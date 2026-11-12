/**
 * The camera of the results show, as a pure function of the show clock (site frame):
 *
 * - a wide, low shot from in front of the podium, pushing in slowly, while the formation comes
 *   out of the sky toward it and leaves over the top of the frame;
 * - a move round to a three-quarter view from the sun's side for the landings;
 * - a slow drift further round and in for the hold.
 *
 * The steps stay in the middle band of the picture (the award cards and the scoreboard take
 * the left and right edges and the bottom). With reduced motion: two still shots and one cut.
 *
 * Allocation-free.
 */
import {
  CAM_DRIFT_BEARING,
  CAM_DRIFT_DISTANCE,
  CAM_DRIFT_Y,
  CAM_PODIUM_AIM,
  CAM_PODIUM_BEARING,
  CAM_PODIUM_DISTANCE,
  CAM_PODIUM_FOV,
  CAM_PODIUM_SHIFT,
  CAM_PODIUM_Y,
  CAM_WIDE_AIM,
  CAM_WIDE_FOV,
  CAM_WIDE_FROM,
  CAM_WIDE_TO,
} from './podium-layout';
import { clamp01, lerp, smoothBetween } from './podium-math';
import {
  CAMERA_CUT_S,
  CAMERA_MOVE_END_S,
  CAMERA_MOVE_START_S,
  SHOW_S,
} from './podium-timeline';

/** Camera position, the point it looks at (site frame) and its vertical field of view. */
export interface ShowCamera {
  x: number;
  y: number;
  z: number;
  aimX: number;
  aimY: number;
  aimZ: number;
  fov: number;
}

export function createShowCamera(): ShowCamera {
  return { x: 0, y: 0, z: 0, aimX: 0, aimY: 0, aimZ: 0, fov: CAM_WIDE_FOV };
}

/** How far the wide shot tilts up after the formation as it comes close, metres at the aim. */
const WIDE_TILT_M = 4;

export function writeShowCamera(
  out: ShowCamera,
  tS: number,
  mirror: number,
  reduceMotion: boolean,
): ShowCamera {
  const t = tS > 0 ? tS : 0;
  // With reduced motion each shot stands still on its first frame.
  const wideT = reduceMotion ? 0 : t;
  const podiumT = reduceMotion ? CAMERA_MOVE_START_S : t;

  // The wide shot keeps pushing in until the move is over, so the two blend without a stop.
  const push = clamp01(wideT / CAMERA_MOVE_END_S);
  const wideX = lerp(CAM_WIDE_FROM[0] ?? 0, CAM_WIDE_TO[0] ?? 0, push);
  const wideY = lerp(CAM_WIDE_FROM[1] ?? 0, CAM_WIDE_TO[1] ?? 0, push);
  const wideZ = lerp(CAM_WIDE_FROM[2] ?? 0, CAM_WIDE_TO[2] ?? 0, push);
  const wideAimY = (CAM_WIDE_AIM[1] ?? 0) + WIDE_TILT_M * smoothBetween(1.2, 3.6, wideT);

  // The podium shot drifts from the moment the move starts, for the same reason.
  const drift = clamp01((podiumT - CAMERA_MOVE_START_S) / (SHOW_S - CAMERA_MOVE_START_S));
  const bearing = CAM_PODIUM_BEARING + CAM_DRIFT_BEARING * drift;
  const distance = CAM_PODIUM_DISTANCE + CAM_DRIFT_DISTANCE * drift;
  const podiumX = Math.sin(bearing) * distance;
  const podiumY = CAM_PODIUM_Y + CAM_DRIFT_Y * drift;
  const podiumZ = Math.cos(bearing) * distance;
  // Aim to the camera's right of the steps. On a mirrored site the camera stands on the other
  // side, and its right is the other way round: the mirror below turns X, this turns it back.
  const aimX = (CAM_PODIUM_AIM[0] ?? 0) + Math.cos(bearing) * CAM_PODIUM_SHIFT * mirror;
  const aimZ = (CAM_PODIUM_AIM[2] ?? 0) - Math.sin(bearing) * CAM_PODIUM_SHIFT * mirror;

  const blend = reduceMotion
    ? t < CAMERA_CUT_S
      ? 0
      : 1
    : smoothBetween(CAMERA_MOVE_START_S, CAMERA_MOVE_END_S, t);
  out.x = lerp(wideX, podiumX, blend) * mirror;
  out.y = lerp(wideY, podiumY, blend);
  out.z = lerp(wideZ, podiumZ, blend);
  out.aimX = lerp(CAM_WIDE_AIM[0] ?? 0, aimX, blend) * mirror;
  out.aimY = lerp(wideAimY, CAM_PODIUM_AIM[1] ?? 0, blend);
  out.aimZ = lerp(CAM_WIDE_AIM[2] ?? 0, aimZ, blend);
  out.fov = lerp(CAM_WIDE_FOV, CAM_PODIUM_FOV, blend);
  return out;
}
