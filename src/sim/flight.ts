/**
 * Arcade flight model (docs/GAME_DESIGN.md, "Flight (arcade)"). Pure functions over one
 * `DragonState`; `sim.ts` calls them for every active dragon each fixed tick:
 *
 *   integrateDragon -> SimCollisionWorld.resolveDragon -> finalizeDragon
 *
 * THE MODEL
 * - Heading is three plain angles (yaw, pitch, bank), not an integrated quaternion. Pitch is
 *   limited to `maxClimbPitch`/`maxDivePitch`, both below a quarter turn. DECISION: no loops.
 *   Mouse aim steers toward a reticle with the camera behind the dragon, and going over the top
 *   would flip "up" for both; a hard limit also keeps yaw/pitch free of gimbal trouble. The
 *   barrel-roll dodge is the aerobatic move.
 * - The dragon always moves along its nose at `speed`, the managed resource: climbing bleeds it
 *   and diving gains it (`gravityAccel * sin(pitch)`), while drag above cruise and wingbeats
 *   below it pull it back to cruise (`speedReturnRate`). Boost adds `boostAccel`.
 * - Everything that is not forward flight (dodge burst, flap kick, folded-wing sink, knock-back
 *   from a collision) lives in `burst`, a world-space velocity that decays by itself.
 * - Below stall speed the nose drops and steering is weak until gravity has given the speed
 *   back (recover by diving). `minSpeedFraction` keeps the dragon moving even then.
 *
 * CONVENTIONS: Y up, yaw 0 faces +Z, +X is the dragon's LEFT (right-handed), so a right turn
 * lowers yaw. Positive pitch = nose up, positive roll = right wing down.
 *
 * DETERMINISM: no randomness, no clocks, fixed TICK_DT_S, timers in whole ticks. Same state and
 * inputs give the same result on the same JS engine. `Math.sin/cos` are not guaranteed to be
 * bit-identical ACROSS engines, which is fine for host authority + reconciliation.
 *
 * Nothing here allocates. Every number comes from the tuning tables, which are read each tick
 * so the dev GUI can change them live; the constants below are numeric guards, not tuning.
 */

import {
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_DODGE_RIGHT,
  BUTTON_FLAP,
  BUTTON_MASK,
  BUTTON_ROLL_LEFT,
  BUTTON_ROLL_RIGHT,
  DRAGON_ANIM_BANK_L,
  DRAGON_ANIM_BANK_R,
  DRAGON_ANIM_BOOST,
  DRAGON_ANIM_DEATH_FALL,
  DRAGON_ANIM_DIVE,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_ANIM_HIT,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_STALLED,
  TICK_DT_S,
  TICK_HZ,
} from '../shared';
import type {
  ClassTuning,
  DragonClassId,
  FlightTuning,
  MatchTuning,
  PlayerId,
  TeamId,
} from '../shared';
import { resetDragonState } from './dragon-state';
import type { DragonState } from './dragon-state';

const TWO_PI = Math.PI * 2;
const EPSILON = 1e-6;
/** Pitch can never reach straight up/down whatever the tuning says (keeps cos(pitch) > 0). */
const PITCH_HARD_LIMIT = 1.5;
/** Cap for a duration from a broken tuning value (Infinity): about 9 hours of ticks. */
const MAX_TIMER_TICKS = 1_000_000;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamps to [-1, 1]; NaN becomes 0. */
function clampUnit(value: number): number {
  if (!(value >= -1)) return value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}

/** Wraps an angle into [-PI, PI). */
function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

function pitchLimit(tuned: number): number {
  return tuned > 0 ? (tuned < PITCH_HARD_LIMIT ? tuned : PITCH_HARD_LIMIT) : 0;
}

/**
 * Whole ticks covering at least `seconds` (0.25 s at 30 Hz = 8 ticks). Zero, negative and NaN
 * give 0.
 */
export function secondsToTicks(seconds: number): number {
  if (!(seconds > 0)) return 0;
  const ticks = Math.ceil(seconds * TICK_HZ - EPSILON);
  return ticks < MAX_TIMER_TICKS ? ticks : MAX_TIMER_TICKS;
}

/** Lowest airspeed a living dragon of this class can have. */
export function minFlightSpeed(flight: FlightTuning, cls: ClassTuning): number {
  return flight.stallSpeed * cls.speedScale * flight.minSpeedFraction;
}

/** Highest airspeed this class can reach (in a full dive, where `diveSpeedScale` applies). */
export function maxFlightSpeed(flight: FlightTuning, cls: ClassTuning): number {
  const dive = cls.diveSpeedScale > 1 ? cls.diveSpeedScale : 1;
  return flight.maxSpeed * cls.speedScale * dive;
}

/** Speed cap at the given nose angle: the class dive bonus fades in as the nose goes down. */
function speedCapAt(flight: FlightTuning, cls: ClassTuning, sinPitch: number): number {
  let cap = flight.maxSpeed * cls.speedScale;
  if (sinPitch < 0) {
    const sinLimit = Math.sin(pitchLimit(flight.maxDivePitch));
    const diveFraction = sinLimit > EPSILON ? clamp(-sinPitch / sinLimit, 0, 1) : 1;
    cap *= 1 + (cls.diveSpeedScale - 1) * diveFraction;
  }
  return cap;
}

/**
 * Turns a free slot into a living dragon at cruise speed, level, facing `yaw`, with full
 * stamina and health and the match's spawn protection. Derived fields are valid on return.
 */
export function initDragon(
  dragon: DragonState,
  id: PlayerId,
  team: TeamId,
  classId: DragonClassId,
  x: number,
  y: number,
  z: number,
  yaw: number,
  flight: FlightTuning,
  cls: ClassTuning,
  match: MatchTuning,
): void {
  resetDragonState(dragon);
  dragon.active = true;
  dragon.id = id;
  dragon.team = team;
  dragon.classId = classId;
  dragon.position.x = Number.isFinite(x) ? x : 0;
  dragon.position.y = Number.isFinite(y) ? y : 0;
  dragon.position.z = Number.isFinite(z) ? z : 0;
  dragon.yaw = Number.isFinite(yaw) ? wrapAngle(yaw) : 0;
  dragon.speed = flight.cruiseSpeed * cls.speedScale;
  dragon.stamina = 1;
  dragon.maxHealth = cls.maxHp;
  dragon.health = cls.maxHp;
  dragon.flags = DRAGON_FLAG_ALIVE;
  dragon.spawnProtectTicks = secondsToTicks(match.spawnProtectionS);
  finalizeDragon(dragon, flight, cls, dragon.position.x, dragon.position.y, dragon.position.z);
}

/**
 * Advances one dragon by one fixed tick from raw input values (they are sanitised here: NaN
 * steers as 0, out-of-range values are clamped, unknown button bits are dropped).
 * Writes the primary fields only; call `finalizeDragon` afterwards.
 */
export function integrateDragon(
  dragon: DragonState,
  rawSteerX: number,
  rawSteerY: number,
  rawButtons: number,
  flight: FlightTuning,
  cls: ClassTuning,
): void {
  const dt = TICK_DT_S;

  if (dragon.dodgeTicks > 0) dragon.dodgeTicks--;
  if (dragon.dodgeImmunityTicks > 0) dragon.dodgeImmunityTicks--;
  if (dragon.dodgeCooldownTicks > 0) dragon.dodgeCooldownTicks--;
  if (dragon.flapCooldownTicks > 0) dragon.flapCooldownTicks--;
  if (dragon.spawnProtectTicks > 0) dragon.spawnProtectTicks--;
  if (dragon.hitTicks > 0) dragon.hitTicks--;
  if (dragon.terrainGraceTicks > 0) dragon.terrainGraceTicks--;

  if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0) {
    integrateDeathFall(dragon, flight);
    return;
  }

  const steerX = clampUnit(rawSteerX);
  const steerY = clampUnit(rawSteerY);
  // `| 0` turns NaN and Infinity into 0 before masking.
  const buttons = (rawButtons | 0) & BUTTON_MASK;
  const pressed = buttons & ~dragon.prevButtons;
  dragon.prevButtons = buttons;

  const stallSpeed = flight.stallSpeed * cls.speedScale;
  const cruiseSpeed = flight.cruiseSpeed * cls.speedScale;
  const levelMaxSpeed = flight.maxSpeed * cls.speedScale;
  const diveHeld = (buttons & BUTTON_DIVE) !== 0;

  // --- Stall, with hysteresis so it does not flicker around the threshold ---------------------
  let stalled = (dragon.flags & DRAGON_FLAG_STALLED) !== 0;
  if (stalled) {
    if (dragon.speed >= stallSpeed * flight.stallRecoverScale) stalled = false;
  } else if (dragon.speed < stallSpeed) {
    stalled = true;
  }
  if (stalled) dragon.flags |= DRAGON_FLAG_STALLED;
  else dragon.flags &= ~DRAGON_FLAG_STALLED;

  // --- Steering: the steer vector commands turn rates; slower flight turns tighter --------------
  const speedSpan = levelMaxSpeed - stallSpeed;
  const speedFraction =
    speedSpan > EPSILON ? clamp((dragon.speed - stallSpeed) / speedSpan, 0, 1) : 0;
  const turnScale =
    flight.turnScaleSlow + (flight.turnScaleFast - flight.turnScaleSlow) * speedFraction;
  const authority = turnScale * (stalled ? flight.stallControlScale : 1);
  const rollInput =
    ((buttons & BUTTON_ROLL_RIGHT) !== 0 ? 1 : 0) - ((buttons & BUTTON_ROLL_LEFT) !== 0 ? 1 : 0);

  // Right turn = negative yaw rate (see CONVENTIONS).
  const yawTarget = -(steerX * flight.maxYawRate + rollInput * flight.rollInputYawRate) * authority;
  let pitchTarget = steerY * flight.maxPitchRate * authority;
  if (diveHeld) pitchTarget -= flight.divePitchRate;
  if (stalled) pitchTarget -= flight.stallNoseDropRate;

  const steerBlend = clamp(flight.steerResponse * dt, 0, 1);
  dragon.yawRate += (yawTarget - dragon.yawRate) * steerBlend;
  dragon.pitchRate += (pitchTarget - dragon.pitchRate) * steerBlend;

  dragon.yaw = wrapAngle(dragon.yaw + dragon.yawRate * dt);
  const maxClimb = pitchLimit(flight.maxClimbPitch);
  const maxDive = pitchLimit(flight.maxDivePitch);
  let pitch = dragon.pitch + dragon.pitchRate * dt;
  if (pitch > maxClimb) {
    pitch = maxClimb;
    if (dragon.pitchRate > 0) dragon.pitchRate = 0;
  } else if (pitch < -maxDive) {
    pitch = -maxDive;
    if (dragon.pitchRate < 0) dragon.pitchRate = 0;
  }
  dragon.pitch = pitch;

  // --- Bank: lean into the turn, plus the roll buttons ------------------------------------------
  const turnFraction =
    flight.maxYawRate > EPSILON ? clamp(-dragon.yawRate / flight.maxYawRate, -1, 1) : 0;
  const bankTarget = turnFraction * flight.maxBankAngle + rollInput * flight.rollInputBank;
  const maxBankStep = flight.maxRollRate * dt;
  dragon.roll += clamp(
    (bankTarget - dragon.roll) * clamp(flight.bankResponse * dt, 0, 1),
    -maxBankStep,
    maxBankStep,
  );

  // --- Boost and flap spend stamina; it comes back after a pause ------------------------------
  let spentStamina = false;
  let boosting = false;
  if (dragon.boostLocked && dragon.stamina >= clamp(flight.boostRestartStamina, 0, 1)) {
    dragon.boostLocked = false;
  }
  if ((buttons & BUTTON_BOOST) !== 0 && !dragon.boostLocked && dragon.stamina > 0) {
    boosting = true;
    spentStamina = true;
    dragon.stamina -= flight.staminaDrainPerS * dt;
    if (dragon.stamina <= 0) {
      dragon.stamina = 0;
      dragon.boostLocked = true;
    }
  }
  if (boosting) dragon.flags |= DRAGON_FLAG_BOOSTING;
  else dragon.flags &= ~DRAGON_FLAG_BOOSTING;

  // Flap repeats while the button is held, once per cooldown.
  if (
    (buttons & BUTTON_FLAP) !== 0 &&
    dragon.flapCooldownTicks === 0 &&
    dragon.stamina >= flight.flapStaminaCost
  ) {
    spentStamina = true;
    dragon.stamina -= flight.flapStaminaCost;
    dragon.flapCooldownTicks = secondsToTicks(flight.flapCooldownS);
    dragon.burst.y += flight.flapImpulse;
    dragon.speed += flight.flapSpeedGain;
  }

  if (spentStamina) {
    dragon.staminaRegenDelayTicks = secondsToTicks(flight.staminaRegenDelayS);
  } else if (dragon.staminaRegenDelayTicks > 0) {
    dragon.staminaRegenDelayTicks--;
  } else {
    dragon.stamina += flight.staminaRegenPerS * dt;
  }

  // --- Barrel-roll dodge: needs a fresh press; left wins if both arrive on the same tick -------
  if (
    dragon.dodgeCooldownTicks === 0 &&
    (pressed & (BUTTON_DODGE_LEFT | BUTTON_DODGE_RIGHT)) !== 0
  ) {
    const dir = (pressed & BUTTON_DODGE_LEFT) !== 0 ? -1 : 1;
    dragon.dodgeDir = dir;
    dragon.dodgeTotalTicks = secondsToTicks(flight.dodgeDurationS);
    dragon.dodgeTicks = dragon.dodgeTotalTicks;
    dragon.dodgeImmunityTicks = secondsToTicks(flight.dodgeImmunityS);
    dragon.dodgeCooldownTicks = secondsToTicks(flight.dodgeCooldownS);
    // Horizontal right of the heading is (-cos yaw, 0, sin yaw).
    dragon.burst.x += -Math.cos(dragon.yaw) * dir * flight.dodgeImpulse;
    dragon.burst.z += Math.sin(dragon.yaw) * dir * flight.dodgeImpulse;
  }

  // --- Energy: gravity along the nose, pull toward cruise, boost --------------------------------
  const sinPitch = Math.sin(dragon.pitch);
  const cosPitch = Math.cos(dragon.pitch);
  let gravityAccel = -flight.gravityAccel * sinPitch;
  let returnRate = flight.speedReturnRate;
  if (sinPitch < 0) {
    gravityAccel *= cls.diveSpeedScale;
    if (diveHeld) gravityAccel *= flight.diveGravityScale;
  }
  if (diveHeld) {
    if (dragon.speed > cruiseSpeed) returnRate *= flight.diveDragScale;
    dragon.burst.y -= flight.diveSinkAccel * dt;
  }
  let speed =
    dragon.speed +
    (gravityAccel +
      (cruiseSpeed - dragon.speed) * returnRate +
      (boosting ? flight.boostAccel : 0)) *
      dt;
  const minSpeed = stallSpeed * flight.minSpeedFraction;
  const maxSpeed = speedCapAt(flight, cls, sinPitch);
  // `!(a >= b)` also catches NaN.
  if (!(speed >= minSpeed)) speed = minSpeed;
  if (speed > maxSpeed) speed = maxSpeed;
  dragon.speed = speed;

  // --- Move, then let the burst fade ------------------------------------------------------------
  const forwardH = cosPitch * speed;
  dragon.position.x += (Math.sin(dragon.yaw) * forwardH + dragon.burst.x) * dt;
  dragon.position.y += (sinPitch * speed + dragon.burst.y) * dt;
  dragon.position.z += (Math.cos(dragon.yaw) * forwardH + dragon.burst.z) * dt;

  const burstKeep = clamp(1 - flight.burstDamping * dt, 0, 1);
  dragon.burst.x *= burstKeep;
  dragon.burst.y *= burstKeep;
  dragon.burst.z *= burstKeep;
}

/** A dead dragon ignores input: the nose drops, forward speed fades and it falls. */
function integrateDeathFall(dragon: DragonState, flight: FlightTuning): void {
  const dt = TICK_DT_S;
  dragon.prevButtons = 0;
  dragon.yawRate = 0;
  dragon.pitchRate = 0;
  dragon.boostLocked = false;

  const maxDive = pitchLimit(flight.maxDivePitch);
  dragon.pitch = clamp(dragon.pitch - flight.maxPitchRate * dt, -maxDive, maxDive);
  dragon.speed -= dragon.speed * clamp(flight.speedReturnRate * dt, 0, 1);

  const burstKeep = clamp(1 - flight.burstDamping * dt, 0, 1);
  dragon.burst.x *= burstKeep;
  dragon.burst.z *= burstKeep;
  dragon.burst.y -= flight.deathFallGravity * dt;
  if (dragon.burst.y < -flight.deathFallMaxSpeed) dragon.burst.y = -flight.deathFallMaxSpeed;

  const forwardH = Math.cos(dragon.pitch) * dragon.speed;
  dragon.position.x += (Math.sin(dragon.yaw) * forwardH + dragon.burst.x) * dt;
  dragon.position.y += (Math.sin(dragon.pitch) * dragon.speed + dragon.burst.y) * dt;
  dragon.position.z += (Math.cos(dragon.yaw) * forwardH + dragon.burst.z) * dt;
}

/**
 * End of a dragon's tick, after collision had its say: forces every primary field back into its
 * legal range (non-finite values included, so no NaN survives a tick), applies death, and
 * rebuilds the derived fields (`orientation`, `velocity`, `anim`, the sim-owned flag bits).
 *
 * `prevX/Y/Z` is the position to fall back to if the current one is not finite.
 */
export function finalizeDragon(
  dragon: DragonState,
  flight: FlightTuning,
  cls: ClassTuning,
  prevX: number,
  prevY: number,
  prevZ: number,
): void {
  const position = dragon.position;
  if (!Number.isFinite(position.x)) position.x = Number.isFinite(prevX) ? prevX : 0;
  if (!Number.isFinite(position.y)) position.y = Number.isFinite(prevY) ? prevY : 0;
  if (!Number.isFinite(position.z)) position.z = Number.isFinite(prevZ) ? prevZ : 0;

  // --- Health and death -------------------------------------------------------------------------
  if (!(dragon.health > 0)) {
    dragon.health = 0;
    dragon.flags &= ~DRAGON_FLAG_ALIVE;
  } else if (dragon.health > dragon.maxHealth) {
    dragon.health = dragon.maxHealth;
  }
  const alive = (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;

  // --- Angles -----------------------------------------------------------------------------------
  dragon.yaw = Number.isFinite(dragon.yaw) ? wrapAngle(dragon.yaw) : 0;
  if (!Number.isFinite(dragon.yawRate)) dragon.yawRate = 0;
  if (!Number.isFinite(dragon.pitchRate)) dragon.pitchRate = 0;
  if (!Number.isFinite(dragon.roll)) dragon.roll = 0;
  const maxClimb = pitchLimit(flight.maxClimbPitch);
  const maxDive = pitchLimit(flight.maxDivePitch);
  dragon.pitch = Number.isFinite(dragon.pitch) ? clamp(dragon.pitch, -maxDive, maxClimb) : 0;

  const sinPitch = Math.sin(dragon.pitch);
  const cosPitch = Math.cos(dragon.pitch);
  const sinYaw = Math.sin(dragon.yaw);
  const cosYaw = Math.cos(dragon.yaw);

  // --- Speed, stamina, burst --------------------------------------------------------------------
  const minSpeed = alive ? minFlightSpeed(flight, cls) : 0;
  const maxSpeed = speedCapAt(flight, cls, sinPitch);
  let speed = dragon.speed;
  if (!(speed >= minSpeed)) speed = minSpeed;
  if (speed > maxSpeed) speed = maxSpeed;
  if (!Number.isFinite(speed)) speed = 0;
  dragon.speed = speed;

  if (!(dragon.stamina >= 0)) dragon.stamina = 0;
  else if (dragon.stamina > 1) dragon.stamina = 1;

  const burst = dragon.burst;
  const burstSq = burst.x * burst.x + burst.y * burst.y + burst.z * burst.z;
  const maxBurst = flight.maxBurstSpeed > 0 ? flight.maxBurstSpeed : 0;
  if (!Number.isFinite(burstSq)) {
    burst.x = 0;
    burst.y = 0;
    burst.z = 0;
  } else if (burstSq > maxBurst * maxBurst) {
    const scale = maxBurst / Math.sqrt(burstSq);
    burst.x *= scale;
    burst.y *= scale;
    burst.z *= scale;
  }

  // --- Derived: velocity ------------------------------------------------------------------------
  dragon.velocity.x = sinYaw * cosPitch * speed + burst.x;
  dragon.velocity.y = sinPitch * speed + burst.y;
  dragon.velocity.z = cosYaw * cosPitch * speed + burst.z;

  // --- Derived: orientation = yaw(Y) * pitch(X, nose up = negative angle) * roll(Z) -----------
  let roll = dragon.roll;
  if (dragon.dodgeTicks > 0 && dragon.dodgeTotalTicks > 0) {
    // Smoothstep over one full turn, so the spin starts and ends level.
    const progress = 1 - dragon.dodgeTicks / dragon.dodgeTotalTicks;
    roll += dragon.dodgeDir * TWO_PI * progress * progress * (3 - 2 * progress);
  }
  const halfYaw = dragon.yaw * 0.5;
  const halfPitch = dragon.pitch * -0.5;
  const halfRoll = roll * 0.5;
  const sy = Math.sin(halfYaw);
  const cy = Math.cos(halfYaw);
  const sx = Math.sin(halfPitch);
  const cx = Math.cos(halfPitch);
  const sz = Math.sin(halfRoll);
  const cz = Math.cos(halfRoll);
  const ax = cy * sx;
  const ay = sy * cx;
  const az = -sy * sx;
  const aw = cy * cx;
  let qx = ax * cz + ay * sz;
  let qy = ay * cz - ax * sz;
  let qz = aw * sz + az * cz;
  let qw = aw * cz - az * sz;
  // Unit by construction; renormalised anyway so rounding can never accumulate downstream.
  const lengthSq = qx * qx + qy * qy + qz * qz + qw * qw;
  if (lengthSq > EPSILON) {
    const inverse = 1 / Math.sqrt(lengthSq);
    qx *= inverse;
    qy *= inverse;
    qz *= inverse;
    qw *= inverse;
  } else {
    qx = 0;
    qy = 0;
    qz = 0;
    qw = 1;
  }
  dragon.orientation.x = qx;
  dragon.orientation.y = qy;
  dragon.orientation.z = qz;
  dragon.orientation.w = qw;

  // --- Derived: flags and the animation hint ----------------------------------------------------
  let flags = dragon.flags & ~(DRAGON_FLAG_DODGING | DRAGON_FLAG_SPAWN_PROTECTED);
  if (!alive) {
    flags &= ~(DRAGON_FLAG_BOOSTING | DRAGON_FLAG_STALLED);
    dragon.flags = flags;
    dragon.anim = DRAGON_ANIM_DEATH_FALL;
    return;
  }
  if (dragon.dodgeImmunityTicks > 0) flags |= DRAGON_FLAG_DODGING;
  if (dragon.spawnProtectTicks > 0) flags |= DRAGON_FLAG_SPAWN_PROTECTED;
  dragon.flags = flags;

  // The list has no dodge clip: the spin is in `orientation`, the hint leans the same way.
  if (dragon.hitTicks > 0) dragon.anim = DRAGON_ANIM_HIT;
  else if (dragon.dodgeTicks > 0) {
    dragon.anim = dragon.dodgeDir < 0 ? DRAGON_ANIM_BANK_L : DRAGON_ANIM_BANK_R;
  } else if (dragon.flapCooldownTicks > 0) dragon.anim = DRAGON_ANIM_FLAP;
  else if ((flags & DRAGON_FLAG_BOOSTING) !== 0) dragon.anim = DRAGON_ANIM_BOOST;
  else if ((dragon.prevButtons & BUTTON_DIVE) !== 0 || dragon.pitch < -flight.diveAnimPitch) {
    dragon.anim = DRAGON_ANIM_DIVE;
  } else if (dragon.roll > flight.bankAnimAngle) dragon.anim = DRAGON_ANIM_BANK_R;
  else if (dragon.roll < -flight.bankAnimAngle) dragon.anim = DRAGON_ANIM_BANK_L;
  else dragon.anim = DRAGON_ANIM_GLIDE;
}

/**
 * Takes `amount` HP off a living dragon and returns what was actually removed. Does nothing
 * during dodge immunity or spawn protection unless `ignoreImmunity` is set. At 0 HP the dragon
 * loses DRAGON_FLAG_ALIVE at once and starts its death fall on the next tick.
 */
export function damageDragon(
  dragon: DragonState,
  amount: number,
  flight: FlightTuning,
  ignoreImmunity = false,
): number {
  if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0 || !(amount > 0)) return 0;
  // The timers, not the flag bits: the bits are only refreshed at the end of the tick.
  if (!ignoreImmunity && (dragon.dodgeImmunityTicks > 0 || dragon.spawnProtectTicks > 0)) return 0;
  const applied = amount < dragon.health ? amount : dragon.health;
  dragon.health -= applied;
  dragon.hitTicks = secondsToTicks(flight.hitAnimS);
  if (!(dragon.health > 0)) {
    dragon.health = 0;
    dragon.flags &= ~DRAGON_FLAG_ALIVE;
  }
  return applied;
}

/**
 * Points the flight path along a world-space velocity (e.g. the reflected velocity of a terrain
 * bounce): sets `yaw`, `pitch` and `speed` and stops the current turn. `burst` is left alone.
 * Pitch and speed are clamped to the flight limits by `finalizeDragon`, so a bounce can never
 * leave the dragon looping or below its minimum speed. Ignored if the velocity is ~zero or NaN.
 */
export function setDragonVelocity(dragon: DragonState, vx: number, vy: number, vz: number): void {
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!(speed > EPSILON) || !Number.isFinite(speed)) return;
  dragon.speed = speed;
  dragon.pitch = Math.asin(clamp(vy / speed, -1, 1));
  // Straight up or down has no heading: keep the old one.
  if (vx * vx + vz * vz > EPSILON * EPSILON) dragon.yaw = Math.atan2(vx, vz);
  dragon.yawRate = 0;
  dragon.pitchRate = 0;
}
