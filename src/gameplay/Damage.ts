/**
 * Damage resolution.
 *
 * Every source of harm in the game — bullets, splash, grenades, melee, burn
 * ticks, fall damage from abilities — funnels through here so that the rules
 * are written once. `Damageable.applyDamage` stays deliberately dumb (subtract
 * from shield, then health); everything that decides *how much* lives in this
 * file.
 *
 * The order of operations matters and is fixed:
 *
 *   base
 *     x region multiplier      (head/crit-spot, from the HitProxy that was hit)
 *     x range falloff          (weapon-defined curve)
 *     x power delta            (attacker level vs target level)
 *     x weaken / empower       (status effects)
 *     x splash falloff         (distance from the blast, with a LOS test)
 *     x element vs shield      (only for targets that do not do this themselves)
 *
 * Multiplicative throughout, because that is the only ordering where two
 * independent buffs cannot interact into a number nobody predicted.
 */
import * as THREE from 'three';
import type {
  Damageable,
  DamageElement,
  DamageInfo,
  HitRegion,
} from '@/types';
import type { CollisionWorld } from '@/types';
import { events } from '@/core/EventBus';
import { clamp, clamp01, rangeFalloff, scratch } from '@/util/math';

/**
 * Matched-element damage against a shield. Destiny's rule, and it is a good
 * one: it turns "which gun do I bring" into a real decision.
 *
 * Note that `EnemyAgent.applyDamage` applies this table itself, so the resolver
 * only uses it for targets that declare a `shieldElement` in the request —
 * i.e. damageables that are not enemy agents.
 */
export const SHIELD_MATCHUP = {
  matched: 2.6,
  kinetic: 0.75,
  mismatched: 1,
} as const;

export function shieldMultiplier(
  shieldElement: DamageElement | null | undefined,
  incoming: DamageElement,
): number {
  if (!shieldElement) return 1;
  if (shieldElement === incoming) return SHIELD_MATCHUP.matched;
  if (incoming === 'kinetic') return SHIELD_MATCHUP.kinetic;
  return SHIELD_MATCHUP.mismatched;
}

/**
 * Power-level delta scaling. Being under-levelled hurts fast and being
 * over-levelled helps slowly, so a world always stays a threat but grinding
 * never trivialises it.
 */
export function powerScale(attackerPower: number, targetPower: number): number {
  const d = attackerPower - targetPower;
  if (d >= 0) return clamp(1 + d * 0.004, 1, 1.25);
  return clamp(1 + d * 0.018, 0.15, 1);
}

/** Region multipliers applied on top of whatever the HitProxy carries. */
export const REGION_BASE: Record<HitRegion, number> = {
  body: 1,
  head: 1,
  limb: 0.75,
  critSpot: 1.15,
  shield: 1,
};

export interface DamageRequest {
  target: Damageable;
  amount: number;
  element: DamageElement;
  /** Entity id of the attacker; 0 = player. */
  sourceId: number;
  point: THREE.Vector3;
  normal?: THREE.Vector3;
  direction?: THREE.Vector3;
  region?: HitRegion;
  /** Multiplier carried by the struck `HitProxy`. */
  regionMultiplier?: number;
  precision?: boolean;
  impulse?: number;
  splash?: boolean;
  /** Weapon falloff. Omit `distance` to skip. */
  distance?: number;
  falloffStart?: number;
  falloffEnd?: number;
  falloffFloor?: number;
  attackerPower?: number;
  targetPower?: number;
  /** Only for damageables that do not apply the element matchup themselves. */
  shieldElement?: DamageElement | null;
  /** Extra multiplier — weaken, empower, super damage bonus. */
  multiplier?: number;
  /**
   * Emit `enemy:damaged`. Off by default: `EnemyManager` already emits it for
   * its own agents, and a second emission would double every damage number on
   * screen. Turn it on for damageables outside the enemy manager.
   */
  emit?: boolean;
  /** Emit a `hitmarker`. Weapons do their own; abilities want this. */
  hitmarker?: boolean;
}

export interface TargetQuery {
  /**
   * Fill `out` with every damageable whose origin is within `radius` of
   * `center`, and return how many were written. Must not allocate.
   */
  (out: Damageable[], center: THREE.Vector3, radius: number): number;
}

export interface SplashRequest {
  center: THREE.Vector3;
  radius: number;
  damage: number;
  element: DamageElement;
  sourceId: number;
  /** Damage at the very edge, as a fraction of `damage`. */
  edgeFraction?: number;
  /** Fraction of full damage the attacker takes from their own blast. */
  selfFraction?: number;
  attackerPower?: number;
  targetPower?: number;
  impulse?: number;
  multiplier?: number;
  /** Emit the `explosion` event (VFX + camera shake subscribe to it). */
  emitEvent?: boolean;
}

/** Result of a splash, so callers can react to "did that kill anything". */
export interface SplashResult {
  hits: number;
  totalDamage: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _targets: Damageable[] = [];

/** Reused so the hot damage path never allocates a DamageInfo. */
const _info: DamageInfo = {
  amount: 0,
  element: 'kinetic',
  region: 'body',
  precision: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  direction: new THREE.Vector3(0, 0, -1),
  sourceId: 0,
};

export class DamageResolver {
  /** Static world, for the splash line-of-sight test. Null = no LOS check. */
  collision: CollisionWorld | null = null;
  /** Supplies candidate targets for splash. Set by whoever owns the enemies. */
  targets: TargetQuery | null = null;
  /** Live damage-taken multipliers from status effects, keyed by entity id. */
  vulnerability: ((entityId: number) => number) | null = null;
  /** The player's current power level, used when a request omits it. */
  playerPower = 100;
  /** The active world's power level. */
  worldPower = 100;

  /** Totals, for the end-of-activity screen and for debugging. */
  readonly stats = { hits: 0, damageDealt: 0, precisionHits: 0, kills: 0 };

  private static isPlayerSource(sourceId: number): boolean {
    return sourceId === 0;
  }

  /**
   * Friendly fire is off: the player can hurt enemies and themselves, and
   * enemies can hurt the player, but nothing hurts its own side.
   */
  canDamage(sourceId: number, target: Damageable): boolean {
    const playerSource = DamageResolver.isPlayerSource(sourceId);
    const playerTarget = target.entityId === 0;
    if (playerSource) return true; // self-damage stays on
    return playerTarget;
  }

  resolve(req: DamageRequest): number {
    const target = req.target;
    if (!target || target.isDead || req.amount <= 0) return 0;
    if (!this.canDamage(req.sourceId, target)) return 0;

    let amount = req.amount;

    // -- region ------------------------------------------------------------
    const region = req.region ?? 'body';
    amount *= REGION_BASE[region] ?? 1;
    if (req.regionMultiplier && req.regionMultiplier > 0) amount *= req.regionMultiplier;

    // -- range falloff -----------------------------------------------------
    if (req.distance != null && req.falloffStart != null && req.falloffEnd != null) {
      amount *= rangeFalloff(
        req.distance,
        req.falloffStart,
        req.falloffEnd,
        req.falloffFloor ?? 0.5,
      );
    }

    // -- power delta -------------------------------------------------------
    const ap = req.attackerPower ?? (DamageResolver.isPlayerSource(req.sourceId) ? this.playerPower : this.worldPower);
    const tp = req.targetPower ?? (target.entityId === 0 ? this.playerPower : this.worldPower);
    amount *= powerScale(ap, tp);

    // -- status vulnerability + explicit multiplier ------------------------
    if (this.vulnerability) amount *= Math.max(0, this.vulnerability(target.entityId));
    if (req.multiplier != null) amount *= Math.max(0, req.multiplier);

    // -- element vs shield (only when the target does not do it itself) ----
    if (req.shieldElement !== undefined && target.shield > 0) {
      amount *= shieldMultiplier(req.shieldElement, req.element);
    }

    if (!(amount > 0)) return 0;

    _info.amount = amount;
    _info.element = req.element;
    _info.region = region;
    _info.precision = req.precision ?? (region === 'head' || region === 'critSpot');
    _info.point.copy(req.point);
    if (req.normal) _info.normal.copy(req.normal);
    else _info.normal.set(0, 1, 0);
    if (req.direction) _info.direction.copy(req.direction);
    else _info.direction.subVectors(req.point, target.getWorldPosition(_v)).normalize().negate();
    _info.sourceId = req.sourceId;
    _info.splash = req.splash;
    _info.impulse = req.impulse;

    const wasAlive = !target.isDead;
    const dealt = target.applyDamage(_info);

    if (dealt > 0) {
      this.stats.hits++;
      this.stats.damageDealt += dealt;
      if (_info.precision) this.stats.precisionHits++;
      if (wasAlive && target.isDead) this.stats.kills++;

      if (req.emit) {
        events.emit('enemy:damaged', {
          ..._info,
          remaining: target.health,
          entityId: target.entityId,
        });
      }
      if (req.hitmarker && DamageResolver.isPlayerSource(req.sourceId) && target.entityId !== 0) {
        events.emit('hitmarker', {
          precision: _info.precision,
          kill: target.isDead,
          damage: Math.round(dealt),
        });
      }
    }
    return dealt;
  }

  /**
   * Radial damage with a line-of-sight test.
   *
   * The LOS test is the difference between a grenade that feels fair and one
   * that does not: without it, a blast around a corner kills you through a
   * wall. Targets that fail LOS from the blast centre still take a reduced hit
   * (the pressure wave bends), which stops "hide behind a pebble" from being a
   * perfect counter.
   */
  splash(req: SplashRequest): SplashResult {
    const result: SplashResult = { hits: 0, totalDamage: 0 };
    if (req.emitEvent !== false) {
      events.emit('explosion', {
        point: req.center.clone(),
        radius: req.radius,
        element: req.element,
      });
    }
    if (!this.targets || req.radius <= 0 || req.damage <= 0) return result;

    const count = this.targets(_targets, req.center, req.radius);
    const edge = req.edgeFraction ?? 0.25;

    for (let i = 0; i < count; i++) {
      const t = _targets[i];
      if (!t || t.isDead) continue;
      if (!this.canDamage(req.sourceId, t)) continue;

      t.getWorldPosition(_v);
      // Measure to the target's centre of mass, not its feet: a blast at head
      // height above a crouching enemy should still land.
      const dist = _v.distanceTo(req.center);
      if (dist > req.radius) continue;

      // Smooth, not linear: a blast is much stronger near the middle.
      const t01 = clamp01(dist / req.radius);
      let falloff = 1 - t01 * t01;
      falloff = edge + (1 - edge) * falloff;

      let occluded = false;
      if (this.collision) {
        _v2.copy(_v);
        _v2.y += 0.6;
        occluded = !this.collision.lineOfSight(req.center, _v2);
        if (occluded) falloff *= 0.35;
      }

      const self = t.entityId === req.sourceId;
      const scale = self ? (req.selfFraction ?? 0.55) : 1;
      _dir.subVectors(_v, req.center);
      if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
      else _dir.normalize();

      const dealt = this.resolve({
        target: t,
        amount: req.damage * falloff * scale,
        element: req.element,
        sourceId: req.sourceId,
        point: scratch.v3a.copy(req.center).addScaledVector(_dir, Math.min(dist, req.radius * 0.5)),
        normal: _dir,
        direction: _dir,
        region: 'body',
        splash: true,
        impulse: (req.impulse ?? 220) * falloff,
        attackerPower: req.attackerPower,
        targetPower: req.targetPower,
        multiplier: req.multiplier,
        hitmarker: !self,
      });
      if (dealt > 0) {
        result.hits++;
        result.totalDamage += dealt;
      }
    }
    return result;
  }

  /** Direct self-damage, used by supers and by rockets fired at your own feet. */
  selfDamage(player: Damageable, amount: number, element: DamageElement, point: THREE.Vector3): number {
    return this.resolve({
      target: player,
      amount,
      element,
      sourceId: 0,
      point,
      region: 'body',
      splash: true,
    });
  }

  resetStats(): void {
    this.stats.hits = 0;
    this.stats.damageDealt = 0;
    this.stats.precisionHits = 0;
    this.stats.kills = 0;
  }
}

/** The one resolver everything shares. */
export const damage = new DamageResolver();
