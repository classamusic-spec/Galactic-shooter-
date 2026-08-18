/**
 * Engine: fixed-timestep simulation, render orchestration, level lifecycle.
 *
 * Simulation runs at a fixed 120 Hz for stable weapon cadence, recoil and
 * physics; rendering happens once per animation frame with interpolation left
 * to individual systems that care.
 */
import * as THREE from 'three';
import type { FrameContext, Level } from '@/types';
import { RendererHost } from './Renderer';
import { InputSystem } from './Input';
import { settings } from './Settings';
import { events } from './EventBus';

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;
/** Never simulate more than this many steps in one frame — avoids death spirals. */
const MAX_STEPS = 8;
/**
 * Ceiling on a *stretched* step, used only when the renderer cannot feed the
 * fixed step fast enough. 1/30 s keeps the character controller's per-step
 * displacement under a third of a metre at sprint speed, which the sweep solver
 * handles; anything longer starts tunnelling.
 */
const MAX_SIM_DT = 1 / 30;

export type GameState = 'boot' | 'menu' | 'loading' | 'playing' | 'paused' | 'dead' | 'starmap';

export interface EngineSystem {
  readonly name: string;
  /** Fixed-step simulation. */
  update?(ctx: FrameContext): void;
  /** Called once per rendered frame, after simulation. Good for visual lerps. */
  render?(ctx: FrameContext, alpha: number): void;
  dispose?(): void;
}

export class Engine {
  readonly host: RendererHost;
  readonly input: InputSystem;
  readonly clock = new THREE.Clock(false);

  /** Currently active level; null while in menus or the star map. */
  level: Level | null = null;
  state: GameState = 'boot';

  private systems: EngineSystem[] = [];
  private accumulator = 0;
  private tick = 0;
  private elapsed = 0;
  private running = false;
  private rafId = 0;
  private lastFrameStart = 0;
  private ctx: FrameContext = { dt: SIM_DT, frameDt: SIM_DT, elapsed: 0, tick: 0 };

  /** Assigned by the composited render pipeline once PostFX is installed. */
  renderPipeline: ((scene: THREE.Scene, camera: THREE.Camera, frameDt: number) => void) | null =
    null;

  /** Smoothed frame time in ms, exposed for the debug overlay. */
  frameMs = 16;
  fps = 60;
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.host = new RendererHost(canvas);
    this.input = new InputSystem(canvas);
    events.on('settings:changed', () => {
      this.host.renderer.toneMappingExposure = settings.user.exposure;
      this.host.markResizeDirty();
      this.host.applyFov();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
  }

  add<T extends EngineSystem>(system: T): T {
    this.systems.push(system);
    return system;
  }

  remove(system: EngineSystem): void {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
  }

  get<T extends EngineSystem>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  setLevel(level: Level | null): void {
    if (this.level && this.level !== level) this.level.dispose();
    this.level = level;
    if (level) events.emit('level:loaded', { id: level.id });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.lastFrameStart = performance.now();
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.clock.stop();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.exitPointerLock();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.accumulator = 0;
    this.input.requestPointerLock();
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now();
    const frameDt = Math.min((now - this.lastFrameStart) / 1000, 0.25);
    this.lastFrameStart = now;

    this.frameMs += (frameDt * 1000 - this.frameMs) * 0.1;
    this.fpsAccum += frameDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    this.host.beginFrame(frameDt * 1000);

    // -- fixed-step simulation ---------------------------------------------
    const simulating = this.state === 'playing' || this.state === 'starmap' || this.state === 'dead';
    if (simulating) {
      this.accumulator += frameDt;
      // Below ~15 fps the 120 Hz step needs more than MAX_STEPS iterations to
      // clear a frame's worth of time. Dropping the backlog there keeps the
      // simulation stable but runs the whole game in slow motion — at 4 fps the
      // player crawls and enemies barely animate, which reads as "the level is
      // frozen and I can't move" rather than as a low frame rate. Stretching the
      // step instead keeps game time locked to wall time: determinism is
      // unaffected at any frame rate that can actually keep up, and the degraded
      // case is a coarse step rather than a stopped world.
      let dt = SIM_DT;
      if (this.accumulator > SIM_DT * MAX_STEPS) {
        dt = Math.min(this.accumulator / MAX_STEPS, MAX_SIM_DT);
      }
      let steps = 0;
      while (this.accumulator >= dt && steps < MAX_STEPS) {
        this.accumulator -= dt;
        steps++;
        this.tick++;
        this.elapsed += dt;
        this.ctx.dt = dt;
        this.ctx.frameDt = frameDt;
        this.ctx.elapsed = this.elapsed;
        this.ctx.tick = this.tick;

        this.input.beginStep(this.elapsed);
        this.level?.update(this.ctx);
        for (const s of this.systems) s.update?.(this.ctx);
        this.input.endStep(this.elapsed);
      }
      // Drop backlog rather than fast-forwarding after a long stall.
      if (steps >= MAX_STEPS) this.accumulator = 0;
    } else {
      this.ctx.frameDt = frameDt;
      this.ctx.elapsed = this.elapsed;
    }

    // -- render -------------------------------------------------------------
    const alpha = Math.min(this.accumulator / SIM_DT, 1);
    for (const s of this.systems) s.render?.(this.ctx, alpha);

    const scene = this.level?.scene;
    if (scene) {
      if (this.renderPipeline) this.renderPipeline(scene, this.host.camera, frameDt);
      else this.host.renderer.render(scene, this.host.camera);
    }
  };

  dispose(): void {
    this.stop();
    for (const s of this.systems) s.dispose?.();
    this.systems.length = 0;
    this.level?.dispose();
    this.host.dispose();
  }
}
