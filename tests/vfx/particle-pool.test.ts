import { describe, expect, it } from 'vitest';
import { PARTICLE_STRIDE, P_LIFE, ParticlePool, packBlend } from '../../src/vfx/particle-pool';

describe('ParticlePool', () => {
  it('hands out slots in ring order and wraps at the capacity', () => {
    const pool = new ParticlePool(4);
    const offsets = [0, 1, 2, 3, 4, 5].map(() => pool.allocate(0, 1));
    expect(offsets).toEqual([0, 1, 2, 3, 0, 1].map((slot) => slot * PARTICLE_STRIDE));
    expect(pool.data.length).toBe(4 * PARTICLE_STRIDE);
  });

  it('reports nothing dirty until something is written', () => {
    const pool = new ParticlePool(8);
    expect(pool.dirtyRangeCount).toBe(0);
  });

  it('reports one run for writes that do not wrap', () => {
    const pool = new ParticlePool(8);
    pool.allocate(0, 1);
    pool.allocate(0, 1);
    pool.clearDirty();
    pool.allocate(0, 1);
    pool.allocate(0, 1);
    pool.allocate(0, 1);
    expect(pool.dirtyRangeCount).toBe(1);
    expect(pool.dirtyRangeStart(0)).toBe(2);
    expect(pool.dirtyRangeLength(0)).toBe(3);
    expect(pool.dirtyRangeLength(1)).toBe(0);
  });

  it('reports two runs when the writes wrap round the end', () => {
    const pool = new ParticlePool(8);
    for (let i = 0; i < 6; i++) pool.allocate(0, 1);
    pool.clearDirty();
    for (let i = 0; i < 5; i++) pool.allocate(0, 1);
    expect(pool.dirtyRangeCount).toBe(2);
    expect([pool.dirtyRangeStart(0), pool.dirtyRangeLength(0)]).toEqual([6, 2]);
    expect([pool.dirtyRangeStart(1), pool.dirtyRangeLength(1)]).toEqual([0, 3]);
  });

  it('a run that ends exactly at the capacity stays one run', () => {
    const pool = new ParticlePool(8);
    for (let i = 0; i < 5; i++) pool.allocate(0, 1);
    pool.clearDirty();
    for (let i = 0; i < 3; i++) pool.allocate(0, 1);
    expect(pool.dirtyRangeCount).toBe(1);
    expect([pool.dirtyRangeStart(0), pool.dirtyRangeLength(0)]).toEqual([5, 3]);
  });

  it('collapses to the whole buffer when a frame writes more than the capacity', () => {
    const pool = new ParticlePool(8);
    for (let i = 0; i < 3; i++) pool.allocate(0, 1);
    pool.clearDirty();
    for (let i = 0; i < 20; i++) pool.allocate(0, 1);
    expect(pool.dirtyRangeCount).toBe(1);
    expect([pool.dirtyRangeStart(0), pool.dirtyRangeLength(0)]).toEqual([0, 8]);
  });

  it('the dirty runs cover exactly the slots written, for any amount', () => {
    const pool = new ParticlePool(7);
    for (let start = 0; start < 7; start++) {
      for (let written = 1; written <= 9; written++) {
        pool.clear();
        for (let i = 0; i < start; i++) pool.allocate(0, 1);
        pool.clearDirty();
        const expected = new Set<number>();
        for (let i = 0; i < written; i++) expected.add(pool.allocate(0, 1) / PARTICLE_STRIDE);
        const covered = new Set<number>();
        for (let run = 0; run < pool.dirtyRangeCount; run++) {
          const first = pool.dirtyRangeStart(run);
          for (let i = 0; i < pool.dirtyRangeLength(run); i++) covered.add(first + i);
        }
        expect([...covered].sort(), `start ${start}, written ${written}`).toEqual(
          [...expected].sort(),
        );
      }
    }
  });

  it('counts the living and turns that into pressure', () => {
    const pool = new ParticlePool(10);
    pool.beginFrame(0);
    pool.allocate(0, 1);
    pool.allocate(0, 2);
    pool.allocate(0, 3);
    expect(pool.alive).toBe(3);
    expect(pool.pressure).toBeCloseTo(0.3);
    pool.beginFrame(1.5);
    expect(pool.alive).toBe(2);
    pool.beginFrame(10);
    expect(pool.alive).toBe(0);
  });

  it('never counts more alive than the cap, even when the ring overwrites live slots', () => {
    const pool = new ParticlePool(5);
    pool.beginFrame(0);
    for (let i = 0; i < 40; i++) pool.allocate(0, 100);
    expect(pool.alive).toBe(5);
    expect(pool.pressure).toBe(1);
    pool.beginFrame(1);
    expect(pool.alive).toBe(5);
  });

  it('setCapacity limits the ring, kills everything and marks the new range dirty', () => {
    const pool = new ParticlePool(8);
    pool.beginFrame(0);
    for (let i = 0; i < 8; i++) {
      const o = pool.allocate(0, 5);
      pool.data[o + P_LIFE] = 5;
    }
    pool.clearDirty();
    pool.setCapacity(3);
    expect(pool.capacity).toBe(3);
    expect(pool.alive).toBe(0);
    for (let i = 0; i < 8; i++) expect(pool.data[i * PARTICLE_STRIDE + P_LIFE]).toBe(0);
    expect(pool.dirtyRangeCount).toBe(1);
    expect(pool.dirtyRangeLength(0)).toBe(3);
    const offsets = [0, 1, 2, 3].map(() => pool.allocate(0, 1) / PARTICLE_STRIDE);
    expect(offsets).toEqual([0, 1, 2, 0]);
  });

  it('clamps the capacity into 1..maxCapacity', () => {
    const pool = new ParticlePool(8, 100);
    expect(pool.capacity).toBe(8);
    pool.setCapacity(0);
    expect(pool.capacity).toBe(1);
  });

  it('never allocates a new buffer', () => {
    const pool = new ParticlePool(16);
    const data = pool.data;
    for (let i = 0; i < 100; i++) pool.allocate(i, 1);
    pool.setCapacity(4);
    pool.clear();
    expect(pool.data).toBe(data);
  });
});

describe('packBlend', () => {
  it('keeps opacity in the integer part and additive in the fraction', () => {
    const decode = (w: number): [number, number] => [
      Math.floor(w) * 0.01,
      (w - Math.floor(w)) / 0.99,
    ];
    const cases: readonly (readonly [number, number])[] = [
      [1, 0],
      [1, 1],
      [0.5, 0.25],
      [0.85, 0.4],
      [0, 0.7],
    ];
    for (const [opacity, additive] of cases) {
      const [o, a] = decode(packBlend(opacity, additive));
      expect(o).toBeCloseTo(opacity, 5);
      expect(a).toBeCloseTo(additive, 5);
    }
  });

  it('survives the float32 the GPU reads it as', () => {
    const packed = Math.fround(packBlend(0.85, 0.4));
    expect(Math.floor(packed)).toBe(85);
    expect((packed - 85) / 0.99).toBeCloseTo(0.4, 4);
  });

  it('clamps out-of-range input', () => {
    expect(packBlend(2, 2)).toBeCloseTo(100.99);
    expect(packBlend(-1, -1)).toBe(0);
  });
});
