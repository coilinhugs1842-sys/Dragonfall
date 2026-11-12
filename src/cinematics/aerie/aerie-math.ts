/**
 * Small pure helpers the aerie shares: easing, a closed spline and the dragon's yaw / pitch /
 * roll as a quaternion. No three.js, no allocation: everything writes into the caller's object.
 *
 * (The shared spline helpers of `src/cinematics/camera-math.ts` were still being written when
 * this was; the few lines the aerie needs live here so the two do not depend on each other.)
 */
import type { MutableQuat, MutableVec3 } from '../../shared';

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0..1 with zero slope at both ends. */
export function smooth01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** 0..1 that starts fast and comes to rest (a dragon braking onto its perch). */
export function easeOut01(t: number): number {
  const x = 1 - clamp01(t);
  return 1 - x * x * x;
}

/** 0..1 that starts from rest and keeps accelerating (a take-off). */
export function easeIn01(t: number): number {
  const x = clamp01(t);
  return x * x;
}

/** Frame-rate independent approach of `current` to `target`; `rate` is per second. */
export function approach(current: number, target: number, rate: number, dtS: number): number {
  return target + (current - target) * Math.exp(-rate * dtS);
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle - twoPi * Math.floor((angle + Math.PI) / twoPi);
  if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

/** Interpolates two headings the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/**
 * The dragon's orientation from a heading (0 = facing +Z, turning toward +X), a pitch (positive
 * = nose up) and a roll (positive = right wing down): `Ry(yaw) * Rx(-pitch) * Rz(roll)`, the
 * same order the sim uses.
 */
export function writeYawPitchRoll(
  out: MutableQuat,
  yaw: number,
  pitch: number,
  roll: number,
): MutableQuat {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cx = Math.cos(-pitch * 0.5);
  const sx = Math.sin(-pitch * 0.5);
  const cz = Math.cos(roll * 0.5);
  const sz = Math.sin(roll * 0.5);
  const x = cy * sx;
  const y = sy * cx;
  const z = -sy * sx;
  const w = cy * cx;
  out.x = x * cz + y * sz;
  out.y = y * cz - x * sz;
  out.z = w * sz + z * cz;
  out.w = w * cz - z * sz;
  return out;
}

/**
 * A point on a cubic Hermite curve from `p0` (leaving along `t0`) to `p1` (arriving along
 * `t1`), `u` in 0..1. The tangents are in metres per unit of `u`.
 */
export function writeHermite(
  out: MutableVec3,
  p0x: number,
  p0y: number,
  p0z: number,
  t0x: number,
  t0y: number,
  t0z: number,
  p1x: number,
  p1y: number,
  p1z: number,
  t1x: number,
  t1y: number,
  t1z: number,
  u: number,
): MutableVec3 {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  out.x = h00 * p0x + h10 * t0x + h01 * p1x + h11 * t1x;
  out.y = h00 * p0y + h10 * t0y + h01 * p1y + h11 * t1y;
  out.z = h00 * p0z + h10 * t0z + h01 * p1z + h11 * t1z;
  return out;
}

/**
 * A point on a CLOSED Catmull-Rom spline through `points` (x, y, z triples). `t` is in laps: 0
 * and 1 are the first point, and it wraps, so a slowly growing clock drifts round for ever.
 */
export function writeClosedSpline(out: MutableVec3, points: ArrayLike<number>, t: number): MutableVec3 {
  const count = Math.floor(points.length / 3);
  if (count === 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  const lap = (t - Math.floor(t)) * count;
  const segment = Math.floor(lap) % count;
  const u = lap - Math.floor(lap);
  const i0 = ((segment + count - 1) % count) * 3;
  const i1 = segment * 3;
  const i2 = ((segment + 1) % count) * 3;
  const i3 = ((segment + 2) % count) * 3;
  const u2 = u * u;
  const u3 = u2 * u;
  // Uniform Catmull-Rom basis.
  const b0 = -0.5 * u3 + u2 - 0.5 * u;
  const b1 = 1.5 * u3 - 2.5 * u2 + 1;
  const b2 = -1.5 * u3 + 2 * u2 + 0.5 * u;
  const b3 = 0.5 * u3 - 0.5 * u2;
  out.x =
    b0 * (points[i0] ?? 0) + b1 * (points[i1] ?? 0) + b2 * (points[i2] ?? 0) + b3 * (points[i3] ?? 0);
  out.y =
    b0 * (points[i0 + 1] ?? 0) +
    b1 * (points[i1 + 1] ?? 0) +
    b2 * (points[i2 + 1] ?? 0) +
    b3 * (points[i3 + 1] ?? 0);
  out.z =
    b0 * (points[i0 + 2] ?? 0) +
    b1 * (points[i1 + 2] ?? 0) +
    b2 * (points[i2 + 2] ?? 0) +
    b3 * (points[i3 + 2] ?? 0);
  return out;
}
