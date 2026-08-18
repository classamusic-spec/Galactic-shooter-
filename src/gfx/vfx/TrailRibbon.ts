/**
 * TrailRibbon — camera-facing ribbons for anything that draws a path.
 *
 * Two jobs share one mesh and one draw call:
 *  - **Follow trails**: a rocket or a grenade hands over an Object3D and the
 *    ribbon samples its world position every rendered frame into a fixed-length
 *    node history.
 *  - **Static polylines**: arc chain lightning, void tendrils and stasis
 *    filaments write their nodes once and then just live out a short life.
 *
 * Orientation is done in the vertex shader against three's built-in
 * `cameraPosition` uniform, so the ribbon needs no camera reference and stays
 * correct in reflection passes and shadow-free re-renders alike.
 */
import * as THREE from 'three';

export interface TrailHandle {
  /** Stop feeding the ribbon; it fades out over its remaining life. */
  stop(): void;
  /** False once the ribbon has fully faded and returned to the pool. */
  readonly alive: boolean;
  /** Retint mid-flight (overheating rounds, element swap). */
  setColor(hex: number): void;
  /** Explicit position feed, for callers without an Object3D. */
  push(x: number, y: number, z: number): void;
}

interface RibbonSlot {
  active: boolean;
  /** Static polylines never resample; follow trails do. */
  isStatic: boolean;
  follow: THREE.Object3D | null;
  age: number;
  life: number;
  width: number;
  stopped: boolean;
  /** Node ring; index 0 is the head (newest). */
  nodes: Float32Array;
  count: number;
  color: THREE.Color;
  generation: number;
  additive: number;
  dirty: boolean;
}

const _wp = new THREE.Vector3();
const _t = new THREE.Vector3();
const _c = new THREE.Color();

const NODES = 24;

export class RibbonPool {
  readonly object: THREE.Mesh;
  readonly capacity: number;

  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aPos: THREE.BufferAttribute;
  private aTan: THREE.BufferAttribute;
  private aCol: THREE.BufferAttribute;
  private aParam: THREE.BufferAttribute; // side, width, alpha, additive
  private slots: RibbonSlot[] = [];
  private handles: TrailHandle[] = [];

  constructor(capacity: number) {
    this.capacity = Math.max(2, capacity);
    const verts = this.capacity * NODES * 2;

    this.geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aTan = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aCol = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aParam = new THREE.BufferAttribute(new Float32Array(verts * 4), 4);
    for (const a of [this.aPos, this.aTan, this.aCol, this.aParam]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    this.geo.setAttribute('position', this.aPos);
    this.geo.setAttribute('aTan', this.aTan);
    this.geo.setAttribute('aCol', this.aCol);
    this.geo.setAttribute('aParam', this.aParam);

    const idx: number[] = [];
    for (let r = 0; r < this.capacity; r++) {
      const base = r * NODES * 2;
      for (let i = 0; i < NODES - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    this.geo.setIndex(idx);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aTan;
        attribute vec3 aCol;
        attribute vec4 aParam;   // side, width, alpha, additive
        uniform float uFade;
        varying vec3 vCol;
        varying float vAlpha;
        varying float vAcross;
        varying float vAdditive;
        void main() {
          vCol = aCol;
          vAlpha = aParam.z * uFade;
          vAcross = aParam.x;
          vAdditive = aParam.w;
          vec3 toEye = normalize(cameraPosition - position);
          vec3 side = cross(normalize(aTan), toEye);
          float sl = length(side);
          side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
          vec3 wp = position + side * (aParam.x * aParam.y * 0.5);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying float vAlpha;
        varying float vAcross;
        varying float vAdditive;
        void main() {
          float across = abs(vAcross);
          float core = 1.0 - smoothstep(0.0, 1.0, across);
          float a = core * core * vAlpha;
          if (a <= 0.003) discard;
          vec3 col = vCol * (1.0 + 5.0 * pow(core, 7.0));
          gl_FragColor = vec4(col * a, a * (1.0 - vAdditive));
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    this.object = new THREE.Mesh(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 13;
    this.object.name = 'vfx.ribbons';
    this.object.matrixAutoUpdate = false;

    for (let i = 0; i < this.capacity; i++) {
      const slot: RibbonSlot = {
        active: false,
        isStatic: false,
        follow: null,
        age: 0,
        life: 1,
        width: 0.1,
        stopped: false,
        nodes: new Float32Array(NODES * 3),
        count: 0,
        color: new THREE.Color(1, 1, 1),
        generation: 0,
        additive: 1,
        dirty: false,
      };
      this.slots.push(slot);
      this.handles.push(makeHandle(this, i));
    }
    this.geo.setDrawRange(0, 0);
  }

  /** Internal: slot accessor for the handle closures. */
  slotAt(i: number): RibbonSlot {
    return this.slots[i];
  }

  private alloc(): number {
    for (let i = 0; i < this.slots.length; i++) if (!this.slots[i].active) return i;
    // All busy: recycle whichever is furthest through its life.
    let best = 0;
    let bestRel = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const rel = this.slots[i].age / this.slots[i].life;
      if (rel > bestRel) {
        bestRel = rel;
        best = i;
      }
    }
    return best;
  }

  /** Start a ribbon that follows an object. */
  follow(
    obj: THREE.Object3D,
    color: number,
    width: number,
    life: number,
    additive = 1,
  ): TrailHandle {
    const i = this.alloc();
    const s = this.slots[i];
    s.active = true;
    s.isStatic = false;
    s.follow = obj;
    s.age = 0;
    s.life = Math.max(0.05, life);
    s.width = width;
    s.stopped = false;
    s.count = 0;
    s.additive = additive;
    s.generation++;
    _c.setHex(color, THREE.SRGBColorSpace);
    s.color.copy(_c);
    obj.getWorldPosition(_wp);
    this.seed(s, _wp.x, _wp.y, _wp.z);
    s.dirty = true;
    return this.handles[i];
  }

  /** A one-shot polyline: chain lightning, tendrils, filaments. */
  polyline(
    pts: Float32Array,
    count: number,
    color: number,
    width: number,
    life: number,
    additive = 1,
  ): void {
    if (count < 2) return;
    const i = this.alloc();
    const s = this.slots[i];
    s.active = true;
    s.isStatic = true;
    s.follow = null;
    s.age = 0;
    s.life = Math.max(0.05, life);
    s.width = width;
    s.stopped = true;
    s.additive = additive;
    s.generation++;
    _c.setHex(color, THREE.SRGBColorSpace);
    s.color.copy(_c);

    // Always resample onto the full node count. Leaving the tail of the strip
    // holding the previous ribbon's positions was drawing ghost segments.
    for (let k = 0; k < NODES; k++) {
      const u = (k / (NODES - 1)) * (count - 1);
      const i0 = Math.min(Math.floor(u), count - 2);
      const f = u - i0;
      const a = i0 * 3;
      const b = a + 3;
      s.nodes[k * 3] = pts[a] + (pts[b] - pts[a]) * f;
      s.nodes[k * 3 + 1] = pts[a + 1] + (pts[b + 1] - pts[a + 1]) * f;
      s.nodes[k * 3 + 2] = pts[a + 2] + (pts[b + 2] - pts[a + 2]) * f;
    }
    s.count = NODES;
    s.dirty = true;
  }

  private seed(s: RibbonSlot, x: number, y: number, z: number): void {
    for (let k = 0; k < NODES; k++) {
      s.nodes[k * 3] = x;
      s.nodes[k * 3 + 1] = y;
      s.nodes[k * 3 + 2] = z;
    }
    s.count = NODES;
  }

  push(i: number, x: number, y: number, z: number): void {
    const s = this.slots[i];
    if (!s.active || s.isStatic) return;
    if (s.count === 0) {
      this.seed(s, x, y, z);
      return;
    }
    // Shift the history down one and write the new head.
    const nodes = s.nodes;
    for (let k = NODES - 1; k > 0; k--) {
      nodes[k * 3] = nodes[(k - 1) * 3];
      nodes[k * 3 + 1] = nodes[(k - 1) * 3 + 1];
      nodes[k * 3 + 2] = nodes[(k - 1) * 3 + 2];
    }
    nodes[0] = x;
    nodes[1] = y;
    nodes[2] = z;
    s.dirty = true;
  }

  /** Per rendered frame: resample followers, age everything, rebuild vertices. */
  flush(frameDt: number): void {
    let anyActive = false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) continue;

      s.age += frameDt;
      if (s.age >= s.life) {
        s.active = false;
        s.follow = null;
        this.hide(i);
        continue;
      }
      if (!s.isStatic && s.follow && !s.stopped) {
        if (s.follow.parent) {
          s.follow.getWorldPosition(_wp);
          this.push(i, _wp.x, _wp.y, _wp.z);
        } else {
          // The followed object left the scene: let the trail run out.
          s.stopped = true;
        }
      } else if (!s.isStatic && s.stopped) {
        // Drag the tail into the head so a stopped trail retracts instead of
        // hanging in the air.
        this.push(i, s.nodes[0], s.nodes[1], s.nodes[2]);
      }
      this.writeRibbon(i);
      anyActive = true;
    }

    if (anyActive) {
      this.aPos.needsUpdate = true;
      this.aTan.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aParam.needsUpdate = true;
      this.geo.setDrawRange(0, this.capacity * (NODES - 1) * 6);
    } else {
      this.geo.setDrawRange(0, 0);
    }
  }

  private hide(i: number): void {
    const base = i * NODES * 2;
    for (let k = 0; k < NODES * 2; k++) {
      this.aParam.array[(base + k) * 4 + 1] = 0;
      this.aParam.array[(base + k) * 4 + 2] = 0;
    }
    this.aParam.needsUpdate = true;
  }

  private writeRibbon(i: number): void {
    const s = this.slots[i];
    const base = i * NODES * 2;
    const pos = this.aPos.array as Float32Array;
    const tan = this.aTan.array as Float32Array;
    const col = this.aCol.array as Float32Array;
    const par = this.aParam.array as Float32Array;
    const lifeFade = 1 - Math.max(0, s.age / s.life - 0.55) / 0.45;
    const fadeIn = Math.min(1, s.age / 0.04);

    for (let k = 0; k < NODES; k++) {
      const n0 = k * 3;
      const prev = Math.max(0, k - 1) * 3;
      const next = Math.min(NODES - 1, k + 1) * 3;
      _t.set(
        s.nodes[next] - s.nodes[prev],
        s.nodes[next + 1] - s.nodes[prev + 1],
        s.nodes[next + 2] - s.nodes[prev + 2],
      );
      if (_t.lengthSq() < 1e-8) _t.set(0, 1, 0);
      else _t.normalize();

      const u = k / (NODES - 1);
      // A follow trail tapers from a full-width head to nothing; a bolt or
      // tendril is pinned at both ends and full width through the middle.
      const taper = s.isStatic
        ? 0.18 + 0.82 * Math.pow(Math.sin(u * Math.PI), 0.32)
        : Math.pow(1 - u, 0.65);
      const w = s.width * taper;
      const alpha = taper * lifeFade * fadeIn;

      for (let side = 0; side < 2; side++) {
        const v = base + k * 2 + side;
        pos[v * 3] = s.nodes[n0];
        pos[v * 3 + 1] = s.nodes[n0 + 1];
        pos[v * 3 + 2] = s.nodes[n0 + 2];
        tan[v * 3] = _t.x;
        tan[v * 3 + 1] = _t.y;
        tan[v * 3 + 2] = _t.z;
        col[v * 3] = s.color.r;
        col[v * 3 + 1] = s.color.g;
        col[v * 3 + 2] = s.color.b;
        par[v * 4] = side === 0 ? -1 : 1;
        par[v * 4 + 1] = w;
        par[v * 4 + 2] = alpha;
        par[v * 4 + 3] = s.additive;
      }
    }
    s.dirty = false;
  }

  setFade(f: number): void {
    this.mat.uniforms.uFade.value = f;
  }

  clear(): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].active = false;
      this.slots[i].follow = null;
      this.hide(i);
    }
    this.geo.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

function makeHandle(pool: RibbonPool, index: number): TrailHandle {
  return {
    stop(): void {
      pool.slotAt(index).stopped = true;
    },
    get alive(): boolean {
      return pool.slotAt(index).active;
    },
    setColor(hex: number): void {
      _c.setHex(hex, THREE.SRGBColorSpace);
      pool.slotAt(index).color.copy(_c);
    },
    push(x: number, y: number, z: number): void {
      pool.push(index, x, y, z);
    },
  };
}
