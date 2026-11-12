/**
 * RELAY (`ctrl`, host -> clients, Ember Relay only, T-6.3): where the stands and braziers are
 * and the state of both shards. The whole state every time (88 bytes): it is sent when
 * something changed (a few times a minute) and to whoever joins or reconnects mid-match, so a
 * client never has to rebuild it from `objective` events it may have missed.
 *
 * A carried shard has no position of its own on the wire that is kept up to date: it rides
 * with its carrier, whose dragon is in every snapshot. `returnTick` is a host tick, the clock
 * snapshots are played back on, so the countdown a client shows is the host's.
 *
 * Layout after the 3-byte header:
 *   u8 bits            bit 0 = the mode is running
 *   4 x (3 x f32)      stand Ember, stand Frost, brazier Ember, brazier Frost
 *   2 x shard          Ember's, Frost's
 *   shard := u8 status, u8 carrierId, 3 x f32 position, u32 returnTick (0 unless dropped)
 *
 * The host's own page does not use this: it reads `SimState.relay` (directly, or from the host
 * worker's state record).
 */

import { NO_PLAYER, SHARD_CARRIED, SHARD_DROPPED, SHARD_STATUS_COUNT } from '../../shared';
import type { MutableVec3, Vec3 } from '../../shared';
import type { RelayState } from '../../sim';
import type { Reader, Writer } from '../codec/io';
import { DECODE_BAD_VALUE, HEADER_BYTES, MSG_RELAY } from '../protocol';

const SITE_BYTES = 12;
const SHARD_BYTES = 1 + 1 + 12 + 4;
export const RELAY_BYTES = HEADER_BYTES + 1 + 4 * SITE_BYTES + 2 * SHARD_BYTES;

const BIT_ACTIVE = 1;

function writeVec(w: Writer, v: Readonly<Vec3> | undefined): void {
  w.f32(v === undefined ? 0 : v.x);
  w.f32(v === undefined ? 0 : v.y);
  w.f32(v === undefined ? 0 : v.z);
}

/** Reads three floats into `out`; false when one of them is not a finite number. */
function readVec(r: Reader, out: MutableVec3): boolean {
  const x = r.f32();
  const y = r.f32();
  const z = r.f32();
  if (!Number.isFinite(x + y + z)) return false;
  out.x = x;
  out.y = y;
  out.z = z;
  return true;
}

/** Writes the message into `w` and returns its length. Allocation-free. */
export function encodeRelay(w: Writer, tick: number, relay: Readonly<RelayState>): number {
  w.reset();
  w.header(MSG_RELAY, tick & 0xffff);
  w.u8(relay.active ? BIT_ACTIVE : 0);
  writeVec(w, relay.stands[0]);
  writeVec(w, relay.stands[1]);
  writeVec(w, relay.braziers[0]);
  writeVec(w, relay.braziers[1]);
  for (let team = 0; team < 2; team++) {
    const shard = relay.shards[team];
    const status = shard === undefined ? 0 : shard.status;
    w.u8(status);
    w.u8(shard === undefined ? NO_PLAYER : shard.carrierId);
    writeVec(w, shard?.position);
    const returnTick = shard !== undefined && status === SHARD_DROPPED ? shard.returnTick : 0;
    w.u32(returnTick > 0 ? returnTick >>> 0 : 0);
  }
  return w.finish();
}

/** Scratch of `decodeRelay`: a message is only applied once all of it checked out. */
const scratch: MutableVec3[] = [];
for (let i = 0; i < 6; i++) scratch.push({ x: 0, y: 0, z: 0 });
const scratchStatus = [0, 0];
const scratchCarrier = [NO_PLAYER, NO_PLAYER];
const scratchReturn = [-1, -1];

function copyVec(out: MutableVec3 | undefined, from: MutableVec3 | undefined): void {
  if (out === undefined || from === undefined) return;
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
}

/**
 * Reads the message into `into` and bumps `into.revision`. False (and `into` untouched) when it
 * is malformed: wrong length, an unknown status, a number that is not finite, or a carried
 * shard without a carrier.
 */
export function decodeRelay(r: Reader, into: RelayState): boolean {
  r.header(MSG_RELAY, RELAY_BYTES);
  const bits = r.u8();
  if (!r.ok) return false;
  if (r.remaining !== RELAY_BYTES - HEADER_BYTES - 1) {
    // Too short or too long: read nothing and let `finish` report which.
    r.skip(RELAY_BYTES - HEADER_BYTES - 1);
    return r.finish();
  }
  let good = true;
  for (let i = 0; i < 4; i++) {
    const site = scratch[i];
    if (site === undefined || !readVec(r, site)) good = false;
  }
  for (let team = 0; team < 2; team++) {
    const status = r.u8();
    const carrierId = r.u8();
    const position = scratch[4 + team];
    if (position === undefined || !readVec(r, position)) good = false;
    const returnTick = r.u32();
    if (status >= SHARD_STATUS_COUNT) good = false;
    if ((status === SHARD_CARRIED) !== (carrierId !== NO_PLAYER)) good = false;
    scratchStatus[team] = status;
    scratchCarrier[team] = carrierId;
    scratchReturn[team] = status === SHARD_DROPPED ? returnTick : -1;
  }
  if (!r.finish()) return false;
  if (!good) return r.fail(DECODE_BAD_VALUE);

  into.active = (bits & BIT_ACTIVE) !== 0;
  into.revision++;
  copyVec(into.stands[0], scratch[0]);
  copyVec(into.stands[1], scratch[1]);
  copyVec(into.braziers[0], scratch[2]);
  copyVec(into.braziers[1], scratch[3]);
  for (let team = 0; team < 2; team++) {
    const shard = into.shards[team];
    if (shard === undefined) continue;
    shard.status = scratchStatus[team] ?? 0;
    shard.carrierId = scratchCarrier[team] ?? NO_PLAYER;
    copyVec(shard.position, scratch[4 + team]);
    shard.returnTick = scratchReturn[team] ?? -1;
  }
  return true;
}
