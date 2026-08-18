/**
 * WeaponDefs — the weapon catalogue and the host contracts the weapon system
 * codes against.
 *
 * There is exactly one weapon per `WeaponFamily`, and the record key is the
 * family name. That keeps lookup trivial (`WEAPONS[family]`) while leaving room
 * to add named variants later without touching call sites.
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
  RaycastHit,
  SurfaceKind,
  WeaponFamily,
  WeaponSlot,
  WeaponStats,
} from '@/types';
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
