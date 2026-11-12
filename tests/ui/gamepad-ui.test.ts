/**
 * The gamepad in the UI (T-6.6): the words of the Controls tab's gamepad section, the pad's
 * rebind model, where a D-pad press moves the focus, and the flight menu driven through
 * `Ui.navigate` on the small fake DOM.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GAMEPAD_BUTTON_CODES, gamepadCodeLabel, gamepadCodeShortLabel } from '../../src/input';
import { DEFAULT_GAME_SETTINGS, DEFAULT_SETTINGS, SETTINGS_LIMITS } from '../../src/shared/ui';
import type { ControlsUiState, UiIntent, UiState } from '../../src/shared/ui';
import { createUi } from '../../src/ui';
import type { Ui } from '../../src/ui';
import {
  GAMEPAD_CANCEL_CODE,
  beginCapture,
  captureCode,
  captureGamepadCode,
  codeLabel,
  codeShortLabel,
  createRangeView,
  createRebindModel,
  gamepadDisplayName,
  gamepadStatus,
  rangeIntent,
  rangeSetting,
  rangeView,
  rebindPrompt,
  resetBindingsIntent,
  resolveConflict,
  toggleIntent,
} from '../../src/ui/settings';
import { MAX_GAMEPAD_NAME_LENGTH } from '../../src/ui/settings/settings-model';
import { pickNeighbour } from '../../src/ui/view-model/spatial';
import type { NavRect } from '../../src/ui/view-model/spatial';
import type { FakeElement } from './fake-dom';
import { createUiRoot, fakeDocument, installFakeDom, makeEvent } from './fake-dom';

const PAD_CONTROLS: ControlsUiState = {
  actions: ['boost', 'flap', 'dive', 'utility'],
  bindings: { boost: ['Pad4'], flap: ['Pad0'], dive: ['Pad1'], utility: [] },
  defaults: { boost: ['Pad4'], flap: ['Pad0'], dive: ['Pad1'], utility: ['Pad2'] },
  slotsPerAction: 2,
  reservedCodes: ['Pad9', 'Pad16'],
};

describe('gamepad words', () => {
  it('names every pad code exactly as the input module does', () => {
    // src/ui may not import src/input, so the two lists are held together here.
    for (const code of [...GAMEPAD_BUTTON_CODES, 'PadFlickLeft', 'PadFlickRight']) {
      expect(codeLabel(code)).toBe(gamepadCodeLabel(code));
      expect(codeShortLabel(code)).toBe(gamepadCodeShortLabel(code));
      expect(codeShortLabel(code).length).toBeLessThanOrEqual(6);
      expect(codeLabel(code)).not.toBe('');
    }
    expect(codeLabel('Pad0')).toBe('A');
    expect(codeLabel('Pad9')).toBe('Menu');
    expect(codeShortLabel('Pad12')).toBe('D↑');
  });

  it('tidies the name a browser gives a pad', () => {
    expect(
      gamepadDisplayName('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'),
    ).toBe('Xbox Wireless Controller');
    expect(gamepadDisplayName('054c-09cc-Wireless Controller')).toBe('Wireless Controller');
    expect(gamepadDisplayName('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe(
      'Xbox 360 Controller',
    );
    expect(gamepadDisplayName('')).toBe('Gamepad');
    expect(gamepadDisplayName('(Vendor: 0000 Product: 0000)')).toBe('Gamepad');
    expect(gamepadDisplayName('a\u0007b   c')).toBe('ab c');
    const long = gamepadDisplayName('Pad '.repeat(4000));
    expect(long.length).toBeLessThanOrEqual(MAX_GAMEPAD_NAME_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });

  it('says what to do when no pad shows, and why a plain http page may hide it', () => {
    const none = gamepadStatus(true, true, false, '', false);
    expect(none.title).toBe('No gamepad detected');
    expect(none.connected).toBe(false);
    expect(none.note).toContain('press any button');
    expect(none.note).toContain('localhost or HTTPS');
    const lan = gamepadStatus(true, false, false, '', false);
    expect(lan.title).toBe('No gamepad detected');
    expect(lan.note).toContain('plain http address');
    const blocked = gamepadStatus(false, false, false, '', false);
    expect(blocked.title).toBe('Gamepads are not available here');
    expect(blocked.note).toContain('localhost or HTTPS');
    const there = gamepadStatus(true, true, true, 'Fake Controller (Vendor: 1 Product: 2)', true);
    expect(there.title).toBe('Fake Controller');
    expect(there.connected).toBe(true);
    expect(there.note).toContain('Menu (Start)');
    const odd = gamepadStatus(true, true, true, 'Old Stick', false);
    expect(odd.note).toContain('layout');
  });
});

describe('gamepad settings controls', () => {
  it('maps the three sliders to their settings and back', () => {
    const view = createRangeView();
    rangeView('gamepadSensitivity', DEFAULT_GAME_SETTINGS, view);
    expect([view.min, view.max, view.step, view.value, view.text]).toEqual([
      50,
      200,
      5,
      100,
      '1.00×',
    ]);
    rangeView('gamepadDeadZone', DEFAULT_GAME_SETTINGS, view);
    expect([view.min, view.max, view.step, view.value, view.text]).toEqual([5, 40, 1, 15, '15 %']);
    rangeView('gamepadCurve', DEFAULT_GAME_SETTINGS, view);
    expect([view.min, view.max, view.step, view.value, view.text]).toEqual([10, 30, 1, 16, '1.6']);
    rangeView('gamepadCurve', { ...DEFAULT_GAME_SETTINGS, gamepadCurve: 1 }, view);
    expect(view.text).toBe('Linear');

    expect(rangeSetting('gamepadCurve', 24, DEFAULT_GAME_SETTINGS)).toBeCloseTo(2.4);
    expect(rangeSetting('gamepadDeadZone', 22, DEFAULT_GAME_SETTINGS)).toBeCloseTo(0.22);
    expect(rangeIntent('gamepadSensitivity', 150, DEFAULT_GAME_SETTINGS)).toEqual({
      type: 'settings.update',
      patch: { gamepadSensitivity: 1.5 },
    });
    expect(rangeIntent('gamepadCurve', 30, DEFAULT_GAME_SETTINGS)).toEqual({
      type: 'settings.update',
      patch: { gamepadCurve: SETTINGS_LIMITS.gamepadCurve.max },
    });
    expect(toggleIntent('gamepadRumble', true)).toEqual({
      type: 'settings.update',
      patch: { gamepadRumble: true },
    });
    expect(toggleIntent('gamepadInvertY', true)).toEqual({
      type: 'settings.update',
      patch: { gamepadInvertY: true },
    });
  });
});

describe('the gamepad rebind model', () => {
  it('raises intents that name the gamepad', () => {
    const model = createRebindModel('gamepad');
    expect(model.device).toBe('gamepad');
    beginCapture(model, PAD_CONTROLS, 'utility', 0);
    expect(rebindPrompt(model)).toContain('Press a button on the gamepad for Utility ability');
    expect(captureGamepadCode(model, PAD_CONTROLS, 'Pad5')).toEqual({
      type: 'settings.rebind',
      action: 'utility',
      slot: 0,
      code: 'Pad5',
      swap: false,
      device: 'gamepad',
    });
    expect(model.phase).toBe('idle');
    expect(resetBindingsIntent(model, null)).toEqual({
      type: 'settings.resetBindings',
      action: null,
      device: 'gamepad',
    });
    expect(resetBindingsIntent(model, 'boost')).toEqual({
      type: 'settings.resetBindings',
      action: 'boost',
      device: 'gamepad',
    });
    // Backspace on the keyboard clears a pad slot.
    beginCapture(model, PAD_CONTROLS, 'boost', 0);
    expect(captureCode(model, PAD_CONTROLS, 'Backspace')).toEqual({
      type: 'settings.unbind',
      action: 'boost',
      slot: 0,
      device: 'gamepad',
    });
  });

  it('keeps the keyboard intents as they were (no device)', () => {
    const model = createRebindModel();
    expect(model.device).toBe('keyboard');
    expect(resetBindingsIntent(model, null)).toEqual({
      type: 'settings.resetBindings',
      action: null,
    });
  });

  it('cancels on Menu, refuses Home, and asks before taking a button in use', () => {
    const model = createRebindModel('gamepad');
    beginCapture(model, PAD_CONTROLS, 'utility', 0);
    expect(captureGamepadCode(model, PAD_CONTROLS, GAMEPAD_CANCEL_CODE)).toBeNull();
    expect(model.phase).toBe('idle');

    beginCapture(model, PAD_CONTROLS, 'utility', 0);
    expect(captureGamepadCode(model, PAD_CONTROLS, 'Pad16')).toBeNull();
    expect(model.phase).toBe('listening');
    expect(model.note).toBe('reserved');
    expect(rebindPrompt(model)).toContain('That button cannot be used');

    expect(captureGamepadCode(model, PAD_CONTROLS, 'Pad0')).toBeNull();
    expect(model.phase).toBe('conflict');
    expect(rebindPrompt(model)).toBe('A is already Wingbeat (climb).');
    expect(resolveConflict(model, 'swap')).toEqual({
      type: 'settings.rebind',
      action: 'utility',
      slot: 0,
      code: 'Pad0',
      swap: true,
      device: 'gamepad',
    });
    // Not listening: a press is nobody's.
    expect(captureGamepadCode(model, PAD_CONTROLS, 'Pad3')).toBeNull();
  });
});

describe('pickNeighbour', () => {
  const rect = (left: number, top: number, width = 100, height = 30): NavRect => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
  });

  it('steps through a column and stops at its ends', () => {
    const column = [rect(0, 0), rect(0, 40), rect(0, 80), rect(0, 120)];
    const second = column[1] as NavRect;
    expect(pickNeighbour(second, column, 'down')).toBe(2);
    expect(pickNeighbour(second, column, 'up')).toBe(0);
    expect(pickNeighbour(column[3] as NavRect, column, 'down')).toBe(-1);
    expect(pickNeighbour(column[0] as NavRect, column, 'up')).toBe(-1);
    expect(pickNeighbour(second, column, 'left')).toBe(-1);
    expect(pickNeighbour(second, column, 'right')).toBe(-1);
  });

  it('stays in its column in a grid, and moves along a row sideways', () => {
    // Two slots and a reset per row, as in the key list.
    const grid = [
      rect(0, 0),
      rect(110, 0),
      rect(220, 0, 50),
      rect(0, 40),
      rect(110, 40),
      rect(220, 40, 50),
      rect(0, 80),
      rect(110, 80),
      rect(220, 80, 50),
    ];
    expect(pickNeighbour(grid[1] as NavRect, grid, 'down')).toBe(4);
    expect(pickNeighbour(grid[4] as NavRect, grid, 'down')).toBe(7);
    expect(pickNeighbour(grid[4] as NavRect, grid, 'up')).toBe(1);
    expect(pickNeighbour(grid[4] as NavRect, grid, 'left')).toBe(3);
    expect(pickNeighbour(grid[4] as NavRect, grid, 'right')).toBe(5);
    expect(pickNeighbour(grid[5] as NavRect, grid, 'right')).toBe(-1);
  });

  it('prefers the control straight below over a nearer one off to the side', () => {
    const from = rect(0, 0);
    const list = [rect(300, 35), rect(0, 90)];
    expect(pickNeighbour(from, list, 'down')).toBe(1);
    // With nothing straight below, the one off to the side is still reached.
    expect(pickNeighbour(from, [rect(300, 35)], 'down')).toBe(0);
    // A taller neighbour in the same row is not "below".
    expect(pickNeighbour(rect(0, 0, 100, 30), [rect(110, 0, 100, 44)], 'down')).toBe(-1);
  });
});

describe('the flight menu with a gamepad', () => {
  let uninstall: () => void = () => {};
  let root: FakeElement;
  let ui: Ui;
  let intents: UiIntent[] = [];

  const matchState = (pauseMenuOpen: boolean): UiState => ({
    screen: 'match',
    connection: { status: 'connected', isHost: false, localPlayerId: 0, pingMs: 20, error: null },
    settings: DEFAULT_SETTINGS,
    lobby: null,
    loading: null,
    hud: null,
    results: null,
    startBlocker: null,
    pauseMenuOpen,
  });

  /** Gives the open dialog and its visible buttons a place on the page, top to bottom. */
  const layOut = (): FakeElement[] => {
    const dialog = root
      .querySelectorAll('[aria-modal="true"]')
      .find((node) => !node.closest('[hidden]'));
    if (dialog === undefined) throw new Error('no open dialog');
    dialog.rect = { left: 400, top: 100, right: 800, bottom: 500 };
    const buttons = dialog.querySelectorAll('button').filter((node) => !node.hidden);
    buttons.forEach((node, index) => {
      node.rect = { left: 450, top: 160 + index * 60, right: 750, bottom: 200 + index * 60 };
    });
    return buttons;
  };

  beforeEach(() => {
    uninstall = installFakeDom();
    const page = createUiRoot();
    root = page.fake;
    intents = [];
    ui = createUi(page.element, (intent) => intents.push(intent), {
      nameStore: { load: () => 'Aman', save: () => undefined },
      now: () => 1000,
    });
  });

  afterEach(() => {
    ui.dispose();
    uninstall();
  });

  it('focuses Resume, steps with the D-pad and presses with A', () => {
    ui.update(matchState(true));
    const buttons = layOut();
    expect(buttons.map((node) => node.textContent)).toEqual(['Resume', 'Settings', 'Leave match']);
    // The menu focuses Resume itself when it opens.
    expect(fakeDocument.activeElement).toBe(buttons[0]);
    ui.markPadUsed();
    expect(root.dataset['dfPadnav']).toBe('true');

    ui.navigate('down');
    expect(fakeDocument.activeElement).toBe(buttons[1]);
    ui.navigate('down');
    expect(fakeDocument.activeElement).toBe(buttons[2]);
    ui.navigate('down');
    expect(fakeDocument.activeElement).toBe(buttons[2]);
    ui.navigate('up');
    ui.navigate('up');
    expect(fakeDocument.activeElement).toBe(buttons[0]);
    expect(intents).toEqual([]);

    ui.navigate('accept');
    expect(intents).toEqual([{ type: 'match.resume' }]);
    ui.navigate('down');
    ui.navigate('accept');
    expect(intents[1]).toEqual({ type: 'settings.open' });
    ui.navigate('down');
    ui.navigate('accept');
    expect(intents[2]).toEqual({ type: 'match.leave' });
  });

  it('B closes the menu like Escape, and does not open it', () => {
    ui.update(matchState(true));
    layOut();
    ui.navigate('back');
    expect(intents).toEqual([{ type: 'match.resume' }]);
    ui.update(matchState(false));
    ui.navigate('back');
    ui.navigate('accept');
    ui.navigate('down');
    expect(intents).toEqual([{ type: 'match.resume' }]);
  });

  it('gives the focus to the main button when nothing in the dialog has it', () => {
    ui.update(matchState(true));
    const buttons = layOut();
    fakeDocument.activeElement = null;
    ui.navigate('down');
    expect(fakeDocument.activeElement).toBe(buttons[0]);
  });

  it('stands back while a settings slot is listening for a button', () => {
    ui.update(matchState(true));
    const buttons = layOut();
    const listening = fakeDocument.createElement('div');
    listening.dataset['capturing'] = 'true';
    root.appendChild(listening);
    ui.navigate('down');
    ui.navigate('accept');
    ui.navigate('back');
    expect(fakeDocument.activeElement).toBe(buttons[0]);
    expect(intents).toEqual([]);
    listening.dataset['capturing'] = 'false';
    ui.navigate('down');
    expect(fakeDocument.activeElement).toBe(buttons[1]);
  });

  it('gives the focus back to the button behind a dialog when the dialog closes', () => {
    // The title with the settings panel over it: the page is disabled meanwhile, so the panel's
    // own "return the focus" does nothing and the keyboard was left with no focus at all.
    const title = (settingsOpen: boolean): UiState => ({
      ...matchState(false),
      screen: 'title',
      connection: { status: 'offline', isHost: false, localPlayerId: 0, pingMs: 0, error: null },
      settingsOpen,
    });
    ui.update(title(false));
    const opener = root
      .querySelectorAll('button')
      .find((node) => node.textContent === 'Settings' && !node.closest('[hidden]'));
    if (opener === undefined) throw new Error('no Settings button on the title');
    opener.focus();
    opener.dispatchEvent(makeEvent('focusin', opener));

    ui.update(title(true));
    // The dialog took the focus, and dropped it when it closed.
    fakeDocument.activeElement = null;
    ui.update(title(true));
    expect(fakeDocument.activeElement).toBeNull();
    ui.update(title(false));
    expect(fakeDocument.activeElement).toBe(opener);

    // Something else already has the focus: it keeps it.
    ui.update(title(true));
    const other = fakeDocument.createElement('button');
    root.appendChild(other);
    other.focus();
    ui.update(title(false));
    expect(fakeDocument.activeElement).toBe(other);
  });

  it('drops the pad focus mark when it is disposed', () => {
    ui.markPadUsed();
    expect(root.dataset['dfPadnav']).toBe('true');
    ui.dispose();
    expect(root.dataset['dfPadnav']).toBeUndefined();
    ui.navigate('down');
    ui.markPadUsed();
    expect(root.dataset['dfPadnav']).toBeUndefined();
  });
});
