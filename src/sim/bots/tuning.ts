/**
 * Every number of the bot riders (T-3.10): how they keep out of the rock and the storm, how
 * they choose and chase a target, when they use what, and what separates easy from hard.
 * Plain mutable data read live on every think, like the shared tuning tables, so the dev GUI
 * can edit it while a match runs. Only the host reads it (bots are flown by the host's sim or
 * by fake clients living next to it), so unlike the flight and ability tables it does not have
 * to match between machines.
 *
 * Units: seconds, metres, radians, fractions 0..1. Durations become whole ticks when used.
 */

import type { BotDifficulty } from '../../shared/lobby';

export interface BotTuning {
  // --- Thinking -----------------------------------------------------------------------------------
  /** Seconds between two re-plans (target choice, mode, abilities). Staggered per bot. */
  replanS: number;

  // --- Steering -----------------------------------------------------------------------------------
  /** Steer per radian of heading / pitch error. */
  yawGain: number;
  pitchGain: number;
  /** Heading error beyond which the roll button is held into the turn. */
  rollAssistAngle: number;
  /** Fractions of the tuned pitch limits the bot uses. */
  climbPitchFraction: number;
  divePitchFraction: number;

  // --- Terrain feelers ----------------------------------------------------------------------------
  /** Feeler length = speed * this + `feelerMin`. */
  feelerLookaheadS: number;
  feelerMin: number;
  /**
   * The four feelers parallel to the flight path start this many body radii to its left,
   * right, above and below.
   */
  feelerOffsetRadii: number;
  /** The wide pair fans out by this angle and is shorter by `feelerWideScale`. */
  feelerWideAngle: number;
  feelerWideScale: number;
  /** Heading change away from an obstacle at zero and at full urgency. */
  avoidTurnMin: number;
  avoidTurnMax: number;
  /** Pitch change over or under an obstacle at full urgency. */
  avoidPitch: number;
  /** Seconds a chosen side is kept once an obstacle made the bot turn. */
  avoidCommitS: number;
  /** Heading change away from rock beside the path while the way ahead is clear. */
  avoidSideTurn: number;
  /** Urgency (0..1) above which the bot stops boosting and diving. */
  avoidBoostCut: number;

  // --- Altitude band and storm --------------------------------------------------------------------
  /** Metres kept above the floor (the cloud sea) and under the ceiling. */
  bandLow: number;
  bandHigh: number;
  /** Seconds of vertical motion the band looks ahead. */
  bandLookaheadS: number;
  /** Radians of corrective pitch per metre past the band, and its cap. */
  bandPitchPerM: number;
  bandPitchMax: number;
  /** Metres kept inside the storm wall, capped at `stormMarginFraction` of its radius. */
  stormMargin: number;
  stormMarginFraction: number;
  /** Seconds of outward motion the storm check looks ahead. */
  stormLookaheadS: number;
  /** A target further than this outside the wall is not chased. */
  stormChaseSlack: number;

  // --- Speed --------------------------------------------------------------------------------------
  /** Speeds, as multiples of the stall speed, between which the climb limit goes 0 -> full. */
  climbSpeedLow: number;
  climbSpeedHigh: number;
  /** Climb pitch held without boost at cruise speed (does not bleed into a stall). */
  sustainedClimbPitch: number;
  /** Boost starts above and stops below these stamina levels. */
  boostStartStamina: number;
  boostStopStamina: number;
  /** A target further than this is chased with boost. */
  boostChaseRange: number;
  /** Folded-wing dive: only for a goal at least this far below, with this much air under it. */
  diveGoalDrop: number;
  diveMinAltitude: number;
  /** Wanted pitch below which the dive button is held. */
  divePitch: number;

  // --- Patrol (no target) -------------------------------------------------------------------------
  /** Circle flown, as a fraction of the storm radius, and where in the height band (0..1). */
  patrolRadiusFraction: number;
  patrolAltitudeFraction: number;
  /** Metres off the circle at which the bot heads straight back to it. */
  patrolCapture: number;
  /** Weave on top of the circle: amplitude (radians) and period (seconds). */
  patrolWeave: number;
  patrolWeaveS: number;

  // --- Targets ------------------------------------------------------------------------------------
  /** Beyond this an enemy counts as out of sight (still flown toward, never fired at). */
  sightRange: number;
  /** A veiled enemy is only seen within this range. */
  veilSightRange: number;
  /** A blinded bot only sees this far. */
  blindSightRange: number;
  /** Share of the score that does not depend on the target's health (1 = distance only). */
  targetHealthBias: number;
  /** Score multipliers (lower = preferred). */
  targetHiddenPenalty: number;
  targetStickiness: number;
  targetProtectedPenalty: number;

  // --- Pursuit ------------------------------------------------------------------------------------
  /** Cap on the lead time of a shot. */
  leadMaxS: number;
  /** Lead of the flight path itself when the primary is not a projectile. */
  pursuitLeadS: number;
  /** Fraction of a projectile's reach, or of a cone / beam range, at which the bot opens fire. */
  fireRangeFraction: number;
  /** Share of a cone's half angle that counts as "on target". */
  coneAimFraction: number;
  /** A veiled bot holds its fire until this fraction of its range (the ambush). */
  veilAmbushFraction: number;
  /**
   * A turning fight is broken off when the target stays more than `extendAngle` off the nose
   * within `extendRange` for `extendAfterS`: the bot flies straight for `extendS` and comes back.
   */
  extendAngle: number;
  extendRange: number;
  extendAfterS: number;
  extendS: number;
  /** Pitch held while the target is off the nose in such a fight (slower = tighter turn). */
  turnFightPitch: number;

  // --- Disengaging --------------------------------------------------------------------------------
  /** Only an enemy within this range makes a hurt bot break off. */
  retreatThreatRange: number;
  retreatS: number;
  /** Seconds before it may break off again. */
  retreatCooldownS: number;
  /** Close enough to the ally or gate it fled to. */
  retreatArriveRange: number;

  // --- Abilities ----------------------------------------------------------------------------------
  /** Seconds a hit is remembered as "under fire". */
  hurtMemoryS: number;
  /** Enemies that must be inside an area effect; fewer when fewer are alive. */
  areaMinTargets: number;
  /** Fraction of an area effect's radius or range that counts as inside. */
  areaFillFraction: number;
  /** An ally (or the bot itself) below this health fraction is worth a heal. */
  allyHurtFraction: number;
  /** Health fraction below which a hurt bot uses its escape. */
  escapeHealthFraction: number;
  /** An enemy behind within this range is a pursuer. */
  chasedRange: number;
  /** A veil is raised on the approach, between these ranges. */
  veilMinRange: number;
  veilMaxRange: number;
  /** A contact dash is used inside this extra reach (on top of its own). */
  dashReach: number;
  /** Cosine of the angle off the nose within which a dash or a wave is "lined up". */
  dashAimCos: number;
  /** Seconds to an obstacle at which a phase dive is used to pass through it. */
  phaseTerrainS: number;
  /** A bomb run needs the target at least this far below and within this horizontal reach. */
  bombDrop: number;
  bombReach: number;

  // --- Dodging ------------------------------------------------------------------------------------
  /** A projectile that will pass within this many metres inside `dodgeProjectileS` is dodged. */
  dodgeMissDistance: number;
  dodgeProjectileS: number;

  // --- Ember Relay (T-6.3) ------------------------------------------------------------------------
  /**
   * Share of a team's living riders that go for the enemy shard while it can be taken (the
   * ones nearest to it, at least one). The rest fight.
   */
  relayRunnerShare: number;
  /** Its own team's dropped shard within this range is fetched even if a mate is nearer. */
  relayReturnRange: number;
  /**
   * A dragon cannot turn on the spot: closer to a shard or brazier than `relayMinTurnM` with
   * it more than `relayTurnAngle` off the nose, the bot flies on and comes round again instead
   * of circling it for ever.
   */
  relayMinTurnM: number;
  relayTurnAngle: number;
  /** Target score multipliers (lower = preferred): the enemy carrying its team's shard... */
  relayCarrierBias: number;
  /** ...and an enemy within `relayEscortRange` of a mate who carries the enemy's. */
  relayEscortBias: number;
  relayEscortRange: number;
}

export const BOT_TUNING: BotTuning = {
  replanS: 0.33,

  yawGain: 2.2,
  pitchGain: 2.2,
  rollAssistAngle: 0.7,
  climbPitchFraction: 0.75,
  divePitchFraction: 0.75,

  feelerLookaheadS: 2.4,
  feelerMin: 40,
  feelerOffsetRadii: 3.5,
  feelerWideAngle: 0.85,
  feelerWideScale: 0.7,
  avoidTurnMin: 0.5,
  avoidTurnMax: 1.5,
  avoidPitch: 0.6,
  avoidCommitS: 1.2,
  avoidSideTurn: 0.7,
  avoidBoostCut: 0.25,

  bandLow: 80,
  bandHigh: 220,
  bandLookaheadS: 1.5,
  bandPitchPerM: 0.012,
  bandPitchMax: 0.6,
  stormMargin: 260,
  stormMarginFraction: 0.35,
  stormLookaheadS: 3,
  stormChaseSlack: 0,

  climbSpeedLow: 1.25,
  climbSpeedHigh: 1.7,
  sustainedClimbPitch: 0.28,
  boostStartStamina: 0.6,
  boostStopStamina: 0.3,
  boostChaseRange: 180,
  diveGoalDrop: 80,
  diveMinAltitude: 140,
  divePitch: -0.55,

  patrolRadiusFraction: 0.32,
  patrolAltitudeFraction: 0.36,
  patrolCapture: 250,
  patrolWeave: 0.3,
  patrolWeaveS: 7,

  sightRange: 700,
  veilSightRange: 60,
  blindSightRange: 90,
  targetHealthBias: 0.6,
  targetHiddenPenalty: 1.5,
  targetStickiness: 0.8,
  targetProtectedPenalty: 1.3,

  leadMaxS: 1.2,
  pursuitLeadS: 0.25,
  fireRangeFraction: 0.85,
  coneAimFraction: 0.75,
  veilAmbushFraction: 0.6,
  extendAngle: 1.2,
  extendRange: 240,
  extendAfterS: 3.5,
  extendS: 2.2,
  turnFightPitch: 0.25,

  retreatThreatRange: 320,
  retreatS: 5,
  retreatCooldownS: 14,
  retreatArriveRange: 140,

  hurtMemoryS: 1.5,
  areaMinTargets: 2,
  areaFillFraction: 0.8,
  allyHurtFraction: 0.65,
  escapeHealthFraction: 0.5,
  chasedRange: 160,
  veilMinRange: 130,
  veilMaxRange: 520,
  dashReach: 20,
  dashAimCos: 0.95,
  phaseTerrainS: 0.45,
  bombDrop: 15,
  bombReach: 150,

  dodgeMissDistance: 9,
  dodgeProjectileS: 0.45,

  relayRunnerShare: 0.5,
  relayReturnRange: 400,
  relayMinTurnM: 110,
  relayTurnAngle: 0.9,
  relayCarrierBias: 0.35,
  relayEscortBias: 0.6,
  relayEscortRange: 250,
};

/** What separates the difficulty levels. Everything else is shared by all bots. */
export interface BotDifficultyTuning {
  /** Seconds between seeing a new target (or regaining sight of it) and the first shot. */
  reactionS: number;
  /** Radians of aim error (a slow random wander of this size around the true aim). */
  aimError: number;
  /** Share of the true lead the bot applies (1 = perfect lead). */
  leadSkill: number;
  /** Chance per re-plan that an ability whose rule holds is actually used. */
  abilityUse: number;
  /** Chance that a hit or an incoming projectile is answered with a dodge roll. */
  dodgeChance: number;
  /** 0..1: scales the range at which it opens fire (0 = half range, 1 = full). */
  aggression: number;
  /** Health fraction below which it breaks off. */
  retreatHealth: number;
  /** It fires in bursts: this long on, this long off. */
  burstOnS: number;
  burstOffS: number;
}

/** First pass: a person who can fly should beat `normal` one on one more often than not. */
export const BOT_DIFFICULTY_TUNING: Record<BotDifficulty, BotDifficultyTuning> = {
  easy: {
    reactionS: 0.6,
    aimError: 0.11,
    leadSkill: 0.5,
    abilityUse: 0.3,
    dodgeChance: 0.15,
    aggression: 0.4,
    retreatHealth: 0.45,
    burstOnS: 1.0,
    burstOffS: 1.1,
  },
  normal: {
    reactionS: 0.32,
    aimError: 0.055,
    leadSkill: 0.85,
    abilityUse: 0.65,
    dodgeChance: 0.45,
    aggression: 0.75,
    retreatHealth: 0.3,
    burstOnS: 1.8,
    burstOffS: 0.5,
  },
  hard: {
    reactionS: 0.12,
    aimError: 0.02,
    leadSkill: 1,
    abilityUse: 1,
    dodgeChance: 0.85,
    aggression: 1,
    retreatHealth: 0.2,
    burstOnS: 3,
    burstOffS: 0.1,
  },
};
