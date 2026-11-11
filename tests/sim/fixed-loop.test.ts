import { describe, expect, it } from 'vitest';
import { TICK_DT_S, TICK_HZ, TICK_MS } from '../../src/shared';
import {
  DEFAULT_MAX_STEPS_PER_ADVANCE,
  FixedStepLoop,
  createSim,
  createSimState,
} from '../../src/sim';

/** Small seeded PRNG so "jittery" frame times are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frame times between 4 and 30 ms (roughly 33 to 250 fps) adding up to exactly `totalMs`. */
function jitteryFrames(totalMs: number, seed: number): number[] {
  const random = mulberry32(seed);
  const frames: number[] = [];
  let sum = 0;
  while (sum < totalMs) {
    const frame = Math.min(4 + random() * 26, totalMs - sum);
    frames.push(frame);
    sum += frame;
  }
  return frames;
}

describe('FixedStepLoop timestep stability', () => {
  it.each([1, 2, 3, 4, 5])('runs 30 ticks per second under jittery frames (seed %i)', (seed) => {
    const seconds = 20;
    const ticks: number[] = [];
    const loop = new FixedStepLoop(TICK_MS, (tick) => ticks.push(tick));

    for (const frame of jitteryFrames(seconds * 1000, seed)) loop.advance(frame);

    const expected = seconds * TICK_HZ;
    expect(Math.abs(ticks.length - expected)).toBeLessThanOrEqual(1);
    expect(loop.tick).toBe(ticks.length);
    expect(loop.droppedMs).toBe(0);
    // Monotonic, gap-free tick numbers starting at 0.
    ticks.forEach((tick, index) => expect(tick).toBe(index));
  });

  it('gives every step the same dt, however long the frame was', () => {
    const sim = createSim();
    const loop = new FixedStepLoop(TICK_MS, (tick) => sim.step(tick, []));
    const deltas: number[] = [];
    let lastTimeS = 0;

    for (const frame of jitteryFrames(5000, 7)) {
      const before = loop.tick;
      loop.advance(frame);
      // Sample after each advance; multi-step advances are covered by the tick-derived clock.
      if (loop.tick > before) {
        deltas.push((sim.current.timeS - lastTimeS) / (loop.tick - before));
        lastTimeS = sim.current.timeS;
      }
    }

    expect(deltas.length).toBeGreaterThan(100);
    for (const dt of deltas) expect(dt).toBeCloseTo(TICK_DT_S, 9);
    expect(sim.current.timeS).toBeCloseTo(loop.tick * TICK_DT_S, 9);
  });

  it('is independent of how the same time is sliced into frames', () => {
    const run = (frameMs: number): number => {
      const loop = new FixedStepLoop(TICK_MS, () => {});
      for (let t = 0; t < 10_000; t += frameMs) loop.advance(frameMs);
      return loop.tick;
    };
    // 144 Hz, 60 Hz and 30 Hz displays all land on 300 ticks (±1 for the last partial step).
    for (const frameMs of [1000 / 144, 1000 / 60, 1000 / 30]) {
      expect(Math.abs(run(frameMs) - 300)).toBeLessThanOrEqual(1);
    }
  });

  it('runs no step until a whole step has been banked', () => {
    const loop = new FixedStepLoop(10, () => {});
    expect(loop.advance(4)).toBe(0);
    expect(loop.advance(4)).toBe(0);
    expect(loop.advance(4)).toBe(1);
    expect(loop.alpha).toBeCloseTo(0.2, 9);
  });
});

describe('FixedStepLoop alpha', () => {
  it('stays in [0, 1) after every advance', () => {
    const loop = new FixedStepLoop(TICK_MS, () => {});
    expect(loop.alpha).toBe(0);
    const random = mulberry32(99);
    for (let i = 0; i < 20_000; i++) {
      // Includes frames far past the clamp and frames of almost nothing.
      const frame = random() < 0.02 ? random() * 5000 : random() * 40;
      loop.advance(frame);
      expect(loop.alpha).toBeGreaterThanOrEqual(0);
      expect(loop.alpha).toBeLessThan(1);
    }
  });

  it('stays below 1 when elapsed is an exact multiple of the step', () => {
    const loop = new FixedStepLoop(TICK_MS, () => {});
    for (let i = 1; i <= 200; i++) {
      loop.advance(TICK_MS * (i % 4));
      expect(loop.alpha).toBeLessThan(1);
    }
  });
});

describe('FixedStepLoop spiral-of-death clamp', () => {
  it('caps the steps per advance and drops the excess', () => {
    let steps = 0;
    const loop = new FixedStepLoop(10, () => steps++);

    // A minute away from the tab would be 6000 steps.
    expect(loop.advance(60_000)).toBe(DEFAULT_MAX_STEPS_PER_ADVANCE);
    expect(steps).toBe(DEFAULT_MAX_STEPS_PER_ADVANCE);
    expect(loop.droppedMs).toBe(60_000 - DEFAULT_MAX_STEPS_PER_ADVANCE * 10);
    expect(loop.alpha).toBe(0);

    // The debt is gone: a normal frame afterwards runs a normal number of steps.
    expect(loop.advance(10)).toBe(1);
    expect(loop.advance(5)).toBe(0);
    expect(steps).toBe(DEFAULT_MAX_STEPS_PER_ADVANCE + 1);
  });

  it('keeps the sub-step remainder when it drops', () => {
    const loop = new FixedStepLoop(10, () => {}, 2);
    expect(loop.advance(57)).toBe(2);
    expect(loop.alpha).toBeCloseTo(0.7, 9);
    expect(loop.droppedMs).toBeCloseTo(30, 9);
  });

  it('honours a custom cap and does not drop at exactly the cap', () => {
    const loop = new FixedStepLoop(10, () => {}, 3);
    expect(loop.advance(30)).toBe(3);
    expect(loop.droppedMs).toBe(0);
    expect(loop.advance(1000)).toBe(3);
    expect(loop.droppedMs).toBe(970);
  });
});

describe('FixedStepLoop input guards', () => {
  it.each([Number.NaN, -1, -1e9, 0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'ignores elapsed = %d',
    (bad) => {
      let steps = 0;
      const loop = new FixedStepLoop(10, () => steps++);
      loop.advance(7);

      expect(loop.advance(bad)).toBe(0);
      expect(steps).toBe(0);
      expect(loop.tick).toBe(0);
      expect(loop.alpha).toBeCloseTo(0.7, 9);

      // Still healthy afterwards.
      expect(loop.advance(3)).toBe(1);
    },
  );

  it('rejects a nonsensical step size or cap', () => {
    for (const stepMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new FixedStepLoop(stepMs, () => {})).toThrow(RangeError);
    }
    expect(() => new FixedStepLoop(10, () => {}, 0)).toThrow(RangeError);
    expect(() => new FixedStepLoop(10, () => {}, Number.NaN)).toThrow(RangeError);
  });

  it('does not replay time when a step throws', () => {
    let calls = 0;
    const loop = new FixedStepLoop(10, () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    expect(() => loop.advance(10)).toThrow('boom');
    expect(loop.tick).toBe(1);
    expect(loop.advance(1)).toBe(0);
  });
});

describe('FixedStepLoop determinism and reset', () => {
  it('produces the same tick sequence for the same elapsed sequence', () => {
    const frames = jitteryFrames(8000, 42);
    frames.splice(50, 0, 900, Number.NaN, -3);

    const run = (): { log: string; alpha: number; tick: number } => {
      const entries: string[] = [];
      const loop = new FixedStepLoop(TICK_MS, (tick) => entries.push(`s${tick}`));
      for (const frame of frames) entries.push(`a${loop.advance(frame)}:${loop.alpha}`);
      return { log: entries.join(','), alpha: loop.alpha, tick: loop.tick };
    };

    expect(run()).toEqual(run());
  });

  it('reset() returns to tick 0 with an empty accumulator', () => {
    const ticks: number[] = [];
    const loop = new FixedStepLoop(10, (tick) => ticks.push(tick));
    loop.advance(1000);
    loop.advance(25);
    loop.reset();

    expect(loop.tick).toBe(0);
    expect(loop.alpha).toBe(0);
    expect(loop.droppedMs).toBe(0);
    ticks.length = 0;
    loop.advance(20);
    expect(ticks).toEqual([0, 1]);
  });

  it('clearAccumulator() drops the fraction but keeps the tick count', () => {
    const loop = new FixedStepLoop(10, () => {});
    loop.advance(27);
    loop.clearAccumulator();
    expect(loop.tick).toBe(2);
    expect(loop.alpha).toBe(0);
  });
});

describe('createSim skeleton', () => {
  it('keeps the previous and current tick for interpolation', () => {
    const sim = createSim();
    expect(sim.current.tick).toBe(-1);

    sim.step(0, []);
    expect(sim.prev.tick).toBe(-1);
    expect(sim.current.tick).toBe(0);

    sim.step(1, []);
    expect(sim.prev.tick).toBe(0);
    expect(sim.current.tick).toBe(1);
    expect(sim.prev.timeS).toBeCloseTo(TICK_DT_S, 12);
    expect(sim.current.timeS).toBeCloseTo(2 * TICK_DT_S, 12);
    expect(sim.prev).not.toBe(sim.current);
  });

  it('reuses its two state buffers instead of allocating per step', () => {
    const sim = createSim();
    sim.step(0, []);
    const a = sim.prev;
    const b = sim.current;
    sim.step(1, []);
    sim.step(2, []);
    expect(sim.prev).toBe(a);
    expect(sim.current).toBe(b);
  });

  it('reset() returns both states to the start', () => {
    const sim = createSim();
    sim.step(0, []);
    sim.step(1, []);
    sim.reset();
    expect(sim.prev).toEqual(createSimState());
    expect(sim.current).toEqual(createSimState());
  });
});
