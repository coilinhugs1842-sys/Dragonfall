/**
 * Small pieces both sessions share: the DataView cache for received buffers, reconnect-token
 * generation, the injected token store and the RTT a client reports in its pings.
 */

import { reconnectTokenFromBytes } from '../codec/ctrl';
import type { RandomSource } from '../room-code';

/**
 * A `DataView` for a received `ArrayBuffer`.
 *
 * A transport that recycles its delivery buffers (the loopback with `recycleBuffers`, netsim)
 * hands the same few `ArrayBuffer` objects over and over; with `cache` on, each gets one
 * `DataView` for life and receiving allocates nothing. A real WebRTC transport delivers a fresh
 * `ArrayBuffer` per message, where a cache would only add work, so it is off by default and a
 * view is made per message (one small object next to the buffer the browser already made).
 */
export class ViewCache {
  private readonly views: WeakMap<ArrayBuffer, DataView> | null;

  constructor(cache: boolean) {
    this.views = cache ? new WeakMap() : null;
  }

  viewOf(buffer: ArrayBuffer): DataView {
    const views = this.views;
    if (views === null) return new DataView(buffer);
    let view = views.get(buffer);
    if (view === undefined) {
      view = new DataView(buffer);
      views.set(buffer, view);
    }
    return view;
  }
}

const TOKEN_BYTES = 16;
const tokenScratch = new Uint8Array(TOKEN_BYTES);

/**
 * A fresh 128-bit reconnect token (32 hex characters). Uses `crypto.getRandomValues` where the
 * platform has it (browsers on any origin including plain-HTTP LAN, workers, node) unless a
 * `random` source is injected (tests). `crypto.randomUUID` is NOT used: it is missing on
 * non-secure origins (docs/DECISIONS.md, transport spike).
 */
export function createReconnectToken(random?: RandomSource): string {
  const platform = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => unknown } })
    .crypto;
  if (random === undefined && platform !== undefined && platform.getRandomValues !== undefined) {
    platform.getRandomValues(tokenScratch);
  } else {
    const source = random ?? Math.random;
    for (let i = 0; i < TOKEN_BYTES; i++) tokenScratch[i] = Math.floor(source() * 256) & 0xff;
  }
  return reconnectTokenFromBytes(tokenScratch);
}

/**
 * Where a client keeps its reconnect token between page loads. The session never touches
 * browser storage itself (it must run in node and in a worker): `src/game` passes an
 * implementation backed by per-tab session storage, keyed by room code.
 */
export interface ReconnectTokenStore {
  /** The token saved for this room, or '' when there is none. */
  load(roomCode: string): string;
  save(roomCode: string, token: string): void;
  clear(roomCode: string): void;
}

/** In-memory store: the default, and what tests and net-bots use. */
export function createMemoryTokenStore(): ReconnectTokenStore {
  const tokens = new Map<string, string>();
  return {
    load: (roomCode) => tokens.get(roomCode) ?? '',
    save: (roomCode, token) => {
      tokens.set(roomCode, token);
    },
    clear: (roomCode) => {
      tokens.delete(roomCode);
    },
  };
}

/**
 * PING carries the client's own smoothed round-trip time in the header's `u16 tick` field (a
 * ping has no sim tick of its own), so the host can show a ping column without a second
 * measurement or a wire-format change. This value means "not measured yet".
 */
export const PING_RTT_UNKNOWN = 0xffff;

export function rttToWire(rttMs: number, known: boolean): number {
  if (!known || !(rttMs >= 0)) return PING_RTT_UNKNOWN;
  return rttMs >= PING_RTT_UNKNOWN - 1 ? PING_RTT_UNKNOWN - 1 : Math.round(rttMs);
}

/** Milliseconds, or -1 for unknown. */
export function rttFromWire(wire: number): number {
  return wire === PING_RTT_UNKNOWN ? -1 : wire;
}
