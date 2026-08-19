/**
 * Perks — the layer that turns a weapon catalogue into a build system.
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

/**
 * One shot's worth of ammunition.
 *
 * Every refund in this file goes through this rather than adding literal `1`s.
 * A charge-fed weapon spends `ammoPerShot` cells per trigger pull, and handing
 * back a single cell would leave the magazine holding a remainder it can never
 * fire — the cadence gate simply refuses a shot it cannot pay for, with no dry
 * fire and no auto-reload, which reads to the player as the gun having jammed.
 */
const shotWorth = (rt: PerkRuntime): number => Math.max(1, rt.stats.ammoPerShot);

/** True while the magazine is in its last third — Overflow's trigger. */
const lowMagazine = (rt: PerkRuntime): boolean => {
  const size = Math.max(1, rt.host.magazineSize);
  return rt.host.magazine > 0 && rt.host.magazine / size <= 0.3;
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
        rt.host.refundRounds(shotWorth(rt), false);
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
        rt.host.refundRounds(shotWorth(rt) * 2, false);
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

  // -- build-craft added with the new archetypes ----------------------------
  //
  // Every one of these has a *tell*: a toast, an ammo counter that moves, or an
  // explosion. A perk the player cannot see fire is a number, not a build.

  targetLock: {
    id: 'targetLock',
    name: 'Target Lock',
    description: 'Sustained hits on one target ramp damage. Looking away drops it.',
    onHit(rt, ev) {
      if (!ev.target) return;
      const id = ev.target.entityId;
      if (rt.n.lockId !== id) {
        rt.n.lockId = id;
        rt.n.lock = 0;
        rt.silence('targetLock');
      }
      rt.n.lock = Math.min(5, (rt.n.lock ?? 0) + 1);
      bump(rt, 'lock', 1.4);
      // Announced from three stacks so the toast marks the point the ramp
      // starts to matter rather than every trigger pull.
      if (rt.n.lock >= 3) {
        rt.announce('targetLock', `x${rt.n.lock}`);
        rt.silence('targetLock');
      }
    },
    onUpdate(rt) {
      if (rt.t.lock <= 0 && rt.n.lock) {
        rt.n.lock = 0;
        rt.n.lockId = 0;
      }
    },
    contribute(rt) {
      const s = rt.n.lock ?? 0;
      if (s > 0) rt.damageMul *= 1 + 0.08 * s;
    },
  },

  kindling: {
    id: 'kindling',
    name: 'Kindling',
    description: 'Hits stack heat on one target. Fifteen stacks ignite it.',
    onHit(rt, ev) {
      if (!ev.target || rt.t.kindleLock > 0) return;
      const id = ev.target.entityId;
      if (rt.n.kindleId !== id) {
        rt.n.kindleId = id;
        rt.n.kindle = 0;
      }
      rt.n.kindle = (rt.n.kindle ?? 0) + 1;
      bump(rt, 'kindle', 1.4);
      if (rt.n.kindle >= 15) {
        rt.n.kindle = 0;
        // The lockout is what stops a 20 Hz beam from detonating continuously.
        bump(rt, 'kindleLock', 0.8);
        rt.host.perkExplosion(ev.point, 3, 48, rt.stats.element);
        rt.announce('kindling');
        rt.silence('kindling');
      }
    },
    onUpdate(rt) {
      if (rt.t.kindle <= 0 && rt.n.kindle) rt.n.kindle = 0;
    },
  },

  feedingFrenzy: {
    id: 'feedingFrenzy',
    name: 'Feeding Frenzy',
    description: 'Kills escalate reload speed. Three stacks, 5 s each.',
    onKill(rt) {
      rt.n.frenzy = Math.min(3, (rt.n.frenzy ?? 0) + 1);
      bump(rt, 'frenzy', 5);
      rt.announce('feedingFrenzy', `x${rt.n.frenzy}`);
      rt.silence('feedingFrenzy');
    },
    onUpdate(rt) {
      if (rt.t.frenzy <= 0 && rt.n.frenzy) rt.n.frenzy = 0;
    },
    contribute(rt) {
      const s = rt.n.frenzy ?? 0;
      if (s > 0) rt.reloadMul *= 1 - 0.12 * s;
    },
  },

  overflow: {
    id: 'overflow',
    name: 'Overflow',
    description: 'The bottom of the magazine hits harder and reloads faster.',
    onUpdate(rt) {
      if (lowMagazine(rt)) rt.announce('overflow');
      else rt.silence('overflow');
    },
    contribute(rt) {
      if (!lowMagazine(rt)) return;
      rt.damageMul *= 1.22;
      rt.reloadMul *= 0.85;
    },
  },

  reservist: {
    id: 'reservist',
    name: 'Reservist',
    description: 'Five seconds off the trigger and the magazine tops itself up from reserves.',
    onUpdate(rt, dt) {
      if (rt.host.stowed || rt.host.reloading || rt.idleTime < 5) {
        rt.n.resv = 0;
        rt.silence('reservist');
        return;
      }
      if (rt.host.magazine >= rt.host.magazineSize || rt.host.reserves <= 0) return;
      rt.n.resv = (rt.n.resv ?? 0) + dt;
      if (rt.n.resv < 0.35) return;
      rt.n.resv = 0;
      rt.host.refundRounds(shotWorth(rt), true);
      rt.announce('reservist');
    },
  },

  handoff: {
    id: 'handoff',
    name: 'Handoff',
    description: 'The first two rounds after a swap hit harder and land tighter.',
    onEquip(rt) {
      rt.n.handoff = 2;
      rt.announce('handoff');
      rt.silence('handoff');
    },
    onFire(rt) {
      if (rt.n.handoff) rt.n.handoff = Math.max(0, rt.n.handoff - 1);
    },
    contribute(rt) {
      if (!rt.n.handoff) return;
      rt.damageMul *= 1.25;
      rt.bloomMul *= 0.45;
    },
  },

  cellRecycler: {
    id: 'cellRecycler',
    name: 'Recycler',
    description: 'On a charge-fed weapon, every second precision hit returns a full shot.',
    // Deliberately absent from `PERK_IDS`: on a weapon that spends one round per
    // shot it would do nothing, and a roll that does nothing is a dead roll.
    onHit(rt, ev) {
      if (!ev.precision || !ev.target || rt.stats.ammoPerShot < 2) return;
      rt.n.recycle = (rt.n.recycle ?? 0) + 1;
      if (rt.n.recycle < 2) return;
      rt.n.recycle = 0;
      rt.host.refundRounds(shotWorth(rt), false);
      rt.announce('cellRecycler');
      rt.silence('cellRecycler');
    },
  },

  // -- exotic signatures ----------------------------------------------------
  //
  // None of these are in `PERK_IDS`, so `Progression.rollWeapon` can never put
  // one on a random drop. They exist on exactly one catalogue entry each.

  bloodPrice: {
    id: 'bloodPrice',
    name: 'Blood Price',
    description: 'Kills inside nine metres pay for themselves: shells returned, damage banked.',
    onKill(rt, ev) {
      if (ev.distance > 9) return;
      rt.host.refundRounds(shotWorth(rt) * 2, false);
      rt.n.wergild = Math.min(3, (rt.n.wergild ?? 0) + 1);
      bump(rt, 'wergild', 5);
      rt.announce('bloodPrice', `x${rt.n.wergild}`);
      rt.silence('bloodPrice');
    },
    onUpdate(rt) {
      if (rt.t.wergild <= 0 && rt.n.wergild) rt.n.wergild = 0;
    },
    contribute(rt) {
      const s = rt.n.wergild ?? 0;
      if (s > 0) rt.damageMul *= 1 + 0.08 * s;
    },
  },

  amendment: {
    id: 'amendment',
    name: 'Amendment',
    description: 'A precision kill un-spends the shot. The record says it was never fired.',
    onKill(rt, ev) {
      if (!ev.precision) return;
      rt.host.refundRounds(shotWorth(rt), false);
      bump(rt, 'amendment', 3);
      rt.announce('amendment');
    },
    contribute(rt) {
      // The filed shot leaves no trace on the weapon either — no bloom to
      // recover from, so a chain of precision kills never opens the cone.
      if (rt.t.amendment > 0) rt.bloomMul *= 0.35;
    },
  },

  cull: {
    id: 'cull',
    name: 'Cull',
    description: 'Wounded targets take far more damage, and finishing one returns ammunition.',
    onHit(rt, ev) {
      const t = ev.target;
      if (!t) return;
      const cap = t.maxHealth + t.maxShield;
      const now = t.health + t.shield;
      if (cap <= 0 || now / cap > 0.4) return;
      bump(rt, 'cull', 0.6);
      rt.announce('cull');
    },
    onKill(rt) {
      rt.host.refundRounds(shotWorth(rt) * 2, false);
    },
    contribute(rt) {
      if (rt.t.cull > 0) rt.damageMul *= 1.45;
    },
  },

  increase: {
    id: 'increase',
    name: 'Increase',
    description: 'Every kill adds a seeker to the next volley. Three, and it decays.',
    onKill(rt) {
      rt.n.increase = Math.min(3, (rt.n.increase ?? 0) + 1);
      bump(rt, 'increase', 6);
      rt.announce('increase', `+${rt.n.increase}`);
      rt.silence('increase');
    },
    onUpdate(rt) {
      if (rt.t.increase <= 0 && rt.n.increase) rt.n.increase = 0;
      // `stats` is this slot's effective-stats clone — the object the firing
      // path reads `pellets` from — and `base` is the roll it was made from, so
      // rewriting it every step is self-healing rather than cumulative.
      const base = Math.max(1, rt.base.pellets);
      rt.stats.pellets = base + (rt.n.increase ?? 0);
    },
    onStow(rt) {
      rt.stats.pellets = Math.max(1, rt.base.pellets);
    },
  },

  tribute: {
    id: 'tribute',
    name: 'Tribute',
    description: 'Kills bank tribute. The next spike spends the whole bank in one blast.',
    onKill(rt) {
      rt.n.tribute = Math.min(3, (rt.n.tribute ?? 0) + 1);
      bump(rt, 'tribute', 12);
      rt.announce('tribute', `x${rt.n.tribute}`);
      rt.silence('tribute');
    },
    onHit(rt) {
      // `contribute()` has already handed the bank to the impact that is being
      // resolved right now, so spending it here charges exactly one hit.
      if (!rt.n.tribute) return;
      rt.n.tribute = 0;
      rt.t.tribute = 0;
      rt.silence('tribute');
    },
    onUpdate(rt) {
      if (rt.t.tribute <= 0 && rt.n.tribute) rt.n.tribute = 0;
    },
    contribute(rt) {
      const s = rt.n.tribute ?? 0;
      if (s <= 0) return;
      rt.bonusSplashRadius = Math.max(rt.bonusSplashRadius, 1.6 + 0.9 * s);
      rt.bonusSplashFraction = Math.max(rt.bonusSplashFraction, 0.25 * s);
    },
  },
};

/**
 * Perks a random drop may roll.
 *
 * `Progression.rollWeapon` draws from this list, so it is the guest list rather
 * than the catalogue: the five exotic signatures and `cellRecycler` are in
 * `PERKS` — equippable, describable, live the moment a catalogue weapon names
 * them — but never rollable, because an exotic's identity cannot survive being
 * handed out at random and a perk that does nothing on the weapon it lands on
 * is a wasted roll.
 */
export const EXCLUSIVE_PERK_IDS: readonly string[] = [
  'cellRecycler',
  'bloodPrice',
  'amendment',
  'cull',
  'increase',
  'tribute',
];

export const PERK_IDS: string[] = Object.keys(PERKS).filter(
  (id) => !EXCLUSIVE_PERK_IDS.includes(id),
);
