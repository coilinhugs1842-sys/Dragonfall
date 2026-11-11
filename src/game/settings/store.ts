/**
 * The settings store: the one owner of the player's settings and key bindings.
 *
 * - Loads once from localStorage (any version, any garbage: see ./schema.ts).
 * - `update(patch)` validates and clamps the patch, notifies subscribers at once (live apply) and
 *   saves a little later (debounced, so dragging a slider is one write, not sixty).
 * - `flush()` saves now; call it on `pagehide` so the last change is not lost.
 *
 * `settings`, `bindings` and `controls` are replaced, never mutated: comparing references is
 * enough to tell that something changed, and `uiState.settings = store.settings` costs nothing
 * per frame.
 */

import { bindingsEqual } from '../../input/bindings';
import type { InputBindings } from '../../input/bindings';
import { DEFAULT_GAME_SETTINGS } from '../../shared';
import type { ControlsUiState, GameSettings } from '../../shared';
import { SETTINGS_STORAGE_KEY } from '../stored-quality';
import {
  applyRebind,
  applyResetBindings,
  applyUnbind,
  controlsUiStateFor,
} from './bindings-bridge';
import { SYSTEM_TIMERS, createDebounce } from './debounce';
import type { Debounce, DebounceTimers } from './debounce';
import {
  SETTINGS_VERSION,
  parseSettingsData,
  sanitizeSettings,
  serializeSettingsData,
  settingsEqual,
} from './schema';
import type { SettingsData } from './schema';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Where the title screen kept the rider name before it became a setting. Read once, never written. */
export const LEGACY_NAME_STORAGE_KEY = 'dragonfall.name';

export const SETTINGS_SAVE_DELAY_MS = 400;
export const SETTINGS_SAVE_MAX_DELAY_MS = 2000;

export type SettingsListener = (next: SettingsData, previous: SettingsData) => void;

export interface SettingsStoreOptions {
  /** `window.localStorage`, or null where there is none. Storage that throws is tolerated. */
  readonly storage: StorageLike | null;
  /** Milliseconds, monotonic. Default `performance.now`. */
  readonly now?: () => number;
  readonly timers?: DebounceTimers;
  readonly saveDelayMs?: number;
  readonly saveMaxDelayMs?: number;
}

export interface SettingsStore {
  readonly settings: GameSettings;
  readonly bindings: InputBindings;
  /** The binding table in the shape `UiState.controls` wants; replaced when bindings change. */
  readonly controls: ControlsUiState;
  /** Both at once, as subscribers get them. */
  readonly data: SettingsData;
  /** A save is waiting for its debounce. */
  readonly dirty: boolean;
  /**
   * Applies a patch from the UI (or anywhere): unknown keys are ignored, wrong types keep the
   * current value, numbers are clamped. Returns true when a setting changed.
   */
  update(patch: unknown): boolean;
  rebind(action: unknown, slot: unknown, code: unknown, swap: boolean): boolean;
  unbind(action: unknown, slot: unknown): boolean;
  /** `null` resets every action. */
  resetBindings(action: unknown): boolean;
  /** Reset all: default settings and default bindings. */
  reset(): boolean;
  /** Called after every change, with the new and the previous data. Returns the unsubscribe. */
  subscribe(listener: SettingsListener): () => void;
  /** Writes now if a save is pending. */
  flush(): void;
  /** Flushes, drops the listeners and stops the timer. */
  dispose(): void;
}

function readText(storage: StorageLike | null, key: string): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** True when `text` is a save this version wrote (so loading it needs no rewrite). */
function isCurrentVersion(text: string | null): boolean {
  return text !== null && text.startsWith(`{"version":${SETTINGS_VERSION},`);
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const storage = options.storage;
  const text = readText(storage, SETTINGS_STORAGE_KEY);
  let data: SettingsData = parseSettingsData(text, readText(storage, LEGACY_NAME_STORAGE_KEY));
  let controls = controlsUiStateFor(data.bindings);
  let listeners: readonly SettingsListener[] = [];
  let disposed = false;

  const save = (): void => {
    if (storage === null) return;
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, serializeSettingsData(data));
    } catch {
      // Blocked or full storage: the settings last for this page only. Deliberately silent
      // (the text holds the TURN credential, and there is nothing the player can do).
    }
  };

  const debounce: Debounce = createDebounce({
    waitMs: options.saveDelayMs ?? SETTINGS_SAVE_DELAY_MS,
    maxWaitMs: options.saveMaxDelayMs ?? SETTINGS_SAVE_MAX_DELAY_MS,
    now: options.now ?? ((): number => performance.now()),
    timers: options.timers ?? SYSTEM_TIMERS,
    run: save,
  });

  // An old or repaired save is rewritten in the current format, but only once something else
  // touches the store or the page closes: loading alone never writes.
  let needsMigrationWrite = text !== null && !isCurrentVersion(text);

  const commit = (next: SettingsData): boolean => {
    if (disposed) return false;
    const previous = data;
    data = next;
    if (next.bindings !== previous.bindings) controls = controlsUiStateFor(next.bindings);
    needsMigrationWrite = false;
    debounce.touch();
    for (const listener of listeners) listener(next, previous);
    return true;
  };

  const commitBindings = (bindings: InputBindings): boolean => {
    if (bindings === data.bindings || bindingsEqual(bindings, data.bindings)) return false;
    return commit({ settings: data.settings, bindings });
  };

  return {
    get settings(): GameSettings {
      return data.settings;
    },
    get bindings(): InputBindings {
      return data.bindings;
    },
    get controls(): ControlsUiState {
      return controls;
    },
    get data(): SettingsData {
      return data;
    },
    get dirty(): boolean {
      return debounce.pending;
    },
    update(patch: unknown): boolean {
      const settings = sanitizeSettings(patch, data.settings);
      if (settingsEqual(settings, data.settings)) return false;
      return commit({ settings, bindings: data.bindings });
    },
    rebind(action: unknown, slot: unknown, code: unknown, swap: boolean): boolean {
      return commitBindings(applyRebind(data.bindings, action, slot, code, swap));
    },
    unbind(action: unknown, slot: unknown): boolean {
      return commitBindings(applyUnbind(data.bindings, action, slot));
    },
    resetBindings(action: unknown): boolean {
      return commitBindings(applyResetBindings(data.bindings, action));
    },
    reset(): boolean {
      const bindings = applyResetBindings(data.bindings, null);
      const sameBindings = bindingsEqual(bindings, data.bindings);
      if (sameBindings && settingsEqual(data.settings, DEFAULT_GAME_SETTINGS)) return false;
      return commit({
        settings: DEFAULT_GAME_SETTINGS,
        bindings: sameBindings ? data.bindings : bindings,
      });
    },
    subscribe(listener: SettingsListener): () => void {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
    flush(): void {
      if (debounce.flush()) return;
      if (needsMigrationWrite) {
        needsMigrationWrite = false;
        save();
      }
    },
    dispose(): void {
      if (disposed) return;
      this.flush();
      disposed = true;
      debounce.cancel();
      listeners = [];
    },
  };
}
