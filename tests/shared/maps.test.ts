import { Euler, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { GreyboxMap, MapSolid, MapTriangles } from '../../src/shared';
import {
  CLASS_TUNING,
  COLLISION_TUNING,
  GREYBOX_CHUNK_SIZE,
  GREYBOX_COVER_DISTANCE,
  GREYBOX_GATE_ARCH_CLEARANCE,
  GREYBOX_GATE_ARCH_DISTANCE,
  GREYBOX_GATE_CORRIDOR_LENGTH,
  GREYBOX_GATE_CORRIDOR_RADIUS,
  GREYBOX_SOLID_MAX_RADIUS,
  GREYBOX_SPIRES_DEFAULT_SEED,
  MAP_SURFACE_ROLES,
  MAP_SURFACE_ROLE_COLORS,
  MAX_TEAM_SIZE,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  TEAM_IDS,
  buildMapTriangles,
  countMapTriangles,
  createGreyboxSpires,
  createSeededRandom,
  distanceToSolidBound,
  mapSurfaceRoleIndex,
  mirrorSolidZ,
  sliceMapChunk,
  triangulateSolid,
} from '../../src/shared';

/** Budgets stated in the T-1.6 brief. */
const VISUAL_TRIANGLE_BUDGET = 60_000;
const COLLISION_TRIANGLE_BUDGET = 8_000;
const LOW_DETAIL_COLLISION_OPTIONS = { maxPrismSides: 4 } as const;
const LOW_DETAIL_COLLISION_TRIANGLE_BUDGET = 5_000;

const SEEDS = [GREYBOX_SPIRES_DEFAULT_SEED, 1, 2, 12345, 0xdeadbeef];

const BOX: MapSolid = {
  kind: 'box',
  role: 'stone',
  position: { x: 10, y: 20, z: -30 },
  yaw: 0.7,
  pitch: -0.3,
  roll: 0.4,
  size: { x: 4, y: 6, z: 10 },
};
const PRISM: MapSolid = {
  kind: 'prism',
  role: 'moss',
  position: { x: -5, y: 100, z: 40 },
  yaw: 2.1,
  pitch: 0.2,
  roll: -0.15,
  radiusBottom: 12,
  radiusTop: 7,
  height: 80,
  sides: 7,
};
const WEDGE: MapSolid = {
  kind: 'wedge',
  role: 'litEdge',
  position: { x: 3, y: -8, z: 12 },
  yaw: -1.2,
  pitch: 0.5,
  roll: 0.9,
  size: { x: 14, y: 5, z: 9 },
};

function analyticVolume(solid: MapSolid, sides?: number): number {
  if (solid.kind === 'box') return solid.size.x * solid.size.y * solid.size.z;
  if (solid.kind === 'wedge') return (solid.size.x * solid.size.y * solid.size.z) / 2;
  const n = sides ?? solid.sides;
  const polygon = (n / 2) * Math.sin((2 * Math.PI) / n);
  const { radiusBottom: a, radiusTop: b } = solid;
  return (polygon * solid.height * (a * a + a * b + b * b)) / 3;
}

/** Signed volume of a closed mesh; positive when the triangles wind outward. */
function signedVolume(
  positions: Float32Array,
  indices: ArrayLike<number>,
  origin: { x: number; y: number; z: number },
  start = 0,
  count = indices.length,
): number {
  let six = 0;
  for (let i = start; i < start + count; i += 3) {
    const a = (indices[i] ?? 0) * 3;
    const b = (indices[i + 1] ?? 0) * 3;
    const c = (indices[i + 2] ?? 0) * 3;
    // Relative to the solid's centre, so float32 world coordinates do not cancel badly.
    const ax = (positions[a] ?? 0) - origin.x;
    const ay = (positions[a + 1] ?? 0) - origin.y;
    const az = (positions[a + 2] ?? 0) - origin.z;
    const bx = (positions[b] ?? 0) - origin.x;
    const by = (positions[b + 1] ?? 0) - origin.y;
    const bz = (positions[b + 2] ?? 0) - origin.z;
    const cx = (positions[c] ?? 0) - origin.x;
    const cy = (positions[c + 1] ?? 0) - origin.y;
    const cz = (positions[c + 2] ?? 0) - origin.z;
    six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

function horizontalRadius(positions: Float32Array, vertex: number): number {
  return Math.hypot(positions[vertex * 3] ?? 0, positions[vertex * 3 + 2] ?? 0);
}

describe('createSeededRandom', () => {
  it('repeats for a seed, differs between seeds and stays in [0, 1)', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const c = createSeededRandom(43);
    let differs = false;
    for (let i = 0; i < 1000; i++) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      if (value !== c()) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('is roughly uniform', () => {
    const random = createSeededRandom(7);
    let sum = 0;
    for (let i = 0; i < 20_000; i++) sum += random();
    expect(sum / 20_000).toBeCloseTo(0.5, 1);
  });
});

describe('surface roles', () => {
  it('has a colour and a stable index for every role', () => {
    MAP_SURFACE_ROLES.forEach((role, index) => {
      expect(mapSurfaceRoleIndex(role)).toBe(index);
      expect(MAP_SURFACE_ROLE_COLORS[role]).toBeGreaterThanOrEqual(0);
      expect(MAP_SURFACE_ROLE_COLORS[role]).toBeLessThanOrEqual(0xffffff);
    });
    expect(Object.keys(MAP_SURFACE_ROLE_COLORS)).toHaveLength(MAP_SURFACE_ROLES.length);
    expect(MAP_SURFACE_ROLES.length).toBeLessThanOrEqual(256);
  });
});

describe('triangulateSolid', () => {
  it.each([
    ['box', BOX, 24, 12],
    ['prism', PRISM, 42, 24],
    ['wedge', WEDGE, 18, 8],
  ] as const)('emits a closed, outward-wound %s', (_name, solid, vertices, triangles) => {
    const mesh = triangulateSolid(solid);
    expect(mesh.positions).toHaveLength(vertices * 3);
    expect(mesh.normals).toHaveLength(vertices * 3);
    expect(mesh.indices).toHaveLength(triangles * 3);
    for (const index of mesh.indices) expect(index).toBeLessThan(vertices);
    const volume = signedVolume(mesh.positions, mesh.indices, solid.position);
    expect(volume).toBeGreaterThan(0);
    expect(volume / analyticVolume(solid)).toBeCloseTo(1, 3);
  });

  it.each([
    ['box', BOX],
    ['prism', PRISM],
    ['wedge', WEDGE],
  ] as const)('gives every %s triangle its unit face normal', (_name, solid) => {
    const { positions, normals, indices } = triangulateSolid(solid);
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const normal = new Vector3();
    const stored = new Vector3();
    // Centroid of the vertices: strictly inside (a wedge's slope passes through `position`).
    const inside = new Vector3();
    for (let i = 0; i < positions.length; i += 3) inside.add(a.fromArray(positions, i));
    inside.multiplyScalar(3 / positions.length);
    for (let i = 0; i < indices.length; i += 3) {
      a.fromArray(positions, (indices[i] ?? 0) * 3);
      b.fromArray(positions, (indices[i + 1] ?? 0) * 3);
      c.fromArray(positions, (indices[i + 2] ?? 0) * 3);
      normal.crossVectors(b.sub(a), c.sub(a)).normalize();
      for (let k = 0; k < 3; k++) {
        stored.fromArray(normals, (indices[i + k] ?? 0) * 3);
        expect(stored.length()).toBeCloseTo(1, 4);
        expect(stored.dot(normal)).toBeGreaterThan(0.999);
      }
      // Outward: the face looks away from the solid's centre.
      a.fromArray(positions, (indices[i] ?? 0) * 3);
      expect(normal.dot(a.sub(inside))).toBeGreaterThan(0);
    }
  });

  it("matches three.js Euler order 'YXZ' (pitch, yaw, roll)", () => {
    const matrix = new Matrix4().makeRotationFromEuler(
      new Euler(BOX.pitch, BOX.yaw, BOX.roll, 'YXZ'),
    );
    // First vertex of a box is its local (+x, -y, -z) corner.
    const expected = new Vector3(2, -3, -5).applyMatrix4(matrix).add(BOX.position as Vector3);
    const { positions } = triangulateSolid(BOX);
    expect(positions[0]).toBeCloseTo(expected.x, 4);
    expect(positions[1]).toBeCloseTo(expected.y, 4);
    expect(positions[2]).toBeCloseTo(expected.z, 4);
  });

  it('points local +X along (cos yaw, 0, -sin yaw)', () => {
    const yaw = 0.5;
    const { positions } = triangulateSolid({
      kind: 'box',
      role: 'stone',
      position: { x: 0, y: 0, z: 0 },
      yaw,
      pitch: 0,
      roll: 0,
      size: { x: 2, y: 0.0002, z: 0.0002 },
    });
    expect(positions[0]).toBeCloseTo(Math.cos(yaw), 3);
    expect(positions[2]).toBeCloseTo(-Math.sin(yaw), 3);
  });

  it('rebuilds a prism with fewer sides for collision, inside the detailed one', () => {
    const low = triangulateSolid(PRISM, 4);
    expect(low.indices).toHaveLength(12 * 3);
    const volume = signedVolume(low.positions, low.indices, PRISM.position);
    expect(volume / analyticVolume(PRISM, 4)).toBeCloseTo(1, 3);
    expect(volume).toBeLessThan(analyticVolume(PRISM));
    // Never below a triangle.
    expect(triangulateSolid(PRISM, 1).indices).toHaveLength(8 * 3);
  });

  it('mirrors to the reflected vertex set', () => {
    for (const solid of [BOX, PRISM, WEDGE]) {
      const original = triangulateSolid(solid).positions;
      const mirrored = triangulateSolid(mirrorSolidZ(solid)).positions;
      expect(mirrored).toHaveLength(original.length);
      for (let i = 0; i < original.length; i += 3) {
        let best = Infinity;
        for (let j = 0; j < mirrored.length; j += 3) {
          const d = Math.hypot(
            (original[i] ?? 0) - (mirrored[j] ?? 0),
            (original[i + 1] ?? 0) - (mirrored[j + 1] ?? 0),
            (original[i + 2] ?? 0) + (mirrored[j + 2] ?? 0),
          );
          if (d < best) best = d;
        }
        expect(best).toBeLessThan(1e-3);
      }
      const volume = signedVolume(
        mirrored,
        triangulateSolid(mirrorSolidZ(solid)).indices,
        mirrorSolidZ(solid).position,
      );
      expect(volume / analyticVolume(solid)).toBeCloseTo(1, 3);
    }
  });
});

describe('mirrorSolidZ', () => {
  it('is an involution and swaps the team roles', () => {
    expect(mirrorSolidZ(mirrorSolidZ(PRISM))).toEqual(PRISM);
    expect(mirrorSolidZ({ ...BOX, role: 'ember' }).role).toBe('frost');
    expect(mirrorSolidZ({ ...BOX, role: 'frost' }).role).toBe('ember');
  });

  it('leaves an upright solid on the mirror plane unchanged (no -0)', () => {
    const solid: MapSolid = { ...BOX, position: { x: 4, y: 5, z: 0 }, yaw: 0, pitch: 0 };
    expect(mirrorSolidZ(solid)).toEqual(solid);
  });
});

describe('distanceToSolidBound', () => {
  it('is exact for a rotated box and zero inside', () => {
    const { x, y, z } = BOX.position;
    expect(distanceToSolidBound(BOX, x, y, z)).toBe(0);
    // 10 m out along the box's local +X axis from its face.
    const matrix = new Matrix4().makeRotationFromEuler(
      new Euler(BOX.pitch, BOX.yaw, BOX.roll, 'YXZ'),
    );
    const p = new Vector3(2 + 10, 0, 0).applyMatrix4(matrix).add(BOX.position as Vector3);
    expect(distanceToSolidBound(BOX, p.x, p.y, p.z)).toBeCloseTo(10, 6);
  });

  it('never over-estimates the distance to a real surface vertex', () => {
    for (const solid of [BOX, PRISM, WEDGE]) {
      const { positions } = triangulateSolid(solid);
      for (const probe of [
        [60, 20, -30],
        [-40, 180, 90],
        [0, -50, 0],
      ] as const) {
        let nearest = Infinity;
        for (let i = 0; i < positions.length; i += 3) {
          const d = Math.hypot(
            probe[0] - (positions[i] ?? 0),
            probe[1] - (positions[i + 1] ?? 0),
            probe[2] - (positions[i + 2] ?? 0),
          );
          if (d < nearest) nearest = d;
        }
        expect(distanceToSolidBound(solid, probe[0], probe[1], probe[2])).toBeLessThanOrEqual(
          nearest + 1e-4,
        );
      }
    }
  });
});

describe('buildMapTriangles', () => {
  const tiny = {
    size: 1000,
    chunkSize: 250,
    colliders: { stormCenter: { x: 0, y: 0, z: 0 } },
    solids: [
      { ...PRISM, position: { x: 300, y: 0, z: 300 } },
      { ...BOX, position: { x: -400, y: 0, z: -400 } },
      { ...WEDGE, position: { x: 310, y: 50, z: 320 } },
      // Outside the grid: clamped into the edge cell.
      { ...BOX, position: { x: 9000, y: 0, z: -9000 } },
    ],
  } as const;

  it('groups solids into contiguous chunk ranges with correct bounds', () => {
    const mesh = buildMapTriangles(tiny);
    expect(mesh.vertexCount).toBe(42 + 24 + 18 + 24);
    expect(mesh.triangleCount).toBe(24 + 12 + 8 + 12);
    expect(mesh.triangleCount).toBe(countMapTriangles(tiny.solids));
    expect(mesh.chunks.map((chunk) => chunk.id)).toEqual(['0_0', '3_0', '3_3']);

    let vertexCursor = 0;
    let indexCursor = 0;
    for (const chunk of mesh.chunks) {
      expect(chunk.vertexStart).toBe(vertexCursor);
      expect(chunk.indexStart).toBe(indexCursor);
      expect(chunk.indexCount % 3).toBe(0);
      vertexCursor += chunk.vertexCount;
      indexCursor += chunk.indexCount;
      for (let i = chunk.indexStart; i < chunk.indexStart + chunk.indexCount; i++) {
        const index = mesh.indices[i] ?? -1;
        expect(index).toBeGreaterThanOrEqual(chunk.vertexStart);
        expect(index).toBeLessThan(chunk.vertexStart + chunk.vertexCount);
      }
      for (let v = chunk.vertexStart; v < chunk.vertexStart + chunk.vertexCount; v++) {
        const d = Math.hypot(
          (mesh.positions[v * 3] ?? 0) - chunk.center.x,
          (mesh.positions[v * 3 + 1] ?? 0) - chunk.center.y,
          (mesh.positions[v * 3 + 2] ?? 0) - chunk.center.z,
        );
        expect(d).toBeLessThanOrEqual(chunk.radius + 1e-3);
      }
    }
    expect(vertexCursor).toBe(mesh.vertexCount);
    expect(indexCursor).toBe(mesh.indices.length);

    // The chunk at 3_3 holds the prism then the wedge, in input order.
    const last = mesh.chunks[2];
    expect(last?.vertexCount).toBe(42 + 18);
    expect(mesh.roles[last?.vertexStart ?? 0]).toBe(mapSurfaceRoleIndex('moss'));
    expect(mesh.roles[(last?.vertexStart ?? 0) + 42]).toBe(mapSurfaceRoleIndex('litEdge'));
  });

  it('slices a chunk into views with rebased 16-bit indices', () => {
    const mesh = buildMapTriangles(tiny);
    const chunk = mesh.chunks[2];
    if (chunk === undefined) throw new Error('missing chunk');
    const slice = sliceMapChunk(mesh, chunk);
    expect(slice.indices).toBeInstanceOf(Uint16Array);
    expect(slice.positions).toHaveLength(chunk.vertexCount * 3);
    expect(slice.normals).toHaveLength(chunk.vertexCount * 3);
    expect(slice.roles).toHaveLength(chunk.vertexCount);
    expect(slice.positions.buffer).toBe(mesh.positions.buffer);
    expect(Math.max(...slice.indices)).toBe(chunk.vertexCount - 1);
    expect(Math.min(...slice.indices)).toBe(0);
    expect(slice.positions[0]).toBe(mesh.positions[chunk.vertexStart * 3]);
  });

  it('honours the chunk size option and tolerates a map without solids', () => {
    expect(buildMapTriangles(tiny, { chunkSize: 1000 }).chunks).toHaveLength(1);
    const empty = buildMapTriangles({ size: 1000, colliders: tiny.colliders });
    expect(empty.triangleCount).toBe(0);
    expect(empty.chunks).toEqual([]);
  });
});

describe.each(SEEDS)('createGreyboxSpires(seed %i)', (seed) => {
  const map: GreyboxMap = createGreyboxSpires(seed);
  const mesh: MapTriangles = buildMapTriangles(map);
  const { stormCenter, stormRadius, ceilingY, floorY, cloudSeaY } = map.colliders;

  it('is deterministic', () => {
    const again = createGreyboxSpires(seed);
    expect(again).toEqual(map);
    const meshAgain = buildMapTriangles(again);
    expect(meshAgain.positions).toEqual(mesh.positions);
    expect(meshAgain.normals).toEqual(mesh.normals);
    expect(meshAgain.roles).toEqual(mesh.roles);
    expect(meshAgain.indices).toEqual(mesh.indices);
    expect(meshAgain.chunks).toEqual(mesh.chunks);
  });

  it('fills the manifest contract', () => {
    expect(map.id).toBe('shattered-spires');
    expect(map.seed).toBe(seed);
    expect(map.size).toBe(2000);
    expect(map.chunkSize).toBe(GREYBOX_CHUNK_SIZE);
    expect(map.chunks).toEqual([]);
    expect(stormCenter).toEqual({ x: 0, y: 0, z: 0 });
    expect(stormRadius).toBe(map.size / 2);
    expect(floorY).toBeLessThanOrEqual(cloudSeaY);
    expect(ceilingY).toBeGreaterThan(cloudSeaY + 500);
    expect(
      Math.hypot(map.sky.sunDirection.x, map.sky.sunDirection.y, map.sky.sunDirection.z),
    ).toBeCloseTo(1, 5);
    expect(map.solids.length).toBe(map.centerSolidCount + map.halfSolidCount * 2);
    for (const solid of map.solids) {
      expect(MAP_SURFACE_ROLES).toContain(solid.role);
      if (solid.kind === 'prism') {
        expect(solid.radiusBottom).toBeGreaterThan(0);
        expect(solid.radiusTop).toBeGreaterThan(0);
        expect(solid.height).toBeGreaterThan(0);
        expect(solid.sides).toBeGreaterThanOrEqual(3);
      } else {
        expect(Math.min(solid.size.x, solid.size.y, solid.size.z)).toBeGreaterThan(0);
      }
    }
  });

  it('is mirror-symmetric in z = 0, solid by solid', () => {
    for (let i = 0; i < map.centerSolidCount; i++) {
      const solid = map.solids[i];
      if (solid === undefined) throw new Error('missing solid');
      expect(mirrorSolidZ(solid)).toEqual(solid);
    }
    for (let i = 0; i < map.halfSolidCount; i++) {
      const near = map.solids[map.centerSolidCount + i];
      const far = map.solids[map.centerSolidCount + map.halfSolidCount + i];
      if (near === undefined || far === undefined) throw new Error('missing solid');
      expect(far).toEqual(mirrorSolidZ(near));
      expect(near.position.z).toBeLessThan(0);
    }
  });

  it('has mirror-symmetric triangle geometry', () => {
    // Every vertex has a twin at -z: compare the two halves as sorted point sets.
    const key = (v: number, flip: number): [number, number, number] => [
      mesh.positions[v * 3] ?? 0,
      mesh.positions[v * 3 + 1] ?? 0,
      flip * (mesh.positions[v * 3 + 2] ?? 0),
    ];
    const near: [number, number, number][] = [];
    const far: [number, number, number][] = [];
    for (let v = 0; v < mesh.vertexCount; v++) {
      const z = mesh.positions[v * 3 + 2] ?? 0;
      if (z < -1e-3) near.push(key(v, 1));
      else if (z > 1e-3) far.push(key(v, -1));
    }
    expect(far.length).toBe(near.length);
    let sumNear = 0;
    let sumFar = 0;
    for (const p of near) sumNear += p[0] * 0.37 + p[1] * 0.11 + p[2] * 0.73;
    for (const p of far) sumFar += p[0] * 0.37 + p[1] * 0.11 + p[2] * 0.73;
    expect(Math.abs(sumNear - sumFar) / near.length).toBeLessThan(1e-3);
  });

  it('has mirror-balanced gates with five slots each', () => {
    expect(map.spawnGates).toHaveLength(TEAM_IDS.length);
    const ember = map.spawnGates[TEAM_EMBER];
    const frost = map.spawnGates[TEAM_FROST];
    if (ember === undefined || frost === undefined) throw new Error('missing gate');
    expect(ember.team).toBe(TEAM_EMBER);
    expect(frost.team).toBe(TEAM_FROST);
    expect(ember.slots).toHaveLength(MAX_TEAM_SIZE);
    expect(frost.slots).toHaveLength(MAX_TEAM_SIZE);
    expect(frost.position).toEqual({ ...ember.position, z: -ember.position.z });
    ember.slots.forEach((slot, i) => {
      expect(frost.slots[i]).toEqual({ ...slot, z: -slot.z });
      expect(slot.y).toBeGreaterThan(cloudSeaY + 100);
      expect(slot.y).toBeLessThan(ceilingY - 100);
    });
    // No two riders overlap (a dragon spans about 14 m).
    for (let i = 0; i < ember.slots.length; i++) {
      for (let j = i + 1; j < ember.slots.length; j++) {
        const a = ember.slots[i];
        const b = ember.slots[j];
        if (a === undefined || b === undefined) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThanOrEqual(15);
      }
    }
    // Both face the centre: dragon forward (+Z) rotated by the gate orientation.
    for (const gate of [ember, frost]) {
      const q = gate.orientation;
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6);
      const forwardX = 2 * (q.x * q.z + q.w * q.y);
      const forwardZ = 1 - 2 * (q.x * q.x + q.y * q.y);
      expect(forwardX).toBeCloseTo(0, 6);
      expect(forwardZ).toBeCloseTo(-Math.sign(gate.position.z), 6);
    }
  });

  it('keeps every launch corridor clear of solids', () => {
    for (const gate of map.spawnGates) {
      const direction = -Math.sign(gate.position.z);
      for (const slot of gate.slots) {
        for (let d = 0; d <= GREYBOX_GATE_CORRIDOR_LENGTH; d += 5) {
          const z = slot.z + direction * d;
          for (const solid of map.solids) {
            if (distanceToSolidBound(solid, slot.x, slot.y, z) < GREYBOX_GATE_CORRIDOR_RADIUS) {
              throw new Error(
                `solid ${solid.kind} at ${JSON.stringify(solid.position)} blocks team ` +
                  `${gate.team} slot at d=${d}`,
              );
            }
          }
        }
        // And against the real mesh: no vertex inside the corridor capsule.
        const zEnd = slot.z + direction * GREYBOX_GATE_CORRIDOR_LENGTH;
        const zMin = Math.min(slot.z, zEnd);
        const zMax = Math.max(slot.z, zEnd);
        for (let v = 0; v < mesh.vertexCount; v++) {
          const vz = mesh.positions[v * 3 + 2] ?? 0;
          const dz = vz < zMin ? zMin - vz : vz > zMax ? vz - zMax : 0;
          const d = Math.hypot(
            (mesh.positions[v * 3] ?? 0) - slot.x,
            (mesh.positions[v * 3 + 1] ?? 0) - slot.y,
            dz,
          );
          expect(d).toBeGreaterThanOrEqual(GREYBOX_GATE_CORRIDOR_RADIUS);
        }
      }
    }
  });

  it('lets the whole slot fan through the team arch', () => {
    // Past the corridor, to the far side of the arch: every slot's straight launch line keeps
    // GREYBOX_GATE_ARCH_CLEARANCE of free air (boxes are measured exactly, prisms as cylinders).
    expect(GREYBOX_GATE_ARCH_DISTANCE).toBeGreaterThan(GREYBOX_GATE_CORRIDOR_LENGTH);
    for (const gate of map.spawnGates) {
      const direction = -Math.sign(gate.position.z);
      for (const slot of gate.slots) {
        let nearest = Infinity;
        for (let d = 0; d <= GREYBOX_GATE_ARCH_DISTANCE + 20; d += 2) {
          const z = slot.z + direction * d;
          for (const solid of map.solids) {
            nearest = Math.min(nearest, distanceToSolidBound(solid, slot.x, slot.y, z));
          }
        }
        expect(nearest).toBeGreaterThanOrEqual(GREYBOX_GATE_ARCH_CLEARANCE - 1e-6);
        // The arch is really there: the legs stand within a dragon's glance of the line.
        expect(nearest).toBeLessThan(GREYBOX_GATE_ARCH_CLEARANCE + 40);
      }
    }
  });

  it('has no rock ending inside the cloud sea within reach of a dragon', () => {
    // The floor hazard holds a dragon at most stormVerticalMaxDepth under floorY. Whatever
    // stands in the sea must be rooted below that, or a diving dragon could pass under it.
    const reach = Math.max(...Object.values(CLASS_TUNING).map((cls) => cls.hitRadius));
    const deepest = floorY - COLLISION_TUNING.stormVerticalMaxDepth - reach;
    expect(COLLISION_TUNING.stormVerticalMaxDepth).toBeGreaterThan(0);
    let rooted = 0;
    let shallowest = -Infinity;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const y = mesh.positions[v * 3 + 1] ?? 0;
      if (y >= cloudSeaY) continue;
      rooted++;
      shallowest = Math.max(shallowest, y);
    }
    expect(rooted).toBeGreaterThan(100);
    expect(shallowest).toBeLessThan(deepest - 2);
    // And the hazard starts at the opaque surface, not far below it where nobody can see.
    expect(cloudSeaY - floorY).toBeLessThanOrEqual(2 * reach);
  });

  it('keeps all geometry inside the storm wall and under the ceiling', () => {
    expect(GREYBOX_SOLID_MAX_RADIUS).toBeLessThan(stormRadius);
    let maxRadius = 0;
    let maxY = -Infinity;
    for (let v = 0; v < mesh.vertexCount; v++) {
      maxRadius = Math.max(maxRadius, horizontalRadius(mesh.positions, v));
      maxY = Math.max(maxY, mesh.positions[v * 3 + 1] ?? 0);
    }
    expect(maxRadius).toBeLessThanOrEqual(GREYBOX_SOLID_MAX_RADIUS);
    expect(maxY).toBeLessThanOrEqual(ceilingY - 50);
  });

  it('has valid indices, finite data and outward winding for every solid', () => {
    expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
    expect(mesh.normals.length).toBe(mesh.vertexCount * 3);
    expect(mesh.roles.length).toBe(mesh.vertexCount);
    for (const index of mesh.indices) expect(index).toBeLessThan(mesh.vertexCount);
    for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
    for (const value of mesh.normals) expect(Number.isFinite(value)).toBe(true);
    for (const role of mesh.roles) expect(role).toBeLessThan(MAP_SURFACE_ROLES.length);
    for (const solid of map.solids) {
      const single = triangulateSolid(solid);
      const volume = signedVolume(single.positions, single.indices, solid.position);
      expect(volume).toBeGreaterThan(0);
      expect(volume / analyticVolume(solid)).toBeCloseTo(1, 2);
    }
    // The whole soup: sum of the parts (solids may overlap, each still counts once).
    let total = 0;
    for (const solid of map.solids) total += analyticVolume(solid);
    const origin = { x: 0, y: 0, z: 0 };
    expect(signedVolume(mesh.positions, mesh.indices, origin) / total).toBeCloseTo(1, 2);
  });

  it('partitions the mesh into chunks of the 250 m grid', () => {
    let triangles = 0;
    const seen = new Set<string>();
    for (const chunk of mesh.chunks) {
      expect(seen.has(chunk.id)).toBe(false);
      seen.add(chunk.id);
      expect(chunk.cellX).toBeGreaterThanOrEqual(0);
      expect(chunk.cellX).toBeLessThan(map.size / map.chunkSize);
      expect(chunk.cellZ).toBeGreaterThanOrEqual(0);
      expect(chunk.cellZ).toBeLessThan(map.size / map.chunkSize);
      expect(chunk.vertexCount).toBeGreaterThan(0);
      expect(chunk.vertexCount).toBeLessThanOrEqual(65535);
      triangles += chunk.indexCount / 3;
    }
    expect(triangles).toBe(mesh.triangleCount);
    // One merged mesh per chunk must leave most of the draw-call budget to everything else.
    expect(mesh.chunks.length).toBeLessThanOrEqual(64);
    expect(mesh.chunks.length).toBeLessThanOrEqual(QUALITY_PRESETS.low.maxDrawCalls / 2);
  });

  it('stays inside the triangle budgets', () => {
    expect(mesh.triangleCount).toBeLessThanOrEqual(VISUAL_TRIANGLE_BUDGET);
    expect(mesh.triangleCount).toBeLessThanOrEqual(QUALITY_PRESETS.low.maxTriangles / 4);
    expect(mesh.triangleCount).toBeLessThanOrEqual(COLLISION_TRIANGLE_BUDGET);
    const low = buildMapTriangles(map, LOW_DETAIL_COLLISION_OPTIONS);
    expect(low.triangleCount).toBe(countMapTriangles(map.solids, LOW_DETAIL_COLLISION_OPTIONS));
    expect(low.triangleCount).toBeLessThanOrEqual(LOW_DETAIL_COLLISION_TRIANGLE_BUDGET);
    expect(low.triangleCount).toBeLessThan(mesh.triangleCount);
  });

  it('offers cover within 4 s of cruise flight everywhere in the bowl', () => {
    let worst = 0;
    for (let x = -850; x <= 850; x += 25) {
      for (let z = -850; z <= 850; z += 25) {
        if (Math.hypot(x, z) > 850) continue;
        let nearest = Infinity;
        for (let v = 0; v < mesh.vertexCount; v++) {
          const dx = (mesh.positions[v * 3] ?? 0) - x;
          const dz = (mesh.positions[v * 3 + 2] ?? 0) - z;
          const d = dx * dx + dz * dz;
          if (d < nearest) nearest = d;
        }
        worst = Math.max(worst, Math.sqrt(nearest));
      }
    }
    expect(worst).toBeLessThanOrEqual(GREYBOX_COVER_DISTANCE);
  });

  it('looks like the brief: a bowl of varied pillars, bridges, a ring and a sky-well', () => {
    const shafts = map.solids.filter(
      (solid) => solid.kind === 'prism' && solid.role === 'stone' && solid.height > 150,
    );
    expect(shafts.length).toBeGreaterThanOrEqual(40);
    expect(shafts.some((solid) => solid.pitch !== 0 || solid.roll !== 0)).toBe(true);
    const heights = shafts.map((solid) => (solid.kind === 'prism' ? solid.height : 0));
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(150);
    // Bowl: rim pillars stand taller than the ones near the centre.
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    const top = (solid: MapSolid): number => {
      const { positions } = triangulateSolid(solid);
      let y = -Infinity;
      for (let i = 1; i < positions.length; i += 3) y = Math.max(y, positions[i] ?? 0);
      return y;
    };
    const radial = (solid: MapSolid): number => Math.hypot(solid.position.x, solid.position.z);
    const inner = shafts.filter((solid) => radial(solid) < 450).map(top);
    const outer = shafts.filter((solid) => radial(solid) > 650).map(top);
    expect(inner.length).toBeGreaterThan(0);
    expect(outer.length).toBeGreaterThan(0);
    expect(mean(outer)).toBeGreaterThan(mean(inner) + 100);

    expect(map.solids.some((solid) => solid.kind === 'box' && solid.size.x > 80)).toBe(true);
    expect(map.solids.filter((solid) => solid.role === 'skyWell').length).toBeGreaterThan(0);
    expect(map.solids.filter((solid) => solid.role === 'ember').length).toBe(
      map.solids.filter((solid) => solid.role === 'frost').length,
    );
    expect(map.solids.some((solid) => solid.role === 'ember')).toBe(true);
    const ring = map.solids.filter(
      (solid) => Math.abs(radial(solid) - map.skyWell.ringRadius) < 1 && solid.kind === 'prism',
    );
    expect(ring.length).toBeGreaterThanOrEqual(10);
  });
});

describe('createGreyboxSpires', () => {
  it('defaults to the documented seed and varies with the seed', () => {
    expect(createGreyboxSpires()).toEqual(createGreyboxSpires(GREYBOX_SPIRES_DEFAULT_SEED));
    expect(createGreyboxSpires(1).solids).not.toEqual(createGreyboxSpires(2).solids);
  });

  it('prints its size (informational)', () => {
    const map = createGreyboxSpires();
    const mesh = buildMapTriangles(map);
    const low = countMapTriangles(map.solids, LOW_DETAIL_COLLISION_OPTIONS);
    console.info(
      `greybox spires: ${map.solids.length} solids, ${mesh.triangleCount} triangles ` +
        `(${low} low-detail), ${mesh.vertexCount} vertices, ${mesh.chunks.length} chunks`,
    );
    expect(mesh.triangleCount).toBeGreaterThan(0);
  });
});
