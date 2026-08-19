/**
 * AiDirector — the engine system that owns every enemy's mind and body.
 *
 * Division of labour with `EnemyManager` (the enemy owner's module):
 *
 *   EnemyManager owns  →  meshes, animation, health, hit proxies, death, pooling
 *   AiDirector owns    →  navigation, perception, decisions, locomotion
 *
 * The seam is `AiAgent.ai`, a plain block of numbers this system writes and the
 * enemy renderer reads: yaw, aim angles, locomotion blend, wind-up progress, and
 * the one-step `fire` / `leap` / `bark` pulses. Nothing calls back the other
 * way, so the enemy owner can rebuild their whole presentation layer without
 * touching a line of AI.
 *
 * Cost control, since this runs for up to 44 agents at 120 Hz:
 *   - nav grid + cover map build incrementally at load, never in one stall;
 *   - perception line-of-sight rays are round-robin budgeted;
 *   - behaviour trees tick at 30 Hz, staggered across agents, while steering
 *     runs every step so movement stays smooth;
 *   - A* is capped at a couple of searches per step and everything else follows
 *     a shared Dijkstra flow field toward the player;
 *   - after construction, the whole update path allocates nothing.
 */
import * as THREE from 'three';
import type { Engine, EngineSystem } from '@/core/Engine';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import type {
  CollisionWorld,
  EnemyArchetype,
  EnemyRank,
  FactionId,
  FrameContext,
  Level,
} from '@/types';
import { clamp, clamp01, damp, Rng } from '@/util/math';
import type { Player } from '@/gameplay/Player';
import { CoverMap, type CoverPoint } from './CoverMap';
import { NAV_WALKABLE, NavGrid, NavPath, type NavGridOptions } from './NavGrid';
import { agentEye, Perception, type PerceptionState, type TargetSignature } from './Perception';
import {
  createSteerCommand,
  createSteerState,
  resetSteerCommand,
  Steering,
  type SteerCommand,
  type SteerState,
} from './Steering';
import { SquadBrain, type Squad, type SquadOrder } from './SquadBrain';
import { EncounterDirector, type EncounterScript, type SpawnVolume } from './EncounterDirector';
import {
  BehaviorTree,
  Blackboard,
  advanceToRange,
  bark as barkNode,
  compileTree,
  cond,
  cooldown,
  fail,
  faceTarget,
  fireBurst,
  followOrder,
  guard,
  guardAnchor,
  hasOrder,
  holdCover,
  holdPosition,
  leaveCover,
  meleeStrike,
  par,
  patrolArea,
  repositionFiring,
  scanArea,
  searchLastKnown,
  sel,
  seq,
  strafeAtRange,
  takeCover,
  telegraph,
  timeout,
  wait,
  withAttackToken,
  type BtContext,
} from './BehaviorTree';

// ---------------------------------------------------------------------------
// The contract with EnemyManager
// ---------------------------------------------------------------------------

/** Coarse behavioural state, for animation selection and the debug overlay. */
export type AiStateName =
  | 'idle'
  | 'patrol'
  | 'alert'
  | 'search'
  | 'engage'
  | 'cover'
  | 'flank'
  | 'advance'
  | 'retreat'
  | 'attack'
  | 'stagger'
  | 'dead';

/** Vocalisation cues. The audio owner maps these to synthesised barks. */
export type AiBark =
  | 'spot'
  | 'suspicious'
  | 'lost'
  | 'flank'
  | 'grenade'
  | 'charge'
  | 'cover'
  | 'reinforce'
  | 'taunt'
  | 'hurt'
  | 'death';

/**
 * The block the AI writes and the enemy presentation layer reads.
 *
 * `fire`, `leap` and `bark` are **one-step pulses**: set by the AI, consumed by
 * `EnemyManager` on its next update, cleared by the AI at the top of the step
 * after that. Read them, do not clear them.
 */
export interface AiAgentOutput {
  state: AiStateName;
  /** Body yaw, radians, Y-up. */
  yaw: number;
  /** Head/weapon yaw — leads the body so units track while turning. */
  aimYaw: number;
  aimPitch: number;
  /** 0..1 locomotion blend (idle → sprint). */
  locomotion: number;
  /** -1..1 lateral blend for strafe animation. */
  strafe: number;
  /** Horizontal speed, m/s. */
  speed: number;
  grounded: boolean;
  /** 0..1 attack wind-up progress. Non-zero means "play the telegraph pose". */
  windup: number;
  /** Id of the attack being wound up / released. */
  attackId: string;
  /** One-step pulse: release the attack now, at `aimPoint`. */
  fire: boolean;
  /** Where the released attack is aimed, aim error already applied. */
  readonly aimPoint: THREE.Vector3;
  /** One-step pulse: play a leap take-off. */
  leap: boolean;
  /** One-step pulse: play this bark. */
  bark: AiBark | null;
  /** True while crouched in a claimed cover point. */
  inCover: boolean;
  /** True while this unit holds an attack permit. */
  hasToken: boolean;
  /** Current squad order kind, for the debug overlay. */
  order: string;
}

/** Convenience factory so EnemyManager never has to remember the field list. */
export function createAiOutput(): AiAgentOutput {
  return {
    state: 'idle',
    yaw: 0,
    aimYaw: 0,
    aimPitch: 0,
    locomotion: 0,
    strafe: 0,
    speed: 0,
    grounded: true,
    windup: 0,
    attackId: '',
    fire: false,
    aimPoint: new THREE.Vector3(),
    leap: false,
    bark: null,
    inCover: false,
    hasToken: false,
    order: 'idle',
  };
}

/** What the AI needs from one enemy. `EnemyManager`'s units satisfy this. */
export interface AiAgent {
  readonly entityId: number;
  readonly archetype: EnemyArchetype;
  /** Capsule centre. The AI moves this through `resolveCapsule`. */
  readonly position: THREE.Vector3;
  /** Linear velocity, m/s. The AI integrates it. */
  readonly velocity: THREE.Vector3;
  readonly isDead: boolean;
  health: number;
  maxHealth: number;
  /** Set by EnemyManager while staggered; the AI suspends decisions and motion. */
  staggered?: boolean;
  /** Optional behaviour id; looked up in the director's registry. */
  behaviourId?: string;
  readonly ai: AiAgentOutput;
}

/**
 * What the AI needs from the enemy manager.
 *
 * The roster may be exposed as either `agents` or `active` — `EnemyManager`
 * calls it `active`, and there is no reason to make a name collision into an
 * integration problem. `aliveCount` is optional and derived when absent.
 */
export interface AiEnemyHost {
  /** Every live agent. Read every step; the array itself may be reused. */
  readonly agents?: readonly AiAgent[];
  /** Alias accepted in place of `agents`. */
  readonly active?: readonly AiAgent[];
  /** Number of agents that are alive. Derived from the roster when omitted. */
  readonly aliveCount?: number;
  /** Create an enemy. Returns null when the pool or budget is exhausted. */
  spawn(archetypeId: string, position: THREE.Vector3, yaw: number): AiAgent | null;
  /** Archetype ids for a faction/rank, used by the encounter director. */
  archetypesFor?(faction: FactionId, rank: EnemyRank): string[];
  /** Deal an attack the AI released. Optional: the manager may poll `ai.fire`. */
  onAttack?(agent: AiAgent, aimPoint: THREE.Vector3): void;
}

const NO_AGENTS: readonly AiAgent[] = [];

/** Resolve the roster from whichever field the manager publishes. */
export function hostAgents(host: AiEnemyHost): readonly AiAgent[] {
  return host.agents ?? host.active ?? NO_AGENTS;
}

/** Live enemy count, derived when the manager does not publish one. */
export function hostAliveCount(host: AiEnemyHost): number {
  if (typeof host.aliveCount === 'number') return host.aliveCount;
  const list = hostAgents(host);
  let n = 0;
  for (let i = 0; i < list.length; i++) if (!list[i].isDead) n++;
  return n;
}

/** Per-agent AI memory. One per live enemy; recycled, never reallocated. */
export interface AiBrain {
  agent: AiAgent;
  percept: PerceptionState;
  steer: SteerState;
  cmd: SteerCommand;
  /** Copy of the last command produced by a behaviour tick, replayed between
   *  ticks so motion is continuous at 120 Hz while decisions run at 30 Hz. */
  cmdLatched: SteerCommand;
  order: SquadOrder;
  path: NavPath;
  bb: Blackboard;
  tree: BehaviorTree;
  /** Seconds since this brain was bound to its agent. */
  age: number;
  /** Accumulated dt awaiting the next (30 Hz) behaviour-tree tick. */
  btAccum: number;
  /** Which of the four stagger slots this agent ticks on. */
  btPhase: number;
  /** Wind-up bookkeeping owned by `telegraph`. */
  windupTimer: number;
  windupDuration: number;
  windupTouched: boolean;
  /** Burst bookkeeping owned by `fireBurst`. */
  burstLeft: number;
  burstTimer: number;
  burstTouched: boolean;
  /** Cover point currently claimed, if any. */
  cover: CoverPoint | null;
  /** Seconds until this agent may run another A* search. */
  repathTimer: number;
  /** True when the agent is following the shared flow field, not its own path. */
  useFlow: boolean;
  /** True when the last behaviour tick asked to follow a route. */
  pathActive: boolean;
  readonly pathGoal: THREE.Vector3;
  pathGoalValid: boolean;
  /** Free-form goal used by patrol/wander nodes. */
  readonly moveGoal: THREE.Vector3;
  moveGoalValid: boolean;
  /** Where this agent was spawned; patrol and guard orbit it. */
  readonly anchor: THREE.Vector3;
  hasToken: boolean;
  tokenTime: number;
  /** Seconds since the last released attack. */
  sinceAttack: number;
  /** Seconds the agent has spent standing on a non-navigable cell. */
  offNav: number;
  rng: Rng;
}

/** The subset of the director behaviour-tree nodes are allowed to touch. */
export interface AiBrainHost {
  readonly nav: NavGrid;
  readonly cover: CoverMap;
  readonly steering: Steering;
  readonly perception: Perception;
  readonly target: TargetSignature;
  readonly threatLevel: number;
  requestToken(brain: AiBrain): boolean;
  releaseToken(brain: AiBrain): void;
  /** Plan or reuse a route to `goal`. False when it is unreachable. */
  pathTo(brain: AiBrain, goal: THREE.Vector3): boolean;
  /** Consume one step of the planned route at the given pace. */
  followPath(brain: AiBrain, speed: number): void;
  bark(brain: AiBrain, id: AiBark): void;
  /** Release an attack toward `point`, with the agent's aim error applied. */
  fireAt(brain: AiBrain, point: THREE.Vector3): void;
  requestReinforcements(brain: AiBrain): boolean;
}

// ---------------------------------------------------------------------------
// Default behaviour
// ---------------------------------------------------------------------------

const isMelee = (c: BtContext): boolean => c.brain.agent.archetype.preferredRange <= 4.5;

/**
 * The stock soldier. Faction owners override it per archetype with
 * `registerBehaviour`, but this alone is a complete, shippable enemy: it takes
 * cover when hurt, obeys squad flanking orders, telegraphs every shot, only
 * fires while holding an attack token, relocates on a cooldown so it never
 * roots in the open, and searches plausibly when it loses you.
 *
 * The engage branch is a parallel on purpose: the movement lane and the attack
 * lane run at the same time, which is why these enemies shoot *while* moving
 * rather than alternating between the two like a turret on rails.
 */
export const DEFAULT_BEHAVIOUR: BehaviorTree = compileTree(
  sel(
    // -- engaged ------------------------------------------------------------
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        // Movement lane. Every branch is wrapped in `fail` so that *completing*
        // a manoeuvre drops through to the next option instead of returning
        // success and leaving the unit rooted — which is how "never stand still
        // shooting in the open" is enforced structurally rather than by hope.
        // The final `strafeAtRange` never succeeds, so the lane always moves.
        sel(
          fail(
            seq(
              cond(
                'badlyHurt',
                (c) =>
                  c.brain.agent.health / Math.max(1, c.brain.agent.maxHealth) < 0.3 &&
                  c.brain.agent.archetype.caution > 0.35,
              ),
              barkNode('hurt'),
              takeCover(26, true, 1),
              holdCover(3.2),
              leaveCover(),
            ),
          ),
          // Flanks and advances walk to the position the squad computed, not to
          // a point of the unit's own choosing. Ignoring the order was the
          // difference between a pincer and a conga line: every unit picked the
          // same "closest point at my preferred range" and they all converged.
          fail(
            seq(
              hasOrder('flankLeft', 'flankRight'),
              barkNode('flank'),
              timeout(9, followOrder(0.95)),
            ),
          ),
          fail(
            seq(
              hasOrder('holdCover', 'suppress'),
              takeCover(22, false, 0.9),
              holdCover(2.6),
              leaveCover(),
            ),
          ),
          fail(seq(hasOrder('retreat', 'regroup'), timeout(5, followOrder(0.9)))),
          fail(
            seq(
              hasOrder('advance'),
              timeout(6, followOrder(0.85)),
              // Having reached the ordered ring position, close the last of the
              // gap to weapon range rather than stopping short of it.
              advanceToRange(undefined, 0.8),
            ),
          ),
          fail(cooldown(4.5, repositionFiring(11, 0.8))),
          strafeAtRange(),
        ),
        // attack lane
        sel(
          guard(isMelee, seq(advanceToRange(2.2, 1), meleeStrike(2.4, 0.4))),
          withAttackToken(
            seq(faceTarget(0.3), telegraph(0.42, 'shoot', 'taunt'), fireBurst(3)),
          ),
          wait(0.4),
        ),
      ),
    ),
    // -- searching ----------------------------------------------------------
    guard(
      (c) => c.brain.percept.state === 'searching',
      sel(seq(searchLastKnown(0.75), scanArea(2.2)), scanArea(1.6)),
    ),
    // -- suspicious ---------------------------------------------------------
    guard(
      (c) => c.brain.percept.state === 'suspicious',
      seq(barkNode('suspicious'), sel(searchLastKnown(0.5), scanArea(1.8))),
    ),
    // -- idle ---------------------------------------------------------------
    sel(
      guard((c) => c.brain.order.kind === 'guard' && c.brain.age > 6, guardAnchor(3)),
      patrolArea(13),
      holdPosition(),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Danger sources
// ---------------------------------------------------------------------------

interface DangerSource {
  x: number;
  z: number;
  radius: number;
  strength: number;
  ttl: number;
}

const MAX_DANGER = 12;

// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _bounds = new THREE.Box3();

/** Default half-extent of the navigable area around the player spawn, metres. */
export const DEFAULT_NAV_RADIUS = 104;

export class AiDirector implements EngineSystem, AiBrainHost {
  readonly name = 'ai';

  nav: NavGrid;
  cover: CoverMap;
  readonly perception = new Perception();
  readonly steering = new Steering();
  readonly squads = new SquadBrain();
  readonly encounters: EncounterDirector;

  /** Refreshed once per step; everything downstream reads this, not the Player. */
  readonly target: TargetSignature = {
    eye: new THREE.Vector3(),
    centre: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    exposure: 1,
    dead: false,
  };

  /** Behaviour trees by archetype id. Faction owners populate this. */
  private behaviours = new Map<string, BehaviorTree>();
  private brains = new Map<number, AiBrain>();
  private brainList: AiBrain[] = [];
  /** entityId → steer state, kept in sync with `brainList` so the separation
   *  solver needs no per-step map rebuild. */
  private steerStates = new Map<number, SteerState>();
  private freePaths: NavPath[] = [];

  private engine: Engine;
  private host: AiEnemyHost;
  private player: Player;
  private world: CollisionWorld | null = null;
  private level: Level | null = null;

  private danger: DangerSource[] = [];
  private dangerCount = 0;
  private rng = new Rng(0x2b7e1516);
  private unsubs: Array<() => void> = [];

  /** A* searches allowed per simulation step across the whole population. */
  pathBudget = 2;
  /** Seconds since the last `combat:threat` emit, and the value it carried. */
  private threatPublish = 0;
  private threatSent = 0;
  private pathsThisStep = 0;
  private flowTimer = 0;
  private footstepTimer = 0;

  private btContext: BtContext;

  /** Rolling diagnostics, surfaced to `window.GF.debug` and the harness. */
  readonly stats = {
    agents: 0,
    engaged: 0,
    pathsPlanned: 0,
    pathFailures: 0,
    losRays: 0,
    steerRays: 0,
    tokens: 0,
    navProgress: 0,
    coverPoints: 0,
    lastStepMs: 0,
    /** Per-phase cost of the last step, ms. Five clock reads, worth the insight. */
    msNav: 0,
    msPerception: 0,
    msSquads: 0,
    msAgents: 0,
    msEncounter: 0,
  };

  constructor(engine: Engine, enemies: AiEnemyHost, player: Player) {
    this.engine = engine;
    this.host = enemies;
    this.player = player;

    // A placeholder grid so every accessor is valid before a level is bound.
    _bounds.min.set(-4, -4, -4);
    _bounds.max.set(4, 4, 4);
    this.nav = new NavGrid(nullWorld, _bounds);
    this.cover = new CoverMap(this.nav, nullWorld, 32);
    this.encounters = new EncounterDirector(enemies);

    this.btContext = { brain: null as unknown as AiBrain, host: this, dt: 1 / 30, nodeId: 0 };

    for (let i = 0; i < MAX_DANGER; i++) {
      this.danger.push({ x: 0, z: 0, radius: 1, strength: 0, ttl: 0 });
    }

    this.squads.onReinforce = (squad: Squad) => this.encounters.requestReinforcements(squad);

    this.unsubs.push(
      // The player's own gunfire is the loudest thing in the level. Enemies
      // hear it, they do not see through it: hearing can only raise suspicion.
      events.on('weapon:fired', () => {
        if (!this.world) return;
        this.perception.hear(this.player.position, 58, hostAgents(this.host));
      }),
      events.on('explosion', (p) => {
        if (!this.world) return;
        this.perception.hear(p.point, Math.max(24, p.radius * 7), hostAgents(this.host));
        this.addDanger(p.point, p.radius * 1.6, 3.5, 4);
      }),
      events.on('enemy:killed', (p) => {
        const brain = this.brains.get(p.entityId);
        if (brain) {
          this.squads.releaseToken(brain);
          this.cover.release(p.entityId);
        }
        // A body dropping is a very loud, very specific piece of information.
        this.perception.hear(p.position, 26, hostAgents(this.host));
      }),
    );
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Build navigation and cover for a level. Both build incrementally from the
   * next simulation step, so this returns immediately and the game keeps its
   * frame rate while the grid fills in.
   */
  bindLevel(level: Level, opts?: Partial<NavGridOptions>): void {
    this.releaseAll();
    this.nav.dispose();
    this.cover.dispose();

    this.level = level;
    this.world = level.collision;

    const spawn = level.getSpawnPoint();
    const hint = level as unknown as { navBounds?: THREE.Box3; navRadius?: number };
    if (hint.navBounds) {
      _bounds.copy(hint.navBounds);
    } else {
      const r = hint.navRadius ?? DEFAULT_NAV_RADIUS;
      _bounds.min.set(spawn.position.x - r, spawn.position.y - 60, spawn.position.z - r);
      _bounds.max.set(spawn.position.x + r, spawn.position.y + 60, spawn.position.z + r);
    }

    this.nav = new NavGrid(level.collision, _bounds, opts);
    // Left null while nothing is burning: A* calls this once per expanded
    // neighbour, so an always-installed hook that returns 0 costs real time.
    this.nav.dangerFn = null;
    const profile = settings.profile;
    this.cover = new CoverMap(
      this.nav,
      level.collision,
      Math.round(160 + profile.enemyBudget * 9),
    );

    this.perception.bindWorld(level.collision);
    this.steering.world = level.collision;
    this.steering.onNav = this.navQuery;
    this.squads.bind(this.nav, this.cover);
    this.encounters.bind(this.nav, (a, b) => level.collision.lineOfSight(a, b));
    this.dangerCount = 0;
  }

  /** Register a behaviour tree for an archetype id. Faction owners call this. */
  registerBehaviour(archetypeId: string, tree: BehaviorTree): void {
    this.behaviours.set(archetypeId, tree);
    // Rebind any live agent of that archetype so hot-reload works in dev.
    for (const brain of this.brainList) {
      if (brain.agent.archetype.id === archetypeId) {
        brain.tree = tree;
        brain.bb = tree.createBlackboard();
      }
    }
  }

  /** Look up the tree an agent will use. */
  behaviourFor(agent: AiAgent): BehaviorTree {
    return (
      (agent.behaviourId ? this.behaviours.get(agent.behaviourId) : undefined) ??
      this.behaviours.get(agent.archetype.id) ??
      DEFAULT_BEHAVIOUR
    );
  }

  /** Register a spawn volume. Levels call this after `bindLevel`. */
  addSpawnVolume(v: SpawnVolume): SpawnVolume {
    return this.encounters.addVolume(v);
  }

  /** Kick off a scripted encounter (waves → optional boss → `level:cleared`). */
  startEncounter(script: EncounterScript): void {
    this.encounters.start(script);
  }

  /** 0..1 combat intensity. Music, pacing and the token pool read this. */
  get threatLevel(): number {
    return this.encounters.threatLevel;
  }

  /** The standing order for an entity. Stable object; safe to hold a reference. */
  requestOrder(entityId: number): SquadOrder {
    return this.squads.order(entityId);
  }

  /** Perception state for an entity, for HUD threat markers and debug. */
  perceptionOf(entityId: number): PerceptionState | undefined {
    return this.perception.get(entityId);
  }

  brainOf(entityId: number): AiBrain | undefined {
    return this.brains.get(entityId);
  }

  // -- danger ----------------------------------------------------------------

  /** Mark an area as expensive to path through — grenades, fire, hazards. */
  addDanger(position: THREE.Vector3, radius: number, strength: number, seconds: number): void {
    let slot = -1;
    for (let i = 0; i < MAX_DANGER; i++) {
      if (this.danger[i].ttl <= 0) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      // Replace the weakest source rather than growing the pool.
      let weakest = 0;
      for (let i = 1; i < MAX_DANGER; i++) {
        if (this.danger[i].strength < this.danger[weakest].strength) weakest = i;
      }
      slot = weakest;
    }
    const d = this.danger[slot];
    d.x = position.x;
    d.z = position.z;
    d.radius = Math.max(1, radius);
    d.strength = strength;
    d.ttl = seconds;
    this.dangerCount = Math.max(this.dangerCount, slot + 1);
    if (!this.nav.dangerFn) this.nav.dangerFn = this.dangerSampler;
  }

  /** Bound once so installing/removing it never allocates. */
  private dangerSampler = (x: number, z: number): number => this.dangerAt(x, z);

  /** Bound nav lookup handed to the steering layer. */
  private navQuery = (x: number, z: number): boolean => {
    const cell = this.nav.cellAt(x, z);
    return cell < 0 ? true : (this.nav.flags[cell] & NAV_WALKABLE) !== 0;
  };

  private dangerAt(x: number, z: number): number {
    let total = 0;
    for (let i = 0; i < this.dangerCount; i++) {
      const d = this.danger[i];
      if (d.ttl <= 0) continue;
      const dx = x - d.x;
      const dz = z - d.z;
      const r2 = d.radius * d.radius;
      const q = dx * dx + dz * dz;
      if (q >= r2) continue;
      total += d.strength * (1 - Math.sqrt(q) / d.radius);
    }
    return total;
  }

  // -- the step --------------------------------------------------------------

  update(ctx: FrameContext): void {
    const t0 = performance.now();
    const dt = ctx.dt;
    if (!this.world) return;

    // Building the nav grid and the cover map are load-time tasks; they get a
    // slice of each frame until they finish rather than one long stall.
    if (!this.nav.ready) {
      this.nav.step(1.4);
      this.stats.navProgress = this.nav.progress;
      return;
    }
    if (!this.cover.ready) {
      this.cover.step(0.9);
      this.stats.coverPoints = this.cover.points.length;
      // Agents still need to move while cover bakes, so we do not early-out.
    }

    this.refreshTarget(dt);
    this.syncBrains();
    this.tickDanger(dt);
    this.cover.update(dt);

    // Shared flow field toward the player: one Dijkstra pass serves the crowd.
    this.flowTimer -= dt;
    if (this.flowTimer <= 0 && this.nav.flow.idle) {
      this.flowTimer = 0.45;
      this.nav.flow.requestGoal(this.target.centre);
    }
    this.nav.flow.step(600);
    const tNav = performance.now();
    this.stats.msNav = tNav - t0;

    // Ambient noise: a sprinting player is audible without being visible.
    this.footstepTimer -= dt;
    if (this.footstepTimer <= 0) {
      this.footstepTimer = 0.4;
      const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
      if (speed > 6 && this.player.grounded) {
        this.perception.hear(this.player.position, 13, hostAgents(this.host));
      }
    }

    const agents = hostAgents(this.host);
    this.perception.update(dt, agents, this.target);
    const tPerc = performance.now();
    this.stats.msPerception = tPerc - tNav;

    let engaged = 0;
    for (let i = 0; i < this.brainList.length; i++) {
      if (this.brainList[i].percept.state === 'engaged') engaged++;
    }
    this.squads.update(dt, agents, this.brains, this.target, this.threatLevel);
    for (let i = 0; i < this.squads.revoked.length; i++) {
      const b = this.brains.get(this.squads.revoked[i]);
      if (b) b.hasToken = false;
    }

    const tSquad = performance.now();
    this.stats.msSquads = tSquad - tPerc;

    this.steering.beginStep();
    this.steering.computeSeparation(agents, this.steerStates);
    this.pathsThisStep = 0;

    const phase = ctx.tick & 3;
    for (let i = 0; i < this.brainList.length; i++) {
      this.stepAgent(this.brainList[i], ctx, phase);
    }
    // Hard depenetration, once everyone has moved. Two enemies sharing one
    // silhouette is the most visible AI failure there is, so this is a
    // guarantee rather than a force. Displacement is capped per agent and the
    // `depenetrated` flag forces a capsule resolve on the next step, which is
    // what keeps a shove near a wall from accumulating into a body in the wall.
    this.steering.resolveOverlaps(agents, this.steerStates);
    for (let i = 0; i < this.brainList.length; i++) {
      const b = this.brainList[i];
      if (b.steer.depenetrated) this.steering.settle(b.agent, b.steer);
    }

    const tAgents = performance.now();
    this.stats.msAgents = tAgents - tSquad;

    this.encounters.hostHealth01 = this.player.maxHealth > 0
      ? clamp01((this.player.health + this.player.shield) / (this.player.maxHealth + this.player.maxShield))
      : 1;
    this.encounters.update(dt, agents, this.target, engaged);

    // Publish the threat level for audio. Emitting every step would be 120 Hz of
    // pub/sub for a value that drives a multi-second crossfade, so it goes out
    // eight times a second and only when it has actually moved.
    this.threatPublish += dt;
    if (this.threatPublish >= 0.125 || Math.abs(this.threatLevel - this.threatSent) > 0.15) {
      this.threatPublish = 0;
      this.threatSent = this.threatLevel;
      events.emit('combat:threat', { level: this.threatLevel, engaged });
    }

    this.stats.msEncounter = performance.now() - tAgents;
    this.stats.agents = this.brainList.length;
    this.stats.engaged = engaged;
    this.stats.losRays = this.perception.raysCast;
    this.stats.steerRays = this.steering.raysCast;
    this.stats.tokens = this.squads.tokensHeld;
    this.stats.coverPoints = this.cover.points.length;
    this.stats.lastStepMs = performance.now() - t0;
  }

  /** One agent: clear pulses, tick the tree at 30 Hz, then steer every step. */
  private stepAgent(brain: AiBrain, ctx: FrameContext, phase: number): void {
    const agent = brain.agent;
    const ai = agent.ai;
    brain.age += ctx.dt;
    brain.sinceAttack += ctx.dt;
    if (brain.repathTimer > 0) brain.repathTimer -= ctx.dt;
    if (brain.hasToken) brain.tokenTime += ctx.dt;

    // Consume the pulses set on the previous step (EnemyManager has seen them:
    // it updates before this system, so they survive exactly one full frame).
    ai.fire = false;
    ai.leap = false;
    ai.bark = null;

    if (agent.isDead) {
      ai.state = 'dead';
      ai.windup = 0;
      ai.locomotion = 0;
      if (brain.hasToken) this.releaseToken(brain);
      return;
    }

    resetSteerCommand(brain.cmd);
    brain.windupTouched = false;
    brain.burstTouched = false;

    if (agent.staggered) {
      ai.state = 'stagger';
      brain.cmd.mode = 'stop';
      brain.windupTimer = 0;
      ai.windup = 0;
    } else {
      // Behaviour trees run at 30 Hz, staggered across four slots. Decisions do
      // not need 120 Hz; movement does, and that still runs every step.
      brain.btAccum += ctx.dt;
      if (phase === brain.btPhase) {
        this.btContext.brain = brain;
        this.btContext.dt = brain.btAccum;
        brain.pathActive = false;
        brain.tree.tick(this.btContext);
        brain.btAccum = 0;
        if (!brain.windupTouched && brain.windupTimer > 0) {
          brain.windupTimer = 0;
          ai.windup = 0;
        }
        if (!brain.burstTouched) brain.burstLeft = 0;
        brain.cmdLatched.mode = brain.cmd.mode;
        brain.cmdLatched.radius = brain.cmd.radius;
        brain.cmdLatched.orbitSign = brain.cmd.orbitSign;
        brain.cmdLatched.speed = brain.cmd.speed;
        brain.cmdLatched.crouch = brain.cmd.crouch;
        brain.cmdLatched.faceValid = brain.cmd.faceValid;
        brain.cmdLatched.target.copy(brain.cmd.target);
        brain.cmdLatched.facePoint.copy(brain.cmd.facePoint);
        brain.cmdLatched.hoverHeight = brain.cmd.hoverHeight;
      } else {
        // Between decisions the last command is held, so motion is continuous
        // rather than stuttering three steps out of four.
        brain.cmd.mode = brain.cmdLatched.mode;
        brain.cmd.radius = brain.cmdLatched.radius;
        brain.cmd.orbitSign = brain.cmdLatched.orbitSign;
        brain.cmd.speed = brain.cmdLatched.speed;
        brain.cmd.crouch = brain.cmdLatched.crouch;
        brain.cmd.faceValid = brain.cmdLatched.faceValid;
        brain.cmd.target.copy(brain.cmdLatched.target);
        brain.cmd.facePoint.copy(brain.cmdLatched.facePoint);
        brain.cmd.hoverHeight = brain.cmdLatched.hoverHeight;
        // Re-run the follower so waypoints advance and the flow-field heading
        // stays current between decisions.
        if (brain.pathActive && (brain.path.count > 0 || brain.useFlow)) {
          this.followPath(brain, brain.cmd.speed);
        }
      }
    }

    // Recovery overrides everything: an agent wedged in geometry walks itself
    // out under its own locomotion rather than being dragged, so the escape
    // still reads as movement and cannot fight the steering that put it there.
    if (brain.offNav > 0.3 && !agent.archetype.flying && this.nav.ready) {
      const near = this.nav.nearestWalkableCell(agent.position.x, agent.position.z, 10);
      if (near >= 0) {
        this.nav.cellCentre(near, _v);
        brain.cmd.mode = 'seek';
        brain.cmd.target.copy(_v);
        brain.cmd.speed = 0.85;
        brain.cmd.crouch = false;
        brain.cmd.faceValid = false;
        brain.path.clear();
        brain.useFlow = false;
        brain.repathTimer = 0;
      }
    }

    this.steering.apply(agent, brain.cmd, brain.steer, ctx);
    this.unstick(brain, ctx.dt);

    // Aim tracks the best estimate of the target independently of the body.
    const p = brain.percept;
    if (p.state === 'engaged' || p.state === 'searching') {
      _v.copy(p.hasLos && p.losAge < 0.5 ? this.target.centre : p.lastKnown);
      this.steering.aimAt(agent, _v, ctx.dt);
    } else {
      agent.ai.aimYaw = agent.ai.yaw;
      agent.ai.aimPitch = damp(agent.ai.aimPitch, 0, 5, ctx.dt);
    }

    ai.hasToken = brain.hasToken;
    ai.order = brain.order.kind;
    ai.state = this.labelState(brain);

    if (p.justAcquired) this.bark(brain, 'spot');
    if (p.justLost) this.bark(brain, 'lost');
    if (p.justAcquired) this.perception.broadcast(p, agent.position, hostAgents(this.host));
  }

  /**
   * Safety net: an agent standing on a non-navigable cell has been squeezed into
   * geometry, and the capsule solver cannot recover it — depenetrating toward
   * the nearest surface point pushes a body that is already *inside* a solid
   * further in. So we detect it directly against the nav grid and slide the
   * agent back out at a walking pace. No shipped shooter goes without some
   * version of this; the alternative is an enemy embedded in a wall for the rest
   * of the encounter.
   */
  private unstick(brain: AiBrain, dt: number): void {
    if (!this.nav.ready || brain.agent.archetype.flying) return;
    const pos = brain.agent.position;
    const cell = this.nav.cellAt(pos.x, pos.z);
    if (cell >= 0 && (this.nav.flags[cell] & NAV_WALKABLE) !== 0) {
      brain.offNav = 0;
      return;
    }
    brain.offNav += dt;
    // Give the locomotion override above a full second to walk the agent out
    // before resorting to a direct positional slide.
    if (brain.offNav < 1.3) return;
    const near = this.nav.nearestWalkableCell(pos.x, pos.z, 10);
    if (near < 0) return;
    this.nav.cellCentre(near, _v);
    const dx = _v.x - pos.x;
    const dz = _v.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return;
    const move = Math.min(d, 4 * dt);
    pos.x += (dx / d) * move;
    pos.z += (dz / d) * move;
    const arch = brain.agent.archetype;
    // Lift back onto the surface too, in case it was pushed under something.
    const targetY = _v.y + arch.capsuleHalfHeight + arch.capsuleRadius;
    if (pos.y < targetY) pos.y = Math.min(targetY, pos.y + 4 * dt);
    brain.agent.velocity.x = 0;
    brain.agent.velocity.z = 0;
    brain.path.clear();
    brain.repathTimer = 0;
    brain.steer.lastProgressPos.copy(pos);
  }

  private labelState(brain: AiBrain): AiStateName {
    const agent = brain.agent;
    if (agent.ai.windup > 0) return 'attack';
    if (agent.ai.inCover) return 'cover';
    switch (brain.percept.state) {
      case 'engaged':
        switch (brain.order.kind) {
          case 'flankLeft':
          case 'flankRight':
            return 'flank';
          case 'retreat':
          case 'regroup':
            return 'retreat';
          case 'advance':
            return 'advance';
          default:
            return 'engage';
        }
      case 'searching':
        return 'search';
      case 'suspicious':
        return 'alert';
      default:
        return brain.steer.locomotion > 0.05 ? 'patrol' : 'idle';
    }
  }

  private refreshTarget(dt: number): void {
    const p = this.player;
    const t = this.target;
    t.eye.copy(p.eyePosition);
    t.centre.copy(p.position);
    t.velocity.copy(p.velocity);
    t.forward.copy(p.aimDirection);
    t.dead = p.isDead;
    // How loud and how visible the player currently is. Sprinting through the
    // open gets you seen; crouch-walking behind a rock does not.
    let exposure = 1;
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    if (p.crouching) exposure *= speed < 1.2 ? 0.55 : 0.78;
    if (p.sprinting) exposure *= 1.35;
    if (p.firing) exposure *= 1.6;
    t.exposure = clamp(exposure, 0.35, 2.4);
    void dt;
  }

  private tickDanger(dt: number): void {
    let live = 0;
    for (let i = 0; i < this.dangerCount; i++) {
      const d = this.danger[i];
      if (d.ttl > 0) {
        d.ttl -= dt;
        if (d.ttl <= 0) d.strength = 0;
        else live++;
      }
    }
    if (live === 0 && this.nav.dangerFn) this.nav.dangerFn = null;
  }

  /** Add brains for new agents, retire brains for departed ones. */
  private syncBrains(): void {
    const agents = hostAgents(this.host);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      let brain = this.brains.get(a.entityId);
      if (!brain) {
        brain = this.createBrain(a);
        this.brains.set(a.entityId, brain);
        this.brainList.push(brain);
        this.steerStates.set(a.entityId, brain.steer);
      } else if (brain.agent !== a) {
        // The manager recycled the id onto a fresh unit: rebind in place.
        this.resetBrain(brain, a);
      }
    }
    for (let i = this.brainList.length - 1; i >= 0; i--) {
      const brain = this.brainList[i];
      if (agents.indexOf(brain.agent) >= 0) continue;
      this.retire(brain);
      this.brainList.splice(i, 1);
    }
  }

  private createBrain(agent: AiAgent): AiBrain {
    const tree = this.behaviourFor(agent);
    const brain: AiBrain = {
      agent,
      percept: this.perception.register(agent),
      steer: createSteerState(agent.entityId),
      cmd: createSteerCommand(),
      cmdLatched: createSteerCommand(),
      order: this.squads.order(agent.entityId),
      path: this.freePaths.pop() ?? new NavPath(),
      bb: tree.createBlackboard(),
      tree,
      age: 0,
      btAccum: 0,
      btPhase: agent.entityId & 3,
      windupTimer: 0,
      windupDuration: 0,
      windupTouched: false,
      burstLeft: 0,
      burstTimer: 0,
      burstTouched: false,
      cover: null,
      repathTimer: 0,
      useFlow: false,
      pathActive: false,
      pathGoal: new THREE.Vector3(),
      pathGoalValid: false,
      moveGoal: new THREE.Vector3(),
      moveGoalValid: false,
      anchor: agent.position.clone(),
      hasToken: false,
      tokenTime: 0,
      sinceAttack: 99,
      offNav: 0,
      rng: new Rng(0x1234567 + agent.entityId * 2246822519),
    };
    brain.steer.lastProgressPos.copy(agent.position);
    return brain;
  }

  private resetBrain(brain: AiBrain, agent: AiAgent): void {
    this.cover.release(brain.agent.entityId);
    this.squads.releaseToken(brain);
    brain.agent = agent;
    brain.percept = this.perception.register(agent);
    brain.steer = createSteerState(agent.entityId);
    this.steerStates.set(agent.entityId, brain.steer);
    brain.order = this.squads.order(agent.entityId);
    const tree = this.behaviourFor(agent);
    if (tree !== brain.tree) {
      brain.tree = tree;
      brain.bb = tree.createBlackboard();
    } else {
      brain.bb.clear();
    }
    brain.path.clear();
    brain.age = 0;
    brain.btAccum = 0;
    brain.btPhase = agent.entityId & 3;
    brain.windupTimer = 0;
    brain.burstLeft = 0;
    brain.cover = null;
    brain.repathTimer = 0;
    brain.useFlow = false;
    brain.pathActive = false;
    brain.pathGoalValid = false;
    brain.moveGoalValid = false;
    brain.hasToken = false;
    brain.offNav = 0;
    brain.anchor.copy(agent.position);
    brain.steer.lastProgressPos.copy(agent.position);
    resetSteerCommand(brain.cmd);
    resetSteerCommand(brain.cmdLatched);
  }

  private retire(brain: AiBrain): void {
    this.cover.release(brain.agent.entityId);
    this.squads.forget(brain.agent.entityId);
    this.perception.unregister(brain.agent.entityId);
    this.brains.delete(brain.agent.entityId);
    this.steerStates.delete(brain.agent.entityId);
    brain.path.clear();
    this.freePaths.push(brain.path);
  }

  private releaseAll(): void {
    for (const brain of this.brainList) {
      this.cover.release(brain.agent.entityId);
      this.squads.forget(brain.agent.entityId);
    }
    this.brainList.length = 0;
    this.brains.clear();
    this.steerStates.clear();
    this.perception.clear();
    this.squads.clear();
    this.freePaths.length = 0;
  }

  // -- AiBrainHost -----------------------------------------------------------

  requestToken(brain: AiBrain): boolean {
    return this.squads.requestToken(brain);
  }

  releaseToken(brain: AiBrain): void {
    this.squads.releaseToken(brain);
    brain.tokenTime = 0;
  }

  /**
   * Plan or reuse a route. Three tiers, cheapest first:
   *   1. the existing path, if the goal has not moved much;
   *   2. the shared flow field, when the goal is essentially "the player";
   *   3. a real A* search, rate-limited to `pathBudget` per step.
   */
  pathTo(brain: AiBrain, goal: THREE.Vector3): boolean {
    if (!this.nav.ready) return false;
    const path = brain.path;

    const goalMoved = !brain.pathGoalValid || brain.pathGoal.distanceToSquared(goal) > 2.25;
    if (!goalMoved && (path.count > 0 || brain.useFlow)) return true;

    // Chasing the player specifically: use the crowd flow field. Thirty enemies
    // converging on one target must not be thirty A* searches.
    const nearTarget = goal.distanceToSquared(this.target.centre) < 16;
    if (nearTarget && this.nav.flow.hasField) {
      const c = this.nav.flow.costAt(brain.agent.position.x, brain.agent.position.z);
      if (Number.isFinite(c)) {
        brain.useFlow = true;
        brain.pathGoal.copy(goal);
        brain.pathGoalValid = true;
        path.clear();
        return true;
      }
    }

    if (brain.repathTimer > 0 && (path.count > 0 || brain.useFlow)) return true;
    if (this.pathsThisStep >= this.pathBudget) return path.count > 0 || brain.useFlow;

    this.pathsThisStep++;
    this.stats.pathsPlanned++;
    brain.useFlow = false;
    // Cost-limited so a long, hopeless search cannot spike a frame.
    const ok = this.nav.findPath(brain.agent.position, goal, path, 3200);
    brain.repathTimer = ok ? 0.55 : 1.1;
    brain.pathGoal.copy(goal);
    brain.pathGoalValid = true;
    if (path.count === 0) {
      this.stats.pathFailures++;
      brain.pathGoalValid = false;
      return false;
    }
    // Drop the first waypoint if we are already standing on it.
    if (path.count > 1 && path.points[0].distanceToSquared(brain.agent.position) < 0.6) {
      path.cursor = 1;
    }
    return true;
  }

  /** Convert the plan into a steering command for this step. */
  followPath(brain: AiBrain, speed: number): void {
    const cmd = brain.cmd;
    cmd.speed = clamp01(speed);
    brain.pathActive = true;

    if (brain.useFlow) {
      if (this.nav.flow.sample(brain.agent.position.x, brain.agent.position.z, _v)) {
        cmd.mode = 'seek';
        cmd.target
          .copy(brain.agent.position)
          .addScaledVector(_v, 4)
          .setY(brain.agent.position.y);
        return;
      }
      // The field does not cover us (fell outside, or mid-rebuild): fall back
      // to walking straight at the goal and re-plan shortly.
      brain.useFlow = false;
      brain.repathTimer = 0;
      cmd.mode = 'arrive';
      cmd.target.copy(brain.pathGoal);
      return;
    }

    const path = brain.path;
    if (path.count === 0) {
      cmd.mode = 'stop';
      return;
    }

    // Advance past every waypoint we have effectively reached, so a burst of
    // speed does not leave the agent doubling back.
    let guardCount = 0;
    while (guardCount++ < 4) {
      const wp = path.current();
      if (!wp) break;
      const dx = wp.x - brain.agent.position.x;
      const dz = wp.z - brain.agent.position.z;
      const last = path.cursor >= path.count - 1;
      const radius = last ? 0.8 : 1.15;
      if (dx * dx + dz * dz > radius * radius) break;
      path.advance();
    }

    const wp = path.current();
    if (!wp) {
      cmd.mode = 'arrive';
      cmd.target.copy(path.points[Math.max(0, path.count - 1)]);
      return;
    }
    // Corner-cut toward the following waypoint when it is directly visible —
    // this is what stops the agent visibly touching each node like a pinball.
    const nxt = path.next();
    if (nxt && this.nav.lineWalkable(brain.agent.position, nxt)) {
      cmd.target.copy(nxt);
      path.advance();
    } else {
      cmd.target.copy(wp);
    }
    cmd.mode = path.cursor >= path.count - 1 ? 'arrive' : 'seek';
  }

  bark(brain: AiBrain, id: AiBark): void {
    brain.agent.ai.bark = id;
  }

  /**
   * Release an attack. Aim error comes from the agent's archetype accuracy
   * scaled by how stale its information is, so an enemy shooting at a
   * half-remembered position genuinely misses.
   */
  fireAt(brain: AiBrain, point: THREE.Vector3): void {
    const agent = brain.agent;
    const arch = agent.archetype;
    agentEye(agent, _v2);
    _aim.copy(point).sub(_v2);
    const dist = _aim.length();
    if (dist < 1e-4) return;
    _aim.multiplyScalar(1 / dist);

    const err = this.perception.aimError(brain.percept, arch.accuracy);
    if (err > 1e-5) {
      // Uniform disc of radius tan(err)*distance around the true aim point, in
      // the plane perpendicular to the shot. Error scales with distance, which
      // is exactly how a real weapon's angular spread behaves.
      _right.set(-_aim.z, 0, _aim.x);
      const rl = _right.length();
      if (rl > 1e-4) _right.multiplyScalar(1 / rl);
      else _right.set(1, 0, 0);
      _up.crossVectors(_right, _aim).normalize();
      const ang = this.rng.next() * Math.PI * 2;
      const mag = Math.tan(Math.min(err, 0.7)) * dist * Math.sqrt(this.rng.next());
      agent.ai.aimPoint
        .copy(point)
        .addScaledVector(_right, Math.cos(ang) * mag)
        .addScaledVector(_up, Math.sin(ang) * mag);
    } else {
      agent.ai.aimPoint.copy(point);
    }

    agent.ai.fire = true;
    brain.sinceAttack = 0;
    this.host.onAttack?.(agent, agent.ai.aimPoint);
  }

  requestReinforcements(brain: AiBrain): boolean {
    const squad = this.squads.squadFor(brain.agent.entityId);
    if (!squad) return false;
    const ok = this.encounters.requestReinforcements(squad);
    if (ok) this.bark(brain, 'reinforce');
    return ok;
  }

  // -- debug -----------------------------------------------------------------

  /**
   * Snapshot for the debug overlay and the verification harness. Allocates —
   * only call it from tooling, never per frame.
   */
  debugSnapshot(): Record<string, unknown> {
    return {
      ...this.stats,
      threat: this.threatLevel,
      pressure: this.encounters.pressure,
      targetPopulation: this.encounters.targetPopulation,
      maxAttackers: this.squads.maxAttackers,
      rangedTokens: this.squads.rangedTokens,
      meleeTokens: this.squads.meleeTokens,
      squads: this.squads.squads.length,
      navReady: this.nav.ready,
      navCells: this.nav.count,
      navWalkable: this.nav.ready ? this.nav.countWalkable() : 0,
      navBuildMs: this.nav.buildMs,
      coverReady: this.cover.ready,
      coverQueries: { ...this.cover.stats },
      wave: this.encounters.currentWave,
      waves: this.encounters.totalWaves,
    };
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.releaseAll();
    this.encounters.dispose();
    this.cover.dispose();
    this.nav.dispose();
    this.perception.bindWorld(null);
    this.steering.world = null;
    this.steering.onNav = null;
    this.world = null;
    this.level = null;
  }
}

// ---------------------------------------------------------------------------

/** A no-op collision world so the director is valid before a level is bound. */
const nullWorld: CollisionWorld = {
  raycast: () => null,
  resolveCapsule: () => ({
    grounded: false,
    groundNormal: new THREE.Vector3(0, 1, 0),
    slope: 0,
    touchedWall: false,
    wallNormal: new THREE.Vector3(),
    landingImpact: 0,
  }),
  sampleGround: () => null,
  lineOfSight: () => true,
};

export type { SquadOrder, SquadOrderKind, Squad } from './SquadBrain';
export type { PerceptionState, AwarenessState, TargetSignature } from './Perception';
export type { CoverPoint, CoverQuery } from './CoverMap';
export type { SpawnVolume, EncounterScript, WaveSpec, WaveUnit } from './EncounterDirector';
export { NavGrid, NavPath, FlowField } from './NavGrid';
export { CoverMap } from './CoverMap';
export { Perception } from './Perception';
export { Steering } from './Steering';
export { SquadBrain } from './SquadBrain';
export { EncounterDirector } from './EncounterDirector';
export * from './BehaviorTree';
