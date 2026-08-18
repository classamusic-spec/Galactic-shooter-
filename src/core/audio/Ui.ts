/**
 * Interface, feedback and ability stings.
 *
 * These are the sounds with the tightest latency requirement in the game: a
 * hitmarker that arrives 80 ms late reads as a different hit. All of them are
 * therefore short, front-loaded and mixed on the UI bus, which sits outside the
 * spatialiser and the reverb send entirely.
 */
import { Rng } from '@/util/math';
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

/** A short, clean bell — the backbone of the UI palette. */
function bell(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  t0: number,
  f: number,
  level: number,
  decay: number,
  bright = 1,
): void {
  modalBank(
    ctx,
    dest,
    t0,
    [
      { f, a: level, decay },
      { f: f * 2.01, a: level * 0.45 * bright, decay: decay * 0.62 },
      { f: f * 3.02, a: level * 0.2 * bright, decay: decay * 0.4 },
      { f: f * 4.98, a: level * 0.08 * bright, decay: decay * 0.25 },
    ],
    1,
  );
}

export function uiJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];

  // -- combat feedback -----------------------------------------------------

  jobs.push({
    id: 'hitmarker',
    duration: 0.16,
    normalize: 0.5,
    tailFade: 0.03,
    build: (ctx, dest, t0, bank) => {
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 3400, 3.2);
      const env = percussiveGain(ctx, t0, 0.8, 0.0002, 0.028);
      nz.connect(bp).connect(env).connect(dest);
      nz.start(t0, 0.2);
      nz.stop(t0 + 0.1);
      bell(ctx, dest, t0, 2400, 0.35, 0.07);
    },
  });

  jobs.push({
    id: 'hitmarker_crit',
    duration: 0.24,
    normalize: 0.58,
    tailFade: 0.04,
    build: (ctx, dest, t0, bank) => {
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 4600, 4);
      const env = percussiveGain(ctx, t0, 0.9, 0.00018, 0.03);
      nz.connect(bp).connect(env).connect(dest);
      nz.start(t0, 0.6);
      nz.stop(t0 + 0.1);
      bell(ctx, dest, t0, 3200, 0.4, 0.11);
      bell(ctx, dest, t0 + 0.035, 3200 * semis(7), 0.3, 0.09);
    },
  });

  jobs.push({
    id: 'hitmarker_kill',
    duration: 0.55,
    normalize: 0.7,
    tailFade: 0.08,
    build: (ctx, dest, t0, bank) => {
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 2600, 2);
      const env = percussiveGain(ctx, t0, 0.9, 0.0002, 0.05);
      nz.connect(bp).connect(env).connect(dest);
      nz.start(t0, 1.4);
      nz.stop(t0 + 0.2);
      // A descending third: the universal "that one is finished" cadence.
      bell(ctx, dest, t0, 1760, 0.45, 0.2);
      bell(ctx, dest, t0 + 0.05, 1760 * semis(-4), 0.4, 0.3);
      const o = osc(ctx, 'sine', 220);
      o.frequency.setValueAtTime(300, t0);
      o.frequency.exponentialRampToValueAtTime(110, t0 + 0.18);
      const oe = percussiveGain(ctx, t0, 0.5, 0.001, 0.16);
      o.connect(oe).connect(dest);
      o.start(t0);
      o.stop(t0 + 0.4);
    },
  });

  jobs.push({
    id: 'shield_break_player',
    duration: 0.9,
    normalize: 0.72,
    tailFade: 0.12,
    build: (ctx, dest, t0, bank) => {
      const nz = bank.source('white');
      const hp = filter(ctx, 'highpass', 900, 0.8);
      const env = percussiveGain(ctx, t0, 0.9, 0.0004, 0.32);
      nz.connect(hp).connect(env).connect(dest);
      nz.start(t0, 1.9);
      nz.stop(t0 + 0.8);
      const o = osc(ctx, 'sawtooth', 420);
      o.frequency.setValueAtTime(420, t0);
      o.frequency.exponentialRampToValueAtTime(90, t0 + 0.35);
      const bp = filter(ctx, 'bandpass', 900, 3);
      const oe = percussiveGain(ctx, t0, 0.7, 0.0008, 0.3);
      o.connect(bp).connect(oe).connect(dest);
      o.start(t0);
      o.stop(t0 + 0.7);
    },
  });

  jobs.push({
    id: 'player_hurt',
    duration: 0.5,
    normalize: 0.6,
    tailFade: 0.08,
    build: (ctx, dest, t0, bank) => {
      const o = osc(ctx, 'sine', 130);
      o.frequency.setValueAtTime(180, t0);
      o.frequency.exponentialRampToValueAtTime(62, t0 + 0.2);
      const sat = saturator(ctx, 3);
      const env = percussiveGain(ctx, t0, 0.9, 0.0008, 0.2);
      o.connect(sat).connect(env).connect(dest);
      o.start(t0);
      o.stop(t0 + 0.45);
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 1500, 1.1);
      const nenv = percussiveGain(ctx, t0, 0.35, 0.0004, 0.09);
      nz.connect(bp).connect(nenv).connect(dest);
      nz.start(t0, 2.2);
      nz.stop(t0 + 0.3);
    },
  });

  jobs.push({
    id: 'player_death',
    duration: 2.4,
    normalize: 0.8,
    tailFade: 0.4,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      // Everything falls: pitch, filter, level.
      for (const [f, lvl] of [
        [220, 0.5],
        [147, 0.4],
        [110, 0.35],
      ] as const) {
        const o = osc(ctx, 'sawtooth', f);
        o.frequency.setValueAtTime(f, t0);
        o.frequency.exponentialRampToValueAtTime(f * 0.42, t0 + 1.8);
        const lp = filter(ctx, 'lowpass', 2200, 1.2);
        lp.frequency.setValueAtTime(2600, t0);
        lp.frequency.exponentialRampToValueAtTime(160, t0 + 1.7);
        const env = percussiveGain(ctx, t0, lvl, 0.006, 1.7);
        o.connect(lp).connect(env).connect(out);
        o.start(t0);
        o.stop(t0 + 2.2);
      }
      const nz = bank.source('brown');
      const lp = filter(ctx, 'lowpass', 500, 0.7);
      const env = percussiveGain(ctx, t0, 0.5, 0.004, 1.2);
      nz.connect(lp).connect(env).connect(out);
      nz.start(t0, 0.4);
      nz.stop(t0 + 2.3);
    },
  });

  // -- pickups -------------------------------------------------------------

  const pickups: Array<[string, number, number, number]> = [
    ['loot_ammo', 780, 0.3, 0.1],
    ['loot_heavy', 520, 0.42, 0.2],
    ['loot_orb', 1240, 0.36, 0.34],
    ['loot_engram', 660, 0.5, 0.6],
    ['loot_health', 980, 0.34, 0.26],
  ];
  for (const [id, f, level, decay] of pickups) {
    jobs.push({
      id,
      duration: decay * 2 + 0.35,
      normalize: 0.55,
      tailFade: 0.08,
      build: (ctx, dest, t0) => {
        bell(ctx, dest, t0, f, level, decay);
        bell(ctx, dest, t0 + 0.045, f * semis(7), level * 0.7, decay * 0.8);
        if (decay > 0.3) bell(ctx, dest, t0 + 0.1, f * semis(12), level * 0.5, decay * 0.9);
        const o = osc(ctx, 'sine', f * 0.5);
        const env = percussiveGain(ctx, t0, level * 0.4, 0.004, decay * 0.6);
        o.connect(env).connect(dest);
        o.start(t0);
        o.stop(t0 + decay * 2);
      },
    });
  }

  // -- abilities -----------------------------------------------------------

  jobs.push({
    id: 'grenade_throw',
    duration: 0.4,
    normalize: 0.5,
    tailFade: 0.06,
    build: (ctx, dest, t0, bank) => {
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 1200, 1.4);
      bp.frequency.setValueAtTime(600, t0);
      bp.frequency.exponentialRampToValueAtTime(3000, t0 + 0.16);
      const env = percussiveGain(ctx, t0, 0.7, 0.004, 0.14);
      nz.connect(bp).connect(env).connect(dest);
      nz.start(t0, 0.8);
      nz.stop(t0 + 0.35);
      modalBank(ctx, dest, t0, [{ f: 2400, a: 0.25, decay: 0.04 }], 1);
    },
  });

  jobs.push({
    id: 'grenade_bounce',
    duration: 0.3,
    normalize: 0.4,
    tailFade: 0.05,
    build: (ctx, dest, t0) => {
      modalBank(
        ctx,
        dest,
        t0,
        [
          { f: 620, a: 0.55, decay: 0.14, bend: 1.25 },
          { f: 1490, a: 0.3, decay: 0.09 },
          { f: 2810, a: 0.14, decay: 0.05 },
        ],
        1,
      );
    },
  });

  jobs.push({
    id: 'melee_swing',
    duration: 0.35,
    normalize: 0.42,
    tailFade: 0.06,
    build: (ctx, dest, t0, bank) => {
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 900, 1.1);
      bp.frequency.setValueAtTime(400, t0);
      bp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.1);
      bp.frequency.exponentialRampToValueAtTime(500, t0 + 0.22);
      const env = percussiveGain(ctx, t0, 0.7, 0.012, 0.16);
      nz.connect(bp).connect(env).connect(dest);
      nz.start(t0, 1.6);
      nz.stop(t0 + 0.32);
    },
  });

  jobs.push({
    id: 'melee_hit',
    duration: 0.6,
    normalize: 0.75,
    tailFade: 0.08,
    build: (ctx, dest, t0, bank) => {
      const o = osc(ctx, 'sine', 120);
      o.frequency.setValueAtTime(240, t0);
      o.frequency.exponentialRampToValueAtTime(52, t0 + 0.14);
      const sat = saturator(ctx, 4);
      const env = percussiveGain(ctx, t0, 1, 0.0005, 0.16);
      o.connect(sat).connect(env).connect(dest);
      o.start(t0);
      o.stop(t0 + 0.5);
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 1900, 0.9);
      const nenv = percussiveGain(ctx, t0, 0.7, 0.0002, 0.06);
      nz.connect(bp).connect(nenv).connect(dest);
      nz.start(t0, 2.4);
      nz.stop(t0 + 0.3);
      modalBank(
        ctx,
        dest,
        t0,
        [
          { f: 340, a: 0.4, decay: 0.12 },
          { f: 810, a: 0.2, decay: 0.07 },
        ],
        1,
      );
    },
  });

  jobs.push({
    id: 'ability_ready',
    duration: 0.7,
    normalize: 0.45,
    tailFade: 0.1,
    build: (ctx, dest, t0) => {
      bell(ctx, dest, t0, 880, 0.4, 0.28);
      bell(ctx, dest, t0 + 0.07, 880 * semis(5), 0.35, 0.34);
    },
  });

  jobs.push({
    id: 'super_ready',
    duration: 2.2,
    normalize: 0.75,
    tailFade: 0.3,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      // Rising choral swell into a struck bell.
      for (const s of [0, 3, 7, 12]) {
        const f = 220 * semis(s);
        const o = osc(ctx, 'sawtooth', f);
        const lp = filter(ctx, 'lowpass', 900, 1.4);
        lp.frequency.setValueAtTime(400, t0);
        lp.frequency.exponentialRampToValueAtTime(3800, t0 + 1.1);
        const g = ctx.createGain();
        g.gain.setValueAtTime(1e-4, t0);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + 1.05);
        g.gain.exponentialRampToValueAtTime(1e-4, t0 + 2);
        o.connect(lp).connect(g).connect(out);
        o.start(t0);
        o.stop(t0 + 2.1);
      }
      bell(ctx, out, t0 + 1.05, 1320, 0.5, 0.9);
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 5200, 1.6);
      const env = percussiveGain(ctx, t0 + 1.05, 0.3, 0.001, 0.5);
      nz.connect(bp).connect(env).connect(out);
      nz.start(t0 + 1.05, 0.9);
      nz.stop(t0 + 2.1);
    },
  });

  jobs.push({
    id: 'super_cast',
    duration: 2.6,
    normalize: 0.9,
    tailFade: 0.3,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      // Suck-in, then detonation.
      const nz = bank.source('white');
      const bp = filter(ctx, 'bandpass', 400, 1.2);
      bp.frequency.setValueAtTime(200, t0);
      bp.frequency.exponentialRampToValueAtTime(6000, t0 + 0.55);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1e-4, t0);
      g.gain.exponentialRampToValueAtTime(0.7, t0 + 0.52);
      g.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.62);
      nz.connect(bp).connect(g).connect(out);
      nz.start(t0, 0.2);
      nz.stop(t0 + 0.8);

      const boom = bank.source('brown');
      const lp = filter(ctx, 'lowpass', 3200, 0.8);
      lp.frequency.setValueAtTime(5200, t0 + 0.55);
      lp.frequency.exponentialRampToValueAtTime(180, t0 + 1.8);
      const benv = percussiveGain(ctx, t0 + 0.55, 1, 0.002, 1.3);
      boom.connect(lp).connect(benv).connect(out);
      boom.start(t0 + 0.55, 1.1);
      boom.stop(t0 + 2.5);

      const sub = osc(ctx, 'sine', 70);
      sub.frequency.setValueAtTime(110, t0 + 0.55);
      sub.frequency.exponentialRampToValueAtTime(28, t0 + 1.5);
      const senv = percussiveGain(ctx, t0 + 0.55, 0.95, 0.003, 1.1);
      sub.connect(senv).connect(out);
      sub.start(t0 + 0.55);
      sub.stop(t0 + 2.4);

      for (const s of [0, 7, 12, 19]) {
        bell(ctx, out, t0 + 0.55, 330 * semis(s), 0.28, 1.4, 0.7);
      }
    },
  });

  jobs.push({
    id: 'super_end',
    duration: 1.4,
    normalize: 0.5,
    tailFade: 0.2,
    build: (ctx, dest, t0) => {
      for (const s of [12, 7, 0]) {
        const f = 440 * semis(s);
        const o = osc(ctx, 'sine', f);
        o.frequency.setValueAtTime(f, t0);
        o.frequency.exponentialRampToValueAtTime(f * 0.72, t0 + 0.9);
        const env = percussiveGain(ctx, t0, 0.3, 0.01, 0.8);
        o.connect(env).connect(dest);
        o.start(t0);
        o.stop(t0 + 1.3);
      }
    },
  });

  // -- interface -----------------------------------------------------------

  jobs.push({
    id: 'ui_hover',
    duration: 0.14,
    normalize: 0.28,
    tailFade: 0.04,
    build: (ctx, dest, t0) => bell(ctx, dest, t0, 1760, 0.3, 0.05, 0.4),
  });

  jobs.push({
    id: 'ui_click',
    duration: 0.28,
    normalize: 0.42,
    tailFade: 0.05,
    build: (ctx, dest, t0) => {
      bell(ctx, dest, t0, 1320, 0.4, 0.1, 0.6);
      bell(ctx, dest, t0 + 0.028, 1980, 0.25, 0.08, 0.5);
    },
  });

  jobs.push({
    id: 'ui_back',
    duration: 0.28,
    normalize: 0.4,
    tailFade: 0.05,
    build: (ctx, dest, t0) => {
      bell(ctx, dest, t0, 990, 0.38, 0.1, 0.5);
      bell(ctx, dest, t0 + 0.03, 660, 0.28, 0.12, 0.5);
    },
  });

  jobs.push({
    id: 'ui_error',
    duration: 0.35,
    normalize: 0.4,
    tailFade: 0.06,
    build: (ctx, dest, t0) => {
      const o = osc(ctx, 'square', 180);
      const bp = filter(ctx, 'bandpass', 600, 4);
      const env = percussiveGain(ctx, t0, 0.5, 0.002, 0.12);
      o.connect(bp).connect(env).connect(dest);
      o.start(t0);
      o.stop(t0 + 0.3);
    },
  });

  jobs.push({
    id: 'ui_toast',
    duration: 0.9,
    normalize: 0.45,
    tailFade: 0.12,
    build: (ctx, dest, t0) => {
      bell(ctx, dest, t0, 587, 0.35, 0.4, 0.8);
      bell(ctx, dest, t0 + 0.09, 880, 0.28, 0.45, 0.8);
    },
  });

  jobs.push({
    id: 'objective',
    duration: 1.6,
    normalize: 0.55,
    tailFade: 0.2,
    build: (ctx, dest, t0) => {
      for (let i = 0; i < 3; i++) {
        bell(ctx, dest, t0 + i * 0.13, 440 * semis([0, 7, 12][i]), 0.34, 0.85, 0.9);
      }
    },
  });

  jobs.push({
    id: 'ship_travel',
    duration: 3.2,
    normalize: 0.8,
    tailFade: 0.35,
    build: (ctx, dest, t0, bank) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      const rng = new Rng(0x77aa);
      for (let i = 0; i < 4; i++) {
        const f = 60 * (i + 1) * rng.range(0.95, 1.05);
        const o = osc(ctx, 'sawtooth', f);
        o.frequency.setValueAtTime(f, t0);
        o.frequency.exponentialRampToValueAtTime(f * 7, t0 + 2.2);
        const bp = filter(ctx, 'bandpass', f * 3, 3);
        bp.frequency.setValueAtTime(f * 2, t0);
        bp.frequency.exponentialRampToValueAtTime(f * 14, t0 + 2.2);
        const g = ctx.createGain();
        g.gain.setValueAtTime(1e-4, t0);
        g.gain.exponentialRampToValueAtTime(0.3 / (i + 1), t0 + 1.9);
        g.gain.exponentialRampToValueAtTime(1e-4, t0 + 3);
        o.connect(bp).connect(g).connect(out);
        o.start(t0);
        o.stop(t0 + 3.1);
      }
      const nz = bank.source('white');
      const hp = filter(ctx, 'highpass', 400, 0.8);
      hp.frequency.setValueAtTime(300, t0);
      hp.frequency.exponentialRampToValueAtTime(7000, t0 + 2.4);
      const env = percussiveGain(ctx, t0, 0.5, 1.9, 0.8);
      nz.connect(hp).connect(env).connect(out);
      nz.start(t0, 0.3);
      nz.stop(t0 + 3.1);
    },
  });

  return jobs;
}
