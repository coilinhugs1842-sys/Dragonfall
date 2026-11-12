/**
 * The host worker and the main thread each build their own copy of the map a match is flown on:
 * the worker through `createShatteredSpiresMatchWorldFactory` (src/game/worker/host.worker.ts),
 * the page through `createMatchAssetsCache` (prediction, camera, views). Nothing but the seed in
 * MATCH_START ties the two together, so they are compared here: a rider who predicts against
 * other rocks than the host simulates would rubber-band on every near miss.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST_SETTINGS, SHATTERED_SPIRES_DEFAULT_SEED } from '../../src/shared';
import type { HostSettings, SpawnGate } from '../../src/shared';
import { createMatchAssetsCache } from '../../src/game/match-assets';
import { createShatteredSpiresMatchWorldFactory } from '../../src/net/session';
import type { MatchWorld } from '../../src/net/session';
import { MapCollisionWorld } from '../../src/sim';

const MODES = ['skirmish', 'duel'] as const;
const SEEDS = [SHATTERED_SPIRES_DEFAULT_SEED, 1, 0xdeadbeef, -7];

function settingsFor(mode: HostSettings['mode']): HostSettings {
  return { ...DEFAULT_HOST_SETTINGS, mode };
}

interface Fingerprint {
  readonly triangles: number;
  /** Order-independent: the same set of triangles gives the same value in any tree order. */
  readonly checksum: string;
}

/** Count and checksum of the exact float bits of every collision triangle. */
function fingerprint(world: MatchWorld): Fingerprint {
  const collision = world.collisionWorld;
  if (!(collision instanceof MapCollisionWorld)) throw new Error('not a map collision world');
  const terrain = collision.terrain;
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

/** Distances of a fan of rays through the arena: what a dragon would actually run into. */
function probes(world: MatchWorld): number[] {
  const collision = world.collisionWorld as MapCollisionWorld;
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
  // One of each for the whole file, as in the game: both keep the latest seed.
  const worker = createShatteredSpiresMatchWorldFactory();
  const page = createMatchAssetsCache();

  for (const mode of MODES) {
    describe(mode, () => {
      it.each(SEEDS)('seed %i: same collision triangles and the same spawn gates', (seed) => {
        const settings = settingsFor(mode);
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

        // And they answer the same: every ray stops at the same distance, to the bit.
        const hostHits = probes(hostWorld);
        expect(probes(pageWorld)).toEqual(hostHits);
        expect(hostHits.some((distance) => distance >= 0)).toBe(true);
      });
    });
  }

  it('the two modes share the collision world and differ only in the gates', () => {
    const seed = SHATTERED_SPIRES_DEFAULT_SEED;
    for (const factory of [worker, page.factory]) {
      const skirmish = factory(settingsFor('skirmish'), seed);
      const duel = factory(settingsFor('duel'), seed);
      expect(duel.collisionWorld).toBe(skirmish.collisionWorld);
      // Duel launches from the closer perches: were the two sets equal, the per-mode
      // comparison above would prove nothing about the mode.
      expect(gatesOf(duel)).not.toEqual(gatesOf(skirmish));
    }
  });

  it('what the page hands its views is the Skirmish world of the same seed', () => {
    const seed = 1;
    const assets = page.get(seed);
    const hostWorld = worker(settingsFor('skirmish'), seed);
    expect(assets.seed).toBe(seed);
    expect(fingerprint(assets.world)).toEqual(fingerprint(hostWorld));
    expect(gatesOf(assets.world)).toEqual(gatesOf(hostWorld));
    expect(assets.world.collisionWorld).toBe(assets.collision);
    // The session's factory and `get` hand out the one BVH, not a copy each.
    expect(page.factory(settingsFor('duel'), seed).collisionWorld).toBe(assets.collision);
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
