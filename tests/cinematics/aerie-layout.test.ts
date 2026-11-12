/**
 * The aerie's perches and its set list: ten distinct seats, mirrored between the teams, far
 * enough apart for ten dragons, and a set that gets cheaper on lower presets.
 */
import { describe, expect, it } from 'vitest';
import {
  AERIE_PERCHES_PER_SIDE,
  AERIE_PERCH_COUNT,
  aerieBraziers,
  aeriePlacements,
  aerieToWorld,
  createAerieLayout,
  perchSlot,
} from '../../src/cinematics/aerie';
import {
  MAX_TEAM_SIZE,
  TEAM_EMBER,
  TEAM_FROST,
  createShatteredSpires,
  createVec3,
} from '../../src/shared';

const map = createShatteredSpires();
const layout = createAerieLayout(map);

describe('aerie layout', () => {
  it('has five perches per team, each in its own slot', () => {
    expect(AERIE_PERCHES_PER_SIDE).toBe(MAX_TEAM_SIZE);
    expect(layout.perches).toHaveLength(AERIE_PERCH_COUNT);
    for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
      for (let index = 0; index < AERIE_PERCHES_PER_SIDE; index++) {
        const perch = layout.perches[perchSlot(team, index)];
        expect(perch?.side).toBe(team);
        expect(perch?.index).toBe(index);
        expect(perch?.slot).toBe(perchSlot(team, index));
      }
    }
  });

  it('puts Ember on the left and Frost on the right, as mirror images', () => {
    for (let index = 0; index < AERIE_PERCHES_PER_SIDE; index++) {
      const ember = layout.perches[perchSlot(TEAM_EMBER, index)];
      const frost = layout.perches[perchSlot(TEAM_FROST, index)];
      if (ember === undefined || frost === undefined) throw new Error('missing perch');
      expect(ember.local.x).toBeLessThan(0);
      expect(frost.local.x).toBeGreaterThan(0);
      expect(ember.local.x).toBeCloseTo(-frost.local.x, 9);
      expect(ember.local.y).toBeCloseTo(frost.local.y, 9);
      expect(ember.local.z).toBeCloseTo(frost.local.z, 9);
      expect(ember.localYaw).toBeCloseTo(-frost.localYaw, 9);
    }
  });

  it('keeps every pair of perches far enough apart for two perched dragons', () => {
    let nearest = Infinity;
    for (let a = 0; a < layout.perches.length; a++) {
      for (let b = a + 1; b < layout.perches.length; b++) {
        const pa = layout.perches[a]?.position;
        const pb = layout.perches[b]?.position;
        if (pa === undefined || pb === undefined) continue;
        nearest = Math.min(nearest, Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z));
      }
    }
    // A perched dragon with folded wings is 4 to 5 m wide; the roar opens them over the gap.
    expect(nearest).toBeGreaterThan(8);
  });

  it('staggers the two rows in height and depth', () => {
    const front = layout.perches[perchSlot(TEAM_FROST, 1)];
    const back = layout.perches[perchSlot(TEAM_FROST, 3)];
    if (front === undefined || back === undefined) throw new Error('missing perch');
    expect(back.local.y - front.local.y).toBeGreaterThan(4);
    expect(front.local.z - back.local.z).toBeGreaterThan(8);
  });

  it('seats perch 0 nearest the middle and every dragon turned toward it', () => {
    for (const perch of layout.perches) {
      const first = layout.perches[perchSlot(perch.side, 0)];
      expect(Math.abs(first?.local.x ?? 0)).toBeLessThanOrEqual(Math.abs(perch.local.x));
      // Facing the camera (+Z local), toed in toward the gap.
      expect(Math.abs(perch.localYaw)).toBeLessThan(0.6);
      expect(Math.sign(perch.localYaw)).toBe(-Math.sign(perch.local.x));
    }
  });

  it('stands above the cloud sea with the sun off to the right of the view', () => {
    expect(layout.origin.y).toBeGreaterThan(layout.cloudSeaY + 40);
    const sun = map.sky.sunDirection;
    // The local +X axis (screen right) and -Z axis (into the picture) in world space.
    const right = aerieToWorld(layout, 1, 0, 0, createVec3());
    const into = aerieToWorld(layout, 0, 0, -1, createVec3());
    const sunRight = (right.x - layout.origin.x) * sun.x + (right.z - layout.origin.z) * sun.z;
    const sunInto = (into.x - layout.origin.x) * sun.x + (into.z - layout.origin.z) * sun.z;
    expect(sunRight).toBeGreaterThan(0.3);
    expect(sunInto).toBeGreaterThan(0.3);
  });

  it('maps local points to the world and back by a pure turn about the origin', () => {
    const p = aerieToWorld(layout, 3, 4, 5, createVec3());
    expect(Math.hypot(p.x - layout.origin.x, p.z - layout.origin.z)).toBeCloseTo(Math.hypot(3, 5), 9);
    expect(p.y - layout.origin.y).toBeCloseTo(4, 9);
  });
});

describe('aerie set', () => {
  it('only places assets the map ships', () => {
    const known = new Set(map.props.map((asset) => asset.id));
    expect(known.size).toBeGreaterThan(0);
    for (const placement of aeriePlacements(layout, 'high')) {
      expect(known.has(placement.type), placement.type).toBe(true);
    }
  });

  it('puts a stone under every perch on every preset', () => {
    for (const preset of ['low', 'medium', 'high'] as const) {
      const stones = aeriePlacements(layout, preset).filter((p) => p.type === 'standing-stone');
      expect(stones).toHaveLength(AERIE_PERCH_COUNT);
      for (const perch of layout.perches) {
        expect(
          stones.some(
            (stone) =>
              Math.hypot(stone.position.x - perch.position.x, stone.position.z - perch.position.z) < 1e-6 &&
              stone.position.y < perch.position.y,
          ),
        ).toBe(true);
      }
    }
  });

  it('gets cheaper on lower presets', () => {
    const low = aeriePlacements(layout, 'low').length;
    const medium = aeriePlacements(layout, 'medium').length;
    const high = aeriePlacements(layout, 'high').length;
    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThanOrEqual(high);
  });

  it('gives each team its own banners and fire, the same number on both sides', () => {
    for (const preset of ['low', 'medium', 'high'] as const) {
      const banners = aeriePlacements(layout, preset).filter((p) => p.type.startsWith('banner'));
      const ember = banners.filter((p) => p.team === TEAM_EMBER).length;
      const frost = banners.filter((p) => p.team === TEAM_FROST).length;
      expect(ember).toBeGreaterThan(0);
      expect(ember).toBe(frost);
      expect(ember + frost).toBe(banners.length);
    }
    const braziers = aerieBraziers(layout);
    expect(braziers.filter((b) => b.team === TEAM_EMBER)).toHaveLength(
      braziers.filter((b) => b.team === TEAM_FROST).length,
    );
    // Every brazier of the High set has its fire.
    expect(braziers).toHaveLength(aeriePlacements(layout, 'high').filter((p) => p.type === 'brazier').length);
  });
});
