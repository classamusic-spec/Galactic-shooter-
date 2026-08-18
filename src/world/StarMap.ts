/**
 * StarMap — the orbital hub, and the first thing the player ever sees.
 *
 * The whole system is a real 3D place rather than a menu with a background: the
 * star is an actual body at the origin, the five worlds are lit by it from
 * whatever direction they happen to be in, and the player flies between them in
 * the Kestrel. Selecting a world is therefore a *flight*, not a click, and the
 * UI panel is only a shortcut for the same action.
 *
 * ## What makes the frame read as expensive
 *
 * 1. **One committed key light.** The star at the origin is the only light in
 *    the system. Every globe computes its own terminator from the direction to
 *    the origin, so the phase of each world is geometrically correct — the
 *    inner planets show gibbous discs, the outer ones crescents, and flying
 *    around one sweeps its terminator exactly as it should.
 * 2. **Absorption, not just emission.** The nebulae come from `SpaceBackdrop`,
 *    which writes premultiplied colour with a real alpha, so dust *occults*
 *    stars. That is the depth cue no additive starfield can fake.
 * 3. **A value ladder.** Nebula sits at 0.02-0.08 linear, planets at 0.07-0.15,
 *    the star core at 3+. The auto-exposure pass keys off the 42-94th
 *    percentile band, so with space dominating the frame it settles near its
 *    5.5x ceiling — which is why the globes are authored dark. Author them at
 *    "correct" brightness and they clip to white discs the moment the camera
 *    backs off.
 * 4. **Foreground framing for free.** The Kestrel's canopy ribs and coaming
 *    occupy the bottom and edges of the frame, which is exactly the dark
 *    foreground frame the value structure wants.
 *
 * ## Scale
 *
 * `PlanetDescriptor.orbitRadius` is in arbitrary star-map units; this module is
 * the thing that decides what they mean. `SPACE_SCALE` puts the outermost orbit
 * at 1518 m and `FLIGHT_BOUNDS` keeps the ship inside 1900 m of the star, so the
 * furthest visible object is ~3.5 km — comfortably inside the camera's 4 km far
 * plane, with no need to touch the shared projection.
 */
import * as THREE from 'three';
import type {
  CapsuleResolveResult,
  CollisionWorld,
  FrameContext,
  Level,
  PlanetDescriptor,
  PlanetId,
  RaycastHit,
} from '@/types';
import type { Engine } from '@/core/Engine';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import type { Ship } from './Ship';
import { PLANETS } from './planets';
import { SkyDome } from '@/gfx/sky/SkyDome';
import { ATMOSPHERES, cloneAtmosphere } from '@/gfx/sky/AtmosphereProfile';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { GLSL_NOISE } from '@/gfx/materials/glsl';
import { clamp, clamp01, Rng, TAU } from '@/util/math';

// Registering the two surface levels this owner ships. The planet registry is
// deliberately indirect (see `planets/index.ts`), which means *something* has to
// import the level modules or their factories never exist. The star map is the
// one module guaranteed to be loaded before any travel can be requested.
import './planets/HivePrime';
import './planets/DracoIX';
// The other three worlds chain from Aurvangr, which imports its own siblings.
import './planets/Aurvangr';

/** Metres per unit of `PlanetDescriptor.orbitRadius`. */
const SPACE_SCALE = 11;
/** Metres per unit of `PlanetDescriptor.radius`. Globes read larger than orbits. */
const GLOBE_SCALE = 17;
/** Radius of the system star, metres. */
const STAR_RADIUS = 118;
/** The ship is pulled back inside this radius, metres. */
const FLIGHT_BOUNDS = 1900;
/** Orbital motion is slowed from the descriptor value so the map is stately. */
const ORBIT_RATE = 0.25;
/** Landing prompt appears inside this many planet radii. */
const LANDING_RADII = 2.8;

// ---------------------------------------------------------------------------
// Art direction, per world
// ---------------------------------------------------------------------------

interface GlobeArt {
  /** Surface shader branch: 0 ice, 1 regolith, 2 jungle, 3 hive, 4 volcanic. */
  style: number;
  /** Secondary surface colour (low ground / shadowed material), sRGB hex. */
  secondary: number;
  /** 0 = clear, 1 = solid cloud deck. */
  cloud: number;
  cloudColor: number;
  /** Night-side emissive: city lights, lava, bioluminescence. */
  nightColor: number;
  nightStrength: number;
  /** Surface rotation, rad/s. */
  spin: number;
  /** Axial tilt, radians. */
  tilt: number;
  /** Orbit phase at t=0, radians. */
  phase: number;
  /** Orbit inclination, radians, about an axis at `node`. */
  inclination: number;
  node: number;
  /** Ring system, in planet radii. */
  ring: { inner: number; outer: number; color: number; opacity: number } | null;
}

const GLOBE_ART: Record<PlanetId, GlobeArt> = {
  aurvangr: {
    style: 0,
    secondary: 0x2c5f80,
    cloud: 0.42,
    cloudColor: 0xdfeeff,
    nightColor: 0x3affc0,
    nightStrength: 0.5,
    spin: 0.012,
    tilt: 0.31,
    phase: 0.62,
    inclination: 0.035,
    node: 0.4,
    // An ice world close enough to its star to have a shepherded debris ring is
    // the cheapest strong silhouette in the whole system.
    ring: { inner: 1.55, outer: 2.5, color: 0xbcd8ee, opacity: 0.55 },
  },
  'zeta-reticuli': {
    style: 1,
    secondary: 0x4a4657,
    cloud: 0.06,
    cloudColor: 0xa9a4b6,
    nightColor: 0x9f7fff,
    nightStrength: 0.9,
    spin: 0.009,
    tilt: 0.06,
    phase: 2.35,
    inclination: -0.075,
    node: 1.9,
    ring: null,
  },
  khepri: {
    style: 2,
    secondary: 0x24401e,
    cloud: 0.68,
    cloudColor: 0xd8ecae,
    nightColor: 0x69ff8f,
    nightStrength: 0.28,
    spin: 0.016,
    tilt: 0.42,
    phase: 4.05,
    inclination: 0.055,
    node: 3.1,
    ring: null,
  },
  'hive-prime': {
    style: 3,
    secondary: 0x4a2c11,
    cloud: 0.5,
    cloudColor: 0xd9a765,
    nightColor: 0xff9a2e,
    nightStrength: 0.75,
    spin: 0.011,
    tilt: 0.19,
    phase: 5.5,
    inclination: -0.03,
    node: 0.9,
    ring: null,
  },
  'draco-ix': {
    style: 4,
    secondary: 0x1a0f0c,
    cloud: 0.34,
    cloudColor: 0x3a2a26,
    nightColor: 0xff4a12,
    nightStrength: 1.35,
    spin: 0.008,
    tilt: 0.26,
    phase: 1.15,
    inclination: 0.045,
    node: 2.4,
    ring: null,
  },
};

/**
 * What the star map needs of `UiRoot`: somewhere to install the SET COURSE
 * handler. Declared structurally so `world` never imports `ui` — the dependency
 * graph runs one way, and the UI is a subscriber, not a dependency.
 */
interface UiTravelHost {
  readonly name: string;
  onTravel: ((id: PlanetId) => void) | null;
}

/**
 * Which orbital level currently owns the ship.
 *
 * Level changes overlap: the incoming level's `load()` runs to completion — and
 * emits `ship:enter` — *before* `Engine.setLevel` disposes the outgoing one. A
 * naive `ship:exit` in `dispose()` therefore switches the ship off immediately
 * after the new map switched it on, and the player ends up looking out of a
 * dead camera parked at the origin. Ownership is tracked so only the level that
 * actually holds the ship can release it.
 */
let shipHolder: OrbitalLevel | null = null;

// Scratch — module scope so nothing in the per-frame path allocates.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _col = new THREE.Color();

/** sRGB hex to a linear-space Vector3, which is what the shaders want. */
function linearRgb(hex: number, scale = 1): THREE.Vector3 {
  _col.set(hex).convertSRGBToLinear();
  return new THREE.Vector3(_col.r * scale, _col.g * scale, _col.b * scale);
}

// ---------------------------------------------------------------------------
// Collision: vacuum
// ---------------------------------------------------------------------------

/**
 * A permissive `CollisionWorld` for open space.
 *
 * There is nothing to stand on and nothing to bump into — the ship's own bounds
 * check is the only constraint — but the contract still has to be honoured
 * because `EnemyManager`, `WeaponSystem` and the player all query it blind.
 * Every method is allocation-free and returns the "nothing there" answer.
 */
class VacuumSpace implements CollisionWorld {
  private readonly result: CapsuleResolveResult = {
    grounded: false,
    groundNormal: new THREE.Vector3(0, 1, 0),
    slope: 0,
    touchedWall: false,
    wallNormal: new THREE.Vector3(0, 1, 0),
    landingImpact: 0,
  };

  raycast(
    _origin: THREE.Vector3,
    _direction: THREE.Vector3,
    _maxDistance: number,
    _out?: RaycastHit,
  ): RaycastHit | null {
    return null;
  }

  resolveCapsule(
    position: THREE.Vector3,
    _radius: number,
    _halfHeight: number,
    velocity: THREE.Vector3,
    dt: number,
  ): CapsuleResolveResult {
    position.addScaledVector(velocity, dt);
    return this.result;
  }

  sampleGround(): { y: number; normal: THREE.Vector3 } | null {
    return null;
  }

  lineOfSight(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/** Shared GLSL: ridged multifractal in 3D, plus a Y rotation for cloud shear. */
const GLSL_GLOBE_COMMON = /* glsl */ `
float ridged3(vec3 p, int oct, float gain){
  float a = 0.5, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float v = 1.0 - abs(gnoise3(p));
    v *= v;
    sum += v * a;
    norm += a;
    a *= gain;
    p *= 2.03;
  }
  return sum / max(norm, 1e-4);
}

vec3 rotY(vec3 p, float a){
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
`;

const GLOBE_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vWorldP;
void main(){
  vObj = normalize(position);
  vWorldN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * One shader for all five globes.
 *
 * The branch is on a uniform, so every world shares a single compiled program —
 * shader-program count is a real first-sight stutter source and five near
 * identical planet programs would be five too many. Surface detail is evaluated
 * in *object* space (so it spins with the body) while lighting uses the world
 * normal (so the terminator tracks the star), which is the whole trick to making
 * a rotating planet read correctly.
 */
const GLOBE_FRAG = /* glsl */ `
${GLSL_NOISE}
${GLSL_GLOBE_COMMON}
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vWorldP;

uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uAtmo;
uniform vec3 uNight;
uniform vec3 uCloudCol;
uniform vec3 uAmbient;
uniform float uCloud;
uniform float uNightStrength;
uniform float uTime;
uniform float uStyle;
uniform float uSeed;

void main(){
  vec3 n = normalize(vObj);
  vec3 base = n * 2.0 + uSeed;

  // Domain warp first: unwarped fBm on a sphere reads as fog, warped fBm reads
  // as coastlines.
  float w = fbm3(base * 1.6, 3, 2.07, 0.5);
  vec3 q = base + vec3(w, w * 0.7, -w * 0.85) * 0.5;

  float cont = fbm3(q * 1.15, 5, 2.05, 0.52);
  float detail = fbm3(q * 5.2 + 13.0, 5, 2.11, 0.5);
  // A fine octave that only matters within a few radii. Without it a globe is a
  // soft mottled ball the moment the ship closes to landing range.
  float fine = fbm3(q * 19.0 + 51.0, 3, 2.13, 0.5);
  float land = smoothstep(-0.06, 0.30, cont + detail * 0.22);
  float lat = abs(n.y);

  vec3 albedo;
  float gloss = 0.0;
  vec3 emis = vec3(0.0);

  if (uStyle < 0.5) {
    // -- ice ----------------------------------------------------------------
    float crack = ridged3(q * 6.5, 4, 0.52);
    // Open ocean under the pack, then shelf, then the caps. Three values, not a
    // gradient — an ice world with one value is a pearl.
    albedo = mix(uColorB * 0.5, uColorA, smoothstep(0.25, 0.62, land));
    albedo = mix(albedo, uColorA * 1.2, smoothstep(0.50, 0.94, lat));
    albedo *= 1.0 - smoothstep(0.66, 0.97, crack) * 0.55;
    gloss = (1.0 - land) * 0.75 + 0.18;
    emis = uNight * smoothstep(0.62, 0.9, lat) * (0.35 + 0.65 * detail);
  } else if (uStyle < 1.5) {
    // -- regolith -----------------------------------------------------------
    float crater = ridged3(q * 8.5 + 4.0, 3, 0.55);
    float maria = smoothstep(0.10, 0.55, cont);
    albedo = mix(uColorB * 0.55, uColorA, maria);
    // Craters are a *value* feature, not a normal map at this distance: bright
    // ejecta rays over dark basin floors is what makes a grey world read as a
    // grey world and not a grey ball.
    albedo *= 0.62 + 0.75 * smoothstep(0.38, 0.90, crater);
    albedo *= 0.85 + 0.3 * smoothstep(0.2, 0.8, detail * 0.5 + 0.5);
    gloss = 0.05;
    // Custodian survey arrays: sparse, geometric, cold violet.
    float grid = smoothstep(0.88, 0.97, fbm3(q * 14.0 + 31.0, 3, 2.2, 0.5) * 0.5 + 0.5);
    emis = uNight * grid;
  } else if (uStyle < 2.5) {
    // -- jungle -------------------------------------------------------------
    float wet = smoothstep(-0.3, 0.25, cont);
    albedo = mix(uColorB * 0.6, uColorA, land);
    albedo *= 0.78 + 0.4 * (detail * 0.5 + 0.5);
    gloss = (1.0 - wet) * 0.55;
    emis = uNight * smoothstep(0.55, 0.85, land) * (0.4 + 0.6 * detail);
  } else if (uStyle < 3.5) {
    // -- hive ---------------------------------------------------------------
    // Ridged cells at two scales: the nest terracing that covers the crust.
    float cells = ridged3(q * 5.0 + 7.0, 4, 0.55);
    float fine = ridged3(q * 15.0 + 2.0, 3, 0.5);
    albedo = mix(uColorB, uColorA, land);
    albedo *= 0.72 + 0.5 * cells + 0.12 * fine;
    emis = uNight * smoothstep(0.58, 0.94, cells * 0.7 + fine * 0.3);
  } else {
    // -- volcanic -----------------------------------------------------------
    float fis = ridged3(q * 4.2 + 3.0, 5, 0.56);
    float lava = smoothstep(0.78, 0.99, fis);
    float caldera = smoothstep(0.55, 0.9, fbm3(q * 2.2 + 21.0, 4, 2.1, 0.5) * 0.5 + 0.5);
    albedo = mix(uColorB, uColorA, land * 0.7 + caldera * 0.3);
    albedo *= 0.65 + 0.45 * (detail * 0.5 + 0.5);
    emis = uNight * (lava * 1.6 + caldera * lava * 2.2);
  }

  // -- cloud deck ------------------------------------------------------------
  // Differential rotation: bands shear faster at the equator, which is what
  // separates weather from a texture sliding across a ball.
  float bandLat = n.y;
  float shear = uTime * (0.010 + 0.024 * (1.0 - bandLat * bandLat));
  vec3 cq = rotY(n, shear) * 2.4 + uSeed * 0.5;
  float cf = fbm3(cq * 2.1, 5, 2.08, 0.55);
  float swirl = fbm3(cq * 5.4 + cf * 0.8, 4, 2.05, 0.5);
  float cval = (cf * 0.6 + swirl * 0.4) * 0.5 + 0.5;
  // Latitude weighting keeps the deck banded rather than blotchy.
  cval += 0.16 * (1.0 - bandLat * bandLat) - 0.10 * lat;
  // A tighter window: soft cloud edges over a whole disc read as smeared grey.
  float cover = smoothstep(1.02 - uCloud, 1.22 - uCloud, cval) * step(0.02, uCloud);

  albedo *= 0.88 + 0.24 * (fine * 0.5 + 0.5);
  vec3 surf = mix(albedo, uCloudCol, cover * 0.94);
  gloss *= 1.0 - cover;

  // -- lighting --------------------------------------------------------------
  vec3 N = normalize(vWorldN);
  vec3 V = normalize(cameraPosition - vWorldP);
  vec3 L = normalize(uLightDir);
  float ndl = dot(N, L);
  float day = smoothstep(-0.10, 0.18, ndl);

  vec3 lit = surf * uLightColor * max(ndl, 0.0);

  // Ocean / ice specular. Narrow and dim: it is a highlight, not a mirror.
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 80.0) * gloss * step(0.0, ndl);
  lit += uLightColor * spec * 0.55;

  // Terminator scattering: the atmosphere is optically thick along the grazing
  // ray, so the day/night boundary carries a band of the atmosphere's own hue.
  float term = exp(-ndl * ndl * 240.0);
  lit += uAtmo * uLightColor * term * 0.55;

  vec3 night = emis * uNightStrength * (1.0 - day);
  vec3 col = lit + night + surf * uAmbient;

  // Limb glow, in-shader, so the atmosphere reads even where the outer shell is
  // edge-on to a pixel.
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  col += uAtmo * fres * (0.20 + 1.0 * max(ndl, 0.0)) * 0.5;

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const ATMO_VERT = GLOBE_VERT;

/**
 * The atmosphere shell.
 *
 * Front faces only, additive: at the centre of the disc the normal faces the
 * camera and the Fresnel term vanishes, so the shell contributes nothing over
 * the globe and everything at the limb. Forward scattering brightens the limb
 * that is closest to the star, which is what gives a crescent its blazing edge.
 */
const ATMO_FRAG = /* glsl */ `
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vWorldP;
uniform vec3 uLightDir;
uniform vec3 uAtmo;
uniform vec3 uSunset;
uniform float uStrength;

void main(){
  vec3 N = normalize(vWorldN);
  vec3 V = normalize(cameraPosition - vWorldP);
  vec3 L = normalize(uLightDir);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 4.2);
  float ndl = dot(N, L);
  float lit = smoothstep(-0.42, 0.30, ndl);
  // Mie forward lobe: looking through the atmosphere toward the star is far
  // brighter than looking through it away from the star.
  float phase = pow(max(dot(-V, L), 0.0), 5.0);
  float term = exp(-ndl * ndl * 26.0);
  vec3 col = mix(uAtmo, uSunset, term * 0.75);
  col *= rim * (0.10 + 1.15 * lit + 0.85 * phase) * uStrength;
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * The system star.
 *
 * Granulation at two scales gives the disc surface texture instead of a flat
 * fill; limb darkening (the same coefficients the sky dome uses for a sun disc)
 * is what stops it reading as a glowing circle; and the chromosphere term lifts
 * the extreme edge so the silhouette has a hot rim before the corona takes over.
 */
const STAR_FRAG = /* glsl */ `
${GLSL_NOISE}
${GLSL_GLOBE_COMMON}
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vWorldP;
uniform vec3 uColor;
uniform vec3 uRim;
uniform float uTime;
uniform float uBrightness;

void main(){
  vec3 n = normalize(vObj);
  vec3 N = normalize(vWorldN);
  vec3 V = normalize(cameraPosition - vWorldP);
  float mu = clamp(dot(N, V), 0.0, 1.0);

  // Convection cells, drifting. Two scales so the disc has both structure and
  // grain rather than one obvious noise frequency.
  float g1 = fbm3(n * 14.0 + vec3(0.0, uTime * 0.012, uTime * 0.009), 4, 2.09, 0.55);
  float g2 = ridged3(n * 38.0 - vec3(uTime * 0.02, 0.0, 0.0), 3, 0.5);
  float gran = 0.78 + 0.30 * g1 + 0.22 * (g2 - 0.5);

  // Cooler magnetic regions. Sparse, or the star reads as diseased.
  float spot = smoothstep(0.70, 0.86, fbm3(n * 5.0 + 17.0, 4, 2.0, 0.5) * 0.5 + 0.5);

  vec3 limb = 1.0 - vec3(0.40, 0.52, 0.68) * (1.0 - mu)
                  - vec3(0.16, 0.13, 0.09) * (1.0 - mu) * (1.0 - mu);
  vec3 col = uColor * gran * max(limb, vec3(0.0)) * uBrightness;
  col *= 1.0 - spot * 0.42;
  col += uRim * pow(1.0 - mu, 7.0) * uBrightness * 0.55;

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Corona. A camera-facing quad with three exponential scales and angular
 * streamers that shear with radius, so the outer corona twists the way a real
 * one does under its own magnetic field.
 */
const CORONA_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CORONA_FRAG = /* glsl */ `
${GLSL_NOISE}
varying vec2 vUv;
uniform vec3 uColor;
uniform float uTime;
uniform float uCore;
uniform float uStrength;

void main(){
  float r = length(vUv);
  if (r > 1.0) discard;
  float ang = atan(vUv.y, vUv.x);

  // Streamers: angular noise that shears with radius.
  float s = fbm(vec2(ang * 2.2 + r * 3.0, r * 2.4 - uTime * 0.03), 4, 2.1, 0.55) * 0.5 + 0.5;
  float streak = mix(0.62, 1.38, s);

  // Three scales. The tight one hugs the photosphere, the wide one is the faint
  // outer halo; keeping the middle term small is what stops the corona reading
  // as a bloom wash across a quarter of the frame.
  float d = max(r - uCore, 0.0);
  float glow = exp(-d * 26.0) * 0.85
             + exp(-d * 7.0) * 0.16 * streak
             + exp(-d * 2.6) * 0.045 * streak;

  // Fade to nothing at the quad edge so the billboard never shows its square.
  glow *= smoothstep(1.0, 0.82, r);
  gl_FragColor = vec4(uColor * glow * uStrength, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Orbit ring. A flat annulus whose alpha is a trailing comet-tail from the
 * planet's current angle, plus a faint continuous line so the full ellipse
 * still reads as a path.
 */
const RING_VERT = /* glsl */ `
varying float vAngle;
varying float vRadial;
void main(){
  vAngle = atan(position.x, position.z);
  vRadial = length(position.xz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ORBIT_RING_FRAG = /* glsl */ `
varying float vAngle;
varying float vRadial;
uniform vec3 uColor;
uniform float uPlanetAngle;
uniform float uRadius;
uniform float uWidth;
uniform float uStrength;

void main(){
  // Distance across the band, 0 at the centre line.
  float across = abs(vRadial - uRadius) / uWidth;
  float band = 1.0 - smoothstep(0.25, 1.0, across);
  // Angle *behind* the planet, wrapped to 0..2pi.
  float d = mod(uPlanetAngle - vAngle + 6.2831853, 6.2831853);
  float tail = exp(-d * 3.4);
  float alpha = band * (0.12 + 1.15 * tail);
  gl_FragColor = vec4(uColor * alpha * uStrength, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * A planetary ring system: radial banding with gaps, lit by the star, with a
 * back-scatter term so the far side of the ring glows when you look through it
 * toward the star.
 */
const PLANET_RING_FRAG = /* glsl */ `
${GLSL_NOISE}
varying float vAngle;
varying float vRadial;
varying vec3 vWorldP;
uniform vec3 uColor;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uInner;
uniform float uOuter;
uniform float uOpacity;

void main(){
  float t = clamp((vRadial - uInner) / max(uOuter - uInner, 1e-3), 0.0, 1.0);
  // Banding: several frequencies of ridged 1D noise, plus a hard division.
  float b = fbm(vec2(t * 34.0, 0.5), 4, 2.2, 0.55) * 0.5 + 0.5;
  float fine = fbm(vec2(t * 120.0, 3.5), 3, 2.1, 0.5) * 0.5 + 0.5;
  float density = clamp(b * 0.75 + fine * 0.35, 0.0, 1.0);
  density *= smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.86, 1.0, t));
  // The division: a real gap, not a fade.
  density *= 1.0 - 0.92 * exp(-pow((t - 0.46) / 0.045, 2.0));

  vec3 V = normalize(cameraPosition - vWorldP);
  vec3 L = normalize(uLightDir);
  float back = pow(max(dot(-V, L), 0.0), 3.0);
  vec3 col = uColor * uLightColor * (0.55 + 1.6 * back);
  gl_FragColor = vec4(col * density * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const PLANET_RING_VERT = /* glsl */ `
varying float vAngle;
varying float vRadial;
varying vec3 vWorldP;
void main(){
  vAngle = atan(position.x, position.z);
  vRadial = length(position.xz);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** Drifting debris close to the ship — the only real parallax cue in vacuum. */
const DUST_VERT = /* glsl */ `
attribute float aSeed;
varying float vFade;
uniform float uPixelScale;
uniform vec3 uCentre;
uniform float uExtent;

void main(){
  // The mote is anchored in world space; this folds it into the 2E box centred
  // on the ship, so a fixed point count covers any distance travelled with no
  // CPU-side respawning and full parallax against the stars.
  vec3 p = mod(position - uCentre + uExtent, uExtent * 2.0) - uExtent;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = length(mv.xyz);
  vFade = smoothstep(2.0, 9.0, d) * (1.0 - smoothstep(uExtent * 0.5, uExtent, d));
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((1.1 + aSeed * 1.6) * uPixelScale * 26.0 / max(d, 1.0), 1.0, 4.5);
}
`;

const DUST_FRAG = /* glsl */ `
varying float vFade;
uniform vec3 uColor;
uniform float uStrength;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.06, length(d));
  gl_FragColor = vec4(uColor * a * vFade * uStrength, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// A world in orbit
// ---------------------------------------------------------------------------

class Globe {
  readonly descriptor: PlanetDescriptor;
  readonly art: GlobeArt;
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly radius: number;
  readonly orbitRadius: number;

  /** Orbit basis: `sin(a) * x + cos(a) * z`, so `atan2(x, z)` recovers `a`. */
  private readonly bx = new THREE.Vector3(1, 0, 0);
  private readonly by = new THREE.Vector3(0, 1, 0);
  private readonly bz = new THREE.Vector3(0, 0, 1);

  private readonly globe: THREE.Mesh;
  private readonly shell: THREE.Mesh;
  private readonly ring: THREE.Mesh | null;
  private readonly orbitLine: THREE.Mesh;
  private readonly globeMat: THREE.ShaderMaterial;
  private readonly shellMat: THREE.ShaderMaterial;
  private readonly ringMat: THREE.ShaderMaterial | null;
  private readonly orbitMat: THREE.ShaderMaterial;
  private readonly owned: Array<{ dispose(): void }> = [];

  angle = 0;

  constructor(descriptor: PlanetDescriptor, quality: 'low' | 'high') {
    this.descriptor = descriptor;
    this.art = GLOBE_ART[descriptor.id];
    this.radius = descriptor.radius * GLOBE_SCALE;
    this.orbitRadius = descriptor.orbitRadius * SPACE_SCALE;
    this.angle = this.art.phase;

    const tilt = _q.setFromAxisAngle(
      _v1.set(Math.cos(this.art.node), 0, Math.sin(this.art.node)),
      this.art.inclination,
    );
    this.bx.set(1, 0, 0).applyQuaternion(tilt);
    this.by.set(0, 1, 0).applyQuaternion(tilt);
    this.bz.set(0, 0, 1).applyQuaternion(tilt);

    const segs = quality === 'high' ? 96 : 64;
    const rings = quality === 'high' ? 64 : 40;

    // -- the body ------------------------------------------------------------
    const geo = this.own(new THREE.SphereGeometry(this.radius, segs, rings));
    const surface = linearRgb(descriptor.color);
    const secondary = linearRgb(this.art.secondary);
    const atmo = linearRgb(descriptor.atmosphereColor);
    this.globeMat = this.own(
      new THREE.ShaderMaterial({
        uniforms: {
          uLightDir: { value: new THREE.Vector3(0, 0, 1) },
          uLightColor: { value: new THREE.Vector3(0.40, 0.378, 0.350) },
          uColorA: { value: surface },
          uColorB: { value: secondary },
          uAtmo: { value: atmo.clone().multiplyScalar(0.5) },
          uNight: { value: linearRgb(this.art.nightColor) },
          uCloudCol: { value: linearRgb(this.art.cloudColor) },
          uAmbient: { value: new THREE.Vector3(0.012, 0.013, 0.02) },
          uCloud: { value: this.art.cloud },
          uNightStrength: { value: this.art.nightStrength * 0.085 },
          uTime: { value: 0 },
          uStyle: { value: this.art.style },
          uSeed: { value: (descriptor.orbitRadius % 7) * 3.7 },
        },
        vertexShader: GLOBE_VERT,
        fragmentShader: GLOBE_FRAG,
      }),
    );
    this.group.name = `globe:${descriptor.id}`;
    this.globe = new THREE.Mesh(geo, this.globeMat);
    this.globe.rotation.z = this.art.tilt;
    this.globe.frustumCulled = false;
    this.group.add(this.globe);

    // -- atmosphere shell ----------------------------------------------------
    const shellGeo = this.own(new THREE.SphereGeometry(this.radius * 1.045, 48, 32));
    this.shellMat = this.own(
      new THREE.ShaderMaterial({
        uniforms: {
          uLightDir: { value: new THREE.Vector3(0, 0, 1) },
          uAtmo: { value: atmo.clone().multiplyScalar(0.085) },
          uSunset: { value: linearRgb(descriptor.color, 0.2) },
          uStrength: { value: 1 },
        },
        vertexShader: ATMO_VERT,
        fragmentShader: ATMO_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    );
    this.shell = new THREE.Mesh(shellGeo, this.shellMat);
    this.shell.renderOrder = 4;
    this.shell.frustumCulled = false;
    this.group.add(this.shell);

    // -- ring system ---------------------------------------------------------
    if (this.art.ring) {
      const inner = this.radius * this.art.ring.inner;
      const outer = this.radius * this.art.ring.outer;
      const ringGeo = this.own(new THREE.RingGeometry(inner, outer, 128, 2));
      ringGeo.rotateX(-Math.PI / 2);
      this.ringMat = this.own(
        new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: linearRgb(this.art.ring.color) },
            uLightDir: { value: new THREE.Vector3(0, 0, 1) },
            uLightColor: { value: new THREE.Vector3(0.3, 0.285, 0.264) },
            uInner: { value: inner },
            uOuter: { value: outer },
            uOpacity: { value: this.art.ring.opacity },
          },
          vertexShader: PLANET_RING_VERT,
          fragmentShader: PLANET_RING_FRAG,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      this.ring = new THREE.Mesh(ringGeo, this.ringMat);
      this.ring.rotation.z = this.art.tilt;
      this.ring.renderOrder = 3;
      this.ring.frustumCulled = false;
      this.group.add(this.ring);
    } else {
      this.ring = null;
      this.ringMat = null;
    }

    // -- orbit path ----------------------------------------------------------
    // Width scales with radius so the line holds roughly the same apparent
    // thickness whether it is the inner orbit or the outer one.
    const width = 2.2 + this.orbitRadius * 0.0022;
    const orbitGeo = this.own(
      new THREE.RingGeometry(this.orbitRadius - width, this.orbitRadius + width, 220, 1),
    );
    orbitGeo.rotateX(-Math.PI / 2);
    this.orbitMat = this.own(
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: linearRgb(descriptor.atmosphereColor) },
          uPlanetAngle: { value: this.angle },
          uRadius: { value: this.orbitRadius },
          uWidth: { value: width },
          uStrength: { value: 0.026 },
        },
        vertexShader: RING_VERT,
        fragmentShader: ORBIT_RING_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.orbitLine = new THREE.Mesh(orbitGeo, this.orbitMat);
    _basis.makeBasis(this.bx, this.by, this.bz);
    this.orbitLine.quaternion.setFromRotationMatrix(_basis);
    this.orbitLine.renderOrder = 2;
    this.orbitLine.frustumCulled = false;
  }

  private own<T extends { dispose(): void }>(x: T): T {
    this.owned.push(x);
    return x;
  }

  /** Add the body and its orbit path to a scene. */
  attach(scene: THREE.Scene): void {
    scene.add(this.group);
    scene.add(this.orbitLine);
  }

  update(elapsed: number): void {
    this.angle = this.art.phase + this.descriptor.orbitSpeed * ORBIT_RATE * elapsed;
    const r = this.orbitRadius;
    const s = Math.sin(this.angle);
    const c = Math.cos(this.angle);
    this.position.set(
      this.bx.x * s * r + this.bz.x * c * r,
      this.bx.y * s * r + this.bz.y * c * r,
      this.bx.z * s * r + this.bz.z * c * r,
    );
    this.group.position.copy(this.position);
    this.globe.rotation.y = elapsed * this.art.spin;

    // Toward the star, which is the origin.
    _v2.copy(this.position).negate().normalize();
    (this.globeMat.uniforms.uLightDir.value as THREE.Vector3).copy(_v2);
    (this.shellMat.uniforms.uLightDir.value as THREE.Vector3).copy(_v2);
    this.globeMat.uniforms.uTime.value = elapsed;
    this.orbitMat.uniforms.uPlanetAngle.value = this.angle;
    if (this.ringMat) (this.ringMat.uniforms.uLightDir.value as THREE.Vector3).copy(_v2);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.orbitLine.removeFromParent();
    this.group.clear();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }
}

// ---------------------------------------------------------------------------
// The level
// ---------------------------------------------------------------------------

class OrbitalLevel implements Level {
  readonly id = 'starmap';
  readonly scene = new THREE.Scene();
  readonly collision = new VacuumSpace();
  readonly sunDirection = new THREE.Vector3(0, 0, 1);
  /**
   * Near-black on purpose.
   *
   * `PostFX` floors the volumetric medium at density 0.004 even when a level
   * installs no fog (`VolumetricPass.density = max(0.004, fogDensity * 2.6)`),
   * so the god-ray march runs in hard vacuum and paints a broad glow along
   * `sunDirection`, tinted with this colour, over the whole frame. At a
   * sunlit-white value that glow washed out half the star map and buried the
   * value structure. Dropping the tint to a twentieth leaves a faint, honest
   * bloom around the star and nothing anywhere else. See the report: the floor
   * belongs behind a "does this level have a medium at all" test.
   */
  readonly sunColor = new THREE.Color(0.06, 0.057, 0.052);
  readonly fogColor = new THREE.Color(0.01, 0.012, 0.02);
  /** Consumed by `AiDirector.bindLevel` if anything ever binds here. */
  readonly navRadius = 40;

  private readonly engine: Engine;
  private readonly materials: MaterialLibrary;
  private readonly globes: Globe[] = [];
  private sky!: SkyDome;
  private star!: THREE.Mesh;
  private starMat!: THREE.ShaderMaterial;
  private corona: THREE.Mesh[] = [];
  private coronaMats: THREE.ShaderMaterial[] = [];
  private starLight!: THREE.PointLight;
  private dust!: THREE.Points;
  private dustMat!: THREE.ShaderMaterial;
  private bracket!: THREE.Mesh;
  private bracketMat!: THREE.ShaderMaterial;

  private readonly spawn = new THREE.Vector3();
  private readonly spawnLook = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private ship: Ship | null = null;
  private readonly envSunDir = new THREE.Vector3(0, 0, 1);
  private envTimer = 0;
  private travelling = false;
  private readonly unsubs: Array<() => void> = [];
  private readonly owned: Array<{ dispose(): void }> = [];
  private disposed = false;
  private bracketScale = 0;

  constructor(engine: Engine, materials: MaterialLibrary) {
    this.engine = engine;
    this.materials = materials;
    this.scene.name = 'starmap';
  }

  private own<T extends { dispose(): void }>(x: T): T {
    this.owned.push(x);
    return x;
  }

  async load(onProgress?: (t: number, label: string) => void): Promise<void> {
    onProgress?.(0.05, 'Charting the Reach');

    // -- deep space ----------------------------------------------------------
    // The orbit profile draws its own star at a fixed direction; this level has
    // a real one at the origin, so the backdrop's is switched off by zeroing the
    // disc brightness before the layer resolves it.
    const profile = cloneAtmosphere(ATMOSPHERES.orbit);
    profile.sunDiscBrightness = 0;
    profile.sunDisc = false;
    // Auto-exposure pins at its 5.5x ceiling in a frame this dark, so the
    // backdrop's authored radiance arrives five times hotter than it reads on a
    // planet surface: at full weight the nebula out-valued every globe in the
    // system and the frame became lilac fog with objects in it. Half weight puts
    // the dust back behind the subjects where it belongs.
    profile.space = 0.34;
    profile.milkyWay = 0.18;
    profile.starDensity = 1.45;
    this.sky = new SkyDome(profile);
    this.sky.attach(this.scene);
    // Nothing in vacuum casts a directional shadow; the star's point light is
    // the key. Leaving the dome's sun on would double-light the ship and pay for
    // a shadow map that renders nothing.
    this.sky.sun.intensity = 0;
    this.sky.sun.castShadow = false;
    this.sky.ambient.intensity = 0.10;

    // Metal needs something to reflect or the hull reads as painted clay. A
    // near-black environment with one small hot source is exactly what a ship in
    // vacuum sees.
    // The Kestrel's hull is metalness 1 at low roughness — a mirror. Give a
    // mirror a *punctual* light and the GGX peak runs to four figures, so a
    // curved canopy rib smears a clipped white streak down its whole length and
    // crawls with it at the medium tier's TAA-off sampling: the canopy frame
    // reads as television static and out-values every planet in the system.
    //
    // So there is no punctual light out here at all. The star lives in the
    // environment map instead, as a broad prefiltered disc, which is both the
    // physically honest answer for a body 1.7 km away and the one that gives a
    // smooth swept highlight rather than an aliasing streak.
    this.refreshEnvironment(true);

    await this.yield();
    onProgress?.(0.3, 'Lighting the primary');
    this.buildStar();

    await this.yield();
    onProgress?.(0.5, 'Placing the worlds');
    const quality = settings.profile.tier === 'low' ? 'low' : 'high';
    for (const d of PLANETS) {
      const g = new Globe(d, quality);
      g.update(0);
      g.attach(this.scene);
      this.globes.push(g);
    }

    await this.yield();
    onProgress?.(0.75, 'Trimming the drift');
    this.buildDust();
    this.buildBracket();

    // -- opening composition -------------------------------------------------
    // Framed from the actual geometry rather than hand-placed numbers, so it
    // stays correct if the orbit table changes: the ship sits off the outermost
    // world's shoulder, high and outward, with the look direction split between
    // the planet and the star. Both land roughly on the thirds of the frame.
    const hero = this.globes[this.globes.length - 1];
    const up = new THREE.Vector3(0, 1, 0);
    const outward = hero.position.clone().normalize();
    const side = new THREE.Vector3().crossVectors(outward, up).normalize();
    this.spawn
      .copy(hero.position)
      .addScaledVector(side, hero.radius * 3.3)
      .addScaledVector(up, hero.radius * 2.1)
      .addScaledVector(outward, hero.radius * 3.4);
    const toPlanet = hero.position.clone().sub(this.spawn).normalize();
    const toStar = this.spawn.clone().negate().normalize();
    this.spawnLook
      .copy(toPlanet)
      .multiplyScalar(0.58)
      .addScaledVector(toStar, 0.42)
      .normalize()
      .multiplyScalar(400)
      .add(this.spawn);
    this.camPos.copy(this.spawn);

    // God rays and the volumetric phase read this once, at level change.
    this.sunDirection.copy(toStar);

    // -- the ship ------------------------------------------------------------
    this.ship = this.engine.get<Ship>('ship') ?? null;
    if (this.ship) {
      this.ship.attach(this.scene);
      this.ship.teleport(this.spawn, this.spawnLook);
      this.ship.landingTarget = null;
    }
    shipHolder = this;
    events.emit('ship:enter');

    // The UI's SET COURSE button and the ship's interact key are the same
    // action; both land here.
    const ui = this.engine.get<UiTravelHost>('ui');
    if (ui) ui.onTravel = (id: PlanetId) => void this.beginTravel(id);
    this.unsubs.push(
      events.on('ship:travelStarted', (p) => void this.beginTravel(p.to)),
    );

    events.emit('ui:toast', {
      text: 'THE OPHIUCHUS REACH',
      sub: 'Five charted worlds · Federation Vanguard',
      duration: 5,
    });

    onProgress?.(1, 'In orbit');
  }

  /**
   * Re-integrate the IBL for where the ship actually is.
   *
   * The environment is a baked cube: it holds one star direction. Fly to the far
   * side of the system and that direction is 180 degrees wrong, and the hull is
   * lit from the wrong side of the frame. Rebuilding whenever the true bearing
   * has drifted more than ~20 degrees costs one PMREM pass every few seconds of
   * hard burn and nothing at all when parked.
   */
  private refreshEnvironment(force: boolean): void {
    _v1.copy(this.camPos).negate();
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, 1);
    _v1.normalize();
    if (!force && _v1.dot(this.envSunDir) > 0.94) return;
    this.envSunDir.copy(_v1);
    this.materials.rebuildEnvironment({
      zenith: 0x0d1020,
      horizon: 0x0e1220,
      ground: 0x030308,
      sunColor: 0xffeeda,
      sunDirection: this.envSunDir.clone(),
      // Broad, prefiltered, and *below the clip point*. Exposure sits at its
      // 5.5x ceiling in a frame this dark, so anything over ~0.45 linear in the
      // environment comes back off a mirror as clipped white: 0.12 with a wide
      // disc puts the reflected star at a readable grey-gold sweep along the
      // canopy ribs, and leaves the cockpit the dark frame the composition wants.
      sunSize: 0.75,
      sunIntensity: 0.12,
      turbidity: 0.1,
    });
    this.scene.environment = this.materials.environment;
  }

  /** One frame of breathing room so the loading bar animates during a build. */
  private yield(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  // -- construction ---------------------------------------------------------

  private buildStar(): void {
    const geo = this.own(new THREE.SphereGeometry(STAR_RADIUS, 96, 64));
    this.starMat = this.own(
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: linearRgb(0xfff0d2) },
          uRim: { value: linearRgb(0xffb469) },
          uTime: { value: 0 },
          uBrightness: { value: 1.05 },
        },
        vertexShader: GLOBE_VERT,
        fragmentShader: STAR_FRAG,
      }),
    );
    this.star = new THREE.Mesh(geo, this.starMat);
    this.star.frustumCulled = false;
    this.scene.add(this.star);

    // Two corona quads at different scales and strengths. Both billboard to the
    // camera in render(); they are additive and depth-tested so a planet passing
    // in front of the star correctly occludes the inner one.
    // Tight. A wide corona at any strength that survives the exposure ceiling
    // puts a bloom wash across a quarter of the frame, which is an automatic
    // fail — and it also swallows the limb, which is the only thing that makes
    // the star read as a body rather than a light.
    const scales = [2.6, 6.0];
    const strengths = [0.58, 0.11];
    const cores = [0.38, 0.13];
    for (let i = 0; i < scales.length; i++) {
      const q = this.own(new THREE.PlaneGeometry(STAR_RADIUS * 2 * scales[i], STAR_RADIUS * 2 * scales[i]));
      const m = this.own(
        new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: linearRgb(i === 0 ? 0xffd9a0 : 0xffa860) },
            uTime: { value: 0 },
            uCore: { value: cores[i] },
            uStrength: { value: strengths[i] },
          },
          vertexShader: CORONA_VERT,
          fragmentShader: CORONA_FRAG,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: i === 0,
        }),
      );
      const mesh = new THREE.Mesh(q, m);
      mesh.renderOrder = 1 + i;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.corona.push(mesh);
      this.coronaMats.push(m);
    }

    // A token fill so the hull's dielectric trim is not literally black, at a
    // level far below where its specular lobe can clip. Everything that reads as
    // "lit by the star" comes from the environment map.
    this.starLight = new THREE.PointLight(0xfff1e0, 0.06, 0, 0);
    this.starLight.castShadow = false;
    this.scene.add(this.starLight);
  }

  private buildDust(): void {
    const count = settings.profile.tier === 'low' ? 400 : 900;
    const extent = 90;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const rng = new Rng(0x5ee5);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-extent, extent);
      pos[i * 3 + 1] = rng.range(-extent, extent);
      pos[i * 3 + 2] = rng.range(-extent, extent);
      seed[i] = rng.next();
    }
    const geo = this.own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.dustMat = this.own(
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: linearRgb(0xbfd4ff) },
          uStrength: { value: 0.5 },
          uPixelScale: { value: 1 },
          uCentre: { value: new THREE.Vector3() },
          uExtent: { value: extent },
        },
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 6;
    this.scene.add(this.dust);
  }

  private buildBracket(): void {
    // Four corner arcs, drawn as a single billboarded quad in the shader. A
    // targeting reticle around the world you are cleared to land on.
    const geo = this.own(new THREE.PlaneGeometry(2, 2));
    this.bracketMat = this.own(
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: linearRgb(0x7fe8ff) },
          uStrength: { value: 0 },
          uTime: { value: 0 },
        },
        vertexShader: CORONA_VERT,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          uniform vec3 uColor;
          uniform float uStrength;
          uniform float uTime;
          void main(){
            // Four L-shaped corners of a square: the square's edge band, kept
            // only where both axes are near the limit. Polar arcs were tried
            // first and read as four blurred crosses — a bracket is a *corner*.
            vec2 a = abs(vUv);
            float m = max(a.x, a.y);
            float band = smoothstep(0.985, 0.968, m) - smoothstep(0.952, 0.935, m);
            float corner = smoothstep(0.52, 0.60, min(a.x, a.y));
            float pulse = 0.72 + 0.28 * sin(uTime * 2.4);
            float alpha = band * corner * pulse;
            if (alpha <= 0.002) discard;
            gl_FragColor = vec4(uColor * alpha * uStrength, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.bracket = new THREE.Mesh(geo, this.bracketMat);
    this.bracket.visible = false;
    this.bracket.frustumCulled = false;
    this.bracket.renderOrder = 8;
    this.scene.add(this.bracket);
  }

  // -- frame ----------------------------------------------------------------

  update(ctx: FrameContext): void {
    const t = ctx.elapsed;
    for (const g of this.globes) g.update(t);
    this.starMat.uniforms.uTime.value = t;
    for (const m of this.coronaMats) m.uniforms.uTime.value = t;
    this.bracketMat.uniforms.uTime.value = t;

    const ship = this.ship;
    if (ship) {
      // Soft boundary: rather than a wall, the far edge of the system bleeds
      // outward velocity so the ship always curves back into play.
      const d = ship.position.length();
      if (d > FLIGHT_BOUNDS) {
        const over = clamp01((d - FLIGHT_BOUNDS) / 260);
        _v1.copy(ship.position).multiplyScalar(1 / Math.max(d, 1e-3));
        const radial = ship.velocity.dot(_v1);
        if (radial > 0) ship.velocity.addScaledVector(_v1, -radial * over * 0.06);
        if (d > FLIGHT_BOUNDS + 260) ship.position.setLength(FLIGHT_BOUNDS + 260);
      }

      // Landing clearance for the nearest world in range.
      let best: Globe | null = null;
      let bestDist = Infinity;
      for (const g of this.globes) {
        const dist = ship.position.distanceTo(g.position) - g.radius;
        if (dist < g.radius * LANDING_RADII && dist < bestDist) {
          bestDist = dist;
          best = g;
        }
      }
      if (best) {
        ship.landingTarget = {
          id: best.descriptor.id,
          name: best.descriptor.displayName,
          distance: Math.max(bestDist, 0),
        };
      } else {
        ship.landingTarget = null;
      }
      this.bracketScale = best ? best.radius * 1.32 : 0;
      if (best) this.bracket.position.copy(best.position);
      this.bracket.visible = !!best;
      this.bracketMat.uniforms.uStrength.value = best ? 0.32 : 0;

      this.dustMat.uniforms.uStrength.value = 0.28 + clamp01(ship.speed / 260) * 0.9;
    }

    // Everything that follows the camera. The engine only drives `update` on a
    // level, so this lives here rather than in a render hook; at 120 Hz it is a
    // handful of quaternion copies.
    const cam = this.engine.host.camera;
    cam.getWorldPosition(this.camPos);
    this.sky.update(t, this.camPos);

    this.envTimer -= ctx.dt;
    if (this.envTimer <= 0) {
      this.envTimer = 3;
      this.refreshEnvironment(false);
    }

    for (const c of this.corona) c.quaternion.copy(cam.quaternion);
    if (this.bracket.visible) {
      this.bracket.quaternion.copy(cam.quaternion);
      this.bracket.scale.setScalar(this.bracketScale);
    }
    (this.dustMat.uniforms.uCentre.value as THREE.Vector3).copy(this.camPos);
    this.dust.position.copy(this.camPos);
    this.dustMat.uniforms.uPixelScale.value = clamp(
      window.devicePixelRatio || 1,
      0.5,
      settings.profile.maxPixelRatio,
    );
  }

  getSpawnPoint(): { position: THREE.Vector3; yaw: number } {
    return { position: this.spawn.clone(), yaw: 0 };
  }

  private async beginTravel(to: PlanetId): Promise<void> {
    if (this.travelling || this.disposed) return;
    this.travelling = true;
    // Dynamic so the static import graph stays `world -> core`; `Game` already
    // imports this module and a static edge back would close the cycle.
    const { game } = await import('@/core/Game');
    await game().travelTo(to);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (shipHolder === this) {
      shipHolder = null;
      events.emit('ship:exit');
    }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    const ui = this.engine.get<UiTravelHost>('ui');
    if (ui) ui.onTravel = null;
    if (this.ship && shipHolder === null) {
      // Only if no incoming orbital level has claimed the ship: `load()` on the
      // next map runs before this `dispose()`, and yanking the root out of the
      // scene it was just added to is how the cockpit vanished the first time.
      this.ship.landingTarget = null;
      this.ship.root.removeFromParent();
    }
    for (const g of this.globes) g.dispose();
    this.globes.length = 0;
    this.sky?.dispose();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
    this.scene.clear();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Factory + owner for the orbital level. `Game` constructs one of these at boot
 * and calls `createLevel()` every time the player returns to orbit.
 */
export class StarMap {
  private readonly engine: Engine;
  private readonly materials: MaterialLibrary;
  private current: OrbitalLevel | null = null;

  constructor(engine: Engine, materials: MaterialLibrary) {
    this.engine = engine;
    this.materials = materials;
  }

  /** A fresh orbital level. The engine disposes the previous one for us. */
  createLevel(): Level {
    const level = new OrbitalLevel(this.engine, this.materials);
    this.current = level;
    return level;
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
  }
}
