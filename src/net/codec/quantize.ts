/**
 * Tick wrapping and the quantizers of the wire format. Pure number functions: nothing here
 * allocates, and every quantizer turns NaN into a legal value instead of passing it on.
 *
 * The snapshot and input codecs (`./fast`) repeat the one-line formulas below inline instead of
 * calling these functions: a `number` that crosses a call the JIT did not inline is boxed on the
 * heap, and the hot path must not create garbage. Keep the two in step (the round-trip tests in
 * tests/net/codec-fast.test.ts compare them).
 */

import { BUTTON_MASK, TICK_DT_S, TICK_HZ } from '../../shared';
import type { InputFrame, MutableQuat, Quat } from '../../shared';
import {
  WIRE_POSITION_CENTER_Y_M,
  WIRE_POSITION_STEP_M,
  WIRE_TIME_INFINITE,
  WIRE_VELOCITY_STEP_MPS,
} from '../protocol';

// --- Ticks ---------------------------------------------------------------------------------------
//
// The header carries `tick & 0xFFFF`. At 30 Hz that wraps every 36.4 minutes, so two wire ticks
// are only comparable while they are less than half a wrap (18.2 min) apart, which is always
// true for live traffic.

export const TICK_WRAP = 0x10000;
export const TICK_HALF_WRAP = 0x8000;

/** Full tick -> the 16-bit value that goes on the wire. */
export function wrapTick(tick: number): number {
  return tick & 0xffff;
}

/**
 * Signed distance `a - b` between two wire ticks (or two full ticks: only the low 16 bits
 * count), in [-32768, 32767]. Positive means `a` is newer.
 */
export function tickDiff(a: number, b: number): number {
  return (((a - b) & 0xffff) ^ TICK_HALF_WRAP) - TICK_HALF_WRAP;
}

/** True when wire tick `a` is strictly newer than `b`. */
export function isTickNewer(a: number, b: number): boolean {
  return tickDiff(a, b) > 0;
}

/**
 * Rebuilds the full tick behind a wire tick: the one tick congruent to `wireTick` that lies
 * within half a wrap of `referenceTick` (a full local tick known to be close, such as the
 * host's current tick or the last expanded snapshot tick). The result can be negative when the
 * reference is near 0 and the wire tick is "behind" it.
 */
export function expandTick(wireTick: number, referenceTick: number): number {
  return referenceTick + tickDiff(wireTick, referenceTick);
}

// --- Position ------------------------------------------------------------------------------------

/** Multiply instead of divide, so the inline copies in `./fast` are bit-identical. */
export const POSITION_UNITS_PER_M = 1 / WIRE_POSITION_STEP_M;

/** Metres on a horizontal axis (x or z) -> `i16`. Out-of-range values clamp; NaN becomes 0. */
export function quantizePositionXZ(metres: number): number {
  return Math.max(-32767, Math.min(32767, Math.round(metres * POSITION_UNITS_PER_M))) | 0;
}

export function dequantizePositionXZ(quantized: number): number {
  return quantized * WIRE_POSITION_STEP_M;
}

/** Height in metres -> `i16`, centred on the middle of the flight band. */
export function quantizePositionY(metres: number): number {
  return (
    Math.max(
      -32767,
      Math.min(32767, Math.round((metres - WIRE_POSITION_CENTER_Y_M) * POSITION_UNITS_PER_M)),
    ) | 0
  );
}

export function dequantizePositionY(quantized: number): number {
  return quantized * WIRE_POSITION_STEP_M + WIRE_POSITION_CENTER_Y_M;
}

// --- Velocity ------------------------------------------------------------------------------------

export const VELOCITY_UNITS_PER_MPS = 1 / WIRE_VELOCITY_STEP_MPS;

/** m/s on one axis -> `i8` in [-127, 127]. Faster values clamp; NaN becomes 0. */
export function quantizeVelocity(metresPerSecond: number): number {
  return Math.max(-127, Math.min(127, Math.round(metresPerSecond * VELOCITY_UNITS_PER_MPS))) | 0;
}

export function dequantizeVelocity(quantized: number): number {
  return quantized * WIRE_VELOCITY_STEP_MPS;
}

// --- Steer ---------------------------------------------------------------------------------------

export const STEER_UNITS = 32767;

/** Steer axis in [-1, 1] -> `i16` in [-32767, 32767]. Clamps; NaN becomes 0. */
export function quantizeSteer(value: number): number {
  return Math.max(-32767, Math.min(32767, Math.round(value * STEER_UNITS))) | 0;
}

/** `i16` -> steer axis. -32768 (never produced by the encoder) clamps to -1. */
export function dequantizeSteer(quantized: number): number {
  return Math.max(-1, quantized / STEER_UNITS);
}

/** The value the host will see for this steer input. */
export function snapSteer(value: number): number {
  return dequantizeSteer(quantizeSteer(value));
}

/**
 * Rewrites a frame to exactly what the host decodes from the wire (steer snapped to the `i16`
 * grid, unknown button bits dropped). The client MUST run this on a frame before predicting
 * with it, or its replay uses slightly different inputs than the host did.
 */
export function snapInputFrame(frame: InputFrame): InputFrame {
  frame.steerX = snapSteer(frame.steerX);
  frame.steerY = snapSteer(frame.steerY);
  frame.buttons &= BUTTON_MASK;
  return frame;
}

// --- Fractions and clock -------------------------------------------------------------------------

/** 0..1 -> `u8`, rounded to nearest. */
export function quantizeUnit8(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255))) | 0;
}

/** 0..1 -> `u8`, rounded UP, so anything above 0 stays above 0 (a living dragon's health). */
export function quantizeUnit8Ceil(value: number): number {
  return Math.max(0, Math.min(255, Math.ceil(value * 255))) | 0;
}

export function dequantizeUnit8(quantized: number): number {
  return quantized / 255;
}

/**
 * Seconds -> whole ticks in a `u16`. With `allowInfinite`, Infinity becomes WIRE_TIME_INFINITE;
 * every other value saturates one below it. NaN and negatives become 0.
 */
export function quantizeClockS(seconds: number, allowInfinite: boolean): number {
  if (allowInfinite && seconds === Infinity) return WIRE_TIME_INFINITE;
  return Math.max(0, Math.min(WIRE_TIME_INFINITE - 1, Math.round(seconds * TICK_HZ))) | 0;
}

export function dequantizeClockS(ticks: number, allowInfinite: boolean): number {
  return allowInfinite && ticks === WIRE_TIME_INFINITE ? Infinity : ticks * TICK_DT_S;
}

// --- Orientation: smallest three -----------------------------------------------------------------
//
// A unit quaternion and its negation are the same rotation, so the sign is flipped until the
// component with the largest magnitude is positive. That component is dropped (2 bits say which
// one it was) and rebuilt from the other three, which all lie in [-1/sqrt(2), 1/sqrt(2)] and get
// 10 bits each. The grid has 1023 points so that 0 is exactly representable: level flight and
// the identity round-trip without error.
//
// Worst-case error: 0.275 degrees (all four components near 0.5, where rebuilding the dropped
// one amplifies the error); the mean is about 0.1 degrees. 32 bits cannot do much better: 2^30
// cells over half the 3-sphere bound any encoding to roughly 0.2 degrees worst case.

const QUAT_LEVELS = 1022;
const QUAT_ZERO = QUAT_LEVELS / 2;
/** Grid units per unit of component value: 511 / (1/sqrt(2)). */
const QUAT_SCALE = QUAT_ZERO * Math.SQRT2;
const QUAT_UNSCALE = 1 / QUAT_SCALE;
const QUAT_MASK = 0x3ff;
/** Packed identity (largest = w, the rest 0). */
export const PACKED_QUAT_IDENTITY =
  ((3 << 30) | (QUAT_ZERO << 20) | (QUAT_ZERO << 10) | QUAT_ZERO) >>> 0;

/**
 * Packs `q` into the `u32` at `offset` (little-endian). `q` does not have to be normalised; a
 * zero-length or non-finite one is written as the identity. Takes the object rather than four
 * numbers so no float crosses a call boundary (see the note at the top of the file).
 */
export function writeQuat(view: DataView, offset: number, q: Quat): void {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  const lengthSq = x * x + y * y + z * z + w * w;
  // `!(> 1e-12)` also catches NaN.
  if (!(lengthSq > 1e-12) || lengthSq === Infinity) {
    view.setUint32(offset, PACKED_QUAT_IDENTITY, true);
    return;
  }
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const aw = Math.abs(w);

  let index = 3;
  let largest = w;
  let largestAbs = aw;
  if (ax > largestAbs) {
    index = 0;
    largest = x;
    largestAbs = ax;
  }
  if (ay > largestAbs) {
    index = 1;
    largest = y;
    largestAbs = ay;
  }
  if (az > largestAbs) {
    index = 2;
    largest = z;
  }

  // Normalise, make the dropped component positive and scale to grid units in one factor.
  const scale = ((largest < 0 ? -1 : 1) / Math.sqrt(lengthSq)) * QUAT_SCALE;
  const a = index === 0 ? y : x;
  const b = index <= 1 ? z : y;
  const c = index === 3 ? z : w;
  const qa = Math.max(0, Math.min(QUAT_LEVELS, Math.round(a * scale) + QUAT_ZERO)) | 0;
  const qb = Math.max(0, Math.min(QUAT_LEVELS, Math.round(b * scale) + QUAT_ZERO)) | 0;
  const qc = Math.max(0, Math.min(QUAT_LEVELS, Math.round(c * scale) + QUAT_ZERO)) | 0;
  // Two u16 writes: every intermediate stays a small integer.
  view.setUint16(offset, ((qb & 0x3f) << 10) | qc, true);
  view.setUint16(offset + 2, (index << 14) | (qa << 4) | (qb >> 6), true);
}

/**
 * Unpacks the `u32` at `offset` into a unit quaternion. Every bit pattern gives a finite,
 * normalised result.
 */
export function readQuat(view: DataView, offset: number, out: MutableQuat): MutableQuat {
  const low = view.getUint16(offset, true);
  const high = view.getUint16(offset + 2, true);
  const index = high >> 14;
  let a = (((high >> 4) & QUAT_MASK) - QUAT_ZERO) * QUAT_UNSCALE;
  let b = ((((high & 0xf) << 6) | (low >> 10)) - QUAT_ZERO) * QUAT_UNSCALE;
  let c = ((low & QUAT_MASK) - QUAT_ZERO) * QUAT_UNSCALE;
  const sumSq = a * a + b * b + c * c;
  let d = 0;
  if (sumSq < 1) {
    d = Math.sqrt(1 - sumSq);
  } else {
    // Only garbage input gets here (the three smallest of a unit quaternion sum to <= 0.75).
    const inverse = 1 / Math.sqrt(sumSq);
    a *= inverse;
    b *= inverse;
    c *= inverse;
  }
  if (index === 0) {
    out.x = d;
    out.y = a;
    out.z = b;
    out.w = c;
  } else if (index === 1) {
    out.x = a;
    out.y = d;
    out.z = b;
    out.w = c;
  } else if (index === 2) {
    out.x = a;
    out.y = b;
    out.z = d;
    out.w = c;
  } else {
    out.x = a;
    out.y = b;
    out.z = c;
    out.w = d;
  }
  return out;
}

const SCRATCH_VIEW = new DataView(new ArrayBuffer(4));
const SCRATCH_QUAT: MutableQuat = { x: 0, y: 0, z: 0, w: 1 };

/** Convenience form of `writeQuat` for tools and tests: returns the packed `u32`. */
export function packQuat(x: number, y: number, z: number, w: number): number {
  SCRATCH_QUAT.x = x;
  SCRATCH_QUAT.y = y;
  SCRATCH_QUAT.z = z;
  SCRATCH_QUAT.w = w;
  writeQuat(SCRATCH_VIEW, 0, SCRATCH_QUAT);
  return SCRATCH_VIEW.getUint32(0, true);
}

/** Convenience form of `readQuat`: unpacks a `u32` value. */
export function unpackQuat(packed: number, out: MutableQuat): MutableQuat {
  SCRATCH_VIEW.setUint32(0, packed, true);
  return readQuat(SCRATCH_VIEW, 0, out);
}
