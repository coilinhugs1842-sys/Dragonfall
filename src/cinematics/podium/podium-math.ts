/**
 * Small pure helpers of the results podium: easing, angles and the dragon's yaw / pitch / roll
 * as a quaternion. No three.js, no allocation: everything writes into the caller's object.
 *
 * (`src/cinematics/camera-math.ts` was still being written when this was; the few lines the
 * podium needs live here so the two do not depend on each other.)
 */
import type { MutableQuat } from '../../shared';

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0..1 with zero slope at both ends. */
export function smooth01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** `smooth01` of where `value` lies between `from` and `to`. */
export function smoothBetween(from: number, to: number, value: number): number {
  return smooth01((value - from) / (to - from));
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
 * A cheap repeatable 0..1 number per (index, salt): the per-dragon variety of the show (bob
 * phase, a little height) has to be the same in every browser, so nothing here is random.
 */
export function hash01(index: number, salt: number): number {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
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
