/**
 * The scene's two lights (docs/ART_DIRECTION.md lighting recipe): one warm low sun and a
 * hemisphere ambient. Exactly one sun: the budget allows a single shadow-casting light.
 */
import { DirectionalLight, HemisphereLight } from 'three';
import type { QualityPreset } from '../../shared';
import { skyLookOf } from './sky-look';
import { GOLDEN_HOUR_SKY, HEMISPHERE_INTENSITY, SUN_INTENSITY } from './sky-math';
import type { SkySetup } from './sky-math';

export interface SkyLightsOptions {
  readonly sunIntensity?: number;
  readonly hemisphereSkyColor?: number;
  readonly hemisphereGroundColor?: number;
  readonly hemisphereIntensity?: number;
  /**
   * Lets `setQuality` turn the sun's shadow map on for presets that have one. Off by default:
   * nothing casts yet, and an enabled shadow light costs a shadow pass every frame. The module
   * that owns the casters (dragons) must also fit `sun.shadow.camera` around them.
   */
  readonly allowShadows?: boolean;
}

export interface SkyLights {
  /** Add both to the scene. `sun.target` stays at the origin, so it needs no scene parent. */
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  /** Shadow map on/off and size from the preset. Never per frame. */
  setQuality(preset: QualityPreset): void;
  /** Another map's sun and hemisphere colours and sun direction. Not per frame. */
  setSky(setup: SkySetup): void;
  dispose(): void;
}

export function createSkyLights(
  setup: SkySetup = GOLDEN_HOUR_SKY,
  options: SkyLightsOptions = {},
): SkyLights {
  const allowShadows = options.allowShadows ?? false;

  const sun = new DirectionalLight(setup.sunColor, options.sunIntensity ?? SUN_INTENSITY);
  // A directional light shines from `position` toward its target (the origin): only the
  // direction matters while it casts no shadow.
  sun.position.set(setup.sunDirection.x, setup.sunDirection.y, setup.sunDirection.z).normalize();
  sun.castShadow = false;

  const look = skyLookOf(setup);
  const hemisphere = new HemisphereLight(
    options.hemisphereSkyColor ?? look.hemisphereSky,
    options.hemisphereGroundColor ?? look.hemisphereGround,
    options.hemisphereIntensity ?? HEMISPHERE_INTENSITY,
  );

  return {
    sun,
    hemisphere,
    setSky(next: SkySetup): void {
      sun.color.setHex(next.sunColor);
      // While the sun casts no shadow only its direction matters; `WorldLighting.update`
      // places it for the shadow pass.
      sun.position.set(next.sunDirection.x, next.sunDirection.y, next.sunDirection.z).normalize();
      const nextLook = skyLookOf(next);
      hemisphere.color.setHex(options.hemisphereSkyColor ?? nextLook.hemisphereSky);
      hemisphere.groundColor.setHex(options.hemisphereGroundColor ?? nextLook.hemisphereGround);
    },
    setQuality(preset: QualityPreset): void {
      const size = preset.shadowMapSize;
      const cast = allowShadows && size > 0 && preset.shadowCasters !== 'none';
      if (cast && sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        // The map is allocated lazily at its first size; drop it so the new size takes effect.
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      sun.castShadow = cast;
    },
    dispose(): void {
      // Frees the shadow render target, if one was ever created.
      sun.dispose();
      hemisphere.dispose();
    },
  };
}
