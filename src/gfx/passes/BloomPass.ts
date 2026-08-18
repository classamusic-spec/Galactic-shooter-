/**
 * Progressive-mip bloom (Jimenez, "Next Generation Post Processing in Call of
 * Duty: Advanced Warfare").
 *
 * Explicitly not `UnrealBloomPass`. That one runs five separate Gaussian blur
 * pairs at fixed resolutions and sums them with hand-tuned weights, which costs
 * ten fullscreen passes and still bands on a smooth gradient. This is a
 * dual-filter pyramid: a 13-tap box-ish downsample to build six mips, then a
 * 9-tap tent on the way back up, additively accumulating into the larger mip.
 * Six passes down, five up, all at progressively tiny resolutions — most of the
 * chain costs less than one fullscreen pass.
 *
 * Two details do most of the visual work:
 *
 * - **Karis average on mip 0.** Weighting each 2x2 block by 1/(1+luma) before
 *   averaging stops a single 300-nit spark from surviving six downsamples as a
 *   flickering blob. Without it, muzzle flashes and sparks make the whole screen
 *   pulse.
 * - **HDR threshold with a soft knee, in exposed space.** Only genuine emissives
 *   bloom, and what counts as "genuine" tracks auto-exposure. A fixed
 *   threshold on unexposed values means bloom appears and vanishes as the player
 *   walks from a cave into daylight.
 */
import * as THREE from 'three';
import { FullscreenPass, makeTarget, type PassRunner } from './FullscreenPass';
import { GLSL_COLOR } from '@/gfx/shaders/common';

const MAX_MIPS = 6;

const PREFILTER_FRAG = /* glsl */ `
${GLSL_COLOR}
uniform sampler2D tSource;
uniform sampler2D tExposure;
uniform vec2 uTexel;        // texel size of the SOURCE
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uClamp;

// Exposure lives in a 1x1 texture rather than a CPU uniform: auto-exposure is
// computed on the GPU with no readback, so there is no value for the CPU to
// pass down. One extra fetch per texel at half resolution is free.
float exposureNow(){
  float e = texture(tExposure, vec2(0.5)).x;
  return (e > 0.0 && !isnan(e) && !isinf(e)) ? e : 1.0;
}

vec3 fetch(vec2 uv, float exposure){
  vec3 c = texture(tSource, uv).rgb * exposure;
  // Clamping before the pyramid is a cheap firefly guard that also stops a NaN
  // from a rogue emissive material propagating into every mip.
  c = min(max(c, vec3(0.0)), vec3(uClamp));
  return c;
}

/** Quadratic soft-knee threshold: no hard cutoff edge on a smooth falloff. */
vec3 prefilter(vec3 c){
  float br = max(max(c.r, c.g), c.b);
  float knee = uThreshold * uSoftKnee + 1e-5;
  float rq = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  rq = (rq * rq) / (4.0 * knee + 1e-5);
  float weight = max(rq, br - uThreshold) / max(br, 1e-5);
  return c * weight;
}

float karisWeight(vec3 c){ return 1.0 / (1.0 + luminance(c)); }

void main(){
  vec2 uv = vUv;
  vec2 t = uTexel;
  float ex = exposureNow();
  vec3 a = fetch(uv + t * vec2(-2.0, -2.0), ex);
  vec3 b = fetch(uv + t * vec2( 0.0, -2.0), ex);
  vec3 c = fetch(uv + t * vec2( 2.0, -2.0), ex);
  vec3 d = fetch(uv + t * vec2(-1.0, -1.0), ex);
  vec3 e = fetch(uv + t * vec2( 1.0, -1.0), ex);
  vec3 f = fetch(uv + t * vec2(-2.0,  0.0), ex);
  vec3 g = fetch(uv, ex);
  vec3 h = fetch(uv + t * vec2( 2.0,  0.0), ex);
  vec3 i = fetch(uv + t * vec2(-1.0,  1.0), ex);
  vec3 j = fetch(uv + t * vec2( 1.0,  1.0), ex);
  vec3 k = fetch(uv + t * vec2(-2.0,  2.0), ex);
  vec3 l = fetch(uv + t * vec2( 0.0,  2.0), ex);
  vec3 m = fetch(uv + t * vec2( 2.0,  2.0), ex);

  vec3 b0 = (a + b + f + g) * 0.25;
  vec3 b1 = (b + c + g + h) * 0.25;
  vec3 b2 = (f + g + k + l) * 0.25;
  vec3 b3 = (g + h + l + m) * 0.25;
  vec3 b4 = (d + e + i + j) * 0.25;

  float w0 = karisWeight(b0) * 0.125;
  float w1 = karisWeight(b1) * 0.125;
  float w2 = karisWeight(b2) * 0.125;
  float w3 = karisWeight(b3) * 0.125;
  float w4 = karisWeight(b4) * 0.5;
  float wsum = w0 + w1 + w2 + w3 + w4;

  vec3 col = (b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + b4 * w4) / max(wsum, 1e-5);
  fragColor = vec4(prefilter(col), 1.0);
}
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;

void main(){
  vec2 uv = vUv;
  vec2 t = uTexel;
  vec3 a = texture(tSource, uv + t * vec2(-2.0, -2.0)).rgb;
  vec3 b = texture(tSource, uv + t * vec2( 0.0, -2.0)).rgb;
  vec3 c = texture(tSource, uv + t * vec2( 2.0, -2.0)).rgb;
  vec3 d = texture(tSource, uv + t * vec2(-1.0, -1.0)).rgb;
  vec3 e = texture(tSource, uv + t * vec2( 1.0, -1.0)).rgb;
  vec3 f = texture(tSource, uv + t * vec2(-2.0,  0.0)).rgb;
  vec3 g = texture(tSource, uv).rgb;
  vec3 h = texture(tSource, uv + t * vec2( 2.0,  0.0)).rgb;
  vec3 i = texture(tSource, uv + t * vec2(-1.0,  1.0)).rgb;
  vec3 j = texture(tSource, uv + t * vec2( 1.0,  1.0)).rgb;
  vec3 k = texture(tSource, uv + t * vec2(-2.0,  2.0)).rgb;
  vec3 l = texture(tSource, uv + t * vec2( 0.0,  2.0)).rgb;
  vec3 m = texture(tSource, uv + t * vec2( 2.0,  2.0)).rgb;

  vec3 col = (d + e + i + j) * 0.125
           + (a + c + k + m) * 0.03125
           + (b + f + h + l) * 0.0625
           + g * 0.125;
  fragColor = vec4(col, 1.0);
}
`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;        // texel size of the SOURCE (the smaller mip)
uniform float uRadius;
uniform float uScale;

/** 9-tap tent. Wider than a bilinear upsample, so the mips overlap smoothly. */
void main(){
  vec2 uv = vUv;
  vec2 t = uTexel * uRadius;
  vec3 s = texture(tSource, uv + vec2(-t.x, -t.y)).rgb;
  s += texture(tSource, uv + vec2(0.0, -t.y)).rgb * 2.0;
  s += texture(tSource, uv + vec2( t.x, -t.y)).rgb;
  s += texture(tSource, uv + vec2(-t.x, 0.0)).rgb * 2.0;
  s += texture(tSource, uv).rgb * 4.0;
  s += texture(tSource, uv + vec2( t.x, 0.0)).rgb * 2.0;
  s += texture(tSource, uv + vec2(-t.x,  t.y)).rgb;
  s += texture(tSource, uv + vec2(0.0,  t.y)).rgb * 2.0;
  s += texture(tSource, uv + vec2( t.x,  t.y)).rgb;
  fragColor = vec4(s * (uScale / 16.0), 1.0);
}
`;

export class BloomPass {
  private mips: THREE.WebGLRenderTarget[] = [];
  private sizes: THREE.Vector2[] = [];
  private readonly prefilter: FullscreenPass;
  private readonly down: FullscreenPass;
  private readonly up: FullscreenPass;
  private width = 1;
  private height = 1;

  /**
   * Threshold in *exposed* HDR units.
   *
   * Auto-exposure keys the frame's mid-grey to ~0.19, which puts a sunlit diffuse
   * white surface around 1.2-1.8 and a bright sky around 2. At the first tuning
   * pass this was 1.05 and the result was a textbook failure: the sky itself
   * cleared the threshold, so half the frame bloomed and the sun became a
   * quarter-screen white blob. 2.5 sits above sunlit white and below any real
   * emissive, which is the definition of "only genuine emissives bloom".
   */
  threshold = 2.5;
  softKnee = 0.45;
  radius = 1.15;

  constructor(width: number, height: number) {
    this.prefilter = new FullscreenPass(PREFILTER_FRAG, {
      tSource: { value: null },
      tExposure: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 2.5 },
      uSoftKnee: { value: 0.45 },
      uClamp: { value: 24 },
    });
    this.down = new FullscreenPass(DOWN_FRAG, {
      tSource: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.up = new FullscreenPass(
      UP_FRAG,
      {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1.15 },
        uScale: { value: 1 },
      },
      { blending: THREE.AdditiveBlending },
    );
    this.allocate(width, height);
  }

  /** How many mips the current resolution supports. */
  get mipCount(): number {
    return this.mips.length;
  }

  /** The accumulated bloom, at half the render resolution. */
  get texture(): THREE.Texture {
    return this.mips[0].texture;
  }

  /**
   * Normalisation for the composite. Each mip contributes roughly the same
   * average energy, so the sum needs dividing by the count or bloom strength
   * would mean something different at every resolution.
   */
  get energyScale(): number {
    return 1 / Math.max(1, this.mips.length);
  }

  private allocate(width: number, height: number): void {
    this.dispose(true);
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    const minDim = Math.min(this.width, this.height);
    // Stop before a mip would be under ~8 px: a 2x1 mip is a horizontal smear,
    // not a glow, and on a prime-sized viewport it produces visible banding.
    const count = Math.max(2, Math.min(MAX_MIPS, Math.floor(Math.log2(minDim)) - 3));
    this.mips = [];
    this.sizes = [];
    let w = this.width;
    let h = this.height;
    for (let i = 0; i < count; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.sizes.push(new THREE.Vector2(w, h));
      this.mips.push(makeTarget(w, h, `bloomMip${i}`));
    }
  }

  setSize(width: number, height: number): void {
    if (Math.round(width) === this.width && Math.round(height) === this.height) return;
    this.allocate(width, height);
  }

  /**
   * Build the pyramid. `source` is the resolved (post-TAA) HDR colour, so bloom
   * never flickers with the jitter pattern.
   */
  render(
    runner: PassRunner,
    source: THREE.Texture,
    sourceWidth: number,
    sourceHeight: number,
    exposureTexture: THREE.Texture,
    bloomStrength: number,
  ): void {
    const pre = this.prefilter;
    pre.set('tSource', source);
    pre.set('tExposure', exposureTexture);
    (pre.uniforms.uTexel.value as THREE.Vector2).set(1 / sourceWidth, 1 / sourceHeight);
    pre.set('uThreshold', this.threshold);
    pre.set('uSoftKnee', this.softKnee);
    // A brighter allowance at higher strength keeps the artistic knob from also
    // being a firefly knob.
    pre.set('uClamp', 18 + bloomStrength * 14);
    runner.run(pre.material, this.mips[0]);

    for (let i = 1; i < this.mips.length; i++) {
      const src = this.sizes[i - 1];
      this.down.set('tSource', this.mips[i - 1].texture);
      (this.down.uniforms.uTexel.value as THREE.Vector2).set(1 / src.x, 1 / src.y);
      runner.run(this.down.material, this.mips[i]);
    }

    for (let i = this.mips.length - 1; i > 0; i--) {
      const src = this.sizes[i];
      this.up.set('tSource', this.mips[i].texture);
      (this.up.uniforms.uTexel.value as THREE.Vector2).set(1 / src.x, 1 / src.y);
      this.up.set('uRadius', this.radius);
      this.up.set('uScale', 1);
      // Additive, and deliberately not cleared: mip i-1 already holds its own
      // band and this accumulates the coarser one on top.
      runner.run(this.up.material, this.mips[i - 1]);
    }
  }

  dispose(keepMaterials = false): void {
    for (const m of this.mips) m.dispose();
    this.mips = [];
    this.sizes = [];
    if (!keepMaterials) {
      this.prefilter.dispose();
      this.down.dispose();
      this.up.dispose();
    }
  }
}
