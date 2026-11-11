/** Pure helpers for the cloud sea and the cloud puffs. No three.js, no DOM: tested in node. */
import { fogDistanceForOpacity } from '../sky/sky-math';

// --- Cloud palette (sRGB hex), derived from the sky colours in docs/ART_DIRECTION.md -------------
// These are the colours wanted ON SCREEN; the views convert them with `setPaintedColor`.
/** Sunlit cloud: a warm peach-cream. */
export const CLOUD_LIT_COLOR = 0xf6cfa2;
/** The brightest crests and rims, facing the sun. */
export const CLOUD_CREST_COLOR = 0xfaecd2;
/** Shaded cloud: the dusk violet lifted toward the haze, so shadows stay airy. */
export const CLOUD_SHADOW_COLOR = 0xa189b4;
/** Shaded folds of the cloud sea. */
export const CLOUD_SEA_SHADOW_COLOR = 0x957fab;
/** The deepest valleys of the cloud sea, and the underside of a puff. */
export const CLOUD_SEA_DEEP_COLOR = 0x6c6599;

/** Nearest multiple of `step` to `value`. A non-positive step returns `value` unchanged. */
export function snapToGrid(value: number, step: number): number {
  if (!(step > 0)) return value;
  // `+ 0` turns the -0 that Math.round gives for small negatives into 0.
  return Math.round(value / step) * step + 0;
}

/**
 * Texture-coordinate offset of a pattern that has scrolled at `speed` m/s for `timeS` seconds
 * over a tile `tileSize` metres wide, wrapped to [0, 1). Wrapping on the CPU keeps the value
 * small, so the shader loses no precision however long the match runs.
 */
export function wrapScroll(timeS: number, speed: number, tileSize: number): number {
  if (!(tileSize > 0)) return 0;
  const turns = (timeS * speed) / tileSize;
  const wrapped = turns - Math.floor(turns);
  // A tiny negative `turns` can round up to exactly 1.
  return wrapped < 1 ? wrapped : 0;
}

/** Largest extent the sea is ever given, also the fallback when the scene has no fog. */
export const CLOUD_SEA_MAX_HALF_EXTENT = 6000;

/**
 * Half the edge of the cloud-sea square: far enough that the fog has hidden all but `residual`
 * of the sea at its nearest edge, plus the snap step it moves by. With the default residual the
 * edge differs from the fog-coloured sky by well under one 8-bit step.
 */
export function cloudSeaHalfExtent(fogDensity: number, snapStep: number, residual = 1e-4): number {
  const reach = fogDistanceForOpacity(fogDensity, 1 - residual);
  const step = snapStep > 0 ? snapStep : 0;
  if (!Number.isFinite(reach)) return CLOUD_SEA_MAX_HALF_EXTENT;
  return Math.min(Math.ceil(reach + step), CLOUD_SEA_MAX_HALF_EXTENT);
}

/** GLSL `smoothstep`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * How much of the screen a puff of half-size `radius` covers at `distance`, as a fraction of
 * the screen's half-height (NDC units), after the on-screen cap. `projectionScale` is
 * `projectionMatrix[1][1]` = 1 / tan(fov / 2). Mirrors the puff vertex shader.
 */
export function puffScreenSize(
  radius: number,
  distance: number,
  projectionScale: number,
  maxScreenSize: number,
): number {
  if (!(distance > 0)) return maxScreenSize;
  return Math.min((radius * projectionScale) / distance, maxScreenSize);
}

/**
 * Opacity factor of a puff from the camera distance alone. Mirrors the puff vertex shader: 0
 * while the camera is within `nearStart * radius`, 1 from `nearEnd * radius`, then back to 0
 * between `farStart` and `farEnd` metres, where the fog has hidden it anyway.
 */
export function puffDistanceFade(
  distance: number,
  radius: number,
  nearStart: number,
  nearEnd: number,
  farStart: number,
  farEnd: number,
): number {
  const near = smoothstep(nearStart * radius, nearEnd * radius, distance);
  const far = 1 - smoothstep(farStart, farEnd, distance);
  return near * far;
}
