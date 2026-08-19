/**
 * AbilitySystem — the Guardian's kit.
 *
 * Owns four slots (grenade, melee, class, super), the three subclasses that
 * populate them, the status-effect system every ability feeds, and the damage
 * resolver's world bindings.
 *
 * Notable implementation choices:
 *
 * **Hit-stop.** There is no global time scale in the engine — the fixed 120 Hz
 * step is deliberately inviolable, because weapon cadence and recoil depend on
 * it. So hit-stop is implemented as a *scope*: while the timer runs, this
 * system's own sub-simulations do not advance, the player's horizontal momentum
 * is killed, and every enemy within eight metres is pinned (velocity and
 * desired velocity zeroed). The result on screen is indistinguishable from a
 * global freeze for the 50–110 ms it lasts, and it costs the rest of the engine
 * nothing.
 *
 * **Damage resistance.** `Player.applyDamage` has no resistance term and is
 * another owner's file, so a super's resistance is applied by subscribing to
 * `player:damaged` and immediately refunding the resisted fraction to shield
 * first, then health. Same arithmetic, no shared ownership.
 *
 * **Speed buffs.** `PlayerMovement` recomputes its speed target from the move
 * command every step, so there is nowhere to write a multiplier that survives.
 * Arc's speed buff instead adds a small impulse along the player's own
 * horizontal velocity each step, sized to hold the raised speed against the
 * mover's friction. It behaves like a higher speed cap and needs no changes
 * anywhere else.
 */
import * as THREE from 'three';
import type { Engine, EngineSystem } from '@/core/Engine';
import type {
  AbilitySlot,
  Damageable,
  DamageElement,
  FrameContext,
  Level,
} from '@/types';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import type { Player } from '../Player';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { clamp, clamp01 } from '@/util/math';
import { damage as sharedDamage } from '../Damage';
import { StatusEffectSystem } from '../StatusEffects';
import { progression } from '../Progression';
import { GrenadePool, chargeFraction } from './Grenades';
import { isSubclassId, loadout } from './Loadout';
import { MeleeController } from './Melee';
import { SuperController } from './Supers';
import type { AbilityContext } from './Context';
import {
  ABILITIES,
  CLASS_ABILITIES,
  GRENADES,
  MELEES,
  SUBCLASSES,
  SUPERS,
  type ClassAbilitySpec,
  type Subclass,
  type SubclassId,
} from './Definitions';

export { ABILITIES, SUBCLASSES, GRENADES, MELEES, SUPERS, CLASS_ABILITIES } from './Definitions';
export { loadout, SubclassLoadout, isSubclassId } from './Loadout';
export type { Subclass, SubclassId, GrenadeSpec, MeleeSpec, SuperSpec } from './Definitions';

export interface CooldownState {
  remaining: number;
  total: number;
  charges: number;
}

/** Structural view of the enemy manager — no import, no cycle. */
interface EnemyRegistry {
  readonly active: readonly Damageable[];
}

/** Super energy earned per point of damage dealt and per kill. */
const SUPER_PER_DAMAGE = 0.00042;
const SUPER_PER_KILL = 0.035;
const SUPER_PASSIVE = 0.0042;

/** Radius within which enemies are pinned during hit-stop. */
const HITSTOP_RADIUS = 8;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

interface PinnedTarget {
  velocity?: THREE.Vector3;
  ai?: { desiredVelocity: THREE.Vector3 };
}

interface Rift {
  active: boolean;
  spec: ClassAbilitySpec | null;
  position: THREE.Vector3;
  remaining: number;
  tick: number;
  mesh: THREE.Mesh;
  light: THREE.PointLight;
}

export class AbilitySystem implements EngineSystem {
  readonly name = 'abilities';

  private engine: Engine;
  private player: Player;
  private vfx: VfxSystem;
  private level: Level | null = null;
  private enemyRegistry: EnemyRegistry | null = null;

  readonly status: StatusEffectSystem;
  private grenades: GrenadePool;
  private melee: MeleeController;
  private superCtl: SuperController;
  private ctx: AbilityContext;

  private activeSubclass: SubclassId = 'solar';
  private grenadeIndex = 0;

  // -- slot state ---------------------------------------------------------
  private slots: Record<AbilitySlot, CooldownState> = {
    grenade: { remaining: 0, total: 8, charges: 1 },
    melee: { remaining: 0, total: 5.5, charges: 1 },
    class: { remaining: 0, total: 22, charges: 1 },
    super: { remaining: 0, total: 0, charges: 0 },
  };
  private maxCharges: Record<AbilitySlot, number> = {
    grenade: 1,
    melee: 1,
    class: 1,
    super: 1,
  };

  private energy = 0;
  private superWasReady = false;

  // -- charge / hit-stop ---------------------------------------------------
  private grenadeHeld = 0;
  private grenadeCharging = false;
  private hitStopTimer = 0;

  // -- class ability state --------------------------------------------------
  private rift: Rift;
  private speedBuff = 0;
  private speedMultiplier = 1;
  private invisibility = 0;

  // -- subclass passives ----------------------------------------------------
  private killSpeed = 0;

  private unsubs: Array<() => void> = [];

  constructor(engine: Engine, player: Player, vfx: VfxSystem) {
    this.engine = engine;
    this.player = player;
    this.vfx = vfx;

    this.status = new StatusEffectSystem(sharedDamage, vfx);
    this.grenades = new GrenadePool(vfx);

    const self = this;
    this.ctx = {
      player,
      vfx,
      damage: sharedDamage,
      status: this.status,
      enemies: () => self.enemies(),
      collision: () => self.level?.collision ?? null,
      scene: () => self.level?.scene ?? null,
      addSuperEnergy: (n) => self.addSuperEnergy(n),
      subclass: () => SUBCLASSES[self.activeSubclass],
      hitStop: (s) => self.hitStop(s),
      get elapsed() {
        return self.elapsed;
      },
    };

    this.melee = new MeleeController(this.ctx, MELEES[SUBCLASSES.solar.melee]);
    this.superCtl = new SuperController(this.ctx, SUPERS[SUBCLASSES.solar.super]);

    // -- healing / burning rift ---------------------------------------------
    const ringGeo = new THREE.CylinderGeometry(1, 1, 0.02, 40, 1, true);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(ringGeo, ringMat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    const light = new THREE.PointLight(0xffffff, 0, 8, 2);
    light.visible = false;
    this.rift = {
      active: false,
      spec: null,
      position: new THREE.Vector3(),
      remaining: 0,
      tick: 0,
      mesh,
      light,
    };

    this.grenades.onDetonate = (spec, position, ownerId, final) => {
      const res = sharedDamage.splash({
        center: position,
        radius: spec.splashRadius,
        damage: final ? spec.splashDamage : spec.fieldDamage,
        element: spec.element,
        sourceId: ownerId,
        edgeFraction: 0.28,
        selfFraction: 0.5,
        impulse: 320,
        emitEvent: final,
      });
      if (final) this.vfx.explosion(position, spec.splashRadius, spec.element);
      if (spec.status) this.applyStatusAround(position, spec.splashRadius, spec.id, spec.statusStacks, spec.statusDuration);
      void res;
    };
    this.grenades.onFieldTick = (spec, position, ownerId) => {
      sharedDamage.splash({
        center: position,
        radius: spec.fieldRadius,
        damage: spec.fieldDamage,
        element: spec.element,
        sourceId: ownerId,
        edgeFraction: 0.55,
        selfFraction: 0.25,
        impulse: 0,
        emitEvent: false,
      });
      if (spec.status) {
        this.applyStatusAround(position, spec.fieldRadius, spec.id, 1, spec.statusDuration || 3);
      }
    };

    // The subclass is a persisted player choice, not a constant. `arc` and
    // `void` were fully authored and permanently unreachable because this line
    // used to read `setSubclass('solar')`.
    this.applyLoadout(true);
    this.unsubs.push(loadout.onChange(() => this.applyLoadout(false)));
    this.subscribe();
  }

  private elapsed = 0;

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private subscribe(): void {
    this.unsubs.push(
      // Super energy from damage the player deals.
      events.on('enemy:damaged', (p) => {
        if (p.sourceId !== 0) return;
        this.addSuperEnergy(p.amount * SUPER_PER_DAMAGE);
      }),
      events.on('enemy:killed', (p) => {
        this.addSuperEnergy(SUPER_PER_KILL);
        this.onKill(p.position);
      }),
      // Super damage resistance, applied as an immediate refund.
      events.on('player:damaged', (p) => {
        const r = this.superCtl.resistance;
        if (r <= 0 || p.amount <= 0) return;
        const refund = p.amount * r;
        const player = this.player;
        const toShield = Math.min(player.maxShield - player.shield, refund);
        player.shield += toShield;
        const rest = refund - toShield;
        if (rest > 0) player.health = clamp(player.health + rest, 0, player.maxHealth);
        // Firing or being hit breaks invisibility.
        this.invisibility = 0;
      }),
      events.on('weapon:fired', () => {
        if (this.invisibility > 0) this.endInvisibility();
      }),
      events.on('player:died', () => this.onDeath()),
    );
  }

  bindLevel(level: Level): void {
    this.level = level;
    this.grenades.detach();
    this.grenades.attach(level.scene);
    this.superCtl.detach();
    this.superCtl.attach(level.scene);
    level.scene.add(this.rift.mesh, this.rift.light);

    this.enemyRegistry = this.engine.get<EngineSystem & EnemyRegistry>('enemies') ?? null;

    // The one place the damage resolver learns about the world.
    sharedDamage.collision = level.collision;
    sharedDamage.playerPower = progression.power;
    sharedDamage.targets = (out, center, radius) => this.collectTargets(out, center, radius);

    this.status.clear();
    this.grenades.clear();
    this.melee.cancel();
    this.superCtl.cancel();
    this.rift.active = false;
    this.rift.mesh.visible = false;
    this.rift.light.visible = false;
  }

  private enemies(): readonly Damageable[] {
    if (!this.enemyRegistry) {
      this.enemyRegistry = this.engine.get<EngineSystem & EnemyRegistry>('enemies') ?? null;
    }
    return this.enemyRegistry?.active ?? EMPTY;
  }

  private collectTargets(out: Damageable[], center: THREE.Vector3, radius: number): number {
    let n = 0;
    const r2 = (radius + 2) * (radius + 2);
    for (const e of this.enemies()) {
      if (e.isDead) continue;
      if (e.getWorldPosition(_v).distanceToSquared(center) > r2) continue;
      out[n++] = e;
      if (n >= 64) break;
    }
    // The player is a valid splash target — self-damage is on.
    if (n < 64 && this.player.getWorldPosition(_v).distanceToSquared(center) <= r2) {
      out[n++] = this.player;
    }
    out.length = Math.max(out.length, n);
    return n;
  }

  // -------------------------------------------------------------------------
  // Subclass
  // -------------------------------------------------------------------------

  /**
   * Equip a subclass. Writes through the persisted loadout, which calls back
   * into `applyLoadout` — so the star map, the keyboard and a debug console all
   * take the same path and the choice survives a reload either way.
   */
  setSubclass(id: string): void {
    if (!isSubclassId(id)) return;
    if (id === this.activeSubclass) return;
    loadout.setSubclass(id);
  }

  get subclass(): Subclass {
    return SUBCLASSES[this.activeSubclass];
  }

  /** Cycle to the next grenade in the subclass's list. */
  cycleGrenade(): void {
    if (this.subclass.grenades.length < 2) return;
    loadout.cycleGrenade(1);
    events.emit('ui:toast', {
      text: this.grenadeSpec.displayName.toUpperCase(),
      sub: `${this.subclass.displayName} grenade`,
      duration: 1.8,
    });
  }

  /** Pull the equipped subclass + grenade out of the store and rebuild slots. */
  private applyLoadout(initial: boolean): void {
    const sub = SUBCLASSES[loadout.subclass];
    const nextGrenade = loadout.grenadeIndex;
    const subclassChanged = initial || sub.id !== this.activeSubclass;
    this.activeSubclass = sub.id;
    this.grenadeIndex = nextGrenade;

    if (subclassChanged) {
      this.melee.spec = MELEES[sub.melee];
      this.superCtl.cancel();
      this.superCtl.setSpec(SUPERS[sub.super]);

      const c = CLASS_ABILITIES[sub.classAbility];
      this.slots.melee.total = this.melee.spec.cooldown;
      this.slots.melee.remaining = 0;
      this.slots.melee.charges = 1;
      this.maxCharges.melee = 1;

      this.slots.class.total = c.cooldown;
      this.slots.class.remaining = 0;
      this.slots.class.charges = c.charges;
      this.maxCharges.class = c.charges;

      (this.rift.mesh.material as THREE.MeshBasicMaterial).color.setHex(
        c.color,
        THREE.SRGBColorSpace,
      );
      this.rift.light.color.setHex(c.color, THREE.SRGBColorSpace);
      // A subclass swap cancels anything the old one had in flight.
      this.rift.active = false;
      this.rift.mesh.visible = false;
      this.rift.light.visible = false;
    }

    // Grenade slot. Charges are clamped rather than refilled: cycling to a
    // grenade with fewer charges than you are holding would otherwise leave
    // `charges > maxCharges`, which `tickSlot` reads as "permanently full" and
    // never corrects.
    const g = GRENADES[sub.grenades[this.grenadeIndex]] ?? GRENADES['grenade.frag'];
    this.maxCharges.grenade = g.charges;
    this.slots.grenade.total = g.cooldown;
    if (subclassChanged) {
      this.slots.grenade.remaining = 0;
      this.slots.grenade.charges = g.charges;
    } else {
      this.slots.grenade.charges = Math.min(this.slots.grenade.charges, g.charges);
      if (this.slots.grenade.charges >= g.charges) this.slots.grenade.remaining = 0;
      else if (this.slots.grenade.remaining <= 0) this.slots.grenade.remaining = g.cooldown;
    }
    // A swap mid-charge would throw the new grenade with the old one's arc.
    this.grenadeCharging = false;
    this.grenades.hidePreview();
  }

  /** Equipped subclass id — the star map's selection highlight reads this. */
  get subclassId(): SubclassId {
    return this.activeSubclass;
  }

  /** Equipped grenade id, for the HUD and for tests. */
  get grenadeId(): string {
    return this.grenadeSpec.id;
  }

  /** Equipped grenade's display name. */
  get grenadeName(): string {
    return this.grenadeSpec.displayName;
  }

  private get grenadeSpec() {
    const sub = this.subclass;
    return GRENADES[sub.grenades[this.grenadeIndex]] ?? GRENADES['grenade.frag'];
  }

  // -------------------------------------------------------------------------
  // Super energy
  // -------------------------------------------------------------------------

  get superEnergy(): number {
    return this.energy;
  }

  get superActive(): boolean {
    return this.superCtl.active;
  }

  addSuperEnergy(amount: number): void {
    if (this.superCtl.active) {
      // While the super is running, energy feeds its own extension rather than
      // the next cast, so refunds cannot bank a second super mid-fight.
      return;
    }
    if (amount <= 0) return;
    const before = this.energy;
    this.energy = clamp01(this.energy + amount);
    if (this.energy >= 1 && before < 1 && !this.superWasReady) {
      this.superWasReady = true;
      events.emit('super:ready');
    }
  }

  readonly cooldowns: Readonly<Record<AbilitySlot, CooldownState>> = this.slots;

  // -------------------------------------------------------------------------
  // Hit-stop
  // -------------------------------------------------------------------------

  /** Freeze this system's simulation, the player's momentum and nearby enemies. */
  hitStop(seconds: number): void {
    if (seconds <= 0) return;
    const scale = settings.user.reducedMotion ? 0.6 : 1;
    this.hitStopTimer = Math.max(this.hitStopTimer, seconds * scale);
  }

  private applyHitStop(): void {
    const p = this.player;
    p.velocity.x = 0;
    p.velocity.z = 0;
    const r2 = HITSTOP_RADIUS * HITSTOP_RADIUS;
    for (const e of this.enemies()) {
      if (e.isDead) continue;
      if (e.getWorldPosition(_v).distanceToSquared(p.position) > r2) continue;
      const t = e as unknown as PinnedTarget;
      if (t.velocity) {
        t.velocity.x = 0;
        t.velocity.z = 0;
      }
      if (t.ai) t.ai.desiredVelocity.set(0, 0, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    this.elapsed = ctx.elapsed;
    const dt = ctx.dt;
    const playing = this.engine.state === 'playing' && !this.player.isDead;

    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= dt;
      this.applyHitStop();
      // The status system keeps ticking: a hit-stop should not extend a burn.
      this.status.update(ctx);
      return;
    }

    sharedDamage.playerPower = progression.power;

    const input = this.engine.input;

    // -- cooldowns ----------------------------------------------------------
    this.tickSlot('grenade', dt, this.grenadeSpec.id);
    this.tickSlot('melee', dt, this.melee.spec.id);
    this.tickSlot('class', dt, CLASS_ABILITIES[this.subclass.classAbility].id);

    // -- passive super charge ----------------------------------------------
    if (playing && !this.superCtl.active) this.addSuperEnergy(SUPER_PASSIVE * dt);

    if (playing) {
      // Cycling is refused mid-charge: `applyLoadout` cancels the charge, so a
      // press while winding up would silently eat the throw.
      if (input.pressed('cycleGrenade') && !this.grenadeCharging) this.cycleGrenade();
      this.handleGrenade(dt, input);
      this.handleMelee(dt, input);
      this.handleClassAbility(input);
      this.handleSuper(input);
    } else {
      this.grenades.hidePreview();
      this.grenadeCharging = false;
    }

    // -- sub-simulations -----------------------------------------------------
    this.grenades.update(dt, this.level?.collision ?? null, this.enemies(), ctx.elapsed);
    this.superCtl.update(dt);
    this.status.update(ctx);
    this.updateRift(dt);
    this.updateBuffs(dt);
  }

  private tickSlot(slot: AbilitySlot, dt: number, abilityId: string): void {
    const s = this.slots[slot];
    if (s.charges >= this.maxCharges[slot]) {
      s.remaining = 0;
      return;
    }
    s.remaining -= dt;
    if (s.remaining <= 0) {
      s.charges = Math.min(this.maxCharges[slot], s.charges + 1);
      s.remaining = s.charges >= this.maxCharges[slot] ? 0 : s.total;
      events.emit('ability:ready', { id: abilityId, slot });
    }
  }

  private spend(slot: AbilitySlot, abilityId: string, total: number): boolean {
    const s = this.slots[slot];
    if (s.charges <= 0) return false;
    s.charges--;
    s.total = total;
    if (s.remaining <= 0) s.remaining = total;
    events.emit('ability:used', { id: abilityId, slot });
    return true;
  }

  // -- grenade --------------------------------------------------------------

  private handleGrenade(dt: number, input: Engine['input']): void {
    const spec = this.grenadeSpec;
    const available = this.slots.grenade.charges > 0;

    if (input.pressed('grenade') && available) {
      this.grenadeCharging = true;
      this.grenadeHeld = 0;
    }

    if (!this.grenadeCharging) {
      // Belt and braces: the preview must never survive the frame it was drawn
      // for. A stale trajectory line hanging in the world is both wrong and,
      // because it draws with depth testing off, extremely visible.
      this.grenades.hidePreview();
    } else {
      this.grenadeHeld += dt;
      const charge = chargeFraction(this.grenadeHeld, spec);
      const origin = _v.copy(this.player.eyePosition).addScaledVector(this.player.aimDirection, 0.5);
      this.grenades.showPreview(
        spec,
        origin,
        this.player.aimDirection,
        charge,
        this.level?.collision ?? null,
      );

      if (!input.down('grenade') || this.grenadeHeld >= spec.chargeTime * 1.6) {
        this.grenadeCharging = false;
        this.grenades.hidePreview();
        if (this.spend('grenade', spec.id, spec.cooldown)) {
          this.grenades.throwGrenade(
            spec,
            origin,
            this.player.aimDirection,
            charge,
            0,
            this.player.velocity,
          );
          this.player.addViewKick(0.02, 0, -0.03, 10);
        }
      }
    }
  }

  // -- melee ----------------------------------------------------------------

  private handleMelee(dt: number, input: Engine['input']): void {
    if (input.pressed('melee') && this.slots.melee.charges > 0 && !this.melee.busy) {
      if (this.melee.begin()) {
        this.slots.melee.charges--;
        this.slots.melee.total = this.melee.spec.cooldown;
        if (this.slots.melee.remaining <= 0) this.slots.melee.remaining = this.melee.spec.cooldown;
      }
    }
    const result = this.melee.update(dt, input.down('melee'));
    if (result && result.hits === 0) {
      // A whiff refunds most of the cooldown — punishing a miss with six
      // seconds of dead time makes players stop trying.
      this.slots.melee.remaining = Math.min(this.slots.melee.remaining, this.melee.spec.cooldown * 0.35);
    }
  }

  // -- class ability ---------------------------------------------------------

  private handleClassAbility(input: Engine['input']): void {
    if (!input.pressed('classAbility')) return;
    const spec = CLASS_ABILITIES[this.subclass.classAbility];
    if (!this.spend('class', spec.id, spec.cooldown)) return;

    switch (spec.kind) {
      case 'healRift': {
        const r = this.rift;
        r.active = true;
        r.spec = spec;
        r.position.copy(this.player.position);
        r.position.y = this.player.position.y - 0.9;
        r.remaining = spec.duration;
        r.tick = 0;
        r.mesh.visible = true;
        r.light.visible = true;
        this.vfx.elementalBurst(r.position, spec.element, 1.4);
        break;
      }
      case 'speedSurge':
        this.speedBuff = spec.duration;
        this.speedMultiplier = spec.magnitude;
        this.vfx.elementalBurst(this.player.eyePosition, spec.element, 1);
        this.player.addViewKick(-0.03, 0, 0, 12);
        break;
      case 'vanish':
        this.invisibility = spec.magnitude;
        this.vfx.elementalBurst(this.player.eyePosition, spec.element, 1.2);
        // Enemies lose the player entirely.
        for (const e of this.enemies()) {
          const t = e as unknown as { ai?: { alert: number; hasLineOfSight: boolean } };
          if (t.ai) {
            t.ai.alert = 0;
            t.ai.hasLineOfSight = false;
          }
        }
        break;
      default:
        break;
    }
  }

  private updateRift(dt: number): void {
    const r = this.rift;
    if (!r.active || !r.spec) return;
    r.remaining -= dt;
    if (r.remaining <= 0) {
      r.active = false;
      r.mesh.visible = false;
      r.light.visible = false;
      return;
    }
    const spec = r.spec;
    // Heal the player while they stand in it.
    if (this.player.position.distanceTo(r.position) < spec.radius) {
      const before = this.player.health;
      this.player.health = clamp(this.player.health + spec.magnitude * dt, 0, this.player.maxHealth);
      const gained = this.player.health - before;
      const spill = spec.magnitude * dt - gained;
      if (spill > 0) {
        this.player.shield = clamp(this.player.shield + spill, 0, this.player.maxShield);
      }
      if (gained > 0.01) events.emit('player:healed', { amount: gained });
    }
    // ...and scorch anything else standing in it.
    r.tick -= dt;
    if (r.tick <= 0) {
      r.tick = 0.5;
      for (const e of this.enemies()) {
        if (e.isDead) continue;
        if (e.getWorldPosition(_v).distanceTo(r.position) > spec.radius) continue;
        this.status.apply(e, 'burn', { sourceId: 0, stacks: 1 });
      }
    }
  }

  private updateBuffs(dt: number): void {
    // Arc's speed surge and the on-kill speed passive share one implementation.
    if (this.speedBuff > 0) this.speedBuff -= dt;
    if (this.killSpeed > 0) this.killSpeed -= dt;
    const mult =
      Math.max(
        this.speedBuff > 0 ? this.speedMultiplier : 1,
        this.killSpeed > 0 ? this.subclass.speedMultiplier : 1,
      ) * (this.superCtl.active && this.subclass.id === 'arc' ? 1.12 : 1);

    if (mult > 1.001 && this.player.grounded) {
      const v = this.player.velocity;
      const speed = Math.hypot(v.x, v.z);
      if (speed > 1.5) {
        // Push along the existing heading up to the raised cap. Sized against
        // the mover's own friction so the speed holds instead of spiking.
        const want = speed * mult;
        const add = Math.min(want - speed, 26 * dt);
        const inv = add / speed;
        v.x += v.x * inv;
        v.z += v.z * inv;
      }
    }

    if (this.invisibility > 0) {
      this.invisibility -= dt;
      if (this.invisibility <= 0) this.endInvisibility();
      else {
        for (const e of this.enemies()) {
          const t = e as unknown as { ai?: { hasLineOfSight: boolean; alert: number } };
          if (t.ai) {
            t.ai.hasLineOfSight = false;
            t.ai.alert = Math.min(t.ai.alert, 0.35);
          }
        }
      }
    }
  }

  private endInvisibility(): void {
    if (this.invisibility <= 0) return;
    this.invisibility = 0;
    this.vfx.elementalBurst(this.player.eyePosition, 'void', 0.6);
  }

  // -- super ------------------------------------------------------------------

  private handleSuper(input: Engine['input']): void {
    if (!input.pressed('super')) return;
    if (this.superCtl.active || this.energy < 1) return;
    const spec = SUPERS[this.subclass.super];
    if (!this.superCtl.activate()) return;
    this.energy = 0;
    this.superWasReady = false;
    this.slots.super.total = spec.duration;
    this.slots.super.remaining = spec.duration + spec.windup;
    this.slots.super.charges = 0;
  }

  // -- kills ------------------------------------------------------------------

  private onKill(position: THREE.Vector3): void {
    const sub = this.subclass;
    if (sub.healPerKill > 0 && position.distanceTo(this.player.position) < 26) {
      const before = this.player.health;
      this.player.health = clamp(this.player.health + sub.healPerKill, 0, this.player.maxHealth);
      const gained = this.player.health - before;
      const spill = sub.healPerKill - gained;
      if (spill > 0) this.player.shield = clamp(this.player.shield + spill * 0.7, 0, this.player.maxShield);
      if (gained > 0) events.emit('player:healed', { amount: gained });
    }
    if (sub.speedOnKill > 0) this.killSpeed = sub.speedOnKill;
  }

  private onDeath(): void {
    this.superCtl.cancel();
    this.melee.cancel();
    this.grenades.clear();
    this.status.clear();
    this.rift.active = false;
    this.rift.mesh.visible = false;
    this.rift.light.visible = false;
    this.speedBuff = 0;
    this.killSpeed = 0;
    this.invisibility = 0;
    this.energy = 0;
    this.superWasReady = false;
    for (const slot of ['grenade', 'melee', 'class'] as AbilitySlot[]) {
      this.slots[slot].charges = this.maxCharges[slot];
      this.slots[slot].remaining = 0;
    }
  }

  private applyStatusAround(
    center: THREE.Vector3,
    radius: number,
    grenadeId: string,
    stacks: number,
    duration: number,
  ): void {
    const spec = GRENADES[grenadeId];
    if (!spec?.status) return;
    for (const e of this.enemies()) {
      if (e.isDead) continue;
      if (e.getWorldPosition(_v2).distanceTo(center) > radius) continue;
      this.status.apply(e, spec.status, { stacks, duration, sourceId: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  render(ctx: FrameContext, _alpha: number): void {
    this.superCtl.render(ctx.frameDt, this.engine.host.camera.position);

    const r = this.rift;
    if (r.active && r.spec) {
      const life = clamp01(r.remaining / Math.max(0.1, r.spec.duration));
      const pulse = settings.user.reducedMotion ? 1 : 1 + Math.sin(ctx.elapsed * 3.1) * 0.05;
      r.mesh.position.copy(r.position);
      r.mesh.position.y += 0.5;
      r.mesh.scale.set(r.spec.radius * pulse, 40, r.spec.radius * pulse);
      r.mesh.rotation.y = ctx.elapsed * 0.4;
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.1 + life * 0.22;
      r.light.position.copy(r.position);
      r.light.position.y += 1.2;
      r.light.intensity = 6 * life * pulse;
      r.light.distance = r.spec.radius * 3;
    }
  }

  // -------------------------------------------------------------------------
  // Readbacks
  // -------------------------------------------------------------------------

  get grenadeCharge(): number {
    return this.grenadeCharging ? chargeFraction(this.grenadeHeld, this.grenadeSpec) : 0;
  }

  get meleeProgress(): number {
    return this.melee.swingProgress;
  }

  get invisible(): boolean {
    return this.invisibility > 0;
  }

  get element(): DamageElement {
    return this.subclass.element;
  }

  stats(): Record<string, number> {
    return {
      superEnergy: Math.round(this.energy * 1000) / 1000,
      grenades: this.grenades.activeCount,
      fields: this.grenades.fieldCount,
      statusEffects: this.status.activeCount,
      affected: this.status.affectedCount,
      hitStop: Math.max(0, Math.round(this.hitStopTimer * 1000)),
    };
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.grenades.dispose();
    this.superCtl.dispose();
    this.status.dispose();
    this.rift.mesh.removeFromParent();
    this.rift.mesh.geometry.dispose();
    (this.rift.mesh.material as THREE.Material).dispose();
    this.rift.light.removeFromParent();
    this.rift.light.dispose();
    sharedDamage.targets = null;
    sharedDamage.collision = null;
    this.level = null;
  }
}

const EMPTY: readonly Damageable[] = [];
