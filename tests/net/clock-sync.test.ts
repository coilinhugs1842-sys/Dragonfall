import { describe, expect, it } from 'vitest';
import { TICK_MS, createSeededRandom } from '../../src/shared';
import {
  CLOCK_SYNC_MIN_SAMPLES,
  CLOCK_SYNC_SLEW_MS,
  CLOCK_SYNC_WINDOW,
  ClockSync,
} from '../../src/net/clock';

/** Host clock = local clock + this. */
const TRUE_OFFSET = 123_456.5;
/** Host tick = (host time + this) / TICK_MS. */
const TICK_EPOCH = -40_000;

function hostTickAtLocal(localMs: number): number {
  return (localMs + TRUE_OFFSET + TICK_EPOCH) / TICK_MS;
}

/** One ping/pong with the given one-way delays; returns the local receive time. */
function exchange(clock: ClockSync, sendMs: number, upMs: number, downMs: number): boolean {
  const hostTime = sendMs + upMs + TRUE_OFFSET;
  const hostTick = Math.floor((hostTime + TICK_EPOCH) / TICK_MS);
  return clock.addSample(sendMs, hostTime, hostTick, sendMs + upMs + downMs);
}

describe('ClockSync', () => {
  it('starts unsynced and empty', () => {
    const clock = new ClockSync();
    expect(clock.synced).toBe(false);
    expect(clock.sampleCount).toBe(0);
    expect(clock.rttMs).toBe(0);
    expect(clock.minRttMs).toBe(Infinity);
    expect(clock.oneWayTicks).toBe(0);
  });

  it('recovers RTT, offset and host tick exactly on a symmetric, steady link', () => {
    const clock = new ClockSync();
    for (let i = 0; i < 10; i++) exchange(clock, 1000 + i * 500, 40, 40);
    expect(clock.synced).toBe(true);
    expect(clock.rttMs).toBeCloseTo(80, 6);
    expect(clock.rttJitterMs).toBeLessThan(4);
    expect(clock.lastRttMs).toBeCloseTo(80, 6);
    expect(clock.minRttMs).toBeCloseTo(80, 6);
    expect(clock.offsetMs).toBeCloseTo(TRUE_OFFSET, 6);
    expect(clock.hostTimeAt(7000)).toBeCloseTo(7000 + TRUE_OFFSET, 6);
    // The tick estimate is good to about a tick (the pong only carries whole ticks).
    expect(Math.abs(clock.hostTickAt(7000) - hostTickAtLocal(7000))).toBeLessThan(1);
    expect(clock.oneWayTicks).toBe(Math.ceil(40 / TICK_MS));
  });

  it('is synced after CLOCK_SYNC_MIN_SAMPLES samples', () => {
    const clock = new ClockSync();
    for (let i = 0; i < CLOCK_SYNC_MIN_SAMPLES; i++) {
      expect(clock.synced).toBe(false);
      exchange(clock, i * 100, 10, 10);
    }
    expect(clock.synced).toBe(true);
  });

  it('with jitter, the lowest-RTT sample keeps the offset within about 10 ms', () => {
    const random = createSeededRandom(7);
    const clock = new ClockSync();
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      // 80 +- 20 ms each way, independently: single samples are up to 20 ms off.
      exchange(clock, i * 500, 60 + random() * 40, 60 + random() * 40);
      if (i >= CLOCK_SYNC_WINDOW) worst = Math.max(worst, Math.abs(clock.offsetMs - TRUE_OFFSET));
    }
    expect(worst).toBeLessThan(12);
    expect(clock.rttMs).toBeGreaterThan(140);
    expect(clock.rttMs).toBeLessThan(180);
    expect(clock.rttJitterMs).toBeGreaterThan(5);
    expect(clock.rttJitterMs).toBeLessThan(30);
  });

  it('one huge outlier barely moves RTT and does not move the offset', () => {
    const clock = new ClockSync();
    for (let i = 0; i < 20; i++) exchange(clock, i * 500, 30, 30);
    const offsetBefore = clock.offsetMs;
    const rttBefore = clock.rttMs;
    // A pong stuck for 900 ms on the way back: its naive offset is 450 ms off.
    exchange(clock, 20 * 500, 30, 930);
    expect(clock.offsetMs).toBeCloseTo(offsetBefore, 6);
    expect(clock.rttMs - rttBefore).toBeLessThan(5);
    expect(clock.lastRttMs).toBeCloseTo(960, 6);
  });

  it('follows a real change of path within a few seconds', () => {
    const clock = new ClockSync();
    for (let i = 0; i < 20; i++) exchange(clock, i * 500, 20, 20);
    for (let i = 20; i < 60; i++) exchange(clock, i * 500, 100, 100);
    expect(clock.rttMs).toBeGreaterThan(190);
    expect(clock.rttMs).toBeLessThan(205);
    expect(clock.offsetMs).toBeCloseTo(TRUE_OFFSET, 3);
  });

  it('slews small offset changes instead of jumping, and jumps large ones', () => {
    const clock = new ClockSync(4);
    for (let i = 0; i < 8; i++) clock.addSample(i * 500, i * 500 + 1000 + 10, i, i * 500 + 20);
    expect(clock.offsetMs).toBeCloseTo(1000, 6);
    // The host clock is now 20 ms further ahead (drift, or a new best sample).
    const before = clock.offsetMs;
    for (let i = 8; i < 12; i++) clock.addSample(i * 500, i * 500 + 1020 + 10, i, i * 500 + 20);
    // Four samples filled the window with the new value; each moved the clock by the slew only.
    expect(clock.offsetMs - before).toBeGreaterThan(0);
    expect(clock.offsetMs - before).toBeLessThanOrEqual(4 * CLOCK_SYNC_SLEW_MS + 1e-9);
    for (let i = 12; i < 30; i++) clock.addSample(i * 500, i * 500 + 1020 + 10, i, i * 500 + 20);
    expect(clock.offsetMs).toBeCloseTo(1020, 6);
    // A suspended tab: the host clock is suddenly 5 s ahead. No slewing through that.
    for (let i = 30; i < 34; i++) clock.addSample(i * 500, i * 500 + 6020 + 10, i, i * 500 + 20);
    expect(clock.offsetMs).toBeCloseTo(6020, 6);
  });

  it('refuses impossible samples and leaves the state alone', () => {
    const clock = new ClockSync();
    exchange(clock, 0, 10, 10);
    const offset = clock.offsetMs;
    expect(clock.addSample(100, 5, 1, 90)).toBe(false); // received before sent
    expect(clock.addSample(Number.NaN, 5, 1, 90)).toBe(false);
    expect(clock.addSample(100, Number.NaN, 1, 120)).toBe(false);
    expect(clock.addSample(100, 5, Number.POSITIVE_INFINITY, 120)).toBe(false);
    expect(clock.addSample(100, 5, 1, 100 + 60_000)).toBe(false); // a minute-long round trip
    expect(clock.sampleCount).toBe(1);
    expect(clock.rejectedCount).toBe(5);
    expect(clock.offsetMs).toBe(offset);
  });

  it('follows the host tick counter when it restarts', () => {
    const clock = new ClockSync();
    for (let i = 0; i < 6; i++) exchange(clock, i * 500, 10, 10);
    // New match: the same host clock, but ticks start again from 0 at local time 3000.
    for (let i = 6; i < 8; i++) {
      const send = i * 500;
      const hostTime = send + 10 + TRUE_OFFSET;
      clock.addSample(send, hostTime, Math.floor((send + 10 - 3000) / TICK_MS), send + 20);
    }
    expect(Math.abs(clock.hostTickAt(4000) - 1000 / TICK_MS)).toBeLessThan(1.5);
  });

  it('reset forgets everything; the same samples give the same answers again', () => {
    const clock = new ClockSync();
    const feed = (): number => {
      const r = createSeededRandom(11);
      for (let i = 0; i < 40; i++) exchange(clock, i * 500, 20 + r() * 30, 20 + r() * 30);
      return clock.offsetMs + clock.rttMs * 1000 + clock.hostTickAt(1e6);
    };
    const first = feed();
    clock.reset();
    expect(clock.synced).toBe(false);
    expect(clock.sampleCount).toBe(0);
    expect(clock.offsetMs).toBe(0);
    expect(feed()).toBe(first);
  });
});
