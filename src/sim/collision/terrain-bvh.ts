/**
 * Static terrain triangles in a bounding volume hierarchy, with the three queries the sim and
 * the camera need: closest point, raycast, and (through closest point) sphere overlap.
 *
 * WHY THE TRAVERSAL IS OURS: three-mesh-bvh (0.9) BUILDS the tree, but its query functions
 * allocate on every call (`BufferStack.setBuffer` creates three typed-array views, `shapecast`
 * and `closestPointToPoint` create closures, `raycastFirst` returns a new hit object), which
 * golden rule 2 forbids in the tick. So the packed tree is taken from the library's public
 * `MeshBVH.serialize` and walked here with an explicit stack and scalar maths: zero allocation
 * per query. tests/sim/collision-bvh.test.ts checks every query against the library's own
 * answers, so a layout change in a future three-mesh-bvh version fails loudly.
 *
 * Packed node layout (serialized format version 1, 32 bytes = 8 uint32 per node):
 *   float32[0..5]  bounds: min x, y, z, max x, y, z
 *   leaf:      uint16[15] === 0xFFFF, uint16[14] = triangle count, uint32[6] = first triangle
 *   internal:  left child = node + 8, right child = node + uint32[6] * 8
 *
 * Nothing here needs the DOM or WebGL: it runs in node and in a Web Worker. Queries are
 * deterministic (fixed traversal order, strict comparisons). Positions are float32, the maths
 * is float64.
 *
 * `!` on typed-array reads: every index is in range by construction (noUncheckedIndexedAccess
 * cannot see that) and a `?? 0` on each of the reads below would cost in the hot loops.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';
import type { MutableVec3 } from '../../shared';
import type { TerrainRay } from '../collision-world';

const UINT32_PER_NODE = 8;
const LEAF_FLAG = 0xffff;
/** The builder's depth cap; the traversal stack is sized from it. */
const MAX_DEPTH = 40;
const STACK_SIZE = MAX_DEPTH + 8;
/** Floats per triangle in `tris`: a, b, c, unit normal. */
const TRI_STRIDE = 12;
/** Squared area (times four) below which a triangle is dropped at build time, in m^4. */
const DEGENERATE_AREA_SQ = 1e-12;
/** Ray/triangle: determinant guard and edge slack (so a ray through a shared edge hits). */
const RAY_PARALLEL_EPSILON = 1e-12;
const RAY_EDGE_SLACK = 1e-6;

function boxDistanceSq(
  f32: Float32Array,
  node: number,
  px: number,
  py: number,
  pz: number,
): number {
  const minX = f32[node]!;
  const minY = f32[node + 1]!;
  const minZ = f32[node + 2]!;
  const maxX = f32[node + 3]!;
  const maxY = f32[node + 4]!;
  const maxZ = f32[node + 5]!;
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Entry distance of the ray into the node's box (0 when the origin is inside), or -1 when the
 * ray misses it or enters beyond `tMax`. `ix/iy/iz` are 1 / direction (Infinity for a zero
 * component: the NaN from `0 * Infinity` fails every comparison, which reads as "inside").
 */
function rayBoxEntry(
  f32: Float32Array,
  node: number,
  ox: number,
  oy: number,
  oz: number,
  ix: number,
  iy: number,
  iz: number,
  tMax: number,
): number {
  let tNear = 0;
  let tFar = tMax;
  let t1 = (f32[node]! - ox) * ix;
  let t2 = (f32[node + 3]! - ox) * ix;
  if (t1 > t2) {
    const swap = t1;
    t1 = t2;
    t2 = swap;
  }
  if (t1 > tNear) tNear = t1;
  if (t2 < tFar) tFar = t2;
  t1 = (f32[node + 1]! - oy) * iy;
  t2 = (f32[node + 4]! - oy) * iy;
  if (t1 > t2) {
    const swap = t1;
    t1 = t2;
    t2 = swap;
  }
  if (t1 > tNear) tNear = t1;
  if (t2 < tFar) tFar = t2;
  t1 = (f32[node + 2]! - oz) * iz;
  t2 = (f32[node + 5]! - oz) * iz;
  if (t1 > t2) {
    const swap = t1;
    t1 = t2;
    t2 = swap;
  }
  if (t1 > tNear) tNear = t1;
  if (t2 < tFar) tFar = t2;
  return tNear <= tFar ? tNear : -1;
}

export class TerrainBvh {
  /** Triangles in the tree (degenerate input triangles are dropped at build time). */
  readonly triangleCount: number;
  /** Input triangles that were dropped because they had no area. */
  readonly droppedTriangleCount: number;
  /**
   * The library tree this was built from, or null when there are no triangles. For tests and
   * debug helpers only: its query methods allocate, so the tick must not call them.
   */
  readonly bvh: MeshBVH | null;

  /** Result of the last `closestPoint` call that returned a distance. */
  closestX = 0;
  closestY = 0;
  closestZ = 0;
  /** Triangle index (this tree's order) of the last `closestPoint` / `raycast` result. */
  closestTriangle = -1;
  hitTriangle = -1;

  // Arguments of the ray being cast (see `raycastRay`).
  private rayOx = 0;
  private rayOy = 0;
  private rayOz = 0;
  private rayDx = 0;
  private rayDy = 0;
  private rayDz = 1;
  private rayMax = 0;

  private readonly f32: Float32Array;
  private readonly u16: Uint16Array;
  private readonly u32: Uint32Array;
  /** TRI_STRIDE floats per triangle, in tree order, so a leaf reads one contiguous run. */
  private readonly tris: Float32Array;
  private readonly stack = new Int32Array(STACK_SIZE);
  private readonly stackKey = new Float64Array(STACK_SIZE);
  // Scratch of `closestOnTriangle`.
  private triX = 0;
  private triY = 0;
  private triZ = 0;

  /**
   * @param positions xyz per vertex. Kept by reference by the library tree; do not modify.
   * @param indices Three vertex indices per triangle. Copied (the builder reorders its copy).
   */
  constructor(positions: Float32Array, indices: Uint32Array | Uint16Array) {
    // Drop triangles without area: they cannot be hit and would divide by zero below.
    const kept = new Uint32Array(indices.length - (indices.length % 3));
    let keptCount = 0;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i]! * 3;
      const b = indices[i + 1]! * 3;
      const c = indices[i + 2]! * 3;
      const abx = positions[b]! - positions[a]!;
      const aby = positions[b + 1]! - positions[a + 1]!;
      const abz = positions[b + 2]! - positions[a + 2]!;
      const acx = positions[c]! - positions[a]!;
      const acy = positions[c + 1]! - positions[a + 1]!;
      const acz = positions[c + 2]! - positions[a + 2]!;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const areaSq = nx * nx + ny * ny + nz * nz;
      // Also false for NaN and for indices outside `positions`.
      if (!(areaSq > DEGENERATE_AREA_SQ) || !Number.isFinite(areaSq)) continue;
      kept[keptCount++] = indices[i]!;
      kept[keptCount++] = indices[i + 1]!;
      kept[keptCount++] = indices[i + 2]!;
    }
    this.triangleCount = keptCount / 3;
    this.droppedTriangleCount = Math.floor(indices.length / 3) - this.triangleCount;

    if (this.triangleCount === 0) {
      this.bvh = null;
      this.f32 = new Float32Array(0);
      this.u16 = new Uint16Array(0);
      this.u32 = new Uint32Array(0);
      this.tris = new Float32Array(0);
      return;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(kept.slice(0, keptCount), 1));
    const bvh = new MeshBVH(geometry, {
      strategy: SAH,
      maxDepth: MAX_DEPTH,
      targetLeafSize: 4,
      verbose: false,
    });
    const packed = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const root = packed.roots[0];
    const order = packed.index;
    if (packed.roots.length !== 1 || root === undefined || order === null) {
      throw new Error('TerrainBvh: expected a single-root BVH with an index');
    }
    if (packed.indirectBuffer !== null || order.length !== keptCount) {
      throw new Error('TerrainBvh: unexpected BVH layout');
    }
    this.bvh = bvh;
    this.f32 = new Float32Array(root);
    this.u16 = new Uint16Array(root);
    this.u32 = new Uint32Array(root);

    // The builder sorted the index so every leaf owns a contiguous triangle range.
    const tris = new Float32Array(this.triangleCount * TRI_STRIDE);
    for (let t = 0; t < this.triangleCount; t++) {
      const a = order[t * 3]! * 3;
      const b = order[t * 3 + 1]! * 3;
      const c = order[t * 3 + 2]! * 3;
      const o = t * TRI_STRIDE;
      for (let k = 0; k < 3; k++) {
        tris[o + k] = positions[a + k]!;
        tris[o + 3 + k] = positions[b + k]!;
        tris[o + 6 + k] = positions[c + k]!;
      }
      const abx = tris[o + 3]! - tris[o]!;
      const aby = tris[o + 4]! - tris[o + 1]!;
      const abz = tris[o + 5]! - tris[o + 2]!;
      const acx = tris[o + 6]! - tris[o]!;
      const acy = tris[o + 7]! - tris[o + 1]!;
      const acz = tris[o + 8]! - tris[o + 2]!;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const inverse = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      tris[o + 9] = nx * inverse;
      tris[o + 10] = ny * inverse;
      tris[o + 11] = nz * inverse;
    }
    this.tris = tris;
  }

  /** Unit face normal (counter-clockwise front) of a triangle index reported by a query. */
  getTriangleNormal(triangle: number, out: MutableVec3): MutableVec3 {
    const o = triangle * TRI_STRIDE;
    if (triangle >= 0 && triangle < this.triangleCount) {
      out.x = this.tris[o + 9]!;
      out.y = this.tris[o + 10]!;
      out.z = this.tris[o + 11]!;
    } else {
      out.x = 0;
      out.y = 1;
      out.z = 0;
    }
    return out;
  }

  /** Components of a triangle's unit face normal, for the tick (no out-object needed). */
  faceNormalX(triangle: number): number {
    return this.tris[triangle * TRI_STRIDE + 9] ?? 0;
  }

  faceNormalY(triangle: number): number {
    return this.tris[triangle * TRI_STRIDE + 10] ?? 1;
  }

  faceNormalZ(triangle: number): number {
    return this.tris[triangle * TRI_STRIDE + 11] ?? 0;
  }

  /**
   * Distance from the point to the nearest triangle, or -1 when there is none STRICTLY closer
   * than `maxDistance` (Infinity is fine). On success the point is in `closestX/Y/Z` and its
   * triangle in `closestTriangle`. A sphere of radius r at the point overlaps the terrain
   * exactly when `closestPoint(x, y, z, r)` is not -1.
   */
  closestPoint(px: number, py: number, pz: number, maxDistance: number): number {
    if (this.triangleCount === 0 || !(maxDistance > 0)) return -1;
    const f32 = this.f32;
    const u16 = this.u16;
    const u32 = this.u32;
    const stack = this.stack;
    const stackKey = this.stackKey;

    let bestSq = maxDistance * maxDistance;
    let found = -1;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;

    const rootSq = boxDistanceSq(f32, 0, px, py, pz);
    // Also false for a NaN point.
    if (!(rootSq < bestSq)) return -1;
    stack[0] = 0;
    stackKey[0] = rootSq;
    let size = 1;

    while (size > 0) {
      size--;
      if (!(stackKey[size]! < bestSq)) continue;
      const node = stack[size]!;
      const node16 = node * 2;
      if (u16[node16 + 15] === LEAF_FLAG) {
        const first = u32[node + 6]!;
        const end = first + u16[node16 + 14]!;
        for (let t = first; t < end; t++) {
          const distSq = this.closestOnTriangle(t, px, py, pz);
          if (distSq < bestSq) {
            bestSq = distSq;
            found = t;
            bestX = this.triX;
            bestY = this.triY;
            bestZ = this.triZ;
          }
        }
      } else {
        const left = node + UINT32_PER_NODE;
        const right = node + u32[node + 6]! * UINT32_PER_NODE;
        const leftSq = boxDistanceSq(f32, left, px, py, pz);
        const rightSq = boxDistanceSq(f32, right, px, py, pz);
        // Nearer child on top of the stack, so it is visited first and prunes the other.
        if (leftSq < rightSq) {
          if (rightSq < bestSq) {
            stack[size] = right;
            stackKey[size++] = rightSq;
          }
          if (leftSq < bestSq) {
            stack[size] = left;
            stackKey[size++] = leftSq;
          }
        } else {
          if (leftSq < bestSq) {
            stack[size] = left;
            stackKey[size++] = leftSq;
          }
          if (rightSq < bestSq) {
            stack[size] = right;
            stackKey[size++] = rightSq;
          }
        }
      }
    }

    if (found < 0) return -1;
    this.closestX = bestX;
    this.closestY = bestY;
    this.closestZ = bestZ;
    this.closestTriangle = found;
    return Math.sqrt(bestSq);
  }

  /**
   * Distance along the ray to the first triangle (either side), or -1 when nothing is hit within
   * `maxDistance`. The direction does not have to be unit length; a zero or non-finite one gives
   * -1. On a hit the triangle is in `hitTriangle`.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    maxDistance: number,
  ): number {
    this.rayOx = ox;
    this.rayOy = oy;
    this.rayOz = oz;
    this.rayDx = directionX;
    this.rayDy = directionY;
    this.rayDz = directionZ;
    this.rayMax = maxDistance;
    return this.castStoredRay();
  }

  /**
   * `raycast` with its arguments in one object, for callers in the tick: floats handed to a call
   * that is not inlined are boxed, fields of a reused object are not.
   */
  raycastRay(ray: Readonly<TerrainRay>): number {
    this.rayOx = ray.originX;
    this.rayOy = ray.originY;
    this.rayOz = ray.originZ;
    this.rayDx = ray.directionX;
    this.rayDy = ray.directionY;
    this.rayDz = ray.directionZ;
    this.rayMax = ray.maxDistance;
    return this.castStoredRay();
  }

  private castStoredRay(): number {
    const ox = this.rayOx;
    const oy = this.rayOy;
    const oz = this.rayOz;
    const directionX = this.rayDx;
    const directionY = this.rayDy;
    const directionZ = this.rayDz;
    const maxDistance = this.rayMax;
    if (this.triangleCount === 0 || !(maxDistance > 0)) return -1;
    const length = Math.sqrt(
      directionX * directionX + directionY * directionY + directionZ * directionZ,
    );
    if (!(length > RAY_PARALLEL_EPSILON) || !Number.isFinite(length)) return -1;
    const dx = directionX / length;
    const dy = directionY / length;
    const dz = directionZ / length;
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;

    const f32 = this.f32;
    const u16 = this.u16;
    const u32 = this.u32;
    const tris = this.tris;
    const stack = this.stack;
    const stackKey = this.stackKey;

    let best = maxDistance;
    let found = -1;
    const rootEntry = rayBoxEntry(f32, 0, ox, oy, oz, ix, iy, iz, best);
    if (rootEntry < 0) return -1;
    stack[0] = 0;
    stackKey[0] = rootEntry;
    let size = 1;

    while (size > 0) {
      size--;
      if (!(stackKey[size]! < best)) continue;
      const node = stack[size]!;
      const node16 = node * 2;
      if (u16[node16 + 15] === LEAF_FLAG) {
        const first = u32[node + 6]!;
        const end = first + u16[node16 + 14]!;
        for (let t = first; t < end; t++) {
          // Moeller-Trumbore, both sides.
          const o = t * TRI_STRIDE;
          const ax = tris[o]!;
          const ay = tris[o + 1]!;
          const az = tris[o + 2]!;
          const e1x = tris[o + 3]! - ax;
          const e1y = tris[o + 4]! - ay;
          const e1z = tris[o + 5]! - az;
          const e2x = tris[o + 6]! - ax;
          const e2y = tris[o + 7]! - ay;
          const e2z = tris[o + 8]! - az;
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -RAY_PARALLEL_EPSILON && det < RAY_PARALLEL_EPSILON) continue;
          const inverse = 1 / det;
          const sx = ox - ax;
          const sy = oy - ay;
          const sz = oz - az;
          const u = (sx * px + sy * py + sz * pz) * inverse;
          if (!(u >= -RAY_EDGE_SLACK && u <= 1 + RAY_EDGE_SLACK)) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inverse;
          if (!(v >= -RAY_EDGE_SLACK && u + v <= 1 + RAY_EDGE_SLACK)) continue;
          const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
          if (distance >= 0 && distance < best) {
            best = distance;
            found = t;
          }
        }
      } else {
        const left = node + UINT32_PER_NODE;
        const right = node + u32[node + 6]! * UINT32_PER_NODE;
        const leftEntry = rayBoxEntry(f32, left, ox, oy, oz, ix, iy, iz, best);
        const rightEntry = rayBoxEntry(f32, right, ox, oy, oz, ix, iy, iz, best);
        // Nearer entry on top of the stack.
        if (leftEntry >= 0 && (rightEntry < 0 || leftEntry < rightEntry)) {
          if (rightEntry >= 0) {
            stack[size] = right;
            stackKey[size++] = rightEntry;
          }
          stack[size] = left;
          stackKey[size++] = leftEntry;
        } else {
          if (leftEntry >= 0) {
            stack[size] = left;
            stackKey[size++] = leftEntry;
          }
          if (rightEntry >= 0) {
            stack[size] = right;
            stackKey[size++] = rightEntry;
          }
        }
      }
    }

    if (found < 0) return -1;
    this.hitTriangle = found;
    return best;
  }

  /**
   * How many solids the point is inside (0 = open air). The triangles are closed volumes wound
   * counter-clockwise from outside (`buildMapTriangles`), so along any ray to infinity the
   * faces crossed from behind minus the faces crossed from the front is that number, whether
   * the solids overlap, touch or share faces: unlike "is the point behind the closest face",
   * which a face of another solid inside the rock gets wrong.
   *
   * A ray through an edge two triangles share would count it twice, so three skew rays vote
   * (the median). Three unpruned traversals: for the rare question, not for every tick.
   */
  solidDepth(px: number, py: number, pz: number): number {
    if (this.triangleCount === 0) return 0;
    this.rayOx = px;
    this.rayOy = py;
    this.rayOz = pz;
    const a = this.signedCrossings(0.3015, 0.9045, 0.3015);
    const b = this.signedCrossings(-0.5298, 0.7205, 0.4472);
    if (a === b) return a;
    const c = this.signedCrossings(0.1874, 0.6325, -0.7515);
    return c === a || c === b ? c : a + b + c - Math.max(a, b, c) - Math.min(a, b, c);
  }

  /** Back-face minus front-face crossings of the ray from `rayO*` along the unit (dx, dy, dz). */
  private signedCrossings(dx: number, dy: number, dz: number): number {
    const ox = this.rayOx;
    const oy = this.rayOy;
    const oz = this.rayOz;
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const f32 = this.f32;
    const u16 = this.u16;
    const u32 = this.u32;
    const tris = this.tris;
    const stack = this.stack;

    let count = 0;
    if (rayBoxEntry(f32, 0, ox, oy, oz, ix, iy, iz, Infinity) < 0) return 0;
    stack[0] = 0;
    let size = 1;
    while (size > 0) {
      const node = stack[--size]!;
      const node16 = node * 2;
      if (u16[node16 + 15] === LEAF_FLAG) {
        const first = u32[node + 6]!;
        const end = first + u16[node16 + 14]!;
        for (let t = first; t < end; t++) {
          // Moeller-Trumbore as in `castStoredRay`, without the edge slack: a crossing on a
          // shared edge must not be counted for both of its triangles more often than chance.
          const o = t * TRI_STRIDE;
          const ax = tris[o]!;
          const ay = tris[o + 1]!;
          const az = tris[o + 2]!;
          const e1x = tris[o + 3]! - ax;
          const e1y = tris[o + 4]! - ay;
          const e1z = tris[o + 5]! - az;
          const e2x = tris[o + 6]! - ax;
          const e2y = tris[o + 7]! - ay;
          const e2z = tris[o + 8]! - az;
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -RAY_PARALLEL_EPSILON && det < RAY_PARALLEL_EPSILON) continue;
          const inverse = 1 / det;
          const sx = ox - ax;
          const sy = oy - ay;
          const sz = oz - az;
          const u = (sx * px + sy * py + sz * pz) * inverse;
          if (!(u >= 0 && u <= 1)) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inverse;
          if (!(v >= 0 && u + v <= 1)) continue;
          const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
          if (!(distance > 0)) continue;
          // det = -(direction . outward normal): negative = leaving a solid through this face.
          count += det < 0 ? 1 : -1;
        }
      } else {
        const left = node + UINT32_PER_NODE;
        const right = node + u32[node + 6]! * UINT32_PER_NODE;
        if (rayBoxEntry(f32, left, ox, oy, oz, ix, iy, iz, Infinity) >= 0) stack[size++] = left;
        if (rayBoxEntry(f32, right, ox, oy, oz, ix, iy, iz, Infinity) >= 0) stack[size++] = right;
      }
    }
    return count;
  }

  /**
   * Closest point on triangle `t` to the point (Ericson, "Real-Time Collision Detection",
   * 5.1.5). Writes it to `triX/Y/Z` and returns the squared distance. Triangles have area (the
   * constructor dropped the others), so no denominator here can be zero.
   */
  private closestOnTriangle(t: number, px: number, py: number, pz: number): number {
    const tris = this.tris;
    const o = t * TRI_STRIDE;
    const ax = tris[o]!;
    const ay = tris[o + 1]!;
    const az = tris[o + 2]!;
    const bx = tris[o + 3]!;
    const by = tris[o + 4]!;
    const bz = tris[o + 5]!;
    const cx = tris[o + 6]!;
    const cy = tris[o + 7]!;
    const cz = tris[o + 8]!;
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    let qx: number;
    let qy: number;
    let qz: number;

    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    const bpx = px - bx;
    const bpy = py - by;
    const bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - cx;
    const cpy = py - cy;
    const cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;

    if (d1 <= 0 && d2 <= 0) {
      qx = ax;
      qy = ay;
      qz = az;
    } else if (d3 >= 0 && d4 <= d3) {
      qx = bx;
      qy = by;
      qz = bz;
    } else if (d6 >= 0 && d5 <= d6) {
      qx = cx;
      qy = cy;
      qz = cz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      const vb = d5 * d2 - d1 * d6;
      const va = d3 * d6 - d5 * d4;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + abx * v;
        qy = ay + aby * v;
        qz = az + abz * v;
      } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        qx = ax + acx * w;
        qy = ay + acy * w;
        qz = az + acz * w;
      } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        qx = bx + (cx - bx) * w;
        qy = by + (cy - by) * w;
        qz = bz + (cz - bz) * w;
      } else {
        const inverse = 1 / (va + vb + vc);
        const v = vb * inverse;
        const w = vc * inverse;
        qx = ax + abx * v + acx * w;
        qy = ay + aby * v + acy * w;
        qz = az + abz * v + acz * w;
      }
    }

    this.triX = qx;
    this.triY = qy;
    this.triZ = qz;
    const dx = px - qx;
    const dy = py - qy;
    const dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  }
}
