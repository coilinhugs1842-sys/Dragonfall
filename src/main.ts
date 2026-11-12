/**
 * Boot: create the one renderer, the game controller (title -> lobby -> match, see
 * ./game/game.ts) and the frame driver.
 *
 * Only ./dev/query-flags and ./dev/boot may be imported from `dev` here. They are tiny; the
 * `./dev` barrel would pull stats-gl and lil-gui into the entry chunk. The netsim chunk and the
 * PeerJS chunk are fetched on demand (`?netsim` / `?debug`, and when the player hosts or joins).
 */
import './style.css';
import type { Bench } from './dev/bench';
import { loadDevTools, loadNetsim } from './dev/boot';
import type { PerfHud } from './dev/perf-hud';
import { getQueryFlags } from './dev/query-flags';
import type { QueryFlags } from './dev/query-flags';
import type { RecordRig } from './dev/record';
import { FrameDriver, createAutoQualityRun, createGame, readStoredQuality } from './game';
import type { AutoQualityReport, AutoQualityRun, Game } from './game';
import { WebGL2UnavailableError, createGameRenderer } from './render';
import type { GameRenderer } from './render';
import { DEFAULT_QUALITY, TICK_MS } from './shared';
import type { QualityPresetId } from './shared';
import { FixedStepLoop } from './sim';

/** What a dev build (and `?debug`) hangs on `window` for the console and the browser tests. */
interface DebugHook {
  readonly game: Game;
  /** For browser tests that draw something of their own with the page's renderer. */
  readonly renderer: GameRenderer;
  report(): unknown;
  /** The automatic quality pick: GPU name, what was measured, the console line (T-6.2). */
  readonly quality: AutoQualityReport;
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

/**
 * `?quality=` wins, then the saved setting (a preset chosen by hand, or what the automatic pick
 * chose), then the default: a first launch, where the automatic pick runs behind the title.
 */
function pickQuality(forced: QualityPresetId | null): QualityPresetId {
  return forced ?? readStoredQuality(storageOrNull('localStorage')) ?? DEFAULT_QUALITY;
}

/**
 * Why the automatic quality pick must not run on this page ('' = it may). The scripted pages
 * (`?bench`, `?autopilot`, `?record`) and a browser driven by a test tool start from an empty
 * profile every time and would look like a first launch; `?autoquality` asks for the test in a
 * driven browser, but never beats the other switches.
 */
function autoQualityBlocker(flags: QueryFlags, recording: boolean): string {
  if (flags.quality !== null) return 'forced by ?quality=';
  if (flags.bench) return '?bench';
  if (flags.autopilot) return '?autopilot';
  if (recording) return '?record';
  if (navigator.webdriver && !flags.autoQuality) return 'automated browser';
  return '';
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

/** `rig`: the `?record` clock and frame stepping (src/dev/record.ts); null in normal play. */
function boot(rig: RecordRig | null): void {
  const flags = getQueryFlags();
  const canvas = requireElement('game', HTMLCanvasElement);
  const renderer = createRendererOrFallback(canvas, pickQuality(flags.quality));
  if (renderer === null) return;

  // `?viewer=dragon:<class>`: a dev asset viewer takes the page instead of the game.
  if (flags.viewer.startsWith('dragon')) {
    void import('./dev/dragon-viewer').then((m) =>
      m.startDragonViewer({
        canvas,
        uiRoot: requireElement('ui', HTMLElement),
        renderer,
        spec: flags.viewer,
      }),
    );
    return;
  }
  // `?viewer=cine:<name>`: one cinematic piece on the real stage, without a room.
  if (flags.viewer.startsWith('cine')) {
    void import('./dev/cine-viewer').then((m) => {
      m.startCineViewer({
        canvas,
        uiRoot: requireElement('ui', HTMLElement),
        renderer,
        spec: flags.viewer,
        record: rig,
      });
    });
    return;
  }

  // `?viewer=ui:<screen>`: one UI screen with made-up state, over the plain backdrop.
  if (flags.viewer.startsWith('ui')) {
    void import('./dev/ui-preview').then((m) => {
      m.startUiPreview(
        requireElement('ui', HTMLElement),
        new URLSearchParams(window.location.search),
      );
    });
    return;
  }

  const now = rig !== null ? rig.now : (): number => performance.now();
  // Fetched only with `?netsim` or `?debug`; the game waits for it before its first transport.
  const netsim = loadNetsim(flags, now);

  // `?bench` is a whole set-up, not one switch: this page hosts a 5v5 Skirmish of bots that
  // cannot end (no score or time limit), a bot flies the local dragon, and the room starts by
  // itself. Explicit flags (`?mode=`, `?teamsize=`, `?botlevel=`) still win.
  const bench = flags.bench;
  // Made right after the game (it reads the game's settings); "Test again" reaches it by name.
  let autoQuality: AutoQualityRun | null = null;
  const game = createGame({
    onRetestQuality: () => autoQuality?.requestRetest(),
    canvas,
    uiRoot: requireElement('ui', HTMLElement),
    renderer,
    flags: {
      autopilot: flags.autopilot || bench,
      autopilotBot: flags.autopilotBot || bench,
      forcedQuality: flags.quality,
      autoSettings: {
        ...(bench
          ? { mode: 'skirmish' as const, teamSize: 5, scoreLimit: 200, timeLimitS: 0, fillBots: true }
          : {}),
        ...(flags.mode !== null ? { mode: flags.mode } : {}),
        ...(flags.map !== null ? { map: flags.map } : {}),
        ...(flags.teamSize > 0 ? { teamSize: flags.teamSize } : {}),
        ...(flags.scoreLimit > 0 ? { scoreLimit: flags.scoreLimit } : {}),
        ...(flags.timeLimitS >= 0 ? { timeLimitS: flags.timeLimitS } : {}),
        ...(flags.botLevel !== null ? { botDifficulty: flags.botLevel } : {}),
        ...(flags.fillBots ? { fillBots: true } : {}),
      },
      lagCompensation: flags.lagCompensation,
      joinCode: bench ? '' : flags.joinCode,
      skipSeconds: flags.skipSeconds,
      bots: flags.bots,
      lan: flags.lan,
      solo: flags.solo && !bench,
      autostart: flags.autostart || bench,
      // A recording steps the host's sim with its own frames: a worker would run on real time.
      noWorker: flags.noWorker || rig !== null,
      // The bench measures the fight, not the way into it.
      cinematics: !flags.noCinematics && !bench,
      measure: flags.perf || flags.debug || bench || import.meta.env.DEV,
    },
    storage: { local: storageOrNull('localStorage'), session: storageOrNull('sessionStorage') },
    pageHostname: window.location.hostname,
    now,
    shaper: netsim,
  });

  // The automatic quality pick (docs/PERFORMANCE.md): measures behind the title screen on a
  // first launch and saves what it picks as a setting. Also the one console line with the GPU.
  const quality = createAutoQualityRun({
    renderer,
    blocked: autoQualityBlocker(flags, rig !== null),
    force: flags.autoQuality,
    titleIdle: () => game.titleIdle,
    settings: () => game.settings,
    save: (patch) => {
      game.handleIntent({ type: 'settings.update', patch });
    },
    visible: () => document.visibilityState === 'visible',
    now,
    log: (line) => {
      console.info(line);
    },
    storage: storageOrNull('localStorage'),
  });
  autoQuality = quality;

  const applySize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.resize(width, height, window.devicePixelRatio);
    if (width > 0 && height > 0) game.setAspect(width / height);
    game.setViewportSize(width, height);
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
  // Filled in when the `?bench` chunk arrives.
  let benchRun: Bench | null = null;
  if (bench) {
    import('./dev/bench').then(
      (m) => {
        benchRun = m.createBench({
          renderer,
          seconds: flags.benchSeconds,
          focus: game.arenaFocus,
          inMatch: () => game.inMatch,
          getSimMs: () => game.getSimMs(),
          getPeaks: () => game.getPeaks(),
          setCameraDirector: (director) => {
            game.setDevCameraDirector(director);
          },
        });
      },
      (error: unknown) => {
        console.warn('Bench failed to load', error);
      },
    );
  }

  const driver = new FrameDriver({
    loop,
    // Created once and called every frame: nothing in here may allocate.
    render: (alpha, frameMs) => {
      perfHud?.begin(frameMs);
      game.frame(alpha, frameMs);
      perfHud?.end();
      quality.frame();
      benchRun?.frame(frameMs);
    },
    // The "30 / 45 fps" setting: callbacks it turns down neither step nor draw.
    shouldRender: (timeMs) => game.shouldRender(timeMs),
    // Hidden tab: no frames, but a client must keep telling the host it is still there.
    background: () => {
      game.background();
    },
    ...(rig !== null ? { host: rig.frameHost } : {}),
  });
  // The recorder holds its clock while a scene's shaders are still compiling.
  rig?.setBusyProbe(() => game.report().show.warming);

  driver.start();

  // The other side should hear a goodbye, not a timeout: the host tells its clients the room
  // is gone, a client lets go of its link (its seat is held for a reload).
  window.addEventListener('pagehide', () => {
    game.shutdown();
  });

  if (import.meta.env.DEV || flags.debug || rig !== null) {
    const hook: DebugHook = {
      game,
      renderer,
      report: () => game.report(),
      get quality() {
        return quality.report;
      },
    };
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
      getFxText: () => game.getFxText(),
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

// `?record`: the recorder's clock must exist before anything reads one, so its chunk comes first.
if (getQueryFlags().record) {
  void import('./dev/record').then((m) => {
    boot(m.createRecordRig());
  });
} else {
  boot(null);
}
