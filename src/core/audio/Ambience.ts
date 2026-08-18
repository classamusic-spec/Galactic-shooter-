/**
 * Ambience beds — one per world, plus orbit.
 *
 * Each bed is a 12-second stereo loop built from four strata: a wind or
 * atmosphere layer (noise through a slowly modulated band), a tonal drone that
 * carries the world's key, a mid "texture" layer with the world's signature
 * material (creaking ice, blowing grit, insect stridulation), and sparse
 * one-off events scattered across the loop so the ear never locks onto the
 * period.
 *
 * Seamlessness is not left to luck: every bed is rendered two seconds longer
 * than its loop and then folded back on itself with an equal-power crossfade
 * (see `makeSeamless`), which guarantees continuity in both value and slope at
 * the loop point regardless of what the modulators happened to be doing.
 */
import type { PlanetId } from '@/types';
import { Rng } from '@/util/math';
import {
  type BakeJob,
  type NoiseBank,
  filter,
  gainNode,
  modalBank,
  osc,
  percussiveGain,
} from './Dsp';

export type AmbienceId = PlanetId | 'orbit';

export const AMBIENCE_IDS: AmbienceId[] = [
  'aurvangr',
  'zeta-reticuli',
  'khepri',
  'hive-prime',
  'draco-ix',
  'orbit',
];

/** Loop length and the overhang folded back over the head. */
export const AMB_LOOP = 12;
export const AMB_XFADE = 2;
/** Ambience is low-bandwidth material; 24 kHz halves the memory for no loss. */
export const AMB_RATE = 24000;

interface AmbienceProfile {
  /** Wind band centre and width. */
  windHz: number;
  windQ: number;
  windLevel: number;
  /** Cutoff sweep depth (multiplier) and rate (Hz). */
  gustDepth: number;
  gustHz: number;
  /** Tonal drone root and its partials. */
  droneHz: number;
  dronePartials: readonly number[];
  droneLevel: number;
  /** Signature texture: 'creak' | 'grit' | 'chorus' | 'stridulate' | 'ember' | 'hull'. */
  texture: 'creak' | 'grit' | 'chorus' | 'stridulate' | 'ember' | 'hull';
  textureLevel: number;
  /** Sparse events per loop. */
  events: number;
  eventHz: number;
  eventDecay: number;
  eventLevel: number;
  /** Stereo width, 0..1. */
  width: number;
}

const PROFILES: Record<AmbienceId, AmbienceProfile> = {
  // Tide-locked ice: a constant high, thin wind and the groan of moving ice.
  aurvangr: {
    windHz: 900,
    windQ: 0.55,
    windLevel: 0.36,
    gustDepth: 2.6,
    gustHz: 0.077,
    droneHz: 55,
    dronePartials: [1, 1.5, 2, 3],
    droneLevel: 0.16,
    texture: 'creak',
    textureLevel: 0.3,
    events: 7,
    eventHz: 240,
    eventDecay: 1.6,
    eventLevel: 0.22,
    width: 0.85,
  },
  // Ashen flats: low grit-laden wind, a dead-flat horizon, Custodian machinery
  // humming somewhere under the dunes.
  'zeta-reticuli': {
    windHz: 420,
    windQ: 0.4,
    windLevel: 0.42,
    gustDepth: 2.1,
    gustHz: 0.053,
    droneHz: 49,
    dronePartials: [1, 2, 2.99, 4.5],
    droneLevel: 0.2,
    texture: 'grit',
    textureLevel: 0.34,
    events: 4,
    eventHz: 88,
    eventDecay: 2.4,
    eventLevel: 0.18,
    width: 0.7,
  },
  // Jungle: dense canopy chorus, humid air, no wind to speak of.
  khepri: {
    windHz: 620,
    windQ: 0.8,
    windLevel: 0.2,
    gustDepth: 1.5,
    gustHz: 0.11,
    droneHz: 62,
    dronePartials: [1, 1.5, 2.5],
    droneLevel: 0.13,
    texture: 'chorus',
    textureLevel: 0.42,
    events: 14,
    eventHz: 1900,
    eventDecay: 0.4,
    eventLevel: 0.2,
    width: 0.95,
  },
  // Hive: everything is alive and none of it is friendly.
  'hive-prime': {
    windHz: 300,
    windQ: 0.5,
    windLevel: 0.24,
    gustDepth: 1.7,
    gustHz: 0.09,
    droneHz: 41,
    dronePartials: [1, 1.19, 2, 2.38],
    droneLevel: 0.26,
    texture: 'stridulate',
    textureLevel: 0.4,
    events: 10,
    eventHz: 700,
    eventDecay: 0.7,
    eventLevel: 0.22,
    width: 0.9,
  },
  // Draco IX: volcanic, close, heavy. Low roar and settling embers.
  'draco-ix': {
    windHz: 240,
    windQ: 0.45,
    windLevel: 0.4,
    gustDepth: 1.9,
    gustHz: 0.041,
    droneHz: 36,
    dronePartials: [1, 1.5, 2, 2.67],
    droneLevel: 0.3,
    texture: 'ember',
    textureLevel: 0.33,
    events: 9,
    eventHz: 150,
    eventDecay: 1.9,
    eventLevel: 0.24,
    width: 0.75,
  },
  // Orbit: no air. Hull tone, reactor hum, distant systems.
  orbit: {
    windHz: 180,
    windQ: 1.1,
    windLevel: 0.1,
    gustDepth: 1.2,
    gustHz: 0.037,
    droneHz: 58,
    dronePartials: [1, 2, 3, 4, 6],
    droneLevel: 0.34,
    texture: 'hull',
    textureLevel: 0.24,
    events: 6,
    eventHz: 1200,
    eventDecay: 0.5,
    eventLevel: 0.14,
    width: 0.6,
  },
};

function buildBed(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  t0: number,
  bank: NoiseBank,
  p: AmbienceProfile,
  rng: Rng,
  seconds: number,
): void {
  const out = gainNode(ctx, 1);
  out.connect(dest);

  // Stereo split: two decorrelated halves at opposite pans.
  const panL = ctx.createStereoPanner();
  panL.pan.value = -p.width;
  const panR = ctx.createStereoPanner();
  panR.pan.value = p.width;
  panL.connect(out);
  panR.connect(out);
  const sides = [panL, panR];

  // -- wind ---------------------------------------------------------------
  for (let s = 0; s < 2; s++) {
    const nz = bank.source(p.windHz > 500 ? 'white' : 'pink');
    const bp = filter(ctx, 'bandpass', p.windHz, p.windQ);
    const lfo = osc(ctx, 'sine', p.gustHz * (s === 0 ? 1 : 0.73));
    const lfoG = gainNode(ctx, p.windHz * (p.gustDepth - 1) * 0.5);
    lfo.connect(lfoG).connect(bp.frequency);
    lfo.start(t0);
    lfo.stop(t0 + seconds);
    // A second, slower modulator on level so gusts swell rather than just sweep.
    const amp = gainNode(ctx, p.windLevel * 0.5);
    const lfo2 = osc(ctx, 'sine', p.gustHz * (s === 0 ? 0.41 : 0.29));
    const lfo2G = gainNode(ctx, p.windLevel * 0.32);
    lfo2.connect(lfo2G).connect(amp.gain);
    lfo2.start(t0);
    lfo2.stop(t0 + seconds);
    nz.connect(bp).connect(amp).connect(sides[s]);
    nz.start(t0, rng.range(0, 2.5));
    nz.stop(t0 + seconds);
  }

  // -- drone --------------------------------------------------------------
  {
    const droneOut = gainNode(ctx, p.droneLevel);
    droneOut.connect(out);
    const lp = filter(ctx, 'lowpass', 1100, 0.8);
    lp.connect(droneOut);
    for (let i = 0; i < p.dronePartials.length; i++) {
      const mult = p.dronePartials[i];
      const f = p.droneHz * mult;
      // Two slightly detuned voices per partial: beating is what makes a drone
      // feel like a physical space rather than a test tone.
      for (let d = 0; d < 2; d++) {
        const o = osc(ctx, i === 0 ? 'sawtooth' : 'sine', f * (d === 0 ? 1 : 1.004));
        const g = gainNode(ctx, (1 / (1 + i * 1.4)) * 0.5);
        const trem = osc(ctx, 'sine', 0.031 + i * 0.017 + d * 0.009);
        const tremG = gainNode(ctx, 0.22 / (1 + i));
        trem.connect(tremG).connect(g.gain);
        trem.start(t0);
        trem.stop(t0 + seconds);
        o.connect(g).connect(lp);
        o.start(t0);
        o.stop(t0 + seconds);
      }
    }
  }

  // -- signature texture ---------------------------------------------------
  buildTexture(ctx, out, t0, bank, p, rng, seconds);

  // -- sparse events -------------------------------------------------------
  for (let i = 0; i < p.events; i++) {
    const at = t0 + rng.range(0.2, seconds - 0.5);
    const side = sides[rng.int(0, 1)];
    const hz = p.eventHz * rng.range(0.6, 1.7);
    modalBank(
      ctx,
      side,
      at,
      [
        { f: hz, a: p.eventLevel * rng.range(0.5, 1), decay: p.eventDecay * rng.range(0.6, 1.4) },
        { f: hz * rng.range(1.6, 2.4), a: p.eventLevel * 0.4, decay: p.eventDecay * 0.6 },
      ],
      1,
    );
  }
}

function buildTexture(
  ctx: OfflineAudioContext,
  out: AudioNode,
  t0: number,
  bank: NoiseBank,
  p: AmbienceProfile,
  rng: Rng,
  seconds: number,
): void {
  const lvl = p.textureLevel;
  switch (p.texture) {
    case 'creak': {
      // Ice under load: slow pitch-bending groans.
      for (let i = 0; i < 9; i++) {
        const at = t0 + rng.range(0, seconds - 1.5);
        const f = rng.range(70, 260);
        const o = osc(ctx, 'sawtooth', f);
        o.frequency.setValueAtTime(f, at);
        o.frequency.linearRampToValueAtTime(f * rng.range(1.05, 1.4), at + rng.range(0.6, 1.6));
        const bp = filter(ctx, 'bandpass', f * 3, 9);
        const env = percussiveGain(ctx, at, lvl * rng.range(0.3, 0.8), 0.25, 1.1);
        o.connect(bp).connect(env).connect(out);
        o.start(at);
        o.stop(at + 2.2);
      }
      break;
    }
    case 'grit': {
      // Sand skittering over stone: high, sparse, band-limited noise pulses.
      for (let i = 0; i < 22; i++) {
        const at = t0 + rng.range(0, seconds - 0.6);
        const nz = bank.source('white');
        const bp = filter(ctx, 'bandpass', rng.range(1800, 6500), rng.range(1.2, 4));
        const env = percussiveGain(ctx, at, lvl * rng.range(0.15, 0.5), 0.02, rng.range(0.1, 0.5));
        nz.connect(bp).connect(env).connect(out);
        nz.start(at, rng.range(0, 2.5));
        nz.stop(at + 0.9);
      }
      break;
    }
    case 'chorus': {
      // Canopy life: layered chirps at wildly different rates.
      for (let i = 0; i < 34; i++) {
        const at = t0 + rng.range(0, seconds - 0.4);
        const f = rng.range(1400, 5200);
        const o = osc(ctx, 'sine', f);
        const vib = osc(ctx, 'sine', rng.range(8, 34));
        const vibG = gainNode(ctx, f * rng.range(0.02, 0.12));
        vib.connect(vibG).connect(o.frequency);
        vib.start(at);
        vib.stop(at + 0.5);
        const env = percussiveGain(ctx, at, lvl * rng.range(0.1, 0.35), 0.008, rng.range(0.05, 0.3));
        o.connect(env).connect(out);
        o.start(at);
        o.stop(at + 0.6);
      }
      // Continuous insect wash under it.
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 4200, 2.2);
      const g = gainNode(ctx, lvl * 0.22);
      nz.connect(bp).connect(g).connect(out);
      nz.start(t0, 0.7);
      nz.stop(t0 + seconds);
      break;
    }
    case 'stridulate': {
      // Hive: amplitude-modulated buzz clusters, like a wingbeat chorus.
      for (let i = 0; i < 7; i++) {
        const at = t0 + rng.range(0, seconds - 2);
        const f = rng.range(180, 620);
        const o = osc(ctx, 'sawtooth', f);
        const am = osc(ctx, 'square', rng.range(14, 46));
        const amG = gainNode(ctx, 0.5);
        const vca = gainNode(ctx, 0.5);
        am.connect(amG).connect(vca.gain);
        am.start(at);
        am.stop(at + 2.4);
        const bp = filter(ctx, 'bandpass', f * rng.range(2, 5), 5);
        const env = percussiveGain(ctx, at, lvl * rng.range(0.25, 0.6), 0.35, 1.4);
        o.connect(vca).connect(bp).connect(env).connect(out);
        o.start(at);
        o.stop(at + 2.6);
      }
      break;
    }
    case 'ember': {
      // Fire and settling rock: crackle plus a low roar.
      const nz = bank.source('brown');
      const lp = filter(ctx, 'lowpass', 320, 0.7);
      const g = gainNode(ctx, lvl * 0.7);
      nz.connect(lp).connect(g).connect(out);
      nz.start(t0, 1.3);
      nz.stop(t0 + seconds);
      for (let i = 0; i < 46; i++) {
        const at = t0 + rng.range(0, seconds - 0.2);
        const cz = bank.source('white');
        const bp = filter(ctx, 'bandpass', rng.range(900, 5000), 6);
        const env = percussiveGain(ctx, at, lvl * rng.range(0.06, 0.28), 0.0005, rng.range(0.01, 0.06));
        cz.connect(bp).connect(env).connect(out);
        cz.start(at, rng.range(0, 2.5));
        cz.stop(at + 0.2);
      }
      break;
    }
    case 'hull': {
      // Ship: reactor hum plus periodic relays and distant structural ticks.
      const o = osc(ctx, 'square', 100);
      const bp = filter(ctx, 'bandpass', 700, 7);
      const g = gainNode(ctx, lvl * 0.28);
      o.connect(bp).connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + seconds);
      for (let i = 0; i < 18; i++) {
        const at = t0 + rng.range(0, seconds - 0.4);
        modalBank(
          ctx,
          out,
          at,
          [
            { f: rng.range(700, 3400), a: lvl * rng.range(0.05, 0.2), decay: rng.range(0.05, 0.4) },
          ],
          1,
        );
      }
      break;
    }
  }
}

export function ambienceJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];
  let seed = 0x4c1d3;
  for (const id of AMBIENCE_IDS) {
    const p = PROFILES[id];
    const rng = new Rng((seed = (seed * 69069 + 1) >>> 0));
    jobs.push({
      id: `amb_${id}`,
      duration: AMB_LOOP + AMB_XFADE,
      normalize: 0.55,
      build: (ctx, dest, t0, bank) =>
        buildBed(ctx, dest, t0, bank, p, rng, AMB_LOOP + AMB_XFADE),
    });
  }
  return jobs;
}

/** Continuous loops that are not tied to a world. */
export function loopJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];

  // The ship. Layered turbine: a low spool, a mid whine, an air rush.
  jobs.push({
    id: 'ship_engine_loop',
    duration: 6 + 1.5,
    normalize: 0.6,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const seconds = 7.5;
      for (const [f, level, wave, q] of [
        [46, 0.5, 'sawtooth', 1.2],
        [92, 0.3, 'sawtooth', 2.4],
        [231, 0.16, 'square', 6],
        [614, 0.08, 'sine', 9],
      ] as const) {
        const o = osc(ctx, wave, f);
        const bp = filter(ctx, 'lowpass', f * q, 1.1);
        const g = gainNode(ctx, level);
        const trem = osc(ctx, 'sine', 0.19 + f * 0.0007);
        const tremG = gainNode(ctx, level * 0.18);
        trem.connect(tremG).connect(g.gain);
        trem.start(t0);
        trem.stop(t0 + seconds);
        o.connect(bp).connect(g).connect(out);
        o.start(t0);
        o.stop(t0 + seconds);
      }
      const air = bank.source('pink');
      const bp = filter(ctx, 'bandpass', 1700, 0.8);
      const g = gainNode(ctx, 0.22);
      air.connect(bp).connect(g).connect(out);
      air.start(t0, 0.5);
      air.stop(t0 + seconds);
    },
  });

  // Super-active loop: a rising, unstable power hum.
  jobs.push({
    id: 'super_loop',
    duration: 4 + 1,
    normalize: 0.5,
    build: (ctx, dest, t0) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const seconds = 5;
      for (const [f, lvl] of [
        [58, 0.5],
        [87, 0.3],
        [174, 0.2],
        [349, 0.12],
      ] as const) {
        const o = osc(ctx, 'sawtooth', f);
        const bp = filter(ctx, 'bandpass', f * 3.2, 3);
        const lfo = osc(ctx, 'sine', 0.63 + f * 0.002);
        const lfoG = gainNode(ctx, f * 4);
        lfo.connect(lfoG).connect(bp.frequency);
        lfo.start(t0);
        lfo.stop(t0 + seconds);
        const g = gainNode(ctx, lvl);
        o.connect(bp).connect(g).connect(out);
        o.start(t0);
        o.stop(t0 + seconds);
      }
    },
  });

  // Burn / on-fire loop for the status effect.
  jobs.push({
    id: 'burn_loop',
    duration: 3 + 1,
    normalize: 0.42,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const seconds = 4;
      const rng = new Rng(0x8c3);
      const nz = bank.source('brown');
      const lp = filter(ctx, 'lowpass', 700, 0.7);
      const g = gainNode(ctx, 0.6);
      nz.connect(lp).connect(g).connect(out);
      nz.start(t0, 0.9);
      nz.stop(t0 + seconds);
      for (let i = 0; i < 70; i++) {
        const at = t0 + rng.range(0, seconds - 0.1);
        const cz = bank.source('white');
        const bp = filter(ctx, 'bandpass', rng.range(1200, 6000), 7);
        const env = percussiveGain(ctx, at, rng.range(0.06, 0.3), 0.0004, rng.range(0.008, 0.05));
        cz.connect(bp).connect(env).connect(out);
        cz.start(at, rng.range(0, 2.5));
        cz.stop(at + 0.15);
      }
    },
  });

  return jobs;
}

export const LOOP_XFADE: Record<string, number> = {
  ship_engine_loop: 1.5,
  super_loop: 1,
  burn_loop: 1,
};
