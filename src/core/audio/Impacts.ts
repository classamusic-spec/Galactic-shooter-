/**
 * Impacts, explosions, footsteps and elemental stings.
 *
 * Surfaces are synthesised modally: a struck body rings at a set of inharmonic
 * partials whose frequencies encode its size and stiffness, and whose decay
 * times encode its damping. Metal is a handful of long, high-Q partials; sand
 * has effectively none and is all noise; ice sits between, bright and glassy
 * with a short crack. Getting these ratios right is why a bullet hitting rock
 * and a bullet hitting a bulkhead sound like different physical events rather
 * than the same click through two different EQs.
 */
import type { SurfaceKind } from '@/types';
import { Rng } from '@/util/math';
import {
  type BakeJob,
  type Mode,
  filter,
  gainNode,
  modalBank,
  osc,
  percussiveGain,
  saturator,
} from './Dsp';

interface SurfaceProfile {
  /** Modal partials as (ratio, amplitude, decay). */
  modes: readonly (readonly [number, number, number])[];
  /** Fundamental, Hz. */
  f0: number;
  /** Noise crunch: band, Q, decay, level. */
  noiseHz: number;
  noiseQ: number;
  noiseDecay: number;
  noiseLevel: number;
  /** Low body thud. */
  thudHz: number;
  thudDecay: number;
  thudLevel: number;
  /** Debris scatter after the hit. */
  debris: number;
  seconds: number;
}

const SURFACES: Record<SurfaceKind, SurfaceProfile> = {
  rock: {
    f0: 430,
    modes: [
      [1, 0.5, 0.06],
      [1.94, 0.3, 0.045],
      [3.31, 0.18, 0.03],
      [5.02, 0.09, 0.02],
    ],
    noiseHz: 1700,
    noiseQ: 0.8,
    noiseDecay: 0.07,
    noiseLevel: 0.85,
    thudHz: 105,
    thudDecay: 0.09,
    thudLevel: 0.5,
    debris: 0.6,
    seconds: 0.5,
  },
  concrete: {
    f0: 380,
    modes: [
      [1, 0.42, 0.05],
      [2.13, 0.24, 0.035],
      [3.72, 0.13, 0.024],
    ],
    noiseHz: 1450,
    noiseQ: 0.7,
    noiseDecay: 0.075,
    noiseLevel: 0.9,
    thudHz: 92,
    thudDecay: 0.1,
    thudLevel: 0.55,
    debris: 0.75,
    seconds: 0.5,
  },
  sand: {
    f0: 260,
    modes: [[1, 0.1, 0.02]],
    noiseHz: 900,
    noiseQ: 0.5,
    noiseDecay: 0.13,
    noiseLevel: 1,
    thudHz: 72,
    thudDecay: 0.08,
    thudLevel: 0.32,
    debris: 0.35,
    seconds: 0.42,
  },
  ice: {
    f0: 1250,
    modes: [
      [1, 0.55, 0.16],
      [2.41, 0.4, 0.12],
      [4.13, 0.26, 0.08],
      [6.7, 0.14, 0.05],
      [9.2, 0.07, 0.03],
    ],
    noiseHz: 5200,
    noiseQ: 1.4,
    noiseDecay: 0.035,
    noiseLevel: 0.7,
    thudHz: 140,
    thudDecay: 0.05,
    thudLevel: 0.25,
    debris: 0.9,
    seconds: 0.62,
  },
  metal: {
    f0: 720,
    modes: [
      [1, 0.6, 0.42],
      [2.76, 0.38, 0.33],
      [5.4, 0.24, 0.22],
      [8.93, 0.13, 0.15],
      [13.1, 0.06, 0.09],
    ],
    noiseHz: 3600,
    noiseQ: 1.1,
    noiseDecay: 0.02,
    noiseLevel: 0.6,
    thudHz: 128,
    thudDecay: 0.07,
    thudLevel: 0.4,
    debris: 0.2,
    seconds: 0.95,
  },
  glass: {
    f0: 2100,
    modes: [
      [1, 0.5, 0.24],
      [2.19, 0.36, 0.17],
      [3.61, 0.24, 0.12],
      [5.9, 0.14, 0.07],
    ],
    noiseHz: 6800,
    noiseQ: 1.2,
    noiseDecay: 0.05,
    noiseLevel: 0.85,
    thudHz: 190,
    thudDecay: 0.03,
    thudLevel: 0.18,
    debris: 1,
    seconds: 0.7,
  },
  organic: {
    f0: 300,
    modes: [
      [1, 0.3, 0.05],
      [1.61, 0.16, 0.035],
    ],
    noiseHz: 1100,
    noiseQ: 0.9,
    noiseDecay: 0.06,
    noiseLevel: 0.75,
    thudHz: 88,
    thudDecay: 0.1,
    thudLevel: 0.5,
    debris: 0.3,
    seconds: 0.45,
  },
  chitin: {
    f0: 860,
    modes: [
      [1, 0.45, 0.09],
      [2.32, 0.26, 0.06],
      [4.07, 0.14, 0.04],
    ],
    noiseHz: 2900,
    noiseQ: 1.3,
    noiseDecay: 0.03,
    noiseLevel: 0.7,
    thudHz: 130,
    thudDecay: 0.055,
    thudLevel: 0.35,
    debris: 0.5,
    seconds: 0.5,
  },
  flesh: {
    f0: 190,
    modes: [
      [1, 0.22, 0.04],
      [1.42, 0.11, 0.028],
    ],
    noiseHz: 620,
    noiseQ: 0.6,
    noiseDecay: 0.05,
    noiseLevel: 0.8,
    thudHz: 66,
    thudDecay: 0.11,
    thudLevel: 0.7,
    debris: 0.15,
    seconds: 0.42,
  },
  water: {
    f0: 540,
    modes: [
      [1, 0.18, 0.05, ],
      [1.59, 0.1, 0.035],
    ],
    noiseHz: 2400,
    noiseQ: 0.5,
    noiseDecay: 0.16,
    noiseLevel: 0.9,
    thudHz: 110,
    thudDecay: 0.07,
    thudLevel: 0.3,
    debris: 0.2,
    seconds: 0.55,
  },
  foliage: {
    f0: 1500,
    modes: [[1, 0.08, 0.02]],
    noiseHz: 3800,
    noiseQ: 0.45,
    noiseDecay: 0.11,
    noiseLevel: 0.75,
    thudHz: 150,
    thudDecay: 0.04,
    thudLevel: 0.12,
    debris: 0.8,
    seconds: 0.42,
  },
  energy: {
    f0: 980,
    modes: [
      [1, 0.4, 0.11],
      [2, 0.26, 0.08],
      [3.02, 0.16, 0.06],
      [4.01, 0.09, 0.04],
    ],
    noiseHz: 4600,
    noiseQ: 2.2,
    noiseDecay: 0.04,
    noiseLevel: 0.45,
    thudHz: 118,
    thudDecay: 0.05,
    thudLevel: 0.22,
    debris: 0,
    seconds: 0.5,
  },
};

export const SURFACE_KINDS = Object.keys(SURFACES) as SurfaceKind[];
export const IMPACT_TAKES = 3;

function buildImpact(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  t0: number,
  bank: import('./Dsp').NoiseBank,
  s: SurfaceProfile,
  rng: Rng,
  scale: number,
): void {
  const out = gainNode(ctx, 1);
  out.connect(dest);

  const f0 = s.f0 * scale * rng.range(0.9, 1.12);
  const modes: Mode[] = s.modes.map(([ratio, amp, dec]) => ({
    f: f0 * ratio * rng.range(0.985, 1.015),
    a: amp * rng.range(0.85, 1.15),
    decay: dec * rng.range(0.82, 1.2),
    bend: 1.04,
  }));
  modalBank(ctx, out, t0, modes, 1);

  // Contact crunch.
  {
    const nz = bank.source('white');
    const bp = filter(ctx, 'bandpass', s.noiseHz * rng.range(0.85, 1.2), s.noiseQ);
    bp.frequency.setValueAtTime(s.noiseHz * 1.8, t0);
    bp.frequency.exponentialRampToValueAtTime(s.noiseHz * 0.6, t0 + s.noiseDecay * 1.5);
    const env = percussiveGain(ctx, t0, s.noiseLevel, 0.0002, s.noiseDecay * rng.range(0.85, 1.2));
    nz.connect(bp).connect(env).connect(out);
    nz.start(t0, rng.range(0, 2.5));
    nz.stop(t0 + s.noiseDecay * 4 + 0.05);
  }

  // Body thud.
  {
    const o = osc(ctx, 'sine', s.thudHz);
    o.frequency.setValueAtTime(s.thudHz * 1.7, t0);
    o.frequency.exponentialRampToValueAtTime(s.thudHz * 0.75, t0 + s.thudDecay);
    const env = percussiveGain(ctx, t0, s.thudLevel, 0.0006, s.thudDecay);
    const sat = saturator(ctx, 1.6);
    o.connect(sat).connect(env).connect(out);
    o.start(t0);
    o.stop(t0 + s.thudDecay * 2.5 + 0.05);
  }

  // Debris scatter: a handful of tiny delayed ticks.
  if (s.debris > 0.01) {
    const count = Math.round(3 + s.debris * 7);
    for (let i = 0; i < count; i++) {
      const at = t0 + rng.range(0.02, 0.22);
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', s.noiseHz * rng.range(0.7, 2.2), 3);
      const env = percussiveGain(ctx, at, s.debris * rng.range(0.05, 0.18), 0.0002, 0.012);
      nz.connect(bp).connect(env).connect(out);
      nz.start(at, rng.range(0, 2.5));
      nz.stop(at + 0.06);
    }
  }
}

export function impactJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];
  let seed = 0xa731;
  for (const kind of SURFACE_KINDS) {
    const s = SURFACES[kind];
    for (let take = 0; take < IMPACT_TAKES; take++) {
      const rng = new Rng((seed = (seed * 1103515245 + 12345) >>> 0));
      jobs.push({
        id: `impact_${kind}_${take}`,
        duration: s.seconds,
        normalize: 0.62,
        tailFade: 0.04,
        build: (ctx, dest, t0, bank) => buildImpact(ctx, dest, t0, bank, s, rng, 1),
      });
    }
    // Footsteps: the same surface model struck softly by something big and soft.
    for (let take = 0; take < 2; take++) {
      const rng = new Rng((seed = (seed * 1103515245 + 12345) >>> 0));
      jobs.push({
        id: `step_${kind}_${take}`,
        duration: 0.34,
        normalize: 0.34,
        tailFade: 0.05,
        build: (ctx, dest, t0, bank) => {
          const soft: SurfaceProfile = {
            ...s,
            noiseHz: s.noiseHz * 0.45,
            noiseDecay: s.noiseDecay * 1.4,
            noiseLevel: s.noiseLevel * 0.7,
            thudHz: s.thudHz * 0.8,
            thudLevel: s.thudLevel * 1.35,
            thudDecay: s.thudDecay * 1.3,
            debris: s.debris * 0.35,
            modes: s.modes.map(([r, a, d]) => [r, a * 0.28, d * 0.7] as const),
          };
          buildImpact(ctx, dest, t0, bank, soft, rng, 0.55);
        },
      });
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Explosions and elemental signatures
// ---------------------------------------------------------------------------

export function explosionJobs(): BakeJob[] {
  const sizes: Array<[string, number, number]> = [
    ['small', 0.55, 1.5],
    ['medium', 1, 2.4],
    ['large', 1.7, 3.4],
  ];
  const jobs: BakeJob[] = [];
  for (const [name, scale, seconds] of sizes) {
    for (let take = 0; take < 2; take++) {
      const rng = new Rng(0x3311 + take * 7919 + Math.round(scale * 1000));
      jobs.push({
        id: `explosion_${name}_${take}`,
        duration: seconds,
        normalize: 0.85,
        tailFade: 0.25,
        build: (ctx, dest, t0, bank) => {
          const out = gainNode(ctx, 1);
          out.connect(dest);

          // Crack: the shock front.
          const crack = bank.source('white');
          const chp = filter(ctx, 'highpass', 1800 / scale, 0.8);
          const cenv = percussiveGain(ctx, t0, 0.75, 0.0002, 0.02 * scale);
          crack.connect(chp).connect(cenv).connect(out);
          crack.start(t0, rng.range(0, 2.5));
          crack.stop(t0 + 0.2);

          // Body: broadband roar with a falling filter.
          const body = bank.source('brown');
          const lp = filter(ctx, 'lowpass', 3000 / scale, 0.8);
          lp.frequency.setValueAtTime(4200 / scale, t0);
          lp.frequency.exponentialRampToValueAtTime(180, t0 + 0.9 * scale);
          const benv = percussiveGain(ctx, t0, 1, 0.0018, 0.55 * scale);
          const sat = saturator(ctx, 3);
          body.connect(lp).connect(sat).connect(benv).connect(out);
          body.start(t0, rng.range(0, 2.5));
          body.stop(t0 + seconds);

          // Sub boom.
          const sub = osc(ctx, 'sine', 90 / scale);
          sub.frequency.setValueAtTime(120 / scale, t0);
          sub.frequency.exponentialRampToValueAtTime(26, t0 + 0.5 * scale);
          const senv = percussiveGain(ctx, t0, 0.95, 0.002, 0.42 * scale);
          sub.connect(senv).connect(out);
          sub.start(t0);
          sub.stop(t0 + seconds);

          // Debris rain.
          const count = Math.round(14 * scale);
          for (let i = 0; i < count; i++) {
            const at = t0 + rng.range(0.08, 0.7 * scale);
            const nz = bank.source('white');
            const bp = filter(ctx, 'bandpass', rng.range(500, 4200), 4);
            const env = percussiveGain(ctx, at, rng.range(0.03, 0.13), 0.0003, 0.03);
            nz.connect(bp).connect(env).connect(out);
            nz.start(at, rng.range(0, 2.5));
            nz.stop(at + 0.12);
          }

          // Rumble tail.
          const tail = bank.source('brown');
          const tlp = filter(ctx, 'lowpass', 420, 0.6);
          const tenv = percussiveGain(ctx, t0 + 0.05, 0.4, 0.09, seconds * 0.6);
          tail.connect(tlp).connect(tenv).connect(out);
          tail.start(t0, rng.range(0, 2.5));
          tail.stop(t0 + seconds);
        },
      });
    }
  }
  return jobs;
}

/** Elemental stings: burn ignition, arc zap, void implosion, stasis shatter. */
export function elementalJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];

  jobs.push({
    id: 'elem_solar_ignite',
    duration: 1.6,
    normalize: 0.8,
    tailFade: 0.2,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 900, 0.8);
      bp.frequency.setValueAtTime(3200, t0);
      bp.frequency.exponentialRampToValueAtTime(240, t0 + 1.1);
      const env = percussiveGain(ctx, t0, 0.9, 0.004, 0.85);
      nz.connect(bp).connect(env).connect(out);
      nz.start(t0, 0.4);
      nz.stop(t0 + 1.6);
      const o = osc(ctx, 'sine', 150);
      o.frequency.setValueAtTime(210, t0);
      o.frequency.exponentialRampToValueAtTime(48, t0 + 0.6);
      const oe = percussiveGain(ctx, t0, 0.8, 0.003, 0.5);
      o.connect(oe).connect(out);
      o.start(t0);
      o.stop(t0 + 1.2);
    },
  });

  jobs.push({
    id: 'elem_arc_zap',
    duration: 0.85,
    normalize: 0.75,
    tailFade: 0.1,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const rng = new Rng(0x7d3);
      // Sputtering discharge: many very short bright bursts.
      for (let i = 0; i < 22; i++) {
        const at = t0 + Math.pow(rng.next(), 1.7) * 0.45;
        const nz = bank.source('white');
        const hp = filter(ctx, 'highpass', rng.range(1800, 6000), 1.4);
        const env = percussiveGain(ctx, at, rng.range(0.2, 0.85), 0.00015, rng.range(0.004, 0.03));
        nz.connect(hp).connect(env).connect(out);
        nz.start(at, rng.range(0, 2.5));
        nz.stop(at + 0.09);
      }
      // 50 Hz-ish electrical hum under it.
      const o = osc(ctx, 'square', 118);
      const bp = filter(ctx, 'bandpass', 1400, 6);
      const oe = percussiveGain(ctx, t0, 0.35, 0.002, 0.4);
      o.connect(bp).connect(oe).connect(out);
      o.start(t0);
      o.stop(t0 + 0.8);
    },
  });

  jobs.push({
    id: 'elem_void_pull',
    duration: 1.8,
    normalize: 0.8,
    tailFade: 0.25,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      // Inverted envelope: an implosion swells and then snaps shut.
      const nz = bank.source('brown');
      const bp = filter(ctx, 'bandpass', 300, 1.4);
      bp.frequency.setValueAtTime(120, t0);
      bp.frequency.exponentialRampToValueAtTime(1900, t0 + 0.75);
      bp.frequency.exponentialRampToValueAtTime(90, t0 + 1.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1e-4, t0);
      g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.72);
      g.gain.exponentialRampToValueAtTime(1e-4, t0 + 1.25);
      nz.connect(bp).connect(g).connect(out);
      nz.start(t0, 0.9);
      nz.stop(t0 + 1.8);
      // The collapse.
      const o = osc(ctx, 'sine', 260);
      o.frequency.setValueAtTime(260, t0 + 0.7);
      o.frequency.exponentialRampToValueAtTime(24, t0 + 1.15);
      const oe = percussiveGain(ctx, t0 + 0.7, 0.9, 0.01, 0.55);
      o.connect(oe).connect(out);
      o.start(t0 + 0.7);
      o.stop(t0 + 1.6);
    },
  });

  jobs.push({
    id: 'elem_stasis_shatter',
    duration: 1.3,
    normalize: 0.78,
    tailFade: 0.15,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const rng = new Rng(0x51ce);
      modalBank(
        ctx,
        out,
        t0,
        [
          { f: 2400, a: 0.5, decay: 0.35 },
          { f: 3910, a: 0.36, decay: 0.28 },
          { f: 5720, a: 0.22, decay: 0.2 },
          { f: 7830, a: 0.12, decay: 0.14 },
        ],
        1,
      );
      for (let i = 0; i < 26; i++) {
        const at = t0 + Math.pow(rng.next(), 1.4) * 0.7;
        const nz = bank.source('white');
        const bp = filter(ctx, 'bandpass', rng.range(2500, 9000), 6);
        const env = percussiveGain(ctx, at, rng.range(0.06, 0.3), 0.0002, rng.range(0.02, 0.09));
        nz.connect(bp).connect(env).connect(out);
        nz.start(at, rng.range(0, 2.5));
        nz.stop(at + 0.2);
      }
      const o = osc(ctx, 'sine', 130);
      const oe = percussiveGain(ctx, t0, 0.5, 0.002, 0.22);
      o.connect(oe).connect(out);
      o.start(t0);
      o.stop(t0 + 0.6);
    },
  });

  jobs.push({
    id: 'shield_break',
    duration: 1.1,
    normalize: 0.72,
    tailFade: 0.12,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 2600, 1.1);
      bp.frequency.setValueAtTime(5200, t0);
      bp.frequency.exponentialRampToValueAtTime(600, t0 + 0.5);
      const env = percussiveGain(ctx, t0, 0.85, 0.0004, 0.35);
      nz.connect(bp).connect(env).connect(out);
      nz.start(t0, 1.1);
      nz.stop(t0 + 1.1);
      modalBank(
        ctx,
        out,
        t0,
        [
          { f: 1180, a: 0.4, decay: 0.5, bend: 1.6 },
          { f: 1770, a: 0.25, decay: 0.36, bend: 1.5 },
          { f: 2960, a: 0.14, decay: 0.24, bend: 1.4 },
        ],
        1,
      );
    },
  });

  return jobs;
}
