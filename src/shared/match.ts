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
    available: false,
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
  'emberfall-caldera': { id: 'emberfall-caldera', name: 'Emberfall Caldera', available: false },
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
