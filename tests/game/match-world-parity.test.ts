/**
 * The host worker and the main thread each build their own copy of the map a match is flown on:
 * the worker through `createShatteredSpiresMatchWorldFactory` (src/game/worker/host.worker.ts;
 * the old name of `createMapMatchWorldFactory`), the page through `createMatchAssetsCache`
 * (prediction, camera, views). Nothing but the map id and the seed in MATCH_START ties the two
 * together, so they are compared here, for every map: a rider who predicts against other rocks
 * (or other heat vents) than the host simulates would rubber-band on every near miss.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  DEFAULT_MAP_ID,
  EMBERFALL_CALDERA_DEFAULT_SEED,
  SHATTERED_SPIRES_DEFAULT_SEED,
  createArenaMap,
  defaultSeedOfMap,
  matchSeedOfMap,
} from '../../src/shared';
import type { HostSettings, MapId, SpawnGate } from '../../src/shared';
import { createMatchAssetsCache } from '../../src/game/match-assets';
import {
  createMapMatchWorldFactory,
  createShatteredSpiresMatchWorldFactory,
} from '../../src/net/session';
import type { MatchWorld } from '../../src/net/session';
import { MAP_IDS } from '../../src/net/protocol';
import { MapCollisionWorld } from '../../src/sim';

const MODES = ['skirmish', 'duel'] as const;
/** Layout seeds per map: its default (what matches fly), and others the generator must also agree on. */
const SEEDS: Record<MapId, readonly number[]> = {
  'shattered-spires': [SHATTERED_SPIRES_DEFAULT_SEED, 1, 0xdeadbeef, -7],
  'emberfall-caldera': [EMBERFALL_CALDERA_DEFAULT_SEED, 1, -7],
};

function settingsFor(mode: HostSettings['mode'], map: MapId = DEFAULT_MAP_ID): HostSettings {
  return { ...DEFAULT_HOST_SETTINGS, mode, map };
}

interface Fingerprint {
  readonly triangles: number;
  /** Order-independent: the same set of triangles gives the same value in any tree order. */
  readonly checksum: string;
}

function collisionOf(world: MatchWorld): MapCollisionWorld {
  const collision = world.collisionWorld;
  if (!(collision instanceof MapCollisionWorld)) throw new Error('not a map collision world');
  return collision;
}

/** Count and checksum of the exact float bits of every collision triangle. */
function fingerprint(world: MatchWorld): Fingerprint {
  const terrain = collisionOf(world).terrain;
  const geometry = terrain?.bvh?.geometry;
  const index = geometry?.getIndex();
  if (terrain === null || geometry === undefined || index === null || index === undefined) {
    throw new Error('the map has no terrain');
  }
  const positions = geometry.getAttribute('position').array as Float32Array;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  let sum = 0;
  let mix = 0;
  for (let t = 0; t < terrain.triangleCount; t++) {
    // FNV-1a over the nine floats of the triangle, in its own vertex order.
    let hash = 0x811c9dc5;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = index.getX(t * 3 + corner) * 3;
      for (let k = 0; k < 3; k++) {
        hash = Math.imul(hash ^ (bits[vertex + k] as number), 16777619) >>> 0;
      }
    }
    sum = (sum + hash) >>> 0;
    mix = (mix ^ Math.imul(hash, 0x9e3779b1)) >>> 0;
  }
  return {
    triangles: terrain.triangleCount,
    checksum: `${sum.toString(16)}:${mix.toString(16)}`,
  };
}

/** Plain numbers of a gate set, so a difference prints as one. */
function gatesOf(world: MatchWorld): unknown {
  return world.spawnGates.map((gate: SpawnGate) => ({
    team: gate.team,
    position: [gate.position.x, gate.position.y, gate.position.z],
    orientation: [gate.orientation.x, gate.orientation.y, gate.orientation.z, gate.orientation.w],
    slots: gate.slots.map((slot) => [slot.x, slot.y, slot.z]),
  }));
}

function boundsOf(world: MatchWorld): number[] {
  return [world.centerX, world.centerZ, world.radius, world.floorY, world.ceilingY];
}

/** The heat vents a world pushes dragons with, as plain numbers (none on a map without them). */
function ventsOf(world: MatchWorld): unknown {
  return collisionOf(world).vents.map((vent) => [
    vent.id,
    vent.position.x,
    vent.position.y,
    vent.position.z,
    vent.radius,
    vent.height,
    vent.lift,
    vent.boost,
  ]);
}

/** Distances of a fan of rays through the arena: what a dragon would actually run into. */
function probes(world: MatchWorld): number[] {
  const collision = collisionOf(world);
  const hits: number[] = [];
  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    const height = 60 + (i % 8) * 70;
    hits.push(
      collision.raycast(
        Math.cos(angle) * 900,
        height,
        Math.sin(angle) * 900,
        -Math.cos(angle),
        0,
        -Math.sin(angle),
        1800,
      ),
    );
    hits.push(collision.raycast(Math.cos(angle) * 400, 690, Math.sin(angle) * 400, 0, -1, 0, 700));
  }
  return hits;
}

describe('the host worker and the main thread fly the same map', () => {
  // One of each for the whole file, as in the game: both keep the latest map and seed.
  const worker = createShatteredSpiresMatchWorldFactory();
  const page = createMatchAssetsCache();

  it('the name the worker entry still imports builds by map id', () => {
    expect(createShatteredSpiresMatchWorldFactory).toBe(createMapMatchWorldFactory);
  });

  for (const map of MAP_IDS) {
    for (const mode of MODES) {
      describe(`${map}, ${mode}`, () => {
        it.each(SEEDS[map])('seed %i: same collision triangles, spawn gates and vents', (seed) => {
          const settings = settingsFor(mode, map);
          const hostWorld = worker(settings, seed);
          const pageWorld = page.factory(settings, seed);

          const host = fingerprint(hostWorld);
          const main = fingerprint(pageWorld);
          expect(host.triangles).toBeGreaterThan(1000);
          expect(main.triangles).toBe(host.triangles);
          expect(main.checksum).toBe(host.checksum);

          expect(gatesOf(pageWorld)).toEqual(gatesOf(hostWorld));
          expect(hostWorld.spawnGates).toHaveLength(2);
          for (const gate of hostWorld.spawnGates) expect(gate.slots.length).toBeGreaterThanOrEqual(5);
          expect(boundsOf(pageWorld)).toEqual(boundsOf(hostWorld));
          expect(ventsOf(pageWorld)).toEqual(ventsOf(hostWorld));

          // And they answer the same: every ray stops at the same distance, to the bit.
          const hostHits = probes(hostWorld);
          expect(probes(pageWorld)).toEqual(hostHits);
          expect(hostHits.some((distance) => distance >= 0)).toBe(true);
        });
      });
    }

    it(`${map}: the two modes share the collision world and differ only in the gates`, () => {
      const seed = defaultSeedOfMap(map);
      for (const factory of [worker, page.factory]) {
        const skirmish = factory(settingsFor('skirmish', map), seed);
        const duel = factory(settingsFor('duel', map), seed);
        expect(duel.collisionWorld).toBe(skirmish.collisionWorld);
        // Duel launches from the closer perches: were the two sets equal, the per-mode
        // comparison above would prove nothing about the mode.
        expect(gatesOf(duel)).not.toEqual(gatesOf(skirmish));
      }
    });

    it(`${map}: what the page hands its views is the Skirmish world of the same map and seed`, () => {
      const seed = 1;
      const assets = page.get(seed, map);
      const hostWorld = worker(settingsFor('skirmish', map), seed);
      expect(assets.seed).toBe(seed);
      expect(assets.mapId).toBe(map);
      expect(assets.map.id).toBe(map);
      expect(fingerprint(assets.world)).toEqual(fingerprint(hostWorld));
      expect(gatesOf(assets.world)).toEqual(gatesOf(hostWorld));
      expect(assets.world.collisionWorld).toBe(assets.collision);
      // The session's factory and `get` hand out the one BVH, not a copy each.
      expect(page.factory(settingsFor('duel', map), seed).collisionWorld).toBe(assets.collision);
    });
  }

  it('the map id picks the world: the same seed on the two maps is two different arenas', () => {
    const seed = 1;
    const spires = worker(settingsFor('skirmish', 'shattered-spires'), seed);
    const spiresPrint = fingerprint(spires);
    const spiresVents = ventsOf(spires);
    const caldera = worker(settingsFor('skirmish', 'emberfall-caldera'), seed);
    expect(fingerprint(caldera).checksum).not.toBe(spiresPrint.checksum);
    expect(spiresVents).toEqual([]);
    expect(ventsOf(caldera)).toHaveLength(9);
    // The page's cache switches map with the settings too, and back.
    expect(fingerprint(page.factory(settingsFor('skirmish', 'emberfall-caldera'), seed))).toEqual(fingerprint(caldera));
    expect(fingerprint(page.factory(settingsFor('skirmish', 'shattered-spires'), seed))).toEqual(spiresPrint);
    // Left out, the map is the default one (the cine viewer and older callers).
    expect(page.get(seed).mapId).toBe(DEFAULT_MAP_ID);
    expect(fingerprint(page.get(seed).world)).toEqual(spiresPrint);
  });

  it('the checksum tells two layouts apart (it is not blind)', () => {
    const settings = settingsFor('skirmish');
    const a = fingerprint(worker(settings, 1));
    const b = fingerprint(worker(settings, 2));
    expect(a.checksum).not.toBe(b.checksum);
    // Rebuilding the same seed after another one gives the same world again.
    expect(fingerprint(worker(settings, 1))).toEqual(a);
  });

  it('both treat the seed as an unsigned 32-bit number', () => {
    const settings = settingsFor('skirmish');
    const wrapped = fingerprint(worker(settings, -7));
    expect(fingerprint(worker(settings, 0xfffffff9))).toEqual(wrapped);
    expect(fingerprint(page.factory(settings, 0xfffffff9))).toEqual(wrapped);
    expect(page.get(-7).seed).toBe(0xfffffff9);
  });
});

describe('the map registry', () => {
  it('builds the map the id names, the same from the same two values', () => {
    for (const map of MAP_IDS) {
      const seed = defaultSeedOfMap(map);
      const a = createArenaMap(map, seed);
      const b = createArenaMap(map, seed);
      expect(a.id).toBe(map);
      expect(a.seed).toBe(seed);
      expect(b.placements).toEqual(a.placements);
      expect(b.spawnGates).toEqual(a.spawnGates);
      expect(b.vents).toEqual(a.vents);
    }
    expect(defaultSeedOfMap('shattered-spires')).toBe(SHATTERED_SPIRES_DEFAULT_SEED >>> 0);
    expect(defaultSeedOfMap('emberfall-caldera')).toBe(EMBERFALL_CALDERA_DEFAULT_SEED >>> 0);
  });

  it('the host flies Spires with its own seed and the Caldera with the Caldera layout', () => {
    expect(matchSeedOfMap('shattered-spires', 1234)).toBe(1234);
    expect(matchSeedOfMap('shattered-spires', -7)).toBe(0xfffffff9);
    for (const hostSeed of [1234, -7, SHATTERED_SPIRES_DEFAULT_SEED]) {
      expect(matchSeedOfMap('emberfall-caldera', hostSeed)).toBe(EMBERFALL_CALDERA_DEFAULT_SEED >>> 0);
    }
  });
});
