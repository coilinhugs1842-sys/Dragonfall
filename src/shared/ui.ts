/**
 * UiState / UiIntent: the only seam between `src/ui` and the rest of the game.
 * `src/game` builds a UiState and the UI renders it; the UI never reads sim or net objects.
 * Every action a menu or HUD can request is a UiIntent sent back to `src/game`, which applies
 * it locally or forwards it to the host.
 */

import type { AbilitySlot, DragonClassId } from './classes';
import type { LobbySide, PlayerId, TeamId } from './constants';
import type { HostSettings, LobbyState, LobbySwitchSideIntent, RejectReason } from './lobby';
import type { MapId, MatchPhase, MatchWinner, ModeId } from './match';
import type { QualityPresetId } from './quality';

// --- Settings -----------------------------------------------------------------------------------

/** How peers find each other (docs/NETWORKING.md, "Connection setup"). */
export type SignalingMode = 'online' | 'lan';

/** Optional TURN relay for networks that block peer-to-peer traffic. */
export interface TurnSettings {
  readonly url: string;
  readonly username: string;
  readonly credential: string;
}

export interface SettingsState {
  /** `auto` = use the result of the first-launch test flight. */
  readonly quality: QualityPresetId | 'auto';
  /** 0 = uncapped; 30/45 save battery and heat. */
  readonly fpsCap: 0 | 30 | 45;
  /** Volumes are 0..1. */
  readonly masterVolume: number;
  readonly musicVolume: number;
  readonly sfxVolume: number;
  readonly mouseSensitivity: number;
  readonly invertY: boolean;
  readonly signaling: SignalingMode;
  /** Host name or IP of the self-hosted PeerServer; used when `signaling` is `lan`. */
  readonly lanHost: string;
  readonly turn: TurnSettings | null;
  // Key rebinding is TBD in T-1.x (controls are "rebindable" per GAME_DESIGN.md).
}

export const DEFAULT_SETTINGS: SettingsState = {
  quality: 'auto',
  fpsCap: 0,
  masterVolume: 1,
  musicVolume: 0.7,
  sfxVolume: 1,
  mouseSensitivity: 1,
  invertY: false,
  signaling: 'online',
  lanHost: '',
  turn: null,
};

// --- State --------------------------------------------------------------------------------------

/** Which screen the app state machine is showing (docs/GAME_DESIGN.md, "Flow"). */
export type UiScreen = 'title' | 'connecting' | 'lobby' | 'loading' | 'match' | 'results';

export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly isHost: boolean;
  /** NO_PLAYER until the host has sent `welcome`. */
  readonly localPlayerId: PlayerId;
  /** Round trip to the host in ms (0 on the host). */
  readonly pingMs: number;
  /** Message for the title screen: a reject reason, "host left", a signaling failure. */
  readonly error: UiError | null;
}

/**
 * Why hosting or joining failed before a session existed. Mirrors the transport's error reasons
 * (`src/net/transport`), repeated here because `shared` cannot import `net`; a transport reason
 * is assignable as it stands.
 */
export type ConnectFailureReason =
  | 'roomNotFound'
  | 'idTaken'
  | 'brokerUnreachable'
  | 'peerUnavailable'
  | 'timeout'
  | 'invalidRoomCode'
  | 'unsupported'
  | 'unknown';

export type UiError =
  | { readonly kind: 'rejected'; readonly reason: RejectReason }
  | { readonly kind: 'hostLeft' }
  | { readonly kind: 'signalingFailed'; readonly detail: string }
  | { readonly kind: 'connectionLost' }
  /** Hosting or joining failed with a typed reason (preferred over `signalingFailed`). */
  | { readonly kind: 'connectFailed'; readonly reason: ConnectFailureReason }
  /** The host removed this player from a room they had already joined. */
  | { readonly kind: 'kicked' };

/**
 * Why Start is unavailable. Mirrors `StartBlocker` in `src/sim/lobby` (the UI cannot import the
 * sim); `src/game` passes `canStart(...).reason` straight through.
 */
export type UiStartBlocker =
  | 'wrongPhase'
  | 'noRiders'
  | 'teamEmpty'
  | 'teamTooSmall'
  | 'teamOverSize'
  | 'teamsUneven'
  | 'playerReconnecting'
  | 'notAllReady';

export interface LoadingState {
  /** 0..1. */
  readonly progress: number;
  readonly label: string;
}

export interface KillfeedEntry {
  /** NO_PLAYER for environment takedowns. */
  readonly killerId: PlayerId;
  readonly killerName: string;
  readonly killerTeam: TeamId | null;
  readonly victimId: PlayerId;
  readonly victimName: string;
  readonly victimTeam: TeamId;
  /** Seconds since it happened, so the HUD can fade it out. */
  readonly ageS: number;
}

export interface ScoreboardRow {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly team: TeamId;
  readonly classId: DragonClassId;
  readonly takedowns: number;
  readonly deaths: number;
  readonly damage: number;
  readonly pingMs: number;
  readonly alive: boolean;
}

/** The local rider's own gauges. */
export interface HudLocalState {
  readonly classId: DragonClassId;
  readonly alive: boolean;
  /** 0..1 fractions. */
  readonly health: number;
  readonly stamina: number;
  /** m/s. */
  readonly speed: number;
  /** 0..1; the ultimate is ready at 1. */
  readonly ultimateCharge: number;
  /** Cooldown left per ability as a 0..1 fraction (0 = ready). */
  readonly cooldowns: Readonly<Record<AbilitySlot, number>>;
  readonly dodgeCooldown: number;
  /** Seconds until respawn, 0 while alive. */
  readonly respawnInS: number;
  /** Death cam target, or NO_PLAYER. */
  readonly killerId: PlayerId;
}

export interface HudState {
  readonly mode: ModeId;
  readonly phase: MatchPhase;
  readonly round: number;
  /** Indexed by TeamId. Round wins in Duel, takedowns in Skirmish. */
  readonly scores: readonly [ember: number, frost: number];
  readonly scoreLimit: number;
  /** Seconds, or Infinity with no time limit. */
  readonly timeRemainingS: number;
  /** Whole seconds left on the 3-2-1, or 0 when not counting down. */
  readonly countdown: number;
  /** Null for spectators. */
  readonly local: HudLocalState | null;
  /** Newest first. */
  readonly killfeed: readonly KillfeedEntry[];
  readonly scoreboard: readonly ScoreboardRow[];
  /** True once this client may skip the intro (not on its first match). */
  readonly canSkipIntro: boolean;
}

/** TBD in T-5.x (results podium): awards beyond the three named in GAME_DESIGN.md. */
export interface ResultsState {
  readonly winner: MatchWinner;
  readonly scores: readonly [ember: number, frost: number];
  readonly mvpId: PlayerId;
  readonly mostTakedownsId: PlayerId;
  readonly mostDamageId: PlayerId;
  readonly scoreboard: readonly ScoreboardRow[];
}

export interface UiState {
  readonly screen: UiScreen;
  readonly connection: ConnectionState;
  readonly settings: SettingsState;
  /** Present on the lobby screen and kept through the match (teams persist). */
  readonly lobby: LobbyState | null;
  readonly loading: LoadingState | null;
  readonly hud: HudState | null;
  readonly results: ResultsState | null;
  /**
   * Lobby: why Start is unavailable, or null when the host may start. Absent = not computed (the
   * panel then leaves Start enabled and the host's own check decides).
   */
  readonly startBlocker?: UiStartBlocker | null;
  /**
   * Round trip per player in ms, indexed by PlayerId; a missing or negative entry = unknown.
   * `src/game` may mutate one array in place: the UI reads values, it does not keep the array.
   */
  readonly playerPings?: readonly number[];
  /** Match: the escape menu (resume / leave) is showing. */
  readonly pauseMenuOpen?: boolean;
}

// --- Intents ------------------------------------------------------------------------------------

/**
 * `host.*` intents only take effect for the host: the host checks the sender's player id and
 * ignores them from anyone else, so the UI hiding the host panel is a convenience, not security.
 */
export type UiIntent =
  // Title
  | { readonly type: 'title.host'; readonly name: string }
  | { readonly type: 'title.join'; readonly name: string; readonly roomCode: string }
  | { readonly type: 'title.dismissError' }
  /** Fly alone in the sandbox: no room, no network. */
  | { readonly type: 'title.solo'; readonly name: string }
  /** Abandon a host/join attempt that is still connecting. */
  | { readonly type: 'title.cancel' }
  // Lobby (any player)
  | { readonly type: 'lobby.ready'; readonly ready: boolean }
  | { readonly type: 'lobby.pickClass'; readonly classId: DragonClassId }
  /** Frames a player's perch in a close-up; null returns to the drifting camera. Local only. */
  | { readonly type: 'lobby.focusPlayer'; readonly playerId: PlayerId | null }
  | { readonly type: 'lobby.leave' }
  /** Change your own side; refused while teams are locked or the side is full. */
  | LobbySwitchSideIntent
  // Host panel
  | { readonly type: 'host.setMode'; readonly mode: ModeId }
  | { readonly type: 'host.setMap'; readonly map: MapId }
  | { readonly type: 'host.setTeamSize'; readonly teamSize: number }
  | { readonly type: 'host.setUnevenTeams'; readonly enabled: boolean }
  | { readonly type: 'host.setScoreLimit'; readonly scoreLimit: number }
  | { readonly type: 'host.setTimeLimit'; readonly timeLimitS: number }
  | { readonly type: 'host.setFriendlyFire'; readonly enabled: boolean }
  | { readonly type: 'host.setAllowedClasses'; readonly classes: readonly DragonClassId[] }
  | { readonly type: 'host.movePlayer'; readonly playerId: PlayerId; readonly side: LobbySide }
  | { readonly type: 'host.autoBalance' }
  | { readonly type: 'host.shuffle' }
  | { readonly type: 'host.lockTeams'; readonly locked: boolean }
  | { readonly type: 'host.kick'; readonly playerId: PlayerId }
  | { readonly type: 'host.start' }
  // Match
  | { readonly type: 'match.skipIntro' }
  | { readonly type: 'match.leave' }
  /**
   * Host only: end the running match and take the whole room back to the lobby (teams and seats
   * are kept, so the host can start again). Handled on the host's own page; a client has no
   * such button and nothing is sent. `match.leave` on the host closes the room instead.
   */
  | { readonly type: 'match.end' }
  /** Open / close the escape menu. Local only; the match keeps running (it is multiplayer). */
  | { readonly type: 'match.pause' }
  | { readonly type: 'match.resume' }
  // Settings (local; a patch so one intent covers every field)
  | { readonly type: 'settings.update'; readonly patch: Partial<SettingsState> }
  | { readonly type: 'settings.reset' };

export type UiIntentType = UiIntent['type'];
export type UiIntentOf<T extends UiIntentType> = Extract<UiIntent, { type: T }>;

/** How the UI hands intents to `src/game`. */
export type UiIntentHandler = (intent: UiIntent) => void;

/** True for intents the host must authorise against the sender's id. */
export function isHostIntent(intent: UiIntent): boolean {
  return intent.type.startsWith('host.');
}

/** Host-settings fields a `host.set*` intent may change; handy for a generic host panel. */
export type HostSettingKey = keyof HostSettings;
