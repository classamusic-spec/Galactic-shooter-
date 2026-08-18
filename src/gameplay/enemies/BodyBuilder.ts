/**
 * BodyBuilder — the compositional creature kit.
 *
 * Faction owners never write raw `BufferGeometry` maths. They compose bodies
 * from named parts that already have correct normals, seam-free UVs, vertex
 * colours for cavity/accent detail, and a material key. The builder then merges
 * everything sharing a material into a single indexed geometry, so a complete
 * enemy is **1–3 draw calls** no matter how many horns, plates and vents it has.
 *
 * ```ts
 * build(ctx) {
 *   const b = ctx.builder;
 *   b.material('shell', 'hiveChitin', { color: 0x3d5a2a });
 *   b.material('glow', b.emissive(0x9dff4a, 3));
 *   b.add('shell', b.carapace({ centre: v(0, 1.2, 0), radius: 0.34, height: 0.5, ridges: 5 }));
 *   b.add('glow',  b.lens({ centre: v(0, 1.55, -0.22), normal: FORWARD, radius: 0.07 }));
 *   return { rig, parts: b.finish(), ... };
 * }
 * ```
 *
 * ## Reading in silhouette
 *
 * Every primitive here is built to survive being flattened to a black shape:
 * limbs taper and bulge at joints instead of being uniform tubes, plates have
 * bevelled rims that catch a highlight, spines and horns break the outline.
 * A creature assembled only from `segment()` capsules will read as a blob —
 * always break the outline with at least two of `spine`, `horn`, `plate`,
 * `mandible` or `carapace`.
 */
import * as THREE from 'three';
import type { MaterialLibrary, SurfaceOptions } from '@/gfx/materials/MaterialLibrary';
import type { SurfaceMaterialName } from '@/gfx/materials/SurfaceMaterials';
import { GLSL_NOISE } from '@/gfx/materials/glsl';
import { clamp, clamp01, lerp, Rng, TAU } from '@/util/math';

// ---------------------------------------------------------------------------
// Enemy materials: per-instance dissolve, hit flash and UV scale
// ---------------------------------------------------------------------------

export interface EnemyMaterialUniforms {
  uUvScale: THREE.IUniform<number>;
  /** 0 = intact, 1 = fully gone. */
  uDissolve: THREE.IUniform<number>;
  /** 0 nordic freeze, 1 grey psionic, 2 mantis burst, 3 insectoid ichor, 4 reptilian ash, 5 federation. */
  uDissolveMode: THREE.IUniform<number>;
  uEdgeColor: THREE.IUniform<THREE.Color>;
  /** 0..1 white-hot flash on a damage hit. */
  uHitFlash: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  /** Body-space centroid, used by the psionic collapse. */
  uCentre: THREE.IUniform<THREE.Vector3>;
}

interface EnemyMaterial extends THREE.MeshStandardMaterial {
  userData: { enemyUniforms?: EnemyMaterialUniforms; uvScale?: THREE.IUniform<number> } & Record<
    string,
    unknown
  >;
}

const DISSOLVE_VERT = /* glsl */ `
  // Per-mode geometric break-up. Runs only while uDissolve > 0, so a live body
  // pays one branch and nothing else.
  if (uDissolve > 0.0) {
    vec3 cell = floor(position * 7.0);
    vec3 h = hash33(cell) * 2.0 - 1.0;
    float d = uDissolve;
    if (uDissolveMode < 0.5) {
      // Nordic: frozen shards drift apart along their own facet normal.
      transformed += (normalize(h + normal * 0.6)) * d * d * 0.42;
    } else if (uDissolveMode < 1.5) {
      // Grey: the body is pulled inward and folded out of the world.
      transformed = mix(transformed, uCentre, d * d * 0.85);
      transformed += h * d * 0.05;
    } else if (uDissolveMode < 2.5) {
      // Mantis: chitin bursts outward off the surface normal.
      transformed += normal * d * d * 0.55 + h * d * 0.18;
    } else if (uDissolveMode < 3.5) {
      // Insectoid: the shell slumps and sags as the fluid leaves it.
      transformed.y -= d * d * 0.35;
      transformed += h * d * 0.08;
    } else if (uDissolveMode < 4.5) {
      // Reptilian: ash lifts on the thermal.
      transformed += vec3(h.x * 0.12, d * 0.55, h.z * 0.12) * d;
    } else {
      transformed += normal * d * 0.06;
    }
  }
`;

const DISSOLVE_FRAG = /* glsl */ `
  if (uDissolve > 0.0) {
    float n = fbm3(vEnemyPos * 5.5, 3, 2.0, 0.5) * 0.5 + 0.5;
    // A bottom-up bias reads as burning/collapsing rather than random fizzing.
    float bias = clamp(0.5 - vEnemyPos.y * 0.45, 0.0, 1.0);
    float mask = n * 0.72 + bias * 0.28;
    float cut = uDissolve * 1.12;
    if (mask < cut - 0.14) discard;
    float edge = 1.0 - smoothstep(cut - 0.14, cut + 0.02, mask);
    totalEmissiveRadiance += uEdgeColor * edge * edge * 6.0;
    diffuseColor.rgb *= mix(1.0, 0.25, edge);
  }
  totalEmissiveRadiance += vec3(uHitFlash) * 2.2;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), uHitFlash * 0.5);
`;

/**
 * Take a library material and make it an enemy body material: vertex colours
 * on, per-instance dissolve/flash uniforms attached, and the library's UV-scale
 * injection re-applied (it lives in `onBeforeCompile`, which `clone()` drops).
 *
 * Every material produced here compiles to the **same** shader source, so N
 * clones share one program — the uniforms are what differ.
 */
export function prepareEnemyMaterial(
  src: THREE.Material,
  opts: { vertexColors?: boolean; uvScale?: number } = {},
): THREE.MeshStandardMaterial {
  const mat = (src as THREE.MeshStandardMaterial).clone() as EnemyMaterial;
  mat.vertexColors = opts.vertexColors ?? true;
  const inherited = (src as EnemyMaterial).userData?.uvScale?.value;
  const uniforms: EnemyMaterialUniforms = {
    uUvScale: { value: opts.uvScale ?? inherited ?? 1 },
    uDissolve: { value: 0 },
    uDissolveMode: { value: 4 },
    uEdgeColor: { value: new THREE.Color(0xff7a3c) },
    uHitFlash: { value: 0 },
    uTime: { value: 0 },
    uCentre: { value: new THREE.Vector3(0, 1, 0) },
  };
  installEnemyShader(mat, uniforms);
  return mat;
}

/** Per-agent copy of a species material. Shares textures and shader program. */
export function cloneEnemyMaterial(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const source = src as EnemyMaterial;
  const mat = src.clone() as EnemyMaterial;
  const from = source.userData.enemyUniforms;
  const uniforms: EnemyMaterialUniforms = {
    uUvScale: { value: from?.uUvScale.value ?? 1 },
    uDissolve: { value: 0 },
    uDissolveMode: { value: from?.uDissolveMode.value ?? 4 },
    uEdgeColor: { value: (from?.uEdgeColor.value ?? new THREE.Color(0xff7a3c)).clone() },
    uHitFlash: { value: 0 },
    uTime: { value: 0 },
    uCentre: { value: (from?.uCentre.value ?? new THREE.Vector3(0, 1, 0)).clone() },
  };
  installEnemyShader(mat, uniforms);
  return mat;
}

export function enemyUniforms(m: THREE.Material): EnemyMaterialUniforms | null {
  return ((m as EnemyMaterial).userData?.enemyUniforms as EnemyMaterialUniforms) ?? null;
}

function installEnemyShader(mat: EnemyMaterial, uniforms: EnemyMaterialUniforms): void {
  mat.userData = { ...mat.userData, enemyUniforms: uniforms, uvScale: uniforms.uUvScale };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uUvScale = uniforms.uUvScale;
    shader.uniforms.uDissolve = uniforms.uDissolve;
    shader.uniforms.uDissolveMode = uniforms.uDissolveMode;
    shader.uniforms.uEdgeColor = uniforms.uEdgeColor;
    shader.uniforms.uHitFlash = uniforms.uHitFlash;
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCentre = uniforms.uCentre;

    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `${GLSL_NOISE}
        uniform float uUvScale;
        uniform float uDissolve;
        uniform float uDissolveMode;
        uniform vec3 uCentre;
        varying vec3 vEnemyPos;
        void main() {`,
      )
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
        #ifdef USE_EMISSIVEMAP
          vEmissiveMapUv *= uUvScale;
        #endif`,
      )
      .replace(
        '#include <skinning_vertex>',
        `vEnemyPos = position;
        ${DISSOLVE_VERT}
        #include <skinning_vertex>`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `${GLSL_NOISE}
        uniform float uDissolve;
        uniform float uDissolveMode;
        uniform vec3 uEdgeColor;
        uniform float uHitFlash;
        varying vec3 vEnemyPos;
        void main() {`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${DISSOLVE_FRAG}`);
  };
  // Programs are keyed by source + this string; every enemy material emits the
  // same source, and only differing UV scales genuinely need separate programs.
  mat.customProgramCacheKey = () => `enemy:${uniforms.uUvScale.value}`;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _col = new THREE.Color();
const _q = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _nm = new THREE.Matrix3();

export interface BuiltPart {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

/** Guarantee position/normal/uv/color + an index, so parts can always merge. */
function ensureStandard(geo: THREE.BufferGeometry, color?: THREE.Color): THREE.BufferGeometry {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const count = geo.getAttribute('position').count;
  if (!geo.getAttribute('uv')) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!geo.getAttribute('color')) {
    const c = new Float32Array(count * 3);
    const col = color ?? new THREE.Color(1, 1, 1);
    for (let i = 0; i < count; i++) {
      c[i * 3] = col.r;
      c[i * 3 + 1] = col.g;
      c[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (!geo.getIndex()) {
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

/**
 * Merge a set of standardised geometries. Written locally rather than pulled
 * from the examples utils so the attribute layout is guaranteed and the merge
 * never silently drops vertex colours.
 */
export function mergeParts(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vTotal = 0;
  let iTotal = 0;
  for (const g of list) {
    vTotal += g.getAttribute('position').count;
    iTotal += g.getIndex()!.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const col = new Float32Array(vTotal * 3);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const t = g.getAttribute('uv') as THREE.BufferAttribute;
    const c = g.getAttribute('color') as THREE.BufferAttribute;
    const ix = g.getIndex()!;
    pos.set(p.array as Float32Array, vo * 3);
    nor.set(n.array as Float32Array, vo * 3);
    uv.set(t.array as Float32Array, vo * 2);
    col.set(c.array as Float32Array, vo * 3);
    for (let i = 0; i < ix.count; i++) idx[io + i] = ix.getX(i) + vo;
    vo += p.count;
    io += ix.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

export interface LoftOptions {
  /** Radial subdivisions. 6–10 reads as hard-surface, 12–16 as organic. */
  sides?: number;
  /** Radius as a function of `t` along the path, or a per-ring array. */
  radius: number | number[] | ((t: number) => number);
  /** Ellipse ratio: local Z radius / local X radius. <1 flattens the part. */
  flatten?: number | ((t: number) => number);
  /** Total twist over the length, radians. */
  twist?: number;
  capStart?: boolean;
  capEnd?: boolean;
  /** Flat-shade the result — the cheapest way to make armour read as armour. */
  faceted?: boolean;
  /** Radial ripple count and depth, for ridged chitin and segmented plating. */
  ridges?: number;
  ridgeDepth?: number;
  /** Vertex colour at the base and at the tip. */
  color?: THREE.Color | number;
  colorTip?: THREE.Color | number;
  /** Extra cavity darkening where the section is thin. 0 disables. */
  cavity?: number;
  uvScale?: number;
  /** Rotate the ring's local frame so ridges line up between parts. */
  phase?: number;
}

function toColor(c: THREE.Color | number | undefined, dflt: THREE.Color): THREE.Color {
  if (c == null) return dflt;
  return typeof c === 'number' ? new THREE.Color(c) : c;
}

/**
 * Sweep a closed ring along a path with parallel-transport frames.
 *
 * Parallel transport (rather than Frenet frames) is what stops a curved horn
 * from spinning its ridges through 180° at an inflection point.
 */
export function loft(path: THREE.Vector3[], opts: LoftOptions): THREE.BufferGeometry {
  const n = path.length;
  if (n < 2) return new THREE.BufferGeometry();
  const sides = Math.max(3, Math.floor(opts.sides ?? 10));
  const capStart = opts.capStart ?? true;
  const capEnd = opts.capEnd ?? true;
  const ridges = opts.ridges ?? 0;
  const ridgeDepth = opts.ridgeDepth ?? 0.12;
  const twist = opts.twist ?? 0;
  const phase = opts.phase ?? 0;
  const uvScale = opts.uvScale ?? 1;
  const cBase = toColor(opts.color, new THREE.Color(1, 1, 1));
  const cTip = toColor(opts.colorTip, cBase);
  const cavity = opts.cavity ?? 0.18;

  const radiusAt = (t: number, i: number): number => {
    const r = opts.radius;
    if (typeof r === 'number') return r;
    if (Array.isArray(r)) return r[Math.min(i, r.length - 1)];
    return r(t);
  };
  const flattenAt = (t: number): number => {
    const f = opts.flatten;
    if (f == null) return 1;
    return typeof f === 'number' ? f : f(t);
  };

  // Arc length for stable UVs.
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + path[i].distanceTo(path[i - 1]));
  const total = Math.max(1e-5, arc[n - 1]);

  // Tangents.
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-10) t.set(0, 1, 0);
    tangents.push(t.normalize());
  }

  // Parallel-transported frame.
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let nrm = new THREE.Vector3();
  if (Math.abs(tangents[0].y) < 0.9) nrm.set(0, 1, 0);
  else nrm.set(1, 0, 0);
  nrm.cross(tangents[0]).normalize();
  if (nrm.lengthSq() < 1e-8) nrm.set(1, 0, 0);
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const axis = _a.crossVectors(tangents[i - 1], tangents[i]);
      const s = axis.length();
      if (s > 1e-7) {
        const ang = Math.atan2(s, tangents[i - 1].dot(tangents[i]));
        nrm = nrm.clone().applyQuaternion(_q.setFromAxisAngle(axis.multiplyScalar(1 / s), ang));
      } else {
        nrm = nrm.clone();
      }
      // Re-orthogonalise so drift never accumulates into a skewed ring.
      nrm.addScaledVector(tangents[i], -nrm.dot(tangents[i])).normalize();
    }
    normals.push(nrm.clone());
    binormals.push(new THREE.Vector3().crossVectors(tangents[i], nrm).normalize());
  }

  const vCount = n * (sides + 1) + (capStart ? sides + 2 : 0) + (capEnd ? sides + 2 : 0);
  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const col = new Float32Array(vCount * 3);
  const indices: number[] = [];
  let v = 0;

  let maxR = 0;
  for (let i = 0; i < n; i++) maxR = Math.max(maxR, radiusAt(i / (n - 1), i));
  maxR = Math.max(maxR, 1e-4);

  const ringStart: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const r = radiusAt(t, i);
    const fl = flattenAt(t);
    const shade = lerp(1 - cavity, 1, clamp01(r / maxR));
    ringStart.push(v);
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * TAU + twist * t + phase;
      const ripple = ridges > 0 ? 1 + Math.cos(a * ridges) * ridgeDepth : 1;
      const rx = Math.cos(a) * r * ripple;
      const rz = Math.sin(a) * r * ripple * fl;
      const p = _b
        .copy(path[i])
        .addScaledVector(normals[i], rx)
        .addScaledVector(binormals[i], rz);
      pos[v * 3] = p.x;
      pos[v * 3 + 1] = p.y;
      pos[v * 3 + 2] = p.z;
      uv[v * 2] = (s / sides) * uvScale;
      uv[v * 2 + 1] = (arc[i] / total) * uvScale * (total / Math.max(0.2, maxR * 4));
      const cc = _col.copy(cBase).lerp(cTip, t).multiplyScalar(shade);
      col[v * 3] = cc.r;
      col[v * 3 + 1] = cc.g;
      col[v * 3 + 2] = cc.b;
      v++;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    for (let s = 0; s < sides; s++) {
      const a = a0 + s;
      const b = a0 + s + 1;
      const c = b0 + s + 1;
      const d = b0 + s;
      indices.push(a, d, b, b, d, c);
    }
  }

  const cap = (index: number, dir: number): void => {
    const t = index / (n - 1);
    const r = radiusAt(t, index);
    const fl = flattenAt(t);
    const centre = v;
    const cc = _col.copy(cBase).lerp(cTip, t).multiplyScalar(1 - cavity * 0.5);
    pos[v * 3] = path[index].x;
    pos[v * 3 + 1] = path[index].y;
    pos[v * 3 + 2] = path[index].z;
    uv[v * 2] = 0.5;
    uv[v * 2 + 1] = 0.5;
    col[v * 3] = cc.r;
    col[v * 3 + 1] = cc.g;
    col[v * 3 + 2] = cc.b;
    v++;
    const first = v;
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * TAU + twist * t + phase;
      const ripple = ridges > 0 ? 1 + Math.cos(a * ridges) * ridgeDepth : 1;
      const p = _b
        .copy(path[index])
        .addScaledVector(normals[index], Math.cos(a) * r * ripple)
        .addScaledVector(binormals[index], Math.sin(a) * r * ripple * fl);
      pos[v * 3] = p.x;
      pos[v * 3 + 1] = p.y;
      pos[v * 3 + 2] = p.z;
      uv[v * 2] = 0.5 + Math.cos(a) * 0.5;
      uv[v * 2 + 1] = 0.5 + Math.sin(a) * 0.5;
      col[v * 3] = cc.r;
      col[v * 3 + 1] = cc.g;
      col[v * 3 + 2] = cc.b;
      v++;
    }
    for (let s = 0; s < sides; s++) {
      if (dir > 0) indices.push(centre, first + s, first + s + 1);
      else indices.push(centre, first + s + 1, first + s);
    }
  };
  if (capStart) cap(0, -1);
  if (capEnd) cap(n - 1, 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, v * 2), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  if (opts.faceted) {
    const flat = geo.toNonIndexed();
    geo.dispose();
    flat.computeVertexNormals();
    return ensureStandard(flat);
  }
  return ensureStandard(geo);
}

/** A path from `from` to `to`, bowed by `bend` metres toward `bendAxis`. */
export function arcPath(
  from: THREE.Vector3,
  to: THREE.Vector3,
  bend: number,
  bendAxis: THREE.Vector3,
  steps: number,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const axis = _a.copy(bendAxis);
  if (axis.lengthSq() < 1e-8) axis.set(0, 0, -1);
  axis.normalize();
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const p = new THREE.Vector3().lerpVectors(from, to, t);
    p.addScaledVector(axis, Math.sin(t * Math.PI) * bend);
    out.push(p);
  }
  return out;
}

/**
 * A 4-sided loft with `phase = PI/4` is an axis-aligned box. Its ring radius is
 * a circumradius, so the half-width is `r * cos(PI/4)`; multiply a desired
 * half-width by this to get the radius to ask for.
 */
export const BOX_R = Math.SQRT2;

/** A bevelled box: chamfered ends that catch a specular line, unlike BoxGeometry. */
export function bevelBox(
  size: THREE.Vector3,
  bevel: number,
  color?: THREE.Color | number,
): THREE.BufferGeometry {
  const by = Math.min(bevel, size.y * 0.45);
  const inset = Math.min(bevel, Math.min(size.x, size.z) * 0.4);
  const hx = size.x * 0.5 * BOX_R;
  const path = [
    new THREE.Vector3(0, -size.y * 0.5, 0),
    new THREE.Vector3(0, -size.y * 0.5 + by, 0),
    new THREE.Vector3(0, size.y * 0.5 - by, 0),
    new THREE.Vector3(0, size.y * 0.5, 0),
  ];
  const inner = (size.x * 0.5 - inset) * BOX_R;
  return loft(path, {
    sides: 4,
    radius: [inner, hx, hx, inner],
    flatten: size.z / Math.max(1e-4, size.x),
    faceted: true,
    color,
    cavity: 0.1,
    phase: Math.PI * 0.25,
  });
}

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

export interface SegmentOptions {
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Radius at the start / at the end. */
  r0: number;
  r1?: number;
  /** Mid-span bulge multiplier (1 = straight taper). */
  bulge?: number;
  bend?: number;
  bendAxis?: THREE.Vector3;
  sides?: number;
  steps?: number;
  flatten?: number;
  faceted?: boolean;
  ridges?: number;
  ridgeDepth?: number;
  color?: THREE.Color | number;
  colorTip?: THREE.Color | number;
  capStart?: boolean;
  capEnd?: boolean;
  twist?: number;
}

export interface PlateOptions {
  centre: THREE.Vector3;
  /** Outward face direction. */
  normal: THREE.Vector3;
  /** In-plane "up" of the plate. */
  up?: THREE.Vector3;
  width: number;
  height: number;
  thickness?: number;
  /** Wrap angle around the up axis, radians — how much the plate curves. */
  curve?: number;
  /** Width multiplier at the top edge; <1 gives a tapered pauldron. */
  taper?: number;
  bevel?: number;
  segments?: number;
  color?: THREE.Color | number;
  edgeColor?: THREE.Color | number;
}

export interface CarapaceOptions {
  centre: THREE.Vector3;
  radius: number;
  height: number;
  /** Cross-section width ratio: >1 stretches the dome across its minor axis. */
  length?: number;
  ridges?: number;
  ridgeDepth?: number;
  segments?: number;
  faceted?: boolean;
  color?: THREE.Color | number;
  colorTip?: THREE.Color | number;
  /** Rotation of the dome, so it can lie along a back rather than face up. */
  direction?: THREE.Vector3;
}

export interface SpineOptions {
  base: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
  radius: number;
  curve?: number;
  curveAxis?: THREE.Vector3;
  sides?: number;
  sharpness?: number;
  color?: THREE.Color | number;
  colorTip?: THREE.Color | number;
}

export interface HornOptions extends SpineOptions {
  ridges?: number;
  twist?: number;
}

export interface MandibleOptions {
  base: THREE.Vector3;
  /** Direction the mandible reaches. */
  direction: THREE.Vector3;
  /** Which way it curves closed (usually toward the body centreline). */
  inward: THREE.Vector3;
  length: number;
  thickness: number;
  /** Blade flattening, 0.25 = very flat. */
  flatten?: number;
  serrations?: number;
  color?: THREE.Color | number;
  colorTip?: THREE.Color | number;
}

export interface DigitOptions {
  base: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
  radius: number;
  joints?: number;
  curl?: number;
  curlAxis?: THREE.Vector3;
  claw?: boolean;
  color?: THREE.Color | number;
}

export interface LensOptions {
  centre: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
  /** Dome bulge as a fraction of the radius. */
  bulge?: number;
  segments?: number;
  color?: THREE.Color | number;
  /** Bright core colour at the pupil. */
  coreColor?: THREE.Color | number;
}

export interface VentOptions {
  centre: THREE.Vector3;
  normal: THREE.Vector3;
  up?: THREE.Vector3;
  width: number;
  height: number;
  depth?: number;
  slats?: number;
  color?: THREE.Color | number;
}

export interface WeaponMountOptions {
  /** Where the mount attaches to the body. */
  base: THREE.Vector3;
  /** Direction the barrel points. */
  direction: THREE.Vector3;
  length: number;
  radius: number;
  /** Bracket size; 0 for a bare barrel. */
  bracket?: number;
  shroud?: boolean;
  color?: THREE.Color | number;
}

function basis(normal: THREE.Vector3, up: THREE.Vector3 | undefined, out: THREE.Matrix4): THREE.Matrix4 {
  const n = _a.copy(normal).normalize();
  const u = _b.copy(up ?? (Math.abs(n.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0)));
  u.addScaledVector(n, -u.dot(n));
  if (u.lengthSq() < 1e-8) u.set(0, 1, 0).addScaledVector(n, -n.y);
  u.normalize();
  const r = _c.crossVectors(u, n).normalize();
  return out.makeBasis(r, u, n);
}

export class BodyBuilder {
  readonly materials: MaterialLibrary;
  readonly rng: Rng;
  /** Geometry detail scalar from the quality profile, 0.5 … 1.3. */
  readonly detail: number;

  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private buckets = new Map<string, THREE.BufferGeometry[]>();

  constructor(materials: MaterialLibrary, rng: Rng, detail = 1) {
    this.materials = materials;
    this.rng = rng;
    this.detail = detail;
  }

  /** Round a subdivision count by the quality profile, with a sane floor. */
  seg(n: number, min = 4): number {
    return Math.max(min, Math.round(n * this.detail));
  }

  /**
   * Register a material under a key. Accepts a library surface name (the usual
   * case) or a ready-made material. The returned material is an *enemy* variant:
   * vertex colours on, dissolve + hit-flash uniforms installed.
   */
  material(
    key: string,
    src: SurfaceMaterialName | THREE.Material,
    opts: SurfaceOptions = {},
  ): THREE.MeshStandardMaterial {
    const existing = this.mats.get(key);
    if (existing) return existing;
    const base = typeof src === 'string' ? this.materials.get(src) : src;
    const mat = prepareEnemyMaterial(base, { uvScale: opts.repeat });
    if (opts.color != null) mat.color.setHex(opts.color);
    if (opts.emissive != null) mat.emissive.setHex(opts.emissive);
    if (opts.emissiveIntensity != null) mat.emissiveIntensity = opts.emissiveIntensity;
    if (opts.roughness != null) mat.roughness = opts.roughness;
    if (opts.metalness != null) mat.metalness = opts.metalness;
    mat.name = `enemy.${key}`;
    this.mats.set(key, mat);
    return mat;
  }

  /** Convenience: a glowing faction-accent material. */
  emissive(key: string, color: number, intensity = 2.5): THREE.MeshStandardMaterial {
    const existing = this.mats.get(key);
    if (existing) return existing;
    const mat = prepareEnemyMaterial(this.materials.emissive(color, intensity), {});
    mat.name = `enemy.${key}`;
    this.mats.set(key, mat);
    return mat;
  }

  /** Queue a geometry under a material key. Optionally transform it first. */
  add(key: string, geo: THREE.BufferGeometry, matrix?: THREE.Matrix4): void {
    if (!this.mats.has(key)) {
      throw new Error(`BodyBuilder: material "${key}" was not registered before add()`);
    }
    if (matrix) {
      geo.applyMatrix4(matrix);
      _nm.getNormalMatrix(matrix);
      const nAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
      for (let i = 0; i < nAttr.count; i++) {
        _a.set(nAttr.getX(i), nAttr.getY(i), nAttr.getZ(i)).applyMatrix3(_nm).normalize();
        nAttr.setXYZ(i, _a.x, _a.y, _a.z);
      }
    }
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = []));
    bucket.push(ensureStandard(geo));
  }

  /** Merge everything queued into one geometry per material. */
  finish(): BuiltPart[] {
    const out: BuiltPart[] = [];
    for (const [key, list] of this.buckets) {
      if (list.length === 0) continue;
      const merged = list.length === 1 ? list[0] : mergeParts(list);
      if (list.length > 1) for (const g of list) g.dispose();
      const material = this.mats.get(key)!;
      out.push({ key, geometry: merged, material });
    }
    this.buckets.clear();
    return out;
  }

  // -- primitives ----------------------------------------------------------

  /**
   * The workhorse: a tapered, optionally bulging and bent tube between two
   * points. Torsos, thighs, forearms, abdomen segments — most of a body.
   */
  segment(o: SegmentOptions): THREE.BufferGeometry {
    const steps = Math.max(3, this.seg(o.steps ?? 7, 3));
    const bend = o.bend ?? 0;
    const path = bend !== 0
      ? arcPath(o.from, o.to, bend, o.bendAxis ?? new THREE.Vector3(0, 0, -1), steps)
      : arcPath(o.from, o.to, 0, new THREE.Vector3(0, 0, -1), steps);
    const r1 = o.r1 ?? o.r0;
    const bulge = o.bulge ?? 1;
    return loft(path, {
      sides: this.seg(o.sides ?? 10, 5),
      radius: (t) => lerp(o.r0, r1, t) * lerp(1, bulge, Math.sin(t * Math.PI)),
      flatten: o.flatten ?? 1,
      faceted: o.faceted ?? false,
      ridges: o.ridges ?? 0,
      ridgeDepth: o.ridgeDepth ?? 0.1,
      color: o.color,
      colorTip: o.colorTip,
      capStart: o.capStart ?? true,
      capEnd: o.capEnd ?? true,
      twist: o.twist ?? 0,
      uvScale: 1.4,
    });
  }

  /**
   * A limb bone: tapered, with a joint bulge at each end and a muscle swell in
   * the middle. Reads as an arm or a leg instead of a pipe.
   */
  taperedLimb(o: SegmentOptions & { jointR?: number; muscle?: number }): THREE.BufferGeometry {
    const steps = Math.max(5, this.seg(o.steps ?? 9, 5));
    const path = arcPath(
      o.from,
      o.to,
      o.bend ?? 0,
      o.bendAxis ?? new THREE.Vector3(0, 0, -1),
      steps,
    );
    const r1 = o.r1 ?? o.r0 * 0.72;
    const jointR = o.jointR ?? Math.max(o.r0, r1) * 1.18;
    const muscle = o.muscle ?? 1.22;
    return loft(path, {
      sides: this.seg(o.sides ?? 10, 5),
      radius: (t) => {
        const base = lerp(o.r0, r1, t);
        const swell = 1 + (muscle - 1) * Math.sin(Math.pow(clamp01(t * 1.15), 0.8) * Math.PI);
        const cap = Math.exp(-Math.pow(t / 0.1, 2)) + Math.exp(-Math.pow((1 - t) / 0.1, 2));
        return lerp(base * swell, jointR, clamp01(cap) * 0.55);
      },
      flatten: o.flatten ?? 0.86,
      faceted: o.faceted ?? false,
      ridges: o.ridges ?? 0,
      ridgeDepth: o.ridgeDepth ?? 0.08,
      color: o.color,
      colorTip: o.colorTip,
      cavity: 0.22,
      uvScale: 1.6,
    });
  }

  /**
   * A curved armour plate with a bevelled rim. Shoulder pauldrons, chest
   * cuirasses, thigh tassets. Curvature plus the rim is what separates armour
   * from a flat card.
   */
  plate(o: PlateOptions): THREE.BufferGeometry {
    const segs = this.seg(o.segments ?? 8, 4);
    const rows = Math.max(2, Math.round(segs * 0.6));
    const thickness = o.thickness ?? 0.03;
    const curve = o.curve ?? 0.9;
    const taper = o.taper ?? 1;
    const bevel = o.bevel ?? 0.22;
    const radius = curve > 0.02 ? o.width / (2 * Math.sin(curve * 0.5)) : 1e5;
    const cBase = toColor(o.color, new THREE.Color(1, 1, 1));
    const cEdge = toColor(o.edgeColor, cBase.clone().multiplyScalar(1.25));

    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];

    // Two shells (outer and inner) plus a skirt joining their rims.
    const ringVert = (shell: number, i: number, j: number): void => {
      const u = i / segs;
      const vv = j / rows;
      const w = lerp(1, taper, vv);
      const ang = (u - 0.5) * curve * w;
      const inset = shell === 0 ? 0 : thickness;
      const rr = radius - inset;
      // Bevel: pull the rim in and back near the border so the edge catches light.
      const edge = Math.min(
        1,
        Math.min(u, 1 - u) / Math.max(1e-4, bevel * 0.5),
      ) * Math.min(1, Math.min(vv, 1 - vv) / Math.max(1e-4, bevel * 0.5));
      const edgeK = smooth01(edge);
      const push = lerp(-thickness * 0.9, 0, edgeK);
      const x = Math.sin(ang) * (rr + push);
      const z = radius - Math.cos(ang) * (rr + push) - inset * 0.15;
      const y = (vv - 0.5) * o.height;
      pos.push(x, y, -z);
      uv.push(u * 1.2, vv * 1.2);
      const cc = _col.copy(cBase).lerp(cEdge, 1 - edgeK);
      col.push(cc.r, cc.g, cc.b);
    };

    const shellVerts = (segs + 1) * (rows + 1);
    for (let shell = 0; shell < 2; shell++) {
      for (let j = 0; j <= rows; j++) for (let i = 0; i <= segs; i++) ringVert(shell, i, j);
    }
    const quad = (a: number, b: number, c: number, d: number): void => {
      idx.push(a, b, c, a, c, d);
    };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i;
        quad(a, a + segs + 1, a + segs + 2, a + 1);
        const b = shellVerts + a;
        quad(b, b + 1, b + segs + 2, b + segs + 1);
      }
    }
    // Skirt around the border.
    const border: number[] = [];
    for (let i = 0; i <= segs; i++) border.push(i);
    for (let j = 1; j <= rows; j++) border.push(j * (segs + 1) + segs);
    for (let i = segs - 1; i >= 0; i--) border.push(rows * (segs + 1) + i);
    for (let j = rows - 1; j >= 1; j--) border.push(j * (segs + 1));
    for (let k = 0; k < border.length; k++) {
      const a = border[k];
      const b = border[(k + 1) % border.length];
      quad(a, b, shellVerts + b, shellVerts + a);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    basis(o.normal, o.up, _mat);
    _mat.setPosition(o.centre);
    geo.applyMatrix4(_mat);
    return ensureStandard(geo);
  }

  /** A domed shell — thorax, skull cap, back carapace. Ridged if you ask. */
  carapace(o: CarapaceOptions): THREE.BufferGeometry {
    const segs = this.seg(o.segments ?? 12, 6);
    const rows = Math.max(4, Math.round(segs * 0.6));
    const length = o.length ?? 1;
    const path: THREE.Vector3[] = [];
    const radii: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      // Half-ellipse profile with a slight overhang at the rim.
      const a = t * Math.PI * 0.5;
      path.push(new THREE.Vector3(0, Math.sin(a) * o.height, 0));
      radii.push(Math.cos(a * 0.98) * o.radius);
    }
    const geo = loft(path, {
      sides: segs,
      radius: radii,
      flatten: length,
      ridges: o.ridges ?? 0,
      ridgeDepth: o.ridgeDepth ?? 0.09,
      faceted: o.faceted ?? false,
      color: o.color,
      colorTip: o.colorTip,
      capStart: true,
      capEnd: true,
      cavity: 0.12,
      uvScale: 1.5,
    });
    if (o.direction) {
      _q.setFromUnitVectors(_a.set(0, 1, 0), _b.copy(o.direction).normalize());
      _mat.makeRotationFromQuaternion(_q).setPosition(o.centre);
    } else {
      _mat.identity().setPosition(o.centre);
    }
    geo.applyMatrix4(_mat);
    geo.computeVertexNormals();
    return geo;
  }

  /** A spike. Cheap, and the fastest way to break a rounded silhouette. */
  spine(o: SpineOptions): THREE.BufferGeometry {
    const steps = this.seg(6, 4);
    const dir = _a.copy(o.direction).normalize();
    const tip = new THREE.Vector3().copy(o.base).addScaledVector(dir, o.length);
    const axis = o.curveAxis ?? (Math.abs(dir.y) > 0.85 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0));
    const path = arcPath(o.base, tip, o.curve ?? o.length * 0.12, axis, steps);
    const sharp = o.sharpness ?? 2.2;
    return loft(path, {
      sides: this.seg(o.sides ?? 7, 4),
      radius: (t) => o.radius * Math.pow(1 - t, sharp) + 0.0015,
      faceted: true,
      color: o.color,
      colorTip: o.colorTip,
      capStart: true,
      capEnd: false,
      cavity: 0.25,
    });
  }

  /** A horn: longer, ridged, twisted, with a real curve. */
  horn(o: HornOptions): THREE.BufferGeometry {
    const steps = this.seg(10, 6);
    const dir = _a.copy(o.direction).normalize();
    const tip = new THREE.Vector3().copy(o.base).addScaledVector(dir, o.length);
    const axis = o.curveAxis ?? (Math.abs(dir.y) > 0.85 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0));
    const path = arcPath(o.base, tip, o.curve ?? o.length * 0.3, axis, steps);
    return loft(path, {
      sides: this.seg(o.sides ?? 9, 5),
      radius: (t) => o.radius * Math.pow(1 - t, o.sharpness ?? 1.5) * (1 + 0.12 * Math.cos(t * (o.ridges ?? 6) * TAU)) + 0.002,
      twist: o.twist ?? 0.6,
      ridges: 0,
      faceted: false,
      color: o.color,
      colorTip: o.colorTip,
      capStart: true,
      capEnd: false,
      cavity: 0.3,
    });
  }

  /** A curved, flattened blade that closes toward the centreline. */
  mandible(o: MandibleOptions): THREE.BufferGeometry {
    const steps = this.seg(9, 5);
    const dir = _a.copy(o.direction).normalize();
    const tip = new THREE.Vector3().copy(o.base).addScaledVector(dir, o.length);
    const path = arcPath(o.base, tip, o.length * 0.34, _b.copy(o.inward).normalize(), steps);
    const ser = o.serrations ?? 0;
    return loft(path, {
      sides: this.seg(8, 5),
      radius: (t) => {
        const base = o.thickness * (1 - Math.pow(t, 1.6) * 0.95) + 0.002;
        return ser > 0 ? base * (1 + 0.18 * Math.abs(Math.sin(t * ser * Math.PI))) : base;
      },
      flatten: o.flatten ?? 0.42,
      faceted: true,
      color: o.color,
      colorTip: o.colorTip,
      capStart: true,
      capEnd: false,
      cavity: 0.28,
    });
  }

  /** A finger/toe/claw: knuckled, curling, optionally tipped with a talon. */
  digit(o: DigitOptions): THREE.BufferGeometry {
    const joints = Math.max(2, o.joints ?? 3);
    const steps = this.seg(joints * 3 + 1, joints * 2);
    const dir = _a.copy(o.direction).normalize();
    const tip = new THREE.Vector3().copy(o.base).addScaledVector(dir, o.length);
    const axis = o.curlAxis ?? (Math.abs(dir.y) > 0.85 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, -1, 0));
    const path = arcPath(o.base, tip, (o.curl ?? 0.35) * o.length, axis, steps);
    const claw = o.claw ?? true;
    return loft(path, {
      sides: this.seg(7, 4),
      radius: (t) => {
        const knuckle = 1 + 0.24 * Math.abs(Math.cos(t * joints * Math.PI));
        const taper = claw ? Math.pow(1 - t, 0.55) : lerp(1, 0.7, t);
        return o.radius * knuckle * taper + 0.0015;
      },
      faceted: false,
      color: o.color,
      capStart: true,
      capEnd: !claw,
      cavity: 0.3,
    });
  }

  /**
   * An eye. A shallow dome with a bright core in the vertex colour, so one
   * emissive material gives both the glass and the glowing pupil.
   */
  lens(o: LensOptions): THREE.BufferGeometry {
    const segs = this.seg(o.segments ?? 12, 6);
    const rows = Math.max(3, Math.round(segs * 0.5));
    const bulge = o.bulge ?? 0.55;
    const path: THREE.Vector3[] = [];
    const radii: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const a = t * Math.PI * 0.5;
      path.push(new THREE.Vector3(0, 0, Math.sin(a) * o.radius * bulge));
      radii.push(Math.cos(a) * o.radius);
    }
    const geo = loft(path, {
      sides: segs,
      radius: radii,
      color: o.color ?? 0x8fd8ff,
      colorTip: o.coreColor ?? 0xffffff,
      capStart: false,
      capEnd: false,
      cavity: 0,
      uvScale: 1,
    });
    basis(o.normal, undefined, _mat);
    _mat.setPosition(o.centre);
    geo.applyMatrix4(_mat);
    geo.computeVertexNormals();
    return geo;
  }

  /** A recessed slotted grille. Reads as machinery even at 30 m. */
  vent(o: VentOptions): THREE.BufferGeometry {
    const slats = Math.max(2, Math.round((o.slats ?? 4) * clamp(this.detail, 0.6, 1.2)));
    const depth = o.depth ?? Math.min(o.width, o.height) * 0.4;
    const parts: THREE.BufferGeometry[] = [];
    const col = toColor(o.color, new THREE.Color(0.75, 0.75, 0.78));
    const dark = col.clone().multiplyScalar(0.35);

    // Recess: a shallow box pushed in, dark inside.
    parts.push(
      ensureStandard(
        loft(
          [new THREE.Vector3(0, 0, -depth), new THREE.Vector3(0, 0, 0)],
          {
            sides: 4,
            radius: [o.width * 0.42 * BOX_R, o.width * 0.5 * BOX_R],
            flatten: o.height / Math.max(1e-4, o.width),
            faceted: true,
            color: dark,
            colorTip: col,
            capStart: true,
            capEnd: false,
            phase: Math.PI * 0.25,
          },
        ),
      ),
    );
    for (let i = 0; i < slats; i++) {
      const y = ((i + 0.5) / slats - 0.5) * o.height * 0.86;
      const h = (o.height / slats) * 0.42;
      parts.push(
        ensureStandard(
          loft(
            [new THREE.Vector3(0, y, -depth * 0.45), new THREE.Vector3(0, y, -depth * 0.05)],
            {
              sides: 4,
              radius: [o.width * 0.44 * BOX_R, o.width * 0.44 * BOX_R],
              flatten: h / Math.max(1e-4, o.width * 0.44),
              faceted: true,
              color: col,
              capStart: false,
              capEnd: true,
              phase: Math.PI * 0.25,
            },
          ),
        ),
      );
    }
    const geo = mergeParts(parts);
    for (const p of parts) p.dispose();
    basis(o.normal, o.up, _mat);
    _mat.setPosition(o.centre);
    geo.applyMatrix4(_mat);
    geo.computeVertexNormals();
    return geo;
  }

  /** A hard-point: bracket, barrel and optional shroud, as one part. */
  weaponMount(o: WeaponMountOptions): THREE.BufferGeometry {
    const dir = new THREE.Vector3().copy(o.direction).normalize();
    const parts: THREE.BufferGeometry[] = [];
    const col = toColor(o.color, new THREE.Color(0.62, 0.65, 0.7));
    const bracket = o.bracket ?? o.radius * 2.2;

    if (bracket > 0) {
      parts.push(
        ensureStandard(
          loft(
            [
              new THREE.Vector3().copy(o.base).addScaledVector(dir, -bracket * 0.35),
              new THREE.Vector3().copy(o.base).addScaledVector(dir, bracket * 0.25),
            ],
            {
              sides: 6,
              radius: [bracket * 0.5, bracket * 0.42],
              faceted: true,
              color: col.clone().multiplyScalar(0.8),
              capStart: true,
              capEnd: true,
            },
          ),
        ),
      );
    }
    const muzzle = new THREE.Vector3().copy(o.base).addScaledVector(dir, o.length);
    parts.push(
      ensureStandard(
        loft(arcPath(o.base, muzzle, 0, dir, 5), {
          sides: this.seg(9, 6),
          radius: (t) => o.radius * (t > 0.86 ? 1.28 : lerp(1, 0.82, t)),
          faceted: false,
          color: col,
          capStart: true,
          capEnd: false,
          cavity: 0.2,
        }),
      ),
    );
    if (o.shroud ?? true) {
      const s0 = new THREE.Vector3().copy(o.base).addScaledVector(dir, o.length * 0.18);
      const s1 = new THREE.Vector3().copy(o.base).addScaledVector(dir, o.length * 0.52);
      parts.push(
        ensureStandard(
          loft(arcPath(s0, s1, 0, dir, 3), {
            sides: 6,
            radius: o.radius * 1.55,
            faceted: true,
            ridges: 6,
            ridgeDepth: 0.1,
            color: col.clone().multiplyScalar(0.9),
            capStart: true,
            capEnd: true,
          }),
        ),
      );
    }
    const geo = mergeParts(parts);
    for (const p of parts) p.dispose();
    return geo;
  }

  /** Dispose any geometry still queued (call only on an aborted build). */
  dispose(): void {
    for (const list of this.buckets.values()) for (const g of list) g.dispose();
    this.buckets.clear();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }
}

function smooth01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}
