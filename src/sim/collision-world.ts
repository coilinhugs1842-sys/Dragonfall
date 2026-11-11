/**
 * The seam between the flight model and whatever the dragon can hit: terrain (BVH) and the
 * storm wall (T-1.7). The sim calls `resolveDragon` once per active dragon per tick, AFTER the
 * flight integration moved it and BEFORE `finalizeDragon` rebuilds the derived fields.
 *
 * What an implementation may do inside `resolveDragon`:
 * - move `dragon.position` out of the obstacle;
 * - change the flight path with `setDragonVelocity` (bounce) or by writing `yaw`/`pitch`/`speed`;
 * - push the dragon by adding to `dragon.burst` (m/s, world space, decays by itself);
 * - hurt it with `damageDragon` (respects dodge immunity and spawn protection unless told not to)
 *   and then say so in `dragon.envDamage` / `dragon.envSource`: the host's damage pipeline reads
 *   those after the step for takedown credit and events (the same code runs in a client's
 *   prediction, where nobody reads them);
 * - set or clear flag bits the sim does not own (e.g. DRAGON_FLAG_IN_STORM).
 *
 * `dragon.velocity` and `dragon.orientation` still hold LAST tick's values during the call and
 * are rewritten right after it, so read `prevPosition` -> `position` for this tick's movement.
 * Dead dragons (no DRAGON_FLAG_ALIVE) are passed too: they are falling and should stop on terrain.
 *
 * Rules: deterministic, no allocation, and it must not keep `dragon` or `prevPosition` (both
 * are reused objects).
 */

import type { FlightTuning, Vec3 } from '../shared';
import type { DragonState } from './dragon-state';

export interface SimCollisionWorld {
  /**
   * @param dragon Mutable state after this tick's flight integration.
   * @param prevPosition Where the dragon was before the integration (a reused scratch vector).
   * @param dtS The fixed tick length in seconds.
   * @param tuning The live flight table (`terrainBounceRestitution`, `terrainLethalSpeed`, ...).
   */
  resolveDragon(dragon: DragonState, prevPosition: Vec3, dtS: number, tuning: FlightTuning): void;
  /**
   * Terrain ray for abilities (bolts stop on rock, cones and beams need a clear line): distance
   * to the first surface along the ray, or -1 when nothing is hit within `maxDistance`. Same
   * contract as `TerrainQuery.raycast`, but it takes one reused object: seven floats passed to a
   * call the JIT does not inline are seven heap numbers, and this runs per projectile per tick.
   * Absent = no terrain.
   */
  raycastRay?(ray: Readonly<TerrainRay>): number;
  /**
   * Moves the storm wall. A negative or non-finite radius restores the map's own. Absent = the
   * world has no storm wall. The host calls it through `Sim.setStormRadius`; a client applies
   * the radius its snapshots carry, so both step dragons against the same wall.
   */
  setStormRadius?(radius: number): void;
}

/** Argument of `SimCollisionWorld.raycastRay`. The direction does not have to be unit length. */
export interface TerrainRay {
  originX: number;
  originY: number;
  originZ: number;
  directionX: number;
  directionY: number;
  directionZ: number;
  maxDistance: number;
}

export function createTerrainRay(): TerrainRay {
  return {
    originX: 0,
    originY: 0,
    originZ: 0,
    directionX: 0,
    directionY: 0,
    directionZ: 1,
    maxDistance: 0,
  };
}

/** Values of `DragonState.envSource`. */
export const ENV_SOURCE_NONE = 0;
export const ENV_SOURCE_TERRAIN = 1;
export const ENV_SOURCE_STORM = 2;

/** Open sky: nothing to hit. The default until a map is loaded. */
export const NULL_COLLISION_WORLD: SimCollisionWorld = {
  resolveDragon() {},
};
