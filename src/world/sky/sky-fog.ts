/**
 * Scene fog for the golden-hour sky. The sky dome's horizon band and the cloud sea both resolve
 * to this fog's colour, which is what hides the far plane.
 *
 * The fog colour is stored SCENE-linear (`fogSceneColor`): the value that the post pass's tone
 * curve shows as the map's `fogColor`. It is not the hex itself.
 */
import { FogExp2 } from 'three';
import type { Scene } from 'three';
import { fogSceneColor } from '../light/light-setup';
import { GOLDEN_HOUR_SKY } from './sky-math';
import type { SkySetup } from './sky-math';

/** A FogExp2 with the setup's density and its colour as shown through the post pass. */
export function createSkyFog(setup: SkySetup = GOLDEN_HOUR_SKY): FogExp2 {
  const fog = new FogExp2(setup.fogColor, setup.fogDensity);
  fogSceneColor(setup, fog.color);
  return fog;
}

/**
 * Puts the fog on `scene`, reusing the scene's FogExp2 when it already has one. Load-time only.
 * Returns the fog so a debug GUI can bind to its density.
 */
export function applySkyFog(scene: Scene, setup: SkySetup = GOLDEN_HOUR_SKY): FogExp2 {
  const existing = scene.fog;
  if (existing instanceof FogExp2) {
    fogSceneColor(setup, existing.color);
    existing.density = setup.fogDensity;
    return existing;
  }
  const fog = createSkyFog(setup);
  scene.fog = fog;
  return fog;
}
