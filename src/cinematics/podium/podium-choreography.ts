/**
 * The moves of the results show: where one dragon is, how it is turned and which clip it plays
 * at a given moment. A pure function of the show clock and the plan (podium-cast.ts): no state
 * is carried from frame to frame, so a browser that joins late, a paused tab and a replayed
 * frame all get the same picture.
 *
 * Everything is in the site frame (podium-layout.ts); podium.ts turns it into world space.
 * Three moves, in this order for a dragon that has all of them:
 *
 * 1. THE PASS: every dragon of a V flies the same curve, a row behind the next (as a delay) and
 *    out to its side, banking with the curve's turn.
 * 2. Waiting out of the picture where its dive (or climb) starts, until its start time.
 * 3. THE ARRIVAL: one straight, strongly braked line to its step or to its place in a hover
 *    arc, facing the camera all the way. The award winners start `land` so the clip's touchdown
 *    meets the stone; the MVP first stops in the air over its step and roars, then lands.
 *
 * Allocation-free.
 */
import {
  DRAGON_ANIM_BANK_L,
  DRAGON_ANIM_BANK_R,
  DRAGON_ANIM_DIVE,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_ANIM_HOVER,
  DRAGON_ANIM_LAND,
  DRAGON_ANIM_ROAR,
} from '../../shared';
import type { DragonAnimState, DragonClassId } from '../../shared';
import type { PodiumPlan } from './podium-cast';
import {
  ARC_APPROACH_SIDE,
  ARC_APPROACH_Y,
  ARC_APPROACH_Z,
  ARC_BEARING,
  ARC_RADIUS,
  ARC_STAGGER_Y,
  ARC_TURN_IN,
  ARC_WINNERS,
  ARC_Y,
  PASS_GROUP_UP,
  PASS_P0,
  PASS_P1,
  PASS_P2,
  PASS_ROW_SIDE,
  PASS_ROW_UP,
  ROAR_HOVER_M,
  SEAT_APPROACH_X,
  SEAT_APPROACH_Y,
  SEAT_APPROACH_Z,
  SEAT_HEADING,
  SEAT_MVP,
  SEAT_TOP_Y,
  SEAT_X,
  SEAT_Z,
  perchDrop,
} from './podium-layout';
import { clamp, clamp01, hash01, lerpAngle, smooth01, smoothBetween } from './podium-math';
import {
  HOVER_APPROACH_S,
  LAND_LEAD_S,
  MVP_APPROACH_S,
  PASS_S,
  ROAR_LEAD_S,
  ROAR_S,
  SEAT_APPROACH_S,
} from './podium-timeline';

/** One dragon at one moment, in the site frame. */
export interface PuppetPose {
  x: number;
  y: number;
  z: number;
  /** Metres per second. */
  vx: number;
  vy: number;
  vz: number;
  /** Radians: 0 faces the camera (+Z), positive turns toward +X. */
  heading: number;
  /** Radians, nose up positive. */
  pitch: number;
  /** Radians, right wing down positive. */
  roll: number;
  anim: DragonAnimState;
}

export function createPuppetPose(): PuppetPose {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, heading: 0, pitch: 0, roll: 0, anim: DRAGON_ANIM_HOVER };
}

/** How much harder than a coordinated turn the formation banks: it has to read from 150 m. */
const BANK_GAIN = 1.2;
const GRAVITY = 9.81;
/** Exponents of the braking curves `(1 - u)^p`: the higher, the faster the start of the line. */
const SEAT_BRAKE = 2.4;
const HOVER_BRAKE = 2;
/** The hoverers' idle: metres of bob and sway, and their rates in radians per second. */
const BOB_M = 0.55;
const BOB_RATE = 1.35;
const SWAY_M = 0.4;
const SWAY_RATE = 0.8;

function writePass(out: PuppetPose, plan: PodiumPlan, index: number, tS: number, mirror: number): void {
  const row = plan.passRow[index] ?? 0;
  const side = plan.passSide[index] ?? 0;
  const group = plan.passGroup[index] ?? 0;
  const u = (tS - (plan.passDelayS[index] ?? 0)) / PASS_S;
  // Outside 0..1 the curve goes on straight along its end tangent.
  const k = clamp01(u);
  const a = (1 - k) * (1 - k);
  const b = 2 * k * (1 - k);
  const c = k * k;
  const p0x = (PASS_P0[0] ?? 0) * mirror;
  const p1x = (PASS_P1[0] ?? 0) * mirror;
  const p2x = (PASS_P2[0] ?? 0) * mirror;
  const p0y = PASS_P0[1] ?? 0;
  const p1y = PASS_P1[1] ?? 0;
  const p2y = PASS_P2[1] ?? 0;
  const p0z = PASS_P0[2] ?? 0;
  const p1z = PASS_P1[2] ?? 0;
  const p2z = PASS_P2[2] ?? 0;
  // First derivative (per unit of u) and the constant second one.
  const dx = 2 * (1 - k) * (p1x - p0x) + 2 * k * (p2x - p1x);
  const dy = 2 * (1 - k) * (p1y - p0y) + 2 * k * (p2y - p1y);
  const dz = 2 * (1 - k) * (p1z - p0z) + 2 * k * (p2z - p1z);
  const ddx = 2 * (p2x - 2 * p1x + p0x);
  const ddz = 2 * (p2z - 2 * p1z + p0z);
  const over = u - k;
  const flat = Math.hypot(dx, dz) || 1;
  // The dragon's own left (+X when it faces +Z), level.
  const leftX = dz / flat;
  const leftZ = -dx / flat;
  const sideways = side * row * PASS_ROW_SIDE;
  // A little life: each wingman rides the air on its own.
  const id = plan.ids[index] ?? 0;
  const ride = Math.sin(tS * 1.7 + hash01(id, 3) * 6.2832) * 0.5 * (row > 0 ? 1 : 0.4);
  out.x = a * p0x + b * p1x + c * p2x + dx * over + leftX * sideways;
  out.y = a * p0y + b * p1y + c * p2y + dy * over + row * PASS_ROW_UP + group * PASS_GROUP_UP + ride;
  out.z = a * p0z + b * p1z + c * p2z + dz * over + leftZ * sideways;
  out.vx = dx / PASS_S;
  out.vy = dy / PASS_S;
  out.vz = dz / PASS_S;
  out.heading = Math.atan2(dx, dz);
  out.pitch = Math.atan2(dy, flat);
  // Bank with the turn, rolling in over the first stretch and level again before the camera.
  const turnRate = (dz * ddx - dx * ddz) / (flat * flat) / PASS_S;
  const speed = flat / PASS_S;
  const envelope = smoothBetween(0, 0.14, u) * (1 - smoothBetween(0.6, 0.9, u));
  out.roll = -BANK_GAIN * Math.atan((speed * turnRate) / GRAVITY) * envelope;
  out.anim =
    u < 0.1 + row * 0.03
      ? DRAGON_ANIM_FLAP
      : out.roll > 0.2
        ? DRAGON_ANIM_BANK_R
        : out.roll < -0.2
          ? DRAGON_ANIM_BANK_L
          : DRAGON_ANIM_GLIDE;
}

/**
 * One braked line from `end + offset` to `end`: position, velocity and the heading of travel.
 * `u` is 0..1 along it in time; before 0 the dragon waits at the far end.
 */
function writeLine(
  out: PuppetPose,
  endX: number,
  endY: number,
  endZ: number,
  offX: number,
  offY: number,
  offZ: number,
  u: number,
  durationS: number,
  brake: number,
): void {
  const k = clamp01(u);
  const left = Math.pow(1 - k, brake);
  // d(left)/dt: zero while waiting and once there.
  const rate = u > 0 && u < 1 ? (-brake * Math.pow(1 - k, brake - 1)) / durationS : 0;
  out.x = endX + offX * left;
  out.y = endY + offY * left;
  out.z = endZ + offZ * left;
  out.vx = offX * rate;
  out.vy = offY * rate;
  out.vz = offZ * rate;
  out.heading = Math.atan2(-offX, -offZ);
  out.roll = 0;
}

function writeSeat(
  out: PuppetPose,
  plan: PodiumPlan,
  index: number,
  seat: number,
  classId: DragonClassId,
  tS: number,
): void {
  const start = plan.startS[index] ?? 0;
  // The MVP's dive ends in the air over its step, where it roars; the others' on the stone.
  const mvp = seat === SEAT_MVP;
  const approachS = mvp ? MVP_APPROACH_S : SEAT_APPROACH_S;
  const u = (tS - start) / approachS;
  writeLine(
    out,
    SEAT_X[seat] ?? 0,
    (SEAT_TOP_Y[seat] ?? 0) + perchDrop(classId),
    SEAT_Z[seat] ?? 0,
    SEAT_APPROACH_X,
    SEAT_APPROACH_Y,
    SEAT_APPROACH_Z,
    u,
    approachS,
    SEAT_BRAKE,
  );
  out.heading = lerpAngle(out.heading, SEAT_HEADING[seat] ?? 0, smoothBetween(0.45, 0.95, u));
  const arrive = start + approachS;
  // The roar comes first and `land` is played once, last: the animator starts `land` from its
  // flare every time it is asked for, so a roar on the stone would end in a second landing.
  const roarAt = arrive - ROAR_LEAD_S;
  const landAt = mvp ? roarAt + ROAR_S : arrive - LAND_LEAD_S;
  const levelAt = mvp ? roarAt : landAt;
  if (mvp) {
    // It hangs over its step for the roar and comes down for the clip's touchdown.
    const down = smoothBetween(landAt, landAt + LAND_LEAD_S, tS);
    out.y += ROAR_HOVER_M * (1 - down);
    if (tS > landAt && tS < landAt + LAND_LEAD_S) {
      const s = (tS - landAt) / LAND_LEAD_S;
      out.vy -= (ROAR_HOVER_M * 6 * s * (1 - s)) / LAND_LEAD_S;
    }
  }
  if (tS >= levelAt) {
    // The clips carry the rearing up, the flare and the perched pose: the body stays level.
    out.pitch = 0;
    out.anim = tS >= landAt ? DRAGON_ANIM_LAND : DRAGON_ANIM_ROAR;
    return;
  }
  const speed = Math.hypot(out.vx, out.vy, out.vz);
  // Nose down the line of the dive, levelling out just before the clip takes over.
  const dive = speed > 1 ? clamp(Math.asin(out.vy / speed), -0.95, 0.3) : 0;
  out.pitch = dive * (1 - smoothBetween(levelAt - 0.4, levelAt, tS));
  out.anim = u <= 0 ? DRAGON_ANIM_HOVER : speed > 34 ? DRAGON_ANIM_DIVE : DRAGON_ANIM_GLIDE;
}

function writeHover(out: PuppetPose, plan: PodiumPlan, index: number, tS: number, mirror: number): void {
  const arc = Math.max(0, plan.arc[index] ?? 0);
  const angle = plan.arcAngle[index] ?? 0;
  const id = plan.ids[index] ?? 0;
  const radius = ARC_RADIUS[arc] ?? 0;
  // The arcs are centred opposite the podium shot's camera, which stands on the sun's side.
  const centre = mirror * ARC_BEARING;
  const sin = Math.sin(angle - centre);
  const cos = Math.cos(angle - centre);
  const start = plan.startS[index] ?? 0;
  const u = (tS - start) / HOVER_APPROACH_S;
  // A loose arc: neighbours alternately high and low, and nobody at quite the same height.
  const stagger = ((plan.arcSlot[index] ?? 0) & 1) === 0 ? ARC_STAGGER_Y : -ARC_STAGGER_Y;
  writeLine(
    out,
    radius * sin,
    (ARC_Y[arc] ?? 0) + stagger + (hash01(id, 1) - 0.5) * 1.2,
    -radius * cos,
    (ARC_APPROACH_SIDE[arc] ?? 0) * sin,
    ARC_APPROACH_Y[arc] ?? 0,
    ARC_APPROACH_Z[arc] ?? 0,
    u,
    HOVER_APPROACH_S,
    HOVER_BRAKE,
  );
  const speed = Math.hypot(out.vx, out.vy, out.vz);
  // Facing the camera, the ones at the ends of the arc turned a little further in.
  out.heading = lerpAngle(out.heading, centre - ARC_TURN_IN * angle, smoothBetween(0.4, 0.95, u));
  // Nose along the line while it is fast, level once it hangs on its wings.
  const along = speed > 1 ? clamp(Math.asin(out.vy / speed), -0.9, 0.6) : 0;
  out.pitch = along * smooth01((speed - 6) / 24);
  // The idle: a slow bob and sway, each dragon on its own beat, fading in as it arrives.
  const idle = u <= 0 ? 1 : smoothBetween(0.75, 1, u);
  const bobPhase = tS * BOB_RATE * (0.85 + 0.3 * hash01(id, 5)) + hash01(id, 7) * 6.2832;
  const swayPhase = tS * SWAY_RATE + hash01(id, 9) * 6.2832;
  out.y += Math.sin(bobPhase) * BOB_M * idle;
  out.x += Math.sin(swayPhase) * SWAY_M * idle;
  out.vy += Math.cos(bobPhase) * BOB_M * BOB_RATE * idle;
  out.roll = Math.sin(swayPhase + 1.2) * 0.05 * idle;
  out.anim =
    u <= 0 || speed < 5
      ? DRAGON_ANIM_HOVER
      : arc === ARC_WINNERS && speed > 30
        ? DRAGON_ANIM_DIVE
        : speed > 16 && arc === ARC_WINNERS
          ? DRAGON_ANIM_GLIDE
          : DRAGON_ANIM_FLAP;
}

/**
 * Writes dragon `index` of the plan at show time `tS` into `out`. `mirror` is the site's (the
 * pass comes from the other side on a mirrored site).
 */
export function writePuppetPose(
  out: PuppetPose,
  plan: PodiumPlan,
  index: number,
  classId: DragonClassId,
  tS: number,
  mirror: number,
): PuppetPose {
  const t = tS > 0 ? tS : 0;
  const seat = plan.seat[index] ?? -1;
  if ((plan.passGroup[index] ?? -1) >= 0 && t < (plan.cutS[index] ?? 0)) {
    writePass(out, plan, index, t, mirror);
  } else if (seat >= 0) {
    writeSeat(out, plan, index, seat, classId, t);
  } else {
    writeHover(out, plan, index, t, mirror);
  }
  return out;
}
