/**
 * The persisted half of the Guardian's kit: which subclass is equipped, and
 * which grenade is equipped *within* each subclass.
 *
 * Why this is a separate module rather than a field on `AbilitySystem`:
 *
 * 1. **It has to survive a mission.** `AbilitySystem` is constructed once and
 *    lives across level changes, so an in-memory field would survive travel —
 *    but not a reload, and a player who picks Void, flies to Khepri, dies to a
 *    browser refresh and comes back a Sunbreaker has been told their choice did
 *    not matter.
 * 2. **The chooser is not the owner.** The star map picks the subclass; the
 *    ability system applies it. Neither may import the other (`ui` subscribes,
 *    `gameplay` emits), so the choice lives in a third place both can hold.
 *    This is deliberately *not* an `EventBus` event — the bus is a published
 *    contract and this is a two-party handshake, so it gets a plain listener
 *    list instead of a new global event name.
 *
 * `Progression` would be the natural home, but it is another owner's file and
 * has no key/value surface to borrow, so this keeps its own tiny store under its
 * own versioned key. See the report: folding this into `Progression`'s save is
 * the right long-term shape.
 */
import { SUBCLASSES, type SubclassId } from './Definitions';

const STORAGE_KEY = 'gf.loadout.v1';

const SUBCLASS_IDS: readonly SubclassId[] = ['solar', 'arc', 'void'];

export function isSubclassId(v: unknown): v is SubclassId {
  return typeof v === 'string' && (SUBCLASS_IDS as readonly string[]).includes(v);
}

interface LoadoutData {
  subclass: SubclassId;
  /** Chosen grenade index, per subclass, into `Subclass.grenades`. */
  grenade: Record<SubclassId, number>;
}

function defaults(): LoadoutData {
  return { subclass: 'solar', grenade: { solar: 0, arc: 0, void: 0 } };
}

/** Clamp an index into a subclass's grenade list. */
function clampGrenade(id: SubclassId, index: number): number {
  const n = SUBCLASSES[id].grenades.length;
  if (!Number.isFinite(index)) return 0;
  const i = Math.floor(index);
  return i < 0 || i >= n ? 0 : i;
}

export class SubclassLoadout {
  private data: LoadoutData = defaults();
  private listeners: Array<() => void> = [];

  constructor() {
    this.load();
  }

  get subclass(): SubclassId {
    return this.data.subclass;
  }

  /** Grenade index for the equipped subclass. */
  get grenadeIndex(): number {
    return this.data.grenade[this.data.subclass];
  }

  grenadeIndexFor(id: SubclassId): number {
    return this.data.grenade[id];
  }

  /** Id of the equipped grenade, for the HUD and the star-map panel. */
  get grenadeId(): string {
    const sub = SUBCLASSES[this.data.subclass];
    return sub.grenades[this.grenadeIndex] ?? sub.grenades[0];
  }

  setSubclass(id: SubclassId): boolean {
    if (!isSubclassId(id) || id === this.data.subclass) return false;
    this.data.subclass = id;
    this.save();
    this.notify();
    return true;
  }

  setGrenadeIndex(index: number): boolean {
    const i = clampGrenade(this.data.subclass, index);
    if (i === this.grenadeIndex) return false;
    this.data.grenade[this.data.subclass] = i;
    this.save();
    this.notify();
    return true;
  }

  /** Next grenade in the equipped subclass's list; returns the new index. */
  cycleGrenade(delta = 1): number {
    const n = SUBCLASSES[this.data.subclass].grenades.length;
    const next = (((this.grenadeIndex + delta) % n) + n) % n;
    this.data.grenade[this.data.subclass] = next;
    this.save();
    this.notify();
    return next;
  }

  /**
   * Subscribe to changes. Returns the unsubscribe. Listeners fire after the
   * store has already committed, so a listener may read back freely.
   */
  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notify(): void {
    // Iterate a copy: a listener that unsubscribes itself must not shorten the
    // list mid-walk.
    const list = this.listeners.slice();
    for (const fn of list) fn();
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* storage blocked or full; the session keeps its in-memory choice */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<LoadoutData>;
      const next = defaults();
      if (isSubclassId(parsed?.subclass)) next.subclass = parsed.subclass;
      const g = parsed?.grenade;
      if (g && typeof g === 'object') {
        for (const id of SUBCLASS_IDS) next.grenade[id] = clampGrenade(id, (g as Record<string, number>)[id]);
      }
      this.data = next;
    } catch {
      // Same policy as the progression save: a foreign or corrupt record is
      // discarded rather than repaired.
      this.data = defaults();
    }
  }

  /** Back to Sunbreaker with default grenades. For the settings reset path. */
  reset(): void {
    this.data = defaults();
    this.save();
    this.notify();
  }
}

export const loadout = new SubclassLoadout();
