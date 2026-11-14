/**
 * Data-driven tuning tables, so balance changes are data edits and not code changes
 * (docs/GAME_DESIGN.md: "Exact numbers live in src/shared tuning tables").
 *
 * Values marked `doc` come from GAME_DESIGN.md. Values marked PLACEHOLDER are guesses that only
 * respect the doc's ordering (e.g. Bastion has the most HP); the task named next to each table
 * replaces them. The tables are intentionally mutable so the dev GUI (lil-gui) can tune them
 * live. Host and clients must run the same values or prediction drifts.
 */

import type { AbilitySlot, DragonClassId } from './classes';

// --- Flight (T-1.1: read every tick by src/sim/flight.ts, so the dev GUI can edit it live) -------
//
// Angles are radians, rates are per second, stamina is 0..1. Speeds are multiplied by the
// class's `speedScale`. Durations are turned into whole sim ticks (rounded up) when they start.

export interface FlightTuning {
  // Speed and energy
  /** m/s. Below this the dragon stalls. */
  stallSpeed: number;
  /** m/s. Level flight with no input settles here. */
  cruiseSpeed: number;
  /** m/s. Top speed in a full dive or boost. */
  maxSpeed: number;
  /** Hard floor on airspeed as a fraction of the stall speed: the dragon always moves forward. */
  minSpeedFraction: number;
  /** Energy trade: m/s² gained in a vertical dive (lost in a vertical climb), times sin(pitch). */
  gravityAccel: number;
  /** 1/s. How hard drag (above cruise) or wingbeats (below it) pull the speed back to cruise. */
  speedReturnRate: number;

  // Steering
  /** rad/s at full steer, before the speed scale below. */
  maxPitchRate: number;
  maxYawRate: number;
  /** rad/s. Cap on how fast the bank angle changes. */
  maxRollRate: number;
  /** 1/s. How quickly the turn rates follow the steer input (higher = snappier). */
  steerResponse: number;
  /** Turn-rate multiplier at stall speed and at max speed; linear in between. */
  turnScaleSlow: number;
  turnScaleFast: number;
  /**
   * Soft pitch caps in radians. At `Math.PI` (the default) pitch wraps freely for loops /
   * inverted flight. Values below PI clamp the nose (accessibility / legacy).
   */
  maxClimbPitch: number;
  maxDivePitch: number;
  /** Bank angle at a full-rate turn. */
  maxBankAngle: number;
  /** 1/s. How quickly the bank follows the turn. */
  bankResponse: number;
  /** Extra bank from a held roll button, and the yaw rate that bank adds. */
  rollInputBank: number;
  rollInputYawRate: number;

  // Stall
  /** The stall ends once speed is back above stallSpeed times this. */
  stallRecoverScale: number;
  /** Multiplier on steering authority while stalled. */
  stallControlScale: number;
  /** rad/s. Nose-down rate forced on a stalled dragon. */
  stallNoseDropRate: number;

  // Boost and stamina
  /** m/s² gained when boosting. */
  boostAccel: number;
  /** Stamina (0..1) spent per second of boost, and regained per second without it. */
  staminaDrainPerS: number;
  staminaRegenPerS: number;
  /** Seconds after the last stamina spend before it starts to regenerate. */
  staminaRegenDelayS: number;
  /** After running dry, boost stays locked until stamina is back to this. */
  boostRestartStamina: number;

  // Flap
  /** m/s of upward kick from a hard flap. */
  flapImpulse: number;
  /** m/s of airspeed a flap adds. */
  flapSpeedGain: number;
  flapCooldownS: number;
  flapStaminaCost: number;

  // Dive (folded wings)
  /** Multiplier on the gravity speed gain while the dive button is held and the nose is down. */
  diveGravityScale: number;
  /** Multiplier on speedReturnRate while folded and above cruise (less drag). */
  diveDragScale: number;
  /** rad/s. Nose-down rate added while the dive button is held. */
  divePitchRate: number;
  /** m/s² of sink while folded, on top of the forward flight path. */
  diveSinkAccel: number;

  // Barrel-roll dodge
  /** Seconds of damage immunity during a barrel-roll dodge. */
  dodgeImmunityS: number;
  dodgeCooldownS: number;
  /** m/s of sideways burst from a dodge. */
  dodgeImpulse: number;
  /** Seconds the full 360° roll takes. */
  dodgeDurationS: number;

  // Burst velocity (dodge, flap, sink, knock-back: everything on top of forward flight)
  /** 1/s. Decay of the burst velocity. */
  burstDamping: number;
  /** m/s. Cap on the burst velocity, whatever pushed it. */
  maxBurstSpeed: number;

  // Animation hints and death
  /** Seconds the `hit` animation hint lasts after taking damage. */
  hitAnimS: number;
  /** Nose-down angle past which the hint is `dive`; bank angle past which it is `bank_l/r`. */
  diveAnimPitch: number;
  bankAnimAngle: number;
  /** m/s² and m/s terminal speed of a dead dragon's fall. */
  deathFallGravity: number;
  deathFallMaxSpeed: number;

  // Terrain (T-1.7)
  /** Restitution along the surface normal: fraction of the impact speed a terrain bounce returns. */
  terrainBounceRestitution: number;
  /** m/s. A terrain hit above this speed is lethal. */
  terrainLethalSpeed: number;
}

/** `doc` = from GAME_DESIGN.md. Everything else is a first-pass feel value, tuned by playtest. */
export const FLIGHT_TUNING: FlightTuning = {
  stallSpeed: 25, // doc
  cruiseSpeed: 45, // doc
  maxSpeed: 95, // doc
  minSpeedFraction: 0.6,
  gravityAccel: 24,
  speedReturnRate: 0.5,

  maxPitchRate: 1.6,
  maxYawRate: 1.2,
  maxRollRate: 3.0,
  steerResponse: 8,
  turnScaleSlow: 1.25,
  turnScaleFast: 0.6,
  maxClimbPitch: Math.PI,
  maxDivePitch: Math.PI,
  maxBankAngle: 1.0,
  bankResponse: 5,
  rollInputBank: 0.5,
  rollInputYawRate: 0.35,

  stallRecoverScale: 1.1,
  stallControlScale: 0.35,
  stallNoseDropRate: 1.2,

  boostAccel: 25,
  staminaDrainPerS: 0.25,
  staminaRegenPerS: 0.12,
  staminaRegenDelayS: 1,
  boostRestartStamina: 0.2,

  flapImpulse: 14,
  flapSpeedGain: 4,
  flapCooldownS: 0.7,
  flapStaminaCost: 0.12,

  diveGravityScale: 1.6,
  diveDragScale: 0.3,
  divePitchRate: 0.9,
  diveSinkAccel: 12,

  dodgeImmunityS: 0.25, // doc
  dodgeCooldownS: 4, // doc
  dodgeImpulse: 30,
  dodgeDurationS: 0.5,

  burstDamping: 3,
  maxBurstSpeed: 60,

  hitAnimS: 0.3,
  diveAnimPitch: 0.5,
  bankAnimAngle: 0.45,
  deathFallGravity: 20,
  deathFallMaxSpeed: 60,

  terrainBounceRestitution: 0.5, // PLACEHOLDER (T-1.7)
  terrainLethalSpeed: 85, // PLACEHOLDER (T-1.7)
};

// --- Classes -------------------------------------------------------------------------------------
//
// The ability numbers are NOT here: see ABILITY_TABLE in ./abilities.ts (T-3.2). `abilities`
// below is the Phase 0 placeholder, kept only so older code that reads it still compiles.

/** @deprecated Use `AbilityDef` and ABILITY_TABLE (./abilities.ts). */
export interface AbilityTuning {
  cooldownS: number;
  damage: number;
}

export interface ClassTuning {
  maxHp: number;
  /** Multiplier on FLIGHT_TUNING speeds. */
  speedScale: number;
  /** Extra multiplier on top speed while diving (Wraith is "fast in dives"). */
  diveSpeedScale: number;
  /**
   * Metres. Radius of the sphere that collides with terrain. Abilities hit a larger sphere:
   * this times COMBAT_TUNING.hitRadiusScale (a sphere, not a capsule: one test per target, and
   * generous enough for a body that is longer than it is wide).
   */
  hitRadius: number;
  /** Multiplier on flight turn authority (1 = baseline). */
  turnScale: number;
  /** @deprecated Placeholder; the real numbers are in ABILITY_TABLE (./abilities.ts). */
  abilities: Record<AbilitySlot, AbilityTuning>;
}

/** PLACEHOLDER for every ability until T-3.x. Each class gets its own copy for live tuning. */
function placeholderAbilities(): Record<AbilitySlot, AbilityTuning> {
  return {
    primary: { cooldownS: 0.2, damage: 8 },
    secondary: { cooldownS: 8, damage: 20 },
    utility: { cooldownS: 12, damage: 0 },
    ultimate: { cooldownS: 0, damage: 40 },
  };
}

/**
 * The doc gives only relative HP and speed (Talon: low / fastest, Bastion: high / slow,
 * Tempest: medium / medium, Wraith: low-med / fast in dives). First-pass numbers that keep that
 * ordering (T-3.1), tuned by playtest.
 */
export const CLASS_TUNING: Record<DragonClassId, ClassTuning> = {
  talon: {
    maxHp: 112,
    speedScale: 1.16,
    diveSpeedScale: 1.04,
    hitRadius: 2.5,
    turnScale: 1.1,
    abilities: placeholderAbilities(),
  },
  bastion: {
    maxHp: 168,
    speedScale: 0.9,
    diveSpeedScale: 1.0,
    hitRadius: 3.2,
    turnScale: 1,
    abilities: placeholderAbilities(),
  },
  tempest: {
    maxHp: 140,
    speedScale: 1.0,
    diveSpeedScale: 1.0,
    hitRadius: 2.8,
    turnScale: 1,
    abilities: placeholderAbilities(),
  },
  wraith: {
    maxHp: 120,
    speedScale: 1.08,
    diveSpeedScale: 1.18,
    hitRadius: 2.5,
    turnScale: 1.08,
    abilities: placeholderAbilities(),
  },
  verdant: {
    maxHp: 135,
    speedScale: 1.0,
    diveSpeedScale: 1.0,
    hitRadius: 2.7,
    turnScale: 1.02,
    abilities: placeholderAbilities(),
  },
  aureate: {
    maxHp: 125,
    speedScale: 1.06,
    diveSpeedScale: 1.05,
    hitRadius: 2.6,
    turnScale: 1.05,
    abilities: placeholderAbilities(),
  },
  zephyr: {
    maxHp: 98,
    speedScale: 1.2,
    diveSpeedScale: 1.1,
    hitRadius: 2.3,
    turnScale: 1.18,
    abilities: placeholderAbilities(),
  },
  granite: {
    maxHp: 185,
    speedScale: 0.86,
    diveSpeedScale: 0.95,
    hitRadius: 3.35,
    turnScale: 1,
    abilities: placeholderAbilities(),
  },
  mirage: {
    maxHp: 115,
    speedScale: 1.1,
    diveSpeedScale: 1.12,
    hitRadius: 2.5,
    turnScale: 1.1,
    abilities: placeholderAbilities(),
  },
};

// --- Match rules ---------------------------------------------------------------------------------

export interface MatchTuning {
  respawnDelayS: number;
  spawnProtectionS: number;
  deathCamS: number;
  /** Match intro length; always skippable (anyone → host advances for the room). */
  matchIntroS: number;
  /**
   * Seconds between the host pressing Start and the match beginning: the lobby is in its
   * `starting` phase and every browser plays the aerie take-off.
   */
  lobbyLaunchS: number;
  countdownS: number;
  /** Duel is best of this many rounds. */
  duelRounds: number;
  /** HP per second inside the storm wall. */
  stormDamagePerS: number;
  /** m/s² pushing a dragon back into the arena. */
  stormPushAccel: number;
}

export const MATCH_TUNING: MatchTuning = {
  respawnDelayS: 5, // doc
  spawnProtectionS: 2, // doc
  deathCamS: 3.5, // slightly longer dramatic orbit; skippable at once
  matchIntroS: 12, // multi-beat flyby + gates (~12 s)
  lobbyLaunchS: 3.5, // aerie take-off; skippable
  countdownS: 3, // doc (3-2-1)
  duelRounds: 5, // doc
  stormDamagePerS: 10, // PLACEHOLDER (T-3.x)
  stormPushAccel: 30, // PLACEHOLDER (T-3.x)
};

// --- Heat vents (T-6.4: read every tick by `applyHeatVents`, src/sim/flight.ts) --------------------
//
// Where each vent is, how wide and tall, and its own `lift` and `boost` are map data
// (`MapManifest.vents`). These are the numbers every vent shares. How strongly a point feels a
// vent ("strength", 0..1) is `heatVentStrength` in src/shared/maps/vents.ts.

export interface VentTuning {
  /**
   * Multiplier on a vent's `lift` (m/s² upward). The push goes into the burst velocity like a
   * flap's kick, so it fades at `FLIGHT_TUNING.burstDamping`: a dragon held on the axis rises
   * at `lift * liftScale / burstDamping` m/s on top of its own flight path.
   */
  liftScale: number;
  /** Multiplier on a vent's `boost` (m/s² along the nose): the free speed. */
  boostScale: number;
  /**
   * Stamina (0..1) regained per second at full strength, on top of the normal regeneration and
   * without its delay. At 0.25 a boost on the axis costs nothing.
   */
  staminaPerS: number;
  /**
   * The effect has full strength from the mouth up to this fraction of the column's height and
   * fades to nothing from there to the top, so a dragon is let go gently, not dropped.
   */
  fullHeightFraction: number;
}

/** First-pass feel values (T-6.4), tuned by playtest. */
export const VENT_TUNING: VentTuning = {
  liftScale: 4,
  boostScale: 2,
  staminaPerS: 0.25,
  fullHeightFraction: 0.6,
};
