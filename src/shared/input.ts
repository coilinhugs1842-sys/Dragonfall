/**
 * InputFrame: one player's input for one sim tick. `src/input` produces it from devices, the
 * client sends it to the host, and both run the same sim code on it (prediction + authority).
 * Fields are flat numbers so a frame can be reused and encoded without allocating.
 */

/** Button bits. They fit a `u16` on the wire; append new bits, never renumber. */
export const BUTTON_BOOST = 1 << 0;
export const BUTTON_FLAP = 1 << 1;
export const BUTTON_DIVE = 1 << 2;
export const BUTTON_DODGE_LEFT = 1 << 3;
export const BUTTON_DODGE_RIGHT = 1 << 4;
export const BUTTON_PRIMARY = 1 << 5;
export const BUTTON_SECONDARY = 1 << 6;
export const BUTTON_UTILITY = 1 << 7;
export const BUTTON_ULTIMATE = 1 << 8;
/** Mask of every defined bit; the host uses it to drop unknown bits from client input. */
export const BUTTON_MASK = (1 << 9) - 1;

export interface InputFrame {
  /** Sim tick this input applies to. */
  tick: number;
  /**
   * Steer vector, each axis in [-1, 1]: x = turn right, y = pitch up. `src/input` folds mouse
   * reticle offset, WASD and gamepad sticks into it. The exact device mapping (and whether roll
   * needs its own axis) is TBD in T-1.x; the host clamps both axes.
   */
  steerX: number;
  steerY: number;
  /** Bitmask of the BUTTON_* constants: buttons held during this tick. */
  buttons: number;
}

export function createInputFrame(): InputFrame {
  return { tick: 0, steerX: 0, steerY: 0, buttons: 0 };
}

/** Clears a frame for reuse. Returns it so calls can be chained. */
export function resetInputFrame(frame: InputFrame, tick = 0): InputFrame {
  frame.tick = tick;
  frame.steerX = 0;
  frame.steerY = 0;
  frame.buttons = 0;
  return frame;
}

export function copyInputFrame(out: InputFrame, from: Readonly<InputFrame>): InputFrame {
  out.tick = from.tick;
  out.steerX = from.steerX;
  out.steerY = from.steerY;
  out.buttons = from.buttons;
  return out;
}

export function hasButton(frame: Readonly<InputFrame>, button: number): boolean {
  return (frame.buttons & button) !== 0;
}

/**
 * Forces a frame into the legal range. The host runs this on every client input ("clients
 * can't set state; the host clamps input values"), and it also turns NaN into 0.
 */
export function sanitizeInputFrame(frame: InputFrame): InputFrame {
  frame.steerX = clampUnit(frame.steerX);
  frame.steerY = clampUnit(frame.steerY);
  frame.buttons &= BUTTON_MASK;
  return frame;
}

function clampUnit(value: number): number {
  if (!(value >= -1)) return value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}
