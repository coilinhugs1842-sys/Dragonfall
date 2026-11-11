import { describe, expect, it } from 'vitest';
import { FrameStats, createFrameStatsSummary } from '../../src/dev/frame-stats';

describe('FrameStats', () => {
  it('reads all zeros while empty', () => {
    const out = new FrameStats(8).read(createFrameStatsSummary());
    expect(out).toEqual({
      count: 0,
      avgMs: 0,
      fps: 0,
      maxMs: 0,
      onePercentLowMs: 0,
      onePercentLowFps: 0,
    });
  });

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => new FrameStats(0)).toThrow(RangeError);
    expect(() => new FrameStats(2.5)).toThrow(RangeError);
  });

  it('computes avg, fps and max over a partly filled window', () => {
    const stats = new FrameStats(100);
    for (const ms of [10, 20, 30]) stats.push(ms);
    const out = stats.read(createFrameStatsSummary());
    expect(out.count).toBe(3);
    expect(out.avgMs).toBeCloseTo(20, 5);
    expect(out.fps).toBeCloseTo(50, 4);
    expect(out.maxMs).toBeCloseTo(30, 5);
    // Fewer than 100 frames: the 1 % low is the single slowest frame.
    expect(out.onePercentLowMs).toBeCloseTo(30, 5);
    expect(out.onePercentLowFps).toBeCloseTo(1000 / 30, 4);
  });

  it('averages the slowest 1 % of frames for the 1 % low', () => {
    const stats = new FrameStats(200);
    for (let i = 0; i < 198; i++) stats.push(10);
    stats.push(40);
    stats.push(60);
    const out = stats.read(createFrameStatsSummary());
    expect(out.count).toBe(200);
    expect(out.onePercentLowMs).toBeCloseTo(50, 5);
    expect(out.onePercentLowFps).toBeCloseTo(20, 4);
    expect(out.maxMs).toBeCloseTo(60, 5);
    expect(out.avgMs).toBeCloseTo((198 * 10 + 100) / 200, 4);
  });

  it('forgets the oldest frames once the ring wraps', () => {
    const stats = new FrameStats(4);
    stats.push(500);
    for (let i = 0; i < 4; i++) stats.push(16);
    const out = stats.read(createFrameStatsSummary());
    expect(out.count).toBe(4);
    expect(out.maxMs).toBeCloseTo(16, 5);
    expect(out.avgMs).toBeCloseTo(16, 5);
  });

  it('drops negative and non-finite samples', () => {
    const stats = new FrameStats(4);
    stats.push(-1);
    stats.push(Number.NaN);
    stats.push(Number.POSITIVE_INFINITY);
    expect(stats.count).toBe(0);
    stats.push(0);
    expect(stats.count).toBe(1);
    // An all-zero window must not divide by zero.
    expect(stats.read(createFrameStatsSummary()).fps).toBe(0);
  });

  it('reuses the caller-owned summary and leaves the ring intact when read', () => {
    const stats = new FrameStats(16);
    for (const ms of [5, 50, 7, 9]) stats.push(ms);
    const out = createFrameStatsSummary();
    expect(stats.read(out)).toBe(out);
    const first = { ...out };
    stats.read(out);
    expect(out).toEqual(first);
    stats.push(100);
    expect(stats.read(out).maxMs).toBeCloseTo(100, 5);
    expect(out.count).toBe(5);
  });

  it('reset empties the window', () => {
    const stats = new FrameStats(4);
    stats.push(16);
    stats.reset();
    expect(stats.count).toBe(0);
    stats.push(8);
    expect(stats.read(createFrameStatsSummary()).maxMs).toBeCloseTo(8, 5);
  });
});
