/**
 * The static-import-safe entry to the dev tools. main.ts imports THIS file (and ./query-flags);
 * stats-gl and lil-gui stay in their own chunks, fetched only when `?perf` / `?debug` is in the
 * URL. Normal play downloads and runs none of it.
 *
 * Only `import type` may point at ./perf-hud and ./debug-gui from here: a value import would
 * drag both libraries into the main chunk.
 */
import type { App } from '../game/app';
import type { GameRenderer } from '../render';
import type { DebugGui } from './debug-gui';
import type { PerfHud } from './perf-hud';
import type { QueryFlags } from './query-flags';

export interface DevToolsOptions {
  renderer: GameRenderer;
  app?: App;
  getSimMs?: () => number;
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
 * Resolves with no network request when neither flag is set. Never rejects because a tool's
 * chunk failed: that tool is null and the other one still works.
 */
export async function loadDevTools(
  flags: Pick<QueryFlags, 'perf' | 'debug'>,
  opts: DevToolsOptions,
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

  return {
    perfHud,
    debugGui,
    dispose(): void {
      perfHud?.dispose();
      debugGui?.dispose();
    },
  };
}
