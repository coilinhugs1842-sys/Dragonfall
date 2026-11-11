/**
 * Dev/test switches read from the page URL (`?perf`, `?debug`, `?bench`, `?autopilot`, `?skip=20`,
 * `?quality=low`).
 * This module is deliberately tiny and dependency-free (shared types only): main.ts imports it
 * statically to decide whether the heavy dev chunks (stats-gl, lil-gui) get fetched at all.
 */
import { isQualityPresetId } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';

export interface QueryFlags {
  /** `?perf`: show the performance HUD (docs/PERFORMANCE.md "How we measure"). */
  readonly perf: boolean;
  /** `?debug`: show the lil-gui debug panel. */
  readonly debug: boolean;
  /** `?bench`: run the fixed benchmark flight and print a summary. */
  readonly bench: boolean;
  /**
   * `?autopilot`: a scripted pilot flies the local dragon instead of the mouse and keyboard, so
   * headless screenshots and soak tests show real flight without pointer lock.
   */
  readonly autopilot: boolean;
  /**
   * `?skip=<seconds>`: the flight sandbox starts that many seconds into the flight (the ticks
   * are simulated at load, not shown). With `?autopilot` this picks the moment a headless
   * screenshot shows. 0 = off; capped at MAX_SKIP_SECONDS.
   */
  readonly skipSeconds: number;
  /** `?quality=low|medium|high`: force a preset, skipping the automatic pick. Null = not forced. */
  readonly quality: QualityPresetId | null;
}

/** A bare `?perf` or `?perf=1` turns a flag on; `?perf=0|false|off|no` keeps it off. */
function isOn(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  if (value === null) return false;
  const v = value.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

export const MAX_SKIP_SECONDS = 600;

/** A plain non-negative number of seconds, else 0. */
function parseSeconds(value: string | null, max: number): number {
  if (value === null || value.trim() === '') return 0;
  const seconds = Number(value);
  if (!(seconds > 0)) return 0;
  return seconds < max ? seconds : max;
}

/** Pure: takes `location.search` (with or without the leading `?`) so it is testable in node. */
export function parseQueryFlags(search: string): QueryFlags {
  const params = new URLSearchParams(search);
  const quality = params.get('quality')?.trim().toLowerCase();
  return {
    perf: isOn(params, 'perf'),
    debug: isOn(params, 'debug'),
    bench: isOn(params, 'bench'),
    autopilot: isOn(params, 'autopilot'),
    skipSeconds: parseSeconds(params.get('skip'), MAX_SKIP_SECONDS),
    quality: isQualityPresetId(quality) ? quality : null,
  };
}

let cached: QueryFlags | null = null;

/** Flags of the current page, parsed once. All off where there is no `location` (node, workers). */
export function getQueryFlags(): QueryFlags {
  cached ??= parseQueryFlags(typeof location === 'undefined' ? '' : location.search);
  return cached;
}
