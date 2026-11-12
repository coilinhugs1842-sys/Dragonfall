/**
 * Ash in the air (docs/GAME_DESIGN.md, Emberfall Caldera): grey flakes drifting down on the
 * wind and, lower down where the lava glows, crimson sparks rising. It is the map's sense of
 * air and of speed: flakes stream past a fast dragon.
 *
 * The flakes live in a box around the camera and wrap as it moves (a flake that leaves on one
 * side comes back on the other), so a few hundred fill the view wherever the camera is and
 * nothing is ever spawned or moved on the CPU.
 *
 * Cost control:
 * - ONE draw call, no texture fetch, quads of a few pixels: almost no overdraw.
 * - Count per preset through the draw range (`ASH_FLAKE_COUNTS`). They are particles: add them
 *   to the effect particles when checking the budget in docs/PERFORMANCE.md.
 * - One blend state for both kinds: premultiplied alpha, where a flake writes its alpha (it
 *   covers what is behind) and a spark writes none (it only adds light).
 *
 * Per frame: one uniform write. No allocation.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import { createSeededRandom } from '../../shared';
import type { QualityPreset, QualityPresetId } from '../../shared';
import { setPaintedColor } from '../light';
import { mixHex, skyLookOf } from '../sky/sky-look';
import type { SkySetup } from '../sky/sky-math';

/** Flakes and sparks drawn at each preset. */
export const ASH_FLAKE_COUNTS: Readonly<Record<QualityPresetId, number>> = {
  low: 90,
  medium: 200,
  high: 420,
};
/** With the effects, after the vent streaks. */
export const ASH_FALL_RENDER_ORDER = -2;
/** The box around the camera the flakes wrap in, metres. */
const BOX_X = 80;
const BOX_Y = 50;
const BOX_Z = 80;
/** One in this many is a spark. */
const SPARK_SHARE = 0.28;
/** Wind (x, z) in m/s, how fast a flake sinks and how fast a spark rises. */
const WIND_X = 2.6;
const WIND_Z = 1.1;
const FLAKE_FALL = 1.3;
const SPARK_RISE = 3.4;
/** Metres above the sea over which the sparks thin out to 37 %. */
const SPARK_HEIGHT = 200;
/** Lava crimson (the map's scenery glow, never the "fly here" magenta). */
const SPARK_COLOR = 0xff3040;
const SPARK_GAIN = 1.6;

const VERTEX_SHADER = /* glsl */ `
attribute vec2 aCorner;  // -1..1
attribute vec4 aSeed;    // x: size 0..1, y: phase 0..1, z: spark when below uSpark.x, w: speed 0..1
uniform float uTime;
uniform vec3 uBox;       // the wrap box, metres
uniform vec3 uWind;      // x, z: wind m/s; y: flake fall m/s
uniform vec4 uSpark;     // x: share of sparks, y: rise m/s, z: sea Y, w: 1 / thin-out height
varying vec2 vCorner;
varying vec3 vKind;      // x: 1 for a spark, y: opacity, z: flicker

void main() {
  float spark = step(aSeed.z, uSpark.x);
  float speed = 0.6 + 0.8 * aSeed.w;
  vec3 p = position * uBox;
  p.x += uWind.x * uTime * speed;
  p.z += uWind.z * uTime * speed;
  p.y += mix(-uWind.y, uSpark.y, spark) * uTime * speed;
  // A flake flutters as it sinks.
  p.x += sin(uTime * (0.9 + aSeed.y) + aSeed.y * 40.0) * 0.8;
  p.z += cos(uTime * (0.7 + aSeed.x) + aSeed.x * 31.0) * 0.8;
  // Wrap into the box centred on the camera.
  vec3 world = cameraPosition + mod(p - cameraPosition + uBox * 0.5, uBox) - uBox * 0.5;

  vec4 view = viewMatrix * vec4(world, 1.0);
  float dist = length(view.xyz);
  // Small: a flake near the lens must stay a speck, not a blob that reads as dirt on the glass.
  float size = mix(0.035 + 0.05 * aSeed.x, 0.03 + 0.03 * aSeed.x, spark);
  view.xy += aCorner * size;

  // Gone before it crosses the lens, and before the box's edge (where it wraps).
  float edge = 0.5 * min(uBox.x, uBox.z);
  float opacity = smoothstep(2.5, 9.0, dist) * (1.0 - smoothstep(edge * 0.6, edge * 0.98, dist));
  // Sparks belong to the glow below: few of them high up.
  opacity *= mix(1.0, exp(-max(world.y - uSpark.z, 0.0) * uSpark.w), spark);

  vCorner = aCorner;
  vKind = vec3(spark, opacity, 0.6 + 0.4 * sin(uTime * (5.0 + 6.0 * aSeed.y) + aSeed.x * 50.0));
  gl_Position = projectionMatrix * view;
  if (opacity < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uAsh;
uniform vec3 uGlow;
varying vec2 vCorner;
varying vec3 vKind;

void main() {
  float r2 = dot(vCorner, vCorner);
  float dot_ = 1.0 - smoothstep(0.25, 1.0, r2);
  float a = dot_ * vKind.y;
  // Premultiplied: a flake covers (alpha), a spark only adds (no alpha).
  vec3 flake = uAsh * (a * 0.7);
  vec3 sparkle = uGlow * (a * vKind.z);
  gl_FragColor = vec4(mix(flake, sparkle, vKind.x), a * 0.7 * (1.0 - vKind.x));
}
`;

export interface AshFallOptions {
  /** The map's sky: the flakes take their grey from its ash and fog colours. */
  readonly sky: SkySetup;
  readonly cloudSeaY: number;
  readonly seed?: number;
}

export interface AshFall {
  /** Add to the scene. */
  readonly object: Mesh<BufferGeometry, ShaderMaterial>;
  /** Flakes and sparks drawn at the current preset. */
  readonly activeCount: number;
  update(timeS: number): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

/** Load-time: allocates the geometry. */
export function createAshFall(options: AshFallOptions, preset: QualityPreset): AshFall {
  const random = createSeededRandom(options.seed ?? 0xa54f);
  const count = ASH_FLAKE_COUNTS.high;
  const positions = new Float32Array(count * 4 * 3);
  const corners = new Float32Array(count * 4 * 2);
  const seeds = new Float32Array(count * 4 * 4);
  const indices = new Uint16Array(count * 6);
  const cornerX = [-1, 1, 1, -1];
  const cornerY = [-1, -1, 1, 1];
  for (let i = 0; i < count; i++) {
    const x = random();
    const y = random();
    const z = random();
    const s0 = random();
    const s1 = random();
    const s2 = random();
    const s3 = random();
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      corners[v * 2] = cornerX[c] ?? 0;
      corners[v * 2 + 1] = cornerY[c] ?? 0;
      seeds[v * 4] = s0;
      seeds[v * 4 + 1] = s1;
      seeds[v * 4 + 2] = s2;
      seeds[v * 4 + 3] = s3;
    }
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aCorner', new BufferAttribute(corners, 2));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 4));
  geometry.setIndex(new BufferAttribute(indices, 1));

  const look = skyLookOf(options.sky);
  const time = { value: 0 };
  const material = new ShaderMaterial({
    name: 'AshFall',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      // Ash in this air: its own grey, pulled a third of the way to the fog it floats in.
      uAsh: { value: setPaintedColor(new Color(), mixHex(look.moss, options.sky.fogColor, 0.35)) },
      uGlow: { value: new Color().setHex(SPARK_COLOR).multiplyScalar(SPARK_GAIN) },
      uBox: { value: new Vector3(BOX_X, BOX_Y, BOX_Z) },
      uWind: { value: new Vector3(WIND_X, FLAKE_FALL, WIND_Z) },
      uSpark: { value: new Vector4(SPARK_SHARE, SPARK_RISE, options.cloudSeaY, 1 / SPARK_HEIGHT) },
      uTime: time,
    },
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    premultipliedAlpha: true,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const object = new Mesh(geometry, material);
  object.name = 'AshFall';
  // The flakes follow the camera in the vertex shader: the geometry's own bounds mean nothing.
  object.frustumCulled = false;
  object.matrixAutoUpdate = false;
  object.renderOrder = ASH_FALL_RENDER_ORDER;

  let activeCount = 0;
  function setQuality(next: QualityPreset): void {
    activeCount = ASH_FLAKE_COUNTS[next.id];
    geometry.setDrawRange(0, activeCount * 6);
  }
  setQuality(preset);

  return {
    object,
    get activeCount(): number {
      return activeCount;
    },
    update(timeS: number): void {
      // Kept small so the positions keep their precision; the wrap is one jump in 100 minutes.
      time.value = timeS % 6000;
    },
    setQuality,
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
