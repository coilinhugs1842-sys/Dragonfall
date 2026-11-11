/**
 * Plain vector shapes for the contracts. They are structurally compatible with three.js
 * `Vector3`/`Quaternion` (so views can `vec.copy(view.position)`), but this file must never
 * import three.js: sim, net and a future Web Worker depend on it.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** Writable variants, for the owners of pooled objects (sim, WorldView builder). */
export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

export interface MutableQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function createVec3(x = 0, y = 0, z = 0): MutableVec3 {
  return { x, y, z };
}

/** Defaults to the identity rotation. */
export function createQuat(x = 0, y = 0, z = 0, w = 1): MutableQuat {
  return { x, y, z, w };
}

export function copyVec3(out: MutableVec3, from: Vec3): MutableVec3 {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  return out;
}

export function copyQuat(out: MutableQuat, from: Quat): MutableQuat {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  out.w = from.w;
  return out;
}
