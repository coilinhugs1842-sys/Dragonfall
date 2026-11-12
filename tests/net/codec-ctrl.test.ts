import { describe, expect, it } from 'vitest';
import {
  MAX_PLAYER_NAME_LENGTH,
  NO_PLAYER,
  PROTOCOL_VERSION,
  TEAM_EMBER,
  TEAM_FROST,
  createGameEventBus,
} from '../../src/shared';
import type { GameEvent, LobbyState } from '../../src/shared';
import { createLobby, joinLobby } from '../../src/sim/lobby';
import type { LobbyIntent } from '../../src/sim/lobby';
import {
  Reader,
  Writer,
  beginGameEvents,
  decodeGameEvents,
  decodeHello,
  decodeHostLeft,
  decodeIntent,
  decodeKick,
  decodeLobbyState,
  decodeMatchPhase,
  decodeMatchStart,
  decodePing,
  decodePong,
  decodeReject,
  decodeWelcome,
  encodeHello,
  encodeHostLeft,
  encodeIntent,
  encodeKick,
  encodeLobbyState,
  encodeMatchPhase,
  encodeMatchStart,
  encodePing,
  encodePong,
  encodeReject,
  encodeWelcome,
  endGameEvents,
  gameEventCount,
  isNetIntent,
  isReconnectToken,
  reconnectTokenFromBytes,
  writeGameEvent,
} from '../../src/net/codec';
import {
  CTRL_MAX_BYTES,
  DECODE_BAD_PAYLOAD,
  DECODE_BAD_VALUE,
  DECODE_OVERSIZED,
  DECODE_TRUNCATED,
  DECODE_WRONG_TYPE,
  GAME_EVENT_TYPES,
  HEADER_BYTES,
  MAP_IDS,
  MATCH_PHASE_BYTES,
  MATCH_START_BYTES,
  MAX_EVENTS_PER_BATCH,
  MSG_GAME_EVENTS,
  MSG_HELLO,
  MSG_HOST_LEFT,
  MSG_INPUT,
  MSG_INTENT,
  MSG_KICK,
  MSG_LOBBY_STATE,
  MSG_MATCH_PHASE,
  MSG_MATCH_START,
  MSG_PING,
  MSG_PONG,
  MSG_REJECT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  NET_INTENT_TYPES,
  PING_BYTES,
  PONG_BYTES,
  REJECT_BYTES,
  REJECT_REASONS,
  WIRE_POSITION_STEP_M,
  createHelloMessage,
  createIntentMessage,
  createLobbyStateMessage,
  createMatchPhaseMessage,
  createMatchStartMessage,
  createNoticeMessage,
  createPingMessage,
  createPongMessage,
  createRejectMessage,
  createWelcomeMessage,
  isClientToHostMessage,
  isFastMessage,
  isMessageType,
} from '../../src/net/protocol';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function viewOf(w: Writer, length: number): DataView {
  return new DataView(w.buffer, 0, length);
}

/** A lobby with the host, two more riders and a spectator-capable room. */
function sampleLobby(): LobbyState {
  let lobby = createLobby({ roomCode: 'K7QXM', hostName: 'Aurelia' });
  for (const name of ['Bram', 'Ysolde \u{1F409}', 'Odo']) {
    const joined = joinLobby(lobby, { name, token: `${name.length}-${TOKEN}` });
    if (!joined.ok) throw new Error('join failed');
    lobby = joined.lobby;
  }
  return lobby.state;
}

describe('message table', () => {
  it('has unique ids and sorts them into channels', () => {
    const ids = [
      MSG_INPUT,
      MSG_SNAPSHOT,
      MSG_HELLO,
      MSG_WELCOME,
      MSG_REJECT,
      MSG_LOBBY_STATE,
      MSG_INTENT,
      MSG_PING,
      MSG_PONG,
      MSG_MATCH_START,
      MSG_MATCH_PHASE,
      MSG_GAME_EVENTS,
      MSG_KICK,
      MSG_HOST_LEFT,
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isMessageType(id)).toBe(true);
    for (const id of [0, 3, 15, 28, 255, -1]) expect(isMessageType(id)).toBe(false);
    expect(ids.filter(isFastMessage)).toEqual([MSG_INPUT, MSG_SNAPSHOT]);
    expect(ids.filter(isClientToHostMessage)).toEqual([MSG_INPUT, MSG_HELLO, MSG_INTENT, MSG_PING]);
  });

  it('uses the protocol version of the shared constants', () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

describe('HELLO', () => {
  it('round-trips name, version and token', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const msg = createHelloMessage();
    msg.tick = 0;
    msg.protocolVersion = PROTOCOL_VERSION;
    msg.name = 'Ysolde \u{1F409}';
    msg.reconnectToken = TOKEN;
    msg.clientId = 'c0ffee00c0ffee00c0ffee00c0ffee00';
    const length = encodeHello(w, msg);
    expect(length).toBeGreaterThan(HEADER_BYTES);

    const out = createHelloMessage();
    expect(decodeHello(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(r.peekType()).toBe(MSG_HELLO);
    expect(out).toEqual(msg);
  });

  it('sends "no token" for a first join and for a malformed token', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createHelloMessage();
    for (const reconnectToken of ['', 'has space', 'x'.repeat(65), 'café']) {
      const length = encodeHello(w, {
        tick: 0,
        protocolVersion: PROTOCOL_VERSION,
        name: 'Bram',
        reconnectToken,
        // The client id follows the same rule.
        clientId: reconnectToken,
      });
      expect(decodeHello(r.reset(viewOf(w, length)), out)).toBe(true);
      expect(out.reconnectToken).toBe('');
      expect(out.clientId).toBe('');
      expect(out.name).toBe('Bram');
    }
  });

  it('cleans and cuts hostile names', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createHelloMessage();
    // Hand-built, because the encoder would sanitize the name first.
    const raw = '  \u0007Evil‮\nName  that is far too long for a plate  ';
    w.reset();
    w.header(MSG_HELLO, 0);
    w.u16(PROTOCOL_VERSION);
    w.text('', 1, 64);
    w.text('', 1, 64);
    w.text(raw, 1, 255);
    expect(decodeHello(r.reset(viewOf(w, w.finish())), out)).toBe(true);
    expect(Array.from(out.name).length).toBeLessThanOrEqual(MAX_PLAYER_NAME_LENGTH);
    expect(out.name.startsWith('Evil Name')).toBe(true);
    expect(/[\u0000-\u001f‮]/.test(out.name)).toBe(false);

    // Invalid UTF-8 never throws; it decodes to replacement characters.
    w.reset();
    w.header(MSG_HELLO, 0);
    w.u16(PROTOCOL_VERSION);
    w.u8(0);
    w.u8(0);
    w.u8(3);
    w.u8(0xff);
    w.u8(0xfe);
    w.u8(0x41);
    expect(decodeHello(r.reset(viewOf(w, w.finish())), out)).toBe(true);
    expect(out.name.endsWith('A')).toBe(true);
  });

  it('reports another protocol version without parsing the rest', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createHelloMessage();
    w.reset();
    w.header(MSG_HELLO, 0);
    w.u16(PROTOCOL_VERSION + 1);
    w.u8(200); // whatever a future layout puts here
    w.u8(7);
    expect(decodeHello(r.reset(viewOf(w, w.finish())), out)).toBe(true);
    expect(out.protocolVersion).toBe(PROTOCOL_VERSION + 1);
    expect(out.name).toBe('');
    expect(out.reconnectToken).toBe('');
  });

  it('rejects truncated, padded and oversized buffers', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createHelloMessage();
    const length = encodeHello(w, {
      tick: 0,
      protocolVersion: PROTOCOL_VERSION,
      name: 'Bram',
      reconnectToken: TOKEN,
      clientId: '',
    });
    for (let cut = 0; cut < length; cut++) {
      expect(decodeHello(r.reset(viewOf(w, cut)), out)).toBe(false);
      expect(r.error).toBe(DECODE_TRUNCATED);
    }
    expect(decodeHello(r.reset(viewOf(w, length + 1)), out)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
    expect(decodeHello(r.reset(viewOf(w, 2000)), out)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
    w.view.setUint8(0, MSG_PING);
    expect(decodeHello(r.reset(viewOf(w, length)), out)).toBe(false);
    expect(r.error).toBe(DECODE_WRONG_TYPE);
  });
});

describe('reconnect tokens', () => {
  it('makes hex tokens from random bytes', () => {
    const token = reconnectTokenFromBytes(Uint8Array.from({ length: 16 }, (_, i) => i * 17));
    expect(token).toBe('00112233445566778899aabbccddeeff');
    expect(isReconnectToken(token)).toBe(true);
    expect(isReconnectToken('')).toBe(false);
    expect(isReconnectToken('with space')).toBe(false);
    expect(isReconnectToken('x'.repeat(64))).toBe(true);
    expect(isReconnectToken('x'.repeat(65))).toBe(false);
  });
});

describe('WELCOME and LOBBY_STATE', () => {
  it('round-trips a welcome with the full lobby state', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const lobbyState = sampleLobby();
    const msg = createWelcomeMessage();
    msg.tick = 4242;
    msg.playerId = 3;
    msg.reconnectToken = TOKEN;
    msg.hostTick = 65536 * 3 + 4242;
    msg.lobbyState = lobbyState;
    const length = encodeWelcome(w, msg);
    expect(length).toBeGreaterThan(0);

    const out = createWelcomeMessage();
    expect(decodeWelcome(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(r.peekType()).toBe(MSG_WELCOME);
    expect(out).toEqual(msg);
    // Rebuilt from validated fields, not the parsed object.
    expect(out.lobbyState).not.toBe(lobbyState);
  });

  it('round-trips a lobby state broadcast', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const lobbyState = sampleLobby();
    const length = encodeLobbyState(w, { tick: 9, lobbyState });
    const out = createLobbyStateMessage();
    expect(decodeLobbyState(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(r.peekType()).toBe(MSG_LOBBY_STATE);
    expect(out.tick).toBe(9);
    expect(out.lobbyState).toEqual(lobbyState);
    expect(out.lobbyState?.players).toHaveLength(4);
  });

  it('refuses to encode without a state or with a bad token', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    expect(encodeLobbyState(w, { tick: 0, lobbyState: null })).toBe(0);
    const welcome = createWelcomeMessage();
    expect(encodeWelcome(w, welcome)).toBe(0);
    welcome.lobbyState = sampleLobby();
    welcome.playerId = 1;
    welcome.reconnectToken = 'not valid';
    expect(encodeWelcome(w, welcome)).toBe(0);
    welcome.reconnectToken = ''; // a seat that cannot be reclaimed (a bot)
    expect(encodeWelcome(w, welcome)).toBeGreaterThan(0);
  });

  it('reports a state that does not fit the buffer instead of throwing', () => {
    const small = new Writer(64);
    expect(encodeLobbyState(small, { tick: 0, lobbyState: sampleLobby() })).toBe(0);
    expect(small.overflow).toBe(true);
  });

  it('rejects JSON that is not a lobby state', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createLobbyStateMessage();
    const state = sampleLobby();
    const payloads = [
      '{',
      'null',
      '[]',
      '"lobby"',
      '{"__proto__":{"polluted":true}}',
      JSON.stringify({ ...state, hostId: 300 }),
      JSON.stringify({ ...state, players: 'everyone' }),
      JSON.stringify({ ...state, settings: { ...state.settings, mode: 'battleRoyale' } }),
      JSON.stringify({ ...state, players: [...state.players, state.players[1]] }),
    ];
    for (const payload of payloads) {
      w.reset();
      w.header(MSG_LOBBY_STATE, 0);
      w.text(payload, 2, CTRL_MAX_BYTES);
      expect(decodeLobbyState(r.reset(viewOf(w, w.finish())), out)).toBe(false);
      expect(r.error).toBe(DECODE_BAD_PAYLOAD);
    }
    expect(out.lobbyState).toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    // A length prefix that points past the end of the buffer.
    w.reset();
    w.header(MSG_LOBBY_STATE, 0);
    w.u16(5000);
    w.u8(0x7b);
    expect(decodeLobbyState(r.reset(viewOf(w, w.finish())), out)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
  });

  it('rejects a welcome with an invalid player id or token', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createWelcomeMessage();
    const length = encodeWelcome(w, {
      tick: 0,
      playerId: 2,
      reconnectToken: TOKEN,
      hostTick: 1,
      lobbyState: sampleLobby(),
    });
    w.view.setUint8(HEADER_BYTES, NO_PLAYER);
    expect(decodeWelcome(r.reset(viewOf(w, length)), out)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    w.view.setUint8(HEADER_BYTES, 2);
    w.view.setUint8(HEADER_BYTES + 1 + 4 + 1, 0x20); // a space inside the token
    expect(decodeWelcome(r.reset(viewOf(w, length)), out)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
  });
});

describe('REJECT', () => {
  it('round-trips every reason', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createRejectMessage();
    for (const reason of REJECT_REASONS) {
      const length = encodeReject(w, { tick: 5, reason });
      expect(length).toBe(REJECT_BYTES);
      expect(decodeReject(r.reset(viewOf(w, length)), out)).toBe(true);
      expect(out).toEqual({ tick: 5, reason });
    }
    w.view.setUint8(HEADER_BYTES, REJECT_REASONS.length);
    expect(decodeReject(r.reset(viewOf(w, REJECT_BYTES)), out)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
  });
});

describe('INTENT', () => {
  const intents: LobbyIntent[] = [
    { type: 'lobby.ready', ready: true },
    { type: 'lobby.ready', ready: false },
    { type: 'lobby.pickClass', classId: 'tempest' },
    { type: 'lobby.switchSide', side: TEAM_FROST },
    { type: 'lobby.switchSide', side: 'spectator' },
    { type: 'lobby.leave' },
    { type: 'host.setMode', mode: 'duel' },
    { type: 'host.setMap', map: 'emberfall-caldera' },
    { type: 'host.setTeamSize', teamSize: 3 },
    { type: 'host.setUnevenTeams', enabled: true },
    { type: 'host.setScoreLimit', scoreLimit: 45 },
    { type: 'host.setTimeLimit', timeLimitS: 600 },
    { type: 'host.setFriendlyFire', enabled: false },
    { type: 'host.setAllowedClasses', classes: ['talon', 'wraith'] },
    { type: 'host.setAllowedClasses', classes: [] },
    { type: 'host.movePlayer', playerId: 7, side: TEAM_EMBER },
    { type: 'host.movePlayer', playerId: 254, side: 'spectator' },
    { type: 'host.autoBalance' },
    { type: 'host.shuffle' },
    { type: 'host.lockTeams', locked: true },
    { type: 'host.kick', playerId: 4 },
    { type: 'host.start' },
  ];

  it('covers every network intent type', () => {
    expect(new Set(intents.map((intent) => intent.type))).toEqual(new Set(NET_INTENT_TYPES));
  });

  it.each(intents)('round-trips $type', (intent) => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createIntentMessage();
    const length = encodeIntent(w, { tick: 77, intent });
    expect(length).toBeGreaterThanOrEqual(HEADER_BYTES + 1);
    expect(length).toBeLessThanOrEqual(HEADER_BYTES + 3);
    expect(decodeIntent(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(r.peekType()).toBe(MSG_INTENT);
    expect(out).toEqual({ tick: 77, intent });
    expect(out.intent).not.toBe(intent);
  });

  it('tells network intents from local ones', () => {
    expect(isNetIntent({ type: 'lobby.ready', ready: true })).toBe(true);
    expect(isNetIntent({ type: 'lobby.switchSide', side: TEAM_EMBER })).toBe(true);
    expect(isNetIntent({ type: 'lobby.focusPlayer', playerId: 1 })).toBe(false);
    expect(isNetIntent({ type: 'settings.reset' })).toBe(false);
    expect(isNetIntent({ type: 'title.host', name: 'x' })).toBe(false);
  });

  it('refuses to encode nothing or an unknown value', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    expect(encodeIntent(w, { tick: 0, intent: null })).toBe(0);
    // Cast: a mode id that is not in the wire table (a newer build's mode, a typo in a test).
    const bogus = { type: 'host.setMode', mode: 'battleRoyale' } as unknown as LobbyIntent;
    expect(encodeIntent(w, { tick: 0, intent: bogus })).toBe(0);
  });

  it('rejects illegal bodies', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createIntentMessage();
    const bodies: [type: (typeof NET_INTENT_TYPES)[number], bytes: number[]][] = [
      ['lobby.ready', [2]],
      ['lobby.pickClass', [9]],
      ['lobby.switchSide', [3]],
      ['host.setMode', [40]],
      ['host.setMap', [2]],
      ['host.setAllowedClasses', [0x10]],
      ['host.movePlayer', [NO_PLAYER, 0]],
      ['host.movePlayer', [1, 3]],
      ['host.lockTeams', [255]],
      ['host.kick', [NO_PLAYER]],
    ];
    for (const [type, bytes] of bodies) {
      w.reset();
      w.header(MSG_INTENT, 0);
      w.u8(NET_INTENT_TYPES.indexOf(type));
      for (const byte of bytes) w.u8(byte);
      expect(decodeIntent(r.reset(viewOf(w, w.finish())), out)).toBe(false);
      expect(r.error).toBe(DECODE_BAD_VALUE);
    }
    // Unknown intent id, a missing body and a trailing byte.
    w.reset();
    w.header(MSG_INTENT, 0);
    w.u8(NET_INTENT_TYPES.length);
    expect(decodeIntent(r.reset(viewOf(w, w.finish())), out)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    const length = encodeIntent(w, { tick: 0, intent: { type: 'host.kick', playerId: 4 } });
    expect(decodeIntent(r.reset(viewOf(w, length - 1)), out)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    expect(decodeIntent(r.reset(viewOf(w, length + 1)), out)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
    expect(out.intent).toBeNull();
  });
});

describe('PING and PONG', () => {
  it('round-trips clock samples at full precision', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const ping = { tick: 12, clientTimeMs: 123456.789012345 };
    let length = encodePing(w, ping);
    expect(length).toBe(PING_BYTES);
    const pingOut = createPingMessage();
    expect(decodePing(r.reset(viewOf(w, length)), pingOut)).toBe(true);
    expect(r.peekType()).toBe(MSG_PING);
    expect(pingOut).toEqual(ping);

    const pong = {
      tick: 13,
      clientTimeMs: ping.clientTimeMs,
      hostTimeMs: 98765.4321,
      hostTick: 4_000_000_000,
    };
    length = encodePong(w, pong);
    expect(length).toBe(PONG_BYTES);
    const pongOut = createPongMessage();
    expect(decodePong(r.reset(viewOf(w, length)), pongOut)).toBe(true);
    expect(r.peekType()).toBe(MSG_PONG);
    expect(pongOut).toEqual(pong);
  });

  it('rejects non-finite times and wrong sizes', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const pingOut = createPingMessage();
    const pongOut = createPongMessage();
    for (const bad of [NaN, Infinity, -Infinity]) {
      let length = encodePing(w, { tick: 0, clientTimeMs: bad });
      expect(decodePing(r.reset(viewOf(w, length)), pingOut)).toBe(false);
      expect(r.error).toBe(DECODE_BAD_VALUE);
      length = encodePong(w, { tick: 0, clientTimeMs: 1, hostTimeMs: bad, hostTick: 0 });
      expect(decodePong(r.reset(viewOf(w, length)), pongOut)).toBe(false);
      expect(r.error).toBe(DECODE_BAD_VALUE);
    }
    const length = encodePing(w, { tick: 0, clientTimeMs: 1 });
    expect(decodePing(r.reset(viewOf(w, length - 1)), pingOut)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    expect(decodePing(r.reset(viewOf(w, length + 1)), pingOut)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
  });
});

describe('MATCH_START and MATCH_PHASE', () => {
  it('round-trips a match start', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const msg = { tick: 100, startTick: 70_000, seed: 0xdeadbeef, map: 'shattered-spires' as const };
    const length = encodeMatchStart(w, msg);
    expect(length).toBe(MATCH_START_BYTES);
    const out = createMatchStartMessage();
    expect(decodeMatchStart(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(r.peekType()).toBe(MSG_MATCH_START);
    expect(out).toEqual(msg);
  });

  it('carries the map id next to the seed, for every map', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    expect(MATCH_START_BYTES).toBe(HEADER_BYTES + 4 + 4 + 1);
    // A fresh message names the first map, so a decode failure can never leave a stale id.
    expect(createMatchStartMessage().map).toBe('shattered-spires');
    for (const map of MAP_IDS) {
      const msg = { tick: 7, startTick: 1234, seed: 0xe3be7fa1, map };
      const length = encodeMatchStart(w, msg);
      expect(length).toBe(MATCH_START_BYTES);
      // The last byte is the index into MAP_IDS.
      expect(w.view.getUint8(length - 1)).toBe(MAP_IDS.indexOf(map));
      const out = createMatchStartMessage();
      expect(decodeMatchStart(r.reset(viewOf(w, length)), out)).toBe(true);
      expect(out).toEqual(msg);
    }
  });

  it('refuses a match start with an unknown map, a short or a long body', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const length = encodeMatchStart(w, {
      tick: 1,
      startTick: 50,
      seed: 9,
      map: 'emberfall-caldera',
    });
    const out = createMatchStartMessage();
    out.seed = 77;
    w.view.setUint8(length - 1, MAP_IDS.length); // one past the table
    expect(decodeMatchStart(r.reset(viewOf(w, length)), out)).toBe(false);
    // Nothing of a refused message is kept.
    expect(out).toEqual({ tick: 0, startTick: 0, seed: 77, map: 'shattered-spires' });
    w.view.setUint8(length - 1, 1);
    expect(decodeMatchStart(r.reset(viewOf(w, length - 1)), out)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    expect(decodeMatchStart(r.reset(viewOf(w, length + 1)), out)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
    // A map id that is not in the wire table cannot be sent at all.
    expect(encodeMatchStart(w, { tick: 1, startTick: 50, seed: 9, map: 'atlantis' as never })).toBe(0);
  });

  it('round-trips every phase and winner', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createMatchPhaseMessage();
    const phases = ['lobby', 'intro', 'countdown', 'playing', 'roundEnd', 'results'] as const;
    const winners = [null, TEAM_EMBER, TEAM_FROST, 'draw'] as const;
    for (const phase of phases) {
      for (const winner of winners) {
        const msg = { tick: 1, phaseStartTick: 123_456, phase, round: 4, winner };
        const length = encodeMatchPhase(w, msg);
        expect(length).toBe(MATCH_PHASE_BYTES);
        expect(decodeMatchPhase(r.reset(viewOf(w, length)), out)).toBe(true);
        expect(r.peekType()).toBe(MSG_MATCH_PHASE);
        expect(out).toEqual(msg);
      }
    }
    w.view.setUint8(HEADER_BYTES + 4, 6); // phase out of range
    expect(decodeMatchPhase(r.reset(viewOf(w, MATCH_PHASE_BYTES)), out)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    w.view.setUint8(HEADER_BYTES + 4, 0);
    w.view.setUint8(HEADER_BYTES + 6, 3); // winner out of range
    expect(decodeMatchPhase(r.reset(viewOf(w, MATCH_PHASE_BYTES)), out)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
  });
});

describe('KICK and HOST_LEFT', () => {
  it('round-trip as bare headers and do not decode as each other', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const r = new Reader();
    const out = createNoticeMessage();

    let length = encodeKick(w, { tick: 300 });
    expect(length).toBe(HEADER_BYTES);
    expect(r.reset(viewOf(w, length)).peekType()).toBe(MSG_KICK);
    expect(decodeKick(r, out)).toBe(true);
    expect(out.tick).toBe(300);
    expect(decodeHostLeft(r, out)).toBe(false);
    expect(r.error).toBe(DECODE_WRONG_TYPE);

    length = encodeHostLeft(w, { tick: 301 });
    expect(length).toBe(HEADER_BYTES);
    expect(r.reset(viewOf(w, length)).peekType()).toBe(MSG_HOST_LEFT);
    expect(decodeHostLeft(r, out)).toBe(true);
    expect(out.tick).toBe(301);
    expect(decodeHostLeft(r.reset(viewOf(w, length + 1)), out)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
  });
});

describe('GAME_EVENTS', () => {
  const events: GameEvent[] = [
    {
      type: 'hit',
      tick: 70_001,
      attackerId: 3,
      targetId: 8,
      source: 'secondary',
      damage: 17.5,
      position: { x: 120.5, y: 310.25, z: -640 },
    },
    {
      type: 'hit',
      tick: 70_002,
      attackerId: NO_PLAYER,
      targetId: 2,
      source: 'storm',
      damage: 0.25,
      position: { x: -998, y: 20, z: 5 },
    },
    {
      type: 'takedown',
      tick: 70_003,
      killerId: NO_PLAYER,
      victimId: 2,
      source: 'terrain',
      position: { x: 1, y: 2, z: 3 },
    },
    {
      type: 'spawn',
      tick: 70_100,
      dragonId: 2,
      team: TEAM_FROST,
      classId: 'bastion',
      position: { x: 0, y: 300, z: 780 },
    },
    {
      type: 'abilityCast',
      tick: 70_150,
      dragonId: 9,
      classId: 'wraith',
      slot: 'ultimate',
      position: { x: 55, y: 410, z: -12 },
      direction: { x: 0.6, y: 0, z: -0.8 },
    },
    {
      type: 'objective',
      tick: 70_200,
      kind: 'captured',
      team: TEAM_EMBER,
      dragonId: NO_PLAYER,
      position: { x: 0, y: 250, z: 0 },
    },
    { type: 'matchPhase', tick: 70_300, phase: 'roundEnd', round: 3, winner: 'draw' },
    { type: 'matchPhase', tick: 70_301, phase: 'countdown', round: 4, winner: null },
    { type: 'matchPhase', tick: 4_000_000_000, phase: 'results', round: 5, winner: TEAM_FROST },
    { type: 'assist', tick: 70_302, assisterId: 4, killerId: 2, victimId: 7 },
    { type: 'assist', tick: 70_303, assisterId: 4, killerId: NO_PLAYER, victimId: 7 },
    {
      type: 'statusApplied',
      tick: 70_304,
      targetId: 7,
      sourceId: 2,
      status: 'blind',
      durationS: 3.5,
      position: { x: -310, y: 280, z: 44 },
    },
    {
      type: 'impact',
      tick: 70_305,
      projectile: 'meteorBomb',
      ownerId: 1,
      targetId: NO_PLAYER,
      position: { x: 12, y: 96, z: -700 },
    },
  ];

  /** Deep copy, because the decoder reuses its scratch objects. */
  function collect(view: DataView): GameEvent[] | null {
    const got: GameEvent[] = [];
    const ok = decodeGameEvents(new Reader().reset(view), {
      emit: (event) => got.push(structuredClone(event)),
    });
    return ok ? got : null;
  }

  function expectClose(got: GameEvent, sent: GameEvent): void {
    const tolerance = WIRE_POSITION_STEP_M / 2 + 1e-9;
    const {
      position: gotPosition,
      direction: gotDirection,
      ...gotRest
    } = got as GameEvent & {
      position?: { x: number; y: number; z: number };
      direction?: { x: number; y: number; z: number };
    };
    const { position, direction, ...rest } = sent as GameEvent & {
      position?: { x: number; y: number; z: number };
      direction?: { x: number; y: number; z: number };
    };
    expect(gotRest).toEqual(rest);
    if (position !== undefined) {
      expect(Math.abs((gotPosition?.x ?? NaN) - position.x)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs((gotPosition?.y ?? NaN) - position.y)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs((gotPosition?.z ?? NaN) - position.z)).toBeLessThanOrEqual(tolerance);
    }
    if (direction !== undefined) {
      expect(gotDirection?.x).toBeCloseTo(direction.x, 4);
      expect(gotDirection?.y).toBeCloseTo(direction.y, 4);
      expect(gotDirection?.z).toBeCloseTo(direction.z, 4);
    }
  }

  it('covers every event type', () => {
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(GAME_EVENT_TYPES));
  });

  it('round-trips a mixed batch in order', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    beginGameEvents(w, 70_301);
    for (const event of events) expect(writeGameEvent(w, event)).toBe(true);
    expect(gameEventCount(w)).toBe(events.length);
    const length = endGameEvents(w);
    // header 3 + count 1 + 18 + 18 + 14 + 14 + 20 + 14 + 8 + 8 + 8, then assist 8 + 8,
    // statusApplied 16, impact 14
    expect(length).toBe(172);
    expect(new Reader().reset(viewOf(w, length)).peekType()).toBe(MSG_GAME_EVENTS);

    const got = collect(viewOf(w, length));
    expect(got).toHaveLength(events.length);
    events.forEach((sent, i) => {
      const event = got?.[i];
      if (event === undefined) throw new Error('missing event');
      expectClose(event, sent);
    });
  });

  it('feeds a GameEventBus, which copies the reused scratch events', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    beginGameEvents(w, 0);
    for (const event of events) writeGameEvent(w, event);
    const length = endGameEvents(w);

    const bus = createGameEventBus();
    const hits: number[] = [];
    const phases: string[] = [];
    bus.on('hit', (event) => hits.push(event.damage));
    bus.on('matchPhase', (event) => phases.push(`${event.phase}:${event.round}`));
    expect(decodeGameEvents(new Reader().reset(viewOf(w, length)), bus)).toBe(true);
    expect(bus.pending).toBe(events.length);
    bus.flush();
    expect(hits).toEqual([17.5, 0.25]);
    expect(phases).toEqual(['roundEnd:3', 'countdown:4', 'results:5']);
  });

  it('returns 0 for an empty batch so nothing is sent', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    beginGameEvents(w, 5);
    expect(gameEventCount(w)).toBe(0);
    expect(endGameEvents(w)).toBe(0);
    // An explicitly empty batch on the wire is still legal.
    expect(collect(viewOf(w, HEADER_BYTES + 1))).toEqual([]);
  });

  it('stops at the batch limit and at the end of the buffer without corrupting the batch', () => {
    const big = new Writer(CTRL_MAX_BYTES);
    const phase = events[6];
    const hit = events[0];
    if (phase === undefined || hit === undefined) throw new Error('fixture');
    beginGameEvents(big, 0);
    for (let i = 0; i < MAX_EVENTS_PER_BATCH; i++) expect(writeGameEvent(big, phase)).toBe(true);
    expect(writeGameEvent(big, phase)).toBe(false);
    expect(collect(viewOf(big, endGameEvents(big)))).toHaveLength(MAX_EVENTS_PER_BATCH);

    const small = new Writer(HEADER_BYTES + 1 + 18 + 10);
    beginGameEvents(small, 0);
    expect(writeGameEvent(small, hit)).toBe(true);
    expect(writeGameEvent(small, hit)).toBe(false); // would not fit: rolled back
    expect(writeGameEvent(small, phase)).toBe(true); // a smaller one still does
    const length = endGameEvents(small);
    expect(length).toBe(HEADER_BYTES + 1 + 18 + 8);
    expect(collect(viewOf(small, length))).toHaveLength(2);
  });

  it('is all-or-nothing: a bad event anywhere emits nothing', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    beginGameEvents(w, 0);
    for (const event of events) writeGameEvent(w, event);
    const length = endGameEvents(w);
    const bytes = new Uint8Array(w.buffer);
    const pristine = bytes.slice(0, length);
    const r = new Reader();
    let emitted = 0;
    const sink = { emit: () => void emitted++ };

    // The kind byte of the LAST event (an impact: 14 bytes).
    bytes[length - 14] = 99;
    expect(decodeGameEvents(r.reset(viewOf(w, length)), sink)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    bytes.set(pristine);

    // Damage of the first hit: NaN, then negative.
    w.view.setFloat32(HEADER_BYTES + 1 + 8, NaN, true);
    expect(decodeGameEvents(r.reset(viewOf(w, length)), sink)).toBe(false);
    w.view.setFloat32(HEADER_BYTES + 1 + 8, -4, true);
    expect(decodeGameEvents(r.reset(viewOf(w, length)), sink)).toBe(false);
    bytes.set(pristine);

    bytes[HEADER_BYTES + 1 + 6] = NO_PLAYER; // hit target must be a real dragon
    expect(decodeGameEvents(r.reset(viewOf(w, length)), sink)).toBe(false);
    bytes.set(pristine);

    bytes[HEADER_BYTES] = events.length + 1; // count says one more than there is
    expect(decodeGameEvents(r.reset(viewOf(w, length)), sink)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    bytes[HEADER_BYTES] = events.length - 1; // one fewer: bytes left over
    expect(decodeGameEvents(r.reset(viewOf(w, length)), sink)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
    bytes.set(pristine);

    expect(emitted).toBe(0);
    expect(decodeGameEvents(r.reset(viewOf(w, length)), sink)).toBe(true);
    expect(emitted).toBe(events.length);
  });

  it('normalises the aim direction and survives a zero vector', () => {
    const w = new Writer(CTRL_MAX_BYTES);
    const cast = events[4];
    if (cast === undefined || cast.type !== 'abilityCast') throw new Error('fixture');
    beginGameEvents(w, 0);
    writeGameEvent(w, { ...cast, direction: { x: 0, y: 0, z: 0 } });
    writeGameEvent(w, { ...cast, direction: { x: 30, y: NaN, z: -40 } });
    const got = collect(viewOf(w, endGameEvents(w)));
    const first = got?.[0];
    const second = got?.[1];
    if (first?.type !== 'abilityCast' || second?.type !== 'abilityCast') throw new Error('decode');
    expect(first.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(Math.hypot(second.direction.x, second.direction.y, second.direction.z)).toBeCloseTo(
      1,
      6,
    );
  });
});
