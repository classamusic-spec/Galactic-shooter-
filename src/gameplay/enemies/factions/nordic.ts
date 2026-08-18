/**
 * The Evil Nordic — the frost-iron warhost of Aurvangr.
 *
 * ## Art direction
 *
 * These are *not* cosplay vikings. They are a tall, broad, pale-skinned species
 * that evolved on a glacier world and built an iron culture around it, and the
 * Norse read comes from the *engineering*: rune-etched frost-iron, antlered
 * helms, braided cable hair, and a stasis technology that runs glacial-blue
 * light through every armour seam. Three values carry every body — near-black
 * frost-iron (`iron`), a lighter forged plate (`plate`), and pale skin — so the
 * silhouette holds at 40 m and the emissive seams are the only saturated thing
 * in the frame.
 *
 * ## Silhouette contract (readable as a black shape, no nameplate)
 *
 * | unit        | h    | stance                    | the read                        |
 * |-------------|------|---------------------------|---------------------------------|
 * | Thrall      | 1.85 | hunched, long-armed       | twin crescent axes, wild braids |
 * | Raider      | 2.15 | upright infantry          | forward horns + long rune rifle |
 * | Huscarl     | 2.40 | braced behind a slab      | antlers + tower shield          |
 * | Seer        | 2.10 | floats, legless robe cone | spiked crown + orbiting runes   |
 * | Jarl        | 2.90 | wide, weight on the back  | crown + two-handed hammer       |
 * | Allfather   | 6.00 | colossal, caped           | antler crown spanning 3 m       |
 *
 * ## Faction mechanics
 *
 * Stasis. Ice-blue emissives, freezing fields that slow, and a shatter on
 * death. `nordic.huscarl` deploys a shield wall that is a **real** blocker —
 * it registers hit proxies with the collision world, so the player's rounds
 * stop in it and the only answer is to flank. The Allfather is a three-phase
 * set-piece: telegraphed slam rings, a blizzard that whites out the arena and
 * seeds thralls, back-mounted rune pylons that open after every slam, and an
 * enrage under a third health.
 *
 * ## Integration seams this module needs from other owners
 *
 * - `setNordicSummoner()` — hand it `enemies.spawn` so the boss can call its
 *   thralls. Without it the summon beat degrades to an extra frost nova, so the
 *   fight still works; it is just poorer.
 * - `registerNordicBehaviours(director)` — installs the compiled AI-layer trees
 *   (`@/gameplay/ai/BehaviorTree` nodes, using Perception/CoverMap/Squad via the
 *   director's own node vocabulary) for the units the director drives.
 */
import * as THREE from 'three';
import type { CollisionWorld, DamageInfo, Damageable, EnemyArchetype } from '@/types';
import { clamp, clamp01, damp, Rng } from '@/util/math';
import { settings } from '@/core/Settings';
import type { HitProxy } from '@/gameplay/Physics';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { ARCHETYPES, FACTION_ACCENT } from '../Archetypes';
import { DOWN, FORWARD, UP } from '../Rig';
import { bevelBox } from '../BodyBuilder';
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
  holdCover,
  holdPosition,
  leaveCover,
  moveToFlank,
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
  withAttackToken,
  action as btAction,
  leapAt,
  bark as btBark,
  type BehaviorTree,
  type BtContext,
} from '@/gameplay/ai/BehaviorTree';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Faction colour identity: glacial blue emissives, near-white ichor. */
export const NORDIC = {
  accent: FACTION_ACCENT.nordic,
  /** Deep frost-iron. Dark enough to read as the silhouette's core value. */
  iron: 0x3d4855,
  /** Forged plate — the mid value that catches the sun. */
  plate: 0x8b98a6,
  /** Pale glacier skin, faintly blue in shadow. */
  skin: 0xbcc7d4,
  /** Pelt and lashings; the only warm note on the body. */
  pelt: 0x39332e,
  /** Rime and axe edges. */
  frost: 0xcfeaff,
  /** Rune light. */
  rune: 0x9fd8ff,
  /** Frozen blood. */
  ichor: 0xa8d4ec,
} as const;

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Brief-facing unit names → catalogue archetype ids. */
export const NORDIC_UNITS = {
  nordic_thrall: 'nordic.thrall',
  nordic_huscarl: 'nordic.raider',
  nordic_shieldbearer: 'nordic.huscarl',
  nordic_seer: 'nordic.seer',
  nordic_jarl: 'nordic.jarl',
  nordic_konungr: 'nordic.allfather',
} as const;

/**
 * The Seer has no slot in the shared catalogue (`@/gameplay/enemies/Archetypes`
 * ships five Nordic entries), so it is declared here with every field filled,
 * following the same rank baselines. Champion health, but a caster's frame:
 * fragile in melee, lethal if left to channel.
 */
const SEER: EnemyArchetype = {
  id: 'nordic.seer',
  faction: 'nordic',
  rank: 'champion',
  displayName: 'Seer',
  health: 620,
  shield: 320,
  shieldElement: 'stasis',
  moveSpeed: 2.6,
  sprintSpeed: 4.2,
  preferredRange: 24,
  eyeHeight: 1.75,
  capsuleRadius: 0.5,
  capsuleHalfHeight: 0.5,
  attackDamage: 12,
  attackInterval: 0.14,
  accuracy: 0.012,
  aggression: 0.35,
  caution: 0.7,
  flying: true,
  score: 180,
  abilities: ['blink', 'runeBeam', 'wardAllies'],
};

/** Every Nordic archetype this module registers, catalogue entries included. */
export const NORDIC_ARCHETYPES: Record<string, EnemyArchetype> = {
  'nordic.thrall': ARCHETYPES['nordic.thrall'],
  'nordic.raider': ARCHETYPES['nordic.raider'],
  'nordic.huscarl': ARCHETYPES['nordic.huscarl'],
  'nordic.seer': SEER,
  'nordic.jarl': ARCHETYPES['nordic.jarl'],
  'nordic.allfather': ARCHETYPES['nordic.allfather'],
};

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

/** Rest position of a bone, as a fresh vector (build-time only). */
function at(ctx: BodyBuildContext, name: string): THREE.Vector3 {
  return ctx.rig.restPosition(name, new THREE.Vector3());
}

/** Rest position of the tip past the last bone of a chain. */
function tip(ctx: BodyBuildContext, chainId: string): THREE.Vector3 {
  const c = ctx.rig.chainById(chainId);
  return c ? c.restTip.clone() : new THREE.Vector3();
}

/**
 * Six materials, four values. A body built from one material is a white blob at
 * 20 m however good its normal map is; the dark/mid/pale split is what carves
 * the armour out of the silhouette, and the rune emissive is the only thing
 * allowed to be saturated.
 */
function nordicMaterials(ctx: BodyBuildContext): void {
  const b = ctx.builder;
  b.material('iron', 'nordicIronwork', { color: NORDIC.iron, roughness: 0.58, metalness: 0.92 });
  b.material('plate', 'nordicIronwork', { color: NORDIC.plate, roughness: 0.34, metalness: 0.96 });
  b.material('skin', 'flesh', { color: NORDIC.skin, roughness: 0.74, metalness: 0.02 });
  b.material('pelt', 'organic', { color: NORDIC.pelt, roughness: 0.95, metalness: 0.03 });
  b.material('frost', 'ice', { color: NORDIC.frost, roughness: 0.16, metalness: 0.04 });
  b.emissive('rune', NORDIC.rune, 3.4);
}

/**
 * A crescent axe head on a haft. Two mirrored blades and a top spike, so the
 * weapon reads as an axe in silhouette rather than as a stick with a lump.
 */
function iceAxe(
  ctx: BodyBuildContext,
  hand: THREE.Vector3,
  forward: THREE.Vector3,
  scale: number,
  doubleBit: boolean,
): void {
  const b = ctx.builder;
  const f = forward.clone().normalize();
  const up = v(0, 1, 0).addScaledVector(f, -f.y).normalize();
  const side = new THREE.Vector3().crossVectors(up, f).normalize();
  const haftEnd = hand.clone().addScaledVector(f, 0.62 * scale);
  const haftStart = hand.clone().addScaledVector(f, -0.2 * scale);
  b.add('iron', b.segment({
    from: haftStart,
    to: haftEnd,
    r0: 0.028 * scale,
    r1: 0.023 * scale,
    sides: 7,
    faceted: true,
    color: 0x2f3740,
  }));
  b.add('pelt', b.segment({
    from: hand.clone().addScaledVector(f, -0.13 * scale),
    to: hand.clone().addScaledVector(f, 0.1 * scale),
    r0: 0.036 * scale,
    r1: 0.034 * scale,
    sides: 8,
  }));
  const head = hand.clone().addScaledVector(f, 0.5 * scale);
  for (const s of doubleBit ? [-1, 1] : [1]) {
    b.add('frost', b.mandible({
      base: head.clone().addScaledVector(up, s * 0.035 * scale),
      direction: up.clone().multiplyScalar(s).addScaledVector(f, 0.18).normalize(),
      inward: f.clone().negate(),
      length: 0.3 * scale,
      thickness: 0.075 * scale,
      flatten: 0.22,
      serrations: 3,
      color: 0xdff2ff,
      colorTip: 0x8fc8ee,
    }));
    b.add('plate', b.plate({
      centre: head.clone().addScaledVector(up, s * 0.13 * scale),
      normal: side,
      up: up.clone().multiplyScalar(s),
      width: 0.2 * scale,
      height: 0.24 * scale,
      thickness: 0.018 * scale,
      curve: 0.55,
      taper: 0.42,
      color: 0x9dabb8,
      edgeColor: 0x59636e,
    }));
  }
  b.add('rune', b.lens({
    centre: head.clone().addScaledVector(side, 0.03 * scale),
    normal: side,
    radius: 0.032 * scale,
    bulge: 0.45,
  }));
  b.add('frost', b.spine({
    base: haftEnd.clone(),
    direction: f,
    length: 0.16 * scale,
    radius: 0.026 * scale,
    sharpness: 1.4,
    color: 0xdff2ff,
  }));
}

/** A rune-etched seam: a thin emissive bar with an iron gutter behind it. */
function runeSeam(
  ctx: BodyBuildContext,
  from: THREE.Vector3,
  to: THREE.Vector3,
  width: number,
): void {
  const b = ctx.builder;
  b.add('rune', b.segment({ from, to, r0: width, r1: width * 0.7, sides: 5, steps: 4 }));
}

/** A forward-sweeping helm horn with ridges. */
function helmHorn(
  ctx: BodyBuildContext,
  base: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  radius: number,
  curve: number,
): void {
  ctx.builder.add('plate', ctx.builder.horn({
    base,
    direction: dir.clone().normalize(),
    length,
    radius,
    curve,
    ridges: 6,
    color: 0x9fadba,
    colorTip: 0x4d5761,
  }));
}

/**
 * A branching antler. One shaft plus three tines — the branch is the whole
 * point: an antlered helm has to break up against the sky or it is a horn.
 */
function antler(
  ctx: BodyBuildContext,
  base: THREE.Vector3,
  outward: THREE.Vector3,
  scale: number,
): void {
  const b = ctx.builder;
  const dir = outward.clone().normalize();
  const shaftEnd = base.clone().addScaledVector(dir, 0.5 * scale);
  b.add('plate', b.horn({
    base,
    direction: dir,
    length: 0.52 * scale,
    radius: 0.036 * scale,
    curve: 0.1 * scale,
    curveAxis: v(0, 0, -1),
    ridges: 7,
    color: 0x93a1ae,
    colorTip: 0x39424c,
  }));
  const tines: Array<[number, THREE.Vector3]> = [
    [0.22, v(dir.x * 0.35, 0.9, -0.3)],
    [0.44, v(dir.x * 0.6, 0.78, 0.25)],
    [0.72, v(dir.x * 0.85, 0.52, -0.15)],
  ];
  for (const [t, td] of tines) {
    b.add('plate', b.horn({
      base: base.clone().lerp(shaftEnd, t),
      direction: td.normalize(),
      length: (0.3 - t * 0.12) * scale,
      radius: 0.024 * scale,
      curve: 0.05 * scale,
      ridges: 4,
      color: 0x93a1ae,
      colorTip: 0x2f3740,
    }));
  }
}

/** Braided cable hair: segmented digits hanging off the back of the skull. */
function braids(ctx: BodyBuildContext, head: THREE.Vector3, count: number, len: number): void {
  const b = ctx.builder;
  for (let i = 0; i < count; i++) {
    const a = (i / Math.max(1, count - 1) - 0.5) * 1.7;
    b.add('pelt', b.digit({
      base: head.clone().add(v(Math.sin(a) * 0.085, 0.03 - Math.abs(a) * 0.02, 0.075 + Math.cos(a) * 0.02)),
      direction: v(Math.sin(a) * 0.5, -0.55, 0.72).normalize(),
      length: len,
      radius: 0.019,
      joints: 4,
      curl: 0.55,
      color: 0x4a423a,
    }));
  }
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * Thrall — the minor. Unarmoured, hunched, long-armed, twin crescent axes.
 * Reads instantly against a Huscarl: no helm, no plate, and a forward lean the
 * armoured units never take.
 */
function buildThrall(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  nordicMaterials(ctx);

  rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'], [0.24, 0.3, 0.13, 0.17, 0.16], {
    origin: v(0, 0.9, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    // Hunched: the lumbar and chest pitch forward, the neck lifts the skull
    // back out of the shoulders so it still faces the player.
    restBend: [0, 0.2, 0.14, -0.34, 0.02],
    capture: [0.3, 0.3, 0.3, 0.18, 0.24],
  });

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`leg.${s}`, ['hip', 'knee', 'ankle', 'toe'], [0.46, 0.44, 0.16, 0.1], {
      parent: 'spine.hips',
      origin: v(side * 0.145, -0.03, 0.01),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side,
      restBend: [0.1, -0.22, 1.64],
      capture: [0.24, 0.2, 0.17, 0.14],
    });
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.36, 0.35, 0.15], {
      parent: 'spine.chest',
      origin: v(side * 0.2, 0.06, 0.02),
      direction: v(side * 0.3, -1, 0.1).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.2, 0.42, 0.18],
      capture: [0.2, 0.17, 0.14],
    });
  }
  rig.chain('braid', ['b0', 'b1', 'b2'], [0.17, 0.15, 0.1], {
    parent: 'spine.head',
    origin: v(0, 0.02, 0.07),
    direction: v(0, -0.35, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.1, 0.09, 0.08],
  });

  const hips = at(ctx, 'spine.hips');
  const lumbar = at(ctx, 'spine.lumbar');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');

  b.add('skin', b.segment({ from: hips.clone().setY(hips.y - 0.1), to: lumbar, r0: 0.155, r1: 0.145, flatten: 0.76, sides: 11 }));
  b.add('skin', b.taperedLimb({ from: lumbar, to: chest, r0: 0.145, r1: 0.205, flatten: 0.66, muscle: 1.12, jointR: 0.17, sides: 12 }));
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.04), to: head, r0: 0.076, r1: 0.07, sides: 8 }));

  // A loin wrap and a single shoulder strap: enough cloth to say "slave-soldier"
  // and to break the bare torso, not enough to read as armour.
  b.add('pelt', b.segment({ from: hips.clone().add(v(0, 0.05, 0)), to: hips.clone().add(v(0, -0.24, 0)), r0: 0.19, r1: 0.21, flatten: 0.72, sides: 10, color: 0x453d34 }));
  b.add('pelt', b.plate({ centre: chest.clone().add(v(-0.06, 0.0, -0.14)), normal: v(-0.35, 0.1, -1).normalize(), width: 0.13, height: 0.44, thickness: 0.016, curve: 0.5, taper: 0.9, color: 0x4b423a, edgeColor: 0x2b2622 }));
  runeSeam(ctx, chest.clone().add(v(0, 0.06, -0.2)), chest.clone().add(v(0, -0.16, -0.19)), 0.011);

  // Skull: long, heavy brow, no helm. The brow and the jaw are the read.
  b.add('skin', b.carapace({ centre: head.clone().add(v(0, -0.02, 0.01)), radius: 0.105, height: 0.17, length: 0.82, segments: 11, color: 0xc6d1dd }));
  b.add('skin', b.segment({ from: head.clone().add(v(0, -0.03, -0.02)), to: head.clone().add(v(0, -0.075, -0.13)), r0: 0.082, r1: 0.05, flatten: 0.8, sides: 8 }));
  b.add('iron', b.plate({ centre: head.clone().add(v(0, 0.035, -0.075)), normal: v(0, 0.42, -1).normalize(), width: 0.19, height: 0.075, thickness: 0.016, curve: 1.5, taper: 0.9, color: 0x59636e, edgeColor: 0x272e35 }));
  for (const s of [-1, 1] as const) {
    b.add('rune', b.lens({ centre: head.clone().add(v(s * 0.048, -0.005, -0.088)), normal: v(s * 0.4, -0.05, -1).normalize(), radius: 0.019, bulge: 0.5 }));
    helmHorn(ctx, head.clone().add(v(s * 0.085, 0.055, 0.01)), v(s * 0.55, 0.42, 0.72), 0.17, 0.021, 0.03);
  }
  braids(ctx, head, 5, 0.24);

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

    b.add('skin', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.075, r1: 0.055, jointR: 0.082, muscle: 1.28 }));
    b.add('skin', b.taperedLimb({ from: elbow, to: wrist, r0: 0.058, r1: 0.042, jointR: 0.063, muscle: 1.18 }));
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.044, r1: 0.034, flatten: 0.7, sides: 7 }));
    b.add('pelt', b.segment({ from: elbow.clone().lerp(wrist, 0.15), to: elbow.clone().lerp(wrist, 0.55), r0: 0.062, r1: 0.056, sides: 8, color: 0x3f382f }));
    runeSeam(ctx, shoulder.clone().add(v(side * 0.06, 0.01, 0)), elbow.clone().add(v(side * 0.045, 0, 0)), 0.008);
    for (let d = 0; d < 3; d++) {
      b.add('skin', b.digit({
        base: hand.clone().add(v(side * (d - 1) * 0.02, 0.004, -0.012)),
        direction: v(side * (d - 1) * 0.25, -0.85, -0.5).normalize(),
        length: 0.07,
        radius: 0.012,
        joints: 2,
        curl: 0.7,
        claw: true,
      }));
    }

    b.add('skin', b.taperedLimb({ from: hip, to: knee, r0: 0.115, r1: 0.082, jointR: 0.122, muscle: 1.3, flatten: 0.92 }));
    b.add('skin', b.taperedLimb({ from: knee, to: ankle, r0: 0.086, r1: 0.052, jointR: 0.09, muscle: 1.2, flatten: 0.9 }));
    b.add('pelt', b.segment({ from: ankle.clone().add(v(0, 0.06, 0)), to: ankle.clone().add(v(0, -0.02, 0)), r0: 0.068, r1: 0.062, sides: 8, color: 0x3f382f }));
    b.add('skin', b.segment({ from: ankle.clone().add(v(0, 0.01, 0.03)), to: toe, r0: 0.066, r1: 0.055, flatten: 0.76, sides: 8 }));
    b.add('skin', b.segment({ from: toe, to: toeTip, r0: 0.055, r1: 0.032, flatten: 0.72, sides: 7 }));

    // Twin axes — the silhouette. Held low and wide so they clear the body.
    iceAxe(ctx, hand.clone().add(v(side * 0.02, -0.02, 0)), v(side * 0.12, -0.28, -0.95), 0.86, true);
  }

  return {
    rig,
    parts: b.finish(),
    height: 1.85,
    headBone: 'spine.head',
    muzzleBone: 'arm.R.wrist',
    accentColor: NORDIC.accent,
    shieldRadius: 0.95,
    tuning: { runSpeed: 7.4, strideScale: 0.72, kneeSign: 1, bob: 0.062, sway: 0.045, leanAccel: 0.035, breathRate: 1.1, breathAmount: 0.05 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.15, multiplier: 2.4 },
      { region: 'body', bone: 'spine.chest', radius: 0.26, halfHeight: 0.16, multiplier: 1 },
      { region: 'body', bone: 'spine.hips', radius: 0.2, halfHeight: 0.12, multiplier: 1 },
      { region: 'limb', bone: 'arm.L.elbow', radius: 0.11, multiplier: 0.6 },
      { region: 'limb', bone: 'arm.R.elbow', radius: 0.11, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.L.knee', radius: 0.13, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.R.knee', radius: 0.13, multiplier: 0.6 },
    ],
  };
}

/**
 * Raider — the standard. Rune-rifle infantry in half plate, forward-swept
 * helm horns, a rifle long enough to read across the whole silhouette. Uses
 * cover and lobs frost bombs.
 */
function buildRaider(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  nordicMaterials(ctx);

  rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'], [0.26, 0.32, 0.15, 0.18, 0.2], {
    origin: v(0, 1.06, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.05, 0.05, 0.01, 0],
    capture: [0.34, 0.34, 0.34, 0.2, 0.28],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`leg.${s}`, ['hip', 'knee', 'ankle', 'toe'], [0.52, 0.5, 0.18, 0.12], {
      parent: 'spine.hips',
      origin: v(side * 0.17, -0.03, 0.01),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side,
      restBend: [0.07, -0.16, 1.66],
      capture: [0.27, 0.23, 0.2, 0.16],
    });
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.34, 0.31, 0.15], {
      parent: 'spine.chest',
      origin: v(side * 0.25, 0.07, 0),
      direction: v(side * 0.2, -1, 0).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.12, 0.32, 0.2],
      capture: [0.21, 0.18, 0.15],
    });
  }
  rig.chain('cloak', ['c0', 'c1', 'c2'], [0.3, 0.26, 0.14], {
    parent: 'spine.chest',
    origin: v(0, 0.08, 0.14),
    direction: v(0, -0.9, 0.44).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.3, 0.28, 0.22],
  });

  const hips = at(ctx, 'spine.hips');
  const lumbar = at(ctx, 'spine.lumbar');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');
  const headTop = tip(ctx, 'spine');

  b.add('iron', b.segment({ from: hips.clone().setY(hips.y - 0.1), to: lumbar, r0: 0.19, r1: 0.175, flatten: 0.74, sides: 12 }));
  b.add('iron', b.taperedLimb({ from: lumbar, to: chest, r0: 0.175, r1: 0.225, flatten: 0.68, muscle: 1.06, jointR: 0.2, sides: 12 }));
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.05), to: head, r0: 0.088, r1: 0.078, sides: 9 }));

  // Cuirass + back plate: the widest, hardest read in the silhouette.
  b.add('plate', b.plate({ centre: chest.clone().add(v(0, 0.02, -0.17)), normal: FORWARD, width: 0.46, height: 0.44, thickness: 0.038, curve: 1.3, taper: 0.82, color: 0x9dabb8, edgeColor: 0x505a65 }));
  b.add('plate', b.plate({ centre: chest.clone().add(v(0, -0.02, 0.17)), normal: v(0, 0.05, 1), width: 0.42, height: 0.4, thickness: 0.032, curve: 1.15, taper: 0.9, color: 0x76828e, edgeColor: 0x3b444d }));
  b.add('rune', b.lens({ centre: chest.clone().add(v(0, 0.07, -0.192)), normal: FORWARD, radius: 0.045, bulge: 0.45 }));
  runeSeam(ctx, chest.clone().add(v(-0.13, 0.09, -0.19)), chest.clone().add(v(-0.13, -0.13, -0.18)), 0.011);
  runeSeam(ctx, chest.clone().add(v(0.13, 0.09, -0.19)), chest.clone().add(v(0.13, -0.13, -0.18)), 0.011);
  // Faulds: overlapping skirt plates over the hips.
  for (let i = 0; i < 5; i++) {
    const a = (i / 4 - 0.5) * 2.1;
    b.add('plate', b.plate({
      centre: hips.clone().add(v(Math.sin(a) * 0.2, -0.11, -Math.cos(a) * 0.2)),
      normal: v(Math.sin(a), -0.18, -Math.cos(a)).normalize(),
      width: 0.14,
      height: 0.22,
      thickness: 0.02,
      curve: 0.5,
      taper: 0.78,
      color: 0x8896a3,
      edgeColor: 0x3f4952,
    }));
  }

  // Helm: a faceted skull-cap, a dark T-slit visor lit from inside, two horns
  // sweeping forward. The horns are what separate it from the Huscarl's antlers.
  b.add('plate', b.carapace({ centre: head.clone().add(v(0, -0.03, 0)), radius: 0.13, height: 0.23, length: 0.9, segments: 10, faceted: true, color: 0x9dabb8, colorTip: 0x646f7a }));
  b.add('iron', b.segment({ from: head.clone().add(v(0, -0.09, -0.01)), to: head.clone().add(v(0, 0.0, -0.06)), r0: 0.125, r1: 0.112, flatten: 0.9, sides: 9, faceted: true, color: 0x333c45 }));
  b.add('rune', b.segment({ from: head.clone().add(v(-0.09, -0.015, -0.1)), to: head.clone().add(v(0.09, -0.015, -0.1)), r0: 0.013, r1: 0.013, sides: 5, steps: 3 }));
  b.add('rune', b.segment({ from: head.clone().add(v(0, -0.015, -0.108)), to: head.clone().add(v(0, -0.075, -0.095)), r0: 0.011, r1: 0.008, sides: 5, steps: 3 }));
  for (const s of [-1, 1] as const) {
    helmHorn(ctx, head.clone().add(v(s * 0.11, 0.03, 0.01)), v(s * 0.5, 0.34, -0.8), 0.3, 0.03, 0.06);
  }
  b.add('plate', b.spine({ base: headTop.clone().add(v(0, -0.1, 0.02)), direction: v(0, 1, -0.1).normalize(), length: 0.12, radius: 0.02, color: 0x9dabb8 }));
  braids(ctx, head, 4, 0.2);

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

    b.add('iron', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.085, r1: 0.062, jointR: 0.09, muscle: 1.2 }));
    b.add('iron', b.taperedLimb({ from: elbow, to: wrist, r0: 0.065, r1: 0.05, jointR: 0.07, muscle: 1.12 }));
    b.add('plate', b.plate({ centre: shoulder.clone().add(v(side * 0.06, 0.04, 0)), normal: v(side, 0.45, 0).normalize(), up: v(0, 0, -1), width: 0.3, height: 0.26, thickness: 0.032, curve: 1.55, taper: 0.72, color: 0xa7b4c0, edgeColor: 0x4b555f }));
    b.add('plate', b.plate({ centre: elbow.clone().lerp(wrist, 0.45).add(v(side * 0.05, 0, -0.02)), normal: v(side, 0.1, -0.4).normalize(), width: 0.14, height: 0.2, thickness: 0.02, curve: 1.2, taper: 0.9, color: 0x8896a3, edgeColor: 0x3f4952 }));
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.05, r1: 0.038, flatten: 0.7, sides: 8 }));
    for (let d = 0; d < 3; d++) {
      b.add('skin', b.digit({
        base: hand.clone().add(v(side * (d - 1) * 0.021, 0.004, -0.01)),
        direction: v(side * (d - 1) * 0.2, -0.9, -0.4).normalize(),
        length: 0.07,
        radius: 0.013,
        joints: 2,
        curl: 0.45,
      }));
    }

    b.add('iron', b.taperedLimb({ from: hip, to: knee, r0: 0.128, r1: 0.094, jointR: 0.135, muscle: 1.22, flatten: 0.92 }));
    b.add('iron', b.taperedLimb({ from: knee, to: ankle, r0: 0.098, r1: 0.064, jointR: 0.102, muscle: 1.14, flatten: 0.9 }));
    b.add('plate', b.plate({ centre: knee.clone().add(v(0, 0.02, -0.09)), normal: FORWARD, width: 0.2, height: 0.21, thickness: 0.026, curve: 1.5, taper: 0.7, color: 0x8896a3, edgeColor: 0x3f4952 }));
    b.add('plate', b.plate({ centre: knee.clone().lerp(ankle, 0.55).add(v(0, 0, -0.08)), normal: FORWARD, width: 0.17, height: 0.26, thickness: 0.022, curve: 1.25, taper: 0.86, color: 0x76828e, edgeColor: 0x333c45 }));
    b.add('iron', b.segment({ from: ankle.clone().add(v(0, 0.01, 0.03)), to: toe, r0: 0.078, r1: 0.064, flatten: 0.78, sides: 8 }));
    b.add('iron', b.segment({ from: toe, to: toeTip, r0: 0.064, r1: 0.04, flatten: 0.72, sides: 7, faceted: true }));
    b.add('rune', b.lens({ centre: shoulder.clone().add(v(side * 0.085, 0.06, -0.03)), normal: v(side, 0.35, -0.3).normalize(), radius: 0.024, bulge: 0.6 }));
  }

  // Rune rifle on the right hard-point. Long barrel, boxy receiver, glowing core.
  const rWrist = at(ctx, 'arm.R.wrist');
  const gunBase = rWrist.clone().add(v(0.03, -0.03, -0.04));
  const gunDir = v(0.04, -0.16, -1).normalize();
  b.add('iron', b.weaponMount({ base: gunBase, direction: gunDir, length: 0.72, radius: 0.032, bracket: 0.12, shroud: true, color: 0x2f3740 }));
  b.add('plate', b.plate({ centre: gunBase.clone().addScaledVector(gunDir, 0.2).add(v(0.055, 0, 0)), normal: v(1, 0.1, 0).normalize(), up: gunDir, width: 0.1, height: 0.28, thickness: 0.02, curve: 0.4, taper: 0.85, color: 0x8896a3, edgeColor: 0x3f4952 }));
  b.add('rune', b.segment({ from: gunBase.clone().addScaledVector(gunDir, 0.1), to: gunBase.clone().addScaledVector(gunDir, 0.34), r0: 0.014, r1: 0.011, sides: 6, steps: 4 }));
  b.add('rune', b.lens({ centre: gunBase.clone().addScaledVector(gunDir, 0.7), normal: gunDir, radius: 0.03, bulge: 0.7 }));

  return {
    rig,
    parts: b.finish(),
    height: 2.15,
    headBone: 'spine.head',
    muzzleBone: 'arm.R.wrist',
    accentColor: NORDIC.accent,
    shieldRadius: 1.05,
    tuning: { runSpeed: 5.4, strideScale: 0.62, kneeSign: 1, bob: 0.045, sway: 0.03 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.18, multiplier: 2.2 },
      { region: 'body', bone: 'spine.chest', radius: 0.32, halfHeight: 0.2, multiplier: 1 },
      { region: 'body', bone: 'spine.hips', radius: 0.25, halfHeight: 0.14, multiplier: 1 },
      { region: 'limb', bone: 'arm.L.elbow', radius: 0.13, multiplier: 0.6 },
      { region: 'limb', bone: 'arm.R.elbow', radius: 0.13, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.L.knee', radius: 0.15, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.R.knee', radius: 0.15, multiplier: 0.6 },
      // The rune reactor between the shoulder blades — a back crit that rewards
      // flanking exactly the unit that hides behind cover.
      { region: 'critSpot', bone: 'spine.chest', offset: v(0, 0.02, 0.19), radius: 0.1, multiplier: 3 },
    ],
  };
}

/**
 * Huscarl — the elite shieldbearer. The widest ground silhouette in the
 * faction: antlers up top, a tower shield out front, and it advances behind a
 * deployed energy wall that genuinely stops bullets.
 */
function buildHuscarl(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  nordicMaterials(ctx);

  rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'], [0.3, 0.36, 0.16, 0.19, 0.22], {
    origin: v(0, 1.18, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.04, 0.07, 0.0, 0],
    capture: [0.4, 0.4, 0.4, 0.24, 0.32],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`leg.${s}`, ['hip', 'knee', 'ankle', 'toe'], [0.58, 0.55, 0.2, 0.13], {
      parent: 'spine.hips',
      origin: v(side * 0.2, -0.04, 0),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side,
      restBend: [0.08, -0.18, 1.66],
      capture: [0.3, 0.26, 0.22, 0.18],
    });
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.38, 0.35, 0.16], {
      parent: 'spine.chest',
      origin: v(side * 0.3, 0.07, 0),
      direction: v(side * 0.22, -1, 0).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.14, 0.36, 0.18],
      capture: [0.24, 0.2, 0.17],
    });
  }
  rig.chain('cloak', ['c0', 'c1', 'c2', 'c3'], [0.34, 0.3, 0.26, 0.16], {
    parent: 'spine.chest',
    origin: v(0, 0.1, 0.17),
    direction: v(0, -0.94, 0.34).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.36, 0.34, 0.3, 0.24],
  });

  const hips = at(ctx, 'spine.hips');
  const lumbar = at(ctx, 'spine.lumbar');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');

  b.add('iron', b.segment({ from: hips.clone().setY(hips.y - 0.12), to: lumbar, r0: 0.23, r1: 0.21, flatten: 0.76, sides: 12 }));
  b.add('iron', b.taperedLimb({ from: lumbar, to: chest, r0: 0.21, r1: 0.29, flatten: 0.68, muscle: 1.08, jointR: 0.24, sides: 13 }));
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.06), to: head, r0: 0.105, r1: 0.092, sides: 9 }));

  b.add('plate', b.plate({ centre: chest.clone().add(v(0, 0.02, -0.22)), normal: FORWARD, width: 0.62, height: 0.54, thickness: 0.05, curve: 1.25, taper: 0.8, color: 0xa7b4c0, edgeColor: 0x4b555f }));
  b.add('plate', b.plate({ centre: chest.clone().add(v(0, -0.02, 0.22)), normal: v(0, 0.05, 1), width: 0.56, height: 0.5, thickness: 0.042, curve: 1.1, taper: 0.9, color: 0x76828e, edgeColor: 0x333c45 }));
  b.add('rune', b.lens({ centre: chest.clone().add(v(0, 0.09, -0.248)), normal: FORWARD, radius: 0.058, bulge: 0.45 }));
  runeSeam(ctx, chest.clone().add(v(-0.18, 0.11, -0.24)), chest.clone().add(v(-0.18, -0.17, -0.23)), 0.014);
  runeSeam(ctx, chest.clone().add(v(0.18, 0.11, -0.24)), chest.clone().add(v(0.18, -0.17, -0.23)), 0.014);
  b.add('pelt', b.carapace({ centre: chest.clone().add(v(0, 0.16, 0.02)), radius: 0.34, height: 0.16, length: 1.5, ridges: 7, ridgeDepth: 0.06, direction: UP, color: 0x3c352d }));
  for (let i = 0; i < 6; i++) {
    const a = (i / 5 - 0.5) * 2.4;
    b.add('plate', b.plate({
      centre: hips.clone().add(v(Math.sin(a) * 0.24, -0.14, -Math.cos(a) * 0.24)),
      normal: v(Math.sin(a), -0.2, -Math.cos(a)).normalize(),
      width: 0.16,
      height: 0.28,
      thickness: 0.024,
      curve: 0.5,
      taper: 0.76,
      color: 0x8896a3,
      edgeColor: 0x3f4952,
    }));
  }

  // Antlered helm — a branching crown. This is the unit's signature read.
  b.add('plate', b.carapace({ centre: head.clone().add(v(0, -0.04, 0)), radius: 0.15, height: 0.26, length: 0.92, segments: 11, faceted: true, color: 0xa7b4c0, colorTip: 0x66727d }));
  b.add('iron', b.segment({ from: head.clone().add(v(0, -0.1, -0.01)), to: head.clone().add(v(0, 0.0, -0.07)), r0: 0.145, r1: 0.128, flatten: 0.9, sides: 10, faceted: true, color: 0x2f3740 }));
  b.add('rune', b.segment({ from: head.clone().add(v(-0.1, -0.02, -0.115)), to: head.clone().add(v(0.1, -0.02, -0.115)), r0: 0.014, r1: 0.014, sides: 5, steps: 3 }));
  for (const s of [-1, 1] as const) {
    antler(ctx, head.clone().add(v(s * 0.11, 0.08, 0.0)), v(s * 0.72, 0.66, 0.2), 1.0);
    b.add('plate', b.plate({ centre: head.clone().add(v(s * 0.135, -0.06, -0.02)), normal: v(s, 0, -0.2).normalize(), width: 0.1, height: 0.2, thickness: 0.016, curve: 0.6, taper: 0.7, color: 0x8896a3, edgeColor: 0x333c45 }));
  }
  braids(ctx, head, 5, 0.26);

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

    b.add('iron', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.1, r1: 0.075, jointR: 0.108, muscle: 1.24 }));
    b.add('iron', b.taperedLimb({ from: elbow, to: wrist, r0: 0.078, r1: 0.058, jointR: 0.084, muscle: 1.14 }));
    // Layered pauldron: two stacked plates read as articulated armour, one reads
    // as a shoulder pad.
    b.add('plate', b.plate({ centre: shoulder.clone().add(v(side * 0.07, 0.07, 0)), normal: v(side, 0.5, 0).normalize(), up: v(0, 0, -1), width: 0.4, height: 0.3, thickness: 0.04, curve: 1.6, taper: 0.68, color: 0xb3c0cc, edgeColor: 0x4b555f }));
    b.add('plate', b.plate({ centre: shoulder.clone().add(v(side * 0.09, -0.04, 0)), normal: v(side, 0.15, 0).normalize(), up: v(0, 0, -1), width: 0.34, height: 0.2, thickness: 0.03, curve: 1.5, taper: 0.8, color: 0x8896a3, edgeColor: 0x3f4952 }));
    b.add('plate', b.spine({ base: shoulder.clone().add(v(side * 0.2, 0.11, 0)), direction: v(side * 0.75, 0.62, 0).normalize(), length: 0.19, radius: 0.028, color: 0xa7b4c0 }));
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.058, r1: 0.045, flatten: 0.7, sides: 8 }));

    b.add('iron', b.taperedLimb({ from: hip, to: knee, r0: 0.145, r1: 0.108, jointR: 0.155, muscle: 1.24, flatten: 0.92 }));
    b.add('iron', b.taperedLimb({ from: knee, to: ankle, r0: 0.112, r1: 0.072, jointR: 0.118, muscle: 1.16, flatten: 0.9 }));
    b.add('plate', b.plate({ centre: knee.clone().add(v(0, 0.02, -0.1)), normal: FORWARD, width: 0.23, height: 0.24, thickness: 0.03, curve: 1.5, taper: 0.7, color: 0x8896a3, edgeColor: 0x3f4952 }));
    b.add('iron', b.segment({ from: ankle.clone().add(v(0, 0.01, 0.035)), to: toe, r0: 0.09, r1: 0.074, flatten: 0.78, sides: 8 }));
    b.add('iron', b.segment({ from: toe, to: toeTip, r0: 0.074, r1: 0.046, flatten: 0.72, sides: 7, faceted: true }));
  }

  // Tower shield on the left forearm: a slab that reads from any angle.
  const lWrist = at(ctx, 'arm.L.wrist');
  const shieldC = lWrist.clone().add(v(-0.06, 0.16, -0.16));
  b.add('plate', b.plate({ centre: shieldC, normal: v(-0.12, 0, -1).normalize(), width: 0.72, height: 1.15, thickness: 0.05, curve: 0.6, taper: 0.84, color: 0x8f9daa, edgeColor: 0x39424c }));
  b.add('iron', b.segment({ from: shieldC.clone().add(v(0, 0.56, 0.03)), to: shieldC.clone().add(v(0, -0.56, 0.03)), r0: 0.035, r1: 0.03, sides: 6, faceted: true, color: 0x2f3740 }));
  b.add('rune', b.lens({ centre: shieldC.clone().add(v(0, 0.06, -0.075)), normal: v(-0.12, 0, -1).normalize(), radius: 0.09, bulge: 0.4 }));
  runeSeam(ctx, shieldC.clone().add(v(-0.24, 0.42, -0.06)), shieldC.clone().add(v(-0.24, -0.42, -0.06)), 0.013);
  runeSeam(ctx, shieldC.clone().add(v(0.24, 0.42, -0.06)), shieldC.clone().add(v(0.24, -0.42, -0.06)), 0.013);
  for (const sy of [1, -1]) {
    b.add('frost', b.spine({ base: shieldC.clone().add(v(0, sy * 0.58, 0)), direction: v(0, sy, -0.15).normalize(), length: 0.14, radius: 0.024, color: 0xdff2ff }));
  }

  // Short broad axe in the right hand.
  const rHand = tip(ctx, 'arm.R');
  iceAxe(ctx, rHand.clone(), v(0.1, -0.35, -0.93), 1.05, false);

  return {
    rig,
    parts: b.finish(),
    height: 2.4,
    headBone: 'spine.head',
    muzzleBone: 'arm.R.wrist',
    accentColor: NORDIC.accent,
    shieldRadius: 1.3,
    tuning: { runSpeed: 5, strideScale: 0.56, kneeSign: 1, bob: 0.036, sway: 0.024, leanTurn: 0.12 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.21, multiplier: 2 },
      { region: 'body', bone: 'spine.chest', radius: 0.38, halfHeight: 0.24, multiplier: 1 },
      { region: 'body', bone: 'spine.hips', radius: 0.3, halfHeight: 0.16, multiplier: 1 },
      { region: 'limb', bone: 'arm.R.elbow', radius: 0.15, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.L.knee', radius: 0.17, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.R.knee', radius: 0.17, multiplier: 0.6 },
      // The shield-generator pack on the back: only reachable from behind, which
      // is the entire point of a unit that must be flanked.
      { region: 'critSpot', bone: 'spine.chest', offset: v(0, 0.04, 0.24), radius: 0.13, multiplier: 3.2 },
    ],
  };
}

/**
 * Seer — the floating rune-caster. Legless: a robe cone tapering to a point,
 * a spiked crown, three rune stones bobbing at its flanks. It teleports, it
 * wards its allies, and it channels a beam you break by taking cover.
 */
function buildSeer(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  nordicMaterials(ctx);

  rig.chain('spine', ['base', 'core', 'chest', 'neck', 'head'], [0.34, 0.36, 0.16, 0.18, 0.2], {
    origin: v(0, 0.42, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.04, 0.04, 0.0, 0],
    capture: [0.44, 0.4, 0.34, 0.2, 0.28],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.34, 0.32, 0.14], {
      parent: 'spine.chest',
      origin: v(side * 0.21, 0.06, 0),
      direction: v(side * 0.42, -0.9, -0.1).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.18, 0.5, 0.15],
      capture: [0.2, 0.17, 0.14],
    });
    // Robe ribbons: the only thing that tells you it is floating rather than
    // standing in a hole.
    rig.chain(`ribbon.${s}`, ['r0', 'r1', 'r2'], [0.26, 0.24, 0.16], {
      parent: 'spine.base',
      origin: v(side * 0.17, -0.06, 0.08),
      direction: v(side * 0.2, -0.92, 0.34).normalize(),
      pole: UP,
      kind: 'tail',
      capture: [0.2, 0.18, 0.15],
    });
    rig.chain(`rune.${s}`, ['s0', 's1'], [0.46, 0.12], {
      parent: 'spine.chest',
      origin: v(side * 0.12, 0.02, 0.02),
      direction: v(side * 0.94, 0.3, 0.14).normalize(),
      pole: UP,
      kind: 'tail',
      // A tiny capture on the stalk keeps the stone bound to its own tip bone
      // instead of being dragged by the chest.
      capture: [0.05, 0.18],
    });
  }
  rig.chain('rune.C', ['s0', 's1'], [0.5, 0.12], {
    parent: 'spine.chest',
    origin: v(0, 0.12, 0.06),
    direction: v(0, 0.62, 0.78).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.05, 0.18],
  });

  const base = at(ctx, 'spine.base');
  const core = at(ctx, 'spine.core');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');
  const headTop = tip(ctx, 'spine');

  // The robe: a flared bell from the waist down to a point below the body.
  b.add('iron', b.segment({ from: base.clone().add(v(0, 0.16, 0)), to: base.clone().add(v(0, -0.62, 0.02)), r0: 0.2, r1: 0.34, flatten: 0.88, bulge: 0.94, sides: 14, ridges: 8, ridgeDepth: 0.05, color: 0x36404b, colorTip: 0x1e252c }));
  b.add('iron', b.segment({ from: base.clone().add(v(0, -0.58, 0.02)), to: base.clone().add(v(0, -0.9, 0.06)), r0: 0.3, r1: 0.06, flatten: 0.9, sides: 12, color: 0x1e252c }));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    runeSeam(
      ctx,
      base.clone().add(v(Math.sin(a) * 0.21, 0.12, Math.cos(a) * 0.19)),
      base.clone().add(v(Math.sin(a) * 0.33, -0.5, Math.cos(a) * 0.3)),
      0.011,
    );
  }
  b.add('iron', b.taperedLimb({ from: base.clone().add(v(0, 0.1, 0)), to: core, r0: 0.2, r1: 0.19, flatten: 0.82, jointR: 0.2, muscle: 1.02, sides: 12 }));
  b.add('iron', b.taperedLimb({ from: core, to: chest, r0: 0.19, r1: 0.23, flatten: 0.72, jointR: 0.21, muscle: 1.05, sides: 12 }));
  b.add('plate', b.plate({ centre: chest.clone().add(v(0, 0.02, -0.18)), normal: FORWARD, width: 0.4, height: 0.38, thickness: 0.03, curve: 1.35, taper: 0.8, color: 0x9dabb8, edgeColor: 0x4b555f }));
  b.add('rune', b.lens({ centre: chest.clone().add(v(0, 0.03, -0.2)), normal: FORWARD, radius: 0.062, bulge: 0.55 }));

  // A high collar that frames the head, then a faceless mask.
  for (let i = 0; i < 5; i++) {
    const a = (i / 4 - 0.5) * 2.6;
    b.add('plate', b.plate({
      centre: neck.clone().add(v(Math.sin(a) * 0.19, 0.06, Math.cos(a) * 0.16)),
      normal: v(Math.sin(a), 0.34, Math.cos(a)).normalize(),
      width: 0.15,
      height: 0.3,
      thickness: 0.018,
      curve: 0.55,
      taper: 0.55,
      color: 0xa7b4c0,
      edgeColor: 0x3f4952,
    }));
  }
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.02), to: head, r0: 0.075, r1: 0.07, sides: 8 }));
  b.add('iron', b.carapace({ centre: head.clone().add(v(0, -0.04, 0.01)), radius: 0.115, height: 0.22, length: 0.82, segments: 11, color: 0x2f3740 }));
  b.add('plate', b.plate({ centre: head.clone().add(v(0, -0.01, -0.098)), normal: v(0, 0.06, -1).normalize(), width: 0.17, height: 0.24, thickness: 0.018, curve: 1.35, taper: 0.72, color: 0xb3c0cc, edgeColor: 0x4b555f }));
  b.add('rune', b.segment({ from: head.clone().add(v(-0.07, 0.0, -0.115)), to: head.clone().add(v(0.07, 0.0, -0.115)), r0: 0.014, r1: 0.014, sides: 5, steps: 3 }));
  // Crown of thin spikes — a fan against the sky, unmistakable at range.
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.5;
    b.add('plate', b.spine({
      base: head.clone().add(v(Math.sin(a) * 0.1, 0.06, Math.cos(a) * 0.09 + 0.01)),
      direction: v(Math.sin(a) * 0.42, 1, Math.cos(a) * 0.34).normalize(),
      length: 0.24 - Math.abs(a) * 0.05,
      radius: 0.017,
      sharpness: 1.5,
      color: 0xa7b4c0,
      colorTip: 0x39424c,
    }));
  }
  b.add('rune', b.lens({ centre: headTop.clone().add(v(0, -0.02, 0)), normal: UP, radius: 0.028, bulge: 0.8 }));

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    const shoulder = at(ctx, `arm.${s}.shoulder`);
    const elbow = at(ctx, `arm.${s}.elbow`);
    const wrist = at(ctx, `arm.${s}.wrist`);
    const hand = tip(ctx, `arm.${s}`);
    b.add('iron', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.062, r1: 0.05, jointR: 0.07, muscle: 1.15 }));
    b.add('skin', b.taperedLimb({ from: elbow, to: wrist, r0: 0.048, r1: 0.036, jointR: 0.052, muscle: 1.08 }));
    b.add('plate', b.plate({ centre: shoulder.clone().add(v(side * 0.05, 0.04, 0)), normal: v(side, 0.5, 0).normalize(), up: v(0, 0, -1), width: 0.24, height: 0.22, thickness: 0.024, curve: 1.5, taper: 0.6, color: 0xa7b4c0, edgeColor: 0x4b555f }));
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.038, r1: 0.03, flatten: 0.7, sides: 7 }));
    for (let d = 0; d < 3; d++) {
      b.add('skin', b.digit({
        base: hand.clone().add(v(side * (d - 1) * 0.017, 0.003, -0.008)),
        direction: v(side * (d - 1) * 0.3, -0.6, -0.75).normalize(),
        length: 0.08,
        radius: 0.009,
        joints: 3,
        curl: 0.35,
      }));
    }
    // Robe ribbon geometry.
    const rb = [`ribbon.${s}.r0`, `ribbon.${s}.r1`, `ribbon.${s}.r2`];
    for (let i = 0; i < rb.length - 1; i++) {
      b.add('iron', b.segment({ from: at(ctx, rb[i]), to: at(ctx, rb[i + 1]), r0: 0.07 - i * 0.015, r1: 0.055 - i * 0.015, flatten: 0.35, sides: 6, color: 0x2a323a }));
    }
  }

  // The three rune stones: faceted shards with a glowing core.
  for (const id of ['rune.L', 'rune.R', 'rune.C']) {
    const stone = at(ctx, `${id}.s1`);
    b.add('plate', b.carapace({ centre: stone.clone().add(v(0, -0.045, 0)), radius: 0.075, height: 0.13, length: 0.85, segments: 6, faceted: true, color: 0x8896a3, colorTip: 0x39424c }));
    b.add('plate', b.carapace({ centre: stone.clone().add(v(0, 0.045, 0)), radius: 0.075, height: 0.13, length: 0.85, segments: 6, faceted: true, direction: DOWN, color: 0x8896a3, colorTip: 0x39424c }));
    b.add('rune', b.lens({ centre: stone.clone().add(v(0, 0, -0.05)), normal: FORWARD, radius: 0.032, bulge: 0.8 }));
    b.add('rune', b.lens({ centre: stone.clone().add(v(0, 0, 0.05)), normal: v(0, 0, 1), radius: 0.032, bulge: 0.8 }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 2.1,
    headBone: 'spine.head',
    muzzleBone: 'spine.chest',
    accentColor: NORDIC.accent,
    shieldRadius: 1.15,
    tuning: { standHeight: 0.42, breathRate: 0.4, breathAmount: 0.05, leanTurn: 0.22, sway: 0.02, bob: 0 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.17, multiplier: 2.4 },
      { region: 'body', bone: 'spine.chest', radius: 0.28, halfHeight: 0.18, multiplier: 1 },
      { region: 'body', bone: 'spine.core', radius: 0.24, halfHeight: 0.18, multiplier: 1 },
      { region: 'body', bone: 'spine.base', radius: 0.26, halfHeight: 0.2, multiplier: 0.8 },
      // Shoot the stones: the ward and the beam both run through them.
      { region: 'critSpot', bone: 'rune.L.s1', radius: 0.11, multiplier: 3 },
      { region: 'critSpot', bone: 'rune.R.s1', radius: 0.11, multiplier: 3 },
      { region: 'critSpot', bone: 'rune.C.s1', radius: 0.11, multiplier: 3 },
    ],
  };
}

/**
 * Jarl — the champion. Nearly three metres of layered plate, a crowned helm,
 * an ice beard, and a two-handed hammer that widens the silhouette by a third.
 * Slams the ground and leaves a freezing field behind.
 */
function buildJarl(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  nordicMaterials(ctx);

  rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'], [0.38, 0.44, 0.19, 0.22, 0.26], {
    origin: v(0, 1.42, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.05, 0.09, -0.02, 0],
    capture: [0.48, 0.48, 0.48, 0.28, 0.38],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`leg.${s}`, ['hip', 'knee', 'ankle', 'toe'], [0.7, 0.66, 0.24, 0.15], {
      parent: 'spine.hips',
      origin: v(side * 0.26, -0.05, 0),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side,
      restBend: [0.09, -0.2, 1.66],
      capture: [0.36, 0.31, 0.26, 0.21],
    });
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.46, 0.42, 0.19], {
      parent: 'spine.chest',
      origin: v(side * 0.37, 0.08, 0),
      direction: v(side * 0.24, -1, 0).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.16, 0.38, 0.18],
      capture: [0.3, 0.25, 0.2],
    });
  }
  rig.chain('cloak', ['c0', 'c1', 'c2', 'c3'], [0.44, 0.4, 0.34, 0.2], {
    parent: 'spine.chest',
    origin: v(0, 0.12, 0.22),
    direction: v(0, -0.95, 0.3).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.46, 0.44, 0.4, 0.32],
  });
  rig.chain('beard', ['b0', 'b1', 'b2'], [0.16, 0.14, 0.1], {
    parent: 'spine.head',
    origin: v(0, -0.1, -0.06),
    direction: v(0, -0.94, -0.34).normalize(),
    pole: FORWARD,
    kind: 'tail',
    capture: [0.14, 0.13, 0.11],
  });

  const hips = at(ctx, 'spine.hips');
  const lumbar = at(ctx, 'spine.lumbar');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');

  b.add('iron', b.segment({ from: hips.clone().setY(hips.y - 0.15), to: lumbar, r0: 0.29, r1: 0.27, flatten: 0.76, sides: 13 }));
  b.add('iron', b.taperedLimb({ from: lumbar, to: chest, r0: 0.27, r1: 0.38, flatten: 0.66, muscle: 1.1, jointR: 0.3, sides: 14 }));
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.07), to: head, r0: 0.125, r1: 0.108, sides: 10 }));

  b.add('plate', b.plate({ centre: chest.clone().add(v(0, 0.03, -0.29)), normal: FORWARD, width: 0.82, height: 0.66, thickness: 0.062, curve: 1.2, taper: 0.78, color: 0xb3c0cc, edgeColor: 0x4b555f }));
  b.add('plate', b.plate({ centre: chest.clone().add(v(0, -0.02, 0.29)), normal: v(0, 0.05, 1), width: 0.74, height: 0.6, thickness: 0.05, curve: 1.1, taper: 0.88, color: 0x76828e, edgeColor: 0x2f3740 }));
  b.add('rune', b.lens({ centre: chest.clone().add(v(0, 0.13, -0.325)), normal: FORWARD, radius: 0.075, bulge: 0.45 }));
  runeSeam(ctx, chest.clone().add(v(-0.24, 0.16, -0.32)), chest.clone().add(v(-0.24, -0.22, -0.3)), 0.016);
  runeSeam(ctx, chest.clone().add(v(0.24, 0.16, -0.32)), chest.clone().add(v(0.24, -0.22, -0.3)), 0.016);
  b.add('pelt', b.carapace({ centre: chest.clone().add(v(0, 0.2, 0.02)), radius: 0.46, height: 0.2, length: 1.55, ridges: 8, ridgeDepth: 0.07, direction: UP, color: 0x322c25 }));
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.6;
    b.add('plate', b.plate({
      centre: hips.clone().add(v(Math.sin(a) * 0.3, -0.18, -Math.cos(a) * 0.3)),
      normal: v(Math.sin(a), -0.22, -Math.cos(a)).normalize(),
      width: 0.19,
      height: 0.36,
      thickness: 0.03,
      curve: 0.48,
      taper: 0.74,
      color: 0x8896a3,
      edgeColor: 0x3f4952,
    }));
  }

  // Crowned helm: a ring of blades over the brow, no antlers — that is the
  // Huscarl's read and these two must never be confused at distance.
  b.add('plate', b.carapace({ centre: head.clone().add(v(0, -0.05, 0)), radius: 0.18, height: 0.3, length: 0.94, segments: 12, faceted: true, color: 0xb3c0cc, colorTip: 0x66727d }));
  b.add('iron', b.segment({ from: head.clone().add(v(0, -0.13, -0.01)), to: head.clone().add(v(0, 0.0, -0.08)), r0: 0.17, r1: 0.15, flatten: 0.9, sides: 10, faceted: true, color: 0x2a323a }));
  b.add('rune', b.segment({ from: head.clone().add(v(-0.12, -0.02, -0.14)), to: head.clone().add(v(0.12, -0.02, -0.14)), r0: 0.016, r1: 0.016, sides: 5, steps: 3 }));
  for (let i = 0; i < 9; i++) {
    const a = (i / 8 - 0.5) * 3.1;
    b.add('plate', b.spine({
      base: head.clone().add(v(Math.sin(a) * 0.17, 0.05, Math.cos(a) * 0.15)),
      direction: v(Math.sin(a) * 0.5, 1, Math.cos(a) * 0.42).normalize(),
      length: 0.2 + Math.cos(a) * 0.08,
      radius: 0.024,
      sharpness: 1.4,
      color: 0xb3c0cc,
      colorTip: 0x39424c,
    }));
  }
  for (const s of [-1, 1] as const) {
    helmHorn(ctx, head.clone().add(v(s * 0.16, -0.01, 0.02)), v(s * 0.86, 0.34, 0.38), 0.44, 0.045, 0.12);
  }
  // Ice beard: crystalline shards, not hair.
  const bd = ['beard.b0', 'beard.b1', 'beard.b2'];
  for (let i = 0; i < bd.length - 1; i++) {
    b.add('frost', b.segment({ from: at(ctx, bd[i]), to: at(ctx, bd[i + 1]), r0: 0.1 - i * 0.025, r1: 0.08 - i * 0.025, flatten: 0.6, sides: 7, faceted: true, color: 0xbfe0f5 }));
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

    b.add('iron', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.125, r1: 0.095, jointR: 0.135, muscle: 1.26 }));
    b.add('iron', b.taperedLimb({ from: elbow, to: wrist, r0: 0.098, r1: 0.072, jointR: 0.105, muscle: 1.16 }));
    b.add('plate', b.plate({ centre: shoulder.clone().add(v(side * 0.09, 0.09, 0)), normal: v(side, 0.52, 0).normalize(), up: v(0, 0, -1), width: 0.52, height: 0.38, thickness: 0.05, curve: 1.6, taper: 0.66, color: 0xbcc8d3, edgeColor: 0x4b555f }));
    b.add('plate', b.plate({ centre: shoulder.clone().add(v(side * 0.11, -0.06, 0)), normal: v(side, 0.14, 0).normalize(), up: v(0, 0, -1), width: 0.44, height: 0.26, thickness: 0.04, curve: 1.5, taper: 0.8, color: 0x8896a3, edgeColor: 0x3f4952 }));
    for (let k = 0; k < 3; k++) {
      b.add('frost', b.spine({
        base: shoulder.clone().add(v(side * (0.2 + k * 0.02), 0.14 - k * 0.06, (k - 1) * 0.12)),
        direction: v(side * 0.7, 0.68, (k - 1) * 0.25).normalize(),
        length: 0.26 - k * 0.04,
        radius: 0.03,
        color: 0xdff2ff,
      }));
    }
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.072, r1: 0.056, flatten: 0.7, sides: 8 }));

    b.add('iron', b.taperedLimb({ from: hip, to: knee, r0: 0.175, r1: 0.132, jointR: 0.188, muscle: 1.26, flatten: 0.92 }));
    b.add('iron', b.taperedLimb({ from: knee, to: ankle, r0: 0.138, r1: 0.088, jointR: 0.145, muscle: 1.18, flatten: 0.9 }));
    b.add('plate', b.plate({ centre: knee.clone().add(v(0, 0.02, -0.13)), normal: FORWARD, width: 0.3, height: 0.3, thickness: 0.036, curve: 1.5, taper: 0.68, color: 0x8896a3, edgeColor: 0x3f4952 }));
    b.add('iron', b.segment({ from: ankle.clone().add(v(0, 0.01, 0.045)), to: toe, r0: 0.11, r1: 0.09, flatten: 0.78, sides: 8 }));
    b.add('iron', b.segment({ from: toe, to: toeTip, r0: 0.09, r1: 0.056, flatten: 0.72, sides: 7, faceted: true }));
  }

  // Two-handed frost hammer on the right hard-point.
  const rHand = tip(ctx, 'arm.R');
  const hDir = v(0.06, -0.2, -0.98).normalize();
  const haftA = rHand.clone().addScaledVector(hDir, -0.34);
  const haftB = rHand.clone().addScaledVector(hDir, 1.02);
  b.add('iron', b.segment({ from: haftA, to: haftB, r0: 0.042, r1: 0.036, sides: 7, faceted: true, color: 0x2a323a }));
  b.add('pelt', b.segment({ from: rHand.clone().addScaledVector(hDir, -0.16), to: rHand.clone().addScaledVector(hDir, 0.16), r0: 0.052, r1: 0.05, sides: 8 }));
  {
    const headC = rHand.clone().addScaledVector(hDir, 0.92);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromUnitVectors(v(0, 1, 0), v(1, 0, 0));
    m.makeRotationFromQuaternion(q).setPosition(headC);
    b.add('plate', bevelBox(v(0.5, 0.34, 0.34), 0.06, 0xa7b4c0), m);
    b.add('frost', b.plate({ centre: headC.clone().add(v(0, 0, -0.18)), normal: FORWARD, width: 0.3, height: 0.3, thickness: 0.03, curve: 0.35, taper: 0.9, color: 0xdff2ff, edgeColor: 0x87b8d6 }));
    b.add('rune', b.lens({ centre: headC.clone().add(v(0.26, 0, 0)), normal: v(1, 0, 0), radius: 0.075, bulge: 0.5 }));
    b.add('rune', b.lens({ centre: headC.clone().add(v(-0.26, 0, 0)), normal: v(-1, 0, 0), radius: 0.075, bulge: 0.5 }));
    b.add('frost', b.spine({ base: haftB.clone(), direction: hDir, length: 0.22, radius: 0.034, color: 0xdff2ff }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 2.9,
    headBone: 'spine.head',
    muzzleBone: 'arm.R.wrist',
    accentColor: NORDIC.accent,
    shieldRadius: 1.6,
    tuning: { runSpeed: 4.8, strideScale: 0.5, kneeSign: 1, bob: 0.03, sway: 0.02, leanTurn: 0.1, breathRate: 0.4 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.26, multiplier: 2 },
      { region: 'body', bone: 'spine.chest', radius: 0.46, halfHeight: 0.3, multiplier: 1 },
      { region: 'body', bone: 'spine.hips', radius: 0.36, halfHeight: 0.2, multiplier: 1 },
      { region: 'limb', bone: 'arm.L.elbow', radius: 0.2, multiplier: 0.55 },
      { region: 'limb', bone: 'arm.R.elbow', radius: 0.2, multiplier: 0.55 },
      { region: 'limb', bone: 'leg.L.knee', radius: 0.22, multiplier: 0.55 },
      { region: 'limb', bone: 'leg.R.knee', radius: 0.22, multiplier: 0.55 },
      { region: 'critSpot', bone: 'spine.lumbar', offset: v(0, 0.14, 0.3), radius: 0.16, multiplier: 3 },
    ],
  };
}

/**
 * The Allfather — the boss. Six metres, caped, crowned with a three-metre
 * antler rack, carrying a hammer the size of the Thrall. Four rune pylons ride
 * the spine of its back plate: those are the weak points, and they only open
 * after a slam.
 */
function buildAllfather(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  nordicMaterials(ctx);

  rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'], [0.8, 0.92, 0.4, 0.46, 0.54], {
    origin: v(0, 3.0, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.06, 0.11, -0.03, 0],
    capture: [1.0, 1.0, 1.0, 0.6, 0.8],
  });
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`leg.${s}`, ['hip', 'knee', 'ankle', 'toe'], [1.45, 1.38, 0.5, 0.32], {
      parent: 'spine.hips',
      origin: v(side * 0.52, -0.1, 0),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side,
      restBend: [0.09, -0.2, 1.66],
      capture: [0.74, 0.64, 0.54, 0.44],
    });
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.95, 0.88, 0.4], {
      parent: 'spine.chest',
      origin: v(side * 0.76, 0.16, 0),
      direction: v(side * 0.24, -1, 0).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.16, 0.36, 0.18],
      capture: [0.62, 0.52, 0.42],
    });
    rig.chain(`cape.${s}`, ['c0', 'c1', 'c2', 'c3'], [0.9, 0.84, 0.7, 0.4], {
      parent: 'spine.chest',
      origin: v(side * 0.4, 0.22, 0.4),
      direction: v(side * 0.16, -0.96, 0.24).normalize(),
      pole: UP,
      kind: 'tail',
      capture: [0.92, 0.88, 0.8, 0.64],
    });
  }
  rig.chain('beard', ['b0', 'b1', 'b2', 'b3'], [0.34, 0.3, 0.26, 0.18], {
    parent: 'spine.head',
    origin: v(0, -0.22, -0.12),
    direction: v(0, -0.94, -0.34).normalize(),
    pole: FORWARD,
    kind: 'tail',
    capture: [0.3, 0.28, 0.24, 0.2],
  });

  const hips = at(ctx, 'spine.hips');
  const lumbar = at(ctx, 'spine.lumbar');
  const chest = at(ctx, 'spine.chest');
  const neck = at(ctx, 'spine.neck');
  const head = at(ctx, 'spine.head');

  b.add('iron', b.segment({ from: hips.clone().setY(hips.y - 0.32), to: lumbar, r0: 0.6, r1: 0.56, flatten: 0.76, sides: 14 }));
  b.add('iron', b.taperedLimb({ from: lumbar, to: chest, r0: 0.56, r1: 0.8, flatten: 0.64, muscle: 1.12, jointR: 0.62, sides: 16 }));
  b.add('skin', b.segment({ from: neck.clone().setY(neck.y - 0.14), to: head, r0: 0.26, r1: 0.22, sides: 11 }));

  b.add('plate', b.plate({ centre: chest.clone().add(v(0, 0.06, -0.62)), normal: FORWARD, width: 1.72, height: 1.38, thickness: 0.13, curve: 1.18, taper: 0.76, color: 0xbcc8d3, edgeColor: 0x4b555f }));
  b.add('plate', b.plate({ centre: chest.clone().add(v(0, -0.02, 0.62)), normal: v(0, 0.05, 1), width: 1.56, height: 1.26, thickness: 0.1, curve: 1.08, taper: 0.86, color: 0x6d7985, edgeColor: 0x2a323a }));
  b.add('rune', b.lens({ centre: chest.clone().add(v(0, 0.3, -0.7)), normal: FORWARD, radius: 0.17, bulge: 0.45 }));
  runeSeam(ctx, chest.clone().add(v(-0.52, 0.36, -0.68)), chest.clone().add(v(-0.52, -0.46, -0.64)), 0.032);
  runeSeam(ctx, chest.clone().add(v(0.52, 0.36, -0.68)), chest.clone().add(v(0.52, -0.46, -0.64)), 0.032);
  b.add('pelt', b.carapace({ centre: chest.clone().add(v(0, 0.42, 0.04)), radius: 1.0, height: 0.42, length: 1.5, ridges: 9, ridgeDepth: 0.09, direction: UP, color: 0x2c2721 }));

  // The four rune pylons: iron sockets on the back plate with a bright core.
  // They are the boss's crit spots, so they are placed to be unmistakable.
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const p = chest.clone().lerp(lumbar, t * 0.85).add(v(0, 0, 0.62));
    b.add('iron', b.segment({ from: p.clone(), to: p.clone().add(v(0, 0, 0.26)), r0: 0.19, r1: 0.15, sides: 8, faceted: true, color: 0x232a31 }));
    b.add('rune', b.lens({ centre: p.clone().add(v(0, 0, 0.27)), normal: v(0, 0.05, 1), radius: 0.115, bulge: 0.8 }));
    b.add('plate', b.spine({ base: p.clone().add(v(0, 0.16, 0.14)), direction: v(0, 0.86, 0.5).normalize(), length: 0.3, radius: 0.05, color: 0x8896a3 }));
  }

  for (let i = 0; i < 9; i++) {
    const a = (i / 8 - 0.5) * 2.7;
    b.add('plate', b.plate({
      centre: hips.clone().add(v(Math.sin(a) * 0.62, -0.36, -Math.cos(a) * 0.62)),
      normal: v(Math.sin(a), -0.24, -Math.cos(a)).normalize(),
      width: 0.38,
      height: 0.78,
      thickness: 0.06,
      curve: 0.46,
      taper: 0.72,
      color: 0x8896a3,
      edgeColor: 0x3f4952,
    }));
  }

  // Crown: two big antler racks plus a ring of blades. Three metres across.
  b.add('plate', b.carapace({ centre: head.clone().add(v(0, -0.1, 0)), radius: 0.37, height: 0.62, length: 0.94, segments: 13, faceted: true, color: 0xbcc8d3, colorTip: 0x66727d }));
  b.add('iron', b.segment({ from: head.clone().add(v(0, -0.28, -0.02)), to: head.clone().add(v(0, 0.0, -0.16)), r0: 0.35, r1: 0.31, flatten: 0.9, sides: 11, faceted: true, color: 0x232a31 }));
  b.add('rune', b.segment({ from: head.clone().add(v(-0.24, -0.04, -0.3)), to: head.clone().add(v(0.24, -0.04, -0.3)), r0: 0.034, r1: 0.034, sides: 6, steps: 3 }));
  b.add('rune', b.lens({ centre: head.clone().add(v(-0.13, -0.03, -0.31)), normal: v(-0.3, 0, -1).normalize(), radius: 0.06, bulge: 0.7 }));
  b.add('rune', b.lens({ centre: head.clone().add(v(0.13, -0.03, -0.31)), normal: v(0.3, 0, -1).normalize(), radius: 0.06, bulge: 0.7 }));
  for (const s of [-1, 1] as const) {
    antler(ctx, head.clone().add(v(s * 0.28, 0.2, 0.02)), v(s * 0.82, 0.56, 0.12), 2.5);
    antler(ctx, head.clone().add(v(s * 0.22, 0.12, 0.2)), v(s * 0.62, 0.72, 0.32), 1.7);
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.2;
    b.add('plate', b.spine({
      base: head.clone().add(v(Math.sin(a) * 0.3, 0.06, Math.cos(a) * 0.26 - 0.06)),
      direction: v(Math.sin(a) * 0.42, 1, Math.cos(a) * 0.3 - 0.12).normalize(),
      length: 0.42,
      radius: 0.045,
      sharpness: 1.4,
      color: 0xbcc8d3,
      colorTip: 0x39424c,
    }));
  }
  const bd = ['beard.b0', 'beard.b1', 'beard.b2', 'beard.b3'];
  for (let i = 0; i < bd.length - 1; i++) {
    b.add('frost', b.segment({ from: at(ctx, bd[i]), to: at(ctx, bd[i + 1]), r0: 0.22 - i * 0.05, r1: 0.17 - i * 0.05, flatten: 0.6, sides: 8, faceted: true, color: 0xbfe0f5 }));
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

    b.add('iron', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.26, r1: 0.2, jointR: 0.28, muscle: 1.26 }));
    b.add('iron', b.taperedLimb({ from: elbow, to: wrist, r0: 0.2, r1: 0.15, jointR: 0.215, muscle: 1.16 }));
    b.add('plate', b.plate({ centre: shoulder.clone().add(v(side * 0.18, 0.2, 0)), normal: v(side, 0.5, 0).normalize(), up: v(0, 0, -1), width: 1.06, height: 0.78, thickness: 0.1, curve: 1.6, taper: 0.64, color: 0xc4d0da, edgeColor: 0x4b555f }));
    b.add('plate', b.plate({ centre: shoulder.clone().add(v(side * 0.22, -0.12, 0)), normal: v(side, 0.14, 0).normalize(), up: v(0, 0, -1), width: 0.9, height: 0.54, thickness: 0.08, curve: 1.5, taper: 0.8, color: 0x8896a3, edgeColor: 0x3f4952 }));
    for (let k = 0; k < 4; k++) {
      b.add('frost', b.spine({
        base: shoulder.clone().add(v(side * (0.44 + k * 0.02), 0.3 - k * 0.11, (k - 1.5) * 0.24)),
        direction: v(side * 0.66, 0.72, (k - 1.5) * 0.22).normalize(),
        length: 0.56 - k * 0.06,
        radius: 0.06,
        color: 0xdff2ff,
      }));
    }
    b.add('skin', b.segment({ from: wrist, to: hand, r0: 0.15, r1: 0.115, flatten: 0.7, sides: 9 }));

    b.add('iron', b.taperedLimb({ from: hip, to: knee, r0: 0.36, r1: 0.27, jointR: 0.39, muscle: 1.26, flatten: 0.92 }));
    b.add('iron', b.taperedLimb({ from: knee, to: ankle, r0: 0.28, r1: 0.18, jointR: 0.3, muscle: 1.18, flatten: 0.9 }));
    b.add('plate', b.plate({ centre: knee.clone().add(v(0, 0.04, -0.27)), normal: FORWARD, width: 0.62, height: 0.62, thickness: 0.075, curve: 1.5, taper: 0.68, color: 0x8896a3, edgeColor: 0x3f4952 }));
    b.add('iron', b.segment({ from: ankle.clone().add(v(0, 0.02, 0.09)), to: toe, r0: 0.23, r1: 0.19, flatten: 0.78, sides: 9 }));
    b.add('iron', b.segment({ from: toe, to: toeTip, r0: 0.19, r1: 0.115, flatten: 0.72, sides: 8, faceted: true }));
    // Cape geometry: broad flattened lofts, not tubes.
    const cp = [`cape.${s}.c0`, `cape.${s}.c1`, `cape.${s}.c2`, `cape.${s}.c3`];
    for (let i = 0; i < cp.length - 1; i++) {
      b.add('pelt', b.segment({ from: at(ctx, cp[i]), to: at(ctx, cp[i + 1]), r0: 0.56 - i * 0.05, r1: 0.5 - i * 0.06, flatten: 0.24, sides: 7, color: 0x2c2721 }));
    }
  }

  // The hammer: a two-metre haft and a head a metre across.
  const rHand = tip(ctx, 'arm.R');
  const hDir = v(0.05, -0.16, -0.99).normalize();
  const haftA = rHand.clone().addScaledVector(hDir, -0.72);
  const haftB = rHand.clone().addScaledVector(hDir, 2.1);
  b.add('iron', b.segment({ from: haftA, to: haftB, r0: 0.095, r1: 0.08, sides: 8, faceted: true, color: 0x232a31 }));
  b.add('pelt', b.segment({ from: rHand.clone().addScaledVector(hDir, -0.34), to: rHand.clone().addScaledVector(hDir, 0.34), r0: 0.115, r1: 0.11, sides: 8 }));
  {
    const headC = rHand.clone().addScaledVector(hDir, 1.9);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromUnitVectors(v(0, 1, 0), v(1, 0, 0));
    m.makeRotationFromQuaternion(q).setPosition(headC);
    b.add('plate', bevelBox(v(1.15, 0.74, 0.74), 0.14, 0xb3c0cc), m);
    b.add('frost', b.plate({ centre: headC.clone().add(v(0, 0, -0.39)), normal: FORWARD, width: 0.66, height: 0.66, thickness: 0.06, curve: 0.3, taper: 0.9, color: 0xdff2ff, edgeColor: 0x87b8d6 }));
    for (const sx of [-1, 1]) {
      b.add('rune', b.lens({ centre: headC.clone().add(v(sx * 0.6, 0, 0)), normal: v(sx, 0, 0), radius: 0.17, bulge: 0.5 }));
    }
    b.add('frost', b.spine({ base: haftB.clone(), direction: hDir, length: 0.5, radius: 0.075, color: 0xdff2ff }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 6.0,
    headBone: 'spine.head',
    muzzleBone: 'arm.R.wrist',
    accentColor: NORDIC.accent,
    shieldRadius: 3.2,
    tuning: { runSpeed: 4.2, strideScale: 0.42, kneeSign: 1, bob: 0.024, sway: 0.016, leanTurn: 0.07, breathRate: 0.28, breathAmount: 0.05 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.52, multiplier: 1.6 },
      { region: 'body', bone: 'spine.chest', radius: 0.95, halfHeight: 0.6, multiplier: 1 },
      { region: 'body', bone: 'spine.lumbar', radius: 0.8, halfHeight: 0.5, multiplier: 1 },
      { region: 'body', bone: 'spine.hips', radius: 0.7, halfHeight: 0.4, multiplier: 1 },
      { region: 'limb', bone: 'arm.L.elbow', radius: 0.4, multiplier: 0.5 },
      { region: 'limb', bone: 'arm.R.elbow', radius: 0.4, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.L.knee', radius: 0.46, multiplier: 0.5 },
      { region: 'limb', bone: 'leg.R.knee', radius: 0.46, multiplier: 0.5 },
      // Four rune pylons down the back plate. `NordicRuntime` enables/disables
      // their extra damage through the boss's `pylonOpen` blackboard value.
      { region: 'critSpot', bone: 'spine.chest', offset: v(0, 0.05, 0.86), radius: 0.3, multiplier: 4 },
      { region: 'critSpot', bone: 'spine.chest', offset: v(0, -0.3, 0.84), radius: 0.28, multiplier: 4 },
      { region: 'critSpot', bone: 'spine.lumbar', offset: v(0, 0.28, 0.8), radius: 0.28, multiplier: 4 },
      { region: 'critSpot', bone: 'spine.lumbar', offset: v(0, -0.1, 0.76), radius: 0.26, multiplier: 4 },
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

/** `BvhCollisionWorld` exposes proxy registration; a stub world may not. */
function proxyHost(world: CollisionWorld | null): ProxyHostLike | null {
  const h = world as unknown as Partial<ProxyHostLike> | null;
  return h && typeof h.addProxy === 'function' && typeof h.removeProxiesFor === 'function'
    ? (h as ProxyHostLike)
    : null;
}

/** Entity ids for the non-agent damageables this module owns (walls, fields). */
let nextPropId = 620000;

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();

/**
 * A deployable shield wall. It is a real obstruction: three capsule hit proxies
 * across its face are registered with the collision world, so `raycastAll`
 * stops the player's rounds in the wall and they damage *it* instead of the
 * Huscarl behind it. Break it or flank it — those are the only two answers,
 * which is exactly the decision the unit is supposed to force.
 */
class ShieldWall implements Damageable {
  readonly entityId = nextPropId++;
  health = 900;
  maxHealth = 900;
  shield = 0;
  maxShield = 0;
  readonly group = new THREE.Group();
  /** Set while deployed; a broken wall goes dormant until it recharges. */
  active = false;
  breakTimer = 0;

  private proxies: HitProxy[] = [];
  private host: ProxyHostLike | null = null;
  private vfx: VfxSystem;
  private pane: THREE.Mesh;
  private lattice: THREE.Mesh;
  private frame: THREE.Mesh;
  private paneMat: THREE.MeshBasicMaterial;
  private latticeMat: THREE.Material;
  private frameMat: THREE.Material;
  private flash = 0;

  constructor(vfx: VfxSystem, width: number, height: number) {
    this.vfx = vfx;
    const mats = vfx.materials;
    this.frameMat = mats.get('nordicIronwork');
    this.latticeMat = mats.emissive(NORDIC.rune, 3.6);
    this.paneMat = mats.additive(NORDIC.rune, 0.16);
    this.paneMat.depthWrite = false;
    this.paneMat.side = THREE.DoubleSide;

    // A shallow cylinder section: a curved pane reads as a projected field,
    // a flat quad reads as a decal.
    const paneGeo = new THREE.CylinderGeometry(2.6, 2.6, height, 20, 1, true, -width / 5.2, width / 2.6);
    this.pane = new THREE.Mesh(paneGeo, this.paneMat);
    this.pane.position.z = -2.6;
    this.pane.renderOrder = 5;
    this.pane.frustumCulled = false;
    this.group.add(this.pane);

    const bars: THREE.BufferGeometry[] = [];
    const bar = (w: number, h: number, x: number, y: number): void => {
      const g = new THREE.BoxGeometry(w, h, 0.035);
      g.translate(x, y, 0.02);
      bars.push(g);
    };
    for (let i = 0; i <= 6; i++) bar(0.035, height, (i / 6 - 0.5) * width, 0);
    for (let i = 0; i <= 4; i++) bar(width, 0.03, 0, (i / 4 - 0.5) * height);
    const latticeGeo = mergeSimple(bars);
    this.lattice = new THREE.Mesh(latticeGeo, this.latticeMat);
    this.lattice.frustumCulled = false;
    this.group.add(this.lattice);

    const posts: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.13, height + 0.16, 0.16);
      g.translate((sx * width) / 2, 0, 0);
      posts.push(g);
    }
    {
      const g = new THREE.BoxGeometry(width + 0.13, 0.14, 0.16);
      g.translate(0, height / 2, 0);
      posts.push(g);
      const g2 = new THREE.BoxGeometry(width + 0.13, 0.14, 0.16);
      g2.translate(0, -height / 2, 0);
      posts.push(g2);
    }
    this.frame = new THREE.Mesh(mergeSimple(posts), this.frameMat);
    this.frame.castShadow = true;
    this.frame.frustumCulled = false;
    this.group.add(this.frame);

    this.group.visible = false;
    const n = 3;
    for (let i = 0; i < n; i++) {
      this.proxies.push({
        damageable: this,
        region: 'body',
        offset: new THREE.Vector3(((i / (n - 1)) - 0.5) * width, 0, 0),
        radius: width / (n * 1.35),
        halfHeight: height * 0.42,
        // A shield eats damage rather than taking it whole: the wall soaks a lot
        // of rounds before it fails, which is what makes flanking the answer.
        multiplier: 0.3,
        enabled: false,
        world: new THREE.Vector3(),
      });
    }
  }

  get isDead(): boolean {
    return !this.active;
  }

  getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.setFromMatrixPosition(this.group.matrixWorld);
  }

  applyDamage(info: DamageInfo): number {
    if (!this.active) return 0;
    // Stasis-on-stasis strips fast, kinetic bounces — same rules as agent shields.
    const mult = info.element === 'stasis' ? 2.4 : info.element === 'kinetic' ? 0.7 : 1;
    const dealt = Math.min(this.health, info.amount * mult);
    this.health -= dealt;
    this.flash = 1;
    this.vfx.impact(info.point, info.normal, 'glass', 0.6);
    if (this.health <= 0) this.shatter(info.point);
    return dealt;
  }

  deploy(scene: THREE.Scene | null, host: ProxyHostLike | null): void {
    if (this.active) return;
    this.active = true;
    this.health = this.maxHealth;
    this.group.visible = true;
    this.group.scale.set(1, 0.05, 1);
    if (scene && this.group.parent !== scene) scene.add(this.group);
    this.host = host;
    if (host) for (const p of this.proxies) { p.enabled = true; host.addProxy(p); }
  }

  shatter(point: THREE.Vector3): void {
    if (!this.active) return;
    this.active = false;
    this.breakTimer = 9;
    this.group.visible = false;
    this.disableProxies();
    this.vfx.shieldBreak(point, 'stasis', 1.6);
    this.vfx.elementalBurst(point, 'stasis', 1.6);
  }

  /** Follow the carrier, and grow into place on deploy. */
  update(dt: number, carrier: THREE.Object3D, forward: number, height: number): void {
    if (!this.active) {
      if (this.breakTimer > 0) this.breakTimer -= dt;
      return;
    }
    this.group.position.copy(carrier.position);
    this.group.position.y += height;
    _q0.setFromAxisAngle(_p0.set(0, 1, 0), forward);
    this.group.quaternion.copy(_q0);
    this.group.translateZ(-1.35);
    this.group.scale.y = damp(this.group.scale.y, 1, 7, dt);
    this.group.updateMatrixWorld(true);
    this.flash = damp(this.flash, 0, 6, dt);
    const health01 = clamp01(this.health / this.maxHealth);
    this.paneMat.opacity = 0.1 + health01 * 0.14 + this.flash * 0.35;
    for (const p of this.proxies) {
      p.world.copy(p.offset).applyMatrix4(this.group.matrixWorld);
    }
  }

  private disableProxies(): void {
    for (const p of this.proxies) p.enabled = false;
    this.host?.removeProxiesFor(this.entityId);
  }

  dispose(): void {
    this.disableProxies();
    this.group.removeFromParent();
    this.pane.geometry.dispose();
    this.lattice.geometry.dispose();
    this.frame.geometry.dispose();
    // `frameMat` belongs to the MaterialLibrary and is shared — only the two
    // materials this class created are ours to release.
    this.paneMat.dispose();
    this.latticeMat.dispose();
  }
}

/** Merge a list of simple non-indexed-safe geometries into one. Disposes inputs. */
function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  let vCount = 0;
  let iCount = 0;
  for (const g of list) {
    vCount += (g.getAttribute('position') as THREE.BufferAttribute).count;
    iCount += g.index ? g.index.count : 0;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const t = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    pos.set(p.array as Float32Array, vo * 3);
    if (n) nrm.set(n.array as Float32Array, vo * 3);
    if (t) uv.set(t.array as Float32Array, vo * 2);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      io += g.index.count;
    }
    vo += p.count;
    g.dispose();
  }
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

interface FrostBomb {
  alive: boolean;
  life: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Mesh;
  radius: number;
  damage: number;
}

interface IceField {
  life: number;
  maxLife: number;
  radius: number;
  mesh: THREE.Mesh;
  damage: number;
  tick: number;
}

interface WarnRing {
  life: number;
  lead: number;
  radius: number;
  mesh: THREE.Mesh;
  damage: number;
  fired: boolean;
  centre: THREE.Vector3;
}

/**
 * Everything the Nordic units put into the world that is not a body: frost
 * bombs, freezing fields, telegraph rings, shield walls and the blizzard. One
 * instance per level, built lazily on first use and stepped from whichever
 * agent ticks first — the pools are shared, so no unit allocates in its update.
 */
class NordicRuntime {
  readonly walls: ShieldWall[] = [];
  private vfx: VfxSystem;
  private scene: THREE.Scene | null = null;
  private bombs: FrostBomb[] = [];
  private fields: IceField[] = [];
  private rings: WarnRing[] = [];
  private lastTime = -1;
  private bombGeo: THREE.BufferGeometry;
  private bombMat: THREE.Material;
  private fieldGeo: THREE.BufferGeometry;
  private fieldMat: THREE.MeshBasicMaterial;
  private ringGeo: THREE.BufferGeometry;
  private ringMat: THREE.MeshBasicMaterial;
  private blizzard: THREE.Points | null = null;
  private blizzardMat: THREE.PointsMaterial | null = null;
  private haze: THREE.Mesh | null = null;
  private hazeMat: THREE.MeshBasicMaterial | null = null;
  private blizzardLevel = 0;
  private blizzardTarget = 0;
  private blizzardCentre = new THREE.Vector3();
  private rng = new Rng(0x51e6d);

  constructor(vfx: VfxSystem) {
    this.vfx = vfx;
    const mats = vfx.materials;
    this.bombGeo = new THREE.IcosahedronGeometry(0.16, 0);
    this.bombMat = mats.emissive(NORDIC.rune, 4.2);
    this.fieldGeo = new THREE.CircleGeometry(1, 30);
    this.fieldGeo.rotateX(-Math.PI / 2);
    this.fieldMat = mats.additive(0x6fb6ff, 0.3);
    this.fieldMat.depthWrite = false;
    this.ringGeo = new THREE.RingGeometry(0.86, 1, 44);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = mats.additive(0xbfe6ff, 0.55);
    this.ringMat.depthWrite = false;
    this.ringMat.side = THREE.DoubleSide;
  }

  bind(scene: THREE.Scene | null): void {
    if (scene && this.scene !== scene) this.scene = scene;
  }

  /** Advance the pools. Idempotent within a frame: driven by wall-clock elapsed. */
  step(elapsed: number, target: Damageable | null, targetPos: THREE.Vector3): void {
    if (this.lastTime < 0) this.lastTime = elapsed;
    const dt = clamp(elapsed - this.lastTime, 0, 0.1);
    this.lastTime = elapsed;
    if (dt <= 0) return;

    for (const bomb of this.bombs) {
      if (!bomb.alive) continue;
      bomb.life -= dt;
      bomb.vel.y -= 22 * dt;
      bomb.pos.addScaledVector(bomb.vel, dt);
      bomb.mesh.position.copy(bomb.pos);
      bomb.mesh.rotation.x += dt * 7;
      bomb.mesh.rotation.z += dt * 5;
      this.vfx.trail(bomb.pos, NORDIC.rune, 0.14);
      const hitGround = bomb.pos.y <= bomb.mesh.userData.groundY;
      if (bomb.life <= 0 || hitGround) this.detonate(bomb, target, targetPos);
    }

    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      f.life -= dt;
      const t = clamp01(f.life / f.maxLife);
      const grow = clamp01((f.maxLife - f.life) * 4);
      f.mesh.scale.setScalar(f.radius * grow);
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.34 * t;
      f.tick -= dt;
      if (f.tick <= 0 && target && !target.isDead) {
        f.tick = 0.5;
        const d = _p0.copy(targetPos).sub(f.mesh.position);
        d.y = 0;
        if (d.lengthSq() < f.radius * f.radius) this.chill(target, targetPos, f.damage, f.mesh.position);
      }
      if (f.life <= 0) {
        f.mesh.removeFromParent();
        this.fields.splice(i, 1);
      }
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      const wind = clamp01(1 - r.life / r.lead);
      // Telegraph: a thin ring at the final radius pulses and fills, then the
      // shock actually travels. That is what makes the pattern learnable.
      r.mesh.scale.setScalar(r.radius * (r.fired ? 1 : 0.2 + wind * 0.8));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = r.fired
        ? clamp01(r.life * 2) * 0.7
        : 0.25 + Math.sin(wind * 26) * 0.16;
      if (!r.fired && r.life <= 0) {
        r.fired = true;
        r.life = 0.45;
        this.vfx.explosion(r.centre, r.radius * 0.5, 'stasis');
        if (target && !target.isDead) {
          const d = _p0.copy(targetPos).sub(r.centre);
          d.y = 0;
          const dist = d.length();
          // The safe zone is *inside* the ring: step in, not away.
          if (dist > r.radius * 0.55 && dist < r.radius * 1.25) {
            this.chill(target, targetPos, r.damage, r.centre);
          }
        }
      }
      if (r.fired && r.life <= 0) {
        r.mesh.removeFromParent();
        this.rings.splice(i, 1);
      }
    }

    this.stepBlizzard(dt);
  }

  /** Lob a frost bomb from `from` toward `to`. */
  throwBomb(from: THREE.Vector3, to: THREE.Vector3, groundY: number, damage: number): void {
    if (!this.scene) return;
    let bomb = this.bombs.find((x) => !x.alive);
    if (!bomb) {
      if (this.bombs.length >= 10) return;
      const mesh = new THREE.Mesh(this.bombGeo, this.bombMat);
      mesh.frustumCulled = false;
      bomb = { alive: false, life: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), mesh, radius: 3.6, damage: 0 };
      this.bombs.push(bomb);
    }
    bomb.alive = true;
    bomb.life = 3;
    bomb.damage = damage;
    bomb.pos.copy(from);
    // A lobbed arc: half the flight in the horizontal, gravity does the rest.
    _p0.subVectors(to, from);
    const flat = Math.hypot(_p0.x, _p0.z);
    const t = clamp(flat / 16, 0.5, 1.5);
    bomb.vel.set(_p0.x / t, _p0.y / t + 0.5 * 22 * t, _p0.z / t);
    bomb.mesh.position.copy(from);
    bomb.mesh.userData.groundY = groundY;
    bomb.mesh.visible = true;
    this.scene.add(bomb.mesh);
  }

  private detonate(bomb: FrostBomb, target: Damageable | null, targetPos: THREE.Vector3): void {
    bomb.alive = false;
    bomb.mesh.removeFromParent();
    this.vfx.explosion(bomb.pos, bomb.radius, 'stasis');
    if (target && !target.isDead) {
      const d = _p0.copy(targetPos).sub(bomb.pos);
      if (d.lengthSq() < bomb.radius * bomb.radius) this.chill(target, targetPos, bomb.damage, bomb.pos);
    }
    this.field(bomb.pos, bomb.radius * 0.75, 4, bomb.damage * 0.25);
  }

  /** A lingering freezing field. Ticks damage and reads as a hazard on the floor. */
  field(centre: THREE.Vector3, radius: number, life: number, damage: number): void {
    if (!this.scene) return;
    if (this.fields.length > 6) {
      const dead = this.fields.shift();
      dead?.mesh.removeFromParent();
    }
    const mesh = new THREE.Mesh(this.fieldGeo, this.fieldMat.clone());
    mesh.position.copy(centre);
    mesh.position.y += 0.05;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.scene.add(mesh);
    this.fields.push({ life, maxLife: life, radius, mesh, damage, tick: 0.4 });
    // Shards rising out of the ground sell it as ice, not as a light decal.
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + this.rng.range(0, 0.6);
      _p1.set(centre.x + Math.cos(a) * radius * 0.8, centre.y + 0.1, centre.z + Math.sin(a) * radius * 0.8);
      this.vfx.elementalBurst(_p1, 'stasis', 0.5);
    }
  }

  /** Telegraphed AoE ring. `lead` seconds of wind-up before it fires. */
  slamRing(centre: THREE.Vector3, radius: number, lead: number, damage: number): void {
    if (!this.scene) return;
    if (this.rings.length > 5) {
      const dead = this.rings.shift();
      dead?.mesh.removeFromParent();
    }
    const mesh = new THREE.Mesh(this.ringGeo, this.ringMat.clone());
    mesh.position.copy(centre);
    mesh.position.y += 0.07;
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    this.scene.add(mesh);
    this.rings.push({ life: lead, lead, radius, mesh, damage, fired: false, centre: centre.clone() });
  }

  /** Stasis damage plus the slow that gives the faction its identity. */
  private chill(target: Damageable, at: THREE.Vector3, amount: number, from: THREE.Vector3): void {
    _p1.subVectors(at, from);
    if (_p1.lengthSq() < 1e-6) _p1.set(0, 1, 0);
    _p1.normalize();
    NORDIC_DAMAGE.amount = amount;
    NORDIC_DAMAGE.point.copy(at);
    NORDIC_DAMAGE.normal.copy(_p1).negate();
    NORDIC_DAMAGE.direction.copy(_p1);
    NORDIC_DAMAGE.splash = true;
    NORDIC_DAMAGE.sourceId = -1;
    target.applyDamage(NORDIC_DAMAGE);
    this.vfx.elementalBurst(at, 'stasis', 0.8);
  }

  /** Ramp the blizzard in (1) or out (0) around `centre`. */
  setBlizzard(level: number, centre: THREE.Vector3): void {
    this.blizzardTarget = clamp01(level);
    this.blizzardCentre.copy(centre);
    if (this.blizzardTarget > 0 && !this.blizzard && this.scene) this.buildBlizzard();
  }

  private buildBlizzard(): void {
    if (!this.scene) return;
    const count = Math.round(clamp(settings.profile.particleBudget * 0.12, 240, 1400));
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = this.rng.range(-30, 30);
      pos[i * 3 + 1] = this.rng.range(0, 22);
      pos[i * 3 + 2] = this.rng.range(-30, 30);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.blizzardMat = new THREE.PointsMaterial({
      color: 0xdcefff,
      size: 0.16,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.blizzard = new THREE.Points(geo, this.blizzardMat);
    this.blizzard.frustumCulled = false;
    this.blizzard.renderOrder = 6;
    this.scene.add(this.blizzard);

    // A white-out shell: seen from inside, it lifts the distance into a flat
    // value and genuinely costs the player their sightlines.
    const hazeGeo = new THREE.SphereGeometry(30, 20, 12);
    this.hazeMat = new THREE.MeshBasicMaterial({
      color: 0xc8dcec,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
      toneMapped: false,
    });
    this.haze = new THREE.Mesh(hazeGeo, this.hazeMat);
    this.haze.frustumCulled = false;
    this.haze.renderOrder = 7;
    this.scene.add(this.haze);
  }

  private stepBlizzard(dt: number): void {
    if (!this.blizzard || !this.blizzardMat || !this.hazeMat || !this.haze) return;
    this.blizzardLevel = damp(this.blizzardLevel, this.blizzardTarget, 1.4, dt);
    const on = this.blizzardLevel > 0.004;
    this.blizzard.visible = on;
    this.haze.visible = on;
    if (!on) return;
    this.blizzard.position.copy(this.blizzardCentre);
    this.haze.position.copy(this.blizzardCentre);
    this.blizzardMat.opacity = this.blizzardLevel * 0.85;
    this.hazeMat.opacity = this.blizzardLevel * 0.42;
    const p = this.blizzard.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = p.array as Float32Array;
    const drift = dt * 9;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += drift * 1.4;
      arr[i + 1] -= drift * 0.8;
      arr[i + 2] += drift * 0.5;
      if (arr[i] > 30) arr[i] -= 60;
      if (arr[i + 2] > 30) arr[i + 2] -= 60;
      if (arr[i + 1] < 0) arr[i + 1] += 22;
    }
    p.needsUpdate = true;
  }

  /** Acquire (or build) a shield wall for a Huscarl. */
  wall(): ShieldWall {
    for (const w of this.walls) {
      if (!w.active && w.breakTimer <= 0 && !w.group.parent) return w;
    }
    const w = new ShieldWall(this.vfx, 2.4, 2.1);
    this.walls.push(w);
    return w;
  }

  dispose(): void {
    for (const w of this.walls) w.dispose();
    this.walls.length = 0;
    for (const b of this.bombs) b.mesh.removeFromParent();
    this.bombs.length = 0;
    for (const f of this.fields) {
      f.mesh.removeFromParent();
      (f.mesh.material as THREE.Material).dispose();
    }
    this.fields.length = 0;
    for (const r of this.rings) {
      r.mesh.removeFromParent();
      (r.mesh.material as THREE.Material).dispose();
    }
    this.rings.length = 0;
    this.bombGeo.dispose();
    this.bombMat.dispose();
    this.fieldGeo.dispose();
    this.fieldMat.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    if (this.blizzard) {
      this.blizzard.removeFromParent();
      this.blizzard.geometry.dispose();
    }
    this.blizzardMat?.dispose();
    if (this.haze) {
      this.haze.removeFromParent();
      this.haze.geometry.dispose();
    }
    this.hazeMat?.dispose();
    this.blizzard = null;
    this.haze = null;
    this.lastTime = -1;
  }
}

/** Reused damage packet — nothing in here allocates per hit. */
const NORDIC_DAMAGE: DamageInfo = {
  amount: 0,
  element: 'stasis',
  region: 'body',
  precision: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  direction: new THREE.Vector3(0, 0, -1),
  sourceId: -1,
  splash: true,
  impulse: 4,
};

let runtime: NordicRuntime | null = null;
/**
 * The VFX system, captured from the first behaviour tick. `animate()` is handed
 * an `AnimationContext`, which deliberately carries no VFX seam, so the breath
 * fog needs this back-reference rather than a wider framework change.
 */
let lastVfx: VfxSystem | null = null;

/**
 * Live Nordic agents, so allies can find each other. The framework does not
 * hand a behaviour tree the roster, and the Seer's ward is meaningless without
 * one; entries are added on tick and pruned as they die.
 */
const NORDIC_ROSTER = new Set<EnemyAgent>();
let prunedAt = -1;

function track(agent: EnemyAgent, ctx: BehaviourContext): void {
  lastVfx = ctx.vfx;
  NORDIC_ROSTER.add(agent);
  if (ctx.elapsed - prunedAt < 2) return;
  prunedAt = ctx.elapsed;
  for (const a of NORDIC_ROSTER) if (a.state !== 'alive') NORDIC_ROSTER.delete(a);
}

function rt(ctx: BehaviourContext): NordicRuntime {
  lastVfx = ctx.vfx;
  if (!runtime) runtime = new NordicRuntime(ctx.vfx);
  runtime.bind(ctx.vfx.scene);
  runtime.step(ctx.elapsed, ctx.target, ctx.targetPosition);
  return runtime;
}

/** Release every world object this module created. Levels call this on unload. */
export function disposeNordicRuntime(): void {
  runtime?.dispose();
  runtime = null;
  NORDIC_ROSTER.clear();
  lastVfx = null;
  prunedAt = -1;
}

export type NordicSummoner = (
  archetypeId: string,
  position: THREE.Vector3,
  yaw: number,
) => unknown;

let summoner: NordicSummoner | null = null;

/**
 * Hand this `(id, pos, yaw) => enemies.spawn(id, pos, yaw)`. Without it the
 * Allfather's blizzard beat still runs — it just detonates a nova instead of
 * calling thralls, so the fight degrades gracefully rather than breaking.
 */
export function setNordicSummoner(fn: NordicSummoner | null): void {
  summoner = fn;
}

// ---------------------------------------------------------------------------
// Behaviour helpers
// ---------------------------------------------------------------------------

/** Flat distance and unit direction from `a` to the target. */
function toTarget(agent: EnemyAgent, ctx: BehaviourContext, out: THREE.Vector3): number {
  out.subVectors(ctx.targetPosition, agent.position);
  out.y = 0;
  const d = out.length() || 1e-3;
  out.multiplyScalar(1 / d);
  return d;
}

/** Face the target and hold still — the shared shape of every wind-up. */
function brace(agent: EnemyAgent, ctx: BehaviourContext, hold: number): void {
  agent.ai.lookAt.copy(ctx.targetPosition);
  agent.ai.lookValid = true;
  agent.ai.desiredVelocity.multiplyScalar(hold);
}

/** Idle/alert gate every Nordic tree opens with. */
function unaware(): BehaviourNode {
  return sequence(
    condition((a, ctx) => !ctx.targetValid || a.ai.alert < 0.25),
    action((a, ctx) => {
      a.ai.state = 'idle';
      a.ai.desiredVelocity.set(0, 0, 0);
      a.ai.lookValid = false;
      const near = ctx.targetValid && a.ai.distanceToTarget < a.archetype.preferredRange * 2.6;
      a.ai.alert = clamp01(a.ai.alert + (near && a.ai.hasLineOfSight ? ctx.dt * 1.8 : -ctx.dt * 0.2));
      return 'running';
    }),
  );
}

/** Approach/strafe/back-off ring movement, shared by the ranged units. */
function ringMove(agent: EnemyAgent, ctx: BehaviourContext, dir: THREE.Vector3, dist: number, strafe: number): void {
  const a = agent.archetype;
  const speed = agent.ai.alert > 0.9 ? a.sprintSpeed : a.moveSpeed;
  let radial = 0;
  if (dist > a.preferredRange * 1.15) radial = 1;
  else if (dist < a.preferredRange * 0.72) radial = -1;
  _p2.set(dir.z, 0, -dir.x);
  agent.ai.desiredVelocity.copy(dir).multiplyScalar(radial * speed).addScaledVector(_p2, strafe * speed * 0.65);
}

// ---------------------------------------------------------------------------
// Behaviours
// ---------------------------------------------------------------------------

/**
 * Thrall — closes without hesitating, leaps the last few metres, and swings
 * twice per commitment. The 0.45 s wind-up is the contract: axes go over the
 * head and the body coils before anything can hurt you.
 */
function thrallBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let leapCd = 2;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      ai.state = 'engage';
      if (!ctx.targetValid) {
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.35);
        ai.desiredVelocity.set(0, 0, 0);
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      ai.desiredVelocity.copy(dir).multiplyScalar(a.archetype.sprintSpeed);
      leapCd -= ctx.dt;

      // The leap: only from a real gap, and only after a held pose.
      if (leapCd <= 0 && d > 6 && d < 15 && a.grounded && !a.anim.busy) {
        leapCd = ctx.rng.range(4.5, 7);
        ai.bark = 'charge';
        ai.attackId = 'leap';
        a.anim.attack(0.5, 0.1, 0.5);
        ai.vars.set('leapPending', 1);
        brace(a, ctx, 0.1);
        return 'running';
      }
      if (ai.vars.get('leapPending') && a.anim.attackStriking) {
        ai.vars.set('leapPending', 0);
        ai.leap = true;
        // Ballistic hop toward the target; the animator plays the take-off.
        const t = clamp(d / 9, 0.5, 1.1);
        a.velocity.set(dir.x * (d / t), 0.5 * 24 * t, dir.z * (d / t));
        a.grounded = false;
      }

      if (a.anim.busy) {
        brace(a, ctx, 0.15);
        return 'running';
      }
      if (ai.attackCooldown <= 0 && d < 3.4 && ai.hasLineOfSight) {
        ai.attackCooldown = a.archetype.attackInterval * ctx.rng.range(0.8, 1.15);
        ai.bark = 'taunt';
        ai.attackId = 'axes';
        // Wind-up ≥ 0.35 s, then a fast strike: readable, then committed.
        a.anim.attack(0.45, 0.11, 0.42);
        ai.vars.set('attackPending', 1);
        brace(a, ctx, 0.2);
      }
      return 'running';
    }),
  );
}

/**
 * Raider — holds the ring at rifle range, strafes, and lobs a frost bomb when
 * the player has been standing still or is behind cover. The bomb is the
 * cover-breaker; the rifle is the pressure.
 */
function raiderBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let strafeDir = 1;
  let strafeTimer = 0;
  let bombCd = 5;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      ai.state = 'engage';
      if (!ctx.targetValid) {
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.35);
        ai.desiredVelocity.set(0, 0, 0);
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      strafeTimer -= ctx.dt;
      if (strafeTimer <= 0) {
        strafeTimer = ctx.rng.range(1.1, 2.6);
        strafeDir = ctx.rng.bool() ? 1 : -1;
      }
      ringMove(a, ctx, dir, d, (0.45 + a.archetype.caution * 0.5) * strafeDir);

      bombCd -= ctx.dt;
      if (bombCd <= 0 && d > 7 && d < 30 && !a.anim.busy) {
        bombCd = ctx.rng.range(7, 11);
        ai.bark = 'grenade';
        ai.attackId = 'frostBomb';
        a.anim.attack(0.55, 0.12, 0.45);
        ai.vars.set('bombPending', 1);
        brace(a, ctx, 0.25);
        return 'running';
      }
      if (ai.vars.get('bombPending') && a.anim.attackStriking) {
        ai.vars.set('bombPending', 0);
        a.rig.boneWorld(a.muzzleBone, _p0);
        _p1.copy(ctx.targetPosition).addScaledVector(ctx.targetVelocity, 0.45);
        _p1.y = a.groundHeight;
        rt(ctx).throwBomb(_p0, _p1, a.groundHeight, a.archetype.attackDamage * 1.8);
      }

      if (a.anim.busy) return 'running';
      if (ai.attackCooldown <= 0 && ai.hasLineOfSight && d < a.archetype.preferredRange * 2.4) {
        ai.attackCooldown = a.archetype.attackInterval * ctx.rng.range(0.85, 1.2);
        ai.attackId = 'runeRifle';
        a.anim.attack(0.36, 0.07, 0.26);
        ai.vars.set('attackPending', 1);
      }
      return 'running';
    }),
  );
}

/**
 * Huscarl — deploys the wall the moment it has line of sight and pushes it
 * forward. Because the wall is a real blocker, the correct play is to leave it
 * up and walk it at the player; the unit never strafes out from behind it.
 */
function huscarlBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let wall: ShieldWall | null = null;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      const runtimeFx = rt(ctx);
      ai.state = 'advance';
      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.35);
        if (wall?.active) wall.shatter(a.position);
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;

      if (a.state !== 'alive') {
        if (wall?.active) wall.shatter(a.position);
        wall = null;
        return 'failure';
      }
      if ((!wall || (!wall.active && wall.breakTimer <= 0)) && ai.hasLineOfSight && d < 40) {
        wall = wall ?? runtimeFx.wall();
        wall.deploy(ctx.vfx.scene, proxyHost(ctx.collision));
        ai.bark = 'cover';
      }
      if (wall) wall.update(ctx.dt, a.object, a.yaw, a.archetype.capsuleHalfHeight + 0.75);

      // Walk it forward at half pace; a shield wall that sprints is not a wall.
      const speed = a.archetype.moveSpeed * (wall?.active ? 0.62 : 1);
      let radial = 0;
      if (d > 6) radial = 1;
      else if (d < 3.2) radial = -0.6;
      ai.desiredVelocity.copy(dir).multiplyScalar(radial * speed);

      if (a.anim.busy) return 'running';
      if (ai.attackCooldown <= 0 && ai.hasLineOfSight && d < 8) {
        ai.attackCooldown = a.archetype.attackInterval * ctx.rng.range(0.9, 1.25);
        ai.attackId = 'shieldBash';
        ai.bark = 'charge';
        a.anim.attack(0.42, 0.1, 0.4);
        ai.vars.set('attackPending', 1);
        brace(a, ctx, 0.2);
      }
      return 'running';
    }),
  );
}

/**
 * Seer — keeps its distance, blinks away when crowded, wards nearby allies,
 * and channels a rune beam. The beam is broken by breaking line of sight,
 * which is the whole counter-play: the Seer punishes standing in the open.
 */
function seerBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let blinkCd = 3;
  let wardCd = 6;
  let channel = -1;
  let beamTick = 0;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      ai.state = 'engage';
      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.3);
        channel = -1;
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      ai.desiredVelocity.y = clamp((ctx.targetPosition.y + 0.6 - a.position.y) * 1.2, -3, 3);
      blinkCd -= ctx.dt;
      wardCd -= ctx.dt;

      // Blink: a short teleport away when the player closes.
      if (blinkCd <= 0 && d < 11) {
        blinkCd = ctx.rng.range(4, 7);
        ctx.vfx.elementalBurst(a.position, 'stasis', 1.3);
        _p0.copy(dir).multiplyScalar(-9).applyAxisAngle(_p1.set(0, 1, 0), ctx.rng.range(-0.9, 0.9));
        a.position.add(_p0);
        a.velocity.set(0, 0, 0);
        a.anim.reset(a.position, a.yaw, a.groundHeight);
        ctx.vfx.elementalBurst(a.position, 'stasis', 1.6);
        channel = -1;
        return 'running';
      }

      // Ward: hand nearby allies a slice of stasis shield.
      if (wardCd <= 0) {
        wardCd = ctx.rng.range(9, 13);
        ai.bark = 'reinforce';
        ai.attackId = 'ward';
        a.anim.attack(0.6, 0.15, 0.5);
        ai.vars.set('wardPending', 1);
      }
      if (ai.vars.get('wardPending') && a.anim.attackStriking) {
        ai.vars.set('wardPending', 0);
        ctx.vfx.elementalBurst(a.position, 'stasis', 3.2);
        // Ward: refill the stasis shields of everyone in the circle, and patch
        // the unshielded minors instead — a buff you can see land on the squad.
        for (const ally of NORDIC_ROSTER) {
          if (ally.state !== 'alive') continue;
          if (ally.position.distanceToSquared(a.position) > 196) continue;
          ctx.vfx.chain(a.position, ally.position, NORDIC.rune, 0.05);
          if (ally.maxShield > 0) {
            ally.shield = ally.maxShield;
            if (ally.shieldMesh) ally.shieldMesh.visible = true;
          } else {
            ally.health = Math.min(ally.maxHealth, ally.health + ally.maxHealth * 0.35);
          }
          ctx.vfx.elementalBurst(ally.position, 'stasis', 0.9);
        }
      }

      ringMove(a, ctx, dir, d, 0.35);

      // The channelled beam. 0.7 s of visible charge, then a sustained lance
      // that stops the instant the target breaks line of sight.
      if (channel < 0 && ai.attackCooldown <= 0 && ai.hasLineOfSight && d < 34 && !a.anim.busy) {
        ai.attackCooldown = 6;
        ai.attackId = 'runeBeam';
        ai.bark = 'taunt';
        a.anim.attack(0.7, 2.4, 0.5);
        channel = 0;
        beamTick = 0;
      }
      if (channel >= 0) {
        channel += ctx.dt;
        brace(a, ctx, 0.25);
        if (channel > 0.7) {
          if (!ai.hasLineOfSight) {
            channel = -1;
            return 'running';
          }
          a.rig.boneWorld('spine.chest', _p0);
          ctx.vfx.beam(_p0, ctx.targetPosition, NORDIC.rune, 0.09);
          beamTick -= ctx.dt;
          if (beamTick <= 0 && ctx.target) {
            beamTick = a.archetype.attackInterval;
            NORDIC_DAMAGE.amount = a.archetype.attackDamage;
            NORDIC_DAMAGE.splash = false;
            NORDIC_DAMAGE.point.copy(ctx.targetPosition);
            NORDIC_DAMAGE.direction.subVectors(ctx.targetPosition, _p0).normalize();
            NORDIC_DAMAGE.normal.copy(NORDIC_DAMAGE.direction).negate();
            NORDIC_DAMAGE.sourceId = a.entityId;
            ctx.target.applyDamage(NORDIC_DAMAGE);
          }
        }
        if (channel > 3.1) channel = -1;
      }
      return 'running';
    }),
  );
}

/**
 * Jarl — closes to hammer range and slams. Every slam is a 0.55 s overhead
 * hold followed by a ring that fires outward and leaves a freezing field, so
 * the counter is always the same: get inside it or get out of the ring.
 */
function jarlBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let novaCd = 8;
  return selector(
    unaware(),
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      const fx = rt(ctx);
      ai.state = 'engage';
      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        ai.alert = Math.max(0, ai.alert - ctx.dt * 0.35);
        return 'running';
      }
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      novaCd -= ctx.dt;

      const speed = ai.alert > 0.9 ? a.archetype.sprintSpeed : a.archetype.moveSpeed;
      ai.desiredVelocity.copy(dir).multiplyScalar(d > 4 ? speed : -0.3 * speed);

      if (ai.vars.get('slamPending') && a.anim.attackStriking) {
        ai.vars.set('slamPending', 0);
        _p0.copy(a.position);
        _p0.y = a.groundHeight;
        ctx.vfx.explosion(_p0, 4.5, 'stasis');
        fx.slamRing(_p0, 7.5, 0.55, a.archetype.attackDamage * 1.4);
        fx.field(_p0, 4.6, 6, a.archetype.attackDamage * 0.3);
        a.anim.hit(_p0, _p1.set(0, 1, 0), 1.4);
      }
      if (ai.vars.get('novaPending') && a.anim.attackStriking) {
        ai.vars.set('novaPending', 0);
        _p0.copy(a.position);
        _p0.y = a.groundHeight;
        fx.slamRing(_p0, 12, 0.9, a.archetype.attackDamage * 1.6);
      }
      if (a.anim.busy) {
        brace(a, ctx, 0.12);
        return 'running';
      }
      if (novaCd <= 0 && d < 20) {
        novaCd = ctx.rng.range(11, 16);
        ai.attackId = 'frostNova';
        ai.bark = 'taunt';
        // A full second of hold: this is the big, learnable one.
        a.anim.attack(1.0, 0.14, 0.6);
        ai.vars.set('novaPending', 1);
        brace(a, ctx, 0.05);
        return 'running';
      }
      if (ai.attackCooldown <= 0 && d < 6.5) {
        ai.attackCooldown = a.archetype.attackInterval * ctx.rng.range(1.4, 1.9);
        ai.attackId = 'slam';
        ai.bark = 'charge';
        a.anim.attack(0.55, 0.12, 0.5);
        ai.vars.set('slamPending', 1);
        brace(a, ctx, 0.1);
      }
      return 'running';
    }),
  );
}

/**
 * The Allfather — a three-phase set-piece, not a large soldier.
 *
 * - **Phase 1 (>66%)** hammer slams with concentric telegraph rings; the four
 *   back pylons flare open for 4 s after each slam.
 * - **Phase 2 (66–33%)** the blizzard: visibility collapses, thralls are called
 *   in, and the boss walks a slow triple-ring pattern.
 * - **Phase 3 (<33%)** enrage: rings come faster and paired, the freezing field
 *   is permanent under his feet, and the pylons stay open.
 *
 * The arena mechanic is the ring geometry itself — the safe ground is *inside*
 * the ring, so the fight is about closing distance under a hammer rather than
 * kiting, and the blizzard removes the ability to read the ring at range.
 */
function allfatherBehaviour(): BehaviourNode {
  const dir = new THREE.Vector3();
  let phase = 1;
  let phaseIntro = 0;
  let slamCd = 3;
  let summonCd = 6;
  let pylon = 0;
  return selector(
    action((a, ctx) => {
      const ai = a.ai;
      track(a, ctx);
      const fx = rt(ctx);
      const frac = a.health / Math.max(1, a.maxHealth);
      const want = frac < 0.33 ? 3 : frac < 0.66 ? 2 : 1;
      if (want !== phase) {
        phase = want;
        phaseIntro = 2.2;
        ai.bark = 'taunt';
        ctx.vfx.explosion(_p0.copy(a.position).setY(a.groundHeight), 9, 'stasis');
        fx.setBlizzard(phase >= 2 ? 1 : 0, a.position);
      }
      if (phaseIntro > 0) {
        phaseIntro -= ctx.dt;
        ai.state = 'stagger';
        ai.desiredVelocity.set(0, 0, 0);
        ai.lookValid = false;
        if (phaseIntro <= 0 && phase === 3) fx.field(_p0.copy(a.position).setY(a.groundHeight), 7, 999, a.archetype.attackDamage * 0.2);
        return 'running';
      }
      if (phase >= 2) fx.setBlizzard(1, a.position);

      if (!ctx.targetValid) {
        ai.desiredVelocity.set(0, 0, 0);
        return 'running';
      }
      ai.state = 'engage';
      const d = toTarget(a, ctx, dir);
      ai.lookAt.copy(ctx.targetPosition);
      ai.lookValid = true;
      ai.alert = 1;

      const speed = a.archetype.moveSpeed * (phase === 3 ? 1.35 : 1);
      ai.desiredVelocity.copy(dir).multiplyScalar(d > 7 ? speed : 0);

      // Pylons: open for 4 s after every slam, the window the fight is built on.
      pylon = Math.max(0, pylon - ctx.dt);
      ai.vars.set('pylonOpen', phase === 3 ? 1 : pylon > 0 ? 1 : 0);

      if (ai.vars.get('slamPending') && a.anim.attackStriking) {
        ai.vars.set('slamPending', 0);
        _p0.copy(a.position);
        _p0.y = a.groundHeight;
        ctx.vfx.explosion(_p0, 8, 'stasis');
        const rings = phase === 1 ? 2 : 3;
        for (let i = 0; i < rings; i++) {
          fx.slamRing(_p0, 7 + i * 5.5, 0.65 + i * (phase === 3 ? 0.34 : 0.55), a.archetype.attackDamage * 1.3);
        }
        fx.field(_p0, 5.5, 7, a.archetype.attackDamage * 0.22);
        pylon = 4;
        a.anim.hit(_p0, _p1.set(0, 1, 0), 2.2);
      }

      if (a.anim.busy) {
        brace(a, ctx, 0.1);
        return 'running';
      }
      slamCd -= ctx.dt;
      summonCd -= ctx.dt;

      if (phase >= 2 && summonCd <= 0) {
        summonCd = phase === 3 ? 12 : 16;
        ai.bark = 'reinforce';
        ai.attackId = 'summon';
        a.anim.attack(0.8, 0.15, 0.6);
        ai.vars.set('summonPending', 1);
        brace(a, ctx, 0.05);
        return 'running';
      }
      if (ai.vars.get('summonPending') && a.anim.attackProgress > 0.5) {
        ai.vars.set('summonPending', 0);
        let called = 0;
        if (summoner) {
          for (let i = 0; i < 3; i++) {
            const ang = (i / 3) * Math.PI * 2 + ctx.rng.range(0, 1);
            _p0.set(a.position.x + Math.cos(ang) * 9, a.groundHeight, a.position.z + Math.sin(ang) * 9);
            ctx.vfx.elementalBurst(_p0, 'stasis', 2);
            if (summoner('nordic.thrall', _p0, ang + Math.PI)) called++;
          }
        }
        // Graceful degradation: with no summoner wired, the beat still lands.
        if (called === 0) {
          _p0.copy(a.position).setY(a.groundHeight);
          rt(ctx).slamRing(_p0, 15, 1.1, a.archetype.attackDamage * 1.5);
        }
        return 'running';
      }

      if (slamCd <= 0 && d < 26) {
        slamCd = phase === 3 ? ctx.rng.range(3.4, 4.6) : ctx.rng.range(5, 7.5);
        ai.attackId = 'hammerSlam';
        ai.bark = 'charge';
        // 0.85 s overhead hold. Even enraged it never drops below the contract.
        a.anim.attack(phase === 3 ? 0.62 : 0.85, 0.14, 0.6);
        ai.vars.set('slamPending', 1);
        brace(a, ctx, 0.05);
      }
      return 'running';
    }),
  );
}

// ---------------------------------------------------------------------------
// Species flourishes
// ---------------------------------------------------------------------------

const _breath = new THREE.Vector3();

/**
 * Breath fogging in the cold, and a pulse in the rune light while a wind-up is
 * held — the visual half of "this attack is coming".
 */
function nordicAnimate(agent: EnemyAgent, ctx: AnimationContext): void {
  if (agent.lod === 'distant' || agent.state !== 'alive' || !lastVfx) return;
  // Breath: a slow puff from the mask, faster while charging.
  const rate = 2.6 + agent.ai.locomotion * 2.4;
  const t = ctx.elapsed * rate;
  const prev = agent.ai.vars.get('breathPhase') ?? 0;
  const now = Math.floor(t);
  if (now !== prev) {
    agent.ai.vars.set('breathPhase', now);
    agent.rig.boneWorld(agent.headBone, _breath);
    _breath.y -= agent.height * 0.03;
    _p1.set(-Math.sin(agent.yaw), 0.16, -Math.cos(agent.yaw));
    _breath.addScaledVector(_p1, agent.height * 0.09);
    lastVfx.trail(_breath, 0xd8ecff, agent.height * 0.05);
  }
}

// ---------------------------------------------------------------------------
// AI-layer behaviour trees
// ---------------------------------------------------------------------------

/**
 * `EnemyAgent`s are what the director actually drives; `AiAgent` is the
 * structural view of them. The cast is safe by construction — the director only
 * ever brains agents the manager created — and it is what lets these nodes
 * reach `anim` for the telegraph poses the AI layer does not model.
 */
function asAgent(c: BtContext): EnemyAgent {
  return c.brain.agent as unknown as EnemyAgent;
}

/** Play a species attack pose and hold the node until the strike lands. */
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

/** The shared skeleton every Nordic tree hangs its speciality off. */
function nordicTree(engaged: ReturnType<typeof par>): BehaviorTree {
  return compileTree(
    sel(
      guard((c) => c.brain.percept.state === 'engaged', engaged),
      guard(
        (c) => c.brain.percept.state === 'searching',
        sel(seq(searchLastKnown(0.8), scanArea(2)), scanArea(1.6)),
      ),
      guard(
        (c) => c.brain.percept.state === 'suspicious',
        seq(btBark('suspicious'), sel(searchLastKnown(0.5), scanArea(1.8))),
      ),
      sel(patrolArea(14), holdPosition()),
    ),
  );
}

/** Compiled per-archetype trees for the AI director. */
export const NORDIC_TREES: Record<string, BehaviorTree> = {
  'nordic.thrall': nordicTree(
    par(
      'all',
      'all',
      sel(fail(seq(cond('gap', (c) => c.brain.agent.position.distanceTo(c.host.target.centre) > 6), leapAt(6, 15, 4.2))), advanceToRange(2.2, 1)),
      sel(seq(faceTarget(0.35), poseAttack('axes', 0.45, 0.11, 0.42)), holdPosition()),
    ),
  ),
  'nordic.raider': nordicTree(
    par(
      'all',
      'all',
      sel(
        fail(seq(cond('hurt', (c) => c.brain.agent.health / Math.max(1, c.brain.agent.maxHealth) < 0.5), takeCover(24, false, 1), holdCover(2.6), leaveCover())),
        fail(seq(cond('flankOrder', (c) => c.brain.order.kind === 'flankLeft' || c.brain.order.kind === 'flankRight'), timeout(8, moveToFlank(c2side, undefined, 0.95)))),
        strafeAtRange(),
      ),
      sel(
        withAttackToken(seq(faceTarget(0.3), telegraph(0.4, 'runeRifle', 'taunt'), fireBurst(3))),
        seq(faceTarget(0.4), poseAttack('frostBomb', 0.55, 0.12, 0.45)),
      ),
    ),
  ),
  'nordic.huscarl': nordicTree(
    par('all', 'all', advanceToRange(4, 0.6), sel(seq(faceTarget(0.4), poseAttack('shieldBash', 0.42, 0.1, 0.4)), holdPosition())),
  ),
  'nordic.seer': nordicTree(
    par(
      'all',
      'all',
      sel(fail(seq(cond('crowded', (c) => c.brain.agent.position.distanceTo(c.host.target.centre) < 11), repositionFiring(14, 1))), strafeAtRange(24, 0.5)),
      withAttackToken(seq(faceTarget(0.2), telegraph(0.7, 'runeBeam', 'taunt'), fireBurst(6, 0.16))),
    ),
  ),
  'nordic.jarl': nordicTree(
    par(
      'all',
      'all',
      advanceToRange(5, 0.95),
      sel(seq(faceTarget(0.3), poseAttack('slam', 0.55, 0.12, 0.5)), seq(faceTarget(0.5), poseAttack('frostNova', 1.0, 0.14, 0.6))),
    ),
  ),
  'nordic.allfather': nordicTree(
    par(
      'all',
      'all',
      advanceToRange(7, 0.9),
      sel(seq(faceTarget(0.3), poseAttack('hammerSlam', 0.85, 0.14, 0.6)), holdPosition()),
    ),
  ),
};

/** Flank side from the squad order, so the pair does not walk the same arc. */
function c2side(c: BtContext): number {
  return c.brain.order.kind === 'flankLeft' ? -1 : 1;
}

/** Minimal view of the AI director this module needs. */
export interface NordicAiHost {
  registerBehaviour(archetypeId: string, tree: BehaviorTree): void;
}

/** Install the compiled trees. Call once after `new AiDirector(...)`. */
export function registerNordicBehaviours(director: NordicAiHost): void {
  for (const id of Object.keys(NORDIC_TREES)) director.registerBehaviour(id, NORDIC_TREES[id]);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function species(
  archetype: EnemyArchetype,
  build: (ctx: BodyBuildContext) => BuiltBody,
  behaviour: () => BehaviourNode,
): SpeciesDefinition {
  return { archetype, build, behaviour, animate: nordicAnimate };
}

let registered = false;

/**
 * Register the warhost. Called at module scope so a bare
 * `import '@/gameplay/enemies/factions/nordic'` is all a level needs.
 */
export function registerNordicSpecies(): void {
  if (registered) return;
  registered = true;
  EnemyManager.register(species(NORDIC_ARCHETYPES['nordic.thrall'], buildThrall, thrallBehaviour));
  EnemyManager.register(species(NORDIC_ARCHETYPES['nordic.raider'], buildRaider, raiderBehaviour));
  EnemyManager.register(species(NORDIC_ARCHETYPES['nordic.huscarl'], buildHuscarl, huscarlBehaviour));
  EnemyManager.register(species(SEER, buildSeer, seerBehaviour));
  EnemyManager.register(species(NORDIC_ARCHETYPES['nordic.jarl'], buildJarl, jarlBehaviour));
  EnemyManager.register(species(NORDIC_ARCHETYPES['nordic.allfather'], buildAllfather, allfatherBehaviour));
}

registerNordicSpecies();

export { buildThrall, buildRaider, buildHuscarl, buildSeer, buildJarl, buildAllfather };
