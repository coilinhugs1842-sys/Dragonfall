/**
 * NetStats: plain traffic counters for the perf HUD's "net KB/s" line.
 *
 * Pure data plus free functions, no imports at all, so a real session can feed the same struct
 * the netsim wrappers feed (and the file can move to `src/shared` unchanged if `src/net` wants
 * to import it; `src/net` may not import `src/dev`).
 *
 * Usage: call `recordSent` / `recordReceived` / `recordDropped` per message (allocation-free),
 * call `updateNetStats(stats, nowMs)` once per frame or tick, read the `*PerS` fields.
 */

/** Same union as the transport's `Channel`; repeated here to keep this file import-free. */
export type NetStatsChannel = 'ctrl' | 'fast';

export interface NetChannelStats {
  /** Running totals since creation or the last `resetNetStats`. */
  sentPackets: number;
  sentBytes: number;
  receivedPackets: number;
  receivedBytes: number;
  /** Messages that never arrived: simulated loss, queue overflow, a refused `send`. */
  droppedPackets: number;
  droppedBytes: number;
  /** Rates over the last finished window, refreshed by `updateNetStats`. */
  sentPacketsPerS: number;
  sentBytesPerS: number;
  receivedPacketsPerS: number;
  receivedBytesPerS: number;
  droppedPacketsPerS: number;
  droppedBytesPerS: number;
  /** Totals at the start of the current window (internal to `updateNetStats`). */
  markSentPackets: number;
  markSentBytes: number;
  markReceivedPackets: number;
  markReceivedBytes: number;
  markDroppedPackets: number;
  markDroppedBytes: number;
}

export interface NetStats {
  readonly ctrl: NetChannelStats;
  readonly fast: NetChannelStats;
  /** Length of one rate window. */
  windowMs: number;
  /** Start of the current window on the caller's clock; -1 until the first update. */
  windowStartMs: number;
}

export const DEFAULT_NET_STATS_WINDOW_MS = 1000;

function createChannelStats(): NetChannelStats {
  return {
    sentPackets: 0,
    sentBytes: 0,
    receivedPackets: 0,
    receivedBytes: 0,
    droppedPackets: 0,
    droppedBytes: 0,
    sentPacketsPerS: 0,
    sentBytesPerS: 0,
    receivedPacketsPerS: 0,
    receivedBytesPerS: 0,
    droppedPacketsPerS: 0,
    droppedBytesPerS: 0,
    markSentPackets: 0,
    markSentBytes: 0,
    markReceivedPackets: 0,
    markReceivedBytes: 0,
    markDroppedPackets: 0,
    markDroppedBytes: 0,
  };
}

export function createNetStats(windowMs: number = DEFAULT_NET_STATS_WINDOW_MS): NetStats {
  return {
    ctrl: createChannelStats(),
    fast: createChannelStats(),
    windowMs: windowMs > 0 ? windowMs : DEFAULT_NET_STATS_WINDOW_MS,
    windowStartMs: -1,
  };
}

export function recordSent(stats: NetStats, channel: NetStatsChannel, bytes: number): void {
  const c = channel === 'fast' ? stats.fast : stats.ctrl;
  c.sentPackets++;
  c.sentBytes += bytes;
}

export function recordReceived(stats: NetStats, channel: NetStatsChannel, bytes: number): void {
  const c = channel === 'fast' ? stats.fast : stats.ctrl;
  c.receivedPackets++;
  c.receivedBytes += bytes;
}

export function recordDropped(stats: NetStats, channel: NetStatsChannel, bytes: number): void {
  const c = channel === 'fast' ? stats.fast : stats.ctrl;
  c.droppedPackets++;
  c.droppedBytes += bytes;
}

function rollChannel(c: NetChannelStats, perS: number): void {
  c.sentPacketsPerS = (c.sentPackets - c.markSentPackets) * perS;
  c.sentBytesPerS = (c.sentBytes - c.markSentBytes) * perS;
  c.receivedPacketsPerS = (c.receivedPackets - c.markReceivedPackets) * perS;
  c.receivedBytesPerS = (c.receivedBytes - c.markReceivedBytes) * perS;
  c.droppedPacketsPerS = (c.droppedPackets - c.markDroppedPackets) * perS;
  c.droppedBytesPerS = (c.droppedBytes - c.markDroppedBytes) * perS;
  markChannel(c);
}

function markChannel(c: NetChannelStats): void {
  c.markSentPackets = c.sentPackets;
  c.markSentBytes = c.sentBytes;
  c.markReceivedPackets = c.receivedPackets;
  c.markReceivedBytes = c.receivedBytes;
  c.markDroppedPackets = c.droppedPackets;
  c.markDroppedBytes = c.droppedBytes;
}

/**
 * Refreshes the per-second rates once a full window has passed. Cheap enough to call every
 * frame. Returns true when the rates changed (a HUD can rebuild its text only then).
 */
export function updateNetStats(stats: NetStats, nowMs: number): boolean {
  if (stats.windowStartMs < 0 || nowMs < stats.windowStartMs) {
    // First call, or the clock went backwards: start a window, keep the old rates.
    stats.windowStartMs = nowMs;
    markChannel(stats.ctrl);
    markChannel(stats.fast);
    return false;
  }
  const elapsedMs = nowMs - stats.windowStartMs;
  if (elapsedMs < stats.windowMs) return false;
  const perS = 1000 / elapsedMs;
  rollChannel(stats.ctrl, perS);
  rollChannel(stats.fast, perS);
  stats.windowStartMs = nowMs;
  return true;
}

/** Zeroes totals and rates. */
export function resetNetStats(stats: NetStats): void {
  const windowMs = stats.windowMs;
  Object.assign(stats.ctrl, createChannelStats());
  Object.assign(stats.fast, createChannelStats());
  stats.windowMs = windowMs;
  stats.windowStartMs = -1;
}

/** Both channels, kilobytes (1000 B) per second going out. */
export function netStatsSentKBps(stats: Readonly<NetStats>): number {
  return (stats.ctrl.sentBytesPerS + stats.fast.sentBytesPerS) / 1000;
}

/** Both channels, kilobytes (1000 B) per second coming in. */
export function netStatsReceivedKBps(stats: Readonly<NetStats>): number {
  return (stats.ctrl.receivedBytesPerS + stats.fast.receivedBytesPerS) / 1000;
}

/** Share of `fast` traffic that was dropped in the last window, 0..1. */
export function netStatsFastLoss(stats: Readonly<NetStats>): number {
  const f = stats.fast;
  const total = f.sentPacketsPerS + f.receivedPacketsPerS + f.droppedPacketsPerS;
  return total > 0 ? f.droppedPacketsPerS / total : 0;
}

/**
 * HUD text, e.g. `up 12.4 down 3.1 KB/s`, plus ` loss 2.0%` when something was dropped.
 * Builds a string: call it at the HUD's text rate, not per frame.
 */
export function formatNetStats(stats: Readonly<NetStats>): string {
  const up = netStatsSentKBps(stats).toFixed(1);
  const down = netStatsReceivedKBps(stats).toFixed(1);
  const loss = netStatsFastLoss(stats);
  const base = `up ${up} down ${down} KB/s`;
  return loss > 0 ? `${base} loss ${(loss * 100).toFixed(1)}%` : base;
}
