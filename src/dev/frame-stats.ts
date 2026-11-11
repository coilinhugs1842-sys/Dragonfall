/**
 * Rolling frame-time statistics over the last N frames. Pure (no DOM, no three.js) so it runs in
 * node tests and can back both the `?perf` HUD and the `?bench` summary.
 *
 * `push` is the per-frame call and only writes one float into a ring buffer. The statistics are
 * computed in `read`, which callers run a few times per second: that keeps the per-frame cost
 * near zero, and neither call allocates.
 */

/** Share of the slowest frames that the "1 % low" figure averages. */
const LOW_FRACTION = 0.01;

/** 10 s at 60 fps: long enough for a stable 1 % low (6 frames), short enough to follow changes. */
export const DEFAULT_FRAME_WINDOW = 600;

export interface FrameStatsSummary {
  /** Frames currently in the window (0 until the first push). */
  count: number;
  /** Mean frame time in ms. */
  avgMs: number;
  /** 1000 / avgMs: frames delivered per second over the window, not a mean of per-frame rates. */
  fps: number;
  /** Slowest single frame in the window, in ms. */
  maxMs: number;
  /** Mean frame time of the slowest 1 % of frames (at least one frame), in ms. */
  onePercentLowMs: number;
  /** 1000 / onePercentLowMs: the "1 % low fps" the phase gates are written against. */
  onePercentLowFps: number;
}

/** A zeroed summary for callers to keep and pass to `FrameStats.read` every time. */
export function createFrameStatsSummary(): FrameStatsSummary {
  return { count: 0, avgMs: 0, fps: 0, maxMs: 0, onePercentLowMs: 0, onePercentLowFps: 0 };
}

export class FrameStats {
  readonly capacity: number;
  private readonly samples: Float32Array;
  /** Sort space for `read`, so finding the slowest frames never disturbs the ring order. */
  private readonly scratch: Float32Array;
  private head = 0;
  private filled = 0;

  constructor(capacity: number = DEFAULT_FRAME_WINDOW) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`FrameStats capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.samples = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity);
  }

  /** Frames currently in the window. */
  get count(): number {
    return this.filled;
  }

  /** Records one frame time. Negative and non-finite values are dropped: they are clock glitches. */
  push(frameMs: number): void {
    if (!(frameMs >= 0) || frameMs === Infinity) return;
    this.samples[this.head] = frameMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Fills `out` with the statistics of the current window and returns it. No allocation. */
  read(out: FrameStatsSummary): FrameStatsSummary {
    const n = this.filled;
    out.count = n;
    if (n === 0) {
      out.avgMs = 0;
      out.fps = 0;
      out.maxMs = 0;
      out.onePercentLowMs = 0;
      out.onePercentLowFps = 0;
      return out;
    }

    // Until the ring wraps, the samples sit in [0, n); afterwards n === capacity. Either way the
    // first n slots are exactly the window. Unused scratch slots become 0 so they sort first.
    const { samples, scratch } = this;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[i] ?? 0;
      scratch[i] = v;
      sum += v;
    }
    scratch.fill(0, n);
    scratch.sort();

    const last = this.capacity - 1;
    const lowCount = Math.max(1, Math.ceil(n * LOW_FRACTION));
    let lowSum = 0;
    for (let i = 0; i < lowCount; i++) lowSum += scratch[last - i] ?? 0;

    const avgMs = sum / n;
    const lowMs = lowSum / lowCount;
    out.avgMs = avgMs;
    out.fps = avgMs > 0 ? 1000 / avgMs : 0;
    out.maxMs = scratch[last] ?? 0;
    out.onePercentLowMs = lowMs;
    out.onePercentLowFps = lowMs > 0 ? 1000 / lowMs : 0;
    return out;
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
  }
}
