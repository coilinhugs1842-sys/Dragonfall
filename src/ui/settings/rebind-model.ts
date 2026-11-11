/**
 * Key rebinding as a small state machine with no DOM, so the capture flow is unit-testable:
 *
 *   idle --beginCapture--> listening --captureCode--> idle            (intent raised)
 *                              |                  \--> conflict --resolveConflict--> idle
 *                              \--Escape / cancelCapture--> idle
 *
 * The model never edits a binding table: it reads `ControlsUiState` and returns the UiIntent for
 * `src/game` to apply (which answers with a new `ControlsUiState`). Fields are mutated in place
 * and hold only strings and numbers.
 */

import type { ControlsUiState, UiIntent } from '../../shared/ui';

export type RebindPhase = 'idle' | 'listening' | 'conflict';

/** Why the last key press was refused while listening ('' = nothing to say). */
export type RebindNote = '' | 'reserved';

export interface RebindModel {
  phase: RebindPhase;
  /** The slot being rebound; '' / -1 while idle. */
  action: string;
  slot: number;
  /** Conflict: the code that was pressed, and who holds it now. */
  code: string;
  holder: string;
  holderSlot: number;
  note: RebindNote;
  /** Goes up on every change, so a view can skip redrawing. */
  revision: number;
}

export function createRebindModel(): RebindModel {
  return {
    phase: 'idle',
    action: '',
    slot: -1,
    code: '',
    holder: '',
    holderSlot: -1,
    note: '',
    revision: 0,
  };
}

function toIdle(model: RebindModel): void {
  model.phase = 'idle';
  model.action = '';
  model.slot = -1;
  model.code = '';
  model.holder = '';
  model.holderSlot = -1;
  model.note = '';
  model.revision++;
}

/** Starts listening for a key for `slot` of `action`. False when that slot does not exist. */
export function beginCapture(
  model: RebindModel,
  controls: ControlsUiState,
  action: string,
  slot: number,
): boolean {
  if (!controls.actions.includes(action)) return false;
  if (!Number.isInteger(slot) || slot < 0 || slot >= controls.slotsPerAction) return false;
  toIdle(model);
  model.phase = 'listening';
  model.action = action;
  // A slot past the end of the list means "add": aim at the first free one.
  const used = controls.bindings[action]?.length ?? 0;
  model.slot = slot < used ? slot : used;
  return true;
}

/** Back to idle from any phase. Returns true when something was in progress. */
export function cancelCapture(model: RebindModel): boolean {
  if (model.phase === 'idle') return false;
  toIdle(model);
  return true;
}

/** `MouseEvent.button` 0..4 as a binding code; null for anything else. */
export function mouseCode(button: number): string | null {
  return Number.isInteger(button) && button >= 0 && button <= 4 ? `Mouse${button}` : null;
}

/** Which other action holds `code`, as [action, slot]; null when none does. */
export function findHolder(
  controls: ControlsUiState,
  code: string,
  exceptAction: string,
): { readonly action: string; readonly slot: number } | null {
  for (const action of controls.actions) {
    if (action === exceptAction) continue;
    const slot = controls.bindings[action]?.indexOf(code) ?? -1;
    if (slot >= 0) return { action, slot };
  }
  return null;
}

/**
 * A key or mouse button was pressed while listening. Returns the intent to raise, or null when
 * there is none (cancelled, refused, unchanged, or a conflict that now needs an answer).
 *
 * - Escape cancels (it can never be bound: the browser uses it to release the pointer).
 * - Backspace clears the slot.
 * - A reserved code is refused and the model keeps listening with `note = 'reserved'`.
 * - A code another action holds moves the model to `conflict`.
 */
export function captureCode(
  model: RebindModel,
  controls: ControlsUiState,
  code: string,
): UiIntent | null {
  if (model.phase !== 'listening') return null;
  if (code === 'Escape') {
    toIdle(model);
    return null;
  }
  const action = model.action;
  const slot = model.slot;
  const current = controls.bindings[action]?.[slot];
  if (code === 'Backspace') {
    toIdle(model);
    return current === undefined ? null : { type: 'settings.unbind', action, slot };
  }
  if (code === '' || controls.reservedCodes.includes(code)) {
    model.note = 'reserved';
    model.revision++;
    return null;
  }
  if (current === code) {
    toIdle(model);
    return null;
  }
  const holder = findHolder(controls, code, action);
  if (holder !== null) {
    model.phase = 'conflict';
    model.code = code;
    model.holder = holder.action;
    model.holderSlot = holder.slot;
    model.note = '';
    model.revision++;
    return null;
  }
  toIdle(model);
  return { type: 'settings.rebind', action, slot, code, swap: false };
}

/** True when a swap has something to give back: the slot being rebound holds a key now. */
export function canSwap(model: RebindModel, controls: ControlsUiState): boolean {
  return model.phase === 'conflict' && controls.bindings[model.action]?.[model.slot] !== undefined;
}

/**
 * Answers a conflict. `swap`: the two actions trade keys (when the slot was empty the other
 * action simply loses the key). `cancel`: nothing changes.
 */
export function resolveConflict(model: RebindModel, choice: 'swap' | 'cancel'): UiIntent | null {
  if (model.phase !== 'conflict') return null;
  const intent: UiIntent | null =
    choice === 'swap'
      ? {
          type: 'settings.rebind',
          action: model.action,
          slot: model.slot,
          code: model.code,
          swap: true,
        }
      : null;
  toIdle(model);
  return intent;
}

/** Drops a capture whose action or slot no longer exists (the table changed under it). */
export function reconcileRebind(model: RebindModel, controls: ControlsUiState | undefined): void {
  if (model.phase === 'idle') return;
  if (
    controls === undefined ||
    !controls.actions.includes(model.action) ||
    model.slot >= controls.slotsPerAction
  ) {
    toIdle(model);
  }
}

// --- Words --------------------------------------------------------------------------------------

const ACTION_LABELS: Readonly<Record<string, string>> = {
  pitchUp: 'Nose up',
  pitchDown: 'Nose down',
  turnLeft: 'Bank left',
  turnRight: 'Bank right',
  boost: 'Boost',
  flap: 'Wingbeat (climb)',
  dive: 'Dive',
  dodgeLeft: 'Roll dodge left',
  dodgeRight: 'Roll dodge right',
  primary: 'Primary attack',
  secondary: 'Secondary ability',
  utility: 'Utility ability',
  ultimate: 'Ultimate',
  scoreboard: 'Scoreboard (hold)',
};

/** A readable name for an action id; unknown ids are spelled out ("airBrake" -> "Air brake"). */
export function actionLabel(action: string): string {
  const known = Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action] : undefined;
  if (known !== undefined) return known;
  const spaced = action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const CODE_LABELS: Readonly<Record<string, string>> = {
  Mouse0: 'Left mouse',
  Mouse1: 'Middle mouse',
  Mouse2: 'Right mouse',
  Mouse3: 'Mouse back',
  Mouse4: 'Mouse forward',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  Escape: 'Esc',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  ArrowUp: 'Up arrow',
  ArrowDown: 'Down arrow',
  ArrowLeft: 'Left arrow',
  ArrowRight: 'Right arrow',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
};

/**
 * A short caption for a binding code. Codes name physical keys, so the caption is the US-layout
 * legend ("W" is the key where W sits on a US keyboard).
 */
export function codeLabel(code: string): string {
  const known = Object.hasOwn(CODE_LABELS, code) ? CODE_LABELS[code] : undefined;
  if (known !== undefined) return known;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6).replace(/([a-z])([A-Z])/g, '$1 $2')}`;
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  // Anything else: split the camel case of the code itself ("ScrollLock" -> "Scroll Lock").
  return code.replace(/([a-z0-9])([A-Z])/g, '$1 $2').slice(0, 24);
}

const SHORT_CODE_LABELS: Readonly<Record<string, string>> = {
  Mouse0: 'LMB',
  Mouse1: 'MMB',
  Mouse2: 'RMB',
  Mouse3: 'M4',
  Mouse4: 'M5',
  ShiftLeft: 'LShift',
  ShiftRight: 'RShift',
  ControlLeft: 'LCtrl',
  ControlRight: 'RCtrl',
  AltLeft: 'LAlt',
  AltRight: 'RAlt',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backspace: 'Bksp',
  CapsLock: 'Caps',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Insert: 'Ins',
  Delete: 'Del',
  NumpadEnter: 'NEnter',
  NumpadAdd: 'N+',
  NumpadSubtract: 'N-',
  NumpadMultiply: 'N*',
  NumpadDivide: 'N/',
  NumpadDecimal: 'N.',
};
/** Longest caption `codeShortLabel` returns. */
export const SHORT_CODE_LABEL_MAX = 6;

/**
 * `codeLabel` for places with room for a few characters (the HUD's ability slots): "LMB",
 * "RShift", "N7". Never longer than SHORT_CODE_LABEL_MAX.
 */
export function codeShortLabel(code: string): string {
  const known = Object.hasOwn(SHORT_CODE_LABELS, code) ? SHORT_CODE_LABELS[code] : undefined;
  if (known !== undefined) return known;
  if (/^Numpad[0-9]$/.test(code)) return `N${code.slice(6)}`;
  const label = codeLabel(code);
  return label.length <= SHORT_CODE_LABEL_MAX ? label : label.slice(0, SHORT_CODE_LABEL_MAX);
}

/** The line shown while listening or in a conflict; '' while idle. */
export function rebindPrompt(model: RebindModel): string {
  if (model.phase === 'listening') {
    const lead = `Press a key or mouse button for ${actionLabel(model.action)}.`;
    return model.note === 'reserved'
      ? `That key cannot be used. ${lead} Esc cancels.`
      : `${lead} Esc cancels, Backspace clears.`;
  }
  if (model.phase === 'conflict') {
    return `${codeLabel(model.code)} is already ${actionLabel(model.holder)}.`;
  }
  return '';
}
