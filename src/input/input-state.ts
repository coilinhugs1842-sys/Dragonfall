/**
 * Device state -> InputFrame, with no DOM in sight: ./input-controller.ts feeds it key codes and
 * mouse deltas from browser events, tests feed it the same calls in node.
 *
 * Nothing here allocates after `createInputState` / `setInputBindings` (which run at boot and on
 * a rebind): the event-side functions and `sampleInput` only read and write numbers in
 * preallocated tables, so they are safe in event handlers and in the 30 Hz tick.
 *
 * STEER = reticle (mouse) + keys, clamped to [-1, 1] per axis:
 * - the reticle offset goes through the dead zone and response curve of ./reticle.ts;
 * - W/S add `keyPitchSteer`, A/D add `keyYawSteer` (small on purpose: A/D mainly roll, through
 *   BUTTON_ROLL_LEFT/RIGHT, see ./bindings.ts).
 *
 * TAPS: an action pressed and released between two samples (a dodge tap shorter than 33 ms)
 * is latched and still reported as held for exactly one frame.
 */
import {
  BUTTON_AIM,
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_DODGE_RIGHT,
  BUTTON_FLAP,
  BUTTON_PRIMARY,
  BUTTON_ROLL_LEFT,
  BUTTON_ROLL_RIGHT,
  BUTTON_SECONDARY,
  BUTTON_ULTIMATE,
  BUTTON_UTILITY,
  TICK_DT_S,
} from '../shared';
import type { InputFrame } from '../shared';
import { DEFAULT_BINDINGS, INPUT_ACTIONS, inputActionBit } from './bindings';
import type { InputAction, InputBindings, InputCode } from './bindings';
import { reticleDecay, reticleSteerGain, reticleUnitsPerCount, unitCircleScale } from './reticle';

/** Player-facing input settings (Settings menu, T-3.9). Plain numbers: store as JSON. */
export interface InputOptions {
  /** Multiplier on mouse movement. 1 = `reticleRadiusCounts` counts from centre to rim. */
  sensitivity: number;
  /** true: pushing the mouse forward lowers the nose (flight-stick style). */
  invertY: boolean;
  /** true: W lowers the nose and S raises it. */
  invertKeyPitch: boolean;
  /** Mouse counts (pixels of movement at sensitivity 1) from the centre to the rim. */
  reticleRadiusCounts: number;
  /** Fraction of the radius round the centre that gives no steer. */
  deadZone: number;
  /** Response curve exponent: 1 = linear, above 1 = finer control near the centre. */
  curveExponent: number;
  /** 1/s. How fast the reticle eases back to the centre. 0 = it stays where it is put. */
  recenterRate: number;
  /** Steer added by W/S and by A/D, 0..1. */
  keyPitchSteer: number;
  keyYawSteer: number;
  /**
   * A single mouse event larger than this many counts on either axis is dropped: browsers
   * sometimes report one huge bogus delta right after pointer lock or a window switch.
   */
  maxMouseDeltaCounts: number;
  /** true: one press of the boost key turns boost on, the next turns it off. */
  boostToggle: boolean;
}

/** First-pass feel values; tune with the dev GUI (the object is read on every call). */
export const DEFAULT_INPUT_OPTIONS: Readonly<InputOptions> = {
  sensitivity: 1,
  invertY: false,
  invertKeyPitch: false,
  reticleRadiusCounts: 220,
  deadZone: 0.06,
  curveExponent: 1.5,
  recenterRate: 1.2,
  keyPitchSteer: 0.6,
  keyYawSteer: 0.3,
  maxMouseDeltaCounts: 1500,
  boostToggle: false,
};

export const MIN_SENSITIVITY = 0.1;
export const MAX_SENSITIVITY = 5;

export interface InputState {
  /** Live settings: write a field at any time, it is read on the next event or sample. */
  readonly options: InputOptions;
  /**
   * Reticle offset inside the unit circle, x right and y UP, both in [-1, 1]. This is the raw
   * offset (before dead zone and curve): draw the HUD reticle from it.
   */
  reticleX: number;
  reticleY: number;
  /** Bitmask of `inputActionBit`: actions held right now. */
  heldActions: number;
  /** Actions pressed since the last sample (so a tap between two samples is not lost). */
  latchedActions: number;
  /** Sum of `heldActions` as sampled for the most recent frame (includes latched taps). */
  sampledActions: number;
  /** `options.boostToggle`: boost is latched on (flipped by each press of the boost key). */
  boostLatched: boolean;
  /**
   * Where abilities are aimed (`InputFrame.aimYaw/aimPitch`: a world-space direction). The
   * module that owns the camera writes it once per rendered frame with `setInputAim`; while
   * `aimValid` is false the frames carry no aim and shots go along the nose.
   */
  aimYaw: number;
  aimPitch: number;
  aimValid: boolean;
  // --- Lookup tables, rebuilt by setInputBindings ---
  bindings: InputBindings;
  /** Code -> slot index in the two arrays below. */
  readonly codeSlots: Map<InputCode, number>;
  /** Per bound code: the action bits it triggers (several when a code is shared). */
  slotActions: Int32Array;
  /** Per bound code: 1 while the key or button is down. */
  slotHeld: Uint8Array;
  slotCount: number;
}

/** Index = action index (INPUT_ACTIONS). 0 = the action is not a sim button. */
const ACTION_BUTTONS = new Int32Array(INPUT_ACTIONS.length);
function mapButton(action: InputAction, button: number): void {
  ACTION_BUTTONS[INPUT_ACTIONS.indexOf(action)] = button;
}
mapButton('turnLeft', BUTTON_ROLL_LEFT);
mapButton('turnRight', BUTTON_ROLL_RIGHT);
mapButton('boost', BUTTON_BOOST);
mapButton('flap', BUTTON_FLAP);
mapButton('dive', BUTTON_DIVE);
mapButton('dodgeLeft', BUTTON_DODGE_LEFT);
mapButton('dodgeRight', BUTTON_DODGE_RIGHT);
mapButton('primary', BUTTON_PRIMARY);
mapButton('secondary', BUTTON_SECONDARY);
mapButton('utility', BUTTON_UTILITY);
mapButton('ultimate', BUTTON_ULTIMATE);

const ACTION_COUNT = INPUT_ACTIONS.length;
const BIT_PITCH_UP = inputActionBit('pitchUp');
const BIT_PITCH_DOWN = inputActionBit('pitchDown');
const BIT_TURN_LEFT = inputActionBit('turnLeft');
const BIT_TURN_RIGHT = inputActionBit('turnRight');
const BIT_BOOST = inputActionBit('boost');

function clampUnit(value: number): number {
  if (!(value >= -1)) return value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}

function clampFraction(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

export function createInputState(
  bindings: InputBindings = DEFAULT_BINDINGS,
  options: Partial<InputOptions> = {},
): InputState {
  const state: InputState = {
    options: { ...DEFAULT_INPUT_OPTIONS, ...options },
    reticleX: 0,
    reticleY: 0,
    heldActions: 0,
    latchedActions: 0,
    sampledActions: 0,
    boostLatched: false,
    aimYaw: 0,
    aimPitch: 0,
    aimValid: false,
    bindings,
    codeSlots: new Map(),
    slotActions: new Int32Array(0),
    slotHeld: new Uint8Array(0),
    slotCount: 0,
  };
  setInputBindings(state, bindings);
  return state;
}

/**
 * Installs a rebind table. Releases every key (a key held across the change would otherwise
 * stick to its old action) but leaves the reticle alone. Allocates: call it on a rebind only.
 */
export function setInputBindings(state: InputState, bindings: InputBindings): void {
  state.bindings = bindings;
  state.codeSlots.clear();
  let count = 0;
  for (const action of INPUT_ACTIONS) {
    for (const code of bindings[action]) {
      if (!state.codeSlots.has(code)) state.codeSlots.set(code, count++);
    }
  }
  state.slotActions = new Int32Array(count);
  state.slotHeld = new Uint8Array(count);
  state.slotCount = count;
  for (const action of INPUT_ACTIONS) {
    const bit = inputActionBit(action);
    for (const code of bindings[action]) {
      const slot = state.codeSlots.get(code);
      if (slot !== undefined) state.slotActions[slot] = (state.slotActions[slot] ?? 0) | bit;
    }
  }
  state.heldActions = 0;
  state.latchedActions = 0;
  state.sampledActions = 0;
  state.boostLatched = false;
}

/** True when the code is bound to an action (the shell calls preventDefault for those only). */
export function isCodeBound(state: InputState, code: InputCode): boolean {
  return state.codeSlots.has(code);
}

/** A key or mouse button went down. Returns whether the code is bound. */
export function inputCodeDown(state: InputState, code: InputCode): boolean {
  const slot = state.codeSlots.get(code);
  if (slot === undefined) return false;
  const actions = state.slotActions[slot] ?? 0;
  // A press edge of the boost key flips the latch (a second key bound to boost, or a repeat
  // the caller did not filter, does not).
  if (
    (actions & BIT_BOOST) !== 0 &&
    state.slotHeld[slot] !== 1 &&
    (state.heldActions & BIT_BOOST) === 0
  ) {
    state.boostLatched = !state.boostLatched;
  }
  state.slotHeld[slot] = 1;
  state.heldActions |= actions;
  state.latchedActions |= actions;
  return true;
}

/** A key or mouse button went up. Returns whether the code is bound. */
export function inputCodeUp(state: InputState, code: InputCode): boolean {
  const slot = state.codeSlots.get(code);
  if (slot === undefined) return false;
  state.slotHeld[slot] = 0;
  // Rebuild rather than clear bits: another held key may be bound to the same action.
  let held = 0;
  for (let i = 0; i < state.slotCount; i++) {
    if (state.slotHeld[i] === 1) held |= state.slotActions[i] ?? 0;
  }
  state.heldActions = held;
  return true;
}

/**
 * Mouse movement in counts (`MouseEvent.movementX/Y`: x right, y DOWN). Moves the reticle and
 * keeps it inside the circle. Non-finite and absurdly large deltas are ignored.
 */
export function inputMouseMove(state: InputState, dx: number, dy: number): void {
  const options = state.options;
  const limit = options.maxMouseDeltaCounts;
  if (!(Math.abs(dx) <= limit) || !(Math.abs(dy) <= limit)) return;
  const units = reticleUnitsPerCount(options.sensitivity, options.reticleRadiusCounts);
  const x = state.reticleX + dx * units;
  // Screen y points down, the reticle's y points up.
  const y = state.reticleY + (options.invertY ? dy : -dy) * units;
  const scale = unitCircleScale(x, y);
  state.reticleX = x * scale;
  state.reticleY = y * scale;
}

/** Releases every key and button; the reticle stays. Use when focus or pointer lock is lost. */
export function releaseAllInput(state: InputState): void {
  state.slotHeld.fill(0);
  state.heldActions = 0;
  state.latchedActions = 0;
  state.sampledActions = 0;
  state.boostLatched = false;
}

/**
 * Sets where abilities are aimed: a world-space heading and angle above the horizon (see
 * `InputFrame.aimYaw`). Non-finite values clear the aim.
 */
export function setInputAim(state: InputState, yaw: number, pitch: number): void {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    state.aimValid = false;
    return;
  }
  state.aimYaw = yaw;
  state.aimPitch = pitch;
  state.aimValid = true;
}

/** The next frames carry no aim (no camera, a spectator, the pointer is free). */
export function clearInputAim(state: InputState): void {
  state.aimValid = false;
}

/** Releases everything and centres the reticle. */
export function clearInputState(state: InputState): void {
  releaseAllInput(state);
  state.reticleX = 0;
  state.reticleY = 0;
}

export function centerReticle(state: InputState): void {
  state.reticleX = 0;
  state.reticleY = 0;
}

/**
 * Whether the action was held in the most recently sampled frame. For actions that are not sim
 * buttons, e.g. `isActionActive(state, 'scoreboard')` for the HUD.
 */
export function isActionActive(state: InputState, action: InputAction): boolean {
  return ((state.sampledActions | state.heldActions) & inputActionBit(action)) !== 0;
}

/**
 * Writes this tick's input into `out` (a reused frame: nothing is allocated) and then eases the
 * reticle toward the centre by `dtS`. Call exactly once per sim tick, before `sim.step`.
 */
export function sampleInput(
  state: InputState,
  tick: number,
  out: InputFrame,
  dtS: number = TICK_DT_S,
): InputFrame {
  const options = state.options;
  let actions = state.heldActions | state.latchedActions;
  state.latchedActions = 0;
  if (options.boostToggle) {
    // The key only flips the latch; the latch is what boosts.
    actions = state.boostLatched ? actions | BIT_BOOST : actions & ~BIT_BOOST;
  } else {
    state.boostLatched = false;
  }
  state.sampledActions = actions;

  let rx = state.reticleX;
  let ry = state.reticleY;
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
    rx = 0;
    ry = 0;
  }
  const gain = reticleSteerGain(
    Math.sqrt(rx * rx + ry * ry),
    options.deadZone,
    options.curveExponent,
  );

  const yawKeys =
    ((actions & BIT_TURN_RIGHT) !== 0 ? 1 : 0) - ((actions & BIT_TURN_LEFT) !== 0 ? 1 : 0);
  let pitchKeys =
    ((actions & BIT_PITCH_UP) !== 0 ? 1 : 0) - ((actions & BIT_PITCH_DOWN) !== 0 ? 1 : 0);
  if (options.invertKeyPitch) pitchKeys = -pitchKeys;

  let buttons = 0;
  for (let i = 0; i < ACTION_COUNT; i++) {
    if ((actions & (1 << i)) !== 0) buttons |= ACTION_BUTTONS[i] ?? 0;
  }

  out.tick = tick;
  out.steerX = clampUnit(rx * gain + yawKeys * clampFraction(options.keyYawSteer));
  out.steerY = clampUnit(ry * gain + pitchKeys * clampFraction(options.keyPitchSteer));
  out.buttons = state.aimValid ? buttons | BUTTON_AIM : buttons;
  out.aimYaw = state.aimValid ? state.aimYaw : 0;
  out.aimPitch = state.aimValid ? state.aimPitch : 0;

  const decay = reticleDecay(options.recenterRate, dtS);
  state.reticleX = rx * decay;
  state.reticleY = ry * decay;
  return out;
}
