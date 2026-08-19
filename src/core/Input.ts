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
  | 'boost'
  | 'cycleGrenade';

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
  // Bottom row, beside the other ability keys (Z X C V = cycle, super, crouch,
  // melee). Grenade itself is Q, and it has to stay a hold for the charge.
  KeyZ: 'cycleGrenade',
};

/**
 * Standard-mapping button indices. Chrome reports a DualSense as
 * `mapping: 'standard'` over both USB and Bluetooth, so these are the PS5 face
 * buttons in order: Cross, Circle, Square, Triangle, L1, R1, L2, R2, Create,
 * Options, L3, R3, then the d-pad.
 *
 * The d-pad carries weapon slots and interact. Both were previously unreachable
 * on a pad — interact especially, which meant loot could not be picked up and the
 * ship could not be boarded without a keyboard.
 *
 * **Index 16** is the last free slot in the W3C standard mapping: 0-15 are all
 * bound above, and 6/7 are the analog triggers driving aim and fire, so binding
 * anything to them would collide. 16 is the guide/PS button. Some desktop
 * shells and overlays swallow it, which is why grenade cycling is *also* on the
 * keyboard and, more importantly, exposed as an explicit picker in the star
 * map's loadout column — a pad player never has to find this button to reach
 * every grenade.
 */
const PAD_BUTTONS: Array<[number, ActionName]> = [
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
  [12, 'interact'],
  [13, 'flashlight'],
  [14, 'slot1'],
  [15, 'slot2'],
  [16, 'cycleGrenade'],
];

/** Analog trigger travel past which the trigger counts as pulled. */
const TRIGGER_PULL = 0.35;
/** Slot in `prevPadButtons` used for the L1+R1 super chord. */
const SUPER_SLOT = 20;

const _stickL = { x: 0, y: 0 };
const _stickR = { x: 0, y: 0 };

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
  /**
   * Whether a click on the canvas should claim the pointer.
   *
   * Pointer lock can only be requested from a user gesture, so nothing can grab
   * it at the moment the player lands on a planet — the state change to
   * `playing` is not a gesture. The first click is, and this flag is how the UI
   * says whether that click is one the game wants (in the world, no menu up) or
   * one the player aimed at a menu.
   */
  autoPointerLock = false;
  usingGamepad = false;
  touchActive = false;
  /**
   * True once the player has touched the screen. Drives the on-screen controls
   * and hides the mouse-only chrome — a phone must never show "Click to look".
   */
  usingTouch = false;
  /**
   * Live floating move-stick state, for the on-screen visual. `active` is false
   * when no finger is down in the movement zone; `bx/by` is the anchor the stick
   * was planted at and `dx/dy` is the current deflection, both in CSS pixels.
   */
  readonly moveStick = { active: false, bx: 0, by: 0, dx: 0, dy: 0 };
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
  private prevPadButtons: boolean[] = [];
  /**
   * Trigger state from the previous poll.
   *
   * Fire and aim are the only actions two devices drive at once, and the pad
   * used to write them every poll. That latched: once `fire` was down the poll
   * re-asserted it, so releasing the trigger never stopped the gun. Edge-driving
   * them means the pad only speaks when its own trigger actually changes, and a
   * mouse hold is left alone in between.
   */
  private prevPadFire = false;
  private prevPadAim = false;
  /** Right-stick deflection 0..1, for scaling aim assist by player intent. */
  lookStick = 0;
  private padPressAnnounced = false;
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

  /**
   * Drive an action from an on-screen touch button.
   *
   * The button DOM sits above the canvas and swallows its own touches, so this
   * is the only path a phone has to jump, reload, aim, throw a grenade or open a
   * menu — none of which the move/look drag zones can express. Marks touch as the
   * active device so the UI keeps the controls up.
   */
  setTouchAction(a: ActionName, down: boolean): void {
    this.usingTouch = true;
    this.touchActive = true;
    this.usingGamepad = false;
    this.set(a, down);
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

    if (this.touchLook.x || this.touchLook.y) {
      // Touch look has its own sensitivity: a thumb drag is a very different
      // gesture from a mouse flick and wants its own scale, aim-scaled while the
      // ADS button is held and honouring the invert-Y preference like every
      // other device.
      const aim = this.down('aim') ? settings.user.adsSensitivityScale : 1;
      const s = settings.user.touchSensitivity * aim;
      this.rawYaw -= this.touchLook.x * s;
      this.rawPitch -= this.touchLook.y * s * (settings.user.invertY ? -1 : 1);
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
    if (e.button === 0 && this.autoPointerLock && !this.pointerLocked) {
      // The click that captures the pointer must not also pull the trigger.
      // Clicking back into a window should not cost a round, and on a hair
      // trigger it costs a whole burst.
      this.requestPointerLock();
      return;
    }
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
    this.usingTouch = true;
    this.usingGamepad = false;
    // The left third is the movement zone; the rest is the look zone. A third
    // rather than a half because on a phone held in two hands the right thumb
    // covers far more of the screen, and the fire/ability buttons live over on
    // that side too.
    const moveZone = window.innerWidth * 0.34;
    for (const t of Array.from(e.changedTouches)) {
      const role: 'move' | 'look' = t.clientX < moveZone ? 'move' : 'look';
      this.activeTouches.set(t.identifier, {
        id: t.identifier,
        role,
        ox: t.clientX,
        oy: t.clientY,
      });
      // Fire is a dedicated on-screen button now, NOT "touched the right half".
      // Welding it to the look zone meant every camera adjustment pulled the
      // trigger and you could never simply look around.
      if (role === 'move') {
        this.moveStick.active = true;
        this.moveStick.bx = t.clientX;
        this.moveStick.by = t.clientY;
        this.moveStick.dx = 0;
        this.moveStick.dy = 0;
      }
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const rec = this.activeTouches.get(t.identifier);
      if (!rec) continue;
      if (rec.role === 'move') {
        const RADIUS = 70;
        const rawX = t.clientX - rec.ox;
        const rawY = t.clientY - rec.oy;
        const dx = rawX / RADIUS;
        const dy = rawY / RADIUS;
        const l = Math.hypot(dx, dy);
        const s = l > 1 ? 1 / l : 1;
        this.touchMove.x = dx * s;
        this.touchMove.y = dy * s;
        // Clamp the visual knob to the ring so it reads like a stick.
        const vl = Math.hypot(rawX, rawY);
        const vs = vl > RADIUS ? RADIUS / vl : 1;
        this.moveStick.dx = rawX * vs;
        this.moveStick.dy = rawY * vs;
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
      if (rec?.role === 'move') {
        this.touchMove.x = this.touchMove.y = 0;
        this.moveStick.active = false;
        this.moveStick.dx = this.moveStick.dy = 0;
      }
      this.activeTouches.delete(t.identifier);
    }
    // touchActive tracks whether a drag zone finger is down; the on-screen
    // buttons keep their own state. `usingTouch` stays latched — the device does
    // not stop being a phone between taps.
    if (this.activeTouches.size === 0) this.touchActive = false;
  };

  /**
   * A pad button went down. Marks the pad as the active device and fires a
   * one-off DOM event that `Audio` listens for — a gamepad press cannot satisfy
   * the autoplay policy, and that is worth telling the player rather than
   * leaving them with a silent game.
   */
  private onPadPress(): void {
    this.usingGamepad = true;
    if (!this.padPressAnnounced) {
      this.padPressAnnounced = true;
      window.dispatchEvent(new Event('gf:padpress'));
    }
  }

  /**
   * Radial deadzone plus response curve, applied to a stick as a pair.
   *
   * Per-axis deadzones carve a *square* hole out of the stick's circle: pushed
   * straight up, x is inside the zone and drops to nothing, but pushed 30 deg off
   * vertical the same tiny x suddenly counts. The result is that shallow
   * diagonals snap to the cardinals. Treating the stick as one vector and gating
   * on its magnitude keeps the direction the player chose.
   */
  private stick(x: number, y: number, out: { x: number; y: number }): number {
    const dead = clamp(settings.user.stickDeadzone, 0.02, 0.5);
    const mag = Math.hypot(x, y);
    if (mag < dead) {
      out.x = 0;
      out.y = 0;
      return 0;
    }
    const scaled = Math.min(1, (mag - dead) / (1 - dead));
    const shaped = scaled ** 1.5;
    out.x = (x / mag) * shaped;
    out.y = (y / mag) * shaped;
    return shaped;
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    const pad = this.padIndex != null ? pads[this.padIndex] : pads.find((p) => p && p.connected);
    if (!pad) {
      this.padMove = null;
      return;
    }
    const moveMag = this.stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, _stickL);
    const lookMag = this.stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, _stickR);
    this.lookStick = lookMag;
    if (moveMag || lookMag) this.usingGamepad = true;
    this.padMove = moveMag ? { x: _stickL.x, y: _stickL.y } : null;

    // Console-style look: exponential ramp plus a small linear base, so small
    // deflections stay precise and the outer travel still turns quickly.
    const aimScale = this.down('aim') ? settings.user.adsSensitivityScale : 1;
    const sens = settings.user.padSensitivity * DEG * aimScale * (1 / 60);
    const curve = (v: number): number => Math.sign(v) * (0.35 * Math.abs(v) + 0.65 * v * v * Math.abs(v));
    this.rawYaw -= curve(_stickR.x) * sens;
    this.rawPitch -= curve(_stickR.y) * sens * (settings.user.invertY ? -1 : 1);

    const b = pad.buttons;
    for (const [i, a] of PAD_BUTTONS) {
      const d = !!b[i]?.pressed;
      if (d !== (this.prevPadButtons[i] ?? false)) {
        this.set(a, d);
        // Buttons count as gamepad use too. Keying this off the sticks alone
        // meant a player who only pressed buttons never got controller prompts.
        if (d) this.onPadPress();
      }
      this.prevPadButtons[i] = d;
    }

    this.fireAxis = clamp(b[7]?.value ?? 0, 0, 1);
    this.aimAxis = clamp(b[6]?.value ?? 0, 0, 1);
    const padFire = this.fireAxis > TRIGGER_PULL;
    if (padFire !== this.prevPadFire) {
      this.set('fire', padFire);
      this.prevPadFire = padFire;
      if (padFire) this.onPadPress();
    }
    const padAim = this.aimAxis > TRIGGER_PULL;
    if (padAim !== this.prevPadAim) {
      this.set('aim', padAim);
      this.prevPadAim = padAim;
      if (padAim) this.onPadPress();
    }

    // Super is both shoulders, the console convention for a committed input that
    // must never fire by accident. It is driven on the edge of the *pair* so it
    // reads as one press rather than re-triggering while both are held.
    const superNow = !!b[4]?.pressed && !!b[5]?.pressed;
    if (superNow !== (this.prevPadButtons[SUPER_SLOT] ?? false)) this.set('super', superNow);
    this.prevPadButtons[SUPER_SLOT] = superNow;
  }
}
