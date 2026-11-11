import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { MAP_SURFACE_ROLES, MAP_SURFACE_ROLE_COLORS, mapSurfaceRoleIndex } from '../../src/shared';
import {
  DEFAULT_MAP_SHADE,
  bakeMapVertexColors,
  createGlowRoleMask,
  createRolePalette,
  fogHiddenDistance,
  mapVertexShade,
  sphereWithinDistance,
  srgbChannelToLinear,
  writeLinearFromSrgbHex,
} from '../../src/world/map';

const SHADE = { ...DEFAULT_MAP_SHADE, baseY: 0 };

describe('sRGB -> linear', () => {
  it('matches three.js Color.setHex for every palette role', () => {
    const out = new Float32Array(3);
    const reference = new Color();
    for (const role of MAP_SURFACE_ROLES) {
      const hex = MAP_SURFACE_ROLE_COLORS[role];
      writeLinearFromSrgbHex(hex, out);
      reference.setHex(hex);
      expect(out[0]).toBeCloseTo(reference.r, 5);
      expect(out[1]).toBeCloseTo(reference.g, 5);
      expect(out[2]).toBeCloseTo(reference.b, 5);
    }
  });

  it('keeps the end points and darkens mid tones', () => {
    expect(srgbChannelToLinear(0)).toBe(0);
    expect(srgbChannelToLinear(1)).toBeCloseTo(1, 6);
    expect(srgbChannelToLinear(0.5)).toBeCloseTo(0.214, 3);
  });

  it('writes at an offset', () => {
    const out = new Float32Array(6);
    writeLinearFromSrgbHex(0xffffff, out, 3);
    expect(Array.from(out.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(out[3]).toBeCloseTo(1, 6);
    expect(out[5]).toBeCloseTo(1, 6);
  });

  it('builds a palette indexed like MAP_SURFACE_ROLES', () => {
    const palette = createRolePalette();
    expect(palette.length).toBe(MAP_SURFACE_ROLES.length * 3);
    const stone = new Color().setHex(0x4e6a86);
    const o = mapSurfaceRoleIndex('stone') * 3;
    expect(palette[o]).toBeCloseTo(stone.r, 5);
    expect(palette[o + 2]).toBeCloseTo(stone.b, 5);
  });
});

describe('baked shade', () => {
  it('rises monotonically from baseShade at the base to 1 at the gradient top', () => {
    expect(mapVertexShade(-100, 0, SHADE)).toBeCloseTo(SHADE.baseShade, 6);
    expect(mapVertexShade(0, 0, SHADE)).toBeCloseTo(SHADE.baseShade, 6);
    expect(mapVertexShade(SHADE.gradientHeight, 1, SHADE)).toBeCloseTo(1, 6);
    expect(mapVertexShade(9999, 0, SHADE)).toBeCloseTo(1, 6);
    let previous = 0;
    for (let y = -50; y <= 400; y += 10) {
      const shade = mapVertexShade(y, 0, SHADE);
      expect(shade).toBeGreaterThanOrEqual(previous);
      expect(shade).toBeGreaterThan(0);
      expect(shade).toBeLessThanOrEqual(1);
      previous = shade;
    }
  });

  it('darkens faces that point down, and only those', () => {
    const side = mapVertexShade(200, 0, SHADE);
    expect(mapVertexShade(200, 1, SHADE)).toBe(side);
    expect(mapVertexShade(200, -1, SHADE)).toBeCloseTo(side * (1 - SHADE.undersideShade), 6);
    expect(mapVertexShade(200, -0.5, SHADE)).toBeLessThan(side);
  });

  it('multiplies the role colour and leaves glow roles at full brightness', () => {
    const palette = createRolePalette();
    const mask = createGlowRoleMask();
    const stone = mapSurfaceRoleIndex('stone');
    const well = mapSurfaceRoleIndex('skyWell');
    const positions = new Float32Array([0, 0, 0, 0, 0, 0, 0, 500, 0]);
    const normals = new Float32Array([1, 0, 0, 0, -1, 0, 0, 1, 0]);
    const roles = new Uint8Array([stone, well, stone]);
    const colors = bakeMapVertexColors(positions, normals, roles, palette, mask, SHADE);
    expect(colors.length).toBe(9);
    expect(colors[0]).toBeCloseTo((palette[stone * 3] ?? 0) * SHADE.baseShade, 6);
    expect(colors[3]).toBeCloseTo(palette[well * 3] ?? 0, 6);
    expect(colors[5]).toBeCloseTo(palette[well * 3 + 2] ?? 0, 6);
    expect(colors[8]).toBeCloseTo(palette[stone * 3 + 2] ?? 0, 6);
    expect(Array.from(mask)).toEqual(
      MAP_SURFACE_ROLES.map((role) =>
        role === 'skyWell' || role === 'ember' || role === 'frost' ? 1 : 0,
      ),
    );
  });
});

describe('distance culling maths', () => {
  it('inverts the exp2 fog curve', () => {
    const density = 0.00165;
    for (const fraction of [0.5, 0.97, 0.995]) {
      const d = fogHiddenDistance(density, fraction);
      expect(1 - Math.exp(-((density * d) ** 2))).toBeCloseTo(fraction, 9);
    }
    expect(fogHiddenDistance(0, 0.97)).toBe(Infinity);
    expect(fogHiddenDistance(0.001, 1)).toBe(Infinity);
    expect(fogHiddenDistance(Number.NaN, 0.5)).toBe(Infinity);
  });

  it('tests a sphere against a distance from the eye', () => {
    expect(sphereWithinDistance(0, 0, 0, 100, 0, 0, 10, 90)).toBe(true);
    expect(sphereWithinDistance(0, 0, 0, 100, 0, 0, 10, 89)).toBe(false);
    expect(sphereWithinDistance(5, 5, 5, 5, 5, 5, 0, 0)).toBe(true);
    expect(sphereWithinDistance(0, 0, 0, 1e6, 0, 0, 1, Infinity)).toBe(true);
  });
});
