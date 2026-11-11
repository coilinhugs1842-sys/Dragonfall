/**
 * The map side of a match, built once per page and shared by everything that needs it: the
 * session (sim on the host, prediction on a client) gets the collision world through a
 * `MatchWorldFactory`, the views get the map data, and the camera gets the terrain query. One
 * BVH per page, not one per user.
 *
 * Every map id flies the greybox until real maps ship (Phase 4); the layout seed travels in
 * MATCH_START, so host and clients build the same world.
 */

import { GREYBOX_SPIRES_DEFAULT_SEED, createGreyboxSpires } from '../shared';
import type { GreyboxMap } from '../shared';
import type { MatchWorld, MatchWorldFactory } from '../net';
import { createMapCollisionWorld } from '../sim';
import type { MapCollisionWorld } from '../sim';

export interface MatchAssets {
  readonly seed: number;
  readonly map: GreyboxMap;
  /** Sim collision, camera terrain query and the storm wall the views draw, in one object. */
  readonly collision: MapCollisionWorld;
  /** What the sessions step dragons against and spawn them from. */
  readonly world: MatchWorld;
}

export interface MatchAssetsCache {
  /**
   * The assets for a layout seed. Builds the map and its BVH on a miss (tens of ms, allocates):
   * match load only. Only the latest seed is kept.
   */
  get(seed: number): MatchAssets;
  /** Hand this to `createHostSession` / `createClientSession` as `createMatchWorld`. */
  readonly factory: MatchWorldFactory;
  /** The map the title and lobby backdrop take their sky from (the default layout's data). */
  readonly defaultMap: GreyboxMap;
}

function buildAssets(seed: number, map: GreyboxMap): MatchAssets {
  const collision = createMapCollisionWorld(map);
  return {
    seed,
    map,
    collision,
    world: {
      collisionWorld: collision,
      spawnGates: map.spawnGates,
      centerX: map.colliders.stormCenter.x,
      centerZ: map.colliders.stormCenter.z,
      radius: map.colliders.stormRadius,
      floorY: map.colliders.floorY,
      ceilingY: map.colliders.ceilingY,
    },
  };
}

export function createMatchAssetsCache(): MatchAssetsCache {
  const defaultSeed = GREYBOX_SPIRES_DEFAULT_SEED >>> 0;
  const defaultMap = createGreyboxSpires(defaultSeed);
  let cached: MatchAssets | null = null;

  function get(seed: number): MatchAssets {
    const key = seed >>> 0;
    if (cached === null || cached.seed !== key) {
      cached = buildAssets(key, key === defaultSeed ? defaultMap : createGreyboxSpires(key));
    }
    return cached;
  }

  return {
    get,
    factory: (_settings, seed) => get(seed).world,
    defaultMap,
  };
}
