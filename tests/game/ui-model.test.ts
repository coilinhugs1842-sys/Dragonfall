import { describe, expect, it } from 'vitest';
import {
  applySessionFacts,
  connectionStatusFor,
  createSessionFacts,
  createUiState,
  peerConfigFor,
  uiScreenFor,
} from '../../src/game/ui-model';
import type { SessionFacts } from '../../src/game/ui-model';
import { DEFAULT_HOST_SETTINGS, NO_PLAYER } from '../../src/shared';
import type { LobbyState } from '../../src/shared';

const LOBBY: LobbyState = {
  roomCode: 'KH7P2',
  phase: 'lobby',
  hostId: 0,
  players: [],
  settings: DEFAULT_HOST_SETTINGS,
};

function facts(patch: Partial<SessionFacts>): SessionFacts {
  return { ...createSessionFacts(), ...patch };
}

describe('uiScreenFor / connectionStatusFor', () => {
  it('shows the title with no session', () => {
    const f = facts({});
    expect(uiScreenFor(f)).toBe('title');
    expect(connectionStatusFor(f)).toBe('offline');
  });

  it('shows the connecting body until the room exists', () => {
    for (const kind of ['host', 'client'] as const) {
      const f = facts({ kind, connecting: true });
      expect(uiScreenFor(f)).toBe('connecting');
      expect(connectionStatusFor(f)).toBe('connecting');
    }
    // Handshake done on the transport, WELCOME not here yet.
    expect(uiScreenFor(facts({ kind: 'client' }))).toBe('connecting');
  });

  it('shows the lobby once there is a lobby state, and the match while one runs', () => {
    const lobby = facts({ kind: 'client', lobby: LOBBY });
    expect(uiScreenFor(lobby)).toBe('lobby');
    expect(connectionStatusFor(lobby)).toBe('connected');
    const match = facts({ kind: 'host', lobby: LOBBY, inMatch: true });
    expect(uiScreenFor(match)).toBe('match');
    expect(connectionStatusFor(match)).toBe('connected');
  });

  it('keeps the screen and flags the link while reconnecting', () => {
    const inLobby = facts({ kind: 'client', lobby: LOBBY, reconnecting: true });
    expect(uiScreenFor(inLobby)).toBe('lobby');
    expect(connectionStatusFor(inLobby)).toBe('reconnecting');
    const inMatch = facts({ kind: 'client', lobby: LOBBY, reconnecting: true, inMatch: true });
    expect(uiScreenFor(inMatch)).toBe('match');
    expect(connectionStatusFor(inMatch)).toBe('reconnecting');
  });

  it('never shows the lobby or a connection chip for a solo flight', () => {
    const starting = facts({ kind: 'solo', lobby: LOBBY });
    expect(uiScreenFor(starting)).toBe('connecting');
    expect(connectionStatusFor(starting)).toBe('offline');
    const flying = facts({ kind: 'solo', lobby: LOBBY, inMatch: true });
    expect(uiScreenFor(flying)).toBe('match');
    expect(connectionStatusFor(flying)).toBe('offline');
  });
});

describe('applySessionFacts', () => {
  it('writes the session fields and marks host and solo as host', () => {
    const state = createUiState();
    applySessionFacts(state, facts({ kind: 'host', lobby: LOBBY }));
    expect(state.screen).toBe('lobby');
    expect(state.lobby).toBe(LOBBY);
    expect(state.connection.isHost).toBe(true);
    applySessionFacts(state, facts({ kind: 'client', lobby: LOBBY }));
    expect(state.connection.isHost).toBe(false);
    applySessionFacts(state, facts({ kind: 'solo', lobby: LOBBY, inMatch: true }));
    expect(state.connection.isHost).toBe(true);
  });

  it('clears everything a session left behind when there is none', () => {
    const state = createUiState();
    applySessionFacts(state, facts({ kind: 'client', lobby: LOBBY, inMatch: true }));
    state.connection.localPlayerId = 3;
    state.connection.pingMs = 42;
    state.startBlocker = 'notAllReady';
    state.playerPings = [1, 2, 3];
    state.pauseMenuOpen = true;
    state.connection.error = { kind: 'hostLeft' };

    applySessionFacts(state, facts({}));
    expect(state.screen).toBe('title');
    expect(state.lobby).toBeNull();
    expect(state.connection.localPlayerId).toBe(NO_PLAYER);
    expect(state.connection.pingMs).toBe(0);
    expect(state.startBlocker).toBeNull();
    expect(state.playerPings).toHaveLength(0);
    expect(state.pauseMenuOpen).toBe(false);
    // The error is the caller's: it is what the title or the notice shows next.
    expect(state.connection.error).toEqual({ kind: 'hostLeft' });
  });
});

describe('peerConfigFor', () => {
  it('uses the public broker online and the page host on the LAN', () => {
    expect(peerConfigFor('online', '', null, '192.168.1.20')).toEqual({
      signaling: { mode: 'cloud' },
      turn: null,
    });
    expect(peerConfigFor('lan', '', null, '192.168.1.20')).toEqual({
      signaling: { mode: 'lan', host: '192.168.1.20' },
      turn: null,
    });
  });

  it('prefers the LAN host from the settings and passes TURN through', () => {
    const config = peerConfigFor(
      'lan',
      '  10.0.0.5 ',
      { url: 'turn:relay.example:3478', username: 'u', credential: 'c' },
      'localhost',
    );
    expect(config.signaling).toEqual({ mode: 'lan', host: '10.0.0.5' });
    expect(config.turn).toEqual({
      urls: 'turn:relay.example:3478',
      username: 'u',
      credential: 'c',
    });
  });
});
