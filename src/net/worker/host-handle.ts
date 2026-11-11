/**
 * `HostHandle`: the ONE interface `src/game` hosts a room through. Two implementations sit
 * behind it and the game layer cannot tell them apart:
 *
 * - `DirectHost` (this file): the `HostCore` runs on the page's main thread, ticked by the
 *   frame driver's fixed loop. The fallback path (`?noworker`, no Worker support, a worker that
 *   failed to start), and what the node tests compare the worker path against.
 * - `WorkerHost` (`worker-host.ts`): the `HostCore` runs in a dedicated Web Worker with its own
 *   30 Hz timer; the page keeps the WebRTC transport and a mirror of the state it draws.
 *
 * Everything the game reads is a plain property that is cheap to read every frame. Per frame
 * the game calls `update(nowMs)` once, `fixedStep()` from its fixed loop (a no-op when a worker
 * owns the clock) and `viewAlpha()` to blend `prev` -> `current`.
 */

import type { LobbyState, MatchPhase, PlayerId, UiIntent } from '../../shared';
import type { StartBlocker } from '../../sim/lobby';
import type { HostSessionState } from '../session';
import type {
  Channel,
  DisconnectReason,
  HostTransport,
  HostTransportHandlers,
  LinkId,
  TransportError,
  TransportMessage,
  TransportPayload,
  TransportState,
} from '../transport';
import { NOOP_HOST_HANDLERS } from '../transport';
import { HostCore } from './host-core';
import type { HostCoreOptions } from './host-core';
import type { HostViewState } from './view-state';

/**
 * Cost and health figures, rewritten in place (read them for the perf HUD and the test driver).
 * Times are milliseconds unless the name says otherwise. The `worker*`, `input*`, `posted*`,
 * `arrival*`, `viewExtrapolated*` and `viewStarved*` groups stay 0 on the direct path.
 */
export interface HostMetrics {
  /** Smoothed cost of one tick inside the session (inputs + sim + snapshots), wherever it runs. */
  stepMs: number;
  simMs: number;
  snapshotMs: number;
  maxStepMs: number;
  /** Ticks the session has run. */
  ticks: number;
  sentBytesPerS: number;
  receivedBytesPerS: number;
  /** Messages the host dropped unread. */
  malformed: number;
  /**
   * Total main-thread time spent in host sim + net code since the handle was made: `update`,
   * `fixedStep`, the transport callbacks and (worker path) the worker's message handler. Only
   * counted with a profile clock.
   */
  mainMs: number;
  /** Whole worker pulse (ticks, bots, state encode, posting): smoothed and worst. */
  workerPulseMs: number;
  workerPulseMaxMs: number;
  /** How late the worker's timer ran a tick against its schedule: smoothed and worst. */
  workerLateMs: number;
  workerLateMaxMs: number;
  /** Age of the host player's newest input sample when its tick ran: smoothed and worst. */
  inputAgeMs: number;
  inputAgeMaxMs: number;
  /** Ticks that ran with no fresh input sample from the page (the last one was held). */
  inputHeldTicks: number;
  /** Bytes and messages through `postMessage`, page -> worker and worker -> page, totals. */
  postedBytesUp: number;
  postedBytesDown: number;
  postedMessagesUp: number;
  postedMessagesDown: number;
  /** A state's arrival on the page against its tick's due time: smoothed and worst. */
  arrivalLateMs: number;
  arrivalLateMaxMs: number;
  /**
   * Frames drawn; frames that blended past the newest state because the next one was late (and
   * the furthest that went, ms); frames that ran out of that allowance and held still.
   */
  viewFrames: number;
  viewExtrapolatedFrames: number;
  viewExtrapolatedMaxMs: number;
  viewStarvedFrames: number;
  /** Pool buffers created on the page side (a steady number = the ping-pong works). */
  buffersAllocated: number;
}

export function createHostMetrics(): HostMetrics {
  return {
    stepMs: 0,
    simMs: 0,
    snapshotMs: 0,
    maxStepMs: 0,
    ticks: 0,
    sentBytesPerS: 0,
    receivedBytesPerS: 0,
    malformed: 0,
    mainMs: 0,
    workerPulseMs: 0,
    workerPulseMaxMs: 0,
    workerLateMs: 0,
    workerLateMaxMs: 0,
    inputAgeMs: 0,
    inputAgeMaxMs: 0,
    inputHeldTicks: 0,
    postedBytesUp: 0,
    postedBytesDown: 0,
    postedMessagesUp: 0,
    postedMessagesDown: 0,
    arrivalLateMs: 0,
    arrivalLateMaxMs: 0,
    viewFrames: 0,
    viewExtrapolatedFrames: 0,
    viewExtrapolatedMaxMs: 0,
    viewStarvedFrames: 0,
    buffersAllocated: 0,
  };
}

export interface HostHandle {
  /** Where the sim runs. */
  readonly mode: 'direct' | 'worker';
  readonly state: HostSessionState;
  /** The last transport error (a fatal one closed the room). */
  readonly error: TransportError | null;
  /** '' until the room is registered. */
  readonly roomCode: string;
  /** Replaced, never mutated. Null until the room has one to show. */
  readonly lobby: LobbyState | null;
  readonly localPlayerId: PlayerId;
  /** The tick of the newest state the page holds. */
  readonly hostTick: number;
  readonly inMatch: boolean;
  /** `lobby` outside a match. */
  readonly matchPhase: MatchPhase;
  readonly phaseTimeS: number;
  /** The host's own player has a dragon. */
  readonly localIsRider: boolean;
  /** The two newest authoritative states; null outside a match or before the first one. */
  readonly prev: Readonly<HostViewState> | null;
  readonly current: Readonly<HostViewState> | null;
  /** Why Start is unavailable, or null when the host may start. */
  readonly startBlocker: StartBlocker | null;
  /** Round trip per player in ms, indexed by PlayerId; -1 = unknown. Mutated in place. */
  readonly playerPings: readonly number[];
  /** Links that completed the handshake (real players and bots). */
  readonly clientCount: number;
  readonly botCount: number;
  readonly botsConnected: number;
  /** The host player's latest steer, for the camera's look-ahead. */
  readonly aimX: number;
  readonly aimY: number;
  readonly metrics: Readonly<HostMetrics>;

  /** Registers the room. Answers through `state` (`open`, or `closed` with `error`). */
  open(): void;
  /** Ends the room: every client is told HOST_LEFT. Final, synchronous, safe in `pagehide`. */
  close(): void;
  /** A lobby or host-panel intent of the host's own UI. */
  applyIntent(intent: UiIntent): void;
  /** Ends the running match and takes everyone back to the lobby. */
  endMatch(): void;
  /** Once per rendered frame. `nowMs` is the page's monotonic clock. */
  update(nowMs: number): void;
  /** Once per fixed 30 Hz step of the page's loop. Does nothing when a worker owns the ticks. */
  fixedStep(): void;
  /**
   * The blend factor for `prev` -> `current` this frame. `loopAlpha` is the page's fixed-loop
   * fraction (used as it is on the direct path). A worker host returns a little more than 1
   * while its next state is late (at most `1 + VIEW_EXTRAPOLATE_TICKS`).
   */
  viewAlpha(loopAlpha: number, nowMs: number): number;
}

/** A re-entrant stopwatch: nested brackets count once. */
export class WorkMeter {
  totalMs = 0;
  private depth = 0;
  private startMs = 0;

  constructor(private readonly clock: (() => number) | null) {}

  enter(): void {
    if (this.clock !== null && this.depth++ === 0) this.startMs = this.clock();
  }

  exit(): void {
    if (this.clock !== null && --this.depth === 0) this.totalMs += this.clock() - this.startMs;
  }
}

/**
 * Passes a transport through unchanged while timing its callbacks into a `WorkMeter`, so the
 * host's work in data-channel tasks (between frames) is part of `metrics.mainMs`.
 */
export class MeteredHostTransport implements HostTransport {
  private handlers: HostTransportHandlers = NOOP_HOST_HANDLERS;

  constructor(
    private readonly inner: HostTransport,
    meter: WorkMeter,
  ) {
    inner.setHandlers({
      onOpen: (roomCode: string): void => {
        meter.enter();
        this.handlers.onOpen(roomCode);
        meter.exit();
      },
      onError: (error: TransportError): void => {
        meter.enter();
        this.handlers.onError(error);
        meter.exit();
      },
      onPeerConnected: (link: LinkId): void => {
        meter.enter();
        this.handlers.onPeerConnected(link);
        meter.exit();
      },
      onPeerDisconnected: (link: LinkId, reason: DisconnectReason): void => {
        meter.enter();
        this.handlers.onPeerDisconnected(link, reason);
        meter.exit();
      },
      onMessage: (link: LinkId, channel: Channel, data: TransportMessage): void => {
        meter.enter();
        this.handlers.onMessage(link, channel, data);
        meter.exit();
      },
    });
  }

  get state(): TransportState {
    return this.inner.state;
  }

  get roomCode(): string {
    return this.inner.roomCode;
  }

  setHandlers(handlers: HostTransportHandlers): void {
    this.handlers = handlers;
  }

  open(roomCode: string): void {
    this.inner.open(roomCode);
  }

  send(link: LinkId, channel: Channel, data: TransportPayload): boolean {
    return this.inner.send(link, channel, data);
  }

  close(link: LinkId): void {
    this.inner.close(link);
  }

  dispose(): void {
    this.handlers = NOOP_HOST_HANDLERS;
    this.inner.dispose();
  }
}

/** The host on the page's main thread. */
export class DirectHost implements HostHandle {
  readonly mode = 'direct';
  readonly core: HostCore;
  readonly metrics: HostMetrics = createHostMetrics();
  private readonly meter: WorkMeter;

  constructor(options: HostCoreOptions) {
    const meter = new WorkMeter(options.profileClock ?? null);
    this.meter = meter;
    const transport =
      options.transport !== null && options.profileClock !== undefined
        ? new MeteredHostTransport(options.transport, meter)
        : options.transport;
    this.core = new HostCore({ ...options, transport });
  }

  get state(): HostSessionState {
    return this.core.session.state;
  }

  get error(): TransportError | null {
    return this.core.session.error;
  }

  get roomCode(): string {
    return this.core.session.roomCode;
  }

  get lobby(): LobbyState {
    return this.core.session.lobby;
  }

  get localPlayerId(): PlayerId {
    return this.core.session.localPlayerId;
  }

  get hostTick(): number {
    return this.core.session.hostTick;
  }

  get inMatch(): boolean {
    return this.core.session.inMatch;
  }

  get matchPhase(): MatchPhase {
    return this.core.session.matchPhase;
  }

  get phaseTimeS(): number {
    return this.core.session.matchClock.phaseTimeS;
  }

  get localIsRider(): boolean {
    return this.core.localIsRider;
  }

  get prev(): Readonly<HostViewState> | null {
    return this.core.session.sim?.prev ?? null;
  }

  get current(): Readonly<HostViewState> | null {
    return this.core.session.sim?.current ?? null;
  }

  get startBlocker(): StartBlocker | null {
    const session = this.core.session;
    return session.state === 'open' ? session.startBlocker() : null;
  }

  get playerPings(): readonly number[] {
    return this.core.session.playerPings;
  }

  get clientCount(): number {
    return this.core.session.clientCount;
  }

  get botCount(): number {
    return this.core.bots?.count ?? 0;
  }

  get botsConnected(): number {
    return this.core.bots?.connectedCount ?? 0;
  }

  get aimX(): number {
    return this.core.aimX;
  }

  get aimY(): number {
    return this.core.aimY;
  }

  open(): void {
    this.core.open();
  }

  close(): void {
    this.core.close();
  }

  applyIntent(intent: UiIntent): void {
    this.core.session.applyIntent(intent);
  }

  endMatch(): void {
    this.core.session.endMatch();
  }

  update(nowMs: number): void {
    this.meter.enter();
    this.core.update(nowMs);
    this.meter.exit();
    this.refreshMetrics();
  }

  fixedStep(): void {
    this.meter.enter();
    this.core.tick();
    this.meter.exit();
  }

  viewAlpha(loopAlpha: number, _nowMs: number): number {
    this.metrics.viewFrames++;
    return loopAlpha;
  }

  private refreshMetrics(): void {
    const core = this.core;
    const session = core.session;
    const metrics = this.metrics;
    metrics.stepMs = core.stepMs;
    metrics.simMs = core.simMs;
    metrics.snapshotMs = core.snapshotMs;
    metrics.maxStepMs = session.timing.maxTotalUs / 1000;
    metrics.ticks = session.hostTick;
    metrics.sentBytesPerS = session.stats.sentBytesPerS;
    metrics.receivedBytesPerS = session.stats.receivedBytesPerS;
    metrics.malformed = session.counters.malformed;
    metrics.mainMs = this.meter.totalMs;
  }
}
