/**
 * Fixed-timestep accumulator. The sim must advance in identical steps on the host and on every
 * predicting client or they diverge, so frame time is banked here and paid out in whole steps;
 * the leftover fraction becomes the render interpolation alpha.
 *
 * Pure on purpose: the caller owns the clock and passes elapsed time in, which keeps this
 * testable in node and usable from a Web Worker.
 */

/** Called once per fixed step with the index of the tick being simulated (0, 1, 2, ...). */
export type FixedStepFn = (tick: number) => void;

export const DEFAULT_MAX_STEPS_PER_ADVANCE = 5;

export class FixedStepLoop {
  private readonly stepMs: number;
  private readonly step: FixedStepFn;
  private readonly maxSteps: number;
  private accumulatorMs = 0;
  private nextTick = 0;
  private dropped = 0;

  constructor(
    stepMs: number,
    step: FixedStepFn,
    maxStepsPerAdvance: number = DEFAULT_MAX_STEPS_PER_ADVANCE,
  ) {
    if (!(stepMs > 0) || !Number.isFinite(stepMs)) {
      throw new RangeError(`FixedStepLoop: stepMs must be a positive finite number, got ${stepMs}`);
    }
    if (!(maxStepsPerAdvance >= 1)) {
      throw new RangeError(
        `FixedStepLoop: maxStepsPerAdvance must be >= 1, got ${maxStepsPerAdvance}`,
      );
    }
    this.stepMs = stepMs;
    this.step = step;
    this.maxSteps = Math.floor(maxStepsPerAdvance);
  }

  /**
   * Banks `elapsedMs` and runs as many whole steps as it covers, up to the per-call cap.
   * Returns the number of steps run.
   *
   * Time beyond the cap is DROPPED (the sim falls behind wall time) instead of being carried:
   * carrying it means a slow frame demands more steps next frame, which makes that frame slower
   * still (the spiral of death). NaN, negative and infinite elapsed values are ignored.
   */
  advance(elapsedMs: number): number {
    // `!(x > 0)` also rejects NaN, which every comparison fails.
    if (!(elapsedMs > 0) || elapsedMs === Infinity) return 0;

    const stepMs = this.stepMs;
    let acc = this.accumulatorMs + elapsedMs;
    let steps = 0;
    while (acc >= stepMs && steps < this.maxSteps) {
      acc -= stepMs;
      steps++;
      // Stored before the callback so a throwing step cannot replay the same time next frame.
      this.accumulatorMs = acc;
      const tick = this.nextTick;
      this.nextTick = tick + 1;
      this.step(tick);
    }
    if (acc >= stepMs) {
      // Keep only the sub-step remainder so alpha stays continuous and inside [0, 1).
      const remainder = acc % stepMs;
      this.dropped += acc - remainder;
      acc = remainder;
    }
    this.accumulatorMs = acc;
    return steps;
  }

  /** Fraction of a step banked but not yet simulated, in [0, 1). Render lerps prev→current by it. */
  get alpha(): number {
    return this.accumulatorMs / this.stepMs;
  }

  /** Steps run since construction or `reset()`; also the index the next step will receive. */
  get tick(): number {
    return this.nextTick;
  }

  /** Total time discarded by the per-call cap, so the perf HUD can show that the sim fell behind. */
  get droppedMs(): number {
    return this.dropped;
  }

  /** Back to tick 0 with an empty accumulator (new match). */
  reset(): void {
    this.accumulatorMs = 0;
    this.nextTick = 0;
    this.dropped = 0;
  }

  /**
   * Forgets the banked fraction but keeps the tick count. For resuming after a pause, where the
   * stale fraction belongs to a frame that was never shown.
   */
  clearAccumulator(): void {
    this.accumulatorMs = 0;
  }
}
