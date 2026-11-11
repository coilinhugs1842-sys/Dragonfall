/**
 * Pure colour and culling maths for the greybox map view (no three.js, node-testable).
 *
 * VERTEX COLOURS IN three r187: with `ColorManagement` enabled (the default) a `color` attribute
 * is taken as-is in the LINEAR-sRGB working space; only `Color.setHex` and textures are
 * converted for you. The palette in docs/ART_DIRECTION.md is sRGB hex, so every role colour
 * goes through the sRGB decode below before it is written to the attribute.
 */

import { MAP_SURFACE_ROLES, MAP_SURFACE_ROLE_COLORS } from '../../shared';
import type { MapSurfaceRole } from '../../shared';

/** sRGB transfer function, one channel, 0..1 -> linear 0..1 (IEC 61966-2-1, as three.js). */
export function srgbChannelToLinear(value: number): number {
  return value < 0.04045
    ? value * 0.0773993808
    : Math.pow(value * 0.9478672986 + 0.0521327014, 2.4);
}

/** Writes the linear RGB of an sRGB hex colour (0xRRGGBB) to `out[offset..offset + 2]`. */
export function writeLinearFromSrgbHex(hex: number, out: Float32Array, offset = 0): void {
  out[offset] = srgbChannelToLinear(((hex >> 16) & 255) / 255);
  out[offset + 1] = srgbChannelToLinear(((hex >> 8) & 255) / 255);
  out[offset + 2] = srgbChannelToLinear((hex & 255) / 255);
}

/** Linear RGB per MAP_SURFACE_ROLES index (3 floats each): the lookup the bake reads. */
export function createRolePalette(
  colors: Readonly<Record<MapSurfaceRole, number>> = MAP_SURFACE_ROLE_COLORS,
): Float32Array {
  const palette = new Float32Array(MAP_SURFACE_ROLES.length * 3);
  for (let i = 0; i < MAP_SURFACE_ROLES.length; i++) {
    const role = MAP_SURFACE_ROLES[i];
    if (role !== undefined) writeLinearFromSrgbHex(colors[role], palette, i * 3);
  }
  return palette;
}

/** Roles that read as light sources (objective, team markers): the bake never darkens them. */
const GLOW_ROLES: readonly MapSurfaceRole[] = ['skyWell', 'ember', 'frost'];

/** One flag per MAP_SURFACE_ROLES index: 1 = keep at full brightness. */
export function createGlowRoleMask(): Uint8Array {
  const mask = new Uint8Array(MAP_SURFACE_ROLES.length);
  for (let i = 0; i < MAP_SURFACE_ROLES.length; i++) {
    const role = MAP_SURFACE_ROLES[i];
    if (role !== undefined && GLOW_ROLES.includes(role)) mask[i] = 1;
  }
  return mask;
}

export interface MapShadeOptions {
  /** World Y where the darkening is strongest (the cloud-sea surface). */
  readonly baseY: number;
  /** Metres above `baseY` over which the shade rises to 1. */
  readonly gradientHeight: number;
  /** Brightness multiplier at and below `baseY`, 0..1. */
  readonly baseShade: number;
  /** Extra darkening of faces that point straight down, 0..1 (fake ambient occlusion). */
  readonly undersideShade: number;
}

export const DEFAULT_MAP_SHADE: Omit<MapShadeOptions, 'baseY'> = {
  gradientHeight: 320,
  baseShade: 0.42,
  undersideShade: 0.3,
};

/**
 * Brightness multiplier for a vertex at height `y` on a face whose unit normal has the vertical
 * component `normalY`: a smooth ramp from `baseShade` at the base to 1 at `gradientHeight`
 * above it, times a darkening of downward faces. Always in (0, 1].
 */
export function mapVertexShade(y: number, normalY: number, shade: MapShadeOptions): number {
  let t = shade.gradientHeight > 0 ? (y - shade.baseY) / shade.gradientHeight : 1;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  // Ease-out: most of the darkening sits in the lowest third, where the cloud sea swallows it.
  const ramp = 1 - (1 - t) * (1 - t);
  const height = shade.baseShade + (1 - shade.baseShade) * ramp;
  const down = normalY < 0 ? -normalY : 0;
  return height * (1 - shade.undersideShade * down);
}

/**
 * Bakes role colour x shade into a new linear-RGB `Float32Array` (3 per vertex) for the chunk
 * whose attribute slices are given. Load-time code.
 */
export function bakeMapVertexColors(
  positions: Float32Array,
  normals: Float32Array,
  roles: Uint8Array,
  palette: Float32Array,
  glowMask: Uint8Array,
  shade: MapShadeOptions,
): Float32Array {
  const vertexCount = roles.length;
  const colors = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const role = roles[i] ?? 0;
    const o = i * 3;
    const factor =
      glowMask[role] === 1 ? 1 : mapVertexShade(positions[o + 1] ?? 0, normals[o + 1] ?? 0, shade);
    const p = role * 3;
    colors[o] = (palette[p] ?? 0) * factor;
    colors[o + 1] = (palette[p + 1] ?? 0) * factor;
    colors[o + 2] = (palette[p + 2] ?? 0) * factor;
  }
  return colors;
}

/**
 * Distance at which exp2 fog (`1 - exp(-(density * d)^2)`, three's FogExp2) hides
 * `hiddenFraction` of an object's colour. Infinity when there is no fog.
 */
export function fogHiddenDistance(fogDensity: number, hiddenFraction: number): number {
  if (!(fogDensity > 0) || !(hiddenFraction > 0)) return Infinity;
  if (hiddenFraction >= 1) return Infinity;
  return Math.sqrt(-Math.log(1 - hiddenFraction)) / fogDensity;
}

/** True when a bounding sphere reaches inside `distance` of the eye. Allocation-free. */
export function sphereWithinDistance(
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  distance: number,
): boolean {
  const reach = distance + radius;
  const dx = centerX - eyeX;
  const dy = centerY - eyeY;
  const dz = centerZ - eyeZ;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}
