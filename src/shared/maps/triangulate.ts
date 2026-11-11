/**
 * Turns a map's primitive solids into one triangle soup that BOTH sides consume: the sim wraps
 * it in a `BufferGeometry` + BVH for collision, the view wraps per-chunk slices in merged
 * meshes. Same function, same solids: collision == visuals.
 *
 * OUTPUT LAYOUT (decided here, rely on it)
 * - Indexed triangles, counter-clockwise seen from OUTSIDE (three.js front faces); every solid
 *   is a closed volume with positive signed volume.
 * - FLAT SHADED: vertices are shared only inside one planar face (a quad or a cap n-gon), never
 *   across faces, and `normals` already holds the unit face normal per vertex. The view needs no
 *   `computeVertexNormals` and no `flatShading` flag.
 * - `roles` holds one MAP_SURFACE_ROLES index per vertex (a solid has a single role).
 * - Triangles are grouped by world chunk: a solid belongs entirely to the chunk that contains
 *   its `position`, so a chunk's vertices and indices are two contiguous ranges. `indices` are
 *   absolute; `sliceMapChunk` rebases them for a per-chunk geometry.
 *
 * Load-time code: it allocates its result once and is not meant for a per-frame path.
 */

import type { MapManifest } from '../manifests';
import type { Vec3 } from '../math-types';
import type { MapSolid } from './solids';
import {
  MAX_PRISM_SIDES,
  MIN_PRISM_SIDES,
  mapSurfaceRoleIndex,
  writeSolidRotation,
} from './solids';

/** Used when neither the options nor the map give a chunk size (docs/PERFORMANCE.md). */
export const DEFAULT_MAP_CHUNK_SIZE = 250;

export interface MapTriangleOptions {
  /**
   * Low-detail switch for collision: prisms with more sides are rebuilt with this many (same
   * circumradius, so the coarser prism sits INSIDE the detailed one by at most
   * `radius * (1 - cos(pi / maxPrismSides))`). Default: keep every prism as authored, which
   * makes the collision mesh identical to the visual one.
   */
  readonly maxPrismSides?: number;
  /** Chunk edge in metres. Default: `map.chunkSize`, else DEFAULT_MAP_CHUNK_SIZE. */
  readonly chunkSize?: number;
}

/** What `buildMapTriangles` needs from a map; a MapManifest with `solids` fits. */
export type MapTriangleSource = Pick<MapManifest, 'size' | 'solids' | 'chunkSize'> & {
  readonly colliders: Pick<MapManifest['colliders'], 'stormCenter'>;
};

/** One world chunk's share of the triangle soup. `center`/`radius` match MapChunk's sphere. */
export interface MapTriangleChunk {
  /** `<cellX>_<cellZ>`. */
  readonly id: string;
  /** Grid cell, 0-based from the map's -X/-Z corner. */
  readonly cellX: number;
  readonly cellZ: number;
  /** Range in `indices` (a multiple of 3). */
  readonly indexStart: number;
  readonly indexCount: number;
  /** Range in the per-vertex arrays, in vertices. */
  readonly vertexStart: number;
  readonly vertexCount: number;
  /** Bounding sphere of the chunk's vertices, for culling. */
  readonly center: Vec3;
  readonly radius: number;
}

export interface MapTriangles {
  /** xyz per vertex, world space. */
  readonly positions: Float32Array;
  /** Unit face normal per vertex. */
  readonly normals: Float32Array;
  /** MAP_SURFACE_ROLES index per vertex. */
  readonly roles: Uint8Array;
  /** Absolute vertex indices, 3 per triangle. */
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Non-empty chunks only, ordered by cellZ then cellX. */
  readonly chunks: readonly MapTriangleChunk[];
}

/** A chunk cut out of MapTriangles: attribute VIEWS (no copy) plus chunk-local indices. */
export interface MapChunkSlice {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly roles: Uint8Array;
  /** Rebased to the slice; `Uint16Array` whenever the chunk has at most 65535 vertices. */
  readonly indices: Uint16Array | Uint32Array;
}

/** One solid on its own, for tests, previews and placeholder props. */
export interface SolidTriangles {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

// --- Counting ----------------------------------------------------------------------------------------

function clampSides(sides: number, maxPrismSides: number): number {
  const wanted = Math.min(Math.floor(sides), Math.floor(maxPrismSides), MAX_PRISM_SIDES);
  return Math.max(wanted, MIN_PRISM_SIDES);
}

function solidVertexCount(solid: MapSolid, maxPrismSides: number): number {
  if (solid.kind === 'box') return 24;
  if (solid.kind === 'wedge') return 18;
  return clampSides(solid.sides, maxPrismSides) * 6;
}

function solidTriangleCount(solid: MapSolid, maxPrismSides: number): number {
  if (solid.kind === 'box') return 12;
  if (solid.kind === 'wedge') return 8;
  return clampSides(solid.sides, maxPrismSides) * 4 - 4;
}

/** Triangles `buildMapTriangles` would emit, without building them (budget checks). */
export function countMapTriangles(
  solids: readonly MapSolid[],
  options: MapTriangleOptions = {},
): number {
  const maxPrismSides = options.maxPrismSides ?? MAX_PRISM_SIDES;
  let total = 0;
  for (const solid of solids) total += solidTriangleCount(solid, maxPrismSides);
  return total;
}

// --- Writer ------------------------------------------------------------------------------------------

interface Writer {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly roles: Uint8Array | null;
  readonly indices: Uint32Array;
  vertex: number;
  index: number;
}

// Module scratch: the current solid's transform and the face being assembled.
const rotation = new Float64Array(9);
const origin = new Float64Array(3);
const face = new Float64Array(MAX_PRISM_SIDES * 3);
let faceCount = 0;
let faceRole = 0;

function beginFace(): void {
  faceCount = 0;
}

/** Appends a corner (solid-local coordinates) to the face, transformed to world space. */
function corner(lx: number, ly: number, lz: number): void {
  const o = faceCount * 3;
  face[o] =
    (origin[0] ?? 0) + (rotation[0] ?? 0) * lx + (rotation[1] ?? 0) * ly + (rotation[2] ?? 0) * lz;
  face[o + 1] =
    (origin[1] ?? 0) + (rotation[3] ?? 0) * lx + (rotation[4] ?? 0) * ly + (rotation[5] ?? 0) * lz;
  face[o + 2] =
    (origin[2] ?? 0) + (rotation[6] ?? 0) * lx + (rotation[7] ?? 0) * ly + (rotation[8] ?? 0) * lz;
  faceCount++;
}

/** Emits the convex planar face (corners counter-clockwise from outside) as a triangle fan. */
function endFace(w: Writer): void {
  // Newell's method: robust for any convex polygon, including thin trapezoids.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < faceCount; i++) {
    const a = i * 3;
    const b = ((i + 1) % faceCount) * 3;
    const ax = face[a] ?? 0;
    const ay = face[a + 1] ?? 0;
    const az = face[a + 2] ?? 0;
    const bx = face[b] ?? 0;
    const by = face[b + 1] ?? 0;
    const bz = face[b + 2] ?? 0;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;

  const first = w.vertex;
  for (let i = 0; i < faceCount; i++) {
    const src = i * 3;
    const dst = w.vertex * 3;
    w.positions[dst] = face[src] ?? 0;
    w.positions[dst + 1] = face[src + 1] ?? 0;
    w.positions[dst + 2] = face[src + 2] ?? 0;
    w.normals[dst] = nx;
    w.normals[dst + 1] = ny;
    w.normals[dst + 2] = nz;
    if (w.roles !== null) w.roles[w.vertex] = faceRole;
    w.vertex++;
  }
  for (let i = 1; i < faceCount - 1; i++) {
    w.indices[w.index] = first;
    w.indices[w.index + 1] = first + i;
    w.indices[w.index + 2] = first + i + 1;
    w.index += 3;
  }
}

function writeBox(w: Writer, hx: number, hy: number, hz: number): void {
  // +X
  beginFace();
  corner(hx, -hy, -hz);
  corner(hx, hy, -hz);
  corner(hx, hy, hz);
  corner(hx, -hy, hz);
  endFace(w);
  // -X
  beginFace();
  corner(-hx, -hy, -hz);
  corner(-hx, -hy, hz);
  corner(-hx, hy, hz);
  corner(-hx, hy, -hz);
  endFace(w);
  // +Y
  beginFace();
  corner(-hx, hy, -hz);
  corner(-hx, hy, hz);
  corner(hx, hy, hz);
  corner(hx, hy, -hz);
  endFace(w);
  // -Y
  beginFace();
  corner(-hx, -hy, -hz);
  corner(hx, -hy, -hz);
  corner(hx, -hy, hz);
  corner(-hx, -hy, hz);
  endFace(w);
  // +Z
  beginFace();
  corner(-hx, -hy, hz);
  corner(hx, -hy, hz);
  corner(hx, hy, hz);
  corner(-hx, hy, hz);
  endFace(w);
  // -Z
  beginFace();
  corner(-hx, -hy, -hz);
  corner(-hx, hy, -hz);
  corner(hx, hy, -hz);
  corner(hx, -hy, -hz);
  endFace(w);
}

function writeWedge(w: Writer, hx: number, hy: number, hz: number): void {
  // Profile in local XY: A (-hx, -hy), B (+hx, -hy), C (-hx, +hy), extruded along Z.
  // -Z end
  beginFace();
  corner(-hx, -hy, -hz);
  corner(-hx, hy, -hz);
  corner(hx, -hy, -hz);
  endFace(w);
  // +Z end
  beginFace();
  corner(-hx, -hy, hz);
  corner(hx, -hy, hz);
  corner(-hx, hy, hz);
  endFace(w);
  // Bottom (-Y)
  beginFace();
  corner(-hx, -hy, -hz);
  corner(hx, -hy, -hz);
  corner(hx, -hy, hz);
  corner(-hx, -hy, hz);
  endFace(w);
  // Back (-X)
  beginFace();
  corner(-hx, -hy, -hz);
  corner(-hx, -hy, hz);
  corner(-hx, hy, hz);
  corner(-hx, hy, -hz);
  endFace(w);
  // Slope
  beginFace();
  corner(hx, -hy, -hz);
  corner(-hx, hy, -hz);
  corner(-hx, hy, hz);
  corner(hx, -hy, hz);
  endFace(w);
}

function writePrism(
  w: Writer,
  radiusBottom: number,
  radiusTop: number,
  halfHeight: number,
  sides: number,
): void {
  const step = (Math.PI * 2) / sides;
  // Sides: one planar trapezoid per edge of the polygon.
  for (let k = 0; k < sides; k++) {
    const c0 = Math.cos(k * step);
    const s0 = Math.sin(k * step);
    const c1 = Math.cos((k + 1) * step);
    const s1 = Math.sin((k + 1) * step);
    beginFace();
    corner(radiusBottom * c0, -halfHeight, radiusBottom * s0);
    corner(radiusTop * c0, halfHeight, radiusTop * s0);
    corner(radiusTop * c1, halfHeight, radiusTop * s1);
    corner(radiusBottom * c1, -halfHeight, radiusBottom * s1);
    endFace(w);
  }
  // Bottom cap: increasing angle is counter-clockwise seen from below.
  beginFace();
  for (let k = 0; k < sides; k++) {
    corner(radiusBottom * Math.cos(k * step), -halfHeight, radiusBottom * Math.sin(k * step));
  }
  endFace(w);
  // Top cap: decreasing angle.
  beginFace();
  for (let k = sides - 1; k >= 0; k--) {
    corner(radiusTop * Math.cos(k * step), halfHeight, radiusTop * Math.sin(k * step));
  }
  endFace(w);
}

function writeSolid(w: Writer, solid: MapSolid, maxPrismSides: number): void {
  writeSolidRotation(solid, rotation);
  origin[0] = solid.position.x;
  origin[1] = solid.position.y;
  origin[2] = solid.position.z;
  faceRole = mapSurfaceRoleIndex(solid.role);
  if (solid.kind === 'box') {
    writeBox(w, solid.size.x * 0.5, solid.size.y * 0.5, solid.size.z * 0.5);
  } else if (solid.kind === 'wedge') {
    writeWedge(w, solid.size.x * 0.5, solid.size.y * 0.5, solid.size.z * 0.5);
  } else {
    writePrism(
      w,
      solid.radiusBottom,
      solid.radiusTop,
      solid.height * 0.5,
      clampSides(solid.sides, maxPrismSides),
    );
  }
}

// --- Public builders ---------------------------------------------------------------------------------

/** Triangulates one solid (world space, same layout rules as `buildMapTriangles`). */
export function triangulateSolid(
  solid: MapSolid,
  maxPrismSides: number = MAX_PRISM_SIDES,
): SolidTriangles {
  const vertexCount = solidVertexCount(solid, maxPrismSides);
  const writer: Writer = {
    positions: new Float32Array(vertexCount * 3),
    normals: new Float32Array(vertexCount * 3),
    roles: null,
    indices: new Uint32Array(solidTriangleCount(solid, maxPrismSides) * 3),
    vertex: 0,
    index: 0,
  };
  writeSolid(writer, solid, maxPrismSides);
  return { positions: writer.positions, normals: writer.normals, indices: writer.indices };
}

function boundChunk(
  positions: Float32Array,
  vertexStart: number,
  vertexCount: number,
): { center: Vec3; radius: number } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const end = (vertexStart + vertexCount) * 3;
  for (let i = vertexStart * 3; i < end; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const center = { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, z: (minZ + maxZ) * 0.5 };
  let radiusSq = 0;
  for (let i = vertexStart * 3; i < end; i += 3) {
    const dx = (positions[i] ?? 0) - center.x;
    const dy = (positions[i + 1] ?? 0) - center.y;
    const dz = (positions[i + 2] ?? 0) - center.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > radiusSq) radiusSq = distSq;
  }
  return { center, radius: Math.sqrt(radiusSq) };
}

/**
 * Builds the triangle soup for every solid of `map`, grouped by world chunk. The chunk grid
 * spans `map.size` around `map.colliders.stormCenter`; solids outside it land in the edge cells.
 * A map without `solids` gives an empty result.
 */
export function buildMapTriangles(
  map: MapTriangleSource,
  options: MapTriangleOptions = {},
): MapTriangles {
  const solids = map.solids ?? [];
  const maxPrismSides = options.maxPrismSides ?? MAX_PRISM_SIDES;
  const chunkSize = options.chunkSize ?? map.chunkSize ?? DEFAULT_MAP_CHUNK_SIZE;
  const cellsPerSide = Math.max(1, Math.ceil(map.size / chunkSize));
  const minX = map.colliders.stormCenter.x - map.size * 0.5;
  const minZ = map.colliders.stormCenter.z - map.size * 0.5;

  // Cell of each solid, then a stable order by cell so every chunk is one contiguous range.
  const cells = new Int32Array(solids.length);
  const order = new Int32Array(solids.length);
  let vertexTotal = 0;
  let triangleTotal = 0;
  for (let i = 0; i < solids.length; i++) {
    const solid = solids[i];
    if (solid === undefined) continue;
    const cellX = Math.floor((solid.position.x - minX) / chunkSize);
    const cellZ = Math.floor((solid.position.z - minZ) / chunkSize);
    const clampedX = Math.min(Math.max(cellX, 0), cellsPerSide - 1);
    const clampedZ = Math.min(Math.max(cellZ, 0), cellsPerSide - 1);
    cells[i] = clampedZ * cellsPerSide + clampedX;
    order[i] = i;
    vertexTotal += solidVertexCount(solid, maxPrismSides);
    triangleTotal += solidTriangleCount(solid, maxPrismSides);
  }
  order.sort((a, b) => (cells[a] ?? 0) - (cells[b] ?? 0) || a - b);

  const writer: Writer = {
    positions: new Float32Array(vertexTotal * 3),
    normals: new Float32Array(vertexTotal * 3),
    roles: new Uint8Array(vertexTotal),
    indices: new Uint32Array(triangleTotal * 3),
    vertex: 0,
    index: 0,
  };

  const chunks: MapTriangleChunk[] = [];
  let start = 0;
  while (start < order.length) {
    const cell = cells[order[start] ?? 0] ?? 0;
    const vertexStart = writer.vertex;
    const indexStart = writer.index;
    let end = start;
    while (end < order.length && (cells[order[end] ?? 0] ?? 0) === cell) {
      const solid = solids[order[end] ?? 0];
      if (solid !== undefined) writeSolid(writer, solid, maxPrismSides);
      end++;
    }
    const vertexCount = writer.vertex - vertexStart;
    const cellX = cell % cellsPerSide;
    const cellZ = (cell - cellX) / cellsPerSide;
    const bounds = boundChunk(writer.positions, vertexStart, vertexCount);
    chunks.push({
      id: `${cellX}_${cellZ}`,
      cellX,
      cellZ,
      indexStart,
      indexCount: writer.index - indexStart,
      vertexStart,
      vertexCount,
      center: bounds.center,
      radius: bounds.radius,
    });
    start = end;
  }

  return {
    positions: writer.positions,
    normals: writer.normals,
    roles: writer.roles ?? new Uint8Array(0),
    indices: writer.indices,
    vertexCount: vertexTotal,
    triangleCount: triangleTotal,
    chunks,
  };
}

/**
 * Cuts one chunk out for its own geometry. The attribute arrays are `subarray` views into
 * `triangles` (no copy; do not mutate them), the indices are a fresh chunk-local array.
 */
export function sliceMapChunk(triangles: MapTriangles, chunk: MapTriangleChunk): MapChunkSlice {
  const vertexEnd = chunk.vertexStart + chunk.vertexCount;
  const indices =
    chunk.vertexCount <= 65535
      ? new Uint16Array(chunk.indexCount)
      : new Uint32Array(chunk.indexCount);
  for (let i = 0; i < chunk.indexCount; i++) {
    indices[i] = (triangles.indices[chunk.indexStart + i] ?? 0) - chunk.vertexStart;
  }
  return {
    positions: triangles.positions.subarray(chunk.vertexStart * 3, vertexEnd * 3),
    normals: triangles.normals.subarray(chunk.vertexStart * 3, vertexEnd * 3),
    roles: triangles.roles.subarray(chunk.vertexStart, vertexEnd),
    indices,
  };
}
