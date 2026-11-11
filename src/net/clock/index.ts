/** Barrel for clock sync (PING/PONG -> RTT and host time). Pure, no transport. */

export {
  CLOCK_SYNC_MAX_RTT_MS,
  CLOCK_SYNC_MIN_SAMPLES,
  CLOCK_SYNC_SLEW_MS,
  CLOCK_SYNC_SNAP_MS,
  CLOCK_SYNC_WINDOW,
  ClockSync,
} from './clock-sync';
