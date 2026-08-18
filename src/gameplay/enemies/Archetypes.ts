/**
 * Archetypes — the stat catalogue, plus four reference species.
 *
 * `ARCHETYPES` is the single source of truth for enemy numbers across every
 * faction. Faction owners look their unit up here rather than inventing stats,
 * so the difficulty curve is tuned in one file instead of five.
 *
 * The `training.*` species at the bottom are **working reference
 * implementations** of `SpeciesDefinition` — a biped, a quadruped, a hexapod
 * and a flyer. They exercise every part of the rig/animation framework (two-bone
 * IK, FABRIK, tripod gait, wing beat) and they are what the capture harness
 * shoots. Copy the one whose body plan matches your species and replace the
 * geometry; the skeleton conventions are the part worth copying verbatim.
 */
import * as THREE from 'three';
import type { DamageElement, EnemyArchetype, EnemyRank, FactionId } from '@/types';
import { Rng } from '@/util/math';
import { DOWN, FORWARD, UP, type Rig } from './Rig';
import type { BodyBuildContext, BuiltBody, SpeciesDefinition } from './EnemyAgent';
import { registerSpecies, standardCombatBehaviour } from './EnemyAgent';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface ArchetypeOverrides extends Partial<EnemyArchetype> {
  id: string;
  faction: FactionId;
  rank: EnemyRank;
  displayName: string;
}

/** Rank-driven baselines, so a "minor" of any faction feels like a minor. */
const RANK_BASE: Record<EnemyRank, Partial<EnemyArchetype>> = {
  minor: {
    health: 60,
    shield: 0,
    moveSpeed: 3.4,
    sprintSpeed: 5.6,
    preferredRange: 12,
    eyeHeight: 1.5,
    capsuleRadius: 0.34,
    capsuleHalfHeight: 0.6,
    attackDamage: 6,
    attackInterval: 1.1,
    accuracy: 0.055,
    aggression: 0.7,
    caution: 0.2,
    score: 10,
  },
  standard: {
    health: 140,
    shield: 0,
    moveSpeed: 3.1,
    sprintSpeed: 5.2,
    preferredRange: 18,
    eyeHeight: 1.7,
    capsuleRadius: 0.38,
    capsuleHalfHeight: 0.72,
    attackDamage: 10,
    attackInterval: 0.9,
    accuracy: 0.038,
    aggression: 0.55,
    caution: 0.4,
    score: 25,
  },
  elite: {
    health: 340,
    shield: 180,
    moveSpeed: 2.9,
    sprintSpeed: 5,
    preferredRange: 16,
    eyeHeight: 1.95,
    capsuleRadius: 0.45,
    capsuleHalfHeight: 0.85,
    attackDamage: 18,
    attackInterval: 0.8,
    accuracy: 0.028,
    aggression: 0.65,
    caution: 0.45,
    score: 70,
  },
  champion: {
    health: 900,
    shield: 400,
    moveSpeed: 2.7,
    sprintSpeed: 4.6,
    preferredRange: 14,
    eyeHeight: 2.35,
    capsuleRadius: 0.6,
    capsuleHalfHeight: 1.1,
    attackDamage: 30,
    attackInterval: 0.75,
    accuracy: 0.022,
    aggression: 0.8,
    caution: 0.3,
    score: 220,
  },
  boss: {
    health: 4200,
    shield: 1800,
    moveSpeed: 2.4,
    sprintSpeed: 4,
    preferredRange: 18,
    eyeHeight: 3.2,
    capsuleRadius: 0.95,
    capsuleHalfHeight: 1.6,
    attackDamage: 46,
    attackInterval: 0.7,
    accuracy: 0.02,
    aggression: 0.85,
    caution: 0.2,
    score: 900,
  },
};

function archetype(o: ArchetypeOverrides): EnemyArchetype {
  const base = RANK_BASE[o.rank];
  return {
    id: o.id,
    faction: o.faction,
    rank: o.rank,
    displayName: o.displayName,
    health: o.health ?? base.health!,
    shield: o.shield ?? base.shield!,
    shieldElement: (o.shieldElement ?? null) as DamageElement | null,
    moveSpeed: o.moveSpeed ?? base.moveSpeed!,
    sprintSpeed: o.sprintSpeed ?? base.sprintSpeed!,
    preferredRange: o.preferredRange ?? base.preferredRange!,
    eyeHeight: o.eyeHeight ?? base.eyeHeight!,
    capsuleRadius: o.capsuleRadius ?? base.capsuleRadius!,
    capsuleHalfHeight: o.capsuleHalfHeight ?? base.capsuleHalfHeight!,
    attackDamage: o.attackDamage ?? base.attackDamage!,
    attackInterval: o.attackInterval ?? base.attackInterval!,
    accuracy: o.accuracy ?? base.accuracy!,
    aggression: o.aggression ?? base.aggression!,
    caution: o.caution ?? base.caution!,
    flying: o.flying ?? false,
    score: o.score ?? base.score!,
    abilities: o.abilities ?? [],
  };
}

const LIST: EnemyArchetype[] = [
  // -- Nordic: heavy ice-blue armour, shield walls, hammers -----------------
  archetype({ id: 'nordic.thrall', faction: 'nordic', rank: 'minor', displayName: 'Thrall', preferredRange: 3, aggression: 0.95, caution: 0.05, moveSpeed: 4.6, sprintSpeed: 7.4, abilities: ['charge'] }),
  archetype({ id: 'nordic.raider', faction: 'nordic', rank: 'standard', displayName: 'Raider', preferredRange: 16, abilities: ['grenade'] }),
  archetype({ id: 'nordic.huscarl', faction: 'nordic', rank: 'elite', displayName: 'Huscarl', shieldElement: 'stasis', preferredRange: 6, aggression: 0.8, abilities: ['shieldWall', 'slam'] }),
  archetype({ id: 'nordic.jarl', faction: 'nordic', rank: 'champion', displayName: 'Jarl', shieldElement: 'stasis', abilities: ['slam', 'frostNova', 'summon'] }),
  archetype({ id: 'nordic.allfather', faction: 'nordic', rank: 'boss', displayName: 'The Allfather', shieldElement: 'stasis', abilities: ['frostNova', 'summon', 'spearVolley'] }),

  // -- Grey: violet psionics, hovering drones, thin bodies ------------------
  archetype({ id: 'grey.drone', faction: 'grey', rank: 'minor', displayName: 'Servitor Drone', flying: true, health: 45, preferredRange: 15, capsuleHalfHeight: 0.4, eyeHeight: 1.4 }),
  archetype({ id: 'grey.observer', faction: 'grey', rank: 'standard', displayName: 'Observer', flying: true, preferredRange: 22, caution: 0.6 }),
  archetype({ id: 'grey.psion', faction: 'grey', rank: 'elite', displayName: 'Psion', shieldElement: 'void', preferredRange: 20, caution: 0.65, abilities: ['mindBlast', 'blink'] }),
  archetype({ id: 'grey.overseer', faction: 'grey', rank: 'champion', displayName: 'Overseer', shieldElement: 'void', flying: true, abilities: ['mindBlast', 'shieldAllies'] }),
  archetype({ id: 'grey.overmind', faction: 'grey', rank: 'boss', displayName: 'Overmind', shieldElement: 'void', flying: true, abilities: ['mindBlast', 'summon', 'psionicStorm'] }),

  // -- Mantis: acid-green resin, four arms, blade limbs ---------------------
  archetype({ id: 'mantis.spawn', faction: 'mantis', rank: 'minor', displayName: 'Spawn', preferredRange: 2.5, aggression: 1, caution: 0.05, moveSpeed: 5.2, sprintSpeed: 8.2 }),
  archetype({ id: 'mantis.stalker', faction: 'mantis', rank: 'standard', displayName: 'Stalker', preferredRange: 3, aggression: 0.9, caution: 0.15, moveSpeed: 4.4, sprintSpeed: 7.6, abilities: ['pounce'] }),
  archetype({ id: 'mantis.reaper', faction: 'mantis', rank: 'elite', displayName: 'Reaper', shieldElement: 'arc', preferredRange: 3.5, abilities: ['pounce', 'bladeStorm'] }),
  archetype({ id: 'mantis.broodlord', faction: 'mantis', rank: 'champion', displayName: 'Broodlord', shieldElement: 'arc', abilities: ['bladeStorm', 'summon'] }),

  // -- Insectoid: amber chitin, six legs, ichor -----------------------------
  archetype({ id: 'insectoid.crawler', faction: 'insectoid', rank: 'minor', displayName: 'Crawler', preferredRange: 2.5, aggression: 1, caution: 0, moveSpeed: 5, sprintSpeed: 8, capsuleHalfHeight: 0.4, eyeHeight: 0.8 }),
  archetype({ id: 'insectoid.warrior', faction: 'insectoid', rank: 'standard', displayName: 'Hive Warrior', preferredRange: 4, aggression: 0.85, caution: 0.2 }),
  archetype({ id: 'insectoid.spitter', faction: 'insectoid', rank: 'standard', displayName: 'Spitter', preferredRange: 20, caution: 0.55, abilities: ['acidSpit'] }),
  archetype({ id: 'insectoid.tunneler', faction: 'insectoid', rank: 'elite', displayName: 'Tunneler', shieldElement: 'solar', preferredRange: 5, abilities: ['burrow', 'acidSpit'] }),
  archetype({ id: 'insectoid.hivequeen', faction: 'insectoid', rank: 'boss', displayName: 'Hive Queen', shieldElement: 'solar', abilities: ['summon', 'acidSpit', 'burrow'] }),

  // -- Reptilian: blood-red stone armour, ash, heavy weapons ----------------
  archetype({ id: 'reptilian.skink', faction: 'reptilian', rank: 'minor', displayName: 'Skink', preferredRange: 10, moveSpeed: 4.2, sprintSpeed: 6.8 }),
  archetype({ id: 'reptilian.saurian', faction: 'reptilian', rank: 'standard', displayName: 'Saurian', preferredRange: 17 }),
  archetype({ id: 'reptilian.warlord', faction: 'reptilian', rank: 'elite', displayName: 'Warlord', shieldElement: 'solar', abilities: ['flameBreath'] }),
  archetype({ id: 'reptilian.tyrant', faction: 'reptilian', rank: 'champion', displayName: 'Tyrant', shieldElement: 'solar', abilities: ['flameBreath', 'stomp'] }),

  // -- Reference species (also usable as live training targets) -------------
  archetype({ id: 'training.biped', faction: 'federation', rank: 'standard', displayName: 'Combat Drill Frame', health: 160, preferredRange: 14, eyeHeight: 1.72, capsuleRadius: 0.36, capsuleHalfHeight: 0.72, score: 5 }),
  archetype({ id: 'training.quadruped', faction: 'federation', rank: 'standard', displayName: 'Quadruped Drill Frame', health: 180, preferredRange: 6, moveSpeed: 4.6, sprintSpeed: 8, eyeHeight: 1.25, capsuleRadius: 0.44, capsuleHalfHeight: 0.55, score: 5 }),
  archetype({ id: 'training.hexapod', faction: 'federation', rank: 'minor', displayName: 'Hexapod Drill Frame', health: 90, preferredRange: 4, moveSpeed: 4.2, sprintSpeed: 7, eyeHeight: 0.85, capsuleRadius: 0.42, capsuleHalfHeight: 0.4, score: 5 }),
  archetype({ id: 'training.flyer', faction: 'federation', rank: 'minor', displayName: 'Aerial Drill Frame', health: 70, flying: true, preferredRange: 16, eyeHeight: 1.6, capsuleRadius: 0.34, capsuleHalfHeight: 0.4, score: 5 }),
];

export const ARCHETYPES: Record<string, EnemyArchetype> = Object.freeze(
  Object.fromEntries(LIST.map((a) => [a.id, a])),
);

/** Every archetype belonging to a faction, in catalogue order. */
export function archetypesOf(faction: FactionId): EnemyArchetype[] {
  return LIST.filter((a) => a.faction === faction);
}

/** Faction accent colours — the emissive language from the art direction. */
export const FACTION_ACCENT: Record<FactionId, number> = {
  federation: 0x64e2ff,
  nordic: 0x9fd8ff,
  grey: 0xb478ff,
  mantis: 0x9dff4a,
  insectoid: 0xffa53a,
  reptilian: 0xff4632,
};

/** Dissolve mode index consumed by the enemy material shader. */
export const FACTION_DISSOLVE: Record<FactionId, number> = {
  nordic: 0,
  grey: 1,
  mantis: 2,
  insectoid: 3,
  reptilian: 4,
  federation: 5,
};

// ---------------------------------------------------------------------------
// Reference species
// ---------------------------------------------------------------------------

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
 * Three values, not one: a dark structural hull, a light armour panel, and a
 * near-black trim. A body made of one material reads as a white blob at 20 m no
 * matter how good the normal map is — the value split is what gives silhouette
 * and panel breakup.
 */
function fedMaterials(ctx: BodyBuildContext): void {
  const b = ctx.builder;
  b.material('hull', 'fedHull', { color: 0x59636f, roughness: 0.52, metalness: 0.88 });
  b.material('panel', 'fedPanel', { color: 0x9aa6b3, roughness: 0.34, metalness: 0.7 });
  b.material('trim', 'fedTrim', { color: 0x252c34, roughness: 0.46, metalness: 0.95 });
  b.emissive('glow', FACTION_ACCENT.federation, 3.4);
}

// -- biped -------------------------------------------------------------------

/**
 * The reference humanoid. Two-bone leg IK, alternating gait, arms that
 * counter-swing, a head that tracks the player.
 */
function buildBiped(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  fedMaterials(ctx);

  // Hip height is deliberately ~88% of the leg's full extension. A rig whose
  // legs are straight when it stands cannot be foot-planted at any speed: the
  // step radius collapses to zero and the feet must slide. Always leave slack.
  rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'], [0.22, 0.28, 0.14, 0.13, 0.2], {
    origin: v(0, 0.98, 0),
    direction: UP,
    pole: FORWARD,
    kind: 'spine',
    restBend: [0, -0.06, 0.04, 0.02, 0],
    capture: [0.34, 0.34, 0.34, 0.2, 0.28],
  });

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(`leg.${s}`, ['hip', 'knee', 'ankle', 'toe'], [0.5, 0.47, 0.17, 0.11], {
      parent: 'spine.hips',
      origin: v(side * 0.155, -0.03, 0.01),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side,
      // Slight flex so IK never starts from a locked-straight singularity, then
      // the ankle swings the foot forward for the bind pose.
      restBend: [0.07, -0.16, 1.66],
      capture: [0.26, 0.22, 0.19, 0.16],
    });
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], [0.31, 0.28, 0.14], {
      parent: 'spine.chest',
      origin: v(side * 0.235, 0.07, 0),
      direction: v(side * 0.18, -1, 0).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.12, 0.3, 0.2],
      capture: [0.2, 0.17, 0.15],
    });
  }

  // -- geometry -------------------------------------------------------------
  const hips = at(rig, 'spine.hips');
  const lumbar = at(rig, 'spine.lumbar');
  const chest = at(rig, 'spine.chest');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTop = tipOf(rig, 'spine');

  b.add('hull', b.segment({ from: hips.clone().setY(hips.y - 0.09), to: lumbar, r0: 0.19, r1: 0.17, flatten: 0.72, sides: 12 }));
  b.add('hull', b.taperedLimb({ from: lumbar, to: chest, r0: 0.17, r1: 0.21, flatten: 0.68, muscle: 1.05, jointR: 0.2, sides: 12 }));
  b.add('panel', b.segment({ from: neck.clone().setY(neck.y - 0.05), to: head, r0: 0.085, r1: 0.075, sides: 9 }));

  // Chest cuirass and back plate: the silhouette's widest, hardest read.
  b.add('panel', b.plate({ centre: chest.clone().add(v(0, 0.02, -0.155)), normal: FORWARD, width: 0.44, height: 0.4, thickness: 0.035, curve: 1.35, taper: 0.86, color: 0xf2f6fa, edgeColor: 0x8f9aa6 }));
  b.add('panel', b.plate({ centre: chest.clone().add(v(0, -0.02, 0.16)), normal: v(0, 0.05, 1), width: 0.4, height: 0.36, thickness: 0.03, curve: 1.2, taper: 0.9, color: 0xd2dae2, edgeColor: 0x828d99 }));
  b.add('trim', b.vent({ centre: chest.clone().add(v(0, 0.02, 0.175)), normal: v(0, 0.05, 1), width: 0.2, height: 0.16, depth: 0.05, slats: 4 }));
  b.add('glow', b.lens({ centre: chest.clone().add(v(0, 0.03, -0.175)), normal: FORWARD, radius: 0.055, bulge: 0.5 }));

  // Helmet: a domed carapace with a visor band and a crest that breaks the
  // round outline — a bare dome reads as a ball on a stick at 30 m.
  b.add('panel', b.carapace({ centre: head.clone().add(v(0, -0.05, 0)), radius: 0.135, height: 0.23, length: 0.94, segments: 12 }));
  b.add('hull', b.segment({ from: head.clone().add(v(0, -0.08, 0)), to: head.clone().add(v(0, 0.02, -0.05)), r0: 0.13, r1: 0.115, flatten: 0.92, sides: 10 }));
  b.add('glow', b.lens({ centre: head.clone().add(v(0, -0.01, -0.115)), normal: v(0, -0.1, -1), radius: 0.072, bulge: 0.42 }));
  b.add('trim', b.spine({ base: head.clone().add(v(0, 0.04, 0.02)), direction: v(0, 0.75, 0.66), length: 0.2, radius: 0.035, curve: 0.03 }));
  b.add('trim', b.spine({ base: headTop.clone().add(v(0, -0.12, -0.02)), direction: v(0, 1, -0.15), length: 0.12, radius: 0.026, curve: 0.01 }));

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    const shoulder = at(rig, `arm.${s}.shoulder`);
    const elbow = at(rig, `arm.${s}.elbow`);
    const wrist = at(rig, `arm.${s}.wrist`);
    const hand = tipOf(rig, `arm.${s}`);
    const hip = at(rig, `leg.${s}.hip`);
    const knee = at(rig, `leg.${s}.knee`);
    const ankle = at(rig, `leg.${s}.ankle`);
    const toe = at(rig, `leg.${s}.toe`);
    const toeTip = tipOf(rig, `leg.${s}`);

    b.add('hull', b.taperedLimb({ from: shoulder, to: elbow, r0: 0.082, r1: 0.062, jointR: 0.088, muscle: 1.2 }));
    b.add('hull', b.taperedLimb({ from: elbow, to: wrist, r0: 0.065, r1: 0.05, jointR: 0.07, muscle: 1.12 }));
    b.add('panel', b.plate({ centre: shoulder.clone().add(v(side * 0.055, 0.03, 0)), normal: v(side, 0.42, 0).normalize(), up: v(0, 0, -1), width: 0.28, height: 0.24, thickness: 0.03, curve: 1.5, taper: 0.78, color: 0xeff4f8, edgeColor: 0x77828e }));
    b.add('hull', b.segment({ from: wrist, to: hand, r0: 0.052, r1: 0.04, flatten: 0.7, sides: 8 }));
    for (let d = 0; d < 3; d++) {
      b.add('hull', b.digit({
        base: hand.clone().add(v(side * (d - 1) * 0.022, 0.005, -0.01)),
        direction: v(side * (d - 1) * 0.2, -0.9, -0.4).normalize(),
        length: 0.075,
        radius: 0.014,
        joints: 2,
        curl: 0.4,
      }));
    }

    b.add('hull', b.taperedLimb({ from: hip, to: knee, r0: 0.125, r1: 0.092, jointR: 0.132, muscle: 1.22, flatten: 0.92 }));
    b.add('hull', b.taperedLimb({ from: knee, to: ankle, r0: 0.096, r1: 0.062, jointR: 0.1, muscle: 1.14, flatten: 0.9 }));
    b.add('panel', b.plate({ centre: knee.clone().add(v(0, 0.02, -0.085)), normal: FORWARD, width: 0.19, height: 0.2, thickness: 0.024, curve: 1.5, taper: 0.72, color: 0xdae2ea, edgeColor: 0x717c88 }));
    b.add('panel', b.plate({ centre: hip.clone().add(v(side * 0.03, -0.12, -0.09)), normal: v(side * 0.4, 0, -1).normalize(), width: 0.2, height: 0.28, thickness: 0.025, curve: 1.0, taper: 0.8, color: 0xccd6e0, edgeColor: 0x6c7783 }));
    b.add('hull', b.segment({ from: ankle.clone().add(v(0, 0.01, 0.03)), to: toe, r0: 0.075, r1: 0.062, flatten: 0.78, sides: 8 }));
    b.add('hull', b.segment({ from: toe, to: toeTip, r0: 0.062, r1: 0.038, flatten: 0.72, sides: 8 }));
    b.add('glow', b.lens({ centre: shoulder.clone().add(v(side * 0.075, 0.05, -0.03)), normal: v(side, 0.35, -0.3).normalize(), radius: 0.028, bulge: 0.6 }));
  }

  // A right-arm hard-point, so the frame reads as armed in silhouette.
  const rWrist = at(rig, 'arm.R.wrist');
  b.add('trim', b.weaponMount({
    base: rWrist.clone().add(v(0.03, -0.02, -0.02)),
    direction: v(0.05, -0.25, -1).normalize(),
    length: 0.42,
    radius: 0.036,
    bracket: 0.11,
  }));

  return {
    rig,
    parts: b.finish(),
    height: 1.95,
    headBone: 'spine.head',
    muzzleBone: 'arm.R.wrist',
    accentColor: FACTION_ACCENT.federation,
    shieldRadius: 1.0,
    tuning: { runSpeed: 6, strideScale: 0.62, kneeSign: 1, bob: 0.05, sway: 0.032 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.17, multiplier: 2.2 },
      { region: 'body', bone: 'spine.chest', radius: 0.3, halfHeight: 0.2, multiplier: 1 },
      { region: 'body', bone: 'spine.hips', radius: 0.24, halfHeight: 0.14, multiplier: 1 },
      { region: 'limb', bone: 'arm.L.elbow', radius: 0.13, multiplier: 0.65 },
      { region: 'limb', bone: 'arm.R.elbow', radius: 0.13, multiplier: 0.65 },
      { region: 'limb', bone: 'leg.L.knee', radius: 0.15, multiplier: 0.65 },
      { region: 'limb', bone: 'leg.R.knee', radius: 0.15, multiplier: 0.65 },
      { region: 'critSpot', bone: 'spine.lumbar', offset: v(0, 0.1, 0.18), radius: 0.11, multiplier: 3 },
    ],
  };
}

// -- quadruped ---------------------------------------------------------------

/** Digitigrade four-legged frame: FABRIK legs, diagonal trot, a lagging tail. */
function buildQuadruped(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  fedMaterials(ctx);

  rig.chain('spine', ['hips', 'back', 'chest', 'neck', 'head'], [0.42, 0.42, 0.3, 0.26, 0.3], {
    origin: v(0, 1.06, 0.56),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    // The neck climbs out of the shoulders and the skull levels off — without
    // that two-stage break the head buries itself in the chest carapace.
    restBend: [0, 0.02, 0.62, 0.32, -0.62],
    capture: [0.44, 0.44, 0.38, 0.22, 0.26],
  });
  rig.chain('tail', ['t0', 't1', 't2', 't3'], [0.22, 0.2, 0.17, 0.12], {
    parent: 'spine.hips',
    origin: v(0, 0.06, 0.1),
    direction: v(0, -0.1, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.16, 0.14, 0.12, 0.1],
  });

  const legDefs: Array<[string, string, number, number]> = [
    ['leg.FL', 'spine.chest', -1, -0.12],
    ['leg.FR', 'spine.chest', 1, -0.12],
    ['leg.BL', 'spine.hips', -1, 0.1],
    ['leg.BR', 'spine.hips', 1, 0.1],
  ];
  for (const [id, parent, side, dz] of legDefs) {
    rig.chain(id, ['hip', 'knee', 'hock', 'ankle', 'toe'], [0.38, 0.36, 0.3, 0.12, 0.09], {
      parent,
      origin: v(side * 0.2, -0.08, dz),
      direction: DOWN,
      pole: FORWARD,
      kind: 'leg',
      side: side as -1 | 1,
      restBend: [0.3, -0.62, 0.62, 1.18],
      capture: [0.2, 0.17, 0.15, 0.12, 0.1],
    });
  }

  const hips = at(rig, 'spine.hips');
  const back = at(rig, 'spine.back');
  const chest = at(rig, 'spine.chest');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  b.add('hull', b.taperedLimb({ from: hips.clone().add(v(0, 0, 0.14)), to: back, r0: 0.2, r1: 0.23, flatten: 0.9, jointR: 0.22, muscle: 1.05, sides: 12 }));
  b.add('hull', b.taperedLimb({ from: back, to: chest, r0: 0.23, r1: 0.25, flatten: 0.88, jointR: 0.25, muscle: 1.05, sides: 12 }));
  b.add('hull', b.taperedLimb({ from: chest, to: neck, r0: 0.2, r1: 0.12, flatten: 0.9, jointR: 0.19, muscle: 1.05, sides: 10 }));
  b.add('hull', b.segment({ from: neck, to: head, r0: 0.12, r1: 0.115, sides: 9 }));
  // A snout: the single cheapest thing that turns a quadruped shell into a head.
  b.add('hull', b.segment({ from: head, to: headTip, r0: 0.11, r1: 0.055, flatten: 0.82, bulge: 1.06, sides: 9 }));
  b.add('trim', b.mandible({ base: head.clone().add(v(0, -0.06, -0.02)), direction: headTip.clone().sub(head).normalize(), inward: v(0, -1, 0), length: 0.24, thickness: 0.035, flatten: 0.5, serrations: 5 }));
  b.add('panel', b.carapace({ centre: back.clone().add(v(0, 0.06, 0)), radius: 0.26, height: 0.2, length: 1.5, ridges: 5, ridgeDepth: 0.06, direction: UP }));
  b.add('panel', b.carapace({ centre: head.clone().add(v(0, 0.04, -0.02)), radius: 0.125, height: 0.24, length: 0.78, direction: v(0, 0.55, -0.84).normalize() }));
  b.add('glow', b.lens({ centre: headTip.clone().add(v(-0.05, 0.03, 0.02)), normal: v(-0.6, 0.3, -0.75).normalize(), radius: 0.035, bulge: 0.6 }));
  b.add('glow', b.lens({ centre: headTip.clone().add(v(0.05, 0.03, 0.02)), normal: v(0.6, 0.3, -0.75).normalize(), radius: 0.035, bulge: 0.6 }));
  b.add('trim', b.horn({ base: head.clone().add(v(0, 0.08, 0.04)), direction: v(0, 0.6, 0.8).normalize(), length: 0.26, radius: 0.03, curve: 0.06, ridges: 5 }));

  for (const [id] of legDefs) {
    const hip = at(rig, `${id}.hip`);
    const knee = at(rig, `${id}.knee`);
    const hock = at(rig, `${id}.hock`);
    const ankle = at(rig, `${id}.ankle`);
    const toe = at(rig, `${id}.toe`);
    const tip = tipOf(rig, id);
    b.add('hull', b.taperedLimb({ from: hip, to: knee, r0: 0.105, r1: 0.08, jointR: 0.112, muscle: 1.3 }));
    b.add('hull', b.taperedLimb({ from: knee, to: hock, r0: 0.082, r1: 0.056, jointR: 0.088, muscle: 1.15 }));
    b.add('hull', b.taperedLimb({ from: hock, to: ankle, r0: 0.056, r1: 0.04, jointR: 0.06, muscle: 1.05 }));
    b.add('hull', b.segment({ from: ankle, to: toe, r0: 0.042, r1: 0.038, flatten: 0.75, sides: 7 }));
    b.add('trim', b.digit({ base: toe, direction: v(0, -0.35, -1).normalize(), length: 0.09, radius: 0.016, joints: 2, curl: 0.5 }));
    void tip;
  }

  const tail = ['tail.t0', 'tail.t1', 'tail.t2', 'tail.t3'];
  for (let i = 0; i < tail.length - 1; i++) {
    b.add('hull', b.segment({ from: at(rig, tail[i]), to: at(rig, tail[i + 1]), r0: 0.075 - i * 0.017, r1: 0.06 - i * 0.016, sides: 8 }));
  }
  b.add('trim', b.spine({ base: at(rig, 'tail.t3'), direction: v(0, -0.2, 1).normalize(), length: 0.16, radius: 0.03 }));

  return {
    rig,
    parts: b.finish(),
    height: 1.3,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: FACTION_ACCENT.federation,
    shieldRadius: 1.0,
    tuning: { runSpeed: 8, strideScale: 0.7, kneeSign: 1, bob: 0.035, sway: 0.012, liftScale: 0.3 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.15, multiplier: 2 },
      { region: 'body', bone: 'spine.back', radius: 0.3, halfHeight: 0.22, multiplier: 1 },
      { region: 'body', bone: 'spine.chest', radius: 0.28, multiplier: 1 },
      { region: 'limb', bone: 'leg.FL.knee', radius: 0.12, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.FR.knee', radius: 0.12, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.BL.knee', radius: 0.12, multiplier: 0.6 },
      { region: 'limb', bone: 'leg.BR.knee', radius: 0.12, multiplier: 0.6 },
    ],
  };
}

// -- hexapod -----------------------------------------------------------------

/** Six splayed legs on an alternating tripod, with mandibles and a shell. */
function buildHexapod(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  fedMaterials(ctx);

  rig.chain('spine', ['abdomen', 'thorax', 'neck', 'head'], [0.44, 0.34, 0.2, 0.2], {
    origin: v(0, 0.78, 0.46),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    restBend: [0, 0.12, 0.1, -0.2],
    capture: [0.4, 0.34, 0.2, 0.22],
  });

  // Three leg rows spread over ~0.8 m of thorax. Clustering them at one point
  // is what makes a hexapod read as a spider bunched into a ball.
  const rows: Array<[number, number, number]> = [
    [0, -0.36, 1.0],
    [1, 0.0, 0.2],
    [2, 0.34, -0.55],
  ];
  for (const [row, dz, splayZ] of rows) {
    for (const side of [-1, 1] as const) {
      const id = `leg.${side < 0 ? 'L' : 'R'}${row}`;
      rig.chain(id, ['coxa', 'femur', 'tibia', 'tarsus'], [0.34, 0.38, 0.16, 0.11], {
        parent: 'spine.thorax',
        origin: v(side * 0.22, -0.02, dz),
        direction: v(side * 0.78, -0.42, splayZ * 0.4).normalize(),
        pole: UP,
        kind: 'leg',
        side,
        restBend: [-0.5, 1.7, 0.45],
        capture: [0.17, 0.15, 0.12, 0.1],
      });
    }
  }

  const abdomen = at(rig, 'spine.abdomen');
  const thorax = at(rig, 'spine.thorax');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  b.add('hull', b.taperedLimb({ from: abdomen.clone().add(v(0, -0.02, 0.3)), to: thorax, r0: 0.16, r1: 0.26, flatten: 0.85, jointR: 0.26, muscle: 1.12, sides: 12 }));
  b.add('panel', b.carapace({ centre: abdomen.clone().add(v(0, 0.05, 0.06)), radius: 0.24, height: 0.2, length: 1.35, ridges: 6, ridgeDepth: 0.09, direction: UP }));
  b.add('panel', b.carapace({ centre: thorax.clone().add(v(0, 0.05, 0.02)), radius: 0.23, height: 0.18, length: 1.2, ridges: 4, ridgeDepth: 0.07, direction: UP }));
  b.add('hull', b.segment({ from: thorax, to: neck, r0: 0.16, r1: 0.1, sides: 9 }));
  b.add('hull', b.segment({ from: neck, to: head, r0: 0.1, r1: 0.12, bulge: 1.15, sides: 10 }));
  b.add('glow', b.lens({ centre: head.clone().add(v(-0.07, 0.04, -0.06)), normal: v(-0.7, 0.3, -0.65).normalize(), radius: 0.042, bulge: 0.7 }));
  b.add('glow', b.lens({ centre: head.clone().add(v(0.07, 0.04, -0.06)), normal: v(0.7, 0.3, -0.65).normalize(), radius: 0.042, bulge: 0.7 }));
  for (const side of [-1, 1] as const) {
    b.add('trim', b.mandible({
      base: head.clone().add(v(side * 0.06, -0.03, -0.06)),
      direction: v(side * 0.28, -0.16, -1).normalize(),
      inward: v(-side, 0, 0),
      length: 0.24,
      thickness: 0.03,
      flatten: 0.4,
      serrations: 4,
    }));
    b.add('trim', b.spine({ base: thorax.clone().add(v(side * 0.14, 0.14, 0.06)), direction: v(side * 0.4, 0.85, 0.3).normalize(), length: 0.19, radius: 0.028 }));
  }
  void headTip;

  for (const [row] of rows) {
    for (const side of [-1, 1] as const) {
      const id = `leg.${side < 0 ? 'L' : 'R'}${row}`;
      const coxa = at(rig, `${id}.coxa`);
      const femur = at(rig, `${id}.femur`);
      const tibia = at(rig, `${id}.tibia`);
      const tarsus = at(rig, `${id}.tarsus`);
      const tip = tipOf(rig, id);
      b.add('hull', b.taperedLimb({ from: coxa, to: femur, r0: 0.055, r1: 0.042, jointR: 0.062, muscle: 1.25 }));
      b.add('hull', b.taperedLimb({ from: femur, to: tibia, r0: 0.044, r1: 0.03, jointR: 0.05, muscle: 1.1 }));
      b.add('trim', b.digit({ base: tibia, direction: tarsus.clone().sub(tibia).normalize(), length: tarsus.distanceTo(tibia) + 0.06, radius: 0.02, joints: 2, curl: 0.25 }));
      void tip;
    }
  }

  return {
    rig,
    parts: b.finish(),
    height: 0.95,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: FACTION_ACCENT.federation,
    shieldRadius: 0.85,
    tuning: { runSpeed: 7, strideScale: 0.55, bob: 0.02, sway: 0.006, liftScale: 0.28, breathAmount: 0.02 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.14, multiplier: 2 },
      { region: 'body', bone: 'spine.thorax', radius: 0.26, multiplier: 1 },
      { region: 'critSpot', bone: 'spine.abdomen', radius: 0.22, multiplier: 2.5 },
    ],
  };
}

// -- flyer -------------------------------------------------------------------

/** A hovering frame: wing beat driven by thrust, banking into turns. */
function buildFlyer(ctx: BodyBuildContext): BuiltBody {
  const rig = ctx.rig;
  const b = ctx.builder;
  fedMaterials(ctx);

  rig.chain('spine', ['core', 'chest', 'head'], [0.3, 0.2, 0.2], {
    origin: v(0, 1.3, 0.16),
    direction: FORWARD,
    pole: UP,
    kind: 'spine',
    restBend: [0, 0.1, -0.1],
    capture: [0.4, 0.34, 0.26],
  });
  for (const side of [-1, 1] as const) {
    rig.chain(`wing.${side < 0 ? 'L' : 'R'}`, ['root', 'mid', 'tip'], [0.34, 0.34, 0.24], {
      parent: 'spine.chest',
      origin: v(side * 0.14, 0.06, 0.02),
      direction: v(side, 0.18, 0.1).normalize(),
      pole: UP,
      kind: 'wing',
      side,
      restBend: [0, -0.18, -0.12],
      capture: [0.3, 0.3, 0.26],
    });
  }
  rig.chain('tail', ['t0', 't1', 't2'], [0.18, 0.16, 0.1], {
    parent: 'spine.core',
    origin: v(0, -0.02, 0.06),
    direction: v(0, -0.3, 1).normalize(),
    pole: UP,
    kind: 'tail',
    capture: [0.14, 0.12, 0.1],
  });

  const core = at(rig, 'spine.core');
  const chest = at(rig, 'spine.chest');
  const head = at(rig, 'spine.head');
  const headTip = tipOf(rig, 'spine');

  b.add('hull', b.taperedLimb({ from: core.clone().add(v(0, 0, 0.16)), to: chest, r0: 0.16, r1: 0.19, flatten: 0.8, jointR: 0.19, muscle: 1.1, sides: 12 }));
  b.add('hull', b.segment({ from: chest, to: head, r0: 0.14, r1: 0.1, bulge: 1.05, sides: 10 }));
  b.add('panel', b.carapace({ centre: chest.clone().add(v(0, 0.04, 0.02)), radius: 0.2, height: 0.16, length: 1.25, ridges: 4, ridgeDepth: 0.08, direction: UP }));
  b.add('glow', b.lens({ centre: headTip.clone().add(v(0, 0.02, 0.03)), normal: v(0, 0.15, -1).normalize(), radius: 0.075, bulge: 0.5 }));
  b.add('trim', b.horn({ base: head.clone().add(v(0, 0.08, 0.05)), direction: v(0, 0.5, 0.86).normalize(), length: 0.2, radius: 0.026, curve: 0.05, ridges: 4 }));

  for (const side of [-1, 1] as const) {
    const id = `wing.${side < 0 ? 'L' : 'R'}`;
    const root = at(rig, `${id}.root`);
    const mid = at(rig, `${id}.mid`);
    const tip = at(rig, `${id}.tip`);
    const end = tipOf(rig, id);
    // Spar + membrane: the membrane is a flattened loft so it reads as a wing
    // rather than three sticks.
    b.add('hull', b.taperedLimb({ from: root, to: mid, r0: 0.05, r1: 0.038, jointR: 0.055, muscle: 1.15 }));
    b.add('hull', b.taperedLimb({ from: mid, to: tip, r0: 0.036, r1: 0.026, jointR: 0.04, muscle: 1.1 }));
    b.add('panel', b.segment({ from: root.clone().add(v(0, 0, 0.02)), to: end, r0: 0.17, r1: 0.05, flatten: 0.09, bend: 0.1, bendAxis: v(0, 0, 1), sides: 8, steps: 8, color: 0xb9c6d2 }));
    b.add('trim', b.spine({ base: tip, direction: v(side * 0.5, -0.2, 0.85).normalize(), length: 0.15, radius: 0.02 }));
  }

  const tailBones = ['tail.t0', 'tail.t1', 'tail.t2'];
  for (let i = 0; i < tailBones.length - 1; i++) {
    b.add('hull', b.segment({ from: at(rig, tailBones[i]), to: at(rig, tailBones[i + 1]), r0: 0.055 - i * 0.014, r1: 0.045 - i * 0.014, sides: 7 }));
  }

  return {
    rig,
    parts: b.finish(),
    height: 0.9,
    headBone: 'spine.head',
    muzzleBone: 'spine.head',
    accentColor: FACTION_ACCENT.federation,
    shieldRadius: 0.9,
    tuning: { wingRate: 2.4, wingAmplitude: 0.95, breathAmount: 0.015, leanTurn: 0.5 },
    hitProxies: [
      { region: 'head', bone: 'spine.head', radius: 0.14, multiplier: 2 },
      { region: 'body', bone: 'spine.core', radius: 0.24, multiplier: 1 },
      { region: 'critSpot', bone: 'spine.chest', radius: 0.16, multiplier: 2.5 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function species(id: string, build: (ctx: BodyBuildContext) => BuiltBody): SpeciesDefinition {
  const a = ARCHETYPES[id];
  return {
    archetype: a,
    build,
    behaviour: () => standardCombatBehaviour(a),
  };
}

let registered = false;

/**
 * Register the reference species. Idempotent, and called by `EnemyManager`'s
 * constructor so the training frames are always available to the capture
 * harness and to level designers without an import dance.
 */
export function registerReferenceSpecies(): void {
  if (registered) return;
  registered = true;
  registerSpecies(species('training.biped', buildBiped));
  registerSpecies(species('training.quadruped', buildQuadruped));
  registerSpecies(species('training.hexapod', buildHexapod));
  registerSpecies(species('training.flyer', buildFlyer));
}

/** Exported so faction owners can build on the reference bodies directly. */
export const REFERENCE_BUILDERS = {
  biped: buildBiped,
  quadruped: buildQuadruped,
  hexapod: buildHexapod,
  flyer: buildFlyer,
};

/** Deterministic per-species RNG seed, so bodies are identical every boot. */
export function speciesSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export { Rng };
