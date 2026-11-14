/**
 * Rebind table: which physical keys and mouse buttons trigger which input action. Pure data and
 * pure functions (no DOM), so the Settings UI (T-3.9) can edit, validate and store a table and
 * hand the result to `InputController.setBindings`.
 *
 * A table is plain JSON: `{ boost: ['ShiftLeft', 'ShiftRight'], ... }`. Codes are
 * `KeyboardEvent.code` values (physical keys, so WASD stays WASD on AZERTY) or `Mouse0`..`Mouse4`
 * for `MouseEvent.button` 0..4. Every function returns a NEW table and leaves its input alone.
 *
 * The gamepad has a SECOND table of the same shape (`Pad0`..`Pad16`, see ./gamepad-bindings.ts)
 * and every function here works on either. One table for both devices was not possible: the
 * keyboard defaults already fill both slots of some actions, and a saved keyboard table lists
 * its actions in full, so pad defaults added later would never reach an existing player.
 *
 * A/D: the design doc lists A/D both as "fine yaw" and as "add roll". They are ONE action pair
 * here (`turnLeft`/`turnRight`) that does both: it sets BUTTON_ROLL_LEFT/RIGHT (the sim banks
 * harder and tightens the turn) and adds a small fine-yaw term to `steerX`. A dragon rolls to
 * turn, so two separate key pairs would fight each other.
 *
 * W/S: `pitchUp` (W) raises the nose, matching the mouse (mouse forward = reticle up = climb).
 * Players who want stick-style pitch flip `invertKeyPitch` / `invertY` in the input options.
 */

/** Order = bit index in the action mask. Append only: saved tables are keyed by name. */
export const INPUT_ACTIONS = [
  'pitchUp',
  'pitchDown',
  'turnLeft',
  'turnRight',
  'boost',
  'flap',
  'dive',
  'dodgeLeft',
  'dodgeRight',
  'primary',
  'secondary',
  'utility',
  'ultimate',
  'scoreboard',
] as const;

export type InputAction = (typeof INPUT_ACTIONS)[number];

/** A `KeyboardEvent.code`, `Mouse0`..`Mouse4`, or a gamepad code (./gamepad-bindings.ts). */
export type InputCode = string;

export type InputBindings = Readonly<Record<InputAction, readonly InputCode[]>>;

/** Index = `MouseEvent.button`: left, middle, right, back, forward. */
export const MOUSE_BUTTON_CODES = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4'] as const;

/** Slots the Settings UI shows per action (primary + alternative). */
export const MAX_CODES_PER_ACTION = 2;

/**
 * Codes a page cannot use for a held game action:
 * - Escape always releases pointer lock (the browser does it, it cannot be prevented);
 * - the OS/Meta keys open system UI and their keyup is often never delivered;
 * - on a gamepad, `Pad9` (Menu / Start) always opens the pause menu, the pad's Escape, and
 *   `Pad16` (Home / Guide) belongs to the OS and most browsers never report it.
 */
export const RESERVED_CODES: readonly InputCode[] = [
  'Escape',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'Pad9',
  'Pad16',
];

/**
 * Defaults from the docs/GAME_DESIGN.md controls table. `KeyC` is a second dive key because
 * Ctrl + W (dive while pitching) closes the tab and no page can prevent that; see
 * ./input-controller.ts for the list of shortcuts that cannot be blocked.
 */
export const DEFAULT_BINDINGS: InputBindings = {
  pitchUp: ['KeyW'],
  pitchDown: ['KeyS'],
  turnLeft: ['KeyA'],
  turnRight: ['KeyD'],
  boost: ['ShiftLeft', 'ShiftRight'],
  flap: [],
  dive: ['ControlLeft', 'KeyC'],
  dodgeLeft: ['KeyQ'],
  dodgeRight: ['KeyE'],
  primary: ['Mouse0', 'Space'],
  secondary: ['KeyV'],
  utility: ['KeyF'],
  ultimate: ['KeyR'],
  scoreboard: ['Tab'],
};

/** Version tag of the serialised form, so a later format change can migrate old saves. */
export const BINDINGS_FORMAT_VERSION = 2;

export interface BindingConflict {
  readonly code: InputCode;
  /** Two or more actions that share the code, in INPUT_ACTIONS order. */
  readonly actions: readonly InputAction[];
}

export function inputActionIndex(action: InputAction): number {
  return INPUT_ACTIONS.indexOf(action);
}

/** Bit of an action in `InputState.heldActions`. */
export function inputActionBit(action: InputAction): number {
  return 1 << INPUT_ACTIONS.indexOf(action);
}

/** `MouseEvent.button` to its code; undefined for buttons beyond the fifth. Allocation-free. */
export function mouseButtonCode(button: number): InputCode | undefined {
  return MOUSE_BUTTON_CODES[button];
}

export function isMouseCode(code: InputCode): boolean {
  return (MOUSE_BUTTON_CODES as readonly string[]).includes(code);
}

/** False for the empty string and the RESERVED_CODES. */
export function isBindableCode(code: InputCode): boolean {
  return code.length > 0 && !RESERVED_CODES.includes(code);
}

function mapBindings(
  bindings: InputBindings,
  pick: (action: InputAction, codes: readonly InputCode[]) => readonly InputCode[],
): InputBindings {
  const next = {} as Record<InputAction, readonly InputCode[]>;
  for (const action of INPUT_ACTIONS) next[action] = pick(action, bindings[action]);
  return next;
}

/** Deep copy (each action gets its own array). */
export function cloneBindings(bindings: InputBindings): InputBindings {
  return mapBindings(bindings, (_action, codes) => [...codes]);
}

/** A fresh copy of the defaults ("reset all"). */
export function resetBindings(): InputBindings {
  return cloneBindings(DEFAULT_BINDINGS);
}

/**
 * Puts one action back to its default and leaves the others alone ("reset this row").
 * `defaults`: the table the row comes from (DEFAULT_GAMEPAD_BINDINGS for the pad's table).
 */
export function resetActionBinding(
  bindings: InputBindings,
  action: InputAction,
  defaults: InputBindings = DEFAULT_BINDINGS,
): InputBindings {
  return mapBindings(bindings, (other, codes) => [
    ...(other === action ? defaults[action] : codes),
  ]);
}

export interface RebindOptions {
  /**
   * true (default): the code is removed from every other action, so a rebind never creates a
   * conflict. false: other actions keep it; use `findBindingConflicts` to warn.
   */
  readonly steal?: boolean;
}

/**
 * Binds `code` to `action` in `slot`: slot 0 replaces the primary key, slot 1 the alternative
 * (a slot past the end appends). A reserved or empty code, or a slot outside
 * 0..MAX_CODES_PER_ACTION-1, changes nothing (a copy is still returned).
 */
export function rebindAction(
  bindings: InputBindings,
  action: InputAction,
  slot: number,
  code: InputCode,
  options: RebindOptions = {},
): InputBindings {
  if (
    !isBindableCode(code) ||
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= MAX_CODES_PER_ACTION
  ) {
    return cloneBindings(bindings);
  }
  const steal = options.steal ?? true;
  return mapBindings(bindings, (other, codes) => {
    if (other !== action) return steal ? codes.filter((c) => c !== code) : [...codes];
    const next = [...codes];
    if (slot < next.length) next[slot] = code;
    else next.push(code);
    // The same code may now sit in the other slot too: keep the one just set.
    return next.filter((c, index) => c !== code || index === Math.min(slot, next.length - 1));
  });
}

/** Removes the code in `slot` of `action`; an action may end up with no binding at all. */
export function unbindAction(
  bindings: InputBindings,
  action: InputAction,
  slot: number,
): InputBindings {
  return mapBindings(bindings, (other, codes) =>
    other === action ? codes.filter((_code, index) => index !== slot) : [...codes],
  );
}

/** Every code bound to more than one action, in first-seen order. Empty = no conflicts. */
export function findBindingConflicts(bindings: InputBindings): BindingConflict[] {
  const byCode = new Map<InputCode, InputAction[]>();
  for (const action of INPUT_ACTIONS) {
    for (const code of bindings[action]) {
      const actions = byCode.get(code);
      if (actions === undefined) byCode.set(code, [action]);
      else if (!actions.includes(action)) actions.push(action);
    }
  }
  const conflicts: BindingConflict[] = [];
  for (const [code, actions] of byCode) {
    if (actions.length > 1) conflicts.push({ code, actions });
  }
  return conflicts;
}

/** Actions with no key at all (the Settings UI should flag them). */
export function findUnboundActions(bindings: InputBindings): InputAction[] {
  return INPUT_ACTIONS.filter((action) => bindings[action].length === 0);
}

export function bindingsEqual(a: InputBindings, b: InputBindings): boolean {
  for (const action of INPUT_ACTIONS) {
    const left = a[action];
    const right = b[action];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  }
  return true;
}

/** JSON text for localStorage: `{"version":1,"bindings":{...}}`. */
export function serializeBindings(bindings: InputBindings): string {
  return JSON.stringify({ version: BINDINGS_FORMAT_VERSION, bindings: cloneBindings(bindings) });
}

function sanitizeCodes(value: unknown, fallback: readonly InputCode[]): readonly InputCode[] {
  if (!Array.isArray(value)) return [...fallback];
  const codes: InputCode[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string' || !isBindableCode(entry) || codes.includes(entry)) continue;
    if (codes.length < MAX_CODES_PER_ACTION) codes.push(entry);
  }
  return codes;
}

/**
 * Reads what `serializeBindings` wrote. Never throws: broken text, a wrong version or a
 * non-object gives the defaults; a missing or malformed action gets its default; unknown actions
 * and reserved or duplicate codes are dropped. An explicitly empty list stays empty (unbound).
 * `defaults`: the table to fall back on (DEFAULT_GAMEPAD_BINDINGS for the pad's table).
 */
export function parseBindings(
  text: string | null | undefined,
  defaults: InputBindings = DEFAULT_BINDINGS,
): InputBindings {
  if (typeof text !== 'string') return cloneBindings(defaults);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return cloneBindings(defaults);
  }
  if (typeof parsed !== 'object' || parsed === null) return cloneBindings(defaults);
  const root = parsed as { version?: unknown; bindings?: unknown };
  if (root.version !== BINDINGS_FORMAT_VERSION) return cloneBindings(defaults);
  if (typeof root.bindings !== 'object' || root.bindings === null) return cloneBindings(defaults);
  const table = root.bindings as Partial<Record<InputAction, unknown>>;
  return mapBindings(defaults, (action, fallback) =>
    Object.hasOwn(table, action) ? sanitizeCodes(table[action], fallback) : [...fallback],
  );
}
