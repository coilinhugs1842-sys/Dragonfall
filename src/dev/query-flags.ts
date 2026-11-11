/**
 * Dev/test switches read from the page URL (`?perf`, `?debug`, `?bench`, `?quality=low`).
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

/** Pure: takes `location.search` (with or without the leading `?`) so it is testable in node. */
export function parseQueryFlags(search: string): QueryFlags {
  const params = new URLSearchParams(search);
  const quality = params.get('quality')?.trim().toLowerCase();
  return {
    perf: isOn(params, 'perf'),
    debug: isOn(params, 'debug'),
    bench: isOn(params, 'bench'),
    quality: isQualityPresetId(quality) ? quality : null,
  };
}

let cached: QueryFlags | null = null;

/** Flags of the current page, parsed once. All off where there is no `location` (node, workers). */
export function getQueryFlags(): QueryFlags {
  cached ??= parseQueryFlags(typeof location === 'undefined' ? '' : location.search);
  return cached;
}
