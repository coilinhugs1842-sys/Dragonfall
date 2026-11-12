/**
 * The DOM shell of the input module: browser events in, `InputState` calls out. All the logic
 * (bindings, reticle, sampling) is in ./input-state.ts and is tested without a browser.
 *
 * POINTER LOCK LIFECYCLE
 * - A click on the canvas requests the lock (browsers only grant it from a user gesture).
 * - Raw mouse input is requested with `unadjustedMovement: true` (no OS pointer acceleration).
 *   Where that is unsupported the promise rejects with NotSupportedError and the lock is requested
 *   again without the option; older browsers return no promise at all, which is handled too.
 * - The lock ends on Esc (the browser does that itself), on window blur, when the tab is hidden,
 *   and on `releaseLock()` / `setEnabled(false)`.
 * - Keys and mouse buttons only count while locked, and every key is released the moment the
 *   lock, the focus or the tab visibility is lost: a keyup that the page never sees (Alt+Tab,
 *   a system dialog) cannot leave a key stuck.
 * - Auto-repeat keydowns are ignored.
 *
 * BROWSER SHORTCUTS. While locked, `preventDefault` is called for BOUND keys only (and for the
 * mouse buttons and the context menu), which stops: Space/arrow scrolling, Tab focus moves,
 * Ctrl+R reload, Ctrl+F find, Ctrl+S save, Ctrl+D bookmark, Ctrl+E/Q address-bar jumps, the
 * mouse back/forward buttons. A page CANNOT prevent: Ctrl+W / Ctrl+F4 (close tab), Ctrl+T,
 * Ctrl+N, Ctrl+Shift+T/N/W, Ctrl+Tab and Ctrl+PageUp/Down (switch tab), Alt+F4, Alt+Tab,
 * Cmd+Q/W on macOS, F11, and Esc leaving pointer lock. Ctrl is the default dive key, so
 * Ctrl+W (dive while pitching) is the dangerous one. Two mitigations: `KeyC` is a second
 * default dive key, and while locked a `beforeunload` guard makes the browser ask before the
 * tab closes (`guardUnload`). Fullscreen + the Keyboard Lock API could capture those keys in
 * Chromium; that is left for the Settings task.
 *
 * GAMEPAD. A pad has no events worth having (only "connected" and "disconnected"), so it is
 * polled: `sample()` does it before every tick's frame, and the game layer may also call
 * `poll()` once per rendered frame (the pause button must work while nothing is sampled).
 * - A pad needs no pointer lock. It counts while the controller is enabled and the page is
 *   focused and visible; `gamepadFlying` says that a pad is what the player flies with, and
 *   `flying` (`locked || gamepadFlying`) is what "the player has control" means for the game.
 * - Keys and mouse still need the lock, and both devices can be used at once: actions are
 *   OR-ed and the reticle belongs to whichever steered last (./input-state.ts).
 * - Blur, a hidden tab, `setEnabled`, `releaseLock()` and unplugging the pad release everything
 *   it held, the way keys are released: a button still down counts again only after it was let
 *   go. While the page is not focused or not visible the pad is not read at all.
 *
 * ALLOCATION: the object registers itself as the listener (`handleEvent`), so no closure is
 * created per event, and the handlers only call the allocation-free `InputState` functions.
 * The promise handlers used by `requestLock` are created once in the constructor.
 */
import type { InputFrame } from '../shared';
import { inputActionBit, mouseButtonCode } from './bindings';
import type { InputAction, InputBindings, InputCode } from './bindings';
import { gamepadButtonCode } from './gamepad-bindings';
import {
  createGamepadSource,
  gamepadSourceSupported,
  pollGamepadSource,
  rumbleGamepad,
} from './gamepad-source';
import type { GamepadProvider, GamepadSource } from './gamepad-source';
import {
  consumeGamepadPause,
  consumeGamepadPress,
  disconnectGamepad,
  releaseGamepad,
  setGamepadBindings,
} from './gamepad-state';
import type { GamepadOptions, GamepadState } from './gamepad-state';
import {
  createInputState,
  clearInputAim,
  inputCodeDown,
  inputCodeUp,
  inputMouseMove,
  isCodeBound,
  releaseAllInput,
  sampleInput,
  setInputAim,
  setInputBindings,
} from './input-state';
import type { InputDevice, InputOptions, InputState } from './input-state';

export interface InputControllerOptions {
  bindings?: InputBindings;
  input?: Partial<InputOptions>;
  /** The gamepad's rebind table. Default DEFAULT_GAMEPAD_BINDINGS. */
  gamepadBindings?: InputBindings;
  gamepad?: Partial<GamepadOptions>;
  /** Where to ask for gamepads. Default: the real `navigator`; null = no gamepad support. */
  navigator?: GamepadProvider | null;
  /** Ask for raw (unaccelerated) mouse movement. Default true. */
  rawMouse?: boolean;
  /** Ask the browser to confirm closing the tab while flying (Ctrl+W protection). Default true. */
  guardUnload?: boolean;
  /** Centre the reticle whenever the lock is gained or lost. Default true. */
  centerOnLockChange?: boolean;
  /** Called after the lock is gained or lost (show or hide the "click to fly" prompt). */
  onLockChange?: (locked: boolean) => void;
  /** Called when the browser refuses the lock (e.g. requested too soon after Esc). */
  onLockError?: (error: unknown) => void;
  /** For tests: the globals to listen on. Default: the real `document` and `window`. */
  document?: Document;
  window?: Window;
}

const RAW_LOCK_OPTIONS: PointerLockOptions = { unadjustedMovement: true };

const DOCUMENT_EVENTS = [
  'pointerlockchange',
  'pointerlockerror',
  'mousemove',
  'mousedown',
  'mouseup',
  'keydown',
  'keyup',
  'contextmenu',
  'visibilitychange',
] as const;
const WINDOW_EVENTS = [
  'blur',
  'focus',
  'beforeunload',
  'gamepadconnected',
  'gamepaddisconnected',
] as const;
/** preventDefault is needed, so these listeners cannot be passive. */
const LISTENER_OPTIONS: AddEventListenerOptions = { passive: false };

function isThenable(value: unknown): value is Promise<void> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return '';
  return typeof error.name === 'string' ? error.name : '';
}

export class InputController implements EventListenerObject {
  /** The pure state: read `state.reticleX/Y` for the HUD, edit `state.options` for settings. */
  readonly state: InputState;
  /**
   * The gamepad: `gamepad.connected` and `gamepad.id` for the settings page, `gamepad.standard`
   * to warn about an unknown layout, and `gamepad.options` to edit for settings.
   */
  readonly gamepad: GamepadState;

  private readonly pads: GamepadSource;
  private readonly canvas: HTMLElement;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly guardUnload: boolean;
  private readonly centerOnLockChange: boolean;
  private readonly onLockChange: ((locked: boolean) => void) | undefined;
  private readonly onLockError: ((error: unknown) => void) | undefined;
  private readonly onRawRejected: (error: unknown) => void;
  private readonly onPlainRejected: (error: unknown) => void;

  private lockedNow = false;
  private enabledNow = true;
  private focusedNow: boolean;
  private rawWanted: boolean;
  private rawActive = false;
  private disposed = false;

  constructor(canvas: HTMLElement, options: InputControllerOptions = {}) {
    this.canvas = canvas;
    this.doc = options.document ?? document;
    this.win = options.window ?? window;
    this.state = createInputState(options.bindings, options.input);
    this.pads = createGamepadSource(options.navigator, options.gamepadBindings, options.gamepad);
    this.gamepad = this.pads.state;
    // A page opened in the background has no focus yet; its `focus` event follows a click.
    this.focusedNow = typeof this.doc.hasFocus === 'function' ? this.doc.hasFocus() : true;
    this.rawWanted = options.rawMouse ?? true;
    this.guardUnload = options.guardUnload ?? true;
    this.centerOnLockChange = options.centerOnLockChange ?? true;
    this.onLockChange = options.onLockChange;
    this.onLockError = options.onLockError;

    this.onPlainRejected = (error) => {
      this.onLockError?.(error);
    };
    this.onRawRejected = (error) => {
      if (errorName(error) !== 'NotSupportedError') {
        this.onLockError?.(error);
        return;
      }
      // No raw input on this browser/OS: remember that and lock with normal mouse movement.
      this.rawWanted = false;
      this.rawActive = false;
      if (!this.disposed && this.enabledNow && !this.lockedNow) this.requestPlainLock();
    };

    canvas.addEventListener('click', this);
    for (const type of DOCUMENT_EVENTS) this.doc.addEventListener(type, this, LISTENER_OPTIONS);
    for (const type of WINDOW_EVENTS) this.win.addEventListener(type, this);
  }

  /** True while the pointer is locked to the canvas: the only time keys and mouse are read. */
  get locked(): boolean {
    return this.lockedNow;
  }

  get enabled(): boolean {
    return this.enabledNow;
  }

  /** True when the current lock delivers raw (unaccelerated) mouse movement. */
  get rawMouse(): boolean {
    return this.lockedNow && this.rawActive;
  }

  /** The device that gave input last, for the HUD's button glyphs. */
  get activeDevice(): InputDevice {
    return this.state.activeDevice;
  }

  /**
   * False where the browser gives this page no gamepads at all (no Gamepad API, or it refused):
   * the settings page then says so instead of "press a button".
   */
  get gamepadSupported(): boolean {
    return gamepadSourceSupported(this.pads);
  }

  /**
   * True while the player flies with a gamepad: one is connected, it gave the last input, and
   * it is being read (the controller is enabled, the page focused and visible). The pad's
   * counterpart of `locked`; it turns true on the first button press or stick push.
   */
  get gamepadFlying(): boolean {
    return (
      this.enabledNow &&
      this.gamepad.connected &&
      this.state.activeDevice === 'gamepad' &&
      this.padReadable()
    );
  }

  /**
   * True while the player has control of the dragon, by pointer lock or by gamepad. What the
   * game should ask instead of `locked` to hide "click to fly", aim abilities and read actions.
   */
  get flying(): boolean {
    return this.lockedNow || this.gamepadFlying;
  }

  /**
   * Reads the gamepad. `sample()` calls it, so flight needs nothing more; the game layer should
   * also call it once per rendered frame so the pause and scoreboard buttons work while nothing
   * is sampled (a menu is open, the player is a spectator). Extra calls are harmless.
   * Allocation-free. `nowMs`: for tests; the default is `performance.now()`.
   */
  poll(nowMs: number = performance.now()): void {
    if (this.disposed || !this.padReadable()) return;
    pollGamepadSource(this.pads, this.state, nowMs, this.enabledNow);
  }

  /**
   * Writes this tick's input into `out` (reused, no allocation). Call once per sim tick. While
   * neither locked nor flying by gamepad the frame is neutral: no buttons, and the reticle
   * keeps easing to the centre.
   */
  sample(tick: number, out: InputFrame, dtS?: number): InputFrame {
    this.poll();
    return dtS === undefined
      ? sampleInput(this.state, tick, out)
      : sampleInput(this.state, tick, out, dtS);
  }

  /**
   * True once per press of the pad's Menu (Start) button: open or close the pause menu. Ask on
   * every rendered frame, after `poll()`; it works while the controller is disabled. A press
   * that nobody asked about within half a second is dropped.
   */
  consumePausePress(nowMs: number = performance.now()): boolean {
    return consumeGamepadPause(this.gamepad, nowMs);
  }

  /**
   * The code (`Pad0`..`Pad16`) of a pad button pressed since the last call, or undefined. For
   * the Controls tab while it listens for a new binding; works while disabled. Call it once
   * when listening starts, to drop a press from before.
   */
  consumeGamepadPress(nowMs: number = performance.now()): InputCode | undefined {
    return gamepadButtonCode(consumeGamepadPress(this.gamepad, nowMs));
  }

  /**
   * Whether a pad button bound to `action` is down right now, also while the controller is
   * disabled: the scoreboard button of a spectator or of a rider who is down.
   */
  isGamepadActionHeld(action: InputAction): boolean {
    return (this.gamepad.actions & inputActionBit(action)) !== 0;
  }

  /**
   * Shakes the pad (`strength` 0..1, `ms` milliseconds), e.g. on damage taken. A no-op unless
   * `gamepad.options.rumble` is on, the player is flying by gamepad, and browser and pad can.
   */
  rumble(strength: number, ms: number): void {
    if (this.gamepadFlying) rumbleGamepad(this.pads, strength, ms);
  }

  /**
   * Where abilities are aimed, as a world-space direction (`InputFrame.aimYaw/aimPitch`). The
   * game layer calls it once per rendered frame from the camera's reticle ray; `clearAim`
   * while there is nothing to aim with. Allocation-free.
   */
  setAim(yaw: number, pitch: number): void {
    setInputAim(this.state, yaw, pitch);
  }

  clearAim(): void {
    clearInputAim(this.state);
  }

  /** Installs a rebind table (releases all keys). */
  setBindings(bindings: InputBindings): void {
    setInputBindings(this.state, bindings);
  }

  /** Installs the gamepad's rebind table (releases everything the pad holds). */
  setGamepadBindings(bindings: InputBindings): void {
    setGamepadBindings(this.gamepad, this.state, bindings);
  }

  /**
   * false while a menu owns the mouse: the lock is released and canvas clicks no longer request
   * it. true hands the canvas back to the game (the next click locks again).
   */
  setEnabled(enabled: boolean): void {
    if (this.enabledNow === enabled) return;
    this.enabledNow = enabled;
    if (!enabled) this.releaseLock();
    // A pad button held while the menu closes (the one that closed it) is not a flight press.
    else releaseGamepad(this.gamepad, this.state);
  }

  /** Must run inside a user gesture (click, key press); the canvas click handler calls it. */
  requestLock(): void {
    if (this.disposed || !this.enabledNow || this.lockedNow) return;
    if (!this.rawWanted) {
      this.requestPlainLock();
      return;
    }
    this.rawActive = true;
    try {
      // Typed as a promise, but older browsers return undefined and ignore the options.
      const result: unknown = this.canvas.requestPointerLock(RAW_LOCK_OPTIONS);
      if (isThenable(result)) result.catch(this.onRawRejected);
    } catch (error) {
      this.onRawRejected(error);
    }
  }

  /** Lets go of everything: keys, mouse buttons, what the gamepad holds, and the pointer lock. */
  releaseLock(): void {
    releaseAllInput(this.state);
    releaseGamepad(this.gamepad, this.state);
    if (this.doc.pointerLockElement === this.canvas) this.doc.exitPointerLock();
  }

  handleEvent(event: Event): void {
    switch (event.type) {
      case 'mousemove':
        if (this.lockedNow) {
          const move = event as MouseEvent;
          inputMouseMove(this.state, move.movementX, move.movementY);
        }
        break;
      case 'keydown':
        this.onKey(event as KeyboardEvent, true);
        break;
      case 'keyup':
        this.onKey(event as KeyboardEvent, false);
        break;
      case 'mousedown':
        this.onMouseButton(event as MouseEvent, true);
        break;
      case 'mouseup':
        this.onMouseButton(event as MouseEvent, false);
        break;
      case 'contextmenu':
        if (this.lockedNow) event.preventDefault();
        break;
      case 'click':
        this.requestLock();
        break;
      case 'pointerlockchange':
        this.syncLock();
        break;
      case 'pointerlockerror':
        releaseAllInput(this.state);
        break;
      case 'visibilitychange':
        if (this.doc.visibilityState !== 'visible') this.releaseLock();
        break;
      case 'blur':
        this.focusedNow = false;
        this.releaseLock();
        break;
      case 'focus':
        this.focusedNow = true;
        break;
      case 'gamepadconnected':
        this.pads.watching = true;
        break;
      case 'gamepaddisconnected':
        // Look again on the next poll (another pad may remain); if it was the pad in use, let
        // go of what it held now, not at a poll that may be a while away.
        this.pads.watching = true;
        if ((event as GamepadEvent).gamepad?.index === this.gamepad.index) {
          disconnectGamepad(this.gamepad, this.state);
        }
        break;
      case 'beforeunload':
        if (this.lockedNow && this.guardUnload) {
          event.preventDefault();
          // Older Chromium and Safari only show the prompt when returnValue is set.
          (event as BeforeUnloadEvent).returnValue = true;
        }
        break;
      default:
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('click', this);
    for (const type of DOCUMENT_EVENTS) this.doc.removeEventListener(type, this, LISTENER_OPTIONS);
    for (const type of WINDOW_EVENTS) this.win.removeEventListener(type, this);
    this.releaseLock();
    this.lockedNow = false;
    // Nothing polls any more: do not go on reporting a pad that is no longer read.
    disconnectGamepad(this.gamepad, this.state);
  }

  /** The pad counts only on the page the player is at, as keys do: focused and visible. */
  private padReadable(): boolean {
    return this.focusedNow && this.doc.visibilityState === 'visible';
  }

  private requestPlainLock(): void {
    this.rawActive = false;
    try {
      const result: unknown = this.canvas.requestPointerLock();
      if (isThenable(result)) result.catch(this.onPlainRejected);
    } catch (error) {
      this.onPlainRejected(error);
    }
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (!this.lockedNow) return;
    const code = event.code;
    if (!isCodeBound(this.state, code)) return;
    // Game keys never reach the browser while flying (scrolling, focus moves, Ctrl+R, ...).
    event.preventDefault();
    if (down) {
      if (!event.repeat) inputCodeDown(this.state, code);
    } else {
      inputCodeUp(this.state, code);
    }
  }

  private onMouseButton(event: MouseEvent, down: boolean): void {
    if (!this.lockedNow) return;
    // Also for unbound buttons: stops middle-click autoscroll and back/forward navigation.
    event.preventDefault();
    const code = mouseButtonCode(event.button);
    if (code === undefined) return;
    if (down) inputCodeDown(this.state, code);
    else inputCodeUp(this.state, code);
  }

  private syncLock(): void {
    const locked = this.doc.pointerLockElement === this.canvas;
    if (locked === this.lockedNow) return;
    this.lockedNow = locked;
    // Keys held across the change are unknown either way: start clean.
    releaseAllInput(this.state);
    if (this.centerOnLockChange) {
      this.state.reticleX = 0;
      this.state.reticleY = 0;
    }
    this.onLockChange?.(locked);
  }
}

export function createInputController(
  canvas: HTMLElement,
  options?: InputControllerOptions,
): InputController {
  return new InputController(canvas, options);
}
