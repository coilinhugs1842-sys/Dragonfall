/**
 * One rebind table of the Controls tab: the prompt, the rows of slots and the reset line. The
 * panel builds two, the keyboard's and the gamepad's; they share this code and the state machine
 * in ./rebind-model.ts and differ in their words and in where a new code comes from (a key or
 * mouse event for the first, `UiState.gamepad.pressCode` for the second).
 *
 * Every button here carries `data-device`, so the panel's one click listener knows which list
 * it belongs to. The list never raises an intent itself.
 */

import type { BindingDevice, ControlsUiState } from '../../shared/ui';
import { append, button, el } from '../dom';
import {
  actionLabel,
  canSwap,
  codeLabel,
  createRebindModel,
  rebindPrompt,
  reconcileRebind,
} from './rebind-model';
import type { RebindModel } from './rebind-model';

export interface BindingListWords {
  /** "key" / "button": the thing a slot holds. */
  readonly thing: string;
  /** In a slot while it listens. */
  readonly listening: string;
  /** Shown instead of the list when there is no table. */
  readonly empty: string;
  /** Under the list, beside the reset button. */
  readonly hint: string;
  /** The reset-everything button. */
  readonly resetAll: string;
}

export const KEYBOARD_LIST_WORDS: BindingListWords = {
  thing: 'key',
  listening: 'Press a key…',
  empty: 'Key bindings are not available here.',
  hint: 'Select a key, then press the new one. Mouse buttons work too.',
  resetAll: 'Reset keys to defaults',
};

export const GAMEPAD_LIST_WORDS: BindingListWords = {
  thing: 'button',
  listening: 'Press a button…',
  empty: 'Gamepad buttons are not available here.',
  hint: 'Select a slot, then press the button on the gamepad. The sticks steer and are not listed.',
  resetAll: 'Reset buttons to defaults',
};

interface RowDom {
  readonly action: string;
  readonly row: HTMLElement;
  readonly slots: HTMLButtonElement[];
  readonly reset: HTMLButtonElement;
}

export interface BindingList {
  readonly device: BindingDevice;
  readonly model: RebindModel;
  /** The elements, in order, for the tab's group. */
  readonly nodes: readonly HTMLElement[];
  /** The table last given to `setControls`. */
  readonly controls: ControlsUiState | undefined;
  /** True when the model changed since the last `draw`. */
  readonly stale: boolean;
  /** Takes the newest table; true when it is a different one (the caller then draws). */
  setControls(controls: ControlsUiState | undefined): boolean;
  /** Redraws prompt and rows. In a conflict the swap button takes the focus. */
  draw(): void;
  focusSlot(action: string, slot: number): void;
}

function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createBindingList(device: BindingDevice, words: BindingListWords): BindingList {
  const model = createRebindModel(device);
  const rows: RowDom[] = [];
  let controls: ControlsUiState | undefined;
  let shownRevision = -1;

  const prompt = el('div', 'dfs-prompt');
  prompt.setAttribute('role', 'status');
  prompt.setAttribute('aria-live', 'polite');
  prompt.hidden = true;
  const promptText = el('p', 'dfs-prompt-text', '');
  const swapButton = button('dfu-btn dfu-btn-small dfu-btn-primary', 'Swap', 'conflictSwap');
  const cancelButton = button('dfu-btn dfu-btn-small', 'Cancel', 'conflictCancel');
  swapButton.dataset['device'] = device;
  cancelButton.dataset['device'] = device;
  const promptActions = el('div', 'dfs-prompt-actions');
  append(promptActions, swapButton, cancelButton);
  append(prompt, promptText, promptActions);

  const list = el('div', 'dfs-keys');
  list.dataset['device'] = device;
  const empty = el('p', 'dfu-hint', words.empty);
  const resetAll = button('dfu-btn dfu-btn-small', words.resetAll, 'resetKeys');
  resetAll.dataset['device'] = device;
  const foot = el('div', 'dfs-keys-foot');
  append(foot, el('p', 'dfu-hint', words.hint), resetAll);

  const build = (current: ControlsUiState): void => {
    list.textContent = '';
    rows.length = 0;
    for (const action of current.actions) {
      const label = actionLabel(action);
      const row = el('div', 'dfs-key-row');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', label);
      const slots: HTMLButtonElement[] = [];
      const slotBox = el('div', 'dfs-key-slots');
      for (let slot = 0; slot < current.slotsPerAction; slot++) {
        const slotButton = button('dfs-key', '', 'bind');
        slotButton.dataset['device'] = device;
        slotButton.dataset['action'] = action;
        slotButton.dataset['slot'] = String(slot);
        slots.push(slotButton);
        slotBox.appendChild(slotButton);
      }
      const reset = button('dfs-key-reset', 'Reset', 'resetKey');
      reset.dataset['device'] = device;
      reset.dataset['action'] = action;
      reset.setAttribute('aria-label', `Reset ${label} to its default ${words.thing}s`);
      append(row, el('span', 'dfs-key-name', label), slotBox, reset);
      rows.push({ action, row, slots, reset });
      list.appendChild(row);
    }
  };

  const drawRows = (): void => {
    const current = controls;
    const has = current !== undefined && current.actions.length > 0;
    empty.hidden = has;
    foot.hidden = !has;
    list.hidden = !has;
    if (current === undefined) return;
    if (
      rows.length !== current.actions.length ||
      rows.some(
        (entry, index) =>
          entry.action !== current.actions[index] || entry.slots.length !== current.slotsPerAction,
      )
    ) {
      build(current);
    }
    let allDefault = true;
    for (const entry of rows) {
      const codes = current.bindings[entry.action] ?? [];
      const isDefault = sameCodes(codes, current.defaults[entry.action] ?? []);
      if (!isDefault) allDefault = false;
      entry.reset.disabled = isDefault;
      entry.row.dataset['unbound'] = codes.length === 0 ? 'true' : 'false';
      const label = actionLabel(entry.action);
      for (let slot = 0; slot < entry.slots.length; slot++) {
        const slotButton = entry.slots[slot];
        if (slotButton === undefined) continue;
        const code = codes[slot];
        const listening =
          model.phase !== 'idle' && model.action === entry.action && model.slot === slot;
        const clash =
          model.phase === 'conflict' && model.holder === entry.action && model.holderSlot === slot;
        const text = listening
          ? model.phase === 'conflict'
            ? codeLabel(model.code)
            : words.listening
          : code === undefined
            ? slot === 0
              ? 'Not set'
              : 'Add'
            : codeLabel(code);
        if (slotButton.textContent !== text) slotButton.textContent = text;
        slotButton.dataset['state'] = listening
          ? 'listening'
          : clash
            ? 'clash'
            : code === undefined
              ? 'empty'
              : 'set';
        const which = `${label}, ${slot === 0 ? 'first' : 'second'} ${words.thing}`;
        slotButton.setAttribute(
          'aria-label',
          code === undefined
            ? `${which}: not set. Press to choose a ${words.thing}.`
            : `${which}: ${codeLabel(code)}. Press to change.`,
        );
      }
    }
    resetAll.disabled = allDefault;
  };

  return {
    device,
    model,
    nodes: [prompt, list, empty, foot],
    get controls(): ControlsUiState | undefined {
      return controls;
    },
    get stale(): boolean {
      return model.revision !== shownRevision;
    },

    setControls(next: ControlsUiState | undefined): boolean {
      if (next === controls) return false;
      controls = next;
      reconcileRebind(model, next);
      return true;
    },

    draw(): void {
      shownRevision = model.revision;
      const text = rebindPrompt(model);
      prompt.hidden = text === '';
      prompt.dataset['phase'] = model.phase;
      if (promptText.textContent !== text) promptText.textContent = text;
      const conflict = model.phase === 'conflict';
      promptActions.hidden = !conflict;
      if (conflict && controls !== undefined) {
        swapButton.textContent = canSwap(model, controls) ? 'Swap the two' : 'Move it here';
      }
      drawRows();
      if (conflict && document.activeElement !== cancelButton) swapButton.focus();
    },

    focusSlot(action: string, slot: number): void {
      const entry = rows.find((candidate) => candidate.action === action);
      (entry?.slots[slot] ?? entry?.slots[0])?.focus();
    },
  };
}
