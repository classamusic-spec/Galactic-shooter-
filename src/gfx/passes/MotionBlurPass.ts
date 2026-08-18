/**
 * Per-pixel motion blur with tile-max velocity dilation (McGuire et al. 2012).
 *
 * The naive version — blur each pixel along its own velocity — cannot work: a
 * fast-moving object has to smear *outside* its own silhouette, and a pixel on
 * the static background has zero velocity and so refuses to receive any of that
 * smear. The result is an object with a sharp leading edge, which reads as a
 * glitch rather than as speed.
 *
 * The fix is dilation. Velocity is reduced to a 16x16 tile maximum, then a 3x3
 * max over tiles, so every pixel knows the fastest motion in its neighbourhood
 * and can gather along it. Taps are jittered with blue noise (banding otherwise)
 * and weighted by a depth/velocity comparison so a static foreground object is
 * not smeared by a fast background.
 *
 * Blur length is hard-clamped to a fraction of screen height. Unclamped motion
 * blur during a 180-degree flick turns the frame into grey soup, and in a
 * first-person shooter that costs the player the fight.
 */
import * as THREE from 'three';
import { FullscreenPass, makeTarget } from './FullscreenPass';
import { GLSL_POST_COMMON } from '@/gfx/shaders/common';
import { BLUE_NOISE_TILE } from './BlueNoise';
import type { RenderContext } from './Context';

/** Tile edge in full-res pixels. 16 balances dilation quality against tile pop. */
const TILE = 16;
const MAX_TAPS = 12;

const TILE_MAX_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tVelocity;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uFullTexel;
uniform vec2 uTileCount;
uniform float uHasG;

/**
 * Strided 8x8 scan of each 16x16 tile. Every second texel is enough to find the
 * dominant motion — the signal is low frequency by construction — and halves the
 * fetch count.
 */
void main(){
  vec2 tile = floor(vUv * uTileCount);
  vec2 base = tile * ${TILE}.0;
  vec2 best = vec2(0.0);
  float bestLen = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      vec2 px = base + vec2(float(x), float(y)) * 2.0 + 0.5;
      vec2 uv = px * uFullTexel;
      if (uv.x >= 1.0 || uv.y >= 1.0) continue;
      float d = rawDepth(tDepth, uv);
      vec2 v = sampleVelocity(tVelocity, uv, d, uInvViewProj, uPrevViewProj, uHasG);
      float l = dot(v, v);
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  fragColor = vec4(best, sqrt(bestLen), 1.0);
}
`;

const NEIGHBOUR_MAX_FRAG = /* glsl */ `
uniform sampler2D tTiles;
uniform vec2 uTexel;

void main(){
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = texture(tTiles, vUv + vec2(float(x), float(y)) * uTexel).xyz;
      if (s.z > bestLen) { bestLen = s.z; best = s.xy; }
    }
  }
  fragColor = vec4(best, max(bestLen, 0.0), 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tVelocity;
uniform sampler2D tTiles;
uniform sampler2D tNoise;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uTexel;
uniform vec2 uSize;
uniform float uNear;
uniform float uFar;
uniform float uStrength;
uniform float uMaxLength;   // in uv units
uniform float uTaps;
uniform float uFrame;
uniform float uHasG;

void main(){
  vec2 uv = vUv;
  vec3 centre = texture(tColor, uv).rgb;
  vec3 tile = texture(tTiles, uv).xyz;

  float tileLen = tile.z * uStrength;
  // Under ~1.5 px of motion there is nothing to blur and the taps would only
  // soften the image.
  if (tileLen * uSize.y < 1.5) { fragColor = vec4(centre, 1.0); return; }

  vec2 dir = tile.xy * uStrength;
  float len = length(dir);
  if (len > uMaxLength) dir *= uMaxLength / len;

  float centreDepth = rawDepth(tDepth, uv);
  float centreZ = linearDepth(centreDepth, uNear, uFar);
  vec2 centreVel = sampleVelocity(tVelocity, uv, centreDepth, uInvViewProj, uPrevViewProj,
                                  uHasG) * uStrength;
  float centreVelLen = length(centreVel);

  vec2 pixel = uv / uTexel;
  float jitter = blueNoise(tNoise, pixel, ${BLUE_NOISE_TILE}.0, uFrame) - 0.5;

  int taps = int(uTaps + 0.5);
  vec3 sum = centre;
  float wsum = 1.0;

  for (int i = 1; i <= ${MAX_TAPS}; i++) {
    if (i > taps) break;
    // Symmetric taps either side of the pixel: a one-sided gather makes the
    // image appear to shift, not blur.
    float t = (float(i) + jitter) / float(taps + 1) * 0.5;
    for (int s = 0; s < 2; s++) {
      float sgn = s == 0 ? 1.0 : -1.0;
      vec2 suv = uv + dir * t * sgn;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
      float sd = rawDepth(tDepth, suv);
      float sz = linearDepth(sd, uNear, uFar);
      vec2 sv = sampleVelocity(tVelocity, suv, sd, uInvViewProj, uPrevViewProj, uHasG)
                * uStrength;
      float svLen = length(sv);

      // McGuire's two cases, simplified: a sample nearer the camera than us is
      // allowed to smear over us; a sample further away only contributes if it
      // is itself moving fast enough to have covered this pixel.
      float foreground = clamp(1.0 - (sz - centreZ) * 2.0, 0.0, 1.0);
      float background = clamp(1.0 - (centreZ - sz) * 2.0, 0.0, 1.0);
      float distUv = length(dir * t);
      float wForeground = foreground * clamp(svLen - distUv * 0.5, 0.0, 1.0) / max(svLen, 1e-5);
      float wBackground = background * clamp(centreVelLen - distUv * 0.5, 0.0, 1.0)
                          / max(centreVelLen, 1e-5);
      float w = clamp(max(wForeground, wBackground), 0.0, 1.0);
      // Never fully reject: a zero-weight ring around fast objects reads as an
      // outline. A small floor keeps the gather continuous.
      w = max(w, 0.06);
      sum += texture(tColor, suv).rgb * w;
      wsum += w;
    }
  }

  vec3 result = sum / max(wsum, 1e-4);
  if (any(isnan(result)) || any(isinf(result))) result = centre;
  fragColor = vec4(max(result, vec3(0.0)), 1.0);
}
`;

export class MotionBlurPass {
  private tilesA: THREE.WebGLRenderTarget;
  private tilesB: THREE.WebGLRenderTarget;
  private output: THREE.WebGLRenderTarget;
  private readonly tileMax: FullscreenPass;
  private readonly neighbourMax: FullscreenPass;
  private readonly blur: FullscreenPass;
  private width: number;
  private height: number;
  private tilesX: number;
  private tilesY: number;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.tilesX = Math.max(1, Math.ceil(this.width / TILE));
    this.tilesY = Math.max(1, Math.ceil(this.height / TILE));
    this.tilesA = makeTarget(this.tilesX, this.tilesY, 'mbTilesA', {
      filter: THREE.NearestFilter,
    });
    this.tilesB = makeTarget(this.tilesX, this.tilesY, 'mbTilesB', {
      // Linear on the dilated tiles softens the tile grid on the way back to
      // full resolution; nearest here shows 16 px staircase edges in the blur.
      filter: THREE.LinearFilter,
    });
    this.output = makeTarget(this.width, this.height, 'motionBlur');

    this.tileMax = new FullscreenPass(
      TILE_MAX_FRAG,
      {
        tDepth: { value: null },
        tVelocity: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uFullTexel: { value: new THREE.Vector2() },
        uTileCount: { value: new THREE.Vector2() },
        uHasG: { value: 0 },
      },
      { include: GLSL_POST_COMMON },
    );

    this.neighbourMax = new FullscreenPass(NEIGHBOUR_MAX_FRAG, {
      tTiles: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });

    this.blur = new FullscreenPass(
      BLUR_FRAG,
      {
        tColor: { value: null },
        tDepth: { value: null },
        tVelocity: { value: null },
        tTiles: { value: null },
        tNoise: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2() },
        uSize: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uStrength: { value: 0.6 },
        uMaxLength: { value: 0.05 },
        uTaps: { value: 8 },
        uFrame: { value: 0 },
        uHasG: { value: 0 },
      },
      { include: GLSL_POST_COMMON },
    );
  }

  get texture(): THREE.Texture {
    return this.output.texture;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.tilesX = Math.max(1, Math.ceil(w / TILE));
    this.tilesY = Math.max(1, Math.ceil(h / TILE));
    this.tilesA.setSize(this.tilesX, this.tilesY);
    this.tilesB.setSize(this.tilesX, this.tilesY);
    this.output.setSize(w, h);
  }

  render(ctx: RenderContext, source: THREE.Texture, strength: number): void {
    const { state } = ctx;

    const tm = this.tileMax;
    tm.set('tDepth', ctx.gbuffer.depthTexture);
    tm.set('tVelocity', ctx.gbuffer.velocity);
    (tm.uniforms.uInvViewProj.value as THREE.Matrix4).copy(state.invViewProj);
    (tm.uniforms.uPrevViewProj.value as THREE.Matrix4).copy(state.prevViewProj);
    (tm.uniforms.uFullTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (tm.uniforms.uTileCount.value as THREE.Vector2).set(this.tilesX, this.tilesY);
    tm.set('uHasG', ctx.gbuffer.hasGBuffer ? 1 : 0);
    ctx.runner.run(tm.material, this.tilesA);

    const nm = this.neighbourMax;
    nm.set('tTiles', this.tilesA.texture);
    (nm.uniforms.uTexel.value as THREE.Vector2).set(1 / this.tilesX, 1 / this.tilesY);
    ctx.runner.run(nm.material, this.tilesB);

    const b = this.blur;
    b.set('tColor', source);
    b.set('tDepth', ctx.gbuffer.depthTexture);
    b.set('tVelocity', ctx.gbuffer.velocity);
    b.set('tTiles', this.tilesB.texture);
    b.set('tNoise', ctx.noise);
    (b.uniforms.uInvViewProj.value as THREE.Matrix4).copy(state.invViewProj);
    (b.uniforms.uPrevViewProj.value as THREE.Matrix4).copy(state.prevViewProj);
    (b.uniforms.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (b.uniforms.uSize.value as THREE.Vector2).set(this.width, this.height);
    b.set('uNear', state.near);
    b.set('uFar', state.far);
    // The engine simulates at a fixed 120 Hz but renders at whatever the display
    // gives us, so velocity is already per-rendered-frame. Strength is the
    // shutter angle: 1.0 would be a 360-degree shutter, which no camera has.
    b.set('uStrength', strength * 0.85);
    b.set('uMaxLength', 0.055);
    b.set('uTaps', ctx.profile.tier === 'ultra' ? 12 : 8);
    b.set('uFrame', state.frame % 64);
    b.set('uHasG', ctx.gbuffer.hasGBuffer ? 1 : 0);
    ctx.runner.run(b.material, this.output);
  }

  dispose(): void {
    this.tilesA.dispose();
    this.tilesB.dispose();
    this.output.dispose();
    this.tileMax.dispose();
    this.neighbourMax.dispose();
    this.blur.dispose();
  }
}
