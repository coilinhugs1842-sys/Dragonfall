import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  FALLBACK_PLAYER_NAME,
  MAX_PLAYER_NAME_LENGTH,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
} from '../../src/shared';
import type { LobbyState, UiIntent } from '../../src/shared';
import {
  HOST_PLAYER_ID,
  INTENT_BURST,
  allowIntent,
  applyLobbyIntent,
  createIntentRateLimiter,
  createLobby,
  dedupePlayerName,
  findLobbyPlayer,
  joinLobby,
  parseLobbyIntent,
  resetIntentRateLimiter,
  sanitizePlayerName,
  setReady,
  validateHostSettings,
  validateLobbyState,
} from '../../src/sim/lobby';
import type { HostLobby, LobbyIntent, LobbyIntentContext } from '../../src/sim/lobby';

const HOST = HOST_PLAYER_ID;
const CTX: LobbyIntentContext = { tick: 0, seed: 99 };

function lobbyOf(clients: number): HostLobby {
  let lobby = createLobby({ roomCode: 'ABCDE', hostName: 'Host' });
  for (let i = 0; i < clients; i++) {
    const joined = joinLobby(lobby, { name: `P${i + 1}`, token: `tok${i}` });
    if (!joined.ok) throw new Error(joined.reject);
    lobby = joined.lobby;
  }
  return lobby;
}

function apply(lobby: HostLobby, actor: number, intent: LobbyIntent | UiIntent): HostLobby {
  const result = applyLobbyIntent(lobby, actor, intent, CTX);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.lobby;
}

function refusal(lobby: HostLobby, actor: number, intent: LobbyIntent | UiIntent): string {
  const result = applyLobbyIntent(lobby, actor, intent, CTX);
  return result.ok ? 'ok' : result.reason;
}

const HOST_INTENTS: readonly LobbyIntent[] = [
  { type: 'host.setMode', mode: 'duel' },
  { type: 'host.setMap', map: 'shattered-spires' },
  { type: 'host.setTeamSize', teamSize: 2 },
  { type: 'host.setUnevenTeams', enabled: true },
  { type: 'host.setScoreLimit', scoreLimit: 9 },
  { type: 'host.setTimeLimit', timeLimitS: 400 },
  { type: 'host.setFriendlyFire', enabled: true },
  { type: 'host.setAllowedClasses', classes: ['wraith'] },
  { type: 'host.movePlayer', playerId: 2, side: 'spectator' },
  { type: 'host.autoBalance' },
  { type: 'host.shuffle' },
  { type: 'host.lockTeams', locked: true },
  { type: 'host.kick', playerId: 2 },
  { type: 'host.start' },
];

describe('applyLobbyIntent', () => {
  it('ignores every host intent from a client and leaves the lobby untouched', () => {
    const lobby = lobbyOf(3);
    for (const intent of HOST_INTENTS) {
      const result = applyLobbyIntent(lobby, 1, intent, CTX);
      expect(result).toEqual({ ok: false, lobby, reason: 'notHost' });
      expect(result.lobby).toBe(lobby);
    }
  });

  it('refuses host intents from someone who is not in the room', () => {
    const lobby = lobbyOf(1);
    for (const intent of HOST_INTENTS) expect(refusal(lobby, 77, intent)).toBe('unknownActor');
  });

  it('applies each host intent for the host', () => {
    let lobby = lobbyOf(5); // E: 0 2 4, F: 1 3 5
    lobby = apply(lobby, HOST, { type: 'host.setTeamSize', teamSize: 2 });
    expect(lobby.state.settings.teamSize).toBe(2);
    expect(findLobbyPlayer(lobby.state, 4)?.side).toBe('spectator');
    lobby = apply(lobby, HOST, { type: 'host.movePlayer', playerId: 3, side: 'spectator' });
    lobby = apply(lobby, HOST, { type: 'host.movePlayer', playerId: 4, side: TEAM_FROST });
    expect(findLobbyPlayer(lobby.state, 4)?.side).toBe(TEAM_FROST);
    lobby = apply(lobby, HOST, { type: 'host.setUnevenTeams', enabled: true });
    lobby = apply(lobby, HOST, { type: 'host.setScoreLimit', scoreLimit: 9 });
    lobby = apply(lobby, HOST, { type: 'host.setTimeLimit', timeLimitS: 400 });
    lobby = apply(lobby, HOST, { type: 'host.setFriendlyFire', enabled: true });
    lobby = apply(lobby, HOST, { type: 'host.setMap', map: 'shattered-spires' });
    lobby = apply(lobby, HOST, { type: 'host.setMode', mode: 'duel' });
    lobby = apply(lobby, HOST, { type: 'host.setAllowedClasses', classes: ['wraith', 'talon'] });
    expect(lobby.state.settings).toEqual({
      ...DEFAULT_HOST_SETTINGS,
      mode: 'duel',
      teamSize: 2,
      unevenTeams: true,
      scoreLimit: 9,
      timeLimitS: 400,
      friendlyFire: true,
      allowedClasses: ['talon', 'wraith'],
    });
    lobby = apply(lobby, HOST, { type: 'host.autoBalance' });
    const shuffledA = apply(lobby, HOST, { type: 'host.shuffle' });
    const shuffledB = apply(lobby, HOST, { type: 'host.shuffle' });
    expect(shuffledA.state).toEqual(shuffledB.state); // same ctx.seed
    lobby = apply(lobby, HOST, { type: 'host.lockTeams', locked: true });
    expect(lobby.state.settings.teamsLocked).toBe(true);
    lobby = apply(lobby, HOST, { type: 'host.kick', playerId: 5 });
    expect(findLobbyPlayer(lobby.state, 5)).toBeUndefined();
  });

  it('maps host.start, with forceStart from the context', () => {
    const lobby = lobbyOf(1);
    expect(refusal(lobby, HOST, { type: 'host.start' })).toBe('notAllReady');
    const forced = applyLobbyIntent(
      lobby,
      HOST,
      { type: 'host.start' },
      { ...CTX, forceStart: true },
    );
    expect(forced.ok && forced.effects[0]?.type).toBe('matchStart');
    const ready = apply(lobby, 1, { type: 'lobby.ready', ready: true });
    expect(apply(ready, HOST, { type: 'host.start' }).state.phase).toBe('starting');
  });

  it('applies player intents for any player', () => {
    let lobby = lobbyOf(2);
    lobby = apply(lobby, 1, { type: 'lobby.pickClass', classId: 'tempest' });
    lobby = apply(lobby, 1, { type: 'lobby.ready', ready: true });
    expect(findLobbyPlayer(lobby.state, 1)).toMatchObject({ classId: 'tempest', ready: true });
    lobby = apply(lobby, 2, { type: 'lobby.switchSide', side: TEAM_FROST });
    expect(findLobbyPlayer(lobby.state, 2)?.side).toBe(TEAM_FROST);
    const left = applyLobbyIntent(lobby, 2, { type: 'lobby.leave' }, CTX);
    expect(left.ok && left.effects).toEqual([
      { type: 'playerRemoved', playerId: 2, cause: 'left' },
    ]);
    const closed = applyLobbyIntent(lobby, HOST, { type: 'lobby.leave' }, CTX);
    expect(closed.ok && closed.effects).toEqual([{ type: 'lobbyClosed' }]);
  });

  it('refuses intents that are not for the lobby', () => {
    const lobby = lobbyOf(1);
    const others: UiIntent[] = [
      { type: 'title.host', name: 'x' },
      { type: 'title.join', name: 'x', roomCode: 'ABCDE' },
      { type: 'title.dismissError' },
      { type: 'lobby.focusPlayer', playerId: 1 },
      { type: 'match.skipIntro' },
      { type: 'match.skipCinematic' },
      { type: 'match.leave' },
      { type: 'settings.update', patch: {} },
      { type: 'settings.reset' },
    ];
    for (const intent of others) expect(refusal(lobby, HOST, intent)).toBe('unsupportedIntent');
  });

  it('rate-limits clients but never the host', () => {
    const lobby = lobbyOf(2);
    const limiter = createIntentRateLimiter();
    const ctx: LobbyIntentContext = { tick: 0, seed: 1, limiter };
    let current = lobby;
    for (let i = 0; i < INTENT_BURST; i++) {
      const result = applyLobbyIntent(current, 1, { type: 'lobby.ready', ready: i % 2 === 0 }, ctx);
      expect(result.ok).toBe(true);
      current = result.lobby;
    }
    const over = applyLobbyIntent(current, 1, { type: 'lobby.ready', ready: true }, ctx);
    expect(over).toEqual({ ok: false, lobby: current, reason: 'rateLimited' });
    // Another client and the host are unaffected.
    expect(applyLobbyIntent(current, 2, { type: 'lobby.ready', ready: true }, ctx).ok).toBe(true);
    for (let i = 0; i < INTENT_BURST * 3; i++) {
      expect(
        applyLobbyIntent(current, HOST, { type: 'host.setScoreLimit', scoreLimit: i + 1 }, ctx).ok,
      ).toBe(true);
    }
    // One second later the client has tokens again.
    const later = applyLobbyIntent(
      current,
      1,
      { type: 'lobby.ready', ready: true },
      { ...ctx, tick: TICK_HZ },
    );
    expect(later.ok).toBe(true);
  });
});

describe('parseLobbyIntent', () => {
  it('accepts every well-formed lobby and host intent', () => {
    const intents: LobbyIntent[] = [
      ...HOST_INTENTS,
      { type: 'lobby.ready', ready: false },
      { type: 'lobby.pickClass', classId: 'bastion' },
      { type: 'lobby.switchSide', side: TEAM_EMBER },
      { type: 'lobby.leave' },
    ];
    for (const intent of intents) {
      expect(parseLobbyIntent(JSON.parse(JSON.stringify(intent)))).toEqual(intent);
    }
  });

  it('drops unknown fields', () => {
    expect(parseLobbyIntent({ type: 'lobby.ready', ready: true, isHost: true })).toEqual({
      type: 'lobby.ready',
      ready: true,
    });
    expect(
      parseLobbyIntent({ type: 'host.setAllowedClasses', classes: ['talon', 7, 'x'] }),
    ).toEqual({ type: 'host.setAllowedClasses', classes: ['talon'] });
  });

  it('rejects malformed input', () => {
    const bad: unknown[] = [
      null,
      undefined,
      7,
      'lobby.ready',
      [],
      {},
      { type: 'lobby.ready' },
      { type: 'lobby.ready', ready: 1 },
      { type: 'lobby.pickClass', classId: 'phoenix' },
      { type: 'lobby.switchSide', side: 2 },
      { type: 'lobby.focusPlayer', playerId: 1 },
      { type: 'title.host', name: 'x' },
      { type: 'settings.reset' },
      { type: 'host.setMode', mode: 4 },
      { type: 'host.setMap' },
      { type: 'host.setTeamSize', teamSize: '3' },
      { type: 'host.setTeamSize', teamSize: null },
      { type: 'host.setScoreLimit', scoreLimit: {} },
      { type: 'host.setTimeLimit' },
      { type: 'host.setUnevenTeams', enabled: 'yes' },
      { type: 'host.setFriendlyFire' },
      { type: 'host.lockTeams', locked: 0 },
      { type: 'host.setAllowedClasses', classes: 'talon' },
      { type: 'host.setAllowedClasses', classes: new Array(100).fill('talon') },
      { type: 'host.movePlayer', playerId: 1.5, side: 0 },
      { type: 'host.movePlayer', playerId: 1, side: 'left' },
      { type: 'host.kick', playerId: -1 },
      { type: 'host.kick', playerId: '1' },
      { type: 'host.unknown' },
      { type: 'constructor' },
    ];
    for (const raw of bad) expect(parseLobbyIntent(raw)).toBeNull();
  });

  it('lets the operation reject ids that only look like strings', () => {
    const lobby = lobbyOf(0);
    const mode = parseLobbyIntent({ type: 'host.setMode', mode: '__proto__' });
    const map = parseLobbyIntent({ type: 'host.setMap', map: 'nowhere' });
    if (mode === null || map === null) throw new Error('should parse');
    expect(refusal(lobby, HOST, mode)).toBe('invalidValue');
    expect(refusal(lobby, HOST, map)).toBe('invalidValue');
  });
});

describe('validateLobbyState', () => {
  function sample(): LobbyState {
    let lobby = lobbyOf(11);
    const ready = setReady(lobby, 1, true);
    if (ready.ok) lobby = ready.lobby;
    return lobby.state;
  }

  function wire(state: unknown): unknown {
    return JSON.parse(JSON.stringify(state));
  }

  it('accepts a real state after a JSON round trip and returns an equal copy', () => {
    const state = sample();
    const parsed = validateLobbyState(wire(state));
    expect(parsed).toEqual(state);
    expect(parsed).not.toBe(state);
  });

  it('strips fields it does not know', () => {
    const state = sample();
    const raw = wire(state) as Record<string, unknown>;
    raw['seats'] = [{ id: 1, token: 'secret' }];
    (raw['players'] as Record<string, unknown>[])[0]!['token'] = 'secret';
    expect(validateLobbyState(raw)).toEqual(state);
  });

  it('cleans names again on the client', () => {
    const raw = wire(sample()) as { players: { name: string }[] };
    raw.players[1]!.name = '  Ev\u0000il‮ name that is far too long for a plate ';
    const parsed = validateLobbyState(raw);
    expect(parsed?.players[1]?.name).toBe('Evil name that i');
  });

  type Mutation = (state: {
    roomCode: unknown;
    phase: unknown;
    hostId: unknown;
    players: Record<string, unknown>[];
    settings: Record<string, unknown>;
  }) => void;

  const mutations: readonly [string, Mutation][] = [
    ['numeric room code', (s) => (s.roomCode = 12345)],
    ['huge room code', (s) => (s.roomCode = 'A'.repeat(64))],
    ['unknown phase', (s) => (s.phase = 'paused')],
    ['hostId out of range', (s) => (s.hostId = 255)],
    ['hostId not a player', (s) => (s.hostId = 200)],
    ['no players', (s) => (s.players = [])],
    ['players not an array', (s) => ((s as { players: unknown }).players = {})],
    [
      'too many players',
      (s) => {
        for (let i = 0; i < 20; i++) s.players.push({ ...s.players[11], id: 100 + i });
      },
    ],
    ['duplicate id', (s) => (s.players[2]!['id'] = 1)],
    ['id 255', (s) => (s.players[2]!['id'] = 255)],
    ['fractional id', (s) => (s.players[2]!['id'] = 2.5)],
    ['empty name', (s) => (s.players[2]!['name'] = '')],
    ['name not a string', (s) => (s.players[2]!['name'] = { toString: 1 })],
    ['unknown side', (s) => (s.players[2]!['side'] = 2)],
    ['spectator with a perch', (s) => (s.players[11]!['perch'] = 0)],
    ['rider without a perch', (s) => (s.players[2]!['perch'] = -1)],
    ['perch out of range', (s) => (s.players[2]!['perch'] = 5)],
    ['perch used twice', (s) => (s.players[2]!['perch'] = 0)],
    ['unknown class', (s) => (s.players[2]!['classId'] = 'phoenix')],
    ['ready not boolean', (s) => (s.players[2]!['ready'] = 'true')],
    ['missing connected', (s) => delete s.players[2]!['connected']],
    ['missing isBot', (s) => delete s.players[2]!['isBot']],
    ['bad deadline', (s) => (s.players[2]!['reconnectDeadlineTick'] = 'soon')],
    ['second host', (s) => (s.players[2]!['isHost'] = true)],
    ['no host', (s) => (s.players[0]!['isHost'] = false)],
    ['team over size', (s) => (s.settings['teamSize'] = 4)],
    ['null player', (s) => ((s.players as unknown[])[3] = null)],
    ['missing settings', (s) => delete (s as { settings?: unknown }).settings],
    ['unknown mode', (s) => (s.settings['mode'] = 'royale')],
    ['prototype key as mode', (s) => (s.settings['mode'] = 'constructor')],
    ['unknown map', (s) => (s.settings['map'] = 'atlantis')],
    ['team size 0', (s) => (s.settings['teamSize'] = 0)],
    ['team size 6', (s) => (s.settings['teamSize'] = 6)],
    ['score limit 0', (s) => (s.settings['scoreLimit'] = 0)],
    ['time limit 30', (s) => (s.settings['timeLimitS'] = 30)],
    ['time limit fractional', (s) => (s.settings['timeLimitS'] = 90.5)],
    ['unevenTeams not boolean', (s) => (s.settings['unevenTeams'] = 0)],
    ['empty classes', (s) => (s.settings['allowedClasses'] = [])],
    ['duplicate classes', (s) => (s.settings['allowedClasses'] = ['talon', 'talon'])],
    ['unknown class allowed', (s) => (s.settings['allowedClasses'] = ['talon', 'hydra'])],
    ['classes not an array', (s) => (s.settings['allowedClasses'] = 'talon')],
  ];

  it.each(mutations)('rejects: %s', (_label, mutate) => {
    const raw = wire(sample()) as Parameters<Mutation>[0];
    expect(validateLobbyState(raw)).not.toBeNull();
    mutate(raw);
    expect(validateLobbyState(raw)).toBeNull();
  });

  it('rejects things that are not objects', () => {
    for (const raw of [null, undefined, 3, 'state', [], true]) {
      expect(validateLobbyState(raw)).toBeNull();
    }
  });

  it('accepts a held seat and normalises a stray deadline', () => {
    const raw = wire(sample()) as { players: Record<string, unknown>[] };
    raw.players[2]!['connected'] = false;
    raw.players[2]!['reconnectDeadlineTick'] = 1234;
    raw.players[3]!['reconnectDeadlineTick'] = 55; // connected, so the deadline is meaningless
    const parsed = validateLobbyState(raw);
    expect(parsed?.players[2]).toMatchObject({ connected: false, reconnectDeadlineTick: 1234 });
    expect(parsed?.players[3]?.reconnectDeadlineTick).toBe(-1);
  });

  it('validates settings on their own', () => {
    expect(validateHostSettings(wire(DEFAULT_HOST_SETTINGS))).toEqual(DEFAULT_HOST_SETTINGS);
    expect(validateHostSettings({ ...DEFAULT_HOST_SETTINGS, timeLimitS: 0 })?.timeLimitS).toBe(0);
    expect(validateHostSettings({ ...DEFAULT_HOST_SETTINGS, friendlyFire: undefined })).toBeNull();
    expect(validateHostSettings(null)).toBeNull();
  });
});

describe('player names', () => {
  it('trims, collapses whitespace and strips control and invisible characters', () => {
    expect(sanitizePlayerName('  Ash  ')).toBe('Ash');
    expect(sanitizePlayerName('Ash\t\n  Wing')).toBe('Ash Wing');
    expect(sanitizePlayerName('A\u0000s\u0007h\u007f')).toBe('Ash');
    expect(sanitizePlayerName('A​s‍h﻿')).toBe('Ash');
    expect(sanitizePlayerName('‮evil‬')).toBe('evil');
    expect(sanitizePlayerName('a  b')).toBe('a b');
    expect(sanitizePlayerName('<b>x</b>')).toBe('<b>x</b>'); // views must use text nodes
  });

  it('falls back when nothing is left or the input is not a string', () => {
    for (const raw of ['', '   ', '\u0000​', null, undefined, 42, {}, ['x']]) {
      expect(sanitizePlayerName(raw)).toBe(FALLBACK_PLAYER_NAME);
    }
  });

  it('caps the length in code points without splitting a surrogate pair', () => {
    expect(sanitizePlayerName('x'.repeat(100))).toBe('x'.repeat(MAX_PLAYER_NAME_LENGTH));
    const dragons = sanitizePlayerName('\u{1F409}'.repeat(40));
    expect([...dragons]).toHaveLength(MAX_PLAYER_NAME_LENGTH);
    expect(dragons).toBe('\u{1F409}'.repeat(MAX_PLAYER_NAME_LENGTH));
    expect(sanitizePlayerName('ab\ud83dcd')).toBe('abcd'); // lone surrogate removed
    expect(sanitizePlayerName('a'.repeat(15) + '  b')).toBe('a'.repeat(15));
    expect(sanitizePlayerName('x'.repeat(1_000_000))).toHaveLength(MAX_PLAYER_NAME_LENGTH);
  });

  it('is idempotent', () => {
    for (const raw of ['  A  b\u0001c ', '\u{1F409}'.repeat(30), 'ﬁre Ⅻ', 'x'.repeat(40)]) {
      const once = sanitizePlayerName(raw);
      expect(sanitizePlayerName(once)).toBe(once);
    }
  });

  it('dedupes with a numeric suffix, ignoring case', () => {
    expect(dedupePlayerName('Ash', [])).toBe('Ash');
    expect(dedupePlayerName('Ash', ['Bo'])).toBe('Ash');
    expect(dedupePlayerName('Ash', ['ash'])).toBe('Ash 2');
    expect(dedupePlayerName('Ash', ['Ash', 'ASH 2', 'Ash 3'])).toBe('Ash 4');
    expect(dedupePlayerName('Ash', ['Ash', 'Ash 3'])).toBe('Ash 2');
  });

  it('keeps a deduped name inside the length cap', () => {
    const long = 'x'.repeat(MAX_PLAYER_NAME_LENGTH);
    const second = dedupePlayerName(long, [long]);
    expect(second).toBe('x'.repeat(MAX_PLAYER_NAME_LENGTH - 2) + ' 2');
    const taken = [long, second];
    for (let n = 3; n <= 12; n++) {
      const next = dedupePlayerName(long, taken);
      expect([...next].length).toBeLessThanOrEqual(MAX_PLAYER_NAME_LENGTH);
      expect(taken.map((t) => t.toLowerCase())).not.toContain(next.toLowerCase());
      taken.push(next);
    }
  });
});

describe('intent rate limiter', () => {
  it('lets a burst through, then refills by tick', () => {
    const limiter = createIntentRateLimiter({ burst: 3, refillPerTick: 0.5 });
    expect([0, 0, 0, 0].map((tick) => allowIntent(limiter, 4, tick))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(allowIntent(limiter, 4, 1)).toBe(false); // half a token
    expect(allowIntent(limiter, 4, 2)).toBe(true);
    expect(allowIntent(limiter, 4, 2)).toBe(false);
    // A long pause refills to the burst and no further.
    let passed = 0;
    for (let i = 0; i < 10; i++) if (allowIntent(limiter, 4, 10_000)) passed += 1;
    expect(passed).toBe(3);
  });

  it('keeps one bucket per player and tolerates time going backwards', () => {
    const limiter = createIntentRateLimiter({ burst: 1, refillPerTick: 1 });
    expect(allowIntent(limiter, 1, 100)).toBe(true);
    expect(allowIntent(limiter, 2, 100)).toBe(true);
    expect(allowIntent(limiter, 1, 100)).toBe(false);
    expect(allowIntent(limiter, 1, 50)).toBe(false);
    expect(allowIntent(limiter, 1, 51)).toBe(true);
  });

  it('uses the documented defaults', () => {
    const limiter = createIntentRateLimiter();
    let passed = 0;
    for (let i = 0; i < 100; i++) if (allowIntent(limiter, 9, 0)) passed += 1;
    expect(passed).toBe(INTENT_BURST);
    // 5 per second sustained.
    passed = 0;
    for (let tick = 1; tick <= TICK_HZ * 2; tick++) {
      if (allowIntent(limiter, 9, tick)) passed += 1;
      if (allowIntent(limiter, 9, tick)) passed += 1;
    }
    expect(passed).toBe(10);
  });

  it('resets one player or everyone, and rejects ids outside a u8', () => {
    const limiter = createIntentRateLimiter({ burst: 1, refillPerTick: 0 });
    expect(allowIntent(limiter, 1, 0)).toBe(true);
    expect(allowIntent(limiter, 2, 0)).toBe(true);
    resetIntentRateLimiter(limiter, 1);
    expect(allowIntent(limiter, 1, 0)).toBe(true);
    expect(allowIntent(limiter, 2, 0)).toBe(false);
    resetIntentRateLimiter(limiter);
    expect(allowIntent(limiter, 2, 0)).toBe(true);
    for (const id of [-1, 256, 1.5, Number.NaN]) {
      expect(allowIntent(limiter, id, 0)).toBe(false);
      resetIntentRateLimiter(limiter, id);
    }
  });
});

describe('teams constant sanity', () => {
  it('uses the shared team ids as sides', () => {
    const lobby = lobbyOf(1);
    expect(lobby.state.players.map((p) => p.side)).toEqual([TEAM_EMBER, TEAM_FROST]);
  });
});
