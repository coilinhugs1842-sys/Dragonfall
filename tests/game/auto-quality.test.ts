import { describe, expect, it } from 'vitest';
import {
  AUTO_QUALITY_REFERENCE_PIXELS,
  AUTO_QUALITY_SCALE,
  AUTO_QUALITY_TUNING,
  AutoQualityMeter,
  createAutoQualityMeasurement,
  decideQuality,
  drawMsAtReference,
  repeatsForScene,
} from '../../src/game/auto-quality';
import type { AutoQualityMeasurement, AutoQualityMeterState } from '../../src/game/auto-quality';
import type { QualityPresetId } from '../../src/shared/quality';

const REPEATS = AUTO_QUALITY_TUNING.repeats;
const PIXELS = AUTO_QUALITY_REFERENCE_PIXELS;

type Series = (frame: number) => { frameMs: number; costMs: number };

/** Pushes `series` until the meter stops asking (or `maxFrames`). Returns the frames pushed. */
function feed(meter: AutoQualityMeter, series: Series, maxFrames = 20_000): number {
  let frame = 0;
  let state: AutoQualityMeterState = meter.state;
  while ((state === 'warmup' || state === 'measuring') && frame < maxFrames) {
    const sample = series(frame);
    state = meter.push(sample.frameMs, sample.costMs);
    frame++;
  }
  return frame;
}

/** A steady machine: every frame `frameMs` apart, every test frame `costMs` of GPU time. */
function steady(frameMs: number, costMs: number): Series {
  // A little ripple, as a real GPU has: 2 % either way.
  return (frame) => ({ frameMs, costMs: costMs * (1 + 0.02 * Math.sin(frame * 1.7)) });
}

function measure(series: Series, expectCost = true): AutoQualityMeasurement {
  const meter = new AutoQualityMeter();
  meter.begin(expectCost);
  feed(meter, series);
  expect(meter.state).toBe('done');
  return meter.read(createAutoQualityMeasurement());
}

function pick(
  series: Series,
  held: QualityPresetId | null = null,
  pixels = PIXELS,
): QualityPresetId {
  return decideQuality(measure(series), REPEATS, pixels, held).preset;
}

describe('the automatic quality pick: the numbers', () => {
  it('tests at the top render scale of Medium, at a 1080p-sized scene', () => {
    expect(AUTO_QUALITY_SCALE).toBe(0.85);
    expect(PIXELS).toBe(1632 * 918);
  });

  it('keeps its limits in order', () => {
    const t = AUTO_QUALITY_TUNING;
    expect(t.highMaxDrawMs).toBeLessThan(t.lowMinDrawMs);
    // The margin must leave a Medium band between "kept on High" and "kept on Low".
    expect(t.highMaxDrawMs).toBeLessThan(t.lowMinDrawMs * (1 - t.stepUpMargin));
    expect(t.stepUpMargin).toBeGreaterThan(0);
    expect(t.stepUpMargin).toBeLessThan(0.5);
    expect(t.measureMs).toBe(3000);
    expect(t.maxMeasureMs).toBeGreaterThan(t.measureMs);
    expect(t.gapMs).toBeGreaterThan(t.noTimerLowFrameMs);
  });
});

describe('AutoQualityMeter', () => {
  it('measures three seconds after discarding the warm-up', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    const frames = feed(meter, steady(1000 / 60, 11));
    const m = meter.read(createAutoQualityMeasurement());
    expect(meter.state).toBe('done');
    expect(m.method).toBe('gpu-timer');
    expect(m.seconds).toBeGreaterThanOrEqual(3);
    expect(m.seconds).toBeLessThan(3.05);
    expect(m.frames).toBe(m.samples);
    // 30 warm-up frames at 60 Hz are the half second (31 if rounding falls short), then 3 s.
    expect(frames - m.frames).toBeGreaterThanOrEqual(AUTO_QUALITY_TUNING.warmupFrames);
    expect(frames - m.frames).toBeLessThanOrEqual(AUTO_QUALITY_TUNING.warmupFrames + 1);
    expect(m.frames).toBeGreaterThanOrEqual(180);
    expect(m.costMs).toBeCloseTo(11, 1);
    expect(m.frameMs).toBeCloseTo(1000 / 60, 3);
  });

  it('does not let the warm-up frames into the result', () => {
    // Shader compiles and a first resize: the first frames cost ten times as much.
    const m = measure((frame) =>
      frame < AUTO_QUALITY_TUNING.warmupFrames
        ? { frameMs: 1000 / 60, costMs: 110 }
        : { frameMs: 1000 / 60, costMs: 11 },
    );
    expect(m.costMs).toBeCloseTo(11, 6);
    expect(m.costP95Ms).toBeCloseTo(11, 6);
  });

  it('warms up for half a second even when thirty frames pass sooner', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    const frameMs = 1000 / 240;
    for (let i = 0; i < AUTO_QUALITY_TUNING.warmupFrames; i++) meter.push(frameMs, 1);
    expect(meter.state).toBe('warmup');
    for (let i = 0; i < 95; i++) meter.push(frameMs, 1);
    expect(meter.state).toBe('measuring');
  });

  it('ignores one hitch', () => {
    const calm = measure(steady(1000 / 60, 11));
    const hitched = measure((frame) =>
      frame === 100 ? { frameMs: 180, costMs: 150 } : steady(1000 / 60, 11)(frame),
    );
    // The mean of all samples would move by about 0.8 ms; the trimmed mean does not.
    expect(hitched.costMs).toBeCloseTo(calm.costMs, 1);
    expect(hitched.costP95Ms).toBeLessThan(12);
    expect(hitched.frameMs).toBeCloseTo(1000 / 60, 1);
    expect(decideQuality(hitched, REPEATS, PIXELS, null).preset).toBe(
      decideQuality(calm, REPEATS, PIXELS, null).preset,
    );
  });

  it('ignores a dozen hitches too', () => {
    const hitched = measure((frame) =>
      frame > 40 && frame % 15 === 0 ? { frameMs: 120, costMs: 90 } : steady(1000 / 60, 11)(frame),
    );
    expect(hitched.costMs).toBeCloseTo(11, 0);
    expect(decideQuality(hitched, REPEATS, PIXELS, null).preset).toBe('medium');
  });

  it('starts over after a gap: the tab was hidden in the middle', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    // One second in, the tab is hidden for five seconds. The frames before it were drawn
    // while the browser was already throttling: their costs must not be in the result.
    for (let i = 0; i < 90; i++) meter.push(1000 / 60, 30);
    expect(meter.state).toBe('measuring');
    expect(meter.push(5000, -1)).toBe('warmup');
    expect(meter.restarts).toBe(1);

    const frames = feed(meter, steady(1000 / 60, 11));
    const m = meter.read(createAutoQualityMeasurement());
    expect(meter.state).toBe('done');
    // A whole new warm-up and a whole new three seconds.
    expect(frames).toBeGreaterThanOrEqual(AUTO_QUALITY_TUNING.warmupFrames + 180);
    expect(m.seconds).toBeGreaterThanOrEqual(3);
    expect(m.seconds).toBeLessThan(3.05);
    expect(m.costMs).toBeCloseTo(11, 1);
    expect(m.costP95Ms).toBeLessThan(12);
  });

  it('starts over when told the tab is hidden, once per absence', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    for (let i = 0; i < 90; i++) meter.push(1000 / 60, 30);
    // Hidden for many beats: one interruption, not many.
    for (let i = 0; i < 20; i++) expect(meter.interrupt()).toBe('warmup');
    expect(meter.restarts).toBe(1);
    feed(meter, steady(1000 / 60, 11));
    const m = meter.read(createAutoQualityMeasurement());
    expect(m.costMs).toBeCloseTo(11, 1);
    expect(m.seconds).toBeLessThan(3.05);
  });

  it('gives no result for a throttled tab: long frames while the GPU is quick', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    // A background tab that still gets one frame a second. The GPU's part is 5 ms: the page
    // is being held back, the machine is not slow.
    feed(meter, () => ({ frameMs: 1000, costMs: 5 }));
    expect(meter.state).toBe('failed');
  });

  it('says "too slow" for a machine that really draws the title at 3 fps', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    const frames = feed(meter, () => ({ frameMs: 330, costMs: 310 }));
    expect(meter.state).toBe('tooSlow');
    expect(frames).toBe(AUTO_QUALITY_TUNING.slowRunFrames);
  });

  it('says "too slow" without a GPU timer when nothing but long frames arrive', () => {
    const meter = new AutoQualityMeter();
    meter.begin(false);
    feed(meter, () => ({ frameMs: 400, costMs: -1 }));
    expect(meter.state).toBe('tooSlow');
  });

  it('gives up after too many interruptions', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    let state: AutoQualityMeterState = meter.state;
    let gaps = 0;
    while (state === 'warmup' || state === 'measuring') {
      for (let i = 0; i < 60; i++) meter.push(1000 / 60, 11);
      state = meter.push(2000, -1);
      gaps++;
    }
    expect(state).toBe('failed');
    expect(gaps).toBe(AUTO_QUALITY_TUNING.maxRestarts + 1);
    // A finished meter stays finished.
    expect(meter.push(16, 11)).toBe('failed');
    expect(meter.interrupt()).toBe('failed');
  });

  it('forgets the interruptions of an earlier test', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    for (let i = 0; i < 5; i++) {
      meter.push(16, 11);
      meter.push(2000, -1);
    }
    expect(meter.restarts).toBe(5);
    meter.begin(true);
    expect(meter.restarts).toBe(0);
    expect(meter.state).toBe('warmup');
  });

  it('skips frames that are not frames', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    expect(meter.push(0, 11)).toBe('warmup');
    expect(meter.push(-5, 11)).toBe('warmup');
    expect(meter.push(Number.NaN, 11)).toBe('warmup');
    expect(meter.push(Number.POSITIVE_INFINITY, 11)).toBe('warmup');
    expect(meter.restarts).toBe(0);
  });

  it('waits for late GPU times, then decides by frame time if none ever come', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    // The timer exists but never answers (a driver that keeps every query "disjoint").
    feed(meter, () => ({ frameMs: 1000 / 60, costMs: -1 }));
    const m = meter.read(createAutoQualityMeasurement());
    expect(meter.state).toBe('done');
    expect(m.method).toBe('frame-time');
    expect(m.samples).toBe(0);
    expect(m.seconds).toBeGreaterThanOrEqual(AUTO_QUALITY_TUNING.maxMeasureMs / 1000);
    expect(decideQuality(m, REPEATS, PIXELS, null).preset).toBe('medium');
  });

  it('takes GPU times that arrive only every few frames', () => {
    // A slow machine: the result of a 60 ms frame is ready three frames later.
    const m = measure((frame) => ({ frameMs: 66, costMs: frame % 3 === 0 ? 58 : -1 }));
    expect(m.method).toBe('gpu-timer');
    expect(m.samples).toBeGreaterThanOrEqual(AUTO_QUALITY_TUNING.minSamples);
    expect(m.costMs).toBeCloseTo(58, 6);
    // It ran on past three seconds to collect enough of them.
    expect(m.seconds).toBeGreaterThan(3);
  });

  it('measures a 240 Hz display for the whole time without running out of room', () => {
    const m = measure(() => ({ frameMs: 1000 / 240, costMs: 2 }));
    expect(m.frames).toBeGreaterThan(700);
    expect(m.frames).toBeLessThanOrEqual(1024);
    expect(m.seconds).toBeGreaterThanOrEqual(3);
    expect(m.costMs).toBeCloseTo(2, 6);
  });

  it('can be used again for a second test', () => {
    const meter = new AutoQualityMeter();
    meter.begin(true);
    feed(meter, steady(1000 / 60, 30));
    expect(meter.read(createAutoQualityMeasurement()).costMs).toBeCloseTo(30, 0);
    meter.begin(true);
    feed(meter, steady(1000 / 60, 4));
    const again = meter.read(createAutoQualityMeasurement());
    expect(again.costMs).toBeCloseTo(4, 1);
    expect(again.seconds).toBeLessThan(3.05);
  });
});

describe('decideQuality: synthetic machines', () => {
  it('steady and fast: High', () => {
    // The dev desktop: 144 Hz, eight title draws in 3.1 ms.
    const m = measure(steady(1000 / 144, 3.1));
    const decision = decideQuality(m, REPEATS, PIXELS, null);
    expect(decision.preset).toBe('high');
    expect(decision.drawMs).toBeCloseTo(3.1 / 8, 2);
    expect(decision.reason).toBe('fast and steady');
  });

  it('steady and slow: Low', () => {
    const decision = decideQuality(measure(steady(40, 30)), REPEATS, PIXELS, null);
    expect(decision.preset).toBe('low');
    expect(decision.drawMs).toBeCloseTo(30 / 8, 1);
  });

  it('the U-series target (about 1.4 ms per draw): Medium, well inside its range', () => {
    const decision = decideQuality(measure(steady(1000 / 60, 11.2)), REPEATS, PIXELS, null);
    expect(decision.preset).toBe('medium');
    expect(decision.drawMs).toBeGreaterThan(decision.highLimitMs * 1.5);
    expect(decision.drawMs).toBeLessThan(decision.lowLimitMs / 1.5);
  });

  it('vsync-capped at 60: the same frame time, three different picks', () => {
    // Every one of these shows 16.7 ms frames. Only the GPU time tells them apart.
    const frameMs = 1000 / 60;
    expect(measure(steady(frameMs, 3)).frameMs).toBeCloseTo(
      measure(steady(frameMs, 12)).frameMs,
      6,
    );
    expect(pick(steady(frameMs, 3))).toBe('high');
    expect(pick(steady(frameMs, 9))).toBe('medium');
    expect(pick(steady(frameMs, 15))).toBe('medium');
  });

  it('a 30 fps laptop: Low when it is the GPU that is slow', () => {
    // 33 ms frames because eight draws take 26 ms: one fight frame would not fit either.
    expect(pick(steady(1000 / 30, 26))).toBe('low');
  });

  it('a laptop capped at 30 fps by a power saver, with a quick GPU: Medium, never High', () => {
    const decision = decideQuality(measure(steady(1000 / 30, 3)), REPEATS, PIXELS, null);
    expect(decision.preset).toBe('medium');
    expect(decision.reason).toBe('fast, but the page showed under 50 fps');
  });

  it('fast on average but uneven: Medium', () => {
    // Every eighth frame costs four times as much (a GPU shared with something else).
    const m = measure((frame) => ({
      frameMs: 1000 / 60,
      costMs: frame % 8 === 0 ? 12 : 3,
    }));
    const decision = decideQuality(m, REPEATS, PIXELS, null);
    expect(m.costP95Ms).toBe(12);
    expect(decision.preset).toBe('medium');
    expect(decision.reason).toBe('fast, but uneven');
  });
});

describe('decideQuality: the edges', () => {
  function at(drawMs: number, frameMs = 1000 / 60): AutoQualityMeasurement {
    return {
      method: 'gpu-timer',
      samples: 180,
      costMs: drawMs * REPEATS,
      costP95Ms: drawMs * REPEATS * 1.1,
      frames: 180,
      frameMs,
      seconds: 3,
    };
  }
  const high = AUTO_QUALITY_TUNING.highMaxDrawMs;
  const low = AUTO_QUALITY_TUNING.lowMinDrawMs;
  const margin = AUTO_QUALITY_TUNING.stepUpMargin;

  it('does not give High to a machine just inside the limit', () => {
    // 5 % under the limit: allowed to stay on High, not to move up to it.
    const edge = at(high * 0.95);
    expect(decideQuality(edge, REPEATS, PIXELS, null).preset).toBe('medium');
    expect(decideQuality(edge, REPEATS, PIXELS, 'medium').preset).toBe('medium');
    expect(decideQuality(edge, REPEATS, PIXELS, 'low').preset).toBe('medium');
    expect(decideQuality(edge, REPEATS, PIXELS, 'high').preset).toBe('high');
  });

  it('gives High once the margin is cleared', () => {
    const clear = at(high * (1 - margin) * 0.99);
    expect(decideQuality(clear, REPEATS, PIXELS, null).preset).toBe('high');
    expect(decideQuality(clear, REPEATS, PIXELS, 'low').preset).toBe('high');
  });

  it('takes High away as soon as its plain limit is passed', () => {
    expect(decideQuality(at(high * 1.02), REPEATS, PIXELS, 'high').preset).toBe('medium');
  });

  it('keeps a machine on Low until it clears the limit by the margin', () => {
    const edge = at(low * 0.95);
    expect(decideQuality(edge, REPEATS, PIXELS, 'low').preset).toBe('low');
    expect(decideQuality(edge, REPEATS, PIXELS, 'medium').preset).toBe('medium');
    expect(decideQuality(edge, REPEATS, PIXELS, null).preset).toBe('medium');
    expect(decideQuality(at(low * (1 - margin) * 0.99), REPEATS, PIXELS, 'low').preset).toBe(
      'medium',
    );
  });

  it('moves down without a margin', () => {
    expect(decideQuality(at(low * 1.02), REPEATS, PIXELS, null).preset).toBe('low');
    expect(decideQuality(at(low * 1.02), REPEATS, PIXELS, 'high').preset).toBe('low');
    expect(decideQuality(at(low * 0.999), REPEATS, PIXELS, null).preset).toBe('medium');
  });

  it('does not flip between two presets when the same machine is tested again', () => {
    // A machine whose readings wander 4 % round the High limit, tested ten times in a row.
    let held: QualityPresetId | null = null;
    const seen = new Set<QualityPresetId>();
    for (let i = 0; i < 10; i++) {
      const wobble = 1 + 0.04 * Math.sin(i * 2.3);
      held = decideQuality(at(high * wobble), REPEATS, PIXELS, held).preset;
      seen.add(held);
    }
    expect([...seen]).toEqual(['medium']);
  });

  it('reports the limits it used', () => {
    const first = decideQuality(at(1.4), REPEATS, PIXELS, null);
    expect(first.highLimitMs).toBeCloseTo(high * (1 - margin), 6);
    expect(first.lowLimitMs).toBe(low);
    const onHigh = decideQuality(at(0.5), REPEATS, PIXELS, 'high');
    expect(onHigh.highLimitMs).toBe(high);
    const onLow = decideQuality(at(3), REPEATS, PIXELS, 'low');
    expect(onLow.lowLimitMs).toBeCloseTo(low * (1 - margin), 6);
  });
});

describe('the window size', () => {
  it('scales a small window up to the reference size', () => {
    // A quarter of the pixels cost a quarter of the time on the same machine.
    expect(drawMsAtReference(8, 8, PIXELS)).toBe(1);
    expect(drawMsAtReference(2, 8, PIXELS / 4)).toBeCloseTo(1, 6);
    expect(drawMsAtReference(4, 8, PIXELS / 2)).toBeCloseTo(1, 6);
  });

  it('gives the same pick in a small window as in a full one', () => {
    for (const perDraw of [0.4, 1.4, 3]) {
      const full = pick(steady(1000 / 60, perDraw * 8));
      const small = pick(steady(1000 / 60, (perDraw * 8) / 3), null, PIXELS / 3);
      expect(small).toBe(full);
    }
  });

  it('never scales down, and scales up by four at most', () => {
    // An ultrawide scene really is more work than the reference.
    expect(drawMsAtReference(8, 8, PIXELS * 2)).toBe(1);
    expect(drawMsAtReference(8, 8, PIXELS / 100)).toBe(AUTO_QUALITY_TUNING.maxPixelCorrection);
  });

  it('draws more often in a small window, to push the same pixels per test frame', () => {
    expect(repeatsForScene(PIXELS)).toBe(8);
    expect(repeatsForScene(1088 * 612)).toBe(18);
    expect(repeatsForScene(1280 * 720)).toBe(13);
    expect(repeatsForScene(816 * 459)).toBe(32);
    // Not without end, and never fewer than at the reference size.
    expect(repeatsForScene(320 * 180)).toBe(32);
    expect(repeatsForScene(2176 * 918)).toBe(8);
    expect(repeatsForScene(0)).toBe(8);
  });

  it('reads a test frame of the same load the same, whatever the window', () => {
    // With the draws `repeatsForScene` gives, the per-draw figure is the frame's cost / 8.
    for (const pixels of [PIXELS, 1280 * 720, 1088 * 612, 960 * 540, 816 * 459]) {
      const repeats = repeatsForScene(pixels);
      // Whole draws: the load is within one sixteenth of the reference's.
      expect((repeats * pixels) / (8 * PIXELS)).toBeGreaterThan(0.94);
      expect((repeats * pixels) / (8 * PIXELS)).toBeLessThan(1.06);
      const perPixelCost = 11.2 / (8 * PIXELS);
      const cost = perPixelCost * repeats * pixels;
      expect(drawMsAtReference(cost, repeats, pixels)).toBeCloseTo(1.4, 6);
    }
  });

  it('takes an unknown size as the reference', () => {
    expect(drawMsAtReference(8, 8, 0)).toBe(1);
    expect(drawMsAtReference(8, 8, Number.NaN)).toBe(1);
    expect(drawMsAtReference(8, 0, PIXELS)).toBe(8);
  });
});

describe('without a GPU timer', () => {
  it('never picks High, however short the frames are', () => {
    for (const frameMs of [1000 / 240, 1000 / 144, 1000 / 60, 1000 / 30]) {
      const m = measure(() => ({ frameMs, costMs: -1 }), false);
      expect(m.method).toBe('frame-time');
      // Three seconds, not the long wait for GPU times that cannot come.
      expect(m.seconds).toBeLessThan(3.05);
      const decision = decideQuality(m, 1, PIXELS, null);
      expect(decision.preset).toBe('medium');
      expect(decision.drawMs).toBe(-1);
    }
  });

  it('picks Low when the title itself runs below 25 fps', () => {
    const m = measure(() => ({ frameMs: 50, costMs: -1 }), false);
    const decision = decideQuality(m, 1, PIXELS, null);
    expect(decision.preset).toBe('low');
    expect(decision.reason).toContain('below 25 fps');
  });

  it('keeps Low near the limit and leaves it with room to spare', () => {
    const near = measure(() => ({ frameMs: 38, costMs: -1 }), false);
    expect(decideQuality(near, 1, PIXELS, 'low').preset).toBe('low');
    expect(decideQuality(near, 1, PIXELS, null).preset).toBe('medium');
    const clear = measure(() => ({ frameMs: 30, costMs: -1 }), false);
    expect(decideQuality(clear, 1, PIXELS, 'low').preset).toBe('medium');
  });

  it('does not trust a handful of GPU times', () => {
    // The timer answered a few times and then stopped: too few to decide by.
    const m = measure((frame) => ({ frameMs: 1000 / 60, costMs: frame < 40 ? 2 : -1 }));
    expect(m.samples).toBeLessThan(AUTO_QUALITY_TUNING.minSamples);
    expect(m.method).toBe('frame-time');
    expect(decideQuality(m, REPEATS, PIXELS, null).preset).toBe('medium');
  });
});
