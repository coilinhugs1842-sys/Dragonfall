/**
 * Placed map assets (T-4.5): a real map is a list of `MapPlacement`s, each one instance of an
 * asset type (hero rock, prop, gate, backdrop) built in Blender. The SAME list drives both sides:
 *
 * - the sim builds its collision triangles from the type's convex hulls x the placements
 *   (`buildPlacementTriangles`, used through `buildMapTriangles`), with no file or network access:
 *   the hulls are compiled in (./generated/shattered-spires-hulls.ts);
 * - the view draws the type's GLB at the same transforms (`buildPlacementInstances` gives one
 *   ready `InstancedMesh` matrix array per type).
 *
 * CONVENTIONS
 * - World space is right-handed, +Y up, metres; asset space is the GLB's own (+Y up).
 * - Transform: world = position + R * (scale * local), R = Ry(yaw) * Rx(pitch) * Rz(roll), the
 *   same order as map solids (three.js `Euler(pitch, yaw, roll, 'YXZ')`). With pitch = roll = 0,
 *   local +Z (an asset's "front", an arch's flight axis) points along world (sin yaw, 0, cos yaw)
 *   and local +X along (cos yaw, 0, -sin yaw).
 * - Scale is uniform and positive, so hull winding and GLB front faces never flip.
 *
 * Load-time code except where noted: it allocates its results once.
 */

import type { TeamId } from '../constants';
import type { Vec3 } from '../math-types';
import { CALDERA_ASSET_TYPES, CALDERA_HULL_QUANTUM } from './generated/emberfall-caldera-hulls';
import { SPIRES_ASSET_TYPES, SPIRES_HULL_QUANTUM } from './generated/shattered-spires-hulls';
import type { GeneratedMapAssetType } from './generated/shattered-spires-hulls';

/** Id of an asset type, e.g. `spire-tall` (the GLB's file name without extension). */
export type MapAssetTypeId = string;

export type MapAssetKind = GeneratedMapAssetType['kind'];

/** One placed instance. JSON-serialisable. */
export interface MapPlacement {
  readonly type: MapAssetTypeId;
  /** World position of the asset's origin. */
  readonly position: Vec3;
  /** Radians; see the conventions above. */
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** Uniform scale, > 0. */
  readonly scale: number;
  /** Team whose colour the asset's "TeamTint" material takes; absent = neutral. */
  readonly team?: TeamId;
  /** What the piece belongs to (`crown`, `gate`, `canyon`, `rim`, ...): for tools and debugging. */
  readonly group?: string;
}

/** Decoded asset type: the generated metadata plus its collision hulls as typed arrays. */
export interface MapAssetType {
  readonly id: MapAssetTypeId;
  readonly kind: MapAssetKind;
  /** Runtime GLB, relative to `public/assets/`; nodes `LOD0`, `LOD1`, ... */
  readonly glb: string;
  /** Triangles per LOD node, nearest first. */
  readonly lodTriangles: readonly number[];
  /** The GLB has a second material named `TeamTint`. */
  readonly hasTint: boolean;
  /** Bounding sphere radius around the origin at scale 1. */
  readonly radius: number;
  readonly boundsMin: Vec3;
  readonly boundsMax: Vec3;
  readonly anchor: 'base' | 'top' | 'centre';
  readonly top: { readonly y: number; readonly radius: number } | null;
  readonly opening: { readonly width: number; readonly height: number; readonly y: number } | null;
  /** Collision hull vertices, xyz in metres, asset space. Empty for decorative types. */
  readonly hullPositions: Float32Array;
  /** Index triples into `hullPositions`, counter-clockwise from outside. */
  readonly hullIndices: Uint16Array;
  readonly hullTriangles: number;
}

// --- base64 (no atob/Buffer: must run identically in node, a worker and the page) -------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(text: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i++) lookup[BASE64.charCodeAt(i)] = i;
  let length = text.length;
  while (length > 0 && text.charCodeAt(length - 1) === 61) length--;
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let o = 0;
  for (let i = 0; i < length; i++) {
    const value = lookup[text.charCodeAt(i)] ?? -1;
    if (value < 0) continue;
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[o++] = (bits >> bitCount) & 0xff;
    }
  }
  return out;
}

function decodeType(source: GeneratedMapAssetType, quantum: number): MapAssetType {
  const vertBytes = decodeBase64(source.verts);
  const triBytes = decodeBase64(source.tris);
  const vertView = new DataView(vertBytes.buffer, vertBytes.byteOffset, vertBytes.byteLength);
  const triView = new DataView(triBytes.buffer, triBytes.byteOffset, triBytes.byteLength);
  const hullPositions = new Float32Array(vertBytes.byteLength >> 1);
  for (let i = 0; i < hullPositions.length; i++) {
    hullPositions[i] = vertView.getInt16(i * 2, true) * quantum;
  }
  const hullIndices = new Uint16Array(triBytes.byteLength >> 1);
  for (let i = 0; i < hullIndices.length; i++) hullIndices[i] = triView.getUint16(i * 2, true);
  return {
    id: source.id,
    kind: source.kind,
    glb: source.glb,
    lodTriangles: source.lodTriangles,
    hasTint: source.hasTint,
    radius: source.radius,
    boundsMin: { x: source.boundsMin[0], y: source.boundsMin[1], z: source.boundsMin[2] },
    boundsMax: { x: source.boundsMax[0], y: source.boundsMax[1], z: source.boundsMax[2] },
    anchor: source.anchor,
    top: source.top,
    opening: source.opening,
    hullPositions,
    hullIndices,
    hullTriangles: hullIndices.length / 3,
  };
}

let decoded: ReadonlyMap<MapAssetTypeId, MapAssetType> | null = null;

/**
 * Every asset type of the shipped maps, decoded once per realm (page, worker, test). One
 * registry for all maps: Emberfall Caldera reuses a few of the first map's pieces (banners,
 * chains, the sky-well crystal), and type ids never repeat between the two lists.
 */
export function mapAssetTypes(): ReadonlyMap<MapAssetTypeId, MapAssetType> {
  if (decoded === null) {
    const map = new Map<MapAssetTypeId, MapAssetType>();
    for (const source of SPIRES_ASSET_TYPES) {
      map.set(source.id, decodeType(source, SPIRES_HULL_QUANTUM));
    }
    for (const source of CALDERA_ASSET_TYPES) {
      // A clash would silently swap one map's rock for the other's: the first map's type stays.
      if (!map.has(source.id)) map.set(source.id, decodeType(source, CALDERA_HULL_QUANTUM));
    }
    decoded = map;
  }
  return decoded;
}

export function mapAssetType(id: MapAssetTypeId): MapAssetType {
  const type = mapAssetTypes().get(id);
  if (type === undefined) throw new Error(`unknown map asset type "${id}"`);
  return type;
}

// --- Transforms -------------------------------------------------------------------------------------

/**
 * Writes the placement's 3x3 rotation, ROW-major (`R[row][col] = out[row * 3 + col]`), without
 * the scale. Allocation-free.
 */
export function writePlacementRotation(placement: MapPlacement, out: Float64Array): Float64Array {
  const cy = Math.cos(placement.yaw);
  const sy = Math.sin(placement.yaw);
  const cx = Math.cos(placement.pitch);
  const sx = Math.sin(placement.pitch);
  const cz = Math.cos(placement.roll);
  const sz = Math.sin(placement.roll);
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
 * Writes the placement's 4x4 world matrix at `out[offset..offset + 15]`, COLUMN-major like
 * three.js `Matrix4.elements` / `InstancedMesh.instanceMatrix`. Allocation-free.
 */
export function writePlacementMatrix(
  placement: MapPlacement,
  out: Float32Array | Float64Array | number[],
  offset = 0,
): void {
  const r = writePlacementRotation(placement, scratchRotation);
  const s = placement.scale;
  out[offset] = (r[0] ?? 0) * s;
  out[offset + 1] = (r[3] ?? 0) * s;
  out[offset + 2] = (r[6] ?? 0) * s;
  out[offset + 3] = 0;
  out[offset + 4] = (r[1] ?? 0) * s;
  out[offset + 5] = (r[4] ?? 0) * s;
  out[offset + 6] = (r[7] ?? 0) * s;
  out[offset + 7] = 0;
  out[offset + 8] = (r[2] ?? 0) * s;
  out[offset + 9] = (r[5] ?? 0) * s;
  out[offset + 10] = (r[8] ?? 0) * s;
  out[offset + 11] = 0;
  out[offset + 12] = placement.position.x;
  out[offset + 13] = placement.position.y;
  out[offset + 14] = placement.position.z;
  out[offset + 15] = 1;
}

/** A point of the asset (asset space) in world space. Allocates its result: load-time only. */
export function placementPoint(placement: MapPlacement, x: number, y: number, z: number): Vec3 {
  const r = writePlacementRotation(placement, scratchRotation);
  const s = placement.scale;
  return {
    x: placement.position.x + ((r[0] ?? 0) * x + (r[1] ?? 0) * y + (r[2] ?? 0) * z) * s,
    y: placement.position.y + ((r[3] ?? 0) * x + (r[4] ?? 0) * y + (r[5] ?? 0) * z) * s,
    z: placement.position.z + ((r[6] ?? 0) * x + (r[7] ?? 0) * y + (r[8] ?? 0) * z) * s,
  };
}

/** Wraps an angle to (-PI, PI], without ever producing -0. */
function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle - twoPi * Math.floor((angle + Math.PI) / twoPi);
  if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped === 0 ? 0 : wrapped;
}

function negate(value: number): number {
  return value === 0 ? 0 : -value;
}

/**
 * The placement turned half a turn about the world's vertical axis through `(centerX, centerZ)`:
 * the other team's copy of it. A proper rotation, so (unlike a mirror image) the twin uses the
 * same mesh and the map plays identically from both gates. Team tints swap.
 */
export function rotatePlacementHalfTurn(
  placement: MapPlacement,
  centerX = 0,
  centerZ = 0,
): MapPlacement {
  const twin: MapPlacement = {
    ...placement,
    position: {
      x: centerX + negate(placement.position.x - centerX),
      y: placement.position.y,
      z: centerZ + negate(placement.position.z - centerZ),
    },
    yaw: wrapAngle(placement.yaw + Math.PI),
  };
  if (placement.team === undefined) return twin;
  return { ...twin, team: placement.team === 0 ? 1 : 0 };
}

// --- Instances for the view ---------------------------------------------------------------------------

/** All placements of one asset type, ready for an `InstancedMesh`. */
export interface MapPlacementInstances {
  readonly type: MapAssetType;
  readonly count: number;
  /** 16 floats per instance, column-major. */
  readonly matrices: Float32Array;
  /** Bounding sphere per instance: x, y, z, radius (world), for culling and LOD picks. */
  readonly spheres: Float32Array;
  /** Uniform scale per instance (LOD distances scale with it). */
  readonly scales: Float32Array;
  /** Team per instance: 0, 1, or 255 for neutral. */
  readonly teams: Uint8Array;
  /** Index into the source placement list per instance. */
  readonly placementIndices: Uint32Array;
}

/** Team value of a neutral instance in `MapPlacementInstances.teams`. */
export const PLACEMENT_TEAM_NEUTRAL = 255;

/**
 * Groups placements by asset type, in first-appearance order, with their matrices. The view
 * makes one InstancedMesh per type and LOD (and per material) from this.
 */
export function buildPlacementInstances(
  placements: readonly MapPlacement[],
): readonly MapPlacementInstances[] {
  const byType = new Map<MapAssetTypeId, number[]>();
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    if (placement === undefined) continue;
    const list = byType.get(placement.type);
    if (list === undefined) byType.set(placement.type, [i]);
    else list.push(i);
  }
  const result: MapPlacementInstances[] = [];
  for (const [id, indices] of byType) {
    const type = mapAssetType(id);
    const count = indices.length;
    const matrices = new Float32Array(count * 16);
    const spheres = new Float32Array(count * 4);
    const scales = new Float32Array(count);
    const teams = new Uint8Array(count);
    const centreX = (type.boundsMin.x + type.boundsMax.x) * 0.5;
    const centreY = (type.boundsMin.y + type.boundsMax.y) * 0.5;
    const centreZ = (type.boundsMin.z + type.boundsMax.z) * 0.5;
    const boxRadius =
      Math.hypot(
        type.boundsMax.x - type.boundsMin.x,
        type.boundsMax.y - type.boundsMin.y,
        type.boundsMax.z - type.boundsMin.z,
      ) * 0.5;
    for (let n = 0; n < count; n++) {
      const placement = placements[indices[n] ?? 0];
      if (placement === undefined) continue;
      writePlacementMatrix(placement, matrices, n * 16);
      const centre = placementPoint(placement, centreX, centreY, centreZ);
      spheres[n * 4] = centre.x;
      spheres[n * 4 + 1] = centre.y;
      spheres[n * 4 + 2] = centre.z;
      spheres[n * 4 + 3] = boxRadius * placement.scale;
      scales[n] = placement.scale;
      teams[n] = placement.team ?? PLACEMENT_TEAM_NEUTRAL;
    }
    result.push({
      type,
      count,
      matrices,
      spheres,
      scales,
      teams,
      placementIndices: Uint32Array.from(indices),
    });
  }
  return result;
}

// --- Collision triangles ------------------------------------------------------------------------------

/** Hull triangles all placements of the list contribute (budget checks, sizing). */
export function countPlacementTriangles(placements: readonly MapPlacement[]): number {
  let total = 0;
  for (const placement of placements) total += mapAssetType(placement.type).hullTriangles;
  return total;
}

/**
 * Writes one placement's hull triangles in world space, FLAT (three fresh vertices per
 * triangle, unit face normal per vertex), at vertex `vertexStart`. `indices` get absolute vertex
 * indices. Returns the number of triangles written. `ups`, when given, receives 1 for vertices
 * of an up-facing triangle (normal.y above 0.7) and 0 otherwise.
 */
export function writePlacementTriangles(
  placement: MapPlacement,
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  vertexStart: number,
  indexStart: number,
  ups?: Uint8Array,
): number {
  const type = mapAssetType(placement.type);
  const r = writePlacementRotation(placement, scratchRotation);
  const s = placement.scale;
  const px = placement.position.x;
  const py = placement.position.y;
  const pz = placement.position.z;
  const r0 = (r[0] ?? 0) * s;
  const r1 = (r[1] ?? 0) * s;
  const r2 = (r[2] ?? 0) * s;
  const r3 = (r[3] ?? 0) * s;
  const r4 = (r[4] ?? 0) * s;
  const r5 = (r[5] ?? 0) * s;
  const r6 = (r[6] ?? 0) * s;
  const r7 = (r[7] ?? 0) * s;
  const r8 = (r[8] ?? 0) * s;
  const src = type.hullPositions;
  const tris = type.hullIndices;
  let v = vertexStart;
  let o = indexStart;
  for (let t = 0; t < tris.length; t += 3) {
    const first = v;
    for (let corner = 0; corner < 3; corner++) {
      const i = (tris[t + corner] ?? 0) * 3;
      const lx = src[i] ?? 0;
      const ly = src[i + 1] ?? 0;
      const lz = src[i + 2] ?? 0;
      positions[v * 3] = px + r0 * lx + r1 * ly + r2 * lz;
      positions[v * 3 + 1] = py + r3 * lx + r4 * ly + r5 * lz;
      positions[v * 3 + 2] = pz + r6 * lx + r7 * ly + r8 * lz;
      indices[o++] = v;
      v++;
    }
    const ax = positions[first * 3] ?? 0;
    const ay = positions[first * 3 + 1] ?? 0;
    const az = positions[first * 3 + 2] ?? 0;
    const ux = (positions[first * 3 + 3] ?? 0) - ax;
    const uy = (positions[first * 3 + 4] ?? 0) - ay;
    const uz = (positions[first * 3 + 5] ?? 0) - az;
    const wx = (positions[first * 3 + 6] ?? 0) - ax;
    const wy = (positions[first * 3 + 7] ?? 0) - ay;
    const wz = (positions[first * 3 + 8] ?? 0) - az;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }
    for (let corner = 0; corner < 3; corner++) {
      normals[(first + corner) * 3] = nx;
      normals[(first + corner) * 3 + 1] = ny;
      normals[(first + corner) * 3 + 2] = nz;
      if (ups !== undefined) ups[first + corner] = ny > 0.7 ? 1 : 0;
    }
  }
  return tris.length / 3;
}
