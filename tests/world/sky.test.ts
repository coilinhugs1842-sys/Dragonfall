import { Color, FogExp2, Scene } from 'three';
import type { Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, createGreyboxSpires } from '../../src/shared';
import { srgbDecode, tonemapFilmic } from '../../src/render/post';
import { setPaintedColor } from '../../src/world/light';
import {
  FOG_COLOR,
  FOG_FADE_DISTANCE,
  GOLDEN_HOUR_SKY,
  HEMISPHERE_GROUND_COLOR,
  HEMISPHERE_SKY_COLOR,
  SKY_NOISE_SIZE,
  SKY_RENDER_ORDER,
  SUN_COLOR,
  SUN_ELEVATION_DEG,
  SUN_INTENSITY,
  applySkyFog,
  createSkyDome,
  createSkyFog,
  createSkyLights,
  fogDensityForFade,
  fogDistanceForOpacity,
  fogOpacityAt,
  generateSkyNoise,
  sunDirectionFromAngles,
} from '../../src/world/sky';

/** Names like uSunDir that a GLSL source declares as uniforms. */
function declaredUniforms(glsl: string): string[] {
  return [...glsl.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((match) => match[1] ?? '');
}

describe('fog maths', () => {
  it('finds the density that reaches the wanted opacity at the fade distance', () => {
    const density = fogDensityForFade(1200, 0.98);
    expect(fogOpacityAt(density, 1200)).toBeCloseTo(0.98, 10);
    expect(density).toBeCloseTo(0.001648, 5);
    expect(fogOpacityAt(density, 0)).toBe(0);
    expect(fogOpacityAt(density, 600)).toBeLessThan(0.65);
  });

  it('inverts back to the distance', () => {
    const density = fogDensityForFade(900, 0.5);
    expect(fogDistanceForOpacity(density, 0.5)).toBeCloseTo(900, 8);
    expect(fogDistanceForOpacity(0, 0.5)).toBe(Infinity);
  });

  it('returns no fog for meaningless input', () => {
    expect(fogDensityForFade(0)).toBe(0);
    expect(fogDensityForFade(-5)).toBe(0);
    expect(fogDensityForFade(Number.NaN)).toBe(0);
    expect(fogDensityForFade(1200, 0)).toBe(0);
    expect(fogDensityForFade(1200, 1)).toBe(0);
  });

  it('agrees with the greybox map and the art recipe', () => {
    const map = createGreyboxSpires();
    expect(GOLDEN_HOUR_SKY.fogColor).toBe(FOG_COLOR);
    expect(map.sky.fogColor).toBe(FOG_COLOR);
    expect(map.sky.sunColor).toBe(SUN_COLOR);
    // The map rounds its density; both must hide ~98 % at the recipe's 1.2 km.
    expect(fogOpacityAt(map.sky.fogDensity, FOG_FADE_DISTANCE)).toBeCloseTo(0.98, 2);
    expect(fogOpacityAt(GOLDEN_HOUR_SKY.fogDensity, FOG_FADE_DISTANCE)).toBeCloseTo(0.98, 10);
  });
});

describe('sun direction', () => {
  it('is a unit vector at the recipe elevation', () => {
    const sun = sunDirectionFromAngles(SUN_ELEVATION_DEG);
    expect(Math.hypot(sun.x, sun.y, sun.z)).toBeCloseTo(1, 12);
    expect(sun.y).toBeCloseTo(Math.sin((18 * Math.PI) / 180), 12);
    expect(sun.z).toBeCloseTo(0, 12);
    const map = createGreyboxSpires();
    expect(sun.x).toBeCloseTo(map.sky.sunDirection.x, 3);
    expect(sun.y).toBeCloseTo(map.sky.sunDirection.y, 3);
  });

  it('turns about +Y with the azimuth', () => {
    const sun = sunDirectionFromAngles(30, Math.PI / 2);
    expect(sun.x).toBeCloseTo(0, 12);
    expect(sun.z).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    expect(sun.y).toBeCloseTo(0.5, 12);
  });
});

describe('sky fog', () => {
  it('creates exp2 fog with the setup colour and density', () => {
    const fog = createSkyFog();
    expect(fog).toBeInstanceOf(FogExp2);
    // Stored scene-linear: through the post pass's tone curve it comes out as FOG_COLOR.
    expect(fog.color.equals(setPaintedColor(new Color(), FOG_COLOR))).toBe(true);
    expect(tonemapFilmic(fog.color.r)).toBeCloseTo(srgbDecode(((FOG_COLOR >> 16) & 0xff) / 255), 6);
    expect(tonemapFilmic(fog.color.g)).toBeCloseTo(srgbDecode(((FOG_COLOR >> 8) & 0xff) / 255), 6);
    expect(tonemapFilmic(fog.color.b)).toBeCloseTo(srgbDecode((FOG_COLOR & 0xff) / 255), 6);
    expect(fog.density).toBe(GOLDEN_HOUR_SKY.fogDensity);
  });

  it('reuses the fog a scene already has', () => {
    const scene = new Scene();
    const first = applySkyFog(scene);
    expect(scene.fog).toBe(first);
    const second = applySkyFog(scene, { ...GOLDEN_HOUR_SKY, fogColor: 0x112233, fogDensity: 0.01 });
    expect(second).toBe(first);
    expect(first.color.equals(setPaintedColor(new Color(), 0x112233))).toBe(true);
    expect(first.density).toBe(0.01);
  });
});

describe('sky lights', () => {
  it('follows the lighting recipe with a single non-shadowing sun', () => {
    const lights = createSkyLights();
    expect(lights.sun.color.getHex()).toBe(SUN_COLOR);
    expect(lights.sun.intensity).toBe(SUN_INTENSITY);
    expect(lights.hemisphere.color.getHex()).toBe(HEMISPHERE_SKY_COLOR);
    expect(lights.hemisphere.groundColor.getHex()).toBe(HEMISPHERE_GROUND_COLOR);
    const elevation = Math.asin(lights.sun.position.y / lights.sun.position.length());
    expect((elevation * 180) / Math.PI).toBeCloseTo(SUN_ELEVATION_DEG, 6);
    for (const preset of Object.values(QUALITY_PRESETS)) {
      lights.setQuality(preset);
      expect(lights.sun.castShadow).toBe(false);
    }
    lights.dispose();
  });

  it('sizes the shadow map from the preset once shadows are allowed', () => {
    const lights = createSkyLights(GOLDEN_HOUR_SKY, { allowShadows: true });
    lights.setQuality(QUALITY_PRESETS.low);
    expect(lights.sun.castShadow).toBe(false);
    lights.setQuality(QUALITY_PRESETS.medium);
    expect(lights.sun.castShadow).toBe(true);
    expect(lights.sun.shadow.mapSize.x).toBe(1024);
    lights.setQuality(QUALITY_PRESETS.high);
    expect(lights.sun.shadow.mapSize.y).toBe(2048);
    lights.dispose();
  });
});

describe('sky dome', () => {
  it('is a depth-tested, non-writing, never-culled background drawn after the opaques', () => {
    const sky = createSkyDome();
    const material = sky.object.material;
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(false);
    expect(material.fog).toBe(false);
    expect(sky.object.frustumCulled).toBe(false);
    expect(sky.object.renderOrder).toBe(SKY_RENDER_ORDER);
    expect(sky.object.geometry.getAttribute('position').count).toBe(3);
    sky.dispose();
  });

  it('puts the scene fog colour on the horizon and leaves the tone map to the post pass', () => {
    const map = createGreyboxSpires();
    const sky = createSkyDome(map.sky);
    const material = sky.object.material;
    // The post pass tone-maps and encodes: the sky writes scene-linear values like everything else.
    expect(material.toneMapped).toBe(false);
    expect(material.fragmentShader).not.toContain('colorspace_fragment');
    expect(material.fragmentShader).not.toContain('tonemapping_fragment');
    expect(material.fragmentShader).toContain('wlHaze(dir)');
    const horizon = material.uniforms['uWlFogColor']?.value as Color;
    expect(horizon.equals(createSkyFog(map.sky).color)).toBe(true);
    sky.dispose();
  });

  it('drifts the cloud sheets with a wrapped offset', () => {
    const sky = createSkyDome();
    const drift = sky.object.material.uniforms['uDrift']?.value as Vector4;
    for (const time of [0, 12.5, 4000, 1e6]) {
      sky.update(time);
      for (const offset of [drift.x, drift.y, drift.z, drift.w]) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(1);
      }
    }
    sky.update(100);
    const before = drift.x;
    sky.update(160);
    expect(drift.x).not.toBe(before);
    sky.dispose();
  });

  it('declares exactly the uniforms it is given', () => {
    const sky = createSkyDome();
    const material = sky.object.material;
    const declared = [
      ...declaredUniforms(material.vertexShader),
      ...declaredUniforms(material.fragmentShader),
    ].sort();
    expect(declared).toEqual(Object.keys(material.uniforms).sort());
    sky.dispose();
  });

  it('switches detail with the preset and only recompiles on a change', () => {
    const sky = createSkyDome();
    const material = sky.object.material;
    sky.setQuality(QUALITY_PRESETS.low);
    expect(Object.keys(material.defines)).toEqual([]);
    const afterLow = material.version;
    sky.setQuality(QUALITY_PRESETS.low);
    expect(material.version).toBe(afterLow);
    sky.setQuality(QUALITY_PRESETS.medium);
    expect(Object.keys(material.defines).sort()).toEqual(['SKY_DETAIL']);
    const afterMedium = material.version;
    expect(afterMedium).toBeGreaterThan(afterLow);
    sky.setQuality(QUALITY_PRESETS.high);
    expect(material.version).toBe(afterMedium);
    sky.dispose();
  });
});

describe('sky noise', () => {
  const size = 64;
  const noise = generateSkyNoise(size, 3);

  it('is deterministic per seed and sized for the dome by default', () => {
    expect(noise.length).toBe(size * size * 4);
    expect(generateSkyNoise(size, 3)).toEqual(noise);
    expect(generateSkyNoise(size, 4)).not.toEqual(noise);
    expect(generateSkyNoise().length).toBe(SKY_NOISE_SIZE * SKY_NOISE_SIZE * 4);
    expect(() => generateSkyNoise(8, 1)).toThrow();
  });

  it('uses the whole range in every channel', () => {
    for (let channel = 0; channel < 4; channel++) {
      let min = 255;
      let max = 0;
      for (let i = 0; i < size * size; i++) {
        const v = noise[i * 4 + channel] ?? 0;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      expect(min).toBe(0);
      expect(max).toBe(255);
    }
  });

  it('tiles: the step across the wrap edge is no bigger than steps inside', () => {
    for (let channel = 0; channel < 4; channel++) {
      const at = (x: number, y: number): number => noise[(y * size + x) * 4 + channel] ?? 0;
      let inside = 0;
      let across = 0;
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size - 1; j++) {
          inside = Math.max(
            inside,
            Math.abs(at(j + 1, i) - at(j, i)),
            Math.abs(at(i, j + 1) - at(i, j)),
          );
        }
        across = Math.max(
          across,
          Math.abs(at(0, i) - at(size - 1, i)),
          Math.abs(at(i, 0) - at(i, size - 1)),
        );
      }
      expect(across).toBeLessThanOrEqual(inside);
    }
  });
});
