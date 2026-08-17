/**
 * The Ophiuchus Reach — five worlds, five hostile species.
 *
 * This file is pure data plus the level factory. Individual planet levels live
 * in sibling modules and are code-split so the star map boots instantly and a
 * surface only pays its cost when you actually fly there.
 */
import * as THREE from 'three';
import type { Level, PlanetDescriptor, PlanetId } from '@/types';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import type { EnemyManager } from '@/gameplay/enemies/EnemyManager';

export interface PlanetDeps {
  materials: MaterialLibrary;
  vfx: VfxSystem;
  enemies: EnemyManager;
}

export const PLANETS: readonly PlanetDescriptor[] = [
  {
    id: 'aurvangr',
    displayName: 'Aurvangr',
    subtitle: 'Frozen Marches · Jötunn Clans',
    faction: 'nordic',
    recommendedPower: 120,
    orbitRadius: 46,
    orbitSpeed: 0.055,
    radius: 3.4,
    color: 0x9fc4d8,
    atmosphereColor: 0x6fa8d0,
    description:
      'A tide-locked ice world in permanent low sun. The Jötunn clans raise rune-forged ' +
      'halls on the glacier shelf and answer every trespass with the axe. Federation ' +
      'survey teams stopped reporting eleven days ago.',
  },
  {
    id: 'zeta-reticuli',
    displayName: 'Zeta Reticuli IV',
    subtitle: 'Ashen Flats · The Custodians',
    faction: 'grey',
    recommendedPower: 145,
    orbitRadius: 66,
    orbitSpeed: 0.041,
    radius: 2.9,
    color: 0xb8b4c4,
    atmosphereColor: 0x8a7fb5,
    description:
      'A stripped grey desert under a near-black sky. The Custodians have been ' +
      'cataloguing this system for longer than the Federation has existed, and they ' +
      'do not consider us a party to the survey.',
  },
  {
    id: 'khepri',
    displayName: 'Khepri',
    subtitle: 'Acid Canopy · Bladed Broods',
    faction: 'mantis',
    recommendedPower: 170,
    orbitRadius: 88,
    orbitSpeed: 0.033,
    radius: 3.8,
    color: 0x7fa860,
    atmosphereColor: 0x9fd45f,
    description:
      'Vertical jungle over a corrosive floodplain. The Bladed Broods hunt from the ' +
      'canopy and do not miss twice. Keep to high ground and keep moving.',
  },
  {
    id: 'hive-prime',
    displayName: 'Hive Prime',
    subtitle: 'The Spore Reach · Unnumbered',
    faction: 'insectoid',
    recommendedPower: 195,
    orbitRadius: 112,
    orbitSpeed: 0.026,
    radius: 4.4,
    color: 0xb5813f,
    atmosphereColor: 0xd99a44,
    description:
      'The whole crust is one nest. There is no leadership to decapitate and no ' +
      'territory to hold — only the count, and the count is always rising.',
  },
  {
    id: 'draco-ix',
    displayName: 'Draco IX',
    subtitle: 'Cinder Basin · Saurian Legions',
    faction: 'reptilian',
    recommendedPower: 225,
    orbitRadius: 138,
    orbitSpeed: 0.019,
    radius: 4.1,
    color: 0x8f3a2c,
    atmosphereColor: 0xd4552c,
    description:
      'A volcanic forge world and the Legions’ staging ground. They have been ' +
      'massing for a push into Federation space. This is where it stops.',
  },
] as const;

export const PLANET_BY_ID: Readonly<Record<PlanetId, PlanetDescriptor>> = Object.freeze(
  Object.fromEntries(PLANETS.map((p) => [p.id, p])) as Record<PlanetId, PlanetDescriptor>,
);

/** Star-map ordering doubles as the intended campaign progression. */
export const CAMPAIGN_ORDER: readonly PlanetId[] = PLANETS.map((p) => p.id);

type LevelFactory = (deps: PlanetDeps, descriptor: PlanetDescriptor) => Level;

const FACTORIES = new Map<PlanetId, LevelFactory>();

/**
 * Planet modules register themselves here. Keeping the registry indirect means a
 * planet that fails to build cannot take the whole star map down with it.
 */
export function registerPlanet(id: PlanetId, factory: LevelFactory): void {
  FACTORIES.set(id, factory);
}

export function createPlanetLevel(id: PlanetId, deps: PlanetDeps): Level {
  const descriptor = PLANET_BY_ID[id];
  if (!descriptor) throw new Error(`Unknown planet "${id}"`);
  const factory = FACTORIES.get(id);
  if (!factory) throw new Error(`Planet "${id}" has no registered level factory`);
  return factory(deps, descriptor);
}

export function hasPlanetLevel(id: PlanetId): boolean {
  return FACTORIES.has(id);
}

/** Shared helper: a level's sun/fog colours as THREE.Color, from a descriptor. */
export function descriptorColors(d: PlanetDescriptor): {
  surface: THREE.Color;
  atmosphere: THREE.Color;
} {
  return {
    surface: new THREE.Color(d.color).convertSRGBToLinear(),
    atmosphere: new THREE.Color(d.atmosphereColor).convertSRGBToLinear(),
  };
}
