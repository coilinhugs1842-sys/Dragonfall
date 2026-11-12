import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../src/shared';
import {
  bandPosition,
  encodeFarFade,
  farClusterKey,
  pickTiers,
  propLodSettings,
  sphereOutsidePlanes,
} from '../../src/world/props/prop-lod';
import type { PropLodSettings, TierFades } from '../../src/world/props/prop-lod';

const SNAP: PropLodSettings = {
  rockLod0: 0.5,
  rockLod1: 0.2,
  propLod0: 0.1,
  fadeBand: 0,
  propDrawDistance: 400,
  cullFade: 0,
  keepDistance: 0,
};
const FADE: PropLodSettings = { ...SNAP, fadeBand: 0.1, cullFade: 60 };

function tiers(
  distance: number,
  radius: number,
  instancedLods: number,
  isRock: boolean,
  cullable: boolean,
  settings: PropLodSettings,
): TierFades {
  return pickTiers({ near: 9, mid: 9, far: 9 }, distance, radius, instancedLods, isRock, cullable, settings);
}

/**
 * Share of the screen-door pattern a signed fade keeps (see the file comment of prop-lod.ts):
 * v > 0 keeps dither < v, v < 0 keeps dither >= 1 + v.
 */
function coverage(fade: number): number {
  return Math.abs(fade);
}

describe('bandPosition', () => {
  it.each([
    // s, threshold, band, expected
    [0.49, 0.5, 0, 0],
    [0.5, 0.5, 0, 1],
    [0.51, 0.5, 0, 1],
    [0.4, 0.5, 0.1, 0],
    [0.45, 0.5, 0.1, 0],
    [0.5, 0.5, 0.1, 0.5],
    [0.55, 0.5, 0.1, 1],
    [0.9, 0.5, 0.1, 1],
    [0.475, 0.5, 0.1, 0.25],
  ])('s = %f around %f (band %f) -> %f', (s, threshold, band, expected) => {
    expect(bandPosition(s, threshold, band)).toBeCloseTo(expected, 6);
  });

  it('treats a negative or NaN band as a snap', () => {
    expect(bandPosition(0.6, 0.5, -1)).toBe(1);
    expect(bandPosition(0.4, 0.5, Number.NaN)).toBe(0);
  });

  it('rises monotonically across the band and stays inside 0..1', () => {
    let last = 0;
    for (let s = 0.3; s <= 0.7; s += 0.005) {
      const a = bandPosition(s, 0.5, 0.1);
      expect(a).toBeGreaterThanOrEqual(last);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      last = a;
    }
    expect(last).toBe(1);
  });
});

describe('pickTiers', () => {
  it.each([
    // distance, radius, instancedLods, isRock, cullable -> near, mid, far
    // A rock with two instanced LODs (radius 100: s = 100 / distance).
    [100, 100, 2, true, false, 1, 0, 0],
    [199, 100, 2, true, false, 1, 0, 0],
    [201, 100, 2, true, false, 0, 1, -0],
    [499, 100, 2, true, false, 0, 1, -0],
    [501, 100, 2, true, false, 0, 0, -1],
    [5000, 100, 2, true, false, 0, 0, -1],
    // A prop with one instanced LOD (radius 10: threshold at 100 m).
    [99, 10, 1, false, false, 1, 0, 0],
    [101, 10, 1, false, false, 0, 0, -1],
    // A rock type that ships one instanced LOD uses the rock threshold.
    [19, 10, 1, true, false, 1, 0, 0],
    [21, 10, 1, true, false, 0, 0, -1],
    // A backdrop is only ever in the far mesh.
    [10, 500, 0, false, false, 0, 0, 1],
    [9000, 500, 0, false, false, 0, 0, 1],
  ])(
    'snap: %f m, radius %f, %i instanced LODs, rock %s, cullable %s',
    (distance, radius, lods, isRock, cullable, near, mid, far) => {
      const out = tiers(distance, radius, lods, isRock, cullable, SNAP);
      expect(out.near).toBeCloseTo(near, 6);
      expect(out.mid).toBeCloseTo(mid, 6);
      expect(out.far).toBeCloseTo(far, 6);
    },
  );

  it('overwrites whatever was in the reused output', () => {
    const out: TierFades = { near: 7, mid: 7, far: 7 };
    expect(pickTiers(out, 100, 100, 2, true, false, SNAP)).toBe(out);
    expect(out).toEqual({ near: 1, mid: 0, far: 0 });
  });

  it('clamps a distance inside one metre instead of dividing by it', () => {
    for (const distance of [0, 1e-9, -5]) {
      const out = tiers(distance, 5, 2, true, false, FADE);
      expect(Number.isFinite(out.near + out.mid + out.far)).toBe(true);
      expect(out.near).toBe(1);
    }
  });

  it('covers every pixel exactly once across both cross-fade bands', () => {
    for (let distance = 50; distance <= 1200; distance += 3.7) {
      for (const lods of [1, 2]) {
        const out = tiers(distance, 100, lods, true, false, FADE);
        const total = coverage(out.near) + coverage(out.mid) + coverage(out.far);
        expect(total).toBeCloseTo(1, 6);
        // Complementary halves of the dither: one tier positive, its partner negative.
        const drawn = [out.near, out.mid, out.far].filter((fade) => fade !== 0);
        expect(drawn.length).toBeGreaterThanOrEqual(1);
        expect(drawn.length).toBeLessThanOrEqual(2);
        if (drawn.length === 2) expect((drawn[0] as number) * (drawn[1] as number)).toBeLessThan(0);
      }
    }
  });

  it('changes tier without a jump in coverage (a blend, not a pop) when there is a band', () => {
    let last = tiers(50, 100, 2, true, false, FADE);
    for (let distance = 50.5; distance <= 1200; distance += 0.5) {
      const out = tiers(distance, 100, 2, true, false, FADE);
      expect(Math.abs(coverage(out.near) - coverage(last.near))).toBeLessThan(0.08);
      expect(Math.abs(coverage(out.far) - coverage(last.far))).toBeLessThan(0.08);
      last = { ...out };
    }
  });

  it('stops drawing a cullable prop past the prop draw distance', () => {
    // radius 5, draw distance 400: gone once distance - radius >= 400.
    expect(tiers(404, 5, 1, false, true, SNAP).far).toBe(-1);
    expect(tiers(405, 5, 1, false, true, SNAP)).toEqual({ near: 0, mid: 0, far: 0 });
    expect(tiers(2000, 5, 1, false, true, SNAP)).toEqual({ near: 0, mid: 0, far: 0 });
    // The same prop when it is not cullable (a gate) stays.
    expect(tiers(2000, 5, 1, false, false, SNAP).far).toBe(-1);
  });

  it('dithers a cullable prop out over the cull fade instead of snapping', () => {
    // FADE: cullFade 60 -> the fade runs from 345 m to 405 m for radius 5.
    expect(tiers(340, 5, 1, false, true, FADE).far).toBe(-1);
    const half = tiers(375, 5, 1, false, true, FADE).far;
    expect(half).toBeCloseTo(0.5, 6);
    let last = 1;
    for (let distance = 346; distance < 405; distance += 1) {
      const fade = tiers(distance, 5, 1, false, true, FADE).far;
      expect(fade).toBeGreaterThan(0);
      expect(fade).toBeLessThanOrEqual(last);
      last = fade;
    }
    expect(tiers(405, 5, 1, false, true, FADE).far).toBe(0);
  });
});

describe('propLodSettings', () => {
  it.each(['low', 'medium', 'high'] as const)('%s: thresholds are ordered and finite', (id) => {
    const preset = QUALITY_PRESETS[id];
    const settings = propLodSettings(preset);
    expect(settings.rockLod0).toBeGreaterThan(settings.rockLod1);
    expect(settings.rockLod1).toBeGreaterThan(0);
    expect(settings.propLod0).toBeGreaterThan(0);
    expect(settings.propDrawDistance).toBe(preset.propDrawDistance);
    // Bands of neighbouring thresholds must not overlap, or a rock could be in three tiers.
    expect(settings.rockLod1 * (1 + settings.fadeBand)).toBeLessThan(
      settings.rockLod0 * (1 - settings.fadeBand),
    );
  });

  it('snaps on Low (no dithered overdraw) and fades elsewhere', () => {
    expect(propLodSettings(QUALITY_PRESETS.low).fadeBand).toBe(0);
    expect(propLodSettings(QUALITY_PRESETS.low).cullFade).toBe(0);
    expect(propLodSettings(QUALITY_PRESETS.medium).fadeBand).toBeGreaterThan(0);
    expect(propLodSettings(QUALITY_PRESETS.high).cullFade).toBeGreaterThan(0);
  });

  it('gets coarser, never finer, from High to Low', () => {
    const low = propLodSettings(QUALITY_PRESETS.low);
    const medium = propLodSettings(QUALITY_PRESETS.medium);
    const high = propLodSettings(QUALITY_PRESETS.high);
    expect(low.rockLod0).toBeGreaterThanOrEqual(medium.rockLod0);
    expect(medium.rockLod0).toBeGreaterThanOrEqual(high.rockLod0);
    expect(low.propLod0).toBeGreaterThanOrEqual(medium.propLod0);
    expect(medium.propLod0).toBeGreaterThanOrEqual(high.propLod0);
  });
});

describe('encodeFarFade', () => {
  it.each([
    // fade -> R (magnitude), G (255 when negative)
    [0, 0, 0],
    [1, 255, 0],
    [-1, 255, 255],
    [0.5, 128, 0],
    [-0.5, 128, 255],
    [0.001, 0, 0],
    [2, 255, 0],
    [-7, 255, 255],
  ])('fade %f -> bytes %i, %i', (fade, r, g) => {
    const out = new Uint8Array([9, 9, 9, 9, 9, 9]);
    encodeFarFade(fade, out, 2);
    expect(Array.from(out)).toEqual([9, 9, r, g, 9, 9]);
  });

  it('keeps a fully drawn instance fully drawn in either sign', () => {
    const out = new Uint8Array(4);
    encodeFarFade(1, out, 0);
    encodeFarFade(-1, out, 2);
    expect(out[0]).toBe(255);
    expect(out[2]).toBe(255);
  });
});

describe('sphereOutsidePlanes', () => {
  /** An axis-aligned box of half-size 10 around the origin, as six inward-facing planes. */
  const box = new Float32Array([
    1, 0, 0, 10, -1, 0, 0, 10, 0, 1, 0, 10, 0, -1, 0, 10, 0, 0, 1, 10, 0, 0, -1, 10,
  ]);

  it.each([
    // x, y, z, radius, outside
    [0, 0, 0, 1, false],
    [9, 9, 9, 0.5, false],
    [12, 0, 0, 1, true],
    [12, 0, 0, 2, false], // touches the plane: not entirely outside
    [12, 0, 0, 2.5, false],
    [-12, 0, 0, 1, true],
    [0, 14, 0, 3, true],
    [0, -14, 0, 3, true],
    [0, 0, 20, 9, true],
    [0, 0, -20, 11, false],
    [100, 100, 100, 50, true],
    [100, 100, 100, 95, false],
  ])('sphere at (%f, %f, %f) radius %f -> outside %s', (x, y, z, radius, outside) => {
    expect(sphereOutsidePlanes(box, x, y, z, radius)).toBe(outside);
  });

  it('never culls a sphere whose centre is inside', () => {
    for (let i = 0; i < 200; i++) {
      const x = Math.sin(i * 1.3) * 9.9;
      const y = Math.sin(i * 2.1) * 9.9;
      const z = Math.sin(i * 0.7) * 9.9;
      expect(sphereOutsidePlanes(box, x, y, z, 0)).toBe(false);
    }
  });
});

describe('farClusterKey', () => {
  it('gives one key per cell of the grid', () => {
    expect(farClusterKey(0, 0, 500)).toBe(farClusterKey(499.9, 499.9, 500));
    expect(farClusterKey(0, 0, 500)).not.toBe(farClusterKey(500, 0, 500));
    expect(farClusterKey(0, 0, 500)).not.toBe(farClusterKey(0, 500, 500));
    expect(farClusterKey(0, 0, 500)).not.toBe(farClusterKey(-0.1, 0, 500));
  });

  it('is unique, positive and integral over a map-sized area', () => {
    const seen = new Map<number, string>();
    for (let cx = -12; cx <= 12; cx++) {
      for (let cz = -12; cz <= 12; cz++) {
        const key = farClusterKey(cx * 500 + 250, cz * 500 + 250, 500);
        expect(Number.isInteger(key)).toBe(true);
        expect(key).toBeGreaterThanOrEqual(0);
        expect(seen.has(key)).toBe(false);
        seen.set(key, `${cx},${cz}`);
      }
    }
    expect(seen.size).toBe(625);
  });

  it('does not confuse x and z', () => {
    expect(farClusterKey(1500, -500, 500)).not.toBe(farClusterKey(-500, 1500, 500));
  });
});
