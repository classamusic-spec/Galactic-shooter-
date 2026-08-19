/**
 * Console-style aim assist.
 *
 * A thumbstick gives roughly two orders of magnitude less angular precision than
 * a mouse, so an FPS that treats them identically is not "harder" on a pad — it
 * is unplayable. Every shipped console shooter closes that gap the same two ways,
 * and this implements both:
 *
 * - **Friction.** Look speed drops as the crosshair crosses a target, so the
 *   stick that would have swept past it now lingers. This is what makes tracking
 *   possible; it is by far the larger of the two effects.
 * - **Adhesion.** A small rotation toward the target, scaled by how hard the
 *   player is *already* pushing the stick. Gating on stick input is the whole
 *   trick: a deliberately still aim is never dragged off, and the assist only
 *   ever helps a movement the player started.
 *
 * Both are off for mouse input, both scale with a user setting, and neither
 * touches where bullets go — the shot still follows the crosshair. Bullet
 * magnetism is the other half of the console toolkit and is deliberately not
 * here: it makes misses count as hits, which is a much bigger change to the
 * game's feel than helping the camera arrive.
 */
import * as THREE from 'three';
import { clamp, clamp01 } from '@/util/math';

export interface AimTarget {
  /** World point to aim at — centre of mass, not the ground contact. */
  point: THREE.Vector3;
  /** Radius of the assist bubble in metres, usually a little over the capsule. */
  radius: number;
}

/** Anything that can offer aim-assist candidates. `EnemyManager` implements it. */
export interface AimTargetSource {
  collectAimTargets(out: AimTarget[], origin: THREE.Vector3, maxDistance: number): void;
}

export interface AimAssistTuning {
  /** Ignore targets past this, metres. */
  maxDistance: number;
  /**
   * Half-angle of the assist cone, radians, measured to the target's *centre*.
   * Wider than this and the assist starts grabbing things the player is not
   * looking at, which reads as the camera fighting back.
   */
  maxAngle: number;
  /** Strongest slow-down, as a fraction removed from look speed. */
  friction: number;
  /** Peak adhesion rate, radians per second at full stick deflection. */
  adhesion: number;
}

export const AIM_ASSIST: AimAssistTuning = {
  maxDistance: 90,
  maxAngle: 0.16, // ~9 degrees
  friction: 0.62,
  adhesion: 1.5,
};

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _targets: AimTarget[] = [];

export interface AimAssistResult {
  /** Multiplier to apply to the player's look delta. */
  frictionScale: number;
  /** Extra yaw to add this step, radians. */
  yaw: number;
  /** Extra pitch to add this step, radians. */
  pitch: number;
  /** True when a target is inside the cone — for the sticky-crosshair tell. */
  locked: boolean;
  /** Candidates considered this step, and the angle to the chosen one (degrees). */
  candidates: number;
  angleDeg: number;
  coneDeg: number;
}

const _result: AimAssistResult = {
  frictionScale: 1,
  yaw: 0,
  pitch: 0,
  locked: false,
  candidates: 0,
  angleDeg: 0,
  coneDeg: 0,
};

/**
 * @param origin     Eye position.
 * @param yaw        Current view yaw.
 * @param pitch      Current view pitch.
 * @param stick      Look-stick deflection this step, 0..1. Adhesion scales with it.
 * @param strength   User setting, 0..1. Zero disables everything.
 * @param dt         Simulation step, seconds.
 */
export function computeAimAssist(
  source: AimTargetSource | null,
  origin: THREE.Vector3,
  yaw: number,
  pitch: number,
  stick: number,
  strength: number,
  dt: number,
): AimAssistResult {
  _result.frictionScale = 1;
  _result.yaw = 0;
  _result.pitch = 0;
  _result.locked = false;
  _result.candidates = 0;
  _result.angleDeg = 180;
  _result.coneDeg = 0;
  if (!source || strength <= 0) return _result;

  _targets.length = 0;
  source.collectAimTargets(_targets, origin, AIM_ASSIST.maxDistance);
  _result.candidates = _targets.length;
  if (!_targets.length) return _result;

  // View basis. Yaw 0 looks down -Z, matching the player's own convention.
  const cp = Math.cos(pitch);
  _fwd.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  _right.crossVectors(_fwd, _up).normalize();

  let best: AimTarget | null = null;
  let bestScore = Infinity;
  let bestAngle = 0;
  let bestDist = 0;
  for (const t of _targets) {
    _to.subVectors(t.point, origin);
    const dist = _to.length();
    if (dist < 1e-3 || dist > AIM_ASSIST.maxDistance) continue;
    _to.divideScalar(dist);
    const cos = clamp(_to.dot(_fwd), -1, 1);
    if (cos <= 0) continue;
    const angle = Math.acos(cos);
    // The bubble subtends a larger angle up close, which is what makes assist
    // feel strong in a brawl and nearly absent at sniping range — the same
    // behaviour a fixed screen-space bubble would give, without the projection.
    const subtend = Math.atan2(t.radius, dist);
    const cone = AIM_ASSIST.maxAngle + subtend;
    if (angle > cone) continue;
    // Prefer the closest to the crosshair, then the nearest — a distant enemy
    // exactly on the crosshair should still lose to one at point-blank range
    // that is nearly on it.
    const score = angle / cone + dist / AIM_ASSIST.maxDistance * 0.25;
    if (score < bestScore) {
      bestScore = score;
      best = t;
      bestAngle = angle;
      bestDist = dist;
    }
  }
  if (!best) return _result;

  const subtend = Math.atan2(best.radius, bestDist);
  const cone = AIM_ASSIST.maxAngle + subtend;
  // 1 at the centre of the target, 0 at the edge of the cone, smoothed so there
  // is no step as the crosshair crosses the boundary.
  const closeness = 1 - clamp01(bestAngle / cone);
  const eased = closeness * closeness * (3 - 2 * closeness);
  _result.locked = bestAngle < subtend;
  _result.angleDeg = (bestAngle * 180) / Math.PI;
  _result.coneDeg = (cone * 180) / Math.PI;

  _result.frictionScale = 1 - AIM_ASSIST.friction * eased * strength;

  // Adhesion: rotate toward the target, but only as fast as the player is
  // already turning. `stick` is the deflection, so a released stick yields zero.
  const pull = AIM_ASSIST.adhesion * eased * strength * clamp01(stick) * dt;
  if (pull > 0) {
    _to.subVectors(best.point, origin).normalize();
    // Decompose the error into the view's own yaw/pitch axes rather than solving
    // a full look-at, so the assist can never roll the camera or fight the
    // pitch clamp.
    const errYaw = Math.atan2(_to.dot(_right), _to.dot(_fwd));
    const errPitch = Math.asin(clamp(_to.y, -1, 1)) - pitch;
    const mag = Math.hypot(errYaw, errPitch);
    if (mag > 1e-5) {
      const step = Math.min(pull, mag);
      // Yaw is negated because the view's yaw *decreases* to turn right — the
      // same convention the mouse and stick handlers use (`rawYaw -= dx`), and
      // the one `aimDirection` is built from.
      _result.yaw = -(errYaw / mag) * step;
      _result.pitch = (errPitch / mag) * step;
    }
  }
  return _result;
}
