import { describe, expect, it } from 'vitest';
import {
  SPATIAL_TUNING,
  createListenerFrame,
  createSpatialResult,
  distanceCutoffHz,
  distanceGain,
  spatialise,
  writeListenerFrame,
} from '../../src/audio';
import type { ListenerFrame } from '../../src/audio';

const REF = 30;
const MAX = 700;

/** A three.js-style camera at the origin looking down -Z, +Y up: +X is to its right. */
function cameraFrame(): ListenerFrame {
  return writeListenerFrame(createListenerFrame(), {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  });
}

describe('distanceGain', () => {
  it('is 1 inside the reference distance and 0 from the max distance on', () => {
    expect(distanceGain(0, REF, MAX)).toBe(1);
    expect(distanceGain(REF, REF, MAX)).toBe(1);
    expect(distanceGain(MAX, REF, MAX)).toBe(0);
    expect(distanceGain(MAX * 3, REF, MAX)).toBe(0);
  });

  it('falls monotonically and continuously in between', () => {
    let previous = 1;
    for (let d = REF; d <= MAX; d += 5) {
      const gain = distanceGain(d, REF, MAX);
      expect(gain).toBeLessThanOrEqual(previous);
      expect(previous - gain).toBeLessThan(0.15);
      previous = gain;
    }
    expect(distanceGain(MAX - 0.5, REF, MAX)).toBeLessThan(0.01);
  });

  it('keeps a mid-range fight clearly audible', () => {
    const gain = distanceGain(150, REF, MAX);
    expect(gain).toBeGreaterThan(0.2);
    expect(gain).toBeLessThan(0.5);
  });
});

describe('distanceCutoffHz', () => {
  it('goes from the near cutoff to the far cutoff', () => {
    expect(distanceCutoffHz(0, REF, MAX)).toBe(SPATIAL_TUNING.nearCutoffHz);
    expect(distanceCutoffHz(MAX, REF, MAX)).toBe(SPATIAL_TUNING.farCutoffHz);
    const middle = distanceCutoffHz((REF + MAX) / 2, REF, MAX);
    expect(middle).toBeCloseTo(
      Math.sqrt(SPATIAL_TUNING.nearCutoffHz * SPATIAL_TUNING.farCutoffHz),
      3,
    );
  });
});

describe('writeListenerFrame', () => {
  it('derives right = forward x up, normalised', () => {
    const frame = writeListenerFrame(createListenerFrame(), {
      position: { x: 1, y: 2, z: 3 },
      forward: { x: 0, y: 0, z: -5 },
      up: { x: 0, y: 2, z: 0 },
    });
    expect([frame.x, frame.y, frame.z]).toEqual([1, 2, 3]);
    expect(frame.rightX).toBeCloseTo(1);
    expect(frame.rightY).toBeCloseTo(0);
    expect(frame.rightZ).toBeCloseTo(0);
    expect(frame.forwardZ).toBeCloseTo(-1);
  });

  it('keeps the previous axes on a degenerate camera', () => {
    const frame = cameraFrame();
    writeListenerFrame(frame, {
      position: { x: NaN, y: 0, z: 0 },
      forward: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    });
    expect(frame.x).toBe(0);
    expect(frame.rightX).toBeCloseTo(1);
    writeListenerFrame(frame, {
      position: { x: 5, y: 0, z: 0 },
      forward: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    });
    expect(frame.x).toBe(5);
    expect(frame.rightX).toBeCloseTo(1);
    expect(frame.forwardZ).toBeCloseTo(-1);
  });
});

describe('spatialise', () => {
  const out = createSpatialResult();

  it('pans right for a sound on the right and left for one on the left', () => {
    const frame = cameraFrame();
    spatialise(out, frame, 100, 0, 0, REF, MAX);
    expect(out.pan).toBeGreaterThan(0.6);
    expect(out.pan).toBeLessThanOrEqual(SPATIAL_TUNING.panWidth);
    const right = out.pan;
    spatialise(out, frame, -100, 0, 0, REF, MAX);
    expect(out.pan).toBeCloseTo(-right, 6);
  });

  it('centres sounds ahead, behind, above and on top of the listener', () => {
    const frame = cameraFrame();
    spatialise(out, frame, 0, 0, -80, REF, MAX);
    expect(out.pan).toBeCloseTo(0, 6);
    spatialise(out, frame, 0, 0, 80, REF, MAX);
    expect(out.pan).toBeCloseTo(0, 6);
    spatialise(out, frame, 0, 60, 0, REF, MAX);
    expect(out.pan).toBeCloseTo(0, 6);
    spatialise(out, frame, 0, 0, 0, REF, MAX);
    expect(out.pan).toBe(0);
    expect(out.gain).toBe(1);
  });

  it('narrows the pan of very close sounds', () => {
    const frame = cameraFrame();
    spatialise(out, frame, 1, 0, 0, REF, MAX);
    const close = out.pan;
    spatialise(out, frame, 50, 0, 0, REF, MAX);
    expect(close).toBeGreaterThan(0);
    expect(close).toBeLessThan(out.pan * 0.3);
  });

  it('follows the listener position and orientation', () => {
    // Looking down +X from (10, 0, 0): +Z is to the right.
    const frame = writeListenerFrame(createListenerFrame(), {
      position: { x: 10, y: 0, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    });
    spatialise(out, frame, 10, 0, 90, REF, MAX);
    expect(out.pan).toBeGreaterThan(0.6);
    expect(out.distance).toBeCloseTo(90, 5);
    expect(out.gain).toBeCloseTo(distanceGain(90, REF, MAX), 6);
  });

  it('dulls a sound behind the listener', () => {
    const frame = cameraFrame();
    spatialise(out, frame, 0, 0, -100, REF, MAX);
    const ahead = out.cutoffHz;
    spatialise(out, frame, 0, 0, 100, REF, MAX);
    expect(out.cutoffHz).toBeCloseTo(ahead * SPATIAL_TUNING.rearCutoffScale, 3);
    spatialise(out, frame, 100, 0, 0, REF, MAX);
    expect(out.cutoffHz).toBeCloseTo(ahead, 3);
  });

  it('is silent beyond the max distance and never NaN', () => {
    const frame = cameraFrame();
    spatialise(out, frame, 0, 0, -5000, REF, MAX);
    expect(out.gain).toBe(0);
    spatialise(out, frame, NaN, 0, 0, REF, MAX);
    expect(out.gain).toBe(0);
    expect(Number.isNaN(out.pan)).toBe(false);
    expect(Number.isNaN(out.cutoffHz)).toBe(false);
    spatialise(out, frame, Infinity, 0, 0, REF, MAX);
    expect(out.gain).toBe(0);
    expect(Number.isNaN(out.pan)).toBe(false);
  });

  it('keeps every output in range over a sweep of positions', () => {
    const frame = cameraFrame();
    for (let x = -900; x <= 900; x += 75) {
      for (let z = -900; z <= 900; z += 75) {
        spatialise(out, frame, x, x * 0.1, z, REF, MAX);
        expect(out.pan).toBeGreaterThanOrEqual(-1);
        expect(out.pan).toBeLessThanOrEqual(1);
        expect(out.gain).toBeGreaterThanOrEqual(0);
        expect(out.gain).toBeLessThanOrEqual(1);
        expect(out.cutoffHz).toBeGreaterThan(SPATIAL_TUNING.farCutoffHz * 0.5);
        expect(out.cutoffHz).toBeLessThanOrEqual(SPATIAL_TUNING.nearCutoffHz);
      }
    }
  });
});
