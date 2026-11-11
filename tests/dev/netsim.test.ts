import { describe, expect, it } from 'vitest';
import {
  NETSIM_PROFILES,
  NETSIM_PROFILE_NAMES,
  createManualClock,
  createNetsim,
  createNetsimProfile,
} from '../../src/dev/netsim';
import type { ManualClock, Netsim, NetsimOptions, NetsimProfile } from '../../src/dev/netsim';
import { generateRoomCode } from '../../src/net/room-code';
import { createLoopbackHub } from '../../src/net/transport/loopback';
import { NOOP_CLIENT_HANDLERS, NOOP_HOST_HANDLERS } from '../../src/net/transport/transport';
import type {
  Channel,
  ClientTransport,
  ClientTransportHandlers,
  DisconnectReason,
  HostTransport,
  HostTransportHandlers,
  LinkId,
  TransportMessage,
  TransportPayload,
  TransportState,
} from '../../src/net/transport/transport';

// --- fakes: an inner transport that is instant, lossless and records what reaches it ------------

interface Sent {
  link: LinkId;
  channel: Channel;
  /** Copy of the bytes (or the string) the inner transport was handed. */
  data: Uint8Array | string;
  atMs: number;
}

function snapshot(data: TransportPayload): Uint8Array | string {
  if (typeof data === 'string') return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  return new Uint8Array(data).slice();
}

class FakeClient implements ClientTransport {
  state: TransportState = 'idle';
  handlers: ClientTransportHandlers = NOOP_CLIENT_HANDLERS;
  readonly sent: Sent[] = [];
  /** Off for the bulk tests, which only count. */
  record = true;
  sentCount = 0;

  constructor(private readonly clock: ManualClock) {}

  setHandlers(handlers: ClientTransportHandlers): void {
    this.handlers = handlers;
  }
  connect(): void {
    this.state = 'open';
    this.handlers.onOpen();
  }
  send(channel: Channel, data: TransportPayload): boolean {
    if (this.state !== 'open') return false;
    this.sentCount++;
    if (this.record) {
      this.sent.push({ link: 0, channel, data: snapshot(data), atMs: this.clock.now() });
    }
    return true;
  }
  close(): void {
    if (this.state !== 'open') return;
    this.state = 'closed';
    this.handlers.onClose('local');
  }
  dispose(): void {
    this.state = 'closed';
  }
  /** The "network" delivers something from the host. */
  receive(channel: Channel, data: TransportMessage): void {
    this.handlers.onMessage(channel, data);
  }
  remoteClose(reason: DisconnectReason = 'remote'): void {
    this.state = 'closed';
    this.handlers.onClose(reason);
  }
}

class FakeHost implements HostTransport {
  state: TransportState = 'idle';
  roomCode = '';
  handlers: HostTransportHandlers = NOOP_HOST_HANDLERS;
  readonly sent: Sent[] = [];
  readonly open_ = new Set<LinkId>();
  private nextLink = 1;

  constructor(private readonly clock: ManualClock) {}

  setHandlers(handlers: HostTransportHandlers): void {
    this.handlers = handlers;
  }
  open(roomCode: string): void {
    this.state = 'open';
    this.roomCode = roomCode;
    this.handlers.onOpen(roomCode);
  }
  send(link: LinkId, channel: Channel, data: TransportPayload): boolean {
    if (!this.open_.has(link)) return false;
    this.sent.push({ link, channel, data: snapshot(data), atMs: this.clock.now() });
    return true;
  }
  close(link: LinkId): void {
    if (!this.open_.delete(link)) return;
    this.handlers.onPeerDisconnected(link, 'local');
  }
  dispose(): void {
    this.state = 'closed';
    this.open_.clear();
  }
  join(): LinkId {
    const link = this.nextLink++;
    this.open_.add(link);
    this.handlers.onPeerConnected(link);
    return link;
  }
  receive(link: LinkId, channel: Channel, data: TransportMessage): void {
    this.handlers.onMessage(link, channel, data);
  }
  drop(link: LinkId, reason: DisconnectReason = 'lost'): void {
    if (!this.open_.delete(link)) return;
    this.handlers.onPeerDisconnected(link, reason);
  }
}

interface Received {
  link: LinkId;
  channel: Channel;
  data: Uint8Array | string;
  atMs: number;
}

interface ClientRig {
  clock: ManualClock;
  netsim: Netsim;
  inner: FakeClient;
  client: ClientTransport;
  received: Received[];
  events: string[];
}

function clientRig(options: Omit<NetsimOptions, 'now'> = {}): ClientRig {
  const clock = createManualClock(1000);
  const netsim = createNetsim({ ...options, now: clock.now });
  const inner = new FakeClient(clock);
  const client = netsim.wrapClient(inner);
  const received: Received[] = [];
  const events: string[] = [];
  client.setHandlers({
    onOpen: () => events.push('open'),
    onClose: (reason) => events.push(`close ${reason}`),
    onError: (error) => events.push(`error ${error.reason}`),
    onMessage: (channel, data) =>
      received.push({ link: 0, channel, data: snapshot(data), atMs: clock.now() }),
  });
  client.connect('ABCDE');
  return { clock, netsim, inner, client, received, events };
}

/** Advances the clock in 1 ms steps, pumping at each. */
function run(rig: { clock: ManualClock; netsim: Netsim }, ms: number): void {
  for (let i = 0; i < ms; i++) {
    rig.clock.advance(1);
    rig.netsim.pump();
  }
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function readU32(data: Uint8Array | string): number {
  if (typeof data === 'string') throw new Error('expected bytes');
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}

const NO_LOSS_BAD = createNetsimProfile(80, 20, 0);
const NASTY: NetsimProfile = createNetsimProfile(120, 100, 60, 40, 40);

// --- tests --------------------------------------------------------------------------------------

describe('netsim: off profile', () => {
  it('passes messages straight through, with no queueing and no copy', () => {
    const rig = clientRig();
    expect(rig.netsim.idle).toBe(true);
    expect(rig.events).toEqual(['open']);

    expect(rig.client.send('fast', u32(7))).toBe(true);
    expect(rig.client.send('ctrl', 'hello')).toBe(true);
    expect(rig.netsim.queued).toBe(0);
    expect(rig.inner.sent.map((s) => s.channel)).toEqual(['fast', 'ctrl']);
    expect(rig.inner.sent[1]?.data).toBe('hello');

    let seen: TransportMessage | null = null;
    rig.client.setHandlers({ ...NOOP_CLIENT_HANDLERS, onMessage: (_c, data) => (seen = data) });
    const buffer = new ArrayBuffer(8);
    rig.inner.receive('fast', buffer);
    expect(seen).toBe(buffer);
    expect(rig.netsim.pump()).toBe(0);
  });

  it('forwards state, send failures and connection events of the inner transport', () => {
    const clock = createManualClock();
    const netsim = createNetsim({ now: clock.now, profile: NETSIM_PROFILES.bad });
    const inner = new FakeClient(clock);
    const client = netsim.wrapClient(inner);
    expect(client.state).toBe('idle');
    expect(client.send('ctrl', 'early')).toBe(false);
    const events: string[] = [];
    client.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onOpen: () => events.push('open'),
      onClose: (reason) => events.push(`close ${reason}`),
    });
    client.connect('ABCDE');
    expect(client.state).toBe('open');
    client.close();
    expect(client.state).toBe('closed');
    expect(events).toEqual(['open', 'close local']);
    expect(client.send('fast', u32(1))).toBe(false);
  });
});

describe('netsim: delay', () => {
  it('delivers within latency ± jitter and never before the minimum (both directions)', () => {
    const rig = clientRig({ profile: NO_LOSS_BAD, seed: 11 });
    const total = 4000;
    const sentAt: number[] = [];
    for (let i = 0; i < total; i++) {
      sentAt.push(rig.clock.now());
      rig.client.send('fast', u32(i));
      rig.inner.receive('fast', u32(i).buffer as ArrayBuffer);
      run(rig, 1);
    }
    run(rig, 200);

    expect(rig.inner.sent).toHaveLength(total);
    expect(rig.received).toHaveLength(total);
    for (const list of [rig.inner.sent, rig.received]) {
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const m of list) {
        const delay = m.atMs - (sentAt[readU32(m.data)] ?? NaN);
        min = Math.min(min, delay);
        max = Math.max(max, delay);
        sum += delay;
      }
      expect(min).toBeGreaterThanOrEqual(60);
      // Pumped every 1 ms, so a packet is at most 1 ms late.
      expect(max).toBeLessThanOrEqual(101);
      expect(min).toBeLessThan(64);
      expect(max).toBeGreaterThan(97);
      expect(sum / total).toBeGreaterThan(78.5);
      expect(sum / total).toBeLessThan(82.5);
    }
  });

  it('holds a message back until its exact due time with no jitter', () => {
    const rig = clientRig({ profile: createNetsimProfile(50, 0, 0) });
    rig.client.send('fast', u32(1));
    rig.clock.advance(49.9);
    expect(rig.netsim.pump()).toBe(0);
    expect(rig.inner.sent).toHaveLength(0);
    rig.clock.advance(0.1);
    expect(rig.netsim.pump()).toBe(1);
    expect(rig.inner.sent).toHaveLength(1);
    expect(rig.netsim.queued).toBe(0);
  });

  it('`pump(nowMs)` uses the given time instead of the clock', () => {
    const rig = clientRig({ profile: createNetsimProfile(50, 0, 0) });
    const start = rig.clock.now();
    rig.client.send('fast', u32(1));
    expect(rig.netsim.pump(start + 49)).toBe(0);
    expect(rig.netsim.pump(start + 50)).toBe(1);
  });

  it('the normal shape stays in bounds and clusters tighter than uniform', () => {
    const spread = (shape: 'uniform' | 'normal'): { sd: number; min: number; max: number } => {
      const rig = clientRig({ profile: createNetsimProfile(100, 40, 0), seed: 5 });
      rig.netsim.outbound.jitterShape = shape;
      const total = 5000;
      const sentAt: number[] = [];
      for (let i = 0; i < total; i++) {
        sentAt.push(rig.clock.now());
        rig.client.send('fast', u32(i));
        run(rig, 1);
      }
      run(rig, 200);
      const delays = rig.inner.sent.map((m) => m.atMs - (sentAt[readU32(m.data)] ?? NaN));
      const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
      const variance = delays.reduce((a, b) => a + (b - mean) ** 2, 0) / delays.length;
      return { sd: Math.sqrt(variance), min: Math.min(...delays), max: Math.max(...delays) };
    };
    const uniform = spread('uniform');
    const normal = spread('normal');
    expect(normal.min).toBeGreaterThanOrEqual(60);
    expect(normal.max).toBeLessThanOrEqual(141);
    // Uniform ±40 has sd 23.1; the sum of three uniforms has sd 13.3.
    expect(uniform.sd).toBeGreaterThan(21);
    expect(normal.sd).toBeGreaterThan(11);
    expect(normal.sd).toBeLessThan(16);
  });

  it('jitter larger than the latency clamps the delay at zero', () => {
    const rig = clientRig({ profile: createNetsimProfile(5, 50, 0), seed: 3 });
    const sentAt: number[] = [];
    for (let i = 0; i < 500; i++) {
      sentAt.push(rig.clock.now());
      rig.client.send('fast', u32(i));
      run(rig, 1);
    }
    run(rig, 100);
    expect(rig.inner.sent).toHaveLength(500);
    const delays = rig.inner.sent.map((m) => m.atMs - (sentAt[readU32(m.data)] ?? NaN));
    expect(Math.min(...delays)).toBe(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(56);
    // Roughly 45 % of the samples fall below zero and go out at once.
    expect(delays.filter((d) => d === 0).length).toBeGreaterThan(150);
  });
});

describe('netsim: loss, duplication, reordering on fast', () => {
  it('loses about the configured share of 100k packets in each direction', () => {
    const rig = clientRig({ profile: NETSIM_PROFILES.bad, seed: 2026 });
    rig.inner.record = false;
    let receivedCount = 0;
    rig.client.setHandlers({ ...NOOP_CLIENT_HANDLERS, onMessage: () => receivedCount++ });
    const total = 100_000;
    const out = u32(1);
    const incoming = new ArrayBuffer(24);
    for (let i = 0; i < total; i++) {
      rig.client.send('fast', out);
      rig.inner.receive('fast', incoming);
      if (i % 4 === 0) run(rig, 1);
    }
    run(rig, 200);

    expect(rig.netsim.queued).toBe(0);
    const outLoss = 1 - rig.inner.sentCount / total;
    const inLoss = 1 - receivedCount / total;
    expect(outLoss).toBeGreaterThan(0.018);
    expect(outLoss).toBeLessThan(0.022);
    expect(inLoss).toBeGreaterThan(0.018);
    expect(inLoss).toBeLessThan(0.022);
    expect(rig.netsim.counters.lost).toBe(2 * total - rig.inner.sentCount - receivedCount);
    expect(rig.netsim.counters.overflowDropped).toBe(0);
    expect(rig.netsim.stats.fast.droppedPackets).toBe(rig.netsim.counters.lost);
  });

  it('send still returns true for a packet the simulation loses', () => {
    const rig = clientRig({ profile: createNetsimProfile(0, 0, 100) });
    expect(rig.client.send('fast', u32(1))).toBe(true);
    run(rig, 10);
    expect(rig.inner.sent).toHaveLength(0);
    expect(rig.netsim.counters.lost).toBe(1);
  });

  it('duplicates about the configured share, byte for byte', () => {
    const rig = clientRig({ profile: createNetsimProfile(10, 5, 0, 10, 0), seed: 9 });
    const total = 10_000;
    for (let i = 0; i < total; i++) {
      rig.client.send('fast', u32(i));
      if (i % 4 === 0) run(rig, 1);
    }
    run(rig, 100);
    const copies = new Map<number, number>();
    for (const m of rig.inner.sent) {
      const id = readU32(m.data);
      copies.set(id, (copies.get(id) ?? 0) + 1);
    }
    expect(copies.size).toBe(total);
    const duplicated = [...copies.values()].filter((n) => n === 2).length;
    expect([...copies.values()].every((n) => n === 1 || n === 2)).toBe(true);
    expect(duplicated).toBe(rig.netsim.counters.duplicated);
    expect(duplicated / total).toBeGreaterThan(0.085);
    expect(duplicated / total).toBeLessThan(0.115);
  });

  it('reorders: jitter alone does, and reorderPct holds packets back at constant latency', () => {
    const inversions = (profile: NetsimProfile): number => {
      const rig = clientRig({ profile, seed: 4 });
      for (let i = 0; i < 2000; i++) {
        rig.client.send('fast', u32(i));
        run(rig, 2);
      }
      run(rig, 300);
      expect(rig.inner.sent).toHaveLength(2000);
      let count = 0;
      let highest = -1;
      for (const m of rig.inner.sent) {
        const id = readU32(m.data);
        if (id < highest) count++;
        else highest = id;
      }
      return count;
    };
    expect(inversions(createNetsimProfile(30, 0, 0))).toBe(0);
    expect(inversions(createNetsimProfile(30, 20, 0))).toBeGreaterThan(100);
    const held = inversions(createNetsimProfile(30, 0, 0, 0, 10));
    expect(held).toBeGreaterThan(120);
    expect(held).toBeLessThan(280);
  });
});

describe('netsim: ctrl is reliable and ordered', () => {
  const profiles: NetsimProfile[] = [...NETSIM_PROFILE_NAMES.map((n) => NETSIM_PROFILES[n]), NASTY];

  for (const profile of profiles) {
    it(`keeps every ctrl message, in order, under ${profile.name} (${profile.latencyMs} ms)`, () => {
      const rig = clientRig({ profile, seed: 77 });
      const total = 3000;
      for (let i = 0; i < total; i++) {
        // Bursts and gaps, binary and text, fast traffic in between.
        rig.client.send('ctrl', i % 3 === 0 ? `m${i}` : u32(i));
        rig.inner.receive('ctrl', i % 5 === 0 ? `m${i}` : (u32(i).buffer as ArrayBuffer));
        rig.client.send('fast', u32(i));
        rig.inner.receive('fast', u32(i).buffer as ArrayBuffer);
        if (i % 7 === 0) run(rig, i % 3);
      }
      run(rig, 1500);

      const idOf = (data: Uint8Array | string): number =>
        typeof data === 'string' ? Number(data.slice(1)) : readU32(data);
      const outCtrl = rig.inner.sent.filter((m) => m.channel === 'ctrl').map((m) => idOf(m.data));
      const inCtrl = rig.received.filter((m) => m.channel === 'ctrl').map((m) => idOf(m.data));
      const expected = Array.from({ length: total }, (_, i) => i);
      expect(outCtrl).toEqual(expected);
      expect(inCtrl).toEqual(expected);
      expect(rig.netsim.stats.ctrl.droppedPackets).toBe(0);
      expect(rig.netsim.queued).toBe(0);
    });
  }

  it('delays ctrl by at least the minimum latency', () => {
    const rig = clientRig({ profile: NETSIM_PROFILES.bad, seed: 1 });
    const sentAt: number[] = [];
    for (let i = 0; i < 500; i++) {
      sentAt.push(rig.clock.now());
      rig.client.send('ctrl', u32(i));
      run(rig, 3);
    }
    run(rig, 300);
    expect(rig.inner.sent).toHaveLength(500);
    for (const m of rig.inner.sent) {
      expect(m.atMs - (sentAt[readU32(m.data)] ?? NaN)).toBeGreaterThanOrEqual(60);
    }
  });

  it('stays ordered when the conditions change while messages wait', () => {
    const rig = clientRig({ profile: NETSIM_PROFILES.awful, seed: 8 });
    for (let i = 0; i < 20; i++) rig.client.send('ctrl', u32(i));
    rig.netsim.setProfile(NETSIM_PROFILES.off);
    // Zero delay now, but 20 older messages still wait: these must queue behind them.
    for (let i = 20; i < 40; i++) rig.client.send('ctrl', u32(i));
    expect(rig.inner.sent).toHaveLength(0);
    rig.netsim.setProfile(NETSIM_PROFILES.lan);
    for (let i = 40; i < 60; i++) rig.client.send('ctrl', u32(i));
    run(rig, 400);
    expect(rig.inner.sent.map((m) => readU32(m.data))).toEqual(
      Array.from({ length: 60 }, (_, i) => i),
    );
    // Once drained, `off` is a straight pass-through again.
    rig.netsim.setProfile(NETSIM_PROFILES.off);
    rig.client.send('ctrl', u32(60));
    expect(rig.inner.sent).toHaveLength(61);
  });

  it('orders ctrl per link on a host and keeps links independent', () => {
    const clock = createManualClock();
    const netsim = createNetsim({ now: clock.now, profile: NASTY, seed: 21 });
    const inner = new FakeHost(clock);
    const host = netsim.wrapHost(inner);
    const received: Received[] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onMessage: (link, channel, data) =>
        received.push({ link, channel, data: snapshot(data), atMs: clock.now() }),
    });
    host.open('ABCDE');
    expect(host.state).toBe('open');
    expect(host.roomCode).toBe('ABCDE');
    const a = inner.join();
    const b = inner.join();
    for (let i = 0; i < 400; i++) {
      host.send(a, 'ctrl', u32(i));
      host.send(b, 'ctrl', u32(1000 + i));
      inner.receive(a, 'ctrl', u32(i).buffer as ArrayBuffer);
      inner.receive(b, 'ctrl', u32(1000 + i).buffer as ArrayBuffer);
      if (i % 5 === 0) run({ clock, netsim }, 2);
    }
    run({ clock, netsim }, 1000);
    const ids = (list: readonly Sent[] | readonly Received[], link: LinkId): number[] =>
      list.filter((m) => m.link === link).map((m) => readU32(m.data));
    const expected = Array.from({ length: 400 }, (_, i) => i);
    expect(ids(inner.sent, a)).toEqual(expected);
    expect(ids(inner.sent, b)).toEqual(expected.map((i) => 1000 + i));
    expect(ids(received, a)).toEqual(expected);
    expect(ids(received, b)).toEqual(expected.map((i) => 1000 + i));
    expect(host.send(99, 'ctrl', u32(1))).toBe(false);
  });
});

describe('netsim: determinism', () => {
  function trace(seed: number): string {
    const rig = clientRig({ profile: createNetsimProfile(60, 30, 10, 5, 5), seed });
    for (let i = 0; i < 1500; i++) {
      rig.client.send('fast', u32(i));
      rig.inner.receive('fast', u32(i).buffer as ArrayBuffer);
      if (i % 10 === 0) rig.client.send('ctrl', u32(i));
      run(rig, 1);
    }
    run(rig, 300);
    const line = (m: Sent | Received): string => `${m.channel}:${readU32(m.data)}@${m.atMs}`;
    return `${rig.inner.sent.map(line).join(',')}|${rig.received.map(line).join(',')}`;
  }

  it('the same seed and traffic give the same deliveries; another seed does not', () => {
    const first = trace(42);
    expect(trace(42)).toBe(first);
    expect(trace(43)).not.toBe(first);
  });

  it('reseed restarts the sequence', () => {
    const rig = clientRig({ profile: createNetsimProfile(0, 0, 50), seed: 6 });
    const pattern = (): string => {
      const start = rig.inner.sent.length;
      for (let i = 0; i < 64; i++) rig.client.send('fast', u32(i));
      return rig.inner.sent
        .slice(start)
        .map((m) => readU32(m.data))
        .join(',');
    };
    const first = pattern();
    expect(pattern()).not.toBe(first);
    rig.netsim.reseed(6);
    expect(pattern()).toBe(first);
  });
});

describe('netsim: bounded queue', () => {
  it('drops the oldest waiting fast packets when full, and never ctrl', () => {
    const rig = clientRig({ profile: createNetsimProfile(100, 0, 0), capacity: 8 });
    for (let i = 0; i < 50; i++) {
      rig.client.send('ctrl', u32(i));
      rig.client.send('fast', u32(i));
    }
    // 50 ctrl (the pool grew for them) + the 8 newest fast.
    expect(rig.netsim.queued).toBe(58);
    expect(rig.netsim.counters.overflowDropped).toBe(42);
    expect(rig.netsim.stats.fast.droppedPackets).toBe(42);
    run(rig, 100);
    const ids = (channel: Channel): number[] =>
      rig.inner.sent.filter((m) => m.channel === channel).map((m) => readU32(m.data));
    expect(ids('ctrl')).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(ids('fast')).toEqual([42, 43, 44, 45, 46, 47, 48, 49]);
    expect(rig.netsim.queued).toBe(0);
    expect(rig.netsim.counters.peakQueued).toBe(58);
  });

  it('stays bounded under sustained overload and recovers', () => {
    const rig = clientRig({ profile: createNetsimProfile(500, 100, 0), capacity: 32, seed: 3 });
    for (let i = 0; i < 5000; i++) {
      rig.client.send('fast', u32(i));
      rig.inner.receive('fast', u32(i).buffer as ArrayBuffer);
      if (i % 20 === 0) run(rig, 1);
      expect(rig.netsim.queued).toBeLessThanOrEqual(32);
    }
    run(rig, 700);
    expect(rig.netsim.queued).toBe(0);
    const delivered = rig.inner.sent.length + rig.received.length;
    expect(delivered + rig.netsim.counters.overflowDropped).toBe(10_000);
    // Drop-oldest under sustained overload starves: nothing lives 500 ms, only the last 32 do.
    expect(delivered).toBe(32);
    rig.netsim.setProfile(NETSIM_PROFILES.off);
    expect(rig.client.send('fast', u32(1))).toBe(true);
    expect(rig.inner.sent.at(-1)?.atMs).toBe(rig.clock.now());
  });
});

describe('netsim: payloads and buffers', () => {
  it('copies on send: views send only their bytes and the sender may reuse its buffer', () => {
    const rig = clientRig({ profile: createNetsimProfile(10, 0, 0) });
    const scratch = new Uint8Array(64).map((_, i) => i);
    rig.client.send('fast', scratch.subarray(10, 15));
    rig.client.send('fast', new DataView(scratch.buffer, 20, 3));
    rig.client.send('fast', new Uint16Array(scratch.buffer, 30, 2));
    rig.client.send('ctrl', scratch.buffer.slice(0, 4));
    const big = new Uint8Array(5000).map((_, i) => i * 7);
    rig.client.send('ctrl', big);
    scratch.fill(255);
    run(rig, 10);
    const bytes = rig.inner.sent.map((m) => (typeof m.data === 'string' ? [] : [...m.data]));
    expect(bytes[0]).toEqual([10, 11, 12, 13, 14]);
    expect(bytes[1]).toEqual([20, 21, 22]);
    expect(bytes[2]).toEqual([30, 31, 32, 33]);
    expect(bytes[3]).toEqual([0, 1, 2, 3]);
    expect(bytes[4]).toEqual([...big]);
  });

  it('delivers inbound binary as an ArrayBuffer of the exact length', () => {
    const rig = clientRig({ profile: createNetsimProfile(10, 0, 0) });
    const seen: TransportMessage[] = [];
    rig.client.setHandlers({ ...NOOP_CLIENT_HANDLERS, onMessage: (_c, data) => seen.push(data) });
    rig.inner.receive('fast', new Uint8Array([1, 2, 3]).buffer);
    rig.inner.receive('ctrl', 'text');
    run(rig, 10);
    expect(seen[0]).toBeInstanceOf(ArrayBuffer);
    expect((seen[0] as ArrayBuffer).byteLength).toBe(3);
    expect([...new Uint8Array(seen[0] as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(seen[1]).toBe('text');
  });

  it('recycles delivered buffers by default and hands out fresh ones when told to', () => {
    const distinct = (recycleBuffers: boolean | undefined): number => {
      const rig = clientRig({ profile: createNetsimProfile(5, 0, 0), recycleBuffers });
      const seen = new Set<TransportMessage>();
      rig.client.setHandlers({ ...NOOP_CLIENT_HANDLERS, onMessage: (_c, data) => seen.add(data) });
      for (let i = 0; i < 200; i++) {
        rig.inner.receive('fast', u32(i).buffer as ArrayBuffer);
        run(rig, 1);
      }
      run(rig, 10);
      return seen.size;
    };
    expect(distinct(undefined)).toBeLessThan(10);
    expect(distinct(false)).toBe(200);
  });

  it('allocates nothing per packet in steady state', () => {
    const rig = clientRig({ profile: NETSIM_PROFILES.bad, seed: 12 });
    rig.inner.record = false;
    let bytesSeen = 0;
    rig.client.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onMessage: (_c, data) => {
        if (typeof data !== 'string') bytesSeen += data.byteLength;
      },
    });
    const out = new Uint8Array(24);
    const incoming = new ArrayBuffer(291);
    const cycle = (): void => {
      rig.client.send('fast', out);
      rig.inner.receive('fast', incoming);
      rig.clock.advance(1);
      rig.netsim.pump();
    };
    for (let i = 0; i < 20_000; i++) cycle();
    const growth: number[] = [];
    for (let trial = 0; trial < 9; trial++) {
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 4000; i++) cycle();
      growth.push(process.memoryUsage().heapUsed - before);
    }
    growth.sort((a, b) => a - b);
    expect(bytesSeen).toBeGreaterThan(0);
    // 4000 cycles = 8000 packets: one 16-byte allocation per packet would be 128 KB.
    expect(growth[4]).toBeLessThan(16 * 1024);
  });
});

describe('netsim: links ending', () => {
  it('close hands queued outbound ctrl to the inner transport first and discards fast', () => {
    const rig = clientRig({ profile: NETSIM_PROFILES.bad });
    rig.client.send('ctrl', 'bye 1');
    rig.client.send('fast', u32(5));
    rig.client.send('ctrl', 'bye 2');
    rig.inner.receive('ctrl', 'unseen');
    expect(rig.inner.sent).toHaveLength(0);
    rig.client.close();
    expect(rig.inner.sent.map((m) => m.data)).toEqual(['bye 1', 'bye 2']);
    expect(rig.events).toEqual(['open', 'close local']);
    expect(rig.netsim.queued).toBe(0);
    run(rig, 300);
    expect(rig.received).toHaveLength(0);
    expect(rig.inner.sent).toHaveLength(2);
    expect(rig.netsim.counters.discarded).toBe(2);
  });

  it('a remote close first delivers the ctrl messages that were still in flight', () => {
    const rig = clientRig({ profile: NETSIM_PROFILES.bad });
    const order: string[] = [];
    rig.client.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onMessage: (channel, data) => order.push(`${channel} ${String(data)}`),
      onClose: (reason) => order.push(`close ${reason}`),
    });
    rig.inner.receive('ctrl', 'lobby');
    rig.inner.receive('fast', u32(1).buffer as ArrayBuffer);
    rig.inner.receive('ctrl', 'kick');
    rig.inner.remoteClose('remote');
    expect(order).toEqual(['ctrl lobby', 'ctrl kick', 'close remote']);
    run(rig, 300);
    expect(order).toHaveLength(3);
  });

  it('reports the close exactly once when a flushed message makes the app close', () => {
    const rig = clientRig({ profile: NETSIM_PROFILES.bad });
    const order: string[] = [];
    rig.client.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onMessage: (_c, data) => {
        order.push(String(data));
        if (data === 'kick') rig.client.close();
      },
      onClose: (reason) => order.push(`close ${reason}`),
    });
    rig.inner.receive('ctrl', 'kick');
    rig.inner.receive('ctrl', 'after');
    rig.inner.remoteClose();
    expect(order.filter((line) => line.startsWith('close'))).toHaveLength(1);
    expect(order[0]).toBe('kick');
  });

  it('a reconnect does not see messages of the previous connection', () => {
    const rig = clientRig({ profile: NETSIM_PROFILES.bad });
    rig.inner.receive('fast', u32(1).buffer as ArrayBuffer);
    rig.client.send('fast', u32(2));
    rig.inner.remoteClose('lost');
    rig.client.connect('ABCDE');
    expect(rig.events).toEqual(['open', 'close lost', 'open']);
    run(rig, 300);
    expect(rig.received).toHaveLength(0);
    expect(rig.inner.sent).toHaveLength(0);
    rig.client.send('ctrl', 'again');
    run(rig, 300);
    expect(rig.inner.sent.map((m) => m.data)).toEqual(['again']);
  });

  it('host: a kick message sent right before close(link) still goes out', () => {
    const clock = createManualClock();
    const netsim = createNetsim({ now: clock.now, profile: NETSIM_PROFILES.awful });
    const inner = new FakeHost(clock);
    const host = netsim.wrapHost(inner);
    const events: string[] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onPeerConnected: (link) => events.push(`+${link}`),
      onPeerDisconnected: (link, reason) => events.push(`-${link} ${reason}`),
      onMessage: (link, _c, data) => events.push(`${link}: ${String(data)}`),
    });
    host.open('ABCDE');
    const a = inner.join();
    const b = inner.join();
    host.send(a, 'ctrl', 'kick');
    host.send(b, 'ctrl', 'stay');
    host.send(a, 'fast', u32(1));
    host.close(a);
    expect(inner.sent.map((m) => `${m.link} ${String(m.data)}`)).toEqual([`${a} kick`]);
    expect(events).toEqual([`+${a}`, `+${b}`, `-${a} local`]);

    inner.receive(b, 'ctrl', 'last words');
    inner.drop(b, 'lost');
    expect(events.slice(3)).toEqual([`${b}: last words`, `-${b} lost`]);
    run({ clock, netsim }, 500);
    expect(inner.sent).toHaveLength(1);
    expect(netsim.queued).toBe(0);
  });

  it('dispose is silent, flushes outbound ctrl and empties the queue', () => {
    const clock = createManualClock();
    const netsim = createNetsim({ now: clock.now, profile: NETSIM_PROFILES.bad });
    const inner = new FakeHost(clock);
    const host = netsim.wrapHost(inner);
    const events: string[] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onPeerDisconnected: (link) => events.push(`-${link}`),
      onMessage: () => events.push('message'),
    });
    host.open('ABCDE');
    const a = inner.join();
    host.send(a, 'ctrl', 'host left');
    host.send(a, 'fast', u32(1));
    inner.receive(a, 'ctrl', 'intent');
    host.dispose();
    expect(inner.sent.map((m) => m.data)).toEqual(['host left']);
    expect(inner.state).toBe('closed');
    expect(netsim.queued).toBe(0);
    run({ clock, netsim }, 300);
    expect(events).toEqual([]);
  });
});

describe('netsim: pump', () => {
  it('ignores a pump from inside a handler and delivers what the handler sends later', () => {
    const rig = clientRig({ profile: createNetsimProfile(10, 0, 0) });
    let nested = -1;
    rig.client.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onMessage: () => {
        nested = rig.netsim.pump();
        rig.client.send('ctrl', 'reply');
      },
    });
    rig.inner.receive('ctrl', 'ping');
    run(rig, 10);
    expect(nested).toBe(0);
    expect(rig.inner.sent).toHaveLength(0);
    run(rig, 10);
    expect(rig.inner.sent.map((m) => m.data)).toEqual(['reply']);
  });

  it('keeps working after a handler throws', () => {
    const rig = clientRig({ profile: createNetsimProfile(10, 0, 0) });
    let calls = 0;
    rig.client.setHandlers({
      ...NOOP_CLIENT_HANDLERS,
      onMessage: () => {
        if (++calls === 1) throw new Error('boom');
      },
    });
    rig.inner.receive('fast', u32(1).buffer as ArrayBuffer);
    rig.inner.receive('fast', u32(2).buffer as ArrayBuffer);
    rig.clock.advance(10);
    expect(() => rig.netsim.pump()).toThrow('boom');
    expect(rig.netsim.pump()).toBe(1);
    expect(calls).toBe(2);
    expect(rig.netsim.queued).toBe(0);
  });
});

describe('netsim: stats', () => {
  it('counts app traffic per channel and refreshes rates on pump', () => {
    const rig = clientRig({ profile: createNetsimProfile(20, 0, 0) });
    rig.netsim.pump();
    for (let i = 0; i < 1000; i++) {
      rig.client.send('fast', new Uint8Array(24));
      if (i % 2 === 0) rig.inner.receive('fast', new ArrayBuffer(291));
      if (i % 100 === 0) rig.client.send('ctrl', 'x'.repeat(10));
      run(rig, 1);
    }
    run(rig, 100);
    const { fast, ctrl } = rig.netsim.stats;
    expect(fast.sentPackets).toBe(1000);
    expect(fast.sentBytes).toBe(24_000);
    expect(fast.receivedPackets).toBe(500);
    expect(fast.receivedBytes).toBe(500 * 291);
    expect(ctrl.sentPackets).toBe(10);
    expect(ctrl.sentBytes).toBe(100);
    expect(fast.droppedPackets).toBe(0);
    // The last full window (t = 1000..1100 ms after the first pump) had no traffic left; the
    // one before it saw a whole second of sends.
    expect(rig.netsim.stats.windowStartMs).toBe(rig.clock.now() - 100);
    expect(fast.sentBytesPerS).toBe(24_000);
    run(rig, 1000);
    expect(fast.sentBytesPerS).toBe(0);
  });

  it('feeds a caller-owned NetStats', async () => {
    const { createNetStats } = await import('../../src/dev/netsim');
    const stats = createNetStats();
    const rig = clientRig({ stats });
    rig.client.send('fast', u32(1));
    expect(rig.netsim.stats).toBe(stats);
    expect(stats.fast.sentPackets).toBe(1);
  });
});

describe('netsim over the loopback transport', () => {
  it('a wrapped host talks to two plain clients through the delay', () => {
    const clock = createManualClock();
    const hub = createLoopbackHub();
    const netsim = createNetsim({
      now: clock.now,
      profile: createNetsimProfile(40, 10, 0),
      seed: 1,
    });
    const host = netsim.wrapHost(hub.createHost());
    const code = generateRoomCode(() => 0.5);
    const hostLog: string[] = [];
    const links: LinkId[] = [];
    host.setHandlers({
      ...NOOP_HOST_HANDLERS,
      onOpen: (roomCode) => hostLog.push(`open ${roomCode}`),
      onPeerConnected: (link) => links.push(link),
      onPeerDisconnected: (link, reason) => hostLog.push(`gone ${link} ${reason}`),
      onMessage: (link, channel, data) =>
        hostLog.push(`${link} ${channel} ${typeof data === 'string' ? data : data.byteLength}`),
    });
    host.open(code);
    hub.flush();
    expect(hostLog).toEqual([`open ${code}`]);

    const clientLogs: string[][] = [[], []];
    const clients = clientLogs.map((log) => {
      const client = hub.createClient();
      client.setHandlers({
        ...NOOP_CLIENT_HANDLERS,
        onOpen: () => log.push('open'),
        onClose: (reason) => log.push(`close ${reason}`),
        onMessage: (channel, data) =>
          log.push(`${channel} ${typeof data === 'string' ? data : data.byteLength}`),
      });
      client.connect(code);
      return client;
    });
    hub.flush();
    expect(links).toHaveLength(2);
    expect(clientLogs).toEqual([['open'], ['open']]);

    const step = (ms: number): void => {
      for (let i = 0; i < ms; i++) {
        clock.advance(1);
        hub.pump();
        netsim.pump();
        hub.pump();
      }
    };
    clients[0]?.send('ctrl', 'hello');
    clients[1]?.send('fast', new Uint8Array(12));
    for (const link of links) host.send(link, 'ctrl', `welcome ${link}`);
    step(29);
    expect(hostLog).toHaveLength(1);
    expect(clientLogs).toEqual([['open'], ['open']]);
    step(30);
    expect(hostLog.slice(1).sort()).toEqual([`${links[0]} ctrl hello`, `${links[1]} fast 12`]);
    expect(clientLogs).toEqual([
      ['open', `ctrl welcome ${links[0]}`],
      ['open', `ctrl welcome ${links[1]}`],
    ]);

    host.send(links[0] ?? 0, 'ctrl', 'kick');
    host.close(links[0] ?? 0);
    hub.flush();
    expect(clientLogs[0]?.slice(2)).toEqual(['ctrl kick', 'close remote']);
    expect(hostLog.at(-1)).toBe(`gone ${links[0]} local`);
    host.dispose();
  });
});
