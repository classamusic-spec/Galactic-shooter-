/**
 * Melee: lunge, sweep, hit-stop, charge and finisher.
 *
 * The whole point of a melee in a shooter is the *impact*, and impact is almost
 * entirely a timing problem:
 *
 *  - **Lunge** closes the last few metres for you, so the player commits to the
 *    intent rather than to the distance. Acquisition is a cone in front of the
 *    camera, biased toward whatever is closest to the crosshair.
 *  - **The hitbox is a swept arc**, not a point: over the 120 ms the swing is
 *    active, a blade angle travels from one side of the arc to the other and
 *    everything it passes through is struck once. That is what lets one swing
 *    catch three enemies without also letting it catch something behind you.
 *  - **Hit-stop** is the single highest-value 50 ms in the game. On a connect,
 *    time stops for the swing, the player's momentum is killed dead, and the
 *    struck enemies are pinned. Without it, a melee that deals 80 damage feels
 *    identical to one that deals 8.
 *  - **Charge** upgrades the swing in place. The first 80 ms of a light and a
 *    charged swing are identical, so the input response never depends on
 *    predicting what the player is about to do.
 *  - **Finisher** replaces the swing entirely when the target is nearly dead
 *    and close: guaranteed kill, longer hit-stop, and a chunk of super energy.
 */
import * as THREE from 'three';
import type { Damageable } from '@/types';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { clamp, clamp01 } from '@/util/math';
import type { AbilityContext } from './Context';
import type { MeleeSpec } from './Definitions';

export type MeleePhase = 'idle' | 'windup' | 'charging' | 'active' | 'recover';

/** Vertical half-extent of the swing, metres. */
const SWING_HEIGHT = 1.5;
/** Angular half-width of the blade itself, radians. */
const BLADE_WIDTH = 0.32;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _normal = new THREE.Vector3();

export interface MeleeResult {
  hits: number;
  kills: number;
  finisher: boolean;
}

export class MeleeController {
  private ctx: AbilityContext;
  spec: MeleeSpec;

  phase: MeleePhase = 'idle';
  private timer = 0;
  private chargeHeld = 0;
  private chargeSpark = 0;
  private charged = false;
  private finisher = false;
  private sweep = 0;
  private struck = new Set<number>();
  private lungeTarget: Damageable | null = null;
  private lungeTime = 0;
  private result: MeleeResult = { hits: 0, kills: 0, finisher: false };
  private kickSign = 1;

  /** Set while a swing is live, so the view model can pose the arm. */
  swingProgress = 0;

  constructor(ctx: AbilityContext, spec: MeleeSpec) {
    this.ctx = ctx;
    this.spec = spec;
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  /** True when a finisher would trigger right now — the HUD can prompt for it. */
  get finisherAvailable(): boolean {
    const t = this.acquire(2.4, this.spec.lungeCone * 1.4);
    return t != null && this.isFinishable(t);
  }

  private isFinishable(t: Damageable): boolean {
    if (t.maxHealth <= 0) return false;
    return t.shield <= 0 && t.health / t.maxHealth <= this.spec.finisherThreshold;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /** Begin a swing. Returns false when one is already running. */
  begin(): boolean {
    if (this.phase !== 'idle') return false;
    this.phase = 'windup';
    this.timer = 0;
    this.chargeHeld = 0;
    this.charged = false;
    this.sweep = 0;
    this.struck.clear();
    this.result.hits = 0;
    this.result.kills = 0;
    this.result.finisher = false;

    const target = this.acquire(this.spec.lungeRange, this.spec.lungeCone);
    this.finisher = target != null && this.isFinishable(target);
    this.lungeTarget = target;
    this.lungeTime = 0;

    events.emit('ability:used', { id: this.spec.id, slot: 'melee' });
    return true;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * `held` is whether the melee key is still down. Returns the swing's result on
   * the step the hitbox closes, otherwise null.
   */
  update(dt: number, held: boolean): MeleeResult | null {
    if (this.phase === 'idle') return null;
    const spec = this.spec;
    this.timer += dt;

    // -- lunge --------------------------------------------------------------
    if (this.lungeTarget && this.lungeTime < 0.22 && this.phase !== 'recover') {
      this.lungeTime += dt;
      if (this.lungeTarget.isDead) {
        this.lungeTarget = null;
      } else {
        this.lungeTarget.getWorldPosition(_v);
        _v.sub(this.ctx.player.position);
        _v.y = 0;
        const d = _v.length();
        if (d > 1.4) {
          _v.multiplyScalar(1 / d);
          const speed = Math.min(spec.lungeSpeed, d / Math.max(dt, 1e-4));
          const vel = this.ctx.player.velocity;
          vel.x = _v.x * speed;
          vel.z = _v.z * speed;
        } else {
          this.lungeTarget = null;
        }
      }
    }

    switch (this.phase) {
      case 'windup':
        this.swingProgress = clamp01(this.timer / spec.windup) * 0.3;
        if (this.timer >= spec.windup) {
          // Still holding? Roll into the charge instead of swinging.
          if (held && !this.finisher) {
            this.phase = 'charging';
            this.timer = 0;
            this.chargeHeld = 0;
          } else {
            this.openHitbox();
          }
        }
        break;

      case 'charging': {
        this.chargeHeld += dt;
        this.swingProgress = 0.3 + clamp01(this.chargeHeld / spec.chargeTime) * 0.2;
        // Charge VFX builds in the player's hand, on a fixed cadence so the
        // simulation stays deterministic.
        this.chargeSpark -= dt;
        if (this.chargeSpark <= 0) {
          this.chargeSpark = 0.06;
          this.handPoint(_hitPoint);
          this.ctx.vfx.elementalBurst(_hitPoint, spec.element, 0.16);
        }
        if (!held || this.chargeHeld >= spec.chargeTime) {
          this.charged = this.chargeHeld >= spec.chargeTime * 0.75;
          this.openHitbox();
        }
        break;
      }

      case 'active': {
        const arc = this.charged ? spec.chargedArc : spec.arc;
        const prev = this.sweep;
        this.sweep = clamp01(this.timer / spec.active);
        this.sweepStrike(prev, this.sweep, arc);
        this.swingProgress = 0.5 + this.sweep * 0.35;
        if (this.timer >= spec.active) {
          this.phase = 'recover';
          this.timer = 0;
          const out = this.result;
          return out;
        }
        break;
      }

      case 'recover':
        this.swingProgress = 0.85 + clamp01(this.timer / spec.recover) * 0.15;
        if (this.timer >= spec.recover) {
          this.phase = 'idle';
          this.swingProgress = 0;
          this.lungeTarget = null;
        }
        break;

      default:
        break;
    }
    return null;
  }

  private openHitbox(): void {
    this.phase = 'active';
    this.timer = 0;
    this.sweep = 0;
    this.struck.clear();
    this.handPoint(_hitPoint);
    this.ctx.vfx.elementalBurst(_hitPoint, this.spec.element, this.charged ? 0.9 : 0.5);
  }

  private handPoint(out: THREE.Vector3): THREE.Vector3 {
    const p = this.ctx.player;
    out.copy(p.eyePosition).addScaledVector(p.aimDirection, 0.9);
    out.y -= 0.2;
    return out;
  }

  // -------------------------------------------------------------------------
  // The swept arc
  // -------------------------------------------------------------------------

  /**
   * Strike everything the blade passed between `t0` and `t1` of the sweep.
   * Working in polar coordinates around the player is both cheaper and more
   * predictable than sampling spheres along the arc, and it makes "did the
   * blade reach it" a single angle comparison.
   */
  private sweepStrike(t0: number, t1: number, arc: number): void {
    const spec = this.spec;
    const player = this.ctx.player;
    const yaw = player.yaw;
    _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));

    // The blade travels from one edge of the arc to the other over the window.
    const angleFrom = (t0 * 2 - 1) * arc;
    const angleTo = (t1 * 2 - 1) * arc;
    const lo = Math.min(angleFrom, angleTo) - BLADE_WIDTH;
    const hi = Math.max(angleFrom, angleTo) + BLADE_WIDTH;

    const reach = spec.range * (this.charged ? 1.25 : 1);
    const enemies = this.ctx.enemies();
    const collision = this.ctx.collision();

    for (const e of enemies) {
      if (e.isDead || this.struck.has(e.entityId)) continue;
      e.getWorldPosition(_v);
      _v2.subVectors(_v, player.position);
      if (Math.abs(_v2.y) > SWING_HEIGHT) continue;
      _v2.y = 0;
      const dist = _v2.length();
      if (dist > reach + 0.6) continue;

      // Signed angle from forward, in the horizontal plane.
      const cross = _fwd.x * _v2.z - _fwd.z * _v2.x;
      const dot = _fwd.x * _v2.x + _fwd.z * _v2.z;
      const angle = Math.atan2(cross, dot);
      if (angle < lo || angle > hi) continue;

      // A wall between you and it stops the swing.
      if (collision) {
        _hitPoint.copy(_v);
        _hitPoint.y += 0.8;
        if (!collision.lineOfSight(player.eyePosition, _hitPoint)) continue;
      }

      this.struck.add(e.entityId);
      this.strike(e, dist);
    }
  }

  private strike(target: Damageable, distance: number): void {
    const spec = this.spec;
    const ctx = this.ctx;
    const player = ctx.player;

    _hitPoint.copy(target.getWorldPosition(_v));
    _hitPoint.y += 0.9;
    _v2.subVectors(_hitPoint, player.eyePosition).normalize();

    const finisher = this.finisher && this.struck.size === 1 && distance < 2.6;
    const base = finisher
      ? target.maxHealth + target.maxShield + 1000
      : this.charged
        ? spec.chargedDamage
        : spec.damage;

    // Frozen targets shatter instead of taking a normal hit.
    const shattered = ctx.status.shatter(target, 0);

    const dealt = ctx.damage.resolve({
      target,
      amount: base,
      element: spec.element,
      sourceId: 0,
      point: _hitPoint,
      normal: _normal.copy(_v2).negate(),
      direction: _v2,
      region: finisher ? 'critSpot' : 'body',
      precision: finisher,
      impulse: finisher ? 900 : this.charged ? 520 : 300,
      hitmarker: true,
    });

    if (dealt <= 0 && !shattered) return;
    this.result.hits++;

    if (spec.status && !finisher) {
      ctx.status.apply(target, spec.status, {
        stacks: spec.statusStacks,
        sourceId: 0,
      });
    }

    // -- feedback ----------------------------------------------------------
    ctx.vfx.elementalBurst(_hitPoint, spec.element, finisher ? 1.8 : this.charged ? 1.1 : 0.7);
    ctx.vfx.impact(_hitPoint, _normal.copy(_v2).negate(), spec.surface, finisher ? 2 : 1.2);
    ctx.vfx.bloodOrIchor(_hitPoint, _v2, 1.4);

    const stop = finisher
      ? spec.chargedHitStop * 1.9
      : this.charged
        ? spec.chargedHitStop
        : spec.hitStop;
    ctx.hitStop(stop);

    const shake = settings.user.reducedMotion ? 0.4 : 1;
    player.addShake((finisher ? 2.6 : this.charged ? 1.7 : 1.1) * shake, 0.26, 26);
    // Alternate the lateral kick so consecutive swings do not walk the aim.
    this.kickSign = -this.kickSign;
    player.addViewKick(
      finisher ? 0.06 : 0.035,
      this.kickSign * 0.012,
      this.kickSign * (this.charged ? 0.05 : 0.025),
    );

    if (target.isDead) {
      this.result.kills++;
      if (finisher) {
        this.result.finisher = true;
        ctx.addSuperEnergy(spec.finisherSuperEnergy);
        ctx.vfx.explosion(_hitPoint, 1.6, spec.element);
      }
      if (spec.healOnKill > 0) this.heal(spec.healOnKill);
    }

    // Arc's melee jumps to a second target.
    if (spec.element === 'arc' && !finisher) this.chain(target, _hitPoint, dealt * 0.45);
  }

  private chain(from: Damageable, origin: THREE.Vector3, amount: number): void {
    let best: Damageable | null = null;
    let bestD = 6.5;
    for (const e of this.ctx.enemies()) {
      if (e.isDead || e.entityId === from.entityId || this.struck.has(e.entityId)) continue;
      const d = e.getWorldPosition(_v).distanceTo(origin);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) return;
    best.getWorldPosition(_v);
    _v.y += 0.9;
    this.ctx.vfx.chain(origin, _v, this.spec.color, 0.05);
    this.ctx.damage.resolve({
      target: best,
      amount,
      element: 'arc',
      sourceId: 0,
      point: _v,
      region: 'body',
      hitmarker: true,
    });
    this.ctx.status.apply(best, 'shock', { sourceId: 0 });
  }

  private heal(amount: number): void {
    const p = this.ctx.player;
    const before = p.health;
    p.health = clamp(p.health + amount, 0, p.maxHealth);
    const gained = p.health - before;
    // Overheal spills into the shield, which is what makes an aggressive melee
    // build survivable rather than merely fast.
    const spill = amount - gained;
    if (spill > 0) p.shield = clamp(p.shield + spill * 0.6, 0, p.maxShield);
    if (gained > 0) events.emit('player:healed', { amount: gained });
  }

  // -------------------------------------------------------------------------
  // Target acquisition
  // -------------------------------------------------------------------------

  /** Best target inside a cone around the aim direction, nearest to the axis. */
  private acquire(range: number, cone: number): Damageable | null {
    const player = this.ctx.player;
    const aim = player.aimDirection;
    let best: Damageable | null = null;
    let bestScore = -Infinity;
    const cosCone = Math.cos(cone);

    for (const e of this.ctx.enemies()) {
      if (e.isDead) continue;
      e.getWorldPosition(_v);
      _v.y += 0.9;
      _v2.subVectors(_v, player.eyePosition);
      const dist = _v2.length();
      if (dist > range || dist < 1e-3) continue;
      _v2.multiplyScalar(1 / dist);
      const align = _v2.dot(aim);
      if (align < cosCone) continue;
      // Prefer things near the crosshair over things merely close.
      const score = align * 3 - dist / range;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  cancel(): void {
    this.phase = 'idle';
    this.swingProgress = 0;
    this.lungeTarget = null;
    this.struck.clear();
  }
}
