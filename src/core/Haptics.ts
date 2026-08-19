/**
 * Controller rumble.
 *
 * The Gamepad extensions expose `vibrationActuator.playEffect('dual-rumble')`,
 * which a DualSense supports over both USB and Bluetooth in Chromium. There is
 * no trigger-effect API on the web, so the adaptive triggers are out of reach —
 * dual-rumble is the whole vocabulary, and the design has to get its variety
 * from duration and the balance between the two motors rather than from
 * waveform.
 *
 * Two rules keep it from turning into mush:
 *
 * - **The strongest effect wins, it does not add.** A dozen impacts in a second
 *   would otherwise saturate both motors and every hit would feel identical.
 * - **Nothing re-triggers under its own tail.** A weaker effect arriving while a
 *   stronger one is still playing is dropped rather than cutting it short.
 *
 * Everything is driven off the same events audio subscribes to, so haptics can
 * never disagree with what the player is hearing.
 */
import { events } from './EventBus';
import { settings } from './Settings';
import { clamp01 } from '@/util/math';

interface Effect {
  /** Low-frequency (heavy) motor, 0..1. */
  strong: number;
  /** High-frequency (light) motor, 0..1. */
  weak: number;
  /** Milliseconds. */
  duration: number;
}

/**
 * The palette. Weights are deliberately spread: firing is a light tick so it can
 * repeat ten times a second without fatigue, taking damage is heavy and short so
 * it cuts through, and a super is the only thing allowed to use both motors at
 * full for longer than a fifth of a second.
 */
const EFFECTS = {
  fire: { strong: 0.16, weak: 0.34, duration: 55 },
  fireHeavy: { strong: 0.45, weak: 0.5, duration: 110 },
  hit: { strong: 0.0, weak: 0.28, duration: 40 },
  kill: { strong: 0.3, weak: 0.45, duration: 110 },
  damaged: { strong: 0.7, weak: 0.3, duration: 160 },
  shieldBreak: { strong: 0.5, weak: 0.7, duration: 220 },
  explosion: { strong: 0.9, weak: 0.45, duration: 260 },
  land: { strong: 0.35, weak: 0.1, duration: 90 },
  superCast: { strong: 1, weak: 0.8, duration: 420 },
  death: { strong: 0.85, weak: 0.2, duration: 600 },
  pickup: { strong: 0, weak: 0.2, duration: 35 },
} as const satisfies Record<string, Effect>;

export type HapticId = keyof typeof EFFECTS;

/** Weapon families heavy enough to earn the bigger fire pulse. */
const HEAVY_FAMILIES = ['shotgun', 'sniperRifle', 'rocketLauncher', 'machineGun', 'handCannon'];

interface Actuator {
  playEffect(type: string, params: Record<string, number>): Promise<string>;
  reset?(): Promise<string>;
}

class HapticsSystem {
  private unsubs: Array<() => void> = [];
  /** Wall-clock ms at which the running effect ends. */
  private busyUntil = 0;
  /** Intensity of the running effect, for the strongest-wins comparison. */
  private busyWeight = 0;
  private installed = false;

  install(): void {
    if (this.installed) return;
    this.installed = true;
    const on = <K extends Parameters<typeof events.on>[0]>(
      key: K,
      fn: Parameters<typeof events.on<K>>[1],
    ): void => {
      this.unsubs.push(events.on(key, fn));
    };

    on('weapon:fired', (p) => {
      this.play(HEAVY_FAMILIES.some((f) => p.weaponId.indexOf(f) >= 0) ? 'fireHeavy' : 'fire');
    });
    on('hitmarker', (p) => this.play(p.kill ? 'kill' : 'hit'));
    on('player:damaged', (p) => this.play(p.shieldBroke ? 'shieldBreak' : 'damaged'));
    on('player:died', () => this.play('death'));
    on('explosion', () => this.play('explosion'));
    on('super:activated', () => this.play('superCast'));
    on('loot:pickup', () => this.play('pickup'));
  }

  /**
   * Fire an effect. Silently does nothing when there is no pad, when the browser
   * has no actuator, or when vibration is turned off — haptics are garnish and
   * must never be able to throw into a gameplay event handler.
   */
  play(id: HapticId): void {
    const scale = clamp01(settings.user.vibration);
    if (scale <= 0) return;
    const pad = this.pad();
    const actuator = (pad as unknown as { vibrationActuator?: Actuator } | null)?.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') return;

    const e = EFFECTS[id];
    const weight = Math.max(e.strong, e.weak) * scale;
    const now = performance.now();
    if (now < this.busyUntil && weight <= this.busyWeight) return;

    this.busyUntil = now + e.duration;
    this.busyWeight = weight;
    void actuator
      .playEffect('dual-rumble', {
        startDelay: 0,
        duration: e.duration,
        strongMagnitude: clamp01(e.strong * scale),
        weakMagnitude: clamp01(e.weak * scale),
      })
      .catch(() => {
        /* an unsupported actuator rejects; there is nothing to recover */
      });
  }

  /** Stop immediately — used when the game pauses or the player dies out. */
  stop(): void {
    const actuator = (this.pad() as unknown as { vibrationActuator?: Actuator } | null)
      ?.vibrationActuator;
    this.busyUntil = 0;
    this.busyWeight = 0;
    void actuator?.reset?.().catch(() => {});
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) return p;
    }
    return null;
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.installed = false;
    this.stop();
  }
}

export const haptics = new HapticsSystem();
