/**
 * Clock sync from PING/PONG (docs/NETWORKING.md: 2 Hz on `ctrl`). The client stamps a ping with
 * its own clock, the host echoes that stamp with its clock and full sim tick, and from each
 * pair the client learns:
 *
 * - RTT, smoothed, plus its jitter (RFC 6298 style: `srtt` and a mean deviation);
 * - the offset between the two clocks, so "host time now" = local time + offset;
 * - where the host's tick counter sits on the host clock, so "host tick now" is a number too.
 *
 * ROBUSTNESS: one pong delayed by a Wi-Fi hiccup must not move the clock. The offset of a sample
 * is only as good as the assumption that both directions took RTT/2, and the samples that took
 * the shortest round trip are the ones where that is closest to true (the NTP trick). So the
 * estimate is the offset of the lowest-RTT sample in a sliding window, and the value handed out
 * slews toward it a few ms per sample instead of jumping. RTT outliers are clamped before they
 * enter the smoothed RTT.
 *
 * Pure: no timers and no clock reads. The caller passes every timestamp in, so tests can drive
 * it with synthetic schedules. Nothing allocates after construction.
 *
 * What uses it: the first guess of the client's prediction tick, the reference for `expandTick`,
 * and RTT for the lag-compensation hint. The two control loops that matter for feel do NOT hang
 * on its accuracy: snapshot playback follows snapshot arrival times, and input timing follows
 * the host's ack margin.
 */

import { TICK_MS } from '../../shared';

/** Samples kept for the lowest-RTT filter: 8 s at 2 Hz. */
export const CLOCK_SYNC_WINDOW = 16;
/** A round trip longer than this is not a measurement of anything (tab was asleep). */
export const CLOCK_SYNC_MAX_RTT_MS = 5000;
/** The handed-out offset moves at most this far per sample toward the estimate... */
export const CLOCK_SYNC_SLEW_MS = 2;
/** ...unless it is this far off (first samples, host hitch, suspended tab): then it jumps. */
export const CLOCK_SYNC_SNAP_MS = 60;
/** Samples needed before `synced` is true. */
export const CLOCK_SYNC_MIN_SAMPLES = 3;

const RTT_GAIN = 1 / 8;
const RTT_VAR_GAIN = 1 / 4;
const TICK_EPOCH_GAIN = 1 / 8;

export class ClockSync {
  private readonly rtts: Float64Array;
  private readonly offsets: Float64Array;
  private readonly capacity: number;
  private stored = 0;
  private head = 0;

  private samples = 0;
  private rejectedSamples = 0;
  private srtt = 0;
  private rttVar = 0;
  private lastRtt = 0;
  private offset = 0;
  private tickEpoch = 0;

  constructor(windowSize: number = CLOCK_SYNC_WINDOW) {
    this.capacity = windowSize >= 1 ? Math.floor(windowSize) : 1;
    this.rtts = new Float64Array(this.capacity);
    this.offsets = new Float64Array(this.capacity);
  }

  /** Forget everything (new connection, reconnect). */
  reset(): void {
    this.stored = 0;
    this.head = 0;
    this.samples = 0;
    this.rejectedSamples = 0;
    this.srtt = 0;
    this.rttVar = 0;
    this.lastRtt = 0;
    this.offset = 0;
    this.tickEpoch = 0;
  }

  /**
   * Feeds one PONG. `clientSendMs` is the stamp echoed from the ping, `hostTimeMs`/`hostTick`
   * come from the pong, `clientRecvMs` is the local clock when the pong arrived (same clock as
   * the stamp). Returns false, changing nothing, for a sample that cannot be real: non-finite
   * numbers, a pong "received before it was sent", or an absurd round trip.
   */
  addSample(
    clientSendMs: number,
    hostTimeMs: number,
    hostTick: number,
    clientRecvMs: number,
  ): boolean {
    const rtt = clientRecvMs - clientSendMs;
    // `!(a >= b)` also rejects NaN.
    if (
      !(rtt >= 0) ||
      rtt > CLOCK_SYNC_MAX_RTT_MS ||
      !Number.isFinite(hostTimeMs) ||
      !Number.isFinite(hostTick) ||
      !Number.isFinite(clientRecvMs)
    ) {
      this.rejectedSamples++;
      return false;
    }

    // --- RTT ------------------------------------------------------------------------------------
    this.lastRtt = rtt;
    if (this.samples === 0) {
      this.srtt = rtt;
      this.rttVar = rtt * 0.5;
    } else {
      // A spike is let in only as far as the current spread explains; a real change of path
      // still gets through, because the spread widens with every clamped sample.
      const ceiling = this.srtt + 4 * this.rttVar + 10;
      const clamped = rtt > ceiling ? ceiling : rtt;
      const deviation = Math.abs(clamped - this.srtt);
      this.rttVar += (deviation - this.rttVar) * RTT_VAR_GAIN;
      this.srtt += (clamped - this.srtt) * RTT_GAIN;
    }

    // --- Clock offset: lowest-RTT sample in the window ---------------------------------------
    // The host stamped the pong half a round trip before it arrived.
    const sampleOffset = hostTimeMs + rtt * 0.5 - clientRecvMs;
    this.rtts[this.head] = rtt;
    this.offsets[this.head] = sampleOffset;
    this.head = (this.head + 1) % this.capacity;
    if (this.stored < this.capacity) this.stored++;

    let best = sampleOffset;
    let bestRtt = Infinity;
    for (let i = 0; i < this.stored; i++) {
      const candidate = this.rtts[i];
      const candidateOffset = this.offsets[i];
      if (candidate !== undefined && candidateOffset !== undefined && candidate < bestRtt) {
        bestRtt = candidate;
        best = candidateOffset;
      }
    }
    const offsetError = best - this.offset;
    if (this.samples < CLOCK_SYNC_MIN_SAMPLES || Math.abs(offsetError) > CLOCK_SYNC_SNAP_MS) {
      this.offset = best;
    } else if (offsetError > CLOCK_SYNC_SLEW_MS) {
      this.offset += CLOCK_SYNC_SLEW_MS;
    } else if (offsetError < -CLOCK_SYNC_SLEW_MS) {
      this.offset -= CLOCK_SYNC_SLEW_MS;
    } else {
      this.offset = best;
    }

    // --- Where the tick counter sits on the host clock -----------------------------------------
    // No network noise in this one, only the host's own sub-tick phase, so a plain average does.
    const sampleEpoch = hostTick * TICK_MS - hostTimeMs;
    if (this.samples === 0 || Math.abs(sampleEpoch - this.tickEpoch) > 2 * TICK_MS) {
      this.tickEpoch = sampleEpoch;
    } else {
      this.tickEpoch += (sampleEpoch - this.tickEpoch) * TICK_EPOCH_GAIN;
    }

    this.samples++;
    return true;
  }

  /** Accepted samples since the last reset. */
  get sampleCount(): number {
    return this.samples;
  }

  /** Samples refused as impossible. */
  get rejectedCount(): number {
    return this.rejectedSamples;
  }

  /** True once enough samples arrived for the estimates to be worth using. */
  get synced(): boolean {
    return this.samples >= CLOCK_SYNC_MIN_SAMPLES;
  }

  /** Smoothed round-trip time. 0 before the first sample. */
  get rttMs(): number {
    return this.srtt;
  }

  /** Mean deviation of the round-trip time (how much it wobbles). */
  get rttJitterMs(): number {
    return this.rttVar;
  }

  /** The newest raw round-trip time, unsmoothed (for a debug HUD). */
  get lastRttMs(): number {
    return this.lastRtt;
  }

  /** Shortest round trip in the window; Infinity before the first sample. */
  get minRttMs(): number {
    let min = Infinity;
    for (let i = 0; i < this.stored; i++) {
      const rtt = this.rtts[i];
      if (rtt !== undefined && rtt < min) min = rtt;
    }
    return min;
  }

  /** Host clock minus local clock, in ms. */
  get offsetMs(): number {
    return this.offset;
  }

  /** The host's clock reading at local time `localMs`. */
  hostTimeAt(localMs: number): number {
    return localMs + this.offset;
  }

  /**
   * The host's sim tick at local time `localMs`, as a fraction: `floor` of it is the tick the
   * host most likely finished last. Accurate to about a tick plus the path asymmetry; see the
   * note at the top about what may depend on it.
   */
  hostTickAt(localMs: number): number {
    // The pong's tick is the last one finished, on average half a tick ago.
    return (localMs + this.offset + this.tickEpoch) / TICK_MS + 0.5;
  }

  /** One-way latency estimate in whole ticks, rounded up (0 before the first sample). */
  get oneWayTicks(): number {
    return Math.ceil((this.srtt * 0.5) / TICK_MS);
  }
}
