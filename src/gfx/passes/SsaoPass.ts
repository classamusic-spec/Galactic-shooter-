/**
 * Ground-Truth Ambient Occlusion (GTAO), half resolution, temporally accumulated.
 *
 * Not the three.js SSAOPass. That one samples a hemisphere of random offsets and
 * counts occluded samples, which converges slowly, has no notion of the surface's
 * cosine lobe, and produces the grey wash that makes browser games look like
 * browser games. GTAO instead sweeps a *horizon* per slice and evaluates the
 * analytic cosine-weighted visibility arc (Jimenez et al., Siggraph 2016). The
 * practical difference: contact darkening tucks tightly into creases and under
 * geometry, and open surfaces stay at 1.0 instead of drifting to 0.85 grey.
 *
 * Three quality levers, all from `settings.profile.ssaoSamples`, all uniforms
 * rather than defines so a tier switch never triggers a shader recompile (a
 * recompile mid-game is a visible hitch).
 *
 * The chain is: GTAO + temporal reprojection -> bilateral cross blur -> the
 * composite does a depth-aware bilinear upsample. Half resolution is not a
 * compromise here: AO is a low-frequency signal and the bilateral upsample keeps
 * the edges, so full-res GTAO costs 4x for no visible gain.
 */
import * as THREE from 'three';
import { FullscreenPass, halfSize, makeTarget } from './FullscreenPass';
import { GLSL_POST_COMMON } from '@/gfx/shaders/common';
import { BLUE_NOISE_TILE } from './BlueNoise';
import type { RenderContext } from './Context';

const MAX_SLICES = 4;
const MAX_STEPS = 8;

const GTAO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tVelocity;
uniform sampler2D tHistory;
uniform sampler2D tNoise;
uniform mat4 uInvProj;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uFullTexel;     // 1 / full-res size
uniform vec2 uHalfTexel;     // 1 / half-res size
uniform vec2 uProjScale;     // 0.5 * (proj[0][0], proj[1][1])
uniform float uNear;
uniform float uFar;
uniform float uRadius;       // world-space sample radius, metres
uniform float uThickness;    // 0 = paper-thin occluders, 1 = fully solid
uniform float uFrame;
uniform float uSlices;
uniform float uSteps;
uniform float uHistoryBlend;
uniform float uReset;
uniform float uHasG;

const float PI = 3.14159265359;
const float HALF_PI = 1.57079632679;

void main(){
  vec2 uv = vUv;
  float d = rawDepth(tDepth, uv);

  // Sky: nothing occludes it, and running the loop there is pure waste.
  if (d >= 0.999999) { fragColor = vec4(1.0, uFar, 1.0, 1.0); return; }

  vec3 P = viewPosFromDepth(uv, d, uInvProj);
  // The reconstruction baseline must be a *half-res* texel: this pass runs at
  // half resolution, so offsetting by one full-res texel puts the two samples
  // half a pixel apart. That tiny baseline is dominated by depth quantisation and
  // produced visibly striped AO across every large flat surface.
  vec3 N = sampleNormal(tNormal, tDepth, uv, uHalfTexel, uInvProj, uHasG);
  vec3 V = normalize(-P);
  float linZ = -P.z;

  vec2 pixel = uv / uHalfTexel;
  vec2 rnd = blueNoise2(tNoise, pixel, ${BLUE_NOISE_TILE}.0, uFrame);

  // World radius -> uv radius, per axis, so the disc stays circular in world
  // space at any aspect ratio. Clamped in pixels: an unbounded radius at close
  // range turns into a full-screen gather and destroys the texture cache.
  vec2 radiusUv = uRadius * uProjScale / max(linZ, 0.05);
  float maxUv = 110.0 * uFullTexel.y;
  float minUv = 2.2 * uFullTexel.y;
  float scale = clamp(maxUv / max(radiusUv.y, 1e-6), 0.0, 1.0);
  radiusUv *= scale;
  if (radiusUv.y < minUv) radiusUv *= minUv / max(radiusUv.y, 1e-6);

  float visibility = 0.0;
  float weightSum = 0.0;
  int slices = int(uSlices + 0.5);
  int steps = int(uSteps + 0.5);

  for (int s = 0; s < ${MAX_SLICES}; s++) {
    if (s >= slices) break;
    // Rotating the slice set per pixel *and* per frame is what lets 2 slices
    // look like 16: the blue-noise term decorrelates neighbours spatially, the
    // frame term hands the rest to the temporal filter.
    float phi = (float(s) + rnd.x) * PI / float(slices);
    vec2 dir = vec2(cos(phi), sin(phi));

    vec3 sliceDir = vec3(dir, 0.0);
    vec3 axis = normalize(cross(sliceDir, V));
    vec3 projN = N - axis * dot(N, axis);
    float projNLen = length(projN);
    if (projNLen < 1e-4) continue;
    vec3 orthoV = sliceDir - dot(sliceDir, V) * V;
    float cosN = clamp(dot(projN, V) / projNLen, -1.0, 1.0);
    float sgn = dot(orthoV, projN) < 0.0 ? -1.0 : 1.0;
    float n = sgn * acos(cosN);

    float cosH1 = -1.0;   // best horizon on the -dir side
    float cosH2 = -1.0;   // best horizon on the +dir side

    for (int t = 0; t < ${MAX_STEPS}; t++) {
      if (t >= steps) break;
      // Quadratic step distribution: contact shadows live in the first few
      // percent of the radius, so most taps belong there.
      float f = (float(t) + rnd.y) / float(steps);
      float march = f * f * 0.94 + 0.06;
      vec2 off = dir * radiusUv * march;

      vec2 uvA = uv - off;
      vec2 uvB = uv + off;

      if (uvA.x > 0.0 && uvA.x < 1.0 && uvA.y > 0.0 && uvA.y < 1.0) {
        float dA = rawDepth(tDepth, uvA);
        if (dA < 0.999999) {
          vec3 sA = viewPosFromDepth(uvA, dA, uInvProj) - P;
          float lA = length(sA);
          float cA = dot(sA, V) / max(lA, 1e-5);
          // Distance attenuation with a thickness heuristic: without it, a thin
          // railing occludes as if it were a wall and the whole scene behind it
          // goes dark.
          float attA = clamp(1.0 - (lA - uRadius) / max(uRadius * uThickness, 1e-3), 0.0, 1.0);
          cosH1 = max(cosH1, mix(-1.0, cA, attA));
        }
      }
      if (uvB.x > 0.0 && uvB.x < 1.0 && uvB.y > 0.0 && uvB.y < 1.0) {
        float dB = rawDepth(tDepth, uvB);
        if (dB < 0.999999) {
          vec3 sB = viewPosFromDepth(uvB, dB, uInvProj) - P;
          float lB = length(sB);
          float cB = dot(sB, V) / max(lB, 1e-5);
          float attB = clamp(1.0 - (lB - uRadius) / max(uRadius * uThickness, 1e-3), 0.0, 1.0);
          cosH2 = max(cosH2, mix(-1.0, cB, attB));
        }
      }
    }

    float h1 = -acos(clamp(cosH1, -1.0, 1.0));
    float h2 =  acos(clamp(cosH2, -1.0, 1.0));
    h1 = n + max(h1 - n, -HALF_PI);
    h2 = n + min(h2 - n,  HALF_PI);

    // The GTAO arc integral: cosine-weighted visibility of the unoccluded wedge.
    float a = 0.25 * (-cos(2.0 * h1 - n) + cos(n) + 2.0 * h1 * sin(n))
            + 0.25 * (-cos(2.0 * h2 - n) + cos(n) + 2.0 * h2 * sin(n));
    visibility += projNLen * a;
    weightSum += projNLen;
  }

  float ao = weightSum > 0.0 ? clamp(visibility / weightSum, 0.0, 1.0) : 1.0;

  // -- temporal accumulation -------------------------------------------------
  float history = ao;
  float age = 0.0;
  vec2 vel = sampleVelocity(tVelocity, uv, d, uInvViewProj, uPrevViewProj, uHasG);
  vec2 prevUv = uv - vel;
  if (uReset < 0.5 && prevUv.x > 0.0 && prevUv.x < 1.0 && prevUv.y > 0.0 && prevUv.y < 1.0) {
    vec3 h = texture(tHistory, prevUv).xyz;
    // Reject on depth discontinuity: reusing AO across a silhouette is what
    // leaves a dark comet trail behind moving geometry.
    float relative = abs(h.y - linZ) / max(linZ, 0.1);
    if (relative < 0.06) {
      age = h.z;
      float blend = uHistoryBlend * clamp(age * 4.0 + 0.25, 0.0, 1.0);
      history = mix(ao, h.x, blend);
    }
  }
  fragColor = vec4(history, linZ, min(age + 0.125, 1.0), 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tAo;
uniform vec2 uTexel;
uniform float uDepthSigma;

/**
 * Bilateral cross blur. A plain Gaussian would smear AO over silhouettes and
 * produce the halo that gives cheap SSAO away; weighting each tap by relative
 * depth keeps the gradient locked to the surface it belongs to.
 */
void main(){
  vec4 c = texture(tAo, vUv);
  float centreZ = c.y;
  float sum = c.x;
  float wsum = 1.0;
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      if (i == 0 && j == 0) continue;
      vec2 o = vec2(float(i), float(j)) * uTexel;
      vec4 s = texture(tAo, vUv + o);
      float spatial = exp(-float(i * i + j * j) * 0.28);
      float dz = abs(s.y - centreZ) / max(centreZ, 0.1);
      float range = exp(-dz * dz * uDepthSigma);
      float w = spatial * range;
      sum += s.x * w;
      wsum += w;
    }
  }
  fragColor = vec4(sum / wsum, centreZ, c.z, 1.0);
}
`;

/** Slices/steps per tier. Kept in one table so the mapping is auditable. */
function sliceSteps(samples: number): { slices: number; steps: number } {
  if (samples >= 24) return { slices: 3, steps: 5 };
  if (samples >= 16) return { slices: 2, steps: 6 };
  if (samples >= 8) return { slices: 2, steps: 3 };
  return { slices: 1, steps: 3 };
}

export class SsaoPass {
  /** The blurred, half-resolution AO the composite upsamples. r = AO, g = depth. */
  private blurTarget: THREE.WebGLRenderTarget;
  private historyA: THREE.WebGLRenderTarget;
  private historyB: THREE.WebGLRenderTarget;
  private readonly gtao: FullscreenPass;
  private readonly blur: FullscreenPass;
  private width = 1;
  private height = 1;
  private ping = false;

  constructor(width: number, height: number) {
    this.width = halfSize(width);
    this.height = halfSize(height);
    this.historyA = makeTarget(this.width, this.height, 'ssaoA');
    this.historyB = makeTarget(this.width, this.height, 'ssaoB');
    this.blurTarget = makeTarget(this.width, this.height, 'ssaoBlur');

    this.gtao = new FullscreenPass(
      GTAO_FRAG,
      {
        tDepth: { value: null },
        tNormal: { value: null },
        tVelocity: { value: null },
        tHistory: { value: null },
        tNoise: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uFullTexel: { value: new THREE.Vector2() },
        uHalfTexel: { value: new THREE.Vector2() },
        uProjScale: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uRadius: { value: 1.1 },
        uThickness: { value: 0.45 },
        uFrame: { value: 0 },
        uSlices: { value: 2 },
        uSteps: { value: 5 },
        uHistoryBlend: { value: 0.9 },
        uReset: { value: 1 },
        uHasG: { value: 0 },
      },
      { include: GLSL_POST_COMMON },
    );

    this.blur = new FullscreenPass(BLUR_FRAG, {
      tAo: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDepthSigma: { value: 900 },
    });
  }

  /** Half-resolution AO texture: r = visibility, g = linear view depth. */
  get texture(): THREE.Texture {
    return this.blurTarget.texture;
  }

  setSize(width: number, height: number): void {
    const w = halfSize(width);
    const h = halfSize(height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.historyA.setSize(w, h);
    this.historyB.setSize(w, h);
    this.blurTarget.setSize(w, h);
  }

  render(ctx: RenderContext): void {
    const { state, profile } = ctx;
    const { slices, steps } = sliceSteps(profile.ssaoSamples);
    const write = this.ping ? this.historyB : this.historyA;
    const read = this.ping ? this.historyA : this.historyB;
    this.ping = !this.ping;

    const g = this.gtao;
    g.set('tDepth', ctx.gbuffer.depthTexture);
    g.set('tNormal', ctx.gbuffer.normal);
    g.set('tVelocity', ctx.gbuffer.velocity);
    g.set('tHistory', read.texture);
    g.set('tNoise', ctx.noise);
    (g.uniforms.uInvProj.value as THREE.Matrix4).copy(state.invProj);
    (g.uniforms.uInvViewProj.value as THREE.Matrix4).copy(state.invViewProj);
    (g.uniforms.uPrevViewProj.value as THREE.Matrix4).copy(state.prevViewProj);
    (g.uniforms.uFullTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    (g.uniforms.uHalfTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (g.uniforms.uProjScale.value as THREE.Vector2).set(
      0.5 * state.proj.elements[0],
      0.5 * state.proj.elements[5],
    );
    g.set('uNear', state.near);
    g.set('uFar', state.far);
    g.set('uFrame', state.frame % 64);
    g.set('uSlices', slices);
    g.set('uSteps', steps);
    // A 1.1 m radius is tuned to this world scale: it reads as contact shadowing
    // at a 1.7 m eye height without turning corridor corners into dark bands.
    // 1.6 m at this world scale (1.7 m eye height) reads as Destiny-style wide
    // occlusion rather than a thin contact line, without darkening corridors.
    g.set('uRadius', profile.tier === 'low' ? 1.0 : 1.6);
    g.set('uHistoryBlend', 0.92);
    g.set('uReset', state.reset ? 1 : 0);
    g.set('uHasG', ctx.gbuffer.hasGBuffer ? 1 : 0);
    ctx.runner.run(g.material, write);

    const b = this.blur;
    b.set('tAo', write.texture);
    (b.uniforms.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    ctx.runner.run(b.material, this.blurTarget);
  }

  dispose(): void {
    this.historyA.dispose();
    this.historyB.dispose();
    this.blurTarget.dispose();
    this.gtao.dispose();
    this.blur.dispose();
  }
}
