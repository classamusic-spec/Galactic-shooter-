/**
 * Game: the integration seam. Constructs every subsystem, wires the level
 * lifecycle, owns the star-map <-> planet flow, and installs the debug hooks
 * the automated visual critic drives.
 */
import * as THREE from 'three';
import type { Engine } from './Engine';
import type { Level, PlanetId, QualityTier } from '@/types';
import { events } from './EventBus';
import { settings } from './Settings';
import { PostFX } from '@/gfx/PostFX';
import { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { Player } from '@/gameplay/Player';
import { WeaponSystem } from '@/gameplay/weapons/WeaponSystem';
import { AbilitySystem } from '@/gameplay/abilities/AbilitySystem';
import { EnemyManager } from '@/gameplay/enemies/EnemyManager';
import { AiDirector } from '@/gameplay/ai/AiDirector';
import { LootSystem } from '@/gameplay/Loot';
import { UiRoot } from '@/ui/UiRoot';
import { audio } from './Audio';
import { PLANETS, createPlanetLevel } from '@/world/planets';
import { StarMap } from '@/world/StarMap';
import { Ship } from '@/world/Ship';

export interface GameContext {
  engine: Engine;
  materials: MaterialLibrary;
  vfx: VfxSystem;
  player: Player;
  weapons: WeaponSystem;
  abilities: AbilitySystem;
  enemies: EnemyManager;
  ai: AiDirector;
  loot: LootSystem;
  ui: UiRoot;
  postfx: PostFX;
  starmap: StarMap;
  ship: Ship;
  /** Load a planet surface level and hand control to the player. */
  travelTo(planet: PlanetId): Promise<void>;
  /** Return to the orbital star map. */
  openStarMap(): Promise<void>;
  currentPlanet: PlanetId | null;
}

let ctx: GameContext | null = null;

export function game(): GameContext {
  if (!ctx) throw new Error('Game not installed yet');
  return ctx;
}

export async function installGame(
  engine: Engine,
  onProgress: (t: number, label: string) => void,
): Promise<GameContext> {
  const renderer = engine.host.renderer;

  onProgress(0.02, 'Compiling materials');
  const materials = new MaterialLibrary(renderer);
  await materials.warmup();

  onProgress(0.18, 'Building post-process chain');
  const postfx = new PostFX(engine);

  onProgress(0.28, 'Priming effects');
  const vfx = engine.add(new VfxSystem(materials));

  onProgress(0.36, 'Synthesising audio');
  await audio.init();

  onProgress(0.46, 'Arming Guardian');
  const player = engine.add(new Player(engine));
  const weapons = engine.add(new WeaponSystem(engine, player, vfx));
  const abilities = engine.add(new AbilitySystem(engine, player, vfx));
  const enemies = engine.add(new EnemyManager(engine, materials, vfx));
  const ai = engine.add(new AiDirector(engine, enemies, player));
  const loot = engine.add(new LootSystem(engine, player, materials));

  onProgress(0.6, 'Raising interface');
  const ui = engine.add(new UiRoot(engine));

  onProgress(0.68, 'Charting the system');
  const starmap = new StarMap(engine, materials);
  const ship = new Ship(engine, materials);

  let currentPlanet: PlanetId | null = null;
  let lastTravelProfile: Record<string, number> = {};

  async function setLevel(level: Level, label: string): Promise<void> {
    engine.state = 'loading';
    ui.showLoading(true, label);
    await level.load((t, l) => ui.setLoadingProgress(t, l));
    engine.setLevel(level);
    postfx.onLevelChanged(level);
    vfx.attach(level.scene);
    // The player takes its collision world through bindCollision rather than the
    // bindLevel() every other system uses, and that asymmetry meant it was simply
    // never called: PlayerMovement.world stayed null, every collision path in the
    // movement solver is guarded behind `if (world)`, and the player free-fell
    // through the terrain on arrival. Binding here rather than in travelTo covers
    // every level, including the star map.
    player.bindCollision(level.collision);
    ui.showLoading(false, '');
  }

  const api: GameContext = {
    engine,
    materials,
    vfx,
    player,
    weapons,
    abilities,
    enemies,
    ai,
    loot,
    ui,
    postfx,
    starmap,
    ship,
    currentPlanet: null,
    async travelTo(planet: PlanetId) {
      const desc = PLANETS.find((p) => p.id === planet);
      if (!desc) throw new Error(`Unknown planet ${planet}`);
      const level = createPlanetLevel(planet, { materials, vfx, enemies });
      await setLevel(level, `Approaching ${desc.displayName}`);
      currentPlanet = planet;
      api.currentPlanet = planet;
      // Level entry is the one place the main thread blocks hard enough for the
      // page to look frozen, so every phase is timed and kept on
      // GF.debug.lastTravelProfile. Without this the only symptom a player can
      // report is "it hung", which is unactionable.
      const profile: Record<string, number> = {};
      const phase = <T>(name: string, fn: () => T): T => {
        const t0 = performance.now();
        const out = fn();
        profile[name] = Math.round(performance.now() - t0);
        return out;
      };

      const spawn = level.getSpawnPoint();
      phase('teleport', () => player.teleport(spawn.position, spawn.yaw));
      phase('enemies.bindLevel', () => enemies.bindLevel(level));
      phase('ai.bindLevel', () => ai.bindLevel(level));
      phase('loot.bindLevel', () => loot.bindLevel(level));
      phase('weapons.bindLevel', () => weapons.bindLevel(level));
      phase('abilities.bindLevel', () => abilities.bindLevel(level));
      profile.total = Object.values(profile).reduce((a, b) => a + b, 0);
      lastTravelProfile = profile;
      engine.state = 'playing';
      events.emit('ship:arrived', { at: planet });
      events.emit('ui:toast', {
        text: desc.displayName.toUpperCase(),
        sub: desc.subtitle,
        duration: 4.2,
      });
      audio.setAmbience(planet);
    },
    async openStarMap() {
      await setLevel(starmap.createLevel(), 'Entering orbit');
      currentPlanet = null;
      api.currentPlanet = null;
      enemies.clear();
      engine.state = 'starmap';
      audio.setAmbience('orbit');
    },
  };
  ctx = api;

  onProgress(0.82, 'Entering orbit');
  await api.openStarMap();

  // -- debug / capture hooks -----------------------------------------------
  const scenarios: Record<string, () => Promise<void>> = {
    starmap: () => api.openStarMap(),
    ...Object.fromEntries(
      PLANETS.map((p) => [p.id, () => api.travelTo(p.id)] as const),
    ),
  };

  (window as unknown as { GF: Record<string, unknown> }).GF = {
    engine,
    settings,
    events,
    game: api,
    debug: {
      scenarios: Object.keys(scenarios),
      async scenario(name: string) {
        const fn = scenarios[name];
        if (!fn) throw new Error(`Unknown scenario "${name}"`);
        await fn();
        // Give particle systems / streaming a few simulated frames to settle.
        await new Promise((r) => setTimeout(r, 400));
      },
      setTier(t: QualityTier) {
        settings.setTier(t);
      },
      freeze(on: boolean) {
        engine.state = on ? 'paused' : 'playing';
      },
      stats: () => ({ ...engine.host.stats, fps: engine.fps, frameMs: engine.frameMs }),
      travelProfile: () => lastTravelProfile,
      audio: () => audio.diagnostics(),
      /** Force the score's combat intensity, 0..1. Drives the recorded switch. */
      setMusicIntensity: (v: number) => audio.setMusicIntensity(v),
    },
  };

  onProgress(1, 'Ready');
  return api;
}

/** Small helper other systems use to grab the active scene safely. */
export function activeScene(): THREE.Scene | null {
  return ctx?.engine.level?.scene ?? null;
}
