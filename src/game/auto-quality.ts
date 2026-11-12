/**
 * The automatic quality pick (docs/PERFORMANCE.md, "Automatic quality pick"): the measuring and
 * the deciding, with no DOM and no three.js so it runs in node tests. ./auto-quality-run.ts
 * drives it from the frame loop and owns everything that touches the renderer and the settings.
 *
 * WHAT IS MEASURED. Not the frame time: a display shows at most its refresh rate, so on a 60 Hz
 * panel a fast machine and a barely adequate one both report 16.7 ms. The number that decides is
 * the GPU's own time for the frame, from a timer query round the draw
 * (`EXT_disjoint_timer_query_webgl2`, src/render/gpu-cost-probe.ts), which vsync does not touch.
 *
 * WHAT IS DRAWN. The title scene (sky, cloud sea, clouds: 6 draw calls) on Medium, at Medium's
 * top render scale, with dynamic resolution held off. One preset, measured once: stepping
 * through High, Medium and Low would recompile shaders and visibly change the picture three
 * times behind the title, and take three times as long. One title draw is far too light to
 * measure a machine by (0.3 ms on the dev desktop, and a GPU that idles between frames clocks
 * down and reads slower than it is), so the test draws it several times inside one timer
 * query: eight times at the 1080p reference size, which costs the dev desktop about what one
 * High fight frame costs it, so the GPU is loaded roughly as it will be in a match. Only the
 * last draw is seen.
 *
 * THE WINDOW SIZE. A small window draws fewer pixels per pass. Scaling the measured time up by
 * the pixel ratio is wrong: a lightly loaded GPU lowers its clock, so the time does not follow
 * the pixels (measured on the dev desktop: a quarter of the pixels cost half the time, not a
 * quarter). Instead the test keeps the LOAD the same: a smaller window gets more draws
 * (`repeatsForScene`), so every machine pushes about the same number of pixels per test frame
 * whatever its window. A window with more pixels than the reference (ultrawide) keeps the
 * eight draws: it really will have more to draw in a match.
 *
 * HOW IT DECIDES. The trimmed mean of the GPU times (one hitch, or a dozen, does not move it),
 * expressed per draw at the 1080p reference size, is "GPU ms per title draw". Two limits on
 * that number split Low / Medium / High; see `AUTO_QUALITY_TUNING` for the numbers and where
 * they come from. A preset already in use is kept while the measurement is inside its limits,
 * and a step UP needs 15 % to spare, so a machine on the edge does not get High and "Test
 * again" does not flip between two presets.
 *
 * Without the timer extension (Firefox, Safari) only the frame time is left, and that cannot
 * show headroom: the pick is then Medium, or Low when the title itself runs below 25 fps.
 */
import { DEFAULT_QUALITY, QUALITY_PRESETS, RENDER_SCALE_REFERENCE_HEIGHT } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';

/** The preset the test runs on. Boot starts on it, so a first launch changes nothing visible. */
export const AUTO_QUALITY_PRESET: QualityPresetId = DEFAULT_QUALITY;
/** The render scale held during the test: the preset's top, where its scene target is full. */
export const AUTO_QUALITY_SCALE = QUALITY_PRESETS[AUTO_QUALITY_PRESET].renderScaleMax;
/**
 * Scene pixels of the test on a 16:9 window of 1080 lines or more (1632 x 918 on Medium). A
 * smaller window draws fewer pixels per pass and would flatter the machine, so it gets more
 * draws per test frame (`repeatsForScene`) to push the same number of pixels as this size.
 */
export const AUTO_QUALITY_REFERENCE_PIXELS =
  Math.round(((RENDER_SCALE_REFERENCE_HEIGHT * 16) / 9) * AUTO_QUALITY_SCALE) *
  Math.round(RENDER_SCALE_REFERENCE_HEIGHT * AUTO_QUALITY_SCALE);

/**
 * Every number of the automatic pick. The two limits are in "GPU ms per title draw at the
 * reference size", the figure the console line reports as `per draw`.
 *
 * Where the limits come from (dev desktop, GTX 1660 SUPER, headless Edge, 1920x1080, timer
 * queries; measured 2026-11-11, T-6.2, at 300 and at 60 frames a second):
 *   title, Medium 0.85, 8 draws   2.9-4.4 ms  -> 0.36-0.55 ms per draw (0.4 taken)
 *   5v5 bot fight (`?bench`)      Medium 1.2-2.4 ms, High 2.7-3.2 ms
 * so a fight frame costs about 3 to 6 title draws on Medium and 7 to 8 on High. (The spread is
 * the desktop's GPU changing its clock with the load, on a machine busy with other work;
 * these are loose numbers.) A laptop measured cold in 3 s runs slower once it is warm (15 W
 * chips drop from their burst power): allow a factor 1.4. The GPU budget is 11 ms
 * (docs/PERFORMANCE.md, "Frame budget").
 *   High:   7.5 x 1.4 x perDraw <= 11 x 0.75 (a quarter kept spare)  ->  perDraw <= 0.8 ms
 *   Low:    Medium can halve its pixels (scale 0.85 -> 0.6), which takes a fight to about 0.6
 *           of its cost. With the dear end of the Medium range:
 *           5.9 x 1.4 x 0.6 x perDraw > 11                           ->  perDraw > 2.2 ms
 * A U-series laptop is expected near 1.4 ms per draw (about 3.5 times slower than the dev
 * desktop's GPU): Medium, with room on both sides. THAT FIGURE IS AN ESTIMATE. The limits must
 * be checked against the console line of a real U-series laptop (cold, and again after ten
 * minutes of play via Settings > Test again) and moved if it does not land near the middle.
 */
export const AUTO_QUALITY_TUNING = {
  /** Title draws inside one timed frame at the reference size (see the file header). */
  repeats: 8,

  /** High at or below this many GPU ms per title draw... */
  highMaxDrawMs: 0.8,
  /** ...Low above this many; Medium in between. */
  lowMinDrawMs: 2.2,
  /** A step up from the preset in use must clear its limit by this fraction. */
  stepUpMargin: 0.15,
  /** High also needs steady frames: the 95th percentile at most this many times the mean... */
  highMaxSpread: 2,
  /** ...and a page that really showed 50 fps or more under the test load (not a 30 fps cap). */
  highMaxFrameMs: 20,

  /** Discarded after every start and restart: shader warm-up, a resize, timer results in flight. */
  warmupFrames: 30,
  warmupMs: 500,
  /** Then this much is measured. */
  measureMs: 3000,
  /** GPU times needed to decide by them; the test runs on (to `maxMeasureMs`) to get them. */
  minSamples: 20,
  maxMeasureMs: 8000,
  /** Share of the samples dropped at each end before averaging. */
  trim: 0.1,

  /** A frame longer than this is not a frame: the tab was hidden or throttled. Start again. */
  gapMs: 250,
  /** This many long frames in a row are not a pause: the machine draws the title that slowly. */
  slowRunFrames: 8,
  /** Restarts (hidden tab, resize, hitch) before the test gives up for this page load. */
  maxRestarts: 6,

  /**
   * A window smaller than the reference gets more draws, up to this many times `repeats`
   * (a scene of a quarter of the reference pixels). A window smaller still is not corrected
   * further: the test then reads a little kind, in a window nobody plays in.
   */
  maxPixelCorrection: 4,
  /** No GPU timer: Low when the title's frame time is above this (no display is slower than 25 Hz). */
  noTimerLowFrameMs: 40,
} as const;

/** 8 s at 120 Hz; a faster display stops storing (not measuring) when the buffers are full. */
const CAPACITY = 1024;

export type AutoQualityMeterState =
  /** Discarding frames after a start or a restart. */
  | 'warmup'
  | 'measuring'
  /** Enough measured: `read` has the numbers. */
  | 'done'
  /** The title itself runs below 4 fps: Low, with nothing to average. */
  | 'tooSlow'
  /** Interrupted too often, or throttled by something that is not the GPU: no result. */
  | 'failed';

export type AutoQualityMethod = 'gpu-timer' | 'frame-time';

/** What a finished test measured. One object, filled by `AutoQualityMeter.read`. */
export interface AutoQualityMeasurement {
  /** `gpu-timer` when enough GPU times arrived; else only `frameMs` means anything. */
  method: AutoQualityMethod;
  /** GPU times averaged. */
  samples: number;
  /** Trimmed mean GPU ms of one test frame (all `repeats` draws). */
  costMs: number;
  /** 95th percentile of the same. */
  costP95Ms: number;
  /** Frames measured, their trimmed mean interval, and how long they took together. */
  frames: number;
  frameMs: number;
  seconds: number;
}

export function createAutoQualityMeasurement(): AutoQualityMeasurement {
  return {
    method: 'frame-time',
    samples: 0,
    costMs: 0,
    costP95Ms: 0,
    frames: 0,
    frameMs: 0,
    seconds: 0,
  };
}

/** Mean of `sorted[0..count)` without the lowest and highest `trim` share. */
function trimmedMean(sorted: Float64Array, count: number, trim: number): number {
  if (count <= 0) return 0;
  const drop = Math.floor(count * trim);
  let sum = 0;
  for (let i = drop; i < count - drop; i++) sum += sorted[i] ?? 0;
  return sum / (count - 2 * drop);
}

function percentile(sorted: Float64Array, count: number, p: number): number {
  if (count <= 0) return 0;
  const index = Math.floor(count * p);
  return sorted[index < count ? index : count - 1] ?? 0;
}

/**
 * Collects the frames of one test. Feed it every rendered frame; it discards the warm-up,
 * restarts itself after a gap, and says when it has enough. `push` does not allocate.
 */
export class AutoQualityMeter {
  private readonly costs = new Float64Array(CAPACITY);
  private readonly intervals = new Float64Array(CAPACITY);
  private current: AutoQualityMeterState = 'warmup';
  private expectCost = true;
  private warmFrames = 0;
  private warmMs = 0;
  private frameCount = 0;
  private costCount = 0;
  private measuredMs = 0;
  private gapRun = 0;
  private restartCount = 0;
  /** Newest GPU time since `begin`, -1 before the first. Survives restarts. */
  private lastCostMs = -1;

  get state(): AutoQualityMeterState {
    return this.current;
  }

  /** Restarts since `begin`. */
  get restarts(): number {
    return this.restartCount;
  }

  /** A new test. `expectCost` false = no GPU timer: decide by frame time after `measureMs`. */
  begin(expectCost: boolean): void {
    this.expectCost = expectCost;
    this.restartCount = 0;
    this.gapRun = 0;
    this.lastCostMs = -1;
    this.clear();
  }

  /**
   * Something outside the test disturbed it (the tab was hidden, the window was resized): what
   * was measured so far is dropped and the warm-up runs again.
   */
  interrupt(): AutoQualityMeterState {
    if (this.current !== 'warmup' && this.current !== 'measuring') return this.current;
    // A second call before any frame arrived is the same interruption (hidden for many beats).
    if (this.current === 'warmup' && this.warmFrames === 0 && this.restartCount > 0) {
      return this.current;
    }
    this.restartCount++;
    this.clear();
    if (this.restartCount > AUTO_QUALITY_TUNING.maxRestarts) this.current = 'failed';
    return this.current;
  }

  /**
   * One rendered frame: the time since the previous one, and a GPU time if one became ready
   * (they arrive a frame or two late and belong to an earlier frame; pass a negative number or
   * NaN for "none").
   */
  push(frameMs: number, costMs: number): AutoQualityMeterState {
    const tuning = AUTO_QUALITY_TUNING;
    if (this.current !== 'warmup' && this.current !== 'measuring') return this.current;
    if (!(frameMs > 0) || frameMs === Infinity) return this.current;
    const hasCost = costMs >= 0 && costMs !== Infinity;
    if (hasCost) this.lastCostMs = costMs;

    if (frameMs > tuning.gapMs) {
      this.gapRun++;
      if (this.gapRun >= tuning.slowRunFrames) {
        // Nothing but long frames while the page is visible. If the GPU says its part was
        // short, something else is holding the page back and this is no measurement at all.
        const gpuIsQuick =
          this.expectCost && this.lastCostMs >= 0 && this.lastCostMs < tuning.gapMs * 0.5;
        this.current = gpuIsQuick ? 'failed' : 'tooSlow';
        return this.current;
      }
      // The first long frame of a run is the interruption; the rest belong to it.
      if (this.gapRun === 1) this.restartCount++;
      this.clear();
      if (this.restartCount > tuning.maxRestarts) this.current = 'failed';
      return this.current;
    }
    this.gapRun = 0;

    if (this.current === 'warmup') {
      this.warmFrames++;
      this.warmMs += frameMs;
      if (this.warmFrames >= tuning.warmupFrames && this.warmMs >= tuning.warmupMs) {
        this.current = 'measuring';
      }
      return this.current;
    }

    if (this.frameCount < CAPACITY) this.intervals[this.frameCount++] = frameMs;
    this.measuredMs += frameMs;
    if (hasCost && this.costCount < CAPACITY) this.costs[this.costCount++] = costMs;

    const enoughCost = !this.expectCost || this.costCount >= tuning.minSamples;
    if (
      (this.measuredMs >= tuning.measureMs && enoughCost) ||
      this.measuredMs >= tuning.maxMeasureMs
    ) {
      this.current = 'done';
    }
    return this.current;
  }

  /**
   * The numbers of a finished test. Sorts the stored samples, so call it once, at the end
   * (it allocates two small array views).
   */
  read(out: AutoQualityMeasurement): AutoQualityMeasurement {
    const tuning = AUTO_QUALITY_TUNING;
    const costs = this.costs.subarray(0, this.costCount).sort();
    const intervals = this.intervals.subarray(0, this.frameCount).sort();
    out.method =
      this.expectCost && this.costCount >= tuning.minSamples ? 'gpu-timer' : 'frame-time';
    out.samples = this.costCount;
    out.costMs = trimmedMean(costs, this.costCount, tuning.trim);
    out.costP95Ms = percentile(costs, this.costCount, 0.95);
    out.frames = this.frameCount;
    out.frameMs = trimmedMean(intervals, this.frameCount, tuning.trim);
    out.seconds = this.measuredMs / 1000;
    return out;
  }

  private clear(): void {
    this.current = 'warmup';
    this.warmFrames = 0;
    this.warmMs = 0;
    this.frameCount = 0;
    this.costCount = 0;
    this.measuredMs = 0;
  }
}

export interface AutoQualityDecision {
  readonly preset: QualityPresetId;
  /** GPU ms per title draw at the reference size; -1 when only the frame time was known. */
  readonly drawMs: number;
  /** The limits this decision used, after the step-up margin: High at or below, Low above. */
  readonly highLimitMs: number;
  readonly lowLimitMs: number;
  /** A few plain words for the console line. */
  readonly reason: string;
}

/**
 * How many reference-sized draws one draw of `scenePixels` stands for: 1 at the reference size
 * and above (never less: an ultrawide window really does draw more than the reference), up to
 * `maxPixelCorrection` for a small window. 0 or less = unknown, taken as the reference.
 */
function pixelRatio(scenePixels: number): number {
  if (!(scenePixels > 0)) return 1;
  const ratio = AUTO_QUALITY_REFERENCE_PIXELS / scenePixels;
  const max = AUTO_QUALITY_TUNING.maxPixelCorrection;
  return ratio <= 1 ? 1 : ratio < max ? ratio : max;
}

/**
 * Title draws per test frame for a scene of `scenePixels`, so that the pixels drawn per frame
 * (and with them the load on the GPU) are the same in a small window as at the reference size:
 * 8 at 1632 x 918 and above, 18 at 1088 x 612, 32 at 816 x 459 and below.
 */
export function repeatsForScene(scenePixels: number): number {
  return Math.round(AUTO_QUALITY_TUNING.repeats * pixelRatio(scenePixels));
}

/**
 * GPU ms per title draw at the reference size, from a test frame's cost: the cost of one draw,
 * times the reference-sized draws it stands for. With `repeatsForScene` draws that is the
 * frame's cost divided by `AUTO_QUALITY_TUNING.repeats`, whatever the window.
 */
export function drawMsAtReference(costMs: number, repeats: number, scenePixels: number): number {
  return (costMs / (repeats >= 1 ? repeats : 1)) * pixelRatio(scenePixels);
}

/**
 * The preset for a finished measurement. `held` is the preset in use by an earlier automatic
 * pick (a re-test); null on a first launch, where the page is on the default and that counts
 * as held. Pure.
 */
export function decideQuality(
  measurement: Readonly<AutoQualityMeasurement>,
  repeats: number,
  scenePixels: number,
  held: QualityPresetId | null,
): AutoQualityDecision {
  const tuning = AUTO_QUALITY_TUNING;
  const from = held ?? DEFAULT_QUALITY;
  const keep = 1 - tuning.stepUpMargin;

  if (measurement.method !== 'gpu-timer') {
    // Frame time only: it can show a machine that cannot draw the title, never one with room.
    const limit = from === 'low' ? tuning.noTimerLowFrameMs * keep : tuning.noTimerLowFrameMs;
    const slow = measurement.frameMs > limit;
    return {
      preset: slow ? 'low' : 'medium',
      drawMs: -1,
      highLimitMs: 0,
      lowLimitMs: limit,
      reason: slow
        ? 'no GPU timer; the title runs below 25 fps'
        : 'no GPU timer; frame time cannot show headroom',
    };
  }

  const drawMs = drawMsAtReference(measurement.costMs, repeats, scenePixels);
  // Staying where it is needs the plain limit; moving up needs the margin.
  const highLimitMs = from === 'high' ? tuning.highMaxDrawMs : tuning.highMaxDrawMs * keep;
  const lowLimitMs = from === 'low' ? tuning.lowMinDrawMs * keep : tuning.lowMinDrawMs;

  if (drawMs > lowLimitMs) {
    return { preset: 'low', drawMs, highLimitMs, lowLimitMs, reason: 'too slow for Medium' };
  }
  if (drawMs > highLimitMs) {
    return { preset: 'medium', drawMs, highLimitMs, lowLimitMs, reason: 'inside the Medium range' };
  }
  if (measurement.costP95Ms > measurement.costMs * tuning.highMaxSpread) {
    return { preset: 'medium', drawMs, highLimitMs, lowLimitMs, reason: 'fast, but uneven' };
  }
  if (measurement.frameMs > tuning.highMaxFrameMs) {
    return {
      preset: 'medium',
      drawMs,
      highLimitMs,
      lowLimitMs,
      reason: 'fast, but the page showed under 50 fps',
    };
  }
  return { preset: 'high', drawMs, highLimitMs, lowLimitMs, reason: 'fast and steady' };
}
