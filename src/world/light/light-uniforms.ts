/**
 * The shared world-light uniforms: ONE set of uniform objects for the whole app. Every material
 * that includes the chunk in ./light-glsl.ts references these same `{ value }` objects, so the
 * lighting is written once per frame (by `WorldLighting`) and every material sees it.
 *
 * Module-level on purpose: the app has one renderer and one stage at a time, and a material
 * built by the map or dragon code must not need the stage handed to it.
 */
import { Color, Matrix4, Vector3, Vector4 } from 'three';
import type { IUniform, Texture } from 'three';
import { MAX_SHADOW_BLOBS } from './light-math';

export interface WorldLightUniforms {
  /** Unit vector toward the sun, world space. */
  readonly uWlSunDir: IUniform<Vector3>;
  /** Linear sun colour * intensity: the same units as three's DirectionalLight. */
  readonly uWlSunColor: IUniform<Color>;
  /** Linear hemisphere colours * intensity. */
  readonly uWlHemiSky: IUniform<Color>;
  readonly uWlHemiGround: IUniform<Color>;
  /** Scene-linear fog colour; equal to `scene.fog.color`. */
  readonly uWlFogColor: IUniform<Color>;
  /** Sun in-scatter colour the fog gains toward the sun. */
  readonly uWlGlowColor: IUniform<Color>;
  /** x: exp2 fog density, y: cloud-sea Y, z: unused, w: sea-haze scale 0..1. */
  readonly uWlFogParams: IUniform<Vector4>;
  /** The sun's shadow depth texture (comparison sampler), or null before the first frame. */
  readonly uWlShadowMap: IUniform<Texture | null>;
  /** World -> shadow uv + depth. */
  readonly uWlShadowMatrix: IUniform<Matrix4>;
  /** x: 1 / map size, y: normal offset (m), z: strength (0 = off), w: depth bias. */
  readonly uWlShadowParams: IUniform<Vector4>;
  /** `MAX_SHADOW_BLOBS` spheres: xyz centre, w radius (0 = unused). */
  readonly uWlBlobs: IUniform<Vector4[]>;
  readonly uWlBlobStrength: IUniform<number>;
}

function createBlobs(): Vector4[] {
  const blobs: Vector4[] = [];
  for (let i = 0; i < MAX_SHADOW_BLOBS; i++) blobs.push(new Vector4(0, 0, 0, 0));
  return blobs;
}

/**
 * Defaults are the golden-hour recipe with no shadow, so a material shows something sensible
 * even in a scene that never creates a `WorldLighting` (dev previews, tests).
 */
export const WORLD_LIGHT: WorldLightUniforms = {
  uWlSunDir: { value: new Vector3(0.951, 0.309, 0) },
  uWlSunColor: { value: new Color(3.0, 2.1, 1.1) },
  uWlHemiSky: { value: new Color(0.35, 0.47, 0.69) },
  uWlHemiGround: { value: new Color(0.05, 0.1, 0.09) },
  uWlFogColor: { value: new Color(1.0, 0.74, 0.48) },
  uWlGlowColor: { value: new Color(1.0, 0.6, 0.25) },
  uWlFogParams: { value: new Vector4(0.00165, 0, 0, 1) },
  uWlShadowMap: { value: null },
  uWlShadowMatrix: { value: new Matrix4() },
  uWlShadowParams: { value: new Vector4(1 / 1024, 0.05, 0, 0.0008) },
  uWlBlobs: { value: createBlobs() },
  uWlBlobStrength: { value: 0.55 },
};

/**
 * The shared uniform objects as a map to spread into `ShaderMaterial.uniforms`:
 * `uniforms: { ...worldLightUniforms(), uMine: { value: 1 } }`. Never clone the result
 * (`UniformsUtils.clone` would cut the material off from the shared values).
 */
export function worldLightUniforms(): Record<string, IUniform> {
  return { ...WORLD_LIGHT };
}
