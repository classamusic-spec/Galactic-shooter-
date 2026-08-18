/**
 * The faction registry — the one import a level, a sandbox or a capture tool
 * needs in order to have every enemy in the game exist.
 *
 * ## Why this file has to exist
 *
 * The five faction modules were written by five different owners and they do
 * not agree on how registration happens, which is fine and was never worth
 * forcing:
 *
 * - `mantis` and `insectoid` self-register at module scope — a `for` loop over
 *   their archetype table runs on import — and expose
 *   `installMantisBehaviours(director)` / `installInsectoidBehaviours(director)`.
 * - `nordic`, `grey` and `reptilian` expose an idempotent
 *   `register*Species()` and a `register*Behaviours(director)`.
 *
 * Importing all five is therefore *necessary but not sufficient*: the
 * side-effecting modules need the import, the explicit ones need the call. This
 * module does both and hides the difference behind four functions.
 *
 * ## Order of operations for a level owner
 *
 * ```ts
 * registerAllFactions();                 // before the first EnemyManager.spawn
 * const enemies = engine.add(new EnemyManager(engine, materials, vfx));
 * enemies.bindLevel(level);
 * bindFactionSpawners(enemies);          // summoners, revives, boss adds
 * installFactionBehaviours(aiDirector);  // only if a director is driving
 * // ... teardown ...
 * disposeFactionEffects();
 * ```
 *
 * Every entry point is safe to call more than once and safe to call with a
 * host that does not implement everything — a faction whose seam is missing
 * degrades (no summons, no revives) rather than throwing.
 *
 * ## Ownership
 *
 * This file owns *no* enemy content. It is a wiring table, and it must stay
 * one: anything unit-specific belongs in the faction module that owns the unit.
 */
import type { DamageElement, FactionId } from '@/types';
import { ARCHETYPES } from '../Archetypes';

// Side-effecting imports first: `mantis` and `insectoid` register on load.
import {
  MANTIS_UNITS,
  bindMantisSpawner,
  disposeMantisEffects,
  installMantisBehaviours,
} from './mantis';
import {
  INSECT_UNITS,
  bindInsectoidSpawner,
  disposeInsectoidEffects,
  installInsectoidBehaviours,
} from './insectoid';
import {
  NORDIC_ARCHETYPES,
  disposeNordicRuntime,
  registerNordicBehaviours,
  registerNordicSpecies,
  setNordicSummoner,
} from './nordic';
import {
  GREY_ARCHETYPES,
  disposeGreyRuntime,
  registerGreyBehaviours,
  registerGreySpecies,
  setGreySummoner,
} from './grey';
import {
  REPT_UNITS,
  bindReptilianSpawner,
  disposeReptilianEffects,
  registerReptilianBehaviours,
  registerReptilianSpecies,
} from './reptilian';

// ---------------------------------------------------------------------------
// Structural views of the two hosts
// ---------------------------------------------------------------------------

/**
 * What `installFactionBehaviours` needs of an `AiDirector`. Declared
 * structurally so this module never imports the AI layer — `@/gameplay/ai`
 * already depends on the enemy layer, and importing it back would close a
 * cycle.
 */
interface BehaviourHost {
  registerBehaviour(archetypeId: string, tree: unknown): void;
}

/** What `bindFactionSpawners` needs of an `EnemyManager`. */
interface SpawnHost {
  spawn(archetypeId: string, position: unknown, yaw: number): unknown;
}

function isBehaviourHost(x: unknown): x is BehaviourHost {
  return !!x && typeof (x as BehaviourHost).registerBehaviour === 'function';
}

function isSpawnHost(x: unknown): x is SpawnHost {
  return !!x && typeof (x as SpawnHost).spawn === 'function';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let speciesRegistered = false;

/**
 * Make every enemy in the game spawnable. Idempotent — the flag here guards the
 * pair of explicit registrars that are not themselves cheap to re-enter, and
 * each of those is independently idempotent as well, so a second call from a
 * second level costs one boolean test.
 *
 * Must run before the first `EnemyManager.spawn`. It is deliberately *not* run
 * as an import side effect of this module: a caller that imports the registry
 * for `FACTION_IDENTITY` alone should not silently pay for it.
 */
export function registerAllFactions(): void {
  if (speciesRegistered) return;
  speciesRegistered = true;
  // Mantis and Insectoid registered themselves when this module imported them.
  registerNordicSpecies();
  registerGreySpecies();
  registerReptilianSpecies();
}

/**
 * Hand the AI director every faction's compiled behaviour trees. Safe to call
 * without a director (does nothing) and safe to call twice — `registerBehaviour`
 * overwrites by archetype id.
 */
export function installFactionBehaviours(director: unknown): void {
  if (!isBehaviourHost(director)) return;
  // Each faction's installer is typed against its own minimal host interface;
  // they are all the same single method, so one structural host serves them all.
  const host = director as never;
  installMantisBehaviours(host);
  installInsectoidBehaviours(host);
  registerNordicBehaviours(host);
  registerGreyBehaviours(host);
  registerReptilianBehaviours(host);
}

/**
 * Give the summoning units a way to put bodies on the field: Mantis clutches,
 * Insectoid broods, the Ashpriest's revive, and the Nordic/Grey bosses' adds.
 *
 * Pass the `EnemyManager` after `bindLevel()`. Pass `null` on teardown so a
 * disposed manager is never called into.
 */
export function bindFactionSpawners(host: unknown): void {
  if (host === null || host === undefined) {
    bindMantisSpawner(null);
    bindInsectoidSpawner(null);
    bindReptilianSpawner(null);
    setNordicSummoner(null);
    setGreySummoner(null);
    return;
  }
  if (!isSpawnHost(host)) return;
  const spawner = host as never;
  bindMantisSpawner(spawner);
  bindInsectoidSpawner(spawner);
  bindReptilianSpawner(spawner);
  // Nordic and Grey take a bound function rather than an object.
  const fn = ((id: string, position: never, yaw: number) => host.spawn(id, position, yaw)) as never;
  setNordicSummoner(fn);
  setGreySummoner(fn);
}

/**
 * Release every faction's shared pools, props and render targets. Call on level
 * teardown, before the scene is discarded.
 *
 * The spawner seams are cleared first: a faction effect that fires during
 * teardown must not be able to spawn into a manager that is going away.
 */
export function disposeFactionEffects(): void {
  bindFactionSpawners(null);
  disposeMantisEffects();
  disposeInsectoidEffects();
  disposeNordicRuntime();
  disposeGreyRuntime();
  disposeReptilianEffects();
}

// ---------------------------------------------------------------------------
// Rosters
// ---------------------------------------------------------------------------

/** Federation "units" are the reference drill frames from the shared catalogue. */
const FEDERATION_UNITS: string[] = Object.keys(ARCHETYPES).filter(
  (id) => ARCHETYPES[id].faction === 'federation',
);

/**
 * Every registered unit id, by faction, in roster order (minor → boss).
 *
 * These are the ids `EnemyManager.spawn` accepts. Catalogue aliases
 * (`reptilian.skink`, `mantis.drone`, …) are also registered by their modules
 * for older level scripts, but they are not listed here — this is the canonical
 * roster, and a tool that iterates it should show each unit exactly once.
 */
export const FACTION_UNITS: Record<FactionId, string[]> = {
  nordic: Object.keys(NORDIC_ARCHETYPES),
  grey: Object.keys(GREY_ARCHETYPES),
  mantis: [...MANTIS_UNITS],
  insectoid: [...INSECT_UNITS],
  reptilian: [...REPT_UNITS],
  federation: FEDERATION_UNITS,
};

/**
 * The player-facing identity of each faction: what it is called, what colour it
 * glows, what its shields are made of, what it bleeds, and how it comes apart.
 *
 * This is the table the UI, the codex, the loot roller and the VFX layer read
 * so they agree with each other without any of them importing a faction module.
 * `emissiveColor` matches `FACTION_ACCENT`; `dissolveStyle` names the mode the
 * enemy material shader selects via `FACTION_DISSOLVE`.
 */
export const FACTION_IDENTITY: Record<
  FactionId,
  {
    displayName: string;
    emissiveColor: number;
    shieldElement: DamageElement | null;
    bloodColor: number;
    description: string;
    dissolveStyle: string;
  }
> = {
  nordic: {
    displayName: 'Nordic Warhost',
    emissiveColor: 0x9fd8ff,
    shieldElement: 'stasis',
    bloodColor: 0x8f2434,
    description:
      'Rune-bound raiders out of the ice. They fight in a shield line, ward each ' +
      'other with stasis, and answer a flank by turning the whole wall to face it.',
    dissolveStyle: 'shatter',
  },
  grey: {
    displayName: 'Grey Collective',
    emissiveColor: 0xb478ff,
    shieldElement: 'void',
    bloodColor: 0x6f7f8c,
    description:
      'A hive intellect wearing bodies. Voids, blinks and psionic tethers; kill ' +
      'the mind that is thinking for them and the rest stop knowing where you are.',
    dissolveStyle: 'implode',
  },
  mantis: {
    displayName: 'Mantis Swarm',
    emissiveColor: 0x9dff4a,
    shieldElement: 'arc',
    bloodColor: 0x9dff4a,
    description:
      'Raptorial ambushers. Everything they do is a blade at the end of a leap, ' +
      'and everything they leave behind is acid.',
    dissolveStyle: 'burst',
  },
  insectoid: {
    displayName: 'Hive Insectoids',
    emissiveColor: 0xffa53a,
    shieldElement: 'arc',
    bloodColor: 0xffb347,
    description:
      'Numbers as a weapon. Individually trivial, collectively a tide, and always ' +
      'refilled from something larger further back.',
    dissolveStyle: 'slump',
  },
  reptilian: {
    displayName: 'Ash Legions',
    emissiveColor: 0xff4632,
    shieldElement: 'solar',
    bloodColor: 0x7d120a,
    description:
      'Saurian warriors off a volcanic world. The faction that punishes passive ' +
      'play: they close, they burn the cover you are behind, and they get ' +
      'brighter and faster as they die.',
    dissolveStyle: 'ash',
  },
  federation: {
    displayName: 'Federation',
    emissiveColor: 0x64e2ff,
    shieldElement: null,
    bloodColor: 0xc8d6e2,
    description:
      'Your own colours. Drill frames on the training deck, and whatever the ' +
      'Federation has lost control of since.',
    dissolveStyle: 'fade',
  },
};
