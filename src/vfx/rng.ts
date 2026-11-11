/**
 * Seeded random numbers for effect variation. Effects are cosmetic, but they still never use
 * `Math.random`: the same seed gives the same particles, so tests and screenshots are repeatable.
 * Allocation-free: the state is one integer in a caller-owned object.
 */

export interface Rng {
  /** 32-bit state. */
  s: number;
}

export function createRng(seed: number): Rng {
  return { s: seed >>> 0 };
}

export function seedRng(rng: Rng, seed: number): void {
  rng.s = seed >>> 0;
}

/** mulberry32: uniform in [0, 1). */
export function nextFloat(rng: Rng): number {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform in [min, max). */
export function nextRange(rng: Rng, min: number, max: number): number {
  return min + (max - min) * nextFloat(rng);
}

/** Stateless integer hash to [0, 1): the same input always gives the same value. */
export function hash01(n: number): number {
  let t = (Math.imul(n | 0, 0x9e3779b1) + 0x7f4a7c15) >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
  t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}
