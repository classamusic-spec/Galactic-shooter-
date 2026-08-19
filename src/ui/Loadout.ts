/**
 * Loadout — the screen where the vault stops being a database and becomes a
 * decision.
 *
 * Everything the player earns is a `WeaponItem` in `progression.vault`. Until
 * this screen existed there was no path from that array to the three weapons in
 * their hands: `WeaponSystem.setWeapon` had no callers and `progression.equip`
 * had none either, so the entire loot loop terminated in storage nobody could
 * open. This is the other end of that wire.
 *
 * Three rules it follows:
 *
 * 1. **It is a subscriber, like the rest of the UI.** It reads `progression`
 *    (there is no event that can carry a vault) but it never touches the weapon
 *    system: equipping writes the choice to the save and emits
 *    `loadout:changed`, and `WeaponSystem` — which owns the guns — applies it.
 * 2. **Rarity is the primary read.** A drop is worth walking to because of the
 *    colour on it, so the colour comes from `RARITY_COLOR` in `Progression`,
 *    the same table the pickup light and the toast use. One item, one colour,
 *    everywhere.
 * 3. **It uses the existing language.** `gf-modal`, `gf-panel`, `gf-tabs`,
 *    `gf-row`, the same cut corners and cyan hairlines as the settings and
 *    pause menus, and the same `nav`/`navX`/`activate` interface `UiRoot`
 *    drives from both the keyboard and a pad.
 */
import type { ItemRarity, WeaponSlot } from '@/types';
import { events } from '@/core/EventBus';
import { RARITY_COLOR, RARITY_ORDER, progression, type WeaponItem } from '@/gameplay/Progression';
import { DEFAULT_LOADOUT, SLOT_ORDER, WEAPONS } from '@/gameplay/weapons/WeaponDefs';
import { PERKS } from '@/gameplay/weapons/Perks';
import { ELEMENT_COLOR, RARITY_LABEL } from './ui.css';
import { div, interactive, prettifyId, StyleBind, TextBind, toggle } from './dom';

const SLOT_LABEL: Record<WeaponSlot, string> = {
  kinetic: 'Kinetic',
  energy: 'Energy',
  power: 'Power',
};

/** Footer legend, per input device. See PauseMenu.setDevice for the reasoning. */
const HINTS = {
  key: 'Arrows ↑↓ — select      ← → — slot      Enter — equip      Esc — back',
  pad: 'D-pad ↑↓ — select      ← → — slot      ✕ — equip      ○ — back',
} as const;

/** `0x4d80f0` → `#4d80f0`. The vault speaks in numbers; CSS does not. */
export function rarityCss(rarity: ItemRarity): string {
  return `#${(RARITY_COLOR[rarity] ?? 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * The rolled identity behind an equipped weapon id, or null when the slot holds
 * a plain catalogue gun.
 *
 * `weapon:swapped` can only carry a weapon *id*, so the HUD has no way to learn
 * that the auto rifle in the player's hands is actually "Frostfang, Legendary".
 * This is the lookup that closes that gap; `UiRoot.applyWeapon` calls it.
 */
export function equippedMeta(weaponId: string): WeaponItem | null {
  for (let i = 0; i < 3; i++) {
    const item = progression.equippedItem(i as 0 | 1 | 2);
    if (item && item.weaponId === weaponId) return item;
  }
  return null;
}

/** The catalogue slot an item belongs in — authoritative over `item.slot`. */
function slotOf(item: WeaponItem): WeaponSlot {
  return WEAPONS[item.weaponId]?.slot ?? item.slot;
}

interface Entry {
  node: HTMLButtonElement;
  /** null = the stock catalogue weapon for this slot. */
  item: WeaponItem | null;
  weaponId: string;
}

export class Loadout {
  visible = false;

  private readonly root: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly tabs: HTMLButtonElement[] = [];
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly hint: TextBind;
  private readonly count: TextBind;

  // -- detail column ---------------------------------------------------------
  private readonly detail: HTMLElement;
  private readonly dAccent: StyleBind;
  private readonly dName: TextBind;
  private readonly dSub: TextBind;
  private readonly dPower: TextBind;
  private readonly dElement: TextBind;
  private readonly dFrame: TextBind;
  private readonly dRarity: TextBind;
  private readonly perkList: HTMLElement;
  private readonly equipBtn: HTMLButtonElement;
  private readonly equipLabel: TextBind;

  private entries: Entry[] = [];
  private slotIndex: 0 | 1 | 2 = 0;
  private index = 0;
  private padPrompts = false;
  /** uids decoded this session and not yet looked at. */
  private fresh = new Set<string>();
  private readonly unbind: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = div('gf-modal gf-loadout', parent);
    interactive(div('gf-modal-backdrop', this.root));

    const panel = interactive(div('gf-panel is-loadout', this.root));
    const head = div('gf-panel-head', panel);
    div('gf-panel-kicker', head).textContent = 'Vanguard Armoury · Vault Access';
    div('gf-panel-title', head).textContent = 'Loadout';
    div('gf-panel-rule', panel);

    const body = div('gf-loadout-body', panel);
    this.rail = div('gf-tabs', body);
    for (let i = 0; i < 3; i++) {
      const tab = interactive(document.createElement('button'));
      tab.className = 'gf-tab';
      tab.type = 'button';
      tab.textContent = SLOT_LABEL[SLOT_ORDER[i]];
      tab.addEventListener('click', () => this.setSlot(i as 0 | 1 | 2));
      this.rail.appendChild(tab);
      this.tabs.push(tab);
    }

    const listCol = div('gf-loadout-col', body);
    this.list = div('gf-loadout-list', listCol);
    this.empty = div('gf-loadout-empty', listCol);
    this.empty.textContent =
      'No rolls for this slot yet. Engrams decode when a mission ends.';

    this.detail = div('gf-loadout-detail', body);
    this.dAccent = new StyleBind(this.detail, '--rarity');
    this.dName = new TextBind(div('gf-loadout-name', this.detail));
    this.dSub = new TextBind(div('gf-loadout-sub', this.detail));
    div('gf-dossier-rule', this.detail);
    const grid = div('gf-dossier-grid', this.detail);
    this.dPower = this.stat(grid, 'Power');
    this.dElement = this.stat(grid, 'Element');
    this.dRarity = this.stat(grid, 'Rarity');
    this.dFrame = this.stat(grid, 'Frame');
    div('gf-loadout-cap', this.detail).textContent = 'Traits';
    this.perkList = div('gf-loadout-perks', this.detail);

    this.equipBtn = interactive(document.createElement('button'));
    this.equipBtn.type = 'button';
    this.equipBtn.className = 'gf-btn is-primary is-wide';
    this.equipLabel = new TextBind(this.equipBtn);
    this.equipBtn.addEventListener('click', () => this.activate());
    this.detail.appendChild(this.equipBtn);

    const foot = div('gf-panel-foot is-split', panel);
    this.hint = new TextBind(div('gf-foot-hint', foot));
    this.count = new TextBind(div('gf-loadout-count', foot));
    this.setDevice(false);

    // A decode that lands while the screen is open should show up in it, and a
    // decode that lands while it is closed should still be flagged as new when
    // the player next opens it. This is the subscriber for `engram:decoded`.
    this.unbind.push(
      events.on('engram:decoded', (p) => {
        this.fresh.add(p.uid);
        if (this.visible) this.rebuild();
      }),
    );

    this.setSlot(0);
  }

  private stat(grid: HTMLElement, label: string): TextBind {
    const cell = div('gf-stat', grid);
    div('gf-stat-cap', cell).textContent = label;
    return new TextBind(div('gf-stat-val', cell));
  }

  // -- data ------------------------------------------------------------------

  /** Vault rolls for the active slot, best first, plus the stock weapon. */
  private rebuild(): void {
    const slot = SLOT_ORDER[this.slotIndex];
    const keep = this.entries[this.index];
    const keepUid = keep?.item?.uid ?? '';

    this.list.textContent = '';
    this.entries = [];

    const rolls = progression.vault
      .filter((v) => slotOf(v) === slot)
      .slice()
      .sort((a, b) => {
        if (a.rarity !== b.rarity) {
          return rarityRank(b.rarity) - rarityRank(a.rarity);
        }
        if (b.power !== a.power) return b.power - a.power;
        return b.acquiredAt - a.acquiredAt;
      });

    for (const item of rolls) this.addEntry(item, item.weaponId);
    // The stock gun always sits at the bottom, so "put it back how it was" is
    // never more than one keypress away from being visible.
    this.addEntry(null, DEFAULT_LOADOUT[this.slotIndex]);

    toggle(this.empty, 'is-on', rolls.length === 0);
    this.count.set(`Vault ${progression.vault.length} · Pending ${progression.pendingEngrams.length}`);

    const again = keepUid ? this.entries.findIndex((e) => e.item?.uid === keepUid) : -1;
    this.index = again >= 0 ? again : 0;
    this.select();
  }

  private addEntry(item: WeaponItem | null, weaponId: string): void {
    const def = WEAPONS[weaponId];
    const rarity: ItemRarity = item?.rarity ?? def?.rarity ?? 'common';
    const node = interactive(document.createElement('button'));
    node.type = 'button';
    node.className = 'gf-loadout-item';
    node.style.setProperty('--rarity', rarityCss(rarity));

    div('gf-loadout-pip', node);
    const text = div('gf-loadout-text', node);
    const name = div('gf-loadout-item-name', text);
    name.textContent = (item?.name ?? def?.displayName ?? prettifyId(weaponId)).toUpperCase();
    const sub = div('gf-loadout-item-sub', text);
    sub.textContent = item
      ? `${RARITY_LABEL[rarity]} · ${prettifyId(def?.family ?? weaponId)}`
      : `Standard Issue · ${prettifyId(def?.family ?? weaponId)}`;
    const power = div('gf-loadout-item-power', node);
    power.textContent = item ? String(item.power) : '—';
    const held = div('gf-loadout-item-held', node);
    held.textContent = 'Equipped';
    if (item && this.fresh.has(item.uid)) div('gf-loadout-item-new', node).textContent = 'New';

    const entry: Entry = { node, item, weaponId };
    node.addEventListener('click', () => {
      const i = this.entries.indexOf(entry);
      if (i < 0) return;
      // A second click on an already-selected row equips it, which is what a
      // mouse player expects and what the pad does with one button.
      if (this.index === i) this.activate();
      else {
        this.index = i;
        this.select();
      }
    });
    node.addEventListener('mouseenter', () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0 && i !== this.index) {
        this.index = i;
        this.select();
      }
    });
    this.list.appendChild(node);
    this.entries.push(entry);
  }

  private select(): void {
    const equippedUid = progression.equippedUids[this.slotIndex];
    const equippedId = progression.equipped[this.slotIndex];
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      toggle(e.node, 'is-active', i === this.index);
      const isHeld = e.item ? e.item.uid === equippedUid : !equippedUid && e.weaponId === equippedId;
      toggle(e.node, 'is-held', isHeld);
    }
    const cur = this.entries[this.index];
    if (!cur) return;
    if (cur.item) this.fresh.delete(cur.item.uid);
    cur.node.scrollIntoView({ block: 'nearest' });

    const def = WEAPONS[cur.weaponId];
    const rarity: ItemRarity = cur.item?.rarity ?? def?.rarity ?? 'common';
    const element = cur.item?.element ?? def?.element ?? 'kinetic';
    this.dAccent.set(rarityCss(rarity));
    this.dName.set((cur.item?.name ?? def?.displayName ?? prettifyId(cur.weaponId)).toUpperCase());
    this.dSub.set(
      cur.item
        ? `${RARITY_LABEL[rarity]} ${prettifyId(def?.family ?? cur.weaponId)}`
        : 'Standard Issue',
    );
    this.dPower.set(cur.item ? String(cur.item.power) : '—');
    this.dElement.set(element.toUpperCase());
    this.dRarity.set(RARITY_LABEL[rarity]);
    this.dFrame.set(def?.displayName ?? prettifyId(cur.weaponId));
    this.detail.style.setProperty('--el', ELEMENT_COLOR[element]);

    this.perkList.textContent = '';
    const perks = cur.item?.perks ?? def?.perks ?? [];
    // An unknown perk id is skipped, never rendered as a raw string: the roll
    // may predate a change to the perk pool, and a blank row reads as a bug.
    let shown = 0;
    for (const id of perks) {
      const perk = PERKS[id];
      if (!perk) continue;
      const row = div('gf-loadout-perk', this.perkList);
      div('gf-loadout-perk-name', row).textContent = perk.name;
      div('gf-loadout-perk-desc', row).textContent = perk.description;
      shown++;
    }
    if (shown === 0) div('gf-loadout-perk-none', this.perkList).textContent = 'No traits rolled.';

    const isHeld = cur.item
      ? cur.item.uid === equippedUid
      : !equippedUid && cur.weaponId === equippedId;
    this.equipLabel.set(isHeld ? 'Equipped' : this.padPrompts ? '✕   Equip' : 'Equip');
    toggle(this.equipBtn, 'is-disabled', isHeld);
  }

  private setSlot(i: 0 | 1 | 2): void {
    this.slotIndex = i;
    for (let t = 0; t < this.tabs.length; t++) toggle(this.tabs[t], 'is-on', t === i);
    this.index = 0;
    this.rebuild();
  }

  // -- navigation ------------------------------------------------------------

  nav(delta: number): void {
    const n = this.entries.length;
    if (n === 0) return;
    this.index = (this.index + delta + n) % n;
    this.select();
  }

  navX(delta: number): void {
    this.setSlot((((this.slotIndex + delta + 3) % 3) as 0 | 1 | 2));
  }

  activate(): void {
    const cur = this.entries[this.index];
    if (!cur) return;
    const slot = this.slotIndex;
    if (cur.item) {
      if (!progression.equipItem(slot, cur.item)) return;
    } else {
      progression.equip(slot, cur.weaponId, '');
    }
    // Gameplay owns the guns; this screen owns the choice. `WeaponSystem`
    // subscribes to this event and rebuilds the slot from the saved item.
    events.emit('loadout:changed', { slot, weaponId: cur.weaponId });
    progression.save();
    this.select();
  }

  /** Swap the prompts between keyboard and PlayStation glyphs. */
  setDevice(pad: boolean): void {
    this.hint.set(pad ? HINTS.pad : HINTS.key);
    if (this.padPrompts === pad) return;
    this.padPrompts = pad;
    if (this.visible) this.select();
  }

  open(): void {
    if (this.visible) return;
    this.visible = true;
    toggle(this.root, 'is-on', true);
    this.rebuild();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    toggle(this.root, 'is-on', false);
  }

  render(_dt: number): void {
    /* CSS handles the transitions */
  }

  dispose(): void {
    for (const off of this.unbind) off();
    this.unbind.length = 0;
    this.root.remove();
  }
}

/** Ladder position, straight off `RARITY_ORDER` — no second table. */
function rarityRank(r: ItemRarity): number {
  return RARITY_ORDER.indexOf(r);
}
