/**
 * The transport seam of `src/net` (docs/NETWORKING.md, "Channels"). Sessions, the codec and the
 * net-bots code against these interfaces only; the implementations are
 *
 * - `loopback.ts`: in-process, manually pumped (vitest, `?bots=N`),
 * - `peerjs.ts`: WebRTC data channels with PeerJS signaling (real play).
 *
 * Star topology: one `HostTransport` accepts many links, a `ClientTransport` owns exactly one.
 * Every link has two logical channels:
 *
 * - `ctrl`: reliable and ordered. Binary or string (JSON) messages.
 * - `fast`: unreliable and unordered (`maxRetransmits: 0`). Messages may be lost, duplicated
 *   never, reordered sometimes. Keep them under `FAST_MAX_BYTES` so they fit one packet.
 *
 * Rules shared by every implementation:
 *
 * - Handlers are registered once with `setHandlers` (one object, no per-message closures or
 *   event objects). Until then events go to no-op handlers.
 * - `send` never keeps a reference to the caller's buffer: it is copied or handed to the browser
 *   before `send` returns, so the caller can reuse it immediately.
 * - A received `ArrayBuffer` is only guaranteed valid during the `onMessage` call. Decode or
 *   copy it before returning (the loopback can recycle delivered buffers, see its options).
 * - `send` returns false instead of throwing when the message cannot be sent (link not open,
 *   or a congested `fast` channel dropping on purpose).
 * - Closing something yourself reports back synchronously: `HostTransport.close(link)` calls
 *   `onPeerDisconnected(link, 'local')` and `ClientTransport.close()` calls `onClose('local')`
 *   before returning (only if that link was open). `dispose()` is silent.
 * - The transport moves bytes. It does not know players, protocol versions or message types;
 *   the host session validates everything that arrives.
 */

export type Channel = 'ctrl' | 'fast';

/**
 * Host-side handle of one client link: a small positive integer, unique for the lifetime of the
 * `HostTransport` (never reused), so it can index arrays or key a `Map` without hashing strings.
 * It is not a `PlayerId`; the host session maps links to players after the `hello` handshake.
 */
export type LinkId = number;

/** What `send` accepts. A view sends exactly its own bytes, not its whole underlying buffer. */
export type TransportPayload = ArrayBuffer | ArrayBufferView | string;

/** What `onMessage` delivers: binary as an `ArrayBuffer` of the exact message length. */
export type TransportMessage = ArrayBuffer | string;

/** `idle` -> `opening` -> `open` -> `closed`. A closed client may `connect` again. */
export type TransportState = 'idle' | 'opening' | 'open' | 'closed';

/**
 * Advice for `fast` messages: stay below one typical path MTU after SCTP/DTLS/UDP overhead so a
 * lost packet costs one message, not a fragmented group. A 5v5 snapshot is about 360 bytes.
 */
export const FAST_MAX_BYTES = 1100;

/**
 * Why opening or connecting failed, or what went wrong later.
 *
 * - `roomNotFound`: the signaling server knows no host for that room code (client).
 * - `idTaken`: another host already registered this room code (host; pick a new code).
 * - `brokerUnreachable`: the signaling server cannot be reached or dropped us.
 * - `peerUnavailable`: signaling worked but no direct link could be established (firewall,
 *   Wi-Fi client isolation, no TURN), or the link broke while it was still being set up.
 * - `timeout`: nothing conclusive happened within the configured time.
 * - `invalidRoomCode`: the code is not 5 characters of the room alphabet; nothing was sent.
 * - `unsupported`: this browser has no WebRTC data channels.
 * - `unknown`: anything else; see `message`.
 */
export type TransportErrorReason =
  | 'roomNotFound'
  | 'idTaken'
  | 'brokerUnreachable'
  | 'peerUnavailable'
  | 'timeout'
  | 'invalidRoomCode'
  | 'unsupported'
  | 'unknown';

export interface TransportError {
  readonly reason: TransportErrorReason;
  /** Developer-facing detail for logs. UI text is chosen from `reason`. */
  readonly message: string;
  /**
   * True when the transport is now `closed`. False for conditions it survives, e.g. a host that
   * loses the signaling server mid-match keeps its existing links and only stops accepting
   * new ones until it reconnects.
   */
  readonly fatal: boolean;
}

/**
 * Why an open link ended. `local`: this side closed it. `remote`: the other side closed it or
 * went away cleanly. `lost`: the connection failed underneath (best effort: WebRTC cannot always
 * tell a crashed tab from a closed one, so treat `remote` and `lost` alike for slot handling).
 */
export type DisconnectReason = 'local' | 'remote' | 'lost';

export interface HostTransportHandlers {
  /** The room is registered and clients can connect. */
  onOpen(roomCode: string): void;
  onError(error: TransportError): void;
  /** Both channels of a new link are open. */
  onPeerConnected(link: LinkId): void;
  /** Fires exactly once per connected link. The id is dead afterwards. */
  onPeerDisconnected(link: LinkId, reason: DisconnectReason): void;
  onMessage(link: LinkId, channel: Channel, data: TransportMessage): void;
}

export interface HostTransport {
  readonly state: TransportState;
  /** The room code passed to `open`, or '' before that. */
  readonly roomCode: string;
  setHandlers(handlers: HostTransportHandlers): void;
  /**
   * Registers the room. Answers with `onOpen` or a fatal `onError`. Allowed from `idle` or
   * `closed` (e.g. retry with a new code after `idTaken`), not after `dispose`.
   */
  open(roomCode: string): void;
  send(link: LinkId, channel: Channel, data: TransportPayload): boolean;
  /** Drops one client (kick, handshake rejected, ping timeout). Unknown ids are ignored. */
  close(link: LinkId): void;
  /** Closes every link and the room, and releases all resources. Final and silent. */
  dispose(): void;
}

export interface ClientTransportHandlers {
  /** Both channels to the host are open. */
  onOpen(): void;
  /** An open link ended. Not called when connecting failed (that is `onError`). */
  onClose(reason: DisconnectReason): void;
  onError(error: TransportError): void;
  onMessage(channel: Channel, data: TransportMessage): void;
}

export interface ClientTransport {
  readonly state: TransportState;
  setHandlers(handlers: ClientTransportHandlers): void;
  /**
   * Connects to the host of `roomCode`. Answers with `onOpen` or a fatal `onError`. Allowed
   * from `idle` or `closed` (reconnect), not after `dispose`.
   */
  connect(roomCode: string): void;
  send(channel: Channel, data: TransportPayload): boolean;
  /** Leaves the room. The transport can `connect` again afterwards. */
  close(): void;
  /** Like `close`, but final and silent. */
  dispose(): void;
}

function noop(): void {}

/** Spread these to implement only the handlers you need: `{ ...NOOP_HOST_HANDLERS, onMessage }`. */
export const NOOP_HOST_HANDLERS: HostTransportHandlers = Object.freeze({
  onOpen: noop,
  onError: noop,
  onPeerConnected: noop,
  onPeerDisconnected: noop,
  onMessage: noop,
});

export const NOOP_CLIENT_HANDLERS: ClientTransportHandlers = Object.freeze({
  onOpen: noop,
  onClose: noop,
  onError: noop,
  onMessage: noop,
});

export function transportError(
  reason: TransportErrorReason,
  message: string,
  fatal = true,
): TransportError {
  return { reason, message, fatal };
}
