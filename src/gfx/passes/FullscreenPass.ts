/**
 * Fullscreen-pass plumbing.
 *
 * `EffectComposer` is deliberately not used. Its model is one pass per effect,
 * each ping-ponging a full-resolution HDR buffer: at 1080p that is a 16 MB
 * read plus a 16 MB write per effect, and eight effects means ~250 MB of
 * bandwidth spent moving pixels that did not change. This chain instead renders
 * the scene once into an MRT and then runs a handful of *fat* passes that each
 * do several things per fetch. The infrastructure for that is small enough to
 * live in this one file.
 *
 * Every pass is a `RawShaderMaterial` at GLSL3 so nothing is injected behind our
 * back — see shaders/common.ts for why that matters.
 */
import * as THREE from 'three';
import { GLSL_FULLSCREEN_VERT } from '@/gfx/shaders/common';

/**
 * One oversized triangle in clip space, shared by every pass and every PostFX
 * instance. Refcounted rather than leaked: the harnesses construct and dispose
 * PostFX repeatedly while probing resizes and tier switches, and a leaked
 * geometry per construction would show up as a climbing `info.memory.geometries`.
 */
let sharedGeometry: THREE.BufferGeometry | null = null;
let sharedRefs = 0;

function acquireGeometry(): THREE.BufferGeometry {
  if (!sharedGeometry) {
    sharedGeometry = new THREE.BufferGeometry();
    sharedGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    // A 3-vertex draw never needs culling or a bounding sphere, and computing
    // one would put the triangle's centre off screen anyway.
    sharedGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);
  }
  sharedRefs++;
  return sharedGeometry;
}

function releaseGeometry(): void {
  sharedRefs = Math.max(0, sharedRefs - 1);
  if (sharedRefs === 0 && sharedGeometry) {
    sharedGeometry.dispose();
    sharedGeometry = null;
  }
}

export type Uniforms = Record<string, THREE.IUniform>;

/**
 * Runs fullscreen materials. Holds the single mesh/scene/camera trio three.js
 * needs; the material is swapped per pass so there is exactly one draw object
 * for the entire chain instead of one per effect.
 */
export class PassRunner {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly placeholder = new THREE.MeshBasicMaterial();

  constructor(readonly renderer: THREE.WebGLRenderer) {
    this.geometry = acquireGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.placeholder);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
    // The pass scene is a fixed one-object graph; skipping the per-frame world
    // matrix walk removes a pointless traversal from every one of ~16 passes.
    this.scene.matrixAutoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
    this.mesh.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
  }

  /**
   * Draw `material` over `target` (or the canvas when null).
   *
   * `clear` is off by default because most passes write every pixel; the bloom
   * upsample chain in particular *must* not clear, since it accumulates into the
   * mip it is drawing over.
   */
  run(material: THREE.Material, target: THREE.WebGLRenderTarget | null, clear = false): void {
    const r = this.renderer;
    r.setRenderTarget(target);
    if (clear) r.clear(true, false, false);
    this.mesh.material = material;
    r.render(this.scene, this.camera);
    this.mesh.material = this.placeholder;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.placeholder.dispose();
    releaseGeometry();
  }
}

export interface PassOptions {
  /** Extra GLSL prepended to the fragment shader (shared library chunks). */
  include?: string;
  blending?: THREE.Blending;
  /** Prefix `#define`s, e.g. { MIPS: '6' }. */
  defines?: Record<string, string>;
}

/** A fragment shader plus its uniforms. Owns nothing but the material. */
export class FullscreenPass {
  readonly material: THREE.RawShaderMaterial;
  readonly uniforms: Uniforms;

  constructor(fragmentShader: string, uniforms: Uniforms, opts: PassOptions = {}) {
    this.uniforms = uniforms;
    const head = opts.include ? `${opts.include}\n` : '';
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      defines: opts.defines ?? {},
      vertexShader: GLSL_FULLSCREEN_VERT,
      fragmentShader: `precision highp float;\nprecision highp sampler2D;\nprecision highp sampler3D;\nin vec2 vUv;\nlayout(location = 0) out vec4 fragColor;\n${head}${fragmentShader}`,
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      toneMapped: false,
    });
  }

  set<T>(name: string, value: T): void {
    const u = this.uniforms[name];
    if (u) u.value = value;
  }

  dispose(): void {
    this.material.dispose();
  }
}

export interface TargetOptions {
  type?: THREE.TextureDataType;
  format?: THREE.PixelFormat;
  filter?: THREE.MagnificationTextureFilter;
  wrap?: THREE.Wrapping;
  count?: number;
  depthBuffer?: boolean;
}

/**
 * Half-float render target with the settings this chain always wants: no
 * mipmaps, clamped edges (so a bloom mip cannot wrap light from the opposite
 * screen edge) and explicit linear colour space.
 */
export function makeTarget(
  width: number,
  height: number,
  name: string,
  opts: TargetOptions = {},
): THREE.WebGLRenderTarget {
  const filter = opts.filter ?? THREE.LinearFilter;
  const wrap = opts.wrap ?? THREE.ClampToEdgeWrapping;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: opts.type ?? THREE.HalfFloatType,
    format: opts.format ?? THREE.RGBAFormat,
    minFilter: filter as THREE.MinificationTextureFilter,
    magFilter: filter,
    wrapS: wrap,
    wrapT: wrap,
    depthBuffer: opts.depthBuffer ?? false,
    stencilBuffer: false,
    generateMipmaps: false,
    count: opts.count ?? 1,
    colorSpace: THREE.NoColorSpace,
  });
  for (const t of rt.textures) {
    t.name = name;
    t.generateMipmaps = false;
  }
  return rt;
}

/** Round a dimension down for a half/quarter-res chain, never below 1. */
export function halfSize(v: number): number {
  return Math.max(1, Math.ceil(v * 0.5));
}
