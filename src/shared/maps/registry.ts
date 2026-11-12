/**
 * Which map a match flies on, by `MapId`. The ONE place that turns `(map id, seed)` into a
 * built map, so the host's sim (worker or main thread), every client's prediction and every
 * view build the same world from the same two numbers. Both travel in MATCH_START.
 *
 * Load-time code: building a map allocates and takes tens of milliseconds.
 */

import type { MapId } from '../match';
import type { ArenaMap } from './arena-map';
import { EMBERFALL_CALDERA_DEFAULT_SEED, createEmberfallCaldera } from './emberfall-caldera';
import { SHATTERED_SPIRES_DEFAULT_SEED, createShatteredSpires } from './shattered-spires';

/** The map a room starts on, and the one the title and the lobby take their sky from. */
export const DEFAULT_MAP_ID: MapId = 'shattered-spires';

/** The layout seed a map is drawn, baked and tested with. */
export function defaultSeedOfMap(map: MapId): number {
  return map === 'emberfall-caldera'
    ? EMBERFALL_CALDERA_DEFAULT_SEED >>> 0
    : SHATTERED_SPIRES_DEFAULT_SEED >>> 0;
}

/**
 * The seed a match on `map` is flown with, given the seed the host was started with.
 *
 * Shattered Spires takes the host's seed as it is. Emberfall Caldera always flies its own
 * default layout: its vents, its intro flyby and its baked manifest are authored around that one
 * layout, and the host's seed is a Shattered Spires seed that says nothing about the caldera.
 * The host calls this when a match begins and sends the result; clients never call it (they
 * take the seed from MATCH_START), so a later change of this rule needs no client change.
 */
export function matchSeedOfMap(map: MapId, hostSeed: number): number {
  return map === 'emberfall-caldera' ? defaultSeedOfMap(map) : hostSeed >>> 0;
}

/** Builds the map `map` with layout seed `seed`. Same two values, same map, on every machine. */
export function createArenaMap(map: MapId, seed: number): ArenaMap {
  return map === 'emberfall-caldera'
    ? createEmberfallCaldera(seed >>> 0)
    : createShatteredSpires(seed >>> 0);
}
