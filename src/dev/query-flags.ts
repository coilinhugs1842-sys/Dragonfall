/**
 * Dev/test switches read from the page URL (`?perf`, `?debug`, `?bench`, `?autopilot`, `?skip=20`,
 * `?quality=low`, `?netsim=bad`, `?bots=8`, `?lan`, `?solo`, `?autostart`, `?noworker`, and the
 * match set-up switches `?mode=duel`, `?score=5`, `?time=0`, `?teamsize=2`, `?botlevel=hard`,
 * `?fill`, `?lagcomp=0`, `?join=CODE`), and `?viewer=dragon:<class>` for the asset viewer.
 * This module is deliberately tiny and dependency-free (shared types and the pure netsim profile
 * table only): main.ts imports it statically to decide whether the heavy dev chunks (stats-gl,
 * lil-gui) get fetched at all.
 */
import { MAX_CLIENT_RIDERS } from '../shared/constants';
import { isBotDifficulty } from '../shared/lobby';
import type { BotDifficulty } from '../shared/lobby';
import { MODES } from '../shared/match';
import type { ModeId } from '../shared/match';
import { isQualityPresetId } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';
import { parseNetsimProfile } from './netsim/profile';
import type { NetsimProfile } from './netsim/profile';

export interface QueryFlags {
  /** `?perf`: show the performance HUD (docs/PERFORMANCE.md "How we measure"). */
  readonly perf: boolean;
  /** `?debug`: show the lil-gui debug panel. */
  readonly debug: boolean;
  /**
   * `?bench`: host a 5v5 bot Skirmish, fly the fixed camera path and print a summary
   * (docs/PERFORMANCE.md, "How we measure"; src/dev/bench.ts).
   */
  readonly bench: boolean;
  /** `?bench=20`: seconds measured (after the warm-up). A bare `?bench` is 60. */
  readonly benchSeconds: number;
  /**
   * `?autopilot`: a scripted pilot flies the local dragon instead of the mouse and keyboard, so
   * headless screenshots and soak tests show real flight without pointer lock.
   */
  readonly autopilot: boolean;
  /**
   * `?autopilot=bot`: the local dragon is flown by a fighting bot instead of the scripted
   * circle. On a host that is the bot brain of the slot-fill bots (so a whole match can be
   * played headless); on a client a simple pursue-and-fire pilot working from what the client
   * sees. Implies `autopilot`.
   */
  readonly autopilotBot: boolean;
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
  /** `?mode=skirmish|duel`: the host's room starts in this mode. Null = the lobby default. */
  readonly mode: ModeId | null;
  /** `?score=N`: score limit of the host's room (clamped by the lobby). 0 = the default. */
  readonly scoreLimit: number;
  /** `?time=S`: time limit in seconds; `?time=0` = none. -1 = not in the URL. */
  readonly timeLimitS: number;
  /** `?teamsize=N`: riders per side. 0 = not in the URL. */
  readonly teamSize: number;
  /** `?botlevel=easy|normal|hard`. Null = the lobby default. */
  readonly botLevel: BotDifficulty | null;
  /** `?fill`: with `?autostart`, seat a host-flown bot in every empty team slot. */
  readonly fillBots: boolean;
  /** `?lagcomp=0`: the host tests hits against current positions (A/B tests). Default on. */
  readonly lagCompensation: boolean;
  /** `?join=CODE`: skip the title and join this room at once (two-page tests). '' = off. */
  readonly joinCode: string;
  /**
   * `?viewer=dragon:<class>`: open a dev viewer instead of the game (src/dev/dragon-viewer.ts).
   * Lower-cased; '' = off.
   */
  readonly viewer: string;
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

export const DEFAULT_BENCH_SECONDS = 60;
const MIN_BENCH_SECONDS = 5;

/** `?bench` / `?bench=1` = the default length; `?bench=20` = 20 s; off = 0. */
function parseBenchSeconds(params: URLSearchParams): number {
  if (!isOn(params, 'bench')) return 0;
  const seconds = Number(params.get('bench'));
  if (!(seconds > 1)) return DEFAULT_BENCH_SECONDS;
  if (seconds < MIN_BENCH_SECONDS) return MIN_BENCH_SECONDS;
  return seconds < MAX_SKIP_SECONDS ? seconds : MAX_SKIP_SECONDS;
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

/** A whole number in [min, max], else `fallback`. */
function parseWhole(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || value.trim() === '') return fallback;
  const number = Math.floor(Number(value));
  if (!(number >= min)) return fallback;
  return number < max ? number : max;
}

const FLAG_MODE_IDS: readonly ModeId[] = ['skirmish', 'duel', 'emberRelay', 'skyCrown'];

function parseMode(value: string | null): ModeId | null {
  if (value === null) return null;
  const lower = value.trim().toLowerCase();
  for (const id of FLAG_MODE_IDS) {
    if (id.toLowerCase() === lower && MODES[id].available) return id;
  }
  return null;
}

/** Pure: takes `location.search` (with or without the leading `?`) so it is testable in node. */
export function parseQueryFlags(search: string): QueryFlags {
  const params = new URLSearchParams(search);
  const quality = params.get('quality')?.trim().toLowerCase();
  const botLevel = params.get('botlevel')?.trim().toLowerCase();
  const autopilotBot = params.get('autopilot')?.trim().toLowerCase() === 'bot';
  return {
    perf: isOn(params, 'perf'),
    debug: isOn(params, 'debug'),
    bench: isOn(params, 'bench'),
    benchSeconds: parseBenchSeconds(params),
    autopilot: isOn(params, 'autopilot'),
    autopilotBot,
    skipSeconds: parseSeconds(params.get('skip'), MAX_SKIP_SECONDS),
    quality: isQualityPresetId(quality) ? quality : null,
    netsim: parseNetsimProfile(params.get('netsim')),
    bots: parseBots(params.get('bots')),
    lan: isOn(params, 'lan'),
    solo: isOn(params, 'solo'),
    autostart: isOn(params, 'autostart'),
    noWorker: isOn(params, 'noworker'),
    mode: parseMode(params.get('mode')),
    scoreLimit: parseWhole(params.get('score'), 1, 1000, 0),
    timeLimitS: parseWhole(params.get('time'), 0, 24 * 3600, -1),
    teamSize: parseWhole(params.get('teamsize'), 1, 5, 0),
    botLevel: isBotDifficulty(botLevel) ? botLevel : null,
    fillBots: isOn(params, 'fill'),
    lagCompensation: params.get('lagcomp') === null || isOn(params, 'lagcomp'),
    joinCode: (params.get('join') ?? '').trim().toUpperCase().slice(0, 12),
    viewer: (params.get('viewer') ?? '').trim().toLowerCase().slice(0, 32),
  };
}

let cached: QueryFlags | null = null;

/** Flags of the current page, parsed once. All off where there is no `location` (node, workers). */
export function getQueryFlags(): QueryFlags {
  cached ??= parseQueryFlags(typeof location === 'undefined' ? '' : location.search);
  return cached;
}
