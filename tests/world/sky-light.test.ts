import {
  Color,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  ShaderChunk,
  ShaderLib,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { POST_SETTINGS, srgbDecode, tonemapFilmic } from '../../src/render/post';
import { DRAGON_FLAG_ALIVE, DRAGON_FLAG_VEILED, QUALITY_PRESETS } from '../../src/shared';
import type { DragonView } from '../../src/shared';
import {
  DRAGON_BLOB_RADIUS,
  LIGHT_SHAFT_COUNTS,
  LIGHT_SHAFT_MAX,
  LIGHT_SHAFT_RENDER_ORDER,
  LIGHT_SHAFT_STRIDE,
  MAX_SHADOW_BLOBS,
  SEA_HAZE_HEIGHT,
  SUN_LIGHT_ANCHOR,
  WORLD_LIGHT,
  WORLD_LIGHT_FOG_PARS_FRAGMENT,
  WORLD_LIGHT_PARS_FRAGMENT,
  blobShadow,
  createHazeUniforms,
  createLightShafts,
  createWorldLighting,
  fogFactor,
  hazeGlow,
  patchWorldLightShader,
  placeLightShafts,
  setPaintedColor,
  setWorldLightShadowMode,
  shadowPlanFor,
  snapShadowFocus,
  trackedWorldLightMaterials,
  useWorldLight,
  worldLightShadowMode,
  worldLightUniforms,
} from '../../src/world/light';
import {
  CLOUD_RENDER_ORDER_BASE,
  createCloudBillboards,
  cloudFieldFromMap,
} from '../../src/world/clouds';
import { createGreyboxSpires } from '../../src/shared';
import { GOLDEN_HOUR_SKY, createSkyFog, createSkyLights, fogOpacityAt } from '../../src/world/sky';

const SUN = GOLDEN_HOUR_SKY.sunDirection;

/** Uniform names a GLSL source declares (arrays and precision qualifiers included). */
function declaredUniforms(glsl: string): string[] {
  const names = new Set<string>();
  for (const match of glsl.matchAll(/uniform\s+(?:highp\s+)?\w+\s+(\w+)\s*(?:\[\w+\])?\s*;/g)) {
    names.add(match[1] ?? '');
  }
  return [...names].sort();
}

afterEach(() => {
  setWorldLightShadowMode('none');
});

describe('painted colours', () => {
  it('come out of the tone curve as the hex that was asked for', () => {
    for (const hex of [0xe9d9c0, 0xf2b984, 0x5b4c7a, 0x101010]) {
      const c = setPaintedColor(new Color(), hex);
      expect(tonemapFilmic(c.r)).toBeCloseTo(srgbDecode(((hex >> 16) & 0xff) / 255), 6);
      expect(tonemapFilmic(c.g)).toBeCloseTo(srgbDecode(((hex >> 8) & 0xff) / 255), 6);
      expect(tonemapFilmic(c.b)).toBeCloseTo(srgbDecode((hex & 0xff) / 255), 6);
    }
    const base = setPaintedColor(new Color(), 0x808080);
    expect(setPaintedColor(new Color(), 0x808080, 2).r).toBeCloseTo(base.r * 2, 12);
  });
});

describe('haze', () => {
  it('adds sun glow only toward the sun', () => {
    expect(hazeGlow(-0.5)).toBe(0);
    expect(hazeGlow(0)).toBe(0);
    expect(hazeGlow(1)).toBeGreaterThan(hazeGlow(0.9));
    expect(hazeGlow(0.9)).toBeGreaterThan(hazeGlow(0.3));
    // Small next to the fog colour itself: the horizon must not blow out toward the sun.
    expect(hazeGlow(1)).toBeLessThan(0.4);
  });

  it('is three.js exp2 fog away from the sea and thicker down on it', () => {
    const density = GOLDEN_HOUR_SKY.fogDensity;
    for (const distance of [0, 100, 600, 1500]) {
      expect(fogFactor(density, distance, SEA_HAZE_HEIGHT + 1)).toBeCloseTo(
        fogOpacityAt(density, distance),
        12,
      );
      expect(fogFactor(density, distance, 0)).toBeGreaterThanOrEqual(
        fogOpacityAt(density, distance),
      );
    }
    // The sea haze needs distance: nothing right in front of the camera.
    expect(fogFactor(density, 0, 0)).toBe(0);
    expect(fogFactor(density, 400, 0)).toBeGreaterThan(fogFactor(density, 400, 60));
    expect(fogFactor(density, 5000, 0)).toBeLessThanOrEqual(1);
  });

  it('builds private haze uniforms that match the scene fog', () => {
    const map = createGreyboxSpires();
    const haze = createHazeUniforms(map.sky, 12);
    expect(Object.keys(haze).sort()).toEqual(declaredUniforms(WORLD_LIGHT_FOG_PARS_FRAGMENT));
    expect((haze['uWlFogColor']?.value as Color).equals(createSkyFog(map.sky).color)).toBe(true);
    const params = haze['uWlFogParams']?.value as Vector4;
    expect(params.x).toBe(map.sky.fogDensity);
    expect(params.y).toBe(12);
    expect((haze['uWlSunDir']?.value as Vector3).length()).toBeCloseTo(1, 6);
  });
});

describe('shared uniforms and GLSL', () => {
  it('declares exactly the shared uniforms', () => {
    // WL_SHADOW_MAP and WL_BLOBS blocks included: the regex does not evaluate #ifdef.
    expect(declaredUniforms(WORLD_LIGHT_PARS_FRAGMENT)).toEqual(Object.keys(WORLD_LIGHT).sort());
    expect(WORLD_LIGHT.uWlBlobs.value.length).toBe(MAX_SHADOW_BLOBS);
    expect(WORLD_LIGHT.uWlShadowMatrix.value).toBeInstanceOf(Matrix4);
  });

  it('hands out the same uniform objects every time', () => {
    const a = worldLightUniforms();
    const b = worldLightUniforms();
    expect(a).not.toBe(b);
    for (const name of Object.keys(WORLD_LIGHT)) expect(a[name]).toBe(b[name]);
    expect(a['uWlSunDir']).toBe(WORLD_LIGHT.uWlSunDir);
  });

  it('offers the documented functions', () => {
    for (const fn of [
      'vec3 wlHaze(vec3 viewDir)',
      'float wlFogFactor(vec3 worldPos, float dist)',
      'vec3 wlApplyFog(vec3 color, vec3 worldPos)',
      'float wlSunVisibility(vec3 worldPos, vec3 worldNormal)',
      'vec3 wlAmbient(vec3 worldNormal)',
      'vec3 wlRim(vec3 worldNormal, vec3 toCamera)',
      'vec3 wlDiffuse(vec3 albedo, vec3 worldPos, vec3 worldNormal)',
    ]) {
      expect(WORLD_LIGHT_PARS_FRAGMENT).toContain(fn);
    }
  });
});

describe('useWorldLight', () => {
  it('patches a built-in lit material at the sun light, the fog and the vertex stage', () => {
    // If a three.js upgrade renames this statement the shadow silently disappears: fail here.
    expect(ShaderChunk.lights_fragment_begin).toContain(SUN_LIGHT_ANCHOR);
    const lib = ShaderLib.standard;
    const patched = patchWorldLightShader(lib.vertexShader, lib.fragmentShader, 0.5);
    expect(patched.vertexShader).toContain('varying vec3 vWlWorldPos;');
    expect(patched.vertexShader).toContain('vWlWorldPos = ( modelMatrix * wlWorld ).xyz;');
    expect(patched.fragmentShader).toContain('directLight.color *= wlVisibility;');
    expect(patched.fragmentShader).toContain('wlApplyFog( gl_FragColor.rgb, vWlWorldPos )');
    expect(patched.fragmentShader).toContain('wlRim( wlNormal');
    expect(patched.fragmentShader).not.toContain('#include <fog_fragment>');
    expect(patched.fragmentShader).not.toContain('#include <lights_fragment_begin>');
    const noRim = patchWorldLightShader(lib.vertexShader, lib.fragmentShader, 0);
    expect(noRim.fragmentShader).not.toContain('wlRim( wlNormal');
    // An unlit material has no light loop: it only gets the fog.
    const basic = patchWorldLightShader(
      ShaderLib.basic.vertexShader,
      ShaderLib.basic.fragmentShader,
      0,
    );
    expect(basic.fragmentShader).toContain('wlApplyFog');
    expect(basic.fragmentShader).not.toContain('wlVisibility');
  });

  it('gives a ShaderMaterial the shared uniform objects and the preset define', () => {
    const before = trackedWorldLightMaterials();
    const material = useWorldLight(new ShaderMaterial({ uniforms: { uMine: { value: 1 } } }));
    expect(material.uniforms['uWlSunColor']).toBe(WORLD_LIGHT.uWlSunColor);
    expect(material.uniforms['uMine']?.value).toBe(1);
    expect(trackedWorldLightMaterials()).toBe(before + 1);
    expect('WL_SHADOW_MAP' in material.defines).toBe(false);
    expect('WL_BLOBS' in material.defines).toBe(false);

    const version = material.version;
    setWorldLightShadowMode('map');
    expect(worldLightShadowMode()).toBe('map');
    expect('WL_SHADOW_MAP' in material.defines).toBe(true);
    expect(material.version).toBeGreaterThan(version);
    setWorldLightShadowMode('blobs');
    expect('WL_SHADOW_MAP' in material.defines).toBe(false);
    expect(material.defines['WL_BLOBS']).toBe(MAX_SHADOW_BLOBS);
    const settled = material.version;
    setWorldLightShadowMode('blobs');
    expect(material.version).toBe(settled);

    // A material hooked up later starts in the current mode.
    const late = useWorldLight(new MeshStandardMaterial());
    expect((late.defines as Record<string, unknown>)['WL_BLOBS']).toBe(MAX_SHADOW_BLOBS);
    const opted = useWorldLight(new MeshStandardMaterial(), { shadows: false });
    expect('WL_BLOBS' in (opted.defines as Record<string, unknown>)).toBe(false);

    material.dispose();
    late.dispose();
    opted.dispose();
    expect(trackedWorldLightMaterials()).toBe(before);
  });

  it('keeps patched programs apart from unpatched ones and from other rim strengths', () => {
    const plain = new MeshStandardMaterial();
    const a = useWorldLight(new MeshStandardMaterial());
    const b = useWorldLight(new MeshStandardMaterial(), { rim: 1 });
    const c = useWorldLight(new MeshBasicMaterial());
    expect(a.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
    expect(typeof c.onBeforeCompile).toBe('function');
    // Calling it again changes the options without stacking a second patch.
    const hook = a.onBeforeCompile;
    useWorldLight(a, { rim: 1 });
    expect(a.onBeforeCompile).toBe(hook);
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    for (const m of [plain, a, b, c]) m.dispose();
  });
});

describe('shadow strategy', () => {
  it('uses blobs on Low, a dragon-range map on Medium and a wider one on High', () => {
    const low = shadowPlanFor(QUALITY_PRESETS.low);
    const medium = shadowPlanFor(QUALITY_PRESETS.medium);
    const high = shadowPlanFor(QUALITY_PRESETS.high);
    expect(low).toEqual({ mode: 'blobs', mapSize: 0, range: 0, focusDistance: 0 });
    expect(medium.mode).toBe('map');
    expect(medium.mapSize).toBe(1024);
    expect(high.mapSize).toBe(2048);
    expect(high.range).toBeGreaterThan(medium.range);
    // Texel size on the receiver stays under 10 cm on both.
    expect((medium.range * 2) / medium.mapSize).toBeLessThan(0.1);
    expect((high.range * 2) / high.mapSize).toBeLessThan(0.1);
    // The local dragon (about 14 m ahead of the chase camera) is well inside the map.
    expect(medium.range - medium.focusDistance).toBeGreaterThan(14);
  });

  it('snaps the shadow focus to the texel grid across the sun direction', () => {
    const texel = 0.07;
    const right = new Vector3(0, 1, 0).cross(new Vector3(SUN.x, SUN.y, SUN.z)).normalize();
    const top = new Vector3(SUN.x, SUN.y, SUN.z).cross(right).normalize();
    for (const start of [new Vector3(12.34, 240.1, -77.7), new Vector3(-900.02, 31, 4.44)]) {
      const snapped = snapShadowFocus(start.clone(), SUN, texel);
      expect(snapped.distanceTo(start)).toBeLessThan(texel);
      const u = snapped.dot(right) / texel;
      const v = snapped.dot(top) / texel;
      expect(Math.abs(u - Math.round(u))).toBeLessThan(1e-6);
      expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-6);
      // Already on the grid: stays put.
      expect(snapShadowFocus(snapped.clone(), SUN, texel).distanceTo(snapped)).toBeLessThan(1e-9);
    }
    const untouched = new Vector3(1, 2, 3);
    expect(snapShadowFocus(untouched, SUN, 0)).toBe(untouched);
    expect(untouched.x).toBe(1);
  });

  it('casts a blob only down-sun of the caster and never on the caster itself', () => {
    const centre = { x: 0, y: 100, z: 0 };
    const r = DRAGON_BLOB_RADIUS;
    const along = (t: number, side = 0): { x: number; y: number; z: number } => ({
      x: centre.x - SUN.x * t,
      y: centre.y - SUN.y * t,
      z: centre.z - SUN.z * t + side,
    });
    expect(blobShadow(along(20), centre, r, SUN)).toBeGreaterThan(0.6);
    expect(blobShadow(along(0), centre, r, SUN)).toBe(0);
    expect(blobShadow(along(r * 0.5), centre, r, SUN)).toBe(0);
    expect(blobShadow(along(-20), centre, r, SUN)).toBe(0);
    expect(blobShadow(along(20, r * 3), centre, r, SUN)).toBe(0);
    // Wider and weaker with distance.
    expect(blobShadow(along(200), centre, r, SUN)).toBeLessThan(
      blobShadow(along(20), centre, r, SUN),
    );
    expect(blobShadow(along(200, r * 1.6), centre, r, SUN)).toBeGreaterThan(0);
    expect(blobShadow(along(20), centre, 0, SUN)).toBe(0);
  });
});

describe('light shafts', () => {
  const field = { center: { x: 0, y: 0, z: 0 }, radius: 1000, bottomY: 0, topY: 900 };

  it('places a deterministic set that ends on the sea inside the arena', () => {
    const placed = placeLightShafts(field, SUN, 5);
    expect(placed.length).toBe(LIGHT_SHAFT_MAX * LIGHT_SHAFT_STRIDE);
    expect(placeLightShafts(field, SUN, 5)).toEqual(placed);
    expect(placeLightShafts(field, SUN, 6)).not.toEqual(placed);
    for (let i = 0; i < LIGHT_SHAFT_MAX; i++) {
      const o = i * LIGHT_SHAFT_STRIDE;
      expect(Math.hypot(placed[o] ?? 0, placed[o + 2] ?? 0)).toBeLessThanOrEqual(field.radius);
      expect(placed[o + 1]).toBe(field.bottomY);
      expect(placed[o + 3]).toBeGreaterThan(10);
      expect(placed[o + 4]).toBeGreaterThan(500);
    }
  });

  it('is one additive draw call, off on Low and capped per preset', () => {
    const shafts = createLightShafts({ ...field, sky: GOLDEN_HOUR_SKY });
    const material = shafts.object.material;
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.depthTest).toBe(true);
    expect(shafts.object.renderOrder).toBe(LIGHT_SHAFT_RENDER_ORDER);
    expect(material.fragmentShader).not.toContain('texture2D');
    const version = material.version;
    for (const id of ['low', 'medium', 'high'] as const) {
      shafts.setQuality(QUALITY_PRESETS[id]);
      expect(shafts.activeCount).toBe(LIGHT_SHAFT_COUNTS[id]);
      expect(shafts.object.geometry.drawRange.count).toBe(LIGHT_SHAFT_COUNTS[id] * 6);
      expect(shafts.object.visible).toBe(LIGHT_SHAFT_COUNTS[id] > 0);
    }
    expect(LIGHT_SHAFT_COUNTS.low).toBe(0);
    expect(material.version).toBe(version);
    const declared = [
      ...declaredUniforms(material.vertexShader),
      ...declaredUniforms(material.fragmentShader),
    ];
    expect([...new Set(declared)].sort()).toEqual(Object.keys(material.uniforms).sort());
    shafts.dispose();
  });

  it('draws after the cloud puffs and before other transparents', () => {
    const map = createGreyboxSpires();
    const clouds = createCloudBillboards({ field: cloudFieldFromMap(map), sky: map.sky });
    expect(LIGHT_SHAFT_RENDER_ORDER).toBeGreaterThan(
      CLOUD_RENDER_ORDER_BASE + clouds.objects.length - 1,
    );
    expect(LIGHT_SHAFT_RENDER_ORDER).toBeLessThan(0);
    clouds.dispose();
  });
});

describe('world lighting', () => {
  function dragon(x: number, y: number, z: number, flags = DRAGON_FLAG_ALIVE): DragonView {
    return { position: { x, y, z }, flags } as unknown as DragonView;
  }

  it('writes the shared uniforms from the sky and the lights', () => {
    const map = createGreyboxSpires();
    const lights = createSkyLights(map.sky);
    const lighting = createWorldLighting({ sky: map.sky, lights, cloudSeaY: 7 });
    const u = WORLD_LIGHT;
    expect(u.uWlSunDir.value.x).toBeCloseTo(map.sky.sunDirection.x, 6);
    expect(u.uWlSunColor.value.r).toBeCloseTo(lights.sun.color.r * lights.sun.intensity, 12);
    expect(u.uWlHemiGround.value.g).toBeCloseTo(
      lights.hemisphere.groundColor.g * lights.hemisphere.intensity,
      12,
    );
    expect(u.uWlFogColor.value.equals(createSkyFog(map.sky).color)).toBe(true);
    expect(u.uWlFogParams.value.x).toBe(map.sky.fogDensity);
    expect(u.uWlFogParams.value.y).toBe(7);
    expect(POST_SETTINGS.sunDirection.y).toBeCloseTo(map.sky.sunDirection.y, 6);
    expect(lighting.shaftCount).toBe(0);
    expect(lighting.object.children.length).toBe(0);
    lighting.dispose();
    lights.dispose();
  });

  it('switches the sun shadow with the preset and fits it in front of the camera', () => {
    const lights = createSkyLights();
    const lighting = createWorldLighting({
      lights,
      cloudSeaY: 0,
      shafts: { center: { x: 0, y: 0, z: 0 }, radius: 1000, topY: 900 },
    });
    const camera = new PerspectiveCamera(60, 16 / 9, 0.5, 6000);
    camera.position.set(100, 250, -40);
    camera.lookAt(100, 250, 100);
    camera.updateMatrixWorld();

    lighting.setQuality(QUALITY_PRESETS.low);
    lighting.update(camera, 1);
    expect(lights.sun.castShadow).toBe(false);
    expect(worldLightShadowMode()).toBe('blobs');
    expect(WORLD_LIGHT.uWlShadowParams.value.z).toBe(0);
    expect(lighting.shaftCount).toBe(0);

    lighting.setQuality(QUALITY_PRESETS.medium);
    // Whatever else toggled the light, the lighting owns its shadow switch.
    lights.sun.castShadow = false;
    lighting.update(camera, 1);
    const plan = lighting.shadowPlan;
    expect(lights.sun.castShadow).toBe(true);
    expect(worldLightShadowMode()).toBe('map');
    expect(lights.sun.shadow.mapSize.x).toBe(1024);
    expect(lights.sun.shadow.camera.right).toBe(plan.range);
    expect(lights.sun.shadow.camera.top).toBe(plan.range);
    expect(WORLD_LIGHT.uWlShadowParams.value.x).toBeCloseTo(1 / 1024, 12);
    expect(WORLD_LIGHT.uWlShadowParams.value.z).toBe(1);
    expect(lighting.shaftCount).toBe(LIGHT_SHAFT_COUNTS.medium);

    // The point `focusDistance` ahead of the camera lands in the middle of the map...
    const matrix = WORLD_LIGHT.uWlShadowMatrix.value;
    const ahead = new Vector3(100, 250, -40 + plan.focusDistance).applyMatrix4(matrix);
    expect(ahead.x).toBeCloseTo(0.5, 2);
    expect(ahead.y).toBeCloseTo(0.5, 2);
    expect(ahead.z).toBeGreaterThan(0);
    expect(ahead.z).toBeLessThan(1);
    // ...a point just inside the range is still on it, one beyond is off.
    const side = new Vector3(100, 250, -40 + plan.focusDistance + plan.range * 0.95);
    expect(side.clone().applyMatrix4(matrix).x).toBeGreaterThan(0);
    expect(side.clone().applyMatrix4(matrix).x).toBeLessThan(1);
    const outside = new Vector3(100, 250, -40 + plan.focusDistance + plan.range * 1.1);
    const ox = outside.applyMatrix4(matrix).x;
    expect(ox < 0 || ox > 1).toBe(true);
    // A caster 200 m up-sun is inside the depth range.
    const upSun = new Vector3(100 + SUN.x * 200, 250 + SUN.y * 200, -40 + plan.focusDistance);
    const uz = upSun.applyMatrix4(matrix).z;
    expect(uz).toBeGreaterThan(0);
    expect(uz).toBeLessThan(ahead.z);

    lighting.setQuality(QUALITY_PRESETS.high);
    lighting.update(camera, 1);
    expect(lights.sun.shadow.mapSize.x).toBe(2048);
    expect(lighting.shaftCount).toBe(LIGHT_SHAFT_COUNTS.high);

    lighting.dispose();
    expect(lights.sun.castShadow).toBe(false);
    expect(WORLD_LIGHT.uWlShadowParams.value.z).toBe(0);
    lights.dispose();
  });

  it('feeds the nearest living, visible dragons to the blob shadows on Low only', () => {
    const lights = createSkyLights();
    const lighting = createWorldLighting({ lights, cloudSeaY: 0 });
    const blobs = WORLD_LIGHT.uWlBlobs.value;
    const near = { x: 0, y: 0, z: 0 };
    const dragons = [
      dragon(500, 0, 0),
      dragon(10, 0, 0),
      dragon(20, 0, 0, 0), // dead
      dragon(30, 0, 0, DRAGON_FLAG_ALIVE | DRAGON_FLAG_VEILED),
      dragon(40, 0, 0),
      dragon(50, 0, 0),
      dragon(60, 0, 0),
    ];

    lighting.setQuality(QUALITY_PRESETS.medium);
    lighting.setBlobCasters(dragons, dragons.length, near);
    expect(blobs.every((b) => b.w === 0)).toBe(true);

    lighting.setQuality(QUALITY_PRESETS.low);
    lighting.setBlobCasters(dragons, dragons.length, near);
    expect(blobs.map((b) => b.x).sort((a, b) => a - b)).toEqual([10, 40, 50, 60]);
    expect(blobs.every((b) => b.w === DRAGON_BLOB_RADIUS)).toBe(true);

    // Fewer casters than slots: the rest are switched off. `count` limits the pool.
    lighting.setBlobCasters(dragons, 2, near);
    expect(
      blobs
        .filter((b) => b.w > 0)
        .map((b) => b.x)
        .sort((a, b) => a - b),
    ).toEqual([10, 500]);
    lighting.setBlobCasters(dragons, 0, near);
    expect(blobs.every((b) => b.w === 0)).toBe(true);
    lighting.dispose();
    lights.dispose();
  });
});
