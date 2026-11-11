/**
 * Tiny deterministic PRNG (mulberry32) for procedural content: the same seed gives the same
 * sequence in every browser, which `Math.random` cannot promise. Integer-only state, so it is
 * bit-exact across engines.
 */

/** Returns a generator of floats in [0, 1). `seed` is truncated to a `u32`. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
