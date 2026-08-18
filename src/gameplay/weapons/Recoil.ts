/**
 * Recoil — three genuinely independent layers, because conflating them is why
 * most browser shooters feel mushy.
 *
 *  1. **Camera kick.** An instant, purely visual punch on the view. It never
 *     changes where bullets go and it always returns to exactly zero. Handed to
 *     `player.addViewKick()`.
 *
 *  2. **Aim drift.** The real recoil: the reticle *climbs*. Crucially it is a
 *     *learnable pattern*, not noise — each family has a fixed, seeded sequence
 *     indexed by the shot number since the burst started, so a player who
 *     memorises "up, drift left, snap right" is rewarded. `recoilRandomness`
 *     dials in a small per-shot jitter on top so it isn't robotic, but the
 *     pattern always dominates. Drift recentres after the trigger is released.
 *
 *  3. **Bloom.** `spreadPerShot` added per shot, decaying at `spreadRecovery`
 *     rad/s after a short hold, hard-capped so the cone never exceeds
 *     `stats.spread`. This is what the crosshair reads.
 *
 * Everything here is frame-rate independent and driven from the fixed 120 Hz
 * step; there is no `performance.now()` anywhere.
 */
import type { WeaponFamily, WeaponStats } from '@/types';
import { Rng, TAU, clamp, lerp, moveTowards } from '@/util/math';

/** Pattern length. Longer mags simply wrap, which reads as a repeating climb. */
const PATTERN_STEPS = 96;

/** Seconds the trigger must be idle before drift/bloom start recovering. */
const RECOVERY_HOLD = 0.1;

/** Shots reset to pattern step 0 after this long without firing. */
const PATTERN_RESET_IDLE = 0.38;

/**
 * Build one family's climb pattern. Vertical starts hard and plateaus (so the
 * first three shots of any burst are the accurate ones); horizontal is a seeded
 * damped walk built from three sines, which produces the characteristic
 * "leans left, then hooks right" signature without ever being random.
 */
function buildPattern(seed: number): Float32Array {
  const rng = new Rng(seed);
  const a1 = rng.range(0, TAU);
  const a2 = rng.range(0, TAU);
  const a3 = rng.range(0, TAU);
  const f1 = rng.range(0.1, 0.2);
  const f2 = rng.range(0.33, 0.55);
  const f3 = rng.range(0.72, 1.15);
  const bias = rng.range(-0.35, 0.35);
  const out = new Float32Array(PATTERN_STEPS * 2);
  let walk = 0;
  for (let i = 0; i < PATTERN_STEPS; i++) {
    // Vertical: 1.25× on the first shot decaying to ~0.7× at the plateau.
    const v = 0.7 + 0.55 * (5 / (i + 5));
    const drive =
      Math.sin(i * f1 + a1) * 0.62 +
      Math.sin(i * f2 + a2) * 0.3 +
      Math.sin(i * f3 + a3) * 0.16 +
      bias;
    walk = walk * 0.84 + drive * 0.52;
    out[i * 2] = v;
    out[i * 2 + 1] = clamp(walk, -1.7, 1.7);
  }
  return out;
}

const FAMILY_SEED: Record<WeaponFamily, number> = {
  autoRifle: 0x51ab21,
  pulseRifle: 0x7c3d99,
  scoutRifle: 0x1de4b7,
  handCannon: 0x9f2c05,
  sidearm: 0x33ce81,
  submachineGun: 0xc41f6d,
  shotgun: 0x0a77e3,
  sniperRifle: 0xe6b024,
  fusionRifle: 0x5d18aa,
  rocketLauncher: 0x2b9c40,
  grenadeLauncher: 0xd0512f,
  machineGun: 0x88f10c,
  bow: 0x46a7d5,
  traceRifle: 0xbe3390,
};

/** One immutable pattern per family, generated once at module load. */
export const RECOIL_PATTERNS: Record<WeaponFamily, Float32Array> = (() => {
  const out = {} as Record<WeaponFamily, Float32Array>;
  for (const k of Object.keys(FAMILY_SEED) as WeaponFamily[]) {
    out[k] = buildPattern(FAMILY_SEED[k]);
  }
  return out;
})();

/** Normalised pattern sample for a shot index; `out` is mutated and returned. */
export function patternSample(
  family: WeaponFamily,
  index: number,
  out: { v: number; h: number },
): { v: number; h: number } {
  const p = RECOIL_PATTERNS[family] ?? RECOIL_PATTERNS.autoRifle;
  const i = (index % PATTERN_STEPS) * 2;
  out.v = p[i];
  out.h = p[i + 1];
  return out;
}

export interface RecoilImpulse {
  /** Positive = view climbs upward, radians. */
  pitch: number;
  /** Positive = view swings right, radians. */
  yaw: number;
}

const _sample = { v: 0, h: 0 };

export class RecoilController {
  /** The impulse produced by the most recent shot (layer 2). */
  readonly kick: RecoilImpulse = { pitch: 0, yaw: 0 };
  /** The recentring delta produced by the most recent `update` (layer 2). */
  readonly recover: RecoilImpulse = { pitch: 0, yaw: 0 };
  /** Visual-only camera punch of the most recent shot (layer 1). */
  readonly viewKick: RecoilImpulse = { pitch: 0, yaw: 0 };

  /** Accumulated bloom above `baseSpread`, radians (layer 3). */
  bloom = 0;
  /** Shot index inside the current pattern run. */
  patternIndex = 0;

  /** Climb applied and not yet given back — what recentring owes the player. */
  private appliedPitch = 0;
  private appliedYaw = 0;
  private idle = 0;
  /** Multiplier applied by perks (Zen Moment, Under Pressure, …). */
  private stability = 1;
  private bloomScale = 1;
  private rng: Rng;

  constructor(seed = 0x4d2a17) {
    this.rng = new Rng(seed);
  }

  /** Full reset — call on equip, reload completion and respawn. */
  reset(): void {
    this.bloom = 0;
    this.patternIndex = 0;
    this.appliedPitch = 0;
    this.appliedYaw = 0;
    this.idle = PATTERN_RESET_IDLE;
    this.kick.pitch = this.kick.yaw = 0;
    this.recover.pitch = this.recover.yaw = 0;
    this.viewKick.pitch = this.viewKick.yaw = 0;
    this.stability = 1;
    this.bloomScale = 1;
  }

  /** Restart the learnable pattern without discarding accumulated climb. */
  resetPattern(): void {
    this.patternIndex = 0;
  }

  /**
   * Perk hook. `stability` scales layers 1 and 2, `bloomScale` scales layer 3.
   * Both are clamped so a stack of perks can never invert recoil.
   */
  setModifiers(stability: number, bloomScale: number): void {
    this.stability = clamp(stability, 0.25, 1.6);
    this.bloomScale = clamp(bloomScale, 0.15, 2);
  }

  /**
   * Register a shot. Returns the aim impulse for layer 2; `viewKick` holds the
   * layer-1 punch and `bloom` has already absorbed layer 3.
   */
  shot(stats: WeaponStats, aimProgress: number): RecoilImpulse {
    patternSample(stats.family, this.patternIndex, _sample);
    this.patternIndex++;
    this.idle = 0;

    // Aiming tightens every layer — that is the whole point of aiming.
    const adsScale = lerp(1, 0.68, aimProgress) * this.stability;

    // The pattern dominates; randomness only smears it.
    const r = clamp(stats.recoilRandomness, 0, 1);
    const jitterH = (this.rng.next() * 2 - 1) * r * 0.55;
    const jitterV = (this.rng.next() * 2 - 1) * r * 0.2;

    const pitch = stats.recoilVertical * (_sample.v + jitterV) * adsScale;
    const yaw = stats.recoilHorizontal * (_sample.h * (1 - r * 0.4) + jitterH) * adsScale;

    this.kick.pitch = pitch;
    this.kick.yaw = yaw;
    this.appliedPitch += pitch;
    this.appliedYaw += yaw;

    // Layer 1: a sharper, shorter punch than the climb, slightly randomised so
    // repeated shots don't strobe on exactly the same axis.
    this.viewKick.pitch = stats.cameraKick * lerp(1, 0.75, aimProgress) * (0.85 + this.rng.next() * 0.3);
    this.viewKick.yaw =
      stats.cameraKick * 0.42 * lerp(1, 0.75, aimProgress) * (this.rng.next() * 2 - 1);

    // Layer 3: bloom, hard-capped so the cone can never exceed stats.spread.
    const bloomCap = Math.max(0, stats.spread - stats.baseSpread);
    this.bloom = Math.min(bloomCap, this.bloom + stats.spreadPerShot * this.bloomScale);

    return this.kick;
  }

  /**
   * Fixed-step decay. Writes the recentring delta into `recover`; the caller
   * applies `-recover` to the aim so the reticle walks back down.
   */
  update(dt: number, stats: WeaponStats): void {
    this.idle += dt;
    this.recover.pitch = 0;
    this.recover.yaw = 0;

    if (this.idle >= PATTERN_RESET_IDLE) this.patternIndex = 0;
    if (this.idle < RECOVERY_HOLD) return;

    // Bloom: linear decay, so it provably reaches exactly zero.
    if (this.bloom > 0) {
      this.bloom = moveTowards(this.bloom, 0, stats.spreadRecovery * this.bloomScale * dt);
    }

    // Drift: linear recentring, likewise exact. Vertical recentres fully;
    // horizontal recentres at 80% so a long burst leaves a small honest scar.
    const step = stats.recoilRecovery * dt;
    if (this.appliedPitch !== 0) {
      const next = moveTowards(this.appliedPitch, 0, step);
      this.recover.pitch = this.appliedPitch - next;
      this.appliedPitch = next;
    }
    if (this.appliedYaw !== 0) {
      const next = moveTowards(this.appliedYaw, 0, step * 0.8);
      this.recover.yaw = this.appliedYaw - next;
      this.appliedYaw = next;
    }
  }

  /** Effective cone half-angle for the crosshair, guaranteed ≤ stats.spread. */
  cone(stats: WeaponStats, aimProgress: number): number {
    const base = lerp(stats.baseSpread, stats.baseSpread * 0.22, aimProgress);
    return Math.min(stats.spread, base + this.bloom);
  }

  /** Outstanding climb, for the verification harness. */
  get residual(): number {
    return Math.abs(this.appliedPitch) + Math.abs(this.appliedYaw);
  }
}
