/**
 * WeaponMeshes — every weapon in the game, built from BufferGeometry maths.
 *
 * Design language (Federation): angular chamfered plates, exposed mechanics,
 * a cyan emissive spine running the length of the receiver, machined trim on
 * the moving parts, and gold accents reserved for exotics. Every model has to
 * be identifiable *as a black shape*, so each family gets one dominant
 * silhouette cue:
 *
 *   autoRifle       carry-handle optic + vented triangular handguard
 *   pulseRifle      bullpup wedge, over-under twin barrels
 *   scoutRifle      very long thin barrel + tube scope with a sun shade
 *   handCannon      fat exposed revolver cylinder + underlug
 *   sidearm         tiny slab slide, no stock
 *   submachineGun   stubby body, fat drum, folding wire stock
 *   shotgun         under-barrel tube magazine + pump grip
 *   sniperRifle     huge scope, bipod, bolt handle out to the right
 *   fusionRifle     stack of charge coils around a central rod
 *   rocketLauncher  wide smooth tube with fore/aft apertures
 *   grenadeLauncher revolver drum + ladder sight
 *   machineGun      belt box, top cover, bipod
 *   bow             riser + recurve limbs + string, no receiver at all
 *   traceRifle      prism emitter head with a caged focus crystal
 *
 * Everything static is merged per material, so a weapon costs 5-7 draw calls
 * plus one per animated part. Nothing here allocates after `build`.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WeaponFamily, WeaponStats } from '@/types';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { standardFromPbr } from '@/gfx/materials/ProceduralTexture';
import { ELEMENT_COLOR } from './WeaponDefs';

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export type WeaponMaterialKey =
  | 'hull'
  | 'panel'
  | 'trim'
  | 'dark'
  | 'glass'
  | 'glow'
  | 'element'
  | 'gold';

export interface WeaponMaterials {
  readonly slots: Record<WeaponMaterialKey, THREE.Material>;
  dispose(): void;
}

/**
 * Build a private material set for the view model.
 *
 * These deliberately do NOT come from `MaterialLibrary.get()` — those instances
 * are shared with the world and the view model needs to install its own
 * narrow-FOV projection via `decorate`, which would corrupt every other user of
 * the material. The baked PBR texture sets are shared (they are GPU-only render
 * targets and must not be cloned); only the material wrappers are new.
 */
export function createWeaponMaterials(
  lib: MaterialLibrary | null,
  elementColor: number,
  decorate?: (m: THREE.Material) => void,
): WeaponMaterials {
  const owned: THREE.Material[] = [];

  /**
   * Machined metal.
   *
   * Deliberately keeps only the *normal* map from the baked set. The library's
   * albedo/ORM maps are authored for architecture — metre-scale panel grids and
   * weld seams — and on a 5 cm receiver 30 cm from the eye they alias into
   * black-and-white corduroy. What a weapon actually needs from a texture is
   * micro-relief for the specular to break up on; colour, roughness and
   * metalness are authored per part instead. The chamfered silhouette and the
   * IBL do the rest of the work.
   */
  const machined = (
    color: number,
    roughness: number,
    metalness: number,
    envMapIntensity: number,
    normalScale: number,
  ): THREE.MeshStandardMaterial => {
    let m: THREE.MeshStandardMaterial;
    if (lib) {
      m = standardFromPbr(lib.pbr('greyAlloy'), {
        repeat: 1,
        color,
        roughness,
        metalness,
        normalScale,
        envMapIntensity,
      });
      m.map = null;
      m.roughnessMap = null;
      m.metalnessMap = null;
      // aoMap reads the uv1 channel, which the view model does not author.
      m.aoMap = null;
      m.envMap = lib.environment;
    } else {
      m = new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity });
    }
    owned.push(m);
    return m;
  };

  const emissive = (color: number, intensity: number): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({
      color: 0x05070a,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 0.34,
      metalness: 0,
    });
    if (lib) m.envMap = lib.environment;
    owned.push(m);
    return m;
  };

  const slots: Record<WeaponMaterialKey, THREE.Material> = {
    // Primary structure: cold blued steel. Dark, because at metalness 1 the
    // albedo is the specular colour and a pale one reads as painted plastic.
    hull: machined(0x39414b, 0.52, 0.7, 0.95, 0.55),
    // Secondary plates, one value step up so panel breaks read at a glance.
    panel: machined(0x59636f, 0.36, 0.85, 1.1, 0.45),
    // Machined bright metal: bolts, brakes, springs.
    trim: machined(0x9aa4ae, 0.18, 1, 1.5, 0.35),
    // Polymer grips, rubber, optic bodies — the only non-metal structure.
    dark: machined(0x0c0e11, 0.7, 0.05, 0.5, 0.9),
    glass: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x0a1a22,
        emissive: new THREE.Color(elementColor),
        emissiveIntensity: 0.5,
        roughness: 0.05,
        metalness: 0.4,
        transparent: true,
        opacity: 0.7,
      });
      if (lib) m.envMap = lib.environment;
      m.envMapIntensity = 2.4;
      owned.push(m);
      return m;
    })(),
    glow: emissive(0x2fd6ff, 3.4),
    element: emissive(elementColor, 3),
    gold: machined(0xc79a3d, 0.2, 1, 1.9, 0.35),
  };

  if (decorate) for (const m of owned) decorate(m);

  return {
    slots,
    dispose() {
      for (const m of owned) m.dispose();
      owned.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/** Rectangle with cut corners — the Federation profile in 2D. */
function cutRect(w: number, h: number, c: number): THREE.Shape {
  const x = w * 0.5;
  const y = h * 0.5;
  const k = Math.min(c, Math.min(x, y) * 0.85);
  const s = new THREE.Shape();
  s.moveTo(-x + k, -y);
  s.lineTo(x - k, -y);
  s.lineTo(x, -y + k);
  s.lineTo(x, y - k);
  s.lineTo(x - k, y);
  s.lineTo(-x + k, y);
  s.lineTo(-x, y - k);
  s.lineTo(-x, -y + k);
  s.closePath();
  return s;
}

/** Trapezoid profile — for wedged receivers and tapered stocks. */
function wedgeRect(wBottom: number, wTop: number, h: number, c: number): THREE.Shape {
  const yb = -h * 0.5;
  const yt = h * 0.5;
  const xb = wBottom * 0.5;
  const xt = wTop * 0.5;
  const k = Math.min(c, h * 0.4);
  const s = new THREE.Shape();
  s.moveTo(-xb + k, yb);
  s.lineTo(xb - k, yb);
  s.lineTo(xb, yb + k);
  s.lineTo(xt, yt - k);
  s.lineTo(xt - k, yt);
  s.lineTo(-xt + k, yt);
  s.lineTo(-xt, yt - k);
  s.lineTo(-xb, yb + k);
  s.closePath();
  return s;
}

const _shapeCache = new Map<string, THREE.BufferGeometry>();

/** Texel density for the view model's box projection, tiles per metre. */
const UV_DENSITY = 7.5;

const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _pc = new THREE.Vector3();
const _fn = new THREE.Vector3();

/**
 * Replace whatever UVs a primitive shipped with by a box projection in model
 * space.
 *
 * This matters more than it sounds: the baked PBR sets are shared, GPU-only
 * textures with a single per-material scale, and the primitives arrive with
 * wildly inconsistent parameterisations (ExtrudeGeometry uses raw world XY,
 * TorusGeometry uses angles, merged parts have none at all). Left alone the
 * result is speckled noise rather than brushed metal. A per-face box projection
 * gives every part the same, correct texel density with no seams that read at
 * view-model distance.
 */
function boxProjectUv(g: THREE.BufferGeometry, density = UV_DENSITY): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count % 3 !== 0) return;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 3) {
    _pa.fromBufferAttribute(pos, i);
    _pb.fromBufferAttribute(pos, i + 1);
    _pc.fromBufferAttribute(pos, i + 2);
    _fn.subVectors(_pc, _pb).cross(_pa.clone().sub(_pb));
    const nx = Math.abs(_fn.x);
    const ny = Math.abs(_fn.y);
    const nz = Math.abs(_fn.z);
    const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
    for (let k = 0; k < 3; k++) {
      const j = i + k;
      const px = pos.getX(j);
      const py = pos.getY(j);
      const pz = pos.getZ(j);
      const u = axis === 0 ? pz : px;
      const v = axis === 1 ? pz : py;
      uv[j * 2] = u * density;
      uv[j * 2 + 1] = v * density;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * Chamfered slab centred on the origin, extruded along Z. This is the workhorse
 * — the bevel is what makes the model catch a specular edge highlight instead
 * of reading as a grey box.
 */
function plate(w: number, h: number, d: number, chamfer?: number): THREE.BufferGeometry {
  const c = chamfer ?? Math.min(w, h) * 0.16;
  const key = `p${w.toFixed(4)},${h.toFixed(4)},${d.toFixed(4)},${c.toFixed(4)}`;
  const hit = _shapeCache.get(key);
  if (hit) return hit.clone();
  const bevel = Math.min(c * 0.75, d * 0.35);
  const g = new THREE.ExtrudeGeometry(cutRect(w, h, c), {
    depth: Math.max(1e-4, d - bevel * 2),
    bevelEnabled: bevel > 1e-5,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 1,
    steps: 1,
  });
  g.center();
  g.computeVertexNormals();
  _shapeCache.set(key, g);
  return g.clone();
}

/** Tapered slab: `wTop` narrower than `wBottom` gives the classic Fed wedge. */
function wedge(
  wBottom: number,
  wTop: number,
  h: number,
  d: number,
  chamfer = 0.006,
): THREE.BufferGeometry {
  const bevel = Math.min(chamfer * 0.75, d * 0.35);
  const g = new THREE.ExtrudeGeometry(wedgeRect(wBottom, wTop, h, chamfer), {
    depth: Math.max(1e-4, d - bevel * 2),
    bevelEnabled: bevel > 1e-5,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 1,
    steps: 1,
  });
  g.center();
  g.computeVertexNormals();
  return g;
}

/** Cylinder whose axis runs along Z (the weapon's forward axis). */
function rod(rTop: number, rBottom: number, len: number, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, len, seg, 1, false);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Open tube (no caps) along Z — barrel shrouds and scope bodies. */
function tube(r: number, len: number, seg = 12): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Torus ring around the Z axis — coils, muzzle brakes, barrel bands. */
function ring(r: number, thickness: number, seg = 14): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, thickness, 5, seg);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Placement {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number] | number;
}

const _m4 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function transformOf(pl: Placement | undefined): THREE.Matrix4 {
  _p.set(0, 0, 0);
  _e.set(0, 0, 0);
  _s.set(1, 1, 1);
  if (pl?.pos) _p.set(pl.pos[0], pl.pos[1], pl.pos[2]);
  if (pl?.rot) _e.set(pl.rot[0], pl.rot[1], pl.rot[2]);
  if (pl?.scale != null) {
    if (typeof pl.scale === 'number') _s.setScalar(pl.scale);
    else _s.set(pl.scale[0], pl.scale[1], pl.scale[2]);
  }
  _q.setFromEuler(_e);
  return _m4.compose(_p, _q, _s);
}

/** Accumulates geometry per material, then merges into one mesh per material. */
class Builder {
  private buckets = new Map<WeaponMaterialKey, THREE.BufferGeometry[]>();
  readonly root = new THREE.Group();
  readonly nodes: Record<string, THREE.Object3D> = {};
  readonly owned: THREE.BufferGeometry[] = [];

  constructor(private mats: WeaponMaterials) {}

  /** Add static geometry. Ownership transfers to the builder. */
  add(geo: THREE.BufferGeometry, mat: WeaponMaterialKey, pl?: Placement): void {
    geo.applyMatrix4(transformOf(pl));
    let b = this.buckets.get(mat);
    if (!b) this.buckets.set(mat, (b = []));
    b.push(geo);
  }

  /** Mirror a part across X — saves authoring both sides of every weapon. */
  addMirrored(geo: THREE.BufferGeometry, mat: WeaponMaterialKey, pl: Placement): void {
    this.add(geo.clone(), mat, pl);
    const p = pl.pos ?? [0, 0, 0];
    const r = pl.rot ?? [0, 0, 0];
    this.add(geo, mat, {
      ...pl,
      pos: [-p[0], p[1], p[2]],
      rot: [r[0], -r[1], -r[2]],
    });
  }

  /** A separately animatable part. Returns its group so callers can nest. */
  node(name: string, pl?: Placement): THREE.Group {
    const g = new THREE.Group();
    const t = transformOf(pl);
    t.decompose(g.position, g.quaternion, g.scale);
    g.name = name;
    this.root.add(g);
    this.nodes[name] = g;
    return g;
  }

  /** Attach geometry directly to an animated node (not merged). */
  addTo(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: WeaponMaterialKey, pl?: Placement): THREE.Mesh {
    geo.applyMatrix4(transformOf(pl));
    if (geo.getIndex()) {
      const flat = geo.toNonIndexed();
      geo.dispose();
      geo = flat;
    }
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    boxProjectUv(geo);
    const mesh = new THREE.Mesh(geo, this.mats.slots[mat]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    parent.add(mesh);
    this.owned.push(geo);
    return mesh;
  }

  /** An empty transform used as an anchor (muzzle tip, sight centre, …). */
  marker(name: string, pos: [number, number, number], rot?: [number, number, number]): THREE.Object3D {
    const o = new THREE.Object3D();
    o.position.set(pos[0], pos[1], pos[2]);
    if (rot) o.rotation.set(rot[0], rot[1], rot[2]);
    o.name = name;
    this.root.add(o);
    this.nodes[name] = o;
    return o;
  }

  finish(): void {
    for (const [key, list] of this.buckets) {
      if (list.length === 0) continue;
      // Normalise attributes so the merge cannot fail on a mismatched set.
      // Primitives arrive mixed: ExtrudeGeometry and OctahedronGeometry are
      // non-indexed, Cylinder/Torus/Circle/Sphere are indexed. `mergeGeometries`
      // refuses a mixture, so everything is flattened to non-indexed first.
      for (let i = 0; i < list.length; i++) {
        let g = list[i];
        if (g.getIndex()) {
          const flat = g.toNonIndexed();
          g.dispose();
          list[i] = g = flat;
        }
        for (const name of Object.keys(g.attributes)) {
          if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
        }
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        if (!g.getAttribute('uv')) {
          const count = g.getAttribute('position').count;
          g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
        }
      }
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) continue;
      if (merged !== list[0]) for (const g of list) g.dispose();
      boxProjectUv(merged);
      const mesh = new THREE.Mesh(merged, this.mats.slots[key]);
      mesh.name = key;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.owned.push(merged);
    }
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// Shared sub-assemblies
// ---------------------------------------------------------------------------

/** Picatinny-style rail: a base strip plus evenly spaced teeth. */
function rail(b: Builder, len: number, y: number, z: number, w = 0.021): void {
  b.add(plate(w, 0.006, len, 0.002), 'panel', { pos: [0, y, z] });
  const teeth = Math.max(3, Math.round(len / 0.024));
  for (let i = 0; i < teeth; i++) {
    const t = -len * 0.5 + (i + 0.5) * (len / teeth);
    b.add(plate(w * 0.92, 0.008, 0.008, 0.0018), 'panel', { pos: [0, y + 0.006, z + t] });
  }
}

/** Angled pistol grip with a chamfered backstrap and a trigger guard loop. */
function pistolGrip(b: Builder, x: number, y: number, z: number, tilt = 0.34): void {
  b.add(wedge(0.026, 0.032, 0.115, 0.044, 0.008), 'dark', {
    pos: [x, y - 0.055, z + 0.018],
    rot: [tilt, 0, 0],
  });
  // Beavertail + palm swell: without these a grip reads as a rectangular peg.
  b.add(wedge(0.03, 0.02, 0.028, 0.03, 0.006), 'hull', { pos: [x, y - 0.006, z + 0.03], rot: [tilt - 0.2, 0, 0] });
  b.addMirrored(plate(0.005, 0.055, 0.03, 0.004), 'panel', { pos: [x + 0.014, y - 0.052, z + 0.016], rot: [tilt, 0, 0] });
  // Finger swells: three small ridges on the front strap.
  for (let i = 0; i < 3; i++) {
    b.add(plate(0.028, 0.007, 0.012, 0.003), 'dark', {
      pos: [x, y - 0.032 - i * 0.024, z - 0.008 + i * 0.008],
      rot: [tilt, 0, 0],
    });
  }
  // Trigger guard: three straight segments instead of a torus (cheaper, and
  // the hard corners suit the faction language better).
  b.add(plate(0.012, 0.006, 0.052, 0.002), 'hull', { pos: [x, y - 0.052, z - 0.028] });
  b.add(plate(0.012, 0.03, 0.006, 0.002), 'hull', { pos: [x, y - 0.038, z - 0.052] });
  b.add(plate(0.008, 0.024, 0.005, 0.002), 'trim', { pos: [x, y - 0.03, z - 0.03], rot: [0.3, 0, 0] });
}

/** Vent slots cut as raised fins — reads as machined cooling at a glance. */
function vents(
  b: Builder,
  count: number,
  spacing: number,
  z0: number,
  y: number,
  x: number,
  w: number,
  h: number,
  mat: WeaponMaterialKey = 'panel',
): void {
  for (let i = 0; i < count; i++) {
    b.addMirrored(plate(w, h, 0.006, 0.0015), mat, { pos: [x, y, z0 + i * spacing] });
  }
}

/** The cyan spine: an emissive strip that runs the length of the receiver. */
function spine(
  b: Builder,
  len: number,
  y: number,
  z: number,
  x = 0.018,
  key: WeaponMaterialKey = 'glow',
): void {
  // Recessed channel first, then the bar inside it. A bare emissive strip reads
  // as a decal; a strip sitting in a shadowed groove reads as a lit component.
  b.addMirrored(plate(0.003, 0.014, len * 1.04, 0.001), 'dark', { pos: [x - 0.0015, y, z] });
  b.addMirrored(plate(0.004, 0.0085, len, 0.0012), key, { pos: [x, y, z] });
  // End caps stop the bar from looking like it was painted on.
  b.addMirrored(plate(0.005, 0.016, 0.008, 0.002), 'trim', { pos: [x, y, z - len * 0.5] });
  b.addMirrored(plate(0.005, 0.016, 0.008, 0.002), 'trim', { pos: [x, y, z + len * 0.5] });
}

/**
 * Scatter small raised chips along a run of receiver. Large flat planes are the
 * single biggest "cheap" tell on a hard-surface model; a handful of 4 mm plates
 * gives the specular something to break on and costs ~80 triangles.
 */
function greebles(
  b: Builder,
  count: number,
  z0: number,
  z1: number,
  y: number,
  x: number,
  seed = 0,
): void {
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const z = z0 + (z1 - z0) * t;
    const k = ((i * 37 + seed * 13) % 5) / 4;
    const w = 0.004 + k * 0.004;
    const h = 0.008 + (1 - k) * 0.016;
    b.addMirrored(plate(w, h, 0.012 + k * 0.02, 0.0015), i % 3 === 0 ? 'trim' : 'panel', {
      pos: [x, y + (k - 0.5) * 0.016, z],
    });
  }
}

/** Collapsible stock: two rails, a buffer tube and a chamfered butt plate. */
function stock(b: Builder, len: number, y: number, z: number): void {
  b.add(rod(0.017, 0.017, len * 0.8, 8), 'hull', { pos: [0, y, z + len * 0.4] });
  b.addMirrored(plate(0.006, 0.03, len * 0.9, 0.002), 'panel', { pos: [0.017, y, z + len * 0.45] });
  b.add(wedge(0.05, 0.032, 0.075, 0.018, 0.006), 'dark', { pos: [0, y - 0.005, z + len * 0.92] });
  b.add(plate(0.03, 0.03, 0.05, 0.004), 'dark', { pos: [0, y - 0.026, z + len * 0.5], rot: [0.32, 0, 0] });
}

/** Tube optic with a hood, two turrets, and an element-tinted lens. */
function scope(b: Builder, r: number, len: number, y: number, z: number, hood = true): THREE.Object3D {
  b.add(tube(r, len, 14), 'dark', { pos: [0, y, z] });
  // Open rings, not capped cylinders: at ADS the player is looking straight
  // down this tube and an end cap blanks the middle of the screen.
  b.add(tube(r * 1.22, 0.014, 14), 'hull', { pos: [0, y, z - len * 0.5 + 0.007] });
  b.add(tube(r * 1.18, 0.014, 14), 'hull', { pos: [0, y, z + len * 0.5 - 0.007] });
  if (hood) b.add(tube(r * 1.3, 0.05, 14), 'panel', { pos: [0, y, z - len * 0.5 - 0.02] });
  // Turrets.
  b.add(rod(0.011, 0.012, 0.02, 8), 'trim', { pos: [0, y + r + 0.008, z - 0.01], rot: [Math.PI / 2, 0, 0] });
  b.add(rod(0.01, 0.011, 0.018, 8), 'trim', { pos: [r + 0.007, y, z - 0.01], rot: [0, Math.PI / 2, 0] });
  // Objective lens, slightly recessed, and a lit crosshair just in front of the
  // ocular so the scope has something to aim with.
  b.add(new THREE.CircleGeometry(r * 0.86, 16), 'glass', { pos: [0, y, z - len * 0.5 + 0.016], rot: [0, Math.PI, 0] });
  b.add(new THREE.CircleGeometry(r * 0.7, 16), 'glass', { pos: [0, y, z + len * 0.5 - 0.02] });
  b.add(plate(0.0016, r * 1.25, 0.0012), 'element', { pos: [0, y, z + len * 0.5 - 0.009] });
  b.add(plate(r * 1.25, 0.0016, 0.0012), 'element', { pos: [0, y, z + len * 0.5 - 0.009] });
  b.add(plate(0.005, 0.005, 0.0012), 'element', { pos: [0, y, z + len * 0.5 - 0.008] });
  // Mounts.
  b.addMirrored(plate(0.008, 0.03, 0.016, 0.002), 'panel', { pos: [0.004, y - r - 0.012, z - len * 0.28] });
  b.addMirrored(plate(0.008, 0.03, 0.016, 0.002), 'panel', { pos: [0.004, y - r - 0.012, z + len * 0.28] });
  // Eye relief: the aim point sits behind the ocular, not inside the tube.
  return b.marker('sight', [0, y, z + len * 0.5 + 0.03]);
}

/**
 * Compact reflex sight.
 *
 * The aperture must stay *open*: aimed down the sights the player is looking
 * straight through this, so a solid front plate — however good it looks in a
 * turntable render — blanks the middle of the screen the moment they aim.
 * Frame, canted glass, floating reticle; nothing solid on the sight line.
 */
function reflexSight(b: Builder, y: number, z: number, size = 0.03): THREE.Object3D {
  b.add(plate(0.032, 0.01, 0.05, 0.003), 'hull', { pos: [0, y - size * 0.5, z] });
  b.addMirrored(plate(0.004, size, 0.05, 0.0015), 'hull', { pos: [0.017, y, z] });
  b.add(plate(0.04, 0.006, 0.052, 0.002), 'hull', { pos: [0, y + size * 0.5 + 0.002, z] });
  b.add(plate(0.026, size * 0.84, 0.0015), 'glass', { pos: [0, y, z + 0.008], rot: [-0.18, 0, 0] });
  // Reticle: a floating dot with a horizontal witness bar under it.
  b.add(plate(0.0032, 0.0032, 0.0012), 'element', { pos: [0, y, z + 0.005] });
  b.add(plate(0.013, 0.0014, 0.0012), 'element', { pos: [0, y - 0.007, z + 0.005] });
  b.add(plate(0.022, 0.0025, 0.004, 0.001), 'glow', { pos: [0, y + size * 0.5 + 0.005, z + 0.02] });
  return b.marker('sight', [0, y, z - 0.02]);
}

/** Muzzle device: a stepped brake with side ports and a machined crown. */
function muzzleBrake(b: Builder, r: number, z: number, ports = 3): void {
  b.add(rod(r * 1.5, r * 1.6, 0.045, 10), 'trim', { pos: [0, 0, z + 0.022] });
  for (let i = 0; i < ports; i++) {
    b.addMirrored(plate(0.004, r * 2.4, 0.006, 0.001), 'hull', {
      pos: [r * 1.45, 0, z + 0.01 + i * 0.012],
    });
  }
  b.add(ring(r * 1.5, 0.004, 10), 'trim', { pos: [0, 0, z + 0.044] });
}

/** Curved box magazine as an animatable node. */
function boxMag(
  b: Builder,
  w: number,
  h: number,
  d: number,
  pos: [number, number, number],
  tilt = 0.12,
): THREE.Group {
  const g = b.node('magazine', { pos, rot: [tilt, 0, 0] });
  b.addTo(g, plate(w, h * 0.86, d, 0.006), 'panel', { pos: [0, h * 0.07, 0] });
  // Floorplate and feed lips are the two silhouette cues that read as "magazine".
  b.addTo(g, plate(w * 1.16, h * 0.16, d * 1.1, 0.005), 'dark', { pos: [0, -h * 0.46, 0] });
  b.addTo(g, plate(w * 1.08, 0.01, d * 1.06, 0.003), 'hull', { pos: [0, h * 0.5 - 0.004, 0] });
  // Witness slots down the flank, with a lit round counter behind them.
  for (let i = 0; i < 3; i++) {
    b.addTo(g, plate(0.004, h * 0.12, d * 0.5, 0.0012), 'glow', {
      pos: [w * 0.52, h * 0.2 - i * h * 0.22, 0],
    });
    b.addTo(g, plate(0.004, h * 0.12, d * 0.5, 0.0012), 'glow', {
      pos: [-w * 0.52, h * 0.2 - i * h * 0.22, 0],
    });
  }
  b.addTo(g, plate(w * 1.04, h * 0.44, 0.006, 0.002), 'hull', { pos: [0, 0, -d * 0.5] });
  return g;
}

// ---------------------------------------------------------------------------
// Per-family builders
// ---------------------------------------------------------------------------

type FamilyBuilder = (b: Builder, exotic: boolean) => void;

const accent = (exotic: boolean): WeaponMaterialKey => (exotic ? 'gold' : 'trim');

const BUILDERS: Record<WeaponFamily, FamilyBuilder> = {
  // -- assault: long receiver, carry handle, triangular vented handguard -----
  autoRifle(b, ex) {
    b.add(wedge(0.05, 0.042, 0.078, 0.30, 0.008), 'hull', { pos: [0, 0.008, -0.02] });
    b.add(plate(0.052, 0.02, 0.20, 0.005), 'panel', { pos: [0, 0.048, -0.03] });
    spine(b, 0.20, 0.024, -0.03, 0.026);
    greebles(b, 5, -0.14, 0.10, 0.0, 0.027, 1);
    // Handguard — triangular, vented, with a canted foregrip.
    b.add(wedge(0.05, 0.03, 0.05, 0.20, 0.008), 'panel', { pos: [0, -0.006, -0.26] });
    vents(b, 5, 0.03, -0.33, -0.006, 0.026, 0.004, 0.03);
    b.add(wedge(0.026, 0.02, 0.075, 0.03, 0.005), 'dark', { pos: [0, -0.056, -0.28], rot: [-0.42, 0, 0] });
    // Barrel + gas block + brake.
    b.add(rod(0.0085, 0.0095, 0.22, 10), 'trim', { pos: [0, 0.006, -0.30] });
    b.add(plate(0.02, 0.024, 0.026, 0.004), 'hull', { pos: [0, 0.018, -0.34] });
    muzzleBrake(b, 0.009, -0.40);
    // Carry-handle optic: the silhouette cue.
    b.addMirrored(plate(0.006, 0.036, 0.02, 0.002), 'hull', { pos: [0.017, 0.074, -0.10] });
    b.addMirrored(plate(0.006, 0.036, 0.02, 0.002), 'hull', { pos: [0.017, 0.074, 0.03] });
    b.add(plate(0.044, 0.014, 0.19, 0.004), 'hull', { pos: [0, 0.09, -0.035] });
    reflexSight(b, 0.104, -0.06, 0.026);
    pistolGrip(b, 0, -0.012, 0.055);
    boxMag(b, 0.028, 0.115, 0.062, [0, -0.075, -0.045], 0.14);
    stock(b, 0.20, 0.012, 0.13);
    // Charging handle / bolt, animated.
    const bolt = b.node('bolt', { pos: [0.028, 0.03, 0.03] });
    b.addTo(bolt, plate(0.016, 0.014, 0.05, 0.003), accent(ex));
    b.addTo(bolt, plate(0.03, 0.01, 0.014, 0.003), accent(ex), { pos: [0.012, 0, 0.02] });
    b.marker('ejectPort', [0.03, 0.02, 0.0], [0, -0.5, 0.4]);
    b.marker('muzzle', [0, 0.006, -0.428]);
  },

  // -- pulse: bullpup wedge with over-under barrels --------------------------
  pulseRifle(b, ex) {
    b.add(wedge(0.056, 0.038, 0.12, 0.34, 0.01), 'hull', { pos: [0, 0.012, 0.03] });
    b.add(plate(0.058, 0.03, 0.16, 0.006), 'panel', { pos: [0, 0.052, 0.06] });
    // Three burst-cadence lamps down the flank.
    for (let i = 0; i < 3; i++) {
      b.addMirrored(plate(0.004, 0.012, 0.03, 0.0015), 'element', { pos: [0.029, 0.02, 0.06 + i * 0.042] });
    }
    spine(b, 0.24, -0.02, 0.02, 0.029);
    greebles(b, 5, -0.06, 0.16, 0.03, 0.030, 6);
    // Over-under twin barrels.
    b.add(rod(0.0075, 0.008, 0.30, 10), 'trim', { pos: [0, 0.028, -0.24] });
    b.add(rod(0.0075, 0.008, 0.30, 10), 'trim', { pos: [0, 0.004, -0.24] });
    b.add(plate(0.026, 0.05, 0.05, 0.006), 'hull', { pos: [0, 0.016, -0.13] });
    b.add(plate(0.03, 0.056, 0.03, 0.006), 'panel', { pos: [0, 0.016, -0.36] });
    b.add(ring(0.014, 0.004, 10), accent(ex), { pos: [0, 0.028, -0.385] });
    b.add(ring(0.014, 0.004, 10), accent(ex), { pos: [0, 0.004, -0.385] });
    // Front handguard + angled grip.
    b.add(wedge(0.044, 0.03, 0.05, 0.13, 0.007), 'panel', { pos: [0, -0.012, -0.20] });
    b.add(wedge(0.024, 0.018, 0.07, 0.028, 0.005), 'dark', { pos: [0, -0.058, -0.22], rot: [-0.5, 0, 0] });
    // Holographic sight on a low riser.
    b.add(plate(0.04, 0.012, 0.10, 0.004), 'hull', { pos: [0, 0.072, -0.02] });
    reflexSight(b, 0.092, -0.05, 0.03);
    pistolGrip(b, 0, -0.014, -0.06);
    // Bullpup magazine sits *behind* the grip.
    boxMag(b, 0.03, 0.10, 0.06, [0, -0.062, 0.075], -0.1);
    const bolt = b.node('bolt', { pos: [0.03, 0.036, 0.05] });
    b.addTo(bolt, plate(0.014, 0.012, 0.044, 0.003), accent(ex));
    b.marker('ejectPort', [0.031, 0.026, 0.03], [0, -0.5, 0.4]);
    b.marker('muzzle', [0, 0.016, -0.40]);
  },

  // -- scout: very long thin barrel, tube scope, cheek riser -----------------
  scoutRifle(b, ex) {
    b.add(wedge(0.046, 0.04, 0.07, 0.26, 0.008), 'hull', { pos: [0, 0.01, 0.02] });
    b.add(plate(0.048, 0.016, 0.18, 0.005), 'panel', { pos: [0, 0.046, 0.02] });
    spine(b, 0.16, 0.022, 0.0, 0.024);
    greebles(b, 4, -0.08, 0.10, 0.0, 0.025, 2);
    // 46 cm of exposed fluted barrel — the whole silhouette is this line.
    b.add(rod(0.0072, 0.0085, 0.42, 10), 'trim', { pos: [0, 0.008, -0.32] });
    for (let i = 0; i < 4; i++) {
      b.add(ring(0.011, 0.0028, 10), 'hull', { pos: [0, 0.008, -0.20 - i * 0.06] });
    }
    b.add(wedge(0.04, 0.026, 0.042, 0.13, 0.007), 'panel', { pos: [0, -0.004, -0.20] });
    vents(b, 4, 0.026, -0.245, -0.004, 0.021, 0.004, 0.024);
    muzzleBrake(b, 0.0085, -0.50, 4);
    // Long tube scope with sun shade.
    b.add(plate(0.04, 0.012, 0.14, 0.004), 'hull', { pos: [0, 0.062, -0.02] });
    scope(b, 0.023, 0.20, 0.09, -0.04);
    // Cheek riser + thumbhole stock.
    b.add(wedge(0.04, 0.03, 0.05, 0.12, 0.008), 'dark', { pos: [0, 0.036, 0.17] });
    b.add(plate(0.036, 0.06, 0.09, 0.008), 'dark', { pos: [0, -0.03, 0.19] });
    b.add(wedge(0.05, 0.034, 0.085, 0.02, 0.006), 'dark', { pos: [0, 0.0, 0.245] });
    pistolGrip(b, 0, -0.012, 0.075, 0.28);
    boxMag(b, 0.026, 0.085, 0.058, [0, -0.062, -0.012], 0.1);
    const bolt = b.node('bolt', { pos: [0.026, 0.028, 0.055] });
    b.addTo(bolt, rod(0.006, 0.006, 0.05, 8), accent(ex), { rot: [0, 1.2, 0] });
    b.addTo(bolt, new THREE.SphereGeometry(0.009, 8, 6), accent(ex), { pos: [0.022, 0, -0.012] });
    b.marker('ejectPort', [0.028, 0.022, 0.03], [0, -0.6, 0.4]);
    b.marker('muzzle', [0, 0.008, -0.528]);
  },

  // -- hand cannon: exposed revolver cylinder, underlug, gold (exotic) -------
  handCannon(b, ex) {
    b.add(wedge(0.032, 0.028, 0.062, 0.15, 0.007), 'hull', { pos: [0, 0.012, -0.02] });
    b.add(plate(0.034, 0.014, 0.10, 0.004), 'panel', { pos: [0, 0.044, -0.03] });
    // Cylinder: six chambers around a machined core. Animated (rotates on fire).
    const cyl = b.node('cylinder', { pos: [0, 0.006, 0.012] });
    b.addTo(cyl, rod(0.026, 0.026, 0.055, 12), accent(ex));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.addTo(cyl, rod(0.0068, 0.0068, 0.058, 8), 'dark', {
        pos: [Math.cos(a) * 0.0165, Math.sin(a) * 0.0165, 0],
      });
    }
    b.addTo(cyl, ring(0.026, 0.003, 12), 'trim', { pos: [0, 0, 0.028] });
    // Barrel with a heavy underlug and a compensator.
    b.add(rod(0.0105, 0.0115, 0.13, 10), 'trim', { pos: [0, 0.006, -0.10] });
    b.add(plate(0.024, 0.026, 0.12, 0.005), 'hull', { pos: [0, -0.012, -0.10] });
    for (let i = 0; i < 3; i++) {
      b.add(plate(0.026, 0.004, 0.008, 0.001), 'hull', { pos: [0, 0.02, -0.11 - i * 0.016] });
    }
    b.add(plate(0.03, 0.03, 0.024, 0.005), accent(ex), { pos: [0, 0.004, -0.162] });
    // Hammer and iron sights.
    const hammer = b.node('hammer', { pos: [0, 0.042, 0.048] });
    b.addTo(hammer, plate(0.008, 0.026, 0.014, 0.003), accent(ex));
    b.add(plate(0.014, 0.012, 0.006, 0.002), 'panel', { pos: [0, 0.05, -0.152] });
    b.add(plate(0.02, 0.012, 0.008, 0.002), 'panel', { pos: [0, 0.05, 0.028] });
    b.add(plate(0.004, 0.008, 0.005), 'glow', { pos: [0, 0.053, -0.152] });
    b.marker('sight', [0, 0.052, 0.028]);
    pistolGrip(b, 0, -0.012, 0.045, 0.42);
    b.add(plate(0.026, 0.05, 0.03, 0.005), 'dark', { pos: [0, -0.05, 0.062], rot: [0.42, 0, 0] });
    b.marker('ejectPort', [0.028, 0.006, 0.012], [0, -0.9, 0.2]);
    b.marker('muzzle', [0, 0.006, -0.178]);
  },

  // -- sidearm: tiny slab slide, no stock ------------------------------------
  sidearm(b, ex) {
    const slide = b.node('bolt', { pos: [0, 0.02, -0.03] });
    b.addTo(slide, wedge(0.028, 0.024, 0.038, 0.16, 0.005), 'hull');
    for (let i = 0; i < 5; i++) {
      b.addTo(slide, plate(0.03, 0.02, 0.004, 0.001), 'panel', { pos: [0, 0.004, 0.05 + i * 0.009] });
    }
    b.addTo(slide, plate(0.012, 0.008, 0.006, 0.002), 'panel', { pos: [0, 0.021, -0.072] });
    b.addTo(slide, plate(0.004, 0.005, 0.004), 'glow', { pos: [0, 0.024, -0.072] });
    b.addTo(slide, plate(0.005, 0.006, 0.03, 0.0012), 'element', { pos: [0.0145, 0.008, 0.0] });
    b.addTo(slide, plate(0.005, 0.006, 0.03, 0.0012), 'element', { pos: [-0.0145, 0.008, 0.0] });
    b.add(plate(0.03, 0.02, 0.13, 0.005), 'dark', { pos: [0, -0.004, -0.02] });
    b.add(rod(0.0055, 0.0055, 0.05, 8), 'trim', { pos: [0, 0.018, -0.11] });
    b.add(rod(0.012, 0.013, 0.014, 10), accent(ex), { pos: [0, 0.018, -0.128] });
    pistolGrip(b, 0, -0.008, 0.032, 0.36);
    boxMag(b, 0.022, 0.075, 0.036, [0, -0.048, 0.03], 0.36);
    b.add(plate(0.024, 0.016, 0.04, 0.003), 'hull', { pos: [0, 0.048, -0.02] });
    reflexSight(b, 0.064, -0.03, 0.02);
    b.marker('ejectPort', [0.017, 0.026, -0.02], [0, -0.6, 0.3]);
    b.marker('muzzle', [0, 0.018, -0.138]);
  },

  // -- SMG: stubby body, fat drum, folding wire stock ------------------------
  submachineGun(b, ex) {
    b.add(wedge(0.05, 0.04, 0.07, 0.20, 0.008), 'hull', { pos: [0, 0.006, -0.01] });
    b.add(plate(0.052, 0.016, 0.12, 0.004), 'panel', { pos: [0, 0.04, -0.02] });
    spine(b, 0.13, 0.014, -0.02, 0.026);
    greebles(b, 4, -0.08, 0.06, -0.008, 0.027, 8);
    b.add(wedge(0.042, 0.03, 0.042, 0.10, 0.006), 'panel', { pos: [0, -0.004, -0.16] });
    vents(b, 4, 0.022, -0.19, -0.004, 0.022, 0.004, 0.022);
    b.add(rod(0.008, 0.009, 0.13, 10), 'trim', { pos: [0, 0.004, -0.17] });
    b.add(rod(0.017, 0.018, 0.055, 12), 'hull', { pos: [0, 0.004, -0.225] });
    for (let i = 0; i < 4; i++) b.add(ring(0.018, 0.0028, 12), 'panel', { pos: [0, 0.004, -0.21 - i * 0.013] });
    // Drum: the read-at-a-glance cue.
    const mag = b.node('magazine', { pos: [0, -0.062, -0.02] });
    b.addTo(mag, rod(0.044, 0.044, 0.03, 16), 'dark', { rot: [0, Math.PI / 2, 0] });
    b.addTo(mag, ring(0.044, 0.004, 16), accent(ex), { rot: [0, Math.PI / 2, 0], pos: [0.015, 0, 0] });
    b.addTo(mag, plate(0.032, 0.006, 0.05, 0.002), 'glow', { pos: [0, 0.0, 0], rot: [0, 0, 0.6] });
    b.addTo(mag, plate(0.03, 0.05, 0.03, 0.004), 'dark', { pos: [0, 0.04, 0] });
    pistolGrip(b, 0, -0.01, 0.045, 0.3);
    // Folding wire stock.
    b.addMirrored(rod(0.005, 0.005, 0.13, 6), 'trim', { pos: [0.02, 0.006, 0.10] });
    b.add(plate(0.05, 0.03, 0.008, 0.003), 'dark', { pos: [0, 0.006, 0.165] });
    b.add(plate(0.03, 0.014, 0.05, 0.004), 'hull', { pos: [0, 0.05, -0.03] });
    reflexSight(b, 0.068, -0.045, 0.024);
    const bolt = b.node('bolt', { pos: [0.028, 0.026, 0.02] });
    b.addTo(bolt, plate(0.014, 0.012, 0.04, 0.003), accent(ex));
    b.marker('ejectPort', [0.028, 0.018, -0.005], [0, -0.5, 0.4]);
    b.marker('muzzle', [0, 0.004, -0.255]);
  },

  // -- shotgun: under-barrel tube magazine + pump ----------------------------
  shotgun(b, ex) {
    b.add(wedge(0.056, 0.05, 0.082, 0.20, 0.009), 'hull', { pos: [0, 0.006, 0.03] });
    b.add(plate(0.058, 0.018, 0.13, 0.005), 'panel', { pos: [0, 0.046, 0.02] });
    spine(b, 0.12, 0.02, 0.02, 0.03);
    greebles(b, 4, -0.04, 0.10, -0.008, 0.03, 4);
    b.add(rod(0.0135, 0.0145, 0.30, 12), 'trim', { pos: [0, 0.012, -0.20] });
    b.add(rod(0.014, 0.014, 0.26, 12), 'hull', { pos: [0, -0.02, -0.18] });
    b.add(rod(0.017, 0.018, 0.02, 12), accent(ex), { pos: [0, -0.02, -0.30] });
    // Pump grip — animated fore/aft on every shot.
    const pump = b.node('pump', { pos: [0, -0.006, -0.15] });
    b.addTo(pump, plate(0.046, 0.05, 0.10, 0.008), 'dark');
    for (let i = 0; i < 5; i++) {
      b.addTo(pump, plate(0.05, 0.006, 0.008, 0.002), 'dark', { pos: [0, -0.012, -0.036 + i * 0.018] });
    }
    b.addTo(pump, plate(0.008, 0.006, 0.07, 0.002), 'glow', { pos: [0.024, 0.012, 0] });
    b.addTo(pump, plate(0.008, 0.006, 0.07, 0.002), 'glow', { pos: [-0.024, 0.012, 0] });
    // Wide choked muzzle.
    b.add(rod(0.02, 0.0165, 0.04, 12), accent(ex), { pos: [0, 0.012, -0.345] });
    b.add(ring(0.019, 0.004, 12), 'trim', { pos: [0, 0.012, -0.362] });
    // Ghost-ring sight.
    b.add(plate(0.012, 0.02, 0.006, 0.002), 'panel', { pos: [0, 0.062, 0.075] });
    b.add(ring(0.008, 0.002, 10), 'panel', { pos: [0, 0.066, 0.075] });
    b.add(plate(0.006, 0.02, 0.005, 0.001), 'panel', { pos: [0, 0.032, -0.30] });
    b.add(plate(0.003, 0.006, 0.004), 'glow', { pos: [0, 0.041, -0.30] });
    b.marker('sight', [0, 0.066, 0.075]);
    pistolGrip(b, 0, -0.014, 0.09, 0.3);
    b.add(wedge(0.05, 0.036, 0.10, 0.10, 0.008), 'dark', { pos: [0, -0.01, 0.17] });
    b.add(plate(0.046, 0.09, 0.016, 0.006), 'dark', { pos: [0, -0.012, 0.225], rot: [0.12, 0, 0] });
    // Shell carrier on the flank — six visible brass heads.
    for (let i = 0; i < 6; i++) {
      b.add(rod(0.008, 0.008, 0.008, 8), accent(ex), { pos: [-0.03, -0.014, -0.02 + i * 0.02], rot: [0, Math.PI / 2, 0] });
    }
    b.marker('ejectPort', [0.031, 0.008, 0.02], [0, -0.7, 0.3]);
    b.marker('muzzle', [0, 0.012, -0.368]);
  },

  // -- sniper: huge scope, bipod, side bolt handle ---------------------------
  sniperRifle(b, ex) {
    b.add(wedge(0.05, 0.044, 0.075, 0.30, 0.009), 'hull', { pos: [0, 0.01, 0.05] });
    b.add(plate(0.052, 0.02, 0.20, 0.005), 'panel', { pos: [0, 0.048, 0.04] });
    spine(b, 0.18, 0.026, 0.03, 0.027);
    greebles(b, 5, -0.05, 0.16, 0.0, 0.026, 3);
    // Long fluted barrel in a skeletal chassis.
    b.add(rod(0.0095, 0.011, 0.44, 12), 'trim', { pos: [0, 0.008, -0.28] });
    for (let i = 0; i < 6; i++) b.add(ring(0.014, 0.003, 10), 'hull', { pos: [0, 0.008, -0.12 - i * 0.06] });
    b.addMirrored(plate(0.006, 0.05, 0.26, 0.003), 'panel', { pos: [0.022, 0.004, -0.20] });
    vents(b, 5, 0.038, -0.28, 0.004, 0.023, 0.005, 0.03, 'hull');
    b.add(plate(0.036, 0.042, 0.07, 0.007), accent(ex), { pos: [0, 0.008, -0.47] });
    for (let i = 0; i < 3; i++) {
      b.addMirrored(plate(0.006, 0.03, 0.008, 0.001), 'hull', { pos: [0.018, 0.008, -0.46 + i * 0.018] });
    }
    // The scope: 25 cm of tube with a sun shade. Dominates the silhouette.
    b.add(plate(0.042, 0.02, 0.16, 0.005), 'hull', { pos: [0, 0.07, 0.0] });
    scope(b, 0.028, 0.25, 0.108, -0.03);
    // Bipod, folded back along the handguard.
    b.addMirrored(rod(0.005, 0.005, 0.12, 6), 'trim', { pos: [0.016, -0.026, -0.30], rot: [0.42, 0.22, 0] });
    b.add(plate(0.03, 0.016, 0.03, 0.004), 'hull', { pos: [0, -0.026, -0.36] });
    // Thumbhole stock + adjustable cheek.
    b.add(wedge(0.044, 0.032, 0.055, 0.14, 0.008), 'dark', { pos: [0, 0.042, 0.20] });
    b.add(plate(0.038, 0.075, 0.10, 0.008), 'dark', { pos: [0, -0.024, 0.215] });
    b.add(wedge(0.055, 0.038, 0.10, 0.022, 0.007), 'dark', { pos: [0, 0.0, 0.285] });
    b.add(plate(0.032, 0.022, 0.03, 0.004), 'trim', { pos: [0, -0.058, 0.275], rot: [0.4, 0, 0] });
    pistolGrip(b, 0, -0.012, 0.10, 0.26);
    boxMag(b, 0.03, 0.08, 0.07, [0, -0.062, 0.0], 0.08);
    // Bolt handle sticking out to the right — animated after every shot.
    const bolt = b.node('bolt', { pos: [0.028, 0.03, 0.10] });
    b.addTo(bolt, rod(0.0065, 0.0065, 0.06, 8), accent(ex), { rot: [0, 1.35, 0] });
    b.addTo(bolt, new THREE.SphereGeometry(0.011, 10, 7), accent(ex), { pos: [0.03, -0.004, -0.012] });
    b.marker('ejectPort', [0.03, 0.024, 0.07], [0, -0.6, 0.35]);
    b.marker('muzzle', [0, 0.008, -0.508]);
  },

  // -- fusion: coil stack around a central accelerator rod -------------------
  fusionRifle(b, ex) {
    b.add(wedge(0.052, 0.04, 0.07, 0.22, 0.008), 'hull', { pos: [0, 0.004, 0.05] });
    b.add(plate(0.054, 0.018, 0.14, 0.005), 'panel', { pos: [0, 0.04, 0.05] });
    // Accelerator rod + five charge coils. `coils` animates during the charge.
    b.add(rod(0.009, 0.009, 0.34, 10), 'trim', { pos: [0, 0.006, -0.14] });
    const coils = b.node('coils', { pos: [0, 0.006, -0.14] });
    for (let i = 0; i < 5; i++) {
      const z = -0.13 + i * 0.062;
      b.addTo(coils, ring(0.03, 0.0075, 14), 'hull', { pos: [0, 0, z] });
      b.addTo(coils, ring(0.023, 0.004, 14), 'element', { pos: [0, 0, z + 0.008] });
      b.addTo(coils, plate(0.012, 0.012, 0.04, 0.003), 'panel', { pos: [0.03, 0, z] });
      b.addTo(coils, plate(0.012, 0.012, 0.04, 0.003), 'panel', { pos: [-0.03, 0, z] });
    }
    // Emitter aperture.
    b.add(rod(0.026, 0.032, 0.05, 12), accent(ex), { pos: [0, 0.006, -0.325] });
    b.add(new THREE.CircleGeometry(0.021, 14), 'element', { pos: [0, 0.006, -0.349], rot: [0, Math.PI, 0] });
    // Battery pack over the receiver with a charge-level strip.
    b.add(plate(0.04, 0.03, 0.11, 0.006), 'panel', { pos: [0, 0.064, 0.06] });
    for (let i = 0; i < 4; i++) {
      b.addMirrored(plate(0.004, 0.014, 0.018, 0.001), 'element', { pos: [0.021, 0.064, 0.02 + i * 0.026] });
    }
    b.add(plate(0.03, 0.014, 0.05, 0.004), 'hull', { pos: [0, 0.055, -0.05] });
    reflexSight(b, 0.072, -0.06, 0.026);
    pistolGrip(b, 0, -0.012, 0.09, 0.3);
    b.add(wedge(0.044, 0.03, 0.06, 0.028, 0.005), 'dark', { pos: [0, -0.05, -0.06], rot: [-0.4, 0, 0] });
    b.add(wedge(0.05, 0.036, 0.09, 0.08, 0.008), 'dark', { pos: [0, -0.004, 0.19] });
    boxMag(b, 0.032, 0.06, 0.05, [0, -0.05, 0.045], 0.1);
    b.marker('ejectPort', [0.028, 0.02, 0.02], [0, -0.6, 0.3]);
    b.marker('muzzle', [0, 0.006, -0.355]);
  },

  // -- rocket launcher: wide smooth tube -------------------------------------
  rocketLauncher(b, ex) {
    b.add(tube(0.055, 0.62, 16), 'hull', { pos: [0, 0.01, -0.06] });
    b.add(rod(0.062, 0.062, 0.05, 16), 'panel', { pos: [0, 0.01, -0.34] });
    b.add(rod(0.05, 0.066, 0.07, 16), 'panel', { pos: [0, 0.01, 0.20] });
    b.add(ring(0.058, 0.006, 16), accent(ex), { pos: [0, 0.01, -0.365] });
    b.add(ring(0.055, 0.005, 16), 'trim', { pos: [0, 0.01, 0.22] });
    // Longitudinal reinforcing ribs + a cyan status spine.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      b.add(plate(0.012, 0.008, 0.5, 0.002), 'panel', {
        pos: [Math.cos(a) * 0.056, 0.01 + Math.sin(a) * 0.056, -0.06],
        rot: [0, 0, a],
      });
    }
    b.add(plate(0.006, 0.008, 0.34, 0.0015), 'glow', { pos: [0, 0.068, -0.06] });
    // Warhead visible in the tube mouth.
    const warhead = b.node('magazine', { pos: [0, 0.01, -0.30] });
    b.addTo(warhead, rod(0.026, 0.038, 0.09, 12), accent(ex));
    b.addTo(warhead, ring(0.038, 0.005, 12), 'element', { pos: [0, 0, 0.04] });
    // Top optic on a riser + shoulder rest + fore grip.
    b.add(plate(0.036, 0.03, 0.10, 0.005), 'hull', { pos: [0, 0.078, -0.02] });
    scope(b, 0.02, 0.11, 0.108, -0.02, false);
    b.add(wedge(0.03, 0.024, 0.08, 0.032, 0.006), 'dark', { pos: [0, -0.058, -0.16], rot: [-0.35, 0, 0] });
    pistolGrip(b, 0, -0.05, 0.06, 0.28);
    b.add(plate(0.07, 0.09, 0.02, 0.008), 'dark', { pos: [0, 0.01, 0.245], rot: [0.1, 0, 0] });
    b.add(plate(0.05, 0.016, 0.09, 0.005), 'panel', { pos: [0.045, -0.02, 0.06], rot: [0, 0, -0.5] });
    b.marker('ejectPort', [0.05, 0.01, 0.18], [0, -0.4, 0.2]);
    b.marker('muzzle', [0, 0.01, -0.375]);
  },

  // -- grenade launcher: revolver drum + ladder sight -------------------------
  grenadeLauncher(b, ex) {
    b.add(wedge(0.05, 0.042, 0.07, 0.18, 0.008), 'hull', { pos: [0, 0.008, 0.06] });
    b.add(plate(0.052, 0.016, 0.1, 0.004), 'panel', { pos: [0, 0.042, 0.06] });
    // Fat six-chamber drum, animated (indexes one chamber per shot).
    const drum = b.node('cylinder', { pos: [0, 0.004, -0.05] });
    b.addTo(drum, rod(0.055, 0.055, 0.10, 14), 'hull');
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.addTo(drum, rod(0.016, 0.016, 0.104, 8), 'dark', {
        pos: [Math.cos(a) * 0.035, Math.sin(a) * 0.035, 0],
      });
      b.addTo(drum, rod(0.013, 0.013, 0.01, 8), accent(ex), {
        pos: [Math.cos(a) * 0.035, Math.sin(a) * 0.035, -0.05],
      });
    }
    b.addTo(drum, ring(0.055, 0.005, 14), 'trim', { pos: [0, 0, 0.05] });
    b.addTo(drum, ring(0.055, 0.005, 14), 'trim', { pos: [0, 0, -0.05] });
    // Short fat barrel.
    b.add(rod(0.023, 0.026, 0.16, 12), 'trim', { pos: [0, 0.004, -0.19] });
    b.add(rod(0.03, 0.028, 0.03, 12), accent(ex), { pos: [0, 0.004, -0.28] });
    b.add(ring(0.028, 0.005, 12), 'trim', { pos: [0, 0.004, -0.293] });
    // Ladder sight — the arcing-trajectory cue.
    b.add(plate(0.026, 0.09, 0.006, 0.003), 'panel', { pos: [0, 0.09, 0.02], rot: [-0.25, 0, 0] });
    for (let i = 0; i < 4; i++) {
      b.add(plate(0.022, 0.003, 0.005, 0.001), 'glow', { pos: [0, 0.06 + i * 0.02, 0.028 - i * 0.005] });
    }
    b.marker('sight', [0, 0.09, 0.02]);
    pistolGrip(b, 0, -0.012, 0.10, 0.3);
    b.add(wedge(0.03, 0.024, 0.075, 0.03, 0.005), 'dark', { pos: [0, -0.05, -0.15], rot: [-0.4, 0, 0] });
    b.add(wedge(0.05, 0.036, 0.09, 0.06, 0.008), 'dark', { pos: [0, -0.002, 0.175] });
    b.marker('ejectPort', [0.032, 0.006, -0.05], [0, -0.8, 0.2]);
    b.marker('muzzle', [0, 0.004, -0.30]);
  },

  // -- machine gun: belt box, top cover, bipod --------------------------------
  machineGun(b, ex) {
    b.add(wedge(0.062, 0.05, 0.09, 0.30, 0.01), 'hull', { pos: [0, 0.006, 0.03] });
    // Hinged top cover with a carry handle.
    b.add(plate(0.064, 0.026, 0.20, 0.006), 'panel', { pos: [0, 0.056, 0.0] });
    b.add(plate(0.014, 0.03, 0.10, 0.004), 'hull', { pos: [0, 0.082, -0.02] });
    b.add(plate(0.014, 0.008, 0.12, 0.003), 'dark', { pos: [0, 0.095, -0.02] });
    spine(b, 0.22, 0.026, 0.0, 0.032);
    greebles(b, 6, -0.13, 0.13, -0.01, 0.033, 5);
    // Heavy fluted barrel with a shroud.
    b.add(rod(0.012, 0.014, 0.40, 12), 'trim', { pos: [0, 0.004, -0.30] });
    b.add(tube(0.026, 0.24, 14), 'panel', { pos: [0, 0.004, -0.26] });
    vents(b, 6, 0.034, -0.36, 0.004, 0.026, 0.005, 0.034, 'hull');
    muzzleBrake(b, 0.014, -0.49, 4);
    // Belt box + a visible run of links into the feed tray.
    const box = b.node('magazine', { pos: [0, -0.062, 0.03] });
    b.addTo(box, plate(0.07, 0.09, 0.13, 0.008), 'dark');
    b.addTo(box, plate(0.05, 0.006, 0.09, 0.003), 'glow', { pos: [0, 0.044, 0] });
    b.addTo(box, plate(0.072, 0.05, 0.006, 0.003), 'panel', { pos: [0, 0.01, -0.066] });
    const belt = b.node('belt', { pos: [0, -0.016, 0.03] });
    for (let i = 0; i < 6; i++) {
      b.addTo(belt, plate(0.03, 0.012, 0.011, 0.002), accent(ex), { pos: [0, i * 0.006, -0.03 + i * 0.012] });
    }
    // Bipod, deployed forward.
    b.addMirrored(rod(0.006, 0.006, 0.16, 6), 'trim', { pos: [0.02, -0.06, -0.34], rot: [0.5, 0.3, 0] });
    b.add(plate(0.034, 0.02, 0.034, 0.005), 'hull', { pos: [0, -0.03, -0.36] });
    pistolGrip(b, 0, -0.012, 0.12, 0.28);
    b.add(wedge(0.056, 0.04, 0.10, 0.10, 0.009), 'dark', { pos: [0, -0.004, 0.21] });
    b.add(plate(0.05, 0.1, 0.018, 0.007), 'dark', { pos: [0, -0.006, 0.27], rot: [0.1, 0, 0] });
    b.add(plate(0.04, 0.016, 0.06, 0.004), 'hull', { pos: [0, 0.072, -0.13] });
    reflexSight(b, 0.09, -0.14, 0.028);
    const bolt = b.node('bolt', { pos: [0.034, 0.024, 0.06] });
    b.addTo(bolt, plate(0.018, 0.016, 0.06, 0.004), accent(ex));
    b.marker('ejectPort', [0.034, 0.0, 0.02], [0, -0.6, 0.5]);
    b.marker('muzzle', [0, 0.004, -0.516]);
  },

  // -- bow: riser + recurve limbs + string ------------------------------------
  bow(b, ex) {
    // Riser: a skeletal machined block with a cut-out window.
    b.add(plate(0.028, 0.10, 0.05, 0.008), 'hull', { pos: [0, 0.02, -0.02] });
    b.add(plate(0.02, 0.03, 0.05, 0.005), 'hull', { pos: [0, 0.12, -0.015] });
    b.add(plate(0.02, 0.03, 0.05, 0.005), 'hull', { pos: [0, -0.08, -0.015] });
    b.add(plate(0.014, 0.09, 0.02, 0.004), accent(ex), { pos: [0.012, 0.02, -0.03] });
    b.add(plate(0.006, 0.10, 0.006, 0.002), 'glow', { pos: [-0.014, 0.02, -0.03] });
    // Grip + arrow shelf.
    b.add(wedge(0.03, 0.026, 0.09, 0.038, 0.007), 'dark', { pos: [0, -0.005, 0.012], rot: [0.1, 0, 0] });
    b.add(plate(0.03, 0.006, 0.03, 0.002), 'trim', { pos: [0.006, 0.048, 0.0] });
    // Limbs — animated: they flex as the draw builds.
    const top = b.node('limbTop', { pos: [0, 0.135, -0.015] });
    b.addTo(top, wedge(0.026, 0.014, 0.02, 0.014, 0.004), 'panel', { pos: [0, 0.09, 0.03], rot: [-0.55, 0, 0], scale: [1, 9, 1] });
    b.addTo(top, plate(0.02, 0.02, 0.02, 0.005), accent(ex), { pos: [0, 0.185, 0.115] });
    const bot = b.node('limbBottom', { pos: [0, -0.095, -0.015] });
    b.addTo(bot, wedge(0.026, 0.014, 0.02, 0.014, 0.004), 'panel', { pos: [0, -0.09, 0.03], rot: [0.55, 0, 0], scale: [1, 9, 1] });
    b.addTo(bot, plate(0.02, 0.02, 0.02, 0.005), accent(ex), { pos: [0, -0.185, 0.115] });
    // String: two segments meeting at the nock. Re-aimed every frame.
    const st = b.node('stringTop', { pos: [0, 0.32, 0.10] });
    b.addTo(st, rod(0.0014, 0.0014, 1, 4), 'trim', { pos: [0, 0, 0.5] });
    const sb = b.node('stringBottom', { pos: [0, -0.28, 0.10] });
    b.addTo(sb, rod(0.0014, 0.0014, 1, 4), 'trim', { pos: [0, 0, 0.5] });
    // The nocked arrow travels back with the draw.
    const arrow = b.node('arrow', { pos: [0.006, 0.048, 0.0] });
    b.addTo(arrow, rod(0.0035, 0.0035, 0.58, 6), 'dark', { pos: [0, 0, -0.14] });
    b.addTo(arrow, rod(0.0, 0.009, 0.05, 6), accent(ex), { pos: [0, 0, -0.455] });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      b.addTo(arrow, plate(0.001, 0.016, 0.05, 0.0004), 'panel', {
        pos: [Math.cos(a) * 0.006, Math.sin(a) * 0.006, 0.12],
        rot: [0, 0, a],
      });
    }
    b.marker('sight', [0.006, 0.052, -0.02]);
    b.marker('ejectPort', [0.02, 0.05, 0.0]);
    b.marker('muzzle', [0.006, 0.048, -0.44]);
  },

  // -- trace rifle: prism emitter head, caged focus crystal -------------------
  traceRifle(b, ex) {
    b.add(wedge(0.05, 0.04, 0.075, 0.24, 0.009), 'hull', { pos: [0, 0.004, 0.04] });
    b.add(plate(0.052, 0.02, 0.16, 0.005), 'panel', { pos: [0, 0.044, 0.04] });
    spine(b, 0.18, 0.024, 0.03, 0.026, 'element');
    greebles(b, 4, 0.0, 0.14, 0.0, 0.027, 7);
    // Cage: four struts around a suspended focus crystal.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      b.add(plate(0.008, 0.008, 0.20, 0.002), 'panel', {
        pos: [Math.cos(a) * 0.028, 0.006 + Math.sin(a) * 0.028, -0.19],
        rot: [0, 0, a],
      });
    }
    const crystal = b.node('coils', { pos: [0, 0.006, -0.19] });
    b.addTo(crystal, new THREE.OctahedronGeometry(0.022, 0), 'element');
    b.addTo(crystal, new THREE.OctahedronGeometry(0.03, 0), 'glass');
    b.add(ring(0.03, 0.005, 12), 'hull', { pos: [0, 0.006, -0.10] });
    b.add(ring(0.03, 0.005, 12), 'hull', { pos: [0, 0.006, -0.28] });
    // Prism head.
    b.add(rod(0.014, 0.03, 0.07, 6), accent(ex), { pos: [0, 0.006, -0.325] });
    b.add(new THREE.CircleGeometry(0.013, 6), 'element', { pos: [0, 0.006, -0.361], rot: [0, Math.PI, 0] });
    // Radiator fins along the flanks.
    for (let i = 0; i < 5; i++) {
      b.addMirrored(plate(0.005, 0.034, 0.014, 0.002), 'panel', { pos: [0.03, 0.004, -0.02 + i * 0.03] });
    }
    b.add(plate(0.03, 0.016, 0.05, 0.004), 'hull', { pos: [0, 0.058, -0.05] });
    reflexSight(b, 0.076, -0.06, 0.026);
    pistolGrip(b, 0, -0.012, 0.08, 0.3);
    boxMag(b, 0.03, 0.08, 0.05, [0, -0.058, 0.02], 0.1);
    b.add(wedge(0.048, 0.034, 0.085, 0.07, 0.008), 'dark', { pos: [0, -0.004, 0.185] });
    b.marker('ejectPort', [0.028, 0.02, 0.0], [0, -0.6, 0.3]);
    b.marker('muzzle', [0, 0.006, -0.365]);
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WeaponModel {
  readonly family: WeaponFamily;
  readonly root: THREE.Group;
  /** Barrel tip: muzzle flash, light and tracer origin. */
  readonly muzzle: THREE.Object3D;
  /** Optic centre — ADS aligns this to the exact screen centre. */
  readonly sight: THREE.Object3D;
  /** Where spent cases leave the weapon. */
  readonly ejectPort: THREE.Object3D;
  /** Reciprocating part (bolt, slide, charging handle) or null. */
  readonly bolt: THREE.Object3D | null;
  /** Detachable magazine / belt box / warhead, or null. */
  readonly magazine: THREE.Object3D | null;
  /** Pump grip, revolver cylinder, coil stack — family-specific extras. */
  readonly nodes: Record<string, THREE.Object3D>;
  /** Triangle count, for the budget report. */
  readonly triangles: number;
  dispose(): void;
}

/**
 * Build the view-model for a weapon.
 *
 * `materials` may be null (the model falls back to plain PBR materials), which
 * is what the standalone verification harness uses.
 */
export function buildWeaponModel(
  stats: WeaponStats,
  materials: MaterialLibrary | null,
  decorate?: (m: THREE.Material) => void,
): WeaponModel {
  const elementColor = ELEMENT_COLOR[stats.element] ?? 0x4fe6ff;
  const mats = createWeaponMaterials(materials, elementColor, decorate);
  const b = new Builder(mats);
  const build = BUILDERS[stats.family] ?? BUILDERS.autoRifle;
  build(b, stats.rarity === 'exotic');
  b.finish();
  b.root.name = `weapon:${stats.id}`;

  let triangles = 0;
  b.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    const index = g.getIndex();
    triangles += index ? index.count / 3 : g.getAttribute('position').count / 3;
  });

  const nodes = b.nodes;
  const fallback = (): THREE.Object3D => {
    const o = new THREE.Object3D();
    b.root.add(o);
    return o;
  };

  return {
    family: stats.family,
    root: b.root,
    muzzle: nodes.muzzle ?? fallback(),
    sight: nodes.sight ?? fallback(),
    ejectPort: nodes.ejectPort ?? fallback(),
    bolt: nodes.bolt ?? null,
    magazine: nodes.magazine ?? null,
    nodes,
    triangles: Math.round(triangles),
    dispose() {
      for (const g of b.owned) g.dispose();
      b.owned.length = 0;
      mats.dispose();
      b.root.clear();
      b.root.removeFromParent();
    },
  };
}

/** Release the shared chamfered-slab cache (call once on teardown). */
export function disposeMeshCache(): void {
  for (const g of _shapeCache.values()) g.dispose();
  _shapeCache.clear();
}
