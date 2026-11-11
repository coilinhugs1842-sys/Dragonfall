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

import {
  DEFAULT_DRAGON_CLASS,
  DRAGON_ANIM_GLIDE,
  MAX_ASSISTS,
  NO_PLAYER,
  TEAM_EMBER,
} from '../shared';
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

  // --- Combat (T-3.1 / T-3.2) -------------------------------------------------------------------
  /**
   * Where abilities are aimed (world heading and angle above the horizon), from the last input
   * that carried BUTTON_AIM. Only meaningful while `prevButtons` has BUTTON_AIM.
   */
  aimYaw: number;
  aimPitch: number;
  /**
   * Per ability slot (index = ABILITY_SLOTS). Ticks until the slot is ready again; with
   * `maxCharges` > 1, ticks until the next charge is back.
   */
  abilityCooldownTicks: number[];
  /** Charges spent and not yet back (0 = all in store). Only counts for `maxCharges` > 1. */
  abilityChargesUsed: number[];
  /** Ticks the ability stays active (buff, dash window, burst, trail). */
  abilityActiveTicks: number[];
  /** Slot being wound up, or -1; and the ticks left until it fires. */
  castSlot: number;
  castTicks: number;
  /**
   * Bit i set = slot i fired THIS tick (a new cast: the host emits `abilityCast`). Rewritten
   * every tick.
   */
  castStarted: number;
  /**
   * Bit i set = slot i applies its effect THIS tick (the cast itself, a burst shot, a trail
   * drop, a dash contact check). The host executes these; a client reads its own for instant
   * cosmetic feedback. Rewritten every tick.
   */
  castPulse: number;
  /** Ticks left of "holding fire" with a sustained primary (DRAGON_FLAG_FIRING). */
  firingTicks: number;
  /** Dragon slots the active dash has already hit (bit = slot index). */
  abilityHitMask: number;
  /** Ultimate charge, 0..1. Survives death. */
  ultCharge: number;
  /** Status timers in ticks (0 = off) and what they carry. See STATUS_KINDS. */
  slowTicks: number;
  slowScale: number;
  hasteTicks: number;
  hasteScale: number;
  burnTicks: number;
  burnDps: number;
  /** Who set the burn and with which slot, for credit. */
  burnSourceId: number;
  burnSlot: number;
  regenTicks: number;
  regenPerS: number;
  blindTicks: number;
  veilTicks: number;
  phaseTicks: number;
  shieldTicks: number;
  /**
   * Whole ticks spent dead (0 while alive and on the tick of death itself). Counted in the
   * dragon's own step, so a client predicts it. The sim respawns at MATCH_TUNING.respawnDelayS.
   */
  deadTicks: number;
  /** Host only: this death's takedown has been credited and announced. */
  downed: boolean;
  /**
   * Who last hurt this dragon, the ticks that credit still holds, and with what (index into
   * DAMAGE_SOURCES). The id stays after death (death cam); the timer decides takedown credit.
   */
  lastDamagerId: number;
  lastDamagerTicks: number;
  lastDamageSource: number;
  /** Recent damagers for assists: ids and the ticks each credit still holds. */
  assistIds: number[];
  assistTicks: number[];
  /**
   * HP the environment took THIS tick and what did it (0 none, 1 terrain, 2 storm). Written by
   * the collision world, read by the host after the step. Rewritten every tick.
   */
  envDamage: number;
  envSource: number;
  /** Where this dragon entered the world (its gate slot): the default respawn pose. */
  home: MutableVec3;
  homeYaw: number;

  // --- Derived ---------------------------------------------------------------------------------
  /** Unit quaternion: yaw, pitch, bank and the dodge spin. Forward is +Z in dragon space. */
  orientation: MutableQuat;
  /** World space, m/s: forward * speed + burst. */
  velocity: MutableVec3;
  /** Animation hint for the view (DRAGON_ANIM_*). */
  anim: DragonAnimState;
}

function filled(length: number, value: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) out.push(value);
  return out;
}

/** Element-wise copy of a fixed-length array (a loop: no iterator, no allocation). */
function copyNumbers(out: number[], from: readonly number[]): void {
  for (let i = 0; i < out.length; i++) out[i] = from[i] ?? 0;
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
    aimYaw: 0,
    aimPitch: 0,
    abilityCooldownTicks: [0, 0, 0, 0],
    abilityChargesUsed: [0, 0, 0, 0],
    abilityActiveTicks: [0, 0, 0, 0],
    castSlot: -1,
    castTicks: 0,
    castStarted: 0,
    castPulse: 0,
    firingTicks: 0,
    abilityHitMask: 0,
    ultCharge: 0,
    slowTicks: 0,
    slowScale: 1,
    hasteTicks: 0,
    hasteScale: 1,
    burnTicks: 0,
    burnDps: 0,
    burnSourceId: NO_PLAYER,
    burnSlot: 0,
    regenTicks: 0,
    regenPerS: 0,
    blindTicks: 0,
    veilTicks: 0,
    phaseTicks: 0,
    shieldTicks: 0,
    deadTicks: 0,
    downed: false,
    lastDamagerId: NO_PLAYER,
    lastDamagerTicks: 0,
    lastDamageSource: 0,
    assistIds: filled(MAX_ASSISTS, NO_PLAYER),
    assistTicks: filled(MAX_ASSISTS, 0),
    envDamage: 0,
    envSource: 0,
    home: { x: 0, y: 0, z: 0 },
    homeYaw: 0,
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
  dragon.aimYaw = 0;
  dragon.aimPitch = 0;
  dragon.abilityCooldownTicks.fill(0);
  dragon.abilityChargesUsed.fill(0);
  dragon.abilityActiveTicks.fill(0);
  dragon.castSlot = -1;
  dragon.castTicks = 0;
  dragon.castStarted = 0;
  dragon.castPulse = 0;
  dragon.firingTicks = 0;
  dragon.abilityHitMask = 0;
  dragon.ultCharge = 0;
  dragon.slowTicks = 0;
  dragon.slowScale = 1;
  dragon.hasteTicks = 0;
  dragon.hasteScale = 1;
  dragon.burnTicks = 0;
  dragon.burnDps = 0;
  dragon.burnSourceId = NO_PLAYER;
  dragon.burnSlot = 0;
  dragon.regenTicks = 0;
  dragon.regenPerS = 0;
  dragon.blindTicks = 0;
  dragon.veilTicks = 0;
  dragon.phaseTicks = 0;
  dragon.shieldTicks = 0;
  dragon.deadTicks = 0;
  dragon.downed = false;
  dragon.lastDamagerId = NO_PLAYER;
  dragon.lastDamagerTicks = 0;
  dragon.lastDamageSource = 0;
  dragon.assistIds.fill(NO_PLAYER);
  dragon.assistTicks.fill(0);
  dragon.envDamage = 0;
  dragon.envSource = 0;
  dragon.home.x = 0;
  dragon.home.y = 0;
  dragon.home.z = 0;
  dragon.homeYaw = 0;
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
  out.aimYaw = from.aimYaw;
  out.aimPitch = from.aimPitch;
  copyNumbers(out.abilityCooldownTicks, from.abilityCooldownTicks);
  copyNumbers(out.abilityChargesUsed, from.abilityChargesUsed);
  copyNumbers(out.abilityActiveTicks, from.abilityActiveTicks);
  out.castSlot = from.castSlot;
  out.castTicks = from.castTicks;
  out.castStarted = from.castStarted;
  out.castPulse = from.castPulse;
  out.firingTicks = from.firingTicks;
  out.abilityHitMask = from.abilityHitMask;
  out.ultCharge = from.ultCharge;
  out.slowTicks = from.slowTicks;
  out.slowScale = from.slowScale;
  out.hasteTicks = from.hasteTicks;
  out.hasteScale = from.hasteScale;
  out.burnTicks = from.burnTicks;
  out.burnDps = from.burnDps;
  out.burnSourceId = from.burnSourceId;
  out.burnSlot = from.burnSlot;
  out.regenTicks = from.regenTicks;
  out.regenPerS = from.regenPerS;
  out.blindTicks = from.blindTicks;
  out.veilTicks = from.veilTicks;
  out.phaseTicks = from.phaseTicks;
  out.shieldTicks = from.shieldTicks;
  out.deadTicks = from.deadTicks;
  out.downed = from.downed;
  out.lastDamagerId = from.lastDamagerId;
  out.lastDamagerTicks = from.lastDamagerTicks;
  out.lastDamageSource = from.lastDamageSource;
  copyNumbers(out.assistIds, from.assistIds);
  copyNumbers(out.assistTicks, from.assistTicks);
  out.envDamage = from.envDamage;
  out.envSource = from.envSource;
  out.home.x = from.home.x;
  out.home.y = from.home.y;
  out.home.z = from.home.z;
  out.homeYaw = from.homeYaw;
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
