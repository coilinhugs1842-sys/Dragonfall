/**
 * Host lag compensation (T-3.3, docs/NETWORKING.md "Prediction, reconciliation, lag
 * compensation"): hits are tested against where the SHOOTER saw its targets.
 *
 * A client draws the other dragons in the past (snapshot interpolation) and its input for tick
 * T only reaches the host later, so by the time the host executes a shot the target has flown
 * on: at 45 m/s and 150 ms that is 6.75 m, more than a hit sphere. The host therefore keeps a
 * short history of every dragon and answers combat's `TargetPositionSource` with the position
 * `rewind` ticks ago, per shooter.
 *
 * HISTORY. A fixed ring of LAG_COMP_HISTORY_TICKS entries per dragon slot (position, tick and
 * whether the dragon could be hit), written by `record` after every sim step. 16 ticks = 533 ms:
 * a power of two that covers the 300 ms the doc asks for (LAG_COMP_HISTORY_MS) with room to
 * spare over the 200 ms cap.
 *
 * REWIND, per shooter, in ticks (fractional; positions are interpolated between two history
 * ticks). The INPUT packet carries the tick of the newest snapshot the client had when it
 * sampled its newest input (`ackSnapshotTick`); it does not carry the tick it was rendering.
 * With T the tick of that input (the tick the host executes it on) and S that snapshot:
 *
 *     T - S       = round trip + the host's input margin + the snapshot's age when sampled
 *     playhead    = S + age - interpolation delay          (see net/snapshot/playback-clock.ts)
 *     rewind      = T - playhead = (T - S) - age + interpolation delay
 *
 * `observeLatency` takes `T - S`, subtracts the mean age of a snapshot
 * (LAG_COMP_SNAPSHOT_AGE_TICKS) and adds the nominal interpolation delay (INTERP_DELAY_MS: the
 * client's adaptive 70-150 ms is not on the wire), smooths the result and CLAMPS it to
 * 0..LAG_COMP_MAX_REWIND_MS. That clamp is the trust boundary: whatever a client reports, it
 * cannot rewind anyone by more than 200 ms. The host's own player and bots are never observed
 * and keep a rewind of 0.
 *
 * WHAT IS REWOUND. Only targets, never the shooter (combat uses the caster's current position).
 * Cones and beams sample once, on the tick they fire. PROJECTILES are NOT fast-forwarded at
 * launch: for its whole flight a projectile is tested against targets rewound by its owner's
 * latency (combat samples with `projectile.ownerId` every tick). That is the same thing seen
 * from the shooter's chair (the shooter's client flies its bolt from the predicted cast against
 * dragons drawn `rewind` in the past, so what it sees hit is what the host scores) and it keeps
 * the host's projectile where every client draws it; fast-forwarding on top would compensate
 * twice. Blasts, zones, waves and dash contact are area effects and use current positions.
 *
 * NO HITS ON WHAT COULD NOT BE HIT THEN. A target that was dead, dodge-immune, spawn-protected
 * or phasing at the rewound time (at either of the two history ticks around it) is reported
 * at LAG_COMP_NOWHERE, far outside any ability's reach, so the shot misses. Immunity NOW is
 * still checked by the damage pipeline itself, so compensation never takes a dodge away.
 *
 * Deterministic, no clock, and nothing allocates after construction.
 */

import {
  DRAGON_FLAG_ALIVE,
  INTERP_DELAY_MS,
  LAG_COMP_MAX_REWIND_MS,
  MAX_PLAYERS,
  TICK_MS,
} from '../../shared';
import type { MutableVec3, PlayerId } from '../../shared';
import type { TargetPositionSource } from '../combat';
import type { DragonState } from '../dragon-state';
import type { SimState } from '../sim-state';

/** Ring length per dragon (a power of two): 533 ms at 30 Hz. */
export const LAG_COMP_HISTORY_TICKS = 16;
/** The cap as ticks (200 ms = 6 ticks at 30 Hz). */
export const LAG_COMP_MAX_REWIND_TICKS = LAG_COMP_MAX_REWIND_MS / TICK_MS;
/** The nominal interpolation delay in ticks (100 ms = 3 ticks). */
export const LAG_COMP_INTERP_DELAY_TICKS = INTERP_DELAY_MS / TICK_MS;
/**
 * Mean age, in ticks, of the newest snapshot at a random moment: snapshots leave on gaps of one
 * and two ticks alternately (20 Hz on a 30 Hz sim), so (1 * 1 + 2 * 2) / (2 * 3).
 */
export const LAG_COMP_SNAPSHOT_AGE_TICKS = 5 / 6;
/** Weight of a new latency sample in the smoothed rewind (about a quarter second at 30 Hz). */
export const LAG_COMP_SMOOTHING = 1 / 8;
/**
 * Where a target that could not be hit at the rewound time is reported: this far up, beyond
 * the reach of anything (and small enough that its square is still ordinary arithmetic).
 */
export const LAG_COMP_NOWHERE = 1e9;

const SLOT_MASK = LAG_COMP_HISTORY_TICKS - 1;
const ID_SLOTS = 256;

export class LagCompensator implements TargetPositionSource {
  /** False: every sample is the current position (a debug switch, and A/B tests). */
  enabled = true;
  /** Samples answered from history / answered with LAG_COMP_NOWHERE, for the debug HUD. */
  rewoundCount = 0;
  vetoedCount = 0;

  // One ring per dragon slot, flattened: entry = slot * LAG_COMP_HISTORY_TICKS + (tick & mask).
  private readonly px = new Float64Array(MAX_PLAYERS * LAG_COMP_HISTORY_TICKS);
  private readonly py = new Float64Array(MAX_PLAYERS * LAG_COMP_HISTORY_TICKS);
  private readonly pz = new Float64Array(MAX_PLAYERS * LAG_COMP_HISTORY_TICKS);
  /** Tick held by each entry; -1 = empty. */
  private readonly ticks = new Int32Array(MAX_PLAYERS * LAG_COMP_HISTORY_TICKS).fill(-1);
  /** 1 = the dragon could be hit on that tick. */
  private readonly hittable = new Uint8Array(MAX_PLAYERS * LAG_COMP_HISTORY_TICKS);
  /** Player whose history a slot holds; -1 = none. */
  private readonly slotPlayer = new Int16Array(MAX_PLAYERS).fill(-1);
  private readonly slotOfPlayer = new Int8Array(ID_SLOTS).fill(-1);
  /** Smoothed rewind per shooter, in ticks, always within 0..LAG_COMP_MAX_REWIND_TICKS. */
  private readonly rewind = new Float64Array(ID_SLOTS);
  private readonly observed = new Uint8Array(ID_SLOTS);

  /** Forgets the history (a new round: everyone was moved). The shooters' rewinds are kept. */
  reset(): void {
    this.ticks.fill(-1);
    this.slotPlayer.fill(-1);
    this.slotOfPlayer.fill(-1);
  }

  /** Forgets the history and every shooter's rewind (a new match). */
  resetAll(): void {
    this.reset();
    this.rewind.fill(0);
    this.observed.fill(0);
    this.rewoundCount = 0;
    this.vetoedCount = 0;
  }

  /**
   * Stores every dragon of `state` under `state.tick`. Call once after each `Sim.step`, with
   * `sim.current`.
   */
  record(state: Readonly<SimState>): void {
    const dragons = state.dragons;
    const tick = state.tick;
    const count = dragons.length < MAX_PLAYERS ? dragons.length : MAX_PLAYERS;
    for (let slot = 0; slot < count; slot++) {
      const dragon = dragons[slot];
      const held = this.slotPlayer[slot] ?? -1;
      if (dragon === undefined || !dragon.active) {
        if (held >= 0) this.clearSlot(slot, held);
        continue;
      }
      if (held !== dragon.id) {
        if (held >= 0) this.clearSlot(slot, held);
        this.slotPlayer[slot] = dragon.id;
        this.slotOfPlayer[dragon.id] = slot;
      }
      const entry = slot * LAG_COMP_HISTORY_TICKS + (tick & SLOT_MASK);
      this.px[entry] = dragon.position.x;
      this.py[entry] = dragon.position.y;
      this.pz[entry] = dragon.position.z;
      this.ticks[entry] = tick;
      this.hittable[entry] =
        (dragon.flags & DRAGON_FLAG_ALIVE) !== 0 &&
        dragon.dodgeImmunityTicks <= 0 &&
        dragon.spawnProtectTicks <= 0 &&
        dragon.phaseTicks <= 0
          ? 1
          : 0;
    }
  }

  /**
   * A latency measurement for `shooterId`: `lagTicks` = the tick of the newest input received
   * from it minus the tick of the newest snapshot it had when it sampled that input (whole
   * ticks; see the top of the file). Smoothed, and clamped to the cap whatever the value.
   */
  observeLatency(shooterId: PlayerId, lagTicks: number): void {
    if (!(shooterId >= 0 && shooterId < ID_SLOTS)) return;
    let raw = lagTicks - LAG_COMP_SNAPSHOT_AGE_TICKS + LAG_COMP_INTERP_DELAY_TICKS;
    // `!(>= 0)` also catches NaN.
    if (!(raw >= 0)) raw = 0;
    if (raw > LAG_COMP_MAX_REWIND_TICKS) raw = LAG_COMP_MAX_REWIND_TICKS;
    if (this.observed[shooterId] === 0) {
      this.observed[shooterId] = 1;
      this.rewind[shooterId] = raw;
    } else {
      const now = this.rewind[shooterId] ?? 0;
      this.rewind[shooterId] = now + (raw - now) * LAG_COMP_SMOOTHING;
    }
  }

  /**
   * Sets a shooter's rewind directly, in ticks (tests, tools; 0 for the host and bots). Clamped
   * to 0..LAG_COMP_MAX_REWIND_TICKS; NaN is 0.
   */
  setRewindTicks(shooterId: PlayerId, ticks: number): void {
    if (!(shooterId >= 0 && shooterId < ID_SLOTS)) return;
    let value = ticks;
    if (!(value >= 0)) value = 0;
    if (value > LAG_COMP_MAX_REWIND_TICKS) value = LAG_COMP_MAX_REWIND_TICKS;
    this.rewind[shooterId] = value;
    this.observed[shooterId] = value > 0 ? 1 : 0;
  }

  /** The rewind used for `shooterId`'s shots, in ticks (0 for unknown players). */
  rewindTicksOf(shooterId: PlayerId): number {
    return this.rewind[shooterId] ?? 0;
  }

  /** The same in milliseconds, for the debug HUD. */
  rewindMsOf(shooterId: PlayerId): number {
    return (this.rewind[shooterId] ?? 0) * TICK_MS;
  }

  /** Ticks of history held for a player (0..LAG_COMP_HISTORY_TICKS), for tests and the HUD. */
  historyLengthOf(playerId: PlayerId): number {
    const slot = this.slotOfPlayer[playerId] ?? -1;
    if (slot < 0) return 0;
    let count = 0;
    const base = slot * LAG_COMP_HISTORY_TICKS;
    for (let i = 0; i < LAG_COMP_HISTORY_TICKS; i++) {
      if ((this.ticks[base + i] ?? -1) >= 0) count++;
    }
    return count;
  }

  /**
   * `TargetPositionSource`: the centre of `target`'s hit sphere as `shooterId` saw it when it
   * fired on `tick`. `target` holds the state of `tick` itself (combat runs after the dragons
   * were stepped and before `record`), so the history supplies the ticks before it.
   */
  sample(shooterId: PlayerId, target: Readonly<DragonState>, tick: number, out: MutableVec3): void {
    const position = target.position;
    out.x = position.x;
    out.y = position.y;
    out.z = position.z;
    if (!this.enabled) return;
    const rewind = this.rewind[shooterId] ?? 0;
    if (!(rewind > 0)) return;
    const slot = this.slotOfPlayer[target.id] ?? -1;
    if (slot < 0) return;

    const base = slot * LAG_COMP_HISTORY_TICKS;
    const time = tick - rewind;
    const older = Math.floor(time);
    const fraction = time - older;
    const newer = older + 1;
    const olderEntry = base + (older & SLOT_MASK);
    const newerEntry = base + (newer & SLOT_MASK);
    const hasOlder = this.ticks[olderEntry] === older;
    // The tick being simulated is not in the ring yet: `target` is that state.
    const newerIsNow = newer >= tick;
    const hasNewer = newerIsNow || this.ticks[newerEntry] === newer;

    // A hole in the history (the dragon just spawned, the sim was paused for a countdown):
    // nothing is known about that time, so the target is where it is.
    if (!hasOlder && !(hasNewer && !newerIsNow)) return;

    if (
      (hasOlder && this.hittable[olderEntry] === 0) ||
      (hasNewer && !newerIsNow && this.hittable[newerEntry] === 0)
    ) {
      this.vetoedCount++;
      out.y = LAG_COMP_NOWHERE;
      return;
    }

    this.rewoundCount++;
    if (!hasOlder) {
      // Only the later of the two ticks is known: closer to the truth than the present.
      out.x = this.px[newerEntry] ?? position.x;
      out.y = this.py[newerEntry] ?? position.y;
      out.z = this.pz[newerEntry] ?? position.z;
      return;
    }
    const ax = this.px[olderEntry] ?? position.x;
    const ay = this.py[olderEntry] ?? position.y;
    const az = this.pz[olderEntry] ?? position.z;
    if (!hasNewer || !(fraction > 0)) {
      out.x = ax;
      out.y = ay;
      out.z = az;
      return;
    }
    const bx = newerIsNow ? position.x : (this.px[newerEntry] ?? position.x);
    const by = newerIsNow ? position.y : (this.py[newerEntry] ?? position.y);
    const bz = newerIsNow ? position.z : (this.pz[newerEntry] ?? position.z);
    out.x = ax + (bx - ax) * fraction;
    out.y = ay + (by - ay) * fraction;
    out.z = az + (bz - az) * fraction;
  }

  private clearSlot(slot: number, playerId: number): void {
    const base = slot * LAG_COMP_HISTORY_TICKS;
    for (let i = 0; i < LAG_COMP_HISTORY_TICKS; i++) this.ticks[base + i] = -1;
    this.slotPlayer[slot] = -1;
    if (this.slotOfPlayer[playerId] === slot) this.slotOfPlayer[playerId] = -1;
  }
}

export function createLagCompensator(): LagCompensator {
  return new LagCompensator();
}
