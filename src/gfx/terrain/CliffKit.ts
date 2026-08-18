/**
 * CliffKit — real cliff-face geometry on the steep parts of the heightfield.
 *
 * A displaced heightmap can only ever produce ramps: every column has exactly
 * one surface, so a 70° slope is a smooth 70° ramp and the horizon reads as a
 * pile of dunes no matter how much noise you add. Destiny's cliffs are not
 * ramps — they are stacked slabs with vertical faces, horizontal ledges and a
 * top lip that juts out past the base. Those need geometry the heightfield
 * cannot express, so we generate it and drop it on top.
 *
 * Each face is anchored to the terrain it grows out of: the foot samples the
 * ground downhill, the crest samples the ground uphill, and the ends taper back
 * into the hillside so a cliff emerges from the slope instead of being parked on
 * it. The faces are merged into a few meshes and handed to the BVH, so they are
 * also the cover the player actually shoots from behind.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { applyUvScale } from '@/gfx/materials/ProceduralTexture';
import type { HeightField, TerrainCliffSpec } from './HeightField';
import { mergeGeometries } from './RockKit';
import { Rng, clamp, smoothstep } from '@/util/math';
import { createFrameBudget } from '@/util/async';
import { phase } from '@/util/profile';

interface CliffSite {
  x: number;
  z: number;
  /** Downhill unit direction in XZ. */
  dx: number;
  dz: number;
  slope: number;
  width: number;
  height: number;
}

/** Hash-based value noise on a 2-D lattice, for face detail only. */
function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const h = (px: number, py: number): number => {
    let v = ((Math.imul(px, 0x27d4eb2f) ^ Math.imul(py, 0x165667b1)) ^ seed) >>> 0;
    v = (v ^ (v >>> 15)) >>> 0;
    v = Math.imul(v, 0x2c1b3c6d) >>> 0;
    v = (v ^ (v >>> 12)) >>> 0;
    return v / 4294967296;
  };
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return (a + (b - a) * ux + (c + (d - c) * ux - (a + (b - a) * ux)) * uy) * 2 - 1;
}

function fbm2(x: number, y: number, oct: number, seed: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x * f, y * f, (seed + i * 6151) >>> 0);
    n += a;
    a *= 0.52;
    f *= 2.07;
  }
  return s / n;
}

export interface CliffBuildResult {
  /** Scene meshes, geometry already in world space. */
  meshes: THREE.Mesh[];
  /** The same meshes, for BVH registration. */
  colliders: THREE.Mesh[];
  faceCount: number;
  triangleCount: number;
}

export class CliffKit {
  readonly material: THREE.MeshStandardMaterial;
  private spec: TerrainCliffSpec;
  private field: HeightField;
  private owned: THREE.BufferGeometry[] = [];
  private ownedMaterials: THREE.Material[] = [];

  constructor(materials: MaterialLibrary, spec: TerrainCliffSpec, field: HeightField) {
    this.spec = spec;
    this.field = field;
    const set = materials.pbr(spec.surface);
    const mat = new THREE.MeshStandardMaterial({
      map: set.albedo,
      normalMap: set.normal,
      roughnessMap: set.orm,
      metalnessMap: set.orm,
      aoMap: set.orm,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.9,
    });
    mat.normalScale.setScalar(1.1);
    mat.envMap = materials.environment;
    applyUvScale(mat, 1 / spec.tileMetres);
    this.recolour(mat, spec.tint, spec.tintDesaturate);
    this.material = mat;
    this.ownedMaterials.push(mat);
  }

  /**
   * Find the steep sites and build faces. Yields between batches so the loading
   * bar keeps moving instead of the tab freezing.
   */
  async build(seed: number, onProgress?: (t: number) => void): Promise<CliffBuildResult> {
    const endSites = phase('cliff.findSites');
    const sites = await this.findSites(seed);
    endSites();
    const geos: THREE.BufferGeometry[] = [];
    const rng = new Rng((seed ^ 0x51ed270b) >>> 0);

    // Time-sliced rather than every-16-faces: face cost varies with width and
    // resolution, so a fixed count either yields far too often on small faces or
    // blocks for hundreds of ms on large ones.
    const endFaces = phase('cliff.faces');
    const budget = createFrameBudget(8);
    for (let i = 0; i < sites.length; i++) {
      geos.push(this.buildFace(sites[i], rng, (seed + i * 2749) >>> 0));
      onProgress?.(i / sites.length);
      await budget();
    }
    endFaces();
    onProgress?.(1);

    if (geos.length === 0) {
      return { meshes: [], colliders: [], faceCount: 0, triangleCount: 0 };
    }

    // Merge into buckets of ~24 faces. One giant mesh would make the BVH
    // build slow and every raycast walk the whole world; one mesh per face
    // would blow the draw-call budget. Buckets get both.
    const endMerge = phase('cliff.merge');
    const meshes: THREE.Mesh[] = [];
    const BUCKET = 24;
    let tris = 0;
    for (let i = 0; i < geos.length; i += BUCKET) {
      const slice = geos.slice(i, i + BUCKET);
      const merged = mergeGeometries(slice);
      tris += merged.getAttribute('position').count / 3;
      const mesh = new THREE.Mesh(merged, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `cliffBucket${i / BUCKET}`;
      meshes.push(mesh);
      this.owned.push(merged);
    }
    for (const g of geos) g.dispose();
    endMerge();

    return { meshes, colliders: meshes, faceCount: geos.length, triangleCount: tris };
  }

  // -- site selection -------------------------------------------------------

  /**
   * Macro slope, sampled over `MACRO_EPS` metres rather than the heightfield's
   * own 0.6 m normal epsilon.
   *
   * This distinction decides whether cliffs land anywhere sensible. The analytic
   * field's *local* slope spikes past 60 degrees all over the map from its finest
   * octaves, so selecting on it scattered cliff faces across gentle ground at
   * random. A cliff belongs on a hillside, and a hillside is a 20 m-scale
   * feature, so that is the scale the site test has to measure.
   */
  private macroSlope(x: number, z: number, out: THREE.Vector3): number {
    const e = 12;
    const f = this.field;
    const hx = (f.height(x + e, z) - f.height(x - e, z)) / (2 * e);
    const hz = (f.height(x, z + e) - f.height(x, z - e)) / (2 * e);
    out.set(-hx, 1, -hz).normalize();
    return Math.acos(clamp(out.y, -1, 1));
  }

  private async findSites(seed: number): Promise<CliffSite[]> {
    const s = this.spec;
    const n = new THREE.Vector3();
    // sitesPerHectare is per 100×100 m, so the sampling pitch is 100/sqrt(n).
    const pitch = clamp(100 / Math.sqrt(Math.max(s.sitesPerHectare, 0.01)), 8, 90);
    const rng = new Rng((seed ^ 0x2b7e1516) >>> 0);
    const accepted: CliffSite[] = [];
    const minGap = pitch * 0.82;
    const r = s.radius;

    // The scan is tens of thousands of candidates and each one costs four fBm
    // height evaluations, so it was the single longest uninterrupted block in the
    // whole level load — measured at 8.6 s, i.e. the tab looked crashed. It now
    // yields on a time budget between rows.
    const budget = createFrameBudget(8);

    // Rejecting candidates that sit within minGap of an already-accepted site was
    // a linear scan over `accepted`, i.e. O(n^2) over a list that reaches the low
    // thousands. A uniform hash grid with cells of exactly minGap means only the
    // 3x3 neighbourhood can contain a clashing site, which makes the test O(1).
    const cell = minGap;
    const buckets = new Map<number, CliffSite[]>();
    const key = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);
    const clashes = (px: number, pz: number): boolean => {
      const cx = Math.floor(px / cell);
      const cz = Math.floor(pz / cell);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = buckets.get(key(cx + dx, cz + dz));
          if (!list) continue;
          for (const a of list) {
            const ax = a.x - px;
            const az = a.z - pz;
            if (ax * ax + az * az < minGap * minGap) return true;
          }
        }
      }
      return false;
    };

    for (let z = -r; z <= r; z += pitch) {
      await budget();
      for (let x = -r; x <= r; x += pitch) {
        const px = x + rng.range(-pitch * 0.42, pitch * 0.42);
        const pz = z + rng.range(-pitch * 0.42, pitch * 0.42);
        if (px * px + pz * pz > r * r) continue;
        const slope = this.macroSlope(px, pz, n);
        if (slope < s.slopeThreshold) continue;

        const hl = Math.hypot(n.x, n.z);
        if (hl < 1e-4) continue;
        // Reject sites too close to an accepted one so faces do not interpenetrate.
        if (clashes(px, pz)) continue;

        // Steeper sites get taller faces — the cliff height follows the terrain's
        // own relief rather than being uniform street furniture.
        const steep = smoothstep((slope - s.slopeThreshold) / 0.55);
        const site: CliffSite = {
          x: px,
          z: pz,
          dx: n.x / hl,
          dz: n.z / hl,
          slope,
          width: rng.range(s.minWidth, s.maxWidth) * (0.8 + steep * 0.45),
          height: rng.range(s.minHeight, s.maxHeight) * (0.62 + steep * 0.62),
        };
        accepted.push(site);
        const bk = key(Math.floor(px / cell), Math.floor(pz / cell));
        const list = buckets.get(bk);
        if (list) list.push(site);
        else buckets.set(bk, [site]);
      }
    }
    if (accepted.length <= s.maxFaces) return accepted;
    // Thinning must not just truncate: the scan is in row order, so `slice()`
    // would put every cliff on the -Z side of the map. Striding keeps the
    // survivors spread across the whole terrain, and biasing the stride toward
    // the steepest sites keeps the most dramatic ones.
    accepted.sort((a, b) => b.slope - a.slope);
    const keep: CliffSite[] = [];
    const stride = accepted.length / s.maxFaces;
    for (let i = 0; keep.length < s.maxFaces && i < accepted.length; i++) {
      if (Math.floor(i / stride) === keep.length) keep.push(accepted[i]);
    }
    return keep;
  }

  // -- face construction ----------------------------------------------------

  /**
   * One cliff face. Grid of `COLS × ROWS` vertices in (contour, vertical)
   * parameter space, pushed out along the downhill direction by a profile that
   * is vertical in the middle, overhanging near the top, and tucked back into
   * the hill at the crest and at both ends.
   */
  private buildFace(site: CliffSite, rng: Rng, seed: number): THREE.BufferGeometry {
    const s = this.spec;
    const field = this.field;
    // 13 columns across a 40 m face is 3 m per column - too coarse to carry a
    // broken crest line, which is most of what makes a cliff read as rock
    // rather than as a slab.
    const COLS = 23;
    const ROWS = 11;

    // Contour tangent (perpendicular to downhill) and downhill vector.
    const dx = site.dx;
    const dz = site.dz;
    const tx = -dz;
    const tz = dx;
    /**
     * Horizontal depth of the shelf — the single number that decides whether
     * this reads as a cliff or as a flat brown decal stuck to a hillside.
     *
     * The face's vertical extent is not free: it is the terrain's own drop
     * between the crest sample and the foot sample. So to get an H-metre wall on
     * a slope of angle θ, the shelf has to be H/tan(θ) deep — the wall then
     * *replaces* that length of ramp with a vertical face, which is exactly what
     * a real cliff is. The first version picked depth from the requested height
     * directly, which on a 26° slope produced a 5 m drop over a 20 m shelf: a
     * near-horizontal quad lying on the ground.
     */
    const tanSlope = Math.max(Math.tan(site.slope), 0.12);
    const depth = clamp(site.height / tanSlope, 8, 90) * rng.range(0.86, 1.14);

    const pos = new Float32Array(COLS * ROWS * 3);
    const uv = new Float32Array(COLS * ROWS * 2);
    const index: number[] = [];

    // Ground heights along the contour at the foot and the crest.
    const footY = new Float32Array(COLS);
    const crestY = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) {
      const u = (c / (COLS - 1) - 0.5) * site.width;
      const fx = site.x + tx * u + dx * depth * 0.5;
      const fz = site.z + tz * u + dz * depth * 0.5;
      const kx = site.x + tx * u - dx * depth * 0.5;
      const kz = site.z + tz * u - dz * depth * 0.5;
      footY[c] = field.height(fx, fz);
      crestY[c] = field.height(kx, kz);
    }

    const overhang = s.overhang * rng.range(0.6, 1.25);
    const strataH = Math.max(0.9, s.strata * rng.range(2.2, 4.4));
    const fluteFreq = rng.range(0.1, 0.22);

    for (let c = 0; c < COLS; c++) {
      const cu = c / (COLS - 1);
      const u = (cu - 0.5) * site.width;
      // Ends taper: at |u| = width/2 the face is flush with the hillside.
      const endT = smoothstep(Math.min(cu, 1 - cu) / 0.22);
      const baseY = footY[c] - 3.2; // bed the foot below the ground

      /**
       * Break the crest line.
       *
       * Following the terrain's own crest smoothly gives a clean, near-straight
       * top edge, and that single silhouette cue is what made these read as dark
       * slabs pasted onto the hillside. Real cliff tops are notched: blocks calve
       * off along joints, leaving an uneven line with occasional deep clefts.
       * Both terms fade out with endT so the face stays watertight where it
       * merges back into the terrain.
       */
      const jag = fbm2(u * 0.085, 17.3, 3, (seed + 311) >>> 0);
      const cleftField = fbm2(u * 0.038, 41.7, 2, (seed + 733) >>> 0);
      const cleft = Math.max(0, cleftField - 0.18);
      const topY =
        crestY[c] +
        0.35 -
        (jag * 0.5 + 0.5) * site.height * 0.14 * endT -
        cleft * cleft * site.height * 0.55 * endT;
      const span = Math.max(topY - baseY, 1.2);

      for (let r = 0; r < ROWS; r++) {
        const v = r / (ROWS - 1);
        const y = baseY + span * v;

        // Horizontal travel from foot to crest. Near-zero for most of the face
        // (that is what makes it vertical), snapping back at the very top.
        let p = smoothstep((v - 0.74) / 0.26);
        // Overhang: bulge downhill through the upper-middle of the face.
        const bulge = Math.sin(Math.PI * clamp(v * 1.06, 0, 1));
        p -= (overhang / Math.max(depth, 0.5)) * bulge * bulge * endT;

        // Fluting + strata ledges, in metres along the downhill axis.
        const flute = fbm2(u * fluteFreq, y * fluteFreq * 1.7, 4, seed) * (depth * 0.16);
        const bandPhase = y / strataH + fbm2(u * 0.05, y * 0.02, 2, (seed + 91) >>> 0) * 0.5;
        const band = bandPhase - Math.floor(bandPhase);
        const ledge = (1 - smoothstep(band / 0.34)) * s.strata;
        const outward = (flute - ledge) * endT;

        // Blend the whole displacement away at the ends and at the crest so the
        // face is watertight against the terrain it grows from.
        const settle = 1 - smoothstep((v - 0.9) / 0.1);
        const travel = p + (1 - endT) * (1 - p);
        const ox = dx * (depth * (0.5 - travel) + outward * settle);
        const oz = dz * (depth * (0.5 - travel) + outward * settle);

        const i3 = (c * ROWS + r) * 3;
        pos[i3] = site.x + tx * u + ox;
        pos[i3 + 1] = y;
        pos[i3 + 2] = site.z + tz * u + oz;
        const i2 = (c * ROWS + r) * 2;
        // UVs in world metres so the strata texture lines up across faces.
        uv[i2] = u;
        uv[i2 + 1] = y;
      }
    }

    for (let c = 0; c < COLS - 1; c++) {
      for (let r = 0; r < ROWS - 1; r++) {
        const a = c * ROWS + r;
        const b = (c + 1) * ROWS + r;
        const cc = c * ROWS + r + 1;
        const d = (c + 1) * ROWS + r + 1;
        index.push(a, b, cc, cc, b, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();
    // Faces are one-sided shells; flipping to the outward winding is easier to
    // get right by testing the average normal against the downhill vector than
    // by reasoning about the parameterisation.
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    let sum = 0;
    for (let i = 0; i < nrm.count; i++) sum += nrm.getX(i) * dx + nrm.getZ(i) * dz;
    if (sum < 0) {
      const idx = geo.getIndex()!;
      const arr = idx.array as ArrayLike<number> & { [k: number]: number };
      for (let i = 0; i < idx.count; i += 3) {
        const t = arr[i + 1];
        arr[i + 1] = arr[i + 2];
        arr[i + 2] = t;
      }
      idx.needsUpdate = true;
      geo.computeVertexNormals();
    }
    // Non-indexed so the merge helper can concatenate without index rebasing.
    const flat = geo.toNonIndexed();
    geo.dispose();
    return flat;
  }

  /**
   * Luminance recolour, matching the terrain material's layer recolour so cliffs
   * and the strata layer they interrupt read as the same rock.
   *
   * `applyUvScale` already installed an `onBeforeCompile`; wrap it rather than
   * replace it, or the cliff UV tiling silently reverts to 1 m.
   */
  private recolour(mat: THREE.MeshStandardMaterial, tint: number, desat: number): void {
    const prev = mat.onBeforeCompile;
    const uTint = { value: new THREE.Vector3() };
    const c = new THREE.Color(tint).convertSRGBToLinear();
    uTint.value.set(c.r, c.g, c.b);
    const uDesat = { value: desat };
    mat.onBeforeCompile = (shader, renderer) => {
      prev?.call(mat, shader, renderer);
      shader.uniforms.uCliffTint = uTint;
      shader.uniforms.uCliffDesat = uDesat;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform vec3 uCliffTint;\nuniform float uCliffDesat;\nvoid main() {')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
             diffuseColor.rgb = mix( diffuseColor.rgb * uCliffTint,
                                     uCliffTint * ( 0.52 + lum * 1.55 ),
                                     uCliffDesat );
           }`,
        );
    };
    const key = `gfCliff:${tint}:${desat}:${mat.customProgramCacheKey()}`;
    mat.customProgramCacheKey = () => key;
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
  }
}
