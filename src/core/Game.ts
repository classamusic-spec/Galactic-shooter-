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
import { haptics } from './Haptics';
import { PLANETS, createPlanetLevel } from '@/world/planets';
import { progression } from '@/gameplay/Progression';
import { chapterFor, playBriefing, playDebrief } from '@/world/campaign/Campaign';
import { damage as damageResolver } from '@/gameplay/Damage';
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
  // Rumble rides the same events audio does, so the two can never disagree about
  // what just happened. No-ops entirely when no pad is connected.
  haptics.install();

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

  // -- mission bookkeeping ---------------------------------------------------
  // The campaign loop hangs off these three values. `level:cleared` carries only
  // an id and a score, which is not enough to report a mission back to the
  // player, so the run's kills and elapsed time are accumulated here and folded
  // into `mission:completed`.
  let missionStart = 0;
  let missionKills = 0;
  let missionId = '';
  events.on('enemy:killed', () => {
    missionKills++;
  });

  /**
   * Close the mission loop.
   *
   * `level:cleared` had exactly one subscriber before this: an audio sting.
   * `progression.markCleared` had no callers at all, so finishing a world
   * granted nothing, recorded nothing, and left the player standing in an empty
   * arena with no way out but the pause menu. This is the missing half.
   */
  events.on('level:cleared', (p) => {
    const planet = currentPlanet;
    if (!planet) return;
    const firstClear = !progression.planet(planet).cleared;
    progression.markCleared(planet, p.score);
    events.emit('mission:completed', {
      planet,
      missionId: missionId || p.id,
      score: p.score,
      kills: missionKills,
      seconds: Math.max(0, (performance.now() - missionStart) / 1000),
      firstClear,
    });
    // The debrief is where the campaign actually advances — each one names the
    // world the player goes to next and why. It plays over the results screen.
    playDebrief(planet);
  });

  events.on('player:died', () => {
    if (currentPlanet) events.emit('mission:failed', { planet: currentPlanet, missionId });
  });

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
    // Aim assist reads live enemy positions. Bound here rather than in travelTo
    // so the star map gets it too — it has no enemies, so the source simply
    // returns nothing and the assist stays inert.
    player.bindAimTargets(enemies);
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
      // Kick the music download off before the terrain build, not after it: the
      // load is several seconds of work that would otherwise be dead air, and a
      // three-minute MP3 takes about that long to fetch and decode.
      audio.prefetchMusic(planet);
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

      // Power only ever affected abilities, because `worldPower` sat at its
      // default of 100 forever and the damage scaling therefore always resolved
      // to 1. Setting it per planet is what makes levelling, and the star map's
      // recommended power, mean anything at all.
      damageResolver.playerPower = progression.power;
      damageResolver.worldPower = desc.recommendedPower;

      missionStart = performance.now();
      missionKills = 0;
      missionId = `${planet}.main`;
      const chapter = chapterFor(planet);
      engine.state = 'playing';
      events.emit('mission:started', {
        planet,
        missionId,
        chapter: chapter?.chapter ?? PLANETS.findIndex((x) => x.id === planet) + 1,
        title: chapter?.title ?? desc.displayName,
      });
      // After the state change, so the briefing sequencer knows it is in a
      // mission and can pace against combat rather than against the loading
      // screen it would otherwise still think it was on.
      playBriefing(planet);
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
      /**
       * Spawn a combat tableau in front of the camera, for visual review.
       *
       * The critic's captures had never once contained an enemy, because a wave
       * only arrives after its scripted delay and a capture under the software
       * rasteriser advances a couple of seconds of simulation at most. Two of the
       * rubric's twelve axes — enemy design and VFX — were therefore unscoreable
       * on every review this project has ever run. This puts the subjects in
       * frame directly rather than waiting for the encounter to do it.
       */
      populate(count = 6): number {
        const planet = currentPlanet;
        if (!planet) return 0;
        const desc = PLANETS.find((p) => p.id === planet);
        if (!desc) return 0;
        const ranks = ['minor', 'minor', 'standard', 'standard', 'elite', 'champion'];
        const origin = player.position;
        const fwd = player.aimDirection;
        const level = engine.level as {
          heightField?: { height(x: number, z: number): number };
        } | null;
        const hf = level?.heightField ?? null;
        const eyeY = origin.y + 0.7;

        /**
         * Is a spawn point actually on screen?
         *
         * This check was missing, and its absence quietly invalidated every
         * enemy and VFX review this project has run: the fan was placed at a
         * fixed bearing and distance and dropped onto the terrain wherever that
         * landed, which on Aurvangr, Hive Prime and Draco IX is behind a ridge.
         * Three of five combat captures contained no visible enemy at all,
         * while reporting that they had spawned.
         *
         * A heightfield does not need a raycast for this. March the straight
         * line from the eye to the unit's chest and fail if the ground ever
         * rises through it.
         */
        const visible = (x: number, z: number, groundY: number): boolean => {
          if (!hf) return true;
          const chest = groundY + 1.1;
          for (let k = 1; k <= 14; k++) {
            const t = k / 15;
            const sx = origin.x + (x - origin.x) * t;
            const sz = origin.z + (z - origin.z) * t;
            const lineY = eyeY + (chest - eyeY) * t;
            if (hf.height(sx, sz) > lineY) return false;
          }
          return true;
        };

        let spawned = 0;
        for (let i = 0; i < count; i++) {
          const ids = enemies.archetypesFor(desc.faction, ranks[i % ranks.length]);
          if (!ids.length) continue;
          // Fan them across the view at readable silhouette distances rather
          // than clumping: a review frame needs to show shape, not a crowd.
          const spread = (i / Math.max(1, count - 1) - 0.5) * 1.05;
          const dist = 11 + (i % 3) * 7;
          let pos: THREE.Vector3 | null = null;
          let yaw = 0;
          // Walk the ideal placement outward and sideways until the unit is in
          // clear view. The first candidate is the composition we want; the
          // rest are progressively larger concessions to the terrain.
          for (let attempt = 0; attempt < 24 && !pos; attempt++) {
            const ring = Math.floor(attempt / 6);
            const bend = ((attempt % 6) - 2.5) * 0.13 * ring;
            const a = spread + bend;
            const d = dist + ring * 5;
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            const dx = fwd.x * cos - fwd.z * sin;
            const dz = fwd.z * cos + fwd.x * sin;
            const px = origin.x + dx * d;
            const pz = origin.z + dz * d;
            const gy = hf ? hf.height(px, pz) : origin.y;
            if (!visible(px, pz, gy)) continue;
            pos = new THREE.Vector3(px, gy, pz);
            yaw = Math.atan2(-dx, -dz) + Math.PI;
          }
          if (!pos) continue;
          if (enemies.spawn(ids[i % ids.length], pos, yaw)) spawned++;
        }
        return spawned;
      },
      /**
       * Fire the effects the VFX axis is scored on.
       *
       * Off the camera axis by default. It used to go straight down the aim
       * vector at 9 m, which is exactly where `populate` puts the enemy fan, so
       * the one frame meant to score both subjects had the fireball covering
       * the units it was supposed to sit beside.
       */
      vfx(bearing = 0.5, dist = 12): void {
        const fwd = player.aimDirection;
        const cos = Math.cos(bearing);
        const sin = Math.sin(bearing);
        const dx = fwd.x * cos - fwd.z * sin;
        const dz = fwd.z * cos + fwd.x * sin;
        const p = new THREE.Vector3(
          player.position.x + dx * dist,
          player.position.y + fwd.y * dist,
          player.position.z + dz * dist,
        );
        events.emit('explosion', { point: p, radius: 6, element: 'solar' });
        events.emit('impact:surface', {
          point: p.clone().addScaledVector(fwd, -2),
          normal: new THREE.Vector3(0, 1, 0),
          surface: 'rock',
          scale: 1.4,
        });
      },
      /** Spectrum of one mix bus, dBFS per octave plus spectral flatness. */
      /**
       * Every voice currently sounding, by id and gain.
       *
       * A bus meter can say a bus is making noise; only this says what is
       * making it. A looping voice held at low gain is invisible in every other
       * diagnostic and perfectly audible in the room.
       */
      audioVoices: () => audio.voices(),
      audioMeter: (bus: 'sfx' | 'music' | 'ambience' | 'ui') => audio.meter(bus),
      /** The live AudioContext, for harnesses that need to drive its state. */
      audioContext: () => audio.context,
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
