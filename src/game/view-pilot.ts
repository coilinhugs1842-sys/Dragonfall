/**
 * `?autopilot=bot` on a CLIENT page: a small pursue-and-fire pilot that flies the local dragon
 * from nothing but the frame's WorldView, i.e. from what a client actually sees (remote dragons
 * about 100 ms in the past). It exists for headless two-page tests: a client that shoots lets a
 * script compare how often its shots land with and without the host's lag compensation.
 *
 * It is deliberately simple (the real bot brain needs the host's sim state): turn toward the
 * nearest enemy that can be hit, lead it by the primary's projectile speed, hold the primary
 * while the nose is close enough, and fall back to the `?autopilot` circle with nobody to chase
 * or when the arena edge is near. Pure and allocation-free: one call per tick.
 */

import {
  ABILITY_TABLE,
  BUTTON_AIM,
  BUTTON_BOOST,
  BUTTON_PRIMARY,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  PROJECTILE_DEFS,
  findDragonView,
  resetInputFrame,
} from '../shared';
import type { DragonView, InputFrame, PlayerId, WorldView } from '../shared';
import { writeAutopilotFrame } from './autopilot';
import type { AutopilotCourse } from './autopilot';

/** Steer per radian of error (the stick is full over at about 35 degrees off). */
const STEER_GAIN = 1.6;
/** The nose must be within this of the aim line to fire, radians. */
const FIRE_CONE = 0.22;
/** Past this fraction of the course radius the pilot turns back before it chases on. */
const EDGE_FRACTION = 1.9;
/** Longest lead time, seconds (a far target's prediction is a guess). */
const MAX_LEAD_S = 1.2;
/** Chases with boost beyond this range, metres. */
const BOOST_RANGE = 110;
/** Used for the lead when the primary is not a projectile (a cone or a beam lands at once). */
const INSTANT_SPEED = 1e6;

function clampUnit(value: number): number {
  if (!(value >= -1)) return value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}

function nearestEnemy(view: WorldView, self: DragonView): DragonView | undefined {
  let best: DragonView | undefined;
  let bestSq = Infinity;
  for (let i = 0; i < view.dragonCount; i++) {
    const other = view.dragons[i];
    if (other === undefined || other.team === self.team) continue;
    const flags = other.flags;
    if ((flags & DRAGON_FLAG_ALIVE) === 0) continue;
    if ((flags & (DRAGON_FLAG_VEILED | DRAGON_FLAG_SPAWN_PROTECTED)) !== 0) continue;
    const dx = other.position.x - self.position.x;
    const dy = other.position.y - self.position.y;
    const dz = other.position.z - self.position.z;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    if (distanceSq < bestSq) {
      bestSq = distanceSq;
      best = other;
    }
  }
  return best;
}

/**
 * Writes the pilot's input for `tick` into `out`. `selfId` is the local dragon; with no dragon,
 * a dead one or nobody to chase it flies the `course` circle.
 */
export function writeViewPilotFrame(
  tick: number,
  view: WorldView,
  selfId: PlayerId,
  course: AutopilotCourse,
  out: InputFrame,
): InputFrame {
  const self = findDragonView(view, selfId);
  if (self === undefined || (self.flags & DRAGON_FLAG_ALIVE) === 0) {
    return resetInputFrame(out, tick);
  }
  const fromCenterX = self.position.x - course.centerX;
  const fromCenterZ = self.position.z - course.centerZ;
  const edge = course.radius * EDGE_FRACTION;
  const target =
    fromCenterX * fromCenterX + fromCenterZ * fromCenterZ < edge * edge
      ? nearestEnemy(view, self)
      : undefined;
  if (target === undefined) return writeAutopilotFrame(tick, self, course, out);

  // --- Where to shoot: lead the target by the primary's time of flight -------------------------
  const primary = ABILITY_TABLE[self.classId].primary;
  const bolt =
    primary.kind === 'projectile' && primary.projectile !== null
      ? PROJECTILE_DEFS[primary.projectile]
      : null;
  const speed = bolt !== null ? bolt.speed : INSTANT_SPEED;
  let dx = target.position.x - self.position.x;
  let dy = target.position.y - self.position.y;
  let dz = target.position.z - self.position.z;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const lead = Math.min(MAX_LEAD_S, speed > 0 ? range / speed : 0);
  dx += target.velocity.x * lead;
  dy += target.velocity.y * lead;
  dz += target.velocity.z * lead;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(length > 1e-3)) return writeAutopilotFrame(tick, self, course, out);
  dx /= length;
  dy /= length;
  dz /= length;

  // --- Into dragon space (+Z forward, +Y up, +X left): rotate by the inverse orientation -------
  const q = self.orientation;
  const qx = -q.x;
  const qy = -q.y;
  const qz = -q.z;
  const qw = q.w;
  const tx = 2 * (qy * dz - qz * dy);
  const ty = 2 * (qz * dx - qx * dz);
  const tz = 2 * (qx * dy - qy * dx);
  const localX = dx + qw * tx + (qy * tz - qz * ty);
  const localY = dy + qw * ty + (qz * tx - qx * tz);
  const localZ = dz + qw * tz + (qx * ty - qy * tx);

  // Angles off the nose: right is -X in dragon space.
  const yawError = Math.atan2(-localX, localZ);
  const pitchError = Math.atan2(localY, Math.sqrt(localX * localX + localZ * localZ));
  const off = Math.acos(localZ > 1 ? 1 : localZ < -1 ? -1 : localZ);

  out.tick = tick;
  out.steerX = clampUnit(yawError * STEER_GAIN);
  out.steerY = clampUnit(pitchError * STEER_GAIN);
  let buttons = BUTTON_AIM;
  // A bolt reaches as far as it flies before it expires; a cone or a beam has a stated range.
  const reach = bolt !== null ? bolt.speed * bolt.lifeS * 0.9 : primary.range;
  if (off < FIRE_CONE && range < reach) buttons |= BUTTON_PRIMARY;
  if (range > BOOST_RANGE && self.stamina > 0.35) buttons |= BUTTON_BOOST;
  out.buttons = buttons;
  out.aimYaw = Math.atan2(dx, dz);
  out.aimPitch = Math.asin(dy > 1 ? 1 : dy < -1 ? -1 : dy);
  return out;
}
