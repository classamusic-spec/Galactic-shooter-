/**
 * Procedural 3D colour-grading LUTs — one mood per world.
 *
 * A grading chain evaluated per pixel in the composite would mean lift/gamma/gain,
 * three tone curves, a saturation matrix, split toning and a temperature shift on
 * every one of two million fragments, every frame. Baking the whole transform into
 * a 33^3 `Data3DTexture` collapses all of it into a single trilinear fetch, and it
 * is what every shipped engine does — with the difference that here the cube is
 * generated from maths at load time rather than authored in Resolve and exported
 * as a .cube file.
 *
 * 33 is the industry-standard cube edge: 32 evenly-spaced intervals plus the
 * endpoint, so pure black and pure white land exactly on a lattice point and
 * cannot drift.
 *
 * The LUT operates on *display-referred sRGB* values, after ACES. That is the
 * right domain: a film LUT is a look applied to a graded image, not to scene
 * radiance, and applying lift/gain in linear light crushes shadows in a way no
 * colourist would accept.
 */
import * as THREE from 'three';
import { clamp01, lerp } from '@/util/math';

export interface GradePreset {
  /** Shadow offset, added. Positive lifts the blacks and tints them. */
  lift: [number, number, number];
  /** Midtone power, per channel. <1 brightens mids. */
  gamma: [number, number, number];
  /** Highlight multiplier, per channel. */
  gain: [number, number, number];
  /** S-curve contrast around `pivot`. 0 = none, 1 = strong. */
  contrast: number;
  pivot: number;
  /** Global saturation. 1 = untouched. */
  saturation: number;
  /** Extra saturation applied only to the shadows (negative desaturates). */
  shadowSaturation: number;
  /** Colour pushed into the shadows, 0..1 strength in `toneBalance`. */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  toneBalance: number;
  /** Warm/cool shift. Positive = warmer. */
  temperature: number;
  /** Green/magenta shift. Positive = magenta. */
  tint: number;
}

const NEUTRAL: GradePreset = {
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  contrast: 0.12,
  pivot: 0.42,
  saturation: 1.04,
  shadowSaturation: -0.1,
  shadowTint: [0.1, 0.16, 0.3],
  highlightTint: [1, 0.97, 0.9],
  toneBalance: 0.16,
  temperature: 0,
  tint: 0,
};

function preset(over: Partial<GradePreset>): GradePreset {
  return { ...NEUTRAL, ...over };
}

/**
 * The catalogue. Each world gets one dominant hue and one complementary accent,
 * per the art direction: the grade is where that commitment actually lands, and
 * it is the cheapest way to make five planets built from the same material
 * library feel like five places.
 */
export const GRADE_PRESETS: Record<string, GradePreset> = {
  neutral: NEUTRAL,

  /** Nordic ice world: cold steel shadows, pale gold sun, high separation. */
  aurvangr: preset({
    lift: [-0.004, 0.004, 0.022],
    gamma: [1.02, 1.0, 0.95],
    gain: [0.98, 1.0, 1.06],
    contrast: 0.2,
    pivot: 0.4,
    saturation: 0.92,
    // Snow is white with a blue *shadow*, not blue snow. The first tuning pass
    // used a 0.3 tone balance against a saturated tint and turned the whole
    // midground electric blue; the fix is a paler tint at lower weight.
    shadowSaturation: 0.06,
    shadowTint: [0.3, 0.42, 0.62],
    highlightTint: [1.0, 0.96, 0.88],
    toneBalance: 0.18,
    temperature: -0.12,
    tint: -0.02,
  }),

  /** Grey facility: bleached violet, near-monochrome, clinical. */
  'zeta-reticuli': preset({
    lift: [0.012, 0.004, 0.02],
    gamma: [1.0, 1.04, 0.98],
    gain: [1.0, 0.97, 1.05],
    contrast: 0.26,
    pivot: 0.38,
    saturation: 0.8,
    shadowSaturation: -0.18,
    shadowTint: [0.16, 0.12, 0.34],
    highlightTint: [0.93, 0.95, 1.0],
    toneBalance: 0.24,
    temperature: -0.06,
    tint: 0.06,
  }),

  /** Insectoid desert: amber dust, deep teal shade, strong warm/cool split. */
  khepri: preset({
    lift: [0.016, 0.008, -0.004],
    gamma: [0.96, 1.0, 1.06],
    gain: [1.08, 1.0, 0.9],
    contrast: 0.18,
    pivot: 0.46,
    saturation: 1.1,
    shadowSaturation: 0.08,
    shadowTint: [0.05, 0.2, 0.26],
    highlightTint: [1.0, 0.9, 0.68],
    toneBalance: 0.34,
    temperature: 0.16,
    tint: -0.03,
  }),

  /** Hive interior: acid green key, bruised magenta shadow. */
  'hive-prime': preset({
    lift: [0.014, 0.016, 0.008],
    gamma: [1.02, 0.95, 1.06],
    gain: [0.94, 1.06, 0.9],
    contrast: 0.28,
    pivot: 0.36,
    saturation: 1.06,
    shadowSaturation: 0.05,
    shadowTint: [0.24, 0.08, 0.24],
    highlightTint: [0.85, 1.0, 0.72],
    toneBalance: 0.3,
    temperature: 0.02,
    tint: 0.05,
  }),

  /** Reptilian volcanic: blood red key, cold blue-black shadow. */
  'draco-ix': preset({
    lift: [0.02, 0.002, 0.006],
    gamma: [0.94, 1.03, 1.08],
    gain: [1.1, 0.95, 0.9],
    contrast: 0.3,
    pivot: 0.4,
    saturation: 1.08,
    shadowSaturation: 0.02,
    shadowTint: [0.1, 0.1, 0.28],
    highlightTint: [1.0, 0.82, 0.66],
    toneBalance: 0.36,
    temperature: 0.14,
    tint: 0.03,
  }),

  /** Orbit / star map: near-black vacuum, cyan instrument glow. */
  orbit: preset({
    lift: [-0.006, 0.0, 0.014],
    gamma: [1.06, 1.02, 0.96],
    gain: [0.94, 1.0, 1.08],
    contrast: 0.34,
    pivot: 0.32,
    saturation: 1.0,
    shadowSaturation: 0.1,
    shadowTint: [0.03, 0.12, 0.3],
    highlightTint: [0.88, 0.97, 1.0],
    toneBalance: 0.26,
    temperature: -0.14,
    tint: -0.02,
  }),

  /** Ship interior: warm practical lights against Federation cyan panels. */
  ship: preset({
    lift: [0.01, 0.006, 0.004],
    gamma: [0.98, 1.0, 1.02],
    gain: [1.05, 1.0, 0.98],
    contrast: 0.2,
    pivot: 0.42,
    saturation: 1.02,
    shadowSaturation: 0.0,
    shadowTint: [0.08, 0.16, 0.3],
    highlightTint: [1.0, 0.94, 0.82],
    toneBalance: 0.22,
    temperature: 0.08,
    tint: 0.0,
  }),
};

export const LUT_SIZE = 33;

const LUMA = [0.2125, 0.7154, 0.0721] as const;

function applySaturation(rgb: number[], amount: number): void {
  const l = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  for (let i = 0; i < 3; i++) rgb[i] = l + (rgb[i] - l) * amount;
}

/**
 * Evaluate the grade for one lattice point. Order matters and follows standard
 * colour-correction practice: exposure-like gain last, contrast after
 * lift/gamma/gain, saturation and tone-split at the end so they act on the
 * already-shaped image.
 */
function grade(p: GradePreset, r: number, g: number, b: number): number[] {
  const c = [r, g, b];

  // -- temperature / tint: a cheap 2-axis white-balance shift ---------------
  const t = p.temperature;
  const ti = p.tint;
  c[0] *= 1 + t * 0.22 + ti * 0.06;
  c[1] *= 1 - Math.abs(t) * 0.03 - ti * 0.12;
  c[2] *= 1 - t * 0.24 + ti * 0.06;

  // -- lift / gamma / gain ---------------------------------------------------
  for (let i = 0; i < 3; i++) {
    // Lift is applied so it fades out toward white, which is what a printer
    // light does; a flat add washes the highlights.
    const lifted = c[i] + p.lift[i] * (1 - c[i]);
    const gained = lifted * p.gain[i];
    c[i] = Math.pow(Math.max(gained, 0), p.gamma[i]);
  }

  // -- S-curve contrast around the pivot ------------------------------------
  if (p.contrast !== 0) {
    for (let i = 0; i < 3; i++) {
      const x = clamp01(c[i]);
      // Smoothstep-shaped curve blended by strength: monotonic, no clipping,
      // and it keeps the pivot fixed so exposure does not shift with contrast.
      const s = x * x * (3 - 2 * x);
      const shaped = lerp(x, s, p.contrast);
      // Re-anchor the pivot so contrast does not double as a brightness knob.
      const pv = p.pivot;
      const pvS = pv * pv * (3 - 2 * pv);
      const anchor = lerp(pv, pvS, p.contrast);
      c[i] = clamp01(shaped + (pv - anchor));
    }
  }

  // -- tone split: tint shadows one way, highlights the other ---------------
  if (p.toneBalance > 0) {
    const l = clamp01(c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]);
    const shadowW = Math.pow(1 - l, 2) * p.toneBalance;
    const highW = Math.pow(l, 2) * p.toneBalance;
    for (let i = 0; i < 3; i++) {
      c[i] = c[i] * (1 - shadowW) + p.shadowTint[i] * shadowW * (1 - l + 0.35);
      c[i] = c[i] * (1 - highW * 0.5) + c[i] * p.highlightTint[i] * highW * 0.5;
    }
  }

  // -- saturation, with a separate shadow term -------------------------------
  applySaturation(c, p.saturation);
  if (p.shadowSaturation !== 0) {
    const l = clamp01(c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]);
    const w = Math.pow(1 - l, 2.2);
    const shadow = [c[0], c[1], c[2]];
    applySaturation(shadow, 1 + p.shadowSaturation);
    for (let i = 0; i < 3; i++) c[i] = lerp(c[i], shadow[i], w);
  }

  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

/**
 * Bake a preset into a 33^3 RGBA8 3D texture.
 *
 * 8 bits per channel is enough because the LUT is interpolated trilinearly and
 * then dithered by the film grain downstream; a float cube would cost 4x the
 * memory for a difference nobody can see.
 */
export function buildGradeLut(name: string): THREE.Data3DTexture {
  const p = GRADE_PRESETS[name] ?? GRADE_PRESETS.neutral;
  const n = LUT_SIZE;
  const data = new Uint8Array(n * n * n * 4);
  let o = 0;
  for (let z = 0; z < n; z++) {
    const b = z / (n - 1);
    for (let y = 0; y < n; y++) {
      const g = y / (n - 1);
      for (let x = 0; x < n; x++) {
        const r = x / (n - 1);
        const c = grade(p, r, g, b);
        data[o++] = Math.round(c[0] * 255);
        data[o++] = Math.round(c[1] * 255);
        data[o++] = Math.round(c[2] * 255);
        data[o++] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  // The cube stores already-encoded display values; a colour-space conversion on
  // top would apply the sRGB curve twice.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = `lut:${name}`;
  return tex;
}

/** GLSL for sampling a baked cube with the correct half-texel inset. */
export const GLSL_LUT = /* glsl */ `
uniform sampler3D tLut;
uniform float uLutSize;
uniform float uLutStrength;

/**
 * Trilinear 3D lookup. The scale/offset inset is not optional: without it the
 * outer half-texel is sampled beyond the cube's centres and pure white shifts
 * hue, which shows up as a coloured cast in every specular highlight.
 */
vec3 applyLut(vec3 color){
  vec3 c = clamp(color, 0.0, 1.0);
  float scale = (uLutSize - 1.0) / uLutSize;
  float offset = 1.0 / (2.0 * uLutSize);
  vec3 graded = texture(tLut, c * scale + offset).rgb;
  return mix(color, graded, uLutStrength);
}
`;
