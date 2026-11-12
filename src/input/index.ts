/** Barrel for input: devices -> the shared InputFrame, the rebind table and the flight overlay. */

export {
  BINDINGS_FORMAT_VERSION,
  DEFAULT_BINDINGS,
  INPUT_ACTIONS,
  MAX_CODES_PER_ACTION,
  MOUSE_BUTTON_CODES,
  RESERVED_CODES,
  bindingsEqual,
  cloneBindings,
  findBindingConflicts,
  findUnboundActions,
  inputActionBit,
  inputActionIndex,
  isBindableCode,
  isMouseCode,
  mouseButtonCode,
  parseBindings,
  rebindAction,
  resetActionBinding,
  resetBindings,
  serializeBindings,
  unbindAction,
} from './bindings';
export type {
  BindingConflict,
  InputAction,
  InputBindings,
  InputCode,
  RebindOptions,
} from './bindings';
export { createFlightOverlay } from './flight-overlay';
export type { FlightOverlay, FlightOverlayOptions } from './flight-overlay';
export {
  DEFAULT_GAMEPAD_BINDINGS,
  GAMEPAD_BUTTON_CODES,
  GAMEPAD_BUTTON_COUNT,
  GAMEPAD_FLICK_LEFT,
  GAMEPAD_FLICK_RIGHT,
  GAMEPAD_MENU_BUTTON,
  gamepadButtonCode,
  gamepadButtonIndex,
  gamepadCodeLabel,
  gamepadCodeShortLabel,
  isGamepadCode,
  parseGamepadBindings,
  resetGamepadBindings,
} from './gamepad-bindings';
export { createGamepadMenuState, pollGamepadMenu } from './gamepad-menu';
export type { GamepadMenuCommand, GamepadMenuState } from './gamepad-menu';
export {
  createGamepadSource,
  gamepadSourceSupported,
  pollGamepadSource,
  rumbleGamepad,
} from './gamepad-source';
export type { GamepadProvider, GamepadSource } from './gamepad-source';
export {
  DEFAULT_GAMEPAD_OPTIONS,
  buttonIsDown,
  consumeGamepadPause,
  consumeGamepadPress,
  createGamepadState,
  disconnectGamepad,
  pollGamepad,
  releaseGamepad,
  setGamepadBindings,
  stickReticleGain,
  stickSteerGain,
} from './gamepad-state';
export type { GamepadButtonLike, GamepadLike, GamepadOptions, GamepadState } from './gamepad-state';
export { InputController, createInputController } from './input-controller';
export type { InputControllerOptions } from './input-controller';
export {
  DEFAULT_INPUT_OPTIONS,
  MAX_SENSITIVITY,
  MIN_SENSITIVITY,
  centerReticle,
  clearInputAim,
  clearInputState,
  createInputState,
  inputCodeDown,
  inputCodeUp,
  inputMouseMove,
  inputPadActions,
  inputPadPulse,
  isActionActive,
  isCodeBound,
  releaseAllInput,
  releasePadInput,
  sampleInput,
  setInputAim,
  setInputBindings,
} from './input-state';
export type { InputDevice, InputOptions, InputState } from './input-state';
export { reticleDecay, reticleSteerGain, reticleUnitsPerCount, unitCircleScale } from './reticle';
