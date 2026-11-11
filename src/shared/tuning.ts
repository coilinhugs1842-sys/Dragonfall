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

// --- Flight (TBD in T-1.x: the flight model fills in and may reshape the placeholders) -----------

export interface FlightTuning {
  /** m/s. Below this the dragon stalls. */
  stallSpeed: number;
  /** m/s. Level flight with no input settles here. */
  cruiseSpeed: number;
  /** m/s. Top speed in a full dive or boost. */
  maxSpeed: number;
  /** Seconds of damage immunity during a barrel-roll dodge. */
  dodgeImmunityS: number;
  dodgeCooldownS: number;
  /** m/s of sideways burst from a dodge. */
  dodgeImpulse: number;
  /** rad/s. */
  maxPitchRate: number;
  maxYawRate: number;
  maxRollRate: number;
  /** m/s² gained when boosting. */
  boostAccel: number;
  /** Stamina (0..1) spent per second of boost, and regained per second without it. */
  staminaDrainPerS: number;
  staminaRegenPerS: number;
  /** m/s of upward kick from a hard flap. */
  flapImpulse: number;
  /** Energy trade: m/s² gained per unit of dive (and lost per unit of climb). */
  gravityAccel: number;
  /** Fraction of speed kept after bouncing off terrain. */
  terrainBounceRestitution: number;
  /** m/s. A terrain hit above this speed is lethal. */
  terrainLethalSpeed: number;
}

export const FLIGHT_TUNING: FlightTuning = {
  stallSpeed: 25, // doc
  cruiseSpeed: 45, // doc
  maxSpeed: 95, // doc
  dodgeImmunityS: 0.25, // doc
  dodgeCooldownS: 4, // doc
  dodgeImpulse: 30, // PLACEHOLDER
  maxPitchRate: 1.6, // PLACEHOLDER
  maxYawRate: 1.2, // PLACEHOLDER
  maxRollRate: 3.0, // PLACEHOLDER
  boostAccel: 25, // PLACEHOLDER
  staminaDrainPerS: 0.25, // PLACEHOLDER
  staminaRegenPerS: 0.12, // PLACEHOLDER
  flapImpulse: 14, // PLACEHOLDER
  gravityAccel: 20, // PLACEHOLDER
  terrainBounceRestitution: 0.5, // PLACEHOLDER
  terrainLethalSpeed: 85, // PLACEHOLDER
};

// --- Classes (TBD in T-3.x: combat fills in ability numbers) ------------------------------------

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
  /** Metres. Radius of the hit sphere; capsule shapes are TBD in T-3.x. */
  hitRadius: number;
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
 * Tempest: medium / medium, Wraith: low-med / fast in dives). Every number is a PLACEHOLDER
 * that keeps that ordering.
 */
export const CLASS_TUNING: Record<DragonClassId, ClassTuning> = {
  talon: {
    maxHp: 100,
    speedScale: 1.1,
    diveSpeedScale: 1.0,
    hitRadius: 2.5,
    abilities: placeholderAbilities(),
  },
  bastion: {
    maxHp: 180,
    speedScale: 0.9,
    diveSpeedScale: 1.0,
    hitRadius: 3.2,
    abilities: placeholderAbilities(),
  },
  tempest: {
    maxHp: 140,
    speedScale: 1.0,
    diveSpeedScale: 1.0,
    hitRadius: 2.8,
    abilities: placeholderAbilities(),
  },
  wraith: {
    maxHp: 120,
    speedScale: 1.0,
    diveSpeedScale: 1.15,
    hitRadius: 2.5,
    abilities: placeholderAbilities(),
  },
};

// --- Match rules ---------------------------------------------------------------------------------

export interface MatchTuning {
  respawnDelayS: number;
  spawnProtectionS: number;
  deathCamS: number;
  /** Approximate; the intro is skippable after the first match. */
  matchIntroS: number;
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
  deathCamS: 3, // doc
  matchIntroS: 6, // doc (~6 s)
  countdownS: 3, // doc (3-2-1)
  duelRounds: 5, // doc
  stormDamagePerS: 10, // PLACEHOLDER (T-3.x)
  stormPushAccel: 30, // PLACEHOLDER (T-3.x)
};
