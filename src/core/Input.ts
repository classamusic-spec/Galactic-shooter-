/**
 * Input: keyboard, mouse (with pointer-lock + raw movement), gamepad and touch.
 * Exposes a stable per-frame action snapshot so gameplay never reads DOM events.
 */
import { clamp, DEG } from '@/util/math';
import { settings } from './Settings';

export type ActionName =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'slide'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'melee'
  | 'grenade'
  | 'classAbility'
  | 'super'
  | 'interact'
  | 'swapWeapon'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'map'
  | 'pause'
  | 'flashlight'
  | 'boost';

const DEFAULT_BINDINGS: Record<string, ActionName> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyR: 'reload',
  KeyV: 'melee',
  KeyQ: 'grenade',
  KeyF: 'interact',
  KeyE: 'classAbility',
  KeyX: 'super',
  Digit1: 'slot1',
  Digit2: 'slot2',
  Digit3: 'slot3',
  Tab: 'map',
  KeyM: 'map',
  Escape: 'pause',
  KeyL: 'flashlight',
  KeyG: 'swapWeapon',
};

interface ButtonState {
  down: boolean;
  /** True only on the frame the button went down. */
  pressed: boolean;
  /** True only on the frame the button went up. */
  released: boolean;
  /** Simulation time the button went down, for hold detection. */
  downAt: number;
}

function makeButton(): ButtonState {
  return { down: false, pressed: false, released: false, downAt: 0 };
}

export class InputSystem {
  /** Mouse delta accumulated since the last consume, in radians. */
  lookYaw = 0;
  lookPitch = 0;
  /** Analog move vector, magnitude clamped to 1. */
  moveX = 0;
  moveZ = 0;
  /** Analog trigger 0..1 for gamepad fire. */
  fireAxis = 0;
  aimAxis = 0;

  pointerLocked = false;
  usingGamepad = false;
  touchActive = false;
  /** Set while any text/menu surface wants raw keys. */
  suppressGameplay = false;

  private buttons = new Map<ActionName, ButtonState>();
  private bindings: Record<string, ActionName> = { ...DEFAULT_BINDINGS };
  private canvas: HTMLCanvasElement;
  private time = 0;
  private rawYaw = 0;
  private rawPitch = 0;
  private wheel = 0;
  private padIndex: number | null = null;
  private padDeadzone = 0.16;
  private prevPadButtons: boolean[] = [];
  /** Touch controls state. */
  private touchLook = { x: 0, y: 0 };
  private touchMove = { x: 0, y: 0 };
  private activeTouches = new Map<number, { id: number; role: 'move' | 'look'; ox: number; oy: number }>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    for (const a of Object.values(DEFAULT_BINDINGS)) this.buttons.set(a, makeButton());
    for (const a of ['fire', 'aim', 'slide', 'boost'] as ActionName[])
      if (!this.buttons.has(a)) this.buttons.set(a, makeButton());
    this.attach();
  }

  // -- queries --------------------------------------------------------------

  down(a: ActionName): boolean {
    return !this.suppressGameplay && (this.buttons.get(a)?.down ?? false);
  }

  pressed(a: ActionName): boolean {
    return !this.suppressGameplay && (this.buttons.get(a)?.pressed ?? false);
  }

  released(a: ActionName): boolean {
    return this.buttons.get(a)?.released ?? false;
  }

  /** Seconds the action has been held, or 0 when up. */
  heldFor(a: ActionName): number {
    const b = this.buttons.get(a);
    return b?.down ? this.time - b.downAt : 0;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Consume accumulated look delta (radians). Call once per simulation step. */
  consumeLook(): { yaw: number; pitch: number } {
    const out = { yaw: this.rawYaw, pitch: this.rawPitch };
    this.rawYaw = 0;
    this.rawPitch = 0;
    return out;
  }

  // -- lifecycle ------------------------------------------------------------

  requestPointerLock(): void {
    if (this.pointerLocked) return;
    const el = this.canvas as HTMLCanvasElement & {
      requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void;
    };
    try {
      const res = el.requestPointerLock({ unadjustedMovement: true });
      if (res && typeof (res as Promise<void>).catch === 'function') {
        (res as Promise<void>).catch(() => el.requestPointerLock());
      }
    } catch {
      el.requestPointerLock();
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Advance edge state. Call at the END of each simulation step. */
  endStep(time: number): void {
    this.time = time;
    for (const b of this.buttons.values()) {
      b.pressed = false;
      b.released = false;
    }
  }

  /** Poll gamepad + fold touch into the analog channels. Call at step start. */
  beginStep(time: number): void {
    this.time = time;
    this.pollGamepad();

    // Keyboard/touch → analog move.
    let mx = 0;
    let mz = 0;
    if (this.down('right')) mx += 1;
    if (this.down('left')) mx -= 1;
    if (this.down('forward')) mz -= 1;
    if (this.down('back')) mz += 1;
    if (this.touchActive) {
      mx += this.touchMove.x;
      mz += this.touchMove.y;
    }
    if (this.padMove) {
      mx += this.padMove.x;
      mz += this.padMove.y;
    }
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    this.moveX = mx;
    this.moveZ = mz;

    if (this.touchActive) {
      this.rawYaw -= this.touchLook.x * settings.user.sensitivity * 1.6;
      this.rawPitch -= this.touchLook.y * settings.user.sensitivity * 1.6;
      this.touchLook.x = 0;
      this.touchLook.y = 0;
    }
  }

  private padMove: { x: number; y: number } | null = null;

  private attach(): void {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.onTouchEnd);
    this.canvas.addEventListener('touchcancel', this.onTouchEnd);
    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = (e as GamepadEvent).gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.padIndex = null;
      this.usingGamepad = false;
      this.padMove = null;
    });
  }

  private set(a: ActionName, down: boolean): void {
    let b = this.buttons.get(a);
    if (!b) this.buttons.set(a, (b = makeButton()));
    if (b.down === down) return;
    b.down = down;
    if (down) {
      b.pressed = true;
      b.downAt = this.time;
    } else {
      b.released = true;
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const a = this.bindings[e.code];
    if (e.code === 'Tab' || (e.code === 'Space' && this.pointerLocked)) e.preventDefault();
    if (!a) return;
    this.set(a, true);
    if (a === 'crouch' && this.down('sprint')) this.set('slide', true);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const a = this.bindings[e.code];
    if (!a) return;
    this.set(a, false);
    if (a === 'crouch') this.set('slide', false);
  };

  private onBlur = (): void => {
    for (const [a, b] of this.buttons) if (b.down) this.set(a, false);
    this.moveX = this.moveZ = 0;
  };

  private onMouseDown = (e: MouseEvent): void => {
    this.usingGamepad = false;
    if (e.button === 0) this.set('fire', true);
    else if (e.button === 2) {
      e.preventDefault();
      this.set('aim', true);
    } else if (e.button === 1) {
      e.preventDefault();
      this.set('melee', true);
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.set('fire', false);
    else if (e.button === 2) this.set('aim', false);
    else if (e.button === 1) this.set('melee', false);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.usingGamepad = false;
    const s = settings.user.sensitivity * (this.down('aim') ? settings.user.adsSensitivityScale : 1);
    this.rawYaw -= e.movementX * s;
    this.rawPitch -= e.movementY * s * (settings.user.invertY ? -1 : 1);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this.onBlur();
  };

  private onTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    this.touchActive = true;
    const half = window.innerWidth * 0.5;
    for (const t of Array.from(e.changedTouches)) {
      const role: 'move' | 'look' = t.clientX < half ? 'move' : 'look';
      this.activeTouches.set(t.identifier, {
        id: t.identifier,
        role,
        ox: t.clientX,
        oy: t.clientY,
      });
      if (role === 'look') this.set('fire', true);
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const rec = this.activeTouches.get(t.identifier);
      if (!rec) continue;
      if (rec.role === 'move') {
        const dx = (t.clientX - rec.ox) / 70;
        const dy = (t.clientY - rec.oy) / 70;
        const l = Math.hypot(dx, dy);
        const s = l > 1 ? 1 / l : 1;
        this.touchMove.x = dx * s;
        this.touchMove.y = dy * s;
      } else {
        this.touchLook.x += t.clientX - rec.ox;
        this.touchLook.y += t.clientY - rec.oy;
        rec.ox = t.clientX;
        rec.oy = t.clientY;
      }
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      const rec = this.activeTouches.get(t.identifier);
      if (rec?.role === 'move') this.touchMove.x = this.touchMove.y = 0;
      if (rec?.role === 'look') this.set('fire', false);
      this.activeTouches.delete(t.identifier);
    }
    if (this.activeTouches.size === 0) this.touchActive = this.activeTouches.size > 0;
  };

  private dz(v: number): number {
    const a = Math.abs(v);
    if (a < this.padDeadzone) return 0;
    // Rescale past the deadzone so the stick keeps full range.
    return Math.sign(v) * ((a - this.padDeadzone) / (1 - this.padDeadzone)) ** 1.5;
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    const pad = this.padIndex != null ? pads[this.padIndex] : pads.find((p) => p && p.connected);
    if (!pad) {
      this.padMove = null;
      return;
    }
    const lx = this.dz(pad.axes[0] ?? 0);
    const ly = this.dz(pad.axes[1] ?? 0);
    const rx = this.dz(pad.axes[2] ?? 0);
    const ry = this.dz(pad.axes[3] ?? 0);
    if (lx || ly || rx || ry) this.usingGamepad = true;
    this.padMove = lx || ly ? { x: lx, y: ly } : null;

    // Console-style look: exponential ramp plus a small linear base.
    const aimScale = this.down('aim') ? settings.user.adsSensitivityScale : 1;
    const sens = 170 * DEG * aimScale * (1 / 60);
    const curve = (v: number): number => Math.sign(v) * (0.35 * Math.abs(v) + 0.65 * v * v * Math.abs(v));
    this.rawYaw -= curve(rx) * sens;
    this.rawPitch -= curve(ry) * sens * (settings.user.invertY ? -1 : 1);

    const b = pad.buttons;
    const map: Array<[number, ActionName]> = [
      [0, 'jump'],
      [1, 'melee'],
      [2, 'reload'],
      [3, 'swapWeapon'],
      [4, 'grenade'],
      [5, 'classAbility'],
      [8, 'map'],
      [9, 'pause'],
      [10, 'sprint'],
      [11, 'crouch'],
    ];
    for (const [i, a] of map) {
      const d = !!b[i]?.pressed;
      if (d !== (this.prevPadButtons[i] ?? false)) this.set(a, d);
      this.prevPadButtons[i] = d;
    }
    this.fireAxis = clamp(b[7]?.value ?? 0, 0, 1);
    this.aimAxis = clamp(b[6]?.value ?? 0, 0, 1);
    this.set('fire', this.fireAxis > 0.35 || this.down('fire') === false ? this.fireAxis > 0.35 : true);
    this.set('aim', this.aimAxis > 0.35);
    if (b[4]?.pressed && b[5]?.pressed) this.set('super', true);
  }
}
