/**
 * World sweeping for anything that is not a character capsule.
 *
 * `BvhCollisionWorld.raycast` only sees registered triangle meshes — props,
 * rocks, structures. Open terrain is an analytic height field plugged in as
 * `groundFn`, and a ray never touches it: `resolveCapsule` special-cases the
 * height field for the player, but nothing else does. A grenade or a super's
 * impact ray using `raycast` alone therefore falls straight through the planet,
 * which is exactly what the first ability capture showed.
 *
 * `sweepWorld` closes that gap: BVH ray first, then an explicit height-field
 * crossing test along the same segment, and whichever is nearer wins.
 */
import * as THREE from 'three';
import type { CollisionWorld, RaycastHit, SurfaceKind } from '@/types';
import { clamp01 } from '@/util/math';
import type { GrenadeSpec } from './Definitions';

/**
 * Upward loft added to a throw, at zero charge and at full charge, m/s.
 *
 * Without it a grenade thrown level from 1.7 m lands nine metres away however
 * hard it is thrown — the flight time is fixed by the drop, not the speed — and
 * the arc reads as a stone skipped across the floor. Lofting the throw is what
 * turns "charge" into "range", which is the whole point of a charged throw.
 */
export const LOFT_BASE = 3;
export const LOFT_CHARGE = 5;

/**
 * The launch velocity for a throw. Both the live projectile and the trajectory
 * preview call this, so the preview cannot drift away from the throw.
 */
export function throwVelocity(
  spec: GrenadeSpec,
  direction: THREE.Vector3,
  charge: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const c = clamp01(charge);
  const speed = spec.minSpeed + (spec.maxSpeed - spec.minSpeed) * c;
  out.copy(direction).normalize().multiplyScalar(speed);
  out.y += LOFT_BASE + c * LOFT_CHARGE;
  return out;
}

const _worldHit: RaycastHit = {
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  surface: 'rock',
};

const _groundHit: RaycastHit = {
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  surface: 'sand',
};

/** Sweep a segment against both the BVH meshes and the analytic height field. */
export function sweepWorld(
  collision: CollisionWorld,
  from: THREE.Vector3,
  dir: THREE.Vector3,
  dist: number,
  radius: number,
  surface: SurfaceKind,
): RaycastHit | null {
  const world = collision.raycast(from, dir, dist + radius, _worldHit);
  const worldDist = world ? world.distance : Infinity;

  const x1 = from.x + dir.x * dist;
  const z1 = from.z + dir.z * dist;
  const y1 = from.y + dir.y * dist;
  const g0 = collision.sampleGround(from.x, from.z);
  const g1 = collision.sampleGround(x1, z1);
  if (g0 && g1) {
    const d0 = from.y - g0.y - radius;
    const d1 = y1 - g1.y - radius;
    if (d1 <= 0) {
      // Fraction of the step at which the segment crossed the surface.
      const t = d0 > 0 ? d0 / Math.max(1e-5, d0 - d1) : 0;
      const groundDist = t * dist;
      if (groundDist <= worldDist) {
        _groundHit.distance = groundDist;
        _groundHit.point.set(
          from.x + dir.x * groundDist,
          from.y + dir.y * groundDist,
          from.z + dir.z * groundDist,
        );
        _groundHit.normal.copy(t > 0.5 ? g1.normal : g0.normal).normalize();
        if (_groundHit.normal.lengthSq() < 0.5) _groundHit.normal.set(0, 1, 0);
        _groundHit.surface = surface;
        return _groundHit;
      }
    }
  }
  return world;
}
