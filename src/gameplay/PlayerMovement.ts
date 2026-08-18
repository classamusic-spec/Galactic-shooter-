/**
 * Player locomotion: capsule character movement with a friction model, air
 * strafing, coyote/buffered jumps, a double jump with hold-to-glide, sprint,
 * crouch, slide, slope handling and step-up.
 *
 * The model is deliberately Quake-lineage rather than rigid-body: velocity is
 * integrated by hand, friction is a *drop per second* rather than a lerp, and
 * acceleration is applied by projecting the current velocity onto the wish
 * direction. That projection is the whole reason air strafing works — you can
 * always add speed in a direction you are not already moving in, which is what
 * makes Destiny's air control feel like flying instead of like steering a brick.
 *
 * Everything the feel depends on lives in `MOVE`, with the reason next to it.
 * All state is integer-stable at the fixed 120 Hz sim step and allocation-free.
 */
import * as THREE from 'three';
import type { CollisionWorld, RaycastHit, SurfaceKind } from '@/types';
import { GRAVITY, MAX_SLOPE } from '@/gameplay/Physics';
import { clamp, clamp01, damp } from '@/util/math';

/**
 * Movement tuning. Distances in metres, speeds in m/s, accelerations in m/s²,
 * rates in 1/s, times in seconds. Every jump is expressed as a *height* so it
 * can be tuned against level geometry rather than against an impulse number.
 */
export const MOVE = {
  // -- capsule ------------------------------------------------------------
  /** Wide enough to not snag on cover, narrow enough for 1 m doorways. */
  radius: 0.35,
  /** Standing half-height. Total height 2*(0.65+0.35) = 2.0 m, eye at 1.70 m. */
  standHalfHeight: 0.65,
  /** Crouched half-height. Total 1.26 m, eye at 1.07 m — reads as a real crouch. */
  crouchHalfHeight: 0.28,
  /** Eye sits at 85% of total height: 1.70 m standing, 1.07 m crouched. */
  eyeRatio: 0.85,
  /** Capsule height interpolation rate. 16/s ≈ 90 ms to look settled. */
  crouchRate: 16,

  // -- ground speeds ------------------------------------------------------
  /** Base walk. Destiny's guardian is fast; 6.4 m/s is a jog, not a stroll. */
  walkSpeed: 6.4,
  /** Sprint. 1.6× walk — enough to feel like a gear change. */
  sprintSpeed: 10.2,
  crouchSpeed: 3.2,
  /** Multiplier applied at full ADS. Aiming should cost mobility, not kill it. */
  adsSpeedScale: 0.72,
  /** Time to ramp from walk to full sprint. Short enough to not feel laggy. */
  sprintRamp: 0.35,
  /** Sprint needs real forward intent; strafing at full tilt looks wrong. */
  sprintForwardThreshold: 0.25,
  /** Horizontal FOV widening at full sprint, as a multiplier. */
  sprintFov: 1.075,

  // -- ground accel / friction -------------------------------------------
  /**
   * Ground acceleration. 85 m/s² reaches walk speed in ~75 ms, so the character
   * starts *now* — the single biggest difference between crisp and mushy.
   */
  groundAccel: 85,
  /**
   * Friction while the player is still asking for movement. Low, so changing
   * direction preserves speed and strafe-around-cover stays fluid.
   */
  groundFriction: 6.5,
  /** Friction with no input. High, so releasing the stick stops you crisply. */
  groundDecel: 12,
  /**
   * Friction is computed against at least this speed, so the last metre per
   * second does not take forever to bleed off (Quake's `sv_stopspeed`).
   */
  stopSpeed: 2.4,
  /** Below this the character is snapped to rest; kills denormal creep. */
  restSpeed: 0.06,

  // -- air ----------------------------------------------------------------
  /**
   * Air acceleration. ~28% of ground: you can steer fully, but you cannot
   * change your mind about a jump for free.
   */
  airAccel: 24,
  /** Air friction. Tiny — enough to settle, not enough to feel like syrup. */
  airFriction: 0.12,
  /**
   * Soft ceiling on horizontal air speed. Above it, air accel may redirect but
   * not increase speed, so strafe-jumping is rewarding without being infinite.
   */
  airSpeedCap: 13.0,
  /** Terminal velocity. Also the clamp that keeps the solver well-conditioned. */
  maxFallSpeed: 58,

  // -- jump ---------------------------------------------------------------
  /** Apex height above takeoff, metres. Clears a 1.8 m crate with margin. */
  jumpHeight: 1.9,
  /** Second (aerial) jump. Lower — it is a correction, not a re-launch. */
  doubleJumpHeight: 1.45,
  /** Total jumps including the ground one. */
  maxJumps: 2,
  /** Forward nudge added by the double jump, m/s — Destiny's mid-air redirect. */
  doubleJumpRedirect: 2.6,
  /** Grace period after walking off a ledge during which jump still works. */
  coyoteTime: 0.09,
  /** Jump pressed this long before landing still fires on touchdown. */
  jumpBuffer: 0.12,
  /**
   * Releasing jump early scales the remaining rise. 0.45 gives a usable short
   * hop without making a tapped jump feel broken.
   */
  jumpCutScale: 0.45,
  /**
   * Minimum hold before an early release can trim the jump. Without it a
   * one-frame tap (and every double jump, which is usually a tap) collapses to
   * a hop, which reads as the input being dropped.
   */
  jumpCutDelay: 0.05,
  /** Ignore ground contact for this long after a jump so we cannot re-stick. */
  jumpLock: 0.09,
  /**
   * How far below the feet a walkable surface is still "the ground".
   *
   * This is a *position* snap, not a downward velocity. A stick velocity is the
   * usual trick, but pushing along the contact normal displaces the capsule
   * horizontally too, and `CollisionWorld`'s analytic-terrain path only corrects
   * the vertical axis — the residue accumulates into a visible uphill drift on
   * any slope. Snapping the position leaves velocity untouched, so it cannot
   * introduce motion the player did not ask for.
   */
  groundSnap: 0.45,
  /**
   * Per-step vertical settle used only on analytic (heightfield) ground, where
   * the ray probe finds no triangles. `resolveCapsule`'s heightfield path treats
   * anything within 0.14 m of the surface as grounded but never pulls you down
   * to it, so without this the capsule can end a fast landing hovering ~9 cm in
   * the air. Safe there precisely because that path corrects Y only — it can
   * introduce no horizontal error, unlike a stick along the contact normal.
   */
  groundSettle: 0.05,

  // -- glide --------------------------------------------------------------
  /** Gravity multiplier while holding jump on the way down after a double jump. */
  glideGravityScale: 0.36,
  /** Hard cap on descent rate while gliding. */
  glideMaxFall: 5.0,
  /** Extra air control while gliding — the glide is a positioning tool. */
  glideAirAccel: 34,
  /** Seconds of glide available per airtime; prevents infinite hover. */
  glideDuration: 1.6,

  // -- slide --------------------------------------------------------------
  /** Minimum entry speed. Below this a crouch is just a crouch. */
  slideMinSpeed: 5.5,
  /** Entry boost. The slide must *reward* committing to it. */
  slideBoost: 1.18,
  slideMaxSpeed: 13.5,
  /** Slide friction — low, so >90% of entry speed survives the first 0.2 s. */
  slideFriction: 1.1,
  /** Slide ends around here; total decay reads as ~0.9 s. */
  slideDuration: 0.9,
  slideExitSpeed: 3.6,
  /** Lateral steering authority while sliding, m/s². */
  slideSteer: 9,
  /** Speed multiplier when jump-cancelling a slide — the momentum tech. */
  slideJumpBoost: 1.12,
  /** Cooldown before another slide can start, so it cannot be spammed. */
  slideCooldown: 0.35,

  // -- slopes & steps -----------------------------------------------------
  /** Steeper than this and you slide down instead of walking up. */
  maxSlope: MAX_SLOPE,
  /** Control retained while sliding down a too-steep face. */
  steepControl: 0.55,
  /** Max ledge the capsule silently steps onto. */
  stepHeight: 0.45,
  /** Rate the camera catches up after a step-up, 1/s. Hides the vertical pop. */
  stepSmoothRate: 15,

  // -- landing ------------------------------------------------------------
  /** Impact speed above which fall damage starts, m/s (≈ a 4 m drop). */
  fallDamageSpeed: 14,
  /** Damage per m/s over the threshold. 24 m/s (30 m drop) ≈ lethal. */
  fallDamagePerSpeed: 9.5,
  /** Impact speed that produces a full-amplitude landing dip. */
  landingReference: 22,
} as const;

/** Per-step intent handed to the mover. Filled by `Player`, never allocated. */
export interface MoveCommand {
  /** Strafe axis, -1..1 (right positive). */
  moveX: number;
  /** Forward axis, -1..1 (forward NEGATIVE, matching InputSystem). */
  moveZ: number;
  /** Look yaw, radians. Movement is always relative to it. */
  yaw: number;
  jumpHeld: boolean;
  jumpPressed: boolean;
  jumpReleased: boolean;
  crouchHeld: boolean;
  sprintHeld: boolean;
  /** External speed multiplier (ADS, debuffs). */
  speedScale: number;
  /** False while firing/aiming — sprint is blocked but the ramp is preserved. */
  allowSprint: boolean;
  /** When false the mover coasts: gravity and collision only. */
  controlEnabled: boolean;
}

export function createMoveCommand(): MoveCommand {
  return {
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    jumpHeld: false,
    jumpPressed: false,
    jumpReleased: false,
    crouchHeld: false,
    sprintHeld: false,
    speedScale: 1,
    allowSprint: true,
    controlEnabled: true,
  };
}

// Module-scope scratch. Deliberately NOT the shared `scratch` pool from
// @/util/math: `CollisionWorld.resolveCapsule` uses that pool internally, so a
// vector held across the call would be clobbered.
const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
/** Preallocated so the per-step ground probe never allocates. */
const _groundHit: RaycastHit = {
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  surface: 'rock',
};

/** Offsets for the stand-up clearance test, in units of capsule radius. */
const STAND_PROBES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.7, 0],
  [-0.7, 0],
  [0, 0.7],
  [0, -0.7],
];

export class PlayerMovement {
  /** Capsule centre, world space. */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Contact normal of the surface under the capsule. */
  readonly groundNormal = new THREE.Vector3(0, 1, 0);

  world: CollisionWorld | null = null;
  /** Latches the missing-world error so it reports once, not every step. */
  private warnedNoWorld = false;

  readonly radius = MOVE.radius;
  /** Live capsule half-height; interpolates between stand and crouch. */
  halfHeight: number = MOVE.standHalfHeight;

  grounded = false;
  crouching = false;
  sprinting = false;
  sliding = false;
  /** True while standing on ground too steep to walk on. */
  steepSliding = false;
  /** Ground steepness in radians. */
  slope = 0;
  /** 0..1 sprint ramp, drives both speed and the FOV kick. */
  sprintBlend = 0;
  /** Vertical offset the camera still owes after a step-up, metres. */
  stepSmooth = 0;
  /** Surface kind under the feet, refreshed periodically for footstep audio. */
  groundSurface: SurfaceKind = 'rock';
  /** True while the hold-to-glide is actively slowing the descent. */
  gliding = false;

  /** Set for exactly one step when the capsule touches down. Impact speed, m/s. */
  landedImpact = 0;
  /** Set for exactly one step when a jump/double jump fires. */
  jumpedThisStep = 0;

  private jumpsUsed = 0;
  private airTime = 0;
  private sinceGrounded = 999;
  private sinceJumpPressed = 999;
  private jumpLock = 0;
  private sinceLaunch = 999;
  private jumpCutDone = true;
  private slideTime = 0;
  private slideCooldown = 0;
  private glideLeft: number = MOVE.glideDuration;
  private wasGrounded = false;
  private surfaceTimer = 0;
  /** True when last step's ray probe found real geometry under the feet. */
  private raySnapped = false;

  // -- public helpers -------------------------------------------------------

  /** Feet (bottom of the capsule) in world space. */
  get feetY(): number {
    return this.position.y - this.halfHeight - this.radius;
  }

  /** Eye height above the feet for the current capsule size. */
  get eyeHeight(): number {
    return 2 * (this.halfHeight + this.radius) * MOVE.eyeRatio;
  }

  get airborne(): boolean {
    return !this.grounded;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Speed along the current facing, used by the camera for bob phase. */
  get slideProgress(): number {
    return this.sliding ? clamp01(this.slideTime / MOVE.slideDuration) : 0;
  }

  teleport(position: THREE.Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.groundNormal.set(0, 1, 0);
    this.halfHeight = MOVE.standHalfHeight;
    this.grounded = false;
    this.wasGrounded = false;
    this.crouching = false;
    this.sliding = false;
    this.steepSliding = false;
    this.sprinting = false;
    this.sprintBlend = 0;
    this.stepSmooth = 0;
    this.jumpsUsed = 0;
    this.airTime = 0;
    this.sinceGrounded = 999;
    this.sinceJumpPressed = 999;
    this.jumpLock = 0;
    this.sinceLaunch = 999;
    this.jumpCutDone = true;
    this.slideTime = 0;
    this.slideCooldown = 0;
    this.glideLeft = MOVE.glideDuration;
    this.raySnapped = false;
    this.landedImpact = 0;
    this.jumpedThisStep = 0;
  }

  addImpulse(v: THREE.Vector3): void {
    this.velocity.add(v);
    if (v.y > 0.25) {
      // Launch: leave the ground immediately instead of being re-stuck by the
      // ground snap on the same step.
      this.grounded = false;
      this.jumpLock = MOVE.jumpLock;
    }
  }

  // -- the step -------------------------------------------------------------

  update(dt: number, cmd: MoveCommand): void {
    const world = this.world;
    if (!world && !this.warnedNoWorld) {
      // Every collision path below is guarded behind `if (world)`, so an unbound
      // world does not throw - it silently degrades into unresolved free-fall
      // through the terrain. That shipped once because nothing said anything;
      // say something.
      this.warnedNoWorld = true;
      console.error(
        '[player] simulating with no CollisionWorld bound - the player will fall ' +
          'through the level. Call player.bindCollision(level.collision) after loading a level.',
      );
    }
    this.landedImpact = 0;
    this.jumpedThisStep = 0;

    this.sinceGrounded += dt;
    this.sinceJumpPressed += dt;
    this.jumpLock = Math.max(0, this.jumpLock - dt);
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    if (cmd.jumpPressed) this.sinceJumpPressed = 0;

    // -- wish direction ----------------------------------------------------
    const sy = Math.sin(cmd.yaw);
    const cy = Math.cos(cmd.yaw);
    // three.js YXZ: yaw 0 looks down -Z.
    _fwd.set(-sy, 0, -cy);
    _right.set(cy, 0, -sy);
    const mx = cmd.controlEnabled ? cmd.moveX : 0;
    const mz = cmd.controlEnabled ? cmd.moveZ : 0;
    _wish.set(0, 0, 0).addScaledVector(_right, mx).addScaledVector(_fwd, -mz);
    const wishLen = Math.min(1, _wish.length());
    if (wishLen > 1e-4) _wish.multiplyScalar(1 / _wish.length());
    else _wish.set(0, 0, 0);

    // -- stance ------------------------------------------------------------
    this.updateSprint(dt, cmd, mz, wishLen);
    this.updateStance(dt, cmd);

    // -- target speed ------------------------------------------------------
    let target =
      this.crouching && !this.sliding
        ? MOVE.crouchSpeed
        : MOVE.walkSpeed + (MOVE.sprintSpeed - MOVE.walkSpeed) * this.sprintBlend;
    target *= cmd.speedScale * wishLen;

    // -- jump --------------------------------------------------------------
    this.handleJump(dt, cmd);

    // -- acceleration ------------------------------------------------------
    if (this.grounded) {
      this.airTime = 0;
      this.glideLeft = MOVE.glideDuration;
      this.gliding = false;
      const n = this.groundNormal;

      // Sit *on* the plane: strip the into/out-of-surface component so the
      // whole velocity is a surface tangent. This is what makes a ramp convert
      // horizontal speed into along-surface speed instead of fighting the
      // solver — and it is why running downhill does not shed speed.
      if (this.jumpLock <= 0) this.velocity.addScaledVector(n, -this.velocity.dot(n));

      if (this.steepSliding) {
        // Too steep to walk. Gravity is applied *along the plane* rather than
        // straight down, because the collision solver zeroes vertical velocity
        // on contact and would otherwise cancel the slide every step.
        this.planeDown(n, _tmp);
        this.velocity.addScaledVector(_tmp, GRAVITY * dt);
        this.applyFriction3(dt, MOVE.airFriction);
        if (wishLen > 0) {
          this.tangent(_wish, n, _dir);
          this.accelerate(_dir, target * MOVE.steepControl, MOVE.airAccel * MOVE.steepControl, dt);
        }
      } else if (this.sliding) {
        this.slideStep(dt, wishLen);
      } else {
        this.applyFriction3(dt, wishLen > 0 ? MOVE.groundFriction : MOVE.groundDecel);
        // Accelerate along the surface tangent of the wish direction so the
        // target speed means "speed along the ground", not "horizontal speed".
        if (wishLen > 0) {
          this.tangent(_wish, n, _dir);
          this.accelerate(_dir, target, MOVE.groundAccel, dt);
        }
      }
    } else {
      this.airStep(dt, cmd, target, wishLen);
    }

    // -- integrate + resolve ----------------------------------------------
    if (this.grounded && !this.raySnapped && !this.steepSliding && this.jumpLock <= 0) {
      this.position.y -= MOVE.groundSettle;
    }
    this.clampVelocity();
    const fallSpeed = -this.velocity.y;
    this.wasGrounded = this.grounded;

    if (world) {
      if (this.grounded && !this.sliding) this.tryStepUp(world);
      // Sub-step when a single step would move further than most of the capsule
      // radius: that is the only way a fast fall can miss thin geometry.
      const travel = this.velocity.length() * dt;
      const sub = clamp(Math.ceil(travel / (this.radius * 0.8)), 1, 4);
      const sdt = dt / sub;
      let grounded = false;
      this.groundNormal.set(0, 1, 0);
      let bestUp = -1;
      for (let i = 0; i < sub; i++) {
        const res = world.resolveCapsule(
          this.position,
          this.radius,
          this.halfHeight,
          this.velocity,
          sdt,
        );
        if (res.grounded) {
          grounded = true;
          if (res.groundNormal.y > bestUp) {
            bestUp = res.groundNormal.y;
            this.groundNormal.copy(res.groundNormal);
            this.slope = res.slope;
          }
        }
      }
      if (!grounded) this.slope = 0;
      // The jump lock keeps the resolver's generous ground band from re-sticking
      // us on the very first ascending step.
      this.grounded = grounded && this.jumpLock <= 0 && this.velocity.y <= 0.6;
      // Walking off a convex edge, or standing on BVH geometry the solver only
      // reports while actually penetrating: pull the feet back onto the surface.
      this.raySnapped = false;
      if (this.wasGrounded && this.jumpLock <= 0 && this.velocity.y <= 0.6) {
        this.snapToGround(world);
      }
      this.steepSliding = this.grounded && this.slope > MOVE.maxSlope;
    } else {
      this.position.addScaledVector(this.velocity, dt);
      this.grounded = false;
      this.steepSliding = false;
    }

    if (!this.grounded) {
      this.airTime += dt;
    } else {
      this.sinceGrounded = 0;
      this.jumpsUsed = 0;
      if (!this.wasGrounded && fallSpeed > 1) this.landedImpact = fallSpeed;
    }

    // Rest snap: kills sub-millimetre creep and keeps the bob phase honest.
    if (this.grounded && !this.sliding && this.horizontalSpeed < MOVE.restSpeed && wishLen === 0) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    this.stepSmooth = damp(this.stepSmooth, 0, MOVE.stepSmoothRate, dt);
    if (Math.abs(this.stepSmooth) < 1e-4) this.stepSmooth = 0;

    this.refreshSurface(dt);
    this.guardNaN();
  }

  // -- pieces ---------------------------------------------------------------

  private updateSprint(dt: number, cmd: MoveCommand, mz: number, wishLen: number): void {
    const wantsSprint =
      cmd.controlEnabled &&
      cmd.sprintHeld &&
      cmd.allowSprint &&
      !this.crouching &&
      !this.sliding &&
      wishLen > 0.1 &&
      -mz > MOVE.sprintForwardThreshold;
    // The ramp is exponential toward the target so letting go decays smoothly
    // rather than dropping the FOV kick off a cliff.
    const rate = 1 / Math.max(0.02, MOVE.sprintRamp);
    this.sprintBlend = damp(this.sprintBlend, wantsSprint ? 1 : 0, rate * 3, dt);
    this.sprintBlend = clamp01(this.sprintBlend);
    this.sprinting = wantsSprint && this.sprintBlend > 0.35;
  }

  private updateStance(dt: number, cmd: MoveCommand): void {
    const wantCrouch = cmd.controlEnabled && cmd.crouchHeld;

    // Slide entry: sprinting + crouch + enough speed + off cooldown.
    if (
      !this.sliding &&
      wantCrouch &&
      this.grounded &&
      this.slideCooldown <= 0 &&
      this.sprintBlend > 0.5 &&
      this.horizontalSpeed > MOVE.slideMinSpeed
    ) {
      const speed = Math.min(this.horizontalSpeed * MOVE.slideBoost, MOVE.slideMaxSpeed);
      const inv = speed / Math.max(1e-4, this.horizontalSpeed);
      this.velocity.x *= inv;
      this.velocity.z *= inv;
      this.sliding = true;
      this.slideTime = 0;
      this.sprintBlend = 1;
    }

    if (this.sliding) {
      this.slideTime += dt;
      const ended =
        !wantCrouch ||
        !this.grounded ||
        this.slideTime > MOVE.slideDuration ||
        this.horizontalSpeed < MOVE.slideExitSpeed;
      if (ended) {
        this.sliding = false;
        this.slideCooldown = MOVE.slideCooldown;
        this.sprintBlend = Math.min(this.sprintBlend, 0.6);
      }
    }

    // Crouch: cannot stand back up under a ceiling.
    const shouldCrouch = wantCrouch || this.sliding;
    if (!shouldCrouch && this.crouching && !this.canStand()) {
      // Held down by geometry — stay crouched this step.
      this.crouching = true;
    } else {
      this.crouching = shouldCrouch;
    }

    const targetHalf = this.crouching ? MOVE.crouchHalfHeight : MOVE.standHalfHeight;
    const prev = this.halfHeight;
    this.halfHeight = damp(this.halfHeight, targetHalf, MOVE.crouchRate, dt);
    if (Math.abs(this.halfHeight - targetHalf) < 1e-4) this.halfHeight = targetHalf;
    const delta = this.halfHeight - prev;
    // Grounded: keep the feet planted (the head moves). Airborne: keep the head
    // steady and tuck the legs, which is what a real crouch-jump looks like.
    this.position.y += this.grounded ? delta : -delta;
  }

  /** Clearance test for standing back up. Only runs when we want to stand. */
  private canStand(): boolean {
    const world = this.world;
    if (!world) return true;
    const feet = this.feetY;
    const standTop = feet + 2 * (MOVE.standHalfHeight + this.radius);
    const from = this.position.y;
    const dist = standTop - from + 0.04;
    if (dist <= 0) return true;
    for (const [ox, oz] of STAND_PROBES) {
      _probe.set(this.position.x + ox * this.radius, from, this.position.z + oz * this.radius);
      if (world.raycast(_probe, _up, dist)) return false;
    }
    return true;
  }

  private handleJump(dt: number, cmd: MoveCommand): void {
    this.sinceLaunch += dt;
    if (!cmd.controlEnabled) return;

    const buffered = this.sinceJumpPressed <= MOVE.jumpBuffer;
    const coyote = this.grounded || this.sinceGrounded <= MOVE.coyoteTime;

    // Walking off a ledge and letting coyote time lapse costs the ground jump.
    // Without this you would get two *air* jumps for free by stepping off.
    if (!this.grounded && !coyote && this.jumpsUsed === 0) this.jumpsUsed = 1;

    if (buffered) {
      if (coyote && this.jumpsUsed === 0) {
        this.launch(this.jumpSpeed(MOVE.jumpHeight, dt));
        this.jumpsUsed = 1;
        this.jumpedThisStep = 1;
        if (this.sliding) {
          // Jump-cancelling a slide converts the slide's momentum into a boost.
          const s = this.horizontalSpeed;
          if (s > 1e-3) {
            const k = Math.min(s * MOVE.slideJumpBoost, MOVE.slideMaxSpeed) / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
          }
          this.sliding = false;
          this.slideCooldown = MOVE.slideCooldown;
        }
        this.sinceJumpPressed = 999;
      } else if (!this.grounded && this.jumpsUsed < MOVE.maxJumps) {
        this.launch(this.jumpSpeed(MOVE.doubleJumpHeight, dt));
        // Redirect: a small shove toward where the stick is pointing, so the
        // second jump is a course correction rather than a straight boost.
        if (Math.abs(_wish.x) + Math.abs(_wish.z) > 1e-3) {
          this.velocity.x += _wish.x * MOVE.doubleJumpRedirect;
          this.velocity.z += _wish.z * MOVE.doubleJumpRedirect;
        }
        this.jumpsUsed++;
        this.jumpedThisStep = 2;
        this.sinceJumpPressed = 999;
      }
    }

    // Variable height: releasing early trims the remaining rise. The minimum
    // hold time stops a single-frame tap (or a double jump released instantly)
    // from being cut to nothing, and the once-per-launch latch means the cut is
    // applied exactly once even if the release edge lands inside the jump lock.
    if (
      !this.jumpCutDone &&
      !cmd.jumpHeld &&
      this.velocity.y > 0 &&
      this.sinceLaunch >= MOVE.jumpCutDelay
    ) {
      this.velocity.y *= MOVE.jumpCutScale;
      this.jumpCutDone = true;
    }
  }

  /**
   * Impulse for a target apex height.
   *
   * The `+ g*dt/2` is not a fudge: gravity is applied *before* the position
   * integrate (semi-implicit Euler), which costs exactly half a step of rise.
   * Without the correction a 1.9 m jump peaks at 1.860 m; with it, 1.89995 m.
   */
  private jumpSpeed(height: number, dt: number): number {
    return Math.sqrt(2 * GRAVITY * height) + GRAVITY * dt * 0.5;
  }

  private launch(speed: number): void {
    this.velocity.y = speed;
    this.sinceLaunch = 0;
    this.jumpCutDone = false;
    this.grounded = false;
    this.steepSliding = false;
    this.jumpLock = MOVE.jumpLock;
    this.sinceGrounded = 999;
    this.gliding = false;
  }

  private airStep(dt: number, cmd: MoveCommand, target: number, wishLen: number): void {
    // Glide: hold jump on the way down after leaving the ground.
    const wantGlide =
      cmd.controlEnabled &&
      cmd.jumpHeld &&
      this.velocity.y < 0 &&
      this.airTime > 0.18 &&
      this.glideLeft > 0;
    this.gliding = wantGlide;
    if (wantGlide) this.glideLeft = Math.max(0, this.glideLeft - dt);

    const g = GRAVITY * (wantGlide ? MOVE.glideGravityScale : 1);
    this.velocity.y -= g * dt;
    if (wantGlide && this.velocity.y < -MOVE.glideMaxFall) this.velocity.y = -MOVE.glideMaxFall;

    if (wishLen > 0) {
      const speedBefore = this.horizontalSpeed;
      const accel = wantGlide ? MOVE.glideAirAccel : MOVE.airAccel;
      this.accelerate(_wish, target, accel, dt);
      // Soft cap: above it, air control may redirect but not add speed.
      const after = this.horizontalSpeed;
      const cap = Math.max(MOVE.airSpeedCap, speedBefore);
      if (after > cap && after > speedBefore) {
        const k = Math.max(cap, speedBefore) / after;
        this.velocity.x *= k;
        this.velocity.z *= k;
      }
    }
    if (MOVE.airFriction > 0) this.applyFriction(dt, MOVE.airFriction);
  }

  private slideStep(dt: number, wishLen: number): void {
    // Slide keeps its speed: only a light friction plus whatever the slope does.
    this.applyFriction3(dt, MOVE.slideFriction);

    // Gravity along the surface — downhill slides accelerate, uphill ones die.
    if (this.slope > 0.02) {
      this.planeDown(this.groundNormal, _tmp);
      this.velocity.addScaledVector(_tmp, GRAVITY * dt);
    }

    // Lateral steering only: you can aim a slide, you cannot pump it.
    if (wishLen > 0) {
      const s = this.horizontalSpeed;
      if (s > 1e-3) {
        _dir.set(this.velocity.x / s, 0, this.velocity.z / s);
        _tmp.copy(_wish).addScaledVector(_dir, -_wish.dot(_dir));
        const tl = _tmp.length();
        if (tl > 1e-4) {
          _tmp.multiplyScalar(1 / tl);
          this.velocity.addScaledVector(_tmp, MOVE.slideSteer * dt);
          // Steering must not add speed, only rotate it.
          const ns = this.horizontalSpeed;
          if (ns > s) {
            const k = s / ns;
            this.velocity.x *= k;
            this.velocity.z *= k;
          }
        }
      }
    }
  }

  /**
   * Quake-style friction: a *drop* subtracted from the speed, evaluated against
   * at least `stopSpeed`. A lerp toward zero never actually stops and makes the
   * last metre per second feel like ice.
   */
  private applyFriction(dt: number, rate: number): void {
    const speed = this.horizontalSpeed;
    if (speed < 1e-5) return;
    const control = Math.max(speed, MOVE.stopSpeed);
    const drop = control * rate * dt;
    const newSpeed = Math.max(0, speed - drop);
    const k = newSpeed / speed;
    this.velocity.x *= k;
    this.velocity.z *= k;
  }

  /** Friction on the full velocity. Used while grounded, where the velocity is
   *  a surface tangent and scaling only X/Z would tilt it off the slope. */
  private applyFriction3(dt: number, rate: number): void {
    const speed = this.velocity.length();
    if (speed < 1e-5) return;
    const control = Math.max(speed, MOVE.stopSpeed);
    const newSpeed = Math.max(0, speed - control * rate * dt);
    this.velocity.multiplyScalar(newSpeed / speed);
  }

  /** Unit downhill direction in the plane defined by `n`. Magnitude sin(slope). */
  private planeDown(n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    // (0,-1,0) projected onto the plane = (0,-1,0) + n * n.y
    return out.set(n.x * n.y, n.y * n.y - 1, n.z * n.y);
  }

  /** Project `v` onto the plane of `n` and renormalise. Falls back to `v`. */
  private tangent(v: THREE.Vector3, n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(v).addScaledVector(n, -v.dot(n));
    const l = out.length();
    if (l > 1e-4) out.multiplyScalar(1 / l);
    else out.copy(v);
    return out;
  }

  /**
   * The core of the feel. Only the component of the wish direction the player
   * is NOT already moving along can be accelerated, which is what turns air
   * strafing into a skill instead of a speed cheat.
   */
  private accelerate(dir: THREE.Vector3, wishSpeed: number, accel: number, dt: number): void {
    if (wishSpeed <= 0) return;
    const current = this.velocity.x * dir.x + this.velocity.y * dir.y + this.velocity.z * dir.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const step = Math.min(accel * dt, add);
    this.velocity.addScaledVector(dir, step);
  }

  /**
   * Silent step-up. Probes for a wall at ankle height, then for a walkable
   * surface just past it that is within `stepHeight`. The lift is recorded in
   * `stepSmooth` so the camera can lag behind it and hide the vertical pop.
   */
  private tryStepUp(world: CollisionWorld): void {
    const speed = this.horizontalSpeed;
    if (speed < 0.6) return;
    _dir.set(this.velocity.x / speed, 0, this.velocity.z / speed);

    const feet = this.feetY;
    // 1. Is something actually blocking us?
    _probe.set(this.position.x, feet + 0.08, this.position.z);
    const wall = world.raycast(_probe, _dir, this.radius + 0.24);
    if (!wall || Math.abs(wall.normal.y) > 0.55) return;

    // 2. Find the top of it.
    const px = this.position.x + _dir.x * (this.radius + 0.2);
    const pz = this.position.z + _dir.z * (this.radius + 0.2);
    _probe.set(px, feet + MOVE.stepHeight + 0.08, pz);
    const top = world.raycast(_probe, _down, MOVE.stepHeight + 0.16);
    if (!top) return;
    const rise = top.point.y - feet;
    if (rise < 0.04 || rise > MOVE.stepHeight) return;
    if (top.normal.y < Math.cos(MOVE.maxSlope)) return;

    // 3. Is there room for the capsule up there?
    _probe.set(px, top.point.y + 0.06, pz);
    if (world.raycast(_probe, _up, 2 * (this.halfHeight + this.radius) - 0.06)) return;

    this.position.y += rise + 0.02;
    this.stepSmooth += rise;
  }

  /**
   * Keep the feet exactly on a walkable surface within `groundSnap` below them.
   * Grounded state comes from this probe as well as from the solver, which is
   * what lets the capsule rest with zero penetration and therefore zero
   * push-out jitter.
   */
  private snapToGround(world: CollisionWorld): void {
    const reach = this.halfHeight + this.radius;
    _probe.set(this.position.x, this.position.y, this.position.z);
    const hit = world.raycast(_probe, _down, reach + MOVE.groundSnap, _groundHit);
    if (!hit) return;
    if (hit.normal.y < Math.cos(MOVE.maxSlope)) return;
    const drop = hit.distance - reach;
    if (drop < -0.02 || drop > MOVE.groundSnap) return;
    this.position.y = hit.point.y + reach;
    this.raySnapped = true;
    this.grounded = true;
    this.groundNormal.copy(hit.normal);
    this.slope = Math.acos(clamp(hit.normal.y, -1, 1));
    this.groundSurface = hit.surface;
    this.surfaceTimer = 0.25;
  }

  private clampVelocity(): void {
    if (this.velocity.y < -MOVE.maxFallSpeed) this.velocity.y = -MOVE.maxFallSpeed;
    const h = this.horizontalSpeed;
    const hardCap = MOVE.slideMaxSpeed * 2.5;
    if (h > hardCap) {
      const k = hardCap / h;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
  }

  /** Cheap periodic surface sample so footsteps pick the right material. */
  private refreshSurface(dt: number): void {
    this.surfaceTimer -= dt;
    if (this.surfaceTimer > 0 || !this.grounded || !this.world) return;
    this.surfaceTimer = 0.25;
    _probe.set(this.position.x, this.position.y, this.position.z);
    const hit = this.world.raycast(_probe, _down, this.halfHeight + this.radius + 0.4, _groundHit);
    if (hit) this.groundSurface = hit.surface;
  }

  /**
   * A single NaN in a character controller poisons the camera matrix and blanks
   * the frame, so it is worth one branch per step to guarantee it cannot happen.
   */
  private guardNaN(): void {
    const p = this.position;
    const v = this.velocity;
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) v.set(0, 0, 0);
      return;
    }
    p.set(0, 0, 0);
    v.set(0, 0, 0);
    this.halfHeight = MOVE.standHalfHeight;
  }
}
