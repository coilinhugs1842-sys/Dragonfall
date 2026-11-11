/**
 * Two host transports behind one `HostTransport`, so a `HostSession` (which takes exactly one)
 * can serve real players and in-page net-bots at the same time: `?bots=N` puts the bots on a
 * loopback hub while humans arrive over WebRTC.
 *
 * - The PRIMARY transport is the room: its state, its room code, its `onOpen` and its errors are
 *   the composite's. The SECONDARY is opened with the same code once the primary is open, and a
 *   failure of it is reported as non-fatal (the room itself is fine).
 * - Link ids of the two are folded into one space without a table: `inner * 2` for the primary,
 *   `inner * 2 + 1` for the secondary. Inner ids are ascending and never reused, so the folded
 *   ids are too. Nothing is allocated per message.
 */

import type {
  Channel,
  DisconnectReason,
  HostTransport,
  HostTransportHandlers,
  LinkId,
  TransportError,
  TransportMessage,
  TransportPayload,
  TransportState,
} from './transport';
import { NOOP_HOST_HANDLERS, transportError } from './transport';

export class CompositeHostTransport implements HostTransport {
  private handlers: HostTransportHandlers = NOOP_HOST_HANDLERS;
  private disposed = false;

  constructor(
    readonly primary: HostTransport,
    readonly secondary: HostTransport,
  ) {
    primary.setHandlers({
      onOpen: (roomCode: string): void => {
        // `closed` too: a room re-opened under a new code (after `idTaken`) re-opens here.
        if (this.secondary.state === 'idle' || this.secondary.state === 'closed') {
          this.secondary.open(roomCode);
        }
        this.handlers.onOpen(roomCode);
      },
      onError: (error: TransportError): void => {
        this.handlers.onError(error);
      },
      onPeerConnected: (link: LinkId): void => {
        this.handlers.onPeerConnected(link * 2);
      },
      onPeerDisconnected: (link: LinkId, reason: DisconnectReason): void => {
        this.handlers.onPeerDisconnected(link * 2, reason);
      },
      onMessage: (link: LinkId, channel: Channel, data: TransportMessage): void => {
        this.handlers.onMessage(link * 2, channel, data);
      },
    });
    secondary.setHandlers({
      onOpen: (): void => {},
      onError: (error: TransportError): void => {
        this.handlers.onError(
          error.fatal ? transportError(error.reason, error.message, false) : error,
        );
      },
      onPeerConnected: (link: LinkId): void => {
        this.handlers.onPeerConnected(link * 2 + 1);
      },
      onPeerDisconnected: (link: LinkId, reason: DisconnectReason): void => {
        this.handlers.onPeerDisconnected(link * 2 + 1, reason);
      },
      onMessage: (link: LinkId, channel: Channel, data: TransportMessage): void => {
        this.handlers.onMessage(link * 2 + 1, channel, data);
      },
    });
  }

  get state(): TransportState {
    return this.primary.state;
  }

  get roomCode(): string {
    return this.primary.roomCode;
  }

  setHandlers(handlers: HostTransportHandlers): void {
    if (!this.disposed) this.handlers = handlers;
  }

  open(roomCode: string): void {
    if (this.disposed) return;
    this.primary.open(roomCode);
  }

  send(link: LinkId, channel: Channel, data: TransportPayload): boolean {
    // `>> 1` and `& 1`: ids stay far below 2^31.
    return (link & 1) === 0
      ? this.primary.send(link >> 1, channel, data)
      : this.secondary.send(link >> 1, channel, data);
  }

  close(link: LinkId): void {
    if ((link & 1) === 0) this.primary.close(link >> 1);
    else this.secondary.close(link >> 1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handlers = NOOP_HOST_HANDLERS;
    this.primary.dispose();
    this.secondary.dispose();
  }
}

export function createCompositeHostTransport(
  primary: HostTransport,
  secondary: HostTransport,
): HostTransport {
  return new CompositeHostTransport(primary, secondary);
}
