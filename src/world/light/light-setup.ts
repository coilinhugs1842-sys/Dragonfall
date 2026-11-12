/**
 * Turns a map's `SkySetup` into uniform values. The sky, the cloud sea and the puffs build
 * their own (private) haze uniforms from it; `WorldLighting` writes the shared ones with the
 * same functions, so every material lands on the same fog colour.
 */
import { Color, Vector3, Vector4 } from 'three';
import type { IUniform } from 'three';
import type { SkySetup } from '../sky/sky-math';
import { setPaintedColor } from './light-math';

/** Sun in-scatter colour = linear sun colour x this. */
export const HAZE_GLOW_GAIN = 0.85;

/** Unit vector toward the sun. */
export function sunDirectionOf(setup: SkySetup, target: Vector3): Vector3 {
  return target.set(setup.sunDirection.x, setup.sunDirection.y, setup.sunDirection.z).normalize();
}

/**
 * The scene-linear fog colour for a setup: the value that the post pass shows as the map's
 * `fogColor`. `scene.fog.color` and every haze uniform use this.
 */
export function fogSceneColor(setup: SkySetup, target: Color): Color {
  return setPaintedColor(target, setup.fogColor);
}

export function glowSceneColor(setup: SkySetup, target: Color): Color {
  return target.setHex(setup.sunColor).multiplyScalar(HAZE_GLOW_GAIN);
}

/** x: exp2 density, y: cloud-sea Y, z: unused, w: sea-haze scale. */
export function fogParamsOf(setup: SkySetup, cloudSeaY: number, target: Vector4): Vector4 {
  return target.set(setup.fogDensity, cloudSeaY, 0, 1);
}

/**
 * Fresh haze uniforms (the four that `WORLD_LIGHT_FOG_PARS_FRAGMENT` declares) for a material
 * that is configured from a `SkySetup` and does not follow the shared set.
 * `cloudSeaY` defaults far below, which turns the sea haze off.
 */
export function createHazeUniforms(setup: SkySetup, cloudSeaY = -1e6): Record<string, IUniform> {
  return {
    uWlSunDir: { value: sunDirectionOf(setup, new Vector3()) },
    uWlFogColor: { value: fogSceneColor(setup, new Color()) },
    uWlGlowColor: { value: glowSceneColor(setup, new Color()) },
    uWlFogParams: { value: fogParamsOf(setup, cloudSeaY, new Vector4()) },
  };
}

/**
 * Rewrites the values of uniforms made by `createHazeUniforms` for another setup (a match on
 * another map). `cloudSeaY` left out keeps the sea level they have. Load-time, no allocation.
 */
export function writeHazeUniforms(
  uniforms: Record<string, IUniform>,
  setup: SkySetup,
  cloudSeaY?: number,
): void {
  const sunDir = uniforms['uWlSunDir']?.value as Vector3 | undefined;
  const fogColor = uniforms['uWlFogColor']?.value as Color | undefined;
  const glowColor = uniforms['uWlGlowColor']?.value as Color | undefined;
  const params = uniforms['uWlFogParams']?.value as Vector4 | undefined;
  if (sunDir !== undefined) sunDirectionOf(setup, sunDir);
  if (fogColor !== undefined) fogSceneColor(setup, fogColor);
  if (glowColor !== undefined) glowSceneColor(setup, glowColor);
  if (params !== undefined) fogParamsOf(setup, cloudSeaY ?? params.y, params);
}
