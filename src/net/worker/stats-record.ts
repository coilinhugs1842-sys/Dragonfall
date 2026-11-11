/**
 * REC_STATS: the numbers the worker reports a few times a second (rates, counts, cost figures,
 * everybody's ping). Small and fixed-layout, so it rides in the binary batch like everything
 * else that is periodic.
 *
 *   stats := f32 sentBytesPerS, f32 receivedBytesPerS, u32 malformed, u32 ticks,
 *            u8 clientCount, u8 botCount, u8 botsConnected, u8 pingCount,
 *            f32 x 10 (the cost figures below, in order), u32 inputHeldTicks,
 *            pingCount x (u8 playerId, i16 pingMs)
 */

import type { LobbyState } from '../../shared';
import { STATS_FIXED_BYTES } from './messages';

export interface HostWorkerStats {
  sentBytesPerS: number;
  receivedBytesPerS: number;
  malformed: number;
  ticks: number;
  clientCount: number;
  botCount: number;
  botsConnected: number;
  stepMs: number;
  simMs: number;
  snapshotMs: number;
  maxStepMs: number;
  pulseMs: number;
  pulseMaxMs: number;
  lateMs: number;
  lateMaxMs: number;
  inputAgeMs: number;
  inputAgeMaxMs: number;
  inputHeldTicks: number;
}

export function createHostWorkerStats(): HostWorkerStats {
  return {
    sentBytesPerS: 0,
    receivedBytesPerS: 0,
    malformed: 0,
    ticks: 0,
    clientCount: 0,
    botCount: 0,
    botsConnected: 0,
    stepMs: 0,
    simMs: 0,
    snapshotMs: 0,
    maxStepMs: 0,
    pulseMs: 0,
    pulseMaxMs: 0,
    lateMs: 0,
    lateMaxMs: 0,
    inputAgeMs: 0,
    inputAgeMaxMs: 0,
    inputHeldTicks: 0,
  };
}

const PING_ENTRY_BYTES = 3;
const MAX_PING_ENTRIES = 255;

export function hostStatsBytes(lobby: Readonly<LobbyState>): number {
  const count = Math.min(lobby.players.length, MAX_PING_ENTRIES);
  return STATS_FIXED_BYTES + count * PING_ENTRY_BYTES;
}

/** Writes a stats payload at `at`. `pings` is indexed by PlayerId (-1 = unknown). */
export function encodeHostStats(
  view: DataView,
  at: number,
  stats: Readonly<HostWorkerStats>,
  lobby: Readonly<LobbyState>,
  pings: readonly number[],
): number {
  const players = lobby.players;
  const count = Math.min(players.length, MAX_PING_ENTRIES);
  view.setFloat32(at, stats.sentBytesPerS, true);
  view.setFloat32(at + 4, stats.receivedBytesPerS, true);
  view.setUint32(at + 8, stats.malformed >>> 0, true);
  view.setUint32(at + 12, stats.ticks >>> 0, true);
  view.setUint8(at + 16, stats.clientCount);
  view.setUint8(at + 17, stats.botCount);
  view.setUint8(at + 18, stats.botsConnected);
  view.setUint8(at + 19, count);
  view.setFloat32(at + 20, stats.stepMs, true);
  view.setFloat32(at + 24, stats.simMs, true);
  view.setFloat32(at + 28, stats.snapshotMs, true);
  view.setFloat32(at + 32, stats.maxStepMs, true);
  view.setFloat32(at + 36, stats.pulseMs, true);
  view.setFloat32(at + 40, stats.pulseMaxMs, true);
  view.setFloat32(at + 44, stats.lateMs, true);
  view.setFloat32(at + 48, stats.lateMaxMs, true);
  view.setFloat32(at + 52, stats.inputAgeMs, true);
  view.setFloat32(at + 56, stats.inputAgeMaxMs, true);
  view.setUint32(at + 60, stats.inputHeldTicks >>> 0, true);
  let o = at + STATS_FIXED_BYTES;
  for (let i = 0; i < count; i++) {
    const player = players[i];
    const id = player === undefined ? 255 : player.id;
    const ping = player !== undefined && player.connected ? (pings[id] ?? -1) : -1;
    view.setUint8(o, id);
    view.setInt16(o + 1, ping < -1 ? -1 : ping > 32767 ? 32767 : Math.round(ping), true);
    o += PING_ENTRY_BYTES;
  }
  return o - at;
}

/** Reads a stats payload; `pings` (indexed by PlayerId) is reset to -1 and refilled. */
export function decodeHostStats(
  view: DataView,
  at: number,
  length: number,
  stats: HostWorkerStats,
  pings: number[],
): boolean {
  if (length < STATS_FIXED_BYTES || at + length > view.byteLength) return false;
  const count = view.getUint8(at + 19);
  if (length !== STATS_FIXED_BYTES + count * PING_ENTRY_BYTES) return false;
  stats.sentBytesPerS = view.getFloat32(at, true);
  stats.receivedBytesPerS = view.getFloat32(at + 4, true);
  stats.malformed = view.getUint32(at + 8, true);
  stats.ticks = view.getUint32(at + 12, true);
  stats.clientCount = view.getUint8(at + 16);
  stats.botCount = view.getUint8(at + 17);
  stats.botsConnected = view.getUint8(at + 18);
  stats.stepMs = view.getFloat32(at + 20, true);
  stats.simMs = view.getFloat32(at + 24, true);
  stats.snapshotMs = view.getFloat32(at + 28, true);
  stats.maxStepMs = view.getFloat32(at + 32, true);
  stats.pulseMs = view.getFloat32(at + 36, true);
  stats.pulseMaxMs = view.getFloat32(at + 40, true);
  stats.lateMs = view.getFloat32(at + 44, true);
  stats.lateMaxMs = view.getFloat32(at + 48, true);
  stats.inputAgeMs = view.getFloat32(at + 52, true);
  stats.inputAgeMaxMs = view.getFloat32(at + 56, true);
  stats.inputHeldTicks = view.getUint32(at + 60, true);
  for (let i = 0; i < pings.length; i++) pings[i] = -1;
  let o = at + STATS_FIXED_BYTES;
  for (let i = 0; i < count; i++) {
    const id = view.getUint8(o);
    if (id < pings.length) pings[id] = view.getInt16(o + 1, true);
    o += PING_ENTRY_BYTES;
  }
  return true;
}
