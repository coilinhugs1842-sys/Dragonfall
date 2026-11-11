/**
 * Lobby state: what the host broadcasts on `ctrl` whenever it changes (docs/NETWORKING.md,
 * "Lobby protocol") and what the aerie scene and lobby panels show. It is rare, JSON-encoded
 * data, so plain arrays are fine here (no pooling).
 */

import type { DragonClassId } from './classes';
import { DRAGON_CLASS_IDS } from './classes';
import type { LobbySide, PlayerId, TeamId } from './constants';
import { MAX_PLAYERS, TEAM_EMBER, TEAM_FROST } from './constants';
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
  /**
   * A bot: either a rider the host added to fill a slot (`host.addBot`; flown by the host's sim
   * directly, it has no connection) or an in-page fake client (`?bots=N`). Views show both with
   * the same badge.
   */
  readonly isBot: boolean;
}

// --- Bot riders (T-3.10) --------------------------------------------------------------------------

/** How well the bots fly and fight. A match rule: every bot of the room uses it. */
export type BotDifficulty = 'easy' | 'normal' | 'hard';
/** Order is the display order (and the index a dev GUI or a wire format may use). Append only. */
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'normal';

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return typeof value === 'string' && (BOT_DIFFICULTIES as readonly string[]).includes(value);
}

/**
 * Names the host gives the riders it adds (`host.addBot`). Invented for this game; each fits
 * MAX_PLAYER_NAME_LENGTH. More names than seats, so a full room never repeats one.
 */
export const BOT_RIDER_NAMES: readonly string[] = [
  'Ashka',
  'Brennoch',
  'Cindrael',
  'Dravik',
  'Eskarin',
  'Fenwyth',
  'Galdris',
  'Hesperyn',
  'Ilvane',
  'Jorrund',
  'Kessim',
  'Lorvath',
  'Myrrin',
  'Nolveth',
  'Orsika',
  'Pyrrath',
  'Rhuvane',
  'Sylkar',
  'Tovrin',
  'Ulveth',
  'Vaskyr',
  'Wyndra',
  'Yssel',
  'Zharun',
];

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
  /** Skill of every bot rider in the match (T-3.10). */
  readonly botDifficulty: BotDifficulty;
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
  botDifficulty: DEFAULT_BOT_DIFFICULTY,
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

/**
 * The host's bot controls (T-3.10). Part of the lobby's intent set like `lobby.switchSide`; they
 * only ever come from the host's own panel, so they have no wire encoding (a client that sent
 * one would be refused as `notHost` anyway).
 */
/** Seats a bot rider on a team (refused when the team is full). `classId` omitted = host picks. */
export interface HostAddBotIntent {
  readonly type: 'host.addBot';
  readonly side: TeamId;
  readonly classId?: DragonClassId;
}
/** Removes one bot rider. Refused for a human (that is `host.kick`). */
export interface HostRemoveBotIntent {
  readonly type: 'host.removeBot';
  readonly playerId: PlayerId;
}
/** Seats a bot in every empty team slot (both teams up to `teamSize`). */
export interface HostFillBotsIntent {
  readonly type: 'host.fillBots';
}
/** Removes every bot rider the host added. */
export interface HostClearBotsIntent {
  readonly type: 'host.clearBots';
}
export interface HostSetBotDifficultyIntent {
  readonly type: 'host.setBotDifficulty';
  readonly difficulty: BotDifficulty;
}

export type LobbyBotIntent =
  | HostAddBotIntent
  | HostRemoveBotIntent
  | HostFillBotsIntent
  | HostClearBotsIntent
  | HostSetBotDifficultyIntent;

export const LOBBY_BOT_INTENT_TYPES: readonly LobbyBotIntent['type'][] = [
  'host.addBot',
  'host.removeBot',
  'host.fillBots',
  'host.clearBots',
  'host.setBotDifficulty',
];

/** True for the host's bot intents (they go to `applyLobbyIntent` without crossing the wire). */
export function isLobbyBotIntent(intent: { readonly type: string }): intent is LobbyBotIntent {
  return (LOBBY_BOT_INTENT_TYPES as readonly string[]).includes(intent.type);
}

/** A team a bot can be seated on (not the spectators). */
export function isBotSide(value: unknown): value is TeamId {
  return value === TEAM_EMBER || value === TEAM_FROST;
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
