/**
 * The worker's end of the room's real transport. WebRTC data channels cannot leave the page's
 * main thread, so inside the worker the `HostSession` talks to this `HostTransport` instead:
 * what it sends becomes records in the worker's outgoing batch, and what the page forwards
 * (packets, links opening and closing, the room being registered) is delivered through the
 * usual handlers. The session cannot tell it from a transport that owns its sockets.
 */

import type {
  Channel,
  DisconnectReason,
  HostTransport,
  HostTransportHandlers,
  LinkId,
  TransportError,
  TransportPayload,
  TransportState,
} from '../transport';
import { NOOP_HOST_HANDLERS } from '../transport';
import { AUX_CTRL, AUX_FAST, REC_CLOSE, REC_PACKET } from './batch';
import type { BatchWriter } from './batch';

export interface PortTransportCommands {
  /** Ask the page to register the room. */
  open(roomCode: string): void;
  /** The session is done with the transport. */
  dispose(): void;
}

export class PortHostTransport implements HostTransport {
  private handlers: HostTransportHandlers = NOOP_HOST_HANDLERS;
  private current: TransportState = 'idle';
  private code = '';
  private disposed = false;
  private readonly links = new Set<LinkId>();
  /** Whole-buffer views of the senders' buffers, so a reused send buffer allocates once. */
  private readonly sourceViews = new WeakMap<ArrayBuffer, Uint8Array>();

  constructor(
    private readonly writer: BatchWriter,
    private readonly commands: PortTransportCommands,
  ) {}

  get state(): TransportState {
    return this.current;
  }

  get roomCode(): string {
    return this.code;
  }

  get linkCount(): number {
    return this.links.size;
  }

  setHandlers(handlers: HostTransportHandlers): void {
    if (!this.disposed) this.handlers = handlers;
  }

  open(roomCode: string): void {
    if (this.disposed || (this.current !== 'idle' && this.current !== 'closed')) return;
    this.current = 'opening';
    this.code = roomCode;
    this.commands.open(roomCode);
  }

  send(link: LinkId, channel: Channel, data: TransportPayload): boolean {
    if (this.current !== 'open' || !this.links.has(link) || typeof data === 'string') return false;
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      let view = this.sourceViews.get(data);
      if (view === undefined) {
        view = new Uint8Array(data);
        this.sourceViews.set(data, view);
      }
      bytes = view;
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return this.writer.copy(REC_PACKET, channel === 'fast' ? AUX_FAST : AUX_CTRL, link, bytes);
  }

  close(link: LinkId): void {
    if (!this.links.delete(link)) return;
    this.writer.mark(REC_CLOSE, 0, link);
    // The transport rule: closing a link yourself reports back before returning.
    this.handlers.onPeerDisconnected(link, 'local');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handlers = NOOP_HOST_HANDLERS;
    this.links.clear();
    this.current = 'closed';
    this.commands.dispose();
  }

  // --- What the page forwards ------------------------------------------------------------------

  emitOpen(roomCode: string): void {
    if (this.disposed) return;
    this.current = 'open';
    this.code = roomCode;
    this.handlers.onOpen(roomCode);
  }

  emitError(error: TransportError): void {
    if (this.disposed) return;
    if (error.fatal) {
      this.current = 'closed';
      this.links.clear();
    }
    this.handlers.onError(error);
  }

  peerOpen(link: LinkId): void {
    if (this.disposed || this.links.has(link)) return;
    this.links.add(link);
    this.handlers.onPeerConnected(link);
  }

  peerGone(link: LinkId, reason: DisconnectReason): void {
    // Already gone when the worker closed it itself: the page's echo is ignored.
    if (!this.links.delete(link)) return;
    this.handlers.onPeerDisconnected(link, reason);
  }

  deliver(link: LinkId, channel: Channel, data: ArrayBuffer | string): void {
    if (this.links.has(link)) this.handlers.onMessage(link, channel, data);
  }
}
