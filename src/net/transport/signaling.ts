/**
 * The pure half of the PeerJS transport: configuration (which signaling server, which ICE
 * servers) and the mapping from PeerJS error types to `TransportErrorReason`. Nothing here
 * imports PeerJS or touches the browser, so it is unit-tested in node.
 *
 * Findings of the Phase 2 spike that shaped this (PeerJS 1.5.5, Edge/Chromium, see
 * tools/net-spike):
 *
 * - `peer.connect(id, { reliable: false })` only sets `ordered: false`. `maxRetransmits` stays
 *   null, so that channel is still fully reliable (it retransmits forever) and is not what
 *   `fast` needs.
 * - Every `peer.connect()` builds its own `RTCPeerConnection`, so two PeerJS connections to the
 *   same peer mean two ICE/DTLS handshakes.
 * - Therefore a link is ONE PeerJS data connection (`ctrl`: label 'ctrl', serialization 'raw',
 *   reliable) plus a second data channel that both ends create themselves on
 *   `dataConnection.peerConnection` with `negotiated: true` and a fixed id (`fast`:
 *   `ordered: false, maxRetransmits: 0`). Negotiated, because an in-band channel would fire
 *   PeerJS's own `ondatachannel` handler, which would mistake it for the connection's channel.
 * - Serialization 'raw' hands `ArrayBuffer`s and strings straight to `RTCDataChannel.send` with
 *   `binaryType = 'arraybuffer'`: no BinaryPack or JSON framing.
 */

import { LAN_PEER_PATH, LAN_PEER_PORT } from '../../shared/constants';
import type { TransportErrorReason } from './transport';

/** Label of the PeerJS data connection that carries `ctrl`. */
export const CTRL_LABEL = 'ctrl';
export const FAST_LABEL = 'fast';
/**
 * SCTP stream id of the negotiated `fast` channel. PeerJS's own channel is allocated in-band and
 * gets 0 or 1 (depending on the DTLS role), so 2 never collides.
 */
export const FAST_CHANNEL_ID = 2;

/** Unreliable and unordered: a lost packet is never resent, a late one is not held back. */
export const FAST_CHANNEL_INIT: Readonly<RTCDataChannelInit> = Object.freeze({
  negotiated: true,
  id: FAST_CHANNEL_ID,
  ordered: false,
  maxRetransmits: 0,
});

/** Google's public STUN servers (docs/NETWORKING.md, "NAT traversal"). */
export const DEFAULT_STUN_URLS: readonly string[] = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
]);

export const DEFAULT_BROKER_TIMEOUT_MS = 10_000;
/** Longer than the PeerServer's 5 s "no such peer" expiry, so a wrong code reads as roomNotFound. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** 10 riders plus spectators and a few half-open joins. */
export const DEFAULT_MAX_LINKS = 24;
export const DEFAULT_MAX_INBOUND_BYTES = 16 * 1024;
/** About two seconds of snapshots: beyond this the link is stalled and newer data is worth more. */
export const DEFAULT_FAST_MAX_BUFFERED_BYTES = 16 * 1024;

export type SignalingConfig =
  /** PeerJS public cloud broker (`0.peerjs.com`, always over TLS). */
  | { readonly mode: 'cloud' }
  /**
   * Self-hosted PeerServer from `npm run peer:lan`. `host` is the machine running it, normally
   * the hostname the page was loaded from (the integrator passes it in; `src/net` does not read
   * the page URL). `secure` defaults to false: the LAN server speaks plain ws/http.
   */
  | {
      readonly mode: 'lan';
      readonly host: string;
      readonly port?: number;
      readonly path?: string;
      readonly secure?: boolean;
    };

export interface TurnConfig {
  readonly urls: string | readonly string[];
  readonly username: string;
  readonly credential: string;
}

export interface PeerTransportConfig {
  readonly signaling: SignalingConfig;
  /** Defaults to `DEFAULT_STUN_URLS` in cloud mode and to none in LAN mode (works offline). */
  readonly stunUrls?: readonly string[];
  /** Optional relay for networks that block peer-to-peer traffic. */
  readonly turn?: TurnConfig | null;
  /** Force all traffic through TURN (for testing a relay). */
  readonly relayOnly?: boolean;
  /** How long the signaling server may take to accept us. */
  readonly brokerTimeoutMs?: number;
  /** Client: total time for `connect`. Host: time a new link may take to open both channels. */
  readonly connectTimeoutMs?: number;
  /** Host: connections beyond this are refused before they cost anything. */
  readonly maxLinks?: number;
  /** Host: larger inbound messages are dropped unseen. */
  readonly maxInboundBytes?: number;
  /** `fast` sends are dropped while more than this is still waiting in the channel. */
  readonly fastMaxBufferedBytes?: number;
  /** PeerJS log level 0-3 (global to the page). */
  readonly debug?: number;
}

export function cloudSignaling(): SignalingConfig {
  return { mode: 'cloud' };
}

/** `pageHostname` is `location.hostname` of the page (e.g. the host laptop's LAN IP). */
export function lanSignaling(pageHostname: string): SignalingConfig {
  return { mode: 'lan', host: pageHostname };
}

export function buildIceServers(config: PeerTransportConfig): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  const stun = config.stunUrls ?? (config.signaling.mode === 'cloud' ? DEFAULT_STUN_URLS : []);
  if (stun.length > 0) servers.push({ urls: [...stun] });
  const turn = config.turn;
  if (turn !== undefined && turn !== null) {
    servers.push({
      urls: typeof turn.urls === 'string' ? turn.urls : [...turn.urls],
      username: turn.username,
      credential: turn.credential,
    });
  }
  return servers;
}

/** The subset of PeerJS's `PeerOptions` we set. Structurally assignable to it. */
export interface PeerOptionsShape {
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  debug: number;
  config: RTCConfiguration;
}

export function buildPeerOptions(config: PeerTransportConfig): PeerOptionsShape {
  const rtc: RTCConfiguration = { iceServers: buildIceServers(config) };
  if (config.relayOnly === true) rtc.iceTransportPolicy = 'relay';
  const options: PeerOptionsShape = { debug: config.debug ?? 0, config: rtc };
  const signaling = config.signaling;
  if (signaling.mode === 'lan') {
    // Always explicit: PeerJS would otherwise copy `secure` from the page protocol, and the LAN
    // PeerServer has no TLS.
    options.host = signaling.host;
    options.port = signaling.port ?? LAN_PEER_PORT;
    options.path = signaling.path ?? LAN_PEER_PATH;
    options.secure = signaling.secure ?? false;
  }
  // Cloud: PeerJS's defaults (0.peerjs.com:443, secure) apply.
  return options;
}

export type TransportRole = 'host' | 'client';

/**
 * Maps `PeerError.type` (from the `Peer` or from a `DataConnection`) to our reasons.
 *
 * PeerJS values, checked against 1.5.5: browser-incompatible, disconnected, invalid-id,
 * invalid-key, network, peer-unavailable, ssl-unavailable, server-error, socket-error,
 * socket-closed, unavailable-id, webrtc (Peer); negotiation-failed, connection-closed,
 * not-open-yet, message-too-big (DataConnection).
 */
export function mapPeerErrorType(type: string, role: TransportRole): TransportErrorReason {
  switch (type) {
    case 'peer-unavailable':
      // For a client the only peer it ever dials is the room's host. On the host it means a
      // joining client vanished mid-handshake.
      return role === 'client' ? 'roomNotFound' : 'peerUnavailable';
    case 'unavailable-id':
      return 'idTaken';
    case 'invalid-id':
      return 'invalidRoomCode';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'ssl-unavailable':
    case 'disconnected':
      return 'brokerUnreachable';
    case 'webrtc':
    case 'negotiation-failed':
    case 'connection-closed':
      return 'peerUnavailable';
    case 'browser-incompatible':
      return 'unsupported';
    default:
      return 'unknown';
  }
}
