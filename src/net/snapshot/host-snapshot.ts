/**
 * Host side of snapshots: WHEN to send one and WHAT goes into it for each recipient.
 *
 * WHEN: the sim runs at 30 Hz and snapshots go out at 20 Hz, so two of every three ticks carry
 * one (`shouldSendSnapshot`). The gaps alternate between one and two ticks (33 ms / 67 ms).
 * That is fine because a snapshot is stamped with its sim tick: the client interpolates on tick
 * time, not on arrival time, so uneven spacing costs nothing. Sending on whole ticks keeps every
 * snapshot an exact sim state (no host-side interpolation, nothing to disagree with prediction).
 *
 * WHAT: the dragon list, the projectile and zone records, the storm radius and the clock are
 * the same for everyone and are filled once per tick (`begin`). Per recipient three things
 * change (`forRecipient`): the input ack, the owner block (the recipient's own dragon at full
 * precision, for reconciliation), and which dragons are listed at all: a VEILED dragon is left
 * out of the snapshots of the other team, so an enemy client has nothing to draw (or to read
 * out of memory). Its own team and spectators still get it, with DRAGON_FLAG_VEILED set.
 * One message struct is reused for all of it; encode it before asking for the next recipient.
 *
 * Usage, once per host tick after `sim.step`:
 *
 *   if (shouldSendSnapshot(sim.current.tick)) {
 *     builder.begin(sim.current, clock);
 *     for (each connected client) {
 *       const msg = builder.forRecipient(playerId, inputs.hasAck, inputs.ackTick);
 *       const n = encodeSnapshot(fastWriter, msg);
 *       if (n > 0) transport.send(link, 'fast', fastWriter.packet(n));
 *     }
 *   }
 */

import { DRAGON_FLAG_VEILED, NO_PLAYER, SNAPSHOT_HZ, TICK_HZ } from '../../shared';
import type { MatchPhase, PlayerId } from '../../shared';
import { findDragon } from '../../sim';
import type { SimState } from '../../sim';
import { fillSnapshotDragons, fillSnapshotEffects, setSnapshotOwner } from '../codec/fast';
import { createSnapshotMessage } from '../protocol';
import type { SnapshotDragon, SnapshotMessage } from '../protocol';

/**
 * Longest run of ticks between two snapshots when nothing is lost (2 at 30 Hz sim / 20 Hz
 * snapshots). The client's interpolation delay has to cover at least this.
 */
export const SNAPSHOT_MAX_GAP_TICKS = Math.ceil(TICK_HZ / SNAPSHOT_HZ);

/**
 * True on the sim ticks that carry a snapshot: SNAPSHOT_HZ of every TICK_HZ ticks, spread as
 * evenly as whole ticks allow (ticks 0, 2, 3, 5, 6, 8, ... at 30/20). Integer maths only, so it
 * is exact for any tick and identical on every machine. Negative and fractional ticks: false.
 */
export function shouldSendSnapshot(tick: number): boolean {
  if (!(tick >= 0) || !Number.isInteger(tick)) return false;
  if (SNAPSHOT_HZ >= TICK_HZ) return true;
  // The running total `tick * SNAPSHOT_HZ` crosses a multiple of TICK_HZ on the ticks that send.
  return ((tick % TICK_HZ) * SNAPSHOT_HZ) % TICK_HZ < SNAPSHOT_HZ;
}

/** The match clock as the snapshot carries it. The phases that own these numbers fill it. */
export interface SnapshotClock {
  phase: MatchPhase;
  /** 1-based. */
  round: number;
  /** Seconds since the phase started. */
  phaseTimeS: number;
  /** Seconds left in the round or match, Infinity with no limit. */
  timeRemainingS: number;
  scoreEmber: number;
  scoreFrost: number;
}

export function createSnapshotClock(): SnapshotClock {
  return {
    phase: 'playing',
    round: 1,
    phaseTimeS: 0,
    timeRemainingS: Infinity,
    scoreEmber: 0,
    scoreFrost: 0,
  };
}

export class HostSnapshotBuilder {
  /** The one reused message. Valid for encoding between `forRecipient` calls. */
  readonly message: SnapshotMessage = createSnapshotMessage();
  private state: Readonly<SimState> | null = null;
  /** This tick's dragons in fill order (`message.dragons` is re-ordered per recipient). */
  private readonly all: SnapshotDragon[] = [];
  /** Team of each entry of `all`, and whether it is veiled. */
  private readonly teams: number[] = [];
  private total = 0;
  private veiled = 0;
  /** `message.dragons` currently lists fewer than `all`. */
  private filtered = false;

  /**
   * Start of a snapshot tick: copies every active dragon and the clock into the message.
   * `state` is read again by `forRecipient`, so it must stay untouched until the last recipient
   * of this tick is encoded (i.e. do all of it before the next `sim.step`).
   */
  begin(state: Readonly<SimState>, clock: Readonly<SnapshotClock>): void {
    const message = this.message;
    this.restoreOrder();
    fillSnapshotDragons(message, state);
    fillSnapshotEffects(message, state);
    // Who is veiled this tick, and on which team. Same walk as `fillSnapshotDragons`.
    let count = 0;
    let veiled = 0;
    for (let i = 0; i < state.dragons.length && count < message.dragonCount; i++) {
      const dragon = state.dragons[i];
      const entry = message.dragons[count];
      if (dragon === undefined || !dragon.active || entry === undefined) continue;
      this.all[count] = entry;
      this.teams[count] = dragon.team;
      if ((dragon.flags & DRAGON_FLAG_VEILED) !== 0) veiled++;
      count++;
    }
    this.total = count;
    this.veiled = veiled;
    message.phase = clock.phase;
    message.round = clock.round;
    message.phaseTimeS = clock.phaseTimeS;
    message.timeRemainingS = clock.timeRemainingS;
    message.scoreEmber = clock.scoreEmber;
    message.scoreFrost = clock.scoreFrost;
    message.hasAck = false;
    message.ackInputTick = 0;
    message.hasOwner = false;
    this.state = state;
  }

  /**
   * Fills the per-recipient part and returns the message, ready for `encodeSnapshot`.
   *
   * @param playerId The recipient. NO_PLAYER (a spectator) or a rider without a dragon gets no
   *   owner block.
   * @param hasAck False until the host has received an input from this recipient.
   * @param ackInputTick Tick of the NEWEST input the host holds from this recipient
   *   (`HostInputBuffer.ackTick`, full or wire). It may be ahead of the snapshot's tick: the
   *   difference is how many ticks of input the host has in hand, which is what the client
   *   steers its send timing with (`InputTiming`).
   */
  forRecipient(playerId: PlayerId, hasAck: boolean, ackInputTick: number): SnapshotMessage {
    const message = this.message;
    message.hasAck = hasAck;
    message.ackInputTick = hasAck ? ackInputTick & 0xffff : 0;
    const state = this.state;
    const dragon =
      state !== null && playerId !== NO_PLAYER ? findDragon(state, playerId) : undefined;
    setSnapshotOwner(message, dragon);

    // Veiled enemies are not sent at all. Riders only: a spectator sees everyone.
    if (this.veiled > 0 && dragon !== undefined) {
      const team = dragon.team;
      let kept = 0;
      let hidden = this.total;
      for (let i = 0; i < this.total; i++) {
        const entry = this.all[i];
        if (entry === undefined) continue;
        if ((entry.flags & DRAGON_FLAG_VEILED) !== 0 && this.teams[i] !== team) {
          // Parked behind the live entries, so the array stays a permutation of its slots.
          message.dragons[--hidden] = entry;
        } else {
          message.dragons[kept++] = entry;
        }
      }
      message.dragonCount = kept;
      this.filtered = true;
    } else if (this.filtered) {
      this.restoreOrder();
    }
    return message;
  }

  /** Puts `message.dragons` back in fill order with every dragon listed. */
  private restoreOrder(): void {
    if (!this.filtered) return;
    const message = this.message;
    for (let i = 0; i < this.total; i++) {
      const entry = this.all[i];
      if (entry !== undefined) message.dragons[i] = entry;
    }
    message.dragonCount = this.total;
    this.filtered = false;
  }
}
