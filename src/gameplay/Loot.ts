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
 * **An engram is a promise, not a payout.** Picking one up banks it (see
 * `./Engram`); it decodes when the mission ends, so the reveal lands on a
 * player who can read it. Chests are the same loop with a bigger number: a
 * procedurally-built container with a light shaft you can see across a valley,
 * opened with `interact`, that coughs up engrams into the same pickup pool.
 *
 * Everything is pooled: 32 pickups, five shared geometries, five shared
 * materials, three shared lights. Nothing is allocated after `bindLevel`
 * except when a level places a chest, which happens at build time.
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
import { Rng, clamp01, damp } from '@/util/math';
import { RARITY_COLOR, RARITY_ORDER, progression } from './Progression';
import { EngramSystem } from './Engram';

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
  /** Generosity banked by the source, carried into the engram queue. */
  luck: number;
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

/** How a level dresses a chest it places. */
export interface ChestOptions {
  /**
   * Generosity, 0..1.5. Feeds `progression.rollRarity` for the engrams inside
   * and scales the size of the light shaft, so a rich cache looks rich before
   * you reach it. 0.35 is a field cache; 1.2 is a boss vault.
   */
  luck?: number;
  /** Engrams inside. Defaults to 1 at luck 0, 3 at luck 1.5. */
  engrams?: number;
  /** Y rotation in radians. Defaults to a stable pseudo-random angle. */
  yaw?: number;
  /** Drop the chest onto the collision ground under `position`. Default true. */
  snapToGround?: boolean;
  /**
   * Which level owns it. Defaults to the bound level, then the engine's active
   * one — so a level may place chests from inside `load()`, before `bindLevel`.
   */
  level?: Level;
}

/** What `placeChest` hands back so a level can script or remove its caches. */
export interface ChestHandle {
  readonly id: number;
  readonly position: THREE.Vector3;
  readonly opened: boolean;
  /** Force it open (a scripted reward). Returns false if already open. */
  open(): boolean;
  /** Despawn and release it. Safe to call twice. */
  remove(): void;
}

interface Chest {
  id: number;
  root: THREE.Group;
  lid: THREE.Mesh;
  seam: THREE.Mesh;
  shaft: THREE.Mesh;
  level: Level;
  position: THREE.Vector3;
  luck: number;
  engrams: number;
  opened: boolean;
  /** 0..1 lid animation. */
  openT: number;
  phase: number;
  removed: boolean;
}

/** Geometry shared by every chest, built on the first placement. */
interface ChestGeometry {
  plinth: THREE.BufferGeometry;
  body: THREE.BufferGeometry;
  lid: THREE.BufferGeometry;
  seam: THREE.BufferGeometry;
  shaft: THREE.BufferGeometry;
}

const POOL_SIZE = 32;
const LIGHT_COUNT = 3;
/** Metres at which `interact` opens a chest, and the lid's swing time. */
const CHEST_REACH = 2.8;
const CHEST_OPEN_TIME = 0.55;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

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
  readonly stats = { dropped: 0, collected: 0, engrams: 0, orbs: 0, chests: 0 };

  /**
   * The decode half of the loop. Owned here rather than registered on the
   * engine because `Game.ts` is another owner's integration seam: the loot
   * system is already constructed and disposed there, so hanging the engram
   * queue off it needs no change to the wiring.
   */
  readonly engrams = new EngramSystem();

  // -- world chests ---------------------------------------------------------
  private chests: Chest[] = [];
  private chestGeo: ChestGeometry | null = null;
  private chestSeamMaterial: THREE.MeshStandardMaterial | null = null;
  private chestShaftMaterial: THREE.MeshBasicMaterial | null = null;
  private chestLight: THREE.PointLight | null = null;
  private nextChestId = 1;

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
        luck: 0,
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
    // Chests belong to the level they were placed in — a level may place them
    // during `load()`, before this runs, so they are culled by identity rather
    // than wiped wholesale.
    this.cullChests(level);
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

  /**
   * Spawn a pickup. Public so encounters and chests can drop directly.
   * `luck` rides along with engrams into the decode roll.
   */
  drop(d: LootDrop, luck = 0): boolean {
    const p = this.pickups.find((q) => !q.active);
    if (!p) return false;

    p.active = true;
    p.kind = d.kind;
    p.rarity = d.rarity ?? 'common';
    p.luck = luck;
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
  // World chests
  // -------------------------------------------------------------------------

  /**
   * Place a loot container in the world.
   *
   * ```ts
   * // inside a level, after the terrain exists:
   * game().loot.placeChest(new THREE.Vector3(120, 0, -40), { luck: 0.8, level: this });
   * ```
   *
   * The container is a procedurally-built mesh — no external asset — with a
   * pulsing seam and a light shaft sized by `luck`, so it reads as loot from
   * the far side of a valley rather than as scenery. It is opened with the
   * `interact` action inside `CHEST_REACH` metres, and pays out engrams into
   * the ordinary pickup pool, which means chest loot obeys exactly the same
   * magnet, feedback and decode rules as a boss drop.
   */
  placeChest(position: THREE.Vector3, opts: ChestOptions = {}): ChestHandle {
    const level = opts.level ?? this.level ?? this.engine.level;
    if (!level) throw new Error('placeChest: no level to attach to');
    const geo = this.chestAssets();
    const luck = Math.max(0, opts.luck ?? 0.35);
    const tier = settings.profile.tier;

    const root = new THREE.Group();
    root.name = 'lootChest';
    const body = new THREE.Mesh(geo.body, this.materials.surface('metal', {
      color: 0x39485a,
      roughness: 0.52,
      metalness: 1,
    }));
    const plinth = new THREE.Mesh(geo.plinth, this.materials.surface('rock', {
      color: 0x3a3a3e,
      roughness: 0.95,
    }));
    const lid = new THREE.Mesh(geo.lid, this.materials.surface('metal', {
      color: 0x4d6070,
      roughness: 0.4,
      metalness: 1,
    }));
    const seam = new THREE.Mesh(geo.seam, this.seamMaterial());
    const shaft = new THREE.Mesh(geo.shaft, this.shaftMaterial());
    // Shadow casting is the single most expensive thing a static prop can ask
    // for, so only the body casts, and only above the lowest tier.
    body.castShadow = tier !== 'low';
    plinth.receiveShadow = tier !== 'low';
    lid.castShadow = tier !== 'low';
    shaft.castShadow = false;
    seam.castShadow = false;
    // The shaft is the across-the-valley tell: taller and brighter the richer
    // the cache. Scaled rather than rebuilt so every chest shares one geometry.
    const shaftScale = 0.75 + luck * 0.9;
    shaft.scale.set(1, shaftScale, 1);
    shaft.position.y = 3.1 * shaftScale;
    root.add(plinth, body, lid, seam, shaft);

    root.position.copy(position);
    if (opts.snapToGround !== false) {
      const g = level.collision.sampleGround(position.x, position.z, position.y + 6);
      if (g) root.position.y = g.y;
    }
    root.rotation.y = opts.yaw ?? this.rng.range(0, Math.PI * 2);
    root.updateMatrixWorld(true);
    level.scene.add(root);

    const chest: Chest = {
      id: this.nextChestId++,
      root,
      lid,
      seam,
      shaft,
      level,
      position: root.position.clone(),
      luck,
      engrams: Math.max(1, Math.round(opts.engrams ?? 1 + luck * 1.4)),
      opened: false,
      openT: 0,
      phase: this.rng.range(0, Math.PI * 2),
      removed: false,
    };
    this.chests.push(chest);

    return {
      id: chest.id,
      position: chest.position,
      get opened(): boolean {
        return chest.opened;
      },
      open: () => this.openChest(chest),
      remove: () => this.removeChest(chest),
    };
  }

  /** Every chest currently placed, for encounter scripts and diagnostics. */
  get chestCount(): number {
    return this.chests.length;
  }

  /** Remove every chest. Called on dispose and when a level is replaced. */
  clearChests(): void {
    for (const c of this.chests.slice()) this.removeChest(c);
  }

  private cullChests(keep: Level | null): void {
    for (const c of this.chests.slice()) if (c.level !== keep) this.removeChest(c);
  }

  private removeChest(c: Chest): void {
    if (c.removed) return;
    c.removed = true;
    c.root.removeFromParent();
    const i = this.chests.indexOf(c);
    if (i >= 0) this.chests.splice(i, 1);
  }

  private openChest(c: Chest): boolean {
    if (c.opened || c.removed) return false;
    c.opened = true;
    this.stats.chests++;

    let best: ItemRarity = 'common';
    for (let i = 0; i < c.engrams; i++) {
      const rarity = progression.rollRarity(c.luck, this.rng);
      if (RARITY_ORDER.indexOf(rarity) > RARITY_ORDER.indexOf(best)) best = rarity;
      _v2.copy(c.position);
      _v2.y += 0.65;
      this.drop({ kind: 'engram', rarity, position: _v2 }, c.luck);
    }

    events.emit('ui:toast', {
      text: 'CACHE BREACHED',
      sub: `${c.engrams} engram${c.engrams === 1 ? '' : 's'} · decodes on extraction`,
      rarity: best,
      duration: 3.4,
    });
    events.emit('camera:shake', { amount: 0.06, duration: 0.35 });
    return true;
  }

  /** Lazily built so a session that never places a chest never pays for one. */
  private chestAssets(): ChestGeometry {
    if (this.chestGeo) return this.chestGeo;
    const tier = settings.profile.tier;
    const radial = tier === 'low' ? 8 : tier === 'medium' ? 12 : 16;
    // The lid geometry is translated so the mesh origin sits on its hinge at
    // the back edge; rotating the mesh then swings it open with no extra node.
    const lid = new THREE.BoxGeometry(1.02, 0.22, 0.72);
    lid.translate(0, 0.11, 0.36);
    this.chestGeo = {
      plinth: new THREE.BoxGeometry(1.24, 0.14, 0.94),
      body: new THREE.BoxGeometry(0.96, 0.5, 0.68),
      lid,
      seam: new THREE.BoxGeometry(1, 0.05, 0.72),
      // Open-ended, wider at the top: a shaft of light rather than a solid cone.
      shaft: new THREE.CylinderGeometry(0.62, 0.2, 6.2, radial, 1, true),
    };
    return this.chestGeo;
  }

  private seamMaterial(): THREE.MeshStandardMaterial {
    // Not `materials.emissive()`: that cache is shared with every other glow in
    // the game, and the pulse below mutates `emissiveIntensity`.
    if (!this.chestSeamMaterial) {
      this.chestSeamMaterial = new THREE.MeshStandardMaterial({
        color: 0x05070d,
        emissive: new THREE.Color().setHex(0x8fd8ff, THREE.SRGBColorSpace),
        emissiveIntensity: 3,
        roughness: 0.35,
        metalness: 0,
      });
    }
    return this.chestSeamMaterial;
  }

  private shaftMaterial(): THREE.MeshBasicMaterial {
    if (!this.chestShaftMaterial) {
      this.chestShaftMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHex(0x8fd8ff, THREE.SRGBColorSpace),
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    }
    return this.chestShaftMaterial;
  }

  /**
   * Fixed-step half: the only thing that can change a chest's state is the
   * player standing next to one and pressing `interact`.
   */
  private updateChests(): void {
    if (this.chests.length === 0) return;
    if (this.engine.state !== 'playing') return;
    if (!this.engine.input.pressed('interact')) return;
    const playerPos = this.player.position;
    let nearest: Chest | null = null;
    let nearestD = CHEST_REACH * CHEST_REACH;
    for (const c of this.chests) {
      if (c.opened) continue;
      const d = c.position.distanceToSquared(playerPos);
      if (d < nearestD) {
        nearestD = d;
        nearest = c;
      }
    }
    if (nearest) this.openChest(nearest);
  }

  /**
   * Presentation half: the idle tell. A slow breathing pulse on the seam and
   * the shaft, and one shared point light on whichever chest is closest — the
   * same "only the nearest gets a real light" rule the pickups use.
   */
  private renderChests(frameDt: number): void {
    if (this.chests.length === 0) return;
    const t = this.time;
    const reduced = settings.user.reducedMotion;
    const playerPos = this.player.position;
    let nearest: Chest | null = null;
    let nearestD = Infinity;

    for (const c of this.chests) {
      if (!c.opened && !reduced) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.7 + c.phase);
        c.seam.scale.setScalar(1 + pulse * 0.03);
        c.shaft.rotation.y = t * 0.18 + c.phase;
      }
      if (c.opened && c.openT < 1) {
        c.openT = Math.min(1, c.openT + frameDt / CHEST_OPEN_TIME);
        // Overshoot then settle: a lid that slams to its stop reads as a prop,
        // one that rebounds reads as a hinge.
        const e = 1 - (1 - c.openT) ** 3;
        c.lid.rotation.x = -e * 1.9 + Math.sin(e * Math.PI) * 0.16;
        c.lid.position.z = -0.36;
        c.lid.position.y = 0.36;
      }
      // A spent chest keeps its silhouette but loses the beacon: the tell must
      // mean "there is loot here", never "there was".
      const glow = c.opened ? damp(c.shaft.scale.x, 0, 4, frameDt) : 1;
      if (c.opened) {
        c.shaft.scale.x = glow;
        c.shaft.scale.z = glow;
        c.shaft.visible = glow > 0.02;
      }
      const d = c.position.distanceToSquared(playerPos);
      if (!c.opened && d < nearestD) {
        nearestD = d;
        nearest = c;
      }
    }

    if (this.chestSeamMaterial) {
      const pulse = reduced ? 1 : 1 + Math.sin(t * 1.7) * 0.35;
      this.chestSeamMaterial.emissiveIntensity = 3 * pulse;
    }
    if (this.chestShaftMaterial) {
      const pulse = reduced ? 1 : 1 + Math.sin(t * 1.1 + 1.3) * 0.3;
      this.chestShaftMaterial.opacity = 0.18 * pulse;
    }

    // One light for the whole chest population, and only above the low tier
    // where an extra shadowless point light is still affordable.
    if (settings.profile.tier === 'low' || !nearest || nearestD > 900) {
      if (this.chestLight) this.chestLight.visible = false;
      return;
    }
    if (!this.chestLight) {
      this.chestLight = new THREE.PointLight(0x8fd8ff, 0, 9, 2);
      this.chestLight.castShadow = false;
    }
    if (this.chestLight.parent !== nearest.root) nearest.root.add(this.chestLight);
    this.chestLight.position.set(0, 0.8, 0);
    this.chestLight.intensity = reduced ? 3 : 3 + Math.sin(t * 1.7 + nearest.phase) * 0.9;
    this.chestLight.visible = true;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    const dt = ctx.dt;
    this.time = ctx.elapsed;
    const playerPos = this.player.position;
    progression.tick(dt);
    this.updateChests();

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
    const luck = p.luck;
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
        // Banked, not opened. The decode is the end-of-mission moment; the
        // `loot:pickup` emitted below is the in-fight receipt for it.
        this.stats.engrams++;
        this.engrams.collect(rarity, this.faction, this.planet, luck);
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

  render(ctx: FrameContext, _alpha: number): void {
    const t = this.time;
    const reduced = settings.user.reducedMotion;
    this.renderChests(ctx.frameDt);
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
    this.clearChests();
    this.engrams.dispose();
    this.chestLight?.removeFromParent();
    this.chestLight?.dispose();
    this.chestLight = null;
    if (this.chestGeo) {
      for (const g of Object.values(this.chestGeo)) g.dispose();
      this.chestGeo = null;
    }
    // Body/plinth/lid materials come from the shared MaterialLibrary cache,
    // which owns them; the seam and shaft are ours because they are mutated.
    this.chestSeamMaterial?.dispose();
    this.chestSeamMaterial = null;
    this.chestShaftMaterial?.dispose();
    this.chestShaftMaterial = null;
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

/** Exported for tuning tools and for the loot-density review. */
export const LOOT_TUNING = { MAGNET_RANGE, PICKUP_RANGE, LIFETIME, KIND_COLOR };
