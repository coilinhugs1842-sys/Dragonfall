/**
 * ClientSession: one player's side of a room (docs/NETWORKING.md). It connects by room code,
 * does the HELLO / WELCOME handshake, mirrors the lobby state the host broadcasts, and in a
 * match runs the client half of the netcode: clock sync from PING / PONG, prediction of the own
 * dragon, INPUT packets on `fast`, snapshots into the interpolation buffer.
 *
 * It sends inputs and intents and nothing else. Everything it receives was decoded and
 * validated by the codec; the host is trusted (docs/NETWORKING.md, "Trust"), but a malformed
 * message is still only ever dropped, never thrown on.
 *
 * DRIVING IT. No timers, no clock reads, no DOM, no storage of its own (the reconnect token
 * goes through an injected `ReconnectTokenStore`), so it runs in node tests and as an in-page
 * net-bot. The caller drives it with a monotonic millisecond clock:
 * - `advance(nowMs, sampler)` once per frame: housekeeping, then as many fixed 30 Hz ticks as
 *   are due (the session owns the accumulator because the host steers its rate, see
 *   `InputTiming`), asking `sampler` for the input of each;
 * - or the two halves by hand: `update(nowMs)` and `tick(input)`.
 * While frames are not running (hidden tab) keep calling `update` about once a second: it sends
 * the pings that tell the host this player is still there (the host drops a link that has been
 * silent for `HOST_LINK_TIMEOUT_MS`) and runs the reconnect when the link drops anyway.
 * Then `writeWorldView(view, stormWall)` for the frame's picture.
 *
 * STATUS. `idle` -> `connecting` -> `connected`; an unexpected drop -> `reconnecting` (same
 * token, retried for 30 s) -> `connected` again or `disconnected`. Terminal: `failed` (never
 * got in), `rejected`, `kicked`, `hostLeft`, `disconnected`, `left`. `error` says why, in the
 * shape `UiState.connection.error` wants.
 */

import {
  MATCH_TUNING,
  NO_PLAYER,
  PING_HZ,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  TICK_DT_S,
  TICK_HZ,
  TICK_MS,
  createInputFrame,
  writeRelayView,
} from '../../shared';
import type {
  ConnectFailureReason,
  GameEvent,
  GameEventSink,
  InputFrame,
  LobbyState,
  MapId,
  MatchPhase,
  MatchWinner,
  MutableWorldView,
  PlayerId,
  RejectReason,
  UiError,
  UiIntent,
} from '../../shared';
import { createRelayState, resetRelayState } from '../../sim';
import type { RelayState } from '../../sim';
import { buildMatchRoster } from '../../sim/lobby';
import { ClockSync } from '../clock/clock-sync';
import {
  decodeHostLeft,
  decodeKick,
  decodeLobbyState,
  decodeMatchPhase,
  decodeMatchStart,
  decodePong,
  decodeReject,
  decodeWelcome,
  encodeHello,
  encodeIntent,
  encodePing,
  isNetIntent,
} from '../codec/ctrl';
import { decodeGameEvents } from '../codec/events';
import { copySnapshotOwner, decodeSnapshot, encodeInput } from '../codec/fast';
import { Reader, Writer } from '../codec/io';
import { expandTick } from '../codec/quantize';
import { InputTiming, initialInputLeadTicks } from '../prediction/input-timing';
import { ClientPredictor } from '../prediction/predictor';
import type { ReconcileResult } from '../prediction/predictor';
import {
  CTRL_MAX_BYTES,
  FAST_MAX_BYTES,
  MSG_GAME_EVENTS,
  MSG_HOST_LEFT,
  MSG_KICK,
  MSG_LOBBY_STATE,
  MSG_MATCH_PHASE,
  MSG_MATCH_START,
  MSG_PLAYER_PINGS,
  MSG_PONG,
  MSG_RELAY,
  MSG_SCOREBOARD,
  MSG_REJECT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  createHelloMessage,
  createInputMessage,
  createIntentMessage,
  createLobbyStateMessage,
  createMatchPhaseMessage,
  createMatchStartMessage,
  createNoticeMessage,
  createPingMessage,
  createPongMessage,
  createRejectMessage,
  createSnapshotMessage,
  createSnapshotOwner,
  createWelcomeMessage,
  isFastMessage,
} from '../protocol';
import type { SnapshotOwner } from '../protocol';
import { isValidRoomCode, normalizeRoomCode } from '../room-code';
import {
  ClientBolts,
  ClientRoster,
  SnapshotBuffer,
  buildClientWorldView,
  createSnapshotSample,
  shouldSendSnapshot,
} from '../snapshot';
import type { ClientStormWallSource, SnapshotSample } from '../snapshot';
import type {
  Channel,
  ClientTransport,
  ClientTransportHandlers,
  DisconnectReason,
  TransportError,
  TransportMessage,
} from '../transport/transport';
import { greyboxMatchWorldFactory } from './match-world';
import type { MatchWorld, MatchWorldFactory } from './match-world';
import { NetRate } from './net-rate';
import { applyPlayerPings, createPlayerPingsMessage, decodePlayerPings } from './pings';
import { decodeRelay } from './relay';
import { createScoreTable, decodeScoreboard } from './scores';
import type { ScoreTable } from './scores';
import { ViewCache, createMemoryTokenStore, rttToWire } from './wire';
import type { ReconnectTokenStore } from './wire';

// --- Tunables ------------------------------------------------------------------------------------

/** After the link opens, WELCOME or REJECT must arrive within this. */
export const CLIENT_HANDSHAKE_TIMEOUT_MS = 6000;
/** Backstop on top of the transport's own connect timeout. */
export const CLIENT_CONNECT_TIMEOUT_MS = 25_000;
/**
 * Wait before the first reconnect attempt. Longer than the host's stale-link threshold, so by
 * the time the HELLO with the old token arrives the host accepts that the old link is dead.
 */
export const CLIENT_RECONNECT_DELAY_MS = 2000;
/** Pause between failed reconnect attempts. */
export const CLIENT_RECONNECT_RETRY_MS = 1500;
/**
 * This many "room not found" answers while reconnecting, with no sign of the host in between,
 * mean the host is gone. An attempt that got no answer at all does not count either way.
 */
export const CLIENT_ROOM_GONE_ATTEMPTS = 3;
/**
 * One "room not found" answer and no sign of the host for this long after it also mean the
 * host is gone. The public signaling server does not answer every attempt to reach a host
 * whose browser has died (measured: an answer at once, then an attempt that hangs until the
 * transport times it out 15 s later, then an answer again), so three answers in a row never
 * come; counting them, the 30 s window ran out first and the player was told to check their
 * own network. A host that is only away for a moment answers a later attempt well inside
 * this time, which clears the count.
 */
export const CLIENT_ROOM_GONE_MS = 10_000;
/**
 * Nothing heard from the host for this long while connected (it answers every ping, so that is
 * a dozen missed pongs) means the link is dead: it is dropped and the reconnect starts. WebRTC
 * alone takes 30 s or more to notice a host that vanished without a goodbye.
 */
export const CLIENT_LINK_TIMEOUT_MS = 6000;
/**
 * A gap this long between two `update` calls means this page was not running (a frozen tab, a
 * long stall); the gap does not count as silence from the host, nor against the reconnect
 * window. Above the one-second beat a hidden tab's `update` gets from the frame driver's
 * background timer: that is the page running slowly, not the page being away.
 */
export const CLIENT_STALL_MS = 2000;
/**
 * Nothing heard from the host for this long (four missed pongs, forty snapshots) and the ping
 * shown is the silence itself: see `pingMs`. Not below `CLIENT_STALL_MS`: a shorter gap
 * between two updates of this page is not told apart from the host being quiet.
 */
export const CLIENT_QUIET_MS = CLIENT_STALL_MS;
/** Pings are sent this often until the clock is synced, then at PING_HZ. */
export const CLIENT_SYNC_PING_INTERVAL_MS = 100;
/** Fixed ticks run by one `advance` at most (a longer stall drops sim time). */
export const CLIENT_MAX_TICKS_PER_ADVANCE = 5;

const PING_INTERVAL_MS = 1000 / PING_HZ;
const LOSS_INTERVAL_MS = 1000;
/** Weight of the newest one-second window in the loss figure. */
const LOSS_SMOOTHING = 0.35;
/** A jump of more ticks than this between two snapshots is a restart, not loss. */
const LOSS_MAX_GAP_TICKS = 150;

// --- Public types --------------------------------------------------------------------------------

export type ClientStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  /** The link dropped and could not be restored within the reconnect grace. */
  | 'disconnected'
  /** Hosting ended: the host closed the room or its page. */
  | 'hostLeft'
  /** The host answered HELLO with REJECT. */
  | 'rejected'
  /** The host removed this player. */
  | 'kicked'
  /** The room was never joined (wrong code, unreachable, timeout). */
  | 'failed'
  /** This player left on purpose. */
  | 'left';

/** Asked for the input of each fixed tick. One object, so sampling allocates nothing. */
export interface ClientInputSampler {
  /**
   * Fill `frame` (steer and buttons; `tick` is set by the session). `own` is this player's
   * dragon as the client knows it, or null before the first snapshot.
   */
  sample(frame: InputFrame, own: Readonly<SnapshotOwner> | null): void;
}

export interface ClientMatchInfo {
  readonly seed: number;
  /** The map the match is flown on, as MATCH_START said. */
  readonly map: MapId;
  /** First host tick the sim steps (the countdown ends). */
  readonly startTick: number;
  /** Null when this session does not predict (net-bots). */
  readonly world: MatchWorld | null;
  /** False for a spectator. */
  readonly isRider: boolean;
}

/** Optional callbacks, called synchronously from `update` or a transport callback. */
export interface ClientSessionListener {
  onStatusChange?(status: ClientStatus): void;
  /** A new lobby state arrived (a new object every time). */
  onLobbyChanged?(lobby: LobbyState): void;
  onMatchStart?(info: ClientMatchInfo): void;
  onMatchPhase?(phase: MatchPhase): void;
  onMatchEnd?(): void;
}

export interface ClientSessionOptions {
  readonly transport: ClientTransport;
  /** Where the reconnect token lives between page loads. Default: memory only. */
  readonly tokenStore?: ReconnectTokenStore;
  /**
   * Names this browser in HELLO, the same in every tab and after a reload (a token-shaped
   * string; `src/game` keeps one in local storage). The host bans it when it kicks this player.
   * Default: none (tests, net-bots).
   */
  readonly clientId?: string;
  readonly listener?: ClientSessionListener;
  /** The client's event bus: GAME_EVENTS from the host are emitted here. */
  readonly events?: GameEventSink;
  /**
   * Predict the own dragon (default true). Off for net-bots: they still send real inputs and
   * the host does its full per-client work, but the bot skips the flight sim, the map collision
   * and the view smoothing, which keeps the host page's CPU honest in a load test.
   */
  readonly predict?: boolean;
  /** Must build the same world as the host. Default: the greybox map. Unused without `predict`. */
  readonly createMatchWorld?: MatchWorldFactory;
  /**
   * The same clock `update` is given, readable at any moment (e.g. `() => performance.now()`).
   * Messages arrive between two `update` calls; with this their timestamps are exact instead of
   * rounded down to the last frame, which matters for the ping shown and for clock sync. Left
   * out (tests, net-bots), the time of the last `update` is used and nothing is read.
   */
  readonly now?: () => number;
  /** The transport recycles delivered buffers (loopback / netsim): cache their DataViews. */
  readonly recycledBuffers?: boolean;
  readonly handshakeTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly linkTimeoutMs?: number;
  readonly reconnectWindowMs?: number;
  readonly reconnectDelayMs?: number;
  readonly reconnectRetryMs?: number;
}

/** Counters for the debug HUD and the tests. */
export interface ClientSessionCounters {
  /** Messages dropped unread: not binary, too large, wrong channel, failed decode. */
  malformed: number;
  snapshots: number;
  inputsSent: number;
  /** Jumps of the prediction clock asked for by `InputTiming`. */
  resyncs: number;
  reconnects: number;
  /** Times the link was dropped because the host had gone silent. */
  linkTimeouts: number;
}

/** `ClientWorldViewOptions` with the fields the session rewrites each frame. */
interface MutableViewOptions {
  localDragonId: PlayerId;
  stormWall: ClientStormWallSource | null;
  phase: MatchPhase;
  respawnDelayS: number;
}

/**
 * The dragons are never held (intro + countdown) longer than this (10 min): a MATCH_PHASE that
 * says otherwise is not believed. Well inside half a wrap of the 16-bit tick it travels as.
 */
const HELD_MAX_TICKS = 600 * TICK_HZ;

export class ClientSession {
  readonly stats = new NetRate();
  readonly counters: ClientSessionCounters = {
    malformed: 0,
    snapshots: 0,
    inputsSent: 0,
    resyncs: 0,
    reconnects: 0,
    linkTimeouts: 0,
  };
  /** The netcode pieces, exposed for the debug HUD and for tests. Treat them as read-only. */
  readonly clock = new ClockSync();
  readonly timing = new InputTiming();
  readonly buffer = new SnapshotBuffer();
  readonly predictor: ClientPredictor;
  /** Team and class of every rider of the running match. */
  readonly roster = new ClientRoster();
  /**
   * Fast projectiles, flown here from `abilityCast` events and from the local rider's own
   * predicted shots; `writeWorldView` appends them to the view's projectiles.
   */
  readonly bolts = new ClientBolts();
  /**
   * What the events of the reliable channel pass through on their way to `options.events`:
   * a cast that launches a bolt starts one here. The local rider's own bolts were already
   * drawn when they were predicted, so the host's echo of those is not drawn again.
   */
  private viewed = false;
  private readonly eventTap: GameEventSink = {
    emit: (event: GameEvent): void => {
      // Only a session somebody draws from flies bolts (a net-bot never asks for a view).
      if (event.type === 'abilityCast' && this.viewed) {
        const predicting = this.predict && this.rider && this.predictor.active;
        this.bolts.onAbilityCast(
          event,
          this.roster.teamOf(event.dragonId),
          this.sample.playTick,
          predicting ? this.playerId : NO_PLAYER,
        );
      }
      if (this.events !== null) this.events.emit(event);
    },
  };
  /** The sample `writeWorldView` last took from the buffer. */
  readonly sample: SnapshotSample = createSnapshotSample();
  /**
   * Round trip per player in ms as the host reports it about once a second, indexed by
   * PlayerId; -1 = unknown. Mutated in place: hand it to `UiState.playerPings` as it is.
   */
  readonly playerPings: number[] = [];
  /**
   * Per-rider totals as the host last sent them (SCOREBOARD): the first `scores.count` rows are
   * live. Rewritten in place; do not keep rows.
   */
  readonly scores: ScoreTable = createScoreTable();
  /**
   * Ember Relay's sites and shards as the host last sent them (RELAY); `relay.active` is false
   * in every other mode and outside a match. Rewritten in place.
   */
  readonly relay: RelayState = createRelayState();
  private readonly relaySpare: RelayState = createRelayState();
  /**
   * Seconds a dead dragon waits to respawn, for `view.local.respawnInS`. `src/game` sets it to
   * Infinity while the mode has respawns off (Duel).
   */
  respawnDelayS: number = MATCH_TUNING.respawnDelayS;
  /** Ability slots the local rider's prediction fired since `takeLocalCasts` was last called. */
  private localCasts = 0;

  private readonly transport: ClientTransport;
  private readonly tokenStore: ReconnectTokenStore;
  private readonly clientId: string;
  private readonly listener: ClientSessionListener;
  private readonly events: GameEventSink | null;
  private readonly predict: boolean;
  private readonly clockNow: (() => number) | null;
  private readonly createMatchWorld: MatchWorldFactory;
  private readonly handshakeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly linkTimeoutMs: number;
  private readonly reconnectWindowMs: number;
  private readonly reconnectDelayMs: number;
  private readonly reconnectRetryMs: number;

  private sessionStatus: ClientStatus = 'idle';
  private sessionError: UiError | null = null;
  private code = '';
  private name = '';
  private playerId: PlayerId = NO_PLAYER;
  private lobbyState: LobbyState | null = null;

  private nowMs = 0;
  /** False until the first `update`: the first call has no previous time to measure a gap from. */
  private updated = false;
  /** When the host was last heard from on the current link (any message that decoded). */
  private lastHeardMs = 0;
  private lastAdvanceMs = -1;
  private lastDtMs = 0;
  private connectStartedMs = 0;
  /** >= 0 while a HELLO is waiting for its answer. */
  private helloSentMs = -1;
  private reconnectDeadlineMs = 0;
  /** When the next reconnect attempt may start; Infinity while one is in flight. */
  private nextAttemptMs = Infinity;
  /** "Room not found" answers since the host last showed a sign of life, and when the first came. */
  private roomGoneStreak = 0;
  private roomGoneSinceMs = 0;
  private nextPingMs = 0;

  // Reference for expanding wire ticks before the first pong.
  private welcomeHostTick = 0;
  private welcomeMs = 0;

  // --- Match ---
  private matchActive = false;
  private matchPhaseNow: MatchPhase = 'lobby';
  private matchRoundNow = 1;
  private matchWinnerNow: MatchWinner | null = null;
  private matchSeedNow = 0;
  private matchMapNow: MapId = 'shattered-spires';
  private matchStartTickNow = -1;
  /** First host tick of the current phase, from the reliable MATCH_PHASE. */
  private phaseStartTickNow = 0;
  private world: MatchWorld | null = null;
  private worldSeed = -1;
  private worldMap: MapId | null = null;
  private rider = false;
  /** The prediction clock has been set from clock sync. */
  private started = false;
  private accumulatorMs = 0;
  private lastSnapshotTick = -1;
  private lastReconcile: ReconcileResult = 0;
  private readonly ownState: SnapshotOwner = createSnapshotOwner();
  private hasOwnState = false;

  // --- Loss estimate ---
  private lossMarkMs = -1;
  /** Snapshots the host sent in the current window, by its schedule, and how many arrived. */
  private lossExpected = 0;
  private lossReceived = 0;
  private lossPercent = 0;

  // --- Codec scratch ---
  private readonly views: ViewCache;
  private readonly reader = new Reader();
  private readonly fastWriter = new Writer(FAST_MAX_BYTES);
  private readonly ctrlWriter = new Writer(CTRL_MAX_BYTES);
  private readonly frame = createInputFrame();
  private readonly inputOut = createInputMessage();
  private readonly snapshotIn = createSnapshotMessage();
  private readonly helloOut = createHelloMessage();
  private readonly intentOut = createIntentMessage();
  private readonly pingOut = createPingMessage();
  private readonly pongIn = createPongMessage();
  private readonly welcomeIn = createWelcomeMessage();
  private readonly rejectIn = createRejectMessage();
  private readonly lobbyIn = createLobbyStateMessage();
  private readonly matchStartIn = createMatchStartMessage();
  private readonly matchPhaseIn = createMatchPhaseMessage();
  private readonly noticeIn = createNoticeMessage();
  private readonly pingsIn = createPlayerPingsMessage();
  private readonly viewOptions: MutableViewOptions = {
    localDragonId: NO_PLAYER,
    stormWall: null,
    phase: 'lobby',
    respawnDelayS: MATCH_TUNING.respawnDelayS,
  };

  private readonly handlers: ClientTransportHandlers;

  constructor(options: ClientSessionOptions) {
    this.transport = options.transport;
    this.tokenStore = options.tokenStore ?? createMemoryTokenStore();
    this.clientId = options.clientId ?? '';
    this.listener = options.listener ?? {};
    this.events = options.events ?? null;
    this.predict = options.predict !== false;
    this.clockNow = options.now ?? null;
    this.createMatchWorld = options.createMatchWorld ?? greyboxMatchWorldFactory;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? CLIENT_HANDSHAKE_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CLIENT_CONNECT_TIMEOUT_MS;
    this.linkTimeoutMs = options.linkTimeoutMs ?? CLIENT_LINK_TIMEOUT_MS;
    this.reconnectWindowMs = options.reconnectWindowMs ?? RECONNECT_GRACE_MS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? CLIENT_RECONNECT_DELAY_MS;
    this.reconnectRetryMs = options.reconnectRetryMs ?? CLIENT_RECONNECT_RETRY_MS;
    this.views = new ViewCache(options.recycledBuffers === true);
    this.predictor = new ClientPredictor();
    for (let i = 0; i < 256; i++) this.playerPings.push(-1);

    this.handlers = {
      onOpen: () => this.onTransportOpen(),
      onClose: (reason) => this.onTransportClose(reason),
      onError: (error) => this.onTransportError(error),
      onMessage: (channel, data) => this.onMessage(channel, data),
    };
    this.transport.setHandlers(this.handlers);
  }

  // --- State the game layer reads ----------------------------------------------------------------

  get status(): ClientStatus {
    return this.sessionStatus;
  }

  /** Why the session is in a terminal status, as `UiState.connection.error`; null otherwise. */
  get error(): UiError | null {
    return this.sessionError;
  }

  get roomCode(): string {
    return this.code;
  }

  /** NO_PLAYER until WELCOME. Kept while reconnecting. */
  get localPlayerId(): PlayerId {
    return this.playerId;
  }

  /** The host's latest lobby state; null until WELCOME. Replaced, never mutated. */
  get lobby(): LobbyState | null {
    return this.lobbyState;
  }

  /**
   * Smoothed round trip to the host in ms (0 before the first pong). Once the host has been
   * silent for `CLIENT_QUIET_MS` the silence is the figure: a ping sent that long ago has not
   * come back, so the number and the bars on screen fall at once instead of showing the last
   * good round trip until the link times out (six seconds of a frozen sky under "7 ms").
   */
  get pingMs(): number {
    const rtt = this.clock.rttMs;
    if (this.sessionStatus !== 'connected') return rtt;
    const silentMs = this.nowMs - this.lastHeardMs;
    return silentMs >= CLIENT_QUIET_MS && silentMs > rtt ? silentMs : rtt;
  }

  /** Share of snapshots that did not arrive over the last second, 0..100. */
  get lossPct(): number {
    return this.lossPercent;
  }

  get inMatch(): boolean {
    return this.matchActive;
  }

  /** `lobby` outside a match. */
  get matchPhase(): MatchPhase {
    return this.matchActive ? this.matchPhaseNow : 'lobby';
  }

  get matchSeed(): number {
    return this.matchSeedNow;
  }

  /** The map of the current (or last) match, from MATCH_START. */
  get matchMap(): MapId {
    return this.matchMapNow;
  }

  /** First tick of play of the current round (a later round's countdown moves it). */
  get matchStartTick(): number {
    return this.matchStartTickNow;
  }

  /** First host tick of the current match phase (0 outside a match). */
  get phaseStartTick(): number {
    return this.matchActive ? this.phaseStartTickNow : 0;
  }

  /** 1-based round, from the last MATCH_PHASE (1 outside a match). */
  get matchRound(): number {
    return this.matchActive ? this.matchRoundNow : 1;
  }

  /** Who won the round (`roundEnd`) or the match (`results`); null in every other phase. */
  get matchWinner(): MatchWinner | null {
    return this.matchActive ? this.matchWinnerNow : null;
  }

  /** The predictor's map; null outside a match and when `predict` is off. */
  get matchWorld(): MatchWorld | null {
    return this.matchActive ? this.world : null;
  }

  /** True while this player has a dragon in the match (false for a spectator). */
  get isRider(): boolean {
    return this.matchActive && this.rider;
  }

  /** The id to pass as `localDragonId`: the own id for a rider, NO_PLAYER otherwise. */
  get localDragonId(): PlayerId {
    return this.matchActive && this.rider ? this.playerId : NO_PLAYER;
  }

  /**
   * This player's own dragon as the client knows it: the predicted state, or with `predict`
   * off the latest owner block from the host. Null without one.
   */
  get ownDragon(): Readonly<SnapshotOwner> | null {
    if (!this.matchActive || !this.rider) return null;
    if (this.predict) return this.predictor.active ? this.predictor.dragon : null;
    return this.hasOwnState ? this.ownState : null;
  }

  /** Fraction of a tick banked in the fixed-step accumulator, for render interpolation. */
  get alpha(): number {
    return this.accumulatorMs / TICK_MS;
  }

  /** Result of the latest `ClientPredictor.reconcile` (RECONCILE_*). */
  get lastReconcileResult(): ReconcileResult {
    return this.lastReconcile;
  }

  /** Full host tick of the newest snapshot handled, or -1. */
  get latestSnapshotTick(): number {
    return this.lastSnapshotTick;
  }

  /** Factor for frame time when the caller runs its own fixed loop around `tick`. */
  get timeScale(): number {
    return this.timing.timeScale;
  }

  // --- Connecting --------------------------------------------------------------------------------

  /**
   * Joins the room `roomCode` as `name`. Answers through `status`: `connected`, or `failed` /
   * `rejected` with `error` set. A token stored for the room is sent along, so a page reload
   * within the grace period takes the old seat back.
   */
  connect(roomCode: string, name: string, nowMs: number = this.nowMs): void {
    if (this.sessionStatus === 'connecting' || this.sessionStatus === 'connected') return;
    if (this.sessionStatus === 'reconnecting') return;
    this.nowMs = nowMs;
    this.code = normalizeRoomCode(roomCode);
    this.name = name;
    this.sessionError = null;
    this.playerId = NO_PLAYER;
    this.lobbyState = null;
    this.playerPings.fill(-1);
    this.endMatchLocal(false);
    if (!isValidRoomCode(this.code)) {
      this.fail('failed', { kind: 'connectFailed', reason: 'invalidRoomCode' });
      return;
    }
    this.connectStartedMs = nowMs;
    this.helloSentMs = -1;
    this.roomGoneStreak = 0;
    this.setStatus('connecting');
    this.transport.connect(this.code);
  }

  /** Leaves the room on purpose: the host frees the seat at once. */
  leave(): void {
    const status = this.sessionStatus;
    if (status === 'connected') {
      this.sendIntentRaw({ type: 'lobby.leave' });
    }
    if (status === 'connected' || status === 'connecting' || status === 'reconnecting') {
      if (this.code.length > 0) this.tokenStore.clear(this.code);
      this.sessionError = null;
      this.endMatchLocal(true);
      this.setStatus('left');
      this.transport.close();
    }
  }

  /** Releases the transport. Final; the host holds the seat for the reconnect grace. */
  dispose(): void {
    this.transport.dispose();
    if (
      this.sessionStatus === 'connected' ||
      this.sessionStatus === 'connecting' ||
      this.sessionStatus === 'reconnecting'
    ) {
      this.sessionStatus = 'left';
    }
    this.matchActive = false;
  }

  /**
   * Sends a lobby or host intent to the host (which decides; `host.*` from a non-host is
   * ignored there). `lobby.leave` leaves. Returns false for anything that is not a network
   * intent or when not connected.
   */
  sendIntent(intent: UiIntent): boolean {
    if (!isNetIntent(intent)) return false;
    if (intent.type === 'lobby.leave') {
      this.leave();
      return true;
    }
    return this.sendIntentRaw(intent);
  }

  private sendIntentRaw(intent: UiIntent): boolean {
    if (this.sessionStatus !== 'connected' || !isNetIntent(intent)) return false;
    const message = this.intentOut;
    message.tick = 0;
    message.intent = intent;
    return this.sendCtrl(encodeIntent(this.ctrlWriter, message));
  }

  // --- Driving -----------------------------------------------------------------------------------

  /**
   * One frame: `update`, then every fixed tick that is due, each with an input from `sampler`
   * (null = neutral input). Returns the number of ticks run.
   */
  advance(nowMs: number, sampler: ClientInputSampler | null): number {
    const dtMs = this.lastAdvanceMs < 0 ? 0 : nowMs - this.lastAdvanceMs;
    this.lastAdvanceMs = nowMs;
    this.lastDtMs = dtMs > 0 ? dtMs : 0;
    this.update(nowMs);

    let steps = 0;
    if (this.matchActive && this.started) {
      // A stall longer than this is not caught up tick by tick: `InputTiming` resyncs instead.
      const usable = dtMs > 0 ? (dtMs < 250 ? dtMs : 250) : 0;
      this.accumulatorMs += usable * this.timing.timeScale;
      const frame = this.frame;
      while (this.accumulatorMs >= TICK_MS && steps < CLIENT_MAX_TICKS_PER_ADVANCE) {
        this.accumulatorMs -= TICK_MS;
        steps++;
        frame.steerX = 0;
        frame.steerY = 0;
        frame.buttons = 0;
        frame.aimYaw = 0;
        frame.aimPitch = 0;
        if (sampler !== null) sampler.sample(frame, this.ownDragon);
        this.tick(frame);
      }
      if (this.accumulatorMs >= TICK_MS) this.accumulatorMs %= TICK_MS;
    }
    return steps;
  }

  /** Wall-clock housekeeping: pings, timeouts, reconnect attempts, the prediction clock's start. */
  update(nowMs: number): void {
    const gap = nowMs - this.nowMs;
    if (this.updated && gap >= CLIENT_STALL_MS) {
      // Whatever happened while this page was not running (a message, the link closing) was
      // stamped with the time of its last update. Without this the whole gap would read as
      // silence from the host, and a reconnect that began during it would find its 30 s window
      // already spent and give up without one attempt while the host still holds the seat.
      this.lastHeardMs += gap;
      this.reconnectDeadlineMs += gap;
      this.connectStartedMs += gap;
      this.roomGoneSinceMs += gap;
      if (this.helloSentMs >= 0) this.helloSentMs += gap;
      // `nextAttemptMs` stays: an attempt that fell due while away is made at once.
    }
    this.updated = true;
    this.nowMs = nowMs;
    this.stats.update(nowMs);
    const status = this.sessionStatus;

    if (status === 'connecting') {
      if (this.helloSentMs >= 0 && nowMs - this.helloSentMs >= this.handshakeTimeoutMs) {
        this.failConnect('timeout');
      } else if (nowMs - this.connectStartedMs >= this.connectTimeoutMs) {
        this.failConnect('timeout');
      }
      return;
    }

    if (status === 'reconnecting') {
      if (nowMs >= this.reconnectDeadlineMs) {
        this.endMatchLocal(true);
        // The last word from the signaling server was that the room is not there: the host
        // went, not this page's network ("check your network" would send the player the
        // wrong way).
        if (this.roomGoneStreak > 0) this.fail('hostLeft', { kind: 'hostLeft' });
        else this.fail('disconnected', { kind: 'connectionLost' });
        this.transport.close();
      } else if (this.roomGoneStreak > 0 && nowMs - this.roomGoneSinceMs >= CLIENT_ROOM_GONE_MS) {
        // Told the room is not there, and nothing from the host since (see the constant).
        this.endMatchLocal(true);
        this.fail('hostLeft', { kind: 'hostLeft' });
        this.transport.close();
      } else if (this.helloSentMs >= 0 && nowMs - this.helloSentMs >= this.handshakeTimeoutMs) {
        // The link opened but the host never answered: try again from scratch.
        this.helloSentMs = -1;
        this.nextAttemptMs = nowMs + this.reconnectRetryMs;
        this.transport.close();
      } else if (nowMs >= this.nextAttemptMs) {
        this.nextAttemptMs = Infinity;
        this.helloSentMs = -1;
        this.transport.connect(this.code);
      }
      return;
    }

    if (status !== 'connected') return;

    if (nowMs - this.lastHeardMs >= this.linkTimeoutMs) {
      // The host stopped answering without the link closing (its page died or its network
      // did). Drop the link ourselves; the reconnect finds out whether the room still exists.
      this.counters.linkTimeouts++;
      this.transport.close();
      this.beginReconnect();
      return;
    }

    if (nowMs >= this.nextPingMs) {
      this.nextPingMs =
        nowMs + (this.clock.synced ? PING_INTERVAL_MS : CLIENT_SYNC_PING_INTERVAL_MS);
      const ping = this.pingOut;
      ping.tick = rttToWire(this.clock.rttMs, this.clock.sampleCount > 0);
      ping.clientTimeMs = this.clockNow !== null ? this.clockNow() : nowMs;
      this.sendCtrl(encodePing(this.ctrlWriter, ping));
    }

    if (!this.matchActive) return;

    if (!this.started && this.rider && this.clock.synced) {
      this.started = true;
      this.accumulatorMs = 0;
      this.predictor.setTick(
        Math.floor(this.clock.hostTickAt(nowMs)) +
          initialInputLeadTicks(this.clock.rttMs, this.clock.rttJitterMs),
      );
    }

    if (this.lossMarkMs < 0) {
      this.lossMarkMs = nowMs;
      this.lossExpected = 0;
      this.lossReceived = 0;
    } else if (nowMs - this.lossMarkMs >= LOSS_INTERVAL_MS) {
      // Counted on the host's send schedule (see `onSnapshot`), not against the wall clock: a
      // one-second window holds about 20 snapshots, and whether the 20th falls just inside or
      // just outside it would otherwise read as 5 % loss on a perfect link.
      let recent = this.lossPercent;
      if (this.lossReceived === 0) recent = 100;
      else if (this.lossExpected > 0) recent = (1 - this.lossReceived / this.lossExpected) * 100;
      if (!(recent > 0)) recent = 0;
      // Smoothed over a few seconds; a dead link (nothing at all) shows at once.
      this.lossPercent =
        recent >= 100 ? 100 : this.lossPercent + (recent - this.lossPercent) * LOSS_SMOOTHING;
      this.lossMarkMs = nowMs;
      this.lossExpected = 0;
      this.lossReceived = 0;
    }
  }

  /**
   * One fixed tick with this input: predicts the own dragon and sends the INPUT packet (the new
   * frame plus the previous two). `input` is rewritten to what the host will see (tick set,
   * steer snapped to the wire grid). Returns the tick, or -1 when there is nothing to do yet
   * (no match, a spectator, clock not synced).
   */
  tick(input: InputFrame): number {
    if (!this.matchActive || !this.started || this.sessionStatus !== 'connected') return -1;
    const predictor = this.predictor;
    const tick = predictor.step(input);
    // The rider's own shots are shown now; the host decides what they hit.
    const pulse = this.predict ? predictor.castPulse : 0;
    if (pulse !== 0) {
      this.localCasts |= pulse;
      for (let slot = 0; slot < 4; slot++) {
        if ((pulse & (1 << slot)) !== 0) this.bolts.spawnLocal(predictor.dragon, slot);
      }
    }
    const have = this.lastSnapshotTick >= 0;
    const count = predictor.writeInputMessage(
      this.inputOut,
      have,
      have ? this.lastSnapshotTick : 0,
    );
    if (count > 0) {
      const length = encodeInput(this.fastWriter, this.inputOut);
      if (length > 0 && this.transport.send('fast', this.fastWriter.packet(length))) {
        this.stats.addSent(length);
        this.counters.inputsSent++;
      }
    }
    return tick;
  }

  /**
   * Bit `i` set = the local rider's predicted dragon fired ABILITY_SLOTS[i] since the last
   * call. The views show and sound those shots at once (`Vfx.spawnLocalShot`,
   * `AudioEngine.playLocalCast`); the host's echo of them arrives a round trip later.
   */
  takeLocalCasts(): number {
    const casts = this.localCasts;
    this.localCasts = 0;
    return casts;
  }

  /**
   * The frame's picture: advances snapshot playback to the time of the latest `advance` /
   * `update`, decays the reconciliation offset and rewrites `view` (own dragon predicted, the
   * others interpolated). Call once per rendered frame, after `advance`.
   */
  writeWorldView(
    view: MutableWorldView,
    stormWall: ClientStormWallSource | null = null,
  ): MutableWorldView {
    this.viewed = true;
    this.buffer.update(this.nowMs);
    this.buffer.sample(this.sample);
    const predicting = this.predict && this.matchActive && this.rider;
    if (predicting) this.predictor.updateSmoothing(this.lastDtMs);
    const options = this.viewOptions;
    options.localDragonId = this.localDragonId;
    options.stormWall = stormWall;
    options.phase = this.matchPhase;
    options.respawnDelayS = this.respawnDelayS;
    buildClientWorldView(
      view,
      this.sample,
      predicting ? this.predictor : null,
      this.accumulatorMs / TICK_MS,
      this.roster,
      options,
    );
    // The phase shown is the reliable MATCH_PHASE's, which can be a few ticks ahead of (or, on a
    // slow ctrl channel, behind) the snapshots being played back. Its time is therefore counted
    // from that phase's own first tick on the playback clock, not read from the snapshot: the
    // two always belong together (a countdown never shows the intro's 6 s), and the value is
    // the one the host had on that tick.
    if (this.matchActive && this.sample.valid) {
      const elapsed = this.sample.playTick - this.phaseStartTickNow + 1;
      view.clock.phaseTimeS = elapsed > 0 ? elapsed * TICK_DT_S : 0;
    }
    // Ember Relay: the shards and braziers, on the same playback clock as the dragons.
    if (this.matchActive && this.relay.active) {
      // `clock.tick` is the whole playback tick `buildClientWorldView` just wrote.
      writeRelayView(view, this.relay, view.clock.tick);
    }
    const bolts = this.bolts;
    if (bolts.count > 0) {
      bolts.update(
        this.lastDtMs,
        this.world !== null ? this.world.collisionWorld : null,
        this.sample,
        this.roster,
        predicting && this.predictor.active ? this.predictor.dragon : null,
      );
      bolts.writeView(view);
    }
    return view;
  }

  // --- Status ------------------------------------------------------------------------------------

  private setStatus(status: ClientStatus): void {
    if (this.sessionStatus === status) return;
    this.sessionStatus = status;
    this.listener.onStatusChange?.(status);
  }

  private fail(status: ClientStatus, error: UiError): void {
    this.sessionError = error;
    this.helloSentMs = -1;
    this.nextAttemptMs = Infinity;
    this.setStatus(status);
  }

  private failConnect(reason: ConnectFailureReason): void {
    this.fail('failed', { kind: 'connectFailed', reason });
    this.transport.close();
  }

  private beginReconnect(): void {
    this.counters.reconnects++;
    this.reconnectDeadlineMs = this.nowMs + this.reconnectWindowMs;
    this.nextAttemptMs = this.nowMs + this.reconnectDelayMs;
    this.helloSentMs = -1;
    this.roomGoneStreak = 0;
    this.started = false;
    this.setStatus('reconnecting');
  }

  // --- Transport callbacks -------------------------------------------------------------------------

  private onTransportOpen(): void {
    const status = this.sessionStatus;
    if (status !== 'connecting' && status !== 'reconnecting') return;
    this.roomGoneStreak = 0;
    const hello = this.helloOut;
    hello.tick = 0;
    hello.protocolVersion = PROTOCOL_VERSION;
    hello.name = this.name;
    hello.reconnectToken = this.tokenStore.load(this.code);
    hello.clientId = this.clientId;
    this.helloSentMs = this.nowMs;
    this.sendCtrl(encodeHello(this.ctrlWriter, hello));
  }

  private onTransportClose(reason: DisconnectReason): void {
    if (reason === 'local') return;
    const status = this.sessionStatus;
    if (status === 'connected') {
      this.beginReconnect();
    } else if (status === 'connecting') {
      // The host dropped the link before answering.
      this.fail('failed', { kind: 'connectFailed', reason: 'peerUnavailable' });
    } else if (status === 'reconnecting') {
      this.helloSentMs = -1;
      this.nextAttemptMs = this.nowMs + this.reconnectRetryMs;
    }
  }

  private onTransportError(error: TransportError): void {
    if (!error.fatal) return;
    const status = this.sessionStatus;
    if (status === 'connecting') {
      this.fail('failed', { kind: 'connectFailed', reason: error.reason });
    } else if (status === 'reconnecting') {
      this.helloSentMs = -1;
      if (error.reason === 'roomNotFound') {
        // The host no longer holds the room code: it closed its page without a goodbye.
        if (this.roomGoneStreak === 0) this.roomGoneSinceMs = this.nowMs;
        this.roomGoneStreak++;
        if (
          this.roomGoneStreak >= CLIENT_ROOM_GONE_ATTEMPTS ||
          this.nowMs - this.roomGoneSinceMs >= CLIENT_ROOM_GONE_MS
        ) {
          this.endMatchLocal(true);
          this.fail('hostLeft', { kind: 'hostLeft' });
          return;
        }
      } else if (error.reason !== 'timeout') {
        // Anything but silence is news: the host answered and closed the link, or the
        // signaling server cannot be reached (then nothing is known about the room).
        this.roomGoneStreak = 0;
      }
      this.nextAttemptMs = this.nowMs + this.reconnectRetryMs;
    } else if (status === 'connected') {
      this.beginReconnect();
    }
  }

  private onMessage(channel: Channel, data: TransportMessage): void {
    if (typeof data === 'string') {
      this.drop();
      return;
    }
    const size = data.byteLength;
    this.stats.addReceived(size);
    if (size > (channel === 'fast' ? FAST_MAX_BYTES : CTRL_MAX_BYTES)) {
      this.drop();
      return;
    }
    const reader = this.reader.reset(this.views.viewOf(data));
    const type = reader.peekType();
    if (type < 0 || isFastMessage(type) !== (channel === 'fast')) {
      this.drop();
      return;
    }
    this.lastHeardMs = this.nowMs;
    const status = this.sessionStatus;
    const handshaking = status === 'connecting' || status === 'reconnecting';
    if (handshaking) {
      if (type === MSG_WELCOME) this.onWelcome(reader);
      else if (type === MSG_REJECT) this.onReject(reader);
      return;
    }
    if (status !== 'connected') return;

    switch (type) {
      case MSG_SNAPSHOT:
        this.onSnapshot(reader);
        return;
      case MSG_PONG:
        if (!decodePong(reader, this.pongIn)) {
          this.drop();
          return;
        }
        this.clock.addSample(
          this.pongIn.clientTimeMs,
          this.pongIn.hostTimeMs,
          this.pongIn.hostTick,
          this.clockNow !== null ? this.clockNow() : this.nowMs,
        );
        return;
      case MSG_PLAYER_PINGS:
        if (!decodePlayerPings(reader, this.pingsIn)) {
          this.drop();
          return;
        }
        applyPlayerPings(this.playerPings, this.pingsIn);
        return;
      case MSG_SCOREBOARD:
        if (!decodeScoreboard(reader, this.scores)) this.drop();
        return;
      case MSG_RELAY:
        // Read into a spare first: one that arrives with no match running must change nothing.
        if (!decodeRelay(reader, this.matchActive ? this.relay : this.relaySpare)) this.drop();
        return;
      case MSG_GAME_EVENTS:
        if (!decodeGameEvents(reader, this.eventTap)) this.drop();
        return;
      case MSG_LOBBY_STATE:
        this.onLobbyState(reader);
        return;
      case MSG_MATCH_START:
        this.onMatchStart(reader);
        return;
      case MSG_MATCH_PHASE:
        this.onMatchPhase(reader);
        return;
      case MSG_KICK:
        if (!decodeKick(reader, this.noticeIn)) {
          this.drop();
          return;
        }
        // The token is kept on purpose: it is what the host remembers the kick by, so joining
        // again from this tab is answered with `reject { kicked }`.
        this.endMatchLocal(true);
        this.fail('kicked', { kind: 'kicked' });
        this.transport.close();
        return;
      case MSG_HOST_LEFT:
        if (!decodeHostLeft(reader, this.noticeIn)) {
          this.drop();
          return;
        }
        this.tokenStore.clear(this.code);
        this.endMatchLocal(true);
        this.fail('hostLeft', { kind: 'hostLeft' });
        this.transport.close();
        return;
      default:
        this.drop();
    }
  }

  private drop(): void {
    this.counters.malformed++;
    this.stats.rejectedPackets++;
  }

  private sendCtrl(length: number): boolean {
    if (length <= 0) return false;
    if (!this.transport.send('ctrl', this.ctrlWriter.packet(length))) return false;
    this.stats.addSent(length);
    return true;
  }

  // --- Handshake -----------------------------------------------------------------------------------

  private onWelcome(reader: Reader): void {
    const welcome = this.welcomeIn;
    if (!decodeWelcome(reader, welcome) || welcome.lobbyState === null) {
      this.drop();
      return;
    }
    const wasInMatch = this.matchActive;
    this.playerId = welcome.playerId;
    this.lobbyState = welcome.lobbyState;
    if (welcome.reconnectToken.length > 0) {
      this.tokenStore.save(this.code, welcome.reconnectToken);
    }
    this.welcomeHostTick = welcome.hostTick;
    this.welcomeMs = this.nowMs;
    this.lastHeardMs = this.nowMs;
    this.helloSentMs = -1;
    this.nextAttemptMs = Infinity;
    this.sessionError = null;
    // A new link is a new path: measure it from scratch.
    this.clock.reset();
    this.nextPingMs = this.nowMs;
    // If a match is running the host says so right after this (MATCH_START); until then there
    // is none as far as this link knows.
    if (wasInMatch) this.endMatchLocal(welcome.lobbyState.phase === 'lobby');
    this.setStatus('connected');
    this.listener.onLobbyChanged?.(welcome.lobbyState);
  }

  private onReject(reader: Reader): void {
    const reject = this.rejectIn;
    if (!decodeReject(reader, reject)) {
      this.drop();
      return;
    }
    const reason: RejectReason = reject.reason;
    this.endMatchLocal(true);
    this.fail('rejected', { kind: 'rejected', reason });
    this.transport.close();
  }

  private onLobbyState(reader: Reader): void {
    const message = this.lobbyIn;
    if (!decodeLobbyState(reader, message) || message.lobbyState === null) {
      this.drop();
      return;
    }
    this.lobbyState = message.lobbyState;
    // Riders can leave mid-match; teams and classes cannot change, so this only prunes.
    if (this.matchActive) this.roster.setFromMatchRoster(buildMatchRoster(message.lobbyState));
    this.listener.onLobbyChanged?.(message.lobbyState);
  }

  // --- Match ---------------------------------------------------------------------------------------

  private onMatchStart(reader: Reader): void {
    const message = this.matchStartIn;
    if (!decodeMatchStart(reader, message)) {
      this.drop();
      return;
    }
    const lobby = this.lobbyState;
    if (lobby === null) return;
    const matchRoster = buildMatchRoster(lobby);
    this.roster.setFromMatchRoster(matchRoster);
    const me = matchRoster.riders.find((entry) => entry.playerId === this.playerId);

    this.matchSeedNow = message.seed;
    this.matchMapNow = message.map;
    this.matchStartTickNow = message.startTick;
    // Until the MATCH_PHASE that follows on the same channel says which (`intro`, or any phase
    // for a late joiner). Either way the dragons are held until `startTick`.
    this.matchPhaseNow = 'countdown';
    this.phaseStartTickNow = message.startTick;
    this.matchRoundNow = 1;
    this.matchWinnerNow = null;
    this.scores.count = 0;
    // An Ember Relay match says so in the RELAY that follows on the same channel.
    resetRelayState(this.relay);
    this.localCasts = 0;
    this.matchActive = true;
    this.rider = me !== undefined;
    this.started = false;
    this.accumulatorMs = 0;
    this.lastSnapshotTick = -1;
    this.hasOwnState = false;
    this.lossMarkMs = -1;
    this.lossPercent = 0;
    this.buffer.reset();
    this.timing.reset();
    this.bolts.reset();

    if (this.predict) {
      if (this.world === null || this.worldSeed !== message.seed || this.worldMap !== message.map) {
        // The map comes from MATCH_START itself, not from whichever lobby state arrived last.
        const settings =
          lobby.settings.map === message.map ? lobby.settings : { ...lobby.settings, map: message.map };
        this.world = this.createMatchWorld(settings, message.seed);
        this.worldSeed = message.seed;
        this.worldMap = message.map;
      }
      this.predictor.setCollisionWorld(this.world.collisionWorld);
    }
    if (me !== undefined) this.predictor.configure(me.playerId, me.team, me.classId);
    else this.predictor.configure(NO_PLAYER, 0, 'talon');
    this.predictor.setSimStartTick(message.startTick);

    this.listener.onMatchStart?.({
      seed: message.seed,
      map: message.map,
      startTick: message.startTick,
      world: this.predict ? this.world : null,
      isRider: this.rider,
    });
  }

  private onMatchPhase(reader: Reader): void {
    const message = this.matchPhaseIn;
    if (!decodeMatchPhase(reader, message)) {
      this.drop();
      return;
    }
    if (message.phase === 'lobby') {
      this.endMatchLocal(true);
      return;
    }
    if (!this.matchActive) return;
    this.matchPhaseNow = message.phase;
    this.phaseStartTickNow = message.phaseStartTick;
    this.matchRoundNow = message.round;
    this.matchWinnerNow = message.winner;
    if (message.phase === 'intro' || message.phase === 'countdown') {
      // The host holds every dragon at its gate and does not step the sim until the countdown
      // is over (every round has one; the first is preceded by the intro). Prediction must
      // stand still for the same ticks. The header's tick says when play begins (its low 16
      // bits), so a skipped intro or a retuned countdown needs no guessing here.
      const liveTick = expandTick(message.tick, message.phaseStartTick);
      const held = liveTick - message.phaseStartTick;
      if (held >= 0 && held <= HELD_MAX_TICKS) {
        this.matchStartTickNow = liveTick;
      } else if (message.phase === 'countdown') {
        // Not believable: the shipped countdown. (`intro` keeps what MATCH_START said.)
        this.matchStartTickNow =
          message.phaseStartTick + Math.round(MATCH_TUNING.countdownS * TICK_HZ);
      }
      this.predictor.setSimStartTick(this.matchStartTickNow);
      // A new round: last round's bolts are gone on the host too.
      if (message.phase === 'countdown') this.bolts.reset();
    } else if (message.phase === 'playing' || message.phaseStartTick < this.matchStartTickNow) {
      // `playing`: the authoritative end of the countdown. The other case is a match that was
      // decided while the dragons were still held (a team left): the host's sim runs from this
      // phase on, so prediction must too.
      this.matchStartTickNow = message.phaseStartTick;
      this.predictor.setSimStartTick(message.phaseStartTick);
    }
    this.listener.onMatchPhase?.(message.phase);
  }

  private endMatchLocal(notify: boolean): void {
    if (!this.matchActive) return;
    this.matchActive = false;
    this.started = false;
    this.rider = false;
    this.hasOwnState = false;
    this.matchPhaseNow = 'lobby';
    this.matchRoundNow = 1;
    this.matchWinnerNow = null;
    this.phaseStartTickNow = 0;
    this.lastSnapshotTick = -1;
    this.accumulatorMs = 0;
    this.lossPercent = 0;
    this.predictor.configure(NO_PLAYER, 0, 'talon');
    this.predictor.setSimStartTick(0);
    this.buffer.reset();
    this.timing.reset();
    this.roster.clear();
    resetRelayState(this.relay);
    if (notify) this.listener.onMatchEnd?.();
  }

  private onSnapshot(reader: Reader): void {
    if (!this.matchActive) return;
    const snapshot = this.snapshotIn;
    if (!decodeSnapshot(reader, snapshot)) {
      this.drop();
      return;
    }
    this.counters.snapshots++;
    const nowMs = this.clockNow !== null ? this.clockNow() : this.nowMs;
    // Reference for the 16-bit wire tick: clock sync once it has a sample, WELCOME before that.
    // `| 0`: a whole number in an int, so no float is boxed for the call (ticks stay far below
    // 2^31: that is two years at 30 Hz).
    const reference =
      (this.clock.sampleCount > 0
        ? this.clock.hostTickAt(nowMs)
        : this.welcomeHostTick + (nowMs - this.welcomeMs) / TICK_MS) | 0;
    const tick = this.buffer.push(snapshot, nowMs, reference);
    if (tick < 0 || tick <= this.lastSnapshotTick) return;
    // Loss: every scheduled send between the last snapshot handled and this one was expected.
    const previous = this.lastSnapshotTick;
    if (previous >= 0 && tick - previous <= LOSS_MAX_GAP_TICKS) {
      for (let t = previous + 1; t <= tick; t++) {
        if (shouldSendSnapshot(t)) this.lossExpected++;
      }
    } else {
      this.lossExpected++;
    }
    this.lossReceived++;
    this.lastSnapshotTick = tick;
    // The storm wall a mode moved: prediction must step against the wall the host uses.
    const world = this.world;
    if (world !== null && world.collisionWorld.setStormRadius !== undefined) {
      world.collisionWorld.setStormRadius(snapshot.stormRadius);
    }
    if (!this.rider) return;

    if (snapshot.hasOwner && snapshot.owner.id === this.playerId) {
      if (!this.predict) {
        copySnapshotOwner(this.ownState, snapshot.owner);
        this.hasOwnState = true;
      }
    } else {
      this.hasOwnState = false;
    }
    if (!this.started) return;

    this.timing.onSnapshot(snapshot.hasAck, snapshot.ackInputTick, snapshot.tick);
    if (this.predict) this.lastReconcile = this.predictor.reconcile(snapshot, tick);
    const resync = this.timing.resyncTicks;
    if (resync !== 0) {
      this.predictor.shiftTick(resync);
      this.timing.resyncApplied(this.clock.rttMs);
      this.counters.resyncs++;
    }
  }
}

export function createClientSession(options: ClientSessionOptions): ClientSession {
  return new ClientSession(options);
}
