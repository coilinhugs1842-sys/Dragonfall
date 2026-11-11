/**
 * Pure LOD and culling maths for the placed map assets (no three.js, node-testable).
 *
 * Every placed instance is in one of four TIERS each frame:
 *
 *   0  LOD0, drawn by its type's InstancedMesh
 *   1  LOD1, drawn by its type's second InstancedMesh (rocks only: they ship three LODs)
 *   F  the type's LAST LOD, drawn by the static merged "far" mesh of its map cluster
 *   -  not drawn (a small prop past the preset's prop draw distance)
 *
 * The pick uses the instance's apparent size `s = radius / distance` (rocks are 50-280 m across,
 * braziers 7 m: one distance table would fit neither). Around each threshold lies a band in
 * which BOTH neighbouring tiers are drawn with complementary screen-door dither, so a switch
 * never pops (Medium / High; Low snaps).
 *
 * Fade values are signed, as the world material reads them (world-material.ts):
 *   v > 0   keep the fragment where dither <  v        (1 = fully drawn)
 *   v < 0   keep the fragment where dither >= 1 + v    (-1 = fully drawn)
 *   v = 0   not drawn
 * so `v` on the nearer tier and `v - 1` on the farther tier cover every pixel exactly once.
 */

import type { QualityPreset, QualityPresetId } from '../../shared';

export interface PropLodSettings {
  /** Apparent size above which a rock uses LOD0 / LOD1. */
  readonly rockLod0: number;
  readonly rockLod1: number;
  /** Apparent size above which a prop or gate uses LOD0 (below: the far mesh, LOD1). */
  readonly propLod0: number;
  /** Half-width of a cross-fade band as a fraction of its threshold; 0 = snap. */
  readonly fadeBand: number;
  /** Metres from the eye to the instance's sphere beyond which a small prop is not drawn. */
  readonly propDrawDistance: number;
  /** Metres over which a prop dithers out before `propDrawDistance`; 0 = snap. */
  readonly cullFade: number;
  /**
   * Instances whose sphere reaches inside this distance are never frustum-culled, so a rock
   * just off screen still casts into the shadow map (High; 0 elsewhere).
   */
  readonly keepDistance: number;
}

const LOD_TABLE: Readonly<
  Record<QualityPresetId, Pick<PropLodSettings, 'rockLod0' | 'rockLod1' | 'propLod0' | 'fadeBand'>>
> = {
  low: { rockLod0: 0.6, rockLod1: 0.25, propLod0: 0.12, fadeBand: 0 },
  medium: { rockLod0: 0.35, rockLod1: 0.14, propLod0: 0.075, fadeBand: 0.1 },
  high: { rockLod0: 0.2, rockLod1: 0.08, propLod0: 0.045, fadeBand: 0.1 },
};

export function propLodSettings(preset: QualityPreset): PropLodSettings {
  const row = LOD_TABLE[preset.id];
  const fade = row.fadeBand > 0;
  return {
    ...row,
    propDrawDistance: preset.propDrawDistance,
    cullFade: fade ? 60 : 0,
    keepDistance: preset.shadowCasters === 'all' ? 170 : 0,
  };
}

/** What the far mesh does with an instance. */
export const TIER_NEAR = 0;
export const TIER_MID = 1;
export const TIER_FAR = 2;

/**
 * Result of `pickTiers`, reused between calls: the signed fade (see the file comment) of each
 * of the three drawn tiers; 0 = that tier does not draw the instance.
 */
export interface TierFades {
  near: number;
  mid: number;
  far: number;
}

/** 0..1 position of `s` inside the band around threshold `t` (0 below it, 1 above it). */
export function bandPosition(s: number, t: number, band: number): number {
  if (!(band > 0)) return s >= t ? 1 : 0;
  const lo = t * (1 - band);
  const hi = t * (1 + band);
  if (s <= lo) return 0;
  if (s >= hi) return 1;
  return (s - lo) / (hi - lo);
}

/**
 * Tiers for one instance. `instancedLods` is how many LODs the type draws instanced (rocks 2,
 * props and gates 1, backdrops 0); `cullable` marks small props that vanish with distance.
 * Allocation-free: writes `out`.
 */
export function pickTiers(
  out: TierFades,
  distance: number,
  radius: number,
  instancedLods: number,
  isRock: boolean,
  cullable: boolean,
  settings: PropLodSettings,
): TierFades {
  out.near = 0;
  out.mid = 0;
  out.far = 0;
  const d = distance > 1 ? distance : 1;
  const s = radius / d;

  if (instancedLods <= 0) {
    out.far = 1;
  } else if (instancedLods === 1) {
    const a = bandPosition(s, isRock ? settings.rockLod0 : settings.propLod0, settings.fadeBand);
    out.near = a;
    out.far = a - 1;
  } else {
    const a = bandPosition(s, settings.rockLod0, settings.fadeBand);
    if (a > 0) {
      out.near = a;
      out.mid = a - 1;
    } else {
      const b = bandPosition(s, settings.rockLod1, settings.fadeBand);
      out.mid = b;
      out.far = b - 1;
    }
  }

  if (cullable && out.far !== 0) {
    const beyond = d - radius - settings.propDrawDistance;
    if (beyond >= 0) {
      out.far = 0;
    } else if (settings.cullFade > 0 && beyond > -settings.cullFade && out.far === -1) {
      // Only a fully-far prop reaches this distance: dither it out.
      out.far = -beyond / settings.cullFade;
    }
  }
  return out;
}

/** Signed fade -> the two bytes of the far-state texture (R magnitude, G 255 when negative). */
export function encodeFarFade(fade: number, out: Uint8Array, offset: number): void {
  const magnitude = fade < 0 ? -fade : fade;
  out[offset] = magnitude >= 1 ? 255 : Math.round(magnitude * 255);
  out[offset + 1] = fade < 0 ? 255 : 0;
}

/**
 * True when the sphere is entirely outside one of the six planes (`planes` = 6 x (nx, ny, nz,
 * constant), normals pointing inward, as three's `Frustum`). Allocation-free.
 */
export function sphereOutsidePlanes(
  planes: Float32Array,
  x: number,
  y: number,
  z: number,
  radius: number,
): boolean {
  for (let p = 0; p < 24; p += 4) {
    const distance =
      (planes[p] ?? 0) * x + (planes[p + 1] ?? 0) * y + (planes[p + 2] ?? 0) * z + (planes[p + 3] ?? 0);
    if (distance < -radius) return true;
  }
  return false;
}

/** Key of the far-mesh cluster a world position falls in (a square grid of `cell` metres). */
export function farClusterKey(x: number, z: number, cell: number): number {
  const cx = Math.floor(x / cell) + 512;
  const cz = Math.floor(z / cell) + 512;
  return cx * 1024 + cz;
}
