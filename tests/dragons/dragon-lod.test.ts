import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../src/shared';
import {
  DRAGON_LOD_FAR,
  LOD_CAP_HYSTERESIS,
  LOD_HYSTERESIS,
  dragonLodPolicy,
  lodForDistance,
  lodFovScale,
  selectDragonLods,
} from '../../src/dragons';
import type { DragonLodPolicy } from '../../src/dragons';

const DISTANCES: readonly [number, number, number] = [25, 70, 200];

function policyOf(overrides: Partial<DragonLodPolicy> = {}): DragonLodPolicy {
  return {
    distances: DISTANCES,
    maxLod0: 10,
    maxSkinned: 10,
    lod1PoseHz: 0,
    lod2PoseHz: 0,
    lod2Procedural: true,
    ...overrides,
  };
}

/** Runs one selection; `previous` is last frame's level per dragon (-1 = not drawn). */
function select(
  distances: readonly number[],
  previous: readonly number[],
  local: number,
  policy: DragonLodPolicy,
): number[] {
  const levels = Int8Array.from(previous);
  selectDragonLods(Float32Array.from(distances), levels, distances.length, local, policy);
  return Array.from(levels);
}

function count(levels: readonly number[], test: (level: number) => boolean): number {
  return levels.filter(test).length;
}

describe('lodForDistance', () => {
  it.each([
    // distance, previous, expected
    [0, -1, 0],
    [25, -1, 0],
    [25.01, -1, 1],
    [70, -1, 1],
    [70.01, -1, 2],
    [200, -1, 2],
    [200.01, -1, DRAGON_LOD_FAR],
    [1e6, -1, DRAGON_LOD_FAR],
  ])('a dragon new to the view at %f m is level %i -> %i', (distance, previous, expected) => {
    expect(lodForDistance(distance, previous, DISTANCES)).toBe(expected);
  });

  it.each([
    // A dragon keeps its level a little past the boundary, in both directions.
    [25 * (1 + LOD_HYSTERESIS) - 0.01, 0, 0],
    [25 * (1 + LOD_HYSTERESIS) + 0.01, 0, 1],
    [25 * (1 - LOD_HYSTERESIS) + 0.01, 1, 1],
    [25 * (1 - LOD_HYSTERESIS) - 0.01, 1, 0],
    [70 * (1 + LOD_HYSTERESIS) - 0.01, 1, 1],
    [70 * (1 - LOD_HYSTERESIS) + 0.01, 2, 2],
    [200 * (1 + LOD_HYSTERESIS) - 0.01, 2, 2],
    [200 * (1 + LOD_HYSTERESIS) + 0.01, 2, DRAGON_LOD_FAR],
    [200 * (1 - LOD_HYSTERESIS) + 0.01, DRAGON_LOD_FAR, DRAGON_LOD_FAR],
    [200 * (1 - LOD_HYSTERESIS) - 0.01, DRAGON_LOD_FAR, 2],
  ])('at %f m a dragon that was level %i becomes %i', (distance, previous, expected) => {
    expect(lodForDistance(distance, previous, DISTANCES)).toBe(expected);
  });

  it('never flickers for a distance that wobbles around a boundary', () => {
    for (const boundary of DISTANCES) {
      let level: number = lodForDistance(boundary * 0.99, -1, DISTANCES);
      let changes = 0;
      for (let frame = 0; frame < 200; frame++) {
        const wobble = 1 + 0.03 * Math.sin(frame * 1.7);
        const next = lodForDistance(boundary * wobble, level, DISTANCES);
        if (next !== level) changes++;
        level = next;
      }
      expect(changes).toBe(0);
    }
  });
});

describe('lodFovScale', () => {
  it('is 1 at the reference FOV, larger for a wider one, and always finite', () => {
    expect(lodFovScale(60)).toBeCloseTo(1, 6);
    expect(lodFovScale(90)).toBeGreaterThan(1);
    expect(lodFovScale(40)).toBeLessThan(1);
    for (const fov of [-10, 0, 179.9, 500, Number.POSITIVE_INFINITY]) {
      const scale = lodFovScale(fov);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });
});

describe('dragonLodPolicy', () => {
  it.each(['low', 'medium', 'high'] as const)('%s takes its distances from the preset', (id) => {
    const preset = QUALITY_PRESETS[id];
    const policy = dragonLodPolicy(preset);
    expect(policy.distances).toEqual(preset.dragonLodDistances);
    expect(policy.maxLod0).toBeGreaterThanOrEqual(1);
    expect(policy.maxSkinned).toBeGreaterThanOrEqual(policy.maxLod0);
  });

  it('caps Low at six skinned dragons and one at LOD0', () => {
    const policy = dragonLodPolicy(QUALITY_PRESETS.low);
    expect(policy.maxSkinned).toBe(6);
    expect(policy.maxLod0).toBe(1);
  });
});

describe('selectDragonLods', () => {
  it('uses plain distance when no cap is hit', () => {
    expect(select([10, 50, 150, 300], [-1, -1, -1, -1], -1, policyOf())).toEqual([0, 1, 2, 3]);
  });

  it('handles an empty view', () => {
    expect(select([], [], -1, policyOf())).toEqual([]);
  });

  it('keeps the local dragon at LOD0 whatever its distance and the caps', () => {
    const levels = select(
      [500, 5, 6, 7],
      [-1, -1, -1, -1],
      0,
      policyOf({ maxLod0: 1, maxSkinned: 2 }),
    );
    expect(levels[0]).toBe(0);
    // The local dragon uses the only LOD0 place; the other three step down.
    expect(count(levels, (level) => level === 0)).toBe(1);
    // Two skinned places: the local one and the nearest other.
    expect(levels).toEqual([0, 1, DRAGON_LOD_FAR, DRAGON_LOD_FAR]);
  });

  it.each([
    // maxLod0, maxSkinned
    [1, 6],
    [2, 10],
    [4, 10],
    [1, 1],
    [3, 3],
  ])('respects maxLod0 = %i and maxSkinned = %i for ten near dragons', (maxLod0, maxSkinned) => {
    const distances = [12, 3, 20, 8, 15, 5, 18, 10, 22, 7];
    const levels = select(
      distances,
      distances.map(() => -1),
      -1,
      policyOf({ maxLod0, maxSkinned }),
    );
    expect(count(levels, (level) => level === 0)).toBe(Math.min(maxLod0, maxSkinned));
    expect(count(levels, (level) => level !== DRAGON_LOD_FAR)).toBe(maxSkinned);
    // The places go to the nearest.
    const order = distances.map((d, i) => [d, i] as const).sort((a, b) => a[0] - b[0]);
    for (let rank = 0; rank < order.length; rank++) {
      const index = (order[rank] as readonly [number, number])[1];
      expect(levels[index] !== DRAGON_LOD_FAR).toBe(rank < maxSkinned);
    }
  });

  it('is not fooled by levels left over from an earlier, larger call', () => {
    const policy = policyOf({ maxSkinned: 1 });
    select(new Array<number>(300).fill(10), new Array<number>(300).fill(1), -1, policy);
    // Nobody held a place last frame here: the nearer one wins outright.
    expect(select([10, 9.5], [-1, -1], -1, policy)).toEqual([DRAGON_LOD_FAR, 0]);
  });
});

describe('the skinned cap has hysteresis', () => {
  const low = dragonLodPolicy(QUALITY_PRESETS.low);

  /**
   * Low in a 5v5: the local dragon, four that are always near, and two (A = index 5,
   * B = index 6) that fight over the sixth skinned place. Returns how often each of the two
   * changed between skinned and far over `frames` frames.
   */
  function flips(
    frames: number,
    distanceA: (frame: number) => number,
    distanceB: (frame: number) => number,
  ): { a: number; b: number; last: number[] } {
    const distances = new Float32Array(7);
    const levels = new Int8Array(7).fill(-1);
    distances.set([0, 8, 12, 16, 20]);
    let a = 0;
    let b = 0;
    let wasA = false;
    let wasB = false;
    for (let frame = 0; frame < frames; frame++) {
      distances[5] = distanceA(frame);
      distances[6] = distanceB(frame);
      // `levels` is fed back, exactly as the view does it.
      selectDragonLods(distances, levels, 7, 0, low);
      const isA = levels[5] !== DRAGON_LOD_FAR;
      const isB = levels[6] !== DRAGON_LOD_FAR;
      expect(Array.from(levels).filter((level) => level !== DRAGON_LOD_FAR)).toHaveLength(6);
      if (frame > 0 && isA !== wasA) a++;
      if (frame > 0 && isB !== wasB) b++;
      wasA = isA;
      wasB = isB;
    }
    return { a, b, last: Array.from(levels) };
  }

  it('does not flip-flop two dragons whose distances cross back and forth by a few percent', () => {
    // A starts nearer; from then on the two swap order every few frames, +-4 %.
    const result = flips(
      600,
      (frame) => 40 * (1 + (frame === 0 ? -0.04 : 0.04 * Math.sin(frame * 0.9))),
      (frame) => 40 * (1 - (frame === 0 ? -0.04 : 0.04 * Math.sin(frame * 0.9))),
    );
    expect(result.a).toBe(0);
    expect(result.b).toBe(0);
    expect(result.last[5]).not.toBe(DRAGON_LOD_FAR);
    expect(result.last[6]).toBe(DRAGON_LOD_FAR);
  });

  it('would flip-flop without the feedback (the bug this guards against)', () => {
    // The same motion with last frame's levels thrown away: the place changes hands.
    const distances = new Float32Array(7);
    distances.set([0, 8, 12, 16, 20]);
    let changes = 0;
    let wasA = true;
    for (let frame = 0; frame < 600; frame++) {
      const swing = 0.04 * Math.sin(frame * 0.9);
      distances[5] = 40 * (1 + swing);
      distances[6] = 40 * (1 - swing);
      const levels = new Int8Array(7).fill(-1);
      selectDragonLods(distances, levels, 7, 0, low);
      const isA = levels[5] !== DRAGON_LOD_FAR;
      if (frame > 0 && isA !== wasA) changes++;
      wasA = isA;
    }
    expect(changes).toBeGreaterThan(50);
  });

  it('hands the place over once, and only once, to a challenger that is clearly nearer', () => {
    // B closes in steadily from 30 % farther to 30 % nearer than A.
    const result = flips(
      400,
      () => 40,
      (frame) => 40 * (1.3 - (0.6 * frame) / 399),
    );
    expect(result.a).toBe(1);
    expect(result.b).toBe(1);
    expect(result.last[5]).toBe(DRAGON_LOD_FAR);
    expect(result.last[6]).not.toBe(DRAGON_LOD_FAR);
  });

  it('keeps the incumbent up to the margin and not beyond it', () => {
    const policy = policyOf({ maxSkinned: 1 });
    const inside = 1 - LOD_CAP_HYSTERESIS + 0.02;
    const beyond = 1 - LOD_CAP_HYSTERESIS - 0.02;
    // Dragon 0 held the place last frame; dragon 1 was far.
    expect(select([40, 40 * inside], [1, DRAGON_LOD_FAR], -1, policy)[0]).not.toBe(DRAGON_LOD_FAR);
    expect(select([40, 40 * beyond], [1, DRAGON_LOD_FAR], -1, policy)[0]).toBe(DRAGON_LOD_FAR);
  });

  it('applies the same margin to the LOD0 cap', () => {
    const policy = policyOf({ maxLod0: 1 });
    // Both inside LOD0 range; dragon 0 was at LOD0, dragon 1 at LOD1 and now 5 % nearer.
    expect(select([10, 9.5], [0, 1], -1, policy)).toEqual([0, 1]);
    // Clearly nearer: it takes the place.
    expect(select([10, 7], [0, 1], -1, policy)).toEqual([1, 0]);
  });
});
