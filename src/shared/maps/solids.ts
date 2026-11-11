/**
 * Primitive solids: the pure-data description of greybox map geometry. The sim (collision) and
 * the views (rendering) both build their meshes from the same list through `buildMapTriangles`,
 * so what you see is what you hit. Everything here is JSON-serialisable and three.js-free.
 *
 * CONVENTIONS
 * - World space is right-handed, +Y up, metres. Angles are radians.
 * - `position` is the CENTRE of the solid (the midpoint of its local bounding box).
 * - Orientation is `R = Ry(yaw) * Rx(pitch) * Rz(roll)`, i.e. three.js
 *   `new Euler(pitch, yaw, roll, 'YXZ')`. With pitch = roll = 0, local +X points along world
 *   `(cos yaw, 0, -sin yaw)`.
 */

import { TEAMS, TEAM_EMBER, TEAM_FROST } from '../constants';
import type { Vec3 } from '../math-types';

// --- Surface roles ---------------------------------------------------------------------------------

/**
 * What a surface is, not what colour it has: the view maps a role to a material/vertex colour
 * (docs/ART_DIRECTION.md, "Palette by role"). Index = the `u8` stored per vertex by
 * `buildMapTriangles`. Append only.
 */
export const MAP_SURFACE_ROLES = [
  'stone',
  'stoneShadow',
  'litEdge',
  'moss',
  'mossLight',
  'skyWell',
  'ember',
  'frost',
] as const;

export type MapSurfaceRole = (typeof MAP_SURFACE_ROLES)[number];

/** Greybox colour per role, sRGB hex (the palette table of docs/ART_DIRECTION.md). */
export const MAP_SURFACE_ROLE_COLORS: Readonly<Record<MapSurfaceRole, number>> = {
  stone: 0x4e6a86,
  stoneShadow: 0x2a3346,
  litEdge: 0xc9b79a,
  moss: 0x3f8f7a,
  mossLight: 0x8cc9a1,
  // Objectives are magenta.
  skyWell: 0xff3fa4,
  ember: TEAMS[TEAM_EMBER].color,
  frost: TEAMS[TEAM_FROST].color,
};

/** Role -> its index in MAP_SURFACE_ROLES (the per-vertex `u8`). */
export function mapSurfaceRoleIndex(role: MapSurfaceRole): number {
  return MAP_SURFACE_ROLES.indexOf(role);
}

// --- Solids ----------------------------------------------------------------------------------------

interface MapSolidBase {
  readonly role: MapSurfaceRole;
  /** Centre of the solid, world space. */
  readonly position: Vec3;
  /** Rotation about world +Y. */
  readonly yaw: number;
  /** Tilt about the (yawed) local X axis. */
  readonly pitch: number;
  /** Tilt about the local Z axis. */
  readonly roll: number;
}

/** A cuboid; `size` is the full extent along local X/Y/Z. */
export interface BoxSolid extends MapSolidBase {
  readonly kind: 'box';
  readonly size: Vec3;
}

/**
 * A (tapered) pillar with a regular `sides`-gon cross-section around local Y. The radii are
 * circumradii and must be > 0; ring vertex `k` sits at local angle `2*pi*k/sides` from +X
 * toward +Z.
 */
export interface PrismSolid extends MapSolidBase {
  readonly kind: 'prism';
  readonly radiusBottom: number;
  readonly radiusTop: number;
  readonly height: number;
  /** 3..MAX_PRISM_SIDES. */
  readonly sides: number;
}

/**
 * A ramp: the box of `size` cut along its diagonal. Full height at local -X, sloping down to
 * nothing at +X; the bottom (-Y) and back (-X) faces stay.
 */
export interface WedgeSolid extends MapSolidBase {
  readonly kind: 'wedge';
  readonly size: Vec3;
}

export type MapSolid = BoxSolid | PrismSolid | WedgeSolid;
export type MapSolidKind = MapSolid['kind'];

export const MIN_PRISM_SIDES = 3;
export const MAX_PRISM_SIDES = 32;

// --- Helpers (load-time; they allocate nothing but are not meant for per-tick use) -----------------

/**
 * Writes the solid's 3x3 rotation matrix into `out`, ROW-major: world = position + R * local,
 * with `R[row][col] = out[row * 3 + col]`.
 */
export function writeSolidRotation(solid: MapSolid, out: Float64Array): Float64Array {
  const cy = Math.cos(solid.yaw);
  const sy = Math.sin(solid.yaw);
  const cx = Math.cos(solid.pitch);
  const sx = Math.sin(solid.pitch);
  const cz = Math.cos(solid.roll);
  const sz = Math.sin(solid.roll);
  out[0] = cy * cz + sy * sx * sz;
  out[1] = sy * sx * cz - cy * sz;
  out[2] = sy * cx;
  out[3] = cx * sz;
  out[4] = cx * cz;
  out[5] = -sx;
  out[6] = cy * sx * sz - sy * cz;
  out[7] = sy * sz + cy * sx * cz;
  out[8] = cy * cx;
  return out;
}

const scratchRotation = new Float64Array(9);

/**
 * A lower bound on the distance from a world point to the solid's surface (0 inside). Exact for
 * boxes; a wedge is treated as its full box and a prism as a cylinder of its larger radius, so
 * the result never over-estimates the clearance.
 */
export function distanceToSolidBound(solid: MapSolid, x: number, y: number, z: number): number {
  const r = writeSolidRotation(solid, scratchRotation);
  const dx = x - solid.position.x;
  const dy = y - solid.position.y;
  const dz = z - solid.position.z;
  // local = R^T * d
  const lx = (r[0] ?? 0) * dx + (r[3] ?? 0) * dy + (r[6] ?? 0) * dz;
  const ly = (r[1] ?? 0) * dx + (r[4] ?? 0) * dy + (r[7] ?? 0) * dz;
  const lz = (r[2] ?? 0) * dx + (r[5] ?? 0) * dy + (r[8] ?? 0) * dz;
  if (solid.kind === 'prism') {
    const radial = Math.hypot(lx, lz) - Math.max(solid.radiusBottom, solid.radiusTop);
    const axial = Math.abs(ly) - solid.height * 0.5;
    return Math.hypot(Math.max(radial, 0), Math.max(axial, 0));
  }
  const ex = Math.max(Math.abs(lx) - solid.size.x * 0.5, 0);
  const ey = Math.max(Math.abs(ly) - solid.size.y * 0.5, 0);
  const ez = Math.max(Math.abs(lz) - solid.size.z * 0.5, 0);
  return Math.hypot(ex, ey, ez);
}

/** Negation that never produces -0, so mirrored data compares equal to hand-written data. */
function negate(value: number): number {
  return value === 0 ? 0 : -value;
}

function mirrorRole(role: MapSurfaceRole): MapSurfaceRole {
  if (role === 'ember') return 'frost';
  if (role === 'frost') return 'ember';
  return role;
}

/**
 * The solid reflected in the world plane z = 0 (the plane halfway between the team gates), with
 * the team roles swapped. Every solid kind is symmetric in its own local z, so the reflection is
 * again a plain solid: z, yaw and pitch change sign, roll stays.
 */
export function mirrorSolidZ(solid: MapSolid): MapSolid {
  return {
    ...solid,
    role: mirrorRole(solid.role),
    position: { x: solid.position.x, y: solid.position.y, z: negate(solid.position.z) },
    yaw: negate(solid.yaw),
    pitch: negate(solid.pitch),
  };
}
