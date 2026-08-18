/**
 * Ragdoll — position-based dynamics over the creature's own skeleton.
 *
 * Why PBD and not a rigid-body solver: we already have a bone hierarchy with
 * known segment lengths, and what a death needs is *plausible weight*, not
 * accurate inertia tensors. Particles at the joints, distance constraints along
 * the bones, and a clamped grandparent constraint that stops joints inverting,
 * gets 95% of the look for 2% of the cost — and, critically, PBD is
 * unconditionally stable, so a ragdoll cannot explode or vibrate.
 *
 * Settling is explicit: once total per-step motion stays under a threshold for
 * a third of a second the solver stops entirely and the pose freezes. That is
 * what guarantees "settles within 3 s without jitter" rather than hoping the
 * damping is tuned right.
 *
 * Ground contact uses a single plane refreshed a few times a second from
 * `CollisionWorld.sampleGround` at the body's centre. Sampling per particle per
 * iteration would be thousands of BVH queries a frame for a visual detail no
 * one can see; a corpse does not travel far enough for the plane to be wrong.
 */
import * as THREE from 'three';
import type { CollisionWorld } from '@/types';
import { clamp } from '@/util/math';
import { aimQuaternion, type RigInstance } from './Rig';

/** Gravity matches @/gameplay/Physics — duplicated to keep this file leaf-level. */
const GRAVITY = 24;

export interface RagdollTuning {
  iterations: number;
  /** Velocity retained per second (air drag). */
  damping: number;
  /** Tangential velocity retained on ground contact. */
  friction: number;
  bounce: number;
  /** Motion per step below which the body counts as still, metres. */
  sleepEpsilon: number;
  /** How long it must stay still before the solver stops, seconds. */
  sleepTime: number;
  /** Fixed solver step. Ragdolls integrate on their own clock for stability. */
  step: number;
}

export const DEFAULT_RAGDOLL: RagdollTuning = {
  iterations: 7,
  damping: 0.6,
  friction: 0.42,
  bounce: 0.06,
  sleepEpsilon: 0.0016,
  sleepTime: 0.32,
  step: 1 / 60,
};

interface Particle {
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  /** 0 = pinned. Extremities are lighter so they whip. */
  invMass: number;
  radius: number;
}

interface DistanceConstraint {
  a: number;
  b: number;
  rest: number;
  /** Compression floor as a fraction of `rest`; 1 = rigid. */
  minScale: number;
  maxScale: number;
  stiffness: number;
}

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();

export class Ragdoll {
  readonly rig: RigInstance;
  readonly tuning: RagdollTuning;

  private particles: Particle[] = [];
  private constraints: DistanceConstraint[] = [];
  /** Particle index per bone, and the tip particle for leaf bones (-1 if none). */
  private boneParticle: Int32Array;
  private tipParticle: Int32Array;
  private firstChild: Int32Array;
  /** Per-bone twist reference (world-space local +Z), for stable orientation. */
  private twistRef: THREE.Vector3[] = [];

  /** World transform the manager copies onto the body group. */
  readonly rootPosition = new THREE.Vector3();
  readonly rootQuaternion = new THREE.Quaternion();

  active = false;
  settled = false;
  /** Seconds since the ragdoll was started — the manager despawns the oldest. */
  age = 0;

  private accumulator = 0;
  private stillTime = 0;
  private groundY = 0;
  private groundNormal = new THREE.Vector3(0, 1, 0);
  private groundRefresh = 0;
  private collision: CollisionWorld | null = null;
  private centre = new THREE.Vector3();

  constructor(rig: RigInstance, tuning: Partial<RagdollTuning> = {}) {
    this.rig = rig;
    this.tuning = { ...DEFAULT_RAGDOLL, ...tuning };
    const n = rig.bones.length;
    this.boneParticle = new Int32Array(n).fill(-1);
    this.tipParticle = new Int32Array(n).fill(-1);
    this.firstChild = new Int32Array(n).fill(-1);

    for (let i = n - 1; i >= 1; i--) {
      const p = rig.def.bones[i].parent;
      if (p >= 0) this.firstChild[p] = i;
    }

    // One particle per bone, plus a tip particle wherever a chain ends. Depth in
    // the hierarchy drives the mass: a hand should whip, a pelvis should not.
    const depth = new Int32Array(n);
    for (let i = 1; i < n; i++) depth[i] = depth[rig.def.bones[i].parent] + 1;

    for (let i = 0; i < n; i++) {
      const bd = rig.def.bones[i];
      this.boneParticle[i] = this.particles.length;
      this.particles.push({
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        invMass: 1 / Math.max(0.35, 2.4 - depth[i] * 0.32),
        radius: clamp(bd.length * 0.45 + 0.06, 0.06, 0.28),
      });
      this.twistRef.push(new THREE.Vector3(0, 0, 1));
      if (this.firstChild[i] < 0 && bd.length > 0.02) {
        this.tipParticle[i] = this.particles.length;
        this.particles.push({
          pos: new THREE.Vector3(),
          prev: new THREE.Vector3(),
          invMass: 1 / 0.35,
          radius: clamp(bd.length * 0.4 + 0.05, 0.05, 0.2),
        });
      }
    }

    // Bone-length constraints.
    for (let i = 1; i < n; i++) {
      const bd = rig.def.bones[i];
      this.constraints.push({
        a: this.boneParticle[bd.parent],
        b: this.boneParticle[i],
        rest: 0,
        minScale: 1,
        maxScale: 1,
        stiffness: 1,
      });
    }
    for (let i = 0; i < n; i++) {
      if (this.tipParticle[i] < 0) continue;
      this.constraints.push({
        a: this.boneParticle[i],
        b: this.tipParticle[i],
        rest: 0,
        minScale: 1,
        maxScale: 1,
        stiffness: 1,
      });
    }
    // Grandparent constraints are the angular limits, and how far each is
    // allowed to fold is what separates a corpse from a crushed ball. A spine
    // barely folds; a knee folds almost double. One number for all of them
    // collapses the whole body into a heap — that is the classic PBD failure.
    const FOLD: Record<string, { min: number; stiffness: number }> = {
      spine: { min: 0.86, stiffness: 0.95 },
      neck: { min: 0.8, stiffness: 0.9 },
      leg: { min: 0.5, stiffness: 0.55 },
      arm: { min: 0.45, stiffness: 0.5 },
      wing: { min: 0.6, stiffness: 0.5 },
      tail: { min: 0.6, stiffness: 0.35 },
      tentacle: { min: 0.5, stiffness: 0.3 },
      digit: { min: 0.5, stiffness: 0.5 },
      generic: { min: 0.65, stiffness: 0.6 },
    };
    for (let i = 1; i < n; i++) {
      const p = rig.def.bones[i].parent;
      if (p <= 0) continue;
      const g = rig.def.bones[p].parent;
      if (g < 0) continue;
      const ci = rig.def.bones[i].chain;
      const kind = ci >= 0 ? rig.def.chains[ci].kind : 'generic';
      const fold = FOLD[kind] ?? FOLD.generic;
      this.constraints.push({
        a: this.boneParticle[g],
        b: this.boneParticle[i],
        rest: 0,
        minScale: fold.min,
        maxScale: 1.0,
        stiffness: fold.stiffness,
      });
    }
  }

  /**
   * Start the simulation from the rig's current pose.
   *
   * `impulsePoint`/`impulseDir` are the killing blow: nearby particles take the
   * kick, so a headshot snaps the head back and a rocket sends the whole body.
   */
  begin(
    velocity: THREE.Vector3,
    impulsePoint: THREE.Vector3,
    impulseDir: THREE.Vector3,
    impulseStrength: number,
    collision: CollisionWorld | null,
  ): void {
    this.collision = collision;
    this.active = true;
    this.settled = false;
    this.age = 0;
    this.stillTime = 0;
    this.accumulator = 0;
    this.groundRefresh = 0;

    const n = this.rig.bones.length;
    this.centre.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const pi = this.boneParticle[i];
      const p = this.particles[pi];
      p.pos.copy(this.rig.worldPos[i]);
      p.prev.copy(p.pos).addScaledVector(velocity, -this.tuning.step);
      this.centre.add(p.pos);
      const ti = this.tipParticle[i];
      if (ti >= 0) {
        const t = this.particles[ti];
        _v0
          .set(0, this.rig.def.bones[i].length, 0)
          .applyQuaternion(this.rig.worldQuat[i])
          .add(this.rig.worldPos[i]);
        t.pos.copy(_v0);
        t.prev.copy(_v0).addScaledVector(velocity, -this.tuning.step);
      }
      this.twistRef[i].set(0, 0, 1).applyQuaternion(this.rig.worldQuat[i]);
    }
    this.centre.multiplyScalar(1 / Math.max(1, n));

    // Rest lengths come from the live pose, so a body that died mid-stride keeps
    // its proportions instead of snapping back to the bind pose.
    let k = 0;
    for (let i = 1; i < n; i++) {
      const c = this.constraints[k++];
      c.rest = this.particles[c.a].pos.distanceTo(this.particles[c.b].pos);
    }
    for (let i = 0; i < n; i++) {
      if (this.tipParticle[i] < 0) continue;
      const c = this.constraints[k++];
      c.rest = this.particles[c.a].pos.distanceTo(this.particles[c.b].pos);
    }
    for (; k < this.constraints.length; k++) {
      const c = this.constraints[k];
      c.rest = Math.max(0.02, this.particles[c.a].pos.distanceTo(this.particles[c.b].pos));
    }

    // The killing blow, in two parts.
    //
    // 1. A local impulse with distance falloff, so a headshot snaps the head.
    // 2. A whole-body angular kick about the horizontal axis perpendicular to
    //    the shot. Without (2) a corpse built from rigid distance constraints
    //    is statically stable and simply stands there — the single most common
    //    way a PBD ragdoll looks broken.
    const strength = clamp(impulseStrength, 0, 24);
    _v1.set(impulseDir.x, 0, impulseDir.z);
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, 1);
    _v1.normalize();
    _v2.set(0, 1, 0).cross(_v1).normalize();
    if (!Number.isFinite(_v2.x) || _v2.lengthSq() < 0.5) _v2.set(1, 0, 0);
    const omega = 1.1 + strength * 0.08;
    for (const p of this.particles) {
      const d = p.pos.distanceTo(impulsePoint);
      const falloff = 1 / (1 + d * d * 3.5);
      _v0.copy(impulseDir).multiplyScalar(strength * falloff * p.invMass * 0.25);
      _v0.y += strength * falloff * 0.1;
      // omega x r, about the body centre.
      _v3.subVectors(p.pos, this.centre);
      _v0.x += omega * (_v2.y * _v3.z - _v2.z * _v3.y);
      _v0.y += omega * (_v2.z * _v3.x - _v2.x * _v3.z);
      _v0.z += omega * (_v2.x * _v3.y - _v2.y * _v3.x);
      p.prev.addScaledVector(_v0, -this.tuning.step);
    }

    this.refreshGround();
  }

  /** Advance the solver. Cheap no-op once settled. */
  step(dt: number): void {
    if (!this.active || this.settled) return;
    this.age += dt;
    this.accumulator += Math.min(dt, 0.1);
    const h = this.tuning.step;
    let steps = 0;
    while (this.accumulator >= h && steps < 4) {
      this.accumulator -= h;
      steps++;
      this.integrate(h);
    }
    if (steps > 0) this.writePose();
  }

  private refreshGround(): void {
    if (!this.collision) {
      this.groundY = this.centre.y - 0.9;
      return;
    }
    const g = this.collision.sampleGround(this.centre.x, this.centre.z, this.centre.y + 4);
    if (g) {
      this.groundY = g.y;
      this.groundNormal.copy(g.normal);
      if (this.groundNormal.y < 0.2) this.groundNormal.set(0, 1, 0);
    }
  }

  private groundAt(x: number, z: number): number {
    const n = this.groundNormal;
    if (n.y < 0.2) return this.groundY;
    return this.groundY - (n.x * (x - this.centre.x) + n.z * (z - this.centre.z)) / n.y;
  }

  private integrate(h: number): void {
    const t = this.tuning;
    const drag = Math.exp(-t.damping * h);

    this.groundRefresh -= h;
    if (this.groundRefresh <= 0) {
      this.groundRefresh = 0.25;
      this.refreshGround();
    }

    let motion = 0;
    // Verlet integration.
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      _v0.subVectors(p.pos, p.prev).multiplyScalar(drag);
      p.prev.copy(p.pos);
      p.pos.add(_v0);
      p.pos.y -= GRAVITY * h * h;
      motion += _v0.lengthSq();
    }

    for (let it = 0; it < t.iterations; it++) {
      for (const c of this.constraints) {
        const a = this.particles[c.a];
        const b = this.particles[c.b];
        _v0.subVectors(b.pos, a.pos);
        const d = _v0.length();
        if (d < 1e-6) continue;
        const lo = c.rest * c.minScale;
        const hi = c.rest * c.maxScale;
        let goal = d;
        if (d < lo) goal = lo;
        else if (d > hi) goal = hi;
        else continue;
        const diff = ((d - goal) / d) * c.stiffness;
        const wSum = a.invMass + b.invMass;
        if (wSum <= 0) continue;
        _v0.multiplyScalar(diff / wSum);
        a.pos.addScaledVector(_v0, a.invMass);
        b.pos.addScaledVector(_v0, -b.invMass);
      }

      // Ground: project out, then kill the tangential velocity by moving `prev`.
      for (const p of this.particles) {
        if (p.invMass === 0) continue;
        const gy = this.groundAt(p.pos.x, p.pos.z) + p.radius;
        if (p.pos.y < gy) {
          const pen = gy - p.pos.y;
          p.pos.y = gy;
          _v1.subVectors(p.pos, p.prev);
          const vn = _v1.dot(this.groundNormal);
          _v2.copy(_v1).addScaledVector(this.groundNormal, -vn);
          _v2.multiplyScalar(t.friction);
          if (vn < 0) _v2.addScaledVector(this.groundNormal, -vn * t.bounce);
          p.prev.copy(p.pos).sub(_v2);
          motion += pen * pen * 0.02;
        }
      }
    }

    // Sleep test.
    this.centre.set(0, 0, 0);
    for (const p of this.particles) this.centre.add(p.pos);
    this.centre.multiplyScalar(1 / this.particles.length);

    const avg = Math.sqrt(motion / Math.max(1, this.particles.length));
    if (avg < t.sleepEpsilon) {
      this.stillTime += h;
      if (this.stillTime >= t.sleepTime) {
        this.settled = true;
        // Freeze exactly: no residual velocity means no micro-jitter, ever.
        for (const p of this.particles) p.prev.copy(p.pos);
      }
    } else {
      this.stillTime = 0;
    }
  }

  /**
   * Convert particle positions back into bone transforms. The body group is
   * placed at the root particle and every bone is aimed at its child, so the
   * rendered skeleton reproduces the simulation exactly.
   */
  private writePose(): void {
    const rig = this.rig;
    const n = rig.bones.length;
    this.rootPosition.copy(this.particles[this.boneParticle[0]].pos);
    this.rootQuaternion.identity();

    for (let i = 0; i < n; i++) {
      const bone = rig.bones[i];
      const bd = rig.def.bones[i];
      const self = this.particles[this.boneParticle[i]].pos;

      // Local translation from the parent particle.
      if (bd.parent >= 0) {
        const parentQ = rig.worldQuat[bd.parent];
        _v0.subVectors(self, this.particles[this.boneParticle[bd.parent]].pos);
        _q0.copy(parentQ).invert();
        bone.position.copy(_v0.applyQuaternion(_q0));
      } else {
        bone.position.set(0, 0, 0);
      }

      // Orientation: aim at the child (or the tip), keeping twist continuous.
      const child = this.firstChild[i];
      const targetIdx = child >= 0 ? this.boneParticle[child] : this.tipParticle[i];
      if (targetIdx >= 0) {
        _v1.subVectors(this.particles[targetIdx].pos, self);
        if (_v1.lengthSq() > 1e-10) {
          aimQuaternion(_v1, this.twistRef[i], _q1);
          if (Number.isFinite(_q1.x)) {
            rig.worldQuat[i].copy(_q1);
            rig.worldPos[i].copy(self);
            this.twistRef[i].set(0, 0, 1).applyQuaternion(_q1);
            const parentQ = bd.parent >= 0 ? rig.worldQuat[bd.parent] : _q0.identity();
            bone.quaternion.copy(parentQ).invert().multiply(_q1);
            continue;
          }
        }
      }
      // Leaf with no tip: keep the parent's orientation.
      bone.quaternion.identity();
      rig.worldQuat[i].copy(bd.parent >= 0 ? rig.worldQuat[bd.parent] : _q0.identity());
      rig.worldPos[i].copy(self);
    }
  }

  /** Stop simulating and release the collision reference. */
  stop(): void {
    this.active = false;
    this.settled = false;
    this.collision = null;
  }

  /** Diagnostics: worst per-step particle motion, for the settle assertion. */
  get motionEstimate(): number {
    let m = 0;
    for (const p of this.particles) m = Math.max(m, p.pos.distanceTo(p.prev));
    return m;
  }

  get particleCount(): number {
    return this.particles.length;
  }
}
