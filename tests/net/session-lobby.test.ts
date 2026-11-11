/**
 * HostSession / ClientSession in the lobby: joining by code, the handshake and its reject
 * paths, lobby operations propagating, host-only enforcement, kick, leave, host leaving.
 */

import { describe, expect, it } from 'vitest';
import {
  Reader,
  Writer,
  decodeReject,
  decodeWelcome,
  encodeHello,
  encodeIntent,
} from '../../src/net/codec';
import {
  CTRL_MAX_BYTES,
  MSG_LOBBY_STATE,
  MSG_REJECT,
  MSG_WELCOME,
  createHelloMessage,
  createIntentMessage,
  createRejectMessage,
  createWelcomeMessage,
} from '../../src/net/protocol';
import { HostSession, createMemoryTokenStore } from '../../src/net/session';
import type { ReconnectTokenStore } from '../../src/net/session';
import { NOOP_CLIENT_HANDLERS, createLoopbackHub } from '../../src/net/transport';
import {
  MAX_LOBBY_MEMBERS,
  MAX_SPECTATORS,
  NO_PLAYER,
  PROTOCOL_VERSION,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../src/shared';
import type { LobbyPlayer, LobbyState } from '../../src/shared';
import { ROOM, Rig, createRoom, startMatch } from './session-harness';

function playerOf(lobby: LobbyState | null, id: number): LobbyPlayer {
  const player = lobby?.players.find((p) => p.id === id);
  if (player === undefined) throw new Error(`no player ${id} in the lobby`);
  return player;
}

describe('hosting and joining', () => {
  it('opens a room under a generated code and retries when the code is taken', () => {
    const hub = createLoopbackHub();
    // The first host holds whatever code the seeded generator gives first.
    const first = new HostSession({
      transport: hub.createHost(),
      hostName: 'A',
      random: sequence([0.1, 0.1, 0.1, 0.1, 0.1]),
    });
    first.open();
    hub.flush();
    expect(first.state).toBe('open');
    expect(first.roomCode).toHaveLength(5);

    // The second generator repeats that code once, then moves on.
    const second = new HostSession({
      transport: hub.createHost(),
      hostName: 'B',
      random: sequence([0.1, 0.1, 0.1, 0.1, 0.1, 0.5, 0.6, 0.7, 0.8, 0.9]),
    });
    second.open();
    hub.flush();
    expect(second.state).toBe('open');
    expect(second.roomCode).toHaveLength(5);
    expect(second.roomCode).not.toBe(first.roomCode);
    expect(second.lobby.roomCode).toBe(second.roomCode);
    first.close();
    second.close();
  });

  it('reports a fixed code that is taken as a fatal error', () => {
    const hub = createLoopbackHub();
    const first = new HostSession({ transport: hub.createHost(), hostName: 'A', roomCode: ROOM });
    first.open();
    hub.flush();
    const second = new HostSession({ transport: hub.createHost(), hostName: 'B', roomCode: ROOM });
    second.open();
    hub.flush();
    expect(second.state).toBe('closed');
    expect(second.error?.reason).toBe('idTaken');
  });

  it('three clients join by code and everyone sees the same lobby', () => {
    const rig = createRoom(3);
    rig.run(100);
    const host = rig.host.lobby;
    expect(host.players.map((p) => p.name)).toEqual(['Host', 'Rider 1', 'Rider 2', 'Rider 3']);
    expect(host.roomCode).toBe(ROOM);
    const ids = new Set<number>([rig.host.localPlayerId]);
    for (const client of rig.clients) {
      expect(client.session.status).toBe('connected');
      expect(client.session.error).toBeNull();
      expect(client.session.localPlayerId).not.toBe(NO_PLAYER);
      ids.add(client.session.localPlayerId);
      expect(client.session.lobby).toEqual(host);
      // Every client got a reconnect token and stored it.
      expect(client.tokens.load(ROOM)).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(ids.size).toBe(4);
    expect(rig.host.clientCount).toBe(3);
    // Newcomers alternate onto the smaller team.
    expect(host.players.map((p) => p.side)).toEqual([
      TEAM_EMBER,
      TEAM_FROST,
      TEAM_EMBER,
      TEAM_FROST,
    ]);
    rig.dispose();
  });

  it('normalises a typed code and fails cleanly on a wrong or malformed one', () => {
    const rig = new Rig().open();
    const typed = rig.join('Typed', {}, ' kh7-p2 ');
    expect(typed.session.status).toBe('connected');

    const wrong = rig.join('Wrong', {}, 'ZZZZZ');
    expect(wrong.session.status).toBe('failed');
    expect(wrong.session.error).toEqual({ kind: 'connectFailed', reason: 'roomNotFound' });

    const malformed = rig.join('Bad', {}, 'nope');
    expect(malformed.session.status).toBe('failed');
    expect(malformed.session.error).toEqual({ kind: 'connectFailed', reason: 'invalidRoomCode' });
    rig.dispose();
  });

  it('sanitises and de-duplicates names', () => {
    const rig = new Rig().open();
    const a = rig.join('  Same\u0000Name  ');
    const b = rig.join('SameName');
    const c = rig.join('');
    const names = rig.host.lobby.players.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(playerOf(rig.host.lobby, c.session.localPlayerId).name.length).toBeGreaterThan(0);
    expect(playerOf(rig.host.lobby, a.session.localPlayerId).name).not.toContain('\u0000');
    expect(b.session.status).toBe('connected');
    rig.dispose();
  });
});

describe('lobby operations', () => {
  it('propagate to every client, coalesced into one LOBBY_STATE per tick', () => {
    const rig = createRoom(3);
    const [a, b, c] = rig.clients;
    if (a === undefined || b === undefined || c === undefined) throw new Error('no clients');
    rig.run(200);

    // Count LOBBY_STATE messages on one client's link.
    let lobbyStates = 0;
    const session = a.session;
    const seen: LobbyState[] = [];
    // The listener is fixed at construction, so watch identity changes instead.
    let last = session.lobby;
    rig.onClientFrame = (client) => {
      if (client === a && client.session.lobby !== last) {
        last = client.session.lobby;
        lobbyStates++;
        if (last !== null) seen.push(last);
      }
    };

    // Several changes inside one host tick.
    expect(rig.host.applyIntent({ type: 'host.setTeamSize', teamSize: 3 })).toBe(true);
    expect(rig.host.applyIntent({ type: 'host.setScoreLimit', scoreLimit: 12 })).toBe(true);
    expect(rig.host.applyIntent({ type: 'host.setFriendlyFire', enabled: true })).toBe(true);
    rig.run(120);
    expect(lobbyStates).toBe(1);
    for (const client of rig.clients) {
      expect(client.session.lobby?.settings.teamSize).toBe(3);
      expect(client.session.lobby?.settings.scoreLimit).toBe(12);
      expect(client.session.lobby?.settings.friendlyFire).toBe(true);
    }

    // Client intents: class, ready, side.
    expect(a.session.sendIntent({ type: 'lobby.pickClass', classId: 'tempest' })).toBe(true);
    expect(b.session.sendIntent({ type: 'lobby.switchSide', side: 'spectator' })).toBe(true);
    rig.run(120);
    expect(a.session.sendIntent({ type: 'lobby.ready', ready: true })).toBe(true);
    rig.run(120);
    for (const client of rig.clients) {
      const lobby = client.session.lobby;
      expect(playerOf(lobby, a.session.localPlayerId).classId).toBe('tempest');
      expect(playerOf(lobby, a.session.localPlayerId).ready).toBe(true);
      expect(playerOf(lobby, b.session.localPlayerId).side).toBe('spectator');
      expect(lobby).toEqual(rig.host.lobby);
    }

    // Host moves a player; the move clears their ready flag.
    const before = playerOf(rig.host.lobby, a.session.localPlayerId).side;
    const other = before === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
    expect(
      rig.host.applyIntent({
        type: 'host.movePlayer',
        playerId: a.session.localPlayerId,
        side: other,
      }),
    ).toBe(true);
    rig.run(120);
    expect(playerOf(c.session.lobby, a.session.localPlayerId).side).toBe(other);
    expect(playerOf(c.session.lobby, a.session.localPlayerId).ready).toBe(false);
    rig.dispose();
  });

  it('ignores host-only intents from a client, and local-only intents altogether', () => {
    const rig = createRoom(2);
    const [a, b] = rig.clients;
    if (a === undefined || b === undefined) throw new Error('no clients');
    rig.run(100);
    const before = rig.host.lobby;
    const refusedBefore = rig.host.counters.intentsRefused;

    a.session.sendIntent({ type: 'host.setTeamSize', teamSize: 1 });
    a.session.sendIntent({ type: 'host.kick', playerId: b.session.localPlayerId });
    a.session.sendIntent({ type: 'host.kick', playerId: rig.host.localPlayerId });
    a.session.sendIntent({ type: 'host.lockTeams', locked: true });
    a.session.sendIntent({ type: 'host.movePlayer', playerId: b.session.localPlayerId, side: 0 });
    a.session.sendIntent({ type: 'host.start' });
    rig.run(200);

    expect(rig.host.lobby).toBe(before);
    expect(rig.host.counters.intentsRefused - refusedBefore).toBe(6);
    expect(rig.host.inMatch).toBe(false);
    expect(b.session.status).toBe('connected');

    // Not network intents at all: nothing is sent.
    expect(a.session.sendIntent({ type: 'lobby.focusPlayer', playerId: 0 })).toBe(false);
    expect(a.session.sendIntent({ type: 'title.host', name: 'x' })).toBe(false);
    expect(rig.host.applyIntent({ type: 'settings.reset' })).toBe(false);
    rig.dispose();
  });

  it('rate-limits a client that floods intents', () => {
    const rig = createRoom(1);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    rig.run(100);
    const refusedBefore = rig.host.counters.intentsRefused;
    for (let i = 0; i < 200; i++) {
      a.session.sendIntent({ type: 'lobby.ready', ready: i % 2 === 0 });
    }
    rig.run(100);
    // The burst passes, the flood does not.
    const refused = rig.host.counters.intentsRefused - refusedBefore;
    expect(refused).toBeGreaterThan(150);
    expect(refused).toBeLessThan(200);
    rig.dispose();
  });

  it('reports the start blocker and starts once everyone is ready', () => {
    const rig = createRoom(3);
    rig.run(100);
    expect(rig.host.startBlocker()).toBe('notAllReady');
    expect(rig.host.applyIntent({ type: 'host.start' })).toBe(false);
    for (const client of rig.clients)
      client.session.sendIntent({ type: 'lobby.ready', ready: true });
    rig.run(200);
    expect(rig.host.startBlocker()).toBeNull();
    expect(rig.host.applyIntent({ type: 'host.start' })).toBe(true);
    rig.run(100);
    expect(rig.host.inMatch).toBe(true);
    expect(rig.host.lobby.phase).toBe('starting');
    for (const client of rig.clients) {
      expect(client.session.inMatch).toBe(true);
      expect(client.session.matchPhase).toBe('countdown');
      expect(client.session.lobby?.phase).toBe('starting');
    }
    rig.runUntil(() => rig.host.matchPhase === 'playing');
    rig.run(100);
    expect(rig.host.lobby.phase).toBe('inMatch');
    for (const client of rig.clients) expect(client.session.matchPhase).toBe('playing');

    // And back.
    expect(rig.host.endMatch()).toBe(true);
    rig.run(100);
    expect(rig.host.inMatch).toBe(false);
    expect(rig.host.sim).toBeNull();
    for (const client of rig.clients) {
      expect(client.session.inMatch).toBe(false);
      expect(client.session.lobby?.phase).toBe('lobby');
      expect(playerOf(client.session.lobby, client.session.localPlayerId).ready).toBe(false);
    }
    rig.dispose();
  });

  it('ending a match keeps the room: a rider who watched the first one flies the second', () => {
    const rig = createRoom(1);
    startMatch(rig);
    // Joins while the match runs: teams are frozen, so this player can only watch.
    const late = rig.join('Late');
    rig.run(500);
    expect(late.session.status).toBe('connected');
    expect(late.session.inMatch).toBe(true);
    expect(late.session.isRider).toBe(false);

    expect(rig.host.endMatch()).toBe(true);
    rig.run(200);
    expect(rig.host.lobby.phase).toBe('lobby');
    expect(rig.host.lobby.players).toHaveLength(3);
    for (const client of rig.clients) {
      expect(client.session.status).toBe('connected');
      expect(client.session.inMatch).toBe(false);
    }

    // Back in the lobby the latecomer takes a side; the same room starts again.
    const lateId = late.session.localPlayerId;
    expect(
      rig.host.applyIntent({ type: 'host.movePlayer', playerId: lateId, side: TEAM_EMBER }),
    ).toBe(true);
    rig.run(100);
    expect(rig.host.applyIntent({ type: 'host.setUnevenTeams', enabled: true })).toBe(true);
    startMatch(rig);
    rig.run(500);
    expect(rig.host.sim?.getDragon(lateId)).toBeDefined();
    for (const client of rig.clients) {
      expect(client.session.inMatch).toBe(true);
      expect(client.session.isRider).toBe(true);
      expect(client.session.matchPhase).toBe('playing');
    }
    rig.dispose();
  });
});

describe('match start', () => {
  it('sends the lobby state the roster was built from before MATCH_START', () => {
    const rig = createRoom(1);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    rig.run(100);
    // A class pick and the ready-up reach the host and Start is pressed before the next host
    // tick, i.e. before the coalesced LOBBY_STATE of that tick would have gone out.
    a.session.sendIntent({ type: 'lobby.pickClass', classId: 'tempest' });
    a.session.sendIntent({ type: 'lobby.ready', ready: true });
    rig.hub.pump();
    expect(rig.host.applyIntent({ type: 'host.start' })).toBe(true);
    rig.hub.pump();
    const id = a.session.localPlayerId;
    expect(a.session.inMatch).toBe(true);
    expect(a.session.lobby?.phase).toBe('starting');
    expect(a.session.roster.classOf(id)).toBe('tempest');
    expect(rig.host.sim?.getDragon(id)?.classId).toBe('tempest');

    // The client predicts with the right class: no corrections once flying.
    rig.runUntil(() => rig.host.matchPhase === 'playing');
    rig.runTicks(120);
    expect(a.session.predictor.dragon.classId).toBe('tempest');
    expect(a.session.predictor.matchCount).toBeGreaterThan(60);
    expect(a.session.predictor.correctionCount).toBe(0);
    rig.dispose();
  });
});

describe('reject paths', () => {
  /** A bare transport that speaks the codec by hand, for messages a ClientSession never sends. */
  function rawClient(rig: Rig): {
    send(bytes: Uint8Array): void;
    received: { type: number; bytes: Uint8Array }[];
    closed: () => boolean;
  } {
    const transport = rig.hub.createClient();
    const received: { type: number; bytes: Uint8Array }[] = [];
    let closed = false;
    transport.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onClose: () => {
        closed = true;
      },
      onMessage: (_channel, data) => {
        if (typeof data === 'string') return;
        const bytes = new Uint8Array(data).slice();
        received.push({ type: bytes[0] ?? -1, bytes });
      },
    });
    transport.connect(rig.host.roomCode);
    rig.run(5);
    return {
      send: (bytes) => {
        transport.send('ctrl', bytes);
      },
      received,
      closed: () => closed,
    };
  }

  it('rejects another protocol version and closes the link', () => {
    const rig = new Rig().open();
    const raw = rawClient(rig);
    const writer = new Writer(CTRL_MAX_BYTES);
    const hello = createHelloMessage();
    hello.protocolVersion = PROTOCOL_VERSION + 1;
    hello.name = 'Old build';
    raw.send(writer.packet(encodeHello(writer, hello)));
    rig.run(10);
    expect(raw.received.map((m) => m.type)).toEqual([MSG_REJECT]);
    const reject = createRejectMessage();
    const bytes = raw.received[0]?.bytes ?? new Uint8Array();
    expect(decodeReject(new Reader().reset(new DataView(bytes.buffer)), reject)).toBe(true);
    expect(reject.reason).toBe('versionMismatch');
    expect(rig.host.lobby.players).toHaveLength(1);
    // The close follows after the grace, so the message got out first.
    rig.run(400);
    expect(raw.closed()).toBe(true);
    expect(rig.host.counters.rejectedHellos).toBe(1);
    rig.dispose();
  });

  it('rejects with `full` when the room has no seat left', () => {
    const rig = new Rig().open();
    for (let i = 1; i < MAX_LOBBY_MEMBERS; i++) {
      expect(rig.join(`P${i}`).session.status).toBe('connected');
    }
    expect(rig.host.lobby.players).toHaveLength(MAX_LOBBY_MEMBERS);
    const extra = rig.join('One too many');
    expect(extra.session.status).toBe('rejected');
    expect(extra.session.error).toEqual({ kind: 'rejected', reason: 'full' });
    expect(rig.host.lobby.players).toHaveLength(MAX_LOBBY_MEMBERS);
    rig.dispose();
  });

  it('a kick sticks: the same tab and a new tab of that browser are both refused', () => {
    const BROWSER = '0123456789abcdef0123456789abcdef';
    const rig = new Rig().open();
    const a = rig.join('Kickme', { clientId: BROWSER });
    const id = a.session.localPlayerId;
    rig.run(50);
    const token = a.tokens.load(ROOM);
    expect(token).not.toBe('');

    expect(rig.host.applyIntent({ type: 'host.kick', playerId: id })).toBe(true);
    rig.run(50);
    expect(a.session.status).toBe('kicked');
    expect(a.session.error).toEqual({ kind: 'kicked' });
    expect(rig.host.lobby.players.some((p) => p.id === id)).toBe(false);
    rig.run(500);
    expect(rig.host.clientCount).toBe(0);

    // The stock client keeps the token the host remembers the kick by, so pressing Join again
    // in the same tab is refused (and refused again: the reject does not clear it either).
    expect(a.tokens.load(ROOM)).toBe(token);
    for (let attempt = 0; attempt < 2; attempt++) {
      a.session.connect(ROOM, 'Kickme', rig.now + a.clockOffsetMs);
      rig.runUntil(() => a.session.status !== 'connecting');
      expect(a.session.status).toBe('rejected');
      expect(a.session.error).toEqual({ kind: 'rejected', reason: 'kicked' });
      expect(a.tokens.load(ROOM)).toBe(token);
      rig.run(400);
    }

    // A new tab of the same browser has no token (tokens are per tab) but the same client id.
    const tab = rig.join('Kickme', { clientId: BROWSER });
    expect(tab.session.status).toBe('rejected');
    expect(tab.session.error).toEqual({ kind: 'rejected', reason: 'kicked' });
    expect(rig.host.lobby.players).toHaveLength(1);

    // Everyone else still gets in.
    const friend = rig.join('Friend', { clientId: 'fedcba9876543210fedcba9876543210' });
    expect(friend.session.status).toBe('connected');
    rig.dispose();
  });

  it('rejects with `matchInProgress` once a running match has no spectator slot left', () => {
    const rig = createRoom(1);
    startMatch(rig);
    expect(rig.host.lobby.phase).toBe('inMatch');
    // Late joiners watch...
    for (let i = 0; i < MAX_SPECTATORS; i++) {
      const watcher = rig.join(`Watcher ${i}`);
      expect(watcher.session.status).toBe('connected');
      expect(playerOf(rig.host.lobby, watcher.session.localPlayerId).side).toBe('spectator');
      rig.run(50);
      expect(watcher.session.inMatch).toBe(true);
      expect(watcher.session.isRider).toBe(false);
    }
    // ...until the watcher seats run out.
    const late = rig.join('Too late');
    expect(late.session.status).toBe('rejected');
    expect(late.session.error).toEqual({ kind: 'rejected', reason: 'matchInProgress' });
    rig.dispose();
  });

  it('drops a link that never says hello, and ignores anything sent before the handshake', () => {
    const rig = new Rig().open();
    const raw = rawClient(rig);
    const writer = new Writer(CTRL_MAX_BYTES);
    const intent = createIntentMessage();
    intent.intent = { type: 'host.start' };
    raw.send(writer.packet(encodeIntent(writer, intent)));
    rig.run(100);
    expect(raw.received).toHaveLength(0);
    expect(rig.host.counters.malformed).toBe(1);
    expect(raw.closed()).toBe(false);
    rig.run(5100);
    expect(raw.closed()).toBe(true);
    expect(rig.host.counters.helloTimeouts).toBe(1);
    rig.dispose();
  });

  it('answers a valid raw hello with WELCOME carrying id, token and the lobby', () => {
    const rig = new Rig().open();
    const raw = rawClient(rig);
    const writer = new Writer(CTRL_MAX_BYTES);
    const hello = createHelloMessage();
    hello.protocolVersion = PROTOCOL_VERSION;
    hello.name = 'Raw';
    raw.send(writer.packet(encodeHello(writer, hello)));
    // A second hello on the same link changes nothing.
    raw.send(writer.packet(encodeHello(writer, hello)));
    rig.run(100);
    expect(raw.received[0]?.type).toBe(MSG_WELCOME);
    expect(raw.received.filter((m) => m.type === MSG_WELCOME)).toHaveLength(1);
    expect(raw.received.some((m) => m.type === MSG_LOBBY_STATE)).toBe(true);
    const welcome = createWelcomeMessage();
    const bytes = raw.received[0]?.bytes ?? new Uint8Array();
    expect(decodeWelcome(new Reader().reset(new DataView(bytes.buffer)), welcome)).toBe(true);
    expect(welcome.playerId).toBe(1);
    expect(welcome.reconnectToken).toMatch(/^[0-9a-f]{32}$/);
    expect(welcome.lobbyState?.players).toHaveLength(2);
    expect(rig.host.lobby.players).toHaveLength(2);
    rig.dispose();
  });
});

describe('leaving', () => {
  it('a client that leaves frees its seat at once', () => {
    const rig = createRoom(2);
    const [a, b] = rig.clients;
    if (a === undefined || b === undefined) throw new Error('no clients');
    const id = a.session.localPlayerId;
    a.session.sendIntent({ type: 'lobby.leave' });
    expect(a.session.status).toBe('left');
    expect(a.tokens.load(ROOM)).toBe('');
    rig.run(100);
    expect(rig.host.lobby.players.some((p) => p.id === id)).toBe(false);
    expect(b.session.lobby?.players.some((p) => p.id === id)).toBe(false);
    expect(rig.host.clientCount).toBe(1);
    rig.dispose();
  });

  it('the host leaving tells every client hostLeft', () => {
    const rig = createRoom(3);
    startMatch(rig);
    rig.host.applyIntent({ type: 'lobby.leave' });
    expect(rig.host.state).toBe('closed');
    rig.run(100);
    for (const client of rig.clients) {
      expect(client.session.status).toBe('hostLeft');
      expect(client.session.error).toEqual({ kind: 'hostLeft' });
      expect(client.session.inMatch).toBe(false);
      expect(client.tokens.load(ROOM)).toBe('');
    }
    // Nothing tries to come back.
    rig.run(5000);
    for (const client of rig.clients) expect(client.session.status).toBe('hostLeft');
  });

  it('a host that vanishes without a goodbye is recognised by the room code being gone', () => {
    const rig = createRoom(1);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    // No HOST_LEFT: the transport just goes away (a crashed tab).
    rig.hostTransport.dispose();
    rig.run(100);
    expect(a.session.status).toBe('reconnecting');
    rig.runUntil(() => a.session.status !== 'reconnecting', 20_000);
    expect(a.session.status).toBe('hostLeft');
  });
});

/** A `random()` that plays back fixed values, then keeps returning the last one. */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
