/**
 * WeaponSystem — the heart of the game.
 *
 * Everything a trigger pull touches lives here, in this order, every time:
 *
 *   gate (fire mode → cadence → ammo → reload → swap)
 *     → aim ray from the player's eye
 *     → cone spread from a seeded RNG, tightened by ADS
 *     → aim assist bending the ray toward the acquired target
 *     → hitscan raycast, or a pooled projectile
 *     → damage = base × falloff × region × perks
 *     → applyDamage → feedback → events
 *
 * The gate accumulates a shot timer against the fixed 120 Hz step. There is no
 * `setTimeout`, no `performance.now()`, and no frame-rate dependence anywhere in
 * the firing path — 600 rpm is 600 rpm on a 30 Hz laptop and a 240 Hz monitor.
 *
 * Recoil is delegated to `RecoilController` (three layers), the held weapon to
 * `ViewModel`, travelling rounds to `ProjectilePool`, and build-craft to
 * `PerkRuntime`. This file is the conductor.
 */
import * as THREE from 'three';
import type { Engine, EngineSystem } from '@/core/Engine';
import type {
  DamageElement,
  DamageInfo,
  Damageable,
  FrameContext,
  HitRegion,
  Level,
  RaycastHit,
  SurfaceKind,
  WeaponSlot,
  WeaponStats,
} from '@/types';
import type { Player } from '@/gameplay/Player';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { KICK } from '@/gameplay/ViewKick';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import {
  Rng,
  TAU,
  clamp,
  clamp01,
  coneDirection,
  damp,
  lerp,
  rangeFalloff,
  scratch,
} from '@/util/math';
import {
  DEFAULT_LOADOUT,
  ELEMENT_COLOR,
  SLOT_ORDER,
  WEAPONS,
  cloneStats,
  shotInterval,
  type PlayerHost,
  type TargetProvider,
  type VfxHost,
  type WeaponCollision,
} from './WeaponDefs';
import { RecoilController } from './Recoil';
import { PerkRuntime, applyPerkModifiers, type PerkHitEvent, type PerkHost } from './Perks';
import { ProjectilePool, type Projectile, type ProjectileSpec } from './Projectiles';
import { ViewModel, type ViewModelState } from './ViewModel';

export { WEAPONS } from './WeaponDefs';

/** Hitscan reach, metres. Beyond this a shot is a miss by definition. */
const MAX_RANGE = 420;
/** How often the aim-assist target is re-acquired, in simulation steps. */
const ASSIST_INTERVAL = 6;
/** Aim-assist authority. A mouse gets a nudge; a stick gets real help. */
const ASSIST_MOUSE = 0.26;
const ASSIST_GAMEPAD = 0.85;
/** Reference sprint speed used to normalise the view-model bob. */
const REFERENCE_SPEED = 9;

const REGION_MULTIPLIER: Record<HitRegion, number> = {
  body: 1,
  head: 1, // replaced by stats.precisionMultiplier
  limb: 0.82,
  critSpot: 1, // replaced by stats.precisionMultiplier * 1.15
  shield: 1,
};

/** Directions used to discover splash victims without a global entity list. */
const SPLASH_DIRECTIONS: THREE.Vector3[] = (() => {
  const n = 42;
  const out: THREE.Vector3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = ga * i;
    out.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return out;
})();

/** Cone sample offsets for aim acquisition: centre, inner ring, outer ring. */
const ASSIST_SAMPLES: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = [[0, 0]];
  for (let i = 0; i < 6; i++) out.push([0.5, (i / 6) * TAU]);
  for (let i = 0; i < 6; i++) out.push([1, (i / 6) * TAU + TAU / 12]);
  return out;
})();

interface SlotState {
  index: 0 | 1 | 2;
  slot: WeaponSlot;
  /** Catalogue entry, never mutated. */
  base: WeaponStats;
  /** Effective stats: base with every perk `modify()` applied. */
  stats: WeaponStats;
  magazine: number;
  reserves: number;
  perks: PerkRuntime;
  recoil: RecoilController;
  /** -1 when idle, else seconds elapsed into the reload. */
  reloadT: number;
  reloadDuration: number;
  reloadEmpty: boolean;
}

function makeDamageInfo(): DamageInfo {
  return {
    amount: 0,
    element: 'kinetic',
    region: 'body',
    precision: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    sourceId: 0,
  };
}

export class WeaponSystem implements EngineSystem {
  readonly name = 'weapons';

  private engine: Engine;
  private player: PlayerHost;
  private vfx: VfxHost;
  private collision: WeaponCollision | null = null;
  private scene: THREE.Scene | null = null;

  private slots: SlotState[] = [];
  private activeIndex: 0 | 1 | 2 = 0;
  private pendingIndex: 0 | 1 | 2 | null = null;

  private viewModel: ViewModel;
  private projectiles: ProjectilePool;

  // -- firing state ---------------------------------------------------------
  private shotTimer = 0;
  private burstLeft = 0;
  private burstGap = 0;
  private charge = 0;
  private chargeHeld = false;
  private perfectDraw = false;
  private triggerLatched = false;
  /** A semi-auto press waiting for the cadence gate to mature (input buffer). */
  private pendingSingle = false;
  private beamActive = false;
  private beamEnd = new THREE.Vector3();
  private swapTimer = 0;
  private aimProgress = 0;
  private idleTime = 10;

  // -- aim assist -----------------------------------------------------------
  private assistTarget: Damageable | null = null;
  private assistPoint = new THREE.Vector3();
  private assistTick = 0;
  private targetProvider: TargetProvider | null = null;

  // -- internal recoil offset (used when the Player has no addRecoil) --------
  private offsetPitch = 0;
  private offsetYaw = 0;
  /**
   * 'viewkick'  — the Player's two-part model owns both climb and recentring.
   * 'addRecoil' — the Player takes the climb, we still push the visual punch.
   * 'internal'  — no Player support; the weapon system bends its own aim ray.
   */
  private recoilMode: 'viewkick' | 'addRecoil' | 'internal' = 'internal';
  private externalRecoil = false;

  // -- scratch --------------------------------------------------------------
  private rng = new Rng(0x9e3fa1);
  private hitBuf: RaycastHit = {
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    surface: 'rock',
  };
  private damagePool: DamageInfo[] = Array.from({ length: 16 }, makeDamageInfo);
  private damageCursor = 0;
  private splashSeen: Damageable[] = [];
  private splashScratch: Damageable[] = [];
  private vmState: ViewModelState;
  private muzzleWorld = new THREE.Vector3();
  private aimDir = new THREE.Vector3(0, 0, -1);
  private shotDir = new THREE.Vector3();
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private projSpec: ProjectileSpec;

  constructor(engine: Engine, player: Player, vfx: VfxSystem) {
    this.engine = engine;
    // Structural narrowing: VFX is built by another owner in parallel, so we
    // bind to the minimum contract rather than the concrete class.
    this.player = player;
    this.vfx = vfx as unknown as VfxHost;
    // The shipped Player owns a two-part recoil model (`ViewKick`): one impulse
    // produces both the camera punch and the true aim climb, and it handles
    // recentring — including cancelling it when the player pulls down manually.
    // Detect that (4-argument signature) and hand the pattern straight to it;
    // otherwise drive an internal aim offset so recoil still works.
    const kickFn = (this.player as PlayerHost).addViewKick as
      | ((...args: number[]) => void)
      | undefined;
    this.recoilMode =
      typeof (this.player as PlayerHost).addRecoil === 'function'
        ? 'addRecoil'
        : typeof kickFn === 'function' && kickFn.length >= 3
          ? 'viewkick'
          : 'internal';
    this.externalRecoil = this.recoilMode !== 'internal';

    const materials = this.vfx?.materials ?? null;
    this.viewModel = new ViewModel(materials);
    this.projectiles = new ProjectilePool(
      {
        collision: () => this.collision,
        onImpact: (p, hit) => this.onProjectileImpact(p, hit),
        onDetonate: (p, point, normal) => this.onProjectileDetonate(p, point, normal),
        onBounce: (p, point, normal, speed) => this.onProjectileBounce(p, point, normal, speed),
        onTrail: (p) => this.vfx?.trail?.(p.position, p.color, p.radius * 6),
        acquire: (origin, dir, cone, dist) => this.acquireTarget(origin, dir, cone, dist),
      },
      materials,
    );

    for (let i = 0; i < 3; i++) {
      this.slots.push(this.makeSlot(i as 0 | 1 | 2, DEFAULT_LOADOUT[i]));
    }
    this.viewModel.setWeapon(this.slots[0].stats);
    this.slots[0].perks.equip();

    this.projSpec = {
      weaponId: '',
      element: 'kinetic',
      look: 'bolt',
      origin: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      speed: 0,
      gravity: 0,
      drag: 0,
      radius: 0.05,
      damage: 0,
      precisionMultiplier: 1,
      splashRadius: 0,
      splashDamage: 0,
      falloffStart: 1e4,
      falloffEnd: 1e4,
      falloffFloor: 1,
      impulse: 0,
      fuse: 0,
      bounce: 0,
      maxBounces: 0,
      proximity: 0,
      homing: 0,
      spin: 0,
      lifetime: 8,
      color: 0xffffff,
      width: 1,
      sourceId: 0,
      tags: 0,
    };

    this.vmState = {
      camera: engine.host.camera,
      frameDt: 1 / 60,
      elapsed: 0,
      speed: 0,
      maxSpeed: REFERENCE_SPEED,
      grounded: true,
      sprinting: false,
      crouching: false,
      ads: 0,
      reload: -1,
      reloadEmpty: false,
      charge: 0,
      perfectDraw: false,
      magazine: 0,
      collision: null,
      visible: true,
    };
  }

  // -- public API -----------------------------------------------------------

  /** Effective stats of the equipped weapon, perks included. */
  get current(): WeaponStats {
    return this.slots[this.activeIndex].stats;
  }

  /** Current cone half-angle in radians — what the crosshair should draw. */
  get spread(): number {
    const s = this.slots[this.activeIndex];
    return s.recoil.cone(s.stats, this.aimProgress);
  }

  get magazine(): number {
    return this.slots[this.activeIndex].magazine;
  }

  get reserves(): number {
    return this.slots[this.activeIndex].reserves;
  }

  get reloading(): boolean {
    return this.slots[this.activeIndex].reloadT >= 0;
  }

  /** 0..1 aim-down-sights blend, simulation-authoritative. */
  get ads(): number {
    return this.aimProgress;
  }

  /** 0..1 charge/draw progress for charge weapons and bows. */
  get chargeProgress(): number {
    return this.charge;
  }

  equip(slot: 0 | 1 | 2): void {
    const idx = clamp(slot, 0, 2) as 0 | 1 | 2;
    if (idx === this.activeIndex || this.pendingIndex === idx) return;
    const from = this.slots[this.activeIndex];
    const to = this.slots[idx];
    this.pendingIndex = idx;
    const handling = from.perks.handlingMul;
    const outTime = 0.2 * handling;
    const inTime = 0.26 * to.perks.handlingMul;
    this.swapTimer = outTime + inTime;
    this.viewModel.beginSwap(to.stats, outTime, inTime);
    this.cancelAction(from);
    from.perks.stow();
  }

  /** Add reserve ammo to a slot, clamped to the weapon's reserve capacity. */
  giveAmmo(slot: WeaponSlot, amount: number): void {
    const s = this.slots.find((x) => x.slot === slot);
    if (!s || amount <= 0) return;
    s.reserves = Math.min(s.base.reserves, s.reserves + Math.round(amount));
  }

  /** Replace the weapon in a slot (loot, loadout screen). */
  setWeapon(slot: 0 | 1 | 2, weaponId: string): void {
    const def = WEAPONS[weaponId];
    if (!def) return;
    const fresh = this.makeSlot(slot, weaponId);
    this.slots[slot] = fresh;
    if (slot === this.activeIndex) {
      // A new weapon starts its cadence clock from zero; carrying the previous
      // weapon's accumulator over would grant a free early shot.
      this.shotTimer = 0;
      this.burstLeft = 0;
      this.burstGap = 0;
      this.charge = 0;
      this.chargeHeld = false;
      this.pendingSingle = false;
      this.triggerLatched = true;
      this.viewModel.setWeapon(fresh.stats);
      fresh.perks.equip();
      events.emit('weapon:swapped', { slot, weaponId: fresh.stats.id });
    }
  }

  /**
   * Optional hook so an enemy manager can supply an exact splash target list.
   * Without it the system discovers victims by probing rays from the blast
   * centre, which has the pleasant side effect of respecting cover.
   */
  setTargetProvider(fn: TargetProvider | null): void {
    this.targetProvider = fn;
  }

  bindLevel(level: Level): void {
    this.collision = level.collision as WeaponCollision;
    this.scene = level.scene;
    this.viewModel.attach(level.scene);
    level.scene.add(this.projectiles.root);
    this.projectiles.clear();
    this.assistTarget = null;
    for (const s of this.slots) {
      s.recoil.reset();
      s.reloadT = -1;
      s.perks.reset();
    }
    this.offsetPitch = 0;
    this.offsetYaw = 0;
    this.shotTimer = 0;
    this.burstLeft = 0;
    this.charge = 0;
  }

  // -- simulation -----------------------------------------------------------

  update(ctx: FrameContext): void {
    const dt = ctx.dt;
    const active = this.slots[this.activeIndex];
    const stats = active.stats;
    const input = this.engine.input;
    const playing = this.engine.state === 'playing';

    // -- swap ---------------------------------------------------------------
    if (this.swapTimer > 0) {
      this.swapTimer -= dt;
      if (this.swapTimer <= 0 && this.pendingIndex != null) {
        this.activeIndex = this.pendingIndex;
        this.pendingIndex = null;
        const now = this.slots[this.activeIndex];
        now.recoil.resetPattern();
        now.perks.equip();
        this.shotTimer = shotInterval(now.stats);
        events.emit('weapon:swapped', { slot: this.activeIndex, weaponId: now.stats.id });
      }
    }
    const swapping = this.swapTimer > 0;

    // -- input --------------------------------------------------------------
    let wantFire = false;
    let wantAim = false;
    let wantReload = false;
    if (playing && !swapping) {
      wantFire = input.down('fire') || input.fireAxis > 0.35;
      wantAim = input.down('aim') || input.aimAxis > 0.35;
      wantReload = input.pressed('reload');
      if (input.pressed('slot1')) this.equip(0);
      else if (input.pressed('slot2')) this.equip(1);
      else if (input.pressed('slot3')) this.equip(2);
      else if (input.pressed('swapWeapon')) this.equip(this.activeIndex === 0 ? 1 : 0);
      const wheel = input.consumeWheel();
      if (wheel !== 0) this.equip((((this.activeIndex + (wheel > 0 ? 1 : 2)) % 3) as 0 | 1 | 2));
    }
    if (!wantFire) this.triggerLatched = false;

    // -- ADS ----------------------------------------------------------------
    const adsAllowed = !swapping && active.reloadT < 0 && playing;
    const adsTarget = wantAim && adsAllowed ? 1 : 0;
    const adsRate = 1 / Math.max(0.04, stats.adsTime * active.perks.handlingMul);
    this.aimProgress = clamp01(
      this.aimProgress + (adsTarget - this.aimProgress > 0 ? adsRate : -adsRate * 1.35) * dt,
    );
    if (adsTarget === 1 && this.aimProgress > 0.999) this.aimProgress = 1;
    if (adsTarget === 0 && this.aimProgress < 0.001) this.aimProgress = 0;
    this.player.aimProgress = this.aimProgress;
    // The camera owns the projection; we only tell it how far to zoom.
    this.player.aimZoom = stats.adsZoom;
    // Blocks sprint while shooting, which is what makes ADS a commitment.
    this.player.firing = wantFire && active.magazine > 0 && active.reloadT < 0;

    // -- reload -------------------------------------------------------------
    for (const s of this.slots) {
      if (s.reloadT < 0) continue;
      s.reloadT += dt;
      if (s.reloadT >= s.reloadDuration) this.finishReload(s);
    }
    if (wantReload && !swapping) {
      if (active.magazine >= stats.magazine && active.reloadT < 0) this.viewModel.inspect();
      else this.beginReload(active);
    }

    // -- perks & recoil ------------------------------------------------------
    this.idleTime += dt;
    for (const s of this.slots) {
      s.perks.aimProgress = s === active ? this.aimProgress : 0;
      s.perks.idleTime = s === active ? this.idleTime : 99;
      s.perks.update(dt);
      s.recoil.setModifiers(s.perks.stabilityMul, s.perks.bloomMul);
      s.recoil.update(dt, s.stats);
    }
    this.applyRecoilRecovery(active);

    // -- aim assist acquisition ---------------------------------------------
    if (++this.assistTick >= ASSIST_INTERVAL) {
      this.assistTick = 0;
      this.refreshAssist(stats);
    }

    // -- firing --------------------------------------------------------------
    if (playing && !swapping) this.tickFiring(active, dt, wantFire);
    else {
      this.beamActive = false;
      this.charge = damp(this.charge, 0, 10, dt);
    }

    this.projectiles.update(dt);
  }

  // -- firing pipeline ------------------------------------------------------

  private tickFiring(s: SlotState, dt: number, wantFire: boolean): void {
    const stats = s.stats;
    const interval = shotInterval(stats);

    // The accumulator keeps its fractional remainder across shots, so an
    // interval that is not a whole number of 120 Hz ticks still averages to the
    // exact authored rate. While the trigger is up it is clamped to one
    // interval so idling never banks a free burst.
    this.shotTimer += dt;
    if (!wantFire) this.shotTimer = Math.min(this.shotTimer, interval);
    else this.shotTimer = Math.min(this.shotTimer, interval * 2);
    if (this.burstGap > 0) this.burstGap = Math.max(0, this.burstGap - dt);

    if (s.reloadT >= 0) {
      this.beamActive = false;
      this.charge = damp(this.charge, 0, 12, dt);
      return;
    }

    switch (stats.fireMode) {
      case 'auto':
        if (wantFire) this.tryRepeat(s, interval);
        break;

      case 'single':
        // One press, one round — never two, however long the trigger is held.
        // A press that arrives before the cadence gate matures is buffered
        // rather than discarded, so rapid clicking hits the true rate cap
        // instead of stuttering below it.
        if (wantFire && !this.triggerLatched) {
          this.triggerLatched = true;
          this.pendingSingle = true;
        }
        if (!wantFire) this.pendingSingle = false;
        if (this.pendingSingle) {
          if (s.magazine <= 0) {
            this.pendingSingle = false;
            this.dryFire(s);
          } else if (this.shotTimer >= interval) {
            if (this.fireOnce(s)) {
              this.shotTimer -= interval;
              this.pendingSingle = false;
            } else {
              this.pendingSingle = false;
            }
          }
        }
        break;

      case 'burst':
        if (this.burstLeft > 0) {
          if (this.shotTimer >= interval) {
            if (this.fireOnce(s)) {
              this.shotTimer -= interval;
              this.burstLeft--;
              if (this.burstLeft === 0) this.burstGap = stats.burstDelay;
            } else {
              this.burstLeft = 0;
              this.burstGap = stats.burstDelay;
            }
          }
        } else if (wantFire && this.burstGap <= 0 && !this.triggerLatched) {
          if (s.magazine > 0) {
            this.burstLeft = stats.burstCount;
            this.shotTimer = interval;
          } else {
            this.dryFire(s);
            this.triggerLatched = true;
          }
        }
        break;

      case 'charge':
        this.tickCharge(s, dt, wantFire);
        break;

      case 'beam':
        this.tickBeam(s, dt, wantFire, interval);
        break;
    }
  }

  /** Auto/single shared path: fire as many whole intervals as have elapsed. */
  private tryRepeat(s: SlotState, interval: number): boolean {
    let fired = false;
    let guard = 0;
    while (this.shotTimer >= interval && guard++ < 4) {
      if (s.magazine <= 0) {
        this.dryFire(s);
        break;
      }
      if (!this.fireOnce(s)) break;
      this.shotTimer -= interval;
      fired = true;
    }
    return fired;
  }

  private tickCharge(s: SlotState, dt: number, wantFire: boolean): void {
    const stats = s.stats;
    const chargeTime = Math.max(0.05, stats.chargeTime * s.perks.handlingMul);
    const isBow = stats.family === 'bow';

    if (wantFire && s.magazine > 0 && !this.triggerLatched) {
      this.chargeHeld = true;
      this.charge = Math.min(isBow ? 1.35 : 1, this.charge + dt / chargeTime);
      // Bows have a perfect-draw window just past full draw.
      this.perfectDraw = isBow && this.charge >= 1 && this.charge <= 1.18;
      if (!isBow && this.charge >= 1) {
        // Fires the instant the coils are full and immediately begins the next
        // charge — holding the trigger walks a fusion rifle through its magazine.
        this.fireOnce(s);
        this.charge = 0;
        this.chargeHeld = false;
      }
    } else if (this.chargeHeld) {
      this.chargeHeld = false;
      if (isBow && this.charge >= 0.55 && s.magazine > 0) {
        this.fireOnce(s);
      }
      this.charge = 0;
      this.perfectDraw = false;
      if (wantFire) this.triggerLatched = true;
    } else if (wantFire && s.magazine <= 0 && !this.triggerLatched) {
      this.dryFire(s);
      this.triggerLatched = true;
    } else {
      this.charge = damp(this.charge, 0, 14, dt);
    }
  }

  private tickBeam(s: SlotState, dt: number, wantFire: boolean, interval: number): void {
    if (!wantFire) {
      this.beamActive = false;
      return;
    }
    if (s.magazine <= 0) {
      this.beamActive = false;
      this.dryFire(s);
      return;
    }
    this.beamActive = true;
    let guard = 0;
    while (this.shotTimer >= interval && guard++ < 6) {
      if (s.magazine <= 0) break;
      this.fireOnce(s);
      this.shotTimer -= interval;
    }
  }

  private dryFire(s: SlotState): void {
    if (this.shotTimer < shotInterval(s.stats)) return;
    this.shotTimer = 0;
    events.emit('weapon:emptied', { weaponId: s.stats.id });
    this.beginReload(s);
  }

  /**
   * One trigger's worth of output. Returns false when the shot could not be
   * taken (no ammo), which the cadence gate uses to stop the loop.
   */
  private fireOnce(s: SlotState): boolean {
    const stats = s.stats;
    const cost = Math.max(1, stats.ammoPerShot);
    if (s.magazine < cost) return false;
    s.magazine -= cost;
    this.idleTime = 0;

    // -- recoil: all three layers, in order ---------------------------------
    const kick = s.recoil.shot(stats, this.aimProgress);
    const vk = s.recoil.viewKick;
    // Cosmetic roll, scaled by the weapon's camera punch — pure garnish, but it
    // is what separates a hand cannon from an SMG on a single frame.
    const roll = vk.yaw * 2.4 + (this.rng.next() * 2 - 1) * stats.cameraKick * 0.9;
    if (this.recoilMode === 'addRecoil') {
      this.player.addRecoil!(kick.pitch, kick.yaw);
      this.player.addViewKick(vk.pitch, vk.yaw, roll, stats.recoilRecovery * 2.7);
    } else if (this.recoilMode === 'viewkick') {
      // ViewKick applies only `aimShare` of an impulse to the true aim, so
      // pre-divide to make the climb match the authored pattern exactly.
      const share = KICK.aimShare > 0.05 ? KICK.aimShare : 1;
      this.player.addViewKick(
        kick.pitch / share,
        kick.yaw / share,
        roll,
        stats.recoilRecovery * 2.7,
      );
    } else {
      this.offsetPitch += kick.pitch;
      this.offsetYaw += kick.yaw;
      this.player.addViewKick(vk.pitch, vk.yaw, roll);
    }
    this.player.addShake(stats.shake * (settings.user.reducedMotion ? 0.4 : 1), 0.18);

    // -- aim ray -------------------------------------------------------------
    this.computeAimDirection(this.aimDir);
    const cone = s.recoil.cone(stats, this.aimProgress);
    const origin = this.player.eyePosition ?? this.tmpA.set(0, 1.7, 0);
    // The view model is placed in render(), so on the first simulation step
    // after a level load (or in a headless harness) its world matrix may still
    // be identity. Fall back to the eye whenever the muzzle is implausibly far
    // from the player — a tracer from the world origin is a very visible bug.
    this.viewModel.muzzleWorld(this.muzzleWorld);
    if (!this.viewModel.placed || !(this.muzzleWorld.distanceToSquared(origin) < 4)) {
      this.muzzleWorld.copy(origin);
    }

    const pellets = Math.max(1, stats.pellets);
    const drawBonus = this.perfectDraw ? 1.2 : 1;
    let anyHit = false;
    let anyKill = false;
    let anyPrecision = false;
    let totalDamage = 0;

    for (let i = 0; i < pellets; i++) {
      // Pellet 0 of a single-pellet weapon fires down the exact cone axis when
      // fully settled — precision weapons must be perfectly predictable.
      coneDirection(this.aimDir, cone, this.rng, this.shotDir);
      this.applyAimAssist(origin, this.shotDir, stats);

      if (stats.hitscan) {
        const r = this.castHitscan(s, origin, this.shotDir, drawBonus, i < 3 || pellets === 1);
        if (r.hit) {
          anyHit = true;
          totalDamage += r.damage;
          anyPrecision = anyPrecision || r.precision;
          anyKill = anyKill || r.killed;
        }
      } else {
        this.launchProjectile(s, origin, this.shotDir, drawBonus);
      }
    }

    // -- feedback ------------------------------------------------------------
    this.vfx?.muzzle?.(
      this.muzzleWorld,
      this.aimDir,
      stats.muzzleIntensity,
      stats.tracerColor,
    );
    this.viewModel.fire(stats, this.aimProgress);

    if (anyHit) {
      events.emit('hitmarker', {
        precision: anyPrecision,
        kill: anyKill,
        damage: Math.round(totalDamage),
      });
    }
    events.emit('weapon:fired', {
      weaponId: stats.id,
      ammo: s.magazine,
      magazine: stats.magazine,
    });
    s.perks.fire();
    if (s.magazine <= 0 && stats.fireMode !== 'beam') {
      events.emit('weapon:emptied', { weaponId: stats.id });
    }
    return true;
  }

  /** Hitscan pellet. Returns what happened so the caller can build feedback. */
  private castHitscan(
    s: SlotState,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    bonus: number,
    drawTracer: boolean,
  ): { hit: boolean; damage: number; precision: boolean; killed: boolean } {
    const stats = s.stats;
    const collision = this.collision;
    const hit = collision
      ? collision.raycastAll
        ? collision.raycastAll(origin, dir, MAX_RANGE, this.player.entityId ?? 0, this.hitBuf)
        : collision.raycast(origin, dir, MAX_RANGE, this.hitBuf)
      : null;

    const end = this.tmpB;
    if (hit) end.copy(hit.point);
    else end.copy(origin).addScaledVector(dir, MAX_RANGE);

    if (drawTracer) {
      this.vfx?.tracer?.(this.muzzleWorld, end, stats.tracerWidth, stats.tracerColor, 900);
    }

    if (!hit) return { hit: false, damage: 0, precision: false, killed: false };

    const result = this.resolveImpact(s, hit, dir, hit.distance, bonus, false);
    return { hit: true, ...result };
  }

  /**
   * Shared damage + VFX resolution for hitscan pellets and projectile impacts.
   */
  private resolveImpact(
    s: SlotState,
    hit: RaycastHit,
    dir: THREE.Vector3,
    distance: number,
    bonus: number,
    fromProjectile: boolean,
  ): { damage: number; precision: boolean; killed: boolean } {
    const stats = s.stats;
    const perks = s.perks;
    const target = hit.damageable ?? null;
    const region: HitRegion = hit.region ?? 'body';
    const precision = region === 'head' || region === 'critSpot';

    let damage = 0;
    let killed = false;

    if (target && !target.isDead) {
      const falloff = rangeFalloff(
        distance,
        stats.falloffStart * perks.rangeMul,
        stats.falloffEnd * perks.rangeMul,
        stats.falloffFloor,
      );
      let regionMul = REGION_MULTIPLIER[region];
      if (region === 'head') regionMul = stats.precisionMultiplier;
      else if (region === 'critSpot') regionMul = stats.precisionMultiplier * 1.15;

      let mul = perks.damageMul;
      if (stats.perks.includes('vorpalWeapon') && target.maxHealth >= 600) mul *= 1.2;

      damage = stats.damage * falloff * regionMul * mul * bonus;
      const info = this.nextDamageInfo();
      info.amount = damage;
      info.element = stats.element;
      info.region = region;
      info.precision = precision;
      info.point.copy(hit.point);
      info.normal.copy(hit.normal);
      info.direction.copy(dir);
      info.sourceId = 0;
      info.splash = false;
      info.impulse = stats.impulse;
      const dealt = target.applyDamage(info);
      damage = Number.isFinite(dealt) && dealt > 0 ? dealt : damage;
      killed = target.isDead;

      this.vfx?.bloodOrIchor?.(hit.point, hit.normal, precision ? 1.5 : 1);

      // Explosive Payload turns every round into a small grenade.
      if (perks.bonusSplashRadius > 0) {
        this.applySplash(
          hit.point,
          perks.bonusSplashRadius,
          damage * perks.bonusSplashFraction,
          stats.element,
          target,
        );
        this.vfx?.explosion?.(hit.point, perks.bonusSplashRadius, stats.element);
      }

      const ev: PerkHitEvent = {
        target,
        precision,
        distance,
        point: hit.point,
        normal: hit.normal,
        damage,
        killed,
        targetMaxHealth: target.maxHealth,
      };
      perks.hit(ev);
    } else {
      const surface: SurfaceKind = hit.surface ?? 'rock';
      const scale = fromProjectile ? 1.4 : 1;
      this.vfx?.impact?.(hit.point, hit.normal, surface, scale);
      this.vfx?.decal?.(hit.point, hit.normal, surface, (0.12 + stats.tracerWidth) * scale);
      events.emit('impact:surface', {
        point: hit.point,
        normal: hit.normal,
        surface,
        scale,
      });
    }
    return { damage, precision, killed };
  }

  // -- projectiles ----------------------------------------------------------

  private launchProjectile(
    s: SlotState,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    bonus: number,
  ): void {
    const stats = s.stats;
    const spec = this.projSpec;
    spec.weaponId = stats.id;
    spec.element = stats.element;
    // Spawn on the *aim ray*, at the muzzle's forward distance. Using the raw
    // muzzle point would give the round a lateral offset from the crosshair, so
    // a rocket fired at a distant target would visibly miss to the left. This
    // keeps the visual stand-off without introducing parallax error.
    const ahead = clamp(this.tmpA.copy(this.muzzleWorld).sub(origin).dot(dir), 0.12, 1.4);
    spec.origin.copy(origin).addScaledVector(dir, ahead);
    spec.direction.copy(dir);
    spec.speed = stats.projectileSpeed;
    spec.gravity = stats.projectileGravity;
    spec.drag = 0;
    spec.damage = stats.damage * s.perks.damageMul * bonus;
    spec.precisionMultiplier = stats.precisionMultiplier;
    spec.splashRadius = stats.splashRadius;
    spec.splashDamage = stats.splashDamage * s.perks.damageMul;
    spec.falloffStart = stats.falloffStart * s.perks.rangeMul;
    spec.falloffEnd = stats.falloffEnd * s.perks.rangeMul;
    spec.falloffFloor = stats.falloffFloor;
    spec.impulse = stats.impulse;
    spec.color = stats.tracerColor;
    spec.sourceId = this.player.entityId ?? 0;
    spec.tags = 0;
    spec.homing = 0;
    spec.proximity = 0;
    spec.bounce = 0;
    spec.maxBounces = 0;
    spec.fuse = 0;
    spec.spin = 0;
    spec.width = 1;

    switch (stats.family) {
      case 'fusionRifle':
        spec.look = 'bolt';
        spec.radius = 0.05;
        spec.lifetime = 1.2;
        spec.width = 1.1;
        break;
      case 'rocketLauncher':
        spec.look = 'rocket';
        spec.radius = 0.09;
        spec.lifetime = 6;
        spec.proximity = 0.55;
        spec.homing = 0.9;
        spec.width = 1.4;
        break;
      case 'grenadeLauncher':
        spec.look = 'grenade';
        spec.radius = 0.06;
        spec.lifetime = 6;
        spec.bounce = 0.42;
        spec.maxBounces = 3;
        spec.fuse = 1.35;
        spec.spin = 16;
        spec.drag = 0.25;
        spec.width = 1.2;
        break;
      case 'bow':
        spec.look = 'arrow';
        spec.radius = 0.035;
        spec.lifetime = 5;
        spec.drag = 0.06;
        spec.width = 1.6;
        break;
      default:
        spec.look = 'bolt';
        spec.radius = 0.05;
        spec.lifetime = 4;
        break;
    }
    this.projectiles.spawn(spec);
  }

  private onProjectileImpact(p: Projectile, hit: RaycastHit): void {
    const s = this.slotForWeapon(p.weaponId);
    if (!s) return;
    this.tmpC.copy(p.velocity).normalize();
    const r = this.resolveImpact(s, hit, this.tmpC, p.travelled, 1, true);
    if (r.damage > 0) {
      events.emit('hitmarker', {
        precision: r.precision,
        kill: r.killed,
        damage: Math.round(r.damage),
      });
    }
  }

  private onProjectileDetonate(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3): void {
    if (p.splashRadius > 0) {
      this.applySplash(point, p.splashRadius, p.splashDamage, p.element, null);
      this.vfx?.explosion?.(point, p.splashRadius, p.element);
      events.emit('explosion', { point, radius: p.splashRadius, element: p.element });
      // Rockets hurt their owner. That is the price of the power slot.
      this.applySelfDamage(point, p.splashRadius, p.splashDamage, p.element);
    } else {
      this.vfx?.impact?.(point, normal, 'rock', 1.2);
    }
  }

  private onProjectileBounce(
    p: Projectile,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    speed: number,
  ): void {
    this.vfx?.impact?.(point, normal, 'metal', clamp(speed / 30, 0.25, 1));
  }

  // -- splash ---------------------------------------------------------------

  /**
   * Radius damage, applied exactly once per target.
   *
   * Victims are found either through an injected provider (fast, exact) or by
   * probing rays outward from the blast centre, which uses only the public
   * collision API and correctly refuses to damage things behind cover.
   */
  private applySplash(
    centre: THREE.Vector3,
    radius: number,
    damage: number,
    element: DamageElement,
    skip: Damageable | null,
  ): void {
    if (radius <= 0 || damage <= 0) return;
    const seen = this.splashSeen;
    seen.length = 0;

    if (this.targetProvider) {
      const list = this.targetProvider(centre, radius, this.splashScratch);
      for (const d of list) if (d && !d.isDead) seen.push(d);
    } else if (this.collision?.raycastAll) {
      for (const dir of SPLASH_DIRECTIONS) {
        const hit = this.collision.raycastAll(centre, dir, radius, -1, this.hitBuf);
        const d = hit?.damageable;
        if (!d || d.isDead) continue;
        if (seen.indexOf(d) >= 0) continue;
        seen.push(d);
      }
    }

    for (const target of seen) {
      if (target === skip) continue;
      target.getWorldPosition(this.tmpA);
      const dist = this.tmpA.distanceTo(centre);
      if (dist > radius) continue;
      // Linear-ish falloff with a floor at the rim; squared reads too weak.
      const t = 1 - clamp01(dist / radius);
      const amount = damage * (0.35 + 0.65 * t * t);
      const info = this.nextDamageInfo();
      info.amount = amount;
      info.element = element;
      info.region = 'body';
      info.precision = false;
      info.point.copy(centre);
      info.normal.copy(this.tmpA).sub(centre).normalize();
      info.direction.copy(info.normal);
      info.sourceId = 0;
      info.splash = true;
      info.impulse = amount * 4;
      const dealt = target.applyDamage(info);
      const active = this.slots[this.activeIndex];
      const ev: PerkHitEvent = {
        target,
        precision: false,
        distance: dist,
        point: centre,
        normal: info.normal,
        damage: dealt > 0 ? dealt : amount,
        killed: target.isDead,
        targetMaxHealth: target.maxHealth,
      };
      active.perks.hit(ev);
    }
    seen.length = 0;
  }

  private applySelfDamage(
    centre: THREE.Vector3,
    radius: number,
    damage: number,
    element: DamageElement,
  ): void {
    const eye = this.player.eyePosition;
    if (!eye) return;
    const dist = eye.distanceTo(centre);
    if (dist > radius) return;
    const t = 1 - clamp01(dist / radius);
    const amount = damage * 0.42 * (0.2 + 0.8 * t * t);
    if (amount <= 0.5) return;
    if (typeof this.player.applyDamage === 'function') {
      const info = this.nextDamageInfo();
      info.amount = amount;
      info.element = element;
      info.region = 'body';
      info.precision = false;
      info.point.copy(centre);
      info.normal.copy(eye).sub(centre).normalize();
      info.direction.copy(info.normal);
      info.sourceId = 0;
      info.splash = true;
      info.impulse = amount * 6;
      this.player.applyDamage(info);
    }
    this.player.addShake?.(clamp(amount / 40, 0.3, 1.6), 0.4);
  }

  // -- aim assist -----------------------------------------------------------

  /** Re-acquire the assist target by sampling rays inside the assist cone. */
  private refreshAssist(stats: WeaponStats): void {
    const collision = this.collision;
    if (!collision?.raycastAll || !this.player.eyePosition) {
      this.assistTarget = null;
      return;
    }
    this.computeAimDirection(this.aimDir);
    const cone = stats.aimAssist * this.slots[this.activeIndex].perks.aimAssistMul;
    const range = Math.min(MAX_RANGE, stats.falloffEnd * 2 + 30);
    const found = this.acquireTarget(this.player.eyePosition, this.aimDir, cone, range);
    this.assistTarget = found;
    if (found) found.getWorldPosition(this.assistPoint);
  }

  /** Sample a small spiral of rays and return the nearest damageable found. */
  private acquireTarget(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    cone: number,
    range: number,
  ): Damageable | null {
    const collision = this.collision;
    if (!collision?.raycastAll) return null;
    // Orthonormal basis around the aim axis, built without trig.
    const t = scratch.v3a;
    if (Math.abs(dir.z) < 0.9) t.set(0, 0, 1);
    else t.set(1, 0, 0);
    const bx = scratch.v3b.crossVectors(t, dir).normalize();
    const by = scratch.v3c.crossVectors(dir, bx);

    let best: Damageable | null = null;
    let bestScore = Infinity;
    const ignore = this.player.entityId ?? 0;
    for (const [r, phi] of ASSIST_SAMPLES) {
      const a = cone * r;
      const s = Math.sin(a);
      this.tmpC
        .copy(dir)
        .multiplyScalar(Math.cos(a))
        .addScaledVector(bx, s * Math.cos(phi))
        .addScaledVector(by, s * Math.sin(phi))
        .normalize();
      const hit = collision.raycastAll(origin, this.tmpC, range, ignore, this.hitBuf);
      const d = hit?.damageable;
      if (!d || d.isDead) continue;
      // Prefer on-axis targets first, then nearer ones.
      const score = r * 1000 + hit!.distance;
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best;
  }

  /**
   * Bend a pellet toward the acquired target. Mouse players get a nudge that is
   * imperceptible but removes the last few pixels of jitter; gamepad players get
   * real magnetism, because a thumbstick cannot resolve 0.3°.
   */
  private applyAimAssist(origin: THREE.Vector3, dir: THREE.Vector3, stats: WeaponStats): void {
    const target = this.assistTarget;
    if (!target || target.isDead || stats.aimAssist <= 0) return;
    target.getWorldPosition(this.assistPoint);
    this.tmpA.copy(this.assistPoint).sub(origin);
    const dist = this.tmpA.length();
    if (dist < 0.5 || dist > MAX_RANGE) return;
    this.tmpA.multiplyScalar(1 / dist);
    const cosA = clamp(this.tmpA.dot(dir), -1, 1);
    const angle = Math.acos(cosA);
    const cone = stats.aimAssist * this.slots[this.activeIndex].perks.aimAssistMul;
    if (angle > cone * 1.15) return;
    const strength =
      (this.engine.input.usingGamepad ? ASSIST_GAMEPAD : ASSIST_MOUSE) *
      (1 - clamp01(angle / (cone * 1.15))) *
      lerp(1, 0.6, this.aimProgress);
    if (strength <= 0) return;
    dir.lerp(this.tmpA, strength).normalize();
  }

  // -- aim / recoil plumbing ------------------------------------------------

  /** The player's look direction with the weapon system's own climb applied. */
  private computeAimDirection(out: THREE.Vector3): THREE.Vector3 {
    const base = this.player.aimDirection;
    if (!base) return out.set(0, 0, -1);
    out.copy(base);
    if (this.externalRecoil) return out.normalize();
    if (this.offsetPitch === 0 && this.offsetYaw === 0) return out.normalize();
    // Pitch about the camera-right axis, yaw about world up.
    this.tmpA.set(0, 1, 0);
    this.tmpB.crossVectors(out, this.tmpA);
    if (this.tmpB.lengthSq() < 1e-8) this.tmpB.set(1, 0, 0);
    this.tmpB.normalize();
    scratch.qa.setFromAxisAngle(this.tmpB, this.offsetPitch);
    out.applyQuaternion(scratch.qa);
    scratch.qb.setFromAxisAngle(this.tmpA, -this.offsetYaw);
    out.applyQuaternion(scratch.qb);
    return out.normalize();
  }

  private applyRecoilRecovery(s: SlotState): void {
    // 'viewkick' Players recentre inside their own model (and cancel it when
    // the player compensates manually), so applying ours too would double up.
    if (this.recoilMode === 'viewkick') return;
    const rec = s.recoil.recover;
    if (rec.pitch === 0 && rec.yaw === 0) return;
    if (this.recoilMode === 'addRecoil') {
      this.player.addRecoil!(-rec.pitch, -rec.yaw);
    } else {
      this.offsetPitch -= rec.pitch;
      this.offsetYaw -= rec.yaw;
    }
  }

  // -- reload ---------------------------------------------------------------

  private beginReload(s: SlotState): boolean {
    if (s.reloadT >= 0) return false;
    if (s.magazine >= s.stats.magazine) return false;
    if (s.reserves <= 0) return false;
    s.reloadEmpty = s.magazine <= 0;
    const base = s.reloadEmpty ? s.stats.emptyReloadTime : s.stats.reloadTime;
    s.reloadDuration = Math.max(0.15, base * s.perks.reloadMul);
    s.reloadT = 0;
    this.beamActive = false;
    this.charge = 0;
    this.burstLeft = 0;
    return true;
  }

  private finishReload(s: SlotState): void {
    const want = s.stats.magazine - s.magazine;
    const take = Math.min(want, s.reserves);
    s.magazine += take;
    s.reserves -= take;
    s.reloadT = -1;
    s.recoil.reset();
    s.perks.reloadFinished();
    events.emit('weapon:reloaded', { weaponId: s.stats.id });
  }

  private cancelAction(s: SlotState): void {
    s.reloadT = -1;
    this.burstLeft = 0;
    this.charge = 0;
    this.chargeHeld = false;
    this.beamActive = false;
    this.pendingSingle = false;
    this.triggerLatched = true;
  }

  // -- construction helpers -------------------------------------------------

  private makeSlot(index: 0 | 1 | 2, weaponId: string): SlotState {
    const base = WEAPONS[weaponId] ?? WEAPONS[DEFAULT_LOADOUT[index]];
    const stats = applyPerkModifiers(base, cloneStats(base));
    stats.slot = SLOT_ORDER[index];
    const state: SlotState = {
      index,
      slot: SLOT_ORDER[index],
      base,
      stats,
      magazine: stats.magazine,
      reserves: stats.reserves,
      perks: null as unknown as PerkRuntime,
      recoil: new RecoilController(0x2f1a07 + index * 7919),
      reloadT: -1,
      reloadDuration: 0,
      reloadEmpty: false,
    };
    const activeIndexRef = (): number => this.activeIndex;
    const host: PerkHost = {
      get magazine() {
        return state.magazine;
      },
      get magazineSize() {
        return state.stats.magazine;
      },
      get reserves() {
        return state.reserves;
      },
      get stowed() {
        return state.index !== activeIndexRef();
      },
      get reloading() {
        return state.reloadT >= 0;
      },
      refundRounds: (count, fromReserves) => {
        const room = state.stats.magazine - state.magazine;
        const give = Math.min(count, room);
        if (give <= 0) return;
        if (fromReserves) {
          const take = Math.min(give, state.reserves);
          state.reserves -= take;
          state.magazine += take;
        } else {
          state.magazine += give;
        }
      },
      perkExplosion: (point, radius, damage, element) => {
        this.applySplash(point, radius, damage, element, null);
        this.vfx?.explosion?.(point, radius, element);
        events.emit('explosion', { point, radius, element });
      },
      instantReload: () => {
        const want = state.stats.magazine - state.magazine;
        const take = Math.min(want, state.reserves);
        state.magazine += take;
        state.reserves -= take;
        state.reloadT = -1;
        events.emit('weapon:reloaded', { weaponId: state.stats.id });
      },
    };

    state.perks = new PerkRuntime(host, base, stats);
    return state;
  }

  private slotForWeapon(id: string): SlotState | null {
    for (const s of this.slots) if (s.stats.id === id) return s;
    return null;
  }

  private nextDamageInfo(): DamageInfo {
    const info = this.damagePool[this.damageCursor];
    this.damageCursor = (this.damageCursor + 1) % this.damagePool.length;
    return info;
  }

  // -- render ---------------------------------------------------------------

  render(ctx: FrameContext, alpha: number): void {
    const s = this.slots[this.activeIndex];
    const st = this.vmState;
    const playing = this.engine.state === 'playing';

    st.camera = this.engine.host.camera;
    st.frameDt = ctx.frameDt;
    st.elapsed = ctx.elapsed;
    const vel = this.player.velocity;
    st.speed = this.player.speed ?? (vel ? Math.hypot(vel.x, vel.z) : 0);
    st.maxSpeed = REFERENCE_SPEED;
    st.grounded = this.player.grounded ?? true;
    st.sprinting = this.player.sprinting ?? false;
    st.crouching = this.player.crouching ?? false;
    st.ads = this.aimProgress;
    st.reload = s.reloadT >= 0 ? clamp01(s.reloadT / Math.max(1e-4, s.reloadDuration)) : -1;
    st.reloadEmpty = s.reloadEmpty;
    st.charge = Math.min(1, this.charge);
    st.perfectDraw = this.perfectDraw;
    st.magazine = s.magazine;
    st.collision = this.collision;
    st.visible = playing && this.scene != null;

    this.viewModel.render(st);
    this.projectiles.render(alpha);

    // Continuous beam: redrawn every frame while the trigger is held.
    if (this.beamActive && playing) {
      this.computeAimDirection(this.aimDir);
      const origin = this.player.eyePosition;
      if (origin) {
        const hit = this.collision?.raycastAll
          ? this.collision.raycastAll(origin, this.aimDir, MAX_RANGE, this.player.entityId ?? 0, this.hitBuf)
          : this.collision?.raycast(origin, this.aimDir, MAX_RANGE, this.hitBuf) ?? null;
        if (hit) this.beamEnd.copy(hit.point);
        else this.beamEnd.copy(origin).addScaledVector(this.aimDir, MAX_RANGE);
        this.viewModel.muzzleWorld(this.muzzleWorld);
        const from = this.muzzleWorld.lengthSq() > 1e-6 ? this.muzzleWorld : origin;
        this.vfx?.beam?.(from, this.beamEnd, s.stats.tracerWidth, s.stats.tracerColor);
      }
    }
  }

  dispose(): void {
    this.viewModel.dispose();
    this.projectiles.dispose();
    this.collision = null;
    this.scene = null;
  }

  // -- diagnostics used by the verification harness --------------------------

  /** Live pool statistics: `{ active, capacity, spawned, dropped }`. */
  get projectileStats(): {
    active: number;
    capacity: number;
    spawned: number;
    dropped: number;
  } {
    return {
      active: this.projectiles.activeCount,
      capacity: this.projectiles.capacity,
      spawned: this.projectiles.spawned,
      dropped: this.projectiles.dropped,
    };
  }

  /** Outstanding recoil climb in radians — should settle to ~0 within 0.5 s. */
  get recoilResidual(): number {
    return this.slots[this.activeIndex].recoil.residual;
  }

  /** Element colour of the equipped weapon, for the crosshair and HUD. */
  get elementColor(): number {
    return ELEMENT_COLOR[this.current.element];
  }
}
