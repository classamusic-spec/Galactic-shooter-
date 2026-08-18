/**
 * Mantis Aliens — the Bladed Broods of Khepri.
 *
 * ## The design brief, in geometry
 *
 * Every unit here is built from one anatomical language so the faction reads as
 * a species rather than a set of props:
 *
 * - **Triangular head, huge compound eyes.** A flattened wedge skull with two
 *   dome lenses that take up a third of it, plus twin antennae. The antennae are
 *   the cheapest silhouette break in the game — two 30 cm curves that make a
 *   black shape at 40 m unmistakably "mantis".
 * - **Long segmented thorax, canted forward.** The spine rises from the hips and
 *   leans 45–50° so the prothorax carries the blades out in front of the body.
 *   That forward mass is what makes the stance read as a predator rather than a
 *   man in a costume.
 * - **Four arms.** The upper pair are raptorial: a long femur and a serrated
 *   tibia blade that folds back flat against it at rest (the "prayer"), and
 *   snaps open through 130° on the strike. The lower pair are small graspers.
 * - **Reverse-jointed digitigrade legs.** hip → knee (forward) → hock (back) →
 *   ankle (flat on the ground) → toe. The hock is the visible backward joint.
 *   Rest bends are chosen so the hip sits at ~84 % of the leg's IK reach, which
 *   is the slack the footstep planner needs to plant feet without sliding.
 *
 * ## Silhouette separation
 *
 * nymph 1.2 m hunched quadrangle · striker 2.4 m upright duellist · spitter
 * 2.1 m with a swollen acid abdomen dragging behind · bladelord 3.1 m with four
 * blades and a horn crown · matriarch 3.6 m winged with a trailing ovipositor ·
 * apex 7 m four-legged with a raised prothorax and a segmented tail. Height,
 * limb count and mass distribution all differ; none of them is another one
 * scaled.
 *
 * ## Telegraphs
 *
 * Every attack goes through `telegraph()` (≥0.35 s, enforced by the node) or
 * `anim.attack()` with an explicit wind-up, and the species `animate()` hook
 * turns that into a **pose**: the blades rear up over the head and the body
 * coils back, then the whole thing unloads forward. The wind-up silhouette is
 * roughly 40 % taller than the idle one, which is the point.
 *
 * ## What this module owns beyond the species
 *
 * `BioField` — a tiny pooled system for lobbed acid globs and the corrosive
 * pools they leave. It exists here because a projectile that damages the player
 * needs a fixed-step tick and the enemy framework only offers the behaviour
 * tick; it is driven from a monotonic `ctx.elapsed` guard so it steps exactly
 * once per simulation advance no matter how many agents ticked. Shared with
 * `insectoid.ts`, which is owned by the same author.
 */
import * as THREE from 'three';
import type { DamageInfo, EnemyArchetype } from '@/types';
import { clamp, clamp01, damp, lerp, smoothstep, TAU } from '@/util/math';
import { settings } from '@/core/Settings';
import { EnemyManager } from '@/gameplay/enemies/EnemyManager';
import { ARCHETYPES } from '@/gameplay/enemies/Archetypes';
import type {
  BehaviourContext,
  BehaviourNode,
  BodyBuildContext,
  BuiltBody,
  EnemyAgent,
  ProxySpec,
} from '@/gameplay/enemies/EnemyAgent';
import {
  action,
  condition,
  parallel,
  selector,
  sequence,
  standardCombatBehaviour,
} from '@/gameplay/enemies/EnemyAgent';
import type { BodyBuilder } from '@/gameplay/enemies/BodyBuilder';
import { DOWN, FORWARD, UP, type ChainRuntime, type Rig, type RigInstance } from '@/gameplay/enemies/Rig';
import type { AnimationContext } from '@/gameplay/enemies/ProceduralAnimator';
import {
  FAILURE,
  RUNNING,
  SUCCESS,
  advanceToRange,
  action as btAction,
  bark as btBark,
  cond as btCond,
  cooldown as btCooldown,
  wait as btWait,
  chance,
  compileTree,
  fail,
  faceTarget,
  guard,
  holdCover,
  leapAt,
  leaveCover,
  meleeStrike,
  moveToFlank,
  par,
  patrolArea,
  repositionFiring,
  retreatFrom,
  scanArea,
  searchLastKnown,
  seq,
  sel,
  strafeAtRange,
  takeCover,
  telegraph,
  timeout,
  withAttackToken,
  type BehaviorTree,
  type BtContext,
} from '@/gameplay/ai/BehaviorTree';

// ---------------------------------------------------------------------------
// Faction identity
// ---------------------------------------------------------------------------

/** Acid-green. Matches `FACTION_ACCENT.mantis`; emissives and ichor use it. */
export const MANTIS_GLOW = 0x9dff4a;
/** Iridescent green-gold chitin, dark jade plate, near-black blade. */
// These are *tints* multiplied onto the library surfaces, which already carry
// their own albedo (mantisResin is olive, chitin is warm brown). Near-white
// values let the procedural colour through; dark values push it toward black.
const SHELL = 0x5f7d38;
const PLATE = 0xb2c46a;
const BLADE = 0x1a2418;
const SHELL_TIP = 0x93ad55;

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Rest position of a bone, as a fresh vector (build-time only). */
function at(rig: Rig, name: string): THREE.Vector3 {
  return rig.restPosition(name, new THREE.Vector3());
}

/** Rest position of the tip past the last bone of a chain. */
function tipOf(rig: Rig, chainId: string): THREE.Vector3 {
  const c = rig.chainById(chainId);
  return c ? c.restTip.clone() : new THREE.Vector3();
}

/**
 * Where a `DOWN`-pointing chain's joints end up, given its per-joint rest bends.
 *
 * `Rig.chain` fixes the chain origin at construction, so a leg's foot height is
 * a *consequence* of the lengths and bends — there is no way to nudge it
 * afterwards. Solving it up front is what lets every unit stand with its feet
 * exactly on the ground and its hip at a known fraction of the leg's reach.
 * Each bone's world direction is the down axis rotated by the accumulated bend
 * about local X, i.e. `(0, -cos θ, -sin θ)`.
 */
function chainReachDown(lengths: number[], bends: number[], joints: number): { dy: number; dz: number } {
  let a = 0;
  let dy = 0;
  let dz = 0;
  for (let i = 0; i < joints; i++) {
    a += bends[i] ?? 0;
    dy -= lengths[i] * Math.cos(a);
    dz -= lengths[i] * Math.sin(a);
  }
  return { dy, dz };
}

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

/**
 * The Mantis stat block. Written out in full rather than derived from a rank
 * table: these units are built around leaps and blades, so almost every field
 * differs from the generic baseline anyway.
 */
function mantisArchetype(o: Partial<EnemyArchetype> & Pick<EnemyArchetype, 'id' | 'rank' | 'displayName'>): EnemyArchetype {
  return {
    faction: 'mantis',
    health: 60,
    shield: 0,
    shieldElement: null,
    moveSpeed: 4,
    sprintSpeed: 7,
    preferredRange: 3,
    eyeHeight: 1.6,
    capsuleRadius: 0.36,
    capsuleHalfHeight: 0.65,
    attackDamage: 8,
    attackInterval: 1,
    accuracy: 0.05,
    aggression: 0.9,
    caution: 0.15,
    flying: false,
    score: 12,
    abilities: [],
    ...o,
  };
}

export const MANTIS_ARCHETYPES: Record<string, EnemyArchetype> = {
  mantis_nymph: mantisArchetype({
    id: 'mantis_nymph',
    rank: 'minor',
    displayName: 'Brood Nymph',
    health: 55,
    moveSpeed: 5.4,
    sprintSpeed: 9.2,
    preferredRange: 2.2,
    eyeHeight: 0.95,
    capsuleRadius: 0.28,
    capsuleHalfHeight: 0.45,
    attackDamage: 7,
    attackInterval: 0.85,
    accuracy: 0.09,
    aggression: 1,
    caution: 0.02,
    score: 12,
    abilities: ['pounce', 'wallCling'],
  }),
  mantis_striker: mantisArchetype({
    id: 'mantis_striker',
    rank: 'standard',
    displayName: 'Blade Striker',
    health: 150,
    moveSpeed: 4.6,
    sprintSpeed: 8.2,
    preferredRange: 2.8,
    eyeHeight: 1.95,
    capsuleRadius: 0.38,
    capsuleHalfHeight: 0.78,
    attackDamage: 13,
    attackInterval: 0.34,
    accuracy: 0.06,
    aggression: 0.92,
    caution: 0.2,
    score: 30,
    abilities: ['pounce', 'bladeCombo', 'dodgeBack'],
  }),
  mantis_spitter: mantisArchetype({
    id: 'mantis_spitter',
    rank: 'standard',
    displayName: 'Acid Spitter',
    health: 130,
    moveSpeed: 3.2,
    sprintSpeed: 6,
    preferredRange: 19,
    eyeHeight: 1.55,
    capsuleRadius: 0.44,
    capsuleHalfHeight: 0.66,
    attackDamage: 16,
    attackInterval: 1.9,
    accuracy: 0.05,
    aggression: 0.4,
    caution: 0.7,
    score: 32,
    abilities: ['acidSpit', 'acidPool', 'retreat'],
  }),
  mantis_bladelord: mantisArchetype({
    id: 'mantis_bladelord',
    rank: 'elite',
    displayName: 'Bladelord',
    health: 380,
    shield: 200,
    shieldElement: 'arc',
    moveSpeed: 4.2,
    sprintSpeed: 8.6,
    preferredRange: 3.4,
    eyeHeight: 2.5,
    capsuleRadius: 0.48,
    capsuleHalfHeight: 0.98,
    attackDamage: 24,
    attackInterval: 0.3,
    accuracy: 0.04,
    aggression: 0.85,
    caution: 0.35,
    score: 90,
    abilities: ['parry', 'bladeStorm', 'dash'],
  }),
  mantis_matriarch: mantisArchetype({
    id: 'mantis_matriarch',
    rank: 'champion',
    displayName: 'Brood Matriarch',
    health: 950,
    shield: 420,
    shieldElement: 'arc',
    moveSpeed: 4,
    sprintSpeed: 8,
    preferredRange: 9,
    eyeHeight: 3,
    capsuleRadius: 0.55,
    capsuleHalfHeight: 0.9,
    attackDamage: 30,
    attackInterval: 0.5,
    accuracy: 0.035,
    aggression: 0.75,
    caution: 0.4,
    flying: true,
    score: 260,
    abilities: ['dive', 'clutch', 'summon'],
  }),
  mantis_apex: mantisArchetype({
    id: 'mantis_apex',
    rank: 'boss',
    displayName: 'The Apex',
    health: 4600,
    shield: 1800,
    shieldElement: 'arc',
    moveSpeed: 3.4,
    sprintSpeed: 7.4,
    preferredRange: 6,
    eyeHeight: 4.4,
    capsuleRadius: 1.15,
    capsuleHalfHeight: 1.5,
    attackDamage: 42,
    attackInterval: 0.42,
    accuracy: 0.03,
    aggression: 0.9,
    caution: 0.15,
    score: 1100,
    abilities: ['bladeSweep', 'diveBomb', 'acidFlood', 'severLimbs'],
  }),
};

/**
 * Catalogue aliases. `Archetypes.ts` (another owner's file) ships a `mantis.*`
 * roster that `EnemyManager.archetypesFor` and the encounter director look up by
 * id. Registering the same bodies under those ids as well means a level can
 * spawn either naming and get a real Mantis rather than a missing species.
 */
const MANTIS_ALIASES: Array<[catalogueId: string, unitId: string]> = [
  ['mantis.spawn', 'mantis_nymph'],
  ['mantis.stalker', 'mantis_striker'],
  ['mantis.reaper', 'mantis_bladelord'],
  ['mantis.broodlord', 'mantis_matriarch'],
];

// ---------------------------------------------------------------------------
// Shared faction kit — pose helpers and the bio-projectile field
// ---------------------------------------------------------------------------

const _fq = new THREE.Quaternion();
const _fx = new THREE.Vector3(1, 0, 0);
const _fy = new THREE.Vector3(0, 1, 0);

/**
 * Rotate bone `i` of a chain about its own local X, starting from the rest pose.
 *
 * Faction `animate()` hooks pose limbs the base animator deliberately ignores
 * (chains declared `generic`). Rebuilding from `restQuat` every frame is what
 * makes the layer additive instead of cumulative — the same discipline
 * `ProceduralAnimator.updateSpine` uses.
 */
export function fkBend(rig: RigInstance, chain: ChainRuntime, i: number, angle: number, yaw = 0): void {
  const bone = chain.bones[i];
  bone.quaternion.copy(rig.def.bones[chain.indices[i]].restQuat);
  if (angle !== 0) bone.quaternion.multiply(_fq.setFromAxisAngle(_fx, angle));
  if (yaw !== 0) bone.quaternion.multiply(_fq.setFromAxisAngle(_fy, yaw));
}

/** Per-agent scalar state that survives pooling. `ai.vars` is a plain number map. */
export function vGet(agent: EnemyAgent, key: string, dflt = 0): number {
  const x = agent.ai.vars.get(key);
  return x === undefined ? dflt : x;
}

export function vSet(agent: EnemyAgent, key: string, value: number): void {
  agent.ai.vars.set(key, value);
}

/**
 * Attack pose drivers, normalised across both ways an attack can reach us.
 *
 * The AI director telegraphs through `ai.windup` and only pulses the animator on
 * release; the manager-driven fallback runs the animator's own timeline. Reading
 * both and latching the strike gives one `coil`/`swing` pair that is correct
 * under either driver, and the caller never has to know which is in charge.
 */
export function attackPose(agent: EnemyAgent, dt: number): { coil: number; swing: number } {
  const active = agent.anim.attackProgress >= 0;

  // `ai.windup` cannot be read directly. `EnemyAgent.publishAi()` rewrites it
  // from the animator's own timeline on every 120 Hz step, while the director's
  // `telegraph` node only writes it at the behaviour rate (30 Hz) — so the value
  // the render pass sees is a square wave that is zero three frames out of four.
  // Latching the last non-zero reading for a sixth of a second bridges the gaps
  // and gives a wind-up pose that actually holds.
  let hold = vGet(agent, 'mxHold');
  let holdT = vGet(agent, 'mxHoldT');
  if (agent.ai.windup > 0.01) {
    hold = agent.ai.windup;
    holdT = 0.16;
  } else {
    holdT = Math.max(0, holdT - dt);
    if (holdT <= 0) hold = 0;
  }
  vSet(agent, 'mxHold', hold);
  vSet(agent, 'mxHoldT', holdT);

  if (!active && hold <= 0.001) vSet(agent, 'mxStruck', 0);
  if (agent.anim.attackStriking) vSet(agent, 'mxStruck', 1);
  const struck = vGet(agent, 'mxStruck') > 0.5;

  const coilTarget = struck ? 0 : Math.max(hold, active ? 1 : 0);
  const swingTarget = struck && active ? 1 : 0;
  const coil = damp(vGet(agent, 'mxCoil'), coilTarget, 13, dt);
  const swing = damp(vGet(agent, 'mxSwing'), swingTarget, 24, dt);
  vSet(agent, 'mxCoil', coil);
  vSet(agent, 'mxSwing', swing);
  return { coil, swing };
}

interface Glob {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  poolRadius: number;
  poolDps: number;
  poolLife: number;
}

interface AcidPool {
  active: boolean;
  pos: THREE.Vector3;
  radius: number;
  life: number;
  maxLife: number;
  dps: number;
  tick: number;
}

const _gv = new THREE.Vector3();
const _gv2 = new THREE.Vector3();
const _gm = new THREE.Matrix4();
const _gs = new THREE.Vector3();
const _gq = new THREE.Quaternion();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _bioDamage: DamageInfo = {
  amount: 0,
  element: 'solar',
  region: 'body',
  precision: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  direction: new THREE.Vector3(0, -1, 0),
  sourceId: 0,
  splash: true,
  impulse: 0,
};

/**
 * Lobbed acid globs and the corrosive pools they leave.
 *
 * Two `InstancedMesh`es, both additive and depth-write-off, so the whole system
 * is **two draw calls** however many globs are in the air. Capacities come from
 * `settings.profile.particleBudget` — a low tier gets a smaller sky.
 *
 * Stepping: `advance()` is guarded on a monotonically increasing simulation
 * clock, so every agent's behaviour tick may call it and only the first one per
 * simulation advance does work.
 */
export class BioField {
  private globs: Glob[] = [];
  private pools: AcidPool[] = [];
  private globMesh: THREE.InstancedMesh;
  private poolMesh: THREE.InstancedMesh;
  private globGeo: THREE.BufferGeometry;
  private poolGeo: THREE.BufferGeometry;
  private globMat: THREE.MeshBasicMaterial;
  private poolMat: THREE.MeshBasicMaterial;
  private root = new THREE.Group();
  private scene: THREE.Object3D | null = null;
  private clock = -1;
  private dirty = true;

  constructor(color: number, name: string) {
    const budget = settings.profile.particleBudget;
    const globCap = Math.round(clamp(budget / 220, 8, 48));
    const poolCap = Math.round(clamp(budget / 340, 6, 32));

    for (let i = 0; i < globCap; i++) {
      this.globs.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        damage: 0,
        poolRadius: 0,
        poolDps: 0,
        poolLife: 0,
      });
    }
    for (let i = 0; i < poolCap; i++) {
      this.pools.push({
        active: false,
        pos: new THREE.Vector3(),
        radius: 0,
        life: 0,
        maxLife: 1,
        dps: 0,
        tick: 0,
      });
    }

    this.globGeo = new THREE.IcosahedronGeometry(1, 1);
    // A flat ring-ish disc: the outer rim is transparent in the vertex colour so
    // a pool fades into the ground instead of ending on a hard circle.
    this.poolGeo = new THREE.CircleGeometry(1, 20);
    this.poolGeo.rotateX(-Math.PI / 2);

    this.globMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.poolMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.globMesh = new THREE.InstancedMesh(this.globGeo, this.globMat, globCap);
    this.poolMesh = new THREE.InstancedMesh(this.poolGeo, this.poolMat, poolCap);
    for (const m of [this.globMesh, this.poolMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      this.root.add(m);
    }
    this.globMesh.renderOrder = 7;
    this.poolMesh.renderOrder = 5;
    for (let i = 0; i < globCap; i++) this.globMesh.setMatrixAt(i, _hidden);
    for (let i = 0; i < poolCap; i++) this.poolMesh.setMatrixAt(i, _hidden);
    this.root.name = `bio:${name}`;
  }

  /** Attach to whatever scene the agent lives in. Cheap to call repeatedly. */
  private attach(from: THREE.Object3D): void {
    let o: THREE.Object3D = from;
    while (o.parent) o = o.parent;
    if (this.scene === o) return;
    this.scene = o;
    o.add(this.root);
  }

  /** Launch a glob on a ballistic arc that lands on `to`. */
  lob(
    origin: THREE.Object3D,
    from: THREE.Vector3,
    to: THREE.Vector3,
    arc: number,
    speed: number,
    damage: number,
    poolRadius: number,
    poolDps: number,
    poolLife: number,
  ): boolean {
    this.attach(origin);
    let g: Glob | null = null;
    for (const c of this.globs) {
      if (!c.active) {
        g = c;
        break;
      }
    }
    if (!g) return false;

    // Solve the launch for a fixed flight time so the arc height is authored
    // rather than emergent — a lob the player cannot read is not a telegraph.
    _gv.subVectors(to, from);
    const horiz = Math.hypot(_gv.x, _gv.z);
    const t = clamp(horiz / Math.max(1, speed), 0.35, 2.6);
    g.active = true;
    g.pos.copy(from);
    g.vel.set(_gv.x / t, _gv.y / t + 0.5 * arc * t, _gv.z / t);
    g.life = t + 1.5;
    g.damage = damage;
    g.poolRadius = poolRadius;
    g.poolDps = poolDps;
    g.poolLife = poolLife;
    vSetGravity(g, arc);
    this.dirty = true;
    return true;
  }

  /**
   * Advance the simulation. Safe to call from every agent's behaviour tick:
   * `clock` must strictly increase, so only the first caller per simulation
   * advance does work and `dt` is exactly the elapsed simulation time.
   */
  advance(ctx: BehaviourContext): void {
    if (this.clock < 0) {
      this.clock = ctx.elapsed;
      return;
    }
    const dt = ctx.elapsed - this.clock;
    if (dt <= 0) return;
    this.clock = ctx.elapsed;
    this.step(Math.min(dt, 0.25), ctx);
  }

  private step(dt: number, ctx: BehaviourContext): void {
    const collision = ctx.collision;
    let live = false;

    for (const g of this.globs) {
      if (!g.active) continue;
      live = true;
      g.vel.y -= gravityOf(g) * dt;
      _gv2.copy(g.pos);
      g.pos.addScaledVector(g.vel, dt);
      g.life -= dt;

      let land = -1;
      if (collision) {
        const ground = collision.sampleGround(g.pos.x, g.pos.z, _gv2.y + 4);
        if (ground && g.pos.y <= ground.y + 0.12) land = ground.y;
      } else if (g.pos.y <= 0) {
        land = 0;
      }
      if (land < 0 && g.life > 0) continue;

      g.active = false;
      g.pos.y = land >= 0 ? land + 0.03 : g.pos.y;
      ctx.vfx.impact(g.pos, _gv.set(0, 1, 0), 'organic', 1.1);
      ctx.vfx.elementalBurst(g.pos, 'solar', 0.7);
      this.splash(g, ctx);
      this.openPool(g);
    }

    for (const p of this.pools) {
      if (!p.active) continue;
      live = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.tick -= dt;
      if (p.tick > 0 || !ctx.targetValid || !ctx.target || ctx.target.isDead) continue;
      p.tick = 0.4;
      ctx.target.getWorldPosition(_gv);
      const dx = _gv.x - p.pos.x;
      const dz = _gv.z - p.pos.z;
      const dy = _gv.y - p.pos.y;
      if (dx * dx + dz * dz > p.radius * p.radius || dy < -1.5 || dy > 2.6) continue;
      _bioDamage.amount = p.dps * 0.4;
      _bioDamage.point.copy(_gv);
      _bioDamage.direction.set(0, -1, 0);
      _bioDamage.normal.set(0, 1, 0);
      ctx.target.applyDamage(_bioDamage);
    }

    if (live || this.dirty) this.upload();
    this.dirty = live;
  }

  private splash(g: Glob, ctx: BehaviourContext): void {
    if (!ctx.targetValid || !ctx.target || ctx.target.isDead) return;
    ctx.target.getWorldPosition(_gv);
    const d = _gv.distanceTo(g.pos);
    const r = g.poolRadius + 0.9;
    if (d > r) return;
    _bioDamage.amount = g.damage * (1 - clamp01(d / r) * 0.6);
    _bioDamage.point.copy(g.pos);
    _bioDamage.direction.subVectors(_gv, g.pos).normalize();
    _bioDamage.normal.set(0, 1, 0);
    ctx.target.applyDamage(_bioDamage);
  }

  private openPool(g: Glob): void {
    if (g.poolLife <= 0) return;
    let best: AcidPool | null = null;
    for (const p of this.pools) {
      if (!p.active) {
        best = p;
        break;
      }
      if (!best || p.life < best.life) best = p;
    }
    if (!best) return;
    best.active = true;
    best.pos.copy(g.pos);
    best.radius = g.poolRadius;
    best.life = g.poolLife;
    best.maxLife = g.poolLife;
    best.dps = g.poolDps;
    best.tick = 0;
  }

  private upload(): void {
    _gq.identity();
    for (let i = 0; i < this.globs.length; i++) {
      const g = this.globs[i];
      if (!g.active) {
        this.globMesh.setMatrixAt(i, _hidden);
        continue;
      }
      // Stretch along the velocity so a fast glob reads as a thrown blob.
      const sp = g.vel.length();
      _gs.set(0.16, 0.16, 0.16 + clamp(sp * 0.012, 0, 0.16));
      _gq.setFromUnitVectors(_gv.set(0, 0, 1), _gv2.copy(g.vel).normalize());
      _gm.compose(g.pos, _gq, _gs);
      this.globMesh.setMatrixAt(i, _gm);
    }
    for (let i = 0; i < this.pools.length; i++) {
      const p = this.pools[i];
      if (!p.active) {
        this.poolMesh.setMatrixAt(i, _hidden);
        continue;
      }
      // Grow fast, fade slow: a pool that pops to full size reads as a decal.
      const age = 1 - p.life / Math.max(0.001, p.maxLife);
      const r = p.radius * smoothstep(clamp01(age * 6)) * lerp(1, 0.78, clamp01(age));
      _gs.set(r, 1, r);
      _gm.compose(p.pos, _gq.identity(), _gs);
      this.poolMesh.setMatrixAt(i, _gm);
    }
    this.globMesh.instanceMatrix.needsUpdate = true;
    this.poolMesh.instanceMatrix.needsUpdate = true;
  }

  /** Wipe everything and detach. Call between levels. */
  clear(): void {
    for (const g of this.globs) g.active = false;
    for (const p of this.pools) p.active = false;
    this.clock = -1;
    this.dirty = true;
    this.upload();
    this.root.removeFromParent();
    this.scene = null;
  }

  dispose(): void {
    this.clear();
    this.globGeo.dispose();
    this.poolGeo.dispose();
    this.globMat.dispose();
    this.poolMat.dispose();
    this.globMesh.dispose();
    this.poolMesh.dispose();
  }
}

// Glob gravity is stored out-of-band so the record stays a flat, poolable shape.
const globGravity = new WeakMap<Glob, number>();
function vSetGravity(g: Glob, arc: number): void {
  globGravity.set(g, arc);
}
function gravityOf(g: Glob): number {
  return globGravity.get(g) ?? 24;
}

/** The faction's acid. Shared by every spitter and by the Apex's flood phase. */
export const MANTIS_ACID = new BioField(0xb6ff3a, 'mantis-acid');

// ---------------------------------------------------------------------------
// Spawner seam
// ---------------------------------------------------------------------------

/** The slice of `EnemyManager` the summoning units need. */
export interface FactionSpawner {
  spawn(archetypeId: string, position: THREE.Vector3, yaw: number): unknown;
}

let spawner: FactionSpawner | null = null;

/**
 * Give the summoning units (Matriarch clutches, the Apex's brood) a way to make
 * more Mantis. The level owner calls `bindMantisSpawner(enemies)` after
 * `enemies.bindLevel(level)`. Unbound, those units simply skip their summon and
 * everything else about them still works.
 */
export function bindMantisSpawner(host: FactionSpawner | null): void {
  spawner = host;
}

const _spawnPos = new THREE.Vector3();

function summon(agent: EnemyAgent, id: string, count: number, radius: number): number {
  if (!spawner) return 0;
  let made = 0;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + agent.yaw;
    _spawnPos.set(
      agent.position.x + Math.sin(a) * radius,
      agent.position.y + 0.2,
      agent.position.z + Math.cos(a) * radius,
    );
    if (spawner.spawn(id, _spawnPos, a + Math.PI)) made++;
  }
  return made;
}

// ---------------------------------------------------------------------------
// Body kit
// ---------------------------------------------------------------------------

interface LegPlan {
  /** femur, tibia, metatarsus, foot, toe-tip. */
  lengths: [number, number, number, number, number];
  bends: [number, number, number, number];
  splay: number;
  /** Forward offset of the hip from the body centre. */
  dz: number;
  radius: number;
}

/** hip height that puts this leg's foot flat on y = 0. */
function hipHeightFor(plan: LegPlan): number {
  const drop = chainReachDown(plan.lengths, plan.bends, 3);
  return -drop.dy + plan.lengths[3] * 0.85;
}

function addLegChain(
  rig: Rig,
  id: string,
  parent: string,
  plan: LegPlan,
  side: -1 | 1,
  gaitPhase?: number,
): void {
  rig.chain(id, ['hip', 'knee', 'hock', 'ankle', 'toe'], plan.lengths.slice(), {
    parent,
    origin: v(side * plan.splay, 0, plan.dz),
    gaitPhase,
    direction: DOWN,
    pole: FORWARD,
    kind: 'leg',
    side,
    restBend: plan.bends.slice(),
    capture: [
      plan.radius * 2.4,
      plan.radius * 2.1,
      plan.radius * 1.9,
      plan.radius * 1.6,
      plan.radius * 1.4,
    ],
  });
}

/**
 * A mantis leg: a fat thigh, a long thin shin, a longer metatarsus with a
 * spur, and a splayed three-toed claw. The knee and hock both carry a small
 * armour scute, which is what stops the leg reading as bent wire in silhouette.
 */
function addLegGeometry(b: BodyBuilder, rig: Rig, id: string, plan: LegPlan, side: -1 | 1): void {
  const hip = at(rig, `${id}.hip`);
  const knee = at(rig, `${id}.knee`);
  const hock = at(rig, `${id}.hock`);
  const ankle = at(rig, `${id}.ankle`);
  const toe = at(rig, `${id}.toe`);
  const tip = tipOf(rig, id);
  const r = plan.radius;

  // The femur carries all the jump power, so it is nearly twice the shin's
  // diameter. That taper is most of what separates a leg from a bent pipe.
  b.add('shell', b.taperedLimb({ from: hip, to: knee, r0: r * 1.5, r1: r * 0.82, jointR: r * 1.6, muscle: 1.55, flatten: 0.8, sides: 9 }));
  b.add('shell', b.taperedLimb({ from: knee, to: hock, r0: r * 0.74, r1: r * 0.46, jointR: r * 0.86, muscle: 1.12, flatten: 0.78, sides: 8 }));
  b.add('shell', b.taperedLimb({ from: hock, to: ankle, r0: r * 0.5, r1: r * 0.36, jointR: r * 0.58, muscle: 1.06, flatten: 0.8, sides: 8 }));
  // Scutes on the two visible joints.
  b.add('plate', b.plate({
    centre: knee.clone().addScaledVector(v(0, 0.05, -1).normalize(), r * 0.9),
    normal: v(side * 0.25, 0.15, -1).normalize(),
    width: r * 1.9,
    height: r * 2.0,
    thickness: r * 0.2,
    curve: 1.6,
    taper: 0.5,
    color: PLATE,
    edgeColor: SHELL_TIP,
  }));
  b.add('plate', b.plate({
    centre: hock.clone().addScaledVector(v(0, 0.1, 1).normalize(), r * 0.72),
    normal: v(side * 0.2, 0.1, 1).normalize(),
    width: r * 1.5,
    height: r * 1.7,
    thickness: r * 0.18,
    curve: 1.45,
    taper: 0.5,
    color: PLATE,
    edgeColor: SHELL_TIP,
  }));
  // A tibial spur — praying mantis legs are famously spined.
  b.add('blade', b.spine({ base: hock.clone().add(v(0, 0.02, 0.02)), direction: v(side * 0.2, 0.55, 0.82).normalize(), length: r * 3.4, radius: r * 0.3, curve: r * 0.5, color: BLADE }));

  b.add('shell', b.segment({ from: ankle, to: toe, r0: r * 0.34, r1: r * 0.3, flatten: 0.72, sides: 7 }));
  for (let d = -1; d <= 1; d++) {
    b.add('blade', b.digit({
      base: toe.clone().add(v(d * r * 0.34, 0, 0)),
      direction: v(d * 0.42, -0.34, -1).normalize(),
      length: Math.max(0.05, tip.distanceTo(toe) + r * 1.5),
      radius: r * 0.24,
      joints: 2,
      curl: 0.42,
      color: BLADE,
    }));
  }
  // A rear dew-claw so the foot is not symmetric — reads instantly as a talon.
  b.add('blade', b.digit({ base: ankle.clone().add(v(0, -r * 0.1, r * 0.1)), direction: v(0, -0.25, 1).normalize(), length: r * 2, radius: r * 0.2, joints: 2, curl: 0.5, color: BLADE }));
}

interface BladePlan {
  /** base, femur, tibia(blade), hook. */
  lengths: [number, number, number, number];
  bends: [number, number, number, number];
  origin: THREE.Vector3;
  thickness: number;
  serrations: number;
}

function addBladeChain(rig: Rig, id: string, parent: string, plan: BladePlan, side: -1 | 1): void {
  rig.chain(id, ['base', 'femur', 'tibia', 'hook'], plan.lengths.slice(), {
    parent,
    origin: v(side * plan.origin.x, plan.origin.y, plan.origin.z),
    // Forward and marginally down at the shoulder; the per-joint bends then lift
    // the femur and fold the blade back underneath it. Mounting the chain
    // up-and-forward (the first attempt) put the folded blades across the face
    // and buried the head entirely.
    direction: v(side * 0.26, -0.12, -1).normalize(),
    pole: UP,
    // `generic`, not `arm`: the base animator's weapon-ready arm pass would drag
    // the blades into a soldier's low guard. The species poses them instead.
    kind: 'generic',
    side,
    restBend: plan.bends.slice(),
    capture: [plan.thickness * 3, plan.thickness * 3.4, plan.thickness * 4.4, plan.thickness * 3],
  });
}

/**
 * The raptorial arm. A knobbed coxa, a spined femur, and a flattened serrated
 * tibia blade that folds back along the femur at rest. The two-tone edge — pale
 * chitin body, near-black cutting edge — is what makes it read as a weapon at
 * distance rather than another limb.
 */
function addBladeGeometry(b: BodyBuilder, rig: Rig, id: string, plan: BladePlan, side: -1 | 1): void {
  const base = at(rig, `${id}.base`);
  const femur = at(rig, `${id}.femur`);
  const tibia = at(rig, `${id}.tibia`);
  const hook = at(rig, `${id}.hook`);
  const tip = tipOf(rig, id);
  const th = plan.thickness;

  b.add('shell', b.taperedLimb({ from: base, to: femur, r0: th * 1.5, r1: th * 1.15, jointR: th * 1.7, muscle: 1.3, flatten: 0.85, sides: 9 }));
  b.add('shell', b.taperedLimb({ from: femur, to: tibia, r0: th * 1.25, r1: th * 0.8, jointR: th * 1.5, muscle: 1.22, flatten: 0.62, sides: 9 }));
  // Femoral spines — the gripping teeth that trap prey against the blade.
  const fdir = tibia.clone().sub(femur);
  const flen = fdir.length();
  fdir.normalize();
  // Straight down, with the along-the-femur component projected out, so the
  // spines stand off the underside of the limb whatever angle it is held at.
  const fnorm = v(0, -1, 0).addScaledVector(fdir, fdir.y).normalize();
  for (let i = 0; i < 4; i++) {
    const t = 0.2 + (i / 3) * 0.62;
    b.add('blade', b.spine({
      base: femur.clone().addScaledVector(fdir, flen * t),
      direction: fnorm.clone().addScaledVector(fdir, 0.16).normalize(),
      length: th * (2.0 - Math.abs(i - 1.5) * 0.3),
      radius: th * 0.3,
      curve: th * 0.25,
      color: BLADE,
    }));
  }
  // The blade itself: a long flattened serrated scythe.
  b.add('blade', b.mandible({
    base: tibia,
    direction: hook.clone().sub(tibia).normalize(),
    inward: v(0, -1, 0),
    length: tibia.distanceTo(hook) * 1.06,
    thickness: th * 2.5,
    flatten: 0.3,
    serrations: plan.serrations,
    color: BLADE,
    colorTip: 0x35422a,
  }));
  // A pale spine along the blade's back, so it is not a black void in shadow.
  b.add('plate', b.segment({
    from: tibia.clone().add(v(0, th * 0.5, 0)),
    to: hook.clone().add(v(0, th * 0.35, 0)),
    r0: th * 0.55,
    r1: th * 0.2,
    flatten: 0.5,
    sides: 6,
    color: PLATE,
    colorTip: SHELL_TIP,
  }));
  b.add('blade', b.digit({ base: hook, direction: tip.clone().sub(hook).normalize(), length: Math.max(0.05, hook.distanceTo(tip) * 1.3), radius: th * 0.5, joints: 2, curl: 0.5, color: BLADE }));
  // Joint seam glow at the elbow — the faction's bioluminescent language.
  b.add('glow', b.lens({ centre: tibia.clone().add(v(side * th * 0.6, 0, 0)), normal: v(side, 0.2, 0).normalize(), radius: th * 0.75, bulge: 0.5, coreColor: 0xe8ffb0 }));
}

interface HeadPlan {
  /** Distance from the neck joint to the front of the wedge. */
  size: number;
  eyeR: number;
  crest: number;
  antenna: number;
  jaws: number;
}

/**
 * The triangular skull: a wide flat wedge, two dome eyes taking a third of it,
 * a small jaw cluster and two long antennae. Everything about the head is
 * pushed to the extremes of the wedge because a mantis head reads by its
 * corners, not its mass.
 */
function addHeadGeometry(b: BodyBuilder, head: THREE.Vector3, front: THREE.Vector3, p: HeadPlan): void {
  const f = front.clone().normalize();
  const up = v(0, 1, 0).addScaledVector(f, -f.y).normalize();
  const right = new THREE.Vector3().crossVectors(f, up).normalize();
  const s = p.size;
  const nose = head.clone().addScaledVector(f, s);

  // Wedge skull: a wide flat 4-sided loft that narrows to the mouth.
  b.add('shell', b.segment({
    from: head.clone().addScaledVector(f, -s * 0.55),
    to: nose,
    r0: s * 1.25,
    r1: s * 0.38,
    flatten: 0.46,
    bulge: 1.06,
    sides: 7,
    faceted: true,
    color: SHELL,
    colorTip: SHELL_TIP,
  }));
  // The occiput: a short backward wedge so the skull has a back to it and the
  // triangle reads from behind as well as head-on.
  b.add('plate', b.segment({
    from: head.clone().addScaledVector(f, -s * 0.55),
    to: head.clone().addScaledVector(f, -s * 0.95).addScaledVector(up, s * 0.1),
    r0: s * 1.2,
    r1: s * 0.5,
    flatten: 0.5,
    sides: 7,
    faceted: true,
    color: PLATE,
    colorTip: SHELL_TIP,
  }));
  // Brow ridge across the top of the wedge.
  b.add('plate', b.plate({
    centre: head.clone().addScaledVector(f, s * 0.12).addScaledVector(up, s * 0.5),
    normal: up.clone().addScaledVector(f, 0.45).normalize(),
    up: f.clone(),
    width: s * 2.05,
    height: s * 1.15,
    thickness: s * 0.1,
    curve: 1.5,
    taper: 0.55,
    color: PLATE,
    edgeColor: SHELL_TIP,
  }));

  for (const side of [-1, 1] as const) {
    const eye = head
      .clone()
      .addScaledVector(f, s * 0.24)
      .addScaledVector(right, side * s * 0.82)
      .addScaledVector(up, s * 0.3);
    // Compound eye: a large dome, plus a bright inner pseudo-pupil.
    b.add('glow', b.lens({
      centre: eye,
      normal: right.clone().multiplyScalar(side).addScaledVector(f, 0.62).addScaledVector(up, 0.2).normalize(),
      radius: p.eyeR,
      bulge: 1.05,
      segments: 14,
      color: 0x8fd83a,
      coreColor: 0xf4ffd0,
    }));
    b.add('shell', b.segment({
      from: eye.clone().addScaledVector(right, -side * p.eyeR * 0.45),
      to: eye.clone().addScaledVector(right, side * p.eyeR * 0.1),
      r0: p.eyeR * 1.16,
      r1: p.eyeR * 1.02,
      flatten: 1.05,
      sides: 10,
      color: SHELL,
    }));
    // Antenna: the single most identifying line in the silhouette.
    if (p.antenna > 0) {
      b.add('blade', b.spine({
        base: head.clone().addScaledVector(f, s * 0.42).addScaledVector(right, side * s * 0.3).addScaledVector(up, s * 0.42),
        direction: f.clone().multiplyScalar(0.55).addScaledVector(up, 0.78).addScaledVector(right, side * 0.3).normalize(),
        length: p.antenna,
        radius: s * 0.09,
        curve: p.antenna * 0.4,
        curveAxis: f.clone().negate(),
        sharpness: 1.15,
        color: BLADE,
        colorTip: SHELL_TIP,
      }));
    }
    // Jaw palps.
    b.add('blade', b.mandible({
      base: nose.clone().addScaledVector(right, side * s * 0.2).addScaledVector(up, -s * 0.2),
      direction: f.clone().addScaledVector(up, -0.5).normalize(),
      inward: right.clone().multiplyScalar(-side),
      length: p.jaws,
      thickness: s * 0.13,
      flatten: 0.45,
      serrations: 3,
      color: BLADE,
    }));
  }
  if (p.crest > 0) {
    b.add('plate', b.horn({
      base: head.clone().addScaledVector(up, s * 0.62).addScaledVector(f, -s * 0.1),
      direction: up.clone().addScaledVector(f, -0.55).normalize(),
      length: p.crest,
      radius: s * 0.24,
      curve: p.crest * 0.3,
      ridges: 5,
      twist: 0.2,
      color: PLATE,
      colorTip: SHELL_TIP,
    }));
  }
}

/** Register the four faction materials on a builder. */
function mantisMaterials(b: BodyBuilder): void {
  // `repeat` below 1 on purpose. The library surfaces already run their pattern
  // at 3x the UV, and the loft primitives add another 1.4-1.6, so anything at or
  // above 1 turns a 40 cm limb into speckled camouflage instead of chitin.
  // Three things had to be tuned together here, and getting any one wrong made
  // the creature look like painted plastic:
  //
  // 1. `repeat` (the shader's UV scale) at 0.2. The library surfaces already run
  //    their pattern at 3x UV and the chitin lattice at another 4x/7x on top, so
  //    anything near 1 produced ~30 bands along a 50 cm limb — visible as
  //    stripes, not as plates.
  // 2. No `roughness` override. The recipes output a roughness map running
  //    0.1-0.9; multiplying that by a constant below 1 turned everything to
  //    wet glass.
  // 3. `envMapIntensity` pulled down. Chitin is waxy, not chrome; at full
  //    strength the IBL washed the albedo out entirely.
  const shell = b.material('shell', 'mantisResin', { color: SHELL, repeat: 0.2 });
  shell.envMapIntensity = 0.5;
  const plate = b.material('plate', 'chitin', { color: PLATE, repeat: 0.26 });
  plate.envMapIntensity = 0.55;
  const blade = b.material('blade', 'chitin', { color: BLADE, repeat: 0.34 });
  blade.envMapIntensity = 0.9;
  b.emissive('glow', MANTIS_GLOW, 3.4);
}

// ---------------------------------------------------------------------------
// Unit bodies
// ---------------------------------------------------------------------------

interface MantisPlan {
  leg: LegPlan;
  blade: BladePlan;
  /** Second (lower) blade pair; null for units with only one pair. */
  blade2: BladePlan | null;
  lowerArms: boolean;
  /** lumbar, thorax, neck, head spans, plus the head tip. */
  spine: [number, number, number, number, number];
  spineBend: [number, number, number, number, number];
  thoraxR: number;
  abdomen: number[];
  abdomenR: number;
  abdomenDroop: number;
  head: HeadPlan;
  wings: number;
  height: number;
  accent: number;
}

/**
 * The shared bipedal Mantis body. Every unit but the Apex is one of these with
 * different numbers; the plan is deliberately explicit so a reviewer can read
 * the proportions of all five units side by side.
 */
function buildMantisBiped(ctx: BodyBuildContext, p: MantisPlan): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  mantisMaterials(b);

  const hipY = hipHeightFor(p.leg);
  rig.chain('spine', ['hips', 'lumbar', 'thorax', 'neck', 'head'], p.spine.slice(), {
    origin: v(0, hipY, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: p.spineBend.slice(),
    capture: [p.thoraxR * 1.5, p.thoraxR * 1.6, p.thoraxR * 1.5, p.thoraxR * 0.9, p.head.size * 1.3],
  });
  rig.chain('abdomen', ['a0', 'a1', 'a2', 'a3'], p.abdomen.slice(), {
    parent: 'spine.hips',
    origin: v(0, p.abdomenR * 0.3, p.abdomenR * 0.5),
    direction: v(0, -p.abdomenDroop, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [p.abdomenR * 2, p.abdomenR * 1.9, p.abdomenR * 1.7, p.abdomenR * 1.4],
  });

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    addLegChain(rig, `leg.${s}`, 'spine.hips', p.leg, side);
    addBladeChain(rig, `blade.${s}`, 'spine.thorax', p.blade, side);
    if (p.blade2) addBladeChain(rig, `blade2.${s}`, 'spine.lumbar', p.blade2, side);
    if (p.lowerArms) {
      rig.chain(`grasp.${s}`, ['shoulder', 'elbow', 'hand'], [p.thoraxR * 1.1, p.thoraxR * 0.95, p.thoraxR * 0.4], {
        parent: 'spine.lumbar',
        origin: v(side * p.thoraxR * 0.78, p.thoraxR * 0.1, -p.thoraxR * 0.25),
        direction: v(side * 0.42, -0.5, -0.76).normalize(),
        pole: UP,
        kind: 'generic',
        side,
        restBend: [0.2, 1.1, 0.4],
        capture: [p.thoraxR * 0.8, p.thoraxR * 0.7, p.thoraxR * 0.55],
      });
    }
    if (p.wings > 0) {
      for (let w = 0; w < p.wings; w++) {
        rig.chain(`wing.${s}${w}`, ['root', 'mid', 'tip'], [p.thoraxR * 2.2, p.thoraxR * 2.1, p.thoraxR * 1.5], {
          parent: w === 0 ? 'spine.thorax' : 'spine.lumbar',
          origin: v(side * p.thoraxR * 0.55, p.thoraxR * (w === 0 ? 0.5 : 0.2), p.thoraxR * 0.6),
          direction: v(side, 0.24 - w * 0.28, 0.5).normalize(),
          pole: UP,
          kind: 'wing',
          side,
          restBend: [0, -0.16, -0.1],
          capture: [p.thoraxR * 1.6, p.thoraxR * 1.6, p.thoraxR * 1.4],
        });
      }
    }
  }

  // -- geometry -------------------------------------------------------------
  const hips = at(rig, 'spine.hips');
  const lumbar = at(rig, 'spine.lumbar');
  const thorax = at(rig, 'spine.thorax');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');
  const R = p.thoraxR;

  b.add('shell', b.taperedLimb({ from: hips.clone().add(v(0, -R * 0.3, R * 0.2)), to: lumbar, r0: R * 0.95, r1: R * 0.85, jointR: R, muscle: 1.12, flatten: 0.8, sides: 11 }));
  // The prothorax: long, narrow, ridged. This is the mantis' defining volume.
  b.add('shell', b.taperedLimb({ from: lumbar, to: thorax, r0: R * 0.85, r1: R * 0.62, jointR: R * 0.9, muscle: 1.05, flatten: 0.66, ridges: 5, ridgeDepth: 0.04, sides: 11 }));
  b.add('shell', b.segment({ from: thorax, to: neck, r0: R * 0.58, r1: R * 0.34, flatten: 0.8, sides: 9 }));
  b.add('shell', b.segment({ from: neck.clone().addScaledVector(headTip.clone().sub(neck).normalize(), -R * 0.1), to: head, r0: R * 0.34, r1: R * 0.3, flatten: 0.9, sides: 8 }));

  // Dorsal plates down the thorax — three overlapping scutes, each catching a
  // highlight along its rim. One long shell reads as a bean; three read as chitin.
  const spineDir = thorax.clone().sub(lumbar).normalize();
  for (let i = 0; i < 3; i++) {
    const t = 0.1 + i * 0.34;
    b.add('plate', b.plate({
      centre: lumbar.clone().lerp(thorax, t).addScaledVector(v(0, 0, 1), R * 0.5),
      normal: v(0, 0.3, 1).normalize(),
      up: spineDir.clone(),
      width: R * (1.9 - i * 0.24),
      height: R * 1.1,
      thickness: R * 0.11,
      curve: 1.6,
      taper: 0.78,
      color: PLATE,
      edgeColor: SHELL_TIP,
    }));
  }
  // Bioluminescent seams between the thoracic segments.
  for (let i = 0; i < 3; i++) {
    const t = 0.2 + i * 0.3;
    const c = lumbar.clone().lerp(thorax, t);
    for (const side of [-1, 1] as const) {
      b.add('glow', b.lens({
        centre: c.clone().add(v(side * R * 0.55, 0, R * 0.1)),
        normal: v(side, 0.1, 0.25).normalize(),
        radius: R * 0.2,
        bulge: 0.4,
        color: 0x7fd830,
        coreColor: 0xe4ffb4,
      }));
    }
  }
  // Shoulder yoke where the raptorial arms mount — the widest point.
  b.add('plate', b.plate({
    centre: thorax.clone().add(v(0, R * 0.1, -R * 0.25)),
    normal: v(0, 0.55, -1).normalize(),
    width: R * 2.6,
    height: R * 1.3,
    thickness: R * 0.13,
    curve: 1.9,
    taper: 0.7,
    color: PLATE,
    edgeColor: SHELL_TIP,
  }));

  addHeadGeometry(b, head, headTip.clone().sub(head).normalize(), p.head);

  // Abdomen: four tapering ridged segments, each stepped so the outline has
  // notches rather than being one smooth cone.
  const ab = ['abdomen.a0', 'abdomen.a1', 'abdomen.a2', 'abdomen.a3'];
  for (let i = 0; i < ab.length; i++) {
    const from = at(rig, ab[i]);
    const to = i + 1 < ab.length ? at(rig, ab[i + 1]) : tipOf(rig, 'abdomen');
    const r0 = p.abdomenR * (1 - i * 0.16);
    const r1 = p.abdomenR * (1 - (i + 1) * 0.19);
    b.add('shell', b.segment({ from, to, r0, r1, bulge: 1.12, flatten: 0.86, ridges: 6, ridgeDepth: 0.045, sides: 10, color: SHELL, colorTip: SHELL_TIP }));
    b.add('plate', b.plate({
      centre: from.clone().lerp(to, 0.45).add(v(0, r0 * 0.72, 0)),
      normal: v(0, 1, 0.2).normalize(),
      up: to.clone().sub(from).normalize(),
      width: r0 * 2.1,
      height: from.distanceTo(to) * 0.9,
      thickness: r0 * 0.16,
      curve: 1.3,
      taper: 0.82,
      color: PLATE,
      edgeColor: SHELL_TIP,
    }));
    if (i < 3) {
      for (const side of [-1, 1] as const) {
        b.add('glow', b.lens({ centre: from.clone().lerp(to, 0.5).add(v(side * r0 * 0.82, 0, 0)), normal: v(side, 0, 0), radius: r0 * 0.22, bulge: 0.5, color: 0x8ce33a, coreColor: 0xe8ffc0 }));
      }
    }
  }

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    addLegGeometry(b, rig, `leg.${s}`, p.leg, side);
    addBladeGeometry(b, rig, `blade.${s}`, p.blade, side);
    if (p.blade2) addBladeGeometry(b, rig, `blade2.${s}`, p.blade2, side);
    if (p.lowerArms) {
      const sh = at(rig, `grasp.${s}.shoulder`);
      const el = at(rig, `grasp.${s}.elbow`);
      const hd = at(rig, `grasp.${s}.hand`);
      const ht = tipOf(rig, `grasp.${s}`);
      b.add('shell', b.taperedLimb({ from: sh, to: el, r0: R * 0.2, r1: R * 0.15, jointR: R * 0.23, muscle: 1.24, sides: 8 }));
      b.add('shell', b.taperedLimb({ from: el, to: hd, r0: R * 0.16, r1: R * 0.11, jointR: R * 0.18, muscle: 1.1, sides: 8 }));
      for (let d = -1; d <= 1; d++) {
        b.add('blade', b.digit({ base: hd.clone().add(v(d * R * 0.07, 0, 0)), direction: ht.clone().sub(hd).normalize().add(v(d * 0.3, -0.2, 0)).normalize(), length: R * 0.42, radius: R * 0.05, joints: 2, curl: 0.55, color: BLADE }));
      }
    }
    for (let w = 0; w < p.wings; w++) {
      const id = `wing.${s}${w}`;
      const root = at(rig, `${id}.root`);
      const mid = at(rig, `${id}.mid`);
      const wtip = at(rig, `${id}.tip`);
      const end = tipOf(rig, id);
      b.add('shell', b.taperedLimb({ from: root, to: mid, r0: R * 0.16, r1: R * 0.1, jointR: R * 0.18, muscle: 1.1, sides: 7 }));
      b.add('shell', b.taperedLimb({ from: mid, to: wtip, r0: R * 0.1, r1: R * 0.06, jointR: R * 0.11, muscle: 1.05, sides: 7 }));
      // Membrane: a very flattened loft with a bow, so it reads as a wing.
      b.add('plate', b.segment({
        from: root.clone().add(v(0, 0, R * 0.06)),
        to: end,
        r0: R * (w === 0 ? 0.95 : 0.75),
        r1: R * 0.18,
        flatten: 0.055,
        bend: R * 0.5,
        bendAxis: v(0, 0, 1),
        sides: 8,
        steps: 9,
        color: 0x9fbf52,
        colorTip: 0xd8ff92,
      }));
      b.add('blade', b.spine({ base: wtip, direction: v(side * 0.4, -0.15, 0.9).normalize(), length: R * 0.7, radius: R * 0.06, color: BLADE }));
    }
  }

  const proxies: ProxySpec[] = [
    { region: 'head', bone: 'spine.head', radius: p.head.size * 0.95, multiplier: 2.4 },
    { region: 'body', bone: 'spine.thorax', radius: R * 0.85, halfHeight: R * 0.5, multiplier: 1 },
    { region: 'body', bone: 'spine.lumbar', radius: R * 0.9, multiplier: 1 },
    { region: 'body', bone: 'abdomen.a1', radius: p.abdomenR * 1.15, multiplier: 1 },
    { region: 'limb', bone: 'leg.L.knee', radius: p.leg.radius * 1.7, multiplier: 0.55 },
    { region: 'limb', bone: 'leg.R.knee', radius: p.leg.radius * 1.7, multiplier: 0.55 },
    { region: 'limb', bone: 'blade.L.femur', radius: p.blade.thickness * 2.1, multiplier: 0.5 },
    { region: 'limb', bone: 'blade.R.femur', radius: p.blade.thickness * 2.1, multiplier: 0.5 },
    // The exposed seam where the prothorax meets the neck. Every Mantis has one
    // and every Mantis dies fast if you find it.
    { region: 'critSpot', bone: 'spine.neck', offset: v(0, 0, R * 0.35), radius: R * 0.34, multiplier: 3.2 },
  ];

  return {
    rig,
    parts: b.finish(),
    height: p.height,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: p.accent,
    shieldRadius: p.height * 0.5,
    tuning: {
      runSpeed: 8,
      strideScale: 0.72,
      kneeSign: 1,
      bob: 0.05,
      sway: 0.028,
      liftScale: 0.4,
      leanAccel: 0.026,
      leanTurn: 0.2,
      breathRate: 0.85,
      breathAmount: 0.03,
      lookYawLimit: 2,
      lookPitchLimit: 1,
      wingRate: 5.5,
      wingAmplitude: 0.75,
    },
    hitProxies: proxies,
  };
}

// -- per-unit plans ----------------------------------------------------------

const NYMPH_PLAN: MantisPlan = {
  leg: { lengths: [0.29, 0.31, 0.24, 0.09, 0.06], bends: [0.78, -1.42, 0.86, 1.28], splay: 0.11, dz: 0.01, radius: 0.055 },
  blade: {
    lengths: [0.06, 0.22, 0.24, 0.07],
    bends: [0, 0.5, 2.52, -0.55],
    origin: v(0.11, -0.05, -0.06),
    thickness: 0.04,
    serrations: 5,
  },
  blade2: null,
  lowerArms: false,
  // Hunched almost to the horizontal: cumulative spine angles run
  // 0.35 / 0.85 / 1.05 / 0.90 / 1.50 rad, so the head is nearly over the toes.
  // That crouch is what makes a nymph read as small and feral rather than as a
  // scaled-down striker.
  spine: [0.13, 0.2, 0.11, 0.12, 0.12],
  spineBend: [0.35, 0.5, 0.2, -0.15, 0.6],
  thoraxR: 0.14,
  abdomen: [0.14, 0.13, 0.11, 0.08],
  abdomenR: 0.12,
  abdomenDroop: 0.5,
  // Oversized head for the body — the juvenile proportion, and it makes the
  // eyes readable even on a 1.2 m unit.
  head: { size: 0.155, eyeR: 0.085, crest: 0, antenna: 0.3, jaws: 0.09 },
  wings: 0,
  height: 1.18,
  accent: MANTIS_GLOW,
};

const STRIKER_PLAN: MantisPlan = {
  leg: { lengths: [0.55, 0.58, 0.44, 0.15, 0.09], bends: [0.7, -1.35, 0.85, 1.28], splay: 0.19, dz: 0.02, radius: 0.095 },
  blade: {
    lengths: [0.13, 0.46, 0.52, 0.13],
    bends: [0, 0.46, 2.5, -0.55],
    origin: v(0.21, -0.11, -0.1),
    thickness: 0.075,
    serrations: 9,
  },
  blade2: null,
  lowerArms: true,
  // Cumulative 0.06 / 0.50 / 0.84 / 0.54 / 1.35 rad: a long prothorax canted
  // ~48 degrees forward, then the skull levels off nearly horizontal so the
  // wedge points at the player instead of at the sky.
  spine: [0.24, 0.42, 0.26, 0.21, 0.2],
  spineBend: [0.06, 0.44, 0.34, -0.3, 0.81],
  thoraxR: 0.23,
  abdomen: [0.28, 0.25, 0.2, 0.14],
  abdomenR: 0.21,
  abdomenDroop: 0.4,
  head: { size: 0.27, eyeR: 0.125, crest: 0.2, antenna: 0.55, jaws: 0.16 },
  wings: 0,
  height: 2.45,
  accent: MANTIS_GLOW,
};

const SPITTER_PLAN: MantisPlan = {
  // Shorter, wider-splayed legs and a hunched spine: the spitter squats behind
  // its own abdomen, which is the reservoir it fires from.
  leg: { lengths: [0.44, 0.46, 0.36, 0.14, 0.09], bends: [0.86, -1.5, 0.9, 1.3], splay: 0.26, dz: 0.03, radius: 0.095 },
  blade: {
    lengths: [0.1, 0.28, 0.3, 0.09],
    bends: [0, 0.52, 2.54, -0.55],
    origin: v(0.2, -0.09, -0.08),
    thickness: 0.058,
    serrations: 5,
  },
  blade2: null,
  lowerArms: true,
  spine: [0.22, 0.3, 0.2, 0.19, 0.19],
  spineBend: [0.3, 0.5, 0.25, -0.25, 0.65],
  thoraxR: 0.25,
  // The tell: an enormous swollen acid sac that drags behind the body. It is
  // 70 % wider than the striker's and hangs lower, so the two never read alike
  // even at the same distance.
  abdomen: [0.36, 0.32, 0.26, 0.17],
  abdomenR: 0.36,
  abdomenDroop: 0.6,
  head: { size: 0.24, eyeR: 0.105, crest: 0, antenna: 0.38, jaws: 0.25 },
  wings: 0,
  height: 2.05,
  accent: MANTIS_GLOW,
};

const BLADELORD_PLAN: MantisPlan = {
  leg: { lengths: [0.72, 0.76, 0.58, 0.19, 0.11], bends: [0.68, -1.32, 0.84, 1.28], splay: 0.26, dz: 0.02, radius: 0.125 },
  blade: {
    lengths: [0.17, 0.6, 0.7, 0.16],
    bends: [0, 0.44, 2.48, -0.55],
    origin: v(0.29, -0.13, -0.12),
    thickness: 0.098,
    serrations: 11,
  },
  // The second pair mounts lower and shorter, so the four blades stack into a
  // layered fan rather than four parallel sticks.
  blade2: {
    lengths: [0.14, 0.44, 0.5, 0.12],
    bends: [0, 0.6, 2.62, -0.5],
    origin: v(0.25, -0.3, -0.06),
    thickness: 0.072,
    serrations: 8,
  },
  lowerArms: false,
  spine: [0.3, 0.52, 0.32, 0.26, 0.24],
  spineBend: [0.04, 0.36, 0.3, -0.25, 0.85],
  thoraxR: 0.31,
  abdomen: [0.34, 0.3, 0.25, 0.17],
  abdomenR: 0.26,
  abdomenDroop: 0.38,
  head: { size: 0.33, eyeR: 0.15, crest: 0.55, antenna: 0.7, jaws: 0.21 },
  wings: 0,
  height: 3.15,
  accent: MANTIS_GLOW,
};

const MATRIARCH_PLAN: MantisPlan = {
  leg: { lengths: [0.7, 0.74, 0.56, 0.18, 0.1], bends: [0.74, -1.4, 0.88, 1.3], splay: 0.23, dz: 0.02, radius: 0.1 },
  blade: {
    lengths: [0.14, 0.46, 0.5, 0.12],
    bends: [0, 0.5, 2.5, -0.55],
    origin: v(0.25, -0.11, -0.1),
    thickness: 0.075,
    serrations: 8,
  },
  blade2: null,
  lowerArms: true,
  spine: [0.28, 0.46, 0.3, 0.24, 0.22],
  spineBend: [0.04, 0.3, 0.26, -0.2, 0.85],
  thoraxR: 0.29,
  // A long ovipositor abdomen that trails under the hover — the clutch organ,
  // and the reason the matriarch reads as a different animal in the air.
  abdomen: [0.46, 0.4, 0.34, 0.26],
  abdomenR: 0.27,
  abdomenDroop: 0.72,
  head: { size: 0.3, eyeR: 0.135, crest: 0.42, antenna: 0.74, jaws: 0.17 },
  wings: 2,
  height: 3.55,
  accent: MANTIS_GLOW,
};

// -- the Apex ----------------------------------------------------------------

/**
 * The boss. Four reverse-jointed legs carrying a raised prothorax, four blades
 * on the raised section, a horn crown and a long segmented tail. The body plan
 * is deliberately *not* the biped: at 7 m the player has to read it as a
 * different animal from across the arena, and limb count is the fastest read.
 */
function buildMantisApex(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  mantisMaterials(b);

  // Front lengths are chosen so `hipHeightFor(front)` lands within a centimetre
  // of `hipHeightFor(back)`: both pairs mount at the same body height, and a
  // mismatch there is exactly how a quadruped ends up standing on tiptoe with
  // one pair locked straight and sliding.
  const front: LegPlan = { lengths: [1.18, 1.3, 1.01, 0.34, 0.18], bends: [0.72, -1.36, 0.86, 1.28], splay: 0.62, dz: -0.55, radius: 0.18 };
  const back: LegPlan = { lengths: [1.18, 1.28, 0.98, 0.3, 0.17], bends: [0.66, -1.28, 0.8, 1.28], splay: 0.7, dz: 0.5, radius: 0.19 };
  const hipY = hipHeightFor(back);
  const R = 0.6;

  // Spine runs FORWARD along the body like a quadruped, then the prothorax
  // climbs steeply out of the shoulders and the skull levels off.
  rig.chain('spine', ['hips', 'back', 'thorax', 'neck', 'head'], [1.05, 0.95, 0.85, 0.6, 0.55], {
    origin: v(0, hipY, 1.0),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    // Cumulative 0 / 0.06 / 1.01 / 1.26 / 0.16 rad: the prothorax climbs almost
    // 60 degrees out of the shoulders and the skull levels off pointing forward.
    restBend: [0, 0.06, 0.95, 0.25, -1.1],
    capture: [R * 1.7, R * 1.7, R * 1.5, R * 0.9, R * 1.1],
  });
  rig.chain('tail', ['t0', 't1', 't2', 't3', 't4'], [0.72, 0.66, 0.58, 0.46, 0.3], {
    parent: 'spine.hips',
    origin: v(0, 0.16, 0.3),
    direction: v(0, -0.18, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.6, 0.55, 0.5, 0.42, 0.34],
  });

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    // Diagonal trot: FL+BR together, FR+BL together. The rig's automatic
    // phasing assumes legs are declared front-pair-then-back-pair, which this
    // interleaved loop is not, so state it explicitly.
    addLegChain(rig, `leg.F${s}`, 'spine.back', front, side, side < 0 ? 0 : 0.5);
    addLegChain(rig, `leg.B${s}`, 'spine.hips', back, side, side < 0 ? 0.5 : 0);
  }

  const bladeMain: BladePlan = {
    lengths: [0.32, 1.25, 1.45, 0.34],
    bends: [0, 0.46, 2.46, -0.55],
    origin: v(0.52, -0.15, -0.2),
    thickness: 0.2,
    serrations: 13,
  };
  const bladeLow: BladePlan = {
    lengths: [0.26, 0.92, 1.05, 0.26],
    bends: [0, 0.62, 2.62, -0.5],
    origin: v(0.46, -0.45, 0.05),
    thickness: 0.15,
    serrations: 10,
  };
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    addBladeChain(rig, `blade.${s}`, 'spine.thorax', bladeMain, side);
    addBladeChain(rig, `blade2.${s}`, 'spine.thorax', bladeLow, side);
  }

  const hips = at(rig, 'spine.hips');
  const backB = at(rig, 'spine.back');
  const thorax = at(rig, 'spine.thorax');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  b.add('shell', b.taperedLimb({ from: hips.clone().add(v(0, 0, 0.5)), to: backB, r0: R * 0.9, r1: R * 1.05, jointR: R, muscle: 1.1, flatten: 0.92, sides: 13 }));
  b.add('shell', b.taperedLimb({ from: backB, to: thorax, r0: R * 1.05, r1: R * 0.78, jointR: R, muscle: 1.08, flatten: 0.72, ridges: 8, ridgeDepth: 0.07, sides: 13 }));
  b.add('shell', b.segment({ from: thorax, to: neck, r0: R * 0.7, r1: R * 0.4, flatten: 0.82, sides: 10 }));
  b.add('shell', b.segment({ from: neck, to: head, r0: R * 0.4, r1: R * 0.36, flatten: 0.92, sides: 9 }));

  // Carapace shell over the back, ridged, plus a row of dorsal spines.
  b.add('plate', b.carapace({ centre: backB.clone().add(v(0, R * 0.35, 0)), radius: R * 1.15, height: R * 0.7, length: 1.9, ridges: 7, ridgeDepth: 0.09, segments: 14, direction: UP, color: PLATE, colorTip: SHELL_TIP }));
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const c = hips.clone().lerp(thorax, t * 0.86);
    b.add('blade', b.spine({ base: c.clone().add(v(0, R * (0.55 + t * 0.2), 0)), direction: v(0, 0.86, 0.5 - t * 0.7).normalize(), length: R * (0.7 + t * 0.55), radius: R * 0.13, curve: R * 0.12, color: BLADE, colorTip: SHELL_TIP }));
    for (const side of [-1, 1] as const) {
      b.add('glow', b.lens({ centre: c.clone().add(v(side * R * 0.85, R * 0.1, 0)), normal: v(side, 0.15, 0).normalize(), radius: R * 0.24, bulge: 0.45, color: 0x8ce33a, coreColor: 0xeaffc0 }));
    }
  }
  // Shoulder yoke for the four blades.
  b.add('plate', b.plate({
    centre: thorax.clone().add(v(0, R * 0.18, R * 0.2)),
    normal: v(0, 0.6, 1).normalize(),
    width: R * 3.4,
    height: R * 1.8,
    thickness: R * 0.16,
    curve: 1.9,
    taper: 0.72,
    color: PLATE,
    edgeColor: SHELL_TIP,
  }));

  addHeadGeometry(b, head, headTip.clone().sub(head).normalize(), {
    size: 0.55,
    eyeR: 0.23,
    crest: 1.15,
    antenna: 1.35,
    jaws: 0.4,
  });
  // Crown of horns, only on the Apex.
  for (const side of [-1, 1] as const) {
    b.add('plate', b.horn({
      base: head.clone().add(v(side * 0.24, 0.3, 0.1)),
      direction: v(side * 0.55, 0.72, 0.42).normalize(),
      length: 0.95,
      radius: 0.1,
      curve: 0.3,
      ridges: 6,
      twist: 0.5,
      color: PLATE,
      colorTip: SHELL_TIP,
    }));
  }

  const tailBones = ['tail.t0', 'tail.t1', 'tail.t2', 'tail.t3', 'tail.t4'];
  for (let i = 0; i < tailBones.length; i++) {
    const from = at(rig, tailBones[i]);
    const to = i + 1 < tailBones.length ? at(rig, tailBones[i + 1]) : tipOf(rig, 'tail');
    const r0 = 0.44 - i * 0.075;
    const r1 = 0.44 - (i + 1) * 0.075;
    b.add('shell', b.segment({ from, to, r0, r1: Math.max(0.05, r1), bulge: 1.1, flatten: 0.88, ridges: 8, ridgeDepth: 0.07, sides: 10, color: SHELL, colorTip: SHELL_TIP }));
    b.add('blade', b.spine({ base: from.clone().lerp(to, 0.5).add(v(0, r0 * 0.8, 0)), direction: v(0, 0.8, 0.6).normalize(), length: r0 * 1.5, radius: r0 * 0.2, color: BLADE }));
    if (i < 4) b.add('glow', b.lens({ centre: from.clone().lerp(to, 0.5).add(v(0, -r0 * 0.7, 0)), normal: v(0, -1, 0), radius: r0 * 0.35, bulge: 0.4, color: 0x8ce33a, coreColor: 0xeaffc0 }));
  }

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    addLegGeometry(b, rig, `leg.F${s}`, front, side);
    addLegGeometry(b, rig, `leg.B${s}`, back, side);
    addBladeGeometry(b, rig, `blade.${s}`, bladeMain, side);
    addBladeGeometry(b, rig, `blade2.${s}`, bladeLow, side);
  }

  return {
    rig,
    parts: b.finish(),
    height: 7,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: MANTIS_GLOW,
    shieldRadius: 3.4,
    tuning: {
      runSpeed: 7.5,
      strideScale: 0.8,
      kneeSign: 1,
      bob: 0.09,
      sway: 0.02,
      liftScale: 0.34,
      leanAccel: 0.014,
      leanTurn: 0.12,
      breathRate: 0.4,
      breathAmount: 0.05,
      lookYawLimit: 1.4,
      lookPitchLimit: 0.9,
    },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.62, multiplier: 2 },
      { region: 'body', bone: 'spine.thorax', radius: 0.85, halfHeight: 0.5, multiplier: 1 },
      { region: 'body', bone: 'spine.back', radius: 0.95, halfHeight: 0.6, multiplier: 1 },
      { region: 'body', bone: 'tail.t1', radius: 0.5, multiplier: 1 },
      { region: 'limb', bone: 'leg.FL.knee', radius: 0.32, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.FR.knee', radius: 0.32, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.BL.knee', radius: 0.34, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.BR.knee', radius: 0.34, multiplier: 0.5 },
      // The four blade joints are the destructible limbs; hitting them hurts
      // the Apex more than body shots, which is the whole reason to aim there.
      { region: 'critSpot', bone: 'blade.L.tibia', radius: 0.34, multiplier: 2.2 },
      { region: 'critSpot', bone: 'blade.R.tibia', radius: 0.34, multiplier: 2.2 },
      { region: 'critSpot', bone: 'blade2.L.tibia', radius: 0.3, multiplier: 2.2 },
      { region: 'critSpot', bone: 'blade2.R.tibia', radius: 0.3, multiplier: 2.2 },
      // The soft thoracic seam under the raised prothorax.
      { region: 'critSpot', bone: 'spine.neck', offset: v(0, -0.3, 0.2), radius: 0.4, multiplier: 3 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Animation — the blade poses that carry every telegraph
// ---------------------------------------------------------------------------

interface BladeSet {
  chains: ChainRuntime[];
}

const bladeCache = new WeakMap<RigInstance, BladeSet>();

function bladesOf(rig: RigInstance): ChainRuntime[] {
  let set = bladeCache.get(rig);
  if (!set) {
    const chains = rig.chains.filter((c) => c.def.id.startsWith('blade'));
    set = { chains };
    bladeCache.set(rig, set);
  }
  return set.chains;
}

function graspOf(rig: RigInstance): ChainRuntime[] {
  return rig.chains.filter((c) => c.def.id.startsWith('grasp'));
}

const graspCache = new WeakMap<RigInstance, ChainRuntime[]>();

/**
 * Pose the raptorial arms.
 *
 * Rest is the folded "prayer": femur up-forward, tibia folded back along it.
 * The wind-up rears both blades up and back over the head and opens them a
 * little — a silhouette that is unmistakably *about to happen*. The strike
 * drives the femur down and forward and snaps the tibia through 130°.
 * `parry` is the Bladelord's crossed guard: blades pulled in front of the chest
 * and rotated inward so they overlap into a solid shield shape.
 */
function poseBlades(agent: EnemyAgent, dt: number, coil: number, swing: number, parry: number): void {
  const rig = agent.rig;
  const chains = bladesOf(rig);
  if (chains.length === 0) return;
  const t = agent.anim.locomotionWeight;
  const breathe = Math.sin(vGet(agent, 'mxPhase') * TAU) * 0.05;
  vSet(agent, 'mxPhase', (vGet(agent, 'mxPhase') + dt * 0.5) % 1);

  for (const chain of chains) {
    if (chain.bones.length < 4) continue;
    const lower = chain.def.id.startsWith('blade2');
    const side = chain.def.side || 1;
    // Severed limbs collapse to nothing — see `updateApexLimbs`.
    const sever = vGet(agent, `sev${chain.def.id}`);
    // Skinning reads `bone.matrixWorld`, which carries scale, so collapsing the
    // bones is a real amputation rather than a hidden mesh. Reset on respawn:
    // agents are pooled, and a severed Apex must come back whole.
    const k = sever > 0 ? Math.max(0.001, 1 - sever) : 1;
    if (k !== 1 || chain.bones[1].scale.x !== 1) {
      for (let i = 1; i < chain.bones.length; i++) chain.bones[i].scale.setScalar(k);
    }

    // Base pose offsets, in radians, applied on top of the rest fold. The idle
    // guard deliberately opens the blades outward: folded tight against the
    // chest they merge into the torso and the silhouette loses its arms.
    let femur = breathe + t * 0.12 + 0.22 - (lower ? 0.1 : 0);
    let tibia = -breathe * 0.6 - 0.12;
    let yaw = side * 0.3;

    if (parry > 0.001) {
      // Crossed guard: arms swing in front, blades rotate across the chest.
      femur = lerp(femur, -0.75, parry);
      tibia = lerp(tibia, -0.55, parry);
      yaw = lerp(0, -side * 0.85, parry);
    }
    if (coil > 0.001) {
      // Rear back and coil tighter. The blade tips climb above the head.
      femur = lerp(femur, 1.05 + (lower ? 0.25 : 0), coil);
      tibia = lerp(tibia, 0.42, coil);
      yaw = lerp(yaw, side * 0.22, coil);
    }
    if (swing > 0.001) {
      // Unload: femur drives down-forward, blade snaps open.
      femur = lerp(femur, -1.15 - (lower ? 0.2 : 0), swing);
      tibia = lerp(tibia, -2.05, swing);
      yaw = lerp(yaw, -side * 0.34, swing);
    }

    fkBend(rig, chain, 1, femur, yaw);
    fkBend(rig, chain, 2, tibia);
    fkBend(rig, chain, 0, (coil - swing) * 0.25);
  }

  let grasp = graspCache.get(rig);
  if (!grasp) {
    grasp = graspOf(rig);
    graspCache.set(rig, grasp);
  }
  for (const chain of grasp) {
    if (chain.bones.length < 3) continue;
    // The small arms paw constantly; that idle motion is most of what sells a
    // standing mantis as alive rather than a statue.
    const p = vGet(agent, 'mxPhase') * TAU + (chain.def.side || 1) * 1.7;
    fkBend(rig, chain, 0, Math.sin(p) * 0.16 - coil * 0.35 + swing * 0.2);
    fkBend(rig, chain, 1, Math.cos(p * 1.3) * 0.2 + coil * 0.5);
  }
}

/** Health-gated limb destruction for the Apex, and the moveset it drives. */
function updateApexLimbs(agent: EnemyAgent, ctx: AnimationContext): void {
  const frac = agent.health / Math.max(1, agent.maxHealth);
  const order = ['blade2.L', 'blade2.R', 'blade.L', 'blade.R'];
  const thresholds = [0.78, 0.6, 0.42, 0.24];
  for (let i = 0; i < order.length; i++) {
    const key = `sev${order[i]}`;
    const want = frac <= thresholds[i] ? 1 : 0;
    const now = vGet(agent, key);
    if (want > now) {
      if (now <= 0.001) {
        // The moment of loss: a burst of ichor and chitin at the joint.
        agent.rig.boneWorld(`${order[i]}.tibia`, _spawnPos);
        for (let g = 0; g < 4; g++) {
          _gv.set(Math.cos(g * 1.7) * 3.2, 3.4, Math.sin(g * 1.7) * 3.2);
          agent.anim.hit(_spawnPos, _gv, 1.2);
        }
      }
      vSet(agent, key, Math.min(1, now + ctx.dt * 2.2));
    }
  }
  vSet(agent, 'mxBlades', 4 - thresholds.filter((t) => frac <= t).length);
}

function mantisAnimate(agent: EnemyAgent, ctx: AnimationContext): void {
  const dt = Math.max(1e-4, ctx.dt);
  const { coil, swing } = attackPose(agent, dt);
  const parry = damp(vGet(agent, 'mxParryBlend'), vGet(agent, 'mxParry'), 10, dt);
  vSet(agent, 'mxParryBlend', parry);
  if (agent.archetype.id === 'mantis_apex') updateApexLimbs(agent, ctx);
  poseBlades(agent, dt, coil, swing, parry);
  agent.rig.syncWorld(agent.anim.rootPosition, agent.anim.rootQuaternion);
}

// ---------------------------------------------------------------------------
// Behaviour — AI-director trees
// ---------------------------------------------------------------------------

const _btV = new THREE.Vector3();

/** Mantis attacks are fast, so the wind-up must be long and still to be fair. */
const bladeCombo = (hits: number, reach: number): BehaviorTree['root'] =>
  seq(
    btCond('inReach', (c) => c.brain.agent.position.distanceTo(c.host.target.centre) <= reach + 1.2),
    faceTarget(0.3),
    // A deliberate, motionless coil. The species animator turns `ai.windup`
    // into blades reared over the head, which is the readable tell.
    telegraph(0.52, 'bladeCombo', 'charge'),
    btAction('combo', (c) => {
      const brain = c.brain;
      const bb = brain.bb;
      const slot = c.nodeId;
      // Three strikes on a fixed rhythm: fast, fast, slow. The gap before the
      // third is deliberately longer so the player can learn to dodge it.
      const beats = [0, 0.26, 0.72];
      const total = beats[hits - 1] + 0.34;
      const prev = bb.nodeTimer[slot];
      const now = prev + c.dt;
      bb.nodeTimer[slot] = now;
      for (let i = 0; i < hits; i++) {
        if (prev < beats[i] && now >= beats[i]) {
          const agent = c.brain.agent as unknown as EnemyAgent;
          agent.anim.attack(0.04, 0.09, 0.2);
          if (agent.position.distanceTo(c.host.target.centre) <= reach + 0.7) {
            c.host.fireAt(brain, c.host.target.centre);
          }
        }
      }
      brain.cmd.mode = 'stop';
      brain.cmd.facePoint.copy(c.host.target.centre);
      brain.cmd.faceValid = true;
      if (now >= total) {
        bb.nodeTimer[slot] = 0;
        return SUCCESS;
      }
      return RUNNING;
    }),
    // The recovery: hop backwards out of the counter-attack window.
    btAction('dodgeBack', (c) => {
      const brain = c.brain;
      _btV.subVectors(brain.agent.position, c.host.target.centre);
      _btV.y = 0;
      if (_btV.lengthSq() < 1e-4) _btV.set(0, 0, 1);
      _btV.normalize().multiplyScalar(4.5).add(brain.agent.position);
      brain.cmd.leap = true;
      brain.cmd.leapTarget.copy(_btV);
      brain.cmd.leapHeight = 1.4;
      brain.agent.ai.leap = true;
      return SUCCESS;
    }),
    btWait(0.45),
  );

/** Lob an acid glob on a high arc, after a long, still, glowing wind-up. */
const acidLob = (range: number, arc: number, damage: number, poolR: number, poolDps: number): BehaviorTree['root'] =>
  seq(
    btCond('inLobRange', (c) => {
      const d = c.brain.agent.position.distanceTo(c.host.target.centre);
      return d > 4 && d < range;
    }),
    faceTarget(0.28),
    telegraph(0.62, 'acidSpit', 'taunt'),
    btAction('spit', (c) => {
      const agent = c.brain.agent as unknown as EnemyAgent;
      agent.anim.attack(0.05, 0.1, 0.3);
      agent.rig.boneWorld(agent.headBone, _btV);
      // Lead the target: a stationary player must be hit, a moving one must not.
      const lead = _gv.copy(c.host.target.centre).addScaledVector(c.host.target.velocity, 0.35);
      MANTIS_ACID.lob(agent.object, _btV, lead, arc, 22, damage, poolR, poolDps, 7);
      c.host.bark(c.brain, 'taunt');
      return SUCCESS;
    }),
    btWait(0.5),
  );

/**
 * The Bladelord's parry. A real state, not a buff: the blades cross into a
 * guard, a hard shield goes up, and the unit stops moving. Kinetic fire is
 * blunted against it (the shield is arc), so it must be broken with a heavy
 * weapon or an arc ability — and when it breaks the guard drops and the neck
 * seam is wide open.
 */
const PARRY_SHIELD = 260;

const parryStance = (seconds: number): BehaviorTree['root'] =>
  seq(
    btCond('canParry', (c) => {
      const d = c.brain.agent.position.distanceTo(c.host.target.centre);
      return d > 3.5 && d < 26 && c.brain.percept.hasLos;
    }),
    btBark('taunt'),
    btAction('parry', (c) => {
      const agent = c.brain.agent as unknown as EnemyAgent;
      const bb = c.brain.bb;
      const slot = c.nodeId;
      if (bb.nodeTimer[slot] <= 0) {
        vSet(agent, 'mxParry', 1);
        agent.maxShield = PARRY_SHIELD;
        agent.shield = PARRY_SHIELD;
      }
      bb.nodeTimer[slot] += c.dt;
      c.brain.cmd.mode = 'stop';
      c.brain.cmd.facePoint.copy(c.host.target.centre);
      c.brain.cmd.faceValid = true;
      const broken = agent.shield <= 0;
      if (broken || bb.nodeTimer[slot] >= seconds) {
        bb.nodeTimer[slot] = 0;
        vSet(agent, 'mxParry', 0);
        agent.maxShield = agent.archetype.shield;
        agent.shield = broken ? 0 : Math.min(agent.shield, agent.archetype.shield);
        // A broken guard staggers: the recovery window the player earned.
        vSet(agent, 'mxGuardBroken', broken ? 1 : 0);
        return broken ? FAILURE : SUCCESS;
      }
      return RUNNING;
    }),
  );

/** A committed dash straight through the target, blades trailing. */
const dashThrough = (distance: number): BehaviorTree['root'] =>
  seq(
    btCond('dashRange', (c) => {
      const d = c.brain.agent.position.distanceTo(c.host.target.centre);
      return d > 5 && d < 22 && c.brain.steer.grounded;
    }),
    faceTarget(0.25),
    telegraph(0.48, 'dash', 'charge'),
    btAction('dash', (c) => {
      const brain = c.brain;
      _btV.subVectors(c.host.target.centre, brain.agent.position);
      _btV.y = 0;
      const d = _btV.length() || 1;
      _btV.multiplyScalar((d + distance) / d).add(brain.agent.position);
      brain.cmd.leap = true;
      brain.cmd.leapTarget.copy(_btV);
      brain.cmd.leapHeight = 1.1;
      brain.agent.ai.leap = true;
      const agent = brain.agent as unknown as EnemyAgent;
      agent.anim.attack(0.05, 0.35, 0.3);
      return SUCCESS;
    }),
    btAction('land', (c) => (c.brain.steer.leaping ? RUNNING : SUCCESS)),
  );

/** Search / idle tail every Mantis tree shares. */
const mantisIdleTail = (patrolRadius: number): BehaviorTree['root'][] => [
  guard(
    (c) => c.brain.percept.state === 'searching',
    sel(seq(searchLastKnown(0.95), scanArea(1.4)), scanArea(1.2)),
  ),
  guard(
    (c) => c.brain.percept.state === 'suspicious',
    seq(btBark('suspicious'), sel(searchLastKnown(0.6), scanArea(1.6))),
  ),
  patrolArea(patrolRadius, 0.42),
];

const NYMPH_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        // Movement lane: relentless. Nymphs never take cover; they close, leap,
        // and swarm around the flanks.
        sel(
          fail(btCooldown(3.2, timeout(2.6, leapAt(4.5, 15, 4.6)))),
          fail(btCooldown(5.5, timeout(3.5, moveToFlank((c) => (c.brain.agent.entityId % 2 ? 1 : -1), 5, 1)))),
          advanceToRange(1.9, 1),
          strafeAtRange(2.4, 0.95),
        ),
        // Attack lane.
        sel(withAttackToken(meleeStrike(2.4, 0.38)), btWait(0.3)),
      ),
    ),
    ...mantisIdleTail(18),
  ),
);

const STRIKER_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        sel(
          // Hurt strikers break contact and come back, rather than dying on the
          // spot. `caution` is low, so this only fires when genuinely wounded.
          fail(seq(btCond('hurt', (c) => c.brain.agent.health / c.brain.agent.maxHealth < 0.3), btBark('hurt'), timeout(2.2, retreatFrom(12, 1)))),
          fail(btCooldown(4.2, timeout(2.8, leapAt(6, 18, 5)))),
          advanceToRange(2.6, 1),
          strafeAtRange(3.2, 0.8),
        ),
        sel(withAttackToken(bladeCombo(3, 2.8)), btWait(0.35)),
      ),
    ),
    ...mantisIdleTail(16),
  ),
);

const SPITTER_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        sel(
          // Approach is the spitter's failure state: back off hard, then keep
          // relocating so it is never a stationary mortar.
          fail(seq(btCond('crowded', (c) => c.brain.agent.position.distanceTo(c.host.target.centre) < 11), btBark('cover'), timeout(3, retreatFrom(17, 1)))),
          fail(seq(btCond('hurt', (c) => c.brain.agent.health / c.brain.agent.maxHealth < 0.5), takeCover(24, false, 1), holdCover(2.4), leaveCover())),
          fail(btCooldown(5, timeout(3.4, repositionFiring(13, 0.8)))),
          strafeAtRange(19, 0.5),
        ),
        sel(withAttackToken(acidLob(30, 26, 26, 3.1, 22)), btWait(0.5)),
      ),
    ),
    ...mantisIdleTail(12),
  ),
);

const BLADELORD_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        sel(
          // A broken guard is a real punish window: the Bladelord staggers back
          // and does nothing for a second and a half.
          fail(seq(btCond('guardBroken', (c) => vGet(c.brain.agent as unknown as EnemyAgent, 'mxGuardBroken') > 0.5), btAction('clearBreak', (c) => {
            vSet(c.brain.agent as unknown as EnemyAgent, 'mxGuardBroken', 0);
            return SUCCESS;
          }), btBark('hurt'), timeout(1.6, retreatFrom(9, 0.6)))),
          fail(btCooldown(7, dashThrough(6))),
          advanceToRange(3, 0.95),
          strafeAtRange(4, 0.7),
        ),
        sel(
          // The parry only comes out at range, so it never robs the player of a
          // melee window they already committed to.
          btCooldown(6.5, parryStance(2.6)),
          withAttackToken(bladeCombo(3, 3.4)),
          btWait(0.3),
        ),
      ),
    ),
    ...mantisIdleTail(14),
  ),
);

const MATRIARCH_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        sel(
          // Hover high and orbit; dive on a cooldown.
          fail(btCooldown(8, seq(faceTarget(0.3), telegraph(0.7, 'dive', 'charge'), btAction('dive', (c) => {
            const brain = c.brain;
            brain.cmd.leap = true;
            brain.cmd.leapTarget.copy(c.host.target.centre);
            brain.cmd.leapHeight = 6.5;
            brain.agent.ai.leap = true;
            const agent = brain.agent as unknown as EnemyAgent;
            agent.anim.attack(0.06, 0.3, 0.5);
            return SUCCESS;
          }), btAction('land', (c) => (c.brain.steer.leaping ? RUNNING : SUCCESS))))),
          strafeAtRange(10, 0.75),
        ),
        sel(
          // Clutch drop: a fresh pack of nymphs, telegraphed by a long hover.
          btCooldown(14, seq(
            btCond('clutchRoom', () => spawner !== null),
            btBark('reinforce'),
            telegraph(0.9, 'clutch', 'reinforce'),
            btAction('clutch', (c) => {
              const agent = c.brain.agent as unknown as EnemyAgent;
              summon(agent, 'mantis_nymph', 3, 1.9);
              return SUCCESS;
            }),
          )),
          withAttackToken(acidLob(28, 24, 30, 3.4, 26)),
          btWait(0.4),
        ),
      ),
    ),
    ...mantisIdleTail(20),
  ),
);

// -- the Apex boss -----------------------------------------------------------

/** Phase from health: 0 = ground duel, 1 = aerial, 2 = acid flood. */
function apexPhase(c: BtContext): number {
  const a = c.brain.agent;
  const frac = a.health / Math.max(1, a.maxHealth);
  return frac > 0.66 ? 0 : frac > 0.33 ? 1 : 2;
}

/**
 * A sweeping blade arc: a long telegraph, then a wide cone of damage centred on
 * the facing. The cone is generous but the wind-up is nearly a second, so it is
 * learnable — walk out of the arc, or get behind.
 */
const bladeSweep = (windup: number, reach: number, damage: number): BehaviorTree['root'] =>
  seq(
    btCond('sweepRange', (c) => c.brain.agent.position.distanceTo(c.host.target.centre) < reach + 3),
    faceTarget(0.35),
    telegraph(windup, 'bladeSweep', 'charge'),
    btAction('sweep', (c) => {
      const brain = c.brain;
      const agent = brain.agent as unknown as EnemyAgent;
      const blades = Math.max(1, vGet(agent, 'mxBlades', 4));
      agent.anim.attack(0.05, 0.22, 0.45);
      _btV.subVectors(c.host.target.centre, agent.position);
      _btV.y = 0;
      const d = _btV.length();
      if (d < reach) {
        const facing = _gv.set(-Math.sin(agent.yaw), 0, -Math.cos(agent.yaw));
        if (facing.dot(_btV.normalize()) > 0.25) c.host.fireAt(brain, c.host.target.centre);
      }
      // Fewer blades, weaker sweep: destroying limbs visibly changes the fight.
      vSet(agent, 'mxSweepPower', blades / 4);
      void damage;
      return SUCCESS;
    }),
    btWait(0.6),
  );

/** Flood the low ground with acid, forcing the player up onto the arena's ledges. */
const acidFlood = (): BehaviorTree['root'] =>
  seq(
    btBark('reinforce'),
    telegraph(1.1, 'acidFlood', 'charge'),
    btAction('flood', (c) => {
      const agent = c.brain.agent as unknown as EnemyAgent;
      agent.anim.attack(0.06, 0.24, 0.7);
      agent.rig.boneWorld(agent.headBone, _btV);
      // A ring of globs walking outward from the boss. Each leaves a long-lived
      // pool, so the safe floor shrinks and the player has to take height.
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU + agent.yaw;
        const r = 5 + (i % 3) * 4.5;
        _gv.set(agent.position.x + Math.sin(a) * r, agent.position.y, agent.position.z + Math.cos(a) * r);
        MANTIS_ACID.lob(agent.object, _btV, _gv, 30, 20, 18, 4.2, 30, 13);
      }
      return SUCCESS;
    }),
    btWait(1.2),
  );

const APEX_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        // -- movement lane --------------------------------------------------
        sel(
          // Phase 1: dive-bomb. The long leap reads as launching off the arena
          // walls, and the landing is the AoE the player must clear.
          fail(guard((c) => apexPhase(c) === 1, btCooldown(6.5, seq(
            faceTarget(0.3),
            telegraph(0.8, 'diveBomb', 'charge'),
            btAction('launch', (c) => {
              const brain = c.brain;
              brain.cmd.leap = true;
              brain.cmd.leapTarget.copy(c.host.target.centre);
              brain.cmd.leapHeight = 9;
              brain.agent.ai.leap = true;
              return SUCCESS;
            }),
            btAction('descend', (c) => (c.brain.steer.leaping ? RUNNING : SUCCESS)),
            btAction('slam', (c) => {
              const agent = c.brain.agent as unknown as EnemyAgent;
              agent.anim.attack(0.03, 0.16, 0.5);
              agent.rig.boneWorld(agent.headBone, _btV);
              for (let i = 0; i < 5; i++) {
                const a = (i / 5) * TAU;
                _gv.set(agent.position.x + Math.sin(a) * 3.4, agent.position.y, agent.position.z + Math.cos(a) * 3.4);
                MANTIS_ACID.lob(agent.object, _btV, _gv, 26, 18, 22, 2.8, 24, 5);
              }
              if (agent.position.distanceTo(c.host.target.centre) < 6) c.host.fireAt(c.brain, c.host.target.centre);
              return SUCCESS;
            }),
            btWait(0.8),
          )))),
          fail(btCooldown(9, timeout(3, moveToFlank((c) => (c.brain.age % 2 < 1 ? 1 : -1), 7, 1)))),
          advanceToRange(5.5, 0.95),
          strafeAtRange(7, 0.6),
        ),
        // -- attack lane ----------------------------------------------------
        sel(
          guard((c) => apexPhase(c) === 2, btCooldown(11, acidFlood())),
          withAttackToken(bladeSweep(0.85, 7.5, 42)),
          btCooldown(4, withAttackToken(acidLob(26, 22, 30, 3.4, 26))),
          btWait(0.5),
        ),
      ),
    ),
    guard((c) => c.brain.percept.state !== 'unaware', sel(searchLastKnown(0.8), scanArea(2))),
    scanArea(3),
  ),
);

/** The compiled trees, keyed by archetype id. */
export const MANTIS_BEHAVIOURS: Record<string, BehaviorTree> = {
  mantis_nymph: NYMPH_TREE,
  mantis_striker: STRIKER_TREE,
  mantis_spitter: SPITTER_TREE,
  mantis_bladelord: BLADELORD_TREE,
  mantis_matriarch: MATRIARCH_TREE,
  mantis_apex: APEX_TREE,
};

/**
 * Hand the trees to the AI director. The game owner calls this once, after the
 * director exists:  `installMantisBehaviours(ai)`.
 */
export function installMantisBehaviours(director: {
  registerBehaviour(archetypeId: string, tree: BehaviorTree): void;
}): void {
  for (const id of Object.keys(MANTIS_BEHAVIOURS)) director.registerBehaviour(id, MANTIS_BEHAVIOURS[id]);
  for (const [catalogueId, unitId] of MANTIS_ALIASES) {
    director.registerBehaviour(catalogueId, MANTIS_BEHAVIOURS[unitId]);
  }
}

// ---------------------------------------------------------------------------
// Fallback behaviour — used when no AI director is driving
// ---------------------------------------------------------------------------

/**
 * `EnemyManager` ticks `SpeciesDefinition.behaviour()` whether or not a director
 * is installed, so this must be safe in both worlds: when the director owns
 * motion (`agent.externalMotion`) it does nothing but the species bookkeeping —
 * stepping the acid field — and leaves steering entirely alone.
 */
function mantisFallback(archetype: EnemyArchetype, ranged: boolean): BehaviourNode {
  const base = standardCombatBehaviour(archetype);
  return parallel(
    action((_agent, ctx) => {
      MANTIS_ACID.advance(ctx);
      return 'running';
    }),
    selector(
      // Returning `success` rather than `running` matters: a `sequence` that
      // returns `running` latches its child index and would never re-evaluate
      // the condition again.
      sequence(
        condition((agent) => agent.externalMotion),
        action(() => 'success'),
      ),
      parallel(
        base,
        // Ranged units lob instead of hitscanning, so the fallback fight looks
        // the same as the directed one.
        ranged
          ? action((agent, ctx) => {
              if (!ctx.targetValid || !ctx.target) return 'running';
              if (agent.ai.vars.get('attackPending') !== 1) return 'running';
              if (!agent.anim.attackStriking) return 'running';
              agent.ai.vars.set('attackPending', 0);
              agent.rig.boneWorld(agent.headBone, _btV);
              MANTIS_ACID.lob(agent.object, _btV, ctx.targetPosition, 26, 22, archetype.attackDamage * 1.6, 3.1, 22, 7);
              return 'running';
            })
          : action(() => 'running'),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function register(
  archetype: EnemyArchetype,
  build: (ctx: BodyBuildContext) => BuiltBody,
  ranged: boolean,
): void {
  EnemyManager.register({
    archetype,
    build,
    behaviour: () => mantisFallback(archetype, ranged),
    animate: mantisAnimate,
  });
}

const BUILDERS: Record<string, (ctx: BodyBuildContext) => BuiltBody> = {
  mantis_nymph: (ctx) => buildMantisBiped(ctx, NYMPH_PLAN),
  mantis_striker: (ctx) => buildMantisBiped(ctx, STRIKER_PLAN),
  mantis_spitter: (ctx) => buildMantisBiped(ctx, SPITTER_PLAN),
  mantis_bladelord: (ctx) => buildMantisBiped(ctx, BLADELORD_PLAN),
  mantis_matriarch: (ctx) => buildMantisBiped(ctx, MATRIARCH_PLAN),
  mantis_apex: buildMantisApex,
};

const RANGED = new Set(['mantis_spitter', 'mantis_matriarch', 'mantis_apex']);

for (const id of Object.keys(MANTIS_ARCHETYPES)) {
  register(MANTIS_ARCHETYPES[id], BUILDERS[id], RANGED.has(id));
}

// Catalogue aliases share the body and the behaviour, but carry the stats from
// `Archetypes.ts` so the difficulty curve stays tuned in one place.
for (const [catalogueId, unitId] of MANTIS_ALIASES) {
  const a = ARCHETYPES[catalogueId];
  if (!a) continue;
  register(a, BUILDERS[unitId], RANGED.has(unitId));
}

/** Ids of every Mantis unit, in roster order. */
export const MANTIS_UNITS: readonly string[] = Object.keys(MANTIS_ARCHETYPES);

/** Release the faction's shared effect pools. Levels call this on teardown. */
export function disposeMantisEffects(): void {
  MANTIS_ACID.dispose();
}
