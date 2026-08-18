/**
 * Toasts — two lanes.
 *
 * The *banner* lane handles the big centred announcements (planet arrival,
 * encounter beats): long, rarity-less messages. The *stack* lane handles loot
 * and perk pickups as rarity-framed cards that queue up bottom-left and slide
 * in one after another. Both lanes are pooled and queue overflow rather than
 * spamming the screen.
 */
import type { ItemRarity } from '@/types';
import { RARITY_COLOR, RARITY_LABEL } from './ui.css';
import { div, StyleBind, TextBind, toggle } from './dom';

export interface ToastRequest {
  text: string;
  sub?: string;
  rarity?: ItemRarity;
  duration?: number;
}

const STACK_VISIBLE = 4;
const IN_TIME = 0.3;
const OUT_TIME = 0.42;

interface Card {
  node: HTMLElement;
  title: TextBind;
  sub: TextBind;
  tag: TextBind;
  color: StyleBind;
  active: boolean;
  t: number;
  hold: number;
  phase: 0 | 1 | 2;
}

export class Toasts {
  private readonly root: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly cards: Card[] = [];
  private readonly queue: ToastRequest[] = [];

  private readonly banner: HTMLElement;
  private readonly bannerTitle: TextBind;
  private readonly bannerSub: TextBind;
  private readonly bannerQueue: ToastRequest[] = [];
  private bannerT = 99;
  private bannerHold = 0;

  constructor(parent: HTMLElement) {
    this.root = div('gf-toasts', parent);
    this.banner = div('gf-banner', this.root);
    div('gf-banner-rule is-top', this.banner);
    this.bannerTitle = new TextBind(div('gf-banner-title', this.banner));
    this.bannerSub = new TextBind(div('gf-banner-sub', this.banner));
    div('gf-banner-rule is-bottom', this.banner);

    this.stack = div('gf-toast-stack', this.root);
    for (let i = 0; i < 6; i++) {
      const node = div('gf-toast', this.stack);
      div('gf-toast-edge', node);
      const body = div('gf-toast-body', node);
      const title = new TextBind(div('gf-toast-title', body));
      const sub = new TextBind(div('gf-toast-sub', body));
      const tag = new TextBind(div('gf-toast-tag', node));
      this.cards.push({
        node,
        title,
        sub,
        tag,
        color: new StyleBind(node, '--r'),
        active: false,
        t: 0,
        hold: 0,
        phase: 0,
      });
    }
  }

  push(req: ToastRequest): void {
    // A long, rarity-less message is a story beat, not a pickup.
    const isBanner = !req.rarity && (req.duration ?? 2) >= 3;
    if (isBanner) {
      if (this.bannerQueue.length < 4) this.bannerQueue.push(req);
      return;
    }
    if (this.queue.length < 12) this.queue.push(req);
  }

  render(dt: number): void {
    this.renderStack(dt);
    this.renderBanner(dt);
  }

  private renderStack(dt: number): void {
    let live = 0;
    for (const c of this.cards) {
      if (!c.active) continue;
      live++;
      c.t += dt;
      if (c.phase === 0 && c.t >= IN_TIME) {
        c.phase = 1;
        c.t = 0;
        toggle(c.node, 'is-in', true);
      } else if (c.phase === 1 && c.t >= c.hold) {
        c.phase = 2;
        c.t = 0;
        toggle(c.node, 'is-out', true);
      } else if (c.phase === 2 && c.t >= OUT_TIME) {
        c.active = false;
        live--;
        toggle(c.node, 'is-live', false);
        toggle(c.node, 'is-in', false);
        toggle(c.node, 'is-out', false);
      }
    }
    if (live >= STACK_VISIBLE || this.queue.length === 0) return;
    const req = this.queue.shift();
    if (!req) return;
    const card = this.cards.find((c) => !c.active);
    if (!card) return;
    const rarity = req.rarity ?? 'common';
    card.active = true;
    card.phase = 0;
    card.t = 0;
    card.hold = Math.max(1.2, req.duration ?? 2.6);
    card.title.set(req.text.toUpperCase());
    card.sub.set(req.sub ?? '');
    card.tag.set(RARITY_LABEL[rarity]);
    card.color.set(RARITY_COLOR[rarity]);
    toggle(card.node, 'is-exotic', rarity === 'exotic');
    toggle(card.node, 'is-legendary', rarity === 'legendary');
    toggle(card.node, 'is-nosub', !req.sub);
    toggle(card.node, 'is-in', false);
    toggle(card.node, 'is-out', false);
    toggle(card.node, 'is-live', true);
    // Cards are appended in arrival order so the newest sits at the bottom of
    // the column, next to where the player's eye already is.
    this.stack.appendChild(card.node);
    void card.node.offsetWidth;
    toggle(card.node, 'is-in', true);
  }

  private renderBanner(dt: number): void {
    this.bannerT += dt;
    const total = this.bannerHold + IN_TIME + OUT_TIME;
    if (this.bannerT < total) {
      toggle(this.banner, 'is-out', this.bannerT > this.bannerHold + IN_TIME);
      return;
    }
    toggle(this.banner, 'is-on', false);
    toggle(this.banner, 'is-out', false);
    const req = this.bannerQueue.shift();
    if (!req) return;
    this.bannerTitle.set(req.text.toUpperCase());
    this.bannerSub.set(req.sub ?? '');
    toggle(this.banner, 'is-nosub', !req.sub);
    this.bannerHold = Math.max(1.6, req.duration ?? 3.6);
    this.bannerT = 0;
    void this.banner.offsetWidth;
    toggle(this.banner, 'is-on', true);
  }

  dispose(): void {
    this.root.remove();
  }
}
