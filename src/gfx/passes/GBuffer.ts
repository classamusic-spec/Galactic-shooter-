/**
 * The scene pass: one draw of the world into an HDR multi-render-target.
 *
 * Attachments (all RGBA16F, so one FBO binding covers the lot):
 *   0  HDR radiance
 *   1  view-space normal (xyz, encoded) + perceptual roughness (w)   [MRT mode]
 *   2  screen-space velocity (xy, uv units) + validity flag (w)      [MRT mode]
 * plus a FloatType DepthTexture. 6 draw buffers are available, so the hardware is
 * not the constraint.
 *
 * ## Why MRT mode is opt-in, and what the default does instead
 *
 * `installGBufferChunks()` patches three's shared `ShaderChunk` table once, at
 * module load, so every *lit* material (`MeshStandardMaterial` and friends) also
 * writes attachments 1 and 2. Guarded by `#ifdef OPAQUE` — three defines it for
 * non-transparent, normally-blended materials — so translucent glass and additive
 * VFX cannot blend garbage into the normal buffer.
 *
 * That covers built-in materials. It does *not* cover custom `ShaderMaterial`s,
 * and this project is full of them: the sky dome, the water plane, the aurora, the
 * space backdrop. Measured behaviour on ANGLE (which is what Chrome runs on every
 * platform): binding a 3-attachment FBO and drawing a shader that declares only
 * output 0 raises `GL_INVALID_OPERATION` — "Active draw buffers with missing
 * fragment shader outputs" — and *silently drops the draw call*. The sky
 * disappears. This is not a driver quirk to work around; it is what the GLES3 spec
 * requires, and no amount of validating the buffer afterwards helps, because the
 * geometry never rasterised.
 *
 * So the default is `'depth'`: one colour attachment, and view normals plus
 * screen velocity are *reconstructed from the depth buffer* inside the passes that
 * need them (`sampleNormal` / `sampleVelocity` in shaders/common.ts). Cost is a
 * few extra depth taps in SSAO and two matrix multiplies per velocity fetch;
 * benefit is that the chain is correct on any scene, from any author, with zero
 * cooperation. That is the "nobody is blocked" guarantee, and it is the mode the
 * shipped frames are rendered with.
 *
 * `setMode('mrt')` switches to true MRT for a scene where *every* material writes
 * the outputs — which buys geometric normals (sharper GTAO on curved surfaces)
 * and real per-object velocity. It self-checks: `probe()` reads `gl.getError()`
 * after the first scene render and permanently downgrades to `'depth'` if the
 * driver rejected anything, so a mistaken opt-in degrades instead of shipping a
 * frame with no sky.
 *
 * ## Object velocity
 *
 * Per-object motion vectors need a per-*object* previous matrix, and three.js
 * materials are shared between objects, so a plain uniform cannot express it.
 * `trackVelocity(mesh)` solves it the only way that works with shared materials:
 * the uniform is written in `Object3D.onBeforeRender`, which three calls
 * immediately before that object's draw. Opt in and enemies/projectiles stop
 * ghosting under TAA; ignore it and camera reprojection covers the rest.
 */
import * as THREE from 'three';
import { makeTarget } from './FullscreenPass';

// ---------------------------------------------------------------------------
// three.js ShaderChunk patch
// ---------------------------------------------------------------------------

/** Materials whose fragment shader has `normal` in scope at the output site. */
const LIT_GUARD =
  '#if ( defined( STANDARD ) || defined( PHONG ) || defined( LAMBERT ) || defined( TOON ) || defined( MATCAP ) ) && defined( OPAQUE )';

const GBUFFER_PARS_FRAGMENT = /* glsl */ `
${LIT_GUARD}
  layout(location = 1) out vec4 gfOutNormal;
  layout(location = 2) out vec4 gfOutVelocity;
  #ifdef GF_OBJECT_VELOCITY
    in vec4 gfPrevClipPos;
    in vec4 gfCurrClipPos;
  #endif
#endif
`;

const GBUFFER_OUTPUT_FRAGMENT = /* glsl */ `
${LIT_GUARD}
  {
    vec3 gfN = normalize( normal );
    #ifdef STANDARD
      float gfRough = roughnessFactor;
    #else
      float gfRough = 0.5;
    #endif
    gfOutNormal = vec4( gfN * 0.5 + 0.5, clamp( gfRough, 0.02, 1.0 ) );
    #ifdef GF_OBJECT_VELOCITY
      vec2 gfCur = gfCurrClipPos.xy / max( abs( gfCurrClipPos.w ), 1e-5 );
      vec2 gfPre = gfPrevClipPos.xy / max( abs( gfPrevClipPos.w ), 1e-5 );
      gfOutVelocity = vec4( ( gfCur - gfPre ) * 0.5, 0.0, 1.0 );
    #else
      // w = 0 tells consumers "no object data here, reproject from depth".
      gfOutVelocity = vec4( 0.0 );
    #endif
  }
#endif
`;

const GBUFFER_PARS_VERTEX = /* glsl */ `
#ifdef GF_OBJECT_VELOCITY
  uniform mat4 gfPrevMVP;
  uniform mat4 gfCurrMVP;
  out vec4 gfPrevClipPos;
  out vec4 gfCurrClipPos;
#endif
`;

const GBUFFER_VERTEX = /* glsl */ `
#ifdef GF_OBJECT_VELOCITY
  gfPrevClipPos = gfPrevMVP * vec4( transformed, 1.0 );
  gfCurrClipPos = gfCurrMVP * vec4( transformed, 1.0 );
#endif
`;

let chunksInstalled = false;

/**
 * Patch three's shared chunk table. Idempotent, and safe to call even if no
 * MRT is ever bound: writing to a fragment output with no matching colour
 * attachment is defined by the GLES3 spec to discard the value, so shadow maps
 * and any single-target render keep working untouched.
 */
export function installGBufferChunks(): void {
  if (chunksInstalled) return;
  chunksInstalled = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  // dithering_pars_fragment / opaque_fragment are the two sites present in every
  // lit material — one at file scope for the declarations, one inside main() at
  // the point where `normal` and `roughnessFactor` are still live.
  C.dithering_pars_fragment += GBUFFER_PARS_FRAGMENT;
  C.opaque_fragment += GBUFFER_OUTPUT_FRAGMENT;
  C.fog_pars_vertex += GBUFFER_PARS_VERTEX;
  C.fog_vertex += GBUFFER_VERTEX;
}

// Installed at import time so it lands before any material compiles a program.
installGBufferChunks();

// ---------------------------------------------------------------------------
// Opt-in object velocity
// ---------------------------------------------------------------------------

interface VelocityRecord {
  mesh: THREE.Mesh;
  /** view-projection × world, as of the previous rendered frame. */
  prev: THREE.Matrix4;
  /** Same for this frame; swapped with `prev` at end of frame. */
  curr: THREE.Matrix4;
}

interface VelocityUniforms {
  prev: THREE.IUniform<THREE.Matrix4>;
  curr: THREE.IUniform<THREE.Matrix4>;
}

const velocityRecords = new Map<THREE.Object3D, VelocityRecord>();
const velocityUniforms = new WeakMap<THREE.Material, VelocityUniforms>();
/** Current unjittered view-projection, published for the onBeforeRender hook. */
const currentViewProj = new THREE.Matrix4();
const IDENTITY = new THREE.Matrix4();

/**
 * Opt a material into per-object motion vectors.
 *
 * The two extra matrices have to reach a *built-in* material's program, and
 * three.js only uploads uniforms it knows about — so they are injected through
 * `onBeforeCompile`, whose `shader.uniforms` object becomes the material's live
 * uniform map. Any existing `onBeforeCompile` from another owner is chained, not
 * replaced.
 *
 * Only valid for lit, opaque materials (`MeshStandardMaterial` and friends):
 * those are the shaders carrying the patched chunks.
 */
export function enableObjectVelocity(material: THREE.Material): VelocityUniforms {
  const existing = velocityUniforms.get(material);
  if (existing) return existing;

  const uniforms: VelocityUniforms = {
    prev: { value: IDENTITY.clone() },
    curr: { value: IDENTITY.clone() },
  };
  velocityUniforms.set(material, uniforms);

  const m = material as THREE.Material & { defines?: Record<string, unknown> };
  if (!m.defines) m.defines = {};
  m.defines.GF_OBJECT_VELOCITY = '';

  const chained = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    chained.call(material, shader, renderer);
    shader.uniforms.gfPrevMVP = uniforms.prev;
    shader.uniforms.gfCurrMVP = uniforms.curr;
  };
  material.needsUpdate = true;
  return uniforms;
}

/**
 * Start feeding true motion vectors for `mesh`.
 *
 * The per-object matrices are written in `Object3D.onBeforeRender`, which three
 * calls immediately before that object's draw and before uniforms are uploaded.
 * That is the only hook that can carry per-object data through a material shared
 * by many objects.
 */
export function trackVelocity(mesh: THREE.Mesh): void {
  if (velocityRecords.has(mesh)) return;
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const uniforms = enableObjectVelocity(material);

  mesh.updateMatrixWorld();
  const record: VelocityRecord = {
    mesh,
    prev: new THREE.Matrix4().multiplyMatrices(currentViewProj, mesh.matrixWorld),
    curr: new THREE.Matrix4(),
  };
  velocityRecords.set(mesh, record);

  const previousHook = mesh.onBeforeRender;
  mesh.onBeforeRender = (renderer, scene, camera, geometry, drawMaterial, group) => {
    previousHook.call(mesh, renderer, scene, camera, geometry, drawMaterial, group);
    record.curr.multiplyMatrices(currentViewProj, mesh.matrixWorld);
    uniforms.prev.value = record.prev;
    uniforms.curr.value = record.curr;
  };
}

export function untrackVelocity(mesh: THREE.Mesh): void {
  velocityRecords.delete(mesh);
}

/** Drop every tracked object — called when a level is torn down. */
export function clearVelocityTracking(): void {
  velocityRecords.clear();
}

/** Roll every tracked object's matrix forward. Called once per rendered frame. */
function advanceVelocityRecords(): void {
  for (const rec of velocityRecords.values()) {
    const swap = rec.prev;
    rec.prev = rec.curr;
    rec.curr = swap;
  }
}

// ---------------------------------------------------------------------------
// Halton jitter
// ---------------------------------------------------------------------------

/** Radical inverse in `base` — the building block of the Halton sequence. */
function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/**
 * 16-sample Halton(2,3), centred on the pixel. 16 is the sweet spot: 8 leaves a
 * faint stipple on high-contrast edges, 32 takes visibly longer to converge
 * after the history is rejected.
 */
export const TAA_SAMPLES = 16;
const JITTER = (() => {
  const out: number[] = [];
  for (let i = 1; i <= TAA_SAMPLES; i++) {
    out.push(halton(i, 2) - 0.5, halton(i, 3) - 0.5);
  }
  return out;
})();

// ---------------------------------------------------------------------------
// GBuffer
// ---------------------------------------------------------------------------

/** Per-frame camera state every pass reads. All matrices are unjittered. */
export interface FrameState {
  readonly view: THREE.Matrix4;
  readonly proj: THREE.Matrix4;
  readonly viewProj: THREE.Matrix4;
  readonly invProj: THREE.Matrix4;
  readonly invView: THREE.Matrix4;
  readonly invViewProj: THREE.Matrix4;
  readonly prevViewProj: THREE.Matrix4;
  readonly jitter: THREE.Vector2;
  near: number;
  far: number;
  frame: number;
  /** True when the history buffers must be treated as invalid this frame. */
  reset: boolean;
}

export type GBufferMode = 'depth' | 'mrt';

export class GBuffer {
  target: THREE.WebGLRenderTarget;
  width: number;
  height: number;
  /** 3 in MRT mode, 1 in depth-reconstruction mode (the default). */
  attachments = 1;
  private mode: GBufferMode = 'depth';
  private readonly maxDrawBuffers: number;
  private probePending = false;
  private mrtRejected = false;

  readonly state: FrameState = {
    view: new THREE.Matrix4(),
    proj: new THREE.Matrix4(),
    viewProj: new THREE.Matrix4(),
    invProj: new THREE.Matrix4(),
    invView: new THREE.Matrix4(),
    invViewProj: new THREE.Matrix4(),
    prevViewProj: new THREE.Matrix4(),
    jitter: new THREE.Vector2(),
    near: 0.1,
    far: 1000,
    frame: 0,
    reset: true,
  };

  private savedProj = new THREE.Matrix4();
  private jitterActive = false;
  private depth: THREE.DepthTexture;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
    mode: GBufferMode = 'depth',
  ) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.maxDrawBuffers = (gl.getParameter(gl.MAX_DRAW_BUFFERS) as number) || 1;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.depth = this.makeDepth(this.width, this.height);
    this.target = this.makeTargetFor(mode);
  }

  /** True when attachments 1 and 2 hold real data worth reading. */
  get hasGBuffer(): boolean {
    return this.attachments === 3;
  }

  private makeTargetFor(mode: GBufferMode): THREE.WebGLRenderTarget {
    this.mode = mode === 'mrt' && this.maxDrawBuffers >= 3 && !this.mrtRejected ? 'mrt' : 'depth';
    this.attachments = this.mode === 'mrt' ? 3 : 1;
    this.probePending = this.mode === 'mrt';
    const rt = makeTarget(this.width, this.height, 'gbuffer', {
      count: this.attachments,
      depthBuffer: true,
    });
    rt.depthTexture = this.depth;
    rt.textures[0].name = 'gbufferColor';
    if (this.attachments === 3) {
      rt.textures[1].name = 'gbufferNormal';
      rt.textures[2].name = 'gbufferVelocity';
    }
    return rt;
  }

  /**
   * Switch between true MRT and depth reconstruction. A downgrade forced by
   * `probe()` is sticky: once the driver has rejected the extra attachments there
   * is no point trying again this session.
   */
  setMode(mode: GBufferMode): void {
    const want = mode === 'mrt' && !this.mrtRejected ? 'mrt' : 'depth';
    if (want === this.mode) return;
    this.target.dispose();
    this.target = this.makeTargetFor(want);
    this.state.reset = true;
  }

  get currentMode(): GBufferMode {
    return this.mode;
  }

  private makeDepth(w: number, h: number): THREE.DepthTexture {
    // FloatType keeps the far end of a 4 km view distance usable; a 24-bit
    // integer depth texture at that range quantises volumetric marching into
    // visible steps.
    const d = new THREE.DepthTexture(w, h, THREE.FloatType);
    d.format = THREE.DepthFormat;
    d.minFilter = THREE.NearestFilter;
    d.magFilter = THREE.NearestFilter;
    d.generateMipmaps = false;
    d.name = 'gbufferDepth';
    return d;
  }

  get color(): THREE.Texture {
    return this.target.textures[0];
  }
  get normal(): THREE.Texture {
    return this.attachments === 3 ? this.target.textures[1] : this.target.textures[0];
  }
  get velocity(): THREE.Texture {
    return this.attachments === 3 ? this.target.textures[2] : this.target.textures[0];
  }
  get depthTexture(): THREE.DepthTexture {
    return this.depth;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    // A DepthTexture cannot be resized in place without its image data going
    // stale, so it is rebuilt and re-attached; the colour attachments resize
    // normally.
    this.depth.dispose();
    this.depth = this.makeDepth(w, h);
    this.target.depthTexture = this.depth;
    this.target.setSize(w, h);
    this.state.reset = true;
  }

  /**
   * Compute this frame's matrices and (optionally) push the TAA jitter into the
   * camera's projection. Must be paired with `endFrame`.
   */
  beginFrame(camera: THREE.PerspectiveCamera, jitterEnabled: boolean): void {
    const s = this.state;
    s.prevViewProj.copy(s.viewProj);

    camera.updateMatrixWorld();
    s.view.copy(camera.matrixWorldInverse);
    s.invView.copy(camera.matrixWorld);
    s.proj.copy(camera.projectionMatrix);
    s.invProj.copy(camera.projectionMatrix).invert();
    s.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    s.invViewProj.copy(s.viewProj).invert();
    s.near = camera.near;
    s.far = camera.far;

    if (s.frame === 0) s.prevViewProj.copy(s.viewProj);
    currentViewProj.copy(s.viewProj);

    if (jitterEnabled) {
      const i = (s.frame % TAA_SAMPLES) * 2;
      const jx = JITTER[i];
      const jy = JITTER[i + 1];
      s.jitter.set(jx, jy);
      this.savedProj.copy(camera.projectionMatrix);
      const e = camera.projectionMatrix.elements;
      e[8] += (jx * 2) / this.width;
      e[9] += (jy * 2) / this.height;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      this.jitterActive = true;
    } else {
      s.jitter.set(0, 0);
      this.jitterActive = false;
    }
  }

  /** Render the world. Clears every attachment so validity flags start at zero. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    if (this.probePending) {
      const gl = r.getContext() as WebGL2RenderingContext;
      // Drain any pre-existing error so the probe below only sees this pass.
      while (gl.getError() !== gl.NO_ERROR) {
        /* flush */
      }
      r.render(scene, camera);
      const err = gl.getError();
      this.probePending = false;
      if (err !== gl.NO_ERROR) {
        // Almost certainly INVALID_OPERATION from a custom ShaderMaterial that
        // declares only output 0 — and its draw was dropped, so the frame is
        // already wrong. Downgrade permanently rather than ship a missing sky.
        this.mrtRejected = true;
        console.warn(
          `[PostFX] MRT G-buffer rejected by the driver (gl error 0x${err.toString(16)}); ` +
            'falling back to depth-reconstructed normals and velocity.',
        );
        this.setMode('depth');
      }
      return;
    }
    r.render(scene, camera);
  }

  /** Undo the jitter and roll velocity history forward. */
  endFrame(camera: THREE.PerspectiveCamera): void {
    if (this.jitterActive) {
      camera.projectionMatrix.copy(this.savedProj);
      camera.projectionMatrixInverse.copy(this.savedProj).invert();
      this.jitterActive = false;
    }
    advanceVelocityRecords();
    this.state.frame++;
    this.state.reset = false;
  }

  /** Force every temporal consumer to discard its history next frame. */
  invalidateHistory(): void {
    this.state.reset = true;
  }

  dispose(): void {
    this.target.dispose();
    this.depth.dispose();
  }
}
