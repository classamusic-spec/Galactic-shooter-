/**
 * The Greys — the psionic swarm of Zeta Reticuli.
 *
 * ## Art direction
 *
 * The classic abduction grey, made genuinely unsettling rather than cute.
 * Smooth grey-mauve skin with no visible musculature, an oversized cranium
 * that overhangs the jaw, enormous black almond eyes with a faint violet inner
 * glow, no mouth at all, and limbs that are too thin for the mass they carry.
 * Their machines are the opposite: seamless white alloy with no fasteners, no
 * panel lines and no wear, hovering silently, lit from inside by violet.
 *
 * The unease is in the *contrast* — organic bodies that look under-built next
 * to hardware that looks impossibly finished — and in the stillness. Greys hold
 * a pose, then move in one fast burst. The animator tuning below is deliberately
 * low-amplitude everywhere except the burst.
 *
 * ## Silhouette contract (readable as a black shape, no nameplate)
 *
 * | unit      | h    | stance                        | the read                       |
 * |-----------|------|-------------------------------|--------------------------------|
 * | Drone     | 0.6  | hovering orb                  | a lens on a ring, three fins   |
 * | Observer  | 2.0  | hovers, limbs hanging         | limp legs + orbiting debris    |
 * | Operative | 1.95 | walks, weapon low             | small body, huge skull         |
 * | Psion     | 2.35 | walks inside an alloy shell   | shoulder yoke + floating halo  |
 * | Overseer  | 3.2  | hovers, arms past the knees   | a needle with trailing legs    |
 * | Overmind  | 5.0  | suspended, never touches down | two-lobed brain in a cradle    |
 *
 * ## Faction mechanics
 *
 * Void. Every projected field is a **real** object registered with the
 * collision world: the Psion's barrier dome stops the player's rounds until it
 * is broken (or until the player walks inside it), the Overmind is untouchable
 * while its tether nodes live, and the Overseer's lift takes real control away
 * for a moment and gives a real input back to break it.
 *
 * ## Integration seams this module needs from other owners
 *
 * - `setGreySummoner()` — hand it `enemies.spawn`; the Overmind's drone swarm
 *   and its tether nodes both come from it. Without it the boss falls back to a
 *   permanently-vulnerable single phase rather than breaking.
 * - `registerGreyBehaviours(director)` — installs the compiled AI-layer trees.
 */
import * as THREE from 'three';
import type { CollisionWorld, DamageInfo, Damageable, EnemyArchetype } from '@/types';
import { clamp, clamp01, damp, Rng } from '@/util/math';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import type { HitProxy } from '@/gameplay/Physics';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { ARCHETYPES, FACTION_ACCENT } from '../Archetypes';
import { DOWN, FORWARD, UP } from '../Rig';
import { EnemyManager } from '../EnemyManager';
import {
  action,
  condition,
  selector,
  sequence,
  type BehaviourContext,
  type BehaviourNode,
  type BodyBuildContext,
  type BuiltBody,
  type EnemyAgent,
  type SpeciesDefinition,
} from '../EnemyAgent';
import type { AnimationContext } from '../ProceduralAnimator';
import {
  RUNNING,
  SUCCESS,
  FAILURE,
  advanceToRange,
  compileTree,
  cond,
  fail,
  faceTarget,
  fireBurst,
  guard,
  holdPosition,
  par,
  patrolArea,
  repositionFiring,
  scanArea,
  searchLastKnown,
  sel,
  seq,
  strafeAtRange,
  telegraph,
  withAttackToken,
  action as btAction,
  bark as btBark,
  type BehaviorTree,
  type BtContext,
} from '@/gameplay/ai/BehaviorTree';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Faction colour identity: violet void light, near-black ichor. */
export const GREY = {
  accent: FACTION_ACCENT.grey,
  /** Grey-mauve skin. Desaturated, slightly warm in the shadows. */
  skin: 0x8f87a0,
  /** Seamless white alloy — the machines. */
  alloy: 0xe4e7ee,
  /** The alloy's shadow value, for recesses and under-structure. */
  deep: 0x272430,
  /** The eyes. Almost pure black, faintly reflective. */
  eye: 0x08060d,
  /** Void light. */
  glow: 0xb478ff,
  /** Ichor. */
  ichor: 0x1d1230,
} as const;

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Brief-facing unit names → catalogue archetype ids. */
export const GREY_UNITS = {
  grey_drone: 'grey.drone',
  grey_levitator: 'grey.observer',
  grey_operative: 'grey.operative',
  grey_overseer: 'grey.psion',
  grey_abductor: 'grey.overseer',
  grey_hivemind: 'grey.overmind',
} as const;

/**
 * The Operative has no slot in the shared catalogue (five Grey entries ship
 * there), so it is declared here with every field filled. A standard-rank
 * walking soldier: the only Grey that holds a weapon and takes ground.
 */
const OPERATIVE: EnemyArchetype = {
  id: 'grey.operative',
  faction: 'grey',
  rank: 'standard',
  displayName: 'Operative',
  health: 130,
  shield: 60,
  shieldElement: 'void',
  moveSpeed: 3.3,
  sprintSpeed: 6.4,
  preferredRange: 17,
  eyeHeight: 1.72,
  capsuleRadius: 0.32,
  capsuleHalfHeight: 0.7,
  attackDamage: 11,
  attackInterval: 0.85,
  accuracy: 0.03,
  aggression: 0.6,
  caution: 0.5,
  flying: false,
  score: 28,
  abilities: ['blink', 'beam'],
};

/** Every Grey archetype this module registers, catalogue entries included. */
export const GREY_ARCHETYPES: Record<string, EnemyArchetype> = {
  'grey.drone': ARCHETYPES['grey.drone'],
  'grey.observer': ARCHETYPES['grey.observer'],
  'grey.operative': OPERATIVE,
  'grey.psion': ARCHETYPES['grey.psion'],
  'grey.overseer': ARCHETYPES['grey.overseer'],
  'grey.overmind': ARCHETYPES['grey.overmind'],
};

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

function at(ctx: BodyBuildContext, name: string): THREE.Vector3 {
  return ctx.rig.restPosition(name, new THREE.Vector3());
}

function tip(ctx: BodyBuildContext, chainId: string): THREE.Vector3 {
  const c = ctx.rig.chainById(chainId);
  return c ? c.restTip.clone() : new THREE.Vector3();
}

/**
 * Five materials. The value split is skin (mid) against alloy (near-white)
 * against deep (near-black), so a Grey in armour still reads as a pale figure
 * inside a white shell rather than as one grey mass.
 */
function greyMaterials(ctx: BodyBuildContext): void {
  const b = ctx.builder;
  // Library albedos are authored physically and the flesh recipe is a warm
  // brown, so the skin's diffuse multiplier is >1 and heavily blue-weighted —
  // `THREE.Color` is unclamped and the multiply is linear, so the recipe's vein
  // and pore detail survives while the hue lands on grey-mauve. `repeat` below
  // 1 enlarges the pattern; at 1:1 the pores were 2 mm and read as noise.
  const skin = b.material('skin', 'flesh', { roughness: 1.05, metalness: 0.03, repeat: 0.6 });
  skin.color.setRGB(0.78, 1.5, 2.7);
  skin.normalScale.setScalar(0.3);
  skin.envMapIntensity = 0.28;
  const alloy = b.material('alloy', 'greyAlloy', { roughness: 1.6, metalness: 0.45, repeat: 0.45 });
  alloy.color.setRGB(1.02, 1.04, 1.12);
  alloy.normalScale.setScalar(0.5);
  // The Greys' alloy is bright but not a mirror: a full-strength environment on
  // a metallic white shell turns every unit into chrome.
  alloy.envMapIntensity = 0.45;
  const deep = b.material('deep', 'greyAlloy', { roughness: 1.9, metalness: 0.6, repeat: 0.45 });
  deep.color.setRGB(0.075, 0.07, 0.095);
  deep.envMapIntensity = 0.3;
  const eye = b.material('eye', 'obsidian', { roughness: 0.45, metalness: 0.1, repeat: 0.5 });
  // Not pure black: an eye with no value at all is a hole, and the whole point
  // of these eyes is that they read as wet.
  eye.color.setRGB(0.6, 0.56, 0.78);
  eye.envMapIntensity = 1.4;
  // 2.4 rather than 3.2: the violet has to stay violet after tone mapping.
  b.emissive('void', GREY.glow, 2.4);
}

/**
 * The head that defines the species: a cranium far too wide at the temples,
 * a jaw that tapers to nothing, no mouth, and two enormous almond eyes with a
 * violet pinprick behind the black.
 *
 * `wrap` stretches the skull backwards for the taller castes; `crest` adds the
 * swept ridge the Overseer and Overmind carry.
 */
function greyHead(
  ctx: BodyBuildContext,
  head: THREE.Vector3,
  scale: number,
  crest: boolean,
): void {
  const b = ctx.builder;
  const s = scale;
  // Cranium: a wide dome, then a second smaller dome behind it so the back of
  // the skull bulges instead of ending in a sphere.
  b.add('skin', b.carapace({ centre: head.clone().add(v(0, -0.02 * s, 0.01 * s)), radius: 0.15 * s, height: 0.2 * s, length: 0.86, segments: 14, color: 0x9c94ad, colorTip: 0x7d7590 }));
  b.add('skin', b.carapace({ centre: head.clone().add(v(0, -0.05 * s, 0.02 * s)), radius: 0.15 * s, height: 0.13 * s, length: 0.86, segments: 14, direction: DOWN, color: 0x8d859e }));
  // Jaw: a short taper down and forward to a chinless point.
  b.add('skin', b.segment({
    from: head.clone().add(v(0, -0.05 * s, 0.0)),
    to: head.clone().add(v(0, -0.16 * s, -0.055 * s)),
    r0: 0.115 * s,
    r1: 0.032 * s,
    flatten: 0.86,
    bulge: 0.92,
    sides: 11,
    color: 0x958da6,
  }));
  // Brow shelf: the tiny bit of structure that stops the face reading as an egg.
  b.add('skin', b.plate({ centre: head.clone().add(v(0, 0.012 * s, -0.108 * s)), normal: v(0, 0.25, -1).normalize(), width: 0.24 * s, height: 0.05 * s, thickness: 0.012 * s, curve: 1.7, taper: 0.85, color: 0xa49cb4, edgeColor: 0x6f6880 }));

  for (const sx of [-1, 1] as const) {
    // Almond eye: a flattened dome swept up and outward toward the temple.
    const e = head.clone().add(v(sx * 0.068 * s, -0.008 * s, -0.088 * s));
    b.add('eye', b.carapace({
      centre: e,
      radius: 0.105 * s,
      height: 0.05 * s,
      length: 0.5,
      segments: 14,
      direction: v(sx * 0.5, 0.2, -0.84).normalize(),
      color: 0x0d0a16,
      colorTip: 0x1a1430,
    }));
    // The violet is *inside* the black, not on it: a faint core the black
    // lacquer sits over, which is what makes the eye read as deep rather than
    // painted.
    b.add('void', b.lens({
      centre: e.clone().add(v(sx * -0.012 * s, 0, -0.036 * s)),
      normal: v(sx * 0.4, 0.08, -0.91).normalize(),
      radius: 0.03 * s,
      bulge: 0.3,
    }));
    // Nostril slits, no mouth. Two tiny recesses is all the face needs.
    b.add('deep', b.lens({ centre: head.clone().add(v(sx * 0.014 * s, -0.086 * s, -0.077 * s)), normal: v(sx * 0.2, -0.2, -1).normalize(), radius: 0.008 * s, bulge: 0.1 }));
  }
  if (crest) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 4 - 0.5) * 1.5;
      b.add('skin', b.spine({
        base: head.clone().add(v(Math.sin(a) * 0.1 * s, 0.14 * s, Math.cos(a) * 0.06 * s + 0.03 * s)),
        direction: v(Math.sin(a) * 0.3, 0.86, 0.42).normalize(),
        length: (0.2 - Math.abs(a) * 0.05) * s,
        radius: 0.016 * s,
        sharpness: 1.6,
        color: 0x9c94ad,
        colorTip: 0x5f5872,
      }));
    }
  }
}

/** A seamless alloy ring — the Greys' entire hardware vocabulary in one shape. */
function alloyRing(
  ctx: BodyBuildContext,
  centre: THREE.Vector3,
  axis: THREE.Vector3,
  radius: number,
  thickness: number,
  lit: boolean,
): void {
  const b = ctx.builder;
  const n = axis.clone().normalize();
  const u = Math.abs(n.y) > 0.9 ? v(0, 0, -1) : v(0, 1, 0);
  const r = new THREE.Vector3().crossVectors(u, n).normalize();
  const f = new THREE.Vector3().crossVectors(n, r).normalize();
  const steps = Math.max(8, Math.round(14 * ctx.detail));
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI * 2;
    const a1 = ((i + 1) / steps) * Math.PI * 2;
    const p0 = centre.clone().addScaledVector(r, Math.cos(a0) * radius).addScaledVector(f, Math.sin(a0) * radius);
    const p1 = centre.clone().addScaledVector(r, Math.cos(a1) * radius).addScaledVector(f, Math.sin(a1) * radius);
    b.add('alloy', b.segment({ from: p0, to: p1, r0: thickness, r1: thickness, sides: 6, capStart: false, capEnd: false, color: 0xe8ebf0 }));
    if (lit) {
      const q0 = p0.clone().addScaledVector(n, thickness * 0.72);
      const q1 = p1.clone().addScaledVector(n, thickness * 0.72);
      b.add('void', b.segment({ from: q0, to: q1, r0: thickness * 0.3, r1: thickness * 0.3, sides: 4, capStart: false, capEnd: false }));
    }
  }
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * Drone — the minor. A hovering orb: a smooth alloy shell split by an
 * equatorial ring, one violet lens, three stabiliser fins. It closes and
 * detonates, so it has to read as a *device* at a glance, never as a creature.
 */
function buildDrone(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  greyMaterials(ctx);

  rig.chain('spine', ['core', 'lens'], [0.16, 0.08], {
    origin: v(0, 0.1, 0.06),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    capture: [0.4, 0.3],
  });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    rig.chain(`fin.${i}`, ['f0', 'f1'], [0.16, 0.09], {
      parent: 'spine.core',
      origin: v(Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0.1),
      direction: v(Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0.62).normalize(),
      pole: UP,
      kind: 'tail',
      capture: [0.14, 0.12],
    });
  }

  const core = at(ctx, 'spine.core');
  const lens = at(ctx, 'spine.lens');

  b.add('alloy', b.carapace({ centre: core.clone(), radius: 0.24, height: 0.2, length: 0.9, segments: 16, color: 0xeef1f6, colorTip: 0xc7ccd8 }));
  b.add('alloy', b.carapace({ centre: core.clone(), radius: 0.24, height: 0.2, length: 0.9, segments: 16, direction: DOWN, color: 0xdfe3eb, colorTip: 0xb6bcc9 }));
  b.add('deep', b.segment({ from: core.clone().add(v(0, 0.005, 0)), to: core.clone().add(v(0, -0.005, 0)), r0: 0.248, r1: 0.248, flatten: 1, sides: 18, color: 0x2b2833 }));
  alloyRing(ctx, core.clone(), UP, 0.245, 0.018, true);

  // The eye. One big violet lens with a dark iris ring around it.
  b.add('deep', b.segment({ from: core.clone().add(v(0, 0, -0.16)), to: lens.clone().add(v(0, 0, -0.02)), r0: 0.15, r1: 0.11, flatten: 1, sides: 14, color: 0x1d1a25 }));
  b.add('void', b.lens({ centre: lens.clone().add(v(0, 0, -0.03)), normal: FORWARD, radius: 0.085, bulge: 0.7, coreColor: 0xffffff }));
  b.add('alloy', b.plate({ centre: lens.clone().add(v(0, 0.055, 0.01)), normal: v(0, 0.7, -0.7).normalize(), width: 0.2, height: 0.09, thickness: 0.014, curve: 1.6, taper: 0.7, color: 0xe8ebf0, edgeColor: 0x9aa1ae }));

  for (let i = 0; i < 3; i++) {
    const f0 = at(ctx, `fin.${i}.f0`);
    const f1 = at(ctx, `fin.${i}.f1`);
    const t = tip(ctx, `fin.${i}`);
    b.add('alloy', b.segment({ from: f0, to: f1, r0: 0.05, r1: 0.035, flatten: 0.22, sides: 6, color: 0xe4e7ee }));
    b.add('deep', b.segment({ from: f1, to: t, r0: 0.032, r1: 0.014, flatten: 0.22, sides: 6, color: 0x2b2833 }));
    b.add('void', b.lens({ centre: f1.clone().add(v(0, 0, 0.01)), normal: v(0, 0, 1), radius: 0.016, bulge: 0.7 }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 0.6,
    headBone: 'spine.lens',
    muzzleBone: 'spine.lens',
    accentColor: GREY.accent,
    shieldRadius: 0.45,
    tuning: { standHeight: 0.1, bob: 0, sway: 0.01, breathRate: 0.9, breathAmount: 0.015, leanTurn: 0.5, lookYawLimit: 2.4 },
    hitProxies: [
      { region: 'body', bone: 'spine.core', radius: 0.26, multiplier: 1 },
      { region: 'critSpot', bone: 'spine.lens', radius: 0.11, multiplier: 3 },
    ],
  };
}

/**
 * Observer — the standard levitator. It never uses its legs: they hang, and
 * that hanging is the whole silhouette. Three chunks of debris orbit it, ready
 * to be thrown.
 */
function buildObserver(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  greyMaterials(ctx);

  rig.chain('spine', ['pelvis', 'core', 'chest', 'neck', 'head'], [0.26, 0.28, 0.12, 0.14, 0.2], {
    origin: v(0, 0.35, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.06, 0.05, 0.02, 0],
    capture: [0.26, 0.26, 0.26, 0.16, 0.24],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.3, 0.3, 0.13], {
      parent: 'spine.chest',
      origin: v(side * 0.13, 0.03, 0),
      direction: v(side * 0.22, -1, 0).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.08, 0.24, 0.14],
      capture: [0.14, 0.12, 0.1],
    });
    // Legs as tails: they dangle and swing with the body instead of walking.
    rig.chain(`leg.${s}`, ['thigh', 'shin', 'foot'], [0.34, 0.32, 0.12], {
      parent: 'spine.pelvis',
      origin: v(side * 0.09, -0.08, 0),
      direction: v(side * 0.08, -1, 0.06).normalize(),
      pole: FORWARD,
      kind: 'tail',
      side,
      capture: [0.16, 0.14, 0.11],
    });
    rig.chain(`orbit.${s}`, ['o0', 'o1'], [0.52, 0.1], {
      parent: 'spine.chest',
      origin: v(side * 0.1, -0.02, 0.02),
      direction: v(side * 0.92, 0.34, 0.2).normalize(),
      pole: UP,
      kind: 'tail',
      capture: [0.04, 0.2],
    });
  }
  rig.chain('orbit.C', ['o0', 'o1'], [0.5, 0.1], {
    parent: 'spine.chest',
    origin: v(0, 0.02, 0.08),
    direction: v(0, 0.36, 0.93).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.04, 0.2],
  });

  const pelvis = at(ctx, 'spine.pelvis');
  const core = at(ctx, 'spine.core');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');

  b.add('skin', b.segment({ from: pelvis.clone().add(v(0, -0.06, 0)), to: core, r0: 0.1, r1: 0.11, flatten: 0.82, sides: 11 }));
  b.add('skin', b.taperedLimb({ from: core, to: chest, r0: 0.11, r1: 0.135, flatten: 0.7, muscle: 1.04, jointR: 0.115, sides: 12 }));
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.03), to: head, r0: 0.042, r1: 0.05, sides: 8 }));
  // The one piece of hardware: a collar plate with a violet core, so the unit
  // is not a naked body floating in the air.
  b.add('alloy', b.plate({ centre: chest.clone().add(v(0, 0.0, -0.12)), normal: FORWARD, width: 0.24, height: 0.22, thickness: 0.018, curve: 1.5, taper: 0.7, color: 0xe8ebf0, edgeColor: 0x9aa1ae }));
  b.add('void', b.lens({ centre: chest.clone().add(v(0, 0.0, -0.135)), normal: FORWARD, radius: 0.036, bulge: 0.6 }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 4 - 0.5) * 2.4;
    b.add('alloy', b.plate({
      centre: neck.clone().add(v(Math.sin(a) * 0.11, -0.02, Math.cos(a) * 0.1)),
      normal: v(Math.sin(a), 0.28, Math.cos(a)).normalize(),
      width: 0.09,
      height: 0.15,
      thickness: 0.012,
      curve: 0.5,
      taper: 0.5,
      color: 0xdfe3eb,
      edgeColor: 0x8f96a3,
    }));
  }
  greyHead(ctx, head, 1.0, false);

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    const shoulder = at(ctx, `arm.${s}.shoulder`);
    const elbow = at(ctx, `arm.${s}.elbow`);
    const wrist = at(ctx, `arm.${s}.wrist`);
    const hand = tip(ctx, `arm.${s}`);
    b.add('skin', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.038, r1: 0.03, jointR: 0.042, muscle: 1.06 }));
    b.add('skin', b.taperedLimb({ from: elbow, to: wrist, r0: 0.03, r1: 0.024, jointR: 0.033, muscle: 1.04 }));
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.026, r1: 0.021, flatten: 0.6, sides: 7 }));
    for (let d = 0; d < 3; d++) {
      b.add('skin', b.digit({
        base: hand.clone().add(v(side * (d - 1) * 0.014, 0.002, -0.006)),
        direction: v(side * (d - 1) * 0.32, -0.86, -0.4).normalize(),
        length: 0.085,
        radius: 0.0075,
        joints: 3,
        curl: 0.3,
      }));
    }
    const thigh = at(ctx, `leg.${s}.thigh`);
    const shin = at(ctx, `leg.${s}.shin`);
    const foot = at(ctx, `leg.${s}.foot`);
    const toe = tip(ctx, `leg.${s}`);
    b.add('skin', b.taperedLimb({ from: thigh, to: shin, r0: 0.055, r1: 0.04, jointR: 0.058, muscle: 1.06 }));
    b.add('skin', b.taperedLimb({ from: shin, to: foot, r0: 0.04, r1: 0.027, jointR: 0.043, muscle: 1.04 }));
    b.add('skin', b.segment({ from: foot, to: toe, r0: 0.028, r1: 0.018, flatten: 0.65, sides: 7 }));

    const stone = at(ctx, `orbit.${s}.o1`);
    debrisChunk(ctx, stone);
  }
  debrisChunk(ctx, at(ctx, 'orbit.C.o1'));

  return {
    rig,
    parts: b.finish(),
    height: 2.0,
    headBone: 'spine.head',
    muzzleBone: 'spine.chest',
    accentColor: GREY.accent,
    shieldRadius: 0.9,
    tuning: { standHeight: 0.35, bob: 0, sway: 0.014, breathRate: 0.35, breathAmount: 0.02, leanTurn: 0.3, leanAccel: 0.05 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.19, multiplier: 2.6 },
      { region: 'body', bone: 'spine.chest', radius: 0.17, halfHeight: 0.12, multiplier: 1 },
      { region: 'body', bone: 'spine.core', radius: 0.15, halfHeight: 0.12, multiplier: 1 },
      { region: 'limb', bone: 'leg.L.shin', radius: 0.08, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.R.shin', radius: 0.08, multiplier: 0.5 },
      { region: 'critSpot', bone: 'spine.chest', offset: v(0, 0, -0.13), radius: 0.07, multiplier: 3 },
    ],
  };
}

/** A lifted rock: faceted, dark, obviously *not* alien hardware. */
function debrisChunk(ctx: BodyBuildContext, centre: THREE.Vector3): void {
  const b = ctx.builder;
  b.add('deep', b.carapace({ centre: centre.clone().add(v(0, -0.03, 0)), radius: 0.085, height: 0.1, length: 0.8, segments: 5, faceted: true, color: 0x4b4654, colorTip: 0x2a2731 }));
  b.add('deep', b.carapace({ centre: centre.clone().add(v(0, 0.03, 0)), radius: 0.09, height: 0.11, length: 0.8, segments: 5, faceted: true, direction: DOWN, color: 0x545060, colorTip: 0x2a2731 }));
  b.add('void', b.lens({ centre: centre.clone().add(v(0, 0, -0.085)), normal: FORWARD, radius: 0.024, bulge: 0.4 }));
}

/**
 * Operative — the standard walker. The only Grey that carries a weapon and
 * holds ground. Slight digitigrade set to the legs so its walk reads as
 * *wrong* next to a human's.
 */
function buildOperative(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  greyMaterials(ctx);

  rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'], [0.24, 0.28, 0.11, 0.15, 0.2], {
    origin: v(0, 0.98, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.04, 0.06, 0.02, 0],
    capture: [0.26, 0.26, 0.26, 0.16, 0.24],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`leg.${s}`, ['hip', 'knee', 'ankle', 'toe'], [0.5, 0.47, 0.16, 0.11], {
      parent: 'spine.hips',
      origin: v(side * 0.11, -0.03, 0.01),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side,
      // A deeper knee bend and a raised heel: digitigrade enough to be uncanny,
      // shallow enough that the two-bone IK never inverts.
      restBend: [0.14, -0.3, 1.5],
      capture: [0.2, 0.17, 0.15, 0.12],
    });
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.3, 0.29, 0.13], {
      parent: 'spine.chest',
      origin: v(side * 0.14, 0.04, 0),
      direction: v(side * 0.2, -1, 0).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.1, 0.28, 0.16],
      // Wide enough to own the sidearm: a vertex past the capture radius binds
      // to whatever bone is nearest instead, and for a held weapon that is a
      // thigh.
      capture: [0.14, 0.12, 0.5],
      skinBias: 2,
    });
  }

  const hips = at(ctx, 'spine.hips');
  const lumbar = at(ctx, 'spine.lumbar');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');

  b.add('skin', b.segment({ from: hips.clone().setY(hips.y - 0.07), to: lumbar, r0: 0.1, r1: 0.104, flatten: 0.8, sides: 11 }));
  b.add('skin', b.taperedLimb({ from: lumbar, to: chest, r0: 0.104, r1: 0.135, flatten: 0.68, muscle: 1.05, jointR: 0.11, sides: 12 }));
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.03), to: head, r0: 0.042, r1: 0.05, sides: 8 }));

  // A single-piece alloy harness. No fasteners: one shell over the ribs, one
  // over the hips, and nothing in between.
  b.add('alloy', b.plate({ centre: chest.clone().add(v(0, 0.0, -0.115)), normal: FORWARD, width: 0.27, height: 0.3, thickness: 0.02, curve: 1.55, taper: 0.76, color: 0xe8ebf0, edgeColor: 0x9aa1ae }));
  b.add('alloy', b.plate({ centre: chest.clone().add(v(0, -0.02, 0.115)), normal: v(0, 0, 1), width: 0.24, height: 0.26, thickness: 0.016, curve: 1.4, taper: 0.86, color: 0xd6dae3, edgeColor: 0x878e9b }));
  b.add('void', b.lens({ centre: chest.clone().add(v(0, 0.03, -0.132)), normal: FORWARD, radius: 0.03, bulge: 0.55 }));
  b.add('alloy', b.segment({ from: hips.clone().add(v(0, 0.04, 0)), to: hips.clone().add(v(0, -0.1, 0)), r0: 0.125, r1: 0.13, flatten: 0.8, sides: 12, color: 0xdfe3eb }));
  b.add('void', b.segment({ from: hips.clone().add(v(-0.1, -0.02, -0.08)), to: hips.clone().add(v(0.1, -0.02, -0.08)), r0: 0.008, r1: 0.008, sides: 4, steps: 3 }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 4 - 0.5) * 2.2;
    b.add('alloy', b.plate({
      centre: neck.clone().add(v(Math.sin(a) * 0.1, -0.02, Math.cos(a) * 0.09)),
      normal: v(Math.sin(a), 0.3, Math.cos(a)).normalize(),
      width: 0.085,
      height: 0.14,
      thickness: 0.012,
      curve: 0.5,
      taper: 0.5,
      color: 0xdfe3eb,
      edgeColor: 0x8f96a3,
    }));
  }
  greyHead(ctx, head, 1.0, false);

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    const shoulder = at(ctx, `arm.${s}.shoulder`);
    const elbow = at(ctx, `arm.${s}.elbow`);
    const wrist = at(ctx, `arm.${s}.wrist`);
    const hand = tip(ctx, `arm.${s}`);
    const hip = at(ctx, `leg.${s}.hip`);
    const knee = at(ctx, `leg.${s}.knee`);
    const ankle = at(ctx, `leg.${s}.ankle`);
    const toe = at(ctx, `leg.${s}.toe`);
    const toeTip = tip(ctx, `leg.${s}`);

    b.add('skin', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.04, r1: 0.031, jointR: 0.044, muscle: 1.06 }));
    b.add('skin', b.taperedLimb({ from: elbow, to: wrist, r0: 0.031, r1: 0.025, jointR: 0.034, muscle: 1.04 }));
    b.add('alloy', b.plate({ centre: shoulder.clone().add(v(side * 0.035, 0.03, 0)), normal: v(side, 0.5, 0).normalize(), up: v(0, 0, -1), width: 0.15, height: 0.13, thickness: 0.014, curve: 1.5, taper: 0.66, color: 0xe8ebf0, edgeColor: 0x8f96a3 }));
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.027, r1: 0.022, flatten: 0.6, sides: 7 }));
    for (let d = 0; d < 3; d++) {
      b.add('skin', b.digit({
        base: hand.clone().add(v(side * (d - 1) * 0.014, 0.002, -0.006)),
        direction: v(side * (d - 1) * 0.3, -0.88, -0.36).normalize(),
        length: 0.08,
        radius: 0.008,
        joints: 3,
        curl: 0.35,
      }));
    }

    b.add('skin', b.taperedLimb({ from: hip, to: knee, r0: 0.07, r1: 0.05, jointR: 0.075, muscle: 1.12, flatten: 0.92 }));
    b.add('skin', b.taperedLimb({ from: knee, to: ankle, r0: 0.05, r1: 0.032, jointR: 0.054, muscle: 1.08, flatten: 0.9 }));
    b.add('alloy', b.plate({ centre: knee.clone().add(v(0, 0.01, -0.055)), normal: FORWARD, width: 0.11, height: 0.12, thickness: 0.012, curve: 1.5, taper: 0.7, color: 0xdfe3eb, edgeColor: 0x878e9b }));
    b.add('skin', b.segment({ from: ankle.clone().add(v(0, 0.01, 0.02)), to: toe, r0: 0.04, r1: 0.032, flatten: 0.72, sides: 7 }));
    b.add('skin', b.segment({ from: toe, to: toeTip, r0: 0.032, r1: 0.018, flatten: 0.68, sides: 7 }));
  }

  // Beam sidearm: a small seamless wedge, no barrel, one aperture.
  const rWrist = at(ctx, 'arm.R.wrist');
  const gunBase = rWrist.clone().add(v(0.02, -0.02, -0.03));
  const gunDir = v(0.03, -0.1, -1).normalize();
  b.add('alloy', b.segment({ from: gunBase, to: gunBase.clone().addScaledVector(gunDir, 0.28), r0: 0.038, r1: 0.028, flatten: 0.55, sides: 7, faceted: true, color: 0xe8ebf0 }));
  b.add('deep', b.segment({ from: gunBase.clone().addScaledVector(gunDir, 0.05), to: gunBase.clone().addScaledVector(gunDir, 0.2), r0: 0.024, r1: 0.02, flatten: 0.4, sides: 6, color: 0x272430 }));
  b.add('void', b.lens({ centre: gunBase.clone().addScaledVector(gunDir, 0.285), normal: gunDir, radius: 0.022, bulge: 0.8 }));

  return {
    rig,
    parts: b.finish(),
    height: 1.95,
    headBone: 'spine.head',
    muzzleBone: 'arm.R.wrist',
    accentColor: GREY.accent,
    shieldRadius: 0.9,
    tuning: { runSpeed: 6.4, strideScale: 0.6, kneeSign: 1, bob: 0.04, sway: 0.026, breathRate: 0.4, breathAmount: 0.02 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.19, multiplier: 2.6 },
      { region: 'body', bone: 'spine.chest', radius: 0.17, halfHeight: 0.12, multiplier: 1 },
      { region: 'body', bone: 'spine.hips', radius: 0.15, halfHeight: 0.1, multiplier: 1 },
      { region: 'limb', bone: 'arm.L.elbow', radius: 0.07, multiplier: 0.5 },
      { region: 'limb', bone: 'arm.R.elbow', radius: 0.07, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.L.knee', radius: 0.09, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.R.knee', radius: 0.09, multiplier: 0.5 },
      { region: 'critSpot', bone: 'spine.chest', offset: v(0, 0.02, 0.12), radius: 0.07, multiplier: 3 },
    ],
  };
}

/**
 * Psion — the elite. A Grey inside a seamless alloy exo-shell: a wide shoulder
 * yoke, a segmented skirt, and a halo ring that floats free above the skull.
 * That halo is the barrier projector, and it is the silhouette.
 */
function buildPsion(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  greyMaterials(ctx);

  rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'], [0.3, 0.34, 0.14, 0.18, 0.24], {
    origin: v(0, 1.16, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.04, 0.06, 0.02, 0],
    capture: [0.34, 0.34, 0.34, 0.2, 0.3],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`leg.${s}`, ['hip', 'knee', 'ankle', 'toe'], [0.58, 0.55, 0.19, 0.13], {
      parent: 'spine.hips',
      origin: v(side * 0.14, -0.04, 0.01),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side,
      restBend: [0.13, -0.28, 1.52],
      capture: [0.24, 0.21, 0.18, 0.15],
    });
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.36, 0.34, 0.15], {
      parent: 'spine.chest',
      origin: v(side * 0.24, 0.06, 0),
      direction: v(side * 0.3, -0.94, -0.12).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.16, 0.44, 0.16],
      capture: [0.18, 0.15, 0.13],
    });
  }
  rig.chain('halo', ['h0', 'h1'], [0.16, 0.08], {
    parent: 'spine.head',
    origin: v(0, 0.16, 0.02),
    direction: UP,
    pole: FORWARD,
    kind: 'tail',
    capture: [0.05, 0.42],
  });

  const hips = at(ctx, 'spine.hips');
  const lumbar = at(ctx, 'spine.lumbar');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');

  b.add('skin', b.segment({ from: hips.clone().setY(hips.y - 0.08), to: lumbar, r0: 0.12, r1: 0.125, flatten: 0.8, sides: 11 }));
  b.add('skin', b.taperedLimb({ from: lumbar, to: chest, r0: 0.125, r1: 0.16, flatten: 0.68, muscle: 1.05, jointR: 0.13, sides: 12 }));
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.03), to: head, r0: 0.05, r1: 0.058, sides: 8 }));

  // Shoulder yoke: one continuous alloy arc across both shoulders. The Greys
  // do not build in parts, so nothing here is bolted to anything.
  for (let i = 0; i < 9; i++) {
    const a = (i / 8 - 0.5) * 3.0;
    b.add('alloy', b.plate({
      centre: chest.clone().add(v(Math.sin(a) * 0.3, 0.1 + Math.cos(a) * 0.03, Math.cos(a) * 0.24)),
      normal: v(Math.sin(a), 0.42, Math.cos(a)).normalize(),
      width: 0.18,
      height: 0.3,
      thickness: 0.024,
      curve: 0.55,
      taper: 0.5,
      color: 0xeef1f6,
      edgeColor: 0x99a0ad,
    }));
  }
  b.add('alloy', b.plate({ centre: chest.clone().add(v(0, -0.02, -0.16)), normal: FORWARD, width: 0.26, height: 0.32, thickness: 0.026, curve: 1.4, taper: 0.74, color: 0xe8ebf0, edgeColor: 0x9aa1ae }));
  b.add('void', b.lens({ centre: chest.clone().add(v(0, 0.04, -0.182)), normal: FORWARD, radius: 0.05, bulge: 0.55 }));
  b.add('void', b.segment({ from: chest.clone().add(v(-0.13, -0.14, -0.16)), to: chest.clone().add(v(0.13, -0.14, -0.16)), r0: 0.01, r1: 0.01, sides: 5, steps: 3 }));
  // Skirt: seven long alloy leaves, so the lower body is a bell not two legs.
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.9;
    b.add('alloy', b.plate({
      centre: hips.clone().add(v(Math.sin(a) * 0.19, -0.22, Math.cos(a) * 0.17)),
      normal: v(Math.sin(a), -0.12, Math.cos(a)).normalize(),
      width: 0.15,
      height: 0.5,
      thickness: 0.018,
      curve: 0.5,
      taper: 0.8,
      color: 0xdfe3eb,
      edgeColor: 0x878e9b,
    }));
  }
  greyHead(ctx, head, 1.24, false);
  // A cowl behind the skull, tying the head into the shell.
  b.add('alloy', b.carapace({ centre: head.clone().add(v(0, -0.05, 0.13)), radius: 0.17, height: 0.26, length: 0.55, segments: 12, direction: v(0, 0.6, 0.8).normalize(), color: 0xe8ebf0, colorTip: 0xa6adba }));

  // Halo: a free-floating ring of alloy with a lit inner edge.
  const halo = at(ctx, 'halo.h1');
  alloyRing(ctx, halo, UP, 0.28, 0.024, true);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.add('void', b.lens({
      centre: halo.clone().add(v(Math.cos(a) * 0.28, 0.03, Math.sin(a) * 0.28)),
      normal: UP,
      radius: 0.03,
      bulge: 0.8,
    }));
  }

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    const shoulder = at(ctx, `arm.${s}.shoulder`);
    const elbow = at(ctx, `arm.${s}.elbow`);
    const wrist = at(ctx, `arm.${s}.wrist`);
    const hand = tip(ctx, `arm.${s}`);
    const hip = at(ctx, `leg.${s}.hip`);
    const knee = at(ctx, `leg.${s}.knee`);
    const ankle = at(ctx, `leg.${s}.ankle`);
    const toe = at(ctx, `leg.${s}.toe`);
    const toeTip = tip(ctx, `leg.${s}`);

    b.add('skin', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.048, r1: 0.037, jointR: 0.052, muscle: 1.06 }));
    b.add('skin', b.taperedLimb({ from: elbow, to: wrist, r0: 0.037, r1: 0.029, jointR: 0.04, muscle: 1.04 }));
    b.add('alloy', b.segment({ from: shoulder.clone().lerp(elbow, 0.1), to: shoulder.clone().lerp(elbow, 0.55), r0: 0.062, r1: 0.05, sides: 8, color: 0xdfe3eb }));
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.03, r1: 0.024, flatten: 0.6, sides: 7 }));
    for (let d = 0; d < 3; d++) {
      b.add('skin', b.digit({
        base: hand.clone().add(v(side * (d - 1) * 0.016, 0.002, -0.008)),
        direction: v(side * (d - 1) * 0.34, -0.7, -0.6).normalize(),
        length: 0.1,
        radius: 0.009,
        joints: 3,
        curl: 0.25,
      }));
    }
    b.add('skin', b.taperedLimb({ from: hip, to: knee, r0: 0.082, r1: 0.058, jointR: 0.088, muscle: 1.12, flatten: 0.92 }));
    b.add('skin', b.taperedLimb({ from: knee, to: ankle, r0: 0.058, r1: 0.037, jointR: 0.062, muscle: 1.08, flatten: 0.9 }));
    b.add('alloy', b.plate({ centre: knee.clone().add(v(0, 0.01, -0.065)), normal: FORWARD, width: 0.13, height: 0.14, thickness: 0.014, curve: 1.5, taper: 0.7, color: 0xdfe3eb, edgeColor: 0x878e9b }));
    b.add('skin', b.segment({ from: ankle.clone().add(v(0, 0.01, 0.024)), to: toe, r0: 0.046, r1: 0.037, flatten: 0.72, sides: 7 }));
    b.add('skin', b.segment({ from: toe, to: toeTip, r0: 0.037, r1: 0.021, flatten: 0.68, sides: 7 }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 2.35,
    headBone: 'spine.head',
    muzzleBone: 'spine.chest',
    accentColor: GREY.accent,
    shieldRadius: 1.2,
    tuning: { runSpeed: 5.4, strideScale: 0.54, kneeSign: 1, bob: 0.028, sway: 0.018, breathRate: 0.3, breathAmount: 0.018 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.24, multiplier: 2.2 },
      { region: 'body', bone: 'spine.chest', radius: 0.22, halfHeight: 0.16, multiplier: 1 },
      { region: 'body', bone: 'spine.hips', radius: 0.2, halfHeight: 0.14, multiplier: 1 },
      { region: 'limb', bone: 'leg.L.knee', radius: 0.11, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.R.knee', radius: 0.11, multiplier: 0.5 },
      // The halo is the projector: break it and the dome goes with it.
      { region: 'critSpot', bone: 'halo.h1', radius: 0.16, multiplier: 3.4 },
    ],
  };
}

/**
 * Overseer — the champion abductor. Three metres of vertical needle: the
 * cranium is stretched into a crest, the arms hang past where its knees would
 * be, and the legs have atrophied into two trailing threads. It never lands.
 */
function buildOverseer(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  greyMaterials(ctx);

  rig.chain('spine', ['pelvis', 'core', 'chest', 'neck', 'head'], [0.42, 0.46, 0.2, 0.3, 0.34], {
    origin: v(0, 0.5, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.05, 0.04, 0.03, 0],
    capture: [0.3, 0.3, 0.3, 0.22, 0.34],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.52, 0.5, 0.22], {
      parent: 'spine.chest',
      origin: v(side * 0.16, 0.04, 0),
      direction: v(side * 0.16, -1, -0.04).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.06, 0.16, 0.12],
      capture: [0.18, 0.16, 0.13],
    });
    rig.chain(`leg.${s}`, ['thigh', 'shin', 'foot'], [0.5, 0.46, 0.16], {
      parent: 'spine.pelvis',
      origin: v(side * 0.08, -0.1, 0),
      direction: v(side * 0.06, -1, 0.05).normalize(),
      pole: FORWARD,
      kind: 'tail',
      side,
      capture: [0.16, 0.14, 0.11],
    });
  }
  rig.chain('shroud', ['s0', 's1', 's2'], [0.44, 0.4, 0.22], {
    parent: 'spine.chest',
    origin: v(0, 0.1, 0.16),
    direction: v(0, -0.92, 0.4).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.4, 0.36, 0.3],
  });

  const pelvis = at(ctx, 'spine.pelvis');
  const core = at(ctx, 'spine.core');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');

  b.add('skin', b.segment({ from: pelvis.clone().add(v(0, -0.1, 0)), to: core, r0: 0.13, r1: 0.14, flatten: 0.8, sides: 11 }));
  b.add('skin', b.taperedLimb({ from: core, to: chest, r0: 0.14, r1: 0.175, flatten: 0.66, muscle: 1.04, jointR: 0.145, sides: 12 }));
  // A long, thin neck. It is what makes the head read as too heavy.
  b.add('skin', b.segment({ from: chest.clone().add(v(0, 0.04, 0)), to: neck, r0: 0.09, r1: 0.06, flatten: 0.85, sides: 9 }));
  b.add('skin', b.segment({ from: neck, to: head, r0: 0.06, r1: 0.075, sides: 9 }));

  // The abduction aperture: a violet iris set into the sternum, ringed in alloy.
  b.add('alloy', b.plate({ centre: chest.clone().add(v(0, -0.02, -0.19)), normal: FORWARD, width: 0.4, height: 0.44, thickness: 0.028, curve: 1.35, taper: 0.72, color: 0xeef1f6, edgeColor: 0x99a0ad }));
  alloyRing(ctx, chest.clone().add(v(0, 0.0, -0.21)), FORWARD, 0.13, 0.018, true);
  b.add('void', b.lens({ centre: chest.clone().add(v(0, 0.0, -0.216)), normal: FORWARD, radius: 0.095, bulge: 0.5, coreColor: 0xffffff }));
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.8;
    b.add('alloy', b.plate({
      centre: neck.clone().add(v(Math.sin(a) * 0.17, -0.06, Math.cos(a) * 0.15)),
      normal: v(Math.sin(a), 0.36, Math.cos(a)).normalize(),
      width: 0.12,
      height: 0.28,
      thickness: 0.014,
      curve: 0.5,
      taper: 0.42,
      color: 0xdfe3eb,
      edgeColor: 0x878e9b,
    }));
  }
  greyHead(ctx, head, 1.5, true);

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    const shoulder = at(ctx, `arm.${s}.shoulder`);
    const elbow = at(ctx, `arm.${s}.elbow`);
    const wrist = at(ctx, `arm.${s}.wrist`);
    const hand = tip(ctx, `arm.${s}`);
    b.add('skin', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.05, r1: 0.039, jointR: 0.055, muscle: 1.05 }));
    b.add('skin', b.taperedLimb({ from: elbow, to: wrist, r0: 0.039, r1: 0.029, jointR: 0.042, muscle: 1.03 }));
    b.add('alloy', b.plate({ centre: shoulder.clone().add(v(side * 0.05, 0.05, 0)), normal: v(side, 0.55, 0).normalize(), up: v(0, 0, -1), width: 0.2, height: 0.2, thickness: 0.018, curve: 1.5, taper: 0.6, color: 0xeef1f6, edgeColor: 0x99a0ad }));
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.03, r1: 0.024, flatten: 0.55, sides: 7 }));
    // Four long fingers, barely curled. The hands are the reach.
    for (let d = 0; d < 4; d++) {
      b.add('skin', b.digit({
        base: hand.clone().add(v(side * (d - 1.5) * 0.017, 0.002, -0.008)),
        direction: v(side * (d - 1.5) * 0.22, -0.95, -0.2).normalize(),
        length: 0.17,
        radius: 0.009,
        joints: 4,
        curl: 0.18,
      }));
    }
    const thigh = at(ctx, `leg.${s}.thigh`);
    const shin = at(ctx, `leg.${s}.shin`);
    const foot = at(ctx, `leg.${s}.foot`);
    const toe = tip(ctx, `leg.${s}`);
    b.add('skin', b.taperedLimb({ from: thigh, to: shin, r0: 0.06, r1: 0.038, jointR: 0.063, muscle: 1.04 }));
    b.add('skin', b.taperedLimb({ from: shin, to: foot, r0: 0.038, r1: 0.024, jointR: 0.04, muscle: 1.02 }));
    b.add('skin', b.segment({ from: foot, to: toe, r0: 0.024, r1: 0.012, flatten: 0.6, sides: 6 }));
    b.add('void', b.lens({ centre: shoulder.clone().add(v(side * 0.075, 0.06, -0.02)), normal: v(side, 0.4, -0.3).normalize(), radius: 0.024, bulge: 0.7 }));
  }

  const sh = ['shroud.s0', 'shroud.s1', 'shroud.s2'];
  for (let i = 0; i < sh.length - 1; i++) {
    b.add('alloy', b.segment({ from: at(ctx, sh[i]), to: at(ctx, sh[i + 1]), r0: 0.28 - i * 0.05, r1: 0.24 - i * 0.06, flatten: 0.2, sides: 7, color: 0xd6dae3 }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 3.2,
    headBone: 'spine.head',
    muzzleBone: 'spine.chest',
    accentColor: GREY.accent,
    shieldRadius: 1.4,
    tuning: { standHeight: 0.5, bob: 0, sway: 0.012, breathRate: 0.25, breathAmount: 0.02, leanTurn: 0.24, leanAccel: 0.04 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.3, multiplier: 2.2 },
      { region: 'body', bone: 'spine.chest', radius: 0.24, halfHeight: 0.18, multiplier: 1 },
      { region: 'body', bone: 'spine.core', radius: 0.22, halfHeight: 0.2, multiplier: 1 },
      { region: 'limb', bone: 'arm.L.elbow', radius: 0.1, multiplier: 0.5 },
      { region: 'limb', bone: 'arm.R.elbow', radius: 0.1, multiplier: 0.5 },
      // The aperture. Shooting it is also what breaks a lift early.
      { region: 'critSpot', bone: 'spine.chest', offset: v(0, 0, -0.21), radius: 0.13, multiplier: 3.2 },
    ],
  };
}

/**
 * Overmind — the boss. A five-metre two-lobed brain suspended in an alloy
 * cradle that never touches the ground: a horizontal ring, four curved
 * suspension arms, a nest of tendrils below, and three tether masts whose
 * beams keep it phased out of reality until they are cut.
 */
function buildOvermind(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  greyMaterials(ctx);

  rig.chain('spine', ['cradle', 'stem', 'brain', 'crown'], [0.6, 0.7, 0.5, 0.4], {
    origin: v(0, -0.5, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, 0, 0, 0],
    // 2.4 on the cradle: the suspension ring is 1.5 m out and the four arms
    // sweep past the tendril roots, so a smaller radius orphans them onto the
    // tendrils and the whole apparatus flails.
    capture: [2.4, 1.0, 1.6, 0.9],
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    rig.chain(`tendril.${i}`, ['t0', 't1', 't2', 't3'], [0.5, 0.46, 0.4, 0.26], {
      parent: 'spine.cradle',
      origin: v(Math.cos(a) * 0.5, -0.16, Math.sin(a) * 0.5),
      direction: v(Math.cos(a) * 0.34, -0.94, Math.sin(a) * 0.34).normalize(),
      pole: UP,
      kind: 'tail',
      capture: [0.26, 0.24, 0.2, 0.16],
      skinBias: 0.5,
    });
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    rig.chain(`mast.${i}`, ['m0', 'm1'], [1.15, 0.22], {
      parent: 'spine.stem',
      origin: v(Math.cos(a) * 0.34, 0.1, Math.sin(a) * 0.34),
      direction: v(Math.cos(a) * 0.78, 0.62, Math.sin(a) * 0.78).normalize(),
      pole: UP,
      kind: 'tail',
      capture: [0.16, 0.34],
    });
  }

  const cradle = at(ctx, 'spine.cradle');
  const stem = at(ctx, 'spine.stem');
  const brain = at(ctx, 'spine.brain');
  const crown = at(ctx, 'spine.crown');

  // The cradle: a wide ring with four curved arms reaching up to the brain.
  alloyRing(ctx, cradle.clone(), UP, 1.5, 0.07, true);
  alloyRing(ctx, cradle.clone().add(v(0, 0.5, 0)), UP, 1.1, 0.05, false);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const base = cradle.clone().add(v(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5));
    const top = brain.clone().add(v(Math.cos(a) * 0.72, -0.34, Math.sin(a) * 0.72));
    b.add('alloy', b.segment({
      from: base,
      to: top,
      r0: 0.115,
      r1: 0.07,
      bend: 0.55,
      bendAxis: v(-Math.cos(a), 0, -Math.sin(a)),
      sides: 9,
      steps: 9,
      color: 0xe8ebf0,
      colorTip: 0xb9bfcb,
    }));
    b.add('void', b.lens({ centre: top.clone().add(v(0, 0.06, 0)), normal: v(Math.cos(a) * 0.4, 1, Math.sin(a) * 0.4).normalize(), radius: 0.075, bulge: 0.7 }));
  }
  b.add('alloy', b.segment({ from: cradle.clone().add(v(0, -0.05, 0)), to: stem, r0: 0.42, r1: 0.34, flatten: 1, sides: 12, color: 0xdfe3eb }));
  b.add('deep', b.segment({ from: stem, to: brain.clone().add(v(0, -0.3, 0)), r0: 0.3, r1: 0.42, flatten: 1, sides: 12, color: 0x272430 }));

  // The brain: two lobes, heavily ridged, wet-looking rather than alloy.
  for (const sx of [-1, 1]) {
    b.add('skin', b.carapace({
      centre: brain.clone().add(v(sx * 0.36, -0.1, 0)),
      radius: 0.78,
      height: 0.98,
      length: 0.72,
      segments: 16,
      ridges: 11,
      ridgeDepth: 0.13,
      color: 0xf0dcf6,
      colorTip: 0xc0a8cc,
    }));
    b.add('skin', b.carapace({
      centre: brain.clone().add(v(sx * 0.36, -0.12, 0)),
      radius: 0.74,
      height: 0.62,
      length: 0.72,
      segments: 16,
      ridges: 11,
      ridgeDepth: 0.12,
      direction: DOWN,
      color: 0xe2cfea,
      colorTip: 0xb096be,
    }));
  }
  // Longitudinal fissure and a brainstem sheath.
  b.add('deep', b.segment({ from: brain.clone().add(v(0, 0.72, -0.6)), to: brain.clone().add(v(0, 0.72, 0.6)), r0: 0.1, r1: 0.1, flatten: 0.5, sides: 8, color: 0x241f2c }));
  b.add('void', b.segment({ from: brain.clone().add(v(0, 0.76, -0.55)), to: brain.clone().add(v(0, 0.76, 0.55)), r0: 0.035, r1: 0.035, sides: 6, steps: 5 }));
  // Suspension fluid shell: a faint alloy cage over the lobes, not a bubble.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.add('alloy', b.segment({
      from: brain.clone().add(v(Math.cos(a) * 1.0, -0.42, Math.sin(a) * 0.78)),
      to: crown.clone().add(v(Math.cos(a) * 0.16, -0.1, Math.sin(a) * 0.12)),
      r0: 0.05,
      r1: 0.03,
      bend: 0.3,
      bendAxis: v(-Math.cos(a), 0, -Math.sin(a)),
      sides: 6,
      steps: 7,
      color: 0xe8ebf0,
    }));
  }
  b.add('alloy', b.carapace({ centre: crown.clone().add(v(0, -0.06, 0)), radius: 0.34, height: 0.3, length: 0.9, segments: 12, color: 0xeef1f6, colorTip: 0xb9bfcb }));
  b.add('void', b.lens({ centre: crown.clone().add(v(0, 0.24, 0)), normal: UP, radius: 0.14, bulge: 0.8 }));

  // Tether masts: the three things that must die before the boss can be hurt.
  for (let i = 0; i < 3; i++) {
    const m0 = at(ctx, `mast.${i}.m0`);
    const m1 = at(ctx, `mast.${i}.m1`);
    const t = tip(ctx, `mast.${i}`);
    b.add('alloy', b.segment({ from: m0, to: m1, r0: 0.1, r1: 0.07, sides: 8, color: 0xe8ebf0 }));
    b.add('deep', b.segment({ from: m1, to: t, r0: 0.14, r1: 0.1, flatten: 1, sides: 10, color: 0x272430 }));
    alloyRing(ctx, t.clone(), m1.clone().sub(m0).normalize(), 0.24, 0.03, true);
    b.add('void', b.lens({ centre: t.clone(), normal: m1.clone().sub(m0).normalize(), radius: 0.13, bulge: 0.9, coreColor: 0xffffff }));
  }

  for (let i = 0; i < 6; i++) {
    const ids = [`tendril.${i}.t0`, `tendril.${i}.t1`, `tendril.${i}.t2`, `tendril.${i}.t3`];
    for (let k = 0; k < ids.length - 1; k++) {
      b.add('skin', b.segment({
        from: at(ctx, ids[k]),
        to: at(ctx, ids[k + 1]),
        r0: 0.14 - k * 0.03,
        r1: 0.11 - k * 0.03,
        sides: 8,
        color: 0xa694b2,
      }));
    }
    b.add('void', b.lens({ centre: tip(ctx, `tendril.${i}`), normal: DOWN, radius: 0.05, bulge: 0.8 }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 5.0,
    headBone: 'spine.brain',
    muzzleBone: 'spine.crown',
    accentColor: GREY.accent,
    shieldRadius: 2.9,
    tuning: { standHeight: -0.5, bob: 0, sway: 0.008, breathRate: 0.22, breathAmount: 0.03, leanTurn: 0.14, lookYawLimit: 1.2 },
    hitProxies: [
      { region: 'body', bone: 'spine.brain', radius: 1.0, halfHeight: 0.4, multiplier: 1 },
      { region: 'body', bone: 'spine.stem', radius: 0.5, halfHeight: 0.4, multiplier: 1 },
      { region: 'body', bone: 'spine.cradle', radius: 0.6, multiplier: 0.8 },
      // The three tether emitters: the fight's actual objective.
      { region: 'critSpot', bone: 'mast.0.m1', radius: 0.34, multiplier: 3 },
      { region: 'critSpot', bone: 'mast.1.m1', radius: 0.34, multiplier: 3 },
      { region: 'critSpot', bone: 'mast.2.m1', radius: 0.34, multiplier: 3 },
      { region: 'critSpot', bone: 'spine.crown', radius: 0.36, multiplier: 3.5 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Runtime effects
// ---------------------------------------------------------------------------

interface ProxyHostLike {
  addProxy(p: HitProxy): HitProxy;
  removeProxiesFor(entityId: number): void;
}

function proxyHost(world: CollisionWorld | null): ProxyHostLike | null {
  const h = world as unknown as Partial<ProxyHostLike> | null;
  return h && typeof h.addProxy === 'function' && typeof h.removeProxiesFor === 'function'
    ? (h as ProxyHostLike)
    : null;
}

/**
 * The player, seen structurally. `BehaviourContext.target` is only typed as
 * `Damageable`, but the abduction lift needs to move the player and read their
 * aim to offer a break-out, and the enemy layer must not import `Player`.
 */
interface PlayerLike extends Damageable {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  eyePosition: THREE.Vector3;
  aimDirection: THREE.Vector3;
  addImpulse(v: THREE.Vector3): void;
}

function asPlayer(t: Damageable | null): PlayerLike | null {
  const p = t as Partial<PlayerLike> | null;
  return p && p.position && p.velocity && p.aimDirection && typeof p.addImpulse === 'function'
    ? (p as PlayerLike)
    : null;
}

let nextPropId = 640000;

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();

/**
 * The Psion's barrier dome. A real blocker: one sphere proxy registered with
 * the collision world stops every round that crosses it, so the allies inside
 * are genuinely protected. Walking *inside* the dome disables the proxy, which
 * is the second, riskier answer to it — the design does not force one solution.
 */
class BarrierDome implements Damageable {
  readonly entityId = nextPropId++;
  health = 700;
  maxHealth = 700;
  shield = 0;
  maxShield = 0;
  readonly group = new THREE.Group();
  readonly radius: number;
  active = false;
  cooldown = 0;

  private proxy: HitProxy;
  private host: ProxyHostLike | null = null;
  private vfx: VfxSystem;
  private shell: THREE.Mesh;
  private lattice: THREE.LineSegments;
  private shellMat: THREE.MeshBasicMaterial;
  private latticeMat: THREE.LineBasicMaterial;
  private flash = 0;

  constructor(vfx: VfxSystem, radius: number) {
    this.vfx = vfx;
    this.radius = radius;
    this.shellMat = vfx.materials.additive(GREY.glow, 0.12);
    this.shellMat.side = THREE.DoubleSide;
    this.shellMat.depthWrite = false;
    const shellGeo = new THREE.SphereGeometry(radius, 26, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
    this.shell = new THREE.Mesh(shellGeo, this.shellMat);
    this.shell.renderOrder = 5;
    this.shell.frustumCulled = false;
    this.group.add(this.shell);

    // A wireframe over the shell: a dome with a visible construction reads as
    // a projected field. A plain translucent sphere reads as fog.
    this.latticeMat = new THREE.LineBasicMaterial({
      color: GREY.glow,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      toneMapped: false,
    });
    const wire = new THREE.WireframeGeometry(new THREE.SphereGeometry(radius * 1.002, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55));
    this.lattice = new THREE.LineSegments(wire, this.latticeMat);
    this.lattice.renderOrder = 6;
    this.lattice.frustumCulled = false;
    this.group.add(this.lattice);
    this.group.visible = false;

    this.proxy = {
      damageable: this,
      region: 'body',
      offset: new THREE.Vector3(0, 0, 0),
      radius,
      halfHeight: 0,
      multiplier: 0.22,
      enabled: false,
      world: new THREE.Vector3(),
    };
  }

  get isDead(): boolean {
    return !this.active;
  }

  getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.group.position);
  }

  applyDamage(info: DamageInfo): number {
    if (!this.active) return 0;
    const mult = info.element === 'void' ? 2.4 : info.element === 'kinetic' ? 0.7 : 1;
    const dealt = Math.min(this.health, info.amount * mult);
    this.health -= dealt;
    this.flash = 1;
    this.vfx.impact(info.point, info.normal, 'glass', 0.55);
    if (this.health <= 0) this.collapse(info.point);
    return dealt;
  }

  deploy(scene: THREE.Scene | null, host: ProxyHostLike | null, centre: THREE.Vector3): void {
    if (this.active) return;
    this.active = true;
    this.health = this.maxHealth;
    this.group.position.copy(centre);
    this.group.visible = true;
    this.group.scale.setScalar(0.05);
    if (scene && this.group.parent !== scene) scene.add(this.group);
    this.host = host;
    if (host) {
      this.proxy.enabled = true;
      host.addProxy(this.proxy);
    }
  }

  collapse(point: THREE.Vector3): void {
    if (!this.active) return;
    this.active = false;
    this.cooldown = 14;
    this.group.visible = false;
    this.proxy.enabled = false;
    this.host?.removeProxiesFor(this.entityId);
    this.vfx.shieldBreak(point, 'void', this.radius);
    this.vfx.elementalBurst(this.group.position, 'void', 2.4);
  }

  update(dt: number, centre: THREE.Vector3, playerPos: THREE.Vector3 | null): void {
    if (!this.active) {
      if (this.cooldown > 0) this.cooldown -= dt;
      return;
    }
    this.group.position.lerp(centre, 1 - Math.exp(-4 * dt));
    this.group.scale.setScalar(damp(this.group.scale.x, 1, 6, dt));
    this.group.updateMatrixWorld(true);
    this.proxy.world.copy(this.group.position);
    // Inside the dome the field is behind you, so it must not eat your shots.
    const inside = playerPos != null && playerPos.distanceTo(this.group.position) < this.radius * 0.96;
    this.proxy.enabled = !inside;
    this.flash = damp(this.flash, 0, 6, dt);
    const h = clamp01(this.health / this.maxHealth);
    this.shellMat.opacity = (0.06 + h * 0.09 + this.flash * 0.3) * (inside ? 0.5 : 1);
    this.latticeMat.opacity = (0.16 + h * 0.3 + this.flash * 0.4) * (inside ? 0.4 : 1);
  }

  dispose(): void {
    this.proxy.enabled = false;
    this.host?.removeProxiesFor(this.entityId);
    this.group.removeFromParent();
    this.shell.geometry.dispose();
    this.lattice.geometry.dispose();
    this.shellMat.dispose();
    this.latticeMat.dispose();
  }
}

interface Debris {
  alive: boolean;
  phase: 'lift' | 'fly';
  life: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  mesh: THREE.Mesh;
  damage: number;
  aim: THREE.Vector3;
}

interface Lance {
  life: number;
  lead: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  damage: number;
  fired: boolean;
}

/**
 * Shared Grey world objects: telekinetic debris, psionic lances, barrier
 * domes and the mind-blast screen wash. Built lazily, stepped from whichever
 * agent ticks first, pooled so nothing allocates per frame.
 */
class GreyRuntime {
  readonly domes: BarrierDome[] = [];
  private vfx: VfxSystem;
  private scene: THREE.Scene | null = null;
  private debris: Debris[] = [];
  private lances: Lance[] = [];
  private lastTime = -1;
  private rockGeo: THREE.BufferGeometry;
  private rockMat: THREE.Material;
  private washMesh: THREE.Mesh | null = null;
  private washMat: THREE.MeshBasicMaterial | null = null;
  private wash = 0;
  private rng = new Rng(0x9a5e1);

  constructor(vfx: VfxSystem) {
    this.vfx = vfx;
    this.rockGeo = new THREE.IcosahedronGeometry(0.34, 0);
    this.rockMat = vfx.materials.surface('rock', { color: 0x4b4654, roughness: 0.9 });
  }

  bind(scene: THREE.Scene | null): void {
    if (scene && this.scene !== scene) this.scene = scene;
  }

  step(elapsed: number, target: Damageable | null, targetPos: THREE.Vector3): void {
    if (this.lastTime < 0) this.lastTime = elapsed;
    const dt = clamp(elapsed - this.lastTime, 0, 0.1);
    this.lastTime = elapsed;
    if (dt <= 0) return;

    for (const d of this.debris) {
      if (!d.alive) continue;
      d.life -= dt;
      if (d.phase === 'lift') {
        // Telegraph: the chunk tears out of the ground and hangs, wobbling.
        d.pos.y += dt * 3.4;
        d.vel.multiplyScalar(0.9);
        if (d.life <= 0) {
          d.phase = 'fly';
          d.life = 3;
          d.vel.copy(d.aim).sub(d.pos).normalize().multiplyScalar(26);
        }
      } else {
        d.pos.addScaledVector(d.vel, dt);
        d.vel.y -= 6 * dt;
        if (target && !target.isDead && d.pos.distanceToSquared(targetPos) < 1.4) {
          this.hit(target, targetPos, d.damage, d.pos, 'void');
          d.life = 0;
        }
        if (d.pos.y < 0.1 || d.life <= 0) {
          this.vfx.impact(d.pos, _p0.set(0, 1, 0), 'rock', 1.1);
          d.life = 0;
        }
      }
      d.mesh.position.copy(d.pos);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.life <= 0) {
        d.alive = false;
        d.mesh.removeFromParent();
      }
    }

    for (let i = this.lances.length - 1; i >= 0; i--) {
      const l = this.lances[i];
      l.life -= dt;
      if (!l.fired) {
        // A thin bright thread while it charges, then the real lance.
        const t = clamp01(1 - l.life / l.lead);
        this.vfx.beam(l.from, l.to, GREY.glow, 0.012 + t * 0.02);
        if (l.life <= 0) {
          l.fired = true;
          l.life = 0.3;
          this.vfx.beam(l.from, l.to, 0xe8d8ff, 0.16);
          this.vfx.explosion(l.to, 3.2, 'void');
          if (target && !target.isDead && targetPos.distanceTo(l.to) < 3.4) {
            this.hit(target, targetPos, l.damage, l.to, 'void');
          }
        }
      } else if (l.life <= 0) {
        this.lances.splice(i, 1);
      }
    }

    this.stepWash(dt, targetPos);
  }

  /** Rip a chunk out of the ground near `from` and hang it, ready to throw. */
  lift(from: THREE.Vector3, groundY: number, aim: THREE.Vector3, damage: number): void {
    if (!this.scene) return;
    let d = this.debris.find((x) => !x.alive);
    if (!d) {
      if (this.debris.length >= 12) return;
      const mesh = new THREE.Mesh(this.rockGeo, this.rockMat);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      d = {
        alive: false,
        phase: 'lift',
        life: 0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        mesh,
        damage: 0,
        aim: new THREE.Vector3(),
      };
      this.debris.push(d);
    }
    d.alive = true;
    d.phase = 'lift';
    // 0.55 s of visible lift before it can hurt anyone — the telegraph.
    d.life = 0.55;
    d.damage = damage;
    d.pos.set(from.x + this.rng.range(-2.4, 2.4), groundY + 0.2, from.z + this.rng.range(-2.4, 2.4));
    d.vel.set(0, 2, 0);
    d.spin.set(this.rng.range(-3, 3), this.rng.range(-3, 3), this.rng.range(-3, 3));
    d.aim.copy(aim);
    d.mesh.position.copy(d.pos);
    d.mesh.scale.setScalar(this.rng.range(0.7, 1.25));
    d.mesh.visible = true;
    this.scene.add(d.mesh);
    this.vfx.elementalBurst(d.pos, 'void', 0.7);
  }

  /** A converging psionic lance: charges visibly along its own line, then fires. */
  lance(from: THREE.Vector3, to: THREE.Vector3, lead: number, damage: number): void {
    if (this.lances.length > 8) this.lances.shift();
    this.lances.push({ life: lead, lead, from: from.clone(), to: to.clone(), damage, fired: false });
  }

  /** The mind blast wash — a violet shell around the camera, fading out. */
  blast(at: THREE.Vector3, strength: number): void {
    this.wash = clamp01(this.wash + strength);
    this.vfx.explosion(at, 4, 'void');
    events.emit('camera:shake', { amount: 0.9 * strength, duration: 0.9, frequency: 22 });
  }

  private stepWash(dt: number, eye: THREE.Vector3): void {
    if (this.wash <= 0.001) {
      if (this.washMesh) this.washMesh.visible = false;
      return;
    }
    if (!this.washMesh && this.scene) {
      this.washMat = new THREE.MeshBasicMaterial({
        color: GREY.glow,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        side: THREE.BackSide,
        fog: false,
        toneMapped: false,
      });
      this.washMesh = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), this.washMat);
      this.washMesh.frustumCulled = false;
      this.washMesh.renderOrder = 999;
      this.scene.add(this.washMesh);
    }
    this.wash = damp(this.wash, 0, 2.2, dt);
    if (this.washMesh && this.washMat) {
      this.washMesh.visible = true;
      this.washMesh.position.copy(eye);
      this.washMat.opacity = this.wash * 0.55;
    }
  }

  private hit(target: Damageable, at: THREE.Vector3, amount: number, from: THREE.Vector3, element: 'void'): void {
    _p1.subVectors(at, from);
    if (_p1.lengthSq() < 1e-6) _p1.set(0, 1, 0);
    _p1.normalize();
    GREY_DAMAGE.amount = amount;
    GREY_DAMAGE.element = element;
    GREY_DAMAGE.point.copy(at);
    GREY_DAMAGE.normal.copy(_p1).negate();
    GREY_DAMAGE.direction.copy(_p1);
    GREY_DAMAGE.splash = true;
    GREY_DAMAGE.sourceId = -1;
    target.applyDamage(GREY_DAMAGE);
    this.vfx.elementalBurst(at, 'void', 0.8);
  }

  dome(): BarrierDome {
    for (const d of this.domes) if (!d.active && d.cooldown <= 0) return d;
    const d = new BarrierDome(this.vfx, 6.5);
    this.domes.push(d);
    return d;
  }

  dispose(): void {
    for (const d of this.domes) d.dispose();
    this.domes.length = 0;
    for (const d of this.debris) d.mesh.removeFromParent();
    this.debris.length = 0;
    this.lances.length = 0;
    this.rockGeo.dispose();
    this.rockMat.dispose();
    if (this.washMesh) {
      this.washMesh.removeFromParent();
      this.washMesh.geometry.dispose();
    }
    this.washMat?.dispose();
    this.washMesh = null;
    this.washMat = null;
    this.lastTime = -1;
  }
}

const GREY_DAMAGE: DamageInfo = {
  amount: 0,
  element: 'void',
  region: 'body',
  precision: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  direction: new THREE.Vector3(0, 0, -1),
  sourceId: -1,
  splash: true,
  impulse: 3,
};

let runtime: GreyRuntime | null = null;
let lastVfx: VfxSystem | null = null;

/**
 * Live Grey agents. The framework does not hand a behaviour tree the roster,
 * and the Psion's dome has to centre on the group it is protecting.
 */
const GREY_ROSTER = new Set<EnemyAgent>();
let prunedAt = -1;

function track(agent: EnemyAgent, ctx: BehaviourContext): void {
  lastVfx = ctx.vfx;
  GREY_ROSTER.add(agent);
  if (ctx.elapsed - prunedAt < 2) return;
  prunedAt = ctx.elapsed;
  for (const a of GREY_ROSTER) if (a.state !== 'alive') GREY_ROSTER.delete(a);
}

function rt(ctx: BehaviourContext): GreyRuntime {
  lastVfx = ctx.vfx;
  if (!runtime) runtime = new GreyRuntime(ctx.vfx);
  runtime.bind(ctx.vfx.scene);
  runtime.step(ctx.elapsed, ctx.target, ctx.targetPosition);
  return runtime;
}

/** Release every world object this module created. Levels call this on unload. */
export function disposeGreyRuntime(): void {
  runtime?.dispose();
  runtime = null;
  GREY_ROSTER.clear();
  lastVfx = null;
  prunedAt = -1;
}

export type GreySummoner = (
  archetypeId: string,
  position: THREE.Vector3,
  yaw: number,
) => unknown;

let summoner: GreySummoner | null = null;

/**
 * Hand this `(id, pos, yaw) => enemies.spawn(id, pos, yaw)`. The Overmind's
 * tether nodes and drone swarm both come from it; without it the boss simply
 * starts vulnerable instead of breaking.
 */
export function setGreySummoner(fn: GreySummoner | null): void {
  summoner = fn;
}

// ---------------------------------------------------------------------------
// Behaviour helpers
// ---------------------------------------------------------------------------

function toTarget(agent: EnemyAgent, ctx: BehaviourContext, out: THREE.Vector3): number {
  out.subVectors(ctx.targetPosition, agent.position);
  out.y = 0;
  const d = out.length() || 1e-3;
  out.multiplyScalar(1 / d);
  return d;
}

function brace(agent: EnemyAgent, ctx: BehaviourContext, hold: number): void {
  agent.ai.lookAt.copy(ctx.targetPosition);
  agent.ai.lookValid = true;
  agent.ai.desiredVelocity.multiplyScalar(hold);
}

/**
 * Hover control: Greys hold an altitude band relative to the player rather
 * than to the ground, so they drift up as you climb and never sink into a slope.
 */
function hover(agent: EnemyAgent, ctx: BehaviourContext, above: number): void {
  agent.ai.desiredVelocity.y = clamp((ctx.targetPosition.y + above - agent.position.y) * 1.3, -3.4, 3.4);
  agent.ai.thrust = clamp01(agent.ai.desiredVelocity.length() / Math.max(1, agent.archetype.sprintSpeed));
}

function unaware(): BehaviourNode {
  return sequence(
    condition((a, ctx) => !ctx.targetValid || a.ai.alert < 0.25),
    action((a, ctx) => {
      a.ai.state = 'idle';
      // Uncanny stillness: a Grey that has not seen you does not fidget at all.
      a.ai.desiredVelocity.set(0, 0, 0);
      if (a.archetype.flying) hover(a, ctx, 0.4);
      a.ai.lookValid = false;
      const near = ctx.targetValid && a.ai.distanceToTarget < a.archetype.preferredRange * 2.6;
      a.ai.alert = clamp01(a.ai.alert + (near && a.ai.hasLineOfSight ? ctx.dt * 2.4 : -ctx.dt * 0.2));
      return 'running';
    }),
  );
}

function ringMove(agent: EnemyAgent, ctx: BehaviourContext, dir: THREE.Vector3, dist: number, strafe: number): void {
  const a = agent.archetype;
  const speed = agent.ai.alert > 0.9 ? a.sprintSpeed : a.moveSpeed;
  let radial = 0;
  if (dist > a.preferredRange * 1.15) radial = 1;
  else if (dist < a.preferredRange * 0.72) radial = -1;
  _p2.set(dir.z, 0, -dir.x);
  agent.ai.desiredVelocity.copy(dir).multiplyScalar(radial * speed).addScaledVector(_p2, strafe * speed * 0.65);
}

/** A short teleport, with a violet collapse at both ends. */
function blink(agent: EnemyAgent, ctx: BehaviourContext, offset: THREE.Vector3): void {
  ctx.vfx.elementalBurst(agent.position, 'void', 1.2);
  agent.position.add(offset);
  agent.velocity.multiplyScalar(0.15);
  agent.anim.reset(agent.position, agent.yaw, agent.groundHeight);
  ctx.vfx.elementalBurst(agent.position, 'void', 1.5);
}

// ---------------------------------------------------------------------------
// Behaviours
// ---------------------------------------------------------------------------

/**
 * Drone — hangs perfectly still until it sees you, then closes in one straight
 * burst and detonates. The tell is the lens: it goes from steady to a fast
 * pulse for 0.6 s before the run, and the run itself is committed and dodgeable.
 */
function droneBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let arming = -1;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      ai.state = 'engage';
      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        hover(a, ctx, 0.4);
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.35);
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;

      if (arming < 0 && d < 14) {
        arming = 0;
        ai.attackId = 'armSelfDestruct';
        ai.bark = 'charge';
        a.anim.attack(0.6, 0.1, 0.4);
      }
      if (arming >= 0) {
        arming += ctx.dt;
        // Committed run: full speed, straight line, no course correction after
        // the first second — so sidestepping actually works.
        const lead = arming < 1 ? ctx.targetPosition : ai.lastKnownPosition;
        _p0.subVectors(lead, a.position).normalize();
        ai.desiredVelocity.copy(_p0).multiplyScalar(a.archetype.sprintSpeed * 1.5);
        ai.thrust = 1;
        if (arming > 0.6 && (d < 1.9 || arming > 5)) {
          const fx = rt(ctx);
          fx.blast(a.position, 0.35);
          if (ctx.target && d < 3.4) {
            GREY_DAMAGE.amount = a.archetype.attackDamage * 3.4;
            GREY_DAMAGE.point.copy(ctx.targetPosition);
            GREY_DAMAGE.direction.subVectors(ctx.targetPosition, a.position).normalize();
            GREY_DAMAGE.normal.copy(GREY_DAMAGE.direction).negate();
            GREY_DAMAGE.sourceId = a.entityId;
            ctx.target.applyDamage(GREY_DAMAGE);
          }
          // Self-destruct: the drone is the ammunition.
          a.health = 0;
          a.applyDamage(GREY_DAMAGE);
        }
        return 'running';
      }

      ringMove(a, ctx, dir, d, 0.5);
      hover(a, ctx, 0.5);
      return 'running';
    }),
  );
}

/**
 * Observer — hovers at range and hurls real debris. Each throw is a visible
 * 0.55 s lift out of the ground before anything flies, and the rock travels
 * slowly enough to sidestep.
 */
function observerBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let throwCd = 2.5;
  let queued = 0;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      const fx = rt(ctx);
      ai.state = 'engage';
      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        hover(a, ctx, 0.6);
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.3);
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      ringMove(a, ctx, dir, d, 0.4);
      hover(a, ctx, 1.4);
      throwCd -= ctx.dt;

      if (throwCd <= 0 && ai.hasLineOfSight && d < 34 && !a.anim.busy) {
        throwCd = ctx.rng.range(4, 6.5);
        ai.attackId = 'telekinesis';
        ai.bark = 'taunt';
        // Arms come up and stay up for 0.7 s. That pose *is* the warning.
        a.anim.attack(0.7, 0.2, 0.6);
        queued = 3;
        ai.vars.set('throwPending', 1);
        brace(a, ctx, 0.2);
        return 'running';
      }
      if (ai.vars.get('throwPending') && a.anim.attackStriking && queued > 0) {
        ai.vars.set('throwPending', 0);
        _p1.copy(ctx.targetPosition).addScaledVector(ctx.targetVelocity, 0.35);
        for (let i = 0; i < queued; i++) {
          fx.lift(a.position, a.groundHeight, _p1, a.archetype.attackDamage * 1.5);
        }
        queued = 0;
      }
      if (a.anim.busy) brace(a, ctx, 0.35);
      return 'running';
    }),
  );
}

/**
 * Operative — holds the ring with the beam sidearm and blinks sideways the
 * instant it is under fire or crowded. The blink is short and sideways, never
 * backwards, so it stays in the fight.
 */
function operativeBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let blinkCd = 2;
  let strafeDir = 1;
  let strafeTimer = 0;
  let lastHealth = -1;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      ai.state = 'engage';
      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.35);
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      if (lastHealth < 0) lastHealth = a.health;
      const tookHit = a.health < lastHealth - 1;
      lastHealth = a.health;

      blinkCd -= ctx.dt;
      strafeTimer -= ctx.dt;
      if (strafeTimer <= 0) {
        strafeTimer = ctx.rng.range(0.9, 2.2);
        strafeDir = ctx.rng.bool() ? 1 : -1;
      }
      if (blinkCd <= 0 && (tookHit || d < 7)) {
        blinkCd = ctx.rng.range(3, 5);
        _p2.set(dir.z, 0, -dir.x).multiplyScalar(strafeDir * ctx.rng.range(4.5, 7));
        blink(a, ctx, _p2);
        return 'running';
      }

      ringMove(a, ctx, dir, d, (0.5 + a.archetype.caution * 0.4) * strafeDir);
      if (a.anim.busy) return 'running';
      if (ai.attackCooldown <= 0 && ai.hasLineOfSight && d < a.archetype.preferredRange * 2.2) {
        ai.attackCooldown = a.archetype.attackInterval * ctx.rng.range(0.85, 1.2);
        ai.attackId = 'beam';
        // Short by human standards, but the aperture flares for the whole of it.
        a.anim.attack(0.38, 0.07, 0.26);
        ai.vars.set('attackPending', 1);
      }
      return 'running';
    }),
  );
}

/**
 * Psion — puts the dome up over whichever knot of allies it is standing with
 * and stays inside it, then mind-blasts anyone who gets close enough to matter.
 */
function psionBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  const centre = new THREE.Vector3();
  let dome: BarrierDome | null = null;
  let blastCd = 6;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      const fx = rt(ctx);
      ai.state = 'engage';

      // Dome centre: the mean of the nearby squad, so it actually covers them.
      centre.copy(a.position);
      let n = 1;
      for (const ally of GREY_ROSTER) {
        if (ally === a || ally.state !== 'alive') continue;
        if (ally.position.distanceToSquared(a.position) > 64) continue;
        centre.add(ally.position);
        n++;
      }
      centre.multiplyScalar(1 / n);
      centre.y += 0.2;

      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.3);
        if (dome) dome.update(ctx.dt, centre, null);
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;

      if (a.state !== 'alive') {
        if (dome?.active) dome.collapse(a.position);
        dome = null;
        return 'failure';
      }
      if ((!dome || (!dome.active && dome.cooldown <= 0)) && ai.hasLineOfSight && d < 40) {
        dome = dome ?? fx.dome();
        dome.deploy(ctx.vfx.scene, proxyHost(ctx.collision), centre);
        ai.bark = 'reinforce';
      }
      if (dome) dome.update(ctx.dt, centre, ctx.targetValid ? ctx.targetPosition : null);

      // Hold the dome: never wander outside the thing you are projecting.
      _p0.subVectors(a.position, centre);
      _p0.y = 0;
      if (dome?.active && _p0.length() > dome.radius * 0.62) {
        ai.desiredVelocity.copy(_p0).normalize().multiplyScalar(-a.archetype.moveSpeed);
      } else {
        ringMove(a, ctx, dir, d, 0.35);
      }

      blastCd -= ctx.dt;
      if (blastCd <= 0 && ai.hasLineOfSight && d < 22 && !a.anim.busy) {
        blastCd = ctx.rng.range(7, 10);
        ai.attackId = 'mindBlast';
        ai.bark = 'taunt';
        // The halo drops to the shoulders and the whole body arches: 0.8 s.
        a.anim.attack(0.8, 0.15, 0.55);
        ai.vars.set('blastPending', 1);
        brace(a, ctx, 0.15);
        return 'running';
      }
      if (ai.vars.get('blastPending') && a.anim.attackStriking) {
        ai.vars.set('blastPending', 0);
        fx.blast(ctx.targetPosition, 1);
        if (ctx.target && ai.hasLineOfSight) {
          GREY_DAMAGE.amount = a.archetype.attackDamage * 1.6;
          GREY_DAMAGE.point.copy(ctx.targetPosition);
          GREY_DAMAGE.direction.subVectors(ctx.targetPosition, a.position).normalize();
          GREY_DAMAGE.normal.copy(GREY_DAMAGE.direction).negate();
          GREY_DAMAGE.sourceId = a.entityId;
          ctx.target.applyDamage(GREY_DAMAGE);
        }
      }
      if (a.anim.busy) brace(a, ctx, 0.2);
      return 'running';
    }),
  );
}

/** How much aim movement breaks an abduction. Roughly a fast half-turn. */
const BREAKOUT_AIM = 5.5;

/**
 * Overseer — the abductor. It telegraphs the grab with a 0.9 s aperture charge
 * and a beam that reaches the player before anything happens, then lifts them.
 * The lift is a real loss of control, and it is broken by *aiming* — swing the
 * view hard and you tear free; the prompt says so the first time it happens.
 */
function overseerBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  const lastAim = new THREE.Vector3();
  let grabCd = 5;
  let lifting = -1;
  let struggle = 0;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      const fx = rt(ctx);
      ai.state = 'engage';
      const player = asPlayer(ctx.target);
      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        hover(a, ctx, 1.6);
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.3);
        lifting = -1;
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      grabCd -= ctx.dt;

      if (lifting >= 0 && player) {
        lifting += ctx.dt;
        // Hold station over the victim while the beam is up.
        _p0.copy(player.position).sub(a.position);
        _p0.y = 0;
        ai.desiredVelocity.copy(_p0).multiplyScalar(1.6);
        hover(a, ctx, 4.2);
        brace(a, ctx, 1);
        a.rig.boneWorld('spine.chest', _p1);
        ctx.vfx.beam(_p1, player.eyePosition, GREY.glow, 0.24);

        // The loss of control: pulled off the ground and held.
        player.velocity.x *= 0.86;
        player.velocity.z *= 0.86;
        if (player.velocity.y < 5.5) player.addImpulse(_p2.set(0, 26 * ctx.dt, 0));

        // The break-out: aim movement, accumulated. Shooting the aperture also
        // ends it, because damage staggers the Overseer.
        struggle += lastAim.distanceTo(player.aimDirection) * 12;
        lastAim.copy(player.aimDirection);
        if (struggle > BREAKOUT_AIM || lifting > 2.6 || a.staggered) {
          lifting = -1;
          struggle = 0;
          fx.blast(player.eyePosition, 0.4);
          player.addImpulse(_p2.set(0, -6, 0));
          GREY_DAMAGE.amount = a.archetype.attackDamage * 0.8;
          GREY_DAMAGE.point.copy(player.eyePosition);
          GREY_DAMAGE.direction.set(0, -1, 0);
          GREY_DAMAGE.normal.set(0, 1, 0);
          GREY_DAMAGE.sourceId = a.entityId;
          player.applyDamage(GREY_DAMAGE);
        }
        return 'running';
      }

      ringMove(a, ctx, dir, d, 0.3);
      hover(a, ctx, 2.4);

      if (grabCd <= 0 && player && ai.hasLineOfSight && d < 22 && !a.anim.busy) {
        grabCd = ctx.rng.range(11, 15);
        ai.attackId = 'abduct';
        ai.bark = 'charge';
        // 0.9 s: arms spread, aperture opens, and a thin locking beam paints
        // the player before the pull starts.
        a.anim.attack(0.9, 0.18, 0.6);
        ai.vars.set('grabPending', 1);
        events.emit('ui:toast', { text: 'ABDUCTION BEAM', sub: 'swing your aim to break free', duration: 3 });
        brace(a, ctx, 0.1);
        return 'running';
      }
      if (ai.vars.get('grabPending')) {
        a.rig.boneWorld('spine.chest', _p1);
        ctx.vfx.beam(_p1, ctx.targetPosition, GREY.glow, 0.03);
        if (a.anim.attackStriking) {
          ai.vars.set('grabPending', 0);
          if (player && ai.hasLineOfSight) {
            lifting = 0;
            struggle = 0;
            lastAim.copy(player.aimDirection);
          }
        }
      }
      if (a.anim.busy) brace(a, ctx, 0.2);

      if (ai.attackCooldown <= 0 && ai.hasLineOfSight && d < 26 && !a.anim.busy) {
        ai.attackCooldown = a.archetype.attackInterval * ctx.rng.range(0.9, 1.3);
        ai.attackId = 'lance';
        a.anim.attack(0.4, 0.08, 0.3);
        ai.vars.set('attackPending', 1);
      }
      return 'running';
    }),
  );
}

/**
 * Overmind — the boss.
 *
 * - **Phase 1** three tether masts hold it out of phase. It is *untouchable*
 *   until they are cut: the shield refills every step, the body is translucent,
 *   and three violet tethers show exactly which nodes to shoot. The nodes are
 *   spawned Drones with a visible beam back to the Overmind.
 * - **Phase 2** the tethers are down. It drops into reality and fires
 *   converging psionic lances — three lines that charge visibly and meet on a
 *   single point of ground, so the pattern is learnable and the answer is
 *   always "do not be where they meet".
 * - **Phase 3 (<35%)** the swarm: drones spawn continuously and the lance
 *   pattern doubles up.
 *
 * The arena mechanic is the phasing itself — the fight is fought against the
 * nodes first, and they re-form on a timer, so the player has to keep clearing
 * them while dodging the lances.
 */
function overmindBehaviour(): BehaviourNode {
  const nodes: EnemyAgent[] = [];
  let phase = 1;
  let phaseIntro = 0;
  let lanceCd = 4;
  let swarmCd = 8;
  let retetherCd = 0;
  return selector(
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      const fx = rt(ctx);
      ai.state = 'engage';
      ai.alert = 1;
      hover(a, ctx, 3.6);

      // -- tether bookkeeping ------------------------------------------------
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].state !== 'alive') nodes.splice(i, 1);
      }
      retetherCd -= ctx.dt;
      if (phase <= 2 && nodes.length === 0 && retetherCd <= 0 && summoner) {
        retetherCd = 26;
        for (let i = 0; i < 3; i++) {
          const ang = (i / 3) * Math.PI * 2 + ctx.elapsed * 0.1;
          _p0.set(a.position.x + Math.cos(ang) * 13, a.groundHeight + 3, a.position.z + Math.sin(ang) * 13);
          const node = summoner('grey.drone', _p0, ang + Math.PI);
          if (node && typeof node === 'object' && 'ai' in node) nodes.push(node as EnemyAgent);
          ctx.vfx.elementalBurst(_p0, 'void', 1.6);
        }
        ai.bark = 'reinforce';
      }
      const phased = nodes.length > 0;
      // Out of phase: the shield is restored every step, so nothing lands. The
      // tethers make it obvious *why*, which is what keeps it fair.
      if (phased) {
        a.shield = a.maxShield;
        a.rig.boneWorld('spine.brain', _p1);
        for (const n of nodes) {
          n.getWorldPosition(_p2);
          ctx.vfx.chain(_p1, _p2, GREY.glow, 0.06);
        }
      }

      const frac = a.health / Math.max(1, a.maxHealth);
      const want = frac < 0.35 ? 3 : phased ? 1 : 2;
      if (want !== phase) {
        phase = want;
        phaseIntro = 1.8;
        ai.bark = 'taunt';
        fx.blast(a.position, 0.5);
      }
      if (phaseIntro > 0) {
        phaseIntro -= ctx.dt;
        ai.desiredVelocity.set(0, 0, 0);
        return 'running';
      }

      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        return 'running';
      }
      const dirTo = _p0.subVectors(ctx.targetPosition, a.position);
      dirTo.y = 0;
      const d = dirTo.length() || 1e-3;
      dirTo.multiplyScalar(1 / d);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      // It drifts, it does not charge. A brain in a jar has no urgency.
      ai.desiredVelocity.copy(dirTo).multiplyScalar(d > 20 ? a.archetype.moveSpeed : d < 12 ? -a.archetype.moveSpeed * 0.5 : 0);

      lanceCd -= ctx.dt;
      swarmCd -= ctx.dt;

      if (!phased && lanceCd <= 0 && !a.anim.busy) {
        lanceCd = phase === 3 ? ctx.rng.range(3.4, 4.6) : ctx.rng.range(5, 7);
        ai.attackId = 'lances';
        ai.bark = 'taunt';
        a.anim.attack(0.75, 0.2, 0.5);
        ai.vars.set('lancePending', 1);
      }
      if (ai.vars.get('lancePending') && a.anim.attackStriking) {
        ai.vars.set('lancePending', 0);
        // Converging: every lance ends on the same predicted point.
        _p1.copy(ctx.targetPosition).addScaledVector(ctx.targetVelocity, 0.5);
        _p1.y = a.groundHeight + 1;
        const beams = phase === 3 ? 6 : 3;
        for (let i = 0; i < beams; i++) {
          const ang = (i / beams) * Math.PI * 2 + ctx.rng.range(0, 0.5);
          _p2.set(_p1.x + Math.cos(ang) * 16, _p1.y + 9, _p1.z + Math.sin(ang) * 16);
          fx.lance(_p2, _p1, 1.1, a.archetype.attackDamage * 1.2);
        }
      }

      if (phase === 3 && swarmCd <= 0 && summoner) {
        swarmCd = 7;
        const budget = Math.max(2, Math.round(settings.profile.enemyBudget * 0.15));
        for (let i = 0; i < budget; i++) {
          const ang = ctx.rng.range(0, Math.PI * 2);
          _p2.set(a.position.x + Math.cos(ang) * 7, a.groundHeight + 2.5, a.position.z + Math.sin(ang) * 7);
          summoner('grey.drone', _p2, ang + Math.PI);
          ctx.vfx.elementalBurst(_p2, 'void', 1);
        }
        ai.bark = 'reinforce';
      }
      return 'running';
    }),
  );
}

// ---------------------------------------------------------------------------
// Species flourishes
// ---------------------------------------------------------------------------

const _eye = new THREE.Vector3();

/**
 * The eye-glow pulse. Greys hold still, so the only thing moving on an idle
 * Grey should be the light behind the eyes — and it races while a wind-up is
 * held, which is half the telegraph.
 */
function greyAnimate(agent: EnemyAgent, ctx: AnimationContext): void {
  if (agent.lod === 'distant' || agent.state !== 'alive' || !lastVfx) return;
  const windup = agent.ai.windup;
  if (windup <= 0.02) return;
  // A violet mote at the head while charging: visible from the front, and the
  // only per-frame effect these units emit.
  const rate = 14;
  const now = Math.floor(ctx.elapsed * rate);
  if (now === (agent.ai.vars.get('glowPhase') ?? -1)) return;
  agent.ai.vars.set('glowPhase', now);
  agent.rig.boneWorld(agent.headBone, _eye);
  lastVfx.trail(_eye, GREY.glow, agent.height * 0.05);
}

// ---------------------------------------------------------------------------
// AI-layer behaviour trees
// ---------------------------------------------------------------------------

function asAgent(c: BtContext): EnemyAgent {
  return c.brain.agent as unknown as EnemyAgent;
}

const poseAttack = (id: string, windup: number, strike: number, recover: number): ReturnType<typeof btAction> =>
  btAction(`pose:${id}`, (c) => {
    const a = asAgent(c);
    if (!a.ai.vars.get(`pose:${id}`)) {
      a.ai.attackId = id;
      a.anim.attack(Math.max(0.35, windup), strike, recover);
      a.ai.vars.set(`pose:${id}`, 1);
      return RUNNING;
    }
    if (a.anim.attackStriking) {
      a.ai.vars.set(`pose:${id}`, 0);
      a.ai.vars.set('attackPending', 1);
      return SUCCESS;
    }
    if (!a.anim.busy) {
      a.ai.vars.set(`pose:${id}`, 0);
      return FAILURE;
    }
    return RUNNING;
  });

function greyTree(engaged: ReturnType<typeof par>): BehaviorTree {
  return compileTree(
    sel(
      guard((c) => c.brain.percept.state === 'engaged', engaged),
      guard(
        (c) => c.brain.percept.state === 'searching',
        sel(seq(searchLastKnown(0.85), scanArea(2.4)), scanArea(1.8)),
      ),
      guard(
        (c) => c.brain.percept.state === 'suspicious',
        seq(btBark('suspicious'), sel(searchLastKnown(0.5), scanArea(2.2))),
      ),
      // Uncanny stillness: a Grey on patrol barely moves, and holds when idle.
      sel(patrolArea(9, 0.22), holdPosition()),
    ),
  );
}

export const GREY_TREES: Record<string, BehaviorTree> = {
  'grey.drone': greyTree(par('all', 'all', advanceToRange(1.6, 1), seq(faceTarget(0.4), poseAttack('armSelfDestruct', 0.6, 0.1, 0.4)))),
  'grey.observer': greyTree(
    par('all', 'all', strafeAtRange(22, 0.5), sel(seq(faceTarget(0.3), poseAttack('telekinesis', 0.7, 0.2, 0.6)), holdPosition())),
  ),
  'grey.operative': greyTree(
    par(
      'all',
      'all',
      sel(fail(cond('crowded', (c) => c.brain.agent.position.distanceTo(c.host.target.centre) < 7)), repositionFiring(10, 0.9), strafeAtRange()),
      withAttackToken(seq(faceTarget(0.3), telegraph(0.38, 'beam', 'taunt'), fireBurst(3, 0.14))),
    ),
  ),
  'grey.psion': greyTree(
    par('all', 'all', advanceToRange(16, 0.6), sel(seq(faceTarget(0.3), poseAttack('mindBlast', 0.8, 0.15, 0.55)), holdPosition())),
  ),
  'grey.overseer': greyTree(
    par('all', 'all', strafeAtRange(16, 0.55), sel(seq(faceTarget(0.25), poseAttack('abduct', 0.9, 0.18, 0.6)), holdPosition())),
  ),
  'grey.overmind': greyTree(
    par('all', 'all', advanceToRange(18, 0.5), sel(seq(faceTarget(0.3), poseAttack('lances', 0.75, 0.2, 0.5)), holdPosition())),
  ),
};

/** Minimal view of the AI director this module needs. */
export interface GreyAiHost {
  registerBehaviour(archetypeId: string, tree: BehaviorTree): void;
}

/** Install the compiled trees. Call once after `new AiDirector(...)`. */
export function registerGreyBehaviours(director: GreyAiHost): void {
  for (const id of Object.keys(GREY_TREES)) director.registerBehaviour(id, GREY_TREES[id]);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function species(
  archetype: EnemyArchetype,
  build: (ctx: BodyBuildContext) => BuiltBody,
  behaviour: () => BehaviourNode,
): SpeciesDefinition {
  return { archetype, build, behaviour, animate: greyAnimate };
}

let registered = false;

/**
 * Register the swarm. Called at module scope so a bare
 * `import '@/gameplay/enemies/factions/grey'` is all a level needs.
 */
export function registerGreySpecies(): void {
  if (registered) return;
  registered = true;
  EnemyManager.register(species(GREY_ARCHETYPES['grey.drone'], buildDrone, droneBehaviour));
  EnemyManager.register(species(GREY_ARCHETYPES['grey.observer'], buildObserver, observerBehaviour));
  EnemyManager.register(species(OPERATIVE, buildOperative, operativeBehaviour));
  EnemyManager.register(species(GREY_ARCHETYPES['grey.psion'], buildPsion, psionBehaviour));
  EnemyManager.register(species(GREY_ARCHETYPES['grey.overseer'], buildOverseer, overseerBehaviour));
  EnemyManager.register(species(GREY_ARCHETYPES['grey.overmind'], buildOvermind, overmindBehaviour));
}

registerGreySpecies();

export { buildDrone, buildObserver, buildOperative, buildPsion, buildOverseer, buildOvermind };
