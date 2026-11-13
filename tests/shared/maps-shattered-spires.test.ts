/**
 * Shattered Spires, the real map (T-4.5): the layout data, its half-turn balance, the collision
 * mesh built from hulls x placements, and the same play guarantees the greybox map had (every
 * spawn slot launches clear, nobody ends a tick inside rock, storm wall, floor and ceiling).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_BUDGETS,
  CLASS_TUNING,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_IN_STORM,
  MAX_PLAYERS,
  MAX_TEAM_SIZE,
  SHATTERED_SPIRES_DEFAULT_SEED,
  SPIRES_CEILING_Y,
  SPIRES_CROWN_RADIUS,
  SPIRES_DUEL_CORRIDOR_LENGTH,
  SPIRES_DUEL_GATE_DISTANCE,
  SPIRES_DUEL_RING_INNER,
  SPIRES_DUEL_RING_OUTER,
  SPIRES_FLOOR_Y,
  SPIRES_GATE_CORRIDOR_LENGTH,
  SPIRES_GATE_CORRIDOR_RADIUS,
  SPIRES_GATE_DISTANCE,
  SPIRES_SOLID_MAX_RADIUS,
  SPIRES_STORM_RADIUS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
  buildMapTriangles,
  buildPlacementInstances,
  countPlacementTriangles,
  createGreyboxSpires,
  createInputFrame,
  createSeededRandom,
  createShatteredSpires,
  mapAssetType,
  mapAssetTypes,
  placementPoint,
  rotatePlacementHalfTurn,
  spawnGatesForMode,
  writePlacementMatrix,
} from '../../src/shared';
import type { DragonClassId, InputFrame, MapPlacement, SpawnGate, Vec3 } from '../../src/shared';
import { createSim } from '../../src/sim';
import type { DragonState, Sim } from '../../src/sim';
import { createMapCollisionWorld } from '../../src/sim/collision';
import type { MapCollisionWorld } from '../../src/sim/collision';

const MAP = createShatteredSpires();
const WORLD = createMapCollisionWorld(MAP);
const CLASSES: readonly DragonClassId[] = ['talon', 'bastion', 'tempest', 'wraith'];
const ASSETS_DIR = resolve(__dirname, '../../public/assets');

function isAlive(dragon: DragonState): boolean {
  return (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
}

/** `closestPoint` answers -1 when nothing is within its search distance. */
function near(distance: number): number {
  return distance < 0 ? Infinity : distance;
}

function terrainOf(world: MapCollisionWorld) {
  const terrain = world.terrain;
  if (terrain === null) throw new Error('map has no terrain');
  return terrain;
}

describe('map asset types', () => {
  it('decodes every generated type with closed, outward-wound convex hulls', () => {
    const types = [...mapAssetTypes().values()];
    expect(types.length).toBeGreaterThanOrEqual(20);
    for (const type of types) {
      expect(type.hullIndices.length % 3).toBe(0);
      expect(type.hullTriangles).toBe(type.hullIndices.length / 3);
      const vertexCount = type.hullPositions.length / 3;
      let volume = 0;
      const edges = new Map<string, number>();
      for (let t = 0; t < type.hullIndices.length; t += 3) {
        const ids = [type.hullIndices[t] ?? 0, type.hullIndices[t + 1] ?? 0, type.hullIndices[t + 2] ?? 0];
        const p = ids.map((id) => {
          expect(id).toBeLessThan(vertexCount);
          return [type.hullPositions[id * 3] ?? 0, type.hullPositions[id * 3 + 1] ?? 0, type.hullPositions[id * 3 + 2] ?? 0];
        }) as [number[], number[], number[]];
        const [a, b, c] = p;
        volume +=
          (a[0] ?? 0) * ((b[1] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[1] ?? 0)) +
          (a[1] ?? 0) * ((b[2] ?? 0) * (c[0] ?? 0) - (b[0] ?? 0) * (c[2] ?? 0)) +
          (a[2] ?? 0) * ((b[0] ?? 0) * (c[1] ?? 0) - (b[1] ?? 0) * (c[0] ?? 0));
        for (let e = 0; e < 3; e++) {
          const from = ids[e] ?? 0;
          const to = ids[(e + 1) % 3] ?? 0;
          edges.set(`${from}>${to}`, (edges.get(`${from}>${to}`) ?? 0) + 1);
        }
      }
      // Closed and consistently wound: every directed edge once, its reverse once.
      for (const [edge, count] of edges) {
        const [from, to] = edge.split('>');
        expect(count, `${type.id} edge ${edge}`).toBe(1);
        expect(edges.get(`${to}>${from}`), `${type.id} edge ${edge} reverse`).toBe(1);
      }
      if (type.hullTriangles > 0) expect(volume, type.id).toBeGreaterThan(0);
      if (type.kind === 'backdrop') expect(type.hullTriangles).toBe(0);
    }
  });

  it('keeps every asset inside its budget, with the files on disk', () => {
    for (const type of mapAssetTypes().values()) {
      const path = resolve(ASSETS_DIR, type.glb);
      expect(existsSync(path), type.glb).toBe(true);
      const bytes = statSync(path).size;
      if (type.kind === 'rock') {
        expect(bytes).toBeLessThanOrEqual(ASSET_BUDGETS.heroRockMaxFileBytes);
        expect(type.lodTriangles).toHaveLength(3);
        type.lodTriangles.forEach((triangles, lod) => {
          expect(triangles).toBeLessThanOrEqual(ASSET_BUDGETS.heroRockLodTriangles[lod] ?? 0);
        });
      } else {
        expect(bytes).toBeLessThanOrEqual(ASSET_BUDGETS.propMaxFileBytes);
        expect(type.lodTriangles[0] ?? Infinity).toBeLessThanOrEqual(ASSET_BUDGETS.propMaxTriangles);
      }
      for (let lod = 1; lod < type.lodTriangles.length; lod++) {
        expect(type.lodTriangles[lod] ?? 0).toBeLessThan(type.lodTriangles[lod - 1] ?? 0);
      }
    }
  });
});

describe('placements', () => {
  const sample: MapPlacement = {
    type: 'arch-great',
    position: { x: 10, y: 20, z: -30 },
    yaw: 0.7,
    pitch: 0.2,
    roll: -0.1,
    scale: 1.5,
    team: TEAM_EMBER,
  };

  it('writes a column-major matrix that agrees with placementPoint', () => {
    const m = new Float32Array(16);
    writePlacementMatrix(sample, m);
    const p = placementPoint(sample, 3, -4, 5);
    expect(m[0]! * 3 + m[4]! * -4 + m[8]! * 5 + m[12]!).toBeCloseTo(p.x, 4);
    expect(m[1]! * 3 + m[5]! * -4 + m[9]! * 5 + m[13]!).toBeCloseTo(p.y, 4);
    expect(m[2]! * 3 + m[6]! * -4 + m[10]! * 5 + m[14]!).toBeCloseTo(p.z, 4);
    expect(m[15]).toBe(1);
    // local +Z is the front: (sin yaw, 0, cos yaw) without tilt
    const flat = placementPoint({ ...sample, pitch: 0, roll: 0, scale: 1, position: { x: 0, y: 0, z: 0 } }, 0, 0, 1);
    expect(flat.x).toBeCloseTo(Math.sin(0.7), 6);
    expect(flat.z).toBeCloseTo(Math.cos(0.7), 6);
  });

  it('half-turn twin: an involution that swaps teams and maps points to (-x, y, -z)', () => {
    const twin = rotatePlacementHalfTurn(sample);
    expect(twin.team).toBe(TEAM_FROST);
    const p = placementPoint(sample, 3, -4, 5);
    const q = placementPoint(twin, 3, -4, 5);
    expect(q.x).toBeCloseTo(-p.x, 9);
    expect(q.y).toBeCloseTo(p.y, 9);
    expect(q.z).toBeCloseTo(-p.z, 9);
    const back = rotatePlacementHalfTurn(twin);
    expect(back.position).toEqual(sample.position);
    expect(back.yaw).toBeCloseTo(sample.yaw, 12);
    expect(back.team).toBe(TEAM_EMBER);
  });

  it('groups instances per type with matrices, spheres and teams', () => {
    const sets = buildPlacementInstances(MAP.placements);
    let total = 0;
    for (const set of sets) {
      total += set.count;
      expect(set.matrices).toHaveLength(set.count * 16);
      expect(set.spheres).toHaveLength(set.count * 4);
      for (let i = 0; i < set.count; i++) {
        const placement = MAP.placements[set.placementIndices[i] ?? 0];
        expect(placement?.type).toBe(set.type.id);
        expect(set.matrices[i * 16 + 12]).toBeCloseTo(placement?.position.x ?? NaN, 3);
        expect(set.spheres[i * 4 + 3] ?? 0).toBeGreaterThan(0);
        expect(set.teams[i]).toBe(placement?.team ?? 255);
      }
    }
    expect(total).toBe(MAP.placements.length);
    expect(sets.map((set) => set.type.id)).toEqual(MAP.props.map((prop) => prop.id));
    MAP.props.forEach((prop, i) => expect(prop.count).toBe(sets[i]?.count));
  });
});

describe('createShatteredSpires', () => {
  it('fills the manifest contract', () => {
    expect(MAP.id).toBe('shattered-spires');
    expect(MAP.seed).toBe(SHATTERED_SPIRES_DEFAULT_SEED);
    expect(MAP.size).toBe(2000);
    expect(MAP.colliders.stormRadius).toBe(SPIRES_STORM_RADIUS);
    expect(MAP.colliders.floorY).toBe(SPIRES_FLOOR_Y);
    expect(MAP.colliders.ceilingY).toBe(SPIRES_CEILING_Y);
    expect(MAP.solids).toBeUndefined();
    expect(MAP.placements.length).toBe(MAP.centerPlacementCount + 2 * MAP.halfPlacementCount);
    expect(Math.hypot(MAP.sky.sunDirection.x, MAP.sky.sunDirection.y, MAP.sky.sunDirection.z)).toBeCloseTo(1, 5);
    for (const placement of MAP.placements) {
      expect(() => mapAssetType(placement.type)).not.toThrow();
      expect(placement.scale).toBeGreaterThan(0);
      for (const value of [placement.position.x, placement.position.y, placement.position.z, placement.yaw, placement.pitch, placement.roll]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    // The same arena envelope as the greybox: wire quantisation and bot bounds stay valid.
    const greybox = createGreyboxSpires();
    expect(MAP.colliders.stormRadius).toBe(greybox.colliders.stormRadius);
    expect(MAP.colliders.floorY).toBe(greybox.colliders.floorY);
    expect(MAP.colliders.ceilingY).toBe(greybox.colliders.ceilingY);
  });

  it('is deterministic and varies with the seed', () => {
    expect(JSON.stringify(createShatteredSpires())).toBe(JSON.stringify(MAP));
    const other = createShatteredSpires(1234);
    expect(JSON.stringify(other.placements)).not.toBe(JSON.stringify(MAP.placements));
    // the authored landmarks do not move with the seed
    expect(other.spawnGates).toEqual(MAP.spawnGates);
    expect(other.placements.filter((p) => p.type === 'crown-claw')).toHaveLength(6);
  });

  it('is its own image under a half turn, placement by placement and triangle by triangle', () => {
    const { centerPlacementCount: c, halfPlacementCount: h } = MAP;
    for (let i = 0; i < h; i++) {
      const a = MAP.placements[c + i];
      const b = MAP.placements[c + h + i];
      if (a === undefined || b === undefined) throw new Error('missing placement');
      expect(b).toEqual(rotatePlacementHalfTurn(a));
    }
    for (let i = 0; i < c; i++) {
      const p = MAP.placements[i];
      expect(p?.position.x).toBe(0);
      expect(p?.position.z).toBe(0);
    }
    const triangles = buildMapTriangles(MAP);
    let sumX = 0;
    let sumZ = 0;
    let sumY = 0;
    for (let v = 0; v < triangles.vertexCount; v++) {
      sumX += triangles.positions[v * 3] ?? 0;
      sumY += triangles.positions[v * 3 + 1] ?? 0;
      sumZ += triangles.positions[v * 3 + 2] ?? 0;
    }
    // Everything off the axis has a twin; only the sky-well crystal's own shape is left over.
    expect(Math.abs(sumX / triangles.vertexCount)).toBeLessThan(0.05);
    expect(Math.abs(sumZ / triangles.vertexCount)).toBeLessThan(0.05);
    expect(sumY).toBeGreaterThan(0);
  });

  it('has half-turn balanced gates with five slots each, for matches and for Duel', () => {
    const check = (gates: readonly SpawnGate[], distance: number): void => {
      expect(gates).toHaveLength(2);
      const ember = gates[TEAM_EMBER];
      const frost = gates[TEAM_FROST];
      if (ember === undefined || frost === undefined) throw new Error('missing gate');
      expect(ember.team).toBe(TEAM_EMBER);
      expect(frost.team).toBe(TEAM_FROST);
      expect(ember.position.z).toBe(-distance);
      expect(frost.position.z).toBe(distance);
      expect(ember.orientation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
      expect(frost.orientation).toEqual({ x: 0, y: 1, z: 0, w: 0 });
      expect(ember.slots).toHaveLength(MAX_TEAM_SIZE);
      ember.slots.forEach((slot, i) => {
        const twin = frost.slots[i];
        expect(twin?.x).toBe(slot.x === 0 ? 0 : -slot.x);
        expect(twin?.y).toBe(slot.y);
        expect(twin?.z).toBe(-slot.z);
        expect(slot.z).toBeLessThanOrEqual(-distance);
      });
      const xs = new Set(ember.slots.map((slot) => slot.x));
      expect(xs.size).toBe(MAX_TEAM_SIZE);
    };
    check(MAP.spawnGates, SPIRES_GATE_DISTANCE);
    check(MAP.duelSpawnGates, SPIRES_DUEL_GATE_DISTANCE);
    expect(spawnGatesForMode(MAP, 'duel')).toBe(MAP.duelSpawnGates);
    expect(spawnGatesForMode(MAP, 'skirmish')).toBe(MAP.spawnGates);
    expect(spawnGatesForMode(createGreyboxSpires(), 'duel')).toHaveLength(2);
    // DECISIONS 34: the Duel storm may close to well inside the match gates.
    expect(SPIRES_DUEL_GATE_DISTANCE + 60).toBeLessThan(SPIRES_STORM_RADIUS * 0.55);
  });

  it('keeps every launch lane clear of rock, for both gate sets', () => {
    const terrain = terrainOf(WORLD);
    const lanes: [readonly SpawnGate[], number][] = [
      [MAP.spawnGates, SPIRES_GATE_CORRIDOR_LENGTH],
      [MAP.duelSpawnGates, SPIRES_DUEL_CORRIDOR_LENGTH],
    ];
    let tightest = Infinity;
    let where = '';
    for (const [gates, length] of lanes) {
      for (const gate of gates) {
        const direction = gate.team === TEAM_EMBER ? 1 : -1;
        for (const slot of gate.slots) {
          for (let d = 0; d <= length; d += 5) {
            const distance = terrain.closestPoint(slot.x, slot.y, slot.z + direction * d, 200);
            if (distance >= 0 && distance < tightest) {
              tightest = distance;
              where = `slot (${slot.x}, ${slot.y}, ${slot.z}) + ${d} m: rock at (${terrain.closestX.toFixed(0)}, ${terrain.closestY.toFixed(0)}, ${terrain.closestZ.toFixed(0)})`;
            }
            expect(terrain.solidDepth(slot.x, slot.y, slot.z + direction * d)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
    expect(tightest, where).toBeGreaterThanOrEqual(SPIRES_GATE_CORRIDOR_RADIUS);
  });

  it('keeps all collision inside the storm wall, under the ceiling, and rooted below the floor', () => {
    const triangles = buildMapTriangles(MAP);
    let maxRadius = 0;
    let maxY = -Infinity;
    for (let v = 0; v < triangles.vertexCount; v++) {
      maxRadius = Math.max(maxRadius, Math.hypot(triangles.positions[v * 3] ?? 0, triangles.positions[v * 3 + 2] ?? 0));
      maxY = Math.max(maxY, triangles.positions[v * 3 + 1] ?? 0);
    }
    expect(maxRadius).toBeLessThanOrEqual(SPIRES_SOLID_MAX_RADIUS);
    expect(maxY).toBeLessThan(SPIRES_CEILING_Y - 40);
    // Rocks that stand in the cloud sea reach below the storm's hard floor limit (floor - 40):
    // no dragon can get under them.
    for (const placement of MAP.placements) {
      const type = mapAssetType(placement.type);
      if (type.kind !== 'rock' || type.anchor !== 'base' || placement.position.y > 0) continue;
      expect(placement.position.y + type.boundsMin.y * placement.scale).toBeLessThan(SPIRES_FLOOR_Y - 40);
    }
  });

  it('looks like the brief: crown, open ring, arches, islands with ruins, canyons, rim, gates', () => {
    const count = (type: string): number => MAP.placements.filter((p) => p.type === type).length;
    expect(count('crystal-core')).toBe(1);
    expect(count('crown-claw')).toBe(6);
    expect(count('crown-base')).toBe(2);
    expect(count('aerie-gate')).toBe(2);
    expect(count('arch-great') + count('arch-broken')).toBeGreaterThanOrEqual(8);
    expect(count('island-large') + count('island-small')).toBeGreaterThanOrEqual(10);
    expect(count('cliff-wall')).toBeGreaterThanOrEqual(12);
    expect(count('spire-tall') + count('spire-twin') + count('spire-lean')).toBeGreaterThanOrEqual(12);
    expect(count('column-ruined') + count('column-broken') + count('wall-fragment')).toBeGreaterThanOrEqual(10);
    expect(count('standing-stone')).toBeGreaterThanOrEqual(8);
    expect(count('crystal-cluster')).toBeGreaterThanOrEqual(6);
    expect(count('backdrop-a') + count('backdrop-b')).toBe(14);
    for (const claw of MAP.placements.filter((p) => p.type === 'crown-claw')) {
      expect(Math.hypot(claw.position.x, claw.position.z)).toBeCloseTo(SPIRES_CROWN_RADIUS, 6);
    }
    // The duelling ring: nothing rooted or large between the crown and the mid ring.
    for (const placement of MAP.placements) {
      const radius = Math.hypot(placement.position.x, placement.position.z);
      if (radius > SPIRES_DUEL_RING_INNER && radius < SPIRES_DUEL_RING_OUTER) {
        expect(placement.type).toBe('shard-cluster');
      }
    }
    // Team-tinted pieces carry their team; the tint flips with the half.
    const tinted = MAP.placements.filter((p) => p.team !== undefined);
    expect(tinted.length).toBeGreaterThanOrEqual(10);
    for (const placement of tinted) {
      expect(mapAssetType(placement.type).hasTint).toBe(true);
      expect(placement.team).toBe(placement.position.z < 0 ? TEAM_EMBER : TEAM_FROST);
    }
    // Backdrop pieces stand outside the arena.
    for (const placement of MAP.placements.filter((p) => p.group === 'backdrop')) {
      const type = mapAssetType(placement.type);
      const reach = Math.hypot(
        Math.max(-type.boundsMin.x, type.boundsMax.x),
        Math.max(-type.boundsMin.z, type.boundsMax.z),
      );
      const radius = Math.hypot(placement.position.x, placement.position.z);
      expect(radius - reach * placement.scale).toBeGreaterThan(SPIRES_STORM_RADIUS + 50);
    }
  });

  it('offers cover everywhere in the bowl outside the duelling ring', () => {
    const terrain = terrainOf(WORLD);
    let worst = 0;
    for (let x = -800; x <= 800; x += 80) {
      for (let z = -800; z <= 800; z += 80) {
        const radius = Math.hypot(x, z);
        if (radius > 800 || radius < SPIRES_DUEL_RING_OUTER + 60) continue;
        let nearest = Infinity;
        for (const y of [120, 250, 380]) nearest = Math.min(nearest, near(terrain.closestPoint(x, y, z, Infinity)));
        worst = Math.max(worst, nearest);
      }
    }
    console.info(`shattered spires: furthest point from cover ${worst.toFixed(0)} m`);
    expect(worst).toBeLessThan(330);
  });

  it('stays inside the triangle and draw-call plan (informational numbers printed)', () => {
    const start = performance.now();
    const world = createMapCollisionWorld(MAP);
    const buildMs = performance.now() - start;
    const collisionTriangles = countPlacementTriangles(MAP.placements);
    expect(terrainOf(world).triangleCount).toBeGreaterThan(collisionTriangles * 0.98);
    let lod0 = 0;
    let lodLast = 0;
    let instancedMeshes = 0;
    for (const set of buildPlacementInstances(MAP.placements)) {
      lod0 += (set.type.lodTriangles[0] ?? 0) * set.count;
      lodLast += (set.type.lodTriangles[set.type.lodTriangles.length - 1] ?? 0) * set.count;
      instancedMeshes += set.type.hasTint ? 2 : 1;
    }
    console.info(
      `shattered spires: ${MAP.placements.length} placements of ${MAP.props.length} types, ` +
        `${collisionTriangles} collision triangles, collision world built in ${buildMs.toFixed(1)} ms, ` +
        `${lod0} triangles if all at LOD0, ${lodLast} if all at the last LOD, ` +
        `${instancedMeshes} instanced meshes at one LOD per type`,
    );
    expect(collisionTriangles).toBeLessThan(60_000);
    expect(instancedMeshes).toBeLessThanOrEqual(40);
    expect(lodLast).toBeLessThan(200_000);
  });

  it('matches the baked manifest in public/assets', () => {
    const path = resolve(ASSETS_DIR, 'maps/shattered-spires/manifest.json');
    expect(existsSync(path)).toBe(true);
    const baked = JSON.parse(readFileSync(path, 'utf8')) as typeof MAP;
    expect(baked.id).toBe(MAP.id);
    expect(baked.placements).toHaveLength(MAP.placements.length);
    expect(baked.spawnGates).toEqual(JSON.parse(JSON.stringify(MAP.spawnGates)));
    expect(baked.duelSpawnGates).toEqual(JSON.parse(JSON.stringify(MAP.duelSpawnGates)));
    expect(baked.props.map((prop) => [prop.id, prop.count])).toEqual(MAP.props.map((prop) => [prop.id, prop.count]));
    baked.placements.forEach((placement, i) => {
      const live = MAP.placements[i];
      expect(placement.type).toBe(live?.type);
      expect(placement.position.x).toBeCloseTo(live?.position.x ?? NaN, 2);
      expect(placement.position.z).toBeCloseTo(live?.position.z ?? NaN, 2);
    });
    for (const prop of baked.props) {
      const file = resolve(ASSETS_DIR, prop.instances);
      expect(existsSync(file), prop.instances).toBe(true);
      expect(statSync(file).size).toBe(prop.count * 64);
    }
    const root = JSON.parse(readFileSync(resolve(ASSETS_DIR, 'manifest.json'), 'utf8')) as { maps: Record<string, string> };
    expect(root.maps['shattered-spires']).toBe('maps/shattered-spires/manifest.json');
  });
});

// --- Flying it -------------------------------------------------------------------------------------

describe('shattered spires in the sim', () => {
  it('launches every spawn slot of both gate sets with no input and no touch', () => {
    let hits = 0;
    const world = createMapCollisionWorld(MAP, {
      onTerrainHit() {
        hits++;
      },
    });
    for (const [gates, length] of [
      [MAP.spawnGates, SPIRES_GATE_CORRIDOR_LENGTH],
      [MAP.duelSpawnGates, SPIRES_DUEL_CORRIDOR_LENGTH],
    ] as const) {
      for (const classId of CLASSES) {
        for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
          const gate = gates[team];
          if (gate === undefined) throw new Error('missing gate');
          for (const slot of gate.slots) {
            const sim = createSim({ collisionWorld: world });
            sim.spawnDragon(0, team, classId, slot, team === TEAM_EMBER ? 0 : Math.PI);
            const inputs = [createInputFrame()];
            let tick = 0;
            for (; tick < 30 * TICK_HZ; tick++) {
              sim.step(tick, inputs);
              const dragon = sim.getDragon(0);
              if (dragon === undefined) throw new Error('missing dragon');
              if (Math.abs(dragon.position.z - slot.z) >= length) break;
            }
            expect(tick).toBeLessThan(30 * TICK_HZ);
            expect(hits).toBe(0);
          }
        }
      }
    }
  });

  interface Flock {
    readonly sim: Sim;
    readonly world: MapCollisionWorld;
    readonly inputs: InputFrame[];
    hits: number;
    step(tick: number): void;
  }

  /** MAX_PLAYERS seeded random pilots; the odd ones aim at the nearest rock every second or so. */
  function makeFlock(seed: number): Flock {
    const random = createSeededRandom(seed);
    const flock: Flock = {
      sim: undefined as unknown as Sim,
      world: createMapCollisionWorld(MAP, {
        onTerrainHit() {
          flock.hits++;
        },
      }),
      inputs: [],
      hits: 0,
      step(tick) {
        for (let id = 0; id < MAX_PLAYERS; id++) {
          const input = flock.inputs[id];
          const dragon = flock.sim.getDragon(id);
          if (input === undefined || dragon === undefined) continue;
          input.tick = tick;
          if (random() < 0.07) {
            input.steerX = random() * 2 - 1;
            input.steerY = random() * 2 - 1.2;
            input.buttons = Math.floor(random() * 2048);
          }
          if (!isAlive(dragon)) {
            if (random() < 0.02) spawn(id);
          } else if (id % 2 === 1 && random() < 0.03) {
            const terrain = terrainOf(flock.world);
            const p = dragon.position;
            if (terrain.closestPoint(p.x, p.y, p.z, Infinity) > 0) {
              const dx = terrain.closestX - p.x;
              const dy = terrain.closestY - p.y;
              const dz = terrain.closestZ - p.z;
              dragon.yaw = Math.atan2(dx, dz);
              dragon.pitch = Math.atan2(dy, Math.hypot(dx, dz));
            }
          }
        }
        flock.sim.step(tick, flock.inputs);
      },
    };
    const sim = createSim({ collisionWorld: flock.world });
    (flock as { sim: Sim }).sim = sim;

    function spawn(id: number): void {
      const team = id % 4 < 2 ? TEAM_EMBER : TEAM_FROST;
      const classId = CLASSES[id % CLASSES.length] ?? 'tempest';
      if (id % 2 === 0) {
        const slot = MAP.spawnGates[team]?.slots[Math.floor(id / 2)];
        if (slot === undefined) throw new Error('no spawn slot');
        sim.spawnDragon(id, team, classId, slot, team === TEAM_EMBER ? 0 : Math.PI);
        return;
      }
      const terrain = terrainOf(flock.world);
      const spot = { x: 0, y: 0, z: 0 };
      do {
        spot.x = (random() - 0.5) * 1300;
        spot.y = 40 + random() * 320;
        spot.z = (random() - 0.5) * 1300;
      } while (near(terrain.closestPoint(spot.x, spot.y, spot.z, 30)) < 12 || terrain.solidDepth(spot.x, spot.y, spot.z) > 0);
      sim.spawnDragon(id, team, classId, spot, (random() - 0.5) * 2 * Math.PI);
    }

    for (let id = 0; id < MAX_PLAYERS; id++) {
      flock.inputs.push(createInputFrame());
      spawn(id);
    }
    return flock;
  }

  it('10 random pilots x 1000 ticks: nobody ends a tick inside the rock, nothing is NaN', () => {
    let hits = 0;
    let stormTicks = 0;
    let samples = 0;
    let overlaps = 0;
    let deepest = 0;
    for (const seed of [1, 2, 3]) {
      const flock = makeFlock(seed);
      const terrain = terrainOf(flock.world);
      for (let tick = 0; tick < 1000; tick++) {
        flock.step(tick);
        for (let id = 0; id < MAX_PLAYERS; id++) {
          const dragon = flock.sim.getDragon(id);
          if (dragon === undefined) throw new Error('missing dragon');
          const p = dragon.position;
          if (!Number.isFinite(p.x + p.y + p.z + dragon.yaw + dragon.pitch + dragon.health)) {
            throw new Error(`seed ${seed}, tick ${tick}, dragon ${id}: not finite`);
          }
          if ((dragon.flags & DRAGON_FLAG_IN_STORM) !== 0) stormTicks++;
          if (dragon.phaseTicks !== 0) continue;
          if (terrain.solidDepth(p.x, p.y, p.z) > 0) {
            throw new Error(`seed ${seed}, tick ${tick}, dragon ${id}: centre inside the rock`);
          }
          // The sphere itself may dip into a crease between two overlapping hulls for a tick
          // or two while the resolver works it out; it must stay rare and shallow.
          samples++;
          const radius = CLASS_TUNING[dragon.classId].hitRadius;
          const distance = terrain.closestPoint(p.x, p.y, p.z, 50);
          if (distance >= 0 && distance < radius - 1e-3) {
            overlaps++;
            deepest = Math.max(deepest, radius - distance);
          }
        }
      }
      hits += flock.hits;
    }
    console.info(
      `shattered spires fuzz: ${hits} terrain hits, ${overlaps} of ${samples} dragon-ticks with the sphere ` +
        `dipping into rock (deepest ${deepest.toFixed(2)} m), ${stormTicks} storm ticks`,
    );
    expect(hits).toBeGreaterThan(100);
    expect(overlaps).toBeLessThan(samples * 0.002);
    expect(deepest).toBeLessThan(2.4);
  });

  it('is deterministic: the same inputs give the same states', () => {
    const run = (): string => {
      const flock = makeFlock(7);
      const trace: string[] = [];
      for (let tick = 0; tick < 500; tick++) {
        flock.step(tick);
        if (tick % 50 === 49) trace.push(JSON.stringify(flock.sim.current));
      }
      trace.push(String(flock.hits));
      return trace.join('\n');
    };
    expect(run()).toBe(run());
  });

  it('never tunnels: boosting straight at the crown, a wall and an island stops outside', () => {
    const terrain = terrainOf(WORLD);
    const targets: Vec3[] = [];
    for (const type of ['crown-claw', 'cliff-wall', 'island-large', 'aerie-gate', 'arch-great']) {
      const placement = MAP.placements.find((p) => p.type === type);
      if (placement === undefined) throw new Error(`no ${type}`);
      const t = mapAssetType(type);
      targets.push(placementPoint(placement, (t.boundsMin.x + t.boundsMax.x) / 2, (t.boundsMin.y + t.boundsMax.y) / 2, (t.boundsMin.z + t.boundsMax.z) / 2));
    }
    for (const target of targets) {
      for (const angle of [0.3, 1.9, 3.6, 5.2]) {
        // start 260 m out, on a clear spot, pointed at the target
        const start = { x: target.x + Math.cos(angle) * 260, y: Math.max(target.y, 60), z: target.z + Math.sin(angle) * 260 };
        if (near(terrain.closestPoint(start.x, start.y, start.z, 30)) < 15 || Math.hypot(start.x, start.z) > 950) continue;
        const sim = createSim({ collisionWorld: WORLD });
        const yaw = Math.atan2(target.x - start.x, target.z - start.z);
        sim.spawnDragon(0, TEAM_EMBER, 'talon', start, yaw);
        const input = createInputFrame();
        input.buttons = 1 << 1;
        for (let tick = 0; tick < 12 * TICK_HZ; tick++) {
          sim.step(tick, [input]);
          const dragon = sim.getDragon(0);
          if (dragon === undefined) throw new Error('missing dragon');
          const p = dragon.position;
          if (dragon.phaseTicks === 0) expect(terrain.solidDepth(p.x, p.y, p.z)).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  it('holds the storm wall, the cloud floor and the ceiling', () => {
    const fly = (start: Vec3, yaw: number, pitch: number): DragonState => {
      const sim = createSim({ collisionWorld: createMapCollisionWorld(MAP) });
      sim.spawnDragon(0, TEAM_EMBER, 'bastion', start, yaw);
      const dragon = sim.getDragon(0);
      if (dragon === undefined) throw new Error('missing dragon');
      dragon.pitch = pitch;
      const input = createInputFrame();
      let flagged = false;
      let worst = 0;
      for (let tick = 0; tick < 12 * TICK_HZ; tick++) {
        sim.step(tick, [input]);
        if ((dragon.flags & DRAGON_FLAG_IN_STORM) !== 0) flagged = true;
        worst = Math.max(
          worst,
          Math.hypot(dragon.position.x, dragon.position.z) - SPIRES_STORM_RADIUS,
          SPIRES_FLOOR_Y - dragon.position.y,
          dragon.position.y - SPIRES_CEILING_Y,
        );
      }
      expect(flagged).toBe(true);
      // pushed back or held: never far out
      expect(worst).toBeLessThan(260);
      return dragon;
    };
    // out through the wall in the open lane behind the rim, heading +X from a clear spot
    fly({ x: 930, y: 620, z: 0 }, Math.PI / 2, 0);
    // down into the cloud sea in the duelling ring
    const diver = fly({ x: 0, y: 60, z: 285 }, 0, -1.2);
    expect(diver.position.y).toBeGreaterThan(SPIRES_FLOOR_Y - 45);
    // up through the ceiling
    const climber = fly({ x: 0, y: 760, z: 285 }, 0, 1.2);
    expect(climber.position.y).toBeLessThan(SPIRES_CEILING_Y + 45);
  });
});
