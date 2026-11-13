/**
 * The hit flash of a skinned dragon: how strong it is, frame by frame.
 *
 * It has to read as an IMPACT (docs/ART_DIRECTION.md: the dragon keeps its form and paint), so
 * it is short, front-loaded and never held:
 *
 * - One hit is a pop that is gone in `durationS`; the strength is the square of a linear ramp,
 *   so most of it is spent in the first few frames.
 * - Fire breath takes health on every sim tick. Popping on each tick would hold the dragon lit
 *   for as long as the breath lasts, and at tick rate that is also a strobe. A full pop
 *   therefore re-arms only after `rearmS` (under three a second, the photosensitivity ceiling);
 *   hits in between keep a low shimmer (`sustain`) alive instead.
 * - Reduce motion scales the whole thing down (`reducedScale`).
 *
 * The shader (dragon-material.ts) turns the strength into a warm lift plus a hot rim; this
 * module is only the timing, so it is testable without a GPU. Nothing here allocates.
 */

export interface HitFlashTuning {
  /** Seconds from a full pop to nothing. */
  durationS: number;
  /** A hit sooner than this after a full pop cannot pop again, seconds. */
  rearmS: number;
  /** Level (0..1, before squaring) that hits inside the re-arm time hold the flash at. */
  sustain: number;
  /** Strength multiplier with reduce motion on. */
  reducedScale: number;
}

export const HIT_FLASH_TUNING: HitFlashTuning = {
  durationS: 0.11,
  rearmS: 0.34,
  sustain: 0.45,
  reducedScale: 0.5,
};

/** Per dragon. Plain numbers: keep it inside the actor and reuse it. */
export interface HitFlashState {
  /** The linear ramp, 1 at a pop .. 0. */
  level: number;
  /** Seconds since the last full pop. */
  sincePopS: number;
}

export function createHitFlashState(): HitFlashState {
  return { level: 0, sincePopS: Number.POSITIVE_INFINITY };
}

/** Nothing showing and the next hit pops in full (a dragon that was not drawn for a while). */
export function resetHitFlash(state: HitFlashState): void {
  state.level = 0;
  state.sincePopS = Number.POSITIVE_INFINITY;
}

/** Once per drawn frame. `hit`: this dragon lost health since the last frame. */
export function advanceHitFlash(
  state: HitFlashState,
  hit: boolean,
  dtS: number,
  tuning: HitFlashTuning = HIT_FLASH_TUNING,
): void {
  state.sincePopS += dtS;
  // The ramp always runs down, hit or not: a hit on every frame must not hold a pop up.
  state.level = tuning.durationS > 0 ? Math.max(0, state.level - dtS / tuning.durationS) : 0;
  if (!hit) return;
  if (state.sincePopS >= tuning.rearmS) {
    state.level = 1;
    state.sincePopS = 0;
  } else if (state.level < tuning.sustain) {
    state.level = tuning.sustain;
  }
}

/** The shader's `uFx.z`, 0..1: front-loaded, and gentler with reduce motion on. */
export function hitFlashStrength(
  state: HitFlashState,
  reduceMotion: boolean,
  tuning: HitFlashTuning = HIT_FLASH_TUNING,
): number {
  const strength = state.level * state.level;
  return reduceMotion ? strength * tuning.reducedScale : strength;
}
