/**
 * Volumetric sunlight (god rays), half resolution, ray-marched from depth.
 *
 * Atmosphere is the single biggest "expensive vs cheap" tell in a frame, and
 * light shafts are the cheapest way to buy it. The march is in world space from
 * the eye to the depth buffer, integrating an exponential height-fog medium with
 * a Henyey-Greenstein phase function toward `level.sunDirection`.
 *
 * ## Occlusion without a shadow map
 *
 * True shafts need to know what blocks the sun. Reading the level's cascaded
 * shadow map would couple this pass to another author's light rig, its cascade
 * count, its VSM encoding and its bias tuning — a contract nobody agreed to. So
 * each march sample instead fires a single, jittered *screen-space* shadow ray:
 * step toward the sun and ask the depth buffer whether that point is hidden. One
 * tap per march step is noisy on its own; the march averages `volumetricSteps` of
 * them, blue noise decorrelates neighbours, and a reprojected temporal history
 * converges the rest. The result is real shafts from real on-screen geometry —
 * arches, cliffs, wrecks — with no cross-system coupling.
 *
 * Off-screen occluders are missed. That is the known cost, and it is the right
 * trade for a first-person camera where the shaft-casting geometry is nearly
 * always in frame.
 */
import * as THREE from 'three';
import { FullscreenPass, halfSize, makeTarget } from './FullscreenPass';
import { GLSL_POST_COMMON } from '@/gfx/shaders/common';
import { BLUE_NOISE_TILE } from './BlueNoise';
import type { RenderContext } from './Context';

const MAX_STEPS = 48;

const FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tVelocity;
uniform sampler2D tHistory;
uniform sampler2D tNoise;
uniform mat4 uInvProj;
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;        // toward the sun
uniform vec3 uSunColor;
uniform vec2 uTexel;
uniform vec2 uFullTexel;
uniform float uNear;
uniform float uFar;
uniform float uSteps;
uniform float uMaxDistance;
uniform float uDensity;
uniform float uHeightFalloff;
uniform float uGroundLevel;
uniform float uAnisotropy;
uniform float uShadowRange;
uniform float uFrame;
uniform float uReset;
uniform float uIntensity;
uniform float uHasG;

/** Henyey-Greenstein. g near 0.7 gives the forward-scattered bloom of real haze. */
float phaseHG(float cosT, float g){
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosT;
  return (1.0 - g2) / (12.566370614 * max(denom * sqrt(max(denom, 1e-4)), 1e-4));
}

float mediumDensity(vec3 p){
  return uDensity * exp(-max(p.y - uGroundLevel, 0.0) * uHeightFalloff);
}

/**
 * Screen-space shadow ray. One jittered tap toward the sun: is that point hidden
 * behind something the camera can see? If so, the sun is blocked here.
 */
float sunVisibility(vec3 p, float jitter){
  vec3 q = p + uSunDir * (uShadowRange * (0.12 + 0.88 * jitter));
  vec4 clip = uViewProj * vec4(q, 1.0);
  if (clip.w <= 0.0) return 1.0;
  vec3 ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) return 1.0;
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float sceneD = rawDepth(tDepth, uv);
  if (sceneD >= 0.999999) return 1.0;
  float sceneZ = linearDepth(sceneD, uNear, uFar);
  float sampleZ = linearDepth(ndc.z * 0.5 + 0.5, uNear, uFar);
  // Bias scales with distance: a fixed epsilon self-shadows the far field and
  // leaves a gap at the near field.
  float bias = 0.06 + sampleZ * 0.012;
  float behind = sampleZ - sceneZ - bias;
  if (behind <= 0.0) return 1.0;
  // Thickness fade: an occluder the ray passes a long way behind is treated as
  // solid, one it barely clips is treated as a partial blocker. Without this,
  // every silhouette edge becomes a hard-edged black stripe in the fog.
  return 1.0 - clamp(behind / 3.0, 0.0, 1.0);
}

void main(){
  vec2 uv = vUv;
  float d = rawDepth(tDepth, uv);
  vec3 worldFar = worldPosFromDepth(uv, min(d, 0.9999995), uInvViewProj);
  vec3 rayDir = worldFar - uCameraPos;
  float sceneDist = length(rayDir);
  rayDir /= max(sceneDist, 1e-5);
  float march = min(sceneDist, uMaxDistance);
  float linZ = d >= 0.999999 ? uFar : linearDepth(d, uNear, uFar);

  int steps = int(uSteps + 0.5);
  vec2 pixel = uv / uTexel;
  vec2 rnd = blueNoise2(tNoise, pixel, ${BLUE_NOISE_TILE}.0, uFrame);

  float cosT = dot(rayDir, uSunDir);
  float phase = phaseHG(cosT, uAnisotropy) * 12.566370614;
  // A floor of isotropic scattering keeps the medium visible when looking away
  // from the sun; without it the fog vanishes behind you and depth cues die.
  // The ceiling matters just as much: at g = 0.72 the forward lobe peaks above
  // 20x isotropic, which turned the area around the sun into a blown-out white
  // disc that bloom then made worse. 7x still reads as a strong glow.
  phase = min(mix(1.0, phase, 0.82), 7.0);

  float stepLen = march / float(steps);
  vec3 accum = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < ${MAX_STEPS}; i++) {
    if (i >= steps) break;
    float t = (float(i) + rnd.x) * stepLen;
    vec3 p = uCameraPos + rayDir * t;
    float sigma = mediumDensity(p);
    if (sigma < 1e-6) continue;
    float seg = sigma * stepLen;
    float vis = sunVisibility(p, fract(rnd.y + float(i) * 0.6180339887));
    accum += transmittance * seg * vis;
    transmittance *= exp(-seg);
    if (transmittance < 0.008) break;
  }

  vec3 scattered = accum * uSunColor * phase * uIntensity;

  // -- temporal accumulation -------------------------------------------------
  vec2 vel = sampleVelocity(tVelocity, uv, d, uInvViewProj, uPrevViewProj, uHasG);
  vec2 prevUv = uv - vel;
  if (uReset < 0.5 && prevUv.x > 0.0 && prevUv.x < 1.0 && prevUv.y > 0.0 && prevUv.y < 1.0) {
    vec4 h = texture(tHistory, prevUv);
    float relative = abs(h.w - linZ) / max(linZ, 0.5);
    if (relative < 0.12) {
      // The march is stochastic (one shadow ray per step), so this is doing the
      // heavy lifting on noise: at 0.88 the residual blotching was still visible
      // in the dark upper half of the frame. 0.93 is about a 14-frame history,
      // which the medium's low frequency tolerates without visible lag.
      scattered = mix(scattered, h.rgb, 0.93);
    }
  }
  fragColor = vec4(max(scattered, vec3(0.0)), linZ);
}
`;

export class VolumetricPass {
  private historyA: THREE.WebGLRenderTarget;
  private historyB: THREE.WebGLRenderTarget;
  private readonly pass: FullscreenPass;
  private width: number;
  private height: number;
  private ping = false;
  private last: THREE.WebGLRenderTarget;

  /** Tunable medium. Overwritten per level from the scene's fog when present. */
  density = 0.012;
  heightFalloff = 0.035;
  groundLevel = 0;
  /**
   * Scattering albedo scalar.
   *
   * Tuned against the debug view and then against the low-tier frame, which has
   * no volumetrics at all: at 0.85 the shafts sat below the sky's own brightness
   * and read as flat haze, while at 1.9 the medium added enough total light that
   * auto-exposure pulled the whole high-tier frame visibly darker than the same
   * shot at low. 1.35 keeps the beams reading as beams and the two tiers within a
   * stop of each other.
   */
  intensity = 1.35;

  constructor(width: number, height: number) {
    this.width = halfSize(width);
    this.height = halfSize(height);
    this.historyA = makeTarget(this.width, this.height, 'volA');
    this.historyB = makeTarget(this.width, this.height, 'volB');
    this.last = this.historyA;
    this.pass = new FullscreenPass(
      FRAG,
      {
        tDepth: { value: null },
        tVelocity: { value: null },
        tHistory: { value: null },
        tNoise: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uInvViewProj: { value: new THREE.Matrix4() },
        uViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uTexel: { value: new THREE.Vector2() },
        uFullTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uSteps: { value: 24 },
        uMaxDistance: { value: 260 },
        uDensity: { value: 0.012 },
        uHeightFalloff: { value: 0.035 },
        uGroundLevel: { value: 0 },
        uAnisotropy: { value: 0.72 },
        uShadowRange: { value: 26 },
        uFrame: { value: 0 },
        uReset: { value: 1 },
        uIntensity: { value: 1.35 },
        uHasG: { value: 0 },
      },
      { include: GLSL_POST_COMMON },
    );
  }

  /** rgb = inscattered radiance, a = linear view depth (for the upsample). */
  get texture(): THREE.Texture {
    return this.last.texture;
  }

  setSize(width: number, height: number): void {
    const w = halfSize(width);
    const h = halfSize(height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.historyA.setSize(w, h);
    this.historyB.setSize(w, h);
  }

  render(ctx: RenderContext, camera: THREE.Camera): void {
    const { state, profile } = ctx;
    const write = this.ping ? this.historyB : this.historyA;
    const read = this.ping ? this.historyA : this.historyB;
    this.ping = !this.ping;
    this.last = write;

    const p = this.pass;
    p.set('tDepth', ctx.gbuffer.depthTexture);
    p.set('tVelocity', ctx.gbuffer.velocity);
    p.set('tHistory', read.texture);
    p.set('tNoise', ctx.noise);
    (p.uniforms.uInvProj.value as THREE.Matrix4).copy(state.invProj);
    (p.uniforms.uInvViewProj.value as THREE.Matrix4).copy(state.invViewProj);
    (p.uniforms.uViewProj.value as THREE.Matrix4).copy(state.viewProj);
    (p.uniforms.uPrevViewProj.value as THREE.Matrix4).copy(state.prevViewProj);
    (p.uniforms.uCameraPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    (p.uniforms.uSunDir.value as THREE.Vector3).copy(ctx.sunDirection);
    (p.uniforms.uSunColor.value as THREE.Color).copy(ctx.sunColor);
    (p.uniforms.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (p.uniforms.uFullTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    p.set('uNear', state.near);
    p.set('uFar', state.far);
    p.set('uSteps', Math.min(MAX_STEPS, Math.max(6, profile.volumetricSteps)));
    p.set('uMaxDistance', Math.min(state.far * 0.7, 280));
    p.set('uDensity', this.density);
    p.set('uHeightFalloff', this.heightFalloff);
    p.set('uGroundLevel', this.groundLevel);
    p.set('uShadowRange', 26);
    p.set('uFrame', state.frame % 64);
    p.set('uReset', state.reset ? 1 : 0);
    p.set('uIntensity', this.intensity);
    p.set('uHasG', ctx.gbuffer.hasGBuffer ? 1 : 0);
    ctx.runner.run(p.material, write);
  }

  dispose(): void {
    this.historyA.dispose();
    this.historyB.dispose();
    this.pass.dispose();
  }
}
