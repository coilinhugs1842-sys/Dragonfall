/**
 * GAME_EVENTS: a batch of GameEvents on the reliable `ctrl` channel, encoded with the wire
 * tables of `src/shared` (DAMAGE_SOURCES, OBJECTIVE_KINDS, DRAGON_CLASS_IDS, ABILITY_SLOTS,
 * MATCH_PHASES). Allocation-free in both directions.
 *
 * Layout: header, u8 count, then `count` events, each `u8 kind` (index into GAME_EVENT_TYPES),
 * `u32 tick` (the full tick: events are rare, so no wrapping) and the body:
 *   hit          u8 attackerId, u8 targetId, u8 source, f32 damage, pos        18 bytes
 *   takedown     u8 killerId, u8 victimId, u8 source, pos                      14 bytes
 *   spawn        u8 dragonId, u8 team, u8 classId, pos                         14 bytes
 *   abilityCast  u8 dragonId, u8 classId, u8 slot, pos, dir (3 x i16)          20 bytes
 *   objective    u8 kind, u8 team, u8 dragonId, pos                            14 bytes
 *   matchPhase   u8 phase, u8 round, u8 winner                                  8 bytes
 * `pos` is 3 x i16 with the snapshot's position quantization (within 3 cm per axis).
 */

import {
  ABILITY_SLOTS,
  DAMAGE_SOURCES,
  DRAGON_CLASS_IDS,
  MATCH_PHASES,
  NO_PLAYER,
  OBJECTIVE_KINDS,
  TEAM_EMBER,
  TEAM_FROST,
  createVec3,
} from '../../shared';
import type {
  AbilityCastEvent,
  GameEvent,
  GameEventSink,
  HitEvent,
  MatchPhaseEvent,
  MatchWinner,
  MutableVec3,
  ObjectiveEvent,
  SpawnEvent,
  TakedownEvent,
  Vec3,
} from '../../shared';
import {
  CTRL_MAX_BYTES,
  DECODE_BAD_VALUE,
  HEADER_BYTES,
  MAX_EVENTS_PER_BATCH,
  MSG_GAME_EVENTS,
  WIRE_WINNER_DRAW,
  WIRE_WINNER_NONE,
} from '../protocol';
import type { Reader, Writer } from './io';
import {
  dequantizePositionXZ,
  dequantizePositionY,
  quantizePositionXZ,
  quantizePositionY,
} from './quantize';

const KIND_HIT = 0;
const KIND_TAKEDOWN = 1;
const KIND_SPAWN = 2;
const KIND_ABILITY_CAST = 3;
const KIND_OBJECTIVE = 4;
const KIND_MATCH_PHASE = 5;

const COUNT_OFFSET = HEADER_BYTES;

/** Writable twin of an event type, for the decoder's scratch objects. */
type Scratch<E extends GameEvent> = {
  -readonly [K in keyof E]: E[K] extends Vec3 ? MutableVec3 : E[K];
};

// One scratch object per event type. `GameEventSink.emit` copies what it is given, so the same
// object is refilled for every event of its type.
const hit: Scratch<HitEvent> = {
  type: 'hit',
  tick: 0,
  attackerId: NO_PLAYER,
  targetId: NO_PLAYER,
  source: 'primary',
  damage: 0,
  position: createVec3(),
};
const takedown: Scratch<TakedownEvent> = {
  type: 'takedown',
  tick: 0,
  killerId: NO_PLAYER,
  victimId: NO_PLAYER,
  source: 'primary',
  position: createVec3(),
};
const spawn: Scratch<SpawnEvent> = {
  type: 'spawn',
  tick: 0,
  dragonId: NO_PLAYER,
  team: TEAM_EMBER,
  classId: 'talon',
  position: createVec3(),
};
const abilityCast: Scratch<AbilityCastEvent> = {
  type: 'abilityCast',
  tick: 0,
  dragonId: NO_PLAYER,
  classId: 'talon',
  slot: 'primary',
  position: createVec3(),
  direction: createVec3(0, 0, 1),
};
const objective: Scratch<ObjectiveEvent> = {
  type: 'objective',
  tick: 0,
  kind: 'pickedUp',
  team: TEAM_EMBER,
  dragonId: NO_PLAYER,
  position: createVec3(),
};
const matchPhase: Scratch<MatchPhaseEvent> = {
  type: 'matchPhase',
  tick: 0,
  phase: 'lobby',
  round: 1,
  winner: null,
};

// --- Shared with MATCH_PHASE ---------------------------------------------------------------------

export function winnerToWire(winner: MatchWinner | null): number {
  if (winner === null) return WIRE_WINNER_NONE;
  return winner === 'draw' ? WIRE_WINNER_DRAW : winner;
}

/** Returns undefined for a byte that is not a legal winner value. */
export function winnerFromWire(value: number): MatchWinner | null | undefined {
  if (value === WIRE_WINNER_NONE) return null;
  if (value === WIRE_WINNER_DRAW) return 'draw';
  if (value === TEAM_EMBER) return TEAM_EMBER;
  if (value === TEAM_FROST) return TEAM_FROST;
  return undefined;
}

// --- Encode --------------------------------------------------------------------------------------

function writePosition(w: Writer, position: Vec3): void {
  w.i16(quantizePositionXZ(position.x));
  w.i16(quantizePositionY(position.y));
  w.i16(quantizePositionXZ(position.z));
}

function writeUnitAxis(w: Writer, value: number): void {
  // `!(>= -1)` also catches NaN.
  const clamped = !(value >= -1) ? (value < -1 ? -1 : 0) : value > 1 ? 1 : value;
  w.i16(Math.round(clamped * 32767));
}

function indexOrZero(index: number): number {
  return index < 0 ? 0 : index;
}

/** Starts a batch: rewinds the writer and writes the header with an event count of 0. */
export function beginGameEvents(w: Writer, tick: number): void {
  w.reset();
  w.header(MSG_GAME_EVENTS, tick);
  w.u8(0);
}

/**
 * Appends one event to the batch started with `beginGameEvents`. Returns false, leaving the
 * batch as it was, when the batch already holds MAX_EVENTS_PER_BATCH events or the buffer is
 * full: send what `endGameEvents` returns and begin a new batch.
 */
export function writeGameEvent(w: Writer, event: GameEvent): boolean {
  if (w.overflow || w.offset <= COUNT_OFFSET) return false;
  const count = w.view.getUint8(COUNT_OFFSET);
  if (count >= MAX_EVENTS_PER_BATCH) return false;
  const start = w.offset;

  switch (event.type) {
    case 'hit':
      w.u8(KIND_HIT);
      w.u32(event.tick >>> 0);
      w.u8(event.attackerId);
      w.u8(event.targetId);
      w.u8(indexOrZero(DAMAGE_SOURCES.indexOf(event.source)));
      w.f32(event.damage > 0 && event.damage < Infinity ? event.damage : 0);
      writePosition(w, event.position);
      break;
    case 'takedown':
      w.u8(KIND_TAKEDOWN);
      w.u32(event.tick >>> 0);
      w.u8(event.killerId);
      w.u8(event.victimId);
      w.u8(indexOrZero(DAMAGE_SOURCES.indexOf(event.source)));
      writePosition(w, event.position);
      break;
    case 'spawn':
      w.u8(KIND_SPAWN);
      w.u32(event.tick >>> 0);
      w.u8(event.dragonId);
      w.u8(event.team);
      w.u8(indexOrZero(DRAGON_CLASS_IDS.indexOf(event.classId)));
      writePosition(w, event.position);
      break;
    case 'abilityCast':
      w.u8(KIND_ABILITY_CAST);
      w.u32(event.tick >>> 0);
      w.u8(event.dragonId);
      w.u8(indexOrZero(DRAGON_CLASS_IDS.indexOf(event.classId)));
      w.u8(indexOrZero(ABILITY_SLOTS.indexOf(event.slot)));
      writePosition(w, event.position);
      writeUnitAxis(w, event.direction.x);
      writeUnitAxis(w, event.direction.y);
      writeUnitAxis(w, event.direction.z);
      break;
    case 'objective':
      w.u8(KIND_OBJECTIVE);
      w.u32(event.tick >>> 0);
      w.u8(indexOrZero(OBJECTIVE_KINDS.indexOf(event.kind)));
      w.u8(event.team);
      w.u8(event.dragonId);
      writePosition(w, event.position);
      break;
    case 'matchPhase':
      w.u8(KIND_MATCH_PHASE);
      w.u32(event.tick >>> 0);
      w.u8(indexOrZero(MATCH_PHASES.indexOf(event.phase)));
      w.u8(event.round < 0 ? 0 : event.round > 255 ? 255 : event.round);
      w.u8(winnerToWire(event.winner));
      break;
  }

  if (w.overflow) {
    // Roll the partial event back so the batch stays sendable.
    w.offset = start;
    w.overflow = false;
    return false;
  }
  w.patchU8(COUNT_OFFSET, count + 1);
  return true;
}

/** Finishes the batch and returns its byte length, or 0 when it holds no events (nothing to send). */
export function endGameEvents(w: Writer): number {
  if (w.overflow || w.offset <= COUNT_OFFSET) return 0;
  return w.view.getUint8(COUNT_OFFSET) === 0 ? 0 : w.offset;
}

/** Number of events written since `beginGameEvents`. */
export function gameEventCount(w: Writer): number {
  return w.offset <= COUNT_OFFSET ? 0 : w.view.getUint8(COUNT_OFFSET);
}

// --- Decode --------------------------------------------------------------------------------------

function readPosition(r: Reader, out: MutableVec3): void {
  out.x = dequantizePositionXZ(r.i16());
  out.y = dequantizePositionY(r.i16());
  out.z = dequantizePositionXZ(r.i16());
}

/** Reads and validates one event into its scratch object; returns it, or null if it is illegal. */
function readEvent(r: Reader): GameEvent | null {
  const kind = r.u8();
  const tick = r.u32();
  switch (kind) {
    case KIND_HIT: {
      hit.tick = tick;
      hit.attackerId = r.u8();
      hit.targetId = r.u8();
      const source = DAMAGE_SOURCES[r.u8()];
      const damage = r.f32();
      readPosition(r, hit.position);
      // `!(>= 0)` also rejects NaN.
      if (source === undefined || hit.targetId === NO_PLAYER || !(damage >= 0)) return null;
      if (damage === Infinity) return null;
      hit.source = source;
      hit.damage = damage;
      return hit;
    }
    case KIND_TAKEDOWN: {
      takedown.tick = tick;
      takedown.killerId = r.u8();
      takedown.victimId = r.u8();
      const source = DAMAGE_SOURCES[r.u8()];
      readPosition(r, takedown.position);
      if (source === undefined || takedown.victimId === NO_PLAYER) return null;
      takedown.source = source;
      return takedown;
    }
    case KIND_SPAWN: {
      spawn.tick = tick;
      spawn.dragonId = r.u8();
      const team = r.u8();
      const classId = DRAGON_CLASS_IDS[r.u8()];
      readPosition(r, spawn.position);
      if (classId === undefined || spawn.dragonId === NO_PLAYER) return null;
      if (team !== TEAM_EMBER && team !== TEAM_FROST) return null;
      spawn.team = team;
      spawn.classId = classId;
      return spawn;
    }
    case KIND_ABILITY_CAST: {
      abilityCast.tick = tick;
      abilityCast.dragonId = r.u8();
      const classId = DRAGON_CLASS_IDS[r.u8()];
      const slot = ABILITY_SLOTS[r.u8()];
      readPosition(r, abilityCast.position);
      const dx = r.i16();
      const dy = r.i16();
      const dz = r.i16();
      if (classId === undefined || slot === undefined) return null;
      if (abilityCast.dragonId === NO_PLAYER) return null;
      abilityCast.classId = classId;
      abilityCast.slot = slot;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length > 0) {
        abilityCast.direction.x = dx / length;
        abilityCast.direction.y = dy / length;
        abilityCast.direction.z = dz / length;
      } else {
        abilityCast.direction.x = 0;
        abilityCast.direction.y = 0;
        abilityCast.direction.z = 1;
      }
      return abilityCast;
    }
    case KIND_OBJECTIVE: {
      objective.tick = tick;
      const objectiveKind = OBJECTIVE_KINDS[r.u8()];
      const team = r.u8();
      objective.dragonId = r.u8();
      readPosition(r, objective.position);
      if (objectiveKind === undefined) return null;
      if (team !== TEAM_EMBER && team !== TEAM_FROST) return null;
      objective.kind = objectiveKind;
      objective.team = team;
      return objective;
    }
    case KIND_MATCH_PHASE: {
      matchPhase.tick = tick;
      const phase = MATCH_PHASES[r.u8()];
      matchPhase.round = r.u8();
      const winner = winnerFromWire(r.u8());
      if (phase === undefined || winner === undefined) return null;
      matchPhase.phase = phase;
      matchPhase.winner = winner;
      return matchPhase;
    }
    default:
      return null;
  }
}

/**
 * Reads a GAME_EVENTS batch and emits every event to `sink` (normally the client's
 * GameEventBus) in order. The batch is all-or-nothing: it is validated in full first, so a
 * malformed batch emits nothing and returns false. The emitted objects are reused scratch
 * storage, exactly as `GameEventSink.emit` allows. Returns true for a valid batch.
 */
export function decodeGameEvents(r: Reader, sink: GameEventSink): boolean {
  r.header(MSG_GAME_EVENTS, CTRL_MAX_BYTES);
  const count = r.u8();
  if (!r.ok) return false;
  const bodyStart = r.offset;

  for (let i = 0; i < count; i++) {
    const event = readEvent(r);
    if (!r.ok) return false;
    if (event === null) return r.fail(DECODE_BAD_VALUE);
  }
  if (!r.finish()) return false;

  r.offset = bodyStart;
  for (let i = 0; i < count; i++) {
    const event = readEvent(r);
    if (event !== null) sink.emit(event);
  }
  return true;
}
