/**
 * Heat vents you can see: streaks of hot air rising up every vent's column (docs/GAME_DESIGN.md,
 * Emberfall Caldera: "rising heat vents (free speed)").
 *
 * The streaks show exactly what the sim does (`heatVentStrength`, src/shared/maps/vents.ts):
 * they fill the column to its radius, are brightest from the mouth to
 * `VENT_TUNING.fullHeightFraction` of the height and fade to nothing at the top. They glow in
 * the palette's magenta, the map's colour for "fly here" (crimson is lava: scenery).
 *
 * Cost control (the overdraw rule in docs/PERFORMANCE.md):
 * - ONE draw call for every vent of the map: each streak is four vertices of one geometry,
 *   moved up its column and turned to the camera around the vertical in the vertex shader.
 *   The draw range caps the count per preset; any prefix of the list is spread over all vents.
 * - A streak fades out as the camera comes close and when it is seen end-on from above or
 *   below, and is then moved out of the clip volume: flying up a vent never fills the screen
 *   with additive quads.
 * - No texture fetch.
 *
 * Per frame: one uniform write. No allocation.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  Vector4,
} from 'three';
import { VENT_TUNING, createSeededRandom } from '../../shared';
import type { MapVent, QualityPreset, QualityPresetId } from '../../shared';
import { WORLD_LIGHT_FOG_PARS_FRAGMENT, createHazeUniforms } from '../light';
import type { SkySetup } from '../sky/sky-math';

/** Streaks per unit of vent weight (`ventCardWeight`) at each preset. */
export const VENT_CARDS_PER_WEIGHT: Readonly<Record<QualityPresetId, number>> = {
  low: 7,
  medium: 12,
  high: 20,
};
/** The palette's objective magenta (docs/ART_DIRECTION.md): "fly here". */
export const VENT_GLOW_COLOR = 0xff3fa4;
/** After the light shafts (-4), before the effects. */
export const VENT_COLUMN_RENDER_ORDER = -3;
/** Floats per streak in `placeVentCards`: mouth x, y, z, radius, height, seed, seed. */
export const VENT_CARD_STRIDE = 7;
/** A column this wide gets one share of streaks; the caldera's flank vents. */
const UNIT_RADIUS = 38;
/** Streak half-width and length in metres, and how fast it rises, in a unit-radius column. */
const CARD_HALF_WIDTH = 5;
const CARD_LENGTH = 54;
const RISE_SPEED = 26;
/** Light one streak adds at its centre, as a multiple of the glow colour (scene-linear). */
const CARD_STRENGTH = 0.36;

/** Shares of streaks a vent gets: a wider column needs more to look as full. */
export function ventCardWeight(vent: Readonly<MapVent>): number {
  return Math.max(1, Math.min(3, Math.round(vent.radius / UNIT_RADIUS)));
}

/** Streaks drawn for `vents` at a preset. */
export function ventCardCount(vents: readonly MapVent[], preset: QualityPresetId): number {
  let weight = 0;
  for (const vent of vents) weight += ventCardWeight(vent);
  return weight * VENT_CARDS_PER_WEIGHT[preset];
}

/**
 * Deterministic streak list for the High count, `VENT_CARD_STRIDE` floats each, ordered so that
 * the first `ventCardCount(vents, preset)` of them give every vent its share. Pure: tested in
 * node.
 */
export function placeVentCards(vents: readonly MapVent[], seed: number): Float32Array {
  const random = createSeededRandom(seed);
  const rounds = VENT_CARDS_PER_WEIGHT.high;
  const out = new Float32Array(ventCardCount(vents, 'high') * VENT_CARD_STRIDE);
  let o = 0;
  for (let round = 0; round < rounds; round++) {
    for (const vent of vents) {
      const weight = ventCardWeight(vent);
      for (let w = 0; w < weight; w++) {
        out[o] = vent.position.x;
        out[o + 1] = vent.position.y;
        out[o + 2] = vent.position.z;
        out[o + 3] = vent.radius;
        out[o + 4] = vent.height;
        out[o + 5] = random();
        out[o + 6] = random();
        o += VENT_CARD_STRIDE;
      }
    }
  }
  return out;
}

const VERTEX_SHADER = /* glsl */ `
attribute vec2 aCorner;  // x: side -1 / +1, y: 0 at the tail .. 1 at the head
attribute vec4 aVent;    // x: radius (m), y: height (m), z and w: seeds 0..1
uniform float uTime;
uniform vec4 uCard;      // x: half-width, y: length, z: rise speed (unit column), w: full-strength share of the height
varying vec3 vUvw;       // x: across -1..1, y: along 0..1, z: brightness
varying vec3 vWorld;

void main() {
  float size = sqrt(aVent.x * ${(1 / UNIT_RADIUS).toFixed(6)});
  // t: how far up the column this streak is, 0 at the mouth .. 1 at the top, then again.
  float t = fract(aVent.z + uTime * uCard.z * (0.7 + 0.6 * aVent.w) / aVent.y);
  // The same shape as the push a dragon feels: full to uCard.w of the height, then fading out.
  float strength = smoothstep(0.0, 0.07, t) * clamp((1.0 - t) / max(1.0 - uCard.w, 1e-3), 0.0, 1.0);
  // Spread over the disc (sqrt: even by area), turning slowly as it climbs.
  float angle = aVent.w * 6.2832 + uTime * 0.11 + t * 1.7;
  float radial = aVent.x * 0.86 * sqrt(fract(aVent.z * 13.7 + aVent.w * 3.1));
  vec3 centre = position + vec3(cos(angle) * radial, t * aVent.y, sin(angle) * radial);

  vec3 toCamera = cameraPosition - centre;
  float dist = length(toCamera);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera) + vec3(1e-5, 0.0, 0.0));
  float halfWidth = uCard.x * size * (0.6 + 0.8 * fract(aVent.z * 29.3));
  float len = uCard.y * size;
  vec3 world = centre + side * (aCorner.x * halfWidth) + vec3(0.0, (aCorner.y - 0.5) * len, 0.0);

  // Close to the eye a streak would be a screen-wide smear: gone before that.
  float fade = smoothstep(len * 0.3, len * 0.9, dist);
  // Seen from straight above or below it is a fat bright bar.
  fade *= 1.0 - smoothstep(0.82, 0.97, abs(toCamera.y) / max(dist, 1e-3));

  vUvw = vec3(aCorner.x, aCorner.y, strength * fade);
  vWorld = world;
  gl_Position = projectionMatrix * (viewMatrix * vec4(world, 1.0));
  if (vUvw.z < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
varying vec3 vUvw;
varying vec3 vWorld;
${WORLD_LIGHT_FOG_PARS_FRAGMENT}

void main() {
  float across = 1.0 - vUvw.x * vUvw.x;
  across *= across;
  // A long soft tail and a rounder head: it reads as moving up.
  float along = smoothstep(0.0, 0.55, vUvw.y) * (1.0 - smoothstep(0.72, 1.0, vUvw.y));
  float dist = length(vWorld - cameraPosition);
  // Vents are waypoints: the fog thins them, but less than it thins rock.
  float clear = 1.0 - 0.7 * wlFogFactor(vWorld, dist);
  gl_FragColor = vec4(uColor * (across * along * vUvw.z * clear), 1.0);
}
`;

export interface VentColumnsOptions {
  readonly vents: readonly MapVent[];
  /** The map's sky: the streaks sit in its fog. */
  readonly sky: SkySetup;
  readonly cloudSeaY: number;
  readonly seed?: number;
}

export interface VentColumns {
  /** Add to the scene. */
  readonly object: Mesh<BufferGeometry, ShaderMaterial>;
  /** Streaks drawn at the current preset (each is one transparent quad). */
  readonly activeCount: number;
  update(timeS: number): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

/** Load-time: allocates the geometry. */
export function createVentColumns(options: VentColumnsOptions, preset: QualityPreset): VentColumns {
  const vents = options.vents;
  const placed = placeVentCards(vents, options.seed ?? 0x7e47);
  const count = placed.length / VENT_CARD_STRIDE;
  const positions = new Float32Array(count * 4 * 3);
  const corners = new Float32Array(count * 4 * 2);
  const shapes = new Float32Array(count * 4 * 4);
  const indices = new Uint16Array(count * 6);
  const cornerX = [-1, 1, 1, -1];
  const cornerY = [0, 0, 1, 1];
  for (let i = 0; i < count; i++) {
    const o = i * VENT_CARD_STRIDE;
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      positions[v * 3] = placed[o] ?? 0;
      positions[v * 3 + 1] = placed[o + 1] ?? 0;
      positions[v * 3 + 2] = placed[o + 2] ?? 0;
      corners[v * 2] = cornerX[c] ?? 0;
      corners[v * 2 + 1] = cornerY[c] ?? 0;
      shapes[v * 4] = placed[o + 3] ?? 1;
      shapes[v * 4 + 1] = placed[o + 4] ?? 1;
      shapes[v * 4 + 2] = placed[o + 5] ?? 0;
      shapes[v * 4 + 3] = placed[o + 6] ?? 0;
    }
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aCorner', new BufferAttribute(corners, 2));
  geometry.setAttribute('aVent', new BufferAttribute(shapes, 4));
  geometry.setIndex(new BufferAttribute(indices, 1));

  const time = { value: 0 };
  const material = new ShaderMaterial({
    name: 'VentColumns',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      ...createHazeUniforms(options.sky, options.cloudSeaY),
      uColor: { value: new Color().setHex(VENT_GLOW_COLOR).multiplyScalar(CARD_STRENGTH) },
      uCard: {
        value: new Vector4(CARD_HALF_WIDTH, CARD_LENGTH, RISE_SPEED, VENT_TUNING.fullHeightFraction),
      },
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
  object.name = 'VentColumns';
  // The streaks are placed in the vertex shader: the geometry's own bounds mean nothing.
  object.frustumCulled = false;
  object.matrixAutoUpdate = false;
  object.renderOrder = VENT_COLUMN_RENDER_ORDER;

  let activeCount = 0;
  function setQuality(next: QualityPreset): void {
    activeCount = Math.min(count, ventCardCount(vents, next.id));
    geometry.setDrawRange(0, activeCount * 6);
    object.visible = activeCount > 0;
  }
  setQuality(preset);

  return {
    object,
    get activeCount(): number {
      return activeCount;
    },
    update(timeS: number): void {
      // Kept small so `fract` keeps its precision; the wrap is one jump in 100 minutes.
      time.value = timeS % 6000;
    },
    setQuality,
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
