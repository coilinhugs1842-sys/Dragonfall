/**
 * Wire protocol: message ids, limits, wire tables and the reusable message structs the codec
 * (`./codec`) fills and reads. Pure data, no transport. Spec: docs/NETWORKING.md.
 *
 * Every message starts with the same 3-byte header: `u8 type`, `u16 tick` (little-endian, like
 * every multi-byte field). `tick` is the sender's sim tick modulo 65536; see the tick helpers in
 * `./codec/quantize`.
 *
 * Changing any layout, id or table order here is a wire-format change: bump PROTOCOL_VERSION in
 * `src/shared/constants.ts`.
 */

import {
  DRAGON_ANIM_GLIDE,
  GREYBOX_CEILING_Y,
  GREYBOX_FLOOR_Y,
  GREYBOX_STORM_RADIUS,
  INPUT_REDUNDANCY,
  MAX_PLAYERS,
  MAX_PLAYER_NAME_LENGTH,
  NO_PLAYER,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  SNAPSHOT_MAX_PROJECTILES,
  SNAPSHOT_MAX_ZONES,
  TEAM_EMBER,
  TICK_HZ,
  createInputFrame,
  createQuat,
  createVec3,
} from '../shared';
import type {
  DragonAnimState,
  InputFrame,
  LobbyState,
  MapId,
  MatchPhase,
  MatchWinner,
  ModeId,
  MutableQuat,
  MutableVec3,
  PlayerId,
  RejectReason,
  TeamId,
} from '../shared';
import type { DragonState } from '../sim';
import { MAX_RECONNECT_TOKEN_LENGTH } from '../sim/lobby';
import type { LobbyIntent } from '../sim/lobby';

export { PROTOCOL_VERSION };

// --- Message ids ---------------------------------------------------------------------------------

/** `fast` channel (unreliable, unordered). */
export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;
/** `ctrl` channel (reliable, ordered). */
export const MSG_HELLO = 16;
export const MSG_WELCOME = 17;
export const MSG_REJECT = 18;
export const MSG_LOBBY_STATE = 19;
export const MSG_INTENT = 20;
export const MSG_PING = 21;
export const MSG_PONG = 22;
export const MSG_MATCH_START = 23;
export const MSG_MATCH_PHASE = 24;
export const MSG_GAME_EVENTS = 25;
export const MSG_KICK = 26;
export const MSG_HOST_LEFT = 27;
// 28 is reserved for CHAT.
/**
 * `ctrl`, H->C, about once a second: every player's round trip, for the ping column. Its codec
 * lives with the sessions (`./session/pings`). An older client drops it as an unknown type.
 */
export const MSG_PLAYER_PINGS = 29;
/**
 * `ctrl`, H->C, at most once a second while a match runs and with every round / match result:
 * every rider's takedowns, deaths, assists, damage and healing. Codec in `./session/scores`.
 */
export const MSG_SCOREBOARD = 30;
/**
 * `ctrl`, H->C, Ember Relay only: where the stands and braziers are and the state of both
 * shards. Sent when it changes and to whoever joins mid-match. Codec in `./session/relay`.
 */
export const MSG_RELAY = 31;

/** What `Reader.peekType` returns for an empty buffer or an id that is not in the table. */
export const MSG_INVALID = -1;

export type MessageType =
  | typeof MSG_INPUT
  | typeof MSG_SNAPSHOT
  | typeof MSG_HELLO
  | typeof MSG_WELCOME
  | typeof MSG_REJECT
  | typeof MSG_LOBBY_STATE
  | typeof MSG_INTENT
  | typeof MSG_PING
  | typeof MSG_PONG
  | typeof MSG_MATCH_START
  | typeof MSG_MATCH_PHASE
  | typeof MSG_GAME_EVENTS
  | typeof MSG_KICK
  | typeof MSG_HOST_LEFT
  | typeof MSG_PLAYER_PINGS
  | typeof MSG_SCOREBOARD
  | typeof MSG_RELAY;

export function isMessageType(value: number): value is MessageType {
  return (
    value === MSG_INPUT ||
    value === MSG_SNAPSHOT ||
    (value >= MSG_HELLO && value <= MSG_HOST_LEFT) ||
    value === MSG_PLAYER_PINGS ||
    value === MSG_SCOREBOARD ||
    value === MSG_RELAY
  );
}

/** True for the two message types that travel on the unreliable `fast` channel. */
export function isFastMessage(type: number): boolean {
  return type === MSG_INPUT || type === MSG_SNAPSHOT;
}

/** Messages only a client may send; the host drops everything else it receives. */
export function isClientToHostMessage(type: number): boolean {
  return type === MSG_INPUT || type === MSG_HELLO || type === MSG_INTENT || type === MSG_PING;
}

// --- Decode failures -----------------------------------------------------------------------------

/** Why a decode returned false; read it from `Reader.error`. */
export const DECODE_OK = 0;
/** The buffer ended before the message did. */
export const DECODE_TRUNCATED = 1;
/** Bytes left over after the message, or a buffer above the size limit. */
export const DECODE_OVERSIZED = 2;
/** The header's type byte is not the message this decoder handles. */
export const DECODE_WRONG_TYPE = 3;
/** A count, id, enum index or number was outside its legal range. */
export const DECODE_BAD_VALUE = 4;
/** A JSON payload did not parse or did not have the expected shape. */
export const DECODE_BAD_PAYLOAD = 5;
/** Well-formed, but uses a part of the format that is reserved in this protocol version. */
export const DECODE_UNSUPPORTED = 6;

export type DecodeError =
  | typeof DECODE_OK
  | typeof DECODE_TRUNCATED
  | typeof DECODE_OVERSIZED
  | typeof DECODE_WRONG_TYPE
  | typeof DECODE_BAD_VALUE
  | typeof DECODE_BAD_PAYLOAD
  | typeof DECODE_UNSUPPORTED;

/** Index = DecodeError value, for logs. */
export const DECODE_ERROR_NAMES: readonly string[] = [
  'ok',
  'truncated',
  'oversized',
  'wrongType',
  'badValue',
  'badPayload',
  'unsupported',
];

// --- Sizes and limits ----------------------------------------------------------------------------

export const HEADER_BYTES = 3;

/** Newest frame + the repeats (docs/NETWORKING.md: "repeats the previous 2 inputs"). */
export const INPUT_FRAMES_PER_PACKET = 1 + INPUT_REDUNDANCY;
/** steer 2 x i16, buttons u16, aim yaw and pitch 2 x i16. */
export const INPUT_FRAME_BYTES = 10;
/** header, u16 ackSnapshotTick, u8 count|flags. */
export const INPUT_FIXED_BYTES = HEADER_BYTES + 3;
export const INPUT_MAX_BYTES = INPUT_FIXED_BYTES + INPUT_FRAMES_PER_PACKET * INPUT_FRAME_BYTES;

/** A snapshot never carries more dragons than the sim has slots. */
export const SNAPSHOT_MAX_DRAGONS = MAX_PLAYERS;
/** u8 id, 3 x i16 position, u32 orientation, 3 x i8 velocity, u8 health, u8 stamina, u16 flags, u8 anim. */
export const SNAPSHOT_DRAGON_BYTES = 19;
/**
 * The recipient's own dragon at full precision. Flight (84 bytes): u8 id, 15 x f32, u16 flags,
 * u16 prevButtons, u8 packed (boostLocked, dodgeDir), 9 x u16 timers. Combat (56 bytes): 3 x f32
 * (ultCharge, slowScale, hasteScale), 4 x u16 cooldowns, 4 x u16 active timers, 4 x u8 charges
 * used, u8 castSlot + 1, u16 castTicks, 10 x u16 timers, u8 lastDamagerId.
 */
export const SNAPSHOT_OWNER_FLIGHT_BYTES = 1 + 15 * 4 + 2 + 2 + 1 + 9 * 2;
export const SNAPSHOT_OWNER_COMBAT_BYTES = 3 * 4 + 4 * 2 + 4 * 2 + 4 + 1 + 2 + 10 * 2 + 1;
export const SNAPSHOT_OWNER_BYTES = SNAPSHOT_OWNER_FLIGHT_BYTES + SNAPSHOT_OWNER_COMBAT_BYTES;
/**
 * On the wire the owner block is packed: a bitmask with one bit per byte of the 140-byte image
 * (bit set = that byte follows), then only the bytes that are not zero. Most of the image is
 * zero most of the time (idle timers, the high byte of small counts, an empty burst), so the
 * block is about half its size in flight; it is lossless, and each snapshot stands on its own.
 */
export const SNAPSHOT_OWNER_MASK_BYTES = Math.ceil(SNAPSHOT_OWNER_BYTES / 8);
/** The packed owner block at its worst: no byte of the image is zero. */
export const SNAPSHOT_OWNER_MAX_WIRE_BYTES = SNAPSHOT_OWNER_MASK_BYTES + SNAPSHOT_OWNER_BYTES;
/** u16 id, u8 kind | team << 4, u8 ownerId, 3 x i16 position, 3 x i8 velocity. */
export const SNAPSHOT_PROJECTILE_BYTES = 13;
/** u8 id, u8 kind | team << 4, u8 ownerId, 3 x i16 position, u8 radius, u8 remaining. */
export const SNAPSHOT_ZONE_BYTES = 11;
export { SNAPSHOT_MAX_PROJECTILES, SNAPSHOT_MAX_ZONES };
/**
 * A zone that stands where it was placed (`ZoneDef.follow` false) is not in every snapshot:
 * it is in the snapshots of its first SNAPSHOT_ZONE_FRESH_TICKS ticks, and after that only in
 * every SNAPSHOT_ZONE_REFRESH-th one (`staticZoneDue`). In between, the client carries it from
 * the snapshot before (`SnapshotBuffer.push`), counting its remaining time down. A zone missing
 * from a snapshot in which it was due has ended. Each snapshot still stands on its own: a lost
 * one costs nothing, and a client that joins late has every zone within a quarter second.
 */
export const SNAPSHOT_ZONE_FRESH_TICKS = 6;
export const SNAPSHOT_ZONE_REFRESH = 5;

/** Is the standing zone `zoneId` listed in the snapshot of `tick`? Same answer on both ends. */
export function staticZoneDue(tick: number, zoneId: number): boolean {
  const index = Math.floor((tick * SNAPSHOT_HZ) / TICK_HZ);
  return (index + zoneId) % SNAPSHOT_ZONE_REFRESH === 0;
}
/**
 * header, u16 ackInputTick, u8 flags, clock (u8 phase, u8 round, u16 phaseTicks,
 * u16 remainingTicks, u8 scoreEmber, u8 scoreFrost), u16 stormRadius, u8 dragonCount,
 * u8 projectileCount, u8 zoneCount.
 */
export const SNAPSHOT_FIXED_BYTES = HEADER_BYTES + 3 + 8 + 2 + 3;
export const SNAPSHOT_MAX_BYTES =
  SNAPSHOT_FIXED_BYTES +
  SNAPSHOT_OWNER_MAX_WIRE_BYTES +
  SNAPSHOT_MAX_DRAGONS * SNAPSHOT_DRAGON_BYTES +
  SNAPSHOT_MAX_PROJECTILES * SNAPSHOT_PROJECTILE_BYTES +
  SNAPSHOT_MAX_ZONES * SNAPSHOT_ZONE_BYTES;

/** Buffer size that holds any `fast` message. */
export const FAST_MAX_BYTES = SNAPSHOT_MAX_BYTES;

/** Wire limit on the UTF-8 bytes of a name (4 bytes per code point at worst). */
export const MAX_PLAYER_NAME_BYTES = MAX_PLAYER_NAME_LENGTH * 4;
/** Reconnect tokens are 1..MAX_RECONNECT_TOKEN_LENGTH printable ASCII characters. */
export const MAX_RECONNECT_TOKEN_BYTES = MAX_RECONNECT_TOKEN_LENGTH;
/** Upper bound on the UTF-8 JSON of a lobby state (MAX_LOBBY_MEMBERS players is about 4 KB). */
export const MAX_LOBBY_JSON_BYTES = 12 * 1024;
/** A GAME_EVENTS batch holds at most this many events (u8 count). */
export const MAX_EVENTS_PER_BATCH = 255;
/** Buffer size that holds any `ctrl` message; larger incoming buffers are rejected unread. */
export const CTRL_MAX_BYTES = 16 * 1024;

/** The decoder accepts any u8-length name and cuts it down, so the limit is the full 255. */
export const HELLO_MAX_BYTES =
  HEADER_BYTES + 2 + 1 + MAX_RECONNECT_TOKEN_BYTES + 1 + MAX_RECONNECT_TOKEN_BYTES + 1 + 255;
export const REJECT_BYTES = HEADER_BYTES + 1;
export const PING_BYTES = HEADER_BYTES + 8;
export const PONG_BYTES = HEADER_BYTES + 8 + 8 + 4;
export const MATCH_START_BYTES = HEADER_BYTES + 4 + 4 + 1;
export const MATCH_PHASE_BYTES = HEADER_BYTES + 4 + 1 + 1 + 1;
export const KICK_BYTES = HEADER_BYTES;
export const HOST_LEFT_BYTES = HEADER_BYTES;

// --- Quantization ranges -------------------------------------------------------------------------

/**
 * Positions are `i16` per axis with one step size on all three axes. The horizontal range is
 * the storm wall plus a margin (dragons pushed into the storm, dead dragons drifting out), and
 * `i16` over it gives the "about 6 cm" step of the spec: 1900 m / 32767 = 5.8 cm, so the
 * round-trip error is at most 2.9 cm per axis. Height uses the same step around the middle of
 * the flight band, which covers about 1.5 km below the cloud sea and above the ceiling.
 *
 * NOTE: derived from the greybox map. A map with a wider bowl needs these to come from its
 * manifest (and a PROTOCOL_VERSION bump, or the range sent in MATCH_START).
 */
export const WIRE_STORM_MARGIN_M = 900;
export const WIRE_POSITION_HALF_EXTENT_M = GREYBOX_STORM_RADIUS + WIRE_STORM_MARGIN_M;
export const WIRE_POSITION_STEP_M = WIRE_POSITION_HALF_EXTENT_M / 32767;
export const WIRE_POSITION_CENTER_Y_M = (GREYBOX_FLOOR_Y + GREYBOX_CEILING_Y) / 2;

/**
 * Velocity is `i8` per axis. The range covers the fastest dive of any class plus a full burst
 * (tests/net/codec-quantize.test.ts checks it against the tuning tables); the step is 1.5 m/s.
 * Remote velocity only feeds extrapolation and effects, so that is plenty. A hasted dragon at
 * full burst can exceed it by a few m/s on one axis and is clamped.
 */
export const WIRE_VELOCITY_MAX_MPS = 190;
/** Storm radius on the wire: `u16` in these steps; this value means "the map's own radius". */
export const WIRE_STORM_RADIUS_STEP_M = 0.1;
export const WIRE_STORM_RADIUS_DEFAULT = 0xffff;
/** Zone radius: `u8` in these steps (up to 127.5 m). */
export const WIRE_ZONE_RADIUS_STEP_M = 0.5;
/** Zone time left: `u8` in these steps (up to 25.4 s; 255 = longer or permanent). */
export const WIRE_ZONE_TIME_STEP_S = 0.1;
/** Aim angles: `i16` over [-PI, PI] (yaw) and [-PI/2, PI/2] (pitch). */
export const WIRE_AIM_UNITS = 32767;
export const WIRE_VELOCITY_STEP_MPS = WIRE_VELOCITY_MAX_MPS / 127;

/** Clock values are whole sim ticks in a `u16`; this value means "no time limit" (Infinity). */
export const WIRE_TIME_INFINITE = 0xffff;

// --- Wire tables ---------------------------------------------------------------------------------

/** Index = `u8` wire value. Append only. */
export const REJECT_REASONS = [
  'full',
  'versionMismatch',
  'kicked',
  'matchInProgress',
] as const satisfies readonly RejectReason[];

/** Compile-time check that the table lists every RejectReason. */
type MissingRejectReason = Exclude<RejectReason, (typeof REJECT_REASONS)[number]>;
const REJECT_REASONS_COMPLETE: MissingRejectReason extends never ? true : never = true;
void REJECT_REASONS_COMPLETE;

/**
 * The intents that cross the network: `LobbyIntent` of `src/sim/lobby` (every `lobby.*` and
 * `host.*` UiIntent except the local-only `lobby.focusPlayer`, plus `lobby.switchSide`).
 * Index = `u8` wire value. Append only. The host must still check `host.*` intents against the
 * sender's player id (`applyLobbyIntent` does): decoding one says nothing about who sent it.
 */
export const NET_INTENT_TYPES = [
  'lobby.ready',
  'lobby.pickClass',
  'lobby.switchSide',
  'lobby.leave',
  'host.setMode',
  'host.setMap',
  'host.setTeamSize',
  'host.setUnevenTeams',
  'host.setScoreLimit',
  'host.setTimeLimit',
  'host.setFriendlyFire',
  'host.setAllowedClasses',
  'host.movePlayer',
  'host.autoBalance',
  'host.shuffle',
  'host.lockTeams',
  'host.kick',
  'host.start',
] as const satisfies readonly LobbyIntent['type'][];

export type NetIntent = LobbyIntent;
export type NetIntentType = NetIntent['type'];

/** Compile-time check that the table lists every LobbyIntent. */
type MissingIntentType = Exclude<NetIntentType, (typeof NET_INTENT_TYPES)[number]>;
const NET_INTENT_TYPES_COMPLETE: MissingIntentType extends never ? true : never = true;
void NET_INTENT_TYPES_COMPLETE;

/** Index = `u8` wire value. Append only. */
export const MODE_IDS = [
  'skirmish',
  'duel',
  'emberRelay',
  'skyCrown',
] as const satisfies readonly ModeId[];
export const MAP_IDS = [
  'shattered-spires',
  'emberfall-caldera',
] as const satisfies readonly MapId[];

type MissingModeId = Exclude<ModeId, (typeof MODE_IDS)[number]>;
type MissingMapId = Exclude<MapId, (typeof MAP_IDS)[number]>;
const MODE_IDS_COMPLETE: MissingModeId extends never ? true : never = true;
const MAP_IDS_COMPLETE: MissingMapId extends never ? true : never = true;
void MODE_IDS_COMPLETE;
void MAP_IDS_COMPLETE;

/** Wire value of the spectator side in `host.movePlayer` (teams are 0 and 1). */
export const WIRE_SIDE_SPECTATOR = 2;
/** Wire value of "no winner yet" and of a draw in MATCH_PHASE and the matchPhase event. */
export const WIRE_WINNER_NONE = 255;
export const WIRE_WINNER_DRAW = 2;

/** Index = `u8` kind byte of an event inside GAME_EVENTS. Append only. */
export const GAME_EVENT_TYPES = [
  'hit',
  'takedown',
  'spawn',
  'abilityCast',
  'objective',
  'matchPhase',
  'assist',
  'statusApplied',
  'impact',
] as const;

// --- Message structs -----------------------------------------------------------------------------
//
// All of them are plain mutable objects made once and reused: decode overwrites every field it
// documents, encode only reads. Ticks named `tick`/`ack*Tick` are the 16-bit WIRE value; turn
// them into full ticks with `expandTick`.

export interface InputMessage {
  /** Wire tick of `frames[0]`. */
  tick: number;
  /** 1..INPUT_FRAMES_PER_PACKET live entries in `frames`. */
  frameCount: number;
  /**
   * Newest first: `frames[i]` is for wire tick `tick - i`, and its own `tick` field holds that
   * wire value. Steer is already clamped to [-1, 1] and buttons masked on decode.
   */
  frames: InputFrame[];
  /** False until the client has received its first snapshot. */
  hasAck: boolean;
  /** Wire tick of the newest snapshot the client had when it sampled this input (lag compensation). */
  ackSnapshotTick: number;
}

export function createInputMessage(): InputMessage {
  const frames: InputFrame[] = [];
  for (let i = 0; i < INPUT_FRAMES_PER_PACKET; i++) frames.push(createInputFrame());
  return { tick: 0, frameCount: 0, frames, hasAck: false, ackSnapshotTick: 0 };
}

/** One dragon as every client sees it (quantized). Team and class are lobby data. */
export interface SnapshotDragon {
  id: PlayerId;
  position: MutableVec3;
  orientation: MutableQuat;
  velocity: MutableVec3;
  /** Fraction of max HP, 0..1. Never 0 for a dragon that still has HP (rounded up). */
  health: number;
  /** 0..1. */
  stamina: number;
  /** DRAGON_FLAG_* bits. */
  flags: number;
  anim: DragonAnimState;
}

export function createSnapshotDragon(): SnapshotDragon {
  return {
    id: NO_PLAYER,
    position: createVec3(),
    orientation: createQuat(),
    velocity: createVec3(),
    health: 0,
    stamina: 0,
    flags: 0,
    anim: DRAGON_ANIM_GLIDE,
  };
}

/**
 * The PRIMARY fields of the recipient's own dragon: everything `integrateDragon` reads, so the
 * client can overwrite its predicted dragon with them and replay its unacknowledged inputs.
 * Floats travel as `f32` (see `encodeSnapshot` for why that is enough). A `DragonState` is
 * structurally assignable, so the host passes the sim's dragon straight to the encoder.
 */
export type SnapshotOwner = Pick<
  DragonState,
  | 'id'
  | 'position'
  | 'yaw'
  | 'pitch'
  | 'roll'
  | 'yawRate'
  | 'pitchRate'
  | 'speed'
  | 'burst'
  | 'stamina'
  | 'health'
  | 'maxHealth'
  | 'flags'
  | 'prevButtons'
  | 'boostLocked'
  | 'dodgeDir'
  | 'dodgeTicks'
  | 'dodgeTotalTicks'
  | 'dodgeImmunityTicks'
  | 'dodgeCooldownTicks'
  | 'flapCooldownTicks'
  | 'staminaRegenDelayTicks'
  | 'spawnProtectTicks'
  | 'hitTicks'
  | 'terrainGraceTicks'
  // Combat: what the caster's side of abilities (`stepAbilities`) and the flight model read.
  | 'ultCharge'
  | 'slowScale'
  | 'hasteScale'
  | 'abilityCooldownTicks'
  | 'abilityActiveTicks'
  | 'abilityChargesUsed'
  | 'castSlot'
  | 'castTicks'
  | 'firingTicks'
  | 'slowTicks'
  | 'hasteTicks'
  | 'burnTicks'
  | 'regenTicks'
  | 'blindTicks'
  | 'veilTicks'
  | 'phaseTicks'
  | 'shieldTicks'
  | 'deadTicks'
  | 'lastDamagerId'
>;

export function createSnapshotOwner(): SnapshotOwner {
  return {
    id: NO_PLAYER,
    position: createVec3(),
    yaw: 0,
    pitch: 0,
    roll: 0,
    yawRate: 0,
    pitchRate: 0,
    speed: 0,
    burst: createVec3(),
    stamina: 0,
    health: 0,
    maxHealth: 0,
    flags: 0,
    prevButtons: 0,
    boostLocked: false,
    dodgeDir: 0,
    dodgeTicks: 0,
    dodgeTotalTicks: 0,
    dodgeImmunityTicks: 0,
    dodgeCooldownTicks: 0,
    flapCooldownTicks: 0,
    staminaRegenDelayTicks: 0,
    spawnProtectTicks: 0,
    hitTicks: 0,
    terrainGraceTicks: 0,
    ultCharge: 0,
    slowScale: 1,
    hasteScale: 1,
    abilityCooldownTicks: [0, 0, 0, 0],
    abilityActiveTicks: [0, 0, 0, 0],
    abilityChargesUsed: [0, 0, 0, 0],
    castSlot: -1,
    castTicks: 0,
    firingTicks: 0,
    slowTicks: 0,
    hasteTicks: 0,
    burnTicks: 0,
    regenTicks: 0,
    blindTicks: 0,
    veilTicks: 0,
    phaseTicks: 0,
    shieldTicks: 0,
    deadTicks: 0,
    lastDamagerId: NO_PLAYER,
  };
}

/** A projectile as a snapshot carries it (only kinds with `replication: 'snapshot'`). */
export interface SnapshotProjectile {
  /** 0..65535. */
  id: number;
  /** Index into PROJECTILE_KINDS. */
  kind: number;
  ownerId: PlayerId;
  team: TeamId;
  position: MutableVec3;
  velocity: MutableVec3;
}

export function createSnapshotProjectile(): SnapshotProjectile {
  return {
    id: 0,
    kind: 0,
    ownerId: NO_PLAYER,
    team: TEAM_EMBER,
    position: createVec3(),
    velocity: createVec3(),
  };
}

/** An ability zone as a snapshot carries it. */
export interface SnapshotZone {
  /** 1..255. */
  id: number;
  /** Index into ZONE_KINDS. */
  kind: number;
  ownerId: PlayerId;
  team: TeamId;
  position: MutableVec3;
  /** Metres, in WIRE_ZONE_RADIUS_STEP_M steps. */
  radius: number;
  /** Seconds left, in WIRE_ZONE_TIME_STEP_S steps; Infinity when beyond the wire range. */
  remainingS: number;
}

export function createSnapshotZone(): SnapshotZone {
  return {
    id: 0,
    kind: 0,
    ownerId: NO_PLAYER,
    team: TEAM_EMBER,
    position: createVec3(),
    radius: 0,
    remainingS: 0,
  };
}

export interface SnapshotMessage {
  /** Wire tick of the sim state this snapshot describes. */
  tick: number;
  /** False until the host has received an input from the recipient. */
  hasAck: boolean;
  /**
   * Wire tick of the newest input the host has RECEIVED from the recipient
   * (`HostInputBuffer.ackTick`). It may be ahead of `tick`: `ackInputTick - tick` is the host's
   * input margin, which steers the client's prediction clock (`InputTiming`). It does not say
   * where to replay from: the owner block is the state after `tick`, so replay starts at
   * `tick + 1`.
   */
  ackInputTick: number;

  // Match clock. Times are whole ticks on the wire, so they round-trip to 1/TICK_HZ s.
  phase: MatchPhase;
  /** 1-based, 1..255. */
  round: number;
  /** Seconds since the phase started; saturates at about 36 min. */
  phaseTimeS: number;
  /** Seconds left, or Infinity with no time limit. */
  timeRemainingS: number;
  /** 0..255 each. */
  scoreEmber: number;
  scoreFrost: number;
  /**
   * Storm wall radius in metres when a mode moved it, or a negative number for "the map's own"
   * (`SimState.stormRadius`). The client steps its predicted dragon against the same wall.
   */
  stormRadius: number;

  /** False for spectators and whenever the recipient has no dragon. */
  hasOwner: boolean;
  /** Only meaningful while `hasOwner` is true. */
  owner: SnapshotOwner;

  /** Live entries in `dragons` (0..SNAPSHOT_MAX_DRAGONS). The recipient's dragon is included. */
  dragonCount: number;
  /** Pool of SNAPSHOT_MAX_DRAGONS slots; entries at index >= dragonCount are stale. */
  dragons: SnapshotDragon[];
  /** Live entries in `projectiles` (0..SNAPSHOT_MAX_PROJECTILES). */
  projectileCount: number;
  projectiles: SnapshotProjectile[];
  /** Live entries in `zones` (0..SNAPSHOT_MAX_ZONES). */
  zoneCount: number;
  zones: SnapshotZone[];
}

export function createSnapshotMessage(): SnapshotMessage {
  const dragons: SnapshotDragon[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_DRAGONS; i++) dragons.push(createSnapshotDragon());
  const projectiles: SnapshotProjectile[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_PROJECTILES; i++) projectiles.push(createSnapshotProjectile());
  const zones: SnapshotZone[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_ZONES; i++) zones.push(createSnapshotZone());
  return {
    tick: 0,
    hasAck: false,
    ackInputTick: 0,
    phase: 'lobby',
    round: 1,
    phaseTimeS: 0,
    timeRemainingS: Infinity,
    scoreEmber: 0,
    scoreFrost: 0,
    stormRadius: -1,
    hasOwner: false,
    owner: createSnapshotOwner(),
    dragonCount: 0,
    dragons,
    projectileCount: 0,
    projectiles,
    zoneCount: 0,
    zones,
  };
}

export interface HelloMessage {
  tick: number;
  /** Decoded even when it differs from ours, so the host can answer `versionMismatch`. */
  protocolVersion: number;
  /** Sanitized on decode (see `sanitizePlayerName`); may be empty, the host then picks a name. */
  name: string;
  /** 1..MAX_RECONNECT_TOKEN_BYTES printable ASCII characters, or '' when the client has none. */
  reconnectToken: string;
  /**
   * Names this browser across tabs and reloads (same alphabet and length as a token; '' for
   * none, e.g. a bot). The host only uses it to keep a kicked player out: a seat's token dies
   * with the tab, this does not.
   */
  clientId: string;
}

export function createHelloMessage(): HelloMessage {
  return { tick: 0, protocolVersion: 0, name: '', reconnectToken: '', clientId: '' };
}

export interface WelcomeMessage {
  tick: number;
  playerId: PlayerId;
  /** The seat's token for a later reconnect; '' when the seat cannot be reclaimed. */
  reconnectToken: string;
  /** The host's full (unwrapped) sim tick: the client's reference for `expandTick`. */
  hostTick: number;
  /** Null only before the first successful decode. */
  lobbyState: LobbyState | null;
}

export function createWelcomeMessage(): WelcomeMessage {
  return { tick: 0, playerId: NO_PLAYER, reconnectToken: '', hostTick: 0, lobbyState: null };
}

export interface RejectMessage {
  tick: number;
  reason: RejectReason;
}

export function createRejectMessage(): RejectMessage {
  return { tick: 0, reason: 'full' };
}

export interface LobbyStateMessage {
  tick: number;
  /** Null only before the first successful decode. */
  lobbyState: LobbyState | null;
}

export function createLobbyStateMessage(): LobbyStateMessage {
  return { tick: 0, lobbyState: null };
}

export interface IntentMessage {
  tick: number;
  /** A fresh, validated object per decode (intents are rare). Null before the first decode. */
  intent: NetIntent | null;
}

export function createIntentMessage(): IntentMessage {
  return { tick: 0, intent: null };
}

export interface PingMessage {
  tick: number;
  /** The client's clock (ms, e.g. `performance.now()`), echoed back in the pong. */
  clientTimeMs: number;
}

export function createPingMessage(): PingMessage {
  return { tick: 0, clientTimeMs: 0 };
}

export interface PongMessage {
  tick: number;
  /** Copied from the ping; RTT = now - clientTimeMs. */
  clientTimeMs: number;
  /** The host's clock (ms) when it answered. */
  hostTimeMs: number;
  /** The host's full (unwrapped) sim tick when it answered. */
  hostTick: number;
}

export function createPongMessage(): PongMessage {
  return { tick: 0, clientTimeMs: 0, hostTimeMs: 0, hostTick: 0 };
}

export interface MatchStartMessage {
  tick: number;
  /** Full host tick at which the match sim starts (dragons spawn). */
  startTick: number;
  /** Map layout seed (u32); mode and teams come from the lobby state. */
  seed: number;
  /**
   * The map the match is flown on (u8 index into MAP_IDS). Sent here, next to the seed, so a
   * client builds its collision world from this one message and can never pair the host's seed
   * with a map id from a lobby state that is a moment older or newer.
   */
  map: MapId;
}

export function createMatchStartMessage(): MatchStartMessage {
  return { tick: 0, startTick: 0, seed: 0, map: 'shattered-spires' };
}

export interface MatchPhaseMessage {
  /**
   * The header's 16-bit tick. For the phases in which the dragons are held (`intro`,
   * `countdown`) it is the low 16 bits of the host tick at which play begins, so a client knows
   * when its controls go live without knowing the lengths of the intro and the countdown (and
   * when the host skipped the intro). For every other phase it is just the tick it was sent on.
   */
  tick: number;
  /** Full host tick at which the phase began. */
  phaseStartTick: number;
  phase: MatchPhase;
  /** 1-based, 1..255. */
  round: number;
  /** Set when entering `roundEnd` or `results`, otherwise null. */
  winner: MatchWinner | null;
}

export function createMatchPhaseMessage(): MatchPhaseMessage {
  return { tick: 0, phaseStartTick: 0, phase: 'lobby', round: 1, winner: null };
}

/** KICK and HOST_LEFT carry nothing but the header. */
export interface NoticeMessage {
  tick: number;
}

export function createNoticeMessage(): NoticeMessage {
  return { tick: 0 };
}
