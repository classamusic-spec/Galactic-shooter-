/**
 * EnemyAgent — one living enemy, and the species contract the faction owners
 * implement.
 *
 * ## Adding a species (the whole job, in one place)
 *
 * ```ts
 * EnemyManager.register({
 *   archetype: ARCHETYPES['nordic.warrior'],       // every field filled
 *   build(ctx) {                                   // called ONCE per species
 *     const rig = ctx.rig;                         // see Rig.ts for the conventions
 *     rig.chain('spine', ['hips','chest','neck','head'], [0.3,0.26,0.16],
 *               { origin: v(0,1.0,0), direction: UP, kind: 'spine' });
 *     rig.chain('leg.L', ['hip','knee','ankle','toe'], [0.46,0.44,0.15],
 *               { parent: 'spine.hips', origin: v(0.17,0,0), direction: DOWN,
 *                 kind: 'leg', side: -1, restBend: [0.06,-0.2,0.14] });
 *     // ... geometry via ctx.builder ...
 *     return { rig, parts: ctx.builder.finish(), height: 1.9,
 *              headBone: 'spine.head', hitProxies: [...] };
 *   },
 *   behaviour(ctx) { return standardCombatBehaviour(ARCHETYPES['nordic.warrior']); },
 *   animate(agent, ctx) { }, // optional: species flourishes on top of the base pass
 * });
 * ```
 *
 * `build()` runs once and its geometry + skin weights are shared by every
 * instance; `behaviour()` runs once **per agent**, so behaviour nodes may hold
 * plain per-agent state with no bookkeeping. `animate()` runs after the base
 * animation pass and may pose any bone the base pass did not claim.
 *
 * ## What the framework guarantees you
 *
 * - `agent.position` is the ground-contact point; `agent.velocity` is world m/s.
 * - `agent.ai` is a blackboard the AI director and your behaviour tree share.
 * - Hit proxies track the animated skeleton, so headshots hit the actual head.
 * - Damage, shields, death, ragdoll, dissolve, gibs and loot are handled for you.
 *   Your behaviour tree only decides where to go and when to attack.
 */
import * as THREE from 'three';
import type {
  CollisionWorld,
  Damageable,
  DamageElement,
  DamageInfo,
  EnemyArchetype,
  FactionId,
  HitRegion,
  RaycastHit,
} from '@/types';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { clamp, clamp01, damp, dampAngle, lerp, Rng, angleDelta } from '@/util/math';
import { GRAVITY } from '@/gameplay/Physics';
import type { BodyBuilder, BuiltPart } from './BodyBuilder';
import { Rig, type RigInstance } from './Rig';
import {
  ProceduralAnimator,
  type AnimationContext,
  type AnimationLod,
  type AnimatorTuning,
} from './ProceduralAnimator';
import { Ragdoll } from './Ragdoll';

// ---------------------------------------------------------------------------
// Species contract
// ---------------------------------------------------------------------------

export interface BodyBuildContext {
  materials: MaterialLibrary;
  /** Geometry kit. Register materials, add parts, then `finish()`. */
  builder: BodyBuilder;
  /** Empty rig — declare the skeleton on it. */
  rig: Rig;
  archetype: EnemyArchetype;
  /** Deterministic per-species RNG. Same seed every boot. */
  rng: Rng;
  /** Geometry detail scalar from the quality profile. */
  detail: number;
}

/** A collision proxy bound to a bone, updated from the animated pose each step. */
export interface ProxySpec {
  region: HitRegion;
  /** Bone name to follow. */
  bone: string;
  /** Offset along the bone's local axes. */
  offset?: THREE.Vector3;
  radius: number;
  /** >0 makes it a capsule along world Y. */
  halfHeight?: number;
  /** Damage multiplier on top of the weapon's precision multiplier. */
  multiplier: number;
}

export interface BuiltBody {
  rig: Rig;
  parts: BuiltPart[];
  /** Overall standing height in metres — used for shields and camera framing. */
  height: number;
  headBone?: string;
  /** Where the unit's weapon fires from. */
  muzzleBone?: string;
  hitProxies?: ProxySpec[];
  /** Shield shell radius; defaults to the archetype capsule. */
  shieldRadius?: number;
  /** Faction accent colour for shields, dissolve edges and gibs. */
  accentColor?: number;
  /** Overrides for the procedural animator. */
  tuning?: Partial<AnimatorTuning>;
  /**
   * Measured height of each leg chain's IK joint above the sole of its foot, in
   * rig order. Filled in by `EnemyManager` from the built geometry — a species
   * never sets it. Without it the animator guesses the figure from bone lengths
   * and the whole roster hovers about a hand's width off the ground.
   */
  footLift?: number[];
}

export type BehaviourStatus = 'success' | 'failure' | 'running';

export interface BehaviourContext {
  dt: number;
  elapsed: number;
  collision: CollisionWorld | null;
  vfx: VfxSystem;
  /** The agent's current quarry (normally the player). */
  target: Damageable | null;
  targetPosition: THREE.Vector3;
  targetVelocity: THREE.Vector3;
  targetValid: boolean;
  rng: Rng;
}

export interface BehaviourNode {
  tick(agent: EnemyAgent, ctx: BehaviourContext): BehaviourStatus;
  reset?(agent: EnemyAgent): void;
}

export interface SpeciesDefinition {
  archetype: EnemyArchetype;
  build(ctx: BodyBuildContext): BuiltBody;
  behaviour(ctx: BehaviourContext): BehaviourNode;
  animate?(agent: EnemyAgent, ctx: AnimationContext): void;
}

const SPECIES = new Map<string, SpeciesDefinition>();

/** Register a species. `EnemyManager.register` delegates here. */
export function registerSpecies(def: SpeciesDefinition): void {
  SPECIES.set(def.archetype.id, def);
}

export function getSpecies(id: string): SpeciesDefinition | undefined {
  return SPECIES.get(id);
}

export function speciesIds(): string[] {
  return [...SPECIES.keys()];
}

// ---------------------------------------------------------------------------
// AI blackboard
// ---------------------------------------------------------------------------

/**
 * Coarse behavioural state. Mirrors `AiStateName` in `@/gameplay/ai/AiDirector`
 * — declared here rather than imported so the enemy layer never depends on the
 * AI layer (the AI layer already declares its view of an agent structurally, so
 * an import in either direction would close a cycle).
 */
export type AgentStateName =
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

/** Vocalisation cue. Mirrors `AiBark`; the audio owner synthesises these. */
export type AgentBark =
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
 * The shared blackboard between the AI layer and the presentation layer.
 *
 * The first block is the contract `@/gameplay/ai`'s director writes and this
 * module reads — field-for-field compatible with its `AiAgentOutput`, so an
 * `EnemyAgent` satisfies its `AiAgent` structurally with no adapter. `fire`,
 * `leap` and `bark` are **one-step pulses**: the AI sets them, the manager
 * consumes them, the AI clears them.
 *
 * The second block is what a `SpeciesDefinition.behaviour()` tree writes when
 * no external director is driving: a desired velocity and a look target, which
 * `EnemyAgent.step()` integrates.
 */
export interface AgentAi {
  state: AgentStateName;
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
  attackId: string;
  /** One-step pulse: release the attack now, at `aimPoint`. */
  fire: boolean;
  readonly aimPoint: THREE.Vector3;
  /** One-step pulse: play a leap take-off. */
  leap: boolean;
  /** One-step pulse: play this bark. */
  bark: AgentBark | null;
  inCover: boolean;
  hasToken: boolean;
  order: string;
  stateTime: number;
  target: Damageable | null;
  targetPosition: THREE.Vector3;
  lastKnownPosition: THREE.Vector3;
  hasLineOfSight: boolean;
  distanceToTarget: number;
  /** 0 = unaware, 1 = fully engaged. */
  alert: number;
  /** Desired world-space velocity, m/s. The agent accelerates toward it. */
  desiredVelocity: THREE.Vector3;
  /** World point to face. */
  lookAt: THREE.Vector3;
  lookValid: boolean;
  destination: THREE.Vector3;
  hasDestination: boolean;
  coverPoint: THREE.Vector3;
  hasCover: boolean;
  squad: number;
  slot: number;
  attackCooldown: number;
  abilityCooldown: number;
  /** Flight thrust 0..1, for winged units. */
  thrust: number;
  /** Free numeric blackboard for behaviour nodes and the director. */
  vars: Map<string, number>;
}

function createAi(): AgentAi {
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
    stateTime: 0,
    target: null,
    targetPosition: new THREE.Vector3(),
    lastKnownPosition: new THREE.Vector3(),
    hasLineOfSight: false,
    distanceToTarget: Infinity,
    alert: 0,
    desiredVelocity: new THREE.Vector3(),
    lookAt: new THREE.Vector3(),
    lookValid: false,
    destination: new THREE.Vector3(),
    hasDestination: false,
    coverPoint: new THREE.Vector3(),
    hasCover: false,
    squad: -1,
    slot: -1,
    attackCooldown: 0,
    abilityCooldown: 0,
    thrust: 0,
    vars: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Host seam
// ---------------------------------------------------------------------------

/**
 * The slice of the manager an agent needs. Declared here rather than importing
 * `EnemyManager` so the module graph stays acyclic at runtime.
 */
export interface EnemyHost {
  readonly vfx: VfxSystem;
  readonly collision: CollisionWorld | null;
  onAgentDamaged(agent: EnemyAgent, info: DamageInfo, dealt: number): void;
  onAgentShieldBroken(agent: EnemyAgent, info: DamageInfo): void;
  onAgentKilled(agent: EnemyAgent, info: DamageInfo | null): void;
}

export type AgentState = 'pooled' | 'alive' | 'dying' | 'dead';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hit: RaycastHit = {
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  surface: 'rock',
};

let nextEntityId = 1000;

/** Shield element interactions, Destiny-style: matching element strips faster. */
function shieldMultiplier(shieldElement: DamageElement | null, incoming: DamageElement): number {
  if (!shieldElement) return 1;
  if (shieldElement === incoming) return 2.6;
  if (incoming === 'kinetic') return 0.75;
  return 1;
}

export class EnemyAgent implements Damageable {
  readonly entityId: number;
  readonly archetype: EnemyArchetype;
  readonly faction: FactionId;
  readonly species: SpeciesDefinition;

  // -- transform ------------------------------------------------------------
  /** Ground-contact point. The body group sits here. */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  yawRate = 0;
  grounded = true;

  // -- vitals ---------------------------------------------------------------
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  state: AgentState = 'pooled';

  // -- presentation ---------------------------------------------------------
  readonly object = new THREE.Group();
  readonly meshes: THREE.SkinnedMesh[] = [];
  readonly rig: RigInstance;
  readonly anim: ProceduralAnimator;
  readonly ragdoll: Ragdoll;
  shieldMesh: THREE.Mesh | null = null;

  // -- brain ----------------------------------------------------------------
  readonly ai: AgentAi = createAi();
  brain: BehaviourNode | null = null;
  readonly rng: Rng;

  /** Bone names the framework uses; filled from the species' BuiltBody. */
  headBone: string;
  muzzleBone: string;
  readonly height: number;
  readonly accentColor: number;

  /** How much of the animator ran this frame. */
  lod: AnimationLod = 'full';
  /** Frames until this agent animates again (LOD rate limiting). */
  animCountdown = 0;
  /** Accumulated real time since the last animation update. */
  animAccum = 0;
  /** Time since the behaviour tree last ticked. */
  brainAccum = 0;

  /**
   * True while a hit stagger is playing. `@/gameplay/ai`'s director reads this
   * and suspends decisions and motion for the duration.
   */
  staggered = false;
  /** Behaviour id for the AI director's registry, when it drives this unit. */
  behaviourId?: string;
  /**
   * When true, an external director owns `position`/`velocity` and `step()`
   * only maintains ground contact, facing and timers. Set by `EnemyManager`
   * when an AI director is installed.
   */
  externalMotion = false;

  /** Death bookkeeping. */
  deathTime = 0;
  dissolve = 0;
  hitFlash = 0;
  /** Set while the stagger plays, before the ragdoll takes over. */
  staggerTime = 0;
  killInfo: DamageInfo | null = null;

  private host: EnemyHost;
  private groundY = 0;
  private groundNormal = new THREE.Vector3(0, 1, 0);
  private groundSampleAt = new THREE.Vector3(0, -9999, 0);
  private wallTimer = 0;
  private wallPush = new THREE.Vector3();
  private prevPosition = new THREE.Vector3();
  private renderPosition = new THREE.Vector3();

  constructor(
    species: SpeciesDefinition,
    body: BuiltBody,
    rig: RigInstance,
    host: EnemyHost,
    seed: number,
  ) {
    this.entityId = nextEntityId++;
    this.species = species;
    this.archetype = species.archetype;
    this.faction = species.archetype.faction;
    this.host = host;
    this.rng = new Rng(seed);
    this.rig = rig;
    this.height = body.height;
    this.headBone = body.headBone ?? 'spine.head';
    this.muzzleBone = body.muzzleBone ?? this.headBone;
    this.accentColor = body.accentColor ?? 0xffffff;

    this.maxHealth = this.archetype.health;
    this.health = this.maxHealth;
    this.maxShield = this.archetype.shield;
    this.shield = this.maxShield;

    this.anim = new ProceduralAnimator(rig, body.tuning ?? {}, body.footLift);
    this.ragdoll = new Ragdoll(rig);

    this.object.name = `enemy:${this.archetype.id}:${this.entityId}`;
    this.object.add(rig.root);
    this.object.visible = false;
  }

  // -- Damageable -----------------------------------------------------------

  get isDead(): boolean {
    return this.state === 'dying' || this.state === 'dead';
  }

  getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).addScaledVector(_v0.set(0, 1, 0), this.height * 0.5);
  }

  /** Eye/aim point — what the player's aim assist and the AI's LOS use. */
  getAimPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).addScaledVector(_v0.set(0, 1, 0), this.archetype.eyeHeight);
  }

  applyDamage(info: DamageInfo): number {
    if (this.isDead || info.amount <= 0) return 0;
    let remaining = info.amount;
    let dealt = 0;
    let shieldBroke = false;

    if (this.shield > 0) {
      const mult = shieldMultiplier(this.archetype.shieldElement, info.element);
      const applied = remaining * mult;
      const absorbed = Math.min(this.shield, applied);
      this.shield -= absorbed;
      dealt += absorbed / mult;
      // Overkill on the shield carries into health at the raw rate.
      remaining = Math.max(0, (applied - absorbed) / mult);
      if (this.shield <= 0) {
        this.shield = 0;
        shieldBroke = true;
      }
    }

    if (remaining > 0) {
      const taken = Math.min(this.health, remaining);
      this.health -= taken;
      dealt += taken;
    }

    this.hitFlash = Math.min(1, this.hitFlash + clamp01(info.amount / Math.max(1, this.maxHealth * 0.35)) * 0.7 + 0.18);
    // Flinch: the impulse goes into the struck limb's spring.
    const strength = clamp(info.amount / Math.max(8, this.maxHealth * 0.2), 0.15, 2.4);
    this.anim.hit(info.point, info.direction, strength);
    this.ai.alert = 1;
    this.ai.lastKnownPosition.copy(info.point).addScaledVector(info.direction, -6);

    if (shieldBroke) this.host.onAgentShieldBroken(this, info);
    this.host.onAgentDamaged(this, info, dealt);

    if (this.health <= 0 && !this.isDead) {
      this.killInfo = info;
      this.host.onAgentKilled(this, info);
    }
    return dealt;
  }

  // -- lifecycle ------------------------------------------------------------

  /** Place a pooled agent into the world. */
  activate(position: THREE.Vector3, yaw: number, groundY: number): void {
    this.state = 'alive';
    this.position.copy(position);
    this.position.y = groundY;
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.yawRate = 0;
    this.grounded = !this.archetype.flying;
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.hitFlash = 0;
    this.dissolve = 0;
    this.deathTime = 0;
    this.staggerTime = 0;
    this.killInfo = null;
    this.staggered = false;
    this.groundY = groundY;
    this.groundSampleAt.set(0, -9999, 0);
    this.animAccum = 0;
    this.brainAccum = 0;
    this.lod = 'full';

    const ai = this.ai;
    ai.state = 'idle';
    ai.yaw = yaw;
    ai.aimYaw = yaw;
    ai.aimPitch = 0;
    ai.locomotion = 0;
    ai.strafe = 0;
    ai.speed = 0;
    ai.grounded = true;
    ai.windup = 0;
    ai.attackId = '';
    ai.fire = false;
    ai.leap = false;
    ai.bark = null;
    ai.inCover = false;
    ai.hasToken = false;
    ai.order = 'idle';
    ai.stateTime = 0;
    ai.alert = 0;
    ai.hasLineOfSight = false;
    ai.distanceToTarget = Infinity;
    ai.desiredVelocity.set(0, 0, 0);
    ai.lookValid = false;
    ai.hasDestination = false;
    ai.hasCover = false;
    ai.attackCooldown = this.rng.range(0.2, 0.9);
    ai.abilityCooldown = this.rng.range(2, 6);
    ai.thrust = this.archetype.flying ? 0.5 : 0;
    ai.vars.clear();

    this.brain?.reset?.(this);
    this.ragdoll.stop();
    this.anim.reset(this.position, yaw, groundY);
    this.object.position.copy(this.position);
    this.object.quaternion.setFromAxisAngle(_v0.set(0, 1, 0), yaw);
    this.object.visible = true;
  }

  /** Return to the pool. */
  deactivate(): void {
    this.state = 'pooled';
    this.object.visible = false;
    this.ragdoll.stop();
    if (this.shieldMesh) this.shieldMesh.visible = false;
  }

  // -- simulation -----------------------------------------------------------

  /**
   * Fixed-step gameplay. Movement only — the behaviour tree is ticked by the
   * manager at its own (LOD-dependent) cadence.
   */
  step(dt: number, collision: CollisionWorld | null): void {
    if (this.state !== 'alive') return;
    this.prevPosition.copy(this.position);
    const a = this.archetype;
    const ai = this.ai;

    ai.stateTime += dt;
    if (ai.attackCooldown > 0) ai.attackCooldown -= dt;
    if (ai.abilityCooldown > 0) ai.abilityCooldown -= dt;

    if (this.externalMotion) {
      // The director integrated us already; just keep the presentation layer's
      // inputs honest and let the facing follow its yaw.
      this.sampleGround(collision);
      const prevYawE = this.yaw;
      this.yaw = dampAngle(this.yaw, ai.yaw, 12, dt);
      this.yawRate = damp(this.yawRate, angleDelta(prevYawE, this.yaw) / dt, 18, dt);
      this.grounded = !a.flying && this.position.y <= this.groundY + 0.06;
      this.publishAi();
      return;
    }

    // Horizontal steering.
    const want = ai.desiredVelocity;
    const maxSpeed = a.sprintSpeed;
    _v0.set(want.x, 0, want.z);
    if (_v0.lengthSq() > maxSpeed * maxSpeed) _v0.setLength(maxSpeed);
    // Acceleration scales with mass class: a champion should not turn like a drone.
    const accel = lerp(28, 9, clamp01(a.capsuleHalfHeight / 1.6));
    this.velocity.x = damp(this.velocity.x, _v0.x, accel, dt);
    this.velocity.z = damp(this.velocity.z, _v0.z, accel, dt);

    if (a.flying) {
      // Flyers hold an altitude band above the ground and hover with damping.
      const targetY = want.y;
      this.velocity.y = damp(this.velocity.y, clamp(targetY, -6, 6), 5, dt);
      this.grounded = false;
    } else {
      this.velocity.y -= GRAVITY * dt;
    }

    this.position.addScaledVector(this.velocity, dt);
    this.position.add(this.wallPush);
    this.wallPush.multiplyScalar(0);

    this.sampleGround(collision);
    if (collision) {
      this.wallTimer -= dt;
      if (this.wallTimer <= 0) {
        this.wallTimer = 1 / 15;
        this.probeWalls(collision);
      }
    }

    if (a.flying) {
      const floor = this.groundY + a.capsuleHalfHeight * 2 + 0.6;
      if (this.position.y < floor) {
        this.position.y = floor;
        if (this.velocity.y < 0) this.velocity.y *= 0.2;
      }
    } else if (this.position.y <= this.groundY + 0.001) {
      this.position.y = this.groundY;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;
    } else if (this.position.y > this.groundY + 0.05) {
      this.grounded = false;
    }

    // Facing: look at the target if asked, otherwise face the way we move.
    let wantYaw = this.yaw;
    if (ai.lookValid) {
      const dx = ai.lookAt.x - this.position.x;
      const dz = ai.lookAt.z - this.position.z;
      if (dx * dx + dz * dz > 0.04) wantYaw = Math.atan2(-dx, -dz);
    } else if (this.velocity.lengthSq() > 0.4) {
      wantYaw = Math.atan2(-this.velocity.x, -this.velocity.z);
    }
    const prevYaw = this.yaw;
    // Turn rate scales with size, and never so fast the gait cannot keep up.
    const turnRate = lerp(9, 3.5, clamp01(a.capsuleHalfHeight / 1.6));
    this.yaw = dampAngle(this.yaw, wantYaw, turnRate, dt);
    this.yawRate = damp(this.yawRate, angleDelta(prevYaw, this.yaw) / dt, 18, dt);
    this.publishAi();
  }

  /**
   * Ground sample, cached. `CollisionWorld.sampleGround` allocates, and there
   * are up to `enemyBudget` of us at 120 Hz, so it is only re-queried once the
   * agent has actually moved.
   */
  private sampleGround(collision: CollisionWorld | null): void {
    if (!collision) return;
    if (this.position.distanceToSquared(this.groundSampleAt) <= 0.02) return;
    const g = collision.sampleGround(this.position.x, this.position.z, this.position.y + 12);
    if (g) {
      this.groundY = g.y;
      this.groundNormal.copy(g.normal);
    }
    this.groundSampleAt.copy(this.position);
  }

  /** Publish the animation-facing half of the blackboard. */
  private publishAi(): void {
    const ai = this.ai;
    ai.speed = Math.hypot(this.velocity.x, this.velocity.z);
    ai.grounded = this.grounded;
    if (!this.externalMotion) {
      ai.yaw = this.yaw;
      ai.locomotion = clamp01(ai.speed / Math.max(0.5, this.archetype.sprintSpeed));
      ai.state = this.isDead ? 'dead' : this.staggered ? 'stagger' : (ai.state as AgentStateName);
    }
    ai.windup = this.anim.attackProgress < 0 ? 0 : clamp01(this.anim.attackProgress);
  }

  /**
   * Four cheap rays instead of a capsule sweep: enemies need to not walk into
   * walls, not to be pixel-accurate, and `resolveCapsule` allocates a result
   * object per call which at 120 Hz × `enemyBudget` is real garbage pressure.
   */
  private probeWalls(collision: CollisionWorld): void {
    const r = this.archetype.capsuleRadius + 0.15;
    const eye = _v0.copy(this.position);
    eye.y += this.archetype.capsuleHalfHeight + this.archetype.capsuleRadius;
    for (let i = 0; i < 4; i++) {
      const a = this.yaw + (i / 4) * Math.PI * 2;
      _v1.set(-Math.sin(a), 0, -Math.cos(a));
      const h = collision.raycast(eye, _v1, r, _hit);
      if (!h) continue;
      const push = r - h.distance;
      if (push <= 0) continue;
      // Only push out along the horizontal component of the surface normal.
      _v2.set(h.normal.x, 0, h.normal.z);
      if (_v2.lengthSq() < 1e-6) continue;
      _v2.normalize().multiplyScalar(push * 0.6);
      this.wallPush.add(_v2);
      const into = this.velocity.dot(_v2);
      if (into < 0) this.velocity.addScaledVector(_v2, -into / _v2.lengthSq());
    }
  }

  /** Tick the behaviour tree. Called by the manager at an LOD-dependent rate. */
  think(ctx: BehaviourContext): void {
    if (this.state !== 'alive' || !this.brain) return;
    this.brain.tick(this, ctx);
  }

  /** Interpolated render position, so 120 Hz sim renders smoothly at any fps. */
  renderPositionAt(alpha: number): THREE.Vector3 {
    return this.renderPosition.lerpVectors(this.prevPosition, this.position, clamp01(alpha));
  }

  get groundHeight(): number {
    return this.groundY;
  }

  get groundSurfaceNormal(): THREE.Vector3 {
    return this.groundNormal;
  }

  /** Begin dying: stagger, then ragdoll, then dissolve. */
  beginDeath(info: DamageInfo | null): void {
    if (this.isDead) return;
    this.state = 'dying';
    this.killInfo = info;
    this.deathTime = 0;
    // A short stagger before the body goes limp reads as a creature losing its
    // legs rather than a puppet whose strings were cut.
    this.staggerTime = info && info.region === 'head' ? 0.05 : 0.16;
    this.ai.desiredVelocity.set(0, 0, 0);
    if (this.shieldMesh) this.shieldMesh.visible = false;
  }

  dispose(): void {
    this.object.removeFromParent();
    // Geometry is shared with every other instance of this species and is
    // released by the manager's species template, not here.
    for (const m of this.meshes) (m.material as THREE.Material).dispose();
    this.meshes.length = 0;
    if (this.shieldMesh) {
      this.shieldMesh.geometry.dispose();
      (this.shieldMesh.material as THREE.Material).dispose();
      this.shieldMesh = null;
    }
    this.rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// Behaviour-tree kit
// ---------------------------------------------------------------------------
//
// Nodes are constructed per agent (see `SpeciesDefinition.behaviour`), so they
// may hold plain state. Keep them cheap: a tree ticks 10–30 times a second per
// agent, never per simulation step.

export function sequence(...children: BehaviourNode[]): BehaviourNode {
  let index = 0;
  return {
    tick(agent, ctx) {
      while (index < children.length) {
        const s = children[index].tick(agent, ctx);
        if (s === 'running') return 'running';
        if (s === 'failure') {
          index = 0;
          return 'failure';
        }
        index++;
      }
      index = 0;
      return 'success';
    },
    reset(agent) {
      index = 0;
      for (const c of children) c.reset?.(agent);
    },
  };
}

export function selector(...children: BehaviourNode[]): BehaviourNode {
  return {
    tick(agent, ctx) {
      for (const c of children) {
        const s = c.tick(agent, ctx);
        if (s !== 'failure') return s;
      }
      return 'failure';
    },
    reset(agent) {
      for (const c of children) c.reset?.(agent);
    },
  };
}

/** Runs every child each tick; succeeds when all do. Good for "move and shoot". */
export function parallel(...children: BehaviourNode[]): BehaviourNode {
  return {
    tick(agent, ctx) {
      let running = false;
      for (const c of children) {
        const s = c.tick(agent, ctx);
        if (s === 'running') running = true;
      }
      return running ? 'running' : 'success';
    },
    reset(agent) {
      for (const c of children) c.reset?.(agent);
    },
  };
}

export function action(
  fn: (agent: EnemyAgent, ctx: BehaviourContext) => BehaviourStatus | void,
): BehaviourNode {
  return {
    tick(agent, ctx) {
      return fn(agent, ctx) ?? 'success';
    },
  };
}

export function condition(fn: (agent: EnemyAgent, ctx: BehaviourContext) => boolean): BehaviourNode {
  return {
    tick(agent, ctx) {
      return fn(agent, ctx) ? 'success' : 'failure';
    },
  };
}

export function invert(child: BehaviourNode): BehaviourNode {
  return {
    tick(agent, ctx) {
      const s = child.tick(agent, ctx);
      return s === 'success' ? 'failure' : s === 'failure' ? 'success' : 'running';
    },
    reset(agent) {
      child.reset?.(agent);
    },
  };
}

/** Succeeds at most once per `seconds`; fails while cooling down. */
export function cooldown(seconds: number, child: BehaviourNode): BehaviourNode {
  let remaining = 0;
  return {
    tick(agent, ctx) {
      remaining -= ctx.dt;
      if (remaining > 0) return 'failure';
      const s = child.tick(agent, ctx);
      if (s === 'success') remaining = seconds;
      return s;
    },
    reset(agent) {
      remaining = 0;
      child.reset?.(agent);
    },
  };
}

/** Runs for `seconds`, then succeeds. */
export function wait(seconds: number): BehaviourNode {
  let t = -1;
  return {
    tick(_agent, ctx) {
      if (t < 0) t = seconds;
      t -= ctx.dt;
      if (t <= 0) {
        t = -1;
        return 'success';
      }
      return 'running';
    },
    reset() {
      t = -1;
    },
  };
}

// ---------------------------------------------------------------------------
// A working default brain
// ---------------------------------------------------------------------------

const _bv = new THREE.Vector3();
const _bv2 = new THREE.Vector3();

/**
 * The baseline combat loop every faction can start from and specialise:
 * idle → notice → close to preferred range → strafe and shoot with a
 * telegraphed wind-up → back off when the range collapses.
 *
 * `aggression` biases how close it presses; `caution` biases how much it
 * strafes and how readily it breaks off. Both come from the archetype, so a
 * champion and a minor of the same species already behave differently.
 */
export function standardCombatBehaviour(archetype: EnemyArchetype): BehaviourNode {
  const melee = archetype.preferredRange < 4;
  let strafeDir = 1;
  let strafeTimer = 0;

  return selector(
    // Unaware: idle sway, occasional look-around.
    sequence(
      condition((a, ctx) => !ctx.targetValid || a.ai.alert < 0.25),
      action((a, ctx) => {
        a.ai.state = 'idle';
        a.ai.desiredVelocity.set(0, 0, 0);
        a.ai.lookValid = false;
        if (ctx.targetValid && a.ai.distanceToTarget < archetype.preferredRange * 2.5 && a.ai.hasLineOfSight) {
          a.ai.alert = Math.min(1, a.ai.alert + ctx.dt * 1.6);
        } else {
          a.ai.alert = Math.max(0, a.ai.alert - ctx.dt * 0.2);
        }
        return 'running';
      }),
    ),

    // Engaged.
    action((a, ctx) => {
      const ai = a.ai;
      ai.state = 'engage';
      if (!ctx.targetValid) {
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.35);
        ai.desiredVelocity.set(0, 0, 0);
        return 'running';
      }

      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;

      _bv.subVectors(ctx.targetPosition, a.position);
      _bv.y = 0;
      const dist = _bv.length() || 1e-3;
      _bv.multiplyScalar(1 / dist);
      _bv2.set(_bv.z, 0, -_bv.x);

      const want = archetype.preferredRange;
      const speed = ai.alert > 0.9 ? archetype.sprintSpeed : archetype.moveSpeed;

      strafeTimer -= ctx.dt;
      if (strafeTimer <= 0) {
        strafeTimer = ctx.rng.range(1.1, 2.8);
        strafeDir = ctx.rng.bool() ? 1 : -1;
      }

      // Radial: close if far, back off if crowded. The dead band stops the
      // classic sewing-machine oscillation at the preferred range.
      let radial = 0;
      if (dist > want * 1.15) radial = 1;
      else if (dist < want * 0.7) radial = -1;
      const strafe = melee ? 0 : (0.45 + archetype.caution * 0.5) * strafeDir;

      ai.desiredVelocity
        .copy(_bv)
        .multiplyScalar(radial * speed)
        .addScaledVector(_bv2, strafe * speed * 0.7);
      if (a.archetype.flying) {
        ai.desiredVelocity.y = clamp((ctx.targetPosition.y + 2.2 - a.position.y) * 1.4, -4, 4);
        ai.thrust = clamp01(ai.desiredVelocity.length() / Math.max(1, archetype.sprintSpeed));
      }

      // Attack: only with line of sight and inside a generous cone.
      if (
        ai.attackCooldown <= 0 &&
        ai.hasLineOfSight &&
        dist < archetype.preferredRange * (melee ? 1.4 : 2.2) &&
        !a.anim.busy
      ) {
        ai.attackCooldown = archetype.attackInterval * ctx.rng.range(0.85, 1.2);
        // The wind-up is the telegraph the game-feel bar demands.
        a.anim.attack(melee ? 0.42 : 0.22, melee ? 0.12 : 0.06, melee ? 0.5 : 0.24);
        ai.vars.set('attackPending', 1);
      }
      return 'running';
    }),
  );
}
