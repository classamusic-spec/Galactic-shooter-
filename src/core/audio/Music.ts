/**
 * Adaptive score.
 *
 * The music is generated, not played back: a small orchestra of synthesised
 * one-shots (bowed pad, low brass, pizzicato cello, choir, taiko, metallic
 * percussion, sub) is sequenced live by a look-ahead scheduler over a Phrygian
 * or Aeolian mode chosen per world. Nothing loops, so nothing wears out.
 *
 * Intensity is a single 0..1 number driven by the combat state, and it gates
 * *stems* rather than switching tracks: the drone and shimmer are always
 * present, the ostinato enters around 0.2, percussion at 0.4, brass at 0.6 and
 * the choir only at 0.8. Because every stem is derived from the same mode and
 * tempo grid, layers can enter and leave on any bar without a transition.
 *
 * Phrygian is the deliberate default. Its flattened second gives the whole
 * score a permanent unresolved half-step that reads as dread rather than as
 * "minor key sad", which is exactly the register a hostile-galaxy shooter wants.
 */
import type { PlanetId } from '@/types';
import { Rng, clamp, clamp01 } from '@/util/math';
import {
  type BakeJob,
  filter,
  gainNode,
  modalBank,
  osc,
  percussiveGain,
  saturator,
  semis,
} from './Dsp';

export const MUSIC_RATE = 32000;

/** Every baked instrument is tuned to this, so playbackRate is pure transpose. */
const REF_HZ = 65.406; // C2

export type StemName = 'drone' | 'shimmer' | 'pulse' | 'perc' | 'brass' | 'choir';

export const STEM_NAMES: StemName[] = ['drone', 'shimmer', 'pulse', 'perc', 'brass', 'choir'];

// ---------------------------------------------------------------------------
// Instrument bakes
// ---------------------------------------------------------------------------

export function musicJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];

  // Bowed/synth pad: many detuned saws through a slow filter, long swell.
  jobs.push({
    id: 'mus_pad',
    duration: 5.5,
    normalize: 0.62,
    tailFade: 0.6,
    build: (ctx, dest, t0) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const rng = new Rng(0x9ad1);
      for (let i = 0; i < 7; i++) {
        const det = 1 + (i - 3) * 0.0032 + rng.range(-0.0012, 0.0012);
        const o = osc(ctx, 'sawtooth', REF_HZ * det * (i === 6 ? 2 : 1));
        const lp = filter(ctx, 'lowpass', 400, 1.1);
        lp.frequency.setValueAtTime(180, t0);
        lp.frequency.linearRampToValueAtTime(1500, t0 + 2.4);
        lp.frequency.exponentialRampToValueAtTime(320, t0 + 5.2);
        const g = ctx.createGain();
        g.gain.setValueAtTime(1e-4, t0);
        g.gain.exponentialRampToValueAtTime(0.16, t0 + 1.4);
        g.gain.setValueAtTime(0.16, t0 + 3.2);
        g.gain.exponentialRampToValueAtTime(1e-4, t0 + 5.4);
        o.connect(lp).connect(g).connect(out);
        o.start(t0);
        o.stop(t0 + 5.5);
      }
    },
  });

  // Sub drone: pure low weight, for the bottom of the mix.
  jobs.push({
    id: 'mus_sub',
    duration: 4.2,
    normalize: 0.7,
    tailFade: 0.5,
    build: (ctx, dest, t0) => {
      const o = osc(ctx, 'sine', REF_HZ * 0.5);
      const o2 = osc(ctx, 'triangle', REF_HZ);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1e-4, t0);
      g.gain.exponentialRampToValueAtTime(0.8, t0 + 0.5);
      g.gain.setValueAtTime(0.8, t0 + 2.4);
      g.gain.exponentialRampToValueAtTime(1e-4, t0 + 4.1);
      const g2 = gainNode(ctx, 0.22);
      o.connect(g).connect(dest);
      o2.connect(g2).connect(g);
      o.start(t0);
      o.stop(t0 + 4.2);
      o2.start(t0);
      o2.stop(t0 + 4.2);
    },
  });

  // Low brass: saw + square through a resonant lowpass, hard swell.
  jobs.push({
    id: 'mus_brass',
    duration: 2.8,
    normalize: 0.72,
    tailFade: 0.35,
    build: (ctx, dest, t0) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      for (let i = 0; i < 4; i++) {
        const o = osc(ctx, i % 2 ? 'square' : 'sawtooth', REF_HZ * (1 + i * 0.004));
        const lp = filter(ctx, 'lowpass', 900, 4.5);
        lp.frequency.setValueAtTime(240, t0);
        lp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.28);
        lp.frequency.exponentialRampToValueAtTime(420, t0 + 2.3);
        const sat = saturator(ctx, 2.4);
        const g = ctx.createGain();
        g.gain.setValueAtTime(1e-4, t0);
        g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.14);
        g.gain.setValueAtTime(0.28, t0 + 1.0);
        g.gain.exponentialRampToValueAtTime(1e-4, t0 + 2.7);
        o.connect(lp).connect(sat).connect(g).connect(out);
        o.start(t0);
        o.stop(t0 + 2.8);
      }
    },
  });

  // Choir: formant-filtered saw stack on an "ah" vowel.
  jobs.push({
    id: 'mus_choir',
    duration: 3.6,
    normalize: 0.6,
    tailFade: 0.5,
    build: (ctx, dest, t0) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const rng = new Rng(0x3f21);
      const sum = gainNode(ctx, 1);
      for (let i = 0; i < 6; i++) {
        const o = osc(ctx, 'sawtooth', REF_HZ * 4 * (1 + rng.range(-0.004, 0.004)));
        const vib = osc(ctx, 'sine', rng.range(4.2, 6.1));
        const vibG = gainNode(ctx, REF_HZ * 4 * 0.006);
        vib.connect(vibG).connect(o.frequency);
        vib.start(t0);
        vib.stop(t0 + 3.6);
        const g = gainNode(ctx, 0.16);
        o.connect(g).connect(sum);
        o.start(t0);
        o.stop(t0 + 3.6);
      }
      // Swell envelope first, then the "ah" formant triple.
      const env = ctx.createGain();
      env.gain.setValueAtTime(1e-4, t0);
      env.gain.exponentialRampToValueAtTime(1, t0 + 0.9);
      env.gain.setValueAtTime(1, t0 + 2.1);
      env.gain.exponentialRampToValueAtTime(1e-4, t0 + 3.5);
      sum.connect(env);
      for (const [f, q, a] of [
        [730, 8, 1],
        [1090, 10, 0.5],
        [2440, 12, 0.22],
      ] as const) {
        const bp = filter(ctx, 'bandpass', f, q);
        const g = gainNode(ctx, a);
        env.connect(bp).connect(g).connect(out);
      }
    },
  });

  // Pizzicato cello: a plucked string, short and dry — the ostinato voice.
  jobs.push({
    id: 'mus_pizz',
    duration: 1.1,
    normalize: 0.68,
    tailFade: 0.12,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      modalBank(
        ctx,
        out,
        t0,
        [
          { f: REF_HZ * 2, a: 0.55, decay: 0.55 },
          { f: REF_HZ * 4, a: 0.3, decay: 0.36 },
          { f: REF_HZ * 6.02, a: 0.16, decay: 0.22 },
          { f: REF_HZ * 8.05, a: 0.08, decay: 0.14 },
          { f: REF_HZ * 10.1, a: 0.04, decay: 0.09 },
        ],
        1,
      );
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 2600, 2);
      const env = percussiveGain(ctx, t0, 0.3, 0.0004, 0.02);
      nz.connect(bp).connect(env).connect(out);
      nz.start(t0, 0.9);
      nz.stop(t0 + 0.1);
    },
  });

  // Taiko: big skin drum. Pitch-bent sine plus a noise slap.
  jobs.push({
    id: 'mus_taiko',
    duration: 1.6,
    normalize: 0.85,
    tailFade: 0.2,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      for (const [f, lvl, dec] of [
        [58, 1, 0.7],
        [88, 0.5, 0.45],
        [131, 0.25, 0.3],
      ] as const) {
        const o = osc(ctx, 'sine', f);
        o.frequency.setValueAtTime(f * 2.1, t0);
        o.frequency.exponentialRampToValueAtTime(f, t0 + 0.07);
        const env = percussiveGain(ctx, t0, lvl, 0.0007, dec);
        const sat = saturator(ctx, 2);
        o.connect(sat).connect(env).connect(out);
        o.start(t0);
        o.stop(t0 + 1.5);
      }
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 1400, 1.1);
      const env = percussiveGain(ctx, t0, 0.4, 0.0004, 0.05);
      nz.connect(bp).connect(env).connect(out);
      nz.start(t0, 1.7);
      nz.stop(t0 + 0.3);
    },
  });

  // Struck metal: the "industrial" colour that keeps it from sounding fantasy.
  jobs.push({
    id: 'mus_metal',
    duration: 1.8,
    normalize: 0.55,
    tailFade: 0.25,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const rng = new Rng(0x5b7);
      const modes = [];
      for (let i = 0; i < 9; i++) {
        modes.push({
          f: 240 * Math.pow(1 + i, 1.31) * rng.range(0.96, 1.04),
          a: 0.4 / (1 + i * 0.6),
          decay: 1.4 / (1 + i * 0.45),
        });
      }
      modalBank(ctx, out, t0, modes, 1);
      const nz = bank.source('white');
      const hp = filter(ctx, 'highpass', 2400, 0.9);
      const env = percussiveGain(ctx, t0, 0.3, 0.0003, 0.03);
      nz.connect(hp).connect(env).connect(out);
      nz.start(t0, 2.1);
      nz.stop(t0 + 0.2);
    },
  });

  // High shimmer: a slow bell cloud for the ambient stem.
  jobs.push({
    id: 'mus_shimmer',
    duration: 3.2,
    normalize: 0.42,
    tailFade: 0.5,
    build: (ctx, dest, t0) => {
      const rng = new Rng(0xc0de);
      const modes = [];
      for (let i = 0; i < 7; i++) {
        modes.push({
          f: REF_HZ * 8 * Math.pow(2, i * 0.19) * rng.range(0.995, 1.005),
          a: 0.22 / (1 + i * 0.4),
          decay: 2.6 / (1 + i * 0.3),
        });
      }
      modalBank(ctx, dest, t0, modes, 1);
    },
  });

  return jobs;
}

// ---------------------------------------------------------------------------
// The sequencer
// ---------------------------------------------------------------------------

/** Phrygian and Aeolian, as semitone offsets from the root. */
const MODES = {
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
} as const;

interface WorldMusic {
  /** Root note as semitones from C2. */
  root: number;
  mode: keyof typeof MODES;
  bpm: number;
  /** Colour bias: how much metal/taiko vs strings/choir. */
  industrial: number;
}

const WORLDS: Record<PlanetId | 'orbit', WorldMusic> = {
  aurvangr: { root: 2, mode: 'aeolian', bpm: 74, industrial: 0.25 },
  'zeta-reticuli': { root: 8, mode: 'phrygian', bpm: 82, industrial: 0.7 },
  khepri: { root: 5, mode: 'aeolian', bpm: 88, industrial: 0.35 },
  'hive-prime': { root: 1, mode: 'phrygian', bpm: 92, industrial: 0.55 },
  'draco-ix': { root: 0, mode: 'phrygian', bpm: 78, industrial: 0.6 },
  orbit: { root: 7, mode: 'aeolian', bpm: 66, industrial: 0.15 },
};

/** Chord degrees the progression walks, per bar. i – bII – i – bVII in Phrygian. */
const PROGRESSION = [0, 1, 0, 6, 0, 5, 3, 6];

export interface MusicHost {
  readonly ctx: AudioContext;
  /** Destination for the music bus. */
  readonly bus: AudioNode;
  buffer(id: string): AudioBuffer | undefined;
}

export class MusicEngine {
  private host: MusicHost;
  private stems = new Map<StemName, GainNode>();
  private rng = new Rng(0x1b3d5f);
  private world: WorldMusic = WORLDS.orbit;
  private nextBeat = 0;
  private beat = 0;
  private running = false;
  private timer = 0;
  private intensity = 0;
  private targetIntensity = 0;
  private levels: Record<StemName, number> = {
    drone: 0,
    shimmer: 0,
    pulse: 0,
    perc: 0,
    brass: 0,
    choir: 0,
  };

  /** Gate thresholds: a stem fades in over the 0.18 above its threshold. */
  private static readonly GATES: Record<StemName, number> = {
    drone: -1,
    shimmer: -0.5,
    pulse: 0.16,
    perc: 0.38,
    brass: 0.6,
    choir: 0.8,
  };

  constructor(host: MusicHost) {
    this.host = host;
    for (const name of STEM_NAMES) {
      const g = host.ctx.createGain();
      g.gain.value = 0;
      g.connect(host.bus);
      this.stems.set(name, g);
    }
  }

  setWorld(id: PlanetId | 'orbit'): void {
    const w = WORLDS[id] ?? WORLDS.orbit;
    if (w === this.world) return;
    this.world = w;
    // Re-anchor the grid so the change lands on the next bar, not mid-beat.
    this.beat = 0;
    this.nextBeat = Math.max(this.nextBeat, this.host.ctx.currentTime + 0.2);
  }

  setIntensity(v: number): void {
    this.targetIntensity = clamp01(v);
  }

  get currentIntensity(): number {
    return this.intensity;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextBeat = this.host.ctx.currentTime + 0.15;
  }

  stop(): void {
    this.running = false;
    for (const g of this.stems.values()) {
      g.gain.cancelScheduledValues(this.host.ctx.currentTime);
      g.gain.setTargetAtTime(0, this.host.ctx.currentTime, 0.4);
    }
  }

  /**
   * Called from the render loop. Advances the look-ahead scheduler and the
   * stem-level smoothing. Allocation-free.
   */
  update(dt: number): void {
    if (!this.running) return;
    // Intensity rises fast (a fight starts instantly) and falls slowly (the
    // adrenaline tail is what makes a lull feel earned).
    const rate = this.targetIntensity > this.intensity ? 2.4 : 0.32;
    this.intensity += (this.targetIntensity - this.intensity) * clamp01(rate * dt);

    const ctx = this.host.ctx;
    for (const name of STEM_NAMES) {
      const gate = MusicEngine.GATES[name];
      const want = clamp01((this.intensity - gate) / 0.18);
      const level = name === 'shimmer' ? want * (1 - this.intensity * 0.55) : want;
      if (Math.abs(level - this.levels[name]) > 0.004) {
        this.levels[name] = level;
        const g = this.stems.get(name);
        if (g) g.gain.setTargetAtTime(level, ctx.currentTime, 0.6);
      }
    }

    this.timer += dt;
    if (this.timer < 0.05) return;
    this.timer = 0;
    this.schedule();
  }

  private schedule(): void {
    const ctx = this.host.ctx;
    const horizon = ctx.currentTime + 0.7;
    const bpm = this.world.bpm * (1 + this.intensity * 0.1);
    const beatDur = 60 / bpm;
    let guard = 0;
    if (this.nextBeat < ctx.currentTime) this.nextBeat = ctx.currentTime + 0.05;
    while (this.nextBeat < horizon && guard++ < 16) {
      this.placeBeat(this.beat, this.nextBeat, beatDur);
      this.beat++;
      this.nextBeat += beatDur;
    }
  }

  private degreeHz(degree: number, octave: number): number {
    const scale = MODES[this.world.mode];
    const idx = ((degree % scale.length) + scale.length) % scale.length;
    const oct = Math.floor(degree / scale.length) + octave;
    return REF_HZ * semis(this.world.root + scale[idx] + oct * 12);
  }

  private fire(
    stem: StemName,
    id: string,
    when: number,
    hz: number,
    gain: number,
    pan = 0,
  ): void {
    const bus = this.stems.get(stem);
    const buf = this.host.buffer(id);
    if (!bus || !buf) return;
    const ctx = this.host.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clamp(hz / REF_HZ, 0.06, 12);
    const g = ctx.createGain();
    g.gain.value = gain;
    if (pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      src.connect(g).connect(p).connect(bus);
    } else {
      src.connect(g).connect(bus);
    }
    src.start(when);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }

  private placeBeat(beat: number, when: number, beatDur: number): void {
    const bar = Math.floor(beat / 4);
    const inBar = beat % 4;
    const chord = PROGRESSION[bar % PROGRESSION.length];
    const rng = this.rng;

    // -- drone: one long pad + sub per two bars --------------------------
    if (inBar === 0 && bar % 2 === 0) {
      const root = this.degreeHz(chord, 0);
      this.fire('drone', 'mus_pad', when, root, 0.5, -0.2);
      this.fire('drone', 'mus_pad', when + 0.02, this.degreeHz(chord + 4, 0), 0.34, 0.25);
      this.fire('drone', 'mus_sub', when, root * 0.5, 0.55);
    }

    // -- shimmer: sparse high bells, avoiding the downbeat ----------------
    if (this.levels.shimmer > 0.02 && inBar !== 0 && rng.bool(0.3)) {
      this.fire(
        'shimmer',
        'mus_shimmer',
        when + rng.range(0, beatDur * 0.5),
        this.degreeHz(chord + rng.int(0, 6), 2),
        0.3,
        rng.range(-0.7, 0.7),
      );
    }

    // -- pulse: driving eighth-note ostinato -------------------------------
    if (this.levels.pulse > 0.02) {
      const pattern = [0, 2, 4, 2];
      for (let s = 0; s < 2; s++) {
        const t = when + s * beatDur * 0.5;
        if (s === 1 && !rng.bool(0.55 + this.intensity * 0.35)) continue;
        const deg = chord + pattern[(inBar + s) % pattern.length];
        this.fire(
          'pulse',
          'mus_pizz',
          t,
          this.degreeHz(deg, 1),
          (s === 0 ? 0.5 : 0.3) * (0.7 + this.intensity * 0.4),
          s === 0 ? -0.25 : 0.25,
        );
      }
    }

    // -- perc: taiko on 1 and 3, metal accents ----------------------------
    if (this.levels.perc > 0.02) {
      if (inBar === 0 || inBar === 2) {
        this.fire('perc', 'mus_taiko', when, REF_HZ * (inBar === 0 ? 1 : 1.06), 0.75);
      }
      if (inBar === 3 && rng.bool(0.5 + this.intensity * 0.3)) {
        this.fire('perc', 'mus_taiko', when + beatDur * 0.5, REF_HZ * 1.12, 0.45);
      }
      if (rng.bool(this.world.industrial * (0.25 + this.intensity * 0.4))) {
        this.fire(
          'perc',
          'mus_metal',
          when + rng.range(0, beatDur * 0.75),
          REF_HZ * rng.range(0.7, 1.9),
          0.3,
          rng.range(-0.8, 0.8),
        );
      }
    }

    // -- brass: chord stabs on bar boundaries ------------------------------
    if (this.levels.brass > 0.02 && inBar === 0) {
      this.fire('brass', 'mus_brass', when, this.degreeHz(chord, 0), 0.55, -0.15);
      this.fire('brass', 'mus_brass', when + 0.015, this.degreeHz(chord + 2, 0), 0.32, 0.2);
      if (rng.bool(0.4)) {
        this.fire('brass', 'mus_brass', when + beatDur * 2, this.degreeHz(chord + 4, 0), 0.3, 0.05);
      }
    }

    // -- choir: sustained top line, one entry per two bars ------------------
    if (this.levels.choir > 0.02 && inBar === 0 && bar % 2 === 1) {
      this.fire('choir', 'mus_choir', when, this.degreeHz(chord + 4, 0) * 0.25, 0.4, -0.3);
      this.fire('choir', 'mus_choir', when + 0.04, this.degreeHz(chord + 7, 0) * 0.25, 0.3, 0.3);
    }
  }

  dispose(): void {
    this.stop();
    for (const g of this.stems.values()) g.disconnect();
    this.stems.clear();
  }
}
