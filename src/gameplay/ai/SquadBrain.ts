/**
 * SquadBrain — coordination, and the attack-token pool.
 *
 * Two jobs, both about *fairness legibility*:
 *
 * 1. **Roles.** Nearby enemies are clustered into squads and given
 *    complementary jobs — one or two suppress from cover, one swings left, one
 *    swings right, the rest advance. Without this, every enemy independently
 *    runs "walk at the player and shoot", and a fight becomes a funnel. With it,
 *    the player gets pressure from multiple bearings and has a reason to move.
 *
 * 2. **Attack tokens.** A small shared pool of permits to actually shoot. Six
 *    enemies may be in view; at most `maxAttackers` of them are shooting at any
 *    moment, and tokens rotate on a timer so it is never the same three. This is
 *    the oldest trick in the AAA book and it is the difference between "intense"
 *    and "unfair". Everyone without a token still moves, still repositions,
 *    still looks dangerous — they just do not add damage.
 *
 * Tokens are revoked, not merely released: a holder that has been shooting for
 * `maxHold` seconds loses its permit to a waiting agent, which keeps the visual
 * focus of the fight moving around the arena.
 */
import * as THREE from 'three';
import type { FactionId } from '@/types';
import { clamp, clamp01 } from '@/util/math';
import type { AiAgent, AiBrain } from './AiDirector';
import type { CoverMap } from './CoverMap';
import type { NavGrid } from './NavGrid';
import type { TargetSignature } from './Perception';

export type SquadOrderKind =
  | 'idle'
  | 'advance'
  | 'suppress'
  | 'flankLeft'
  | 'flankRight'
  | 'holdCover'
  | 'regroup'
  | 'retreat'
  | 'search'
  | 'guard';

/** A standing instruction. One stable instance per agent — never reallocated. */
export interface SquadOrder {
  kind: SquadOrderKind;
  /** Where the order points. Meaning depends on `kind`. */
  readonly position: THREE.Vector3;
  /** Owning squad, or -1 when the agent is alone. */
  squadId: number;
  /** Engagement distance this role wants to hold. */
  standoff: number;
  /** 0..1 — how hard to push. Drives run vs walk and cover dwell time. */
  urgency: number;
  /** Bumped whenever the order changes; behaviour trees can watch it. */
  serial: number;
  /** True on the step the order changed. */
  fresh: boolean;
  /** True while the holder may actually shoot. */
  hasAttackToken: boolean;
}

export function createSquadOrder(): SquadOrder {
  return {
    kind: 'idle',
    position: new THREE.Vector3(),
    squadId: -1,
    standoff: 12,
    urgency: 0.5,
    serial: 0,
    fresh: false,
    hasAttackToken: false,
  };
}

export interface Squad {
  id: number;
  faction: FactionId;
  members: number[];
  readonly centroid: THREE.Vector3;
  /** Members currently in the `engaged` perception state. */
  engaged: number;
  /** Peak member count, so we can tell when a squad is being wiped. */
  peakSize: number;
  /** Seconds until the next role re-plan. */
  planTimer: number;
  /** Seconds until this squad may call for help again. */
  reinforceTimer: number;
  /** 0..1 blended aggression of the members. */
  aggression: number;
  /** True when the squad contains an elite/champion/boss. */
  hasElite: boolean;
  /** Alternating flank side so successive squads pincer rather than stack. */
  flankParity: number;
}

export const SQUAD = {
  /** Agents within this distance of a squad centroid join it. */
  clusterRadius: 26,
  /** Seconds between squad membership rebuilds. */
  clusterInterval: 1.6,
  /** Seconds between role re-plans within a squad. */
  planInterval: 2.4,
  /** Minimum seconds a token holder keeps its permit. */
  minHold: 0.7,
  /** After this long a holder is preempted if anyone else is waiting. */
  maxHold: 3.4,
  /** Ranged attackers permitted at the lowest pressure. */
  minAttackers: 2,
  /** Ranged attackers permitted at maximum pressure. */
  maxAttackersCap: 5,
  /** Melee attackers permitted at once, regardless of pressure. */
  maxMelee: 2,
  /** A melee archetype is one whose preferred range is under this. */
  meleeRange: 4.5,
  /** Squad calls for help below this fraction of its peak size. */
  reinforceThreshold: 0.45,
  reinforceCooldown: 22,
} as const;

interface TokenHolder {
  entityId: number;
  held: number;
  melee: boolean;
}

const _v = new THREE.Vector3();
const _flank = new THREE.Vector3();

export class SquadBrain {
  readonly squads: Squad[] = [];
  private orders = new Map<number, SquadOrder>();
  private squadOf = new Map<number, number>();
  private nextSquadId = 1;
  private clusterTimer = 0;

  /**
   * Token pools are fixed-size and mutated in place: granting a permit must not
   * allocate, because it happens several times a second for the whole fight.
   */
  private ranged: TokenHolder[] = [];
  private rangedCount = 0;
  private melee: TokenHolder[] = [];
  private meleeCount = 0;
  /** Agents refused a token since the last update — drives preemption pressure. */
  private waiting = 0;

  /** Live cap on simultaneous ranged attackers; raised by the director. */
  maxAttackers: number = SQUAD.minAttackers;

  /** Callback the director installs so an elite can pull in another wave. */
  onReinforce: ((squad: Squad, at: THREE.Vector3) => boolean) | null = null;

  private nav: NavGrid | null = null;
  private cover: CoverMap | null = null;

  constructor() {
    for (let i = 0; i < SQUAD.maxAttackersCap; i++) {
      this.ranged.push({ entityId: -1, held: 0, melee: false });
    }
    for (let i = 0; i < SQUAD.maxMelee; i++) {
      this.melee.push({ entityId: -1, held: 0, melee: true });
    }
  }

  bind(nav: NavGrid | null, cover: CoverMap | null): void {
    this.nav = nav;
    this.cover = cover;
  }

  order(entityId: number): SquadOrder {
    let o = this.orders.get(entityId);
    if (!o) {
      o = createSquadOrder();
      this.orders.set(entityId, o);
    }
    return o;
  }

  forget(entityId: number): void {
    this.orders.delete(entityId);
    this.squadOf.delete(entityId);
    this.dropToken(entityId);
  }

  clear(): void {
    this.squads.length = 0;
    this.orders.clear();
    this.squadOf.clear();
    this.rangedCount = 0;
    this.meleeCount = 0;
    this.nextSquadId = 1;
    this.clusterTimer = 0;
  }

  // -- attack tokens ---------------------------------------------------------

  /** Entities whose token was taken away this step; the director clears flags. */
  readonly revoked: number[] = [];

  /**
   * Ask for permission to attack. Grants when the pool has room, or when a
   * holder has overstayed `maxHold` and can therefore be preempted — which is
   * what keeps the shooting rotating around the arena instead of sticking to
   * whichever three enemies happened to ask first.
   */
  requestToken(brain: AiBrain): boolean {
    const arch = brain.agent.archetype;
    const melee = arch.preferredRange <= SQUAD.meleeRange;
    const pool = melee ? this.melee : this.ranged;
    const count = melee ? this.meleeCount : this.rangedCount;
    const cap = Math.min(melee ? SQUAD.maxMelee : this.maxAttackers, pool.length);
    const id = brain.agent.entityId;

    for (let i = 0; i < count; i++) {
      if (pool[i].entityId === id) {
        brain.hasToken = true;
        return true;
      }
    }
    if (count < cap) {
      pool[count].entityId = id;
      pool[count].held = 0;
      if (melee) this.meleeCount = count + 1;
      else this.rangedCount = count + 1;
      brain.hasToken = true;
      brain.tokenTime = 0;
      return true;
    }
    // Preempt the longest-held permit, but only once it has had its turn.
    let oldest = -1;
    let oldestHeld: number = SQUAD.maxHold;
    for (let i = 0; i < count; i++) {
      if (pool[i].held > oldestHeld) {
        oldestHeld = pool[i].held;
        oldest = i;
      }
    }
    if (oldest >= 0) {
      this.revoked.push(pool[oldest].entityId);
      pool[oldest].entityId = id;
      pool[oldest].held = 0;
      brain.hasToken = true;
      brain.tokenTime = 0;
      return true;
    }
    this.waiting++;
    brain.hasToken = false;
    return false;
  }

  releaseToken(brain: AiBrain): void {
    brain.hasToken = false;
    this.dropToken(brain.agent.entityId);
  }

  private dropToken(entityId: number): void {
    for (let i = 0; i < this.rangedCount; i++) {
      if (this.ranged[i].entityId === entityId) {
        this.removeAt(this.ranged, i, false);
        return;
      }
    }
    for (let i = 0; i < this.meleeCount; i++) {
      if (this.melee[i].entityId === entityId) {
        this.removeAt(this.melee, i, true);
        return;
      }
    }
  }

  /** Swap-with-last removal so the pool never allocates or shifts. */
  private removeAt(pool: TokenHolder[], i: number, melee: boolean): void {
    const count = melee ? this.meleeCount : this.rangedCount;
    const last = count - 1;
    if (i !== last) {
      const t = pool[i];
      pool[i] = pool[last];
      pool[last] = t;
    }
    pool[last].entityId = -1;
    pool[last].held = 0;
    if (melee) this.meleeCount = last;
    else this.rangedCount = last;
  }

  /** Number of live attack permits, for the HUD/debug and the harness. */
  get tokensHeld(): number {
    return this.rangedCount + this.meleeCount;
  }

  get rangedTokens(): number {
    return this.rangedCount;
  }

  get meleeTokens(): number {
    return this.meleeCount;
  }

  /** `brains` doubles as the liveness oracle — rebuilding a Set of live ids
   *  every step would allocate, and this runs 120 times a second. */
  private tickTokens(dt: number, brains: Map<number, AiBrain>): void {
    this.waiting = 0;
    for (let i = this.rangedCount - 1; i >= 0; i--) {
      this.ranged[i].held += dt;
      if (!isAlive(brains, this.ranged[i].entityId)) this.removeAt(this.ranged, i, false);
    }
    for (let i = this.meleeCount - 1; i >= 0; i--) {
      this.melee[i].held += dt;
      if (!isAlive(brains, this.melee[i].entityId)) this.removeAt(this.melee, i, true);
    }
    // Trim if the cap shrank (pressure dropped): the oldest holders go first.
    while (this.rangedCount > this.maxAttackers) {
      let oldest = 0;
      for (let i = 1; i < this.rangedCount; i++) {
        if (this.ranged[i].held > this.ranged[oldest].held) oldest = i;
      }
      this.revoked.push(this.ranged[oldest].entityId);
      this.removeAt(this.ranged, oldest, false);
    }
  }

  // -- clustering + orders ---------------------------------------------------

  /**
   * Rebuild squads and re-plan roles. Called every step; the expensive parts
   * are on their own timers.
   */
  update(
    dt: number,
    agents: readonly AiAgent[],
    brains: Map<number, AiBrain>,
    target: TargetSignature,
    threat: number,
  ): void {
    this.revoked.length = 0;

    // Pressure sets how many enemies may shoot at once. Low threat = a duel,
    // high threat = a firefight, but never a firing squad.
    this.maxAttackers = Math.round(
      clamp(
        SQUAD.minAttackers + threat * (SQUAD.maxAttackersCap - SQUAD.minAttackers),
        SQUAD.minAttackers,
        SQUAD.maxAttackersCap,
      ),
    );
    this.tickTokens(dt, brains);

    this.clusterTimer -= dt;
    if (this.clusterTimer <= 0) {
      this.clusterTimer = SQUAD.clusterInterval;
      this.recluster(agents, brains);
    }

    for (let i = 0; i < this.squads.length; i++) {
      const sq = this.squads[i];
      sq.planTimer -= dt;
      sq.reinforceTimer -= dt;
      if (sq.planTimer <= 0) {
        sq.planTimer = SQUAD.planInterval * (0.8 + (i % 3) * 0.18);
        this.plan(sq, agents, brains, target, threat);
      }
    }

    // Publish token state onto the orders so behaviour trees and the HUD agree.
    // Iterating the agent list rather than the order map keeps this free of the
    // [key, value] pair allocation that `for…of` over a Map produces.
    for (let i = 0; i < agents.length; i++) {
      const brain = brains.get(agents[i].entityId);
      if (brain) brain.order.hasAttackToken = brain.hasToken;
    }
  }

  /**
   * Greedy proximity clustering. Squads are ephemeral by design: when the
   * player splits a group, the halves become separate squads and start planning
   * separate flanks, which is exactly the behaviour you want.
   */
  private recluster(agents: readonly AiAgent[], brains: Map<number, AiBrain>): void {
    const r2 = SQUAD.clusterRadius * SQUAD.clusterRadius;
    // Reuse squad objects to keep ids (and therefore order continuity) stable.
    for (let i = 0; i < this.squads.length; i++) this.squads[i].members.length = 0;

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.isDead) continue;
      let joined = -1;
      let bestD = r2;
      for (let s = 0; s < this.squads.length; s++) {
        const sq = this.squads[s];
        if (sq.faction !== a.archetype.faction) continue;
        if (sq.members.length === 0 && sq.peakSize > 0) {
          // Empty shell from the previous rebuild — still a valid anchor.
          const d = a.position.distanceToSquared(sq.centroid);
          if (d < bestD) {
            bestD = d;
            joined = s;
          }
          continue;
        }
        const d = a.position.distanceToSquared(sq.centroid);
        if (d < bestD) {
          bestD = d;
          joined = s;
        }
      }
      if (joined < 0) {
        this.squads.push({
          id: this.nextSquadId++,
          faction: a.archetype.faction,
          members: [a.entityId],
          centroid: a.position.clone(),
          engaged: 0,
          peakSize: 1,
          planTimer: 0,
          reinforceTimer: 0,
          aggression: a.archetype.aggression,
          hasElite: a.archetype.rank !== 'minor' && a.archetype.rank !== 'standard',
          flankParity: this.squads.length & 1,
        });
      } else {
        this.squads[joined].members.push(a.entityId);
      }
    }

    for (let s = this.squads.length - 1; s >= 0; s--) {
      const sq = this.squads[s];
      if (sq.members.length === 0) {
        this.squads.splice(s, 1);
        continue;
      }
      _v.set(0, 0, 0);
      let aggr = 0;
      let elite = false;
      let engaged = 0;
      for (let m = 0; m < sq.members.length; m++) {
        const brain = brains.get(sq.members[m]);
        if (!brain) continue;
        _v.add(brain.agent.position);
        aggr += brain.agent.archetype.aggression;
        const rank = brain.agent.archetype.rank;
        if (rank === 'elite' || rank === 'champion' || rank === 'boss') elite = true;
        if (brain.percept.state === 'engaged') engaged++;
        this.squadOf.set(sq.members[m], sq.id);
      }
      sq.centroid.copy(_v).multiplyScalar(1 / sq.members.length);
      sq.aggression = aggr / sq.members.length;
      sq.hasElite = elite;
      sq.engaged = engaged;
      sq.peakSize = Math.max(sq.peakSize, sq.members.length);
    }
  }

  /**
   * Hand out roles. The shape of a plan:
   *   - a fraction of the squad suppresses from cover (pins the player down),
   *   - one member swings each way (forces the player to move),
   *   - the remainder advances (applies the clock),
   * scaled by how cautious the species is and how the fight is going.
   */
  private plan(
    sq: Squad,
    agents: readonly AiAgent[],
    brains: Map<number, AiBrain>,
    target: TargetSignature,
    threat: number,
  ): void {
    const n = sq.members.length;
    if (n === 0) return;

    const losing = n < sq.peakSize * SQUAD.reinforceThreshold;
    if (losing && sq.hasElite && sq.reinforceTimer <= 0 && this.onReinforce) {
      if (this.onReinforce(sq, sq.centroid)) sq.reinforceTimer = SQUAD.reinforceCooldown;
    }

    // How many should be pinning rather than pushing.
    const cautionBias = clamp01(1 - sq.aggression);
    const suppressors = Math.max(
      n >= 3 ? 1 : 0,
      Math.round(n * (0.22 + cautionBias * 0.3)),
    );
    const flankers = n >= 3 ? (n >= 6 ? 2 : 1) : 0;

    // Sort so the healthiest/closest push and the hurt ones hold cover. Cheap
    // insertion sort over a handful of ids; no allocation.
    const ids = sq.members;
    for (let i = 1; i < ids.length; i++) {
      const key = ids[i];
      const kb = brains.get(key);
      const kd = kb ? kb.agent.position.distanceToSquared(target.centre) : Infinity;
      let j = i - 1;
      while (j >= 0) {
        const jb = brains.get(ids[j]);
        const jd = jb ? jb.agent.position.distanceToSquared(target.centre) : Infinity;
        if (jd <= kd) break;
        ids[j + 1] = ids[j];
        j--;
      }
      ids[j + 1] = key;
    }

    let assignedFlank = 0;
    let assignedSuppress = 0;
    for (let i = 0; i < ids.length; i++) {
      const brain = brains.get(ids[i]);
      if (!brain) continue;
      const arch = brain.agent.archetype;
      const o = this.order(ids[i]);
      const prevKind = o.kind;
      o.squadId = sq.id;

      const perceptState = brain.percept.state;
      let kind: SquadOrderKind;

      if (perceptState === 'unaware') {
        kind = 'guard';
      } else if (perceptState === 'suspicious' || perceptState === 'searching') {
        kind = 'search';
      } else if (brain.agent.health / Math.max(1, brain.agent.maxHealth) < 0.28 && arch.caution > 0.4) {
        kind = 'retreat';
      } else if (arch.preferredRange <= SQUAD.meleeRange) {
        // Melee species never hold cover; they close, but from an angle.
        kind = assignedFlank < flankers ? (sq.flankParity + assignedFlank) % 2 === 0
          ? 'flankLeft'
          : 'flankRight'
          : 'advance';
        if (kind === 'flankLeft' || kind === 'flankRight') assignedFlank++;
      } else if (assignedFlank < flankers && arch.aggression > 0.35) {
        kind = (sq.flankParity + assignedFlank) % 2 === 0 ? 'flankLeft' : 'flankRight';
        assignedFlank++;
      } else if (assignedSuppress < suppressors) {
        kind = arch.caution > 0.25 ? 'holdCover' : 'suppress';
        assignedSuppress++;
      } else {
        kind = 'advance';
      }

      if (losing && arch.caution > 0.55 && kind === 'advance') kind = 'regroup';

      o.standoff = arch.preferredRange;
      o.urgency = clamp01(0.3 + sq.aggression * 0.5 + threat * 0.3);
      this.positionFor(o, kind, brain, sq, target);
      if (kind !== prevKind) {
        o.kind = kind;
        o.serial++;
        o.fresh = true;
      } else {
        o.fresh = false;
      }
    }
    sq.flankParity ^= 1;
  }

  /** Turn an order kind into a world position the behaviour tree can walk to. */
  private positionFor(
    o: SquadOrder,
    kind: SquadOrderKind,
    brain: AiBrain,
    sq: Squad,
    target: TargetSignature,
  ): void {
    const pos = brain.agent.position;
    const arch = brain.agent.archetype;
    switch (kind) {
      case 'flankLeft':
      case 'flankRight': {
        const side = kind === 'flankLeft' ? -1 : 1;
        if (this.cover?.findFlank(target.centre, pos, side, arch.preferredRange, _flank)) {
          o.position.copy(_flank);
        } else {
          o.position.copy(target.centre);
        }
        break;
      }
      case 'holdCover':
      case 'suppress': {
        const p = this.cover?.find({
          entityId: brain.agent.entityId,
          from: pos,
          threat: target.eye,
          minRange: Math.max(3, arch.preferredRange * 0.4),
          maxRange: Math.max(9, arch.preferredRange * 1.8),
          maxTravel: 24,
          preferHigh: kind === 'holdCover',
        });
        o.position.copy(p ? p.position : pos);
        break;
      }
      case 'retreat': {
        _v.subVectors(pos, target.centre);
        _v.y = 0;
        const l = _v.length() || 1;
        _v.multiplyScalar(Math.max(14, arch.preferredRange * 1.4) / l);
        _v.add(pos);
        if (this.nav?.snap(_v, _flank, 8)) o.position.copy(_flank);
        else o.position.copy(pos);
        break;
      }
      case 'regroup':
        o.position.copy(sq.centroid);
        break;
      case 'search':
        o.position.copy(brain.percept.searchValid ? brain.percept.searchPoint : brain.percept.lastKnown);
        break;
      case 'guard':
        o.position.copy(brain.anchor);
        break;
      case 'advance':
      default: {
        // A point on the standoff ring, not the player's feet — a squad that
        // paths to the exact same point converges into a single-file queue.
        _v.subVectors(pos, target.centre);
        _v.y = 0;
        const l = _v.length() || 1;
        // Spread members around the ring by their index within the squad.
        const idx = sq.members.indexOf(brain.agent.entityId);
        const spread = ((idx % 5) - 2) * 0.42;
        const ang = Math.atan2(_v.x, _v.z) + spread;
        o.position.set(
          target.centre.x + Math.sin(ang) * arch.preferredRange,
          target.centre.y,
          target.centre.z + Math.cos(ang) * arch.preferredRange,
        );
        if (this.nav?.snap(o.position, _flank, 8)) o.position.copy(_flank);
        break;
      }
    }
  }

  squadFor(entityId: number): Squad | null {
    const id = this.squadOf.get(entityId);
    if (id === undefined) return null;
    for (let i = 0; i < this.squads.length; i++) if (this.squads[i].id === id) return this.squads[i];
    return null;
  }
}

function isAlive(brains: Map<number, AiBrain>, entityId: number): boolean {
  const b = brains.get(entityId);
  return b !== undefined && !b.agent.isDead;
}
