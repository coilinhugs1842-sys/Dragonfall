/**
 * The gamepad's share of the game layer, kept out of `game.ts`: once per rendered frame it reads
 * the pad and says what the game should do about it.
 *
 * - `pausePressed`: Menu (Start) went down: open or close the escape menu.
 * - `nav`: a menu step (D-pad / stick, A, B) for `Ui.navigate`, while a menu is in front.
 * - `ui`: what the Controls tab shows (`UiState.gamepad`): the pad's name, its rebind table and
 *   the button pressed last, which is how the tab listens for a new binding.
 * - The HUD's key captions follow the device in use: pad glyphs while the pad gave the last
 *   input, the keyboard's otherwise.
 * - The gamepad settings and the pad's rebind table reach the input layer from here.
 *
 * WITHOUT A PAD this is one `poll()` (which asks the browser about once a second whether a pad
 * has appeared) and two comparisons per frame. Nothing here allocates per frame; the caption
 * arrays are rebuilt on a rebind only.
 */

import type { InputBindings, InputCode } from '../../input/bindings';
import { gamepadCodeShortLabel } from '../../input/gamepad-bindings';
import { createGamepadMenuState, pollGamepadMenu } from '../../input/gamepad-menu';
import type { GamepadState } from '../../input/gamepad-state';
import type { InputDevice } from '../../input/input-state';
import { ABILITY_SLOTS } from '../../shared';
import type { GamepadUiState, UiNavCommand } from '../../shared';
import { bindSettingsTargets } from './apply';
import type { SettingsStore } from './store';

/** The part of `InputController` the link uses (a real one fits; a test passes a small fake). */
export interface GamepadLinkInput {
  readonly gamepad: GamepadState;
  readonly activeDevice: InputDevice;
  readonly gamepadSupported: boolean;
  poll(nowMs?: number): void;
  consumePausePress(nowMs?: number): boolean;
  consumeGamepadPress(nowMs?: number): InputCode | undefined;
  setGamepadBindings(bindings: InputBindings): void;
}

export interface GamepadLinkOptions {
  readonly input: GamepadLinkInput;
  readonly store: SettingsStore;
  /** The captions of the four ability slots changed (`HudBuilder.setKeyLabels`). */
  setKeyLabels(labels: readonly string[]): void;
  /**
   * A pad appeared or went away: the page marks it, so the "click to fly" prompt can add that
   * a button on the pad works too.
   */
  onPresence?(connected: boolean): void;
  /** The page is a secure context. Default: what the browser says (true where it does not). */
  readonly secure?: boolean;
}

export interface GamepadLink {
  /** For `UiState.gamepad`: one object, rewritten in place. */
  readonly ui: GamepadUiState;
  /** Menu (Start) was pressed since the last frame. */
  readonly pausePressed: boolean;
  /** This frame's menu step, or null. Always null while `menuInFront` is false. */
  readonly nav: UiNavCommand | null;
  /**
   * Once per rendered frame, before anything asks the input for this frame.
   * `menuInFront`: the player is not flying, so the pad steps through menus.
   * `settingsOpen`: the Controls tab may be listening for a button.
   */
  frame(nowMs: number, menuInFront: boolean, settingsOpen: boolean): void;
  /** The keyboard's captions for the four ability slots (after a rebind). */
  setKeyboardLabels(labels: readonly string[]): void;
  dispose(): void;
}

type MutableGamepadUi = { -readonly [K in keyof GamepadUiState]: GamepadUiState[K] };

function pageIsSecure(): boolean {
  return typeof isSecureContext === 'boolean' ? isSecureContext : true;
}

export function createGamepadLink(options: GamepadLinkOptions): GamepadLink {
  const { input, store } = options;
  const menu = createGamepadMenuState();
  const keyboardLabels: string[] = ABILITY_SLOTS.map(() => '');
  const padLabels: string[] = ABILITY_SLOTS.map(() => '');
  const ui: MutableGamepadUi = {
    supported: input.gamepadSupported,
    secure: options.secure ?? pageIsSecure(),
    connected: false,
    name: '',
    standard: false,
    controls: store.gamepadControls,
    pressCode: '',
    pressSeq: 0,
  };
  let shownDevice: InputDevice = 'keyboard';
  let haveKeyboardLabels = false;
  let pausePressed = false;
  let nav: UiNavCommand | null = null;

  const showLabels = (): void => {
    // Until the keyboard's captions arrive the HUD keeps its own defaults.
    if (shownDevice === 'gamepad') options.setKeyLabels(padLabels);
    else if (haveKeyboardLabels) options.setKeyLabels(keyboardLabels);
  };

  const unbind = bindSettingsTargets(store, {
    setGamepad(sensitivity, invertY, deadZone, curveExponent, rumble): void {
      const pad = input.gamepad.options;
      pad.sensitivity = sensitivity;
      pad.invertY = invertY;
      pad.deadZone = deadZone;
      pad.curveExponent = curveExponent;
      pad.rumble = rumble;
    },
    setGamepadBindings(bindings): void {
      input.setGamepadBindings(bindings);
      for (let i = 0; i < ABILITY_SLOTS.length; i++) {
        const slot = ABILITY_SLOTS[i];
        const code = slot === undefined ? undefined : bindings[slot][0];
        padLabels[i] = code === undefined ? '' : gamepadCodeShortLabel(code);
      }
      if (shownDevice === 'gamepad') showLabels();
    },
  });

  return {
    ui,
    get pausePressed(): boolean {
      return pausePressed;
    },
    get nav(): UiNavCommand | null {
      return nav;
    },

    frame(nowMs: number, menuInFront: boolean, settingsOpen: boolean): void {
      input.poll(nowMs);
      const pad = input.gamepad;
      pausePressed = false;
      nav = null;
      ui.controls = store.gamepadControls;
      if (pad.connected !== ui.connected || pad.id !== ui.name) {
        const was = ui.connected;
        ui.connected = pad.connected;
        ui.name = pad.id;
        ui.standard = pad.standard;
        ui.supported = input.gamepadSupported;
        if (was !== pad.connected) options.onPresence?.(pad.connected);
      }
      if (pad.connected) {
        pausePressed = input.consumePausePress(nowMs);
        // Asked for on every frame, so a press from before the panel opened is not kept for it.
        const code = input.consumeGamepadPress(nowMs);
        if (settingsOpen && code !== undefined) {
          ui.pressCode = code;
          ui.pressSeq++;
        }
        nav = pollGamepadMenu(menu, pad, nowMs, menuInFront);
      } else if (menu.active) {
        pollGamepadMenu(menu, pad, nowMs, false);
      }
      const device = input.activeDevice;
      if (device !== shownDevice) {
        shownDevice = device;
        showLabels();
      }
    },

    setKeyboardLabels(labels: readonly string[]): void {
      for (let i = 0; i < keyboardLabels.length; i++) keyboardLabels[i] = labels[i] ?? '';
      haveKeyboardLabels = true;
      if (shownDevice === 'keyboard') showLabels();
    },

    dispose(): void {
      unbind();
    },
  };
}
