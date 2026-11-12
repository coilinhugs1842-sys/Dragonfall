/**
 * Match-level ids shared by lobby settings, the match clock, events and manifests
 * (docs/GAME_DESIGN.md, "Modes", "Maps", "Flow").
 */

import type { TeamId } from './constants';

export type ModeId = 'skirmish' | 'duel' | 'emberRelay' | 'skyCrown';

export interface ModeInfo {
  readonly id: ModeId;
  readonly name: string;
  readonly minTeamSize: number;
  readonly maxTeamSize: number;
  /** False until the mode's phase lands, so the host panel can grey it out. */
  readonly available: boolean;
}

export const MODES: Readonly<Record<ModeId, ModeInfo>> = {
  skirmish: { id: 'skirmish', name: 'Skirmish', minTeamSize: 1, maxTeamSize: 5, available: true },
  duel: { id: 'duel', name: 'Duel', minTeamSize: 1, maxTeamSize: 2, available: true },
  // Phase 6.
  emberRelay: {
    id: 'emberRelay',
    name: 'Ember Relay',
    minTeamSize: 2,
    maxTeamSize: 5,
    available: true,
  },
  // Stretch goal.
  skyCrown: { id: 'skyCrown', name: 'Sky Crown', minTeamSize: 2, maxTeamSize: 5, available: false },
};

export type MapId = 'shattered-spires' | 'emberfall-caldera';

export interface MapInfo {
  readonly id: MapId;
  readonly name: string;
  /** False until the map ships (Emberfall Caldera is Phase 6). */
  readonly available: boolean;
}

export const MAPS: Readonly<Record<MapId, MapInfo>> = {
  'shattered-spires': { id: 'shattered-spires', name: 'Shattered Spires', available: true },
  'emberfall-caldera': { id: 'emberfall-caldera', name: 'Emberfall Caldera', available: true },
};

/**
 * Where the match is in its flow. `lobby` covers the aerie; `intro` is the map flyby;
 * `countdown` is the 3-2-1 before control is handed over; `roundEnd` is the pause between Duel
 * rounds; `results` is the podium.
 */
export type MatchPhase = 'lobby' | 'intro' | 'countdown' | 'playing' | 'roundEnd' | 'results';

/** Order is the wire encoding (index = `u8` phase id). Append only. */
export const MATCH_PHASES: readonly MatchPhase[] = [
  'lobby',
  'intro',
  'countdown',
  'playing',
  'roundEnd',
  'results',
];

/** A round or match can end level (time ran out on equal scores). */
export type MatchWinner = TeamId | 'draw';

// --- Mode rules (T-3.4) --------------------------------------------------------------------------
//
// The numbers the host's match rules (`src/sim/match`) read, live every tick: mutate them under
// ?debug to balance without a rebuild. What the lobby sets per match (score limit, time limit,
// friendly fire) is in `HostSettings`; what is fixed per mode is here.

export interface SkirmishTuning {
  /**
   * Seconds of sudden death when the time limit ends on equal scores: the next takedown wins.
   * Still level when it runs out = a draw. 0 = no overtime, a level match is a draw at once.
   */
  overtimeS: number;
}

export interface DuelTuning {
  /** Seconds a round may last. Then the team with more health left takes it. 0 = no limit. */
  roundTimeS: number;
  /**
   * Rounds played at most. A drawn round gives nobody a point and is replayed, so a match can
   * need more than MATCH_TUNING.duelRounds rounds; after this many it ends on the rounds won
   * (a draw if level).
   */
  maxRounds: number;
  /**
   * Storm wall radius at the start of each round, as a fraction of the map's own radius
   * (index = round - 1; later rounds reuse the last entry). The wall never starts inside the
   * spawn gates: see `stormGateMarginM`.
   */
  stormRoundFractions: number[];
  /** Seconds the wall holds its start radius before it closes in. */
  stormHoldS: number;
  /** Seconds the wall takes to close from the start radius to the end radius. */
  stormShrinkS: number;
  /** The radius the wall closes to, as a fraction of the map's own radius... */
  stormEndFraction: number;
  /** ...but never tighter than this many metres (a dragon must still be able to turn inside). */
  stormMinRadiusM: number;
  /** At the start of a round the wall is at least this far outside the furthest spawn slot. */
  stormGateMarginM: number;
  /**
   * A round that times out is a draw when the teams' health fractions (0..1, the average over
   * the team, a dead dragon counts 0) are closer than this.
   */
  healthTieEpsilon: number;
}

/**
 * Ember Relay (T-6.3): each team keeps a sky-shard on a stand at its base and a brazier beside
 * it. Fly through the enemy's shard to take it, carry it into your own brazier to score. The
 * rules are in `src/sim/match/relay.ts`; where the stands and braziers go is derived from the
 * spawn gates and the map centre in `src/sim/match/relay-sites.ts`.
 */
export interface EmberRelayTuning {
  /** Captures that win, as the lobby sets it when the mode is picked, and the most it allows. */
  defaultCaptures: number;
  maxCaptures: number;
  /**
   * Seconds of sudden death when the time limit ends on equal captures: the next capture wins.
   * Still level when it runs out = a draw. 0 = a level match is a draw at once.
   */
  overtimeS: number;
  /** A dragon this close to a shard (centre to centre, metres) touches it. */
  pickupRadiusM: number;
  /** A carrier this close to its own brazier scores. */
  captureRadiusM: number;
  /** The carrier's cruise and top speed are multiplied by this (the price of carrying). */
  carrierSpeedScale: number;
  /** Seconds a dropped shard lies where it fell before it goes home by itself. */
  dropReturnS: number;
  /**
   * True: a capture only counts while the team's own shard is on its stand. False (the
   * default): it always counts, so two carriers cannot hold the match up.
   */
  captureNeedsShardHome: boolean;
  /** The stand: metres from the team's gate toward the map centre, and to the gate's right. */
  standForwardM: number;
  standSideM: number;
  /** The brazier, likewise (a negative side = to the gate's left). */
  brazierForwardM: number;
  brazierSideM: number;
  /** Open air kept around a stand or a brazier, and around a dropped shard. */
  siteClearanceM: number;
  dropClearanceM: number;
  /** Stands, braziers and dropped shards stay this far above the map floor (the cloud sea)... */
  minAltitudeM: number;
  /** ...this far under the ceiling, and this far inside the storm wall. */
  ceilingMarginM: number;
  stormMarginM: number;
}

export interface ModeTuning {
  /** Seconds of `roundEnd`: the beat between a round's last takedown and what follows. */
  roundEndS: number;
  /** Seconds of `results` before everyone is taken back to the lobby. */
  resultsS: number;
  /**
   * A team that has riders but none of them connected for this long gives up the round (and in
   * Skirmish, which is one round, the match). A team with no riders left ends the match at
   * once. Same length as the reconnect grace (RECONNECT_GRACE_MS) by default.
   */
  forfeitGraceS: number;
  skirmish: SkirmishTuning;
  duel: DuelTuning;
  emberRelay: EmberRelayTuning;
}

/** First-pass numbers (T-3.4); tuned by playtest. */
export const MODE_TUNING: ModeTuning = {
  roundEndS: 4,
  resultsS: 12,
  forfeitGraceS: 30,
  skirmish: {
    overtimeS: 60,
  },
  duel: {
    roundTimeS: 120,
    maxRounds: 9,
    stormRoundFractions: [1, 0.85, 0.7, 0.55, 0.45],
    stormHoldS: 20,
    stormShrinkS: 80,
    stormEndFraction: 0.15,
    stormMinRadiusM: 120,
    stormGateMarginM: 60,
    healthTieEpsilon: 0.01,
  },
  // First-pass numbers (T-6.3); tuned by playtest.
  emberRelay: {
    defaultCaptures: 3,
    maxCaptures: 10,
    overtimeS: 60,
    pickupRadiusM: 14,
    captureRadiusM: 24,
    carrierSpeedScale: 0.85,
    dropReturnS: 20,
    captureNeedsShardHome: false,
    standForwardM: 180,
    standSideM: 40,
    brazierForwardM: 100,
    brazierSideM: -40,
    siteClearanceM: 30,
    dropClearanceM: 10,
    minAltitudeM: 80,
    ceilingMarginM: 80,
    stormMarginM: 120,
  },
};

/**
 * One rider's running totals for the scoreboard and the results podium. Counted by the host's
 * match rules only while a round is live (nothing after the final takedown counts).
 */
export interface MatchPlayerStats {
  playerId: number;
  team: TeamId;
  /** False once the rider left the match (the row is kept for the results). */
  present: boolean;
  takedowns: number;
  deaths: number;
  assists: number;
  /** HP of damage dealt to enemies. */
  damage: number;
  /** HP restored by this rider's healing effects (to anyone, itself included). */
  healing: number;
}

/**
 * Is a Skirmish in sudden death? The clock carries no flag for it: it is `playing` past the
 * time limit. (During overtime `timeRemainingS` counts the overtime down.)
 */
export function isOvertime(
  phase: MatchPhase,
  phaseTimeS: number,
  mode: ModeId,
  timeLimitS: number,
): boolean {
  // Ember Relay ends level games the same way: the next capture wins.
  const hasSuddenDeath = mode === 'skirmish' || mode === 'emberRelay';
  return hasSuddenDeath && phase === 'playing' && timeLimitS > 0 && phaseTimeS > timeLimitS;
}
