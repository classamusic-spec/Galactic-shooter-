/**
 * WeaponDefs — the weapon catalogue and the host contracts the weapon system
 * codes against.
 *
 * The record key is the weapon id. The first fourteen entries are one per
 * `WeaponFamily` and are keyed by the family name, so `WEAPONS[family]` still
 * resolves; everything added since is an *archetype* — a weapon that plays
 * differently while borrowing an existing family's gunshot and recoil
 * signature, because `WeaponFamily` lives in `@/types` and is owned elsewhere.
 * Archetype ids are therefore `<family><Variant>` (`sidearmRicochet`), which is
 * exactly the shape `Audio.familyOf()` needs to find the right sample.
 *
 * Tuning notes, because the numbers here ARE the game feel:
 *  - `rpm` is the intra-burst cadence. For `burst` weapons the pause between
 *    bursts is `burstDelay`, so the effective sustained rate is
 *    `burstCount / (burstCount * 60/rpm - 60/rpm + burstDelay)`.
 *  - All angles are radians. `baseSpread` is the settled cone half-angle,
 *    `spread` is the hard ceiling bloom may reach.
 *  - Damage is per pellet/bolt. A shotgun's on-paper damage is
 *    `damage * pellets`.
 *  - Falloff is evaluated with `rangeFalloff()` from `@/util/math`, so
 *    `falloffFloor` is the multiplier at and beyond `falloffEnd`.
 */
import type * as THREE from 'three';
import type {
  CollisionWorld,
  DamageElement,
  DamageInfo,
  Damageable,
  ItemRarity,
  RaycastHit,
  SurfaceKind,
  WeaponFamily,
  WeaponSlot,
  WeaponStats,
} from '@/types';
import type { Rng } from '@/util/math';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';

// ---------------------------------------------------------------------------
// Host contracts
//
// Player and VfxSystem are owned by other authors and built in parallel. The
// weapon system talks to them through these structural interfaces so a partial
// implementation degrades instead of crashing, and so the compiler tells us
// immediately if a signature drifts.
// ---------------------------------------------------------------------------

/** Everything the weapon system needs from the Player. */
export interface PlayerHost {
  /** World-space eye/muzzle origin for every aim ray. */
  readonly eyePosition: THREE.Vector3;
  /** Normalised world-space look direction. */
  readonly aimDirection: THREE.Vector3;
  /** 0..1 aim-down-sights blend. The weapon system writes this every frame. */
  aimProgress: number;
  /** ADS FOV multiplier for the active weapon; the camera owns the projection. */
  aimZoom?: number;
  /** Set while the trigger is down so the Player can block sprint. */
  firing?: boolean;
  /**
   * Recoil impulse. The Player's `ViewKick` splits this into a camera punch
   * that fully recovers and a smaller true-aim climb that only partly does —
   * layers 1 and 2 in one call. `recovery` overrides the auto-recentre rate.
   * When the bound Player only accepts two arguments the weapon system falls
   * back to driving its own aim offset instead.
   */
  addViewKick(pitch: number, yaw: number, roll?: number, recovery?: number): void;
  /** Positional screen shake impulse. */
  addShake(amount: number, duration?: number, frequency?: number): void;
  /** Optional: explicit aim-only displacement, if a Player prefers to split it. */
  addRecoil?(pitch: number, yaw: number): void;
  /** Optional: lets rockets hurt their owner. */
  applyDamage?(info: DamageInfo): number;
  readonly velocity?: THREE.Vector3;
  /** Horizontal speed, m/s. Preferred over deriving it from `velocity`. */
  readonly speed?: number;
  readonly grounded?: boolean;
  readonly sprinting?: boolean;
  readonly crouching?: boolean;
  readonly sliding?: boolean;
  readonly entityId?: number;
}

/** Everything the weapon system needs from the VFX system. */
export interface VfxHost {
  muzzle?(
    position: THREE.Vector3,
    direction: THREE.Vector3,
    scale: number,
    color: number,
  ): void;
  tracer?(
    from: THREE.Vector3,
    to: THREE.Vector3,
    width: number,
    color: number,
    speed?: number,
  ): void;
  impact?(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    surface: SurfaceKind,
    scale: number,
  ): void;
  bloodOrIchor?(point: THREE.Vector3, normal: THREE.Vector3, scale: number): void;
  decal?(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    surface: SurfaceKind,
    size: number,
  ): void;
  explosion?(point: THREE.Vector3, radius: number, element: DamageElement): void;
  /** Optional continuous beam used by the trace rifle. */
  beam?(from: THREE.Vector3, to: THREE.Vector3, width: number, color: number): void;
  /** Optional projectile trail puff. */
  trail?(point: THREE.Vector3, color: number, scale: number): void;
  /** The shared material library, forwarded from VfxSystem's constructor. */
  readonly materials?: MaterialLibrary;
  /** Scene the VFX system is currently attached to. */
  readonly scene?: THREE.Scene | null;
}

/**
 * The collision surface weapons use. `raycastAll` and `sphereSweep` are on
 * `BvhCollisionWorld` but not on the narrower `CollisionWorld` interface, so
 * they are declared optional and feature-detected.
 */
export interface WeaponCollision extends CollisionWorld {
  raycastAll?(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    ignoreEntityId?: number,
    out?: RaycastHit,
  ): RaycastHit | null;
  sphereSweep?(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    radius: number,
    maxDistance: number,
    ignoreEntityId?: number,
    out?: RaycastHit,
  ): RaycastHit | null;
}

/** Optional hook so an enemy manager can hand splash a precise target list. */
export type TargetProvider = (
  centre: THREE.Vector3,
  radius: number,
  out: Damageable[],
) => Damageable[];

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** Tracer/flash colour per damage element, in sRGB hex. */
export const ELEMENT_COLOR: Record<DamageElement, number> = {
  kinetic: 0xffd8a2,
  solar: 0xff8a2c,
  arc: 0x7fdcff,
  void: 0xb887ff,
  stasis: 0x8ec6ff,
};

/** Sensible values for every field; each weapon overrides what matters. */
const BASE: WeaponStats = {
  id: 'base',
  displayName: 'Base',
  family: 'autoRifle',
  slot: 'kinetic',
  element: 'kinetic',
  fireMode: 'auto',
  rpm: 600,
  burstCount: 1,
  burstDelay: 0,
  chargeTime: 0,
  magazine: 30,
  reserves: 200,
  reloadTime: 2.1,
  emptyReloadTime: 2.6,
  damage: 15,
  precisionMultiplier: 1.5,
  pellets: 1,
  spread: 0.03,
  baseSpread: 0.0045,
  spreadPerShot: 0.0038,
  spreadRecovery: 0.055,
  falloffStart: 26,
  falloffEnd: 40,
  falloffFloor: 0.6,
  recoilVertical: 0.0105,
  recoilHorizontal: 0.0035,
  recoilRandomness: 0.35,
  recoilRecovery: 2.6,
  cameraKick: 0.01,
  modelKick: 0.028,
  adsTime: 0.22,
  adsZoom: 1.15,
  adsMoveScale: 0.62,
  hitscan: true,
  projectileSpeed: 0,
  projectileGravity: 0,
  splashRadius: 0,
  splashDamage: 0,
  aimAssist: 0.038,
  muzzleIntensity: 1,
  tracerWidth: 0.035,
  tracerColor: ELEMENT_COLOR.kinetic,
  shake: 0.1,
  ammoPerShot: 1,
  perks: [],
  rarity: 'legendary',
  impulse: 40,
};

function mk(over: Partial<WeaponStats> & Pick<WeaponStats, 'id' | 'displayName' | 'family' | 'slot' | 'element'>): WeaponStats {
  const s: WeaponStats = { ...BASE, ...over, perks: [...(over.perks ?? [])] };
  // Tracer colour defaults to the element identity unless authored explicitly.
  if (over.tracerColor == null) s.tracerColor = ELEMENT_COLOR[s.element];
  return s;
}

/** Deep-ish copy. Only `perks` needs cloning; everything else is a scalar. */
export function cloneStats(s: WeaponStats): WeaponStats {
  return { ...s, perks: [...s.perks] };
}

export const WEAPONS: Record<string, WeaponStats> = {
  // -- kinetic slot ---------------------------------------------------------

  /** The reliable one. Forgiving bloom, gentle climb, good everywhere. */
  autoRifle: mk({
    id: 'autoRifle',
    displayName: 'Sentinel AR-7',
    family: 'autoRifle',
    slot: 'kinetic',
    element: 'kinetic',
    fireMode: 'auto',
    rpm: 600,
    magazine: 36,
    reserves: 246,
    reloadTime: 2.1,
    emptyReloadTime: 2.6,
    damage: 14.5,
    precisionMultiplier: 1.5,
    spread: 0.03,
    baseSpread: 0.0045,
    spreadPerShot: 0.0038,
    spreadRecovery: 0.055,
    falloffStart: 26,
    falloffEnd: 40,
    falloffFloor: 0.6,
    recoilVertical: 0.0105,
    recoilHorizontal: 0.0035,
    recoilRandomness: 0.35,
    recoilRecovery: 2.6,
    cameraKick: 0.01,
    modelKick: 0.028,
    adsTime: 0.22,
    adsZoom: 1.15,
    adsMoveScale: 0.62,
    aimAssist: 0.038,
    muzzleIntensity: 1,
    tracerWidth: 0.035,
    shake: 0.1,
    impulse: 40,
    perks: ['zenMoment', 'rampage'],
    rarity: 'legendary',
  }),

  /** Long-range precision. High per-shot damage, slow, rewards headshots. */
  scoutRifle: mk({
    id: 'scoutRifle',
    displayName: 'Long Watch MK4',
    family: 'scoutRifle',
    slot: 'kinetic',
    element: 'kinetic',
    fireMode: 'single',
    rpm: 180,
    magazine: 17,
    reserves: 150,
    reloadTime: 2,
    emptyReloadTime: 2.5,
    damage: 33,
    precisionMultiplier: 1.65,
    spread: 0.016,
    baseSpread: 0.0022,
    spreadPerShot: 0.003,
    spreadRecovery: 0.075,
    falloffStart: 48,
    falloffEnd: 72,
    falloffFloor: 0.72,
    recoilVertical: 0.0165,
    recoilHorizontal: 0.0035,
    recoilRandomness: 0.28,
    recoilRecovery: 3.1,
    cameraKick: 0.013,
    modelKick: 0.034,
    adsTime: 0.26,
    adsZoom: 1.45,
    adsMoveScale: 0.6,
    aimAssist: 0.028,
    muzzleIntensity: 1.2,
    tracerWidth: 0.04,
    shake: 0.16,
    impulse: 70,
    perks: ['rangefinder', 'explosivePayload'],
    rarity: 'legendary',
  }),

  /** Huge punch, heavy recoil, tiny mag. Exotic — gold trim on the model. */
  handCannon: mk({
    id: 'handCannon',
    displayName: 'Ironclad .50',
    family: 'handCannon',
    slot: 'kinetic',
    element: 'kinetic',
    fireMode: 'single',
    rpm: 140,
    magazine: 9,
    reserves: 90,
    reloadTime: 1.9,
    emptyReloadTime: 2.4,
    damage: 62,
    precisionMultiplier: 1.9,
    spread: 0.022,
    baseSpread: 0.003,
    spreadPerShot: 0.0075,
    spreadRecovery: 0.09,
    falloffStart: 30,
    falloffEnd: 46,
    falloffFloor: 0.55,
    recoilVertical: 0.042,
    recoilHorizontal: 0.013,
    recoilRandomness: 0.45,
    recoilRecovery: 3.4,
    cameraKick: 0.03,
    modelKick: 0.055,
    adsTime: 0.26,
    adsZoom: 1.35,
    adsMoveScale: 0.68,
    aimAssist: 0.042,
    muzzleIntensity: 1.7,
    tracerWidth: 0.05,
    shake: 0.34,
    impulse: 150,
    perks: ['outlaw', 'openingShot', 'vorpalWeapon'],
    rarity: 'exotic',
  }),

  /** Brutal inside 15 m, near-useless past 20. Fastest cadence in the game. */
  submachineGun: mk({
    id: 'submachineGun',
    displayName: 'Riptide SMG',
    family: 'submachineGun',
    slot: 'kinetic',
    element: 'kinetic',
    fireMode: 'auto',
    rpm: 900,
    magazine: 40,
    reserves: 300,
    reloadTime: 2,
    emptyReloadTime: 2.5,
    damage: 10.5,
    precisionMultiplier: 1.35,
    spread: 0.048,
    baseSpread: 0.0075,
    spreadPerShot: 0.0042,
    spreadRecovery: 0.09,
    falloffStart: 9,
    falloffEnd: 20,
    falloffFloor: 0.35,
    recoilVertical: 0.008,
    recoilHorizontal: 0.004,
    recoilRandomness: 0.55,
    recoilRecovery: 3,
    cameraKick: 0.008,
    modelKick: 0.022,
    adsTime: 0.17,
    adsZoom: 1.05,
    adsMoveScale: 0.75,
    aimAssist: 0.05,
    muzzleIntensity: 0.8,
    tracerWidth: 0.028,
    shake: 0.06,
    impulse: 26,
    perks: ['adrenalineJunkie', 'underPressure'],
    rarity: 'legendary',
  }),

  /** Draw-to-full with a perfect-draw window, arrow drop, silent. Exotic. */
  bow: mk({
    id: 'bow',
    displayName: 'Silent Verdict',
    family: 'bow',
    slot: 'kinetic',
    element: 'kinetic',
    fireMode: 'charge',
    rpm: 90,
    chargeTime: 0.62,
    magazine: 1,
    reserves: 42,
    reloadTime: 0.9,
    emptyReloadTime: 0.9,
    damage: 120,
    precisionMultiplier: 1.75,
    spread: 0.02,
    baseSpread: 0.0008,
    spreadPerShot: 0.006,
    spreadRecovery: 0.08,
    falloffStart: 55,
    falloffEnd: 80,
    falloffFloor: 0.8,
    recoilVertical: 0.03,
    recoilHorizontal: 0.006,
    recoilRandomness: 0.25,
    recoilRecovery: 2.6,
    cameraKick: 0.02,
    modelKick: 0.048,
    adsTime: 0.3,
    adsZoom: 1.4,
    adsMoveScale: 0.55,
    hitscan: false,
    projectileSpeed: 110,
    projectileGravity: 8.5,
    aimAssist: 0.026,
    muzzleIntensity: 0.15,
    tracerWidth: 0.02,
    shake: 0.22,
    impulse: 180,
    perks: ['archersTempo', 'vorpalWeapon'],
    rarity: 'exotic',
  }),

  // -- energy slot ----------------------------------------------------------

  /** Three-round bursts 0.32 s apart. Rewards holding the burst on target. */
  pulseRifle: mk({
    id: 'pulseRifle',
    displayName: 'Triad Cadence',
    family: 'pulseRifle',
    slot: 'energy',
    element: 'arc',
    fireMode: 'burst',
    rpm: 450,
    burstCount: 3,
    burstDelay: 0.32,
    magazine: 33,
    reserves: 210,
    reloadTime: 2.3,
    emptyReloadTime: 2.8,
    damage: 17,
    precisionMultiplier: 1.55,
    spread: 0.024,
    baseSpread: 0.0035,
    spreadPerShot: 0.0034,
    spreadRecovery: 0.06,
    falloffStart: 30,
    falloffEnd: 46,
    falloffFloor: 0.62,
    recoilVertical: 0.0125,
    recoilHorizontal: 0.0032,
    recoilRandomness: 0.3,
    recoilRecovery: 2.9,
    cameraKick: 0.011,
    modelKick: 0.03,
    adsTime: 0.24,
    adsZoom: 1.25,
    adsMoveScale: 0.62,
    aimAssist: 0.036,
    muzzleIntensity: 1.05,
    tracerWidth: 0.032,
    shake: 0.11,
    impulse: 45,
    perks: ['killClip', 'underPressure'],
    rarity: 'legendary',
  }),

  /** Tiny mag, fast handling, solid close-mid. The panic button. */
  sidearm: mk({
    id: 'sidearm',
    displayName: 'Wasp SD-3',
    family: 'sidearm',
    slot: 'energy',
    element: 'solar',
    fireMode: 'auto',
    rpm: 325,
    magazine: 12,
    reserves: 180,
    reloadTime: 1.6,
    emptyReloadTime: 2,
    damage: 19,
    precisionMultiplier: 1.4,
    spread: 0.03,
    baseSpread: 0.005,
    spreadPerShot: 0.004,
    spreadRecovery: 0.09,
    falloffStart: 15,
    falloffEnd: 27,
    falloffFloor: 0.5,
    recoilVertical: 0.014,
    recoilHorizontal: 0.0045,
    recoilRandomness: 0.4,
    recoilRecovery: 3.2,
    cameraKick: 0.012,
    modelKick: 0.026,
    adsTime: 0.18,
    adsZoom: 1.1,
    adsMoveScale: 0.78,
    aimAssist: 0.045,
    muzzleIntensity: 0.9,
    tracerWidth: 0.03,
    shake: 0.09,
    impulse: 32,
    perks: ['adrenalineJunkie', 'outlaw'],
    rarity: 'rare',
  }),

  /** Ten pellets, wide cone, 65 rpm. Deletes anything inside 6 m. */
  shotgun: mk({
    id: 'shotgun',
    displayName: 'Breachlight 12',
    family: 'shotgun',
    slot: 'energy',
    element: 'void',
    fireMode: 'single',
    rpm: 65,
    magazine: 6,
    reserves: 42,
    reloadTime: 2.6,
    emptyReloadTime: 3.2,
    damage: 22,
    precisionMultiplier: 1.2,
    pellets: 10,
    spread: 0.095,
    baseSpread: 0.075,
    spreadPerShot: 0.012,
    spreadRecovery: 0.1,
    falloffStart: 5,
    falloffEnd: 11,
    falloffFloor: 0.22,
    recoilVertical: 0.048,
    recoilHorizontal: 0.014,
    recoilRandomness: 0.4,
    recoilRecovery: 3,
    cameraKick: 0.034,
    modelKick: 0.07,
    adsTime: 0.24,
    adsZoom: 1.1,
    adsMoveScale: 0.7,
    aimAssist: 0.075,
    muzzleIntensity: 2.2,
    tracerWidth: 0.02,
    shake: 0.42,
    impulse: 60,
    perks: ['openingShot', 'rampage'],
    rarity: 'legendary',
  }),

  /** 0.7 s charge, then seven bolts that travel. Reads the room in one shot. */
  fusionRifle: mk({
    id: 'fusionRifle',
    displayName: 'Solstice Coil',
    family: 'fusionRifle',
    slot: 'energy',
    element: 'arc',
    fireMode: 'charge',
    rpm: 60,
    chargeTime: 0.7,
    magazine: 7,
    reserves: 21,
    reloadTime: 2.4,
    emptyReloadTime: 3,
    damage: 26,
    precisionMultiplier: 1.3,
    pellets: 7,
    spread: 0.024,
    baseSpread: 0.01,
    spreadPerShot: 0.006,
    spreadRecovery: 0.08,
    falloffStart: 22,
    falloffEnd: 34,
    falloffFloor: 0.55,
    recoilVertical: 0.03,
    recoilHorizontal: 0.008,
    recoilRandomness: 0.35,
    recoilRecovery: 2.6,
    cameraKick: 0.024,
    modelKick: 0.052,
    adsTime: 0.34,
    adsZoom: 1.3,
    adsMoveScale: 0.58,
    hitscan: false,
    projectileSpeed: 150,
    projectileGravity: 0,
    aimAssist: 0.055,
    muzzleIntensity: 1.9,
    tracerWidth: 0.05,
    shake: 0.3,
    impulse: 55,
    perks: ['chargeTime', 'killClip'],
    rarity: 'legendary',
  }),

  /** Continuous beam. Damage ticks 20×/s and drains a round each tick. */
  traceRifle: mk({
    id: 'traceRifle',
    displayName: 'Continuum Ray',
    family: 'traceRifle',
    slot: 'energy',
    element: 'solar',
    fireMode: 'beam',
    rpm: 1200,
    magazine: 100,
    reserves: 400,
    reloadTime: 3,
    emptyReloadTime: 3.6,
    damage: 5.2,
    precisionMultiplier: 1.35,
    spread: 0.004,
    baseSpread: 0.0008,
    spreadPerShot: 0.0002,
    spreadRecovery: 0.02,
    falloffStart: 34,
    falloffEnd: 52,
    falloffFloor: 0.6,
    recoilVertical: 0.0004,
    recoilHorizontal: 0.0002,
    recoilRandomness: 0.5,
    recoilRecovery: 6.5,
    cameraKick: 0.0016,
    modelKick: 0.004,
    adsTime: 0.24,
    adsZoom: 1.3,
    adsMoveScale: 0.62,
    aimAssist: 0.04,
    muzzleIntensity: 0.5,
    tracerWidth: 0.09,
    shake: 0.03,
    impulse: 8,
    perks: ['zenMoment', 'rampage', 'vorpalWeapon'],
    rarity: 'exotic',
  }),

  // -- power slot -----------------------------------------------------------

  /** Tiny spread, 2.5× precision, long ADS. Punishes anything that stands still. */
  sniperRifle: mk({
    id: 'sniperRifle',
    displayName: 'Meridian Longshot',
    family: 'sniperRifle',
    slot: 'power',
    element: 'stasis',
    fireMode: 'single',
    rpm: 90,
    magazine: 5,
    reserves: 18,
    reloadTime: 2.9,
    emptyReloadTime: 3.6,
    damage: 190,
    precisionMultiplier: 2.5,
    spread: 0.0045,
    baseSpread: 0.0004,
    spreadPerShot: 0.003,
    spreadRecovery: 0.05,
    falloffStart: 110,
    falloffEnd: 160,
    falloffFloor: 0.92,
    recoilVertical: 0.062,
    recoilHorizontal: 0.011,
    recoilRandomness: 0.25,
    recoilRecovery: 2.2,
    cameraKick: 0.03,
    modelKick: 0.06,
    adsTime: 0.42,
    adsZoom: 2.5,
    adsMoveScale: 0.42,
    aimAssist: 0.014,
    muzzleIntensity: 2.4,
    tracerWidth: 0.06,
    shake: 0.36,
    impulse: 260,
    perks: ['tripleTap', 'fourthTimesTheCharm', 'rangefinder'],
    rarity: 'legendary',
  }),

  /** Slow projectile, six-metre splash, and yes it will kill you too. */
  rocketLauncher: mk({
    id: 'rocketLauncher',
    displayName: 'Havoc RL-9',
    family: 'rocketLauncher',
    slot: 'power',
    element: 'solar',
    fireMode: 'single',
    rpm: 20,
    magazine: 1,
    reserves: 6,
    reloadTime: 3.1,
    emptyReloadTime: 3.6,
    damage: 90,
    precisionMultiplier: 1,
    spread: 0.01,
    baseSpread: 0.004,
    spreadPerShot: 0.006,
    spreadRecovery: 0.06,
    falloffStart: 60,
    falloffEnd: 90,
    falloffFloor: 0.85,
    recoilVertical: 0.07,
    recoilHorizontal: 0.016,
    recoilRandomness: 0.3,
    recoilRecovery: 2,
    cameraKick: 0.04,
    modelKick: 0.09,
    adsTime: 0.4,
    adsZoom: 1.15,
    adsMoveScale: 0.5,
    hitscan: false,
    projectileSpeed: 42,
    projectileGravity: 0,
    splashRadius: 6,
    splashDamage: 160,
    aimAssist: 0.03,
    muzzleIntensity: 2.6,
    tracerWidth: 0.05,
    shake: 0.55,
    impulse: 400,
    perks: ['autoLoadingHolster', 'vorpalWeapon'],
    rarity: 'legendary',
  }),

  /** Arcs, bounces, cooks a fuse. Bank it round a corner. */
  grenadeLauncher: mk({
    id: 'grenadeLauncher',
    displayName: 'Bellringer GL',
    family: 'grenadeLauncher',
    slot: 'power',
    element: 'arc',
    fireMode: 'single',
    rpm: 90,
    magazine: 6,
    reserves: 24,
    reloadTime: 2.6,
    emptyReloadTime: 3.1,
    damage: 55,
    precisionMultiplier: 1,
    spread: 0.016,
    baseSpread: 0.006,
    spreadPerShot: 0.006,
    spreadRecovery: 0.07,
    falloffStart: 40,
    falloffEnd: 60,
    falloffFloor: 0.8,
    recoilVertical: 0.052,
    recoilHorizontal: 0.012,
    recoilRandomness: 0.3,
    recoilRecovery: 2.4,
    cameraKick: 0.03,
    modelKick: 0.065,
    adsTime: 0.3,
    adsZoom: 1.15,
    adsMoveScale: 0.6,
    hitscan: false,
    projectileSpeed: 38,
    projectileGravity: 22,
    splashRadius: 4.2,
    splashDamage: 90,
    aimAssist: 0.03,
    muzzleIntensity: 1.8,
    tracerWidth: 0.04,
    shake: 0.3,
    impulse: 220,
    perks: ['autoLoadingHolster', 'rampage'],
    rarity: 'legendary',
  }),

  /** Hundred-round belt at 450 rpm. Sustained-fire answer to a whole squad. */
  machineGun: mk({
    id: 'machineGun',
    displayName: 'Hammerfall LMG',
    family: 'machineGun',
    slot: 'power',
    element: 'void',
    fireMode: 'auto',
    rpm: 450,
    magazine: 100,
    reserves: 300,
    reloadTime: 4.2,
    emptyReloadTime: 5,
    damage: 21,
    precisionMultiplier: 1.4,
    spread: 0.038,
    baseSpread: 0.006,
    spreadPerShot: 0.0036,
    spreadRecovery: 0.05,
    falloffStart: 32,
    falloffEnd: 48,
    falloffFloor: 0.62,
    recoilVertical: 0.013,
    recoilHorizontal: 0.0048,
    recoilRandomness: 0.45,
    recoilRecovery: 2.4,
    cameraKick: 0.014,
    modelKick: 0.032,
    adsTime: 0.28,
    adsZoom: 1.15,
    adsMoveScale: 0.4,
    aimAssist: 0.04,
    muzzleIntensity: 1.4,
    tracerWidth: 0.045,
    shake: 0.16,
    impulse: 70,
    perks: ['rampage', 'underPressure', 'dragonfly'],
    rarity: 'legendary',
  }),

  // -- new archetypes -------------------------------------------------------
  //
  // Six weapons that answer "what does this let me do that nothing else does?"
  // rather than "what number is bigger?". They share the fourteen `WeaponFamily`
  // buckets with the originals — a family is the *sound and recoil signature*,
  // not the archetype — and every one of them has its own view model
  // (`ID_BUILDERS` in WeaponMeshes), its own recoil pattern (`ARCHETYPE_SEED` in
  // Recoil) and, where it travels, its own projectile behaviour
  // (`PROJECTILE_ARCHETYPES` in Projectiles).
  //
  // NAMING RULE, and it is load-bearing: `Audio.familyOf()` resolves a gunshot
  // by scanning the *weapon id* for a family name, case-sensitively. So every id
  // here starts with the family whose voice it borrows — `sidearmRicochet`, not
  // `ricochetSidearm`, which would leave it silent-by-fallback on an auto rifle
  // sample. Keep that shape when adding more.

  /**
   * Bolts that bank. Slow projectiles that reflect off hard surfaces three
   * times and gain charge with every bounce, so the play is banking a shot into
   * a corridor nobody is looking down. Nothing else in the catalogue hurts
   * something you cannot see.
   */
  sidearmRicochet: mk({
    id: 'sidearmRicochet',
    displayName: 'Caroms SD-4',
    family: 'sidearm',
    slot: 'energy',
    element: 'arc',
    fireMode: 'auto',
    rpm: 300,
    magazine: 18,
    reserves: 216,
    reloadTime: 1.7,
    emptyReloadTime: 2.1,
    damage: 17,
    precisionMultiplier: 1.35,
    spread: 0.034,
    baseSpread: 0.0055,
    spreadPerShot: 0.0042,
    spreadRecovery: 0.085,
    falloffStart: 18,
    falloffEnd: 30,
    falloffFloor: 0.55,
    recoilVertical: 0.0125,
    recoilHorizontal: 0.005,
    recoilRandomness: 0.42,
    recoilRecovery: 3.1,
    cameraKick: 0.011,
    modelKick: 0.026,
    adsTime: 0.19,
    adsZoom: 1.1,
    adsMoveScale: 0.76,
    hitscan: false,
    projectileSpeed: 95,
    projectileGravity: 0,
    aimAssist: 0.04,
    muzzleIntensity: 0.95,
    tracerWidth: 0.03,
    shake: 0.09,
    impulse: 34,
    perks: ['handoff', 'underPressure'],
    rarity: 'legendary',
  }),

  /**
   * Three-round bursts from a sidearm frame. On its own it is the weakest
   * energy primary in the catalogue; held on one target it is the strongest,
   * because Target Lock ramps while the chain holds and drops the instant you
   * look away. The build is "never switch targets".
   */
  sidearmBurst: mk({
    id: 'sidearmBurst',
    displayName: 'Fixation BS-2',
    family: 'sidearm',
    slot: 'energy',
    element: 'solar',
    fireMode: 'burst',
    rpm: 750,
    burstCount: 3,
    burstDelay: 0.26,
    magazine: 21,
    reserves: 189,
    reloadTime: 1.65,
    emptyReloadTime: 2.05,
    damage: 15,
    precisionMultiplier: 1.4,
    spread: 0.028,
    baseSpread: 0.0045,
    spreadPerShot: 0.0032,
    spreadRecovery: 0.085,
    falloffStart: 17,
    falloffEnd: 29,
    falloffFloor: 0.5,
    recoilVertical: 0.011,
    recoilHorizontal: 0.0038,
    recoilRandomness: 0.32,
    recoilRecovery: 3.3,
    cameraKick: 0.0105,
    modelKick: 0.024,
    adsTime: 0.18,
    adsZoom: 1.12,
    adsMoveScale: 0.76,
    aimAssist: 0.046,
    muzzleIntensity: 0.85,
    tracerWidth: 0.028,
    shake: 0.08,
    impulse: 30,
    perks: ['targetLock', 'zenMoment'],
    rarity: 'legendary',
  }),

  /**
   * A beam that cooks rather than cuts. Lower per-tick damage than the trace
   * rifle, but every tick stacks heat on whatever it is touching and fifteen
   * stacks ignite it. Tagging one body and popping it into a crowd is the
   * play; sweeping the beam across three targets throws the stacks away.
   */
  traceRifleKindler: mk({
    id: 'traceRifleKindler',
    displayName: 'Emberline TR-2',
    family: 'traceRifle',
    slot: 'energy',
    element: 'solar',
    fireMode: 'beam',
    rpm: 1200,
    magazine: 90,
    reserves: 360,
    reloadTime: 2.9,
    emptyReloadTime: 3.5,
    damage: 4.2,
    precisionMultiplier: 1.3,
    spread: 0.005,
    baseSpread: 0.001,
    spreadPerShot: 0.00025,
    spreadRecovery: 0.02,
    falloffStart: 30,
    falloffEnd: 46,
    falloffFloor: 0.6,
    recoilVertical: 0.0005,
    recoilHorizontal: 0.00025,
    recoilRandomness: 0.5,
    recoilRecovery: 6.5,
    cameraKick: 0.0018,
    modelKick: 0.0045,
    adsTime: 0.24,
    adsZoom: 1.28,
    adsMoveScale: 0.62,
    aimAssist: 0.04,
    muzzleIntensity: 0.6,
    tracerWidth: 0.085,
    shake: 0.035,
    impulse: 8,
    perks: ['kindling', 'rangefinder'],
    rarity: 'legendary',
  }),

  /**
   * No magazine — a battery. Every shot spends six cells out of seventy-two, so
   * the resource the player manages is *shots taken*, not rounds loaded, and a
   * missed shot costs six times what a missed auto-rifle round does. Recycler
   * hands a whole shot back for every second precision hit, which turns "aim
   * properly" into ammo economy instead of a damage bonus.
   */
  scoutRifleCell: mk({
    id: 'scoutRifleCell',
    displayName: 'Dry Cell SR-9',
    family: 'scoutRifle',
    slot: 'kinetic',
    element: 'kinetic',
    fireMode: 'single',
    rpm: 150,
    magazine: 72,
    ammoPerShot: 6,
    reserves: 432,
    reloadTime: 2.4,
    emptyReloadTime: 2.9,
    damage: 44,
    precisionMultiplier: 1.7,
    spread: 0.014,
    baseSpread: 0.002,
    spreadPerShot: 0.0032,
    spreadRecovery: 0.07,
    falloffStart: 44,
    falloffEnd: 66,
    falloffFloor: 0.7,
    recoilVertical: 0.019,
    recoilHorizontal: 0.004,
    recoilRandomness: 0.26,
    recoilRecovery: 3,
    cameraKick: 0.015,
    modelKick: 0.038,
    adsTime: 0.25,
    adsZoom: 1.4,
    adsMoveScale: 0.6,
    aimAssist: 0.03,
    muzzleIntensity: 1.3,
    tracerWidth: 0.042,
    shake: 0.18,
    impulse: 85,
    perks: ['cellRecycler', 'rangefinder'],
    rarity: 'legendary',
  }),

  /**
   * Four seekers per trigger pull, fanned wide and steering hard. Each one
   * acquires its own target, so this is the only weapon in the game that can
   * answer four spread-out enemies with one press. Against a single body it is
   * deliberately worse than the rocket launcher.
   */
  rocketLauncherSwarm: mk({
    id: 'rocketLauncherSwarm',
    displayName: 'Hornet Pod RL-4',
    family: 'rocketLauncher',
    slot: 'power',
    element: 'void',
    fireMode: 'single',
    rpm: 60,
    magazine: 2,
    reserves: 8,
    reloadTime: 3,
    emptyReloadTime: 3.4,
    damage: 22,
    precisionMultiplier: 1,
    pellets: 4,
    spread: 0.12,
    baseSpread: 0.075,
    spreadPerShot: 0.02,
    spreadRecovery: 0.12,
    falloffStart: 50,
    falloffEnd: 80,
    falloffFloor: 0.8,
    recoilVertical: 0.05,
    recoilHorizontal: 0.012,
    recoilRandomness: 0.34,
    recoilRecovery: 2.2,
    cameraKick: 0.03,
    modelKick: 0.075,
    adsTime: 0.34,
    adsZoom: 1.1,
    adsMoveScale: 0.52,
    hitscan: false,
    projectileSpeed: 36,
    projectileGravity: 0,
    splashRadius: 2.4,
    splashDamage: 30,
    aimAssist: 0.05,
    muzzleIntensity: 2,
    tracerWidth: 0.04,
    shake: 0.4,
    impulse: 120,
    perks: ['vorpalWeapon', 'feedingFrenzy'],
    rarity: 'legendary',
  }),

  /**
   * The only weapon that pays you for *holding*. It runs on the bow's
   * draw-and-loose contract: let go early and the spike leaves weak, hold into
   * the window just past full draw and it lands at 1.2x. A heavy siege bolt
   * with a small blast, on a two-shot rail.
   */
  bowSiege: mk({
    id: 'bowSiege',
    displayName: 'Piledriver XB-1',
    family: 'bow',
    slot: 'power',
    element: 'void',
    fireMode: 'charge',
    rpm: 60,
    chargeTime: 0.95,
    magazine: 2,
    reserves: 12,
    reloadTime: 2.3,
    emptyReloadTime: 2.7,
    damage: 175,
    precisionMultiplier: 1.5,
    spread: 0.014,
    baseSpread: 0.001,
    spreadPerShot: 0.006,
    spreadRecovery: 0.07,
    falloffStart: 60,
    falloffEnd: 90,
    falloffFloor: 0.85,
    recoilVertical: 0.052,
    recoilHorizontal: 0.009,
    recoilRandomness: 0.22,
    recoilRecovery: 2.3,
    cameraKick: 0.032,
    modelKick: 0.075,
    adsTime: 0.34,
    adsZoom: 1.5,
    adsMoveScale: 0.5,
    hitscan: false,
    projectileSpeed: 130,
    projectileGravity: 5.5,
    splashRadius: 3.6,
    splashDamage: 90,
    aimAssist: 0.024,
    muzzleIntensity: 0.6,
    tracerWidth: 0.03,
    shake: 0.34,
    impulse: 320,
    perks: ['archersTempo', 'feedingFrenzy'],
    rarity: 'legendary',
  }),

  // -- exotics --------------------------------------------------------------
  //
  // One per faction, and each one is that faction's single idea expressed as a
  // rule the player has to play around. They carry `rarity: 'exotic'`, which is
  // what gilds the view model and what `pickLootWeapon()` gates on, and their
  // signature perks are deliberately absent from `PERK_IDS` so no random roll
  // can ever hand them out.

  /**
   * Jötunn Clans — mercenaries who took a contract they did not read. A
   * weregild is the price paid for a life taken, and this pays it in ammunition:
   * kill inside contract range and the shells are simply there again.
   */
  shotgunWeregild: mk({
    id: 'shotgunWeregild',
    displayName: 'Weregild',
    family: 'shotgun',
    slot: 'energy',
    element: 'stasis',
    fireMode: 'single',
    rpm: 75,
    magazine: 5,
    reserves: 40,
    reloadTime: 2.4,
    emptyReloadTime: 3,
    damage: 21,
    precisionMultiplier: 1.25,
    pellets: 9,
    spread: 0.1,
    baseSpread: 0.07,
    spreadPerShot: 0.012,
    spreadRecovery: 0.11,
    falloffStart: 6,
    falloffEnd: 12,
    falloffFloor: 0.24,
    recoilVertical: 0.046,
    recoilHorizontal: 0.013,
    recoilRandomness: 0.4,
    recoilRecovery: 3.1,
    cameraKick: 0.032,
    modelKick: 0.068,
    adsTime: 0.23,
    adsZoom: 1.1,
    adsMoveScale: 0.72,
    aimAssist: 0.075,
    muzzleIntensity: 2.2,
    tracerWidth: 0.02,
    shake: 0.4,
    impulse: 60,
    perks: ['bloodPrice', 'feedingFrenzy'],
    rarity: 'exotic',
  }),

  /**
   * The Custodians — archivists who catalogued the end of the world and filed
   * it. An erratum is a correction appended to a record that has already been
   * published: a precision kill un-spends the shot, because the archive now
   * says it was never fired.
   */
  scoutRifleErrata: mk({
    id: 'scoutRifleErrata',
    displayName: 'Errata',
    family: 'scoutRifle',
    slot: 'kinetic',
    element: 'void',
    fireMode: 'single',
    rpm: 140,
    magazine: 60,
    ammoPerShot: 5,
    reserves: 360,
    reloadTime: 2.5,
    emptyReloadTime: 3,
    damage: 46,
    precisionMultiplier: 1.85,
    spread: 0.013,
    baseSpread: 0.0018,
    spreadPerShot: 0.003,
    spreadRecovery: 0.075,
    falloffStart: 50,
    falloffEnd: 76,
    falloffFloor: 0.74,
    recoilVertical: 0.0185,
    recoilHorizontal: 0.0035,
    recoilRandomness: 0.22,
    recoilRecovery: 3.2,
    cameraKick: 0.014,
    modelKick: 0.036,
    adsTime: 0.26,
    adsZoom: 1.45,
    adsMoveScale: 0.58,
    aimAssist: 0.028,
    muzzleIntensity: 1.2,
    tracerWidth: 0.04,
    shake: 0.17,
    impulse: 80,
    perks: ['amendment', 'cellRecycler'],
    rarity: 'exotic',
  }),

  /**
   * Bladed Broods — predators being rewritten mid-hunt. An instar is the stage
   * between two moults, and the bolt moults too: on its last bounce it sheds
   * and comes apart into two smaller bolts. Cull finishes whatever the shrapnel
   * opened up.
   */
  sidearmInstar: mk({
    id: 'sidearmInstar',
    displayName: 'Third Instar',
    family: 'sidearm',
    slot: 'energy',
    element: 'arc',
    fireMode: 'auto',
    rpm: 280,
    magazine: 16,
    reserves: 200,
    reloadTime: 1.6,
    emptyReloadTime: 2,
    damage: 18,
    precisionMultiplier: 1.35,
    spread: 0.032,
    baseSpread: 0.005,
    spreadPerShot: 0.004,
    spreadRecovery: 0.085,
    falloffStart: 18,
    falloffEnd: 30,
    falloffFloor: 0.55,
    recoilVertical: 0.0125,
    recoilHorizontal: 0.0048,
    recoilRandomness: 0.4,
    recoilRecovery: 3.2,
    cameraKick: 0.011,
    modelKick: 0.026,
    adsTime: 0.18,
    adsZoom: 1.1,
    adsMoveScale: 0.78,
    hitscan: false,
    projectileSpeed: 92,
    projectileGravity: 0,
    aimAssist: 0.044,
    muzzleIntensity: 1,
    tracerWidth: 0.032,
    shake: 0.09,
    impulse: 34,
    perks: ['cull', 'adrenalineJunkie'],
    rarity: 'exotic',
  }),

  /**
   * The Unnumbered — not a faction, a result, and the only roster in the game
   * with no individual name anywhere in it. So this weapon does not get a name
   * either: it gets a count, and the count goes up. Every kill adds a seeker to
   * the next volley.
   */
  rocketLauncherTenThousand: mk({
    id: 'rocketLauncherTenThousand',
    displayName: 'Ten Thousand',
    family: 'rocketLauncher',
    slot: 'power',
    element: 'solar',
    fireMode: 'single',
    rpm: 55,
    magazine: 2,
    reserves: 8,
    reloadTime: 3.2,
    emptyReloadTime: 3.6,
    damage: 22,
    precisionMultiplier: 1,
    pellets: 3,
    spread: 0.13,
    baseSpread: 0.085,
    spreadPerShot: 0.02,
    spreadRecovery: 0.12,
    falloffStart: 50,
    falloffEnd: 80,
    falloffFloor: 0.8,
    recoilVertical: 0.048,
    recoilHorizontal: 0.011,
    recoilRandomness: 0.34,
    recoilRecovery: 2.2,
    cameraKick: 0.029,
    modelKick: 0.072,
    adsTime: 0.34,
    adsZoom: 1.1,
    adsMoveScale: 0.52,
    hitscan: false,
    projectileSpeed: 34,
    projectileGravity: 0,
    splashRadius: 2.2,
    splashDamage: 30,
    aimAssist: 0.05,
    muzzleIntensity: 2,
    tracerWidth: 0.04,
    shake: 0.38,
    impulse: 110,
    perks: ['increase', 'vorpalWeapon'],
    rarity: 'exotic',
  }),

  /**
   * Saurian Legions — a war machine holding something it does not understand.
   * The Red Court takes tribute: every kill banks one, and the next spike
   * spends the whole bank at once in a blast that scales with what you owed it.
   */
  bowRedCourt: mk({
    id: 'bowRedCourt',
    displayName: 'Red Court',
    family: 'bow',
    slot: 'power',
    element: 'kinetic',
    fireMode: 'charge',
    rpm: 60,
    chargeTime: 1.05,
    magazine: 2,
    reserves: 12,
    reloadTime: 2.4,
    emptyReloadTime: 2.8,
    damage: 165,
    precisionMultiplier: 1.55,
    spread: 0.014,
    baseSpread: 0.001,
    spreadPerShot: 0.006,
    spreadRecovery: 0.07,
    falloffStart: 60,
    falloffEnd: 90,
    falloffFloor: 0.85,
    recoilVertical: 0.05,
    recoilHorizontal: 0.009,
    recoilRandomness: 0.2,
    recoilRecovery: 2.3,
    cameraKick: 0.031,
    modelKick: 0.072,
    adsTime: 0.36,
    adsZoom: 1.5,
    adsMoveScale: 0.5,
    hitscan: false,
    projectileSpeed: 125,
    projectileGravity: 5.5,
    splashRadius: 3.2,
    splashDamage: 80,
    aimAssist: 0.024,
    muzzleIntensity: 0.7,
    tracerWidth: 0.032,
    shake: 0.33,
    impulse: 300,
    perks: ['tribute', 'openingShot'],
    rarity: 'exotic',
  }),
};

/** Every family maps to exactly one catalogue entry, so this is total. */
export const WEAPON_BY_FAMILY = WEAPONS as Record<WeaponFamily, WeaponStats>;

export const WEAPON_IDS: string[] = Object.keys(WEAPONS);

/** Slot ordering used by `equip(0|1|2)`. */
export const SLOT_ORDER: readonly WeaponSlot[] = ['kinetic', 'energy', 'power'];

export const SLOT_INDEX: Record<WeaponSlot, 0 | 1 | 2> = {
  kinetic: 0,
  energy: 1,
  power: 2,
};

/** Catalogue grouped by slot, in catalogue order. */
export const WEAPONS_BY_SLOT: Record<WeaponSlot, string[]> = {
  kinetic: WEAPON_IDS.filter((id) => WEAPONS[id].slot === 'kinetic'),
  energy: WEAPON_IDS.filter((id) => WEAPONS[id].slot === 'energy'),
  power: WEAPON_IDS.filter((id) => WEAPONS[id].slot === 'power'),
};

// ---------------------------------------------------------------------------
// Loot pools
// ---------------------------------------------------------------------------

/**
 * The named exotics, one per faction.
 *
 * `handCannon`, `bow` and `traceRifle` also carry `rarity: 'exotic'`, but they
 * are exotic *frames* — the gold-trim treatment on a generic weapon. These five
 * are named guns with a signature perk no roll can produce, and they are the
 * set the loot roller should treat as an event.
 */
export const EXOTIC_IDS: readonly string[] = [
  'shotgunWeregild',
  'scoutRifleErrata',
  'sidearmInstar',
  'rocketLauncherTenThousand',
  'bowRedCourt',
].filter((id) => WEAPONS[id] != null);

/**
 * What a drop of each quality is allowed to be.
 *
 * `common` is the starter kit, `good` is everything with a gimmick, `power` is
 * the heavy slot. Split as data rather than inline in the loot system so adding
 * a weapon to the catalogue is the only edit needed to put it in the world —
 * the previous arrangement hard-coded three string arrays inside `Loot.ts`, and
 * every weapon added after it shipped was unreachable.
 */
export const LOOT_TIERS: Record<'common' | 'good' | 'power', readonly string[]> = {
  common: ['autoRifle', 'pulseRifle', 'scoutRifle', 'sidearm', 'submachineGun', 'sidearmRicochet'],
  good: [
    'handCannon',
    'shotgun',
    'sniperRifle',
    'fusionRifle',
    'bow',
    'traceRifle',
    'sidearmBurst',
    'traceRifleKindler',
    'scoutRifleCell',
  ],
  power: [
    'rocketLauncher',
    'grenadeLauncher',
    'machineGun',
    'rocketLauncherSwarm',
    'bowSiege',
  ],
};

/**
 * Pick the catalogue entry a drop of this rarity rolls into.
 *
 * Drop-in replacement for `pickWeaponForRarity()` in `Loot.ts`: same signature,
 * same shape of answer, but sourced from the catalogue instead of a copy of it.
 * An exotic drop resolves to a *named* exotic slightly more often than not; the
 * rest of the time it is an exotic-quality roll of an ordinary frame, which is
 * what keeps "Weregild dropped" an event rather than a Tuesday.
 */
export function pickLootWeapon(rarity: ItemRarity, rng: Rng): string {
  if (rarity === 'exotic' && EXOTIC_IDS.length > 0 && rng.bool(0.55)) {
    return rng.pick(EXOTIC_IDS);
  }
  if (rarity === 'exotic' || rarity === 'legendary') {
    return rng.bool(0.45) ? rng.pick(LOOT_TIERS.power) : rng.pick(LOOT_TIERS.good);
  }
  if (rarity === 'rare') {
    return rng.bool(0.5) ? rng.pick(LOOT_TIERS.good) : rng.pick(LOOT_TIERS.common);
  }
  return rng.pick(LOOT_TIERS.common);
}

/** Every id a drop can produce — used by the verification harness. */
export const LOOT_REACHABLE: readonly string[] = [
  ...LOOT_TIERS.common,
  ...LOOT_TIERS.good,
  ...LOOT_TIERS.power,
  ...EXOTIC_IDS,
];

/** What the player spawns holding. */
export const DEFAULT_LOADOUT: [string, string, string] = [
  'autoRifle',
  'pulseRifle',
  'rocketLauncher',
];

/** Seconds between shots for a family's intra-burst cadence. */
export function shotInterval(s: WeaponStats): number {
  return 60 / Math.max(1, s.rpm);
}

/**
 * Sustained rounds-per-minute including burst pauses and charge time. Used by
 * the verification harness and by the UI's stat bars.
 */
export function sustainedRpm(s: WeaponStats): number {
  const gap = shotInterval(s);
  if (s.fireMode === 'burst') {
    const cycle = (s.burstCount - 1) * gap + s.burstDelay;
    return (s.burstCount / cycle) * 60;
  }
  if (s.fireMode === 'charge') return 60 / (s.chargeTime + gap);
  return s.rpm;
}
