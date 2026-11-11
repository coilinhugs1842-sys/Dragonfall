/**
 * A minimal course-holding pilot: steer a dragon onto a circle around the arena centre at a
 * given altitude. Two users: the host flies a disconnected rider's dragon with it while the slot
 * is held (a dragon left alone flies straight into the storm wall in about 20 s), and the
 * net-bots build their "random but sane" flight on top of it.
 *
 * It reads only position, yaw and pitch, which both the sim's `DragonState` and a snapshot's
 * owner block carry. Allocation-free.
 */

import type { InputFrame, Vec3 } from '../../shared';

/** What the pilot reads of a dragon. `DragonState` and `SnapshotOwner` both fit. */
export interface PilotSubject {
  readonly position: Vec3;
  /** Heading about +Y; 0 faces +Z, a right turn lowers it. */
  readonly yaw: number;
  /** Nose angle above the horizon. */
  readonly pitch: number;
}

export interface PilotCourse {
  centerX: number;
  centerZ: number;
  /** Radius of the circle flown, metres. */
  radius: number;
  altitude: number;
  /**
   * Added to the wanted heading and pitch (radians): the bots weave with these. They are fields
   * and not arguments because a float passed to a function that is not inlined gets boxed.
   */
  yawBias: number;
  pitchBias: number;
}

const TWO_PI = Math.PI * 2;
const YAW_GAIN = 1.6;
const PITCH_GAIN = 1.6;
/** Metres off the circle at which the pilot heads straight back to it. */
const RADIAL_CAPTURE = 250;
const ALTITUDE_GAIN = 0.004;
const MAX_ALTITUDE_PITCH = 0.3;

function clampUnit(value: number): number {
  if (!(value >= -1)) return value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}

function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

/**
 * Writes the steer that takes `subject` onto `course` into `out` (buttons and tick are left
 * alone).
 */
export function steerToCourse(
  subject: PilotSubject,
  course: Readonly<PilotCourse>,
  out: InputFrame,
): InputFrame {
  const position = subject.position;
  let radialX = position.x - course.centerX;
  let radialZ = position.z - course.centerZ;
  const distance = Math.sqrt(radialX * radialX + radialZ * radialZ);
  if (distance > 1e-3) {
    radialX /= distance;
    radialZ /= distance;
  } else {
    radialX = 0;
    radialZ = -1;
  }
  const inward = clampUnit((distance - course.radius) / RADIAL_CAPTURE);
  // Tangent of a circle flown with the centre on the dragon's right, leaning back toward it.
  const wantX = -radialZ - radialX * inward * 1.5;
  const wantZ = radialX - radialZ * inward * 1.5;
  const yawError = wrapAngle(Math.atan2(wantX, wantZ) + course.yawBias - subject.yaw);
  // A right turn lowers yaw, and steerX > 0 turns right.
  out.steerX = clampUnit(-yawError * YAW_GAIN);

  const wantPitch =
    clampUnit(((course.altitude - position.y) * ALTITUDE_GAIN) / MAX_ALTITUDE_PITCH) *
      MAX_ALTITUDE_PITCH +
    course.pitchBias;
  out.steerY = clampUnit((wantPitch - subject.pitch) * PITCH_GAIN);
  return out;
}
