/**
 * The island under the results podium, per map: each map names (or defaults to) one of its own
 * shipped rocks, big enough for the steps, and the show has free air over that map's rock.
 */
import { describe, expect, it } from 'vitest';
import { SEAT_X, choosePodiumSite, createPodiumSite } from '../../src/cinematics/podium';
import { podiumIslandOf } from '../../src/cinematics/podium/podium-rock';
import { CALDERA_PODIUM, createArenaMap, defaultSeedOfMap, mapAssetType } from '../../src/shared';
import type { MapId } from '../../src/shared';
import { createMapCollisionWorld } from '../../src/sim';

const MAPS_WITH_A_PODIUM: readonly MapId[] = ['shattered-spires', 'emberfall-caldera'];

describe('podium: the island of each map', () => {
  it('is the first map\'s island-small where a map names none', () => {
    const spires = createArenaMap('shattered-spires', defaultSeedOfMap('shattered-spires'));
    expect(spires.podium).toBeUndefined();
    expect(podiumIslandOf(spires)).toEqual({
      island: 'island-small',
      scale: 0.82,
      y: -0.2,
      yaw: -0.82,
      yawMirrored: -1.41,
    });
  });

  it('is one of the caldera\'s own ash islands on Emberfall Caldera', () => {
    const caldera = createArenaMap('emberfall-caldera', defaultSeedOfMap('emberfall-caldera'));
    expect(caldera.podium).toBe(CALDERA_PODIUM);
    expect(podiumIslandOf(caldera).island).toBe('ash-island-small');
  });

  for (const id of MAPS_WITH_A_PODIUM) {
    it(`${id}: the island ships with the map and carries the steps`, () => {
      const map = createArenaMap(id, defaultSeedOfMap(id));
      const island = podiumIslandOf(map);
      // The podium draws it from the map's own bundle: it has to be one of the map's props.
      expect(map.props.some((set) => set.id === island.island)).toBe(true);
      const type = mapAssetType(island.island);
      // A flat top with its origin on it, wide enough for the three steps and the banners.
      expect(type.top).not.toBeNull();
      expect(type.top?.y).toBe(0);
      const outerSeat = Math.max(...SEAT_X.map(Math.abs));
      expect((type.top?.radius ?? 0) * island.scale).toBeGreaterThan(outerSeat + 10);
      // Never above the floor of the steps (they would hang in the air at its rim).
      expect(island.y).toBeLessThanOrEqual(0);
      expect(island.y).toBeGreaterThan(-3);
    });

    it(`${id}: the show stands in free air over the map's rock`, () => {
      const map = createArenaMap(id, defaultSeedOfMap(id));
      const terrain = createMapCollisionWorld(map);
      const site = choosePodiumSite(createPodiumSite(), map, terrain);
      // Above the steps (the dragons land here) and where the three-quarter camera stands.
      expect(terrain.clearance(site.x, site.y + 12, site.z, 12)).toBe(-1);
      expect(site.y).toBeGreaterThan((map.colliders.cloudSeaY ?? map.colliders.floorY) + 100);
      expect(site.y).toBeLessThan(map.colliders.ceilingY - 60);
    });
  }
});
