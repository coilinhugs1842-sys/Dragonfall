/**
 * `WorkerHost`: the page's side of a host that runs in a Web Worker. It keeps what cannot leave
 * the main thread (the WebRTC transport, the input devices) and a mirror of what the page shows
 * (lobby, room code, the two newest authoritative states), and moves everything else across:
 *
 *   transport callback --record--> pending batch --postMessage (transfer)--> worker
 *   worker tick --one batch: packets for every link + the view state--> transport.send / mirror
 *
 * WHEN THE PAGE POSTS. A `ctrl` message or a link event goes out at once (a PING answered a
 * frame late would inflate everybody's ping). `fast` packets (client inputs, 30 a second per
 * client) wait for the next `update()`, so a frame sends one batch however many arrived, along
 * with the host player's own input sample. When frames are not running (hidden tab) the page
 * instead answers each batch of the worker, which is not timer-driven and so is not throttled.
 *
 * THE HOST'S OWN VIEW. States are stamped with the time their tick was due on a clock both
 * threads share, and `viewAlpha` blends `prev` -> `current` by the page's own clock against
 * that stamp: the same picture the fixed loop's alpha gives on the direct path, without the two
 * threads' timers having to agree. When the next state is late (a timer or a busy thread) the
 * blend carries on past 1 for up to `VIEW_EXTRAPOLATE_TICKS`, which extrapolates along the last
 * tick's motion: a few milliseconds of that is millimetres off, where holding the old state
 * still would be a visible stutter.
 */

import { TICK_MS, createInputFrame } from '../../shared';
import type {
  GameEventSink,
  InputFrame,
  LobbyState,
  MatchPhase,
  MatchPlayerStats,
  MatchWinner,
  PlayerId,
  UiIntent,
} from '../../shared';
import type { StartBlocker } from '../../sim/lobby';
import { encodeHostLeft } from '../codec/ctrl';
import { decodeGameEvents } from '../codec/events';
import { Reader, Writer } from '../codec/io';
import { HOST_LEFT_BYTES, createNoticeMessage } from '../protocol';
import type { HostSessionState } from '../session';
import { createScoreTable, decodeScoreboard } from '../session/scores';
import { ViewCache } from '../session/wire';
import type { HostTransport, LinkId, TransportError } from '../transport';
import { NOOP_HOST_HANDLERS, transportError } from '../transport';
import {
  AUX_CTRL,
  AUX_FAST,
  AUX_REASON_LOCAL,
  AUX_REASON_LOST,
  AUX_REASON_REMOTE,
  BatchReader,
  BatchWriter,
  BufferPool,
  ExactBuffers,
  REC_CLOSE,
  REC_EVENTS,
  REC_INPUT,
  REC_KEEPALIVE,
  REC_PACKET,
  REC_PEER_GONE,
  REC_PEER_OPEN,
  REC_SCORES,
  REC_STATE,
  REC_STATS,
  REC_TEXT,
} from './batch';
import type { BatchMessage } from './batch';
import type { LocalInputSource } from './host-core';
import { WorkMeter, createHostMetrics } from './host-handle';
import type { HostHandle, HostMetrics } from './host-handle';
import { INPUT_RECORD_BYTES, PAGE_KEEPALIVE_MS } from './messages';
import type { FromWorkerMessage, HostMeta, HostWorkerConfig, ToWorkerMessage } from './messages';
import { createHostWorkerStats, decodeHostStats } from './stats-record';
import {
  createHostTickInfo,
  createHostViewState,
  decodeHostState,
  findViewDragon,
} from './view-state';
import type { HostTickInfo, HostViewState } from './view-state';

/** A worker that has not said `ready` after this long is given up on (fallback to direct). */
export const WORKER_START_TIMEOUT_MS = 5000;
/** A running worker that has been silent this long is dead (it reports every 250 ms). */
export const WORKER_SILENT_MS = 5000;
/** No `update()` for this long: frames are not running, so batches ride on the worker's ticks. */
const FRAMES_STOPPED_MS = 50;
/** How far past the newest state the view may blend before it holds still, in ticks. */
export const VIEW_EXTRAPOLATE_TICKS = 0.5;
const METRIC_SMOOTHING = 0.05;
const PLAYER_SLOTS = 256;

/** The slice of a `Worker` this side needs; tests pass an in-memory one. */
export interface WorkerLike {
  post(message: ToWorkerMessage, transfer: ArrayBuffer[]): void;
  /** Registers the two listeners (once). `onError` = the worker script failed or threw. */
  listen(onMessage: (message: FromWorkerMessage) => void, onError: (message: string) => void): void;
  terminate(): void;
}

export interface WorkerHostOptions {
  readonly worker: WorkerLike;
  /** The room's real transport; null for a solo room (nothing leaves the worker). */
  readonly transport: HostTransport | null;
  readonly config: HostWorkerConfig;
  /** The page's monotonic clock: the one `update(nowMs)` is given. */
  readonly now: () => number;
  /** A clock the worker shares (`performance.timeOrigin + performance.now()`). */
  readonly epochNow: () => number;
  /** Times this side's work into `metrics.mainMs`. */
  readonly profileClock?: () => number;
  /** Samples the host player's input once per frame (unused when the worker has the autopilot). */
  readonly localInput?: LocalInputSource | null;
  /** The match's GameEvents, decoded from the worker's batches (the host's own views). */
  readonly events?: GameEventSink | null;
  /** Called for every state that arrives (debug probe). */
  readonly onState?: ((hostTick: number, current: Readonly<HostViewState>) => void) | null;
  /**
   * The worker never started (script failed to load, threw while starting, timed out). Nothing
   * has touched the transport yet, so the caller can host on the main thread instead.
   */
  readonly onStartFailed?: ((reason: string) => void) | null;
  readonly startTimeoutMs?: number;
}

export class WorkerHost implements HostHandle {
  readonly mode = 'worker';
  readonly metrics: HostMetrics = createHostMetrics();
  readonly playerPings: number[] = [];

  private readonly worker: WorkerLike;
  private readonly transport: HostTransport | null;
  private readonly config: HostWorkerConfig;
  private readonly now: () => number;
  private readonly epochNow: () => number;
  private readonly localInput: LocalInputSource | null;
  private readonly events: GameEventSink | null;
  private readonly eventReader = new Reader();
  private readonly eventViews = new ViewCache(true);
  private readonly scores = createScoreTable();
  private readonly onState: WorkerHostOptions['onState'];
  private readonly onStartFailed: WorkerHostOptions['onStartFailed'];
  private readonly startTimeoutMs: number;
  private readonly meter: WorkMeter;

  private readonly pool = new BufferPool();
  private readonly inbound = new BatchWriter(this.pool);
  private readonly reader = new BatchReader();
  private readonly exact = new ExactBuffers();
  private readonly returns: ArrayBuffer[] = [];
  private readonly transfer: ArrayBuffer[] = [];
  private readonly batchMessage: BatchMessage = { t: 'b', b: new ArrayBuffer(0), r: [] };
  private readonly links = new Set<LinkId>();
  private readonly frame: InputFrame = createInputFrame();
  private readonly stats = createHostWorkerStats();

  private ready = false;
  private ended = false;
  private readonly createdMs: number;
  private lastUpdateMs = -1;
  private lastPostMs = -Infinity;
  private lastWorkerMs: number;
  /** Epoch clock minus the page clock, so a tick's due time can be put on the page's clock. */
  private readonly epochOffsetMs: number;

  // The mirror.
  private sessionState: HostSessionState = 'idle';
  private lastError: TransportError | null = null;
  private code = '';
  private lobbyState: LobbyState | null = null;
  private localId: PlayerId = 0;
  private matchRunning = false;
  private phase: MatchPhase = 'lobby';
  private blocker: StartBlocker | null = null;
  private readonly info: HostTickInfo = createHostTickInfo();
  private readonly prevState: HostViewState = createHostViewState();
  private readonly currentState: HostViewState = createHostViewState();
  private hasState = false;
  private steerX = 0;
  private steerY = 0;
  private lateMean = 0;

  constructor(options: WorkerHostOptions) {
    this.worker = options.worker;
    this.transport = options.transport;
    this.config = options.config;
    this.now = options.now;
    this.epochNow = options.epochNow;
    this.localInput = options.localInput ?? null;
    this.events = options.events ?? null;
    this.onState = options.onState ?? null;
    this.onStartFailed = options.onStartFailed ?? null;
    this.startTimeoutMs = options.startTimeoutMs ?? WORKER_START_TIMEOUT_MS;
    this.meter = new WorkMeter(options.profileClock ?? null);
    this.createdMs = this.now();
    this.lastWorkerMs = this.createdMs;
    this.epochOffsetMs = this.epochNow() - this.createdMs;
    for (let i = 0; i < PLAYER_SLOTS; i++) this.playerPings.push(-1);
    this.inbound.flush = (): void => this.flushInbound();

    this.transport?.setHandlers({
      onOpen: (roomCode): void => {
        this.meter.enter();
        this.postObject({ t: 'transportOpen', roomCode });
        this.meter.exit();
      },
      onError: (error): void => {
        this.meter.enter();
        // A plain copy: the error object must survive a structured clone.
        this.postObject({
          t: 'transportError',
          error: { reason: error.reason, message: error.message, fatal: error.fatal },
        });
        this.meter.exit();
      },
      onPeerConnected: (link): void => {
        this.meter.enter();
        this.links.add(link);
        this.inbound.mark(REC_PEER_OPEN, 0, link);
        this.flushInbound();
        this.meter.exit();
      },
      onPeerDisconnected: (link, reason): void => {
        this.meter.enter();
        this.links.delete(link);
        this.inbound.mark(
          REC_PEER_GONE,
          reason === 'local'
            ? AUX_REASON_LOCAL
            : reason === 'lost'
              ? AUX_REASON_LOST
              : AUX_REASON_REMOTE,
          link,
        );
        this.flushInbound();
        this.meter.exit();
      },
      onMessage: (link, channel, data): void => {
        this.meter.enter();
        const aux = channel === 'fast' ? AUX_FAST : AUX_CTRL;
        if (typeof data === 'string') this.inbound.mark(REC_TEXT, aux, link);
        else this.inbound.copy(REC_PACKET, aux, link, new Uint8Array(data));
        // Reliable messages are rare and want an answer now; inputs wait for the frame.
        if (channel === 'ctrl') this.flushInbound();
        this.meter.exit();
      },
    });

    this.worker.listen(
      (message) => this.onWorkerMessage(message),
      (message) => this.fail(message),
    );
    this.postObject({ t: 'init', config: this.config });
  }

  // --- What the game reads ---------------------------------------------------------------------

  get state(): HostSessionState {
    return this.sessionState;
  }

  get error(): TransportError | null {
    return this.lastError;
  }

  get roomCode(): string {
    return this.code;
  }

  get lobby(): LobbyState | null {
    return this.lobbyState;
  }

  get localPlayerId(): PlayerId {
    return this.localId;
  }

  get hostTick(): number {
    return this.hasState ? this.info.hostTick : this.stats.ticks;
  }

  get inMatch(): boolean {
    return this.matchRunning;
  }

  get matchPhase(): MatchPhase {
    return this.matchRunning ? this.phase : 'lobby';
  }

  get phaseTimeS(): number {
    return this.info.phaseTimeS;
  }

  get matchRound(): number {
    return this.matchRunning && this.hasState ? this.info.round : 1;
  }

  get matchWinner(): MatchWinner | null {
    return this.matchRunning && this.hasState ? this.info.winner : null;
  }

  get timeRemainingS(): number {
    return this.matchRunning && this.hasState ? this.info.timeRemainingS : Infinity;
  }

  get scoreEmber(): number {
    return this.matchRunning && this.hasState ? this.info.scoreEmber : 0;
  }

  get scoreFrost(): number {
    return this.matchRunning && this.hasState ? this.info.scoreFrost : 0;
  }

  get matchStats(): readonly Readonly<MatchPlayerStats>[] {
    return this.scores.rows;
  }

  get matchStatsCount(): number {
    return this.matchRunning ? this.scores.count : 0;
  }

  get localIsRider(): boolean {
    return this.matchRunning && this.hasState && this.info.localIsRider;
  }

  get prev(): Readonly<HostViewState> | null {
    return this.matchRunning && this.hasState ? this.prevState : null;
  }

  get current(): Readonly<HostViewState> | null {
    return this.matchRunning && this.hasState ? this.currentState : null;
  }

  get startBlocker(): StartBlocker | null {
    return this.blocker;
  }

  get clientCount(): number {
    return this.stats.clientCount;
  }

  get botCount(): number {
    return this.config.bots;
  }

  get botsConnected(): number {
    return this.stats.botsConnected;
  }

  get aimX(): number {
    return this.steerX;
  }

  get aimY(): number {
    return this.steerY;
  }

  /** The worker said `ready`. */
  get started(): boolean {
    return this.ready;
  }

  // --- Commands ----------------------------------------------------------------------------------

  open(): void {
    if (this.ended || this.sessionState !== 'idle') return;
    this.sessionState = 'opening';
    this.postObject({ t: 'open' });
  }

  /**
   * Ends the room from the page: HOST_LEFT goes straight out on the links the page holds (a
   * round trip through the worker would not finish inside `pagehide`), then the transport and
   * the worker are let go.
   */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.sayGoodbye();
    this.worker.terminate();
    this.sessionState = 'closed';
    this.matchRunning = false;
  }

  applyIntent(intent: UiIntent): void {
    if (this.ended) return;
    this.postObject({ t: 'intent', intent });
  }

  endMatch(): void {
    if (this.ended) return;
    this.postObject({ t: 'endMatch' });
  }

  update(nowMs: number): void {
    if (this.ended) return;
    this.meter.enter();
    const gapMs = this.lastUpdateMs < 0 ? 0 : nowMs - this.lastUpdateMs;
    this.lastUpdateMs = nowMs;

    if (!this.ready) {
      if (nowMs - this.createdMs >= this.startTimeoutMs) this.fail('the worker did not start');
    } else if (gapMs >= 1000) {
      // The page itself was away: the worker's messages may still be queued behind this frame.
      this.lastWorkerMs = nowMs;
    } else if (nowMs - this.lastWorkerMs >= WORKER_SILENT_MS) {
      this.fail('the worker stopped answering');
    }

    if (!this.ended) {
      const source = this.localInput;
      if (
        this.matchRunning &&
        this.hasState &&
        source !== null &&
        this.config.autopilot === null &&
        !this.config.localBot
      ) {
        const frame = this.frame;
        const dtS = gapMs > 100 ? 0.1 : gapMs / 1000;
        source.sample(
          this.info.hostTick + 1,
          findViewDragon(this.currentState, this.localId),
          frame,
          dtS,
        );
        this.steerX = frame.steerX;
        this.steerY = frame.steerY;
        const inbound = this.inbound;
        const at = inbound.begin(REC_INPUT, 0, 0, INPUT_RECORD_BYTES);
        if (at >= 0) {
          const view = inbound.view;
          view.setFloat32(at, frame.steerX, true);
          view.setFloat32(at + 4, frame.steerY, true);
          view.setUint16(at + 8, frame.buttons & 0xffff, true);
          view.setUint16(at + 10, 0, true);
          view.setFloat64(at + 12, this.epochNow(), true);
          view.setFloat32(at + 20, frame.aimYaw, true);
          view.setFloat32(at + 24, frame.aimPitch, true);
        }
      }
      if (this.inbound.empty && nowMs - this.lastPostMs >= PAGE_KEEPALIVE_MS) {
        this.inbound.mark(REC_KEEPALIVE, 0, 0);
      }
      this.flushInbound();
    }
    this.meter.exit();
    this.metrics.mainMs = this.meter.totalMs;
    this.metrics.buffersAllocated = this.pool.allocated;
  }

  fixedStep(): void {
    // The worker owns the ticks.
  }

  viewAlpha(_loopAlpha: number, nowMs: number): number {
    const metrics = this.metrics;
    metrics.viewFrames++;
    if (!this.hasState) return 1;
    const dueMs = this.info.tickAtMs - this.epochOffsetMs;
    const alpha = (nowMs - dueMs) / TICK_MS;
    if (alpha > 1) {
      metrics.viewExtrapolatedFrames++;
      const over = (alpha - 1) * TICK_MS;
      if (alpha > 1 + VIEW_EXTRAPOLATE_TICKS) {
        metrics.viewStarvedFrames++;
        return 1 + VIEW_EXTRAPOLATE_TICKS;
      }
      if (over > metrics.viewExtrapolatedMaxMs) metrics.viewExtrapolatedMaxMs = over;
      return alpha;
    }
    return alpha > 0 ? alpha : 0;
  }

  // --- Worker -> page ----------------------------------------------------------------------------

  private onWorkerMessage(message: FromWorkerMessage): void {
    if (this.ended) return;
    this.meter.enter();
    this.lastWorkerMs = this.now();
    switch (message.t) {
      case 'b':
        this.onBatch(message);
        break;
      case 'meta':
        this.applyMeta(message.meta);
        break;
      case 'ready':
        this.ready = true;
        break;
      case 'transportOpen':
        this.transport?.open(message.roomCode);
        break;
      case 'transportDispose':
        this.transport?.dispose();
        this.links.clear();
        break;
      case 'failed':
        this.fail(message.message);
        break;
    }
    this.meter.exit();
  }

  private applyMeta(meta: HostMeta): void {
    this.sessionState = meta.state;
    this.lastError = meta.error;
    this.code = meta.roomCode;
    this.lobbyState = meta.lobby;
    this.localId = meta.localPlayerId;
    this.phase = meta.matchPhase;
    this.blocker = meta.startBlocker;
    if (!meta.inMatch) {
      // The next match must not start from the last picture of this one.
      this.hasState = false;
      this.scores.count = 0;
      this.steerX = 0;
      this.steerY = 0;
    }
    this.matchRunning = meta.inMatch;
    if (!this.hasState) this.stats.ticks = meta.hostTick;
  }

  private onBatch(message: BatchMessage): void {
    const returned = message.r;
    for (let i = 0; i < returned.length; i++) {
      const buffer = returned[i];
      if (buffer !== undefined) this.pool.release(buffer);
    }
    const reader = this.reader;
    const transport = this.transport;
    const metrics = this.metrics;
    if (reader.open(message.b)) {
      metrics.postedBytesDown += reader.byteLength;
      metrics.postedMessagesDown++;
      while (reader.next()) {
        switch (reader.kind) {
          case REC_PACKET:
            if (transport !== null && this.links.has(reader.link)) {
              transport.send(
                reader.link,
                reader.aux === AUX_FAST ? 'fast' : 'ctrl',
                this.exact.filled(reader.bytes, reader.offset, reader.length),
              );
            }
            break;
          case REC_CLOSE:
            // Reports back through `onPeerDisconnected`, which tells the worker (it ignores it).
            transport?.close(reader.link);
            break;
          case REC_STATE:
            this.onStateRecord(reader.view, reader.offset, reader.length);
            break;
          case REC_STATS:
            this.onStatsRecord(reader.view, reader.offset, reader.length);
            break;
          case REC_EVENTS:
            if (this.events !== null) {
              const packet = this.exact.filled(reader.bytes, reader.offset, reader.length);
              decodeGameEvents(
                this.eventReader.reset(this.eventViews.viewOf(packet.buffer)),
                this.events,
              );
            }
            break;
          case REC_SCORES: {
            const packet = this.exact.filled(reader.bytes, reader.offset, reader.length);
            decodeScoreboard(
              this.eventReader.reset(this.eventViews.viewOf(packet.buffer)),
              this.scores,
            );
            break;
          }
          default:
            break;
        }
      }
    }
    reader.close();
    this.returns.push(message.b);

    // Frames not running (hidden tab): what arrived from the links rides on the worker's beat.
    const now = this.lastWorkerMs;
    const framesStopped = now - this.lastUpdateMs > FRAMES_STOPPED_MS;
    if (framesStopped && !this.inbound.empty) {
      this.flushInbound();
    } else if (now - this.lastPostMs >= PAGE_KEEPALIVE_MS) {
      if (this.inbound.empty) this.inbound.mark(REC_KEEPALIVE, 0, 0);
      this.flushInbound();
    }
  }

  private onStateRecord(view: DataView, at: number, length: number): void {
    const info = this.info;
    if (!decodeHostState(view, at, length, info, this.prevState, this.currentState)) {
      this.hasState = false;
      return;
    }
    this.hasState = true;
    if (this.config.autopilot !== null) {
      this.steerX = info.aimX;
      this.steerY = info.aimY;
    }
    const metrics = this.metrics;
    const late = this.lastWorkerMs - (info.tickAtMs - this.epochOffsetMs);
    if (late >= 0) {
      this.lateMean += (late - this.lateMean) * METRIC_SMOOTHING;
      metrics.arrivalLateMs = this.lateMean;
      if (late > metrics.arrivalLateMaxMs) metrics.arrivalLateMaxMs = late;
    }
    if (this.onState !== null && this.onState !== undefined) {
      this.onState(info.hostTick, this.currentState);
    }
  }

  private onStatsRecord(view: DataView, at: number, length: number): void {
    const stats = this.stats;
    if (!decodeHostStats(view, at, length, stats, this.playerPings)) return;
    const metrics = this.metrics;
    metrics.stepMs = stats.stepMs;
    metrics.simMs = stats.simMs;
    metrics.snapshotMs = stats.snapshotMs;
    metrics.maxStepMs = stats.maxStepMs;
    metrics.ticks = stats.ticks;
    metrics.sentBytesPerS = stats.sentBytesPerS;
    metrics.receivedBytesPerS = stats.receivedBytesPerS;
    metrics.malformed = stats.malformed;
    metrics.workerPulseMs = stats.pulseMs;
    metrics.workerPulseMaxMs = stats.pulseMaxMs;
    metrics.workerLateMs = stats.lateMs;
    metrics.workerLateMaxMs = stats.lateMaxMs;
    metrics.inputAgeMs = stats.inputAgeMs;
    metrics.inputAgeMaxMs = stats.inputAgeMaxMs;
    metrics.inputHeldTicks = stats.inputHeldTicks;
  }

  // --- Page -> worker ----------------------------------------------------------------------------

  /** Object messages keep their place in the stream: the pending batch goes first. */
  private postObject(message: ToWorkerMessage): void {
    this.flushInbound();
    this.transfer.length = 0;
    this.worker.post(message, this.transfer);
    this.metrics.postedMessagesUp++;
  }

  private flushInbound(): void {
    if (this.ended) return;
    const buffer = this.inbound.take(this.epochNow());
    if (buffer === null) return;
    const message = this.batchMessage;
    const transfer = this.transfer;
    const returns = this.returns;
    transfer.length = 0;
    transfer.push(buffer);
    for (let i = 0; i < returns.length; i++) {
      const returned = returns[i];
      if (returned !== undefined) transfer.push(returned);
    }
    message.b = buffer;
    message.r = returns;
    this.worker.post(message, transfer);
    returns.length = 0;
    transfer.length = 0;
    this.lastPostMs = this.now();
    this.metrics.postedBytesUp += this.inbound.takenBytes;
    this.metrics.postedMessagesUp++;
  }

  // --- Endings -----------------------------------------------------------------------------------

  /** HOST_LEFT to every link the page holds, then the transport is released. */
  private sayGoodbye(): void {
    const transport = this.transport;
    if (transport === null) return;
    const writer = new Writer(HOST_LEFT_BYTES);
    const notice = createNoticeMessage();
    notice.tick = this.hostTick & 0xffff;
    const length = encodeHostLeft(writer, notice);
    if (length > 0) {
      for (const link of this.links) transport.send(link, 'ctrl', writer.packet(length));
    }
    this.links.clear();
    transport.dispose();
  }

  private fail(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.worker.terminate();
    this.matchRunning = false;
    if (!this.ready && this.onStartFailed !== null && this.onStartFailed !== undefined) {
      // Nothing was opened yet: hand the untouched transport back for the direct path.
      this.transport?.setHandlers(NOOP_HOST_HANDLERS);
      this.sessionState = 'closed';
      this.onStartFailed(reason);
      return;
    }
    this.sayGoodbye();
    this.lastError = transportError('unknown', `The host worker failed: ${reason}`, true);
    this.sessionState = 'closed';
  }
}
