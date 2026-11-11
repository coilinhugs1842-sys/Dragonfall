/** Barrel for input timing and prediction: the host's input rule and the client's predictor. */

export {
  HOST_INPUT_WINDOW_TICKS,
  HostInputBuffer,
  INPUT_REPEAT_MAX_TICKS,
  INPUT_REWIND_TICKS,
} from './host-input-buffer';
export {
  INPUT_DILATION_PER_TICK,
  INPUT_MARGIN_DEADBAND_TICKS,
  INPUT_MARGIN_TARGET_TICKS,
  INPUT_MAX_DILATION,
  INPUT_RESYNC_CONFIRM,
  INPUT_RESYNC_TICKS,
  INPUT_TIMING_WINDOW,
  InputTiming,
  initialInputLeadTicks,
} from './input-timing';
export {
  ClientPredictor,
  PREDICTION_HISTORY_TICKS,
  PREDICTION_MAX_REPLAY_TICKS,
  RECONCILE_ANGLE_EPSILON_RAD,
  RECONCILE_CORRECTED,
  RECONCILE_IGNORED,
  RECONCILE_MATCHED,
  RECONCILE_NO_OWNER,
  RECONCILE_POSITION_EPSILON_M,
  RECONCILE_SNAPPED,
  RECONCILE_SNAP_DISTANCE_M,
  RECONCILE_VALUE_EPSILON,
} from './predictor';
export type { ClientPredictorOptions, ReconcileResult } from './predictor';
