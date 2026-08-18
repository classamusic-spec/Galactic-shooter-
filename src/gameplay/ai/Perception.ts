/**
 * Perception — what an enemy knows, when it knows it, and how wrong it is.
 *
 * The single biggest tell that an AI is cheap is omniscience: the moment you
 * break line of sight, a cheap AI keeps tracking you through the wall. This
 * module exists to stop that. Every agent carries:
 *
 *  - an **awareness accumulator** that fills while you are visible and drains
 *    while you are not, with hysteresis so the state does not flicker;
 *  - a **last-known position** with a confidence that decays, extrapolated
 *    along your last observed velocity, plus a growing search radius, so a
 *    hunting enemy looks like it is guessing (because it is);
 *  - **hearing**, driven off gunfire and explosions, which raises suspicion and
 *    seeds a search point without ever granting a precise fix.
 *
 * Line-of-sight rays are the expensive part, so they are **round-robin
 * budgeted**: a fixed number of agents are tested per simulation step. At 120 Hz
 * with a budget of six, thirty enemies each get re-tested 24 times a second —
 * far faster than a human can exploit, at a fifth of the ray cost.
 */
import * as THREE from 'three';
import type { CollisionWorld } from '@/types';
import { clamp, clamp01, Rng, scratch } from '@/util/math';
import type { AiAgent } from './AiDirector';

export type AwarenessState = 'unaware' | 'suspicious' | 'searching' | 'engaged';

/** Tuning for the whole perception model. One place, no magic numbers inline. */
export const PERCEPTION = {
  /** Half-angle of the sight cone while calm, radians (~62°). */
  fovCalm: 1.08,
  /** Half-angle while alert — heads turn, peripheral vision engages. */
  fovAlert: 1.48,
  /** Everything inside this radius is noticed regardless of facing. */
  proximityRadius: 5.5,
  /** Awareness gained per second at point-blank range with clear sight. */
  gainNear: 2.6,
  /** Awareness gained per second at the very edge of sight range. */
  gainFar: 0.5,
  /** Awareness lost per second with no contact at all. */
  decay: 0.34,
  /** Awareness lost per second while actively searching (slower — they commit). */
  decaySearching: 0.13,
  /** Rise above this and the agent commits to a fight. */
  engageEnter: 0.85,
  /** Only below this does an engaged agent give up the fight. */
  engageExit: 0.42,
  /** Rise above this and the agent starts investigating. */
  suspectEnter: 0.3,
  suspectExit: 0.1,
  /** Seconds an engaged agent keeps shooting at your last position. */
  losGrace: 1.35,
  /** Confidence half-life of a last-known position, seconds. */
  memoryHalfLife: 5.5,
  /** How far the search guess spreads per second of stale memory, metres. */
  searchSpreadRate: 2.4,
  /** Cap on that spread. */
  searchSpreadMax: 11,
  /** Radius within which an engaged agent shouts a contact to its squad. */
  commsRadius: 26,
  /** Delay before a shouted contact lands — nobody reacts instantly. */
  commsDelay: 0.38,
  /** Awareness a relayed contact grants. Enough to search, not enough to snap-shoot. */
  commsAwareness: 0.62,
  /** Multiplier on gain while the player is sprinting (loud, silhouetted). */
  sprintExposure: 1.35,
  /** Multiplier while the player is crouched and still. */
  crouchExposure: 0.55,
  /** Extra gain while the player is firing. */
  firingExposure: 1.6,
  /** Give up searching after this long and go back to patrol. */
  searchTimeout: 14,
} as const;

/** Everything one agent believes about the player. Pooled, never reallocated. */
export interface PerceptionState {
  entityId: number;
  state: AwarenessState;
  /** 0..1 detection meter. */
  awareness: number;
  /** True on the last completed line-of-sight test. */
  hasLos: boolean;
  /** Seconds since line of sight was last confirmed. Large when never seen. */
  losAge: number;
  /** Distance to the player at the last test. */
  distance: number;
  /** Best guess at where the player is. */
  readonly lastKnown: THREE.Vector3;
  /** Player velocity observed at the moment of the last sighting. */
  readonly lastKnownVel: THREE.Vector3;
  /** Seconds since `lastKnown` was refreshed. */
  lastKnownAge: number;
  /** 0..1, decays with `lastKnownAge`. Drives accuracy and search behaviour. */
  confidence: number;
  /** Where the agent should physically go to look. */
  readonly searchPoint: THREE.Vector3;
  searchValid: boolean;
  /** Seconds spent in the current awareness state. */
  timeInState: number;
  /** Seconds spent searching without a re-acquire. */
  searchTime: number;
  /** Set for one step when the agent first acquires the target — bark hook. */
  justAcquired: boolean;
  /** Set for one step when the agent loses a target it had. */
  justLost: boolean;
  /** Countdown until a relayed contact from a squadmate takes effect. */
  relayTimer: number;
  readonly relayPoint: THREE.Vector3;
  /** Steps since this agent's last LOS test — the round-robin cursor. */
  sinceCheck: number;
  /** Effective sight range in metres, derived from the archetype. */
  sightRange: number;
  /** Per-agent deterministic noise source for search scatter. */
  rng: Rng;
}

const _eye = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();

/** World-space eye position of an agent, from its capsule + archetype. */
export function agentEye(agent: AiAgent, out: THREE.Vector3): THREE.Vector3 {
  const a = agent.archetype;
  const feet = agent.position.y - a.capsuleHalfHeight - a.capsuleRadius;
  return out.set(agent.position.x, feet + a.eyeHeight, agent.position.z);
}

/** World-space foot height of an agent. */
export function agentFeetY(agent: AiAgent): number {
  const a = agent.archetype;
  return agent.position.y - a.capsuleHalfHeight - a.capsuleRadius;
}

/** The signal the player is currently broadcasting, refreshed once per step. */
export interface TargetSignature {
  /** Eye position — what agents actually try to see. */
  readonly eye: THREE.Vector3;
  /** Capsule centre — what agents navigate toward. */
  readonly centre: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** Unit aim direction; spawn placement uses it to stay out of view. */
  readonly forward: THREE.Vector3;
  /** 0..1 multiplier on detection speed built from stance and noise. */
  exposure: number;
  dead: boolean;
}

export class Perception {
  private world: CollisionWorld | null = null;
  private states = new Map<number, PerceptionState>();
  private order: number[] = [];
  private cursor = 0;

  /** Rays spent per simulation step. Scaled by population in `update`. */
  losBudget = 6;
  /** Rolling count of LOS rays cast, for the perf harness. */
  raysCast = 0;

  bindWorld(world: CollisionWorld | null): void {
    this.world = world;
  }

  register(agent: AiAgent): PerceptionState {
    let s = this.states.get(agent.entityId);
    if (!s) {
      s = {
        entityId: agent.entityId,
        state: 'unaware',
        awareness: 0,
        hasLos: false,
        losAge: 999,
        distance: 999,
        lastKnown: new THREE.Vector3(),
        lastKnownVel: new THREE.Vector3(),
        lastKnownAge: 999,
        confidence: 0,
        searchPoint: new THREE.Vector3(),
        searchValid: false,
        timeInState: 0,
        searchTime: 0,
        justAcquired: false,
        justLost: false,
        relayTimer: 0,
        relayPoint: new THREE.Vector3(),
        sinceCheck: 0,
        sightRange: 55,
        rng: new Rng(0x51ed + agent.entityId * 2654435761),
      };
      this.states.set(agent.entityId, s);
      this.order.push(agent.entityId);
    } else {
      s.state = 'unaware';
      s.awareness = 0;
      s.hasLos = false;
      s.losAge = 999;
      s.lastKnownAge = 999;
      s.confidence = 0;
      s.searchValid = false;
      s.timeInState = 0;
      s.searchTime = 0;
      s.relayTimer = 0;
    }
    // Sight range follows the archetype's engagement envelope: a shotgunner
    // that wants to be at 8 m has no business spotting you at 90.
    s.sightRange = clamp(agent.archetype.preferredRange * 2.3 + 14, 26, 95);
    return s;
  }

  unregister(entityId: number): void {
    if (!this.states.delete(entityId)) return;
    const i = this.order.indexOf(entityId);
    if (i >= 0) this.order.splice(i, 1);
    if (this.cursor >= this.order.length) this.cursor = 0;
  }

  get(entityId: number): PerceptionState | undefined {
    return this.states.get(entityId);
  }

  clear(): void {
    this.states.clear();
    this.order.length = 0;
    this.cursor = 0;
  }

  /**
   * A noise at a world position. `loudness` is the radius in metres at which it
   * is still just audible. Gunfire ≈ 55 m, a grenade ≈ 70 m, a footstep ≈ 9 m.
   */
  hear(position: THREE.Vector3, loudness: number, agents: readonly AiAgent[]): void {
    const l2 = loudness * loudness;
    for (const agent of agents) {
      if (agent.isDead) continue;
      const s = this.states.get(agent.entityId);
      if (!s) continue;
      const d2 = agent.position.distanceToSquared(position);
      if (d2 > l2) continue;
      const t = 1 - Math.sqrt(d2) / loudness;
      // Sound never fully identifies a target — it caps below the engage line
      // so an enemy investigates the noise rather than instantly opening fire.
      const bump = 0.22 + t * 0.42;
      if (s.awareness < PERCEPTION.engageEnter - 0.05) {
        s.awareness = Math.min(PERCEPTION.engageEnter - 0.05, s.awareness + bump);
      }
      if (s.confidence < 0.55 || s.lastKnownAge > 1.5) {
        // Bearing is accurate, distance is not: scatter the guess along the ray.
        const dir = _to.subVectors(position, agent.position);
        const dist = dir.length() || 1;
        dir.multiplyScalar(1 / dist);
        const err = (s.rng.next() - 0.5) * Math.min(9, dist * 0.32);
        s.lastKnown.copy(position).addScaledVector(dir, err);
        s.lastKnownVel.set(0, 0, 0);
        s.lastKnownAge = 0;
        s.confidence = Math.max(s.confidence, 0.35);
        s.searchValid = false;
      }
    }
  }

  /** Relay a confirmed contact from one agent to its neighbours, with delay. */
  broadcast(from: PerceptionState, source: THREE.Vector3, agents: readonly AiAgent[]): void {
    const r2 = PERCEPTION.commsRadius * PERCEPTION.commsRadius;
    for (const agent of agents) {
      if (agent.isDead || agent.entityId === from.entityId) continue;
      const s = this.states.get(agent.entityId);
      if (!s || s.state === 'engaged') continue;
      if (agent.position.distanceToSquared(source) > r2) continue;
      if (s.relayTimer > 0) continue;
      s.relayTimer = PERCEPTION.commsDelay;
      s.relayPoint.copy(from.lastKnown);
    }
  }

  /**
   * Advance every agent's belief by one simulation step.
   * Only `losBudget` agents pay for a ray; the rest coast on their timers,
   * which is why this scales to a full arena of enemies.
   */
  update(dt: number, agents: readonly AiAgent[], target: TargetSignature): void {
    const world = this.world;
    if (!world) return;

    // Keep the round-robin list in sync with the live population.
    if (this.order.length !== this.states.size) {
      this.order.length = 0;
      for (const id of this.states.keys()) this.order.push(id);
      this.cursor = 0;
    }
    this.losBudget = clamp(Math.ceil(agents.length / 5), 3, 10);

    // -- decay + state machine for everyone ---------------------------------
    for (const agent of agents) {
      const s = this.states.get(agent.entityId);
      if (!s) continue;
      s.justAcquired = false;
      s.justLost = false;
      s.timeInState += dt;
      s.losAge += dt;
      s.lastKnownAge += dt;
      s.sinceCheck++;
      s.confidence = Math.exp(-s.lastKnownAge / PERCEPTION.memoryHalfLife);

      if (s.relayTimer > 0) {
        s.relayTimer -= dt;
        if (s.relayTimer <= 0) {
          s.awareness = Math.max(s.awareness, PERCEPTION.commsAwareness);
          s.lastKnown.copy(s.relayPoint);
          s.lastKnownVel.set(0, 0, 0);
          s.lastKnownAge = 0;
          s.searchValid = false;
        }
      }
    }

    // -- budgeted line-of-sight ---------------------------------------------
    const n = this.order.length;
    if (n > 0 && !target.dead) {
      const tests = Math.min(this.losBudget, n);
      for (let k = 0; k < tests; k++) {
        const id = this.order[this.cursor];
        this.cursor = (this.cursor + 1) % n;
        const s = this.states.get(id);
        if (!s) continue;
        const agent = findAgent(agents, id);
        if (!agent || agent.isDead) continue;
        this.testSight(s, agent, target, world);
      }
    }

    // -- integrate awareness -------------------------------------------------
    for (const agent of agents) {
      const s = this.states.get(agent.entityId);
      if (!s) continue;
      if (target.dead) {
        s.awareness = Math.max(0, s.awareness - PERCEPTION.decay * 2 * dt);
      } else if (s.hasLos && s.losAge < 0.001) {
        // Gain was applied at test time; nothing to do between tests.
      } else if (s.losAge > 0.35) {
        const rate = s.state === 'searching' ? PERCEPTION.decaySearching : PERCEPTION.decay;
        s.awareness = Math.max(0, s.awareness - rate * dt);
      }
      this.advanceState(s, dt);
      this.refreshSearchPoint(s, dt);
    }
  }

  private testSight(
    s: PerceptionState,
    agent: AiAgent,
    target: TargetSignature,
    world: CollisionWorld,
  ): void {
    const dtSince = s.sinceCheck / 120;
    s.sinceCheck = 0;
    agentEye(agent, _eye);
    _to.subVectors(target.eye, _eye);
    const dist = _to.length();
    s.distance = dist;
    if (dist > s.sightRange) {
      s.hasLos = false;
      return;
    }

    const alert = s.state === 'engaged' || s.state === 'searching';
    const cosLimit = Math.cos(alert ? PERCEPTION.fovAlert : PERCEPTION.fovCalm);
    _fwd.set(Math.sin(agent.ai.yaw), 0, Math.cos(agent.ai.yaw));
    _to.multiplyScalar(1 / Math.max(dist, 1e-4));
    const facing = _fwd.x * _to.x + _fwd.z * _to.z;
    const inCone = facing >= cosLimit || dist <= PERCEPTION.proximityRadius;
    if (!inCone) {
      s.hasLos = false;
      return;
    }

    // Two rays: eyes and centre mass. Catches a player peeking over cover with
    // only their head exposed, and costs one extra ray at most.
    this.raysCast++;
    let visible = world.lineOfSight(_eye, target.eye);
    if (!visible) {
      this.raysCast++;
      _tgt.copy(target.centre);
      visible = world.lineOfSight(_eye, _tgt);
    }

    if (!visible) {
      s.hasLos = false;
      return;
    }

    s.hasLos = true;
    s.losAge = 0;
    const t = clamp01(1 - dist / s.sightRange);
    const base = PERCEPTION.gainFar + (PERCEPTION.gainNear - PERCEPTION.gainFar) * (t * t);
    const cone = clamp01((facing - cosLimit) / Math.max(1e-3, 1 - cosLimit)) * 0.5 + 0.5;
    const before = s.awareness;
    s.awareness = clamp01(s.awareness + base * cone * target.exposure * dtSince);
    if (before < PERCEPTION.engageEnter && s.awareness >= PERCEPTION.engageEnter) {
      s.justAcquired = true;
    }
    s.lastKnown.copy(target.centre);
    s.lastKnownVel.copy(target.velocity);
    s.lastKnownAge = 0;
    s.confidence = 1;
    s.searchValid = false;
  }

  private advanceState(s: PerceptionState, dt: number): void {
    const prev = s.state;
    switch (s.state) {
      case 'unaware':
        if (s.awareness >= PERCEPTION.engageEnter) s.state = 'engaged';
        else if (s.awareness >= PERCEPTION.suspectEnter) s.state = 'suspicious';
        break;
      case 'suspicious':
        if (s.awareness >= PERCEPTION.engageEnter) s.state = 'engaged';
        else if (s.awareness < PERCEPTION.suspectExit) s.state = 'unaware';
        else if (s.timeInState > 2.5 && s.lastKnownAge < 8) s.state = 'searching';
        break;
      case 'searching':
        s.searchTime += dt;
        if (s.awareness >= PERCEPTION.engageEnter && s.losAge < 0.5) s.state = 'engaged';
        else if (s.awareness < PERCEPTION.suspectExit || s.searchTime > PERCEPTION.searchTimeout) {
          s.state = 'unaware';
        }
        break;
      case 'engaged':
        if (s.losAge > PERCEPTION.losGrace && s.awareness < PERCEPTION.engageExit) {
          s.state = 'searching';
          s.searchTime = 0;
          s.justLost = true;
        } else if (s.awareness < PERCEPTION.engageExit * 0.5) {
          s.state = 'searching';
          s.searchTime = 0;
          s.justLost = true;
        }
        break;
    }
    if (s.state !== prev) {
      s.timeInState = 0;
      if (s.state !== 'searching') s.searchTime = 0;
      if (s.state === 'searching') s.searchValid = false;
    }
  }

  /**
   * Where a hunting agent should physically walk. Extrapolate the last observed
   * velocity, then scatter by an error that grows with how stale the memory is:
   * fresh memory sends them to the right doorway, old memory sends them
   * plausibly wrong. That asymmetry is the whole illusion.
   */
  private refreshSearchPoint(s: PerceptionState, _dt: number): void {
    if (s.searchValid) return;
    if (s.lastKnownAge > 30) {
      s.searchPoint.copy(s.lastKnown);
      s.searchValid = true;
      return;
    }
    const lead = Math.min(s.lastKnownAge, 2.2);
    const spread = Math.min(
      PERCEPTION.searchSpreadMax,
      s.lastKnownAge * PERCEPTION.searchSpreadRate,
    );
    const ang = s.rng.next() * Math.PI * 2;
    const rad = Math.sqrt(s.rng.next()) * spread;
    s.searchPoint
      .copy(s.lastKnown)
      .addScaledVector(s.lastKnownVel, lead)
      .add(scratch.v3a.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad));
    s.searchValid = true;
  }

  /** Invalidate the current search guess so the next tick picks a new one. */
  repickSearch(s: PerceptionState): void {
    s.searchValid = false;
  }

  /** Aim error in radians for this agent, from confidence and distance. */
  aimError(s: PerceptionState, baseAccuracy: number): number {
    const staleness = 1 - s.confidence;
    const settle = clamp01((s.timeInState + s.losAge > 0 ? s.timeInState : 0) / 1.2);
    return baseAccuracy * (0.55 + staleness * 1.6) * (1.25 - settle * 0.35);
  }
}

/** Linear scan; agent counts are tens, and a Map lookup per test is worse. */
function findAgent(agents: readonly AiAgent[], id: number): AiAgent | null {
  for (let i = 0; i < agents.length; i++) if (agents[i].entityId === id) return agents[i];
  return null;
}
