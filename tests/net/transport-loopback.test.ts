import { describe, expect, it } from 'vitest';
import {
  NOOP_CLIENT_HANDLERS,
  NOOP_HOST_HANDLERS,
  createLoopbackHub,
} from '../../src/net/transport';
import type {
  ClientTransport,
  HostTransport,
  LoopbackClientTransport,
  LoopbackHostTransport,
  LoopbackHub,
  LoopbackOptions,
  TransportMessage,
} from '../../src/net/transport';

const ROOM = 'ABCDE';

/** Renders a received message as text so logs are easy to compare. */
function show(data: TransportMessage): string {
  return typeof data === 'string' ? `"${data}"` : `[${[...new Uint8Array(data)].join(',')}]`;
}

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

/** Records every host event as one line. */
function hostLog(host: HostTransport): string[] {
  const log: string[] = [];
  host.setHandlers({
    onOpen: (code) => log.push(`open ${code}`),
    onError: (error) => log.push(`error ${error.reason} fatal=${error.fatal}`),
    onPeerConnected: (link) => log.push(`+${link}`),
    onPeerDisconnected: (link, reason) => log.push(`-${link} ${reason}`),
    onMessage: (link, channel, data) => log.push(`${link} ${channel} ${show(data)}`),
  });
  return log;
}

function clientLog(client: ClientTransport): string[] {
  const log: string[] = [];
  client.setHandlers({
    onOpen: () => log.push('open'),
    onClose: (reason) => log.push(`close ${reason}`),
    onError: (error) => log.push(`error ${error.reason} fatal=${error.fatal}`),
    onMessage: (channel, data) => log.push(`${channel} ${show(data)}`),
  });
  return log;
}

interface Rig {
  hub: LoopbackHub;
  host: LoopbackHostTransport;
  hostEvents: string[];
  clients: LoopbackClientTransport[];
  clientEvents: string[][];
}

/** An open room with `count` connected clients and empty logs. Links are 1..count. */
function rig(count: number, options?: LoopbackOptions): Rig {
  const hub = createLoopbackHub(options);
  const host = hub.createHost();
  const hostEvents = hostLog(host);
  host.open(ROOM);
  const clients: LoopbackClientTransport[] = [];
  const clientEvents: string[][] = [];
  for (let i = 0; i < count; i++) {
    const client = hub.createClient();
    clientEvents.push(clientLog(client));
    client.connect(ROOM);
    clients.push(client);
  }
  hub.flush();
  hostEvents.length = 0;
  for (const events of clientEvents) events.length = 0;
  return { hub, host, hostEvents, clients, clientEvents };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at index ${index}`);
  return item;
}

describe('loopback: opening and connecting', () => {
  it('does nothing until pumped, then opens the room', () => {
    const hub = createLoopbackHub();
    const host = hub.createHost();
    const events = hostLog(host);
    expect(host.state).toBe('idle');
    expect(host.roomCode).toBe('');
    host.open(ROOM);
    expect(host.state).toBe('opening');
    expect(host.roomCode).toBe(ROOM);
    expect(events).toEqual([]);
    expect(hub.pending).toBe(1);
    expect(hub.pump()).toBe(1);
    expect(host.state).toBe('open');
    expect(events).toEqual([`open ${ROOM}`]);
    expect(hub.pump()).toBe(0);
  });

  it('connects N clients with ascending link ids, in connect order', () => {
    const hub = createLoopbackHub();
    const host = hub.createHost();
    const events = hostLog(host);
    host.open(ROOM);
    const logs: string[][] = [];
    const clients: ClientTransport[] = [];
    for (let i = 0; i < 9; i++) {
      const client = hub.createClient();
      logs.push(clientLog(client));
      client.connect(ROOM);
      expect(client.state).toBe('opening');
      clients.push(client);
    }
    hub.pump();
    expect(events).toEqual([`open ${ROOM}`, '+1', '+2', '+3', '+4', '+5', '+6', '+7', '+8', '+9']);
    expect(host.linkCount).toBe(9);
    for (const log of logs) expect(log).toEqual(['open']);
    for (const client of clients) expect(client.state).toBe('open');
  });

  it('reports roomNotFound for an unknown room, and for a host that is not open yet', () => {
    const hub = createLoopbackHub();
    const early = hub.createClient();
    const earlyEvents = clientLog(early);
    early.connect(ROOM); // queued before the host opens
    const host = hub.createHost();
    host.open(ROOM);
    const wrong = hub.createClient();
    const wrongEvents = clientLog(wrong);
    wrong.connect('ZZZZZ');
    hub.flush();
    expect(earlyEvents).toEqual(['error roomNotFound fatal=true']);
    expect(wrongEvents).toEqual(['error roomNotFound fatal=true']);
    expect(early.state).toBe('closed');
    expect(early.send('ctrl', 'x')).toBe(false);
    // A failed client may try again.
    early.connect(ROOM);
    hub.flush();
    expect(earlyEvents).toEqual(['error roomNotFound fatal=true', 'open']);
  });

  it('reports idTaken to a second host on the same code, and lets it retry elsewhere', () => {
    const hub = createLoopbackHub();
    const first = hub.createHost();
    const second = hub.createHost();
    const secondEvents = hostLog(second);
    first.open(ROOM);
    second.open(ROOM);
    hub.flush();
    expect(first.state).toBe('open');
    expect(second.state).toBe('closed');
    expect(secondEvents).toEqual(['error idTaken fatal=true']);
    second.open('FGHJK');
    hub.flush();
    expect(secondEvents).toEqual(['error idTaken fatal=true', 'open FGHJK']);
  });

  it('rejects malformed room codes on both sides', () => {
    const hub = createLoopbackHub();
    const host = hub.createHost();
    const hostEvents = hostLog(host);
    host.open('abc');
    const client = hub.createClient();
    const events = clientLog(client);
    client.connect('ABCD0');
    hub.flush();
    expect(hostEvents).toEqual(['error invalidRoomCode fatal=true']);
    expect(events).toEqual(['error invalidRoomCode fatal=true']);
  });

  it('frees the room code when the host is disposed', () => {
    const { hub, host } = rig(0);
    host.dispose();
    const next = hub.createHost();
    const events = hostLog(next);
    next.open(ROOM);
    hub.flush();
    expect(events).toEqual([`open ${ROOM}`]);
  });

  it('ignores open/connect while already opening or open', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(1);
    host.open('FGHJK');
    at(clients, 0).connect(ROOM);
    hub.flush();
    expect(host.roomCode).toBe(ROOM);
    expect(hostEvents).toEqual([]);
    expect(at(clientEvents, 0)).toEqual([]);
    expect(host.linkCount).toBe(1);
  });
});

describe('loopback: delivery and ordering', () => {
  it('delivers both channels in send order, binary and strings, both directions', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(2);
    const [a, b] = [at(clients, 0), at(clients, 1)];
    expect(a.send('ctrl', '{"hello":1}')).toBe(true);
    expect(b.send('fast', bytes(1, 2, 3))).toBe(true);
    expect(a.send('fast', bytes(4))).toBe(true);
    expect(a.send('ctrl', bytes(5, 6).buffer)).toBe(true);
    expect(host.send(2, 'ctrl', 'welcome')).toBe(true);
    expect(host.send(1, 'fast', bytes(9, 9))).toBe(true);
    expect(host.send(1, 'ctrl', '')).toBe(true);
    expect(hostEvents).toEqual([]);
    expect(hub.pending).toBe(7);
    expect(hub.pump()).toBe(7);
    expect(hostEvents).toEqual([
      '1 ctrl "{"hello":1}"',
      '2 fast [1,2,3]',
      '1 fast [4]',
      '1 ctrl [5,6]',
    ]);
    expect(at(clientEvents, 0)).toEqual(['fast [9,9]', 'ctrl ""']);
    expect(at(clientEvents, 1)).toEqual(['ctrl "welcome"']);
  });

  it('delivers what handlers send during a pump only on the next pump', () => {
    const { hub, host, clients } = rig(1);
    const client = at(clients, 0);
    let hostGot = 0;
    let clientGot = 0;
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onMessage: (link) => {
        hostGot++;
        host.send(link, 'ctrl', 'pong');
      },
    });
    client.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onMessage: () => {
        clientGot++;
        client.send('ctrl', 'ping');
        expect(hub.pump()).toBe(0); // re-entrant pump is a no-op
      },
    });
    client.send('ctrl', 'ping');
    expect(hub.pump()).toBe(1);
    expect([hostGot, clientGot]).toEqual([1, 0]);
    expect(hub.pump()).toBe(1);
    expect([hostGot, clientGot]).toEqual([1, 1]);
    // An endless ping-pong cannot hang flush().
    expect(hub.flush(10)).toBe(10);
    expect(hub.pending).toBe(1);
  });

  it('is deterministic: the same script gives the same event log', () => {
    const run = (): string[] => {
      const { hub, host, hostEvents, clients, clientEvents } = rig(3);
      for (let tick = 0; tick < 5; tick++) {
        clients.forEach((client, index) => client.send('fast', bytes(tick, index)));
        for (let link = 1; link <= 3; link++) host.send(link, 'fast', bytes(100 + tick, link));
        if (tick === 2) at(clients, 1).close();
        hub.pump();
      }
      return [...hostEvents, '|', ...clientEvents.flat()];
    };
    const first = run();
    expect(first.length).toBeGreaterThan(20);
    expect(run()).toEqual(first);
  });

  it('returns false and queues nothing when the link is not open', () => {
    const hub = createLoopbackHub();
    const host = hub.createHost();
    const client = hub.createClient();
    expect(client.send('ctrl', 'x')).toBe(false);
    expect(host.send(1, 'ctrl', 'x')).toBe(false);
    host.open(ROOM);
    client.connect(ROOM);
    expect(client.send('ctrl', 'x')).toBe(false); // still opening
    expect(hub.pending).toBe(2);
    hub.flush();
    expect(host.send(7, 'ctrl', 'x')).toBe(false); // unknown link
    expect(hub.pending).toBe(0);
  });

  it('keeps the rest of the queue when a handler throws', () => {
    const { hub, host, clients } = rig(1);
    const client = at(clients, 0);
    const got: string[] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onMessage: (_link, _channel, data) => {
        if (data === 'bad') throw new Error('boom');
        got.push(String(data));
      },
    });
    client.send('ctrl', 'one');
    client.send('ctrl', 'bad');
    client.send('ctrl', 'two');
    expect(() => hub.pump()).toThrow('boom');
    expect(got).toEqual(['one']);
    expect(hub.pending).toBe(1);
    client.send('ctrl', 'three');
    hub.pump();
    expect(got).toEqual(['one', 'two', 'three']);
  });

  it('drops fast messages the filter rejects, and never touches ctrl', () => {
    const seen: string[] = [];
    const { hub, host, hostEvents, clients, clientEvents } = rig(1, {
      fastFilter: (toHost, link, byteLength) => {
        seen.push(`${toHost ? 'up' : 'down'} ${link} ${byteLength}`);
        return byteLength !== 2;
      },
    });
    const client = at(clients, 0);
    expect(client.send('fast', bytes(1))).toBe(true);
    expect(client.send('fast', bytes(1, 2))).toBe(true); // lost, but the sender cannot tell
    expect(client.send('ctrl', bytes(1, 2))).toBe(true);
    expect(host.send(1, 'fast', bytes(7, 7))).toBe(true);
    expect(host.send(1, 'fast', bytes(7, 7, 7))).toBe(true);
    hub.pump();
    expect(seen).toEqual(['up 1 1', 'up 1 2', 'down 1 2', 'down 1 3']);
    expect(hostEvents).toEqual(['1 fast [1]', '1 ctrl [1,2]']);
    expect(at(clientEvents, 0)).toEqual(['fast [7,7,7]']);
  });
});

describe('loopback: copy semantics', () => {
  it('copies on send, so the sender can reuse its buffer straight away', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(1);
    const client = at(clients, 0);
    const scratch = new Uint8Array(4);
    for (let i = 0; i < 3; i++) {
      scratch.fill(i + 1);
      client.send('fast', scratch);
      host.send(1, 'fast', scratch.buffer);
    }
    scratch.fill(99);
    hub.pump();
    expect(hostEvents).toEqual(['1 fast [1,1,1,1]', '1 fast [2,2,2,2]', '1 fast [3,3,3,3]']);
    expect(at(clientEvents, 0)).toEqual(['fast [1,1,1,1]', 'fast [2,2,2,2]', 'fast [3,3,3,3]']);
  });

  it('sends exactly the bytes of a view, whatever its type or offset', () => {
    const { hub, host, clients } = rig(1);
    const client = at(clients, 0);
    const received: ArrayBuffer[] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onMessage: (_link, _channel, data) => {
        if (typeof data !== 'string') received.push(data);
      },
    });
    const backing = new ArrayBuffer(32);
    new Uint8Array(backing).forEach((_, i, all) => (all[i] = i));
    client.send('fast', new Uint8Array(backing, 4, 3));
    client.send('fast', new DataView(backing, 10, 5));
    client.send('fast', new Uint16Array(backing, 20, 2));
    client.send('fast', new Uint8Array(0));
    const big = new Uint8Array(5000).map((_, i) => i % 251);
    client.send('ctrl', big.subarray(100, 4100));
    hub.pump();
    expect(received.map((buffer) => buffer.byteLength)).toEqual([3, 5, 4, 0, 4000]);
    expect([...new Uint8Array(at(received, 0))]).toEqual([4, 5, 6]);
    expect([...new Uint8Array(at(received, 1))]).toEqual([10, 11, 12, 13, 14]);
    expect([...new Uint8Array(at(received, 2))]).toEqual([20, 21, 22, 23]);
    expect(new Uint8Array(at(received, 4))).toEqual(big.slice(100, 4100));
    // Delivered buffers are private copies, not the sender's memory.
    for (const buffer of received) expect(buffer).not.toBe(backing);
  });

  it('gives every message its own buffer by default (safe to keep)', () => {
    const { hub, host, clients } = rig(1);
    const kept: ArrayBuffer[] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onMessage: (_link, _channel, data) => {
        if (typeof data !== 'string') kept.push(data);
      },
    });
    for (let round = 0; round < 3; round++) {
      at(clients, 0).send('fast', bytes(round, round));
      hub.pump();
    }
    expect(new Set(kept).size).toBe(3);
    expect(kept.map((buffer) => [...new Uint8Array(buffer)])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('reuses delivered buffers when recycling is on, with correct contents each time', () => {
    const { hub, host, clients } = rig(1, { recycleBuffers: true });
    const seenBuffers = new Set<ArrayBuffer>();
    const contents: number[][] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onMessage: (_link, _channel, data) => {
        if (typeof data === 'string') return;
        seenBuffers.add(data);
        contents.push([...new Uint8Array(data)]);
      },
    });
    const scratch = new Uint8Array(8);
    for (let round = 0; round < 50; round++) {
      scratch.fill(round);
      at(clients, 0).send('fast', scratch);
      at(clients, 0).send('fast', scratch.subarray(0, 3));
      hub.pump();
    }
    expect(contents).toHaveLength(100);
    contents.forEach((content, index) => {
      const round = Math.floor(index / 2);
      expect(content).toEqual(new Array(index % 2 === 0 ? 8 : 3).fill(round));
    });
    // One buffer per message size, however many rounds ran.
    expect(seenBuffers.size).toBe(2);
  });
});

describe('loopback: disconnects', () => {
  it('client close: local on the client at once, remote on the host after a pump', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(2);
    const leaving = at(clients, 0);
    leaving.send('ctrl', 'bye'); // sent before closing: still arrives
    leaving.close();
    expect(leaving.state).toBe('closed');
    expect(at(clientEvents, 0)).toEqual(['close local']);
    expect(leaving.send('ctrl', 'late')).toBe(false);
    expect(hostEvents).toEqual([]);
    host.send(1, 'ctrl', 'into the void'); // host does not know yet
    hub.pump();
    expect(hostEvents).toEqual(['1 ctrl "bye"', '-1 remote']);
    expect(at(clientEvents, 0)).toEqual(['close local']);
    expect(host.linkCount).toBe(1);
    expect(host.send(1, 'ctrl', 'x')).toBe(false);
    expect(host.send(2, 'ctrl', 'still here')).toBe(true);
    hub.pump();
    expect(at(clientEvents, 1)).toEqual(['ctrl "still here"']);
  });

  it('host close: local on the host at once, remote on the client after a pump', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(2);
    host.send(2, 'ctrl', 'kicked');
    host.close(2);
    expect(hostEvents).toEqual(['-2 local']);
    expect(host.send(2, 'ctrl', 'x')).toBe(false);
    at(clients, 1).send('ctrl', 'unaware'); // dropped: the host already forgot the link
    hub.pump();
    expect(at(clientEvents, 1)).toEqual(['ctrl "kicked"', 'close remote']);
    expect(at(clients, 1).state).toBe('closed');
    expect(hostEvents).toEqual(['-2 local']);
    expect(at(clients, 0).state).toBe('open');
    host.close(2); // unknown now: ignored
    host.close(42);
    expect(hostEvents).toEqual(['-2 local']);
  });

  it('reports each disconnect exactly once when both sides close together', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(1);
    at(clients, 0).close();
    host.close(1);
    hub.flush();
    expect(hostEvents).toEqual(['-1 local']);
    expect(at(clientEvents, 0)).toEqual(['close local']);
  });

  it('host dispose closes every client and is silent on the host', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(3);
    at(clients, 0).send('ctrl', 'never read');
    host.dispose();
    host.dispose();
    expect(host.state).toBe('closed');
    hub.flush();
    expect(hostEvents).toEqual([]);
    for (const events of clientEvents) expect(events).toEqual(['close remote']);
    for (const client of clients) expect(client.state).toBe('closed');
    host.open(ROOM); // final
    expect(host.state).toBe('closed');
  });

  it('client dispose is silent locally and tells the host', () => {
    const { hub, hostEvents, clients, clientEvents } = rig(1);
    at(clients, 0).dispose();
    hub.flush();
    expect(at(clientEvents, 0)).toEqual([]);
    expect(hostEvents).toEqual(['-1 remote']);
    at(clients, 0).connect(ROOM); // final
    expect(at(clients, 0).state).toBe('closed');
  });

  it('sever reports lost on both ends', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(1);
    host.sever(1);
    host.send(1, 'fast', bytes(1)); // sent into a dead link
    at(clients, 0).send('fast', bytes(2));
    hub.flush();
    expect(hostEvents).toEqual(['-1 lost']);
    expect(at(clientEvents, 0)).toEqual(['close lost']);
  });

  it('lets a client reconnect on the same transport and get a fresh link id', () => {
    const { hub, host, hostEvents, clients, clientEvents } = rig(1);
    const client = at(clients, 0);
    host.send(1, 'ctrl', 'old link');
    client.close();
    client.connect(ROOM);
    hub.flush();
    expect(hostEvents).toEqual(['-1 remote', '+2']);
    // The message for the old link never reaches the new one.
    expect(at(clientEvents, 0)).toEqual(['close local', 'open']);
    client.send('ctrl', 'back');
    host.send(2, 'ctrl', 'hi again');
    hub.flush();
    expect(hostEvents).toEqual(['-1 remote', '+2', '2 ctrl "back"']);
    expect(at(clientEvents, 0)).toEqual(['close local', 'open', 'ctrl "hi again"']);
  });

  it('cancels a connect that is closed before it completes', () => {
    const { hub, host, hostEvents } = rig(0);
    const client = hub.createClient();
    const events = clientLog(client);
    client.connect(ROOM);
    client.close();
    hub.flush();
    expect(events).toEqual([]);
    expect(hostEvents).toEqual([]);
    expect(host.linkCount).toBe(0);
    expect(client.state).toBe('closed');
  });

  it('lets the host close a link from inside onPeerConnected', () => {
    const hub = createLoopbackHub();
    const host = hub.createHost();
    const hostEvents: string[] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onPeerConnected: (link) => {
        hostEvents.push(`+${link}`);
        host.close(link);
      },
      onPeerDisconnected: (link, reason) => hostEvents.push(`-${link} ${reason}`),
    });
    host.open(ROOM);
    const client = hub.createClient();
    const events = clientLog(client);
    client.connect(ROOM);
    hub.flush();
    expect(hostEvents).toEqual(['+1', '-1 local']);
    expect(events).toEqual(['open', 'close remote']);
  });
});
