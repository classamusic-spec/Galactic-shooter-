/**
 * TerrainBuilder — the clipmap, the ground material, and the five planet recipes.
 *
 * ## Geometry: one mesh, one draw call, no popping
 *
 * A concentric clipmap: a dense centre patch plus seven square annuli, each
 * double the cell size of the one inside it, **all sharing one snapped centre**.
 * Sharing the centre is the whole trick — every level's lattice is then a strict
 * subset of the level inside it, so ring boundaries land on identical world
 * positions and there is nothing to stitch. Because the levels never move
 * relative to each other, they can all live in a single static
 * `BufferGeometry` (lattice coordinates in `position`, cell size in
 * `aGfScale`) and the whole planet's terrain is **one draw call**.
 *
 * Popping is removed by vertex morphing, not by hiding the transition: as a
 * vertex approaches the outer edge of its ring, odd lattice indices slide
 * continuously onto the even ones. At the boundary the fine ring is sampling
 * exactly the coarse ring's lattice, so the LOD change has already finished
 * happening by the time it matters. Skirts on every ring boundary hang below the
 * surface and are invisible except at the outermost edge, where they hide the
 * gap against the sky.
 *
 * ## Material: triplanar, slope-and-height blended, still real PBR
 *
 * Four layers, each with its own baked albedo/normal/ORM set from the material
 * library, blended by slope and height windows whose thresholds are pushed
 * around by a noise field — that is what makes the transitions interlock like
 * geology instead of following smooth contour lines. The blend then runs through
 * a depth-style cut so the dominant layer stays crisp rather than muddied.
 *
 * It is built by patching `MeshStandardMaterial` through `onBeforeCompile`, so
 * cascaded shadows, IBL, fog and tone mapping all still apply — a bespoke
 * `ShaderMaterial` would have to reimplement every one of those and would look
 * worse for it.
 *
 * Cost control that matters on a fill-rate-bound machine:
 *  - Only the cliff layer is triplanar; the ground layers are XZ-planar, which
 *    is what triplanar *degenerates to* on near-horizontal ground anyway.
 *  - Layers whose weight rounds to nothing are branched out entirely.
 *  - Every noise field the fragment shader wants (macro tint drift, mask
 *    breakup, convexity occlusion) is evaluated per *vertex* and interpolated.
 *    Those fields are low-frequency by construction, so there is nothing to lose
 *    and a whole fBm per pixel to gain.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import type { PlanetId } from '@/types';
import { settings } from '@/core/Settings';
import { clamp } from '@/util/math';
import {
  HeightField,
  TERRAIN_GLSL_BODY,
  TERRAIN_GLSL_UNIFORMS,
  type TerrainDescriptor,
  type TerrainLayerSpec,
} from './HeightField';
import { CliffKit } from './CliffKit';
import { RockKit } from './RockKit';
import { FoliageKit } from './FoliageKit';
import { ScatterSystem, type ScatterProtoDef } from './ScatterSystem';
import { WaterPlane } from './WaterPlane';

export type {
  TerrainDescriptor,
  TerrainLayerSpec,
  TerrainCliffSpec,
  TerrainRockSpec,
  TerrainRockEntry,
  TerrainFloraSpec,
  TerrainFloraEntry,
  TerrainWaterSpec,
  RockKind,
  FloraKind,
} from './HeightField';
export { HeightField } from './HeightField';

export interface TerrainStats {
  /** Clipmap. */
  cells: number;
  levels: number;
  cellSize: number;
  terrainVertices: number;
  terrainTriangles: number;
  cliffFaces: number;
  cliffTriangles: number;
  /** Scatter. */
  scatterCandidates: number;
  scatterDrawCalls: number;
  colliderMeshes: number;
}

export interface TerrainResult {
  object: THREE.Object3D;
  heightField: HeightField;
  /** Cliffs, boulders, spires and arches — register these with the BVH. */
  colliders: THREE.Mesh[];
  bounds: THREE.Box3;
  dispose(): void;
  /** Extras beyond the required contract. */
  scatter: ScatterSystem;
  water: WaterPlane | null;
  stats: TerrainStats;
}

// ---------------------------------------------------------------------------
// Clipmap geometry
// ---------------------------------------------------------------------------

interface Lattice {
  pos: number[];
  scale: number[];
  skirt: number[];
  idx: number[];
}

/**
 * One level of the clipmap: a `cells × cells` lattice with an optional central
 * `hole × hole` region removed, plus a downward skirt on the outer boundary.
 * Positions are integer lattice coordinates; the shader multiplies by `aGfScale`.
 */
function addLevel(out: Lattice, cells: number, hole: number, cellSize: number, skirt: boolean): void {
  const half = cells / 2;
  const halfHole = hole / 2;
  const cache = new Map<number, number>();

  const vert = (gx: number, gz: number, isSkirt: number): number => {
    const key = (gx + 4096) * 33554432 + (gz + 4096) * 2 + isSkirt;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const id = out.pos.length / 3;
    out.pos.push(gx, 0, gz);
    out.scale.push(cellSize);
    out.skirt.push(isSkirt);
    cache.set(key, id);
    return id;
  };

  for (let gz = -half; gz < half; gz++) {
    for (let gx = -half; gx < half; gx++) {
      if (hole > 0 && gx >= -halfHole && gx + 1 <= halfHole && gz >= -halfHole && gz + 1 <= halfHole) {
        continue;
      }
      const a = vert(gx, gz, 0);
      const b = vert(gx + 1, gz, 0);
      const c = vert(gx, gz + 1, 0);
      const d = vert(gx + 1, gz + 1, 0);
      // Wound so the surface normal points +Y.
      out.idx.push(a, c, b, b, c, d);
    }
  }

  if (!skirt) return;

  // Walk the boundary counter-clockwise seen from above; for a tangent `t` the
  // outward normal is cross(up, t), which fixes the winding below.
  const strip = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
  ): void => {
    const a = vert(ax, az, 0);
    const b = vert(bx, bz, 0);
    const a2 = vert(ax, az, 1);
    const b2 = vert(bx, bz, 1);
    out.idx.push(a, a2, b2, a, b2, b);
  };
  for (let gx = -half; gx < half; gx++) strip(gx, -half, gx + 1, -half);
  for (let gz = -half; gz < half; gz++) strip(half, gz, half, gz + 1);
  for (let gx = half; gx > -half; gx--) strip(gx, half, gx - 1, half);
  for (let gz = half; gz > -half; gz--) strip(-half, gz, -half, gz - 1);
}

function buildClipmap(
  cells: number,
  levels: number,
  cellSize: number,
): { geometry: THREE.BufferGeometry; vertices: number; triangles: number } {
  const out: Lattice = { pos: [], scale: [], skirt: [], idx: [] };
  addLevel(out, cells, 0, cellSize, false);
  for (let l = 1; l < levels; l++) {
    addLevel(out, cells, cells / 2, cellSize * Math.pow(2, l), true);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  geo.setAttribute('aGfScale', new THREE.Float32BufferAttribute(out.scale, 1));
  geo.setAttribute('aGfSkirt', new THREE.Float32BufferAttribute(out.skirt, 1));
  geo.setIndex(out.idx);
  // The real positions are synthesised in the vertex shader, so the attribute
  // bounds are meaningless. Give shadow culling something generous instead.
  const reach = cellSize * cells * Math.pow(2, levels - 1);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), reach * 1.5);
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(-reach, -2000, -reach),
    new THREE.Vector3(reach, 2000, reach),
  );
  return { geometry: geo, vertices: out.pos.length / 3, triangles: out.idx.length / 3 };
}

// ---------------------------------------------------------------------------
// TerrainBuilder
// ---------------------------------------------------------------------------

const _camWorld = new THREE.Vector3();
/** Wall-clock fallback for the wind/wave phase when no sim clock is supplied. */
const _bootMs = typeof performance !== 'undefined' ? performance.now() : 0;

export class TerrainBuilder {
  private materials: MaterialLibrary;

  // Live state, valid after build().
  private field: HeightField | null = null;
  private uniforms: Record<string, THREE.IUniform> = {};
  private mesh: THREE.Mesh | null = null;
  private scatter: ScatterSystem | null = null;
  private water: WaterPlane | null = null;
  private foliage: FoliageKit | null = null;
  private snapStep = 1;

  constructor(materials: MaterialLibrary) {
    this.materials = materials;
  }

  async build(d: TerrainDescriptor, onProgress?: (t: number) => void): Promise<TerrainResult> {
    const prof = settings.profile;
    const report = (t: number): void => onProgress?.(clamp(t, 0, 1));
    report(0.01);

    const field = new HeightField(d);
    this.field = field;
    const uniforms = field.uniforms();
    this.uniforms = uniforms;

    const root = new THREE.Group();
    root.name = `terrain:${d.id}`;

    // -- clipmap -----------------------------------------------------------
    // `terrainDetail` moves the lattice resolution; the ring count is fixed so
    // the coverage is identical across tiers and only the triangle size changes.
    const cells = clamp(Math.round((52 * prof.terrainDetail) / 4) * 4, 16, 112);
    const levels = 8;
    const cellSize = d.viewDistance / (cells * Math.pow(2, levels - 1));
    this.snapStep = cellSize * 2;

    const clip = buildClipmap(cells, levels, cellSize);
    const material = this.buildTerrainMaterial(d, cells);
    const mesh = new THREE.Mesh(clip.geometry, material);
    mesh.name = 'terrainClipmap';
    mesh.frustumCulled = false;
    mesh.castShadow = d.castShadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // Shadow casters need the same displacement or the terrain shadows itself
    // from a flat plane.
    mesh.customDepthMaterial = this.buildTerrainDepthMaterial(cells);
    this.mesh = mesh;
    root.add(mesh);
    report(0.1);

    // -- cliffs ------------------------------------------------------------
    const cliffKit = new CliffKit(this.materials, d.cliffs, field);
    const cliffs = await cliffKit.build(d.seed, (t) => report(0.1 + t * 0.3));
    for (const m of cliffs.meshes) root.add(m);
    report(0.42);

    // -- prototypes --------------------------------------------------------
    const rockKit = new RockKit(this.materials, d.rocks);
    rockKit.build(d.seed);
    const foliage = new FoliageKit(this.materials, d.flora);
    foliage.build(d.seed);
    this.foliage = foliage;
    report(0.5);

    // -- scatter -----------------------------------------------------------
    const scatter = new ScatterSystem(field, {
      region: d.extent,
      gridPitch: 2.5,
      bucketSize: 30,
    });
    for (const entry of d.rocks.entries) {
      const protos = rockKit.prototypes(entry.kind);
      for (let i = 0; i < protos.length; i++) {
        const p = protos[i];
        const def: ScatterProtoDef = {
          id: `rock:${entry.kind}:${i}`,
          near: p.geometry,
          far: p.far,
          material: rockKit.material,
          density: entry.perHectare / 10000 / protos.length,
          minScale: entry.minScale,
          maxScale: entry.maxScale,
          maxSlope: entry.maxSlope,
          heightLo: entry.heightLo,
          heightHi: entry.heightHi,
          moistureLo: 0,
          moistureHi: 1,
          alignToNormal: entry.alignToNormal,
          tintA: entry.tintA,
          tintB: entry.tintB,
          distance: entry.distance,
          nearDistance: Math.min(entry.distance, 120),
          castShadow: entry.castShadow,
          collide: entry.collide,
          radius: d.rocks.radius,
          sink: entry.kind === 'scree' ? 0.02 : 0.06,
          useFoliageDensity: false,
          tilt: entry.kind === 'spire' || entry.kind === 'arch' ? 0.04 : 0.16,
        };
        scatter.add(def);
      }
    }
    for (const entry of d.flora.entries) {
      const protos = foliage.prototypes(entry.kind);
      for (let i = 0; i < protos.length; i++) {
        const p = protos[i];
        scatter.add({
          id: `flora:${entry.kind}:${i}`,
          near: p.near,
          far: p.far,
          material: p.material,
          depthMaterial: p.depthMaterial,
          density: entry.density / protos.length,
          minScale: entry.minScale,
          maxScale: entry.maxScale,
          maxSlope: entry.maxSlope,
          heightLo: entry.heightLo,
          heightHi: entry.heightHi,
          moistureLo: entry.moistureLo,
          moistureHi: entry.moistureHi,
          alignToNormal: entry.alignToNormal,
          tintA: entry.tintA,
          tintB: entry.tintB,
          distance: entry.distance,
          nearDistance: entry.nearDistance,
          castShadow: entry.castShadow,
          collide: false,
          radius: Math.min(d.extent, entry.distance * 1.6),
          sink: 0.03,
          useFoliageDensity: true,
          tilt: entry.kind === 'crystal' ? 0.22 : 0.05,
        });
      }
    }
    await scatter.build(d.seed, (t) => report(0.5 + t * 0.42));
    root.add(scatter.object);
    this.scatter = scatter;
    report(0.94);

    // -- water -------------------------------------------------------------
    let water: WaterPlane | null = null;
    if (d.water) {
      const segs = clamp(Math.round(96 * prof.terrainDetail), 32, 192);
      water = new WaterPlane(this.materials, field, d.water, uniforms, segs);
      root.add(water.mesh);
      this.water = water;
    }
    report(1);

    const range = field.range();
    const bounds = new THREE.Box3(
      new THREE.Vector3(-d.extent, range.min, -d.extent),
      new THREE.Vector3(d.extent, range.max, d.extent),
    );

    const colliders: THREE.Mesh[] = [...cliffs.colliders, ...scatter.colliders];
    const sc = scatter.stats;
    const stats: TerrainStats = {
      cells,
      levels,
      cellSize,
      terrainVertices: clip.vertices,
      terrainTriangles: clip.triangles,
      cliffFaces: cliffs.faceCount,
      cliffTriangles: cliffs.triangleCount,
      scatterCandidates: sc.candidates,
      scatterDrawCalls: sc.drawCalls,
      colliderMeshes: colliders.length,
    };

    const result: TerrainResult = {
      object: root,
      heightField: field,
      colliders,
      bounds,
      scatter,
      water,
      stats,
      dispose: () => {
        clip.geometry.dispose();
        material.dispose();
        (mesh.customDepthMaterial as THREE.Material | undefined)?.dispose();
        cliffKit.dispose();
        rockKit.dispose();
        foliage.dispose();
        scatter.dispose();
        water?.dispose();
        root.clear();
        this.field = null;
        this.mesh = null;
        this.scatter = null;
        this.water = null;
        this.foliage = null;
      },
    };
    return result;
  }

  /**
   * Per-frame: re-snap the clipmap centre, feed the camera to the shading and
   * culling passes, and advance the wind and wave clocks.
   *
   * `elapsed` is optional so this satisfies `update(camera)`; pass the engine's
   * simulation clock when you have it. Wind and waves are purely visual, which
   * is why an internal wall clock is an acceptable fallback here and would not be
   * for anything in `update()`.
   */
  update(camera: THREE.Camera, elapsed?: number): void {
    if (!this.field || !this.mesh) return;
    camera.getWorldPosition(_camWorld);
    const s = this.snapStep;
    const c = this.uniforms.uGfClipCenter?.value as THREE.Vector2 | undefined;
    if (c) c.set(Math.round(_camWorld.x / s) * s, Math.round(_camWorld.z / s) * s);
    const cp = this.uniforms.uGfCamPos?.value as THREE.Vector3 | undefined;
    if (cp) cp.copy(_camWorld);

    const t = elapsed ?? (performance.now() - _bootMs) / 1000;
    this.foliage?.update(t);
    this.water?.update(t, camera);
    this.scatter?.update(camera);
  }

  // -- terrain material -----------------------------------------------------

  private layerUniforms(d: TerrainDescriptor): Record<string, THREE.IUniform> {
    const layers: TerrainLayerSpec[] = d.layers.slice(0, 4);
    while (layers.length < 4) layers.push(layers[layers.length - 1]);
    const A: THREE.Vector4[] = [];
    const B: THREE.Vector4[] = [];
    const C: THREE.Vector4[] = [];
    const tint: THREE.Vector3[] = [];
    const tri = new Float32Array(4);
    for (let i = 0; i < 4; i++) {
      const l = layers[i];
      A.push(new THREE.Vector4(Math.max(l.tileMetres, 0.05), l.desaturate, l.roughness, l.metalness));
      B.push(new THREE.Vector4(l.slopeLo, l.slopeHi, l.heightLo, l.heightHi));
      C.push(new THREE.Vector4(Math.max(l.softness, 0.005), l.bias, l.breakup, l.normalStrength));
      const c = new THREE.Color(l.tint).convertSRGBToLinear();
      tint.push(new THREE.Vector3(c.r, c.g, c.b));
      tri[i] = l.triplanar ? 1 : 0;
    }
    const u: Record<string, THREE.IUniform> = {
      uGfLayerA: { value: A },
      uGfLayerB: { value: B },
      uGfLayerC: { value: C },
      uGfLayerTint: { value: tint },
      uGfTri: { value: tri },
      uGfContrast: { value: clamp(d.layerContrast, 0.5, 6) },
      uGfDistantTint: {
        value: (() => {
          const c = new THREE.Color(d.distantTint).convertSRGBToLinear();
          return new THREE.Vector3(c.r, c.g, c.b);
        })(),
      },
      uGfDistantFade: { value: new THREE.Vector2(d.distantFadeStart, d.distantFadeEnd) },
    };
    // NOTE: twelve layer samplers plus the environment map plus one shadow map
    // sits at fourteen of the sixteen fragment texture units WebGL2 guarantees.
    // If a level ever needs more than one shadow-casting light on the terrain,
    // fold the four ORM maps into a single packed atlas before adding lights.
    for (let i = 0; i < 4; i++) {
      const set = this.materials.pbr(layers[i].surface);
      u[`uGfA${i}`] = { value: set.albedo };
      u[`uGfN${i}`] = { value: set.normal };
      u[`uGfO${i}`] = { value: set.orm };
    }
    return u;
  }

  private vertexPrefix(cells: number): string {
    return /* glsl */ `
      ${TERRAIN_GLSL_UNIFORMS}
      ${TERRAIN_GLSL_BODY}
      attribute float aGfScale;
      attribute float aGfSkirt;
      uniform vec2  uGfClipCenter;
      uniform float uGfCells;
      uniform float uGfMorphStart;
      uniform float uGfSkirtDepth;
      uniform float uGfNormalEps;
      uniform vec3  uGfCamPos;

      varying vec3  vGfWorld;
      varying vec3  vGfNormal;
      varying float vGfSlope;
      varying float vGfConvex;
      varying vec2  vGfMacro;

      bool  gfDone = false;
      vec3  gfPosObj;
      vec3  gfNrmObj;

      void gfTerrainVertex(){
        if( gfDone ) return;
        gfDone = true;

        vec2 grid  = position.xz;
        float cs   = aGfScale;
        vec2 local = grid * cs;

        // Vertex morph. Every ring shares the clipmap centre, so a ring's even
        // lattice IS its parent's lattice; sliding odd indices onto even ones as
        // the outer edge approaches means the boundary is already coincident by
        // the time the LOD changes. No crack, no pop, no stitch geometry.
        float halfSpan = uGfCells * 0.5 * cs;
        float t = max( abs( local.x ), abs( local.y ) ) / max( halfSpan, 0.001 );
        float k = clamp( ( t - uGfMorphStart ) / ( 1.0 - uGfMorphStart ), 0.0, 1.0 );
        vec2 odd = fract( grid * 0.5 ) * 2.0;
        local -= odd * cs * k;

        vec2 world = uGfClipCenter + local;
        float h = gfHeight( world );

        // Forward differences, with the epsilon growing smoothly with view
        // distance. A fixed 0.6 m epsilon shades a 300 m-wide distant triangle
        // with 0.6 m detail, which aliases into a crawling pattern; growing it
        // with distance matches the shading frequency to the geometry the
        // clipmap actually has there. It is a function of distance, not of ring
        // level, so nothing pops at a boundary.
        float dist = distance( vec3( world.x, h, world.y ), uGfCamPos );
        float e  = clamp( dist * 0.025, uGfNormalEps, 28.0 );
        float hx = gfHeight( world + vec2( e, 0.0 ) );
        float hz = gfHeight( world + vec2( 0.0, e ) );
        vec3 n = normalize( vec3( -( hx - h ) / e, 1.0, -( hz - h ) / e ) );

        // Convexity against the smooth base form: negative in valleys, positive
        // on spurs. Drives large-scale occlusion, which is most of the value
        // structure in a landscape shot.
        float low = gfLowHeight( world );
        vGfConvex = clamp( ( h - low ) * 0.028, -1.0, 1.0 );

        vGfNormal = n;
        vGfSlope  = acos( clamp( n.y, -1.0, 1.0 ) );
        vGfWorld  = vec3( world.x, h, world.y );

        // Low-frequency fields the fragment shader needs, evaluated once per
        // vertex instead of once per pixel.
        //
        // The mask-breakup field MUST be band-limited to the local vertex
        // spacing. Sampling a 13 m noise on a ring whose cells are 32 m wide
        // aliases it, and because that value then displaces the layer *masks*,
        // the alias shows up as a structured moire of interlocking snow and rock
        // patches stamped across every distant mountain — by far the ugliest
        // artifact this material had. Lowering the frequency with distance keeps
        // it above Nyquist everywhere, and does it continuously so nothing pops.
        float bf = mix( 0.075, 0.007, smoothstep( 50.0, 620.0, dist ) );
        vGfMacro  = vec2(
          gfFbm( world * 0.0062, 3, 2.05, 0.5, uint( uGfSeed ) + 401u ),
          gfFbm( world * bf,     2, 2.11, 0.5, uint( uGfSeed ) + 503u ) );

        h -= aGfSkirt * uGfSkirtDepth;
        gfPosObj = vec3( world.x, h, world.y );
        gfNrmObj = n;
      }
    `;
  }

  private buildTerrainMaterial(d: TerrainDescriptor, cells: number): THREE.MeshStandardMaterial {
    const uniforms: Record<string, THREE.IUniform> = {
      ...this.uniforms,
      ...this.layerUniforms(d),
      uGfClipCenter: { value: new THREE.Vector2() },
      uGfCamPos: { value: new THREE.Vector3() },
      uGfCells: { value: cells },
      uGfMorphStart: { value: 0.72 },
      uGfSkirtDepth: { value: d.skirtDepth },
      uGfNormalEps: { value: 0.6 },
    };
    // Merge back so update() and the water plane see the same objects.
    Object.assign(this.uniforms, uniforms);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 1,
    });
    mat.envMap = this.materials.environment;

    const vert = this.vertexPrefix(cells);
    const frag = /* glsl */ `
      uniform sampler2D uGfA0, uGfN0, uGfO0;
      uniform sampler2D uGfA1, uGfN1, uGfO1;
      uniform sampler2D uGfA2, uGfN2, uGfO2;
      uniform sampler2D uGfA3, uGfN3, uGfO3;
      uniform vec4  uGfLayerA[4];
      uniform vec4  uGfLayerB[4];
      uniform vec4  uGfLayerC[4];
      uniform vec3  uGfLayerTint[4];
      uniform float uGfTri[4];
      uniform float uGfContrast;
      uniform vec3  uGfDistantTint;
      uniform vec2  uGfDistantFade;
      uniform vec3  uGfCamPos;

      varying vec3  vGfWorld;
      varying vec3  vGfNormal;
      varying float vGfSlope;
      varying float vGfConvex;
      varying vec2  vGfMacro;

      vec3  gfWp;
      vec3  gfGeoN;
      vec3  gfTriW;
      float gfDetail;
      vec3  gfAccAlb;
      vec3  gfAccNrm;
      float gfAccAo;
      float gfAccRough;
      float gfAccMetal;

      vec3  gfNormalW;
      float gfRough;
      float gfMetal;
      float gfAo;

      /**
       * Tangent-space normal into world space for a planar projection. The
       * projection axes are orthonormalised against the *geometric* normal, so a
       * detail normal on a 40 degree slope tilts with the slope instead of
       * flattening it — which is what a naive swizzle would do.
       */
      vec3 gfPlanarNormal( vec3 nts, vec3 aT, vec3 aB, float strength ){
        vec3 N = gfGeoN;
        vec3 T = normalize( aT - N * dot( N, aT ) );
        vec3 B = normalize( aB - N * dot( N, aB ) - T * dot( T, aB ) );
        return normalize( T * nts.x * strength + B * nts.y * strength + N * max( nts.z, 0.45 ) );
      }

      /**
       * Composite one layer over whatever is already accumulated.
       *
       * An earlier version normalised four weights and averaged them, which is
       * both harder to author (every layer's bias fights every other) and worse
       * looking (three weak layers wash the dominant one into grey mud). A
       * bottom-up over-composite is the splat-stack model artists actually
       * expect: layer 0 is the ground, each later layer paints over it by its
       * own mask, and nothing else has to be re-tuned when one mask changes.
       */
      void gfLayer( int i, sampler2D ta, sampler2D tn, sampler2D to, float w ){
        if( w <= 0.004 ) return;
        float inv   = 1.0 / uGfLayerA[i].x;
        float nstr  = uGfLayerC[i].w * gfDetail * 0.6;
        vec3 alb, nrm, orm;

        if( uGfTri[i] < 0.5 ){
          // Anti-tiling by domain warp, not by a second tap.
          //
          // Two failed attempts are worth recording: cross-fading a 1/4-scale tap
          // as albedo, and using its luminance as a value modulation. Both stamp
          // the *texture's own* macro structure at the coarse tile size, and the
          // rock recipe's crack network at 26 m reads as an interlocking maze
          // across an entire mountainside. A smooth UV offset driven by the
          // procedural macro field has no repeat of its own, costs no extra
          // fetch, and slides the tiling out of alignment with itself over a
          // ~160 m period, which is what actually kills the sense of repetition.
          vec2 uv = gfWp.xz * inv + vGfMacro * 1.15;
          alb = texture2D( ta, uv ).rgb;
          nrm = gfPlanarNormal( texture2D( tn, uv ).xyz * 2.0 - 1.0,
                                vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), nstr );
          orm = texture2D( to, uv ).rgb;
        } else {
          vec3 aA = vec3( 0.0 ), nA = vec3( 0.0 ), oA = vec3( 0.0 );
          float wsum = 0.0;
          if( gfTriW.y > 0.02 ){
            vec2 uv = gfWp.xz * inv + vGfMacro * 1.15;
            aA += texture2D( ta, uv ).rgb * gfTriW.y;
            nA += gfPlanarNormal( texture2D( tn, uv ).xyz * 2.0 - 1.0,
                                  vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), nstr ) * gfTriW.y;
            oA += texture2D( to, uv ).rgb * gfTriW.y;
            wsum += gfTriW.y;
          }
          if( gfTriW.x > 0.02 ){
            vec2 uv = gfWp.zy * inv;
            aA += texture2D( ta, uv ).rgb * gfTriW.x;
            nA += gfPlanarNormal( texture2D( tn, uv ).xyz * 2.0 - 1.0,
                                  vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), nstr ) * gfTriW.x;
            oA += texture2D( to, uv ).rgb * gfTriW.x;
            wsum += gfTriW.x;
          }
          if( gfTriW.z > 0.02 ){
            vec2 uv = gfWp.xy * inv;
            aA += texture2D( ta, uv ).rgb * gfTriW.z;
            nA += gfPlanarNormal( texture2D( tn, uv ).xyz * 2.0 - 1.0,
                                  vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), nstr ) * gfTriW.z;
            oA += texture2D( to, uv ).rgb * gfTriW.z;
            wsum += gfTriW.z;
          }
          wsum = max( wsum, 1e-4 );
          alb = aA / wsum;
          orm = oA / wsum;
          nrm = normalize( nA / wsum );
        }

        // Recolour. Multiplying a warm sand albedo by a cold hex gives warm
        // sand; to get snow the texture has to contribute contrast and the tint
        // has to contribute colour.
        float lum = dot( alb, vec3( 0.2126, 0.7152, 0.0722 ) );
        alb = mix( alb * uGfLayerTint[i],
                   uGfLayerTint[i] * ( 0.52 + lum * 1.55 ),
                   uGfLayerA[i].y );

        gfAccAlb   = mix( gfAccAlb,   alb, w );
        gfAccNrm   = mix( gfAccNrm,   nrm, w );
        gfAccAo    = mix( gfAccAo,    orm.r, w );
        gfAccRough = mix( gfAccRough, orm.g * uGfLayerA[i].z, w );
        gfAccMetal = mix( gfAccMetal, orm.b * uGfLayerA[i].w, w );
      }

      /**
       * Slope and height windows with noise-perturbed thresholds. Perturbing the
       * threshold rather than lerping the result is the difference between layers
       * that interlock like strata and layers that meet on a contour line.
       */
      float gfWeight( int i, float slope, float height, float n ){
        vec4 B = uGfLayerB[i];
        vec4 C = uGfLayerC[i];
        float sft = C.x;
        float sl  = slope  + n * C.z * 0.20;
        float hg  = height + n * C.z * 11.0;
        float ws = smoothstep( B.x - sft, B.x + sft, sl )
                 * ( 1.0 - smoothstep( B.y - sft, B.y + sft, sl ) );
        float wh = smoothstep( B.z - sft * 9.0, B.z + sft * 9.0, hg )
                 * ( 1.0 - smoothstep( B.w - sft * 9.0, B.w + sft * 9.0, hg ) );
        float w = clamp( ws * wh + C.y, 0.0, 1.0 );
        // Contrast on the mask itself: a wide, soft window still lands as a
        // reasonably decisive boundary, which is what geology looks like.
        return pow( w, uGfContrast );
      }
    `;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${vert}\nvoid main() {`)
        .replace(
          '#include <beginnormal_vertex>',
          'gfTerrainVertex();\n#include <beginnormal_vertex>\nobjectNormal = gfNrmObj;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = gfPosObj;');

      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${frag}\nvoid main() {`)
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          gfWp   = vGfWorld;
          gfGeoN = normalize( vGfNormal );

          float gfDist = distance( gfWp, uGfCamPos );
          gfDetail = 1.0 - smoothstep( uGfDistantFade.x, uGfDistantFade.y, gfDist );

          // Triplanar weights, sharpened so the projections do not smear into
          // each other across a whole 45 degree band.
          gfTriW = pow( abs( gfGeoN ), vec3( 5.0 ) );
          gfTriW /= max( gfTriW.x + gfTriW.y + gfTriW.z, 1e-4 );

          float n = vGfMacro.y;

          // Layer 0 is the unconditional ground; 1..3 paint over it.
          gfAccAlb = vec3( 0.0 );
          gfAccNrm = vec3( 0.0 );
          gfAccAo = 1.0;
          gfAccRough = 1.0;
          gfAccMetal = 0.0;
          gfLayer( 0, uGfA0, uGfN0, uGfO0, 1.0 );
          gfLayer( 1, uGfA1, uGfN1, uGfO1, gfWeight( 1, vGfSlope, gfWp.y, -n ) );
          gfLayer( 2, uGfA2, uGfN2, uGfO2, gfWeight( 2, vGfSlope, gfWp.y, n * 0.75 ) );
          gfLayer( 3, uGfA3, uGfN3, uGfO3, gfWeight( 3, vGfSlope, gfWp.y, -n * 0.6 ) );

          vec3 gfAlbedo = gfAccAlb;
          // Large-scale value and hue drift. Without this, a single tiled albedo
          // reads as wallpaper no matter how good the texture is.
          gfAlbedo *= mix( 0.66, 1.34, vGfMacro.x * 0.5 + 0.5 );
          gfAlbedo *= 1.0 + vec3( 0.06, 0.01, -0.05 ) * vGfMacro.y * 2.0;

          gfNormalW = length( gfAccNrm ) > 1e-4 ? normalize( gfAccNrm ) : gfGeoN;
          gfRough   = clamp( gfAccRough, 0.04, 1.0 );
          gfMetal   = clamp( gfAccMetal, 0.0, 1.0 );
          gfAo      = clamp( gfAccAo, 0.0, 1.0 );
          // Valleys occlude, spurs catch light.
          gfAo *= clamp( 0.74 + vGfConvex * 0.5, 0.42, 1.12 );

          // Aerial perspective on the ground itself: distance lifts the albedo
          // toward the atmosphere colour and flattens the detail, which is what
          // stops far terrain from sizzling with high-frequency noise.
          float gfFar = 1.0 - gfDetail;
          gfAlbedo  = mix( gfAlbedo, uGfDistantTint, gfFar * 0.6 );
          gfNormalW = normalize( mix( gfNormalW, gfGeoN, gfFar ) );
          gfRough   = mix( gfRough, 0.9, gfFar * 0.5 );

          diffuseColor.rgb *= gfAlbedo;
        `,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gfRough;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gfMetal;')
        .replace(
          '#include <normal_fragment_maps>',
          'normal = normalize( ( viewMatrix * vec4( gfNormalW, 0.0 ) ).xyz );',
        )
        .replace(
          '#include <aomap_fragment>',
          /* glsl */ `
          reflectedLight.indirectDiffuse *= gfAo;
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            float gfDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
            reflectedLight.indirectSpecular *= computeSpecularOcclusion( gfDotNV, gfAo, material.roughness );
          #endif
        `,
        );
    };
    mat.customProgramCacheKey = () => 'gfTerrain';
    return mat;
  }

  /** Depth pass with the identical displacement, so the terrain shadows itself. */
  private buildTerrainDepthMaterial(cells: number): THREE.MeshDepthMaterial {
    const uniforms = this.uniforms;
    const vert = this.vertexPrefix(cells);
    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${vert}\nvoid main() {`)
        .replace(
          '#include <begin_vertex>',
          'gfTerrainVertex();\n#include <begin_vertex>\ntransformed = gfPosObj;',
        );
    };
    mat.customProgramCacheKey = () => 'gfTerrainDepth';
    return mat;
  }
}

// ---------------------------------------------------------------------------
// Planet recipes
// ---------------------------------------------------------------------------

function layer(spec: Partial<TerrainLayerSpec> & Pick<TerrainLayerSpec, 'surface'>): TerrainLayerSpec {
  return {
    tileMetres: 4,
    tint: 0xffffff,
    desaturate: 0,
    roughness: 1,
    metalness: 0,
    normalStrength: 1,
    slopeLo: -1,
    slopeHi: 1.6,
    heightLo: -4000,
    heightHi: 4000,
    softness: 0.16,
    bias: 0,
    breakup: 0.4,
    triplanar: false,
    ...spec,
  };
}

/**
 * The five worlds. Each recipe is tuned as a *landscape*, not as a noise field:
 * a continental mask decides where relief is allowed, erosion decides where
 * detail collects, and the layer windows are set from the actual height range the
 * shape produces. Getting those three to agree is what makes terrain read as a
 * place rather than as a heightmap.
 */
export const TERRAIN_RECIPES: Record<PlanetId, TerrainDescriptor> = {
  // -- Aurvangr: tide-locked ice world, low raking sun, glacier shelves ------
  aurvangr: {
    id: 'aurvangr',
    seed: 0x31757,
    extent: 900,
    viewDistance: 5200,
    featureMetres: 1000,
    continentScale: 0.72,
    warp: 0.55,
    erosion: 1.1,
    ridgeOctaves: 7,
    ridgeLacunarity: 2.02,
    ridgeGain: 0.52,
    ridgePower: 2.1,
    mountainAmplitude: 330,
    plainAmplitude: 30,
    terraceStrength: 0.44,
    terraceHeight: 16,
    duneAmplitude: 1.5,
    duneWavelength: 27,
    duneAngle: 0.62,
    flattenRadius: 52,
    flattenHeight: 7,
    skirtDepth: 300,
    layerContrast: 1.6,
    castShadow: true,
    distantTint: 0x9cc2de,
    distantFadeStart: 180,
    distantFadeEnd: 1200,
    layers: [
      // Base: cold dark stone. Everything else is a deposit painted over it.
      layer({ surface: 'rock', tileMetres: 5, tint: 0x6b7380, desaturate: 0.5 }),
      // Wind-packed snow, thinning off the steep faces so rock shows through —
      // which is the whole silhouette language of a snow mountain.
      // slopeHi was 0.34 (~19 deg), which confined snow to near-flat ground and
      // left every mountainside bare black rock on a world that is supposed to
      // be glaciated. Snow holds on far steeper faces than that; only the
      // genuinely vertical strata should stay exposed.
      layer({ surface: 'sand', tileMetres: 7, tint: 0xc4d2e2, desaturate: 0.94, normalStrength: 0.8, slopeHi: 0.95, softness: 0.20, breakup: 0.9 }),
      // Exposed glacier on the flat low shelves.
      layer({ surface: 'ice', tileMetres: 16, tint: 0x8fb4cf, desaturate: 0.68, roughness: 0.45, normalStrength: 0.6, slopeHi: 0.32, heightHi: 46, softness: 0.16, breakup: 0.8 }),
      // Cliff strata, triplanar so vertical faces are not smeared.
      layer({ surface: 'reptilianStone', tileMetres: 8, tint: 0x6e7988, desaturate: 0.7, slopeLo: 0.95, slopeHi: 1.9, softness: 0.13, breakup: 0.5, triplanar: true, normalStrength: 1.2 }),
    ],
    cliffs: {
      slopeThreshold: 0.46,
      sitesPerHectare: 5.5,
      maxFaces: 96,
      minHeight: 18,
      maxHeight: 62,
      minWidth: 16,
      maxWidth: 42,
      overhang: 3.6,
      strata: 0.85,
      surface: 'rock',
      tileMetres: 5.5,
      tint: 0xa8b6c6,
      tintDesaturate: 0.45,
      radius: 900,
    },
    rocks: {
      surface: 'rock',
      tileMetres: 4.2,
      radius: 880,
      entries: [
        { kind: 'boulder', perHectare: 4.5, minScale: 0.4, maxScale: 3.6, maxSlope: 0.98, heightLo: -400, heightHi: 4000, alignToNormal: 0.55, tintA: 0x7d8895, tintB: 0xe0e0e0, distance: 320, castShadow: true, collide: true, variants: 3 },
        { kind: 'slab', perHectare: 1.5, minScale: 0.7, maxScale: 2.1, maxSlope: 0.72, heightLo: -400, heightHi: 4000, alignToNormal: 0.8, tintA: 0x737b89, tintB: 0xe0e0e0, distance: 300, castShadow: true, collide: true, variants: 2 },
        { kind: 'spire', perHectare: 0.099, minScale: 1.1, maxScale: 3.0, maxSlope: 0.68, heightLo: -400, heightHi: 4000, alignToNormal: 0.2, tintA: 0x677180, tintB: 0xe0e0e0, distance: 560, castShadow: true, collide: true, variants: 2 },
        { kind: 'arch', perHectare: 0.018, minScale: 7, maxScale: 15, maxSlope: 0.42, heightLo: -400, heightHi: 4000, alignToNormal: 0.1, tintA: 0x6e7886, tintB: 0xe0e0e0, distance: 760, castShadow: true, collide: true, variants: 2 },
        { kind: 'scree', perHectare: 16, minScale: 0.4, maxScale: 1.1, maxSlope: 1.1, heightLo: -400, heightHi: 4000, alignToNormal: 0.9, tintA: 0x767f8b, tintB: 0xe0e0e0, distance: 130, castShadow: false, collide: false, variants: 3 },
      ],
    },
    flora: {
      windDirection: 0.35,
      windStrength: 0.13,
      gustScale: 26,
      gustSpeed: 9,
      entries: [
        { kind: 'crystal', density: 0.004, minScale: 0.35, maxScale: 1.15, maxSlope: 0.9, heightLo: -400, heightHi: 4000, moistureLo: 0, moistureHi: 1, tintA: 0x2c6890, tintB: 0x9bffff, stiffness: 0, distance: 260, nearDistance: 110, alignToNormal: 0.75, castShadow: true, variants: 3, emissive: 0x2e86c8, emissiveIntensity: 0.22 },
        { kind: 'grass', density: 0.55, minScale: 0.4, maxScale: 1.0, maxSlope: 0.8, heightLo: -400, heightHi: 140, moistureLo: 0.1, moistureHi: 1, tintA: 0x75826f, tintB: 0xfffff0, stiffness: 1, distance: 84, nearDistance: 38, alignToNormal: 0.7, castShadow: false, variants: 3, emissive: 0, emissiveIntensity: 0 },
      ],
    },
    water: {
      level: -8,
      shallow: 0x4d7f92,
      deep: 0x0b2733,
      foam: 0xd8ecf5,
      absorption: 6,
      foamDepth: 1.6,
      waveScale: 7,
      waveSpeed: 0.55,
      waveHeight: 0.16,
      fresnel: 0.02,
      glossiness: 1.0,
      emissive: 0,
      emissiveIntensity: 0,
      extent: 2600,
    },
  },

  // -- Zeta Reticuli IV: stripped grey mesa desert under a near-black sky ----
  'zeta-reticuli': {
    id: 'zeta-reticuli',
    seed: 0x5a657,
    extent: 900,
    viewDistance: 5600,
    featureMetres: 1150,
    continentScale: 0.6,
    warp: 0.42,
    erosion: 0.9,
    ridgeOctaves: 7,
    ridgeLacunarity: 2.06,
    ridgeGain: 0.52,
    ridgePower: 2.0,
    mountainAmplitude: 300,
    plainAmplitude: 38,
    // Heavy terracing is the entire silhouette language of this world.
    terraceStrength: 0.7,
    terraceHeight: 20,
    duneAmplitude: 2.3,
    duneWavelength: 36,
    duneAngle: 1.15,
    flattenRadius: 58,
    flattenHeight: 4,
    skirtDepth: 320,
    layerContrast: 1.5,
    castShadow: true,
    distantTint: 0x9a94a8,
    distantFadeStart: 220,
    distantFadeEnd: 1500,
    layers: [
      layer({ surface: 'rock', tileMetres: 4.5, tint: 0x605a54, desaturate: 0.74 }),
      layer({ surface: 'sand', tileMetres: 7.5, tint: 0x8d8779, desaturate: 0.86, normalStrength: 0.85, slopeHi: 0.4, softness: 0.14, breakup: 0.9 }),
      layer({ surface: 'concrete', tileMetres: 6, tint: 0x8d8a86, desaturate: 0.76, slopeHi: 0.18, heightHi: 26, softness: 0.12, breakup: 0.85 }),
      layer({ surface: 'obsidian', tileMetres: 9, tint: 0x4d4952, desaturate: 0.72, slopeLo: 0.9, slopeHi: 1.9, softness: 0.13, breakup: 0.5, triplanar: true, normalStrength: 1.25 }),
    ],
    cliffs: {
      slopeThreshold: 0.42,
      sitesPerHectare: 6.5,
      maxFaces: 128,
      minHeight: 20,
      maxHeight: 74,
      minWidth: 20,
      maxWidth: 55,
      overhang: 4.6,
      strata: 1.15,
      surface: 'rock',
      tileMetres: 6,
      tint: 0x8b8478,
      tintDesaturate: 0.72,
      radius: 900,
    },
    rocks: {
      surface: 'rock',
      tileMetres: 4.2,
      radius: 880,
      entries: [
        { kind: 'boulder', perHectare: 3.5, minScale: 0.4, maxScale: 3.6, maxSlope: 0.95, heightLo: -400, heightHi: 4000, alignToNormal: 0.5, tintA: 0x898273, tintB: 0xe0e0e0, distance: 320, castShadow: true, collide: true, variants: 3 },
        { kind: 'slab', perHectare: 2.5, minScale: 0.8, maxScale: 2.6, maxSlope: 0.68, heightLo: -400, heightHi: 4000, alignToNormal: 0.85, tintA: 0x81796d, tintB: 0xe0e0d4, distance: 320, castShadow: true, collide: true, variants: 3 },
        { kind: 'spire', perHectare: 0.272, minScale: 1.1, maxScale: 3.0, maxSlope: 0.78, heightLo: -400, heightHi: 4000, alignToNormal: 0.15, tintA: 0x797163, tintB: 0xe0dec5, distance: 640, castShadow: true, collide: true, variants: 3 },
        { kind: 'arch', perHectare: 0.022, minScale: 7, maxScale: 15, maxSlope: 0.38, heightLo: -400, heightHi: 4000, alignToNormal: 0.08, tintA: 0x7d7668, tintB: 0xe0e0ca, distance: 860, castShadow: true, collide: true, variants: 2 },
        { kind: 'scree', perHectare: 20, minScale: 0.4, maxScale: 1.3, maxSlope: 1.05, heightLo: -400, heightHi: 4000, alignToNormal: 0.9, tintA: 0x8b8374, tintB: 0xe0e0d4, distance: 145, castShadow: false, collide: false, variants: 3 },
      ],
    },
    flora: {
      windDirection: 1.1,
      windStrength: 0.11,
      gustScale: 30,
      gustSpeed: 11,
      entries: [
        { kind: 'grass', density: 0.3, minScale: 0.35, maxScale: 0.85, maxSlope: 0.68, heightLo: -400, heightHi: 4000, moistureLo: 0, moistureHi: 1, tintA: 0x807560, tintB: 0xfff3b4, stiffness: 1, distance: 76, nearDistance: 34, alignToNormal: 0.72, castShadow: false, variants: 3, emissive: 0, emissiveIntensity: 0 },
        { kind: 'bush', density: 0.02, minScale: 0.5, maxScale: 1.2, maxSlope: 0.45, heightLo: -400, heightHi: 4000, moistureLo: 0.18, moistureHi: 1, tintA: 0x645e4e, tintB: 0xd3c488, stiffness: 0.6, distance: 160, nearDistance: 66, alignToNormal: 0.35, castShadow: true, variants: 3, emissive: 0, emissiveIntensity: 0 },
      ],
    },
    water: null,
  },

  // -- Khepri: vertical jungle over a corrosive floodplain ------------------
  khepri: {
    id: 'khepri',
    seed: 0x4b686,
    extent: 900,
    viewDistance: 4600,
    featureMetres: 820,
    continentScale: 0.8,
    warp: 0.62,
    erosion: 1.3,
    ridgeOctaves: 7,
    ridgeLacunarity: 2.04,
    ridgeGain: 0.54,
    ridgePower: 2.3,
    mountainAmplitude: 290,
    plainAmplitude: 32,
    terraceStrength: 0.12,
    terraceHeight: 9,
    duneAmplitude: 0,
    duneWavelength: 30,
    duneAngle: 0,
    flattenRadius: 46,
    flattenHeight: 9,
    skirtDepth: 280,
    layerContrast: 1.7,
    castShadow: true,
    distantTint: 0x8fbf72,
    distantFadeStart: 140,
    distantFadeEnd: 950,
    layers: [
      layer({ surface: 'rock', tileMetres: 4.2, tint: 0x51544a, desaturate: 0.72 }),
      layer({ surface: 'organic', tileMetres: 3.6, tint: 0x5f8034, desaturate: 0.8, slopeHi: 0.44, softness: 0.14, breakup: 0.9 }),
      layer({ surface: 'mantisResin', tileMetres: 5, tint: 0x9dc03c, desaturate: 0.76, roughness: 0.8, metalness: 0.1, slopeHi: 0.18, heightHi: 4, softness: 0.12, breakup: 0.9 }),
      layer({ surface: 'reptilianStone', tileMetres: 7.5, tint: 0x6d7656, desaturate: 0.7, slopeLo: 0.92, slopeHi: 1.9, softness: 0.13, breakup: 0.5, triplanar: true, normalStrength: 1.25 }),
    ],
    cliffs: {
      slopeThreshold: 0.5,
      sitesPerHectare: 6,
      maxFaces: 126,
      minHeight: 18,
      maxHeight: 66,
      minWidth: 14,
      maxWidth: 38,
      overhang: 4.2,
      strata: 0.7,
      surface: 'reptilianStone',
      tileMetres: 6.5,
      tint: 0x77805f,
      tintDesaturate: 0.72,
      radius: 900,
    },
    rocks: {
      surface: 'rock',
      tileMetres: 4.2,
      radius: 880,
      entries: [
        { kind: 'boulder', perHectare: 5.0, minScale: 0.4, maxScale: 3.6, maxSlope: 1.0, heightLo: -400, heightHi: 4000, alignToNormal: 0.6, tintA: 0x5d644c, tintB: 0xd8e0a6, distance: 300, castShadow: true, collide: true, variants: 3 },
        { kind: 'slab', perHectare: 1.2, minScale: 0.7, maxScale: 2.0, maxSlope: 0.72, heightLo: -400, heightHi: 4000, alignToNormal: 0.8, tintA: 0x555c47, tintB: 0xcad69c, distance: 280, castShadow: true, collide: true, variants: 2 },
        { kind: 'spire', perHectare: 0.223, minScale: 1.1, maxScale: 3.0, maxSlope: 0.64, heightLo: -400, heightHi: 4000, alignToNormal: 0.18, tintA: 0x525945, tintB: 0xc2cf96, distance: 520, castShadow: true, collide: true, variants: 2 },
        { kind: 'arch', perHectare: 0.018, minScale: 7, maxScale: 15, maxSlope: 0.42, heightLo: -400, heightHi: 4000, alignToNormal: 0.1, tintA: 0x585e4a, tintB: 0xc5d198, distance: 720, castShadow: true, collide: true, variants: 2 },
        { kind: 'scree', perHectare: 11, minScale: 0.35, maxScale: 1.0, maxSlope: 1.1, heightLo: -400, heightHi: 4000, alignToNormal: 0.9, tintA: 0x5b624a, tintB: 0xc5d198, distance: 120, castShadow: false, collide: false, variants: 3 },
      ],
    },
    flora: {
      windDirection: 2.1,
      windStrength: 0.2,
      gustScale: 42,
      gustSpeed: 7,
      entries: [
        { kind: 'grass', density: 1.8, minScale: 0.55, maxScale: 1.4, maxSlope: 0.68, heightLo: -400, heightHi: 4000, moistureLo: 0.2, moistureHi: 1, tintA: 0x3f7630, tintB: 0xffff7e, stiffness: 1, distance: 96, nearDistance: 42, alignToNormal: 0.72, castShadow: false, variants: 4, emissive: 0, emissiveIntensity: 0 },
        { kind: 'fern', density: 0.3, minScale: 0.7, maxScale: 1.8, maxSlope: 0.7, heightLo: -400, heightHi: 4000, moistureLo: 0.3, moistureHi: 1, tintA: 0x326825, tintB: 0xe0ff69, stiffness: 0.85, distance: 140, nearDistance: 60, alignToNormal: 0.55, castShadow: true, variants: 4, emissive: 0, emissiveIntensity: 0 },
        { kind: 'bush', density: 0.09, minScale: 0.8, maxScale: 2.0, maxSlope: 0.78, heightLo: -400, heightHi: 4000, moistureLo: 0.26, moistureHi: 1, tintA: 0x2c591c, tintB: 0xd1ff5f, stiffness: 0.6, distance: 200, nearDistance: 80, alignToNormal: 0.3, castShadow: true, variants: 3, emissive: 0, emissiveIntensity: 0 },
        { kind: 'tree', density: 0.02, minScale: 0.8, maxScale: 2.0, maxSlope: 0.64, heightLo: -400, heightHi: 4000, moistureLo: 0.26, moistureHi: 1, tintA: 0x4e8934, tintB: 0xffff81, stiffness: 0.35, distance: 560, nearDistance: 200, alignToNormal: 0.12, castShadow: true, variants: 4, emissive: 0, emissiveIntensity: 0 },
        { kind: 'reed', density: 0.5, minScale: 0.7, maxScale: 1.7, maxSlope: 0.42, heightLo: -400, heightHi: 7, moistureLo: 0.58, moistureHi: 1, tintA: 0x517e2c, tintB: 0xffff99, stiffness: 1, distance: 115, nearDistance: 50, alignToNormal: 0.4, castShadow: false, variants: 3, emissive: 0, emissiveIntensity: 0 },
      ],
    },
    water: {
      level: -4,
      shallow: 0x6f9a3a,
      deep: 0x14260c,
      foam: 0xd6e89a,
      absorption: 3.4,
      foamDepth: 2.1,
      waveScale: 5,
      waveSpeed: 0.42,
      waveHeight: 0.12,
      fresnel: 0.022,
      glossiness: 0.9,
      emissive: 0x9fd45f,
      emissiveIntensity: 0.35,
      extent: 2400,
    },
  },

  // -- Hive Prime: the crust is one nest ------------------------------------
  'hive-prime': {
    id: 'hive-prime',
    seed: 0x48697,
    extent: 900,
    viewDistance: 4400,
    featureMetres: 900,
    continentScale: 0.86,
    warp: 0.72,
    erosion: 1.1,
    ridgeOctaves: 7,
    ridgeLacunarity: 2.09,
    ridgeGain: 0.54,
    ridgePower: 2.4,
    mountainAmplitude: 210,
    plainAmplitude: 24,
    terraceStrength: 0,
    terraceHeight: 10,
    duneAmplitude: 0.9,
    duneWavelength: 19,
    duneAngle: 2.35,
    flattenRadius: 44,
    flattenHeight: 5,
    skirtDepth: 240,
    layerContrast: 1.6,
    castShadow: true,
    distantTint: 0xd09a52,
    distantFadeStart: 130,
    distantFadeEnd: 860,
    layers: [
      layer({ surface: 'organic', tileMetres: 3.4, tint: 0x4e3218, desaturate: 0.76 }),
      layer({ surface: 'chitin', tileMetres: 4.4, tint: 0xa8763a, desaturate: 0.74, roughness: 0.9, metalness: 0.12, slopeHi: 0.42, softness: 0.14, breakup: 0.85 }),
      layer({ surface: 'sand', tileMetres: 5.5, tint: 0xb08b4e, desaturate: 0.86, slopeHi: 0.2, softness: 0.13, breakup: 0.9 }),
      layer({ surface: 'hiveChitin', tileMetres: 6.5, tint: 0x8a5a2a, desaturate: 0.72, slopeLo: 0.88, slopeHi: 1.9, softness: 0.13, breakup: 0.55, triplanar: true, normalStrength: 1.3 }),
    ],
    cliffs: {
      slopeThreshold: 0.44,
      sitesPerHectare: 7,
      maxFaces: 132,
      minHeight: 14,
      maxHeight: 50,
      minWidth: 13,
      maxWidth: 34,
      overhang: 5.2,
      strata: 0.6,
      surface: 'hiveChitin',
      tileMetres: 5.5,
      tint: 0xa06c33,
      tintDesaturate: 0.68,
      radius: 900,
    },
    rocks: {
      surface: 'reptilianStone',
      tileMetres: 4.2,
      radius: 880,
      entries: [
        { kind: 'boulder', perHectare: 5.5, minScale: 0.4, maxScale: 3.6, maxSlope: 0.98, heightLo: -400, heightHi: 4000, alignToNormal: 0.6, tintA: 0x8b6135, tintB: 0xe0df84, distance: 300, castShadow: true, collide: true, variants: 3 },
        { kind: 'spire', perHectare: 0.495, minScale: 1.1, maxScale: 3.0, maxSlope: 0.7, heightLo: -400, heightHi: 4000, alignToNormal: 0.24, tintA: 0x7d552c, tintB: 0xe0d178, distance: 580, castShadow: true, collide: true, variants: 3 },
        { kind: 'arch', perHectare: 0.022, minScale: 7, maxScale: 15, maxSlope: 0.46, heightLo: -400, heightHi: 4000, alignToNormal: 0.12, tintA: 0x835a2f, tintB: 0xe0d87e, distance: 740, castShadow: true, collide: true, variants: 2 },
        { kind: 'slab', perHectare: 1.1, minScale: 0.7, maxScale: 1.9, maxSlope: 0.72, heightLo: -400, heightHi: 4000, alignToNormal: 0.8, tintA: 0x7b552a, tintB: 0xe0cf75, distance: 280, castShadow: true, collide: true, variants: 2 },
        { kind: 'scree', perHectare: 16, minScale: 0.35, maxScale: 1.1, maxSlope: 1.1, heightLo: -400, heightHi: 4000, alignToNormal: 0.9, tintA: 0x855c2e, tintB: 0xe0d67a, distance: 125, castShadow: false, collide: false, variants: 3 },
      ],
    },
    flora: {
      windDirection: 2.9,
      windStrength: 0.14,
      gustScale: 48,
      gustSpeed: 5,
      entries: [
        { kind: 'fungus', density: 0.028, minScale: 0.6, maxScale: 2.2, maxSlope: 0.72, heightLo: -400, heightHi: 4000, moistureLo: 0.08, moistureHi: 1, tintA: 0xaa602c, tintB: 0xffff99, stiffness: 0.25, distance: 480, nearDistance: 190, alignToNormal: 0.35, castShadow: true, variants: 4, emissive: 0xff9a3c, emissiveIntensity: 0.6 },
        { kind: 'grass', density: 0.75, minScale: 0.45, maxScale: 1.2, maxSlope: 0.78, heightLo: -400, heightHi: 4000, moistureLo: 0.1, moistureHi: 1, tintA: 0x805529, tintB: 0xfffa75, stiffness: 1, distance: 84, nearDistance: 36, alignToNormal: 0.72, castShadow: false, variants: 3, emissive: 0, emissiveIntensity: 0 },
        { kind: 'bush', density: 0.04, minScale: 0.6, maxScale: 1.6, maxSlope: 0.72, heightLo: -400, heightHi: 4000, moistureLo: 0.16, moistureHi: 1, tintA: 0x68461c, tintB: 0xffc257, stiffness: 0.55, distance: 180, nearDistance: 74, alignToNormal: 0.3, castShadow: true, variants: 3, emissive: 0, emissiveIntensity: 0 },
      ],
    },
    water: {
      level: -14,
      shallow: 0xc78a3a,
      deep: 0x2a1405,
      foam: 0xf0cf92,
      absorption: 2.6,
      foamDepth: 1.4,
      waveScale: 4,
      waveSpeed: 0.3,
      waveHeight: 0.08,
      fresnel: 0.03,
      glossiness: 0.7,
      emissive: 0xff9c3a,
      emissiveIntensity: 0.6,
      extent: 2200,
    },
  },

  // -- Draco IX: volcanic forge world --------------------------------------
  'draco-ix': {
    id: 'draco-ix',
    seed: 0x44726,
    extent: 900,
    viewDistance: 5400,
    featureMetres: 1050,
    continentScale: 0.66,
    warp: 0.5,
    erosion: 1.0,
    ridgeOctaves: 7,
    ridgeLacunarity: 2.03,
    ridgeGain: 0.53,
    ridgePower: 2.2,
    mountainAmplitude: 350,
    plainAmplitude: 30,
    terraceStrength: 0.4,
    terraceHeight: 19,
    duneAmplitude: 1.7,
    duneWavelength: 24,
    duneAngle: 2.7,
    flattenRadius: 50,
    flattenHeight: 6,
    skirtDepth: 340,
    layerContrast: 1.5,
    castShadow: true,
    distantTint: 0xc25a30,
    distantFadeStart: 200,
    distantFadeEnd: 1400,
    layers: [
      layer({ surface: 'rock', tileMetres: 4.2, tint: 0x5e3a2e, desaturate: 0.76 }),
      layer({ surface: 'sand', tileMetres: 6.5, tint: 0x4c4446, desaturate: 0.86, normalStrength: 0.85, slopeHi: 0.4, softness: 0.14, breakup: 0.9 }),
      layer({ surface: 'obsidian', tileMetres: 8, tint: 0x2e2a2e, desaturate: 0.8, roughness: 0.7, metalness: 0.2, slopeHi: 0.2, heightHi: 16, softness: 0.13, breakup: 0.9 }),
      layer({ surface: 'obsidian', tileMetres: 5, tint: 0x3f3538, desaturate: 0.74, slopeLo: 0.88, slopeHi: 1.9, softness: 0.13, breakup: 0.5, triplanar: true, normalStrength: 1.35 }),
    ],
    cliffs: {
      slopeThreshold: 0.44,
      sitesPerHectare: 6.5,
      maxFaces: 128,
      minHeight: 19,
      maxHeight: 72,
      minWidth: 17,
      maxWidth: 48,
      overhang: 4.8,
      strata: 1.05,
      surface: 'obsidian',
      tileMetres: 6,
      tint: 0x5b4a44,
      tintDesaturate: 0.72,
      radius: 900,
    },
    rocks: {
      surface: 'obsidian',
      tileMetres: 4.2,
      radius: 880,
      entries: [
        { kind: 'boulder', perHectare: 4.5, minScale: 0.4, maxScale: 3.6, maxSlope: 0.98, heightLo: -400, heightHi: 4000, alignToNormal: 0.55, tintA: 0x4d4347, tintB: 0xcfa293, distance: 320, castShadow: true, collide: true, variants: 3 },
        { kind: 'slab', perHectare: 2.0, minScale: 0.8, maxScale: 2.4, maxSlope: 0.7, heightLo: -400, heightHi: 4000, alignToNormal: 0.85, tintA: 0x463c41, tintB: 0xc09789, distance: 320, castShadow: true, collide: true, variants: 3 },
        { kind: 'spire', perHectare: 0.371, minScale: 1.1, maxScale: 3.0, maxSlope: 0.8, heightLo: -400, heightHi: 4000, alignToNormal: 0.16, tintA: 0x40373d, tintB: 0xb48f82, distance: 640, castShadow: true, collide: true, variants: 3 },
        { kind: 'arch', perHectare: 0.018, minScale: 7, maxScale: 15, maxSlope: 0.4, heightLo: -400, heightHi: 4000, alignToNormal: 0.09, tintA: 0x453b40, tintB: 0xbb9385, distance: 820, castShadow: true, collide: true, variants: 2 },
        { kind: 'scree', perHectare: 22, minScale: 0.4, maxScale: 1.2, maxSlope: 1.05, heightLo: -400, heightHi: 4000, alignToNormal: 0.9, tintA: 0x4c4046, tintB: 0xbe9688, distance: 145, castShadow: false, collide: false, variants: 3 },
      ],
    },
    flora: {
      windDirection: 2.6,
      windStrength: 0.12,
      gustScale: 28,
      gustSpeed: 10,
      entries: [
        { kind: 'grass', density: 0.26, minScale: 0.35, maxScale: 0.8, maxSlope: 0.68, heightLo: -400, heightHi: 4000, moistureLo: 0, moistureHi: 1, tintA: 0x60443b, tintB: 0xd4966d, stiffness: 1, distance: 74, nearDistance: 32, alignToNormal: 0.72, castShadow: false, variants: 3, emissive: 0, emissiveIntensity: 0 },
        { kind: 'crystal', density: 0.01, minScale: 0.35, maxScale: 1.2, maxSlope: 0.7, heightLo: -400, heightHi: 4000, moistureLo: 0, moistureHi: 1, tintA: 0x433030, tintB: 0xff804b, stiffness: 0, distance: 280, nearDistance: 110, alignToNormal: 0.75, castShadow: true, variants: 3, emissive: 0xff5b22, emissiveIntensity: 0.45 },
      ],
    },
    water: {
      level: -12,
      shallow: 0xd6551f,
      deep: 0x2a0a04,
      foam: 0xffb45c,
      absorption: 1.6,
      foamDepth: 2.4,
      waveScale: 9,
      waveSpeed: 0.18,
      waveHeight: 0.1,
      fresnel: 0.05,
      glossiness: 0.55,
      emissive: 0xff6a1e,
      emissiveIntensity: 2.6,
      extent: 2600,
    },
  },
};

/** Look up a recipe, falling back to the ice world for unknown ids. */
export function terrainRecipe(id: PlanetId): TerrainDescriptor {
  return TERRAIN_RECIPES[id] ?? TERRAIN_RECIPES.aurvangr;
}
