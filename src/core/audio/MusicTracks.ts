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
  /** Level the current fade started from. */
  from: number;
  /** Level the current fade is heading to. */
  to: number;
  /** Audio-clock time the current fade started at. */
  startedAt: number;
  /** Fade length in seconds. */
  dur: number;
  /** Once true and silent, the source is stopped and the voice dropped. */
  retiring: boolean;
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
  /** Voices fading out after a world change, kept until they reach silence. */
  private retiring: Voice[] = [];
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
    this.advance(Math.min(dt, 0.25));
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
    for (const voice of this.retiring) {
      try {
        voice.source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.retiring.length = 0;
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

    const previous = this.voices.get(role);
    if (previous) {
      previous.retiring = true;
      this.ramp(previous, 0, FADE_WORLD);
      this.retiring.push(previous);
    }
    this.voices.set(role, {
      source,
      gain,
      from: 0,
      to: 0,
      startedAt: ctx.currentTime,
      dur: FADE_WORLD,
      retiring: false,
    });
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
   * Begin an equal-power fade. The shape is applied per frame by `advance`.
   *
   * Neither built-in ramp is right for swapping two pieces of music. A linear
   * ramp dips through the middle, because two uncorrelated signals sum in power,
   * not amplitude — the crossfade audibly sags. An exponential ramp from the
   * silence floor errs the other way: almost all its travel happens in the last
   * fifth, so the incoming track appears to jump in late. A cos/sin pair holds
   * total power constant, which is what makes the swap sound like one continuous
   * piece of music.
   *
   * That shape was first scheduled with `setValueCurveAtTime`, which is the
   * obvious way to express it — and it threw. Chrome refuses a curve, a
   * `setValueAtTime`, or even a `cancelAndHoldAtTime` that lands inside a curve
   * that is already running, so interrupting one fade with another (flying to a
   * second world before the first has faded) raised NotSupportedError from
   * inside `travelTo`. Driving the shape from the audio frame loop instead makes
   * an interruption just a new `from`, and nothing on the audio path can throw.
   */
  private ramp(voice: Voice | undefined, target: number, fade: number): void {
    if (!voice) return;
    voice.from = voice.gain.gain.value;
    voice.to = target;
    voice.startedAt = this.host.ctx.currentTime;
    voice.dur = Math.max(fade, 0.05);
  }

  /**
   * Advance every fade. Called once per audio frame from `setIntensity`.
   *
   * Progress comes from the audio clock, not from accumulated frame deltas. The
   * frame loop clamps its own dt to 100 ms to survive a stall, so a
   * delta-accumulated fade silently stretches to ten times its length once the
   * renderer drops under 10 fps — a two-second crossfade taking half a minute.
   * Sampling a real-time curve means a slow frame only makes the fade *coarser*,
   * never longer.
   */
  private advance(dt: number): void {
    const now = this.host.ctx.currentTime;
    const step = (voice: Voice): boolean => {
      const t = Math.min(1, Math.max(0, (now - voice.startedAt) / voice.dur));
      const x = t * (Math.PI / 2);
      const v = voice.from * Math.cos(x) + voice.to * Math.sin(x);
      // A short linear ramp to the next frame's value rather than a bare
      // assignment: stepping a gain once a frame is a zipper, and a ramp this
      // short is indistinguishable from the curve it samples.
      const g = voice.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(Math.max(0, v), now + Math.max(dt, 1 / 240));
      return t >= 1 && voice.retiring;
    };
    for (const voice of this.voices.values()) step(voice);
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      if (step(this.retiring[i])) {
        try {
          this.retiring[i].source.stop();
        } catch {
          /* already stopped */
        }
        this.retiring.splice(i, 1);
      }
    }
  }

  private stopAll(fade: number): void {
    for (const voice of this.voices.values()) {
      voice.retiring = true;
      this.ramp(voice, 0, fade);
      this.retiring.push(voice);
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
