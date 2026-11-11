/**
 * Tuning for terrain bounces and the storm wall (T-1.7). Same rules as the shared tables: plain
 * mutable data, read every tick, so the dev GUI can edit it live and host and clients must run
 * the same values.
 *
 * The rest of the numbers the collision world reads are already in the shared tables:
 * `FLIGHT_TUNING.terrainBounceRestitution`, `FLIGHT_TUNING.terrainLethalSpeed`,
 * `MATCH_TUNING.stormDamagePerS`, `MATCH_TUNING.stormPushAccel` and `CLASS_TUNING[..].hitRadius`
 * (./tuning.ts).
 */

export interface CollisionTuning {
  // Terrain
  /** m/s into the surface. A bounce slower than this does no damage (scrapes are free). */
  terrainDamageMinSpeed: number;
  /** HP per m/s of impact speed (along the surface normal) above `terrainDamageMinSpeed`. */
  terrainDamagePerSpeed: number;
  /** Seconds after taking damage during which another terrain hit does none (unless lethal). */
  terrainRehitGraceS: number;
  /** Speed lost along the surface per m/s of bounce impulse (Coulomb friction). 0 = ice. */
  terrainFriction: number;
  /** m/s. Every bounce leaves the surface at least this fast, so a scrape does not stick. */
  terrainMinBounceSpeed: number;

  // Storm wall
  /** Metres. The push grows by one `stormPushAccel` for every this much depth past the wall. */
  stormPushDepthScale: number;
  /** rad/s. How fast the wall turns the nose back toward the arena at full depth. */
  stormSteerRate: number;
  /** Metres past the wall at which the turn reaches `stormSteerRate`. */
  stormSteerFullDepth: number;
  /**
   * Metres. A living dragon cannot get further than this below the floor or above the ceiling:
   * there the storm is a hard limit. Map geometry that stands in the cloud sea must be rooted
   * deeper than `floorY` minus this. 0 = no hard limit.
   */
  stormVerticalMaxDepth: number;
}

/** First-pass feel values, tuned by playtest. */
export const COLLISION_TUNING: CollisionTuning = {
  terrainDamageMinSpeed: 15,
  terrainDamagePerSpeed: 0.6,
  terrainRehitGraceS: 0.5,
  terrainFriction: 0.3,
  terrainMinBounceSpeed: 6,

  stormPushDepthScale: 40,
  stormSteerRate: 2.5,
  stormSteerFullDepth: 60,
  stormVerticalMaxDepth: 40,
};
