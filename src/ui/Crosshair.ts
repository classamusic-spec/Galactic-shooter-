/**
 * Crosshair + hit feedback.
 *
 * Three styles come from `settings.user.crosshairStyle`. The dynamic reticle
 * reconstructs weapon bloom from the fire cadence (see `HudState.bloom`) and
 * tightens toward the base gap while aiming down sights.
 *
 * Legibility: every stroke is a solid light bar with a hard 1px black ring and
 * a soft dark halo (`box-shadow`), so the reticle survives both a white sky and
 * a black cave without the usual "difference blend" trick, which goes invisible
 * over mid-grey.
 *
 * Hit feedback is driven from JS rather than CSS keyframes so a second hit
 * 40 ms after the first re-punches instantly instead of waiting out the
 * animation.
 */
import type { HudState } from './UiRoot';
import { settings } from '@/core/Settings';
import { clamp01 } from '@/util/math';
import { div, easeOutBack, easeOutCubic, StyleBind, toggle } from './dom';

const HIT_LIFE = 0.34;
const KILL_LIFE = 0.55;

export class Crosshair {
  private readonly root: HTMLElement;
  private readonly state: HudState;
  private readonly gap: StyleBind;
  private readonly spreadVar: StyleBind;

  private readonly hitRoot: HTMLElement;
  private readonly hitScale: StyleBind;
  private readonly hitOpacity: StyleBind;
  private readonly killRoot: HTMLElement;
  private readonly killScale: StyleBind;
  private readonly killOpacity: StyleBind;

  private hitT = 99;
  private killT = 99;
  private precision = false;
  private heavy = 0;
  private smoothGap = 0;

  constructor(parent: HTMLElement, state: HudState) {
    this.state = state;
    this.root = div('gf-cross', parent);
    this.gap = new StyleBind(this.root, '--gap');
    this.spreadVar = new StyleBind(this.root, '--spread');

    div('gf-cross-dot', this.root);
    for (const side of ['t', 'r', 'b', 'l']) div(`gf-cross-tick is-${side}`, this.root);
    // Outer bracket, only drawn by the dynamic style — gives the reticle a
    // silhouette that survives bloom without the ticks reading as four
    // unrelated dashes.
    for (const side of ['tl', 'tr', 'br', 'bl']) div(`gf-cross-corner is-${side}`, this.root);

    this.hitRoot = div('gf-hitmark', parent);
    this.hitScale = new StyleBind(this.hitRoot, '--s');
    this.hitOpacity = new StyleBind(this.hitRoot, 'opacity');
    for (const q of ['a', 'b', 'c', 'd']) div(`gf-hitmark-line is-${q}`, this.hitRoot);

    this.killRoot = div('gf-killmark', parent);
    this.killScale = new StyleBind(this.killRoot, '--s');
    this.killOpacity = new StyleBind(this.killRoot, 'opacity');
    for (const q of ['a', 'b', 'c', 'd']) div(`gf-killmark-line is-${q}`, this.killRoot);
    div('gf-killmark-ring', this.killRoot);

    this.applyStyle();
  }

  applyStyle(): void {
    const style = settings.user.crosshairStyle;
    toggle(this.root, 'is-dynamic', style === 'dynamic');
    toggle(this.root, 'is-static', style === 'static');
    toggle(this.root, 'is-dot', style === 'dot');
  }

  /** Fired from the `hitmarker` event. */
  hit(precision: boolean, kill: boolean, damage: number): void {
    this.hitT = 0;
    this.precision = precision;
    this.heavy = clamp01(damage / 220);
    if (kill) this.killT = 0;
    toggle(this.hitRoot, 'is-precision', precision);
  }

  render(dt: number, visible: boolean): void {
    toggle(this.root, 'is-on', visible);

    const s = this.state;
    // Bloom pushes the ticks out; ADS pulls them in and shrinks the base gap.
    const target = 3.2 + s.bloom * 15 - s.ads * 2.4;
    this.smoothGap += (target - this.smoothGap) * Math.min(1, dt * 26);
    this.gap.num(Math.max(0.6, this.smoothGap));
    this.spreadVar.num(clamp01(s.bloom));
    toggle(this.root, 'is-ads', s.ads > 0.6);

    this.hitT += dt;
    if (this.hitT < HIT_LIFE) {
      const t = this.hitT / HIT_LIFE;
      const punch = 1.55 - 0.55 * easeOutCubic(Math.min(1, this.hitT / 0.085));
      this.hitScale.num(punch * (1 + this.heavy * 0.22));
      this.hitOpacity.num((1 - t * t) * (visible ? 1 : 0));
      toggle(this.hitRoot, 'is-on', visible);
    } else if (this.hitRoot.classList.contains('is-on')) {
      this.hitOpacity.num(0);
      toggle(this.hitRoot, 'is-on', false);
    }

    this.killT += dt;
    if (this.killT < KILL_LIFE) {
      const t = this.killT / KILL_LIFE;
      const grow = easeOutBack(Math.min(1, this.killT / 0.16));
      this.killScale.num(0.55 + grow * 0.75);
      this.killOpacity.num((1 - t) ** 1.6 * (visible ? 1 : 0));
      toggle(this.killRoot, 'is-on', visible);
    } else if (this.killRoot.classList.contains('is-on')) {
      this.killOpacity.num(0);
      toggle(this.killRoot, 'is-on', false);
    }
  }

  dispose(): void {
    this.root.remove();
    this.hitRoot.remove();
    this.killRoot.remove();
  }
}
