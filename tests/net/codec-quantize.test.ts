import { describe, expect, it } from 'vitest';
import {
  BUTTON_BOOST,
  BUTTON_MASK,
  CLASS_TUNING,
  DRAGON_CLASS_IDS,
  FLIGHT_TUNING,
  GREYBOX_CEILING_Y,
  GREYBOX_FLOOR_Y,
  GREYBOX_STORM_RADIUS,
  TICK_DT_S,
  createInputFrame,
  createQuat,
} from '../../src/shared';
import { createSeededRandom } from '../../src/shared/maps/seeded-random';
import { maxFlightSpeed } from '../../src/sim';
import {
  PACKED_QUAT_IDENTITY,
  TICK_WRAP,
  dequantizeClockS,
  dequantizePositionXZ,
  dequantizePositionY,
  dequantizeSteer,
  dequantizeUnit8,
  dequantizeVelocity,
  expandTick,
  isTickNewer,
  packQuat,
  quantizeClockS,
  quantizePositionXZ,
  quantizePositionY,
  quantizeSteer,
  quantizeUnit8,
  quantizeUnit8Ceil,
  quantizeVelocity,
  snapInputFrame,
  snapSteer,
  tickDiff,
  unpackQuat,
  wrapTick,
} from '../../src/net/codec';
import {
  WIRE_POSITION_HALF_EXTENT_M,
  WIRE_POSITION_STEP_M,
  WIRE_TIME_INFINITE,
  WIRE_VELOCITY_MAX_MPS,
  WIRE_VELOCITY_STEP_MPS,
} from '../../src/net/protocol';

const DEG = 180 / Math.PI;

/** Angle in degrees between the rotations of two unit quaternions. */
function quatAngleDeg(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot)) * DEG;
}

describe('tick wrapping', () => {
  it('wraps a full tick to 16 bits', () => {
    expect(wrapTick(0)).toBe(0);
    expect(wrapTick(65535)).toBe(65535);
    expect(wrapTick(65536)).toBe(0);
    expect(wrapTick(65536 * 3 + 17)).toBe(17);
  });

  it('gives the signed distance across the wrap', () => {
    expect(tickDiff(5, 3)).toBe(2);
    expect(tickDiff(3, 5)).toBe(-2);
    expect(tickDiff(2, 65534)).toBe(4);
    expect(tickDiff(65534, 2)).toBe(-4);
    expect(tickDiff(0, 0)).toBe(0);
    expect(tickDiff(32767, 0)).toBe(32767);
    expect(tickDiff(32768, 0)).toBe(-32768);
    // Full ticks work too: only the low 16 bits count.
    expect(tickDiff(65536 + 10, 65530)).toBe(16);
  });

  it('orders ticks across the wrap', () => {
    expect(isTickNewer(1, 65535)).toBe(true);
    expect(isTickNewer(65535, 1)).toBe(false);
    expect(isTickNewer(7, 7)).toBe(false);
  });

  it('expands a wire tick against a full local tick, on both sides of every wrap', () => {
    for (const reference of [0, 5, 32760, 65530, 65536, 65541, 200_000, 65536 * 40 - 3]) {
      for (const offset of [-32768, -3000, -3, -1, 0, 1, 2, 900, 32767]) {
        const full = reference + offset;
        expect(expandTick(wrapTick(full), reference)).toBe(full);
      }
    }
  });

  it('follows a tick counter through several wraps', () => {
    let known = 0;
    for (let tick = 0; tick < TICK_WRAP * 3; tick += 613) {
      known = expandTick(wrapTick(tick), known);
      expect(known).toBe(tick);
    }
  });
});

describe('position quantization', () => {
  it('uses a step of about 6 cm', () => {
    expect(WIRE_POSITION_STEP_M).toBeGreaterThan(0.05);
    expect(WIRE_POSITION_STEP_M).toBeLessThan(0.06);
  });

  it('covers the map with margin on every axis', () => {
    expect(WIRE_POSITION_HALF_EXTENT_M).toBeGreaterThanOrEqual(GREYBOX_STORM_RADIUS * 1.5);
    expect(dequantizePositionY(-32767)).toBeLessThan(GREYBOX_FLOOR_Y - 500);
    expect(dequantizePositionY(32767)).toBeGreaterThan(GREYBOX_CEILING_Y + 500);
  });

  it('keeps the error within 3 cm per axis over the whole map volume', () => {
    const random = createSeededRandom(0xc0dec);
    let worst = 0;
    const check = (x: number, y: number, z: number): void => {
      const ex = Math.abs(dequantizePositionXZ(quantizePositionXZ(x)) - x);
      const ey = Math.abs(dequantizePositionY(quantizePositionY(y)) - y);
      const ez = Math.abs(dequantizePositionXZ(quantizePositionXZ(z)) - z);
      worst = Math.max(worst, ex, ey, ez);
    };
    const reach = GREYBOX_STORM_RADIUS + 300;
    for (let i = 0; i < 200_000; i++) {
      check(
        (random() * 2 - 1) * reach,
        GREYBOX_FLOOR_Y - 300 + random() * (GREYBOX_CEILING_Y - GREYBOX_FLOOR_Y + 600),
        (random() * 2 - 1) * reach,
      );
    }
    // Corners and edges of the volume.
    for (const x of [-reach, 0, reach]) {
      for (const y of [GREYBOX_FLOOR_Y - 300, 0, GREYBOX_CEILING_Y + 300]) {
        for (const z of [-reach, 0, reach]) check(x, y, z);
      }
    }
    expect(worst).toBeLessThanOrEqual(0.03);
    expect(worst).toBeLessThanOrEqual(WIRE_POSITION_STEP_M / 2 + 1e-9);
  });

  it('clamps out-of-range values and turns NaN into a legal value', () => {
    expect(quantizePositionXZ(1e9)).toBe(32767);
    expect(quantizePositionXZ(-1e9)).toBe(-32767);
    expect(quantizePositionXZ(Infinity)).toBe(32767);
    expect(quantizePositionXZ(-Infinity)).toBe(-32767);
    expect(quantizePositionXZ(NaN)).toBe(0);
    expect(quantizePositionY(NaN)).toBe(0);
    expect(quantizePositionY(1e9)).toBe(32767);
  });
});

describe('quaternion smallest-three', () => {
  it('round-trips the identity and the axis half-turns exactly', () => {
    const out = createQuat();
    expect(packQuat(0, 0, 0, 1)).toBe(PACKED_QUAT_IDENTITY);
    for (const [x, y, z, w] of [
      [0, 0, 0, 1],
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ] as const) {
      unpackQuat(packQuat(x, y, z, w), out);
      expect([out.x, out.y, out.z, out.w]).toEqual([x, y, z, w]);
    }
  });

  it('treats q and -q as the same rotation', () => {
    expect(packQuat(0.1, -0.2, 0.3, -0.9)).toBe(packQuat(-0.1, 0.2, -0.3, 0.9));
  });

  it('always returns a unit quaternion with the dropped component positive', () => {
    const random = createSeededRandom(7);
    const out = createQuat();
    for (let i = 0; i < 20_000; i++) {
      // Every 32-bit pattern, including ones no encoder produces.
      unpackQuat((random() * 0x1_0000_0000) >>> 0, out);
      const length = Math.hypot(out.x, out.y, out.z, out.w);
      expect(length).toBeGreaterThan(0.999999);
      expect(length).toBeLessThan(1.000001);
    }
  });

  it('bounds the angular error: worst case under 0.28 degrees, mean under 0.1', () => {
    const random = createSeededRandom(0xa11);
    const out = createQuat();
    let worst = 0;
    let sum = 0;
    const count = 300_000;
    const gauss = (): number => {
      // Box-Muller: normal components give uniformly distributed rotations.
      const u = Math.max(random(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
    };
    for (let i = 0; i < count; i++) {
      const x = gauss();
      const y = gauss();
      const z = gauss();
      const w = gauss();
      const length = Math.hypot(x, y, z, w);
      const q = { x: x / length, y: y / length, z: z / length, w: w / length };
      unpackQuat(packQuat(x, y, z, w), out);
      const error = quatAngleDeg(q, out);
      worst = Math.max(worst, error);
      sum += error;
    }
    expect(worst).toBeLessThan(0.28);
    expect(sum / count).toBeLessThan(0.1);
  });

  it('holds the bound at the worst spot (all four components near 0.5)', () => {
    const random = createSeededRandom(99);
    const out = createQuat();
    let worst = 0;
    for (let i = 0; i < 100_000; i++) {
      const x = 0.5 + (random() - 0.5) * 0.02;
      const y = (random() < 0.5 ? -1 : 1) * (0.5 + (random() - 0.5) * 0.02);
      const z = 0.5 + (random() - 0.5) * 0.02;
      const w = (random() < 0.5 ? -1 : 1) * (0.5 + (random() - 0.5) * 0.02);
      const length = Math.hypot(x, y, z, w);
      unpackQuat(packQuat(x, y, z, w), out);
      const q = { x: x / length, y: y / length, z: z / length, w: w / length };
      worst = Math.max(worst, quatAngleDeg(q, out));
    }
    expect(worst).toBeLessThan(0.28);
  });

  it('normalises its input and packs degenerate input as the identity', () => {
    const out = createQuat();
    unpackQuat(packQuat(0, 0, 0, 25), out);
    expect([out.x, out.y, out.z, out.w]).toEqual([0, 0, 0, 1]);
    expect(packQuat(0, 0, 0, 0)).toBe(PACKED_QUAT_IDENTITY);
    expect(packQuat(NaN, 0, 0, 1)).toBe(PACKED_QUAT_IDENTITY);
    expect(packQuat(Infinity, 0, 0, 1)).toBe(PACKED_QUAT_IDENTITY);
  });
});

describe('velocity quantization', () => {
  it('covers the fastest dive of every class plus a full burst', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      const top =
        maxFlightSpeed(FLIGHT_TUNING, CLASS_TUNING[classId]) + FLIGHT_TUNING.maxBurstSpeed;
      expect(top).toBeLessThanOrEqual(WIRE_VELOCITY_MAX_MPS);
    }
  });

  it('keeps the error within half a step (0.75 m/s) inside the range', () => {
    let worst = 0;
    for (let v = -WIRE_VELOCITY_MAX_MPS; v <= WIRE_VELOCITY_MAX_MPS; v += 0.037) {
      worst = Math.max(worst, Math.abs(dequantizeVelocity(quantizeVelocity(v)) - v));
    }
    expect(worst).toBeLessThanOrEqual(WIRE_VELOCITY_STEP_MPS / 2 + 1e-9);
    expect(worst).toBeLessThan(0.75);
  });

  it('clamps to an i8 and never yields NaN', () => {
    expect(quantizeVelocity(1e6)).toBe(127);
    expect(quantizeVelocity(-1e6)).toBe(-127);
    expect(quantizeVelocity(NaN)).toBe(0);
    expect(dequantizeVelocity(quantizeVelocity(0))).toBe(0);
  });
});

describe('steer quantization', () => {
  it('round-trips -1, 0 and 1 exactly and stays within one grid step elsewhere', () => {
    expect(snapSteer(-1)).toBe(-1);
    expect(snapSteer(0)).toBe(0);
    expect(snapSteer(1)).toBe(1);
    let worst = 0;
    for (let v = -1; v <= 1; v += 0.00013) worst = Math.max(worst, Math.abs(snapSteer(v) - v));
    expect(worst).toBeLessThanOrEqual(0.5 / 32767 + 1e-12);
  });

  it('clamps and sanitises', () => {
    expect(quantizeSteer(4)).toBe(32767);
    expect(quantizeSteer(-4)).toBe(-32767);
    expect(quantizeSteer(NaN)).toBe(0);
    expect(dequantizeSteer(-32768)).toBe(-1);
  });

  it('is idempotent, so a snapped frame is exactly what the host decodes', () => {
    const frame = createInputFrame();
    frame.steerX = 0.123456789;
    frame.steerY = -0.987654321;
    frame.buttons = BUTTON_BOOST | (1 << 14);
    snapInputFrame(frame);
    expect(frame.buttons).toBe(BUTTON_BOOST);
    expect(frame.buttons & ~BUTTON_MASK).toBe(0);
    const { steerX, steerY } = frame;
    snapInputFrame(frame);
    expect(frame.steerX).toBe(steerX);
    expect(frame.steerY).toBe(steerY);
    expect(dequantizeSteer(quantizeSteer(steerX))).toBe(steerX);
  });
});

describe('fractions and clock', () => {
  it('quantizes 0..1 to a byte', () => {
    expect(quantizeUnit8(0)).toBe(0);
    expect(quantizeUnit8(1)).toBe(255);
    expect(quantizeUnit8(7)).toBe(255);
    expect(quantizeUnit8(-1)).toBe(0);
    expect(quantizeUnit8(NaN)).toBe(0);
    expect(Math.abs(dequantizeUnit8(quantizeUnit8(0.4)) - 0.4)).toBeLessThanOrEqual(0.5 / 255);
  });

  it('never rounds a living dragon down to zero health', () => {
    expect(quantizeUnit8Ceil(0.0001)).toBe(1);
    expect(quantizeUnit8Ceil(0)).toBe(0);
    expect(quantizeUnit8Ceil(1)).toBe(255);
    expect(quantizeUnit8Ceil(NaN)).toBe(0);
  });

  it('carries clock times as whole ticks, with Infinity as a sentinel', () => {
    expect(quantizeClockS(Infinity, true)).toBe(WIRE_TIME_INFINITE);
    expect(dequantizeClockS(WIRE_TIME_INFINITE, true)).toBe(Infinity);
    expect(quantizeClockS(Infinity, false)).toBe(WIRE_TIME_INFINITE - 1);
    expect(quantizeClockS(1e9, true)).toBe(WIRE_TIME_INFINITE - 1);
    expect(quantizeClockS(NaN, true)).toBe(0);
    expect(quantizeClockS(-3, true)).toBe(0);
    const seconds = 8 * 60 - 12.34;
    expect(Math.abs(dequantizeClockS(quantizeClockS(seconds, true), true) - seconds)).toBeLessThan(
      TICK_DT_S / 2 + 1e-9,
    );
  });
});
