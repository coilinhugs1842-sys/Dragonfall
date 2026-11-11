import { describe, expect, it } from 'vitest';
import {
  ATLAS_CHANNELS,
  ATLAS_COLUMNS,
  ATLAS_ROWS,
  SPRITES,
  atlasCellRect,
  atlasTexelOffset,
  generateEffectAtlas,
} from '../../src/vfx/atlas';

const CELL = 32;

describe('effect atlas', () => {
  it('has a cell for every sprite', () => {
    expect(SPRITES.length).toBeLessThanOrEqual(ATLAS_COLUMNS * ATLAS_ROWS);
  });

  it('maps a sprite to its cell rectangle', () => {
    const rect = { u0: 0, v0: 0, u1: 0, v1: 0 };
    expect(atlasCellRect(0, rect)).toEqual({ u0: 0, v0: 0, u1: 0.25, v1: 0.5 });
    expect(atlasCellRect(3, rect)).toEqual({ u0: 0.75, v0: 0, u1: 1, v1: 0.5 });
    expect(atlasCellRect(5, rect)).toEqual({ u0: 0.25, v0: 0.5, u1: 0.5, v1: 1 });
  });

  it('cells tile the atlas without overlap', () => {
    const rect = { u0: 0, v0: 0, u1: 0, v1: 0 };
    let area = 0;
    for (let s = 0; s < ATLAS_COLUMNS * ATLAS_ROWS; s++) {
      atlasCellRect(s, rect);
      area += (rect.u1 - rect.u0) * (rect.v1 - rect.v0);
      expect(rect.u1).toBeLessThanOrEqual(1);
      expect(rect.v1).toBeLessThanOrEqual(1);
    }
    expect(area).toBeCloseTo(1);
  });

  it('texel offsets agree with the cell rectangles', () => {
    const rect = { u0: 0, v0: 0, u1: 0, v1: 0 };
    const width = ATLAS_COLUMNS * CELL;
    for (let s = 0; s < SPRITES.length; s++) {
      atlasCellRect(s, rect);
      const o = atlasTexelOffset(s, 0, 0, CELL) / ATLAS_CHANNELS;
      expect(o % width).toBe(Math.round(rect.u0 * width));
      expect(Math.floor(o / width)).toBe(Math.round(rect.v0 * ATLAS_ROWS * CELL));
    }
  });

  it('has the right size and is deterministic for a seed', () => {
    const a = generateEffectAtlas(CELL, 7);
    const b = generateEffectAtlas(CELL, 7);
    expect(a.length).toBe(ATLAS_COLUMNS * CELL * ATLAS_ROWS * CELL * ATLAS_CHANNELS);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(generateEffectAtlas(CELL, 8)).equals(Buffer.from(a))).toBe(false);
  });

  it('every sprite is exactly zero on its cell border (no bleed, no visible quad edge)', () => {
    const data = generateEffectAtlas(CELL);
    const edges: readonly (readonly [number, number])[] = [
      [1, 0],
      [0, 1],
    ];
    for (let s = 0; s < SPRITES.length; s++) {
      for (let i = 0; i < CELL; i++) {
        for (const [alongX, alongY] of edges) {
          for (const far of [0, CELL - 1]) {
            const x = alongX === 1 ? i : far;
            const y = alongY === 1 ? i : far;
            const o = atlasTexelOffset(s, x, y, CELL);
            expect(data[o]).toBe(0);
            expect(data[o + 1]).toBe(0);
          }
        }
      }
    }
  });

  it('every sprite has a visible shape, and a core no larger than it', () => {
    const data = generateEffectAtlas(CELL);
    for (let s = 0; s < SPRITES.length; s++) {
      let shape = 0;
      let core = 0;
      let peak = 0;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const o = atlasTexelOffset(s, x, y, CELL);
          shape += data[o] ?? 0;
          core += data[o + 1] ?? 0;
          peak = Math.max(peak, data[o] ?? 0);
        }
      }
      const coverage = shape / (255 * CELL * CELL);
      expect(peak, SPRITES[s]).toBeGreaterThan(200);
      expect(coverage, SPRITES[s]).toBeGreaterThan(0.02);
      // Bold shapes, but never a full quad: overdraw is the budget.
      expect(coverage, SPRITES[s]).toBeLessThan(0.5);
      expect(core, SPRITES[s]).toBeLessThan(shape);
    }
  });

  it('directional sprites are heavier toward +U (the head leads)', () => {
    const data = generateEffectAtlas(CELL);
    for (const name of ['wisp', 'spark'] as const) {
      const s = SPRITES.indexOf(name);
      let left = 0;
      let right = 0;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const v = data[atlasTexelOffset(s, x, y, CELL)] ?? 0;
          if (x < CELL / 2) left += v;
          else right += v;
        }
      }
      expect(right, name).toBeGreaterThan(left * 1.3);
    }
  });
});
