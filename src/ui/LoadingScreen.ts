/**
 * LoadingScreen — the transit card.
 *
 * `Game` hands us a free-text label ("Approaching Aurvangr", "Entering orbit"),
 * which is matched against the planet table to pull the real subtitle, faction
 * and flavour text. The faction sigil is drawn from parametric SVG primitives —
 * no image, no font glyph, no external asset.
 */
import type { FactionId } from '@/types';
import { PLANETS } from '@/world/planets';
import { FACTION_COLOR, FACTION_NAME } from './ui.css';
import { div, polyPath, StyleBind, svg, TextBind, toggle } from './dom';
import { clamp01 } from '@/util/math';

const FLAVOUR: Record<FactionId, string> = {
  federation: 'Vanguard transit corridor clear. Weapons free on arrival.',
  nordic: 'Rune-forged steel and a cold that eats through plate. Move fast, stay warm.',
  grey: 'They have been cataloguing this system since before we had a word for it.',
  mantis: 'They hunt from the canopy. If you can hear them, you are already late.',
  insectoid: 'There is no leadership to decapitate. Only the nest, and how much of it you burn.',
  reptilian: 'Old blood, old grudges, and a fortress cut into the shield volcano.',
};

export class LoadingScreen {
  visible = false;

  private readonly root: HTMLElement;
  private readonly kicker: TextBind;
  private readonly title: TextBind;
  private readonly sub: TextBind;
  private readonly flavour: TextBind;
  private readonly status: TextBind;
  private readonly percent: TextBind;
  private readonly fill: StyleBind;
  private readonly accent: StyleBind;
  private readonly sigilHost: HTMLElement;

  private target = 0;
  private shown = 0;

  constructor(parent: HTMLElement) {
    this.root = div('gf-loading', parent);
    this.root.setAttribute('data-interactive', '');
    this.accent = new StyleBind(this.root, '--accent');
    div('gf-loading-grid', this.root);
    div('gf-loading-scan', this.root);

    const inner = div('gf-loading-inner', this.root);
    this.sigilHost = div('gf-sigil', inner);
    this.kicker = new TextBind(div('gf-loading-kicker', inner));
    this.title = new TextBind(div('gf-loading-title', inner));
    this.sub = new TextBind(div('gf-loading-sub', inner));
    this.flavour = new TextBind(div('gf-loading-flavour', inner));

    const barRow = div('gf-loading-barrow', inner);
    const bar = div('gf-loading-bar', barRow);
    this.fill = new StyleBind(div('gf-loading-fill', bar), 'width');
    div('gf-loading-sheen', bar);
    this.percent = new TextBind(div('gf-loading-pct', barRow));
    this.status = new TextBind(div('gf-loading-status', inner));

    buildSigil(this.sigilHost, 'federation');
  }

  show(on: boolean, label: string): void {
    this.visible = on;
    toggle(this.root, 'is-on', on);
    if (!on) return;
    this.target = 0;
    this.shown = 0;
    this.fill.num(0, '%');
    this.apply(label);
  }

  setProgress(t: number, label: string): void {
    this.target = clamp01(t);
    if (label) this.status.set(label.toUpperCase());
  }

  private apply(label: string): void {
    const lower = label.toLowerCase();
    const planet = PLANETS.find((p) => lower.includes(p.displayName.toLowerCase()));
    if (planet) {
      this.kicker.set('Federation Vanguard · Planetfall');
      this.title.set(planet.displayName);
      this.sub.set(planet.subtitle);
      this.flavour.set(FLAVOUR[planet.faction]);
      this.accent.set(FACTION_COLOR[planet.faction]);
      buildSigil(this.sigilHost, planet.faction);
    } else {
      this.kicker.set('Federation Vanguard · Transit');
      this.title.set('The Ophiuchus Reach');
      this.sub.set('Orbital Command · Vanguard Division');
      this.flavour.set(FLAVOUR.federation);
      this.accent.set(FACTION_COLOR.federation);
      buildSigil(this.sigilHost, 'federation');
    }
    this.status.set(label.toUpperCase());
    this.percent.set('0%');
  }

  render(dt: number): void {
    if (!this.visible) return;
    // Ease toward the reported progress so a single 0 → 0.6 jump still reads
    // as motion rather than a teleport.
    this.shown += (this.target - this.shown) * Math.min(1, dt * 6);
    if (this.target >= 1 && this.shown > 0.995) this.shown = 1;
    this.fill.num(this.shown * 100, '%');
    this.percent.set(`${Math.round(this.shown * 100)}%`);
  }

  dispose(): void {
    this.root.remove();
  }
}

/**
 * Procedural faction sigils. Every emblem is built from the same vocabulary —
 * an outer ring, a containment frame and an inner mark — so they read as one
 * set the way real faction iconography does.
 */
export function buildSigil(host: HTMLElement, faction: FactionId): void {
  if (host.dataset.faction === faction) return;
  host.dataset.faction = faction;
  host.textContent = '';
  host.style.setProperty('--accent', FACTION_COLOR[faction]);
  host.setAttribute('title', FACTION_NAME[faction]);

  const s = svg('svg', { viewBox: '0 0 120 120', class: 'gf-sigil-svg' }, host);
  const ring = svg('g', { class: 'gf-sigil-ring' }, s);
  svg('circle', { cx: 60, cy: 60, r: 55, class: 'gf-sigil-thin' }, ring);
  svg('path', { d: polyPath(60, 60, 49, 6, -Math.PI / 2), class: 'gf-sigil-thin' }, ring);
  // Four registration ticks at the cardinal points, common to every faction.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const x = 60 + Math.cos(a) * 55;
    const y = 60 + Math.sin(a) * 55;
    svg(
      'path',
      { d: `M ${x} ${y} L ${60 + Math.cos(a) * 62} ${60 + Math.sin(a) * 62}`, class: 'gf-sigil-tick' },
      ring,
    );
  }

  const mark = svg('g', { class: 'gf-sigil-mark' }, s);
  switch (faction) {
    case 'federation':
      svg('path', { d: 'M60 26 L86 44 L86 76 L60 94 L34 76 L34 44 Z', class: 'gf-sigil-line' }, mark);
      svg('path', { d: 'M60 40 L76 60 L60 54 L44 60 Z', class: 'gf-sigil-fill' }, mark);
      svg('path', { d: 'M60 62 L74 82 L60 76 L46 82 Z', class: 'gf-sigil-fill is-dim' }, mark);
      svg('path', { d: 'M42 60 H30 M78 60 H90', class: 'gf-sigil-line' }, mark);
      break;
    case 'nordic':
      svg('path', { d: 'M60 24 L92 60 L60 96 L28 60 Z', class: 'gf-sigil-line' }, mark);
      svg('path', { d: 'M60 32 V88', class: 'gf-sigil-stave' }, mark);
      svg('path', { d: 'M60 44 L78 34 M60 44 L42 34 M60 66 L78 56 M60 66 L42 56', class: 'gf-sigil-stave' }, mark);
      svg('path', { d: 'M46 78 L60 88 L74 78', class: 'gf-sigil-line' }, mark);
      break;
    case 'grey':
      svg('path', { d: 'M60 34 C82 34 96 60 96 60 C96 60 82 86 60 86 C38 86 24 60 24 60 C24 60 38 34 60 34 Z', class: 'gf-sigil-line' }, mark);
      svg('ellipse', { cx: 60, cy: 60, rx: 13, ry: 20, class: 'gf-sigil-fill' }, mark);
      svg('path', { d: 'M60 20 V34 M60 86 V100', class: 'gf-sigil-line' }, mark);
      svg('circle', { cx: 60, cy: 60, r: 4, class: 'gf-sigil-hole' }, mark);
      break;
    case 'mantis':
      svg('path', { d: 'M32 88 C36 56 48 40 60 30 C72 40 84 56 88 88', class: 'gf-sigil-line' }, mark);
      svg('path', { d: 'M60 30 L52 48 L60 44 L68 48 Z', class: 'gf-sigil-fill' }, mark);
      svg('path', { d: 'M26 44 C42 50 50 62 52 78 M94 44 C78 50 70 62 68 78', class: 'gf-sigil-blade' }, mark);
      svg('path', { d: 'M50 90 H70', class: 'gf-sigil-line' }, mark);
      break;
    case 'insectoid':
      svg('path', { d: polyPath(60, 60, 34, 6, -Math.PI / 2), class: 'gf-sigil-line' }, mark);
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
        svg(
          'path',
          {
            d: `M ${60 + Math.cos(a) * 16} ${60 + Math.sin(a) * 16} L ${60 + Math.cos(a) * 46} ${60 + Math.sin(a) * 46}`,
            class: 'gf-sigil-stave',
          },
          mark,
        );
      }
      svg('path', { d: polyPath(60, 60, 15, 6, -Math.PI / 2), class: 'gf-sigil-fill' }, mark);
      break;
    case 'reptilian':
      svg('path', { d: 'M28 36 H92 L60 96 Z', class: 'gf-sigil-line' }, mark);
      svg('path', { d: 'M44 46 L52 70 L60 50 L68 70 L76 46', class: 'gf-sigil-fang' }, mark);
      svg('path', { d: 'M34 28 H86', class: 'gf-sigil-line' }, mark);
      svg('path', { d: 'M60 96 L60 106', class: 'gf-sigil-line' }, mark);
      break;
    default:
      break;
  }
}
