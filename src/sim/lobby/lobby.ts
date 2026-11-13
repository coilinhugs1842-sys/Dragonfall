/**
 * The lobby the host runs (docs/NETWORKING.md, "Lobby protocol"; docs/GAME_DESIGN.md, "Players
 * and teams"). Pure: no transport, no clock, no randomness of its own. Every operation takes a
 * HostLobby and returns a new one (or the same object when nothing changed), so the host session
 * can broadcast whenever `result.changed` is true and tests can replay any sequence.
 *
 * Rules decided here (the docs leave them open):
 * - `players` is kept in join order; "newest" always means "latest in that array".
 * - A new player goes to the smaller team (Ember on a tie) while it has room, otherwise to the
 *   spectators. While teams are locked or a match is running, newcomers always spectate.
 * - Leaving on purpose frees the slot at once. A dropped connection holds it for 30 s.
 * - `ready` is cleared whenever a player's side or class changes (by anyone), on disconnect, and
 *   for everybody when the room returns from a match. Changing mode, map or limits does not clear
 *   it. Spectators cannot be ready.
 * - Locked teams: nobody changes sides, not even by host drag, auto-balance or shuffle; the host
 *   unlocks first. Shrinking the team size still moves the overflow to the spectators.
 * - Teams, classes and settings only change in the `lobby` phase. Joining, leaving, reconnecting
 *   and kicking work in every phase.
 * - Bot riders (T-3.10): the host seats them on a team (`addBot`, `fillBots`). A bot is a
 *   LobbyPlayer with `isBot` and a seat without a token: it has no connection, is always ready
 *   and is flown by the host's sim. Bots never spectate: a bot that would be moved to the
 *   spectators (host drag, a smaller team size) is removed instead. A human who joins a room
 *   whose teams are full of bots takes the newest bot's seat rather than a spectator's.
 */

import type { DragonClassId } from '../../shared/classes';
import { DEFAULT_DRAGON_CLASS, DRAGON_CLASS_IDS, isDragonClassId } from '../../shared/classes';
import type { LobbySide, PlayerId, TeamId } from '../../shared/constants';
import {
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  NO_PLAYER,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_MS,
} from '../../shared/constants';
import type {
  BotDifficulty,
  HostSettings,
  LobbyPlayer,
  LobbyState,
  MatchRoster,
  RejectReason,
} from '../../shared/lobby';
import {
  BOT_RIDER_NAMES,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_HOST_SETTINGS,
  HOST_SETTING_LIMITS,
  MAX_LOBBY_MEMBERS,
  MAX_SPECTATORS,
  isBotDifficulty,
  isBotSide,
} from '../../shared/lobby';
import { createSeededRandom } from '../../shared/maps/seeded-random';
import type { MapId, ModeId } from '../../shared/match';
import { MAPS, MODES } from '../../shared/match';
import { resolveScoreLimit, scoreLimitRule } from '../match/mode-config';
import { dedupePlayerName, sanitizePlayerName } from './names';
import type { StartBlocker, StartOptions } from './start';
import { buildMatchRoster, canStart } from './start';

// --- Types --------------------------------------------------------------------------------------

/** Host ticks a dropped player's slot is held (30 s at 30 Hz). */
export const RECONNECT_GRACE_TICKS = Math.round(RECONNECT_GRACE_MS / TICK_MS);
/** Reconnect tokens longer than this are ignored. */
export const MAX_RECONNECT_TOKEN_LENGTH = 64;
/** How many kicked tokens and client ids the host remembers (oldest forgotten first). */
export const MAX_KICKED_TOKENS = 64;
/** The host always takes the first id. */
export const HOST_PLAYER_ID: PlayerId = 0;

/** The secret half of a seat. Never broadcast: a token lets its holder take the seat. */
export interface LobbySeat {
  readonly id: PlayerId;
  /** Empty for the host and bots (they never reconnect). */
  readonly token: string;
  /** The `clientId` of the `hello` that took the seat ('' when it sent none). */
  readonly clientId: string;
}

/**
 * Everything the host keeps about the room. `state` is the public part it broadcasts as
 * LOBBY_STATE; the rest stays on the host. Plain JSON-safe data throughout.
 */
export interface HostLobby {
  readonly state: LobbyState;
  readonly seats: readonly LobbySeat[];
  /**
   * Seat tokens and client ids of kicked players. A `hello` carrying either is rejected for
   * the life of the room: the token stops the kicked tab, the client id stops the same browser
   * coming back in a new tab with no token.
   */
  readonly kickedTokens: readonly string[];
}

export type LobbyRefusal =
  /** A `host.*` operation from someone who is not the host. */
  | 'notHost'
  /** The acting player is not in the room (or is not connected). */
  | 'unknownActor'
  /** The target player is not in the room. */
  | 'unknownPlayer'
  /** Teams, classes and settings are frozen outside the `lobby` phase. */
  | 'wrongPhase'
  | 'teamsLocked'
  | 'teamFull'
  /** A value of the wrong type or outside anything that can be clamped. */
  | 'invalidValue'
  /** A mode or map that has not shipped yet. */
  | 'unavailable'
  | 'classNotAllowed'
  /** Spectators cannot ready up. */
  | 'spectator'
  /** The host cannot be kicked or disconnected. */
  | 'isHost'
  | 'rateLimited'
  /** Not a lobby or host intent (title, match, settings, local-only ones). */
  | 'unsupportedIntent'
  | StartBlocker;

export type PlayerRemovalCause = 'left' | 'kicked' | 'timedOut';

/** Things the host session must do besides broadcasting the new state. */
export type LobbyEffect =
  /** Close the player's connection (send `reject { kicked }` first when the cause is `kicked`). */
  | {
      readonly type: 'playerRemoved';
      readonly playerId: PlayerId;
      readonly cause: PlayerRemovalCause;
    }
  /** The host left: tell every client and tear the room down. */
  | { readonly type: 'lobbyClosed' }
  /**
   * Start was accepted and the room is `starting`: the launch has begun. `roster` is the teams as
   * they stand now; the match itself is loaded from the `matchLaunch` roster.
   */
  | { readonly type: 'matchStart'; readonly roster: MatchRoster }
  /** The launch is over and the room is `inMatch`: load the match with this roster. */
  | { readonly type: 'matchLaunch'; readonly roster: MatchRoster };

export type LobbyResult =
  | {
      readonly ok: true;
      readonly lobby: HostLobby;
      /** True when the public state changed and must be broadcast. */
      readonly changed: boolean;
      readonly effects: readonly LobbyEffect[];
    }
  | { readonly ok: false; readonly lobby: HostLobby; readonly reason: LobbyRefusal };

/** The fields of a `hello` the lobby cares about, exactly as they came off the wire. */
export interface HelloRequest {
  readonly name: unknown;
  readonly protocolVersion: unknown;
  readonly reconnectToken?: unknown;
  /** Names the browser across tabs; see `HostLobby.kickedTokens`. */
  readonly clientId?: unknown;
}

export interface AdmitContext {
  /** Current host lobby tick. */
  readonly tick: number;
  /**
   * A fresh unguessable token the caller generated (e.g. from `crypto.getRandomValues`), handed
   * to the player if they get a new seat. Must be non-empty and not in use.
   */
  readonly newToken: string;
}

export type AdmitResult =
  | {
      readonly ok: true;
      readonly lobby: HostLobby;
      readonly changed: true;
      readonly playerId: PlayerId;
      /** Send this back in `welcome`; the client stores it for reconnects. */
      readonly token: string;
      /** True when the player took their held seat back. */
      readonly reconnected: boolean;
      readonly effects: readonly LobbyEffect[];
    }
  | { readonly ok: false; readonly lobby: HostLobby; readonly reject: RejectReason };

export interface CreateLobbyOptions {
  readonly roomCode: string;
  readonly hostName: unknown;
  /** Defaults to DEFAULT_HOST_SETTINGS. */
  readonly settings?: HostSettings;
}

// --- Small helpers ------------------------------------------------------------------------------

const NO_EFFECTS: readonly LobbyEffect[] = Object.freeze([]);

function done(
  prev: HostLobby,
  next: HostLobby,
  effects: readonly LobbyEffect[] = NO_EFFECTS,
): LobbyResult {
  return { ok: true, lobby: next, changed: next.state !== prev.state, effects };
}

function refuse(lobby: HostLobby, reason: LobbyRefusal): LobbyResult {
  return { ok: false, lobby, reason };
}

export function isLobbySide(value: unknown): value is LobbySide {
  return value === TEAM_EMBER || value === TEAM_FROST || value === 'spectator';
}

export function findLobbyPlayer(state: LobbyState, id: PlayerId): LobbyPlayer | undefined {
  const players = state.players;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (player !== undefined && player.id === id) return player;
  }
  return undefined;
}

/** How many players sit on `side`. Allocation-free. */
export function countLobbySide(players: readonly LobbyPlayer[], side: LobbySide): number {
  let count = 0;
  for (let i = 0; i < players.length; i++) {
    if (players[i]?.side === side) count += 1;
  }
  return count;
}

/**
 * The earliest tick at which a held slot expires, or Infinity. Allocation-free, so the host can
 * poll it every tick and call `expireReconnects` only when it is due.
 */
export function nextReconnectDeadline(state: LobbyState): number {
  let earliest = Infinity;
  const players = state.players;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (player !== undefined && !player.connected && player.reconnectDeadlineTick < earliest) {
      earliest = player.reconnectDeadlineTick;
    }
  }
  return earliest;
}

function withPlayers(lobby: HostLobby, players: readonly LobbyPlayer[]): HostLobby {
  return { ...lobby, state: { ...lobby.state, players } };
}

function withSettings(lobby: HostLobby, settings: HostSettings): HostLobby {
  return { ...lobby, state: { ...lobby.state, settings } };
}

function lowestFreePerch(players: readonly LobbyPlayer[], team: TeamId): number {
  for (let perch = 0; perch < MAX_TEAM_SIZE; perch++) {
    if (!players.some((player) => player.side === team && player.perch === perch)) return perch;
  }
  // Unreachable while teams hold at most MAX_TEAM_SIZE players.
  return MAX_TEAM_SIZE - 1;
}

/** Moves the player at `index` to `side` in place (in a working copy). Clears their ready flag. */
function seatAt(players: LobbyPlayer[], index: number, side: LobbySide): void {
  const player = players[index];
  if (player === undefined || player.side === side) return;
  const perch = side === 'spectator' ? -1 : lowestFreePerch(players, side);
  players[index] = { ...player, side, perch, ready: false };
}

/** Moves the newest members of an over-full team to the spectators. Returns true if any moved. */
function spillOverflow(players: LobbyPlayer[], teamSize: number): boolean {
  let moved = false;
  for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
    let count = countLobbySide(players, team);
    for (let i = players.length - 1; i >= 0 && count > teamSize; i--) {
      if (players[i]?.side !== team) continue;
      seatAt(players, i, 'spectator');
      count -= 1;
      moved = true;
    }
  }
  return moved;
}

function fallbackClass(allowed: readonly DragonClassId[]): DragonClassId {
  return allowed.includes(DEFAULT_DRAGON_CLASS)
    ? DEFAULT_DRAGON_CLASS
    : (allowed[0] ?? DEFAULT_DRAGON_CLASS);
}

function teamSizeRange(mode: ModeId): { min: number; max: number } {
  const info = MODES[mode];
  return {
    min: Math.max(MIN_TEAM_SIZE, info.minTeamSize),
    max: Math.min(MAX_TEAM_SIZE, info.maxTeamSize),
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isRealNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Null when `actorId` is the connected host and the room is in the `lobby` phase. */
function hostPanelRefusal(lobby: HostLobby, actorId: PlayerId): LobbyRefusal | null {
  const refusal = hostRefusal(lobby, actorId);
  if (refusal !== null) return refusal;
  return lobby.state.phase === 'lobby' ? null : 'wrongPhase';
}

function hostRefusal(lobby: HostLobby, actorId: PlayerId): LobbyRefusal | null {
  const actor = findLobbyPlayer(lobby.state, actorId);
  if (actor === undefined || !actor.connected) return 'unknownActor';
  return actorId === lobby.state.hostId && actor.isHost ? null : 'notHost';
}

function lowestFreeId(players: readonly LobbyPlayer[]): PlayerId {
  for (let id = 0; id < NO_PLAYER; id++) {
    if (!players.some((player) => player.id === id)) return id;
  }
  return NO_PLAYER;
}

function removePlayer(lobby: HostLobby, playerId: PlayerId): HostLobby {
  return {
    ...lobby,
    state: {
      ...lobby.state,
      players: lobby.state.players.filter((player) => player.id !== playerId),
    },
    seats: lobby.seats.filter((seat) => seat.id !== playerId),
  };
}

function isUsableToken(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_RECONNECT_TOKEN_LENGTH
  );
}

// --- Creating, joining, leaving -----------------------------------------------------------------

function sanitizeSettings(settings: HostSettings | undefined): HostSettings {
  const source = settings ?? DEFAULT_HOST_SETTINGS;
  const mode = Object.hasOwn(MODES, source.mode) && MODES[source.mode].available;
  const map = Object.hasOwn(MAPS, source.map) && MAPS[source.map].available;
  const safeMode = mode ? source.mode : DEFAULT_HOST_SETTINGS.mode;
  const range = teamSizeRange(safeMode);
  const classes = Array.isArray(source.allowedClasses)
    ? DRAGON_CLASS_IDS.filter((id) => source.allowedClasses.includes(id))
    : [];
  return {
    mode: safeMode,
    map: map ? source.map : DEFAULT_HOST_SETTINGS.map,
    teamSize: isRealNumber(source.teamSize)
      ? clampInt(source.teamSize, range.min, range.max)
      : range.max,
    unevenTeams: source.unevenTeams === true,
    // The mode's own range: Ember Relay counts captures, a handful of them (`scoreLimitRule`).
    scoreLimit: isRealNumber(source.scoreLimit)
      ? resolveScoreLimit(safeMode, source.scoreLimit)
      : scoreLimitRule(safeMode).initial,
    timeLimitS: isRealNumber(source.timeLimitS)
      ? clampTimeLimit(source.timeLimitS)
      : DEFAULT_HOST_SETTINGS.timeLimitS,
    friendlyFire: source.friendlyFire === true,
    allowedClasses: classes.length > 0 ? classes : [...DRAGON_CLASS_IDS],
    teamsLocked: source.teamsLocked === true,
    botDifficulty: isBotDifficulty(source.botDifficulty)
      ? source.botDifficulty
      : DEFAULT_BOT_DIFFICULTY,
  };
}

function clampTimeLimit(seconds: number): number {
  if (seconds <= 0) return 0;
  return clampInt(seconds, HOST_SETTING_LIMITS.timeLimitMinS, HOST_SETTING_LIMITS.timeLimitMaxS);
}

/** A new room with the host seated on Ember's first perch. Settings are clamped to legal values. */
export function createLobby(options: CreateLobbyOptions): HostLobby {
  const settings = sanitizeSettings(options.settings);
  const host: LobbyPlayer = {
    id: HOST_PLAYER_ID,
    name: sanitizePlayerName(options.hostName),
    side: TEAM_EMBER,
    perch: 0,
    classId: fallbackClass(settings.allowedClasses),
    ready: false,
    isHost: true,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: false,
  };
  return {
    state: {
      roomCode: options.roomCode,
      phase: 'lobby',
      hostId: host.id,
      players: [host],
      settings,
    },
    seats: [{ id: host.id, token: '', clientId: '' }],
    kickedTokens: [],
  };
}

/**
 * Sets the room code once the signaling broker has registered the room (the lobby can be created
 * with '' before that). Called by the host's own flow, not a player.
 */
export function setRoomCode(lobby: HostLobby, roomCode: string): LobbyResult {
  if (typeof roomCode !== 'string') return refuse(lobby, 'invalidValue');
  if (roomCode === lobby.state.roomCode) return done(lobby, lobby);
  return done(lobby, { ...lobby, state: { ...lobby.state, roomCode } });
}

/** Where a newcomer would sit, or null when the room has no seat for them. */
function pickJoinSide(state: LobbyState): LobbySide | null {
  const players = state.players;
  if (players.length >= MAX_LOBBY_MEMBERS || players.length >= NO_PLAYER) return null;
  if (state.phase === 'lobby' && !state.settings.teamsLocked) {
    const ember = countLobbySide(players, TEAM_EMBER);
    const frost = countLobbySide(players, TEAM_FROST);
    const smaller: TeamId = frost < ember ? TEAM_FROST : TEAM_EMBER;
    if (Math.min(ember, frost) < state.settings.teamSize) return smaller;
  }
  return countLobbySide(players, 'spectator') < MAX_SPECTATORS ? 'spectator' : null;
}

export interface JoinRequest {
  readonly name: unknown;
  /** Reconnect token for the new seat; empty for bots (no reconnect). */
  readonly token: string;
  /** The joining browser's id, remembered with the seat so a kick can ban it. */
  readonly clientId?: string;
  readonly isBot?: boolean;
}

/**
 * Seats a new player (or bot). Rejects with `full` in the lobby phase and `matchInProgress`
 * otherwise when there is neither a team slot nor a spectator slot. Throws if `token` is already
 * in use, because that is a host bug (tokens must be unique and unguessable), not a client error.
 */
export function joinLobby(lobby: HostLobby, request: JoinRequest): AdmitResult {
  return joinWithEffects(lobby, request, NO_EFFECTS);
}

function joinWithEffects(
  lobby: HostLobby,
  request: JoinRequest,
  effects: readonly LobbyEffect[],
): AdmitResult {
  const state = lobby.state;
  const token = request.token;
  if (token.length > MAX_RECONNECT_TOKEN_LENGTH) throw new Error('lobby: token too long');
  if (token.length > 0 && lobby.seats.some((seat) => seat.token === token)) {
    throw new Error('lobby: reconnect token already in use');
  }
  const side = pickJoinSide(state);
  if (request.isBot !== true && (side === null || side === 'spectator')) {
    // The teams are full: a human takes the seat of the newest bot rider, if there is one.
    const bot = newestSeatedBot(lobby);
    if (bot !== undefined && state.phase === 'lobby' && !state.settings.teamsLocked) {
      const freed = removePlayer(lobby, bot.id);
      const joined = joinWithEffects(freed, request, [
        ...effects,
        { type: 'playerRemoved', playerId: bot.id, cause: 'left' },
      ]);
      // `freed` only differs from `lobby` by the bot, so a refusal hands back the original.
      return joined.ok ? joined : { ok: false, lobby, reject: joined.reject };
    }
  }
  if (side === null) {
    return { ok: false, lobby, reject: state.phase === 'lobby' ? 'full' : 'matchInProgress' };
  }
  const players = state.players;
  const id = lowestFreeId(players);
  const taken = players.map((player) => player.name);
  const player: LobbyPlayer = {
    id,
    name: dedupePlayerName(sanitizePlayerName(request.name), taken),
    side,
    perch: side === 'spectator' ? -1 : lowestFreePerch(players, side),
    classId: fallbackClass(state.settings.allowedClasses),
    ready: false,
    isHost: false,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: request.isBot === true,
  };
  const next: HostLobby = {
    ...lobby,
    state: { ...state, players: [...players, player] },
    seats: [...lobby.seats, { id, token, clientId: request.clientId ?? '' }],
  };
  return { ok: true, lobby: next, changed: true, playerId: id, token, reconnected: false, effects };
}

/**
 * The one entry point for a `hello`. In order: a wrong protocol version is rejected; a kicked
 * token is rejected as `kicked`; held slots that ran out are freed; a token that matches a held
 * slot takes it back (same id, team, class and name; `ready` stays cleared); a kicked client id
 * is rejected as `kicked`; anything else is a fresh join under `ctx.newToken`. A token that matches a seat which is still connected (a
 * duplicated tab copies `sessionStorage`) does not steal that seat: it joins fresh.
 */
export function handleHello(lobby: HostLobby, hello: HelloRequest, ctx: AdmitContext): AdmitResult {
  if (hello.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, lobby, reject: 'versionMismatch' };
  }
  const token = isUsableToken(hello.reconnectToken) ? hello.reconnectToken : '';
  if (token.length > 0 && lobby.kickedTokens.includes(token)) {
    return { ok: false, lobby, reject: 'kicked' };
  }
  const expired = expireReconnects(lobby, ctx.tick);
  const current = expired.lobby;
  const effects = expired.ok ? expired.effects : NO_EFFECTS;
  if (token.length > 0) {
    const seat = current.seats.find((candidate) => candidate.token === token);
    const player = seat === undefined ? undefined : findLobbyPlayer(current.state, seat.id);
    if (player !== undefined && !player.connected) {
      const players = current.state.players.map((other) =>
        other.id === player.id ? { ...other, connected: true, reconnectDeadlineTick: -1 } : other,
      );
      return {
        ok: true,
        lobby: withPlayers(current, players),
        changed: true,
        playerId: player.id,
        token,
        reconnected: true,
        effects,
      };
    }
  }
  // Only a new seat is refused by client id: another tab of the same browser that still holds
  // a seat of its own keeps it, and gets it back above.
  const clientId = isUsableToken(hello.clientId) ? hello.clientId : '';
  if (clientId.length > 0 && lobby.kickedTokens.includes(clientId)) {
    return { ok: false, lobby, reject: 'kicked' };
  }
  if (!isUsableToken(ctx.newToken)) throw new Error('lobby: newToken must be a non-empty string');
  const joined = joinWithEffects(
    current,
    { name: hello.name, token: ctx.newToken, clientId },
    effects,
  );
  // A reject carries no effects, so hand back the untouched lobby: the slots that just ran out
  // are then freed (and reported) by the host's regular `expireReconnects` poll instead.
  return joined.ok ? joined : { ok: false, lobby, reject: joined.reject };
}

/**
 * A player leaves on purpose (`lobby.leave`): the seat is freed immediately and its token dies.
 * When the host leaves, the room closes: the state is untouched and the effect says so.
 */
export function leaveLobby(lobby: HostLobby, playerId: PlayerId): LobbyResult {
  const player = findLobbyPlayer(lobby.state, playerId);
  if (player === undefined) return refuse(lobby, 'unknownPlayer');
  if (player.isHost) return done(lobby, lobby, [{ type: 'lobbyClosed' }]);
  return done(lobby, removePlayer(lobby, playerId), [
    { type: 'playerRemoved', playerId, cause: 'left' },
  ]);
}

/**
 * A player's connection dropped. Their seat (team, perch, class, name) is held until
 * `tick + RECONNECT_GRACE_TICKS`; they show as not connected and not ready. Bots are removed at
 * once. The host cannot disconnect from itself.
 */
export function disconnectPlayer(lobby: HostLobby, playerId: PlayerId, tick: number): LobbyResult {
  const player = findLobbyPlayer(lobby.state, playerId);
  if (player === undefined) return refuse(lobby, 'unknownPlayer');
  if (player.isHost) return refuse(lobby, 'isHost');
  if (!player.connected) return done(lobby, lobby);
  const seat = lobby.seats.find((candidate) => candidate.id === playerId);
  if (player.isBot || seat === undefined || seat.token.length === 0) {
    return done(lobby, removePlayer(lobby, playerId), [
      { type: 'playerRemoved', playerId, cause: 'left' },
    ]);
  }
  const players = lobby.state.players.map((other) =>
    other.id === playerId
      ? {
          ...other,
          connected: false,
          ready: false,
          reconnectDeadlineTick: tick + RECONNECT_GRACE_TICKS,
        }
      : other,
  );
  return done(lobby, withPlayers(lobby, players));
}

/**
 * Frees every held slot whose deadline has passed (`tick >= deadline`). Poll
 * `nextReconnectDeadline` each tick and call this only when it is due.
 */
export function expireReconnects(lobby: HostLobby, tick: number): LobbyResult {
  if (nextReconnectDeadline(lobby.state) > tick) return done(lobby, lobby);
  const effects: LobbyEffect[] = [];
  let next = lobby;
  for (const player of lobby.state.players) {
    if (!player.connected && player.reconnectDeadlineTick <= tick) {
      next = removePlayer(next, player.id);
      effects.push({ type: 'playerRemoved', playerId: player.id, cause: 'timedOut' });
    }
  }
  return done(lobby, next, effects);
}

/**
 * Host removes a player in any phase. Their token and their browser's client id are remembered,
 * so a `hello` that carries either is rejected as `kicked`. The host cannot kick itself.
 */
export function kickPlayer(lobby: HostLobby, actorId: PlayerId, playerId: PlayerId): LobbyResult {
  const refusal = hostRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  const target = findLobbyPlayer(lobby.state, playerId);
  if (target === undefined) return refuse(lobby, 'unknownPlayer');
  if (target.isHost) return refuse(lobby, 'isHost');
  const seat = lobby.seats.find((candidate) => candidate.id === playerId);
  const removed = removePlayer(lobby, playerId);
  let kickedTokens = lobby.kickedTokens;
  if (seat !== undefined) {
    const banned = [...kickedTokens];
    if (seat.token.length > 0) banned.push(seat.token);
    if (seat.clientId.length > 0 && !banned.includes(seat.clientId)) banned.push(seat.clientId);
    if (banned.length > kickedTokens.length) kickedTokens = banned.slice(-MAX_KICKED_TOKENS);
  }
  return done(lobby, { ...removed, kickedTokens }, [
    { type: 'playerRemoved', playerId, cause: 'kicked' },
  ]);
}

// --- Teams --------------------------------------------------------------------------------------

function changeSide(lobby: HostLobby, playerId: PlayerId, side: LobbySide): LobbyResult {
  const state = lobby.state;
  const index = state.players.findIndex((player) => player.id === playerId);
  const player = state.players[index];
  if (player === undefined) return refuse(lobby, 'unknownPlayer');
  if (player.side === side) return done(lobby, lobby);
  if (side === 'spectator' && isSeatedBot(lobby, player)) {
    // A bot has nothing to watch: off the team means out of the room.
    return done(lobby, removePlayer(lobby, playerId), [
      { type: 'playerRemoved', playerId, cause: 'left' },
    ]);
  }
  if (side !== 'spectator' && countLobbySide(state.players, side) >= state.settings.teamSize) {
    return refuse(lobby, 'teamFull');
  }
  const players = [...state.players];
  seatAt(players, index, side);
  return done(lobby, withPlayers(lobby, players));
}

/**
 * Host drags a player to a team or to the spectators. Refused when teams are locked or the team
 * already has `teamSize` riders. Moving to the spectators always fits.
 */
export function movePlayer(
  lobby: HostLobby,
  actorId: PlayerId,
  playerId: PlayerId,
  side: LobbySide,
): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!isLobbySide(side)) return refuse(lobby, 'invalidValue');
  if (findLobbyPlayer(lobby.state, playerId) === undefined) return refuse(lobby, 'unknownPlayer');
  if (lobby.state.settings.teamsLocked) return refuse(lobby, 'teamsLocked');
  return changeSide(lobby, playerId, side);
}

/** A player changes their own side: only while teams are unlocked and the side has room. */
export function switchSide(lobby: HostLobby, actorId: PlayerId, side: LobbySide): LobbyResult {
  const actor = findLobbyPlayer(lobby.state, actorId);
  if (actor === undefined || !actor.connected) return refuse(lobby, 'unknownActor');
  if (lobby.state.phase !== 'lobby') return refuse(lobby, 'wrongPhase');
  if (!isLobbySide(side)) return refuse(lobby, 'invalidValue');
  if (lobby.state.settings.teamsLocked) return refuse(lobby, 'teamsLocked');
  return changeSide(lobby, actorId, side);
}

/**
 * Host evens the teams out: the newest riders of the larger team cross over until the counts
 * differ by at most one. Spectators are left alone (they may be watching by choice).
 */
export function autoBalance(lobby: HostLobby, actorId: PlayerId): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (lobby.state.settings.teamsLocked) return refuse(lobby, 'teamsLocked');
  const players = [...lobby.state.players];
  let ember = countLobbySide(players, TEAM_EMBER);
  let frost = countLobbySide(players, TEAM_FROST);
  if (Math.abs(ember - frost) <= 1) return done(lobby, lobby);
  while (Math.abs(ember - frost) > 1) {
    const from: TeamId = ember > frost ? TEAM_EMBER : TEAM_FROST;
    const to: TeamId = from === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
    let index = -1;
    for (let i = players.length - 1; i >= 0; i--) {
      if (players[i]?.side === from) {
        index = i;
        break;
      }
    }
    if (index < 0) break;
    seatAt(players, index, to);
    if (from === TEAM_EMBER) {
      ember -= 1;
      frost += 1;
    } else {
      frost -= 1;
      ember += 1;
    }
  }
  return done(lobby, withPlayers(lobby, players));
}

/**
 * Host deals the riders out again at random, keeping both team counts. Deterministic: the same
 * lobby and `seed` always give the same teams (the caller supplies the seed). Riders who end up
 * on the other side lose their ready flag; spectators are not touched.
 */
export function shuffleTeams(lobby: HostLobby, actorId: PlayerId, seed: number): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!isRealNumber(seed)) return refuse(lobby, 'invalidValue');
  if (lobby.state.settings.teamsLocked) return refuse(lobby, 'teamsLocked');
  const source = lobby.state.players;
  const riderIndices: number[] = [];
  source.forEach((player, index) => {
    if (player.side !== 'spectator') riderIndices.push(index);
  });
  const emberCount = countLobbySide(source, TEAM_EMBER);
  const random = createSeededRandom(seed);
  for (let i = riderIndices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = riderIndices[i];
    const b = riderIndices[j];
    if (a === undefined || b === undefined) continue;
    riderIndices[i] = b;
    riderIndices[j] = a;
  }
  const players = [...source];
  let changed = false;
  riderIndices.forEach((playerIndex, dealt) => {
    const player = players[playerIndex];
    if (player === undefined) return;
    const side: TeamId = dealt < emberCount ? TEAM_EMBER : TEAM_FROST;
    const perch = dealt < emberCount ? dealt : dealt - emberCount;
    if (player.side === side && player.perch === perch) return;
    players[playerIndex] = {
      ...player,
      side,
      perch,
      ready: player.side === side ? player.ready : false,
    };
    changed = true;
  });
  return changed ? done(lobby, withPlayers(lobby, players)) : done(lobby, lobby);
}

// --- Player choices -----------------------------------------------------------------------------

/** A player picks a class from the allowed list (spectators too: it is used when they join a team). */
export function pickClass(
  lobby: HostLobby,
  actorId: PlayerId,
  classId: DragonClassId,
): LobbyResult {
  const actor = findLobbyPlayer(lobby.state, actorId);
  if (actor === undefined || !actor.connected) return refuse(lobby, 'unknownActor');
  if (lobby.state.phase !== 'lobby') return refuse(lobby, 'wrongPhase');
  if (!isDragonClassId(classId)) return refuse(lobby, 'invalidValue');
  if (!lobby.state.settings.allowedClasses.includes(classId)) {
    return refuse(lobby, 'classNotAllowed');
  }
  if (actor.classId === classId) return done(lobby, lobby);
  const players = lobby.state.players.map((player) =>
    player.id === actorId ? { ...player, classId, ready: false } : player,
  );
  return done(lobby, withPlayers(lobby, players));
}

/** A rider readies up or stands down. Spectators cannot. */
export function setReady(lobby: HostLobby, actorId: PlayerId, ready: boolean): LobbyResult {
  const actor = findLobbyPlayer(lobby.state, actorId);
  if (actor === undefined || !actor.connected) return refuse(lobby, 'unknownActor');
  if (lobby.state.phase !== 'lobby') return refuse(lobby, 'wrongPhase');
  if (typeof ready !== 'boolean') return refuse(lobby, 'invalidValue');
  if (actor.side === 'spectator') return refuse(lobby, 'spectator');
  if (actor.ready === ready) return done(lobby, lobby);
  const players = lobby.state.players.map((player) =>
    player.id === actorId ? { ...player, ready } : player,
  );
  return done(lobby, withPlayers(lobby, players));
}

// --- Host settings ------------------------------------------------------------------------------

function applySettings(
  lobby: HostLobby,
  patch: Partial<HostSettings>,
  players?: readonly LobbyPlayer[],
): LobbyResult {
  const settings: HostSettings = { ...lobby.state.settings, ...patch };
  const next = withSettings(lobby, settings);
  return done(lobby, players === undefined ? next : withPlayers(next, players));
}

/** Applies a new team size, moving overflow riders (newest first) to the spectators. */
function resizeTeams(
  lobby: HostLobby,
  teamSize: number,
  patch: Partial<HostSettings>,
): LobbyResult {
  const players = [...lobby.state.players];
  const moved = spillOverflow(players, teamSize);
  const result = applySettings(lobby, { ...patch, teamSize }, moved ? players : undefined);
  if (!moved || !result.ok) return result;
  // Bots that no longer fit leave the room instead of spectating.
  let next = result.lobby;
  const effects: LobbyEffect[] = [];
  for (const player of result.lobby.state.players) {
    if (player.side === 'spectator' && isSeatedBot(next, player)) {
      next = removePlayer(next, player.id);
      effects.push({ type: 'playerRemoved', playerId: player.id, cause: 'left' });
    }
  }
  return effects.length > 0 ? done(lobby, next, effects) : result;
}

/**
 * Host sets riders per side. The value is rounded and clamped to what the mode allows (1-5; Duel
 * 1-2). When a team no longer fits, its newest members move to the spectators.
 */
export function setTeamSize(lobby: HostLobby, actorId: PlayerId, teamSize: number): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!isRealNumber(teamSize)) return refuse(lobby, 'invalidValue');
  const range = teamSizeRange(lobby.state.settings.mode);
  const size = clampInt(teamSize, range.min, range.max);
  if (size === lobby.state.settings.teamSize) return done(lobby, lobby);
  return resizeTeams(lobby, size, {});
}

export function setUnevenTeams(lobby: HostLobby, actorId: PlayerId, enabled: boolean): LobbyResult {
  return setFlag(lobby, actorId, 'unevenTeams', enabled);
}

export function setFriendlyFire(
  lobby: HostLobby,
  actorId: PlayerId,
  enabled: boolean,
): LobbyResult {
  return setFlag(lobby, actorId, 'friendlyFire', enabled);
}

/** While locked, nobody changes sides and newcomers spectate (see the file header). */
export function lockTeams(lobby: HostLobby, actorId: PlayerId, locked: boolean): LobbyResult {
  return setFlag(lobby, actorId, 'teamsLocked', locked);
}

function setFlag(
  lobby: HostLobby,
  actorId: PlayerId,
  key: 'unevenTeams' | 'friendlyFire' | 'teamsLocked',
  value: boolean,
): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (typeof value !== 'boolean') return refuse(lobby, 'invalidValue');
  if (lobby.state.settings[key] === value) return done(lobby, lobby);
  return applySettings(lobby, { [key]: value });
}

/**
 * Host picks the mode. Unknown modes are invalid, unshipped ones unavailable. The team size is
 * pulled into the new mode's range (Ember Relay needs at least 2), with the usual overflow to
 * spectators. The score limit starts again on the new mode's own value when the two modes count
 * different things (30 takedowns in Skirmish, 3 captures in Ember Relay).
 */
export function setMode(lobby: HostLobby, actorId: PlayerId, mode: ModeId): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (typeof mode !== 'string' || !Object.hasOwn(MODES, mode)) {
    return refuse(lobby, 'invalidValue');
  }
  if (!MODES[mode].available) return refuse(lobby, 'unavailable');
  const settings = lobby.state.settings;
  if (mode === settings.mode) return done(lobby, lobby);
  const range = teamSizeRange(mode);
  const size = clampInt(settings.teamSize, range.min, range.max);
  const rule = scoreLimitRule(mode);
  const before = scoreLimitRule(settings.mode);
  const sameScale = rule.max === before.max && rule.initial === before.initial;
  return resizeTeams(lobby, size, sameScale ? { mode } : { mode, scoreLimit: rule.initial });
}

export function setMap(lobby: HostLobby, actorId: PlayerId, map: MapId): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (typeof map !== 'string' || !Object.hasOwn(MAPS, map)) return refuse(lobby, 'invalidValue');
  if (!MAPS[map].available) return refuse(lobby, 'unavailable');
  if (map === lobby.state.settings.map) return done(lobby, lobby);
  return applySettings(lobby, { map });
}

/**
 * Rounded and clamped to what the mode allows: HOST_SETTING_LIMITS, and in Ember Relay at most
 * `MODE_TUNING.emberRelay.maxCaptures`.
 */
export function setScoreLimit(
  lobby: HostLobby,
  actorId: PlayerId,
  scoreLimit: number,
): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!isRealNumber(scoreLimit)) return refuse(lobby, 'invalidValue');
  const limits = scoreLimitRule(lobby.state.settings.mode);
  const value = clampInt(scoreLimit, limits.min, limits.max);
  if (value === lobby.state.settings.scoreLimit) return done(lobby, lobby);
  return applySettings(lobby, { scoreLimit: value });
}

/** Seconds; 0 or less means no limit, anything else is rounded and clamped to HOST_SETTING_LIMITS. */
export function setTimeLimit(lobby: HostLobby, actorId: PlayerId, timeLimitS: number): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!isRealNumber(timeLimitS)) return refuse(lobby, 'invalidValue');
  const value = clampTimeLimit(timeLimitS);
  if (value === lobby.state.settings.timeLimitS) return done(lobby, lobby);
  return applySettings(lobby, { timeLimitS: value });
}

/**
 * Host chooses which classes may be picked. Unknown ids and duplicates are dropped and the list
 * is stored in canonical order; an empty result is refused. Players whose class is no longer
 * allowed fall back to the default class (or the first allowed one) and lose their ready flag.
 */
export function setAllowedClasses(
  lobby: HostLobby,
  actorId: PlayerId,
  classes: readonly DragonClassId[],
): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!Array.isArray(classes)) return refuse(lobby, 'invalidValue');
  const requested: readonly unknown[] = classes;
  const allowed = DRAGON_CLASS_IDS.filter((id) => requested.includes(id));
  if (allowed.length === 0) return refuse(lobby, 'invalidValue');
  const current = lobby.state.settings.allowedClasses;
  if (allowed.length === current.length && allowed.every((id, index) => current[index] === id)) {
    return done(lobby, lobby);
  }
  const fallback = fallbackClass(allowed);
  let anyFallback = false;
  const players = lobby.state.players.map((player) => {
    if (allowed.includes(player.classId)) return player;
    anyFallback = true;
    return { ...player, classId: fallback, ready: false };
  });
  return applySettings(lobby, { allowedClasses: allowed }, anyFallback ? players : undefined);
}

// --- Bot riders (T-3.10) --------------------------------------------------------------------------

/** The seat of a bot the host added has no token (a `?bots=N` fake client has one). */
function isSeatedBot(lobby: HostLobby, player: LobbyPlayer): boolean {
  if (!player.isBot || player.isHost) return false;
  const seat = lobby.seats.find((candidate) => candidate.id === player.id);
  return seat === undefined || seat.token.length === 0;
}

/** The latest-joined bot rider on a team, or undefined. */
function newestSeatedBot(lobby: HostLobby): LobbyPlayer | undefined {
  const players = lobby.state.players;
  for (let i = players.length - 1; i >= 0; i--) {
    const player = players[i];
    if (player !== undefined && player.side !== 'spectator' && isSeatedBot(lobby, player)) {
      return player;
    }
  }
  return undefined;
}

/** The first bot name nobody in the room uses, starting at a seeded place in the list. */
function pickBotName(players: readonly LobbyPlayer[], seed: number): string {
  const names = BOT_RIDER_NAMES;
  const taken = players.map((player) => player.name);
  const used = new Set(taken.map((name) => name.toLowerCase()));
  const start = Math.floor(createSeededRandom(seed)() * names.length);
  for (let i = 0; i < names.length; i++) {
    const name = names[(start + i) % names.length];
    if (name !== undefined && !used.has(name.toLowerCase())) return name;
  }
  return dedupePlayerName(names[start % names.length] ?? 'Rider', taken);
}

function seatBot(
  lobby: HostLobby,
  side: TeamId,
  seed: number,
  classId: DragonClassId | undefined,
): HostLobby {
  const state = lobby.state;
  const players = state.players;
  const allowed = state.settings.allowedClasses;
  const random = createSeededRandom(seed ^ 0x51ed270b);
  const picked =
    classId !== undefined && allowed.includes(classId)
      ? classId
      : (allowed[Math.floor(random() * allowed.length)] ?? fallbackClass(allowed));
  const id = lowestFreeId(players);
  const bot: LobbyPlayer = {
    id,
    name: pickBotName(players, seed),
    side,
    perch: lowestFreePerch(players, side),
    classId: picked,
    // A bot is always ready (and `canStart` does not wait for bots anyway).
    ready: true,
    isHost: false,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: true,
  };
  return {
    ...lobby,
    state: { ...state, players: [...players, bot] },
    seats: [...lobby.seats, { id, token: '', clientId: '' }],
  };
}

function roomHasSeat(state: LobbyState): boolean {
  return state.players.length < MAX_LOBBY_MEMBERS && state.players.length < NO_PLAYER;
}

/**
 * Host seats a bot rider on `side`. The name comes from BOT_RIDER_NAMES and, unless `classId` is
 * given and allowed, the class from the allowed list; both are picked with `seed` (the caller
 * supplies a new one per call), so the same lobby and seed always give the same bot. Refused
 * with `teamFull` when the team has `teamSize` riders or the room has no seat left. Locked teams
 * do not stop it: the lock is about who sits where, and a new bot moves nobody.
 */
export function addBot(
  lobby: HostLobby,
  actorId: PlayerId,
  side: TeamId,
  seed: number,
  classId?: DragonClassId,
): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!isBotSide(side) || !isRealNumber(seed)) return refuse(lobby, 'invalidValue');
  if (classId !== undefined && !isDragonClassId(classId)) return refuse(lobby, 'invalidValue');
  const state = lobby.state;
  if (countLobbySide(state.players, side) >= state.settings.teamSize || !roomHasSeat(state)) {
    return refuse(lobby, 'teamFull');
  }
  return done(lobby, seatBot(lobby, side, seed, classId));
}

/**
 * Host fills every empty team slot with a bot, the smaller team first (Ember on a tie), so the
 * teams end up even. Nothing to fill is not an error.
 */
export function fillBots(lobby: HostLobby, actorId: PlayerId, seed: number): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!isRealNumber(seed)) return refuse(lobby, 'invalidValue');
  let next = lobby;
  for (let added = 0; added < MAX_TEAM_SIZE * 2; added++) {
    const state = next.state;
    if (!roomHasSeat(state)) break;
    const ember = countLobbySide(state.players, TEAM_EMBER);
    const frost = countLobbySide(state.players, TEAM_FROST);
    const side: TeamId = frost < ember ? TEAM_FROST : TEAM_EMBER;
    if (Math.min(ember, frost) >= state.settings.teamSize) break;
    next = seatBot(next, side, (seed + Math.imul(added + 1, 0x9e3779b1)) >>> 0, undefined);
  }
  return done(lobby, next);
}

/**
 * Host removes one bot rider, in any phase (mid-match its dragon leaves with it). A human is
 * refused with `invalidValue`: that is `kickPlayer`, which also bans the seat.
 */
export function removeBot(lobby: HostLobby, actorId: PlayerId, playerId: PlayerId): LobbyResult {
  const refusal = hostRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  const target = findLobbyPlayer(lobby.state, playerId);
  if (target === undefined) return refuse(lobby, 'unknownPlayer');
  if (!isSeatedBot(lobby, target)) return refuse(lobby, 'invalidValue');
  return done(lobby, removePlayer(lobby, playerId), [
    { type: 'playerRemoved', playerId, cause: 'left' },
  ]);
}

/** Host removes every bot rider it added. `?bots=N` fake clients are connections and stay. */
export function clearBots(lobby: HostLobby, actorId: PlayerId): LobbyResult {
  const refusal = hostRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  let next = lobby;
  const effects: LobbyEffect[] = [];
  for (const player of lobby.state.players) {
    if (!isSeatedBot(lobby, player)) continue;
    next = removePlayer(next, player.id);
    effects.push({ type: 'playerRemoved', playerId: player.id, cause: 'left' });
  }
  return done(lobby, next, effects);
}

/** Host sets how well the bots fly and fight (a match rule: read when the match starts). */
export function setBotDifficulty(
  lobby: HostLobby,
  actorId: PlayerId,
  difficulty: BotDifficulty,
): LobbyResult {
  const refusal = hostPanelRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  if (!isBotDifficulty(difficulty)) return refuse(lobby, 'invalidValue');
  if (lobby.state.settings.botDifficulty === difficulty) return done(lobby, lobby);
  return applySettings(lobby, { botDifficulty: difficulty });
}

// --- Match flow ---------------------------------------------------------------------------------

/**
 * Host presses Start. Checked by `canStart`; on success the room enters `starting` and the
 * `matchStart` effect carries the roster. `force` skips only the ready check.
 *
 * `starting` is the lobby launch (the dragons take off, MATCH_TUNING.lobbyLaunchS on the host's
 * clock): teams, classes, ready flags and settings are frozen, newcomers spectate, and the host
 * ends it with `launchMatch`.
 */
export function startMatch(
  lobby: HostLobby,
  actorId: PlayerId,
  options?: StartOptions,
): LobbyResult {
  const refusal = hostRefusal(lobby, actorId);
  if (refusal !== null) return refuse(lobby, refusal);
  const check = canStart(lobby.state, options);
  if (!check.ok) return refuse(lobby, check.reason);
  const roster = buildMatchRoster(lobby.state);
  const next: HostLobby = { ...lobby, state: { ...lobby.state, phase: 'starting' } };
  return done(lobby, next, [{ type: 'matchStart', roster }]);
}

/**
 * The lobby launch is over: the room goes `starting` → `inMatch` and the `matchLaunch` effect
 * carries the roster to load. The roster is built from the room as it is NOW, not as it was when
 * Start was pressed, because riders can still go during the launch: one who left, was kicked or
 * was a removed bot is simply not in it, and one whose connection dropped keeps its seat (the
 * host flies it until it is back or its seat expires, as in any match).
 *
 * If that leaves a team with nobody (and Start was not a solo sandbox: `solo`), there is no
 * match to play: the room goes back to `lobby` with every ready flag cleared and no effect.
 * Called by the host's own flow, not a player.
 */
export function launchMatch(lobby: HostLobby, solo = false): LobbyResult {
  if (lobby.state.phase !== 'starting') return refuse(lobby, 'wrongPhase');
  const roster = buildMatchRoster(lobby.state);
  let ember = 0;
  let frost = 0;
  for (const rider of roster.riders) {
    if (rider.team === TEAM_EMBER) ember += 1;
    else frost += 1;
  }
  const playable = solo ? roster.solo : ember > 0 && frost > 0;
  if (!playable) return returnToLobby(lobby);
  const next: HostLobby = { ...lobby, state: { ...lobby.state, phase: 'inMatch' } };
  return done(lobby, next, [{ type: 'matchLaunch', roster }]);
}

/** `starting` → `inMatch` and nothing else. Called by the host's own flow, not a player. */
export function enterMatch(lobby: HostLobby): LobbyResult {
  if (lobby.state.phase !== 'starting') return refuse(lobby, 'wrongPhase');
  return done(lobby, { ...lobby, state: { ...lobby.state, phase: 'inMatch' } });
}

/**
 * Back to the aerie after the results podium (or a cancelled start). Teams, classes and settings
 * are kept; every ready flag is cleared. Called by the host's own flow, not a player.
 */
export function returnToLobby(lobby: HostLobby): LobbyResult {
  if (lobby.state.phase === 'lobby') return done(lobby, lobby);
  const players = lobby.state.players.map((player) =>
    player.ready ? { ...player, ready: false } : player,
  );
  return done(lobby, { ...lobby, state: { ...lobby.state, phase: 'lobby', players } });
}
