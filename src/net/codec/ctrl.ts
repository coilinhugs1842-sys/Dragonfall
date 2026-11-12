/**
 * `ctrl` channel messages (reliable, ordered): handshake, lobby, intents, clock sync, match
 * flow and notices. These are rare, so text fields and decoded intents may allocate; the
 * numeric ones (PING/PONG) do not.
 *
 * Framing is the same as on `fast`: the 3-byte binary header, then a binary body. The lobby
 * state is the one JSON payload, carried as length-prefixed UTF-8 inside that binary frame.
 *
 * Layouts after the header:
 *   HELLO        u16 protocolVersion, u8 tokenBytes, token (ASCII), u8 idBytes, clientId (ASCII),
 *                u8 nameBytes, name (UTF-8)
 *   WELCOME      u8 playerId, u32 hostTick, u8 tokenBytes, token, u16 jsonBytes, lobby state JSON
 *   REJECT       u8 reason                         index into REJECT_REASONS
 *   LOBBY_STATE  u16 jsonBytes, lobby state JSON
 *   INTENT       u8 intent, body                   see `encodeIntent`
 *   PING         f64 clientTimeMs
 *   PONG         f64 clientTimeMs, f64 hostTimeMs, u32 hostTick
 *   MATCH_START  u32 startTick, u32 seed, u8 map   (index into MAP_IDS)
 *   MATCH_PHASE  u32 phaseStartTick, u8 phase, u8 round, u8 winner
 *                (header tick = low 16 bits of the tick play begins while `intro` / `countdown`)
 *   KICK         (nothing)
 *   HOST_LEFT    (nothing)
 */

import {
  DRAGON_CLASS_IDS,
  MATCH_PHASES,
  NO_PLAYER,
  PROTOCOL_VERSION,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../shared';
import type { DragonClassId, LobbySide, LobbyState, UiIntent } from '../../shared';
import {
  CTRL_MAX_BYTES,
  DECODE_BAD_PAYLOAD,
  DECODE_BAD_VALUE,
  HELLO_MAX_BYTES,
  HOST_LEFT_BYTES,
  KICK_BYTES,
  MAP_IDS,
  MATCH_PHASE_BYTES,
  MATCH_START_BYTES,
  MAX_LOBBY_JSON_BYTES,
  MAX_PLAYER_NAME_BYTES,
  MAX_RECONNECT_TOKEN_BYTES,
  MODE_IDS,
  MSG_HELLO,
  MSG_HOST_LEFT,
  MSG_INTENT,
  MSG_KICK,
  MSG_LOBBY_STATE,
  MSG_MATCH_PHASE,
  MSG_MATCH_START,
  MSG_PING,
  MSG_PONG,
  MSG_REJECT,
  MSG_WELCOME,
  NET_INTENT_TYPES,
  PING_BYTES,
  PONG_BYTES,
  REJECT_BYTES,
  REJECT_REASONS,
  WIRE_SIDE_SPECTATOR,
} from '../protocol';
import type {
  HelloMessage,
  IntentMessage,
  LobbyStateMessage,
  MatchPhaseMessage,
  MatchStartMessage,
  NetIntent,
  NetIntentType,
  NoticeMessage,
  PingMessage,
  PongMessage,
  RejectMessage,
  WelcomeMessage,
} from '../protocol';
import { winnerFromWire, winnerToWire } from './events';
import type { Reader, Writer } from './io';
import { sanitizePlayerName, validateLobbyState } from '../../sim/lobby';

const INTENT_MAX_BYTES = 16;
const HEX = '0123456789abcdef';

// --- Reconnect token -----------------------------------------------------------------------------

/** True for 1..MAX_RECONNECT_TOKEN_BYTES printable ASCII characters (no spaces). */
export function isReconnectToken(value: string): boolean {
  if (value.length < 1 || value.length > MAX_RECONNECT_TOKEN_BYTES) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Hex token from random bytes (16 bytes = 128 bits is plenty). The caller supplies the bytes,
 * e.g. from `crypto.getRandomValues`, so this module stays free of platform APIs.
 */
export function reconnectTokenFromBytes(bytes: ArrayLike<number>): string {
  let token = '';
  const length = Math.min(bytes.length, MAX_RECONNECT_TOKEN_BYTES / 2);
  for (let i = 0; i < length; i++) {
    const byte = (bytes[i] ?? 0) & 0xff;
    token += HEX.charAt(byte >> 4) + HEX.charAt(byte & 15);
  }
  return token;
}

/** Reads a token; '' when absent. A token with illegal characters fails the decode. */
function readToken(r: Reader): string {
  const token = r.text(1, MAX_RECONNECT_TOKEN_BYTES);
  if (r.ok && token.length > 0 && !isReconnectToken(token)) r.fail(DECODE_BAD_VALUE);
  return token;
}

function parseLobbyJson(text: string): LobbyState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateLobbyState(parsed);
}

// --- HELLO ---------------------------------------------------------------------------------------

/**
 * The name is sanitized before it is written; a malformed token or client id is sent as "none".
 */
export function encodeHello(w: Writer, msg: Readonly<HelloMessage>): number {
  w.reset();
  w.header(MSG_HELLO, msg.tick);
  w.u16(msg.protocolVersion & 0xffff);
  const token = isReconnectToken(msg.reconnectToken) ? msg.reconnectToken : '';
  w.text(token, 1, MAX_RECONNECT_TOKEN_BYTES);
  w.text(isReconnectToken(msg.clientId) ? msg.clientId : '', 1, MAX_RECONNECT_TOKEN_BYTES);
  w.text(sanitizePlayerName(msg.name), 1, MAX_PLAYER_NAME_BYTES);
  return w.finish();
}

/**
 * Reads a HELLO from untrusted bytes. The version comes first on the wire and is checked first:
 * when it is not PROTOCOL_VERSION the rest of the buffer is NOT parsed (its layout may differ),
 * `name`, `reconnectToken` and `clientId` are '' and the result is still true, so the host can answer
 * `versionMismatch`. Otherwise the name is cleaned with the lobby's `sanitizePlayerName` (cut
 * to MAX_PLAYER_NAME_LENGTH characters, never empty).
 */
export function decodeHello(r: Reader, into: HelloMessage): boolean {
  const tick = r.header(MSG_HELLO, HELLO_MAX_BYTES);
  const version = r.u16();
  if (!r.ok) return false;
  into.tick = tick;
  into.protocolVersion = version;
  into.name = '';
  into.reconnectToken = '';
  into.clientId = '';
  if (version !== PROTOCOL_VERSION) return true;

  const token = readToken(r);
  const clientId = readToken(r);
  const name = r.text(1, 255);
  if (!r.finish()) return false;
  into.reconnectToken = token;
  into.clientId = clientId;
  into.name = sanitizePlayerName(name);
  return true;
}

// --- WELCOME / LOBBY_STATE -----------------------------------------------------------------------

/** Returns 0 if the lobby state is null, the token is malformed (not '') or the JSON is too large. */
export function encodeWelcome(w: Writer, msg: Readonly<WelcomeMessage>): number {
  w.reset();
  if (msg.lobbyState === null) return 0;
  if (msg.reconnectToken !== '' && !isReconnectToken(msg.reconnectToken)) return 0;
  w.header(MSG_WELCOME, msg.tick);
  w.u8(msg.playerId);
  w.u32(msg.hostTick >>> 0);
  w.text(msg.reconnectToken, 1, MAX_RECONNECT_TOKEN_BYTES);
  w.text(JSON.stringify(msg.lobbyState), 2, MAX_LOBBY_JSON_BYTES);
  return w.finish();
}

/** The lobby state is checked and rebuilt by `validateLobbyState`; anything else fails the decode. */
export function decodeWelcome(r: Reader, into: WelcomeMessage): boolean {
  const tick = r.header(MSG_WELCOME, CTRL_MAX_BYTES);
  const playerId = r.u8();
  const hostTick = r.u32();
  const token = readToken(r);
  const json = r.text(2, MAX_LOBBY_JSON_BYTES);
  if (!r.finish()) return false;
  if (playerId === NO_PLAYER) return r.fail(DECODE_BAD_VALUE);
  const lobbyState = parseLobbyJson(json);
  if (lobbyState === null) return r.fail(DECODE_BAD_PAYLOAD);
  into.tick = tick;
  into.playerId = playerId;
  into.reconnectToken = token;
  into.hostTick = hostTick;
  into.lobbyState = lobbyState;
  return true;
}

/** Returns 0 if the lobby state is null or its JSON is too large. */
export function encodeLobbyState(w: Writer, msg: Readonly<LobbyStateMessage>): number {
  w.reset();
  if (msg.lobbyState === null) return 0;
  w.header(MSG_LOBBY_STATE, msg.tick);
  w.text(JSON.stringify(msg.lobbyState), 2, MAX_LOBBY_JSON_BYTES);
  return w.finish();
}

export function decodeLobbyState(r: Reader, into: LobbyStateMessage): boolean {
  const tick = r.header(MSG_LOBBY_STATE, CTRL_MAX_BYTES);
  const json = r.text(2, MAX_LOBBY_JSON_BYTES);
  if (!r.finish()) return false;
  const lobbyState = parseLobbyJson(json);
  if (lobbyState === null) return r.fail(DECODE_BAD_PAYLOAD);
  into.tick = tick;
  into.lobbyState = lobbyState;
  return true;
}

// --- REJECT --------------------------------------------------------------------------------------

export function encodeReject(w: Writer, msg: Readonly<RejectMessage>): number {
  w.reset();
  const reason = REJECT_REASONS.indexOf(msg.reason);
  if (reason < 0) return 0;
  w.header(MSG_REJECT, msg.tick);
  w.u8(reason);
  return w.finish();
}

export function decodeReject(r: Reader, into: RejectMessage): boolean {
  const tick = r.header(MSG_REJECT, REJECT_BYTES);
  const reason = REJECT_REASONS[r.u8()];
  if (!r.finish()) return false;
  if (reason === undefined) return r.fail(DECODE_BAD_VALUE);
  into.tick = tick;
  into.reason = reason;
  return true;
}

// --- INTENT --------------------------------------------------------------------------------------

/** True for the intents that are sent to the host (see NET_INTENT_TYPES). */
export function isNetIntent(intent: UiIntent | NetIntent): intent is NetIntent {
  return (NET_INTENT_TYPES as readonly string[]).includes(intent.type);
}

function sideToWire(side: LobbySide): number {
  return side === 'spectator' ? WIRE_SIDE_SPECTATOR : side;
}

function sideFromWire(value: number): LobbySide | undefined {
  if (value === TEAM_EMBER) return TEAM_EMBER;
  if (value === TEAM_FROST) return TEAM_FROST;
  return value === WIRE_SIDE_SPECTATOR ? 'spectator' : undefined;
}

function wireIndex(index: number, w: Writer): number {
  // A value that is not in its wire table cannot be sent: fail the encode.
  if (index < 0) w.overflow = true;
  return index < 0 ? 0 : index;
}

/**
 * Body per intent (after the `u8` index into NET_INTENT_TYPES):
 *   lobby.ready, host.setUnevenTeams, host.setFriendlyFire, host.lockTeams   u8 (0 or 1)
 *   lobby.pickClass          u8 class            host.setMode / host.setMap   u8 index
 *   host.setTeamSize         u8                  host.setScoreLimit           u16
 *   host.setTimeLimit        u16 seconds         host.setAllowedClasses       u8 bitmask
 *   host.movePlayer          u8 playerId, u8 side (0, 1, 2 = spectator)
 *   host.kick                u8 playerId         lobby.switchSide             u8 side
 *   lobby.leave, host.autoBalance, host.shuffle, host.start                   nothing
 * Returns 0 if `msg.intent` is null or holds a value that has no wire encoding.
 */
export function encodeIntent(w: Writer, msg: Readonly<IntentMessage>): number {
  w.reset();
  const intent = msg.intent;
  if (intent === null) return 0;
  w.header(MSG_INTENT, msg.tick);
  w.u8(wireIndex(NET_INTENT_TYPES.indexOf(intent.type), w));
  switch (intent.type) {
    case 'lobby.ready':
      w.u8(intent.ready ? 1 : 0);
      break;
    case 'lobby.pickClass':
      w.u8(wireIndex(DRAGON_CLASS_IDS.indexOf(intent.classId), w));
      break;
    case 'lobby.switchSide':
      w.u8(sideToWire(intent.side));
      break;
    case 'host.setMode':
      w.u8(wireIndex(MODE_IDS.indexOf(intent.mode), w));
      break;
    case 'host.setMap':
      w.u8(wireIndex(MAP_IDS.indexOf(intent.map), w));
      break;
    case 'host.setTeamSize':
      w.u8(clampU(intent.teamSize, 255));
      break;
    case 'host.setUnevenTeams':
    case 'host.setFriendlyFire':
      w.u8(intent.enabled ? 1 : 0);
      break;
    case 'host.setScoreLimit':
      w.u16(clampU(intent.scoreLimit, 0xffff));
      break;
    case 'host.setTimeLimit':
      w.u16(clampU(intent.timeLimitS, 0xffff));
      break;
    case 'host.setAllowedClasses': {
      let mask = 0;
      for (const classId of intent.classes) {
        mask |= 1 << wireIndex(DRAGON_CLASS_IDS.indexOf(classId), w);
      }
      w.u8(mask);
      break;
    }
    case 'host.movePlayer':
      w.u8(intent.playerId);
      w.u8(sideToWire(intent.side));
      break;
    case 'host.lockTeams':
      w.u8(intent.locked ? 1 : 0);
      break;
    case 'host.kick':
      w.u8(intent.playerId);
      break;
    case 'lobby.leave':
    case 'host.autoBalance':
    case 'host.shuffle':
    case 'host.start':
      break;
  }
  return w.finish();
}

function clampU(value: number, max: number): number {
  // `!(> 0)` also catches NaN.
  if (!(value > 0)) return 0;
  return value >= max ? max : Math.round(value);
}

/** Reads the body of one intent; null means a value was out of range. */
function readIntent(r: Reader, type: NetIntentType): NetIntent | null {
  switch (type) {
    case 'lobby.ready': {
      const flag = r.u8();
      return flag > 1 ? null : { type, ready: flag === 1 };
    }
    case 'lobby.pickClass': {
      const classId = DRAGON_CLASS_IDS[r.u8()];
      return classId === undefined ? null : { type, classId };
    }
    case 'lobby.switchSide': {
      const side = sideFromWire(r.u8());
      return side === undefined ? null : { type, side };
    }
    case 'host.setMode': {
      const mode = MODE_IDS[r.u8()];
      return mode === undefined ? null : { type, mode };
    }
    case 'host.setMap': {
      const map = MAP_IDS[r.u8()];
      return map === undefined ? null : { type, map };
    }
    // Ranges of the three numbers are the lobby operations' job (they clamp or refuse).
    case 'host.setTeamSize':
      return { type, teamSize: r.u8() };
    case 'host.setUnevenTeams':
    case 'host.setFriendlyFire': {
      const flag = r.u8();
      return flag > 1 ? null : { type, enabled: flag === 1 };
    }
    case 'host.setScoreLimit':
      return { type, scoreLimit: r.u16() };
    case 'host.setTimeLimit':
      return { type, timeLimitS: r.u16() };
    case 'host.setAllowedClasses': {
      const mask = r.u8();
      if (mask >>> DRAGON_CLASS_IDS.length !== 0) return null;
      const classes: DragonClassId[] = [];
      for (let i = 0; i < DRAGON_CLASS_IDS.length; i++) {
        const classId = DRAGON_CLASS_IDS[i];
        if (classId !== undefined && (mask & (1 << i)) !== 0) classes.push(classId);
      }
      return { type, classes };
    }
    case 'host.movePlayer': {
      const playerId = r.u8();
      const side = sideFromWire(r.u8());
      return playerId === NO_PLAYER || side === undefined ? null : { type, playerId, side };
    }
    case 'host.lockTeams': {
      const flag = r.u8();
      return flag > 1 ? null : { type, locked: flag === 1 };
    }
    case 'host.kick': {
      const playerId = r.u8();
      return playerId === NO_PLAYER ? null : { type, playerId };
    }
    case 'lobby.leave':
    case 'host.autoBalance':
    case 'host.shuffle':
    case 'host.start':
      return { type };
  }
}

/**
 * Reads an INTENT from untrusted bytes into a fresh, fully validated intent object. Decoding a
 * `host.*` intent does NOT mean the sender may use it: the host checks the sender's player id
 * (`isHostIntent`) and rate-limits intents.
 */
export function decodeIntent(r: Reader, into: IntentMessage): boolean {
  const tick = r.header(MSG_INTENT, INTENT_MAX_BYTES);
  const type = NET_INTENT_TYPES[r.u8()];
  if (!r.ok) return false;
  if (type === undefined) return r.fail(DECODE_BAD_VALUE);
  const intent = readIntent(r, type);
  if (!r.finish()) return false;
  if (intent === null) return r.fail(DECODE_BAD_VALUE);
  into.tick = tick;
  into.intent = intent;
  return true;
}

// --- PING / PONG ---------------------------------------------------------------------------------

export function encodePing(w: Writer, msg: Readonly<PingMessage>): number {
  w.reset();
  w.header(MSG_PING, msg.tick);
  w.f64(msg.clientTimeMs);
  return w.finish();
}

export function decodePing(r: Reader, into: PingMessage): boolean {
  const tick = r.header(MSG_PING, PING_BYTES);
  const clientTimeMs = r.f64();
  if (!r.finish()) return false;
  // `x - x` is NaN for NaN and both infinities.
  if (clientTimeMs - clientTimeMs !== 0) return r.fail(DECODE_BAD_VALUE);
  into.tick = tick;
  into.clientTimeMs = clientTimeMs;
  return true;
}

export function encodePong(w: Writer, msg: Readonly<PongMessage>): number {
  w.reset();
  w.header(MSG_PONG, msg.tick);
  w.f64(msg.clientTimeMs);
  w.f64(msg.hostTimeMs);
  w.u32(msg.hostTick >>> 0);
  return w.finish();
}

export function decodePong(r: Reader, into: PongMessage): boolean {
  const tick = r.header(MSG_PONG, PONG_BYTES);
  const clientTimeMs = r.f64();
  const hostTimeMs = r.f64();
  const hostTick = r.u32();
  if (!r.finish()) return false;
  if (clientTimeMs - clientTimeMs !== 0 || hostTimeMs - hostTimeMs !== 0) {
    return r.fail(DECODE_BAD_VALUE);
  }
  into.tick = tick;
  into.clientTimeMs = clientTimeMs;
  into.hostTimeMs = hostTimeMs;
  into.hostTick = hostTick;
  return true;
}

// --- MATCH_START / MATCH_PHASE -------------------------------------------------------------------

export function encodeMatchStart(w: Writer, msg: Readonly<MatchStartMessage>): number {
  w.reset();
  w.header(MSG_MATCH_START, msg.tick);
  w.u32(msg.startTick >>> 0);
  w.u32(msg.seed >>> 0);
  w.u8(wireIndex(MAP_IDS.indexOf(msg.map), w));
  return w.finish();
}

export function decodeMatchStart(r: Reader, into: MatchStartMessage): boolean {
  const tick = r.header(MSG_MATCH_START, MATCH_START_BYTES);
  const startTick = r.u32();
  const seed = r.u32();
  const map = MAP_IDS[r.u8()];
  // A map this build does not know: refuse the message whole, never guess a map.
  if (!r.finish() || map === undefined) return false;
  into.tick = tick;
  into.startTick = startTick;
  into.seed = seed;
  into.map = map;
  return true;
}

export function encodeMatchPhase(w: Writer, msg: Readonly<MatchPhaseMessage>): number {
  w.reset();
  const phase = MATCH_PHASES.indexOf(msg.phase);
  if (phase < 0) return 0;
  w.header(MSG_MATCH_PHASE, msg.tick);
  w.u32(msg.phaseStartTick >>> 0);
  w.u8(phase);
  w.u8(clampU(msg.round, 255));
  w.u8(winnerToWire(msg.winner));
  return w.finish();
}

export function decodeMatchPhase(r: Reader, into: MatchPhaseMessage): boolean {
  const tick = r.header(MSG_MATCH_PHASE, MATCH_PHASE_BYTES);
  const phaseStartTick = r.u32();
  const phase = MATCH_PHASES[r.u8()];
  const round = r.u8();
  const winner = winnerFromWire(r.u8());
  if (!r.finish()) return false;
  if (phase === undefined || winner === undefined) return r.fail(DECODE_BAD_VALUE);
  into.tick = tick;
  into.phaseStartTick = phaseStartTick;
  into.phase = phase;
  into.round = round;
  into.winner = winner;
  return true;
}

// --- KICK / HOST_LEFT ----------------------------------------------------------------------------

/** Host -> one client: "you were removed". The host closes the connection right after. */
export function encodeKick(w: Writer, msg: Readonly<NoticeMessage>): number {
  w.reset();
  w.header(MSG_KICK, msg.tick);
  return w.finish();
}

export function decodeKick(r: Reader, into: NoticeMessage): boolean {
  const tick = r.header(MSG_KICK, KICK_BYTES);
  if (!r.finish()) return false;
  into.tick = tick;
  return true;
}

/** Host -> every client, sent on a deliberate leave (a crash shows up as a closed channel). */
export function encodeHostLeft(w: Writer, msg: Readonly<NoticeMessage>): number {
  w.reset();
  w.header(MSG_HOST_LEFT, msg.tick);
  return w.finish();
}

export function decodeHostLeft(r: Reader, into: NoticeMessage): boolean {
  const tick = r.header(MSG_HOST_LEFT, HOST_LEFT_BYTES);
  if (!r.finish()) return false;
  into.tick = tick;
  return true;
}
