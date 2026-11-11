/**
 * HostSession: the authority of a room (docs/NETWORKING.md). It owns the lobby state machine,
 * the match sim and one link per client, and is the only place where anything a client sent is
 * turned into state. Clients send inputs and intents, never state; everything received is
 * decoded by the codec (which range-checks), then validated again by the lobby operations and
 * the input buffers before it is used.
 *
 * DRIVING IT. No timers, no clock reads, no DOM: the caller drives two entry points, so tests,
 * net-bots and a Web Worker all run it the same way.
 * - `update(nowMs)`: once per frame (or per pump). Wall-clock housekeeping: handshake and
 *   silence timeouts, delayed closes, byte rates.
 * - `tick(localInput)`: once per fixed 30 Hz step (the caller's `FixedStepLoop`). Advances the
 *   host tick, the lobby (held seats expiring), the match (inputs -> sim -> snapshots) and
 *   flushes what the tick produced (events, one coalesced LOBBY_STATE).
 * Transport callbacks (messages, links opening and closing) may arrive at any time in between.
 *
 * ONE TICK COUNTER. `hostTick` counts fixed steps since the session was created and never wraps.
 * It is the lobby tick (reconnect deadlines, rate limiter), the sim tick (`sim.current.tick`)
 * and the tick WELCOME, PONG, MATCH_START and every snapshot refer to.
 *
 * THE HOST PLAYS TOO. The host's own player (id 0) has no link: its intents go through
 * `applyIntent` and its input is the argument of `tick`. The game layer renders `sim.prev` /
 * `sim.current` directly, with zero network delay.
 *
 * MATCH (Phase 2: everyone flies together). `host.start` -> roster -> `MatchWorld` -> dragons
 * spawned at their gate slots and held there for `countdownTicks` -> `playing`. MATCH_START
 * carries the first simulated tick, so clients know in advance when control is handed over and
 * their input timing has settled by then. A dragon killed by terrain or the storm respawns at
 * its gate after `respawnTicks`. Combat, scoring and round flow are Phase 3: they hook into
 * `stepMatch` (after `sim.step`), `emitEvent` and `setMatchPhase`.
 */

import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_IN_STORM,
  NO_PLAYER,
  PROTOCOL_VERSION,
  TICK_DT_S,
  TICK_HZ,
  createInputFrame,
  createVec3,
} from '../../shared';
import type {
  DragonClassId,
  GameEvent,
  GameEventSink,
  HostSettings,
  InputFrame,
  LobbyState,
  MatchPhase,
  MatchPhaseEvent,
  MatchRoster,
  MutableVec3,
  PlayerId,
  SpawnEvent,
  TakedownEvent,
  TeamId,
  UiIntent,
} from '../../shared';
import { createSim } from '../../sim';
import type { Sim } from '../../sim';
import {
  applyLobbyIntent,
  canStart,
  createIntentRateLimiter,
  createLobby,
  disconnectPlayer,
  enterMatch,
  expireReconnects,
  findLobbyPlayer,
  handleHello,
  nextReconnectDeadline,
  resetIntentRateLimiter,
  returnToLobby,
  setRoomCode,
} from '../../sim/lobby';
import type {
  HostLobby,
  IntentRateLimiter,
  LobbyResult,
  PlayerRemovalCause,
  StartBlocker,
} from '../../sim/lobby';
import {
  decodeHello,
  decodeIntent,
  decodePing,
  encodeHostLeft,
  encodeKick,
  encodeLobbyState,
  encodeMatchPhase,
  encodeMatchStart,
  encodePong,
  encodeReject,
  encodeWelcome,
  isNetIntent,
} from '../codec/ctrl';
import { beginGameEvents, endGameEvents, writeGameEvent } from '../codec/events';
import { decodeInput, encodeSnapshot } from '../codec/fast';
import { Reader, Writer } from '../codec/io';
import { HostInputBuffer } from '../prediction/host-input-buffer';
import {
  CTRL_MAX_BYTES,
  FAST_MAX_BYTES,
  INPUT_MAX_BYTES,
  MSG_HELLO,
  MSG_INPUT,
  MSG_INTENT,
  MSG_PING,
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
  createWelcomeMessage,
  isClientToHostMessage,
  isFastMessage,
} from '../protocol';
import { generateRoomCode } from '../room-code';
import type { RandomSource } from '../room-code';
import { HostSnapshotBuilder, createSnapshotClock, shouldSendSnapshot } from '../snapshot';
import type { SnapshotClock } from '../snapshot';
import type {
  Channel,
  DisconnectReason,
  HostTransport,
  HostTransportHandlers,
  LinkId,
  TransportError,
  TransportMessage,
} from '../transport/transport';
import {
  DEFAULT_MATCH_SEED,
  greyboxMatchWorldFactory,
  spawnPointOf,
  spawnYawOf,
} from './match-world';
import type { MatchWorld, MatchWorldFactory } from './match-world';
import { NetRate } from './net-rate';
import { addPlayerPing, createPlayerPingsMessage, encodePlayerPings } from './pings';
import { steerToCourse } from './pilot';
import type { PilotCourse } from './pilot';
import { ViewCache, createReconnectToken, rttFromWire } from './wire';

// --- Tunables ------------------------------------------------------------------------------------

/** A link that has not sent a valid HELLO after this long is closed. */
export const HOST_HELLO_TIMEOUT_MS = 5000;
/**
 * A welcomed link that has been silent this long is closed and its seat held for a reconnect.
 * Clients ping at 2 Hz, so this is ten missed pings; WebRTC alone needs 15-30 s to notice.
 */
export const HOST_LINK_TIMEOUT_MS = 6000;
/**
 * A HELLO whose token matches a seat that still has a link takes the seat over only if that
 * link has been silent this long (the player's old connection died and the host has not noticed
 * yet). A link heard from more recently is a second tab with a copied token: it joins fresh.
 */
export const HOST_STALE_LINK_MS = 1500;
/** REJECT and KICK are followed by a close this much later, so the message gets out first. */
export const HOST_CLOSE_GRACE_MS = 250;
/** Room codes tried before `open` gives up on `idTaken`. */
export const HOST_ROOM_CODE_ATTEMPTS = 6;
/** Dragons are held at their gates this long after Start (3 s). */
export const DEFAULT_COUNTDOWN_TICKS = 3 * TICK_HZ;
/** A dead dragon keeps falling this long before it is back at its gate (sandbox rule, 2 s). */
export const DEFAULT_RESPAWN_TICKS = 2 * TICK_HZ;
/**
 * A gap this long between two `update` calls means the host page was not running (hidden tab,
 * debugger, a long stall). Messages that arrived meanwhile were stamped with the time of the
 * last `update`, so without a correction every link would look silent for the whole gap and be
 * closed at once on return. The gap is added to every link's timestamps instead: time the host
 * was not listening is not silence.
 */
export const HOST_STALL_MS = 1000;
/** PINGs answered per link per second; more are dropped (a ping costs the host a reply). */
export const HOST_MAX_PINGS_PER_S = 20;

/** Circle a disconnected rider's dragon is flown on while its seat is held. */
const HOLD_RADIUS_FRACTION = 0.4;
const HOLD_ALTITUDE_FRACTION = 0.55;

const PLAYER_SLOTS = 256;

// --- Public types --------------------------------------------------------------------------------

export type HostSessionState = 'idle' | 'opening' | 'open' | 'closed';

export interface HostMatchInfo {
  readonly roster: MatchRoster;
  readonly world: MatchWorld;
  readonly seed: number;
  /** First host tick the sim steps (the countdown ends). */
  readonly startTick: number;
}

/** Optional callbacks; every one may be left out. Called synchronously from `tick`, `update`,
 * `applyIntent` or a transport callback. */
export interface HostSessionListener {
  onStateChange?(state: HostSessionState): void;
  /** Opening the room failed for good, or the signaling server was lost (non-fatal). */
  onError?(error: TransportError): void;
  /** The public lobby state was replaced (a new object every time). */
  onLobbyChanged?(lobby: LobbyState): void;
  onPlayerJoined?(playerId: PlayerId, reconnected: boolean): void;
  onPlayerRemoved?(playerId: PlayerId, cause: PlayerRemovalCause): void;
  /** Dragons are spawned and held; load the map views now. */
  onMatchStart?(info: HostMatchInfo): void;
  onMatchPhase?(phase: MatchPhase): void;
  /** Back in the lobby; `sim` is null again. */
  onMatchEnd?(): void;
}

export interface HostSessionOptions {
  readonly transport: HostTransport;
  readonly hostName: string;
  readonly settings?: HostSettings;
  readonly listener?: HostSessionListener;
  /** The host's own event bus: every GameEvent the match produces is emitted here too. */
  readonly events?: GameEventSink;
  /** Builds the map side of a match. Default: the greybox map with terrain collision. */
  readonly createMatchWorld?: MatchWorldFactory;
  /** Layout seed sent in MATCH_START. Default: the greybox default layout. */
  readonly mapSeed?: number;
  /** Fixed room code (tests). Default: generated, with a new one on `idTaken`. */
  readonly roomCode?: string;
  /** Randomness for room codes, tokens and shuffle seeds. Default: crypto / `Math.random`. */
  readonly random?: RandomSource;
  /**
   * The same clock `update` is given, readable at any moment (e.g. `() => performance.now()`).
   * Messages arrive between two `update` calls; with this their timestamps are exact instead of
   * rounded down to the last frame, which matters for the ping shown and for clock sync. Left
   * out (tests, net-bots), the time of the last `update` is used and nothing is read.
   */
  readonly now?: () => number;
  /**
   * High-resolution clock in ms for the per-tick cost numbers in `timing` (e.g.
   * `() => performance.now()`). Left out, nothing is measured and nothing is read.
   */
  readonly profileClock?: () => number;
  /** The transport recycles delivered buffers (loopback / netsim): cache their DataViews. */
  readonly recycledBuffers?: boolean;
  readonly countdownTicks?: number;
  readonly respawnTicks?: number;
  readonly helloTimeoutMs?: number;
  readonly linkTimeoutMs?: number;
  readonly staleLinkMs?: number;
  readonly closeGraceMs?: number;
}

/** Host cost per tick in microseconds, from `profileClock`. All zero when no clock was given. */
export interface HostTickTiming {
  /** Ticks measured since the last `resetTiming`. */
  ticks: number;
  /** The latest tick. */
  lastInputsUs: number;
  lastSimUs: number;
  lastSnapshotUs: number;
  lastTotalUs: number;
  /** Sums over `ticks`, for averages. */
  sumInputsUs: number;
  sumSimUs: number;
  sumSnapshotUs: number;
  sumTotalUs: number;
  maxTotalUs: number;
}

/** Counters of things the host refused, for the debug HUD and the tests. */
export interface HostSessionCounters {
  /** Messages dropped unread: not binary, too large, wrong type or channel, failed decode. */
  malformed: number;
  /** Intents refused by the lobby (not host, rate limited, wrong phase, ...). */
  intentsRefused: number;
  /** PINGs dropped by the per-link budget. */
  pingsDropped: number;
  rejectedHellos: number;
  helloTimeouts: number;
  linkTimeouts: number;
}

// --- Internals -----------------------------------------------------------------------------------

/** Host-side state of one client link. */
class HostPeer {
  playerId: PlayerId = NO_PLAYER;
  lastHeardMs: number;
  /** >= 0: the link is being shut (REJECT / KICK sent); close it at this time. */
  closeAtMs = -1;
  /** The ping budget: how many were answered in the one-second window that began at the mark. */
  pingsThisSecond = 0;
  pingWindowMs: number;
  readonly inputs = new HostInputBuffer();

  constructor(
    readonly link: LinkId,
    public connectedAtMs: number,
  ) {
    this.lastHeardMs = connectedAtMs;
    this.pingWindowMs = connectedAtMs;
  }
}

interface MatchRider {
  playerId: PlayerId;
  team: TeamId;
  classId: DragonClassId;
  gateSlot: number;
  wasAlive: boolean;
  deadTicks: number;
}

interface HostMatch {
  roster: MatchRoster;
  world: MatchWorld;
  seed: number;
  startTick: number;
  phase: MatchPhase;
  phaseStartTick: number;
  riders: MatchRider[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class HostSession {
  /** Bytes and packets over all links. */
  readonly stats = new NetRate();
  readonly timing: HostTickTiming = {
    ticks: 0,
    lastInputsUs: 0,
    lastSimUs: 0,
    lastSnapshotUs: 0,
    lastTotalUs: 0,
    sumInputsUs: 0,
    sumSimUs: 0,
    sumSnapshotUs: 0,
    sumTotalUs: 0,
    maxTotalUs: 0,
  };
  readonly counters: HostSessionCounters = {
    malformed: 0,
    intentsRefused: 0,
    pingsDropped: 0,
    rejectedHellos: 0,
    helloTimeouts: 0,
    linkTimeouts: 0,
  };
  /**
   * Round trip per player in ms, indexed by PlayerId; -1 = unknown, 0 for the host itself.
   * Mutated in place: hand it to `UiState.playerPings` as it is.
   */
  readonly playerPings: number[] = [];
  /** The match clock as snapshots carry it; valid while `inMatch`. */
  readonly matchClock: SnapshotClock = createSnapshotClock();

  private readonly transport: HostTransport;
  private readonly listener: HostSessionListener;
  private readonly events: GameEventSink | null;
  private readonly createMatchWorld: MatchWorldFactory;
  private readonly mapSeed: number;
  private readonly fixedRoomCode: string | null;
  private readonly random: RandomSource | undefined;
  private readonly profileClock: (() => number) | null;
  private readonly clockNow: (() => number) | null;
  private readonly countdownTicks: number;
  private readonly respawnTicks: number;
  private readonly helloTimeoutMs: number;
  private readonly linkTimeoutMs: number;
  private readonly staleLinkMs: number;
  private readonly closeGraceMs: number;

  private sessionState: HostSessionState = 'idle';
  private lastError: TransportError | null = null;
  private codeAttempts = 0;
  private nowMs = 0;
  /** False until the first `update`: the first call has no previous time to measure a gap from. */
  private updated = false;
  private rateMarkMs = -1;
  private tickNow = 0;
  private shuffleCounter = 0;

  private hostLobby: HostLobby;
  private lobbyDirty = false;
  private readonly limiter: IntentRateLimiter = createIntentRateLimiter();

  private readonly peers: HostPeer[] = [];
  private readonly peerByLink = new Map<LinkId, HostPeer>();
  private readonly peerByPlayer: (HostPeer | undefined)[] = [];

  private simInstance: Sim | null = null;
  private match: HostMatch | null = null;
  private readonly simInputs: (Readonly<InputFrame> | undefined)[] = [];
  private readonly holdFrame = createInputFrame();
  private readonly holdCourse: PilotCourse = {
    centerX: 0,
    centerZ: 0,
    radius: 400,
    altitude: 350,
    yawBias: 0,
    pitchBias: 0,
  };
  private readonly snapshots = new HostSnapshotBuilder();

  // Codec scratch: one of each, reused for every message.
  private readonly views: ViewCache;
  private readonly reader = new Reader();
  private readonly fastWriter = new Writer(FAST_MAX_BYTES);
  private readonly ctrlWriter = new Writer(CTRL_MAX_BYTES);
  private readonly eventWriter = new Writer(CTRL_MAX_BYTES);
  private eventsOpen = false;
  private readonly inputIn = createInputMessage();
  private readonly helloIn = createHelloMessage();
  private readonly intentIn = createIntentMessage();
  private readonly pingIn = createPingMessage();
  private readonly pongOut = createPongMessage();
  private readonly welcomeOut = createWelcomeMessage();
  private readonly rejectOut = createRejectMessage();
  private readonly lobbyOut = createLobbyStateMessage();
  private readonly matchStartOut = createMatchStartMessage();
  private readonly matchPhaseOut = createMatchPhaseMessage();
  private readonly noticeOut = createNoticeMessage();
  private readonly pingsOut = createPlayerPingsMessage();

  // Event scratch (the sink copies on emit).
  private readonly eventPosition: MutableVec3 = createVec3();
  private readonly spawnEvent: Mutable<SpawnEvent>;
  private readonly takedownEvent: Mutable<TakedownEvent>;
  private readonly phaseEvent: Mutable<MatchPhaseEvent> = {
    type: 'matchPhase',
    tick: 0,
    phase: 'lobby',
    round: 1,
    winner: null,
  };

  private readonly handlers: HostTransportHandlers;

  constructor(options: HostSessionOptions) {
    this.transport = options.transport;
    this.listener = options.listener ?? {};
    this.events = options.events ?? null;
    this.createMatchWorld = options.createMatchWorld ?? greyboxMatchWorldFactory;
    this.mapSeed = options.mapSeed ?? DEFAULT_MATCH_SEED;
    this.fixedRoomCode = options.roomCode ?? null;
    this.random = options.random;
    this.profileClock = options.profileClock ?? null;
    this.clockNow = options.now ?? null;
    this.countdownTicks = Math.max(
      0,
      Math.floor(options.countdownTicks ?? DEFAULT_COUNTDOWN_TICKS),
    );
    this.respawnTicks = Math.max(1, Math.floor(options.respawnTicks ?? DEFAULT_RESPAWN_TICKS));
    this.helloTimeoutMs = options.helloTimeoutMs ?? HOST_HELLO_TIMEOUT_MS;
    this.linkTimeoutMs = options.linkTimeoutMs ?? HOST_LINK_TIMEOUT_MS;
    this.staleLinkMs = options.staleLinkMs ?? HOST_STALE_LINK_MS;
    this.closeGraceMs = options.closeGraceMs ?? HOST_CLOSE_GRACE_MS;
    this.views = new ViewCache(options.recycledBuffers === true);

    this.hostLobby = createLobby(
      options.settings !== undefined
        ? { roomCode: '', hostName: options.hostName, settings: options.settings }
        : { roomCode: '', hostName: options.hostName },
    );
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      this.playerPings.push(-1);
      this.peerByPlayer.push(undefined);
      this.simInputs.push(undefined);
    }
    this.playerPings[this.hostLobby.state.hostId] = 0;

    this.spawnEvent = {
      type: 'spawn',
      tick: 0,
      dragonId: NO_PLAYER,
      team: 0,
      classId: 'talon',
      position: this.eventPosition,
    };
    this.takedownEvent = {
      type: 'takedown',
      tick: 0,
      killerId: NO_PLAYER,
      victimId: NO_PLAYER,
      source: 'terrain',
      position: this.eventPosition,
    };

    this.handlers = {
      onOpen: (roomCode) => this.onTransportOpen(roomCode),
      onError: (error) => this.onTransportError(error),
      onPeerConnected: (link) => this.onPeerConnected(link),
      onPeerDisconnected: (link, reason) => this.onPeerDisconnected(link, reason),
      onMessage: (link, channel, data) => this.onMessage(link, channel, data),
    };
    this.transport.setHandlers(this.handlers);
  }

  // --- State the game layer reads ----------------------------------------------------------------

  get state(): HostSessionState {
    return this.sessionState;
  }

  /** The last transport error (a fatal one closed the session). */
  get error(): TransportError | null {
    return this.lastError;
  }

  /** '' until the room is registered. */
  get roomCode(): string {
    return this.hostLobby.state.roomCode;
  }

  /** The public lobby state. Replaced, never mutated: compare by identity to detect a change. */
  get lobby(): LobbyState {
    return this.hostLobby.state;
  }

  get localPlayerId(): PlayerId {
    return this.hostLobby.state.hostId;
  }

  /** Fixed steps run so far: the tick of the latest `tick()` call. */
  get hostTick(): number {
    return this.tickNow;
  }

  get inMatch(): boolean {
    return this.match !== null;
  }

  /** The authoritative sim (`prev` / `current` for the host's own view); null outside a match. */
  get sim(): Sim | null {
    return this.match !== null ? this.simInstance : null;
  }

  get matchWorld(): MatchWorld | null {
    return this.match?.world ?? null;
  }

  /** `lobby` outside a match. */
  get matchPhase(): MatchPhase {
    return this.match?.phase ?? 'lobby';
  }

  get matchStartTick(): number {
    return this.match?.startTick ?? -1;
  }

  /** Links that completed the handshake. */
  get clientCount(): number {
    let count = 0;
    for (let i = 0; i < this.peers.length; i++) {
      const peer = this.peers[i];
      if (peer !== undefined && peer.playerId !== NO_PLAYER) count++;
    }
    return count;
  }

  /** Why Start is unavailable, or null when the host may start (for `UiState.startBlocker`). */
  startBlocker(): StartBlocker | null {
    const check = canStart(this.hostLobby.state);
    return check.ok ? null : check.reason;
  }

  /** Ticks of input the host holds beyond the current tick for a client; 0 for unknown players. */
  inputMarginOf(playerId: PlayerId): number {
    const peer = this.peerByPlayer[playerId];
    return peer === undefined ? 0 : peer.inputs.margin(this.tickNow);
  }

  /** The player's input buffer (counters for tests and the debug HUD), or null. */
  inputBufferOf(playerId: PlayerId): HostInputBuffer | null {
    return this.peerByPlayer[playerId]?.inputs ?? null;
  }

  resetTiming(): void {
    const timing = this.timing;
    timing.ticks = 0;
    timing.lastInputsUs = 0;
    timing.lastSimUs = 0;
    timing.lastSnapshotUs = 0;
    timing.lastTotalUs = 0;
    timing.sumInputsUs = 0;
    timing.sumSimUs = 0;
    timing.sumSnapshotUs = 0;
    timing.sumTotalUs = 0;
    timing.maxTotalUs = 0;
  }

  // --- Lifecycle ---------------------------------------------------------------------------------

  /**
   * Registers the room with the signaling server. Answers through `state` / the listener: `open`
   * with a room code, or `closed` with `error` set. A taken code is retried with a new one.
   */
  open(): void {
    if (this.sessionState !== 'idle') return;
    this.codeAttempts = 0;
    this.setState('opening');
    this.openWithNewCode();
  }

  /**
   * Ends the room: every client is told HOST_LEFT and the transport is released. Final. Safe to
   * call from `pagehide`.
   */
  close(): void {
    if (this.sessionState === 'closed') return;
    const length = encodeHostLeft(this.ctrlWriter, this.noticeOut);
    if (length > 0) {
      for (let i = 0; i < this.peers.length; i++) {
        const peer = this.peers[i];
        if (peer !== undefined && peer.playerId !== NO_PLAYER) {
          this.sendRaw(peer, 'ctrl', this.ctrlWriter, length);
        }
      }
    }
    this.transport.dispose();
    this.peers.length = 0;
    this.peerByLink.clear();
    this.peerByPlayer.fill(undefined);
    this.match = null;
    this.setState('closed');
  }

  /** Same as `close`. */
  dispose(): void {
    this.close();
  }

  // --- The host's own player -----------------------------------------------------------------------

  /**
   * Applies an intent of the host's own UI. Lobby and host intents go through the same
   * `applyLobbyIntent` as a client's; `lobby.leave` closes the room. Anything else (title,
   * settings, match menu) is not the session's business and returns false.
   */
  applyIntent(intent: UiIntent): boolean {
    if (this.sessionState === 'closed' || !isNetIntent(intent)) return false;
    const result = applyLobbyIntent(this.hostLobby, this.hostLobby.state.hostId, intent, {
      tick: this.tickNow,
      seed: this.nextSeed(),
    });
    return this.handleResult(result);
  }

  /**
   * Marks a seated player as an in-page net-bot (`?bots=N`): shown with a Bot badge, never
   * blocks Start on its ready flag, and its seat is not held when its link drops.
   */
  setPlayerIsBot(playerId: PlayerId, isBot: boolean): boolean {
    const state = this.hostLobby.state;
    const player = findLobbyPlayer(state, playerId);
    if (player === undefined || player.isHost || player.isBot === isBot) return false;
    const players = state.players.map((other) =>
      other.id === playerId ? { ...other, isBot } : other,
    );
    this.hostLobby = { ...this.hostLobby, state: { ...state, players } };
    this.markLobbyDirty();
    return true;
  }

  /** Ends the running match and takes everyone back to the lobby. False when no match runs. */
  endMatch(): boolean {
    const match = this.match;
    if (match === null) return false;
    this.setMatchPhase(match, 'lobby', this.tickNow + 1);
    this.flushEvents();
    this.match = null;
    this.simInstance?.reset();
    this.simInstance?.setCollisionWorld(null);
    this.handleResult(returnToLobby(this.hostLobby));
    this.listener.onMatchEnd?.();
    return true;
  }

  // --- Driving -----------------------------------------------------------------------------------

  /** Wall-clock housekeeping. `nowMs` is any monotonic millisecond clock, the same every call. */
  update(nowMs: number): void {
    const gap = nowMs - this.nowMs;
    const stalled = this.updated && gap >= HOST_STALL_MS;
    this.updated = true;
    this.nowMs = nowMs;
    if (this.sessionState === 'closed') return;
    this.stats.update(nowMs);
    if (stalled) {
      for (let i = 0; i < this.peers.length; i++) {
        const peer = this.peers[i];
        if (peer === undefined) continue;
        peer.lastHeardMs += gap;
        peer.connectedAtMs += gap;
        if (peer.closeAtMs >= 0) peer.closeAtMs += gap;
      }
    }

    const newSecond = this.rateMarkMs < 0 || nowMs - this.rateMarkMs >= 1000;
    if (newSecond) {
      this.rateMarkMs = nowMs;
      this.broadcastPings();
    }

    // Backwards: closing a link removes its peer from the list (swap with the last one).
    for (let i = this.peers.length - 1; i >= 0; i--) {
      const peer = this.peers[i];
      if (peer === undefined) continue;
      if (peer.closeAtMs >= 0) {
        if (nowMs >= peer.closeAtMs) this.transport.close(peer.link);
      } else if (peer.playerId === NO_PLAYER) {
        if (nowMs - peer.connectedAtMs >= this.helloTimeoutMs) {
          this.counters.helloTimeouts++;
          this.transport.close(peer.link);
        }
      } else if (nowMs - peer.lastHeardMs >= this.linkTimeoutMs) {
        this.counters.linkTimeouts++;
        this.transport.close(peer.link);
      }
    }
  }

  /**
   * One fixed step. `localInput` is the host player's input for this tick (omit it while the
   * host has no dragon or no input: the dragon then flies straight). `localAway` = nobody is at
   * the host's controls (its page stopped sending input, e.g. a hidden tab while the sim runs
   * in a worker): the host's dragon is then flown on the holding circle like a held seat's.
   */
  tick(localInput?: Readonly<InputFrame>, localAway = false): void {
    if (this.sessionState === 'closed') return;
    const tick = ++this.tickNow;

    if (nextReconnectDeadline(this.hostLobby.state) <= tick) {
      this.handleResult(expireReconnects(this.hostLobby, tick));
    }

    const match = this.match;
    if (match !== null) this.stepMatch(match, tick, localInput, localAway);

    this.flushEvents();
    if (this.lobbyDirty) this.broadcastLobby();
  }

  // --- Match -------------------------------------------------------------------------------------

  private beginMatch(roster: MatchRoster): void {
    const seed = this.mapSeed >>> 0;
    const world = this.createMatchWorld(roster.settings, seed);
    let sim = this.simInstance;
    if (sim === null) {
      sim = createSim({ collisionWorld: world.collisionWorld });
      this.simInstance = sim;
    } else {
      sim.reset();
      sim.setCollisionWorld(world.collisionWorld);
    }

    const firstTick = this.tickNow + 1;
    const match: HostMatch = {
      roster,
      world,
      seed,
      startTick: firstTick + this.countdownTicks,
      phase: 'countdown',
      phaseStartTick: firstTick,
      riders: [],
    };
    this.match = match;
    this.holdCourse.centerX = world.centerX;
    this.holdCourse.centerZ = world.centerZ;
    this.holdCourse.radius = world.radius * HOLD_RADIUS_FRACTION;
    this.holdCourse.altitude =
      world.floorY + (world.ceilingY - world.floorY) * HOLD_ALTITUDE_FRACTION;

    for (let i = 0; i < this.peers.length; i++) this.peers[i]?.inputs.reset();
    this.simInputs.fill(undefined);

    // Clients build their roster (teams, classes, their own dragon's class for prediction) from
    // the lobby state they hold when MATCH_START arrives, so the state this roster was made
    // from goes out first, not at the end of the tick.
    if (this.lobbyDirty) this.broadcastLobby();
    // MATCH_START goes out before the spawn events so a client has its roster when they arrive.
    for (let i = 0; i < this.peers.length; i++) {
      const peer = this.peers[i];
      if (peer !== undefined && peer.playerId !== NO_PLAYER) this.sendMatchState(peer, match);
    }

    for (const entry of roster.riders) {
      const rider: MatchRider = {
        playerId: entry.playerId,
        team: entry.team,
        classId: entry.classId,
        gateSlot: entry.gateSlot,
        wasAlive: true,
        deadTicks: 0,
      };
      match.riders.push(rider);
      this.spawnRider(match, sim, rider, firstTick);
    }
    this.emitPhaseEvent(match);
    this.updateMatchClock(match, this.tickNow);
    this.listener.onMatchStart?.({ roster, world, seed, startTick: match.startTick });
    this.listener.onMatchPhase?.(match.phase);
  }

  private spawnRider(match: HostMatch, sim: Sim, rider: MatchRider, tick: number): void {
    const point = spawnPointOf(match.world, rider.team, rider.gateSlot);
    const dragon = sim.spawnDragon(
      rider.playerId,
      rider.team,
      rider.classId,
      point,
      spawnYawOf(match.world, rider.team),
    );
    rider.wasAlive = dragon !== null;
    rider.deadTicks = 0;
    if (dragon === null) return;
    const event = this.spawnEvent;
    event.tick = tick;
    event.dragonId = rider.playerId;
    event.team = rider.team;
    event.classId = rider.classId;
    this.eventPosition.x = point.x;
    this.eventPosition.y = point.y;
    this.eventPosition.z = point.z;
    this.emitEvent(event);
  }

  private stepMatch(
    match: HostMatch,
    tick: number,
    localInput: Readonly<InputFrame> | undefined,
    localAway: boolean,
  ): void {
    const sim = this.simInstance;
    if (sim === null) return;
    const clock = this.profileClock;
    const t0 = clock !== null ? clock() : 0;

    if (match.phase === 'countdown' && tick >= match.startTick) {
      this.setMatchPhase(match, 'playing', tick);
      this.handleResult(enterMatch(this.hostLobby));
    }
    const playing = match.phase === 'playing';

    // --- Inputs: exactly one per rider per tick ------------------------------------------------
    const hostId = this.hostLobby.state.hostId;
    const riders = match.riders;
    for (let i = 0; i < riders.length; i++) {
      const rider = riders[i];
      if (rider === undefined) continue;
      const id = rider.playerId;
      let input: Readonly<InputFrame> | undefined;
      if (id === hostId) {
        input = localAway && playing ? this.holdingInput(sim, id, tick) : localInput;
      } else {
        const peer = this.peerByPlayer[id];
        if (peer !== undefined) {
          // Taken during the countdown too, so the buffer and its ack keep moving and the
          // client's input timing has settled when control is handed over.
          input = peer.inputs.take(tick);
        } else if (playing) {
          input = this.holdingInput(sim, id, tick);
        }
      }
      this.simInputs[id] = playing ? input : undefined;
    }
    const t1 = clock !== null ? clock() : 0;

    // --- Sim -------------------------------------------------------------------------------------
    if (playing) {
      sim.step(tick, this.simInputs);
      this.afterStep(match, sim, tick);
      // Phase 3: projectiles, hits, lag compensation and scoring go here.
    }
    this.updateMatchClock(match, tick);
    const t2 = clock !== null ? clock() : 0;

    // --- Snapshots -------------------------------------------------------------------------------
    if (shouldSendSnapshot(tick)) {
      const builder = this.snapshots;
      builder.begin(sim.current, this.matchClock);
      // The sim's own tick stands still during the countdown; the host tick does not.
      builder.message.tick = tick & 0xffff;
      const peers = this.peers;
      for (let i = 0; i < peers.length; i++) {
        const peer = peers[i];
        if (peer === undefined || peer.playerId === NO_PLAYER || peer.closeAtMs >= 0) continue;
        const inputs = peer.inputs;
        const message = builder.forRecipient(peer.playerId, inputs.hasAck, inputs.ackTick);
        const length = encodeSnapshot(this.fastWriter, message);
        if (length > 0) this.sendRaw(peer, 'fast', this.fastWriter, length);
      }
    }

    if (clock !== null) {
      const t3 = clock();
      const timing = this.timing;
      timing.ticks++;
      timing.lastInputsUs = (t1 - t0) * 1000;
      timing.lastSimUs = (t2 - t1) * 1000;
      timing.lastSnapshotUs = (t3 - t2) * 1000;
      timing.lastTotalUs = (t3 - t0) * 1000;
      timing.sumInputsUs += timing.lastInputsUs;
      timing.sumSimUs += timing.lastSimUs;
      timing.sumSnapshotUs += timing.lastSnapshotUs;
      timing.sumTotalUs += timing.lastTotalUs;
      if (timing.lastTotalUs > timing.maxTotalUs) timing.maxTotalUs = timing.lastTotalUs;
    }
  }

  /** A held seat's dragon circles the arena instead of flying straight into the storm. */
  private holdingInput(sim: Sim, id: PlayerId, tick: number): Readonly<InputFrame> | undefined {
    const dragon = sim.getDragon(id);
    if (dragon === undefined || (dragon.flags & DRAGON_FLAG_ALIVE) === 0) return undefined;
    const frame = this.holdFrame;
    frame.tick = tick;
    frame.buttons = 0;
    return steerToCourse(dragon, this.holdCourse, frame);
  }

  /** Deaths and respawns. Phase 3 replaces this with the real takedown and respawn rules. */
  private afterStep(match: HostMatch, sim: Sim, tick: number): void {
    const riders = match.riders;
    for (let i = 0; i < riders.length; i++) {
      const rider = riders[i];
      if (rider === undefined) continue;
      const dragon = sim.getDragon(rider.playerId);
      if (dragon === undefined) {
        this.spawnRider(match, sim, rider, tick);
        continue;
      }
      const alive = (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
      if (alive) {
        rider.wasAlive = true;
        rider.deadTicks = 0;
        continue;
      }
      if (rider.wasAlive) {
        rider.wasAlive = false;
        rider.deadTicks = 0;
        const event = this.takedownEvent;
        event.tick = tick;
        event.killerId = NO_PLAYER;
        event.victimId = rider.playerId;
        event.source = (dragon.flags & DRAGON_FLAG_IN_STORM) !== 0 ? 'storm' : 'terrain';
        this.eventPosition.x = dragon.position.x;
        this.eventPosition.y = dragon.position.y;
        this.eventPosition.z = dragon.position.z;
        this.emitEvent(event);
      }
      if (++rider.deadTicks >= this.respawnTicks) this.spawnRider(match, sim, rider, tick);
    }
  }

  private updateMatchClock(match: HostMatch, tick: number): void {
    const clock = this.matchClock;
    clock.phase = match.phase;
    clock.round = 1;
    const elapsed = tick - match.phaseStartTick + 1;
    clock.phaseTimeS = (elapsed > 0 ? elapsed : 0) * TICK_DT_S;
    // Phase 3 owns the time limit and the scores.
    clock.timeRemainingS = Infinity;
    clock.scoreEmber = 0;
    clock.scoreFrost = 0;
  }

  private setMatchPhase(match: HostMatch, phase: MatchPhase, tick: number): void {
    match.phase = phase;
    match.phaseStartTick = tick;
    const message = this.matchPhaseOut;
    message.tick = tick & 0xffff;
    message.phaseStartTick = tick;
    message.phase = phase;
    message.round = 1;
    message.winner = null;
    this.broadcastCtrl(encodeMatchPhase(this.ctrlWriter, message));
    this.emitPhaseEvent(match);
    this.listener.onMatchPhase?.(phase);
  }

  private emitPhaseEvent(match: HostMatch): void {
    const event = this.phaseEvent;
    event.tick = match.phaseStartTick;
    event.phase = match.phase;
    event.round = 1;
    event.winner = null;
    this.emitEvent(event);
  }

  /** Tells one client about the running match (at Start, and to whoever joins mid-match). */
  private sendMatchState(peer: HostPeer, match: HostMatch): void {
    const start = this.matchStartOut;
    start.tick = this.tickNow & 0xffff;
    start.startTick = match.startTick;
    start.seed = match.seed;
    this.sendRaw(peer, 'ctrl', this.ctrlWriter, encodeMatchStart(this.ctrlWriter, start));
    const phase = this.matchPhaseOut;
    phase.tick = this.tickNow & 0xffff;
    phase.phaseStartTick = match.phaseStartTick;
    phase.phase = match.phase;
    phase.round = 1;
    phase.winner = null;
    this.sendRaw(peer, 'ctrl', this.ctrlWriter, encodeMatchPhase(this.ctrlWriter, phase));
  }

  private removeRider(playerId: PlayerId): void {
    const match = this.match;
    if (match === null) return;
    const riders = match.riders;
    for (let i = 0; i < riders.length; i++) {
      if (riders[i]?.playerId === playerId) {
        riders.splice(i, 1);
        break;
      }
    }
    this.simInstance?.despawnDragon(playerId);
    this.simInputs[playerId] = undefined;
  }

  // --- Events ------------------------------------------------------------------------------------

  /**
   * Hands a GameEvent to the host's own bus and queues it for every client (reliable, sent at
   * the end of the tick). The event object may be reused by the caller straight away.
   */
  emitEvent(event: GameEvent): void {
    this.events?.emit(event);
    if (!this.eventsOpen) {
      beginGameEvents(this.eventWriter, this.tickNow);
      this.eventsOpen = true;
    }
    if (!writeGameEvent(this.eventWriter, event)) {
      this.flushEvents();
      beginGameEvents(this.eventWriter, this.tickNow);
      this.eventsOpen = true;
      writeGameEvent(this.eventWriter, event);
    }
  }

  private flushEvents(): void {
    if (!this.eventsOpen) return;
    this.eventsOpen = false;
    const length = endGameEvents(this.eventWriter);
    if (length <= 0) return;
    const peers = this.peers;
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      if (peer === undefined || peer.playerId === NO_PLAYER || peer.closeAtMs >= 0) continue;
      this.sendRaw(peer, 'ctrl', this.eventWriter, length);
    }
  }

  // --- Lobby -------------------------------------------------------------------------------------

  private nextSeed(): number {
    const source = this.random ?? Math.random;
    this.shuffleCounter = (this.shuffleCounter + 1) >>> 0;
    return (Math.floor(source() * 0x100000000) ^ this.shuffleCounter) >>> 0;
  }

  private markLobbyDirty(): void {
    this.lobbyDirty = true;
    this.listener.onLobbyChanged?.(this.hostLobby.state);
  }

  /** Stores an operation's outcome and carries out its effects. False for a refusal. */
  private handleResult(result: LobbyResult): boolean {
    if (!result.ok) return false;
    this.hostLobby = result.lobby;
    if (result.changed) this.markLobbyDirty();
    for (const effect of result.effects) {
      switch (effect.type) {
        case 'playerRemoved':
          this.onPlayerRemoved(effect.playerId, effect.cause);
          break;
        case 'matchStart':
          this.beginMatch(effect.roster);
          break;
        case 'lobbyClosed':
          this.close();
          return true;
      }
    }
    return true;
  }

  private onPlayerRemoved(playerId: PlayerId, cause: PlayerRemovalCause): void {
    const peer = this.peerByPlayer[playerId];
    if (peer !== undefined) {
      // Detach first: closing reports back synchronously and must not find a seat to hold.
      this.peerByPlayer[playerId] = undefined;
      peer.playerId = NO_PLAYER;
      if (cause === 'kicked') {
        this.sendRaw(peer, 'ctrl', this.ctrlWriter, encodeKick(this.ctrlWriter, this.noticeOut));
        peer.closeAtMs = this.nowMs + this.closeGraceMs;
      } else {
        this.transport.close(peer.link);
      }
    }
    this.playerPings[playerId] = -1;
    this.removeRider(playerId);
    this.listener.onPlayerRemoved?.(playerId, cause);
  }

  private broadcastLobby(): void {
    this.lobbyDirty = false;
    const message = this.lobbyOut;
    message.tick = this.tickNow & 0xffff;
    message.lobbyState = this.hostLobby.state;
    this.broadcastCtrl(encodeLobbyState(this.ctrlWriter, message));
  }

  /** Once a second: everybody's round trip, so clients can show the ping column too. */
  private broadcastPings(): void {
    if (this.peers.length === 0) return;
    const message = this.pingsOut;
    message.tick = this.tickNow & 0xffff;
    message.count = 0;
    const players = this.hostLobby.state.players;
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (player === undefined) continue;
      addPlayerPing(
        message,
        player.id,
        player.connected ? (this.playerPings[player.id] ?? -1) : -1,
      );
    }
    this.broadcastCtrl(encodePlayerPings(this.ctrlWriter, message));
  }

  /** Sends what is in `ctrlWriter` to every welcomed client. */
  private broadcastCtrl(length: number): void {
    if (length <= 0) return;
    const peers = this.peers;
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      if (peer === undefined || peer.playerId === NO_PLAYER || peer.closeAtMs >= 0) continue;
      this.sendRaw(peer, 'ctrl', this.ctrlWriter, length);
    }
  }

  private sendRaw(peer: HostPeer, channel: Channel, writer: Writer, length: number): void {
    if (length <= 0) return;
    if (this.transport.send(peer.link, channel, writer.packet(length))) {
      this.stats.addSent(length);
    }
  }

  // --- Transport callbacks -------------------------------------------------------------------------

  private setState(state: HostSessionState): void {
    if (this.sessionState === state) return;
    this.sessionState = state;
    this.listener.onStateChange?.(state);
  }

  private openWithNewCode(): void {
    this.codeAttempts++;
    const code = this.fixedRoomCode ?? generateRoomCode(this.random);
    this.transport.open(code);
  }

  private onTransportOpen(roomCode: string): void {
    if (this.sessionState === 'closed') return;
    this.lastError = null;
    this.handleResult(setRoomCode(this.hostLobby, roomCode));
    this.setState('open');
  }

  private onTransportError(error: TransportError): void {
    if (this.sessionState === 'closed') return;
    this.lastError = error;
    if (
      this.sessionState === 'opening' &&
      error.reason === 'idTaken' &&
      this.fixedRoomCode === null &&
      this.codeAttempts < HOST_ROOM_CODE_ATTEMPTS
    ) {
      this.openWithNewCode();
      return;
    }
    this.listener.onError?.(error);
    // A non-fatal error (signaling lost mid-session) keeps the links that exist.
    if (error.fatal) this.close();
  }

  private onPeerConnected(link: LinkId): void {
    if (this.sessionState === 'closed') return;
    const peer = new HostPeer(link, this.nowMs);
    this.peers.push(peer);
    this.peerByLink.set(link, peer);
  }

  private onPeerDisconnected(link: LinkId, _reason: DisconnectReason): void {
    const peer = this.peerByLink.get(link);
    if (peer === undefined) return;
    this.peerByLink.delete(link);
    const index = this.peers.indexOf(peer);
    if (index >= 0) {
      const last = this.peers.pop();
      if (last !== undefined && last !== peer) this.peers[index] = last;
    }
    const playerId = peer.playerId;
    if (playerId === NO_PLAYER) return;
    peer.playerId = NO_PLAYER;
    if (this.peerByPlayer[playerId] !== peer) return;
    this.peerByPlayer[playerId] = undefined;
    this.playerPings[playerId] = -1;
    if (this.sessionState === 'closed') return;
    // Holds the seat for the reconnect grace (bots and token-less seats are freed at once).
    this.handleResult(disconnectPlayer(this.hostLobby, playerId, this.tickNow));
  }

  private onMessage(link: LinkId, channel: Channel, data: TransportMessage): void {
    const peer = this.peerByLink.get(link);
    if (peer === undefined || this.sessionState === 'closed') return;
    // The protocol is binary on both channels.
    if (typeof data === 'string') {
      this.drop();
      return;
    }
    const size = data.byteLength;
    this.stats.addReceived(size);
    if (peer.closeAtMs >= 0) return;
    if (size > (channel === 'fast' ? INPUT_MAX_BYTES : CTRL_MAX_BYTES)) {
      this.drop();
      return;
    }
    const reader = this.reader.reset(this.views.viewOf(data));
    const type = reader.peekType();
    if (!isClientToHostMessage(type) || isFastMessage(type) !== (channel === 'fast')) {
      this.drop();
      return;
    }
    // Before the handshake only a HELLO is listened to.
    if (peer.playerId === NO_PLAYER && type !== MSG_HELLO) {
      this.drop();
      return;
    }

    switch (type) {
      case MSG_INPUT:
        if (!decodeInput(reader, this.inputIn)) {
          this.drop();
          return;
        }
        peer.lastHeardMs = this.nowMs;
        if (this.match !== null) peer.inputs.push(this.inputIn, this.tickNow);
        return;
      case MSG_PING:
        this.onPing(peer, reader);
        return;
      case MSG_INTENT:
        this.onIntent(peer, reader);
        return;
      case MSG_HELLO:
        this.onHello(peer, reader);
        return;
      default:
        this.drop();
    }
  }

  private drop(): void {
    this.counters.malformed++;
    this.stats.rejectedPackets++;
  }

  private onPing(peer: HostPeer, reader: Reader): void {
    const ping = this.pingIn;
    if (!decodePing(reader, ping)) {
      this.drop();
      return;
    }
    peer.lastHeardMs = this.nowMs;
    // The window runs on the time the ping arrived, not on `update`: transport callbacks keep
    // coming while a main-thread host's tab is hidden and `update` does not run, and a budget
    // that only `update` refilled would then go silent for good after 20 pings.
    const arrivedMs = this.clockNow !== null ? this.clockNow() : this.nowMs;
    if (arrivedMs - peer.pingWindowMs >= 1000) {
      peer.pingWindowMs = arrivedMs;
      peer.pingsThisSecond = 0;
    }
    if (++peer.pingsThisSecond > HOST_MAX_PINGS_PER_S) {
      this.counters.pingsDropped++;
      return;
    }
    this.playerPings[peer.playerId] = rttFromWire(ping.tick);
    const pong = this.pongOut;
    pong.tick = this.tickNow & 0xffff;
    pong.clientTimeMs = ping.clientTimeMs;
    pong.hostTimeMs = this.clockNow !== null ? this.clockNow() : this.nowMs;
    pong.hostTick = this.tickNow;
    this.sendRaw(peer, 'ctrl', this.ctrlWriter, encodePong(this.ctrlWriter, pong));
  }

  private onIntent(peer: HostPeer, reader: Reader): void {
    const message = this.intentIn;
    if (!decodeIntent(reader, message) || message.intent === null) {
      this.drop();
      return;
    }
    peer.lastHeardMs = this.nowMs;
    // `applyLobbyIntent` is the gate: `host.*` from anyone but the host is refused there, and
    // the limiter caps how often a client may ask.
    const result = applyLobbyIntent(this.hostLobby, peer.playerId, message.intent, {
      tick: this.tickNow,
      seed: this.nextSeed(),
      limiter: this.limiter,
    });
    if (!this.handleResult(result)) this.counters.intentsRefused++;
  }

  private onHello(peer: HostPeer, reader: Reader): void {
    const hello = this.helloIn;
    if (!decodeHello(reader, hello)) {
      this.drop();
      return;
    }
    // A second HELLO on a seated link changes nothing.
    if (peer.playerId !== NO_PLAYER) return;
    peer.lastHeardMs = this.nowMs;

    const token = hello.reconnectToken;
    if (token.length > 0 && hello.protocolVersion === PROTOCOL_VERSION) {
      // The seat's old link may be dead without the host knowing yet: free it for its owner.
      const seat = this.hostLobby.seats.find((candidate) => candidate.token === token);
      const old = seat === undefined ? undefined : this.peerByPlayer[seat.id];
      if (old !== undefined && old !== peer && this.nowMs - old.lastHeardMs >= this.staleLinkMs) {
        this.transport.close(old.link);
      }
    }

    const admit = handleHello(
      this.hostLobby,
      {
        name: hello.name,
        protocolVersion: hello.protocolVersion,
        reconnectToken: token.length > 0 ? token : undefined,
        clientId: hello.clientId,
      },
      { tick: this.tickNow, newToken: createReconnectToken(this.random) },
    );
    if (!admit.ok) {
      this.counters.rejectedHellos++;
      const reject = this.rejectOut;
      reject.tick = this.tickNow & 0xffff;
      reject.reason = admit.reject;
      this.sendRaw(peer, 'ctrl', this.ctrlWriter, encodeReject(this.ctrlWriter, reject));
      peer.closeAtMs = this.nowMs + this.closeGraceMs;
      return;
    }

    this.hostLobby = admit.lobby;
    const playerId = admit.playerId;
    peer.playerId = playerId;
    peer.inputs.reset();
    this.peerByPlayer[playerId] = peer;
    this.playerPings[playerId] = -1;
    if (!admit.reconnected) resetIntentRateLimiter(this.limiter, playerId);
    for (const effect of admit.effects) {
      if (effect.type === 'playerRemoved') this.onPlayerRemoved(effect.playerId, effect.cause);
    }

    const welcome = this.welcomeOut;
    welcome.tick = this.tickNow & 0xffff;
    welcome.playerId = playerId;
    welcome.reconnectToken = admit.token;
    welcome.hostTick = this.tickNow;
    welcome.lobbyState = this.hostLobby.state;
    this.sendRaw(peer, 'ctrl', this.ctrlWriter, encodeWelcome(this.ctrlWriter, welcome));
    if (this.match !== null) this.sendMatchState(peer, this.match);

    this.markLobbyDirty();
    this.listener.onPlayerJoined?.(playerId, admit.reconnected);
  }
}

export function createHostSession(options: HostSessionOptions): HostSession {
  return new HostSession(options);
}
