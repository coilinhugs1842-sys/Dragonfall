/**
 * The map side of a match, built once per page and shared by everything that needs it: the
 * session (sim on the host, prediction on a client) gets the collision world through a
 * `MatchWorldFactory`, the views get the map data, and the camera gets the terrain query. One
 * BVH per page, not one per user.
 *
 * Which map is built comes from the lobby (`HostSettings.map`) on the host and from MATCH_START
 * on a client, together with the layout seed, so host and clients build the same world
 * (src/shared/maps/registry.ts). `?map=greybox` is not wired: the greybox generator stays for
 * tests.
 */

import { DEFAULT_MAP_ID, createArenaMap, defaultSeedOfMap } from '../shared';
import type { ArenaMap, MapId } from '../shared';
import { matchWorldOf } from '../net';
import type { MatchWorld, MatchWorldFactory } from '../net';
import { createMapCollisionWorld } from '../sim';
import type { MapCollisionWorld } from '../sim';

export interface MatchAssets {
  readonly mapId: MapId;
  readonly seed: number;
  readonly map: ArenaMap;
  /** Sim collision, camera terrain query and the storm wall the views draw, in one object. */
  readonly collision: MapCollisionWorld;
  /** What the sessions step dragons against and spawn them from (the Skirmish gate set). */
  readonly world: MatchWorld;
}

export interface MatchAssetsCache {
  /**
   * The assets for a layout seed of a map (the default map when left out). Builds the map and
   * its BVH on a miss (tens of ms, allocates): match load only. Only the latest pair is kept.
   */
  get(seed: number, mapId?: MapId): MatchAssets;
  /** Hand this to `createHostSession` / `createClientSession` as `createMatchWorld`. */
  readonly factory: MatchWorldFactory;
  /** The map the title and lobby backdrop take their sky from (the default layout's data). */
  readonly defaultMap: ArenaMap;
}

function buildAssets(mapId: MapId, seed: number, map: ArenaMap): MatchAssets {
  const collision = createMapCollisionWorld(map);
  return { mapId, seed, map, collision, world: matchWorldOf(map, collision, 'skirmish') };
}

export function createMatchAssetsCache(): MatchAssetsCache {
  const defaultSeed = defaultSeedOfMap(DEFAULT_MAP_ID);
  const defaultMap = createArenaMap(DEFAULT_MAP_ID, defaultSeed);
  let cached: MatchAssets | null = null;

  function get(seed: number, mapId: MapId = DEFAULT_MAP_ID): MatchAssets {
    const key = seed >>> 0;
    if (cached === null || cached.seed !== key || cached.mapId !== mapId) {
      const isDefault = mapId === DEFAULT_MAP_ID && key === defaultSeed;
      cached = buildAssets(mapId, key, isDefault ? defaultMap : createArenaMap(mapId, key));
    }
    return cached;
  }

  return {
    get,
    // Same collision world for every mode; Duel launches from the map's closer gate set.
    factory: (settings, seed) => {
      const assets = get(seed, settings.map);
      return matchWorldOf(assets.map, assets.collision, settings.mode);
    },
    defaultMap,
  };
}
