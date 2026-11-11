/**
 * Pure numbers behind the world lighting: display-referred ("painted") colours, the shadow
 * frustum fit and the blob-shadow maths. No three.js, no DOM: tested in node. The GLSL in
 * ./light-glsl.ts implements the same formulas; change both together.
 */
import { inverseTonemapFilmic, srgbDecode } from '../../render/post/post-math';
import type { QualityPreset, Vec3 } from '../../shared';

/** A mutable RGB triple; three's `Color` fits. */
export interface RgbTarget {
  r: number;
  g: number;
  b: number;
}

/**
 * Writes the SCENE-linear colour that the post pass shows as sRGB `hex`.
 *
 * The scene is tone-mapped in the post pass, so a colour that must come out as an exact
 * palette value (sky, fog, clouds: everything painted rather than lit) is authored through the
 * inverse of the tone curve. `gain` multiplies the result (above 1 = HDR, picked up by bloom).
 */
export function setPaintedColor<T extends RgbTarget>(target: T, hex: number, gain = 1): T {
  target.r = inverseTonemapFilmic(srgbDecode(((hex >> 16) & 0xff) / 255)) * gain;
  target.g = inverseTonemapFilmic(srgbDecode(((hex >> 8) & 0xff) / 255)) * gain;
  target.b = inverseTonemapFilmic(srgbDecode((hex & 0xff) / 255)) * gain;
  return target;
}

// --- Haze: the fog colour as a function of the view direction -------------------------------------
/** Weights of the two sun lobes added to the fog colour toward the sun (cos^8 and cos^2). */
export const HAZE_GLOW_TIGHT = 0.22;
export const HAZE_GLOW_WIDE = 0.05;

/** Sun in-scatter factor for a view direction at `cosAngle` to the sun. Mirrors `wlHaze`. */
export function hazeGlow(cosAngle: number): number {
  const s = cosAngle > 0 ? cosAngle : 0;
  const s2 = s * s;
  const s8 = s2 * s2 * s2 * s2;
  return s8 * HAZE_GLOW_TIGHT + s2 * HAZE_GLOW_WIDE;
}

/** Metres above the cloud sea over which the sea haze thins out to nothing. */
export const SEA_HAZE_HEIGHT = 130;
/** Most of a far object that the sea haze alone can hide at sea level. */
export const SEA_HAZE_STRENGTH = 0.6;
/** The haze needs distance to build up: this is its 1/e length in metres. */
export const SEA_HAZE_DISTANCE = 400;

/**
 * Fog opacity of a point `distance` metres away at `heightAboveSea`: exp2 distance fog combined
 * with a haze layer lying on the cloud sea. Mirrors `wlFogFactor`.
 */
export function fogFactor(density: number, distance: number, heightAboveSea: number): number {
  const x = density * distance;
  const far = 1 - Math.exp(-x * x);
  let h = 1 - heightAboveSea / SEA_HAZE_HEIGHT;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const haze = h * h * SEA_HAZE_STRENGTH * (1 - Math.exp(-distance / SEA_HAZE_DISTANCE));
  return 1 - (1 - far) * (1 - haze);
}

// --- Shadow strategy ------------------------------------------------------------------------------
export type ShadowMode = 'none' | 'blobs' | 'map';

export interface ShadowPlan {
  readonly mode: ShadowMode;
  /** Shadow map edge in texels (0 without a map). */
  readonly mapSize: number;
  /** Half-edge in metres of the square the map covers, centred in front of the camera. */
  readonly range: number;
  /** Metres from the camera to the centre of that square, along the view direction. */
  readonly focusDistance: number;
}

/** Most blob casters the shader loops over (Low). */
export const MAX_SHADOW_BLOBS = 4;

/**
 * Low: no shadow pass; up to four analytic sphere ("blob") shadows in the receiving shader.
 * Medium: one 1024 map over a 36 m half-range around the local dragon (3.5 cm texels x PCF):
 *   enough for dragons to shade themselves, each other and rock they skim.
 * High: one 2048 map over 80 m, so rocks and props cast too (8 cm texels).
 * The map fades out at its edge, so the range never shows as a line.
 */
export function shadowPlanFor(preset: QualityPreset): ShadowPlan {
  if (preset.shadowMapSize <= 0 || preset.shadowCasters === 'none') {
    return {
      mode: preset.blobShadows ? 'blobs' : 'none',
      mapSize: 0,
      range: 0,
      focusDistance: 0,
    };
  }
  const all = preset.shadowCasters === 'all';
  return {
    mode: 'map',
    mapSize: preset.shadowMapSize,
    range: all ? 80 : 36,
    focusDistance: all ? 44 : 16,
  };
}

/** Distance the sun's shadow camera sits behind the focus, beyond the range: casters above. */
export const SHADOW_CASTER_MARGIN = 260;

/**
 * Moves `focus` to the nearest shadow-texel centre, in place, and returns it. The shadow
 * camera looks along -`sunDir` with world +Y as its up hint (what three's `lookAt` does), so
 * the texel grid lies along `right = up x sunDir` and `top = sunDir x right`. Snapping the
 * focus to that grid keeps shadow edges from crawling while the camera moves.
 */
export function snapShadowFocus<T extends { x: number; y: number; z: number }>(
  focus: T,
  sunDir: Vec3,
  texelWorld: number,
): T {
  if (!(texelWorld > 0)) return focus;
  // right = (0, 1, 0) x sunDir
  let rx = sunDir.z;
  let rz = -sunDir.x;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-6) return focus; // sun straight overhead: lookAt is degenerate, leave it
  rx /= rl;
  rz /= rl;
  // top = sunDir x right
  const tx = sunDir.y * rz;
  const ty = sunDir.z * rx - sunDir.x * rz;
  const tz = -sunDir.y * rx;
  const u = focus.x * rx + focus.z * rz;
  const v = focus.x * tx + focus.y * ty + focus.z * tz;
  const du = Math.round(u / texelWorld) * texelWorld - u;
  const dv = Math.round(v / texelWorld) * texelWorld - v;
  focus.x += rx * du + tx * dv;
  focus.y += ty * dv;
  focus.z += rz * du + tz * dv;
  return focus;
}

/**
 * How much of the sun a sphere of `radius` at `centre` hides from point `p` (0..1 before the
 * strength). Mirrors the WL_BLOBS loop: soft disc around the sun ray through `p`, only for
 * casters on the sun's side and beyond their own radius (a caster never shades itself), wider
 * and weaker with distance.
 */
export function blobShadow(p: Vec3, centre: Vec3, radius: number, sunDir: Vec3): number {
  if (!(radius > 0)) return 0;
  const vx = centre.x - p.x;
  const vy = centre.y - p.y;
  const vz = centre.z - p.z;
  const t = vx * sunDir.x + vy * sunDir.y + vz * sunDir.z;
  const d2 = vx * vx + vy * vy + vz * vz - t * t;
  const r2 = radius * radius;
  const disc = 1 - smooth(r2 * 0.15, r2 * (1 + Math.max(t, 0) * 0.02), d2);
  const side = smooth(radius * 0.6, radius * 1.6, t);
  return (disc * side) / (1 + Math.max(t, 0) * 0.012);
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
