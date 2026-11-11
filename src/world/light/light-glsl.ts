/**
 * GLSL of the shared world lighting. One fragment chunk, used by every material that wants the
 * map's sun, ambient, shadow and fog: our own ShaderMaterials include it directly, and
 * ./light-patch.ts splices it into three's built-in materials.
 *
 * Needs `cameraPosition` (three declares it for every ShaderMaterial) and, in the including
 * shader, a world-space position and normal per fragment.
 *
 * Defines (set by `useWorldLight` from the quality preset; never by hand):
 *   WL_SHADOW_MAP     sample the sun's shadow map (Medium / High)
 *   WL_BLOBS <n>      n analytic sphere shadows (Low)
 *
 *   vec3  wlHaze(vec3 viewDir)                       fog colour seen along a unit view direction
 *   float wlFogFactor(vec3 worldPos, float dist)     0 clear .. 1 fully fogged
 *   vec3  wlApplyFog(vec3 color, vec3 worldPos)      replaces <fog_fragment>
 *   float wlSunVisibility(vec3 worldPos, vec3 N)     0 shadowed .. 1 lit
 *   vec3  wlAmbient(vec3 N)                          hemisphere irradiance (three's formula)
 *   vec3  wlRim(vec3 N, vec3 toCamera)               warm rim on the sun side, already coloured
 *   vec3  wlDiffuse(vec3 albedo, vec3 worldPos, vec3 N)   sun + ambient Lambert, like
 *                                                    MeshLambertMaterial under the same lights
 */
import {
  HAZE_GLOW_TIGHT,
  HAZE_GLOW_WIDE,
  SEA_HAZE_DISTANCE,
  SEA_HAZE_HEIGHT,
  SEA_HAZE_STRENGTH,
} from './light-math';

function f(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** Only the haze / fog half: what the sky, the cloud sea and the puffs need. */
export const WORLD_LIGHT_FOG_PARS_FRAGMENT = /* glsl */ `
uniform vec3 uWlSunDir;     // unit, toward the sun, world space
uniform vec3 uWlFogColor;   // scene-linear; equal to scene.fog.color
uniform vec3 uWlGlowColor;  // sun in-scatter added to the fog toward the sun
uniform vec4 uWlFogParams;  // x: exp2 density, y: cloud-sea Y, z: unused, w: sea-haze scale 0..1

vec3 wlHaze(vec3 viewDir) {
  float s = max(dot(viewDir, uWlSunDir), 0.0);
  float s2 = s * s;
  float s8 = s2 * s2 * s2 * s2;
  return uWlFogColor + uWlGlowColor * (s8 * ${f(HAZE_GLOW_TIGHT)} + s2 * ${f(HAZE_GLOW_WIDE)});
}

float wlFogFactor(vec3 worldPos, float dist) {
  float x = uWlFogParams.x * dist;
  float far = 1.0 - exp(-x * x);
  float h = clamp(1.0 - (worldPos.y - uWlFogParams.y) * ${f(1 / SEA_HAZE_HEIGHT)}, 0.0, 1.0);
  float haze = h * h * ${f(SEA_HAZE_STRENGTH)} * uWlFogParams.w
             * (1.0 - exp(-dist * ${f(1 / SEA_HAZE_DISTANCE)}));
  return 1.0 - (1.0 - far) * (1.0 - haze);
}

vec3 wlApplyFog(vec3 color, vec3 worldPos) {
  vec3 toFragment = worldPos - cameraPosition;
  float dist = max(length(toFragment), 1e-3);
  return mix(color, wlHaze(toFragment / dist), wlFogFactor(worldPos, dist));
}
`;

/** The whole chunk: fog + sun, ambient, shadow. */
export const WORLD_LIGHT_PARS_FRAGMENT = /* glsl */ `
${WORLD_LIGHT_FOG_PARS_FRAGMENT}
uniform vec3 uWlSunColor;    // linear colour * intensity (three's DirectionalLight units)
uniform vec3 uWlHemiSky;     // linear colour * intensity
uniform vec3 uWlHemiGround;
#ifdef WL_SHADOW_MAP
  uniform highp sampler2DShadow uWlShadowMap;
  uniform mat4 uWlShadowMatrix;  // world -> shadow uv + depth
  uniform vec4 uWlShadowParams;  // x: 1 / map size, y: normal offset (m), z: strength, w: depth bias
#endif
#ifdef WL_BLOBS
  uniform vec4 uWlBlobs[WL_BLOBS]; // xyz: centre, w: radius (0 = unused)
  uniform float uWlBlobStrength;
#endif

float wlSunVisibility(vec3 worldPos, vec3 worldNormal) {
  #if defined(WL_SHADOW_MAP)
    if (uWlShadowParams.z <= 0.0) return 1.0;
    vec4 sc = uWlShadowMatrix * vec4(worldPos + worldNormal * uWlShadowParams.y, 1.0);
    vec3 c = sc.xyz / sc.w;
    // Fades to "lit" over the outer 12 % of the map, so its edge is never a visible line.
    vec2 e = min(c.xy, 1.0 - c.xy);
    float fade = clamp(min(e.x, e.y) * 8.0, 0.0, 1.0) * step(c.z, 1.0);
    if (fade <= 0.0) return 1.0;
    float z = c.z - uWlShadowParams.w;
    // Four hardware-filtered compares on a square turned by a per-pixel angle: a soft edge
    // about 4 texels wide whose steps become fine grain (which FXAA then smooths).
    float angle = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))
                * 6.2831853;
    vec2 r = vec2(cos(angle), sin(angle)) * (1.5 * uWlShadowParams.x);
    float lit = texture(uWlShadowMap, vec3(c.xy + r, z))
              + texture(uWlShadowMap, vec3(c.xy - r, z))
              + texture(uWlShadowMap, vec3(c.xy + vec2(-r.y, r.x), z))
              + texture(uWlShadowMap, vec3(c.xy + vec2(r.y, -r.x), z));
    return 1.0 - (1.0 - lit * 0.25) * fade * uWlShadowParams.z;
  #elif defined(WL_BLOBS)
    float vis = 1.0;
    for (int i = 0; i < WL_BLOBS; i++) {
      vec4 blob = uWlBlobs[i];
      vec3 v = blob.xyz - worldPos;
      float t = dot(v, uWlSunDir);
      float d2 = dot(v, v) - t * t;
      float r2 = max(blob.w * blob.w, 1e-4);
      float tp = max(t, 0.0);
      float disc = 1.0 - smoothstep(r2 * 0.15, r2 * (1.0 + tp * 0.02), d2);
      float side = smoothstep(blob.w * 0.6, blob.w * 1.6 + 1e-3, t) * step(1e-3, blob.w);
      vis *= 1.0 - disc * side / (1.0 + tp * 0.012) * uWlBlobStrength;
    }
    return vis;
  #else
    return 1.0;
  #endif
}

vec3 wlAmbient(vec3 worldNormal) {
  return mix(uWlHemiGround, uWlHemiSky, worldNormal.y * 0.5 + 0.5);
}

vec3 wlRim(vec3 worldNormal, vec3 toCamera) {
  float fresnel = 1.0 - max(dot(worldNormal, toCamera), 0.0);
  fresnel *= fresnel * fresnel;
  float sunSide = clamp(dot(worldNormal, uWlSunDir) * 0.5 + 0.5, 0.0, 1.0);
  return uWlSunColor * (fresnel * sunSide * 0.3183);
}

vec3 wlDiffuse(vec3 albedo, vec3 worldPos, vec3 worldNormal) {
  float nl = max(dot(worldNormal, uWlSunDir), 0.0);
  vec3 irradiance = uWlSunColor * (nl * wlSunVisibility(worldPos, worldNormal))
                  + wlAmbient(worldNormal);
  return albedo * irradiance * 0.3183; // 1 / pi: three's Lambert BRDF
}
`;
