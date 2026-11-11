/**
 * The cloud sea (T-1.5, repainted in T-4.7): the endless cloud layer under the map, i.e. this
 * game's "ground". It should read as a soft ocean of cumulus under a low sun, for the price of
 * one flat quad.
 *
 * - ONE opaque flat quad (2 triangles) that follows the camera in XZ. Opaque on purpose: it
 *   fills half the screen, and the budget forbids a transparent full-screen layer. It writes
 *   depth, so the sky behind it is rejected for free.
 * - The billows are a generated tiling height + slope texture sampled at two scales that scroll
 *   in different directions: one fetch per octave gives a height and a normal, no derivatives.
 * - Volume without geometry (Medium / High): a short parallax march (2 / 3 single-channel
 *   fetches) slides the pattern under the view ray, so near crests move over far valleys as the
 *   camera flies; and one / two extra height fetches toward the sun find whether a taller
 *   billow stands in the way, which gives the long soft shadows of a low sun. Low does neither
 *   (two fetches: one octave alone shows the texel grid of its slopes up close).
 * - Colour is a four-stop painted ramp driven by light and height: deep valley -> shaded fold
 *   -> sunlit flank -> cream crest, plus a warm rim on crests seen against the sun. Colours are
 *   scene-linear values authored through `setPaintedColor`.
 * - The pattern is anchored to world XZ, so moving the quad never makes it swim. The quad is
 *   still snapped to a coarse grid, so its vertices only ever take a few distinct values.
 * - The edge is hidden by `wlApplyFog` (the same distance fog and haze colour as the sky's
 *   horizon band). The quad is sized from the fog density.
 *
 * Texture fetches per sea pixel: Low 2, Medium 5, High 7.
 * Per frame: `update` writes two numbers into the mesh position and four into one uniform.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
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
import type { QualityPreset, QualityPresetId, Vec3 } from '../../shared';
import { WORLD_LIGHT_FOG_PARS_FRAGMENT } from '../light/light-glsl';
import { setPaintedColor } from '../light/light-math';
import { createHazeUniforms } from '../light/light-setup';
import { GOLDEN_HOUR_SKY } from '../sky/sky-math';
import type { SkySetup } from '../sky/sky-math';
import {
  CLOUD_CREST_COLOR,
  CLOUD_LIT_COLOR,
  CLOUD_SEA_DEEP_COLOR,
  CLOUD_SEA_SHADOW_COLOR,
  cloudSeaHalfExtent,
  snapToGrid,
  wrapScroll,
} from './cloud-math';
import { generateCloudSeaNoise } from './cloud-noise';

/** After the terrain (default 0) so its pixels are depth-rejected, before the sky (1000). */
export const CLOUD_SEA_RENDER_ORDER = 900;
/** Metres the quad moves by when it follows the camera. */
export const CLOUD_SEA_SNAP_STEP = 64;

/** World size of one repeat of the noise texture, per octave (not multiples of each other). */
const TILE_A = 1500;
const TILE_B = 430;
/** Scroll velocity in m/s along world X and Z, per octave. */
const WIND_A_X = 3.2;
const WIND_A_Z = 1.1;
const WIND_B_X = 4.6;
const WIND_B_Z = -3.4;
const NOISE_SIZE = 256;
const DEFAULT_NOISE_SEED = 0x5ea5;
/** Apparent height of the billows in metres: the depth the parallax march works with. */
const BILLOW_DEPTH = 85;
/**
 * The sea is fogged with this fraction of the scene's fog density. At the map density (98 %
 * at 1.2 km) a flat layer seen at a grazing angle is two-thirds fog 600 m out and the billows
 * wash out; thinner fog keeps their form to about 1.2 km. It still ends on the same haze colour
 * as the sky's horizon band, and the quad is sized for this density.
 */
export const SEA_FOG_DENSITY_SCALE = 0.5;
/** How far toward the sun (metres) the shadow fetches look. */
const SHADOW_STEP_NEAR = 60;
const SHADOW_STEP_FAR = 150;

/** Per-preset shader variant. */
export interface CloudSeaQuality {
  readonly octaves: 1 | 2;
  /** Parallax march steps (single-channel fetches). */
  readonly parallaxSteps: number;
  /** Height fetches toward the sun for the billow shadows. */
  readonly shadowTaps: number;
  /** Warm rim on crests seen against the sun. */
  readonly rim: boolean;
  /** Normal strength: how steep the billows look. */
  readonly bump: number;
}

export const CLOUD_SEA_QUALITY: Readonly<Record<QualityPresetId, CloudSeaQuality>> = {
  low: { octaves: 2, parallaxSteps: 0, shadowTaps: 0, rim: false, bump: 2.2 },
  medium: { octaves: 2, parallaxSteps: 2, shadowTaps: 1, rim: true, bump: 2.6 },
  high: { octaves: 2, parallaxSteps: 3, shadowTaps: 2, rim: true, bump: 2.6 },
};

const VERTEX_SHADER = /* glsl */ `
uniform vec2 uInvTile;  // 1 / tile size of octave A, B
uniform vec4 uScroll;   // wrapped scroll offset: xy octave A, zw octave B
varying vec2 vUvA;
varying vec2 vUvB;
varying vec3 vWorld;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  // World-anchored pattern: computed here in highp, so the fragment side only sees small UVs.
  vUvA = worldPosition.xz * uInvTile.x + uScroll.xy;
  vUvB = worldPosition.xz * uInvTile.y + uScroll.zw;
  vWorld = worldPosition.xyz;
  gl_Position = projectionMatrix * (viewMatrix * worldPosition);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;   // r: height, gb: slope along +u/+v (zero at 128/255), a: detail
uniform vec2 uInvTile;
uniform vec3 uSunGlow;      // linear sun colour
uniform vec3 uDeep;
uniform vec3 uShadow;
uniform vec3 uLit;
uniform vec3 uCrest;
uniform float uBump;
uniform vec4 uShape;        // x: billow depth (m), y: near shadow step (m), z: far step, w: rise per metre / depth
varying vec2 vUvA;
varying vec2 vUvB;
varying vec3 vWorld;
${WORLD_LIGHT_FOG_PARS_FRAGMENT}

void main() {
  vec3 toCamera = cameraPosition - vWorld;
  float dist = max(length(toCamera), 1e-3);
  vec3 view = toCamera / dist; // fragment -> camera

  vec2 uvA = vUvA;
  vec2 uvB = vUvB;
  #if SEA_PARALLAX > 0
    // Slide the pattern under the view ray: a point of height h lies (1 - h) * depth below the
    // quad. The grazing limit keeps the far sea from smearing; it fades out with distance,
    // where the offset would be sub-pixel work anyway.
    vec2 slide = view.xz / max(abs(view.y), 0.22) * (uShape.x * (1.0 - smoothstep(600.0, 1500.0, dist)));
    float hp = texture2D(uNoise, uvA).r;
    for (int i = 1; i < SEA_PARALLAX; i++) {
      hp = mix(hp, texture2D(uNoise, uvA - slide * ((1.0 - hp) * uInvTile.x)).r, 0.7);
    }
    vec2 offset = slide * (1.0 - hp);
    uvA -= offset * uInvTile.x;
    uvB -= offset * uInvTile.y;
  #endif

  vec4 a = texture2D(uNoise, uvA);
  float height = a.r;
  vec2 slope = a.gb - 0.50196;
  #if SEA_OCTAVES > 1
    vec4 b = texture2D(uNoise, uvB);
    height = height * 0.66 + b.r * 0.26 + b.a * 0.08;
    slope += (b.gb - 0.50196) * 0.5;
  #endif

  // u runs along world +X and v along world +Z, so the slope is the height gradient in XZ.
  vec3 normal = normalize(vec3(-slope.x * uBump, 1.0, -slope.y * uBump));
  float facing = dot(normal, uWlSunDir);
  float lit = smoothstep(-0.05, 0.85, facing);

  #if SEA_SHADOW_TAPS > 0
    // Is a taller billow standing between this point and the low sun?
    vec2 sunStep = uWlSunDir.xz * uInvTile.x;
    float blocker = texture2D(uNoise, uvA + sunStep * uShape.y).r - a.r - uShape.y * uShape.w;
    #if SEA_SHADOW_TAPS > 1
      blocker = max(blocker, texture2D(uNoise, uvA + sunStep * uShape.z).r - a.r - uShape.z * uShape.w);
    #endif
    lit *= 1.0 - 0.75 * smoothstep(-0.06, 0.22, blocker);
  #endif

  // Painted ramp: valleys hold the dusk, flanks catch the sun, crests go cream.
  float valley = smoothstep(0.1, 0.8, height);
  float sunlit = lit * (0.35 + 0.65 * valley);
  vec3 col = mix(uDeep, uShadow, valley);
  col = mix(col, uLit, sunlit * sunlit * (3.0 - 2.0 * sunlit));
  col = mix(col, uCrest, smoothstep(0.55, 1.0, sunlit) * smoothstep(0.4, 0.9, height));

  #ifdef SEA_RIM
    // Crests seen against the sun light up along their edge, and the whole sea warms toward it.
    float against = max(dot(-view, uWlSunDir), 0.0);
    float against2 = against * against;
    float graze = 1.0 - max(dot(normal, view), 0.0);
    col += uSunGlow * (graze * graze * against2 * against2 * smoothstep(0.4, 0.85, height) * 0.55);
    col += uSunGlow * (against2 * against2 * against2 * 0.10);
  #endif

  gl_FragColor = vec4(wlApplyFog(col, vWorld), 1.0);
}
`;

export interface CloudSeaOptions {
  /** World Y of the surface (`MapColliders.cloudSeaY`, or `floorY` when the map has none). */
  readonly cloudSeaY: number;
  /** Sun and fog; `MapManifest.sky` fits. Defaults to the golden-hour recipe. */
  readonly sky?: SkySetup;
  readonly noiseSeed?: number;
}

export interface CloudSea {
  /** Add to the scene. */
  readonly object: Mesh<BufferGeometry, ShaderMaterial>;
  /**
   * Call once per frame with the render camera's world position and the interpolated match
   * time in seconds. Allocation-free.
   */
  update(cameraPosition: Vec3, timeS: number): void;
  /** Picks the `CLOUD_SEA_QUALITY` variant. Recompiles the shader: not per frame. */
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

export function createCloudSea(options: CloudSeaOptions): CloudSea {
  const sky = options.sky ?? GOLDEN_HOUR_SKY;
  const seaFogDensity = sky.fogDensity * SEA_FOG_DENSITY_SCALE;
  const halfExtent = cloudSeaHalfExtent(seaFogDensity, CLOUD_SEA_SNAP_STEP);

  // A square in the XZ plane, facing +Y.
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([
        -halfExtent,
        0,
        -halfExtent,
        -halfExtent,
        0,
        halfExtent,
        halfExtent,
        0,
        halfExtent,
        halfExtent,
        0,
        -halfExtent,
      ]),
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const noise = new DataTexture(
    generateCloudSeaNoise(NOISE_SIZE, options.noiseSeed ?? DEFAULT_NOISE_SEED),
    NOISE_SIZE,
    NOISE_SIZE,
    RGBAFormat,
    UnsignedByteType,
  );
  noise.wrapS = RepeatWrapping;
  noise.wrapT = RepeatWrapping;
  noise.magFilter = LinearFilter;
  noise.minFilter = LinearMipmapLinearFilter;
  noise.generateMipmaps = true;
  noise.needsUpdate = true;

  // Height the sun ray gains per metre travelled toward it, in units of the billow depth.
  const flat = Math.hypot(sky.sunDirection.x, sky.sunDirection.z);
  const risePerMetre = flat > 1e-6 ? sky.sunDirection.y / flat / BILLOW_DEPTH : 1;

  const scroll = new Vector4(0, 0, 0, 0);
  const bump = { value: CLOUD_SEA_QUALITY.medium.bump };
  const material = new ShaderMaterial({
    name: 'CloudSea',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      // No sea haze on the sea itself (it IS the haze layer): distance fog only, and thinner
      // than the scene's (see SEA_FOG_DENSITY_SCALE).
      ...createHazeUniforms({ ...sky, fogDensity: seaFogDensity }),
      uNoise: { value: noise },
      uInvTile: { value: new Vector2(1 / TILE_A, 1 / TILE_B) },
      uScroll: { value: scroll },
      uSunGlow: { value: new Color(sky.sunColor) },
      uDeep: { value: setPaintedColor(new Color(), CLOUD_SEA_DEEP_COLOR) },
      uShadow: { value: setPaintedColor(new Color(), CLOUD_SEA_SHADOW_COLOR) },
      uLit: { value: setPaintedColor(new Color(), CLOUD_LIT_COLOR) },
      uCrest: { value: setPaintedColor(new Color(), CLOUD_CREST_COLOR) },
      uBump: bump,
      uShape: {
        value: new Vector4(BILLOW_DEPTH, SHADOW_STEP_NEAR, SHADOW_STEP_FAR, risePerMetre),
      },
    },
    defines: { SEA_OCTAVES: 2, SEA_PARALLAX: 2, SEA_SHADOW_TAPS: 1, SEA_RIM: '' },
    fog: false,
    toneMapped: false,
    // Seen from below when a dragon dips into the hazard band under the surface.
    side: DoubleSide,
  });

  const object = new Mesh(geometry, material);
  object.name = 'CloudSea';
  object.position.y = options.cloudSeaY;
  // It is centred on the camera: always in view, so the culling test would be wasted work.
  object.frustumCulled = false;
  object.renderOrder = CLOUD_SEA_RENDER_ORDER;

  let current: CloudSeaQuality = CLOUD_SEA_QUALITY.medium;

  return {
    object,
    update(cameraPosition: Vec3, timeS: number): void {
      object.position.x = snapToGrid(cameraPosition.x, CLOUD_SEA_SNAP_STEP);
      object.position.z = snapToGrid(cameraPosition.z, CLOUD_SEA_SNAP_STEP);
      // The pattern drifts downwind, so its texture coordinates move the other way.
      scroll.x = wrapScroll(timeS, -WIND_A_X, TILE_A);
      scroll.y = wrapScroll(timeS, -WIND_A_Z, TILE_A);
      scroll.z = wrapScroll(timeS, -WIND_B_X, TILE_B);
      scroll.w = wrapScroll(timeS, -WIND_B_Z, TILE_B);
    },
    setQuality(preset: QualityPreset): void {
      const want = CLOUD_SEA_QUALITY[preset.id];
      bump.value = want.bump;
      if (want === current) return;
      current = want;
      const defines = material.defines as Record<string, string | number>;
      defines['SEA_OCTAVES'] = want.octaves;
      defines['SEA_PARALLAX'] = want.parallaxSteps;
      defines['SEA_SHADOW_TAPS'] = want.shadowTaps;
      if (want.rim) defines['SEA_RIM'] = '';
      else delete defines['SEA_RIM'];
      // New defines mean a new program: compile it on the loading screen, not mid-match.
      material.needsUpdate = true;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      noise.dispose();
    },
  };
}
