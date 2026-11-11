/**
 * Lobby state: what the host broadcasts on `ctrl` whenever it changes (docs/NETWORKING.md,
 * "Lobby protocol") and what the aerie scene and lobby panels show. It is rare, JSON-encoded
 * data, so plain arrays are fine here (no pooling).
 */

import type { DragonClassId } from './classes';
import { DRAGON_CLASS_IDS } from './classes';
import type { LobbySide, PlayerId } from './constants';
import type { MapId, ModeId } from './match';

export interface LobbyPlayer {
  readonly id: PlayerId;
  readonly name: string;
  readonly side: LobbySide;
  /** Perch index on the team's terrace (0..MAX_TEAM_SIZE-1), or -1 for spectators. */
  readonly perch: number;
  readonly classId: DragonClassId;
  readonly ready: boolean;
  readonly isHost: boolean;
  /** False while the slot is being held for a reconnect. */
  readonly connected: boolean;
  /** In-page fake client (`?bots=N`) or bot rider. */
  readonly isBot: boolean;
}

/** Everything on the host panel (docs/GAME_DESIGN.md, "Cinematic lobby"). */
export interface HostSettings {
  readonly mode: ModeId;
  readonly map: MapId;
  /** Riders per side, MIN_TEAM_SIZE..MAX_TEAM_SIZE. */
  readonly teamSize: number;
  /** Allows e.g. 2v3. */
  readonly unevenTeams: boolean;
  /** Takedowns (or mode score) needed to win. */
  readonly scoreLimit: number;
  /** Seconds; 0 = no time limit. */
  readonly timeLimitS: number;
  readonly friendlyFire: boolean;
  readonly allowedClasses: readonly DragonClassId[];
  /** When locked, players cannot be moved between teams. */
  readonly teamsLocked: boolean;
}

/**
 * The doc fixes only the ranges (team size 1-5, matches of 6-10 min). Score and time limits
 * are PLACEHOLDER defaults until T-3.x tunes the modes.
 */
export const DEFAULT_HOST_SETTINGS: HostSettings = {
  mode: 'skirmish',
  map: 'shattered-spires',
  teamSize: 5,
  unevenTeams: false,
  scoreLimit: 30, // PLACEHOLDER
  timeLimitS: 8 * 60, // PLACEHOLDER (inside the 6-10 min window)
  friendlyFire: false,
  allowedClasses: DRAGON_CLASS_IDS,
  teamsLocked: false,
};

export interface LobbyState {
  /** The 5-character code clients type to join. */
  readonly roomCode: string;
  readonly hostId: PlayerId;
  readonly players: readonly LobbyPlayer[];
  readonly settings: HostSettings;
}

/** Why the host answered `hello` with `reject`. */
export type RejectReason = 'full' | 'versionMismatch' | 'kicked' | 'matchInProgress';
