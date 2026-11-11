import { describe, expect, it } from 'vitest';
import {
  LOOP_OVERLAP_S,
  RENDER_PEAK,
  RENDER_SAMPLE_RATE,
  Rng,
  SOUND_COUNT,
  SOUND_DEFS,
  SOUND_IDS,
  addCrackle,
  addNoise,
  addTail,
  addTone,
  crossfadeLoop,
  fadeEdges,
  normalise,
  peakOf,
  renderSound,
  rmsOf,
  soundIndexOf,
  soundLength,
} from '../../src/audio';

const SR = RENDER_SAMPLE_RATE;

function allFinite(buffer: Float32Array): boolean {
  for (let i = 0; i < buffer.length; i++) if (!Number.isFinite(buffer[i])) return false;
  return true;
}

describe('Rng', () => {
  it('is deterministic per seed and stays in range', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    let differs = false;
    for (let i = 0; i < 2000; i++) {
      const value = a.next();
      expect(value).toBe(b.next());
      if (value !== c.next()) differs = true;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(differs).toBe(true);
  });

  it('has roughly zero-mean bipolar noise', () => {
    const rng = new Rng(7);
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += rng.bipolar();
    expect(Math.abs(sum / 20000)).toBeLessThan(0.02);
  });
});

describe('layers', () => {
  it('addTone writes only inside its window and ends silent', () => {
    const out = new Float32Array(SR);
    addTone(out, SR, 0.25, 0.5, 1, 440, 220, 0.01, 3);
    expect(peakOf(out.subarray(0, Math.round(0.25 * SR) - 1))).toBe(0);
    expect(peakOf(out.subarray(Math.round(0.75 * SR) + 1))).toBe(0);
    expect(peakOf(out)).toBeGreaterThan(0.5);
    expect(peakOf(out)).toBeLessThanOrEqual(1.0001);
    expect(Math.abs(out[Math.round(0.75 * SR) - 1] ?? 1)).toBeLessThan(0.01);
  });

  it('a pure tone has the frequency asked for', () => {
    const out = new Float32Array(SR);
    addTone(out, SR, 0, 1, 1, 500, 500, 0.001, -1);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) {
      if ((out[i - 1] ?? 0) <= 0 && (out[i] ?? 0) > 0) crossings++;
    }
    expect(Math.abs(crossings - 500)).toBeLessThanOrEqual(2);
  });

  it('a negative decay holds the level (loops)', () => {
    const out = new Float32Array(SR);
    addTone(out, SR, 0, 99, 1, 300, 300, 0.01, -1);
    expect(peakOf(out.subarray(SR - 400))).toBeGreaterThan(0.95);
  });

  it('addNoise is finite, bounded and filtered as asked', () => {
    const low = new Float32Array(SR);
    const high = new Float32Array(SR);
    addNoise(low, SR, new Rng(1), 0, 1, 1, 'lp', 200, 200, 0.7, 0.01, -1);
    addNoise(high, SR, new Rng(1), 0, 1, 1, 'hp', 4000, 4000, 0.7, 0.01, -1);
    expect(allFinite(low)).toBe(true);
    expect(allFinite(high)).toBe(true);
    // Sample-to-sample change is a cheap brightness measure: the high-pass must be far busier.
    const roughness = (b: Float32Array): number => {
      let sum = 0;
      for (let i = 1; i < b.length; i++) sum += Math.abs((b[i] ?? 0) - (b[i - 1] ?? 0));
      return sum / rmsOf(b) / b.length;
    };
    expect(roughness(high)).toBeGreaterThan(roughness(low) * 5);
    expect(peakOf(low)).toBeLessThan(2);
    expect(peakOf(high)).toBeLessThan(4);
  });

  it('a swept filter stays stable at the extremes', () => {
    const out = new Float32Array(SR);
    addNoise(out, SR, new Rng(3), 0, 1, 1, 'bp', 20, 30000, 8, 0.01, 0);
    expect(allFinite(out)).toBe(true);
    expect(peakOf(out)).toBeLessThan(8);
  });

  it('addCrackle and addTail stay finite and add energy', () => {
    const out = new Float32Array(SR);
    addCrackle(out, SR, new Rng(5), 0, 0.5, 1, 100, 0.003, 4000);
    const dry = rmsOf(out);
    expect(dry).toBeGreaterThan(0);
    expect(peakOf(out.subarray(Math.round(0.5 * SR) + 1))).toBe(0);
    addTail(out, SR, 0.4, 0.6);
    expect(allFinite(out)).toBe(true);
    // The tail rings on after the dry sound stopped.
    expect(rmsOf(out.subarray(Math.round(0.55 * SR), Math.round(0.7 * SR)))).toBeGreaterThan(0);
    expect(peakOf(out)).toBeLessThan(4);
  });

  it('normalise hits the peak exactly and leaves silence alone', () => {
    const out = new Float32Array([0.1, -0.2, 0.05]);
    normalise(out, 0.5);
    expect(peakOf(out)).toBeCloseTo(0.5, 6);
    const silent = new Float32Array(8);
    normalise(silent, 0.5);
    expect(peakOf(silent)).toBe(0);
  });

  it('fadeEdges zeroes both ends', () => {
    const out = new Float32Array(1000).fill(1);
    fadeEdges(out, 1000, 0.01, 0.02);
    expect(out[0]).toBe(0);
    expect(out[999]).toBe(0);
    expect(out[500]).toBe(1);
  });

  it('crossfadeLoop makes the wrap-around continuous', () => {
    const length = 1000;
    const overlap = 200;
    const rendered = new Float32Array(length + overlap);
    for (let i = 0; i < rendered.length; i++) rendered[i] = Math.sin(i * 0.0371);
    const loop = crossfadeLoop(rendered, length);
    expect(loop.length).toBe(length);
    // The first loop sample is the render's sample at `length`: the one after the last.
    expect(loop[0]).toBeCloseTo(rendered[length] ?? 0, 5);
    expect(Math.abs((loop[0] ?? 0) - (loop[length - 1] ?? 0))).toBeLessThan(0.05);
  });
});

describe('sound library', () => {
  it('has a healthy number of distinct sounds', () => {
    expect(SOUND_COUNT).toBeGreaterThanOrEqual(25);
    expect(new Set(SOUND_IDS).size).toBe(SOUND_COUNT);
    for (const id of SOUND_IDS) expect(SOUND_IDS[soundIndexOf(id)]).toBe(id);
  });

  it('every definition has sane mix numbers', () => {
    for (const id of SOUND_IDS) {
      const def = SOUND_DEFS[id];
      expect(def.durationS, id).toBeGreaterThan(0.02);
      expect(def.durationS, id).toBeLessThanOrEqual(4);
      expect(def.gain, id).toBeGreaterThan(0);
      expect(def.gain, id).toBeLessThanOrEqual(1);
      expect(def.maxInstances, id).toBeGreaterThanOrEqual(1);
      expect(def.maxInstances, id).toBeLessThanOrEqual(4);
      expect(def.minRetriggerS, id).toBeGreaterThanOrEqual(0);
      expect(def.maxDistanceM, id).toBeGreaterThan(def.refDistanceM);
      expect(def.pitchJitter, id).toBeLessThanOrEqual(0.15);
      // A one-shot that may repeat must be limited by a gap as well as by its instance cap.
      if (!def.loop) expect(def.minRetriggerS, id).toBeGreaterThan(0);
      if (def.loop) expect(def.durationS, id).toBeGreaterThan(LOOP_OVERLAP_S * 2);
    }
  });

  it('every generator gives a finite, bounded, non-silent buffer of the expected length', () => {
    const renders = new Map<string, Float32Array>();
    const started = performance.now();
    for (const id of SOUND_IDS) renders.set(id, renderSound(id));
    const elapsedMs = performance.now() - started;
    let samples = 0;
    for (const id of SOUND_IDS) {
      const buffer = renders.get(id);
      expect(buffer, id).toBeDefined();
      if (buffer === undefined) continue;
      samples += buffer.length;
      expect(buffer.length, id).toBe(soundLength(id));
      expect(buffer.length, id).toBe(Math.round(SOUND_DEFS[id].durationS * SR));
      expect(allFinite(buffer), id).toBe(true);
      expect(peakOf(buffer), id).toBeCloseTo(RENDER_PEAK, 5);
      // Not a click in a silent buffer: real energy relative to the peak.
      expect(rmsOf(buffer), id).toBeGreaterThan(RENDER_PEAK * 0.04);
      if (!SOUND_DEFS[id].loop) {
        expect(Math.abs(buffer[0] ?? 1), id).toBeLessThan(0.01);
        expect(Math.abs(buffer[buffer.length - 1] ?? 1), id).toBeLessThan(0.01);
      }
    }
    console.info(
      `[audio] rendered ${SOUND_COUNT} sounds, ${(samples / SR).toFixed(1)} s of audio, in ` +
        `${elapsedMs.toFixed(1)} ms (node; includes cold JIT)`,
    );
    // Generous: this guards against an accidental O(n^2), not against a slow CI box.
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('is deterministic', () => {
    for (const id of SOUND_IDS) {
      const a = renderSound(id);
      const b = renderSound(id);
      expect(a.length).toBe(b.length);
      let same = true;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          same = false;
          break;
        }
      }
      expect(same, id).toBe(true);
    }
  });

  it('gives different sounds different samples', () => {
    const signatures = new Set<string>();
    for (const id of SOUND_IDS) {
      const buffer = renderSound(id);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 7) sum += (buffer[i] ?? 0) * (1 + (i % 13));
      signatures.add(`${buffer.length}:${sum.toFixed(6)}`);
    }
    expect(signatures.size).toBe(SOUND_COUNT);
  });

  it('loops wrap without a jump', () => {
    for (const id of SOUND_IDS) {
      if (!SOUND_DEFS[id].loop) continue;
      const buffer = renderSound(id);
      let largestStep = 0;
      for (let i = 1; i < buffer.length; i++) {
        const step = Math.abs((buffer[i] ?? 0) - (buffer[i - 1] ?? 0));
        if (step > largestStep) largestStep = step;
      }
      const wrap = Math.abs((buffer[0] ?? 0) - (buffer[buffer.length - 1] ?? 0));
      // The seam is no rougher than the roughest step inside the loop.
      expect(wrap, id).toBeLessThanOrEqual(largestStep * 1.05 + 1e-6);
    }
  });

  it('renders at other sample rates too', () => {
    const buffer = renderSound('fireBolt', 48_000);
    expect(buffer.length).toBe(soundLength('fireBolt', 48_000));
    expect(peakOf(buffer)).toBeCloseTo(RENDER_PEAK, 5);
  });
});
