/**
 * The seam between the flight model and whatever the dragon can hit: terrain (BVH) and the
 * storm wall (T-1.7). The sim calls `resolveDragon` once per active dragon per tick, AFTER the
 * flight integration moved it and BEFORE `finalizeDragon` rebuilds the derived fields.
 *
 * What an implementation may do inside `resolveDragon`:
 * - move `dragon.position` out of the obstacle;
 * - change the flight path with `setDragonVelocity` (bounce) or by writing `yaw`/`pitch`/`speed`;
 * - push the dragon by adding to `dragon.burst` (m/s, world space, decays by itself);
 * - hurt it with `damageDragon` (respects dodge immunity and spawn protection unless told not to);
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
}

/** Open sky: nothing to hit. The default until a map is loaded. */
export const NULL_COLLISION_WORLD: SimCollisionWorld = {
  resolveDragon() {},
};
