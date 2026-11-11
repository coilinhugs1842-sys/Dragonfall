/**
 * Bot riders in the lobby (T-3.10): the host seats and removes them, sets their difficulty, and
 * they behave like riders everywhere else (teams, start, roster) without ever spectating.
 */

import { describe, expect, it } from 'vitest';
import {
  BOT_DIFFICULTIES,
  BOT_RIDER_NAMES,
  DEFAULT_HOST_SETTINGS,
  DRAGON_CLASS_IDS,
  MAX_PLAYER_NAME_LENGTH,
  PROTOCOL_VERSION,
  TEAM_EMBER,
  TEAM_FROST,
  isBotDifficulty,
  isLobbyBotIntent,
} from '../../src/shared';
import type { LobbyBotIntent, LobbyState } from '../../src/shared';
import {
  HOST_PLAYER_ID,
  addBot,
  applyLobbyIntent,
  buildMatchRoster,
  canStart,
  clearBots,
  countLobbySide,
  createLobby,
  disconnectPlayer,
  fillBots,
  findLobbyPlayer,
  handleHello,
  joinLobby,
  kickPlayer,
  lockTeams,
  movePlayer,
  parseLobbyBotIntent,
  parseLobbyIntent,
  removeBot,
  setAllowedClasses,
  setBotDifficulty,
  setMode,
  setTeamSize,
  shuffleTeams,
  startMatch,
  validateHostSettings,
  validateLobbyState,
} from '../../src/sim/lobby';
import type { HostLobby, LobbyResult } from '../../src/sim/lobby';

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

function bots(state: LobbyState) {
  return state.players.filter((player) => player.isBot);
}

function join(lobby: HostLobby, name: string, token: string): HostLobby {
  const result = joinLobby(lobby, { name, token });
  if (!result.ok) throw new Error(`rejected: ${result.reject}`);
  return result.lobby;
}

describe('bot names and difficulty contract', () => {
  it('names are unique, fit the name cap and survive sanitising unchanged', () => {
    expect(BOT_RIDER_NAMES.length).toBeGreaterThanOrEqual(18);
    expect(new Set(BOT_RIDER_NAMES.map((name) => name.toLowerCase())).size).toBe(
      BOT_RIDER_NAMES.length,
    );
    for (const name of BOT_RIDER_NAMES) {
      expect(name.length).toBeGreaterThan(2);
      expect([...name].length).toBeLessThanOrEqual(MAX_PLAYER_NAME_LENGTH);
      expect(name).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('normal is the default difficulty of a new room', () => {
    expect(BOT_DIFFICULTIES).toEqual(['easy', 'normal', 'hard']);
    expect(DEFAULT_HOST_SETTINGS.botDifficulty).toBe('normal');
    expect(newLobby().state.settings.botDifficulty).toBe('normal');
    expect(isBotDifficulty('hard')).toBe(true);
    expect(isBotDifficulty('brutal')).toBe(false);
    // A bad value handed to createLobby falls back instead of being stored.
    const lobby = createLobby({
      roomCode: 'ABCDE',
      hostName: 'Host',
      settings: { ...DEFAULT_HOST_SETTINGS, botDifficulty: 'brutal' as 'hard' },
    });
    expect(lobby.state.settings.botDifficulty).toBe('normal');
  });
});

describe('addBot', () => {
  it('seats a named, ready bot on the asked team with a seat that has no token', () => {
    const lobby = must(addBot(newLobby(), HOST, TEAM_FROST, 7));
    expect(lobby.state.players).toHaveLength(2);
    const bot = lobby.state.players[1];
    expect(bot).toMatchObject({
      id: 1,
      side: TEAM_FROST,
      perch: 0,
      isBot: true,
      isHost: false,
      ready: true,
      connected: true,
      reconnectDeadlineTick: -1,
    });
    expect(BOT_RIDER_NAMES).toContain(bot?.name);
    expect(DRAGON_CLASS_IDS).toContain(bot?.classId);
    expect(lobby.seats.find((seat) => seat.id === 1)).toEqual({ id: 1, token: '', clientId: '' });
    // The state it broadcasts is one a client accepts.
    expect(validateLobbyState(JSON.parse(JSON.stringify(lobby.state)))).toEqual(lobby.state);
  });

  it('is deterministic per seed and never repeats a name in the room', () => {
    const a = must(addBot(newLobby(), HOST, TEAM_EMBER, 1234));
    const b = must(addBot(newLobby(), HOST, TEAM_EMBER, 1234));
    expect(a.state).toEqual(b.state);
    const names = new Set<string>();
    const classes = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const bot = must(addBot(newLobby(), HOST, TEAM_EMBER, seed)).state.players[1];
      names.add(bot?.name ?? '');
      classes.add(bot?.classId ?? '');
    }
    expect(names.size).toBeGreaterThan(8);
    expect(classes.size).toBe(DRAGON_CLASS_IDS.length);

    // The same seed nine times: nine different names anyway.
    let lobby = newLobby();
    for (let i = 0; i < 9; i++) {
      const side = i % 2 === 0 ? TEAM_FROST : TEAM_EMBER;
      lobby = must(addBot(lobby, HOST, side, 5));
    }
    expect(new Set(lobby.state.players.map((player) => player.name)).size).toBe(10);
  });

  it('takes the asked class when it is allowed, and only allowed classes otherwise', () => {
    let lobby = must(setAllowedClasses(newLobby(), HOST, ['bastion', 'wraith']));
    lobby = must(addBot(lobby, HOST, TEAM_FROST, 1, 'wraith'));
    expect(lobby.state.players[1]?.classId).toBe('wraith');
    // Talon is not allowed: the host picks from the list instead.
    for (let seed = 0; seed < 12; seed++) {
      const bot = must(addBot(lobby, HOST, TEAM_EMBER, seed, 'talon')).state.players[2];
      expect(['bastion', 'wraith']).toContain(bot?.classId);
    }
  });

  it('is refused for non-hosts, full teams, bad values and outside the lobby phase', () => {
    let lobby = join(newLobby(), 'Ada', 'tok-a');
    expect(reasonOf(addBot(lobby, 1, TEAM_EMBER, 1))).toBe('notHost');
    expect(reasonOf(addBot(lobby, 99, TEAM_EMBER, 1))).toBe('unknownActor');
    expect(reasonOf(addBot(lobby, HOST, 'spectator' as unknown as 0, 1))).toBe('invalidValue');
    expect(reasonOf(addBot(lobby, HOST, 2 as unknown as 0, 1))).toBe('invalidValue');
    expect(reasonOf(addBot(lobby, HOST, TEAM_EMBER, Number.NaN))).toBe('invalidValue');
    expect(reasonOf(addBot(lobby, HOST, TEAM_EMBER, 1, 'phoenix' as 'talon'))).toBe('invalidValue');

    lobby = must(setTeamSize(lobby, HOST, 2));
    lobby = must(addBot(lobby, HOST, TEAM_EMBER, 1));
    expect(reasonOf(addBot(lobby, HOST, TEAM_EMBER, 2))).toBe('teamFull');
    lobby = must(addBot(lobby, HOST, TEAM_FROST, 3));
    expect(countLobbySide(lobby.state.players, TEAM_FROST)).toBe(2);

    // Locked teams do not stop a new bot (nobody is moved).
    const locked = must(lockTeams(must(setTeamSize(lobby, HOST, 3)), HOST, true));
    expect(addBot(locked, HOST, TEAM_EMBER, 4).ok).toBe(true);

    const started = must(startMatch(lobby, HOST, { force: true }));
    expect(reasonOf(addBot(started, HOST, TEAM_EMBER, 5))).toBe('wrongPhase');
  });
});

describe('fillBots, removeBot, clearBots', () => {
  it('fills both teams to the team size, evenly, around the people already there', () => {
    let lobby = join(newLobby(), 'Ada', 'tok-a');
    lobby = must(setTeamSize(lobby, HOST, 3));
    const filled = must(fillBots(lobby, HOST, 99));
    expect(countLobbySide(filled.state.players, TEAM_EMBER)).toBe(3);
    expect(countLobbySide(filled.state.players, TEAM_FROST)).toBe(3);
    expect(bots(filled.state)).toHaveLength(4);
    // No perch is used twice and the state validates.
    expect(validateLobbyState(JSON.parse(JSON.stringify(filled.state)))).toEqual(filled.state);
    // Nothing left to fill: unchanged, not refused.
    const again = fillBots(filled, HOST, 100);
    expect(again.ok && again.changed).toBe(false);
    expect(reasonOf(fillBots(filled, 1, 1))).toBe('notHost');
    // Deterministic.
    expect(must(fillBots(lobby, HOST, 99)).state).toEqual(filled.state);

    // A 5v5 around the host alone: nine bots, the largest room.
    const full = must(fillBots(newLobby(), HOST, 3));
    expect(full.state.players).toHaveLength(10);
    expect(bots(full.state)).toHaveLength(9);
    expect(canStart(full.state)).toEqual({ ok: true, solo: false });
  });

  it('removeBot removes a bot in any phase and refuses to remove a person', () => {
    let lobby = join(newLobby(), 'Ada', 'tok-a');
    lobby = must(addBot(lobby, HOST, TEAM_EMBER, 1));
    lobby = must(addBot(lobby, HOST, TEAM_FROST, 2));
    const botId = lobby.state.players[2]?.id ?? -1;
    expect(reasonOf(removeBot(lobby, 1, botId))).toBe('notHost');
    expect(reasonOf(removeBot(lobby, HOST, 1))).toBe('invalidValue');
    expect(reasonOf(removeBot(lobby, HOST, HOST))).toBe('invalidValue');
    expect(reasonOf(removeBot(lobby, HOST, 77))).toBe('unknownPlayer');

    const result = removeBot(lobby, HOST, botId);
    if (!result.ok) throw new Error(result.reason);
    expect(result.effects).toEqual([{ type: 'playerRemoved', playerId: botId, cause: 'left' }]);
    expect(findLobbyPlayer(result.lobby.state, botId)).toBeUndefined();
    expect(result.lobby.seats.some((seat) => seat.id === botId)).toBe(false);
    // Nobody was banned by it.
    expect(result.lobby.kickedTokens).toEqual([]);

    // Mid-match too (its dragon leaves with it).
    const started = must(startMatch(lobby, HOST, { force: true }));
    expect(removeBot(started, HOST, botId).ok).toBe(true);
    // `host.kick` works on a bot as well.
    expect(kickPlayer(lobby, HOST, botId).ok).toBe(true);
  });

  it('clearBots removes every bot rider and nobody else', () => {
    let lobby = join(newLobby(), 'Ada', 'tok-a');
    lobby = must(fillBots(lobby, HOST, 5));
    expect(lobby.state.players).toHaveLength(10);
    const result = clearBots(lobby, HOST);
    if (!result.ok) throw new Error(result.reason);
    expect(result.lobby.state.players.map((player) => player.name)).toEqual(['Host', 'Ada']);
    expect(result.effects).toHaveLength(8);
    expect(result.lobby.seats).toHaveLength(2);
    const none = clearBots(result.lobby, HOST);
    expect(none.ok && none.changed).toBe(false);
  });

  it('a fake client flagged as a bot (`?bots=N`) is a connection, not a bot rider', () => {
    // Joined through `hello` with a token, flagged afterwards the way HostSession does it.
    const hello = handleHello(
      newLobby(),
      { name: 'Bot 1', protocolVersion: PROTOCOL_VERSION },
      { tick: 0, newToken: 'net-bot-token' },
    );
    if (!hello.ok) throw new Error(hello.reject);
    const flagged: HostLobby = {
      ...hello.lobby,
      state: {
        ...hello.lobby.state,
        players: hello.lobby.state.players.map((player) =>
          player.id === hello.playerId ? { ...player, isBot: true } : player,
        ),
      },
    };
    expect(reasonOf(removeBot(flagged, HOST, hello.playerId))).toBe('invalidValue');
    const cleared = clearBots(flagged, HOST);
    expect(cleared.ok && cleared.changed).toBe(false);
    // It may spectate like any client.
    const moved = must(movePlayer(flagged, HOST, hello.playerId, 'spectator'));
    expect(findLobbyPlayer(moved.state, hello.playerId)?.side).toBe('spectator');
  });
});

describe('bots among the other lobby rules', () => {
  it('a bot never spectates: dragging it off the team or shrinking the team removes it', () => {
    let lobby = must(fillBots(newLobby(), HOST, 8));
    const bot = bots(lobby.state)[0];
    if (bot === undefined) throw new Error('no bot');
    const dragged = movePlayer(lobby, HOST, bot.id, 'spectator');
    if (!dragged.ok) throw new Error(dragged.reason);
    expect(findLobbyPlayer(dragged.lobby.state, bot.id)).toBeUndefined();
    expect(dragged.effects).toEqual([{ type: 'playerRemoved', playerId: bot.id, cause: 'left' }]);

    // 5v5 of bots around the host, shrunk to 2v2: six bots leave, nobody watches.
    const shrunk = setTeamSize(lobby, HOST, 2);
    if (!shrunk.ok) throw new Error(shrunk.reason);
    expect(shrunk.lobby.state.players).toHaveLength(4);
    expect(countLobbySide(shrunk.lobby.state.players, 'spectator')).toBe(0);
    expect(shrunk.effects).toHaveLength(6);
    expect(validateLobbyState(JSON.parse(JSON.stringify(shrunk.lobby.state)))).not.toBeNull();

    // Duel caps the teams at 2 the same way.
    const duel = setMode(lobby, HOST, 'duel');
    if (!duel.ok) throw new Error(duel.reason);
    expect(countLobbySide(duel.lobby.state.players, 'spectator')).toBe(0);
    expect(duel.lobby.state.players.length).toBeLessThanOrEqual(4);

    // A person on a shrunk team still moves to the spectators.
    lobby = join(must(setTeamSize(newLobby(), HOST, 2)), 'Ada', 'tok-a');
    lobby = join(lobby, 'Bo', 'tok-b');
    lobby = join(lobby, 'Cy', 'tok-c');
    const one = must(setTeamSize(lobby, HOST, 1));
    expect(one.state.players).toHaveLength(4);
    expect(countLobbySide(one.state.players, 'spectator')).toBe(2);
  });

  it('a person who joins a room full of bots takes the newest bot seat', () => {
    const lobby = must(fillBots(newLobby(), HOST, 4));
    const newest = lobby.state.players[lobby.state.players.length - 1];
    if (newest === undefined) throw new Error('no bot');
    const result = handleHello(
      lobby,
      { name: 'Ada', protocolVersion: PROTOCOL_VERSION },
      { tick: 10, newToken: 'tok-ada' },
    );
    if (!result.ok) throw new Error(result.reject);
    const ada = findLobbyPlayer(result.lobby.state, result.playerId);
    expect(ada).toMatchObject({ name: 'Ada', side: newest.side, isBot: false });
    expect(result.lobby.state.players).toHaveLength(10);
    expect(bots(result.lobby.state)).toHaveLength(8);
    expect(result.effects).toEqual([{ type: 'playerRemoved', playerId: newest.id, cause: 'left' }]);
    expect(validateLobbyState(JSON.parse(JSON.stringify(result.lobby.state)))).not.toBeNull();

    // With the teams locked the newcomer watches and the bots stay.
    const locked = must(lockTeams(lobby, HOST, true));
    const watcher = handleHello(
      locked,
      { name: 'Bo', protocolVersion: PROTOCOL_VERSION },
      { tick: 10, newToken: 'tok-bo' },
    );
    if (!watcher.ok) throw new Error(watcher.reject);
    expect(findLobbyPlayer(watcher.lobby.state, watcher.playerId)?.side).toBe('spectator');
    expect(bots(watcher.lobby.state)).toHaveLength(9);
  });

  it('bots shuffle with the riders, never block Start, and carry their marker into the roster', () => {
    let lobby = join(newLobby(), 'Ada', 'tok-a');
    lobby = must(setTeamSize(lobby, HOST, 2));
    lobby = must(fillBots(lobby, HOST, 6));
    // Ada has not readied up: she blocks, the bots do not.
    expect(canStart(lobby.state)).toEqual({ ok: false, reason: 'notAllReady' });
    expect(canStart(lobby.state, { force: true })).toEqual({ ok: true, solo: false });
    const shuffled = must(shuffleTeams(lobby, HOST, 31));
    expect(bots(shuffled.state)).toHaveLength(2);
    expect(countLobbySide(shuffled.state.players, TEAM_EMBER)).toBe(2);

    const started = startMatch(lobby, HOST, { force: true });
    if (!started.ok) throw new Error(started.reason);
    const effect = started.effects[0];
    if (effect?.type !== 'matchStart') throw new Error('no roster');
    expect(effect.roster.riders).toHaveLength(4);
    expect(effect.roster.riders.filter((rider) => rider.isBot)).toHaveLength(2);
    expect(effect.roster.settings.botDifficulty).toBe('normal');
    expect(effect.roster.solo).toBe(false);
    expect(buildMatchRoster(lobby.state).riders.map((rider) => rider.isBot)).toEqual(
      effect.roster.riders.map((rider) => rider.isBot),
    );

    // The host alone with one bot is a 1v1, not a solo sandbox.
    const duel = must(addBot(newLobby(), HOST, TEAM_FROST, 2));
    expect(canStart(duel.state)).toEqual({ ok: true, solo: false });
    // A bot has no connection to drop: `disconnectPlayer` simply removes it.
    const dropped = must(disconnectPlayer(duel, 1, 50));
    expect(dropped.state.players).toHaveLength(1);
  });
});

describe('difficulty setting and intents', () => {
  it('setBotDifficulty changes the rule for the host only, in the lobby only', () => {
    let lobby = join(newLobby(), 'Ada', 'tok-a');
    expect(reasonOf(setBotDifficulty(lobby, 1, 'hard'))).toBe('notHost');
    expect(reasonOf(setBotDifficulty(lobby, HOST, 'brutal' as 'hard'))).toBe('invalidValue');
    const same = setBotDifficulty(lobby, HOST, 'normal');
    expect(same.ok && same.changed).toBe(false);
    lobby = must(setBotDifficulty(lobby, HOST, 'hard'));
    expect(lobby.state.settings.botDifficulty).toBe('hard');
    const started = must(startMatch(lobby, HOST, { force: true }));
    expect(reasonOf(setBotDifficulty(started, HOST, 'easy'))).toBe('wrongPhase');
  });

  it('validateHostSettings carries the difficulty, defaults it when absent, rejects junk', () => {
    const settings = { ...DEFAULT_HOST_SETTINGS, botDifficulty: 'easy' as const };
    expect(validateHostSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    const { botDifficulty: _dropped, ...older } = DEFAULT_HOST_SETTINGS;
    expect(validateHostSettings(older)?.botDifficulty).toBe('normal');
    expect(validateHostSettings({ ...DEFAULT_HOST_SETTINGS, botDifficulty: 'brutal' })).toBeNull();
    expect(validateHostSettings({ ...DEFAULT_HOST_SETTINGS, botDifficulty: 3 })).toBeNull();
  });

  it('the five bot intents go through applyLobbyIntent with the context seed', () => {
    const ctx = { tick: 0, seed: 17 };
    let lobby = newLobby();
    const apply = (intent: LobbyBotIntent, actor = HOST): LobbyResult =>
      applyLobbyIntent(lobby, actor, intent, ctx);

    lobby = must(apply({ type: 'host.addBot', side: TEAM_FROST, classId: 'tempest' }));
    expect(lobby.state.players[1]).toMatchObject({ isBot: true, classId: 'tempest' });
    expect(lobby.state).toEqual(must(addBot(newLobby(), HOST, TEAM_FROST, 17, 'tempest')).state);
    lobby = must(apply({ type: 'host.fillBots' }));
    expect(lobby.state.players).toHaveLength(10);
    lobby = must(apply({ type: 'host.removeBot', playerId: 1 }));
    expect(lobby.state.players).toHaveLength(9);
    lobby = must(apply({ type: 'host.setBotDifficulty', difficulty: 'easy' }));
    expect(lobby.state.settings.botDifficulty).toBe('easy');
    lobby = must(apply({ type: 'host.clearBots' }));
    expect(lobby.state.players).toHaveLength(1);

    // From anyone else they are refused like every `host.*` intent.
    lobby = join(lobby, 'Ada', 'tok-a');
    expect(reasonOf(apply({ type: 'host.addBot', side: TEAM_EMBER }, 1))).toBe('notHost');
    expect(reasonOf(apply({ type: 'host.fillBots' }, 1))).toBe('notHost');
    expect(reasonOf(apply({ type: 'host.setBotDifficulty', difficulty: 'hard' }, 1))).toBe(
      'notHost',
    );
  });

  it('parseLobbyBotIntent rebuilds them from untyped data; clients cannot send them', () => {
    expect(parseLobbyBotIntent({ type: 'host.addBot', side: 1, extra: true })).toEqual({
      type: 'host.addBot',
      side: 1,
    });
    expect(parseLobbyBotIntent({ type: 'host.addBot', side: 0, classId: 'wraith' })).toEqual({
      type: 'host.addBot',
      side: 0,
      classId: 'wraith',
    });
    expect(parseLobbyBotIntent({ type: 'host.addBot', side: 'spectator' })).toBeNull();
    expect(parseLobbyBotIntent({ type: 'host.addBot', side: 0, classId: 'phoenix' })).toBeNull();
    expect(parseLobbyBotIntent({ type: 'host.removeBot', playerId: 4 })).toEqual({
      type: 'host.removeBot',
      playerId: 4,
    });
    expect(parseLobbyBotIntent({ type: 'host.removeBot', playerId: 4.5 })).toBeNull();
    expect(parseLobbyBotIntent({ type: 'host.fillBots' })).toEqual({ type: 'host.fillBots' });
    expect(parseLobbyBotIntent({ type: 'host.clearBots' })).toEqual({ type: 'host.clearBots' });
    expect(parseLobbyBotIntent({ type: 'host.setBotDifficulty', difficulty: 'hard' })).toEqual({
      type: 'host.setBotDifficulty',
      difficulty: 'hard',
    });
    expect(parseLobbyBotIntent({ type: 'host.setBotDifficulty', difficulty: 'x' })).toBeNull();
    expect(parseLobbyBotIntent({ type: 'host.start' })).toBeNull();
    expect(parseLobbyBotIntent(null)).toBeNull();
    expect(parseLobbyBotIntent('host.fillBots')).toBeNull();

    // Not part of the wire intents: the network parser does not know them.
    expect(parseLobbyIntent({ type: 'host.addBot', side: 0 })).toBeNull();
    expect(parseLobbyIntent({ type: 'host.fillBots' })).toBeNull();
    expect(isLobbyBotIntent({ type: 'host.fillBots' })).toBe(true);
    expect(isLobbyBotIntent({ type: 'host.start' })).toBe(false);
  });
});
