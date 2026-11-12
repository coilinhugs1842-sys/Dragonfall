/**
 * The host's match rules (T-3.4): mode config, the phase timeline, Skirmish, Duel, the storm,
 * and Ember Relay (T-6.3).
 */

export { MatchDirector, capturesOf, createMatchDirector } from './match-director';
export type {
  MatchDirectorListener,
  MatchDirectorOptions,
  MatchEndReason,
  MatchRiderStats,
} from './match-director';
export {
  createModeConfig,
  isClassAllowed,
  resolveScoreLimit,
  roundsToWin,
  scoreLimitRule,
} from './mode-config';
export type { ModeConfig, PlayableModeId, ScoreLimitRule } from './mode-config';
export { RelayRules } from './relay';
export { relayTerrainOf, settleInOpenAir, writeRelaySites } from './relay-sites';
export type { RelayArena, RelayTerrain } from './relay-sites';
export { createStormRadii, writeDuelStorm } from './storm-schedule';
export type { MatchArena, StormRadii } from './storm-schedule';
