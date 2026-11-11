/** Host lag compensation (T-3.3). Pure sim-side code: runs in node tests and the host worker. */

export {
  LAG_COMP_HISTORY_TICKS,
  LAG_COMP_INTERP_DELAY_TICKS,
  LAG_COMP_MAX_REWIND_TICKS,
  LAG_COMP_NOWHERE,
  LAG_COMP_SMOOTHING,
  LAG_COMP_SNAPSHOT_AGE_TICKS,
  LagCompensator,
  createLagCompensator,
} from './lag-compensator';
