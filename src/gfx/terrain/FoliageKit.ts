/**
 * FoliageKit — procedural flora prototypes and the wind that moves them.
 *
 * Three things separate believable foliage from green confetti:
 *
 * 1. **Silhouette from alpha, volume from normals.** Cards are alpha-tested
 *    against a procedurally drawn atlas (blades, fern pinnae, ovate leaves,
 *    reeds, bark), and their vertex normals are bowed away from the card plane
 *    toward the growth direction. Flat plane normals are why cheap grass reads as
 *    cardboard: every blade in a clump lights identically.
 * 2. **Value gradient along the plant.** Vertex colour runs dark at the base to
 *    light at the tip, so a clump has internal occlusion before a single light
 *    hits it. Per-instance tint on top of that gives a field its variation.
 * 3. **Coherent wind.** Not per-instance sine noise — a gust *field* that travels
 *    across the world, so a wave visibly rolls across a meadow. Stiffness scales
 *    with the square of the normalised height, so the base stays planted.
 *
 * Trees come from a bracketed stochastic L-system (three rewrites) run through a
 * turtle that emits tapered prisms for wood and leaf rosettes at the apices,
 * which is why no two are the same shape. Wood and canopy share one geometry and
 * one material — the bark tile in the atlas is fully opaque, so the alpha test
 * that cuts the leaves never touches the trunk.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import type { SurfaceMaterialName } from '@/gfx/materials/SurfaceMaterials';
import { settings } from '@/core/Settings';
import { Rng, clamp } from '@/util/math';
import type { FloraKind, TerrainFloraEntry, TerrainFloraSpec } from './HeightField';

// ---------------------------------------------------------------------------
// Atlas layout: 3 columns × 2 rows
// ---------------------------------------------------------------------------

/** `[u0, v0, u1, v1]` in atlas space. */
export type UvRect = readonly [number, number, number, number];

const COLS = 3;
const ROWS = 2;

/** Tile rect with a half-percent inset so mip levels cannot bleed between tiles. */
function tileRect(col: number, row: number): UvRect {
  const iu = 0.004;
  const iv = 0.006;
  const u0 = col / COLS + iu;
  const u1 = (col + 1) / COLS - iu;
  // Canvas row 0 is the top of the image; texture v runs bottom-up.
  const v1 = 1 - row / ROWS - iv;
  const v0 = 1 - (row + 1) / ROWS + iv;
  return [u0, v0, u1, v1];
}

const TILE_GRASS = tileRect(0, 0);
const TILE_FERN = tileRect(1, 0);
const TILE_REED = tileRect(2, 0);
const TILE_LEAF = tileRect(0, 1);
const TILE_BARK = tileRect(1, 1);
const TILE_POD = tileRect(2, 1);

// ---------------------------------------------------------------------------
// Geometry accumulator
// ---------------------------------------------------------------------------

interface Builder {
  pos: number[];
  nrm: number[];
  uv: number[];
  col: number[];
  /** 0 at the base, 1 at the tip — drives the wind falloff. */
  bend: number[];
  idx: number[];
}

function newBuilder(): Builder {
  return { pos: [], nrm: [], uv: [], col: [], bend: [], idx: [] };
}

function finish(b: Builder): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.setAttribute('aBend', new THREE.Float32BufferAttribute(b.bend, 1));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _cA = new THREE.Color();
const _cB = new THREE.Color();
/** Dedicated scratch for colour interpolation, so callers can pass `_cA` safely. */
const _cS = new THREE.Color();

/**
 * A segmented, tapering, forward-curving card. `yaw` spins it about Y so three
 * crossed cards fill volume; `lean` tips the whole card over so a tuft splays
 * outward instead of standing to attention.
 */
function addCard(
  b: Builder,
  o: {
    width: number;
    height: number;
    segments: number;
    yaw: number;
    lean: number;
    curve: number;
    taper: number;
    uv: UvRect;
    x: number;
    z: number;
    baseCol: THREE.Color;
    tipCol: THREE.Color;
    /** How far the vertex normals bow away from the card plane, 0..1. */
    bow: number;
  },
): void {
  const base = b.pos.length / 3;
  const rx = Math.cos(o.yaw);
  const rz = Math.sin(o.yaw);
  const fx = -rz;
  const fz = rx;
  const [u0, v0, u1, v1] = o.uv;

  for (let s = 0; s <= o.segments; s++) {
    const t = s / o.segments;
    const w = o.width * 0.5 * (1 - Math.pow(t, o.taper) * 0.94);
    const drift = o.curve * t * t + o.lean * t;
    const y = o.height * t * (1 - 0.12 * t * t);
    for (let k = 0; k < 2; k++) {
      const sgn = k === 0 ? -1 : 1;
      b.pos.push(o.x + rx * w * sgn + fx * drift, y, o.z + rz * w * sgn + fz * drift);
      _v.set(fx, 0, fz);
      _v2.set(rx * sgn, 0.55, rz * sgn).normalize();
      _v.lerp(_v2, o.bow).normalize();
      b.nrm.push(_v.x, _v.y, _v.z);
      b.uv.push(k === 0 ? u0 : u1, v0 + (v1 - v0) * t);
      _cS.copy(o.baseCol).lerp(o.tipCol, Math.pow(t, 0.72));
      b.col.push(_cS.r, _cS.g, _cS.b);
      b.bend.push(t);
    }
  }
  for (let s = 0; s < o.segments; s++) {
    const a = base + s * 2;
    b.idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
}

/**
 * A tapered prism between two oriented rings. Wood, stalks, crystal shafts.
 *
 * When `rect` is given the ring UVs are mapped into that atlas tile, with the V
 * fraction alternating 0/1 per segment so consecutive segments mirror the tile
 * instead of needing a wrapped sampler.
 */
function addTube(
  b: Builder,
  from: THREE.Vector3,
  to: THREE.Vector3,
  qFrom: THREE.Quaternion,
  qTo: THREE.Quaternion,
  r0: number,
  r1: number,
  sides: number,
  colA: THREE.Color,
  colB: THREE.Color,
  bendA: number,
  bendB: number,
  rect: UvRect | null,
  segIndex: number,
): void {
  const base = b.pos.length / 3;
  for (let e = 0; e < 2; e++) {
    const p = e === 0 ? from : to;
    const q = e === 0 ? qFrom : qTo;
    const r = e === 0 ? r0 : r1;
    const c = e === 0 ? colA : colB;
    const bend = e === 0 ? bendA : bendB;
    const vf = (segIndex + e) % 2;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      _v.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(q);
      b.pos.push(p.x + _v.x, p.y + _v.y, p.z + _v.z);
      _v2.copy(_v);
      if (_v2.lengthSq() < 1e-10) _v2.set(0, 1, 0);
      _v2.normalize();
      b.nrm.push(_v2.x, _v2.y, _v2.z);
      if (rect) {
        b.uv.push(rect[0] + (rect[2] - rect[0]) * (i / sides), rect[1] + (rect[3] - rect[1]) * vf);
      } else {
        b.uv.push(i / sides, segIndex + e);
      }
      b.col.push(c.r, c.g, c.b);
      b.bend.push(bend);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < sides; i++) {
    const a = base + i;
    const c = base + ring + i;
    b.idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
}

/** Surface of revolution from a (radius, height) profile. Fungal caps, pods. */
function addLathe(
  b: Builder,
  profile: readonly (readonly [number, number])[],
  segments: number,
  height: number,
  radius: number,
  colA: THREE.Color,
  colB: THREE.Color,
): void {
  const base = b.pos.length / 3;
  const rows = profile.length;
  for (let r = 0; r < rows; r++) {
    const [pr, ph] = profile[r];
    const prev = profile[Math.max(r - 1, 0)];
    const next = profile[Math.min(r + 1, rows - 1)];
    const dr = (next[0] - prev[0]) * radius;
    const dh = (next[1] - prev[1]) * height;
    const nl = Math.hypot(dr, dh) || 1;
    const nRad = dh / nl;
    const nY = -dr / nl;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      b.pos.push(Math.cos(a) * pr * radius, ph * height, Math.sin(a) * pr * radius);
      _v.set(Math.cos(a) * nRad, nY, Math.sin(a) * nRad);
      if (_v.lengthSq() < 1e-10) _v.set(0, 1, 0);
      _v.normalize();
      b.nrm.push(_v.x, _v.y, _v.z);
      b.uv.push((i / segments) * 2, ph * 2);
      _cS.copy(colA).lerp(colB, ph);
      b.col.push(_cS.r, _cS.g, _cS.b);
      b.bend.push(ph * 0.85);
    }
  }
  const ring = segments + 1;
  for (let r = 0; r < rows - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const a = base + r * ring + i;
      const c = base + (r + 1) * ring + i;
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Leaf atlas — drawn, not downloaded
// ---------------------------------------------------------------------------

/**
 * Six shapes in a 3×2 atlas, drawn in near-neutral luminance so the per-planet
 * tint (vertex colour × instance colour) decides the hue.
 *
 * A second canvas derives a normal map from the drawn luminance with a Sobel
 * filter, so veins, leaf curl and bark ridges actually catch light. Without it
 * every card shades as a flat plane and the whole meadow reads as paper.
 */
function buildLeafAtlas(size: number): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  const TW = size / COLS;
  const TH = size / ROWS;
  const pad = Math.max(3, size / 150);

  const grey = (v: number, a = 1): string => {
    const n = clamp(v, 0, 255) | 0;
    return `rgba(${n},${(n * 1.03) | 0},${(n * 0.86) | 0},${a})`;
  };

  const blade = (x0: number, y0: number, len: number, wid: number, bendX: number, shade: number): void => {
    const tipX = x0 + bendX;
    const tipY = y0 - len;
    const midX = x0 + bendX * 0.35;
    const midY = y0 - len * 0.55;
    const grad = g.createLinearGradient(x0, y0, tipX, tipY);
    grad.addColorStop(0, grey(84 * shade));
    grad.addColorStop(0.55, grey(163 * shade));
    grad.addColorStop(1, grey(232 * shade));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x0 - wid, y0);
    g.quadraticCurveTo(midX - wid * 0.55, midY, tipX, tipY);
    g.quadraticCurveTo(midX + wid * 0.55, midY, x0 + wid, y0);
    g.closePath();
    g.fill();
    g.strokeStyle = grey(244 * shade, 0.5);
    g.lineWidth = Math.max(1, wid * 0.16);
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(midX, midY, tipX, tipY);
    g.stroke();
  };

  const ovate = (cx: number, cy: number, len: number, wid: number, rot: number, shade: number): void => {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot);
    const grad = g.createLinearGradient(0, 0, 0, -len);
    grad.addColorStop(0, grey(78 * shade));
    grad.addColorStop(1, grey(222 * shade));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(-wid, -len * 0.3, -wid * 0.8, -len * 0.85, 0, -len);
    g.bezierCurveTo(wid * 0.8, -len * 0.85, wid, -len * 0.3, 0, 0);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(58,62,48,0.6)';
    g.lineWidth = Math.max(1, wid * 0.1);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -len);
    g.stroke();
    for (let i = 1; i < 7; i++) {
      const t = i / 7;
      g.beginPath();
      g.moveTo(0, -len * t);
      g.lineTo(wid * 0.6 * (1 - t * 0.6), -len * (t + 0.11));
      g.moveTo(0, -len * t);
      g.lineTo(-wid * 0.6 * (1 - t * 0.6), -len * (t + 0.11));
      g.stroke();
    }
    g.restore();
  };

  // -- (0,0) grass tuft ------------------------------------------------------
  g.save();
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    blade(
      TW * (0.14 + t * 0.72),
      TH - pad,
      TH * (0.52 + Math.sin(i * 2.1) * 0.3),
      TW * 0.036,
      (t - 0.5) * TW * 0.38,
      0.8 + (i % 3) * 0.09,
    );
  }
  g.restore();

  // -- (1,0) fern frond ------------------------------------------------------
  g.save();
  g.translate(TW, 0);
  g.strokeStyle = grey(150);
  g.lineWidth = Math.max(1.5, TW * 0.018);
  g.beginPath();
  g.moveTo(TW * 0.5, TH - pad);
  g.quadraticCurveTo(TW * 0.56, TH * 0.4, TW * 0.52, pad);
  g.stroke();
  for (let i = 0; i < 13; i++) {
    const t = i / 12;
    const y = TH - pad - (TH - pad * 2) * t;
    const l = TH * 0.3 * (1 - t * 0.8) * (0.6 + 0.5 * Math.sin(t * 3.1));
    const droop = -0.55 - t * 0.45;
    ovate(TW * (0.5 + 0.02 * t), y, l, l * 0.3, Math.PI / 2 + droop, 0.86);
    ovate(TW * (0.5 + 0.02 * t), y, l, l * 0.3, -Math.PI / 2 - droop, 0.92);
  }
  g.restore();

  // -- (2,0) reeds -----------------------------------------------------------
  g.save();
  g.translate(TW * 2, 0);
  for (let i = 0; i < 13; i++) {
    const t = i / 12;
    blade(
      TW * (0.1 + t * 0.8),
      TH - pad,
      TH * (0.68 + Math.cos(i * 1.7) * 0.26),
      TW * 0.019,
      (t - 0.5) * TW * 0.5,
      0.76 + (i % 4) * 0.07,
    );
  }
  g.restore();

  // -- (0,1) broad leaf cluster ---------------------------------------------
  g.save();
  g.translate(0, TH);
  for (let i = 0; i < 5; i++) {
    const a = (i / 4 - 0.5) * 1.7;
    ovate(TW * 0.5, TH - pad, TH * (0.66 - Math.abs(a) * 0.16), TW * 0.22, a, 0.86 + (i % 2) * 0.1);
  }
  g.restore();

  // -- (1,1) bark (fully opaque: shares the alpha-tested material with leaves)
  g.save();
  g.translate(TW, TH);
  g.fillStyle = grey(96);
  g.fillRect(0, 0, TW, TH);
  for (let i = 0; i < 34; i++) {
    const x = (i / 34) * TW + Math.sin(i * 3.3) * TW * 0.01;
    const w = TW * (0.006 + (i % 5) * 0.004);
    g.fillStyle = grey(60 + (i % 7) * 16, 0.85);
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + TW * 0.02, TH * 0.35, x - TW * 0.02, TH * 0.7, x + TW * 0.005, TH);
    g.lineTo(x + w, TH);
    g.bezierCurveTo(x - TW * 0.015, TH * 0.7, x + TW * 0.025, TH * 0.35, x + w, 0);
    g.closePath();
    g.fill();
  }
  for (let i = 0; i < 90; i++) {
    const x = ((i * 37) % 100) / 100 * TW;
    const y = ((i * 61) % 100) / 100 * TH;
    g.fillStyle = grey(130 + (i % 5) * 22, 0.35);
    g.fillRect(x, y, TW * 0.012, TH * 0.03);
  }
  g.restore();

  // -- (2,1) seed pod / lichen frill ---------------------------------------
  g.save();
  g.translate(TW * 2, TH);
  for (let i = 0; i < 6; i++) {
    const a = (i / 5 - 0.5) * 2.2;
    const l = TH * (0.4 - Math.abs(a) * 0.06);
    g.save();
    g.translate(TW * 0.5, TH - pad);
    g.rotate(a);
    const grad = g.createLinearGradient(0, 0, 0, -l);
    grad.addColorStop(0, grey(70));
    grad.addColorStop(1, grey(206));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(0, -l * 0.6, TW * 0.06, l * 0.6, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  g.restore();

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.anisotropy = 4;
  map.needsUpdate = true;

  // -- normal map from the luminance we just drew ---------------------------
  const src = g.getImageData(0, 0, size, size);
  const nc = document.createElement('canvas');
  nc.width = size;
  nc.height = size;
  const ng = nc.getContext('2d')!;
  const dst = ng.createImageData(size, size);
  const lum = (x: number, y: number): number => {
    const xi = clamp(x, 0, size - 1) | 0;
    const yi = clamp(y, 0, size - 1) | 0;
    const o = (yi * size + xi) * 4;
    const a = src.data[o + 3] / 255;
    return ((src.data[o] * 0.3 + src.data[o + 1] * 0.6 + src.data[o + 2] * 0.1) / 255) * a;
  };
  const strength = size / 110;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        lum(x - 1, y - 1) + 2 * lum(x - 1, y) + lum(x - 1, y + 1) -
        (lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1));
      const dy =
        lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1) -
        (lum(x - 1, y - 1) + 2 * lum(x, y - 1) + lum(x + 1, y - 1));
      let nx = dx * strength;
      let ny = dy * strength;
      const l = Math.hypot(nx, ny, 1) || 1;
      nx /= l;
      ny /= l;
      const o = (y * size + x) * 4;
      dst.data[o] = ((nx * 0.5 + 0.5) * 255) | 0;
      dst.data[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      dst.data[o + 2] = ((1 / l) * 0.5 * 255 + 127.5) | 0;
      dst.data[o + 3] = 255;
    }
  }
  ng.putImageData(dst, 0, 0);
  const normal = new THREE.CanvasTexture(nc);
  normal.colorSpace = THREE.NoColorSpace;
  normal.wrapS = THREE.ClampToEdgeWrapping;
  normal.wrapT = THREE.ClampToEdgeWrapping;
  normal.generateMipmaps = true;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.needsUpdate = true;

  return { map, normal };
}

// ---------------------------------------------------------------------------
// L-system
// ---------------------------------------------------------------------------

/**
 * Bracketed stochastic L-system. `A` is the apex; each rule splits it into a
 * segment plus two or three sub-apices with rolls between them, so the tree is
 * never bilaterally symmetric.
 *
 *   F  draw forward       [ ] push/pop      + -  pitch about local Z
 *   &  ^ pitch about X    / \  roll about Y  !   thin the branch
 *   A  apex (leaf rosette on the final pass)
 */
function lsystem(iterations: number, rng: Rng): string {
  const rules: readonly string[] = [
    'F[&+A]/[&-A]//A',
    'F[&&+A]//[&-A]/A',
    'FF[&+A]///[&&-A]A',
    'F[&+A]//[&&-A]/[&^A]A',
  ];
  let s = 'A';
  for (let i = 0; i < iterations; i++) {
    let out = '';
    for (const ch of s) out += ch === 'A' ? '!' + rng.pick(rules) : ch;
    s = out;
  }
  return s;
}

function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// FoliageKit
// ---------------------------------------------------------------------------

export interface FoliagePrototype {
  kind: FloraKind;
  near: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  /** Matching depth material, so shadow casters displace identically. */
  depthMaterial: THREE.Material;
  /** Height in prototype units, used for placement sinking. */
  height: number;
}

export class FoliageKit {
  /** Shared wind uniforms. One object drives every foliage material. */
  readonly wind: Record<string, THREE.IUniform> = {
    uWindTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindAmp: { value: 0.16 },
    uGustScale: { value: 34 },
    uGustSpeed: { value: 6 },
  };

  private lib: MaterialLibrary;
  private spec: TerrainFloraSpec;
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private protos = new Map<FloraKind, FoliagePrototype[]>();
  private atlas: { map: THREE.CanvasTexture; normal: THREE.CanvasTexture };
  private owned: THREE.BufferGeometry[] = [];
  private ownedMaterials: THREE.Material[] = [];

  constructor(lib: MaterialLibrary, spec: TerrainFloraSpec) {
    this.lib = lib;
    this.spec = spec;
    (this.wind.uWindDir.value as THREE.Vector2).set(
      Math.cos(spec.windDirection),
      Math.sin(spec.windDirection),
    );
    this.wind.uWindAmp.value = spec.windStrength;
    this.wind.uGustScale.value = spec.gustScale;
    this.wind.uGustSpeed.value = spec.gustSpeed;
    this.atlas = buildLeafAtlas(clamp(settings.profile.textureSize, 256, 1024));
  }

  /** Advance the gust field. Called from the render hook, not the sim step. */
  update(elapsed: number): void {
    this.wind.uWindTime.value = elapsed;
  }

  build(seed: number): void {
    for (const entry of this.spec.entries) {
      const list: FoliagePrototype[] = [];
      for (let v = 0; v < entry.variants; v++) {
        const s = (seed ^ hashName(entry.kind)) + v * 6151;
        list.push(this.makePrototype(entry, new Rng(s >>> 0), s >>> 0));
      }
      this.protos.set(entry.kind, list);
    }
  }

  prototypes(kind: FloraKind): FoliagePrototype[] {
    return this.protos.get(kind) ?? [];
  }

  // -- materials ------------------------------------------------------------

  private cardMaterial(entry: TerrainFloraEntry): THREE.MeshStandardMaterial {
    const key = `card:${entry.emissive}:${entry.emissiveIntensity}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const m = new THREE.MeshStandardMaterial({
      map: this.atlas.map,
      normalMap: this.atlas.normal,
      roughness: 0.76,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: 0.4,
      vertexColors: true,
    });
    m.normalScale.setScalar(0.8);
    m.envMap = this.lib.environment;
    m.envMapIntensity = 0.55;
    if (entry.emissive) {
      m.emissive = new THREE.Color(entry.emissive);
      m.emissiveIntensity = entry.emissiveIntensity;
    }
    this.patchWind(m, 'card', 0);
    this.cache.set(key, m);
    this.ownedMaterials.push(m);
    return m;
  }

  private solidMaterial(
    surface: SurfaceMaterialName,
    entry: TerrainFloraEntry,
    tileMetres: number,
  ): THREE.MeshStandardMaterial {
    const key = `solid:${surface}:${tileMetres}:${entry.emissive}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const set = this.lib.pbr(surface);
    const m = new THREE.MeshStandardMaterial({
      map: set.albedo,
      normalMap: set.normal,
      roughnessMap: set.orm,
      metalnessMap: set.orm,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    });
    m.envMap = this.lib.environment;
    m.envMapIntensity = surface === 'crystal' ? 1.9 : 0.85;
    if (entry.emissive) {
      m.emissive = new THREE.Color(entry.emissive);
      m.emissiveIntensity = entry.emissiveIntensity;
    }
    this.patchWind(m, `solid:${surface}`, 1 / tileMetres);
    this.cache.set(key, m);
    this.ownedMaterials.push(m);
    return m;
  }

  /**
   * Inject the wind displacement. It is applied *after* the instance matrix, in
   * world space, so a yaw-rotated instance still sways downwind rather than
   * downwind-of-itself. `worldpos_vertex` is patched too, otherwise the shadow
   * lookup samples the unswayed position and the shadow detaches from the plant.
   */
  private patchWind(mat: THREE.MeshStandardMaterial, tag: string, uvScale: number): void {
    const wind = this.wind;
    const prefix = /* glsl */ `
      attribute float aBend;
      uniform float uWindTime;
      uniform vec2  uWindDir;
      uniform float uWindAmp;
      uniform float uGustScale;
      uniform float uGustSpeed;
      ${uvScale > 0 ? 'uniform float uFolUv;' : ''}

      vec3 gfWind(vec3 wp, float instScale){
        // One scalar wave travelling across the world: a gust visibly rolls
        // across a meadow instead of every plant twitching on its own clock.
        float gs = max(uGustScale, 0.001);
        float travel = (dot(wp.xz, uWindDir) - uWindTime * uGustSpeed) / gs;
        float gust = sin(travel) * 0.5 + 0.5;
        gust = gust * gust * (3.0 - 2.0 * gust);
        // Per-instance phase from the instance's own footprint: no extra
        // attribute, and stable as instances move between LOD buffers.
        float phase = fract(sin(dot(floor(wp.xz * 3.0), vec2(12.9898, 78.233))) * 43758.5453) * 6.28318;
        float flutter = sin(uWindTime * 3.1 + phase) * 0.32 + sin(uWindTime * 7.7 + phase * 2.3) * 0.13;
        float k = aBend * aBend;                       // stiffer at the base
        float amp = uWindAmp * instScale * k * (0.42 + gust * 0.95 + flutter * 0.55);
        vec3 off = vec3(uWindDir.x, 0.0, uWindDir.y) * amp;
        off.y -= abs(amp) * 0.3 * k;                   // bowing shortens the plant
        return off;
      }
    `;

    const projectPatch = /* glsl */ `
      vec4 mvPosition = vec4( transformed, 1.0 );
      float gfInstScale = 1.0;
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
        gfInstScale = length( instanceMatrix[0].xyz );
      #endif
      vec3 gfOff = gfWind( ( modelMatrix * mvPosition ).xyz, gfInstScale );
      mvPosition.xyz += gfOff;
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;
    `;

    const uvPatch =
      uvScale > 0
        ? `#include <uv_vertex>
           #ifdef USE_MAP
             vMapUv *= uFolUv;
           #endif
           #ifdef USE_NORMALMAP
             vNormalMapUv *= uFolUv;
           #endif
           #ifdef USE_ROUGHNESSMAP
             vRoughnessMapUv *= uFolUv;
           #endif
           #ifdef USE_METALNESSMAP
             vMetalnessMapUv *= uFolUv;
           #endif`
        : '#include <uv_vertex>';

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, wind);
      if (uvScale > 0) shader.uniforms.uFolUv = { value: uvScale };
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${prefix}\nvoid main() {`)
        .replace('#include <uv_vertex>', uvPatch)
        .replace('#include <project_vertex>', projectPatch)
        .replace(
          '#include <worldpos_vertex>',
          `#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
             vec4 worldPosition = vec4( transformed, 1.0 );
             #ifdef USE_INSTANCING
               worldPosition = instanceMatrix * worldPosition;
             #endif
             worldPosition.xyz += gfOff;
             worldPosition = modelMatrix * worldPosition;
           #endif`,
        );
    };
    mat.customProgramCacheKey = () => `gfFoliage:${tag}:${uvScale}`;

    // Shadow casters need the identical displacement or the shadow detaches.
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    if (mat.alphaTest > 0) {
      depth.map = mat.map;
      depth.alphaTest = mat.alphaTest;
    }
    depth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, wind);
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${prefix}\nvoid main() {`)
        .replace('#include <project_vertex>', projectPatch);
    };
    depth.customProgramCacheKey = () => `gfFoliageDepth:${tag}`;
    mat.userData.gfDepth = depth;
    this.ownedMaterials.push(depth);
  }

  // -- prototypes -----------------------------------------------------------

  private makePrototype(entry: TerrainFloraEntry, rng: Rng, seed: number): FoliagePrototype {
    _cA.set(entry.tintA).convertSRGBToLinear();
    _cB.set(entry.tintB).convertSRGBToLinear();
    switch (entry.kind) {
      case 'grass':
        return this.makeTuft(entry, rng, TILE_GRASS, 3, 0.45);
      case 'fern':
        return this.makeTuft(entry, rng, TILE_FERN, 3, 0.95);
      case 'reed':
        return this.makeTuft(entry, rng, TILE_REED, 2, 1.4);
      case 'bush':
        return this.makeBush(entry, rng);
      case 'tree':
        return this.makeTree(entry, rng, seed);
      case 'fungus':
        return this.makeFungus(entry, rng);
      default:
        return this.makeCrystal(entry, rng, seed);
    }
  }

  private wrap(
    entry: TerrainFloraEntry,
    near: THREE.BufferGeometry,
    far: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    height: number,
  ): FoliagePrototype {
    this.owned.push(near, far);
    return {
      kind: entry.kind,
      near,
      far,
      material,
      depthMaterial: material.userData.gfDepth as THREE.Material,
      height,
    };
  }

  /** Crossed cards. The workhorse: grass, ferns, reeds. */
  private makeTuft(
    entry: TerrainFloraEntry,
    rng: Rng,
    uv: UvRect,
    cards: number,
    height: number,
  ): FoliagePrototype {
    const make = (n: number, segs: number, r: Rng): THREE.BufferGeometry => {
      const b = newBuilder();
      for (let i = 0; i < n; i++) {
        addCard(b, {
          width: height * r.range(0.5, 0.74),
          height: height * r.range(0.8, 1.2),
          segments: segs,
          yaw: (i / n) * Math.PI + r.range(-0.25, 0.25),
          lean: height * r.range(-0.14, 0.14),
          curve: height * r.range(0.08, 0.28),
          taper: 1.5,
          uv,
          x: r.range(-0.06, 0.06) * height,
          z: r.range(-0.06, 0.06) * height,
          baseCol: _cA,
          tipCol: _cB,
          bow: 0.55,
        });
      }
      return finish(b);
    };
    const s = rng.next() * 4294967296;
    return this.wrap(
      entry,
      make(cards, 4, new Rng(s >>> 0)),
      make(Math.max(1, cards - 1), 1, new Rng(s >>> 0)),
      this.cardMaterial(entry),
      height,
    );
  }

  private makeBush(entry: TerrainFloraEntry, rng: Rng): FoliagePrototype {
    const h = rng.range(0.85, 1.5);
    const make = (n: number, segs: number, r: Rng): THREE.BufferGeometry => {
      const b = newBuilder();
      for (let i = 0; i < n; i++) {
        const a = r.range(0, Math.PI * 2);
        const rad = r.range(0, 0.34) * h;
        addCard(b, {
          width: h * r.range(0.55, 0.92),
          height: h * r.range(0.5, 1.0),
          segments: segs,
          yaw: a,
          lean: h * r.range(0.12, 0.42),
          curve: h * r.range(-0.2, 0.2),
          taper: 1.1,
          uv: TILE_LEAF,
          x: Math.cos(a) * rad,
          z: Math.sin(a) * rad,
          baseCol: _cA,
          tipCol: _cB,
          bow: 0.7,
        });
      }
      return finish(b);
    };
    const s = rng.next() * 4294967296;
    return this.wrap(
      entry,
      make(9, 3, new Rng(s >>> 0)),
      make(3, 1, new Rng(s >>> 0)),
      this.cardMaterial(entry),
      h,
    );
  }

  /** L-system tree: wood and canopy in one geometry, one material, one draw. */
  private makeTree(entry: TerrainFloraEntry, rng: Rng, seed: number): FoliagePrototype {
    const angle = rng.range(0.34, 0.56);
    const roll = rng.range(1.9, 2.6);
    const len0 = rng.range(1.9, 3.2);
    const w0 = len0 * rng.range(0.085, 0.13);
    const barkA = new THREE.Color().copy(_cA).multiplyScalar(0.5);
    const barkB = new THREE.Color().copy(_cA).multiplyScalar(0.78);
    const leafA = new THREE.Color().copy(_cA);
    const leafB = new THREE.Color().copy(_cB);

    const build = (iterations: number, sides: number, leafSegs: number, rosette: number) => {
      const b = newBuilder();
      const word = lsystem(iterations, new Rng(seed));
      const lrng = new Rng((seed ^ 0x5bf03635) >>> 0);

      interface State {
        pos: THREE.Vector3;
        q: THREE.Quaternion;
        w: number;
        l: number;
        depth: number;
        seg: number;
      }
      const stack: State[] = [];
      let st: State = {
        pos: new THREE.Vector3(),
        q: new THREE.Quaternion(),
        w: w0,
        l: len0,
        depth: 0,
        seg: 0,
      };
      let maxY = 0;
      const X = new THREE.Vector3(1, 0, 0);
      const Y = new THREE.Vector3(0, 1, 0);
      const Z = new THREE.Vector3(0, 0, 1);
      const rot = (axis: THREE.Vector3, a: number): void => {
        _q.setFromAxisAngle(axis, a);
        st.q.multiply(_q);
      };
      const from = new THREE.Vector3();
      const to = new THREE.Vector3();
      const card = newBuilder();

      for (const ch of word) {
        switch (ch) {
          case 'F': {
            from.copy(st.pos);
            to.copy(from).add(_v.set(0, st.l, 0).applyQuaternion(st.q));
            addTube(
              b,
              from,
              to,
              st.q,
              st.q,
              st.w,
              st.w * 0.76,
              sides,
              barkA,
              barkB,
              clamp(st.depth / 5, 0, 1) * 0.65,
              clamp((st.depth + 1) / 5, 0, 1) * 0.85,
              TILE_BARK,
              st.seg,
            );
            st.pos.copy(to);
            st.seg++;
            st.w *= 0.86;
            st.l *= 0.82;
            st.depth++;
            if (to.y > maxY) maxY = to.y;
            break;
          }
          case '!':
            st.w *= 0.94;
            break;
          case '+':
            rot(Z, angle);
            break;
          case '-':
            rot(Z, -angle);
            break;
          case '&':
            rot(X, angle * 0.72);
            break;
          case '^':
            rot(X, -angle * 0.72);
            break;
          case '/':
            rot(Y, roll);
            break;
          case '\\':
            rot(Y, -roll);
            break;
          case '[':
            stack.push({
              pos: st.pos.clone(),
              q: st.q.clone(),
              w: st.w,
              l: st.l,
              depth: st.depth,
              seg: st.seg,
            });
            break;
          case ']': {
            const p = stack.pop();
            if (p) st = p;
            break;
          }
          case 'A': {
            // Canopy: a rosette of leaf cards at every apex, splayed so the crown
            // silhouette is broken rather than a ball.
            for (let i = 0; i < rosette; i++) {
              card.pos.length = 0;
              card.nrm.length = 0;
              card.uv.length = 0;
              card.col.length = 0;
              card.bend.length = 0;
              card.idx.length = 0;
              addCard(card, {
                width: st.l * 2.1,
                height: st.l * 1.8,
                segments: leafSegs,
                yaw: (i / rosette) * Math.PI * 2 + lrng.range(-0.35, 0.35),
                lean: st.l * 0.5,
                curve: st.l * -0.2,
                taper: 1.05,
                uv: TILE_LEAF,
                x: 0,
                z: 0,
                baseCol: leafA,
                tipCol: leafB,
                bow: 0.75,
              });
              const base = b.pos.length / 3;
              for (let v = 0; v < card.pos.length; v += 3) {
                _v.set(card.pos[v], card.pos[v + 1], card.pos[v + 2])
                  .applyQuaternion(st.q)
                  .add(st.pos);
                b.pos.push(_v.x, _v.y, _v.z);
                _v2.set(card.nrm[v], card.nrm[v + 1], card.nrm[v + 2]).applyQuaternion(st.q);
                b.nrm.push(_v2.x, _v2.y, _v2.z);
                if (_v.y > maxY) maxY = _v.y;
              }
              for (const t of card.uv) b.uv.push(t);
              for (const t of card.col) b.col.push(t);
              for (const t of card.bend) b.bend.push(clamp(0.5 + t * 0.5, 0, 1));
              for (const t of card.idx) b.idx.push(base + t);
            }
            break;
          }
          default:
            break;
        }
      }
      return { geo: finish(b), maxY };
    };

    const hi = build(3, 5, 2, 4);
    const lo = build(2, 3, 1, 2);
    return this.wrap(entry, hi.geo, lo.geo, this.cardMaterial(entry), Math.max(hi.maxY, 1));
  }

  /** Hive fungus: a swollen stalk under a heavy cap. Reads at 100 m. */
  private makeFungus(entry: TerrainFloraEntry, rng: Rng): FoliagePrototype {
    const h = rng.range(2.4, 6.2);
    const profile: readonly (readonly [number, number])[] = [
      [0.1, 0],
      [0.16, 0.05],
      [0.12, 0.3],
      [0.11, 0.55],
      [0.15, 0.62],
      [0.44, 0.66],
      [0.64, 0.72],
      [0.68, 0.79],
      [0.52, 0.9],
      [0.24, 0.97],
      [0.0, 1.0],
    ];
    const radius = h * rng.range(0.32, 0.5);
    const make = (segs: number): THREE.BufferGeometry => {
      const b = newBuilder();
      addLathe(b, profile, segs, h, radius, _cA, _cB);
      return finish(b);
    };
    return this.wrap(entry, make(12), make(6), this.solidMaterial('hiveChitin', entry, 2.6), h);
  }

  /** Ice-world crystal growth: a cluster of tilted hexagonal shafts. */
  private makeCrystal(entry: TerrainFloraEntry, rng: Rng, seed: number): FoliagePrototype {
    const h = rng.range(1.2, 3.6);
    const make = (count: number, sides: number): THREE.BufferGeometry => {
      const b = newBuilder();
      const r = new Rng(seed);
      const axis = new THREE.Vector3();
      const q0 = new THREE.Quaternion();
      const from = new THREE.Vector3();
      const mid = new THREE.Vector3();
      const tip = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        const a = r.range(0, Math.PI * 2);
        const len = h * r.range(0.45, 1.0);
        const rad = len * r.range(0.1, 0.2);
        axis.set(Math.cos(a), 0, Math.sin(a));
        q0.setFromAxisAngle(axis, r.range(0.08, 0.52));
        from.set(Math.cos(a) * r.range(0, 0.3) * h, -0.06 * h, Math.sin(a) * r.range(0, 0.3) * h);
        _v.set(0, len, 0).applyQuaternion(q0);
        mid.copy(from).addScaledVector(_v, 0.78);
        tip.copy(from).add(_v);
        addTube(b, from, mid, q0, q0, rad, rad * 0.84, sides, _cA, _cB, 0, 0.45, null, 0);
        addTube(b, mid, tip, q0, q0, rad * 0.84, rad * 0.05, sides, _cB, _cB, 0.45, 1, null, 1);
      }
      return finish(b);
    };
    return this.wrap(entry, make(6, 6), make(3, 5), this.solidMaterial('crystal', entry, 1.6), h);
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.atlas.map.dispose();
    this.atlas.normal.dispose();
    this.protos.clear();
    this.cache.clear();
  }
}
