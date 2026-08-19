/**
 * The audio system.
 *
 * Zero audio files. Everything you hear is synthesised at boot into
 * `AudioBuffer`s by `OfflineAudioContext` (see `@/core/audio/Dsp`), then played
 * through a spatialising voice pool into a four-bus mixer with a compressor and
 * brick-wall limiter on the master.
 *
 * The design rule this module follows is that **gameplay does not call audio**.
 * Almost every sound in the game is produced by a subscription to the event bus
 * — a weapon fires, a surface is struck, an enemy dies — which means the audio
 * layer can be rewritten, muted or removed without touching a line of gameplay
 * code, and no system has to remember to make a noise.
 *
 * The handful of things that *are* imperative (`play('ship_engine_loop')`) are
 * continuous sounds whose volume is a function of a caller's own state, which no
 * event can express.
 *
 * Context lifecycle: browsers create an `AudioContext` suspended until a user
 * gesture. We create it anyway, bake into it, and resume on the first pointer or
 * key event. Nothing in here throws if audio is unavailable — `play()` returns
 * null and the game carries on in silence.
 */
import * as THREE from 'three';
import type {
  AudioEmitOptions,
  AudioHandle,
  DamageElement,
  FactionId,
  PlanetId,
  SurfaceKind,
  WeaponFamily,
} from '@/types';
import { events } from './EventBus';
import { settings } from './Settings';
import { Rng, clamp, clamp01 } from '@/util/math';
import {
  type BakeJob,
  type BufferMetrics,
  bakeBatch,
  makeSeamless,
  measure,
} from './audio/Dsp';
import { GUN_TAKES, gunJobs, handlingJobs } from './audio/Weapons';
import { IMPACT_TAKES, elementalJobs, explosionJobs, impactJobs } from './audio/Impacts';
import { VOICE_TAKES, creatureJobs, enemyWeaponJobs } from './audio/Creatures';
import { AMB_LOOP, AMB_RATE, AMB_XFADE, LOOP_XFADE, ambienceJobs, loopJobs } from './audio/Ambience';
import { uiJobs } from './audio/Ui';
import { MUSIC_RATE, MusicEngine, musicJobs } from './audio/Music';
import { MusicTracks } from './audio/MusicTracks';
import { SfxPack } from './audio/SfxPack';
import { Mixer, type ReverbPreset } from './audio/Mixer';
import { VoicePool, type Voice } from './audio/Voices';

export type AmbienceId = PlanetId | 'orbit';

/** Which bus an id belongs on, decided by prefix. */
type BusKind = 'sfx' | 'ui' | 'ambience' | 'music';

/** Every weapon family, for id resolution. Mirrors the union in `@/types`. */
const WEAPON_FAMILIES: readonly WeaponFamily[] = [
  'autoRifle',
  'pulseRifle',
  'scoutRifle',
  'handCannon',
  'sidearm',
  'submachineGun',
  'shotgun',
  'sniperRifle',
  'fusionRifle',
  'rocketLauncher',
  'grenadeLauncher',
  'machineGun',
  'bow',
  'traceRifle',
];

/**
 * Which species holds which world. Duplicated from `@/world/planets` on
 * purpose: `core` must not import `world`, and six strings are cheaper than an
 * inverted dependency.
 */
const PLANET_FACTION: Record<PlanetId, FactionId> = {
  aurvangr: 'nordic',
  'zeta-reticuli': 'grey',
  khepri: 'mantis',
  'hive-prime': 'insectoid',
  'draco-ix': 'reptilian',
};

const AMBIENCE_REVERB: Record<AmbienceId, [ReverbPreset, number]> = {
  aurvangr: ['ice', 0.42],
  'zeta-reticuli': ['canyon', 0.36],
  khepri: ['jungle', 0.3],
  'hive-prime': ['hive', 0.44],
  'draco-ix': ['cave', 0.4],
  orbit: ['ship', 0.34],
};

/** How many copies of one id may sound at once. */
const VOICE_LIMITS: Array<[string, number]> = [
  ['gun_', 5],
  ['impact_', 4],
  ['step_', 3],
  ['voice_', 2],
  ['enemyfire_', 4],
  ['explosion_', 4],
  ['hitmarker', 2],
  ['loot_', 3],
  ['burn_loop', 6],
];

/** Reverb send per category. UI and music stay dry. */
function reverbFor(id: string): number {
  if (id.startsWith('ui_') || id.startsWith('hitmarker') || id.startsWith('loot_')) return 0;
  if (id.startsWith('amb_') || id.startsWith('mus_')) return 0;
  if (id.startsWith('gun_') || id.startsWith('explosion_')) return 0.85;
  if (id.startsWith('impact_') || id.startsWith('enemyfire_')) return 0.55;
  if (id.startsWith('voice_')) return 0.5;
  return 0.3;
}

function busFor(id: string): BusKind {
  if (id.startsWith('amb_')) return 'ambience';
  if (id.startsWith('mus_')) return 'music';
  if (
    id.startsWith('ui_') ||
    id.startsWith('hitmarker') ||
    id.startsWith('super_') ||
    id.startsWith('ability_') ||
    id.startsWith('loot_') ||
    id === 'objective' ||
    id === 'player_hurt' ||
    id === 'player_death' ||
    id === 'shield_break_player'
  ) {
    return 'ui';
  }
  return 'sfx';
}

export interface AudioDiagnostics {
  ready: boolean;
  sampleRate: number;
  buffers: number;
  megabytes: number;
  bakeMs: number;
  /** Worst peak across the whole bank; must stay below 1.0. */
  worstPeak: number;
  clipped: string[];
  /** Slowest gunshot attack, milliseconds. Target: under 5. */
  worstGunAttackMs: number;
  gunAttacks: Record<string, number>;
  /** Loop discontinuity for every looping buffer. */
  loopSeams: Record<string, { step: number; meanStep: number; ratio: number }>;
  activeVoices: number;
  limiterReduction: number;
  musicIntensity: number;
  /** Which recorded track is playing, or 'none' when the generated score is up. */
  musicTrack: 'none' | 'ambient' | 'combat';
  /** Live gain of each recorded voice, and of the generated score under them. */
  musicGains: { ambient: number; combat: number; generated: number };
  /** Recorded effects: installed, failed to fetch, and decoded-but-unusable. */
  sfxPack: { loaded: number; failed: number; rejected: number };
  /**
   * Post-install peak and attack for every recorded effect, measured on the
   * buffer that actually ships. The generator's audit reads this rather than
   * re-deriving it, so the two can never disagree about what was installed.
   */
  sfxMetrics: Record<string, { peak: number; attackMs: number }>;
}

class AudioSystem {
  private ctx: AudioContext | null = null;
  private mixer: Mixer | null = null;
  private pool: VoicePool | null = null;
  private music: MusicEngine | null = null;
  private tracks: MusicTracks | null = null;
  private sfxPack: SfxPack | null = null;
  /** Gain the generated score runs through, ducked when a recorded track wins. */
  private generatedGain: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private variants = new Map<string, string[]>();
  private metrics = new Map<string, BufferMetrics>();
  private rng = new Rng(0x5eed17);
  private unsubs: Array<() => void> = [];
  private ambienceVoice: Voice | null = null;
  private ambience: AmbienceId | null = null;
  private superVoice: Voice | null = null;
  private raf = 0;
  private lastFrame = 0;
  private initPromise: Promise<void> | null = null;
  private readyFlag = false;
  private bakeMs = 0;
  private gestureBound = false;

  /** Combat heat, 0..1, drives the adaptive score. */
  private heat = 0;
  private heatTarget = 0;
  /**
   * Combat intensity pushed in by the AI director, 0..1. Heat is built purely
   * from audible events, so it misses "six of them are flanking me and nobody
   * has fired yet"; the director's threat level covers exactly that, and the
   * music switch reads whichever is higher.
   */
  private threat = 0;

  get ready(): boolean {
    return this.readyFlag;
  }

  /** Diagnostics for the bake self-test. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async init(onProgress?: (t: number, label: string) => void): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.boot(onProgress).catch((err) => {
      // Audio must never be the reason the game fails to load.
      console.warn('[audio] initialisation failed; running silent', err);
      this.readyFlag = false;
    });
    return this.initPromise;
  }

  private async boot(onProgress?: (t: number, label: string) => void): Promise<void> {
    const report = onProgress ?? ((): void => {});
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('WebAudio unavailable');

    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.mixer = new Mixer(ctx);
    this.pool = new VoicePool(ctx, this.mixer.reverbSend, 48);
    // The generated score goes through its own gain so a recorded track can duck
    // it to silence without touching the music bus the player's volume slider
    // controls.
    const generated = ctx.createGain();
    generated.gain.value = 1;
    generated.connect(this.mixer.buses.music);
    this.generatedGain = generated;
    this.music = new MusicEngine({
      ctx,
      bus: generated,
      buffer: (id) => this.buffers.get(id),
    });
    this.tracks = new MusicTracks({ ctx, bus: this.mixer.buses.music, generated });

    const t0 = performance.now();
    const sr = ctx.sampleRate;

    // Six batches instead of ~280 offline contexts. Sample rates are chosen per
    // category: transient-critical material at full rate, tonal beds lower.
    report(0.02, 'weapons');
    await this.bake(sr, 1, [...gunJobs(), ...handlingJobs()], 0x1a1);
    report(0.24, 'impacts');
    await this.bake(sr, 1, [...impactJobs(), ...explosionJobs(), ...elementalJobs()], 0x2b2);
    report(0.44, 'voices');
    await this.bake(32000, 1, [...creatureJobs(), ...enemyWeaponJobs()], 0x3c3);
    report(0.66, 'interface');
    await this.bake(sr, 1, uiJobs(), 0x4d4);
    report(0.74, 'ambience');
    await this.bake(AMB_RATE, 2, [...ambienceJobs(), ...loopJobs()], 0x5e5);
    report(0.9, 'score');
    await this.bake(MUSIC_RATE, 1, musicJobs(), 0x6f6);
    report(0.94, 'recorded effects');
    // Recorded effects replace the synthesised buffer of the same id. This runs
    // *after* every bake so `peakOf` can read the level the bank was tuned to,
    // and *before* the loop repair below so a replacement is still folded back
    // on itself if it happens to be a looping id.
    this.sfxPack = new SfxPack({
      ctx,
      peakOf: (id) => {
        const buf = this.buffers.get(id);
        if (!buf) return null;
        const d = buf.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < d.length; i++) {
          const a = Math.abs(d[i]);
          if (a > peak) peak = a;
        }
        return peak > 0 ? peak : null;
      },
      apply: (id, buf) => {
        this.buffers.set(id, buf);
        this.metrics.set(id, measure(buf));
      },
    });
    await this.sfxPack.load();

    report(0.97, 'mixing');

    // Fold every loop back on itself so it repeats without a seam.
    for (const id of this.buffers.keys()) {
      if (id.startsWith('amb_')) this.reloop(id, AMB_XFADE, AMB_LOOP);
      else if (LOOP_XFADE[id] != null) this.reloop(id, LOOP_XFADE[id], 0);
    }

    this.indexVariants();
    for (const [id, buf] of this.buffers) this.metrics.set(id, measure(buf));

    this.bakeMs = performance.now() - t0;
    this.applyVolumes();
    this.subscribe();
    this.bindGesture();
    this.startLoop();
    this.music.start();
    this.readyFlag = true;
  }

  private async bake(
    sampleRate: number,
    channels: number,
    jobs: BakeJob[],
    seed: number,
  ): Promise<void> {
    const out = await bakeBatch(sampleRate, channels, jobs, seed);
    for (const [id, buf] of out) this.buffers.set(id, buf);
  }

  /** Replace a buffer with a seamless-looping version of itself. */
  private reloop(id: string, xfade: number, expected: number): void {
    const buf = this.buffers.get(id);
    if (!buf) return;
    const looped = makeSeamless(buf, xfade);
    if (expected > 0 && Math.abs(looped.duration - expected) > 0.05) {
      // Length drifted — still usable, just note it rather than fail the boot.
      console.debug(`[audio] ${id} loop is ${looped.duration.toFixed(2)}s`);
    }
    this.buffers.set(id, looped);
  }

  /** Group `foo_0 foo_1 foo_2` under the stem `foo` so `play('foo')` varies. */
  private indexVariants(): void {
    for (const id of this.buffers.keys()) {
      const m = /^(.*)_(\d+)$/.exec(id);
      if (!m) continue;
      const stem = m[1];
      let list = this.variants.get(stem);
      if (!list) this.variants.set(stem, (list = []));
      list.push(id);
    }
    for (const list of this.variants.values()) list.sort();
  }

  private bindGesture(): void {
    if (this.gestureBound) return;
    this.gestureBound = true;
    const resume = (): void => {
      void this.ctx?.resume();
      if (this.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', resume);
        window.removeEventListener('keydown', resume);
        window.removeEventListener('touchstart', resume);
      }
    };
    window.addEventListener('pointerdown', resume, { passive: true });
    window.addEventListener('keydown', resume, { passive: true });
    window.addEventListener('touchstart', resume, { passive: true });

    // A gamepad button is not a user activation as far as the autoplay policy is
    // concerned, so a player on a controller alone can reach the star map with
    // the audio context still suspended and no idea why the game is silent.
    // Nothing here can resume it — only a key, click or touch can — so the honest
    // move is to say so, once, at the moment they first press something.
    const nag = (): void => {
      if (!this.ctx || this.ctx.state === 'running') {
        window.removeEventListener('gf:padpress', nag);
        return;
      }
      window.removeEventListener('gf:padpress', nag);
      events.emit('ui:toast', {
        text: 'AUDIO MUTED',
        sub: 'Press any key or click once — a controller cannot start audio',
        duration: 7,
      });
    };
    window.addEventListener('gf:padpress', nag);
  }

  private startLoop(): void {
    this.lastFrame = performance.now();
    const tick = (): void => {
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      // Heat decays continuously; every combat event pushes it back up.
      this.heatTarget = Math.max(0, this.heatTarget - dt * 0.11);
      this.heat += (this.heatTarget - this.heat) * clamp01(dt * 3);
      this.music?.setIntensity(this.heat);
      this.music?.update(dt);
      this.tracks?.setIntensity(Math.max(this.heat, this.threat), dt);
      this.pool?.update(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private bump(amount: number): void {
    this.heatTarget = clamp01(this.heatTarget + amount);
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  /** Resolve an id to a concrete buffer, choosing a random take when there is one. */
  private resolve(id: string): { key: string; buffer: AudioBuffer } | null {
    const direct = this.buffers.get(id);
    if (direct) return { key: id, buffer: direct };
    const takes = this.variants.get(id);
    if (takes && takes.length) {
      const key = takes[Math.floor(this.rng.next() * takes.length) % takes.length];
      const buffer = this.buffers.get(key);
      if (buffer) return { key, buffer };
    }
    return null;
  }

  private limitFor(id: string): number {
    for (const [prefix, n] of VOICE_LIMITS) if (id.startsWith(prefix)) return n;
    return 4;
  }

  play(id: string, opts: AudioEmitOptions = {}): AudioHandle | null {
    if (!this.readyFlag || !this.pool || !this.mixer) return null;
    const hit = this.resolve(id);
    if (!hit) return null;

    const jitter = opts.pitchJitter ?? 0;
    const pitch = (opts.pitch ?? 1) * (jitter > 0 ? 1 + this.rng.range(-jitter, jitter) : 1);
    const bus = this.mixer.buses[busFor(id)];
    const positional = opts.position != null;

    return this.pool.play({
      id,
      buffer: hit.buffer,
      bus,
      volume: Math.max(0, opts.volume ?? 1),
      pitch,
      loop: opts.loop ?? false,
      position: positional ? opts.position! : null,
      velocity: null,
      maxDistance: opts.maxDistance ?? 110,
      refDistance: id.startsWith('explosion_') ? 12 : 3.5,
      reverb: positional ? reverbFor(id) : reverbFor(id) * 0.35,
      limit: this.limitFor(id),
      priority: id.startsWith('gun_') || id.startsWith('super_') ? 2 : 1,
    });
  }

  /** Positional convenience used by the event handlers. */
  private at(
    id: string,
    position: THREE.Vector3,
    volume = 1,
    jitter = 0.06,
    maxDistance = 110,
  ): AudioHandle | null {
    return this.play(id, { position, volume, pitchJitter: jitter, maxDistance });
  }

  stopAll(): void {
    this.pool?.stopAll(0.05);
    this.ambienceVoice = null;
    this.superVoice = null;
    this.ambience = null;
  }

  setReverb(preset: string, wet: number): void {
    this.mixer?.setReverb(preset as ReverbPreset, wet);
  }

  setListener(
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    velocity: THREE.Vector3,
  ): void {
    this.pool?.setListener(position, quaternion, velocity);
  }

  /** Optional line-of-sight probe so occluded sounds go dull, not just quiet. */
  setOcclusionProbe(fn: ((position: THREE.Vector3) => number) | null): void {
    if (this.pool) this.pool.occlusionProbe = fn;
  }

  /**
   * Begin downloading a world's music before its level loads.
   *
   * Called at the top of `travelTo` rather than driven off `ship:travelStarted`,
   * because that event only fires on the ship's landing approach — the star-map
   * button and the debug scenarios reach `travelTo` without it, and they need
   * the head start just as much.
   */
  prefetchMusic(id: AmbienceId): void {
    this.tracks?.prefetch(id);
  }

  setAmbience(id: AmbienceId): void {
    if (!this.readyFlag || this.ambience === id) return;
    this.ambience = id;
    this.ambienceVoice?.stop(1.6);
    this.ambienceVoice = null;
    const buf = this.buffers.get(`amb_${id}`);
    if (buf && this.pool && this.mixer) {
      const v = this.pool.play({
        id: `amb_${id}`,
        buffer: buf,
        bus: this.mixer.buses.ambience,
        volume: 0.0001,
        pitch: 1,
        loop: true,
        position: null,
        velocity: null,
        maxDistance: 1000,
        refDistance: 1,
        reverb: 0,
        limit: 1,
        priority: 3,
      });
      if (v) {
        v.setVolume(0.85, 2.4);
        this.ambienceVoice = v;
      }
    }
    const [preset, wet] = AMBIENCE_REVERB[id] ?? (['outdoor', 0.35] as [ReverbPreset, number]);
    this.setReverb(preset, wet);
    this.music?.setWorld(id);
    this.tracks?.setWorld(id);
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  private applyVolumes(): void {
    this.mixer?.setVolumes(
      settings.user.masterVolume,
      settings.user.sfxVolume,
      settings.user.musicVolume,
    );
  }

  // -------------------------------------------------------------------------
  // Event wiring — this is where most of the game's audio actually comes from
  // -------------------------------------------------------------------------

  private familyOf(weaponId: string): WeaponFamily {
    for (const f of WEAPON_FAMILIES) if (weaponId === f) return f;
    for (const f of WEAPON_FAMILIES) if (weaponId.indexOf(f) >= 0) return f;
    return 'autoRifle';
  }

  private currentFaction(): FactionId {
    if (this.ambience && this.ambience !== 'orbit') return PLANET_FACTION[this.ambience];
    return 'federation';
  }

  private subscribe(): void {
    const on = events.on.bind(events);

    this.unsubs.push(
      on('settings:changed', () => this.applyVolumes()),

      // -- weapons ---------------------------------------------------------
      on('weapon:fired', (p) => {
        const family = this.familyOf(p.weaponId);
        // Live per-shot variation on top of the four baked takes: a pitch
        // spread wide enough to matter but narrow enough not to sound broken,
        // plus a level drop as the mag empties (a hot barrel and a light gun).
        const magFrac = p.magazine > 0 ? clamp01(p.ammo / p.magazine) : 1;
        this.play(`gun_${family}`, {
          volume: 0.92 - (1 - magFrac) * 0.06,
          pitch: 1,
          pitchJitter: 0.055,
        });
        this.bump(0.05);
      }),
      on('weapon:reloaded', (p) => {
        const family = this.familyOf(p.weaponId);
        const heavy =
          family === 'rocketLauncher' ||
          family === 'machineGun' ||
          family === 'sniperRifle' ||
          family === 'shotgun';
        const light = family === 'sidearm' || family === 'submachineGun' || family === 'bow';
        this.play(`reload_${heavy ? 'heavy' : light ? 'light' : 'medium'}`, {
          volume: 0.55,
          pitchJitter: 0.04,
        });
      }),
      on('weapon:swapped', () => this.play('weapon_swap', { volume: 0.5, pitchJitter: 0.05 })),
      on('weapon:emptied', () => this.play('weapon_dryfire', { volume: 0.45 })),

      // -- impacts and explosions -------------------------------------------
      on('impact:surface', (p) => {
        const scale = clamp(p.scale ?? 1, 0.05, 3);
        // Footsteps come through as very small surface impacts; play the
        // footstep model for those rather than a bullet strike.
        const id = scale < 0.2 ? `step_${p.surface}` : `impact_${p.surface}`;
        this.at(id, p.point, clamp(scale, 0.15, 1.2), 0.12, 60);
      }),
      on('explosion', (p) => {
        const size = p.radius > 6 ? 'large' : p.radius > 3 ? 'medium' : 'small';
        this.at(`explosion_${size}`, p.point, 1, 0.08, 240);
        if (p.element !== 'kinetic') this.elementSting(p.point, p.element, 0.55);
        this.bump(0.22);
      }),

      // -- enemies -----------------------------------------------------------
      on('enemy:damaged', (p) => {
        if (p.amount <= 0) return;
        // Occasional pain vocalisation — every hit would be a wall of noise.
        if (this.rng.bool(clamp01(p.amount / 60) * 0.5)) {
          this.at(`voice_${this.currentFaction()}_hurt`, p.point, 0.55, 0.09, 70);
        }
        this.bump(0.02);
      }),
      on('enemy:shieldBroken', (p) => {
        this.at('shield_break', p.position, 0.8, 0.07, 90);
        this.elementSting(p.position, p.element, 0.4);
      }),
      on('enemy:killed', (p) => {
        this.play('hitmarker_kill', { volume: 0.6 });
        this.at(`voice_${this.currentFaction()}_death`, p.position, 0.75, 0.08, 90);
        this.bump(0.18);
      }),

      // -- player ------------------------------------------------------------
      on('player:damaged', (p) => {
        this.play('player_hurt', { volume: clamp(0.35 + p.amount / 90, 0.35, 1) });
        if (p.shieldBroke) this.play('shield_break_player', { volume: 0.8 });
        this.bump(0.14);
      }),
      on('player:died', () => {
        this.play('player_death', { volume: 0.9 });
        this.heatTarget = 0;
        this.threat = 0;
        // Death ends the fight regardless of dwell — holding the combat track
        // over a death screen is the one case the hysteresis gets wrong.
        this.tracks?.releaseCombat();
      }),
      on('combat:threat', (p) => {
        this.threat = clamp01(p.level);
        this.tracks?.setEngaged(p.engaged);
      }),

      // -- abilities ---------------------------------------------------------
      on('ability:used', (p) => {
        if (p.slot === 'grenade') this.play('grenade_throw', { volume: 0.6, pitchJitter: 0.06 });
        else if (p.slot === 'melee') this.play('melee_swing', { volume: 0.6, pitchJitter: 0.08 });
        else this.play('ability_ready', { volume: 0.4, pitch: 1.3 });
        this.bump(0.08);
      }),
      on('ability:ready', () => this.play('ability_ready', { volume: 0.32 })),
      on('super:ready', () => this.play('super_ready', { volume: 0.75 })),
      on('super:activated', () => {
        this.play('super_cast', { volume: 1 });
        this.superVoice?.stop(0.1);
        const buf = this.buffers.get('super_loop');
        if (buf && this.pool && this.mixer) {
          const v = this.pool.play({
            id: 'super_loop',
            buffer: buf,
            bus: this.mixer.buses.sfx,
            volume: 0.0001,
            pitch: 1,
            loop: true,
            position: null,
            velocity: null,
            maxDistance: 1000,
            refDistance: 1,
            reverb: 0.2,
            limit: 1,
            priority: 3,
          });
          if (v) {
            v.setVolume(0.42, 0.6);
            this.superVoice = v;
          }
        }
        this.heatTarget = 1;
      }),
      on('super:ended', () => {
        this.play('super_end', { volume: 0.55 });
        this.superVoice?.stop(0.9);
        this.superVoice = null;
      }),

      // -- loot and interface -------------------------------------------------
      on('loot:pickup', (p) => {
        const id =
          p.kind === 'heavyAmmo'
            ? 'loot_heavy'
            : p.kind === 'orb'
              ? 'loot_orb'
              : p.kind === 'engram'
                ? 'loot_engram'
                : p.kind === 'health'
                  ? 'loot_health'
                  : 'loot_ammo';
        this.play(id, { volume: 0.55, pitchJitter: 0.03 });
      }),
      on('hitmarker', (p) => {
        if (p.kill) return; // the kill sting already covers it
        this.play(p.precision ? 'hitmarker_crit' : 'hitmarker', {
          volume: p.precision ? 0.5 : 0.38,
          pitchJitter: 0.035,
        });
      }),
      on('ui:toast', () => this.play('ui_toast', { volume: 0.4 })),
      on('objective:updated', () => this.play('ui_click', { volume: 0.3 })),
      on('objective:completed', () => this.play('objective', { volume: 0.55 })),
      on('level:cleared', () => this.play('objective', { volume: 0.7, pitch: 0.94 })),
      on('ship:travelStarted', () => this.play('ship_travel', { volume: 0.7 })),
    );
  }

  private elementSting(point: THREE.Vector3, element: DamageElement, volume: number): void {
    const id =
      element === 'solar'
        ? 'elem_solar_ignite'
        : element === 'arc'
          ? 'elem_arc_zap'
          : element === 'void'
            ? 'elem_void_pull'
            : element === 'stasis'
              ? 'elem_stasis_shatter'
              : null;
    if (id) this.at(id, point, volume, 0.06, 100);
  }

  /** Surface-specific one-shot other systems can call directly. */
  impact(point: THREE.Vector3, surface: SurfaceKind, scale = 1): void {
    this.at(`impact_${surface}`, point, clamp(scale, 0.1, 1.2), 0.12, 60);
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  diagnostics(): AudioDiagnostics {
    let bytes = 0;
    let worstPeak = 0;
    const clipped: string[] = [];
    const gunAttacks: Record<string, number> = {};
    const loopSeams: Record<string, { step: number; meanStep: number; ratio: number }> = {};
    let worstGunAttackMs = 0;

    for (const [id, buf] of this.buffers) {
      bytes += buf.length * buf.numberOfChannels * 4;
      const m = this.metrics.get(id);
      if (!m) continue;
      if (m.peak > worstPeak) worstPeak = m.peak;
      if (m.peak >= 0.999) clipped.push(id);
      if (id.startsWith('gun_')) {
        gunAttacks[id] = Math.round(m.attackMs * 1000) / 1000;
        if (m.attackMs > worstGunAttackMs) worstGunAttackMs = m.attackMs;
      }
      if (id.startsWith('amb_') || LOOP_XFADE[id] != null) {
        const r = m.meanStep > 1e-9 ? m.loopStep / m.meanStep : 0;
        loopSeams[id] = {
          step: Math.round(m.loopStep * 1e6) / 1e6,
          meanStep: Math.round(m.meanStep * 1e6) / 1e6,
          ratio: Math.round(r * 100) / 100,
        };
      }
    }

    return {
      ready: this.readyFlag,
      sampleRate: this.ctx?.sampleRate ?? 0,
      buffers: this.buffers.size,
      megabytes: Math.round((bytes / 1048576) * 100) / 100,
      bakeMs: Math.round(this.bakeMs),
      worstPeak: Math.round(worstPeak * 1e4) / 1e4,
      clipped,
      worstGunAttackMs: Math.round(worstGunAttackMs * 1000) / 1000,
      gunAttacks,
      loopSeams,
      activeVoices: this.pool?.activeCount ?? 0,
      limiterReduction: Math.round((this.mixer?.reduction ?? 0) * 100) / 100,
      musicIntensity: Math.round((this.music?.currentIntensity ?? 0) * 1000) / 1000,
      sfxPack: {
        loaded: this.sfxPack?.loaded ?? 0,
        failed: this.sfxPack?.failed ?? 0,
        rejected: this.sfxPack?.rejected ?? 0,
      },
      sfxMetrics: Object.fromEntries(
        [...(this.sfxPack?.installed ?? [])].map((id) => {
          const m = this.metrics.get(id);
          return [
            id,
            {
              peak: Math.round((m?.peak ?? 0) * 1000) / 1000,
              attackMs: Math.round((m?.attackMs ?? 0) * 100) / 100,
            },
          ];
        }),
      ),
      musicTrack: this.tracks?.state ?? 'none',
      musicGains: {
        ...(this.tracks?.gains ?? { ambient: 0, combat: 0 }),
        generated: Math.round((this.generatedGain?.gain.value ?? 0) * 1000) / 1000,
      },
    };
  }

  /**
   * Test hook: force the score to a given intensity, skipping the dwell and the
   * quiet-release timer so a harness can assert the switch in one call.
   */
  setMusicIntensity(v: number): void {
    this.heatTarget = clamp01(v);
    this.heat = this.heatTarget;
    this.threat = this.heatTarget;
    this.music?.setIntensity(this.heat);
    this.tracks?.setEngaged(this.heat >= 0.34 ? 1 : 0);
    this.tracks?.setIntensity(this.heat, 1000);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.tracks?.dispose();
    this.music?.dispose();
    this.pool?.dispose();
    this.mixer?.dispose();
    void this.ctx?.close();
    this.buffers.clear();
    this.variants.clear();
    this.metrics.clear();
    this.readyFlag = false;
    this.initPromise = null;
  }
}

export const audio = new AudioSystem();

/** Re-exported so callers can type an `audio.play` result without importing types. */
export type { AudioHandle, AudioEmitOptions };

/** Unused-import guards for the take constants, kept for the bank's shape. */
export const AUDIO_BANK_SHAPE = {
  gunTakes: GUN_TAKES,
  impactTakes: IMPACT_TAKES,
  voiceTakes: VOICE_TAKES,
  ambienceLoopSeconds: AMB_LOOP,
} as const;
