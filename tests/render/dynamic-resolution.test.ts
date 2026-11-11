import { describe, expect, it } from 'vitest';
import {
  DYNRES_SCALE_STEP,
  DYNRES_TARGET_FRAME_MS,
  DynamicResolution,
} from '../../src/render/dynamic-resolution';
import { computePixelRatio } from '../../src/render/render-scale';

const MIN = 0.6;
const MAX = 0.85;
const VSYNC = DYNRES_TARGET_FRAME_MS;

/** Feeds `frames` identical frames; returns how many times the scale changed. */
function feed(dyn: DynamicResolution, frameMs: number, frames: number): number {
  let changes = 0;
  for (let i = 0; i < frames; i++) {
    if (dyn.update(frameMs)) changes++;
  }
  return changes;
}

/** A scaler that has already seen the display run at 60 Hz, as after any calm half second. */
function createOn60HzDisplay(): DynamicResolution {
  const dyn = new DynamicResolution(MIN, MAX);
  feed(dyn, VSYNC, 64);
  return dyn;
}

/**
 * A fixed-refresh display: the GPU cost grows with the pixel count and every frame lasts a whole
 * number of refresh intervals. Returns the number of scale changes.
 */
function simulateVsynced(
  dyn: DynamicResolution,
  refreshMs: number,
  sustainableScale: number,
  frames: number,
): number {
  let changes = 0;
  for (let i = 0; i < frames; i++) {
    const cost = refreshMs * (dyn.scale / sustainableScale) ** 2;
    if (dyn.update(Math.max(1, Math.ceil(cost / refreshMs - 1e-9)) * refreshMs)) changes++;
  }
  return changes;
}

/**
 * A vsynced GPU whose cost grows with the pixel count: on budget up to `sustainableScale`,
 * over budget above it. Returns the number of scale changes.
 */
function simulate(dyn: DynamicResolution, sustainableScale: number, frames: number): number {
  let changes = 0;
  for (let i = 0; i < frames; i++) {
    const cost = VSYNC * (dyn.scale / sustainableScale) ** 2;
    if (dyn.update(Math.max(VSYNC, cost))) changes++;
    expect(dyn.scale).toBeGreaterThanOrEqual(MIN);
    expect(dyn.scale).toBeLessThanOrEqual(MAX);
  }
  return changes;
}

describe('DynamicResolution', () => {
  it('starts at the top of its bounds', () => {
    expect(new DynamicResolution(MIN, MAX).scale).toBe(MAX);
  });

  it('converges down to the minimum under sustained slow frames', () => {
    const dyn = createOn60HzDisplay();
    feed(dyn, 25, 600);
    expect(dyn.scale).toBe(MIN);
    // It has seen 60 Hz, so slow frames are the GPU's doing and the budget stays at 60 fps.
    feed(dyn, 25, 6000);
    expect(dyn.scale).toBe(MIN);
    expect(dyn.frameBudgetMs).toBe(VSYNC);
  });

  it('steps down within about half a second of going over budget', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    feed(dyn, 20, 30);
    expect(dyn.scale).toBeLessThan(MAX);
  });

  it('never leaves the bounds, whatever the frame times', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    const pattern = [5, 40, 16.7, 99, 8, 33.3, 12, 60];
    for (let i = 0; i < 20_000; i++) {
      dyn.update(pattern[i % pattern.length] ?? VSYNC);
      expect(dyn.scale).toBeGreaterThanOrEqual(MIN);
      expect(dyn.scale).toBeLessThanOrEqual(MAX);
    }
    feed(dyn, 4, 20_000);
    expect(dyn.scale).toBe(MAX);
  });

  it('only produces quantized scales', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    for (let i = 0; i < 2_000; i++) {
      dyn.update(i % 700 < 350 ? 22 : VSYNC);
      const steps = dyn.scale / DYNRES_SCALE_STEP;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
  });

  it('settles under a steady load instead of oscillating', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    // One minute at 60 fps on a GPU that can hold 0.7 but not 0.75.
    const changes = simulate(dyn, 0.7, 3600);
    // 3 steps down to settle, then a handful of failed probes with a doubling wait.
    expect(changes).toBeLessThanOrEqual(14);
    expect(dyn.scale).toBeGreaterThanOrEqual(0.7 - 1e-9);
    expect(dyn.scale).toBeLessThanOrEqual(0.75 + 1e-9);

    // The wait is capped at a minute: later minutes see at most one probe (up + back down).
    simulate(dyn, 0.7, 3600 * 3);
    expect(simulate(dyn, 0.7, 3600)).toBeLessThanOrEqual(2);
  });

  it('does not change the scale at all for a load it handles at maximum', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    expect(feed(dyn, VSYNC, 3600)).toBe(0);
    expect(dyn.scale).toBe(MAX);
  });

  it('climbs back up when the load goes away', () => {
    const dyn = createOn60HzDisplay();
    feed(dyn, 25, 600);
    expect(dyn.scale).toBe(MIN);
    feed(dyn, VSYNC, 3600);
    expect(dyn.scale).toBe(MAX);
  });

  it('ignores single outlier frames', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    let changes = 0;
    for (let i = 0; i < 3000; i++) {
      // A tab-switch sized stall every 5 s and a missed vsync every second.
      const frameMs = i % 300 === 150 ? 800 : i % 60 === 30 ? VSYNC * 2 : VSYNC;
      if (dyn.update(frameMs)) changes++;
    }
    expect(changes).toBe(0);
    expect(dyn.scale).toBe(MAX);
  });

  it('steps down when every frame is slower than the outlier limit', () => {
    // Software rendering at 5 fps: no frame is an isolated hitch.
    const dyn = new DynamicResolution(MIN, MAX);
    feed(dyn, 200, 300);
    expect(dyn.scale).toBe(MIN);
    // That is no display cadence: the budget is not relaxed and the scale stays down.
    feed(dyn, 200, 3000);
    expect(dyn.scale).toBe(MIN);
    expect(dyn.frameBudgetMs).toBe(VSYNC);
  });

  it('ignores a short run of outlier frames', () => {
    const dyn = createOn60HzDisplay();
    let changes = 0;
    for (let i = 0; i < 3000; i++) {
      // A loading stall of four long frames every 5 s.
      if (dyn.update(i % 300 < 4 ? 400 : VSYNC)) changes++;
    }
    expect(changes).toBe(0);
  });

  it.each([
    ['50 Hz', 20],
    ['48 Hz', 1000 / 48],
    ['a 30 fps frame cap', 1000 / 30],
  ])('returns to full scale on a display limited to %s', (_name, refreshMs) => {
    const dyn = new DynamicResolution(MIN, MAX);
    // An idle GPU: every frame lasts exactly one refresh, whatever the scale.
    feed(dyn, refreshMs, 1200);
    expect(dyn.scale).toBe(MAX);
    expect(dyn.frameBudgetMs).toBeCloseTo(refreshMs, 6);
    expect(feed(dyn, refreshMs, 3600)).toBe(0);
  });

  it('still scales for GPU load on a slow display', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    feed(dyn, 20, 1200);
    expect(dyn.scale).toBe(MAX);
    // The GPU now holds 50 Hz up to 0.7 only.
    simulateVsynced(dyn, 20, 0.7, 1200);
    expect(dyn.scale).toBeLessThanOrEqual(0.75 + 1e-9);
    expect(dyn.scale).toBeGreaterThanOrEqual(0.7 - 1e-9);
  });

  it('tightens the budget again when the display turns out to be faster', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    feed(dyn, 20, 1200);
    expect(dyn.frameBudgetMs).toBeCloseTo(20, 6);
    feed(dyn, VSYNC, 64);
    expect(dyn.frameBudgetMs).toBeCloseTo(VSYNC, 9);
  });

  it('does not mistake a GPU that is overloaded from the first frame for a slow display', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    // 60 Hz display, GPU holds 60 fps up to 0.7: at the start every frame takes two refreshes.
    simulateVsynced(dyn, VSYNC, 0.7, 1200);
    expect(dyn.frameBudgetMs).toBe(VSYNC);
    expect(dyn.scale).toBeLessThanOrEqual(0.75 + 1e-9);
    expect(dyn.scale).toBeGreaterThanOrEqual(0.65 - 1e-9);
  });

  it('steps down when a few percent of frames miss vsync', () => {
    const dyn = createOn60HzDisplay();
    let changes = 0;
    for (let i = 0; i < 600; i++) {
      // One missed vsync every 30 frames (3.3 %): the mean stays inside the dead band.
      const missing = dyn.scale > 0.7 + 1e-9 && i % 30 === 15;
      if (dyn.update(missing ? VSYNC * 2 : VSYNC)) changes++;
    }
    expect(changes).toBeGreaterThan(0);
    expect(dyn.scale).toBeCloseTo(0.7, 9);
  });

  it('fails a probe that makes the frame rate judder', () => {
    const dyn = createOn60HzDisplay();
    let changes = 0;
    // Ten minutes: every scale above 0.7 misses one vsync in 30.
    for (let i = 0; i < 36_000; i++) {
      const missing = dyn.scale > 0.7 + 1e-9 && i % 30 === 15;
      if (dyn.update(missing ? VSYNC * 2 : VSYNC)) changes++;
    }
    // 3 steps down, then failed probes with a doubling wait: not one probe every 3 s (~200).
    expect(changes).toBeLessThanOrEqual(40);
    expect(dyn.scale).toBeLessThanOrEqual(0.75 + 1e-9);
  });

  it('ignores invalid frame times', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(feed(dyn, bad, 500)).toBe(0);
    }
    expect(dyn.scale).toBe(MAX);
  });

  it('setBounds clamps the current scale', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    dyn.setBounds(0.5, 0.7);
    expect(dyn.scale).toBe(0.7);
    dyn.setBounds(0.85, 1.0);
    expect(dyn.scale).toBe(0.85);
    expect(dyn.minScale).toBe(0.85);
    expect(dyn.maxScale).toBe(1.0);
  });

  it('does nothing while disabled', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    dyn.enabled = false;
    expect(feed(dyn, 40, 2000)).toBe(0);
    expect(dyn.scale).toBe(MAX);
    dyn.enabled = true;
    expect(feed(dyn, 40, 2000)).toBeGreaterThan(0);
  });

  it('setScale pins a clamped, quantized scale', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    expect(dyn.setScale(0.72)).toBe(true);
    expect(dyn.scale).toBe(0.7);
    expect(dyn.setScale(0.1)).toBe(true);
    expect(dyn.scale).toBe(MIN);
    expect(dyn.setScale(MIN)).toBe(false);
  });

  it('reset returns to the maximum', () => {
    const dyn = new DynamicResolution(MIN, MAX);
    feed(dyn, 25, 600);
    dyn.reset();
    expect(dyn.scale).toBe(MAX);
  });
});

describe('computePixelRatio', () => {
  it('references 1080p, not the native resolution', () => {
    // 1080p panel at 100 % scaling: 1080 * 0.85 lines.
    expect(1080 * computePixelRatio(1080, 1, 0.85)).toBeCloseTo(918);
    // 2880x1800 panel at 200 % scaling (css 900): capped at 1080 lines before scaling.
    expect(900 * computePixelRatio(900, 2, 0.85)).toBeCloseTo(918);
    // 4K at 100 %: still 1080-referenced.
    expect(2160 * computePixelRatio(2160, 1, 1)).toBeCloseTo(1080);
  });

  it('never renders above native resolution in a small window', () => {
    expect(computePixelRatio(600, 1, 1)).toBe(1);
    expect(computePixelRatio(600, 1.25, 0.6)).toBeCloseTo(0.75);
  });

  it('survives a zero-sized canvas', () => {
    expect(Number.isFinite(computePixelRatio(0, 1, 0.7))).toBe(true);
  });
});
