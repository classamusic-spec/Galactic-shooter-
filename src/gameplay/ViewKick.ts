/**
 * View-kick primitives: critically-damped springs, the two-part recoil model,
 * and a decaying multi-octave shake stack.
 *
 * Why recoil is split in two:
 *   A gun that only pushes the *camera* feels like a rumble pack — your shots
 *   still land where the crosshair was. A gun that only pushes the *aim* feels
 *   like input lag. Real weapon feel is both at once, with different recovery:
 *
 *   - The **camera** part is a fast spring that returns to exactly zero. It is
 *     the visual punch. It never changes where your bullets go.
 *   - The **aim** part moves the true look angles and only auto-recovers a
 *     *fraction* of what it took. The remainder is the recoil pattern the
 *     player has to physically pull down — which is what makes a weapon feel
 *     like it has a personality instead of a screen shader.
 *
 *   And when the player *does* compensate manually, `absorbManualLook` cancels
 *   the pending auto-recentre in that direction, so the game never fights the
 *   correction the player just made (the classic "double-correction" bug that
 *   makes recoil feel slippery).
 *
 * Everything here is allocation-free and deterministic at the fixed 120 Hz step.
 */
import { clamp01, hash1 } from '@/util/math';
import { settings } from '@/core/Settings';

/** How the applied kick is divided between visual punch and true aim movement. */
export const KICK = {
  /** Share of a kick that goes to the camera-only spring (fully recovers). */
  cameraShare: 1.0,
  /**
   * Share that moves the real aim. Below 1 so the crosshair climbs more slowly
   * than the camera jolts — the camera "overshoots" the aim, which reads as
   * muzzle rise rather than as the whole world tilting.
   */
  aimShare: 0.62,
  /**
   * Of the aim movement, how much comes back on its own. 0.55 leaves 45% of the
   * climb for the player to pull down, which is roughly Destiny's auto-recentre.
   */
  aimRecoverFraction: 0.55,
  /** Default auto-recentre rate, 1/s. Weapons override per-shot. */
  aimRecoverRate: 7.0,
  /** Camera spring stiffness — high, so the punch is a snap not a wobble. */
  cameraStiffness: 210,
  /** Slightly under-damped so there is one small overshoot on the way back. */
  cameraDamping: 0.72,
  /** Roll kick is looser; it is pure garnish and should hang a beat longer. */
  rollStiffness: 120,
  rollDamping: 0.65,
} as const;

export const SHAKE = {
  /** Max simultaneous shake sources. New ones evict the weakest. */
  maxSources: 8,
  /** Radians of rotation per unit of `amount`. */
  rotationScale: 0.055,
  /** Metres of positional jitter per unit of `amount`. */
  positionScale: 0.055,
  /** Default duration and frequency when the caller does not specify. */
  duration: 0.36,
  frequency: 24,
  /** Multiplier applied when the accessibility "reduced motion" flag is set. */
  reducedMotionScale: 0.3,
  /** Global ceiling so stacked explosions cannot make the frame unreadable. */
  maxAmount: 3.2,
} as const;

/**
 * Damped harmonic oscillator, integrated semi-implicitly. Stable for the
 * stiffness values above at dt = 1/120 with a wide margin.
 */
export class Spring {
  value = 0;
  velocity = 0;
  target = 0;

  constructor(
    private stiffness: number,
    private dampingRatio: number,
  ) {}

  add(v: number): void {
    this.value += v;
  }

  /** Kick the spring by velocity instead of displacement — a softer punch. */
  impulse(v: number): void {
    this.velocity += v;
  }

  /**
   * Integrate by `dt`, sub-stepping as needed.
   *
   * The sub-stepping is not a nicety. Semi-implicit Euler on a damped
   * oscillator diverges once `c*dt` exceeds 2, which for the stiffnesses this
   * rig uses happens at around 10 fps — precisely when a frame hitch is most
   * likely. Without this, one long frame launches the camera to infinity and
   * the screen goes black. Verified: a 0.13 s frame blew the eye height to
   * 1226 m before this was added. At 60 Hz `n` is always 1, so it is free.
   */
  step(dt: number): number {
    const k = this.stiffness;
    const c = 2 * Math.sqrt(k) * this.dampingRatio;
    const maxDt = Math.min(0.5 / Math.max(c, 1e-4), 1 / Math.sqrt(k));
    const n = Math.min(16, Math.max(1, Math.ceil(dt / maxDt)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    // Snap to rest so idle springs cost nothing and never drift on denormals.
    if (Math.abs(this.value - this.target) < 1e-6 && Math.abs(this.velocity) < 1e-5) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }

  reset(v = 0): void {
    this.value = v;
    this.velocity = 0;
    this.target = 0;
  }
}

/** Output slot for a step of recoil recovery. Reused; never allocate per call. */
export interface AimDelta {
  pitch: number;
  yaw: number;
}

export class ViewKick {
  /** Camera-only offsets, radians. Fully recover to zero. */
  readonly pitchSpring = new Spring(KICK.cameraStiffness, KICK.cameraDamping);
  readonly yawSpring = new Spring(KICK.cameraStiffness, KICK.cameraDamping);
  readonly rollSpring = new Spring(KICK.rollStiffness, KICK.rollDamping);

  /** Aim movement queued for this step (applied once, immediately). */
  private instantPitch = 0;
  private instantYaw = 0;
  /** Aim movement still owed back to the player by the auto-recentre. */
  private owedPitch = 0;
  private owedYaw = 0;
  private recoverRate: number = KICK.aimRecoverRate;

  /**
   * @param pitch  Upward kick, radians (positive = muzzle rise).
   * @param yaw    Sideways kick, radians.
   * @param roll   Camera roll, radians. Visual only — never touches aim.
   * @param recovery Auto-recentre rate override, 1/s.
   */
  add(pitch: number, yaw: number, roll: number, recovery: number = KICK.aimRecoverRate): void {
    this.pitchSpring.add(pitch * KICK.cameraShare);
    this.yawSpring.add(yaw * KICK.cameraShare);
    this.rollSpring.add(roll);

    const ap = pitch * KICK.aimShare;
    const ay = yaw * KICK.aimShare;
    this.instantPitch += ap;
    this.instantYaw += ay;
    this.owedPitch += ap * KICK.aimRecoverFraction;
    this.owedYaw += ay * KICK.aimRecoverFraction;
    this.recoverRate = recovery;
  }

  /**
   * Advance the springs and compute this step's change to the *true* aim.
   * Writes into `out` so the hot path allocates nothing.
   */
  step(dt: number, out: AimDelta): void {
    out.pitch = this.instantPitch;
    out.yaw = this.instantYaw;
    this.instantPitch = 0;
    this.instantYaw = 0;

    const f = 1 - Math.exp(-this.recoverRate * dt);
    const dp = this.owedPitch * f;
    const dy = this.owedYaw * f;
    this.owedPitch -= dp;
    this.owedYaw -= dy;
    out.pitch -= dp;
    out.yaw -= dy;

    this.pitchSpring.step(dt);
    this.yawSpring.step(dt);
    this.rollSpring.step(dt);
  }

  /**
   * Tell the kick how far the player moved the mouse this step so it can drop
   * the matching amount of pending auto-recentre. Without this, pulling down on
   * a climbing weapon over-corrects the moment you stop firing.
   */
  absorbManualLook(dPitch: number, dYaw: number): void {
    if (this.owedPitch > 0 && dPitch < 0) this.owedPitch = Math.max(0, this.owedPitch + dPitch);
    else if (this.owedPitch < 0 && dPitch > 0) this.owedPitch = Math.min(0, this.owedPitch + dPitch);
    if (this.owedYaw > 0 && dYaw < 0) this.owedYaw = Math.max(0, this.owedYaw + dYaw);
    else if (this.owedYaw < 0 && dYaw > 0) this.owedYaw = Math.min(0, this.owedYaw + dYaw);
  }

  /** True while any part of the recoil is still settling — used by the HUD. */
  get settling(): boolean {
    return (
      Math.abs(this.owedPitch) > 1e-4 ||
      Math.abs(this.owedYaw) > 1e-4 ||
      Math.abs(this.pitchSpring.value) > 1e-4
    );
  }

  reset(): void {
    this.pitchSpring.reset();
    this.yawSpring.reset();
    this.rollSpring.reset();
    this.instantPitch = this.instantYaw = 0;
    this.owedPitch = this.owedYaw = 0;
  }
}

// ---------------------------------------------------------------------------
// Shake
// ---------------------------------------------------------------------------

/**
 * Value noise over a 1-D time axis. Three octaves of this read as a real impact
 * rattle; a single sine reads as a wobble, and pure white noise reads as static.
 */
function vnoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash1(i * 73856093 + seed) * 2 - 1;
  const b = hash1((i + 1) * 73856093 + seed) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

interface ShakeSource {
  amount: number;
  remaining: number;
  duration: number;
  frequency: number;
  seed: number;
}

/** Result slot for `ShakeStack.sample`. Reused. */
export interface ShakeSample {
  pitch: number;
  yaw: number;
  roll: number;
  x: number;
  y: number;
}

export class ShakeStack {
  private sources: ShakeSource[] = [];
  private time = 0;
  private seedCounter = 1;
  /** Current summed intensity, exposed so the HUD/PostFX can react. */
  intensity = 0;

  constructor() {
    for (let i = 0; i < SHAKE.maxSources; i++) {
      this.sources.push({ amount: 0, remaining: 0, duration: 1, frequency: 20, seed: 0 });
    }
  }

  add(amount: number, duration: number = SHAKE.duration, frequency: number = SHAKE.frequency): void {
    if (amount <= 0) return;
    // Pick a free slot, else evict whichever source has the least energy left.
    let slot = this.sources[0];
    let worst = Infinity;
    for (const s of this.sources) {
      const energy = s.remaining <= 0 ? -1 : s.amount * (s.remaining / s.duration);
      if (energy < worst) {
        worst = energy;
        slot = s;
      }
      if (energy < 0) break;
    }
    if (worst > amount) return; // everything queued is stronger — ignore this one
    slot.amount = Math.min(amount, SHAKE.maxAmount);
    slot.remaining = duration;
    slot.duration = Math.max(0.016, duration);
    slot.frequency = frequency;
    slot.seed = (this.seedCounter = (this.seedCounter + 1013) | 0);
  }

  step(dt: number): void {
    this.time += dt;
    let total = 0;
    for (const s of this.sources) {
      if (s.remaining <= 0) continue;
      s.remaining -= dt;
      if (s.remaining <= 0) {
        s.remaining = 0;
        continue;
      }
      total += s.amount * (s.remaining / s.duration);
    }
    this.intensity = Math.min(total, SHAKE.maxAmount);
  }

  /** Sum every live source into `out`. `scale` folds in accessibility settings. */
  sample(out: ShakeSample, scale = 1): ShakeSample {
    out.pitch = out.yaw = out.roll = out.x = out.y = 0;
    const global = scale * (settings.user.reducedMotion ? SHAKE.reducedMotionScale : 1);
    if (global <= 0) return out;

    for (const s of this.sources) {
      if (s.remaining <= 0) continue;
      // Quadratic falloff: impacts hit hard then get out of the way fast.
      const decay = clamp01(s.remaining / s.duration);
      const a = s.amount * decay * decay * global;
      const t = this.time * s.frequency;
      const sd = s.seed;
      // Three octaves at irrational-ish frequency ratios so the pattern never
      // visibly loops within a single shake.
      const o1 = vnoise(t, sd);
      const o2 = vnoise(t * 2.31, sd + 977) * 0.5;
      const o3 = vnoise(t * 4.73, sd + 4231) * 0.25;
      const n1 = o1 + o2 + o3;
      const n2 =
        vnoise(t, sd + 131) + vnoise(t * 2.31, sd + 1783) * 0.5 + vnoise(t * 4.73, sd + 6151) * 0.25;
      const n3 =
        vnoise(t * 0.83, sd + 613) +
        vnoise(t * 1.97, sd + 2749) * 0.5 +
        vnoise(t * 3.61, sd + 8123) * 0.25;

      out.pitch += n1 * a * SHAKE.rotationScale;
      out.yaw += n2 * a * SHAKE.rotationScale;
      out.roll += n3 * a * SHAKE.rotationScale * 0.6;
      out.x += n2 * a * SHAKE.positionScale;
      out.y += n1 * a * SHAKE.positionScale;
    }
    return out;
  }

  reset(): void {
    for (const s of this.sources) s.remaining = 0;
    this.intensity = 0;
  }
}
