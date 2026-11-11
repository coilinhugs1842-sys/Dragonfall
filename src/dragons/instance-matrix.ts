/** Pure transform helper for instanced dragons (node-testable, allocation-free). */

import type { Quat, Vec3 } from '../shared';

/**
 * Writes the column-major 4x4 of `translate(position) * rotate(orientation)` (unit scale) to
 * `out[offset..offset + 15]`: the layout of `InstancedMesh.instanceMatrix`, identical to
 * `Matrix4.compose` with a scale of 1. `orientation` must be a unit quaternion.
 */
export function writeInstanceMatrix(
  out: { [index: number]: number },
  offset: number,
  position: Vec3,
  orientation: Quat,
): void {
  const x = orientation.x;
  const y = orientation.y;
  const z = orientation.z;
  const w = orientation.w;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  out[offset] = 1 - (yy + zz);
  out[offset + 1] = xy + wz;
  out[offset + 2] = xz - wy;
  out[offset + 3] = 0;
  out[offset + 4] = xy - wz;
  out[offset + 5] = 1 - (xx + zz);
  out[offset + 6] = yz + wx;
  out[offset + 7] = 0;
  out[offset + 8] = xz + wy;
  out[offset + 9] = yz - wx;
  out[offset + 10] = 1 - (xx + yy);
  out[offset + 11] = 0;
  out[offset + 12] = position.x;
  out[offset + 13] = position.y;
  out[offset + 14] = position.z;
  out[offset + 15] = 1;
}
