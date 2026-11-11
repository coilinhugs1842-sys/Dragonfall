/**
 * The map side of a match, built once per page and shared by everything that needs it: the
 * session (sim on the host, prediction on a client) gets the collision world through a
 * `MatchWorldFactory`, the views get the map data, and the camera gets the terrain query. One
 * BVH per page, not one per user.
 *
 * Every map id flies Shattered Spires (the real map, T-4.5) until the second map ships; the
 * layout seed travels in MATCH_START, so host and clients build the same world. `?map=greybox`
 * is not wired: the greybox generator stays for tests.
 */

import { SHATTERED_SPIRES_DEFAULT_SEED, createShatteredSpires } from '../shared';
import type { ArenaMap } from '../shared';
import { matchWorldOf } from '../net';
import type { MatchWorld, MatchWorldFactory } from '../net';
import { createMapCollisionWorld } from '../sim';
import type { MapCollisionWorld } from '../sim';

export interface MatchAssets {
  readonly seed: number;
  readonly map: ArenaMap;
  /** Sim collision, camera terrain query and the storm wall the views draw, in one object. */
  readonly collision: MapCollisionWorld;
  /** What the sessions step dragons against and spawn them from (the Skirmish gate set). */
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
  readonly defaultMap: ArenaMap;
}

function buildAssets(seed: number, map: ArenaMap): MatchAssets {
  const collision = createMapCollisionWorld(map);
  return { seed, map, collision, world: matchWorldOf(map, collision, 'skirmish') };
}

export function createMatchAssetsCache(): MatchAssetsCache {
  const defaultSeed = SHATTERED_SPIRES_DEFAULT_SEED >>> 0;
  const defaultMap = createShatteredSpires(defaultSeed);
  let cached: MatchAssets | null = null;

  function get(seed: number): MatchAssets {
    const key = seed >>> 0;
    if (cached === null || cached.seed !== key) {
      cached = buildAssets(key, key === defaultSeed ? defaultMap : createShatteredSpires(key));
    }
    return cached;
  }

  return {
    get,
    // Same collision world for every mode; Duel launches from the map's closer gate set.
    factory: (settings, seed) => {
      const assets = get(seed);
      return matchWorldOf(assets.map, assets.collision, settings.mode);
    },
    defaultMap,
  };
}
