/**
 * Ability data.
 *
 * Three subclasses, each a *complete kit* rather than a list of powers: two
 * grenades, a melee, a class ability and a super that all push the same
 * gameplay verb.
 *
 *  - **Solar** is about *stacking then spending*. Everything applies burn;
 *    burn stacks to an ignition that chains. Kills heal, so the reward for
 *    playing aggressively is the resource you need to keep playing aggressively.
 *  - **Arc** is about *chaining and momentum*. Damage jumps between targets, and
 *    kills grant speed, so the fantasy is a fight that accelerates.
 *  - **Void** is about *control and attrition*. Suppress stops an enemy acting,
 *    weaken makes it take more, invisibility resets a fight you were losing, and
 *    kills return health.
 *
 * Cooldowns are long by shooter standards and deliberately so — an ability the
 * player can spam is an ability they stop thinking about.
 */
import type { AbilityDefinition, DamageElement, SurfaceKind } from '@/types';
import type { StatusKind } from '../StatusEffects';

export type SubclassId = 'solar' | 'arc' | 'void';

// ---------------------------------------------------------------------------
// Grenades
// ---------------------------------------------------------------------------

export interface GrenadeSpec {
  id: string;
  displayName: string;
  element: DamageElement;
  cooldown: number;
  charges: number;
  /** Direct impact damage. */
  damage: number;
  splashDamage: number;
  splashRadius: number;
  /** Seconds from throw to detonation. 0 = detonate on first contact. */
  fuse: number;
  /** True to stick to the first surface hit. */
  sticky: boolean;
  /** Bounce restitution; 0 = dead drop. */
  restitution: number;
  /** Rolling/sliding friction per bounce. */
  friction: number;
  /** Throw speed at zero charge and at full charge, m/s. */
  minSpeed: number;
  maxSpeed: number;
  /** Seconds of hold to reach full charge. */
  chargeTime: number;
  /** Collision radius. */
  radius: number;
  /** Status applied inside the blast. */
  status: StatusKind | null;
  statusStacks: number;
  statusDuration: number;
  /**
   * Lingering field: seconds the grenade keeps pulsing after detonation, and
   * the damage per pulse. 0 disables.
   */
  fieldDuration: number;
  fieldTick: number;
  fieldDamage: number;
  fieldRadius: number;
  /** Trail and blast colour. */
  color: number;
  /** Detonates on proximity to an enemy within this radius. 0 disables. */
  proximity: number;
  description: string;
}

const grenadeBase: Omit<GrenadeSpec, 'id' | 'displayName' | 'description'> = {
  element: 'kinetic',
  cooldown: 8,
  charges: 1,
  damage: 40,
  splashDamage: 110,
  splashRadius: 4.6,
  fuse: 1.35,
  sticky: false,
  restitution: 0.42,
  friction: 0.6,
  minSpeed: 13,
  maxSpeed: 26,
  chargeTime: 0.55,
  radius: 0.14,
  status: null,
  statusStacks: 0,
  statusDuration: 0,
  fieldDuration: 0,
  fieldTick: 0.5,
  fieldDamage: 0,
  fieldRadius: 0,
  color: 0xbfc8d4,
  proximity: 0,
};

export const GRENADES: Record<string, GrenadeSpec> = {
  'grenade.frag': {
    ...grenadeBase,
    id: 'grenade.frag',
    displayName: 'Fragmentation',
    description: 'A bouncing charge with a short fuse. Reliable, and yours whatever you wear.',
    element: 'kinetic',
    cooldown: 7.5,
    splashDamage: 120,
    splashRadius: 4.8,
    color: 0xd8dde6,
  },

  'grenade.incendiary': {
    ...grenadeBase,
    id: 'grenade.incendiary',
    displayName: 'Incendiary',
    description: 'Bursts into clinging fire. Two stacks of burn on everything caught.',
    element: 'solar',
    cooldown: 9,
    damage: 25,
    splashDamage: 78,
    splashRadius: 5,
    status: 'burn',
    statusStacks: 2,
    statusDuration: 5.5,
    fieldDuration: 4,
    fieldTick: 0.4,
    fieldDamage: 13,
    fieldRadius: 3.4,
    color: 0xff7a2a,
  },

  'grenade.thermite': {
    ...grenadeBase,
    id: 'grenade.thermite',
    displayName: 'Thermite',
    description: 'Detonates on impact into a line of burning slag that keeps working.',
    element: 'solar',
    cooldown: 9.5,
    fuse: 0,
    damage: 55,
    splashDamage: 60,
    splashRadius: 3.4,
    restitution: 0,
    minSpeed: 22,
    maxSpeed: 38,
    status: 'burn',
    statusStacks: 1,
    statusDuration: 6,
    fieldDuration: 6,
    fieldTick: 0.45,
    fieldDamage: 16,
    fieldRadius: 3,
    color: 0xffb04a,
  },

  'grenade.pulse': {
    ...grenadeBase,
    id: 'grenade.pulse',
    displayName: 'Pulse',
    description: 'Sticks where it lands and discharges four times. Shocks whatever survives.',
    element: 'arc',
    cooldown: 10,
    sticky: true,
    fuse: 0.5,
    damage: 30,
    splashDamage: 52,
    splashRadius: 4.2,
    status: 'shock',
    statusStacks: 1,
    statusDuration: 3,
    fieldDuration: 2.4,
    fieldTick: 0.6,
    fieldDamage: 46,
    fieldRadius: 4.2,
    color: 0x7fdcff,
  },

  'grenade.flux': {
    ...grenadeBase,
    id: 'grenade.flux',
    displayName: 'Flux',
    description: 'Arms on the ground and detonates the moment anything comes close.',
    element: 'arc',
    cooldown: 9,
    fuse: 6,
    proximity: 3.2,
    damage: 40,
    splashDamage: 145,
    splashRadius: 5,
    restitution: 0.25,
    status: 'shock',
    statusStacks: 1,
    statusDuration: 3.5,
    color: 0x9ce8ff,
  },

  'grenade.vortex': {
    ...grenadeBase,
    id: 'grenade.vortex',
    displayName: 'Vortex',
    description: 'Tears open a void well that suppresses and grinds down anything inside it.',
    element: 'void',
    cooldown: 11,
    fuse: 1.1,
    damage: 20,
    splashDamage: 62,
    splashRadius: 4,
    restitution: 0.15,
    status: 'suppress',
    statusStacks: 1,
    statusDuration: 3,
    fieldDuration: 6.5,
    fieldTick: 0.45,
    fieldDamage: 19,
    fieldRadius: 4.2,
    color: 0x9b6bff,
  },

  'grenade.suppressor': {
    ...grenadeBase,
    id: 'grenade.suppressor',
    displayName: 'Suppressor',
    description: 'Impact charge. Suppresses abilities and leaves the survivors weakened.',
    element: 'void',
    cooldown: 10,
    fuse: 0,
    damage: 62,
    splashDamage: 74,
    splashRadius: 6,
    restitution: 0,
    minSpeed: 20,
    maxSpeed: 34,
    status: 'suppress',
    statusStacks: 1,
    statusDuration: 4.5,
    color: 0xb08cff,
  },
};

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

export interface MeleeSpec {
  id: string;
  displayName: string;
  element: DamageElement;
  cooldown: number;
  /** Uncharged damage, and the charged (powered) variant. */
  damage: number;
  chargedDamage: number;
  /** Swing reach and the half-angle of the arc, radians. */
  range: number;
  arc: number;
  chargedArc: number;
  /** Seconds of wind-up before the hitbox opens, and how long it stays open. */
  windup: number;
  active: number;
  recover: number;
  /** Lunge: max distance and the acquisition cone. */
  lungeRange: number;
  lungeCone: number;
  lungeSpeed: number;
  /** Seconds the world holds still on a connect. */
  hitStop: number;
  chargedHitStop: number;
  /** Hold time to charge the powered melee. */
  chargeTime: number;
  status: StatusKind | null;
  statusStacks: number;
  /** Health returned per kill (Solar/Void kits). */
  healOnKill: number;
  /** Fraction of a target's max health under which a finisher is offered. */
  finisherThreshold: number;
  finisherSuperEnergy: number;
  color: number;
  surface: SurfaceKind;
  description: string;
}

const meleeBase: Omit<MeleeSpec, 'id' | 'displayName' | 'description'> = {
  element: 'kinetic',
  cooldown: 5.5,
  damage: 78,
  chargedDamage: 165,
  range: 2.6,
  arc: 0.7,
  chargedArc: 1.05,
  windup: 0.08,
  active: 0.12,
  recover: 0.24,
  lungeRange: 4.6,
  lungeCone: 0.55,
  lungeSpeed: 17,
  hitStop: 0.055,
  chargedHitStop: 0.11,
  chargeTime: 0.42,
  status: null,
  statusStacks: 0,
  healOnKill: 0,
  finisherThreshold: 0.28,
  finisherSuperEnergy: 0.09,
  color: 0xffffff,
  surface: 'flesh',
};

export const MELEES: Record<string, MeleeSpec> = {
  'melee.solar': {
    ...meleeBase,
    id: 'melee.solar',
    displayName: 'Igniting Strike',
    description: 'A burning uppercut. Applies burn; kills restore health.',
    element: 'solar',
    status: 'burn',
    statusStacks: 2,
    healOnKill: 34,
    color: 0xff8534,
  },
  'melee.arc': {
    ...meleeBase,
    id: 'melee.arc',
    displayName: 'Ball Lightning',
    description: 'A discharging palm strike that jumps to a second target. Kills grant speed.',
    element: 'arc',
    cooldown: 5,
    damage: 70,
    chargedDamage: 150,
    lungeRange: 5.4,
    lungeSpeed: 20,
    status: 'shock',
    statusStacks: 1,
    color: 0x8fe4ff,
  },
  'melee.void': {
    ...meleeBase,
    id: 'melee.void',
    displayName: 'Shadow Strike',
    description: 'A weakening slash. Kills return health and hide you for a moment.',
    element: 'void',
    cooldown: 6,
    damage: 82,
    chargedDamage: 175,
    status: 'weaken',
    statusStacks: 1,
    healOnKill: 28,
    color: 0xa87cff,
  },
};

// ---------------------------------------------------------------------------
// Class abilities
// ---------------------------------------------------------------------------

export interface ClassAbilitySpec {
  id: string;
  displayName: string;
  element: DamageElement;
  cooldown: number;
  charges: number;
  duration: number;
  /** What it does, mechanically. */
  kind: 'healRift' | 'speedSurge' | 'vanish';
  /** Magnitude: health per second, speed multiplier, or invisibility seconds. */
  magnitude: number;
  radius: number;
  color: number;
  description: string;
}

export const CLASS_ABILITIES: Record<string, ClassAbilitySpec> = {
  'class.solar': {
    id: 'class.solar',
    displayName: 'Sunspot',
    element: 'solar',
    cooldown: 22,
    charges: 1,
    duration: 9,
    kind: 'healRift',
    magnitude: 15,
    radius: 3.2,
    color: 0xff9040,
    description: 'Plant a burning well. It mends you while you stand in it and scorches anything else.',
  },
  'class.arc': {
    id: 'class.arc',
    displayName: 'Overcharge',
    element: 'arc',
    cooldown: 20,
    charges: 2,
    duration: 7,
    kind: 'speedSurge',
    magnitude: 1.35,
    radius: 0,
    color: 0x7fdcff,
    description: 'Dump the whole cell into your legs. Faster, and every hit shocks.',
  },
  'class.void': {
    id: 'class.void',
    displayName: 'Vanish',
    element: 'void',
    cooldown: 26,
    charges: 1,
    duration: 6,
    kind: 'vanish',
    magnitude: 6,
    radius: 0,
    color: 0x8b5cf6,
    description: 'Fold out of sight. Enemies lose you entirely until you fire.',
  },
};

// ---------------------------------------------------------------------------
// Supers
// ---------------------------------------------------------------------------

export interface SuperSpec {
  id: string;
  displayName: string;
  element: DamageElement;
  /** Seconds of wind-up before the super does anything. */
  windup: number;
  duration: number;
  /** Fraction of incoming damage negated while active. */
  resistance: number;
  /** Cadence of the super's damage tick. */
  interval: number;
  /** Damage per tick, and the shape of the tick. */
  damage: number;
  radius: number;
  range: number;
  /** Cone half-angle for directional supers. */
  cone: number;
  /** Extra super energy the player keeps per kill during the super. */
  refundOnKill: number;
  status: StatusKind | null;
  statusStacks: number;
  color: number;
  /** Light intensity and reach attached to the caster. */
  lightIntensity: number;
  lightRange: number;
  /** Camera roll amplitude, radians, and its frequency. */
  cameraRoll: number;
  cameraRollHz: number;
  description: string;
}

export const SUPERS: Record<string, SuperSpec> = {
  'super.solar': {
    id: 'super.solar',
    displayName: 'Daybreak',
    element: 'solar',
    windup: 0.85,
    duration: 12,
    resistance: 0.45,
    interval: 0.55,
    damage: 96,
    radius: 4.4,
    range: 34,
    cone: 0.34,
    refundOnKill: 0.012,
    status: 'burn',
    statusStacks: 2,
    color: 0xff8a2e,
    lightIntensity: 5.5,
    lightRange: 22,
    cameraRoll: 0.028,
    cameraRollHz: 0.6,
    description: 'Summon a blade of solar light and hurl arcs of fire until it burns out.',
  },
  'super.arc': {
    id: 'super.arc',
    displayName: 'Stormtrance',
    element: 'arc',
    windup: 0.7,
    duration: 10.5,
    resistance: 0.4,
    interval: 0.22,
    damage: 34,
    radius: 3,
    range: 18,
    cone: 0.55,
    refundOnKill: 0.014,
    status: 'shock',
    statusStacks: 1,
    color: 0x8fe4ff,
    lightIntensity: 4.5,
    lightRange: 20,
    cameraRoll: 0.045,
    cameraRollHz: 1.6,
    description: 'Become the storm. Lightning leaps from your hands and chains between targets.',
  },
  'super.void': {
    id: 'super.void',
    displayName: 'Spectral Bind',
    element: 'void',
    windup: 1,
    duration: 9,
    resistance: 0.55,
    interval: 0.4,
    damage: 58,
    radius: 5.5,
    range: 26,
    cone: 0.7,
    refundOnKill: 0.016,
    status: 'suppress',
    statusStacks: 1,
    color: 0x9b6bff,
    lightIntensity: 4,
    lightRange: 20,
    cameraRoll: 0.02,
    cameraRollHz: 0.35,
    description: 'Bind everything in front of you. Tethered targets are suppressed, weakened, and feed you.',
  },
};

// ---------------------------------------------------------------------------
// Subclasses
// ---------------------------------------------------------------------------

export interface Subclass {
  id: SubclassId;
  displayName: string;
  element: DamageElement;
  color: number;
  /** Grenades available; the first is equipped by default. */
  grenades: string[];
  melee: string;
  classAbility: string;
  super: string;
  /** Passive: health restored per ability kill. */
  healPerKill: number;
  /** Passive: seconds of a movement-speed buff granted per kill. */
  speedOnKill: number;
  speedMultiplier: number;
  description: string;
}

export const SUBCLASSES: Record<SubclassId, Subclass> = {
  solar: {
    id: 'solar',
    displayName: 'Sunbreaker',
    element: 'solar',
    color: 0xff8534,
    grenades: ['grenade.incendiary', 'grenade.thermite', 'grenade.frag'],
    melee: 'melee.solar',
    classAbility: 'class.solar',
    super: 'super.solar',
    healPerKill: 22,
    speedOnKill: 0,
    speedMultiplier: 1,
    description: 'Burn stacks into ignition, and every kill puts you back on your feet.',
  },
  arc: {
    id: 'arc',
    displayName: 'Stormcaller',
    element: 'arc',
    color: 0x7fdcff,
    grenades: ['grenade.pulse', 'grenade.flux', 'grenade.frag'],
    melee: 'melee.arc',
    classAbility: 'class.arc',
    super: 'super.arc',
    healPerKill: 0,
    speedOnKill: 5,
    speedMultiplier: 1.28,
    description: 'Damage jumps between targets and kills make the fight go faster.',
  },
  void: {
    id: 'void',
    displayName: 'Nightstalker',
    element: 'void',
    color: 0x9b6bff,
    grenades: ['grenade.vortex', 'grenade.suppressor', 'grenade.frag'],
    melee: 'melee.void',
    classAbility: 'class.void',
    super: 'super.void',
    healPerKill: 18,
    speedOnKill: 0,
    speedMultiplier: 1,
    description: 'Suppress, weaken, disappear. Attrition as a playstyle.',
  },
};

// ---------------------------------------------------------------------------
// The flat catalogue the UI and the HUD read
// ---------------------------------------------------------------------------

function def(
  id: string,
  slot: AbilityDefinition['slot'],
  displayName: string,
  element: DamageElement,
  cooldown: number,
  charges: number,
  cost: number,
  description: string,
): AbilityDefinition {
  return { id, slot, displayName, element, cooldown, charges, cost, description };
}

export const ABILITIES: Record<string, AbilityDefinition> = {};

for (const g of Object.values(GRENADES)) {
  ABILITIES[g.id] = def(
    g.id,
    'grenade',
    g.displayName,
    g.element,
    g.cooldown,
    g.charges,
    0,
    g.description,
  );
}
for (const m of Object.values(MELEES)) {
  ABILITIES[m.id] = def(m.id, 'melee', m.displayName, m.element, m.cooldown, 1, 0, m.description);
}
for (const c of Object.values(CLASS_ABILITIES)) {
  ABILITIES[c.id] = def(
    c.id,
    'class',
    c.displayName,
    c.element,
    c.cooldown,
    c.charges,
    0,
    c.description,
  );
}
for (const s of Object.values(SUPERS)) {
  ABILITIES[s.id] = def(s.id, 'super', s.displayName, s.element, 0, 1, 1, s.description);
}
