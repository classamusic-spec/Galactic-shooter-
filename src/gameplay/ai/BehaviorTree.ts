/**
 * BehaviorTree — a small, allocation-free BT runtime plus the domain node
 * library that faction authors compose species behaviour from.
 *
 * The important structural decision: **nodes are shared, state is not.** A tree
 * is compiled once per archetype (`compileTree`) and every agent of that
 * archetype ticks the *same* node objects, carrying its own `Blackboard` — three
 * typed arrays indexed by node id. Ticking therefore allocates nothing, and a
 * hundred agents of one species cost one tree's worth of memory.
 *
 * The node library at the bottom of this file is the public surface for faction
 * owners. A species is a data expression, e.g.
 *
 * ```ts
 * export const mantisSkirmisher = compileTree(
 *   sel(
 *     guard(isEngaged(),
 *       sel(
 *         seq(cond('low', c => c.brain.agent.health / c.brain.agent.maxHealth < 0.3),
 *             bark('hurt'), takeCover(), holdCover(2.5)),
 *         withAttackToken(seq(faceTarget(), telegraph(0.45, 'spit'), fireBurst(3, 0.12))),
 *         strafeAtRange(),
 *       )),
 *     guard(isSearching(), searchLastKnown()),
 *     patrolArea(14),
 *   ),
 * );
 * ```
 *
 * Nothing in here knows what a Mantis is; nothing in the faction files needs to
 * know what a Dijkstra is.
 */
import * as THREE from 'three';
import { clamp, clamp01 } from '@/util/math';
import type { AiBark, AiBrain, AiBrainHost } from './AiDirector';

export const FAILURE = 0;
export const SUCCESS = 1;
export const RUNNING = 2;
export type BtStatus = 0 | 1 | 2;

/** Named scratch slots on the blackboard, so species code can share meaning. */
export const BB_SLOT = {
  /** Generic seconds counter for species-specific logic. */
  timerA: 0,
  timerB: 1,
  /** Generic counters. */
  countA: 2,
  countB: 3,
  /** Chosen strafe direction persisted across ticks. */
  strafeSign: 4,
  /** Last chosen attack index. */
  attack: 5,
} as const;

/** Per-agent behaviour-tree memory. One per agent; never reallocated. */
export class Blackboard {
  /** Composite bookkeeping: index of the child that was running. */
  readonly nodeChild: Uint8Array;
  /** Decorator/leaf timers, seconds. */
  readonly nodeTimer: Float32Array;
  /** One byte of per-node flags (entered, latched, …). */
  readonly nodeFlag: Uint8Array;
  /** Free numeric slots for species logic. */
  readonly num = new Float32Array(12);
  /** Free vector slots for species logic. */
  readonly vec: THREE.Vector3[] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];

  constructor(nodeCount: number) {
    this.nodeChild = new Uint8Array(nodeCount);
    this.nodeTimer = new Float32Array(nodeCount);
    this.nodeFlag = new Uint8Array(nodeCount);
  }

  clear(): void {
    this.nodeChild.fill(0);
    this.nodeTimer.fill(0);
    this.nodeFlag.fill(0);
    this.num.fill(0);
  }
}

/** Everything a node can reach. Constructed once by the director, then reused. */
export interface BtContext {
  brain: AiBrain;
  host: AiBrainHost;
  /** Fixed simulation step, seconds. */
  dt: number;
  /**
   * Id of the leaf currently ticking. Action leaves use it to index their own
   * slot in `bb.nodeTimer` / `bb.nodeFlag`, which is how two timed actions in
   * the same tree keep separate state without the author having to hand-allocate
   * blackboard slots (and without two of them silently sharing one).
   */
  nodeId: number;
}

/** Parameters may be constants or evaluated per tick from the context. */
export type BtNumber = number | ((c: BtContext) => number);
export type BtPoint = (c: BtContext, out: THREE.Vector3) => boolean;

export function evalNumber(v: BtNumber, c: BtContext): number {
  return typeof v === 'number' ? v : v(c);
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export abstract class BtNode {
  /** Assigned by `compileTree`; indexes the blackboard arrays. */
  id = 0;
  readonly children: BtNode[] = [];
  /** Debug label, shown by the AI overlay. */
  label = '';

  abstract tick(c: BtContext): BtStatus;

  /** Clear this subtree's per-agent state. Called when a branch is abandoned. */
  reset(c: BtContext): void {
    const bb = c.brain.bb;
    bb.nodeChild[this.id] = 0;
    bb.nodeTimer[this.id] = 0;
    bb.nodeFlag[this.id] = 0;
    for (let i = 0; i < this.children.length; i++) this.children[i].reset(c);
  }
}

/** A compiled tree: the shared node graph plus its node count. */
export class BehaviorTree {
  readonly root: BtNode;
  readonly nodeCount: number;

  constructor(root: BtNode, nodeCount: number) {
    this.root = root;
    this.nodeCount = nodeCount;
  }

  createBlackboard(): Blackboard {
    return new Blackboard(this.nodeCount);
  }

  tick(c: BtContext): BtStatus {
    const s = this.root.tick(c);
    // A finished tree restarts cleanly next step; a running one keeps its state.
    if (s !== RUNNING) this.root.reset(c);
    return s;
  }
}

/** Assign node ids depth-first and wrap the graph in a `BehaviorTree`. */
export function compileTree(root: BtNode): BehaviorTree {
  let next = 0;
  const visit = (n: BtNode): void => {
    n.id = next++;
    for (let i = 0; i < n.children.length; i++) visit(n.children[i]);
  };
  visit(root);
  return new BehaviorTree(root, next);
}

// ---------------------------------------------------------------------------
// Composites
// ---------------------------------------------------------------------------

class SequenceNode extends BtNode {
  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    let i = bb.nodeChild[this.id];
    while (i < this.children.length) {
      const s = this.children[i].tick(c);
      if (s === RUNNING) {
        bb.nodeChild[this.id] = i;
        return RUNNING;
      }
      if (s === FAILURE) {
        bb.nodeChild[this.id] = 0;
        return FAILURE;
      }
      i++;
    }
    bb.nodeChild[this.id] = 0;
    return SUCCESS;
  }
}

class SelectorNode extends BtNode {
  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    // `nodeChild` stores index+1 so that 0 means "nothing was running".
    const prev = bb.nodeChild[this.id] - 1;
    for (let i = 0; i < this.children.length; i++) {
      const s = this.children[i].tick(c);
      if (s === FAILURE) continue;
      // A higher-priority branch just took over: tear down the one that was
      // running so it does not resume mid-sequence later. This re-evaluation
      // from index 0 every tick is what makes the selector *reactive* — an
      // enemy drops what it is doing the instant something more urgent is true.
      if (prev >= 0 && prev !== i && prev < this.children.length) {
        this.children[prev].reset(c);
      }
      bb.nodeChild[this.id] = s === RUNNING ? i + 1 : 0;
      return s;
    }
    if (prev >= 0 && prev < this.children.length) this.children[prev].reset(c);
    bb.nodeChild[this.id] = 0;
    return FAILURE;
  }
}

export type ParallelPolicy = 'one' | 'all';

class ParallelNode extends BtNode {
  constructor(
    private successPolicy: ParallelPolicy,
    private failurePolicy: ParallelPolicy,
  ) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    let successes = 0;
    let failures = 0;
    for (let i = 0; i < this.children.length; i++) {
      const s = this.children[i].tick(c);
      if (s === SUCCESS) successes++;
      else if (s === FAILURE) failures++;
    }
    const n = this.children.length;
    if (this.failurePolicy === 'one' ? failures > 0 : failures === n) return FAILURE;
    if (this.successPolicy === 'one' ? successes > 0 : successes === n) return SUCCESS;
    return RUNNING;
  }
}

/** Weighted random choice, latched while the chosen child runs. */
class RandomSelectorNode extends BtNode {
  constructor(private weights: number[]) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    let pick = bb.nodeChild[this.id] - 1;
    if (pick < 0 || pick >= this.children.length) {
      let total = 0;
      for (let i = 0; i < this.children.length; i++) total += this.weights[i] ?? 1;
      let r = c.brain.steer.rng.next() * total;
      pick = 0;
      for (let i = 0; i < this.children.length; i++) {
        r -= this.weights[i] ?? 1;
        if (r <= 0) {
          pick = i;
          break;
        }
      }
    }
    const s = this.children[pick].tick(c);
    bb.nodeChild[this.id] = s === RUNNING ? pick + 1 : 0;
    return s;
  }
}

// ---------------------------------------------------------------------------
// Decorators
// ---------------------------------------------------------------------------

class InverterNode extends BtNode {
  override tick(c: BtContext): BtStatus {
    const s = this.children[0].tick(c);
    return s === SUCCESS ? FAILURE : s === FAILURE ? SUCCESS : RUNNING;
  }
}

class SucceederNode extends BtNode {
  override tick(c: BtContext): BtStatus {
    const s = this.children[0].tick(c);
    return s === RUNNING ? RUNNING : SUCCESS;
  }
}

class FailerNode extends BtNode {
  override tick(c: BtContext): BtStatus {
    const s = this.children[0].tick(c);
    return s === RUNNING ? RUNNING : FAILURE;
  }
}

class RepeatNode extends BtNode {
  constructor(private times: number) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    for (let guard = 0; guard < 8; guard++) {
      const s = this.children[0].tick(c);
      if (s === RUNNING) return RUNNING;
      if (s === FAILURE) {
        bb.nodeChild[this.id] = 0;
        return FAILURE;
      }
      const done = bb.nodeChild[this.id] + 1;
      if (this.times > 0 && done >= this.times) {
        bb.nodeChild[this.id] = 0;
        return SUCCESS;
      }
      bb.nodeChild[this.id] = done & 0xff;
    }
    return RUNNING;
  }
}

/** Fails while cooling down. The timer runs on the blackboard, per agent. */
class CooldownNode extends BtNode {
  constructor(private seconds: BtNumber) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    if (bb.nodeTimer[this.id] > 0) {
      bb.nodeTimer[this.id] -= c.dt;
      return FAILURE;
    }
    const s = this.children[0].tick(c);
    if (s === SUCCESS) bb.nodeTimer[this.id] = evalNumber(this.seconds, c);
    return s;
  }

  override reset(c: BtContext): void {
    // Deliberately keeps the timer: a cooldown that resets when the branch is
    // abandoned is not a cooldown.
    const t = c.brain.bb.nodeTimer[this.id];
    super.reset(c);
    c.brain.bb.nodeTimer[this.id] = t;
  }
}

/** Aborts its child the moment the condition stops holding. */
class GuardNode extends BtNode {
  constructor(private cond: (c: BtContext) => boolean) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    if (!this.cond(c)) {
      if (bb.nodeFlag[this.id] === 1) {
        this.children[0].reset(c);
        bb.nodeFlag[this.id] = 0;
      }
      return FAILURE;
    }
    const s = this.children[0].tick(c);
    bb.nodeFlag[this.id] = s === RUNNING ? 1 : 0;
    return s;
  }
}

class TimeoutNode extends BtNode {
  constructor(private seconds: BtNumber) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    bb.nodeTimer[this.id] += c.dt;
    if (bb.nodeTimer[this.id] >= evalNumber(this.seconds, c)) {
      this.children[0].reset(c);
      bb.nodeTimer[this.id] = 0;
      return FAILURE;
    }
    const s = this.children[0].tick(c);
    if (s !== RUNNING) bb.nodeTimer[this.id] = 0;
    return s;
  }
}

/** Rolls once per entry; fails outright when the roll misses. */
class ChanceNode extends BtNode {
  constructor(private p: BtNumber) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    if (bb.nodeFlag[this.id] === 0) {
      bb.nodeFlag[this.id] = c.brain.steer.rng.next() < evalNumber(this.p, c) ? 1 : 2;
    }
    if (bb.nodeFlag[this.id] === 2) {
      bb.nodeFlag[this.id] = 0;
      return FAILURE;
    }
    const s = this.children[0].tick(c);
    if (s !== RUNNING) bb.nodeFlag[this.id] = 0;
    return s;
  }
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

class ActionNode extends BtNode {
  constructor(private fn: (c: BtContext) => BtStatus) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    c.nodeId = this.id;
    return this.fn(c);
  }
}

class ConditionNode extends BtNode {
  constructor(private fn: (c: BtContext) => boolean) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    c.nodeId = this.id;
    return this.fn(c) ? SUCCESS : FAILURE;
  }
}

class WaitNode extends BtNode {
  constructor(private seconds: BtNumber) {
    super();
  }

  override tick(c: BtContext): BtStatus {
    const bb = c.brain.bb;
    bb.nodeTimer[this.id] += c.dt;
    if (bb.nodeTimer[this.id] >= evalNumber(this.seconds, c)) {
      bb.nodeTimer[this.id] = 0;
      return SUCCESS;
    }
    return RUNNING;
  }
}

// ---------------------------------------------------------------------------
// Structural builders — the composition vocabulary
// ---------------------------------------------------------------------------

function withChildren<T extends BtNode>(node: T, children: BtNode[], label: string): T {
  for (let i = 0; i < children.length; i++) node.children.push(children[i]);
  node.label = label;
  return node;
}

/** Run children in order until one fails. */
export const seq = (...children: BtNode[]): BtNode =>
  withChildren(new SequenceNode(), children, 'seq');

/** Run children in order until one succeeds. Reactive: re-evaluates priorities. */
export const sel = (...children: BtNode[]): BtNode =>
  withChildren(new SelectorNode(), children, 'sel');

/** Tick every child each step. Useful for "move *and* shoot". */
export const par = (
  successPolicy: ParallelPolicy,
  failurePolicy: ParallelPolicy,
  ...children: BtNode[]
): BtNode => withChildren(new ParallelNode(successPolicy, failurePolicy), children, 'par');

/** Weighted random branch, latched while it runs. */
export const randomSel = (weights: number[], ...children: BtNode[]): BtNode =>
  withChildren(new RandomSelectorNode(weights), children, 'random');

export const inv = (child: BtNode): BtNode =>
  withChildren(new InverterNode(), [child], 'inv');

export const succeed = (child: BtNode): BtNode =>
  withChildren(new SucceederNode(), [child], 'succeed');

export const fail = (child: BtNode): BtNode =>
  withChildren(new FailerNode(), [child], 'fail');

/** `times <= 0` repeats forever (until the child fails). */
export const repeat = (times: number, child: BtNode): BtNode =>
  withChildren(new RepeatNode(times), [child], 'repeat');

export const cooldown = (seconds: BtNumber, child: BtNode): BtNode =>
  withChildren(new CooldownNode(seconds), [child], 'cooldown');

export const guard = (cond: (c: BtContext) => boolean, child: BtNode): BtNode =>
  withChildren(new GuardNode(cond), [child], 'guard');

export const timeout = (seconds: BtNumber, child: BtNode): BtNode =>
  withChildren(new TimeoutNode(seconds), [child], 'timeout');

export const chance = (p: BtNumber, child: BtNode): BtNode =>
  withChildren(new ChanceNode(p), [child], 'chance');

export const action = (label: string, fn: (c: BtContext) => BtStatus): BtNode => {
  const n = new ActionNode(fn);
  n.label = label;
  return n;
};

export const cond = (label: string, fn: (c: BtContext) => boolean): BtNode => {
  const n = new ConditionNode(fn);
  n.label = label;
  return n;
};

export const wait = (seconds: BtNumber): BtNode => {
  const n = new WaitNode(seconds);
  n.label = 'wait';
  return n;
};

// ---------------------------------------------------------------------------
// Domain nodes — the vocabulary faction owners actually write with
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

// -- conditions --------------------------------------------------------------

export const isEngaged = (): BtNode =>
  cond('engaged', (c) => c.brain.percept.state === 'engaged');

export const isSearching = (): BtNode =>
  cond('searching', (c) => c.brain.percept.state === 'searching');

export const isSuspicious = (): BtNode =>
  cond('suspicious', (c) => c.brain.percept.state === 'suspicious');

export const isUnaware = (): BtNode =>
  cond('unaware', (c) => c.brain.percept.state === 'unaware');

export const hasLineOfSight = (): BtNode =>
  cond('los', (c) => c.brain.percept.hasLos && c.brain.percept.losAge < 0.35);

/** True when the target is inside `metres`. */
export const targetWithin = (metres: BtNumber): BtNode =>
  cond('within', (c) => {
    const d = c.brain.agent.position.distanceTo(c.host.target.centre);
    return d <= evalNumber(metres, c);
  });

/** True when the target is beyond `metres`. */
export const targetBeyond = (metres: BtNumber): BtNode =>
  cond('beyond', (c) => {
    const d = c.brain.agent.position.distanceTo(c.host.target.centre);
    return d > evalNumber(metres, c);
  });

export const healthBelow = (fraction: BtNumber): BtNode =>
  cond('hurt', (c) => {
    const a = c.brain.agent;
    return a.maxHealth > 0 && a.health / a.maxHealth < evalNumber(fraction, c);
  });

/** True when the squad brain gave this agent one of the listed orders. */
export const hasOrder = (...kinds: string[]): BtNode =>
  cond('order', (c) => kinds.indexOf(c.brain.order.kind) >= 0);

export const holdsAttackToken = (): BtNode =>
  cond('token', (c) => c.brain.hasToken);

/** True when the agent is standing in claimed cover. */
export const inCover = (): BtNode => cond('inCover', (c) => c.brain.agent.ai.inCover);

// -- movement ----------------------------------------------------------------

/**
 * Walk to an arbitrary point supplied by a callback. Returns RUNNING while
 * travelling, SUCCESS on arrival, FAILURE when the point is unreachable.
 * All the other movement nodes are thin wrappers around this one.
 */
export const moveTo = (
  point: BtPoint,
  arriveRadius: BtNumber = 1.2,
  speed: BtNumber = 0.75,
): BtNode =>
  action('moveTo', (c) => {
    if (!point(c, _p)) return FAILURE;
    const brain = c.brain;
    if (!c.host.pathTo(brain, _p)) return FAILURE;
    const r = evalNumber(arriveRadius, c);
    const dx = brain.agent.position.x - _p.x;
    const dz = brain.agent.position.z - _p.z;
    if (dx * dx + dz * dz <= r * r) return SUCCESS;
    c.host.followPath(brain, evalNumber(speed, c));
    // A genuinely stuck agent fails rather than grinding into geometry forever;
    // the selector above it then picks something else to do.
    if (brain.steer.stuckFor > 2.4) return FAILURE;
    return RUNNING;
  });

/** Close to the archetype's preferred range and stop there. */
export const advanceToRange = (range?: BtNumber, speed: BtNumber = 0.85): BtNode =>
  action('advance', (c) => {
    const brain = c.brain;
    const want = range === undefined ? brain.agent.archetype.preferredRange : evalNumber(range, c);
    const tgt = brain.percept.confidence > 0.25 ? brain.percept.lastKnown : c.host.target.centre;
    const dx = brain.agent.position.x - tgt.x;
    const dz = brain.agent.position.z - tgt.z;
    const d = Math.hypot(dx, dz);
    if (d <= want) return SUCCESS;
    // Aim for a point on the ring, not the target itself, so the agent stops
    // cleanly at range instead of overshooting and backing up.
    const t = clamp01((d - want) / Math.max(0.5, d));
    _p.set(tgt.x + dx * (1 - t), tgt.y, tgt.z + dz * (1 - t));
    if (!c.host.pathTo(brain, _p)) return FAILURE;
    c.host.followPath(brain, evalNumber(speed, c));
    return RUNNING;
  });

/**
 * Circle the target at the preferred radius. Never returns SUCCESS — it is a
 * "do this while nothing better exists" node, so put it last in a selector.
 */
export const strafeAtRange = (range?: BtNumber, speed: BtNumber = 0.62): BtNode =>
  action('strafe', (c) => {
    const brain = c.brain;
    const cmd = brain.cmd;
    const want = range === undefined ? brain.agent.archetype.preferredRange : evalNumber(range, c);
    const tgt = brain.percept.confidence > 0.2 ? brain.percept.lastKnown : c.host.target.centre;
    cmd.mode = 'orbit';
    cmd.target.copy(tgt);
    cmd.radius = want;
    // Flip when blocked or when a coin-flip timer expires, so the weave reads
    // as intentional footwork rather than a metronome.
    cmd.orbitSign = c.host.steering.updateStrafe(brain.steer, c.dt, brain.steer.stuck);
    cmd.speed = evalNumber(speed, c);
    cmd.facePoint.copy(tgt);
    cmd.faceValid = true;
    return RUNNING;
  });

/** Back away from the target, keeping it in view. */
export const retreatFrom = (distance: BtNumber = 14, speed: BtNumber = 0.9): BtNode =>
  action('retreat', (c) => {
    const brain = c.brain;
    const tgt = c.host.target.centre;
    const d = brain.agent.position.distanceTo(tgt);
    if (d >= evalNumber(distance, c)) return SUCCESS;
    brain.cmd.mode = 'flee';
    brain.cmd.target.copy(tgt);
    brain.cmd.speed = evalNumber(speed, c);
    brain.cmd.facePoint.copy(tgt);
    brain.cmd.faceValid = true;
    return RUNNING;
  });

/** Stand still. Facing is preserved; use `faceTarget` alongside if needed. */
export const holdPosition = (): BtNode =>
  action('hold', (c) => {
    c.brain.cmd.mode = 'stop';
    return RUNNING;
  });

/** Take the best cover point for the current threat and go there. */
export const takeCover = (
  maxTravel: BtNumber = 22,
  preferHigh = false,
  speed: BtNumber = 0.95,
): BtNode =>
  action('takeCover', (c) => {
    const brain = c.brain;
    const arch = brain.agent.archetype;
    let p = brain.cover;
    if (!p || p.claimedBy !== brain.agent.entityId) {
      p = c.host.cover.find({
        entityId: brain.agent.entityId,
        from: brain.agent.position,
        threat: c.host.target.eye,
        minRange: Math.max(2.5, arch.preferredRange * 0.35),
        maxRange: Math.max(8, arch.preferredRange * 1.7),
        maxTravel: evalNumber(maxTravel, c),
        preferHigh,
      });
      if (!p) return FAILURE;
      c.host.cover.claim(p, brain.agent.entityId);
      brain.cover = p;
    }
    // Horizontal distance only. The agent's `position` is its capsule *centre*,
    // roughly a metre above the cover point's ground-level position, so a 3D
    // test can never be satisfied and the unit walks to its cover forever.
    const cdx = brain.agent.position.x - p.position.x;
    const cdz = brain.agent.position.z - p.position.z;
    if (cdx * cdx + cdz * cdz <= 1.3 * 1.3) {
      brain.agent.ai.inCover = true;
      return SUCCESS;
    }
    if (!c.host.pathTo(brain, p.position)) {
      c.host.cover.release(brain.agent.entityId);
      brain.cover = null;
      return FAILURE;
    }
    c.host.followPath(brain, evalNumber(speed, c));
    if (brain.steer.stuckFor > 2.4) {
      c.host.cover.release(brain.agent.entityId);
      brain.cover = null;
      return FAILURE;
    }
    return RUNNING;
  });

/** Crouch in the held cover point for a while, peeking occasionally. */
export const holdCover = (seconds: BtNumber = 2.4): BtNode =>
  action('holdCover', (c) => {
    const brain = c.brain;
    const bb = brain.bb;
    const slot = c.nodeId;
    const p = brain.cover;
    if (!p) return FAILURE;
    brain.cmd.mode = 'arrive';
    brain.cmd.target.copy(p.position);
    brain.cmd.speed = 0.4;
    brain.cmd.crouch = true;
    brain.cmd.facePoint.copy(c.host.target.centre);
    brain.cmd.faceValid = true;
    brain.agent.ai.inCover = true;
    bb.nodeTimer[slot] += c.dt;
    if (bb.nodeTimer[slot] >= evalNumber(seconds, c)) {
      bb.nodeTimer[slot] = 0;
      brain.agent.ai.inCover = false;
      return SUCCESS;
    }
    return RUNNING;
  });

/** Leave cover and release the claim, so squadmates can rotate through it. */
export const leaveCover = (): BtNode =>
  action('leaveCover', (c) => {
    c.host.cover.release(c.brain.agent.entityId);
    c.brain.cover = null;
    c.brain.agent.ai.inCover = false;
    return SUCCESS;
  });

/** Swing wide to the target's left (-1) or right (+1). */
export const moveToFlank = (side: BtNumber = 1, radius?: BtNumber, speed: BtNumber = 1): BtNode =>
  action('flank', (c) => {
    const brain = c.brain;
    const r = radius === undefined ? brain.agent.archetype.preferredRange : evalNumber(radius, c);
    const s = evalNumber(side, c);
    if (!c.host.cover.findFlank(c.host.target.centre, brain.agent.position, s, r, _p)) {
      return FAILURE;
    }
    const dx = brain.agent.position.x - _p.x;
    const dz = brain.agent.position.z - _p.z;
    if (dx * dx + dz * dz < 2.2 * 2.2) return SUCCESS;
    if (!c.host.pathTo(brain, _p)) return FAILURE;
    c.host.followPath(brain, evalNumber(speed, c));
    if (brain.steer.stuckFor > 2.4) return FAILURE;
    return RUNNING;
  });

/**
 * Relocate to a fresh firing position with a clear shot. This is the node that
 * enforces "never stand still shooting in the open".
 */
export const repositionFiring = (spread: BtNumber = 9, speed: BtNumber = 0.8): BtNode =>
  action('reposition', (c) => {
    const brain = c.brain;
    const arch = brain.agent.archetype;
    if (
      !c.host.cover.findFiringPosition(
        c.host.target.centre,
        brain.agent.position,
        arch.preferredRange,
        evalNumber(spread, c),
        _p,
      )
    ) {
      return FAILURE;
    }
    const dx = brain.agent.position.x - _p.x;
    const dz = brain.agent.position.z - _p.z;
    if (dx * dx + dz * dz < 1.6 * 1.6) return SUCCESS;
    if (!c.host.pathTo(brain, _p)) return FAILURE;
    c.host.followPath(brain, evalNumber(speed, c));
    brain.cmd.facePoint.copy(c.host.target.centre);
    brain.cmd.faceValid = true;
    return RUNNING;
  });

/** Walk the squad's ordered destination. Succeeds on arrival. */
export const followOrder = (speed: BtNumber = 0.8): BtNode =>
  moveTo(
    (c, out) => {
      const o = c.brain.order;
      if (o.kind === 'idle') return false;
      out.copy(o.position);
      return true;
    },
    1.6,
    speed,
  );

/** Investigate the last known position, then look around. */
export const searchLastKnown = (speed: BtNumber = 0.7): BtNode =>
  action('search', (c) => {
    const brain = c.brain;
    const p = brain.percept;
    if (!p.searchValid) return FAILURE;
    const dx = brain.agent.position.x - p.searchPoint.x;
    const dz = brain.agent.position.z - p.searchPoint.z;
    if (dx * dx + dz * dz < 2.0 * 2.0) {
      // Arrived and found nothing: pick a new guess further out.
      c.host.perception.repickSearch(p);
      return SUCCESS;
    }
    if (!c.host.pathTo(brain, p.searchPoint)) {
      c.host.perception.repickSearch(p);
      return FAILURE;
    }
    c.host.followPath(brain, evalNumber(speed, c));
    if (brain.steer.stuckFor > 2.0) {
      c.host.perception.repickSearch(p);
      return FAILURE;
    }
    return RUNNING;
  });

/** Sweep the head across the area — the "looking for you" beat between moves. */
export const scanArea = (seconds: BtNumber = 1.8): BtNode =>
  action('scan', (c) => {
    const brain = c.brain;
    const bb = brain.bb;
    const slot = c.nodeId;
    bb.nodeTimer[slot] += c.dt;
    const t = bb.nodeTimer[slot];
    const total = evalNumber(seconds, c);
    brain.cmd.mode = 'stop';
    const sweep = Math.sin((t / Math.max(0.2, total)) * Math.PI * 2) * 1.15;
    const base = brain.percept.searchValid
      ? Math.atan2(
          brain.percept.searchPoint.x - brain.agent.position.x,
          brain.percept.searchPoint.z - brain.agent.position.z,
        )
      : brain.agent.ai.yaw;
    _p.set(
      brain.agent.position.x + Math.sin(base + sweep) * 10,
      brain.agent.position.y,
      brain.agent.position.z + Math.cos(base + sweep) * 10,
    );
    brain.cmd.facePoint.copy(_p);
    brain.cmd.faceValid = true;
    if (t >= total) {
      bb.nodeTimer[slot] = 0;
      return SUCCESS;
    }
    return RUNNING;
  });

/** Wander around the spawn anchor. The idle behaviour for unaware units. */
export const patrolArea = (radius: BtNumber = 12, speed: BtNumber = 0.35): BtNode =>
  action('patrol', (c) => {
    const brain = c.brain;
    const bb = brain.bb;
    const slot = c.nodeId;
    bb.nodeTimer[slot] -= c.dt;
    if (bb.nodeTimer[slot] <= 0 || !brain.moveGoalValid) {
      const r = evalNumber(radius, c);
      const ang = brain.steer.rng.next() * Math.PI * 2;
      const dist = Math.sqrt(brain.steer.rng.next()) * r;
      _p.set(
        brain.anchor.x + Math.sin(ang) * dist,
        brain.anchor.y,
        brain.anchor.z + Math.cos(ang) * dist,
      );
      if (!c.host.nav.snap(_p, _q, 6)) return FAILURE;
      brain.moveGoal.copy(_q);
      brain.moveGoalValid = true;
      bb.nodeTimer[slot] = 6 + brain.steer.rng.next() * 6;
    }
    const dx = brain.agent.position.x - brain.moveGoal.x;
    const dz = brain.agent.position.z - brain.moveGoal.z;
    if (dx * dx + dz * dz < 1.8 * 1.8) {
      brain.moveGoalValid = false;
      return SUCCESS;
    }
    if (!c.host.pathTo(brain, brain.moveGoal)) {
      brain.moveGoalValid = false;
      return FAILURE;
    }
    c.host.followPath(brain, evalNumber(speed, c));
    return RUNNING;
  });

/** Stand at the anchor facing outward. For sentries and boss-arena guards. */
export const guardAnchor = (radius: BtNumber = 3): BtNode =>
  action('guardAnchor', (c) => {
    const brain = c.brain;
    const gdx = brain.agent.position.x - brain.anchor.x;
    const gdz = brain.agent.position.z - brain.anchor.z;
    const d = Math.hypot(gdx, gdz);
    if (d > evalNumber(radius, c)) {
      if (!c.host.pathTo(brain, brain.anchor)) return FAILURE;
      c.host.followPath(brain, 0.5);
      return RUNNING;
    }
    brain.cmd.mode = 'stop';
    return SUCCESS;
  });

// -- combat ------------------------------------------------------------------

/** Turn the body and the aim onto the current best estimate of the target. */
export const faceTarget = (tolerance: BtNumber = 0.22): BtNode =>
  action('face', (c) => {
    const brain = c.brain;
    const p = brain.percept;
    const tgt = p.hasLos && p.losAge < 0.4 ? c.host.target.centre : p.lastKnown;
    brain.cmd.facePoint.copy(tgt);
    brain.cmd.faceValid = true;
    const dx = tgt.x - brain.agent.position.x;
    const dz = tgt.z - brain.agent.position.z;
    const want = Math.atan2(dx, dz);
    let diff = (want - brain.agent.ai.yaw) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff) <= evalNumber(tolerance, c) ? SUCCESS : RUNNING;
  });

/**
 * The wind-up. **Every** attack must go through one of these: the contract is a
 * visible pose and an audible tell for at least 0.35 s before damage exists.
 * The node clamps its own duration up to that floor so a species cannot
 * accidentally ship an unreactable attack.
 */
export const telegraph = (
  seconds: BtNumber = 0.45,
  attackId = 'attack',
  bark: AiBark | null = null,
): BtNode =>
  action('telegraph', (c) => {
    const brain = c.brain;
    const ai = brain.agent.ai;
    const total = Math.max(0.35, evalNumber(seconds, c));
    if (brain.windupTimer <= 0) {
      brain.windupDuration = total;
      ai.attackId = attackId;
      if (bark) c.host.bark(brain, bark);
    }
    brain.windupTouched = true;
    brain.windupTimer += c.dt;
    ai.windup = clamp01(brain.windupTimer / total);
    // Keep tracking during the wind-up, but slowly — that is what makes the
    // telegraph dodgeable instead of a homing missile.
    const tgt = brain.percept.hasLos ? c.host.target.centre : brain.percept.lastKnown;
    brain.cmd.facePoint.copy(tgt);
    brain.cmd.faceValid = true;
    brain.cmd.speed = 0.2;
    if (brain.windupTimer >= total) {
      brain.windupTimer = 0;
      ai.windup = 0;
      return SUCCESS;
    }
    return RUNNING;
  });

/**
 * Fire `count` shots at `interval`. Requires an attack token — wrap in
 * `withAttackToken` or the node fails immediately.
 */
export const fireBurst = (count: BtNumber = 3, interval?: BtNumber): BtNode =>
  action('fire', (c) => {
    const brain = c.brain;
    if (!brain.hasToken) return FAILURE;
    const p = brain.percept;
    if (!p.hasLos || p.losAge > 0.6) return FAILURE;
    const arch = brain.agent.archetype;
    const gap = interval === undefined ? arch.attackInterval : evalNumber(interval, c);
    brain.burstTouched = true;
    if (brain.burstLeft <= 0) {
      brain.burstLeft = Math.max(1, Math.round(evalNumber(count, c)));
      brain.burstTimer = 0;
    }
    brain.cmd.facePoint.copy(c.host.target.centre);
    brain.cmd.faceValid = true;
    brain.cmd.speed = 0.25;
    brain.burstTimer -= c.dt;
    if (brain.burstTimer <= 0) {
      c.host.fireAt(brain, c.host.target.centre);
      brain.burstLeft--;
      brain.burstTimer = Math.max(0.04, gap);
    }
    if (brain.burstLeft <= 0) {
      brain.burstLeft = 0;
      return SUCCESS;
    }
    return RUNNING;
  });

/** A single melee strike; deals its damage on the frame the wind-up completes. */
export const meleeStrike = (reach: BtNumber = 2.4, windup: BtNumber = 0.4): BtNode =>
  seq(
    cond('inReach', (c) => {
      const d = c.brain.agent.position.distanceTo(c.host.target.centre);
      return d <= evalNumber(reach, c) + 0.6;
    }),
    faceTarget(0.35),
    telegraph(windup, 'melee', 'charge'),
    action('strike', (c) => {
      const d = c.brain.agent.position.distanceTo(c.host.target.centre);
      if (d <= evalNumber(reach, c) + 0.5) c.host.fireAt(c.brain, c.host.target.centre);
      return SUCCESS;
    }),
  );

/** A telegraphed pounce. Big commitment, big tell, big payoff. */
export const leapAt = (
  minRange: BtNumber = 5,
  maxRange: BtNumber = 15,
  height: BtNumber = 3.2,
): BtNode =>
  seq(
    cond('leapRange', (c) => {
      const d = c.brain.agent.position.distanceTo(c.host.target.centre);
      return d >= evalNumber(minRange, c) && d <= evalNumber(maxRange, c) && c.brain.steer.grounded;
    }),
    faceTarget(0.3),
    telegraph(0.5, 'leap', 'charge'),
    action('leap', (c) => {
      const brain = c.brain;
      brain.cmd.leap = true;
      brain.cmd.leapTarget.copy(c.host.target.centre);
      brain.cmd.leapHeight = evalNumber(height, c);
      brain.agent.ai.leap = true;
      return SUCCESS;
    }),
    action('land', (c) => (c.brain.steer.leaping ? RUNNING : SUCCESS)),
  );

/**
 * Gate a subtree on the shared attack-token pool. Only a handful of agents hold
 * tokens at once, so the player is never shot at by the whole arena — the
 * single most important trick for making a big fight feel fair.
 */
export const withAttackToken = (child: BtNode): BtNode =>
  withChildren(new TokenNode(), [child], 'token');

class TokenNode extends BtNode {
  override tick(c: BtContext): BtStatus {
    const brain = c.brain;
    if (!brain.hasToken && !c.host.requestToken(brain)) return FAILURE;
    const s = this.children[0].tick(c);
    if (s !== RUNNING) c.host.releaseToken(brain);
    return s;
  }

  override reset(c: BtContext): void {
    if (c.brain.hasToken) c.host.releaseToken(c.brain);
    super.reset(c);
  }
}

/** Emit a vocalisation. The enemy owner turns this into a synthesised bark. */
export const bark = (id: AiBark): BtNode =>
  action('bark', (c) => {
    c.host.bark(c.brain, id);
    return SUCCESS;
  });

/** Elites use this to pull another squad in. Fails when the budget is full. */
export const callReinforcements = (): BtNode =>
  action('reinforce', (c) => (c.host.requestReinforcements(c.brain) ? SUCCESS : FAILURE));

/** Set the AI state label the animation and debug layers read. */
export const setState = (state: string): BtNode =>
  action('setState', (c) => {
    c.brain.agent.ai.state = state as typeof c.brain.agent.ai.state;
    return SUCCESS;
  });

/** Scale the pace of whatever movement node runs after it, this tick. */
export const pace = (speed: BtNumber): BtNode =>
  action('pace', (c) => {
    c.brain.cmd.speed = clamp(evalNumber(speed, c), 0, 1);
    return SUCCESS;
  });
