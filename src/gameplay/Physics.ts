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

    // Analytic terrain floor (cheap and always exact).
    if (this.groundFn) {
      const n = scratch.v3c.set(0, 1, 0);
      const gy = this.groundFn(position.x, position.z, n);
      const feet = position.y - halfHeight - radius;
      if (feet < gy) {
        position.y = gy + halfHeight + radius;
        if (velocity.y < 0) velocity.y = 0;
        if (n.y > bestGroundDot) {
          bestGroundDot = n.y;
          result.groundNormal.copy(n);
        }
        result.grounded = true;
      } else if (feet < gy + 0.14) {
        // Coyote-ish contact band keeps the player glued on gentle slopes.
        if (n.y > bestGroundDot) {
          bestGroundDot = n.y;
          result.groundNormal.copy(n);
        }
        result.grounded = true;
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
