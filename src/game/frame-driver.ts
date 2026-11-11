/**
 * requestAnimationFrame driver. It owns the clock: each frame it measures elapsed time, pays it
 * into the fixed-step loop, then calls the render callback with the interpolation alpha.
 *
 * It stops while the tab is hidden and restarts its clock on return, so the time spent away is
 * never simulated (no fast-forward). The browser pieces come through `FrameHost` so tests can
 * drive it by hand in node.
 */

import type { FixedStepLoop } from '../sim/fixed-loop';

/** The slice of `window`/`document` the driver needs. */
export interface FrameHost {
  requestFrame(callback: (timeMs: number) => void): number;
  cancelFrame(handle: number): void;
  /** High-resolution clock, used only to time the sim work for the perf HUD. */
  now(): number;
  isHidden(): boolean;
  /** Subscribes to visibility changes. Returns the unsubscribe function. */
  onVisibilityChange(listener: () => void): () => void;
}

export type FrameRenderFn = (alpha: number, frameMs: number) => void;

export interface FrameDriverOptions {
  loop: FixedStepLoop;
  render: FrameRenderFn;
  /** Defaults to the real browser (`createBrowserFrameHost`). */
  host?: FrameHost;
}

/** Reported as `frameMs` on a frame with no measurement (the first one after start or resume). */
const NOMINAL_FRAME_MS = 1000 / 60;

export function createBrowserFrameHost(): FrameHost {
  return {
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    now: () => performance.now(),
    isHidden: () => document.hidden,
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

export class FrameDriver {
  private readonly loop: FixedStepLoop;
  private readonly render: FrameRenderFn;
  private readonly host: FrameHost;
  private wanted = false;
  private handle: number | null = null;
  /** NaN means "no previous frame": the next frame measures nothing. */
  private lastTimeMs = Number.NaN;
  private lastFrameMs = NOMINAL_FRAME_MS;
  private lastSimMs = 0;
  private unsubscribeVisibility: (() => void) | null = null;

  constructor(options: FrameDriverOptions) {
    this.loop = options.loop;
    this.render = options.render;
    this.host = options.host ?? createBrowserFrameHost();
  }

  /** True between `start()` and `stop()`, including while paused by a hidden tab. */
  get running(): boolean {
    return this.wanted;
  }

  /** True when started but not scheduling frames because the tab is hidden. */
  get paused(): boolean {
    return this.wanted && this.handle === null;
  }

  /** Time the sim steps took in the latest frame (0 if none ran). Feeds `PerfHud.getSimMs`. */
  get simMs(): number {
    return this.lastSimMs;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.unsubscribeVisibility = this.host.onVisibilityChange(this.onVisibility);
    if (!this.host.isHidden()) this.schedule();
  }

  stop(): void {
    if (!this.wanted) return;
    this.wanted = false;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    this.cancel();
  }

  /** Same as `stop()`; named for symmetry with the other long-lived objects. */
  dispose(): void {
    this.stop();
  }

  private schedule(): void {
    // The previous timestamp is stale after any gap, and the banked fraction belongs to a frame
    // that was never shown.
    this.lastTimeMs = Number.NaN;
    this.loop.clearAccumulator();
    this.handle = this.host.requestFrame(this.onFrame);
  }

  private cancel(): void {
    if (this.handle !== null) {
      this.host.cancelFrame(this.handle);
      this.handle = null;
    }
  }

  private readonly onVisibility = (): void => {
    if (!this.wanted) return;
    if (this.host.isHidden()) {
      this.cancel();
    } else if (this.handle === null) {
      this.schedule();
    }
  };

  private readonly onFrame = (timeMs: number): void => {
    if (!this.wanted) return;
    // Re-arm first so an exception in sim or render does not freeze the game for good.
    this.handle = this.host.requestFrame(this.onFrame);

    const elapsedMs = timeMs - this.lastTimeMs;
    this.lastTimeMs = timeMs;
    // False for the NaN of a first frame and for a clock that went backwards.
    const measured = elapsedMs > 0;
    // An unmeasured frame repeats the last figure: reporting 0 would read as an infinitely fast
    // frame and push the resolution scaler up.
    if (measured) this.lastFrameMs = elapsedMs;

    const simStart = this.host.now();
    const steps = measured ? this.loop.advance(elapsedMs) : 0;
    this.lastSimMs = steps > 0 ? this.host.now() - simStart : 0;

    this.render(this.loop.alpha, this.lastFrameMs);
  };
}
