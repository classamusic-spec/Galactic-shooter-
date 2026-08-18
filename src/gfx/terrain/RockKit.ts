/**
 * RockKit — procedural boulders, slabs, spires, arches and scree.
 *
 * The rule that decides whether a rock reads as rock: **rocks have flat faces
 * and sharp edges**. Displacing a sphere with noise gives you a potato. What
 * gives you granite is slicing the blob with a handful of random planes, so the
 * silhouette is made of straight segments meeting at hard corners, and then
 * shading those corners as creases rather than smoothing them away.
 *
 * So the pipeline per prototype is:
 *   welded icosphere → anisotropic squash → layered 3-D noise displacement →
 *   random planar slicing (the fracture faces) → optional fluting/stratification →
 *   crease-aware normals → per-face planar UVs.
 *
 * Everything comes out as a small set of shared `BufferGeometry` prototypes that
 * `ScatterSystem` instances with per-instance rotation, scale and tint.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { applyUvScale } from '@/gfx/materials/ProceduralTexture';
import type { RockKind, TerrainRockSpec } from './HeightField';
import { Rng, clamp } from '@/util/math';
import { createFrameBudget } from '@/util/async';

// ---------------------------------------------------------------------------
// Small 3-D noise (independent of the terrain field — different job, no need to
// agree with anything on the GPU).
// ---------------------------------------------------------------------------

function h3(ix: number, iy: number, iz: number, seed: number): number {
  let x = ((Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f)) ^ seed) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x2c1b3c6d) >>> 0;
  x = (x ^ (x >>> 12)) >>> 0;
  x = Math.imul(x, 0x297a2d39) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x / 4294967296;
}

function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const c000 = h3(ix, iy, iz, seed);
  const c100 = h3(ix + 1, iy, iz, seed);
  const c010 = h3(ix, iy + 1, iz, seed);
  const c110 = h3(ix + 1, iy + 1, iz, seed);
  const c001 = h3(ix, iy, iz + 1, seed);
  const c101 = h3(ix + 1, iy, iz + 1, seed);
  const c011 = h3(ix, iy + 1, iz + 1, seed);
  const c111 = h3(ix + 1, iy + 1, iz + 1, seed);
  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return (y0 + (y1 - y0) * uz) * 2 - 1;
}

function fbm3(x: number, y: number, z: number, oct: number, seed: number, gain = 0.5): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f, y * f, z * f, (seed + i * 977) >>> 0);
    n += a;
    a *= gain;
    f *= 2.03;
  }
  return s / n;
}

/** Ridged 3-D noise. Gives the sharp vertical fluting spires need. */
function ridged3(x: number, y: number, z: number, oct: number, seed: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    const v = 1 - Math.abs(noise3(x * f, y * f, z * f, (seed + i * 613) >>> 0));
    s += a * v * v;
    n += a;
    a *= 0.55;
    f *= 2.11;
  }
  return (s / n) * 2 - 1;
}

// ---------------------------------------------------------------------------
// Mesh utilities (shared with CliffKit and FoliageKit)
// ---------------------------------------------------------------------------

/** Mutable, indexed triangle soup used while a prototype is being shaped. */
export interface MeshData {
  pos: number[];
  index: number[];
}

/**
 * Welded icosphere. `THREE.IcosahedronGeometry` is non-indexed, which means a
 * shared vertex gets displaced independently per face and the mesh tears; this
 * builds an indexed one with a midpoint cache so displacement stays watertight.
 */
export function icosphere(subdivisions: number): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;
  const base: number[] = [
    -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
    0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
    t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
  ];
  const pos: number[] = [];
  for (let i = 0; i < base.length; i += 3) {
    const l = Math.hypot(base[i], base[i + 1], base[i + 2]);
    pos.push(base[i] / l, base[i + 1] / l, base[i + 2] / l);
  }
  let index: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];

  const cache = new Map<number, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const ax = pos[a * 3];
    const ay = pos[a * 3 + 1];
    const az = pos[a * 3 + 2];
    const bx = pos[b * 3];
    const by = pos[b * 3 + 1];
    const bz = pos[b * 3 + 2];
    let mx = (ax + bx) * 0.5;
    let my = (ay + by) * 0.5;
    let mz = (az + bz) * 0.5;
    const l = Math.hypot(mx, my, mz) || 1;
    mx /= l;
    my /= l;
    mz /= l;
    const id = pos.length / 3;
    pos.push(mx, my, mz);
    cache.set(key, id);
    return id;
  };

  for (let s = 0; s < subdivisions; s++) {
    const next: number[] = [];
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i];
      const b = index[i + 1];
      const c = index[i + 2];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    index = next;
    cache.clear();
  }
  return { pos, index };
}

/**
 * Crease-aware normals, emitted as a non-indexed geometry.
 *
 * Smooth normals everywhere would round off the fracture faces we worked to
 * create; per-face normals everywhere gives a low-poly art look. So: average
 * the adjacent face normals per vertex, then per triangle corner keep the
 * average only when it is within `creaseDeg` of the face normal, else use the
 * face normal. Curved parts stay smooth, sliced parts get hard edges.
 *
 * UVs are a per-face planar projection on the face normal's dominant axis. Rock
 * has no directional pattern to break, so the projection seams are invisible.
 */
export function finalizeMesh(
  data: MeshData,
  creaseDeg = 34,
  uvScale = 1,
): THREE.BufferGeometry {
  const { pos, index } = data;
  const vertCount = pos.length / 3;
  const triCount = index.length / 3;
  const acc = new Float32Array(vertCount * 3);
  const faceN = new Float32Array(triCount * 3);

  for (let f = 0; f < triCount; f++) {
    const a = index[f * 3] * 3;
    const b = index[f * 3 + 1] * 3;
    const c = index[f * 3 + 2] * 3;
    const e1x = pos[b] - pos[a];
    const e1y = pos[b + 1] - pos[a + 1];
    const e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a];
    const e2y = pos[c + 1] - pos[a + 1];
    const e2z = pos[c + 2] - pos[a + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    // Unnormalised cross product = area-weighted, which is the right weight for
    // the smooth average. Keep a normalised copy for the crease test.
    acc[a] += nx;
    acc[a + 1] += ny;
    acc[a + 2] += nz;
    acc[b] += nx;
    acc[b + 1] += ny;
    acc[b + 2] += nz;
    acc[c] += nx;
    acc[c + 1] += ny;
    acc[c + 2] += nz;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    faceN[f * 3] = nx;
    faceN[f * 3 + 1] = ny;
    faceN[f * 3 + 2] = nz;
  }

  for (let v = 0; v < vertCount; v++) {
    const l = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]) || 1;
    acc[v * 3] /= l;
    acc[v * 3 + 1] /= l;
    acc[v * 3 + 2] /= l;
  }

  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const outPos = new Float32Array(triCount * 9);
  const outNrm = new Float32Array(triCount * 9);
  const outUv = new Float32Array(triCount * 6);

  for (let f = 0; f < triCount; f++) {
    const fnx = faceN[f * 3];
    const fny = faceN[f * 3 + 1];
    const fnz = faceN[f * 3 + 2];
    const ax = Math.abs(fnx);
    const ay = Math.abs(fny);
    const az = Math.abs(fnz);
    for (let k = 0; k < 3; k++) {
      const vi = index[f * 3 + k];
      const px = pos[vi * 3];
      const py = pos[vi * 3 + 1];
      const pz = pos[vi * 3 + 2];
      const o = f * 9 + k * 3;
      outPos[o] = px;
      outPos[o + 1] = py;
      outPos[o + 2] = pz;
      const sx = acc[vi * 3];
      const sy = acc[vi * 3 + 1];
      const sz = acc[vi * 3 + 2];
      if (sx * fnx + sy * fny + sz * fnz >= cosCrease) {
        outNrm[o] = sx;
        outNrm[o + 1] = sy;
        outNrm[o + 2] = sz;
      } else {
        outNrm[o] = fnx;
        outNrm[o + 1] = fny;
        outNrm[o + 2] = fnz;
      }
      const uo = f * 6 + k * 2;
      if (ay >= ax && ay >= az) {
        outUv[uo] = px * uvScale;
        outUv[uo + 1] = pz * uvScale;
      } else if (ax >= az) {
        outUv[uo] = pz * uvScale;
        outUv[uo + 1] = py * uvScale;
      } else {
        outUv[uo] = px * uvScale;
        outUv[uo + 1] = py * uvScale;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Concatenate geometries that share an attribute layout. No BVH, no groups. */
export function mergeGeometries(
  geometries: readonly THREE.BufferGeometry[],
  attributes: readonly string[] = ['position', 'normal', 'uv'],
): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of attributes) {
    const first = geometries[0].getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!first) continue;
    const itemSize = first.itemSize;
    let total = 0;
    for (const g of geometries) total += (g.getAttribute(name) as THREE.BufferAttribute).count;
    const arr = new Float32Array(total * itemSize);
    let off = 0;
    for (const g of geometries) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      arr.set(a.array as Float32Array, off);
      off += a.count * itemSize;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/** Bake a matrix into a geometry's position/normal attributes. */
export function applyMatrix(geo: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  geo.applyMatrix4(m);
  return geo;
}

// ---------------------------------------------------------------------------
// Shaping operators
// ---------------------------------------------------------------------------

/**
 * Slice the mesh with a random plane: everything past the plane is projected
 * onto it. Repeat and you get the flat conchoidal faces of broken stone.
 */
function slice(data: MeshData, nx: number, ny: number, nz: number, d: number): void {
  const p = data.pos;
  for (let i = 0; i < p.length; i += 3) {
    const dist = p[i] * nx + p[i + 1] * ny + p[i + 2] * nz - d;
    if (dist > 0) {
      p[i] -= nx * dist;
      p[i + 1] -= ny * dist;
      p[i + 2] -= nz * dist;
    }
  }
}

interface RockShape {
  /** Ellipsoid squash. */
  scale: THREE.Vector3;
  /** Broad lumpiness. */
  lump: number;
  lumpFreq: number;
  /** Fine grain. */
  grain: number;
  /** Vertical fluting/stratification strength. */
  flute: number;
  fluteFreq: number;
  /** Number of fracture planes. */
  slices: number;
  /** How close the planes cut to the centre (0.5 = aggressive). */
  sliceDepth: number;
  creaseDeg: number;
  /** Push the base flat so it beds into the ground. */
  flatBottom: number;
}

function shapeRock(subdiv: number, s: RockShape, rng: Rng, seed: number): MeshData {
  const data = icosphere(subdiv);
  const p = data.pos;

  for (let i = 0; i < p.length; i += 3) {
    let x = p[i];
    let y = p[i + 1];
    let z = p[i + 2];

    // Layered displacement in the *undeformed* sphere domain so the noise does
    // not stretch with the squash.
    const lump = fbm3(x * s.lumpFreq, y * s.lumpFreq, z * s.lumpFreq, 3, seed);
    const grain = fbm3(x * 7.3, y * 7.3, z * 7.3, 3, (seed + 4001) >>> 0);
    // Fluting runs vertically: sample a cylinder domain so the ridges are
    // columns, not blobs.
    const ang = Math.atan2(z, x);
    const flute = ridged3(
      Math.cos(ang) * s.fluteFreq,
      y * s.fluteFreq * 0.28,
      Math.sin(ang) * s.fluteFreq,
      3,
      (seed + 8009) >>> 0,
    );
    const r = 1 + lump * s.lump + grain * s.grain + flute * s.flute;

    x *= r * s.scale.x;
    y *= r * s.scale.y;
    z *= r * s.scale.z;
    p[i] = x;
    p[i + 1] = y;
    p[i + 2] = z;
  }

  for (let k = 0; k < s.slices; k++) {
    // Bias the plane normals toward horizontal so faces read as bedding planes
    // and the silhouette gets vertical straight edges.
    const az = rng.range(0, Math.PI * 2);
    const el = rng.gaussian() * 0.42;
    const nx = Math.cos(az) * Math.cos(el);
    const ny = Math.sin(el);
    const nz = Math.sin(az) * Math.cos(el);
    const reach = Math.abs(nx) * s.scale.x + Math.abs(ny) * s.scale.y + Math.abs(nz) * s.scale.z;
    slice(data, nx, ny, nz, reach * rng.range(s.sliceDepth, 0.94));
  }

  if (s.flatBottom > 0) slice(data, 0, -1, 0, s.scale.y * s.flatBottom);

  // Sit the rock on y=0 so scatter can place it by ground height directly.
  let minY = Infinity;
  for (let i = 1; i < p.length; i += 3) if (p[i] < minY) minY = p[i];
  for (let i = 1; i < p.length; i += 3) p[i] -= minY;
  return data;
}

/**
 * A natural arch: a noisy tube swept along a semicircle, sliced flat so the
 * span reads as stacked strata rather than a bent sausage.
 */
function shapeArch(rng: Rng, seed: number): MeshData {
  const SEG = 26;
  const RING = 10;
  const pos: number[] = [];
  const index: number[] = [];
  const spanR = rng.range(0.85, 1.15);
  const spanH = rng.range(0.9, 1.35);
  const thick = rng.range(0.17, 0.26);
  const lean = rng.range(-0.18, 0.18);

  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const a = Math.PI * t;
    // Path: legs plant at y=0, apex at spanH. Slight asymmetry so it is not a
    // perfect arc.
    const cx = -Math.cos(a) * spanR * (1 + lean * Math.sin(a));
    const cy = Math.sin(a) * spanH;
    const cz = Math.sin(a * 2) * 0.12 * spanR;
    // Tangent (finite difference is plenty for a frame).
    const a2 = a + 0.01;
    const tx = -Math.cos(a2) * spanR * (1 + lean * Math.sin(a2)) - cx;
    const ty = Math.sin(a2) * spanH - cy;
    const tz = Math.sin(a2 * 2) * 0.12 * spanR - cz;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const ux = tx / tl;
    const uy = ty / tl;
    const uz = tz / tl;
    // Frame: bitangent from world up.
    let bx = uy * 0 - uz * 1;
    let by = uz * 0 - ux * 0;
    let bz = ux * 1 - uy * 0;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl;
    by /= bl;
    bz /= bl;
    const nx2 = uy * bz - uz * by;
    const ny2 = uz * bx - ux * bz;
    const nz2 = ux * by - uy * bx;

    // The leg feet flare out; the apex thins.
    const taper = thick * (1 + (1 - Math.sin(a)) * 0.75);
    for (let j = 0; j < RING; j++) {
      const ra = (j / RING) * Math.PI * 2;
      const cr = Math.cos(ra);
      const sr = Math.sin(ra);
      // Square-ish cross-section: rock spans are slabs, not tubes.
      const boxy = 0.62;
      const rx = Math.sign(cr) * Math.pow(Math.abs(cr), boxy);
      const ry = Math.sign(sr) * Math.pow(Math.abs(sr), boxy);
      const wob =
        1 +
        fbm3(cr * 3.1 + t * 5.7, sr * 3.1, t * 4.3, 3, seed) * 0.3 +
        ridged3(cr * 6, t * 9, sr * 6, 2, (seed + 71) >>> 0) * 0.14;
      const w = taper * wob;
      pos.push(
        cx + bx * rx * w + nx2 * ry * w * 1.35,
        cy + by * rx * w + ny2 * ry * w * 1.35,
        cz + bz * rx * w + nz2 * ry * w * 1.35,
      );
    }
  }
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < RING; j++) {
      const j2 = (j + 1) % RING;
      const a = i * RING + j;
      const b = i * RING + j2;
      const c = (i + 1) * RING + j;
      const d = (i + 1) * RING + j2;
      index.push(a, c, b, b, c, d);
    }
  }
  const data: MeshData = { pos, index };
  // Strata cuts: horizontal planes shear the whole arch into layers.
  for (let k = 0; k < 3; k++) {
    const az = rng.range(0, Math.PI * 2);
    slice(data, Math.cos(az) * 0.35, rng.range(0.7, 1), Math.sin(az) * 0.35, rng.range(1.45, 2.3));
  }
  let minY = Infinity;
  for (let i = 1; i < pos.length; i += 3) if (pos[i] < minY) minY = pos[i];
  for (let i = 1; i < pos.length; i += 3) pos[i] -= minY;
  return data;
}

// ---------------------------------------------------------------------------
// RockKit
// ---------------------------------------------------------------------------

export interface RockPrototype {
  kind: RockKind;
  geometry: THREE.BufferGeometry;
  /** Low-poly stand-in used past the near LOD band. */
  far: THREE.BufferGeometry;
  /** Bounding radius in prototype units (before instance scaling). */
  radius: number;
  /** Height in prototype units, for collider sizing. */
  height: number;
}

export class RockKit {
  readonly material: THREE.MeshStandardMaterial;
  private spec: TerrainRockSpec;
  private protos = new Map<RockKind, RockPrototype[]>();
  private owned: THREE.BufferGeometry[] = [];
  private ownedMaterials: THREE.Material[] = [];

  constructor(materials: MaterialLibrary, spec: TerrainRockSpec) {
    this.spec = spec;
    const set = materials.pbr(spec.surface);
    // Own material rather than `materials.get()`: rocks need instance-colour
    // tinting and their own UV scale, and mutating a shared cached material
    // would change every other user of that surface.
    const mat = new THREE.MeshStandardMaterial({
      map: set.albedo,
      normalMap: set.normal,
      roughnessMap: set.orm,
      metalnessMap: set.orm,
      aoMap: set.orm,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 1,
    });
    mat.normalScale.setScalar(0.8);
    mat.aoMapIntensity = 1;
    mat.envMap = materials.environment;
    applyUvScale(mat, 1 / spec.tileMetres);
    this.material = mat;
    this.ownedMaterials.push(mat);
  }

  /**
   * Generate every prototype the spec asks for. Deterministic from the seed.
   *
   * One prototype is a multi-subdivision displaced mesh plus a crease-split
   * finalize pass, i.e. tens of milliseconds each, and a spec can ask for a few
   * dozen. Run synchronously that is a single block long enough to stall the
   * loading screen, so the loop yields on a time budget between prototypes.
   * Yield points do not touch the RNG, so the output stays bit-identical.
   */
  async build(seed: number): Promise<void> {
    const budget = createFrameBudget(8);
    for (const entry of this.spec.entries) {
      const list: RockPrototype[] = [];
      for (let v = 0; v < entry.variants; v++) {
        await budget();
        const s = (seed + entry.kind.length * 7919 + v * 104729) >>> 0;
        const rng = new Rng(s);
        list.push(this.makePrototype(entry.kind, rng, s));
      }
      this.protos.set(entry.kind, list);
    }
  }

  prototypes(kind: RockKind): RockPrototype[] {
    return this.protos.get(kind) ?? [];
  }

  private makePrototype(kind: RockKind, rng: Rng, seed: number): RockPrototype {
    const uv = 1; // UVs are in prototype metres; the material carries the tiling.
    let hi: THREE.BufferGeometry;
    let lo: THREE.BufferGeometry;

    switch (kind) {
      case 'boulder': {
        const shape: RockShape = {
          scale: new THREE.Vector3(rng.range(0.85, 1.3), rng.range(0.6, 0.95), rng.range(0.85, 1.3)),
          lump: 0.3,
          lumpFreq: rng.range(1.5, 2.4),
          grain: 0.045,
          flute: 0.05,
          fluteFreq: 3.5,
          slices: rng.int(5, 8),
          sliceDepth: 0.52,
          creaseDeg: 30,
          flatBottom: 0.62,
        };
        hi = finalizeMesh(shapeRock(3, shape, rng, seed), shape.creaseDeg, uv);
        lo = finalizeMesh(shapeRock(1, shape, new Rng(seed), seed), 44, uv);
        break;
      }
      case 'slab': {
        // A tilted tabular block: the reliable "cover" prop and a strong
        // horizontal in the composition.
        const shape: RockShape = {
          scale: new THREE.Vector3(rng.range(1.3, 2.1), rng.range(0.28, 0.5), rng.range(0.9, 1.5)),
          lump: 0.17,
          lumpFreq: rng.range(1.8, 2.8),
          grain: 0.05,
          flute: 0.09,
          fluteFreq: 5,
          slices: rng.int(6, 9),
          sliceDepth: 0.58,
          creaseDeg: 24,
          flatBottom: 0.5,
        };
        const d = shapeRock(3, shape, rng, seed);
        hi = finalizeMesh(d, shape.creaseDeg, uv);
        lo = finalizeMesh(shapeRock(1, shape, new Rng(seed), seed), 40, uv);
        break;
      }
      case 'spire': {
        const shape: RockShape = {
          scale: new THREE.Vector3(rng.range(0.6, 0.9), rng.range(1.5, 2.4), rng.range(0.6, 0.9)),
          lump: 0.2,
          lumpFreq: rng.range(1.2, 2.0),
          grain: 0.035,
          flute: 0.19,
          fluteFreq: 7.5,
          slices: rng.int(7, 11),
          sliceDepth: 0.6,
          creaseDeg: 26,
          flatBottom: 0.86,
        };
        // Taper the top after shaping so the silhouette comes to a point.
        const d = shapeRock(3, shape, rng, seed);
        const p = d.pos;
        let maxY = 0;
        for (let i = 1; i < p.length; i += 3) if (p[i] > maxY) maxY = p[i];
        for (let i = 0; i < p.length; i += 3) {
          const t = clamp(p[i + 1] / maxY, 0, 1);
          const k = 1 - Math.pow(t, 1.5) * 0.62;
          p[i] *= k;
          p[i + 2] *= k;
        }
        hi = finalizeMesh(d, shape.creaseDeg, uv);
        lo = finalizeMesh(shapeRock(1, shape, new Rng(seed), seed), 40, uv);
        break;
      }
      case 'arch': {
        hi = finalizeMesh(shapeArch(rng, seed), 28, uv);
        lo = finalizeMesh(shapeArch(new Rng(seed), seed), 44, uv);
        break;
      }
      default: {
        // Scree: a cluster of angular chips baked into one geometry, so a whole
        // patch of debris costs a single instance.
        const parts: THREE.BufferGeometry[] = [];
        const count = rng.int(5, 9);
        for (let i = 0; i < count; i++) {
          const shape: RockShape = {
            scale: new THREE.Vector3(rng.range(0.2, 0.5), rng.range(0.1, 0.24), rng.range(0.2, 0.5)),
            lump: 0.22,
            lumpFreq: 3.2,
            grain: 0.06,
            flute: 0,
            fluteFreq: 1,
            slices: rng.int(4, 6),
            sliceDepth: 0.5,
            creaseDeg: 18,
            flatBottom: 0.4,
          };
          const g = finalizeMesh(shapeRock(1, shape, rng, (seed + i * 313) >>> 0), 18, uv);
          const m = new THREE.Matrix4()
            .makeRotationY(rng.range(0, Math.PI * 2))
            .setPosition(rng.range(-0.85, 0.85), 0, rng.range(-0.85, 0.85));
          g.applyMatrix4(m);
          parts.push(g);
        }
        hi = mergeGeometries(parts);
        for (const p of parts) p.dispose();
        lo = hi;
        break;
      }
    }

    hi.computeBoundingSphere();
    const bs = hi.boundingSphere!;
    const bb = hi.boundingBox!;
    this.owned.push(hi);
    if (lo !== hi) this.owned.push(lo);
    return { kind, geometry: hi, far: lo, radius: bs.radius, height: bb.max.y - bb.min.y };
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.protos.clear();
  }
}
