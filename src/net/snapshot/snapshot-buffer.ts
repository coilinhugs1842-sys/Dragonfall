/**
 * Client side of snapshots: a fixed ring of decoded snapshots and the sampler that turns it into
 * what the views draw for every dragon the client does not predict.
 *
 * STORAGE. `push` copies a decoded `SnapshotMessage` into one of `capacity` preallocated slots,
 * kept sorted by full tick. The `fast` channel is unreliable and unordered, so: a duplicate is
 * dropped, a late packet is slotted in where it belongs (it may still be the "to" end of the
 * current blend), and anything older than a full ring is dropped. Wire ticks are 16 bits; they
 * are expanded against the newest stored tick, which works across the wrap at 65535.
 *
 * SAMPLING. `sample` reads the state at the playback clock's position (`PlaybackClock`: host
 * tick time, 70-150 ms in the past). With snapshot A at or before the play tick and B after it:
 *
 * - Position: cubic HERMITE through A and B using their velocities as tangents, not a straight
 *   lerp. Dragons fly arcs; a lerp cuts every corner and its velocity kinks at each snapshot
 *   (at 60 m/s and a hard turn that is a 6 degree kink 20 times a second, which reads as
 *   judder on a dragon and in anything aligned to its motion). The Hermite curve is C1 across
 *   snapshots. The wire velocity is coarse (1.5 m/s steps) but it only shapes the tangent: the
 *   worst case moves the curve by under a centimetre. Where the velocities do not describe the
 *   path between the two states (a bounce off terrain, a gap after packet loss that is too long)
 *   the tangents would overshoot, so the sampler falls back to the lerp there.
 * - Orientation: nlerp along the shorter arc (snapshots are at most a few ticks of rotation
 *   apart, where nlerp and slerp are indistinguishable).
 * - Velocity: lerp. Health, stamina, flags and animation: taken from A.
 * - A dragon that is in A but not in B (despawned), or that TELEPORTED between them (respawn:
 *   ALIVE or SPAWN_PROTECTED rises, or it moved further than any dragon can fly), is not blended
 *   across the gap: it carries on from A and snaps when the play tick reaches B. A dragon that
 *   is only in B appears when the play tick reaches B.
 * - STARVED (no snapshot after the play tick): extrapolate from the newest one along its
 *   velocity for at most MAX_EXTRAPOLATION_MS, then hold. When snapshots return, the difference
 *   between where the dragon was drawn and where it really is gets blended out over about
 *   100 ms instead of popping (unless it is huge, then it snaps).
 *
 * `sample` keeps a little per-dragon state for that blend, so call it once per rendered frame.
 * Nothing here allocates after construction.
 */

import {
  DRAGON_ANIM_GLIDE,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_SPAWN_PROTECTED,
  MAX_EXTRAPOLATION_MS,
  NO_PLAYER,
  RECONCILE_SMOOTH_MS,
  TICK_DT_S,
  TICK_MS,
  ZONE_DEFS,
  ZONE_KINDS,
  createQuat,
  createVec3,
} from '../../shared';
import type { DragonAnimState, MatchPhase, MutableQuat, MutableVec3, PlayerId } from '../../shared';
import { expandTick } from '../codec/quantize';
import {
  SNAPSHOT_MAX_DRAGONS,
  SNAPSHOT_MAX_PROJECTILES,
  SNAPSHOT_MAX_ZONES,
  WIRE_VELOCITY_MAX_MPS,
  createSnapshotDragon,
  createSnapshotProjectile,
  createSnapshotZone,
  staticZoneDue,
} from '../protocol';
import type {
  SnapshotDragon,
  SnapshotMessage,
  SnapshotProjectile,
  SnapshotZone,
} from '../protocol';
import { PlaybackClock } from './playback-clock';

/** Default ring size: 1.6 s at 20 Hz, far more than the 150 ms the playhead trails by. */
export const SNAPSHOT_BUFFER_CAPACITY = 32;
/**
 * A snapshot this many ticks away from the newest one (either way) is not late or early, it is
 * a different timeline (the host restarted its tick counter, or nothing arrived for 10 s): the
 * buffer starts over from it.
 */
export const SNAPSHOT_DISCONTINUITY_TICKS = 300;
/** Slack on top of "further than the fastest dragon flies" before a jump counts as a teleport. */
export const TELEPORT_SLACK_M = 5;
/** A catch-up blend larger than this is not blended: the dragon snaps. */
export const REMOTE_BLEND_SNAP_M = 25;
/** Hermite tangents are only trusted across gaps up to this long. */
const HERMITE_MAX_GAP_S = 0.25;
/** Time constant of the catch-up blend: 5 % left after RECONCILE_SMOOTH_MS. */
const BLEND_TAU_MS = RECONCILE_SMOOTH_MS / 3;
const BLEND_EPSILON_M = 1e-3;
/** Ids are a `u8`. */
const ID_SLOTS = 256;

const MODE_INTERPOLATED = 0;
const MODE_STARVED = 1;
const MODE_CARRIED = 2;

interface StoredSnapshot {
  tick: number;
  phase: MatchPhase;
  round: number;
  phaseTimeS: number;
  timeRemainingS: number;
  scoreEmber: number;
  scoreFrost: number;
  dragonCount: number;
  dragons: SnapshotDragon[];
  stormRadius: number;
  projectileCount: number;
  projectiles: SnapshotProjectile[];
  zoneCount: number;
  zones: SnapshotZone[];
}

function createProjectilePool(): SnapshotProjectile[] {
  const pool: SnapshotProjectile[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_PROJECTILES; i++) pool.push(createSnapshotProjectile());
  return pool;
}

function createZonePool(): SnapshotZone[] {
  const pool: SnapshotZone[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_ZONES; i++) pool.push(createSnapshotZone());
  return pool;
}

function createStoredSnapshot(): StoredSnapshot {
  const dragons: SnapshotDragon[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_DRAGONS; i++) dragons.push(createSnapshotDragon());
  return {
    stormRadius: -1,
    projectileCount: 0,
    projectiles: createProjectilePool(),
    zoneCount: 0,
    zones: createZonePool(),
    tick: -1,
    phase: 'lobby',
    round: 1,
    phaseTimeS: 0,
    timeRemainingS: Infinity,
    scoreEmber: 0,
    scoreFrost: 0,
    dragonCount: 0,
    dragons,
  };
}

/** One dragon at the play tick. Same fields as `SnapshotDragon`, plus how it was produced. */
export interface SampledDragon {
  id: PlayerId;
  position: MutableVec3;
  orientation: MutableQuat;
  velocity: MutableVec3;
  /** Fraction of max HP, 0..1. */
  health: number;
  stamina: number;
  flags: number;
  anim: DragonAnimState;
  /** True when no snapshot after the play tick covered this dragon (extrapolated or held). */
  extrapolated: boolean;
}

/** Reused output of `SnapshotBuffer.sample`. Entries at index >= `dragonCount` are stale. */
export interface SnapshotSample {
  /** False until the first snapshot arrived; everything else is then meaningless. */
  valid: boolean;
  /** The fractional full host tick this sample describes. */
  playTick: number;
  dragonCount: number;
  dragons: SampledDragon[];
  phase: MatchPhase;
  round: number;
  phaseTimeS: number;
  timeRemainingS: number;
  scoreEmber: number;
  scoreFrost: number;
  /** True when the play tick is past the newest snapshot. */
  starved: boolean;
  /** How far past the newest snapshot the dragons were extrapolated (0..MAX_EXTRAPOLATION_MS). */
  extrapolatedMs: number;
  /** Storm wall radius a mode set, or negative for the map's own. */
  stormRadius: number;
  /**
   * The slow projectiles (the ones snapshots carry) and the ability zones at the play tick.
   * Entries at index >= the matching count are stale. Fast bolts are not here: see `ClientBolts`.
   */
  projectileCount: number;
  projectiles: SnapshotProjectile[];
  zoneCount: number;
  zones: SnapshotZone[];
}

export function createSnapshotSample(): SnapshotSample {
  const dragons: SampledDragon[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_DRAGONS; i++) {
    dragons.push({
      id: NO_PLAYER,
      position: createVec3(),
      orientation: createQuat(),
      velocity: createVec3(),
      health: 0,
      stamina: 0,
      flags: 0,
      anim: DRAGON_ANIM_GLIDE,
      extrapolated: false,
    });
  }
  return {
    valid: false,
    playTick: 0,
    dragonCount: 0,
    dragons,
    phase: 'lobby',
    round: 1,
    phaseTimeS: 0,
    timeRemainingS: Infinity,
    scoreEmber: 0,
    scoreFrost: 0,
    starved: false,
    extrapolatedMs: 0,
    stormRadius: -1,
    projectileCount: 0,
    projectiles: createProjectilePool(),
    zoneCount: 0,
    zones: createZonePool(),
  };
}

/** Linear scan (at most 10). */
export function findSampledDragon(
  sample: Readonly<SnapshotSample>,
  id: PlayerId,
): SampledDragon | undefined {
  for (let i = 0; i < sample.dragonCount; i++) {
    const dragon = sample.dragons[i];
    if (dragon !== undefined && dragon.id === id) return dragon;
  }
  return undefined;
}

function findStoredDragon(snapshot: StoredSnapshot, id: PlayerId): SnapshotDragon | undefined {
  for (let i = 0; i < snapshot.dragonCount; i++) {
    const dragon = snapshot.dragons[i];
    if (dragon !== undefined && dragon.id === id) return dragon;
  }
  return undefined;
}

export class SnapshotBuffer {
  /** The playhead; exposed for the debug HUD (`delayMs`, `jitterMs`, `rate`). */
  readonly clock = new PlaybackClock();

  private readonly capacity: number;
  /** Sorted by tick, oldest first; only the first `stored` entries are live. */
  private readonly order: StoredSnapshot[] = [];
  private stored = 0;

  // Per-dragon blend state, indexed by player id.
  private readonly blendX = new Float64Array(ID_SLOTS);
  private readonly blendY = new Float64Array(ID_SLOTS);
  private readonly blendZ = new Float64Array(ID_SLOTS);
  private readonly lastX = new Float64Array(ID_SLOTS);
  private readonly lastY = new Float64Array(ID_SLOTS);
  private readonly lastZ = new Float64Array(ID_SLOTS);
  private readonly lastVx = new Float64Array(ID_SLOTS);
  private readonly lastVy = new Float64Array(ID_SLOTS);
  private readonly lastVz = new Float64Array(ID_SLOTS);
  private readonly lastFrame = new Int32Array(ID_SLOTS);
  private readonly lastMode = new Uint8Array(ID_SLOTS);
  private frame = 0;
  private lastPlayTick = 0;
  /** The play tick `sampleInto` reads (set by `sample` / `sampleAt`). */
  private samplePlayTick = 0;
  /** Tick of the snapshot the previous `sample` read from. */
  private lastSourceTick = -1;
  private effectCarryS = 0;

  private received = 0;
  private duplicates = 0;
  private outOfOrder = 0;
  private tooOld = 0;
  private restarts = 0;

  constructor(capacity: number = SNAPSHOT_BUFFER_CAPACITY) {
    this.capacity = capacity >= 2 ? Math.floor(capacity) : 2;
    for (let i = 0; i < this.capacity; i++) this.order.push(createStoredSnapshot());
  }

  /** Empties the buffer and restarts the playhead (new match, reconnect). */
  reset(): void {
    this.stored = 0;
    this.clock.reset();
    this.lastFrame.fill(0);
    this.frame = 0;
    this.lastPlayTick = 0;
    this.lastSourceTick = -1;
    this.received = 0;
    this.duplicates = 0;
    this.outOfOrder = 0;
    this.tooOld = 0;
    this.restarts = 0;
  }

  /** Snapshots held. */
  get count(): number {
    return this.stored;
  }

  /** Full tick of the newest snapshot held, or -1. */
  get newestTick(): number {
    const newest = this.order[this.stored - 1];
    return this.stored > 0 && newest !== undefined ? newest.tick : -1;
  }

  /** Full tick of the oldest snapshot held, or -1. */
  get oldestTick(): number {
    const oldest = this.order[0];
    return this.stored > 0 && oldest !== undefined ? oldest.tick : -1;
  }

  /** Snapshots accepted since the last reset. */
  get receivedCount(): number {
    return this.received;
  }

  get duplicateCount(): number {
    return this.duplicates;
  }

  /** Accepted snapshots that were older than the newest one held when they arrived. */
  get outOfOrderCount(): number {
    return this.outOfOrder;
  }

  /** Snapshots dropped because they were older than everything in a full ring. */
  get tooOldCount(): number {
    return this.tooOld;
  }

  /** Times the buffer started over because the tick jumped (see SNAPSHOT_DISCONTINUITY_TICKS). */
  get restartCount(): number {
    return this.restarts;
  }

  /**
   * Stores a decoded snapshot (it is copied; `msg` can be reused at once).
   *
   * @param recvMs Local clock at arrival (the clock later passed to `update`).
   * @param referenceTick A full host tick known to be within 18 minutes of this snapshot (the
   *   WELCOME/PONG host tick, or `ClockSync.hostTickAt`). Only used while the buffer is empty;
   *   after that the newest stored tick is the reference. Without it the wire tick is taken as
   *   the full tick.
   * @returns The snapshot's FULL tick (pass it to `ClientPredictor.reconcile`), or -1 if it was
   *   a duplicate or too old to keep (the predictor has no use for those either).
   */
  push(msg: Readonly<SnapshotMessage>, recvMs: number, referenceTick?: number): number {
    const newest = this.newestTick;
    const reference = newest >= 0 ? newest : (referenceTick ?? msg.tick);
    const tick = expandTick(msg.tick, Math.floor(reference));
    if (tick < 0) {
      this.tooOld++;
      return -1;
    }

    if (newest >= 0 && Math.abs(tick - newest) > SNAPSHOT_DISCONTINUITY_TICKS) {
      // A different timeline: nothing held can be blended with this.
      this.stored = 0;
      this.clock.reset();
      this.lastFrame.fill(0);
      this.frame = 0;
      this.restarts++;
    }

    // Find the slot from the newest end: almost every snapshot is simply the next one.
    let at = this.stored;
    while (at > 0) {
      const before = this.order[at - 1];
      if (before === undefined || before.tick < tick) break;
      if (before.tick === tick) {
        this.duplicates++;
        return -1;
      }
      at--;
    }

    let slot: StoredSnapshot | undefined;
    if (this.stored === this.capacity) {
      if (at === 0) {
        this.tooOld++;
        return -1;
      }
      // Recycle the oldest: everything before the insert point moves down one.
      slot = this.order[0];
      for (let i = 1; i < at; i++) {
        const moved = this.order[i];
        if (moved !== undefined) this.order[i - 1] = moved;
      }
      at--;
    } else {
      // Take the free object at the end and open a gap at the insert point.
      slot = this.order[this.stored];
      for (let i = this.stored; i > at; i--) {
        const moved = this.order[i - 1];
        if (moved !== undefined) this.order[i] = moved;
      }
      this.stored++;
    }
    if (slot === undefined) return -1;
    this.order[at] = slot;
    if (at < this.stored - 1) this.outOfOrder++;

    slot.tick = tick;
    slot.phase = msg.phase;
    slot.round = msg.round;
    slot.phaseTimeS = msg.phaseTimeS;
    slot.timeRemainingS = msg.timeRemainingS;
    slot.scoreEmber = msg.scoreEmber;
    slot.scoreFrost = msg.scoreFrost;
    const count = msg.dragonCount < SNAPSHOT_MAX_DRAGONS ? msg.dragonCount : SNAPSHOT_MAX_DRAGONS;
    let kept = 0;
    for (let i = 0; i < count; i++) {
      const from = msg.dragons[i];
      const to = slot.dragons[kept];
      if (from === undefined || to === undefined) continue;
      to.id = from.id;
      to.position.x = from.position.x;
      to.position.y = from.position.y;
      to.position.z = from.position.z;
      to.orientation.x = from.orientation.x;
      to.orientation.y = from.orientation.y;
      to.orientation.z = from.orientation.z;
      to.orientation.w = from.orientation.w;
      to.velocity.x = from.velocity.x;
      to.velocity.y = from.velocity.y;
      to.velocity.z = from.velocity.z;
      to.health = from.health;
      to.stamina = from.stamina;
      to.flags = from.flags;
      to.anim = from.anim;
      kept++;
    }
    slot.dragonCount = kept;

    slot.stormRadius = msg.stormRadius;
    const projectileCount =
      msg.projectileCount < SNAPSHOT_MAX_PROJECTILES
        ? msg.projectileCount
        : SNAPSHOT_MAX_PROJECTILES;
    for (let i = 0; i < projectileCount; i++) {
      const from = msg.projectiles[i];
      const to = slot.projectiles[i];
      if (from === undefined || to === undefined) continue;
      to.id = from.id;
      to.kind = from.kind;
      to.ownerId = from.ownerId;
      to.team = from.team;
      to.position.x = from.position.x;
      to.position.y = from.position.y;
      to.position.z = from.position.z;
      to.velocity.x = from.velocity.x;
      to.velocity.y = from.velocity.y;
      to.velocity.z = from.velocity.z;
    }
    slot.projectileCount = projectileCount;
    const zoneCount = msg.zoneCount < SNAPSHOT_MAX_ZONES ? msg.zoneCount : SNAPSHOT_MAX_ZONES;
    for (let i = 0; i < zoneCount; i++) {
      const from = msg.zones[i];
      const to = slot.zones[i];
      if (from === undefined || to === undefined) continue;
      to.id = from.id;
      to.kind = from.kind;
      to.ownerId = from.ownerId;
      to.team = from.team;
      to.position.x = from.position.x;
      to.position.y = from.position.y;
      to.position.z = from.position.z;
      to.radius = from.radius;
      to.remainingS = from.remainingS;
    }
    slot.zoneCount = zoneCount;
    if (at > 0) this.carryStaticZones(slot, this.order[at - 1]);

    this.received++;
    this.clock.onSnapshot(tick, recvMs);
    return tick;
  }

  /** Advances the playhead to local time `nowMs`. Once per rendered frame, before `sample`. */
  update(nowMs: number): void {
    this.clock.update(nowMs);
  }

  /*
   * HOW THE BODY OF `sampleInto` IS WRITTEN. It runs every frame for every dragon and must not
   * create garbage, and the optimising compilers box a float (16 bytes) in two situations that
   * look innocent:
   * - a float passed to, or returned from, a function that was not inlined;
   * - a variable that is an integer literal on one path and a float on the other, e.g.
   *   `let t = 0; if (b) t = x / y;` or `c ? x : 0`.
   * So there are no float-taking helpers here, and every float is produced by one expression
   * on all paths: `Math.min`/`Math.max` instead of a ternary, a 0/1 integer flag multiplied in
   * instead of a branch, a store in each branch instead of a variable merged after it.
   * tests/net/prediction-units.test.ts ("hot path allocations") measures the result.
   */

  /**
   * Writes the state at the playback clock's position into `out` and returns it. Call once per
   * rendered frame, after `update` (it advances the catch-up blends).
   */
  sample(out: SnapshotSample): SnapshotSample {
    this.samplePlayTick = this.clock.playTick;
    return this.sampleInto(out);
  }

  /**
   * `sample` at a play tick of the caller's choosing, for tests and tools. Same rules: once per
   * frame, and the play tick must not run backwards.
   */
  sampleAt(out: SnapshotSample, playTick: number): SnapshotSample {
    this.samplePlayTick = playTick;
    return this.sampleInto(out);
  }

  private sampleInto(out: SnapshotSample): SnapshotSample {
    // Read from a field rather than passed in: see the note above.
    const playTick = this.samplePlayTick;
    out.playTick = playTick;
    out.dragonCount = 0;
    out.projectileCount = 0;
    out.zoneCount = 0;
    out.starved = false;
    out.extrapolatedMs = 0;
    if (this.stored === 0) {
      out.valid = false;
      return out;
    }
    out.valid = true;

    // --- Bracket the play tick: A at or before it, B after it ------------------------------------
    let after = this.stored;
    while (after > 0) {
      const candidate = this.order[after - 1];
      if (candidate === undefined || candidate.tick <= playTick) break;
      after--;
    }
    // `after` is the index of B (or `stored` when there is none); A is the one before it.
    // Play tick before the oldest snapshot (the first 100 ms of a connection): show the oldest
    // as it is, with no B.
    const beforeOldest = after === 0;
    const a = this.order[beforeOldest ? 0 : after - 1];
    const b = !beforeOldest && after < this.stored ? this.order[after] : undefined;
    if (a === undefined) {
      out.valid = false;
      return out;
    }

    // Before the oldest snapshot the difference is negative: no time has passed since A.
    const elapsedTicks = Math.max(0, playTick - a.tick);
    const elapsedMs = elapsedTicks * TICK_MS;
    const starved = b === undefined && !beforeOldest;
    const carryMs = Math.min(elapsedMs, MAX_EXTRAPOLATION_MS);
    const carryS = carryMs / 1000;
    out.starved = starved;
    if (starved) out.extrapolatedMs = carryMs;

    this.effectCarryS = carryS;
    this.sampleEffects(out, a, b);

    // Whole ticks between A and B (0 without a B, where `t` is not used).
    const gapTicks = b !== undefined ? b.tick - a.tick : 0;
    const gapS = gapTicks * TICK_DT_S;
    const t = Math.max(0, Math.min(1, elapsedTicks / Math.max(1, gapTicks)));
    const reach = WIRE_VELOCITY_MAX_MPS * 1.5 * gapS + TELEPORT_SLACK_M;
    const reachSq = reach * reach;

    // --- Clock -------------------------------------------------------------------------------
    // Time runs on between snapshots (only as far as dragons are extrapolated), but not into a
    // phase change: there A's clock stands until the play tick reaches B.
    const samePhase = b === undefined || b.phase === a.phase ? 1 : 0;
    const clockS =
      (Math.min(elapsedMs, b !== undefined ? 1e9 : MAX_EXTRAPOLATION_MS) / 1000) * samePhase;
    out.phase = a.phase;
    out.round = a.round;
    out.phaseTimeS = a.phaseTimeS + clockS;
    // Infinity (no time limit) stays Infinity.
    out.timeRemainingS = Math.max(0, a.timeRemainingS - clockS);
    const newest = this.order[this.stored - 1] ?? a;
    out.scoreEmber = newest.scoreEmber;
    out.scoreFrost = newest.scoreFrost;

    // --- Blend bookkeeping ---------------------------------------------------------------------
    const frame = ++this.frame;
    // (On the first frame this is meaningless, and unused: no dragon is `continuous` yet.)
    const playDtS = Math.max(0, (playTick - this.lastPlayTick) * TICK_DT_S);
    this.lastPlayTick = playTick;
    const blendKeep = Math.exp((-playDtS * 1000) / BLEND_TAU_MS);
    const sourceChanged = a.tick !== this.lastSourceTick;
    this.lastSourceTick = a.tick;
    // While held (extrapolation used up) a dragon is drawn standing still.
    const carrying = elapsedMs < MAX_EXTRAPOLATION_MS ? 1 : 0;
    const blendX = this.blendX;
    const blendY = this.blendY;
    const blendZ = this.blendZ;

    // --- Dragons: the set is whoever exists in A ---------------------------------------------
    let written = 0;
    for (let i = 0; i < a.dragonCount; i++) {
      const from: SnapshotDragon | undefined = a.dragons[i];
      const dragon = out.dragons[written];
      if (from === undefined || dragon === undefined) continue;
      const id = from.id;
      const to: SnapshotDragon | undefined = b !== undefined ? findStoredDragon(b, id) : undefined;
      // With no B for this dragon the chord below is zero and unused.
      const target = to ?? from;

      const position = dragon.position;
      const velocity = dragon.velocity;
      const ax = from.position.x;
      const ay = from.position.y;
      const az = from.position.z;
      const cx = target.position.x - ax;
      const cy = target.position.y - ay;
      const cz = target.position.z - az;
      const chordSq = cx * cx + cy * cy + cz * cz;
      // A teleport is not a continuation: the dragon came back to life, got fresh spawn
      // protection, or moved further than the wire's top speed allows.
      const rising = target.flags & ~from.flags;
      const continues =
        to !== undefined &&
        (rising & (DRAGON_FLAG_ALIVE | DRAGON_FLAG_SPAWN_PROTECTED)) === 0 &&
        chordSq <= reachSq;

      let mode = MODE_INTERPOLATED;
      if (continues) {
        // Do the two velocities describe the path? Compare the chord with what flying at their
        // average for `gapS` would cover.
        const mx = cx - (from.velocity.x + target.velocity.x) * 0.5 * gapS;
        const my = cy - (from.velocity.y + target.velocity.y) * 0.5 * gapS;
        const mz = cz - (from.velocity.z + target.velocity.z) * 0.5 * gapS;
        const mismatchSq = mx * mx + my * my + mz * mz;
        const tolerance = 0.2 * Math.sqrt(chordSq) + 0.2;
        if (gapS <= HERMITE_MAX_GAP_S && mismatchSq <= tolerance * tolerance) {
          const t2 = t * t;
          const t3 = t2 * t;
          // Hermite basis with p0 factored out: p = a + h01 * chord + h10 * m0 + h11 * m1.
          const h01 = 3 * t2 - 2 * t3;
          const h10 = (t3 - 2 * t2 + t) * gapS;
          const h11 = (t3 - t2) * gapS;
          position.x = ax + h01 * cx + h10 * from.velocity.x + h11 * target.velocity.x;
          position.y = ay + h01 * cy + h10 * from.velocity.y + h11 * target.velocity.y;
          position.z = az + h01 * cz + h10 * from.velocity.z + h11 * target.velocity.z;
        } else {
          position.x = ax + cx * t;
          position.y = ay + cy * t;
          position.z = az + cz * t;
        }
        velocity.x = from.velocity.x + (target.velocity.x - from.velocity.x) * t;
        velocity.y = from.velocity.y + (target.velocity.y - from.velocity.y) * t;
        velocity.z = from.velocity.z + (target.velocity.z - from.velocity.z) * t;

        // nlerp, shorter arc.
        const qa = from.orientation;
        const qb = target.orientation;
        const sign = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w < 0 ? -1 : 1;
        const u = 1 - t;
        const st = sign * t;
        const qx = qa.x * u + qb.x * st;
        const qy = qa.y * u + qb.y * st;
        const qz = qa.z * u + qb.z * st;
        const qw = qa.w * u + qb.w * st;
        const lengthSq = qx * qx + qy * qy + qz * qz + qw * qw;
        const orientation = dragon.orientation;
        if (lengthSq > 1e-12) {
          const inverse = 1 / Math.sqrt(lengthSq);
          orientation.x = qx * inverse;
          orientation.y = qy * inverse;
          orientation.z = qz * inverse;
          orientation.w = qw * inverse;
        } else {
          orientation.x = qb.x;
          orientation.y = qb.y;
          orientation.z = qb.z;
          orientation.w = qb.w;
        }
        dragon.extrapolated = false;
      } else {
        // Nothing to blend toward: carry on from A along its velocity, for a bounded time.
        mode = starved ? MODE_STARVED : MODE_CARRIED;
        position.x = ax + from.velocity.x * carryS;
        position.y = ay + from.velocity.y * carryS;
        position.z = az + from.velocity.z * carryS;
        velocity.x = from.velocity.x;
        velocity.y = from.velocity.y;
        velocity.z = from.velocity.z;
        dragon.orientation.x = from.orientation.x;
        dragon.orientation.y = from.orientation.y;
        dragon.orientation.z = from.orientation.z;
        dragon.orientation.w = from.orientation.w;
        dragon.extrapolated = !beforeOldest;
      }

      // --- Catch-up blend after starvation -------------------------------------------------
      // The blend lives in the typed arrays; each branch stores it, then it is read back once.
      const continuous = frame > 1 && this.lastFrame[id] === frame - 1;
      if (!continuous || mode === MODE_CARRIED) {
        blendX[id] = 0;
        blendY[id] = 0;
        blendZ[id] = 0;
      } else if (
        this.lastMode[id] === MODE_STARVED &&
        (mode === MODE_INTERPOLATED || sourceChanged)
      ) {
        // Where the dragon would have been drawn this frame, minus where it really is.
        const ex = (this.lastX[id] as number) + (this.lastVx[id] as number) * playDtS - position.x;
        const ey = (this.lastY[id] as number) + (this.lastVy[id] as number) * playDtS - position.y;
        const ez = (this.lastZ[id] as number) + (this.lastVz[id] as number) * playDtS - position.z;
        // Too far to blend: snap (the flag zeroes the blend without a branch on floats).
        const keep =
          ex * ex + ey * ey + ez * ez > REMOTE_BLEND_SNAP_M * REMOTE_BLEND_SNAP_M ? 0 : 1;
        blendX[id] = ex * keep;
        blendY[id] = ey * keep;
        blendZ[id] = ez * keep;
      } else {
        const kx = (blendX[id] as number) * blendKeep;
        const ky = (blendY[id] as number) * blendKeep;
        const kz = (blendZ[id] as number) * blendKeep;
        const keep = kx * kx + ky * ky + kz * kz < BLEND_EPSILON_M * BLEND_EPSILON_M ? 0 : 1;
        blendX[id] = kx * keep;
        blendY[id] = ky * keep;
        blendZ[id] = kz * keep;
      }
      position.x += blendX[id] as number;
      position.y += blendY[id] as number;
      position.z += blendZ[id] as number;
      this.lastX[id] = position.x;
      this.lastY[id] = position.y;
      this.lastZ[id] = position.z;
      const moving = mode === MODE_INTERPOLATED ? 1 : carrying;
      this.lastVx[id] = velocity.x * moving;
      this.lastVy[id] = velocity.y * moving;
      this.lastVz[id] = velocity.z * moving;
      this.lastFrame[id] = frame;
      this.lastMode[id] = mode;

      dragon.id = id;
      dragon.health = from.health;
      dragon.stamina = from.stamina;
      dragon.flags = from.flags;
      dragon.anim = from.anim;
      written++;
    }
    out.dragonCount = written;
    return out;
  }

  /**
   * Standing zones are not in every snapshot (SNAPSHOT_ZONE_REFRESH): the ones `before` (the
   * snapshot stored just ahead of `slot`) holds and `slot` was not sent are copied over with
   * their time counted down, so every stored snapshot lists every zone and sampling needs to
   * know nothing about it. A zone missing although it was due in `slot` has ended.
   */
  private carryStaticZones(slot: StoredSnapshot, before: StoredSnapshot | undefined): void {
    if (before === undefined || before.zoneCount === 0) return;
    const elapsedS = (slot.tick - before.tick) * TICK_DT_S;
    const sent = slot.zoneCount;
    // A full list was cut short by the host: "missing" then says nothing.
    const complete = sent < SNAPSHOT_MAX_ZONES;
    for (let i = 0; i < before.zoneCount && slot.zoneCount < SNAPSHOT_MAX_ZONES; i++) {
      const from = before.zones[i];
      const to = slot.zones[slot.zoneCount];
      if (from === undefined || to === undefined) continue;
      const kind = ZONE_KINDS[from.kind];
      if (kind === undefined || ZONE_DEFS[kind].follow) continue;
      if (!(from.remainingS > elapsedS)) continue;
      if (complete && staticZoneDue(slot.tick, from.id)) continue;
      let listed = false;
      for (let j = 0; j < sent; j++) {
        if (slot.zones[j]?.id === from.id) {
          listed = true;
          break;
        }
      }
      if (listed) continue;
      to.id = from.id;
      to.kind = from.kind;
      to.ownerId = from.ownerId;
      to.team = from.team;
      to.position.x = from.position.x;
      to.position.y = from.position.y;
      to.position.z = from.position.z;
      to.radius = from.radius;
      to.remainingS = from.remainingS - elapsedS;
      slot.zoneCount++;
    }
  }

  /**
   * Projectiles and zones at the play tick, from snapshot A: a record that B also has (same id)
   * is lerped to it, anything else is carried along its velocity for `carryS` (capped by the
   * caller like every extrapolation). A record that only B has appears when the playhead gets
   * there. Reads `this.samplePlayTick` and `this.effectCarryS` (fields, not float arguments).
   */
  private sampleEffects(
    out: SnapshotSample,
    a: StoredSnapshot,
    b: StoredSnapshot | undefined,
  ): void {
    const carryS = this.effectCarryS;
    const gap = b !== undefined ? b.tick - a.tick : 0;
    const t = gap > 0 ? Math.max(0, Math.min(1, (this.samplePlayTick - a.tick) / gap)) : 0;
    out.stormRadius = a.stormRadius;

    let count = 0;
    for (let i = 0; i < a.projectileCount; i++) {
      const from = a.projectiles[i];
      const to = out.projectiles[count];
      if (from === undefined || to === undefined) continue;
      let next: SnapshotProjectile | undefined;
      if (b !== undefined) {
        for (let j = 0; j < b.projectileCount; j++) {
          const candidate = b.projectiles[j];
          if (candidate !== undefined && candidate.id === from.id && candidate.kind === from.kind) {
            next = candidate;
            break;
          }
        }
      }
      to.id = from.id;
      to.kind = from.kind;
      to.ownerId = from.ownerId;
      to.team = from.team;
      if (next !== undefined) {
        to.position.x = from.position.x + (next.position.x - from.position.x) * t;
        to.position.y = from.position.y + (next.position.y - from.position.y) * t;
        to.position.z = from.position.z + (next.position.z - from.position.z) * t;
        to.velocity.x = from.velocity.x + (next.velocity.x - from.velocity.x) * t;
        to.velocity.y = from.velocity.y + (next.velocity.y - from.velocity.y) * t;
        to.velocity.z = from.velocity.z + (next.velocity.z - from.velocity.z) * t;
      } else {
        to.position.x = from.position.x + from.velocity.x * carryS;
        to.position.y = from.position.y + from.velocity.y * carryS;
        to.position.z = from.position.z + from.velocity.z * carryS;
        to.velocity.x = from.velocity.x;
        to.velocity.y = from.velocity.y;
        to.velocity.z = from.velocity.z;
      }
      count++;
    }
    out.projectileCount = count;

    count = 0;
    const elapsedS = Math.max(0, this.samplePlayTick - a.tick) * TICK_DT_S;
    for (let i = 0; i < a.zoneCount; i++) {
      const from = a.zones[i];
      const to = out.zones[count];
      if (from === undefined || to === undefined) continue;
      let next: SnapshotZone | undefined;
      if (b !== undefined) {
        for (let j = 0; j < b.zoneCount; j++) {
          const candidate = b.zones[j];
          if (candidate !== undefined && candidate.id === from.id && candidate.kind === from.kind) {
            next = candidate;
            break;
          }
        }
      }
      to.id = from.id;
      to.kind = from.kind;
      to.ownerId = from.ownerId;
      to.team = from.team;
      to.radius = from.radius;
      const remaining = from.remainingS - elapsedS;
      to.remainingS = remaining > 0 ? remaining : 0;
      if (next !== undefined) {
        // A zone that follows its owner moves; the others stand still and this is a no-op.
        to.position.x = from.position.x + (next.position.x - from.position.x) * t;
        to.position.y = from.position.y + (next.position.y - from.position.y) * t;
        to.position.z = from.position.z + (next.position.z - from.position.z) * t;
      } else {
        to.position.x = from.position.x;
        to.position.y = from.position.y;
        to.position.z = from.position.z;
      }
      count++;
    }
    out.zoneCount = count;
  }
}
