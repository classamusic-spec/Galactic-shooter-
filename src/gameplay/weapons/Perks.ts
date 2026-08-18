/**
 * Perks — the layer that turns fourteen weapons into a build system.
 *
 * A perk is a small state machine with three ways to affect the game:
 *   1. `modify()` rewrites the effective `WeaponStats` once, at equip time.
 *   2. `contribute()` writes live multipliers every step (damage, reload speed,
 *      stability, bloom, range, handling). These are aggregated, never stacked
 *      blindly, and clamped in `recompute()`.
 *   3. The event hooks (`onFire`, `onHit`, `onKill`, `onReload`, `onStow`)
 *      mutate the perk's own timers and counters.
 *
 * Perk state lives in two flat records — `t` for timers in seconds, `n` for
 * counters — so a `PerkRuntime` never allocates after construction.
 */
import type * as THREE from 'three';
import type { DamageElement, Damageable, WeaponStats } from '@/types';
import { events } from '@/core/EventBus';
import { clamp } from '@/util/math';

/** What a perk can ask the weapon system to do. */
export interface PerkHost {
  readonly magazine: number;
  readonly magazineSize: number;
  readonly reserves: number;
  readonly stowed: boolean;
  readonly reloading: boolean;
  /** Put rounds back in the magazine. `fromReserves` false = created rounds. */
  refundRounds(count: number, fromReserves: boolean): void;
  /** Detonate a perk-sourced explosion (Dragonfly, Explosive Payload). */
  perkExplosion(
    point: THREE.Vector3,
    radius: number,
    damage: number,
    element: DamageElement,
  ): void;
  /** Silently top the magazine up (Auto-Loading Holster). */
  instantReload(): void;
}

export interface PerkHitEvent {
  target: Damageable | null;
  precision: boolean;
  /** Metres from muzzle to impact. */
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Damage actually dealt. */
  damage: number;
  killed: boolean;
  /** Target's max health, used by Vorpal Weapon to spot elites. */
  targetMaxHealth: number;
}

export interface PerkDef {
  id: string;
  name: string;
  description: string;
  /** One-time rewrite of the effective stats at equip. */
  modify?(stats: WeaponStats, base: WeaponStats): void;
  /** Write live multipliers. Called every step after timers decay. */
  contribute?(rt: PerkRuntime): void;
  onFire?(rt: PerkRuntime): void;
  onHit?(rt: PerkRuntime, ev: PerkHitEvent): void;
  onKill?(rt: PerkRuntime, ev: PerkHitEvent): void;
  onReloadFinished?(rt: PerkRuntime): void;
  onEquip?(rt: PerkRuntime): void;
  onStow?(rt: PerkRuntime): void;
  onUpdate?(rt: PerkRuntime, dt: number): void;
}

/** Live perk state for one weapon. One instance per loadout slot. */
export class PerkRuntime {
  readonly defs: PerkDef[] = [];
  /** Timers, seconds remaining. */
  readonly t: Record<string, number> = Object.create(null) as Record<string, number>;
  /** Counters / stacks. */
  readonly n: Record<string, number> = Object.create(null) as Record<string, number>;

  // -- aggregated live modifiers, rebuilt by recompute() ---------------------
  damageMul = 1;
  /** <1 = faster reload. */
  reloadMul = 1;
  /** <1 = less recoil. */
  stabilityMul = 1;
  /** <1 = less bloom. */
  bloomMul = 1;
  /** Multiplies falloffStart and falloffEnd. */
  rangeMul = 1;
  /** <1 = faster ADS, charge and swap. */
  handlingMul = 1;
  aimAssistMul = 1;
  /** Splash added to every hit by Explosive Payload; 0 when inactive. */
  bonusSplashRadius = 0;
  bonusSplashFraction = 0;

  /** Written by the weapon system each step so perks can read context. */
  aimProgress = 0;
  idleTime = 10;
  host: PerkHost;
  base: WeaponStats;
  stats: WeaponStats;

  /** Perks that were active last frame, for one-shot toast suppression. */
  private announced = new Set<string>();

  constructor(host: PerkHost, base: WeaponStats, stats: WeaponStats) {
    this.host = host;
    this.base = base;
    this.stats = stats;
    for (const id of stats.perks) {
      const def = PERKS[id];
      if (def) this.defs.push(def);
    }
  }

  /** Emit a toast exactly once per activation of a perk. */
  announce(id: string, sub?: string): void {
    if (this.announced.has(id)) return;
    this.announced.add(id);
    const def = PERKS[id];
    events.emit('ui:toast', { text: (def?.name ?? id).toUpperCase(), sub, duration: 1.8 });
  }

  /** Clear the announce latch when a perk drops out. */
  silence(id: string): void {
    this.announced.delete(id);
  }

  reset(): void {
    for (const k of Object.keys(this.t)) this.t[k] = 0;
    for (const k of Object.keys(this.n)) this.n[k] = 0;
    this.announced.clear();
    this.recompute();
  }

  update(dt: number): void {
    for (const k in this.t) {
      if (this.t[k] > 0) {
        this.t[k] -= dt;
        if (this.t[k] <= 0) {
          this.t[k] = 0;
          this.silence(k);
        }
      }
    }
    for (const d of this.defs) d.onUpdate?.(this, dt);
    this.recompute();
  }

  fire(): void {
    for (const d of this.defs) d.onFire?.(this);
    this.recompute();
  }

  hit(ev: PerkHitEvent): void {
    for (const d of this.defs) d.onHit?.(this, ev);
    if (ev.killed) for (const d of this.defs) d.onKill?.(this, ev);
    this.recompute();
  }

  reloadFinished(): void {
    for (const d of this.defs) d.onReloadFinished?.(this);
    this.recompute();
  }

  equip(): void {
    for (const d of this.defs) d.onEquip?.(this);
    this.recompute();
  }

  stow(): void {
    for (const d of this.defs) d.onStow?.(this);
    this.recompute();
  }

  /** Rebuild the aggregate multipliers from scratch. Never accumulates drift. */
  recompute(): void {
    this.damageMul = 1;
    this.reloadMul = 1;
    this.stabilityMul = 1;
    this.bloomMul = 1;
    this.rangeMul = 1;
    this.handlingMul = 1;
    this.aimAssistMul = 1;
    this.bonusSplashRadius = 0;
    this.bonusSplashFraction = 0;
    for (const d of this.defs) d.contribute?.(this);
    // Clamps: a full perk stack must never trivialise the game.
    this.damageMul = clamp(this.damageMul, 0.5, 2.4);
    this.reloadMul = clamp(this.reloadMul, 0.45, 1.6);
    this.stabilityMul = clamp(this.stabilityMul, 0.4, 1.5);
    this.bloomMul = clamp(this.bloomMul, 0.3, 1.6);
    this.rangeMul = clamp(this.rangeMul, 0.8, 1.6);
    this.handlingMul = clamp(this.handlingMul, 0.55, 1.4);
    this.aimAssistMul = clamp(this.aimAssistMul, 0.7, 1.5);
  }
}

/** Apply every `modify()` hook to produce the effective stats for a weapon. */
export function applyPerkModifiers(base: WeaponStats, out: WeaponStats): WeaponStats {
  for (const id of base.perks) PERKS[id]?.modify?.(out, base);
  return out;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const bump = (rt: PerkRuntime, key: string, seconds: number): void => {
  rt.t[key] = seconds;
};

export const PERKS: Record<string, PerkDef> = {
  outlaw: {
    id: 'outlaw',
    name: 'Outlaw',
    description: 'Precision kills dramatically increase reload speed for 6 s.',
    onKill(rt, ev) {
      if (!ev.precision) return;
      bump(rt, 'outlaw', 6);
      rt.announce('outlaw');
    },
    contribute(rt) {
      if (rt.t.outlaw > 0) rt.reloadMul *= 0.6;
    },
  },

  rampage: {
    id: 'rampage',
    name: 'Rampage',
    description: 'Kills stack escalating damage. Three stacks, 4.5 s each.',
    onKill(rt) {
      rt.n.rampage = Math.min(3, (rt.n.rampage ?? 0) + 1);
      bump(rt, 'rampage', 4.5);
      rt.announce('rampage', `x${rt.n.rampage}`);
      // Re-announce on every new stack.
      rt.silence('rampage');
    },
    onUpdate(rt) {
      if (rt.t.rampage <= 0 && rt.n.rampage) rt.n.rampage = 0;
    },
    contribute(rt) {
      const s = rt.n.rampage ?? 0;
      if (s > 0) rt.damageMul *= 1 + 0.1 * s;
    },
  },

  dragonfly: {
    id: 'dragonfly',
    name: 'Dragonfly',
    description: 'Precision kills trigger an elemental detonation.',
    onKill(rt, ev) {
      if (!ev.precision) return;
      rt.host.perkExplosion(ev.point, 3.2, 48, rt.stats.element);
      rt.announce('dragonfly');
      rt.silence('dragonfly');
    },
  },

  rangefinder: {
    id: 'rangefinder',
    name: 'Rangefinder',
    description: 'Aiming extends damage falloff and widens target acquisition.',
    contribute(rt) {
      const a = rt.aimProgress;
      rt.rangeMul *= 1 + 0.2 * a;
      rt.aimAssistMul *= 1 + 0.12 * a;
    },
  },

  openingShot: {
    id: 'openingShot',
    name: 'Opening Shot',
    description: 'The first shot of an engagement is more accurate and damaging.',
    onUpdate(rt) {
      // Armed after 1.2 s off the trigger — that is what makes it an *opening*.
      rt.n.opening = rt.idleTime >= 1.2 ? 1 : (rt.n.opening ?? 0);
    },
    // `fire()` runs after the shot has been resolved, so the bonus applies to
    // the opening shot itself and is spent immediately afterwards.
    onFire(rt) {
      rt.n.opening = 0;
    },
    contribute(rt) {
      if (rt.n.opening) {
        rt.damageMul *= 1.25;
        rt.bloomMul *= 0.4;
        rt.aimAssistMul *= 1.2;
      }
    },
  },

  killClip: {
    id: 'killClip',
    name: 'Kill Clip',
    description: 'Reloading after a kill grants a large damage bonus for 5 s.',
    onKill(rt) {
      bump(rt, 'killClipArmed', 4);
    },
    onReloadFinished(rt) {
      if (rt.t.killClipArmed > 0) {
        rt.t.killClipArmed = 0;
        bump(rt, 'killClip', 5);
        rt.announce('killClip');
      }
    },
    contribute(rt) {
      if (rt.t.killClip > 0) rt.damageMul *= 1.33;
    },
  },

  underPressure: {
    id: 'underPressure',
    name: 'Under Pressure',
    description: 'Sustained hits progressively tighten recoil and bloom.',
    onHit(rt) {
      rt.n.pressure = Math.min(10, (rt.n.pressure ?? 0) + 1);
      bump(rt, 'pressure', 1.6);
      if (rt.n.pressure >= 6) rt.announce('underPressure');
    },
    onUpdate(rt) {
      if (rt.t.pressure <= 0 && rt.n.pressure) {
        rt.n.pressure = Math.max(0, rt.n.pressure - 1);
        if (rt.n.pressure > 0) bump(rt, 'pressure', 0.25);
        else rt.silence('underPressure');
      }
    },
    contribute(rt) {
      const p = (rt.n.pressure ?? 0) / 10;
      rt.stabilityMul *= 1 - 0.35 * p;
      rt.bloomMul *= 1 - 0.45 * p;
    },
  },

  autoLoadingHolster: {
    id: 'autoLoadingHolster',
    name: 'Auto-Loading Holster',
    description: 'Stowing this weapon reloads it after a short delay.',
    onStow(rt) {
      bump(rt, 'alhArm', 3.5);
      rt.n.alhPending = 1;
    },
    onEquip(rt) {
      rt.n.alhPending = 0;
      rt.t.alhArm = 0;
    },
    onUpdate(rt) {
      if (!rt.n.alhPending || !rt.host.stowed) return;
      if (rt.t.alhArm <= 0) {
        rt.n.alhPending = 0;
        if (rt.host.magazine < rt.host.magazineSize && rt.host.reserves > 0) {
          rt.host.instantReload();
          rt.announce('autoLoadingHolster');
          rt.silence('autoLoadingHolster');
        }
      }
    },
  },

  tripleTap: {
    id: 'tripleTap',
    name: 'Triple Tap',
    description: 'Every third rapid precision hit returns a round to the magazine.',
    onHit(rt, ev) {
      if (!ev.precision || !ev.target) {
        return;
      }
      if (rt.t.tripleTap <= 0) rt.n.tripleTap = 0;
      rt.n.tripleTap = (rt.n.tripleTap ?? 0) + 1;
      bump(rt, 'tripleTap', 2.5);
      if (rt.n.tripleTap >= 3) {
        rt.n.tripleTap = 0;
        rt.host.refundRounds(1, false);
        rt.announce('tripleTap');
        rt.silence('tripleTap');
      }
    },
  },

  fourthTimesTheCharm: {
    id: 'fourthTimesTheCharm',
    name: "Fourth Time's the Charm",
    description: 'Four rapid precision hits return two rounds to the magazine.',
    onHit(rt, ev) {
      if (!ev.precision || !ev.target) return;
      if (rt.t.fttc <= 0) rt.n.fttc = 0;
      rt.n.fttc = (rt.n.fttc ?? 0) + 1;
      bump(rt, 'fttc', 3);
      if (rt.n.fttc >= 4) {
        rt.n.fttc = 0;
        rt.host.refundRounds(2, false);
        rt.announce('fourthTimesTheCharm');
        rt.silence('fourthTimesTheCharm');
      }
    },
  },

  explosivePayload: {
    id: 'explosivePayload',
    name: 'Explosive Payload',
    description: 'Rounds detonate on impact, dealing area damage.',
    contribute(rt) {
      rt.bonusSplashRadius = 1.7;
      rt.bonusSplashFraction = 0.22;
    },
  },

  vorpalWeapon: {
    id: 'vorpalWeapon',
    name: 'Vorpal Weapon',
    description: 'Increased damage against elites, champions and bosses.',
    // Handled by the weapon system, which knows the target's max health at the
    // moment of the hit; contribute() cannot see per-target context.
    onHit(rt, ev) {
      if (ev.targetMaxHealth >= 600) {
        bump(rt, 'vorpalSeen', 0.5);
        rt.announce('vorpalWeapon');
        rt.silence('vorpalWeapon');
      }
    },
  },

  adrenalineJunkie: {
    id: 'adrenalineJunkie',
    name: 'Adrenaline Junkie',
    description: 'Kills grant damage and handling for 6 s.',
    onKill(rt) {
      bump(rt, 'adrenaline', 6);
      rt.announce('adrenalineJunkie');
    },
    contribute(rt) {
      if (rt.t.adrenaline > 0) {
        rt.damageMul *= 1.2;
        rt.handlingMul *= 0.8;
      }
    },
  },

  zenMoment: {
    id: 'zenMoment',
    name: 'Zen Moment',
    description: 'Causing damage progressively steadies this weapon.',
    onHit(rt) {
      rt.n.zen = Math.min(12, (rt.n.zen ?? 0) + 1);
      bump(rt, 'zen', 1.2);
    },
    onUpdate(rt) {
      if (rt.t.zen <= 0 && rt.n.zen) {
        rt.n.zen = Math.max(0, rt.n.zen - 1);
        if (rt.n.zen > 0) bump(rt, 'zen', 0.2);
      }
    },
    contribute(rt) {
      const z = (rt.n.zen ?? 0) / 12;
      rt.bloomMul *= 1 - 0.4 * z;
      rt.stabilityMul *= 1 - 0.2 * z;
    },
  },

  archersTempo: {
    id: 'archersTempo',
    name: "Archer's Tempo",
    description: 'Precision hits shorten the draw for 5 s.',
    onHit(rt, ev) {
      if (!ev.precision) return;
      bump(rt, 'archersTempo', 5);
      rt.announce('archersTempo');
    },
    contribute(rt) {
      if (rt.t.archersTempo > 0) rt.handlingMul *= 0.72;
    },
  },

  chargeTime: {
    id: 'chargeTime',
    name: 'Accelerated Coils',
    description: 'Permanently shortens charge time at a small damage cost.',
    modify(stats) {
      stats.chargeTime *= 0.86;
      stats.damage *= 0.96;
    },
  },
};

export const PERK_IDS: string[] = Object.keys(PERKS);
