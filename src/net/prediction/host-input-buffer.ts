/**
 * Host side of client input: one buffer per connected rider, between the INPUT decoder and
 * `sim.step`. This file is THE RULE for which input the host applies on which tick; client
 * prediction (`ClientPredictor`) is built to agree with it.
 *
 * THE TIMELINE. Client and host count the same ticks. An `InputFrame` with `tick = T` is the
 * input for host sim tick T, nothing else. The client therefore runs its prediction a little
 * AHEAD of the host (by the one-way latency plus a small margin, steered by `InputTiming`), so
 * that its input for tick T is already here when the host simulates T.
 *
 * WHAT THE HOST APPLIES ON TICK T (`take(T)`):
 * 1. The client's frame for T, if it has arrived. Every INPUT packet repeats the two frames
 *    before its newest one, so a lost packet is covered by either of the next two as long as
 *    one of them arrives before T is simulated.
 * 2. Otherwise the newest frame received from the client (normally the one for T-1), re-used
 *    as it is: same steer, same held buttons. Held buttons cause no new press edge, so a missing packet never
 *    fakes a dodge, and repeating the steer keeps a turning dragon turning (the best guess of
 *    what the client is doing, so the smallest correction afterwards). This lasts for at most
 *    INPUT_REPEAT_MAX_TICKS ticks.
 * 3. After that, nothing (`undefined`): the sim's own rule takes over and the dragon flies
 *    straight with the buttons it last held (`SimInputs`).
 *
 * A frame that arrives after its tick was simulated is NOT applied retroactively (the host
 * never rewinds). It still updates the "newest frame" of rule 2 if nothing newer is known.
 *
 * WHY PREDICTION STILL MATCHES. The client cannot know which of its frames were late, and does
 * not need to: a snapshot for tick S is the dragon's state AFTER tick S whatever input the host
 * used, so the client resets to it and replays its own inputs for S+1 onward. A substituted
 * input shows up once, as a small difference between predicted and authoritative state at S,
 * and is smoothed away. With the margin `InputTiming` keeps, that needs two packets in a row to
 * be lost.
 *
 * THE ACK. `ackTick` is the newest input tick received from the client. The host puts it in
 * every snapshot; `ackTick - snapshotTick` is the number of ticks of input the host has in hand
 * for this client, which is the measurement the client steers its clock with.
 *
 * Everything received is clamped again here (`writeClamped`); the decoder already did, but
 * this is the trust boundary. Nothing allocates after construction.
 */

import { BUTTON_MASK, copyInputFrame, createInputFrame } from '../../shared';
import type { InputFrame } from '../../shared';
import { STEER_UNITS, expandTick } from '../codec/quantize';
import { INPUT_FRAMES_PER_PACKET } from '../protocol';
import type { InputMessage } from '../protocol';
import { INPUT_RESYNC_TICKS } from './input-timing';

/** Frames further ahead of the host than this are not stored (about 1 s; power of two). */
export const HOST_INPUT_WINDOW_TICKS = 32;
/** How long the newest known frame stands in for missing ones before the dragon flies straight. */
export const INPUT_REPEAT_MAX_TICKS = 6;
/**
 * A packet whose newest tick is MORE than this far behind the newest one seen is not a reordered
 * packet: the client moved its clock back (resync). The buffer follows it.
 *
 * Tied to the client's rule. `InputTiming` only jumps for an error above INPUT_RESYNC_TICKS, so
 * the smallest step back is INPUT_RESYNC_TICKS + 1 ticks, and the first packet after it is then
 * INPUT_RESYNC_TICKS behind the last one before it (the client ticked once in between). Two
 * below that still catches the smallest jump when one packet on either side of it was lost,
 * and stays clear of ordinary reordering, which is a tick or two.
 */
export const INPUT_REWIND_TICKS = INPUT_RESYNC_TICKS - 2;

const SLOT_MASK = HOST_INPUT_WINDOW_TICKS - 1;

const HALF_PI = Math.PI / 2;

/**
 * Copies a received frame, forced into the legal range: steer onto the wire's `i16` grid in
 * [-1, 1] (NaN becomes 0), known buttons only, the aim inside its range. Same result as `sanitizeInputFrame` for anything
 * the decoder produces, but written as integer maths so no float crosses a call or a branch
 * (either would be boxed; this runs for every frame of every packet).
 */
function writeClamped(out: InputFrame, from: Readonly<InputFrame>, tick: number): void {
  out.tick = tick;
  out.steerX =
    (Math.max(-STEER_UNITS, Math.min(STEER_UNITS, Math.round(from.steerX * STEER_UNITS))) | 0) /
    STEER_UNITS;
  out.steerY =
    (Math.max(-STEER_UNITS, Math.min(STEER_UNITS, Math.round(from.steerY * STEER_UNITS))) | 0) /
    STEER_UNITS;
  out.buttons = from.buttons & BUTTON_MASK;
  // The aim: the decoder already keeps it in range; anything else (NaN included) aims level
  // along +Z, and the sim only reads it while BUTTON_AIM is set.
  const aimYaw = from.aimYaw;
  const aimPitch = from.aimPitch;
  out.aimYaw = aimYaw >= -Math.PI && aimYaw <= Math.PI ? aimYaw : 0;
  out.aimPitch = aimPitch >= -HALF_PI && aimPitch <= HALF_PI ? aimPitch : 0;
}

export class HostInputBuffer {
  private readonly slots: InputFrame[] = [];
  /** Full tick held by each slot, -1 = empty. */
  private readonly slotTicks = new Int32Array(HOST_INPUT_WINDOW_TICKS).fill(-1);
  /** Newest frame known for any tick (rule 2), and the frame handed out when repeating. */
  private readonly last = createInputFrame();
  private readonly repeat = createInputFrame();
  private lastTick = -1;
  private newest = -1;
  private taken = -1;

  private snapshotAck = 0;
  private snapshotAckValid = false;

  private packets = 0;
  private stored = 0;
  private late = 0;
  private repeated = 0;
  private empty = 0;

  constructor() {
    for (let i = 0; i < HOST_INPUT_WINDOW_TICKS; i++) this.slots.push(createInputFrame());
  }

  /** Forget everything (the rider left, reconnected, or a new match starts). */
  reset(): void {
    this.slotTicks.fill(-1);
    this.lastTick = -1;
    this.newest = -1;
    this.taken = -1;
    this.snapshotAck = 0;
    this.snapshotAckValid = false;
    this.packets = 0;
    this.stored = 0;
    this.late = 0;
    this.repeated = 0;
    this.empty = 0;
  }

  /**
   * Files the frames of a decoded INPUT message.
   *
   * @param hostTick The last tick the host has simulated (`sim.current.tick`): frames for it or
   *   anything older are late. Also the reference for expanding the 16-bit wire ticks.
   * @returns How many frames were new and in time.
   */
  push(msg: Readonly<InputMessage>, hostTick: number): number {
    this.packets++;
    const count =
      msg.frameCount < INPUT_FRAMES_PER_PACKET ? msg.frameCount : INPUT_FRAMES_PER_PACKET;
    let added = 0;
    for (let i = 0; i < count; i++) {
      const frame = msg.frames[i];
      if (frame === undefined) continue;
      const tick = expandTick(frame.tick, hostTick);
      if (tick < 0) continue;

      if (i === 0) {
        if (this.newest >= 0 && tick < this.newest - INPUT_REWIND_TICKS) {
          // The client stepped its clock back: frames filed for its old future are void.
          this.slotTicks.fill(-1);
          this.newest = tick;
          if (this.lastTick > tick) this.lastTick = -1;
        } else if (tick > this.newest) {
          this.newest = tick;
        }
        if (msg.hasAck) {
          this.snapshotAck = msg.ackSnapshotTick;
          this.snapshotAckValid = true;
        }
      }

      if (tick > this.lastTick) {
        writeClamped(this.last, frame, tick);
        this.lastTick = tick;
      }

      if (tick <= hostTick || tick <= this.taken) {
        if (i === 0) this.late++;
        continue;
      }
      // Too far ahead to store. `newest` above still moved, so the ack tells the client.
      if (tick > hostTick + HOST_INPUT_WINDOW_TICKS) continue;

      const index = tick & SLOT_MASK;
      if (this.slotTicks[index] === tick) continue;
      const slot = this.slots[index];
      if (slot === undefined) continue;
      writeClamped(slot, frame, tick);
      this.slotTicks[index] = tick;
      added++;
    }
    this.stored += added;
    return added;
  }

  /**
   * The input the host applies on `tick` (see the rule at the top), or undefined to let the sim
   * fly the dragon straight. Call exactly once per sim tick, in order, and put the result in
   * `SimInputs[playerId]`. The returned frame is reused by the next call.
   */
  take(tick: number): Readonly<InputFrame> | undefined {
    this.taken = tick;
    const index = tick & SLOT_MASK;
    if (this.slotTicks[index] === tick) {
      this.slotTicks[index] = -1;
      return this.slots[index];
    }
    // `lastTick` can be ahead of `tick` (the frame for T was lost for good but T+1 is here):
    // the newest frame is the best guess either way.
    if (this.lastTick >= 0 && tick - this.lastTick <= INPUT_REPEAT_MAX_TICKS) {
      this.repeated++;
      copyInputFrame(this.repeat, this.last);
      this.repeat.tick = tick;
      return this.repeat;
    }
    this.empty++;
    return undefined;
  }

  /** False until the first input arrived. */
  get hasAck(): boolean {
    return this.newest >= 0;
  }

  /** Full tick of the newest input received; goes into the snapshot as `ackInputTick`. */
  get ackTick(): number {
    return this.newest < 0 ? 0 : this.newest;
  }

  /** Ticks of input in hand beyond `hostTick` (negative = the client is behind). */
  margin(hostTick: number): number {
    return this.newest < 0 ? 0 : this.newest - hostTick;
  }

  /** False until an input carrying a snapshot ack arrived. */
  get hasSnapshotAck(): boolean {
    return this.snapshotAckValid;
  }

  /**
   * WIRE tick of the newest snapshot the client had when it sampled its newest input. Lag
   * compensation (Phase 3) rewinds targets to about this tick.
   */
  get ackSnapshotTick(): number {
    return this.snapshotAck;
  }

  /** INPUT packets received. */
  get packetCount(): number {
    return this.packets;
  }

  /** Frames stored in time for their tick. */
  get storedCount(): number {
    return this.stored;
  }

  /** Packets whose newest frame was already too late to apply. */
  get lateCount(): number {
    return this.late;
  }

  /** Ticks on which rule 2 repeated the newest known frame. */
  get repeatedCount(): number {
    return this.repeated;
  }

  /** Ticks on which the host had nothing to apply (rule 3). */
  get emptyCount(): number {
    return this.empty;
  }
}
