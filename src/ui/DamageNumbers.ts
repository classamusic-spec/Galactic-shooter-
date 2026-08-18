/**
 * Floating damage numbers.
 *
 * Pooled DOM nodes, world-space anchored: each number keeps the impact point
 * it was born at and is re-projected every frame, so it stays glued to the
 * enemy while the camera moves and only the arc offset is added in screen
 * space. Rapid hits on the same entity merge into one accumulating number
 * rather than stacking a column of "12"s.
 */
import * as THREE from 'three';
import type { DamageElement } from '@/types';
import { ELEMENT_COLOR } from './ui.css';
import { div, easeOutCubic, StyleBind, TextBind, toggle } from './dom';

const POOL = 34;
const LIFE = 1.15;
const MERGE_WINDOW = 0.55;

interface Entry {
  node: HTMLElement;
  text: TextBind;
  transform: StyleBind;
  opacity: StyleBind;
  color: StyleBind;
  world: THREE.Vector3;
  entityId: number;
  value: number;
  t: number;
  active: boolean;
  crit: boolean;
  driftX: number;
  startY: number;
  rise: number;
  punch: number;
  sizeClass: string;
}

const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rel = new THREE.Vector3();

export class DamageNumbers {
  private readonly root: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly pool: Entry[] = [];
  private cursor = 0;
  private seed = 1;

  constructor(parent: HTMLElement, camera: THREE.Camera) {
    this.camera = camera;
    this.root = div('gf-dmgnums', parent);
    for (let i = 0; i < POOL; i++) {
      const node = div('gf-dmg', this.root);
      this.pool.push({
        node,
        text: new TextBind(node),
        transform: new StyleBind(node, 'transform'),
        opacity: new StyleBind(node, 'opacity'),
        color: new StyleBind(node, '--c'),
        world: new THREE.Vector3(),
        entityId: -1,
        value: 0,
        t: 0,
        active: false,
        crit: false,
        driftX: 0,
        startY: 0,
        rise: 0,
        punch: 0,
        sizeClass: '',
      });
    }
  }

  spawn(
    point: THREE.Vector3,
    amount: number,
    precision: boolean,
    element: DamageElement,
    entityId: number,
  ): void {
    if (amount <= 0) return;

    // Merge into a recent number on the same entity so a burst reads as one
    // escalating figure, the way Destiny stacks sustained fire.
    for (const e of this.pool) {
      if (e.active && e.entityId === entityId && e.t < MERGE_WINDOW) {
        e.value += amount;
        e.crit = e.crit || precision;
        e.t = Math.max(0, e.t - 0.16);
        e.punch = 1;
        e.world.copy(point);
        this.style(e, element);
        return;
      }
    }

    const e = this.take();
    e.active = true;
    e.entityId = entityId;
    e.value = amount;
    e.crit = precision;
    e.t = 0;
    e.punch = 1;
    e.world.copy(point);
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    const r = (this.seed % 1000) / 1000;
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    const r2 = (this.seed % 1000) / 1000;
    // Wide lateral throw plus a staggered start height: without both, a burst
    // of five hits on one enemy renders as an unreadable pile at the impact.
    e.driftX = (r - 0.5) * 150;
    e.startY = (r2 - 0.5) * 46;
    e.rise = 46 + r2 * 40;
    this.style(e, element);
  }

  private take(): Entry {
    for (let i = 0; i < POOL; i++) {
      const e = this.pool[(this.cursor + i) % POOL];
      if (!e.active) {
        this.cursor = (this.cursor + i + 1) % POOL;
        return e;
      }
    }
    const e = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % POOL;
    return e;
  }

  private style(e: Entry, element: DamageElement): void {
    const v = Math.round(e.value);
    e.text.set(e.crit ? `${v}` : String(v));
    const size = e.crit ? 'is-crit' : v >= 120 ? 'is-l' : v >= 45 ? 'is-m' : 'is-s';
    if (size !== e.sizeClass) {
      if (e.sizeClass) e.node.classList.remove(e.sizeClass);
      e.node.classList.add(size);
      e.sizeClass = size;
    }
    e.color.set(e.crit ? '#ffe7a8' : ELEMENT_COLOR[element]);
    toggle(e.node, 'is-precision', e.crit);
  }

  render(dt: number, visible: boolean): void {
    toggle(this.root, 'is-on', visible);
    if (!visible) {
      for (const e of this.pool) if (e.active) this.retire(e);
      return;
    }
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (w < 2 || h < 2) return;
    this.camera.getWorldDirection(_fwd);

    for (const e of this.pool) {
      if (!e.active) continue;
      e.t += dt;
      if (e.t >= LIFE) {
        this.retire(e);
        continue;
      }
      _rel.copy(e.world).sub(this.camera.position);
      if (_rel.dot(_fwd) <= 0.15) {
        e.opacity.num(0);
        continue;
      }
      _p.copy(e.world).project(this.camera);
      const x = (_p.x * 0.5 + 0.5) * w;
      const y = (-_p.y * 0.5 + 0.5) * h;
      const k = e.t / LIFE;
      const ease = easeOutCubic(Math.min(1, k * 1.35));
      // Arc: rise fast, then let gravity pull the tail back down a touch.
      const lift = e.rise * ease - k * k * 26 - e.startY;
      e.punch = Math.max(0, e.punch - dt * 7);
      const scale = 1 + e.punch * 0.34;
      e.transform.set(
        `translate3d(${(x + e.driftX * ease).toFixed(1)}px, ${(y - lift).toFixed(1)}px, 0) translate(-50%,-50%) scale(${scale.toFixed(3)})`,
      );
      e.opacity.num(k < 0.62 ? 1 : 1 - (k - 0.62) / 0.38);
    }
  }

  private retire(e: Entry): void {
    e.active = false;
    e.opacity.num(0);
    e.entityId = -1;
  }

  clear(): void {
    for (const e of this.pool) if (e.active) this.retire(e);
  }

  dispose(): void {
    this.root.remove();
  }
}
