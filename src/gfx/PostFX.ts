/**
 * PostFX — the render pipeline.
 *
 * Installs itself as `engine.renderPipeline`, which is the single seam between
 * the game and the screen (see docs/ARCHITECTURE.md). Nothing else in the
 * codebase needs to know this file exists.
 *
 * ## Shape of a frame
 *
 *   scene  -> HDR MRT (colour / normal+roughness / velocity + FloatType depth)
 *   depth  -> GTAO           (half res, temporal)
 *   depth  -> volumetrics    (half res, temporal, ray-marched toward the sun)
 *   colour -> TAA or FXAA    (full res, ping-ponged history)
 *          -> motion blur    (tile-max dilated, optional)
 *          -> bloom pyramid  (6 mips, Karis, progressive up)
 *          -> auto-exposure  (32x32 -> 16-bin histogram -> 1x1, no readback)
 *          -> composite      (everything else, one pass, straight to the canvas)
 *
 * Measured: 1 scene pass plus 22 fullscreen passes at `high` (16 at `low`), of
 * which only four (TAA, motion blur, composite, and bloom's prefilter read) touch
 * full resolution — eleven of the 22 are bloom mips at 1/4 area and below, three
 * are 32x32 or smaller. Total draw calls for the whole chain measured at +7 over
 * the same scene with every optional pass disabled. The alternative — one
 * `EffectComposer` pass per effect — would be eight full-resolution HDR
 * read/write round trips instead.
 *
 * ## Things that must not break
 *
 * - **Resize, including prime dimensions.** Every derived size is `ceil(w/2)` or
 *   `ceil(w/16)`, never an assumed power of two, and every shader addresses its
 *   inputs through an explicit texel-size uniform rather than assuming its own
 *   resolution matches its source's.
 * - **Runtime tier switches.** Sample counts, step counts and radii are all
 *   *uniforms*, not `#define`s, so `settings.setTier()` never triggers a shader
 *   recompile mid-game. Passes that a tier disables entirely are created and
 *   destroyed on demand, and history is invalidated so nothing blends across the
 *   change.
 * - **A null level.** The engine can be in a menu with no scene at all, and
 *   `onLevelChanged(null)`-equivalent state (no sun, no fog) has to produce a
 *   sane frame rather than NaN.
 */
import * as THREE from 'three';
import type { Engine } from '@/core/Engine';
import type { FrameContext, Level } from '@/types';
import { settings } from '@/core/Settings';
import { events } from '@/core/EventBus';
import { clamp, clamp01, damp } from '@/util/math';

import { PassRunner } from './passes/FullscreenPass';
import { GBuffer, clearVelocityTracking, type GBufferMode } from './passes/GBuffer';
import { blueNoiseTexture } from './passes/BlueNoise';
import { SsaoPass } from './passes/SsaoPass';
import { VolumetricPass } from './passes/VolumetricPass';
import { BloomPass } from './passes/BloomPass';
import { TaaPass } from './passes/TaaPass';
import { MotionBlurPass } from './passes/MotionBlurPass';
import { ExposurePass } from './passes/ExposurePass';
import { CompositePass, MAX_DISTORTIONS } from './passes/CompositePass';
import type { RenderContext } from './passes/Context';
import { buildGradeLut } from './shaders/lut';

// Re-exported so other subsystems can opt into true motion vectors without
// reaching into the passes directory.
export {
  enableObjectVelocity,
  trackVelocity,
  untrackVelocity,
  installGBufferChunks,
} from './passes/GBuffer';
export { GRADE_PRESETS } from './shaders/lut';

/** IEEE-754 binary16 -> number. Needed to inspect a HalfFloatType readback. */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h & 0x7c00) >> 10;
  const fraction = h & 0x03ff;
  if (exponent === 0) return sign * 6.103515625e-5 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

/** Buffer inspection modes; the index is what the composite shader switches on. */
const DEBUG_VIEWS = [
  'off',
  'ao',
  'volumetric',
  'normals',
  'velocity',
  'bloom',
  'depth',
] as const;
export type DebugView = (typeof DEBUG_VIEWS)[number];

/** Preallocated constants: events fire in gameplay hot paths, so no `new` here. */
const SUPER_FLASH_TINT = new THREE.Color(0.6, 0.92, 1);
const AO_TINT_NEUTRAL = new THREE.Color(0.5, 0.5, 0.5);

/** One live screen-space distortion (heat shimmer, shockwave). */
interface Distortion {
  position: THREE.Vector3;
  radius: number;
  strength: number;
  life: number;
  age: number;
  active: boolean;
}

/** Planet id -> grade preset. Levels are identified by `level.id`. */
const LEVEL_GRADES: Record<string, string> = {
  aurvangr: 'aurvangr',
  'zeta-reticuli': 'zeta-reticuli',
  khepri: 'khepri',
  'hive-prime': 'hive-prime',
  'draco-ix': 'draco-ix',
  starmap: 'orbit',
  orbit: 'orbit',
  ship: 'ship',
};

export class PostFX {
  readonly name = 'postfx';

  private readonly engine: Engine;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly runner: PassRunner;
  private readonly gbuffer: GBuffer;
  private readonly taa: TaaPass;
  private readonly bloom: BloomPass;
  private readonly exposure: ExposurePass;
  private readonly composite: CompositePass;
  private ssao: SsaoPass | null = null;
  private volumetric: VolumetricPass | null = null;
  private motionBlur: MotionBlurPass | null = null;

  private readonly noise: THREE.DataTexture;
  private readonly luts = new Map<string, THREE.Data3DTexture>();
  private lut: THREE.Data3DTexture;
  private gradeName = 'neutral';
  private gradeOverride: string | null = null;

  private width = 1;
  private height = 1;
  private elapsed = 0;
  private level: Level | null = null;

  private readonly sunDirection = new THREE.Vector3(0.4, 0.62, 0.68).normalize();
  private readonly sunColor = new THREE.Color(1, 0.96, 0.9);
  private readonly fogColor = new THREE.Color(0.42, 0.5, 0.62);
  private readonly aoTint = new THREE.Color();
  private readonly cameraPos = new THREE.Vector3();

  /** Aerial-perspective medium, re-derived per level from the scene's fog. */
  private fogDensity = 0.0035;
  private fogHeightFalloff = 0.03;
  private fogGround = 0;
  private fogInscatter = 0.5;

  private debugView = 0;
  private damage = 0;
  private flash = 0;
  private readonly flashColor = new THREE.Color(1, 1, 1);
  private readonly distortions: Distortion[] = [];
  private readonly distortVec: THREE.Vector4[];
  private readonly distortWave: THREE.Vector2[];

  private depthConsumer: ((t: THREE.Texture) => void) | null = null;
  private readonly unsubscribes: Array<() => void> = [];
  private disposed = false;

  private readonly ctx: RenderContext;

  constructor(engine: Engine) {
    this.engine = engine;
    this.renderer = engine.host.renderer;

    // The chain owns tone mapping and colour encoding from here on. Leaving
    // three's ACES approximation on would apply a second, different curve to the
    // scene pass and everything downstream would be grading an already-mapped
    // image.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    // Clears are explicit: the bloom upsample chain accumulates into the target
    // it draws over and must never be auto-cleared.
    this.renderer.autoClear = false;

    const size = engine.host.drawingBufferSize;
    this.width = Math.max(1, Math.round(size.x) || 1);
    this.height = Math.max(1, Math.round(size.y) || 1);

    this.runner = new PassRunner(this.renderer);
    this.gbuffer = new GBuffer(this.renderer, this.width, this.height);
    this.taa = new TaaPass(this.width, this.height);
    this.bloom = new BloomPass(this.width, this.height);
    this.exposure = new ExposurePass();
    this.composite = new CompositePass();
    this.noise = blueNoiseTexture();
    this.lut = this.gradeLut('neutral');

    this.distortVec = this.composite.uniforms.uDistort.value as THREE.Vector4[];
    this.distortWave = this.composite.uniforms.uDistortWave.value as THREE.Vector2[];
    for (let i = 0; i < MAX_DISTORTIONS; i++) {
      this.distortions.push({
        position: new THREE.Vector3(),
        radius: 1,
        strength: 0,
        life: 1,
        age: 0,
        active: false,
      });
    }

    this.ctx = {
      runner: this.runner,
      renderer: this.renderer,
      gbuffer: this.gbuffer,
      state: this.gbuffer.state,
      profile: settings.profile,
      user: settings.user,
      noise: this.noise,
      frameDt: 1 / 60,
      elapsed: 0,
      sunDirection: this.sunDirection,
      sunColor: this.sunColor,
      fogColor: this.fogColor,
      width: this.width,
      height: this.height,
    };

    this.applyTier();

    // The engine drives `update` at a fixed 120 Hz; distortion ageing and the
    // damage/flash envelopes belong there, not in render(), so they behave the
    // same regardless of frame rate.
    engine.add(this);
    engine.renderPipeline = this.pipeline;

    this.unsubscribes.push(
      events.on('settings:changed', () => this.applyTier()),
      events.on('player:damaged', (p) => {
        if (settings.user.reducedMotion) return;
        // Shield break is a bigger, whiter hit than a health hit.
        const amount = clamp01(p.amount / 60) * (p.shieldBroke ? 1.1 : 0.8);
        this.damage = clamp01(Math.max(this.damage, 0.22 + amount * 0.55));
      }),
      events.on('super:activated', () => {
        if (settings.user.reducedMotion) return;
        this.flash = 0.72;
        this.flashColor.copy(this.sunColor).lerp(SUPER_FLASH_TINT, 0.7);
      }),
      events.on('player:respawn', () => {
        this.damage = 0;
        this.flash = 0;
        this.gbuffer.invalidateHistory();
      }),
    );

    this.publishDepth();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Pick up a level's lighting contract. `sunDirection`, `sunColor` and
   * `fogColor` are the only things the post chain needs from a level, and they
   * are exactly what `Level` promises.
   */
  onLevelChanged(level: Level): void {
    this.level = level ?? null;
    if (level) {
      // Levels express the sun as a direction; normalise defensively because a
      // zero or unnormalised vector would put NaN through the volumetric phase
      // function and blank the frame.
      const dir = level.sunDirection;
      if (dir && Number.isFinite(dir.x) && dir.lengthSq() > 1e-6) {
        this.sunDirection.copy(dir).normalize();
      }
      if (level.sunColor) this.sunColor.copy(level.sunColor);
      if (level.fogColor) this.fogColor.copy(level.fogColor);
      this.deriveFogFromScene(level.scene);
      if (!this.gradeOverride) {
        this.setGrade(LEVEL_GRADES[level.id] ?? 'neutral');
      }
    } else {
      this.fogDensity = 0;
    }

    // AO is tinted with a dark, *partly* desaturated version of the sky fill: a
    // crease loses coloured bounce light, so neutral grey occlusion reads as dirt
    // — but a fully saturated tint swings every shadow hard toward the fog hue,
    // which on an ice world turned the whole midground electric blue.
    this.aoTint.copy(this.fogColor).lerp(AO_TINT_NEUTRAL, 0.45).multiplyScalar(0.34);

    // Anything reprojected across a level change is meaningless.
    clearVelocityTracking();
    this.gbuffer.invalidateHistory();
    this.damage = 0;
    this.flash = 0;
    for (const d of this.distortions) d.active = false;
  }

  /**
   * Register a screen-space distortion at a world position — explosion
   * shockwaves, heat shimmer off a vent, a warp effect.
   *
   * Sources are pooled and projected to screen space on the CPU once per frame,
   * so this costs nothing but an array slot; there is no per-call allocation and
   * no texture involved. The oldest source is recycled when the pool is full,
   * because dropping the *newest* explosion is the wrong failure mode.
   */
  requestDistortion(worldPos: THREE.Vector3, radius: number, strength: number, life: number): void {
    if (settings.user.reducedMotion) return;
    let slot = this.distortions.find((d) => !d.active);
    if (!slot) {
      slot = this.distortions[0];
      for (const d of this.distortions) if (d.age / d.life > slot.age / slot.life) slot = d;
    }
    slot.position.copy(worldPos);
    slot.radius = Math.max(0.05, radius);
    slot.strength = strength;
    slot.life = Math.max(0.05, life);
    slot.age = 0;
    slot.active = true;
  }

  /**
   * Force a colour-grade preset, overriding the per-level choice. Pass an unknown
   * name (or `'auto'`) to hand control back to the level.
   */
  setColorGrade(preset: string): void {
    if (preset === 'auto') {
      this.gradeOverride = null;
      const id = this.level?.id;
      this.setGrade((id && LEVEL_GRADES[id]) || 'neutral');
      return;
    }
    this.gradeOverride = preset;
    this.setGrade(preset);
  }

  /**
   * Switch the scene pass between depth reconstruction (default) and a true MRT
   * G-buffer.
   *
   * Only worth `'mrt'` once every material in the level writes the extra
   * attachments — see GBuffer for the GLES3 rule that makes this a per-scene
   * decision rather than a global one. A rejected opt-in downgrades itself on the
   * first frame instead of dropping draw calls.
   */
  setGBufferMode(mode: GBufferMode): void {
    this.gbuffer.setMode(mode);
    this.publishDepth();
  }

  /** Which G-buffer mode actually survived the driver probe. */
  get gbufferMode(): GBufferMode {
    return this.gbuffer.currentMode;
  }

  /**
   * Hand the scene depth texture to another subsystem — VfxSystem wants it for
   * soft particles. Called immediately with the current texture, and again every
   * time a resize forces a new one, so the consumer never holds a stale handle.
   */
  setDepthTextureConsumer(fn: (t: THREE.Texture) => void): void {
    this.depthConsumer = fn;
    this.publishDepth();
  }

  /**
   * QA hook: scan the resolved HDR buffer for NaN/Inf.
   *
   * The composite clamps to [0,1] before writing the framebuffer, so a NaN in the
   * HDR chain is *invisible* in a canvas screenshot — it silently becomes black or
   * white. The only way to catch one is to read the half-float buffer itself and
   * decode it, which is what this does. Called by the capture harness, not by the
   * game; it stalls the pipeline and must never run per frame.
   */
  debugScanForNaN(): { samples: number; nan: number; inf: number; max: number } {
    const target = this.taa.currentTarget;
    const w = Math.min(256, this.width);
    const h = Math.min(256, this.height);
    const buffer = new Uint16Array(w * h * 4);
    let nan = 0;
    let inf = 0;
    let max = 0;
    try {
      this.renderer.readRenderTargetPixels(target, 0, 0, w, h, buffer);
    } catch {
      return { samples: 0, nan: 0, inf: 0, max: 0 };
    }
    for (let i = 0; i < buffer.length; i++) {
      const v = halfToFloat(buffer[i]);
      if (Number.isNaN(v)) nan++;
      else if (!Number.isFinite(v)) inf++;
      else if (v > max) max = v;
    }
    return { samples: buffer.length, nan, inf, max };
  }

  /**
   * Inspect one stage of the chain in isolation.
   *
   * `'off' | 'ao' | 'volumetric' | 'normals' | 'velocity' | 'bloom' | 'depth'`.
   * A post chain you cannot look at buffer-by-buffer is a chain you cannot tune —
   * every value in these passes was set by switching one of these on and looking.
   */
  setDebugView(mode: DebugView): void {
    this.debugView = DEBUG_VIEWS.indexOf(mode) < 0 ? 0 : DEBUG_VIEWS.indexOf(mode);
  }

  /** Tuning hook for the aerial-perspective medium; levels may override. */
  setAerialPerspective(density: number, heightFalloff: number, inscatter: number): void {
    this.fogDensity = Math.max(0, density);
    this.fogHeightFalloff = Math.max(1e-4, heightFalloff);
    this.fogInscatter = Math.max(0, inscatter);
  }

  // -------------------------------------------------------------------------
  // EngineSystem
  // -------------------------------------------------------------------------

  /** Fixed 120 Hz. Envelopes and distortion ageing live here, never in render. */
  update(ctx: FrameContext): void {
    const dt = ctx.dt;
    // Damage vignette: fast attack (handled by the event), slow decay.
    this.damage = this.damage > 1e-4 ? damp(this.damage, 0, 3.2, dt) : 0;
    this.flash = this.flash > 1e-4 ? damp(this.flash, 0, 5.5, dt) : 0;
    for (const d of this.distortions) {
      if (!d.active) continue;
      d.age += dt;
      if (d.age >= d.life) d.active = false;
    }
  }

  // -------------------------------------------------------------------------
  // The pipeline
  // -------------------------------------------------------------------------

  private pipeline = (scene: THREE.Scene, camera: THREE.Camera, frameDt: number): void => {
    if (this.disposed) return;
    const perspective = camera as THREE.PerspectiveCamera;
    const size = this.engine.host.drawingBufferSize;
    const w = Math.max(1, Math.round(size.x) || 1);
    const h = Math.max(1, Math.round(size.y) || 1);
    if (w !== this.width || h !== this.height) this.setSize(w, h);

    const dt = Number.isFinite(frameDt) ? clamp(frameDt, 1 / 480, 0.25) : 1 / 60;
    this.elapsed += dt;

    const ctx = this.ctx;
    ctx.profile = settings.profile;
    ctx.user = settings.user;
    ctx.frameDt = dt;
    ctx.elapsed = this.elapsed;
    ctx.width = this.width;
    ctx.height = this.height;

    const profile = ctx.profile;
    const user = ctx.user;
    const reduced = user.reducedMotion;
    const useTaa = profile.taaEnabled;

    // -- 1. scene into the HDR MRT ------------------------------------------
    this.gbuffer.beginFrame(perspective, useTaa);
    this.gbuffer.render(scene, camera);
    this.cameraPos.setFromMatrixPosition(camera.matrixWorld);

    // -- 2. SSAO -------------------------------------------------------------
    if (this.ssao) this.ssao.render(ctx);

    // -- 3. volumetric light -------------------------------------------------
    if (this.volumetric) this.volumetric.render(ctx, camera);

    // -- 4. temporal AA (or FXAA) -------------------------------------------
    this.taa.render(ctx, useTaa);
    let colour = this.taa.texture;

    // -- 5. motion blur ------------------------------------------------------
    const motionStrength = reduced ? 0 : user.motionBlurStrength;
    if (this.motionBlur && motionStrength > 0.01) {
      this.motionBlur.render(ctx, colour, motionStrength);
      colour = this.motionBlur.texture;
    }

    // -- 6. auto-exposure ----------------------------------------------------
    // Runs before bloom so the pyramid's threshold sees this frame's exposure,
    // and reads the resolved colour so the measurement is not jitter-dependent.
    this.exposure.render(
      this.runner,
      colour,
      this.width,
      this.height,
      Math.max(0.05, user.exposure),
      dt,
      this.gbuffer.state.reset,
    );

    // -- 7. bloom ------------------------------------------------------------
    const bloomStrength = profile.bloomEnabled ? Math.max(0, user.bloomStrength) : 0;
    if (bloomStrength > 0.001) {
      this.bloom.render(
        this.runner,
        colour,
        this.width,
        this.height,
        this.exposure.texture,
        bloomStrength,
      );
    }

    // -- 8. composite straight to the canvas --------------------------------
    this.updateComposite(colour, bloomStrength, reduced);
    this.runner.run(this.composite.pass.material, null);

    this.gbuffer.endFrame(perspective);
  };

  private updateComposite(colour: THREE.Texture, bloomStrength: number, reduced: boolean): void {
    const u = this.composite.uniforms;
    const state = this.gbuffer.state;
    const user = settings.user;
    const profile = settings.profile;

    u.tColor.value = colour;
    u.tDepth.value = this.gbuffer.depthTexture;
    u.tAo.value = this.ssao ? this.ssao.texture : this.gbuffer.color;
    u.tVolumetric.value = this.volumetric ? this.volumetric.texture : this.gbuffer.color;
    u.tBloom.value = this.bloom.texture;
    u.tExposure.value = this.exposure.texture;
    u.tNoise.value = this.noise;
    u.tLut.value = this.lut;

    (u.uInvViewProj.value as THREE.Matrix4).copy(state.invViewProj);
    (u.uInvProjDebug.value as THREE.Matrix4).copy(state.invProj);
    (u.uPrevViewProjDebug.value as THREE.Matrix4).copy(state.prevViewProj);
    u.uDebugView.value = this.debugView;
    (u.uCameraPos.value as THREE.Vector3).copy(this.cameraPos);
    (u.uSunDir.value as THREE.Vector3).copy(this.sunDirection);
    (u.uSunColor.value as THREE.Color).copy(this.sunColor);
    (u.uFogColor.value as THREE.Color).copy(this.fogColor);
    (u.uAoTint.value as THREE.Color).copy(this.aoTint);
    (u.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (u.uSize.value as THREE.Vector2).set(this.width, this.height);
    (u.uHalfTexel.value as THREE.Vector2).set(
      1 / Math.max(1, Math.ceil(this.width / 2)),
      1 / Math.max(1, Math.ceil(this.height / 2)),
    );
    u.uAspect.value = this.width / Math.max(1, this.height);
    u.uNear.value = state.near;
    u.uFar.value = state.far;

    u.uAoStrength.value = this.ssao ? 0.9 : 0;
    u.uVolStrength.value = this.volumetric ? 1 : 0;
    // The pyramid sums `mipCount` bands of similar energy, so strength has to be
    // normalised by the mip count or "bloom 1.0" would mean something different
    // at every resolution.
    u.uBloomStrength.value = bloomStrength * this.bloom.energyScale * 0.72;

    u.uFogDensity.value = this.level ? this.fogDensity : 0;
    u.uFogHeightFalloff.value = this.fogHeightFalloff;
    u.uFogGround.value = this.fogGround;
    u.uFogInscatter.value = this.fogInscatter;
    u.uFogMax.value = 0.94;

    // 0.006 uv at the frame edge is roughly 6 px of separation at 1080p — present
    // if you look for it, invisible if you do not. Anything stronger reads as a
    // broken display rather than as a lens.
    u.uCaStrength.value = clamp01(user.chromaticAberration) * 0.012;
    u.uVignette.value = clamp01(user.vignette);
    u.uGrain.value = clamp(user.filmGrain, 0, 0.25);
    // Sharpen compensates for TAA's inherent softness; with FXAA instead there is
    // nothing to compensate for and sharpening would just amplify its artefacts.
    u.uSharpen.value = profile.taaEnabled ? 0.38 : 0.12;

    u.uDamage.value = reduced ? 0 : this.damage;
    u.uFlash.value = reduced ? 0 : this.flash;
    (u.uFlashColor.value as THREE.Color).copy(this.flashColor);
    u.uFrame.value = state.frame % 64;

    this.packDistortions(reduced);
  }

  /** Project live distortion sources to screen space. No allocation. */
  private packDistortions(reduced: boolean): void {
    const u = this.composite.uniforms;
    if (reduced) {
      u.uDistortCount.value = 0;
      return;
    }
    const state = this.gbuffer.state;
    let n = 0;
    for (const d of this.distortions) {
      if (!d.active || n >= MAX_DISTORTIONS) continue;
      const v = this.distortVec[n];
      v.set(d.position.x, d.position.y, d.position.z, 1).applyMatrix4(state.viewProj);
      if (v.w <= 0.001) continue;
      const sx = (v.x / v.w) * 0.5 + 0.5;
      const sy = (v.y / v.w) * 0.5 + 0.5;
      // World radius -> uv radius through the same projection, so a shockwave
      // shrinks correctly with distance instead of being a fixed screen circle.
      const scale = 0.5 * state.proj.elements[5];
      const viewZ = Math.max(0.05, v.w);
      const uvRadius = (d.radius * scale) / viewZ;
      if (uvRadius < 0.004) continue;
      const t = clamp01(d.age / d.life);
      // Ring expands and fades; strength decays quadratically so the tail is soft.
      const fade = (1 - t) * (1 - t);
      v.set(sx, sy, uvRadius * (0.35 + t * 0.9), d.strength * fade * 0.05);
      this.distortWave[n].set(t * 9.5, 14 + d.radius * 0.4);
      n++;
    }
    u.uDistortCount.value = n;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create or destroy the optional passes to match the active tier.
   *
   * Sample and step counts are uniforms, so only wholesale enable/disable needs
   * to touch allocation. Every history buffer is invalidated afterwards: blending
   * a 24-sample AO history into an 8-sample one produces a visible wipe.
   */
  private applyTier(): void {
    const profile = settings.profile;

    const wantSsao = profile.ssaoEnabled && profile.ssaoSamples > 0;
    if (wantSsao && !this.ssao) this.ssao = new SsaoPass(this.width, this.height);
    else if (!wantSsao && this.ssao) {
      this.ssao.dispose();
      this.ssao = null;
    }

    const wantVolumetric = profile.volumetricLightEnabled && profile.volumetricSteps > 0;
    if (wantVolumetric && !this.volumetric) {
      this.volumetric = new VolumetricPass(this.width, this.height);
      this.applyFogToVolumetric();
    } else if (!wantVolumetric && this.volumetric) {
      this.volumetric.dispose();
      this.volumetric = null;
    }

    const wantMotionBlur = profile.motionBlurEnabled;
    if (wantMotionBlur && !this.motionBlur) {
      this.motionBlur = new MotionBlurPass(this.width, this.height);
    } else if (!wantMotionBlur && this.motionBlur) {
      this.motionBlur.dispose();
      this.motionBlur = null;
    }

    this.gbuffer.invalidateHistory();
  }

  private setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.gbuffer.setSize(width, height);
    this.taa.setSize(width, height);
    this.bloom.setSize(width, height);
    this.ssao?.setSize(width, height);
    this.volumetric?.setSize(width, height);
    this.motionBlur?.setSize(width, height);
    this.gbuffer.invalidateHistory();
    this.publishDepth();
  }

  private publishDepth(): void {
    this.depthConsumer?.(this.gbuffer.depthTexture);
  }

  private setGrade(name: string): void {
    if (this.gradeName === name && this.luts.has(name)) return;
    this.lut = this.gradeLut(name);
    this.gradeName = name;
  }

  /** LUTs are baked once and cached: five planets means five 140 kB cubes. */
  private gradeLut(name: string): THREE.Data3DTexture {
    let tex = this.luts.get(name);
    if (!tex) {
      tex = buildGradeLut(name);
      this.luts.set(name, tex);
    }
    return tex;
  }

  /**
   * Derive the aerial-perspective medium from whatever fog the level installed.
   *
   * three.js already applies `scene.fog` inside every lit material, so adding a
   * second full-strength fog here would double-fog the frame. Instead the
   * composite runs at a fraction of the scene's density and contributes mainly
   * the *sun inscatter* term, which `scene.fog` has no concept of — that glow
   * toward the sun is the part that actually reads as atmosphere.
   */
  private deriveFogFromScene(scene: THREE.Scene): void {
    const fog = scene?.fog ?? null;
    if (fog && (fog as THREE.FogExp2).isFogExp2) {
      const exp = fog as THREE.FogExp2;
      this.fogDensity = exp.density * 0.55;
      this.fogColor.copy(exp.color);
    } else if (fog) {
      const linear = fog as THREE.Fog;
      // Match the exponential medium to the linear ramp at its far plane.
      const range = Math.max(1, linear.far - linear.near);
      this.fogDensity = (1.6 / range) * 0.55;
      this.fogColor.copy(linear.color);
    } else {
      this.fogDensity = 0.0022;
    }
    this.fogHeightFalloff = 0.028;
    this.fogGround = 0;
    this.fogInscatter = 0.6;
    this.applyFogToVolumetric();
  }

  private applyFogToVolumetric(): void {
    if (!this.volumetric) return;
    // The volumetric medium is deliberately denser than the aerial-perspective
    // one: shafts need enough scattering to read as beams, while distance fog
    // needs to stay off the midground.
    this.volumetric.density = Math.max(0.004, this.fogDensity * 2.6);
    this.volumetric.heightFalloff = this.fogHeightFalloff;
    this.volumetric.groundLevel = this.fogGround;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    if (this.engine.renderPipeline === this.pipeline) this.engine.renderPipeline = null;

    this.gbuffer.dispose();
    this.taa.dispose();
    this.bloom.dispose();
    this.exposure.dispose();
    this.composite.dispose();
    this.ssao?.dispose();
    this.volumetric?.dispose();
    this.motionBlur?.dispose();
    this.ssao = null;
    this.volumetric = null;
    this.motionBlur = null;
    this.runner.dispose();
    for (const lut of this.luts.values()) lut.dispose();
    this.luts.clear();
    clearVelocityTracking();
    // The blue-noise tile is process-wide and shared by every instance, so it is
    // deliberately not disposed here.
    this.renderer.autoClear = true;
  }
}
