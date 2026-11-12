/** Barrel for the settings panel (T-3.9). */

export { createSettingsPanel } from './create-settings-panel';
export type { SettingsPanel } from './create-settings-panel';
export { UI_SCALE_PROPERTY, applyPageSettings } from './page-settings';
export { GAMEPAD_LIST_WORDS, KEYBOARD_LIST_WORDS, createBindingList } from './binding-list';
export type { BindingList, BindingListWords } from './binding-list';
export {
  GAMEPAD_CANCEL_CODE,
  actionLabel,
  beginCapture,
  canSwap,
  cancelCapture,
  captureCode,
  captureGamepadCode,
  codeLabel,
  codeShortLabel,
  createRebindModel,
  findHolder,
  mouseCode,
  rebindPrompt,
  reconcileRebind,
  resetBindingsIntent,
  resolveConflict,
} from './rebind-model';
export type { RebindModel, RebindNote, RebindPhase } from './rebind-model';
export {
  RANGE_FIELDS,
  SELECT_OPTIONS,
  SETTINGS_TAB_LABELS,
  TOGGLE_FIELDS,
  createRangeView,
  gamepadDisplayName,
  gamepadStatus,
  isSettingsTab,
  neighbourTab,
  qualityHint,
  rangeIntent,
  rangeSetting,
  rangeText,
  rangeView,
  selectIntent,
  selectValue,
  textIntent,
  toggleIntent,
  turnIntent,
} from './settings-model';
export type {
  GamepadStatus,
  RangeField,
  RangeView,
  SelectField,
  SelectOption,
  TextField,
  ToggleField,
  TurnFormResult,
  TurnProblem,
} from './settings-model';
