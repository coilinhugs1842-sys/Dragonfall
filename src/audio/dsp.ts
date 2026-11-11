/**
 * Pure Float32Array DSP for the procedural placeholder sounds (T-3.8). No WebAudio here: the
 * same code runs in node tests and in the browser, and every generator is deterministic (its
 * only randomness is a seeded `Rng`). Everything is additive ("add a layer into `out`"), so a
 * sound is a few layer calls plus `normalise`.
 *
 * These run ONCE per sound at init, never per frame, so clarity wins over the last nanosecond;
 * still, the inner loops avoid `Math.pow`/`Math.tan` per sample.
 */

/** mulberry32: small, fast, good enough for noise. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [-1, 1). */
  bipolar(): number {
    return this.next() * 2 - 1;
  }
}

export type FilterMode = 'lp' | 'bp' | 'hp';

const TWO_PI = Math.PI * 2;

/**
 * Sine by table (nearest of 16384 entries: an error below -80 dB). The tones call it up to
 * twice per sample, which made `Math.sin` the largest part of the init cost.
 */
const SINE_BITS = 14;
const SINE_SIZE = 1 << SINE_BITS;
const SINE_MASK = SINE_SIZE - 1;
const SINE_SCALE = SINE_SIZE / TWO_PI;
const SINE_TABLE = new Float32Array(SINE_SIZE);
for (let i = 0; i < SINE_SIZE; i++) SINE_TABLE[i] = Math.sin((i + 0.5) / SINE_SCALE);

/** Any finite phase in radians, negative included. */
function fastSin(phase: number): number {
  return SINE_TABLE[Math.floor(phase * SINE_SCALE) & SINE_MASK] ?? 0;
}
/** Filter coefficients are refreshed every this many samples while a frequency sweeps. */
const COEF_INTERVAL = 16;

/** The filter's `g`. Called once per COEF_INTERVAL samples, so an exact `tan` costs nothing. */
function svfG(frequency: number, sampleRate: number): number {
  const limit = sampleRate * 0.45;
  const f = frequency < 10 ? 10 : frequency > limit ? limit : frequency;
  return Math.tan((Math.PI * f) / sampleRate);
}

function sampleIndex(seconds: number, sampleRate: number, length: number): number {
  const index = Math.round(seconds * sampleRate);
  return index < 0 ? 0 : index > length ? length : index;
}

/**
 * The shared envelope of the layers: a squared ramp up over `attackS`, then an exponential fall
 * (`decay` = how many e-folds over the rest; 0 = none) times a straight line to zero, so every
 * layer ends silent whatever its decay. A NEGATIVE `decay` holds the level instead (loops).
 */
function attackSamples(attackS: number, sampleRate: number, count: number): number {
  const n = Math.round(attackS * sampleRate);
  return n < 1 ? 1 : n > count ? count : n;
}

/**
 * Filtered white noise from `startS` for `durS`, its filter sweeping `f0` → `f1` (Hz,
 * exponentially). `q` is the resonance (0.5 = gentle, 4 = whistling).
 */
export function addNoise(
  out: Float32Array,
  sampleRate: number,
  rng: Rng,
  startS: number,
  durS: number,
  gain: number,
  mode: FilterMode,
  f0: number,
  f1: number,
  q: number,
  attackS: number,
  decay: number,
): void {
  const begin = sampleIndex(startS, sampleRate, out.length);
  const end = sampleIndex(startS + durS, sampleRate, out.length);
  const count = end - begin;
  if (count <= 0) return;
  const attack = attackSamples(attackS, sampleRate, count);
  const release = count - attack > 0 ? count - attack : 1;
  const hold = decay < 0;
  const decayStep = hold ? 1 : Math.exp(-decay / release);
  const sweep = Math.pow(f1 / f0, COEF_INTERVAL / count);
  const k = 1 / (q > 0.05 ? q : 0.05);
  // A band-pass at high Q is loud, a low-pass of white noise is quiet: even them out roughly.
  const makeup = mode === 'bp' ? k : 1;
  let frequency = f0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  let ic1 = 0;
  let ic2 = 0;
  let fall = 1;
  for (let i = 0; i < count; i++) {
    if (i % COEF_INTERVAL === 0) {
      const g = svfG(frequency, sampleRate);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
      frequency *= sweep;
    }
    const x = rng.bipolar();
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    const y = mode === 'lp' ? v2 : mode === 'bp' ? v1 * makeup : x - k * v1 - v2;
    let envelope: number;
    if (i < attack) {
      const u = i / attack;
      envelope = u * u;
    } else {
      envelope = hold ? 1 : fall * (1 - (i - attack) / release);
      fall *= decayStep;
    }
    const index = begin + i;
    out[index] = (out[index] ?? 0) + y * envelope * gain;
  }
}

/**
 * A sine from `startS` for `durS`, gliding `f0` → `f1` (exponentially), optionally phase
 * modulated by a second sine at `fmRatio` times its frequency whose depth goes `fmIndex0` →
 * `fmIndex1` (radians; 0 = a pure sine, 2+ = bell or buzz depending on the ratio).
 */
export function addTone(
  out: Float32Array,
  sampleRate: number,
  startS: number,
  durS: number,
  gain: number,
  f0: number,
  f1: number,
  attackS: number,
  decay: number,
  fmRatio = 0,
  fmIndex0 = 0,
  fmIndex1 = 0,
): void {
  const begin = sampleIndex(startS, sampleRate, out.length);
  const end = sampleIndex(startS + durS, sampleRate, out.length);
  const count = end - begin;
  if (count <= 0) return;
  const attack = attackSamples(attackS, sampleRate, count);
  const release = count - attack > 0 ? count - attack : 1;
  const hold = decay < 0;
  const decayStep = hold ? 1 : Math.exp(-decay / release);
  const glide = Math.pow(f1 / f0, 1 / count);
  const indexStep = (fmIndex1 - fmIndex0) / count;
  const modulated = fmRatio > 0 && (fmIndex0 !== 0 || fmIndex1 !== 0);
  let step = (TWO_PI * f0) / sampleRate;
  let phase = 0;
  let modPhase = 0;
  let fmIndex = fmIndex0;
  let fall = 1;
  for (let i = 0; i < count; i++) {
    let envelope: number;
    if (i < attack) {
      const u = i / attack;
      envelope = u * u;
    } else {
      envelope = hold ? 1 : fall * (1 - (i - attack) / release);
      fall *= decayStep;
    }
    const y = modulated ? fastSin(phase + fmIndex * fastSin(modPhase)) : fastSin(phase);
    const index = begin + i;
    out[index] = (out[index] ?? 0) + y * envelope * gain;
    phase += step;
    if (phase > TWO_PI) phase -= TWO_PI;
    if (modulated) {
      modPhase += step * fmRatio;
      if (modPhase > TWO_PI) modPhase -= TWO_PI;
      fmIndex += indexStep;
    }
    step *= glide;
  }
}

/**
 * Sparse crackle: about `ratePerS` random clicks a second, each a burst of noise that dies in
 * `clickS`, smoothed by a one-pole low-pass at `cutoffHz`. Sparks, static, embers.
 */
export function addCrackle(
  out: Float32Array,
  sampleRate: number,
  rng: Rng,
  startS: number,
  durS: number,
  gain: number,
  ratePerS: number,
  clickS: number,
  cutoffHz: number,
): void {
  const begin = sampleIndex(startS, sampleRate, out.length);
  const end = sampleIndex(startS + durS, sampleRate, out.length);
  const count = end - begin;
  if (count <= 0) return;
  const chance = ratePerS / sampleRate;
  const fall = Math.exp(-1 / (clickS * sampleRate));
  const smooth = 1 - Math.exp((-TWO_PI * cutoffHz) / sampleRate);
  const fade = Math.min(count, Math.round(0.01 * sampleRate)) || 1;
  let level = 0;
  let low = 0;
  for (let i = 0; i < count; i++) {
    if (rng.next() < chance) level = 0.4 + 0.6 * rng.next();
    low += (rng.bipolar() * level - low) * smooth;
    level *= fall;
    const tail = count - i;
    const edge = tail < fade ? tail / fade : 1;
    const index = begin + i;
    out[index] = (out[index] ?? 0) + low * gain * edge;
  }
}

/**
 * Multiplies the buffer by a slow random curve (smoothly interpolated values, `hz` new ones a
 * second, between `1 - depth` and 1): gusts, flicker, rumble lumps.
 */
export function wobble(
  out: Float32Array,
  sampleRate: number,
  rng: Rng,
  hz: number,
  depth: number,
): void {
  const span = Math.max(1, Math.round(sampleRate / hz));
  let from = 1 - depth * rng.next();
  let to = 1 - depth * rng.next();
  for (let i = 0; i < out.length; i++) {
    const within = i % span;
    if (within === 0 && i > 0) {
      from = to;
      to = 1 - depth * rng.next();
    }
    const u = within / span;
    // Smoothstep between the two values so the curve has no corners.
    const s = u * u * (3 - 2 * u);
    out[i] = (out[i] ?? 0) * (from + (to - from) * s);
  }
}

/** Sine amplitude modulation between `1 - depth` and 1. */
export function tremolo(out: Float32Array, sampleRate: number, hz: number, depth: number): void {
  const step = (TWO_PI * hz) / sampleRate;
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] ?? 0) * (1 - depth * (0.5 + 0.5 * Math.sin(i * step)));
  }
}

const COMB_DELAYS_S = [0.0297, 0.0371, 0.0411] as const;
const ALLPASS_DELAY_S = 0.0051;

/**
 * A small reverb tail mixed into the buffer in place: three feedback combs and one all-pass
 * (Schroeder). Far cheaper than convolving with decaying noise and close enough for
 * placeholders. `decayS` is roughly the time the tail takes to fall by 60 dB.
 */
export function addTail(out: Float32Array, sampleRate: number, mix: number, decayS: number): void {
  const length = out.length;
  const wet = new Float32Array(length);
  for (let c = 0; c < COMB_DELAYS_S.length; c++) {
    const delayS = COMB_DELAYS_S[c] ?? 0.03;
    const delay = Math.max(1, Math.round(delayS * sampleRate));
    const feedback = Math.pow(10, (-3 * delayS) / decayS);
    const line = new Float32Array(delay);
    let cursor = 0;
    let damp = 0;
    for (let i = 0; i < length; i++) {
      const delayed = line[cursor] ?? 0;
      // A little low-pass in the loop: the tail darkens as it fades, like a real space.
      damp += (delayed - damp) * 0.6;
      line[cursor] = (out[i] ?? 0) + damp * feedback;
      cursor = cursor + 1 === delay ? 0 : cursor + 1;
      wet[i] = (wet[i] ?? 0) + delayed;
    }
  }
  const delay = Math.max(1, Math.round(ALLPASS_DELAY_S * sampleRate));
  const line = new Float32Array(delay);
  let cursor = 0;
  const scale = mix / COMB_DELAYS_S.length;
  for (let i = 0; i < length; i++) {
    const delayed = line[cursor] ?? 0;
    const input = (wet[i] ?? 0) + delayed * 0.5;
    line[cursor] = input;
    cursor = cursor + 1 === delay ? 0 : cursor + 1;
    out[i] = (out[i] ?? 0) + (delayed - input * 0.5) * scale;
  }
}

/** Short linear fades at both ends so a buffer can never start or stop with a click. */
export function fadeEdges(out: Float32Array, sampleRate: number, inS: number, outS: number): void {
  const length = out.length;
  const fadeIn = Math.min(length, Math.round(inS * sampleRate));
  const fadeOut = Math.min(length, Math.round(outS * sampleRate));
  for (let i = 0; i < fadeIn; i++) out[i] = ((out[i] ?? 0) * i) / fadeIn;
  for (let i = 0; i < fadeOut; i++) {
    const index = length - 1 - i;
    out[index] = ((out[index] ?? 0) * i) / fadeOut;
  }
}

/** Removes any constant offset (a low sweep cut short can leave one). */
export function removeDc(out: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] ?? 0;
  const mean = out.length > 0 ? sum / out.length : 0;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) - mean;
}

export function peakOf(buffer: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = Math.abs(buffer[i] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
}

export function rmsOf(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = buffer[i] ?? 0;
    sum += value * value;
  }
  return buffer.length > 0 ? Math.sqrt(sum / buffer.length) : 0;
}

/** Scales the buffer so its peak is exactly `peak`. A silent buffer is left alone. */
export function normalise(out: Float32Array, peak: number): void {
  const current = peakOf(out);
  if (!(current > 1e-9)) return;
  const scale = peak / current;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * scale;
}

/**
 * Makes a seamless loop of `loopLength` samples out of a longer render: the extra samples after
 * the loop point are cross-faded (equal power, right for noise) over the start, so the jump
 * from the last sample back to the first lands on continuous material.
 */
export function crossfadeLoop(rendered: Float32Array, loopLength: number): Float32Array {
  const overlap = rendered.length - loopLength;
  const loop = rendered.slice(0, loopLength);
  for (let i = 0; i < overlap && i < loopLength; i++) {
    const u = i / overlap;
    const fadeIn = Math.sin(u * Math.PI * 0.5);
    const fadeOut = Math.cos(u * Math.PI * 0.5);
    loop[i] = (loop[i] ?? 0) * fadeIn + (rendered[loopLength + i] ?? 0) * fadeOut;
  }
  return loop;
}
