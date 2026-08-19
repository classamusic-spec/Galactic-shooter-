/**
 * On-screen controls for touch devices.
 *
 * The game shipped with a move/look drag scheme and nothing else — no way to
 * jump, reload, aim, throw a grenade, use an ability, swap weapons, interact, or
 * even open a menu, and fire was welded to the look drag so you could not look
 * without shooting. On a phone that is not a hard game, it is an unplayable one.
 *
 * This is the missing half: a floating move stick (drawn from the live stick
 * state `Input` already tracks) plus a set of action buttons that drive the same
 * action system the keyboard and pad do, through `Input.setTouchAction`. The
 * buttons are `data-interactive` DOM, so they swallow their own touches while the
 * empty screen behind them still falls through to the canvas for look and move —
 * that pass-through is exactly what `#ui-root`'s pointer-events rules give us.
 *
 * Everything here is inert until the player first touches the screen, and hidden
 * again whenever a menu is up (menus are tapped directly) or the device is not a
 * phone.
 */
import type { ActionName } from '@/core/Input';
import type { InputSystem } from '@/core/Input';
import { div } from './dom';

interface TouchButton {
  el: HTMLElement;
  action: ActionName;
  /** True while a finger is down on it, for the pressed visual. */
  held: boolean;
}

/** Auto-sprint kicks in when the move stick is pushed past this fraction. */
const SPRINT_AT = 0.92;

export class TouchControls {
  private readonly root: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly buttons: TouchButton[] = [];
  private visible = false;
  private sprinting = false;

  constructor(
    parent: HTMLElement,
    private readonly input: InputSystem,
    private readonly taps: { pause: () => void },
  ) {
    this.root = div('gf-touch', parent);

    // The move stick is a visual only — the canvas handlers own the actual
    // movement vector. It is floating: planted wherever the left thumb lands.
    this.stick = div('gf-touch-stick', this.root);
    div('gf-touch-stick-ring', this.stick);
    this.stickKnob = div('gf-touch-stick-knob', this.stick);

    // Right-hand action cluster, plus the two corner buttons. Glyphs are drawn
    // in CSS; the label is the accessible name and the small caption.
    const cluster = div('gf-touch-cluster', this.root);
    this.button(cluster, 'fire', 'Fire', 'is-fire');
    this.button(cluster, 'aim', 'Aim', 'is-aim');
    this.button(cluster, 'jump', 'Jump', 'is-jump');
    this.button(cluster, 'reload', 'Reload', 'is-reload');
    this.button(cluster, 'melee', 'Melee', 'is-melee');
    this.button(cluster, 'swapWeapon', 'Swap', 'is-swap');

    const powers = div('gf-touch-powers', this.root);
    this.button(powers, 'grenade', 'Grenade', 'is-nade');
    this.button(powers, 'classAbility', 'Ability', 'is-ability');
    this.button(powers, 'super', 'Super', 'is-super');

    // Interact sits centre-low where the crosshair points, the way a prompt
    // would; pause and map take the top corners, clear of both thumbs.
    this.button(this.root, 'interact', 'Interact', 'is-interact');
    // The star map is reachable only from orbit, where it is shown directly and
    // tapped; you return there through the Menu button's "Return to Orbit". A Map
    // button during a planet mission would do nothing, so there isn't one.
    this.tapButton(this.root, 'Menu', 'is-pause', () => this.taps.pause());

    this.setVisible(false);
  }

  private button(parent: HTMLElement, action: ActionName, label: string, cls: string): void {
    const el = div(`gf-tbtn ${cls}`, parent);
    el.setAttribute('data-interactive', '');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', label);
    div('gf-tbtn-cap', el).textContent = label;

    const rec: TouchButton = { el, action, held: false };
    this.buttons.push(rec);

    // Pointer events only — a browser fires BOTH touchstart and a synthetic
    // pointerdown for one touch, so listening to both drove every press twice
    // (which toggled a tap-button straight back off). Pointer capture keeps the
    // release bound to this button even if the thumb slides off a small target.
    const press = (e: PointerEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture?.(e.pointerId);
      if (rec.held) return;
      rec.held = true;
      el.classList.add('is-down');
      this.input.setTouchAction(action, true);
    };
    const release = (e: PointerEvent): void => {
      e.preventDefault();
      if (!rec.held) return;
      rec.held = false;
      el.classList.remove('is-down');
      this.input.setTouchAction(action, false);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  }

  /**
   * A button that fires a callback once on press rather than driving a held
   * action. Pause and the star map are toggles, not things you hold, and nothing
   * polls their actions — so they route straight to the UI instead.
   */
  private tapButton(parent: HTMLElement, label: string, cls: string, fn: () => void): void {
    const el = div(`gf-tbtn ${cls}`, parent);
    el.setAttribute('data-interactive', '');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', label);
    div('gf-tbtn-cap', el).textContent = label;
    // Pointer-only, one fire per press: see the note in button(). Fires on
    // pointerdown so a menu opens the instant the thumb lands.
    const fire = (e: PointerEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('is-down');
      fn();
    };
    const up = (): void => el.classList.remove('is-down');
    el.addEventListener('pointerdown', fire);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

    /** Show or hide the whole layer, releasing any held button on the way out. */
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('is-on', on);
    if (!on) this.releaseAll();
  }

  private releaseAll(): void {
    for (const b of this.buttons) {
      if (!b.held) continue;
      b.held = false;
      b.el.classList.remove('is-down');
      this.input.setTouchAction(b.action, false);
    }
    if (this.sprinting) {
      this.sprinting = false;
      this.input.setTouchAction('sprint', false);
    }
  }

  /**
   * Drive the visuals each frame. Cheap: a class toggle and two transforms, only
   * written when they change.
   */
  update(): void {
    if (!this.visible) return;
    const m = this.input.moveStick;
    if (m.active) {
      this.stick.classList.add('is-on');
      this.stick.style.setProperty('--x', `${m.bx}px`);
      this.stick.style.setProperty('--y', `${m.by}px`);
      this.stickKnob.style.transform = `translate(${m.dx}px, ${m.dy}px)`;
      // Auto-sprint at full deflection removes a button the thumb has no room
      // for: push the stick to the edge and you run.
      const want = Math.hypot(m.dx, m.dy) / 70 >= SPRINT_AT;
      if (want !== this.sprinting) {
        this.sprinting = want;
        this.input.setTouchAction('sprint', want);
      }
    } else {
      this.stick.classList.remove('is-on');
      if (this.sprinting) {
        this.sprinting = false;
        this.input.setTouchAction('sprint', false);
      }
    }
  }

  dispose(): void {
    this.releaseAll();
    this.root.remove();
  }
}
