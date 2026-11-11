/**
 * Cloud puffs (T-1.5): camera-facing sprites, ONE InstancedMesh (one draw call) per layer.
 * Layers enabled per preset: `QualityPreset.cloudLayers` (1 / 2 / 3).
 *
 * Overdraw is the top risk on an integrated GPU, so every decision here bounds fill:
 * - Hard instance cap per layer (`CLOUD_LAYER_SPECS[i].count`); Low and Medium draw fewer.
 * - On-screen size cap per preset: a puff is shrunk in the vertex shader so it never covers
 *   more than a fraction of the screen height.
 * - Near fade: a puff fades out as the camera approaches and is fully gone before the camera is
 *   inside it. A fully faded puff (near, or beyond the fog) is moved outside the clip volume in
 *   the vertex shader, so it rasterises nothing: flying through a cloud is never a full-screen
 *   transparent quad.
 * - Octagon instead of a quad: trims the empty corners of the sprite (about 17 % less fill).
 * - The fragment shader is one texture fetch and a few mixes.
 *
 * Blending: premultiplied alpha, depth test on, depth write off, NOT sorted. Sorting instances
 * means a CPU sort plus a buffer upload every frame; unsorted "over" blending is only wrong
 * where two puffs overlap on screen, and there the puffs are soft and nearly the same colour,
 * so the error is a faint tint. Placement also keeps puffs of a layer apart. Dithered
 * alpha-test puffs would need no order at all but look grainy at a 0.6 render scale.
 * The layers draw low to high and before every other transparent object (negative
 * `renderOrder`), so particles and effects always composite over the clouds.
 *
 * Billboarding happens in the vertex shader around the world up axis (so a banking camera
 * does not roll the clouds). Per frame the CPU writes one float. Colours are painted and
 * `toneMapped = false`, like the sky; three's fog chunks fade the puffs into `scene.fog`.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  Vector4,
} from 'three';
import type { QualityPreset, QualityPresetId } from '../../shared';
import { GOLDEN_HOUR_SKY, fogDistanceForOpacity } from '../sky/sky-math';
import type { SkySetup } from '../sky/sky-math';
import { CLOUD_LIT_COLOR, CLOUD_SHADOW_COLOR } from './cloud-math';
import { PUFF_ATLAS_GRID, PUFF_CONTENT_RADIUS, generatePuffAtlas } from './cloud-noise';
import {
  CLOUD_DEFAULT_SEED,
  CLOUD_LAYER_SPECS,
  CLOUD_PUFF_STRIDE,
  PUFF_FLIP,
  PUFF_HALF_HEIGHT,
  PUFF_HALF_WIDTH,
  PUFF_OPACITY,
  PUFF_PHASE,
  PUFF_VARIANT,
  PUFF_X,
  PUFF_Y,
  PUFF_Z,
  placeCloudLayer,
} from './cloud-placement';
import type { CloudField, CloudLayerSpec } from './cloud-placement';

/** Per-preset overdraw limits. */
export interface CloudQualityLimits {
  /** Fraction of each layer's instance cap that is drawn. */
  readonly instanceFraction: number;
  /**
   * Largest on-screen half-size of a puff, as a fraction of the screen's half-height: 0.4 means
   * a puff is never taller than 40 % of the screen.
   */
  readonly maxScreenSize: number;
}

export const CLOUD_QUALITY_LIMITS: Readonly<Record<QualityPresetId, CloudQualityLimits>> = {
  low: { instanceFraction: 0.7, maxScreenSize: 0.32 },
  medium: { instanceFraction: 0.85, maxScreenSize: 0.42 },
  high: { instanceFraction: 1, maxScreenSize: 0.55 },
};

/** A puff is invisible within NEAR_FADE_START half-widths of the camera, full from NEAR_FADE_END. */
export const PUFF_NEAR_FADE_START = 1.2;
export const PUFF_NEAR_FADE_END = 3.0;
/** Puffs are dropped once the fog hides this much of them; the fade starts at 80 % of that range. */
const FAR_FADE_FOG_OPACITY = 0.99;
const FAR_FADE_START_FRACTION = 0.8;
/** Used when the scene has no fog. */
const FAR_FADE_FALLBACK = 2500;
/** Idle bob in metres and its angular speed in rad/s (one cycle in about 50 s). */
const SWAY_AMPLITUDE = 5;
const SWAY_RATE = 0.125;
const TWO_PI = Math.PI * 2;
/** Texels per sprite; the atlas is twice this. Soft shapes need no more. */
const PUFF_CELL_SIZE = 64;
const PUFF_ATLAS_SEED = 0xb111;
/** Layer i draws at CLOUD_RENDER_ORDER_BASE + i: all negative, before other transparents. */
export const CLOUD_RENDER_ORDER_BASE = -8;

const VERTEX_SHADER = /* glsl */ `
attribute vec4 aPuff;     // x: atlas sprite, y: flip (+1 / -1), z: sway phase 0..1, w: opacity
uniform vec4 uFade;       // x, y: near fade in half-widths; z, w: far fade in metres
uniform float uMaxScreen; // on-screen half-size cap (fraction of the screen half-height)
uniform float uSway;      // wrapped angle, radians
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vSun;        // sun direction in the sprite's (right, up, toward-camera) frame
varying float vAlpha;
#include <fog_pars_vertex>

void main() {
  // The instance matrix only carries the centre and the half-size (scale x / y).
  vec4 centre = modelMatrix * (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0));
  vec2 halfSize = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
  float radius = max(halfSize.x, halfSize.y);
  centre.y += sin(uSway + aPuff.z * 6.2831853) * ${SWAY_AMPLITUDE.toFixed(1)};

  vec3 toCamera = cameraPosition - centre.xyz;
  float dist = max(length(toCamera), 0.001);
  vec3 forward = toCamera / dist;
  // Face the camera but stay upright in the world. The tiny bias keeps 'right' defined when
  // the camera is exactly above or below the puff.
  vec3 right = normalize(vec3(forward.z + 0.00001, 0.0, -forward.x));
  vec3 up = cross(forward, right);

  // Fade in with distance (never a big quad near the lens), fade out where the fog takes over.
  float fade = smoothstep(uFade.x * radius, uFade.y * radius, dist)
             * (1.0 - smoothstep(uFade.z, uFade.w, dist));
  vAlpha = fade * aPuff.w;

  // On-screen size cap: shrink the puff when it would cover too much of the screen.
  float cap = min(1.0, uMaxScreen * dist / (radius * projectionMatrix[1][1]));
  vec2 corner = position.xy * halfSize * cap;
  vec3 worldPosition = centre.xyz + right * corner.x + up * corner.y;

  // Atlas cell + mirrored u. position.xy spans the cell as -1..1.
  float sprite = aPuff.x;
  vec2 cell = vec2(mod(sprite, ${PUFF_ATLAS_GRID.toFixed(1)}), floor(sprite / ${PUFF_ATLAS_GRID.toFixed(1)}));
  vec2 local = vec2(position.x * aPuff.y, position.y) * 0.5 + 0.5;
  vUv = (cell + local) / ${PUFF_ATLAS_GRID.toFixed(1)};
  // Mirroring the sprite mirrors its baked normals, so mirror the sun's x to match.
  vSun = vec3(dot(uSunDir, right) * aPuff.y, dot(uSunDir, up), dot(uSunDir, forward));

  vec4 mvPosition = viewMatrix * vec4(worldPosition, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // Invisible puffs leave the clip volume: zero fragments, zero overdraw.
  if (vAlpha < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <fog_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uAtlas; // rg: normal xy (zero at 128/255), b: thickness, a: alpha
uniform vec3 uLit;
uniform vec3 uShadow;
varying vec2 vUv;
varying vec3 vSun;
varying float vAlpha;
#include <fog_pars_fragment>

void main() {
  vec4 texel = texture2D(uAtlas, vUv);
  vec3 normal;
  normal.xy = (texel.rg - 0.50196) * 2.0;
  normal.z = sqrt(max(1.0 - dot(normal.xy, normal.xy), 0.0));
  // Half-Lambert so the shaded side keeps its colour; thick cores read a little denser.
  float lit = smoothstep(0.1, 0.95, dot(normal, vSun) * 0.5 + 0.5);
  lit *= 1.0 - 0.2 * texel.b;
  gl_FragColor = vec4(mix(uShadow, uLit, lit), texel.a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
  #include <premultiplied_alpha_fragment>
}
`;

export interface CloudBillboardsOptions {
  /** Where the puffs go: `cloudFieldFromMap(map)`. */
  readonly field: CloudField;
  /** Sun and fog; `MapManifest.sky` fits. Defaults to the golden-hour recipe. */
  readonly sky?: SkySetup;
  readonly seed?: number;
  /** Defaults to `CLOUD_LAYER_SPECS`. At most one layer per spec is ever drawn. */
  readonly layers?: readonly CloudLayerSpec[];
}

export interface CloudBillboards {
  /**
   * One mesh per layer: add them all to the scene. `setQuality` hides the layers the preset
   * does not get, so a hidden layer costs no draw call.
   */
  readonly objects: readonly InstancedMesh<BufferGeometry, ShaderMaterial>[];
  /** Puffs currently drawn across the visible layers (for the perf HUD / tests). */
  readonly activeInstances: number;
  /** Call once per frame with the interpolated match time in seconds. Allocation-free. */
  update(timeS: number): void;
  /** Layers shown, instances per layer and the on-screen size cap. No shader recompile. */
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

/** A regular octagon whose inscribed circle is the sprite's content circle. */
function createPuffGeometry(): BufferGeometry {
  const sides = 8;
  const circumradius = PUFF_CONTENT_RADIUS / Math.cos(Math.PI / sides);
  const positions = new Float32Array((sides + 1) * 3);
  const indices: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = ((i + 0.5) / sides) * TWO_PI;
    positions[(i + 1) * 3] = Math.cos(angle) * circumradius;
    positions[(i + 1) * 3 + 1] = Math.sin(angle) * circumradius;
    indices.push(0, i + 1, ((i + 1) % sides) + 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // Unit radius: InstancedMesh.computeBoundingSphere scales it by each instance's largest
  // scale, which bounds the billboard whichever way it turns.
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere !== null) geometry.boundingSphere.radius = 1;
  return geometry;
}

export function createCloudBillboards(options: CloudBillboardsOptions): CloudBillboards {
  const sky = options.sky ?? GOLDEN_HOUR_SKY;
  const specs = options.layers ?? CLOUD_LAYER_SPECS;
  const seed = options.seed ?? CLOUD_DEFAULT_SEED;

  const atlasSize = PUFF_CELL_SIZE * PUFF_ATLAS_GRID;
  const atlas = new DataTexture(
    generatePuffAtlas(PUFF_CELL_SIZE, PUFF_ATLAS_SEED),
    atlasSize,
    atlasSize,
    RGBAFormat,
    UnsignedByteType,
  );
  atlas.magFilter = LinearFilter;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.needsUpdate = true;

  const farEnd = Math.min(
    fogDistanceForOpacity(sky.fogDensity, FAR_FADE_FOG_OPACITY),
    FAR_FADE_FALLBACK,
  );
  // Shared by every layer: one program, one set of per-frame uniform writes.
  const sway = { value: 0 };
  const maxScreen = { value: CLOUD_QUALITY_LIMITS.medium.maxScreenSize };
  const material = new ShaderMaterial({
    name: 'CloudPuffs',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uAtlas: { value: atlas },
      uFade: {
        value: new Vector4(
          PUFF_NEAR_FADE_START,
          PUFF_NEAR_FADE_END,
          farEnd * FAR_FADE_START_FRACTION,
          farEnd,
        ),
      },
      uMaxScreen: maxScreen,
      uSway: sway,
      uSunDir: {
        value: new Vector3(sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z).normalize(),
      },
      uLit: { value: new Color(CLOUD_LIT_COLOR) },
      uShadow: { value: new Color(CLOUD_SHADOW_COLOR) },
      // Filled by the renderer from scene.fog (material.fog = true).
      fogColor: { value: new Color(sky.fogColor) },
      fogDensity: { value: sky.fogDensity },
      fogNear: { value: 1 },
      fogFar: { value: 2000 },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthTest: true,
    depthWrite: false,
    fog: true,
    toneMapped: false,
  });

  const baseGeometry = createPuffGeometry();
  const geometries: BufferGeometry[] = [];
  const objects: InstancedMesh<BufferGeometry, ShaderMaterial>[] = [];
  const placedCounts: number[] = [];
  const matrix = new Matrix4();

  for (let layer = 0; layer < specs.length; layer++) {
    const spec = specs[layer];
    if (spec === undefined) continue;
    const placement = placeCloudLayer(options.field, spec, seed, layer);
    const count = placement.count;

    // Own geometry per layer (it carries that layer's per-instance attribute); the vertex and
    // index buffers are shared.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', baseGeometry.getAttribute('position'));
    geometry.setIndex(baseGeometry.getIndex());
    geometry.boundingSphere = baseGeometry.boundingSphere;
    const puff = new Float32Array(Math.max(count, 1) * 4);

    // At least one slot so three never sees an empty instance buffer.
    const mesh = new InstancedMesh(geometry, material, Math.max(count, 1));
    for (let i = 0; i < count; i++) {
      const o = i * CLOUD_PUFF_STRIDE;
      const data = placement.data;
      matrix.makeScale(data[o + PUFF_HALF_WIDTH] ?? 1, data[o + PUFF_HALF_HEIGHT] ?? 1, 1);
      matrix.setPosition(data[o + PUFF_X] ?? 0, data[o + PUFF_Y] ?? 0, data[o + PUFF_Z] ?? 0);
      mesh.setMatrixAt(i, matrix);
      puff[i * 4] = data[o + PUFF_VARIANT] ?? 0;
      puff[i * 4 + 1] = data[o + PUFF_FLIP] ?? 1;
      puff[i * 4 + 2] = data[o + PUFF_PHASE] ?? 0;
      puff[i * 4 + 3] = data[o + PUFF_OPACITY] ?? 1;
    }
    geometry.setAttribute('aPuff', new InstancedBufferAttribute(puff, 4));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = count;
    // Bounds of ALL placed puffs (computed at the full count, so any smaller count fits), grown
    // by the sway. The renderer culls the whole layer against this; the GPU clips single puffs.
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere !== null) mesh.boundingSphere.radius += SWAY_AMPLITUDE;
    mesh.name = `CloudPuffs:${spec.name}`;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = CLOUD_RENDER_ORDER_BASE + layer;

    geometries.push(geometry);
    objects.push(mesh);
    placedCounts.push(count);
  }

  let activeInstances = 0;
  for (const count of placedCounts) activeInstances += count;

  return {
    objects,
    get activeInstances(): number {
      return activeInstances;
    },
    update(timeS: number): void {
      // Wrapped on the CPU: the shader only ever sees an angle below 2 pi.
      const angle = timeS * SWAY_RATE;
      sway.value = angle - Math.floor(angle / TWO_PI) * TWO_PI;
    },
    setQuality(preset: QualityPreset): void {
      const limits = CLOUD_QUALITY_LIMITS[preset.id];
      maxScreen.value = limits.maxScreenSize;
      activeInstances = 0;
      for (let layer = 0; layer < objects.length; layer++) {
        const mesh = objects[layer];
        const placed = placedCounts[layer] ?? 0;
        if (mesh === undefined) continue;
        const count = Math.min(placed, Math.ceil(placed * limits.instanceFraction));
        mesh.count = count;
        mesh.visible = layer < preset.cloudLayers && count > 0;
        if (mesh.visible) activeInstances += count;
      }
    },
    dispose(): void {
      for (const mesh of objects) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      baseGeometry.dispose();
      material.dispose();
      atlas.dispose();
    },
  };
}
