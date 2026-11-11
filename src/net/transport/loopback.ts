/**
 * In-memory transport: one hub pairs hosts and clients living in the same JS realm. Used by
 * vitest and by the in-page net-bots (`?bots=N`), which go through the real codec but not
 * through WebRTC.
 *
 * Nothing is delivered until someone calls `hub.pump()`: every send and every connection event
 * is queued in call order, and one `pump()` delivers exactly the entries that were queued before
 * it started (what handlers send while being pumped arrives with the next pump). There are no
 * timers, promises or microtasks, so a test or a fixed-tick loop decides when the "network" runs
 * and the result is fully deterministic.
 *
 * Binary payloads are copied on `send`, so senders can reuse their buffers. In steady state the
 * hub allocates nothing per message when `recycleBuffers` is on (queue entries, copy buffers and
 * source views are pooled); with it off (the default) each delivered message is a fresh
 * `ArrayBuffer`, as from a real data channel.
 *
 * Differences from WebRTC worth knowing: `fast` is delivered in order and never lost unless
 * `fastFilter` drops it; latency, jitter and loss belong to the netsim wrapper, not here.
 */

import { isValidRoomCode } from '../room-code';
import type {
  Channel,
  ClientTransport,
  ClientTransportHandlers,
  DisconnectReason,
  HostTransport,
  HostTransportHandlers,
  LinkId,
  TransportPayload,
  TransportState,
} from './transport';
import { NOOP_CLIENT_HANDLERS, NOOP_HOST_HANDLERS, transportError } from './transport';

export interface LoopbackOptions {
  /**
   * Reuse delivered `ArrayBuffer`s for later messages of the same size. Receivers must then
   * honour the transport rule strictly: the buffer is only valid during `onMessage`. Default
   * false (every message gets its own buffer, safe to keep).
   */
  readonly recycleBuffers?: boolean;
  /**
   * Called for each binary or string message sent on `fast`; return false to lose it (the
   * sender's `send` still returns true, as on a real network). `toHost` is the direction, `link`
   * the host-side link id.
   */
  readonly fastFilter?: (toHost: boolean, link: LinkId, byteLength: number) => boolean;
}

const KIND_HOST_OPEN = 0;
const KIND_CONNECT = 1;
const KIND_TO_HOST = 2;
const KIND_TO_CLIENT = 3;
const KIND_HOST_PEER_GONE = 4;
const KIND_CLIENT_CLOSED = 5;

/** Copies at or below this size use a plain loop (no temporary sub-view to allocate). */
const LOOP_COPY_MAX = 2048;
const POOL_MAX_PER_SIZE = 64;
const POOL_MAX_SIZES = 256;

/** One queued event. Pooled: fields are overwritten on reuse. */
interface Entry {
  kind: number;
  host: LoopbackHostTransport | null;
  client: LoopbackClientTransport | null;
  link: LinkId;
  /** The client's or host's session counter when the entry was queued (drops stale entries). */
  session: number;
  channel: Channel;
  text: string | null;
  bytes: Uint8Array<ArrayBuffer> | null;
  reason: DisconnectReason;
}

function createEntry(): Entry {
  return {
    kind: KIND_HOST_OPEN,
    host: null,
    client: null,
    link: 0,
    session: 0,
    channel: 'ctrl',
    text: null,
    bytes: null,
    reason: 'remote',
  };
}

export class LoopbackHub {
  private readonly recycle: boolean;
  private readonly fastFilter: LoopbackOptions['fastFilter'];
  private readonly rooms = new Map<string, LoopbackHostTransport>();
  private queue: Entry[] = [];
  private batch: Entry[] = [];
  private readonly freeEntries: Entry[] = [];
  private readonly freeBytes = new Map<number, Uint8Array<ArrayBuffer>[]>();
  /** Whole-buffer views of senders' buffers, so a reused send buffer costs no allocation. */
  private readonly sourceViews = new WeakMap<ArrayBufferLike, Uint8Array>();
  private pumping = false;

  constructor(options: LoopbackOptions = {}) {
    this.recycle = options.recycleBuffers ?? false;
    this.fastFilter = options.fastFilter;
  }

  createHost(): LoopbackHostTransport {
    return new LoopbackHostTransport(this);
  }

  createClient(): LoopbackClientTransport {
    return new LoopbackClientTransport(this);
  }

  /** Queued events not yet delivered. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Delivers everything queued before this call, in order. Returns how many entries were
   * processed (including ones dropped because their link had gone). A `pump()` from inside a
   * handler does nothing and returns 0.
   */
  pump(): number {
    if (this.pumping) return 0;
    this.pumping = true;
    const batch = this.queue;
    this.queue = this.batch;
    this.batch = batch;
    let index = 0;
    try {
      for (; index < batch.length; index++) {
        const entry = batch[index];
        if (entry === undefined) continue;
        this.deliver(entry);
        this.releaseEntry(entry);
      }
    } finally {
      if (index < batch.length) {
        // A handler threw: the entry that threw is dropped, the rest stay queued in order.
        const thrown = batch[index];
        if (thrown !== undefined) this.releaseEntry(thrown);
        this.queue = batch.slice(index + 1).concat(this.queue);
      }
      batch.length = 0;
      this.pumping = false;
    }
    return index;
  }

  /**
   * Pumps until the queue is empty or `maxRounds` pumps have run (two sides that answer each
   * other forever would otherwise never finish). Returns the number of processed entries.
   */
  flush(maxRounds = 64): number {
    let total = 0;
    for (let round = 0; round < maxRounds && this.queue.length > 0; round++) total += this.pump();
    return total;
  }

  // --- used by the two transports below ---------------------------------------------------------

  /** @internal */
  enqueueEvent(
    kind: number,
    host: LoopbackHostTransport | null,
    client: LoopbackClientTransport | null,
    link: LinkId,
    session: number,
    reason: DisconnectReason,
  ): void {
    const entry = this.freeEntries.pop() ?? createEntry();
    entry.kind = kind;
    entry.host = host;
    entry.client = client;
    entry.link = link;
    entry.session = session;
    entry.reason = reason;
    this.queue.push(entry);
  }

  /** @internal */
  enqueueMessage(
    kind: number,
    host: LoopbackHostTransport,
    client: LoopbackClientTransport,
    link: LinkId,
    session: number,
    channel: Channel,
    data: TransportPayload,
  ): void {
    if (channel === 'fast' && this.fastFilter !== undefined) {
      const size = typeof data === 'string' ? data.length : data.byteLength;
      if (!this.fastFilter(kind === KIND_TO_HOST, link, size)) return;
    }
    const entry = this.freeEntries.pop() ?? createEntry();
    entry.kind = kind;
    entry.host = host;
    entry.client = client;
    entry.link = link;
    entry.session = session;
    entry.channel = channel;
    if (typeof data === 'string') entry.text = data;
    else entry.bytes = this.copyIn(data);
    this.queue.push(entry);
  }

  /** @internal */
  roomHost(code: string): LoopbackHostTransport | undefined {
    return this.rooms.get(code);
  }

  /** @internal */
  releaseRoom(code: string, host: LoopbackHostTransport): void {
    if (this.rooms.get(code) === host) this.rooms.delete(code);
  }

  private deliver(entry: Entry): void {
    const host = entry.host;
    const client = entry.client;
    switch (entry.kind) {
      case KIND_HOST_OPEN:
        if (host !== null && host.session === entry.session) host.finishOpen(this.rooms);
        break;
      case KIND_CONNECT:
        if (client !== null && client.session === entry.session) client.finishConnect();
        break;
      case KIND_TO_HOST:
        if (host !== null && client !== null && host.owns(entry.link, client)) {
          host.handlers.onMessage(entry.link, entry.channel, entry.text ?? this.bufferOf(entry));
        }
        break;
      case KIND_TO_CLIENT:
        if (client !== null && client.state === 'open' && client.session === entry.session) {
          client.handlers.onMessage(entry.channel, entry.text ?? this.bufferOf(entry));
        }
        break;
      case KIND_HOST_PEER_GONE:
        if (host !== null && client !== null) host.peerGone(entry.link, client, entry.reason);
        break;
      case KIND_CLIENT_CLOSED:
        if (client !== null && client.session === entry.session) client.remoteClosed(entry.reason);
        break;
    }
  }

  private bufferOf(entry: Entry): ArrayBuffer {
    // A message entry always has text or bytes; the fallback only satisfies the type checker.
    return entry.bytes !== null ? entry.bytes.buffer : new ArrayBuffer(0);
  }

  private releaseEntry(entry: Entry): void {
    const bytes = entry.bytes;
    if (bytes !== null && this.recycle) {
      let bucket = this.freeBytes.get(bytes.length);
      if (bucket === undefined && this.freeBytes.size < POOL_MAX_SIZES) {
        bucket = [];
        this.freeBytes.set(bytes.length, bucket);
      }
      if (bucket !== undefined && bucket.length < POOL_MAX_PER_SIZE) bucket.push(bytes);
    }
    entry.host = null;
    entry.client = null;
    entry.text = null;
    entry.bytes = null;
    this.freeEntries.push(entry);
  }

  /** Copies the payload's bytes into a buffer of exactly that length (pooled when recycling). */
  private copyIn(data: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
    let source: Uint8Array;
    let offset = 0;
    if (data instanceof Uint8Array) {
      source = data;
    } else if (ArrayBuffer.isView(data)) {
      source = this.sourceView(data.buffer);
      offset = data.byteOffset;
    } else {
      source = this.sourceView(data);
    }
    const length = data.byteLength;
    const target = this.freeBytes.get(length)?.pop() ?? new Uint8Array(length);
    if (length <= LOOP_COPY_MAX) {
      for (let i = 0; i < length; i++) target[i] = source[offset + i] ?? 0;
    } else {
      target.set(source.subarray(offset, offset + length));
    }
    return target;
  }

  private sourceView(buffer: ArrayBufferLike): Uint8Array {
    let view = this.sourceViews.get(buffer);
    if (view === undefined) {
      view = new Uint8Array(buffer);
      this.sourceViews.set(buffer, view);
    }
    return view;
  }
}

export function createLoopbackHub(options?: LoopbackOptions): LoopbackHub {
  return new LoopbackHub(options);
}

export class LoopbackHostTransport implements HostTransport {
  state: TransportState = 'idle';
  roomCode = '';
  /** @internal */
  handlers: HostTransportHandlers = NOOP_HOST_HANDLERS;
  /** @internal Bumped by every `open` and by `dispose`, so stale queued events are ignored. */
  session = 0;
  private readonly links = new Map<LinkId, LoopbackClientTransport>();
  private nextLink: LinkId = 1;
  private disposed = false;

  constructor(private readonly hub: LoopbackHub) {}

  /** Number of connected links. */
  get linkCount(): number {
    return this.links.size;
  }

  setHandlers(handlers: HostTransportHandlers): void {
    this.handlers = handlers;
  }

  open(roomCode: string): void {
    if (this.disposed || this.state === 'opening' || this.state === 'open') return;
    this.roomCode = roomCode;
    this.state = 'opening';
    this.session++;
    this.hub.enqueueEvent(KIND_HOST_OPEN, this, null, 0, this.session, 'remote');
  }

  send(link: LinkId, channel: Channel, data: TransportPayload): boolean {
    const client = this.links.get(link);
    if (client === undefined || this.state !== 'open') return false;
    this.hub.enqueueMessage(KIND_TO_CLIENT, this, client, link, client.session, channel, data);
    return true;
  }

  close(link: LinkId): void {
    const client = this.links.get(link);
    if (client === undefined) return;
    this.links.delete(link);
    this.hub.enqueueEvent(KIND_CLIENT_CLOSED, this, client, link, client.session, 'remote');
    this.handlers.onPeerDisconnected(link, 'local');
  }

  /**
   * Test helper: the link dies underneath both ends, as when Wi-Fi drops. Both sides see `lost`
   * on the next pump.
   */
  sever(link: LinkId): void {
    const client = this.links.get(link);
    if (client === undefined) return;
    this.hub.enqueueEvent(KIND_CLIENT_CLOSED, this, client, link, client.session, 'lost');
    this.hub.enqueueEvent(KIND_HOST_PEER_GONE, this, client, link, this.session, 'lost');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session++;
    for (const [link, client] of this.links) {
      this.hub.enqueueEvent(KIND_CLIENT_CLOSED, this, client, link, client.session, 'remote');
    }
    this.links.clear();
    this.hub.releaseRoom(this.roomCode, this);
    this.state = 'closed';
    this.handlers = NOOP_HOST_HANDLERS;
  }

  /** @internal */
  finishOpen(rooms: Map<string, LoopbackHostTransport>): void {
    if (this.state !== 'opening') return;
    if (!isValidRoomCode(this.roomCode)) {
      this.state = 'closed';
      this.handlers.onError(
        transportError('invalidRoomCode', `"${this.roomCode}" is not a valid room code`),
      );
      return;
    }
    const owner = rooms.get(this.roomCode);
    if (owner !== undefined && owner !== this) {
      this.state = 'closed';
      this.handlers.onError(transportError('idTaken', `room ${this.roomCode} already has a host`));
      return;
    }
    rooms.set(this.roomCode, this);
    this.state = 'open';
    this.handlers.onOpen(this.roomCode);
  }

  /** @internal */
  accept(client: LoopbackClientTransport): LinkId {
    const link = this.nextLink++;
    this.links.set(link, client);
    return link;
  }

  /** @internal */
  owns(link: LinkId, client: LoopbackClientTransport): boolean {
    return this.state === 'open' && this.links.get(link) === client;
  }

  /** @internal */
  peerGone(link: LinkId, client: LoopbackClientTransport, reason: DisconnectReason): void {
    if (this.links.get(link) !== client) return;
    this.links.delete(link);
    this.handlers.onPeerDisconnected(link, reason);
  }
}

export class LoopbackClientTransport implements ClientTransport {
  state: TransportState = 'idle';
  /** @internal */
  handlers: ClientTransportHandlers = NOOP_CLIENT_HANDLERS;
  /** @internal Bumped whenever a link attempt starts or ends, so stale queued events are ignored. */
  session = 0;
  private host: LoopbackHostTransport | null = null;
  private link: LinkId = 0;
  private roomCode = '';
  private disposed = false;

  constructor(private readonly hub: LoopbackHub) {}

  setHandlers(handlers: ClientTransportHandlers): void {
    this.handlers = handlers;
  }

  connect(roomCode: string): void {
    if (this.disposed || this.state === 'opening' || this.state === 'open') return;
    this.roomCode = roomCode;
    this.state = 'opening';
    this.session++;
    this.hub.enqueueEvent(KIND_CONNECT, null, this, 0, this.session, 'remote');
  }

  send(channel: Channel, data: TransportPayload): boolean {
    const host = this.host;
    if (host === null || this.state !== 'open') return false;
    this.hub.enqueueMessage(KIND_TO_HOST, host, this, this.link, this.session, channel, data);
    return true;
  }

  close(): void {
    const wasOpen = this.state === 'open';
    this.detach('remote');
    if (this.state !== 'idle') this.state = 'closed';
    if (wasOpen) this.handlers.onClose('local');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach('remote');
    this.state = 'closed';
    this.handlers = NOOP_CLIENT_HANDLERS;
  }

  /** @internal */
  finishConnect(): void {
    if (this.state !== 'opening') return;
    if (!isValidRoomCode(this.roomCode)) {
      this.state = 'closed';
      this.handlers.onError(
        transportError('invalidRoomCode', `"${this.roomCode}" is not a valid room code`),
      );
      return;
    }
    const host = this.hub.roomHost(this.roomCode);
    if (host === undefined || host.state !== 'open') {
      this.state = 'closed';
      this.handlers.onError(transportError('roomNotFound', `no host for room ${this.roomCode}`));
      return;
    }
    this.host = host;
    this.link = host.accept(this);
    this.state = 'open';
    host.handlers.onPeerConnected(this.link);
    // The host may have closed the link from inside its handler; the client still sees the
    // open and then the close, as it would over a real connection.
    this.handlers.onOpen();
  }

  /** @internal */
  remoteClosed(reason: DisconnectReason): void {
    if (this.state !== 'open') return;
    this.session++;
    this.host = null;
    this.state = 'closed';
    this.handlers.onClose(reason);
  }

  /** Ends the current attempt or link and tells the host side (on the next pump). */
  private detach(reason: DisconnectReason): void {
    const host = this.host;
    if (host !== null && this.state === 'open') {
      this.hub.enqueueEvent(KIND_HOST_PEER_GONE, host, this, this.link, host.session, reason);
    }
    this.host = null;
    this.session++;
  }
}
