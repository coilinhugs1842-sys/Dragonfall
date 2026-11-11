/**
 * Boot: create the one renderer, start the App state machine, start the frame driver.
 *
 * Phase 1 has no title screen or lobby yet, so the app starts in `match`, which is the flight
 * sandbox (game/match-scene.ts). The other states exist and are reachable from the `?debug`
 * panel; they draw nothing.
 *
 * Only ./dev/query-flags and ./dev/boot may be imported from `dev` here. They are tiny; the
 * `./dev` barrel would pull stats-gl and lil-gui into the entry chunk.
 */
import './style.css';
import { loadDevTools } from './dev/boot';
import type { PerfHud } from './dev/perf-hud';
import { getQueryFlags } from './dev/query-flags';
import { App, FrameDriver, createMatchScene, readStoredQuality } from './game';
import { WebGL2UnavailableError, createGameRenderer } from './render';
import type { GameRenderer } from './render';
import { DEFAULT_QUALITY, TICK_MS } from './shared';
import type { QualityPresetId } from './shared';
import { FixedStepLoop } from './sim';

/** EMA weight for the HUD's sim figure. Most 60 Hz frames run 0 or 1 sim steps, so raw is noisy. */
const SIM_MS_SMOOTHING = 0.05;

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`index.html is missing #${id}`);
  return element;
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Some browsers throw on the property access itself when storage is blocked.
    return null;
  }
}

/** `?quality=` wins, then the saved setting, then the default (until the automatic pick exists). */
function pickQuality(forced: QualityPresetId | null): QualityPresetId {
  return forced ?? readStoredQuality(localStorageOrNull()) ?? DEFAULT_QUALITY;
}

/** Returns null after showing the index.html fallback when WebGL2 cannot be created. */
function createRendererOrFallback(
  canvas: HTMLCanvasElement,
  presetId: QualityPresetId,
): GameRenderer | null {
  try {
    return createGameRenderer(canvas, presetId);
  } catch (error) {
    if (!(error instanceof WebGL2UnavailableError)) throw error;
    console.warn(error.message);
    requireElement('fallback', HTMLElement).hidden = false;
    canvas.hidden = true;
    return null;
  }
}

/**
 * Runs `onChange` whenever devicePixelRatio changes (browser zoom, window dragged to another
 * monitor). A resolution media query only matches one ratio, so it is re-armed after each change.
 */
function watchDevicePixelRatio(onChange: () => void): void {
  const arm = (): void => {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener(
      'change',
      () => {
        onChange();
        arm();
      },
      { once: true },
    );
  };
  arm();
}

function boot(): void {
  const flags = getQueryFlags();
  const canvas = requireElement('game', HTMLCanvasElement);
  const renderer = createRendererOrFallback(canvas, pickQuality(flags.quality));
  if (renderer === null) return;

  const app = new App('match');
  const match = createMatchScene({
    app,
    renderer,
    canvas,
    autopilot: flags.autopilot,
    skipSeconds: flags.skipSeconds,
  });

  const applySize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.resize(width, height, window.devicePixelRatio);
    if (width > 0 && height > 0) match.setAspect(width / height);
  };
  applySize();
  new ResizeObserver(applySize).observe(canvas);
  watchDevicePixelRatio(applySize);

  // The active state's scene samples input and steps its sim inside `app.update`, so the
  // frame driver's sim timing (the HUD's `sim` line) covers all of it.
  const loop = new FixedStepLoop(TICK_MS, (tick) => {
    app.update(tick);
  });

  // Filled in when the `?perf` chunk arrives; stays null in normal play.
  let perfHud: PerfHud | null = null;
  let simMs = 0;

  const driver = new FrameDriver({
    loop,
    // Created once and called every frame: nothing in here may allocate.
    render: (alpha, frameMs) => {
      perfHud?.begin(frameMs);
      simMs += (driver.simMs - simMs) * SIM_MS_SMOOTHING;
      match.renderFrame(alpha, frameMs);
      perfHud?.end();
    },
  });

  app.start();
  driver.start();

  // Not awaited: the game must not wait for (or die with) a dev-only chunk. loadDevTools
  // already turns a tool whose chunk failed into null; the handler below is for anything else.
  loadDevTools(flags, { renderer, app, getSimMs: () => simMs }).then(
    (dev) => {
      perfHud = dev.perfHud;
    },
    (error: unknown) => {
      console.warn('Dev tools failed to load', error);
    },
  );
}

boot();
