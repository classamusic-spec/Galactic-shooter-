/**
 * MissionResults — the debrief.
 *
 * This is the payoff screen, and it is the one place in this interface where
 * *slow is correct*. Everywhere else the HUD is racing the player: the rule in
 * `docs/ARCHITECTURE.md` is a response inside 80 ms. Here the opposite applies
 * — a score that snaps to its final value has already finished before the
 * player's eye reaches it, and a reward the player did not watch arrive is not
 * a reward. So the numbers count, the decoded weapons land one at a time, and
 * the best one lands last.
 *
 * The screen is reconstructed entirely from the event stream, like the rest of
 * the UI. `mission:completed` carries the score, the kills and the clock;
 * `mission:started` carries the title and the world; `engram:decoded` arrives
 * whenever a drop finishes decoding during the run and is banked here until the
 * debrief opens. Nothing is polled and nothing is imported from gameplay.
 *
 * Failure gets the same frame with almost everything stripped out of it. The
 * story bible's handler is terse and slightly overworked; a losing screen that
 * tallies statistics is a losing screen that gloats.
 */
import type { ItemRarity, PlanetId } from '@/types';
import { events } from '@/core/EventBus';
import { PLANETS } from '@/world/planets';
import { buildSigil } from './LoadingScreen';
import { FACTION_COLOR, RARITY_COLOR, RARITY_LABEL } from './ui.css';
import { clamp01 } from '@/util/math';
import {
  div,
  easeOutCubic,
  interactive,
  prettifyId,
  StyleBind,
  TextBind,
  toggle,
} from './dom';

export interface ResultsActions {
  /** Leave the world. Wired to the same path the pause menu's orbit item uses. */
  orbit(): void;
}

/**
 * Reveal order. `RARITY_COLOR` is keyed, not ordered, and the reveal has to
 * finish on the best thing in the run — so the ranking is explicit.
 */
const RARITY_RANK: Record<ItemRarity, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  legendary: 3,
  exotic: 4,
};

/**
 * UI-local mission titles, the same trick `UiRoot`'s weapon lexicon uses.
 * `mission:started` currently carries the planet's display name in `title`
 * because no campaign module owns the mission table yet; when the two match,
 * the two-word campaign name from `docs/STORY.md` is the better label. As soon
 * as a real `MissionDef.title` starts arriving it wins automatically.
 */
const MISSION_TITLE: Record<PlanetId, string> = {
  aurvangr: 'Cold Contract',
  'zeta-reticuli': 'Silent Archive',
  khepri: 'Green Rot',
  'hive-prime': 'The Count',
  'draco-ix': 'Iron Choir',
};

/** Footer legend per device. See `PauseMenu.setDevice` for why this exists. */
const HINTS = {
  key: 'Enter — select      Arrows — navigate      Esc — dismiss',
  pad: '✕ — select      D-pad — navigate',
} as const;

// -- reveal timeline (seconds from open) ------------------------------------
/** The panel's own transform settles first; nothing counts under a moving box. */
const COUNT_AT = 0.34;
const SCORE_TIME = 1.55;
const KILL_TIME = 1.05;
const CLOCK_TIME = 1.05;
/** Stagger between the three readouts so they do not land as one event. */
const STAT_STEP = 0.16;
const LOOT_AT = 2.05;
const LOOT_STEP = 0.42;
/** Rows are pooled; anything past this is summarised instead. */
const LOOT_ROWS = 5;

interface Decoded {
  name: string;
  rarity: ItemRarity;
  weaponId: string;
}

interface LootRow {
  node: HTMLElement;
  name: TextBind;
  family: TextBind;
  tag: TextBind;
  color: StyleBind;
}

interface Action {
  node: HTMLButtonElement;
  run(): void;
}

export class MissionResults {
  visible = false;

  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly accent: StyleBind;
  private readonly sigilHost: HTMLElement;
  private readonly kicker: TextBind;
  private readonly title: TextBind;
  private readonly sub: TextBind;
  private readonly stamp: TextBind;
  private readonly stampNode: HTMLElement;
  private readonly scoreVal: TextBind;
  private readonly killVal: TextBind;
  private readonly clockVal: TextBind;
  private readonly objVal: TextBind;
  private readonly lootCap: TextBind;
  private readonly lootEmpty: HTMLElement;
  private readonly lootMore: TextBind;
  private readonly rows: LootRow[] = [];
  private readonly note: TextBind;
  private readonly actions: Action[] = [];
  private readonly foot: TextBind;
  private readonly unbind: (() => void)[] = [];
  private readonly trapKeys: (ev: KeyboardEvent) => void;

  // -- run state, accumulated between mission:started and mission:completed --
  private planet: PlanetId = 'aurvangr';
  private missionTitle = '';
  private chapter = 1;
  private decoded: Decoded[] = [];
  private objectives = 0;

  // -- presentation state ---------------------------------------------------
  private t = 0;
  private failed = false;
  private score = 0;
  private kills = 0;
  private seconds = 0;
  private shownRows = 0;
  private index = 0;
  /** Set while the player is down; the death screen owns that moment, not this. */
  private dead = false;
  /** Seconds a suppressed failure has been waiting for a respawn that never came. */
  private pendingFail = -1;

  constructor(parent: HTMLElement, actions: ResultsActions) {
    this.root = div('gf-modal gf-results', parent);
    interactive(div('gf-modal-backdrop', this.root));
    div('gf-results-grid-bg', this.root);

    this.panel = interactive(div('gf-panel is-results', this.root));
    this.accent = new StyleBind(this.panel, '--accent');

    const head = div('gf-results-head', this.panel);
    this.sigilHost = div('gf-sigil is-small', head);
    const titles = div('gf-results-titles', head);
    this.kicker = new TextBind(div('gf-panel-kicker', titles));
    this.title = new TextBind(div('gf-panel-title', titles));
    this.sub = new TextBind(div('gf-results-sub', titles));
    this.stampNode = div('gf-results-stamp', head);
    this.stamp = new TextBind(this.stampNode);

    div('gf-panel-rule', this.panel);

    const body = div('gf-results-body', this.panel);
    const scoreBlock = div('gf-results-score', body);
    div('gf-results-score-cap', scoreBlock).textContent = 'Score';
    this.scoreVal = new TextBind(div('gf-results-score-val', scoreBlock));
    div('gf-results-score-rule', scoreBlock);

    const rail = div('gf-results-rail', body);
    this.killVal = this.stat(rail, 'Kills');
    this.clockVal = this.stat(rail, 'Time');
    this.objVal = this.stat(rail, 'Objectives');

    this.note = new TextBind(div('gf-results-note', this.panel));

    const loot = div('gf-results-loot', this.panel);
    this.lootCap = new TextBind(div('gf-results-cap', loot));
    this.lootEmpty = div('gf-results-empty', loot);
    this.lootEmpty.textContent = 'No engrams decoded this run';
    for (let i = 0; i < LOOT_ROWS; i++) {
      const node = div('gf-loot-row', loot);
      div('gf-loot-edge', node);
      const text = div('gf-loot-body', node);
      const name = new TextBind(div('gf-loot-name', text));
      const family = new TextBind(div('gf-loot-family', text));
      const tag = new TextBind(div('gf-loot-tag', node));
      this.rows.push({ node, name, family, tag, color: new StyleBind(node, '--r') });
    }
    this.lootMore = new TextBind(div('gf-results-more', loot));

    const row = div('gf-results-actions', this.panel);
    this.add(row, 'Return to Orbit', true, () => {
      this.hide();
      actions.orbit();
    });
    this.add(row, 'Dismiss', false, () => this.hide());

    this.foot = new TextBind(div('gf-panel-foot', this.panel));
    this.setDevice(false);

    this.bindEvents();

    // Escape is claimed here rather than in UiRoot so the debrief owns its own
    // dismissal; without stopping propagation the same press would also pause
    // the game underneath it.
    this.trapKeys = (ev: KeyboardEvent): void => {
      if (!this.visible) return;
      if (ev.code === 'Escape' || ev.code === 'Backspace') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        this.hide();
      } else if (ev.key === 'Tab') {
        ev.preventDefault();
        this.nav(ev.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', this.trapKeys, { capture: true });
  }

  // -- construction helpers --------------------------------------------------

  private stat(parent: HTMLElement, label: string): TextBind {
    const cell = div('gf-stat', parent);
    div('gf-stat-cap', cell).textContent = label;
    return new TextBind(div('gf-stat-val', cell));
  }

  private add(parent: HTMLElement, label: string, primary: boolean, run: () => void): void {
    const node = interactive(document.createElement('button'));
    node.type = 'button';
    node.className = `gf-btn${primary ? ' is-primary' : ''}`;
    node.textContent = label;
    node.addEventListener('click', () => {
      this.index = this.actions.findIndex((a) => a.node === node);
      this.highlight();
      run();
    });
    node.addEventListener('mouseenter', () => {
      this.index = this.actions.findIndex((a) => a.node === node);
      this.highlight();
    });
    parent.appendChild(node);
    this.actions.push({ node, run });
  }

  // -- event wiring ----------------------------------------------------------

  private bindEvents(): void {
    const on = <K extends keyof import('@/core/EventBus').GameEvents>(
      key: K,
      fn: (p: import('@/core/EventBus').GameEvents[K]) => void,
    ): void => {
      this.unbind.push(events.on(key, fn));
    };

    on('mission:started', (p) => {
      this.hide();
      this.planet = p.planet;
      this.chapter = p.chapter;
      // A title equal to the world's own name means no mission table is
      // supplying one yet; fall back to the campaign name for that world.
      const world = PLANETS.find((x) => x.id === p.planet);
      this.missionTitle =
        p.title && p.title !== world?.displayName ? p.title : MISSION_TITLE[p.planet];
      this.decoded = [];
      this.objectives = 0;
      this.pendingFail = -1;
    });

    on('engram:decoded', (p) => {
      if (this.decoded.length < 32) {
        this.decoded.push({ name: p.name, rarity: p.rarity, weaponId: p.weaponId });
      }
    });

    on('objective:completed', () => {
      this.objectives++;
    });

    on('mission:completed', (p) => {
      this.planet = p.planet;
      this.score = p.score;
      this.kills = p.kills;
      this.seconds = p.seconds;
      this.show(false, p.firstClear);
    });

    on('mission:failed', (p) => {
      this.planet = p.planet;
      // A death the player respawns out of is not a failed mission, and the
      // death screen already owns that moment — two full-screen panels over one
      // event is the bug, not the feature. Hold the card while the body is
      // down; `player:respawn` cancels it, and only a death nobody comes back
      // from ever promotes it to the screen.
      if (this.dead) {
        this.pendingFail = 0;
        return;
      }
      this.show(true, false);
    });

    on('player:died', () => {
      this.dead = true;
    });
    on('player:respawn', () => {
      this.dead = false;
      this.pendingFail = -1;
    });

    // Leaving the world takes the debrief with it.
    on('level:loaded', () => this.hide());
  }

  // -- open / close ----------------------------------------------------------

  private show(failed: boolean, firstClear: boolean): void {
    const world = PLANETS.find((x) => x.id === this.planet);
    const faction = world?.faction ?? 'federation';
    this.failed = failed;
    this.t = 0;
    this.index = 0;
    this.pendingFail = -1;

    this.accent.set(failed ? '#ff5a4c' : FACTION_COLOR[faction]);
    buildSigil(this.sigilHost, faction);
    toggle(this.root, 'is-failed', failed);

    this.title.set(this.missionTitle || MISSION_TITLE[this.planet]);
    this.sub.set(`${world?.displayName ?? 'The Reach'} · Chapter ${this.chapter}`);

    if (failed) {
      this.kicker.set('Vanguard Telemetry · Signal Lost');
      this.stamp.set('Mission Lost');
      this.note.set(
        `Withdrawn from ${world?.displayName ?? 'the surface'}. No clear recorded.`,
      );
      this.shownRows = 0;
    } else {
      this.kicker.set('Federation Vanguard · Debrief');
      this.stamp.set(firstClear ? 'First Clear' : 'Mission Complete');
      this.note.set('');
      this.scoreVal.set('0');
      this.killVal.set('0');
      this.clockVal.set(fmtClock(0));
      this.objVal.set('0');
      this.fillLoot();
    }
    toggle(this.stampNode, 'is-first', firstClear && !failed);

    this.visible = true;
    toggle(this.root, 'is-on', true);
    this.highlight();
  }

  /** Sort ascending by rarity so the run's best roll is the last thing revealed. */
  private fillLoot(): void {
    const list = this.decoded
      .slice()
      .sort((a, b) => RARITY_RANK[a.rarity] - RARITY_RANK[b.rarity]);
    this.shownRows = Math.min(list.length, LOOT_ROWS);
    this.lootCap.set(list.length === 1 ? 'Engram Decoded' : 'Engrams Decoded');
    toggle(this.lootEmpty, 'is-on', list.length === 0);
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const item = i < this.shownRows ? list[i] : null;
      toggle(row.node, 'is-live', item !== null);
      toggle(row.node, 'is-in', false);
      if (!item) continue;
      row.name.set(item.name.toUpperCase());
      row.family.set(prettifyId(item.weaponId));
      row.tag.set(RARITY_LABEL[item.rarity]);
      row.color.set(RARITY_COLOR[item.rarity]);
      toggle(row.node, 'is-exotic', item.rarity === 'exotic');
      toggle(row.node, 'is-legendary', item.rarity === 'legendary');
    }
    const extra = list.length - this.shownRows;
    this.lootMore.set(extra > 0 ? `+${extra} more in the vault` : '');
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.pendingFail = -1;
    toggle(this.root, 'is-on', false);
    (document.activeElement as HTMLElement | null)?.blur();
  }

  /** Swap the footer legend and the primary prompt between keyboard and pad. */
  setDevice(pad: boolean): void {
    this.foot.set(pad ? HINTS.pad : HINTS.key);
    // The primary button names the actual control, exactly as SET COURSE does
    // on the star map: a prompt for a device the player is not holding is worse
    // than no prompt at all.
    const primary = this.actions[0];
    if (primary) primary.node.textContent = pad ? '✕   Return to Orbit' : 'Return to Orbit';
  }

  // -- navigation ------------------------------------------------------------

  nav(delta: number): void {
    // Touching the controls at all means "I have seen enough" — the reveal
    // finishes on the spot rather than making the player wait out an animation
    // they have already decided to skip.
    this.settle();
    const n = this.actions.length;
    this.index = (this.index + delta + n) % n;
    this.highlight();
  }

  navX(delta: number): void {
    this.nav(delta);
  }

  activate(): void {
    this.settle();
    this.actions[this.index]?.run();
  }

  private highlight(): void {
    for (let i = 0; i < this.actions.length; i++) {
      toggle(this.actions[i].node, 'is-focus', i === this.index);
    }
    this.actions[this.index]?.node.focus({ preventScroll: true });
  }

  /** Jump the reveal to its end state. */
  private settle(): void {
    const end = LOOT_AT + this.shownRows * LOOT_STEP + 0.4;
    if (this.t < end) this.t = end;
  }

  // -- frame -----------------------------------------------------------------

  render(dt: number): void {
    // A failure held back by the death screen only reaches the screen if nobody
    // ever gets up. The death screen's own countdown is shorter than this, so
    // in practice an ordinary death never sees this card — which is the point.
    if (this.pendingFail >= 0) {
      this.pendingFail += dt;
      if (this.pendingFail > 6.5) this.show(true, false);
    }
    if (!this.visible) return;
    this.t += dt;
    if (this.failed) return;

    const t = this.t;
    const p = (start: number, len: number): number => easeOutCubic(clamp01((t - start) / len));
    this.scoreVal.set(groupInt(Math.round(this.score * p(COUNT_AT, SCORE_TIME))));
    this.killVal.set(String(Math.round(this.kills * p(COUNT_AT + STAT_STEP, KILL_TIME))));
    this.clockVal.set(fmtClock(this.seconds * p(COUNT_AT + STAT_STEP * 2, CLOCK_TIME)));
    this.objVal.set(String(Math.round(this.objectives * p(COUNT_AT + STAT_STEP * 3, KILL_TIME))));

    for (let i = 0; i < this.shownRows; i++) {
      toggle(this.rows[i].node, 'is-in', t >= LOOT_AT + i * LOOT_STEP);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.trapKeys, { capture: true });
    for (const off of this.unbind) off();
    this.unbind.length = 0;
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------

/** `12480` → `12,480`. Tabular numerals keep the width stable while it counts. */
function groupInt(v: number): string {
  const n = Math.max(0, Math.round(v));
  const s = String(n);
  if (s.length < 4) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

/** `401.4` → `6:41`; over an hour it grows a third field rather than wrapping. */
function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (v: number): string => (v < 10 ? `0${v}` : String(v));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
