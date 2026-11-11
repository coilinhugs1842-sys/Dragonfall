/** Seconds -> whole sim ticks. Its own file so flight and abilities can both use it. */

import { TICK_HZ } from '../shared';

const EPSILON = 1e-6;
/** Cap for a duration from a broken tuning value (Infinity): about 9 hours of ticks. */
const MAX_TIMER_TICKS = 1_000_000;

/**
 * Whole ticks covering at least `seconds` (0.25 s at 30 Hz = 8 ticks). Zero, negative and NaN
 * give 0.
 */
export function secondsToTicks(seconds: number): number {
  if (!(seconds > 0)) return 0;
  const ticks = Math.ceil(seconds * TICK_HZ - EPSILON);
  return ticks < MAX_TIMER_TICKS ? ticks : MAX_TIMER_TICKS;
}

// The same, reading the seconds from a field. For callers in the tick: a float passed to a call
// the JIT did not inline is boxed on the heap, a field read is not (and these return integers).

export function cooldownTicksOf(def: { readonly cooldownS: number }): number {
  return secondsToTicks(def.cooldownS);
}

export function windupTicksOf(def: { readonly windupS: number }): number {
  return secondsToTicks(def.windupS);
}

export function durationTicksOf(def: { readonly durationS: number }): number {
  return secondsToTicks(def.durationS);
}

export function pulseTicksOf(def: { readonly pulseIntervalS: number }): number {
  return secondsToTicks(def.pulseIntervalS);
}

export function lifeTicksOf(def: { readonly lifeS: number }): number {
  return secondsToTicks(def.lifeS);
}
