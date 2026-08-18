/**
 * DeathScreen — cause of death and a respawn countdown.
 *
 * The countdown ring is one SVG circle with `pathLength="100"`, unwound by a
 * single attribute write per frame. Hitting the button (or Enter/Space/A)
 * skips the remainder; otherwise the respawn fires automatically at zero so a
 * player who has walked away is not left staring at a dead screen.
 */
import { AttrBind, div, interactive, svg, TextBind, toggle } from './dom';

const COUNTDOWN = 5;

export class DeathScreen {
  visible = false;

  private readonly root: HTMLElement;
  private readonly cause: TextBind;
  private readonly count: TextBind;
  private readonly ring: AttrBind;
  private readonly button: HTMLButtonElement;
  private readonly buttonLabel: TextBind;
  private readonly onRespawn: () => void;
  private t = 0;
  private fired = false;

  constructor(parent: HTMLElement, onRespawn: () => void) {
    this.onRespawn = onRespawn;
    this.root = div('gf-modal gf-death', parent);
    interactive(div('gf-death-wash', this.root));

    const inner = div('gf-death-inner', this.root);
    div('gf-death-kicker', inner).textContent = 'Vanguard Telemetry · Signal Lost';
    div('gf-death-title', inner).textContent = 'You Died';
    this.cause = new TextBind(div('gf-death-cause', inner));

    const ringWrap = div('gf-death-ring', inner);
    const s = svg('svg', { viewBox: '0 0 120 120' }, ringWrap);
    svg('circle', { class: 'gf-death-ring-track', cx: 60, cy: 60, r: 52, pathLength: 100 }, s);
    const fill = svg(
      'circle',
      { class: 'gf-death-ring-fill', cx: 60, cy: 60, r: 52, pathLength: 100, 'stroke-dasharray': '100 100' },
      s,
    );
    this.ring = new AttrBind(fill, 'stroke-dasharray');
    this.count = new TextBind(div('gf-death-count', ringWrap));

    this.button = interactive(document.createElement('button'));
    this.button.type = 'button';
    this.button.className = 'gf-btn is-primary is-wide';
    this.buttonLabel = new TextBind(this.button);
    this.button.addEventListener('click', () => this.activate());
    inner.appendChild(this.button);

    div('gf-death-hint', inner).textContent = 'Enter / A — respawn immediately';
  }

  show(killerName: string): void {
    this.visible = true;
    this.t = COUNTDOWN;
    this.fired = false;
    this.cause.set(`Killed by ${killerName}`);
    this.buttonLabel.set('Respawn');
    toggle(this.root, 'is-on', true);
    this.button.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    toggle(this.root, 'is-on', false);
  }

  nav(_d: number): void {
    /* single action */
  }
  navX(_d: number): void {
    /* single action */
  }

  activate(): void {
    if (!this.visible || this.fired) return;
    this.fired = true;
    this.onRespawn();
  }

  render(dt: number): void {
    if (!this.visible) return;
    this.t = Math.max(0, this.t - dt);
    this.ring.set(`${((this.t / COUNTDOWN) * 100).toFixed(1)} 100`);
    this.count.set(String(Math.ceil(this.t)));
    if (this.t <= 0 && !this.fired) {
      this.fired = true;
      this.onRespawn();
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
