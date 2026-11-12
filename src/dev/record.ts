/**
 * `?record` (`?record=30` for another frame rate): the page stops driving itself. Nothing is
 * stepped or drawn from `requestAnimationFrame` and nothing reads real time; instead
 * `window.__dfRecord.step()` advances the whole page by exactly one frame of `1 / fps` seconds
 * and draws it. `tools/capture/record.mjs` calls it, takes a screenshot, and repeats, so a
 * video gets every frame exactly once however slow the capture is.
 *
 * What the rig replaces, all before the game is created (main.ts loads this chunk first):
 * - the frame driver's host: `requestFrame` only remembers the callback, `step()` calls it with
 *   the virtual timestamp (so the fixed 30 Hz loop gets `1000 / fps` ms per frame, exactly);
 * - `performance.now()`, for everything that reads it directly (the game's `now`, the HUD's text
 *   pacing, the UI's own timers): it returns the virtual clock;
 * - CSS animations and transitions: each is paused the frame it is born and moved on by one
 *   frame per step, so HUD pulses and menu fades play at the video's speed, not the capture's;
 * - with `&recordseed=<n>`, `Math.random` (a seeded generator: the same seed, the same match).
 * The host's sim must be on this thread (`?noworker`; main.ts forces it): a worker has its own
 * real-time timer. Network, asset downloads, decoding and shader compiles stay in real time;
 * the recorder waits for them between frames (`busy`, `quietMs` below) instead of stepping on.
 *
 * Not covered: audio (not captured at all), `Date.now()`, `setTimeout` (real time: PeerJS and
 * the settings debounce use it), and anything drawn by another `requestAnimationFrame` loop.
 *
 * `&recordstamp=1` puts the frame number in the top-left corner as 16 black / white squares,
 * for the recorder's self-test (it reads them back from the encoded video).
 *
 * Costs nothing without the flag: this module is a chunk of its own that is never fetched.
 */
import type { FrameHost } from '../game/frame-driver';

export interface RecordRig {
  /** Frames per virtual second. */
  readonly fps: number;
  /** The virtual clock in ms: give it to the game as its `now`. */
  readonly now: () => number;
  /** Give it to the `FrameDriver`: a frame happens when the recorder steps, never by itself. */
  readonly frameHost: FrameHost;
  /**
   * True while the page is still building something the next frame should wait for (a shader
   * warm-up, a map that is still loading). The recorder holds the virtual clock meanwhile.
   */
  setBusyProbe(probe: (() => boolean) | null): void;
}

/** What `step()` and `state()` hand to the recorder. Plain data: it crosses the DevTools wire. */
export interface RecordState {
  /** Frames stepped since the page loaded. */
  readonly frame: number;
  /** Virtual seconds since the page loaded: `frame / fps`. */
  readonly timeS: number;
  /** The busy probe's answer now. */
  readonly busy: boolean;
  /** Real milliseconds since a Web Worker last sent or received a message (asset decoding). */
  readonly quietMs: number;
}

/** `window.__dfRecord`. */
export interface RecordControl {
  readonly fps: number;
  /** Advances `count` frames (default 1), drawing each, then lets pending tasks run. */
  step(count?: number): Promise<RecordState>;
  state(): RecordState;
}

/** The virtual clock starts here: later than any real `performance.now()` read while booting. */
const CLOCK_BASE_MS = 10_000;
const DEFAULT_FPS = 60;
const STAMP_BITS = 16;
const STAMP_CELL_PX = 8;

/** mulberry32: small, fast, and the same sequence in every browser. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readFps(params: URLSearchParams): number {
  const value = Number(params.get('record'));
  return Number.isFinite(value) && value >= 10 && value <= 240 ? value : DEFAULT_FPS;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function createRecordRig(): RecordRig {
  const params = new URLSearchParams(location.search);
  const fps = readFps(params);
  const stepMs = 1000 / fps;
  const realNow = performance.now.bind(performance);
  // A page that took longer than the base to get here still gets a clock that never runs back.
  const baseMs = Math.max(CLOCK_BASE_MS, Math.ceil(realNow() / 1000) * 1000);

  let frame = 0;
  let timeMs = baseMs;
  const now = (): number => timeMs;
  performance.now = now;

  const seedParam = params.get('recordseed');
  if (seedParam !== null && Number.isFinite(Number(seedParam))) {
    Math.random = createSeededRandom(Number(seedParam));
  }

  // --- Asset decoding happens in workers (the KTX2 transcoder): note their traffic --------------
  let lastWorkerMs = realNow();
  const touch = (): void => {
    lastWorkerMs = realNow();
  };
  const heard = new WeakSet<Worker>();
  const nativePost = Worker.prototype.postMessage;
  function trackedPost(this: Worker, ...args: unknown[]): void {
    if (!heard.has(this)) {
      heard.add(this);
      this.addEventListener('message', touch);
    }
    touch();
    Reflect.apply(nativePost, this, args);
  }
  Worker.prototype.postMessage = trackedPost;

  // --- CSS animations and transitions on the virtual clock --------------------------------------
  const held = new WeakSet<Animation>();

  /** Moves every animation this rig holds on by one frame; ends the ones that are done. */
  function advanceAnimations(): void {
    for (const animation of document.getAnimations()) {
      if (!held.has(animation) || animation.playState === 'finished') continue;
      const at = Number(animation.currentTime ?? 0) + stepMs;
      const end = Number(animation.effect?.getComputedTiming().endTime ?? Infinity);
      if (at >= end) {
        // `finish` rather than a parked clock: the end events fire and the fill applies.
        animation.finish();
      } else {
        animation.currentTime = at;
      }
    }
  }

  /** Takes over the animations the frame just started: they begin at 0 on this frame. */
  function holdNewAnimations(): void {
    // `getAnimations` flushes style first, so what this frame's DOM changes started is in it.
    for (const animation of document.getAnimations()) {
      if (held.has(animation) || animation.playState === 'finished') continue;
      held.add(animation);
      animation.pause();
      animation.currentTime = 0;
    }
  }

  // --- The frame number as squares, for the recorder's self-test --------------------------------
  const cells: HTMLElement[] = [];
  if (params.get('recordstamp') === '1') {
    const stamp = document.createElement('div');
    stamp.style.cssText =
      `position:fixed;left:0;top:0;z-index:2147483647;display:flex;pointer-events:none;` +
      `width:${STAMP_BITS * STAMP_CELL_PX}px;height:${STAMP_CELL_PX}px;background:#000;`;
    for (let bit = 0; bit < STAMP_BITS; bit++) {
      const cell = document.createElement('div');
      cell.style.cssText = `flex:none;width:${STAMP_CELL_PX}px;height:${STAMP_CELL_PX}px;background:#000;`;
      stamp.appendChild(cell);
      cells.push(cell);
    }
    document.body.appendChild(stamp);
  }
  let stamped = 0;
  function writeStamp(): void {
    const changed = stamped ^ frame;
    stamped = frame;
    for (let bit = 0; bit < cells.length; bit++) {
      if (((changed >> bit) & 1) === 0) continue;
      // Bit 0 is the rightmost square, like a written binary number.
      const cell = cells[cells.length - 1 - bit];
      if (cell !== undefined) cell.style.background = ((frame >> bit) & 1) === 1 ? '#fff' : '#000';
    }
  }

  // --- The frame driver's host -------------------------------------------------------------------
  let pending: ((timeMs: number) => void) | null = null;
  let handle = 0;
  const frameHost: FrameHost = {
    requestFrame(callback): number {
      pending = callback;
      return ++handle;
    },
    cancelFrame(which): void {
      if (which === handle) pending = null;
    },
    now,
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  };

  let busyProbe: (() => boolean) | null = null;
  function state(): RecordState {
    return {
      frame,
      timeS: frame / fps,
      busy: busyProbe !== null && busyProbe(),
      quietMs: realNow() - lastWorkerMs,
    };
  }

  function stepOne(): void {
    frame++;
    // From the frame number, not accumulated: no drift over a long take.
    timeMs = baseMs + frame * stepMs;
    advanceAnimations();
    const callback = pending;
    pending = null;
    if (callback !== null) callback(timeMs);
    holdNewAnimations();
    if (cells.length > 0) writeStamp();
  }

  const control: RecordControl = {
    fps,
    async step(count = 1): Promise<RecordState> {
      for (let i = 0; i < count; i++) stepOne();
      // Promise chains and loader callbacks that this frame set off run before the recorder
      // decides whether to wait: the same work lands on the same frame in every take.
      await nextTask();
      await nextTask();
      return state();
    },
    state,
  };
  Reflect.set(window, '__dfRecord', control);

  return {
    fps,
    now,
    frameHost,
    setBusyProbe(probe): void {
      busyProbe = probe;
    },
  };
}
