/**
 * Hostile and broken clients: garbage, truncated, bit-flipped, oversized, wrong-channel and
 * wrong-direction messages, before and after the handshake, in the lobby and in a match. The
 * host must never throw, never let the sender change anything but its own seat, and keep
 * serving everyone else exactly as before.
 */

import { describe, expect, it } from 'vitest';
import {
  Reader,
  Writer,
  decodeWelcome,
  encodeHello,
  encodeInput,
  encodeIntent,
  encodeLobbyState,
  encodeMatchStart,
  encodePing,
  encodeSnapshot,
  encodeWelcome,
} from '../../src/net/codec';
import {
  CTRL_MAX_BYTES,
  MSG_WELCOME,
  createHelloMessage,
  createInputMessage,
  createIntentMessage,
  createLobbyStateMessage,
  createMatchStartMessage,
  createPingMessage,
  createSnapshotMessage,
  createWelcomeMessage,
} from '../../src/net/protocol';
import type { NetIntent } from '../../src/net/protocol';
import { NOOP_CLIENT_HANDLERS } from '../../src/net/transport';
import type { Channel, LoopbackClientTransport } from '../../src/net/transport';
import { BUTTON_MASK, PROTOCOL_VERSION, createSeededRandom } from '../../src/shared';
import type { LobbyState } from '../../src/shared';
import { createRoom, startMatch } from './session-harness';
import type { Rig } from './session-harness';

interface RawClient {
  readonly transport: LoopbackClientTransport;
  playerId: number;
  closed: boolean;
}

/** A hand-driven link; with `hello` it completes the handshake and learns its player id. */
function attach(rig: Rig, hello: boolean): RawClient {
  const transport = rig.hub.createClient();
  const raw: RawClient = { transport, playerId: -1, closed: false };
  transport.setHandlers({
    ...NOOP_CLIENT_HANDLERS,
    onClose: () => {
      raw.closed = true;
    },
    onMessage: (_channel, data) => {
      if (typeof data === 'string' || new Uint8Array(data)[0] !== MSG_WELCOME) return;
      const welcome = createWelcomeMessage();
      if (decodeWelcome(new Reader().reset(new DataView(data.slice(0))), welcome)) {
        raw.playerId = welcome.playerId;
      }
    },
  });
  transport.connect(rig.host.roomCode);
  rig.run(5);
  if (hello) {
    const writer = new Writer(CTRL_MAX_BYTES);
    const message = createHelloMessage();
    message.protocolVersion = PROTOCOL_VERSION;
    message.name = 'Mallory';
    transport.send('ctrl', writer.packet(encodeHello(writer, message)));
    rig.run(20);
    expect(raw.playerId).toBeGreaterThan(0);
  }
  return raw;
}

/** Valid messages of every kind, client-to-host and host-to-client, as raw material. */
function corpus(lobby: LobbyState): Uint8Array[] {
  const writer = new Writer(CTRL_MAX_BYTES);
  const out: Uint8Array[] = [];
  const keep = (length: number): void => {
    if (length > 0) out.push(writer.packet(length).slice());
  };

  const hello = createHelloMessage();
  hello.protocolVersion = PROTOCOL_VERSION;
  hello.name = 'Mallory';
  hello.reconnectToken = '0123456789abcdef0123456789abcdef';
  keep(encodeHello(writer, hello));

  const ping = createPingMessage();
  ping.clientTimeMs = 1234.5;
  keep(encodePing(writer, ping));

  const input = createInputMessage();
  input.frameCount = 3;
  input.tick = 500;
  input.frames.forEach((frame, i) => {
    frame.tick = 500 - i;
    frame.steerX = 0.5;
    frame.steerY = -0.25;
    frame.buttons = 0x7ff;
  });
  keep(encodeInput(writer, input));

  const intents: NetIntent[] = [
    { type: 'lobby.ready', ready: true },
    { type: 'lobby.pickClass', classId: 'tempest' },
    { type: 'lobby.switchSide', side: 1 },
    { type: 'host.setMode', mode: 'duel' },
    { type: 'host.setMap', map: 'shattered-spires' },
    { type: 'host.setTeamSize', teamSize: 1 },
    { type: 'host.setUnevenTeams', enabled: true },
    { type: 'host.setScoreLimit', scoreLimit: 1 },
    { type: 'host.setTimeLimit', timeLimitS: 60 },
    { type: 'host.setFriendlyFire', enabled: true },
    { type: 'host.setAllowedClasses', classes: ['talon'] },
    { type: 'host.movePlayer', playerId: 0, side: 'spectator' },
    { type: 'host.autoBalance' },
    { type: 'host.shuffle' },
    { type: 'host.lockTeams', locked: true },
    { type: 'host.kick', playerId: 1 },
    { type: 'host.kick', playerId: 0 },
    { type: 'host.start' },
  ];
  const intent = createIntentMessage();
  for (const one of intents) {
    intent.intent = one;
    keep(encodeIntent(writer, intent));
  }

  // Messages only the host may send: a client that sends them is trying to set state.
  const welcome = createWelcomeMessage();
  welcome.playerId = 0;
  welcome.reconnectToken = 'ffffffffffffffffffffffffffffffff';
  welcome.lobbyState = lobby;
  keep(encodeWelcome(writer, welcome));
  const state = createLobbyStateMessage();
  state.lobbyState = { ...lobby, hostId: 1 };
  keep(encodeLobbyState(writer, state));
  const start = createMatchStartMessage();
  start.startTick = 1;
  keep(encodeMatchStart(writer, start));
  const snapshot = createSnapshotMessage();
  snapshot.dragonCount = 2;
  keep(encodeSnapshot(writer, snapshot));
  return out;
}

/** One hostile message: garbage, or a valid message cut short, extended or with flipped bits. */
function mutate(random: () => number, valid: readonly Uint8Array[]): Uint8Array | string {
  const pick = Math.floor(random() * 10);
  const source = valid[Math.floor(random() * valid.length)] ?? new Uint8Array(4);
  switch (pick) {
    case 0: {
      const bytes = new Uint8Array(Math.floor(random() * 400));
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
      return bytes;
    }
    case 1:
      return source.slice(0, Math.floor(random() * source.length));
    case 2: {
      const bytes = new Uint8Array(source.length + 1 + Math.floor(random() * 40));
      bytes.set(source);
      return bytes;
    }
    case 3:
    case 4:
    case 5: {
      const bytes = source.slice();
      const flips = 1 + Math.floor(random() * 4);
      for (let i = 0; i < flips; i++) {
        const at = Math.floor(random() * bytes.length);
        bytes[at] = (bytes[at] ?? 0) ^ (1 << Math.floor(random() * 8));
      }
      return bytes;
    }
    case 6: {
      // Any type byte on top of another message's body.
      const bytes = source.slice();
      bytes[0] = Math.floor(random() * 256);
      return bytes;
    }
    case 7:
      return random() < 0.5 ? new Uint8Array(0) : new Uint8Array(CTRL_MAX_BYTES + 1 + 4000);
    case 8:
      return random() < 0.5 ? '{"type":"host.start"}' : 'x'.repeat(Math.floor(random() * 200));
    default:
      return source;
  }
}

function spray(
  rig: Rig,
  raw: RawClient,
  random: () => number,
  valid: readonly Uint8Array[],
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const channel: Channel = random() < 0.5 ? 'ctrl' : 'fast';
    const message = mutate(random, valid);
    expect(() => {
      raw.transport.send(channel, message);
      if (i % 7 === 0) rig.run(1);
    }).not.toThrow();
  }
  expect(() => rig.run(40)).not.toThrow();
}

/** The lobby without one player's own row: what a hostile client must not be able to change. */
function withoutPlayer(lobby: LobbyState, id: number): unknown {
  return { ...lobby, players: lobby.players.filter((p) => p.id !== id) };
}

describe('fuzz: a hostile client', () => {
  it('cannot crash the host or change the room before the handshake', () => {
    const rig = createRoom(2);
    rig.run(100);
    const before = rig.host.lobby;
    const random = createSeededRandom(0xfa22);
    const valid = corpus(before).slice(1); // without the hello: this link never introduces itself
    let raw = attach(rig, false);
    let links = 1;
    for (let round = 0; round < 40; round++) {
      // A mutated message can come out as a hello of another protocol version: the host
      // rejects it and closes the link, as it should. Carry on with a new one.
      if (raw.closed) {
        raw = attach(rig, false);
        links++;
      }
      spray(rig, raw, random, valid, 100);
    }
    // Nobody got a seat and nothing in the room moved.
    expect(rig.host.lobby).toEqual(before);
    expect(rig.host.counters.malformed).toBeGreaterThan(1000);
    expect(links).toBeLessThan(40);
    expect(rig.host.state).toBe('open');
    for (const client of rig.clients) expect(client.session.status).toBe('connected');
    rig.dispose();
  });

  it('cannot change anything but its own seat from inside the lobby', () => {
    for (const seed of [1, 2, 3]) {
      const rig = createRoom(2);
      rig.run(100);
      const raw = attach(rig, true);
      rig.run(100);
      const before = rig.host.lobby;
      const random = createSeededRandom(seed);
      spray(rig, raw, random, corpus(before), 4000);

      const after = rig.host.lobby;
      // Settings, phase, host and every other player are exactly as they were. Its own seat
      // may have changed class, side or ready flag, or be gone (a valid `lobby.leave`).
      expect(after.settings).toEqual(before.settings);
      expect(after.phase).toBe('lobby');
      expect(after.hostId).toBe(before.hostId);
      expect(withoutPlayer(after, raw.playerId)).toEqual(withoutPlayer(before, raw.playerId));
      expect(rig.host.inMatch).toBe(false);
      expect(rig.host.state).toBe('open');
      // The flood ran into the rate limiter and the type/channel checks.
      expect(rig.host.counters.malformed).toBeGreaterThan(1000);
      expect(rig.host.counters.intentsRefused).toBeGreaterThan(50);
      // The honest clients were not disturbed and agree with the host.
      rig.run(100);
      for (const client of rig.clients) {
        expect(client.session.status).toBe('connected');
        expect(client.session.lobby).toEqual(rig.host.lobby);
      }
      rig.dispose();
    }
  });

  it('cannot corrupt a running match: every dragon stays finite and honest clients stay exact', () => {
    const rig = createRoom(3);
    startMatch(rig);
    const mallory = attach(rig, true);
    rig.run(200);
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    const before = rig.host.lobby;
    const random = createSeededRandom(0xbad);
    const valid = corpus(before);

    // Honest client 0's prediction error, measured through the whole attack.
    const [honest] = rig.clients;
    if (honest === undefined) throw new Error('no client');
    const honestId = honest.session.localPlayerId;
    const predicted = new Map<number, number>();
    let worst = 0;
    let compared = 0;
    rig.onClientTick = (client, _index, tick) => {
      if (client === honest) predicted.set(tick, client.session.predictor.dragon.position.z);
    };
    rig.onHostTick = (tick) => {
      const mine = predicted.get(tick);
      const dragon = sim.getDragon(honestId);
      if (mine !== undefined && dragon !== undefined) {
        worst = Math.max(worst, Math.abs(mine - dragon.position.z));
        compared++;
      }
      for (const dragon of sim.current.dragons) {
        if (!dragon.active) continue;
        const values = [
          dragon.position.x,
          dragon.position.y,
          dragon.position.z,
          dragon.yaw,
          dragon.pitch,
          dragon.speed,
          dragon.health,
          dragon.stamina,
        ];
        for (const value of values) expect(Number.isFinite(value)).toBe(true);
        expect(dragon.stamina).toBeGreaterThanOrEqual(0);
        expect(dragon.stamina).toBeLessThanOrEqual(1);
      }
    };

    for (let round = 0; round < 30; round++) {
      spray(rig, mallory, random, valid, 300);
    }

    expect(compared).toBeGreaterThan(60);
    expect(worst).toBeLessThan(0.001);
    expect(rig.host.lobby.settings).toEqual(before.settings);
    expect(rig.host.lobby.phase).toBe('inMatch');
    expect(withoutPlayer(rig.host.lobby, mallory.playerId)).toEqual(
      withoutPlayer(before, mallory.playerId),
    );
    // A spectator has no dragon to steer, whatever inputs it sends.
    expect(sim.current.dragonCount).toBe(4);
    expect(sim.getDragon(mallory.playerId)).toBeUndefined();
    expect(rig.host.matchPhase).toBe('playing');
    for (const client of rig.clients) expect(client.session.status).toBe('connected');
    rig.dispose();
  });

  it('a rider sending absurd inputs only ever gets clamped, in-range inputs applied', () => {
    const rig = createRoom(3);
    startMatch(rig);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    const id = a.session.localPlayerId;
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    // The client's own pilot goes mad: out-of-range steer, NaN, every button bit.
    let step = 0;
    a.pilot.sample = (frame) => {
      const mode = step++ % 4;
      frame.steerX = mode === 0 ? 1e9 : mode === 1 ? -Infinity : mode === 2 ? NaN : 3;
      frame.steerY = mode === 0 ? NaN : -1e9;
      frame.buttons = 0xffffffff;
    };
    const buffer = rig.host.inputBufferOf(id);
    if (buffer === null) throw new Error('no buffer');
    const original = buffer.take.bind(buffer);
    let applied = 0;
    buffer.take = (tick: number) => {
      const frame = original(tick);
      if (frame !== undefined) {
        applied++;
        expect(Math.abs(frame.steerX)).toBeLessThanOrEqual(1);
        expect(Math.abs(frame.steerY)).toBeLessThanOrEqual(1);
        expect(frame.buttons & ~BUTTON_MASK).toBe(0);
        expect(frame.tick).toBe(tick);
      }
      return frame;
    };
    rig.runTicks(150);
    expect(applied).toBeGreaterThan(140);
    const dragon = sim.getDragon(id);
    expect(Number.isFinite(dragon?.position.x)).toBe(true);
    expect(Number.isFinite(dragon?.speed)).toBe(true);
    expect(dragon?.speed).toBeLessThan(200);
    rig.dispose();
  });
});

describe('fuzz: a broken host', () => {
  it('garbage from the host never throws in a client and never changes who it is', () => {
    const rig = createRoom(1);
    startMatch(rig);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    const id = a.session.localPlayerId;
    const random = createSeededRandom(77);
    // Without the notices and rejects, which a host may legitimately send.
    const valid = corpus(rig.host.lobby).slice(0, 3);
    for (let i = 0; i < 3000; i++) {
      const message = mutate(random, valid);
      expect(() => {
        rig.hostTransport.send(1, random() < 0.5 ? 'ctrl' : 'fast', message);
        if (i % 5 === 0) rig.run(1);
      }).not.toThrow();
    }
    rig.run(200);
    expect(a.session.localPlayerId).toBe(id);
    expect(a.session.counters.malformed).toBeGreaterThan(1500);
    expect(['connected', 'kicked', 'hostLeft']).toContain(a.session.status);
  });
});
