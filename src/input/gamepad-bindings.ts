/**
 * The gamepad's rebind table: the same serialisable shape as the keyboard table of ./bindings.ts
 * (`{ boost: ['Pad4'], ... }`), with its own codes, so every function there (rebindAction,
 * unbindAction, findBindingConflicts, serializeBindings, ...) works on it unchanged.
 *
 * CODES. `Pad0`..`Pad16` are the buttons of the W3C "standard gamepad" mapping, named here as on
 * an Xbox pad (the design table uses those names):
 *
 *   0 A   1 B   2 X   3 Y   4 LB   5 RB   6 LT   7 RT   8 View   9 Menu
 *   10 left stick click   11 right stick click   12..15 D-pad up / down / left / right   16 Home
 *
 * `PadFlickLeft` / `PadFlickRight` are not buttons: they stand for "flick the left stick sideways
 * while the boost button is held", the dodge of the design table ("LB + stick"). As codes in the
 * table they show in the Controls tab like any binding, can be unbound by a player who dodges by
 * accident, and a dodge can be put on a button instead.
 *
 * The sticks are not in the table: left = steer, right = fine pitch / yaw (./gamepad-state.ts).
 * `Pad9` (Menu) is the pause button and `Pad16` belongs to the OS; both are in RESERVED_CODES.
 */
import { INPUT_ACTIONS, cloneBindings, isBindableCode, parseBindings } from './bindings';
import type { InputAction, InputBindings, InputCode } from './bindings';

/** Buttons of the standard mapping. A pad with more is read up to here, one with fewer is fine. */
export const GAMEPAD_BUTTON_COUNT = 17;

/** Index = position in `Gamepad.buttons`. */
export const GAMEPAD_BUTTON_CODES = [
  'Pad0',
  'Pad1',
  'Pad2',
  'Pad3',
  'Pad4',
  'Pad5',
  'Pad6',
  'Pad7',
  'Pad8',
  'Pad9',
  'Pad10',
  'Pad11',
  'Pad12',
  'Pad13',
  'Pad14',
  'Pad15',
  'Pad16',
] as const;

export const GAMEPAD_FLICK_LEFT = 'PadFlickLeft';
export const GAMEPAD_FLICK_RIGHT = 'PadFlickRight';

/** Menu / Start: always the pause menu, never a flight action. */
export const GAMEPAD_MENU_BUTTON = 9;

/**
 * Defaults from the docs/GAME_DESIGN.md controls table. The D-pad is the digital twin of the
 * right stick (what W/S and A/D are on the keyboard). RB and the two stick clicks are free.
 */
export const DEFAULT_GAMEPAD_BINDINGS: InputBindings = {
  pitchUp: ['Pad12'],
  pitchDown: ['Pad13'],
  turnLeft: ['Pad14'],
  turnRight: ['Pad15'],
  boost: ['Pad4'],
  flap: ['Pad0'],
  dive: ['Pad1'],
  dodgeLeft: [GAMEPAD_FLICK_LEFT],
  dodgeRight: [GAMEPAD_FLICK_RIGHT],
  primary: ['Pad7'],
  secondary: ['Pad6'],
  utility: ['Pad2'],
  ultimate: ['Pad3'],
  scoreboard: ['Pad8'],
};

/** `Gamepad.buttons` index to its code; undefined past the standard 17. Allocation-free. */
export function gamepadButtonCode(index: number): InputCode | undefined {
  return GAMEPAD_BUTTON_CODES[index];
}

/** The `Gamepad.buttons` index of a `Pad<n>` code; -1 for anything else. Allocation-free. */
export function gamepadButtonIndex(code: InputCode): number {
  return (GAMEPAD_BUTTON_CODES as readonly string[]).indexOf(code);
}

/** True for `Pad0`..`Pad16` and the two flick codes. */
export function isGamepadCode(code: InputCode): boolean {
  return (
    gamepadButtonIndex(code) >= 0 || code === GAMEPAD_FLICK_LEFT || code === GAMEPAD_FLICK_RIGHT
  );
}

/** A fresh copy of the pad defaults ("reset all"). */
export function resetGamepadBindings(): InputBindings {
  return cloneBindings(DEFAULT_GAMEPAD_BINDINGS);
}

/**
 * `parseBindings` for the pad's table: the same repairs, falling back on the pad defaults, and
 * codes that are not gamepad codes are dropped (a keyboard table pasted into the wrong slot).
 */
export function parseGamepadBindings(text: string | null | undefined): InputBindings {
  const parsed = parseBindings(text, DEFAULT_GAMEPAD_BINDINGS);
  const next = {} as Record<InputAction, readonly InputCode[]>;
  for (const action of INPUT_ACTIONS) {
    next[action] = parsed[action].filter((code) => isGamepadCode(code) && isBindableCode(code));
  }
  return next;
}

const BUTTON_LABELS: readonly string[] = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Menu',
  'Left stick click',
  'Right stick click',
  'D-pad up',
  'D-pad down',
  'D-pad left',
  'D-pad right',
  'Home',
];

/** Each at most 6 characters: the HUD's ability slots were laid out for "RShift". */
const BUTTON_SHORT_LABELS: readonly string[] = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Menu',
  'LS',
  'RS',
  'D\u2191',
  'D\u2193',
  'D\u2190',
  'D\u2192',
  'Home',
];

/**
 * A readable name for a gamepad code ("LB", "D-pad up", "Boost + flick left"); '' for a code
 * that is not a gamepad code, so a caller can fall through to its keyboard labels.
 */
export function gamepadCodeLabel(code: InputCode): string {
  if (code === GAMEPAD_FLICK_LEFT) return 'Boost + flick left';
  if (code === GAMEPAD_FLICK_RIGHT) return 'Boost + flick right';
  return BUTTON_LABELS[gamepadButtonIndex(code)] ?? '';
}

/** `gamepadCodeLabel` in at most 6 characters ("LS", "D↑", "Flick←"); '' for other codes. */
export function gamepadCodeShortLabel(code: InputCode): string {
  if (code === GAMEPAD_FLICK_LEFT) return 'Flick\u2190';
  if (code === GAMEPAD_FLICK_RIGHT) return 'Flick\u2192';
  return BUTTON_SHORT_LABELS[gamepadButtonIndex(code)] ?? '';
}
