import { DepthTexture, PerspectiveCamera, WebGLRenderTarget } from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../src/shared';
import { WORLD_LIGHT, createWorldLighting } from '../../src/world/light';
import type { WorldLighting } from '../../src/world/light';
import { createSkyLights } from '../../src/world/sky';
import type { SkyLights } from '../../src/world/sky';

interface Rig {
  lights: SkyLights;
  lighting: WorldLighting;
  camera: PerspectiveCamera;
}

function rig(): Rig {
  const lights = createSkyLights();
  const lighting = createWorldLighting({ lights, cloudSeaY: 0 });
  const camera = new PerspectiveCamera(60, 16 / 9, 0.5, 6000);
  camera.position.set(0, 250, 0);
  camera.lookAt(0, 250, 100);
  camera.updateMatrixWorld();
  return { lights, lighting, camera };
}

/**
 * What three does the first time the sun's shadow is rendered: it allocates the depth target
 * at the light's `mapSize`. Returns the target and a count of its `dispose` events.
 */
function renderShadowOnce(lights: SkyLights): { target: WebGLRenderTarget; disposed: () => number } {
  const size = lights.sun.shadow.mapSize.x;
  const target = new WebGLRenderTarget(size, size);
  target.depthTexture = new DepthTexture(size, size);
  let count = 0;
  target.addEventListener('dispose', () => {
    count++;
  });
  lights.sun.shadow.map = target;
  return { target, disposed: () => count };
}

describe('the sun shadow map is freed when no preset samples it', () => {
  it.each(['medium', 'high'] as const)('%s -> low frees the depth target', (from) => {
    const { lights, lighting, camera } = rig();
    lighting.setQuality(QUALITY_PRESETS[from]);
    const shadow = renderShadowOnce(lights);
    lighting.update(camera, 0);
    expect(WORLD_LIGHT.uWlShadowMap.value).toBe(shadow.target.depthTexture);
    expect(shadow.disposed()).toBe(0);

    lighting.setQuality(QUALITY_PRESETS.low);
    expect(lighting.shadowPlan.mode).not.toBe('map');
    expect(shadow.disposed()).toBe(1);
    expect(lights.sun.shadow.map).toBeNull();
    // Nothing may keep sampling the freed texture.
    expect(WORLD_LIGHT.uWlShadowMap.value).toBeNull();
    expect(lights.sun.castShadow).toBe(false);

    // Frames on Low neither bring it back nor free it twice.
    for (let i = 0; i < 3; i++) lighting.update(camera, i);
    expect(lights.sun.shadow.map).toBeNull();
    expect(WORLD_LIGHT.uWlShadowMap.value).toBeNull();
    expect(shadow.disposed()).toBe(1);

    lighting.dispose();
    lights.dispose();
  });

  it('keeps the map while the preset still uses one of the same size', () => {
    const { lights, lighting, camera } = rig();
    lighting.setQuality(QUALITY_PRESETS.medium);
    const shadow = renderShadowOnce(lights);
    lighting.setQuality(QUALITY_PRESETS.medium);
    lighting.update(camera, 0);
    expect(shadow.disposed()).toBe(0);
    expect(lights.sun.shadow.map).toBe(shadow.target);
    lighting.dispose();
    lights.dispose();
  });

  it('replaces it when the size changes, and the switch back up from Low starts clean', () => {
    const { lights, lighting, camera } = rig();
    lighting.setQuality(QUALITY_PRESETS.medium);
    const medium = renderShadowOnce(lights);
    lighting.setQuality(QUALITY_PRESETS.high);
    expect(medium.disposed()).toBe(1);
    expect(lights.sun.shadow.map).toBeNull();
    expect(lights.sun.shadow.mapSize.x).toBe(QUALITY_PRESETS.high.shadowMapSize);

    const high = renderShadowOnce(lights);
    lighting.setQuality(QUALITY_PRESETS.low);
    expect(high.disposed()).toBe(1);

    lighting.setQuality(QUALITY_PRESETS.high);
    lighting.update(camera, 0);
    // three allocates a new one on the next shadow pass; until then the shader gets none.
    expect(lights.sun.castShadow).toBe(true);
    expect(lights.sun.shadow.map).toBeNull();
    expect(WORLD_LIGHT.uWlShadowMap.value).toBeNull();
    lighting.dispose();
    lights.dispose();
  });

  it('frees it on dispose', () => {
    const { lights, lighting, camera } = rig();
    lighting.setQuality(QUALITY_PRESETS.high);
    const shadow = renderShadowOnce(lights);
    lighting.update(camera, 0);
    lighting.dispose();
    expect(shadow.disposed()).toBe(1);
    expect(lights.sun.shadow.map).toBeNull();
    expect(WORLD_LIGHT.uWlShadowMap.value).toBeNull();
    lights.dispose();
  });

  it('does nothing when there never was a map (a session that started on Low)', () => {
    const { lights, lighting, camera } = rig();
    lighting.setQuality(QUALITY_PRESETS.low);
    lighting.update(camera, 0);
    lighting.setQuality(QUALITY_PRESETS.low);
    expect(lights.sun.shadow.map).toBeNull();
    lighting.dispose();
    lights.dispose();
  });
});
