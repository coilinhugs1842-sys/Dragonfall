/**
 * Painterly golden-hour sky (T-1.4, repainted in T-4.7).
 *
 * What is painted, back to front:
 * - a gradient that changes with height AND with the bearing to the sun: cream -> peach ->
 *   dusk violet on the sun's side, rose -> mauve -> violet opposite it;
 * - the sun: an HDR disc with three glow lobes (the post pass blooms it on High);
 * - high cloud sheets: a generated noise texture projected onto a plane overhead, stretched
 *   into long strokes, lit on the edges that face the sun, drifting slowly;
 * - far cloud banks along the horizon with sunlit crests;
 * - the horizon haze, which is exactly the fog colour (`wlHaze`), so fogged geometry and the
 *   cloud sea vanish into it.
 *
 * How it is drawn, and why:
 * - ONE full-screen triangle whose vertices are written straight to clip space at the far plane
 *   (z = w). It has no world position, so it follows the camera with no parallax, can never be
 *   clipped by the far plane, and needs no per-frame CPU work beyond the drift offsets.
 * - Drawn LAST among the opaque objects (`renderOrder`), depth test on, depth write off. On an
 *   integrated GPU fill is the cost, and by then the depth buffer rejects every sky pixel that
 *   terrain, dragons or the cloud sea already cover. Transparent objects still draw after it.
 *
 * Colour: every colour here is a scene-linear value authored through `setPaintedColor`, i.e.
 * chosen as the colour wanted on screen after the post pass's tone curve. Low: 2 texture
 * fetches per sky pixel; Medium / High: 5.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector4,
} from 'three';
import type { QualityPreset } from '../../shared';
import { WORLD_LIGHT_FOG_PARS_FRAGMENT } from '../light/light-glsl';
import { setPaintedColor } from '../light/light-math';
import { createHazeUniforms } from '../light/light-setup';
import {
  GOLDEN_HOUR_SKY,
  SKY_CLOUD_LIT,
  SKY_CLOUD_SHADOW,
  SKY_CREAM,
  SKY_DUSK_VIOLET,
  SKY_MAUVE,
  SKY_PEACH,
  SKY_ROSE,
} from './sky-math';
import type { SkySetup } from './sky-math';
import { SKY_NOISE_SIZE, generateSkyNoise } from './sky-noise';

/** After every opaque object (default 0) and after the cloud sea. */
export const SKY_RENDER_ORDER = 1000;

/** Brightness of the sun disc relative to the linear sun colour (HDR: it blooms). */
const SUN_DISC_GAIN = 12;
/** Sheet projection: uv per unit of the planar coordinate, and the stretch across the strokes. */
const SHEET_SCALE = 0.066;
const SHEET_STRETCH = 2.0;
/** The strokes run along this unit direction in the planar (x, z) coordinate. */
const SHEET_AXIS_X = 0.8;
const SHEET_AXIS_Z = 0.6;
/** How far toward the sun (planar units) the lighting fetch looks. */
const SHEET_LIGHT_STEP = 0.5;
/** Drift in uv per second: one repeat of the sheet texture takes about 35 minutes. */
const SHEET_DRIFT_U = 0.00047;
const SHEET_DRIFT_V = 0.00013;
const DETAIL_DRIFT_U = 0.0011;
const DETAIL_DRIFT_V = -0.0004;

const VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;

void main() {
  // position.xy is already clip space; z = w puts the triangle on the far plane.
  gl_Position = vec4(position.xy, 1.0, 1.0);
  // View-space ray through this vertex at depth 1 (the [2] terms are zero for a centred frustum).
  vec3 ray = vec3(
    (position.x + projectionMatrix[2][0]) / projectionMatrix[0][0],
    (position.y + projectionMatrix[2][1]) / projectionMatrix[1][1],
    -1.0
  );
  // viewMatrix's 3x3 is a pure rotation: v * M is transpose(M) * v, i.e. view -> world.
  vDir = ray * mat3(viewMatrix);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;   // r: sheets, g: billows, b: slow, a: streaks
uniform vec3 uCream;
uniform vec3 uPeach;
uniform vec3 uRose;
uniform vec3 uMauve;
uniform vec3 uZenith;
uniform vec3 uSunDisc;      // HDR disc colour
uniform vec3 uSunGlow;      // linear sun colour
uniform vec3 uCloudLit;
uniform vec3 uCloudShadow;
uniform vec2 uSunFlat;      // unit bearing of the sun in the xz plane
uniform vec2 uSunUv;        // sheet-uv step toward the sun
uniform vec4 uDrift;        // xy: sheet offset, zw: detail offset
varying vec3 vDir;
${WORLD_LIGHT_FOG_PARS_FRAGMENT}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;            // sine of the elevation: 0 at the horizon, 1 straight up
  float hp = max(h, 0.0);
  float s = max(dot(dir, uWlSunDir), 0.0);
  vec2 bearing = dir.xz * inversesqrt(max(dot(dir.xz, dir.xz), 1e-6));
  float sunSide = dot(bearing, uSunFlat) * 0.5 + 0.5;
  sunSide = sunSide * sunSide * (3.0 - 2.0 * sunSide);

  // Gradient: warm toward the sun, rose and mauve away from it, violet overhead.
  vec3 col = mix(mix(uRose, uCream, sunSide), mix(uMauve, uPeach, sunSide),
                 smoothstep(0.02, 0.27, hp));
  col = mix(col, uZenith, smoothstep(0.1, 0.7, hp));

  // Sun glow lobes by repeated squaring (no pow), then the disc.
  float s2 = s * s;
  float s8 = s2 * s2;
  s8 *= s8;
  float s64 = s8 * s8;
  s64 *= s64 * s64 * s64;
  col += uSunGlow * (s8 * 0.10 + s64 * 0.30);
  #ifdef SKY_DETAIL
    float s512 = s64 * s64;
    s512 *= s512 * s512 * s512;
    col += uSunGlow * (s512 * 1.0);
  #endif
  col = mix(col, uSunDisc, smoothstep(0.99885, 0.99935, s)); // about 5 degrees across

  // High cloud sheets on a plane overhead, stretched into strokes.
  vec2 p = dir.xz / (hp + 0.09);
  vec2 q = vec2(
    p.x * ${SHEET_AXIS_X.toFixed(2)} + p.y * ${SHEET_AXIS_Z.toFixed(2)},
    (p.y * ${SHEET_AXIS_X.toFixed(2)} - p.x * ${SHEET_AXIS_Z.toFixed(2)}) * ${SHEET_STRETCH.toFixed(2)}
  ) * ${SHEET_SCALE.toFixed(4)} + uDrift.xy;
  vec4 n = texture2D(uNoise, q);
  float base = n.r * 0.6 + n.a * 0.4;
  float sheet = base;
  #ifdef SKY_DETAIL
    sheet = base * 0.74 + texture2D(uNoise, q * 2.9 + uDrift.zw).g * 0.26;
  #endif
  float cover = 0.56 - 0.12 * (1.0 - smoothstep(0.08, 0.5, hp));
  float density = smoothstep(cover, cover + 0.2, sheet);
  density *= smoothstep(0.015, 0.09, hp) * (1.0 - 0.75 * smoothstep(0.45, 0.95, hp));
  density *= 1.0 - s64 * 0.85; // never bury the sun
  #ifdef SKY_DETAIL
    // Thinner toward the sun = an edge that faces it = lit.
    vec4 toward = texture2D(uNoise, q + uSunUv);
    float lit = clamp(0.5 + (base - (toward.r * 0.6 + toward.a * 0.4)) * 4.5, 0.0, 1.0);
  #else
    float lit = 0.55;
  #endif
  vec3 cloud = mix(uCloudShadow, uCloudLit, lit * (0.45 + 0.55 * sunSide));
  cloud += uSunGlow * (s8 * 0.22 * (1.0 - density * 0.5)); // thin cloud near the sun glows
  col = mix(col, cloud, density * 0.88);

  // Far cloud banks standing on the horizon; their skyline comes from the slow field.
  float around = atan(dir.z, dir.x) * 0.15915494;
  float skyline = textureLod(uNoise, vec2(around * 3.0 + uDrift.x, 0.31), 0.0).b;
  #ifdef SKY_DETAIL
    skyline = skyline * 0.72 + textureLod(uNoise, vec2(around * 13.0, 0.67), 0.0).g * 0.28;
  #endif
  float top = 0.012 + 0.075 * skyline;
  float bank = 1.0 - smoothstep(top - 0.016, top, h);
  float crest = smoothstep(top - 0.045, top - 0.008, h);
  vec3 bankCol = mix(uCloudShadow, uCloudLit, crest * (0.3 + 0.7 * sunSide));
  bankCol += uSunGlow * (s8 * 0.12);
  col = mix(col, bankCol, bank * 0.8);

  // Haze: at and below the horizon the sky IS the fog colour, so fogged geometry vanishes.
  col = mix(col, wlHaze(dir), 1.0 - smoothstep(-0.005, 0.05, h));

  gl_FragColor = vec4(col, 1.0);
}
`;

export interface SkyDome {
  /** Add to the scene. */
  readonly object: Mesh<BufferGeometry, ShaderMaterial>;
  /** Drifts the cloud sheets. Call once per frame with the scene time in seconds. No allocation. */
  update(timeS: number): void;
  /** Low: flat-lit sheets, 2 fetches. Medium/High: lit sheets, detail and the tight sun core. */
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

function wrap01(value: number): number {
  return value - Math.floor(value);
}

export function createSkyDome(setup: SkySetup = GOLDEN_HOUR_SKY): SkyDome {
  // One triangle that covers the whole viewport: no diagonal seam, no overdraw.
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );

  const noise = new DataTexture(
    generateSkyNoise(),
    SKY_NOISE_SIZE,
    SKY_NOISE_SIZE,
    RGBAFormat,
    UnsignedByteType,
  );
  noise.wrapS = RepeatWrapping;
  noise.wrapT = RepeatWrapping;
  noise.magFilter = LinearFilter;
  noise.minFilter = LinearMipmapLinearFilter;
  noise.generateMipmaps = true;
  noise.needsUpdate = true;

  const haze = createHazeUniforms(setup);
  const flatLength = Math.hypot(setup.sunDirection.x, setup.sunDirection.z);
  const sunFlat =
    flatLength > 1e-6
      ? new Vector2(setup.sunDirection.x / flatLength, setup.sunDirection.z / flatLength)
      : new Vector2(1, 0);
  // The sheet uv of a planar step toward the sun (same rotation and stretch as the shader).
  const sunUv = new Vector2(
    sunFlat.x * SHEET_AXIS_X + sunFlat.y * SHEET_AXIS_Z,
    (sunFlat.y * SHEET_AXIS_X - sunFlat.x * SHEET_AXIS_Z) * SHEET_STRETCH,
  ).multiplyScalar(SHEET_SCALE * SHEET_LIGHT_STEP);
  const drift = new Vector4(0, 0, 0, 0);

  const material = new ShaderMaterial({
    name: 'SkyDome',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      ...haze,
      uNoise: { value: noise },
      uCream: { value: setPaintedColor(new Color(), SKY_CREAM) },
      uPeach: { value: setPaintedColor(new Color(), SKY_PEACH) },
      uRose: { value: setPaintedColor(new Color(), SKY_ROSE) },
      uMauve: { value: setPaintedColor(new Color(), SKY_MAUVE) },
      uZenith: { value: setPaintedColor(new Color(), SKY_DUSK_VIOLET) },
      uSunDisc: { value: new Color(setup.sunColor).multiplyScalar(SUN_DISC_GAIN) },
      uSunGlow: { value: new Color(setup.sunColor) },
      uCloudLit: { value: setPaintedColor(new Color(), SKY_CLOUD_LIT) },
      uCloudShadow: { value: setPaintedColor(new Color(), SKY_CLOUD_SHADOW) },
      uSunFlat: { value: sunFlat },
      uSunUv: { value: sunUv },
      uDrift: { value: drift },
    },
    defines: {},
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const object = new Mesh(geometry, material);
  object.name = 'SkyDome';
  // The triangle is in clip space: a world-space bounding sphere would cull it wrongly.
  object.frustumCulled = false;
  object.matrixAutoUpdate = false;
  object.renderOrder = SKY_RENDER_ORDER;

  let detailed: boolean | null = null;

  return {
    object,
    update(timeS: number): void {
      // Wrapped on the CPU: the shader only ever adds a value below 1.
      drift.set(
        wrap01(timeS * SHEET_DRIFT_U),
        wrap01(timeS * SHEET_DRIFT_V),
        wrap01(timeS * DETAIL_DRIFT_U),
        wrap01(timeS * DETAIL_DRIFT_V),
      );
    },
    setQuality(preset: QualityPreset): void {
      const wantDetailed = preset.id !== 'low';
      if (wantDetailed === detailed) return;
      detailed = wantDetailed;
      // Assigning the object needs the property to be writable; rebuild the flag in place.
      const defines = material.defines as Record<string, string>;
      if (wantDetailed) defines['SKY_DETAIL'] = '';
      else delete defines['SKY_DETAIL'];
      material.needsUpdate = true;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      noise.dispose();
    },
  };
}
