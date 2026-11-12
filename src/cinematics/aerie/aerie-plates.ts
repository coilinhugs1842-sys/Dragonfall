/**
 * Where the lobby's name cards go: a point above each occupied perch, projected to the screen.
 * The UI owns the cards; this only does the arithmetic, by hand on the matrices' numbers so
 * nothing is allocated per frame.
 */
import type { PerspectiveCamera } from 'three';
import type { Vec3 } from '../../shared';
import type { AerieLayout } from './aerie-layout';
import { CAST_ARRIVING, CAST_HOPPING, CAST_LAUNCHING, CAST_PERCHED } from './aerie-cast';
import type { AerieCast } from './aerie-cast';
import type { MutableLobbyPlate } from '../types';

/** Metres from the perch stone up to the card's anchor: clear of a rearing dragon's head. */
export const PLATE_HEIGHT = 6.4;

/**
 * Projects a world point with the camera's current matrices (`matrixWorldInverse` and
 * `projectionMatrix` must be up to date: the stage refreshes them after the director runs).
 * Writes viewport fractions from the top-left into `out.x` / `out.y`; returns false, and
 * leaves the fractions unclamped, when the point is behind the camera or off the screen.
 */
export function projectToViewport(
  camera: PerspectiveCamera,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number },
): boolean {
  const v = camera.matrixWorldInverse.elements;
  const p = camera.projectionMatrix.elements;
  // Column-major: element [column * 4 + row].
  const vx = (v[0] ?? 0) * x + (v[4] ?? 0) * y + (v[8] ?? 0) * z + (v[12] ?? 0);
  const vy = (v[1] ?? 0) * x + (v[5] ?? 0) * y + (v[9] ?? 0) * z + (v[13] ?? 0);
  const vz = (v[2] ?? 0) * x + (v[6] ?? 0) * y + (v[10] ?? 0) * z + (v[14] ?? 0);
  const cx = (p[0] ?? 0) * vx + (p[4] ?? 0) * vy + (p[8] ?? 0) * vz + (p[12] ?? 0);
  const cy = (p[1] ?? 0) * vx + (p[5] ?? 0) * vy + (p[9] ?? 0) * vz + (p[13] ?? 0);
  const cw = (p[3] ?? 0) * vx + (p[7] ?? 0) * vy + (p[11] ?? 0) * vz + (p[15] ?? 0);
  if (cw <= 1e-4) {
    // Behind the lens: park the card off screen rather than divide by nothing.
    out.x = -1;
    out.y = -1;
    return false;
  }
  const nx = cx / cw;
  const ny = cy / cw;
  out.x = nx * 0.5 + 0.5;
  out.y = 0.5 - ny * 0.5;
  return nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
}

/**
 * Fills `out` with one plate per rider that has a perch, and returns how many. `out` is a pool:
 * it grows (once) to the number of riders and its entries are reused after that.
 * `usualEye` is where the wide shot stands: `scale` is 1 for a card seen from there and grows
 * as the camera closes in.
 */
export function writeAeriePlates(
  camera: PerspectiveCamera,
  cast: AerieCast,
  layout: AerieLayout,
  usualEye: Vec3,
  out: MutableLobbyPlate[],
): number {
  const members = cast.members;
  const eye = camera.matrixWorld.elements;
  const ex = eye[12] ?? 0;
  const ey = eye[13] ?? 0;
  const ez = eye[14] ?? 0;
  let count = 0;
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (member === undefined) continue;
    const state = member.state;
    const waiting = state === CAST_LAUNCHING && cast.launchTimeS <= member.launchDelayS;
    // A card belongs to a perch with a rider on it or on the way to it; a dragon that has
    // taken off for the match, or is leaving, has none.
    if (state !== CAST_ARRIVING && state !== CAST_PERCHED && state !== CAST_HOPPING && !waiting) {
      continue;
    }
    const perch = layout.perches[member.slot];
    if (perch === undefined) continue;
    let plate = out[count];
    if (plate === undefined) {
      plate = { playerId: member.playerId, x: 0, y: 0, scale: 1, visible: false };
      out.push(plate);
    }
    const ax = perch.position.x;
    const ay = perch.position.y + PLATE_HEIGHT;
    const az = perch.position.z;
    plate.playerId = member.playerId;
    plate.visible = projectToViewport(camera, ax, ay, az, plate);
    const usual = Math.hypot(ax - usualEye.x, ay - usualEye.y, az - usualEye.z);
    const now = Math.hypot(ax - ex, ay - ey, az - ez);
    plate.scale = now > 1e-3 ? usual / now : 1;
    count++;
  }
  return count;
}
