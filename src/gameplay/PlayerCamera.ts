/**
 * First-person camera rig.
 *
 * The one rule this file exists to enforce: **every effect is a contribution
 * that gets summed, never an assignment.** Bob, roll, recoil, landing dip,
 * damage punch, shake, step smoothing and the death fall all write into a
 * shared offset/rotation accumulator which is applied once at the end. The
 * moment one of them writes `camera.position.y = …` directly, every other
 * effect silently stops existing, which is how FPS cameras usually die.
 *
 * It also runs in `render()`, not `update()`. The simulation is 120 Hz but the
 * display may be 144 or 165; interpolating the eye position between the last
 * two sim states and smoothing the springs on `frameDt` is what keeps a
 * high-refresh monitor from showing 120 Hz stair-stepping.
 */
import * as THREE from 'three';
import type { RendererHost } from '@/core/Renderer';
import { settings } from '@/core/Settings';
import { clamp, clamp01, damp, lerp, TAU } from '@/util/math';
import { MOVE } from './PlayerMovement';
import { ShakeStack, Spring, ViewKick, type ShakeSample } from './ViewKick';

/** Camera tuning. Angles in radians unless the name says degrees. */
export const VIEW = {
  /** Pitch clamp. 88° rather than 90° so the horizon never fully inverts. */
  pitchLimit: 88 * (Math.PI / 180),

  // -- eye ----------------------------------------------------------------
  /** Eye-height catch-up rate. Fast enough to not float, slow enough to smooth. */
  eyeRate: 18,
  /** Extra drop while sliding — the camera goes low and the world gets fast. */
  slideEyeDrop: 0.3,
  /** Forward offset of the eye from the capsule axis, metres. */
  eyeForward: 0.06,

  // -- view bob -----------------------------------------------------------
  /** Metres of travel per footfall. Sets the bob frequency from actual speed. */
  strideLength: 1.62,
  /** Peak lateral bob at walk speed, metres. Subtle: this is a 1:2 Lissajous. */
  bobLateral: 0.038,
  /** Peak vertical bob. Slightly less than lateral or it reads as a limp. */
  bobVertical: 0.028,
  /** Bob-driven roll, radians. */
  bobRoll: 0.0075,
  /** Bob-driven pitch, radians — the head nods, it does not just translate. */
  bobPitch: 0.0045,
  /** Bob is suppressed while aiming; you cannot shoot through a bouncing sight. */
  bobAdsScale: 0.25,
  bobCrouchScale: 0.55,
  /** Bob amplitude ramps in over this fraction of walk speed. */
  bobSpeedRef: MOVE.walkSpeed,
  /** Extra downward kick applied on each footfall, metres. */
  footstepDip: 0.011,
  /** How fast the bob amplitude fades in/out when you start or stop, 1/s. */
  bobBlendRate: 11,

  // -- roll ---------------------------------------------------------------
  /** Roll into a strafe. 2.4° — present, never nauseating. */
  strafeRoll: 2.4 * (Math.PI / 180),
  /** Roll while sliding. Bigger, because a slide is a commitment. */
  slideRoll: 6.5 * (Math.PI / 180),
  /** Roll catch-up rate. */
  rollRate: 8,
  /** Airborne roll from lateral velocity, radians per m/s. */
  airRoll: 0.0025,

  // -- landing ------------------------------------------------------------
  /** Deepest landing dip, metres, reached at MOVE.landingReference. */
  landingDip: 0.26,
  /** Landing pitch nod, radians. */
  landingPitch: 0.055,
  landingStiffness: 88,
  /** Under-damped so the landing has one small rebound. */
  landingDamping: 0.62,

  // -- damage -------------------------------------------------------------
  /** Punch per unit of normalised damage, radians. */
  damagePunch: 0.07,
  damageStiffness: 150,
  damageDamping: 0.55,
  /** Positional shove away from the hit, metres. */
  damageShove: 0.035,

  // -- death --------------------------------------------------------------
  /** Where the eye ends up after the death fall, metres above the feet. */
  deathEyeHeight: 0.42,
  deathRoll: 62 * (Math.PI / 180),
  deathPitch: -18 * (Math.PI / 180),
  /** Seconds for the fall to complete. */
  deathFall: 1.15,

  // -- fov ----------------------------------------------------------------
  /** Default ADS zoom if the weapon system never sets one. */
  defaultAimZoom: 1.2,
  /** How fast the FOV chases its target, 1/s. */
  fovRate: 11,
  /** Extra widening while sliding, multiplier. */
  slideFov: 1.05,
} as const;

/** What the camera needs to know each frame. Owned by `Player`, never allocated. */
export interface CameraState {
  /** Interpolated capsule centre. */
  position: THREE.Vector3;
  /** Eye height above the feet for the current stance. */
  eyeHeight: number;
  /** Distance from the capsule centre down to the feet. */
  centreToFeet: number;
  velocity: THREE.Vector3;
  yaw: number;
  pitch: number;
  /** Lateral input, -1..1, for strafe roll. */
  strafe: number;
  grounded: boolean;
  crouching: boolean;
  sliding: boolean;
  aimProgress: number;
  aimZoom: number;
  sprintBlend: number;
  /** Vertical offset the camera should still lag behind after a step-up. */
  stepSmooth: number;
  dead: boolean;
}

export function createCameraState(): CameraState {
  return {
    position: new THREE.Vector3(),
    eyeHeight: 1.7,
    centreToFeet: 1,
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    strafe: 0,
    grounded: true,
    crouching: false,
    sliding: false,
    aimProgress: 0,
    aimZoom: VIEW.defaultAimZoom,
    sprintBlend: 0,
    stepSmooth: 0,
    dead: false,
  };
}

const _shakeOut: ShakeSample = { pitch: 0, yaw: 0, roll: 0, x: 0, y: 0 };
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export class PlayerCamera {
  readonly kick = new ViewKick();
  readonly shake = new ShakeStack();

  /** World-space eye position after all contributions. Read by the view model. */
  readonly eye = new THREE.Vector3();

  /** Bob phase in radians; a footfall lands every PI, a full stride every 2*PI. */
  private bobPhase = 0;
  /** Smoothed bob amplitude, 0..1. */
  private bobAmount = 0;
  /** Whole-steps taken, so the owner can detect a new footfall. */
  footstepCount = 0;

  /**
   * Eye height above the feet, metres — smoothed in LOCAL space, never world
   * space. Smoothing the world Y looks equivalent and is not: at terminal
   * velocity the target moves ~0.4 m per frame, so an exponential chase settles
   * into a permanent metre-plus lag and the camera trails the body all the way
   * down. In local space the only thing being smoothed is the stance change,
   * which is what actually needed smoothing.
   */
  private smoothedEye = 1.7;
  private eyeInitialised = false;
  private rollValue = 0;

  private landSpring = new Spring(VIEW.landingStiffness, VIEW.landingDamping);
  private landPitchSpring = new Spring(VIEW.landingStiffness, VIEW.landingDamping);
  private punchPitch = new Spring(VIEW.damageStiffness, VIEW.damageDamping);
  private punchYaw = new Spring(VIEW.damageStiffness, VIEW.damageDamping);
  private punchShove = new Spring(VIEW.damageStiffness, VIEW.damageDamping);
  private footDip = new Spring(220, 0.8);

  private deathTime = 0;
  private fovZoom = 1;
  private lastAppliedZoom = -1;

  // -- external drivers -----------------------------------------------------

  /** Impact from a landing, in m/s. Scales the dip and the nod. */
  land(impactSpeed: number): void {
    const t = clamp01(impactSpeed / MOVE.landingReference);
    // Square-root shaping: small hops still register, big drops do not blow out.
    const s = Math.sqrt(t);
    this.landSpring.add(-VIEW.landingDip * s);
    this.landPitchSpring.add(-VIEW.landingPitch * s);
    this.shake.add(s * 0.55, 0.22, 26);
  }

  /**
   * Damage punch. `localDir` is the incoming direction expressed in view space
   * (x right, z forward); the camera is thrown *away* from it.
   */
  punch(strength: number, localX: number, localZ: number): void {
    // Accessibility scaling lives here so no caller can forget it.
    const s = clamp01(strength) * (reducedMotion() ? 0.4 : 1);
    this.punchPitch.add(VIEW.damagePunch * s * (0.55 + 0.45 * clamp(localZ, -1, 1)));
    this.punchYaw.add(-VIEW.damagePunch * s * clamp(localX, -1, 1) * 1.2);
    this.punchShove.add(-VIEW.damageShove * s);
    this.shake.add(0.5 + s * 1.4, 0.3, 30);
  }

  /**
   * Takeoff kick. `kind` is 1 for the ground jump, 2 for the aerial one — the
   * double jump gets a sharper hit because there is no leg extension selling
   * it, only the camera.
   */
  jump(kind: number): void {
    const s = kind >= 2 ? 1 : 0.55;
    this.landSpring.impulse(0.5 * s);
    this.landPitchSpring.add(0.012 * s);
    if (kind >= 2) this.shake.add(0.35, 0.16, 30);
  }

  beginDeath(): void {
    this.deathTime = 0;
  }

  reset(state: CameraState): void {
    this.kick.reset();
    this.shake.reset();
    this.landSpring.reset();
    this.landPitchSpring.reset();
    this.punchPitch.reset();
    this.punchYaw.reset();
    this.punchShove.reset();
    this.footDip.reset();
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.footstepCount = 0;
    this.rollValue = 0;
    this.deathTime = 0;
    this.smoothedEye = state.eyeHeight;
    this.eyeInitialised = true;
    this.fovZoom = 1;
  }

  // -- per-frame ------------------------------------------------------------

  /**
   * Apply the camera for one rendered frame. `dt` is the *frame* delta, not the
   * sim step: springs and smoothing must run on real time or they change
   * character with the refresh rate.
   */
  render(dt: number, s: CameraState, host: RendererHost): void {
    const cam = host.camera;
    const clampedDt = Math.min(dt, 0.1);

    // -- eye height ---------------------------------------------------------
    const feetY = s.position.y - s.centreToFeet;
    let targetEye = s.eyeHeight;
    if (s.sliding) targetEye -= VIEW.slideEyeDrop;
    if (!this.eyeInitialised) {
      this.smoothedEye = targetEye;
      this.eyeInitialised = true;
    }
    this.smoothedEye = damp(this.smoothedEye, targetEye, VIEW.eyeRate, clampedDt);

    // Step-up compensation: the capsule teleports up a ledge, the camera does not.
    const eyeY = feetY + this.smoothedEye - s.stepSmooth;

    // -- accumulators -------------------------------------------------------
    let offX = 0;
    let offY = 0;
    let addPitch = 0;
    let addYaw = 0;
    let roll = 0;

    // -- view bob -----------------------------------------------------------
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    const moving = s.grounded && !s.sliding && speed > 0.4;
    if (moving) {
      // Phase is driven by distance travelled, so the cadence is always correct
      // regardless of speed, slope or frame rate. PI per footfall, and the
      // phase is kept over a FULL 2*PI stride — wrapping at PI would make both
      // feet land on the same side and the walk would read as a shuffle.
      const prev = this.bobPhase;
      this.bobPhase += ((speed * clampedDt) / VIEW.strideLength) * Math.PI;
      const falls = Math.floor(this.bobPhase / Math.PI) - Math.floor(prev / Math.PI);
      if (falls > 0) {
        this.footstepCount += falls;
        this.footDip.add(-VIEW.footstepDip * clamp01(speed / VIEW.bobSpeedRef));
      }
      // Wrapping by whole strides preserves which foot is next.
      if (this.bobPhase >= TAU) this.bobPhase -= TAU * Math.floor(this.bobPhase / TAU);
    }

    // Amplitude, not phase, is what eases out when you stop — damping the phase
    // would run the head backwards through the gait.
    const bobTarget =
      (moving ? 1 : 0) *
      clamp01(speed / VIEW.bobSpeedRef) *
      lerp(1, VIEW.bobAdsScale, s.aimProgress) *
      (s.crouching ? VIEW.bobCrouchScale : 1);
    this.bobAmount = damp(this.bobAmount, bobTarget, VIEW.bobBlendRate, clampedDt);
    const bobAmp = this.bobAmount;
    if (bobAmp > 1e-4) {
      // A 1:2 Lissajous — the classic figure-eight head path. A single sine on
      // Y reads as a bounce; the figure-eight reads as a gait.
      const sinP = Math.sin(this.bobPhase);
      const sin2P = Math.sin(this.bobPhase * 2);
      offY += sin2P * VIEW.bobVertical * bobAmp;
      addPitch += sin2P * VIEW.bobPitch * bobAmp;
      // Lateral bob is applied along the camera's right axis further down.
      offX += sinP * VIEW.bobLateral * bobAmp;
      roll += sinP * VIEW.bobRoll * bobAmp;
    }

    // -- roll ---------------------------------------------------------------
    let rollTarget = -s.strafe * VIEW.strafeRoll;
    if (s.sliding) {
      // Lean into the slide: sign follows lateral input, defaulting to the
      // direction the slide is already drifting.
      const lean = Math.abs(s.strafe) > 0.15 ? Math.sign(s.strafe) : 1;
      rollTarget -= lean * VIEW.slideRoll;
    }
    if (!s.grounded) {
      // In the air, roll follows actual lateral velocity instead of input —
      // it makes a strafe-jump read as a bank.
      _right.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
      rollTarget = -(s.velocity.x * _right.x + s.velocity.z * _right.z) * VIEW.airRoll;
    }
    this.rollValue = damp(this.rollValue, rollTarget, VIEW.rollRate, clampedDt);
    roll += this.rollValue;

    // -- springs ------------------------------------------------------------
    offY += this.landSpring.step(clampedDt);
    addPitch += this.landPitchSpring.step(clampedDt);
    offY += this.footDip.step(clampedDt);
    addPitch += this.punchPitch.step(clampedDt);
    addYaw += this.punchYaw.step(clampedDt);
    const shove = this.punchShove.step(clampedDt);

    // -- recoil (camera half; the aim half is applied by Player in update) ---
    addPitch += this.kick.pitchSpring.value;
    addYaw += this.kick.yawSpring.value;
    roll += this.kick.rollSpring.value;

    // -- shake --------------------------------------------------------------
    this.shake.step(clampedDt);
    this.shake.sample(_shakeOut, 1);
    addPitch += _shakeOut.pitch;
    addYaw += _shakeOut.yaw;
    roll += _shakeOut.roll;
    offX += _shakeOut.x;
    offY += _shakeOut.y;

    // -- death fall ---------------------------------------------------------
    if (s.dead) {
      this.deathTime = Math.min(VIEW.deathFall, this.deathTime + clampedDt);
      const t = clamp01(this.deathTime / VIEW.deathFall);
      // Ease-out: the body drops fast then settles.
      const e = 1 - (1 - t) * (1 - t);
      const groundEye = feetY + VIEW.deathEyeHeight;
      offY += (groundEye - eyeY) * e;
      roll += VIEW.deathRoll * e;
      addPitch += VIEW.deathPitch * e;
    }

    // -- compose ------------------------------------------------------------
    const sy = Math.sin(s.yaw);
    const cyw = Math.cos(s.yaw);
    _fwd.set(-sy, 0, -cyw);
    _right.set(cyw, 0, -sy);

    this.eye.set(s.position.x, eyeY, s.position.z);
    this.eye.addScaledVector(_right, offX);
    this.eye.y += offY;
    this.eye.addScaledVector(_fwd, VIEW.eyeForward + shove);

    cam.position.copy(this.eye);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(
      clamp(s.pitch + addPitch, -VIEW.pitchLimit - 0.2, VIEW.pitchLimit + 0.2),
      s.yaw + addYaw,
      roll,
    );

    // -- field of view ------------------------------------------------------
    // Composed once, here, so sprint and ADS cannot fight over the projection.
    // Sprint/slide widen (zoom < 1), aiming narrows (zoom > 1).
    const wide = lerp(1, MOVE.sprintFov, s.sprintBlend) * (s.sliding ? VIEW.slideFov : 1);
    const target = lerp(1, Math.max(1, s.aimZoom), clamp01(s.aimProgress)) / wide;
    this.fovZoom = damp(this.fovZoom, target, VIEW.fovRate, clampedDt);
    if (Math.abs(this.fovZoom - this.lastAppliedZoom) > 4e-4) {
      this.lastAppliedZoom = this.fovZoom;
      host.applyFov(this.fovZoom);
    }
  }

  /** Normalised stride phase, 0..1 across a full two-step cycle. View-model sway
   *  should follow this, not the footfall, or the weapon will judder. */
  get stridePhase(): number {
    return this.bobPhase / TAU;
  }

  /** Current summed shake intensity — PostFX and the HUD can react to it. */
  get shakeIntensity(): number {
    return this.shake.intensity;
  }
}

/** Wrap an angle into (-PI, PI]. Used to keep yaw bounded over long sessions. */
export function wrapAngle(a: number): number {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x <= -Math.PI) x += TAU;
  return x;
}

/** True when the accessibility flag should suppress heavy camera motion. */
export function reducedMotion(): boolean {
  return settings.user.reducedMotion;
}
