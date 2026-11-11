import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, QUALITY_PRESET_IDS, TEAM_EMBER, TEAM_FROST } from '../../src/shared';
import {
  Emitter,
  PRESSURE_FLOOR,
  PRESSURE_SOFT_LIMIT,
  VFX_QUALITY,
  defineRecipe,
  pressureScale,
  spawnCount,
} from '../../src/vfx/emitter';
import { COLOR_TEAM, PALETTE, paletteOffset } from '../../src/vfx/palette';
import {
  PARTICLE_STRIDE,
  P_BIRTH,
  P_BLEND,
  P_LIFE,
  P_R0,
  P_SIZE_END,
  P_SIZE_START,
  P_SPRITE_SEED,
  P_VX,
  P_VY,
  P_VZ,
  P_X,
  P_Y,
  P_Z,
  ParticlePool,
} from '../../src/vfx/particle-pool';
import { RECIPES } from '../../src/vfx/recipes';

function at(pool: ParticlePool, slot: number, field: number): number {
  return pool.data[slot * PARTICLE_STRIDE + field] ?? NaN;
}

describe('pressureScale', () => {
  it('is 1 while the pool has room and falls to the floor when it is full', () => {
    expect(pressureScale(0)).toBe(1);
    expect(pressureScale(PRESSURE_SOFT_LIMIT)).toBe(1);
    expect(pressureScale(1)).toBe(PRESSURE_FLOOR);
    expect(pressureScale(5)).toBe(PRESSURE_FLOOR);
    expect(pressureScale(NaN)).toBe(1);
  });

  it('never rises as the pool fills', () => {
    let last = 1;
    for (let p = 0; p <= 1.001; p += 0.01) {
      const scale = pressureScale(p);
      expect(scale).toBeLessThanOrEqual(last + 1e-12);
      expect(scale).toBeGreaterThanOrEqual(PRESSURE_FLOOR - 1e-12);
      last = scale;
    }
  });
});

describe('spawnCount', () => {
  it('scales the authored count by the preset factor', () => {
    expect(spawnCount(20, 1, 0, 0, 0)).toBe(20);
    expect(spawnCount(20, 0.65, 0, 0, 0)).toBe(13);
    expect(spawnCount(20, 0.4, 0, 0, 0)).toBe(8);
  });

  it('rounds the fraction with the roll, so the average is exact', () => {
    expect(spawnCount(1, 0.3, 0, 0, 0.69)).toBe(0);
    expect(spawnCount(1, 0.3, 0, 0, 0.71)).toBe(1);
    let total = 0;
    const rolls = 1000;
    for (let i = 0; i < rolls; i++) total += spawnCount(1, 0.3, 0, 0, i / rolls);
    expect(total / rolls).toBeCloseTo(0.3, 2);
  });

  it('thins out under pressure but keeps the minimum', () => {
    expect(spawnCount(20, 1, 1, 0, 0)).toBe(3);
    expect(spawnCount(20, 1, 1, 5, 0)).toBe(5);
    expect(spawnCount(1, 0.4, 1, 1, 0)).toBe(1);
    expect(spawnCount(0, 1, 0, 0, 0.99)).toBe(0);
  });
});

describe('preset factors', () => {
  it('spawn less and draw a little larger on weaker presets', () => {
    expect(VFX_QUALITY.low.countScale).toBeLessThan(VFX_QUALITY.medium.countScale);
    expect(VFX_QUALITY.medium.countScale).toBeLessThan(VFX_QUALITY.high.countScale);
    expect(VFX_QUALITY.high.countScale).toBe(1);
    expect(VFX_QUALITY.low.sizeScale).toBeGreaterThan(VFX_QUALITY.high.sizeScale);
    expect(VFX_QUALITY.low.maxScreenSize).toBeLessThan(VFX_QUALITY.high.maxScreenSize);
  });
});

describe('Emitter', () => {
  const burst = defineRecipe({
    count: 20,
    minCount: 2,
    shape: 'cone',
    spread: 0.3,
    speedMin: 10,
    speedMax: 20,
    lifeMin: 0.5,
    lifeMax: 1,
    sizeMin: 1,
    sizeMax: 2,
    sizeEnd: 3,
    colorStart: COLOR_TEAM,
  });

  it('expands a recipe into the preset-scaled number of particles', () => {
    for (const id of QUALITY_PRESET_IDS) {
      const pool = new ParticlePool(
        QUALITY_PRESETS.high.maxParticles,
        QUALITY_PRESETS[id].maxParticles,
      );
      const em = new Emitter(pool, 1);
      em.countScale = VFX_QUALITY[id].countScale;
      pool.beginFrame(0);
      const n = em.burst(burst, 0, 0, 0, 0, 0, 1, TEAM_EMBER);
      const exact = 20 * VFX_QUALITY[id].countScale;
      expect(n).toBeGreaterThanOrEqual(Math.floor(exact));
      expect(n).toBeLessThanOrEqual(Math.ceil(exact));
      expect(pool.alive).toBe(n);
      expect(em.spawned).toBe(n);
    }
  });

  it('gives the same particles for the same seed, and different ones for another', () => {
    const run = (seed: number): Float32Array => {
      const pool = new ParticlePool(64);
      const em = new Emitter(pool, seed);
      em.time = 3;
      pool.beginFrame(3);
      em.burst(burst, 1, 2, 3, 0, 1, 0, TEAM_FROST);
      em.burst(RECIPES.takedownEmbers, 4, 5, 6, 1, 0, 0, TEAM_EMBER);
      return pool.data.slice();
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('writes every particle inside the recipe ranges', () => {
    const pool = new ParticlePool(64);
    const em = new Emitter(pool, 9);
    em.time = 5;
    pool.beginFrame(5);
    const n = em.burst(burst, 10, 20, 30, 0, 0, 2, TEAM_FROST);
    const c = paletteOffset(TEAM_FROST, COLOR_TEAM);
    for (let i = 0; i < n; i++) {
      expect(at(pool, i, P_X)).toBe(10);
      expect(at(pool, i, P_Y)).toBe(20);
      expect(at(pool, i, P_Z)).toBe(30);
      expect(at(pool, i, P_BIRTH)).toBe(5);
      const life = at(pool, i, P_LIFE);
      expect(life).toBeGreaterThanOrEqual(0.5);
      expect(life).toBeLessThanOrEqual(1);
      const size = at(pool, i, P_SIZE_START);
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(2);
      expect(at(pool, i, P_SIZE_END)).toBeCloseTo(size * 3, 4);
      const vx = at(pool, i, P_VX);
      const vy = at(pool, i, P_VY);
      const vz = at(pool, i, P_VZ);
      const speed = Math.hypot(vx, vy, vz);
      expect(speed).toBeGreaterThanOrEqual(10 - 1e-3);
      expect(speed).toBeLessThanOrEqual(20 + 1e-3);
      // Inside the cone round +Z.
      expect(vz / speed).toBeGreaterThanOrEqual(Math.cos(0.3) - 1e-4);
      expect(at(pool, i, P_R0)).toBeCloseTo(PALETTE[c] ?? NaN, 6);
      expect(Math.floor(at(pool, i, P_SPRITE_SEED))).toBe(0);
      expect(Math.floor(at(pool, i, P_BLEND))).toBe(100);
    }
  });

  it('scales sizes by the preset and by the caller', () => {
    const pool = new ParticlePool(64);
    const em = new Emitter(pool, 9);
    em.sizeScale = 1.2;
    pool.beginFrame(0);
    const n = em.burst(burst, 0, 0, 0, 0, 0, 1, TEAM_EMBER, 2);
    for (let i = 0; i < n; i++) {
      expect(at(pool, i, P_SIZE_START)).toBeGreaterThanOrEqual(2.4 - 1e-4);
      expect(at(pool, i, P_SIZE_START)).toBeLessThanOrEqual(4.8 + 1e-4);
    }
  });

  it('a ring starts on its circle, square to the direction', () => {
    const ring = defineRecipe({ count: 16, shape: 'ring', radius: 5, speedMin: 2, speedMax: 2 });
    const pool = new ParticlePool(64);
    const em = new Emitter(pool, 3);
    pool.beginFrame(0);
    const n = em.burst(ring, 0, 0, 0, 0, 1, 0, TEAM_EMBER);
    expect(n).toBe(16);
    for (let i = 0; i < n; i++) {
      expect(at(pool, i, P_Y)).toBeCloseTo(0, 5);
      expect(Math.hypot(at(pool, i, P_X), at(pool, i, P_Z))).toBeCloseTo(5, 4);
      // Moving straight out from the centre.
      const dot = at(pool, i, P_X) * at(pool, i, P_VX) + at(pool, i, P_Z) * at(pool, i, P_VZ);
      expect(dot).toBeCloseTo(10, 3);
    }
  });

  it('a sphere fills its radius and a zero direction means up', () => {
    const ball = defineRecipe({ count: 40, shape: 'sphere', radius: 4 });
    const pool = new ParticlePool(64);
    const em = new Emitter(pool, 3);
    pool.beginFrame(0);
    em.burst(ball, 0, 0, 0, 0, 0, 0, TEAM_EMBER);
    let far = 0;
    for (let i = 0; i < 40; i++) {
      const r = Math.hypot(at(pool, i, P_X), at(pool, i, P_Y), at(pool, i, P_Z));
      expect(r).toBeLessThanOrEqual(4 + 1e-4);
      far = Math.max(far, r);
    }
    expect(far).toBeGreaterThan(2.5);

    const up = defineRecipe({ count: 4, speedMin: 5, speedMax: 5 });
    pool.clear();
    em.burst(up, 0, 0, 0, 0, 0, 0, TEAM_EMBER);
    for (let i = 0; i < 4; i++) expect(at(pool, i, P_VY)).toBeCloseTo(5, 4);
  });

  it('inherits the source velocity and spreads a trail back along its path', () => {
    const trail = defineRecipe({ count: 30, inherit: 0.5 });
    const pool = new ParticlePool(64);
    const em = new Emitter(pool, 3);
    em.time = 10;
    pool.beginFrame(10);
    em.setSource(60, 0, 0, 1 / 60);
    const n = em.burst(trail, 100, 0, 0, 1, 0, 0, TEAM_EMBER);
    let spread = 0;
    for (let i = 0; i < n; i++) {
      expect(at(pool, i, P_VX)).toBeCloseTo(30, 4);
      const back = 10 - at(pool, i, P_BIRTH);
      expect(back).toBeGreaterThanOrEqual(0);
      expect(back).toBeLessThanOrEqual(1 / 60 + 1e-5);
      // Where the source was at that birth time.
      expect(at(pool, i, P_X)).toBeCloseTo(100 - 60 * back, 2);
      spread = Math.max(spread, back);
    }
    expect(spread).toBeGreaterThan(0.01);
    em.clearSource();
    pool.clear();
    em.burst(trail, 100, 0, 0, 1, 0, 0, TEAM_EMBER);
    expect(at(pool, 0, P_VX)).toBe(0);
    expect(at(pool, 0, P_X)).toBe(100);
  });

  it('a stream averages its rate over many frames and ignores minCount', () => {
    const stream = defineRecipe({ count: 30, minCount: 5, lifeMin: 0.01, lifeMax: 0.01 });
    const pool = new ParticlePool(256);
    const em = new Emitter(pool, 11);
    let total = 0;
    const frames = 600;
    for (let f = 0; f < frames; f++) {
      em.time = f / 60;
      pool.beginFrame(em.time);
      total += em.stream(stream, 1 / 60, 0, 0, 0, 0, 1, 0, TEAM_EMBER);
    }
    // 30 per second for 10 seconds.
    expect(total).toBeGreaterThan(270);
    expect(total).toBeLessThan(330);
    expect(em.stream(stream, 0, 0, 0, 0, 0, 1, 0, TEAM_EMBER)).toBe(0);
  });

  it('degrades gracefully: a full pool gets a fraction, and never more than the cap alive', () => {
    const pool = new ParticlePool(100);
    const em = new Emitter(pool, 5);
    const big = defineRecipe({ count: 40, lifeMin: 10, lifeMax: 10 });
    pool.beginFrame(0);
    const first = em.burst(big, 0, 0, 0, 0, 1, 0, TEAM_EMBER);
    expect(first).toBe(40);
    em.burst(big, 0, 0, 0, 0, 1, 0, TEAM_EMBER);
    // Above the soft limit now: the next burst is thinned.
    const thinned = em.burst(big, 0, 0, 0, 0, 1, 0, TEAM_EMBER);
    expect(thinned).toBeLessThan(40);
    for (let i = 0; i < 50; i++) em.burst(big, 0, 0, 0, 0, 1, 0, TEAM_EMBER);
    expect(pool.alive).toBe(100);
    const starved = em.burst(big, 0, 0, 0, 0, 1, 0, TEAM_EMBER);
    expect(starved).toBeLessThanOrEqual(Math.ceil(40 * PRESSURE_FLOOR));
    expect(pool.alive).toBeLessThanOrEqual(pool.capacity);
  });

  it('writes only finite numbers, whatever the recipe', () => {
    const pool = new ParticlePool(3000);
    const em = new Emitter(pool, 77);
    pool.beginFrame(0);
    em.setSource(40, -3, 12, 1 / 60);
    for (const recipe of Object.values(RECIPES)) {
      em.burst(recipe, 1, 2, 3, 0.3, -0.2, 0.9, TEAM_FROST);
    }
    for (let i = 0; i < pool.alive * PARTICLE_STRIDE; i++) {
      expect(Number.isFinite(pool.data[i])).toBe(true);
    }
  });
});
