/**
 * The slice of the host's authoritative sim state that the host's own page draws from, and its
 * wire form for the worker -> main hop (one REC_STATE record per tick, see `batch.ts`).
 *
 * `HostViewState` is a structural subset of `SimState` (and `HostViewDragon` of `DragonState`):
 * on the direct path the game layer is handed the sim's own `prev` / `current`, on the worker
 * path a mirror decoded from the record. The views cannot tell the two apart.
 *
 * BOTH states travel every tick, not only `current`: `Sim.spawnDragon` rewrites the slot in
 * `prev` as well (so a respawn is not interpolated in from the place of death), and a mirror
 * that kept its own "previous current" would lose that. Floats are f64, so the mirror is
 * bit-identical to the sim (the equivalence test relies on it). 10 dragons cost 2.3 KB a tick,
 * which is transferred, not copied.
 *
 *   state record := info (56 bytes), simState(prev), simState(current)
 *   simState     := i32 tick, f64 timeS, u8 dragonCount, dragon*
 *   dragon       := u8 slot, u8 id, u8 team, u8 class, u8 anim, u16 flags, 13 x f64
 */

import { DRAGON_CLASS_IDS, MATCH_PHASES, MAX_PLAYERS, NO_PLAYER, TEAM_EMBER } from '../../shared';
import type {
  DragonAnimState,
  DragonClassId,
  MatchPhase,
  MutableQuat,
  MutableVec3,
  PlayerId,
  TeamId,
} from '../../shared';

/** What the views read of one dragon. `DragonState` fits. */
export interface HostViewDragon {
  active: boolean;
  id: PlayerId;
  team: TeamId;
  classId: DragonClassId;
  position: MutableVec3;
  velocity: MutableVec3;
  orientation: MutableQuat;
  health: number;
  maxHealth: number;
  stamina: number;
  flags: number;
  anim: DragonAnimState;
}

/** What the views read of one tick. `SimState` fits. Slots are NOT packed (see `SimState`). */
export interface HostViewState {
  tick: number;
  timeS: number;
  dragons: HostViewDragon[];
}

/** The per-tick facts that travel with the state. */
export interface HostTickInfo {
  /** The host tick this state is the result of. */
  hostTick: number;
  /** When that tick was due, in epoch milliseconds (comparable across threads). */
  tickAtMs: number;
  phase: MatchPhase;
  phaseTimeS: number;
  /** The host's own player has a dragon. */
  localIsRider: boolean;
  /** The steer applied for the host's dragon this tick (camera look-ahead). */
  aimX: number;
  aimY: number;
  /** Age of the newest local input sample when the tick ran, ms; -1 when none was fresh. */
  inputAgeMs: number;
  /** Cost of the tick inside the session, microseconds (0 when not measured). */
  stepUs: number;
  simUs: number;
  snapshotUs: number;
  /** Cost of the previous whole worker pulse (ticks, bots, encoding, posting), microseconds. */
  pulseUs: number;
}

export const STATE_INFO_BYTES = 56;
const SIM_STATE_FIXED_BYTES = 13;
const DRAGON_BYTES = 7 + 13 * 8;
/** Largest state record: both states with every slot live. */
export const STATE_RECORD_MAX_BYTES =
  STATE_INFO_BYTES + 2 * (SIM_STATE_FIXED_BYTES + MAX_PLAYERS * DRAGON_BYTES);

const INFO_FLAG_RIDER = 1;

export function createHostViewDragon(): HostViewDragon {
  return {
    active: false,
    id: NO_PLAYER,
    team: TEAM_EMBER,
    classId: DRAGON_CLASS_IDS[0] ?? 'talon',
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    health: 0,
    maxHealth: 0,
    stamina: 0,
    flags: 0,
    anim: 0,
  };
}

export function createHostViewState(): HostViewState {
  const dragons: HostViewDragon[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) dragons.push(createHostViewDragon());
  return { tick: -1, timeS: 0, dragons };
}

export function createHostTickInfo(): HostTickInfo {
  return {
    hostTick: 0,
    tickAtMs: 0,
    phase: 'lobby',
    phaseTimeS: 0,
    localIsRider: false,
    aimX: 0,
    aimY: 0,
    inputAgeMs: -1,
    stepUs: 0,
    simUs: 0,
    snapshotUs: 0,
    pulseUs: 0,
  };
}

/** The player's dragon in a view state, or undefined. */
export function findViewDragon(
  state: Readonly<HostViewState>,
  id: PlayerId,
): HostViewDragon | undefined {
  const dragons = state.dragons;
  for (let i = 0; i < dragons.length; i++) {
    const dragon = dragons[i];
    if (dragon !== undefined && dragon.active && dragon.id === id) return dragon;
  }
  return undefined;
}

/** Bytes `encodeHostState` will write for these two states. */
export function hostStateBytes(
  prev: Readonly<HostViewState>,
  current: Readonly<HostViewState>,
): number {
  return (
    STATE_INFO_BYTES +
    2 * SIM_STATE_FIXED_BYTES +
    (countActive(prev) + countActive(current)) * DRAGON_BYTES
  );
}

function countActive(state: Readonly<HostViewState>): number {
  let count = 0;
  const dragons = state.dragons;
  for (let i = 0; i < dragons.length && i < MAX_PLAYERS; i++) {
    if (dragons[i]?.active === true) count++;
  }
  return count;
}

function writeSimState(view: DataView, at: number, state: Readonly<HostViewState>): number {
  let o = at;
  view.setInt32(o, state.tick, true);
  view.setFloat64(o + 4, state.timeS, true);
  const countAt = o + 12;
  o += SIM_STATE_FIXED_BYTES;
  let count = 0;
  const dragons = state.dragons;
  for (let i = 0; i < dragons.length && i < MAX_PLAYERS; i++) {
    const dragon = dragons[i];
    if (dragon === undefined || !dragon.active) continue;
    count++;
    view.setUint8(o, i);
    view.setUint8(o + 1, dragon.id);
    view.setUint8(o + 2, dragon.team);
    const classIndex = DRAGON_CLASS_IDS.indexOf(dragon.classId);
    view.setUint8(o + 3, classIndex < 0 ? 0 : classIndex);
    view.setUint8(o + 4, dragon.anim);
    view.setUint16(o + 5, dragon.flags, true);
    o += 7;
    view.setFloat64(o, dragon.position.x, true);
    view.setFloat64(o + 8, dragon.position.y, true);
    view.setFloat64(o + 16, dragon.position.z, true);
    view.setFloat64(o + 24, dragon.velocity.x, true);
    view.setFloat64(o + 32, dragon.velocity.y, true);
    view.setFloat64(o + 40, dragon.velocity.z, true);
    view.setFloat64(o + 48, dragon.orientation.x, true);
    view.setFloat64(o + 56, dragon.orientation.y, true);
    view.setFloat64(o + 64, dragon.orientation.z, true);
    view.setFloat64(o + 72, dragon.orientation.w, true);
    view.setFloat64(o + 80, dragon.health, true);
    view.setFloat64(o + 88, dragon.maxHealth, true);
    view.setFloat64(o + 96, dragon.stamina, true);
    o += 104;
  }
  view.setUint8(countAt, count);
  return o;
}

/** Returns the offset after the state, or -1 when the record is cut short or malformed. */
function readSimState(view: DataView, at: number, end: number, out: HostViewState): number {
  let o = at;
  if (o + SIM_STATE_FIXED_BYTES > end) return -1;
  out.tick = view.getInt32(o, true);
  out.timeS = view.getFloat64(o + 4, true);
  const count = view.getUint8(o + 12);
  o += SIM_STATE_FIXED_BYTES;
  if (count > MAX_PLAYERS || o + count * DRAGON_BYTES > end) return -1;
  const dragons = out.dragons;
  for (let i = 0; i < dragons.length; i++) {
    const dragon = dragons[i];
    if (dragon !== undefined) dragon.active = false;
  }
  for (let n = 0; n < count; n++) {
    const dragon = dragons[view.getUint8(o)];
    if (dragon === undefined) return -1;
    dragon.active = true;
    dragon.id = view.getUint8(o + 1);
    dragon.team = view.getUint8(o + 2) === 0 ? 0 : 1;
    dragon.classId = DRAGON_CLASS_IDS[view.getUint8(o + 3)] ?? 'talon';
    dragon.anim = view.getUint8(o + 4);
    dragon.flags = view.getUint16(o + 5, true);
    o += 7;
    dragon.position.x = view.getFloat64(o, true);
    dragon.position.y = view.getFloat64(o + 8, true);
    dragon.position.z = view.getFloat64(o + 16, true);
    dragon.velocity.x = view.getFloat64(o + 24, true);
    dragon.velocity.y = view.getFloat64(o + 32, true);
    dragon.velocity.z = view.getFloat64(o + 40, true);
    dragon.orientation.x = view.getFloat64(o + 48, true);
    dragon.orientation.y = view.getFloat64(o + 56, true);
    dragon.orientation.z = view.getFloat64(o + 64, true);
    dragon.orientation.w = view.getFloat64(o + 72, true);
    dragon.health = view.getFloat64(o + 80, true);
    dragon.maxHealth = view.getFloat64(o + 88, true);
    dragon.stamina = view.getFloat64(o + 96, true);
    o += 104;
  }
  return o;
}

/**
 * Writes one state record payload at `at` (reserve `hostStateBytes(prev, current)` bytes).
 * Returns the bytes written. Allocation-free.
 */
export function encodeHostState(
  view: DataView,
  at: number,
  info: Readonly<HostTickInfo>,
  prev: Readonly<HostViewState>,
  current: Readonly<HostViewState>,
): number {
  view.setUint32(at, info.hostTick >>> 0, true);
  view.setFloat64(at + 4, info.tickAtMs, true);
  view.setFloat64(at + 12, info.phaseTimeS, true);
  const phase = MATCH_PHASES.indexOf(info.phase);
  view.setUint8(at + 20, phase < 0 ? 0 : phase);
  view.setUint8(at + 21, info.localIsRider ? INFO_FLAG_RIDER : 0);
  view.setUint16(at + 22, 0, true);
  view.setFloat32(at + 24, info.aimX, true);
  view.setFloat32(at + 28, info.aimY, true);
  view.setFloat32(at + 32, info.inputAgeMs, true);
  view.setFloat32(at + 36, info.stepUs, true);
  view.setFloat32(at + 40, info.simUs, true);
  view.setFloat32(at + 44, info.snapshotUs, true);
  view.setFloat32(at + 48, info.pulseUs, true);
  view.setFloat32(at + 52, 0, true);
  let o = writeSimState(view, at + STATE_INFO_BYTES, prev);
  o = writeSimState(view, o, current);
  return o - at;
}

/** Reads a state record payload. False (with the outputs in an undefined state) when malformed. */
export function decodeHostState(
  view: DataView,
  at: number,
  length: number,
  info: HostTickInfo,
  prev: HostViewState,
  current: HostViewState,
): boolean {
  const end = at + length;
  if (length < STATE_INFO_BYTES + 2 * SIM_STATE_FIXED_BYTES || end > view.byteLength) return false;
  info.hostTick = view.getUint32(at, true);
  info.tickAtMs = view.getFloat64(at + 4, true);
  info.phaseTimeS = view.getFloat64(at + 12, true);
  info.phase = MATCH_PHASES[view.getUint8(at + 20)] ?? 'lobby';
  info.localIsRider = (view.getUint8(at + 21) & INFO_FLAG_RIDER) !== 0;
  info.aimX = view.getFloat32(at + 24, true);
  info.aimY = view.getFloat32(at + 28, true);
  info.inputAgeMs = view.getFloat32(at + 32, true);
  info.stepUs = view.getFloat32(at + 36, true);
  info.simUs = view.getFloat32(at + 40, true);
  info.snapshotUs = view.getFloat32(at + 44, true);
  info.pulseUs = view.getFloat32(at + 48, true);
  const o = readSimState(view, at + STATE_INFO_BYTES, end, prev);
  if (o < 0) return false;
  return readSimState(view, o, end, current) === end;
}
