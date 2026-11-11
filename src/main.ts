/**
 * Boot: create the one renderer, the game controller (title -> lobby -> match, see
 * ./game/game.ts) and the frame driver.
 *
 * Only ./dev/query-flags and ./dev/boot may be imported from `dev` here. They are tiny; the
 * `./dev` barrel would pull stats-gl and lil-gui into the entry chunk. The netsim chunk and the
 * PeerJS chunk are fetched on demand (`?netsim` / `?debug`, and when the player hosts or joins).
 */
import './style.css';
import { loadDevTools, loadNetsim } from './dev/boot';
import type { PerfHud } from './dev/perf-hud';
import { getQueryFlags } from './dev/query-flags';
import { FrameDriver, createGame, readStoredQuality } from './game';
import type { Game } from './game';
import { WebGL2UnavailableError, createGameRenderer } from './render';
import type { GameRenderer } from './render';
import { DEFAULT_QUALITY, TICK_MS } from './shared';
import type { QualityPresetId } from './shared';
import { FixedStepLoop } from './sim';

/** What a dev build (and `?debug`) hangs on `window` for the console and the browser tests. */
interface DebugHook {
  readonly game: Game;
  report(): unknown;
}

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`index.html is missing #${id}`);
  return element;
}

function storageOrNull(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return window[kind];
  } catch {
    // Some browsers throw on the property access itself when storage is blocked.
    return null;
  }
}

/** `?quality=` wins, then the saved setting, then the default (until the automatic pick exists). */
function pickQuality(forced: QualityPresetId | null): QualityPresetId {
  return forced ?? readStoredQuality(storageOrNull('localStorage')) ?? DEFAULT_QUALITY;
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

  const now = (): number => performance.now();
  // Fetched only with `?netsim` or `?debug`; the game waits for it before its first transport.
  const netsim = loadNetsim(flags, now);

  const game = createGame({
    canvas,
    uiRoot: requireElement('ui', HTMLElement),
    renderer,
    flags: {
      autopilot: flags.autopilot,
      skipSeconds: flags.skipSeconds,
      bots: flags.bots,
      lan: flags.lan,
      solo: flags.solo,
      autostart: flags.autostart,
      noWorker: flags.noWorker,
      measure: flags.perf || flags.debug || import.meta.env.DEV,
    },
    storage: { local: storageOrNull('localStorage'), session: storageOrNull('sessionStorage') },
    pageHostname: window.location.hostname,
    now,
    shaper: netsim,
  });

  const applySize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.resize(width, height, window.devicePixelRatio);
    if (width > 0 && height > 0) game.setAspect(width / height);
  };
  applySize();
  new ResizeObserver(applySize).observe(canvas);
  watchDevicePixelRatio(applySize);

  // The host's fixed 30 Hz step. A client's ticks are run by its session inside `game.frame`
  // (the host steers their rate), so on a client this does nothing.
  const loop = new FixedStepLoop(TICK_MS, () => {
    game.fixedStep();
  });

  // Filled in when the `?perf` chunk arrives; stays null in normal play.
  let perfHud: PerfHud | null = null;

  const driver = new FrameDriver({
    loop,
    // Created once and called every frame: nothing in here may allocate.
    render: (alpha, frameMs) => {
      perfHud?.begin(frameMs);
      game.frame(alpha, frameMs);
      perfHud?.end();
    },
    // Hidden tab: no frames, but a client must keep telling the host it is still there.
    background: () => {
      game.background();
    },
  });

  driver.start();

  // The other side should hear a goodbye, not a timeout: the host tells its clients the room
  // is gone, a client lets go of its link (its seat is held for a reload).
  window.addEventListener('pagehide', () => {
    game.shutdown();
  });

  if (import.meta.env.DEV || flags.debug) {
    const hook: DebugHook = { game, report: () => game.report() };
    Reflect.set(window, '__dragonfall', hook);
  }

  // Not awaited: the game must not wait for (or die with) a dev-only chunk. loadDevTools
  // already turns a tool whose chunk failed into null; the handler below is for anything else.
  loadDevTools(
    flags,
    {
      renderer,
      app: game.app,
      getSimMs: () => game.getSimMs(),
      getNetText: () => game.getNetText(),
    },
    netsim,
  ).then(
    (dev) => {
      perfHud = dev.perfHud;
    },
    (error: unknown) => {
      console.warn('Dev tools failed to load', error);
    },
  );
}

boot();
