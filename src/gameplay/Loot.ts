/**
 * Loot: the drops, the pickups, and the rules about what is worth dropping.
 *
 * Two design rules drive everything here.
 *
 * **A pickup must be visible from across an arena.** Every drop is an emissive
 * core inside a counter-rotating shell, bobbing on its own phase, with a
 * rarity-coloured light. Lights are the expensive part, so only the three
 * nearest drops carry one and the rest rely on the emissive plus bloom.
 *
 * **A pickup must be worth walking to.** Ammo only drops for a slot the player
 * has actually depleted — a brick that gives you 4 rounds you did not need is
 * worse than no brick at all, because it teaches the player to ignore pickups.
 * Orbs and engrams always drop on schedule because their value never expires.
 *
 * Everything is pooled: 32 pickups, five shared geometries, five shared
 * materials, three shared lights. Nothing is allocated after `bindLevel`.
 */
import * as THREE from 'three';
import type { Engine, EngineSystem } from '@/core/Engine';
import type {
  FactionId,
  FrameContext,
  ItemRarity,
  Level,
  LootDrop,
  PlanetId,
  WeaponSlot,
} from '@/types';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import type { Player } from './Player';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { Rng, clamp01 } from '@/util/math';
import { RARITY_COLOR, progression } from './Progression';

export type LootKind = LootDrop['kind'];

/** Reach of the magnetic pull, and the radius at which the pickup resolves. */
export const MAGNET_RANGE = 2.5;
export const PICKUP_RANGE = 1.05;

const KIND_COLOR: Record<LootKind, number> = {
  ammo: 0xd8e4f0,
  heavyAmmo: 0x9b59d0,
  orb: 0xbfe6ff,
  engram: 0x8fd8ff,
  health: 0x5ce07a,
};

/** Seconds a drop survives before it despawns. */
const LIFETIME: Record<LootKind, number> = {
  ammo: 40,
  heavyAmmo: 55,
  orb: 30,
  engram: 120,
  health: 40,
};

interface Pickup {
  active: boolean;
  kind: LootKind;
  rarity: ItemRarity;
  core: THREE.Mesh;
  shell: THREE.Mesh;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  groundY: number;
  age: number;
  life: number;
  phase: number;
  spin: number;
  /** 0..1 magnet blend; once it starts it never lets go. */
  pull: number;
  scale: number;
}

/** What we need from the weapon system, without importing it. */
interface AmmoSink {
  readonly current: { slot: WeaponSlot };
  readonly reserves: number;
  readonly magazine: number;
  giveAmmo(slot: WeaponSlot, amount: number): void;
}

/** What we need from the ability system. */
interface SuperSink {
  addSuperEnergy(amount: number): void;
  readonly superEnergy: number;
}

const PLANET_FACTION: Record<PlanetId, FactionId> = {
  aurvangr: 'nordic',
  'zeta-reticuli': 'grey',
  khepri: 'mantis',
  'hive-prime': 'insectoid',
  'draco-ix': 'reptilian',
};

const POOL_SIZE = 32;
const LIGHT_COUNT = 3;

const _v = new THREE.Vector3();

export class LootSystem implements EngineSystem {
  readonly name = 'loot';

  private engine: Engine;
  private player: Player;
  private materials: MaterialLibrary;
  private group = new THREE.Group();
  private pickups: Pickup[] = [];
  private lights: THREE.PointLight[] = [];
  private geometry: Record<LootKind, THREE.BufferGeometry>;
  private shellGeometry: THREE.BufferGeometry;
  private coreMaterials: Record<LootKind, THREE.MeshStandardMaterial>;
  private shellMaterials = new Map<number, THREE.MeshBasicMaterial>();
  private rng = new Rng(0x10c7ee);
  private unsubs: Array<() => void> = [];
  private level: Level | null = null;
  private faction: FactionId = 'federation';
  private planet: PlanetId | null = null;
  private time = 0;
  /** Reused in render() — the nearest few drops that get a real light. */
  private lit: Pickup[] = [];

  /** Running totals for the end-of-activity screen. */
  readonly stats = { dropped: 0, collected: 0, engrams: 0, orbs: 0 };

  constructor(engine: Engine, player: Player, materials: MaterialLibrary) {
    this.engine = engine;
    this.player = player;
    this.materials = materials;
    this.group.name = 'loot';
    this.group.matrixAutoUpdate = false;

    // -- shared geometry ---------------------------------------------------
    this.geometry = {
      // Ammo bricks read as *objects*, not gems: flat boxes with a chamfer.
      ammo: new THREE.BoxGeometry(0.26, 0.1, 0.17),
      heavyAmmo: new THREE.BoxGeometry(0.34, 0.14, 0.22),
      orb: new THREE.IcosahedronGeometry(0.14, 1),
      engram: new THREE.OctahedronGeometry(0.19, 0),
      health: new THREE.TetrahedronGeometry(0.17, 0),
    };
    // One shell for everything: a wireframe-ish open cage that reads at range.
    this.shellGeometry = new THREE.IcosahedronGeometry(0.3, 0);

    this.coreMaterials = {
      ammo: materials.emissive(KIND_COLOR.ammo, 2.4),
      heavyAmmo: materials.emissive(KIND_COLOR.heavyAmmo, 3),
      orb: materials.emissive(KIND_COLOR.orb, 6),
      engram: materials.emissive(KIND_COLOR.engram, 3.4),
      health: materials.emissive(KIND_COLOR.health, 3.6),
    };

    for (let i = 0; i < POOL_SIZE; i++) {
      const kind: LootKind = 'ammo';
      const core = new THREE.Mesh(this.geometry[kind], this.coreMaterials[kind]);
      const shell = new THREE.Mesh(this.shellGeometry, this.shellMaterial(KIND_COLOR.ammo));
      core.castShadow = false;
      core.receiveShadow = false;
      shell.castShadow = false;
      core.visible = false;
      shell.visible = false;
      core.frustumCulled = true;
      shell.frustumCulled = true;
      this.group.add(core, shell);
      this.pickups.push({
        active: false,
        kind,
        rarity: 'common',
        core,
        shell,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        groundY: 0,
        age: 0,
        life: 30,
        phase: this.rng.range(0, Math.PI * 2),
        spin: this.rng.range(0.6, 1.4),
        pull: 0,
        scale: 1,
      });
    }

    for (let i = 0; i < LIGHT_COUNT; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 6, 2);
      l.castShadow = false;
      l.visible = false;
      this.lights.push(l);
      this.group.add(l);
    }

    this.unsubs.push(
      events.on('enemy:killed', (p) => this.onEnemyKilled(p.position, p.score)),
      events.on('level:loaded', () => this.clear()),
    );
  }

  /**
   * Shell materials are built here rather than taken from
   * `MaterialLibrary.additive()`: that helper hands back a *shared, cached*
   * material, and setting `wireframe` on it would turn every tracer and beam
   * in the game into a wireframe too.
   */
  private shellMaterial(color: number): THREE.MeshBasicMaterial {
    let m = this.shellMaterials.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHex(color, THREE.SRGBColorSpace),
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        wireframe: true,
        toneMapped: false,
      });
      this.shellMaterials.set(color, m);
    }
    return m;
  }

  // -------------------------------------------------------------------------
  // Level lifecycle
  // -------------------------------------------------------------------------

  bindLevel(level: Level): void {
    this.clear();
    this.level = level;
    level.scene.add(this.group);
    this.group.updateMatrix();
    const id = level.id as PlanetId;
    this.planet = PLANET_FACTION[id] ? id : null;
    this.faction = this.planet ? PLANET_FACTION[this.planet] : 'federation';
    if (this.planet) progression.visit(this.planet);
  }

  clear(): void {
    for (const p of this.pickups) this.release(p);
  }

  // -------------------------------------------------------------------------
  // Dropping
  // -------------------------------------------------------------------------

  /**
   * The kill table. Rank is inferred from the archetype's score value, which is
   * the one piece of "how big was that thing" the kill event actually carries.
   */
  private onEnemyKilled(position: THREE.Vector3, score: number): void {
    progression.recordKill(this.planet, score);
    const boss = score >= 400;
    const champion = score >= 180;
    const elite = score >= 80;
    const luck = boss ? 1.4 : champion ? 0.8 : elite ? 0.35 : 0;

    // Orbs of Light: the currency that keeps supers flowing. Elites always
    // leave one, ordinary units sometimes do.
    if (elite || this.rng.bool(0.3)) {
      this.drop({ kind: 'orb', position });
    }

    // Engrams. Rare from anything, near-certain from a boss.
    const engramChance = boss ? 0.95 : champion ? 0.45 : elite ? 0.16 : 0.045;
    if (this.rng.bool(engramChance)) {
      this.drop({
        kind: 'engram',
        rarity: progression.rollRarity(luck, this.rng),
        position,
      });
    }

    // Ammo, but only if the player actually needs it.
    const need = this.ammoNeed();
    if (need === 'power') {
      if (this.rng.bool(boss || champion ? 0.7 : elite ? 0.3 : 0.06)) {
        this.drop({ kind: 'heavyAmmo', position });
      }
    } else if (need !== 'none' && this.rng.bool(elite ? 0.75 : 0.42)) {
      this.drop({ kind: 'ammo', position });
    }

    // Health, only when it would matter.
    if (this.player.health01 < 0.7 && this.rng.bool(elite ? 0.4 : 0.14)) {
      this.drop({ kind: 'health', position });
    }
  }

  /**
   * Which slot is genuinely short. Returns 'none' when the player is topped up,
   * so we can skip the drop entirely rather than litter the arena.
   */
  private ammoNeed(): 'primary' | 'power' | 'none' {
    const weapons = this.engine.get<EngineSystem & AmmoSink>('weapons');
    if (!weapons) return 'primary';
    const slot = weapons.current.slot;
    const reserves = weapons.reserves;
    const mag = Math.max(1, weapons.magazine);
    if (slot === 'power' && reserves <= mag) return 'power';
    // Under three magazines in reserve counts as "short".
    if (reserves < mag * 3) return 'primary';
    // Even when the held weapon is full, heavy runs dry quietly; offer it
    // occasionally so the power slot is not dead weight.
    return this.rng.bool(0.18) ? 'power' : 'none';
  }

  /** Spawn a pickup. Public so encounters and chests can drop directly. */
  drop(d: LootDrop): boolean {
    const p = this.pickups.find((q) => !q.active);
    if (!p) return false;

    p.active = true;
    p.kind = d.kind;
    p.rarity = d.rarity ?? 'common';
    p.age = 0;
    p.life = LIFETIME[d.kind];
    p.pull = 0;
    p.phase = this.rng.range(0, Math.PI * 2);
    p.spin = this.rng.range(0.7, 1.5) * (this.rng.bool() ? 1 : -1);
    p.scale = d.kind === 'engram' ? 1.15 : 1;

    p.position.copy(d.position);
    p.position.y += 0.35;
    // A small pop so drops scatter instead of stacking inside each other.
    // Kept low deliberately: the first capture had drops hanging at head height
    // for over a second, which reads as floating debris rather than as loot.
    p.velocity.set(this.rng.range(-0.9, 0.9), this.rng.range(1.2, 2.2), this.rng.range(-0.9, 0.9));
    p.groundY = this.sampleGround(p.position.x, p.position.z, p.position.y);

    const color = d.kind === 'engram' ? RARITY_COLOR[p.rarity] : KIND_COLOR[d.kind];
    p.core.geometry = this.geometry[d.kind];
    p.core.material = this.coreMaterials[d.kind];
    p.shell.material = this.shellMaterial(color);
    p.core.visible = true;
    p.shell.visible = true;
    p.core.position.copy(p.position);
    p.shell.position.copy(p.position);
    p.shell.scale.setScalar(p.scale);
    p.core.scale.setScalar(p.scale);

    this.stats.dropped++;
    return true;
  }

  private sampleGround(x: number, z: number, fallback: number): number {
    const g = this.level?.collision.sampleGround(x, z);
    return g ? g.y : fallback - 1;
  }

  private release(p: Pickup): void {
    if (!p.active) return;
    p.active = false;
    p.core.visible = false;
    p.shell.visible = false;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    const dt = ctx.dt;
    this.time = ctx.elapsed;
    const playerPos = this.player.position;
    progression.tick(dt);

    for (const p of this.pickups) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age > p.life) {
        this.release(p);
        continue;
      }

      // -- settle onto the ground ------------------------------------------
      if (p.pull <= 0) {
        // Heavier than world gravity so a drop is on the floor in well under a
        // second; a pickup you have to wait for is a pickup you walk past.
        p.velocity.y -= 34 * dt;
        p.position.addScaledVector(p.velocity, dt);
        const rest = p.groundY + 0.42;
        if (p.position.y <= rest) {
          p.position.y = rest;
          if (p.velocity.y < 0) {
            // One soft bounce, then it stays put.
            p.velocity.y = p.velocity.y < -3 ? -p.velocity.y * 0.28 : 0;
            p.velocity.x *= 0.4;
            p.velocity.z *= 0.4;
          }
        }
      }

      // -- magnetic attract --------------------------------------------------
      _v.subVectors(playerPos, p.position);
      const dist = _v.length();
      if (dist < MAGNET_RANGE || p.pull > 0) {
        p.pull = Math.min(1, p.pull + dt * 2.6);
        // Accelerating pull: slow reach, fast finish, so it reads as attraction
        // rather than as the pickup being teleported to your face.
        const speed = 3 + p.pull * p.pull * 16;
        if (dist > 1e-3) p.position.addScaledVector(_v.multiplyScalar(1 / dist), speed * dt);
        p.velocity.set(0, 0, 0);
      }

      if (dist < PICKUP_RANGE) {
        this.collect(p);
        continue;
      }
    }
  }

  private collect(p: Pickup): void {
    const kind = p.kind;
    const rarity = p.rarity;
    this.release(p);
    this.stats.collected++;

    switch (kind) {
      case 'ammo': {
        const weapons = this.engine.get<EngineSystem & AmmoSink>('weapons');
        if (weapons) {
          // A brick tops up both primaries: the player should never have to
          // swap weapons just to make a pickup worth walking to.
          const amount = Math.max(12, Math.round(weapons.magazine * 1.5));
          weapons.giveAmmo('kinetic', amount);
          weapons.giveAmmo('energy', amount);
        }
        break;
      }
      case 'heavyAmmo': {
        const weapons = this.engine.get<EngineSystem & AmmoSink>('weapons');
        weapons?.giveAmmo('power', 6);
        break;
      }
      case 'orb': {
        const abilities = this.engine.get<EngineSystem & SuperSink>('abilities');
        abilities?.addSuperEnergy(0.11);
        this.stats.orbs++;
        break;
      }
      case 'engram': {
        this.stats.engrams++;
        const item = progression.rollWeapon(
          pickWeaponForRarity(rarity, this.rng),
          rarity === 'exotic' || rarity === 'legendary' ? 'power' : this.rng.bool() ? 'kinetic' : 'energy',
          this.rng.pick(['kinetic', 'solar', 'arc', 'void', 'stasis'] as const),
          this.faction,
          rarity,
        );
        progression.addToVault(item);
        break;
      }
      case 'health': {
        const heal = Math.min(this.player.maxHealth - this.player.health, this.player.maxHealth * 0.35);
        if (heal > 0) {
          this.player.health += heal;
          events.emit('player:healed', { amount: heal });
        }
        break;
      }
      default:
        break;
    }
    events.emit('loot:pickup', { kind, rarity });
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  render(_ctx: FrameContext, _alpha: number): void {
    const t = this.time;
    const reduced = settings.user.reducedMotion;
    let lightIndex = 0;
    const playerPos = this.player.position;

    // Sort-free "nearest three": one pass keeping the best candidates.
    const best = this.lit;
    best.length = 0;
    for (const p of this.pickups) {
      if (!p.active) continue;

      const bob = reduced ? 0 : Math.sin(t * 2.1 + p.phase) * 0.09;
      const settle = clamp01(p.age * 3);
      const s = p.scale * (0.35 + 0.65 * settle) * (1 - p.pull * 0.55);

      p.core.position.set(p.position.x, p.position.y + bob, p.position.z);
      p.core.rotation.y = t * p.spin * 1.8 + p.phase;
      p.core.rotation.x = Math.sin(t * 0.9 + p.phase) * 0.4;
      p.core.scale.setScalar(s);

      p.shell.position.copy(p.core.position);
      // Counter-rotation: two objects turning opposite ways read as one
      // designed device rather than as a spinning prop.
      p.shell.rotation.y = -t * p.spin * 0.9 + p.phase;
      p.shell.rotation.z = t * p.spin * 0.5;
      const pulse = 1 + (reduced ? 0 : Math.sin(t * 3.4 + p.phase) * 0.07);
      p.shell.scale.setScalar(s * pulse);

      // Fade the last two seconds so a despawn is never a pop.
      const remaining = p.life - p.age;
      const fade = clamp01(remaining / 2);
      if (fade < 1) p.shell.scale.multiplyScalar(fade);

      if (best.length < LIGHT_COUNT) best.push(p);
      else {
        let worst = 0;
        let worstD = -1;
        for (let i = 0; i < best.length; i++) {
          const d = best[i].position.distanceToSquared(playerPos);
          if (d > worstD) {
            worstD = d;
            worst = i;
          }
        }
        if (p.position.distanceToSquared(playerPos) < worstD) best[worst] = p;
      }
    }

    for (const p of best) {
      const l = this.lights[lightIndex++];
      if (!l) break;
      const color = p.kind === 'engram' ? RARITY_COLOR[p.rarity] : KIND_COLOR[p.kind];
      l.color.setHex(color, THREE.SRGBColorSpace);
      l.position.copy(p.core.position);
      l.intensity = (p.kind === 'orb' ? 4.5 : 2.8) * (reduced ? 0.7 : 1 + Math.sin(t * 3 + p.phase) * 0.15);
      l.distance = p.kind === 'orb' ? 7 : 5;
      l.visible = true;
    }
    for (let i = lightIndex; i < this.lights.length; i++) this.lights[i].visible = false;
    best.length = 0;
  }

  get activeCount(): number {
    let n = 0;
    for (const p of this.pickups) if (p.active) n++;
    return n;
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.clear();
    this.group.removeFromParent();
    for (const g of Object.values(this.geometry)) g.dispose();
    this.shellGeometry.dispose();
    // Core materials come from the shared MaterialLibrary cache; that library
    // owns and disposes them. Only the shells are ours to release.
    for (const m of this.shellMaterials.values()) m.dispose();
    this.shellMaterials.clear();
    for (const l of this.lights) l.dispose();
    this.lights.length = 0;
    this.pickups.length = 0;
    this.level = null;
  }
}

/**
 * Which weapon family an engram of a given rarity produces. Higher rarities
 * skew toward the power slot, because that is where the "oh, *that* dropped"
 * moments live.
 */
function pickWeaponForRarity(rarity: ItemRarity, rng: Rng): string {
  const common = ['autoRifle', 'pulseRifle', 'scoutRifle', 'sidearm', 'submachineGun'];
  const good = ['handCannon', 'shotgun', 'sniperRifle', 'fusionRifle', 'bow', 'traceRifle'];
  const power = ['rocketLauncher', 'grenadeLauncher', 'machineGun'];
  if (rarity === 'exotic' || rarity === 'legendary') {
    return rng.bool(0.45) ? rng.pick(power) : rng.pick(good);
  }
  if (rarity === 'rare') return rng.bool(0.5) ? rng.pick(good) : rng.pick(common);
  return rng.pick(common);
}

/** Exported for tuning tools and for the loot-density review. */
export const LOOT_TUNING = { MAGNET_RANGE, PICKUP_RANGE, LIFETIME, KIND_COLOR };
