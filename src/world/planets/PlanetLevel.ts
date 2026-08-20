/**
 * PlanetLevel — the shared surface-level base every world is built on.
 *
 * A planet level is four things stitched together, and this class owns all four
 * so the individual worlds only have to be *art*:
 *
 *  1. **The place.** `TerrainBuilder` from this planet's recipe, its analytic
 *     height field wired straight into the collision world (exact, allocation
 *     free, and about forty times cheaper than raycasting the mesh), and every
 *     cliff/boulder/spire mesh registered with the BVH.
 *  2. **The light.** A `SkyDome` from this planet's atmosphere, whose sun is the
 *     level's only key light, plus an IBL rebuilt *from that same sky* so metal
 *     reflects the world it is standing in rather than the previous planet.
 *  3. **The camera's first impression.** The world origin is usually a pit
 *     ringed by three-hundred-metre peaks, so the spawn is *searched for*:
 *     candidates are scored by local prominence minus how much sky the horizon
 *     eats, and then a heading is scored across the compass for an open view
 *     with a silhouette in it. Every set piece a subclass builds is then placed
 *     in that heading's frame, which is what makes the opening shot composed
 *     instead of accidental.
 *  4. **The fight.** Spawn volumes and a wave script handed to the AI director,
 *     and the faction registry called so this world's species exist.
 *
 * ## Set-piece batching
 *
 * Subclasses do not create meshes. They push transformed geometry into named
 * `PropBatch`es, and `flushBatches()` merges each batch into exactly one mesh —
 * so a Jötunn hall of two hundred carved blocks costs two draw calls, not two
 * hundred. Batches also carry world-space box-projected UVs, which is what stops
 * a stretched cylinder from reading as smeared plastic.
 */
import * as THREE from 'three';
import { phase, resetProfile } from '@/util/profile';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  Damageable,
  DamageInfo,
  FrameContext,
  HitRegion,
  Level,
  PlanetDescriptor,
  PlanetId,
  SurfaceKind,
} from '@/types';
import { settings } from '@/core/Settings';
import { clamp, clamp01, Rng, TAU } from '@/util/math';
import { BvhCollisionWorld } from '@/gameplay/Physics';
import type { MaterialLibrary, SurfaceOptions } from '@/gfx/materials/MaterialLibrary';
import type { SurfaceMaterialName } from '@/gfx/materials/SurfaceMaterials';
import { SkyDome } from '@/gfx/sky/SkyDome';
import {
  ATMOSPHERES,
  cloneAtmosphere,
  type AtmosphereProfile,
} from '@/gfx/sky/AtmosphereProfile';
import { TerrainBuilder, terrainRecipe, type TerrainResult } from '@/gfx/terrain/TerrainBuilder';
import type { HeightField, TerrainDescriptor } from '@/gfx/terrain/HeightField';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import type { EnemyManager } from '@/gameplay/enemies/EnemyManager';
import type { AiDirector } from '@/gameplay/ai/AiDirector';
import type {
  DestructibleTarget,
  EncounterScript,
  SpawnVolume,
} from '@/gameplay/ai/EncounterDirector';
import { events } from '@/core/EventBus';
import {
  bindFactionSpawners,
  disposeFactionEffects,
  installFactionBehaviours,
  registerAllFactions,
} from '@/gameplay/enemies/factions';
import type { PlanetDeps } from './index';

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * `MaterialLibrary.surface()` is declared against `SurfaceKind`, but it forwards
 * unchanged to the private `build(name, opts)` which accepts every baked surface
 * — including the faction sets (`nordicIronwork`, `greyAlloy`, `mantisResin`, …)
 * that levels are precisely the consumer of. Widen the call here rather than
 * duplicating the cache, and see the report: the fix belongs in the library.
 */
type WideSurface = (name: SurfaceMaterialName, opts?: SurfaceOptions) => THREE.MeshStandardMaterial;

/**
 * World-space box projection. Non-indexed geometry only: the dominant axis is
 * taken from each *triangle's* geometric normal so smooth-shaded lathes and
 * spheres do not swim across the axis switch the way per-vertex normals make
 * them.
 */
function boxProjectUv(geo: THREE.BufferGeometry, tileMetres: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const inv = 1 / Math.max(0.05, tileMetres);
  for (let t = 0; t < n; t += 3) {
    const ax = pos.getX(t);
    const ay = pos.getY(t);
    const az = pos.getZ(t);
    const bx = pos.getX(t + 1) - ax;
    const by = pos.getY(t + 1) - ay;
    const bz = pos.getZ(t + 1) - az;
    const cx = pos.getX(t + 2) - ax;
    const cy = pos.getY(t + 2) - ay;
    const cz = pos.getZ(t + 2) - az;
    const nx = Math.abs(by * cz - bz * cy);
    const ny = Math.abs(bz * cx - bx * cz);
    const nz = Math.abs(bx * cy - by * cx);
    // 0 = project along X, 1 = along Y, 2 = along Z.
    const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
    for (let k = 0; k < 3; k++) {
      const px = pos.getX(t + k);
      const py = pos.getY(t + k);
      const pz = pos.getZ(t + k);
      const u = axis === 0 ? pz : px;
      const v = axis === 1 ? pz : py;
      uv[(t + k) * 2] = u * inv;
      uv[(t + k) * 2 + 1] = v * inv;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Strip everything the merge does not need, and flatten to non-indexed. */
function normalizeForMerge(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  for (const key of Object.keys(flat.attributes)) {
    // `color` survives: additive light shafts and glow cards carry their fade
    // in vertex colour so they need no per-shape material.
    if (key !== 'position' && key !== 'normal' && key !== 'uv' && key !== 'color') {
      flat.deleteAttribute(key);
    }
  }
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  // Hand-built geometry (`tapered`, `prism`, `revolved`, `tube`) carries no UVs.
  // A batch with `tile: 0` would then try to merge a UV-less shape with a
  // primitive that has them, and `mergeGeometries` refuses the whole batch.
  if (!flat.getAttribute('uv')) {
    const n = flat.getAttribute('position').count;
    flat.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  flat.morphAttributes = {};
  flat.clearGroups();
  return flat;
}

export interface PropBatchOptions {
  /** Collision surface reported by raycasts against this batch. */
  surface?: SurfaceKind;
  /** Register the merged mesh with the BVH. */
  collide?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Metres per texture tile for the world-space box projection. 0 keeps UVs. */
  tile?: number;
  renderOrder?: number;
}

/**
 * An accumulator for one material's worth of set-piece geometry. Everything
 * pushed here ends up in a single merged mesh.
 */
export class PropBatch {
  readonly parts: THREE.BufferGeometry[] = [];
  mesh: THREE.Mesh | null = null;

  constructor(
    readonly name: string,
    readonly material: THREE.Material,
    readonly options: PropBatchOptions,
  ) {}

  /** Copy `geo`, transform it into world space and queue it. Never consumes. */
  add(geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): void {
    const g = normalizeForMerge(geo.clone());
    if (matrix) g.applyMatrix4(matrix);
    const tile = this.options.tile ?? 0;
    if (tile > 0) boxProjectUv(g, tile);
    this.parts.push(g);
  }

  /** Convenience: position/rotation/scale instead of a matrix. */
  addAt(
    geo: THREE.BufferGeometry,
    position: THREE.Vector3,
    rotationY = 0,
    scale: THREE.Vector3 | number = 1,
    tiltX = 0,
    tiltZ = 0,
  ): void {
    _q.setFromEuler(new THREE.Euler(tiltX, rotationY, tiltZ, 'YXZ'));
    const s = typeof scale === 'number' ? _v.set(scale, scale, scale) : _v.copy(scale);
    _m.compose(position, _q, s);
    this.add(geo, _m);
  }

  triangles(): number {
    let t = 0;
    for (const p of this.parts) t += p.getAttribute('position').count / 3;
    return t;
  }
}

export interface SpawnVolumeSpec {
  id: string;
  /** Metres ahead of the spawn along the authored view heading. */
  forward: number;
  /** Metres to the right of the spawn heading. */
  right: number;
  radius: number;
  minPlayerDistance?: number;
  archetypes?: string[];
}

export interface PlanetLevelOptions {
  /** Half-extent of the navigable play space, metres. */
  navRadius?: number;
  /**
   * Where the authored spawn view should sit relative to the sun. `across`
   * gives classic three-quarter lighting: the key rakes in from the side, which
   * is the only way to get form on a world with no sky fill to speak of.
   */
  spawnFacing?: 'away' | 'toward' | 'across' | 'any';
  /** Radius the spawn search covers around the world origin, metres. */
  spawnSearchRadius?: number;
  /** Camera-following particulate: snow, dust, spores. */
  dust?: { density: number; color: number; size: number } | null;
}

/** Deep-enough copy of a terrain recipe so a world can retune it safely. */
export function cloneRecipe(d: TerrainDescriptor): TerrainDescriptor {
  return {
    ...d,
    layers: d.layers.map((l) => ({ ...l })),
    cliffs: { ...d.cliffs },
    rocks: { ...d.rocks, entries: d.rocks.entries.map((e) => ({ ...e })) },
    flora: { ...d.flora, entries: d.flora.entries.map((e) => ({ ...e })) },
    water: d.water ? { ...d.water } : null,
  };
}

/**
 * Only one planet level is live at a time, but during a planet-to-planet
 * transition the incoming level's `load()` runs *before* the outgoing level's
 * `dispose()`. Tracking who is current stops the departing world from tearing
 * down the faction runtime the arriving world has just bound itself to.
 */
let currentLevel: PlanetLevel | null = null;

// ---------------------------------------------------------------------------
// Destructible objectives
// ---------------------------------------------------------------------------

/**
 * Entity ids for level-owned damageables.
 *
 * `EnemyAgent` allocates from 1000 upward and the player is 0, so destructibles
 * take a range neither can ever reach in a session. They have to be distinct:
 * `CollisionWorld.removeProxiesFor` and every status-effect lookup key off this
 * number alone.
 */
let nextDestructibleId = 500000;

/** How a destructible reports itself when it dies. */
export interface DestructibleOptions {
  /** Radius of the shootable proxy. Make it fit the silhouette, not the mesh. */
  radius: number;
  /** Half-height for a capsule proxy; 0 gives a sphere. */
  halfHeight?: number;
  /** Surface the impact VFX should use. */
  surface?: SurfaceKind;
  /** Called once, when health first reaches zero. */
  onDestroyed?: (prop: DestructibleProp) => void;
}

/**
 * A world object the player can shoot to pieces, and that a wave's `destroy`
 * trigger can name.
 *
 * It is deliberately the thinnest thing that satisfies both halves of the seam:
 * `Damageable` so `WeaponSystem` and `DamageResolver` can hit it through a
 * `HitProxy`, and `DestructibleTarget` so `EncounterDirector` can read its
 * health without knowing what it is. Nothing else — no mesh, no animation, no
 * state machine. The level owns the geometry; this owns the number.
 */
export class DestructibleProp implements Damageable, DestructibleTarget {
  readonly entityId = nextDestructibleId++;
  readonly id: string;
  readonly maxHealth: number;
  health: number;
  shield = 0;
  maxShield = 0;
  readonly position = new THREE.Vector3();
  readonly surface: SurfaceKind;
  private readonly onDestroyed: ((prop: DestructibleProp) => void) | null;
  private destroyed = false;

  constructor(id: string, position: THREE.Vector3, health: number, opts: DestructibleOptions) {
    this.id = id;
    this.position.copy(position);
    this.maxHealth = Math.max(1, health);
    this.health = this.maxHealth;
    this.surface = opts.surface ?? 'rock';
    this.onDestroyed = opts.onDestroyed ?? null;
  }

  get isDead(): boolean {
    return this.health <= 0;
  }

  applyDamage(info: DamageInfo): number {
    if (this.destroyed) return 0;
    const before = this.health;
    this.health = Math.max(0, this.health - Math.max(0, info.amount));
    const dealt = before - this.health;
    if (dealt > 0) {
      // The HUD's damage numbers and its target health bar are both built from
      // this one event, which is why a destructible emits it and an enemy agent
      // does too. `EnemyManager` is not in the path here — the weapon calls
      // `applyDamage` straight through the hit proxy — so nothing else would.
      events.emit('enemy:damaged', {
        amount: dealt,
        element: info.element,
        region: (info.region ?? 'body') as HitRegion,
        precision: false,
        point: info.point,
        normal: info.normal,
        direction: info.direction,
        sourceId: info.sourceId,
        splash: info.splash,
        impulse: info.impulse,
        remaining: this.health,
        entityId: this.entityId,
      });
    }
    if (this.health <= 0 && !this.destroyed) {
      this.destroyed = true;
      this.onDestroyed?.(this);
    }
    return dealt;
  }

  getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position);
  }
}

/**
 * Several destructibles that a single objective treats as one thing — Khepri's
 * three brood pods, for instance, where the line reads "burn out the brood pods"
 * and the bar has to fill across all of them.
 *
 * It satisfies `DestructibleTarget` by summing, so the director needs no notion
 * of a group and the HUD bar drains smoothly rather than in thirds.
 */
export class DestructibleCluster implements DestructibleTarget {
  readonly id: string;
  readonly members: DestructibleProp[] = [];

  constructor(id: string) {
    this.id = id;
  }

  add(prop: DestructibleProp): DestructibleProp {
    this.members.push(prop);
    return prop;
  }

  get health(): number {
    let h = 0;
    for (let i = 0; i < this.members.length; i++) h += Math.max(0, this.members[i].health);
    return h;
  }

  get maxHealth(): number {
    let h = 0;
    for (let i = 0; i < this.members.length; i++) h += this.members[i].maxHealth;
    return Math.max(1, h);
  }

  /**
   * Where to point the objective marker: the centroid of whatever is still
   * standing. Once a pod is down it stops pulling the marker toward a place
   * there is no longer any reason to go.
   */
  get position(): THREE.Vector3 {
    _clusterAt.set(0, 0, 0);
    let n = 0;
    for (const m of this.members) {
      if (m.health <= 0) continue;
      _clusterAt.add(m.position);
      n++;
    }
    if (n === 0 && this.members.length > 0) return this.members[0].position;
    if (n > 0) _clusterAt.multiplyScalar(1 / n);
    return _clusterAt;
  }
}

const _clusterAt = new THREE.Vector3();

// ---------------------------------------------------------------------------
// PlanetLevel
// ---------------------------------------------------------------------------

export abstract class PlanetLevel implements Level {
  readonly id: string;
  readonly scene = new THREE.Scene();
  readonly collision = new BvhCollisionWorld();
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly sunColor = new THREE.Color(1, 1, 1);
  readonly fogColor = new THREE.Color(0.5, 0.6, 0.7);

  readonly planetId: PlanetId;
  readonly descriptor: PlanetDescriptor;

  /** Read by `AiDirector.bindLevel` to size the nav grid. */
  readonly navBounds = new THREE.Box3();
  readonly navRadius: number;

  /** Handed to the encounter director once it is bound to this level. */
  readonly spawnVolumes: SpawnVolume[] = [];
  encounter: EncounterScript | null = null;

  /**
   * Objective targets this level owns, handed to the encounter director at the
   * same moment the volumes are. Registered late for the same reason they are:
   * `AiDirector.bindLevel` clears the director's target map, and the game binds
   * the director after `load()` has finished.
   */
  readonly objectiveTargets: DestructibleTarget[] = [];
  /** Every shootable prop this level built, for proxy teardown. */
  protected readonly destructibles: DestructibleProp[] = [];

  protected readonly deps: PlanetDeps;
  protected readonly materials: MaterialLibrary;
  protected readonly vfx: VfxSystem;
  protected readonly enemies: EnemyManager;
  protected readonly rng: Rng;
  protected readonly options: Required<PlanetLevelOptions>;
  /**
   * Tier-derived density scalar for set-piece detail, ~0.55 (low) to ~1.2
   * (ultra). Multiply *counts* by this, never sizes — a low tier should have
   * fewer vines, not smaller trees.
   */
  protected readonly detail: number;

  protected sky!: SkyDome;
  protected builder!: TerrainBuilder;
  protected terrain!: TerrainResult;
  protected heightField!: HeightField;

  /** Root for every authored set piece. Cleared wholesale on dispose. */
  protected readonly props = new THREE.Group();

  /** Authored spawn, and the heading the whole composition is framed around. */
  protected readonly spawnPos = new THREE.Vector3();
  protected spawnYaw = 0;
  /** Unit basis of the authored view: -Z at yaw 0, matching the camera. */
  protected readonly viewForward = new THREE.Vector3(0, 0, -1);
  protected readonly viewRight = new THREE.Vector3(1, 0, 0);

  /** A second, purely cinematic camera for review shots and arrival cuts. */
  protected readonly vistaPos = new THREE.Vector3();
  protected vistaYaw = 0;
  protected vistaPitch = -0.06;

  private readonly batches = new Map<string, PropBatch>();
  private readonly scratchGeometry: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly propMeshes: THREE.Mesh[] = [];
  private readonly camera: THREE.PerspectiveCamera;
  /** Camera world position, refreshed at the top of every simulation step. */
  protected readonly camPos = new THREE.Vector3();
  private aiWired = false;
  private disposed = false;

  constructor(deps: PlanetDeps, descriptor: PlanetDescriptor, options: PlanetLevelOptions = {}) {
    this.deps = deps;
    this.materials = deps.materials;
    this.vfx = deps.vfx;
    this.enemies = deps.enemies;
    this.descriptor = descriptor;
    this.planetId = descriptor.id;
    this.id = `planet:${descriptor.id}`;
    this.scene.name = this.id;
    this.camera = deps.enemies.engine.host.camera;

    let seed = 0x9e3779b9;
    for (let i = 0; i < descriptor.id.length; i++) {
      seed = (Math.imul(seed ^ descriptor.id.charCodeAt(i), 0x85ebca6b) >>> 0) || 1;
    }
    this.rng = new Rng(seed);

    this.options = {
      navRadius: options.navRadius ?? 118,
      spawnFacing: options.spawnFacing ?? 'any',
      spawnSearchRadius: options.spawnSearchRadius ?? 340,
      dust: options.dust ?? null,
    };
    this.navRadius = this.options.navRadius;
    this.detail = clamp(0.45 + settings.profile.terrainDetail * 0.6, 0.5, 1.25);
    this.props.name = 'setPieces';
    this.scene.add(this.props);
  }

  // -- subclass contract -----------------------------------------------------

  /** This world's atmosphere. Override to retune it without editing the table. */
  protected atmosphere(): AtmosphereProfile {
    return cloneAtmosphere(ATMOSPHERES[this.planetId]);
  }

  /** This world's terrain recipe. Override to retune it. */
  protected recipe(): TerrainDescriptor {
    return terrainRecipe(this.planetId);
  }

  /** Build the set pieces. Called after terrain, sky and spawn are resolved. */
  protected abstract decorate(): void;

  /** Where enemies arrive from. Called after `decorate`. */
  protected abstract spawnVolumeSpecs(): SpawnVolumeSpec[];

  /** The mission. Called after `spawnVolumeSpecs`. */
  protected abstract encounterScript(): EncounterScript;

  /** Per-simulation-step world logic: ambient emitters, animated props. */
  protected tick(_ctx: FrameContext): void {}

  // -- lifecycle -------------------------------------------------------------

  async load(onProgress?: (t: number, label: string) => void): Promise<void> {
    const prof: Record<string, number> = {};
    let _t = performance.now();
    const mark = (name: string): void => {
      prof[name] = Math.round(performance.now() - _t);
      _t = performance.now();
    };
    (globalThis as unknown as { GF_LOAD_PROFILE?: unknown }).GF_LOAD_PROFILE = prof;
    resetProfile();
    onProgress?.(0.04, 'Reading atmosphere');
    const endSky = phase('skyDome');
    this.sky = new SkyDome(this.atmosphere());
    this.sky.attach(this.scene);
    this.sky.applyFog(this.scene);
    // The IBL must be integrated from *this* sky, or every metal surface in the
    // level reflects whichever planet was loaded last.
    endSky();
    const endIbl = phase('rebuildEnvironment');
    this.materials.rebuildEnvironment(this.sky.environmentProfile());
    endIbl();
    this.scene.environment = this.materials.environment;
    // NOT `sun.position`: SkyDome only places the light in `update()`, so at
    // load time it is still the DirectionalLight default (0,1,0) — which would
    // hand PostFX a sun straight overhead on every world.
    this.sunDirection.copy(this.sky.atmosphere.sunDirection).normalize();
    this.sunColor.copy(this.sky.sun.color);
    const fog = this.scene.fog as THREE.FogExp2 | THREE.Fog | null;
    if (fog) this.fogColor.copy(fog.color);

    mark('sky+ibl');
    onProgress?.(0.12, 'Raising terrain');
    this.builder = new TerrainBuilder(this.materials);
    this.terrain = await this.builder.build(this.recipe(), (t) =>
      onProgress?.(0.12 + t * 0.62, 'Raising terrain'),
    );
    mark('terrain.build');
    this.scene.add(this.terrain.object);
    this.heightField = this.terrain.heightField;

    // Analytic ground beats a mesh raycast on every axis that matters here:
    // exact at any scale, constant time, and it allocates nothing.
    this.collision.groundFn = this.heightField.groundFn;
    this.collision.heightFn = this.heightField.heightFn;
    const endBvh = phase('collision.addMesh');
    for (const mesh of this.terrain.colliders) this.collision.addMesh(mesh, 'rock');
    endBvh();

    mark('colliders');
    onProgress?.(0.78, 'Surveying landing site');
    const endSpawn = phase('pickSpawn');
    this.pickSpawn();
    endSpawn();
    mark('pickSpawn');

    onProgress?.(0.84, 'Placing structures');
    const endDec = phase('decorate');
    this.decorate();
    endDec();
    mark('decorate');
    this.flushBatches();
    mark('flushBatches');
    this.releaseScratch();

    onProgress?.(0.94, 'Briefing');
    for (const spec of this.spawnVolumeSpecs()) this.spawnVolumes.push(this.makeVolume(spec));
    this.encounter = this.encounterScript();

    const dust = this.options.dust;
    if (dust) this.vfx.ambientDust(null, dust.density, dust.color, dust.size);

    registerAllFactions();
    bindFactionSpawners(this.enemies);
    currentLevel = this;
    onProgress?.(1, 'Ready');
  }

  update(ctx: FrameContext): void {
    if (this.disposed) return;
    this.camera.getWorldPosition(this.camPos);
    // The dome is 400 m across. Without this it is left behind in about four
    // seconds of sprinting and the player runs out of the sky.
    this.sky.update(ctx.elapsed, this.camPos);
    this.builder.update(this.camera, ctx.elapsed);
    if (!this.aiWired) this.wireAi();
    this.tick(ctx);
  }

  getSpawnPoint(): { position: THREE.Vector3; yaw: number } {
    return { position: this.spawnPos.clone(), yaw: this.spawnYaw };
  }

  /** A composed camera for arrival cuts and review captures. */
  getVistaCamera(): { position: THREE.Vector3; yaw: number; pitch: number } {
    return { position: this.vistaPos.clone(), yaw: this.vistaYaw, pitch: this.vistaPitch };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (currentLevel === this) {
      currentLevel = null;
      disposeFactionEffects();
    }
    for (const mesh of this.propMeshes) {
      mesh.geometry.dispose();
      this.props.remove(mesh);
    }
    this.propMeshes.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.releaseScratch();
    for (const d of this.destructibles) this.collision.removeProxiesFor(d.entityId);
    this.destructibles.length = 0;
    this.objectiveTargets.length = 0;
    this.batches.clear();
    this.terrain?.dispose();
    this.sky?.dispose();
    this.collision.clear();
    this.scene.clear();
    this.scene.environment = null;
  }

  // -- AI wiring -------------------------------------------------------------

  /**
   * `AiDirector.bindLevel` clears the encounter director's volume list, and the
   * game binds the director *after* the level has loaded — so volumes handed
   * over during `load()` would be thrown away. The level's own `update()` is
   * called before any system's, and only once the engine is running the level,
   * which makes the first simulation step the earliest correct moment.
   */
  private wireAi(): void {
    this.aiWired = true;
    const director = this.enemies.engine.get<AiDirector>('ai');
    if (!director) return;
    installFactionBehaviours(director);
    for (const v of this.spawnVolumes) director.addSpawnVolume(v);
    // Before `startEncounter`, so a wave whose `destroy` trigger fires on the
    // first frame still finds its target rather than silently falling back to a
    // kill count.
    for (const t of this.objectiveTargets) director.encounters.registerTarget(t);
    if (this.encounter) director.startEncounter(this.encounter);
  }

  private makeVolume(spec: SpawnVolumeSpec): SpawnVolume {
    const p = this.atSpawn(spec.forward, spec.right, 0.6);
    return {
      id: spec.id,
      position: p,
      radius: spec.radius,
      minPlayerDistance: spec.minPlayerDistance ?? 26,
      archetypes: spec.archetypes ?? [],
      enabled: true,
      cooldown: 0,
    };
  }

  // -- traversal helpers -----------------------------------------------------

  /**
   * A flight of steps climbing `rise` metres from `foot` along `yaw`, and the
   * world point of the top landing.
   *
   * Verticality is only verticality if the player can get up it, and the number
   * that decides that is `MOVE.stepHeight` — 0.45 m. A step taller than that is
   * a wall, so `stepRise` defaults comfortably under it and the count is derived
   * rather than authored. Each tread is a solid block sunk `bury` metres so the
   * flight follows uneven ground without showing daylight underneath.
   *
   * The nav grid samples terrain height only, so a flight is invisible to it:
   * enemies will not path up these, and the ground the flight stands on stops
   * being walkable. That is the intended trade — this is *player* verticality,
   * and the block it makes is cover for everyone.
   */
  protected stairs(
    batch: PropBatch,
    foot: THREE.Vector3,
    yaw: number,
    rise: number,
    width: number,
    tread = 1.15,
    stepRise = 0.38,
  ): THREE.Vector3 {
    const steps = Math.max(1, Math.ceil(rise / stepRise));
    const per = rise / steps;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const bury = 1.6;
    for (let i = 0; i < steps; i++) {
      const d = tread * (i + 0.5);
      const x = foot.x + fx * d;
      const z = foot.z + fz * d;
      const h = per * (i + 1) + bury;
      _v3.set(x, foot.y - bury, z);
      batch.addAt(this.temp(tapered(width, h, tread, 0, 0, 0.02, this.rng)), _v3.clone(), yaw);
    }
    return new THREE.Vector3(
      foot.x + fx * (tread * steps + 0.6),
      foot.y + rise,
      foot.z + fz * (tread * steps + 0.6),
    );
  }

  /**
   * A flat span from `from` to `to`, both at their own heights, `width` wide.
   *
   * Always pair this with `stairs`. A flight authored to a fixed foot position
   * either falls short of the thing it climbs to — leaving a gap at deck height
   * — or overshoots into it, which is worse: the treads end up *inside* the
   * structure and the player walks into a solid. The fix is to make the flight
   * deliberately short and let a landing close the remainder, which is also what
   * a real stair does.
   */
  protected landing(
    batch: PropBatch,
    from: THREE.Vector3,
    to: THREE.Vector3,
    width: number,
    thickness = 1.1,
  ): void {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const y = Math.min(from.y, to.y);
    _v3.set((from.x + to.x) * 0.5, y - thickness + 0.05, (from.z + to.z) * 0.5);
    batch.addAt(
      this.temp(tapered(width, thickness, len + 1.2, 0, 0, 0.02, this.rng)),
      _v3.clone(),
      Math.atan2(dx, dz) + Math.PI,
    );
  }

  // -- destructible objectives -----------------------------------------------

  /**
   * Build a shootable objective prop at `position`.
   *
   * Two registrations are needed and both are easy to forget: a `HitProxy` on
   * the collision world (without it the thing is scenery — bullets pass through
   * whatever mesh you drew for it, because the batch mesh is static geometry and
   * carries no damageable), and a `DestructibleTarget` on the encounter director
   * (without it the wave falls back to counting kills and the objective bar
   * shows the wrong number). This does both.
   *
   * `register` false builds a member of a `DestructibleCluster` — the cluster is
   * what the director watches, not the individual pod.
   */
  protected destructible(
    id: string,
    position: THREE.Vector3,
    health: number,
    opts: DestructibleOptions,
    register = true,
  ): DestructibleProp {
    const prop = new DestructibleProp(id, position, health, opts);
    this.destructibles.push(prop);
    this.collision.addProxy({
      damageable: prop,
      region: 'body',
      offset: new THREE.Vector3(),
      radius: opts.radius,
      halfHeight: opts.halfHeight ?? 0,
      multiplier: 1,
      enabled: true,
      // Static: the proxy never moves, so its world position is authored once
      // rather than refreshed per step like an agent's.
      world: position.clone(),
    });
    if (register) this.objectiveTargets.push(prop);
    return prop;
  }

  /** Register a multi-part objective — the cluster, not its members. */
  protected objectiveTarget<T extends DestructibleTarget>(target: T): T {
    this.objectiveTargets.push(target);
    return target;
  }

  /**
   * Standard destruction response: a blast where the prop stood, and the proxy
   * retired so a dead object cannot keep soaking rounds.
   */
  protected breakDestructible(prop: DestructibleProp, radius = 5): void {
    this.collision.removeProxiesFor(prop.entityId);
    this.vfx.explosion?.(prop.position, radius, 'solar');
    events.emit('explosion', { point: prop.position.clone(), radius, element: 'solar' });
  }

  // -- set-piece helpers -----------------------------------------------------

  /** A cached shared surface, widened to the full baked-surface catalogue. */
  protected surface(name: SurfaceMaterialName, opts: SurfaceOptions = {}): THREE.MeshStandardMaterial {
    return (this.materials.surface as unknown as WideSurface)(name, opts);
  }

  /** A cached emissive; faction accents and rune light live here. */
  protected glow(color: number, intensity: number, opts: SurfaceOptions = {}): THREE.MeshStandardMaterial {
    return this.materials.emissive(color, intensity, opts);
  }

  /** Register a material this level created itself, for disposal. */
  protected own<T extends THREE.Material>(m: T): T {
    this.ownedMaterials.push(m);
    return m;
  }

  /** Register a temporary geometry; released once `decorate()` has finished. */
  protected temp<T extends THREE.BufferGeometry>(g: T): T {
    this.scratchGeometry.push(g);
    return g;
  }

  /** Named accumulator for one material's worth of set-piece geometry. */
  protected batch(
    name: string,
    material: THREE.Material,
    options: PropBatchOptions = {},
  ): PropBatch {
    let b = this.batches.get(name);
    if (!b) {
      b = new PropBatch(name, material, options);
      this.batches.set(name, b);
    }
    return b;
  }

  /** Merge every batch into one mesh each and put them in the scene. */
  private flushBatches(): void {
    for (const b of this.batches.values()) {
      if (b.parts.length === 0) continue;
      const merged = b.parts.length === 1 ? b.parts[0] : mergeGeometries(b.parts, false);
      if (b.parts.length > 1) for (const p of b.parts) p.dispose();
      b.parts.length = 0;
      if (!merged) continue;
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `prop:${b.name}`;
      mesh.castShadow = b.options.castShadow ?? true;
      mesh.receiveShadow = b.options.receiveShadow ?? true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (b.options.renderOrder != null) mesh.renderOrder = b.options.renderOrder;
      b.mesh = mesh;
      this.props.add(mesh);
      this.propMeshes.push(mesh);
      if (b.options.collide) this.collision.addMesh(mesh, b.options.surface ?? 'rock');
    }
  }

  private releaseScratch(): void {
    for (const g of this.scratchGeometry) g.dispose();
    this.scratchGeometry.length = 0;
  }

  // -- placement -------------------------------------------------------------

  protected groundAt(x: number, z: number): number {
    return this.heightField.height(x, z);
  }

  protected slopeAt(x: number, z: number): number {
    return this.heightField.slope(x, z);
  }

  /**
   * A world position in the authored view frame: `forward` metres along the
   * spawn heading, `right` metres to its right, sitting on the ground plus
   * `lift`. This is the coordinate system every set piece is composed in.
   */
  protected atSpawn(forward: number, right: number, lift = 0): THREE.Vector3 {
    const x = this.spawnPos.x + this.viewForward.x * forward + this.viewRight.x * right;
    const z = this.spawnPos.z + this.viewForward.z * forward + this.viewRight.z * right;
    return new THREE.Vector3(x, this.groundAt(x, z) + lift, z);
  }

  /** Yaw that faces a world point from another, in the camera's convention. */
  protected yawTowards(from: THREE.Vector3, to: THREE.Vector3): number {
    return Math.atan2(from.x - to.x, from.z - to.z);
  }

  /**
   * Flatten a disc of ground into the collision world with a raised pad, so a
   * structure has something level to stand on instead of hovering over a slope.
   * Returns the pad height.
   */
  protected padHeight(centre: THREE.Vector3, radius: number, samples = 9): number {
    let hi = -Infinity;
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * TAU;
      const r = i === 0 ? 0 : radius;
      hi = Math.max(hi, this.groundAt(centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r));
    }
    return hi;
  }

  // -- spawn search ----------------------------------------------------------

  /**
   * Choose *where the player stands and which way they are looking* as one
   * decision, because they are one decision.
   *
   * The first version scored positions alone, by prominence minus horizon
   * occlusion, and reliably put the player on a knife-edge ridge: maximally
   * prominent, maximally open, and useless — the ground fell away on both sides
   * so every authored set piece ended up strung down a slope behind the crest.
   *
   * What a level designer actually wants is a *corridor*: a hundred and seventy
   * metres of ground in front of you that stays within a few metres of your own
   * height, so the composition has a floor to stand on, with the horizon opening
   * out beyond it. So the search scores (site, heading) pairs and the dominant
   * term is corridor flatness, not prominence.
   */
  private pickSpawn(): void {
    const hf = this.heightField;
    const R = this.options.spawnSearchRadius;
    const SITES = 150;
    const HEADINGS = 24;
    /** Distances the composition actually occupies. */
    const CORRIDOR = [25, 50, 80, 110, 140, 175];
    /** Distances that decide whether there is sky above the horizon. */
    const HORIZON = [230, 320, 430, 560];

    const sunXZ = _v2.set(this.sunDirection.x, 0, this.sunDirection.z);
    const sunLen = sunXZ.length();
    if (sunLen > 1e-4) sunXZ.multiplyScalar(1 / sunLen);
    const facing = this.options.spawnFacing;

    let bestScore = -Infinity;
    let bx = 0;
    let bz = 0;
    let by = hf.height(0, 0);
    let byaw = 0;

    for (let i = 0; i < SITES; i++) {
      // Golden-angle spiral: even coverage with none of a grid's axis bias.
      const t = i / SITES;
      const a = i * 2.399963;
      const r = Math.sqrt(t) * R;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = hf.height(x, z);

      // Standable, and not a ridge crest.
      if (hf.slope(x, z) > 0.42) continue;
      let rough = 0;
      for (let k = 0; k < 6; k++) {
        const ka = (k / 6) * TAU;
        rough += Math.abs(hf.height(x + Math.cos(ka) * 13, z + Math.sin(ka) * 13) - y);
      }
      if (rough > 34) continue;

      for (let j = 0; j < HEADINGS; j++) {
        const yaw = (j / HEADINGS) * TAU;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);

        // Corridor: metres of vertical deviation beyond a 5 m tolerance.
        let corridor = 0;
        let mean = 0;
        for (const d of CORRIDOR) {
          const h = hf.height(x + fx * d, z + fz * d);
          corridor += Math.max(0, Math.abs(h - y) - 5);
          mean += h;
        }
        mean /= CORRIDOR.length;

        // Horizon: anything rising more than about five degrees eats the sky.
        let block = 0;
        let relief = 0;
        let prev = mean;
        for (const d of HORIZON) {
          const h = hf.height(x + fx * d, z + fz * d);
          const rise = (h - y) / d;
          if (rise > 0.09) block += rise;
          relief += Math.abs(h - prev);
          prev = h;
        }

        let score = -corridor * 0.9 - block * 190 - rough * 0.9;
        // Standing a couple of metres over the corridor tilts the composition
        // very slightly downward, which is how an establishing shot is framed.
        score += clamp(y - mean, -4, 7) * 1.6;
        // Some relief out on the horizon, so the landmark has company.
        score += clamp(relief, 0, 260) * 0.03;

        if (sunLen > 1e-4 && facing !== 'any') {
          const d = fx * sunXZ.x + fz * sunXZ.z;
          const bias =
            facing === 'toward' ? d : facing === 'away' ? -d : 1 - Math.abs(d) * 1.6;
          score += bias * 26;
        }

        if (score > bestScore) {
          bestScore = score;
          bx = x;
          bz = z;
          by = y;
          byaw = yaw;
        }
      }
    }

    this.spawnPos.set(bx, by + 1.15, bz);
    this.spawnYaw = byaw;
    this.viewForward.set(-Math.sin(byaw), 0, -Math.cos(byaw)).normalize();
    // Written out rather than crossed: `forward x up` and `up x forward` both
    // come out as the camera's *left* in this convention, and a mirrored frame
    // is a bug you only notice after authoring an asymmetric composition.
    this.viewRight.set(Math.cos(byaw), 0, -Math.sin(byaw)).normalize();

    const nr = this.options.navRadius;
    this.navBounds.min.set(bx - nr, by - 70, bz - nr);
    this.navBounds.max.set(bx + nr, by + 90, bz + nr);

    // The vista camera stands back and above the spawn on the same heading, so
    // a review frame and the player's first frame are of the same thing.
    const vx = bx - this.viewForward.x * 20;
    const vz = bz - this.viewForward.z * 20;
    this.vistaPos.set(vx, Math.max(hf.height(vx, vz), by) + 5, vz);
    this.vistaYaw = byaw;
    this.vistaPitch = -0.09;
  }


  // -- diagnostics -----------------------------------------------------------

  /** Static budget report, for the capture harness and the perf gate. */
  stats(): Record<string, number> {
    let propTris = 0;
    for (const m of this.propMeshes) {
      const pos = m.geometry.getAttribute('position');
      propTris += pos ? pos.count / 3 : 0;
    }
    return {
      propMeshes: this.propMeshes.length,
      propTriangles: propTris,
      terrainTriangles: this.terrain?.stats.terrainTriangles ?? 0,
      cliffTriangles: this.terrain?.stats.cliffTriangles ?? 0,
      scatterDrawCalls: this.terrain?.stats.scatterDrawCalls ?? 0,
      colliders: this.terrain?.colliders.length ?? 0,
      spawnVolumes: this.spawnVolumes.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Geometry kit — shared shapes the three worlds all draw from
// ---------------------------------------------------------------------------

/**
 * A tapered, slightly irregular block. The workhorse: pillars, lintels, hull
 * plates, monoliths and buttresses are all this with different numbers.
 *
 * `taper` shrinks the top face, `lean` shears it sideways, and `jitter` pushes
 * every corner by a seeded amount so a row of them never reads as clones.
 */
export function tapered(
  width: number,
  height: number,
  depth: number,
  taper: number,
  lean: number,
  jitter: number,
  rng: Rng,
): THREE.BufferGeometry {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const tw = hw * (1 - taper);
  const td = hd * (1 - taper);
  const j = (): number => (rng.next() - 0.5) * 2 * jitter;
  const v: number[] = [
    -hw + j(), 0, -hd + j(),
    hw + j(), 0, -hd + j(),
    hw + j(), 0, hd + j(),
    -hw + j(), 0, hd + j(),
    -tw + lean + j(), height, -td + j(),
    tw + lean + j(), height, -td + j(),
    tw + lean + j(), height, td + j(),
    -tw + lean + j(), height, td + j(),
  ];
  const idx = [
    0, 2, 1, 0, 3, 2, // bottom (wound down)
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A crystal / ice-spike prism: an n-sided tapered shaft with a point on top.
 * Flat-shaded so the facets catch a grazing sun as hard edges.
 */
export function prism(
  sides: number,
  radius: number,
  height: number,
  tip: number,
  rng: Rng,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const shoulder = height * (1 - tip);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * TAU;
    const r = radius * (0.72 + rng.next() * 0.56);
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
  }
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * TAU;
    const r = radius * 0.62 * (0.7 + rng.next() * 0.6);
    pos.push(Math.cos(a) * r, shoulder, Math.sin(a) * r);
  }
  pos.push(0, height, 0); // tip
  pos.push(0, 0, 0); // base centre
  const tipI = sides * 2;
  const baseI = tipI + 1;
  for (let i = 0; i < sides; i++) {
    const n = (i + 1) % sides;
    idx.push(i, sides + i, sides + n, i, sides + n, n);
    idx.push(sides + i, tipI, sides + n);
    idx.push(baseI, n, i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A profile revolved around Y with per-ring radial noise — trunks, brood pods,
 * alloy domes. `segments` controls how round it reads in silhouette.
 */
export function revolved(
  profile: Array<[number, number]>,
  segments: number,
  wobble: number,
  rng: Rng,
): THREE.BufferGeometry {
  const rings = profile.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const noise: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) noise.push(1 + (rng.next() - 0.5) * 2 * wobble);
  }
  for (let r = 0; r < rings; r++) {
    const [radius, y] = profile[r];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * TAU;
      const rr = radius * noise[r * segments + s];
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
    }
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const n = (s + 1) % segments;
      const a = r * segments + s;
      const b = r * segments + n;
      const c = (r + 1) * segments + s;
      const d = (r + 1) * segments + n;
      idx.push(a, c, d, a, d, b);
    }
  }
  // Caps, so the shape is watertight for the BVH.
  const bottom = pos.length / 3;
  pos.push(0, profile[0][1], 0);
  const top = bottom + 1;
  pos.push(0, profile[rings - 1][1], 0);
  for (let s = 0; s < segments; s++) {
    const n = (s + 1) % segments;
    idx.push(bottom, n, s);
    idx.push(top, (rings - 1) * segments + s, (rings - 1) * segments + n);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A swept tube along a polyline — vines, cables, conduits, roots. Radius may
 * taper from `r0` at the start to `r1` at the end.
 */
export function tube(
  points: THREE.Vector3[],
  r0: number,
  r1: number,
  sides = 6,
): THREE.BufferGeometry {
  const n = points.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    tangent.subVectors(b, a);
    if (tangent.lengthSq() < 1e-8) tangent.set(0, 1, 0);
    tangent.normalize();
    normal.set(0, 1, 0);
    if (Math.abs(tangent.y) > 0.94) normal.set(1, 0, 0);
    binormal.crossVectors(tangent, normal).normalize();
    normal.crossVectors(binormal, tangent).normalize();
    const t = n === 1 ? 0 : i / (n - 1);
    const r = r0 + (r1 - r0) * t;
    for (let s = 0; s < sides; s++) {
      const ang = (s / sides) * TAU;
      const cx = Math.cos(ang) * r;
      const cy = Math.sin(ang) * r;
      pos.push(
        points[i].x + normal.x * cx + binormal.x * cy,
        points[i].y + normal.y * cx + binormal.y * cy,
        points[i].z + normal.z * cx + binormal.z * cy,
      );
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const m = (s + 1) % sides;
      const a = i * sides + s;
      const b = i * sides + m;
      const c = (i + 1) * sides + s;
      const d = (i + 1) * sides + m;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A flat ring band lying in XZ — rune bands, alloy seams, pool rims. */
export function bandRing(inner: number, outer: number, segments: number): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(inner, outer, segments);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Shared up axis for level maths that needs one. */
export const LEVEL_UP = _up;

/** Reusable scratch, so composition maths in a subclass allocates nothing. */
export const levelScratch = { a: _v, b: _v2, c: _v3, m: _m, q: _q };

/**
 * A soft light-shaft cone: wide at the base, narrow at the apex, with vertex
 * alpha fading out at both ends so it never shows a hard rim against geometry.
 * Used with an additive material for god rays and aurora spill.
 */
export function shaftCone(
  topRadius: number,
  bottomRadius: number,
  height: number,
  color: THREE.Color,
  segments = 10,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(topRadius, bottomRadius, height, segments, 5, true);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // 0 at the bottom of the shaft, 1 at the source. Brightest just under the
    // source, faded to nothing at the floor so there is never a hard rim.
    const t = clamp01(pos.getY(i) / height + 0.5);
    const a = Math.pow(t, 1.6) * (0.35 + 0.65 * t);
    col[i * 3] = color.r * a;
    col[i * 3 + 1] = color.g * a;
    col[i * 3 + 2] = color.b * a;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * A vertical glow card pair (two crossed quads) with vertex-colour falloff —
 * the cheap way to put a haloed emissive in a frame without a light.
 */
export function glowCross(width: number, height: number, color: THREE.Color): THREE.BufferGeometry {
  const half = width * 0.5;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let plane = 0; plane < 2; plane++) {
    const base = plane * 4;
    const dx = plane === 0 ? half : 0;
    const dz = plane === 0 ? 0 : half;
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, height, dz, -dx, height, -dz);
    for (let k = 0; k < 4; k++) {
      const a = k < 2 ? 0.15 : 1;
      col.push(color.r * a, color.g * a, color.b * a);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
