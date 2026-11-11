/**
 * Light shafts (docs/ART_DIRECTION.md: "light shafts as cheap additive cards near the sun").
 *
 * A handful of long, soft, additive cards that run along the sun's direction and stand at fixed
 * places in the arena, as if the sun broke through gaps high above. They are world-anchored, so
 * flying past them gives parallax and rock in front of a shaft hides it: depth for free.
 *
 * Cost control (the overdraw rule in docs/PERFORMANCE.md):
 * - ONE draw call: every card is four vertices of one geometry, turned to face the camera
 *   around the beam axis in the vertex shader. The draw range caps the count per preset
 *   (Low: none, Medium: 5, High: 9).
 * - A card fades out as the camera nears its axis, or looks along it, and is then moved out of
 *   the clip volume, so flying through a shaft is never a full-screen transparent quad.
 * - The fragment shader has no texture fetch.
 *
 * Per frame: one uniform write.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
} from 'three';
import { createSeededRandom } from '../../shared';
import type { QualityPreset, QualityPresetId, Vec3 } from '../../shared';
import type { SkySetup } from '../sky/sky-math';
import { WORLD_LIGHT_FOG_PARS_FRAGMENT } from './light-glsl';
import { createHazeUniforms } from './light-setup';

/** Cards built; presets draw a prefix of them. */
export const LIGHT_SHAFT_MAX = 9;
export const LIGHT_SHAFT_COUNTS: Readonly<Record<QualityPresetId, number>> = {
  low: 0,
  medium: 5,
  high: LIGHT_SHAFT_MAX,
};
/** Before other transparents and after the cloud puffs (-8..-6). */
export const LIGHT_SHAFT_RENDER_ORDER = -4;
/** Floats per card in `placeLightShafts`: foot x, y, z, half-width, length, seed. */
export const LIGHT_SHAFT_STRIDE = 6;
const MIN_HALF_WIDTH = 22;
const MAX_HALF_WIDTH = 64;
const MAX_LENGTH = 2400;
/** Peak brightness added at the centre of a shaft, as a fraction of the linear sun colour. */
const SHAFT_STRENGTH = 0.2;

export interface LightShaftField {
  /** Arena centre (x, z used) and radius: the shafts land inside it. */
  readonly center: Vec3;
  readonly radius: number;
  /** The shafts end here (the cloud sea) and start at `topY`. */
  readonly bottomY: number;
  readonly topY: number;
}

/**
 * Deterministic shaft placement: `LIGHT_SHAFT_MAX` cards as `LIGHT_SHAFT_STRIDE` floats each.
 * A card starts above `topY` up-sun of its foot and ends at the foot on `bottomY`. Feet are
 * spread on a jittered ring so two shafts rarely overlap on screen. Pure: tested in node.
 */
export function placeLightShafts(field: LightShaftField, sunDir: Vec3, seed: number): Float32Array {
  const random = createSeededRandom(seed);
  const out = new Float32Array(LIGHT_SHAFT_MAX * LIGHT_SHAFT_STRIDE);
  const rise = sunDir.y > 0.05 ? sunDir.y : 0.05;
  const length = Math.min((field.topY - field.bottomY) / rise, MAX_LENGTH);
  const turn = random() * Math.PI * 2;
  for (let i = 0; i < LIGHT_SHAFT_MAX; i++) {
    // Golden-angle ring: any prefix of the list is evenly spread.
    const angle = turn + i * 2.399963;
    const r = field.radius * (0.25 + 0.65 * Math.sqrt((i + random()) / LIGHT_SHAFT_MAX));
    const o = i * LIGHT_SHAFT_STRIDE;
    out[o] = field.center.x + Math.cos(angle) * r;
    out[o + 1] = field.bottomY;
    out[o + 2] = field.center.z + Math.sin(angle) * r;
    out[o + 3] = MIN_HALF_WIDTH + (MAX_HALF_WIDTH - MIN_HALF_WIDTH) * random();
    out[o + 4] = length * (0.8 + 0.2 * random());
    out[o + 5] = random();
  }
  return out;
}

const VERTEX_SHADER = /* glsl */ `
attribute vec2 aCorner;  // x: side -1 / +1, y: 0 at the foot .. 1 at the top
attribute vec3 aShape;   // x: half-width (m), y: length (m), z: seed 0..1
uniform vec3 uWlSunDir;
uniform float uTime;
varying vec3 vUvw;       // x: across -1..1, y: along 0..1, z: seed
varying vec3 vWorld;
varying float vFade;

void main() {
  // position is the foot; the card runs from it toward the sun.
  vec3 onAxis = position + uWlSunDir * (aCorner.y * aShape.y);
  vec3 toCamera = cameraPosition - onAxis;
  vec3 side = normalize(cross(uWlSunDir, toCamera) + vec3(1e-5, 0.0, 0.0));
  vec3 world = onAxis + side * (aCorner.x * aShape.x);

  // Distance from the camera to the beam's axis: fade out before the camera is inside it.
  vec3 fromFoot = cameraPosition - position;
  float nearAxis = length(fromFoot - uWlSunDir * dot(fromFoot, uWlSunDir));
  float fade = smoothstep(aShape.x * 1.6, aShape.x * 5.0, nearAxis);
  // Seen end-on (looking straight up or down the beam) a card is a fat bright smear: fade it.
  float endOn = abs(dot(normalize(toCamera), uWlSunDir));
  fade *= 1.0 - smoothstep(0.80, 0.97, endOn);
  // A slow breath, out of step per shaft.
  fade *= 0.8 + 0.2 * sin(uTime * 0.21 + aShape.z * 40.0);

  vUvw = vec3(aCorner.x, aCorner.y, aShape.z);
  vWorld = world;
  vFade = fade;
  gl_Position = projectionMatrix * (viewMatrix * vec4(world, 1.0));
  if (fade < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
varying vec3 vUvw;
varying vec3 vWorld;
varying float vFade;
${WORLD_LIGHT_FOG_PARS_FRAGMENT}

void main() {
  float across = 1.0 - vUvw.x * vUvw.x;
  across *= across;
  // Soft at the foot (it sinks into the sea) and long gone before the top.
  float along = smoothstep(0.0, 0.1, vUvw.y) * (1.0 - smoothstep(0.35, 0.95, vUvw.y));
  // A few finer rays inside the shaft.
  float rays = 0.85 + 0.15 * sin(vUvw.x * 5.0 + vUvw.z * 31.0) * sin(vUvw.x * 11.0 + vUvw.z * 11.0);
  vec3 toFragment = vWorld - cameraPosition;
  float dist = max(length(toFragment), 1e-3);
  // Forward scattering: shafts show when looking toward the sun, barely with it behind.
  float s = max(dot(toFragment / dist, uWlSunDir), 0.0);
  float phase = 0.3 + 0.7 * s * s;
  float clear = 1.0 - wlFogFactor(vWorld, dist);
  gl_FragColor = vec4(uColor * (across * along * rays * phase * clear * vFade), 1.0);
}
`;

export interface LightShaftsOptions extends LightShaftField {
  readonly sky: SkySetup;
  readonly seed?: number;
}

export interface LightShafts {
  /** Add to the scene. Hidden on Low. */
  readonly object: Mesh<BufferGeometry, ShaderMaterial>;
  /** Cards drawn at the current preset. */
  readonly activeCount: number;
  update(timeS: number): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

export function createLightShafts(options: LightShaftsOptions): LightShafts {
  const placed = placeLightShafts(options, options.sky.sunDirection, options.seed ?? 0x5afe);
  const positions = new Float32Array(LIGHT_SHAFT_MAX * 4 * 3);
  const corners = new Float32Array(LIGHT_SHAFT_MAX * 4 * 2);
  const shapes = new Float32Array(LIGHT_SHAFT_MAX * 4 * 3);
  const indices: number[] = [];
  const cornerX = [-1, 1, 1, -1];
  const cornerY = [0, 0, 1, 1];
  for (let i = 0; i < LIGHT_SHAFT_MAX; i++) {
    const o = i * LIGHT_SHAFT_STRIDE;
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      positions[v * 3] = placed[o] ?? 0;
      positions[v * 3 + 1] = placed[o + 1] ?? 0;
      positions[v * 3 + 2] = placed[o + 2] ?? 0;
      corners[v * 2] = cornerX[c] ?? 0;
      corners[v * 2 + 1] = cornerY[c] ?? 0;
      shapes[v * 3] = placed[o + 3] ?? 1;
      shapes[v * 3 + 1] = placed[o + 4] ?? 1;
      shapes[v * 3 + 2] = placed[o + 5] ?? 0;
    }
    indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aCorner', new BufferAttribute(corners, 2));
  geometry.setAttribute('aShape', new BufferAttribute(shapes, 3));
  geometry.setIndex(indices);

  const time = { value: 0 };
  const material = new ShaderMaterial({
    name: 'LightShafts',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      ...createHazeUniforms(options.sky),
      uColor: { value: new Color(options.sky.sunColor).multiplyScalar(SHAFT_STRENGTH) },
      uTime: time,
    },
    blending: AdditiveBlending,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const object = new Mesh(geometry, material);
  object.name = 'LightShafts';
  // The cards are built in the vertex shader: the geometry's own bounds mean nothing.
  object.frustumCulled = false;
  object.matrixAutoUpdate = false;
  object.renderOrder = LIGHT_SHAFT_RENDER_ORDER;

  let activeCount = LIGHT_SHAFT_COUNTS.medium;
  geometry.setDrawRange(0, activeCount * 6);

  return {
    object,
    get activeCount(): number {
      return activeCount;
    },
    update(timeS: number): void {
      // Only ever used inside sin(): wrap to keep the float small.
      time.value = timeS % 6000;
    },
    setQuality(preset: QualityPreset): void {
      activeCount = LIGHT_SHAFT_COUNTS[preset.id];
      geometry.setDrawRange(0, activeCount * 6);
      object.visible = activeCount > 0;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
