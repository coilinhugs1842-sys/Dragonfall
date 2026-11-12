/**
 * Emberfall Caldera, the second map (T-6.4): the layout data, its half-turn balance, the heat
 * vents (data only), the cover rule, the collision mesh built from hulls x placements, the
 * budgets, the baked manifest, and the same play guarantees as Shattered Spires (every spawn slot
 * launches clear, nobody ends a tick inside rock).
 *
 * The map module is imported by its own path: it does not have to be in the src/shared barrel.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_BUDGETS,
  CLASS_TUNING,
  FLIGHT_TUNING,
  DRAGON_FLAG_ALIVE,
  MAX_PLAYERS,
  MAX_TEAM_SIZE,
  SPIRES_CEILING_Y,
  SPIRES_CHUNK_SIZE,
  SPIRES_CLOUD_SEA_Y,
  SPIRES_DUEL_CORRIDOR_LENGTH,
  SPIRES_DUEL_GATE_DISTANCE,
  SPIRES_DUEL_GATE_Y,
  SPIRES_FLOOR_Y,
  SPIRES_GATE_CORRIDOR_LENGTH,
  SPIRES_GATE_CORRIDOR_RADIUS,
  SPIRES_GATE_DISTANCE,
  SPIRES_GATE_Y,
  SPIRES_MAP_SIZE,
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
} from '../../src/shared';
import type { DragonClassId, InputFrame, SpawnGate, Vec3 } from '../../src/shared';
import {
  CALDERA_ASH_SEA_Y,
  CALDERA_CEILING_Y,
  CALDERA_CHUNK_SIZE,
  CALDERA_CONE_RADIUS,
  CALDERA_COVER_SECONDS,
  CALDERA_DUEL_CORRIDOR_LENGTH,
  CALDERA_DUEL_GATE_DISTANCE,
  CALDERA_DUEL_GATE_Y,
  CALDERA_DUEL_RING_INNER,
  CALDERA_DUEL_RING_OUTER,
  CALDERA_FLOOR_Y,
  CALDERA_GATE_CORRIDOR_LENGTH,
  CALDERA_GATE_CORRIDOR_RADIUS,
  CALDERA_GATE_DISTANCE,
  CALDERA_GATE_Y,
  CALDERA_MAP_SIZE,
  CALDERA_SKY,
  CALDERA_SKY_WELL_Y,
  CALDERA_SOLID_MAX_RADIUS,
  CALDERA_STORM_RADIUS,
  EMBERFALL_CALDERA_DEFAULT_SEED,
  EMBERFALL_VENTS,
  createEmberfallCaldera,
  registerEmberfallAssetTypes,
} from '../../src/shared/maps/emberfall-caldera';
import type { MapVent } from '../../src/shared/maps/emberfall-caldera';
import { CALDERA_ASSET_TYPES, CALDERA_HULL_QUANTUM } from '../../src/shared/maps/generated/emberfall-caldera-hulls';
import { SPIRES_ASSET_TYPES, SPIRES_HULL_QUANTUM } from '../../src/shared/maps/generated/shattered-spires-hulls';
import { createSim } from '../../src/sim';
import type { DragonState, Sim } from '../../src/sim';
import { createMapCollisionWorld } from '../../src/sim/collision';
import type { MapCollisionWorld } from '../../src/sim/collision';
import { checkManifest } from '../../tools/pipeline/manifest.mjs';

const MAP = createEmberfallCaldera();
const WORLD = createMapCollisionWorld(MAP);
const CLASSES: readonly DragonClassId[] = ['talon', 'bastion', 'tempest', 'wraith'];
const REPO = resolve(__dirname, '../..');
const ASSETS_DIR = resolve(REPO, 'public/assets');
const CALDERA_IDS = new Set(CALDERA_ASSET_TYPES.map((type) => type.id));
/** First-map GLBs the caldera uses from where they are. */
const SHARED_IDS = ['crystal-core', 'banner-tall', 'chain'];
/** 4 s at cruise speed (docs/GAME_DESIGN.md: 45 m/s). */
const COVER_METRES = CALDERA_COVER_SECONDS * FLIGHT_TUNING.cruiseSpeed;
/** Inner face of the crater wall, about: nothing playable stands beyond it. */
const CALDERA_RIM_INNER = 770;

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

function count(type: string): number {
  return MAP.placements.filter((p) => p.type === type).length;
}

describe('emberfall caldera asset types', () => {
  it('registers its types next to those of the first map, idempotently, without touching them', () => {
    const before = [...mapAssetTypes().keys()];
    registerEmberfallAssetTypes();
    registerEmberfallAssetTypes();
    expect([...mapAssetTypes().keys()]).toEqual(before);
    expect(CALDERA_ASSET_TYPES).toHaveLength(19);
    expect(CALDERA_HULL_QUANTUM).toBe(SPIRES_HULL_QUANTUM);
    for (const source of CALDERA_ASSET_TYPES) {
      expect(mapAssetType(source.id).glb).toBe(source.glb);
      expect(source.glb.startsWith('maps/emberfall-caldera/')).toBe(true);
    }
    // no id of the caldera shadows a first-map type
    for (const source of SPIRES_ASSET_TYPES) {
      expect(CALDERA_IDS.has(source.id), source.id).toBe(false);
      expect(mapAssetType(source.id).glb).toBe(source.glb);
    }
  });

  it('decodes every type with closed, outward-wound convex hulls', () => {
    for (const source of CALDERA_ASSET_TYPES) {
      const type = mapAssetType(source.id);
      expect(type.hullIndices.length % 3).toBe(0);
      expect(type.hullTriangles).toBe(source.hullTriangles);
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
      for (const [edge, n] of edges) {
        const [from, to] = edge.split('>');
        expect(n, `${type.id} edge ${edge}`).toBe(1);
        expect(edges.get(`${to}>${from}`), `${type.id} edge ${edge} reverse`).toBe(1);
      }
      if (type.hullTriangles > 0) expect(volume, type.id).toBeGreaterThan(0);
      if (type.kind === 'backdrop') expect(type.hullTriangles).toBe(0);
      if (type.kind === 'rock') expect(type.hullTriangles, type.id).toBeGreaterThan(0);
    }
    // markers are signs, not obstacles
    expect(mapAssetType('vent-marker').hullTriangles).toBe(0);
  });

  it('keeps every asset inside its budget, with the files on disk', () => {
    let bytesTotal = 0;
    for (const source of CALDERA_ASSET_TYPES) {
      const type = mapAssetType(source.id);
      const path = resolve(ASSETS_DIR, type.glb);
      expect(existsSync(path), type.glb).toBe(true);
      const bytes = statSync(path).size;
      bytesTotal += bytes;
      expect(source.bytes, `${type.id}: generated size is stale, re-run export_caldera_assets.mjs`).toBe(bytes);
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
    console.info(`emberfall caldera: ${CALDERA_ASSET_TYPES.length} GLBs, ${(bytesTotal / 1048576).toFixed(2)} MB`);
    expect(bytesTotal).toBeLessThan(8 * 1048576);
  });

  it('has a generated hulls file that matches the Blender output and the placements', () => {
    for (const source of CALDERA_ASSET_TYPES) {
      const raw = resolve(REPO, `art-source/maps/caldera/hulls/${source.id}.json`);
      if (!existsSync(raw)) continue;
      const meta = JSON.parse(readFileSync(raw, 'utf8')) as {
        kind: string;
        triangles: number[];
        hasTint: boolean;
        hulls: { verts: number[][]; tris: number[][] }[];
      };
      expect(source.kind).toBe(meta.kind);
      expect(source.lodTriangles).toEqual(meta.triangles);
      expect(source.hasTint).toBe(meta.hasTint);
      expect(source.hullCount).toBe(meta.hulls.length);
      expect(source.hullTriangles).toBe(meta.hulls.reduce((sum, hull) => sum + hull.tris.length, 0));
      // every hull vertex fits the Int16 packing at the quantum, with room for the layout's scales
      for (const hull of meta.hulls) {
        for (const v of hull.verts) {
          for (const c of v) expect(Math.abs(c)).toBeLessThan(327);
        }
      }
    }
    // every placed type is a caldera type or one of the three shared first-map props
    let hullTriangles = 0;
    for (const placement of MAP.placements) {
      expect(CALDERA_IDS.has(placement.type) || SHARED_IDS.includes(placement.type), placement.type).toBe(true);
      const source = CALDERA_ASSET_TYPES.find((type) => type.id === placement.type);
      hullTriangles += source?.hullTriangles ?? mapAssetType(placement.type).hullTriangles;
    }
    expect(countPlacementTriangles(MAP.placements)).toBe(hullTriangles);
    // and every caldera type is used
    for (const id of CALDERA_IDS) expect(count(id), id).toBeGreaterThan(0);
  });
});

describe('createEmberfallCaldera', () => {
  it('fills the manifest contract, with the same envelope as Shattered Spires and the greybox', () => {
    expect(MAP.id).toBe('emberfall-caldera');
    expect(MAP.name).toBe('Emberfall Caldera');
    expect(MAP.seed).toBe(EMBERFALL_CALDERA_DEFAULT_SEED);
    expect(MAP.solids).toBeUndefined();
    expect(MAP.chunks).toEqual([]);
    expect(MAP.placements.length).toBe(MAP.centerPlacementCount + 2 * MAP.halfPlacementCount);
    for (const placement of MAP.placements) {
      expect(() => mapAssetType(placement.type)).not.toThrow();
      expect(placement.scale).toBeGreaterThan(0);
      for (const value of [placement.position.x, placement.position.y, placement.position.z, placement.yaw, placement.pitch, placement.roll]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    const spires = createShatteredSpires();
    const greybox = createGreyboxSpires();
    for (const other of [spires, greybox]) {
      expect(MAP.size).toBe(other.size);
      expect(MAP.chunkSize).toBe(other.chunkSize);
      expect(MAP.colliders.stormCenter).toEqual(other.colliders.stormCenter);
      expect(MAP.colliders.stormRadius).toBe(other.colliders.stormRadius);
      expect(MAP.colliders.floorY).toBe(other.colliders.floorY);
      expect(MAP.colliders.ceilingY).toBe(other.colliders.ceilingY);
      expect(MAP.colliders.cloudSeaY).toBe(other.colliders.cloudSeaY);
    }
    expect([CALDERA_MAP_SIZE, CALDERA_STORM_RADIUS, CALDERA_CHUNK_SIZE, CALDERA_ASH_SEA_Y, CALDERA_FLOOR_Y, CALDERA_CEILING_Y]).toEqual([
      SPIRES_MAP_SIZE,
      SPIRES_STORM_RADIUS,
      SPIRES_CHUNK_SIZE,
      SPIRES_CLOUD_SEA_Y,
      SPIRES_FLOOR_Y,
      SPIRES_CEILING_Y,
    ]);
    expect([CALDERA_SOLID_MAX_RADIUS, CALDERA_GATE_DISTANCE, CALDERA_GATE_Y, CALDERA_DUEL_GATE_DISTANCE, CALDERA_DUEL_GATE_Y]).toEqual([
      SPIRES_SOLID_MAX_RADIUS,
      SPIRES_GATE_DISTANCE,
      SPIRES_GATE_Y,
      SPIRES_DUEL_GATE_DISTANCE,
      SPIRES_DUEL_GATE_Y,
    ]);
    expect([CALDERA_GATE_CORRIDOR_LENGTH, CALDERA_GATE_CORRIDOR_RADIUS, CALDERA_DUEL_CORRIDOR_LENGTH]).toEqual([
      SPIRES_GATE_CORRIDOR_LENGTH,
      SPIRES_GATE_CORRIDOR_RADIUS,
      SPIRES_DUEL_CORRIDOR_LENGTH,
    ]);
    // gates and sky-well in the same places: the two maps are interchangeable for the game layer
    expect(MAP.spawnGates).toEqual(spires.spawnGates);
    expect(MAP.duelSpawnGates).toEqual(spires.duelSpawnGates);
    expect(MAP.skyWell.position).toEqual(spires.skyWell.position);
  });

  it('has its own dusk sky: low orange sun, violet fog, crimson (not orange) lava', () => {
    const sky = MAP.sky;
    expect(sky).toBe(CALDERA_SKY);
    expect(Math.hypot(sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z)).toBeCloseTo(1, 5);
    // 12 degrees above the horizon, from +X: side light for both teams alike
    expect((Math.asin(sky.sunDirection.y) * 180) / Math.PI).toBeCloseTo(12, 3);
    expect(sky.sunDirection.z).toBe(0);
    expect(sky.sunColor).toBe(0xff9a5c);
    expect(sky.fogColor).toBe(0x7a4e5a);
    expect(sky.hemisphereSkyColor).toBe(0x6b5a8c);
    expect(sky.hemisphereGroundColor).toBe(0x4a2a20);
    expect(sky.panorama).toBeUndefined();
    for (const [key, value] of Object.entries(sky)) {
      if (key === 'sunDirection' || key === 'fogDensity') continue;
      expect(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffff, key).toBe(true);
    }
    // Lava must not read as team Ember (#FF7A1A): much less green than red, some blue, and dim.
    for (const lava of [sky.seaGlowColor, sky.bounceColor]) {
      const r = (lava >> 16) & 255;
      const g = (lava >> 8) & 255;
      const b = lava & 255;
      expect(g / r).toBeLessThan(0.3); // Ember orange: 0.48
      expect(b).toBeGreaterThan(g);
      expect(r).toBeLessThan(0xc0);
    }
    // a different place from the first map
    const spires = createShatteredSpires();
    expect(sky.sunColor).not.toBe(spires.sky.sunColor);
    expect(sky.fogColor).not.toBe(spires.sky.fogColor);
    expect(sky.sunDirection.y).toBeLessThan(spires.sky.sunDirection.y);
  });

  it('is deterministic and varies with the seed', () => {
    expect(JSON.stringify(createEmberfallCaldera())).toBe(JSON.stringify(MAP));
    const other = createEmberfallCaldera(1234);
    expect(JSON.stringify(other.placements)).not.toBe(JSON.stringify(MAP.placements));
    expect(JSON.stringify(createEmberfallCaldera(1234))).toBe(JSON.stringify(other));
    // the authored landmarks do not move with the seed
    expect(other.spawnGates).toEqual(MAP.spawnGates);
    expect(other.duelSpawnGates).toEqual(MAP.duelSpawnGates);
    expect(other.vents).toBe(EMBERFALL_VENTS);
    expect(other.placements.filter((p) => p.type === 'cone-wall')).toHaveLength(4);
    expect(other.placements.filter((p) => p.type === 'caldera-gate').map((p) => p.position)).toEqual(
      MAP.placements.filter((p) => p.type === 'caldera-gate').map((p) => p.position),
    );
    // other seeds keep the guarantees that matter most
    for (const seed of [1, 77, 0xc0ffee]) {
      const variant = createEmberfallCaldera(seed);
      const terrain = terrainOf(createMapCollisionWorld(variant));
      for (const gates of [variant.spawnGates, variant.duelSpawnGates]) {
        for (const gate of gates) {
          const direction = gate.team === TEAM_EMBER ? 1 : -1;
          for (const slot of gate.slots) {
            for (let d = 0; d <= CALDERA_DUEL_CORRIDOR_LENGTH; d += 10) {
              expect(near(terrain.closestPoint(slot.x, slot.y, slot.z + direction * d, 60)), `seed ${seed}`).toBeGreaterThanOrEqual(
                CALDERA_GATE_CORRIDOR_RADIUS,
              );
            }
          }
        }
      }
      const triangles = buildMapTriangles(variant);
      for (let v = 0; v < triangles.vertexCount; v++) {
        expect(Math.hypot(triangles.positions[v * 3] ?? 0, triangles.positions[v * 3 + 2] ?? 0)).toBeLessThanOrEqual(CALDERA_SOLID_MAX_RADIUS);
      }
    }
  });

  it('is its own image under a half turn, placement by placement and triangle by triangle', () => {
    const { centerPlacementCount: c, halfPlacementCount: h } = MAP;
    for (let i = 0; i < h; i++) {
      const a = MAP.placements[c + i];
      const b = MAP.placements[c + h + i];
      if (a === undefined || b === undefined) throw new Error('missing placement');
      expect(b).toEqual(rotatePlacementHalfTurn(a));
    }
    expect(c).toBe(4);
    for (let i = 0; i < c; i++) {
      const p = MAP.placements[i];
      expect(p?.position.x).toBe(0);
      expect(p?.position.z).toBe(0);
      expect(p?.team).toBeUndefined();
    }
    // Collision of the two halves: the same triangles, turned half a turn.
    // (One chunk for the whole map, so the triangles come in placement order in both.)
    const oneChunk = { chunkSize: CALDERA_MAP_SIZE * 2 };
    const halfA = buildMapTriangles({ ...MAP, placements: MAP.placements.slice(c, c + h) }, oneChunk);
    const halfB = buildMapTriangles({ ...MAP, placements: MAP.placements.slice(c + h) }, oneChunk);
    expect(halfB.vertexCount).toBe(halfA.vertexCount);
    expect(halfA.vertexCount).toBeGreaterThan(10_000);
    let worst = 0;
    for (let v = 0; v < halfA.vertexCount; v++) {
      worst = Math.max(
        worst,
        Math.abs((halfA.positions[v * 3] ?? 0) + (halfB.positions[v * 3] ?? 0)),
        Math.abs((halfA.positions[v * 3 + 1] ?? 0) - (halfB.positions[v * 3 + 1] ?? 0)),
        Math.abs((halfA.positions[v * 3 + 2] ?? 0) + (halfB.positions[v * 3 + 2] ?? 0)),
      );
    }
    expect(worst).toBeLessThan(1e-3);
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
      expect(new Set(ember.slots.map((slot) => slot.x)).size).toBe(MAX_TEAM_SIZE);
    };
    check(MAP.spawnGates, CALDERA_GATE_DISTANCE);
    check(MAP.duelSpawnGates, CALDERA_DUEL_GATE_DISTANCE);
    expect(spawnGatesForMode(MAP, 'duel')).toBe(MAP.duelSpawnGates);
    expect(spawnGatesForMode(MAP, 'skirmish')).toBe(MAP.spawnGates);
    // DECISIONS 34: the Duel storm may close to well inside the match gates.
    expect(CALDERA_DUEL_GATE_DISTANCE + 60).toBeLessThan(CALDERA_STORM_RADIUS * 0.55);
    // Each gate set stands on its own rock, 40 to 50 m under the slots.
    for (const [gates, type] of [
      [MAP.spawnGates, 'caldera-gate'],
      [MAP.duelSpawnGates, 'ash-island-small'],
    ] as const) {
      for (const gate of gates) {
        const under = MAP.placements.filter((p) => p.type === type && Math.hypot(p.position.x - gate.position.x, p.position.z - gate.position.z) < 40);
        expect(under).toHaveLength(1);
        const drop = gate.position.y - (under[0]?.position.y ?? NaN);
        expect(drop).toBeGreaterThan(40);
        expect(drop).toBeLessThan(50);
      }
    }
  });

  it('keeps every launch lane clear of rock, for both gate sets', () => {
    const terrain = terrainOf(WORLD);
    const lanes: [readonly SpawnGate[], number][] = [
      [MAP.spawnGates, CALDERA_GATE_CORRIDOR_LENGTH],
      [MAP.duelSpawnGates, CALDERA_DUEL_CORRIDOR_LENGTH],
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
    console.info(`emberfall caldera: tightest launch lane clearance ${tightest.toFixed(1)} m (${where})`);
    expect(tightest, where).toBeGreaterThanOrEqual(CALDERA_GATE_CORRIDOR_RADIUS);
  });

  it('keeps all collision inside the storm wall, under the ceiling, and rooted below the floor', () => {
    const triangles = buildMapTriangles(MAP);
    let maxRadius = 0;
    let maxY = -Infinity;
    for (let v = 0; v < triangles.vertexCount; v++) {
      maxRadius = Math.max(maxRadius, Math.hypot(triangles.positions[v * 3] ?? 0, triangles.positions[v * 3 + 2] ?? 0));
      maxY = Math.max(maxY, triangles.positions[v * 3 + 1] ?? 0);
    }
    console.info(`emberfall caldera: collision reaches radius ${maxRadius.toFixed(0)} m, height ${maxY.toFixed(0)} m`);
    expect(maxRadius).toBeLessThanOrEqual(CALDERA_SOLID_MAX_RADIUS);
    expect(maxY).toBeLessThan(CALDERA_CEILING_Y - 40);
    // Rocks that stand in the ash sea reach below the storm's hard floor limit (floor - 40): no
    // dragon can get under them.
    let rooted = 0;
    for (const placement of MAP.placements) {
      const type = mapAssetType(placement.type);
      if (type.kind !== 'rock' || type.anchor !== 'base' || placement.position.y > 0) continue;
      rooted++;
      expect(placement.position.y + type.boundsMin.y * placement.scale, placement.type).toBeLessThan(CALDERA_FLOOR_Y - 40);
    }
    expect(rooted).toBeGreaterThan(40);
  });

  it('looks like the brief: rim of crater wall, broken cone, trench, ash islands, vents, gates', () => {
    expect(count('crystal-core')).toBe(1);
    expect(count('cone-wall')).toBe(4);
    expect(count('caldera-gate')).toBe(2);
    // the rim: twelve slabs of wall, four of them breached, and four hooked teeth by the gates
    expect(count('crater-wall')).toBe(8);
    expect(count('crater-breach')).toBe(4);
    expect(count('rim-tooth')).toBeGreaterThanOrEqual(4);
    expect(count('lava-arch')).toBeGreaterThanOrEqual(6);
    expect(count('ash-island-large') + count('ash-island-small')).toBeGreaterThanOrEqual(12);
    expect(count('basalt-columns') + count('basalt-tall')).toBeGreaterThanOrEqual(12);
    expect(count('obsidian-shards') + count('obsidian-fan')).toBeGreaterThanOrEqual(12);
    expect(count('vent-chimney')).toBe(EMBERFALL_VENTS.length);
    expect(count('vent-marker')).toBe(2 + 3 * (EMBERFALL_VENTS.length - 1));
    expect(count('basalt-pylon') + count('obsidian-cluster') + count('fumarole')).toBeGreaterThanOrEqual(30);
    expect(count('backdrop-ridge') + count('backdrop-cone')).toBe(14);
    // nothing of the first map's stone: the caldera has its own silhouettes
    for (const placement of MAP.placements) {
      if (SHARED_IDS.includes(placement.type)) continue;
      expect(CALDERA_IDS.has(placement.type), placement.type).toBe(true);
    }
    // the cone: four segments on one ring, a wide gap toward each gate, a slit toward +-X
    const cone = MAP.placements.filter((p) => p.type === 'cone-wall');
    const angles = cone.map((p) => (Math.atan2(p.position.z, p.position.x) * 180) / Math.PI).sort((a, b) => a - b);
    for (const wall of cone) expect(Math.hypot(wall.position.x, wall.position.z)).toBeCloseTo(CALDERA_CONE_RADIUS, 6);
    expect((angles[1] ?? 0) - (angles[0] ?? 0)).toBeGreaterThan(90); // across Ember's axis (-90)
    expect((angles[2] ?? 0) - (angles[1] ?? 0)).toBeLessThan(90); // across +X
    // the rim: every wall on the rim radius, facing in, and none in front of a gate
    for (const wall of MAP.placements.filter((p) => p.type === 'crater-wall' || p.type === 'crater-breach')) {
      const radius = Math.hypot(wall.position.x, wall.position.z);
      expect(radius).toBeGreaterThan(780);
      expect(radius).toBeLessThan(840);
      const face = placementPoint({ ...wall, position: { x: 0, y: 0, z: 0 }, scale: 1 }, 0, 0, 1);
      expect((face.x * -wall.position.x + face.z * -wall.position.z) / radius).toBeGreaterThan(0.99);
      expect(Math.abs(wall.position.x)).toBeGreaterThan(150);
    }
    // The duelling ring: only drifting obsidian and a vent's chimney and rings.
    for (const placement of MAP.placements) {
      const radius = Math.hypot(placement.position.x, placement.position.z);
      if (radius > CALDERA_DUEL_RING_INNER && radius < CALDERA_DUEL_RING_OUTER) {
        expect(['obsidian-shards', 'vent-chimney', 'vent-marker']).toContain(placement.type);
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
      expect(type.kind).toBe('backdrop');
      const reach = Math.hypot(Math.max(-type.boundsMin.x, type.boundsMax.x), Math.max(-type.boundsMin.z, type.boundsMax.z));
      const radius = Math.hypot(placement.position.x, placement.position.z);
      expect(radius - reach * placement.scale).toBeGreaterThan(CALDERA_STORM_RADIUS + 50);
    }
    // The sky-well floats inside the cone, above the main chimney's throat.
    expect(MAP.skyWell.position).toEqual({ x: 0, y: CALDERA_SKY_WELL_Y, z: 0 });
    expect(MAP.skyWell.ringRadius).toBeGreaterThan(CALDERA_DUEL_RING_INNER);
    expect(MAP.skyWell.ringRadius).toBeLessThan(CALDERA_DUEL_RING_OUTER);
  });

  it('keeps the intro flyby out of the rock', () => {
    const spline = MAP.introSpline;
    if (spline === undefined) throw new Error('no intro spline');
    expect(spline.length).toBeGreaterThanOrEqual(4);
    const terrain = terrainOf(WORLD);
    const at = (i: number): Vec3 => spline[Math.min(Math.max(i, 0), spline.length - 1)] as Vec3;
    let tightest = Infinity;
    for (let segment = 0; segment + 1 < spline.length; segment++) {
      const [p0, p1, p2, p3] = [at(segment - 1), at(segment), at(segment + 1), at(segment + 2)];
      for (let step = 0; step <= 20; step++) {
        const t = step / 20;
        // uniform Catmull-Rom
        const blend = (a: number, b: number, c: number, d: number): number =>
          0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
        const x = blend(p0.x, p1.x, p2.x, p3.x);
        const y = blend(p0.y, p1.y, p2.y, p3.y);
        const z = blend(p0.z, p1.z, p2.z, p3.z);
        expect(terrain.solidDepth(x, y, z)).toBeLessThanOrEqual(0);
        tightest = Math.min(tightest, near(terrain.closestPoint(x, y, z, 300)));
      }
    }
    console.info(`emberfall caldera: intro flyby keeps ${tightest.toFixed(0)} m from the rock`);
    expect(tightest).toBeGreaterThan(20);
    // it ends looking at the cone from outside, the sun (+X) ahead
    const end = at(spline.length - 1);
    const start = at(0);
    expect(end.x).toBeGreaterThan(start.x);
    expect(Math.hypot(end.x, end.z)).toBeGreaterThan(CALDERA_DUEL_RING_INNER);
  });
});

describe('heat vents (data only)', () => {
  const half = (EMBERFALL_VENTS.length - 1) / 2;

  it('exports one main vent and four per team, twinned by the half turn', () => {
    expect(MAP.vents).toBe(EMBERFALL_VENTS);
    expect(EMBERFALL_VENTS).toHaveLength(9);
    const main = EMBERFALL_VENTS[0] as MapVent;
    expect(main.id).toBe('main');
    expect(main.position.x).toBe(0);
    expect(main.position.z).toBe(0);
    expect(new Set(EMBERFALL_VENTS.map((vent) => vent.id)).size).toBe(EMBERFALL_VENTS.length);
    for (let i = 0; i < half; i++) {
      const ember = EMBERFALL_VENTS[1 + i] as MapVent;
      const frost = EMBERFALL_VENTS[1 + half + i] as MapVent;
      expect(ember.id.endsWith('-ember')).toBe(true);
      expect(frost.id).toBe(ember.id.replace('-ember', '-frost'));
      expect(frost.position).toEqual({ x: -ember.position.x, y: ember.position.y, z: -ember.position.z });
      expect([frost.radius, frost.height, frost.lift, frost.boost]).toEqual([ember.radius, ember.height, ember.lift, ember.boost]);
      // Ember's vents are nearer Ember's gate than their twins are
      const gate = MAP.spawnGates[TEAM_EMBER]?.position as Vec3;
      expect(Math.hypot(ember.position.x - gate.x, ember.position.z - gate.z)).toBeLessThan(
        Math.hypot(frost.position.x - gate.x, frost.position.z - gate.z),
      );
    }
  });

  it('gives sane columns: inside the arena, mouth above the ash, top under the ceiling', () => {
    for (const vent of EMBERFALL_VENTS) {
      expect(vent.radius).toBeGreaterThanOrEqual(30);
      expect(vent.radius).toBeLessThanOrEqual(70);
      expect(vent.height).toBeGreaterThanOrEqual(200);
      expect(vent.lift).toBeGreaterThan(0);
      expect(vent.boost).toBeGreaterThan(0);
      expect(vent.position.y).toBeGreaterThan(CALDERA_ASH_SEA_Y + 10);
      expect(vent.position.y + vent.height).toBeLessThan(CALDERA_CEILING_Y - 200);
      expect(Math.hypot(vent.position.x, vent.position.z) + vent.radius).toBeLessThan(CALDERA_RIM_INNER);
    }
    // no two columns overlap
    for (const a of EMBERFALL_VENTS) {
      for (const b of EMBERFALL_VENTS) {
        if (a === b) continue;
        expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThan(a.radius + b.radius + 100);
      }
    }
  });

  it('stands every vent over a chimney, marks it with rings, and keeps its column free', () => {
    const terrain = terrainOf(WORLD);
    const chimney = mapAssetType('vent-chimney');
    const crystal = MAP.placements.find((p) => p.type === 'crystal-core');
    if (crystal === undefined) throw new Error('no sky-well crystal');
    const crystalType = mapAssetType('crystal-core');
    const crystalLow = crystal.position.y + crystalType.boundsMin.y * crystal.scale;
    const crystalHigh = crystal.position.y + crystalType.boundsMax.y * crystal.scale;
    // the crystal is slim: the column around it stays wide enough to ride
    const mainVent = EMBERFALL_VENTS[0] as MapVent;
    expect(Math.max(crystalType.boundsMax.x, -crystalType.boundsMin.x, crystalType.boundsMax.z, -crystalType.boundsMin.z) * crystal.scale).toBeLessThan(
      mainVent.radius * 0.5,
    );
    for (const vent of EMBERFALL_VENTS) {
      const under = MAP.placements.filter(
        (p) => p.type === 'vent-chimney' && Math.hypot(p.position.x - vent.position.x, p.position.z - vent.position.z) < 1e-6,
      );
      expect(under, vent.id).toHaveLength(1);
      const host = under[0];
      if (host === undefined) continue;
      // the mouth is the chimney's lava throat; the staves around it stay inside the column's radius
      expect(vent.position.y).toBeGreaterThan(host.position.y);
      expect(vent.position.y).toBeLessThan(host.position.y + chimney.boundsMax.y * host.scale);
      const rings = MAP.placements.filter(
        (p) => p.type === 'vent-marker' && Math.hypot(p.position.x - vent.position.x, p.position.z - vent.position.z) < 1e-6,
      );
      expect(rings.length).toBeGreaterThanOrEqual(2);
      for (const ring of rings) {
        expect(ring.position.y).toBeGreaterThan(vent.position.y);
        expect(ring.position.y).toBeLessThan(vent.position.y + vent.height);
        // a ring is 10 m in radius at scale 1: it sits inside the column
        expect(ring.scale * 10).toBeLessThanOrEqual(vent.radius);
      }
      // Above the chimney the column's core is free air all the way up, except that the main vent
      // carries its riders up AROUND the sky-well crystal, which hangs in the middle of the column.
      const clearFrom = host.position.y + chimney.boundsMax.y * host.scale + 25;
      for (let y = clearFrom; y <= vent.position.y + vent.height; y += 20) {
        if (vent.id === 'main' && y > crystalLow - vent.radius * 0.5 && y < crystalHigh + vent.radius * 0.5) continue;
        expect(terrain.solidDepth(vent.position.x, y, vent.position.z), `${vent.id} at y ${y}`).toBeLessThanOrEqual(0);
        expect(near(terrain.closestPoint(vent.position.x, y, vent.position.z, 60)), `${vent.id} at y ${y}`).toBeGreaterThan(vent.radius * 0.5);
      }
    }
  });

  it('leads every vent to cover: rock within the cover rule from the top of the column', () => {
    const terrain = terrainOf(WORLD);
    let worst = 0;
    for (const vent of EMBERFALL_VENTS) {
      for (const fraction of [0.5, 0.75, 1]) {
        // not counting the vent's own chimney: the nearest OTHER rock
        let nearest = Infinity;
        const y = vent.position.y + vent.height * fraction;
        for (let a = 0; a < 16; a++) {
          const angle = (a / 16) * Math.PI * 2;
          const x = vent.position.x + Math.cos(angle) * (vent.radius + 5);
          const z = vent.position.z + Math.sin(angle) * (vent.radius + 5);
          nearest = Math.min(nearest, near(terrain.closestPoint(x, y, z, 400)) + vent.radius + 5);
        }
        worst = Math.max(worst, nearest);
        expect(nearest, `${vent.id} at ${fraction}`).toBeLessThanOrEqual(COVER_METRES);
      }
    }
    console.info(`emberfall caldera: furthest vent column from cover ${worst.toFixed(0)} m (rule ${COVER_METRES} m)`);
  });
});

describe('the cover rule', () => {
  interface Route {
    readonly name: string;
    readonly points: readonly Vec3[];
  }

  function routes(): Route[] {
    const list: Route[] = [];
    const gate = MAP.spawnGates[TEAM_EMBER] as SpawnGate;
    const enemy = MAP.spawnGates[TEAM_FROST] as SpawnGate;
    const duel = MAP.duelSpawnGates[TEAM_EMBER] as SpawnGate;
    const ventOf = (id: string): MapVent => EMBERFALL_VENTS.find((vent) => vent.id === id) as MapVent;
    const top = (vent: MapVent, fraction: number): Vec3 => ({ x: vent.position.x, y: vent.position.y + vent.height * fraction, z: vent.position.z });
    // every launch lane, flown straight on to the cone
    gate.slots.forEach((slot, i) => list.push({ name: `gate slot ${i} lane`, points: [slot, { x: slot.x, y: slot.y, z: -CALDERA_DUEL_RING_INNER }] }));
    duel.slots.forEach((slot, i) => list.push({ name: `duel slot ${i} lane`, points: [slot, { x: slot.x, y: slot.y, z: -CALDERA_DUEL_RING_INNER }] }));
    // gate to gate straight over the cone
    list.push({ name: 'gate to gate, over the cone', points: [gate.position, { x: 0, y: 380, z: -260 }, { x: 0, y: 400, z: 0 }, { x: 0, y: 380, z: 260 }, enemy.position] });
    // gate to the sky-well through the cone's gap
    list.push({ name: 'gate to sky-well', points: [gate.position, { x: 0, y: 270, z: -300 }, { x: 0, y: 262, z: -60 }] });
    // gate to each of the team's vents and up its column
    for (const id of ['ring', 'trench', 'stairs', 'home']) {
      const vent = ventOf(`${id}-ember`);
      list.push({ name: `gate to ${id} vent`, points: [gate.position, top(vent, 0.2), top(vent, 1)] });
    }
    // the right flank: down into the trench, along it, up the vent at its end, on to the enemy's side
    const trench = MAP.trenches[0] ?? [];
    const trenchVent = ventOf('trench-ember');
    list.push({
      name: 'right flank through the trench',
      points: [gate.position, ...trench, top(trenchVent, 0.15), top(trenchVent, 0.9), { x: 610, y: 300, z: 290 }, { x: -228, y: 330, z: 562 }, enemy.position],
    });
    // the left flank: home vent, up the ash staircase, across to the cone's slit, on to the enemy gate
    const stairs = MAP.placements.filter((p) => p.group === 'stairs' && p.type.startsWith('ash-island') && p.position.z < 0);
    list.push({
      name: 'left flank up the staircase',
      points: [
        gate.position,
        top(ventOf('home-ember'), 0.5),
        ...stairs.map((p) => ({ x: p.position.x, y: p.position.y + 35, z: p.position.z })),
        { x: -300, y: 310, z: 0 },
        { x: -420, y: 260, z: 110 },
        { x: -150, y: 250, z: 320 },
        enemy.position,
      ],
    });
    // loops: the duelling ring, and the long way round at three radii and three flight levels
    for (const [radius, y] of [
      [310, 150],
      [310, 250],
      [310, 350],
      [470, 160],
      [470, 260],
      [470, 360],
      [600, 160],
      [600, 260],
      [600, 360],
      [700, 120],
      [700, 260],
    ] as const) {
      const points: Vec3[] = [];
      for (let a = 0; a <= 72; a++) {
        const angle = (a / 72) * Math.PI * 2;
        points.push({ x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius });
      }
      list.push({ name: `loop at ${radius} m, ${y} m up`, points });
    }
    return list;
  }

  it('every route has rock within 4 s of flight at cruise speed, all the way', () => {
    const terrain = terrainOf(WORLD);
    let worst = 0;
    let worstWhere = '';
    let samples = 0;
    const failures: string[] = [];
    for (const route of routes()) {
      let routeWorst = 0;
      let routeWhere = '';
      for (let i = 0; i + 1 < route.points.length; i++) {
        const a = route.points[i] as Vec3;
        const b = route.points[i + 1] as Vec3;
        const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        const steps = Math.max(1, Math.ceil(length / 15));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          const z = a.z + (b.z - a.z) * t;
          const distance = terrain.solidDepth(x, y, z) > 0 ? 0 : near(terrain.closestPoint(x, y, z, 600));
          samples++;
          if (distance > routeWorst) {
            routeWorst = distance;
            routeWhere = `(${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`;
          }
          if (distance > worst) {
            worst = distance;
            worstWhere = `${route.name} at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`;
          }
        }
      }
      if (routeWorst > COVER_METRES) failures.push(`${route.name}: ${routeWorst.toFixed(0)} m at ${routeWhere}`);
    }
    console.info(
      `emberfall caldera: cover rule over ${samples} route samples: furthest from rock ${worst.toFixed(0)} m = ` +
        `${(worst / FLIGHT_TUNING.cruiseSpeed).toFixed(1)} s at cruise (${worstWhere}); rule ${COVER_METRES} m`,
    );
    expect(failures).toEqual([]);
  });

  it('has no big hole anywhere in the bowl, at three flight levels', () => {
    const terrain = terrainOf(WORLD);
    let worstBest = 0;
    let worstAny = 0;
    let over = 0;
    let points = 0;
    for (let x = -760; x <= 760; x += 40) {
      for (let z = -760; z <= 760; z += 40) {
        if (Math.hypot(x, z) > CALDERA_RIM_INNER - 20) continue;
        let best = Infinity;
        for (const y of [150, 255, 360]) {
          const distance = terrain.solidDepth(x, y, z) > 0 ? 0 : near(terrain.closestPoint(x, y, z, 600));
          best = Math.min(best, distance);
          worstAny = Math.max(worstAny, distance);
          points++;
          if (distance > COVER_METRES) over++;
        }
        worstBest = Math.max(worstBest, best);
      }
    }
    console.info(
      `emberfall caldera: bowl grid (40 m, 3 levels, ${points} points): furthest from rock ${worstAny.toFixed(0)} m at any level, ` +
        `${worstBest.toFixed(0)} m at the best level; ${over} points beyond ${COVER_METRES} m`,
    );
    // From any spot there is a level with cover well inside the rule...
    expect(worstBest).toBeLessThanOrEqual(COVER_METRES * 0.85);
    // ...and nowhere, at any of the three levels, is rock further than the rule allows.
    expect(worstAny).toBeLessThanOrEqual(COVER_METRES);
    expect(over).toBe(0);
  });
});

describe('budgets and the baked manifest', () => {
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
    const spires = createShatteredSpires();
    console.info(
      `emberfall caldera: ${MAP.placements.length} placements of ${MAP.props.length} types, ` +
        `${collisionTriangles} collision triangles (shattered spires: ${countPlacementTriangles(spires.placements)} in ${spires.placements.length} placements), ` +
        `collision world built in ${buildMs.toFixed(1)} ms, ` +
        `${lod0} triangles if all at LOD0, ${lodLast} if all at the last LOD, ` +
        `${instancedMeshes} instanced meshes at one LOD per type`,
    );
    // the first map's limits
    expect(collisionTriangles).toBeLessThan(60_000);
    expect(instancedMeshes).toBeLessThanOrEqual(40);
    expect(lodLast).toBeLessThan(200_000);
    expect(MAP.placements.length).toBeLessThanOrEqual(320);
    // and the same weight class as the first map: within a third of its numbers
    expect(collisionTriangles).toBeLessThan(countPlacementTriangles(spires.placements) * 1.6);
  });

  it('groups instances per type and matches the prop sets', () => {
    const sets = buildPlacementInstances(MAP.placements);
    let total = 0;
    for (const set of sets) {
      total += set.count;
      expect(set.matrices).toHaveLength(set.count * 16);
    }
    expect(total).toBe(MAP.placements.length);
    expect(sets.map((set) => set.type.id)).toEqual(MAP.props.map((prop) => prop.id));
    MAP.props.forEach((prop, i) => {
      expect(prop.count).toBe(sets[i]?.count);
      expect(prop.instances).toBe(`maps/emberfall-caldera/instances/${prop.id}.bin`);
      expect(prop.glb).toBe(mapAssetType(prop.id).glb);
    });
    // shared props come from the first map's folder, everything else from this map's
    for (const prop of MAP.props) {
      expect(prop.glb.startsWith(SHARED_IDS.includes(prop.id) ? 'maps/shattered-spires/props/' : 'maps/emberfall-caldera/')).toBe(true);
    }
  });

  it('matches the baked manifest in public/assets', () => {
    const path = resolve(ASSETS_DIR, 'maps/emberfall-caldera/manifest.json');
    expect(existsSync(path)).toBe(true);
    const baked = JSON.parse(readFileSync(path, 'utf8')) as Omit<typeof MAP, 'textures'> & {
      textures: { id: string; url: string; role: string }[];
    };
    expect(baked.id).toBe(MAP.id);
    expect(baked.seed).toBe(MAP.seed);
    expect(baked.placements).toHaveLength(MAP.placements.length);
    expect(baked.spawnGates).toEqual(JSON.parse(JSON.stringify(MAP.spawnGates)));
    expect(baked.duelSpawnGates).toEqual(JSON.parse(JSON.stringify(MAP.duelSpawnGates)));
    expect(baked.vents).toEqual(JSON.parse(JSON.stringify(MAP.vents)));
    expect(baked.sky).toEqual(JSON.parse(JSON.stringify(MAP.sky)));
    expect(baked.colliders).toEqual(JSON.parse(JSON.stringify(MAP.colliders)));
    expect(baked.props.map((prop) => [prop.id, prop.count])).toEqual(MAP.props.map((prop) => [prop.id, prop.count]));
    baked.placements.forEach((placement, i) => {
      const live = MAP.placements[i];
      expect(placement.type).toBe(live?.type);
      expect(placement.position.x).toBeCloseTo(live?.position.x ?? NaN, 2);
      expect(placement.position.y).toBeCloseTo(live?.position.y ?? NaN, 2);
      expect(placement.position.z).toBeCloseTo(live?.position.z ?? NaN, 2);
      expect(placement.yaw).toBeCloseTo(live?.yaw ?? NaN, 4);
      expect(placement.scale).toBeCloseTo(live?.scale ?? NaN, 3);
      expect(placement.team).toBe(live?.team);
    });
    for (const prop of baked.props) {
      const file = resolve(ASSETS_DIR, prop.instances);
      expect(existsSync(file), prop.instances).toBe(true);
      expect(statSync(file).size).toBe(prop.count * 64);
    }
    // the map's own textures, each with the material slot it fills, and the files exist
    expect(baked.textures.map((t) => [t.id, t.role])).toEqual(
      expect.arrayContaining([
        ['basalt', 'stone'],
        ['columnar', 'cliff'],
        ['ash', 'moss'],
      ]),
    );
    for (const texture of baked.textures) expect(existsSync(resolve(ASSETS_DIR, texture.url)), texture.url).toBe(true);
  });

  it('passes the pipeline manifest check (tools/pipeline/manifest.mjs) and the map budget', async () => {
    // The root manifest is not this task's file, so the map is checked through a scratch root that
    // lists only it: a copy of the map folder, the three first-map GLBs it shares and its textures.
    // (Under node_modules/.cache, on the repo's own drive, rather than the system temp folder.)
    const cache = resolve(REPO, 'node_modules/.cache');
    mkdirSync(cache, { recursive: true });
    const scratch = mkdtempSync(join(cache, 'dragonfall-caldera-'));
    try {
      cpSync(resolve(ASSETS_DIR, 'maps/emberfall-caldera'), join(scratch, 'maps/emberfall-caldera'), { recursive: true });
      const shared = MAP.props.filter((prop) => prop.glb.startsWith('maps/shattered-spires/')).map((prop) => prop.glb);
      const baked = JSON.parse(readFileSync(resolve(ASSETS_DIR, 'maps/emberfall-caldera/manifest.json'), 'utf8')) as {
        textures: { url: string }[];
      };
      for (const file of [...shared, ...baked.textures.map((texture) => texture.url)]) {
        mkdirSync(dirname(join(scratch, file)), { recursive: true });
        cpSync(resolve(ASSETS_DIR, file), join(scratch, file));
      }
      writeFileSync(
        join(scratch, 'manifest.json'),
        JSON.stringify({ version: 1, dragons: {}, maps: { 'emberfall-caldera': 'maps/emberfall-caldera/manifest.json' } }),
      );
      const result = await checkManifest(scratch);
      expect(result.errors).toEqual([]);
      expect(result.maps).toEqual(['emberfall-caldera']);
      const totals = (result.mapTotals as Record<string, { files: number; bytes: number }>)['emberfall-caldera'];
      console.info(
        `emberfall caldera: manifest check OK, ${totals?.files} files, ${((totals?.bytes ?? 0) / 1048576).toFixed(2)} MB download ` +
          `(budget ${(ASSET_BUDGETS.mapMaxDownloadBytes / 1048576).toFixed(0)} MB), warnings: ${JSON.stringify(result.warnings)}`,
      );
      expect(totals?.bytes ?? Infinity).toBeLessThan(ASSET_BUDGETS.mapMaxDownloadBytes);
      // the same weight class as the first map's folder (5.27 MB)
      expect(totals?.bytes ?? Infinity).toBeLessThan(7 * 1048576);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});

// --- Flying it -------------------------------------------------------------------------------------

describe('emberfall caldera in the sim', () => {
  /** Thousands of sim ticks each: room for a busy machine (others build on this one too). */
  const SIM_TEST_MS = 60_000;

  it('launches every spawn slot of both gate sets with no input and no touch', () => {
    let hits = 0;
    const world = createMapCollisionWorld(MAP, {
      onTerrainHit() {
        hits++;
      },
    });
    for (const [gates, length] of [
      [MAP.spawnGates, CALDERA_GATE_CORRIDOR_LENGTH],
      [MAP.duelSpawnGates, CALDERA_DUEL_CORRIDOR_LENGTH],
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
  }, SIM_TEST_MS);

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
    let samples = 0;
    let overlaps = 0;
    let deepest = 0;
    for (const seed of [1, 2]) {
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
          if (dragon.phaseTicks !== 0) continue;
          if (terrain.solidDepth(p.x, p.y, p.z) > 0) {
            throw new Error(`seed ${seed}, tick ${tick}, dragon ${id}: centre inside the rock`);
          }
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
      `emberfall caldera fuzz: ${hits} terrain hits, ${overlaps} of ${samples} dragon-ticks with the sphere ` +
        `dipping into rock (deepest ${deepest.toFixed(2)} m)`,
    );
    expect(hits).toBeGreaterThan(60);
    expect(overlaps).toBeLessThan(samples * 0.002);
    expect(deepest).toBeLessThan(2.4);
  }, SIM_TEST_MS);

  it('never tunnels: boosting straight at a wall, the cone, an island, a gate, an arch and columns stops outside', () => {
    const terrain = terrainOf(WORLD);
    const targets: Vec3[] = [];
    for (const type of ['crater-wall', 'cone-wall', 'ash-island-large', 'caldera-gate', 'lava-arch', 'basalt-columns', 'vent-chimney']) {
      const placement = MAP.placements.find((p) => p.type === type && p.position.z < 0) ?? MAP.placements.find((p) => p.type === type);
      if (placement === undefined) throw new Error(`no ${type}`);
      const t = mapAssetType(type);
      targets.push(placementPoint(placement, (t.boundsMin.x + t.boundsMax.x) / 2, (t.boundsMin.y + t.boundsMax.y) / 2, (t.boundsMin.z + t.boundsMax.z) / 2));
    }
    let flights = 0;
    for (const target of targets) {
      for (const angle of [0.3, 1.9, 3.6, 5.2]) {
        const start = { x: target.x + Math.cos(angle) * 260, y: Math.max(target.y, 60), z: target.z + Math.sin(angle) * 260 };
        if (near(terrain.closestPoint(start.x, start.y, start.z, 30)) < 15 || Math.hypot(start.x, start.z) > 950) continue;
        if (terrain.solidDepth(start.x, start.y, start.z) > 0) continue;
        flights++;
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
    expect(flights).toBeGreaterThanOrEqual(12);
  }, SIM_TEST_MS);
});
