/**
 * Connection chip logic: ping → quality bars and label, and which overlay layers a UiState needs.
 * DOM-free; the screen manager writes the results to the page only when they change.
 */

import type { ConnectionStatus, UiScreen } from '../../shared/ui';

export const QUALITY_BARS = 4;

/** Round-trip thresholds in ms for 4, 3 and 2 bars; anything slower shows 1. */
export const PING_GOOD_MS = 60;
export const PING_FAIR_MS = 110;
export const PING_POOR_MS = 180;

/** 0 (no link / unknown) to QUALITY_BARS. The host has no link to itself and shows full bars. */
export function qualityBars(status: ConnectionStatus, isHost: boolean, pingMs: number): number {
  if (status !== 'connected') return 0;
  if (isHost) return QUALITY_BARS;
  if (!(pingMs >= 0)) return 0;
  if (pingMs <= PING_GOOD_MS) return 4;
  if (pingMs <= PING_FAIR_MS) return 3;
  if (pingMs <= PING_POOR_MS) return 2;
  return 1;
}

/** Bars for one lobby row from its ping alone (negative = unknown). */
export function pingBars(pingMs: number): number {
  if (!(pingMs >= 0)) return 0;
  if (pingMs <= PING_GOOD_MS) return 4;
  if (pingMs <= PING_FAIR_MS) return 3;
  if (pingMs <= PING_POOR_MS) return 2;
  return 1;
}

/** Whole ms for display, capped so a stalled link does not print a five-digit number. */
export function displayPing(pingMs: number): number {
  if (!(pingMs >= 0)) return -1;
  return Math.min(999, Math.round(pingMs));
}

export type ChipKind = 'hidden' | 'host' | 'ping' | 'connecting' | 'reconnecting';

export function chipKind(status: ConnectionStatus, isHost: boolean): ChipKind {
  switch (status) {
    case 'offline':
      return 'hidden';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'connected':
      return isHost ? 'host' : 'ping';
  }
}

/**
 * Who is looking at the escape menu, which decides what its buttons do:
 * - `host`: "End match" returns the room to the lobby, the other button closes the room for
 *   everyone, so it must not read like a guest's harmless "Leave match";
 * - `solo`: a flight alone, nothing to return to;
 * - `guest`: leaving only takes this player out.
 */
export type PauseRole = 'host' | 'solo' | 'guest';

/** A solo flight is a host with no network (`offline`). */
export function pauseRole(status: ConnectionStatus, isHost: boolean): PauseRole {
  if (!isHost) return 'guest';
  return status === 'offline' ? 'solo' : 'host';
}

/** Which top-level layers are showing. One mutable instance is reused every update. */
export interface LayerFlags {
  /** Title card, including its "connecting" body. */
  title: boolean;
  lobby: boolean;
  loading: boolean;
  /** Ping / quality chip in the corner. */
  chip: boolean;
  /** "Trying to rejoin" strip. */
  reconnecting: boolean;
  /** Escape menu. */
  pause: boolean;
  /** Full-screen "host left / connection lost / removed" card. */
  notice: boolean;
}

export function createLayerFlags(): LayerFlags {
  return {
    title: false,
    lobby: false,
    loading: false,
    chip: false,
    reconnecting: false,
    pause: false,
    notice: false,
  };
}

/**
 * Layer rules:
 * - a session-ending error covers whatever is on screen with the notice card, and hides the
 *   interactive layers underneath so nothing behind it can be clicked or focused;
 * - the lobby needs a lobby state to draw; until `welcome` arrives the title card keeps showing
 *   its connecting body;
 * - the chip and the rejoin strip only exist once there is a session (not on the title, not in a
 *   solo flight where the status is `offline`).
 */
export function computeLayers(
  out: LayerFlags,
  screen: UiScreen,
  status: ConnectionStatus,
  hasLobby: boolean,
  sessionEnded: boolean,
  pauseMenuOpen: boolean,
): LayerFlags {
  const inSession = screen !== 'title' && screen !== 'connecting';
  const lobby = screen === 'lobby' && hasLobby;
  out.notice = sessionEnded;
  out.title = screen === 'title' || screen === 'connecting' || (screen === 'lobby' && !hasLobby);
  out.lobby = lobby && !sessionEnded;
  out.loading = screen === 'loading';
  out.chip = inSession && status !== 'offline' && !sessionEnded;
  out.reconnecting = inSession && status === 'reconnecting' && !sessionEnded;
  out.pause = screen === 'match' && pauseMenuOpen && !sessionEnded;
  return out;
}
