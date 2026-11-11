/**
 * The clock remote dragons are drawn on: host tick time, a little in the past.
 *
 * Every snapshot is stamped with its sim tick, and the buffer notes the local time it arrived.
 * From those pairs this clock keeps three estimates:
 *
 * - `offset`: the average of (tick time - arrival time), i.e. where host tick time sits on the
 *   local clock for a snapshot of average lateness;
 * - `jitter`: the mean deviation of single arrivals from that average;
 * - `delay`: how far behind the average the playhead should run. It must cover the longest
 *   normal gap between snapshots (two ticks, see `shouldSendSnapshot`) plus the jitter, so:
 *   `clamp(gap + 3 * jitter, 70 ms, 150 ms)`. Clean LAN sits at 70 ms, the "bad Wi-Fi" profile
 *   (80 +- 20 ms) lands near the nominal 100 ms.
 *
 * The playhead never jumps to its target. `update` moves it by the frame time scaled by a rate
 * within +-`PLAYBACK_MAX_WARP` of 1, chosen to close the error in about half a second, and the
 * delay itself slews (quickly up when jitter appears, slowly down when it calms). So a change of
 * delay, a drifting host clock and a noisy offset estimate all turn into a few percent of time
 * warp that nobody sees, and playback never runs backwards. Two exceptions, both a jump:
 *
 * - an error larger than `PLAYBACK_SNAP_MS` (first snapshot, tab was asleep);
 * - the playhead has run AHEAD OF THE DATA: `PLAYBACK_AHEAD_CONFIRM` snapshots in a row each
 *   arrived after the playhead had already passed their tick. That is not jitter (the delay
 *   covers three deviations of it) and not loss (a lost snapshot never arrives at all): the
 *   whole timeline moved later, because the path got slower or the host dropped sim time in a
 *   hitch. Warping 5 % would leave every remote dragon extrapolating, then frozen, for twenty
 *   times the shift, so the clock re-anchors on the newest arrival and jumps back once.
 *
 * Pure and allocation-free: the caller passes every timestamp in.
 */

import {
  INTERP_DELAY_MAX_MS,
  INTERP_DELAY_MIN_MS,
  INTERP_DELAY_MS,
  SNAPSHOT_HZ,
  TICK_HZ,
  TICK_MS,
} from '../../shared';

/** Longest gap between two snapshots with no loss (two ticks at 30/20). */
const SNAPSHOT_MAX_GAP_MS = Math.ceil(TICK_HZ / SNAPSHOT_HZ) * TICK_MS;

/** Delay = gap + this many mean deviations of arrival jitter. */
export const PLAYBACK_JITTER_MULTIPLIER = 3;
/** The playback rate stays within 1 +- this. */
export const PLAYBACK_MAX_WARP = 0.05;
/** Playhead error (ms) that is jumped instead of warped away. */
export const PLAYBACK_SNAP_MS = 300;
/**
 * Newest snapshots in a row that must arrive behind the playhead before it re-anchors (about
 * 150 ms at 20 Hz: long enough that one late packet never does it).
 */
export const PLAYBACK_AHEAD_CONFIRM = 3;
/** The delay grows at most this fast when jitter rises... */
export const PLAYBACK_DELAY_RISE_MS_PER_S = 60;
/** ...and shrinks at most this fast when the link calms down. */
export const PLAYBACK_DELAY_FALL_MS_PER_S = 10;

/** 1 / (ms it takes to close a playhead error). */
const RATE_GAIN_PER_MS = 1 / 500;
const OFFSET_GAIN = 1 / 20;
const JITTER_GAIN = 1 / 16;
/** A frame longer than this is a stall, not playback time: the playhead re-anchors. */
const MAX_FRAME_MS = 250;

// NOTE: no float-taking helper functions in this file, and no variable that is an integer
// literal on one path and a float on another. Both make the optimising compilers box the float
// on the heap, and `update` runs every frame; clamps are written with Math.min/Math.max, which
// compile to machine code without a call. (See the note above `SnapshotBuffer.sample`.)

export class PlaybackClock {
  private samples = 0;
  private offset = 0;
  private jitter = 0;
  private delay = INTERP_DELAY_MS;
  private playMs = 0;
  /**
   * Play position as a fractional full host tick. READ ONLY for callers: `update` writes it.
   * (A plain field, not a getter: a float returned from a call that is not inlined is boxed.)
   */
  playTick = 0;
  private lastNowMs = 0;
  private started = false;
  private lastRate = 1;
  private snaps = 0;
  /** Tick time (ms) of the newest snapshot seen. */
  private newestMs = 0;
  /** Newest snapshots in a row that arrived with the playhead already past them. */
  private aheadCount = 0;
  /** The next `update` jumps to its target (set when the clock re-anchored). */
  private reanchored = false;

  reset(): void {
    this.samples = 0;
    this.offset = 0;
    this.jitter = 0;
    this.delay = INTERP_DELAY_MS;
    this.playMs = 0;
    this.playTick = 0;
    this.lastNowMs = 0;
    this.started = false;
    this.lastRate = 1;
    this.snaps = 0;
    this.newestMs = 0;
    this.aheadCount = 0;
    this.reanchored = false;
  }

  /**
   * Notes the arrival of the snapshot for full tick `tick` at local time `recvMs`. Call it for
   * every snapshot that was not a duplicate, late ones included: their lateness IS the jitter.
   */
  onSnapshot(tick: number, recvMs: number): void {
    const tickMs = tick * TICK_MS;
    const sample = tickMs - recvMs;
    if (!Number.isFinite(sample)) return;
    if (this.samples === 0) {
      this.offset = sample;
      this.jitter = 0;
      this.samples = 1;
      this.newestMs = tickMs;
      return;
    }
    if (tickMs > this.newestMs) {
      this.newestMs = tickMs;
      // Where the playhead is at this moment (it was last moved at `lastNowMs`).
      const sinceFrameMs = Math.max(0, Math.min(MAX_FRAME_MS, recvMs - this.lastNowMs));
      if (this.started && this.playMs + sinceFrameMs > tickMs) {
        if (++this.aheadCount >= PLAYBACK_AHEAD_CONFIRM) {
          // The timeline moved later for good: start the estimate again from this arrival (the
          // average would take a second or two to follow) and let `update` jump to it.
          this.aheadCount = 0;
          this.offset = sample;
          this.samples = 1;
          this.reanchored = true;
          return;
        }
      } else {
        this.aheadCount = 0;
      }
    }
    // One wild arrival may not drag the estimates: it only counts as far as the usual spread
    // (or two ticks, whichever is more). A real shift in latency still gets through, a step at
    // a time, because the spread widens with every clamped sample.
    const limit = Math.max(4 * this.jitter, 2 * TICK_MS);
    const step = Math.max(-limit, Math.min(limit, sample - this.offset));
    this.jitter += (Math.abs(step) - this.jitter) * JITTER_GAIN;
    // Converge quickly over the first arrivals, then settle to a slow average.
    const gain = Math.max(OFFSET_GAIN, 1 / (this.samples + 1));
    this.offset += step * gain;
    this.samples++;
  }

  /**
   * Advances the playhead to local time `nowMs` (once per rendered frame); read the result from
   * `playTick`. Before the first snapshot it does nothing. (Returns nothing on purpose: a float
   * returned from a call the JIT did not inline is boxed, and this runs every frame.)
   */
  update(nowMs: number): void {
    if (this.samples === 0 || !Number.isFinite(nowMs)) return;

    const wanted = Math.max(
      INTERP_DELAY_MIN_MS,
      Math.min(INTERP_DELAY_MAX_MS, SNAPSHOT_MAX_GAP_MS + PLAYBACK_JITTER_MULTIPLIER * this.jitter),
    );
    if (!this.started) {
      this.started = true;
      this.delay = Math.max(wanted, INTERP_DELAY_MS);
      this.playMs = nowMs + this.offset - this.delay;
      this.playTick = this.playMs / TICK_MS;
      this.lastNowMs = nowMs;
      this.lastRate = 1;
      return;
    }

    const elapsedMs = nowMs - this.lastNowMs;
    this.lastNowMs = nowMs;
    if (!(elapsedMs > 0)) return;
    const stalled = elapsedMs > MAX_FRAME_MS;
    const dtMs = Math.min(elapsedMs, MAX_FRAME_MS);

    const dtS = dtMs / 1000;
    if (wanted > this.delay) {
      this.delay = Math.min(wanted, this.delay + PLAYBACK_DELAY_RISE_MS_PER_S * dtS);
    } else {
      this.delay = Math.max(wanted, this.delay - PLAYBACK_DELAY_FALL_MS_PER_S * dtS);
    }

    const target = nowMs + this.offset - this.delay;
    const error = target - (this.playMs + dtMs);
    if (stalled || this.reanchored || Math.abs(error) > PLAYBACK_SNAP_MS) {
      this.reanchored = false;
      this.playMs = target;
      this.playTick = this.playMs / TICK_MS;
      this.lastRate = 1;
      this.snaps++;
      return;
    }
    const rate =
      1 + Math.max(-PLAYBACK_MAX_WARP, Math.min(PLAYBACK_MAX_WARP, error * RATE_GAIN_PER_MS));
    this.lastRate = rate;
    this.playMs += dtMs * rate;
    this.playTick = this.playMs / TICK_MS;
  }

  /** True once a snapshot arrived and `update` ran. */
  get running(): boolean {
    return this.started;
  }

  /** The interpolation delay in use right now (ms). */
  get delayMs(): number {
    return this.delay;
  }

  /** Mean deviation of snapshot arrival times (ms). */
  get jitterMs(): number {
    return this.jitter;
  }

  /** Playback rate of the last `update` (1 = real time). */
  get rate(): number {
    return this.lastRate;
  }

  /** How many times the playhead jumped instead of warping. */
  get snapCount(): number {
    return this.snaps;
  }

  /**
   * Estimated newest host tick time "in the air": the tick a snapshot arriving right now, with
   * average lateness, would carry. For debug HUDs.
   */
  estimatedArrivalTick(nowMs: number): number {
    return (nowMs + this.offset) / TICK_MS;
  }
}
