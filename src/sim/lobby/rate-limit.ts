/**
 * Token bucket per player for `ctrl` intents (docs/NETWORKING.md, "Trust": the host rate-limits
 * intents). Tick-based and clock-free, so it behaves the same in tests and in a worker. The
 * buckets are typed arrays indexed by player id: checking an intent allocates nothing.
 */

import type { PlayerId } from '../../shared/constants';
import { TICK_HZ } from '../../shared/constants';

/** Player ids are a `u8`. */
const BUCKET_COUNT = 256;

const TOKEN_EPSILON = 1e-9;

/** A burst this large passes at once (a player clicking through the class picker). */
export const INTENT_BURST = 10;
/** Sustained intents per second after the burst is spent. */
export const INTENT_REFILL_PER_S = 5;

export interface IntentRateLimiterOptions {
  /** Bucket size. */
  readonly burst?: number;
  /** Tokens regained per host tick. */
  readonly refillPerTick?: number;
}

export interface IntentRateLimiter {
  readonly burst: number;
  readonly refillPerTick: number;
  /** Tokens left, per player id. */
  readonly tokens: Float64Array;
  /** Tick of the last refill, per player id. */
  readonly lastTick: Float64Array;
}

export function createIntentRateLimiter(options: IntentRateLimiterOptions = {}): IntentRateLimiter {
  const burst = Math.max(1, options.burst ?? INTENT_BURST);
  const refillPerTick = Math.max(0, options.refillPerTick ?? INTENT_REFILL_PER_S / TICK_HZ);
  const tokens = new Float64Array(BUCKET_COUNT).fill(burst);
  return { burst, refillPerTick, tokens, lastTick: new Float64Array(BUCKET_COUNT) };
}

/**
 * Spends one token for `playerId` at host tick `tick`. False = over the limit: drop the intent.
 * Ticks are expected to be monotonic; a tick that goes backwards simply earns no refill.
 */
export function allowIntent(limiter: IntentRateLimiter, playerId: PlayerId, tick: number): boolean {
  if (!Number.isInteger(playerId) || playerId < 0 || playerId >= BUCKET_COUNT) return false;
  const last = limiter.lastTick[playerId] ?? 0;
  let tokens = limiter.tokens[playerId] ?? 0;
  if (tick > last) {
    tokens = Math.min(limiter.burst, tokens + (tick - last) * limiter.refillPerTick);
  }
  limiter.lastTick[playerId] = tick;
  // The epsilon absorbs float drift, so six ticks at 1/6 token per tick do add up to one.
  if (tokens < 1 - TOKEN_EPSILON) {
    limiter.tokens[playerId] = tokens;
    return false;
  }
  limiter.tokens[playerId] = Math.max(0, tokens - 1);
  return true;
}

/** Refills one player's bucket (call when a player id is handed to a new player), or all. */
export function resetIntentRateLimiter(limiter: IntentRateLimiter, playerId?: PlayerId): void {
  if (playerId === undefined) {
    limiter.tokens.fill(limiter.burst);
    limiter.lastTick.fill(0);
    return;
  }
  if (!Number.isInteger(playerId) || playerId < 0 || playerId >= BUCKET_COUNT) return;
  limiter.tokens[playerId] = limiter.burst;
  limiter.lastTick[playerId] = 0;
}
