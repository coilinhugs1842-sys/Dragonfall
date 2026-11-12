/**
 * `WorldLighting`: the one object a scene creates to drive the shared lighting.
 *
 * It owns nothing visible except the light shafts. Its job is to keep three things in step
 * with the map's sky and the quality preset:
 * - the shared uniforms in ./light-uniforms.ts (sun, hemisphere, fog, shadow, blobs);
 * - the sun `DirectionalLight`'s shadow: one map fitted around a point in front of the camera
 *   (i.e. around the local dragon), snapped to its texel grid, on Medium / High only;
 * - the post pass's sun direction (sun shafts on High).
 *
 * Shadow strategy (see `shadowPlanFor`): Low draws no shadow pass and shades with up to four
 * analytic "blob" spheres fed by `setBlobCasters`; Medium fits a 1024 map over +-36 m for
 * dragons; High a 2048 map over +-80 m for everything that has `castShadow`. three.js renders
 * the map (so skinned, instanced and alpha-tested casters just work); receivers sample it
 * through `wlSunVisibility`, which fades it out at its edge.
 *
 * Per frame (`update`): a dozen float writes and one matrix product; no allocation.
 */
import { Group, Vector3 } from 'three';
import type { Camera, Object3D } from 'three';
import { POST_SETTINGS } from '../../render/post';
import { DRAGON_FLAG_ALIVE, DRAGON_FLAG_VEILED } from '../../shared';
import type { DragonView, QualityPreset, Vec3 } from '../../shared';
import type { SkyLights } from '../sky/sky-lights';
import { GOLDEN_HOUR_SKY } from '../sky/sky-math';
import type { SkySetup } from '../sky/sky-math';
import {
  MAX_SHADOW_BLOBS,
  SHADOW_CASTER_MARGIN,
  shadowPlanFor,
  snapShadowFocus,
} from './light-math';
import type { ShadowPlan } from './light-math';
import { setWorldLightShadowMode } from './light-patch';
import { fogParamsOf, fogSceneColor, glowSceneColor, sunDirectionOf } from './light-setup';
import { createLightShafts } from './light-shafts';
import type { LightShaftField, LightShafts } from './light-shafts';
import { WORLD_LIGHT } from './light-uniforms';

/** Radius in metres of the blob a dragon casts on Low (wingspan is about 14 m). */
export const DRAGON_BLOB_RADIUS = 5;
/** World-space depth offset of the shadow compare, in metres. */
const SHADOW_DEPTH_BIAS_M = 0.08;
/** The receiver is pushed along its normal by this many shadow texels. */
const SHADOW_NORMAL_BIAS_TEXELS = 1.6;

export interface WorldLightingOptions {
  /** Sun and fog; `MapManifest.sky` fits. Defaults to the golden-hour recipe. */
  readonly sky?: SkySetup;
  /** The scene's sun and hemisphere (from `createSkyLights`); the sun's shadow is driven here. */
  readonly lights: SkyLights;
  /** World Y of the cloud sea: where the sea haze lies and the shafts end. */
  readonly cloudSeaY: number;
  /** Where the light shafts stand; omit for a scene without shafts. */
  readonly shafts?: Omit<LightShaftField, 'bottomY'>;
  readonly seed?: number;
}

export interface WorldLighting {
  /** Add to the scene (holds the light shafts). */
  readonly object: Object3D;
  /** What the current preset does about shadows. */
  readonly shadowPlan: ShadowPlan;
  /** Light-shaft cards drawn at the current preset. */
  readonly shaftCount: number;
  /**
   * Once per frame, after the camera is placed: refits the shadow around the view and writes
   * the shared uniforms. `timeS` is the scene time in seconds.
   */
  update(camera: Camera, timeS: number): void;
  /**
   * Low preset: the dragons that cast blob shadows this frame (the `MAX_SHADOW_BLOBS` nearest
   * to `near` that are alive and not veiled). A no-op on the other presets.
   */
  setBlobCasters(dragons: readonly DragonView[], count: number, near: Vec3): void;
  /** Shadow mode and map size, shaft count; retargets every `useWorldLight` material. */
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

export function createWorldLighting(options: WorldLightingOptions): WorldLighting {
  const sky = options.sky ?? GOLDEN_HOUR_SKY;
  const { sun, hemisphere } = options.lights;
  const sunDir = sunDirectionOf(sky, new Vector3());
  const object = new Group();
  object.name = 'WorldLighting';

  const shafts: LightShafts | null =
    options.shafts !== undefined
      ? createLightShafts({
          ...options.shafts,
          bottomY: options.cloudSeaY,
          sky,
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
        })
      : null;
  if (shafts !== null) object.add(shafts.object);

  // --- Shared uniforms: constant for the life of this lighting ---------------------------------
  const u = WORLD_LIGHT;
  u.uWlSunDir.value.copy(sunDir);
  u.uWlSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
  u.uWlHemiSky.value.copy(hemisphere.color).multiplyScalar(hemisphere.intensity);
  u.uWlHemiGround.value.copy(hemisphere.groundColor).multiplyScalar(hemisphere.intensity);
  fogSceneColor(sky, u.uWlFogColor.value);
  glowSceneColor(sky, u.uWlGlowColor.value);
  fogParamsOf(sky, options.cloudSeaY, u.uWlFogParams.value);
  u.uWlShadowParams.value.z = 0;
  for (const blob of u.uWlBlobs.value) blob.set(0, 0, 0, 0);
  POST_SETTINGS.sunDirection.copy(sunDir);

  let plan: ShadowPlan = { mode: 'none', mapSize: 0, range: 0, focusDistance: 0 };
  const focus = new Vector3();
  const forward = new Vector3();
  /** Squared distances of the blob slots filled this frame. */
  const blobDistance = new Float32Array(MAX_SHADOW_BLOBS);

  /** Frees the sun's shadow render target; three allocates a new one when it next casts. */
  function freeShadowMap(): void {
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    u.uWlShadowMap.value = null;
  }

  function applyPlan(): void {
    setWorldLightShadowMode(plan.mode);
    const params = u.uWlShadowParams.value;
    if (plan.mode !== 'map') {
      sun.castShadow = false;
      params.z = 0;
      // Nothing samples the map any more: on a switch down to Low a 1024 or 2048 depth target
      // would otherwise stay allocated for the rest of the session.
      freeShadowMap();
      return;
    }
    const shadow = sun.shadow;
    if (shadow.mapSize.x !== plan.mapSize) {
      shadow.mapSize.set(plan.mapSize, plan.mapSize);
      // The map is allocated lazily at its first size; drop it so the new size takes effect.
      shadow.map?.dispose();
      shadow.map = null;
    }
    const camera = shadow.camera;
    camera.left = -plan.range;
    camera.right = plan.range;
    camera.top = plan.range;
    camera.bottom = -plan.range;
    camera.near = 1;
    camera.far = plan.range * 2 + SHADOW_CASTER_MARGIN;
    camera.updateProjectionMatrix();
    // The compare bias is ours (in the receiver); three's own would only add to it.
    shadow.bias = 0;
    shadow.normalBias = 0;
    const texelWorld = (plan.range * 2) / plan.mapSize;
    params.set(
      1 / plan.mapSize,
      texelWorld * SHADOW_NORMAL_BIAS_TEXELS,
      1,
      SHADOW_DEPTH_BIAS_M / (camera.far - camera.near),
    );
    sun.castShadow = true;
  }

  return {
    object,
    get shadowPlan(): ShadowPlan {
      return plan;
    },
    get shaftCount(): number {
      return shafts === null ? 0 : shafts.activeCount;
    },

    update(camera: Camera, timeS: number): void {
      shafts?.update(timeS);
      if (plan.mode !== 'map') {
        // Something else (SkyLights.setQuality) may have switched the light's shadow back on.
        if (sun.castShadow) sun.castShadow = false;
        return;
      }
      if (!sun.castShadow) sun.castShadow = true;
      const e = camera.matrixWorld.elements;
      camera.getWorldDirection(forward);
      focus.set(
        (e[12] ?? 0) + forward.x * plan.focusDistance,
        (e[13] ?? 0) + forward.y * plan.focusDistance,
        (e[14] ?? 0) + forward.z * plan.focusDistance,
      );
      snapShadowFocus(focus, sunDir, (plan.range * 2) / plan.mapSize);
      const back = plan.range + SHADOW_CASTER_MARGIN;
      sun.target.position.copy(focus);
      sun.position.set(
        focus.x + sunDir.x * back,
        focus.y + sunDir.y * back,
        focus.z + sunDir.z * back,
      );
      // The target is not in the scene graph, and the matrices are needed before the render.
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();
      sun.shadow.updateMatrices(sun);
      u.uWlShadowMatrix.value.copy(sun.shadow.matrix);
      // Null until three has rendered the map once; the shader then reads an empty texture.
      u.uWlShadowMap.value = sun.shadow.map?.depthTexture ?? null;
    },

    setBlobCasters(dragons: readonly DragonView[], count: number, near: Vec3): void {
      if (plan.mode !== 'blobs') return;
      const blobs = u.uWlBlobs.value;
      let used = 0;
      for (let i = 0; i < count; i++) {
        const dragon = dragons[i];
        if (dragon === undefined) continue;
        if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0 || (dragon.flags & DRAGON_FLAG_VEILED) !== 0) {
          continue;
        }
        const p = dragon.position;
        const dx = p.x - near.x;
        const dy = p.y - near.y;
        const dz = p.z - near.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        // Insertion into the (tiny) sorted list of the nearest casters.
        let slot = used < MAX_SHADOW_BLOBS ? used : -1;
        if (slot < 0) {
          let worst = 0;
          for (let k = 1; k < MAX_SHADOW_BLOBS; k++) {
            if ((blobDistance[k] ?? 0) > (blobDistance[worst] ?? 0)) worst = k;
          }
          if (d2 < (blobDistance[worst] ?? 0)) slot = worst;
        } else {
          used++;
        }
        if (slot < 0) continue;
        blobDistance[slot] = d2;
        blobs[slot]?.set(p.x, p.y, p.z, DRAGON_BLOB_RADIUS);
      }
      for (let k = used; k < MAX_SHADOW_BLOBS; k++) blobs[k]?.set(0, 0, 0, 0);
    },

    setQuality(preset: QualityPreset): void {
      plan = shadowPlanFor(preset);
      applyPlan();
      shafts?.setQuality(preset);
    },

    dispose(): void {
      shafts?.dispose();
      object.clear();
      sun.castShadow = false;
      u.uWlShadowParams.value.z = 0;
      freeShadowMap();
      for (const blob of u.uWlBlobs.value) blob.set(0, 0, 0, 0);
    },
  };
}
