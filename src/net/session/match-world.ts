/**
 * What a session needs to know about the map a match is flown on: the collision world the sim
 * (host) and the predictor (client) step dragons against, where riders spawn, and the arena
 * bounds. The sessions never build geometry themselves: they call a `MatchWorldFactory`, so the
 * game layer can hand in the collision world it already built for its views (one BVH per page,
 * not one per session), tests can fly in open sky, and net-bots can skip the map entirely.
 *
 * Host and clients must build the same world from the same `(settings.map, seed)`; both
 * travel in MATCH_START.
 */

import {
  GREYBOX_SPIRES_DEFAULT_SEED,
  createArenaMap,
  createGreyboxSpires,
  spawnGatesForMode,
} from '../../shared';
import type { ArenaMap, HostSettings, MapId, Quat, SpawnGate, TeamId, Vec3 } from '../../shared';
import { NULL_COLLISION_WORLD, createMapCollisionWorld } from '../../sim';
import type { SimCollisionWorld } from '../../sim';

export interface MatchWorld {
  /** Stepped against by `Sim` (host) and `ClientPredictor` (client). */
  readonly collisionWorld: SimCollisionWorld;
  /** Indexed by TeamId. A missing gate falls back to `fallbackSpawn`. */
  readonly spawnGates: readonly SpawnGate[];
  /** Arena bounds, for the holding pattern of a disconnected rider and for the bots. */
  readonly centerX: number;
  readonly centerZ: number;
  /** Horizontal distance from the centre at which the storm starts. */
  readonly radius: number;
  readonly floorY: number;
  readonly ceilingY: number;
}

export type MatchWorldFactory = (settings: Readonly<HostSettings>, seed: number) => MatchWorld;

/** The seed a host uses unless told otherwise: the layout the views draw by default. */
export const DEFAULT_MATCH_SEED = GREYBOX_SPIRES_DEFAULT_SEED;

/**
 * The greybox map with its real terrain collision. Builds a BVH (tens of ms, allocates): call it
 * at match load, not per tick. Every map id flies the greybox until real maps ship (Phase 4).
 */
export function createGreyboxMatchWorld(seed: number = DEFAULT_MATCH_SEED): MatchWorld {
  const map = createGreyboxSpires(seed);
  const collision = createMapCollisionWorld(map);
  return {
    collisionWorld: collision,
    spawnGates: map.spawnGates,
    centerX: map.colliders.stormCenter.x,
    centerZ: map.colliders.stormCenter.z,
    radius: map.colliders.stormRadius,
    floorY: map.colliders.floorY,
    ceilingY: map.colliders.ceilingY,
  };
}

/** `MatchWorldFactory` form of `createGreyboxMatchWorld`: the default of both sessions. */
export const greyboxMatchWorldFactory: MatchWorldFactory = (_settings, seed) =>
  createGreyboxMatchWorld(seed);

/**
 * The MatchWorld of a built map for a mode: the same collision world for every mode, the gate
 * set the mode launches from (Duel uses the closer perches of a real map, DECISIONS 34).
 */
export function matchWorldOf(
  map: ArenaMap,
  collisionWorld: SimCollisionWorld,
  mode: HostSettings['mode'],
): MatchWorld {
  return {
    collisionWorld,
    spawnGates: spawnGatesForMode(map, mode),
    centerX: map.colliders.stormCenter.x,
    centerZ: map.colliders.stormCenter.z,
    radius: map.colliders.stormRadius,
    floorY: map.colliders.floorY,
    ceilingY: map.colliders.ceilingY,
  };
}

/**
 * A `MatchWorldFactory` for the real maps: what matches fly on. It builds the map the lobby
 * picked (`settings.map`, src/shared/maps/registry.ts) and its BVH once per map and layout seed
 * (about 70 ms, allocates) and keeps the latest, so a rematch or a mode change costs nothing.
 * The host worker uses this; the page uses the cache in src/game/match-assets.ts, which builds
 * the same world from the same two values (tests/game/match-world-parity.test.ts).
 */
export function createMapMatchWorldFactory(): MatchWorldFactory {
  let seedOf = -1;
  let mapOf: MapId | null = null;
  let map: ArenaMap | null = null;
  let collision: SimCollisionWorld | null = null;
  return (settings, seed) => {
    const key = seed >>> 0;
    if (map === null || collision === null || seedOf !== key || mapOf !== settings.map) {
      map = createArenaMap(settings.map, key);
      collision = createMapCollisionWorld(map);
      seedOf = key;
      mapOf = settings.map;
    }
    return matchWorldOf(map, collision, settings.mode);
  };
}

/**
 * The old name of `createMapMatchWorldFactory`, from when Shattered Spires was the only map.
 * Kept so callers that still use it (the host worker's entry) build by map id too.
 */
export const createShatteredSpiresMatchWorldFactory = createMapMatchWorldFactory;

const OPEN_SKY_GATE_DISTANCE = 300;
const OPEN_SKY_ALTITUDE = 320;
const OPEN_SKY_SLOT_SPACING = 30;

function openSkyGate(team: TeamId): SpawnGate {
  // Ember launches from -Z toward +Z (yaw 0 = identity), Frost from +Z toward -Z (yaw PI).
  const side = team === 0 ? -1 : 1;
  const slots: Vec3[] = [];
  for (let i = 0; i < 5; i++) {
    slots.push({
      x: (i - 2) * OPEN_SKY_SLOT_SPACING,
      y: OPEN_SKY_ALTITUDE,
      z: side * OPEN_SKY_GATE_DISTANCE,
    });
  }
  return {
    team,
    position: { x: 0, y: OPEN_SKY_ALTITUDE, z: side * OPEN_SKY_GATE_DISTANCE },
    orientation: team === 0 ? { x: 0, y: 0, z: 0, w: 1 } : { x: 0, y: 1, z: 0, w: 0 },
    slots,
  };
}

/**
 * No terrain and no storm wall: two gates facing each other in open sky. For tests that want
 * exact prediction without a BVH, and for anything that only needs the sessions to run.
 */
export function createOpenSkyMatchWorld(): MatchWorld {
  return {
    collisionWorld: NULL_COLLISION_WORLD,
    spawnGates: [openSkyGate(0), openSkyGate(1)],
    centerX: 0,
    centerZ: 0,
    radius: 1000,
    floorY: 0,
    ceilingY: 700,
  };
}

export const openSkyMatchWorldFactory: MatchWorldFactory = () => createOpenSkyMatchWorld();

/** Heading (radians about +Y, 0 = +Z) of a gate's launch direction. */
export function yawOfOrientation(q: Quat): number {
  const forwardX = 2 * (q.x * q.z + q.w * q.y);
  const forwardZ = 1 - 2 * (q.x * q.x + q.y * q.y);
  return Math.atan2(forwardX, forwardZ);
}

const FALLBACK_SPAWN: Vec3 = { x: 0, y: OPEN_SKY_ALTITUDE, z: 0 };

/** Where a rider of `team` in gate slot `gateSlot` enters the world. */
export function spawnPointOf(world: MatchWorld, team: TeamId, gateSlot: number): Vec3 {
  const gate = world.spawnGates[team];
  if (gate === undefined) return FALLBACK_SPAWN;
  return gate.slots[gateSlot] ?? gate.position;
}

export function spawnYawOf(world: MatchWorld, team: TeamId): number {
  const gate = world.spawnGates[team];
  return gate === undefined ? 0 : yawOfOrientation(gate.orientation);
}
