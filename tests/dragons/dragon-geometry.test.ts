import { describe, expect, it } from 'vitest';
import { DRAGON_CLASS_IDS, TEAMS, TEAM_EMBER } from '../../src/shared';
import {
  DRAGON_MAX_TRIANGLES,
  DRAGON_SHAPES,
  DRAGON_WING_ITEM_SIZE,
  WING_HINGE_Y,
  buildDragonGeometry,
} from '../../src/dragons';
import type { DragonGeometryData } from '../../src/dragons';

/** Hue in degrees of an sRGB hex colour. */
function hue(hex: number): number {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function saturation(hex: number): number {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

interface Triangle {
  readonly p: readonly [number, number, number][];
  readonly normal: readonly [number, number, number];
  /** Signed hinge X of its first vertex: 0 = body. */
  readonly hinge: number;
}

function triangles(data: DragonGeometryData): Triangle[] {
  const out: Triangle[] = [];
  for (let t = 0; t < data.triangleCount; t++) {
    const p: [number, number, number][] = [];
    for (let c = 0; c < 3; c++) {
      const o = (t * 3 + c) * 3;
      p.push([data.positions[o] ?? 0, data.positions[o + 1] ?? 0, data.positions[o + 2] ?? 0]);
    }
    const o = t * 9;
    out.push({
      p,
      normal: [data.normals[o] ?? 0, data.normals[o + 1] ?? 0, data.normals[o + 2] ?? 0],
      hinge: data.wing[t * 3 * DRAGON_WING_ITEM_SIZE] ?? 0,
    });
  }
  return out;
}

function windingNormal(t: Triangle): [number, number, number] {
  const [a, b, c] = t.p;
  if (a === undefined || b === undefined || c === undefined) return [0, 0, 0];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  const n: [number, number, number] = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const length = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / length, n[1] / length, n[2] / length];
}

describe.each(DRAGON_CLASS_IDS)('placeholder geometry: %s', (classId) => {
  const shape = DRAGON_SHAPES[classId];
  const data = buildDragonGeometry(shape);
  const tris = triangles(data);

  it('fits the triangle budget and its arrays agree', () => {
    expect(data.triangleCount).toBeGreaterThan(100);
    expect(data.triangleCount).toBeLessThanOrEqual(DRAGON_MAX_TRIANGLES);
    expect(Number.isInteger(data.triangleCount)).toBe(true);
    expect(data.positions.length).toBe(data.vertexCount * 3);
    expect(data.normals.length).toBe(data.vertexCount * 3);
    expect(data.colors.length).toBe(data.vertexCount * 3);
    expect(data.wing.length).toBe(data.vertexCount * DRAGON_WING_ITEM_SIZE);
    expect(data.positions.every(Number.isFinite)).toBe(true);
    expect(data.colors.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('stores unit face normals that agree with the counter-clockwise winding', () => {
    for (const t of tris) {
      const n = windingNormal(t);
      expect(Math.hypot(...t.normal)).toBeCloseTo(1, 5);
      expect(n[0] * t.normal[0] + n[1] * t.normal[1] + n[2] * t.normal[2]).toBeGreaterThan(0.999);
    }
  });

  it('has an outward-facing body: positive enclosed volume', () => {
    // Wings and fins are double-sided pairs that cancel; the open horn bases add a sliver.
    let volume = 0;
    for (const t of tris) {
      const [a, b, c] = t.p;
      if (a === undefined || b === undefined || c === undefined) continue;
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
    expect(volume).toBeGreaterThan(2);
    expect(volume).toBeLessThan(40);
  });

  it('points the nose along +Z and the tail along -Z, belly lighter than the back', () => {
    let maxZ = -Infinity;
    let minZ = Infinity;
    for (const t of tris) {
      if (t.hinge !== 0) continue;
      for (const p of t.p) {
        maxZ = Math.max(maxZ, p[2]);
        minZ = Math.min(minZ, p[2]);
      }
    }
    expect(maxZ).toBeCloseTo(1.9 + shape.neckLength + shape.headLength, 4);
    expect(minZ).toBeCloseTo(-1.9 - shape.tailLength, 4);
    // A straight-down face (belly) and a straight-up face (back) differ in colour.
    const down = tris.findIndex((t) => t.hinge === 0 && t.normal[1] < -0.99);
    const up = tris.findIndex((t) => t.hinge === 0 && t.normal[1] > 0.99);
    expect(down).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThanOrEqual(0);
    const sum = (index: number): number =>
      (data.colors[index * 9] ?? 0) +
      (data.colors[index * 9 + 1] ?? 0) +
      (data.colors[index * 9 + 2] ?? 0);
    expect(sum(down)).toBeGreaterThan(sum(up));
  });

  it('builds two mirrored, double-sided wings spread flat at the hinge height', () => {
    const left = tris.filter((t) => t.hinge > 0);
    const right = tris.filter((t) => t.hinge < 0);
    expect(left.length).toBe((2 * shape.wingFingers + 1) * 2);
    expect(right.length).toBe(left.length);
    let normalSum = 0;
    let maxX = 0;
    for (const t of left) {
      expect(Math.abs(t.normal[1])).toBeCloseTo(1, 6);
      normalSum += t.normal[1];
      for (const p of t.p) {
        expect(p[1]).toBeCloseTo(WING_HINGE_Y, 6);
        expect(p[0]).toBeGreaterThanOrEqual(t.hinge - 1e-6);
        maxX = Math.max(maxX, p[0]);
      }
    }
    // Every top face has a bottom twin.
    expect(normalSum).toBe(0);
    expect(maxX).toBeCloseTo(left[0] === undefined ? 0 : left[0].hinge + shape.wingSpan, 4);
    for (const t of right) for (const p of t.p) expect(p[0]).toBeLessThanOrEqual(t.hinge + 1e-6);
  });

  it('fans each wing without overlapping panels', () => {
    const top = tris.filter((t) => t.hinge > 0 && t.normal[1] > 0);
    const inside = (t: Triangle, x: number, z: number): boolean => {
      const [a, b, c] = t.p;
      if (a === undefined || b === undefined || c === undefined) return false;
      const edge = (p: readonly number[], q: readonly number[]): number =>
        ((q[0] ?? 0) - (p[0] ?? 0)) * (z - (p[2] ?? 0)) -
        ((q[2] ?? 0) - (p[2] ?? 0)) * (x - (p[0] ?? 0));
      const e0 = edge(a, b);
      const e1 = edge(b, c);
      const e2 = edge(c, a);
      const eps = 1e-6;
      return (e0 > eps && e1 > eps && e2 > eps) || (e0 < -eps && e1 < -eps && e2 < -eps);
    };
    for (const t of top) {
      const cx = t.p.reduce((s, p) => s + p[0], 0) / 3;
      const cz = t.p.reduce((s, p) => s + p[2], 0) / 3;
      for (const other of top) {
        if (other !== t) expect(inside(other, cx, cz)).toBe(false);
      }
    }
  });

  it('tags wing vertices for the shader and leaves the body alone', () => {
    let tailMax = 0;
    for (let i = 0; i < data.vertexCount; i++) {
      const o = i * DRAGON_WING_ITEM_SIZE;
      const hinge = data.wing[o] ?? 0;
      const tip = data.wing[o + 1] ?? 0;
      const tail = data.wing[o + 2] ?? 0;
      const membrane = data.wing[o + 3] ?? 0;
      const x = data.positions[i * 3] ?? 0;
      const z = data.positions[i * 3 + 2] ?? 0;
      expect(tip).toBeGreaterThanOrEqual(0);
      expect(tip).toBeLessThanOrEqual(1);
      expect(tail).toBeGreaterThanOrEqual(0);
      expect(tail).toBeLessThanOrEqual(1);
      if (hinge === 0) {
        expect(tip).toBe(0);
        expect(membrane).toBe(0);
        // The tail weight is 0 from the hips forward.
        if (z >= -1.9) expect(tail).toBe(0);
        tailMax = Math.max(tailMax, tail);
      } else {
        expect(Math.sign(hinge)).toBe(Math.sign(x));
        expect(tip).toBeCloseTo((Math.abs(x) - Math.abs(hinge)) / shape.wingSpan, 5);
        expect(membrane).toBeGreaterThan(0);
        expect(membrane).toBeLessThanOrEqual(1);
        expect(tail).toBe(0);
      }
    }
    expect(tailMax).toBeCloseTo(1, 5);
  });

  it('covers its vertices with the bounding radius and stays dragon sized', () => {
    for (let i = 0; i < data.vertexCount; i++) {
      const o = i * 3;
      const d = Math.hypot(
        data.positions[o] ?? 0,
        data.positions[o + 1] ?? 0,
        data.positions[o + 2] ?? 0,
      );
      expect(d).toBeLessThanOrEqual(data.boundingRadius + 1e-6);
    }
    expect(data.boundingRadius).toBeGreaterThan(5);
    expect(data.boundingRadius).toBeLessThan(9);
  });

  it('uses a jewel-tone hide, never red or orange', () => {
    const h = hue(shape.hideColor);
    // Reds and oranges sit between 345 and 40 degrees; Ember orange is at about 25.
    const redOrOrange = (h >= 345 || h <= 40) && saturation(shape.hideColor) > 0.25;
    expect(redOrOrange).toBe(false);
    expect(Math.abs(h - hue(TEAMS[TEAM_EMBER].color))).toBeGreaterThan(15);
  });
});

describe('placeholder silhouettes', () => {
  it('differ per class as the art direction asks', () => {
    const { talon, bastion, tempest, wraith } = DRAGON_SHAPES;
    expect(talon.girth).toBeLessThan(tempest.girth);
    expect(talon.wingChord).toBeLessThan(wraith.wingChord);
    expect(talon.wingSweep).toBeGreaterThan(bastion.wingSweep);
    expect(bastion.girth).toBeGreaterThan(tempest.girth);
    expect(bastion.wingChord).toBeGreaterThan(tempest.wingChord);
    expect(bastion.backPlates).toBeGreaterThan(0);
    expect(tempest.neckLength).toBeGreaterThan(wraith.neckLength);
    expect(tempest.crestHeight).toBeGreaterThan(0);
    expect(wraith.wingNotch).toBeGreaterThan(tempest.wingNotch);
    expect(wraith.tailLength).toBeGreaterThan(talon.tailLength);
  });
});
