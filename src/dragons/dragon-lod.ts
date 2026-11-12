/**
 * Which representation each dragon gets this frame. Pure and allocation-free (node-testable).
 *
 * A dragon is drawn as a skinned mesh at LOD0, LOD1 or LOD2, or, beyond the last LOD distance
 * (or when the preset's skinned-dragon cap is full), as the FAR representation: the instanced
 * ~170-triangle dragon with vertex-shader wings (placeholder-dragons.ts), one draw call per
 * class for any number of dragons.
 *
 * Distances come from `QualityPreset.dragonLodDistances` and are compared against the
 * SCREEN-SIZE distance: the real distance scaled by the camera's zoom, so a boost's wide FOV
 * (dragons look smaller) drops detail sooner and a narrow FOV keeps it longer.
 */

import type { QualityPreset, QualityPresetId } from '../shared/quality';

export const DRAGON_LOD_FAR = 3;
/** 0, 1, 2 = skinned LOD; 3 = far representation. */
export type DragonLodLevel = 0 | 1 | 2 | 3;

/** A boundary moves by this fraction against the direction of travel, so LODs do not flicker. */
export const LOD_HYSTERESIS = 0.08;
/**
 * The caps (`maxLod0`, `maxSkinned`) rank dragons by distance, and a dragon that already holds
 * a place is ranked as if it were this fraction nearer. A challenger therefore takes a place
 * only when it is clearly nearer (about 10 %), not every time two distances cross: on Low in a
 * 5v5 two dragons circling each other at the cut would otherwise swap between the skinned
 * model and the far one, with a pose pop each time.
 */
export const LOD_CAP_HYSTERESIS = 0.1;
/** The vertical FOV (degrees) the preset distances are tuned for. */
export const LOD_REFERENCE_FOV_DEG = 60;

export interface DragonLodPolicy {
  /** Metres: LOD0 up to [0], LOD1 up to [1], LOD2 up to [2], far beyond. */
  readonly distances: readonly [number, number, number];
  /** Most dragons at LOD0 at once (the local dragon counts). */
  readonly maxLod0: number;
  /** Most skinned dragons at once; the farthest beyond this are drawn far. */
  readonly maxSkinned: number;
  /** Pose updates per second for LOD1 and LOD2 dragons; 0 = every frame. */
  readonly lod1PoseHz: number;
  readonly lod2PoseHz: number;
  /** LOD2 dragons skip the procedural layers (neck, tail, wing lag). */
  readonly lod2Procedural: boolean;
}

const POLICY_EXTRAS: Readonly<
  Record<QualityPresetId, Omit<DragonLodPolicy, 'distances'>>
> = {
  low: { maxLod0: 1, maxSkinned: 6, lod1PoseHz: 30, lod2PoseHz: 15, lod2Procedural: false },
  medium: { maxLod0: 2, maxSkinned: 10, lod1PoseHz: 0, lod2PoseHz: 15, lod2Procedural: false },
  high: { maxLod0: 4, maxSkinned: 10, lod1PoseHz: 0, lod2PoseHz: 30, lod2Procedural: true },
};

export function dragonLodPolicy(preset: QualityPreset): DragonLodPolicy {
  return { distances: preset.dragonLodDistances, ...POLICY_EXTRAS[preset.id] };
}

/** Factor that turns a real distance into the screen-size distance for a vertical FOV. */
export function lodFovScale(fovDeg: number): number {
  const half = (Math.min(Math.max(fovDeg, 10), 150) * Math.PI) / 360;
  return Math.tan(half) / Math.tan((LOD_REFERENCE_FOV_DEG * Math.PI) / 360);
}

/**
 * LOD for one dragon by distance alone. `previous` is last frame's level (or -1 for a dragon
 * not drawn last frame): boundaries next to it get the hysteresis.
 */
export function lodForDistance(
  distance: number,
  previous: number,
  distances: readonly [number, number, number],
): DragonLodLevel {
  for (let level = 0; level < 3; level++) {
    let limit = distances[level] as number;
    if (previous >= 0) limit *= previous <= level ? 1 + LOD_HYSTERESIS : 1 - LOD_HYSTERESIS;
    if (distance <= limit) return level as DragonLodLevel;
  }
  return DRAGON_LOD_FAR;
}

/** What a dragon held last frame (see `LOD_CAP_HYSTERESIS`). */
const HELD_SKINNED = 1;
const HELD_LOD0 = 2;
/** Per-dragon HELD_* bits of the call in progress. Grown (never per frame in practice) on demand. */
let heldScratch = new Uint8Array(256);

/**
 * Chooses the level of `count` dragons in place.
 *
 * @param distances screen-size distance per dragon (see `lodFovScale`).
 * @param levels in: last frame's level per dragon or -1; out: this frame's level.
 * @param localIndex index of the camera's own dragon (always LOD0), or -1.
 */
export function selectDragonLods(
  distances: Float32Array,
  levels: Int8Array,
  count: number,
  localIndex: number,
  policy: DragonLodPolicy,
): void {
  if (heldScratch.length < count) heldScratch = new Uint8Array(count);
  const held = heldScratch;
  const keep = 1 - LOD_CAP_HYSTERESIS;
  let lod0 = 0;
  let skinned = 0;
  for (let i = 0; i < count; i++) {
    const previous = levels[i] as number;
    held[i] =
      previous === 0
        ? HELD_SKINNED | HELD_LOD0
        : previous > 0 && previous < DRAGON_LOD_FAR
          ? HELD_SKINNED
          : 0;
    const level =
      i === localIndex ? 0 : lodForDistance(distances[i] as number, previous, policy.distances);
    levels[i] = level;
    if (level === 0) lod0++;
    if (level !== DRAGON_LOD_FAR) skinned++;
  }
  // Too many at LOD0: the farthest (never the local one) step down to LOD1. A dragon that was
  // at LOD0 last frame counts as a little nearer, so it is not pushed out by a near tie.
  while (lod0 > policy.maxLod0) {
    let worst = -1;
    let worstRank = 0;
    for (let i = 0; i < count; i++) {
      if (i === localIndex || levels[i] !== 0) continue;
      const rank =
        (distances[i] as number) * (((held[i] as number) & HELD_LOD0) !== 0 ? keep : 1);
      if (worst < 0 || rank > worstRank) {
        worst = i;
        worstRank = rank;
      }
    }
    if (worst < 0) break;
    levels[worst] = 1;
    lod0--;
  }
  // Too many skinned: the farthest go far, with the same preference for those already skinned.
  while (skinned > policy.maxSkinned) {
    let worst = -1;
    let worstRank = 0;
    for (let i = 0; i < count; i++) {
      if (i === localIndex || levels[i] === DRAGON_LOD_FAR) continue;
      const rank =
        (distances[i] as number) * (((held[i] as number) & HELD_SKINNED) !== 0 ? keep : 1);
      if (worst < 0 || rank > worstRank) {
        worst = i;
        worstRank = rank;
      }
    }
    if (worst < 0) break;
    levels[worst] = DRAGON_LOD_FAR;
    skinned--;
  }
}
