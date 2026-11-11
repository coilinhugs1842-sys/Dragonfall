/**
 * The simulation's state for one tick: time, a fixed pool of dragons, and (T-3.x) fixed pools of
 * projectiles and zones plus the running score sheet.
 *
 * Everything stays mutable and fixed-size so a state can be copied into a reused buffer without
 * allocating. Every field added here must also be copied in `copySimState`.
 */

import { MAX_PLAYERS, MAX_PROJECTILES, MAX_ZONES, NO_PLAYER, TEAM_EMBER } from '../shared';
import type { MutableVec3, PlayerId, TeamId } from '../shared';
import { copyDragonState, createDragonState, resetDragonState } from './dragon-state';
import type { DragonState } from './dragon-state';

/** One projectile in flight. A swept sphere: see `combat.ts`. */
export interface ProjectileState {
  /** False = free pool slot. */
  active: boolean;
  /** Unique among live projectiles; wraps at 65536. */
  id: number;
  /** Index into PROJECTILE_KINDS. */
  kind: number;
  ownerId: PlayerId;
  team: TeamId;
  /** Ability slot that launched it (index into ABILITY_SLOTS = its damage source). */
  slot: number;
  /** Damage it carries, fixed at launch. */
  damage: number;
  position: MutableVec3;
  velocity: MutableVec3;
  ticksLeft: number;
}

/** One ability zone (a sphere). The storm wall is not here: the collision world owns it. */
export interface ZoneState {
  active: boolean;
  /** 1..255, unique among live zones (0 is the storm wall in the views). */
  id: number;
  /** Index into ZONE_KINDS. */
  kind: number;
  ownerId: PlayerId;
  team: TeamId;
  slot: number;
  position: MutableVec3;
  radius: number;
  ticksLeft: number;
  /** Ticks since it appeared (drives its pulses). */
  ageTicks: number;
}

/** A dragon slot's running totals for the scoreboard. Same index as `SimState.dragons`. */
export interface ScoreState {
  takedowns: number;
  deaths: number;
  assists: number;
  /** HP of damage dealt to enemies. */
  damage: number;
}

export interface SimState {
  /** Index of the last tick applied to this state; -1 before the first step. */
  tick: number;
  /** Simulated seconds since the sim was created or reset. */
  timeS: number;
  /**
   * Pool of exactly MAX_PLAYERS slots; the array never grows or shrinks. A slot is live only
   * when `active` is true, and live slots are NOT packed at the front: loop over all of them
   * and skip the inactive ones. The slot index is not the player id (use `findDragon`).
   */
  dragons: DragonState[];
  /** Number of active slots. */
  dragonCount: number;
  /** Pool of exactly MAX_PROJECTILES slots; same rules as `dragons`. */
  projectiles: ProjectileState[];
  projectileCount: number;
  /** Pool of exactly MAX_ZONES slots; same rules as `dragons`. */
  zones: ZoneState[];
  zoneCount: number;
  /** Indexed like `dragons`. Kept across respawns; cleared when the slot is freed. */
  scores: ScoreState[];
  /** Takedowns of an enemy per team (index = TeamId). A mode turns these into its score. */
  teamTakedowns: number[];
  /**
   * The storm wall radius a mode set (`Sim.setStormRadius`), in metres; -1 = the map's own.
   * Travels in snapshots so clients predict against the same wall.
   */
  stormRadius: number;
  nextProjectileId: number;
  nextZoneId: number;
}

export function createProjectileState(): ProjectileState {
  return {
    active: false,
    id: 0,
    kind: 0,
    ownerId: NO_PLAYER,
    team: TEAM_EMBER,
    slot: 0,
    damage: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    ticksLeft: 0,
  };
}

export function createZoneState(): ZoneState {
  return {
    active: false,
    id: 0,
    kind: 0,
    ownerId: NO_PLAYER,
    team: TEAM_EMBER,
    slot: 0,
    position: { x: 0, y: 0, z: 0 },
    radius: 0,
    ticksLeft: 0,
    ageTicks: 0,
  };
}

function copyProjectileState(out: ProjectileState, from: Readonly<ProjectileState>): void {
  out.active = from.active;
  // A free slot's other fields are never read.
  if (!from.active) return;
  out.id = from.id;
  out.kind = from.kind;
  out.ownerId = from.ownerId;
  out.team = from.team;
  out.slot = from.slot;
  out.damage = from.damage;
  out.position.x = from.position.x;
  out.position.y = from.position.y;
  out.position.z = from.position.z;
  out.velocity.x = from.velocity.x;
  out.velocity.y = from.velocity.y;
  out.velocity.z = from.velocity.z;
  out.ticksLeft = from.ticksLeft;
}

function copyZoneState(out: ZoneState, from: Readonly<ZoneState>): void {
  out.active = from.active;
  if (!from.active) return;
  out.id = from.id;
  out.kind = from.kind;
  out.ownerId = from.ownerId;
  out.team = from.team;
  out.slot = from.slot;
  out.position.x = from.position.x;
  out.position.y = from.position.y;
  out.position.z = from.position.z;
  out.radius = from.radius;
  out.ticksLeft = from.ticksLeft;
  out.ageTicks = from.ageTicks;
}

export function resetScoreState(score: ScoreState): void {
  score.takedowns = 0;
  score.deaths = 0;
  score.assists = 0;
  score.damage = 0;
}

export function createSimState(): SimState {
  const dragons: DragonState[] = [];
  const scores: ScoreState[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    dragons.push(createDragonState());
    scores.push({ takedowns: 0, deaths: 0, assists: 0, damage: 0 });
  }
  const projectiles: ProjectileState[] = [];
  for (let i = 0; i < MAX_PROJECTILES; i++) projectiles.push(createProjectileState());
  const zones: ZoneState[] = [];
  for (let i = 0; i < MAX_ZONES; i++) zones.push(createZoneState());
  return {
    tick: -1,
    timeS: 0,
    dragons,
    dragonCount: 0,
    projectiles,
    projectileCount: 0,
    zones,
    zoneCount: 0,
    scores,
    teamTakedowns: [0, 0],
    stormRadius: -1,
    nextProjectileId: 0,
    nextZoneId: 0,
  };
}

/** Removes every projectile and zone (new round). Dragons and scores are left alone. */
export function clearSimEffects(state: SimState): void {
  // Whole slots are reset, not just `active`, so a cleared state equals a new one.
  for (let i = 0; i < state.projectiles.length; i++) {
    const projectile = state.projectiles[i];
    if (projectile === undefined) continue;
    projectile.active = false;
    projectile.id = 0;
    projectile.kind = 0;
    projectile.ownerId = NO_PLAYER;
    projectile.team = TEAM_EMBER;
    projectile.slot = 0;
    projectile.damage = 0;
    projectile.position.x = 0;
    projectile.position.y = 0;
    projectile.position.z = 0;
    projectile.velocity.x = 0;
    projectile.velocity.y = 0;
    projectile.velocity.z = 0;
    projectile.ticksLeft = 0;
  }
  state.projectileCount = 0;
  for (let i = 0; i < state.zones.length; i++) {
    const zone = state.zones[i];
    if (zone === undefined) continue;
    zone.active = false;
    zone.id = 0;
    zone.kind = 0;
    zone.ownerId = NO_PLAYER;
    zone.team = TEAM_EMBER;
    zone.slot = 0;
    zone.position.x = 0;
    zone.position.y = 0;
    zone.position.z = 0;
    zone.radius = 0;
    zone.ticksLeft = 0;
    zone.ageTicks = 0;
  }
  state.zoneCount = 0;
}

export function resetSimState(state: SimState): SimState {
  state.tick = -1;
  state.timeS = 0;
  for (let i = 0; i < state.dragons.length; i++) {
    const dragon = state.dragons[i];
    if (dragon !== undefined) resetDragonState(dragon);
    const score = state.scores[i];
    if (score !== undefined) resetScoreState(score);
  }
  state.dragonCount = 0;
  clearSimEffects(state);
  state.teamTakedowns.fill(0);
  state.stormRadius = -1;
  state.nextProjectileId = 0;
  state.nextZoneId = 0;
  return state;
}

export function copySimState(out: SimState, from: Readonly<SimState>): SimState {
  out.tick = from.tick;
  out.timeS = from.timeS;
  for (let i = 0; i < out.dragons.length; i++) {
    const target = out.dragons[i];
    const source = from.dragons[i];
    if (target !== undefined && source !== undefined) copyDragonState(target, source);
    const score = out.scores[i];
    const fromScore = from.scores[i];
    if (score !== undefined && fromScore !== undefined) {
      score.takedowns = fromScore.takedowns;
      score.deaths = fromScore.deaths;
      score.assists = fromScore.assists;
      score.damage = fromScore.damage;
    }
  }
  out.dragonCount = from.dragonCount;
  for (let i = 0; i < out.projectiles.length; i++) {
    const target = out.projectiles[i];
    const source = from.projectiles[i];
    if (target !== undefined && source !== undefined) {
      // Free on both sides is the common case: nothing to do.
      if (target.active || source.active) copyProjectileState(target, source);
    }
  }
  out.projectileCount = from.projectileCount;
  for (let i = 0; i < out.zones.length; i++) {
    const target = out.zones[i];
    const source = from.zones[i];
    if (target !== undefined && source !== undefined) {
      if (target.active || source.active) copyZoneState(target, source);
    }
  }
  out.zoneCount = from.zoneCount;
  out.teamTakedowns[0] = from.teamTakedowns[0] ?? 0;
  out.teamTakedowns[1] = from.teamTakedowns[1] ?? 0;
  out.stormRadius = from.stormRadius;
  out.nextProjectileId = from.nextProjectileId;
  out.nextZoneId = from.nextZoneId;
  return out;
}

/** Linear scan (at most MAX_PLAYERS slots). Returns undefined when the player has no dragon. */
export function findDragon(state: Readonly<SimState>, id: PlayerId): DragonState | undefined {
  for (let i = 0; i < state.dragons.length; i++) {
    const dragon = state.dragons[i];
    if (dragon !== undefined && dragon.active && dragon.id === id) return dragon;
  }
  return undefined;
}

/** Slot index of the player's dragon, or -1. The same index is valid in `prev` and `current`. */
export function findDragonSlot(state: Readonly<SimState>, id: PlayerId): number {
  for (let i = 0; i < state.dragons.length; i++) {
    const dragon = state.dragons[i];
    if (dragon !== undefined && dragon.active && dragon.id === id) return i;
  }
  return -1;
}
