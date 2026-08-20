/**
 * Engrams — the loot box, and the only reason to keep shooting after the
 * shooting is good.
 *
 * The rule this file exists to enforce is one of *timing*. An engram that
 * decoded where it dropped would hand the player a weapon reveal in the middle
 * of a firefight, which is the worst possible moment for it: they cannot read
 * it, cannot act on it, and the one thing the whole loop is built to produce —
 * "oh, *that* dropped" — lands on a player who is busy not dying. So a pickup
 * is a *promise*: it gives instant feedback in the field (`loot:pickup`, the
 * magnet, the rarity-coloured light) and banks the reward. The mission ends,
 * and every promise pays out at once.
 *
 * Two consequences follow from that, and both are deliberate:
 *
 * 1. The queue lives in the **save**, not in this object. A run that ends with
 *    a browser refresh, or a player who quits to orbit, must not silently lose
 *    six engrams. `Progression.pendingEngrams` outlives every level.
 * 2. Rarity is rolled **twice** against the same table. `progression.rollRarity`
 *    (and therefore `RARITY_WEIGHTS`) decides what colour the engram drops at,
 *    and rolls again at decode with the engram's own tier as both a luck bonus
 *    and a floor. A legendary engram can never decode into a common, and it
 *    skews the second roll upward — so a rarer engram is both harder to get and
 *    genuinely worth more, without a second rarity table existing anywhere.
 */
import type { DamageElement, FactionId, ItemRarity, PlanetId, WeaponSlot } from '@/types';
import { events } from '@/core/EventBus';
import { Rng } from '@/util/math';
import { WEAPONS } from './weapons/WeaponDefs';
import {
  RARITY_ORDER,
  progression,
  type PendingEngram,
  type WeaponItem,
} from './Progression';

/**
 * Luck each step up the rarity ladder adds to the decode roll. `rollRarity`
 * multiplies weight *i* by `1 + luck * i * 0.55`, so one tier of engram roughly
 * doubles the chance of a legendary and quadruples the chance of an exotic
 * without ever making either certain.
 */
const TIER_LUCK = 0.75;

/** Energy-slot elements. The kinetic slot is kinetic by definition. */
const ENERGY_ELEMENTS: readonly DamageElement[] = ['solar', 'arc', 'void', 'stasis'];

/**
 * Which weapon family an engram of a given rarity produces. Higher rarities
 * skew toward the power slot, because that is where the "oh, *that* dropped"
 * moments live.
 */
const COMMON_POOL = ['autoRifle', 'pulseRifle', 'scoutRifle', 'sidearm', 'submachineGun'];
const GOOD_POOL = ['handCannon', 'shotgun', 'sniperRifle', 'fusionRifle', 'bow', 'traceRifle'];
const POWER_POOL = ['rocketLauncher', 'grenadeLauncher', 'machineGun'];

export function pickWeaponForRarity(rarity: ItemRarity, rng: Rng): string {
  if (rarity === 'exotic' || rarity === 'legendary') {
    return rng.bool(0.45) ? rng.pick(POWER_POOL) : rng.pick(GOOD_POOL);
  }
  if (rarity === 'rare') return rng.bool(0.5) ? rng.pick(GOOD_POOL) : rng.pick(COMMON_POOL);
  return rng.pick(COMMON_POOL);
}

/** What a finished decode produced, for the results screen and for tests. */
export interface DecodeResult {
  items: WeaponItem[];
  /** The best rarity in the batch, or null when nothing was pending. */
  best: ItemRarity | null;
}

export class EngramSystem {
  private rng = new Rng(0x5eed1e);
  private unsubs: Array<() => void> = [];
  /** Every item decoded this session, newest last. Read by the loadout screen. */
  readonly decoded: WeaponItem[] = [];

  constructor() {
    // The campaign layer emits `mission:completed`; this is its loot half.
    // `level:cleared` is deliberately *not* subscribed to: one mission may run
    // several encounter scripts, and paying out per encounter would turn the
    // reveal back into the mid-firefight noise this whole design avoids.
    //
    // `mission:completed` is not subscribed to here either, and that is the
    // fix for a measured bug rather than a style preference. Owning the trigger
    // meant the decode raced the last few pickups: engrams collected at t=21.8
    // and t=28.9 against a completion at t=28.8, and the second one banked
    // 0.1 s too late and was never opened. The boss drops an engram 95% of the
    // time and killing the boss is what completes the mission, so the run's
    // best engram is precisely the one that lands on the wrong side of that
    // line. `LootSystem` now sweeps the ground first and then calls
    // `decodeAll`, in that order, on one path.
  }

  /** Engrams banked and not yet decoded. */
  get pending(): number {
    return progression.pendingEngrams.length;
  }

  /**
   * Bank an engram picked up in the field. `luck` is the source's generosity —
   * a boss chest hands over more than a trash-mob drop.
   */
  collect(rarity: ItemRarity, faction: FactionId, planet: PlanetId | null, luck = 0): void {
    progression.addPendingEngram({ rarity, faction, planet, luck, at: Date.now() });
  }

  /**
   * Decode everything banked. Safe to call with an empty queue — that is the
   * common case for a mission the player finished without picking anything up.
   */
  decodeAll(): DecodeResult {
    const queue = progression.takePendingEngrams();
    const items: WeaponItem[] = [];
    let best: ItemRarity | null = null;
    for (const e of queue) {
      const item = this.decodeOne(e);
      items.push(item);
      if (best === null || RARITY_ORDER.indexOf(item.rarity) > RARITY_ORDER.indexOf(best)) {
        best = item.rarity;
      }
    }
    if (items.length > 0) progression.save();
    return { items, best };
  }

  private decodeOne(e: PendingEngram): WeaponItem {
    const rarity = this.rollDecodeRarity(e);
    const weaponId = pickWeaponForRarity(rarity, this.rng);
    // The catalogue is authoritative about which slot a family belongs in: a
    // rocket launcher in the kinetic slot would draw primary ammo bricks and
    // read as a bug. Take the slot from the weapon, not from the engram.
    const slot: WeaponSlot = WEAPONS[weaponId]?.slot ?? 'kinetic';
    const element: DamageElement =
      slot === 'kinetic' ? 'kinetic' : this.rng.pick(ENERGY_ELEMENTS);
    const item = progression.rollWeapon(weaponId, slot, element, e.faction, rarity);
    progression.addToVault(item);
    this.decoded.push(item);
    if (this.decoded.length > 60) this.decoded.shift();
    events.emit('engram:decoded', {
      uid: item.uid,
      name: item.name,
      rarity: item.rarity,
      weaponId: item.weaponId,
    });
    return item;
  }

  /**
   * The engram's own rarity is a floor and a thumb on the scale, never a
   * guarantee — the second roll is what makes opening one an event rather than
   * a transaction.
   */
  private rollDecodeRarity(e: PendingEngram): ItemRarity {
    const tier = Math.max(0, RARITY_ORDER.indexOf(e.rarity));
    const rolled = progression.rollRarity(e.luck + tier * TIER_LUCK, this.rng);
    return RARITY_ORDER.indexOf(rolled) >= tier ? rolled : RARITY_ORDER[tier];
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.decoded.length = 0;
  }
}
