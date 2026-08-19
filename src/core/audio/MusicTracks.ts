/**
 * Recorded score: two tracks per world, crossfaded by combat intensity.
 *
 * The generated `MusicEngine` is still here and still correct — it just yields
 * to a recorded track whenever one exists for the current world, and takes over
 * again on any world whose files are missing or fail to load. That fallback is
 * the reason every failure path here is silent: a 404 on a music file must cost
 * the player nothing but a different soundtrack.
 *
 * ## Why both tracks play at once
 *
 * The ambient and combat tracks for a world are independent songs of different
 * lengths, so they cannot be bar-aligned. Starting the combat track on demand
 * would mean either a hard cut or a fade from silence, and returning to ambient
 * would restart it from the top every lull. Instead both sources run looped from
 * the moment the world loads and only the *gains* move. A silent
 * AudioBufferSourceNode costs almost nothing, each track keeps its own timeline,
 * and switching is a gain ramp rather than a re-cue — so a fight can start on
 * any beat and the lull afterwards drops back into the ambient track exactly
 * where it would have been.
 *
 * ## Why the switch has hysteresis and a dwell
 *
 * Combat intensity is noisy: it spikes on every hit and decays continuously, so
 * a single threshold makes the music flap between states during one firefight.
 * Entering at 0.34 and leaving at 0.14 gives a wide dead band, and an 8 s
 * minimum dwell means a two-second lull mid-fight cannot pull the combat track
 * out from under the player.
 */
import type { PlanetId } from '@/types';

export type MusicWorldId = PlanetId | 'orbit';
export type TrackRole = 'ambient' | 'combat';

/**
 * Which file backs which world. Paths are relative to the site root and resolve
 * to `public/music/`, so replacing a track is a file swap with no code change —
 * keep the name and Vite will serve it.
 */
export const MUSIC_MANIFEST: Record<MusicWorldId, Partial<Record<TrackRole, string>>> = {
  // Orbit has no combat, so it deliberately has no combat track.
  orbit: { ambient: 'music/orbit-ambient.mp3' },
  aurvangr: { ambient: 'music/aurvangr-ambient.mp3', combat: 'music/aurvangr-combat.mp3' },
  'zeta-reticuli': {
    ambient: 'music/zeta-reticuli-ambient.mp3',
    combat: 'music/zeta-reticuli-combat.mp3',
  },
  khepri: { ambient: 'music/khepri-ambient.mp3', combat: 'music/khepri-combat.mp3' },
  'hive-prime': { ambient: 'music/hive-prime-ambient.mp3', combat: 'music/hive-prime-combat.mp3' },
  'draco-ix': { ambient: 'music/draco-ix-ambient.mp3', combat: 'music/draco-ix-combat.mp3' },
};

/** Intensity at or above which the combat track takes over. */
const ENTER_COMBAT = 0.34;
/** Intensity at or below which the ambient track comes back. */
const LEAVE_COMBAT = 0.14;
/** Combat must hold for this long before it can release, seconds. */
const MIN_COMBAT_DWELL = 8;
/**
 * Combat also releases once nothing has been actively fighting the player for
 * this long, whatever the intensity says.
 *
 * Intensity counts nearby enemies, so on a densely populated map it can sit
 * above the release threshold forever and strand the combat track on. "Nobody
 * has engaged me in ten seconds" is the signal that cannot be gamed by crowding.
 */
const QUIET_RELEASE = 10;
/** Ambient -> combat ramp. Short: a fight starting should be felt immediately. */
const FADE_IN_COMBAT = 2.2;
/** Combat -> ambient ramp. Long: a lull should settle, not snap. */
const FADE_OUT_COMBAT = 5;
/** World -> world ramp, and the fade used when a track finishes loading. */
const FADE_WORLD = 2.6;

/** Per-track trim so no world is noticeably louder than its neighbours. */
const TRACK_GAIN = 0.9;

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export interface MusicTracksHost {
  readonly ctx: AudioContext;
  /** Destination for recorded music — the same bus the generated score uses. */
  readonly bus: AudioNode;
  /**
   * Gain on the generated score, ducked to 0 while a recorded track is playing
   * and restored when there is nothing to play.
   */
  readonly generated: GainNode;
}

export class MusicTracks {
  private host: MusicTracksHost;
  private buffers = new Map<string, AudioBuffer | null>();
  private inflight = new Map<string, Promise<AudioBuffer | null>>();
  private voices = new Map<TrackRole, Voice>();
  private world: MusicWorldId | null = null;
  /** Bumped on every world change; a load that resolves late checks it. */
  private generation = 0;
  private inCombat = false;
  private combatSince = 0;
  /** Seconds since the last step that had an enemy engaged with the player. */
  private quietFor = 0;
  private engaged = 0;
  private disposed = false;

  constructor(host: MusicTracksHost) {
    this.host = host;
  }

  /** True once at least one recorded track is audible. Drives the fallback. */
  get active(): boolean {
    return this.voices.size > 0;
  }

  /** Live gain of each recorded voice — the check that the crossfade really ran. */
  get gains(): Record<TrackRole, number> {
    const read = (r: TrackRole): number =>
      Math.round((this.voices.get(r)?.gain.gain.value ?? 0) * 1000) / 1000;
    return { ambient: read('ambient'), combat: read('combat') };
  }

  /** What is playing right now, for the HUD debug readout and the test harness. */
  get state(): 'none' | 'ambient' | 'combat' {
    if (!this.voices.size) return 'none';
    return this.inCombat && this.voices.has('combat') ? 'combat' : 'ambient';
  }

  /**
   * Switch worlds. Fades out whatever is playing, then starts the new world's
   * tracks as they decode — the two are independent, so the ambient bed can come
   * up while the combat track is still downloading.
   */
  setWorld(id: MusicWorldId): void {
    if (this.disposed || this.world === id) return;
    this.world = id;
    this.generation++;
    const gen = this.generation;

    this.stopAll(FADE_WORLD);
    this.inCombat = false;
    this.combatSince = 0;
    this.quietFor = 0;
    this.engaged = 0;

    const entry = MUSIC_MANIFEST[id];
    if (!entry) {
      this.setGeneratedGain(1, FADE_WORLD);
      return;
    }
    for (const role of ['ambient', 'combat'] as const) {
      const url = entry[role];
      if (!url) continue;
      void this.load(url).then((buf) => {
        // A world change during the download makes this result stale. Without
        // this guard, flying away mid-load starts the previous world's music
        // over the top of the new one.
        if (this.disposed || gen !== this.generation || !buf) return;
        this.start(role, buf);
      });
    }
  }

  /**
   * Start downloading and decoding a world's tracks without switching to them.
   *
   * Called when travel begins rather than when it ends. Decoding a three-minute
   * MP3 is seconds of work on top of the download, and measured cold it left
   * thirteen seconds between landing and the music starting — the generated
   * score covering a gap that the level load was already long enough to hide.
   * Buffers are cached by URL, so the `setWorld` on arrival finds them ready.
   */
  prefetch(id: MusicWorldId): void {
    if (this.disposed) return;
    const entry = MUSIC_MANIFEST[id];
    if (!entry) return;
    for (const role of ['ambient', 'combat'] as const) {
      const url = entry[role];
      if (url) void this.load(url);
    }
  }

  /**
   * Combat intensity, 0..1. Called every frame; the hysteresis and dwell below
   * are what turn that continuous signal into a stable two-state switch.
   */
  setIntensity(v: number, dt: number): void {
    if (this.disposed) return;
    this.quietFor = this.engaged > 0 ? 0 : this.quietFor + dt;
    if (this.inCombat) {
      this.combatSince += dt;
      const settled = v <= LEAVE_COMBAT && this.combatSince >= MIN_COMBAT_DWELL;
      if (settled || this.quietFor >= QUIET_RELEASE) {
        this.inCombat = false;
        this.applyMix(FADE_OUT_COMBAT);
      }
    } else if (v >= ENTER_COMBAT && this.voices.has('combat')) {
      this.inCombat = true;
      this.combatSince = 0;
      this.applyMix(FADE_IN_COMBAT);
    }
  }

  /** How many enemies are actively fighting the player, from the AI director. */
  setEngaged(n: number): void {
    this.engaged = n;
  }

  /** Drop straight back to the ambient bed — used when the player dies. */
  releaseCombat(): void {
    if (!this.inCombat) return;
    this.inCombat = false;
    this.applyMix(FADE_OUT_COMBAT);
  }

  dispose(): void {
    this.disposed = true;
    this.stopAll(0.4);
    this.buffers.clear();
    this.inflight.clear();
  }

  // -- internals ------------------------------------------------------------

  private async load(url: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(url);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(url);
    if (pending) return pending;

    const job = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const bytes = await res.arrayBuffer();
        const buf = await this.host.ctx.decodeAudioData(bytes);
        this.buffers.set(url, buf);
        return buf;
      } catch (err) {
        // Cached as null so a missing file is not re-fetched on every visit.
        this.buffers.set(url, null);
        console.warn(`[music] ${url} unavailable; using the generated score`, err);
        return null;
      } finally {
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, job);
    return job;
  }

  private start(role: TrackRole, buffer: AudioBuffer): void {
    const ctx = this.host.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.host.bus);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    // Combat enters mid-track rather than from the top: the first bars of a
    // combat cue are its quietest, and a fight does not start at bar one.
    source.start(0, role === 'combat' ? Math.min(4, buffer.duration * 0.05) : 0);

    this.voices.get(role)?.source.stop();
    this.voices.set(role, { source, gain });
    this.applyMix(FADE_WORLD);
    this.setGeneratedGain(0, FADE_WORLD);
  }

  /** Push both voices to whatever the current combat state says they should be. */
  private applyMix(fade: number): void {
    const wantCombat = this.inCombat && this.voices.has('combat');
    this.ramp(this.voices.get('ambient'), wantCombat ? 0 : TRACK_GAIN, fade);
    this.ramp(this.voices.get('combat'), wantCombat ? TRACK_GAIN : 0, fade);
  }

  /**
   * Equal-power ramp.
   *
   * Neither built-in ramp is right for swapping two pieces of music. A linear
   * ramp dips in the middle, because two uncorrelated signals sum in power, not
   * amplitude — the crossfade audibly sags. An exponential ramp from the silence
   * floor is worse in the other direction: almost all of its travel happens in
   * the last fifth of the fade, so the incoming track appears to jump in late.
   * The cos/sin pair below holds total power constant across the swap, which is
   * what makes it sound like one continuous piece of music.
   */
  private ramp(voice: Voice | undefined, target: number, fade: number): void {
    if (!voice) return;
    const g = voice.gain.gain;
    const t = this.host.ctx.currentTime;
    const dur = Math.max(fade, 0.05);
    // Hold at the value actually reached before replacing the schedule, or a
    // switch that interrupts an earlier fade restarts from the wrong level.
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t);
    else g.cancelScheduledValues(t);
    const from = g.value;

    const N = 64;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * (Math.PI / 2);
      curve[i] = from * Math.cos(x) + target * Math.sin(x);
    }
    try {
      g.setValueCurveAtTime(curve, t, dur);
    } catch {
      // Overlapping an in-flight curve throws in some engines. A linear ramp is
      // the wrong shape but an inaudible fallback beats an exception on the
      // audio path.
      g.cancelScheduledValues(t);
      g.setValueAtTime(from, t);
      g.linearRampToValueAtTime(target, t + dur);
    }
  }

  private stopAll(fade: number): void {
    const t = this.host.ctx.currentTime;
    for (const voice of this.voices.values()) {
      this.ramp(voice, 0, fade);
      try {
        voice.source.stop(t + fade + 0.1);
      } catch {
        /* already stopped */
      }
    }
    this.voices.clear();
    this.setGeneratedGain(1, fade);
  }

  private setGeneratedGain(target: number, fade: number): void {
    const t = this.host.ctx.currentTime;
    const g = this.host.generated.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + Math.max(fade, 0.05));
  }
}
