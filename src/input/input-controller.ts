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
 * ALLOCATION: the object registers itself as the listener (`handleEvent`), so no closure is
 * created per event, and the handlers only call the allocation-free `InputState` functions.
 * The promise handlers used by `requestLock` are created once in the constructor.
 */
import type { InputFrame } from '../shared';
import { mouseButtonCode } from './bindings';
import type { InputBindings } from './bindings';
import {
  createInputState,
  inputCodeDown,
  inputCodeUp,
  inputMouseMove,
  isCodeBound,
  releaseAllInput,
  sampleInput,
  setInputBindings,
} from './input-state';
import type { InputOptions, InputState } from './input-state';

export interface InputControllerOptions {
  bindings?: InputBindings;
  input?: Partial<InputOptions>;
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
const WINDOW_EVENTS = ['blur', 'beforeunload'] as const;
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
  private rawWanted: boolean;
  private rawActive = false;
  private disposed = false;

  constructor(canvas: HTMLElement, options: InputControllerOptions = {}) {
    this.canvas = canvas;
    this.doc = options.document ?? document;
    this.win = options.window ?? window;
    this.state = createInputState(options.bindings, options.input);
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

  /** True while the pointer is locked to the canvas: the only time input is read. */
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

  /**
   * Writes this tick's input into `out` (reused, no allocation). Call once per sim tick. While
   * unlocked the frame is neutral: no buttons, and the reticle keeps easing to the centre.
   */
  sample(tick: number, out: InputFrame, dtS?: number): InputFrame {
    return dtS === undefined
      ? sampleInput(this.state, tick, out)
      : sampleInput(this.state, tick, out, dtS);
  }

  /** Installs a rebind table (releases all keys). */
  setBindings(bindings: InputBindings): void {
    setInputBindings(this.state, bindings);
  }

  /**
   * false while a menu owns the mouse: the lock is released and canvas clicks no longer request
   * it. true hands the canvas back to the game (the next click locks again).
   */
  setEnabled(enabled: boolean): void {
    if (this.enabledNow === enabled) return;
    this.enabledNow = enabled;
    if (!enabled) this.releaseLock();
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

  releaseLock(): void {
    releaseAllInput(this.state);
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
        this.releaseLock();
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
