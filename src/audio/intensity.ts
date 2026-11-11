/**
 * How heated the match is, 0..1, for cross-fading the music's calm and battle layers (T-4.8).
 * Pure arithmetic on a few numbers the engine already has, so it is testable without WebAudio
 * and allocates nothing.
 *
 * What raises it:
 * - takedowns: each adds heat that cools off over a few seconds (more when the local rider was
 *   the killer or the victim),
 * - the local rider being low on health,
 * - the last seconds of a timed round or match.
 * Outside the `playing` phase it falls to zero.
 */

import type { MatchPhase } from '../shared';

export interface IntensityTuning {
  /** Level of a quiet moment in a live round. */
  base: number;
  /** Heat added by a takedown, and by one the local rider was part of. */
  takedownHeat: number;
  localTakedownHeat: number;
  /** Seconds for takedown heat to halve. */
  heatHalfLifeS: number;
  /** Below this health fraction the rider's danger adds up to `lowHealthBoost`. */
  lowHealth: number;
  lowHealthBoost: number;
  /** The closing stretch: from this many seconds left, up to `finaleBoost` at zero. */
  finaleS: number;
  finaleBoost: number;
  /** Time constants of the output following its target (rising is quicker than falling). */
  riseS: number;
  fallS: number;
}

export const INTENSITY_TUNING: IntensityTuning = {
  base: 0.12,
  takedownHeat: 0.16,
  localTakedownHeat: 0.5,
  heatHalfLifeS: 7,
  lowHealth: 0.35,
  lowHealthBoost: 0.35,
  finaleS: 30,
  finaleBoost: 0.6,
  riseS: 1.2,
  fallS: 5,
};

export class MusicIntensity {
  /** The smoothed output, 0..1. */
  value = 0;
  private heat = 0;

  takedown(localInvolved: boolean): void {
    const tuning = INTENSITY_TUNING;
    const next = this.heat + (localInvolved ? tuning.localTakedownHeat : tuning.takedownHeat);
    this.heat = next < 1 ? next : 1;
  }

  reset(): void {
    this.value = 0;
    this.heat = 0;
  }

  /**
   * Advances by `dtS` and returns the new value. `health` is the local rider's 0..1 (pass 1 for
   * spectators and the dead); `timeRemainingS` may be Infinity.
   */
  update(dtS: number, phase: MatchPhase, health: number, timeRemainingS: number): number {
    const tuning = INTENSITY_TUNING;
    const dt = dtS > 0 ? (dtS < 1 ? dtS : 1) : 0;
    this.heat *= Math.pow(0.5, dt / tuning.heatHalfLifeS);
    let target = 0;
    if (phase === 'playing') {
      target = tuning.base + this.heat;
      if (health > 0 && health < tuning.lowHealth) {
        target += tuning.lowHealthBoost * (1 - health / tuning.lowHealth);
      }
      if (timeRemainingS >= 0 && timeRemainingS < tuning.finaleS) {
        target += tuning.finaleBoost * (1 - timeRemainingS / tuning.finaleS);
      }
      if (!(target < 1)) target = 1;
      if (!(target > 0)) target = 0;
    }
    const tau = target > this.value ? tuning.riseS : tuning.fallS;
    this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }
}

/** Equal-power gains of the two layers at an intensity: [calm, battle] written to `out`. */
export function layerGains(intensity: number, out: Float32Array): void {
  const t = intensity > 0 ? (intensity < 1 ? intensity : 1) : 0;
  out[0] = Math.cos(t * Math.PI * 0.5);
  out[1] = Math.sin(t * Math.PI * 0.5);
}
