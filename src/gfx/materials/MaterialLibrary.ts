/**
 * MaterialLibrary — the game's one source of materials.
 *
 * Bakes every surface once at boot into shared PBR texture sets, then hands out
 * cached `MeshStandardMaterial`s. It also owns the procedural IBL environment,
 * which is the single highest-leverage thing in the whole renderer: without a
 * prefiltered environment map, metal and glass have nothing to reflect and
 * everything looks like painted clay no matter how good the albedo is.
 */
import * as THREE from 'three';
import type { SurfaceKind } from '@/types';
import { settings } from '@/core/Settings';
import { clamp01 } from '@/util/math';
import { TextureBaker, standardFromPbr, type PbrSet } from './ProceduralTexture';
import {
  SURFACE_NAMES,
  SURFACE_RECIPES,
  type SurfaceMaterialName,
  type SurfaceRecipe,
} from './SurfaceMaterials';

export interface SurfaceOptions {
  repeat?: number;
  color?: number;
  roughness?: number;
  metalness?: number;
  normalScale?: number;
  emissive?: number;
  emissiveIntensity?: number;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  /** Alpha-test cutout, for foliage cards. */
  alphaTest?: number;
  envMapIntensity?: number;
}

/** Sky/ground description used to synthesise the environment map per planet. */
export interface EnvironmentProfile {
  zenith: THREE.ColorRepresentation;
  horizon: THREE.ColorRepresentation;
  ground: THREE.ColorRepresentation;
  sunColor: THREE.ColorRepresentation;
  sunDirection: THREE.Vector3;
  /** Sun angular size multiplier; bigger = softer highlights. */
  sunSize: number;
  sunIntensity: number;
  /** Haze thickness near the horizon, 0..1. */
  turbidity: number;
}

export const DEFAULT_ENVIRONMENT: EnvironmentProfile = {
  zenith: 0x1a3a5c,
  horizon: 0x8fb4d0,
  ground: 0x2a2620,
  sunColor: 0xfff2dc,
  sunDirection: new THREE.Vector3(0.4, 0.55, 0.73).normalize(),
  sunSize: 1,
  sunIntensity: 6,
  turbidity: 0.35,
};

export class MaterialLibrary {
  readonly renderer: THREE.WebGLRenderer;
  /** Prefiltered environment map. Assign to `scene.environment`. */
  environment!: THREE.Texture;

  private baker: TextureBaker;
  private sets = new Map<SurfaceMaterialName, PbrSet>();
  private cache = new Map<string, THREE.Material>();
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envScene = new THREE.Scene();
  private envSky: THREE.Mesh | null = null;
  private currentProfile: EnvironmentProfile = DEFAULT_ENVIRONMENT;
  /** Materials that opted into env-map updates when the planet changes. */
  private envConsumers: THREE.MeshStandardMaterial[] = [];

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.baker = new TextureBaker(renderer);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  /**
   * Bake everything. Yields to the event loop between surfaces so the boot bar
   * animates instead of the tab locking up for a second.
   */
  async warmup(onProgress?: (t: number, label: string) => void): Promise<void> {
    this.buildEnvScene();
    this.rebuildEnvironment(DEFAULT_ENVIRONMENT);

    const size = settings.profile.textureSize;
    const aniso = Math.min(settings.profile.anisotropy, this.renderer.capabilities.getMaxAnisotropy());

    for (let i = 0; i < SURFACE_NAMES.length; i++) {
      const name = SURFACE_NAMES[i];
      const recipe = SURFACE_RECIPES[name];
      this.sets.set(
        name,
        this.baker.bake(recipe.glsl, {
          size,
          normalScale: recipe.normalScale,
          anisotropy: aniso,
          seed: i * 17.13,
        }),
      );
      onProgress?.((i + 1) / SURFACE_NAMES.length, `Baking ${name}`);
      // One frame per surface keeps the main thread responsive during boot.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  }

  /** True when the driver supports the 3-attachment bake path. */
  get hasMrt(): boolean {
    return this.baker.hasMrt;
  }

  /** Baked texture set for a surface, for callers building custom shaders. */
  pbr(name: SurfaceMaterialName): PbrSet {
    const set = this.sets.get(name);
    if (!set) throw new Error(`Surface "${name}" was not baked; call warmup() first`);
    return set;
  }

  /** Cached shared material by name. Do not mutate the result. */
  get(name: SurfaceMaterialName): THREE.Material {
    const key = `named:${name}`;
    let m = this.cache.get(key);
    if (!m) {
      m = this.build(name, {});
      this.cache.set(key, m);
    }
    return m;
  }

  /** A material for a raw surface kind, optionally tweaked. */
  surface(kind: SurfaceKind, opts: SurfaceOptions = {}): THREE.MeshStandardMaterial {
    const key = `surf:${kind}:${JSON.stringify(opts)}`;
    const hit = this.cache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = this.build(kind, opts);
    this.cache.set(key, m);
    return m;
  }

  /** Bloom-friendly emissive material. Colour is authored in sRGB hex. */
  emissive(color: number, intensity: number, opts: SurfaceOptions = {}): THREE.MeshStandardMaterial {
    const key = `emis:${color}:${intensity}:${JSON.stringify(opts)}`;
    const hit = this.cache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: opts.roughness ?? 0.4,
      metalness: 0,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      side: opts.side ?? THREE.FrontSide,
      toneMapped: true,
    });
    m.envMap = this.environment;
    this.envConsumers.push(m);
    this.cache.set(key, m);
    return m;
  }

  /** Unlit additive material for tracers, glows and beam cores. */
  additive(color: number, opacity = 1): THREE.MeshBasicMaterial {
    const key = `add:${color}:${opacity}`;
    const hit = this.cache.get(key);
    if (hit) return hit as THREE.MeshBasicMaterial;
    const m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.cache.set(key, m);
    return m;
  }

  private build(name: SurfaceMaterialName, opts: SurfaceOptions): THREE.MeshStandardMaterial {
    const recipe: SurfaceRecipe = SURFACE_RECIPES[name] ?? SURFACE_RECIPES.rock;
    const set = this.sets.get(name) ?? this.sets.get('rock');
    if (!set) throw new Error('MaterialLibrary.warmup() has not run');

    const mat = standardFromPbr(set, {
      repeat: opts.repeat ?? recipe.repeat,
      color: opts.color,
      roughness: opts.roughness ?? recipe.roughness ?? 1,
      metalness: opts.metalness ?? recipe.metalness ?? 0,
      normalScale: opts.normalScale ?? 1,
      envMapIntensity: opts.envMapIntensity ?? recipe.envMapIntensity ?? 1,
      side: opts.side,
      transparent: opts.transparent,
      opacity: opts.opacity,
      emissive: opts.emissive,
      emissiveIntensity: opts.emissiveIntensity,
    });

    if (opts.alphaTest != null) {
      mat.alphaTest = opts.alphaTest;
      mat.alphaMap = mat.map;
    }

    // Glass and water want transmission-ish behaviour without the cost of
    // MeshPhysicalMaterial's full transmission pass.
    if (name === 'glass' || name === 'fedGlass') {
      mat.transparent = true;
      mat.opacity = opts.opacity ?? 0.32;
      mat.roughness = opts.roughness ?? 0.06;
      mat.metalness = 0.1;
      mat.depthWrite = false;
    }
    if (name === 'water') {
      mat.transparent = true;
      mat.opacity = opts.opacity ?? 0.82;
    }
    if (name === 'foliage') {
      mat.side = THREE.DoubleSide;
      mat.alphaTest = opts.alphaTest ?? 0.42;
      mat.alphaMap = mat.map;
    }

    mat.envMap = this.environment;
    this.envConsumers.push(mat);
    return mat;
  }

  // -- environment ----------------------------------------------------------

  /**
   * Build the tiny scene the environment map is rendered from: an inverted
   * sphere with a gradient + sun disc + ground bounce. Cheap, and enough for
   * PMREM to produce a convincing prefiltered radiance chain.
   */
  private buildEnvScene(): void {
    const geo = new THREE.SphereGeometry(1, 48, 32);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3() },
        uSunSize: { value: 1 },
        uSunIntensity: { value: 6 },
        uTurbidity: { value: 0.35 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uZenith, uHorizon, uGround, uSunColor, uSunDir;
        uniform float uSunSize, uSunIntensity, uTurbidity;
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;

          // Sky: horizon haze lifting into zenith, with a turbidity-controlled
          // falloff so a thick atmosphere reads differently from a thin one.
          float t = clamp(h, 0.0, 1.0);
          float hazePow = mix(3.2, 1.1, uTurbidity);
          vec3 sky = mix(uHorizon, uZenith, pow(t, 1.0/hazePow));

          // Ground hemisphere: a dim bounce, warmer and flatter than the sky.
          float g = clamp(-h*2.2, 0.0, 1.0);
          vec3 col = mix(sky, uGround, g);

          // Sun disc plus a broad forward-scattering halo. The halo matters more
          // than the disc for specular highlight shape.
          float cosA = dot(d, normalize(uSunDir));
          float discEdge = cos(0.0075 * 3.14159 * max(uSunSize, 0.05) * 60.0);
          float disc = smoothstep(discEdge - 0.0006, discEdge + 0.0006, cosA);
          float halo = pow(max(cosA, 0.0), mix(360.0, 40.0, uTurbidity)) * 0.55;
          float bloomWide = pow(max(cosA, 0.0), 6.0) * 0.12 * uTurbidity;

          col += uSunColor * (disc * uSunIntensity + halo * uSunIntensity * 0.35
                              + bloomWide * uSunIntensity * 0.15);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.envSky = new THREE.Mesh(geo, mat);
    this.envSky.frustumCulled = false;
    this.envScene.add(this.envSky);
  }

  /**
   * Regenerate the IBL for a planet. Call on level load — each world gets
   * genuinely different reflections and ambient, which is most of why they feel
   * like different places.
   */
  rebuildEnvironment(profile: Partial<EnvironmentProfile>): THREE.Texture {
    this.currentProfile = { ...this.currentProfile, ...profile };
    const p = this.currentProfile;
    if (!this.envSky) this.buildEnvScene();

    const u = (this.envSky!.material as THREE.ShaderMaterial).uniforms;
    (u.uZenith.value as THREE.Color).set(p.zenith).convertSRGBToLinear();
    (u.uHorizon.value as THREE.Color).set(p.horizon).convertSRGBToLinear();
    (u.uGround.value as THREE.Color).set(p.ground).convertSRGBToLinear();
    (u.uSunColor.value as THREE.Color).set(p.sunColor).convertSRGBToLinear();
    (u.uSunDir.value as THREE.Vector3).copy(p.sunDirection).normalize();
    u.uSunSize.value = p.sunSize;
    u.uSunIntensity.value = p.sunIntensity;
    u.uTurbidity.value = clamp01(p.turbidity);

    const prev = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.04, 0.1, 120);
    this.environment = this.envTarget.texture;
    prev?.dispose();

    for (const m of this.envConsumers) {
      m.envMap = this.environment;
      m.needsUpdate = true;
    }
    return this.environment;
  }

  get environmentProfile(): Readonly<EnvironmentProfile> {
    return this.currentProfile;
  }

  /** Diagnostic used by the capture harness: per-surface albedo variance. */
  measureAll(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, set] of this.sets) out[name] = this.baker.measureVariance(set.albedo);
    return out;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    this.sets.clear();
    this.baker.dispose();
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.envSky?.geometry.dispose();
    (this.envSky?.material as THREE.Material | undefined)?.dispose();
    this.envConsumers.length = 0;
  }
}
