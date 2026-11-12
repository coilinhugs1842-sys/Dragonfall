/**
 * Gamepad -> the `pad*` fields of InputState, with no DOM in sight: ./gamepad-source.ts hands
 * it the pad object the browser returned for this frame, tests hand it a plain object.
 *
 * `pollGamepad` copies NUMBERS out of the pad and keeps no reference to it (the browser makes
 * new snapshot objects on every `navigator.getGamepads()`). Nothing here allocates after
 * `createGamepadState` / `setGamepadBindings`.
 *
 * WHAT MAPS TO WHAT (the sim sees the same InputFrame as from mouse and keys):
 * - Left stick = the reticle. The mouse moves the reticle by deltas; the stick sets it outright:
 *   stick position = reticle position, back to the centre when released. A radial dead zone
 *   (rescaled, so the reticle starts at 0 on its edge) and the sensitivity give the reticle; the
 *   response curve then gives the steer, exactly as the mouse path curves its reticle.
 * - Right stick = the analogue W/S and A/D: it scales the same small fine pitch / yaw term, and
 *   pushed nearly all the way sideways it also holds `turnLeft` / `turnRight` (the roll that
 *   A/D give).
 * - Buttons = actions, through the pad's own rebind table (./gamepad-bindings.ts). Every button
 *   is read as an analogue value with hysteresis, so a finger resting on a trigger does not
 *   flutter it; a digital button is simply 0 or 1.
 * - Dodge = flick the left stick sideways while the pad's boost button is held (`PadFlickLeft` /
 *   `PadFlickRight` in the table). It is a one-frame press, like a tap on Q or E.
 * - Menu (Start) = pause: never an action, the game layer asks with `consumeGamepadPause`.
 * - While a menu is in front (no flight input) the same buttons and the left stick step
 *   through it: ./gamepad-menu.ts.
 *
 * WHO STEERS. The pad takes the reticle when the left stick MOVES outside its dead zone, not
 * while it merely sits there: a worn stick that rests off-centre, or one held still while the
 * mouse is moved, never pulls the reticle back. The mouse takes it by moving.
 *
 * NON-STANDARD PADS (`mapping` is not "standard": no known layout for this device in this
 * browser) are read with the SAME indices: buttons 0..16 and axes 0..3. For many that is right
 * or close; for others buttons are swapped or a trigger sits on an axis. Nothing can be known
 * about them here, so nothing is guessed: missing buttons and axes read as released / centred,
 * and the rule above keeps an axis that rests at -1 from steering until it is moved. Their axes
 * are ignored altogether until one of their buttons was pressed: laptops list tilt sensors and
 * the like as "gamepads" whose axes wander by themselves, and those must never take the reticle
 * from a mouse player. (A standard pad needs no such proof: browsers only reveal one after a
 * button press.)
 */
import { inputActionBit, INPUT_ACTIONS } from './bindings';
import type { InputBindings } from './bindings';
import {
  DEFAULT_GAMEPAD_BINDINGS,
  GAMEPAD_BUTTON_COUNT,
  GAMEPAD_FLICK_LEFT,
  GAMEPAD_FLICK_RIGHT,
  GAMEPAD_MENU_BUTTON,
  gamepadButtonIndex,
} from './gamepad-bindings';
import { inputPadActions, inputPadPulse, releasePadInput } from './input-state';
import type { InputState } from './input-state';
import { reticleSteerGain } from './reticle';

/** The part of a `GamepadButton` that is read. */
export interface GamepadButtonLike {
  readonly pressed?: boolean;
  readonly value?: number;
}

/** The part of a browser `Gamepad` that is read (a real one fits; so does a test's object). */
export interface GamepadLike {
  readonly id: string;
  readonly connected?: boolean;
  /** "standard" when the browser knows the layout; '' otherwise. */
  readonly mapping?: string;
  /** Standard order: left x, left y, right x, right y; y is DOWN-positive. */
  readonly axes: ArrayLike<number>;
  readonly buttons: ArrayLike<GamepadButtonLike | null | undefined>;
  /** Rumble motor, where the browser has one. Only ./gamepad-source.ts looks at it. */
  readonly vibrationActuator?: unknown;
}

/** Player-facing gamepad settings. Plain values: store as JSON. */
export interface GamepadOptions {
  /**
   * Multiplier on the left stick's reach, like the mouse sensitivity: above 1 the reticle is at
   * the rim before the stick is; below 1 it cannot reach the rim at all (a gentler dragon).
   */
  sensitivity: number;
  /** true: pushing a stick forward lowers the nose (flight-stick style). Both sticks. */
  invertY: boolean;
  /** Fraction of a stick's travel round its centre that gives nothing. Both sticks. */
  deadZone: number;
  /** Left stick response curve: 1 = linear, above 1 = finer control near the centre. */
  curveExponent: number;
  /** A button or trigger counts as pressed from this value up (0..1) ... */
  triggerPress: number;
  /** ... and as released again only at or below this one. */
  triggerRelease: number;
  /**
   * A dodge flick must get from near the centre to the edge within this many ms, so steering
   * hard while boosting is not a dodge. 0 = no limit: any push to the edge counts.
   */
  flickWindowMs: number;
  /** Let `rumble()` shake the pad. Off until the Settings menu has a switch for it. */
  rumble: boolean;
}

/** First-pass feel values (the object is read on every poll: edit it at any time). */
export const DEFAULT_GAMEPAD_OPTIONS: Readonly<GamepadOptions> = {
  sensitivity: 1,
  invertY: false,
  deadZone: 0.15,
  curveExponent: 1.6,
  triggerPress: 0.5,
  triggerRelease: 0.35,
  flickWindowMs: 200,
  rumble: false,
};

export interface GamepadState {
  /** Live settings: write a field at any time, it is read on the next poll. */
  readonly options: GamepadOptions;
  /** A pad is being read. */
  connected: boolean;
  /** Its slot in `navigator.getGamepads()`; -1 without a pad. */
  index: number;
  /** `Gamepad.id` (vendor / product text) for the settings page; '' without a pad. */
  id: string;
  /** The browser knows the pad's layout. false: read by the same indices, unverified. */
  standard: boolean;
  /**
   * The sticks count. Always for a standard pad; for an unknown layout only once one of its
   * buttons was pressed, which shows that a person holds it (see NON-STANDARD PADS above).
   */
  awake: boolean;
  /**
   * Bitmask of `inputActionBit`: actions held by the pad's buttons right now. Kept up to date
   * while flight input is off too (a spectator's scoreboard button).
   */
  actions: number;
  /**
   * The left stick as it sits (x right, y UP, no dead zone), also while flight input is off:
   * what ./gamepad-menu.ts steps through the menus with. 0 until the pad is `awake`.
   */
  leftX: number;
  leftY: number;
  // --- Lookup tables, rebuilt by setGamepadBindings ---
  bindings: InputBindings;
  /** Per button: the action bits it triggers. */
  readonly buttonActions: Int32Array;
  flickLeftActions: number;
  flickRightActions: number;
  // --- Poll-to-poll memory ---
  /** Per button: 1 while it is physically down (after hysteresis). */
  readonly buttonDown: Uint8Array;
  /** Per button: 1 = was down when the pad was released; ignored until it has been let go. */
  readonly buttonBlocked: Uint8Array;
  /** The last poll fed flight input. A change releases the pad, like a lost pointer lock. */
  flight: boolean;
  /** The left stick owned the reticle on the last poll. */
  ownsSteer: boolean;
  /** Where the left stick sat when it last rested or lost the reticle: it must leave here. */
  restX: number;
  restY: number;
  /** The right stick was outside its dead zone on the last poll. */
  fineOut: boolean;
  /** -1 / 0 / 1: the right stick holds a roll (with hysteresis). */
  roll: number;
  /** The boost button was held on the last poll (a flick only counts while it is). */
  flickBoost: boolean;
  /** Time the stick was last NOT on that side, while boost was held; -1 = must come back first. */
  flickLeftMs: number;
  flickRightMs: number;
  /** Time of the last Menu press that nobody consumed yet; -1 = none. */
  pauseAtMs: number;
  /** The last button pressed that nobody consumed yet (for rebinding), and when; -1 = none. */
  pressButton: number;
  pressAtMs: number;
}

/** The stick must travel this far from where it rested before it takes the reticle. */
const TAKEOVER_DISTANCE = 0.1;
/** Right stick x (after the dead zone) from which a roll is held, and where it lets go. */
const ROLL_PRESS = 0.8;
const ROLL_RELEASE = 0.65;
/** Left stick |x| that counts as "back near the centre" and as "at the edge" for a flick. */
const FLICK_INNER = 0.35;
const FLICK_OUTER = 0.8;
/** An unread Menu or rebind press is forgotten after this long (nobody was asking). */
const PRESS_MEMORY_MS = 500;

const BIT_BOOST = inputActionBit('boost');
const BIT_TURN_LEFT = inputActionBit('turnLeft');
const BIT_TURN_RIGHT = inputActionBit('turnRight');

/**
 * Factor for BOTH raw stick axes that gives the reticle offset: 0 inside the dead zone, growing
 * from 0 on its edge, times `sensitivity`, and never outside the unit circle (so a stick in the
 * corner of a square gate is no further out than one pushed straight).
 */
export function stickReticleGain(magnitude: number, deadZone: number, sensitivity: number): number {
  const linear = reticleSteerGain(magnitude, deadZone, 1);
  if (!(linear > 0) || !(sensitivity > 0)) return 0;
  const gain = linear * sensitivity;
  return gain * magnitude > 1 ? 1 / magnitude : gain;
}

/**
 * Factor for BOTH raw stick axes that gives the steer vector: the reticle offset of
 * `stickReticleGain` through the response curve. Length 1 with the reticle on the rim.
 */
export function stickSteerGain(
  magnitude: number,
  deadZone: number,
  sensitivity: number,
  exponent: number,
): number {
  const gain = stickReticleGain(magnitude, deadZone, sensitivity);
  if (gain === 0) return 0;
  return gain * reticleSteerGain(gain * magnitude, 0, exponent);
}

/**
 * Whether a button or trigger at `value` (0..1) is down, given whether it was: it goes down at
 * `press` and comes up at `release`, so a value hovering between the two changes nothing.
 * Unusable thresholds fall back to the defaults.
 */
export function buttonIsDown(
  value: number,
  wasDown: boolean,
  press: number,
  release: number,
): boolean {
  const p = press > 0 && press <= 1 ? press : DEFAULT_GAMEPAD_OPTIONS.triggerPress;
  if (!wasDown) return value >= p;
  const r = release >= 0 && release < p ? release : p * 0.7;
  return value > r;
}

export function createGamepadState(
  bindings: InputBindings = DEFAULT_GAMEPAD_BINDINGS,
  options: Partial<GamepadOptions> = {},
): GamepadState {
  const gp: GamepadState = {
    options: { ...DEFAULT_GAMEPAD_OPTIONS, ...options },
    connected: false,
    index: -1,
    id: '',
    standard: false,
    awake: false,
    actions: 0,
    leftX: 0,
    leftY: 0,
    bindings,
    buttonActions: new Int32Array(GAMEPAD_BUTTON_COUNT),
    flickLeftActions: 0,
    flickRightActions: 0,
    buttonDown: new Uint8Array(GAMEPAD_BUTTON_COUNT),
    buttonBlocked: new Uint8Array(GAMEPAD_BUTTON_COUNT),
    flight: false,
    ownsSteer: false,
    restX: 0,
    restY: 0,
    fineOut: false,
    roll: 0,
    flickBoost: false,
    flickLeftMs: -1,
    flickRightMs: -1,
    pauseAtMs: -1,
    pressButton: -1,
    pressAtMs: -1,
  };
  writeBindingTables(gp, bindings);
  return gp;
}

function writeBindingTables(gp: GamepadState, bindings: InputBindings): void {
  gp.bindings = bindings;
  gp.buttonActions.fill(0);
  gp.flickLeftActions = 0;
  gp.flickRightActions = 0;
  for (const action of INPUT_ACTIONS) {
    const bit = inputActionBit(action);
    for (const code of bindings[action]) {
      if (code === GAMEPAD_FLICK_LEFT) gp.flickLeftActions |= bit;
      else if (code === GAMEPAD_FLICK_RIGHT) gp.flickRightActions |= bit;
      else {
        const button = gamepadButtonIndex(code);
        // Menu is the pause button whatever a hand-edited table says.
        if (button >= 0 && button !== GAMEPAD_MENU_BUTTON) {
          gp.buttonActions[button] = (gp.buttonActions[button] ?? 0) | bit;
        }
      }
    }
  }
}

/**
 * Installs the pad's rebind table. Releases the pad (a button held across the change would
 * otherwise jump to its new action). Call it on a rebind only.
 */
export function setGamepadBindings(
  gp: GamepadState,
  input: InputState,
  bindings: InputBindings,
): void {
  writeBindingTables(gp, bindings);
  releaseGamepad(gp, input);
}

/**
 * Lets go of everything the pad holds, as `releaseAllInput` does for keys: its actions end, both
 * sticks read as centred (the reticle too, if the stick owned it) and a button that is still
 * physically down counts again only after it was let go. The sticks are live again on the next
 * poll: an axis is a position, not a key that could stick. Use when focus is lost, the tab is
 * hidden or flight input is switched off or on.
 */
export function releaseGamepad(gp: GamepadState, input: InputState): void {
  gp.buttonBlocked.set(gp.buttonDown);
  gp.actions = 0;
  gp.fineOut = false;
  gp.roll = 0;
  gp.flickBoost = false;
  gp.flickLeftMs = -1;
  gp.flickRightMs = -1;
  releasePadInput(input);
  if (input.steerDevice === 'gamepad') {
    input.reticleX = 0;
    input.reticleY = 0;
  }
}

/** The pad is gone: everything is released and the keyboard and mouse own the input again. */
export function disconnectGamepad(gp: GamepadState, input: InputState): void {
  releaseGamepad(gp, input);
  gp.buttonDown.fill(0);
  gp.buttonBlocked.fill(0);
  gp.connected = false;
  gp.index = -1;
  gp.id = '';
  gp.standard = false;
  gp.awake = false;
  gp.leftX = 0;
  gp.leftY = 0;
  gp.ownsSteer = false;
  gp.pauseAtMs = -1;
  gp.pressButton = -1;
  input.steerDevice = 'keyboard';
  input.activeDevice = 'keyboard';
}

/** A missing, NaN or out-of-range axis reads as centred / clamped. */
function readAxis(axes: ArrayLike<number>, index: number): number {
  const value = index < axes.length ? axes[index] : 0;
  if (value === undefined || !(value >= -1)) return value !== undefined && value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}

/**
 * A vertical axis with y UP, as the reticle has it (the Gamepad API's y grows downward).
 * `0 - x` and not `-x`, so a centred stick reads 0 and never -0.
 */
function readAxisUp(axes: ArrayLike<number>, index: number): number {
  return 0 - readAxis(axes, index);
}

/**
 * Reads one pad. Call once per rendered frame (more often is harmless).
 *
 * - `pad`: the browser's object for this frame, or null when there is none (releases everything
 *   if there was one). `index`: its slot, to notice that another pad took over.
 * - `nowMs`: any monotonic clock; it times the dodge flick and the two press memories.
 * - `flight`: whether the game wants flight input now. false (a menu, a spectator): buttons are
 *   still followed, for `actions` and the pause button, but nothing reaches `input`.
 */
export function pollGamepad(
  gp: GamepadState,
  input: InputState,
  pad: GamepadLike | null,
  index: number,
  nowMs: number,
  flight: boolean,
): void {
  if (pad === null) {
    if (gp.connected) disconnectGamepad(gp, input);
    return;
  }
  const axes = pad.axes;
  if (!gp.connected || gp.index !== index) {
    if (gp.connected) disconnectGamepad(gp, input);
    gp.connected = true;
    gp.index = index;
    gp.id = typeof pad.id === 'string' ? pad.id : '';
    gp.standard = pad.mapping === 'standard';
    gp.awake = gp.standard;
    gp.flight = flight;
    // Wherever the stick sits now is its resting place until it moves (worn sticks, odd pads).
    gp.restX = readAxis(axes, 0);
    gp.restY = readAxisUp(axes, 1);
  }
  if (flight !== gp.flight) {
    gp.flight = flight;
    releaseGamepad(gp, input);
  }

  // --- Buttons ---------------------------------------------------------------------------------
  const options = gp.options;
  const buttons = pad.buttons;
  const count = buttons.length < GAMEPAD_BUTTON_COUNT ? buttons.length : GAMEPAD_BUTTON_COUNT;
  const down = gp.buttonDown;
  const blocked = gp.buttonBlocked;
  let actions = 0;
  let meaningful = false;
  for (let i = 0; i < GAMEPAD_BUTTON_COUNT; i++) {
    const button = i < count ? buttons[i] : undefined;
    let value = 0;
    if (button !== undefined && button !== null) {
      const analogue = button.value;
      // Some pads only say `pressed`; NaN fails the comparison and lands there too.
      value = analogue !== undefined && analogue > 0 ? analogue : button.pressed === true ? 1 : 0;
    }
    const was = down[i] === 1;
    const now = buttonIsDown(value, was, options.triggerPress, options.triggerRelease);
    down[i] = now ? 1 : 0;
    if (!now) {
      blocked[i] = 0;
      continue;
    }
    if (blocked[i] === 1) continue;
    actions |= gp.buttonActions[i] ?? 0;
    if (!was) {
      meaningful = true;
      gp.pressButton = i;
      gp.pressAtMs = nowMs;
      if (i === GAMEPAD_MENU_BUTTON) gp.pauseAtMs = nowMs;
      if (!gp.awake) {
        // Somebody holds this unknown device. Its axes count from here on, measured from
        // where they sit right now.
        gp.awake = true;
        gp.restX = readAxis(axes, 0);
        gp.restY = readAxisUp(axes, 1);
      }
    }
  }
  gp.actions = actions;
  // The menus read the stick too, so it is kept whether or not flight input is wanted.
  const leftX = gp.awake ? readAxis(axes, 0) : 0;
  const leftY = gp.awake ? readAxisUp(axes, 1) : 0;
  gp.leftX = leftX;
  gp.leftY = leftY;
  if (!flight || !gp.awake) return;

  // --- Left stick: the reticle -----------------------------------------------------------------
  const leftLength = Math.sqrt(leftX * leftX + leftY * leftY);
  const outside = reticleSteerGain(leftLength, options.deadZone, 1) > 0;
  if (input.steerDevice !== 'gamepad') {
    if (gp.ownsSteer) {
      // The mouse took the reticle: a stick still held where it was must not take it back.
      gp.ownsSteer = false;
      gp.restX = leftX;
      gp.restY = leftY;
    } else if (!outside) {
      gp.restX = leftX;
      gp.restY = leftY;
    }
    const movedX = leftX - gp.restX;
    const movedY = leftY - gp.restY;
    if (outside && movedX * movedX + movedY * movedY > TAKEOVER_DISTANCE * TAKEOVER_DISTANCE) {
      input.steerDevice = 'gamepad';
      meaningful = true;
    }
  }
  if (input.steerDevice === 'gamepad') {
    gp.ownsSteer = true;
    const stickY = options.invertY ? -leftY : leftY;
    const reticle = stickReticleGain(leftLength, options.deadZone, options.sensitivity);
    input.reticleX = leftX * reticle;
    input.reticleY = stickY * reticle;
    const steer = stickSteerGain(
      leftLength,
      options.deadZone,
      options.sensitivity,
      options.curveExponent,
    );
    input.padSteerX = leftX * steer;
    input.padSteerY = stickY * steer;
  }

  // --- Right stick: fine pitch / yaw, and the roll of A/D at the far ends ------------------------
  const rightX = readAxis(axes, 2);
  const rightY = readAxisUp(axes, 3);
  const fine = reticleSteerGain(Math.sqrt(rightX * rightX + rightY * rightY), options.deadZone, 1);
  const fineX = rightX * fine;
  input.padFineX = fineX;
  input.padFineY = (options.invertY ? -rightY : rightY) * fine;
  if (fine > 0 && !gp.fineOut) meaningful = true;
  gp.fineOut = fine > 0;
  if (gp.roll > 0 && !(fineX > ROLL_RELEASE)) gp.roll = 0;
  else if (gp.roll < 0 && !(fineX < -ROLL_RELEASE)) gp.roll = 0;
  if (gp.roll === 0) gp.roll = fineX >= ROLL_PRESS ? 1 : fineX <= -ROLL_PRESS ? -1 : 0;
  let held = actions;
  if (gp.roll > 0) held |= BIT_TURN_RIGHT;
  else if (gp.roll < 0) held |= BIT_TURN_LEFT;
  inputPadActions(input, held);

  // --- Dodge: a sideways flick of the left stick while boost is held ----------------------------
  if ((actions & BIT_BOOST) !== 0) {
    if (!gp.flickBoost) {
      // Boost just went down: a stick already held over must come back before it can flick.
      gp.flickBoost = true;
      gp.flickLeftMs = -1;
      gp.flickRightMs = -1;
    }
    const window = options.flickWindowMs;
    const sideways = Math.abs(leftX) > Math.abs(leftY);
    if (leftX > -FLICK_INNER) {
      gp.flickLeftMs = nowMs;
    } else if (leftX <= -FLICK_OUTER && gp.flickLeftMs >= 0) {
      if (sideways && (!(window > 0) || nowMs - gp.flickLeftMs <= window)) {
        inputPadPulse(input, gp.flickLeftActions);
      }
      // One dodge per flick: nothing more until the stick has come back.
      gp.flickLeftMs = -1;
    }
    if (leftX < FLICK_INNER) {
      gp.flickRightMs = nowMs;
    } else if (leftX >= FLICK_OUTER && gp.flickRightMs >= 0) {
      if (sideways && (!(window > 0) || nowMs - gp.flickRightMs <= window)) {
        inputPadPulse(input, gp.flickRightActions);
      }
      gp.flickRightMs = -1;
    }
  } else {
    gp.flickBoost = false;
  }

  if (meaningful) input.activeDevice = 'gamepad';
}

/**
 * True once per press of Menu (Start), for the game layer's pause menu. Works while flight
 * input is off, so the same button closes the menu. A press nobody asked about within half a
 * second is forgotten (a press in the lobby must not pause the match that starts later).
 */
export function consumeGamepadPause(gp: GamepadState, nowMs: number): boolean {
  const at = gp.pauseAtMs;
  gp.pauseAtMs = -1;
  return at >= 0 && nowMs - at <= PRESS_MEMORY_MS;
}

/**
 * The `Gamepad.buttons` index of a button pressed since the last call, or -1. For the Controls
 * tab while it listens for a new binding (works while flight input is off). Forgets like
 * `consumeGamepadPause`; call it once when listening starts to drop an older press.
 */
export function consumeGamepadPress(gp: GamepadState, nowMs: number): number {
  const button = gp.pressButton;
  const at = gp.pressAtMs;
  gp.pressButton = -1;
  return button >= 0 && nowMs - at <= PRESS_MEMORY_MS ? button : -1;
}
