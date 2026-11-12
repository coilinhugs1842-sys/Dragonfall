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
 *   state record := info (64 bytes), simState(prev), simState(current), relay(current)
 *   simState     := i32 tick, f64 timeS, u8 dragonCount, f32 stormRadius, u8 projectileCount,
 *                   u8 zoneCount, dragon*, projectile*, zone*
 *   dragon       := u8 slot, u8 id, u8 team, u8 class, u8 anim, u16 flags, 13 x f64, combat
 *   combat       := 4 x u16 cooldowns, 4 x u16 active, 4 x u8 charges used, i8 castSlot,
 *                   u16 castTicks, f32 ultCharge, u16 dodgeCooldown, u16 dead, u8 lastDamager,
 *                   u16 blind                                                    (34 bytes)
 *   projectile   := u16 id, u8 kind, u8 owner, u8 team, 6 x f32                  (29 bytes)
 *   zone         := u8 id, u8 kind, u8 owner, u8 team, 4 x f32, u16 ticksLeft    (22 bytes)
 *   relay        := u8 active, u32 revision, and only when active: 4 x (3 x f64) sites, then
 *                   per shard u8 status, u8 carrier, 3 x f64 position, i32 returnTick
 *                                                                               (5 or 161 bytes)
 *
 * Projectiles and zones are `f32`: only the views read them. `appendHostEffects` turns them,
 * and the local dragon's combat fields, into the WorldView's projectiles, zones and `local`.
 */

import {
  DRAGON_CLASS_IDS,
  FLIGHT_TUNING,
  MATCH_PHASES,
  MATCH_TUNING,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  MAX_ZONES,
  NO_PLAYER,
  PROJECTILE_KINDS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  ZONE_KINDS,
  acquireProjectileView,
  acquireZoneView,
  writeLocalCombatView,
} from '../../shared';
import type {
  DragonAnimState,
  DragonClassId,
  MatchPhase,
  MatchWinner,
  MutableQuat,
  MutableVec3,
  MutableWorldView,
  PlayerId,
  TeamId,
} from '../../shared';
import { createRelayState } from '../../sim';
import type { RelayState } from '../../sim';

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
  // Combat, for the local rider's HUD (`LocalCombatSource` of src/shared).
  abilityCooldownTicks: number[];
  abilityChargesUsed: number[];
  abilityActiveTicks: number[];
  castSlot: number;
  castTicks: number;
  ultCharge: number;
  dodgeCooldownTicks: number;
  deadTicks: number;
  lastDamagerId: PlayerId;
  blindTicks: number;
}

/** What the views read of one projectile. `ProjectileState` fits. */
export interface HostViewProjectile {
  active: boolean;
  id: number;
  /** Index into PROJECTILE_KINDS. */
  kind: number;
  ownerId: PlayerId;
  team: TeamId;
  position: MutableVec3;
  velocity: MutableVec3;
}

/** What the views read of one ability zone. `ZoneState` fits. */
export interface HostViewZone {
  active: boolean;
  id: number;
  /** Index into ZONE_KINDS. */
  kind: number;
  ownerId: PlayerId;
  team: TeamId;
  position: MutableVec3;
  radius: number;
  ticksLeft: number;
}

/** What the views read of one tick. `SimState` fits. Slots are NOT packed (see `SimState`). */
export interface HostViewState {
  tick: number;
  timeS: number;
  dragons: HostViewDragon[];
  /** Pools of MAX_PROJECTILES / MAX_ZONES slots, like the sim's. */
  projectiles: HostViewProjectile[];
  zones: HostViewZone[];
  /** Storm wall radius a mode set, or negative for the map's own. */
  stormRadius: number;
  /** Ember Relay's shards and sites (`relay.active` false in every other mode). */
  relay: RelayState;
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
  // The match clock, as the snapshots carry it to clients.
  /** 1-based round. */
  round: number;
  /** Who won the round (`roundEnd`) or the match (`results`); null otherwise. */
  winner: MatchWinner | null;
  /** Seconds left in the round or match; Infinity with no limit. */
  timeRemainingS: number;
  /** Takedowns in Skirmish, rounds won in Duel. */
  scoreEmber: number;
  scoreFrost: number;
}

export const STATE_INFO_BYTES = 64;
const SIM_STATE_FIXED_BYTES = 19;
const DRAGON_COMBAT_BYTES = 34;
const DRAGON_BYTES = 7 + 13 * 8 + DRAGON_COMBAT_BYTES;
const PROJECTILE_BYTES = 29;
const ZONE_BYTES = 22;
const RELAY_IDLE_BYTES = 1 + 4;
const RELAY_SHARD_BYTES = 2 + 24 + 4;
const RELAY_ACTIVE_BYTES = RELAY_IDLE_BYTES + 4 * 24 + 2 * RELAY_SHARD_BYTES;
/** Largest state record: both states with every slot live, in an Ember Relay match. */
export const STATE_RECORD_MAX_BYTES =
  STATE_INFO_BYTES +
  2 *
    (SIM_STATE_FIXED_BYTES +
      MAX_PLAYERS * DRAGON_BYTES +
      MAX_PROJECTILES * PROJECTILE_BYTES +
      MAX_ZONES * ZONE_BYTES) +
  RELAY_ACTIVE_BYTES;

const INFO_FLAG_RIDER = 1;
const WINNER_NONE = 0;
const WINNER_EMBER = 1;
const WINNER_FROST = 2;
const WINNER_DRAW = 3;

function winnerToByte(winner: MatchWinner | null): number {
  if (winner === null) return WINNER_NONE;
  if (winner === 'draw') return WINNER_DRAW;
  return winner === TEAM_EMBER ? WINNER_EMBER : WINNER_FROST;
}

function winnerFromByte(value: number): MatchWinner | null {
  if (value === WINNER_EMBER) return TEAM_EMBER;
  if (value === WINNER_FROST) return TEAM_FROST;
  return value === WINNER_DRAW ? 'draw' : null;
}

function clampU16(value: number): number {
  return value > 0 ? (value < 0xffff ? Math.floor(value) : 0xffff) : 0;
}

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
    abilityCooldownTicks: [0, 0, 0, 0],
    abilityChargesUsed: [0, 0, 0, 0],
    abilityActiveTicks: [0, 0, 0, 0],
    castSlot: -1,
    castTicks: 0,
    ultCharge: 0,
    dodgeCooldownTicks: 0,
    deadTicks: 0,
    lastDamagerId: NO_PLAYER,
    blindTicks: 0,
  };
}

export function createHostViewState(): HostViewState {
  const dragons: HostViewDragon[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) dragons.push(createHostViewDragon());
  const projectiles: HostViewProjectile[] = [];
  for (let i = 0; i < MAX_PROJECTILES; i++) {
    projectiles.push({
      active: false,
      id: 0,
      kind: 0,
      ownerId: NO_PLAYER,
      team: TEAM_EMBER,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
  }
  const zones: HostViewZone[] = [];
  for (let i = 0; i < MAX_ZONES; i++) {
    zones.push({
      active: false,
      id: 0,
      kind: 0,
      ownerId: NO_PLAYER,
      team: TEAM_EMBER,
      position: { x: 0, y: 0, z: 0 },
      radius: 0,
      ticksLeft: 0,
    });
  }
  return {
    tick: -1,
    timeS: 0,
    dragons,
    projectiles,
    zones,
    stormRadius: -1,
    relay: createRelayState(),
  };
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
    round: 1,
    winner: null,
    timeRemainingS: Infinity,
    scoreEmber: 0,
    scoreFrost: 0,
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
    (countActive(prev) + countActive(current)) * DRAGON_BYTES +
    (countLive(prev.projectiles, MAX_PROJECTILES) +
      countLive(current.projectiles, MAX_PROJECTILES)) *
      PROJECTILE_BYTES +
    (countLive(prev.zones, MAX_ZONES) + countLive(current.zones, MAX_ZONES)) * ZONE_BYTES +
    (current.relay.active ? RELAY_ACTIVE_BYTES : RELAY_IDLE_BYTES)
  );
}

function writeVec3(view: DataView, at: number, v: Readonly<MutableVec3> | undefined): void {
  view.setFloat64(at, v === undefined ? 0 : v.x, true);
  view.setFloat64(at + 8, v === undefined ? 0 : v.y, true);
  view.setFloat64(at + 16, v === undefined ? 0 : v.z, true);
}

function readVec3(view: DataView, at: number, out: MutableVec3 | undefined): void {
  if (out === undefined) return;
  out.x = view.getFloat64(at, true);
  out.y = view.getFloat64(at + 8, true);
  out.z = view.getFloat64(at + 16, true);
}

function writeRelay(view: DataView, at: number, relay: Readonly<RelayState>): number {
  view.setUint8(at, relay.active ? 1 : 0);
  view.setUint32(at + 1, relay.revision >>> 0, true);
  if (!relay.active) return at + RELAY_IDLE_BYTES;
  let o = at + RELAY_IDLE_BYTES;
  writeVec3(view, o, relay.stands[0]);
  writeVec3(view, o + 24, relay.stands[1]);
  writeVec3(view, o + 48, relay.braziers[0]);
  writeVec3(view, o + 72, relay.braziers[1]);
  o += 96;
  for (let team = 0; team < 2; team++) {
    const shard = relay.shards[team];
    view.setUint8(o, shard === undefined ? 0 : shard.status);
    view.setUint8(o + 1, shard === undefined ? NO_PLAYER : shard.carrierId);
    writeVec3(view, o + 2, shard?.position);
    view.setInt32(o + 26, shard === undefined ? -1 : shard.returnTick, true);
    o += RELAY_SHARD_BYTES;
  }
  return o;
}

/** Returns the offset after the block, or -1 when the record is cut short or malformed. */
function readRelay(view: DataView, at: number, end: number, out: RelayState): number {
  if (at + RELAY_IDLE_BYTES > end) return -1;
  const active = view.getUint8(at) !== 0;
  out.active = active;
  out.revision = view.getUint32(at + 1, true);
  // Off (any other mode): the rest of the mirror is not read by anybody.
  if (!active) return at + RELAY_IDLE_BYTES;
  if (at + RELAY_ACTIVE_BYTES > end) return -1;
  let o = at + RELAY_IDLE_BYTES;
  readVec3(view, o, out.stands[0]);
  readVec3(view, o + 24, out.stands[1]);
  readVec3(view, o + 48, out.braziers[0]);
  readVec3(view, o + 72, out.braziers[1]);
  o += 96;
  for (let team = 0; team < 2; team++) {
    const shard = out.shards[team];
    if (shard !== undefined) {
      shard.status = view.getUint8(o);
      shard.carrierId = view.getUint8(o + 1);
      readVec3(view, o + 2, shard.position);
      shard.returnTick = view.getInt32(o + 26, true);
    }
    o += RELAY_SHARD_BYTES;
  }
  return o;
}

function countLive(pool: readonly { active: boolean }[], limit: number): number {
  let count = 0;
  for (let i = 0; i < pool.length && i < limit; i++) {
    if (pool[i]?.active === true) count++;
  }
  return count;
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
  view.setFloat32(o + 13, state.stormRadius, true);
  const effectCountsAt = o + 17;
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
    for (let k = 0; k < 4; k++) {
      view.setUint16(o + k * 2, Math.min(0xffff, dragon.abilityCooldownTicks[k] ?? 0), true);
      view.setUint16(o + 8 + k * 2, Math.min(0xffff, dragon.abilityActiveTicks[k] ?? 0), true);
      view.setUint8(o + 16 + k, Math.min(255, dragon.abilityChargesUsed[k] ?? 0));
    }
    view.setInt8(o + 20, dragon.castSlot);
    view.setUint16(o + 21, Math.min(0xffff, dragon.castTicks), true);
    view.setFloat32(o + 23, dragon.ultCharge, true);
    view.setUint16(o + 27, Math.min(0xffff, dragon.dodgeCooldownTicks), true);
    view.setUint16(o + 29, Math.min(0xffff, dragon.deadTicks), true);
    view.setUint8(o + 31, dragon.lastDamagerId);
    view.setUint16(o + 32, Math.min(0xffff, dragon.blindTicks), true);
    o += DRAGON_COMBAT_BYTES;
  }
  view.setUint8(countAt, count);

  count = 0;
  const projectiles = state.projectiles;
  for (let i = 0; i < projectiles.length && i < MAX_PROJECTILES; i++) {
    const projectile = projectiles[i];
    if (projectile === undefined || !projectile.active) continue;
    count++;
    view.setUint16(o, projectile.id, true);
    view.setUint8(o + 2, projectile.kind);
    view.setUint8(o + 3, projectile.ownerId);
    view.setUint8(o + 4, projectile.team);
    view.setFloat32(o + 5, projectile.position.x, true);
    view.setFloat32(o + 9, projectile.position.y, true);
    view.setFloat32(o + 13, projectile.position.z, true);
    view.setFloat32(o + 17, projectile.velocity.x, true);
    view.setFloat32(o + 21, projectile.velocity.y, true);
    view.setFloat32(o + 25, projectile.velocity.z, true);
    o += PROJECTILE_BYTES;
  }
  view.setUint8(effectCountsAt, count);

  count = 0;
  const zones = state.zones;
  for (let i = 0; i < zones.length && i < MAX_ZONES; i++) {
    const zone = zones[i];
    if (zone === undefined || !zone.active) continue;
    count++;
    view.setUint8(o, zone.id);
    view.setUint8(o + 1, zone.kind);
    view.setUint8(o + 2, zone.ownerId);
    view.setUint8(o + 3, zone.team);
    view.setFloat32(o + 4, zone.position.x, true);
    view.setFloat32(o + 8, zone.position.y, true);
    view.setFloat32(o + 12, zone.position.z, true);
    view.setFloat32(o + 16, zone.radius, true);
    view.setUint16(o + 20, Math.min(0xffff, zone.ticksLeft), true);
    o += ZONE_BYTES;
  }
  view.setUint8(effectCountsAt + 1, count);
  return o;
}

/** Returns the offset after the state, or -1 when the record is cut short or malformed. */
function readSimState(view: DataView, at: number, end: number, out: HostViewState): number {
  let o = at;
  if (o + SIM_STATE_FIXED_BYTES > end) return -1;
  out.tick = view.getInt32(o, true);
  out.timeS = view.getFloat64(o + 4, true);
  const count = view.getUint8(o + 12);
  out.stormRadius = view.getFloat32(o + 13, true);
  const projectileCount = view.getUint8(o + 17);
  const zoneCount = view.getUint8(o + 18);
  o += SIM_STATE_FIXED_BYTES;
  if (count > MAX_PLAYERS || projectileCount > MAX_PROJECTILES || zoneCount > MAX_ZONES) return -1;
  if (
    o + count * DRAGON_BYTES + projectileCount * PROJECTILE_BYTES + zoneCount * ZONE_BYTES >
    end
  ) {
    return -1;
  }
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
    for (let k = 0; k < 4; k++) {
      dragon.abilityCooldownTicks[k] = view.getUint16(o + k * 2, true);
      dragon.abilityActiveTicks[k] = view.getUint16(o + 8 + k * 2, true);
      dragon.abilityChargesUsed[k] = view.getUint8(o + 16 + k);
    }
    dragon.castSlot = view.getInt8(o + 20);
    dragon.castTicks = view.getUint16(o + 21, true);
    dragon.ultCharge = view.getFloat32(o + 23, true);
    dragon.dodgeCooldownTicks = view.getUint16(o + 27, true);
    dragon.deadTicks = view.getUint16(o + 29, true);
    dragon.lastDamagerId = view.getUint8(o + 31);
    dragon.blindTicks = view.getUint16(o + 32, true);
    o += DRAGON_COMBAT_BYTES;
  }

  // Live records fill the mirror's pools from the front; the rest are free slots.
  const projectiles = out.projectiles;
  for (let i = 0; i < projectiles.length; i++) {
    const projectile = projectiles[i];
    if (projectile === undefined) continue;
    projectile.active = i < projectileCount;
    if (!projectile.active) continue;
    projectile.id = view.getUint16(o, true);
    projectile.kind = view.getUint8(o + 2);
    projectile.ownerId = view.getUint8(o + 3);
    projectile.team = view.getUint8(o + 4) === 0 ? 0 : 1;
    projectile.position.x = view.getFloat32(o + 5, true);
    projectile.position.y = view.getFloat32(o + 9, true);
    projectile.position.z = view.getFloat32(o + 13, true);
    projectile.velocity.x = view.getFloat32(o + 17, true);
    projectile.velocity.y = view.getFloat32(o + 21, true);
    projectile.velocity.z = view.getFloat32(o + 25, true);
    o += PROJECTILE_BYTES;
  }
  const zones = out.zones;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (zone === undefined) continue;
    zone.active = i < zoneCount;
    if (!zone.active) continue;
    zone.id = view.getUint8(o);
    zone.kind = view.getUint8(o + 1);
    zone.ownerId = view.getUint8(o + 2);
    zone.team = view.getUint8(o + 3) === 0 ? 0 : 1;
    zone.position.x = view.getFloat32(o + 4, true);
    zone.position.y = view.getFloat32(o + 8, true);
    zone.position.z = view.getFloat32(o + 12, true);
    zone.radius = view.getFloat32(o + 16, true);
    zone.ticksLeft = view.getUint16(o + 20, true);
    o += ZONE_BYTES;
  }
  return o;
}

/** Options of `appendHostEffects`. */
export interface HostEffectsOptions {
  /** The dragon this browser controls, or NO_PLAYER. */
  readonly localDragonId: PlayerId;
  /**
   * Seconds a dead dragon waits to respawn, for `view.local.respawnInS`. Default:
   * MATCH_TUNING.respawnDelayS. Pass Infinity while the mode has respawns off.
   */
  readonly respawnDelayS?: number;
}

/**
 * The host's counterpart of what `buildClientWorldView` does for combat: appends every
 * projectile and ability zone of `current` to the frame's WorldView and fills `view.local` from
 * the local dragon. Call it right after `buildWorldView(view, prev, current, alpha, ...)` with
 * the same states and blend factor. Projectiles are placed along their velocity (they fly
 * straight within a tick, and one launched this tick has no `prev` to blend from); zones stand
 * where `current` has them. Allocation-free once the view's pools have grown.
 */
export function appendHostEffects(
  view: MutableWorldView,
  current: Readonly<HostViewState>,
  alpha: number,
  options: HostEffectsOptions,
): MutableWorldView {
  // A storm wall a mode moved: the views' own storm source only knows the map's radius.
  if (current.stormRadius >= 0) {
    for (let i = 0; i < view.zoneCount; i++) {
      const zone = view.zones[i];
      if (zone !== undefined && zone.kind === 'stormWall') zone.radius = current.stormRadius;
    }
  }

  // `alpha` 1 = at `current`; before it the projectile is that much of a tick back.
  const back = (Math.max(0, Math.min(2, alpha)) - 1) * TICK_DT_S;
  const projectiles = current.projectiles;
  for (let i = 0; i < projectiles.length; i++) {
    const from = projectiles[i];
    if (from === undefined || !from.active) continue;
    const kind = PROJECTILE_KINDS[from.kind];
    if (kind === undefined) continue;
    const out = acquireProjectileView(view);
    out.id = from.id;
    out.kind = kind;
    out.ownerId = from.ownerId;
    out.team = from.team;
    out.position.x = from.position.x + from.velocity.x * back;
    out.position.y = from.position.y + from.velocity.y * back;
    out.position.z = from.position.z + from.velocity.z * back;
    out.velocity.x = from.velocity.x;
    out.velocity.y = from.velocity.y;
    out.velocity.z = from.velocity.z;
  }

  const zones = current.zones;
  for (let i = 0; i < zones.length; i++) {
    const from = zones[i];
    if (from === undefined || !from.active) continue;
    const kind = ZONE_KINDS[from.kind];
    if (kind === undefined) continue;
    const out = acquireZoneView(view);
    out.id = from.id;
    out.kind = kind;
    out.team = from.team;
    out.position.x = from.position.x;
    out.position.y = from.position.y;
    out.position.z = from.position.z;
    out.radius = from.radius;
    out.ownerId = from.ownerId;
    out.remainingS = from.ticksLeft * TICK_DT_S;
  }

  const local = findViewDragon(current, options.localDragonId);
  if (local !== undefined) {
    writeLocalCombatView(
      view.local,
      local,
      options.respawnDelayS ?? MATCH_TUNING.respawnDelayS,
      FLIGHT_TUNING.dodgeCooldownS,
    );
  }
  return view;
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
  view.setUint8(at + 22, info.round > 0 ? (info.round < 255 ? info.round : 255) : 0);
  view.setUint8(at + 23, winnerToByte(info.winner));
  view.setFloat32(at + 24, info.aimX, true);
  view.setFloat32(at + 28, info.aimY, true);
  view.setFloat32(at + 32, info.inputAgeMs, true);
  view.setFloat32(at + 36, info.stepUs, true);
  view.setFloat32(at + 40, info.simUs, true);
  view.setFloat32(at + 44, info.snapshotUs, true);
  view.setFloat32(at + 48, info.pulseUs, true);
  view.setFloat32(at + 52, info.timeRemainingS, true);
  view.setUint16(at + 56, clampU16(info.scoreEmber), true);
  view.setUint16(at + 58, clampU16(info.scoreFrost), true);
  view.setUint32(at + 60, 0, true);
  let o = writeSimState(view, at + STATE_INFO_BYTES, prev);
  o = writeSimState(view, o, current);
  o = writeRelay(view, o, current.relay);
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
  if (
    length < STATE_INFO_BYTES + 2 * SIM_STATE_FIXED_BYTES + RELAY_IDLE_BYTES ||
    end > view.byteLength
  ) {
    return false;
  }
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
  info.round = view.getUint8(at + 22);
  info.winner = winnerFromByte(view.getUint8(at + 23));
  info.timeRemainingS = view.getFloat32(at + 52, true);
  info.scoreEmber = view.getUint16(at + 56, true);
  info.scoreFrost = view.getUint16(at + 58, true);
  let o = readSimState(view, at + STATE_INFO_BYTES, end, prev);
  if (o < 0) return false;
  o = readSimState(view, o, end, current);
  if (o < 0) return false;
  return readRelay(view, o, end, current.relay) === end;
}
