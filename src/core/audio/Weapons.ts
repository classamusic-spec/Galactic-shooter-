/**
 * Gunfire synthesis.
 *
 * A gunshot is not one sound, it is five events that happen within 400 ms and
 * whose balance is the entire character of the weapon:
 *
 *   1. **Transient** — the crack of the muzzle blast leaving the barrel. A
 *      sub-millisecond spike of very bright noise. This is the layer that makes
 *      a shot feel like it has force; everything else is body.
 *   2. **Body** — the blast itself: a filtered noise burst plus two or three
 *      high-Q resonances standing in for the chamber and barrel.
 *   3. **Thump** — the low-frequency pressure wave, a fast downward pitch
 *      sweep. This is what the player feels rather than hears.
 *   4. **Mechanics** — bolt, slide, cycling, magazine rattle. Offset 15–70 ms
 *      after the shot, and the single strongest cue for "which gun is this".
 *   5. **Tail** — the environment answering: a darkened noise decay plus a
 *      slap-back reflection.
 *
 * Every family gets four independently seeded takes, and the runtime layers
 * per-shot pitch, filter and envelope jitter on top, so a 90-round machine-gun
 * mag never audibly repeats.
 */
import type { WeaponFamily } from '@/types';
import { Rng } from '@/util/math';
import {
  type BakeJob,
  type NoiseBank,
  filter,
  gainNode,
  modalBank,
  osc,
  percussiveGain,
  saturator,
} from './Dsp';

export interface GunProfile {
  /** Overall loudness relative to the bank. */
  level: number;
  /** Transient brightness (highpass corner) and decay. */
  clickHz: number;
  clickDecay: number;
  clickLevel: number;
  /** Body noise band. */
  bodyHz: number;
  bodyQ: number;
  bodyDecay: number;
  bodyLevel: number;
  /** Chamber resonances, as multiples of bodyHz. */
  resonances: readonly number[];
  resonanceQ: number;
  resonanceDecay: number;
  /** Low pressure wave. */
  thumpHz: number;
  thumpEndHz: number;
  thumpDecay: number;
  thumpLevel: number;
  /** Mechanical action: two impacts, seconds after the shot. */
  mechAt: readonly [number, number];
  mechHz: number;
  mechLevel: number;
  /** Environmental tail. */
  tailCut: number;
  tailDecay: number;
  tailLevel: number;
  /** Slap-back reflection delay, seconds. */
  slap: number;
  /** Extra tonal layer for energy weapons — 0 disables. */
  energyHz: number;
  energyLevel: number;
  /** Total buffer length. */
  seconds: number;
}

const base: GunProfile = {
  level: 0.9,
  clickHz: 3800,
  clickDecay: 0.0022,
  clickLevel: 0.85,
  bodyHz: 640,
  bodyQ: 1.4,
  bodyDecay: 0.075,
  bodyLevel: 0.95,
  resonances: [1.9, 3.4, 5.8],
  resonanceQ: 11,
  resonanceDecay: 0.045,
  thumpHz: 150,
  thumpEndHz: 48,
  thumpDecay: 0.11,
  thumpLevel: 0.7,
  mechAt: [0.026, 0.062],
  mechHz: 2600,
  mechLevel: 0.3,
  tailCut: 2400,
  tailDecay: 0.24,
  tailLevel: 0.22,
  slap: 0.041,
  energyHz: 0,
  energyLevel: 0,
  seconds: 0.85,
};

const p = (over: Partial<GunProfile>): GunProfile => ({ ...base, ...over });

export const GUN_PROFILES: Record<WeaponFamily, GunProfile> = {
  autoRifle: p({}),

  pulseRifle: p({
    level: 0.82,
    clickHz: 4400,
    bodyHz: 780,
    bodyQ: 1.8,
    bodyDecay: 0.055,
    resonances: [2.1, 3.9, 6.4],
    thumpHz: 135,
    thumpDecay: 0.085,
    mechAt: [0.018, 0.044],
    tailDecay: 0.2,
    seconds: 0.75,
  }),

  scoutRifle: p({
    level: 1,
    clickHz: 3200,
    clickDecay: 0.0028,
    bodyHz: 470,
    bodyQ: 1.15,
    bodyDecay: 0.1,
    resonances: [1.7, 3.1, 5.1],
    resonanceDecay: 0.07,
    thumpHz: 175,
    thumpEndHz: 42,
    thumpDecay: 0.15,
    thumpLevel: 0.85,
    mechAt: [0.034, 0.082],
    mechHz: 2200,
    mechLevel: 0.38,
    tailCut: 1900,
    tailDecay: 0.42,
    tailLevel: 0.3,
    slap: 0.058,
    seconds: 1.1,
  }),

  handCannon: p({
    level: 1.05,
    clickHz: 2900,
    clickDecay: 0.0032,
    clickLevel: 1,
    bodyHz: 380,
    bodyQ: 1,
    bodyDecay: 0.13,
    bodyLevel: 1,
    resonances: [1.6, 2.8, 4.6],
    resonanceQ: 8,
    resonanceDecay: 0.09,
    thumpHz: 195,
    thumpEndHz: 38,
    thumpDecay: 0.2,
    thumpLevel: 1,
    mechAt: [0.042, 0.115],
    mechHz: 1800,
    mechLevel: 0.42,
    tailCut: 1500,
    tailDecay: 0.6,
    tailLevel: 0.36,
    slap: 0.072,
    seconds: 1.35,
  }),

  sidearm: p({
    level: 0.72,
    clickHz: 5200,
    clickDecay: 0.0016,
    bodyHz: 950,
    bodyQ: 2.1,
    bodyDecay: 0.04,
    resonances: [2.4, 4.3, 7.1],
    resonanceDecay: 0.03,
    thumpHz: 120,
    thumpDecay: 0.06,
    thumpLevel: 0.5,
    mechAt: [0.02, 0.05],
    mechHz: 3400,
    mechLevel: 0.34,
    tailCut: 3000,
    tailDecay: 0.15,
    tailLevel: 0.17,
    slap: 0.032,
    seconds: 0.6,
  }),

  submachineGun: p({
    level: 0.68,
    clickHz: 5000,
    clickDecay: 0.0014,
    bodyHz: 880,
    bodyQ: 2.3,
    bodyDecay: 0.035,
    resonances: [2.3, 4.1, 6.9],
    resonanceDecay: 0.026,
    thumpHz: 118,
    thumpDecay: 0.05,
    thumpLevel: 0.44,
    mechAt: [0.014, 0.033],
    mechHz: 3800,
    mechLevel: 0.3,
    tailCut: 3200,
    tailDecay: 0.12,
    tailLevel: 0.14,
    slap: 0.028,
    seconds: 0.5,
  }),

  shotgun: p({
    level: 1.1,
    clickHz: 2400,
    clickDecay: 0.004,
    bodyHz: 300,
    bodyQ: 0.75,
    bodyDecay: 0.2,
    bodyLevel: 1.1,
    resonances: [1.4, 2.3, 3.9],
    resonanceQ: 5,
    resonanceDecay: 0.12,
    thumpHz: 165,
    thumpEndHz: 34,
    thumpDecay: 0.26,
    thumpLevel: 1.1,
    mechAt: [0.16, 0.30],
    mechHz: 1400,
    mechLevel: 0.5,
    tailCut: 1300,
    tailDecay: 0.7,
    tailLevel: 0.4,
    slap: 0.085,
    seconds: 1.5,
  }),

  sniperRifle: p({
    level: 1.15,
    clickHz: 2600,
    clickDecay: 0.0042,
    clickLevel: 1.1,
    bodyHz: 330,
    bodyQ: 0.9,
    bodyDecay: 0.17,
    bodyLevel: 1.05,
    resonances: [1.5, 2.6, 4.2],
    resonanceQ: 7,
    resonanceDecay: 0.13,
    thumpHz: 210,
    thumpEndHz: 32,
    thumpDecay: 0.3,
    thumpLevel: 1.15,
    mechAt: [0.19, 0.42],
    mechHz: 1600,
    mechLevel: 0.55,
    tailCut: 1150,
    tailDecay: 1.05,
    tailLevel: 0.46,
    slap: 0.115,
    seconds: 1.9,
  }),

  fusionRifle: p({
    level: 0.95,
    clickHz: 4200,
    clickDecay: 0.0018,
    bodyHz: 720,
    bodyQ: 3.2,
    bodyDecay: 0.11,
    resonances: [2.0, 3.0, 4.0],
    resonanceQ: 16,
    resonanceDecay: 0.14,
    thumpHz: 140,
    thumpEndHz: 55,
    thumpDecay: 0.14,
    thumpLevel: 0.62,
    mechAt: [0.09, 0.2],
    mechHz: 5200,
    mechLevel: 0.18,
    tailCut: 2600,
    tailDecay: 0.45,
    tailLevel: 0.24,
    slap: 0.05,
    energyHz: 430,
    energyLevel: 0.5,
    seconds: 1.2,
  }),

  rocketLauncher: p({
    level: 1.1,
    clickHz: 1900,
    clickDecay: 0.005,
    bodyHz: 240,
    bodyQ: 0.6,
    bodyDecay: 0.34,
    bodyLevel: 1.1,
    resonances: [1.3, 2.1, 3.2],
    resonanceQ: 4,
    resonanceDecay: 0.22,
    thumpHz: 130,
    thumpEndHz: 28,
    thumpDecay: 0.45,
    thumpLevel: 1.2,
    mechAt: [0.25, 0.55],
    mechHz: 1100,
    mechLevel: 0.3,
    tailCut: 900,
    tailDecay: 1.2,
    tailLevel: 0.5,
    slap: 0.13,
    seconds: 2,
  }),

  grenadeLauncher: p({
    level: 1,
    clickHz: 2100,
    clickDecay: 0.0038,
    bodyHz: 270,
    bodyQ: 0.7,
    bodyDecay: 0.14,
    resonances: [1.4, 2.2, 3.6],
    resonanceQ: 6,
    resonanceDecay: 0.1,
    thumpHz: 155,
    thumpEndHz: 40,
    thumpDecay: 0.2,
    thumpLevel: 0.95,
    mechAt: [0.13, 0.3],
    mechHz: 1500,
    mechLevel: 0.45,
    tailCut: 1250,
    tailDecay: 0.5,
    tailLevel: 0.32,
    slap: 0.07,
    seconds: 1.25,
  }),

  machineGun: p({
    level: 1,
    clickHz: 3300,
    clickDecay: 0.0026,
    bodyHz: 500,
    bodyQ: 1.2,
    bodyDecay: 0.09,
    resonances: [1.8, 3.2, 5.4],
    resonanceDecay: 0.06,
    thumpHz: 168,
    thumpEndHz: 40,
    thumpDecay: 0.16,
    thumpLevel: 0.95,
    mechAt: [0.022, 0.05],
    mechHz: 2000,
    mechLevel: 0.48,
    tailCut: 1700,
    tailDecay: 0.4,
    tailLevel: 0.3,
    slap: 0.062,
    seconds: 1,
  }),

  bow: p({
    level: 0.6,
    clickHz: 1600,
    clickDecay: 0.006,
    clickLevel: 0.4,
    bodyHz: 210,
    bodyQ: 1.9,
    bodyDecay: 0.09,
    bodyLevel: 0.45,
    resonances: [2.7, 5.1, 8.3],
    resonanceQ: 20,
    resonanceDecay: 0.16,
    thumpHz: 90,
    thumpEndHz: 46,
    thumpDecay: 0.1,
    thumpLevel: 0.32,
    mechAt: [0.005, 0.03],
    mechHz: 4200,
    mechLevel: 0.22,
    tailCut: 2200,
    tailDecay: 0.3,
    tailLevel: 0.12,
    slap: 0.05,
    seconds: 0.8,
  }),

  traceRifle: p({
    level: 0.55,
    clickHz: 6200,
    clickDecay: 0.0012,
    clickLevel: 0.35,
    bodyHz: 1500,
    bodyQ: 5,
    bodyDecay: 0.05,
    bodyLevel: 0.4,
    resonances: [2.0, 3.0, 4.02],
    resonanceQ: 24,
    resonanceDecay: 0.09,
    thumpHz: 95,
    thumpEndHz: 70,
    thumpDecay: 0.05,
    thumpLevel: 0.2,
    mechAt: [0.4, 0.9],
    mechHz: 6000,
    mechLevel: 0.05,
    tailCut: 4200,
    tailDecay: 0.16,
    tailLevel: 0.1,
    slap: 0.02,
    energyHz: 880,
    energyLevel: 0.55,
    seconds: 0.55,
  }),
};

/** Per-take jitter so the four bakes of a family are genuinely different. */
function jitter(g: GunProfile, rng: Rng): GunProfile {
  return {
    ...g,
    clickHz: g.clickHz * rng.range(0.88, 1.14),
    clickDecay: g.clickDecay * rng.range(0.8, 1.25),
    bodyHz: g.bodyHz * rng.range(0.9, 1.11),
    bodyQ: g.bodyQ * rng.range(0.85, 1.2),
    bodyDecay: g.bodyDecay * rng.range(0.86, 1.16),
    resonanceQ: g.resonanceQ * rng.range(0.8, 1.25),
    resonanceDecay: g.resonanceDecay * rng.range(0.8, 1.25),
    thumpHz: g.thumpHz * rng.range(0.92, 1.09),
    thumpDecay: g.thumpDecay * rng.range(0.88, 1.14),
    mechAt: [g.mechAt[0] * rng.range(0.8, 1.25), g.mechAt[1] * rng.range(0.85, 1.2)] as const,
    mechHz: g.mechHz * rng.range(0.85, 1.18),
    tailCut: g.tailCut * rng.range(0.85, 1.2),
    tailDecay: g.tailDecay * rng.range(0.85, 1.2),
    slap: g.slap * rng.range(0.8, 1.3),
  };
}

/** Build one shot into an offline graph at `t0`. */
export function buildShot(
  ctx: OfflineAudioContext,
  dest: AudioNode,
  t0: number,
  bank: NoiseBank,
  g: GunProfile,
  rng: Rng,
): void {
  const out = gainNode(ctx, g.level);
  out.connect(dest);

  // -- 1. transient -------------------------------------------------------
  //
  // Two parts. The *spike* is a 0.6 ms broadband burst that is deliberately the
  // loudest thing in the whole shot: a real muzzle blast's leading edge peaks
  // within a millisecond, and if any later layer out-peaks it the measured
  // attack time slides past 5 ms and the shot stops reading as a crack. The
  // *crack* on top of it carries the family's brightness.
  {
    const spike = bank.source('white');
    const shp = filter(ctx, 'highpass', 400, 0.7);
    // Just enough to be the peak. Pushed higher, normalisation scales the body
    // and thump down with it and the gun turns into all click and no weight.
    const spikeLevel = Math.max(g.clickLevel, g.bodyLevel, g.thumpLevel) * 1.25;
    const senv = percussiveGain(ctx, t0, spikeLevel, 0.00012, 0.0006);
    spike.connect(shp).connect(senv).connect(out);
    spike.start(t0, rng.range(0, 1.2));
    spike.stop(t0 + 0.02);

    const nz = bank.source('white');
    const hp = filter(ctx, 'highpass', g.clickHz, 0.8);
    const bp = filter(ctx, 'bandpass', g.clickHz * 1.6, 0.9);
    const env = percussiveGain(ctx, t0, g.clickLevel * 1.15, 0.00016, g.clickDecay);
    nz.connect(hp).connect(bp).connect(env).connect(out);
    nz.start(t0, rng.range(0, 1.2));
    nz.stop(t0 + 0.03);
  }

  // -- 2. body + chamber resonance ----------------------------------------
  {
    const nz = bank.source('white');
    const bp = filter(ctx, 'bandpass', g.bodyHz, g.bodyQ);
    // A downward filter sweep is what makes the blast "open up" then close.
    bp.frequency.setValueAtTime(g.bodyHz * 2.4, t0);
    bp.frequency.exponentialRampToValueAtTime(g.bodyHz * 0.7, t0 + g.bodyDecay * 1.4);
    const env = percussiveGain(ctx, t0, g.bodyLevel, 0.0004, g.bodyDecay);
    const sat = saturator(ctx, 1.8);
    nz.connect(bp).connect(sat).connect(env).connect(out);
    nz.start(t0, rng.range(0, 2.5));
    nz.stop(t0 + g.bodyDecay * 3 + 0.05);

    const res = bank.source('white');
    const resSum = gainNode(ctx, 0.55);
    for (const mult of g.resonances) {
      const f = filter(ctx, 'bandpass', g.bodyHz * mult, g.resonanceQ * rng.range(0.85, 1.2));
      const gg = gainNode(ctx, 1 / g.resonances.length);
      res.connect(f).connect(gg).connect(resSum);
    }
    const resEnv = percussiveGain(ctx, t0, 0.9, 0.0003, g.resonanceDecay);
    resSum.connect(resEnv).connect(out);
    res.start(t0, rng.range(0, 2.5));
    res.stop(t0 + g.resonanceDecay * 3 + 0.05);
  }

  // -- 3. low pressure wave -----------------------------------------------
  {
    const o = osc(ctx, 'sine', g.thumpHz);
    o.frequency.setValueAtTime(g.thumpHz, t0);
    o.frequency.exponentialRampToValueAtTime(g.thumpEndHz, t0 + g.thumpDecay);
    const sub = osc(ctx, 'triangle', g.thumpHz * 0.5);
    sub.frequency.setValueAtTime(g.thumpHz * 0.5, t0);
    sub.frequency.exponentialRampToValueAtTime(g.thumpEndHz * 0.6, t0 + g.thumpDecay * 1.3);
    const env = percussiveGain(ctx, t0, g.thumpLevel, 0.0009, g.thumpDecay);
    const sat = saturator(ctx, 2.4);
    const mix = gainNode(ctx, 1);
    o.connect(mix);
    const subG = gainNode(ctx, 0.5);
    sub.connect(subG).connect(mix);
    mix.connect(sat).connect(env).connect(out);
    o.start(t0);
    o.stop(t0 + g.thumpDecay * 2 + 0.05);
    sub.start(t0);
    sub.stop(t0 + g.thumpDecay * 2.6 + 0.05);
  }

  // -- 4. mechanical action ------------------------------------------------
  for (let i = 0; i < g.mechAt.length; i++) {
    const at = t0 + g.mechAt[i];
    const lvl = g.mechLevel * (i === 0 ? 1 : 0.72);
    const nz = bank.source('white');
    const hp = filter(ctx, 'highpass', g.mechHz * 0.6, 0.9);
    const env = percussiveGain(ctx, at, lvl, 0.0003, 0.012 * rng.range(0.7, 1.5));
    nz.connect(hp).connect(env).connect(out);
    nz.start(at, rng.range(0, 2.5));
    nz.stop(at + 0.06);
    // Metal ring on the cycling parts: two inharmonic modes, short.
    modalBank(
      ctx,
      out,
      at,
      [
        { f: g.mechHz * rng.range(0.95, 1.05), a: lvl * 0.5, decay: 0.028 },
        { f: g.mechHz * rng.range(1.53, 1.71), a: lvl * 0.3, decay: 0.019 },
      ],
      1,
    );
  }

  // -- 5. environmental tail + slap-back -----------------------------------
  {
    const nz = bank.source('white');
    const lp = filter(ctx, 'lowpass', g.tailCut, 0.7);
    lp.frequency.setValueAtTime(g.tailCut, t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(160, g.tailCut * 0.22), t0 + g.tailDecay);
    const env = percussiveGain(ctx, t0 + 0.004, g.tailLevel, 0.006, g.tailDecay);
    nz.connect(lp).connect(env).connect(out);
    nz.start(t0, rng.range(0, 2.5));
    nz.stop(t0 + g.tailDecay * 3 + 0.1);

    const slapNz = bank.source('white');
    const slapLp = filter(ctx, 'lowpass', g.tailCut * 0.55, 0.9);
    const slapEnv = percussiveGain(
      ctx,
      t0 + g.slap,
      g.tailLevel * 0.7,
      0.0016,
      g.tailDecay * 0.55,
    );
    slapNz.connect(slapLp).connect(slapEnv).connect(out);
    slapNz.start(t0 + g.slap, rng.range(0, 2.5));
    slapNz.stop(t0 + g.slap + g.tailDecay * 2 + 0.1);
  }

  // -- energy overlay (fusion / trace) -------------------------------------
  if (g.energyHz > 0) {
    const o = osc(ctx, 'sawtooth', g.energyHz);
    o.frequency.setValueAtTime(g.energyHz * 2.6, t0);
    o.frequency.exponentialRampToValueAtTime(g.energyHz * 0.8, t0 + 0.09);
    const bp = filter(ctx, 'bandpass', g.energyHz * 3, 4);
    const env = percussiveGain(ctx, t0, g.energyLevel, 0.0006, 0.14);
    o.connect(bp).connect(env).connect(out);
    o.start(t0);
    o.stop(t0 + 0.35);
    // Ring-modulated shimmer keeps energy weapons from sounding like a saw pad.
    const ring = osc(ctx, 'sine', g.energyHz * 5.13);
    const ringG = gainNode(ctx, 0);
    ringG.gain.setValueAtTime(g.energyLevel * 0.4, t0);
    ringG.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.11);
    ring.connect(ringG).connect(out);
    ring.start(t0);
    ring.stop(t0 + 0.2);
  }
}

export const GUN_TAKES = 4;

/** Every gunshot job in the bank: `gun_<family>_<take>`. */
export function gunJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];
  let seed = 0x1234f;
  for (const family of Object.keys(GUN_PROFILES) as WeaponFamily[]) {
    const profile = GUN_PROFILES[family];
    for (let take = 0; take < GUN_TAKES; take++) {
      const rng = new Rng((seed = (seed * 1664525 + 1013904223) >>> 0));
      const g = take === 0 ? profile : jitter(profile, rng);
      jobs.push({
        id: `gun_${family}_${take}`,
        duration: g.seconds,
        // Leave headroom: several shots overlap in a burst and the bus limiter
        // should be doing gain reduction, not the source.
        normalize: 0.72,
        tailFade: Math.min(0.08, g.seconds * 0.15),
        build: (ctx, dest, t0, bank) => buildShot(ctx, dest, t0, bank, g, rng),
      });
    }
  }
  return jobs;
}

/** Reload / handling foley, parameterised by weapon weight class. */
export function handlingJobs(): BakeJob[] {
  const weights: Array<[string, number, number]> = [
    ['light', 3600, 0.55],
    ['medium', 2300, 0.75],
    ['heavy', 1350, 1],
  ];
  const jobs: BakeJob[] = [];
  for (const [name, hz, mass] of weights) {
    jobs.push({
      id: `reload_${name}`,
      duration: 1.05,
      normalize: 0.6,
      tailFade: 0.06,
      build: (ctx, dest, t0, bank) => {
        const rng = new Rng(0x77 + hz);
        const out = gainNode(ctx, 1);
        out.connect(dest);
        // mag release · mag out · mag in · bolt
        const beats = [0, 0.16, 0.44, 0.72];
        const levels = [0.5, 0.4, 0.9, 0.75];
        for (let i = 0; i < beats.length; i++) {
          const at = t0 + beats[i] * (0.85 + mass * 0.3);
          const nz = bank.source('white');
          const hp = filter(ctx, 'highpass', hz * rng.range(0.6, 1.1), 0.9);
          const env = percussiveGain(ctx, at, levels[i], 0.0003, 0.02 + mass * 0.03);
          nz.connect(hp).connect(env).connect(out);
          nz.start(at, rng.range(0, 2.5));
          nz.stop(at + 0.12);
          modalBank(
            ctx,
            out,
            at,
            [
              { f: hz * rng.range(0.9, 1.1), a: levels[i] * 0.45, decay: 0.05 * mass },
              { f: hz * rng.range(1.5, 1.8), a: levels[i] * 0.28, decay: 0.035 * mass },
              { f: hz * rng.range(2.4, 2.9), a: levels[i] * 0.15, decay: 0.022 * mass },
            ],
            1,
          );
          // Spring/clunk body under the metal.
          const o = osc(ctx, 'sine', 160 * mass);
          const oe = percussiveGain(ctx, at, levels[i] * 0.5 * mass, 0.001, 0.07);
          o.connect(oe).connect(out);
          o.start(at);
          o.stop(at + 0.2);
        }
      },
    });
  }

  jobs.push({
    id: 'weapon_dryfire',
    duration: 0.2,
    normalize: 0.5,
    tailFade: 0.03,
    build: (ctx, dest, t0, bank) => {
      const nz = bank.source('white');
      const hp = filter(ctx, 'highpass', 4200, 1.2);
      const env = percussiveGain(ctx, t0, 0.8, 0.0002, 0.01);
      nz.connect(hp).connect(env).connect(dest);
      nz.start(t0, 0.3);
      nz.stop(t0 + 0.05);
      modalBank(ctx, dest, t0, [{ f: 3100, a: 0.4, decay: 0.03 }], 1);
    },
  });

  jobs.push({
    id: 'weapon_swap',
    duration: 0.45,
    normalize: 0.5,
    tailFade: 0.05,
    build: (ctx, dest, t0, bank) => {
      const rng = new Rng(0x5151);
      for (const [at, lvl] of [
        [0, 0.7],
        [0.13, 0.55],
      ] as const) {
        const nz = bank.source('white');
        const bp = filter(ctx, 'bandpass', 1800 * rng.range(0.8, 1.3), 1.6);
        const env = percussiveGain(ctx, t0 + at, lvl, 0.0004, 0.055);
        nz.connect(bp).connect(env).connect(dest);
        nz.start(t0 + at, rng.range(0, 2));
        nz.stop(t0 + at + 0.2);
      }
      modalBank(
        ctx,
        dest,
        t0,
        [
          { f: 720, a: 0.4, decay: 0.16 },
          { f: 1180, a: 0.22, decay: 0.11 },
        ],
        1,
      );
    },
  });

  // Charge-up for fusion/bow, played as a live-controlled loop-ish one-shot.
  jobs.push({
    id: 'weapon_charge',
    duration: 1.1,
    normalize: 0.55,
    tailFade: 0.05,
    build: (ctx, dest, t0) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      for (let i = 0; i < 3; i++) {
        const o = osc(ctx, i === 0 ? 'sawtooth' : 'sine', 90 * (i + 1));
        o.frequency.setValueAtTime(90 * (i + 1), t0);
        o.frequency.exponentialRampToValueAtTime(560 * (i + 1), t0 + 0.95);
        const bp = filter(ctx, 'bandpass', 900, 2.5 + i * 2);
        bp.frequency.setValueAtTime(500, t0);
        bp.frequency.exponentialRampToValueAtTime(4200, t0 + 0.95);
        const g = ctx.createGain();
        g.gain.setValueAtTime(1e-4, t0);
        g.gain.exponentialRampToValueAtTime(0.5 / (i + 1), t0 + 0.9);
        g.gain.exponentialRampToValueAtTime(1e-4, t0 + 1.05);
        o.connect(bp).connect(g).connect(out);
        o.start(t0);
        o.stop(t0 + 1.1);
      }
    },
  });

  return jobs;
}
