/**
 * The cloud sea (T-1.5): the endless cloud layer under the map, i.e. this game's "ground".
 *
 * - ONE opaque flat quad (2 triangles) that follows the camera in XZ. Opaque on purpose: it
 *   fills half the screen, and the budget forbids a transparent full-screen layer. It writes
 *   depth, so the sky behind it is rejected for free.
 * - The billows are a generated tiling height + slope texture sampled at two scales that scroll
 *   in different directions: one fetch per octave gives a height and a normal, no derivatives.
 *   No vertex displacement: the silhouette is hidden by fog anyway and a flat quad costs nothing.
 * - The pattern is anchored to world XZ, so moving the quad never makes it swim. The quad is
 *   still snapped to a coarse grid, so its vertices only ever take a few distinct values.
 * - The edge is hidden by the scene fog (three's own fog chunks, so it tracks `scene.fog` and
 *   lands on the same colour as the sky's horizon band). The quad is sized from the fog density.
 *   REQUIRES `scene.fog`; without it the edge of the quad is visible.
 * - Colours are painted, not physically lit: `toneMapped = false`, like the sky and the fog.
 *
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
  Vector3,
  Vector4,
} from 'three';
import type { QualityPreset, Vec3 } from '../../shared';
import { GOLDEN_HOUR_SKY } from '../sky/sky-math';
import type { SkySetup } from '../sky/sky-math';
import {
  CLOUD_LIT_COLOR,
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
const TILE_A = 900;
const TILE_B = 310;
/** Scroll velocity in m/s along world X and Z, per octave. */
const WIND_A_X = 3.2;
const WIND_A_Z = 1.1;
const WIND_B_X = 4.6;
const WIND_B_Z = -3.4;
const NOISE_SIZE = 128;
const DEFAULT_NOISE_SEED = 0x5ea5;
/** Normal strength: how steep the billows look. Low is flatter. */
const BUMP_LOW = 1.6;
const BUMP_FULL = 3.0;

const VERTEX_SHADER = /* glsl */ `
uniform vec2 uInvTile;  // 1 / tile size of octave A, B
uniform vec4 uScroll;   // wrapped scroll offset: xy octave A, zw octave B
varying vec2 vUvA;
varying vec2 vUvB;
varying vec3 vToCamera;
#include <fog_pars_vertex>

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  // World-anchored pattern: computed here in highp, so the fragment side only sees small UVs.
  vUvA = worldPosition.xz * uInvTile.x + uScroll.xy;
  vUvB = worldPosition.xz * uInvTile.y + uScroll.zw;
  vToCamera = cameraPosition - worldPosition.xyz;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uNoise;   // r: height, gb: slope along +u/+v, zero at 128/255
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uLit;
uniform vec3 uShadow;
uniform float uBump;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec3 vToCamera;
#include <fog_pars_fragment>

void main() {
  vec4 a = texture2D(uNoise, vUvA);
  float height = a.r;
  vec2 slope = a.gb - 0.50196;
  #if SEA_OCTAVES > 1
    vec4 b = texture2D(uNoise, vUvB);
    height = height * 0.65 + b.r * 0.35;
    slope += (b.gb - 0.50196) * 0.6;
  #endif

  // u runs along world +X and v along world +Z, so the slope is the height gradient in XZ.
  vec3 normal = normalize(vec3(-slope.x * uBump, 1.0, -slope.y * uBump));

  // Wrapped sun term: the low sun lights the slopes that face it; folds sit in shadow.
  float lit = smoothstep(-0.25, 0.8, dot(normal, uSunDir));
  lit *= 0.55 + 0.45 * height;
  vec3 col = mix(uShadow, uLit, lit);

  #ifdef SEA_RIM
    // Warm sheen on the billows when looking across the sea toward the sun.
    vec3 toCamera = normalize(vToCamera);
    float graze = 1.0 - max(dot(normal, toCamera), 0.0);
    float towardSun = max(dot(-toCamera, uSunDir), 0.0);
    col += uSunColor * (graze * graze * graze * towardSun * towardSun * 0.3);
  #endif

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
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
  /** Low: 1 octave, flatter. Medium: 2 octaves. High: 2 octaves + sun rim sheen. */
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

export function createCloudSea(options: CloudSeaOptions): CloudSea {
  const sky = options.sky ?? GOLDEN_HOUR_SKY;
  const halfExtent = cloudSeaHalfExtent(sky.fogDensity, CLOUD_SEA_SNAP_STEP);

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

  const scroll = new Vector4(0, 0, 0, 0);
  const bump = { value: BUMP_FULL };
  const material = new ShaderMaterial({
    name: 'CloudSea',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uNoise: { value: noise },
      uInvTile: { value: new Vector2(1 / TILE_A, 1 / TILE_B) },
      uScroll: { value: scroll },
      uSunDir: {
        value: new Vector3(sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z).normalize(),
      },
      uSunColor: { value: new Color(sky.sunColor) },
      uLit: { value: new Color(CLOUD_LIT_COLOR) },
      uShadow: { value: new Color(CLOUD_SEA_SHADOW_COLOR) },
      uBump: bump,
      // Filled by the renderer from scene.fog (material.fog = true).
      fogColor: { value: new Color(sky.fogColor) },
      fogDensity: { value: sky.fogDensity },
      fogNear: { value: 1 },
      fogFar: { value: 2000 },
    },
    defines: { SEA_OCTAVES: 2 },
    fog: true,
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

  let octaves = 2;
  let rim = false;

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
      const wantOctaves = preset.id === 'low' ? 1 : 2;
      const wantRim = preset.id === 'high';
      bump.value = preset.id === 'low' ? BUMP_LOW : BUMP_FULL;
      if (wantOctaves === octaves && wantRim === rim) return;
      octaves = wantOctaves;
      rim = wantRim;
      const defines = material.defines as Record<string, string | number>;
      defines['SEA_OCTAVES'] = wantOctaves;
      if (wantRim) defines['SEA_RIM'] = '';
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
