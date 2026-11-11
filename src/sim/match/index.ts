/** The host's match rules (T-3.4): mode config, the phase timeline, Skirmish, Duel, the storm. */

export { MatchDirector, createMatchDirector } from './match-director';
export type { MatchDirectorListener, MatchDirectorOptions, MatchEndReason } from './match-director';
export { createModeConfig, isClassAllowed, roundsToWin } from './mode-config';
export type { ModeConfig, PlayableModeId } from './mode-config';
export { createStormRadii, writeDuelStorm } from './storm-schedule';
export type { MatchArena, StormRadii } from './storm-schedule';
