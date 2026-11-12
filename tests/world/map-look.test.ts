/**
 * A match on another map repaints the scene's sky, fog, lights, sea and cloud puffs for that
 * map, and the default map's look comes back exactly when the match unloads (the title and the
 * lobby keep the first map's golden hour). Also: which textures a map draws with.
 */
import { readFileSync } from 'node:fs';
import { Color, DataTexture, FogExp2, Scene, Vector2, Vector3, Vector4 } from 'three';
import type { BufferGeometry, Mesh, Object3D, ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  QUALITY_PRESETS,
  createEmberfallCaldera,
  createShatteredSpires,
} from '../../src/shared';
import type { MapTexture } from '../../src/shared';
import { POST_SETTINGS } from '../../src/render/post';
import { cloudFieldFromMap, createCloudBillboards, createCloudSea } from '../../src/world/clouds';
import { WORLD_LIGHT, createWorldLighting } from '../../src/world/light';
import { createMapLook } from '../../src/world/map-look';
import { collectMapAssets, texturesForMap, textureSlotOf } from '../../src/world/props';
import {
  GOLDEN_HOUR_LOOK,
  HEMISPHERE_GROUND_COLOR,
  HEMISPHERE_SKY_COLOR,
  SKY_CREAM,
  SKY_DUSK_VIOLET,
  WORLD_GLOW_GAIN,
  WORLD_MOSS_COLOR,
  WORLD_STONE_COLOR,
  WORLD_STONE_SATURATION,
  applySkyFog,
  createSkyDome,
  createSkyLights,
  mixHex,
  skyLookOf,
} from '../../src/world/sky';

const SPIRES = createShatteredSpires();
const CALDERA = createEmberfallCaldera();

/** A number for every float a view holds: uniforms, vertex buffers, draw ranges. */
function fingerprint(objects: readonly Object3D[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  objects.forEach((object, index) => {
    const mesh = object as Mesh<BufferGeometry, ShaderMaterial>;
    const key = `${index}:${object.name}`;
    out[`${key}.position`] = object.position.toArray();
    out[`${key}.visible`] = object.visible;
    if (mesh.geometry === undefined) return;
    out[`${key}.count`] = (mesh as unknown as { count?: number }).count ?? -1;
    out[`${key}.drawRange`] = [mesh.geometry.drawRange.start, mesh.geometry.drawRange.count];
    for (const name of Object.keys(mesh.geometry.attributes)) {
      out[`${key}.attr.${name}`] = Array.from(mesh.geometry.attributes[name]?.array ?? []);
    }
    const uniforms = mesh.material.uniforms ?? {};
    for (const name of Object.keys(uniforms)) {
      const value: unknown = uniforms[name]?.value;
      if (typeof value === 'number') out[`${key}.u.${name}`] = value;
      else if (
        value instanceof Color ||
        value instanceof Vector2 ||
        value instanceof Vector3 ||
        value instanceof Vector4
      ) {
        out[`${key}.u.${name}`] = value.toArray();
      }
    }
  });
  return out;
}

function sharedLight(): Record<string, unknown> {
  const u = WORLD_LIGHT;
  return {
    sunDir: u.uWlSunDir.value.toArray(),
    sunColor: u.uWlSunColor.value.toArray(),
    hemiSky: u.uWlHemiSky.value.toArray(),
    hemiGround: u.uWlHemiGround.value.toArray(),
    fogColor: u.uWlFogColor.value.toArray(),
    glowColor: u.uWlGlowColor.value.toArray(),
    fogParams: u.uWlFogParams.value.toArray(),
    postSun: POST_SETTINGS.sunDirection.toArray(),
  };
}

function buildScene() {
  const map = SPIRES;
  const scene = new Scene();
  applySkyFog(scene, map.sky);
  const sky = createSkyDome(map.sky);
  const lights = createSkyLights(map.sky);
  const cloudSeaY = map.colliders.cloudSeaY ?? map.colliders.floorY;
  const sea = createCloudSea({ cloudSeaY, sky: map.sky });
  const clouds = createCloudBillboards({ field: cloudFieldFromMap(map), sky: map.sky });
  const lighting = createWorldLighting({
    sky: map.sky,
    lights,
    cloudSeaY,
    shafts: {
      center: map.colliders.stormCenter,
      radius: map.colliders.stormRadius,
      topY: map.colliders.ceilingY + 200,
    },
  });
  for (const view of [sky, lights, lighting, sea, clouds]) view.setQuality(QUALITY_PRESETS.medium);
  const look = createMapLook({ scene, sky, sea, clouds, lighting }, map);
  const state = (): Record<string, unknown> => ({
    views: fingerprint([sky.object, sea.object, ...clouds.objects, lighting.object, ...lighting.object.children]),
    shared: sharedLight(),
    fog: [(scene.fog as FogExp2).color.toArray(), (scene.fog as FogExp2).density],
    sun: [lights.sun.color.toArray(), lights.sun.position.toArray(), lights.sun.intensity],
    hemisphere: [lights.hemisphere.color.toArray(), lights.hemisphere.groundColor.toArray()],
    shafts: lighting.shaftCount,
  });
  const dispose = (): void => {
    sky.dispose();
    lighting.dispose();
    lights.dispose();
    sea.dispose();
    clouds.dispose();
  };
  return { scene, lights, lighting, look, state, dispose };
}

describe('skyLookOf', () => {
  it('a sky that names no colours is the first map, as it was painted', () => {
    expect(skyLookOf(SPIRES.sky)).toEqual(GOLDEN_HOUR_LOOK);
    expect(GOLDEN_HOUR_LOOK.horizonSun).toBe(SKY_CREAM);
    expect(GOLDEN_HOUR_LOOK.zenith).toBe(SKY_DUSK_VIOLET);
    expect(GOLDEN_HOUR_LOOK.hemisphereSky).toBe(HEMISPHERE_SKY_COLOR);
    expect(GOLDEN_HOUR_LOOK.hemisphereGround).toBe(HEMISPHERE_GROUND_COLOR);
    expect(GOLDEN_HOUR_LOOK.stone).toBe(WORLD_STONE_COLOR);
    expect(GOLDEN_HOUR_LOOK.moss).toBe(WORLD_MOSS_COLOR);
    expect(GOLDEN_HOUR_LOOK.stoneSaturation).toBe(WORLD_STONE_SATURATION);
    expect(GOLDEN_HOUR_LOOK.glowGain).toBe(WORLD_GLOW_GAIN);
    // no lava anywhere on the first map
    expect(GOLDEN_HOUR_LOOK.seaGlow).toBe(0);
    expect(GOLDEN_HOUR_LOOK.bounce).toBe(0);
  });

  it('the caldera names its own colours, and the ones it leaves out follow from them', () => {
    const sky = CALDERA.sky;
    const look = skyLookOf(sky);
    expect(look.horizonSun).toBe(sky.horizonColor);
    expect(look.zenith).toBe(sky.zenithColor);
    expect(look.midAway).toBe(sky.midSkyColor);
    expect(look.hemisphereSky).toBe(sky.hemisphereSkyColor);
    expect(look.seaDeep).toBe(sky.seaDeepColor);
    expect(look.seaGlow).toBe(sky.seaGlowColor);
    expect(look.bounce).toBe(sky.bounceColor);
    expect(look.stone).toBe(sky.stoneColor);
    expect(look.moss).toBe(sky.ashColor);
    expect(look.stoneSaturation).toBe(1);
    expect(look.glowGain).toBe(sky.glowGain);
    // away from the sun the horizon sinks toward the fog
    expect(look.horizonAway).toBe(mixHex(sky.horizonColor ?? 0, sky.fogColor, 0.62));
    for (const value of Object.values(look)) expect(Number.isFinite(value)).toBe(true);
  });

  it('mixes per channel and clamps the weight', () => {
    expect(mixHex(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mixHex(0x102030, 0x405060, 0)).toBe(0x102030);
    expect(mixHex(0x102030, 0x405060, 1)).toBe(0x405060);
    expect(mixHex(0x102030, 0x405060, 7)).toBe(0x405060);
    expect(mixHex(0x102030, 0x405060, -1)).toBe(0x102030);
  });
});

describe('createMapLook', () => {
  it('repaints every view for the caldera and restores the first map exactly', () => {
    const rig = buildScene();
    const golden = rig.state();
    expect(rig.look.mapId).toBe(SPIRES.id);
    expect(rig.lighting.shaftCount).toBeGreaterThan(0);

    rig.look.use(CALDERA);
    expect(rig.look.mapId).toBe(CALDERA.id);
    const dusk = rig.state();
    expect(dusk).not.toEqual(golden);
    // the lights are the recipe's: orange sun 12 degrees up, violet sky over a brown ground
    expect(rig.lights.sun.color.getHex()).toBe(CALDERA.sky.sunColor);
    expect(rig.lights.hemisphere.color.getHex()).toBe(CALDERA.sky.hemisphereSkyColor);
    expect(rig.lights.hemisphere.groundColor.getHex()).toBe(CALDERA.sky.hemisphereGroundColor);
    expect(WORLD_LIGHT.uWlSunDir.value.y).toBeCloseTo(Math.sin((12 * Math.PI) / 180), 5);
    expect(WORLD_LIGHT.uWlFogParams.value.x).toBe(CALDERA.sky.fogDensity);
    expect(POST_SETTINGS.sunDirection.toArray()).toEqual(WORLD_LIGHT.uWlSunDir.value.toArray());
    expect((rig.scene.fog as FogExp2).density).toBe(CALDERA.sky.fogDensity);
    // its accent is the glow from below, not shafts of sun
    expect(rig.lighting.shaftCount).toBe(0);
    // a preset change while the caldera is up does not bring the shafts back
    rig.lighting.setQuality(QUALITY_PRESETS.high);
    expect(rig.lighting.shaftCount).toBe(0);
    rig.lighting.setQuality(QUALITY_PRESETS.medium);

    // the same map again writes nothing
    rig.look.use(CALDERA);
    expect(rig.state()).toEqual(dusk);

    rig.look.use(SPIRES);
    expect(rig.look.mapId).toBe(SPIRES.id);
    expect(rig.state()).toEqual(golden);
    rig.dispose();
  });
});

describe('texturesForMap', () => {
  const list = (
    JSON.parse(readFileSync('public/assets/textures/textures.json', 'utf8')) as {
      textures: MapTexture[];
    }
  ).textures;
  const slots = ['stone', 'cliff', 'moss', 'masonry', 'brush'];

  it('the shipped list has both maps in it', () => {
    expect(list.map((texture) => texture.id).sort()).toEqual(
      ['ash', 'basalt', 'brush', 'cliff', 'columnar', 'masonry', 'moss', 'stone'].sort(),
    );
  });

  it('gives the first map its own five tiles and none of the caldera', () => {
    const picked = texturesForMap(list, SPIRES.id);
    expect(picked.map((texture) => texture.id).sort()).toEqual([...slots].sort());
    expect(picked.map(textureSlotOf).sort()).toEqual([...slots].sort());
  });

  it('gives the caldera basalt, columnar and ash in the stone, cliff and moss slots', () => {
    const picked = texturesForMap(list, CALDERA.id);
    expect(picked.map(textureSlotOf).sort()).toEqual([...slots].sort());
    const bySlot = new Map(picked.map((texture) => [textureSlotOf(texture), texture.id]));
    expect(bySlot.get('stone')).toBe('basalt');
    expect(bySlot.get('cliff')).toBe('columnar');
    expect(bySlot.get('moss')).toBe('ash');
    expect(bySlot.get('masonry')).toBe('masonry');
    expect(bySlot.get('brush')).toBe('brush');
    // and it never downloads the first map's slate, strata or moss
    expect(picked.some((texture) => ['stone', 'cliff', 'moss'].includes(texture.id))).toBe(false);
  });

  it('the loaded bundle is keyed by slot, so every reader asks for "stone"', async () => {
    const loaded: string[] = [];
    const bundle = await collectMapAssets(
      { ...CALDERA, props: [] },
      {
        loadAsset: () => Promise.reject(new Error('no props in this test')),
        loadTextureList: () => Promise.resolve(list),
        loadTexture: (info) => {
          loaded.push(info.id);
          return Promise.resolve({ info, texture: new DataTexture(new Uint8Array(4), 1, 1) });
        },
      },
    );
    expect(loaded.sort()).toEqual(['ash', 'basalt', 'brush', 'columnar', 'masonry']);
    expect([...bundle.textures.keys()].sort()).toEqual([...slots].sort());
    expect(bundle.textures.get('stone')?.info.id).toBe('basalt');
    expect(bundle.textures.get('moss')?.info.id).toBe('ash');
    expect(bundle.textures.get('cliff')?.info.id).toBe('columnar');
  });

  it('a list already made for one map (a baked manifest) passes through unchanged', () => {
    const baked = texturesForMap(list, CALDERA.id).map(({ map: _map, ...rest }) => rest);
    expect(texturesForMap(baked, CALDERA.id)).toEqual(baked);
  });
});
