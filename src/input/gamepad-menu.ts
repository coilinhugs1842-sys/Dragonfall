/**
 * The gamepad in the menus: D-pad or left stick to move, A to press, B to step back. No DOM and
 * no menu knowledge: it turns what ./gamepad-state.ts read on this poll into at most one command,
 * and the UI decides what "down" or "press" means for whatever has the focus.
 *
 * The buttons are fixed (the bottom and the right face button, the D-pad), not taken from the
 * rebind table: a player who moved "flap" off A must still be able to press Resume.
 *
 * - A and B are presses: one command when the button goes down.
 * - A direction repeats while held, after a longer first pause, like a held arrow key.
 * - Whatever is held when the menus take over (the stick pushed over in a turn, the flap button
 *   down as the pause menu opens) is ignored until it has been let go.
 *
 * Allocation-free: call it once per rendered frame after the pad was polled.
 */
import type { GamepadState } from './gamepad-state';

export type GamepadMenuCommand = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back';

export interface GamepadMenuState {
  /** The menus were being read on the last poll. */
  active: boolean;
  acceptDown: boolean;
  backDown: boolean;
  /** Index into DIRECTIONS of the direction held on the last poll; 0 = none. */
  direction: number;
  /** The stick's share of `direction` (kept apart for its hysteresis). */
  stickDirection: number;
  /** When the held direction steps again; Infinity = not until it was let go. */
  repeatAtMs: number;
}

const BUTTON_ACCEPT = 0;
const BUTTON_BACK = 1;
const BUTTON_DPAD_UP = 12;
const BUTTON_DPAD_DOWN = 13;
const BUTTON_DPAD_LEFT = 14;
const BUTTON_DPAD_RIGHT = 15;

/** The stick counts as pushed from here, and as let go again only below the second value. */
const STICK_PRESS = 0.6;
const STICK_RELEASE = 0.4;
/** A held direction steps again after this long, then at this pace. */
const FIRST_REPEAT_MS = 400;
const REPEAT_MS = 140;

const DIRECTIONS: readonly (GamepadMenuCommand | null)[] = [null, 'up', 'down', 'left', 'right'];

export function createGamepadMenuState(): GamepadMenuState {
  return {
    active: false,
    acceptDown: false,
    backDown: false,
    direction: 0,
    stickDirection: 0,
    repeatAtMs: Infinity,
  };
}

function stickDirection(gp: GamepadState, held: number): number {
  const x = gp.leftX;
  const y = gp.leftY;
  const sideways = Math.abs(x) > Math.abs(y);
  const value = sideways ? x : y;
  const direction = sideways ? (value > 0 ? 4 : 3) : value > 0 ? 1 : 2;
  // Hysteresis only for the direction already held: a stick rolled from "down" to "right" has
  // to be properly over to the right before that counts.
  const threshold = direction === held ? STICK_RELEASE : STICK_PRESS;
  return Math.abs(value) >= threshold ? direction : 0;
}

/**
 * The menu command of this poll, or null. `active`: a menu is in front and wants the pad (false
 * while the player flies; the state then forgets what was held).
 */
export function pollGamepadMenu(
  menu: GamepadMenuState,
  gp: GamepadState,
  nowMs: number,
  active: boolean,
): GamepadMenuCommand | null {
  if (!active || !gp.connected) {
    menu.active = false;
    return null;
  }
  const down = gp.buttonDown;
  const accept = down[BUTTON_ACCEPT] === 1;
  const back = down[BUTTON_BACK] === 1;
  const stick = stickDirection(gp, menu.stickDirection);
  const direction =
    down[BUTTON_DPAD_UP] === 1
      ? 1
      : down[BUTTON_DPAD_DOWN] === 1
        ? 2
        : down[BUTTON_DPAD_LEFT] === 1
          ? 3
          : down[BUTTON_DPAD_RIGHT] === 1
            ? 4
            : stick;
  menu.stickDirection = stick;

  if (!menu.active) {
    // The menus just took over: what is held now was meant for the flight, not for them.
    menu.active = true;
    menu.acceptDown = accept;
    menu.backDown = back;
    menu.direction = direction;
    menu.repeatAtMs = Infinity;
    return null;
  }

  const pressedAccept = accept && !menu.acceptDown;
  const pressedBack = back && !menu.backDown;
  menu.acceptDown = accept;
  menu.backDown = back;

  let step = 0;
  if (direction !== menu.direction) {
    menu.direction = direction;
    menu.repeatAtMs = nowMs + FIRST_REPEAT_MS;
    step = direction;
  } else if (direction !== 0 && nowMs >= menu.repeatAtMs) {
    menu.repeatAtMs = nowMs + REPEAT_MS;
    step = direction;
  }

  if (pressedAccept) return 'accept';
  if (pressedBack) return 'back';
  return DIRECTIONS[step] ?? null;
}
