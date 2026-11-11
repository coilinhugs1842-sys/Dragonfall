/**
 * The real transport: WebRTC data channels, introduced by a PeerJS signaling server (public
 * cloud or the LAN PeerServer from `npm run peer:lan`). See `signaling.ts` for the configuration
 * and for why a link is built the way it is:
 *
 * - `ctrl` = one PeerJS data connection (label 'ctrl', serialization 'raw', reliable + ordered).
 * - `fast` = a second data channel on the same `RTCPeerConnection`, created by both ends with
 *   `negotiated: true, id: 2, ordered: false, maxRetransmits: 0`.
 *
 * This is the only file that imports the PeerJS runtime; it needs a browser (WebRTC). Per-link
 * closures are created once when a link is set up; nothing is allocated per message here (the
 * browser itself allocates the `ArrayBuffer` of each received message).
 *
 * Not handled here, on purpose:
 * - A peer that vanishes without closing (crashed tab, Wi-Fi off) is only noticed when ICE
 *   gives up, which can take 15-30 s. The session's 2 Hz ping should call `close(link)` sooner.
 * - Page unload: the integrator should call `dispose()` on `pagehide` so the other side sees a
 *   clean close immediately.
 */

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import { isValidRoomCode, roomCodeToPeerId } from '../room-code';
import type { PeerTransportConfig } from './signaling';
import {
  CTRL_LABEL,
  DEFAULT_BROKER_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_FAST_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_INBOUND_BYTES,
  DEFAULT_MAX_LINKS,
  FAST_CHANNEL_INIT,
  FAST_LABEL,
  buildPeerOptions,
  mapPeerErrorType,
} from './signaling';
import type {
  Channel,
  ClientTransport,
  ClientTransportHandlers,
  DisconnectReason,
  HostTransport,
  HostTransportHandlers,
  LinkId,
  TransportErrorReason,
  TransportPayload,
  TransportState,
} from './transport';
import { NOOP_CLIENT_HANDLERS, NOOP_HOST_HANDLERS, transportError } from './transport';

type Timer = ReturnType<typeof setTimeout>;

const RAW_SERIALIZATION = 'raw';
const BROKER_RETRY_MS = 3000;

/** PeerJS errors carry a `type`; anything else thrown at us is treated as unknown. */
function errorType(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'type' in error) {
    const type = (error as { type: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Byte length of a received message, or -1 when it is not a kind we accept. */
function inboundSize(data: unknown): number {
  if (typeof data === 'string') return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return -1;
}

function channelSend(channel: RTCDataChannel, data: TransportPayload): void {
  if (typeof data === 'string') channel.send(data);
  else if (data instanceof ArrayBuffer) channel.send(data);
  // The DOM typings only accept views over a plain ArrayBuffer; a view over a SharedArrayBuffer
  // would throw at runtime and is caught by the callers, so the cast only narrows the type.
  else channel.send(data as ArrayBufferView<ArrayBuffer>);
}

/** Sends on `fast`, dropping instead of queueing when the channel is backed up. */
function sendFast(channel: RTCDataChannel, data: TransportPayload, maxBuffered: number): boolean {
  if (channel.readyState !== 'open' || channel.bufferedAmount > maxBuffered) return false;
  try {
    channelSend(channel, data);
    return true;
  } catch {
    return false;
  }
}

function openFastChannel(conn: DataConnection): RTCDataChannel {
  const channel = conn.peerConnection.createDataChannel(FAST_LABEL, FAST_CHANNEL_INIT);
  channel.binaryType = 'arraybuffer';
  return channel;
}

function releaseChannel(channel: RTCDataChannel | null): void {
  if (channel === null) return;
  channel.onopen = null;
  channel.onmessage = null;
  channel.onclose = null;
  try {
    channel.close();
  } catch {
    // Already closed with its peer connection.
  }
}

interface HostLink {
  readonly id: LinkId;
  readonly conn: DataConnection;
  fast: RTCDataChannel | null;
  /** Both channels open and `onPeerConnected` delivered. */
  announced: boolean;
  closed: boolean;
  /** ICE reported trouble, so a following close counts as `lost`. */
  lost: boolean;
  setupTimer: Timer | null;
}

export class PeerJsHostTransport implements HostTransport {
  state: TransportState = 'idle';
  roomCode = '';
  /** Inbound messages dropped for being oversized or of an unexpected kind. */
  droppedInbound = 0;
  private handlers: HostTransportHandlers = NOOP_HOST_HANDLERS;
  private readonly links = new Map<LinkId, HostLink>();
  private nextLink: LinkId = 1;
  private peer: Peer | null = null;
  private brokerTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private disposed = false;
  private readonly connectTimeoutMs: number;
  private readonly brokerTimeoutMs: number;
  private readonly maxLinks: number;
  private readonly maxInboundBytes: number;
  private readonly fastMaxBuffered: number;

  constructor(private readonly config: PeerTransportConfig) {
    this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.brokerTimeoutMs = config.brokerTimeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
    this.maxLinks = config.maxLinks ?? DEFAULT_MAX_LINKS;
    this.maxInboundBytes = config.maxInboundBytes ?? DEFAULT_MAX_INBOUND_BYTES;
    this.fastMaxBuffered = config.fastMaxBufferedBytes ?? DEFAULT_FAST_MAX_BUFFERED_BYTES;
  }

  /** Links that exist, including ones still opening. */
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
    if (!isValidRoomCode(roomCode)) {
      queueMicrotask(() => {
        if (this.state === 'opening' && this.peer === null) {
          this.fail('invalidRoomCode', `"${roomCode}" is not a valid room code`);
        }
      });
      return;
    }
    const peer = new Peer(roomCodeToPeerId(roomCode), buildPeerOptions(this.config));
    this.peer = peer;
    this.brokerTimer = setTimeout(() => {
      this.brokerTimer = null;
      if (this.peer === peer && this.state === 'opening') {
        this.fail('brokerUnreachable', 'the signaling server did not answer in time');
      }
    }, this.brokerTimeoutMs);

    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.clearBrokerTimer();
      if (this.state === 'opening') {
        this.state = 'open';
        this.handlers.onOpen(roomCode);
      }
    });
    peer.on('connection', (conn) => {
      if (this.peer === peer && this.state === 'open') this.accept(conn);
      else conn.close();
    });
    peer.on('disconnected', () => {
      // Lost the signaling server after opening: existing links are untouched; keep trying to
      // get the room id back so late joiners and reconnects still work.
      if (this.peer === peer && this.state === 'open') this.scheduleBrokerRetry(peer);
    });
    peer.on('error', (error) => {
      if (this.peer !== peer) return;
      const reason = mapPeerErrorType(errorType(error), 'host');
      if (this.state === 'opening') this.fail(reason, errorText(error));
      else if (this.state === 'open') {
        this.handlers.onError(transportError(reason, errorText(error), false));
      }
    });
  }

  send(link: LinkId, channel: Channel, data: TransportPayload): boolean {
    const entry = this.links.get(link);
    if (entry === undefined || !entry.announced) return false;
    if (channel === 'fast') {
      return entry.fast !== null && sendFast(entry.fast, data, this.fastMaxBuffered);
    }
    if (!entry.conn.open) return false;
    // Raw serialization: PeerJS passes this straight to RTCDataChannel.send (and queues it
    // itself in the rare case the reliable channel is backed up).
    void entry.conn.send(data);
    return true;
  }

  close(link: LinkId): void {
    const entry = this.links.get(link);
    if (entry !== undefined) this.finishLink(entry, 'local');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handlers = NOOP_HOST_HANDLERS;
    this.shutdown();
  }

  private accept(conn: DataConnection): void {
    // Only links shaped like ours get in; anything else is refused before it costs anything.
    if (
      conn.label !== CTRL_LABEL ||
      conn.serialization !== RAW_SERIALIZATION ||
      !conn.reliable ||
      this.links.size >= this.maxLinks
    ) {
      conn.close();
      return;
    }
    const entry: HostLink = {
      id: this.nextLink++,
      conn,
      fast: null,
      announced: false,
      closed: false,
      lost: false,
      setupTimer: null,
    };
    this.links.set(entry.id, entry);
    try {
      entry.fast = openFastChannel(conn);
    } catch {
      this.finishLink(entry, 'lost');
      return;
    }
    const fast = entry.fast;
    const announceWhenReady = (): void => {
      if (entry.closed || entry.announced) return;
      if (!conn.open || fast.readyState !== 'open') return;
      entry.announced = true;
      this.clearSetupTimer(entry);
      this.handlers.onPeerConnected(entry.id);
    };
    entry.setupTimer = setTimeout(() => {
      entry.setupTimer = null;
      if (!entry.announced) this.finishLink(entry, 'lost');
    }, this.connectTimeoutMs);

    conn.on('open', announceWhenReady);
    conn.on('data', (data) => this.receive(entry, 'ctrl', data));
    conn.on('close', () => this.finishLink(entry, entry.lost ? 'lost' : 'remote'));
    conn.on('error', () => {
      entry.lost = true;
    });
    conn.on('iceStateChanged', (state) => {
      entry.lost = state === 'disconnected' || state === 'failed';
    });
    fast.onopen = announceWhenReady;
    fast.onmessage = (event) => this.receive(entry, 'fast', event.data);
    fast.onclose = () => this.finishLink(entry, entry.lost ? 'lost' : 'remote');
  }

  private receive(entry: HostLink, channel: Channel, data: unknown): void {
    if (!entry.announced || entry.closed) return;
    const size = inboundSize(data);
    if (size < 0 || size > this.maxInboundBytes) {
      this.droppedInbound++;
      return;
    }
    this.handlers.onMessage(entry.id, channel, data as ArrayBuffer | string);
  }

  private finishLink(entry: HostLink, reason: DisconnectReason): void {
    if (entry.closed) return;
    entry.closed = true;
    this.clearSetupTimer(entry);
    this.links.delete(entry.id);
    releaseChannel(entry.fast);
    entry.fast = null;
    entry.conn.close();
    if (entry.announced) this.handlers.onPeerDisconnected(entry.id, reason);
  }

  private clearSetupTimer(entry: HostLink): void {
    if (entry.setupTimer !== null) {
      clearTimeout(entry.setupTimer);
      entry.setupTimer = null;
    }
  }

  private clearBrokerTimer(): void {
    if (this.brokerTimer !== null) {
      clearTimeout(this.brokerTimer);
      this.brokerTimer = null;
    }
  }

  private scheduleBrokerRetry(peer: Peer): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.peer !== peer || this.state !== 'open' || peer.destroyed) return;
      if (peer.disconnected) {
        try {
          peer.reconnect();
        } catch {
          // Not reconnectable right now; the next 'disconnected' or retry tries again.
        }
        // If this attempt fails, PeerJS emits 'disconnected' again and we come back here.
      }
    }, BROKER_RETRY_MS);
  }

  private fail(reason: TransportErrorReason, message: string): void {
    const handlers = this.handlers;
    this.shutdown();
    handlers.onError(transportError(reason, message, true));
  }

  /** Closes every link silently, releases the room id and ends in `closed`. */
  private shutdown(): void {
    this.clearBrokerTimer();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const peer = this.peer;
    this.peer = null;
    this.state = 'closed';
    for (const entry of [...this.links.values()]) {
      entry.announced = false; // silent
      this.finishLink(entry, 'local');
    }
    if (peer !== null) peer.destroy();
  }
}

export class PeerJsClientTransport implements ClientTransport {
  state: TransportState = 'idle';
  private handlers: ClientTransportHandlers = NOOP_CLIENT_HANDLERS;
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private fast: RTCDataChannel | null = null;
  private timer: Timer | null = null;
  private lost = false;
  private disposed = false;
  private readonly connectTimeoutMs: number;
  private readonly fastMaxBuffered: number;

  constructor(private readonly config: PeerTransportConfig) {
    this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.fastMaxBuffered = config.fastMaxBufferedBytes ?? DEFAULT_FAST_MAX_BUFFERED_BYTES;
  }

  setHandlers(handlers: ClientTransportHandlers): void {
    this.handlers = handlers;
  }

  connect(roomCode: string): void {
    if (this.disposed || this.state === 'opening' || this.state === 'open') return;
    this.state = 'opening';
    this.lost = false;
    if (!isValidRoomCode(roomCode)) {
      queueMicrotask(() => {
        if (this.state === 'opening' && this.peer === null) {
          this.fail('invalidRoomCode', `"${roomCode}" is not a valid room code`);
        }
      });
      return;
    }
    // No id: the signaling server assigns one. Every event below is ignored once `this.peer`
    // has moved on (close, failure or a newer connect).
    const peer = new Peer(buildPeerOptions(this.config));
    this.peer = peer;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.peer !== peer || this.state !== 'opening') return;
      // No answer from the server at all is a signaling problem; anything later is the link.
      if (peer.open) this.fail('timeout', 'connecting to the host timed out');
      else this.fail('brokerUnreachable', 'the signaling server did not answer in time');
    }, this.connectTimeoutMs);

    peer.on('error', (error) => {
      // Once the link is open the signaling server no longer matters to a client.
      if (this.peer === peer && this.state === 'opening') {
        this.fail(mapPeerErrorType(errorType(error), 'client'), errorText(error));
      }
    });
    peer.on('open', () => {
      if (this.peer !== peer || this.state !== 'opening') return;
      const conn = peer.connect(roomCodeToPeerId(roomCode), {
        label: CTRL_LABEL,
        reliable: true,
        serialization: RAW_SERIALIZATION,
      });
      this.conn = conn;
      let fast: RTCDataChannel;
      try {
        fast = openFastChannel(conn);
      } catch (error) {
        this.fail('peerUnavailable', errorText(error));
        return;
      }
      this.fast = fast;
      const openWhenReady = (): void => {
        if (this.conn !== conn || this.state !== 'opening') return;
        if (!conn.open || fast.readyState !== 'open') return;
        this.clearTimer();
        this.state = 'open';
        this.handlers.onOpen();
      };
      const ended = (): void => {
        if (this.conn !== conn) return;
        if (this.state === 'open') {
          const reason: DisconnectReason = this.lost ? 'lost' : 'remote';
          this.teardown();
          this.handlers.onClose(reason);
        } else if (this.state === 'opening') {
          this.fail('peerUnavailable', 'the link to the host closed while connecting');
        }
      };
      conn.on('open', openWhenReady);
      conn.on('data', (data) => {
        if (this.conn === conn && this.state === 'open' && inboundSize(data) >= 0) {
          this.handlers.onMessage('ctrl', data as ArrayBuffer | string);
        }
      });
      conn.on('close', ended);
      conn.on('error', (error) => {
        if (this.conn !== conn) return;
        this.lost = true;
        if (this.state === 'opening') {
          this.fail(mapPeerErrorType(errorType(error), 'client'), errorText(error));
        }
      });
      conn.on('iceStateChanged', (state) => {
        if (this.conn === conn) this.lost = state === 'disconnected' || state === 'failed';
      });
      fast.onopen = openWhenReady;
      fast.onmessage = (event) => {
        const data: unknown = event.data;
        if (this.conn === conn && this.state === 'open' && inboundSize(data) >= 0) {
          this.handlers.onMessage('fast', data as ArrayBuffer | string);
        }
      };
      fast.onclose = ended;
    });
  }

  send(channel: Channel, data: TransportPayload): boolean {
    if (this.state !== 'open') return false;
    if (channel === 'fast') {
      return this.fast !== null && sendFast(this.fast, data, this.fastMaxBuffered);
    }
    const conn = this.conn;
    if (conn === null || !conn.open) return false;
    void conn.send(data);
    return true;
  }

  close(): void {
    const wasOpen = this.state === 'open';
    const wasIdle = this.state === 'idle';
    this.teardown();
    if (wasIdle) this.state = 'idle';
    if (wasOpen) this.handlers.onClose('local');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handlers = NOOP_CLIENT_HANDLERS;
    this.teardown();
  }

  private fail(reason: TransportErrorReason, message: string): void {
    this.teardown();
    this.handlers.onError(transportError(reason, message, true));
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Drops the link and the signaling connection without telling anyone. Ends in `closed`. */
  private teardown(): void {
    this.clearTimer();
    const peer = this.peer;
    const conn = this.conn;
    const fast = this.fast;
    this.peer = null;
    this.conn = null;
    this.fast = null;
    this.state = 'closed';
    releaseChannel(fast);
    if (conn !== null) conn.close();
    if (peer !== null) peer.destroy();
  }
}

export function createPeerJsHostTransport(config: PeerTransportConfig): HostTransport {
  return new PeerJsHostTransport(config);
}

export function createPeerJsClientTransport(config: PeerTransportConfig): ClientTransport {
  return new PeerJsClientTransport(config);
}
