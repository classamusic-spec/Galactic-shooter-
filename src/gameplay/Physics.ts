/**
 * Collision: BVH-accelerated static world queries plus capsule character
 * resolution. This is deliberately not a rigid-body engine — an FPS wants
 * predictable, tunable, frame-rate-independent character movement, and
 * `three-mesh-bvh` gives us exact triangle queries fast enough to do it right.
 */
import * as THREE from 'three';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';
import type {
  CapsuleResolveResult,
  CollisionWorld,
  Damageable,
  HitRegion,
  RaycastHit,
  SurfaceKind,
} from '@/types';
import { clamp, scratch } from '@/util/math';

/** Gravity in m/s². Heavier than Earth for snappier, Destiny-like arcs. */
export const GRAVITY = 24;

/** Max walkable slope, radians (~46°). */
export const MAX_SLOPE = 0.8;
/** Cosine of MAX_SLOPE: ground with a flatter normal than this is walkable. */
const TERRAIN_WALKABLE_COS = Math.cos(MAX_SLOPE);
/** Rise over run at MAX_SLOPE, for testing steepness from heights alone. */
const TERRAIN_WALKABLE_TAN = Math.tan(MAX_SLOPE);
/**
 * Bearings probed around the horizontal velocity, radians. Three is enough to
 * catch a face taken at a glancing angle without paying for a full ring; the
 * first is the travel direction itself and doubles as the cheap gate.
 */
const TERRAIN_PROBE_FAN = [0, -0.7, 0.7];
/** Fallback bearings for a capsule with no horizontal velocity to aim along. */
const TERRAIN_PROBE_RING = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/**
 * Probe distances as a fraction of the capsule radius. The rim catches ground
 * rising just outside the body; the inner one catches a face the capsule has
 * already moved past, where the rim sample reads as merely tangent.
 */
const TERRAIN_PROBE_IN = 0.6;
const TERRAIN_PROBE_OUT = 1;
/** Penetration under this is left alone -- it is the surface's own noise. */
const TERRAIN_SKIN = 0.02;
/** Depenetration passes per resolve. Two is plenty; the third is insurance. */
const TERRAIN_PUSH_ITERATIONS = 3;
/** Reused by the terrain probes. `resolveCapsule` must not allocate per step. */
const _terrainNormal = new THREE.Vector3();

/** Ground steeper than this gets no standoff help at all (60 degrees). */
const TERRAIN_STANDOFF_FADE_COS = Math.cos(1.05);

/**
 * How far above the ground sample the capsule centre has to sit.
 *
 * Lifting by exactly `radius` is only correct on the flat. On a slope the
 * capsule touches the ground on its lower hemisphere's *side*, not its lowest
 * point, so the tangent offset along the surface normal is `radius / n.y` --
 * lift by `radius` instead and the uphill half of the hemisphere is buried.
 * That was worth 0.14 m of the player's shins on a 44 degree face.
 *
 * The correction fades to nothing between the walkable limit and 60 degrees,
 * and clamping it there rather than fading was a mistake worth measuring: a
 * flat clamp still handed an 82 degree cliff 0.15 m of lift every step, and the
 * capsule ratcheted 3.1 m up a face it had previously slid 0.9 m *down*. Steep
 * ground is the horizontal solver's problem; this function must not help.
 */
function standoff(radius: number, ny: number): number {
  const t = clamp(
    (ny - TERRAIN_STANDOFF_FADE_COS) / (TERRAIN_WALKABLE_COS - TERRAIN_STANDOFF_FADE_COS),
    0,
    1,
  );
  return radius * (1 + t * (1 / Math.max(ny, 1e-3) - 1));
}

/** How many push-out iterations the capsule solver runs per step. */
const RESOLVE_ITERATIONS = 5;

/** Hit-proxy registration for damageable entities (spheres/capsules). */
export interface HitProxy {
  damageable: Damageable;
  region: HitRegion;
  /** Local-space offset from the entity origin. */
  offset: THREE.Vector3;
  radius: number;
  /** Half-height for capsule proxies; 0 = sphere. */
  halfHeight: number;
  /** Damage multiplier applied by the resolver on top of the weapon's. */
  multiplier: number;
  enabled: boolean;
  /** Cached world position, refreshed each step by the owner. */
  world: THREE.Vector3;
}

interface StaticChunk {
  bvh: MeshBVH;
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  inverse: THREE.Matrix4;
  surface: SurfaceKind;
  /** World-space bounding sphere for cheap rejection. */
  center: THREE.Vector3;
  radius: number;
}

const _ray = new THREE.Ray();
const _hitTmp: RaycastHit = {
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  surface: 'rock',
};
const _tri = new THREE.Triangle();
const _box = new THREE.Box3();
const _seg = new THREE.Line3();
const _closestTri = new THREE.Vector3();
const _closestSeg = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _sphere = new THREE.Sphere();

export class BvhCollisionWorld implements CollisionWorld {
  private chunks: StaticChunk[] = [];
  private proxies: HitProxy[] = [];
  /** Optional analytic ground function (terrain heightfield) — much faster. */
  groundFn: ((x: number, z: number, outNormal: THREE.Vector3) => number) | null = null;
  /** Optional normal-free height sampler; see `terrainHeight`. */
  heightFn: ((x: number, z: number) => number) | null = null;

  /**
   * Register static collision geometry. Pass the mesh's *world* matrix; the
   * BVH is built in local space and rays are transformed into it.
   */
  addStatic(
    geometry: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    surface: SurfaceKind = 'rock',
    opts?: MeshBVHOptions,
  ): void {
    if (!geometry.getAttribute('position')) return;
    const bvh = new MeshBVH(geometry, { maxLeafTris: 8, ...opts });
    geometry.computeBoundingSphere();
    const bs = geometry.boundingSphere!;
    const center = bs.center.clone().applyMatrix4(matrix);
    // Uniform-ish scale assumption: take the largest axis scale.
    const s = scratch.v3a.setFromMatrixScale(matrix);
    const radius = bs.radius * Math.max(s.x, s.y, s.z);
    this.chunks.push({
      bvh,
      geometry,
      matrix: matrix.clone(),
      inverse: matrix.clone().invert(),
      surface,
      center,
      radius,
    });
  }

  /** Convenience: register a mesh (updates its world matrix first). */
  addMesh(mesh: THREE.Mesh, surface: SurfaceKind = 'rock'): void {
    mesh.updateWorldMatrix(true, false);
    this.addStatic(mesh.geometry, mesh.matrixWorld, surface);
  }

  addProxy(p: HitProxy): HitProxy {
    this.proxies.push(p);
    return p;
  }

  removeProxiesFor(entityId: number): void {
    this.proxies = this.proxies.filter((p) => p.damageable.entityId !== entityId);
  }

  get proxyCount(): number {
    return this.proxies.length;
  }

  // -- queries --------------------------------------------------------------

  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    out: RaycastHit = _hitTmp,
  ): RaycastHit | null {
    let best = maxDistance;
    let found = false;

    for (const c of this.chunks) {
      // Cheap sphere rejection before the BVH walk.
      const toCenter = scratch.v3a.subVectors(c.center, origin);
      const along = toCenter.dot(direction);
      if (along < -c.radius || along - c.radius > best) continue;
      if (toCenter.lengthSq() - along * along > c.radius * c.radius) continue;

      _ray.origin.copy(origin).applyMatrix4(c.inverse);
      _ray.direction.copy(direction).transformDirection(c.inverse).normalize();
      const hit = c.bvh.raycastFirst(_ray, THREE.FrontSide);
      if (!hit || hit.distance == null) continue;

      // Distance is in local space; convert by re-projecting the point.
      const worldPoint = scratch.v3b.copy(hit.point).applyMatrix4(c.matrix);
      const d = worldPoint.distanceTo(origin);
      if (d >= best) continue;

      best = d;
      found = true;
      out.distance = d;
      out.point.copy(worldPoint);
      out.normal
        .copy(hit.face?.normal ?? scratch.v3c.set(0, 1, 0))
        .transformDirection(c.matrix)
        .normalize();
      out.surface = c.surface;
      out.object = undefined;
      out.damageable = undefined;
      out.region = undefined;
    }
    return found ? out : null;
  }

  /**
   * Raycast against enemy hit proxies as well as the world, returning whichever
   * is nearer. This is what weapons use.
   */
  raycastAll(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    ignoreEntityId = -1,
    out: RaycastHit = _hitTmp,
  ): RaycastHit | null {
    const world = this.raycast(origin, direction, maxDistance, out);
    let best = world ? world.distance : maxDistance;
    let bestProxy: HitProxy | null = null;
    let bestT = best;

    for (const p of this.proxies) {
      if (!p.enabled || p.damageable.entityId === ignoreEntityId) continue;
      if (p.damageable.isDead) continue;
      const t = p.halfHeight > 0
        ? rayCapsule(origin, direction, p.world, p.halfHeight, p.radius)
        : raySphere(origin, direction, p.world, p.radius);
      if (t == null || t < 0 || t >= bestT) continue;
      bestT = t;
      bestProxy = p;
    }

    if (bestProxy) {
      const hitPoint = out.point.copy(origin).addScaledVector(direction, bestT);
      out.distance = bestT;
      out.normal.subVectors(hitPoint, bestProxy.world).normalize();
      out.surface = 'flesh';
      out.damageable = bestProxy.damageable;
      out.region = bestProxy.region;
      out.object = undefined;
      return out;
    }
    return world;
  }

  lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dir = scratch.v3d.subVectors(to, from);
    const dist = dir.length();
    if (dist < 1e-4) return true;
    dir.multiplyScalar(1 / dist);
    return this.raycast(from, dir, dist - 0.05, _hitTmp) == null;
  }

  sampleGround(x: number, z: number, maxY = 400): { y: number; normal: THREE.Vector3 } | null {
    if (this.groundFn) {
      const n = new THREE.Vector3(0, 1, 0);
      return { y: this.groundFn(x, z, n), normal: n };
    }
    const origin = scratch.v3a.set(x, maxY, z);
    const dir = scratch.v3b.set(0, -1, 0);
    const hit = this.raycast(origin, dir, maxY + 600, _hitTmp);
    return hit ? { y: hit.point.y, normal: hit.normal.clone() } : null;
  }

  // -- capsule character resolution ----------------------------------------

  /**
   * Integrate + resolve a capsule against the static world.
   *
   * `position` is the capsule *centre*. Velocity is mutated so that motion into
   * a surface is cancelled along the contact normal (slide, don't stick).
   */
  /**
   * Terrain height with no normal. `groundFn` computes one by central
   * differences whether the caller wants it or not, which is four extra field
   * evaluations; the solid-terrain probes want heights and nothing else, and
   * they take enough samples for the difference to show up in a profile.
   */
  private terrainHeight(x: number, z: number): number {
    if (this.heightFn) return this.heightFn(x, z);
    return this.groundFn ? this.groundFn(x, z, _terrainNormal) : 0;
  }

  /**
   * Stand the capsule on the analytic ground under its centre, reporting
   * contact. Runs once before the solid-terrain probes and again after any
   * horizontal push, because a push puts the capsule over a different column.
   */
  private settleOnTerrain(
    position: THREE.Vector3,
    radius: number,
    halfHeight: number,
    velocity: THREE.Vector3,
    result: CapsuleResolveResult,
    bestGroundDot: number,
  ): number {
    if (!this.groundFn) return bestGroundDot;
    const n = scratch.v3c.set(0, 1, 0);
    const gy = this.groundFn(position.x, position.z, n);
    const stand = standoff(radius, n.y);
    const feet = position.y - halfHeight - stand;
    // Coyote-ish contact band keeps the player glued on gentle slopes.
    if (feet >= gy + 0.14) return bestGroundDot;
    if (feet < gy) {
      position.y = gy + halfHeight + stand;
      if (velocity.y < 0) velocity.y = 0;
    }
    result.grounded = true;
    if (n.y > bestGroundDot) {
      result.groundNormal.copy(n);
      return n.y;
    }
    return bestGroundDot;
  }

  resolveCapsule(
    position: THREE.Vector3,
    radius: number,
    halfHeight: number,
    velocity: THREE.Vector3,
    dt: number,
  ): CapsuleResolveResult {
    const result: CapsuleResolveResult = {
      grounded: false,
      groundNormal: new THREE.Vector3(0, 1, 0),
      slope: 0,
      touchedWall: false,
      wallNormal: new THREE.Vector3(),
      landingImpact: 0,
    };

    position.addScaledVector(velocity, dt);

    const verticalBefore = velocity.y;
    let bestGroundDot = 0;

    for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
      let moved = false;

      _seg.start.set(position.x, position.y - halfHeight, position.z);
      _seg.end.set(position.x, position.y + halfHeight, position.z);
      _box.setFromPoints([_seg.start, _seg.end]).expandByScalar(radius + 0.02);

      for (const c of this.chunks) {
        _sphere.center.copy(position);
        _sphere.radius = radius + halfHeight + 0.05;
        if (_sphere.center.distanceTo(c.center) > c.radius + _sphere.radius) continue;

        // Work in the chunk's local space.
        const localSeg = _seg.clone();
        localSeg.start.applyMatrix4(c.inverse);
        localSeg.end.applyMatrix4(c.inverse);
        const localBox = _box.clone().applyMatrix4(c.inverse);

        c.bvh.shapecast({
          intersectsBounds: (bounds) => bounds.intersectsBox(localBox),
          intersectsTriangle: (tri) => {
            _tri.copy(tri as unknown as THREE.Triangle);
            const dist = triangleSegmentClosest(_tri, localSeg, _closestTri, _closestSeg);
            if (dist >= radius) return false;

            // Back to world space to build the push-out.
            const wTri = _closestTri.clone().applyMatrix4(c.matrix);
            const wSeg = _closestSeg.clone().applyMatrix4(c.matrix);
            _delta.subVectors(wSeg, wTri);
            const len = _delta.length();
            if (len < 1e-6) {
              tri.getNormal(_normal);
              _normal.transformDirection(c.matrix).normalize();
            } else {
              _normal.copy(_delta).multiplyScalar(1 / len);
            }
            const depth = radius - len;
            if (depth <= 0) return false;

            position.addScaledVector(_normal, depth);
            localSeg.start.set(position.x, position.y - halfHeight, position.z).applyMatrix4(c.inverse);
            localSeg.end.set(position.x, position.y + halfHeight, position.z).applyMatrix4(c.inverse);
            moved = true;

            const up = _normal.y;
            if (up > 0.4) {
              if (up > bestGroundDot) {
                bestGroundDot = up;
                result.groundNormal.copy(_normal);
              }
              result.grounded = true;
            } else if (Math.abs(up) <= 0.4) {
              result.touchedWall = true;
              result.wallNormal.copy(_normal);
            }

            // Cancel inward velocity so we slide along the surface.
            const into = velocity.dot(_normal);
            if (into < 0) velocity.addScaledVector(_normal, -into);
            return false;
          },
        });
      }
      if (!moved) break;
    }

    // Analytic terrain, in two passes: stand on it, then stop passing through it.
    //
    // The floor pass corrects Y only: it samples the height under the capsule's
    // centre and lifts the capsule to stand on it. That alone makes terrain a
    // floor you can never be inside vertically -- and a wall you can walk
    // straight through. Measured on a 44 degree face on Draco IX: the capsule's
    // base sat exactly on the centre sample while the terrain 0.35 m to one side
    // stood 0.22 m higher, so the player's body was a fifth of a metre inside the
    // hill, and on steeper ground the camera goes in with it.
    bestGroundDot = this.settleOnTerrain(position, radius, halfHeight, velocity, result, 0);

    // The solid pass. For a terrain column of height `sy` at horizontal distance
    // `d` from the capsule axis, the capsule is clear iff `d >= D`, where D falls
    // out of the capsule's own shape: with `k` the drop from the axis segment's
    // bottom down to the terrain top, D = 0 once the column is fully below the
    // lower hemisphere (k >= radius), D = sqrt(radius^2 - k^2) while the column
    // meets that hemisphere, and D = radius once it reaches the cylinder. Using
    // the hemisphere rather than the capsule's flat base is what keeps hills
    // walkable: on a 30 degree slope the uphill rim needs 0.32 m of clearance and
    // has 0.35, so nothing pushes back, while a 60 degree face demands the full
    // radius and shoves the player out.
    //
    // Cost drove the shape of this. Every enemy capsule runs it 120 times a
    // second, and `groundFn` is not cheap -- it is a height sample plus a normal
    // by central differences, five field evaluations, 14.6 microseconds measured
    // against a bare resolve of about 24. So the probes below take *heights* only
    // and read steepness off the samples themselves: the rise between successive
    // probes along a bearing is the slope in the direction of travel, which is
    // the one that decides whether the player can walk up it anyway. Ground flat
    // enough to walk is skipped outright; blocking there would stop the climb.
    if (this.groundFn) {
      const hs = Math.hypot(velocity.x, velocity.z);
      // A capsule standing still cannot acquire new penetration -- nothing moved
      // -- so the ring is only ever insurance against a spawn or a teleport
      // placing one inside a dune. Travel direction is what matters otherwise.
      const moving = hs > 1e-4;
      const fan = moving ? TERRAIN_PROBE_FAN : TERRAIN_PROBE_RING;
      const dx = moving ? velocity.x / hs : 1;
      const dz = moving ? velocity.z / hs : 0;
      // A capsule standing squarely on walkable ground has nowhere new to be
      // inside, so the ring stays unpaid in the case that dominates the frame:
      // idle enemies. It still sweeps for one that is airborne, sliding, or
      // freshly teleported, which is the only way to arrive inside a dune
      // without having walked there.
      const skip =
        !moving && result.grounded && result.groundNormal.y > TERRAIN_WALKABLE_COS;
      const dIn = radius * TERRAIN_PROBE_IN;
      const dOut = radius * TERRAIN_PROBE_OUT;
      const span = dOut - dIn;

      for (let iter = 0; !skip && iter < TERRAIN_PUSH_ITERATIONS; iter++) {
        const axisBottom = position.y - halfHeight;
        const centre = this.terrainHeight(position.x, position.z);
        let worst = TERRAIN_SKIN;
        let wx = 0;
        let wz = 0;
        for (let b = 0; b < fan.length; b++) {
          const a = fan[b];
          const c = Math.cos(a);
          const sn = Math.sin(a);
          const px = dx * c - dz * sn;
          const pz = dz * c + dx * sn;
          const hIn = this.terrainHeight(position.x + px * dIn, position.z + pz * dIn);
          const hOut = this.terrainHeight(position.x + px * dOut, position.z + pz * dOut);
          // Steepest rise anywhere along this bearing. The inner leg matters as
          // much as the outer: a capsule pressed past a cliff lip finds both
          // probes sitting on the plateau, whose outer rise reads as flat while
          // the face itself is inside the radius -- only the climb from the
          // centre out gives it away.
          const rise = Math.max((hIn - centre) / dIn, (hOut - hIn) / span);
          if (rise < TERRAIN_WALKABLE_TAN) {
            // The travel bearing leads the fan and doubles as its gate. Nothing
            // steep straight ahead means nothing for the flanking probes to find
            // either, and skipping them is what keeps the common case at two
            // height samples instead of six. The ring has no travel direction to
            // lead with, so every bearing there stands on its own.
            if (moving && b === 0) break;
            continue;
          }
          for (let q = 0; q < 2; q++) {
            const d = q === 0 ? dIn : dOut;
            const sy = q === 0 ? hIn : hOut;
            const k = axisBottom - sy;
            if (k >= radius) continue;
            const need = k > 0 ? Math.sqrt(radius * radius - k * k) : radius;
            const push = need - d;
            if (push <= worst) continue;
            worst = push;
            wx = -px;
            wz = -pz;
          }
        }
        if (wx === 0 && wz === 0) break;
        position.x += wx * worst;
        position.z += wz * worst;
        const into = velocity.x * wx + velocity.z * wz;
        if (into < 0) {
          velocity.x -= wx * into;
          velocity.z -= wz * into;
        }
        result.touchedWall = true;
        result.wallNormal.set(wx, 0, wz);
        // Pushed out horizontally, so the ground underfoot is a different
        // column now. Re-seat before the next pass measures against it.
        bestGroundDot = this.settleOnTerrain(
          position,
          radius,
          halfHeight,
          velocity,
          result,
          bestGroundDot,
        );
      }
    }
    result.slope = Math.acos(clamp(result.groundNormal.y, -1, 1));
    if (result.grounded && verticalBefore < -1) result.landingImpact = -verticalBefore;
    return result;
  }

  /** Spherecast used by projectiles that need thickness. */
  sphereSweep(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    radius: number,
    maxDistance: number,
    ignoreEntityId = -1,
    out: RaycastHit = _hitTmp,
  ): RaycastHit | null {
    // A thin ray plus a proxy inflation is accurate enough for game projectiles
    // and dramatically cheaper than a true swept-sphere against the BVH.
    const hit = this.raycastAll(origin, direction, maxDistance + radius, ignoreEntityId, out);
    if (!hit) return null;
    hit.distance = Math.max(0, hit.distance - radius * 0.5);
    return hit;
  }

  clear(): void {
    for (const c of this.chunks) c.bvh = null as unknown as MeshBVH;
    this.chunks.length = 0;
    this.proxies.length = 0;
    this.groundFn = null;
    this.heightFn = null;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/** Closest points between a triangle and a segment. Returns the distance. */
function triangleSegmentClosest(
  tri: THREE.Triangle,
  seg: THREE.Line3,
  outTri: THREE.Vector3,
  outSeg: THREE.Vector3,
): number {
  // Sample the segment against the triangle plane; refine with edge tests.
  tri.closestPointToPoint(seg.start, outTri);
  let best = outTri.distanceToSquared(seg.start);
  outSeg.copy(seg.start);

  const pB = scratch.v3a;
  tri.closestPointToPoint(seg.end, pB);
  const dB = pB.distanceToSquared(seg.end);
  if (dB < best) {
    best = dB;
    outTri.copy(pB);
    outSeg.copy(seg.end);
  }

  // Midpoint plus two quarter points catch the common capsule-on-floor case
  // that pure-endpoint tests miss on large triangles.
  for (const t of [0.5, 0.25, 0.75]) {
    const p = scratch.v3b.lerpVectors(seg.start, seg.end, t);
    const q = scratch.v3d;
    tri.closestPointToPoint(p, q);
    const d = q.distanceToSquared(p);
    if (d < best) {
      best = d;
      outTri.copy(q);
      outSeg.copy(p);
    }
  }
  return Math.sqrt(best);
}

/** Ray-sphere intersection. Returns entry distance or null. */
export function raySphere(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/** Ray vs vertical capsule (axis along Y). Returns entry distance or null. */
export function rayCapsule(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  center: THREE.Vector3,
  halfHeight: number,
  radius: number,
): number | null {
  // Infinite-cylinder test in XZ, then clamp to the segment and fall back to
  // the end caps.
  const ox = origin.x - center.x;
  const oz = origin.z - center.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a > 1e-8) {
    const b = ox * dir.x + oz * dir.z;
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0) {
        const y = origin.y + dir.y * t - center.y;
        if (Math.abs(y) <= halfHeight) return t;
      }
    }
  }
  const top = scratch.v3a.set(center.x, center.y + halfHeight, center.z);
  const bot = scratch.v3b.set(center.x, center.y - halfHeight, center.z);
  const tTop = raySphere(origin, dir, top, radius);
  const tBot = raySphere(origin, dir, bot, radius);
  if (tTop == null) return tBot;
  if (tBot == null) return tTop;
  return Math.min(tTop, tBot);
}
