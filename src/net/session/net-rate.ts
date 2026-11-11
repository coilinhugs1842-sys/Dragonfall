/**
 * Byte and packet counters for one session, with rates over a sliding one-second step. The
 * sessions feed it on every send and receive; `src/game` reads the rates for the perf HUD
 * ("KB/s up / down") and tests read the totals. Allocation-free.
 */

export const NET_RATE_INTERVAL_MS = 1000;

export class NetRate {
  /** Totals since construction or `reset`. */
  sentBytes = 0;
  receivedBytes = 0;
  sentPackets = 0;
  receivedPackets = 0;
  /** Messages a peer sent that were dropped unread (wrong type, wrong channel, failed decode). */
  rejectedPackets = 0;
  /** Rates over the last finished interval. */
  sentBytesPerS = 0;
  receivedBytesPerS = 0;
  sentPacketsPerS = 0;
  receivedPacketsPerS = 0;

  private markMs = -1;
  private markSentBytes = 0;
  private markReceivedBytes = 0;
  private markSentPackets = 0;
  private markReceivedPackets = 0;

  reset(): void {
    this.sentBytes = 0;
    this.receivedBytes = 0;
    this.sentPackets = 0;
    this.receivedPackets = 0;
    this.rejectedPackets = 0;
    this.sentBytesPerS = 0;
    this.receivedBytesPerS = 0;
    this.sentPacketsPerS = 0;
    this.receivedPacketsPerS = 0;
    this.markMs = -1;
    this.markSentBytes = 0;
    this.markReceivedBytes = 0;
    this.markSentPackets = 0;
    this.markReceivedPackets = 0;
  }

  addSent(bytes: number): void {
    this.sentBytes += bytes;
    this.sentPackets++;
  }

  addReceived(bytes: number): void {
    this.receivedBytes += bytes;
    this.receivedPackets++;
  }

  /** Rolls the rates over once per interval. Returns true when they changed. */
  update(nowMs: number): boolean {
    if (this.markMs < 0) {
      this.markMs = nowMs;
      return false;
    }
    const elapsed = nowMs - this.markMs;
    if (!(elapsed >= NET_RATE_INTERVAL_MS)) return false;
    const perS = 1000 / elapsed;
    this.sentBytesPerS = (this.sentBytes - this.markSentBytes) * perS;
    this.receivedBytesPerS = (this.receivedBytes - this.markReceivedBytes) * perS;
    this.sentPacketsPerS = (this.sentPackets - this.markSentPackets) * perS;
    this.receivedPacketsPerS = (this.receivedPackets - this.markReceivedPackets) * perS;
    this.markMs = nowMs;
    this.markSentBytes = this.sentBytes;
    this.markReceivedBytes = this.receivedBytes;
    this.markSentPackets = this.sentPackets;
    this.markReceivedPackets = this.receivedPackets;
    return true;
  }
}

/** `up 1.2 down 12.3 KB/s`, for the perf HUD's text line. */
export function formatNetRate(rate: Readonly<NetRate>): string {
  const up = (rate.sentBytesPerS / 1024).toFixed(1);
  const down = (rate.receivedBytesPerS / 1024).toFixed(1);
  return `up ${up} down ${down} KB/s`;
}
