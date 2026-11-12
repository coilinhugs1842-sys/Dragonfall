/**
 * The gamepad's share of the settings (T-6.6): its own stored rebind table, the device on the
 * rebind intents, the two settings targets, and the game layer's gamepad link.
 */
import { describe, expect, it } from 'vitest';
import {
  applyRebind,
  applyResetBindings,
  applySettings,
  bindingDeviceOf,
  controlsUiStateFor,
  createGamepadLink,
  createSettingsStore,
  handleSettingsIntent,
  parseSettingsData,
} from '../../src/game/settings';
import type { GamepadLinkInput, SettingsTargets } from '../../src/game/settings';
import { SETTINGS_STORAGE_KEY } from '../../src/game/stored-quality';
import { InputController } from '../../src/input';
import { DEFAULT_BINDINGS, findBindingConflicts } from '../../src/input/bindings';
import { DEFAULT_GAMEPAD_BINDINGS } from '../../src/input/gamepad-bindings';
import { DEFAULT_GAME_SETTINGS } from '../../src/shared';
import { FakeCanvas, FakeDocument, FakeNavigator, FakePad, FakeTarget, PAD } from '../input/fakes';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      data.set(key, value);
    },
  };
}

describe('the gamepad binding table', () => {
  it('names its device and only takes its own codes', () => {
    expect(bindingDeviceOf('gamepad')).toBe('gamepad');
    for (const other of [undefined, null, 'keyboard', 'pad', 7, {}]) {
      expect(bindingDeviceOf(other)).toBe('keyboard');
    }
    const pad = DEFAULT_GAMEPAD_BINDINGS;
    expect(applyRebind(pad, 'utility', 0, 'Pad5', false, 'gamepad').utility).toEqual(['Pad5']);
    // A key in the pad's table, a pad button in the keyboard's, and the reserved buttons.
    expect(applyRebind(pad, 'utility', 0, 'KeyG', false, 'gamepad')).toBe(pad);
    expect(applyRebind(pad, 'utility', 0, 'Pad9', false, 'gamepad')).toBe(pad);
    expect(applyRebind(pad, 'utility', 0, 'Pad16', false, 'gamepad')).toBe(pad);
    expect(applyRebind(pad, 'utility', 0, 'Pad99', false, 'gamepad')).toBe(pad);
    expect(applyRebind(DEFAULT_BINDINGS, 'utility', 0, 'Pad5', false)).toBe(DEFAULT_BINDINGS);
    expect(applyRebind(DEFAULT_BINDINGS, 'utility', 0, 'Pad5', false, 'keyboard')).toBe(
      DEFAULT_BINDINGS,
    );
  });

  it('handles a conflict the way the keyboard table does: take or swap', () => {
    const pad = DEFAULT_GAMEPAD_BINDINGS;
    // A is the wingbeat by default: giving it to Utility takes it from there...
    const taken = applyRebind(pad, 'utility', 0, 'Pad0', false, 'gamepad');
    expect(taken.utility).toEqual(['Pad0']);
    expect(taken.flap).toEqual([]);
    expect(findBindingConflicts(taken)).toEqual([]);
    // ...and a swap hands the wingbeat what Utility had.
    const swapped = applyRebind(pad, 'utility', 0, 'Pad0', true, 'gamepad');
    expect(swapped.utility).toEqual(['Pad0']);
    expect(swapped.flap).toEqual(['Pad2']);
    expect(findBindingConflicts(swapped)).toEqual([]);
    // Resetting one action or all of them goes back to the pad's defaults, not the keyboard's.
    expect(applyResetBindings(swapped, 'utility', 'gamepad').utility).toEqual(['Pad2']);
    expect(applyResetBindings(swapped, null, 'gamepad')).toEqual(DEFAULT_GAMEPAD_BINDINGS);
  });

  it('describes itself for the Controls tab', () => {
    const controls = controlsUiStateFor(DEFAULT_GAMEPAD_BINDINGS, 'gamepad');
    expect(controls.actions).toEqual(Object.keys(DEFAULT_GAMEPAD_BINDINGS));
    expect(controls.bindings['boost']).toEqual(['Pad4']);
    expect(controls.defaults['primary']).toEqual(['Pad7']);
    expect(controls.reservedCodes).toContain('Pad9');
    expect(controls.reservedCodes).toContain('Pad16');
  });
});

describe('the store with two tables', () => {
  it('keeps them apart, saves both and loads both', () => {
    const storage = memoryStorage();
    const store = createSettingsStore({ storage });
    expect(store.gamepadBindings).toEqual(DEFAULT_GAMEPAD_BINDINGS);
    const keyControls = store.controls;
    const padControls = store.gamepadControls;

    store.rebind('utility', 0, 'Pad5', false, 'gamepad');
    expect(store.gamepadBindings.utility).toEqual(['Pad5']);
    expect(store.bindings).toEqual(DEFAULT_BINDINGS);
    // Only the pad's view object was replaced.
    expect(store.controls).toBe(keyControls);
    expect(store.gamepadControls).not.toBe(padControls);
    expect(store.gamepadControls.bindings['utility']).toEqual(['Pad5']);

    store.rebind('utility', 0, 'KeyG', false);
    expect(store.bindings.utility).toEqual(['KeyG']);
    expect(store.gamepadBindings.utility).toEqual(['Pad5']);
    store.update({ gamepadSensitivity: 1.5, gamepadRumble: true });
    store.flush();

    const again = createSettingsStore({ storage });
    expect(again.gamepadBindings.utility).toEqual(['Pad5']);
    expect(again.bindings.utility).toEqual(['KeyG']);
    expect(again.settings.gamepadSensitivity).toBe(1.5);
    expect(again.settings.gamepadRumble).toBe(true);
    const saved = parseSettingsData(storage.data.get(SETTINGS_STORAGE_KEY) ?? null);
    expect(saved.gamepadBindings.utility).toEqual(['Pad5']);

    again.unbind('utility', 0, 'gamepad');
    expect(again.gamepadBindings.utility).toEqual([]);
    expect(again.bindings.utility).toEqual(['KeyG']);
    again.resetBindings(null, 'gamepad');
    expect(again.gamepadBindings).toEqual(DEFAULT_GAMEPAD_BINDINGS);
    expect(again.bindings.utility).toEqual(['KeyG']);
    again.reset();
    expect(again.bindings).toEqual(DEFAULT_BINDINGS);
    expect(again.settings).toEqual(DEFAULT_GAME_SETTINGS);
  });

  it('routes the device of a rebind intent', () => {
    const store = createSettingsStore({ storage: null });
    const hooks = { open: (): void => {}, close: (): void => {}, redetectDisplay: (): void => {} };
    handleSettingsIntent(
      store,
      {
        type: 'settings.rebind',
        action: 'boost',
        slot: 1,
        code: 'Pad5',
        swap: false,
        device: 'gamepad',
      },
      hooks,
    );
    expect(store.gamepadBindings.boost).toEqual(['Pad4', 'Pad5']);
    expect(store.bindings).toEqual(DEFAULT_BINDINGS);
    handleSettingsIntent(
      store,
      { type: 'settings.unbind', action: 'boost', slot: 0, device: 'gamepad' },
      hooks,
    );
    expect(store.gamepadBindings.boost).toEqual(['Pad5']);
    handleSettingsIntent(
      store,
      { type: 'settings.resetBindings', action: 'boost', device: 'gamepad' },
      hooks,
    );
    expect(store.gamepadBindings.boost).toEqual(['Pad4']);
    // A pad code sent without the device is a keyboard rebind, and refused there.
    handleSettingsIntent(
      store,
      { type: 'settings.rebind', action: 'boost', slot: 0, code: 'Pad5', swap: false },
      hooks,
    );
    expect(store.bindings).toEqual(DEFAULT_BINDINGS);
    expect(store.gamepadBindings).toEqual(DEFAULT_GAMEPAD_BINDINGS);
  });
});

describe('the gamepad settings targets', () => {
  it('are called on the first apply and then only when their values change', () => {
    const calls: string[] = [];
    const targets: SettingsTargets = {
      setGamepad: (sensitivity, invertY, deadZone, curve, rumble) =>
        calls.push(`pad ${sensitivity} ${invertY} ${deadZone} ${curve} ${rumble}`),
      setGamepadBindings: (bindings) => calls.push(`padBindings ${bindings.boost.join('+')}`),
    };
    const base = {
      settings: DEFAULT_GAME_SETTINGS,
      bindings: DEFAULT_BINDINGS,
      gamepadBindings: DEFAULT_GAMEPAD_BINDINGS,
    };
    applySettings(targets, base, null);
    expect(calls).toEqual(['pad 1 false 0.15 1.6 false', 'padBindings Pad4']);
    calls.length = 0;
    applySettings(targets, { ...base, settings: { ...DEFAULT_GAME_SETTINGS, fovDeg: 90 } }, base);
    applySettings(targets, { ...base, bindings: { ...DEFAULT_BINDINGS } }, base);
    expect(calls).toEqual([]);
    applySettings(
      targets,
      { ...base, settings: { ...DEFAULT_GAME_SETTINGS, gamepadDeadZone: 0.3 } },
      base,
    );
    applySettings(
      targets,
      { ...base, settings: { ...DEFAULT_GAME_SETTINGS, gamepadRumble: true } },
      base,
    );
    applySettings(
      targets,
      {
        ...base,
        gamepadBindings: applyRebind(base.gamepadBindings, 'boost', 0, 'Pad5', false, 'gamepad'),
      },
      base,
    );
    expect(calls).toEqual([
      'pad 1 false 0.3 1.6 false',
      'pad 1 false 0.15 1.6 true',
      'padBindings Pad5',
    ]);
  });
});

describe('createGamepadLink', () => {
  function rig(connectPad = true) {
    const doc = new FakeDocument();
    const win = new FakeTarget();
    const nav = new FakeNavigator();
    const controller = new InputController(new FakeCanvas(doc) as unknown as HTMLElement, {
      document: doc as unknown as Document,
      window: win as unknown as Window,
      navigator: nav,
    });
    const store = createSettingsStore({ storage: null });
    const labels: string[][] = [];
    const presence: boolean[] = [];
    const link = createGamepadLink({
      input: controller,
      store,
      setKeyLabels: (next) => labels.push([...next]),
      onPresence: (connected) => presence.push(connected),
      secure: false,
    });
    const pad = new FakePad();
    const plug = (): void => {
      nav.pads = [pad];
      win.dispatch('gamepadconnected', { gamepad: { index: 0 } });
    };
    if (connectPad) plug();
    return { controller, store, link, labels, presence, pad, nav, win, plug };
  }

  it('costs a pad-less page nothing and says so', () => {
    const r = rig(false);
    r.nav.pads = [null, null, null, null];
    for (let i = 0; i < 600; i++) r.link.frame(i * 16, i % 2 === 0, false);
    // The browser is asked about once a second, not every frame.
    expect(r.nav.calls).toBeLessThanOrEqual(12);
    expect(r.link.ui.connected).toBe(false);
    expect(r.link.ui.supported).toBe(true);
    expect(r.link.ui.secure).toBe(false);
    expect(r.link.ui.name).toBe('');
    expect(r.link.ui.pressSeq).toBe(0);
    expect(r.link.pausePressed).toBe(false);
    expect(r.link.nav).toBeNull();
    expect(r.presence).toEqual([]);
    expect(r.labels).toEqual([]);
  });

  it('reports a pad that appears and one that goes away', () => {
    const r = rig(false);
    r.link.frame(0, true, false);
    expect(r.link.ui.connected).toBe(false);
    r.plug();
    r.link.frame(16, true, false);
    expect(r.link.ui.connected).toBe(true);
    expect(r.link.ui.name).toBe(r.pad.id);
    expect(r.link.ui.standard).toBe(true);
    expect(r.presence).toEqual([true]);
    r.nav.pads = [null];
    r.win.dispatch('gamepaddisconnected', { gamepad: { index: 0 } });
    r.link.frame(32, true, false);
    expect(r.link.ui.connected).toBe(false);
    expect(r.presence).toEqual([true, false]);
  });

  it('writes the gamepad settings and the pad table into the input layer', () => {
    const r = rig();
    const options = r.controller.gamepad.options;
    expect(options.sensitivity).toBe(1);
    expect(options.deadZone).toBe(0.15);
    expect(options.curveExponent).toBe(1.6);
    expect(options.rumble).toBe(false);
    r.store.update({
      gamepadSensitivity: 1.5,
      gamepadInvertY: true,
      gamepadDeadZone: 0.3,
      gamepadCurve: 2.2,
      gamepadRumble: true,
    });
    expect(options.sensitivity).toBe(1.5);
    expect(options.invertY).toBe(true);
    expect(options.deadZone).toBe(0.3);
    expect(options.curveExponent).toBe(2.2);
    expect(options.rumble).toBe(true);
    // The link's view of the pad table follows the store.
    r.store.rebind('utility', 0, 'Pad5', false, 'gamepad');
    r.link.frame(0, true, false);
    expect(r.link.ui.controls).toBe(r.store.gamepadControls);
    expect(r.link.ui.controls.bindings['utility']).toEqual(['Pad5']);
    r.link.dispose();
    r.store.update({ gamepadSensitivity: 0.5 });
    expect(options.sensitivity).toBe(1.5);
  });

  it('gives Menu as the pause press and D-pad / A / B as menu steps', () => {
    const r = rig();
    r.link.frame(0, true, false);
    r.pad.press(PAD.MENU);
    r.link.frame(16, true, false);
    expect(r.link.pausePressed).toBe(true);
    r.link.frame(32, true, false);
    expect(r.link.pausePressed).toBe(false);
    r.pad.release(PAD.MENU).press(PAD.DOWN);
    r.link.frame(48, true, false);
    expect(r.link.nav).toBe('down');
    r.pad.release(PAD.DOWN).press(PAD.A);
    r.link.frame(64, true, false);
    expect(r.link.nav).toBe('accept');
    r.link.frame(80, true, false);
    expect(r.link.nav).toBeNull();
    // While flying there are no menu steps, and the button held as a menu opens is not one.
    r.link.frame(96, false, false);
    r.link.frame(112, true, false);
    expect(r.link.nav).toBeNull();
    r.pad.release(PAD.A);
    r.link.frame(128, true, false);
    r.pad.press(PAD.B);
    r.link.frame(144, true, false);
    expect(r.link.nav).toBe('back');
  });

  it('passes button presses to the Controls tab only while the settings are open', () => {
    const r = rig();
    r.link.frame(0, true, false);
    r.pad.press(PAD.X);
    r.link.frame(16, true, false);
    expect(r.link.ui.pressSeq).toBe(0);
    r.pad.release(PAD.X);
    r.link.frame(32, true, true);
    expect(r.link.ui.pressSeq).toBe(0);
    r.pad.press(PAD.RB);
    r.link.frame(48, true, true);
    expect(r.link.ui.pressSeq).toBe(1);
    expect(r.link.ui.pressCode).toBe('Pad5');
    r.link.frame(64, true, true);
    expect(r.link.ui.pressSeq).toBe(1);
    r.pad.release(PAD.RB).press(PAD.MENU);
    r.link.frame(80, true, true);
    expect(r.link.ui.pressSeq).toBe(2);
    expect(r.link.ui.pressCode).toBe('Pad9');
  });

  it('shows pad captions on the HUD while the pad is in use, and the keyboard ones otherwise', () => {
    const r = rig();
    const input: GamepadLinkInput = r.controller;
    expect(input.activeDevice).toBe('keyboard');
    r.link.setKeyboardLabels(['LMB', 'RMB', 'F', 'R']);
    expect(r.labels).toEqual([['LMB', 'RMB', 'F', 'R']]);
    r.controller.setEnabled(true);
    r.link.frame(0, false, false);
    expect(r.labels).toHaveLength(1);
    // The first button press hands the pad the flight (no click on the picture needed).
    r.pad.press(PAD.A);
    r.link.frame(16, false, false);
    expect(r.controller.gamepadFlying).toBe(true);
    expect(r.controller.flying).toBe(true);
    expect(r.labels[1]).toEqual(['RT', 'LT', 'X', 'Y']);
    // A rebind of the pad shows at once; one of the keyboard waits until the keyboard is back.
    r.store.rebind('utility', 0, 'Pad5', false, 'gamepad');
    expect(r.labels[2]).toEqual(['RT', 'LT', 'RB', 'Y']);
    r.link.setKeyboardLabels(['LMB', 'RMB', 'G', 'R']);
    expect(r.labels).toHaveLength(3);
    // Unplugged: back to the keyboard's captions.
    r.nav.pads = [null];
    r.win.dispatch('gamepaddisconnected', { gamepad: { index: 0 } });
    r.link.frame(32, false, false);
    expect(r.controller.activeDevice).toBe('keyboard');
    expect(r.labels[3]).toEqual(['LMB', 'RMB', 'G', 'R']);
  });
});
