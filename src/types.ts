/**
 * Galactic Federation — shared contracts.
 *
 * Every subsystem codes against the interfaces in this file. Treat it as the
 * engine's ABI: additive changes are cheap, renames are expensive.
 */
import type * as THREE from 'three';

// ---------------------------------------------------------------------------
// Time & simulation
// ---------------------------------------------------------------------------

/** One simulation step. `dt` is the fixed step in seconds; `alpha` is render blend. */
export interface FrameContext {
  /** Fixed simulation delta, seconds (1/60 by default). */
  dt: number;
  /** Wall-clock delta for the rendered frame, seconds (may exceed dt). */
  frameDt: number;
  /** Seconds since engine start. */
  elapsed: number;
  /** Monotonic simulation tick counter. */
  tick: number;
}

export interface Updatable {
  update(ctx: FrameContext): void;
}

export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Quality / settings
// ---------------------------------------------------------------------------

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityProfile {
  tier: QualityTier;
  /** Device pixel ratio ceiling. */
  maxPixelRatio: number;
  shadowMapSize: number;
  /** Number of cascaded shadow splits. */
  shadowCascades: number;
  ssaoEnabled: boolean;
  ssaoSamples: number;
  bloomEnabled: boolean;
  motionBlurEnabled: boolean;
  ssrEnabled: boolean;
  volumetricLightEnabled: boolean;
  volumetricSteps: number;
  taaEnabled: boolean;
  /** Anisotropic filtering level for world textures. */
  anisotropy: number;
  /** Procedural texture resolution for world materials. */
  textureSize: number;
  /** Max simultaneously simulated particles. */
  particleBudget: number;
  /** Max simultaneously active enemies. */
  enemyBudget: number;
  /** Terrain mesh resolution multiplier. */
  terrainDetail: number;
  foliageDensity: number;
  decalBudget: number;
}

// ---------------------------------------------------------------------------
// Damage, elements, combat maths
// ---------------------------------------------------------------------------

export type DamageElement = 'kinetic' | 'solar' | 'arc' | 'void' | 'stasis';

export type HitRegion = 'body' | 'head' | 'limb' | 'critSpot' | 'shield';

export interface DamageInfo {
  amount: number;
  element: DamageElement;
  region: HitRegion;
  /** True when the hit rolled/landed a precision multiplier. */
  precision: boolean;
  /** World-space point of impact. */
  point: THREE.Vector3;
  /** Surface normal at impact. */
  normal: THREE.Vector3;
  /** Direction the projectile was travelling. */
  direction: THREE.Vector3;
  /** Entity id of the attacker; 0 = player. */
  sourceId: number;
  /** Set when the damage came from a splash/AoE source. */
  splash?: boolean;
  /** Impulse to apply to ragdolls/physics, in newtons-ish game units. */
  impulse?: number;
}

export interface Damageable {
  readonly entityId: number;
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  readonly isDead: boolean;
  /** Returns damage actually dealt after resistances/shields. */
  applyDamage(info: DamageInfo): number;
  /** World-space position used for aim assist, AoE falloff and audio. */
  getWorldPosition(out: THREE.Vector3): THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Collision / physics
// ---------------------------------------------------------------------------

export interface RaycastHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Material/surface descriptor for impact VFX + audio selection. */
  surface: SurfaceKind;
  /** Set when the ray struck a damageable entity. */
  damageable?: Damageable;
  region?: HitRegion;
  object?: THREE.Object3D;
}

export type SurfaceKind =
  | 'rock'
  | 'metal'
  | 'sand'
  | 'ice'
  | 'organic'
  | 'chitin'
  | 'glass'
  | 'energy'
  | 'water'
  | 'concrete'
  | 'foliage'
  | 'flesh';

/** The world's collision + query interface. Levels provide an implementation. */
export interface CollisionWorld {
  /** Static geometry raycast. Returns null on miss. */
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    out?: RaycastHit,
  ): RaycastHit | null;
  /** Sweep a capsule and resolve penetration. Mutates `position` in place. */
  resolveCapsule(
    position: THREE.Vector3,
    radius: number,
    halfHeight: number,
    velocity: THREE.Vector3,
    dt: number,
  ): CapsuleResolveResult;
  /** Ground height sample used by AI + spawn placement. Returns null if none. */
  sampleGround(x: number, z: number, maxY?: number): { y: number; normal: THREE.Vector3 } | null;
  /** Line-of-sight test between two points against static geometry. */
  lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean;
}

export interface CapsuleResolveResult {
  grounded: boolean;
  groundNormal: THREE.Vector3;
  /** Steepness of contacted ground in radians. */
  slope: number;
  /** True when the capsule was pushed by a wall this step. */
  touchedWall: boolean;
  wallNormal: THREE.Vector3;
  /** Impact speed along the ground normal on the frame of landing. */
  landingImpact: number;
}

// ---------------------------------------------------------------------------
// Factions & enemies
// ---------------------------------------------------------------------------

export type FactionId = 'nordic' | 'grey' | 'mantis' | 'insectoid' | 'reptilian' | 'federation';

export type EnemyRank = 'minor' | 'standard' | 'elite' | 'champion' | 'boss';

export interface EnemyArchetype {
  id: string;
  faction: FactionId;
  rank: EnemyRank;
  displayName: string;
  health: number;
  shield: number;
  shieldElement: DamageElement | null;
  moveSpeed: number;
  sprintSpeed: number;
  /** Preferred engagement distance in metres. */
  preferredRange: number;
  /** Eye height for line-of-sight and headshots. */
  eyeHeight: number;
  capsuleRadius: number;
  capsuleHalfHeight: number;
  /** Damage per shot/hit. */
  attackDamage: number;
  attackInterval: number;
  /** Radians of aim error at max range. */
  accuracy: number;
  /** Behaviour bias; the AI blends these. */
  aggression: number;
  /** How readily the unit takes cover, 0..1. */
  caution: number;
  /** True for flying units — skips ground snapping. */
  flying: boolean;
  /** XP / score value. */
  score: number;
  abilities: string[];
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export type WeaponSlot = 'kinetic' | 'energy' | 'power';

export type WeaponFamily =
  | 'autoRifle'
  | 'pulseRifle'
  | 'scoutRifle'
  | 'handCannon'
  | 'sidearm'
  | 'submachineGun'
  | 'shotgun'
  | 'sniperRifle'
  | 'fusionRifle'
  | 'rocketLauncher'
  | 'grenadeLauncher'
  | 'machineGun'
  | 'bow'
  | 'traceRifle';

export type FireMode = 'auto' | 'burst' | 'single' | 'charge' | 'beam';

export interface WeaponStats {
  id: string;
  displayName: string;
  family: WeaponFamily;
  slot: WeaponSlot;
  element: DamageElement;
  fireMode: FireMode;
  /** Rounds per minute for auto/single; per-burst cadence for burst. */
  rpm: number;
  burstCount: number;
  /** Delay between bursts, seconds. */
  burstDelay: number;
  /** Charge/draw time for charge + bow weapons, seconds. */
  chargeTime: number;
  magazine: number;
  reserves: number;
  reloadTime: number;
  /** Time from empty-mag reload, seconds (usually longer). */
  emptyReloadTime: number;
  damage: number;
  precisionMultiplier: number;
  /** Pellets fired per trigger pull (shotguns, fusion bolts). */
  pellets: number;
  /** Cone half-angle in radians at full bloom. */
  spread: number;
  /** Base cone half-angle when perfectly settled. */
  baseSpread: number;
  /** Spread added per shot. */
  spreadPerShot: number;
  /** Spread recovery per second. */
  spreadRecovery: number;
  /** Range at which damage begins to fall off, metres. */
  falloffStart: number;
  /** Range at which damage reaches its floor, metres. */
  falloffEnd: number;
  /** Damage multiplier at falloffEnd. */
  falloffFloor: number;
  /** Vertical kick, radians per shot. */
  recoilVertical: number;
  /** Horizontal kick magnitude, radians per shot. */
  recoilHorizontal: number;
  /** 0 = perfectly vertical recoil, 1 = fully random horizontal. */
  recoilRandomness: number;
  /** Recoil recentring speed, radians/sec. */
  recoilRecovery: number;
  /** Camera punch on fire, radians. */
  cameraKick: number;
  /** Weapon-model kickback, metres. */
  modelKick: number;
  /** Aim-down-sights transition, seconds. */
  adsTime: number;
  /** FOV multiplier while aiming. */
  adsZoom: number;
  /** Movement speed multiplier while aiming. */
  adsMoveScale: number;
  /** True for hitscan; false spawns a projectile. */
  hitscan: boolean;
  projectileSpeed: number;
  projectileGravity: number;
  /** Explosion radius, metres. 0 = no splash. */
  splashRadius: number;
  splashDamage: number;
  /** Aim assist cone half-angle, radians. */
  aimAssist: number;
  /** Muzzle flash intensity scalar. */
  muzzleIntensity: number;
  /** Tracer visual width. */
  tracerWidth: number;
  tracerColor: number;
  /** Screen-shake scalar per shot. */
  shake: number;
  /** Ammo consumed per trigger pull. */
  ammoPerShot: number;
  perks: string[];
  rarity: ItemRarity;
  /** Impulse applied to hit ragdolls. */
  impulse: number;
}

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'legendary' | 'exotic';

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

export type AbilitySlot = 'grenade' | 'melee' | 'class' | 'super';

export interface AbilityDefinition {
  id: string;
  slot: AbilitySlot;
  displayName: string;
  element: DamageElement;
  cooldown: number;
  /** Charges available; >1 means the ability stacks. */
  charges: number;
  /** Super energy cost, 0..1 of the bar. */
  cost: number;
  description: string;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface AudioEmitOptions {
  position?: THREE.Vector3;
  volume?: number;
  /** Playback-rate multiplier; also used for pitch variance. */
  pitch?: number;
  /** Random pitch jitter, +/- fraction. */
  pitchJitter?: number;
  /** Max audible distance, metres. */
  maxDistance?: number;
  loop?: boolean;
}

export interface AudioHandle {
  stop(fade?: number): void;
  setVolume(v: number, fade?: number): void;
  readonly playing: boolean;
}

// ---------------------------------------------------------------------------
// Levels / planets
// ---------------------------------------------------------------------------

export type PlanetId = 'aurvangr' | 'zeta-reticuli' | 'khepri' | 'hive-prime' | 'draco-ix';

export interface PlanetDescriptor {
  id: PlanetId;
  displayName: string;
  /** Short flavour line shown in the star map. */
  subtitle: string;
  faction: FactionId;
  /** Recommended power level. */
  recommendedPower: number;
  /** Orbital radius in the star map, arbitrary units. */
  orbitRadius: number;
  orbitSpeed: number;
  /** Planet render radius in the star map. */
  radius: number;
  /** Base surface colour used for the star-map globe. */
  color: number;
  atmosphereColor: number;
  description: string;
}

/** A playable level. The Engine owns exactly one active Level at a time. */
export interface Level extends Disposable {
  readonly id: string;
  readonly scene: THREE.Scene;
  readonly collision: CollisionWorld;
  /** Called once after construction; may await async generation. */
  load(onProgress?: (t: number, label: string) => void): Promise<void>;
  /** Per-simulation-step update. */
  update(ctx: FrameContext): void;
  /** Where the player spawns. */
  getSpawnPoint(): { position: THREE.Vector3; yaw: number };
  /** Environment lighting rig, so post-processing can query sun direction. */
  readonly sunDirection: THREE.Vector3;
  readonly sunColor: THREE.Color;
  readonly fogColor: THREE.Color;
}

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

export interface LootDrop {
  kind: 'ammo' | 'heavyAmmo' | 'orb' | 'engram' | 'health';
  rarity?: ItemRarity;
  position: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export type Listener<T> = (payload: T) => void;
