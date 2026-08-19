/**
 * HeightField — the analytic terrain surface.
 *
 * Everything about a planet's shape lives in one pure function of (x, z). No
 * heightmap textures, no baked meshes, no streaming: collision, AI placement,
 * scatter density, water depth and the GPU displacement all read the *same*
 * closed-form field. That is what makes collision exact and free.
 *
 * ## The CPU/GPU contract
 *
 * `TERRAIN_GLSL` below and the TypeScript in this file are two transcriptions of
 * one algorithm. They must agree to within float32 rounding, because the mesh
 * you see is displaced by the GLSL while the capsule you walk with is resolved
 * against the TypeScript. Two things make that agreement possible:
 *
 * 1. **Bit-identical hashing.** WebGL2 gives us real 32-bit `uint` arithmetic, so
 *    the lattice hash is the same integer mix on both sides (`Math.imul` +
 *    `>>>` mirrors `uint` multiply + shift exactly). No `fract(sin(...))`, whose
 *    result depends on the driver's `sin`.
 * 2. **Bit-identical gradients.** The gradient table is built once in JS,
 *    rounded through `Math.fround`, and uploaded as a `vec2[64]` uniform. Both
 *    sides therefore index the same float32 values instead of each computing
 *    their own `cos`/`sin`.
 *
 * What is left is float32-vs-float64 accumulation, which measures at well under
 * a millimetre over a 200 m relief (see `measureDivergence` in the harness).
 * Every step of the field is also continuous — Perlin gradient noise is zero at
 * its lattice points, the terrace riser is C0 at the step, the dune profile
 * meets at its crest — so a rounding difference can never produce a cliff.
 *
 * EDIT THE GLSL AND THE TS TOGETHER. They are marked with matching section
 * comments; a change to one without the other is a bug that shows up as the
 * player sinking into a hillside.
 */
import * as THREE from 'three';
import type { SurfaceMaterialName } from '@/gfx/materials/SurfaceMaterials';
import { clamp } from '@/util/math';

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/** One of the four blended ground layers. */
export interface TerrainLayerSpec {
  surface: SurfaceMaterialName;
  /** World metres covered by one texture repeat. */
  tileMetres: number;
  /**
   * sRGB hex. At `desaturate` 0 this multiplies the sampled albedo; at 1 it
   * *becomes* the albedo, with the texture contributing only its luminance
   * contrast. Multiplication alone cannot turn a warm sand texture into cold
   * snow, which is why the second mode exists.
   */
  tint: number;
  /** 0 = tint by multiply, 1 = full luminance recolour. */
  desaturate: number;
  /** Multiplier on the sampled roughness. */
  roughness: number;
  metalness: number;
  /** Detail-normal strength. */
  normalStrength: number;
  /** Slope window, radians. The layer fades in at `slopeLo`, out at `slopeHi`. */
  slopeLo: number;
  slopeHi: number;
  /** Height window, metres. */
  heightLo: number;
  heightHi: number;
  /** Transition half-width: radians for slope, ×8 metres for height. */
  softness: number;
  /**
   * Constant added to the mask before the contrast exponent. Layers 1..3 paint
   * *over* layer 0, so a small bias gives a layer a faint presence everywhere
   * rather than making it dominate. Layer 0's mask is ignored entirely.
   */
  bias: number;
  /**
   * How far the mask thresholds are pushed around by the breakup noise. This is
   * what stops the four layers meeting on smooth contour lines.
   */
  breakup: number;
  /** Sample on all three world axes. Only worth it for cliff strata. */
  triplanar: boolean;
}

export interface TerrainCliffSpec {
  /** Slope above which real cliff geometry is generated, radians. */
  slopeThreshold: number;
  /** Candidate sites per 100 m × 100 m of terrain. */
  sitesPerHectare: number;
  /** Maximum number of cliff faces actually built. */
  maxFaces: number;
  minHeight: number;
  maxHeight: number;
  minWidth: number;
  maxWidth: number;
  /** How far the top lip juts out past the base, metres. */
  overhang: number;
  /** Depth of the horizontal strata cut into the face, metres. */
  strata: number;
  surface: SurfaceMaterialName;
  /** Metres per texture repeat on cliff faces. */
  tileMetres: number;
  tint: number;
  /** 0 = tint by multiply, 1 = full luminance recolour (see TerrainLayerSpec). */
  tintDesaturate: number;
  /** Only generate within this radius of the origin. */
  radius: number;
}

export type RockKind = 'boulder' | 'slab' | 'spire' | 'arch' | 'scree';

export interface TerrainRockEntry {
  kind: RockKind;
  /** Instances per 100 m × 100 m at density 1. */
  perHectare: number;
  minScale: number;
  maxScale: number;
  maxSlope: number;
  heightLo: number;
  heightHi: number;
  /** 0 = always upright, 1 = fully aligned to the ground normal. */
  alignToNormal: number;
  tintA: number;
  tintB: number;
  /** Cull distance, metres. */
  distance: number;
  castShadow: boolean;
  /** Register as a BVH collider (boulders/spires/arches yes, scree no). */
  collide: boolean;
  /** Distinct meshes generated for this entry. */
  variants: number;
}

export interface TerrainRockSpec {
  surface: SurfaceMaterialName;
  tileMetres: number;
  entries: TerrainRockEntry[];
  /** Radius within which rocks are placed. */
  radius: number;
}

export type FloraKind =
  | 'grass'
  | 'fern'
  | 'bush'
  | 'tree'
  | 'fungus'
  | 'crystal'
  | 'reed';

export interface TerrainFloraEntry {
  kind: FloraKind;
  /** Instances per square metre at `foliageDensity` 1. */
  density: number;
  minScale: number;
  maxScale: number;
  maxSlope: number;
  heightLo: number;
  heightHi: number;
  /** Moisture window, 0..1. Moisture rises near water and in concavities. */
  moistureLo: number;
  moistureHi: number;
  /** Base and tip tints, sRGB hex. */
  tintA: number;
  tintB: number;
  /** Wind response. 0 = rigid (crystals), 1 = grass. */
  stiffness: number;
  /** Cull distance, metres. */
  distance: number;
  /** Inside this radius the detailed prototype is used and casts shadows. */
  nearDistance: number;
  alignToNormal: number;
  castShadow: boolean;
  variants: number;
  /** Emissive colour for hive fungus / ice crystal, 0 = none. */
  emissive: number;
  emissiveIntensity: number;
}

export interface TerrainFloraSpec {
  entries: TerrainFloraEntry[];
  /** Wind heading, radians. */
  windDirection: number;
  /** Peak sway in metres at the tip of a 1 m plant. */
  windStrength: number;
  /** Wavelength of the coherent gust field, metres. */
  gustScale: number;
  /** Gust travel speed, m/s. */
  gustSpeed: number;
}

export interface TerrainWaterSpec {
  /** World Y of the surface, metres. */
  level: number;
  /** Shallow and deep body colours, sRGB hex. */
  shallow: number;
  deep: number;
  /** Foam colour. */
  foam: number;
  /** Metres of water at which the deep colour is fully reached. */
  absorption: number;
  /** Depth below which shoreline foam appears, metres. */
  foamDepth: number;
  /** Ripple size in metres and scroll speed in m/s. */
  waveScale: number;
  waveSpeed: number;
  waveHeight: number;
  /** Index-of-refraction-ish fresnel bias, 0.02 = water, higher = lava crust. */
  fresnel: number;
  /** Sun glint tightness. */
  glossiness: number;
  /** Set for lava: the body emits light instead of reflecting the sky. */
  emissive: number;
  emissiveIntensity: number;
  /** Half-extent of the water mesh, metres. */
  extent: number;
}

export interface TerrainDescriptor {
  id: string;
  seed: number;
  /** Half-extent of the authored region, metres. Bounds and scatter use it. */
  extent: number;
  /** How far terrain geometry reaches, metres. Drives the clipmap ring count. */
  viewDistance: number;
  /** Metres per unit of the base noise lattice. Bigger = broader landforms. */
  featureMetres: number;
  /** Relative frequency of the continental mask. */
  continentScale: number;
  /** Domain-warp strength in lattice units. */
  warp: number;
  /** Slope-dependent octave damping. 0 = raw fBm, 2+ = heavily eroded. */
  erosion: number;
  ridgeOctaves: number;
  ridgeLacunarity: number;
  ridgeGain: number;
  /** Valley-deepening exponent on the ridge field. 1 = raw, 2-3 = dramatic. */
  ridgePower: number;
  /** Peak height of the mountain field, metres. */
  mountainAmplitude: number;
  /** Amplitude of the rolling ground, metres. */
  plainAmplitude: number;
  /** 0..1 blend toward stepped mesas. */
  terraceStrength: number;
  /** Height of one terrace step, metres. */
  terraceHeight: number;
  /** Dune ripple height, metres. 0 disables. */
  duneAmplitude: number;
  duneWavelength: number;
  /** Dune crest heading, radians. */
  duneAngle: number;
  /** Radius of the flattened landing basin at the origin, metres. 0 disables. */
  flattenRadius: number;
  flattenHeight: number;
  /** Downward skirt on clipmap ring boundaries, metres. */
  skirtDepth: number;
  /** Exactly four blended layers. */
  layers: TerrainLayerSpec[];
  /** Exponent applied to each overlay mask. Higher = more decisive boundaries. */
  layerContrast: number;
  cliffs: TerrainCliffSpec;
  rocks: TerrainRockSpec;
  flora: TerrainFloraSpec;
  water: TerrainWaterSpec | null;
  castShadow: boolean;
  /** Colour the ground fades toward at distance, helping aerial perspective. */
  distantTint: number;
  distantFadeStart: number;
  distantFadeEnd: number;
}

// ---------------------------------------------------------------------------
// The gradient table — the shared source of truth for both transcriptions
// ---------------------------------------------------------------------------

export const GRADIENT_COUNT = 64;

/**
 * 64 unit directions, each component rounded to float32 so the GPU uniform and
 * the JS array hold bit-identical numbers. Uploaded as `vec2 uGfGrad[64]`.
 */
export const GRADIENT_TABLE: Float32Array = (() => {
  const a = new Float32Array(GRADIENT_COUNT * 2);
  for (let i = 0; i < GRADIENT_COUNT; i++) {
    const th = ((i + 0.5) * Math.PI * 2) / GRADIENT_COUNT;
    a[i * 2] = Math.fround(Math.cos(th));
    a[i * 2 + 1] = Math.fround(Math.sin(th));
  }
  return a;
})();

// ---------------------------------------------------------------------------
// GLSL transcription
// ---------------------------------------------------------------------------

/**
 * Uniform declarations for the terrain field. Included separately from the body
 * so a `ShaderMaterial` can declare them itself while a patched
 * `MeshStandardMaterial` gets them injected.
 */
export const TERRAIN_GLSL_UNIFORMS = /* glsl */ `
uniform float uGfSeed;
uniform float uGfFeature;        // 1 / featureMetres
uniform float uGfContinent;
uniform float uGfWarp;
uniform float uGfErosion;
uniform float uGfMountain;
uniform float uGfPlain;
uniform float uGfRidgeLac;
uniform float uGfRidgeGain;
uniform int   uGfRidgeOct;
uniform float uGfRidgePower;
uniform float uGfTerrace;
uniform float uGfTerraceH;
uniform float uGfDuneAmp;
uniform float uGfDuneWave;
uniform vec2  uGfDuneDir;
uniform float uGfFlatR;
uniform float uGfFlatH;
uniform vec2  uGfGrad[${GRADIENT_COUNT}];
`;

/**
 * The field itself. Mirrors `HeightField.height` line for line.
 *
 * Exposes:
 *   float gfHeight(vec2 world)      — surface Y in metres
 *   float gfLowHeight(vec2 world)   — the smooth base form, for convexity/AO
 *   float gfFbm(vec2, int, float, float, uint)
 */
export const TERRAIN_GLSL_BODY = /* glsl */ `
// -- exact 32-bit integer hash (mirrors Math.imul + >>> on the CPU) ----------
uint gfHash(uint x){
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
uint gfCell(ivec2 i, uint s){
  return gfHash(uint(i.x) * 0x27d4eb2fu ^ uint(i.y) * 0x9e3779b1u ^ s);
}
vec2 gfGrad(ivec2 i, uint s){ return uGfGrad[gfCell(i, s) >> 26u]; }

// -- Perlin gradient noise with analytic derivative (value, d/dx, d/dy) ------
// Gradient noise, not value noise: the field is exactly 0 at every lattice
// point, so a float32-vs-float64 disagreement about which cell a sample falls
// in cannot produce a discontinuity.
vec3 gfNoiseD(vec2 p, uint s){
  vec2 fl = floor(p);
  ivec2 i = ivec2(fl);
  vec2 f = p - fl;
  vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = gfGrad(i,               s);
  vec2 gb = gfGrad(i + ivec2(1, 0), s);
  vec2 gc = gfGrad(i + ivec2(0, 1), s);
  vec2 gd = gfGrad(i + ivec2(1, 1), s);
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  float k1 = vb - va;
  float k2 = vc - va;
  float k3 = va - vb - vc + vd;
  float v = va + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);
  return vec3(v, d);
}

float gfFbm(vec2 p, int oct, float lac, float gain, uint s){
  float sum = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  for(int i = 0; i < 8; i++){
    if(i >= oct) break;
    sum  += amp * gfNoiseD(p * freq, s + uint(i) * 77u).x;
    norm += amp;
    amp  *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/**
 * Eroded ridged multifractal. Each octave's amplitude is divided down by the
 * accumulated slope of the octaves above it, so detail collects in the flats and
 * thins out on the faces. That single term is what turns "ridged fBm" — which
 * reads as crumpled paper — into something with valleys, spurs and drainage.
 */
float gfRidge(vec2 p, int oct, float lac, float gain, float ero, uint s){
  float sum = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  vec2 dsum = vec2(0.0);
  for(int i = 0; i < 10; i++){
    if(i >= oct) break;
    vec3 n = gfNoiseD(p * freq, s + uint(i) * 131u);
    float r  = 1.0 - abs(n.x);
    vec2  dr = -sign(n.x) * n.yz * freq;
    float damp = amp / (1.0 + ero * dot(dsum, dsum));
    sum  += damp * r * r;
    norm += damp;
    dsum += damp * 2.0 * r * dr;
    amp  *= gain;
    freq *= lac;
  }
  return (sum / norm) * 2.0 - 1.0;
}

/** The smooth base form: continents plus rolling ground, no ridges. */
float gfLowHeight(vec2 world){
  uint s = uint(uGfSeed);
  vec2 q = world * uGfFeature;
  float cont = gfFbm(q * uGfContinent, 3, 2.03, 0.5, s + 11u);
  float plain = gfFbm(q * 1.9, 3, 2.11, 0.5, s + 71u);
  return plain * uGfPlain + smoothstep(-0.42, 0.26, cont) * uGfMountain * 0.26;
}

float gfHeight(vec2 world){
  uint s = uint(uGfSeed);
  vec2 q = world * uGfFeature;

  // 1. continental mask — decides *where* mountains are allowed to exist.
  float cont = gfFbm(q * uGfContinent, 3, 2.03, 0.5, s + 11u);
  float mask = smoothstep(-0.42, 0.26, cont);

  // 2. domain warp — bends ridge lines so they curve like real ranges.
  vec2 w = q + uGfWarp * vec2(
    gfFbm(q * 0.71 + vec2(3.11, 7.53), 2, 2.07, 0.5, s + 23u),
    gfFbm(q * 0.71 + vec2(9.27, 1.41), 2, 2.07, 0.5, s + 37u));

  // 3. eroded ridged mountains, contrasted into broad valleys + sharp crests.
  float mnt = gfRidge(w, uGfRidgeOct, uGfRidgeLac, uGfRidgeGain, uGfErosion, s + 53u);
  // Ridged fBm clusters around its own mean, which produces a raised plateau
  // rather than a mountain range. A power curve drops the valley floors while
  // leaving the crests where they are, which is what gives real relief.
  mnt = clamp(mnt * 0.5 + 0.5, 0.0, 1.0);
  mnt = pow(mnt, uGfRidgePower);

  // 4. rolling ground everywhere.
  float plain = gfFbm(w * 1.9, 4, 2.11, 0.5, s + 71u);

  float h = plain * uGfPlain + mnt * uGfMountain * mask;

  // 5. terraces: flat tread, sharp riser. Mesa country.
  if(uGfTerrace > 0.0){
    float t  = h / uGfTerraceH;
    float fl = floor(t);
    float fr = t - fl;
    float shaped = (fl + smoothstep(0.30, 0.88, fr)) * uGfTerraceH;
    h = mix(h, shaped, uGfTerrace * mask);
  }

  // 6. dunes: long windward slope, short lee face, only on the low ground.
  if(uGfDuneAmp > 0.0){
    float along = dot(world, uGfDuneDir) / uGfDuneWave;
    float wob   = gfFbm(q * 3.1, 3, 2.05, 0.5, s + 97u);
    float ph    = along + wob * 0.55;
    float saw   = ph - floor(ph);
    float prof  = saw < 0.72 ? smoothstep(0.0, 0.72, saw)
                             : 1.0 - smoothstep(0.72, 1.0, saw);
    float field = gfFbm(q * 0.9, 2, 2.0, 0.5, s + 113u) * 0.5 + 0.5;
    float dm    = (1.0 - mask) * smoothstep(0.15, 0.65, field);
    h += (prof - 0.5) * uGfDuneAmp * dm;
  }

  // 7. landing basin so the player always spawns somewhere playable.
  if(uGfFlatR > 0.0){
    float d = length(world) / uGfFlatR;
    float k = 1.0 - smoothstep(0.45, 1.0, d);
    h = mix(h, uGfFlatH + plain * uGfPlain * 0.18, k * 0.94);
  }
  return h;
}
`;

/** Convenience: uniforms + body, for shaders that want the whole thing. */
export const TERRAIN_GLSL = `${TERRAIN_GLSL_UNIFORMS}\n${TERRAIN_GLSL_BODY}`;

// ---------------------------------------------------------------------------
// TypeScript transcription
// ---------------------------------------------------------------------------

const G = GRADIENT_TABLE;

/** Bit-identical twin of `gfCell`. */
function cellHash(ix: number, iz: number, seed: number): number {
  let x = ((Math.imul(ix, 0x27d4eb2f) ^ Math.imul(iz, 0x9e3779b1)) ^ seed) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

// Noise results live in module scope so the hot path never allocates.
let nV = 0;
let nDx = 0;
let nDy = 0;

/** Bit-for-bit twin of `gfNoiseD`. Writes into `nV`/`nDx`/`nDy`. */
function noiseD(px: number, pz: number, seed: number): void {
  const flx = Math.floor(px);
  const flz = Math.floor(pz);
  const fx = px - flx;
  const fz = pz - flz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duz = 30 * fz * fz * (fz * (fz - 2) + 1);

  const ia = (cellHash(flx, flz, seed) >>> 26) * 2;
  const ib = (cellHash(flx + 1, flz, seed) >>> 26) * 2;
  const ic = (cellHash(flx, flz + 1, seed) >>> 26) * 2;
  const id = (cellHash(flx + 1, flz + 1, seed) >>> 26) * 2;
  const gax = G[ia];
  const gay = G[ia + 1];
  const gbx = G[ib];
  const gby = G[ib + 1];
  const gcx = G[ic];
  const gcy = G[ic + 1];
  const gdx = G[id];
  const gdy = G[id + 1];

  const va = gax * fx + gay * fz;
  const vb = gbx * (fx - 1) + gby * fz;
  const vc = gcx * fx + gcy * (fz - 1);
  const vd = gdx * (fx - 1) + gdy * (fz - 1);
  const k1 = vb - va;
  const k2 = vc - va;
  const k3 = va - vb - vc + vd;

  nV = va + k1 * ux + k2 * uz + k3 * ux * uz;
  nDx =
    gax +
    ux * (gbx - gax) +
    uz * (gcx - gax) +
    ux * uz * (gax - gbx - gcx + gdx) +
    dux * (k1 + k3 * uz);
  nDy =
    gay +
    ux * (gby - gay) +
    uz * (gcy - gay) +
    ux * uz * (gay - gby - gcy + gdy) +
    duz * (k2 + k3 * ux);
}

function fbm(px: number, pz: number, oct: number, lac: number, gain: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < 8; i++) {
    if (i >= oct) break;
    noiseD(px * freq, pz * freq, (seed + i * 77) >>> 0);
    sum += amp * nV;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

function ridge(
  px: number,
  pz: number,
  oct: number,
  lac: number,
  gain: number,
  ero: number,
  seed: number,
): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  let dsx = 0;
  let dsz = 0;
  for (let i = 0; i < 10; i++) {
    if (i >= oct) break;
    noiseD(px * freq, pz * freq, (seed + i * 131) >>> 0);
    const sgn = Math.sign(nV);
    const r = 1 - Math.abs(nV);
    const drx = -sgn * nDx * freq;
    const drz = -sgn * nDy * freq;
    const damp = amp / (1 + ero * (dsx * dsx + dsz * dsz));
    sum += damp * r * r;
    norm += damp;
    dsx += damp * 2 * r * drx;
    dsz += damp * 2 * r * drz;
    amp *= gain;
    freq *= lac;
  }
  return (sum / norm) * 2 - 1;
}

/** GLSL `smoothstep(a, b, x)`. */
function sstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// HeightField
// ---------------------------------------------------------------------------

const _n = new THREE.Vector3();

export class HeightField {
  readonly descriptor: TerrainDescriptor;

  /** Epsilon used for the finite-difference normal, metres. */
  readonly normalEpsilon = 0.6;

  private seed: number;
  private feature: number;
  private continent: number;
  private warp: number;
  private erosion: number;
  private mountain: number;
  private plain: number;
  private ridgeOct: number;
  private ridgeLac: number;
  private ridgeGain: number;
  private ridgePower: number;
  private terrace: number;
  private terraceH: number;
  private duneAmp: number;
  private duneWave: number;
  private duneDirX: number;
  private duneDirZ: number;
  private flatR: number;
  private flatH: number;

  /** Cached vertical extent, filled lazily by `range()`. */
  private minY = 0;
  private maxY = 0;
  private rangeDone = false;

  constructor(d: TerrainDescriptor) {
    this.descriptor = d;
    // The seed travels to the GPU through a `float` uniform, so it must be
    // exactly representable in float32 — anything above 2^24 gets rounded and
    // the two transcriptions then hash different integers, which shows up as the
    // player walking through a hillside. Twenty bits is far more entropy than the
    // lattice hash needs.
    this.seed = (d.seed >>> 0) & 0xfffff;
    this.feature = 1 / d.featureMetres;
    this.continent = d.continentScale;
    this.warp = d.warp;
    this.erosion = d.erosion;
    this.mountain = d.mountainAmplitude;
    this.plain = d.plainAmplitude;
    this.ridgeOct = d.ridgeOctaves;
    this.ridgeLac = d.ridgeLacunarity;
    this.ridgeGain = d.ridgeGain;
    this.ridgePower = d.ridgePower;
    this.terrace = d.terraceStrength;
    this.terraceH = d.terraceHeight;
    this.duneAmp = d.duneAmplitude;
    this.duneWave = d.duneWavelength;
    this.duneDirX = Math.fround(Math.cos(d.duneAngle));
    this.duneDirZ = Math.fround(Math.sin(d.duneAngle));
    this.flatR = d.flattenRadius;
    this.flatH = d.flattenHeight;
  }

  // -- the field ------------------------------------------------------------

  /** Surface Y in metres. Mirrors `gfHeight`. */
  height(x: number, z: number): number {
    const s = this.seed;
    const qx = x * this.feature;
    const qz = z * this.feature;

    // 1. continental mask
    const cont = fbm(qx * this.continent, qz * this.continent, 3, 2.03, 0.5, (s + 11) >>> 0);
    const mask = sstep(-0.42, 0.26, cont);

    // 2. domain warp
    const wx = qx + this.warp * fbm(qx * 0.71 + 3.11, qz * 0.71 + 7.53, 2, 2.07, 0.5, (s + 23) >>> 0);
    const wz = qz + this.warp * fbm(qx * 0.71 + 9.27, qz * 0.71 + 1.41, 2, 2.07, 0.5, (s + 37) >>> 0);

    // 3. eroded ridged mountains
    let mnt = ridge(wx, wz, this.ridgeOct, this.ridgeLac, this.ridgeGain, this.erosion, (s + 53) >>> 0);
    mnt = clamp(mnt * 0.5 + 0.5, 0, 1);
    mnt = Math.pow(mnt, this.ridgePower);

    // 4. rolling ground
    const plain = fbm(wx * 1.9, wz * 1.9, 4, 2.11, 0.5, (s + 71) >>> 0);

    let h = plain * this.plain + mnt * this.mountain * mask;

    // 5. terraces
    if (this.terrace > 0) {
      const t = h / this.terraceH;
      const fl = Math.floor(t);
      const fr = t - fl;
      const shaped = (fl + sstep(0.3, 0.88, fr)) * this.terraceH;
      const k = this.terrace * mask;
      h = h + (shaped - h) * k;
    }

    // 6. dunes
    if (this.duneAmp > 0) {
      const along = (x * this.duneDirX + z * this.duneDirZ) / this.duneWave;
      const wob = fbm(qx * 3.1, qz * 3.1, 3, 2.05, 0.5, (s + 97) >>> 0);
      const ph = along + wob * 0.55;
      const saw = ph - Math.floor(ph);
      const prof = saw < 0.72 ? sstep(0, 0.72, saw) : 1 - sstep(0.72, 1, saw);
      const field = fbm(qx * 0.9, qz * 0.9, 2, 2.0, 0.5, (s + 113) >>> 0) * 0.5 + 0.5;
      const dm = (1 - mask) * sstep(0.15, 0.65, field);
      h += (prof - 0.5) * this.duneAmp * dm;
    }

    // 7. landing basin
    if (this.flatR > 0) {
      const d = Math.sqrt(x * x + z * z) / this.flatR;
      const k = (1 - sstep(0.45, 1, d)) * 0.94;
      const target = this.flatH + plain * this.plain * 0.18;
      h = h + (target - h) * k;
    }
    return h;
  }

  /** The smooth base form. Mirrors `gfLowHeight`; used for convexity/AO. */
  lowHeight(x: number, z: number): number {
    const s = this.seed;
    const qx = x * this.feature;
    const qz = z * this.feature;
    const cont = fbm(qx * this.continent, qz * this.continent, 3, 2.03, 0.5, (s + 11) >>> 0);
    const plain = fbm(qx * 1.9, qz * 1.9, 3, 2.11, 0.5, (s + 71) >>> 0);
    return plain * this.plain + sstep(-0.42, 0.26, cont) * this.mountain * 0.26;
  }

  /** Surface normal by central differences. */
  normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = this.normalEpsilon;
    const hx = (this.height(x + e, z) - this.height(x - e, z)) / (2 * e);
    const hz = (this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
    return out.set(-hx, 1, -hz).normalize();
  }

  /** Steepness in radians. */
  slope(x: number, z: number): number {
    this.normal(x, z, _n);
    return Math.acos(clamp(_n.y, -1, 1));
  }

  /**
   * Discrete Laplacian of the field — negative in bowls, positive on crests.
   * Scatter uses it for curvature and moisture; water uses nothing of it.
   */
  curvature(x: number, z: number, e = 3): number {
    const h = this.height(x, z);
    return (
      (this.height(x + e, z) + this.height(x - e, z) + this.height(x, z + e) + this.height(x, z - e)) /
        4 -
      h
    );
  }

  /**
   * 0..1 wetness. Rises in concavities, near the waterline, and with a slow
   * noise band so a planet has damp regions rather than uniform moisture.
   */
  moisture(x: number, z: number): number {
    const h = this.height(x, z);
    const curve = this.curvature(x, z, 4);
    const band = fbm(x * this.feature * 0.6, z * this.feature * 0.6, 3, 2.05, 0.5, (this.seed + 211) >>> 0);
    let m = 0.42 + band * 0.45 + clamp(curve * 0.28, -0.3, 0.3);
    const water = this.descriptor.water;
    if (water) m += (1 - sstep(0, 26, Math.max(0, h - water.level))) * 0.45;
    m -= sstep(0.25, 0.85, this.slope(x, z)) * 0.35;
    return clamp(m, 0, 1);
  }

  /**
   * The exact signature `BvhCollisionWorld.groundFn` expects. Bound as an arrow
   * property so it can be handed over without losing `this`.
   */
  groundFn = (x: number, z: number, outNormal: THREE.Vector3): number => {
    this.normal(x, z, outNormal);
    return this.height(x, z);
  };

  /**
   * `height` as a bound property, for callers that want the field and not its
   * normal. `groundFn` costs five evaluations to `heightFn`'s one.
   */
  heightFn = (x: number, z: number): number => this.height(x, z);

  /** Cheap conservative vertical range over the authored extent. */
  range(): { min: number; max: number } {
    if (!this.rangeDone) {
      const e = this.descriptor.extent;
      const step = Math.max(8, (e * 2) / 96);
      let lo = Infinity;
      let hi = -Infinity;
      for (let z = -e; z <= e; z += step) {
        for (let x = -e; x <= e; x += step) {
          const h = this.height(x, z);
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
      }
      this.minY = lo - this.descriptor.skirtDepth;
      this.maxY = hi + 8;
      this.rangeDone = true;
    }
    return { min: this.minY, max: this.maxY };
  }

  /**
   * Uniform values for `TERRAIN_GLSL_UNIFORMS`. Returns a fresh record; callers
   * keep the object identity so the same uniforms feed the colour pass, the
   * depth pass and the water shader.
   */
  uniforms(): Record<string, THREE.IUniform> {
    const d = this.descriptor;
    return {
      uGfSeed: { value: this.seed },
      uGfFeature: { value: this.feature },
      uGfContinent: { value: this.continent },
      uGfWarp: { value: this.warp },
      uGfErosion: { value: this.erosion },
      uGfMountain: { value: this.mountain },
      uGfPlain: { value: this.plain },
      uGfRidgeLac: { value: this.ridgeLac },
      uGfRidgeGain: { value: this.ridgeGain },
      uGfRidgePower: { value: this.ridgePower },
      uGfRidgeOct: { value: this.ridgeOct },
      uGfTerrace: { value: this.terrace },
      uGfTerraceH: { value: this.terraceH },
      uGfDuneAmp: { value: this.duneAmp },
      uGfDuneWave: { value: this.duneWave },
      uGfDuneDir: { value: new THREE.Vector2(this.duneDirX, this.duneDirZ) },
      uGfFlatR: { value: this.flatR },
      uGfFlatH: { value: this.flatH },
      uGfGrad: { value: GRADIENT_TABLE },
      // Unused by the field itself but declared by every consumer, so keeping it
      // here means one Object.assign wires a whole material.
      uGfSkirt: { value: d.skirtDepth },
    };
  }
}
