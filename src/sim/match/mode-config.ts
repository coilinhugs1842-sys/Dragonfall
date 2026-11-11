/**
 * Lobby settings -> the rules of one match (T-3.4). The host panel's values were validated when
 * they were set (`sim/lobby/validate.ts`), but a match must never start on a broken rule set, so
 * everything is checked again here and forced into range: this is what the `MatchDirector` runs.
 * Called once per match start (it allocates; never call it per tick).
 */

import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_CLASS_IDS,
  HOST_SETTING_LIMITS,
  MATCH_TUNING,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  MODES,
  MODE_TUNING,
} from '../../shared';
import type { DragonClassId, HostSettings, MatchTuning, ModeId, ModeTuning } from '../../shared';

/** The modes that have rules today. Anything else in the settings falls back to Skirmish. */
export type PlayableModeId = 'skirmish' | 'duel';

export interface ModeConfig {
  readonly mode: PlayableModeId;
  /**
   * One rider alone in the room: free flight. No score limit, no clock, no forfeit; the match
   * lasts until the host ends it.
   */
  readonly sandbox: boolean;
  /** Riders per side, inside the mode's own range. */
  readonly teamSize: number;
  /** Points that win the match: takedowns in Skirmish, rounds in Duel. */
  readonly scoreLimit: number;
  /**
   * Skirmish: seconds of play, 0 = no limit. Duel: the round length at match start, for
   * display only (the director reads MODE_TUNING.duel.roundTimeS live).
   */
  readonly timeLimitS: number;
  /** Rounds played at most (1 in Skirmish). */
  readonly maxRounds: number;
  /** True: the dead come back after MATCH_TUNING.respawnDelayS. False (Duel): out until the next round. */
  readonly respawns: boolean;
  /** True: the storm wall follows the mode's schedule instead of the map's own radius. */
  readonly stormShrinks: boolean;
  readonly friendlyFire: boolean;
  /** Never empty. */
  readonly allowedClasses: readonly DragonClassId[];
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const whole = Math.round(value);
  return whole < min ? min : whole > max ? max : whole;
}

function isPlayable(mode: ModeId): mode is PlayableModeId {
  return (mode === 'skirmish' || mode === 'duel') && MODES[mode].available;
}

/** Rounds a team must win in a best-of-`rounds` (3 of 5). */
export function roundsToWin(rounds: number): number {
  const total = Number.isFinite(rounds) && rounds >= 1 ? Math.floor(rounds) : 1;
  return Math.floor(total / 2) + 1;
}

/**
 * @param solo `MatchRoster.solo`: one rider alone in the room.
 */
export function createModeConfig(
  settings: Readonly<HostSettings>,
  solo = false,
  matchTuning: Readonly<MatchTuning> = MATCH_TUNING,
  modeTuning: Readonly<ModeTuning> = MODE_TUNING,
): ModeConfig {
  const mode: PlayableModeId = isPlayable(settings.mode) ? settings.mode : 'skirmish';
  const info = MODES[mode];
  const teamSize = clampInt(
    settings.teamSize,
    Math.max(MIN_TEAM_SIZE, info.minTeamSize),
    Math.min(MAX_TEAM_SIZE, info.maxTeamSize),
    info.maxTeamSize,
  );

  const allowedClasses: DragonClassId[] = [];
  if (Array.isArray(settings.allowedClasses)) {
    for (const classId of DRAGON_CLASS_IDS) {
      if (settings.allowedClasses.includes(classId)) allowedClasses.push(classId);
    }
  }
  if (allowedClasses.length === 0) allowedClasses.push(...DRAGON_CLASS_IDS);

  const limits = HOST_SETTING_LIMITS;
  let scoreLimit: number;
  let timeLimitS: number;
  let maxRounds: number;
  if (mode === 'duel') {
    scoreLimit = roundsToWin(matchTuning.duelRounds);
    timeLimitS = modeTuning.duel.roundTimeS > 0 ? modeTuning.duel.roundTimeS : 0;
    // Never fewer rounds than it takes to win, never more than the round counter's `u8`.
    maxRounds = clampInt(modeTuning.duel.maxRounds, scoreLimit, 255, scoreLimit * 2 - 1);
  } else {
    scoreLimit = clampInt(
      settings.scoreLimit,
      limits.scoreLimitMin,
      limits.scoreLimitMax,
      DEFAULT_HOST_SETTINGS.scoreLimit,
    );
    timeLimitS =
      settings.timeLimitS === 0
        ? 0
        : clampInt(
            settings.timeLimitS,
            limits.timeLimitMinS,
            limits.timeLimitMaxS,
            DEFAULT_HOST_SETTINGS.timeLimitS,
          );
    maxRounds = 1;
  }

  return {
    mode,
    sandbox: solo,
    teamSize,
    scoreLimit,
    timeLimitS,
    maxRounds,
    respawns: mode === 'skirmish' || solo,
    stormShrinks: mode === 'duel' && !solo,
    friendlyFire: settings.friendlyFire === true,
    allowedClasses,
  };
}

/** May a rider fly `classId` under this config? (The lobby enforces it; this is the check.) */
export function isClassAllowed(config: ModeConfig, classId: DragonClassId): boolean {
  return config.allowedClasses.includes(classId);
}
