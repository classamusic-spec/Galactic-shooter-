/**
 * ScatterSystem — density-driven world scatter with real culling and LOD.
 *
 * The interesting problem is not "draw 100k instances", it is "decide which
 * 15k of the 150k candidates are worth submitting this frame, without
 * allocating and without a per-frame O(candidates) pass".
 *
 * Structure:
 *  - **Placement** happens once, at load. A cached coarse height grid (a few
 *    hundred microseconds to fill) lets the density gates — slope, height,
 *    curvature, moisture — be evaluated for hundreds of thousands of trial
 *    points without paying for the full analytic field each time. Accepted
 *    points get one exact `heightField.height()` call so nothing floats.
 *  - **Distribution** is a jittered grid with best-candidate rejection against
 *    the eight neighbouring cells. That gives blue-noise spacing (no clumps, no
 *    visible lattice) for a fraction of the cost of Poisson-disc dart throwing.
 *  - **Culling** buckets candidates into a coarse grid, counting-sorted so each
 *    bucket is a contiguous index range. Per update we frustum-test buckets, not
 *    instances, then split survivors into a near (detailed, shadow-casting) and
 *    a far (low-poly, no shadow) `InstancedMesh`.
 *  - **Throttling** rebuilds only when the camera has actually moved or turned,
 *    so standing still costs nothing.
 */
import * as THREE from 'three';
import { settings } from '@/core/Settings';
import { Rng, clamp } from '@/util/math';
import type { HeightField } from './HeightField';

export interface ScatterProtoDef {
  id: string;
  /** Detailed geometry used inside `nearDistance`. */
  near: THREE.BufferGeometry;
  /** Cheap geometry used from `nearDistance` to `distance`. */
  far: THREE.BufferGeometry;
  material: THREE.Material;
  /** Depth material with matching vertex displacement, for shadow casting. */
  depthMaterial?: THREE.Material;
  /** Instances per square metre before the quality multiplier. */
  density: number;
  minScale: number;
  maxScale: number;
  /** Radians. Candidates on steeper ground are rejected. */
  maxSlope: number;
  heightLo: number;
  heightHi: number;
  moistureLo: number;
  moistureHi: number;
  /** 0 = always upright, 1 = fully aligned to the ground normal. */
  alignToNormal: number;
  /** Per-instance tint is lerped between these two sRGB hexes. */
  tintA: number;
  tintB: number;
  /** Cull distance, metres. */
  distance: number;
  /** Inside this radius the detailed mesh is used and casts shadows. */
  nearDistance: number;
  castShadow: boolean;
  /** Bake world-space collider geometry from the far mesh. */
  collide: boolean;
  /** Placement radius from the origin, metres. */
  radius: number;
  /** Fraction of the instance's height buried, hiding the ground seam. */
  sink: number;
  /** Scale the density by the foliage-density profile knob (flora yes, rocks no). */
  useFoliageDensity: boolean;
  /** Random tilt off vertical, radians. */
  tilt: number;
}

interface Proto {
  def: ScatterProtoDef;
  count: number;
  /** Candidate arrays. */
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  scale: Float32Array;
  qx: Float32Array;
  qy: Float32Array;
  qz: Float32Array;
  qw: Float32Array;
  tint: Float32Array;
  /** Counting-sort buckets over the culling grid. */
  bucketStart: Int32Array;
  order: Int32Array;
  nearMesh: THREE.InstancedMesh;
  farMesh: THREE.InstancedMesh;
  nearCap: number;
  farCap: number;
  drawnNear: number;
  drawnFar: number;
}

interface Bucket {
  /** Culling box, world space. */
  box: THREE.Box3;
  cx: number;
  cz: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _nrm = new THREE.Vector3();
const _col = new THREE.Color();
const _colA = new THREE.Color();
const _colB = new THREE.Color();
const _qAlign = new THREE.Quaternion();
const _qTilt = new THREE.Quaternion();
const _qId = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();

export interface ScatterOptions {
  /** Half-extent of the placement region, metres. */
  region?: number;
  /** Coarse height-cache pitch, metres. */
  gridPitch?: number;
  /** Culling bucket size, metres. */
  bucketSize?: number;
}

export class ScatterSystem {
  readonly object = new THREE.Group();
  /** World-space collider meshes for prototypes flagged `collide`. */
  readonly colliders: THREE.Mesh[] = [];

  private field: HeightField;
  private region: number;
  private pitch: number;
  private bucketSize: number;
  private defs: ScatterProtoDef[] = [];
  private protos: Proto[] = [];
  private buckets: Bucket[] = [];
  private bucketsPerAxis = 0;

  /** Coarse height cache covering the placement region. */
  private grid!: Float32Array;
  private gridN = 0;

  private lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  private lastDir = new THREE.Vector3();
  private dirty = true;
  private candidateTotal = 0;
  private ownedGeometries: THREE.BufferGeometry[] = [];

  constructor(field: HeightField, opts: ScatterOptions = {}) {
    this.field = field;
    this.region = opts.region ?? field.descriptor.extent;
    this.pitch = opts.gridPitch ?? 2.5;
    this.bucketSize = opts.bucketSize ?? 28;
    this.object.name = 'scatter';
  }

  add(def: ScatterProtoDef): void {
    this.defs.push(def);
  }

  get stats(): {
    candidates: number;
    drawnNear: number;
    drawnFar: number;
    protos: number;
    drawCalls: number;
  } {
    let dn = 0;
    let df = 0;
    for (const p of this.protos) {
      dn += p.drawnNear;
      df += p.drawnFar;
    }
    return {
      candidates: this.candidateTotal,
      drawnNear: dn,
      drawnFar: df,
      protos: this.protos.length,
      drawCalls: this.protos.length * 2,
    };
  }

  // -- build ----------------------------------------------------------------

  async build(seed: number, onProgress?: (t: number) => void): Promise<void> {
    this.buildHeightCache();
    this.buildBuckets();

    for (let i = 0; i < this.defs.length; i++) {
      this.protos.push(this.place(this.defs[i], (seed + i * 7477) >>> 0));
      onProgress?.((i + 1) / this.defs.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    this.dirty = true;
  }

  /**
   * Coarse height cache. Bilinear sampling of this replaces the analytic field
   * during candidate rejection; the analytic field is only consulted for points
   * that survive, which is a ~40× reduction in field evaluations.
   */
  private buildHeightCache(): void {
    const n = Math.ceil((this.region * 2) / this.pitch) + 1;
    this.gridN = n;
    this.grid = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const z = -this.region + j * this.pitch;
      for (let i = 0; i < n; i++) {
        this.grid[j * n + i] = this.field.height(-this.region + i * this.pitch, z);
      }
    }
  }

  private gridHeight(x: number, z: number): number {
    const n = this.gridN;
    const fx = clamp((x + this.region) / this.pitch, 0, n - 1.001);
    const fz = clamp((z + this.region) / this.pitch, 0, n - 1.001);
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const g = this.grid;
    const a = g[j * n + i];
    const b = g[j * n + i + 1];
    const c = g[(j + 1) * n + i];
    const d = g[(j + 1) * n + i + 1];
    return a + (b - a) * tx + (c + (d - c) * tx - (a + (b - a) * tx)) * tz;
  }

  /** Slope, curvature and moisture from the cache — all placement needs. */
  private sample(x: number, z: number): { h: number; slope: number; curve: number; moist: number } {
    const e = this.pitch;
    const h = this.gridHeight(x, z);
    const hx = this.gridHeight(x + e, z) - this.gridHeight(x - e, z);
    const hz = this.gridHeight(x, z + e) - this.gridHeight(x, z - e);
    const gx = hx / (2 * e);
    const gz = hz / (2 * e);
    const slope = Math.atan(Math.hypot(gx, gz));
    const curve =
      (this.gridHeight(x + e * 2, z) +
        this.gridHeight(x - e * 2, z) +
        this.gridHeight(x, z + e * 2) +
        this.gridHeight(x, z - e * 2)) /
        4 -
      h;
    // Moisture: concave ground holds water, steep ground sheds it, and the
    // waterline soaks everything near it.
    let m = 0.46 + clamp(curve * 0.3, -0.32, 0.32) - clamp(slope * 0.5, 0, 0.4);
    const w = this.field.descriptor.water;
    if (w) {
      const above = Math.max(0, h - w.level);
      m += (1 - clamp(above / 24, 0, 1)) * 0.5;
    }
    return { h, slope, curve, moist: clamp(m, 0, 1) };
  }

  private buildBuckets(): void {
    const n = Math.ceil((this.region * 2) / this.bucketSize);
    this.bucketsPerAxis = n;
    this.buckets = new Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x0 = -this.region + i * this.bucketSize;
        const z0 = -this.region + j * this.bucketSize;
        this.buckets[j * n + i] = {
          box: new THREE.Box3(
            new THREE.Vector3(x0, 0, z0),
            new THREE.Vector3(x0 + this.bucketSize, 0, z0 + this.bucketSize),
          ),
          cx: x0 + this.bucketSize * 0.5,
          cz: z0 + this.bucketSize * 0.5,
        };
      }
    }
  }

  private bucketIndex(x: number, z: number): number {
    const n = this.bucketsPerAxis;
    const i = clamp(Math.floor((x + this.region) / this.bucketSize), 0, n - 1);
    const j = clamp(Math.floor((z + this.region) / this.bucketSize), 0, n - 1);
    return j * n + i;
  }

  /** Generate candidates for one prototype and build its instanced meshes. */
  private place(def: ScatterProtoDef, seed: number): Proto {
    const prof = settings.profile;
    const density =
      def.density * (def.useFoliageDensity ? prof.foliageDensity : 0.4 + prof.foliageDensity * 0.6);
    // The cell size IS the mean spacing, so the upper clamp is a real design
    // limit: at 60 m a prototype authored at "four per map" (arches) came out one
    // every 60 m, which turned the midground into a forest of monoliths.
    const cell = clamp(1 / Math.sqrt(Math.max(density, 1e-9)), 0.5, 700);
    const radius = Math.min(def.radius, this.region);
    const cells = Math.ceil((radius * 2) / cell);
    const rng = new Rng(seed);

    // Accepted point per cell (NaN = empty), for the blue-noise spacing test.
    const accX = new Float32Array(cells * cells).fill(NaN);
    const accZ = new Float32Array(cells * cells);
    const px: number[] = [];
    const pz: number[] = [];
    const py: number[] = [];
    const sc: number[] = [];
    const qx: number[] = [];
    const qy: number[] = [];
    const qz: number[] = [];
    const qw: number[] = [];
    const tint: number[] = [];
    _colA.set(def.tintA).convertSRGBToLinear();
    _colB.set(def.tintB).convertSRGBToLinear();

    const minGap = cell * 0.62;
    const hardCap = 260000;

    for (let cj = 0; cj < cells && px.length < hardCap; cj++) {
      for (let ci = 0; ci < cells; ci++) {
        const bx = -radius + (ci + 0.5) * cell;
        const bz = -radius + (cj + 0.5) * cell;
        if (bx * bx + bz * bz > radius * radius) continue;

        // Best-candidate: three darts, keep the one furthest from the accepted
        // points in the 3×3 neighbourhood. Cheap blue noise.
        let bestX = 0;
        let bestZ = 0;
        let bestScore = -1;
        let bestSample: { h: number; slope: number; curve: number; moist: number } | null = null;
        for (let k = 0; k < 3; k++) {
          const x = bx + rng.range(-cell * 0.5, cell * 0.5);
          const z = bz + rng.range(-cell * 0.5, cell * 0.5);
          const s = this.sample(x, z);
          if (s.slope > def.maxSlope) continue;
          if (s.h < def.heightLo || s.h > def.heightHi) continue;
          if (s.moist < def.moistureLo || s.moist > def.moistureHi) continue;
          let score = 1e9;
          for (let dj = -1; dj <= 1; dj++) {
            const nj = cj + dj;
            if (nj < 0 || nj >= cells) continue;
            for (let di = -1; di <= 1; di++) {
              const ni = ci + di;
              if (ni < 0 || ni >= cells) continue;
              const ax = accX[nj * cells + ni];
              if (Number.isNaN(ax)) continue;
              const d = Math.hypot(ax - x, accZ[nj * cells + ni] - z);
              if (d < score) score = d;
            }
          }
          if (score < minGap) continue;
          if (score > bestScore) {
            bestScore = score;
            bestX = x;
            bestZ = z;
            bestSample = s;
          }
        }
        if (!bestSample) continue;

        accX[cj * cells + ci] = bestX;
        accZ[cj * cells + ci] = bestZ;

        // Exact height + normal only for accepted points.
        this.field.normal(bestX, bestZ, _nrm);
        const y = this.field.height(bestX, bestZ);
        const s = rng.range(def.minScale, def.maxScale);

        _q.setFromAxisAngle(_up, rng.range(0, Math.PI * 2));
        if (def.alignToNormal > 0) {
          _qAlign.setFromUnitVectors(_up, _nrm);
          if (def.alignToNormal < 1) _qAlign.slerp(_qId, 1 - def.alignToNormal);
          _q.premultiply(_qAlign);
        }
        if (def.tilt > 0) {
          _axis.set(rng.gaussian(), 0, rng.gaussian());
          if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0);
          _axis.normalize();
          _qTilt.setFromAxisAngle(_axis, rng.gaussian() * def.tilt);
          _q.premultiply(_qTilt);
        }

        px.push(bestX);
        py.push(y - s * def.sink);
        pz.push(bestZ);
        sc.push(s);
        qx.push(_q.x);
        qy.push(_q.y);
        qz.push(_q.z);
        qw.push(_q.w);
        _col.copy(_colA).lerp(_colB, rng.next());
        // A little independent value jitter stops a field of instances reading
        // as one flat colour swatch.
        const v = rng.range(0.82, 1.18);
        tint.push(_col.r * v, _col.g * v, _col.b * v);
      }
    }

    const count = px.length;
    this.candidateTotal += count;

    const proto: Proto = {
      def,
      count,
      px: new Float32Array(px),
      py: new Float32Array(py),
      pz: new Float32Array(pz),
      scale: new Float32Array(sc),
      qx: new Float32Array(qx),
      qy: new Float32Array(qy),
      qz: new Float32Array(qz),
      qw: new Float32Array(qw),
      tint: new Float32Array(tint),
      bucketStart: new Int32Array(this.buckets.length + 1),
      order: new Int32Array(count),
      nearMesh: null as unknown as THREE.InstancedMesh,
      farMesh: null as unknown as THREE.InstancedMesh,
      nearCap: 0,
      farCap: 0,
      drawnNear: 0,
      drawnFar: 0,
    };

    // Counting sort into culling buckets, and grow each bucket's Y extent so the
    // frustum test is conservative.
    const counts = new Int32Array(this.buckets.length);
    const bucketOf = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const b = this.bucketIndex(proto.px[i], proto.pz[i]);
      bucketOf[i] = b;
      counts[b]++;
      const box = this.buckets[b].box;
      const top = proto.py[i] + proto.scale[i] * 2.2;
      const bot = proto.py[i] - 2;
      if (box.min.y === 0 && box.max.y === 0) {
        box.min.y = bot;
        box.max.y = top;
      } else {
        if (bot < box.min.y) box.min.y = bot;
        if (top > box.max.y) box.max.y = top;
      }
    }
    let acc = 0;
    for (let b = 0; b < counts.length; b++) {
      proto.bucketStart[b] = acc;
      acc += counts[b];
    }
    proto.bucketStart[counts.length] = acc;
    const cursor = proto.bucketStart.slice(0, counts.length);
    for (let i = 0; i < count; i++) proto.order[cursor[bucketOf[i]]++] = i;

    // Capacities: the near band is a disc, so estimate from area and keep a
    // healthy margin. Clamped so a pathological density cannot allocate GBs.
    const area = (r: number): number => Math.PI * r * r;
    const dens = count / Math.max(area(radius), 1);
    proto.nearCap = clamp(
      Math.ceil(area(def.nearDistance) * dens * 1.5) + 32,
      32,
      Math.min(count, 30000),
    );
    proto.farCap = clamp(
      Math.ceil(area(def.distance) * dens * 1.2) + 64,
      64,
      Math.min(count, 60000),
    );

    proto.nearMesh = this.makeMesh(def, def.near, proto.nearCap, def.castShadow, `${def.id}:near`);
    proto.farMesh = this.makeMesh(def, def.far, proto.farCap, false, `${def.id}:far`);
    this.object.add(proto.nearMesh, proto.farMesh);

    if (def.collide) this.bakeColliders(proto);
    return proto;
  }

  private makeMesh(
    def: ScatterProtoDef,
    geo: THREE.BufferGeometry,
    cap: number,
    castShadow: boolean,
    name: string,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, def.material, cap);
    mesh.name = name;
    mesh.count = 0;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // we cull per bucket, which is far tighter
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    if (castShadow && def.depthMaterial) mesh.customDepthMaterial = def.depthMaterial;
    return mesh;
  }

  /**
   * Bake the far geometry into world-space collider buckets. Using the low-poly
   * mesh keeps the BVH build to a few thousand triangles per bucket while still
   * blocking movement and bullets at the right silhouette.
   */
  private bakeColliders(proto: Proto): void {
    const src = proto.def.far;
    const srcPos = src.getAttribute('position') as THREE.BufferAttribute;
    const vertsPer = srcPos.count;
    const PER_BUCKET = 64;
    const total = proto.count;
    for (let start = 0; start < total; start += PER_BUCKET) {
      const n = Math.min(PER_BUCKET, total - start);
      const out = new Float32Array(n * vertsPer * 3);
      for (let k = 0; k < n; k++) {
        const i = start + k;
        _pos.set(proto.px[i], proto.py[i], proto.pz[i]);
        _q.set(proto.qx[i], proto.qy[i], proto.qz[i], proto.qw[i]);
        _scl.setScalar(proto.scale[i]);
        _m.compose(_pos, _q, _scl);
        const e = _m.elements;
        const base = k * vertsPer * 3;
        for (let v = 0; v < vertsPer; v++) {
          const x = srcPos.getX(v);
          const y = srcPos.getY(v);
          const z = srcPos.getZ(v);
          out[base + v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
          out[base + v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          out[base + v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, proto.def.material);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.name = `${proto.def.id}:collider${start}`;
      this.colliders.push(mesh);
      this.ownedGeometries.push(geo);
    }
  }

  // -- per-frame ------------------------------------------------------------

  /** Cheap to call every frame; only re-fills buffers when the view changed. */
  update(camera: THREE.Camera): void {
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camDir);
    if (
      !this.dirty &&
      _camPos.distanceToSquared(this.lastCam) < 16 &&
      _camDir.dot(this.lastDir) > 0.992
    ) {
      return;
    }
    this.dirty = false;
    this.lastCam.copy(_camPos);
    this.lastDir.copy(_camDir);

    _viewProj.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    _frustum.setFromProjectionMatrix(_viewProj);

    for (const proto of this.protos) {
      const def = proto.def;
      const nearArr = proto.nearMesh.instanceMatrix.array as Float32Array;
      const farArr = proto.farMesh.instanceMatrix.array as Float32Array;
      const nearCol = proto.nearMesh.instanceColor!.array as Float32Array;
      const farCol = proto.farMesh.instanceColor!.array as Float32Array;
      let nn = 0;
      let nf = 0;
      const maxD2 = def.distance * def.distance;
      const nearD2 = def.nearDistance * def.nearDistance;
      // Bucket radius plus the far cull distance; a bucket whose centre is
      // outside this cannot contain a visible instance.
      const bucketReach = def.distance + this.bucketSize;

      for (let b = 0; b < this.buckets.length; b++) {
        const s = proto.bucketStart[b];
        const e = proto.bucketStart[b + 1];
        if (s === e) continue;
        const bucket = this.buckets[b];
        const dx = bucket.cx - _camPos.x;
        const dz = bucket.cz - _camPos.z;
        if (dx * dx + dz * dz > bucketReach * bucketReach) continue;
        if (!_frustum.intersectsBox(bucket.box)) continue;

        for (let oi = s; oi < e; oi++) {
          const i = proto.order[oi];
          const ddx = proto.px[i] - _camPos.x;
          const ddy = proto.py[i] - _camPos.y;
          const ddz = proto.pz[i] - _camPos.z;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 > maxD2) continue;

          const isNear = d2 <= nearD2;
          if (isNear ? nn >= proto.nearCap : nf >= proto.farCap) continue;

          _pos.set(proto.px[i], proto.py[i], proto.pz[i]);
          _q.set(proto.qx[i], proto.qy[i], proto.qz[i], proto.qw[i]);
          _scl.setScalar(proto.scale[i]);
          _m.compose(_pos, _q, _scl);
          if (isNear) {
            _m.toArray(nearArr, nn * 16);
            nearCol[nn * 3] = proto.tint[i * 3];
            nearCol[nn * 3 + 1] = proto.tint[i * 3 + 1];
            nearCol[nn * 3 + 2] = proto.tint[i * 3 + 2];
            nn++;
          } else {
            _m.toArray(farArr, nf * 16);
            farCol[nf * 3] = proto.tint[i * 3];
            farCol[nf * 3 + 1] = proto.tint[i * 3 + 1];
            farCol[nf * 3 + 2] = proto.tint[i * 3 + 2];
            nf++;
          }
        }
      }

      proto.nearMesh.count = nn;
      proto.farMesh.count = nf;
      proto.drawnNear = nn;
      proto.drawnFar = nf;
      proto.nearMesh.instanceMatrix.needsUpdate = true;
      proto.farMesh.instanceMatrix.needsUpdate = true;
      proto.nearMesh.instanceColor!.needsUpdate = true;
      proto.farMesh.instanceColor!.needsUpdate = true;
    }
  }

  /** Force a refill on the next update (after a teleport, for instance). */
  invalidate(): void {
    this.dirty = true;
    this.lastCam.set(1e9, 1e9, 1e9);
  }

  dispose(): void {
    for (const p of this.protos) {
      p.nearMesh.dispose();
      p.farMesh.dispose();
    }
    this.protos.length = 0;
    for (const g of this.ownedGeometries) g.dispose();
    this.ownedGeometries.length = 0;
    this.colliders.length = 0;
    this.object.clear();
  }
}
