/**
 * Atmosphere profiles — the physical + art-directed description of one sky.
 *
 * Every planet's mood starts here. The scattering model in `SkyDome` is
 * genuinely physical (Rayleigh + Mie single scattering with a multiple-scatter
 * approximation), which means the *spectral* coefficients below are the primary
 * art tool: you do not paint an acid-green sky, you give Khepri an atmosphere
 * whose Rayleigh cross-section peaks in the green and let the integral produce
 * the colour — including the correct horizon reddening, aureole and terminator.
 *
 * Units, so nothing here is a magic number:
 *   rayleigh          per-channel scattering coefficient at sea level, m^-1
 *                     (Earth is ~(5.8, 13.6, 33.1)e-6 — blue scatters 6x red)
 *   mie               Mie scattering coefficient at sea level, m^-1
 *                     (Earth clear air ~4e-6; dust/ash/fog run 20-45e-6)
 *   mieAlbedo         scattering / extinction for the aerosol. 0.9 = haze,
 *                     0.5 = soot and ash, which *absorbs* and darkens the sky.
 *   mieG              Henyey-Greenstein asymmetry. 0.76-0.88 = strong forward
 *                     scatter, i.e. a big bright aureole hugging the sun.
 *   turbidity         0..1 artistic haze weight; drives star extinction, IBL
 *                     softness and the aerial-perspective strength.
 *   sunIntensity      solar irradiance in the renderer's light units. It is fed
 *                     to the DirectionalLight *and* the scattering integral, so
 *                     sky and surface brightness can never disagree.
 *   fogDensity        FogExp2 density (m^-1) the level should install.
 *   cloudAltitude     cloud base above the ground plane, metres.
 */
import * as THREE from 'three';
import type { PlanetId } from '@/types';
import { DEG } from '@/util/math';

/** Every sky the game can be in: the five worlds plus deep space. */
export type SkyId = PlanetId | 'orbit';

export interface AtmosphereProfile {
  // -- scattering medium ----------------------------------------------------
  /** Per-channel Rayleigh scattering coefficient at ground level, m^-1. */
  rayleigh: THREE.Vector3;
  /** Mie (aerosol) scattering coefficient at ground level, m^-1. */
  mie: number;
  /** Henyey-Greenstein asymmetry parameter for the aerosol, -1..1. */
  mieG: number;
  /** Artistic haze weight, 0..1. Drives star extinction and IBL softness. */
  turbidity: number;

  // -- the star -------------------------------------------------------------
  /** Unit vector pointing from the world *towards* the sun. */
  sunDirection: THREE.Vector3;
  /** Solar colour, authored in sRGB. */
  sunColor: THREE.Color;
  /** Solar irradiance; also the DirectionalLight intensity. */
  sunIntensity: number;

  // -- surroundings ---------------------------------------------------------
  /** Diffuse albedo of the distant ground, for sky bounce and the IBL floor. */
  groundAlbedo: THREE.Color;
  /** Art-directed zenith colour. Used for cloud/aurora ambient and fallbacks. */
  zenith: THREE.Color;
  /** Art-directed horizon colour. Also the aerial-perspective target. */
  horizon: THREE.Color;

  // -- participating media --------------------------------------------------
  fogColor: THREE.Color;
  /** FogExp2 density, m^-1. */
  fogDensity: number;
  /** Height-fog e-folding distance, metres. Larger = fog reaches higher. */
  fogHeightFalloff: number;

  // -- clouds ---------------------------------------------------------------
  /** 0 = clear, 1 = solid overcast. */
  cloudCoverage: number;
  /** Cloud base altitude above the ground plane, metres. */
  cloudAltitude: number;
  cloudColor: THREE.Color;

  // -- celestial ------------------------------------------------------------
  auroraStrength: number;
  auroraColor: THREE.Color;
  /** Star count multiplier. 0 disables the starfield entirely. */
  starDensity: number;
  /** Suggested renderer exposure for this world. Consumed by PostFX. */
  exposure: number;

  // -- optional refinements (all defaulted by `resolveAtmosphere`) ----------
  /** Aerosol single-scattering albedo. <0.8 makes ash and soot absorb. */
  mieAlbedo?: number;
  /** Rayleigh e-folding height, metres (Earth 8000). */
  rayleighScaleHeight?: number;
  /** Mie e-folding height, metres (Earth 1200). Thick dust sits higher. */
  mieScaleHeight?: number;
  /** Multiple-scattering lift, 0..2. Stops thin skies crushing to black. */
  multipleScattering?: number;
  /** Final multiplicative tint on the sky radiance. Pure art direction. */
  skyTint?: THREE.Color;
  /** Angular radius of the sun disc, radians (Earth 0.00465). */
  sunAngularRadius?: number;
  /** Peak radiance of the disc, as a multiple of sunIntensity. */
  sunDiscBrightness?: number;
  /** False when another layer owns the star (deep space draws its own). */
  sunDisc?: boolean;
  /** HemisphereLight intensity. Defaults from the integrated sky brightness. */
  ambientIntensity?: number;
  /**
   * Hue of the light bounced back *up* off the ground, lighting undersides and
   * the lower half of every vertical face. Defaults to `groundAlbedo`, which is
   * right for a world lit only from above — but a world with its own ground
   * light source (lava, a city, a glacier under a low sun) bounces something
   * quite different from its albedo, and that difference is the whole reason a
   * basin floor reads as a floor instead of as a hole.
   */
  groundBounce?: THREE.Color;
  /**
   * Strength of that bounce relative to the sky fill. 1 = the sky and the ground
   * contribute equally; above 1 the ground is the brighter of the two, which is
   * exactly what standing in a lava basin looks like.
   */
  groundBounceStrength?: number;
  /** Half-width of the shadow-map footprint, metres. Low suns need more. */
  shadowExtent?: number;
  /** VSM blur radius. Bigger = softer, for overcast worlds. */
  shadowSoftness?: number;
  /** Cloud slab thickness, metres. */
  cloudThickness?: number;
  /** 0 = flat stratus sheet, 1 = towering cumulus with an anvil top. */
  cloudAnvil?: number;
  /** Extinction coefficient inside cloud, m^-1. */
  cloudExtinction?: number;
  /** Horizontal wind, m/s, applied to the cloud noise domain. */
  cloudWind?: THREE.Vector2;
  /** Anisotropic stretch of the cloud noise domain (x, y, z). */
  cloudStretch?: THREE.Vector3;
  /** Light bounced onto the cloud base from below — lava, city, ice. */
  cloudUnderlight?: THREE.Color;
  cloudUnderlightStrength?: number;
  /** Aurora curtain base altitude, metres above the camera. */
  auroraAltitude?: number;
  /** Milky-way band brightness, 0..2. */
  milkyWay?: number;
  /** Deep-space nebula backdrop weight, 0..1. */
  space?: number;
  /** Scintillation strength, 0..1. Vacuum is 0 — stars there are rock steady. */
  starTwinkle?: number;
}

/** Scattering coefficients read better authored in units of 1e-6 m^-1. */
function beta(r: number, g: number, b: number): THREE.Vector3 {
  return new THREE.Vector3(r * 1e-6, g * 1e-6, b * 1e-6);
}

/** Sun direction from elevation/azimuth in degrees. Azimuth 0 = +Z. */
export function sunDirectionFromAngles(
  elevationDeg: number,
  azimuthDeg: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const e = elevationDeg * DEG;
  const a = azimuthDeg * DEG;
  const c = Math.cos(e);
  return out.set(c * Math.sin(a), Math.sin(e), c * Math.cos(a)).normalize();
}

const c = (hex: number): THREE.Color => new THREE.Color(hex);

// ---------------------------------------------------------------------------
// The five worlds, plus orbit.
// ---------------------------------------------------------------------------

export const ATMOSPHERES: Record<SkyId, AtmosphereProfile> = {
  /**
   * Aurvangr — tide-locked ice world. The sun never climbs above 8 degrees, so
   * every shadow is a 20-metre streak and the whole world is lit by a cold
   * grazing beam through a lot of atmosphere. Ice fog scatters hard (high Mie,
   * high albedo) which produces the pale cyan-white horizon band; the Rayleigh
   * term is pulled towards cyan rather than Earth's deep blue.
   */
  aurvangr: {
    rayleigh: beta(6.4, 15.2, 26.0),
    mie: 15.5e-6,
    mieAlbedo: 0.96,
    mieG: 0.71,
    mieScaleHeight: 3100,
    turbidity: 0.62,
    multipleScattering: 1.5,
    sunDirection: sunDirectionFromAngles(6.5, 152),
    sunColor: c(0xcfe2ff),
    sunIntensity: 4.2,
    sunAngularRadius: 0.0052,
    sunDiscBrightness: 26,
    groundAlbedo: c(0x8fa8bd),
    zenith: c(0x2c5f96),
    horizon: c(0xbcd8ee),
    fogColor: c(0x9dc0dc),
    fogDensity: 0.0030,
    fogHeightFalloff: 46,
    cloudCoverage: 0.44,
    cloudAltitude: 5200,
    cloudThickness: 620,
    cloudAnvil: 0.06,
    cloudExtinction: 0.009,
    cloudColor: c(0xd8e8f8),
    cloudStretch: new THREE.Vector3(0.34, 2.6, 1.0),
    cloudWind: new THREE.Vector2(11, 3),
    cloudUnderlight: c(0x5f88b4),
    cloudUnderlightStrength: 0.5,
    auroraStrength: 1,
    auroraColor: c(0x4dffab),
    auroraAltitude: 1400,
    starDensity: 0.5,
    starTwinkle: 0.55,
    milkyWay: 0.5,
    exposure: 1.05,
    shadowExtent: 130,
    shadowSoftness: 3.2,
  },

  /**
   * Zeta Reticuli IV — 40 mbar of nitrogen over grey regolith. Almost no
   * atmosphere means almost no scattering: the zenith is near black, stars are
   * out at noon, and the terminator on every rock is a knife edge because there
   * is no sky fill to soften it. The little scattering there is peaks in the
   * violet, giving the horizon its bruised cast.
   */
  'zeta-reticuli': {
    rayleigh: beta(0.95, 0.70, 2.35),
    mie: 0.8e-6,
    mieAlbedo: 0.7,
    mieG: 0.55,
    mieScaleHeight: 900,
    rayleighScaleHeight: 10000,
    turbidity: 0.05,
    multipleScattering: 0.22,
    sunDirection: sunDirectionFromAngles(47, -38),
    sunColor: c(0xeee6ff),
    sunIntensity: 5.6,
    sunAngularRadius: 0.0061,
    sunDiscBrightness: 42,
    groundAlbedo: c(0x6d6a74),
    zenith: c(0x07060e),
    horizon: c(0x352c48),
    fogColor: c(0x2a2436),
    fogDensity: 0.00035,
    fogHeightFalloff: 200,
    cloudCoverage: 0,
    cloudAltitude: 9000,
    cloudColor: c(0x9a94a8),
    auroraStrength: 0,
    auroraColor: c(0x8f7fff),
    starDensity: 1.35,
    starTwinkle: 0,
    milkyWay: 1.15,
    exposure: 0.95,
    shadowExtent: 95,
    shadowSoftness: 1.1,
  },

  /**
   * Khepri — a hot wet greenhouse. Enormous aerosol load at a high scale
   * height, so the whole volume glows: contrast collapses, the sun becomes a
   * diffuse bright patch behind cloud, and everything more than 80 m away
   * dissolves into acid haze. The Rayleigh term peaks in the green.
   */
  khepri: {
    rayleigh: beta(6.0, 17.5, 8.5),
    mie: 46e-6,
    mieAlbedo: 0.93,
    mieG: 0.63,
    mieScaleHeight: 3400,
    turbidity: 0.96,
    multipleScattering: 1.55,
    sunDirection: sunDirectionFromAngles(58, 24),
    sunColor: c(0xfff6d8),
    sunIntensity: 2.9,
    sunAngularRadius: 0.0098,
    sunDiscBrightness: 14,
    groundAlbedo: c(0x4a5c30),
    zenith: c(0x7fae52),
    horizon: c(0xc8e08a),
    fogColor: c(0x9fc46a),
    fogDensity: 0.0050,
    fogHeightFalloff: 90,
    cloudCoverage: 0.86,
    cloudAltitude: 1250,
    cloudThickness: 1500,
    cloudAnvil: 0.35,
    cloudExtinction: 0.013,
    cloudColor: c(0xcfe6a0),
    cloudWind: new THREE.Vector2(4, 6),
    cloudUnderlight: c(0x86a83c),
    cloudUnderlightStrength: 0.85,
    auroraStrength: 0,
    auroraColor: c(0x9fff66),
    starDensity: 0,
    exposure: 1,
    shadowExtent: 85,
    shadowSoftness: 5.5,
  },

  /**
   * Hive Prime — perpetual dusk under a spore-laden dust column. Iron-rich dust
   * absorbs blue, so the Rayleigh term is inverted relative to Earth and the
   * sky runs amber to rust. Low sun, low ceiling: the cloud deck sits at 900 m
   * and caps the world like a lid.
   */
  'hive-prime': {
    rayleigh: beta(13.5, 8.2, 5.0),
    mie: 30e-6,
    mieAlbedo: 0.82,
    mieG: 0.77,
    mieScaleHeight: 3000,
    turbidity: 0.86,
    multipleScattering: 1.25,
    sunDirection: sunDirectionFromAngles(8.5, -108),
    sunColor: c(0xffb257),
    sunIntensity: 2.9,
    sunAngularRadius: 0.0165,
    sunDiscBrightness: 16,
    groundAlbedo: c(0x7a4c22),
    zenith: c(0x6d3b1c),
    horizon: c(0xe08a3a),
    fogColor: c(0xb0682c),
    fogDensity: 0.0042,
    fogHeightFalloff: 70,
    cloudCoverage: 0.72,
    cloudAltitude: 900,
    cloudThickness: 900,
    cloudAnvil: 0.5,
    cloudExtinction: 0.011,
    cloudColor: c(0xd9975a),
    cloudWind: new THREE.Vector2(-6, 5),
    cloudUnderlight: c(0xc45f18),
    cloudUnderlightStrength: 1,
    auroraStrength: 0,
    auroraColor: c(0xffb257),
    starDensity: 0.16,
    starTwinkle: 0.85,
    milkyWay: 0.25,
    exposure: 1.1,
    shadowExtent: 120,
    shadowSoftness: 3.6,
  },

  /**
   * Draco IX — a forge world under an ash column. The aerosol here *absorbs*
   * (mieAlbedo 0.5), which is what makes an ash sky read as ash: the zenith
   * goes dark brown-black instead of bright grey, while the strong forward
   * lobe wraps a huge blood-red glare around a swollen sun. Cloud is black
   * smoke lit from beneath by lava.
   */
  'draco-ix': {
    rayleigh: beta(17.0, 5.6, 3.0),
    mie: 40e-6,
    // mieAlbedo 0.5 on the thickest Mie coefficient of any world meant the ash
    // absorbed half of everything it scattered, and multipleScattering 0.8 left
    // nothing to fill it back in - so away from the sun the dome integrated to
    // black and the frame showed a hard black band between the lit cloud deck
    // and the horizon haze. Ash should redden and dim the sky, not erase it.
    mieAlbedo: 0.72,
    mieG: 0.86,
    mieScaleHeight: 4200,
    turbidity: 0.9,
    // Raised from 1.35. Measured on a real capture, 68% of the frame sat below
    // L=25 and 84% below L=51, with the bottom 40% carrying no readable form at
    // all - "the whole frame in one value band", which is an outright fail in
    // the rubric. The sky above the ash layer was among the best things in the
    // build, so the answer is emphatically *not* more exposure: that lifts the
    // basin and the sky together and throws away the one part that was working.
    // Multiple scattering is the term that fills a thick, absorbing medium back
    // in from below, so raising it lights the basin far more than the zenith.
    multipleScattering: 1.75,
    sunDirection: sunDirectionFromAngles(19, 68),
    sunColor: c(0xff5c26),
    sunIntensity: 2.8,
    sunAngularRadius: 0.021,
    sunDiscBrightness: 2.5,
    groundAlbedo: c(0x2e1a14),
    // Ash haze has to read as depth, not as a flat wash. At 0.0040 with a dark
    // red fog colour, everything past ~150 m saturated to one value and the
    // whole world collapsed into a single red field with no terrain readable in
    // it. Thinned, and the zenith lifted off near-black so the sky still has
    // range above the ash layer.
    zenith: c(0x3a1a12),
    horizon: c(0xc0421a),
    fogColor: c(0x5a2113),
    fogDensity: 0.0015,
    fogHeightFalloff: 80,
    cloudCoverage: 0.5,
    cloudAltitude: 2100,
    cloudThickness: 2200,
    cloudAnvil: 0.95,
    cloudExtinction: 0.016,
    cloudColor: c(0x241a18),
    cloudWind: new THREE.Vector2(3, -8),
    cloudUnderlight: c(0xff5410),
    cloudUnderlightStrength: 3.6,
    auroraStrength: 0,
    auroraColor: c(0xff4400),
    starDensity: 0.06,
    starTwinkle: 0.9,
    milkyWay: 0.12,
    exposure: 1.15,
    // A basin floored with open lava is not lit from the sky; it is lit from
    // itself. The hemisphere fill is given an explicit magnitude rather than one
    // derived from a near-black zenith, and the ground half of it is turned into
    // a hot, over-unity bounce so overhangs, rock undersides and the bottom of
    // every vertical face pick up the orange the channels are actually throwing.
    // This is what puts form into the bottom 40% of the frame.
    ambientIntensity: 0.72,
    groundBounce: c(0xff6a24),
    groundBounceStrength: 2.1,
    shadowExtent: 110,
    shadowSoftness: 2.6,
  },

  /**
   * Orbit — vacuum. No scattering at all, so the sky dome integrates to black
   * and `SpaceBackdrop` owns the frame: nebulae with real absorption, dust
   * lanes, a distant galaxy and the system star with its corona. Stars do not
   * twinkle because there is nothing to scintillate through.
   */
  orbit: {
    rayleigh: beta(0, 0, 0),
    mie: 0,
    mieG: 0.76,
    turbidity: 0,
    multipleScattering: 0,
    sunDirection: sunDirectionFromAngles(14, 118),
    sunColor: c(0xfff1e0),
    sunIntensity: 6,
    sunAngularRadius: 0.012,
    sunDisc: false,
    groundAlbedo: c(0x000000),
    zenith: c(0x0d1230),
    horizon: c(0x1a1030),
    fogColor: c(0x03040a),
    fogDensity: 0,
    fogHeightFalloff: 1000,
    cloudCoverage: 0,
    cloudAltitude: 0,
    cloudColor: c(0x000000),
    auroraStrength: 0,
    auroraColor: c(0x66ccff),
    starDensity: 1.6,
    starTwinkle: 0,
    milkyWay: 1.0,
    space: 1,
    exposure: 1,
    ambientIntensity: 0.14,
    shadowExtent: 90,
    shadowSoftness: 1,
  },
};

/** Deep copy, so a caller can tweak a profile without editing the table. */
export function cloneAtmosphere(p: AtmosphereProfile): AtmosphereProfile {
  const out = { ...p } as AtmosphereProfile;
  out.rayleigh = p.rayleigh.clone();
  out.sunDirection = p.sunDirection.clone();
  out.sunColor = p.sunColor.clone();
  out.groundAlbedo = p.groundAlbedo.clone();
  out.zenith = p.zenith.clone();
  out.horizon = p.horizon.clone();
  out.fogColor = p.fogColor.clone();
  out.cloudColor = p.cloudColor.clone();
  out.auroraColor = p.auroraColor.clone();
  if (p.skyTint) out.skyTint = p.skyTint.clone();
  if (p.groundBounce) out.groundBounce = p.groundBounce.clone();
  if (p.cloudWind) out.cloudWind = p.cloudWind.clone();
  if (p.cloudStretch) out.cloudStretch = p.cloudStretch.clone();
  if (p.cloudUnderlight) out.cloudUnderlight = p.cloudUnderlight.clone();
  return out;
}

/** Every field present. Internal shape all sky layers actually consume. */
export interface ResolvedAtmosphere extends Required<AtmosphereProfile> {}

const WHITE = new THREE.Color(0xffffff);

/**
 * Fill in the optional half of a profile. Called once per `setProfile`, never
 * per frame, so it is free to allocate.
 */
export function resolveAtmosphere(p: AtmosphereProfile): ResolvedAtmosphere {
  const coverage = p.cloudCoverage;
  return {
    rayleigh: p.rayleigh.clone(),
    mie: p.mie,
    mieG: p.mieG,
    turbidity: p.turbidity,
    sunDirection: p.sunDirection.clone().normalize(),
    sunColor: p.sunColor.clone(),
    sunIntensity: p.sunIntensity,
    groundAlbedo: p.groundAlbedo.clone(),
    zenith: p.zenith.clone(),
    horizon: p.horizon.clone(),
    fogColor: p.fogColor.clone(),
    fogDensity: p.fogDensity,
    fogHeightFalloff: p.fogHeightFalloff,
    cloudCoverage: coverage,
    cloudAltitude: p.cloudAltitude,
    cloudColor: p.cloudColor.clone(),
    auroraStrength: p.auroraStrength,
    auroraColor: p.auroraColor.clone(),
    starDensity: p.starDensity,
    exposure: p.exposure,

    mieAlbedo: p.mieAlbedo ?? 0.9,
    rayleighScaleHeight: p.rayleighScaleHeight ?? 8000,
    mieScaleHeight: p.mieScaleHeight ?? 1200,
    multipleScattering: p.multipleScattering ?? 1,
    skyTint: (p.skyTint ?? WHITE).clone(),
    sunAngularRadius: p.sunAngularRadius ?? 0.0075,
    sunDiscBrightness: p.sunDiscBrightness ?? 26,
    sunDisc: p.sunDisc ?? true,
    ambientIntensity: p.ambientIntensity ?? -1,
    groundBounce: (p.groundBounce ?? p.groundAlbedo).clone(),
    groundBounceStrength: p.groundBounceStrength ?? 1,
    shadowExtent: p.shadowExtent ?? 100,
    shadowSoftness: p.shadowSoftness ?? 2.5,
    cloudThickness: p.cloudThickness ?? 900,
    cloudAnvil: p.cloudAnvil ?? 0.5,
    cloudExtinction: p.cloudExtinction ?? 0.012,
    cloudWind: (p.cloudWind ?? new THREE.Vector2(6, 2)).clone(),
    cloudStretch: (p.cloudStretch ?? new THREE.Vector3(1, 1, 1)).clone(),
    cloudUnderlight: (p.cloudUnderlight ?? p.groundAlbedo).clone(),
    cloudUnderlightStrength: p.cloudUnderlightStrength ?? 0.6,
    auroraAltitude: p.auroraAltitude ?? 1200,
    milkyWay: p.milkyWay ?? 0,
    space: p.space ?? 0,
    starTwinkle: p.starTwinkle ?? 0.6,
  };
}
