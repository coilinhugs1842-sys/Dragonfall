/**
 * One dragon's simulation state. `SimState` owns a fixed pool of these (MAX_PLAYERS slots), so
 * spawning never allocates and a whole state can be copied field by field.
 *
 * Fields are in three groups:
 * - PRIMARY: what the flight model integrates and what other systems (collision, combat) may
 *   write: position, yaw/pitch/roll, speed, burst, stamina, health, timers.
 * - DERIVED: `orientation`, `velocity`, `anim` and the sim-owned flag bits. `finalizeDragon`
 *   rewrites them from the primary fields at the end of every tick, so writing them is pointless.
 * - Timers are whole sim ticks (not seconds), which keeps them exact and deterministic.
 *
 * Every field added here must also be handled in `resetDragonState` and `copyDragonState`
 * (tests/sim/sim-state.test.ts fails if one is forgotten).
 */

import { DEFAULT_DRAGON_CLASS, DRAGON_ANIM_GLIDE, NO_PLAYER, TEAM_EMBER } from '../shared';
import type {
  DragonAnimState,
  DragonClassId,
  MutableQuat,
  MutableVec3,
  PlayerId,
  TeamId,
} from '../shared';

export interface DragonState {
  /** False = free pool slot; every other field is then stale. */
  active: boolean;
  /** Same id as the rider's PlayerId. NOT the slot index. */
  id: PlayerId;
  team: TeamId;
  classId: DragonClassId;

  // --- Primary ---------------------------------------------------------------------------------
  /** World space, metres. Y is up. */
  position: MutableVec3;
  /** Heading about +Y, in (-PI, PI]. 0 faces +Z; a RIGHT turn makes it smaller. */
  yaw: number;
  /** Nose angle above the horizon. Positive = climbing. */
  pitch: number;
  /** Bank angle. Positive = right wing down. The dodge spin is not included. */
  roll: number;
  /** rad/s, smoothed turn rates behind `yaw` and `pitch`. */
  yawRate: number;
  pitchRate: number;
  /** m/s along the nose: the managed "energy" of the flight model. */
  speed: number;
  /** m/s, world space: velocity on top of forward flight (dodge, flap, sink, knock-back). Decays. */
  burst: MutableVec3;
  /** Boost stamina, 0..1. */
  stamina: number;
  /** Hit points, 0..maxHealth. */
  health: number;
  maxHealth: number;
  /** Bitmask of DRAGON_FLAG_*. ALIVE and STALLED persist here; see `finalizeDragon`. */
  flags: number;
  /** Buttons seen on the previous tick, for press edges (dodge). */
  prevButtons: number;
  /** Boost ran dry and is locked until stamina is back to `boostRestartStamina`. */
  boostLocked: boolean;

  // --- Timers, in ticks (0 = idle) -------------------------------------------------------------
  /** -1 = rolling left, 1 = rolling right, 0 = no dodge yet. */
  dodgeDir: number;
  /** Ticks left of the barrel-roll spin, and its full length (for the spin angle). */
  dodgeTicks: number;
  dodgeTotalTicks: number;
  /** Ticks of dodge damage immunity left. */
  dodgeImmunityTicks: number;
  dodgeCooldownTicks: number;
  flapCooldownTicks: number;
  /** Ticks until stamina starts to regenerate. */
  staminaRegenDelayTicks: number;
  spawnProtectTicks: number;
  /** Ticks left of the `hit` animation hint. */
  hitTicks: number;
  /** Ticks during which another terrain hit does no damage (unless lethal). Set by collision. */
  terrainGraceTicks: number;

  // --- Derived ---------------------------------------------------------------------------------
  /** Unit quaternion: yaw, pitch, bank and the dodge spin. Forward is +Z in dragon space. */
  orientation: MutableQuat;
  /** World space, m/s: forward * speed + burst. */
  velocity: MutableVec3;
  /** Animation hint for the view (DRAGON_ANIM_*). */
  anim: DragonAnimState;
}

export function createDragonState(): DragonState {
  return {
    active: false,
    id: NO_PLAYER,
    team: TEAM_EMBER,
    classId: DEFAULT_DRAGON_CLASS,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    yawRate: 0,
    pitchRate: 0,
    speed: 0,
    burst: { x: 0, y: 0, z: 0 },
    stamina: 0,
    health: 0,
    maxHealth: 0,
    flags: 0,
    prevButtons: 0,
    boostLocked: false,
    dodgeDir: 0,
    dodgeTicks: 0,
    dodgeTotalTicks: 0,
    dodgeImmunityTicks: 0,
    dodgeCooldownTicks: 0,
    flapCooldownTicks: 0,
    staminaRegenDelayTicks: 0,
    spawnProtectTicks: 0,
    hitTicks: 0,
    terrainGraceTicks: 0,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    anim: DRAGON_ANIM_GLIDE,
  };
}

/** Back to a free slot with the same values as a newly created one. */
export function resetDragonState(dragon: DragonState): DragonState {
  dragon.active = false;
  dragon.id = NO_PLAYER;
  dragon.team = TEAM_EMBER;
  dragon.classId = DEFAULT_DRAGON_CLASS;
  dragon.position.x = 0;
  dragon.position.y = 0;
  dragon.position.z = 0;
  dragon.yaw = 0;
  dragon.pitch = 0;
  dragon.roll = 0;
  dragon.yawRate = 0;
  dragon.pitchRate = 0;
  dragon.speed = 0;
  dragon.burst.x = 0;
  dragon.burst.y = 0;
  dragon.burst.z = 0;
  dragon.stamina = 0;
  dragon.health = 0;
  dragon.maxHealth = 0;
  dragon.flags = 0;
  dragon.prevButtons = 0;
  dragon.boostLocked = false;
  dragon.dodgeDir = 0;
  dragon.dodgeTicks = 0;
  dragon.dodgeTotalTicks = 0;
  dragon.dodgeImmunityTicks = 0;
  dragon.dodgeCooldownTicks = 0;
  dragon.flapCooldownTicks = 0;
  dragon.staminaRegenDelayTicks = 0;
  dragon.spawnProtectTicks = 0;
  dragon.hitTicks = 0;
  dragon.terrainGraceTicks = 0;
  dragon.orientation.x = 0;
  dragon.orientation.y = 0;
  dragon.orientation.z = 0;
  dragon.orientation.w = 1;
  dragon.velocity.x = 0;
  dragon.velocity.y = 0;
  dragon.velocity.z = 0;
  dragon.anim = DRAGON_ANIM_GLIDE;
  return dragon;
}

export function copyDragonState(out: DragonState, from: Readonly<DragonState>): DragonState {
  out.active = from.active;
  out.id = from.id;
  out.team = from.team;
  out.classId = from.classId;
  out.position.x = from.position.x;
  out.position.y = from.position.y;
  out.position.z = from.position.z;
  out.yaw = from.yaw;
  out.pitch = from.pitch;
  out.roll = from.roll;
  out.yawRate = from.yawRate;
  out.pitchRate = from.pitchRate;
  out.speed = from.speed;
  out.burst.x = from.burst.x;
  out.burst.y = from.burst.y;
  out.burst.z = from.burst.z;
  out.stamina = from.stamina;
  out.health = from.health;
  out.maxHealth = from.maxHealth;
  out.flags = from.flags;
  out.prevButtons = from.prevButtons;
  out.boostLocked = from.boostLocked;
  out.dodgeDir = from.dodgeDir;
  out.dodgeTicks = from.dodgeTicks;
  out.dodgeTotalTicks = from.dodgeTotalTicks;
  out.dodgeImmunityTicks = from.dodgeImmunityTicks;
  out.dodgeCooldownTicks = from.dodgeCooldownTicks;
  out.flapCooldownTicks = from.flapCooldownTicks;
  out.staminaRegenDelayTicks = from.staminaRegenDelayTicks;
  out.spawnProtectTicks = from.spawnProtectTicks;
  out.hitTicks = from.hitTicks;
  out.terrainGraceTicks = from.terrainGraceTicks;
  out.orientation.x = from.orientation.x;
  out.orientation.y = from.orientation.y;
  out.orientation.z = from.orientation.z;
  out.orientation.w = from.orientation.w;
  out.velocity.x = from.velocity.x;
  out.velocity.y = from.velocity.y;
  out.velocity.z = from.velocity.z;
  out.anim = from.anim;
  return out;
}
