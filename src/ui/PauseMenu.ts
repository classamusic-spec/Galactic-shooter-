/**
 * PauseMenu — keyboard, mouse and gamepad navigable.
 *
 * Focus is *owned* by the menu: a Tab press is swallowed and re-routed to the
 * internal cursor, so focus can never escape into the page behind the backdrop
 * while the game is paused.
 */
import { div, interactive, toggle } from './dom';

export interface PauseActions {
  resume(): void;
  settings(): void;
  orbit(): void;
  abandon(): void;
}

interface Item {
  node: HTMLButtonElement;
  run(): void;
  danger?: boolean;
}

export class PauseMenu {
  visible = false;

  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly items: Item[] = [];
  private readonly confirmRow: HTMLElement;
  private readonly actions: PauseActions;
  private index = 0;
  private confirming = false;
  private readonly trapKeys: (ev: KeyboardEvent) => void;

  constructor(parent: HTMLElement, actions: PauseActions) {
    this.actions = actions;
    this.root = div('gf-modal gf-pause', parent);
    interactive(div('gf-modal-backdrop', this.root));

    const panel = div('gf-panel is-pause', this.root);
    interactive(panel);
    const head = div('gf-panel-head', panel);
    div('gf-panel-kicker', head).textContent = 'Federation Vanguard Division';
    div('gf-panel-title', head).textContent = 'Paused';
    div('gf-panel-rule', panel);

    const body = div('gf-pause-body', panel);
    const side = div('gf-pause-side', body);
    div('gf-pause-side-cap', side).textContent = 'Field Manual';
    const rows: [string, string][] = [
      ['Move', 'W A S D'],
      ['Sprint / Slide', 'Shift'],
      ['Jump', 'Space'],
      ['Grenade', 'Q'],
      ['Melee', 'V'],
      ['Class Ability', 'E'],
      ['Super', 'X'],
      ['Reload', 'R'],
      ['Star Map', 'Tab'],
    ];
    for (const [k, v] of rows) {
      const row = div('gf-kv', side);
      div('gf-kv-k', row).textContent = k;
      div('gf-kv-v', row).textContent = v;
    }

    this.list = div('gf-menu', body);
    this.add('Resume', () => this.actions.resume());
    this.add('Settings', () => this.actions.settings());
    this.add('Return to Orbit', () => this.actions.orbit());
    this.add('Abandon Mission', () => this.beginConfirm(), true);

    this.confirmRow = div('gf-menu-confirm', this.list);
    div('gf-menu-confirm-text', this.confirmRow).textContent =
      'Abandon the mission? Progress on this world is lost.';
    const yes = interactive(document.createElement('button'));
    yes.className = 'gf-btn is-danger is-small';
    yes.textContent = 'Confirm';
    yes.addEventListener('click', () => {
      this.confirming = false;
      toggle(this.confirmRow, 'is-on', false);
      this.actions.abandon();
    });
    const no = interactive(document.createElement('button'));
    no.className = 'gf-btn is-small';
    no.textContent = 'Cancel';
    no.addEventListener('click', () => {
      this.confirming = false;
      toggle(this.confirmRow, 'is-on', false);
    });
    this.confirmRow.append(yes, no);

    div('gf-panel-foot', panel).textContent =
      'Enter / A — select      Esc / B — resume      Arrows — navigate';

    this.trapKeys = (ev: KeyboardEvent): void => {
      if (!this.visible) return;
      if (ev.key === 'Tab') {
        ev.preventDefault();
        this.nav(ev.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', this.trapKeys, { capture: true });
  }

  private add(label: string, run: () => void, danger = false): void {
    const node = interactive(document.createElement('button'));
    node.className = `gf-menu-item${danger ? ' is-danger' : ''}`;
    node.type = 'button';
    const caret = div('gf-menu-caret');
    const text = div('gf-menu-label');
    text.textContent = label;
    node.append(caret, text, div('gf-menu-edge'));
    node.addEventListener('click', () => {
      this.index = this.items.findIndex((i) => i.node === node);
      this.highlight();
      run();
    });
    node.addEventListener('mouseenter', () => {
      this.index = this.items.findIndex((i) => i.node === node);
      this.highlight();
    });
    this.list.appendChild(node);
    this.items.push({ node, run, danger });
  }

  private beginConfirm(): void {
    this.confirming = !this.confirming;
    toggle(this.confirmRow, 'is-on', this.confirming);
  }

  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.index = 0;
    this.confirming = false;
    toggle(this.confirmRow, 'is-on', false);
    toggle(this.root, 'is-on', true);
    this.highlight();
    this.items[0]?.node.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.confirming = false;
    toggle(this.confirmRow, 'is-on', false);
    toggle(this.root, 'is-on', false);
    (document.activeElement as HTMLElement | null)?.blur();
  }

  nav(delta: number): void {
    const n = this.items.length;
    this.index = (this.index + delta + n) % n;
    this.highlight();
  }

  navX(_delta: number): void {
    /* the pause list is one-dimensional */
  }

  activate(): void {
    this.items[this.index]?.run();
  }

  private highlight(): void {
    for (let i = 0; i < this.items.length; i++) {
      toggle(this.items[i].node, 'is-active', i === this.index);
    }
    this.items[this.index]?.node.focus({ preventScroll: true });
  }

  render(_dt: number): void {
    /* purely CSS-animated */
  }

  dispose(): void {
    window.removeEventListener('keydown', this.trapKeys, { capture: true });
    this.root.remove();
  }
}
