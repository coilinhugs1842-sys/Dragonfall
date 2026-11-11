/**
 * Terrain collision and the storm wall (T-1.7). Pure sim code: no view modules, no DOM.
 * `COLLISION_TUNING` and `TerrainQuery` live in `src/shared` (views and the dev GUI need them).
 */

export { MapCollisionWorld, createMapCollisionWorld } from './map-collision-world';
export type {
  CollisionMapSource,
  MapCollisionOptions,
  TerrainHitListener,
} from './map-collision-world';
export { TerrainBvh } from './terrain-bvh';
