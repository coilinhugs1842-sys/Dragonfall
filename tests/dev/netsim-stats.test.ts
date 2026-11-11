import { describe, expect, it } from 'vitest';
import {
  createNetStats,
  formatNetStats,
  netStatsFastLoss,
  netStatsReceivedKBps,
  netStatsSentKBps,
  recordDropped,
  recordReceived,
  recordSent,
  resetNetStats,
  updateNetStats,
} from '../../src/dev/netsim/stats';

describe('NetStats', () => {
  it('keeps totals per channel', () => {
    const stats = createNetStats();
    recordSent(stats, 'fast', 24);
    recordSent(stats, 'fast', 24);
    recordSent(stats, 'ctrl', 100);
    recordReceived(stats, 'fast', 291);
    recordReceived(stats, 'ctrl', 11);
    recordDropped(stats, 'fast', 291);
    expect(stats.fast).toMatchObject({
      sentPackets: 2,
      sentBytes: 48,
      receivedPackets: 1,
      receivedBytes: 291,
      droppedPackets: 1,
      droppedBytes: 291,
    });
    expect(stats.ctrl).toMatchObject({
      sentPackets: 1,
      sentBytes: 100,
      receivedPackets: 1,
      receivedBytes: 11,
      droppedPackets: 0,
    });
  });

  it('computes per-second rates once per window', () => {
    const stats = createNetStats();
    expect(updateNetStats(stats, 5000)).toBe(false);
    for (let i = 0; i < 30; i++) recordSent(stats, 'fast', 24);
    for (let i = 0; i < 20; i++) recordReceived(stats, 'fast', 291);
    recordSent(stats, 'ctrl', 280);
    expect(updateNetStats(stats, 5500)).toBe(false);
    expect(stats.fast.sentBytesPerS).toBe(0);
    expect(updateNetStats(stats, 6000)).toBe(true);
    expect(stats.fast.sentPacketsPerS).toBe(30);
    expect(stats.fast.sentBytesPerS).toBe(720);
    expect(stats.fast.receivedPacketsPerS).toBe(20);
    expect(stats.fast.receivedBytesPerS).toBe(5820);
    expect(netStatsSentKBps(stats)).toBe(1);
    expect(netStatsReceivedKBps(stats)).toBe(5.82);

    // A late update scales by the real elapsed time.
    for (let i = 0; i < 30; i++) recordSent(stats, 'fast', 24);
    expect(updateNetStats(stats, 8000)).toBe(true);
    expect(stats.fast.sentPacketsPerS).toBe(15);
    expect(stats.ctrl.sentBytesPerS).toBe(0);

    // Quiet window: rates fall to zero, totals stay.
    expect(updateNetStats(stats, 9000)).toBe(true);
    expect(stats.fast.sentPacketsPerS).toBe(0);
    expect(stats.fast.sentPackets).toBe(60);
  });

  it('honours a custom window and survives a clock that jumps back', () => {
    const stats = createNetStats(250);
    updateNetStats(stats, 100);
    recordSent(stats, 'fast', 100);
    expect(updateNetStats(stats, 350)).toBe(true);
    expect(stats.fast.sentBytesPerS).toBe(400);
    expect(updateNetStats(stats, 10)).toBe(false);
    expect(stats.fast.sentBytesPerS).toBe(400);
    expect(stats.windowStartMs).toBe(10);
    expect(createNetStats(0).windowMs).toBe(1000);
  });

  it('reports the fast loss share and formats the HUD line', () => {
    const stats = createNetStats();
    updateNetStats(stats, 0);
    expect(formatNetStats(stats)).toBe('up 0.0 down 0.0 KB/s');
    for (let i = 0; i < 49; i++) recordReceived(stats, 'fast', 250);
    recordDropped(stats, 'fast', 250);
    for (let i = 0; i < 50; i++) recordSent(stats, 'fast', 24);
    updateNetStats(stats, 1000);
    expect(netStatsFastLoss(stats)).toBeCloseTo(0.01, 10);
    expect(formatNetStats(stats)).toBe('up 1.2 down 12.3 KB/s loss 1.0%');
  });

  it('resets totals and rates but keeps the window length', () => {
    const stats = createNetStats(500);
    updateNetStats(stats, 0);
    recordSent(stats, 'ctrl', 10);
    updateNetStats(stats, 500);
    resetNetStats(stats);
    expect(stats.ctrl.sentPackets).toBe(0);
    expect(stats.ctrl.sentBytesPerS).toBe(0);
    expect(stats.windowMs).toBe(500);
    expect(stats.windowStartMs).toBe(-1);
  });
});
