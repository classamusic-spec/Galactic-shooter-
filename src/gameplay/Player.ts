/**
 * The Guardian: the player character controller.
 *
 * This class is deliberately thin — it is the *integration* layer. The three
 * things that actually decide how the game feels each live in their own file:
 *
 *   - `PlayerMovement` — capsule locomotion, the friction model, air strafing,
 *      jump/slide/crouch/slope/step-up.
 *   - `PlayerCamera`  — the summed-contribution camera rig (bob, roll, dip,
 *      recoil, shake, death fall) plus the single owner of the FOV.
 *   - `ViewKick`      — the two-part recoil model and the shake stack.
 *
 * What lives here: health and shields, damage resolution and the events other
 * systems subscribe to, the look angles (because recoil moves them), and the
 * translation from `InputSystem` actions into a `MoveCommand`.
 *
 * Simulation is in `update()` at a fixed 120 Hz. Anything whose smoothness the
 * player can see is in `render()`, running on the real frame delta.
 */
import * as THREE from 'three';
import type { Engine, EngineSystem } from '@/core/Engine';
import type {
  CollisionWorld,
  Damageable,
  DamageInfo,
  FrameContext,
  SurfaceKind,
} from '@/types';
import {
  computeAimAssist,
  type AimAssistResult,
  type AimTargetSource,
} from '@/gameplay/AimAssist';
import { settings } from '@/core/Settings';
import { events } from '@/core/EventBus';
import { clamp, clamp01, lerp } from '@/util/math';
import { MOVE, PlayerMovement, createMoveCommand } from './PlayerMovement';
import { PlayerCamera, VIEW, createCameraState, wrapAngle } from './PlayerCamera';
import type { AimDelta } from './ViewKick';

/** Survivability tuning. Destiny-style: a big regenerating shield over a small
 *  health pool, so most fights are recoverable but a bad one is not. */
export const VITALS = {
  maxHealth: 100,
  maxShield: 130,
  /** Undamaged time before the shield starts refilling. */
  shieldDelay: 4.5,
  /** Seconds for an empty shield to reach full once it starts. */
  shieldRefill: 2.5,
  /** Extra delay after the shield tops out before health begins to come back. */
  healthDelay: 1.5,
  /** Seconds for health to go 0 → full. Deliberately slow: health is a resource. */
  healthRefill: 7,
  /**
   * Fraction of a shield-breaking hit's overkill that carries into health.
   * Below 1 so breaking the shield is a readable beat rather than a silent
   * continuation — but NOT zero, or a rocket to the face would be survivable
   * purely because the shield happened to be up.
   */
  breakCarry: 0.5,
  /** Extra regen delay imposed by a shield break, on top of `shieldDelay`. */
  breakPenalty: 0.6,
} as const;

/** Reused so a hit never allocates on the damage path. */
const _fallDamage: DamageInfo = {
  amount: 0,
  element: 'kinetic',
  region: 'body',
  precision: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  direction: new THREE.Vector3(0, -1, 0),
  sourceId: -1,
};

const _dmgDir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _aimDelta: AimDelta = { pitch: 0, yaw: 0 };

export class Player implements EngineSystem, Damageable {
  readonly name = 'player';
  /** Entity 0 is always the player — weapons and AI use this to skip self-hits. */
  readonly entityId = 0;

  // Explicit `number` annotations: `VITALS` is `as const`, so inference would
  // otherwise pin these fields to their literal initial values.
  health: number = VITALS.maxHealth;
  maxHealth: number = VITALS.maxHealth;
  shield: number = VITALS.maxShield;
  maxShield: number = VITALS.maxShield;

  /** Capsule centre. Alias of the mover's state — same object, no copying. */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** Sim-exact eye position. Weapons fire from here; the *visual* eye (with bob
   *  and shake folded in) is `viewCamera.eye`. */
  readonly eyePosition = new THREE.Vector3();
  /** True while gamepad aim assist has a target under the crosshair. */
  aimLocked = false;
  /** Last aim-assist result, for the controller test harness. */
  aimAssistDebug: AimAssistResult | null = null;
  /**
   * Aim-assist candidate source. Injected rather than imported so `Player` stays
   * independent of `EnemyManager`, the same way collision is bound.
   */
  private aimTargets: AimTargetSource | null = null;
  /** Unit vector the player is actually aiming along, recoil included. */
  readonly aimDirection = new THREE.Vector3(0, 0, -1);

  /** Look angles, radians. Recoil writes into these — that is the point. */
  yaw = 0;
  pitch = 0;

  /** 0..1 aim-down-sights blend. Written by WeaponSystem. */
  aimProgress = 0;
  /** ADS zoom factor for the active weapon. WeaponSystem should set this rather
   *  than calling `host.applyFov` itself — the camera owns the projection. */
  aimZoom: number = VIEW.defaultAimZoom;
  /** Set by WeaponSystem while the trigger is down; blocks sprint. */
  firing = false;

  /** The camera rig. Public so the view model can read bob phase and shake. */
  readonly viewCamera = new PlayerCamera();
  readonly movement = new PlayerMovement();

  /** Optional footstep sink for the audio system: `player.onFootstep = …`. */
  onFootstep: ((surface: SurfaceKind, position: THREE.Vector3, speed: number) => void) | null =
    null;
  /** Optional name lookup so `player:died` can report who killed you. */
  resolveAttackerName: ((sourceId: number) => string) | null = null;

  private engine: Engine;
  private cmd = createMoveCommand();
  private camState = createCameraState();
  private prevPosition = new THREE.Vector3();
  private prevEyeHeight = 1.7;
  private prevCentreToFeet = 1;

  private sinceDamage = 999;
  private sinceShieldFull = 999;
  private deadFlag = false;
  private lastFootstep = 0;
  private unsubs: Array<() => void> = [];

  constructor(engine: Engine) {
    this.engine = engine;
    this.position = this.movement.position;
    this.velocity = this.movement.velocity;
    this.viewCamera.reset(this.camState);

    // Anything in the game may ask for a shake; route it through the one stack
    // that knows about reduced-motion and the global cap.
    this.unsubs.push(
      events.on('camera:shake', (p) => this.addShake(p.amount, p.duration, p.frequency)),
      events.on('player:respawn', () => this.revive()),
      events.on('explosion', (p) => {
        // Distance-scaled concussion, so a rocket across the arena is a rumble
        // and one at your feet is a kick.
        const d = this.eyePosition.distanceTo(p.point);
        const falloff = clamp01(1 - d / Math.max(1, p.radius * 3.5));
        if (falloff > 0.01) this.addShake(falloff * falloff * 1.6, 0.42, 22);
      }),
    );
  }

  // -- Damageable ------------------------------------------------------------

  get isDead(): boolean {
    return this.deadFlag;
  }

  getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position);
  }

  applyDamage(info: DamageInfo): number {
    if (this.deadFlag || info.amount <= 0) return 0;

    const hadShield = this.shield > 0;
    let remaining = info.amount;
    let dealt = 0;

    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      dealt += absorbed;
    }
    const shieldBroke = hadShield && this.shield <= 0;
    if (remaining > 0) {
      // Overkill from the hit that popped the shield is softened, not erased.
      const carry = shieldBroke ? remaining * VITALS.breakCarry : remaining;
      const taken = Math.min(this.health, carry);
      this.health -= taken;
      dealt += taken;
    }

    // A break also pushes the regen clock backwards — losing your shield should
    // cost more than the last point of it.
    this.sinceDamage = shieldBroke ? -VITALS.breakPenalty : 0;
    this.sinceShieldFull = 999;

    // Direction *toward* the attacker, which is what a hit indicator wants.
    if (info.direction.lengthSq() > 1e-6) _dmgDir.copy(info.direction).normalize().negate();
    else _dmgDir.copy(this.eyePosition).sub(info.point).normalize();
    if (!Number.isFinite(_dmgDir.x)) _dmgDir.set(0, 0, 1);

    // Punch away from the hit, expressed in view space.
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const localX = _dmgDir.x * cy - _dmgDir.z * sy;
    const localZ = _dmgDir.x * -sy - _dmgDir.z * cy;
    this.viewCamera.punch(clamp01(info.amount / 45), localX, localZ);

    events.emit('player:damaged', { amount: dealt, direction: _dmgDir, shieldBroke });

    if (this.health <= 0 && !this.deadFlag) this.die(info.sourceId);
    return dealt;
  }

  // -- lifecycle -------------------------------------------------------------

  bindCollision(world: CollisionWorld): void {
    this.movement.world = world;
  }

  /** Supply the aim-assist candidate list. Null disables assist entirely. */
  bindAimTargets(source: AimTargetSource | null): void {
    this.aimTargets = source;
  }

  teleport(position: THREE.Vector3, yaw: number): void {
    this.movement.teleport(position);
    this.yaw = wrapAngle(yaw);
    this.pitch = 0;
    this.prevPosition.copy(position);
    this.syncCamState(1);
    this.viewCamera.reset(this.camState);
    this.refreshEye();
    this.lastFootstep = this.viewCamera.footstepCount;
  }

  /** Full restore. Also fired by the `player:respawn` event. */
  revive(): void {
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.deadFlag = false;
    this.sinceDamage = 999;
    this.sinceShieldFull = 0;
    this.viewCamera.reset(this.camState);
    if (this.engine.state === 'dead') this.engine.state = 'playing';
  }

  private die(sourceId: number): void {
    this.health = 0;
    this.shield = 0;
    this.deadFlag = true;
    this.viewCamera.beginDeath();
    this.engine.state = 'dead';
    const name =
      this.resolveAttackerName?.(sourceId) ?? (sourceId === -1 ? 'the fall' : 'an unknown hostile');
    events.emit('player:died', { killerName: name });
  }

  // -- API other systems call ------------------------------------------------

  /**
   * Weapon recoil. Pitch is muzzle rise (positive = up), yaw is lateral, roll is
   * cosmetic. `recovery` overrides the auto-recentre rate in 1/s.
   */
  addViewKick(pitch: number, yaw: number, roll: number, recovery?: number): void {
    this.viewCamera.kick.add(pitch, yaw, roll, recovery);
  }

  addShake(amount: number, duration?: number, frequency?: number): void {
    this.viewCamera.shake.add(amount, duration, frequency);
  }

  addImpulse(v: THREE.Vector3): void {
    this.movement.addImpulse(v);
  }

  // -- convenience readbacks -------------------------------------------------

  get grounded(): boolean {
    return this.movement.grounded;
  }
  get crouching(): boolean {
    return this.movement.crouching;
  }
  get sprinting(): boolean {
    return this.movement.sprinting;
  }
  get sliding(): boolean {
    return this.movement.sliding;
  }
  get airborne(): boolean {
    return !this.movement.grounded;
  }
  /** Horizontal speed, m/s. HUD and audio both want this. */
  get speed(): number {
    return this.movement.horizontalSpeed;
  }
  /** 0..1 shield fraction, for the HUD. */
  get shield01(): number {
    return this.maxShield > 0 ? this.shield / this.maxShield : 0;
  }
  get health01(): number {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0;
  }

  // -- simulation ------------------------------------------------------------

  update(ctx: FrameContext): void {
    const dt = ctx.dt;
    const input = this.engine.input;
    const playing = this.engine.state === 'playing' && !this.deadFlag;

    this.prevPosition.copy(this.position);
    this.prevEyeHeight = this.movement.eyeHeight;
    this.prevCentreToFeet = this.movement.halfHeight + this.movement.radius;

    // -- look ---------------------------------------------------------------
    const look = input.consumeLook();
    if (playing) {
      // Aim assist is gamepad-only and applies before the look is committed:
      // friction scales the player's own delta, adhesion adds to it. A mouse
      // never reaches this branch, so nothing about mouse aim changes.
      if (input.usingGamepad) {
        const assist = computeAimAssist(
          this.aimTargets,
          this.eyePosition,
          this.yaw,
          this.pitch,
          input.lookStick,
          settings.user.aimAssist,
          dt,
        );
        look.yaw *= assist.frictionScale;
        look.pitch *= assist.frictionScale;
        look.yaw += assist.yaw;
        look.pitch += assist.pitch;
        this.aimLocked = assist.locked;
        this.aimAssistDebug = assist;
      } else {
        this.aimLocked = false;
      }
      // Tell the recoil model how much the player compensated so it does not
      // hand back an aim correction the player already made themselves.
      this.viewCamera.kick.absorbManualLook(look.pitch, look.yaw);
      this.yaw += look.yaw;
      this.pitch += look.pitch;
    }

    // Recoil's aim half moves the true angles, and only partially recovers.
    this.viewCamera.kick.step(dt, _aimDelta);
    if (!this.deadFlag) {
      this.pitch += _aimDelta.pitch;
      this.yaw += _aimDelta.yaw;
    }
    this.yaw = wrapAngle(this.yaw);
    this.pitch = clamp(this.pitch, -VIEW.pitchLimit, VIEW.pitchLimit);

    // -- movement command ---------------------------------------------------
    const cmd = this.cmd;
    cmd.moveX = input.moveX;
    cmd.moveZ = input.moveZ;
    cmd.yaw = this.yaw;
    cmd.jumpHeld = input.down('jump');
    cmd.jumpPressed = input.pressed('jump');
    cmd.jumpReleased = input.released('jump');
    cmd.crouchHeld = input.down('crouch') || input.down('slide');
    cmd.sprintHeld = input.down('sprint');
    // Firing or aiming drops you out of sprint; the ramp decays rather than cuts.
    cmd.allowSprint = !this.firing && this.aimProgress < 0.4;
    cmd.speedScale = lerp(1, MOVE.adsSpeedScale, clamp01(this.aimProgress));
    cmd.controlEnabled = playing;

    this.movement.update(dt, cmd);

    // -- takeoff / landing / fall damage ------------------------------------
    if (this.movement.jumpedThisStep > 0) this.viewCamera.jump(this.movement.jumpedThisStep);
    const impact = this.movement.landedImpact;
    if (impact > 1) {
      this.viewCamera.land(impact);
      if (impact > MOVE.fallDamageSpeed) {
        const amount = (impact - MOVE.fallDamageSpeed) * MOVE.fallDamagePerSpeed;
        _fallDamage.amount = amount;
        _fallDamage.point.copy(this.position);
        _fallDamage.direction.set(0, -1, 0);
        _fallDamage.normal.copy(this.movement.groundNormal);
        this.applyDamage(_fallDamage);
      }
    }

    // -- regeneration -------------------------------------------------------
    this.regenerate(dt);

    this.refreshEye();
  }

  private regenerate(dt: number): void {
    if (this.deadFlag) return;
    this.sinceDamage += dt;
    if (this.sinceDamage < VITALS.shieldDelay) {
      this.sinceShieldFull = 0;
      return;
    }
    if (this.shield < this.maxShield) {
      const before = this.shield;
      this.shield = Math.min(this.maxShield, this.shield + (this.maxShield / VITALS.shieldRefill) * dt);
      if (this.shield >= this.maxShield && before < this.maxShield) this.sinceShieldFull = 0;
      return;
    }
    // Health only comes back once the shield is capped, and much more slowly.
    this.sinceShieldFull += dt;
    if (this.sinceShieldFull < VITALS.healthDelay || this.health >= this.maxHealth) return;
    const gain = Math.min(
      this.maxHealth - this.health,
      (this.maxHealth / VITALS.healthRefill) * dt,
    );
    this.health += gain;
    if (gain > 0) events.emit('player:healed', { amount: gain });
  }

  private refreshEye(): void {
    const m = this.movement;
    this.eyePosition.set(
      m.position.x,
      m.position.y - (m.halfHeight + m.radius) + m.eyeHeight,
      m.position.z,
    );
    const cp = Math.cos(this.pitch);
    this.aimDirection.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  // -- presentation ----------------------------------------------------------

  render(ctx: FrameContext, alpha: number): void {
    this.syncCamState(alpha);
    this.viewCamera.render(ctx.frameDt, this.camState, this.engine.host);

    // Footsteps are counted by the bob phase, so the sound lands exactly on the
    // visual footfall instead of on a separate timer that slowly drifts.
    const steps = this.viewCamera.footstepCount;
    if (steps !== this.lastFootstep) {
      this.lastFootstep = steps;
      this.emitFootstep();
    }
  }

  private syncCamState(alpha: number): void {
    const s = this.camState;
    const a = clamp01(alpha);
    const m = this.movement;
    s.position.lerpVectors(this.prevPosition, m.position, a);
    s.eyeHeight = lerp(this.prevEyeHeight, m.eyeHeight, a);
    s.centreToFeet = lerp(this.prevCentreToFeet, m.halfHeight + m.radius, a);
    s.velocity.copy(m.velocity);
    s.yaw = this.yaw;
    s.pitch = this.pitch;
    // From the command, not raw input, so a paused or dead player stops leaning.
    s.strafe = this.cmd.controlEnabled ? this.cmd.moveX : 0;
    s.grounded = m.grounded;
    s.crouching = m.crouching;
    s.sliding = m.sliding;
    s.aimProgress = clamp01(this.aimProgress);
    s.aimZoom = this.aimZoom;
    s.sprintBlend = m.sprintBlend;
    s.stepSmooth = m.stepSmooth;
    s.dead = this.deadFlag;
  }

  private emitFootstep(): void {
    if (!this.movement.grounded) return;
    const speed = this.movement.horizontalSpeed;
    if (speed < 0.5) return;
    const surface = this.movement.groundSurface;
    _tmp.set(this.position.x, this.movement.feetY, this.position.z);
    this.onFootstep?.(surface, _tmp, speed);
    // Also broadcast as a very small surface impact: VFX gets a dust scuff and
    // audio gets a positioned event, without Player depending on either system.
    events.emit('impact:surface', {
      point: _tmp,
      normal: this.movement.groundNormal,
      surface,
      scale: 0.12 * clamp01(speed / MOVE.sprintSpeed),
    });
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.movement.world = null;
  }
}
