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
/** Held roll keys (A/D): extra bank that tightens the turn. Digital, so bits and not an axis. */
export const BUTTON_ROLL_LEFT = 1 << 9;
export const BUTTON_ROLL_RIGHT = 1 << 10;
/**
 * `aimYaw`/`aimPitch` of this frame are valid. Not a key: `src/input` sets it whenever it knows
 * where the reticle points. Without it abilities fire straight along the nose (bots, a held seat).
 */
export const BUTTON_AIM = 1 << 11;
/** Mask of every defined bit; the host uses it to drop unknown bits from client input. */
export const BUTTON_MASK = (1 << 12) - 1;
/** The four ability buttons; `BUTTON_PRIMARY << i` is the button of ABILITY_SLOTS[i]. */
export const BUTTON_ABILITY_MASK =
  BUTTON_PRIMARY | BUTTON_SECONDARY | BUTTON_UTILITY | BUTTON_ULTIMATE;

export interface InputFrame {
  /** Sim tick this input applies to. */
  tick: number;
  /**
   * Steer vector, each axis in [-1, 1]: x = turn right, y = pitch up. `src/input` folds mouse
   * reticle offset, WASD and gamepad sticks into it. Roll has no axis: the sim banks into the
   * turn by itself and BUTTON_ROLL_LEFT/RIGHT add to it. The host clamps both axes.
   */
  steerX: number;
  steerY: number;
  /** Bitmask of the BUTTON_* constants: buttons held during this tick. */
  buttons: number;
  /**
   * Where abilities are aimed, as a WORLD-space direction: heading about +Y (0 = +Z, a right
   * turn lowers it, like `DragonState.yaw`) and angle above the horizon. `src/input` computes it
   * from the camera's reticle ray: the direction from the dragon to the point where that ray
   * reaches the convergence range (so shots cross the reticle there although the camera sits
   * behind and above the dragon). Only read while BUTTON_AIM is set. The sim limits how far a
   * shot may leave the nose per ability (`AbilityDef.aimLimit`), so this is aim assist, not a
   * turret.
   */
  aimYaw: number;
  aimPitch: number;
}

export function createInputFrame(): InputFrame {
  return { tick: 0, steerX: 0, steerY: 0, buttons: 0, aimYaw: 0, aimPitch: 0 };
}

/** Clears a frame for reuse. Returns it so calls can be chained. */
export function resetInputFrame(frame: InputFrame, tick = 0): InputFrame {
  frame.tick = tick;
  frame.steerX = 0;
  frame.steerY = 0;
  frame.buttons = 0;
  frame.aimYaw = 0;
  frame.aimPitch = 0;
  return frame;
}

export function copyInputFrame(out: InputFrame, from: Readonly<InputFrame>): InputFrame {
  out.tick = from.tick;
  out.steerX = from.steerX;
  out.steerY = from.steerY;
  out.buttons = from.buttons;
  out.aimYaw = from.aimYaw;
  out.aimPitch = from.aimPitch;
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
  frame.aimYaw = clampAimYaw(frame.aimYaw);
  frame.aimPitch = clampAimPitch(frame.aimPitch);
  return frame;
}

const AIM_PITCH_LIMIT = Math.PI / 2;

/** Wraps a heading into [-PI, PI); NaN and infinities become 0. */
export function clampAimYaw(value: number): number {
  if (!(value - value === 0)) return 0;
  if (value >= -Math.PI && value < Math.PI) return value;
  return value - Math.PI * 2 * Math.floor((value + Math.PI) / (Math.PI * 2));
}

/** Clamps to straight down .. straight up; NaN becomes 0. */
export function clampAimPitch(value: number): number {
  if (!(value >= -AIM_PITCH_LIMIT)) return value < -AIM_PITCH_LIMIT ? -AIM_PITCH_LIMIT : 0;
  return value > AIM_PITCH_LIMIT ? AIM_PITCH_LIMIT : value;
}

function clampUnit(value: number): number {
  if (!(value >= -1)) return value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}
