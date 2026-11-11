/**
 * `?autopilot`: a scripted pilot that writes the local InputFrame instead of the mouse and
 * keyboard, so headless screenshots and soak tests show real flight without pointer lock.
 *
 * It flies a wide circle round the arena centre at a fixed altitude with a gentle weave, and on
 * a fixed timetable boosts, flaps, folds into a short dive and barrel-rolls. It does NOT avoid
 * terrain: a pillar in the way is hit, which is part of what a soak test should exercise.
 *
 * Deterministic: the frame is a pure function of the tick and the dragon's position and
 * velocity (both sim state), with no clock and no randomness. Allocation-free.
 */

import {
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_DODGE_RIGHT,
  BUTTON_FLAP,
  TICK_HZ,
} from '../shared';
import type { InputFrame, Vec3 } from '../shared';

/** What the pilot reads of its dragon; the sim's DragonState and a DragonView both fit. */
export interface AutopilotSubject {
  readonly position: Vec3;
  readonly velocity: Vec3;
}

export interface AutopilotCourse {
  /** Centre of the circle, world XZ. */
  readonly centerX: number;
  readonly centerZ: number;
  /** Metres. */
  readonly radius: number;
  readonly altitude: number;
}

/** The timetable repeats after this many ticks (24 s). */
export const AUTOPILOT_CYCLE_TICKS = 24 * TICK_HZ;

const TWO_PI = Math.PI * 2;
/** Steer per radian of heading / pitch error. */
const YAW_GAIN = 1.6;
const PITCH_GAIN = 1.6;
/** Metres off the circle at which the pilot heads straight back to it. */
const RADIAL_CAPTURE = 250;
/** Radians of climb or dive asked for per metre of altitude error, and the most it asks for. */
const ALTITUDE_GAIN = 0.004;
const MAX_ALTITUDE_PITCH = 0.25;
const WEAVE_YAW = 0.22;
const WEAVE_YAW_PERIOD_TICKS = 7 * TICK_HZ;
const WEAVE_PITCH = 0.1;
const WEAVE_PITCH_PERIOD_TICKS = 4.5 * TICK_HZ;

// Timetable, in ticks from the start of a cycle.
const BOOST_START = 5 * TICK_HZ;
const BOOST_END = 7.5 * TICK_HZ;
const FLAP_START = 10 * TICK_HZ;
const FLAP_END = 11.5 * TICK_HZ;
const DODGE_RIGHT_TICK = 13 * TICK_HZ;
const DIVE_START = 16 * TICK_HZ;
const DIVE_END = 17.2 * TICK_HZ;
const DODGE_LEFT_TICK = 21 * TICK_HZ;

function clampUnit(value: number): number {
  if (!(value >= -1)) return value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}

function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

/**
 * Writes the pilot's input for `tick` into `out` (a reused frame). With no dragon (not spawned
 * yet) the frame is neutral.
 */
export function writeAutopilotFrame(
  tick: number,
  subject: AutopilotSubject | undefined,
  course: AutopilotCourse,
  out: InputFrame,
): InputFrame {
  out.tick = tick;
  out.steerX = 0;
  out.steerY = 0;
  out.buttons = 0;
  if (subject === undefined) return out;

  const { position, velocity } = subject;
  const speed = Math.sqrt(
    velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
  );
  if (!(speed > 1e-3) || !Number.isFinite(speed)) return out;

  // --- Heading: along the circle, leaning back toward it when off it ----------------------------
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
  // Tangent of a circle flown with the centre on the dragon's right.
  const wantX = -radialZ - radialX * inward * 1.5;
  const wantZ = radialX - radialZ * inward * 1.5;
  const yawError = wrapAngle(Math.atan2(wantX, wantZ) - Math.atan2(velocity.x, velocity.z));
  const weaveYaw = WEAVE_YAW * Math.sin((tick / WEAVE_YAW_PERIOD_TICKS) * TWO_PI);
  // A right turn lowers yaw, and steerX > 0 turns right.
  out.steerX = clampUnit(-yawError * YAW_GAIN + weaveYaw);

  // --- Pitch: hold the altitude, with a slow porpoise -------------------------------------------
  const pitch = Math.asin(clampUnit(velocity.y / speed));
  const wantPitch =
    clampUnit(((course.altitude - position.y) * ALTITUDE_GAIN) / MAX_ALTITUDE_PITCH) *
      MAX_ALTITUDE_PITCH +
    WEAVE_PITCH * Math.sin((tick / WEAVE_PITCH_PERIOD_TICKS) * TWO_PI);
  out.steerY = clampUnit((wantPitch - pitch) * PITCH_GAIN);

  // --- Timetable --------------------------------------------------------------------------------
  const phase = ((tick % AUTOPILOT_CYCLE_TICKS) + AUTOPILOT_CYCLE_TICKS) % AUTOPILOT_CYCLE_TICKS;
  let buttons = 0;
  if (phase >= BOOST_START && phase < BOOST_END) buttons |= BUTTON_BOOST;
  if (phase >= FLAP_START && phase < FLAP_END) buttons |= BUTTON_FLAP;
  if (phase === DODGE_RIGHT_TICK) buttons |= BUTTON_DODGE_RIGHT;
  if (phase >= DIVE_START && phase < DIVE_END) {
    buttons |= BUTTON_DIVE;
    // Hands off the stick while folded, so the dive is a real dive.
    out.steerY = 0;
  }
  if (phase === DODGE_LEFT_TICK) buttons |= BUTTON_DODGE_LEFT;
  out.buttons = buttons;
  return out;
}
