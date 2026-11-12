/**
 * Menus with a gamepad: one step of the D-pad or stick, A or B, turned into what the keyboard
 * and mouse already do. The game layer reads the pad (src/ui has no input module) and passes
 * each step to `Ui.navigate`; nothing here runs unless a pad button was pressed.
 *
 * - A direction moves the focus to the nearest control that way (./view-model/spatial.ts).
 *   Left / right on a slider or a select change its value instead, and on a tab change the tab.
 * - A presses the focused button. B is Escape: whatever a screen does for Escape, it does for B.
 * - With a dialog open (flight menu, settings, session notice) only its controls are reached.
 * - While a settings slot listens for a button (`data-capturing`), nothing is navigated: the
 *   press belongs to the slot.
 *
 * The browser draws its focus ring only after keyboard use, so pad use marks the root
 * (`data-df-padnav`) and ui.css draws the same ring for `:focus` under it. The next pointer
 * press clears the mark.
 *
 * Text fields cannot be typed in with a pad; they are reachable but A does nothing in them.
 */

import type { UiNavCommand } from '../shared/ui';
import { pickNeighbour } from './view-model/spatial';
import type { NavDirection, NavRect } from './view-model/spatial';

export interface PadNav {
  /** One step. Returns true when it did something (moved, pressed, changed a value). */
  navigate(command: UiNavCommand): boolean;
  /**
   * The pad was just used for something else (Menu opened the flight menu): show the focus
   * ring, so the button that dialog focuses is visibly the one A will press.
   */
  markUsed(): void;
  dispose(): void;
}

const FOCUSABLE = 'button, input, select, textarea, [tabindex]';

function isUsable(node: HTMLElement): boolean {
  if ((node as HTMLButtonElement).disabled) return false;
  if (node.closest('[hidden], [inert]') !== null) return false;
  // Not laid out (display: none from a style sheet) = not there.
  return node.getClientRects().length > 0;
}

/** The topmost open dialog under `root`, or `root` when there is none. */
function scopeOf(root: HTMLElement): HTMLElement {
  const dialogs = root.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const dialog = dialogs[i];
    if (dialog !== undefined && isUsable(dialog)) return dialog;
  }
  return root;
}

function collect(scope: HTMLElement, out: HTMLElement[]): void {
  out.length = 0;
  const nodes = scope.querySelectorAll<HTMLElement>(FOCUSABLE);
  for (const node of nodes) {
    // tabindex -1 is skipped like Tab skips it, except the unselected tabs of a tab list,
    // which the keyboard reaches with the arrow keys.
    if (node.tabIndex < 0 && node.getAttribute('role') !== 'tab') continue;
    if (isUsable(node)) out.push(node);
  }
}

function sendKey(target: EventTarget, key: string): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }),
  );
}

/** Left / right on a slider or select: one step of its value. True when the control took it. */
function adjust(node: HTMLElement, step: number): boolean {
  if (node instanceof HTMLInputElement && node.type === 'range') {
    const before = node.value;
    if (step > 0) node.stepUp();
    else node.stepDown();
    if (node.value !== before) {
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }
  if (node instanceof HTMLSelectElement) {
    const next = node.selectedIndex + step;
    if (next >= 0 && next < node.options.length) {
      node.selectedIndex = next;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }
  if (node.getAttribute('role') === 'tab') {
    sendKey(node, step > 0 ? 'ArrowRight' : 'ArrowLeft');
    return true;
  }
  return false;
}

export function createPadNav(root: HTMLElement): PadNav {
  const found: HTMLElement[] = [];
  const rects: NavRect[] = [];
  let marked = false;

  const mark = (): void => {
    if (marked) return;
    marked = true;
    root.dataset['dfPadnav'] = 'true';
  };

  const onPointerDown = (): void => {
    if (!marked) return;
    marked = false;
    delete root.dataset['dfPadnav'];
  };
  document.addEventListener('pointerdown', onPointerDown, true);

  const focusOn = (node: HTMLElement): void => {
    node.focus();
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  /** The focused control when it is one of the scope's; otherwise null. */
  const current = (scope: HTMLElement): HTMLElement | null => {
    const active = document.activeElement;
    return active instanceof HTMLElement && scope.contains(active) && active !== scope
      ? active
      : null;
  };

  const focusFirst = (scope: HTMLElement): boolean => {
    collect(scope, found);
    // A dialog's main button first (Resume, Done), as its own keyboard focus does.
    const first = found.find((node) => node.classList.contains('dfu-btn-primary')) ?? found[0];
    if (first === undefined) return false;
    focusOn(first);
    return true;
  };

  const move = (scope: HTMLElement, from: HTMLElement, direction: NavDirection): boolean => {
    collect(scope, found);
    rects.length = 0;
    for (const node of found) rects.push(node.getBoundingClientRect());
    const index = pickNeighbour(from.getBoundingClientRect(), rects, direction);
    const next = found[index];
    if (next === undefined || next === from) return false;
    focusOn(next);
    return true;
  };

  return {
    navigate(command: UiNavCommand): boolean {
      if (root.querySelector('[data-capturing="true"]') !== null) return false;
      mark();
      if (command === 'back') {
        sendKey(document.activeElement ?? document.body, 'Escape');
        return true;
      }
      const scope = scopeOf(root);
      const from = current(scope);
      if (from === null) return focusFirst(scope);
      if (command === 'accept') {
        if (!(from instanceof HTMLButtonElement) || from.disabled) return false;
        from.click();
        return true;
      }
      if (command === 'left' || command === 'right') {
        if (adjust(from, command === 'right' ? 1 : -1)) return true;
      }
      return move(scope, from, command);
    },

    markUsed(): void {
      mark();
    },

    dispose(): void {
      document.removeEventListener('pointerdown', onPointerDown, true);
      if (marked) delete root.dataset['dfPadnav'];
      marked = false;
      found.length = 0;
      rects.length = 0;
    },
  };
}
