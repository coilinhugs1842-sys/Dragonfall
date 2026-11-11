/** Barrel for the settings store (T-3.9): load / validate / save, live apply, the rebind bridge. */

export {
  applySettings,
  bindSettingsTargets,
  createSettingsNameStore,
  handleSettingsIntent,
} from './apply';
export type { SettingsIntentHooks, SettingsTargets } from './apply';
export {
  applyRebind,
  applyResetBindings,
  applyUnbind,
  controlsUiStateFor,
  isInputAction,
} from './bindings-bridge';
export { SYSTEM_TIMERS, createDebounce, debounceDueMs } from './debounce';
export type { Debounce, DebounceOptions, DebounceTimers } from './debounce';
export { FRAME_CAP_SLACK_MS, FrameCap } from './frame-cap';
export {
  MAX_SETTINGS_TEXT_LENGTH,
  SENSITIVE_SETTING_KEYS,
  SETTINGS_VERSION,
  clampSetting,
  isValidTurnUrl,
  parseSettingsData,
  redactSettings,
  sanitizeLanHost,
  sanitizePlayerName,
  sanitizeSettings,
  sanitizeTurn,
  serializeSettingsData,
  settingsEqual,
} from './schema';
export type { SettingsData } from './schema';
export {
  LEGACY_NAME_STORAGE_KEY,
  SETTINGS_SAVE_DELAY_MS,
  SETTINGS_SAVE_MAX_DELAY_MS,
  createSettingsStore,
} from './store';
export type { SettingsListener, SettingsStore, SettingsStoreOptions } from './store';
