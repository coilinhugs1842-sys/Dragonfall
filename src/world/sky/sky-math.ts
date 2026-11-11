/**
 * Pure numbers behind the sky: the golden-hour palette and lighting recipe from
 * docs/ART_DIRECTION.md, and the exp2 fog maths. No three.js, no DOM: tested in node.
 */
import type { MapSky, Vec3 } from '../../shared';

/** What the sky, lights, fog and clouds need from a map: `MapManifest.sky` fits as it is. */
export type SkySetup = Pick<MapSky, 'sunDirection' | 'sunColor' | 'fogColor' | 'fogDensity'>;

// --- Palette (docs/ART_DIRECTION.md "Sky, clouds": cream -> peach -> dusk violet), sRGB hex -------
export const SKY_CREAM = 0xf4e6cc;
export const SKY_PEACH = 0xf2b984;
export const SKY_DUSK_VIOLET = 0x5b4c7a;

// --- Lighting recipe, Shattered Spires (golden hour) ---------------------------------------------
export const SUN_COLOR = 0xffd9a0;
export const SUN_INTENSITY = 2.2;
export const SUN_ELEVATION_DEG = 18;
export const HEMISPHERE_SKY_COLOR = 0x9fb7d9;
export const HEMISPHERE_GROUND_COLOR = 0x3f5a55;
export const HEMISPHERE_INTENSITY = 1.0;
export const FOG_COLOR = 0xe9d9c0;
/** "Density tuned so 1.2 km fades out". */
export const FOG_FADE_DISTANCE = 1200;
/** What "fades out" means here: the fog hides this fraction of an object at the fade distance. */
export const FOG_FADE_OPACITY = 0.98;

/**
 * Opacity of three's FogExp2 at `distance`: `1 - exp(-(density * distance)^2)`, the same formula
 * as the `fog_fragment` shader chunk.
 */
export function fogOpacityAt(density: number, distance: number): number {
  const x = density * distance;
  return 1 - Math.exp(-x * x);
}

/**
 * The FogExp2 density at which the fog reaches `opacity` (0..1 exclusive) at `distance` metres.
 * Returns 0 (no fog) for a distance or opacity that makes no sense.
 */
export function fogDensityForFade(distance: number, opacity: number = FOG_FADE_OPACITY): number {
  if (!(distance > 0) || !(opacity > 0) || !(opacity < 1)) return 0;
  return Math.sqrt(-Math.log(1 - opacity)) / distance;
}

/**
 * Inverse of `fogOpacityAt`: the distance at which fog of `density` reaches `opacity`.
 * Infinity when there is no fog.
 */
export function fogDistanceForOpacity(density: number, opacity: number): number {
  if (!(density > 0) || !(opacity > 0) || !(opacity < 1)) return Infinity;
  return Math.sqrt(-Math.log(1 - opacity)) / density;
}

/**
 * Unit vector toward a sun `elevationDeg` above the horizon. `azimuthRad` turns about +Y from +X
 * toward +Z, so 0 puts the sun over +X (side-on to both team gates of a z-mirrored map).
 */
export function sunDirectionFromAngles(elevationDeg: number, azimuthRad = 0): Vec3 {
  const elevation = (elevationDeg * Math.PI) / 180;
  const flat = Math.cos(elevation);
  return {
    x: flat * Math.cos(azimuthRad),
    y: Math.sin(elevation),
    z: flat * Math.sin(azimuthRad),
  };
}

/** The recipe as a `SkySetup`, for scenes without a map (title, tests). */
export const GOLDEN_HOUR_SKY: SkySetup = {
  sunDirection: sunDirectionFromAngles(SUN_ELEVATION_DEG),
  sunColor: SUN_COLOR,
  fogColor: FOG_COLOR,
  fogDensity: fogDensityForFade(FOG_FADE_DISTANCE),
};
