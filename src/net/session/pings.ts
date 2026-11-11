/**
 * PLAYER_PINGS (`ctrl`, host -> clients, about once a second): every player's round trip, so a
 * client can show the same ping column as the host. Pings are not lobby state: putting them in
 * LOBBY_STATE would re-send the whole JSON room every second.
 *
 * Layout after the 3-byte header: `u8 count`, then per player `u8 playerId`, `u16 rttMs`
 * (0xFFFF = unknown). 16 players are 52 bytes.
 */

import { MAX_LOBBY_MEMBERS } from '../../shared';
import type { PlayerId } from '../../shared';
import type { Reader, Writer } from '../codec/io';
import { DECODE_BAD_VALUE, HEADER_BYTES, MSG_PLAYER_PINGS } from '../protocol';
import { PING_RTT_UNKNOWN, rttFromWire, rttToWire } from './wire';

export const PLAYER_PINGS_MAX_PLAYERS = MAX_LOBBY_MEMBERS;
export const PLAYER_PINGS_ENTRY_BYTES = 3;
export const PLAYER_PINGS_MAX_BYTES =
  HEADER_BYTES + 1 + PLAYER_PINGS_MAX_PLAYERS * PLAYER_PINGS_ENTRY_BYTES;

/** Reused struct: `count` live entries in the two parallel arrays. */
export interface PlayerPingsMessage {
  tick: number;
  count: number;
  readonly ids: Uint8Array;
  /** Wire values: milliseconds, or PING_RTT_UNKNOWN. */
  readonly rtts: Uint16Array;
}

export function createPlayerPingsMessage(): PlayerPingsMessage {
  return {
    tick: 0,
    count: 0,
    ids: new Uint8Array(PLAYER_PINGS_MAX_PLAYERS),
    rtts: new Uint16Array(PLAYER_PINGS_MAX_PLAYERS),
  };
}

/** Appends one player; `rttMs` < 0 = unknown. False when the message is full. */
export function addPlayerPing(msg: PlayerPingsMessage, playerId: PlayerId, rttMs: number): boolean {
  if (msg.count >= PLAYER_PINGS_MAX_PLAYERS) return false;
  msg.ids[msg.count] = playerId;
  msg.rtts[msg.count] = rttToWire(rttMs, rttMs >= 0);
  msg.count++;
  return true;
}

export function encodePlayerPings(w: Writer, msg: Readonly<PlayerPingsMessage>): number {
  const count = msg.count < PLAYER_PINGS_MAX_PLAYERS ? msg.count : PLAYER_PINGS_MAX_PLAYERS;
  w.reset();
  w.header(MSG_PLAYER_PINGS, msg.tick);
  w.u8(count);
  for (let i = 0; i < count; i++) {
    w.u8(msg.ids[i] ?? 0);
    w.u16(msg.rtts[i] ?? PING_RTT_UNKNOWN);
  }
  return w.finish();
}

export function decodePlayerPings(r: Reader, into: PlayerPingsMessage): boolean {
  const tick = r.header(MSG_PLAYER_PINGS, PLAYER_PINGS_MAX_BYTES);
  const count = r.u8();
  if (!r.ok) return false;
  if (count > PLAYER_PINGS_MAX_PLAYERS) return r.fail(DECODE_BAD_VALUE);
  if (r.remaining !== count * PLAYER_PINGS_ENTRY_BYTES) {
    // Too short or too long: read (or skip) nothing and let `finish` report which.
    r.skip(count * PLAYER_PINGS_ENTRY_BYTES);
    return r.finish();
  }
  for (let i = 0; i < count; i++) {
    into.ids[i] = r.u8();
    into.rtts[i] = r.u16();
  }
  if (!r.finish()) return false;
  into.tick = tick;
  into.count = count;
  return true;
}

/**
 * Writes a decoded message into a ping table indexed by PlayerId (-1 = unknown). Players the
 * message does not list are set to unknown, so a seat that was freed does not keep its number.
 */
export function applyPlayerPings(table: number[], msg: Readonly<PlayerPingsMessage>): void {
  for (let i = 0; i < table.length; i++) table[i] = -1;
  for (let i = 0; i < msg.count; i++) {
    const id = msg.ids[i] ?? 0;
    if (id < table.length) table[id] = rttFromWire(msg.rtts[i] ?? PING_RTT_UNKNOWN);
  }
}
