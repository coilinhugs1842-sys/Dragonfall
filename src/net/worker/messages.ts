/**
 * The object side of the main <-> host-worker protocol: the few messages that are rare (setup,
 * lobby changes, the host's own menu clicks, opening the room) and therefore simply
 * structured-cloned. Everything per tick or per packet is a binary batch (`batch.ts`).
 *
 * Order matters between the two kinds (a link must exist before its first packet), so whoever
 * posts an object message flushes its pending batch first.
 */

import type { LobbyState, MatchPhase, PlayerId, UiIntent } from '../../shared';
import type { HostAutoSettings } from './host-core';
import type { StartBlocker } from '../../sim/lobby';
import type { HostSessionState } from '../session';
import type { TransportError } from '../transport';
import type { BatchMessage } from './batch';

/** The circle `?autopilot` flies. */
export interface WorkerPilotCourse {
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  readonly altitude: number;
}

/** What the page tells the worker once, before anything else. Plain data: it is cloned. */
export interface HostWorkerConfig {
  readonly kind: 'host' | 'solo';
  readonly hostName: string;
  /** The page holds a real transport for this room (false: solo, in-worker only). */
  readonly hasTransport: boolean;
  readonly bots: number;
  readonly botSeed?: number;
  readonly autoStart: boolean;
  readonly skipTicks: number;
  readonly mapSeed?: number;
  /** Measure per-tick cost. */
  readonly measure: boolean;
  /** `?autopilot`: the worker flies the host's dragon itself; the page sends no input. */
  readonly autopilot: WorkerPilotCourse | null;
  /** `?autopilot=bot`: the host's own dragon is flown by a bot brain in the worker. */
  readonly localBot: boolean;
  /** False: hits are tested against current positions (`?lagcomp=0`). */
  readonly lagCompensation: boolean;
  /** The page has views that want the match's GameEvents. */
  readonly wantEvents: boolean;
  /** Host settings applied when the room opens (`?mode=`, `?score=`, ...). */
  readonly autoSettings: HostAutoSettings | null;
  /** False: no lobby launch delay and no `intro` phase (`HostSessionOptions.cinematics`). */
  readonly cinematics: boolean;
  /** Tests: a fixed room code and fixed lengths for the timeline. */
  readonly roomCode?: string;
  readonly countdownTicks?: number;
  readonly introTicks?: number;
  readonly launchTicks?: number;
}

/** The slow-changing state of the room, sent whenever any of it changed. */
export interface HostMeta {
  readonly state: HostSessionState;
  readonly error: TransportError | null;
  readonly roomCode: string;
  readonly lobby: LobbyState;
  readonly localPlayerId: PlayerId;
  readonly hostTick: number;
  readonly inMatch: boolean;
  readonly matchPhase: MatchPhase;
  readonly startBlocker: StartBlocker | null;
  /** `HostSession.canSkipIntro`: the host may skip the running intro. */
  readonly canSkipIntro: boolean;
}

export type ToWorkerMessage =
  | { readonly t: 'init'; readonly config: HostWorkerConfig }
  | { readonly t: 'open' }
  | { readonly t: 'intent'; readonly intent: UiIntent }
  | { readonly t: 'endMatch' }
  /** The host asks to skip the intro (`HostSession.requestSkipIntro`). */
  | { readonly t: 'skipIntro'; readonly force: boolean }
  /** The real transport registered the room. */
  | { readonly t: 'transportOpen'; readonly roomCode: string }
  | { readonly t: 'transportError'; readonly error: TransportError }
  | { readonly t: 'close' }
  | BatchMessage;

export type FromWorkerMessage =
  /** The worker script loaded and built its host. */
  | { readonly t: 'ready' }
  | { readonly t: 'meta'; readonly meta: HostMeta }
  /** Ask the page's real transport to register the room under this code. */
  | { readonly t: 'transportOpen'; readonly roomCode: string }
  /** The session let go of the transport (the room closed itself). */
  | { readonly t: 'transportDispose' }
  /** The worker cannot go on. */
  | { readonly t: 'failed'; readonly message: string }
  | BatchMessage;

/** Size of the fixed part of a REC_STATS payload; `3 * pingCount` bytes of pings follow. */
export const STATS_FIXED_BYTES = 64;
/** The worker sends its stats this often; it doubles as its heartbeat. */
export const WORKER_STATS_INTERVAL_MS = 250;
/** The page answers the worker at least this often, so the worker knows the page is alive. */
export const PAGE_KEEPALIVE_MS = 200;
/**
 * The page has been silent this long: its main thread is stalled (a breakpoint, a very long
 * task). The worker stops ticking and freezes the session clock until the page is back, which
 * is what a stalled main-thread host does too: no packets can come in or go out meanwhile, so
 * simulating on would only fly every dragon without input.
 */
export const PAGE_STALL_MS = 1000;
/** Ticks the worker holds the host player's last input sample before treating the seat as away. */
export const INPUT_HOLD_TICKS = 15;
/**
 * Size of a REC_INPUT payload: f32 steerX, f32 steerY, u16 buttons, u16 pad, f64 sampledAtMs,
 * f32 aimYaw, f32 aimPitch.
 */
export const INPUT_RECORD_BYTES = 28;
