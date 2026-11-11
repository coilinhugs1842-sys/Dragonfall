/**
 * Disconnects and reconnects: the seat is held for 30 s (the dragon stays in the match and is
 * kept inside the arena), the token brings the same player back mid-lobby and mid-match, and
 * both sides give up cleanly when nobody returns.
 */

import { describe, expect, it } from 'vitest';
import { Writer, encodeHello, encodePing } from '../../src/net/codec';
import { CTRL_MAX_BYTES, createHelloMessage, createPingMessage } from '../../src/net/protocol';
import {
  CLIENT_LINK_TIMEOUT_MS,
  ClientSession,
  HOST_MAX_PINGS_PER_S,
  createMemoryTokenStore,
} from '../../src/net/session';
import { NOOP_CLIENT_HANDLERS, transportError } from '../../src/net/transport';
import type {
  Channel,
  ClientTransport,
  ClientTransportHandlers,
  TransportErrorReason,
  TransportPayload,
  TransportState,
} from '../../src/net/transport';
import { DRAGON_FLAG_ALIVE, PROTOCOL_VERSION, RECONNECT_GRACE_MS, TICK_HZ } from '../../src/shared';
import type { LobbyPlayer } from '../../src/shared';
import { ROOM, Rig, createRoom, startMatch } from './session-harness';
import type { RigClient } from './session-harness';

function seatOf(rig: Rig, id: number): LobbyPlayer | undefined {
  return rig.host.lobby.players.find((p) => p.id === id);
}

/** Cuts the client's link underneath both ends, as when Wi-Fi drops. Links are 1-based, in join order. */
function sever(rig: Rig, client: RigClient): void {
  rig.hostTransport.sever(rig.clients.indexOf(client) + 1);
  rig.run(3);
}

/** A client transport whose connect attempts can be made to fail (no route to the host). */
class BlockableTransport implements ClientTransport {
  blocked = false;
  /** What a blocked connect attempt reports. */
  blockReason: TransportErrorReason = 'peerUnavailable';
  /** Nothing the host sends arrives, and the link does not close: a host that just vanished. */
  deaf = false;
  attempts = 0;
  private handlers: ClientTransportHandlers | null = null;

  constructor(private readonly inner: ClientTransport) {}

  get state(): TransportState {
    return this.inner.state;
  }

  setHandlers(handlers: ClientTransportHandlers): void {
    this.handlers = handlers;
    this.inner.setHandlers({
      onOpen: () => handlers.onOpen(),
      onClose: (reason) => {
        if (!this.deaf) handlers.onClose(reason);
      },
      onError: (error) => handlers.onError(error),
      onMessage: (channel, data) => {
        if (!this.deaf) handlers.onMessage(channel, data);
      },
    });
  }

  connect(roomCode: string): void {
    this.attempts++;
    if (this.blocked) {
      this.handlers?.onError(transportError(this.blockReason, 'blocked by the test'));
      return;
    }
    this.inner.connect(roomCode);
  }

  send(channel: Channel, data: TransportPayload): boolean {
    return this.inner.send(channel, data);
  }

  close(): void {
    this.inner.close();
  }

  dispose(): void {
    this.inner.dispose();
  }
}

describe('reconnecting', () => {
  it('in the lobby: a dropped player comes back to the same seat by token', () => {
    const rig = createRoom(3);
    const [a, b] = rig.clients;
    if (a === undefined || b === undefined) throw new Error('no clients');
    a.session.sendIntent({ type: 'lobby.pickClass', classId: 'wraith' });
    a.session.sendIntent({ type: 'lobby.ready', ready: true });
    rig.run(200);
    const id = a.session.localPlayerId;
    const before = seatOf(rig, id);

    sever(rig, a);
    expect(a.session.status).toBe('reconnecting');
    expect(a.session.localPlayerId).toBe(id);
    rig.run(100);
    expect(seatOf(rig, id)?.connected).toBe(false);
    expect(seatOf(rig, id)?.ready).toBe(false);
    expect(b.session.lobby?.players.find((p) => p.id === id)?.connected).toBe(false);
    expect(rig.host.startBlocker()).toBe('playerReconnecting');

    rig.runUntil(() => a.session.status === 'connected', 10_000);
    rig.run(100);
    expect(a.session.localPlayerId).toBe(id);
    expect(a.session.counters.reconnects).toBe(1);
    const after = seatOf(rig, id);
    expect(after?.connected).toBe(true);
    expect(after?.side).toBe(before?.side);
    expect(after?.perch).toBe(before?.perch);
    expect(after?.classId).toBe('wraith');
    expect(after?.name).toBe(before?.name);
    expect(rig.host.lobby.players).toHaveLength(4);
    expect(a.session.lobby).toEqual(rig.host.lobby);
    rig.dispose();
  });

  it('mid-match: the dragon is kept flying, and the same player takes it back', () => {
    const rig = createRoom(3);
    startMatch(rig);
    rig.runTicks(60);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    const id = a.session.localPlayerId;
    const team = seatOf(rig, id)?.side;
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');

    sever(rig, a);
    expect(a.session.status).toBe('reconnecting');
    expect(a.session.inMatch).toBe(true);
    // No inputs are sent into the void.
    const sentBefore = a.session.counters.inputsSent;

    // Keep the client away for 20 s (its own retries are blocked by freezing it).
    a.running = false;
    rig.run(20_000);
    expect(a.session.counters.inputsSent).toBe(sentBefore);
    expect(seatOf(rig, id)?.connected).toBe(false);
    expect(seatOf(rig, id)?.side).toBe(team);
    // The dragon is still in the match, alive, and circling inside the arena instead of having
    // flown 900 m in a straight line into the storm.
    const held = sim.getDragon(id);
    expect(held).toBeDefined();
    expect((held?.flags ?? 0) & DRAGON_FLAG_ALIVE).toBe(DRAGON_FLAG_ALIVE);
    const world = rig.host.matchWorld;
    expect(Math.hypot(held?.position.x ?? 0, held?.position.z ?? 0)).toBeLessThan(
      (world?.radius ?? 0) * 0.8,
    );
    // Everyone else still sees it.
    const [, b] = rig.clients;
    expect(b?.view.dragonCount).toBe(4);

    // Back within the 30 s grace.
    a.running = true;
    rig.runUntil(() => a.session.status === 'connected', 10_000);
    expect(a.session.localPlayerId).toBe(id);
    rig.run(1500);
    expect(seatOf(rig, id)?.connected).toBe(true);
    expect(seatOf(rig, id)?.side).toBe(team);
    expect(a.session.inMatch).toBe(true);
    expect(a.session.isRider).toBe(true);
    expect(a.session.matchPhase).toBe('playing');
    expect(a.session.predictor.active).toBe(true);
    expect(a.view.dragonCount).toBe(4);

    // Prediction is exact again: the host applies this client's inputs, not the holding pattern.
    let worst = 0;
    const predicted = new Map<number, number>();
    rig.onClientTick = (client, _index, tick) => {
      if (client === a) predicted.set(tick, client.session.predictor.dragon.position.x);
    };
    const emptyBefore = rig.host.inputBufferOf(id)?.emptyCount ?? 0;
    rig.onHostTick = (tick) => {
      const mine = predicted.get(tick);
      const dragon = sim.getDragon(id);
      if (mine !== undefined && dragon !== undefined) {
        worst = Math.max(worst, Math.abs(mine - dragon.position.x));
      }
    };
    rig.runTicks(90);
    expect(predicted.size).toBeGreaterThan(60);
    expect(worst).toBeLessThan(0.001);
    expect(rig.host.inputBufferOf(id)?.emptyCount).toBe(emptyBefore);
    rig.dispose();
  });

  it('a reloaded page (new session, stored token) gets its seat and dragon back', () => {
    const rig = createRoom(3);
    startMatch(rig);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    const id = a.session.localPlayerId;
    const tokens = a.tokens;
    // The tab goes away: the transport is released without a goodbye message.
    a.running = false;
    a.session.dispose();
    rig.run(200);
    expect(seatOf(rig, id)?.connected).toBe(false);

    const again = rig.join('Rider 1', { tokenStore: tokens });
    expect(again.session.status).toBe('connected');
    expect(again.session.localPlayerId).toBe(id);
    rig.run(1500);
    expect(again.session.inMatch).toBe(true);
    expect(again.session.isRider).toBe(true);
    expect(again.session.predictor.active).toBe(true);
    expect(rig.host.lobby.players).toHaveLength(4);
    rig.dispose();
  });

  it('a second tab with a copied token does not steal a live seat', () => {
    const rig = createRoom(1);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    rig.run(500);
    const copied = createMemoryTokenStore();
    copied.save(ROOM, a.tokens.load(ROOM));
    const twin = rig.join('Twin', { tokenStore: copied });
    expect(twin.session.status).toBe('connected');
    expect(twin.session.localPlayerId).not.toBe(a.session.localPlayerId);
    expect(a.session.status).toBe('connected');
    expect(rig.host.lobby.players).toHaveLength(3);
    // The twin was given a token of its own.
    expect(copied.load(ROOM)).not.toBe(a.tokens.load(ROOM));
    rig.dispose();
  });

  it('takes over a seat whose old link has gone silent without the host noticing yet', () => {
    const rig = createRoom(1);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    const id = a.session.localPlayerId;
    // The old tab hangs: no pings, but its link is still up as far as the host can tell.
    a.running = false;
    rig.run(2000);
    expect(seatOf(rig, id)?.connected).toBe(true);
    const again = rig.join('Rider 1', { tokenStore: a.tokens });
    expect(again.session.status).toBe('connected');
    expect(again.session.localPlayerId).toBe(id);
    expect(rig.host.lobby.players).toHaveLength(2);
    expect(rig.host.clientCount).toBe(1);
    rig.dispose();
  });
});

describe('giving up', () => {
  it('the host frees a held seat after 30 s and removes the dragon', () => {
    const rig = createRoom(3);
    startMatch(rig);
    const [a, b] = rig.clients;
    if (a === undefined || b === undefined) throw new Error('no clients');
    const id = a.session.localPlayerId;
    a.running = false;
    a.session.dispose();
    rig.run(100);
    const droppedAt = rig.host.hostTick;
    expect(seatOf(rig, id)?.connected).toBe(false);
    expect(seatOf(rig, id)?.reconnectDeadlineTick).toBeGreaterThan(droppedAt + 29 * TICK_HZ);

    rig.run(RECONNECT_GRACE_MS - 1500);
    expect(seatOf(rig, id)).toBeDefined();
    expect(rig.host.sim?.getDragon(id)).toBeDefined();

    rig.run(2500);
    expect(seatOf(rig, id)).toBeUndefined();
    expect(rig.host.sim?.getDragon(id)).toBeUndefined();
    expect(rig.host.sim?.current.dragonCount).toBe(3);
    expect(b.session.lobby?.players.some((p) => p.id === id)).toBe(false);
    rig.run(500);
    expect(b.view.dragonCount).toBe(3);

    // Too late: the token no longer names a seat, and a running match only has watcher seats.
    const late = rig.join('Rider 1', { tokenStore: a.tokens });
    expect(late.session.status).toBe('connected');
    expect(late.session.localPlayerId).toBe(id); // lowest free id, but a new seat:
    expect(seatOf(rig, late.session.localPlayerId)?.side).toBe('spectator');
    rig.dispose();
  });

  it('the client retries for its grace period and then reports the connection lost', () => {
    const rig = new Rig().open();
    const blockable = new BlockableTransport(rig.hub.createClient());
    const session = new ClientSession({
      transport: blockable,
      reconnectWindowMs: 12_000,
      recycledBuffers: true,
    });
    session.connect(ROOM, 'Flaky', rig.now);
    const drive = (ms: number): void => {
      const end = rig.now + ms;
      while (rig.now < end) {
        rig.run(1);
        session.update(rig.now);
      }
    };
    drive(200);
    expect(session.status).toBe('connected');
    const id = session.localPlayerId;

    blockable.blocked = true;
    rig.hostTransport.sever(1);
    drive(50);
    expect(session.status).toBe('reconnecting');
    const attemptsBefore = blockable.attempts;
    drive(11_000);
    expect(session.status).toBe('reconnecting');
    // First attempt after the delay, then one every retry interval.
    expect(blockable.attempts - attemptsBefore).toBeGreaterThanOrEqual(5);
    expect(blockable.attempts - attemptsBefore).toBeLessThanOrEqual(8);
    drive(1500);
    expect(session.status).toBe('disconnected');
    expect(session.error).toEqual({ kind: 'connectionLost' });
    const attemptsAfter = blockable.attempts;
    drive(5000);
    expect(blockable.attempts).toBe(attemptsAfter);
    // The host is still holding the seat for the rest of its own 30 s.
    expect(seatOf(rig, id)?.connected).toBe(false);
    rig.dispose();
  });

  it('the host closes a link that has gone silent, and the client finds its way back', () => {
    const rig = createRoom(1);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    const id = a.session.localPlayerId;
    a.running = false;
    rig.run(5500);
    expect(seatOf(rig, id)?.connected).toBe(true);
    rig.run(1000);
    expect(rig.host.counters.linkTimeouts).toBe(1);
    expect(seatOf(rig, id)?.connected).toBe(false);
    expect(rig.host.clientCount).toBe(0);

    // The close reached the client while it hung; once it runs again it reconnects by itself.
    expect(a.session.status).toBe('reconnecting');
    a.running = true;
    rig.runUntil(() => a.session.status === 'connected', 10_000);
    expect(a.session.counters.reconnects).toBe(1);
    expect(a.session.localPlayerId).toBe(id);
    expect(seatOf(rig, id)?.connected).toBe(true);
    rig.dispose();
  });

  it('a host that was not running for a while does not take its own gap for silence', () => {
    const rig = createRoom(2);
    const ids = rig.clients.map((client) => client.session.localPlayerId);
    // The host page is hidden for 12 s: no `update`, no ticks. Messages still arrive (the
    // clients keep pinging) and are stamped with the time of the host's last `update`.
    for (let ms = 0; ms < 12_000; ms++) {
      rig.now += 1;
      rig.hub.pump();
      if (ms % 16 === 0) {
        for (const client of rig.clients) {
          client.session.advance(rig.now + client.clockOffsetMs, client.pilot);
        }
      }
    }
    rig.run(500);
    expect(rig.host.counters.linkTimeouts).toBe(0);
    expect(rig.host.clientCount).toBe(2);
    for (const id of ids) expect(seatOf(rig, id)?.connected).toBe(true);
    for (const client of rig.clients) {
      expect(client.session.status).toBe('connected');
      expect(client.session.counters.reconnects).toBe(0);
    }
    // A link that really is silent is still closed, counted from the host's return.
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    a.running = false;
    rig.run(6500);
    expect(rig.host.counters.linkTimeouts).toBe(1);
    rig.dispose();
  });

  it('a hidden main-thread host keeps answering pings for as long as it is hidden', () => {
    // `now`: the host stamps arrivals with the real time, as the page does.
    const rig: Rig = new Rig({ host: { now: () => rig.now } }).open();
    const a = rig.join('Rider 1');
    rig.run(500);
    const id = a.session.localPlayerId;

    // A minute hidden: no `update`, no ticks, only transport callbacks. The ping budget used to
    // be refilled by `update` alone, so the 21st ping was the last one answered and the client
    // dropped the link and reconnected every 16 s.
    rig.hostRunning = false;
    rig.run(60_000);
    expect(rig.host.counters.pingsDropped).toBe(0);
    expect(a.session.status).toBe('connected');
    expect(a.session.counters.linkTimeouts).toBe(0);
    expect(a.session.counters.reconnects).toBe(0);

    rig.hostRunning = true;
    rig.run(1000);
    expect(rig.host.counters.linkTimeouts).toBe(0);
    expect(seatOf(rig, id)?.connected).toBe(true);
    expect(a.session.counters.reconnects).toBe(0);
    rig.dispose();
  });

  it('a hidden client tab keeps its seat: the background beat keeps the pings going', () => {
    const rig = createRoom(2);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    const id = a.session.localPlayerId;
    a.session.sendIntent({ type: 'lobby.ready', ready: true });
    rig.run(300);

    // Hidden for 20 s: no frames, `update` about once a second.
    a.running = false;
    a.backgroundMs = 1000;
    rig.run(20_000);
    expect(rig.host.counters.linkTimeouts).toBe(0);
    expect(seatOf(rig, id)?.connected).toBe(true);
    expect(seatOf(rig, id)?.ready).toBe(true);
    expect(rig.host.startBlocker()).not.toBe('playerReconnecting');
    expect(a.session.status).toBe('connected');
    expect(a.session.counters.reconnects).toBe(0);

    // A host that really went away is still noticed from the background.
    rig.hostRunning = false;
    rig.hostTransport.sever(1);
    rig.run(1500);
    expect(a.session.status).toBe('reconnecting');
    rig.hostRunning = true;
    rig.runUntil(() => a.session.status === 'connected', 10_000);
    expect(a.session.localPlayerId).toBe(id);
    expect(a.running).toBe(false);
    rig.dispose();
  });

  it('a tab frozen past the reconnect window still tries once the page runs again', () => {
    const rig = createRoom(1);
    const [a] = rig.clients;
    if (a === undefined) throw new Error('no client');
    const id = a.session.localPlayerId;
    rig.run(300);
    // Frozen outright (no timers either) for 31.5 s. The host drops the link after 6 s and
    // holds the seat until 36 s; the close reaches the client stamped with the time it froze.
    a.running = false;
    rig.run(31_500);
    expect(seatOf(rig, id)?.connected).toBe(false);
    expect(a.session.status).toBe('reconnecting');

    // Its 30 s window must not have run out while it could not act.
    a.running = true;
    rig.run(50);
    expect(a.session.status).not.toBe('disconnected');
    rig.runUntil(() => a.session.status === 'connected', 5000);
    expect(a.session.localPlayerId).toBe(id);
    expect(a.session.counters.reconnects).toBe(1);
    expect(seatOf(rig, id)?.connected).toBe(true);
    expect(rig.host.lobby.players).toHaveLength(2);
    rig.dispose();
  });

  it('answers at most HOST_MAX_PINGS_PER_S pings per link per second', () => {
    const rig: Rig = new Rig({ host: { now: () => rig.now } }).open();
    const raw = rig.hub.createClient();
    raw.setHandlers(NOOP_CLIENT_HANDLERS);
    raw.connect(ROOM);
    rig.run(5);
    const writer = new Writer(CTRL_MAX_BYTES);
    const hello = createHelloMessage();
    hello.protocolVersion = PROTOCOL_VERSION;
    hello.name = 'Flood';
    raw.send('ctrl', writer.packet(encodeHello(writer, hello)));
    rig.run(20);
    expect(rig.host.clientCount).toBe(1);

    const ping = createPingMessage();
    const flood = (count: number): void => {
      for (let i = 0; i < count; i++) {
        ping.clientTimeMs = rig.now + i;
        raw.send('ctrl', writer.packet(encodePing(writer, ping)));
      }
      rig.run(5);
    };
    flood(HOST_MAX_PINGS_PER_S + 15);
    expect(rig.host.counters.pingsDropped).toBe(15);
    // Still inside the same second: all dropped. A second later the budget is back.
    flood(5);
    expect(rig.host.counters.pingsDropped).toBe(20);
    rig.run(1000);
    flood(HOST_MAX_PINGS_PER_S);
    expect(rig.host.counters.pingsDropped).toBe(20);
    rig.dispose();
  });

  it('drops a link the host went silent on, and reports the host gone when the room is too', () => {
    const rig = new Rig().open();
    const blockable = new BlockableTransport(rig.hub.createClient());
    const session = new ClientSession({ transport: blockable, recycledBuffers: true });
    session.connect(ROOM, 'Lonely', rig.now);
    const drive = (ms: number): void => {
      const end = rig.now + ms;
      while (rig.now < end) {
        rig.run(1);
        session.update(rig.now);
      }
    };
    drive(300);
    expect(session.status).toBe('connected');

    // The host's page dies: no HOST_LEFT, no close event, and its room code is gone.
    blockable.deaf = true;
    blockable.blocked = true;
    blockable.blockReason = 'roomNotFound';
    drive(CLIENT_LINK_TIMEOUT_MS - 500);
    expect(session.status).toBe('connected');
    drive(1000);
    expect(session.status).toBe('reconnecting');
    expect(session.counters.linkTimeouts).toBe(1);
    // First attempt after the reconnect delay, then two retries: three "no such room" answers.
    drive(6000);
    expect(session.status).toBe('hostLeft');
    expect(session.error).toEqual({ kind: 'hostLeft' });
    rig.dispose();
  });

  it('a client that was not running for a while does not take its own gap for silence', () => {
    const rig = new Rig().open();
    const session = new ClientSession({
      transport: rig.hub.createClient(),
      linkTimeoutMs: 2000,
      recycledBuffers: true,
    });
    session.connect(ROOM, 'Sleepy', rig.now);
    for (let i = 0; i < 300; i++) {
      rig.run(1);
      session.update(rig.now);
    }
    expect(session.status).toBe('connected');
    // The page hangs for 3 s (longer than its own timeout, shorter than the host's).
    rig.run(3000);
    session.update(rig.now);
    expect(session.status).toBe('connected');
    expect(session.counters.linkTimeouts).toBe(0);
    for (let i = 0; i < 2500; i++) {
      rig.run(1);
      session.update(rig.now);
    }
    expect(session.status).toBe('connected');
    expect(session.counters.linkTimeouts).toBe(0);
    rig.dispose();
  });

  it('reports a failed join when the host never answers the hello', () => {
    const rig = new Rig({ host: { helloTimeoutMs: 60_000 } }).open();
    // A host that accepts the link but ignores the handshake: drop every ctrl message to it.
    const client = rig.addClient({ handshakeTimeoutMs: 3000 });
    rig.hostTransport.setHandlers({
      onOpen: () => {},
      onError: () => {},
      onPeerConnected: () => {},
      onPeerDisconnected: () => {},
      onMessage: () => {},
    });
    client.session.connect(ROOM, 'Nobody home', rig.now + client.clockOffsetMs);
    rig.run(2500);
    expect(client.session.status).toBe('connecting');
    rig.run(1000);
    expect(client.session.status).toBe('failed');
    expect(client.session.error).toEqual({ kind: 'connectFailed', reason: 'timeout' });
  });
});
