# Controller Support

Full support for any pad Chromium reports in the W3C **standard mapping**, which
covers the DualSense (PS5) over both USB and Bluetooth, DualShock 4, Xbox
controllers and most third-party pads. Nothing is PlayStation-specific except the
on-screen glyphs.

## Layout

| PS5 | Standard index | Action |
|---|---|---|
| ✕ | 0 | Jump |
| ○ | 1 | Melee |
| □ | 2 | Reload |
| △ | 3 | Swap weapon |
| L1 | 4 | Grenade |
| R1 | 5 | Class ability |
| L2 | 6 | Aim (analog) |
| R2 | 7 | Fire (analog) |
| Create | 8 | Star map |
| Options | 9 | Pause |
| L3 | 10 | Sprint |
| R3 | 11 | Crouch / slide |
| D-pad ↑ | 12 | Interact |
| D-pad ↓ | 13 | Flashlight |
| D-pad ← | 14 | Weapon slot 1 |
| D-pad → | 15 | Weapon slot 2 |
| L1 + R1 | — | Super |

Menus take the d-pad and left stick for navigation, ✕ to confirm and ○ to go
back. Legends across the pause menu, settings and star map switch to these glyphs
the moment the pad is touched, and back to keyboard prompts on the next mouse
move — a prompt naming the wrong device is worse than no prompt.

## Aim assist

`src/gameplay/AimAssist.ts`. A thumbstick gives roughly two orders of magnitude
less angular precision than a mouse; a shooter that treats them identically is
not "harder" on a pad, it is unplayable. Two effects, both standard, both
gamepad-only, both scaled by the **Aim Assist** setting:

- **Friction** — look speed drops as the crosshair crosses a target, so a stick
  that would have swept past it lingers instead. Measured: sweeping across a
  target 18 m away, the view turns 2.85° with assist off and 1.74° with it on,
  and the crosshair ends 0.16° from the target instead of 2.1°.
- **Adhesion** — a small rotation toward the target, scaled by how hard the
  player is *already* pushing the stick. That gate is the whole trick: with the
  stick at rest the view turns **0.00°** no matter how close the target is, so
  the assist can never drag a deliberately still aim.

The cone is 9° plus whatever the target subtends, so assist is strong in a brawl
and nearly absent at sniping range without any special-casing. Friction ramps
0.85 → 0.38 as the crosshair closes.

**Bullet magnetism is deliberately absent.** It is the other half of the console
toolkit, and it makes misses count as hits — a much larger change to the game's
feel than helping the camera arrive. Shots still go exactly where the crosshair
points.

## Vibration

`src/core/Haptics.ts`, driven off the same events audio subscribes to, so the two
can never disagree about what just happened. The web exposes only
`dual-rumble` — there is no trigger-effect API, so the DualSense's adaptive
triggers are out of reach and the variety has to come from duration and the
balance between the two motors.

Two rules stop it turning to mush: the strongest effect wins rather than adding,
and nothing re-triggers under its own tail. Firing is a light tick so it can
repeat ten times a second; taking damage is heavy and short so it cuts through;
only a super uses both motors at full for longer than a fifth of a second.

## Settings

Gameplay page: **Stick Sensitivity** (deg/s at full deflection), **Stick
Deadzone**, **Aim Assist**, **Vibration**. Invert Look and ADS Sensitivity apply
to both devices.

The deadzone is **radial**, not per-axis. A per-axis deadzone carves a *square*
hole out of the stick's circle — pushed straight up, x sits inside the zone and
drops to nothing, but 30° off vertical the same tiny x suddenly counts — so
shallow diagonals snap to the cardinals. Gating on the vector's magnitude keeps
the direction the player chose, which is why the default can be 0.08 rather than
the 0.15 a square deadzone needs to hide its artefact.

## One thing a controller cannot do

Browsers do not count a gamepad button as a user activation, so a pad alone
cannot start the audio context. A controller-only player would otherwise reach
the star map in silence with no explanation. On the first pad press with the
context still suspended the game says so once, in a toast: press any key or click
once. Nothing in the page can work around this.

## Mouse look needs the pointer, and something has to ask for it

`onMouseMove` reads `movementX`, which the browser only delivers under pointer
lock, and pointer lock can only be requested from a user gesture. Landing on a
planet sets `engine.state = 'playing'` directly — not a gesture — so nothing can
claim the pointer at that moment. The first click is the gesture, and
`Input.autoPointerLock` is how the UI says whether that click belongs to the
world or to a menu: `UiRoot.render` sets it whenever no menu is up and the state
is `playing` or `starmap`, and `Input.onMouseDown` claims the pointer instead of
pulling the trigger when it is set.

The click that captures deliberately does not fire. Clicking back into a window
should not cost a round, and on a hair trigger it costs a burst.

A **Click to look** prompt shows while the world wants the pointer and does not
have it, and is hidden entirely on a pad, which never needs the lock. If a
request is refused — Chromium blocks one briefly after the player presses Esc to
escape a lock — nothing needs to recover: the flag stays set and the prompt stays
up, so the next click tries again.

## Testing without hardware

`tools/critic/` has no gamepad, so the harness installs a **virtual DualSense**:
it overrides `navigator.getGamepads` with a standard-mapping object driven from
Node, including a `vibrationActuator` that logs every effect. See the scratch
harness in the controller commit for the shape.

One trap is worth knowing about. The pad is only polled inside a simulation step,
and a frame under the software rasteriser is over a second, so a probe that sets
a button and reads 400 ms later reads state from before the input was applied —
which looks exactly like "gamepad support is completely broken". Always wait for
`GF.engine.tick` to advance before sampling, and hold a menu button for at least
one full frame.

`GF.game.player.aimAssistDebug` exposes the last assist result — candidate count,
angle to the chosen target, cone size and friction scale — which is what makes
the assist testable at all.
