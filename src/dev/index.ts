/**
 * Full dev-tools barrel. It pulls in stats-gl AND lil-gui, so game code must never import it
 * statically: either `await import('./dev')` behind a flag check, or (preferred) use
 * `loadDevTools` from './dev/boot', which fetches each tool's chunk only for its own flag.
 */

export { loadDevTools } from './boot';
export type { DevTools, DevToolsOptions } from './boot';
export { createDebugGui } from './debug-gui';
export type { DebugGui, DebugGuiOptions } from './debug-gui';
export { DEFAULT_FRAME_WINDOW, FrameStats, createFrameStatsSummary } from './frame-stats';
export type { FrameStatsSummary } from './frame-stats';
export { createPerfHud } from './perf-hud';
export type { PerfHud, PerfHudOptions } from './perf-hud';
export { getQueryFlags, parseQueryFlags } from './query-flags';
export type { QueryFlags } from './query-flags';
