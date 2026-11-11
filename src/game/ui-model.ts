/**
 * From session facts to the UiState the menus draw (`src/shared/ui.ts`). Pure: no DOM, no
 * session objects, so the mapping is unit-tested in node.
 *
 * `src/game` keeps ONE mutable state object, rewrites its fields every frame and hands it to
 * `ui.update`, which compares against what it last wrote; nothing is allocated per frame.
 */

import { DEFAULT_SETTINGS, NO_PLAYER } from '../shared';
import type {
  ConnectFailureReason,
  ConnectionStatus,
  ControlsUiState,
  HudState,
  LoadingState,
  LobbyState,
  PlayerId,
  ResultsState,
  SettingsState,
  SettingsTab,
  SignalingMode,
  TurnSettings,
  UiError,
  UiScreen,
  UiStartBlocker,
} from '../shared';
import type { PeerTransportConfig } from '../net';

/** Which kind of session the page runs. `solo` is a host session with no network. */
export type RunKind = 'none' | 'solo' | 'host' | 'client';

/** What the mapping needs to know, gathered by `src/game` from whichever session is live. */
export interface SessionFacts {
  kind: RunKind;
  /** A host or join attempt has not answered yet (chunk loading, room opening, handshake). */
  connecting: boolean;
  /** The link dropped and the client is trying to get its seat back. */
  reconnecting: boolean;
  /** The match scene is (or stays) up. */
  inMatch: boolean;
  /** The lobby state the session holds, or null. */
  lobby: LobbyState | null;
}

export function createSessionFacts(): SessionFacts {
  return { kind: 'none', connecting: false, reconnecting: false, inMatch: false, lobby: null };
}

/**
 * - no session: the title (with an inline error or the session-ended notice over it);
 * - an attempt in flight: the title's connecting body;
 * - a solo flight never shows the lobby: it starts at once, so until the match is up it is
 *   still "connecting";
 * - otherwise the lobby, or the match while one runs.
 */
export function uiScreenFor(facts: Readonly<SessionFacts>): UiScreen {
  if (facts.kind === 'none') return 'title';
  if (facts.inMatch) return 'match';
  if (facts.connecting || facts.lobby === null || facts.kind === 'solo') return 'connecting';
  return 'lobby';
}

/** A solo flight is `offline`: no chip, no rejoin strip. */
export function connectionStatusFor(facts: Readonly<SessionFacts>): ConnectionStatus {
  if (facts.kind === 'none' || facts.kind === 'solo') return 'offline';
  if (facts.reconnecting) return 'reconnecting';
  if (facts.connecting || facts.lobby === null) return 'connecting';
  return 'connected';
}

/** A transport failure while hosting or joining, as the title's error banner wants it. */
export function connectFailure(reason: ConnectFailureReason): UiError {
  return { kind: 'connectFailed', reason };
}

/** `UiState` with every field writable. Structurally assignable to `UiState`. */
export interface MutableUiState {
  screen: UiScreen;
  connection: {
    status: ConnectionStatus;
    isHost: boolean;
    localPlayerId: PlayerId;
    pingMs: number;
    error: UiError | null;
  };
  settings: SettingsState;
  lobby: LobbyState | null;
  loading: LoadingState | null;
  hud: HudState | null;
  results: ResultsState | null;
  startBlocker: UiStartBlocker | null;
  playerPings: readonly number[];
  pauseMenuOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Absent until `src/game` has a binding table to show. */
  controls?: ControlsUiState;
}

const NO_PINGS: readonly number[] = Object.freeze([]);

export function createUiState(settings: SettingsState = DEFAULT_SETTINGS): MutableUiState {
  return {
    screen: 'title',
    connection: {
      status: 'offline',
      isHost: false,
      localPlayerId: NO_PLAYER,
      pingMs: 0,
      error: null,
    },
    settings,
    lobby: null,
    loading: null,
    hud: null,
    results: null,
    startBlocker: null,
    playerPings: NO_PINGS,
    pauseMenuOpen: false,
    settingsOpen: false,
    settingsTab: 'video',
  };
}

/** Rewrites the session-derived fields of `state`. The caller fills ids, pings and the blocker. */
export function applySessionFacts(
  state: MutableUiState,
  facts: Readonly<SessionFacts>,
): MutableUiState {
  state.screen = uiScreenFor(facts);
  state.connection.status = connectionStatusFor(facts);
  state.connection.isHost = facts.kind === 'host' || facts.kind === 'solo';
  // The lobby panel needs a lobby to draw; a solo flight has one but never shows it.
  state.lobby = facts.kind === 'none' ? null : facts.lobby;
  if (facts.kind === 'none') {
    state.connection.localPlayerId = NO_PLAYER;
    state.connection.pingMs = 0;
    state.startBlocker = null;
    state.playerPings = NO_PINGS;
    state.pauseMenuOpen = false;
  }
  return state;
}

/**
 * The PeerJS transport configuration for the player's settings. `pageHostname` is
 * `location.hostname`: in LAN mode the PeerServer runs on the machine that served the page
 * unless the settings name another host.
 */
export function peerConfigFor(
  signaling: SignalingMode,
  lanHost: string,
  turn: TurnSettings | null,
  pageHostname: string,
): PeerTransportConfig {
  const host = lanHost.trim() !== '' ? lanHost.trim() : pageHostname;
  return {
    signaling: signaling === 'lan' ? { mode: 'lan', host } : { mode: 'cloud' },
    turn:
      turn === null
        ? null
        : { urls: turn.url, username: turn.username, credential: turn.credential },
  };
}
