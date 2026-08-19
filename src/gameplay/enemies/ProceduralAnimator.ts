/**
 * ProceduralAnimator — every enemy in this game moves without a single keyframe.
 *
 * The design in one page:
 *
 * 1. **Footstep planning owns the ground truth.** Each leg holds a *world-space*
 *    plant position. While a foot is in stance that position does not move, and
 *    IK drives the leg to it. Feet therefore cannot slide: sliding is only ever
 *    possible if we move a planted target, and we never do. When the body walks
 *    far enough that a planted foot would over-extend the leg, the planner
 *    triggers an early step rather than stretching — no rubber legs either.
 * 2. **The pelvis is derived, not authored.** Its height is clamped so no leg
 *    can exceed ~96% of its reach; its bob, sway and lean come from the gait
 *    phase and the body's own acceleration and turn rate, through springs. There
 *    is no canned curve anywhere in this file.
 * 3. **IK is analytic where it can be.** Two-segment limbs use the closed-form
 *    two-bone solution with a pole vector. Longer chains (digitigrade legs,
 *    tails, necks, tentacles) use FABRIK, plane-constrained for legs so the
 *    knee/hock never inverts.
 * 4. **Everything else is an additive layer** blended by weight: breathing,
 *    look-at, flinch, attack, recharge. Layers are springs, so the blend in and
 *    out is continuous and nothing can pop.
 *
 * ### LOD
 * `AnimationLod` selects how much of the above runs. At `full` everything does;
 * at `reduced` the arms stop solving IK; at `coarse` the legs stop solving IK
 * and swing by direct rotation; at `distant` only the root and facing update.
 * The manager also drops the *rate* — a distant unit animates every 6th frame.
 * The output stays continuous because all of it is spring-smoothed.
 */
import * as THREE from 'three';
import type { CollisionWorld } from '@/types';
import { clamp, clamp01, damp, lerp, smoothstep, TAU } from '@/util/math';
import { aimQuaternion, type ChainRuntime, type Rig, type RigInstance } from './Rig';

export type AnimationLod = 'full' | 'reduced' | 'coarse' | 'distant';

/** What the species `animate()` hook receives, after the base pass has run. */
export interface AnimationContext {
  /** Seconds since the last animation update for this agent (LOD-scaled). */
  dt: number;
  elapsed: number;
  lod: AnimationLod;
  collision: CollisionWorld | null;
  /** Point the creature should look at (usually the player's head). */
  focus: THREE.Vector3;
  focusValid: boolean;
}

export interface AnimatorTuning {
  /** Distance from hip to ground when standing. Derived from the rig if absent. */
  standHeight: number;
  /** Speed at which the gait is considered a full run. */
  runSpeed: number;
  /** Stride length multiplier against leg reach. */
  strideScale: number;
  /** Vertical bob amplitude in metres at full run. */
  bob: number;
  /** Lateral sway amplitude in metres at full run. */
  sway: number;
  /** How hard the body leans into acceleration, radians per m/s². */
  leanAccel: number;
  /** How hard the body banks into a turn, radians per rad/s. */
  leanTurn: number;
  /** Head/neck/chest look-at share; must sum to <= 1. */
  lookShare: [number, number, number];
  /** Look-at yaw and pitch limits, radians. */
  lookYawLimit: number;
  lookPitchLimit: number;
  /** Breathing rate (Hz) and amplitude (radians). */
  breathRate: number;
  breathAmount: number;
  /** Wing beats per second at hover, and the extra beats at full thrust. */
  wingRate: number;
  wingAmplitude: number;
  /** Foot lift arc height as a fraction of stride length. */
  liftScale: number;
  /** Which way legs bend: +1 knee forward (plantigrade), -1 knee back (avian). */
  kneeSign: number;
}

export const DEFAULT_TUNING: AnimatorTuning = {
  standHeight: 0.9,
  runSpeed: 6,
  strideScale: 0.62,
  bob: 0.045,
  sway: 0.03,
  leanAccel: 0.02,
  leanTurn: 0.16,
  lookShare: [0.55, 0.28, 0.17],
  lookYawLimit: 1.75,
  lookPitchLimit: 0.85,
  breathRate: 0.55,
  breathAmount: 0.035,
  wingRate: 2.6,
  wingAmplitude: 0.85,
  liftScale: 0.34,
  kneeSign: 1,
};

/** Per-leg gait state. All positions are world space. */
interface FootState {
  chain: ChainRuntime;
  phase: number;
  /** Where the foot is planted right now (fixed during stance). */
  plant: THREE.Vector3;
  /** Where it lifted from, and where it is heading. */
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Live IK target — equals `plant` in stance, the swing arc in flight. */
  target: THREE.Vector3;
  normal: THREE.Vector3;
  pole: THREE.Vector3;
  planted: boolean;
  /** Elapsed swing time and its duration; -1 while in stance. */
  swingT: number;
  swingDur: number;
  /** Last completed gait cycle index, for wrap-free step triggering. */
  lastCycle: number;
  /** Body-space hip offset, used to place the step under the right shoulder. */
  hipLocal: THREE.Vector3;
  /** Ankle height above the plant point at rest. */
  ankleLift: number;
  /** Joint index the IK actually drives (the ankle). */
  ikJoint: number;
  /** Reach of the IK portion only — hip to ankle, excluding the foot. */
  ikReach: number;
  /** True when the foot was already planted at the previous animator update. */
  wasPlanted: boolean;
  /** Diagnostics: worst world-space movement of a planted foot, metres. */
  slide: number;
  lastWorld: THREE.Vector3;
  stepCount: number;
  /** `stepCount` at the previous slide sample, so steps are not counted as slide. */
  lastSampleStep: number;
}

interface SpringVec {
  value: THREE.Vector3;
  vel: THREE.Vector3;
}

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
// Solver-private scratch. Kept distinct from _v0.._v4 because callers routinely
// pass one of those in as an output, and a shared temporary silently corrupts it.
const _s0 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _s4 = new THREE.Vector3();
// Bone-writeback scratch. `aimBone`/`setBoneWorldAim` are called with caller
// vectors as arguments, so they must not touch _v0.._v4 at all: an aliased
// temporary here silently aims a bone at itself, which is exactly how limbs end
// up pointing at the sky.
const _k0 = new THREE.Vector3();
const _k1 = new THREE.Vector3();
const _k2 = new THREE.Vector3();

/**
 * Closed-form two-bone IK. Places `outMid` so that a chain of `l1`,`l2` from
 * `root` reaches `target`, bending toward `pole`. Over-extension is handled by
 * clamping the reach, which straightens the limb rather than tearing it.
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  outMid: THREE.Vector3,
): void {
  const toTarget = _s0.subVectors(target, root);
  let d = toTarget.length();
  if (d < 1e-5) {
    toTarget.set(0, -1, 0);
    d = 1e-5;
  }
  const maxReach = (l1 + l2) * 0.999;
  const minReach = Math.abs(l1 - l2) * 1.001 + 1e-4;
  const dc = clamp(d, minReach, maxReach);
  const u = _s1.copy(toTarget).multiplyScalar(1 / d);

  // Cosine rule for the angle at the root joint.
  const cosA = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

  // Bend plane: the component of the pole direction perpendicular to the limb.
  const poleDir = _s2.subVectors(pole, root);
  poleDir.addScaledVector(u, -poleDir.dot(u));
  if (poleDir.lengthSq() < 1e-8) {
    // Degenerate pole: pick any perpendicular deterministically.
    poleDir.set(-u.y, u.x, u.z).addScaledVector(u, -(-u.y * u.x + u.x * u.y + u.z * u.z));
    if (poleDir.lengthSq() < 1e-8) poleDir.set(1, 0, 0).addScaledVector(u, -u.x);
    if (poleDir.lengthSq() < 1e-8) poleDir.set(0, 0, 1).addScaledVector(u, -u.z);
  }
  poleDir.normalize();

  outMid
    .copy(root)
    .addScaledVector(u, l1 * cosA)
    .addScaledVector(poleDir, l1 * sinA);
}

/**
 * FABRIK for chains longer than two segments. `points` holds `n+1` joint
 * positions; `points[0]` is pinned to the root. Runs a fixed small number of
 * iterations — enough to converge for the short chains creatures actually have.
 */
export function solveFabrik(
  points: THREE.Vector3[],
  lengths: number[],
  target: THREE.Vector3,
  iterations = 6,
): void {
  const n = lengths.length;
  const rootPos = _s3.copy(points[0]);
  // The target may alias one of `points`, so snapshot it before solving.
  const goal = _s4.copy(target);
  let total = 0;
  for (let i = 0; i < n; i++) total += lengths[i];
  const dist = rootPos.distanceTo(goal);

  if (dist > total * 0.999) {
    // Out of reach: lay the chain straight at the target.
    const dir = _s0.subVectors(goal, rootPos).normalize();
    for (let i = 1; i <= n; i++) {
      points[i].copy(points[i - 1]).addScaledVector(dir, lengths[i - 1]);
    }
    return;
  }

  for (let it = 0; it < iterations; it++) {
    // Backward: pull the tip to the target.
    points[n].copy(goal);
    for (let i = n - 1; i >= 0; i--) {
      const d = _s0.subVectors(points[i], points[i + 1]);
      const len = d.length();
      if (len < 1e-8) d.set(0, 1, 0);
      else d.multiplyScalar(1 / len);
      points[i].copy(points[i + 1]).addScaledVector(d, lengths[i]);
    }
    // Forward: pin the root back down.
    points[0].copy(rootPos);
    for (let i = 0; i < n; i++) {
      const d = _s0.subVectors(points[i + 1], points[i]);
      const len = d.length();
      if (len < 1e-8) d.set(0, 1, 0);
      else d.multiplyScalar(1 / len);
      points[i + 1].copy(points[i]).addScaledVector(d, lengths[i]);
    }
  }
}

/** Per-frame inputs the manager hands the animator. */
export interface AnimatorInput {
  dt: number;
  elapsed: number;
  lod: AnimationLod;
  /** World position of the body root (feet-level origin). */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  /** Angular velocity of the yaw, rad/s. */
  yawRate: number;
  grounded: boolean;
  /** Ground height under the root, and its normal. */
  groundY: number;
  groundNormal: THREE.Vector3;
  collision: CollisionWorld | null;
  focus: THREE.Vector3;
  focusValid: boolean;
  /** 0..1 desired flight thrust for winged units. */
  thrust: number;
}

export class ProceduralAnimator {
  readonly rig: RigInstance;
  readonly tuning: AnimatorTuning;

  /** The transform the manager writes onto the body group each frame. */
  readonly rootPosition = new THREE.Vector3();
  readonly rootQuaternion = new THREE.Quaternion();

  // -- chains ---------------------------------------------------------------
  private spine: ChainRuntime | null;
  /**
   * Per-spine-bone rotation axes expressed in that bone's *rest local* frame.
   * A spine may run vertically (a biped) or horizontally (a quadruped), so
   * "yaw" is not always the bone's local +Y. Resolving the body's up/right/
   * forward into each bone's own frame is what makes one look-at implementation
   * work for both without a special case.
   */
  private spineYawAxis: THREE.Vector3[] = [];
  private spinePitchAxis: THREE.Vector3[] = [];
  private spineRollAxis: THREE.Vector3[] = [];
  private legs: FootState[] = [];
  private arms: ChainRuntime[] = [];
  private tails: ChainRuntime[] = [];
  private wings: ChainRuntime[] = [];

  // -- gait -----------------------------------------------------------------
  private gaitTime = 0;
  private cadence = 0;
  private stride = 0;
  private duty = 0.68;
  private speed = 0;
  /**
   * How far a planted foot may sit from its hip, horizontally. Derived from the
   * leg's IK reach and the current hip height — the single number that decides
   * whether a gait can be foot-planted at a given speed, and therefore the
   * number everything else in the planner is built around.
   */
  private stepRadius = 0.4;
  private gaitWeight = 0;
  private legReach = 1;
  private prevVelocity = new THREE.Vector3();
  private prevRoot = new THREE.Vector3();
  private prevRootQuat = new THREE.Quaternion();
  private targetRoot = new THREE.Vector3();
  private targetRootQuat = new THREE.Quaternion();
  private accel = new THREE.Vector3();
  /** Rises to 1 when the creature is airborne so the legs tuck instead of walking. */
  private airborne = 0;

  // -- springs --------------------------------------------------------------
  private pelvisOffset: SpringVec = { value: new THREE.Vector3(), vel: new THREE.Vector3() };
  private pelvisTarget = new THREE.Vector3();
  private leanSpring: SpringVec = { value: new THREE.Vector3(), vel: new THREE.Vector3() };
  private leanTarget = new THREE.Vector3();
  private lookYaw = 0;
  private lookPitch = 0;
  private bank = 0;

  // -- additive layers ------------------------------------------------------
  /** Per-chain flinch springs, keyed by chain index. */
  private flinch: SpringVec[] = [];
  private breathPhase = 0;
  /** 0 = idle, else the attack timeline in seconds. */
  private attackTime = -1;
  private attackWindup = 0.35;
  private attackStrike = 0.12;
  private attackRecover = 0.4;
  private attackWeight = 0;
  private attackChain = -1;
  private recharge = 0;
  private staggerSpring: SpringVec = { value: new THREE.Vector3(), vel: new THREE.Vector3() };

  /** Diagnostics for the capture harness. */
  maxFootSlide = 0;
  /** Context captured at the worst slide: speed, reach ratio, dt. */
  readonly slideDiag = { speed: 0, ratio: 0, dt: 0, lod: 0, cadence: 0 };
  /**
   * Worst distance between a planted foot and where the planner put it. This,
   * not frame-to-frame motion, is the honest "does the foot slide" number: it
   * is immune to the sample interval and to steps taken between samples, and it
   * is non-zero only when IK could not reach the plant.
   */
  maxPlantError = 0;
  stepEvents = 0;
  /** Set by the manager when a foot plants, for audio/VFX. */
  onFootPlant: ((foot: number, position: THREE.Vector3, normal: THREE.Vector3) => void) | null = null;

  /** Scratch joint buffer for FABRIK, sized to the longest chain in the rig. */
  private fabrikPts: THREE.Vector3[] = [];
  private fabrikLens: number[] = [];
  private initialised = false;
  private lastDt = 0;
  /** Measured sole clearance per leg chain; see `BuiltBody.footLift`. */
  private footLift: readonly number[] | null = null;

  constructor(
    rig: RigInstance,
    tuning: Partial<AnimatorTuning> = {},
    footLift?: readonly number[],
  ) {
    this.rig = rig;
    this.footLift = footLift ?? null;
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
    this.spine = rig.chainsOfKind('spine')[0] ?? rig.chainsOfKind('neck')[0] ?? null;

    let longest = 0;
    for (const c of rig.chains) longest = Math.max(longest, c.indices.length);
    for (let i = 0; i <= longest + 1; i++) {
      this.fabrikPts.push(new THREE.Vector3());
      this.fabrikLens.push(0);
    }
    for (let i = 0; i < rig.chains.length; i++) {
      this.flinch.push({ value: new THREE.Vector3(), vel: new THREE.Vector3() });
    }

    for (const c of rig.chains) {
      switch (c.def.kind) {
        case 'leg':
          this.legs.push(this.makeFoot(c, this.footLift?.[this.legs.length]));
          break;
        case 'arm':
          this.arms.push(c);
          break;
        case 'tail':
        case 'tentacle':
          this.tails.push(c);
          break;
        case 'wing':
          this.wings.push(c);
          break;
        default:
          break;
      }
    }
    if (this.spine) {
      for (const gi of this.spine.indices) {
        const inv = new THREE.Quaternion().copy(rig.def.bones[gi].worldQuat).invert();
        this.spineYawAxis.push(new THREE.Vector3(0, 1, 0).applyQuaternion(inv).normalize());
        this.spinePitchAxis.push(new THREE.Vector3(1, 0, 0).applyQuaternion(inv).normalize());
        this.spineRollAxis.push(new THREE.Vector3(0, 0, -1).applyQuaternion(inv).normalize());
      }
    }

    if (this.legs.length) {
      this.legReach = this.legs[0].chain.reach;
      if (tuning.standHeight == null) {
        // Stand at 88% of leg reach below the hip — a creature at rest is never
        // locked straight, and that 12% is the compliance the gait needs.
        this.tuning.standHeight = this.legs[0].chain.def.origin.y;
      }
    }
  }

  private makeFoot(chain: ChainRuntime, measuredLift?: number): FootState {
    const nSeg = chain.lengths.length;
    // A leg of 4+ parts ends in a foot bone; IK drives the joint before it.
    const hasFoot = nSeg >= 3;
    const ikJoint = hasFoot ? nSeg - 1 : nSeg;
    // The fallback — a fraction of the last bone's length — knows nothing about
    // how thick the foot mesh is, and left every unit in the game hovering
    // 5-13 cm above the floor. The measured figure replaces it, but only ever
    // downward: a measurement that would *raise* the body is a sign the sole is
    // not where the geometry search thinks it is (radial hexapod feet whose
    // claws splay outward rather than hanging under the joint), and raising a
    // body is a defect the fallback never had.
    const guess = hasFoot ? chain.lengths[nSeg - 1] * 0.85 : 0.05;
    const ankleLift =
      measuredLift != null && Number.isFinite(measuredLift)
        ? clamp(Math.min(measuredLift, guess), 0, chain.reach * 0.4)
        : guess;
    let ikReach = 0;
    for (let i = 0; i < ikJoint; i++) ikReach += chain.lengths[i];
    return {
      chain,
      phase: chain.def.gaitPhase,
      plant: new THREE.Vector3(),
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      target: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      pole: new THREE.Vector3(),
      planted: true,
      wasPlanted: true,
      swingT: -1,
      swingDur: 0.3,
      lastCycle: 0,
      hipLocal: chain.def.origin.clone(),
      ankleLift,
      ikJoint,
      ikReach,
      slide: 0,
      lastWorld: new THREE.Vector3(),
      stepCount: 0,
      lastSampleStep: 0,
    };
  }

  /** Snap every foot under the body — used on spawn and after a teleport. */
  reset(position: THREE.Vector3, yaw: number, groundY: number): void {
    this.rootPosition.copy(position);
    this.rootPosition.y = groundY;
    this.rootQuaternion.setFromAxisAngle(_v0.set(0, 1, 0), yaw);
    this.gaitTime = 0;
    this.cadence = 0;
    this.speed = 0;
    this.gaitWeight = 0;
    this.airborne = 0;
    this.attackTime = -1;
    this.attackWeight = 0;
    this.recharge = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.bank = 0;
    this.maxFootSlide = 0;
    this.maxPlantError = 0;
    this.pelvisOffset.value.set(0, 0, 0);
    this.pelvisOffset.vel.set(0, 0, 0);
    this.leanSpring.value.set(0, 0, 0);
    this.leanSpring.vel.set(0, 0, 0);
    this.staggerSpring.value.set(0, 0, 0);
    this.staggerSpring.vel.set(0, 0, 0);
    for (const f of this.flinch) {
      f.value.set(0, 0, 0);
      f.vel.set(0, 0, 0);
    }
    this.rig.resetPose();
    this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
    for (const foot of this.legs) {
      const hip = _v0.copy(foot.hipLocal).applyQuaternion(this.rootQuaternion).add(this.rootPosition);
      foot.plant.set(hip.x, groundY, hip.z);
      foot.from.copy(foot.plant);
      foot.to.copy(foot.plant);
      foot.target.copy(foot.plant);
      foot.normal.set(0, 1, 0);
      foot.planted = true;
      foot.wasPlanted = false;
      foot.swingT = -1;
      foot.lastWorld.copy(foot.plant);
      foot.phase = foot.chain.def.gaitPhase;
      foot.lastCycle = Math.floor(foot.chain.def.gaitPhase - this.duty);
    }
    this.prevVelocity.set(0, 0, 0);
    this.prevRoot.copy(this.rootPosition);
    this.prevRootQuat.copy(this.rootQuaternion);
    this.initialised = true;
  }

  // -- external impulses -----------------------------------------------------

  /**
   * A hit landed. `worldPoint` selects the nearest chain, and the impulse goes
   * into that chain's flinch spring plus a whole-body stagger.
   */
  hit(worldPoint: THREE.Vector3, direction: THREE.Vector3, strength: number): void {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.rig.chains.length; i++) {
      const c = this.rig.chains[i];
      const d = c.world[0].distanceToSquared(worldPoint);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      const s = clamp(strength, 0, 3);
      this.flinch[best].vel.addScaledVector(direction, s * 9);
    }
    this.staggerSpring.vel.addScaledVector(direction, clamp(strength, 0, 3) * 2.4);
  }

  /** Begin an attack timeline. The pose blend is driven from it every frame. */
  attack(windup = 0.35, strike = 0.12, recover = 0.4, chainIndex = -1): void {
    this.attackTime = 0;
    this.attackWindup = Math.max(0.02, windup);
    this.attackStrike = Math.max(0.02, strike);
    this.attackRecover = Math.max(0.02, recover);
    this.attackChain = chainIndex;
  }

  /** True while the strike window is open — the frame the damage should land. */
  get attackStriking(): boolean {
    return (
      this.attackTime >= this.attackWindup &&
      this.attackTime < this.attackWindup + this.attackStrike
    );
  }

  /** 0..1 attack progress, or -1 when idle. */
  get attackProgress(): number {
    if (this.attackTime < 0) return -1;
    const total = this.attackWindup + this.attackStrike + this.attackRecover;
    return clamp01(this.attackTime / total);
  }

  /** Drive a reload/recharge pose over `seconds`. */
  rechargeFor(seconds: number): void {
    this.recharge = Math.max(0.05, seconds);
  }

  get busy(): boolean {
    return this.attackTime >= 0 || this.recharge > 0;
  }

  /** True while a hit impulse is still visibly rocking the body. */
  get staggering(): boolean {
    return this.staggerSpring.value.lengthSq() > 0.0025;
  }

  // -- the frame ------------------------------------------------------------

  update(input: AnimatorInput): void {
    // Clamped generously rather than tightly: the gait planner is sub-stepped, so
    // a long frame is handled correctly, whereas *truncating* dt would make the
    // planner believe the body moved less than it did and over-extend the legs.
    const dt = Math.min(Math.max(input.dt, 1e-4), 0.25);
    this.lastDt = dt;
    if (!this.initialised) this.reset(input.position, input.yaw, input.groundY);

    // -- body transform -----------------------------------------------------
    this.speed = Math.hypot(input.velocity.x, input.velocity.z);
    this.accel
      .subVectors(input.velocity, this.prevVelocity)
      .multiplyScalar(1 / dt);
    this.prevVelocity.copy(input.velocity);
    // Cap the derived acceleration: a teleport or a spawn must not fling the
    // lean springs into orbit.
    if (this.accel.lengthSq() > 900) this.accel.setLength(30);

    this.airborne = damp(this.airborne, input.grounded ? 0 : 1, 7, dt);

    // The body root sits at the *ground*; the pelvis bob rides on the hips bone
    // alone, so the feet stay where the planner put them.
    this.rootPosition.set(
      input.position.x,
      input.grounded ? input.groundY : input.position.y,
      input.position.z,
    );
    _q0.setFromAxisAngle(_v0.set(0, 1, 0), input.yaw);

    // Bank into the turn — subtle on ground units, pronounced on flyers.
    const bankTarget = clamp(-input.yawRate * clamp01(this.speed / this.tuning.runSpeed), -1.1, 1.1) *
      (this.wings.length ? 0.65 : this.tuning.leanTurn);
    this.bank = damp(this.bank, bankTarget, 6, dt);
    _q1.setFromAxisAngle(_v0.set(0, 0, -1), this.bank);
    this.rootQuaternion.copy(_q0).multiply(_q1);

    // -- gait + pelvis, sub-stepped ----------------------------------------
    // The footstep planner is the one part of this file that is *not* safe at
    // an arbitrary dt: it can only react to over-extension once per update, so
    // a 100 ms frame lets a running body drag a planted foot 40 cm before the
    // early-step fires. Sub-stepping at 45 Hz makes the plant exact regardless
    // of frame rate, and costs nothing at 60 fps because it never splits.
    // Only a *moving* body can out-run its footstep planner, so a standing
    // creature never pays for sub-stepping — which is most of the roster most
    // of the time.
    const sub =
      this.legs.length && this.speed > 0.4 ? clamp(Math.ceil(dt * 60), 1, 8) : 1;
    const h = dt / sub;
    this.targetRoot.copy(this.rootPosition);
    this.targetRootQuat.copy(this.rootQuaternion);
    for (let i = 1; i <= sub; i++) {
      const t = i / sub;
      if (sub > 1) {
        this.rootPosition.lerpVectors(this.prevRoot, this.targetRoot, t);
        this.rootQuaternion.slerpQuaternions(this.prevRootQuat, this.targetRootQuat, t);
      }
      this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
      if (this.legs.length) this.updateGait(input, h);
      this.updatePelvis(input, h);
    }
    this.prevRoot.copy(this.rootPosition);
    this.prevRootQuat.copy(this.rootQuaternion);

    // -- spine, look-at, breathing -----------------------------------------
    this.updateSpine(input, dt);

    // -- limbs --------------------------------------------------------------
    if (input.lod !== 'distant') {
      if (this.legs.length) {
        if (input.lod === 'coarse') this.poseLegsCoarse(dt);
        else this.poseLegsIk();
      }
      if (this.wings.length) this.updateWings(input, dt);
      if (input.lod === 'full' || input.lod === 'reduced') this.updateTails(input, dt);
      if (input.lod === 'full') this.updateArms(input, dt);
    }

    // -- additive layers ----------------------------------------------------
    this.updateLayers(dt);

    // The body root carries the stagger lean, so a hit rocks the whole creature.
    if (this.staggerSpring.value.lengthSq() > 1e-8) {
      _v1.copy(this.staggerSpring.value);
      const amount = clamp(_v1.length(), 0, 0.5);
      _v2.set(_v1.z, 0, -_v1.x).normalize();
      if (_v2.lengthSq() > 0.5) {
        _q2.setFromAxisAngle(_v2, amount * 0.7);
        this.rootQuaternion.multiply(_q2);
      }
    }

    this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
    // Only meaningful when the legs actually solved IK this frame; the coarse
    // and distant LODs pose legs by rotation and do not aim for the plant.
    if (input.lod === 'full' || input.lod === 'reduced') this.trackSlide();
  }

  // -- gait ------------------------------------------------------------------

  private updateGait(input: AnimatorInput, dt: number): void {
    const t = this.tuning;
    const reach = this.legReach;
    const targetSpeed = this.speed;
    this.gaitWeight = damp(this.gaitWeight, smoothstep(targetSpeed / 0.35), 12, dt);
    this.duty = clamp(lerp(0.74, 0.44, clamp01(targetSpeed / t.runSpeed)), 0.4, 0.86);

    // Step radius: how far the foot can be from the hip on the ground. A leg
    // that is nearly straight when standing has almost none, which is why the
    // rig must give its legs ~12% slack at rest.
    const f0 = this.legs[0];
    const hipHeight = Math.max(
      0.05,
      f0.chain.world[0].y - (f0.plant.y + f0.ankleLift),
    );
    const usable = f0.ikReach * 0.95;
    this.stepRadius = Math.sqrt(Math.max(0.0025, usable * usable - hipHeight * hipHeight));

    // Cadence is *derived*, not chosen: a planted foot must travel no further
    // than 2 * stepRadius during its stance, so the step rate has to rise with
    // speed. Get this wrong and the only outcomes are sliding or rubber legs.
    const usableSpan = Math.max(0.08, this.stepRadius * 1.7);
    const cadenceNeeded = (targetSpeed * this.duty) / usableSpan;
    // Style: prefer a longer stride at low speed so a walk does not mince.
    const styleStride = clamp(targetSpeed * 0.5, 0.25, usableSpan);
    const cadenceStyle = styleStride > 1e-3 ? targetSpeed / styleStride : 0;
    // Turning in place still needs steps, or the feet twist through the floor.
    const turnCadence = Math.abs(input.yawRate) * 0.5;
    const target = clamp(Math.max(cadenceNeeded, cadenceStyle, turnCadence), 0, 4.6);
    this.cadence = damp(this.cadence, target, 10, dt);
    this.stride = this.cadence > 0.05 ? targetSpeed / this.cadence : reach * 0.2;

    const moving = target > 0.12;
    let anySwing = false;
    for (const f of this.legs) if (!f.planted) anySwing = true;
    // When the creature stops we keep the clock running only long enough for
    // every airborne foot to land. Freezing mid-swing is the classic "one leg
    // stuck out" artefact.
    if (moving || anySwing) this.gaitTime += Math.max(this.cadence, 0.55) * dt;

    const swingTime = clamp((1 - this.duty) / Math.max(0.35, this.cadence), 0.1, 0.75);
    const stanceTime = clamp(this.duty / Math.max(0.35, this.cadence), 0.1, 1.6);
    const lift = Math.max(0.055, this.stride * this.tuning.liftScale);

    for (let i = 0; i < this.legs.length; i++) {
      const f = this.legs[i];
      // Unwrapped cycle coordinate: a step fires each time it crosses `duty`,
      // with no modulo wrap-around edge case to get wrong.
      const u = this.gaitTime + f.chain.def.gaitPhase;
      const cycle = Math.floor(u - this.duty);
      f.phase = u - Math.floor(u);

      // The *animated* hip, which already carries the pelvis bob/sway/drop.
      // Using the rest-pose hip here would let the leg silently over-extend by
      // exactly the amount the pelvis moved, and that shows up as slide.
      const hip = _v0.copy(f.chain.world[0]);

      // Force an early step the moment the planted foot's ankle target leaves
      // the leg's reach. This is the anti-slide guarantee: IK clamping is the
      // only thing that can move a planted foot, so we step before it can.
      let forceStep = false;
      if (f.planted) {
        const ax = f.plant.x + f.normal.x * f.ankleLift - hip.x;
        const ay = f.plant.y + f.normal.y * f.ankleLift - hip.y;
        const az = f.plant.z + f.normal.z * f.ankleLift - hip.z;
        const limit = f.ikReach * 0.96;
        if (ax * ax + ay * ay + az * az > limit * limit) forceStep = true;
      }

      const scheduled = cycle > f.lastCycle;
      if (f.planted && (forceStep || (scheduled && moving))) {
        f.from.copy(f.plant);
        this.planFootfall(f, hip, input, swingTime, stanceTime);
        f.planted = false;
        f.swingT = 0;
        f.swingDur = swingTime;
        f.lastCycle = cycle;
        this.stepEvents++;
        f.stepCount++;
      } else if (scheduled) {
        f.lastCycle = cycle;
      }

      if (f.planted) {
        f.target.copy(f.plant);
      } else {
        f.swingT += dt;
        const s = clamp01(f.swingT / Math.max(1e-3, f.swingDur));
        f.target.lerpVectors(f.from, f.to, smoothstep(s));
        f.target.y += Math.sin(s * Math.PI) * lift;
        if (s >= 1) {
          f.planted = true;
          f.swingT = -1;
          f.plant.copy(f.to);
          f.target.copy(f.plant);
          this.onFootPlant?.(i, f.plant, f.normal);
        }
      }
    }
  }

  /**
   * Choose where a foot lands: under the hip, half a stride ahead, plus the
   * distance the body will cover during the swing. Then sample the ground so
   * feet land on terrain rather than on an imaginary plane.
   */
  private planFootfall(
    f: FootState,
    hip: THREE.Vector3,
    input: AnimatorInput,
    swingTime: number,
    stanceTime: number,
  ): void {
    // Where the hip will be when this foot lands, plus half a stance ahead of
    // it, so the foot spends stance travelling symmetrically hip-forward to
    // hip-back and never runs out of leg at either end.
    const lead = clamp(swingTime + stanceTime * 0.5, 0, 0.8);
    _v1.set(hip.x + input.velocity.x * lead, hip.y, hip.z + input.velocity.z * lead);

    // Turning: swing the target around the body so the feet lead the rotation.
    if (Math.abs(input.yawRate) > 0.2) {
      const a = clamp(input.yawRate * lead, -0.8, 0.8);
      const dx = _v1.x - this.rootPosition.x;
      const dz = _v1.z - this.rootPosition.z;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      _v1.x = this.rootPosition.x + dx * c - dz * sn;
      _v1.z = this.rootPosition.z + dx * sn + dz * c;
    }

    // Clamp against the hip *at landing*, not the hip now.
    const hx = hip.x + input.velocity.x * swingTime;
    const hz = hip.z + input.velocity.z * swingTime;
    const dx = _v1.x - hx;
    const dz = _v1.z - hz;
    const horiz = Math.hypot(dx, dz);
    const maxHoriz = this.stepRadius * 0.95;
    if (horiz > maxHoriz) {
      const k = maxHoriz / horiz;
      _v1.x = hx + dx * k;
      _v1.z = hz + dz * k;
    }

    let y = input.groundY;
    f.normal.copy(input.groundNormal);
    if (input.collision) {
      const g = input.collision.sampleGround(_v1.x, _v1.z, hip.y + f.ikReach);
      if (g) {
        // Refuse a step onto a ledge the leg cannot reach down to.
        y = clamp(g.y, input.groundY - f.ikReach * 0.5, input.groundY + f.ikReach * 0.45);
        f.normal.copy(g.normal);
      }
    }
    f.to.set(_v1.x, y, _v1.z);
  }

  // -- pelvis ----------------------------------------------------------------

  private updatePelvis(input: AnimatorInput, dt: number): void {
    const t = this.tuning;
    const speedN = clamp01(this.speed / t.runSpeed);

    // Bob: two dips per gait cycle for a biped, one per leg pair in general.
    const cycles = this.legs.length >= 4 ? this.legs.length * 0.5 : 2;
    const bob = -Math.abs(Math.sin(this.gaitTime * Math.PI * cycles)) * t.bob * speedN * this.gaitWeight;

    // Sway toward whichever side is currently loaded.
    let sway = 0;
    if (this.legs.length === 2) {
      sway = Math.sin(this.gaitTime * TAU) * t.sway * speedN * this.gaitWeight;
    }

    // Hard constraint: the pelvis must stay inside every planted leg's reach.
    // This is computed from the *offset-free* hip position, so it is a target
    // for the spring rather than a feedback loop on the spring's own output.
    let drop = 0;
    for (const f of this.legs) {
      if (!f.planted) continue;
      const hip = _v0.copy(f.hipLocal).applyQuaternion(this.rootQuaternion).add(this.rootPosition);
      const dx = hip.x - f.plant.x;
      const dz = hip.z - f.plant.z;
      const horiz2 = dx * dx + dz * dz;
      const limit = f.ikReach * 0.95;
      const vertical = Math.sqrt(Math.max(0, limit * limit - horiz2));
      // > 0 means the hip sits higher than this leg can reach: crouch into it.
      drop = Math.max(drop, hip.y - (f.plant.y + f.ankleLift) - vertical);
    }
    drop = clamp(drop, 0, this.legReach * 0.45);

    this.pelvisTarget.set(sway, bob - drop, 0);
    springTo(this.pelvisOffset, this.pelvisTarget, 260, 26, dt);

    // Lean: forward into acceleration, sideways out of a turn.
    const fwd = _v1.set(-Math.sin(input.yaw), 0, -Math.cos(input.yaw));
    const right = _v2.set(fwd.z, 0, -fwd.x);
    const aF = this.accel.dot(fwd);
    const aR = this.accel.dot(right);
    this.leanTarget.set(
      clamp(-aF * t.leanAccel, -0.28, 0.28),
      0,
      clamp(aR * t.leanAccel * 0.8, -0.22, 0.22),
    );
    springTo(this.leanSpring, this.leanTarget, 60, 12, dt);
  }

  // -- spine -----------------------------------------------------------------

  private updateSpine(input: AnimatorInput, dt: number): void {
    const chain = this.spine;
    if (!chain) return;
    const t = this.tuning;
    const n = chain.bones.length;

    // Desired look angles, relative to the body's facing.
    let wantYaw = 0;
    let wantPitch = 0;
    if (input.focusValid && n >= 2) {
      const head = chain.world[n - 1];
      _v0.subVectors(input.focus, head);
      const dist = _v0.length();
      if (dist > 0.2) {
        _v0.multiplyScalar(1 / dist);
        // Into body space.
        _q0.copy(this.rootQuaternion).invert();
        _v1.copy(_v0).applyQuaternion(_q0);
        wantYaw = clamp(Math.atan2(-_v1.x, -_v1.z), -t.lookYawLimit, t.lookYawLimit);
        wantPitch = clamp(Math.asin(clamp(_v1.y, -1, 1)), -t.lookPitchLimit, t.lookPitchLimit);
      }
    }
    this.lookYaw = damp(this.lookYaw, wantYaw, 8, dt);
    this.lookPitch = damp(this.lookPitch, wantPitch, 8, dt);

    this.breathPhase = (this.breathPhase + dt * t.breathRate) % 1;
    const breathW = (1 - this.gaitWeight * 0.65) * (1 - this.airborne * 0.5);
    const breath = Math.sin(this.breathPhase * TAU) * t.breathAmount * breathW;

    // Distribute look-at down the chain from the head backwards. `lookShare`
    // is [head, neck, chest]; anything further down gets the remainder / 3.
    const shares = t.lookShare;
    const lean = this.leanSpring.value;
    for (let i = 0; i < n; i++) {
      const fromTop = n - 1 - i;
      const share = fromTop < shares.length ? shares[fromTop] : 0.06;
      const bone = chain.bones[i];
      const rest = this.rig.def.bones[chain.indices[i]];
      // Rebuild from rest so the layers are genuinely additive, never cumulative.
      bone.quaternion.copy(rest.restQuat);

      if (share > 0) {
        _q0.setFromAxisAngle(this.spineYawAxis[i], this.lookYaw * share);
        _q1.setFromAxisAngle(this.spinePitchAxis[i], -this.lookPitch * share);
        bone.quaternion.multiply(_q0).multiply(_q1);
      }
      // Lean + breathing ride on the lower spine, where a torso actually bends.
      if (i < n - 1) {
        const w = (1 - i / Math.max(1, n - 1)) * 0.9 + 0.1;
        _q0.setFromAxisAngle(this.spinePitchAxis[i], (lean.x + breath * 0.5) * w);
        _q1.setFromAxisAngle(this.spineRollAxis[i], lean.z * w);
        bone.quaternion.multiply(_q0).multiply(_q1);
      }
    }
    // The pelvis offset is applied to the chain root bone's translation, so the
    // legs' hips move with it and the IK re-solves against the fixed footfalls.
    // It is already expressed in body space, which is this bone's parent frame.
    const rootBone = chain.bones[0];
    const rootRest = this.rig.def.bones[chain.indices[0]];
    rootBone.position.copy(rootRest.restPos).add(this.pelvisOffset.value);

    this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
  }

  // -- legs ------------------------------------------------------------------

  private poseLegsIk(): void {
    for (const f of this.legs) {
      const chain = f.chain;
      const nBones = chain.bones.length;
      const nSeg = chain.lengths.length;
      if (nSeg < 2) continue;

      // Target for the ankle: the foot plant lifted along its ground normal.
      const ankleTarget = _v4
        .copy(f.target)
        .addScaledVector(f.normal, f.ankleLift * (1 - this.airborne * 0.6));
      // Tuck the legs when airborne rather than reaching for a floor that isn't there.
      if (this.airborne > 0.01) {
        _v0.copy(chain.world[0]);
        _v0.y -= chain.reach * 0.55;
        ankleTarget.lerp(_v0, this.airborne);
      }

      // Pole: ahead of the knee, in the body's facing, flipped for avian legs.
      const pole = f.pole;
      pole.copy(chain.world[0]);
      _v0.set(0, 0, -1).applyQuaternion(this.rootQuaternion);
      pole.addScaledVector(_v0, chain.reach * 1.4 * this.tuning.kneeSign);
      pole.y -= chain.reach * 0.35;

      const ikSegments = f.ikJoint; // the trailing segment, if any, is the foot
      if (ikSegments === 2) {
        solveTwoBone(
          chain.world[0],
          ankleTarget,
          pole,
          chain.lengths[0],
          chain.lengths[1],
          _v2,
        );
        this.aimBone(chain, 0, _v2, pole);
        this.aimBone(chain, 1, ankleTarget, pole);
      } else {
        const pts = this.fabrikPts;
        for (let i = 0; i <= ikSegments; i++) pts[i].copy(chain.world[i]);
        for (let i = 0; i < ikSegments; i++) this.fabrikLens[i] = chain.lengths[i];
        // Bias the mid joints alternately toward and away from the pole. A
        // digitigrade leg is a Z: knee forward, hock back, ankle forward — one
        // pole direction for every joint gives a spider, not a hound.
        for (let i = 1; i < ikSegments; i++) {
          pts[i].lerp(pole, i % 2 === 1 ? 0.18 : -0.18);
        }
        solveFabrik(pts, this.fabrikLens.slice(0, ikSegments), ankleTarget, 5);
        for (let i = 0; i < ikSegments; i++) this.aimBone(chain, i, pts[i + 1], pole);
      }

      // The foot itself: flat to the ground, rolling off at the end of stance.
      if (nBones > ikSegments) {
        const footIdx = ikSegments;
        _v0.set(0, 0, -1).applyQuaternion(this.rootQuaternion);
        // Project the body's forward onto the ground plane at this foot.
        _v0.addScaledVector(f.normal, -_v0.dot(f.normal)).normalize();
        if (_v0.lengthSq() < 0.5) _v0.set(0, 0, -1);
        const roll = f.planted
          ? clamp01((f.phase - this.duty * 0.55) / Math.max(1e-3, this.duty * 0.45)) * 0.55
          : -0.35 * (1 - clamp01((f.phase - this.duty) / Math.max(1e-3, 1 - this.duty)));
        _v1.copy(_v0);
        _v1.addScaledVector(f.normal, Math.tan(clamp(roll, -0.9, 0.9)));
        this.setBoneWorldAim(chain, footIdx, _v1, f.normal);
      }
    }
    this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
  }

  /**
   * The cheap gait: no IK at all, legs swing by direct rotation around the hip.
   * Used past ~90 m where a 6-pixel-tall creature's knee position is invisible
   * but its motion is not.
   */
  private poseLegsCoarse(dt: number): void {
    void dt;
    for (const f of this.legs) {
      const chain = f.chain;
      const swing = Math.sin((f.phase - this.duty * 0.5) * TAU) * 0.55 * this.gaitWeight;
      const knee = (0.35 + Math.cos(f.phase * TAU) * 0.3) * this.gaitWeight;
      for (let i = 0; i < chain.bones.length; i++) {
        const rest = this.rig.def.bones[chain.indices[i]];
        chain.bones[i].quaternion.copy(rest.restQuat);
        const a = i === 0 ? swing : i === 1 ? -knee * this.tuning.kneeSign : 0;
        if (a !== 0) {
          _q0.setFromAxisAngle(_v0.set(1, 0, 0), a * this.tuning.kneeSign);
          chain.bones[i].quaternion.multiply(_q0);
        }
      }
    }
    this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
  }

  /**
   * Point bone `i` of a chain at a world position, keeping its twist stable by
   * leaning its local +Z toward `poleRef`. Writes the *local* quaternion and
   * updates our world cache so the next bone in the chain sees it.
   */
  private aimBone(chain: ChainRuntime, i: number, worldTarget: THREE.Vector3, poleRef: THREE.Vector3): void {
    _k0.subVectors(worldTarget, chain.world[i]);
    _k1.subVectors(poleRef, chain.world[i]);
    this.setBoneWorldAim(chain, i, _k0, _k1);
  }

  private setBoneWorldAim(
    chain: ChainRuntime,
    i: number,
    dirWorld: THREE.Vector3,
    poleWorld: THREE.Vector3,
  ): void {
    aimQuaternion(dirWorld, poleWorld, _q0);
    if (!Number.isFinite(_q0.x)) return;
    const gi = chain.indices[i];
    const parent = this.rig.def.bones[gi].parent;
    _q1.copy(this.rig.worldQuat[parent]).invert().multiply(_q0);
    chain.bones[i].quaternion.copy(_q1);
    // Keep our world cache coherent for the rest of this chain.
    this.rig.worldQuat[gi].copy(_q0);
    chain.quats[i].copy(_q0);
    const len = this.rig.def.bones[gi].length;
    if (i + 1 <= chain.bones.length) {
      _k2.set(0, len, 0).applyQuaternion(_q0).add(chain.world[i]);
      chain.world[i + 1].copy(_k2);
      if (i + 1 < chain.indices.length) this.rig.worldPos[chain.indices[i + 1]].copy(_k2);
    }
  }

  // -- arms ------------------------------------------------------------------

  private updateArms(input: AnimatorInput, dt: number): void {
    void dt;
    const atk = this.attackWeight;
    for (let k = 0; k < this.arms.length; k++) {
      const chain = this.arms[k];
      const nSeg = chain.lengths.length;
      if (nSeg < 2) continue;
      const side = chain.def.side || (k % 2 === 0 ? -1 : 1);

      // Rest: a ready stance, hands forward and slightly in, driven by whether
      // the unit is aiming or idle.
      const reach = chain.reach;
      const aim = input.focusValid ? 1 : 0;
      const fwd = _v0.set(0, 0, -1).applyQuaternion(this.rootQuaternion);
      const right = _v1.set(1, 0, 0).applyQuaternion(this.rootQuaternion);

      // Counter-swing with the gait: arms oppose the legs.
      const swing = Math.sin((this.gaitTime + (side < 0 ? 0 : 0.5)) * TAU) *
        0.35 * this.gaitWeight * clamp01(this.speed / this.tuning.runSpeed) * (1 - atk);

      // A weapon-ready stance: hands forward of the chest and well below the
      // shoulder. Anything shallower reads as a scarecrow.
      const target = _v2.copy(chain.world[0]);
      target
        .addScaledVector(fwd, reach * (0.26 + aim * 0.18 + atk * 0.45) + swing * reach * 0.4)
        .addScaledVector(right, side * reach * (0.16 - aim * 0.1))
        .addScaledVector(_v3.set(0, 1, 0), -reach * (0.7 - aim * 0.16) - swing * reach * 0.16);

      // Attack: the hand rises behind the shoulder, then drives through.
      if (atk > 0.001) {
        const p = this.attackShape();
        target.addScaledVector(fwd, reach * p * 0.9);
        target.addScaledVector(_v3.set(0, 1, 0), reach * Math.max(0, -p) * 0.7);
      }
      if (this.recharge > 0) {
        target.addScaledVector(_v3.set(0, 1, 0), -reach * 0.18);
        target.addScaledVector(right, -side * reach * 0.16);
      }

      // Elbow pole: down, out and back — the elbow hangs, it does not flare.
      const pole = _v3.copy(chain.world[0]);
      pole
        .addScaledVector(right, side * reach * 0.45)
        .addScaledVector(fwd, -reach * 0.5)
        .addScaledVector(_v4.set(0, 1, 0), -reach * 1.4);

      if (nSeg === 2) {
        solveTwoBone(chain.world[0], target, pole, chain.lengths[0], chain.lengths[1], _v4);
        this.aimBone(chain, 0, _v4, pole);
        this.aimBone(chain, 1, target, pole);
      } else {
        const pts = this.fabrikPts;
        for (let i = 0; i <= nSeg; i++) pts[i].copy(chain.world[i]);
        for (let i = 1; i < nSeg; i++) pts[i].lerp(pole, 0.1);
        solveFabrik(pts, chain.lengths, target, 4);
        for (let i = 0; i < nSeg; i++) this.aimBone(chain, i, pts[i + 1], pole);
      }

      // Lock the hand bone to its rest rotation relative to the forearm.
      //
      // Aiming it like every other link twists it by whatever the elbow pole
      // demands, and that twist swings through the better part of a right angle
      // between a hanging idle and a raised ready stance. On a bare hand that is
      // invisible; on anything the hand *holds* it is fatal — the Huscarl's
      // tower shield went edge-on to the player and the Thrall's axes rolled
      // into its own thigh. A wrist that simply follows the forearm is both
      // anatomically right and the only stable frame a rigidly bound prop can
      // be authored against.
      if (nSeg >= 3) {
        const last = nSeg - 1;
        const gi = chain.indices[last];
        chain.bones[last].quaternion.copy(this.rig.def.bones[gi].restQuat);
        const parent = this.rig.def.bones[gi].parent;
        _q0.copy(this.rig.worldQuat[parent]).multiply(chain.bones[last].quaternion);
        this.rig.worldQuat[gi].copy(_q0);
        chain.quats[last].copy(_q0);
        const len = this.rig.def.bones[gi].length;
        chain.world[last + 1]
          .copy(_v4.set(0, len, 0).applyQuaternion(_q0))
          .add(chain.world[last]);
      }
    }
    this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
  }

  /** -1 at full wind-up, +1 at the end of the strike, 0 at rest. */
  private attackShape(): number {
    if (this.attackTime < 0) return 0;
    const t = this.attackTime;
    if (t < this.attackWindup) return -smoothstep(t / this.attackWindup);
    if (t < this.attackWindup + this.attackStrike) {
      const s = (t - this.attackWindup) / this.attackStrike;
      return lerp(-1, 1, smoothstep(s));
    }
    const s = clamp01((t - this.attackWindup - this.attackStrike) / this.attackRecover);
    return lerp(1, 0, smoothstep(s));
  }

  // -- tails / necks / tentacles --------------------------------------------

  private updateTails(input: AnimatorInput, dt: number): void {
    for (const chain of this.tails) {
      const nSeg = chain.lengths.length;
      if (nSeg < 1) continue;
      const reach = chain.reach;
      // The tip trails the base with lag, droops under gravity and sways.
      const base = chain.world[0];
      const restDir = _v0.copy(chain.def.direction).applyQuaternion(this.rootQuaternion);
      const target = _v1.copy(base).addScaledVector(restDir, reach * 0.92);
      target.addScaledVector(_v2.set(0, -1, 0), reach * 0.24);
      // Lag behind the body's motion, and sway with the gait.
      target.addScaledVector(input.velocity, -0.09);
      const sway = Math.sin(this.gaitTime * TAU * 0.5 + chain.def.gaitPhase * TAU) *
        reach * (0.1 + 0.18 * this.gaitWeight);
      _v2.set(1, 0, 0).applyQuaternion(this.rootQuaternion);
      target.addScaledVector(_v2, sway);

      const pts = this.fabrikPts;
      for (let i = 0; i <= nSeg; i++) pts[i].copy(chain.world[i]);
      // Ease the tip toward the target instead of snapping — this is the only
      // smoothing a tail needs to feel like it has mass.
      pts[nSeg].lerp(target, 1 - Math.exp(-6 * dt));
      solveFabrik(pts, chain.lengths, pts[nSeg], 4);
      const pole = _v3.copy(base).addScaledVector(_v2, reach);
      for (let i = 0; i < nSeg; i++) this.aimBone(chain, i, pts[i + 1], pole);
    }
    this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
  }

  // -- wings -----------------------------------------------------------------

  private updateWings(input: AnimatorInput, dt: number): void {
    void dt;
    const t = this.tuning;
    const rate = t.wingRate * (1 + input.thrust * 1.4);
    const phase = input.elapsed * rate;
    for (let k = 0; k < this.wings.length; k++) {
      const chain = this.wings[k];
      const side = chain.def.side || (k % 2 === 0 ? -1 : 1);
      const beat = Math.sin(phase * TAU);
      // The outer segments lag the inner ones: that phase delay is what makes a
      // wing beat look like a membrane and not a plank.
      for (let i = 0; i < chain.bones.length; i++) {
        const rest = this.rig.def.bones[chain.indices[i]];
        chain.bones[i].quaternion.copy(rest.restQuat);
        const lag = Math.sin((phase - i * 0.09) * TAU);
        const flap = lag * t.wingAmplitude * (0.35 + input.thrust * 0.65) * (i === 0 ? 1 : 0.55);
        const fold = (1 - clamp01(input.thrust)) * 0.35 * (i > 0 ? 1 : 0.3);
        _q0.setFromAxisAngle(_v0.set(0, 0, 1), flap * -side);
        _q1.setFromAxisAngle(_v0.set(1, 0, 0), fold + beat * 0.12);
        chain.bones[i].quaternion.multiply(_q0).multiply(_q1);
      }
    }
    this.rig.syncWorld(this.rootPosition, this.rootQuaternion);
  }

  // -- additive layers -------------------------------------------------------

  private updateLayers(dt: number): void {
    // Attack timeline.
    if (this.attackTime >= 0) {
      this.attackTime += dt;
      const total = this.attackWindup + this.attackStrike + this.attackRecover;
      if (this.attackTime >= total) this.attackTime = -1;
    }
    const wantAttack = this.attackTime >= 0 ? 1 : 0;
    this.attackWeight = damp(this.attackWeight, wantAttack, 14, dt);
    if (this.recharge > 0) this.recharge = Math.max(0, this.recharge - dt);

    // Flinch springs decay to zero and are applied as an extra rotation on the
    // struck chain's first two bones.
    for (let i = 0; i < this.flinch.length; i++) {
      const s = this.flinch[i];
      if (s.value.lengthSq() < 1e-8 && s.vel.lengthSq() < 1e-8) continue;
      springTo(s, _v0.set(0, 0, 0), 160, 13, dt);
      const chain = this.rig.chains[i];
      const amount = clamp(s.value.length(), 0, 0.6);
      if (amount < 1e-4) continue;
      _v1.copy(s.value).multiplyScalar(1 / Math.max(1e-6, s.value.length()));
      // Rotate the chain away from the impulse direction, in the chain's frame.
      _q0.copy(this.rig.worldQuat[chain.indices[0]]).invert();
      _v2.copy(_v1).applyQuaternion(_q0);
      _v3.set(_v2.z, 0, -_v2.x);
      if (_v3.lengthSq() > 1e-6) {
        _v3.normalize();
        _q1.setFromAxisAngle(_v3, amount);
        for (let b = 0; b < Math.min(2, chain.bones.length); b++) {
          chain.bones[b].quaternion.multiply(_q1);
        }
      }
    }
    springTo(this.staggerSpring, _v0.set(0, 0, 0), 70, 9, dt);
  }

  // -- diagnostics -----------------------------------------------------------

  private trackSlide(): void {
    // Measures the *ankle* joint, not the toe tip: the foot rolls about the
    // ankle during stance by design, and that roll is not slide.
    for (const f of this.legs) {
      const joint = f.chain.world[f.ikJoint];
      // Only compare updates where the foot was planted at *both* ends of the
      // interval; the landing frame legitimately moves the foot to its target.
      if (f.planted && this.airborne < 0.05) {
        _v0.copy(f.plant).addScaledVector(f.normal, f.ankleLift);
        const err = joint.distanceTo(_v0);
        if (err > this.maxPlantError) this.maxPlantError = err;
      }
      // Frame-to-frame motion, ignoring intervals in which a step completed.
      if (f.planted && f.wasPlanted && f.stepCount === f.lastSampleStep && this.airborne < 0.05) {
        const d = joint.distanceTo(f.lastWorld);
        if (d > f.slide) f.slide = d;
        if (d > this.maxFootSlide) {
          this.maxFootSlide = d;
          this.slideDiag.speed = this.speed;
          this.slideDiag.ratio =
            f.chain.world[0].distanceTo(f.plant) / Math.max(1e-4, f.ikReach);
          this.slideDiag.dt = this.lastDt;
          this.slideDiag.cadence = this.cadence;
        }
      }
      f.wasPlanted = f.planted;
      f.lastSampleStep = f.stepCount;
      f.lastWorld.copy(joint);
    }
  }

  /** World position of a named bone after the last update. */
  bonePosition(name: string, out: THREE.Vector3): THREE.Vector3 {
    return this.rig.boneWorld(name, out);
  }

  /** Read-only view of a foot, for species code and audio. */
  foot(i: number): { planted: boolean; position: THREE.Vector3; phase: number } | null {
    const f = this.legs[i];
    return f ? { planted: f.planted, position: f.target, phase: f.phase } : null;
  }

  get footCount(): number {
    return this.legs.length;
  }

  get locomotionWeight(): number {
    return this.gaitWeight;
  }
}

/** Critically-damped-ish spring toward a target. Stable at any dt we see. */
function springTo(
  s: SpringVec,
  target: THREE.Vector3,
  stiffness: number,
  damping: number,
  dt: number,
): void {
  const step = Math.min(dt, 1 / 60);
  let remaining = dt;
  // Sub-step so a long frame cannot make the spring explode.
  while (remaining > 1e-5) {
    const h = Math.min(step, remaining);
    remaining -= h;
    s.vel.x += (target.x - s.value.x) * stiffness * h - s.vel.x * damping * h;
    s.vel.y += (target.y - s.value.y) * stiffness * h - s.vel.y * damping * h;
    s.vel.z += (target.z - s.value.z) * stiffness * h - s.vel.z * damping * h;
    s.value.addScaledVector(s.vel, h);
  }
  if (!Number.isFinite(s.value.x) || !Number.isFinite(s.vel.x)) {
    s.value.set(0, 0, 0);
    s.vel.set(0, 0, 0);
  }
}


// ---------------------------------------------------------------------------
// Build-time pose probe
// ---------------------------------------------------------------------------

const _settleFocus = new THREE.Vector3();
const _settleInput: AnimatorInput = {
  dt: 1 / 30,
  elapsed: 0,
  lod: 'full',
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  yaw: 0,
  yawRate: 0,
  grounded: true,
  groundY: 0,
  groundNormal: new THREE.Vector3(0, 1, 0),
  collision: null,
  focus: _settleFocus,
  focusValid: true,
  thrust: 0,
};

/**
 * Instantiate a rig and run it to the stance the player actually fights.
 *
 * Every rig is *authored* with its arms hanging straight down, and nothing is
 * ever seen in that pose: the animator drops the elbow back and swings the
 * forearm forward the moment a unit has a target. Measured on the Nordic
 * Huscarl that is an 89-degree rotation of the hand bone, and anything a hand
 * holds inherits all of it — which is why a tower shield authored square to the
 * front rendered edge-on and a flamethrower authored along the barrel axis
 * sprayed its parts across its owner's hip.
 *
 * Guessing the number from limb geometry does not work; it depends on
 * proportions the author does not control. Measuring it does. Callers get a
 * posed `RigInstance` with `matrixWorld` up to date on every bone, in body
 * space (the root is at the origin with no yaw), and must `dispose()` it.
 *
 * Cost is one throwaway skeleton and 24 animator steps, paid once per species
 * at template build.
 */
export function settleRig(
  rig: Rig,
  tuning: Partial<AnimatorTuning> = {},
  height = 1.8,
  footLift?: readonly number[],
): RigInstance {
  const inst = rig.build();
  const anim = new ProceduralAnimator(inst, tuning, footLift);
  _settleFocus.set(0, height * 0.62, -14);
  _settleInput.position.set(0, 0, 0);
  _settleInput.velocity.set(0, 0, 0);
  for (let i = 0; i < 24; i++) {
    _settleInput.elapsed = i / 30;
    anim.update(_settleInput);
  }
  inst.root.updateMatrixWorld(true);
  return inst;
}

/**
 * How much a bone has rotated out of its bind orientation by the time the body
 * reaches its combat stance. Author a held weapon's axes through the inverse of
 * this and it points where you drew it in the pose that matters.
 */
export function combatBoneRotation(
  rig: Rig,
  bone: string,
  out: THREE.Quaternion,
  tuning: Partial<AnimatorTuning> = {},
  height = 1.8,
): THREE.Quaternion {
  const gi = rig.boneIndex(bone);
  if (gi < 0) return out.identity();
  const inst = settleRig(rig, tuning, height);
  const posed = new THREE.Quaternion().setFromRotationMatrix(inst.bones[gi].matrixWorld);
  out.copy(posed).multiply(_settleQ.copy(rig.bones[gi].worldQuat).invert());
  inst.dispose();
  return out;
}

const _settleQ = new THREE.Quaternion();
