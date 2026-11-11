/**
 * Lobby state: what the host broadcasts on `ctrl` whenever it changes (docs/NETWORKING.md,
 * "Lobby protocol") and what the aerie scene and lobby panels show. It is rare, JSON-encoded
 * data, so plain arrays are fine here (no pooling).
 */

import type { DragonClassId } from './classes';
import { DRAGON_CLASS_IDS } from './classes';
import type { LobbySide, PlayerId, TeamId } from './constants';
import { MAX_PLAYERS } from './constants';
import type { MapId, ModeId } from './match';

/** Longest player name the host accepts, in Unicode code points (the host sanitises names). */
export const MAX_PLAYER_NAME_LENGTH = 16;
/** Name given to a rider whose name is empty after sanitising. */
export const FALLBACK_PLAYER_NAME = 'Rider';

/**
 * Watchers the host admits on top of the riders. PLACEHOLDER: the docs only say "extra people
 * join as spectators"; each one costs the host a snapshot stream, so the number stays small.
 */
export const MAX_SPECTATORS = 6;
/** Most seats a lobby can hold; a `hello` beyond this is rejected as `full`. */
export const MAX_LOBBY_MEMBERS = MAX_PLAYERS + MAX_SPECTATORS;

/**
 * Where the room is: `lobby` = the aerie, everything editable; `starting` = Start was pressed and
 * the launch sequence plays (teams and settings are frozen); `inMatch` = until the results podium
 * hands everyone back to the aerie.
 */
export type LobbyPhase = 'lobby' | 'starting' | 'inMatch';
export const LOBBY_PHASES: readonly LobbyPhase[] = ['lobby', 'starting', 'inMatch'];

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
  /**
   * Host lobby tick (a 30 Hz count that never wraps, not the wire `u16`) at which a held slot is
   * freed; -1 while connected.
   */
  readonly reconnectDeadlineTick: number;
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

/**
 * Ranges the host clamps its panel values to. PLACEHOLDER until T-3.x tunes the modes; the time
 * limit may also be 0 (none).
 */
export const HOST_SETTING_LIMITS = {
  scoreLimitMin: 1,
  scoreLimitMax: 200,
  timeLimitMinS: 60,
  timeLimitMaxS: 30 * 60,
} as const;

export interface LobbyState {
  /** The 5-character code clients type to join. */
  readonly roomCode: string;
  readonly phase: LobbyPhase;
  readonly hostId: PlayerId;
  /** In join order (oldest first); the host is always first. */
  readonly players: readonly LobbyPlayer[];
  readonly settings: HostSettings;
}

/** Why the host answered `hello` with `reject`. */
export type RejectReason = 'full' | 'versionMismatch' | 'kicked' | 'matchInProgress';

/**
 * Any player asks to change sides themselves (refused while teams are locked or the side is
 * full). Part of the `UiIntent` union (`shared/ui.ts`); defined here because the host's lobby
 * logic names it too.
 */
export interface LobbySwitchSideIntent {
  readonly type: 'lobby.switchSide';
  readonly side: LobbySide;
}

// --- Match roster -------------------------------------------------------------------------------

/** One rider of the match the host is starting. */
export interface MatchRosterEntry {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly team: TeamId;
  readonly classId: DragonClassId;
  /** Index into the team's `SpawnGate.slots`; riders fill the fan from the centre outwards. */
  readonly gateSlot: number;
  readonly isBot: boolean;
}

/** What `host.start` produces: who flies where, under which rules. Frozen for the match. */
export interface MatchRoster {
  readonly settings: HostSettings;
  readonly riders: readonly MatchRosterEntry[];
  readonly spectators: readonly PlayerId[];
  /** One rider alone in the room: a free-flight sandbox with no opposing team. */
  readonly solo: boolean;
}
