/**
 * Frame cap for the "30 / 45 fps" setting (docs/PERFORMANCE.md, "Thermal headroom"). The browser
 * still calls back at the display rate; the gate says which of those callbacks should draw.
 *
 * It keeps a deadline that advances by exactly one interval per drawn frame, so the average rate
 * is the cap (45 fps on a 60 Hz display is a 1-2-1-1 pattern of display frames, averaging 22.2
 * ms) instead of drifting down to the next divisor of the refresh rate. No allocation.
 */

/** A callback this much before its deadline still draws (display callbacks jitter by ~1 ms). */
export const FRAME_CAP_SLACK_MS = 1.5;

export class FrameCap {
  private intervalMs = 0;
  private nextMs = Number.NEGATIVE_INFINITY;

  /** 0 (or anything not above 0) = no cap. */
  setCap(fps: number): void {
    this.intervalMs = fps > 0 ? 1000 / fps : 0;
    this.nextMs = Number.NEGATIVE_INFINITY;
  }

  get capFps(): number {
    return this.intervalMs > 0 ? 1000 / this.intervalMs : 0;
  }

  /** Call once per animation-frame callback with its timestamp. True = step and draw this one. */
  shouldRender(nowMs: number): boolean {
    const interval = this.intervalMs;
    if (interval <= 0) return true;
    if (nowMs + FRAME_CAP_SLACK_MS < this.nextMs) return false;
    // After a stall (hidden tab, long frame) start again from now instead of bursting to catch up.
    const next = this.nextMs + interval;
    this.nextMs = next < nowMs - interval ? nowMs + interval : next;
    return true;
  }
}
