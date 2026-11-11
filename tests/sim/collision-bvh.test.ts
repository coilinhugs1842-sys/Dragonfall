/**
 * TerrainBvh (T-1.7): the allocation-free queries walk three-mesh-bvh's packed tree directly, so
 * every query is checked here against the library's own answer and against brute force. If a
 * future three-mesh-bvh changes its node layout, these fail.
 */

import { Ray, Vector3 } from 'three';
import { DoubleSide } from 'three';
import { describe, expect, it } from 'vitest';
import { buildMapTriangles, createGreyboxSpires, createSeededRandom } from '../../src/shared';
import type { MapTriangles } from '../../src/shared';
import { TerrainBvh } from '../../src/sim/collision';

const map = createGreyboxSpires();
const triangles: MapTriangles = buildMapTriangles(map);
const terrain = new TerrainBvh(triangles.positions, triangles.indices);

/** Closest distance by testing every triangle with three.js maths. */
function bruteForceDistance(point: Vector3): number {
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const closest = new Vector3();
  let best = Infinity;
  const { positions, indices } = triangles;
  for (let i = 0; i < indices.length; i += 3) {
    a.fromArray(positions, (indices[i] ?? 0) * 3);
    b.fromArray(positions, (indices[i + 1] ?? 0) * 3);
    c.fromArray(positions, (indices[i + 2] ?? 0) * 3);
    // Same algorithm family as three's Triangle.closestPointToPoint, inlined to avoid importing
    // Triangle's static helpers per call.
    closestPointOnTriangle(point, a, b, c, closest);
    const distance = closest.distanceTo(point);
    if (distance < best) best = distance;
  }
  return best;
}

const ab = new Vector3();
const ac = new Vector3();
const ap = new Vector3();
const edge = new Vector3();
const normal = new Vector3();

/** Projection onto the plane when it lands inside, else the nearest point on the three edges. */
function closestPointOnTriangle(
  p: Vector3,
  a: Vector3,
  b: Vector3,
  c: Vector3,
  out: Vector3,
): Vector3 {
  ab.subVectors(b, a);
  ac.subVectors(c, a);
  normal.crossVectors(ab, ac).normalize();
  ap.subVectors(p, a);
  const projected = p.clone().addScaledVector(normal, -ap.dot(normal));
  const inside =
    sameSide(projected, a, b, normal) &&
    sameSide(projected, b, c, normal) &&
    sameSide(projected, c, a, normal);
  if (inside) return out.copy(projected);
  let best = Infinity;
  for (const [from, to] of [
    [a, b],
    [b, c],
    [c, a],
  ] as const) {
    edge.subVectors(to, from);
    const t = Math.min(1, Math.max(0, p.clone().sub(from).dot(edge) / edge.lengthSq()));
    const candidate = from.clone().addScaledVector(edge, t);
    const distance = candidate.distanceToSquared(p);
    if (distance < best) {
      best = distance;
      out.copy(candidate);
    }
  }
  return out;
}

function sameSide(p: Vector3, from: Vector3, to: Vector3, n: Vector3): boolean {
  return new Vector3().subVectors(to, from).cross(new Vector3().subVectors(p, from)).dot(n) >= 0;
}

function randomPoint(random: () => number, out: Vector3): Vector3 {
  return out.set((random() - 0.5) * 2000, random() * 700 - 50, (random() - 0.5) * 2000);
}

describe('TerrainBvh build', () => {
  it('keeps every triangle of the greybox map and exposes the library tree', () => {
    expect(terrain.triangleCount).toBe(triangles.triangleCount);
    expect(terrain.droppedTriangleCount).toBe(0);
    expect(terrain.bvh).not.toBeNull();
  });

  it('leaves the caller index untouched (the builder reorders its own copy)', () => {
    const fresh = buildMapTriangles(map);
    expect(Array.from(triangles.indices)).toEqual(Array.from(fresh.indices));
  });

  it('drops triangles without area and answers -1 when nothing is left', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0]);
    const degenerate = new TerrainBvh(positions, new Uint16Array([0, 1, 2, 0, 0, 3]));
    expect(degenerate.triangleCount).toBe(0);
    expect(degenerate.droppedTriangleCount).toBe(2);
    expect(degenerate.bvh).toBeNull();
    expect(degenerate.closestPoint(0, 0, 0, Infinity)).toBe(-1);
    expect(degenerate.raycast(0, 5, 0, 0, -1, 0, 100)).toBe(-1);

    const mixed = new TerrainBvh(positions, new Uint16Array([0, 1, 2, 0, 1, 3]));
    expect(mixed.triangleCount).toBe(1);
    expect(mixed.droppedTriangleCount).toBe(1);
    expect(mixed.closestPoint(0.25, 0.25, 3, Infinity)).toBeCloseTo(3, 6);
    expect(mixed.raycast(0.25, 0.25, 3, 0, 0, -2, 100)).toBeCloseTo(3, 6);
  });
});

describe('TerrainBvh.closestPoint', () => {
  it('matches three-mesh-bvh closestPointToPoint on random points', () => {
    const random = createSeededRandom(11);
    const point = new Vector3();
    const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
    const bvh = terrain.bvh;
    if (bvh === null) throw new Error('no bvh');
    for (let i = 0; i < 1500; i++) {
      randomPoint(random, point);
      const expected = bvh.closestPointToPoint(point, target);
      const distance = terrain.closestPoint(point.x, point.y, point.z, Infinity);
      expect(expected).not.toBeNull();
      expect(distance).toBeCloseTo(target.distance, 3);
      // The reported point really is that far away, and lies on the reported triangle's plane.
      const reported = new Vector3(terrain.closestX, terrain.closestY, terrain.closestZ);
      expect(reported.distanceTo(point)).toBeCloseTo(distance, 6);
      expect(terrain.closestTriangle).toBeGreaterThanOrEqual(0);
      expect(terrain.closestTriangle).toBeLessThan(terrain.triangleCount);
    }
  });

  it('matches brute force', () => {
    const random = createSeededRandom(12);
    const point = new Vector3();
    for (let i = 0; i < 60; i++) {
      randomPoint(random, point);
      const distance = terrain.closestPoint(point.x, point.y, point.z, Infinity);
      expect(distance).toBeCloseTo(bruteForceDistance(point), 3);
    }
  });

  it('only reports points strictly inside maxDistance', () => {
    const random = createSeededRandom(13);
    const point = new Vector3();
    for (let i = 0; i < 300; i++) {
      randomPoint(random, point);
      const distance = terrain.closestPoint(point.x, point.y, point.z, Infinity);
      expect(terrain.closestPoint(point.x, point.y, point.z, distance * 0.999 - 1e-6)).toBe(-1);
      expect(terrain.closestPoint(point.x, point.y, point.z, distance * 1.001 + 1e-6)).toBeCloseTo(
        distance,
        9,
      );
    }
  });

  it('answers -1 for NaN, zero and negative limits and for NaN points', () => {
    expect(terrain.closestPoint(0, 100, 0, 0)).toBe(-1);
    expect(terrain.closestPoint(0, 100, 0, -5)).toBe(-1);
    expect(terrain.closestPoint(0, 100, 0, NaN)).toBe(-1);
    expect(terrain.closestPoint(NaN, 100, 0, Infinity)).toBe(-1);
    expect(terrain.closestPoint(0, Infinity, 0, 1000)).toBe(-1);
  });

  it('reports a unit face normal for the closest triangle', () => {
    terrain.closestPoint(10, 300, 10, Infinity);
    const n = terrain.getTriangleNormal(terrain.closestTriangle, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 5);
    expect(terrain.faceNormalX(terrain.closestTriangle)).toBe(n.x);
    expect(terrain.faceNormalY(terrain.closestTriangle)).toBe(n.y);
    expect(terrain.faceNormalZ(terrain.closestTriangle)).toBe(n.z);
    expect(terrain.getTriangleNormal(-1, { x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
  });
});

describe('TerrainBvh.raycast', () => {
  it('matches three-mesh-bvh raycastFirst (both sides) on random rays', () => {
    const random = createSeededRandom(21);
    const ray = new Ray();
    const bvh = terrain.bvh;
    if (bvh === null) throw new Error('no bvh');
    let hits = 0;
    for (let i = 0; i < 1500; i++) {
      randomPoint(random, ray.origin);
      ray.direction.set(random() - 0.5, (random() - 0.5) * 0.6, random() - 0.5).normalize();
      const maxDistance = 50 + random() * 800;
      const expected = bvh.raycastFirst(ray, DoubleSide, 0, maxDistance);
      const distance = terrain.raycast(
        ray.origin.x,
        ray.origin.y,
        ray.origin.z,
        // Not unit length on purpose.
        ray.direction.x * 7,
        ray.direction.y * 7,
        ray.direction.z * 7,
        maxDistance,
      );
      if (expected === null) {
        // Our edge slack may catch a ray the library lets slip through a seam, never the reverse
        // by more than the slack; a hit here must then be real geometry within range.
        if (distance >= 0) expect(distance).toBeLessThan(maxDistance);
      } else {
        hits++;
        expect(distance).toBeGreaterThanOrEqual(0);
        // We can only be nearer (the slack) and then only marginally.
        expect(distance).toBeLessThanOrEqual(expected.distance + 1e-3);
        expect(distance).toBeGreaterThan(expected.distance - 0.05);
      }
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('answers -1 for a zero or NaN direction and a non-positive range', () => {
    expect(terrain.raycast(0, 300, -500, 0, 0, 0, 1000)).toBe(-1);
    expect(terrain.raycast(0, 300, -500, NaN, 0, 1, 1000)).toBe(-1);
    expect(terrain.raycast(0, 300, -500, 0, 0, 1, 0)).toBe(-1);
    expect(terrain.raycast(0, 300, -500, 0, 0, 1, NaN)).toBe(-1);
  });

  it('handles axis-aligned rays (zero direction components)', () => {
    // Straight down from above the sky-well core at the map centre.
    const down = terrain.raycast(0, 690, 0, 0, -1, 0, 2000);
    expect(down).toBeGreaterThan(0);
    const point = new Vector3(0, 690 - down, 0);
    expect(terrain.closestPoint(point.x, point.y, point.z, Infinity)).toBeLessThan(1e-3);
  });

  it('is deterministic', () => {
    const run = (): number[] => {
      const random = createSeededRandom(5);
      const out: number[] = [];
      const point = new Vector3();
      for (let i = 0; i < 200; i++) {
        randomPoint(random, point);
        out.push(terrain.closestPoint(point.x, point.y, point.z, 400));
        out.push(terrain.raycast(point.x, point.y, point.z, 0.3, -0.2, 0.9, 600));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('TerrainBvh.solidDepth', () => {
  const solid = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
    ({
      kind: 'box',
      role: 'stone',
      position: { x, y, z },
      yaw: 0,
      pitch: 0,
      roll: 0,
      size: { x: sx, y: sy, z: sz },
    }) as const;

  it('counts the solids a point is in: overlapping, stacked and apart', () => {
    // A on the origin; B overlaps A's top by 10 m; C sits exactly on B (a shared face).
    const built = buildMapTriangles({
      size: 2000,
      chunkSize: 250,
      colliders: { stormCenter: { x: 0, y: 0, z: 0 } },
      solids: [
        solid(0, 50, 0, 40, 100, 40),
        solid(0, 140, 0, 40, 100, 40),
        solid(0, 240, 0, 40, 100, 40),
      ],
    });
    const stack = new TerrainBvh(built.positions, built.indices);
    expect(stack.solidDepth(0, 50, 0)).toBe(1);
    expect(stack.solidDepth(3, 95, -7)).toBe(2);
    // Just under B's bottom face, inside A only: the closest face looks at the point.
    expect(stack.solidDepth(3, 88, -7)).toBe(1);
    expect(stack.solidDepth(0, 150, 0)).toBe(1);
    // Either side of the face B and C share.
    expect(stack.solidDepth(5, 189.5, 5)).toBe(1);
    expect(stack.solidDepth(5, 190.5, 5)).toBe(1);
    expect(stack.solidDepth(0, 291, 0)).toBe(0);
    expect(stack.solidDepth(25, 50, 0)).toBe(0);
    expect(stack.solidDepth(0, -5, 0)).toBe(0);
    expect(stack.solidDepth(500, 50, 500)).toBe(0);
  });

  it('agrees with "every way out is blocked" on the greybox map, and is 0 in open sky', () => {
    const random = createSeededRandom(31);
    let inside = 0;
    for (let i = 0; i < 4000; i++) {
      const x = (random() - 0.5) * 1600;
      const y = random() * 700;
      const z = (random() - 0.5) * 1600;
      const depth = terrain.solidDepth(x, y, z);
      expect(depth).toBeGreaterThanOrEqual(0);
      // A point with a free line straight up or down is not inside a closed solid.
      const open =
        terrain.raycast(x, y, z, 0, 1, 0, 1e5) < 0 || terrain.raycast(x, y, z, 0, -1, 0, 1e5) < 0;
      if (open) expect(depth, `${x}, ${y}, ${z}`).toBe(0);
      if (depth > 0) inside++;
    }
    expect(inside).toBeGreaterThan(20);
    expect(terrain.solidDepth(0, 5000, 0)).toBe(0);
  });
});
