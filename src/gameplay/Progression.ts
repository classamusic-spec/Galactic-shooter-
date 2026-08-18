/**
 * Progression: power, XP, the vault, and what you have finished.
 *
 * The loop this exists to serve is the one every looter-shooter runs on: kill
 * things, get a weapon with a *name*, notice it rolled something you like, and
 * change how you play because of it. That means three things have to be true —
 * drops must be randomised but not uniform, the roll must be readable at a
 * glance, and the item must be worth reading, which is mostly a naming problem.
 *
 * Persistence is versioned and defensive. A save from an older build is
 * discarded rather than migrated, because a half-migrated save that crashes on
 * load costs the player everything, while a reset costs them one session.
 */
import type {
  DamageElement,
  FactionId,
  ItemRarity,
  PlanetId,
  WeaponSlot,
} from '@/types';
import { events } from '@/core/EventBus';
import { Rng, clamp, clamp01 } from '@/util/math';
import { PERK_IDS } from './weapons/Perks';

const STORAGE_KEY = 'gf.progress';
const SAVE_VERSION = 3;

/** Power gained per level, and the XP each level costs. */
export const POWER_PER_LEVEL = 5;
export const BASE_POWER = 100;
export const MAX_LEVEL = 50;

export function xpForLevel(level: number): number {
  // Gently superlinear: early levels are quick, later ones are a commitment.
  return Math.round(320 * Math.pow(level, 1.35));
}

export const RARITY_ORDER: readonly ItemRarity[] = [
  'common',
  'uncommon',
  'rare',
  'legendary',
  'exotic',
];

/** Drop weights. Exotics are deliberately rare enough to be an event. */
export const RARITY_WEIGHTS: Record<ItemRarity, number> = {
  common: 46,
  uncommon: 30,
  rare: 16,
  legendary: 7,
  exotic: 1,
};

export const RARITY_COLOR: Record<ItemRarity, number> = {
  common: 0xc8ccd4,
  uncommon: 0x4fbf6a,
  rare: 0x4d80f0,
  legendary: 0x9b59d0,
  exotic: 0xf0d23c,
};

/** How many perks a roll gets, and how much raw damage it carries. */
const RARITY_PERKS: Record<ItemRarity, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  legendary: 3,
  exotic: 4,
};

const RARITY_POWER_BONUS: Record<ItemRarity, number> = {
  common: -4,
  uncommon: 0,
  rare: 3,
  legendary: 7,
  exotic: 12,
};

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Faction-flavoured names, assembled from a prefix, a noun and an optional
 * suffix clause. Each faction has its own vocabulary and its own grammar — the
 * Nordic clans get possessive kennings, the Greys get catalogue designations,
 * the Insectoids get compound biological terms — so a weapon's name tells you
 * where you got it before you read the tooltip.
 */
const NAME_BANK: Record<
  FactionId,
  { a: readonly string[]; b: readonly string[]; c: readonly string[]; pattern: number }
> = {
  nordic: {
    a: ['Frost', 'Jötunn', 'Rime', 'Wolfsbane', 'Hail', 'Skald', 'Draugr', 'Iron', 'Storm', 'Bright'],
    b: ['Reckoning', 'Oath', 'Verdict', 'Fang', 'Hymn', 'Sunder', 'Vow', 'Harrow', 'Bite', 'Wake'],
    c: ['of the Long Dark', 'of Nine Winters', 'Unbroken', 'of the Deep Shelf', 'Everfrost'],
    pattern: 0,
  },
  grey: {
    a: ['Null', 'Pale', 'Quiet', 'Vestige', 'Nth', 'Cipher', 'Hollow', 'Zeta', 'Meridian', 'Silent'],
    b: ['Directive', 'Postulate', 'Index', 'Theorem', 'Lament', 'Protocol', 'Axiom', 'Vector', 'Fault'],
    c: ['Mk. II', 'Rev. 9', 'Type-04', 'Series C', 'Amended'],
    pattern: 1,
  },
  mantis: {
    a: ['Acid', 'Green', 'Sickle', 'Chrysalis', 'Bloom', 'Thorn', 'Verdant', 'Spore', 'Reaper', 'Vein'],
    b: ['Harvest', 'Scythe', 'Bloom', 'Molt', 'Chorus', 'Prayer', 'Cull', 'Vigil', 'Rite'],
    c: ['of the Third Instar', 'Devouring', 'in Season', 'of the Hollow Grove'],
    pattern: 0,
  },
  insectoid: {
    a: ['Hive', 'Amber', 'Swarm', 'Brood', 'Chitin', 'Drone', 'Nectar', 'Sting', 'Comb', 'Wing'],
    b: ['Consensus', 'Increase', 'Hunger', 'Chorus', 'Mandible', 'Sovereign', 'Cell', 'Tithe'],
    c: ['of Ten Thousand', 'Unnumbered', 'of the Deep Comb', 'Ascendant'],
    pattern: 0,
  },
  reptilian: {
    a: ['Blood', 'Ember', 'Scale', 'Cinder', 'Tyrant', 'Molten', 'Basilisk', 'Ash', 'Wyrm', 'Crimson'],
    b: ['Tribute', 'Dominion', 'Fang', 'Decree', 'Coil', 'Ruin', 'Throne', 'Bargain', 'Maw'],
    c: ['of the Red Court', 'Unyielding', 'of Nine Suns', 'Enthroned'],
    pattern: 0,
  },
  federation: {
    a: ['Sentinel', 'Bulwark', 'Aegis', 'Concord', 'Vigil', 'Lantern', 'Anchor', 'Charter', 'Beacon'],
    b: ['Standard', 'Mandate', 'Warrant', 'Accord', 'Watch', 'Pattern', 'Compact', 'Resolve'],
    c: ['AR-7', 'SR-12', 'Issue III', 'Fleet Pattern', 'Reclaimed'],
    pattern: 1,
  },
};

export function rollWeaponName(faction: FactionId, rng: Rng): string {
  const bank = NAME_BANK[faction] ?? NAME_BANK.federation;
  const a = rng.pick(bank.a);
  const b = rng.pick(bank.b);
  const c = rng.pick(bank.c);
  // Two grammars: a kenning ("Frost Reckoning of Nine Winters") and a
  // designation ("Null Directive Mk. II"). Both read as proper nouns; neither
  // reads as a string concatenation, which is the failure mode to avoid.
  if (bank.pattern === 0) {
    const roll = rng.next();
    if (roll < 0.4) return `${a} ${b} ${c}`;
    // Compounding the two halves ("Frostfang", "Bloomscythe") is what makes a
    // generated name read as one word a person chose rather than two words a
    // machine joined.
    if (roll < 0.75) return `${a}${b.toLowerCase()}`;
    return `${a} ${b}`;
  }
  return rng.bool(0.55) ? `${a} ${b} ${c}` : `${a} ${b}`;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface WeaponItem {
  /** Stable instance id. */
  uid: string;
  /** Key into `WEAPONS`. */
  weaponId: string;
  slot: WeaponSlot;
  name: string;
  rarity: ItemRarity;
  element: DamageElement;
  faction: FactionId;
  perks: string[];
  power: number;
  /** Seed the roll came from, so a name can be regenerated deterministically. */
  seed: number;
  acquiredAt: number;
}

export interface PlanetProgress {
  visits: number;
  kills: number;
  cleared: boolean;
  bestScore: number;
}

interface SaveData {
  version: number;
  xp: number;
  level: number;
  totalKills: number;
  vault: WeaponItem[];
  equipped: [string, string, string];
  planets: Record<string, PlanetProgress>;
}

function emptyPlanets(): Record<string, PlanetProgress> {
  return {};
}

function defaultSave(): SaveData {
  return {
    version: SAVE_VERSION,
    xp: 0,
    level: 1,
    totalKills: 0,
    vault: [],
    equipped: ['autoRifle', 'pulseRifle', 'rocketLauncher'],
    planets: emptyPlanets(),
  };
}

export class Progression {
  private data: SaveData = defaultSave();
  private rng = new Rng((Date.now() ^ 0x5bd1e995) >>> 0);
  private dirty = false;
  private saveTimer = 0;
  /** True when the last load threw away an incompatible or corrupt save. */
  saveWasReset = false;

  constructor() {
    this.load();
  }

  // -- power / xp -----------------------------------------------------------

  get level(): number {
    return this.data.level;
  }

  get xp(): number {
    return this.data.xp;
  }

  get power(): number {
    return BASE_POWER + (this.data.level - 1) * POWER_PER_LEVEL;
  }

  /** 0..1 toward the next level. */
  get levelProgress(): number {
    if (this.data.level >= MAX_LEVEL) return 1;
    const need = xpForLevel(this.data.level);
    return clamp01(this.data.xp / need);
  }

  addXp(amount: number): void {
    if (amount <= 0 || this.data.level >= MAX_LEVEL) return;
    this.data.xp += amount;
    let levelled = false;
    while (this.data.level < MAX_LEVEL && this.data.xp >= xpForLevel(this.data.level)) {
      this.data.xp -= xpForLevel(this.data.level);
      this.data.level++;
      levelled = true;
    }
    if (levelled) {
      events.emit('ui:toast', {
        text: `POWER ${this.power}`,
        sub: `Guardian rank ${this.data.level}`,
        duration: 3.6,
      });
    }
    this.markDirty();
  }

  recordKill(planet: PlanetId | null, score: number): void {
    this.data.totalKills++;
    this.addXp(Math.max(1, Math.round(score * 0.6)));
    if (planet) {
      const p = this.planet(planet);
      p.kills++;
      p.bestScore = Math.max(p.bestScore, score);
    }
    this.markDirty();
  }

  get totalKills(): number {
    return this.data.totalKills;
  }

  // -- planets --------------------------------------------------------------

  planet(id: PlanetId): PlanetProgress {
    let p = this.data.planets[id];
    if (!p) {
      p = { visits: 0, kills: 0, cleared: false, bestScore: 0 };
      this.data.planets[id] = p;
    }
    return p;
  }

  visit(id: PlanetId): void {
    this.planet(id).visits++;
    this.markDirty();
  }

  markCleared(id: PlanetId, score: number): void {
    const p = this.planet(id);
    const first = !p.cleared;
    p.cleared = true;
    p.bestScore = Math.max(p.bestScore, score);
    this.addXp(first ? 1400 : 420);
    this.markDirty();
  }

  get clearedCount(): number {
    let n = 0;
    for (const k of Object.keys(this.data.planets)) if (this.data.planets[k].cleared) n++;
    return n;
  }

  // -- items ----------------------------------------------------------------

  rollRarity(luck = 0, rng: Rng = this.rng): ItemRarity {
    // `luck` skews the weights toward the top of the table without ever
    // guaranteeing anything — a boss should feel generous, not scripted.
    let total = 0;
    const weights: number[] = [];
    for (let i = 0; i < RARITY_ORDER.length; i++) {
      const r = RARITY_ORDER[i];
      const w = RARITY_WEIGHTS[r] * (1 + luck * i * 0.55);
      weights.push(w);
      total += w;
    }
    let roll = rng.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return RARITY_ORDER[i];
    }
    return 'common';
  }

  /** Generate a fully rolled weapon. `weaponId` must be a key of `WEAPONS`. */
  rollWeapon(
    weaponId: string,
    slot: WeaponSlot,
    element: DamageElement,
    faction: FactionId,
    rarity?: ItemRarity,
    luck = 0,
  ): WeaponItem {
    const seed = (this.rng.next() * 0xffffffff) >>> 0;
    const rng = new Rng(seed);
    const r = rarity ?? this.rollRarity(luck, rng);
    const perkCount = RARITY_PERKS[r];
    const perks: string[] = [];
    const pool = PERK_IDS.slice();
    for (let i = 0; i < perkCount && pool.length > 0; i++) {
      const idx = rng.int(0, pool.length - 1);
      perks.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return {
      uid: `${seed.toString(36)}-${(Date.now() % 0xffffff).toString(36)}`,
      weaponId,
      slot,
      name: rollWeaponName(faction, rng),
      rarity: r,
      element,
      faction,
      perks,
      power: clamp(this.power + RARITY_POWER_BONUS[r] + rng.int(-2, 2), 1, 400),
      seed,
      acquiredAt: Date.now(),
    };
  }

  addToVault(item: WeaponItem): WeaponItem {
    this.data.vault.push(item);
    // Keep the vault bounded; drop the least interesting commons first.
    if (this.data.vault.length > 60) {
      this.data.vault.sort((a, b) => {
        const ra = RARITY_ORDER.indexOf(a.rarity);
        const rb = RARITY_ORDER.indexOf(b.rarity);
        if (ra !== rb) return ra - rb;
        return a.acquiredAt - b.acquiredAt;
      });
      this.data.vault.splice(0, this.data.vault.length - 60);
    }
    this.markDirty();
    events.emit('ui:toast', {
      text: item.name.toUpperCase(),
      sub: `${item.rarity} · power ${item.power}`,
      rarity: item.rarity,
      duration: 4,
    });
    return item;
  }

  get vault(): readonly WeaponItem[] {
    return this.data.vault;
  }

  get equipped(): readonly [string, string, string] {
    return this.data.equipped;
  }

  equip(slot: 0 | 1 | 2, weaponId: string): void {
    this.data.equipped[slot] = weaponId;
    this.markDirty();
  }

  // -- persistence ----------------------------------------------------------

  private markDirty(): void {
    this.dirty = true;
  }

  /** Call from a frame hook; batches writes so a kill streak is one save. */
  tick(dt: number): void {
    if (!this.dirty) return;
    this.saveTimer += dt;
    if (this.saveTimer < 2) return;
    this.saveTimer = 0;
    this.save();
  }

  save(): void {
    this.dirty = false;
    try {
      localStorage.setItem(`${STORAGE_KEY}.v${SAVE_VERSION}`, JSON.stringify(this.data));
    } catch {
      /* storage blocked or full; the session keeps its in-memory state */
    }
  }

  private load(): void {
    this.saveWasReset = false;
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY}.v${SAVE_VERSION}`);
      if (!raw) {
        // Sweep any older-version keys so they do not accumulate forever.
        for (let v = 1; v < SAVE_VERSION; v++) {
          try {
            localStorage.removeItem(`${STORAGE_KEY}.v${v}`);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      if (!parsed || parsed.version !== SAVE_VERSION) throw new Error('version mismatch');
      const data = defaultSave();
      data.xp = numberOr(parsed.xp, 0);
      data.level = clamp(numberOr(parsed.level, 1), 1, MAX_LEVEL);
      data.totalKills = numberOr(parsed.totalKills, 0);
      data.vault = Array.isArray(parsed.vault) ? parsed.vault.filter(isWeaponItem) : [];
      if (
        Array.isArray(parsed.equipped) &&
        parsed.equipped.length === 3 &&
        parsed.equipped.every((s) => typeof s === 'string')
      ) {
        data.equipped = parsed.equipped as [string, string, string];
      }
      if (parsed.planets && typeof parsed.planets === 'object') {
        for (const [k, v] of Object.entries(parsed.planets)) {
          if (!v || typeof v !== 'object') continue;
          const p = v as Partial<PlanetProgress>;
          data.planets[k] = {
            visits: numberOr(p.visits, 0),
            kills: numberOr(p.kills, 0),
            cleared: !!p.cleared,
            bestScore: numberOr(p.bestScore, 0),
          };
        }
      }
      this.data = data;
    } catch {
      // A corrupt or foreign save is discarded, never repaired. Repairing is
      // how you ship a build that crashes on boot for exactly the players who
      // have the most to lose.
      this.data = defaultSave();
      this.saveWasReset = true;
      try {
        localStorage.removeItem(`${STORAGE_KEY}.v${SAVE_VERSION}`);
      } catch {
        /* ignore */
      }
    }
  }

  /** Wipe everything. Exposed for the settings menu and for tests. */
  reset(): void {
    this.data = defaultSave();
    this.save();
  }

  /** Snapshot for the UI and for debugging. */
  summary(): {
    level: number;
    power: number;
    xp: number;
    toNext: number;
    kills: number;
    vault: number;
    cleared: number;
    wasReset: boolean;
  } {
    return {
      level: this.data.level,
      power: this.power,
      xp: this.data.xp,
      toNext: this.data.level >= MAX_LEVEL ? 0 : xpForLevel(this.data.level),
      kills: this.data.totalKills,
      vault: this.data.vault.length,
      cleared: this.clearedCount,
      wasReset: this.saveWasReset,
    };
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function isWeaponItem(v: unknown): v is WeaponItem {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<WeaponItem>;
  return (
    typeof o.uid === 'string' &&
    typeof o.weaponId === 'string' &&
    typeof o.name === 'string' &&
    typeof o.power === 'number' &&
    Array.isArray(o.perks)
  );
}

export const progression = new Progression();
