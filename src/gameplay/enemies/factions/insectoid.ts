/**
 * Insectoid Aliens — the Unnumbered of Hive Prime.
 *
 * ## The design problem is COUNT, not detail
 *
 * A Mantis fight is five duellists. A Hive fight is forty things pouring out of
 * a tunnel, climbing over each other, bursting. Everything below is shaped by
 * that:
 *
 * - **Two materials on the swarmling** (shell + spiracle glow), so forty of them
 *   is eighty draw calls, not two hundred. Value separation inside the body
 *   comes from *vertex colour*, which is free, rather than from a third
 *   material. Bigger units earn a third and fourth.
 * - **Three-span legs everywhere.** `hip → knee → ankle` puts the animator on
 *   its closed-form two-bone solver instead of FABRIK. Six legs on a swarmling
 *   then cost about what two legs on a biped cost, and the manager's animation
 *   LOD drops them to direct-rotation swing past 42 m anyway.
 * - **Silhouette by mass, not by filigree.** At forty units nobody reads a
 *   spine. They read *height, width and leg count*: 0.6 m skitterer, 1.9 m
 *   gunner, 1.5 m squat mortar, 2.4 m armoured wedge, 3.2 m sessile sac, and a
 *   12 m worm.
 *
 * ## Anatomy
 *
 * Amber-brown segmented carapace, wet near-black mandibles, and a row of
 * glowing orange spiracles along the flanks — which double as the crit spots,
 * so the art direction and the mechanic are the same thing. Legs mount on
 * laterally-projecting coxal bosses so the stance is genuinely wide: the
 * footstep planner plants each foot under its own hip, so hip *width* is the
 * only control over stance width, and narrow hips give a bug that walks like a
 * greyhound.
 *
 * Deliberately unlike the Mantis: no elegance, no duellist's poise. Low centres
 * of gravity, too many legs, everything pointed forward at you.
 */
import * as THREE from 'three';
import type { EnemyArchetype } from '@/types';
import { clamp01, damp, lerp, TAU } from '@/util/math';
import { EnemyManager } from '@/gameplay/enemies/EnemyManager';
import { ARCHETYPES } from '@/gameplay/enemies/Archetypes';
import type {
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
import { FORWARD, UP, type ChainRuntime, type Rig, type RigInstance } from '@/gameplay/enemies/Rig';
import type { AnimationContext } from '@/gameplay/enemies/ProceduralAnimator';
import {
  RUNNING,
  SUCCESS,
  advanceToRange,
  action as btAction,
  bark as btBark,
  cond as btCond,
  cooldown as btCooldown,
  wait as btWait,
  compileTree,
  fail,
  faceTarget,
  guard,
  holdCover,
  holdPosition,
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
} from '@/gameplay/ai/BehaviorTree';
// The bio-projectile field and the FK pose helpers live in `mantis.ts`. Both
// faction modules are owned by the same author and a third shared file is
// outside that ownership list, so the Mantis module is the kit's home and this
// one imports from it rather than carrying a second copy.
import { BioField, attackPose, fkBend, vGet, vSet, type FactionSpawner } from './mantis';

// ---------------------------------------------------------------------------
// Faction identity
// ---------------------------------------------------------------------------

/** Amber-orange. Matches `FACTION_ACCENT.insectoid`. */
export const HIVE_GLOW = 0xffa53a;
/** Tints multiplied onto the library surfaces, which carry their own albedo. */
const SHELL = 0xc9a066;
const PLATE = 0xe8c184;
const MAW = 0x2e2018;
const SHELL_TIP = 0xf3d49a;
/** Vertex-colour darkening used where a second material is not affordable. */
const DARK = 0x4a3524;

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

function at(rig: Rig, name: string): THREE.Vector3 {
  return rig.restPosition(name, new THREE.Vector3());
}

function tipOf(rig: Rig, chainId: string): THREE.Vector3 {
  const c = rig.chainById(chainId);
  return c ? c.restTip.clone() : new THREE.Vector3();
}

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

function hiveArchetype(
  o: Partial<EnemyArchetype> & Pick<EnemyArchetype, 'id' | 'rank' | 'displayName'>,
): EnemyArchetype {
  return {
    faction: 'insectoid',
    health: 60,
    shield: 0,
    shieldElement: null,
    moveSpeed: 4,
    sprintSpeed: 6.5,
    preferredRange: 3,
    eyeHeight: 1.2,
    capsuleRadius: 0.4,
    capsuleHalfHeight: 0.5,
    attackDamage: 8,
    attackInterval: 1,
    accuracy: 0.05,
    aggression: 0.9,
    caution: 0.1,
    flying: false,
    score: 10,
    abilities: [],
    ...o,
  };
}

export const INSECT_ARCHETYPES: Record<string, EnemyArchetype> = {
  insect_swarmling: hiveArchetype({
    id: 'insect_swarmling',
    rank: 'minor',
    displayName: 'Swarmling',
    // One body shot from anything. The pressure is the count, and a swarmling
    // that survives two hits turns a swarm into a slog.
    health: 14,
    moveSpeed: 6.2,
    sprintSpeed: 9.8,
    preferredRange: 1.6,
    eyeHeight: 0.42,
    capsuleRadius: 0.22,
    capsuleHalfHeight: 0.22,
    attackDamage: 5,
    attackInterval: 0.7,
    accuracy: 0.12,
    aggression: 1,
    caution: 0,
    score: 5,
    abilities: ['swarm'],
  }),
  insect_soldier: hiveArchetype({
    id: 'insect_soldier',
    rank: 'standard',
    displayName: 'Hive Soldier',
    health: 150,
    moveSpeed: 3.4,
    sprintSpeed: 5.8,
    preferredRange: 15,
    eyeHeight: 1.55,
    capsuleRadius: 0.42,
    capsuleHalfHeight: 0.62,
    attackDamage: 11,
    attackInterval: 0.28,
    accuracy: 0.042,
    aggression: 0.6,
    caution: 0.35,
    score: 28,
    abilities: ['bioCannon', 'burrow'],
  }),
  insect_spitmaw: hiveArchetype({
    id: 'insect_spitmaw',
    rank: 'standard',
    displayName: 'Spitmaw',
    health: 120,
    moveSpeed: 2.6,
    sprintSpeed: 4.4,
    preferredRange: 24,
    eyeHeight: 1.05,
    capsuleRadius: 0.5,
    capsuleHalfHeight: 0.48,
    attackDamage: 20,
    attackInterval: 2.4,
    accuracy: 0.05,
    aggression: 0.3,
    caution: 0.8,
    score: 34,
    abilities: ['acidMortar'],
  }),
  insect_ravager: hiveArchetype({
    id: 'insect_ravager',
    rank: 'elite',
    displayName: 'Ravager',
    health: 420,
    shield: 160,
    shieldElement: 'solar',
    moveSpeed: 3,
    sprintSpeed: 9.5,
    preferredRange: 3.2,
    eyeHeight: 1.5,
    capsuleRadius: 0.7,
    capsuleHalfHeight: 0.78,
    attackDamage: 34,
    attackInterval: 1.1,
    accuracy: 0.04,
    aggression: 1,
    caution: 0.05,
    score: 95,
    abilities: ['charge', 'wallStagger'],
  }),
  insect_broodmother: hiveArchetype({
    id: 'insect_broodmother',
    rank: 'champion',
    displayName: 'Broodmother',
    health: 1100,
    shield: 0,
    // Rooted. Speed zero is the mechanic: it cannot chase, so the player
    // chooses between killing the tap and fighting the flood.
    moveSpeed: 0,
    sprintSpeed: 0,
    preferredRange: 12,
    eyeHeight: 2.1,
    capsuleRadius: 1.05,
    capsuleHalfHeight: 1.3,
    attackDamage: 18,
    attackInterval: 1.6,
    accuracy: 0.06,
    aggression: 0.4,
    caution: 0,
    score: 240,
    abilities: ['spawn', 'acidSpit'],
  }),
  insect_hivelord: hiveArchetype({
    id: 'insect_hivelord',
    rank: 'boss',
    displayName: 'The Hivelord',
    health: 5200,
    shield: 1500,
    shieldElement: 'solar',
    moveSpeed: 4.2,
    sprintSpeed: 7.5,
    preferredRange: 8,
    eyeHeight: 3.6,
    capsuleRadius: 1.3,
    capsuleHalfHeight: 1.4,
    attackDamage: 44,
    attackInterval: 0.9,
    accuracy: 0.035,
    aggression: 0.9,
    caution: 0.1,
    score: 1200,
    abilities: ['burrow', 'bodySlam', 'ichorSpray', 'segmentBreak'],
  }),
};

const INSECT_ALIASES: Array<[catalogueId: string, unitId: string]> = [
  ['insectoid.crawler', 'insect_swarmling'],
  ['insectoid.warrior', 'insect_soldier'],
  ['insectoid.spitter', 'insect_spitmaw'],
  ['insectoid.tunneler', 'insect_ravager'],
  ['insectoid.hivequeen', 'insect_hivelord'],
];

// ---------------------------------------------------------------------------
// Shared effects
// ---------------------------------------------------------------------------

/** Amber resin and ichor. Separate pool from the Mantis so the colours differ. */
export const HIVE_ACID = new BioField(0xffb347, 'hive-acid');

let spawner: FactionSpawner | null = null;

/**
 * Give the Broodmother and the Hivelord a way to make swarmlings. The level
 * owner calls `bindInsectoidSpawner(enemies)` after `enemies.bindLevel(level)`.
 * Unbound, the Broodmother is simply a large stationary target.
 */
export function bindInsectoidSpawner(host: FactionSpawner | null): void {
  spawner = host;
}

const _sp = new THREE.Vector3();
const _bv = new THREE.Vector3();
const _bv2 = new THREE.Vector3();

function hatch(agent: EnemyAgent, id: string, count: number, radius: number): number {
  if (!spawner) return 0;
  let made = 0;
  for (let i = 0; i < count; i++) {
    const a = agent.rng.range(0, TAU);
    const r = radius * (0.55 + agent.rng.next() * 0.45);
    _sp.set(agent.position.x + Math.sin(a) * r, agent.position.y + 0.2, agent.position.z + Math.cos(a) * r);
    if (spawner.spawn(id, _sp, a + Math.PI)) made++;
  }
  return made;
}

// ---------------------------------------------------------------------------
// Leg kit
// ---------------------------------------------------------------------------

interface HiveLegPlan {
  /** femur, tibia, tarsus (the flat foot), claw tip. */
  lengths: [number, number, number, number];
  /** Per-joint bend, radians, measured outward from straight down. */
  bends: [number, number, number];
  /** Outward tilt of the whole chain from vertical. */
  tilt: number;
  /** Lateral offset of the coxa boss from the body centreline. */
  splay: number;
  dz: number;
  radius: number;
  gaitPhase?: number;
}

/**
 * Where a radially-articulated leg's joints end up.
 *
 * The chain's pole is set to the outward-up perpendicular, which makes each
 * bone's local X the world Z axis — so the rest bends swing the leg *within*
 * its splay plane rather than fore-and-aft, and each bone's direction is simply
 * `tilt + Σbends` measured outward from straight down. That identity is what
 * makes it possible to place a six-legged body at exactly the height where all
 * six feet touch the floor.
 */
function radialReach(
  lengths: number[],
  bends: number[],
  joints: number,
  tilt: number,
): { dy: number; dr: number } {
  let a = tilt;
  let dy = 0;
  let dr = 0;
  for (let i = 0; i < joints; i++) {
    a += bends[i] ?? 0;
    dy -= lengths[i] * Math.cos(a);
    dr += lengths[i] * Math.sin(a);
  }
  return { dy, dr };
}

/** Body height at which this leg plan's feet rest exactly on y = 0. */
function hiveHipHeight(plan: HiveLegPlan): number {
  return -radialReach(plan.lengths, plan.bends, 2, plan.tilt).dy + plan.lengths[2] * 0.85;
}

function addHiveLeg(rig: Rig, id: string, parent: string, plan: HiveLegPlan, side: -1 | 1): void {
  const dir = v(Math.sin(plan.tilt) * side, -Math.cos(plan.tilt), 0);
  // Outward-and-up, perpendicular to `dir` inside the splay plane.
  const pole = v(Math.cos(plan.tilt) * side, Math.sin(plan.tilt), 0);
  rig.chain(id, ['coxa', 'femur', 'tibia', 'tarsus'], plan.lengths.slice(), {
    parent,
    origin: v(side * plan.splay, 0, plan.dz),
    direction: dir,
    pole,
    kind: 'leg',
    side,
    gaitPhase: plan.gaitPhase,
    restBend: plan.bends.slice(),
    capture: [plan.radius * 2.6, plan.radius * 2.3, plan.radius * 2, plan.radius * 1.8],
  });
}

/**
 * A hive leg: a knobbed coxa boss, a short thick femur that carries the knee
 * high and outboard, a long thin tibia and a two-clawed foot. Every joint gets
 * a bulge, because at forty units on screen the joint bulges are the only leg
 * detail that survives.
 */
function addHiveLegGeometry(
  b: BodyBuilder,
  rig: Rig,
  id: string,
  plan: HiveLegPlan,
  side: -1 | 1,
  simple = false,
): void {
  const coxa = at(rig, `${id}.coxa`);
  const femur = at(rig, `${id}.femur`);
  const tibia = at(rig, `${id}.tibia`);
  const tarsus = at(rig, `${id}.tarsus`);
  const tip = tipOf(rig, id);
  const r = plan.radius;

  put(b, 'shell', b.taperedLimb({ from: coxa, to: femur, r0: r * 1.5, r1: r * 0.85, jointR: r * 1.6, muscle: 1.5, flatten: 0.9, sides: 8 }));
  put(b, 'shell', b.taperedLimb({ from: femur, to: tibia, r0: r * 0.8, r1: r * 0.42, jointR: r * 0.95, muscle: 1.1, flatten: 0.86, sides: 7 }));
  put(b, 'shell', b.segment({ from: tibia, to: tarsus, r0: r * 0.42, r1: r * 0.3, flatten: 0.8, sides: 6, color: DARK }));
  // `simple` halves the per-leg part count for the units that spawn in tens.
  // Six legs on forty swarmlings is 240 limbs on screen; a claw nobody can see
  // at 8 m is 240 wasted merges.
  for (let d = -1; d <= 1; d += simple ? 4 : 2) {
    put(b, 'shell', b.digit({
      base: tarsus.clone().add(v(0, 0, d * r * 0.2)),
      direction: tip.clone().sub(tarsus).normalize().add(v(0, -0.4, d * 0.5)).normalize(),
      length: Math.max(0.03, r * 2.2),
      radius: r * 0.24,
      joints: 2,
      curl: 0.5,
      color: MAW,
    }));
  }
  if (!simple) {
    // A spur on the outside of the femur joint: it is what stops six identical
    // tubes reading as wire.
    put(b, 'shell', b.spine({
      base: femur.clone().add(v(side * r * 0.5, r * 0.3, 0)),
      direction: v(side * 0.5, 0.7, -0.3).normalize(),
      length: r * 2.4,
      radius: r * 0.34,
      color: DARK,
    }));
  }
}

// ---------------------------------------------------------------------------
// Shared body parts
// ---------------------------------------------------------------------------

/**
 * Active material-key map, and the `add` wrapper every builder goes through.
 *
 * `BodyBuilder` merges one geometry per *key*, so aliasing two kinds onto one
 * key is what collapses the swarmling to two draw calls. `BodyBuilder.material`
 * always clones, so registering the same material under two keys would produce
 * two buckets and defeat the whole point — the indirection has to happen here,
 * at the call site. Builds are synchronous and one at a time, so a module-level
 * map is safe.
 */
let KEYS: Record<'shell' | 'plate' | 'maw' | 'glow', string> = {
  shell: 'shell',
  plate: 'plate',
  maw: 'maw',
  glow: 'glow',
};

function put(b: BodyBuilder, kind: 'shell' | 'plate' | 'maw' | 'glow', geo: THREE.BufferGeometry): void {
  b.add(KEYS[kind], geo);
}

/** Full four-material set. Big units only. */
function hiveMaterials(b: BodyBuilder): void {
  KEYS = { shell: 'shell', plate: 'plate', maw: 'maw', glow: 'glow' };
  // See `mantis.ts` for why the roughness maps are dropped: they bake down to
  // ~0.1 in places, `roughness` can only scale a map downward, and a 3-unit key
  // light on a 0.1-roughness surface is a mirror. Constant values here, with
  // albedo/normal/AO still coming from the procedural set.
  const shell = b.material('shell', 'hiveChitin', { color: SHELL, repeat: 0.24 });
  shell.roughnessMap = null;
  shell.roughness = 0.7;
  shell.envMapIntensity = 0.35;
  const plate = b.material('plate', 'chitin', { color: PLATE, repeat: 0.4 });
  plate.roughnessMap = null;
  plate.roughness = 0.5;
  plate.envMapIntensity = 0.45;
  // The mandibles are the one genuinely wet thing on a hive unit.
  const maw = b.material('maw', 'chitin', { color: MAW, repeat: 0.5 });
  maw.roughnessMap = null;
  maw.roughness = 0.22;
  maw.envMapIntensity = 1;
  b.emissive('glow', HIVE_GLOW, 3.6);
}

/**
 * Two materials, for the units that appear in tens: shell and glow only, with
 * `plate` and `maw` aliased onto the shell so the value split falls to vertex
 * colour, which is free.
 */
function swarmMaterials(b: BodyBuilder): void {
  KEYS = { shell: 'shell', plate: 'shell', maw: 'shell', glow: 'glow' };
  const shell = b.material('shell', 'hiveChitin', { color: SHELL, repeat: 0.3 });
  shell.roughnessMap = null;
  shell.roughness = 0.66;
  shell.envMapIntensity = 0.35;
  b.emissive('glow', HIVE_GLOW, 3.6);
}

/**
 * A hive head: a low armoured skull with a pair of wet mandibles that cross in
 * front of the mouth, small clustered eyes and a set of palps. The mandibles
 * are the read — they are near-black against an amber body and they break the
 * outline at the very front, where the player is looking.
 */
function addHiveHead(
  b: BodyBuilder,
  head: THREE.Vector3,
  front: THREE.Vector3,
  o: { size: number; jaw: number; eyeR: number; horn: number; eyes: number },
): void {
  const f = front.clone().normalize();
  const up = v(0, 1, 0).addScaledVector(f, -f.y).normalize();
  const right = new THREE.Vector3().crossVectors(f, up).normalize();
  const s = o.size;
  const nose = head.clone().addScaledVector(f, s * 1.1);

  put(b, 'shell', b.segment({
    from: head.clone().addScaledVector(f, -s * 0.6),
    to: nose,
    r0: s * 1.0,
    r1: s * 0.45,
    flatten: 0.62,
    bulge: 1.12,
    sides: 9,
    color: SHELL,
    colorTip: SHELL_TIP,
  }));
  // Skull cap, ridged: the frontal armour every hive unit wears.
  put(b, 'plate', b.carapace({
    centre: head.clone().addScaledVector(up, s * 0.34).addScaledVector(f, s * 0.14),
    radius: s * 0.92,
    height: s * 0.62,
    length: 1.35,
    ridges: 5,
    ridgeDepth: 0.1,
    segments: 11,
    direction: up.clone().addScaledVector(f, 0.35).normalize(),
    color: PLATE,
    colorTip: SHELL_TIP,
  }));

  for (const side of [-1, 1] as const) {
    // Mandibles: long, crossed, serrated, near-black.
    put(b, 'maw', b.mandible({
      base: nose.clone().addScaledVector(right, side * s * 0.42).addScaledVector(up, -s * 0.18),
      direction: f.clone().addScaledVector(right, side * 0.25).addScaledVector(up, -0.12).normalize(),
      inward: right.clone().multiplyScalar(-side),
      length: o.jaw,
      thickness: s * 0.24,
      flatten: 0.5,
      serrations: 4,
      color: MAW,
      colorTip: DARK,
    }));
    // Palps under the mouth.
    put(b, 'maw', b.digit({
      base: nose.clone().addScaledVector(right, side * s * 0.2).addScaledVector(up, -s * 0.42),
      direction: f.clone().addScaledVector(up, -0.6).normalize(),
      length: o.jaw * 0.4,
      radius: s * 0.09,
      joints: 2,
      curl: 0.5,
      color: MAW,
    }));
    // A cluster of small simple eyes, not one big lens: a hive unit's head must
    // not look like a mantis' head.
    for (let e = 0; e < o.eyes; e++) {
      const t = e / Math.max(1, o.eyes - 1) - 0.5;
      const c = head
        .clone()
        .addScaledVector(f, s * (0.42 - Math.abs(t) * 0.2))
        .addScaledVector(right, side * s * (0.5 + Math.abs(t) * 0.22))
        .addScaledVector(up, s * (0.16 + t * 0.34));
      const n = right.clone().multiplyScalar(side).addScaledVector(f, 0.7).addScaledVector(up, 0.25).normalize();
      const r = o.eyeR * (1 - Math.abs(t) * 0.35);
      // A dark wet socket with a small emissive core, not one big glowing lens:
      // `b.emissive` materials ignore vertex colour, so a large emissive dome
      // renders as a flat blob with no form.
      put(b, 'maw', b.lens({ centre: c, normal: n, radius: r * 1.35, bulge: 0.75, segments: 8, color: 0x120c07, coreColor: 0x2c1a0e }));
      put(b, 'glow', b.lens({ centre: c.clone().addScaledVector(n, r * 0.5), normal: n, radius: r * 0.62, bulge: 0.8, segments: 7 }));
    }
    if (o.horn > 0) {
      put(b, 'plate', b.horn({
        base: head.clone().addScaledVector(up, s * 0.6).addScaledVector(right, side * s * 0.4),
        direction: up.clone().addScaledVector(f, 0.5).addScaledVector(right, side * 0.35).normalize(),
        length: o.horn,
        radius: s * 0.2,
        curve: o.horn * 0.28,
        ridges: 5,
        twist: 0.3,
        color: PLATE,
        colorTip: SHELL_TIP,
      }));
    }
  }
}

/**
 * The flank spiracles: glowing breathing pores in a row down each side. They are
 * the faction's emissive language *and* the weak point the elite units force you
 * to shoot, so they are always placed where a crit proxy can sit on a real bone.
 */
function addSpiracles(
  b: BodyBuilder,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const c = from.clone().lerp(to, t);
    const r = radius * (1 - Math.abs(t - 0.45) * 0.5);
    for (const side of [-1, 1] as const) {
      put(b, 'shell', b.vent({
        centre: c.clone().add(v(side * r * 0.88, 0, 0)),
        normal: v(side, 0.12, 0).normalize(),
        width: r * 0.5,
        height: r * 0.34,
        depth: r * 0.16,
        slats: 2,
        color: DARK,
      }));
      put(b, 'glow', b.lens({
        centre: c.clone().add(v(side * r * 0.94, 0, 0)),
        normal: v(side, 0.12, 0).normalize(),
        radius: r * 0.19,
        bulge: 0.5,
        color: 0xff7a18,
        coreColor: 0xffdca0,
      }));
    }
  }
}

/** A tapering, ridged, plated abdomen along a chain of bones. */
function addAbdomen(
  b: BodyBuilder,
  rig: Rig,
  chainId: string,
  bones: string[],
  r0: number,
  taper: number,
  spikes: boolean,
): void {
  for (let i = 0; i < bones.length; i++) {
    const from = at(rig, bones[i]);
    const to = i + 1 < bones.length ? at(rig, bones[i + 1]) : tipOf(rig, chainId);
    const ra = r0 * Math.pow(taper, i);
    const rb = r0 * Math.pow(taper, i + 1);
    put(b, 'shell', b.segment({ from, to, r0: ra, r1: rb, bulge: 1.16, flatten: 0.9, ridges: 9, ridgeDepth: 0.07, sides: 10, color: SHELL, colorTip: SHELL_TIP }));
    put(b, 'plate', b.plate({
      centre: from.clone().lerp(to, 0.4).add(v(0, ra * 0.74, 0)),
      normal: v(0, 1, 0.15).normalize(),
      up: to.clone().sub(from).normalize(),
      width: ra * 2.05,
      height: from.distanceTo(to) * 1.05,
      thickness: ra * 0.15,
      curve: 1.35,
      taper: 0.85,
      color: PLATE,
      edgeColor: SHELL_TIP,
    }));
    if (spikes) {
      put(b, 'maw', b.spine({
        base: from.clone().lerp(to, 0.45).add(v(0, ra * 0.9, 0)),
        direction: v(0, 0.9, 0.44).normalize(),
        length: ra * 1.2,
        radius: ra * 0.16,
        color: MAW,
      }));
    }
    addSpiracles(b, from, to, ra, 1);
  }
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Swarmling. 0.6 m, six legs, a body that is basically one hunched carapace and
 * a pair of mandibles half as long as it is. Two materials, ~700 triangles at
 * `high`. Everything about it is subordinated to appearing in packs of ten.
 */
function buildSwarmling(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  swarmMaterials(b);

  const leg: HiveLegPlan = {
    lengths: [0.16, 0.2, 0.09, 0.05],
    bends: [1.15, -1.95, 0.8],
    tilt: 0.6,
    splay: 0.11,
    dz: 0,
    radius: 0.024,
  };
  const hipY = hiveHipHeight(leg);

  rig.chain('spine', ['thorax', 'neck', 'head'], [0.15, 0.09, 0.11], {
    origin: v(0, hipY, -0.02),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    restBend: [0.16, 0.1, -0.3],
    capture: [0.2, 0.12, 0.14],
  });
  rig.chain('abdomen', ['a0', 'a1'], [0.14, 0.1], {
    parent: 'spine.thorax',
    origin: v(0, 0.02, 0.06),
    direction: v(0, -0.16, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.16, 0.13],
  });

  // Three leg rows, spread over the thorax. Clustering them at one point is
  // what makes a hexapod read as a spider bunched into a ball.
  const rows: Array<[number, number]> = [
    [0, -0.12],
    [1, 0.0],
    [2, 0.11],
  ];
  for (const [row, dz] of rows) {
    for (const side of [-1, 1] as const) {
      addHiveLeg(rig, `leg.${side < 0 ? 'L' : 'R'}${row}`, 'spine.thorax', { ...leg, dz }, side);
    }
  }

  const thorax = at(rig, 'spine.thorax');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  put(b, 'shell', b.taperedLimb({ from: thorax.clone().add(v(0, 0, 0.09)), to: neck, r0: 0.115, r1: 0.075, jointR: 0.12, muscle: 1.1, flatten: 0.9, sides: 9 }));
  put(b, 'plate', b.carapace({ centre: thorax.clone().add(v(0, 0.05, 0.01)), radius: 0.125, height: 0.1, length: 1.3, ridges: 4, ridgeDepth: 0.1, segments: 10, direction: UP, color: PLATE, colorTip: SHELL_TIP }));
  put(b, 'shell', b.segment({ from: neck, to: head, r0: 0.07, r1: 0.062, flatten: 0.92, sides: 7 }));
  addHiveHead(b, head, headTip.clone().sub(head).normalize(), { size: 0.075, jaw: 0.13, eyeR: 0.018, horn: 0, eyes: 2 });
  addAbdomen(b, rig, 'abdomen', ['abdomen.a0', 'abdomen.a1'], 0.1, 0.7, false);

  for (const [row, dz] of rows) {
    for (const side of [-1, 1] as const) {
      addHiveLegGeometry(b, rig, `leg.${side < 0 ? 'L' : 'R'}${row}`, { ...leg, dz }, side, true);
    }
  }

  return {
    rig,
    parts: b.finish(),
    height: 0.6,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: HIVE_GLOW,
    shieldRadius: 0.35,
    tuning: { runSpeed: 9, strideScale: 0.55, kneeSign: 1, bob: 0.018, sway: 0.004, liftScale: 0.3, breathAmount: 0.02, leanAccel: 0.01 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.11, multiplier: 1.6 },
      { region: 'body', bone: 'spine.thorax', radius: 0.17, multiplier: 1 },
    ],
  };
}

/**
 * Hive Soldier. Four walking legs plus a fused pair of forelimbs carrying a
 * chitin bio-cannon. 1.9 m at the raised head, armoured across the shoulders,
 * with the barrel slung under the right forelimb so it reads as armed from any
 * angle.
 */
function buildSoldier(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  hiveMaterials(b);

  const leg: HiveLegPlan = {
    lengths: [0.44, 0.55, 0.24, 0.12],
    bends: [1.1, -1.92, 0.85],
    tilt: 0.5,
    splay: 0.36,
    dz: 0,
    radius: 0.062,
  };
  const hipY = hiveHipHeight(leg);

  // Spine runs forward and climbs: the front of the body rears up so the
  // forelimbs can hold the cannon at eye level.
  rig.chain('spine', ['hips', 'thorax', 'neck', 'head'], [0.5, 0.44, 0.3, 0.3], {
    origin: v(0, hipY, 0.42),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    restBend: [0.05, 0.62, 0.3, -0.78],
    capture: [0.42, 0.4, 0.24, 0.28],
  });
  rig.chain('abdomen', ['a0', 'a1', 'a2'], [0.32, 0.28, 0.2], {
    parent: 'spine.hips',
    origin: v(0, 0.04, 0.2),
    direction: v(0, -0.22, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.3, 0.27, 0.22],
  });

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    addHiveLeg(rig, `leg.F${s}`, 'spine.thorax', { ...leg, dz: -0.06, gaitPhase: side < 0 ? 0 : 0.5 }, side);
    addHiveLeg(rig, `leg.B${s}`, 'spine.hips', { ...leg, dz: 0.1, gaitPhase: side < 0 ? 0.5 : 0 }, side);
    // Forelimbs: `generic`, so the base animator leaves them alone and the
    // species holds them on the weapon.
    rig.chain(`fore.${s}`, ['shoulder', 'elbow', 'hand'], [0.34, 0.3, 0.14], {
      parent: 'spine.neck',
      origin: v(side * 0.24, -0.06, 0.02),
      direction: v(side * 0.35, -0.55, -0.76).normalize(),
      pole: UP,
      kind: 'generic',
      side,
      restBend: [0.15, 0.95, 0.3],
      capture: [0.24, 0.2, 0.16],
    });
  }

  const hips = at(rig, 'spine.hips');
  const thorax = at(rig, 'spine.thorax');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  put(b, 'shell', b.taperedLimb({ from: hips.clone().add(v(0, 0, 0.22)), to: thorax, r0: 0.32, r1: 0.34, jointR: 0.34, muscle: 1.1, flatten: 0.92, sides: 12 }));
  put(b, 'shell', b.taperedLimb({ from: thorax, to: neck, r0: 0.32, r1: 0.2, jointR: 0.3, muscle: 1.05, flatten: 0.86, sides: 11 }));
  put(b, 'shell', b.segment({ from: neck, to: head, r0: 0.19, r1: 0.16, flatten: 0.92, sides: 9 }));
  put(b, 'plate', b.carapace({ centre: thorax.clone().add(v(0, 0.14, 0.04)), radius: 0.36, height: 0.24, length: 1.45, ridges: 6, ridgeDepth: 0.1, segments: 13, direction: UP, color: PLATE, colorTip: SHELL_TIP }));
  // Shoulder pauldrons over the forelimb mounts.
  for (const side of [-1, 1] as const) {
    put(b, 'plate', b.plate({
      centre: neck.clone().add(v(side * 0.24, 0.12, 0.06)),
      normal: v(side * 0.85, 0.5, 0.1).normalize(),
      up: v(0, 0, -1),
      width: 0.34,
      height: 0.3,
      thickness: 0.035,
      curve: 1.5,
      taper: 0.7,
      color: PLATE,
      edgeColor: SHELL_TIP,
    }));
  }
  addSpiracles(b, hips, thorax, 0.33, 3);
  addHiveHead(b, head, headTip.clone().sub(head).normalize(), { size: 0.16, jaw: 0.28, eyeR: 0.035, horn: 0.2, eyes: 3 });
  addAbdomen(b, rig, 'abdomen', ['abdomen.a0', 'abdomen.a1', 'abdomen.a2'], 0.26, 0.78, true);

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    addHiveLegGeometry(b, rig, `leg.F${s}`, { ...leg, dz: -0.06 }, side);
    addHiveLegGeometry(b, rig, `leg.B${s}`, { ...leg, dz: 0.1 }, side);

    const sh = at(rig, `fore.${s}.shoulder`);
    const el = at(rig, `fore.${s}.elbow`);
    const hd = at(rig, `fore.${s}.hand`);
    put(b, 'shell', b.taperedLimb({ from: sh, to: el, r0: 0.1, r1: 0.07, jointR: 0.11, muscle: 1.3, sides: 8 }));
    put(b, 'shell', b.taperedLimb({ from: el, to: hd, r0: 0.072, r1: 0.05, jointR: 0.08, muscle: 1.12, sides: 8 }));
  }

  // The bio-cannon: a fused chitin tube grown out of the right forelimb, with a
  // resin bulb magazine and a glowing chamber.
  const hand = at(rig, 'fore.R.hand');
  const aim = v(0.02, -0.12, -1).normalize();
  put(b, 'maw', b.weaponMount({ base: hand.clone().addScaledVector(aim, -0.1), direction: aim, length: 0.62, radius: 0.055, bracket: 0.16, color: MAW }));
  put(b, 'shell', b.carapace({ centre: hand.clone().addScaledVector(aim, 0.02).add(v(0, 0.09, 0)), radius: 0.11, height: 0.14, length: 1.5, ridges: 4, ridgeDepth: 0.12, segments: 9, direction: v(0, 1, 0.25).normalize(), color: SHELL, colorTip: SHELL_TIP }));
  put(b, 'glow', b.lens({ centre: hand.clone().addScaledVector(aim, 0.2).add(v(0, 0.03, 0)), normal: v(1, 0.3, 0).normalize(), radius: 0.045, bulge: 0.6, color: 0xff8a24, coreColor: 0xffe6b0 }));

  return {
    rig,
    parts: b.finish(),
    height: 1.9,
    headBone: 'spine.head',
    muzzleBone: 'fore.R.hand',
    accentColor: HIVE_GLOW,
    shieldRadius: 1,
    tuning: { runSpeed: 6.5, strideScale: 0.62, kneeSign: 1, bob: 0.035, sway: 0.012, liftScale: 0.3, breathAmount: 0.03 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.2, multiplier: 2.2 },
      { region: 'body', bone: 'spine.thorax', radius: 0.36, halfHeight: 0.2, multiplier: 1 },
      { region: 'body', bone: 'abdomen.a0', radius: 0.28, multiplier: 1 },
      { region: 'limb', bone: 'leg.FL.femur', radius: 0.14, multiplier: 0.55 },
      { region: 'limb', bone: 'leg.FR.femur', radius: 0.14, multiplier: 0.55 },
      { region: 'critSpot', bone: 'spine.hips', offset: v(0, 0, 0.1), radius: 0.26, multiplier: 2.8 },
    ],
  };
}

/**
 * Spitmaw. A squat six-legged mortar: the front third of the body is one
 * enormous upward-angled maw, and the back half is the pressurised sac that
 * feeds it. Wide and low, so it never silhouettes like the soldier.
 */
function buildSpitmaw(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  hiveMaterials(b);

  const leg: HiveLegPlan = {
    lengths: [0.3, 0.36, 0.16, 0.09],
    bends: [1.2, -2.0, 0.85],
    tilt: 0.62,
    splay: 0.4,
    dz: 0,
    radius: 0.055,
  };
  const hipY = hiveHipHeight(leg);

  rig.chain('spine', ['hips', 'thorax', 'neck', 'head'], [0.42, 0.32, 0.2, 0.34], {
    origin: v(0, hipY, 0.36),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    // The maw tilts up: this is an artillery piece, and its elevation has to be
    // visible in the rest pose or the arcing shot is a surprise.
    restBend: [0.04, 0.2, 0.34, 0.24],
    capture: [0.42, 0.38, 0.24, 0.36],
  });
  rig.chain('abdomen', ['a0', 'a1', 'a2'], [0.3, 0.26, 0.2], {
    parent: 'spine.hips',
    origin: v(0, 0.08, 0.18),
    direction: v(0, -0.1, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.34, 0.3, 0.24],
  });

  const rows: Array<[number, number]> = [
    [0, -0.2],
    [1, 0.02],
    [2, 0.22],
  ];
  for (const [row, dz] of rows) {
    for (const side of [-1, 1] as const) {
      addHiveLeg(rig, `leg.${side < 0 ? 'L' : 'R'}${row}`, row === 0 ? 'spine.thorax' : 'spine.hips', { ...leg, dz }, side);
    }
  }

  const hips = at(rig, 'spine.hips');
  const thorax = at(rig, 'spine.thorax');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  put(b, 'shell', b.taperedLimb({ from: hips.clone().add(v(0, 0, 0.2)), to: thorax, r0: 0.36, r1: 0.34, jointR: 0.38, muscle: 1.14, flatten: 0.95, sides: 12 }));
  put(b, 'shell', b.taperedLimb({ from: thorax, to: neck, r0: 0.34, r1: 0.28, jointR: 0.34, muscle: 1.05, flatten: 0.95, sides: 11 }));
  put(b, 'plate', b.carapace({ centre: thorax.clone().add(v(0, 0.16, 0.03)), radius: 0.38, height: 0.2, length: 1.5, ridges: 6, ridgeDepth: 0.12, segments: 13, direction: UP, color: PLATE, colorTip: SHELL_TIP }));

  // The maw: a flaring, ribbed funnel with a dark throat and a glowing gullet.
  const mawDir = headTip.clone().sub(head).normalize();
  put(b, 'maw', b.segment({ from: neck, to: head, r0: 0.26, r1: 0.34, bulge: 1.05, flatten: 1, sides: 12, color: MAW, colorTip: DARK }));
  put(b, 'shell', b.segment({ from: head, to: headTip, r0: 0.36, r1: 0.5, flatten: 1, sides: 12, ridges: 8, ridgeDepth: 0.09, faceted: true, color: SHELL, colorTip: SHELL_TIP, capEnd: false }));
  put(b, 'glow', b.lens({ centre: head.clone().addScaledVector(mawDir, -0.02), normal: mawDir.clone(), radius: 0.27, bulge: 0.35, segments: 14, color: 0xff7a18, coreColor: 0xffe0a0 }));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    put(b, 'maw', b.spine({
      base: headTip.clone().addScaledVector(mawDir, -0.06).add(v(Math.cos(a) * 0.44, Math.sin(a) * 0.44, 0)),
      direction: mawDir.clone().addScaledVector(v(Math.cos(a), Math.sin(a), 0), 0.55).normalize(),
      length: 0.19,
      radius: 0.05,
      color: MAW,
    }));
  }
  addSpiracles(b, hips, thorax, 0.36, 2);
  addAbdomen(b, rig, 'abdomen', ['abdomen.a0', 'abdomen.a1', 'abdomen.a2'], 0.34, 0.8, false);

  for (const [row, dz] of rows) {
    for (const side of [-1, 1] as const) {
      addHiveLegGeometry(b, rig, `leg.${side < 0 ? 'L' : 'R'}${row}`, { ...leg, dz }, side);
    }
  }

  return {
    rig,
    parts: b.finish(),
    height: 1.45,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: HIVE_GLOW,
    shieldRadius: 0.95,
    tuning: { runSpeed: 5, strideScale: 0.55, kneeSign: 1, bob: 0.022, sway: 0.006, liftScale: 0.28, breathAmount: 0.045 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.34, multiplier: 1.4 },
      { region: 'body', bone: 'spine.thorax', radius: 0.38, multiplier: 1 },
      // The pressurised sac. Puncturing it is the fast way to kill a spitmaw.
      { region: 'critSpot', bone: 'abdomen.a0', radius: 0.34, multiplier: 3 },
      { region: 'body', bone: 'abdomen.a1', radius: 0.26, multiplier: 1 },
    ],
  };
}

/**
 * Ravager. A four-legged battering ram whose entire front is one fused head
 * plate — the `head` proxy is set to a 0.08 multiplier, so frontal fire is
 * genuinely wasted and the player has to break contact and shoot the flank
 * spiracles instead. Low, wide, and the only hive unit whose silhouette is
 * mostly horizontal.
 */
function buildRavager(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  hiveMaterials(b);

  const front: HiveLegPlan = {
    lengths: [0.5, 0.62, 0.26, 0.14],
    bends: [1.05, -1.88, 0.85],
    tilt: 0.42,
    splay: 0.48,
    dz: 0,
    radius: 0.095,
  };
  const back: HiveLegPlan = { ...front, splay: 0.52, radius: 0.105 };
  const hipY = hiveHipHeight(back);

  rig.chain('spine', ['hips', 'back', 'thorax', 'neck', 'head'], [0.62, 0.6, 0.46, 0.28, 0.5], {
    origin: v(0, hipY, 0.95),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    // Head *below* the shoulders: a charger leads with its plate, not its eyes.
    restBend: [0.02, 0.06, 0.1, -0.34, 0.1],
    capture: [0.5, 0.5, 0.46, 0.3, 0.5],
  });
  rig.chain('abdomen', ['a0', 'a1'], [0.4, 0.3], {
    parent: 'spine.hips',
    origin: v(0, 0.06, 0.24),
    direction: v(0, -0.25, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.4, 0.32],
  });

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    addHiveLeg(rig, `leg.F${s}`, 'spine.thorax', { ...front, dz: 0.02, gaitPhase: side < 0 ? 0 : 0.5 }, side);
    addHiveLeg(rig, `leg.B${s}`, 'spine.hips', { ...back, dz: 0.08, gaitPhase: side < 0 ? 0.5 : 0 }, side);
  }

  const hips = at(rig, 'spine.hips');
  const backB = at(rig, 'spine.back');
  const thorax = at(rig, 'spine.thorax');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  put(b, 'shell', b.taperedLimb({ from: hips.clone().add(v(0, 0, 0.3)), to: backB, r0: 0.42, r1: 0.5, jointR: 0.46, muscle: 1.1, flatten: 0.96, sides: 13 }));
  put(b, 'shell', b.taperedLimb({ from: backB, to: thorax, r0: 0.5, r1: 0.46, jointR: 0.52, muscle: 1.08, flatten: 0.98, sides: 13 }));
  put(b, 'shell', b.segment({ from: thorax, to: neck, r0: 0.42, r1: 0.34, flatten: 0.98, sides: 11 }));
  put(b, 'plate', b.carapace({ centre: backB.clone().add(v(0, 0.24, 0)), radius: 0.54, height: 0.34, length: 1.9, ridges: 7, ridgeDepth: 0.12, segments: 15, direction: UP, color: PLATE, colorTip: SHELL_TIP }));

  // The ram: a single enormous curved plate across the whole front, flanked by
  // two forward-swept horns. In silhouette this is a wedge, and the wedge is
  // the instruction — do not stand in front of it.
  const fwd = headTip.clone().sub(head).normalize();
  put(b, 'shell', b.segment({ from: neck, to: head, r0: 0.36, r1: 0.4, bulge: 1.05, flatten: 1.05, sides: 11 }));
  put(b, 'plate', b.plate({
    centre: head.clone().addScaledVector(fwd, 0.24),
    normal: fwd.clone(),
    up: v(0, 1, 0),
    width: 1.34,
    height: 0.82,
    thickness: 0.11,
    curve: 1.75,
    taper: 0.66,
    bevel: 0.3,
    color: PLATE,
    edgeColor: SHELL_TIP,
  }));
  for (const side of [-1, 1] as const) {
    put(b, 'plate', b.horn({
      base: head.clone().addScaledVector(fwd, 0.14).add(v(side * 0.42, 0.14, 0)),
      direction: fwd.clone().addScaledVector(v(side, 0, 0), 0.34).addScaledVector(v(0, 1, 0), 0.22).normalize(),
      length: 0.86,
      radius: 0.1,
      curve: 0.2,
      ridges: 6,
      twist: 0.25,
      color: PLATE,
      colorTip: SHELL_TIP,
    }));
    put(b, 'maw', b.mandible({
      base: head.clone().addScaledVector(fwd, 0.2).add(v(side * 0.2, -0.24, 0)),
      direction: fwd.clone().addScaledVector(v(0, -1, 0), 0.3).normalize(),
      inward: v(-side, 0, 0),
      length: 0.4,
      thickness: 0.07,
      flatten: 0.5,
      serrations: 4,
      color: MAW,
    }));
    put(b, 'glow', b.lens({
      centre: head.clone().addScaledVector(fwd, 0.1).add(v(side * 0.4, 0.24, 0)),
      normal: v(side * 0.8, 0.4, 0).addScaledVector(fwd, 0.4).normalize(),
      radius: 0.06,
      bulge: 0.8,
      color: 0xff7a18,
      coreColor: 0xffe0a0,
    }));
  }
  // Four big spiracles per flank — the only soft part of the animal.
  addSpiracles(b, hips, thorax, 0.5, 4);
  addAbdomen(b, rig, 'abdomen', ['abdomen.a0', 'abdomen.a1'], 0.38, 0.72, true);

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    addHiveLegGeometry(b, rig, `leg.F${s}`, { ...front, dz: 0.02 }, side);
    addHiveLegGeometry(b, rig, `leg.B${s}`, { ...back, dz: 0.08 }, side);
  }

  return {
    rig,
    parts: b.finish(),
    height: 2.4,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: HIVE_GLOW,
    shieldRadius: 1.5,
    tuning: { runSpeed: 9.5, strideScale: 0.75, kneeSign: 1, bob: 0.05, sway: 0.01, liftScale: 0.3, leanAccel: 0.02 },
    hitProxies: [
      // The plate. Near-immune, and large enough that a player shooting the
      // "head" of a charging ravager will notice they are doing nothing.
      { region: 'head', bone: 'spine.head', offset: v(0, 0, -0.3), radius: 0.62, multiplier: 0.08 },
      { region: 'body', bone: 'spine.back', radius: 0.55, halfHeight: 0.25, multiplier: 0.45 },
      { region: 'body', bone: 'spine.thorax', radius: 0.5, multiplier: 0.45 },
      // The flanks. Where the fight actually happens.
      { region: 'critSpot', bone: 'spine.hips', offset: v(0.5, 0.05, 0), radius: 0.32, multiplier: 3.2 },
      { region: 'critSpot', bone: 'spine.hips', offset: v(-0.5, 0.05, 0), radius: 0.32, multiplier: 3.2 },
      { region: 'critSpot', bone: 'spine.back', offset: v(0.55, 0.05, 0), radius: 0.32, multiplier: 3.2 },
      { region: 'critSpot', bone: 'spine.back', offset: v(-0.55, 0.05, 0), radius: 0.32, multiplier: 3.2 },
      { region: 'body', bone: 'abdomen.a0', radius: 0.36, multiplier: 1 },
      { region: 'limb', bone: 'leg.FL.femur', radius: 0.2, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.FR.femur', radius: 0.2, multiplier: 0.6 },
    ],
  };
}

/**
 * Broodmother. Rooted. A swollen birthing sac on a ring of vestigial legs, with
 * four waving feeder tendrils (`tentacle` chains, so the animator's trailing
 * solver drives them for free) and a glowing orifice at the front that opens
 * every time she hatches. She never moves and never stops producing, which is
 * the entire encounter design: kill the tap or drown.
 */
function buildBroodmother(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  hiveMaterials(b);

  const hipY = 1.15;
  rig.chain('spine', ['base', 'sac', 'neck', 'head'], [0.72, 0.66, 0.34, 0.42], {
    origin: v(0, hipY, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0.1, 0.16, 0.5, 0.65],
    capture: [0.8, 0.9, 0.4, 0.42],
  });
  // Vestigial legs: `generic`, because a sessile unit must not try to walk.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.4;
    rig.chain(`prop.${i}`, ['coxa', 'knee', 'foot'], [0.5, 0.6, 0.2], {
      parent: 'spine.base',
      origin: v(Math.sin(a) * 0.5, -0.05, Math.cos(a) * 0.5),
      direction: v(Math.sin(a) * 0.72, -0.7, Math.cos(a) * 0.72).normalize(),
      pole: UP,
      kind: 'generic',
      restBend: [1.15, -2.1, 0.6],
      capture: [0.3, 0.26, 0.2],
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.8;
    rig.chain(`tendril.${i}`, ['t0', 't1', 't2', 't3'], [0.42, 0.36, 0.3, 0.2], {
      parent: 'spine.sac',
      origin: v(Math.sin(a) * 0.42, 0.28, Math.cos(a) * 0.42),
      direction: v(Math.sin(a) * 0.55, 0.72, Math.cos(a) * 0.55).normalize(),
      pole: UP,
      kind: 'tentacle',
      gaitPhase: i / 4,
      capture: [0.2, 0.18, 0.16, 0.14],
    });
  }

  const base = at(rig, 'spine.base');
  const sac = at(rig, 'spine.sac');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  put(b, 'shell', b.taperedLimb({ from: base.clone().add(v(0, -0.45, 0)), to: sac, r0: 0.72, r1: 0.86, jointR: 0.78, muscle: 1.2, flatten: 1, sides: 14 }));
  put(b, 'shell', b.taperedLimb({ from: sac, to: neck, r0: 0.86, r1: 0.42, jointR: 0.8, muscle: 1.12, flatten: 1, sides: 13 }));
  put(b, 'plate', b.carapace({ centre: sac.clone().add(v(0, 0.12, 0)), radius: 0.92, height: 0.75, length: 1, ridges: 9, ridgeDepth: 0.13, segments: 16, direction: UP, color: PLATE, colorTip: SHELL_TIP }));
  addSpiracles(b, base, sac, 0.8, 3);

  // Egg clutch around the foot of the sac: translucent-looking amber bulbs with
  // a bright core, the visual promise of what is about to come out.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + 0.2;
    const r = 0.86 + (i % 3) * 0.12;
    const c = base.clone().add(v(Math.sin(a) * r, -0.42 + (i % 2) * 0.14, Math.cos(a) * r));
    put(b, 'shell', b.carapace({ centre: c, radius: 0.15 + (i % 3) * 0.02, height: 0.24, length: 1, segments: 8, direction: v(Math.sin(a) * 0.4, 1, Math.cos(a) * 0.4).normalize(), color: SHELL, colorTip: SHELL_TIP }));
    put(b, 'glow', b.lens({ centre: c.clone().add(v(0, 0.16, 0)), normal: UP.clone(), radius: 0.07, bulge: 0.7, color: 0xff9a2a, coreColor: 0xffe8b8 }));
  }

  // Head and birthing orifice.
  put(b, 'shell', b.segment({ from: neck, to: head, r0: 0.4, r1: 0.36, flatten: 0.95, sides: 11 }));
  const fwd = headTip.clone().sub(head).normalize();
  addHiveHead(b, head, fwd, { size: 0.28, jaw: 0.5, eyeR: 0.05, horn: 0.34, eyes: 4 });
  put(b, 'maw', b.segment({ from: head.clone().addScaledVector(fwd, 0.05), to: headTip, r0: 0.3, r1: 0.4, flatten: 1, sides: 12, ridges: 7, ridgeDepth: 0.1, color: MAW, colorTip: DARK, capEnd: false }));
  put(b, 'glow', b.lens({ centre: head.clone().addScaledVector(fwd, 0.16), normal: fwd.clone(), radius: 0.22, bulge: 0.4, segments: 13, color: 0xff7a18, coreColor: 0xffe0a0 }));

  for (let i = 0; i < 6; i++) {
    const id = `prop.${i}`;
    const coxa = at(rig, `${id}.coxa`);
    const knee = at(rig, `${id}.knee`);
    const foot = at(rig, `${id}.foot`);
    const tip = tipOf(rig, id);
    put(b, 'shell', b.taperedLimb({ from: coxa, to: knee, r0: 0.11, r1: 0.07, jointR: 0.12, muscle: 1.35, sides: 8 }));
    put(b, 'shell', b.taperedLimb({ from: knee, to: foot, r0: 0.07, r1: 0.045, jointR: 0.08, muscle: 1.1, sides: 7 }));
    put(b, 'maw', b.digit({ base: foot, direction: tip.clone().sub(foot).normalize(), length: 0.22, radius: 0.03, joints: 2, curl: 0.5, color: MAW }));
  }
  for (let i = 0; i < 4; i++) {
    const id = `tendril.${i}`;
    const bones = [`${id}.t0`, `${id}.t1`, `${id}.t2`, `${id}.t3`];
    for (let j = 0; j < bones.length; j++) {
      const from = at(rig, bones[j]);
      const to = j + 1 < bones.length ? at(rig, bones[j + 1]) : tipOf(rig, id);
      put(b, 'shell', b.segment({ from, to, r0: 0.075 - j * 0.014, r1: Math.max(0.012, 0.062 - j * 0.014), flatten: 0.9, sides: 7, ridges: 5, ridgeDepth: 0.1, color: SHELL, colorTip: SHELL_TIP }));
    }
    put(b, 'glow', b.lens({ centre: tipOf(rig, id), normal: UP.clone(), radius: 0.05, bulge: 0.9, color: 0xff9a2a, coreColor: 0xffe8b8 }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 3.2,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: HIVE_GLOW,
    shieldRadius: 1.7,
    tuning: { runSpeed: 4, bob: 0, sway: 0, breathRate: 0.35, breathAmount: 0.09, lookYawLimit: 1.2 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.34, multiplier: 1.8 },
      { region: 'body', bone: 'spine.sac', radius: 0.9, halfHeight: 0.35, multiplier: 1 },
      { region: 'body', bone: 'spine.base', radius: 0.78, multiplier: 1 },
      // The ovipositor gland. The fast kill, and it is on the exposed underside
      // — you have to get close to a thing that is making more enemies.
      { region: 'critSpot', bone: 'spine.base', offset: v(0, -0.3, -0.62), radius: 0.3, multiplier: 3.4 },
    ],
  };
}

/**
 * The Hivelord. Twelve metres of segmented worm, reared out of the ground.
 *
 * It has **no `leg` chains at all**, which switches the animator's whole gait
 * and IK stage off and leaves the body to the trailing-chain solver — so the
 * segments lag, whip and settle with real weight, and the boss costs less to
 * animate than a soldier. The rearing front is the `spine`; the body behind it
 * is one long `tail` whose segments carry the glowing weak points.
 */
function buildHivelord(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  hiveMaterials(b);

  const R = 0.95;
  rig.chain('spine', ['thorax', 'neck', 'head'], [1.5, 1.05, 1.1], {
    origin: v(0, R * 0.9, 0),
    // Reared: the base of the neck already leans 44 degrees forward out of the
    // ground, and the bends bring the skull down level with the player.
    direction: v(0, 0.72, -0.7).normalize(),
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, 0.55, 0.5],
    capture: [R * 1.4, R * 1.1, R * 1.2],
  });
  // The trailing solver hangs the chain's tip about a quarter of its reach below
  // the base, so the last two segments end up under the floor. That is on
  // purpose: the Hivelord is *erupting* from the ground, and burying its tail
  // both sells that and saves laying six metres of worm on uneven terrain.
  rig.chain('body', ['s0', 's1', 's2', 's3', 's4', 's5'], [1.3, 1.2, 1.1, 0.95, 0.8, 0.6], {
    parent: 'spine.thorax',
    origin: v(0, -0.1, 0.5),
    direction: v(0, -0.2, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [R * 1.5, R * 1.4, R * 1.3, R * 1.2, R * 1.1, R],
  });
  // Paddle legs down the body: `generic`, driven by a travelling wave in
  // `animate()`. A centipede's legs are a rhythm, not a gait.
  // Only the four segments that stay above ground get legs.
  for (let seg = 0; seg < 4; seg++) {
    for (const side of [-1, 1] as const) {
      rig.chain(`paddle.${seg}${side < 0 ? 'L' : 'R'}`, ['root', 'tip'], [0.62, 0.34], {
        parent: `body.s${seg}`,
        origin: v(side * R * 0.62, -0.1, 0),
        direction: v(side * 0.86, -0.5, 0).normalize(),
        pole: FORWARD,
        kind: 'generic',
        side,
        restBend: [0.2, 0.55],
        capture: [0.34, 0.26],
      });
    }
  }

  const thorax = at(rig, 'spine.thorax');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  put(b, 'shell', b.taperedLimb({ from: thorax, to: neck, r0: R, r1: R * 0.85, jointR: R * 1.05, muscle: 1.06, flatten: 1, ridges: 9, ridgeDepth: 0.09, sides: 14 }));
  put(b, 'shell', b.taperedLimb({ from: neck, to: head, r0: R * 0.85, r1: R * 0.72, jointR: R * 0.9, muscle: 1.05, flatten: 1, ridges: 8, ridgeDepth: 0.09, sides: 13 }));
  put(b, 'plate', b.carapace({ centre: neck.clone().add(v(0, R * 0.2, 0)), radius: R * 0.95, height: R * 0.5, length: 1.15, ridges: 8, ridgeDepth: 0.14, segments: 15, direction: v(0, 0.86, -0.5).normalize(), color: PLATE, colorTip: SHELL_TIP }));

  // Head: a mandible crown — six radial jaws around a lamprey gullet.
  const fwd = headTip.clone().sub(head).normalize();
  const up = v(0, 1, 0).addScaledVector(fwd, -fwd.y).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
  put(b, 'shell', b.segment({ from: head, to: headTip, r0: R * 0.75, r1: R * 0.92, flatten: 1, sides: 14, ridges: 6, ridgeDepth: 0.08, color: SHELL, colorTip: SHELL_TIP, capEnd: false }));
  put(b, 'maw', b.segment({ from: head.clone().addScaledVector(fwd, 0.1), to: headTip.clone().addScaledVector(fwd, -0.06), r0: R * 0.6, r1: R * 0.74, flatten: 1, sides: 13, color: MAW, colorTip: DARK, capEnd: false }));
  put(b, 'glow', b.lens({ centre: head.clone().addScaledVector(fwd, 0.24), normal: fwd.clone(), radius: R * 0.6, bulge: 0.32, segments: 16, color: 0xff6a10, coreColor: 0xffe0a0 }));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.5;
    const radial = right.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
    put(b, 'maw', b.mandible({
      base: headTip.clone().addScaledVector(fwd, -0.1).addScaledVector(radial, R * 0.86),
      direction: fwd.clone().addScaledVector(radial, 0.42).normalize(),
      inward: radial.clone().negate(),
      length: 1.25,
      thickness: 0.2,
      flatten: 0.42,
      serrations: 5,
      color: MAW,
      colorTip: DARK,
    }));
  }
  for (const side of [-1, 1] as const) {
    for (let e = 0; e < 3; e++) {
      put(b, 'glow', b.lens({
        centre: head
          .clone()
          .addScaledVector(fwd, -R * 0.3)
          .addScaledVector(right, side * R * 0.6)
          .addScaledVector(up, R * (0.2 + e * 0.24)),
        normal: right.clone().multiplyScalar(side).addScaledVector(up, 0.4).normalize(),
        radius: 0.1 - e * 0.015,
        bulge: 0.9,
        color: 0xff8a24,
        coreColor: 0xffe6b0,
      }));
    }
  }

  // Body segments. Each is a ridged ring with a plated dorsal shield and, on
  // the underside, an exposed membrane that glows — the segment weak point.
  const segs = ['body.s0', 'body.s1', 'body.s2', 'body.s3', 'body.s4', 'body.s5'];
  for (let i = 0; i < segs.length; i++) {
    const from = at(rig, segs[i]);
    const to = i + 1 < segs.length ? at(rig, segs[i + 1]) : tipOf(rig, 'body');
    const ra = R * (1.05 - i * 0.1);
    const rb = R * (1.05 - (i + 1) * 0.1);
    put(b, 'shell', b.segment({ from, to, r0: ra, r1: Math.max(0.16, rb), bulge: 1.2, flatten: 1, ridges: 10, ridgeDepth: 0.09, sides: 13, color: SHELL, colorTip: SHELL_TIP }));
    put(b, 'plate', b.plate({
      centre: from.clone().lerp(to, 0.42).add(v(0, ra * 0.78, 0)),
      normal: v(0, 1, 0.1).normalize(),
      up: to.clone().sub(from).normalize(),
      width: ra * 2.15,
      height: from.distanceTo(to) * 1.05,
      thickness: ra * 0.13,
      curve: 1.4,
      taper: 0.86,
      color: PLATE,
      edgeColor: SHELL_TIP,
    }));
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      put(b, 'maw', b.spine({
        base: from.clone().lerp(to, 0.45).add(v(Math.sin(a) * ra * 0.8, Math.cos(a) * ra * 0.8, 0)),
        direction: v(Math.sin(a) * 0.8, Math.cos(a) * 0.8, 0.5).normalize(),
        length: ra * 0.85,
        radius: ra * 0.13,
        color: MAW,
      }));
    }
    // The weak point: a glowing intersegmental membrane on the flanks.
    for (const side of [-1, 1] as const) {
      put(b, 'glow', b.lens({
        centre: from.clone().lerp(to, 0.12).add(v(side * ra * 0.82, -ra * 0.15, 0)),
        normal: v(side, -0.2, 0).normalize(),
        radius: ra * 0.3,
        bulge: 0.4,
        color: 0xff6a10,
        coreColor: 0xffdc9a,
      }));
    }
  }

  for (let seg = 0; seg < 4; seg++) {
    for (const side of [-1, 1] as const) {
      const id = `paddle.${seg}${side < 0 ? 'L' : 'R'}`;
      const root = at(rig, `${id}.root`);
      const tipB = at(rig, `${id}.tip`);
      const end = tipOf(rig, id);
      put(b, 'shell', b.taperedLimb({ from: root, to: tipB, r0: 0.15, r1: 0.09, jointR: 0.17, muscle: 1.3, flatten: 0.7, sides: 8 }));
      put(b, 'maw', b.digit({ base: tipB, direction: end.clone().sub(tipB).normalize(), length: 0.42, radius: 0.05, joints: 2, curl: 0.45, color: MAW }));
    }
  }

  return {
    rig,
    parts: b.finish(),
    height: 4.4,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: HIVE_GLOW,
    shieldRadius: 2.6,
    tuning: { runSpeed: 8, bob: 0, sway: 0, breathRate: 0.3, breathAmount: 0.07, lookYawLimit: 1.5, lookPitchLimit: 1.1, leanTurn: 0.28 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.8, multiplier: 1.5 },
      { region: 'body', bone: 'spine.neck', radius: 0.8, multiplier: 1 },
      { region: 'body', bone: 'spine.thorax', radius: 0.9, multiplier: 0.8 },
      // Six destructible segments. Each is a crit, and the behaviour tree reads
      // total health to escalate as they come apart.
      { region: 'critSpot', bone: 'body.s0', radius: 0.72, multiplier: 2.4 },
      { region: 'critSpot', bone: 'body.s1', radius: 0.68, multiplier: 2.4 },
      { region: 'critSpot', bone: 'body.s2', radius: 0.62, multiplier: 2.4 },
      { region: 'critSpot', bone: 'body.s3', radius: 0.56, multiplier: 2.4 },
      { region: 'body', bone: 'body.s4', radius: 0.5, multiplier: 1 },
      { region: 'body', bone: 'body.s5', radius: 0.42, multiplier: 1 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const chainCache = new WeakMap<RigInstance, Map<string, ChainRuntime[]>>();

function chainsWithPrefix(rig: RigInstance, prefix: string): ChainRuntime[] {
  let byPrefix = chainCache.get(rig);
  if (!byPrefix) {
    byPrefix = new Map();
    chainCache.set(rig, byPrefix);
  }
  let list = byPrefix.get(prefix);
  if (!list) {
    list = rig.chains.filter((c) => c.def.id.startsWith(prefix));
    byPrefix.set(prefix, list);
  }
  return list;
}

/**
 * Hive units chatter. A constant mandible tremor plus a spine-driven ripple down
 * the paddle legs is what stops forty identical bodies reading as forty copies
 * of one asset: their phases are offset by entity id, so the mass never pulses
 * in unison.
 */
function insectAnimate(agent: EnemyAgent, ctx: AnimationContext): void {
  const dt = Math.max(1e-4, ctx.dt);
  const { coil, swing } = attackPose(agent, dt);
  const phase = (vGet(agent, 'hvPhase') + dt * (1.1 + (agent.entityId % 7) * 0.06)) % 1;
  vSet(agent, 'hvPhase', phase);
  const rig = agent.rig;
  let touched = false;

  // Forelimbs (soldier): hold the cannon, recoil on the strike.
  const fore = chainsWithPrefix(rig, 'fore.');
  if (fore.length) {
    touched = true;
    const kick = swing * 0.55 - coil * 0.28;
    for (const c of fore) {
      if (c.bones.length < 3) continue;
      fkBend(rig, c, 0, Math.sin(phase * TAU) * 0.05 + kick * 0.5);
      fkBend(rig, c, 1, -kick);
    }
  }

  // Vestigial props (broodmother): a slow shuffling twitch.
  const props = chainsWithPrefix(rig, 'prop.');
  if (props.length) {
    touched = true;
    for (let i = 0; i < props.length; i++) {
      const c = props[i];
      if (c.bones.length < 2) continue;
      const p = (phase + i / props.length) * TAU;
      fkBend(rig, c, 0, Math.sin(p) * 0.1);
      fkBend(rig, c, 1, Math.cos(p * 0.7) * 0.12);
    }
  }

  // Paddle legs (hivelord): a travelling metachronal wave, head to tail, the
  // way a real centipede's legs move.
  const paddles = chainsWithPrefix(rig, 'paddle.');
  if (paddles.length) {
    touched = true;
    const speed = clamp01(agent.ai.speed / Math.max(1, agent.archetype.sprintSpeed));
    for (const c of paddles) {
      if (c.bones.length < 2) continue;
      // "paddle.<seg><side>" — the segment index is the character after the dot.
      const seg = Number(c.def.id.charAt(7)) || 0;
      const p = (phase * 2.6 - seg * 0.16) * TAU;
      const amp = 0.35 + speed * 0.5;
      fkBend(rig, c, 0, Math.sin(p) * amp);
      fkBend(rig, c, 1, 0.4 + Math.cos(p) * amp * 0.6);
    }
  }

  if (touched) rig.syncWorld(agent.anim.rootPosition, agent.anim.rootQuaternion);

  // The charge stance: the ravager drops its head plate and flattens out. Done
  // through the animator's own lean spring rather than by posing bones, so it
  // composes with the gait instead of fighting it.
  if (agent.archetype.id === 'insect_ravager') {
    const charging = vGet(agent, 'hvCharge');
    const blend = damp(vGet(agent, 'hvChargeBlend'), charging, 6, dt);
    vSet(agent, 'hvChargeBlend', blend);
    if (blend > 0.01) {
      const spine = rig.chain('spine');
      if (spine) {
        for (let i = 0; i < spine.bones.length; i++) {
          const w = lerp(0.2, 1, i / Math.max(1, spine.bones.length - 1));
          fkBend(rig, spine, i, -blend * 0.22 * w);
        }
        rig.syncWorld(agent.anim.rootPosition, agent.anim.rootQuaternion);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

const hiveIdleTail = (radius: number): BehaviorTree['root'][] => [
  guard(
    (c) => c.brain.percept.state === 'searching',
    sel(seq(searchLastKnown(0.9), scanArea(1.3)), scanArea(1.1)),
  ),
  guard(
    (c) => c.brain.percept.state === 'suspicious',
    seq(btBark('suspicious'), sel(searchLastKnown(0.6), scanArea(1.5))),
  ),
  patrolArea(radius, 0.4),
];

/**
 * Swarmlings have almost no tree, on purpose. They run at you, they bite, they
 * die. Everything interesting about a swarm is emergent from separation,
 * pathing and count — a swarmling that takes cover is a bug, not a feature.
 */
const SWARMLING_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state !== 'unaware',
      par(
        'all',
        'all',
        sel(
          // A short scuttle-hop to break the conga line: half the pack peels
          // wide so they arrive as a crescent, not a queue.
          fail(btCooldown(4, timeout(1.4, moveToFlank((c) => (c.brain.agent.entityId % 2 ? 1 : -1), 4, 1)))),
          advanceToRange(1.4, 1),
          strafeAtRange(1.8, 1),
        ),
        sel(meleeStrike(1.8, 0.35), btWait(0.2)),
      ),
    ),
    patrolArea(10, 0.6),
  ),
);

/** Fire an amber resin bolt burst after a visible charge in the cannon bulb. */
const cannonBurst = (): BehaviorTree['root'] =>
  seq(
    faceTarget(0.26),
    telegraph(0.45, 'bioCannon', 'taunt'),
    btAction('burst', (c) => {
      const brain = c.brain;
      const bb = brain.bb;
      const slot = c.nodeId;
      const agent = brain.agent as unknown as EnemyAgent;
      const prev = bb.nodeTimer[slot];
      const now = prev + c.dt;
      bb.nodeTimer[slot] = now;
      const gap = 0.14;
      for (let i = 0; i < 4; i++) {
        const t = i * gap;
        if (prev < t && now >= t) {
          agent.anim.attack(0.02, 0.05, 0.12);
          c.host.fireAt(brain, c.host.target.centre);
        }
      }
      brain.cmd.facePoint.copy(c.host.target.centre);
      brain.cmd.faceValid = true;
      brain.cmd.speed = 0.3;
      if (now >= 4 * gap) {
        bb.nodeTimer[slot] = 0;
        return SUCCESS;
      }
      return RUNNING;
    }),
    btWait(0.5),
  );

/**
 * Burrow: drop out of the world, travel, and erupt somewhere the player is not
 * looking. The unit is invisible and unhittable while under, which is the whole
 * point — it is a repositioning tool, not an escape.
 */
const burrowTo = (distance: number, seconds: number): BehaviorTree['root'] =>
  seq(
    btBark('cover'),
    btAction('submerge', (c) => {
      const agent = c.brain.agent as unknown as EnemyAgent;
      agent.object.visible = false;
      c.brain.cmd.mode = 'stop';
      c.host.bark(c.brain, 'cover');
      return SUCCESS;
    }),
    btAction('travel', (c) => {
      const brain = c.brain;
      const bb = brain.bb;
      const slot = c.nodeId;
      bb.nodeTimer[slot] += c.dt;
      // Move underground toward a point flanking the target.
      const agent = brain.agent as unknown as EnemyAgent;
      _bv.subVectors(agent.position, c.host.target.centre);
      _bv.y = 0;
      const a = Math.atan2(_bv.x, _bv.z) + c.dt * 2.2;
      _bv2.set(
        c.host.target.centre.x + Math.sin(a) * distance,
        agent.position.y,
        c.host.target.centre.z + Math.cos(a) * distance,
      );
      if (c.host.nav.snap(_bv2, _bv, 8)) agent.position.copy(_bv);
      agent.velocity.set(0, 0, 0);
      brain.cmd.mode = 'stop';
      if (bb.nodeTimer[slot] >= seconds) {
        bb.nodeTimer[slot] = 0;
        return SUCCESS;
      }
      return RUNNING;
    }),
    btAction('erupt', (c) => {
      const agent = c.brain.agent as unknown as EnemyAgent;
      agent.object.visible = true;
      // Re-seat the animator: the body teleported, and without this the footstep
      // planner would try to walk the old plants back under the new position.
      agent.anim.reset(agent.position, agent.yaw, agent.position.y);
      _bv.copy(agent.position);
      _bv.y += 0.4;
      agent.anim.hit(_bv, _bv2.set(0, 1, 0), 1.4);
      return SUCCESS;
    }),
    btWait(0.4),
  );

const SOLDIER_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        sel(
          fail(seq(btCond('hurt', (c) => c.brain.agent.health / c.brain.agent.maxHealth < 0.4), btCooldown(9, burrowTo(14, 1.6)))),
          fail(seq(takeCover(22, false, 0.95), holdCover(2.2), leaveCover())),
          fail(btCooldown(5, timeout(3, repositionFiring(10, 0.85)))),
          advanceToRange(14, 0.8),
          strafeAtRange(15, 0.6),
        ),
        sel(withAttackToken(cannonBurst()), btWait(0.4)),
      ),
    ),
    ...hiveIdleTail(14),
  ),
);

/** Lob an amber glob on a mortar arc and leave a corrosive pool where it lands. */
const acidMortar = (range: number, damage: number, poolR: number, poolDps: number): BehaviorTree['root'] =>
  seq(
    btCond('mortarRange', (c) => {
      const d = c.brain.agent.position.distanceTo(c.host.target.centre);
      return d > 7 && d < range;
    }),
    faceTarget(0.3),
    // A full second of visible charge in the gullet: this is artillery, and the
    // player has to be given the time to leave the impact circle.
    telegraph(0.95, 'acidMortar', 'taunt'),
    btAction('mortar', (c) => {
      const agent = c.brain.agent as unknown as EnemyAgent;
      agent.anim.attack(0.05, 0.14, 0.4);
      agent.rig.boneWorld(agent.headBone, _bv);
      _bv2.copy(c.host.target.centre).addScaledVector(c.host.target.velocity, 0.5);
      HIVE_ACID.lob(agent.object, _bv, _bv2, 34, 18, damage, poolR, poolDps, 9);
      return SUCCESS;
    }),
    btWait(0.8),
  );

const SPITMAW_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state === 'engaged',
      par(
        'all',
        'all',
        sel(
          // Flushable: closing on a spitmaw makes it break cover and waddle,
          // which is when it is worth killing.
          fail(seq(btCond('crowded', (c) => c.brain.agent.position.distanceTo(c.host.target.centre) < 12), btBark('cover'), timeout(3.5, retreatFrom(20, 1)))),
          fail(seq(takeCover(26, true, 0.9), holdCover(3), leaveCover())),
          holdPosition(),
        ),
        sel(withAttackToken(acidMortar(40, 30, 4, 26)), btWait(0.6)),
      ),
    ),
    ...hiveIdleTail(8),
  ),
);

/**
 * The charge. A long, loud, straight-line commitment: 0.9 s of wind-up with the
 * head plate dropping, then a leap-flat sprint at the player's *last* position.
 * Miss, and the ravager buries its horns and is stunned for two seconds with its
 * flanks presented — the punish window the whole unit is built around.
 */
const ravagerCharge = (): BehaviorTree['root'] =>
  seq(
    btCond('chargeRange', (c) => {
      const d = c.brain.agent.position.distanceTo(c.host.target.centre);
      return d > 6 && d < 26 && c.brain.percept.hasLos;
    }),
    faceTarget(0.2),
    btAction('lowerPlate', (c) => {
      vSet(c.brain.agent as unknown as EnemyAgent, 'hvCharge', 1);
      return SUCCESS;
    }),
    telegraph(0.9, 'charge', 'charge'),
    btAction('commit', (c) => {
      const brain = c.brain;
      const bb = brain.bb;
      const slot = c.nodeId;
      const agent = brain.agent as unknown as EnemyAgent;
      if (bb.nodeTimer[slot] <= 0) {
        // Aim at where the player was, not where they are. That is what makes
        // the charge dodgeable rather than a homing missile with hooves.
        bb.vec[0].copy(c.host.target.centre);
        _bv.subVectors(bb.vec[0], agent.position);
        _bv.y = 0;
        _bv.normalize().multiplyScalar(9).add(bb.vec[0]);
        bb.vec[1].copy(_bv);
      }
      bb.nodeTimer[slot] += c.dt;
      brain.cmd.mode = 'seek';
      brain.cmd.target.copy(bb.vec[1]);
      brain.cmd.speed = 1;
      brain.cmd.facePoint.copy(bb.vec[1]);
      brain.cmd.faceValid = true;
      if (agent.position.distanceTo(c.host.target.centre) < 2.6) {
        c.host.fireAt(brain, c.host.target.centre);
        agent.anim.attack(0.02, 0.1, 0.3);
        bb.nodeTimer[slot] = 0;
        vSet(agent, 'hvCharge', 0);
        return SUCCESS;
      }
      // Ran out of runway, or hit something: stagger.
      if (bb.nodeTimer[slot] > 2.4 || brain.steer.stuckFor > 0.35) {
        bb.nodeTimer[slot] = 0;
        vSet(agent, 'hvCharge', 0);
        vSet(agent, 'hvStagger', 1);
        agent.anim.hit(agent.position, _bv.set(0, 0, 1), 2.4);
        return SUCCESS;
      }
      return RUNNING;
    }),
    // The punish window.
    btAction('recover', (c) => {
      const agent = c.brain.agent as unknown as EnemyAgent;
      if (vGet(agent, 'hvStagger') < 0.5) return SUCCESS;
      const bb = c.brain.bb;
      bb.nodeTimer[c.nodeId] += c.dt;
      c.brain.cmd.mode = 'stop';
      if (bb.nodeTimer[c.nodeId] >= 2) {
        bb.nodeTimer[c.nodeId] = 0;
        vSet(agent, 'hvStagger', 0);
        return SUCCESS;
      }
      return RUNNING;
    }),
  );

const RAVAGER_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state !== 'unaware',
      par(
        'all',
        'all',
        sel(
          fail(btCooldown(6, ravagerCharge())),
          advanceToRange(3, 1),
          strafeAtRange(4, 0.7),
        ),
        sel(withAttackToken(meleeStrike(3.4, 0.55)), btWait(0.4)),
      ),
    ),
    ...hiveIdleTail(12),
  ),
);

const BROODMOTHER_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state !== 'unaware',
      par(
        'all',
        'all',
        // She cannot move. Facing is the only "movement" she has.
        seq(faceTarget(0.5), holdPosition()),
        sel(
          // The tap. Every four seconds, another handful, forever, until she is
          // dead. The rate rises as she is hurt so the pressure escalates.
          btCooldown(
            (c) => lerp(4.4, 2.4, 1 - c.brain.agent.health / Math.max(1, c.brain.agent.maxHealth)),
            seq(
              btCond('canSpawn', () => spawner !== null),
              telegraph(0.6, 'spawn', 'reinforce'),
              btAction('hatch', (c) => {
                const agent = c.brain.agent as unknown as EnemyAgent;
                agent.anim.attack(0.05, 0.15, 0.5);
                hatch(agent, 'insect_swarmling', 4, 2.4);
                return SUCCESS;
              }),
            ),
          ),
          btCooldown(3.5, withAttackToken(acidMortar(34, 22, 3.4, 20))),
          btWait(0.5),
        ),
      ),
    ),
    holdPosition(),
  ),
);

/** Phase by health: 0 = surface duel, 1 = burrow-and-ambush, 2 = enraged flail. */
function hivelordPhase(health: number, maxHealth: number): number {
  const f = health / Math.max(1, maxHealth);
  return f > 0.66 ? 0 : f > 0.33 ? 1 : 2;
}

/**
 * A body slam: the reared front third comes down across an arc. Long wind-up,
 * a cone the player can simply walk out of, and it escalates by phase.
 */
const bodySlam = (windup: number, reach: number): BehaviorTree['root'] =>
  seq(
    btCond('slamRange', (c) => c.brain.agent.position.distanceTo(c.host.target.centre) < reach + 3),
    faceTarget(0.4),
    telegraph(windup, 'bodySlam', 'charge'),
    btAction('slam', (c) => {
      const agent = c.brain.agent as unknown as EnemyAgent;
      agent.anim.attack(0.05, 0.2, 0.5);
      agent.rig.boneWorld(agent.headBone, _bv);
      // The slam throws ichor in a ring; the pools are the real hazard.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + agent.yaw;
        _bv2.set(agent.position.x + Math.sin(a) * 4, agent.position.y, agent.position.z + Math.cos(a) * 4);
        HIVE_ACID.lob(agent.object, _bv, _bv2, 26, 16, 18, 2.6, 22, 5);
      }
      if (agent.position.distanceTo(c.host.target.centre) < reach) {
        c.host.fireAt(c.brain, c.host.target.centre);
      }
      return SUCCESS;
    }),
    btWait(0.7),
  );

/** A sweeping cone of ichor from the gullet. Wide, slow, and telegraphed. */
const ichorSpray = (): BehaviorTree['root'] =>
  seq(
    faceTarget(0.3),
    telegraph(0.85, 'ichorSpray', 'taunt'),
    btAction('spray', (c) => {
      const brain = c.brain;
      const bb = brain.bb;
      const slot = c.nodeId;
      const agent = brain.agent as unknown as EnemyAgent;
      const prev = bb.nodeTimer[slot];
      const now = prev + c.dt;
      bb.nodeTimer[slot] = now;
      agent.rig.boneWorld(agent.headBone, _bv);
      // Sweep across 70 degrees over 1.1 s, one glob every 0.12 s.
      if (Math.floor(now / 0.12) > Math.floor(prev / 0.12) && now < 1.1) {
        const t = now / 1.1 - 0.5;
        const a = agent.yaw + t * 1.25;
        const r = 12;
        _bv2.set(agent.position.x - Math.sin(a) * r, agent.position.y, agent.position.z - Math.cos(a) * r);
        HIVE_ACID.lob(agent.object, _bv, _bv2, 22, 24, 14, 2.4, 20, 6);
      }
      brain.cmd.mode = 'stop';
      if (now >= 1.3) {
        bb.nodeTimer[slot] = 0;
        return SUCCESS;
      }
      return RUNNING;
    }),
    btWait(0.5),
  );

const HIVELORD_TREE = compileTree(
  sel(
    guard(
      (c) => c.brain.percept.state !== 'unaware',
      par(
        'all',
        'all',
        sel(
          // Phase 1 onward: burrow between the arena's tunnel mouths and erupt
          // somewhere new. It is the boss's only repositioning tool and the
          // reason the arena has to be fought as a whole.
          fail(guard(
            (c) => hivelordPhase(c.brain.agent.health, c.brain.agent.maxHealth) >= 1,
            btCooldown(11, burrowTo(11, 2.2)),
          )),
          fail(guard(
            (c) => hivelordPhase(c.brain.agent.health, c.brain.agent.maxHealth) >= 1,
            btCooldown(16, seq(
              btCond('canSpawn', () => spawner !== null),
              btBark('reinforce'),
              btAction('brood', (c) => {
                hatch(c.brain.agent as unknown as EnemyAgent, 'insect_swarmling', 6, 4.5);
                return SUCCESS;
              }),
            )),
          )),
          advanceToRange(7, 0.9),
          strafeAtRange(9, 0.55),
        ),
        sel(
          // Enraged: the spray comes out twice as often and the slam is faster.
          guard(
            (c) => hivelordPhase(c.brain.agent.health, c.brain.agent.maxHealth) === 2,
            sel(btCooldown(5, ichorSpray()), withAttackToken(bodySlam(0.55, 9))),
          ),
          btCooldown(9, ichorSpray()),
          withAttackToken(bodySlam(0.8, 8)),
          btWait(0.5),
        ),
      ),
    ),
    scanArea(3),
  ),
);

export const INSECT_BEHAVIOURS: Record<string, BehaviorTree> = {
  insect_swarmling: SWARMLING_TREE,
  insect_soldier: SOLDIER_TREE,
  insect_spitmaw: SPITMAW_TREE,
  insect_ravager: RAVAGER_TREE,
  insect_broodmother: BROODMOTHER_TREE,
  insect_hivelord: HIVELORD_TREE,
};

/** Hand the trees to the AI director: `installInsectoidBehaviours(ai)`. */
export function installInsectoidBehaviours(director: {
  registerBehaviour(archetypeId: string, tree: BehaviorTree): void;
}): void {
  for (const id of Object.keys(INSECT_BEHAVIOURS)) director.registerBehaviour(id, INSECT_BEHAVIOURS[id]);
  for (const [catalogueId, unitId] of INSECT_ALIASES) {
    director.registerBehaviour(catalogueId, INSECT_BEHAVIOURS[unitId]);
  }
}

// ---------------------------------------------------------------------------
// Fallback behaviour, used when no AI director is driving
// ---------------------------------------------------------------------------

function hiveFallback(archetype: EnemyArchetype, ranged: boolean, spawns: string | null): BehaviourNode {
  const base = standardCombatBehaviour(archetype);
  let spawnTimer = 4;
  return parallel(
    action((_agent, ctx) => {
      HIVE_ACID.advance(ctx);
      return 'running';
    }),
    selector(
      // `success`, not `running`: a sequence that returns `running` latches its
      // child index and stops re-evaluating the condition.
      sequence(
        condition((agent) => agent.externalMotion),
        action(() => 'success'),
      ),
      parallel(
        base,
        action((agent, ctx) => {
          if (spawns) {
            spawnTimer -= ctx.dt;
            if (spawnTimer <= 0 && ctx.targetValid && agent.ai.alert > 0.5) {
              spawnTimer = 4.5;
              hatch(agent, spawns, 3, 2.2);
            }
          }
          if (!ranged) return 'running';
          if (!ctx.targetValid || !ctx.target) return 'running';
          if (agent.ai.vars.get('attackPending') !== 1) return 'running';
          if (!agent.anim.attackStriking) return 'running';
          agent.ai.vars.set('attackPending', 0);
          agent.rig.boneWorld(agent.muzzleBone, _bv);
          HIVE_ACID.lob(agent.object, _bv, ctx.targetPosition, 30, 20, archetype.attackDamage * 1.5, 3.4, 20, 8);
          return 'running';
        }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const BUILDERS: Record<string, (ctx: BodyBuildContext) => BuiltBody> = {
  insect_swarmling: buildSwarmling,
  insect_soldier: buildSoldier,
  insect_spitmaw: buildSpitmaw,
  insect_ravager: buildRavager,
  insect_broodmother: buildBroodmother,
  insect_hivelord: buildHivelord,
};

const RANGED = new Set(['insect_spitmaw', 'insect_broodmother', 'insect_hivelord']);
const SPAWNS: Record<string, string> = {
  insect_broodmother: 'insect_swarmling',
  insect_hivelord: 'insect_swarmling',
};

function register(archetype: EnemyArchetype, build: (ctx: BodyBuildContext) => BuiltBody, unitId: string): void {
  EnemyManager.register({
    archetype,
    build,
    behaviour: () => hiveFallback(archetype, RANGED.has(unitId), SPAWNS[unitId] ?? null),
    animate: insectAnimate,
  });
}

for (const id of Object.keys(INSECT_ARCHETYPES)) register(INSECT_ARCHETYPES[id], BUILDERS[id], id);

for (const [catalogueId, unitId] of INSECT_ALIASES) {
  const a = ARCHETYPES[catalogueId];
  if (!a) continue;
  register(a, BUILDERS[unitId], unitId);
}

/** Ids of every Insectoid unit, in roster order. */
export const INSECT_UNITS: readonly string[] = Object.keys(INSECT_ARCHETYPES);

/** Release the faction's shared effect pools. Levels call this on teardown. */
export function disposeInsectoidEffects(): void {
  HIVE_ACID.dispose();
}
