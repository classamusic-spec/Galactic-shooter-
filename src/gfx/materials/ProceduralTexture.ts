/**
 * GPU texture baker.
 *
 * A surface recipe is a fragment-shader snippet defining
 * `void surface(vec2 uv, out vec3 albedo, out float height, out float rough,
 *              out float metal, out float ao)`.
 *
 * One draw call bakes a complete PBR set into three attachments — albedo,
 * tangent-space normal, and packed ORM (ao/roughness/metalness) — which is the
 * layout three.js already expects. Deriving the normal from the *same* height
 * function the albedo came from is the whole trick: the shading can never
 * disagree with what the surface looks like.
 */
import * as THREE from 'three';
import { GLSL_BAKE_MAIN, GLSL_BAKE_VERTEX, GLSL_NOISE } from './glsl';

export interface PbrSet {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  /** r = ambient occlusion, g = roughness, b = metalness. */
  orm: THREE.Texture;
  dispose(): void;
}

export interface BakeOptions {
  size?: number;
  /** Height-field to normal-map strength. Higher = more pronounced relief. */
  normalScale?: number;
  seed?: number;
  /** Extra uniforms the recipe declares. */
  uniforms?: Record<string, THREE.IUniform>;
  anisotropy?: number;
  /** UV repeats baked into the material, not the texture. */
  repeat?: number;
}

export class TextureBaker {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad: THREE.Mesh;
  private owned: PbrSet[] = [];
  private mrtSupported: boolean;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const geo = new THREE.BufferGeometry();
    // Fullscreen triangle-pair in clip space; the vertex shader passes uv through.
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.mrtSupported = (gl.getParameter(gl.MAX_DRAW_BUFFERS) as number) >= 3;
  }

  /**
   * Bake a PBR set. `recipe` must define `surface(...)` and may use anything from
   * the shared noise library.
   */
  bake(recipe: string, opts: BakeOptions = {}): PbrSet {
    const size = opts.size ?? 512;
    const normalScale = opts.normalScale ?? 1;
    const seed = opts.seed ?? 0;

    const target = new THREE.WebGLRenderTarget(size, size, {
      count: this.mrtSupported ? 3 : 1,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      // three generates the mip chain for every MRT attachment at the end of
      // render() while the target is still bound, so asking for a mipmap
      // minFilter here is safe and gives anisotropy something to work with.
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const uniforms: Record<string, THREE.IUniform> = {
      uTexel: { value: 1 / size },
      uNormalScale: { value: normalScale * size * 0.004 },
      uSeed: { value: seed },
      ...(opts.uniforms ?? {}),
    };

    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GLSL_BAKE_VERTEX,
      fragmentShader: `precision highp float;\n${GLSL_NOISE}\n${GLSL_BAKE_MAIN}\n${recipe}`,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });

    const prevTarget = this.renderer.getRenderTarget();
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prevTarget);
    material.dispose();

    const aniso = Math.min(
      opts.anisotropy ?? 8,
      this.renderer.capabilities.getMaxAnisotropy(),
    );

    const textures = target.textures ?? [target.texture];
    const albedo = textures[0];
    const normal = textures[Math.min(1, textures.length - 1)];
    const orm = textures[Math.min(2, textures.length - 1)];

    for (const t of [albedo, normal, orm]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = aniso;
      // aoMap normally samples the second UV set; force it onto uv0 since every
      // mesh in this game uses a single UV channel.
      t.channel = 0;
    }
    albedo.colorSpace = THREE.SRGBColorSpace;
    normal.colorSpace = THREE.NoColorSpace;
    orm.colorSpace = THREE.NoColorSpace;

    const set: PbrSet = {
      albedo,
      normal,
      orm,
      dispose: () => target.dispose(),
    };
    this.owned.push(set);
    return set;
  }

  /** Bake a single-channel/RGBA utility texture (masks, gradients, ramps). */
  bakeSingle(
    fragment: string,
    size = 256,
    uniforms: Record<string, THREE.IUniform> = {},
    colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
  ): THREE.Texture {
    const target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GLSL_BAKE_VERTEX,
      fragmentShader:
        `precision highp float;\n${GLSL_NOISE}\nin vec2 vUv;\nout vec4 outColor;\n` +
        `uniform float uSeed;\n${fragment}`,
      uniforms: { uSeed: { value: 0 }, ...uniforms },
      depthTest: false,
      depthWrite: false,
    });
    const prev = this.renderer.getRenderTarget();
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    material.dispose();
    target.texture.colorSpace = colorSpace;
    target.texture.wrapS = THREE.RepeatWrapping;
    target.texture.wrapT = THREE.RepeatWrapping;
    this.owned.push({
      albedo: target.texture,
      normal: target.texture,
      orm: target.texture,
      dispose: () => target.dispose(),
    });
    return target.texture;
  }

  /** True when the driver gave us real multiple render targets. */
  get hasMrt(): boolean {
    return this.mrtSupported;
  }

  /**
   * Read back a small sample and report the variance, so callers can assert a
   * texture actually contains detail instead of a flat fill.
   */
  measureVariance(texture: THREE.Texture, samples = 32): number {
    const rt = new THREE.WebGLRenderTarget(samples, samples, { depthBuffer: false });
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GLSL_BAKE_VERTEX,
      fragmentShader:
        'precision highp float;\nin vec2 vUv;\nout vec4 outColor;\nuniform sampler2D t;\n' +
        'void main(){ outColor = texture(t, vUv); }',
      uniforms: { t: { value: texture } },
      depthTest: false,
      depthWrite: false,
    });
    const prev = this.renderer.getRenderTarget();
    this.quad.material = mat;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.camera);
    const buf = new Uint8Array(samples * samples * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, samples, samples, buf);
    this.renderer.setRenderTarget(prev);
    mat.dispose();
    rt.dispose();

    let mean = 0;
    const n = samples * samples;
    for (let i = 0; i < n; i++) mean += (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3;
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const l = (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3;
      v += (l - mean) * (l - mean);
    }
    return Math.sqrt(v / n);
  }

  dispose(): void {
    for (const s of this.owned) s.dispose();
    this.owned.length = 0;
    this.quad.geometry.dispose();
    (this.quad.material as THREE.Material).dispose?.();
  }
}

/**
 * Give a material its own UV scale without duplicating textures.
 *
 * `texture.repeat` lives on the texture, so a shared texture cannot have a
 * per-material repeat — and these textures must be shared, because they are
 * GPU-only render-target storage that cannot be cloned. Scaling the UV varyings
 * right after three computes them gets us per-material tiling for the cost of
 * one uniform.
 */
export function applyUvScale(material: THREE.Material, scale: number): void {
  const uniform = { value: scale };
  (material as THREE.Material & { userData: Record<string, unknown> }).userData.uvScale = uniform;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uUvScale = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uUvScale;\nvoid main() {')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv *= uUvScale;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv *= uUvScale;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv *= uUvScale;
        #endif
        #ifdef USE_METALNESSMAP
          vMetalnessMapUv *= uUvScale;
        #endif
        #ifdef USE_AOMAP
          vAoMapUv *= uUvScale;
        #endif
        #ifdef USE_ALPHAMAP
          vAlphaMapUv *= uUvScale;
        #endif
        #ifdef USE_EMISSIVEMAP
          vEmissiveMapUv *= uUvScale;
        #endif`,
      );
  };
  // Materials differing only by uv scale must not share a compiled program.
  material.customProgramCacheKey = () => `uvScale:${scale}`;
}

/**
 * Build a `MeshStandardMaterial` from a baked set. Textures are shared; tiling is
 * applied per-material through `applyUvScale`.
 */
export function standardFromPbr(
  set: PbrSet,
  opts: {
    repeat?: number;
    color?: number;
    roughness?: number;
    metalness?: number;
    normalScale?: number;
    aoIntensity?: number;
    emissive?: number;
    emissiveIntensity?: number;
    envMapIntensity?: number;
    side?: THREE.Side;
    transparent?: boolean;
    opacity?: number;
  } = {},
): THREE.MeshStandardMaterial {
  const repeat = opts.repeat ?? 1;
  // Textures are shared between materials, so clone the wrappers to give each
  // material its own repeat without re-baking the pixels.
  // NOTE: do not clone these. They are backed by GPU-only render-target storage
  // with no CPU-side image, so Texture.clone() yields a handle to nothing and
  // samples as pure black. Per-material UV scaling is applied via uUvScale below.
  const clone = (t: THREE.Texture): THREE.Texture => t;

  const mat = new THREE.MeshStandardMaterial({
    map: clone(set.albedo),
    normalMap: clone(set.normal),
    roughnessMap: clone(set.orm),
    metalnessMap: clone(set.orm),
    aoMap: clone(set.orm),
    color: opts.color ?? 0xffffff,
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 1,
    envMapIntensity: opts.envMapIntensity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
  mat.normalScale.setScalar(opts.normalScale ?? 1);
  mat.aoMapIntensity = opts.aoIntensity ?? 1;
  applyUvScale(mat, repeat);
  if (opts.emissive != null) {
    mat.emissive = new THREE.Color(opts.emissive);
    mat.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }
  return mat;
}
