import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_CLASS_IDS,
  MAX_LOBBY_MEMBERS,
  MAX_SPECTATORS,
  PROTOCOL_VERSION,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../src/shared';
import type { LobbySide, LobbyState, PlayerId } from '../../src/shared';
import {
  HOST_PLAYER_ID,
  MAX_KICKED_TOKENS,
  RECONNECT_GRACE_TICKS,
  autoBalance,
  buildMatchRoster,
  canStart,
  countLobbySide,
  createLobby,
  disconnectPlayer,
  enterMatch,
  expireReconnects,
  findLobbyPlayer,
  handleHello,
  joinLobby,
  kickPlayer,
  launchMatch,
  leaveLobby,
  lockTeams,
  movePlayer,
  nextReconnectDeadline,
  pickClass,
  returnToLobby,
  setAllowedClasses,
  setFriendlyFire,
  setMap,
  setMode,
  setReady,
  setRoomCode,
  setScoreLimit,
  setTeamSize,
  setTimeLimit,
  setUnevenTeams,
  shuffleTeams,
  startMatch,
  switchSide,
} from '../../src/sim/lobby';
import type { AdmitResult, HostLobby, LobbyResult } from '../../src/sim/lobby';

const HOST = HOST_PLAYER_ID;

function newLobby(): HostLobby {
  return createLobby({ roomCode: 'ABCDE', hostName: 'Host' });
}

function must(result: LobbyResult): HostLobby {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.lobby;
}

function reasonOf(result: LobbyResult): string {
  return result.ok ? 'ok' : result.reason;
}

function admitted(result: AdmitResult): Extract<AdmitResult, { ok: true }> {
  if (!result.ok) throw new Error(`rejected: ${result.reject}`);
  return result;
}

/** Joins `count` players named P1.. with tokens tok-<id>. */
function withPlayers(lobby: HostLobby, count: number): HostLobby {
  let next = lobby;
  for (let i = 0; i < count; i++) {
    const n = next.state.players.length;
    next = admitted(joinLobby(next, { name: `P${n}`, token: `tok-${n}-${i}` })).lobby;
  }
  return next;
}

function sides(state: LobbyState): Record<string, number> {
  return {
    ember: countLobbySide(state.players, TEAM_EMBER),
    frost: countLobbySide(state.players, TEAM_FROST),
    spectator: countLobbySide(state.players, 'spectator'),
  };
}

function sideOf(lobby: HostLobby, id: PlayerId): LobbySide | undefined {
  return findLobbyPlayer(lobby.state, id)?.side;
}

function tokenOf(lobby: HostLobby, id: PlayerId): string {
  return lobby.seats.find((seat) => seat.id === id)?.token ?? '';
}

function readyAll(lobby: HostLobby): HostLobby {
  let next = lobby;
  for (const player of lobby.state.players) {
    if (player.side !== 'spectator' && !player.isHost) next = must(setReady(next, player.id, true));
  }
  return next;
}

function hello(lobby: HostLobby, token: string | undefined, tick: number, newToken = 'fresh') {
  return handleHello(
    lobby,
    { name: 'Back', protocolVersion: PROTOCOL_VERSION, reconnectToken: token },
    { tick, newToken },
  );
}

describe('createLobby', () => {
  it('seats the host on Ember with default settings', () => {
    const lobby = newLobby();
    expect(lobby.state.phase).toBe('lobby');
    expect(lobby.state.hostId).toBe(HOST);
    expect(lobby.state.settings).toEqual(DEFAULT_HOST_SETTINGS);
    expect(lobby.state.players).toEqual([
      {
        id: HOST,
        name: 'Host',
        side: TEAM_EMBER,
        perch: 0,
        classId: 'talon',
        ready: false,
        isHost: true,
        connected: true,
        reconnectDeadlineTick: -1,
        isBot: false,
      },
    ]);
  });

  it('clamps bad initial settings', () => {
    const lobby = createLobby({
      roomCode: 'ABCDE',
      hostName: '',
      settings: {
        ...DEFAULT_HOST_SETTINGS,
        mode: 'duel',
        map: 'emberfall-caldera',
        teamSize: 9,
        scoreLimit: -4,
        allowedClasses: [],
      },
    });
    expect(lobby.state.settings.mode).toBe('duel');
    expect(lobby.state.settings.map).toBe('shattered-spires');
    expect(lobby.state.settings.teamSize).toBe(2);
    expect(lobby.state.settings.scoreLimit).toBe(1);
    expect(lobby.state.settings.allowedClasses).toEqual(DRAGON_CLASS_IDS);
    expect(lobby.state.players[0]?.name).toBe('Rider');
  });

  it('can take its room code later', () => {
    const lobby = createLobby({ roomCode: '', hostName: 'Host' });
    const named = setRoomCode(lobby, 'QRSTU');
    expect(named).toMatchObject({ ok: true, changed: true });
    expect(named.lobby.state.roomCode).toBe('QRSTU');
    expect(setRoomCode(named.lobby, 'QRSTU').lobby).toBe(named.lobby);
  });

  it('survives a JSON round trip unchanged', () => {
    const lobby = withPlayers(newLobby(), 4);
    expect(JSON.parse(JSON.stringify(lobby))).toEqual(lobby);
  });
});

describe('join', () => {
  it('assigns to the smaller team, Ember on a tie, with ids and perches in order', () => {
    const lobby = withPlayers(newLobby(), 4);
    expect(lobby.state.players.map((p) => [p.id, p.side, p.perch])).toEqual([
      [0, TEAM_EMBER, 0],
      [1, TEAM_FROST, 0],
      [2, TEAM_EMBER, 1],
      [3, TEAM_FROST, 1],
      [4, TEAM_EMBER, 2],
    ]);
  });

  it('never mutates the lobby it was given', () => {
    const lobby = newLobby();
    const frozen = JSON.stringify(lobby);
    withPlayers(lobby, 3);
    expect(JSON.stringify(lobby)).toBe(frozen);
  });

  it('sends everyone past 10 players to the spectators, then rejects as full', () => {
    let lobby = withPlayers(newLobby(), 9);
    expect(sides(lobby.state)).toEqual({ ember: 5, frost: 5, spectator: 0 });
    const eleventh = admitted(joinLobby(lobby, { name: 'Eleven', token: 'e' }));
    expect(sideOf(eleventh.lobby, eleventh.playerId)).toBe('spectator');
    expect(findLobbyPlayer(eleventh.lobby.state, eleventh.playerId)?.perch).toBe(-1);
    lobby = withPlayers(eleventh.lobby, MAX_SPECTATORS - 1);
    expect(lobby.state.players).toHaveLength(MAX_LOBBY_MEMBERS);
    expect(sides(lobby.state)).toEqual({ ember: 5, frost: 5, spectator: MAX_SPECTATORS });
    const refused = joinLobby(lobby, { name: 'Late', token: 'late' });
    expect(refused).toEqual({ ok: false, lobby, reject: 'full' });
  });

  it('spectates beyond 2 x teamSize', () => {
    let lobby = must(setTeamSize(newLobby(), HOST, 2));
    lobby = withPlayers(lobby, 5);
    expect(sides(lobby.state)).toEqual({ ember: 2, frost: 2, spectator: 2 });
  });

  it('fills the gap a leaver left on the smaller team', () => {
    let lobby = withPlayers(newLobby(), 3); // E: 0,2  F: 1,3
    lobby = must(leaveLobby(lobby, 1));
    const joined = admitted(joinLobby(lobby, { name: 'New', token: 'n' }));
    expect(joined.playerId).toBe(1); // lowest free id is reused
    expect(sideOf(joined.lobby, 1)).toBe(TEAM_FROST);
    expect(findLobbyPlayer(joined.lobby.state, 1)?.perch).toBe(0);
    // Join order, not id order: the newcomer is last.
    expect(joined.lobby.state.players.map((p) => p.id)).toEqual([0, 2, 3, 1]);
  });

  it('spectates while teams are locked or a match is running', () => {
    const locked = must(lockTeams(newLobby(), HOST, true));
    const a = admitted(joinLobby(locked, { name: 'A', token: 'a' }));
    expect(sideOf(a.lobby, a.playerId)).toBe('spectator');

    let running = readyAll(withPlayers(newLobby(), 1));
    running = must(startMatch(running, HOST));
    const b = admitted(joinLobby(running, { name: 'B', token: 'b' }));
    expect(sideOf(b.lobby, b.playerId)).toBe('spectator');
    const full = withPlayers(b.lobby, MAX_SPECTATORS - 1);
    expect(joinLobby(full, { name: 'C', token: 'c' })).toMatchObject({
      ok: false,
      reject: 'matchInProgress',
    });
  });

  it('dedupes names and gives new players an allowed class', () => {
    let lobby = must(setAllowedClasses(newLobby(), HOST, ['wraith', 'bastion']));
    lobby = admitted(joinLobby(lobby, { name: ' host ', token: 'a' })).lobby;
    lobby = admitted(joinLobby(lobby, { name: 'HOST', token: 'b' })).lobby;
    expect(lobby.state.players.map((p) => p.name)).toEqual(['Host', 'host 2', 'HOST 3']);
    expect(lobby.state.players[1]?.classId).toBe('bastion');
  });

  it('throws on a token that is already in use (host bug)', () => {
    const lobby = admitted(joinLobby(newLobby(), { name: 'A', token: 'same' })).lobby;
    expect(() => joinLobby(lobby, { name: 'B', token: 'same' })).toThrow();
  });

  it('adds bots without a token', () => {
    let lobby = admitted(joinLobby(newLobby(), { name: 'Bot', token: '', isBot: true })).lobby;
    lobby = admitted(joinLobby(lobby, { name: 'Bot', token: '', isBot: true })).lobby;
    expect(lobby.state.players.filter((p) => p.isBot)).toHaveLength(2);
    // A dropped bot has nothing to reconnect with, so it is removed at once.
    const dropped = disconnectPlayer(lobby, 1, 10);
    expect(dropped.ok && dropped.effects).toEqual([
      { type: 'playerRemoved', playerId: 1, cause: 'left' },
    ]);
  });
});

describe('hello', () => {
  it('rejects a wrong protocol version', () => {
    const lobby = newLobby();
    const result = handleHello(
      lobby,
      { name: 'X', protocolVersion: PROTOCOL_VERSION + 1 },
      { tick: 0, newToken: 't' },
    );
    expect(result).toEqual({ ok: false, lobby, reject: 'versionMismatch' });
    expect(
      handleHello(lobby, { name: 'X', protocolVersion: '1' }, { tick: 0, newToken: 't' }),
    ).toMatchObject({ reject: 'versionMismatch' });
  });

  it('joins fresh under the new token, ignoring unknown or malformed tokens', () => {
    const lobby = newLobby();
    for (const token of [undefined, 'never-seen', '', 42, 'x'.repeat(500)]) {
      const result = admitted(
        handleHello(
          lobby,
          { name: 'New', protocolVersion: PROTOCOL_VERSION, reconnectToken: token },
          { tick: 0, newToken: 'fresh' },
        ),
      );
      expect(result.reconnected).toBe(false);
      expect(result.token).toBe('fresh');
      expect(result.playerId).toBe(1);
      expect(tokenOf(result.lobby, 1)).toBe('fresh');
    }
  });

  it('requires a usable new token for a fresh join', () => {
    expect(() => hello(newLobby(), undefined, 0, '')).toThrow();
  });
});

describe('leave, disconnect, reconnect', () => {
  it('frees a seat at once on leave', () => {
    const lobby = withPlayers(newLobby(), 2);
    const result = leaveLobby(lobby, 1);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      effects: [{ type: 'playerRemoved', playerId: 1, cause: 'left' }],
    });
    expect(findLobbyPlayer(result.lobby.state, 1)).toBeUndefined();
    expect(result.lobby.seats.map((s) => s.id)).toEqual([0, 2]);
    expect(reasonOf(leaveLobby(lobby, 77))).toBe('unknownPlayer');
  });

  it('closes the room when the host leaves, leaving the state untouched', () => {
    const lobby = withPlayers(newLobby(), 2);
    const result = leaveLobby(lobby, HOST);
    expect(result).toEqual({ ok: true, lobby, changed: false, effects: [{ type: 'lobbyClosed' }] });
  });

  it('holds a dropped seat with a deadline and clears ready', () => {
    let lobby = withPlayers(newLobby(), 2);
    lobby = must(setReady(lobby, 1, true));
    const dropped = must(disconnectPlayer(lobby, 1, 100));
    expect(findLobbyPlayer(dropped.state, 1)).toMatchObject({
      connected: false,
      ready: false,
      side: TEAM_FROST,
      perch: 0,
      reconnectDeadlineTick: 100 + RECONNECT_GRACE_TICKS,
    });
    expect(RECONNECT_GRACE_TICKS).toBe(900);
    expect(nextReconnectDeadline(dropped.state)).toBe(1000);
    expect(nextReconnectDeadline(lobby.state)).toBe(Infinity);
    // Dropping twice does not extend the deadline.
    const again = disconnectPlayer(dropped, 1, 500);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(again.lobby).toBe(dropped);
    expect(reasonOf(disconnectPlayer(lobby, HOST, 0))).toBe('isHost');
    expect(reasonOf(disconnectPlayer(lobby, 9, 0))).toBe('unknownPlayer');
  });

  it('gives the seat back on a reconnect inside the window', () => {
    let lobby = withPlayers(newLobby(), 2);
    lobby = must(pickClass(lobby, 1, 'wraith'));
    const token = tokenOf(lobby, 1);
    const dropped = must(disconnectPlayer(lobby, 1, 100));
    const back = admitted(hello(dropped, token, 100 + RECONNECT_GRACE_TICKS - 1));
    expect(back).toMatchObject({ reconnected: true, playerId: 1, token, changed: true });
    expect(findLobbyPlayer(back.lobby.state, 1)).toMatchObject({
      name: 'P1',
      classId: 'wraith',
      side: TEAM_FROST,
      perch: 0,
      connected: true,
      ready: false,
      reconnectDeadlineTick: -1,
    });
    expect(back.lobby.state.players).toHaveLength(3);
  });

  it('frees the seat after 30 s; a late reconnect is a fresh join', () => {
    const lobby = withPlayers(newLobby(), 2);
    const token = tokenOf(lobby, 1);
    const dropped = must(disconnectPlayer(lobby, 1, 100));
    const deadline = 100 + RECONNECT_GRACE_TICKS;

    const early = expireReconnects(dropped, deadline - 1);
    expect(early).toMatchObject({ ok: true, changed: false, effects: [] });
    expect(early.lobby).toBe(dropped);

    const expired = expireReconnects(dropped, deadline);
    expect(expired).toMatchObject({
      ok: true,
      changed: true,
      effects: [{ type: 'playerRemoved', playerId: 1, cause: 'timedOut' }],
    });
    expect(findLobbyPlayer(expired.lobby.state, 1)).toBeUndefined();
    expect(expired.lobby.seats.some((s) => s.token === token)).toBe(false);

    // The hello itself expires the seat even if the host has not polled yet.
    const late = admitted(hello(dropped, token, deadline, 'brand-new'));
    expect(late.reconnected).toBe(false);
    expect(late.token).toBe('brand-new');
    expect(late.effects).toEqual([{ type: 'playerRemoved', playerId: 1, cause: 'timedOut' }]);
    expect(findLobbyPlayer(late.lobby.state, late.playerId)?.name).toBe('Back');
    expect(late.lobby.state.players).toHaveLength(3);
  });

  it('does not let a copied token steal a connected seat', () => {
    const lobby = withPlayers(newLobby(), 1);
    const result = admitted(hello(lobby, tokenOf(lobby, 1), 5, 'second-tab'));
    expect(result.reconnected).toBe(false);
    expect(result.playerId).toBe(2);
    expect(tokenOf(result.lobby, 1)).not.toBe('second-tab');
  });

  it('keeps a rider seat through a match and rejoins it', () => {
    let lobby = readyAll(withPlayers(newLobby(), 1));
    lobby = must(enterMatch(must(startMatch(lobby, HOST))));
    const token = tokenOf(lobby, 1);
    lobby = must(disconnectPlayer(lobby, 1, 50));
    const back = admitted(hello(lobby, token, 60));
    expect(back.reconnected).toBe(true);
    expect(sideOf(back.lobby, 1)).toBe(TEAM_FROST);
  });
});

describe('kick', () => {
  it('removes the player and bans their token', () => {
    const lobby = withPlayers(newLobby(), 2);
    const token = tokenOf(lobby, 2);
    const result = kickPlayer(lobby, HOST, 2);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      effects: [{ type: 'playerRemoved', playerId: 2, cause: 'kicked' }],
    });
    const after = result.lobby;
    expect(findLobbyPlayer(after.state, 2)).toBeUndefined();
    expect(after.kickedTokens).toEqual([token]);
    expect(hello(after, token, 0)).toEqual({ ok: false, lobby: after, reject: 'kicked' });
    // Without the token they are just a new player (the host is trusted among friends).
    expect(hello(after, undefined, 0).ok).toBe(true);
  });

  it('bans the browser too, so a new tab without the token stays out', () => {
    const say = (lobby: HostLobby, clientId: unknown, token?: string) =>
      handleHello(
        lobby,
        { name: 'Tab', protocolVersion: PROTOCOL_VERSION, reconnectToken: token, clientId },
        { tick: 0, newToken: `fresh-${lobby.seats.length}-${lobby.kickedTokens.length}` },
      );
    // Two tabs of one browser (same client id) and a friend on another machine.
    let lobby = admitted(say(newLobby(), 'browser-a')).lobby;
    lobby = admitted(say(lobby, 'browser-a')).lobby;
    lobby = admitted(say(lobby, 'browser-b')).lobby;
    const siblingToken = tokenOf(lobby, 2);
    const kickedToken = tokenOf(lobby, 1);

    lobby = must(kickPlayer(lobby, HOST, 1));
    expect(lobby.kickedTokens).toEqual([kickedToken, 'browser-a']);
    // A new tab of the kicked browser: no token, same id.
    expect(say(lobby, 'browser-a')).toEqual({ ok: false, lobby, reject: 'kicked' });
    // Other browsers, and a client that sends no id, are new players as before.
    expect(say(lobby, 'browser-c').ok).toBe(true);
    expect(say(lobby, undefined).ok).toBe(true);
    expect(say(lobby, 42).ok).toBe(true);

    // The sibling tab was not kicked: it keeps its seat and gets it back after a drop.
    expect(findLobbyPlayer(lobby.state, 2)?.connected).toBe(true);
    lobby = must(disconnectPlayer(lobby, 2, 10));
    const back = admitted(say(lobby, 'browser-a', siblingToken));
    expect(back.reconnected).toBe(true);
    expect(back.playerId).toBe(2);

    // Kicking the sibling as well does not list the id twice.
    lobby = must(kickPlayer(back.lobby, HOST, 2));
    expect(lobby.kickedTokens).toEqual([kickedToken, 'browser-a', siblingToken]);
  });

  it('is host-only and cannot target the host or a stranger', () => {
    const lobby = withPlayers(newLobby(), 2);
    expect(reasonOf(kickPlayer(lobby, 1, 2))).toBe('notHost');
    expect(reasonOf(kickPlayer(lobby, 1, HOST))).toBe('notHost');
    expect(reasonOf(kickPlayer(lobby, HOST, HOST))).toBe('isHost');
    expect(reasonOf(kickPlayer(lobby, HOST, 42))).toBe('unknownPlayer');
    expect(reasonOf(kickPlayer(lobby, 42, 1))).toBe('unknownActor');
  });

  it('works on a held seat and during a match, and caps the ban list', () => {
    let lobby = readyAll(withPlayers(newLobby(), 1));
    lobby = must(startMatch(lobby, HOST));
    lobby = must(disconnectPlayer(lobby, 1, 0));
    lobby = must(kickPlayer(lobby, HOST, 1));
    expect(lobby.state.players).toHaveLength(1);

    let many = newLobby();
    for (let i = 0; i < MAX_KICKED_TOKENS + 3; i++) {
      many = admitted(joinLobby(many, { name: 'K', token: `k${i}` })).lobby;
      many = must(kickPlayer(many, HOST, 1));
    }
    expect(many.kickedTokens).toHaveLength(MAX_KICKED_TOKENS);
    expect(many.kickedTokens[0]).toBe('k3');
  });
});

describe('team size and uneven teams', () => {
  it('moves the newest overflow to the spectators when shrinking', () => {
    let lobby = withPlayers(newLobby(), 9); // E: 0 2 4 6 8, F: 1 3 5 7 9
    lobby = readyAll(lobby);
    lobby = must(setTeamSize(lobby, HOST, 2));
    expect(lobby.state.settings.teamSize).toBe(2);
    const ids = (side: LobbySide): number[] =>
      lobby.state.players.filter((p) => p.side === side).map((p) => p.id);
    expect(ids(TEAM_EMBER)).toEqual([0, 2]);
    expect(ids(TEAM_FROST)).toEqual([1, 3]);
    expect(ids('spectator')).toEqual([4, 5, 6, 7, 8, 9]);
    for (const id of ids('spectator')) {
      expect(findLobbyPlayer(lobby.state, id)).toMatchObject({ perch: -1, ready: false });
    }
    // Those who stayed keep their ready flag.
    expect(findLobbyPlayer(lobby.state, 2)?.ready).toBe(true);
    // Growing again does not pull anyone back.
    lobby = must(setTeamSize(lobby, HOST, 5));
    expect(sides(lobby.state)).toEqual({ ember: 2, frost: 2, spectator: 6 });
  });

  it('is deterministic about who overflows after side switches', () => {
    let lobby = withPlayers(newLobby(), 3); // E: 0 2, F: 1 3
    lobby = must(switchSide(lobby, 1, TEAM_EMBER)); // E: 0 1 2, F: 3
    lobby = must(setTeamSize(lobby, HOST, 1));
    expect(sideOf(lobby, 0)).toBe(TEAM_EMBER);
    expect(sideOf(lobby, 1)).toBe('spectator');
    expect(sideOf(lobby, 2)).toBe('spectator');
    expect(sideOf(lobby, 3)).toBe(TEAM_FROST);
  });

  it('rounds and clamps the size, refuses non-numbers and non-hosts', () => {
    const lobby = withPlayers(newLobby(), 1);
    expect(must(setTeamSize(lobby, HOST, 99)).state.settings.teamSize).toBe(5);
    expect(must(setTeamSize(lobby, HOST, -3)).state.settings.teamSize).toBe(1);
    expect(must(setTeamSize(lobby, HOST, 2.6)).state.settings.teamSize).toBe(3);
    expect(reasonOf(setTeamSize(lobby, HOST, Number.NaN))).toBe('invalidValue');
    expect(reasonOf(setTeamSize(lobby, HOST, '3' as unknown as number))).toBe('invalidValue');
    expect(reasonOf(setTeamSize(lobby, 1, 3))).toBe('notHost');
    const same = setTeamSize(lobby, HOST, 5);
    expect(same).toMatchObject({ ok: true, changed: false });
    expect(same.lobby).toBe(lobby);
  });

  it('toggles uneven teams, which decides whether 1v2 may start', () => {
    let lobby = withPlayers(newLobby(), 2); // E: 0 2, F: 1
    lobby = readyAll(lobby);
    expect(canStart(lobby.state)).toEqual({ ok: false, reason: 'teamsUneven' });
    expect(reasonOf(setUnevenTeams(lobby, 1, true))).toBe('notHost');
    expect(reasonOf(setUnevenTeams(lobby, HOST, 1 as unknown as boolean))).toBe('invalidValue');
    lobby = must(setUnevenTeams(lobby, HOST, true));
    expect(lobby.state.settings.unevenTeams).toBe(true);
    expect(canStart(lobby.state)).toEqual({ ok: true, solo: false });
    lobby = must(setUnevenTeams(lobby, HOST, false));
    expect(canStart(lobby.state).ok).toBe(false);
  });
});

describe('moving between sides', () => {
  it('lets the host drag players, respecting the team size', () => {
    let lobby = must(setTeamSize(newLobby(), HOST, 2));
    lobby = withPlayers(lobby, 4); // E: 0 2, F: 1 3, S: 4
    lobby = must(setReady(lobby, 3, true));
    expect(reasonOf(movePlayer(lobby, HOST, 4, TEAM_EMBER))).toBe('teamFull');
    expect(reasonOf(movePlayer(lobby, HOST, 3, TEAM_EMBER))).toBe('teamFull');
    lobby = must(movePlayer(lobby, HOST, 3, 'spectator'));
    expect(findLobbyPlayer(lobby.state, 3)).toMatchObject({
      side: 'spectator',
      perch: -1,
      ready: false,
    });
    lobby = must(movePlayer(lobby, HOST, 4, TEAM_FROST));
    expect(findLobbyPlayer(lobby.state, 4)).toMatchObject({ side: TEAM_FROST, perch: 1 });
    // The host may move itself too.
    lobby = must(movePlayer(lobby, HOST, HOST, 'spectator'));
    expect(sideOf(lobby, HOST)).toBe('spectator');
    expect(lobby.state.players[0]?.isHost).toBe(true);
  });

  it('refuses illegal moves', () => {
    const lobby = withPlayers(newLobby(), 2);
    expect(reasonOf(movePlayer(lobby, 1, 2, TEAM_FROST))).toBe('notHost');
    expect(reasonOf(movePlayer(lobby, HOST, 50, TEAM_FROST))).toBe('unknownPlayer');
    expect(reasonOf(movePlayer(lobby, HOST, 1, 2 as unknown as LobbySide))).toBe('invalidValue');
    const same = movePlayer(lobby, HOST, 1, TEAM_FROST);
    expect(same).toMatchObject({ ok: true, changed: false });
    const locked = must(lockTeams(lobby, HOST, true));
    expect(reasonOf(movePlayer(locked, HOST, 1, TEAM_EMBER))).toBe('teamsLocked');
  });

  it('lets a player switch sides only when unlocked and there is room', () => {
    let lobby = must(setTeamSize(newLobby(), HOST, 2));
    lobby = withPlayers(lobby, 3); // E: 0 2, F: 1 3
    lobby = must(setReady(lobby, 3, true));
    expect(reasonOf(switchSide(lobby, 3, TEAM_EMBER))).toBe('teamFull');
    expect(reasonOf(switchSide(lobby, 3, 'nowhere' as unknown as LobbySide))).toBe('invalidValue');
    expect(reasonOf(switchSide(lobby, 60, TEAM_EMBER))).toBe('unknownActor');
    lobby = must(switchSide(lobby, 2, 'spectator'));
    lobby = must(switchSide(lobby, 3, TEAM_EMBER));
    expect(findLobbyPlayer(lobby.state, 3)).toMatchObject({
      side: TEAM_EMBER,
      perch: 1,
      ready: false,
    });
    const locked = must(lockTeams(lobby, HOST, true));
    expect(reasonOf(switchSide(locked, 2, TEAM_FROST))).toBe('teamsLocked');
    expect(reasonOf(switchSide(locked, HOST, TEAM_FROST))).toBe('teamsLocked');
    const unlocked = must(lockTeams(locked, HOST, false));
    expect(sideOf(must(switchSide(unlocked, 2, TEAM_FROST)), 2)).toBe(TEAM_FROST);
    expect(reasonOf(lockTeams(lobby, 2, true))).toBe('notHost');
  });

  it('refuses a disconnected actor', () => {
    let lobby = withPlayers(newLobby(), 1);
    lobby = must(disconnectPlayer(lobby, 1, 0));
    expect(reasonOf(switchSide(lobby, 1, TEAM_EMBER))).toBe('unknownActor');
    expect(reasonOf(setReady(lobby, 1, true))).toBe('unknownActor');
    expect(reasonOf(pickClass(lobby, 1, 'wraith'))).toBe('unknownActor');
  });
});

describe('autoBalance', () => {
  it('evens out lopsided teams by moving the newest riders', () => {
    let lobby = withPlayers(newLobby(), 5); // E: 0 2 4, F: 1 3 5
    lobby = must(movePlayer(lobby, HOST, 1, TEAM_EMBER));
    lobby = must(movePlayer(lobby, HOST, 3, TEAM_EMBER)); // E: 0 1 2 3 4, F: 5
    lobby = readyAll(lobby);
    const balanced = must(autoBalance(lobby, HOST));
    expect(sides(balanced.state)).toEqual({ ember: 3, frost: 3, spectator: 0 });
    expect(sideOf(balanced, 4)).toBe(TEAM_FROST);
    expect(sideOf(balanced, 3)).toBe(TEAM_FROST);
    expect(findLobbyPlayer(balanced.state, 4)?.ready).toBe(false);
    expect(findLobbyPlayer(balanced.state, 2)?.ready).toBe(true);
    const perches = balanced.state.players.filter((p) => p.side === TEAM_FROST).map((p) => p.perch);
    expect(new Set(perches).size).toBe(perches.length);
  });

  it('leaves at most one of difference for every split, and spectators alone', () => {
    for (let total = 1; total <= 10; total++) {
      for (let ember = Math.max(0, total - 5); ember <= Math.min(5, total); ember++) {
        let lobby = withPlayers(newLobby(), total + 1);
        // Everyone to the spectators first, then build the exact split.
        for (const p of lobby.state.players)
          lobby = must(movePlayer(lobby, HOST, p.id, 'spectator'));
        const riders = lobby.state.players.slice(0, total);
        riders.forEach((p, i) => {
          lobby = must(movePlayer(lobby, HOST, p.id, i < ember ? TEAM_EMBER : TEAM_FROST));
        });
        const result = autoBalance(lobby, HOST);
        const after = sides(must(result).state);
        expect(Math.abs((after.ember ?? 0) - (after.frost ?? 0))).toBeLessThanOrEqual(1);
        expect((after.ember ?? 0) + (after.frost ?? 0)).toBe(total);
        expect(after.spectator).toBe(2);
        if (Math.abs(ember - (total - ember)) <= 1) expect(result.lobby).toBe(lobby);
      }
    }
  });

  it('is host-only and respects the lock', () => {
    const lobby = withPlayers(newLobby(), 2);
    expect(reasonOf(autoBalance(lobby, 1))).toBe('notHost');
    expect(reasonOf(autoBalance(must(lockTeams(lobby, HOST, true)), HOST))).toBe('teamsLocked');
  });
});

describe('shuffle', () => {
  function lopsided(): HostLobby {
    let lobby = withPlayers(newLobby(), 8); // 9 riders: E 5, F 4 ... then a spectator
    lobby = must(movePlayer(lobby, HOST, 8, 'spectator')); // E 4, F 4, S 1
    lobby = must(movePlayer(lobby, HOST, 7, 'spectator')); // E 4, F 3, S 2
    return lobby;
  }

  it('is deterministic for a seed and differs across seeds', () => {
    const lobby = lopsided();
    const a = must(shuffleTeams(lobby, HOST, 1234));
    const b = must(shuffleTeams(lobby, HOST, 1234));
    expect(a.state).toEqual(b.state);
    const layouts = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const shuffled = must(shuffleTeams(lobby, HOST, seed));
      layouts.add(shuffled.state.players.map((p) => p.side).join(','));
    }
    expect(layouts.size).toBeGreaterThan(5);
  });

  it('keeps both team counts, the spectators, the order and unique perches', () => {
    const lobby = lopsided();
    for (let seed = 0; seed < 50; seed++) {
      const shuffled = must(shuffleTeams(lobby, HOST, seed));
      expect(sides(shuffled.state)).toEqual({ ember: 4, frost: 3, spectator: 2 });
      expect(sideOf(shuffled, 7)).toBe('spectator');
      expect(sideOf(shuffled, 8)).toBe('spectator');
      expect(shuffled.state.players.map((p) => p.id)).toEqual(lobby.state.players.map((p) => p.id));
      for (const team of [TEAM_EMBER, TEAM_FROST]) {
        const perches = shuffled.state.players.filter((p) => p.side === team).map((p) => p.perch);
        expect([...perches].sort()).toEqual(perches.map((_, i) => i));
      }
    }
  });

  it('clears ready only for riders who changed side', () => {
    const lobby = readyAll(lopsided());
    const shuffled = must(shuffleTeams(lobby, HOST, 7));
    let moved = 0;
    for (const player of shuffled.state.players) {
      if (player.side === 'spectator' || player.isHost) continue;
      const before = findLobbyPlayer(lobby.state, player.id);
      if (before?.side !== player.side) moved += 1;
      expect(player.ready).toBe(before?.side === player.side);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('is host-only, needs a numeric seed and respects the lock', () => {
    const lobby = lopsided();
    expect(reasonOf(shuffleTeams(lobby, 1, 5))).toBe('notHost');
    expect(reasonOf(shuffleTeams(lobby, HOST, Number.NaN))).toBe('invalidValue');
    expect(reasonOf(shuffleTeams(must(lockTeams(lobby, HOST, true)), HOST, 5))).toBe('teamsLocked');
  });
});

describe('class and ready', () => {
  it('picks an allowed class and clears ready when it changes', () => {
    let lobby = withPlayers(newLobby(), 1);
    lobby = must(setReady(lobby, 1, true));
    const same = pickClass(lobby, 1, 'talon');
    expect(same).toMatchObject({ ok: true, changed: false });
    expect(findLobbyPlayer(same.lobby.state, 1)?.ready).toBe(true);
    lobby = must(pickClass(lobby, 1, 'tempest'));
    expect(findLobbyPlayer(lobby.state, 1)).toMatchObject({ classId: 'tempest', ready: false });
    expect(reasonOf(pickClass(lobby, 1, 'phoenix' as never))).toBe('invalidValue');
    expect(reasonOf(pickClass(lobby, 30, 'talon'))).toBe('unknownActor');
  });

  it('refuses a class the host removed and falls affected players back', () => {
    let lobby = withPlayers(newLobby(), 2);
    lobby = must(pickClass(lobby, 1, 'wraith'));
    lobby = must(pickClass(lobby, 2, 'bastion'));
    lobby = must(setReady(lobby, 1, true));
    lobby = must(setReady(lobby, 2, true));
    expect(reasonOf(setAllowedClasses(lobby, 1, ['talon']))).toBe('notHost');
    lobby = must(setAllowedClasses(lobby, HOST, ['bastion', 'talon', 'bastion', 'nope' as never]));
    expect(lobby.state.settings.allowedClasses).toEqual(['talon', 'bastion']);
    expect(findLobbyPlayer(lobby.state, 1)).toMatchObject({ classId: 'talon', ready: false });
    expect(findLobbyPlayer(lobby.state, 2)).toMatchObject({ classId: 'bastion', ready: true });
    expect(reasonOf(pickClass(lobby, 1, 'wraith'))).toBe('classNotAllowed');

    // Without the default class the fallback is the first allowed one.
    lobby = must(setAllowedClasses(lobby, HOST, ['wraith', 'tempest']));
    expect(lobby.state.players.map((p) => p.classId)).toEqual(['tempest', 'tempest', 'tempest']);
    expect(reasonOf(setAllowedClasses(lobby, HOST, []))).toBe('invalidValue');
    expect(reasonOf(setAllowedClasses(lobby, HOST, ['zzz' as never]))).toBe('invalidValue');
    expect(reasonOf(setAllowedClasses(lobby, HOST, 'talon' as never))).toBe('invalidValue');
    const same = setAllowedClasses(lobby, HOST, ['tempest', 'wraith']);
    expect(same.lobby).toBe(lobby);
  });

  it('toggles ready for riders but not spectators', () => {
    let lobby = withPlayers(newLobby(), 1);
    lobby = must(setReady(lobby, 1, true));
    expect(findLobbyPlayer(lobby.state, 1)?.ready).toBe(true);
    expect(setReady(lobby, 1, true).lobby).toBe(lobby);
    lobby = must(setReady(lobby, 1, false));
    expect(findLobbyPlayer(lobby.state, 1)?.ready).toBe(false);
    expect(reasonOf(setReady(lobby, 1, 'yes' as unknown as boolean))).toBe('invalidValue');
    lobby = must(switchSide(lobby, 1, 'spectator'));
    expect(reasonOf(setReady(lobby, 1, true))).toBe('spectator');
  });
});

describe('host settings', () => {
  it('sets mode, pulling the team size into range with overflow', () => {
    let lobby = withPlayers(newLobby(), 5);
    expect(reasonOf(setMode(lobby, 1, 'duel'))).toBe('notHost');
    expect(reasonOf(setMode(lobby, HOST, 'emberRelay'))).toBe('unavailable');
    expect(reasonOf(setMode(lobby, HOST, 'toString' as never))).toBe('invalidValue');
    lobby = must(setMode(lobby, HOST, 'duel'));
    expect(lobby.state.settings).toMatchObject({ mode: 'duel', teamSize: 2 });
    expect(sides(lobby.state)).toEqual({ ember: 2, frost: 2, spectator: 2 });
    // Duel caps the size at 2.
    expect(setTeamSize(lobby, HOST, 5).lobby).toBe(lobby);
    lobby = must(setMode(lobby, HOST, 'skirmish'));
    expect(lobby.state.settings.teamSize).toBe(2);
  });

  it('sets map, limits and friendly fire with clamping', () => {
    let lobby = withPlayers(newLobby(), 1);
    expect(reasonOf(setMap(lobby, HOST, 'emberfall-caldera'))).toBe('unavailable');
    expect(reasonOf(setMap(lobby, HOST, 'atlantis' as never))).toBe('invalidValue');
    expect(setMap(lobby, HOST, 'shattered-spires').lobby).toBe(lobby);
    expect(reasonOf(setMap(lobby, 1, 'shattered-spires'))).toBe('notHost');

    lobby = must(setScoreLimit(lobby, HOST, 12.4));
    expect(lobby.state.settings.scoreLimit).toBe(12);
    expect(must(setScoreLimit(lobby, HOST, 1e9)).state.settings.scoreLimit).toBe(200);
    expect(must(setScoreLimit(lobby, HOST, 0)).state.settings.scoreLimit).toBe(1);
    expect(reasonOf(setScoreLimit(lobby, HOST, Infinity))).toBe('invalidValue');
    expect(reasonOf(setScoreLimit(lobby, 1, 5))).toBe('notHost');

    expect(must(setTimeLimit(lobby, HOST, 0)).state.settings.timeLimitS).toBe(0);
    expect(must(setTimeLimit(lobby, HOST, -5)).state.settings.timeLimitS).toBe(0);
    expect(must(setTimeLimit(lobby, HOST, 5)).state.settings.timeLimitS).toBe(60);
    expect(must(setTimeLimit(lobby, HOST, 99999)).state.settings.timeLimitS).toBe(1800);
    expect(must(setTimeLimit(lobby, HOST, 361.2)).state.settings.timeLimitS).toBe(361);
    expect(reasonOf(setTimeLimit(lobby, HOST, Number.NaN))).toBe('invalidValue');
    expect(reasonOf(setTimeLimit(lobby, 1, 300))).toBe('notHost');

    lobby = must(setFriendlyFire(lobby, HOST, true));
    expect(lobby.state.settings.friendlyFire).toBe(true);
    expect(reasonOf(setFriendlyFire(lobby, 1, false))).toBe('notHost');
  });

  it('does not clear ready on settings that keep teams and classes', () => {
    let lobby = readyAll(withPlayers(newLobby(), 3));
    lobby = must(setScoreLimit(lobby, HOST, 10));
    lobby = must(setTimeLimit(lobby, HOST, 600));
    lobby = must(setFriendlyFire(lobby, HOST, true));
    lobby = must(setUnevenTeams(lobby, HOST, true));
    lobby = must(lockTeams(lobby, HOST, true));
    expect(lobby.state.players.filter((p) => p.ready)).toHaveLength(3);
  });
});

describe('canStart', () => {
  it('allows a solo sandbox for a single player only', () => {
    const solo = newLobby();
    expect(canStart(solo.state)).toEqual({ ok: true, solo: true });
    const watched = must(movePlayer(withPlayers(solo, 1), HOST, 1, 'spectator'));
    expect(canStart(watched.state)).toEqual({ ok: false, reason: 'teamEmpty' });
    const none = must(movePlayer(solo, HOST, HOST, 'spectator'));
    expect(canStart(none.state)).toEqual({ ok: false, reason: 'noRiders' });
  });

  it('needs a rider on both teams and equal counts unless uneven is on', () => {
    let lobby = withPlayers(newLobby(), 1); // 1v1
    expect(canStart(lobby.state)).toEqual({ ok: false, reason: 'notAllReady' });
    lobby = readyAll(lobby);
    expect(canStart(lobby.state)).toEqual({ ok: true, solo: false });
    const oneSided = must(movePlayer(lobby, HOST, 1, TEAM_EMBER));
    expect(canStart(oneSided.state)).toEqual({ ok: false, reason: 'teamEmpty' });
    const uneven = readyAll(withPlayers(lobby, 1));
    expect(canStart(uneven.state)).toEqual({ ok: false, reason: 'teamsUneven' });
    expect(canStart(must(setUnevenTeams(uneven, HOST, true)).state).ok).toBe(true);
  });

  it('waits for every rider except the host and bots; force skips only that', () => {
    let lobby = withPlayers(newLobby(), 3);
    lobby = must(setReady(lobby, 1, true));
    lobby = must(setReady(lobby, 2, true));
    expect(canStart(lobby.state)).toEqual({ ok: false, reason: 'notAllReady' });
    expect(canStart(lobby.state, { force: true })).toEqual({ ok: true, solo: false });
    lobby = must(setReady(lobby, 3, true));
    expect(lobby.state.players[0]?.ready).toBe(false); // the host need not ready up
    expect(canStart(lobby.state).ok).toBe(true);

    let bots = newLobby();
    bots = admitted(joinLobby(bots, { name: 'Bot', token: '', isBot: true })).lobby;
    expect(canStart(bots.state)).toEqual({ ok: true, solo: false });

    // Force does not override structure.
    const uneven = withPlayers(lobby, 1);
    expect(canStart(uneven.state, { force: true })).toEqual({ ok: false, reason: 'teamsUneven' });
  });

  it('ignores spectators and blocks on a reconnecting rider', () => {
    let lobby = readyAll(withPlayers(newLobby(), 3));
    const withWatcher = must(setTeamSize(withPlayers(lobby, 0), HOST, 2));
    const watcher = admitted(joinLobby(withWatcher, { name: 'W', token: 'w' }));
    expect(sideOf(watcher.lobby, watcher.playerId)).toBe('spectator');
    expect(canStart(watcher.lobby.state).ok).toBe(true);
    const watcherGone = must(disconnectPlayer(watcher.lobby, watcher.playerId, 0));
    expect(canStart(watcherGone.state).ok).toBe(true);

    lobby = must(disconnectPlayer(lobby, 3, 0));
    expect(canStart(lobby.state)).toEqual({ ok: false, reason: 'playerReconnecting' });
    expect(canStart(lobby.state, { force: true })).toEqual({
      ok: false,
      reason: 'playerReconnecting',
    });
  });

  it('rejects a state with an over-full team or outside the lobby phase', () => {
    const lobby = readyAll(withPlayers(newLobby(), 3));
    const tampered: LobbyState = {
      ...lobby.state,
      settings: { ...lobby.state.settings, teamSize: 1 },
    };
    expect(canStart(tampered)).toEqual({ ok: false, reason: 'teamOverSize' });
    const tooSmall: LobbyState = {
      ...readyAll(withPlayers(newLobby(), 1)).state,
      settings: { ...lobby.state.settings, mode: 'emberRelay' },
    };
    expect(canStart(tooSmall)).toEqual({ ok: false, reason: 'teamTooSmall' });
    const started = must(startMatch(lobby, HOST));
    expect(canStart(started.state)).toEqual({ ok: false, reason: 'wrongPhase' });
  });
});

describe('start and match flow', () => {
  it('produces the roster and enters the starting phase', () => {
    let lobby = withPlayers(newLobby(), 4); // E: 0 2 4, F: 1 3
    lobby = must(pickClass(lobby, 3, 'bastion'));
    lobby = must(setUnevenTeams(lobby, HOST, true));
    lobby = must(setTeamSize(lobby, HOST, 3));
    const watcher = admitted(joinLobby(lobby, { name: 'Watcher', token: 'w' }));
    lobby = must(movePlayer(watcher.lobby, HOST, watcher.playerId, 'spectator'));
    lobby = readyAll(lobby);
    expect(reasonOf(startMatch(lobby, 1))).toBe('notHost');
    const result = startMatch(lobby, HOST);
    if (!result.ok) throw new Error(result.reason);
    expect(result.changed).toBe(true);
    expect(result.lobby.state.phase).toBe('starting');
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0];
    if (effect?.type !== 'matchStart') throw new Error('no roster');
    expect(effect.roster).toEqual(buildMatchRoster(lobby.state));
    expect(effect.roster.solo).toBe(false);
    expect(effect.roster.settings).toEqual(lobby.state.settings);
    expect(effect.roster.spectators).toEqual([watcher.playerId]);
    expect(effect.roster.riders).toEqual([
      { playerId: 0, name: 'Host', team: 0, classId: 'talon', gateSlot: 2, isBot: false },
      { playerId: 2, name: 'P2', team: 0, classId: 'talon', gateSlot: 1, isBot: false },
      { playerId: 4, name: 'P4', team: 0, classId: 'talon', gateSlot: 3, isBot: false },
      { playerId: 1, name: 'P1', team: 1, classId: 'talon', gateSlot: 2, isBot: false },
      { playerId: 3, name: 'P3', team: 1, classId: 'bastion', gateSlot: 1, isBot: false },
    ]);
  });

  it('gives a full team five distinct gate slots', () => {
    const lobby = withPlayers(newLobby(), 9);
    const roster = buildMatchRoster(lobby.state);
    for (const team of [TEAM_EMBER, TEAM_FROST]) {
      const slots = roster.riders.filter((r) => r.team === team).map((r) => r.gateSlot);
      expect(slots).toEqual([2, 1, 3, 0, 4]);
    }
  });

  it('starts a solo sandbox', () => {
    const result = startMatch(newLobby(), HOST);
    if (!result.ok) throw new Error(result.reason);
    const effect = result.effects[0];
    expect(effect?.type === 'matchStart' && effect.roster.solo).toBe(true);
  });

  it('refuses to start with the reason from canStart', () => {
    const lobby = withPlayers(newLobby(), 1);
    expect(reasonOf(startMatch(lobby, HOST))).toBe('notAllReady');
    expect(startMatch(lobby, HOST, { force: true }).ok).toBe(true);
    expect(reasonOf(startMatch(must(startMatch(lobby, HOST, { force: true })), HOST))).toBe(
      'wrongPhase',
    );
  });

  it('freezes teams, classes and settings outside the lobby phase', () => {
    const lobby = must(startMatch(readyAll(withPlayers(newLobby(), 3)), HOST));
    const attempts: LobbyResult[] = [
      setTeamSize(lobby, HOST, 2),
      setUnevenTeams(lobby, HOST, true),
      setMode(lobby, HOST, 'duel'),
      setMap(lobby, HOST, 'shattered-spires'),
      setScoreLimit(lobby, HOST, 5),
      setTimeLimit(lobby, HOST, 300),
      setFriendlyFire(lobby, HOST, true),
      setAllowedClasses(lobby, HOST, ['talon']),
      lockTeams(lobby, HOST, true),
      movePlayer(lobby, HOST, 1, 'spectator'),
      autoBalance(lobby, HOST),
      shuffleTeams(lobby, HOST, 1),
      switchSide(lobby, 1, 'spectator'),
      pickClass(lobby, 1, 'wraith'),
      setReady(lobby, 1, false),
    ];
    expect(attempts.map(reasonOf)).toEqual(attempts.map(() => 'wrongPhase'));
  });

  it('moves starting -> inMatch -> lobby, keeping teams and clearing ready', () => {
    const ready = readyAll(withPlayers(newLobby(), 3));
    expect(reasonOf(enterMatch(ready))).toBe('wrongPhase');
    expect(returnToLobby(ready).lobby).toBe(ready);
    const starting = must(startMatch(ready, HOST));
    const inMatch = must(enterMatch(starting));
    expect(inMatch.state.phase).toBe('inMatch');
    const back = must(returnToLobby(inMatch));
    expect(back.state.phase).toBe('lobby');
    expect(back.state.players.some((p) => p.ready)).toBe(false);
    expect(back.state.players.map((p) => [p.id, p.side, p.perch, p.classId])).toEqual(
      ready.state.players.map((p) => [p.id, p.side, p.perch, p.classId]),
    );
    expect(back.state.settings).toBe(ready.state.settings);
    // A cancelled start goes straight back.
    expect(must(returnToLobby(starting)).state.phase).toBe('lobby');
  });
});

describe('lobby launch (T-5.1)', () => {
  /** Host + `count` players, everyone ready, Start pressed: the room is `starting`. */
  function launching(count: number): HostLobby {
    return must(startMatch(readyAll(withPlayers(newLobby(), count)), HOST));
  }

  it('ends in inMatch with the roster to load', () => {
    const ready = readyAll(withPlayers(newLobby(), 3));
    expect(reasonOf(launchMatch(ready))).toBe('wrongPhase');
    const starting = must(startMatch(ready, HOST));
    const result = launchMatch(starting);
    if (!result.ok) throw new Error(result.reason);
    expect(result.changed).toBe(true);
    expect(result.lobby.state.phase).toBe('inMatch');
    expect(result.effects).toEqual([
      { type: 'matchLaunch', roster: buildMatchRoster(starting.state) },
    ]);
    // Teams, classes and ready flags are untouched by the launch.
    expect(result.lobby.state.players).toBe(starting.state.players);
    expect(reasonOf(launchMatch(result.lobby))).toBe('wrongPhase');
  });

  it('refuses every team, class, ready and settings change while it runs', () => {
    const lobby = launching(5);
    const attempts: LobbyResult[] = [
      startMatch(lobby, HOST),
      startMatch(lobby, HOST, { force: true }),
      setTeamSize(lobby, HOST, 2),
      setMode(lobby, HOST, 'duel'),
      setScoreLimit(lobby, HOST, 5),
      setFriendlyFire(lobby, HOST, true),
      lockTeams(lobby, HOST, true),
      movePlayer(lobby, HOST, 1, 'spectator'),
      movePlayer(lobby, HOST, 1, TEAM_EMBER),
      autoBalance(lobby, HOST),
      shuffleTeams(lobby, HOST, 1),
      switchSide(lobby, 1, 'spectator'),
      switchSide(lobby, 2, TEAM_FROST),
      pickClass(lobby, 1, 'wraith'),
      setReady(lobby, 1, false),
      setReady(lobby, 2, true),
    ];
    expect(attempts.map(reasonOf)).toEqual(attempts.map(() => 'wrongPhase'));
  });

  it('seats whoever joins during it as a spectator, never as a rider', () => {
    const lobby = launching(1); // E: 0, F: 1: both teams have room
    const late = admitted(joinLobby(lobby, { name: 'Late', token: 'late' }));
    expect(sideOf(late.lobby, late.playerId)).toBe('spectator');
    const result = launchMatch(late.lobby);
    if (!result.ok) throw new Error(result.reason);
    const effect = result.effects[0];
    if (effect?.type !== 'matchLaunch') throw new Error('no roster');
    expect(effect.roster.riders.map((r) => r.playerId)).toEqual([0, 1]);
    expect(effect.roster.spectators).toEqual([late.playerId]);
  });

  it('builds the roster from who is still there when it ends', () => {
    let lobby = launching(5); // E: 0 2 4, F: 1 3 5
    lobby = must(leaveLobby(lobby, 2));
    lobby = must(kickPlayer(lobby, HOST, 3));
    lobby = must(disconnectPlayer(lobby, 5, 100));
    expect(lobby.state.phase).toBe('starting');
    const result = launchMatch(lobby);
    if (!result.ok) throw new Error(result.reason);
    expect(result.lobby.state.phase).toBe('inMatch');
    const effect = result.effects[0];
    if (effect?.type !== 'matchLaunch') throw new Error('no roster');
    // Gone riders are not in the match; the dropped one keeps its seat (the host flies it).
    expect(effect.roster.riders.map((r) => [r.playerId, r.team])).toEqual([
      [0, TEAM_EMBER],
      [4, TEAM_EMBER],
      [1, TEAM_FROST],
      [5, TEAM_FROST],
    ]);
    expect(findLobbyPlayer(result.lobby.state, 5)?.connected).toBe(false);
    expect(effect.roster.solo).toBe(false);
  });

  it('goes back to the lobby when a team is left with nobody', () => {
    const lobby = must(leaveLobby(launching(1), 1));
    const result = launchMatch(lobby);
    if (!result.ok) throw new Error(result.reason);
    expect(result.effects).toHaveLength(0);
    expect(result.lobby.state.phase).toBe('lobby');
    expect(result.lobby.state.players.some((p) => p.ready)).toBe(false);
    // The room is usable again: the host alone may start a sandbox.
    expect(canStart(result.lobby.state)).toEqual({ ok: true, solo: true });
  });

  it('launches a solo start as a sandbox, unless somebody joined meanwhile', () => {
    const starting = must(startMatch(newLobby(), HOST));
    const solo = launchMatch(starting, true);
    if (!solo.ok) throw new Error(solo.reason);
    expect(solo.lobby.state.phase).toBe('inMatch');
    const effect = solo.effects[0];
    expect(effect?.type === 'matchLaunch' && effect.roster.solo).toBe(true);
    // Without the solo flag one rider alone is a team short.
    expect(must(launchMatch(starting)).state.phase).toBe('lobby');

    // Somebody else is in the room now: no sandbox, they pick sides in the lobby instead.
    const joined = admitted(joinLobby(starting, { name: 'Late', token: 'late' })).lobby;
    const cancelled = launchMatch(joined, true);
    if (!cancelled.ok) throw new Error(cancelled.reason);
    expect(cancelled.effects).toHaveLength(0);
    expect(cancelled.lobby.state.phase).toBe('lobby');
    expect(cancelled.lobby.state.players).toHaveLength(2);
  });
});
