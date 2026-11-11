/**
 * The static-import-safe entry to the dev tools. main.ts imports THIS file (and ./query-flags);
 * stats-gl, lil-gui and the netsim stay in their own chunks, fetched only when `?perf` /
 * `?debug` / `?netsim` is in the URL. Normal play downloads and runs none of it.
 *
 * Only `import type` may point at ./perf-hud, ./debug-gui and ./netsim from here: a value import
 * would drag them (and both libraries) into the main chunk.
 */
import type { App } from '../game/app';
import type { GameRenderer } from '../render';
import type { DebugGui } from './debug-gui';
import type { Netsim } from './netsim';
import type { PerfHud } from './perf-hud';
import type { QueryFlags } from './query-flags';

export interface DevToolsOptions {
  renderer: GameRenderer;
  app?: App;
  getSimMs?: () => number;
  /** See `PerfHudOptions.getNetText`. */
  getNetText?: () => string;
  /** See `PerfHudOptions.getFxText`. */
  getFxText?: () => string;
  /** Mount point of the perf HUD. Defaults to `#ui`. */
  parent?: HTMLElement;
}

export interface DevTools {
  /** Null unless `?perf`. The frame loop calls `perfHud?.begin(frameMs)` / `perfHud?.end()`. */
  readonly perfHud: PerfHud | null;
  /** Null unless `?debug`. */
  readonly debugGui: DebugGui | null;
  dispose(): void;
}

const NO_DEV_TOOLS: DevTools = { perfHud: null, debugGui: null, dispose() {} };

function toolFailed(name: string): (error: unknown) => null {
  return (error) => {
    console.warn(`${name} failed to load`, error);
    return null;
  };
}

/**
 * `?netsim=<profile>` (and `?debug`, so the panel has sliders to move): the artificial-network
 * wrapper for this page's transport. Resolves with null, and fetches nothing, without either
 * flag; also null when the chunk fails to load (the game then plays on the real network).
 * `now` is the game's millisecond clock.
 */
export function loadNetsim(
  flags: Pick<QueryFlags, 'netsim' | 'debug'>,
  now: () => number,
): Promise<Netsim | null> {
  if (flags.netsim === null && !flags.debug) return Promise.resolve(null);
  return import('./netsim')
    .then((m) => m.createNetsim({ profile: flags.netsim ?? m.NETSIM_PROFILES.off, now }))
    .catch(toolFailed('Netsim'));
}

/**
 * Resolves with no network request when neither flag is set. Never rejects because a tool's
 * chunk failed: that tool is null and the other one still works. `netsim` (from `loadNetsim`)
 * gets its sliders in the debug panel.
 */
export async function loadDevTools(
  flags: Pick<QueryFlags, 'perf' | 'debug'>,
  opts: DevToolsOptions,
  netsim: Promise<Netsim | null> = Promise.resolve(null),
): Promise<DevTools> {
  if (!flags.perf && !flags.debug) return NO_DEV_TOOLS;

  // Each tool fails on its own (stale deploy, offline): one missing chunk must not orphan the
  // other tool, which by then is mounted on the page with nothing left to drive or dispose it.
  const [perfHud, debugGui] = await Promise.all([
    flags.perf
      ? import('./perf-hud').then((m) => m.createPerfHud(opts)).catch(toolFailed('Perf HUD'))
      : null,
    flags.debug
      ? import('./debug-gui').then((m) => m.createDebugGui(opts)).catch(toolFailed('Debug GUI'))
      : null,
  ]);

  if (debugGui !== null) {
    const shaper = await netsim;
    if (shaper !== null) {
      await import('./netsim')
        .then((m) => m.addNetsimFolder(debugGui, shaper))
        .catch(toolFailed('Netsim panel'));
    }
  }

  return {
    perfHud,
    debugGui,
    dispose(): void {
      perfHud?.dispose();
      debugGui?.dispose();
    },
  };
}
