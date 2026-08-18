/**
 * Status effects.
 *
 * Eight effects, one pool, one tick. Everything that damages over time routes
 * through `DamageResolver` rather than touching `applyDamage` directly, so a
 * burn tick obeys exactly the same power-delta and vulnerability rules as a
 * bullet, and shows up in the same damage numbers.
 *
 * Two of the effects are *thresholded* rather than continuous, which is what
 * makes them interesting to build around:
 *
 *  - **Burn** stacks. Each application adds a stack and refreshes the timer;
 *    at the ignition threshold the stacks are consumed for a large radial
 *    detonation. Setting three enemies alight and igniting one to chain the
 *    rest is the Solar subclass's entire fantasy.
 *  - **Slow** stacks into **freeze**. A frozen target cannot act at all, and a
 *    hit on a frozen target *shatters* it: the freeze is spent for a burst of
 *    splash damage. Freezing is therefore never just a stun — it is a setup.
 *
 * Enemy agents are steered through duck-typed access to their `ai` blackboard
 * (`desiredVelocity`, `attackCooldown`, `hasLineOfSight`, `alert`). That keeps
 * this file from having to own, or import, the enemy implementation.
 */
import * as THREE from 'three';
import type { Damageable, DamageElement, FrameContext } from '@/types';
import type { EngineSystem } from '@/core/Engine';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { events } from '@/core/EventBus';
import { clamp, clamp01 } from '@/util/math';
import { DamageResolver } from './Damage';

export type StatusKind =
  | 'burn'
  | 'shock'
  | 'suppress'
  | 'weaken'
  | 'slow'
  | 'freeze'
  | 'blind'
  | 'dot';

export interface StatusTuning {
  /** Burn stacks needed to ignite. */
  ignitionStacks: number;
  /** Damage of the ignition detonation, before falloff. */
  ignitionDamage: number;
  ignitionRadius: number;
  /** Slow stacks needed to freeze. */
  freezeStacks: number;
  freezeDuration: number;
  /** Shatter payload when a frozen target is struck. */
  shatterDamage: number;
  shatterRadius: number;
  /** Movement multiplier at one stack of slow, scaling toward the freeze. */
  slowFloor: number;
  /** Extra damage taken while weakened. */
  weakenMultiplier: number;
  /** Seconds between damage-over-time ticks. */
  tickInterval: number;
}

export const STATUS: StatusTuning = {
  ignitionStacks: 5,
  ignitionDamage: 105,
  ignitionRadius: 5.2,
  freezeStacks: 4,
  freezeDuration: 3.4,
  shatterDamage: 90,
  shatterRadius: 4.4,
  slowFloor: 0.42,
  weakenMultiplier: 1.3,
  tickInterval: 0.5,
};

interface Effect {
  kind: StatusKind;
  active: boolean;
  entityId: number;
  target: Damageable | null;
  sourceId: number;
  element: DamageElement;
  /** Seconds remaining. */
  remaining: number;
  duration: number;
  stacks: number;
  /** Damage per second for burn/dot/shock. */
  dps: number;
  /** Generic strength, 0..1 — slow depth, blind severity. */
  potency: number;
  tickAccum: number;
  /** Wall-clock when it was applied, for the HUD's ordering. */
  appliedAt: number;
}

/** What we can steer on an enemy without owning its implementation. */
interface ControllableTarget {
  velocity?: THREE.Vector3;
  ai?: {
    desiredVelocity: THREE.Vector3;
    attackCooldown: number;
    hasLineOfSight: boolean;
    alert: number;
    windup: number;
  };
}

export interface TargetStatus {
  entityId: number;
  target: Damageable | null;
  burnStacks: number;
  slowStacks: number;
  frozen: boolean;
  suppressed: boolean;
  blinded: boolean;
  weakened: boolean;
  shocked: boolean;
  /** Aggregate movement multiplier. */
  speed: number;
  /** Aggregate damage-taken multiplier. */
  vulnerability: number;
  /** Position cached at the last tick, for ignition/shatter epicentres. */
  position: THREE.Vector3;
}

const MAX_EFFECTS = 320;
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();

export class StatusEffectSystem implements EngineSystem {
  readonly name = 'status';

  private effects: Effect[] = [];
  private freeList: number[] = [];
  private states = new Map<number, TargetStatus>();
  private statePool: TargetStatus[] = [];
  private damage: DamageResolver;
  private vfx: VfxSystem | null;
  private unsubs: Array<() => void> = [];
  private elapsed = 0;

  constructor(resolver: DamageResolver, vfx: VfxSystem | null = null) {
    this.damage = resolver;
    this.vfx = vfx;
    for (let i = 0; i < MAX_EFFECTS; i++) {
      this.effects.push({
        kind: 'dot',
        active: false,
        entityId: -1,
        target: null,
        sourceId: 0,
        element: 'kinetic',
        remaining: 0,
        duration: 0,
        stacks: 0,
        dps: 0,
        potency: 0,
        tickAccum: 0,
        appliedAt: 0,
      });
      this.freeList.push(i);
    }
    // The resolver asks us how vulnerable a target is on every single hit.
    resolver.vulnerability = (id) => this.states.get(id)?.vulnerability ?? 1;

    this.unsubs.push(
      events.on('enemy:killed', (p) => this.clearEntity(p.entityId)),
    );
  }

  // -------------------------------------------------------------------------
  // Application
  // -------------------------------------------------------------------------

  /**
   * Apply (or refresh) an effect. Repeated applications of a stacking effect
   * add a stack; non-stacking effects take the stronger of the two.
   */
  apply(
    target: Damageable,
    kind: StatusKind,
    opts: {
      duration?: number;
      dps?: number;
      stacks?: number;
      potency?: number;
      sourceId?: number;
      element?: DamageElement;
    } = {},
  ): void {
    if (!target || target.isDead) return;
    const id = target.entityId;
    const duration = opts.duration ?? defaultDuration(kind);
    const stacks = opts.stacks ?? 1;

    const existing = this.find(id, kind);
    if (existing) {
      existing.remaining = Math.max(existing.remaining, duration);
      existing.duration = Math.max(existing.duration, duration);
      existing.dps = Math.max(existing.dps, opts.dps ?? existing.dps);
      existing.potency = Math.max(existing.potency, opts.potency ?? existing.potency);
      existing.target = target;
      if (stacksOf(kind)) existing.stacks = Math.min(existing.stacks + stacks, maxStacks(kind));
      this.refresh(id, target);
      this.checkThresholds(existing);
      return;
    }

    const idx = this.freeList.pop();
    if (idx == null) return; // pool exhausted: dropping the weakest new effect
    const e = this.effects[idx];
    e.kind = kind;
    e.active = true;
    e.entityId = id;
    e.target = target;
    e.sourceId = opts.sourceId ?? 0;
    e.element = opts.element ?? defaultElement(kind);
    e.remaining = duration;
    e.duration = duration;
    e.stacks = stacksOf(kind) ? Math.min(stacks, maxStacks(kind)) : 1;
    e.dps = opts.dps ?? defaultDps(kind);
    e.potency = opts.potency ?? 1;
    e.tickAccum = 0;
    e.appliedAt = this.elapsed;

    this.refresh(id, target);
    this.onApplied(e, target);
    this.checkThresholds(e);
  }

  private onApplied(e: Effect, target: Damageable): void {
    if (!this.vfx) return;
    target.getWorldPosition(_p);
    _p.y += 0.9;
    switch (e.kind) {
      case 'burn':
        this.vfx.elementalBurst(_p, 'solar', 0.5);
        break;
      case 'shock':
        this.vfx.elementalBurst(_p, 'arc', 0.5);
        break;
      case 'suppress':
      case 'weaken':
        this.vfx.elementalBurst(_p, 'void', 0.55);
        break;
      case 'slow':
      case 'freeze':
        this.vfx.elementalBurst(_p, 'stasis', 0.6);
        break;
      default:
        break;
    }
  }

  private find(entityId: number, kind: StatusKind): Effect | null {
    for (const e of this.effects) {
      if (e.active && e.entityId === entityId && e.kind === kind) return e;
    }
    return null;
  }

  private refresh(entityId: number, target: Damageable | null): TargetStatus {
    let s = this.states.get(entityId);
    if (!s) {
      s = this.statePool.pop() ?? {
        entityId,
        target: null,
        burnStacks: 0,
        slowStacks: 0,
        frozen: false,
        suppressed: false,
        blinded: false,
        weakened: false,
        shocked: false,
        speed: 1,
        vulnerability: 1,
        position: new THREE.Vector3(),
      };
      s.entityId = entityId;
      this.states.set(entityId, s);
    }
    if (target) s.target = target;
    return s;
  }

  // -------------------------------------------------------------------------
  // Thresholds: ignition and freeze
  // -------------------------------------------------------------------------

  private checkThresholds(e: Effect): void {
    if (e.kind === 'burn' && e.stacks >= STATUS.ignitionStacks) this.ignite(e);
    else if (e.kind === 'slow' && e.stacks >= STATUS.freezeStacks) this.freeze(e);
  }

  private ignite(e: Effect): void {
    const target = e.target;
    if (!target) return;
    target.getWorldPosition(_p);
    _p.y += 0.9;
    // Consume the stacks first, so a chain ignition cannot re-enter here.
    e.stacks = 0;
    e.remaining = Math.min(e.remaining, 0.4);

    this.vfx?.elementalBurst(_p, 'solar', 1.6);
    this.damage.splash({
      center: _p,
      radius: STATUS.ignitionRadius,
      damage: STATUS.ignitionDamage,
      element: 'solar',
      sourceId: e.sourceId,
      edgeFraction: 0.3,
      selfFraction: 0.35,
      impulse: 260,
    });
    // Ignition spreads: everything caught takes a stack of burn.
    this.spread(_p, STATUS.ignitionRadius * 0.85, 'burn', e.sourceId, target.entityId);
  }

  private freeze(e: Effect): void {
    const target = e.target;
    if (!target) return;
    e.stacks = 0;
    e.remaining = 0;
    this.apply(target, 'freeze', {
      duration: STATUS.freezeDuration,
      sourceId: e.sourceId,
      element: 'stasis',
      potency: 1,
    });
    target.getWorldPosition(_p);
    _p.y += 0.9;
    this.vfx?.elementalBurst(_p, 'stasis', 1.2);
  }

  /**
   * Shatter a frozen target. Called by whoever lands the hit — the whole point
   * of freezing is that the follow-up is worth more than the stun.
   */
  shatter(target: Damageable, sourceId = 0): boolean {
    const s = this.states.get(target.entityId);
    if (!s || !s.frozen) return false;
    this.clearKind(target.entityId, 'freeze');
    this.clearKind(target.entityId, 'slow');
    target.getWorldPosition(_p);
    _p.y += 0.9;
    this.vfx?.elementalBurst(_p, 'stasis', 1.5);
    this.damage.splash({
      center: _p,
      radius: STATUS.shatterRadius,
      damage: STATUS.shatterDamage,
      element: 'stasis',
      sourceId,
      edgeFraction: 0.25,
      selfFraction: 0,
      impulse: 300,
    });
    return true;
  }

  private spread(
    center: THREE.Vector3,
    radius: number,
    kind: StatusKind,
    sourceId: number,
    skipEntityId: number,
  ): void {
    for (const s of this.states.values()) {
      if (s.entityId === skipEntityId || !s.target || s.target.isDead) continue;
      if (s.target.getWorldPosition(_p2).distanceTo(center) > radius) continue;
      this.apply(s.target, kind, { sourceId });
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    const dt = ctx.dt;
    this.elapsed = ctx.elapsed;

    // Reset aggregates; they are rebuilt from the live effects every step.
    for (const s of this.states.values()) {
      s.burnStacks = 0;
      s.slowStacks = 0;
      s.frozen = false;
      s.suppressed = false;
      s.blinded = false;
      s.weakened = false;
      s.shocked = false;
      s.speed = 1;
      s.vulnerability = 1;
    }

    for (let i = 0; i < this.effects.length; i++) {
      const e = this.effects[i];
      if (!e.active) continue;
      const target = e.target;
      if (!target || target.isDead) {
        this.releaseAt(i);
        continue;
      }

      e.remaining -= dt;
      if (e.remaining <= 0) {
        this.releaseAt(i);
        continue;
      }

      const s = this.refresh(e.entityId, target);
      target.getWorldPosition(s.position);

      // -- damage over time -------------------------------------------------
      if (e.dps > 0) {
        e.tickAccum += dt;
        while (e.tickAccum >= STATUS.tickInterval) {
          e.tickAccum -= STATUS.tickInterval;
          const stackScale = e.kind === 'burn' ? 1 + (e.stacks - 1) * 0.45 : 1;
          this.damage.resolve({
            target,
            amount: e.dps * STATUS.tickInterval * stackScale,
            element: e.element,
            sourceId: e.sourceId,
            point: s.position,
            region: 'body',
            splash: true,
          });
          if (target.isDead) break;
        }
        if (target.isDead) {
          this.releaseAt(i);
          continue;
        }
      }

      // -- aggregate --------------------------------------------------------
      switch (e.kind) {
        case 'burn':
          s.burnStacks = Math.max(s.burnStacks, e.stacks);
          break;
        case 'shock':
          s.shocked = true;
          s.speed *= 0.82;
          break;
        case 'suppress':
          s.suppressed = true;
          s.speed *= 0.55;
          break;
        case 'weaken':
          s.weakened = true;
          s.vulnerability *= STATUS.weakenMultiplier;
          break;
        case 'slow': {
          s.slowStacks = Math.max(s.slowStacks, e.stacks);
          const depth = clamp01(e.stacks / STATUS.freezeStacks) * e.potency;
          s.speed *= 1 - (1 - STATUS.slowFloor) * depth;
          break;
        }
        case 'freeze':
          s.frozen = true;
          s.speed = 0;
          // A frozen target is a bigger target.
          s.vulnerability *= 1.15;
          break;
        case 'blind':
          s.blinded = true;
          break;
        default:
          break;
      }
    }

    // Push the aggregate back onto whatever we can steer.
    for (const s of this.states.values()) this.drive(s, dt);

    // Retire entries for entities that no longer carry anything.
    for (const [id, s] of this.states) {
      if (
        s.burnStacks === 0 &&
        s.slowStacks === 0 &&
        !s.frozen &&
        !s.suppressed &&
        !s.blinded &&
        !s.weakened &&
        !s.shocked
      ) {
        this.states.delete(id);
        s.target = null;
        if (this.statePool.length < 64) this.statePool.push(s);
      }
    }
  }

  private drive(s: TargetStatus, dt: number): void {
    const t = s.target as (Damageable & ControllableTarget) | null;
    if (!t) return;
    const ai = t.ai;
    if (s.speed < 0.999) {
      if (ai) ai.desiredVelocity.multiplyScalar(s.speed);
      if (t.velocity && s.frozen) {
        t.velocity.x = 0;
        t.velocity.z = 0;
      }
    }
    if (ai) {
      if (s.frozen || s.suppressed) {
        // Cannot shoot, cannot wind up an attack.
        ai.attackCooldown = Math.max(ai.attackCooldown, s.frozen ? 0.5 : 0.25);
        ai.windup = 0;
      }
      if (s.blinded) {
        ai.hasLineOfSight = false;
        ai.alert = Math.min(ai.alert, 0.55);
      }
    }
    void dt;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  status(entityId: number): TargetStatus | undefined {
    return this.states.get(entityId);
  }

  speedMultiplier(entityId: number): number {
    return this.states.get(entityId)?.speed ?? 1;
  }

  vulnerability(entityId: number): number {
    return this.states.get(entityId)?.vulnerability ?? 1;
  }

  isFrozen(entityId: number): boolean {
    return this.states.get(entityId)?.frozen ?? false;
  }

  isSuppressed(entityId: number): boolean {
    return this.states.get(entityId)?.suppressed ?? false;
  }

  burnStacks(entityId: number): number {
    return this.states.get(entityId)?.burnStacks ?? 0;
  }

  get activeCount(): number {
    return MAX_EFFECTS - this.freeList.length;
  }

  /** Number of entities currently carrying at least one effect. */
  get affectedCount(): number {
    return this.states.size;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  private releaseAt(index: number): void {
    const e = this.effects[index];
    if (!e.active) return;
    e.active = false;
    e.target = null;
    e.stacks = 0;
    e.remaining = 0;
    this.freeList.push(index);
  }

  clearKind(entityId: number, kind: StatusKind): void {
    for (let i = 0; i < this.effects.length; i++) {
      const e = this.effects[i];
      if (e.active && e.entityId === entityId && e.kind === kind) this.releaseAt(i);
    }
    const s = this.states.get(entityId);
    if (s && kind === 'freeze') s.frozen = false;
  }

  clearEntity(entityId: number): void {
    for (let i = 0; i < this.effects.length; i++) {
      const e = this.effects[i];
      if (e.active && e.entityId === entityId) this.releaseAt(i);
    }
    const s = this.states.get(entityId);
    if (s) {
      this.states.delete(entityId);
      s.target = null;
      if (this.statePool.length < 64) this.statePool.push(s);
    }
  }

  clear(): void {
    for (let i = 0; i < this.effects.length; i++) this.releaseAt(i);
    for (const s of this.states.values()) s.target = null;
    this.states.clear();
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.clear();
    this.vfx = null;
  }
}

// ---------------------------------------------------------------------------
// Per-kind defaults
// ---------------------------------------------------------------------------

function defaultDuration(kind: StatusKind): number {
  switch (kind) {
    case 'burn':
      return 4.5;
    case 'shock':
      return 2.4;
    case 'suppress':
      return 3;
    case 'weaken':
      return 6;
    case 'slow':
      return 5;
    case 'freeze':
      return STATUS.freezeDuration;
    case 'blind':
      return 3.2;
    default:
      return 4;
  }
}

function defaultDps(kind: StatusKind): number {
  switch (kind) {
    case 'burn':
      return 11;
    case 'shock':
      return 8;
    case 'dot':
      return 7;
    default:
      return 0;
  }
}

function defaultElement(kind: StatusKind): DamageElement {
  switch (kind) {
    case 'burn':
      return 'solar';
    case 'shock':
      return 'arc';
    case 'suppress':
    case 'weaken':
      return 'void';
    case 'slow':
    case 'freeze':
      return 'stasis';
    default:
      return 'kinetic';
  }
}

function stacksOf(kind: StatusKind): boolean {
  return kind === 'burn' || kind === 'slow';
}

function maxStacks(kind: StatusKind): number {
  if (kind === 'burn') return STATUS.ignitionStacks;
  if (kind === 'slow') return STATUS.freezeStacks;
  return 1;
}

/** Clamp helper re-exported so tuning code does not import maths twice. */
export const clampStacks = (v: number, kind: StatusKind): number =>
  clamp(v, 0, maxStacks(kind));
