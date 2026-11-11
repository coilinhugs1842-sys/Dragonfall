/**
 * Keeps the client's prediction clock the right distance ahead of the host.
 *
 * The client's input for tick T must reach the host before the host simulates T (see
 * `HostInputBuffer`), so the client runs ahead by the one-way latency plus a margin. Latency
 * changes and the two machines' clocks drift (a 60.1 Hz display against a 59.9 Hz one is a tick
 * every 5 s), so the lead is closed-loop: every snapshot carries `ackInputTick`, the newest
 * input tick the host holds for this client, and
 *
 *   margin = ackInputTick - snapshotTick
 *
 * is how many ticks of this client's input the host had in hand right after simulating the
 * snapshot's tick. Zero or less means the host ran dry (it had to guess); a large margin means
 * the client's inputs sit in the host's buffer for nothing, which is pure added input delay.
 *
 * THE LOOP. Over the last second of snapshots take the LOWEST margin (the worst moment is what
 * has to be covered, and that automatically accounts for jitter and loss on the uplink):
 * - lowest < INPUT_MARGIN_TARGET_TICKS: run the client's sim clock slightly fast;
 * - lowest > target + INPUT_MARGIN_DEADBAND_TICKS: run it slightly slow;
 * - in between: real time.
 * "Slightly" is at most INPUT_MAX_DILATION (3 %): `timeScale` is a factor for the frame time
 * the client feeds its fixed-step loop, and nobody can see 3 %. Growing margin = the host's
 * input buffer growing = the client clock running fast, so this is also the drift correction.
 *
 * RESYNC. If the margin is off by more than INPUT_RESYNC_TICKS for several snapshots in a row
 * (tab was suspended, a long stall dropped sim time, the first guess was wrong), dilation would
 * take many seconds. `resyncTicks` then asks for a jump: add it to the prediction tick
 * (`ClientPredictor.shiftTick`) and call `resyncApplied`.
 *
 * Pure and allocation-free. Ticks may be passed full or as 16-bit wire values.
 */

import { SNAPSHOT_INTERVAL_MS, TICK_MS } from '../../shared';
import { tickDiff } from '../codec/quantize';

/** The lowest margin of the last second should not go below this. */
export const INPUT_MARGIN_TARGET_TICKS = 1;
/** ...and the clock is left alone while it is no more than this far above the target. */
export const INPUT_MARGIN_DEADBAND_TICKS = 1;
/** Snapshots in the window the lowest margin is taken over (1 s at 20 Hz). */
export const INPUT_TIMING_WINDOW = 20;
/** `timeScale` stays within 1 +- this. */
export const INPUT_MAX_DILATION = 0.03;
/** Dilation per tick of margin error. */
export const INPUT_DILATION_PER_TICK = 0.015;
/** A margin error beyond this (in ticks), sustained, is jumped instead of dilated away. */
export const INPUT_RESYNC_TICKS = 6;
/** Snapshots in a row that must agree before a jump is asked for. */
export const INPUT_RESYNC_CONFIRM = 3;

/**
 * First guess of how many ticks the client's prediction should run ahead of the host tick it
 * estimates from clock sync: one-way latency, its jitter, the target margin and one tick for
 * the estimate being off. The loop above takes over from there.
 */
export function initialInputLeadTicks(rttMs: number, rttJitterMs: number): number {
  const oneWayMs = (rttMs > 0 ? rttMs : 0) * 0.5 + (rttJitterMs > 0 ? rttJitterMs : 0);
  return Math.ceil(oneWayMs / TICK_MS) + INPUT_MARGIN_TARGET_TICKS + 1;
}

export class InputTiming {
  private readonly margins = new Int16Array(INPUT_TIMING_WINDOW);
  private filled = 0;
  private head = 0;
  private latest = 0;
  private lowest = 0;
  private scale = 1;
  private offCount = 0;
  private resync = 0;
  private holdoff = 0;
  private samples = 0;

  /** Forget everything (new match, reconnect). */
  reset(): void {
    this.filled = 0;
    this.head = 0;
    this.latest = 0;
    this.lowest = 0;
    this.scale = 1;
    this.offCount = 0;
    this.resync = 0;
    this.holdoff = 0;
    this.samples = 0;
  }

  /**
   * Feeds the ack of one snapshot. Call it for every snapshot that was newer than the last one
   * (a stale margin says nothing about now).
   */
  onSnapshot(hasAck: boolean, ackInputTick: number, snapshotTick: number): void {
    // No input has reached the host yet: nothing to measure, the first guess stands.
    if (!hasAck) return;
    if (this.holdoff > 0) {
      // Still looking at inputs sent before the last jump.
      this.holdoff--;
      return;
    }
    const margin = tickDiff(ackInputTick, snapshotTick);
    this.latest = margin;
    this.samples++;
    this.margins[this.head] = margin;
    this.head = (this.head + 1) % INPUT_TIMING_WINDOW;
    if (this.filled < INPUT_TIMING_WINDOW) this.filled++;

    let lowest = margin;
    for (let i = 0; i < this.filled; i++) {
      const value = this.margins[i];
      if (value !== undefined && value < lowest) lowest = value;
    }
    this.lowest = lowest;

    // --- Jump? ------------------------------------------------------------------------------
    const wanted = INPUT_MARGIN_TARGET_TICKS + 1;
    const error = wanted - margin;
    if (error > INPUT_RESYNC_TICKS || error < -INPUT_RESYNC_TICKS) {
      this.offCount++;
      if (this.offCount >= INPUT_RESYNC_CONFIRM) this.resync = error;
    } else {
      this.offCount = 0;
      this.resync = 0;
    }

    // --- Dilation -----------------------------------------------------------------------------
    // Whole ticks below the target, or above the dead band (one of the two is 0).
    const below = Math.max(0, INPUT_MARGIN_TARGET_TICKS - lowest);
    const above = Math.max(0, lowest - INPUT_MARGIN_TARGET_TICKS - INPUT_MARGIN_DEADBAND_TICKS);
    const dilation = Math.max(
      -INPUT_MAX_DILATION,
      Math.min(INPUT_MAX_DILATION, (below - above) * INPUT_DILATION_PER_TICK),
    );
    this.scale = 1 + dilation;
  }

  /**
   * Factor for the frame time fed to the client's fixed-step loop: above 1 the client's sim
   * clock runs fast (it was behind), below 1 slow. Within 1 +- INPUT_MAX_DILATION.
   */
  get timeScale(): number {
    return this.scale;
  }

  /**
   * Non-zero when the prediction tick should jump by this many ticks (positive = forward).
   * Apply it with `ClientPredictor.shiftTick`, then call `resyncApplied`.
   */
  get resyncTicks(): number {
    return this.resync;
  }

  /**
   * Tells the loop the jump was made. Margins measured on inputs sent before the jump are still
   * in flight for about a round trip, so that many snapshots are skipped.
   */
  resyncApplied(rttMs: number): void {
    this.resync = 0;
    this.offCount = 0;
    this.filled = 0;
    this.head = 0;
    this.scale = 1;
    const rtt = rttMs > 0 && Number.isFinite(rttMs) ? rttMs : 0;
    this.holdoff = Math.ceil((rtt + 2 * TICK_MS) / SNAPSHOT_INTERVAL_MS) + 2;
  }

  /** Margin of the newest snapshot, in ticks. */
  get marginTicks(): number {
    return this.latest;
  }

  /** Lowest margin in the window. */
  get lowestMarginTicks(): number {
    return this.lowest;
  }

  /** Margins measured since the last reset. */
  get sampleCount(): number {
    return this.samples;
  }
}
