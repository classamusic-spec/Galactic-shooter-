/**
 * StarMapUi — the orbital overlay.
 *
 * Deliberately *not* a full-screen modal: the 3D star map is the hero, so the
 * chrome lives in two side columns and leaves the middle of the frame clear.
 * The world's `StarMap` installs `UiRoot.onTravel`, which this panel invokes
 * from SET COURSE — the UI never touches the level loader itself.
 */
import type { PlanetId } from '@/types';
import { PLANETS } from '@/world/planets';
import { buildSigil } from './LoadingScreen';
import { FACTION_COLOR, FACTION_SPECIES, THREAT_WORDS } from './ui.css';
import { div, interactive, StyleBind, TextBind, toggle } from './dom';

interface PlanetRow {
  node: HTMLElement;
  id: PlanetId;
}

export class StarMapUi {
  visible = false;

  private readonly root: HTMLElement;
  private readonly rows: PlanetRow[] = [];
  private readonly onTravel: (id: PlanetId) => void;

  private readonly sigilHost: HTMLElement;
  private readonly dossier: HTMLElement;
  private readonly dName: TextBind;
  private readonly dSub: TextBind;
  private readonly dDesc: TextBind;
  private readonly dSpecies: TextBind;
  private readonly dFaction: TextBind;
  private readonly dPower: TextBind;
  private readonly dThreat: TextBind;
  private readonly threatPips: HTMLElement[] = [];
  private readonly accent: StyleBind;
  private readonly courseBtn: HTMLButtonElement;
  private readonly courseLabel: TextBind;

  private index = 0;
  private activeId: string | null = null;
  private pending: PlanetId | null = null;

  constructor(parent: HTMLElement, onTravel: (id: PlanetId) => void) {
    this.onTravel = onTravel;
    this.root = div('gf-starmap', parent);
    this.accent = new StyleBind(this.root, '--accent');

    const head = div('gf-starmap-head', this.root);
    div('gf-starmap-kicker', head).textContent = 'Federation Vanguard · Orbital Command';
    div('gf-starmap-title', head).textContent = 'The Ophiuchus Reach';

    const list = div('gf-starmap-list', this.root);
    div('gf-starmap-cap', list).textContent = 'Charted Worlds';
    for (const p of PLANETS) {
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
      const power = div('gf-planet-power');
      power.textContent = `${p.recommendedPower}`;
      const here = div('gf-planet-here');
      here.textContent = 'Current';
      node.append(dot, text, power, here);
      node.addEventListener('click', () => {
        this.index = this.rows.findIndex((r) => r.id === p.id);
        this.select();
      });
      node.addEventListener('mouseenter', () => {
        this.index = this.rows.findIndex((r) => r.id === p.id);
        this.select();
      });
      list.appendChild(node);
      this.rows.push({ node, id: p.id });
    }

    this.dossier = div('gf-dossier', this.root);
    const dHead = div('gf-dossier-head', this.dossier);
    this.sigilHost = div('gf-sigil is-small', dHead);
    const dTitles = div('gf-dossier-titles', dHead);
    this.dName = new TextBind(div('gf-dossier-name', dTitles));
    this.dSub = new TextBind(div('gf-dossier-sub', dTitles));
    div('gf-dossier-rule', this.dossier);
    this.dDesc = new TextBind(div('gf-dossier-desc', this.dossier));

    const grid = div('gf-dossier-grid', this.dossier);
    this.dFaction = this.stat(grid, 'Faction');
    this.dSpecies = this.stat(grid, 'Species');
    this.dPower = this.stat(grid, 'Recommended Power');
    this.dThreat = this.stat(grid, 'Threat Assessment');

    const threat = div('gf-threat', this.dossier);
    for (let i = 0; i < 5; i++) this.threatPips.push(div('gf-threat-pip', threat));

    this.courseBtn = interactive(document.createElement('button'));
    this.courseBtn.type = 'button';
    this.courseBtn.className = 'gf-btn is-primary is-wide';
    this.courseLabel = new TextBind(this.courseBtn);
    this.courseBtn.addEventListener('click', () => this.activate());
    this.dossier.appendChild(this.courseBtn);

    div('gf-starmap-foot', this.root).textContent =
      'Arrows — select world      Enter / A — set course      Esc — close';

    this.select();
  }

  private stat(grid: HTMLElement, label: string): TextBind {
    const cell = div('gf-stat', grid);
    div('gf-stat-cap', cell).textContent = label;
    return new TextBind(div('gf-stat-val', cell));
  }

  /** Called when a level loads so the list can mark where the player is. */
  setActive(levelId: string): void {
    this.activeId = levelId;
    for (const r of this.rows) toggle(r.node, 'is-here', r.id === levelId);
  }

  private select(): void {
    const p = PLANETS[this.index];
    if (!p) return;
    for (let i = 0; i < this.rows.length; i++) toggle(this.rows[i].node, 'is-active', i === this.index);
    this.accent.set(FACTION_COLOR[p.faction]);
    buildSigil(this.sigilHost, p.faction);
    this.dName.set(p.displayName);
    this.dSub.set(p.subtitle);
    this.dDesc.set(p.description);
    this.dFaction.set(p.faction.toUpperCase());
    this.dSpecies.set(FACTION_SPECIES[p.faction]);
    this.dPower.set(String(p.recommendedPower));
    const level = Math.max(1, Math.min(5, Math.round(p.recommendedPower / 45)));
    this.dThreat.set(THREAT_WORDS[level - 1]);
    for (let i = 0; i < this.threatPips.length; i++) toggle(this.threatPips[i], 'is-on', i < level);
    const here = this.activeId === p.id;
    this.courseLabel.set(here ? 'You Are Here' : 'Set Course');
    toggle(this.courseBtn, 'is-disabled', here || this.pending !== null);
  }

  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.pending = null;
    toggle(this.root, 'is-on', true);
    this.select();
  }

  close(pending?: PlanetId): void {
    this.pending = pending ?? null;
    this.visible = false;
    toggle(this.root, 'is-on', false);
  }

  nav(delta: number): void {
    this.index = (this.index + delta + PLANETS.length) % PLANETS.length;
    this.select();
  }

  navX(delta: number): void {
    this.nav(delta);
  }

  activate(): void {
    const p = PLANETS[this.index];
    if (!p || this.activeId === p.id || this.pending) return;
    this.pending = p.id;
    this.courseLabel.set('Plotting…');
    toggle(this.courseBtn, 'is-disabled', true);
    this.onTravel(p.id);
  }

  render(_dt: number): void {
    /* CSS transitions only */
  }

  dispose(): void {
    this.root.remove();
  }
}
