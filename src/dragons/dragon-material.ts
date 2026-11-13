/**
 * The dragon material: one ShaderMaterial program for every class, LOD and dragon.
 *
 * LOOK (docs/ART_DIRECTION.md): the atlas already carries painted light, occlusion and scales,
 * so the shader lights it softly (a wrapped sun term + the hemisphere, from the shared world
 * lighting) and spends its effort on SILHOUETTE: a strong warm rim on the sun side, a cool sky
 * rim opposite, and back-lit wing membranes. Team colour is emissive only, on the membrane and
 * rune slots through the emissive mask (the cloak is part of the membrane slot).
 *
 * QUALITY (`DRAGON_QUALITY` define, set by `setDragonMaterialQuality`):
 *   0 Low     lighting per VERTEX (sun half-Lambert + hemisphere), one rim term, no shadow
 *             lookup. Two texture fetches per pixel. The hit flash is the rim alone.
 *   1 Medium  per-pixel wrapped sun with the shared sun shadow, warm + cool rim, back-lit
 *             membranes.
 *   2 High    Medium plus a soft specular sheen on the hide.
 *
 * PER-DRAGON STATE is four vec4 uniforms (team colour, effects); every dragon has its own
 * material object but they all compile to the same program.
 *
 * `aParams` per vertex (see dragon-assets.ts): x = membrane slot, y = rune slot, z = cloak
 * flutter weight (0 at the shoulders .. 1 at the free end).
 */

import { Color, DoubleSide, ShaderMaterial, Vector4 } from 'three';
import type { IUniform, Texture } from 'three';
import type { QualityPresetId } from '../shared';
import { WORLD_LIGHT_PARS_FRAGMENT, useWorldLight } from '../world/light';

/** Emissive strength of the team colour on membranes and runes at rest (scene-linear). */
export const MEMBRANE_GLOW = 0.55;
export const RUNE_GLOW = 3.2;

const VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>

attribute vec4 aParams;

uniform vec4 uMotion; // x: time (s), y: flutter strength 0..1, z: per-dragon phase

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vSlot;

#if DRAGON_QUALITY == 0
  uniform vec3 uWlSunDir;
  uniform vec3 uWlSunColor;
  uniform vec3 uWlHemiSky;
  uniform vec3 uWlHemiGround;
  varying vec3 vLight;
#endif

void main() {
  vUv = uv;
  vSlot = aParams.xy;

  vec3 objectNormal = normal;
  vec3 transformed = position;

  // Cloak: a travelling wave from the shoulders to the free end, in the bind pose.
  float flutter = aParams.z * aParams.z * uMotion.y;
  if (flutter > 0.0) {
    float wave = uMotion.x * 9.0 + uMotion.z - aParams.z * 5.5 + position.x * 2.4;
    transformed.y += sin(wave) * flutter * 0.2;
    transformed.x += cos(wave * 0.63 + 1.3) * flutter * 0.1;
  }

  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <skinning_vertex>

  vec4 world = modelMatrix * vec4(transformed, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);

  #if DRAGON_QUALITY == 0
    float halfLambert = dot(vWorldNormal, uWlSunDir) * 0.5 + 0.5;
    vLight = (uWlSunColor * (halfLambert * halfLambert * 0.8)
            + mix(uWlHemiGround, uWlHemiSky, vWorldNormal.y * 0.5 + 0.5) * 1.05) * 0.3183;
  #endif

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uBaseMap;
uniform sampler2D uEmissiveMap;
uniform vec4 uTeam;     // rgb: linear team colour, a: unused
uniform vec4 uTeamGlow; // rgb: the lighter glow colour, a: unused
uniform vec4 uFx;       // x: membrane glow, y: rune glow, z: hit flash 0..1, w: fade 1 = solid
uniform vec4 uFx2;      // x: low health 0..1, y: shield 0..1, z: spawn protection 0..1, w: time
uniform vec3 uDebug;    // x: 1 = show slots

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vSlot;
#if DRAGON_QUALITY == 0
  varying vec3 vLight;
#endif

${WORLD_LIGHT_PARS_FRAGMENT}

// The hit flash's colour: a hot ember, scene-linear. Warm for both teams (it says "struck", and
// the team colour is already on the wings).
const vec3 HIT_TINT = vec3(1.0, 0.44, 0.13);

void main() {
  if (uFx.w < 0.999) {
    // Interleaved gradient noise: a stable, evenly spread screen-door pattern (veil, phase).
    float dither = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
    if (dither > uFx.w) discard;
  }

  vec3 base = texture2D(uBaseMap, vUv).rgb;
  float mask = texture2D(uEmissiveMap, vUv).r;
  float membrane = vSlot.x;
  float runes = vSlot.y;

  // Badly hurt: the hide greys and darkens.
  float luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
  base = mix(base, vec3(luma) * 0.5, uFx2.x * 0.65);

  vec3 N = normalize(vWorldNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 toCamera = cameraPosition - vWorldPos;
  vec3 V = toCamera / max(length(toCamera), 1e-3);
  float fresnel = 1.0 - max(dot(N, V), 0.0);
  float fresnel3 = fresnel * fresnel * fresnel;
  float nl = dot(N, uWlSunDir);
  float sunSide = nl * 0.5 + 0.5;

  #if DRAGON_QUALITY == 0
    vec3 color = base * vLight;
    color += (base * 0.7 + 0.05) * uWlSunColor * (fresnel3 * sunSide * 0.5);
  #else
    // The membranes are thin and double-sided: a shadow lookup on them is mostly acne.
    float visibility = mix(wlSunVisibility(vWorldPos, N), 1.0, membrane);
    float lit = smoothstep(-0.15, 0.7, nl);
    vec3 irradiance = uWlSunColor * (lit * visibility * 0.8) + wlAmbient(N) * 1.05;
    // Sun through a wing seen from its shadow side.
    irradiance += uWlSunColor * (membrane * max(-nl, 0.0) * 0.55);
    vec3 color = base * irradiance * 0.3183;

    // Silhouette: warm rim toward the sun, cool sky rim away from it.
    vec3 rimTint = base * 0.75 + 0.06;
    color += rimTint * uWlSunColor * (fresnel3 * sunSide * sunSide * 0.85 * (0.35 + 0.65 * visibility));
    float fresnel2 = fresnel * fresnel;
    color += rimTint * uWlHemiSky * (fresnel2 * (1.0 - sunSide) * 1.1);

    #if DRAGON_QUALITY == 2
      vec3 H = normalize(uWlSunDir + V);
      float sheen = pow(max(dot(N, H), 0.0), 22.0) * (1.0 - membrane) * visibility;
      color += uWlSunColor * (sheen * 0.05) * (0.4 + luma * 2.0);
    #endif
  #endif

  // Team accent: emissive through the mask, on the membrane and rune slots only.
  float glow = mask * (membrane * uFx.x + runes * uFx.y);
  color += uTeam.rgb * glow;

  // Wing shield: a team-coloured edge glow (the shell itself is a vfx mesh).
  color += uTeamGlow.rgb * (uFx2.y * (0.004 + fresnel3 * fresnel * 0.5));
  // Spawn protection: pale bands sweeping up the body.
  if (uFx2.z > 0.0) {
    float band = 0.5 + 0.5 * sin(vWorldPos.y * 2.2 - uFx2.w * 7.0);
    color = mix(color, color * 0.8 + vec3(0.95, 0.97, 1.0) * (0.012 + fresnel3 * 0.7), uFx2.z * (0.3 + 0.6 * band * band));
  }
  // Hit flash (strength and timing: hit-flash.ts). An impact, never a fill: the lit, painted
  // colour stays under it, and the heat sits on the silhouette the camera sees.
  if (uFx.z > 0.0) {
    // A wing seen edge-on is one large grazing surface: it takes less rim than the body.
    float hitRim = uFx.z * (1.0 - 0.6 * membrane);
    #if DRAGON_QUALITY == 0
      color += HIT_TINT * (uFx.z * 0.03 + hitRim * fresnel3 * 1.3);
    #else
      color = color * (1.0 + uFx.z * 0.5)
        + HIT_TINT * (uFx.z * 0.02 + hitRim * (fresnel2 * 0.3 + fresnel3 * 0.9));
    #endif
  }

  if (uDebug.x > 0.5) color = vec3(membrane, runes, mask) * 0.8 + base * 0.2;

  gl_FragColor = vec4(wlApplyFog(color, vWorldPos), 1.0);
}
`;

const QUALITY_LEVEL: Readonly<Record<QualityPresetId, number>> = { low: 0, medium: 1, high: 2 };

/** The per-dragon uniforms, typed. `material.uniforms` holds these same objects. */
export interface DragonUniforms {
  readonly uBaseMap: IUniform<Texture | null>;
  readonly uEmissiveMap: IUniform<Texture | null>;
  readonly uTeam: IUniform<Vector4>;
  readonly uTeamGlow: IUniform<Vector4>;
  readonly uFx: IUniform<Vector4>;
  readonly uFx2: IUniform<Vector4>;
  readonly uMotion: IUniform<Vector4>;
  readonly uDebug: IUniform<Color>;
}

export interface DragonMaterial {
  readonly material: ShaderMaterial;
  readonly uniforms: DragonUniforms;
}

/** Load-time: one per rig. All of them share one compiled program per quality level. */
export function createDragonMaterial(
  baseMap: Texture,
  emissiveMap: Texture,
  quality: QualityPresetId,
): DragonMaterial {
  const uniforms: DragonUniforms = {
    uBaseMap: { value: baseMap },
    uEmissiveMap: { value: emissiveMap },
    uTeam: { value: new Vector4(1, 0.2, 0.02, 1) },
    uTeamGlow: { value: new Vector4(1, 0.45, 0.1, 1) },
    uFx: { value: new Vector4(MEMBRANE_GLOW, RUNE_GLOW, 0, 1) },
    uFx2: { value: new Vector4(0, 0, 0, 0) },
    uMotion: { value: new Vector4(0, 1, 0, 0) },
    uDebug: { value: new Color(0, 0, 0) },
  };
  const material = new ShaderMaterial({
    name: 'dragon',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: uniforms as unknown as Record<string, IUniform>,
    defines: { DRAGON_QUALITY: QUALITY_LEVEL[quality] },
    // Membranes and the cloak are single sheets; the hide's back faces cost nothing behind
    // its front faces (same draw call, depth-tested).
    side: DoubleSide,
    fog: false,
    lights: false,
  });
  // Low lights per vertex and takes no shadow lookup at all.
  useWorldLight(material, { shadows: quality !== 'low' });
  return { material, uniforms };
}

/** Preset change: recompiles only when the level really changes. Not per frame. */
export function setDragonMaterialQuality(target: DragonMaterial, quality: QualityPresetId): void {
  const level = QUALITY_LEVEL[quality];
  const defines = target.material.defines as Record<string, number | string>;
  if (defines['DRAGON_QUALITY'] === level) return;
  defines['DRAGON_QUALITY'] = level;
  useWorldLight(target.material, { shadows: quality !== 'low' });
  target.material.needsUpdate = true;
}

/** The GLSL, for tests. */
export const DRAGON_SHADER_SOURCE = { vertex: VERTEX, fragment: FRAGMENT } as const;
