/**
 * Steering — the layer between "the AI decided to go there" and "a body moved".
 *
 * Behaviour trees produce *intent* (a `SteerCommand`); this file turns intent
 * into an acceleration, resolves it against the world through `resolveCapsule`,
 * and guarantees the three things that separate a convincing crowd from a
 * shambling one:
 *
 *  1. **Nothing stacks.** Separation is applied before the world is resolved, so
 *     two enemies never occupy one silhouette. This is checked by the harness:
 *     no pair may sit closer than 0.8× their summed radii for over half a second.
 *  2. **Nothing jitters.** The steering direction is exponentially smoothed, the
 *     desired velocity has a dead-zone, and arrival uses a slowing radius rather
 *     than a hard stop. Agents settle instead of buzzing.
 *  3. **Nothing walks into a wall forever.** Whisker rays (round-robin budgeted)
 *     produce an avoidance vector, and a contacted wall converts the desire into
 *     a tangential slide — wall hugging — rather than a stall.
 */
import * as THREE from 'three';
import type { CollisionWorld, FrameContext } from '@/types';
import { clamp, clamp01, damp, lerp, Rng } from '@/util/math';
import { GRAVITY } from '@/gameplay/Physics';
import type { AiAgent } from './AiDirector';

export type SteerMode = 'stop' | 'seek' | 'arrive' | 'flee' | 'orbit' | 'path';

export const STEER = {
  /** Slowing radius for `arrive`, metres. */
  arriveRadius: 2.2,
  /** Inside this, the agent is "there" and stops asking for speed. */
  stopRadius: 0.55,
  /** Separation ramps in below this multiple of the summed capsule radii. */
  separationScale: 3.0,
  /** Peak separation acceleration, m/s². */
  separationForce: 26,
  /** Whisker probe length, metres. */
  whiskerLength: 2.6,
  /** Whisker spread from the movement direction, radians. */
  whiskerAngle: 0.62,
  /** How many simulation steps between whisker probes for one agent. */
  whiskerPeriod: 4,
  /** Avoidance vector decay per second between probes. */
  avoidDecay: 5.5,
  /** Steering direction smoothing rate, 1/s. Higher = snappier, lower = floatier. */
  smoothRate: 14,
  /** Ground acceleration as a multiple of walk speed, 1/s. */
  accelGround: 7.5,
  accelAir: 1.6,
  /** Braking deceleration multiple when no movement is wanted. */
  brake: 9,
  /** Below this desired speed the agent simply stops — kills micro-jitter. */
  speedDeadzone: 0.28,
  /** Body yaw slew rate, radians/s. */
  turnRate: 6.2,
  /** Aim slew rate, radians/s — faster than the body, so they track while turning. */
  aimRate: 9.5,
  /** Seconds of near-zero progress before the agent is considered stuck. */
  stuckTime: 0.75,
  /** Metres of progress in that window that counts as "moving". */
  stuckDistance: 0.25,
  /** Minimum seconds between strafe direction flips. */
  strafeHold: 1.6,
  /** Hover spring for flying units, 1/s. */
  hoverRate: 3.2,
  /** Largest positional correction one agent may receive per step, metres. */
  maxDepenetration: 0.055,
} as const;

/** Intent written by behaviour-tree actions, consumed once per step. */
export interface SteerCommand {
  mode: SteerMode;
  /** Move goal for seek/arrive/flee, or the orbit centre. */
  readonly target: THREE.Vector3;
  /** Preferred standoff radius when orbiting. */
  radius: number;
  /** +1 or -1; which way around the orbit. */
  orbitSign: number;
  /** 0..1 pace. 0.5 is the archetype's walk, 1 its sprint. */
  speed: number;
  /** World point the body/aim should face. */
  readonly facePoint: THREE.Vector3;
  faceValid: boolean;
  /** Set true for one step to launch a leap toward `leapTarget`. */
  leap: boolean;
  readonly leapTarget: THREE.Vector3;
  /** Peak height of the requested leap above the launch point. */
  leapHeight: number;
  /** Crouch behind cover — lowers the eye and the silhouette. */
  crouch: boolean;
  /** Hover height above ground for flying archetypes. */
  hoverHeight: number;
}

export function createSteerCommand(): SteerCommand {
  return {
    mode: 'stop',
    target: new THREE.Vector3(),
    radius: 6,
    orbitSign: 1,
    speed: 0.5,
    facePoint: new THREE.Vector3(),
    faceValid: false,
    leap: false,
    leapTarget: new THREE.Vector3(),
    leapHeight: 2.2,
    crouch: false,
    hoverHeight: 3.5,
  };
}

export function resetSteerCommand(c: SteerCommand): void {
  c.mode = 'stop';
  c.speed = 0.5;
  c.faceValid = false;
  c.leap = false;
  c.crouch = false;
}

/** Per-agent steering memory. Pooled for the agent's lifetime. */
export interface SteerState {
  entityId: number;
  readonly separation: THREE.Vector3;
  readonly avoid: THREE.Vector3;
  readonly smoothDir: THREE.Vector3;
  readonly lastProgressPos: THREE.Vector3;
  progressTimer: number;
  stuck: boolean;
  stuckFor: number;
  whiskerPhase: number;
  grounded: boolean;
  airborne: number;
  leaping: boolean;
  leapTimer: number;
  strafeSign: number;
  strafeTimer: number;
  /** Smoothed locomotion magnitude, 0..1, for animation blending. */
  locomotion: number;
  /** Smoothed lateral component, -1..1. */
  strafeBlend: number;
  wallContact: number;
  readonly wallNormal: THREE.Vector3;
  /** Set by `resolveOverlaps` when this agent was pushed; forces a capsule
   *  resolve on the same step so a shove cannot leave it inside a wall. */
  depenetrated: boolean;
  /** Accumulated depenetration for this step, applied once and capped. */
  pushX: number;
  pushZ: number;
  rng: Rng;
}

export function createSteerState(entityId: number): SteerState {
  return {
    entityId,
    separation: new THREE.Vector3(),
    avoid: new THREE.Vector3(),
    smoothDir: new THREE.Vector3(),
    lastProgressPos: new THREE.Vector3(),
    progressTimer: 0,
    stuck: false,
    stuckFor: 0,
    whiskerPhase: (entityId * 7) % STEER.whiskerPeriod,
    grounded: true,
    airborne: 0,
    leaping: false,
    leapTimer: 0,
    strafeSign: entityId % 2 === 0 ? 1 : -1,
    strafeTimer: 0,
    locomotion: 0,
    strafeBlend: 0,
    wallContact: 0,
    wallNormal: new THREE.Vector3(),
    depenetrated: false,
    pushX: 0,
    pushZ: 0,
    rng: new Rng(0x9e37 + entityId * 40503),
  };
}

const _desired = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _probeDir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _zero = new THREE.Vector3();

/**
 * Shared steering solver. One instance lives on the director; agents pass their
 * own `SteerState`, so nothing here holds per-agent memory.
 */
export class Steering {
  world: CollisionWorld | null = null;
  /**
   * "Is this world XZ a place an agent may stand?" — supplied by the director
   * from the nav grid. Steering modes like `orbit` and `flee` produce a
   * direction rather than a route, so without this an enemy will happily strafe
   * under a low overhang or into a gap the navigation layer already rejected,
   * and then need rescuing. Probing one cell ahead is far cheaper than the
   * rescue.
   */
  onNav: ((x: number, z: number) => boolean) | null = null;
  /** Rays cast this step, exposed for the perf harness. */
  raysCast = 0;
  private whiskerTick = 0;

  /**
   * O(n²) pairwise separation. With `enemyBudget` capped at 44 that is under a
   * thousand distance tests per step — cheaper than maintaining a spatial hash,
   * and with no buckets to allocate.
   */
  computeSeparation(agents: readonly AiAgent[], states: Map<number, SteerState>): void {
    for (let i = 0; i < agents.length; i++) {
      const s = states.get(agents[i].entityId);
      if (s) s.separation.set(0, 0, 0);
    }
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.isDead) continue;
      const sa = states.get(a.entityId);
      if (!sa) continue;
      const ra = a.archetype.capsuleRadius;
      for (let j = i + 1; j < agents.length; j++) {
        const b = agents[j];
        if (b.isDead) continue;
        const rb = b.archetype.capsuleRadius;
        const want = (ra + rb) * STEER.separationScale;
        const dx = a.position.x - b.position.x;
        const dz = a.position.z - b.position.z;
        const dy = a.position.y - b.position.y;
        // Ignore agents on a different floor — no point shoving through a ceiling.
        if (dy > 3 || dy < -3) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 >= want * want) continue;
        const d = Math.sqrt(d2);
        const sb = states.get(b.entityId);
        // Deterministic tie-break when perfectly co-located, so two agents never
        // push along the same axis and lock together.
        let nx: number;
        let nz: number;
        if (d < 1e-4) {
          const ang = ((a.entityId * 2654435761) % 1024) / 1024 * Math.PI * 2;
          nx = Math.cos(ang);
          nz = Math.sin(ang);
        } else {
          nx = dx / d;
          nz = dz / d;
        }
        // Quadratic ramp: gentle at the edge of personal space, firm on contact.
        const t = 1 - d / want;
        const force = STEER.separationForce * t * t;
        sa.separation.x += nx * force;
        sa.separation.z += nz * force;
        if (sb) {
          sb.separation.x -= nx * force;
          sb.separation.z -= nz * force;
        }
      }
    }
  }

  /**
   * Hard depenetration pass, run after every agent has moved.
   *
   * The soft separation force above handles ordinary crowding, but it loses to
   * a strong seek when several agents want the same doorway, and losing looks
   * like two enemies sharing one silhouette. This pass is the guarantee: any
   * pair still interpenetrating is pushed apart geometrically, split evenly,
   * with the correction rate-limited so it reads as jostling rather than as a
   * teleport. Anything shoved into a wall is pulled back out by the capsule
   * resolve on the following step.
   */
  resolveOverlaps(agents: readonly AiAgent[], states: Map<number, SteerState>): void {
    for (let i = 0; i < agents.length; i++) {
      const st = states.get(agents[i].entityId);
      if (st) {
        st.pushX = 0;
        st.pushZ = 0;
      }
    }
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.isDead) continue;
      const sa = states.get(a.entityId);
      if (!sa) continue;
      const ra = a.archetype.capsuleRadius;
      for (let j = i + 1; j < agents.length; j++) {
        const b = agents[j];
        if (b.isDead) continue;
        const sb = states.get(b.entityId);
        const rb = b.archetype.capsuleRadius;
        const contact = ra + rb;
        const dy = a.position.y - b.position.y;
        const reach = a.archetype.capsuleHalfHeight + b.archetype.capsuleHalfHeight + contact;
        if (dy > reach || -dy > reach) continue;
        const dx = a.position.x - b.position.x;
        const dz = a.position.z - b.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= contact * contact) continue;
        const d = Math.sqrt(d2);
        let nx: number;
        let nz: number;
        if (d < 1e-4) {
          const ang = ((((a.entityId * 2654435761) >>> 0) % 1024) / 1024) * Math.PI * 2;
          nx = Math.cos(ang);
          nz = Math.sin(ang);
        } else {
          nx = dx / d;
          nz = dz / d;
        }
        const push = (contact - d) * 0.5;
        sa.pushX += nx * push;
        sa.pushZ += nz * push;
        if (sb) {
          sb.pushX -= nx * push;
          sb.pushZ -= nz * push;
        }
        // Cancel the closing velocity so they stop trying to re-merge.
        const closing = (a.velocity.x - b.velocity.x) * nx + (a.velocity.z - b.velocity.z) * nz;
        if (closing < 0) {
          a.velocity.x -= nx * closing * 0.5;
          a.velocity.z -= nz * closing * 0.5;
          b.velocity.x += nx * closing * 0.5;
          b.velocity.z += nz * closing * 0.5;
        }
      }
    }
    // Apply once, with the TOTAL displacement capped. Applying each pair's push
    // as it is found lets an agent surrounded by five squadmates move a quarter
    // of a metre in one step, which is enough to shove it through a wall's
    // collision margin — after which the capsule solver, which depenetrates
    // toward the nearest surface point, happily keeps it there.
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.isDead) continue;
      const st = states.get(a.entityId);
      if (!st) continue;
      const mag = Math.hypot(st.pushX, st.pushZ);
      if (mag < 1e-5) continue;
      const scale = Math.min(1, STEER.maxDepenetration / mag);
      a.position.x += st.pushX * scale;
      a.position.z += st.pushZ * scale;
      st.depenetrated = true;
    }
  }

  /** Advance the round-robin whisker cursor once per simulation step. */
  beginStep(): void {
    this.whiskerTick = (this.whiskerTick + 1) % STEER.whiskerPeriod;
    this.raysCast = 0;
  }

  /**
   * Move one agent. Returns the horizontal speed achieved, which the caller
   * feeds to animation.
   */
  apply(agent: AiAgent, cmd: SteerCommand, st: SteerState, ctx: FrameContext): number {
    const world = this.world;
    const dt = ctx.dt;
    const arch = agent.archetype;
    const pos = agent.position;
    const vel = agent.velocity;

    // -- desired velocity ----------------------------------------------------
    _desired.set(0, 0, 0);
    const walk = arch.moveSpeed;
    const sprint = Math.max(arch.sprintSpeed, arch.moveSpeed);
    const pace =
      cmd.speed <= 0.5
        ? lerp(walk * 0.42, walk, clamp01(cmd.speed * 2))
        : lerp(walk, sprint, clamp01((cmd.speed - 0.5) * 2));

    switch (cmd.mode) {
      case 'seek': {
        _dir.set(cmd.target.x - pos.x, 0, cmd.target.z - pos.z);
        const d = _dir.length();
        if (d > 1e-4) _desired.copy(_dir).multiplyScalar(pace / d);
        break;
      }
      case 'arrive': {
        _dir.set(cmd.target.x - pos.x, 0, cmd.target.z - pos.z);
        const d = _dir.length();
        if (d > STEER.stopRadius) {
          const scale = d < STEER.arriveRadius ? d / STEER.arriveRadius : 1;
          _desired.copy(_dir).multiplyScalar((pace * scale) / d);
        }
        break;
      }
      case 'flee': {
        _dir.set(pos.x - cmd.target.x, 0, pos.z - cmd.target.z);
        const d = _dir.length();
        if (d > 1e-4) _desired.copy(_dir).multiplyScalar(pace / d);
        break;
      }
      case 'orbit': {
        // Strafe at a preferred radius: a radial term that corrects the standoff
        // plus a tangential term that circles. This is what stops enemies from
        // standing in the open trading shots.
        _dir.set(pos.x - cmd.target.x, 0, pos.z - cmd.target.z);
        const d = _dir.length();
        if (d > 1e-4) {
          _dir.multiplyScalar(1 / d);
          _tan.set(-_dir.z * cmd.orbitSign, 0, _dir.x * cmd.orbitSign);
          const err = clamp((d - cmd.radius) / Math.max(2, cmd.radius * 0.5), -1, 1);
          _desired
            .copy(_tan)
            .multiplyScalar(1 - Math.abs(err) * 0.55)
            .addScaledVector(_dir, -err);
          const l = _desired.length();
          if (l > 1e-4) _desired.multiplyScalar(pace / l);
        }
        break;
      }
      case 'path':
      case 'stop':
      default:
        break;
    }

    // -- avoidance ------------------------------------------------------------
    this.probeWhiskers(agent, st, _desired, dt);
    _desired.add(st.avoid);
    // Separation is deliberately NOT folded in here: it is an acceleration, and
    // pushing it through the desired-velocity path scales it by dt twice and
    // then lets the dead-zone swallow it entirely — which is exactly how a
    // stationary group ends up fused into one silhouette. It is integrated
    // straight into the velocity further down.
    const sepMag = Math.hypot(st.separation.x, st.separation.z);

    // Wall hugging: project the desire onto the contacted wall so the agent
    // slides along cover instead of grinding into it.
    if (st.wallContact > 0) {
      st.wallContact -= dt;
      const into = _desired.x * st.wallNormal.x + _desired.z * st.wallNormal.z;
      if (into < 0) {
        _desired.x -= st.wallNormal.x * into;
        _desired.z -= st.wallNormal.z * into;
      }
    }

    // Keep the desire on navigable ground.
    if (this.onNav && !arch.flying) {
      const dl = Math.hypot(_desired.x, _desired.z);
      if (dl > 1e-3) {
        const ahead = arch.capsuleRadius + 0.45;
        const ux = _desired.x / dl;
        const uz = _desired.z / dl;
        if (!this.onNav(pos.x + ux * ahead, pos.z + uz * ahead)) {
          // Slide along the boundary instead of stopping dead at it: try
          // progressively wider deflections either side and take the first that
          // is clear, preferring the side the agent is already turning toward.
          let found = false;
          for (let k = 1; k <= 3 && !found; k++) {
            const ang = k * 0.55;
            for (let sgn = 0; sgn < 2 && !found; sgn++) {
              const a = sgn === 0 ? ang * st.strafeSign : -ang * st.strafeSign;
              const ca = Math.cos(a);
              const sa = Math.sin(a);
              const rx = ux * ca - uz * sa;
              const rz = ux * sa + uz * ca;
              if (this.onNav(pos.x + rx * ahead, pos.z + rz * ahead)) {
                _desired.x = rx * dl;
                _desired.z = rz * dl;
                found = true;
              }
            }
          }
          if (!found) _desired.set(0, 0, 0);
        }
      }
    }

    // Clamp back to the pace so avoidance cannot make an agent sprint.
    const wantSpeed = Math.hypot(_desired.x, _desired.z);
    if (wantSpeed > pace && wantSpeed > 1e-4) {
      _desired.x *= pace / wantSpeed;
      _desired.z *= pace / wantSpeed;
    }

    // -- smoothing + dead-zone ----------------------------------------------
    const finalSpeed = Math.hypot(_desired.x, _desired.z);
    if (finalSpeed < STEER.speedDeadzone) {
      _desired.set(0, 0, 0);
    } else {
      st.smoothDir.x = damp(st.smoothDir.x, _desired.x / finalSpeed, STEER.smoothRate, dt);
      st.smoothDir.z = damp(st.smoothDir.z, _desired.z / finalSpeed, STEER.smoothRate, dt);
      const sl = Math.hypot(st.smoothDir.x, st.smoothDir.z);
      if (sl > 1e-4) {
        _desired.x = (st.smoothDir.x / sl) * finalSpeed;
        _desired.z = (st.smoothDir.z / sl) * finalSpeed;
      }
    }

    // -- integrate -----------------------------------------------------------
    const grounded = st.grounded;
    const accelRate = (grounded ? STEER.accelGround : STEER.accelAir) * walk;
    const brakeRate = STEER.brake * walk;

    if (_desired.lengthSq() > 1e-6) {
      _delta.set(_desired.x - vel.x, 0, _desired.z - vel.z);
      const dl = _delta.length();
      const maxDelta = accelRate * dt;
      if (dl > maxDelta) _delta.multiplyScalar(maxDelta / dl);
      vel.x += _delta.x;
      vel.z += _delta.z;
    } else if (grounded && !st.leaping && sepMag < 3) {
      // Braking is suppressed while being shoved apart, or friction would win
      // the argument and the pair would stay merged.
      const h = Math.hypot(vel.x, vel.z);
      if (h > 1e-4) {
        const drop = Math.min(h, brakeRate * dt);
        vel.x -= (vel.x / h) * drop;
        vel.z -= (vel.z / h) * drop;
      }
    }

    if (sepMag > 1e-4) {
      vel.x += st.separation.x * dt;
      vel.z += st.separation.z * dt;
      const h = Math.hypot(vel.x, vel.z);
      const cap = sprint * 1.3;
      if (h > cap) {
        vel.x *= cap / h;
        vel.z *= cap / h;
      }
    }

    // -- leap ----------------------------------------------------------------
    if (cmd.leap && grounded && !st.leaping) {
      const h = Math.max(0.6, cmd.leapHeight);
      const vy = Math.sqrt(2 * GRAVITY * h);
      const flight = (2 * vy) / GRAVITY;
      _dir.set(cmd.leapTarget.x - pos.x, 0, cmd.leapTarget.z - pos.z);
      const d = _dir.length();
      if (d > 1e-3) {
        _dir.multiplyScalar(Math.min(sprint * 2.2, d / Math.max(0.25, flight)) / d);
        vel.x = _dir.x;
        vel.z = _dir.z;
      }
      vel.y = vy;
      st.leaping = true;
      st.leapTimer = 0;
      st.grounded = false;
    }
    if (st.leaping) {
      st.leapTimer += dt;
      if (st.grounded && st.leapTimer > 0.18) st.leaping = false;
      if (st.leapTimer > 3) st.leaping = false;
    }

    // -- world resolution ----------------------------------------------------
    if (arch.flying) {
      vel.y = damp(vel.y, 0, 3, dt);
      if (world) {
        const g = world.sampleGround(pos.x, pos.z);
        if (g) {
          const wanted = g.y + cmd.hoverHeight;
          vel.y += (wanted - pos.y) * STEER.hoverRate * dt;
        }
      }
      vel.y = clamp(vel.y, -8, 8);
    } else {
      vel.y -= GRAVITY * dt;
      if (vel.y < -60) vel.y = -60;
    }

    if (world) {
      // `depenetrated` forces a resolve even for a perfectly still agent: it was
      // just pushed by a squadmate and may now be a few centimetres inside a
      // wall, which the capsule solver cannot recover from once it is deep.
      const moving =
        st.depenetrated ||
        Math.abs(vel.x) > 1e-3 ||
        Math.abs(vel.z) > 1e-3 ||
        Math.abs(vel.y) > 1e-3;
      st.depenetrated = false;
      if (moving) {
        const r = world.resolveCapsule(pos, arch.capsuleRadius, arch.capsuleHalfHeight, vel, dt);
        st.grounded = arch.flying ? true : r.grounded;
        if (r.grounded) st.airborne = 0;
        else st.airborne += dt;
        if (r.touchedWall) {
          st.wallContact = 0.25;
          st.wallNormal.copy(r.wallNormal);
          st.wallNormal.y = 0;
          const wl = st.wallNormal.length();
          if (wl > 1e-4) st.wallNormal.multiplyScalar(1 / wl);
          else st.wallContact = 0;
        }
      }
    }

    // Guard against a NaN escaping into the scene graph. If physics ever hands
    // back garbage, freeze the agent rather than teleporting it to infinity.
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      pos.copy(st.lastProgressPos);
      vel.set(0, 0, 0);
    }
    if (!Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z)) {
      vel.set(0, 0, 0);
    }

    // -- stuck detection -----------------------------------------------------
    st.progressTimer += dt;
    if (st.progressTimer >= STEER.stuckTime) {
      const moved = st.lastProgressPos.distanceTo(pos);
      const wanted = _desired.lengthSq() > 1e-6;
      st.stuck = wanted && moved < STEER.stuckDistance;
      st.stuckFor = st.stuck ? st.stuckFor + st.progressTimer : 0;
      st.lastProgressPos.copy(pos);
      st.progressTimer = 0;
    }

    // -- facing --------------------------------------------------------------
    const speed = Math.hypot(vel.x, vel.z);
    let faceYaw = agent.ai.yaw;
    if (cmd.faceValid) {
      faceYaw = Math.atan2(cmd.facePoint.x - pos.x, cmd.facePoint.z - pos.z);
    } else if (speed > 0.4) {
      faceYaw = Math.atan2(vel.x, vel.z);
    }
    agent.ai.yaw = slewAngle(agent.ai.yaw, faceYaw, STEER.turnRate * dt);

    // Locomotion + strafe blends for the animation layer.
    const norm = clamp01(speed / Math.max(0.5, sprint));
    st.locomotion = damp(st.locomotion, norm, 10, dt);
    const cy = Math.cos(agent.ai.yaw);
    const sy = Math.sin(agent.ai.yaw);
    const lateral = speed > 0.05 ? (vel.x * cy - vel.z * sy) / Math.max(0.5, sprint) : 0;
    st.strafeBlend = damp(st.strafeBlend, clamp(lateral, -1, 1), 10, dt);
    agent.ai.locomotion = st.locomotion;
    agent.ai.strafe = st.strafeBlend;
    agent.ai.grounded = st.grounded;
    agent.ai.speed = speed;

    return speed;
  }

  /**
   * Three forward whiskers, refreshed every `whiskerPeriod` steps per agent and
   * decayed in between. Budgeting this way keeps ray traffic near 30 per step
   * for a full arena instead of 120.
   */
  private probeWhiskers(agent: AiAgent, st: SteerState, desired: THREE.Vector3, dt: number): void {
    const world = this.world;
    const decay = Math.exp(-STEER.avoidDecay * dt);
    st.avoid.multiplyScalar(decay);
    if (!world) return;
    if (st.whiskerPhase !== this.whiskerTick) return;
    const speed = Math.hypot(desired.x, desired.z);
    if (speed < 0.2) return;

    const arch = agent.archetype;
    _origin.set(agent.position.x, agent.position.y, agent.position.z);
    const baseAngle = Math.atan2(desired.x, desired.z);
    const reach = STEER.whiskerLength + arch.capsuleRadius;
    let ax = 0;
    let az = 0;

    for (let k = -1; k <= 1; k++) {
      const ang = baseAngle + k * STEER.whiskerAngle;
      _probeDir.set(Math.sin(ang), 0, Math.cos(ang));
      const len = k === 0 ? reach : reach * 0.7;
      this.raysCast++;
      const hit = world.raycast(_origin, _probeDir, len);
      if (!hit) continue;
      // Push away from the surface, weighted by how close the obstruction is and
      // how central the whisker was.
      const t = 1 - hit.distance / len;
      const weight = (k === 0 ? 1.5 : 1) * t * t;
      _probe.copy(hit.normal);
      _probe.y = 0;
      const nl = _probe.length();
      if (nl < 1e-4) continue;
      _probe.multiplyScalar(1 / nl);
      ax += _probe.x * weight;
      az += _probe.z * weight;
      // A tangential nudge turns "stop at the wall" into "walk around it".
      ax += -_probeDir.z * weight * 0.85 * (k === 0 ? st.strafeSign : -k);
      az += _probeDir.x * weight * 0.85 * (k === 0 ? st.strafeSign : -k);
    }

    const l = Math.hypot(ax, az);
    if (l > 1e-4) {
      const mag = Math.min(1, l) * arch.moveSpeed * 0.9;
      st.avoid.x = (ax / l) * mag;
      st.avoid.z = (az / l) * mag;
    }
  }

  /** Flip the strafe direction on a cooldown so agents weave without twitching. */
  updateStrafe(st: SteerState, dt: number, wantFlip: boolean): number {
    st.strafeTimer += dt;
    if ((wantFlip || st.stuck) && st.strafeTimer >= STEER.strafeHold) {
      st.strafeSign = -st.strafeSign;
      st.strafeTimer = 0;
    } else if (st.strafeTimer >= STEER.strafeHold * 2.6 && st.rng.bool(0.35)) {
      st.strafeSign = -st.strafeSign;
      st.strafeTimer = 0;
    }
    return st.strafeSign;
  }

  /**
   * Re-seat a depenetrated agent against the static world, with a zero step so
   * `resolveCapsule` performs push-out only.
   *
   * This has to happen in the same step as the push. Deferring it to the next
   * step's ordinary resolve measurably leaves bodies inside walls: an agent
   * squeezed between a squadmate and a wall is shoved again every step, so the
   * error compounds faster than one resolve per step can undo it.
   */
  settle(agent: AiAgent, st: SteerState): void {
    if (!st.depenetrated || !this.world) return;
    st.depenetrated = false;
    _zero.set(0, 0, 0);
    this.world.resolveCapsule(
      agent.position,
      agent.archetype.capsuleRadius,
      agent.archetype.capsuleHalfHeight,
      _zero,
      0,
    );
  }

  /** Slew the aim angles toward a world point. Returns the residual error. */
  aimAt(agent: AiAgent, point: THREE.Vector3, dt: number, rate = STEER.aimRate): number {
    const pos = agent.position;
    const dx = point.x - pos.x;
    const dz = point.z - pos.z;
    const horiz = Math.hypot(dx, dz);
    const targetYaw = Math.atan2(dx, dz);
    const eyeY = pos.y - agent.archetype.capsuleHalfHeight
      - agent.archetype.capsuleRadius + agent.archetype.eyeHeight;
    const targetPitch = Math.atan2(point.y - eyeY, Math.max(0.05, horiz));
    const before = Math.abs(angleDiff(agent.ai.aimYaw, targetYaw));
    agent.ai.aimYaw = slewAngle(agent.ai.aimYaw, targetYaw, rate * dt);
    agent.ai.aimPitch = clamp(
      agent.ai.aimPitch + clamp(targetPitch - agent.ai.aimPitch, -rate * dt, rate * dt),
      -1.2,
      1.2,
    );
    return before;
  }
}

/** Shortest-arc angle difference, (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move `a` toward `b` by at most `maxDelta` radians, taking the short way. */
export function slewAngle(a: number, b: number, maxDelta: number): number {
  const d = angleDiff(a, b);
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}
