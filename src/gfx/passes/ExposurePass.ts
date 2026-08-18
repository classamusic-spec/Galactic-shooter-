/**
 * Histogram auto-exposure. Three passes on targets of 32x32, 16x1 and 1x1 —
 * together well under a millisecond, and no CPU readback, so there is no
 * pipeline stall and no one-frame `readPixels` hitch.
 *
 * Why a histogram rather than an average: the average log-luminance of a frame
 * containing a sky is dominated by the sky, so walking into a cave mouth with
 * bright sky behind you leaves the interior black. Binning and then taking a
 * *percentile band* of the bins throws away the brightest and darkest tails, so
 * exposure keys off the bulk of the image — the part the player is looking at.
 *
 * Adaptation is asymmetric: fast when the scene gets brighter (the eye protects
 * itself quickly), slow when it darkens. Matching real adaptation matters for
 * feel; a symmetric filter reads as a camera, not as eyes.
 */
import * as THREE from 'three';
import { FullscreenPass, makeTarget, type PassRunner } from './FullscreenPass';
import { GLSL_COLOR } from '@/gfx/shaders/common';

const LUM_SIZE = 32;
const BINS = 16;
/** Histogram range in log2 luminance. Covers moonlight to a lit desert. */
const LOG_MIN = -8;
const LOG_MAX = 6;

const LUM_FRAG = /* glsl */ `
${GLSL_COLOR}
uniform sampler2D tSource;
uniform vec2 uTexel;

void main(){
  // Four taps per output texel: 32x32x4 = 4096 samples of the frame, which is
  // plenty for a luminance estimate and immune to a single bright pixel.
  vec3 c = texture(tSource, vUv + uTexel * vec2(-0.5, -0.5)).rgb
         + texture(tSource, vUv + uTexel * vec2( 0.5, -0.5)).rgb
         + texture(tSource, vUv + uTexel * vec2(-0.5,  0.5)).rgb
         + texture(tSource, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  float l = luminance(max(c * 0.25, vec3(0.0)));
  // Store log2 luminance so the histogram bins are perceptually even.
  float logL = log2(max(l, 1e-6));
  fragColor = vec4(logL, l, 0.0, 1.0);
}
`;

const HIST_FRAG = /* glsl */ `
uniform sampler2D tLuminance;
uniform float uLogMin;
uniform float uLogMax;

/**
 * One fragment per bin; each one scans the whole 32x32 luminance texture and
 * counts the samples that land in it. 16 x 1024 taps is trivially cheap and
 * needs no compute shader or atomics, which WebGL2 does not have.
 */
void main(){
  float bin = floor(vUv.x * ${BINS}.0);
  float invRange = 1.0 / (uLogMax - uLogMin);
  float count = 0.0;
  // Centre weighting: what is in the middle of the frame is what the player is
  // aiming at, and should drive exposure more than the corners.
  float weightSum = 0.0;
  for (int y = 0; y < ${LUM_SIZE}; y++) {
    for (int x = 0; x < ${LUM_SIZE}; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / ${LUM_SIZE}.0;
      float logL = texture(tLuminance, uv).x;
      float t = clamp((logL - uLogMin) * invRange, 0.0, 0.9999);
      float b = floor(t * ${BINS}.0);
      vec2 d = uv - 0.5;
      float w = mix(0.45, 1.0, 1.0 - clamp(length(d) * 1.7, 0.0, 1.0));
      weightSum += w;
      count += (b == bin) ? w : 0.0;
    }
  }
  fragColor = vec4(count / max(weightSum, 1e-5), 0.0, 0.0, 1.0);
}
`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D tHistogram;
uniform sampler2D tPrevious;
uniform float uLogMin;
uniform float uLogMax;
uniform float uLowPercent;
uniform float uHighPercent;
uniform float uKeyValue;
uniform float uMinExposure;
uniform float uMaxExposure;
uniform float uSpeedUp;
uniform float uSpeedDown;
uniform float uDt;
uniform float uReset;
uniform float uManual;

void main(){
  // Walk the CDF and average the bins between the two percentiles, so a bright
  // sky (top tail) and deep shadow (bottom tail) are both discarded.
  float cdf = 0.0;
  float sum = 0.0;
  float weight = 0.0;
  float range = uLogMax - uLogMin;
  for (int i = 0; i < ${BINS}; i++) {
    float f = texture(tHistogram, vec2((float(i) + 0.5) / ${BINS}.0, 0.5)).x;
    float lo = cdf;
    cdf += f;
    float overlap = max(0.0, min(cdf, uHighPercent) - max(lo, uLowPercent));
    if (overlap > 0.0) {
      float centre = uLogMin + (float(i) + 0.5) / ${BINS}.0 * range;
      sum += centre * overlap;
      weight += overlap;
    }
  }
  float logAvg = weight > 1e-5 ? sum / weight : 0.0;
  float avgLum = exp2(logAvg);
  float target = clamp(uKeyValue / max(avgLum, 1e-4), uMinExposure, uMaxExposure);
  target *= uManual;

  float prev = texture(tPrevious, vec2(0.5)).x;
  if (uReset > 0.5 || prev <= 0.0 || isnan(prev) || isinf(prev)) {
    fragColor = vec4(target, avgLum, 0.0, 1.0);
    return;
  }
  // Asymmetric exponential adaptation, frame-rate independent.
  float speed = target > prev ? uSpeedUp : uSpeedDown;
  float k = 1.0 - exp(-speed * uDt);
  float value = prev + (target - prev) * k;
  fragColor = vec4(value, avgLum, 0.0, 1.0);
}
`;

export class ExposurePass {
  private readonly lumTarget: THREE.WebGLRenderTarget;
  private readonly histTarget: THREE.WebGLRenderTarget;
  private readonly adaptA: THREE.WebGLRenderTarget;
  private readonly adaptB: THREE.WebGLRenderTarget;
  private readonly lum: FullscreenPass;
  private readonly hist: FullscreenPass;
  private readonly adapt: FullscreenPass;
  private ping = false;
  private current: THREE.WebGLRenderTarget;

  constructor() {
    this.lumTarget = makeTarget(LUM_SIZE, LUM_SIZE, 'autoLum', { filter: THREE.NearestFilter });
    this.histTarget = makeTarget(BINS, 1, 'autoHist', { filter: THREE.NearestFilter });
    this.adaptA = makeTarget(1, 1, 'autoExposureA', { filter: THREE.NearestFilter });
    this.adaptB = makeTarget(1, 1, 'autoExposureB', { filter: THREE.NearestFilter });
    this.current = this.adaptA;

    this.lum = new FullscreenPass(LUM_FRAG, {
      tSource: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.hist = new FullscreenPass(HIST_FRAG, {
      tLuminance: { value: null },
      uLogMin: { value: LOG_MIN },
      uLogMax: { value: LOG_MAX },
    });
    this.adapt = new FullscreenPass(ADAPT_FRAG, {
      tHistogram: { value: null },
      tPrevious: { value: null },
      uLogMin: { value: LOG_MIN },
      uLogMax: { value: LOG_MAX },
      uLowPercent: { value: 0.42 },
      uHighPercent: { value: 0.94 },
      uKeyValue: { value: 0.19 },
      uMinExposure: { value: 0.28 },
      uMaxExposure: { value: 5.5 },
      uSpeedUp: { value: 2.6 },
      uSpeedDown: { value: 1.0 },
      uDt: { value: 1 / 60 },
      uReset: { value: 1 },
      uManual: { value: 1 },
    });
  }

  /** 1x1 texture: r = exposure multiplier, g = measured average luminance. */
  get texture(): THREE.Texture {
    return this.current.texture;
  }

  render(
    runner: PassRunner,
    source: THREE.Texture,
    sourceWidth: number,
    sourceHeight: number,
    manualExposure: number,
    frameDt: number,
    reset: boolean,
  ): void {
    this.lum.set('tSource', source);
    (this.lum.uniforms.uTexel.value as THREE.Vector2).set(1 / sourceWidth, 1 / sourceHeight);
    runner.run(this.lum.material, this.lumTarget);

    this.hist.set('tLuminance', this.lumTarget.texture);
    runner.run(this.hist.material, this.histTarget);

    const write = this.ping ? this.adaptB : this.adaptA;
    const read = this.ping ? this.adaptA : this.adaptB;
    this.ping = !this.ping;
    this.adapt.set('tHistogram', this.histTarget.texture);
    this.adapt.set('tPrevious', read.texture);
    this.adapt.set('uManual', manualExposure);
    this.adapt.set('uDt', Math.min(0.25, Math.max(1 / 480, frameDt)));
    this.adapt.set('uReset', reset ? 1 : 0);
    runner.run(this.adapt.material, write);
    this.current = write;
  }

  dispose(): void {
    this.lumTarget.dispose();
    this.histTarget.dispose();
    this.adaptA.dispose();
    this.adaptB.dispose();
    this.lum.dispose();
    this.hist.dispose();
    this.adapt.dispose();
  }
}
