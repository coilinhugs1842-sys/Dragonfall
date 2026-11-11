/**
 * Dev/test switches read from the page URL (`?perf`, `?debug`, `?bench`, `?autopilot`, `?skip=20`,
 * `?quality=low`, `?netsim=bad`, `?bots=8`, `?lan`, `?solo`, `?autostart`, `?noworker`).
 * This module is deliberately tiny and dependency-free (shared types and the pure netsim profile
 * table only): main.ts imports it statically to decide whether the heavy dev chunks (stats-gl,
 * lil-gui) get fetched at all.
 */
import { MAX_CLIENT_RIDERS } from '../shared/constants';
import { isQualityPresetId } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';
import { parseNetsimProfile } from './netsim/profile';
import type { NetsimProfile } from './netsim/profile';

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
   * `?skip=<seconds>`: a `?solo` flight starts that many seconds in (the ticks are simulated
   * when the match starts, not shown). With `?autopilot` this picks the moment a headless
   * screenshot shows. 0 = off; capped at MAX_SKIP_SECONDS.
   */
  readonly skipSeconds: number;
  /** `?quality=low|medium|high`: force a preset, skipping the automatic pick. Null = not forced. */
  readonly quality: QualityPresetId | null;
  /**
   * `?netsim=bad` or `?netsim=80,20,2` (one-way ms, ± ms, loss %): artificial network conditions
   * for this page's transport (docs/NETWORKING.md, "Testing multiplayer alone"). A bare `?netsim`
   * is the standard `bad` profile. Null = not in the URL, or not understood.
   */
  readonly netsim: NetsimProfile | null;
  /**
   * `?bots=N`: the host spawns N in-page net-bots (fake clients on the loopback transport).
   * A whole number, 0 = none, capped at MAX_BOTS.
   */
  readonly bots: number;
  /**
   * `?lan`: use the PeerServer on the machine that served the page for signaling instead of the
   * public broker, so a LAN game needs no internet.
   */
  readonly lan: boolean;
  /**
   * `?solo`: skip the title and fly alone at once (the same code path as the title's "Fly solo":
   * a host session with no network). With `?autopilot` and `?skip` this is the headless
   * screenshot and soak-test entry.
   */
  readonly solo: boolean;
  /**
   * `?autostart`: skip the title, host a room, wait for the `?bots=N` bots to take their seats
   * and start the match at once. For load tests; real players can still join as watchers.
   */
  readonly autostart: boolean;
  /**
   * `?noworker`: the host runs its sim, snapshot encoding and bots on the main thread instead
   * of in the host worker (the fallback path, and the "before" of a worker measurement).
   */
  readonly noWorker: boolean;
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

/** Every seat that is not the host's can be a bot. */
export const MAX_BOTS = MAX_CLIENT_RIDERS;

/** A plain whole number of bots, else 0. `?bots=2.9` is 2. */
function parseBots(value: string | null): number {
  if (value === null || value.trim() === '') return 0;
  const count = Math.floor(Number(value));
  if (!(count > 0)) return 0;
  return count < MAX_BOTS ? count : MAX_BOTS;
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
    netsim: parseNetsimProfile(params.get('netsim')),
    bots: parseBots(params.get('bots')),
    lan: isOn(params, 'lan'),
    solo: isOn(params, 'solo'),
    autostart: isOn(params, 'autostart'),
    noWorker: isOn(params, 'noworker'),
  };
}

let cached: QueryFlags | null = null;

/** Flags of the current page, parsed once. All off where there is no `location` (node, workers). */
export function getQueryFlags(): QueryFlags {
  cached ??= parseQueryFlags(typeof location === 'undefined' ? '' : location.search);
  return cached;
}
