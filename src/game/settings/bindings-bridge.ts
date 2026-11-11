/**
 * The bridge between the Controls tab and the rebind table in `src/input`. `src/ui` may not
 * import `src/input`, so the table crosses the seam as plain data (`ControlsUiState`) and comes
 * back as `settings.rebind` / `settings.unbind` / `settings.resetBindings` intents carrying
 * strings. Everything arriving here is checked: an unknown action, a reserved key or a slot out
 * of range changes nothing.
 */

import {
  DEFAULT_BINDINGS,
  INPUT_ACTIONS,
  MAX_CODES_PER_ACTION,
  RESERVED_CODES,
  isBindableCode,
  rebindAction,
  resetActionBinding,
  resetBindings,
  unbindAction,
} from '../../input/bindings';
import type { InputAction, InputBindings, InputCode } from '../../input/bindings';
import type { ControlsUiState } from '../../shared';

/** Longest code accepted from an intent (`KeyboardEvent.code` values are short). */
const MAX_CODE_LENGTH = 32;

export function isInputAction(value: unknown): value is InputAction {
  return typeof value === 'string' && (INPUT_ACTIONS as readonly string[]).includes(value);
}

function isSlot(slot: unknown): slot is number {
  return (
    typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < MAX_CODES_PER_ACTION
  );
}

/** What the UI draws. Allocates one small object: build it when the table changes, not per frame. */
export function controlsUiStateFor(bindings: InputBindings): ControlsUiState {
  return {
    actions: INPUT_ACTIONS,
    bindings,
    defaults: DEFAULT_BINDINGS,
    reservedCodes: RESERVED_CODES,
    slotsPerAction: MAX_CODES_PER_ACTION,
  };
}

/**
 * Binds `code` to `slot` of `action`. Every other action loses the code. With `swap`, the first
 * action that held it gets, in the slot it lost, the code this slot had before, so two actions
 * trade keys. Returns the SAME table when the request is invalid or changes nothing.
 */
export function applyRebind(
  bindings: InputBindings,
  action: unknown,
  slot: unknown,
  code: unknown,
  swap: boolean,
): InputBindings {
  if (!isInputAction(action) || !isSlot(slot)) return bindings;
  if (typeof code !== 'string' || code.length > MAX_CODE_LENGTH || !isBindableCode(code)) {
    return bindings;
  }
  const mine = bindings[action];
  const previous: InputCode | undefined = mine[slot];
  if (previous === code) return bindings;

  let holder: InputAction | null = null;
  let holderSlot = -1;
  if (swap && previous !== undefined) {
    for (const other of INPUT_ACTIONS) {
      if (other === action) continue;
      const index = bindings[other].indexOf(code);
      if (index >= 0) {
        holder = other;
        holderSlot = index;
        break;
      }
    }
  }
  const next = rebindAction(bindings, action, slot, code);
  if (holder === null || previous === undefined) return next;

  // `rebindAction` removed the code from the holder; put the traded key where it was.
  const traded = [...next[holder]];
  traded.splice(Math.min(holderSlot, traded.length), 0, previous);
  return { ...next, [holder]: traded.slice(0, MAX_CODES_PER_ACTION) };
}

/** Clears one slot. Returns the same table when there is nothing there. */
export function applyUnbind(
  bindings: InputBindings,
  action: unknown,
  slot: unknown,
): InputBindings {
  if (!isInputAction(action) || !isSlot(slot)) return bindings;
  if (bindings[action][slot] === undefined) return bindings;
  return unbindAction(bindings, action, slot);
}

/** One action back to its defaults (`action` a valid id) or all of them (`null`). */
export function applyResetBindings(bindings: InputBindings, action: unknown): InputBindings {
  if (action === null) return resetBindings();
  if (!isInputAction(action)) return bindings;
  // Its default keys may be in use elsewhere by now: take them back, one slot at a time.
  let next = resetActionBinding(bindings, action);
  const defaults = DEFAULT_BINDINGS[action];
  for (let slot = 0; slot < defaults.length; slot++) {
    const code = defaults[slot];
    if (code !== undefined) next = rebindAction(next, action, slot, code);
  }
  return next;
}
