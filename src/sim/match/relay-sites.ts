/**
 * Where Ember Relay's stands and braziers go (T-6.3), and where a dropped shard may lie.
 *
 * Nothing here is written into a map: both come from data every map already has, the two team
 * spawn gates and the map centre, so the mode works on any map. Each team's stand and brazier
 * sit in front of its gate on the way to the centre, one to the gate's right and one to its
 * left (`MODE_TUNING.emberRelay`). Both teams use their own right hand, so the layout is a half
 * turn of itself, like the maps are: neither side has the shorter run.
 *
 * A wanted spot is then moved into open air (`settleInOpenAir`): inside the height band, inside
 * the storm wall, out of the rock and with room around it. The same routine places a dropped
 * shard, which is how "a shard never stays under the cloud sea or inside rock" holds.
 *
 * Pure functions of their arguments; no clock, no randomness. Site placement runs once per match
 * and a drop a few times per match, so they may make as many terrain queries as they need, but
 * they still allocate nothing.
 */

import type { EmberRelayTuning, MutableVec3, Vec3 } from '../../shared';
import { MapCollisionWorld } from '../collision';
import type { SimCollisionWorld } from '../collision-world';

/** The two terrain questions asked here. A `TerrainBvh` answers both as it is. */
export interface RelayTerrain {
  /** Distance to the nearest surface within `maxDistance`, or -1 when there is none. */
  closestPoint(x: number, y: number, z: number, maxDistance: number): number;
  /** Greater than 0 when the point is inside rock. */
  solidDepth(x: number, y: number, z: number): number;
}

/** What the relay rules need to know about the map. A session's `MatchWorld` has all of it. */
export interface RelayArena {
  /** Where each team launches from. Index = TeamId. */
  readonly gates: readonly Vec3[];
  readonly centerX: number;
  readonly centerZ: number;
  /** The storm wall's radius; 0 or less = the map has no wall. */
  readonly radius: number;
  readonly floorY: number;
  readonly ceilingY: number;
  /** Null = open sky. */
  readonly terrain: RelayTerrain | null;
}

/** Rings searched around a blocked spot, and directions per ring. */
const SEARCH_RINGS = 8;
const SEARCH_DIRECTIONS = 8;
/** The step between rings is at least this many metres. */
const MIN_SEARCH_STEP_M = 20;

/** The terrain of a session's collision world, or null for open sky. */
export function relayTerrainOf(collision: SimCollisionWorld | null): RelayTerrain | null {
  return collision instanceof MapCollisionWorld ? collision.terrain : null;
}

/** Scratch of `settleInOpenAir` (module state: one host, one thread, never re-entered). */
const trial: MutableVec3 = { x: 0, y: 0, z: 0 };

/** Pulls `point` into the height band and inside the storm wall. */
function clampIntoArena(
  point: MutableVec3,
  arena: Readonly<RelayArena>,
  tuning: Readonly<EmberRelayTuning>,
): void {
  const low = arena.floorY + tuning.minAltitudeM;
  const high = arena.ceilingY - tuning.ceilingMarginM;
  if (low <= high) {
    if (point.y < low) point.y = low;
    else if (point.y > high) point.y = high;
  } else {
    // A band thinner than the two margins: the middle of what there is.
    point.y = (arena.floorY + arena.ceilingY) * 0.5;
  }
  if (!(arena.radius > 0)) return;
  const limit = arena.radius - tuning.stormMarginM;
  const dx = point.x - arena.centerX;
  const dz = point.z - arena.centerZ;
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance > limit && distance > 1e-6) {
    const scale = (limit > 0 ? limit : 0) / distance;
    point.x = arena.centerX + dx * scale;
    point.z = arena.centerZ + dz * scale;
  }
}

function isOpen(terrain: RelayTerrain, point: Readonly<Vec3>, clearance: number): boolean {
  if (terrain.solidDepth(point.x, point.y, point.z) > 0) return false;
  return !(clearance > 0) || terrain.closestPoint(point.x, point.y, point.z, clearance) < 0;
}

/**
 * Moves `point` to the nearest spot that is inside the arena, outside the rock and at least
 * `clearance` metres from any surface. Tries the spot itself, then rings around it: straight
 * up, eight ways round (the first toward the map centre), straight down, further out each ring.
 * Returns false, with `point` only clamped into the arena, when none of them is open.
 */
export function settleInOpenAir(
  point: MutableVec3,
  arena: Readonly<RelayArena>,
  tuning: Readonly<EmberRelayTuning>,
  clearance: number,
): boolean {
  clampIntoArena(point, arena, tuning);
  const terrain = arena.terrain;
  if (terrain === null) return true;
  if (isOpen(terrain, point, clearance)) return true;

  const step = clearance > MIN_SEARCH_STEP_M ? clearance : MIN_SEARCH_STEP_M;
  const baseX = point.x;
  const baseY = point.y;
  const baseZ = point.z;
  // The first horizontal direction looks at the map centre: an open spot found there is also
  // further from the storm wall.
  const inward = Math.atan2(arena.centerX - baseX, arena.centerZ - baseZ);
  for (let ring = 1; ring <= SEARCH_RINGS; ring++) {
    const reach = ring * step;
    // -1 = up, 0..7 = round, 8 = down.
    for (let i = -1; i <= SEARCH_DIRECTIONS; i++) {
      trial.x = baseX;
      trial.y = baseY;
      trial.z = baseZ;
      if (i < 0) trial.y += reach;
      else if (i === SEARCH_DIRECTIONS) trial.y -= reach;
      else {
        const angle = inward + (i * Math.PI * 2) / SEARCH_DIRECTIONS;
        trial.x += Math.sin(angle) * reach;
        trial.z += Math.cos(angle) * reach;
      }
      clampIntoArena(trial, arena, tuning);
      if (isOpen(terrain, trial, clearance)) {
        point.x = trial.x;
        point.y = trial.y;
        point.z = trial.z;
        return true;
      }
    }
  }
  return false;
}

/**
 * Writes one site: `forward` metres from the team's gate toward the map centre and `side`
 * metres to the right of that line, at the gate's height, then settled into open air. A gate on
 * the centre itself (no direction to go) keeps the site on the gate.
 */
function writeSite(
  out: MutableVec3,
  gate: Readonly<Vec3>,
  arena: Readonly<RelayArena>,
  tuning: Readonly<EmberRelayTuning>,
  forward: number,
  side: number,
): void {
  let dirX = arena.centerX - gate.x;
  let dirZ = arena.centerZ - gate.z;
  const length = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (length > 1e-6) {
    dirX /= length;
    dirZ /= length;
  } else {
    dirX = 0;
    dirZ = 0;
  }
  // Never past the centre: on a small map both teams' sites would swap sides.
  const along = forward < length * 0.45 ? forward : length * 0.45;
  // Right of a heading (x, z) is (-z, x) with +Y up and yaw 0 = +Z (see CONVENTIONS in flight.ts).
  out.x = gate.x + dirX * along - dirZ * side;
  out.y = gate.y;
  out.z = gate.z + dirZ * along + dirX * side;
  if (settleInOpenAir(out, arena, tuning, tuning.siteClearanceM)) return;
  // Nothing open nearby (a map packed with rock around its gates): the gate itself is open air
  // by the map rules, so the site goes there.
  out.x = gate.x;
  out.y = gate.y;
  out.z = gate.z;
  clampIntoArena(out, arena, tuning);
}

/**
 * Fills `stands` and `braziers` (index = TeamId) for a map. A team without a gate gets its
 * sites on the map centre, so a broken map still starts a match.
 */
export function writeRelaySites(
  stands: MutableVec3[],
  braziers: MutableVec3[],
  arena: Readonly<RelayArena>,
  tuning: Readonly<EmberRelayTuning>,
): void {
  for (let team = 0; team < 2; team++) {
    const stand = stands[team];
    const brazier = braziers[team];
    if (stand === undefined || brazier === undefined) continue;
    const gate = arena.gates[team];
    if (gate === undefined) {
      const y = (arena.floorY + arena.ceilingY) * 0.5;
      stand.x = arena.centerX;
      stand.y = y;
      stand.z = arena.centerZ;
      brazier.x = arena.centerX;
      brazier.y = y;
      brazier.z = arena.centerZ;
      continue;
    }
    writeSite(stand, gate, arena, tuning, tuning.standForwardM, tuning.standSideM);
    writeSite(brazier, gate, arena, tuning, tuning.brazierForwardM, tuning.brazierSideM);
  }
}
