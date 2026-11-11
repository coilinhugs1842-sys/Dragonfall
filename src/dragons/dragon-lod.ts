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
  let lod0 = 0;
  let skinned = 0;
  for (let i = 0; i < count; i++) {
    const level =
      i === localIndex
        ? 0
        : lodForDistance(distances[i] as number, levels[i] as number, policy.distances);
    levels[i] = level;
    if (level === 0) lod0++;
    if (level !== DRAGON_LOD_FAR) skinned++;
  }
  // Too many at LOD0: the farthest (never the local one) step down to LOD1.
  while (lod0 > policy.maxLod0) {
    let worst = -1;
    for (let i = 0; i < count; i++) {
      if (i === localIndex || levels[i] !== 0) continue;
      if (worst < 0 || (distances[i] as number) > (distances[worst] as number)) worst = i;
    }
    if (worst < 0) break;
    levels[worst] = 1;
    lod0--;
  }
  // Too many skinned: the farthest go far.
  while (skinned > policy.maxSkinned) {
    let worst = -1;
    for (let i = 0; i < count; i++) {
      if (i === localIndex || levels[i] === DRAGON_LOD_FAR) continue;
      if (worst < 0 || (distances[i] as number) > (distances[worst] as number)) worst = i;
    }
    if (worst < 0) break;
    levels[worst] = DRAGON_LOD_FAR;
    skinned--;
  }
}
