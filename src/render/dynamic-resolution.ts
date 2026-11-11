/**
 * Dynamic resolution scaler: moves the render scale inside the quality preset's bounds to hold
 * 60 fps (docs/PERFORMANCE.md, "Dynamic resolution" and "Thermal headroom").
 *
 * PURE: no three.js and no DOM, so it runs in node unit tests. The renderer feeds it one frame
 * time per rendered frame and resizes the drawing buffer only when `update` returns true.
 *
 * How it decides:
 * - Frame times are smoothed with an EMA so one slow frame does not move the scale. Isolated
 *   frames over 100 ms (tab switch, GC, loading) are ignored; a run of them is the frame rate.
 * - DOWN is fast: the smoothed time must stay over budget for a short run of frames, then the
 *   scale drops one step (two when far over budget).
 * - UP is slow, and it is a PROBE. With vsync a frame never takes less than one display refresh
 *   (16.7 ms at 60 Hz), so frame time cannot show how much headroom the GPU has: "on budget"
 *   looks the same at 30 % and at 99 % GPU load. So after a stable on-budget period the scaler
 *   simply tries one step up. If that step is followed by a step down within the probe window,
 *   the probe failed and the wait before the next probe doubles (up to a cap); a probe that
 *   survives resets the wait. Under a steady load this settles to one brief probe every minute
 *   instead of a constant up/down flicker.
 * - The scale is quantized to steps and every change starts a cooldown, because resizing the
 *   drawing buffer is expensive and visible.
 * - The mean hides judder: a scale that misses 3 % of vsyncs averages only 3 % over budget. So
 *   missed frames are also counted directly, and a window with too many of them steps down (or
 *   fails the probe) whatever the mean says.
 * - The budget is 60 fps unless the DISPLAY is slower (a 48/50 Hz panel mode, a browser
 *   battery-saver cap at 30 fps). Frame time alone cannot tell a slow display from a slow GPU,
 *   so the budget is only relaxed on evidence a slow GPU rarely produces: the scale is at its
 *   minimum, the cadence is steady there, and nothing faster has been seen since this object was
 *   created. Any faster half second seen later tightens the budget again, back to 60 fps at
 *   most. Known gap: a display that slows down AFTER a faster cadence was seen (refresh rate
 *   switched mid-session) still holds the scale at its minimum.
 * - A frame cap the PLAYER chose (Settings: 30 / 45 fps) is not a slow GPU either, and here
 *   nothing has to be inferred: `setFrameCap` makes the cap's interval the budget. Capped
 *   frames come in whole display refreshes (45 fps on a 60 Hz panel alternates 16.7 and 33.3
 *   ms), so while capped a frame only counts as missed when it is most of a refresh late.
 */

/** 60 fps. */
export const DYNRES_TARGET_FRAME_MS = 1000 / 60;
/** Scale moves in these increments so the drawing buffer is not resized by tiny amounts. */
export const DYNRES_SCALE_STEP = 0.05;

/** EMA weight of the newest frame (time constant of about 20 frames). */
const EMA_ALPHA = 0.05;
// The factors below multiply the frame budget (16.7 ms unless the display is slower).
/** Over budget above this (17.5 ms at 60 Hz, clear of vsync timer jitter). */
const OVER_BUDGET_FACTOR = 1.05;
/** Far over budget: drop two steps at once. */
const FAR_OVER_BUDGET_FACTOR = 1.25;
/** On budget at or below this (17.0 ms at 60 Hz); up to OVER_BUDGET_FACTOR nothing is counted. */
const ON_BUDGET_FACTOR = 1.02;
/** A sample counts at most this much, so one missed vsync cannot drag the EMA over budget. */
const SAMPLE_CLAMP_FACTOR = 2;
/** A frame longer than this missed at least one vsync. */
const MISSED_FRAME_FACTOR = 1.5;
/**
 * Under a frame cap a frame is missed when it is this much of a 60 Hz refresh over the budget
 * (the longer of a cap's alternating intervals is at most two thirds of a refresh over it).
 */
const CAPPED_MISSED_REFRESHES = 0.75;

/** Frames longer than this are tab switches, GC pauses or loading hitches, not GPU load... */
const OUTLIER_MS = 100;
/** ...unless this many come in a row: then the renderer really is that slow (software GL). */
const OUTLIER_RUN_FRAMES = 5;
/** Smoothed time must stay over budget for this many consecutive frames before stepping down. */
const OVER_FRAMES_TO_STEP_DOWN = 12;
/** Frames discarded after every change: the resize itself hitches and the load has changed. */
const COOLDOWN_FRAMES = 20;
/** On-budget frames before the first upward probe (about 3 s at 60 fps). */
const STABLE_FRAMES_BASE = 180;
/** Cap of the doubled wait after failed probes (about 60 s at 60 fps). */
const STABLE_FRAMES_MAX = 3600;
/** A step down within this many frames after a probe means the probe failed. */
const PROBE_WINDOW_FRAMES = 120;
/** Missed frames are counted over windows of this length: the same frames a probe is judged on. */
const JUDDER_WINDOW_FRAMES = PROBE_WINDOW_FRAMES;
/** This many missed frames in one window (2.5 %) is judder: step down. One a second is tolerated. */
const JUDDER_MISSED_FRAMES = 3;
/** The frame cadence is averaged over windows of this length (about half a second). */
const CADENCE_WINDOW_FRAMES = 32;
/** Cadence windows in a row that must agree before the display is taken to be slower than 60 Hz. */
const STEADY_WINDOWS_FOR_SLOW_DISPLAY = 4;
/** A cadence window agrees with the fastest one when it is within this factor (timer jitter). */
const STEADY_CADENCE_FACTOR = 1.03;
/** No display or browser frame cap is slower than this (25 Hz); beyond it the GPU is the limit. */
const SLOWEST_DISPLAY_MS = 40;
/**
 * Wait between probes right after a slow display was recognised: the steps down that led there
 * were not the GPU's fault, so the way back up need not take 3 s a step.
 */
const STABLE_FRAMES_RECOVERY = 30;

/** Dividing by an integer gives the nearest double (0.7, not 14 * 0.05 = 0.7000000000000001). */
const STEPS_PER_UNIT = Math.round(1 / DYNRES_SCALE_STEP);

function quantize(scale: number): number {
  return Math.round(scale * STEPS_PER_UNIT) / STEPS_PER_UNIT;
}

export class DynamicResolution {
  /** When false, `update` does nothing and the scale stays where it is. */
  enabled = true;

  private min: number;
  private max: number;
  private current: number;
  /** Frame time to hold: 60 fps, or the display's own interval when that is longer. */
  private budget = DYNRES_TARGET_FRAME_MS;
  private ema = DYNRES_TARGET_FRAME_MS;
  private overFrames = 0;
  private stableFrames = 0;
  /** What `stableFramesNeeded` returns to after a probe that held. */
  private stableFramesBase = STABLE_FRAMES_BASE;
  private stableFramesNeeded = STABLE_FRAMES_BASE;
  private cooldown = 0;
  private probeFrames = 0;
  private outlierRun = 0;
  private judderFrames = 0;
  private missedFrames = 0;
  private cadenceFrames = 0;
  private cadenceSum = 0;
  private steadyWindows = 0;
  /** Fastest cadence-window average ever seen. Outlives `reset`: it describes the display. */
  private fastestCadenceMs = Infinity;
  /** The frame time asked for: 60 fps, or the interval of the player's frame cap. */
  private targetMs = DYNRES_TARGET_FRAME_MS;
  private capped = false;

  constructor(min = 1, max = 1) {
    this.min = 1;
    this.max = 1;
    this.current = 1;
    this.setBounds(min, max);
    this.reset();
  }

  /** Current render scale: a fraction of the 1080p-referenced target (see render-scale.ts). */
  get scale(): number {
    return this.current;
  }

  get minScale(): number {
    return this.min;
  }

  get maxScale(): number {
    return this.max;
  }

  /** Smoothed frame time the decisions are based on, for the perf HUD. */
  get smoothedFrameMs(): number {
    return this.ema;
  }

  /** Frame time the scaler holds: 1000 / 60, or longer on a slower display or under a cap. */
  get frameBudgetMs(): number {
    return this.budget;
  }

  /**
   * The page draws at most `fps` frames a second by the player's choice (0 or less = no cap).
   * The budget becomes the cap's interval, so capped frames read as on time and not as a GPU
   * that cannot hold 60 fps. The scale stays where it is and finds its way from there.
   */
  setFrameCap(fps: number): void {
    const capMs = fps > 0 && Number.isFinite(fps) ? 1000 / fps : 0;
    const target = capMs > DYNRES_TARGET_FRAME_MS ? capMs : DYNRES_TARGET_FRAME_MS;
    const capped = capMs > 0;
    if (target === this.targetMs && capped === this.capped) return;
    this.targetMs = target;
    this.capped = capped;
    this.budget = target;
    this.clearHistory();
  }

  /** Sets the preset's bounds and clamps the current scale into them. */
  setBounds(min: number, max: number): void {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    // A scale of 0 would make a 0-pixel drawing buffer.
    this.min = Math.max(lo, DYNRES_SCALE_STEP);
    this.max = Math.max(hi, this.min);
    this.current = this.clamp(this.current);
  }

  /**
   * Pins the scale (clamped to the bounds), e.g. from the debug GUI with `enabled = false`.
   * Returns true when the scale changed.
   */
  setScale(scale: number): boolean {
    const next = this.clamp(scale);
    if (next === this.current) return false;
    this.current = next;
    this.clearHistory();
    this.cooldown = COOLDOWN_FRAMES;
    return true;
  }

  /**
   * Feed one rendered frame's duration. Returns true when the scale changed, which is the
   * caller's cue to resize the drawing buffer. Allocation-free.
   */
  update(frameMs: number): boolean {
    if (!this.enabled) return false;
    // Also rejects NaN and non-positive values.
    if (!(frameMs > 0) || frameMs === Infinity) return false;

    let sampleMs = frameMs;
    if (sampleMs > OUTLIER_MS) {
      this.outlierRun++;
      if (this.outlierRun < OUTLIER_RUN_FRAMES) return false;
      // Not a hitch but the frame rate: count it, at a value that is over any budget.
      sampleMs = OUTLIER_MS;
    } else {
      this.outlierRun = 0;
    }

    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }

    if (this.observeCadence(sampleMs)) return false;

    const budget = this.budget;
    const clamp = budget * SAMPLE_CLAMP_FACTOR;
    this.ema += ((sampleMs < clamp ? sampleMs : clamp) - this.ema) * EMA_ALPHA;

    // Checked before the probe window below: both end on the same frame, and a probe that
    // juddered has failed.
    const missedMs = this.capped
      ? budget + DYNRES_TARGET_FRAME_MS * CAPPED_MISSED_REFRESHES
      : budget * MISSED_FRAME_FACTOR;
    if (sampleMs > missedMs) this.missedFrames++;
    this.judderFrames++;
    if (this.judderFrames === JUDDER_WINDOW_FRAMES) {
      const juddering = this.missedFrames >= JUDDER_MISSED_FRAMES;
      this.judderFrames = 0;
      this.missedFrames = 0;
      if (juddering) {
        this.overFrames = 0;
        this.stableFrames = 0;
        return this.stepDown();
      }
    }

    if (this.probeFrames > 0) {
      this.probeFrames--;
      // The probe held for the whole window: the headroom was real.
      if (this.probeFrames === 0) this.stableFramesNeeded = this.stableFramesBase;
    }

    if (this.ema > budget * OVER_BUDGET_FACTOR) {
      this.stableFrames = 0;
      this.overFrames++;
      if (this.overFrames < OVER_FRAMES_TO_STEP_DOWN) return false;
      this.overFrames = 0;
      return this.stepDown();
    }

    this.overFrames = 0;
    if (this.ema > budget * ON_BUDGET_FACTOR) return false;

    this.stableFrames++;
    if (this.stableFrames < this.stableFramesNeeded) return false;
    this.stableFrames = 0;
    return this.probeUp();
  }

  /** Back to the top of the bounds with no history (new preset, new scene). */
  reset(): void {
    this.current = this.max;
    this.stableFramesBase = STABLE_FRAMES_BASE;
    this.stableFramesNeeded = STABLE_FRAMES_BASE;
    this.cooldown = 0;
    this.clearHistory();
  }

  /**
   * Feeds the cadence windows. Returns true when the budget was relaxed for a slow display,
   * which clears the history: the caller skips the rest of this frame's bookkeeping.
   */
  private observeCadence(sampleMs: number): boolean {
    this.cadenceSum += sampleMs;
    this.cadenceFrames++;
    if (this.cadenceFrames < CADENCE_WINDOW_FRAMES) return false;
    const average = this.cadenceSum / CADENCE_WINDOW_FRAMES;
    this.cadenceSum = 0;
    this.cadenceFrames = 0;

    if (average < this.fastestCadenceMs) this.fastestCadenceMs = average;
    // The best the display has shown it can do, but never asking for more than the target
    // (60 fps, or the player's frame cap).
    const proven = this.fastestCadenceMs > this.targetMs ? this.fastestCadenceMs : this.targetMs;

    if (proven < this.budget) {
      // Faster frames than the relaxed budget assumed possible: tighten it.
      this.budget = proven;
      this.steadyWindows = 0;
      return false;
    }

    // A slow display looks like this: over budget even at the minimum scale, at the same steady
    // cadence window after window, and never once faster.
    if (
      this.current !== this.min ||
      proven <= this.budget * OVER_BUDGET_FACTOR ||
      proven > SLOWEST_DISPLAY_MS ||
      average > proven * STEADY_CADENCE_FACTOR
    ) {
      this.steadyWindows = 0;
      return false;
    }
    this.steadyWindows++;
    if (this.steadyWindows < STEADY_WINDOWS_FOR_SLOW_DISPLAY) return false;

    this.budget = proven;
    this.stableFramesBase = STABLE_FRAMES_RECOVERY;
    this.stableFramesNeeded = STABLE_FRAMES_RECOVERY;
    this.clearHistory();
    return true;
  }

  private stepDown(): boolean {
    const probing = this.probeFrames > 0;
    if (probing) {
      // Failed probe: wait twice as long before trying again (and no more quick recovery).
      this.probeFrames = 0;
      this.stableFramesBase = STABLE_FRAMES_BASE;
      const doubled = this.stableFramesNeeded * 2;
      this.stableFramesNeeded =
        doubled < STABLE_FRAMES_BASE
          ? STABLE_FRAMES_BASE
          : doubled < STABLE_FRAMES_MAX
            ? doubled
            : STABLE_FRAMES_MAX;
    }
    // A failed probe only undoes its own step; it must not undershoot the last good scale.
    const steps = !probing && this.ema > this.budget * FAR_OVER_BUDGET_FACTOR ? 2 : 1;
    return this.apply(this.current - steps * DYNRES_SCALE_STEP);
  }

  private probeUp(): boolean {
    if (!this.apply(this.current + DYNRES_SCALE_STEP)) {
      // Already at the top: a quick recovery, if one was running, is over.
      this.stableFramesBase = STABLE_FRAMES_BASE;
      if (this.stableFramesNeeded < STABLE_FRAMES_BASE) {
        this.stableFramesNeeded = STABLE_FRAMES_BASE;
      }
      return false;
    }
    this.probeFrames = PROBE_WINDOW_FRAMES;
    return true;
  }

  private apply(target: number): boolean {
    const next = this.clamp(target);
    if (next === this.current) return false;
    this.current = next;
    // Old samples describe the old resolution; start from a neutral value.
    this.ema = this.budget;
    this.judderFrames = 0;
    this.missedFrames = 0;
    this.cadenceFrames = 0;
    this.cadenceSum = 0;
    this.steadyWindows = 0;
    this.cooldown = COOLDOWN_FRAMES;
    return true;
  }

  private clamp(scale: number): number {
    const q = quantize(scale);
    return q < this.min ? this.min : q > this.max ? this.max : q;
  }

  private clearHistory(): void {
    this.ema = this.budget;
    this.overFrames = 0;
    this.stableFrames = 0;
    this.probeFrames = 0;
    this.outlierRun = 0;
    this.judderFrames = 0;
    this.missedFrames = 0;
    this.cadenceFrames = 0;
    this.cadenceSum = 0;
    this.steadyWindows = 0;
  }
}
