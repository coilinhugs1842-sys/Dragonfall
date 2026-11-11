/**
 * Scene fog for the golden-hour sky. The sky dome's horizon band and the cloud sea both resolve
 * to this fog's colour, which is what hides the far plane.
 */
import { FogExp2 } from 'three';
import type { Scene } from 'three';
import { GOLDEN_HOUR_SKY } from './sky-math';
import type { SkySetup } from './sky-math';

/** A FogExp2 with the setup's colour and density. Colour management converts the sRGB hex. */
export function createSkyFog(setup: SkySetup = GOLDEN_HOUR_SKY): FogExp2 {
  return new FogExp2(setup.fogColor, setup.fogDensity);
}

/**
 * Puts the fog on `scene`, reusing the scene's FogExp2 when it already has one. Load-time only.
 * Returns the fog so a debug GUI can bind to its density.
 */
export function applySkyFog(scene: Scene, setup: SkySetup = GOLDEN_HOUR_SKY): FogExp2 {
  const existing = scene.fog;
  if (existing instanceof FogExp2) {
    existing.color.setHex(setup.fogColor);
    existing.density = setup.fogDensity;
    return existing;
  }
  const fog = createSkyFog(setup);
  scene.fog = fog;
  return fog;
}
