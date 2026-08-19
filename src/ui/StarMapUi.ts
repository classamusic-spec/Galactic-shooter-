/**
 * StarMapUi — the orbital overlay.
 *
 * Deliberately *not* a full-screen modal: the 3D star map is the hero, so the
 * chrome lives in two side columns and leaves the middle of the frame clear.
 * The world's `StarMap` installs `UiRoot.onTravel`, which this panel invokes
 * from SET COURSE — the UI never touches the level loader itself.
 *
 * ## Two things this panel is responsible for beyond picking a world
 *
 * **Campaign shape.** `recommendedPower` used to be printed as a number and
 * compared to nothing, and `CAMPAIGN_ORDER` had no readers at all, so every
 * world was selectable from the first second of a new save and clearing one
 * changed nothing on screen. The list now reads `progression.power` and
 * `progression.planet(id).cleared` and renders three states — LOCKED, the
 * available chapter, CLEARED — plus a *warning*, never a wall, when the player
 * is under the recommended power. Under-levelling is a choice with consequences;
 * a locked chapter is a chapter you have not reached yet.
 *
 * **Loadout.** Two of the three subclasses, and two of the three grenades in
 * each, were unreachable because nothing ever called `setSubclass` or
 * `cycleGrenade`. The left column carries an explicit picker for both. It writes
 * to `@/gameplay/abilities/Loadout`, which persists the choice and notifies
 * `AbilitySystem` — the UI never holds a reference to a gameplay system.
 *
 * ## Styling
 *
 * The tokens, the 1 px hairlines and the cut-corner clip path all come from
 * `ui.css.ts`. That file belongs to another owner, so the handful of rules the
 * gated/loadout rows need are injected from here instead, written entirely in
 * terms of the same custom properties (`--u`, `--accent`, `--gold`, `--red`,
 * `--text-faint`, `--cut`) so the two stylesheets cannot drift apart visually.
 */
import type { PlanetDescriptor, PlanetId } from '@/types';
import { CAMPAIGN_ORDER, PLANET_BY_ID } from '@/world/planets';
import { progression } from '@/gameplay/Progression';
import { GRENADES, SUBCLASSES, type SubclassId } from '@/gameplay/abilities/Definitions';
import { loadout } from '@/gameplay/abilities/Loadout';
import { events } from '@/core/EventBus';
import { buildSigil } from './LoadingScreen';
import { ELEMENT_COLOR, FACTION_COLOR, FACTION_SPECIES, THREAT_WORDS } from './ui.css';
import { div, interactive, span, StyleBind, svg, TextBind, toggle } from './dom';

/** Chapter numerals. The star map is the only place a chapter number appears. */
const NUMERAL = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

const SUBCLASS_IDS: readonly SubclassId[] = ['solar', 'arc', 'void'];

export interface WorldGate {
  /** 1-based position in `CAMPAIGN_ORDER`. */
  chapter: number;
  locked: boolean;
  cleared: boolean;
  /** The chapter that has to be cleared first; null for chapter one. */
  requires: PlanetDescriptor | null;
  /** True when the player's power is below the recommendation. */
  underPower: boolean;
  deficit: number;
}

/**
 * The campaign gate: a world opens when the chapter before it is cleared.
 *
 * Pure, and deliberately cheap — it is called for every row on every selection
 * change. `src/world/StarMap.ts` enforces the same rule at the travel choke
 * point; see the note there about why the predicate is stated twice rather than
 * shared (the natural home, `world/planets/index.ts`, is another owner's file).
 */
export function worldGate(id: PlanetId): WorldGate {
  const index = CAMPAIGN_ORDER.indexOf(id);
  const chapter = index < 0 ? 1 : index + 1;
  const previous = index > 0 ? PLANET_BY_ID[CAMPAIGN_ORDER[index - 1]] : null;
  const locked = previous ? !progression.planet(previous.id).cleared : false;
  const rec = PLANET_BY_ID[id]?.recommendedPower ?? 0;
  const deficit = Math.max(0, rec - progression.power);
  return {
    chapter,
    locked,
    cleared: progression.planet(id).cleared,
    requires: locked ? previous : null,
    underPower: deficit > 0,
    deficit,
  };
}

interface PlanetRow {
  node: HTMLButtonElement;
  id: PlanetId;
  power: TextBind;
  tag: TextBind;
  lock: SVGSVGElement;
  check: SVGSVGElement;
}

interface KitRow {
  node: HTMLButtonElement;
  kind: 'subclass' | 'grenade';
  /** Subclass id, or the grenade's index within the equipped subclass. */
  key: string;
  name: TextBind;
  sub: TextBind;
}

/** Which column the cursor is in. Left/right switches; up/down moves within. */
type Column = 'worlds' | 'kit';

export class StarMapUi {
  visible = false;
  private padPrompts = false;

  private readonly root: HTMLElement;
  private readonly rows: PlanetRow[] = [];
  private readonly kit: KitRow[] = [];
  private readonly onTravel: (id: PlanetId) => void;

  private readonly sigilHost: HTMLElement;
  private readonly dossier: HTMLElement;
  private readonly dName: TextBind;
  private readonly dSub: TextBind;
  private readonly dChapter: TextBind;
  private readonly dDesc: TextBind;
  private readonly dSpecies: TextBind;
  private readonly dFaction: TextBind;
  private readonly dPower: TextBind;
  private readonly dYourPower: TextBind;
  private readonly dThreat: TextBind;
  private readonly banner: HTMLElement;
  private readonly bannerText: TextBind;
  private readonly threatPips: HTMLElement[] = [];
  private readonly accent: StyleBind;
  private readonly courseBtn: HTMLButtonElement;
  private readonly courseLabel: TextBind;
  private readonly foot: TextBind;
  private readonly kitCap: HTMLElement;
  private readonly unsubs: Array<() => void> = [];

  private index = 0;
  private kitIndex = 0;
  private column: Column = 'worlds';
  private activeId: string | null = null;
  private pending: PlanetId | null = null;

  constructor(parent: HTMLElement, onTravel: (id: PlanetId) => void) {
    this.onTravel = onTravel;
    injectGateCss();
    this.root = div('gf-starmap', parent);
    this.accent = new StyleBind(this.root, '--accent');

    const head = div('gf-starmap-head', this.root);
    div('gf-starmap-kicker', head).textContent = 'Federation Vanguard · Orbital Command';
    div('gf-starmap-title', head).textContent = 'The Ophiuchus Reach';

    // -- left column: the campaign, then the kit ----------------------------
    const rail = div('gf-starmap-rail', this.root);
    const list = div('gf-starmap-list', rail);
    div('gf-starmap-cap', list).textContent = 'Charted Worlds';
    for (const id of CAMPAIGN_ORDER) {
      const p = PLANET_BY_ID[id];
      if (!p) continue;
      this.rows.push(this.buildPlanetRow(list, p));
    }

    const kitBox = div('gf-starmap-kit', rail);
    this.kitCap = div('gf-starmap-cap', kitBox);
    this.kitCap.textContent = 'Subclass';
    for (const id of SUBCLASS_IDS) this.kit.push(this.buildKitRow(kitBox, 'subclass', id));
    div('gf-starmap-cap is-tight', kitBox).textContent = 'Grenade';
    for (let i = 0; i < 3; i++) this.kit.push(this.buildKitRow(kitBox, 'grenade', String(i)));

    // -- right column: the dossier ------------------------------------------
    this.dossier = div('gf-dossier', this.root);
    const dHead = div('gf-dossier-head', this.dossier);
    this.sigilHost = div('gf-sigil is-small', dHead);
    const dTitles = div('gf-dossier-titles', dHead);
    this.dChapter = new TextBind(div('gf-dossier-chapter', dTitles));
    this.dName = new TextBind(div('gf-dossier-name', dTitles));
    this.dSub = new TextBind(div('gf-dossier-sub', dTitles));
    div('gf-dossier-rule', this.dossier);

    this.banner = div('gf-gate-banner', this.dossier);
    this.bannerText = new TextBind(span('gf-gate-banner-text', this.banner));

    this.dDesc = new TextBind(div('gf-dossier-desc', this.dossier));

    const grid = div('gf-dossier-grid', this.dossier);
    this.dFaction = this.stat(grid, 'Faction');
    this.dSpecies = this.stat(grid, 'Species');
    this.dPower = this.stat(grid, 'Recommended Power');
    this.dYourPower = this.stat(grid, 'Your Power');
    this.dThreat = this.stat(grid, 'Threat Assessment');

    const threat = div('gf-threat', this.dossier);
    for (let i = 0; i < 5; i++) this.threatPips.push(div('gf-threat-pip', threat));

    this.courseBtn = interactive(document.createElement('button'));
    this.courseBtn.type = 'button';
    this.courseBtn.className = 'gf-btn is-primary is-wide';
    this.courseLabel = new TextBind(this.courseBtn);
    this.courseBtn.addEventListener('click', () => {
      this.column = 'worlds';
      this.activate();
    });
    this.dossier.appendChild(this.courseBtn);

    this.foot = new TextBind(div('gf-starmap-foot', this.root));

    // The gate is derived from progression, so it has to be recomputed whenever
    // progression moves. `campaign:unlocked` has no emitter yet — subscribing
    // now means the campaign layer's emitter arrives with a subscriber already
    // in place rather than another write nothing reads.
    this.unsubs.push(
      events.on('mission:completed', () => this.refresh()),
      events.on('campaign:unlocked', () => this.refresh()),
      loadout.onChange(() => this.refreshKit()),
    );

    this.refresh();
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  private buildPlanetRow(list: HTMLElement, p: PlanetDescriptor): PlanetRow {
    const node = interactive(document.createElement('button'));
    node.type = 'button';
    node.className = 'gf-planet';
    node.style.setProperty('--accent', FACTION_COLOR[p.faction]);

    const dot = div('gf-planet-dot');
    const text = div('gf-planet-text');
    const name = div('gf-planet-name');
    name.textContent = p.displayName;
    const sub = div('gf-planet-sub');
    sub.textContent = p.subtitle;
    text.append(name, sub);

    const right = div('gf-planet-mark');
    const power = new TextBind(div('gf-planet-power', right));
    const lock = lockGlyph();
    const check = checkGlyph();
    right.append(lock, check);
    const tag = new TextBind(div('gf-planet-tag', right));

    node.append(dot, text, right);
    const select = (): void => {
      this.column = 'worlds';
      this.index = this.rows.findIndex((r) => r.id === p.id);
      this.select();
    };
    node.addEventListener('click', select);
    node.addEventListener('mouseenter', select);
    list.appendChild(node);
    return { node, id: p.id, power, tag, lock, check };
  }

  private buildKitRow(box: HTMLElement, kind: KitRow['kind'], key: string): KitRow {
    const node = interactive(document.createElement('button'));
    node.type = 'button';
    node.className = 'gf-planet is-kit';
    const dot = div('gf-planet-dot');
    const text = div('gf-planet-text');
    const name = new TextBind(div('gf-planet-name', text));
    const sub = new TextBind(div('gf-planet-sub', text));
    node.append(dot, text);
    const row: KitRow = { node, kind, key, name, sub };
    const focus = (): void => {
      this.column = 'kit';
      this.kitIndex = this.kit.indexOf(row);
      this.select();
    };
    node.addEventListener('mouseenter', focus);
    node.addEventListener('click', () => {
      focus();
      this.activate();
    });
    box.appendChild(node);
    return row;
  }

  private stat(grid: HTMLElement, label: string): TextBind {
    const cell = div('gf-stat', grid);
    div('gf-stat-cap', cell).textContent = label;
    return new TextBind(div('gf-stat-val', cell));
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Called when a level loads so the list can mark where the player is. */
  setActive(levelId: string): void {
    this.activeId = levelId;
    this.refresh();
  }

  /** Recompute every gated row. Cheap: five rows of integer comparisons. */
  private refresh(): void {
    for (const r of this.rows) {
      const g = worldGate(r.id);
      toggle(r.node, 'is-here', r.id === this.activeId);
      toggle(r.node, 'is-locked', g.locked);
      toggle(r.node, 'is-cleared', !g.locked && g.cleared);
      toggle(r.node, 'is-under', !g.locked && !g.cleared && g.underPower);
      r.lock.style.display = g.locked ? '' : 'none';
      r.check.style.display = !g.locked && g.cleared ? '' : 'none';
      const rec = PLANET_BY_ID[r.id]?.recommendedPower ?? 0;
      r.power.set(g.locked ? '' : String(rec));
      r.tag.set(
        g.locked
          ? 'Locked'
          : r.id === this.activeId
            ? 'Current'
            : g.cleared
              ? 'Cleared'
              : g.underPower
                ? 'Low Power'
                : `Chapter ${NUMERAL[g.chapter - 1] ?? g.chapter}`,
      );
    }
    this.refreshKit();
    this.select();
  }

  private refreshKit(): void {
    const equipped = loadout.subclass;
    const sub = SUBCLASSES[equipped];
    for (const row of this.kit) {
      if (row.kind === 'subclass') {
        const s = SUBCLASSES[row.key as SubclassId];
        row.node.style.setProperty('--accent', ELEMENT_COLOR[s.element]);
        row.name.set(s.displayName);
        row.sub.set(s.element.toUpperCase());
        toggle(row.node, 'is-equipped', s.id === equipped);
      } else {
        const i = Number(row.key);
        const g = GRENADES[sub.grenades[i]] ?? GRENADES['grenade.frag'];
        row.node.style.setProperty('--accent', ELEMENT_COLOR[g.element]);
        row.name.set(g.displayName);
        row.sub.set(`${g.splashDamage} blast · ${g.cooldown.toFixed(0)}s`);
        toggle(row.node, 'is-equipped', i === loadout.grenadeIndex);
      }
    }
    this.kitCap.textContent = `Subclass · ${sub.displayName}`;
  }

  private select(): void {
    const worlds = this.column === 'worlds';
    for (let i = 0; i < this.rows.length; i++)
      toggle(this.rows[i].node, 'is-active', worlds && i === this.index);
    for (let i = 0; i < this.kit.length; i++)
      toggle(this.kit[i].node, 'is-active', !worlds && i === this.kitIndex);

    const row = this.rows[this.index];
    const p = row ? PLANET_BY_ID[row.id] : undefined;
    if (!p) return;
    const gate = worldGate(p.id);

    this.accent.set(FACTION_COLOR[p.faction]);
    buildSigil(this.sigilHost, p.faction);
    this.dChapter.set(`Chapter ${NUMERAL[gate.chapter - 1] ?? gate.chapter}`);
    this.dName.set(p.displayName);
    this.dSub.set(p.subtitle);
    this.dDesc.set(p.description);
    this.dFaction.set(p.faction.toUpperCase());
    this.dSpecies.set(FACTION_SPECIES[p.faction]);
    this.dPower.set(String(p.recommendedPower));
    this.dYourPower.set(String(progression.power));
    const level = Math.max(1, Math.min(5, Math.round(p.recommendedPower / 45)));
    this.dThreat.set(THREAT_WORDS[level - 1]);
    for (let i = 0; i < this.threatPips.length; i++) toggle(this.threatPips[i], 'is-on', i < level);

    // -- the status band ----------------------------------------------------
    // One line, always present, and its colour alone says which of the four
    // states this world is in — that is what lets the list read without a
    // legend.
    const here = this.activeId === p.id;
    toggle(this.banner, 'is-locked', gate.locked);
    toggle(this.banner, 'is-warn', !gate.locked && gate.underPower);
    toggle(this.banner, 'is-cleared', !gate.locked && !gate.underPower && gate.cleared);
    if (gate.locked) {
      this.bannerText.set(`Locked · clear ${gate.requires?.displayName ?? 'the previous chapter'} first`);
    } else if (gate.underPower) {
      this.bannerText.set(`Under-levelled by ${gate.deficit} · they will hit harder than you do`);
    } else if (gate.cleared) {
      const best = progression.planet(p.id).bestScore;
      this.bannerText.set(best > 0 ? `Cleared · best score ${best}` : 'Cleared');
    } else {
      this.bannerText.set('Cleared for approach');
    }

    // The button is the only affordance telling the player how to commit, so it
    // names the actual control: the Cross glyph on a pad, nothing on a mouse
    // where clicking it is self-evident.
    const glyph = this.padPrompts ? '✕   ' : '';
    const label = gate.locked
      ? 'Locked'
      : here
        ? 'You Are Here'
        : gate.underPower
          ? `${glyph}Set Course Anyway`
          : `${glyph}Set Course`;
    this.courseLabel.set(label);
    toggle(this.courseBtn, 'is-disabled', gate.locked || here || this.pending !== null);
    toggle(this.courseBtn, 'is-warn', !gate.locked && !here && gate.underPower);

    this.foot.set(
      this.padPrompts
        ? '↕ select      ↔ worlds / loadout      ✕ confirm      ○ close'
        : '↑↓ select      ←→ worlds / loadout      Enter confirm      Esc close',
    );
  }

  /** Swap the course prompt between mouse and PlayStation glyphs. */
  setDevice(pad: boolean): void {
    if (this.padPrompts === pad) return;
    this.padPrompts = pad;
    this.select();
  }

  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.pending = null;
    toggle(this.root, 'is-on', true);
    // Land the cursor on something useful: the first world that is open and not
    // yet cleared, which is where the campaign actually is.
    const next = this.rows.findIndex((r) => {
      const g = worldGate(r.id);
      return !g.locked && !g.cleared;
    });
    if (next >= 0) this.index = next;
    this.column = 'worlds';
    this.refresh();
  }

  close(pending?: PlanetId): void {
    this.pending = pending ?? null;
    this.visible = false;
    toggle(this.root, 'is-on', false);
  }

  nav(delta: number): void {
    if (this.column === 'kit') {
      this.kitIndex = (this.kitIndex + delta + this.kit.length) % this.kit.length;
    } else {
      this.index = (this.index + delta + this.rows.length) % this.rows.length;
    }
    this.select();
  }

  /** Left/right switches column. Up/down moves inside it. */
  navX(delta: number): void {
    if (delta === 0) return;
    this.column = delta > 0 ? 'kit' : 'worlds';
    this.select();
  }

  activate(): void {
    if (this.column === 'kit') {
      const row = this.kit[this.kitIndex];
      if (!row) return;
      if (row.kind === 'subclass') loadout.setSubclass(row.key as SubclassId);
      else loadout.setGrenadeIndex(Number(row.key));
      return;
    }
    const row = this.rows[this.index];
    const p = row ? PLANET_BY_ID[row.id] : undefined;
    if (!p || this.activeId === p.id || this.pending) return;
    const gate = worldGate(p.id);
    if (gate.locked) {
      // Refused here as well as at the travel choke point in `world/StarMap`,
      // so the player gets the reason rather than a dead button.
      events.emit('ui:toast', {
        text: 'CHAPTER LOCKED',
        sub: `Clear ${gate.requires?.displayName ?? 'the previous chapter'} first`,
        duration: 3.2,
      });
      return;
    }
    this.pending = p.id;
    this.courseLabel.set('Plotting…');
    toggle(this.courseBtn, 'is-disabled', true);
    this.onTravel(p.id);
  }

  render(_dt: number): void {
    /* CSS transitions only */
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/** Padlock. Square shackle and square body — no rounded corners anywhere. */
function lockGlyph(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 16 16', class: 'gf-gate-glyph is-lock' });
  svg('path', { d: 'M4.6 7V5.2A3.4 3.4 0 0 1 11.4 5.2V7', class: 'gf-gate-stroke' }, s);
  svg('path', { d: 'M2.8 7.4h10.4v6.4H2.8z', class: 'gf-gate-fill' }, s);
  svg('path', { d: 'M8 9.2v2.8', class: 'gf-gate-stroke is-thick' }, s);
  return s;
}

/** Clear mark: a check inside the same cut-corner frame the panels use. */
function checkGlyph(): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 16 16', class: 'gf-gate-glyph is-check' });
  svg('path', { d: 'M2.6 4.4 5 2h8.4v9.6L11 14H2.6z', class: 'gf-gate-frame' }, s);
  svg('path', { d: 'm4.8 8.1 2.3 2.4 4.2-4.9', class: 'gf-gate-stroke is-thick' }, s);
  return s;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * The gated-row and loadout rules.
 *
 * `ui.css.ts` is another owner's file, so rather than edit it these are injected
 * once from here. Everything below is expressed in the tokens that stylesheet
 * defines, uses its 1 px hairline weight, and repeats its cut-corner polygon
 * verbatim, so a change to `--u` or `--accent` moves both together.
 */
const GATE_CSS = `
.gf-starmap-rail {
  position: absolute;
  left: var(--pad-x);
  top: 50%;
  transform: translateY(-50%);
  width: calc(var(--u) * 22);
  display: flex;
  flex-direction: column;
  gap: calc(var(--u) * 1.1);
}
.gf-starmap-rail .gf-starmap-list {
  position: static;
  transform: none;
  width: auto;
}
.gf-starmap-kit { display: flex; flex-direction: column; gap: calc(var(--u) * 0.32); }
.gf-starmap-cap.is-tight { margin-top: calc(var(--u) * 0.55); }

/* -- the right-hand cell of a world row --------------------------------- */
.gf-planet-mark {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: calc(var(--u) * 0.05);
  min-width: calc(var(--u) * 3.4);
}
.gf-planet-tag {
  font-size: calc(var(--u) * 0.52);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--text-faint);
  white-space: nowrap;
}
.gf-planet.is-here .gf-planet-tag { color: var(--gold); }
.gf-planet.is-cleared .gf-planet-tag { color: var(--gold); }
.gf-planet.is-under .gf-planet-tag { color: var(--red); }
.gf-planet.is-under .gf-planet-power { color: var(--red); }

.gf-gate-glyph { width: calc(var(--u) * 1.15); height: calc(var(--u) * 1.15); overflow: visible; }
.gf-gate-stroke { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: square; }
.gf-gate-stroke.is-thick { stroke-width: 1.9; }
.gf-gate-fill { fill: currentColor; opacity: 0.22; stroke: currentColor; stroke-width: 1.2; }
.gf-gate-frame { fill: none; stroke: currentColor; stroke-width: 1.2; opacity: 0.55; }
.gf-gate-glyph.is-lock { color: var(--text-faint); }
.gf-gate-glyph.is-check { color: var(--gold); }

/* -- locked ------------------------------------------------------------- */
.gf-planet.is-locked {
  background: rgba(6, 11, 18, 0.6);
  box-shadow: inset 0 0 0 1px rgba(120, 180, 220, 0.09);
}
.gf-planet.is-locked .gf-planet-name,
.gf-planet.is-locked .gf-planet-sub { color: var(--text-faint); }
.gf-planet.is-locked .gf-planet-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--text-faint);
}
/* Hatching, not just a dim fill: a greyed row can read as a rendering bug,
   whereas diagonal hatch reads as "deliberately not available". */
.gf-planet.is-locked::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    -45deg, rgba(120, 160, 195, 0.07) 0 1px, transparent 1px 7px);
}
.gf-planet.is-locked:hover { background: rgba(9, 16, 25, 0.72); }
.gf-planet.is-locked.is-active {
  box-shadow: inset 0 0 0 1px rgba(150, 185, 215, 0.5);
  transform: translateX(calc(var(--u) * 0.3));
}

/* -- cleared ------------------------------------------------------------ */
.gf-planet.is-cleared .gf-planet-dot {
  box-shadow: 0 0 calc(var(--u) * 0.7) var(--accent), 0 0 0 2px rgba(255, 196, 107, 0.55);
}
.gf-planet.is-cleared .gf-planet-power { color: var(--text-faint); }

/* -- kit rows ----------------------------------------------------------- */
.gf-planet.is-kit { padding: calc(var(--u) * 0.36) calc(var(--u) * 0.8); }
.gf-planet.is-kit .gf-planet-name { font-size: calc(var(--u) * 0.86); }
.gf-planet.is-kit .gf-planet-sub { font-size: calc(var(--u) * 0.58); }
.gf-planet.is-kit .gf-planet-dot {
  width: calc(var(--u) * 0.5);
  height: calc(var(--u) * 0.5);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--accent);
}
.gf-planet.is-kit.is-equipped .gf-planet-dot {
  background: var(--accent);
  box-shadow: 0 0 calc(var(--u) * 0.7) var(--accent);
}
.gf-planet.is-kit.is-equipped {
  background: rgba(14, 30, 46, 0.85);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.gf-planet.is-kit.is-equipped .gf-planet-name { color: var(--accent); }

/* -- dossier additions --------------------------------------------------- */
.gf-dossier-chapter {
  font-size: calc(var(--u) * 0.6);
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: calc(var(--u) * 0.1);
}
.gf-gate-banner {
  --cut: calc(var(--u) * 0.42);
  display: flex;
  align-items: center;
  padding: calc(var(--u) * 0.38) calc(var(--u) * 0.7);
  margin-bottom: calc(var(--u) * 0.85);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
  clip-path: polygon(
    0 var(--cut), var(--cut) 0, 100% 0,
    100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%);
}
.gf-gate-banner-text {
  font-size: calc(var(--u) * 0.64);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent);
}
.gf-gate-banner.is-locked { background: rgba(120, 160, 195, 0.08); box-shadow: inset 0 0 0 1px rgba(150, 185, 215, 0.35); }
.gf-gate-banner.is-locked .gf-gate-banner-text { color: var(--text-dim); }
.gf-gate-banner.is-warn { background: rgba(255, 90, 76, 0.12); box-shadow: inset 0 0 0 1px rgba(255, 90, 76, 0.55); }
.gf-gate-banner.is-warn .gf-gate-banner-text { color: var(--red); }
.gf-gate-banner.is-cleared { background: rgba(255, 196, 107, 0.1); box-shadow: inset 0 0 0 1px rgba(255, 196, 107, 0.5); }
.gf-gate-banner.is-cleared .gf-gate-banner-text { color: var(--gold); }
.gf-btn.is-primary.is-warn {
  background: linear-gradient(180deg, #ffb9ac, #ff7a68);
  color: #2a0703;
}
.gf-btn.is-primary.is-warn:hover { background: linear-gradient(180deg, #ffd0c6, #ff8f7e); }
`;

let cssInjected = false;

function injectGateCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const tag = document.createElement('style');
  tag.id = 'gf-starmap-gate-css';
  tag.textContent = GATE_CSS;
  document.head.appendChild(tag);
}
