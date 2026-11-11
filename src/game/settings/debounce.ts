/**
 * Trailing debounce with a ceiling, for "save a little after the player stops dragging the
 * slider, but at the latest a couple of seconds after the first change". The clock and the timer
 * are passed in, so tests drive it with a fake clock and no real waiting.
 */

export interface DebounceTimers {
  /** Like `setTimeout`: calls `callback` once after `delayMs`. Returns a handle for `clear`. */
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface DebounceOptions {
  /** Quiet time after the last `touch` before `run` is called. */
  readonly waitMs: number;
  /** `run` is called no later than this after the first `touch` of a burst. */
  readonly maxWaitMs: number;
  readonly now: () => number;
  readonly timers: DebounceTimers;
  readonly run: () => void;
}

export interface Debounce {
  /** Something changed: (re)start the wait. */
  touch(): void;
  /** Runs now if a run is pending. Returns true when it ran. */
  flush(): boolean;
  /** Drops a pending run without running it. */
  cancel(): void;
  readonly pending: boolean;
}

/** When a burst that started at `firstMs` and was last touched at `nowMs` should run. */
export function debounceDueMs(
  firstMs: number,
  nowMs: number,
  waitMs: number,
  maxWaitMs: number,
): number {
  const quiet = nowMs + waitMs;
  const ceiling = firstMs + maxWaitMs;
  return quiet < ceiling ? quiet : ceiling;
}

export function createDebounce(options: DebounceOptions): Debounce {
  const { waitMs, maxWaitMs, now, timers, run } = options;
  let handle: unknown = null;
  let pending = false;
  let firstMs = 0;
  let dueMs = 0;

  const stopTimer = (): void => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };

  const fire = (): void => {
    handle = null;
    if (!pending) return;
    const nowMs = now();
    // A timer that fires early (clamped or coarse timers) just waits for the rest.
    if (nowMs < dueMs) {
      handle = timers.set(fire, dueMs - nowMs);
      return;
    }
    pending = false;
    run();
  };

  return {
    get pending(): boolean {
      return pending;
    },
    touch(): void {
      const nowMs = now();
      if (!pending) {
        pending = true;
        firstMs = nowMs;
      }
      dueMs = debounceDueMs(firstMs, nowMs, waitMs, maxWaitMs);
      stopTimer();
      handle = timers.set(fire, Math.max(0, dueMs - nowMs));
    },
    flush(): boolean {
      stopTimer();
      if (!pending) return false;
      pending = false;
      run();
      return true;
    },
    cancel(): void {
      stopTimer();
      pending = false;
    },
  };
}

/** The real timers. `globalThis` so it also works where there is no `window`. */
export const SYSTEM_TIMERS: DebounceTimers = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};
