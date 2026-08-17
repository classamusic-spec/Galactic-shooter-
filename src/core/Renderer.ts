/**
 * WebGL2 renderer host: colour management, tone mapping, shadow policy and
 * adaptive resolution. Owns the canvas; PostFX composes on top of it.
 */
import * as THREE from 'three';
import { settings } from './Settings';
import { clamp } from '@/util/math';

export class RendererHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
  /** Rendered size in device pixels, after resolution scale. */
  readonly drawingBufferSize = new THREE.Vector2();
  /** CSS size in logical pixels. */
  readonly cssSize = new THREE.Vector2();

  private frameMsAvg = 14;
  private resizeDirty = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // post-process AA (TAA/FXAA) handles this
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });

    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = settings.user.exposure;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.VSMShadowMap;
    r.shadowMap.autoUpdate = true;
    r.autoClear = true;
    r.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(settings.user.fov, 1, 0.06, 4000);
    this.camera.rotation.order = 'YXZ';

    window.addEventListener('resize', () => (this.resizeDirty = true), { passive: true });
    window.addEventListener('orientationchange', () => (this.resizeDirty = true), {
      passive: true,
    });
    this.applySize();
  }

  get gl(): WebGL2RenderingContext {
    return this.renderer.getContext() as WebGL2RenderingContext;
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  /** Effective anisotropy for world textures, respecting the quality tier. */
  get anisotropy(): number {
    return Math.min(settings.profile.anisotropy, this.maxAnisotropy);
  }

  /** Call once per rendered frame before drawing. */
  beginFrame(frameMs: number): boolean {
    // Exponential moving average keeps adaptive res from oscillating.
    this.frameMsAvg += (frameMs - this.frameMsAvg) * 0.08;
    const before = settings.resolutionScale;
    settings.tickAdaptiveResolution(this.frameMsAvg);
    if (Math.abs(settings.resolutionScale - before) > 0.001) this.resizeDirty = true;
    this.renderer.info.reset();
    if (this.resizeDirty) {
      this.applySize();
      return true;
    }
    return false;
  }

  private applySize(): void {
    this.resizeDirty = false;
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.cssSize.set(w, h);

    const dpr = clamp(window.devicePixelRatio || 1, 0.5, settings.profile.maxPixelRatio);
    const scale = dpr * settings.resolutionScale;
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(w, h, false);
    this.drawingBufferSize.set(Math.round(w * scale), Math.round(h * scale));

    this.camera.aspect = w / h;
    this.applyFov();
  }

  /**
   * Horizontal FOV from settings, converted to the vertical FOV three.js wants.
   * Uses Hor+ scaling so ultrawide players see more, not less.
   */
  applyFov(zoom = 1): void {
    const hFov = (settings.user.fov / zoom) * (Math.PI / 180);
    const halfH = Math.tan(hFov / 2) / Math.max(this.camera.aspect, 0.0001);
    this.camera.fov = 2 * Math.atan(halfH) * (180 / Math.PI);
    this.camera.updateProjectionMatrix();
  }

  markResizeDirty(): void {
    this.resizeDirty = true;
  }

  get stats(): { calls: number; triangles: number; programs: number; geometries: number } {
    const i = this.renderer.info;
    return {
      calls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
      geometries: i.memory.geometries,
    };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
