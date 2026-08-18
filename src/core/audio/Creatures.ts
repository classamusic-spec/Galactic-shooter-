/**
 * Creature voices.
 *
 * Every species uses the same engine — a glottal source (buzz plus breath)
 * through three resonant formants — and differs only in where those formants
 * sit, how much of the source is noise, and how the fundamental moves across
 * the phrase. That is also how real vocal tracts differ, which is why this
 * reads as "different animals" rather than "same synth, different EQ".
 *
 * Five states per faction (idle, alert, attack, hurt, death) at three takes
 * each, so a squad of six never chorus-lines the same bark.
 */
import type { FactionId } from '@/types';
import { Rng } from '@/util/math';
import {
  type BakeJob,
  type FormantVoice,
  type NoiseBank,
  filter,
  formantVoice,
  gainNode,
  modalBank,
  osc,
  percussiveGain,
} from './Dsp';

export type VoiceState = 'idle' | 'alert' | 'attack' | 'hurt' | 'death';

export const VOICE_STATES: VoiceState[] = ['idle', 'alert', 'attack', 'hurt', 'death'];
export const VOICE_FACTIONS: FactionId[] = [
  'nordic',
  'grey',
  'mantis',
  'insectoid',
  'reptilian',
  'federation',
];
export const VOICE_TAKES = 3;

interface SpeciesVoice {
  f0: number;
  formants: readonly [number, number, number];
  qs: readonly [number, number, number];
  breath: number;
  growl: number;
  growlHz: number;
  wave: OscillatorType;
  /** Extra clicks/chitters layered on top, 0 disables. */
  clicks: number;
  clickHz: number;
  /** Radio-comms band-limiting, for the Federation. */
  radio: boolean;
}

const SPECIES: Record<FactionId, SpeciesVoice> = {
  nordic: {
    f0: 92,
    formants: [400, 1080, 2380],
    qs: [7, 9, 11],
    breath: 0.16,
    growl: 0.035,
    growlHz: 22,
    wave: 'sawtooth',
    clicks: 0,
    clickHz: 0,
    radio: false,
  },
  grey: {
    f0: 205,
    formants: [720, 1960, 3050],
    qs: [12, 15, 14],
    breath: 0.34,
    growl: 0.11,
    growlHz: 46,
    wave: 'square',
    clicks: 0.35,
    clickHz: 5200,
    radio: false,
  },
  mantis: {
    f0: 318,
    formants: [1420, 2680, 4300],
    qs: [16, 18, 14],
    breath: 0.52,
    growl: 0.33,
    growlHz: 29,
    wave: 'sawtooth',
    clicks: 0.9,
    clickHz: 6400,
    radio: false,
  },
  insectoid: {
    f0: 148,
    formants: [880, 1830, 3390],
    qs: [10, 13, 12],
    breath: 0.42,
    growl: 0.46,
    growlHz: 41,
    wave: 'square',
    clicks: 0.7,
    clickHz: 4100,
    radio: false,
  },
  reptilian: {
    f0: 78,
    formants: [370, 905, 2110],
    qs: [6, 8, 9],
    breath: 0.5,
    growl: 0.075,
    growlHz: 17,
    wave: 'sawtooth',
    clicks: 0.15,
    clickHz: 2600,
    radio: false,
  },
  federation: {
    f0: 132,
    formants: [560, 1430, 2510],
    qs: [9, 11, 12],
    breath: 0.2,
    growl: 0.02,
    growlHz: 25,
    wave: 'sawtooth',
    clicks: 0,
    clickHz: 0,
    radio: true,
  },
};

interface StateShape {
  duration: number;
  /** Fundamental multiplier at start and end of the phrase. */
  pitch: number;
  pitchEnd: number;
  level: number;
  attack: number;
  release: number;
  breathAdd: number;
  clickScale: number;
}

const STATES: Record<VoiceState, StateShape> = {
  idle: {
    duration: 0.62,
    pitch: 0.9,
    pitchEnd: 0.78,
    level: 0.4,
    attack: 0.06,
    release: 0.22,
    breathAdd: 0.1,
    clickScale: 0.6,
  },
  alert: {
    duration: 0.55,
    pitch: 1.05,
    pitchEnd: 1.45,
    level: 0.75,
    attack: 0.012,
    release: 0.14,
    breathAdd: -0.05,
    clickScale: 1.1,
  },
  attack: {
    duration: 0.78,
    pitch: 1.35,
    pitchEnd: 0.85,
    level: 1,
    attack: 0.006,
    release: 0.2,
    breathAdd: 0.05,
    clickScale: 1.4,
  },
  hurt: {
    duration: 0.42,
    pitch: 1.5,
    pitchEnd: 1.1,
    level: 0.85,
    attack: 0.004,
    release: 0.12,
    breathAdd: 0.16,
    clickScale: 0.8,
  },
  death: {
    duration: 1.45,
    pitch: 1.2,
    pitchEnd: 0.42,
    level: 0.95,
    attack: 0.008,
    release: 0.55,
    breathAdd: 0.24,
    clickScale: 0.5,
  },
};

function build(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  t0: number,
  bank: NoiseBank,
  sp: SpeciesVoice,
  st: StateShape,
  rng: Rng,
): void {
  let out: AudioNode = gainNode(ctx, 1);
  (out as GainNode).connect(dest);

  if (sp.radio) {
    // Comms chain: band-limit hard, then add a little grit and squelch.
    const hp = filter(ctx, 'highpass', 420, 0.9);
    const lp = filter(ctx, 'lowpass', 3100, 0.9);
    const pk = filter(ctx, 'peaking', 1700, 1.6, 6);
    hp.connect(pk).connect(lp).connect(out as GainNode);
    out = hp;
    // Squelch tail.
    const nz = bank.source('white');
    const nhp = filter(ctx, 'highpass', 2400, 1);
    const env = percussiveGain(ctx, t0 + st.duration * 0.94, 0.18, 0.002, 0.06);
    nz.connect(nhp).connect(env).connect(dest);
    nz.start(t0 + st.duration * 0.94, rng.range(0, 2));
    nz.stop(t0 + st.duration + 0.2);
  }

  const jitterPitch = rng.range(0.9, 1.12);
  const v: FormantVoice = {
    f0: sp.f0 * st.pitch * jitterPitch,
    f0End: sp.f0 * st.pitchEnd * jitterPitch,
    formants: [
      sp.formants[0] * rng.range(0.93, 1.08),
      sp.formants[1] * rng.range(0.94, 1.07),
      sp.formants[2] * rng.range(0.95, 1.06),
    ],
    qs: sp.qs,
    breath: Math.max(0.02, Math.min(0.95, sp.breath + st.breathAdd + rng.range(-0.06, 0.06))),
    growl: sp.growl * rng.range(0.7, 1.35),
    growlHz: sp.growlHz * rng.range(0.8, 1.25),
    duration: st.duration * rng.range(0.88, 1.14),
    attack: st.attack,
    release: st.release,
    level: st.level,
    wave: sp.wave,
  };
  formantVoice(ctx, bank, out, t0, v);

  // Mandible clicks / chitters — the layer that sells "insect" over "animal".
  const clickAmt = sp.clicks * st.clickScale;
  if (clickAmt > 0.02) {
    const count = Math.round(2 + clickAmt * 9);
    for (let i = 0; i < count; i++) {
      const at = t0 + rng.range(0, v.duration * 0.85);
      const bp = filter(ctx, 'bandpass', sp.clickHz * rng.range(0.6, 1.6), 8);
      const nz = bank.source('white');
      const env = percussiveGain(ctx, at, clickAmt * rng.range(0.08, 0.26), 0.00018, 0.006);
      nz.connect(bp).connect(env).connect(out);
      nz.start(at, rng.range(0, 2.5));
      nz.stop(at + 0.04);
    }
  }

  // Chest resonance for the big species — a low modal thump under the shout.
  if (sp.f0 < 110 && st.level > 0.6) {
    modalBank(
      ctx,
      out,
      t0,
      [
        { f: sp.f0 * 0.72, a: 0.22 * st.level, decay: v.duration * 0.55 },
        { f: sp.f0 * 1.31, a: 0.11 * st.level, decay: v.duration * 0.35 },
      ],
      1,
    );
  }
}

export function creatureJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];
  let seed = 0x2c9f1;
  for (const faction of VOICE_FACTIONS) {
    const sp = SPECIES[faction];
    for (const state of VOICE_STATES) {
      const st = STATES[state];
      for (let take = 0; take < VOICE_TAKES; take++) {
        const rng = new Rng((seed = (seed * 22695477 + 1) >>> 0));
        jobs.push({
          id: `voice_${faction}_${state}_${take}`,
          duration: st.duration * 1.25 + 0.25,
          normalize: state === 'idle' ? 0.4 : 0.66,
          tailFade: 0.08,
          build: (ctx, dest, t0, bank) => build(ctx, dest, t0, bank, sp, st, rng),
        });
      }
    }
  }
  return jobs;
}

/** Enemy ranged-attack sounds, one per faction, so a shot reads as *theirs*. */
export function enemyWeaponJobs(): BakeJob[] {
  const specs: Array<[FactionId, number, number, OscillatorType, number]> = [
    ['nordic', 520, 0.14, 'sawtooth', 0.9],
    ['grey', 1650, 0.09, 'sine', 0.7],
    ['mantis', 980, 0.11, 'square', 0.75],
    ['insectoid', 340, 0.16, 'sawtooth', 0.85],
    ['reptilian', 700, 0.13, 'sawtooth', 0.95],
    ['federation', 820, 0.1, 'square', 0.8],
  ];
  const jobs: BakeJob[] = [];
  for (const [faction, hz, decay, wave, level] of specs) {
    for (let take = 0; take < 2; take++) {
      const rng = new Rng(0x9001 + hz + take * 131);
      jobs.push({
        id: `enemyfire_${faction}_${take}`,
        duration: 0.7,
        normalize: 0.55,
        tailFade: 0.07,
        build: (ctx, dest, t0, bank) => {
          const out = gainNode(ctx, level);
          out.connect(dest);
          const f = hz * rng.range(0.88, 1.16);
          const o = osc(ctx, wave, f);
          o.frequency.setValueAtTime(f * 3.2, t0);
          o.frequency.exponentialRampToValueAtTime(f * 0.55, t0 + decay * 1.6);
          const bp = filter(ctx, 'bandpass', f * 2.4, 2.6);
          const env = percussiveGain(ctx, t0, 0.9, 0.0003, decay);
          o.connect(bp).connect(env).connect(out);
          o.start(t0);
          o.stop(t0 + decay * 4 + 0.1);

          const nz = bank.source('white');
          const hp = filter(ctx, 'highpass', f * 3, 1);
          const nenv = percussiveGain(ctx, t0, 0.5, 0.0002, decay * 0.5);
          nz.connect(hp).connect(nenv).connect(out);
          nz.start(t0, rng.range(0, 2.5));
          nz.stop(t0 + 0.3);

          const tail = bank.source('white');
          const lp = filter(ctx, 'lowpass', 1400, 0.7);
          const tenv = percussiveGain(ctx, t0 + 0.01, 0.16, 0.006, 0.22);
          tail.connect(lp).connect(tenv).connect(out);
          tail.start(t0, rng.range(0, 2.5));
          tail.stop(t0 + 0.6);
        },
      });
    }
  }
  return jobs;
}
