/**
 * Client prediction and reconciliation for the dragon this browser flies.
 *
 * PREDICTION. `step` runs the sim's own per-dragon tick (`stepDragon`: flight, collision,
 * derived fields; the very code the host runs) on the local input straight away, so the dragon
 * answers the hand with no network delay. Each input is first snapped to what the host will
 * decode from the wire (`snapInputFrame`), then kept in a ring by tick together with the state
 * it produced.
 *
 * TICKS. Client and host count the same ticks: the input for tick T is applied by the host on
 * its tick T (`HostInputBuffer` states the rule, including what the host does when an input is
 * missing). The client runs ahead of the host so its inputs arrive in time; `InputTiming` keeps
 * that lead. The predictor only counts: `tick` is the last tick it simulated.
 *
 * RECONCILIATION. A snapshot for host tick S carries the owner block: this dragon's primary
 * state after tick S, whatever inputs the host applied to get there. `reconcile`:
 * 1. compares it with what was predicted for S. If they agree within a small tolerance (the
 *    normal case: same code, same inputs) nothing happens at all;
 * 2. otherwise resets the dragon to the host's state and replays the stored inputs for
 *    S+1..tick, which gives the corrected present;
 * 3. takes the difference between where the dragon was DRAWN before and the corrected present
 *    as a visual offset (position and orientation) that `updateSmoothing` then decays over
 *    about RECONCILE_SMOOTH_MS. The sim state is corrected at once, the picture catches up
 *    smoothly, so a correction never pops;
 * 4. unless the difference is huge (a respawn or teleport, or more than
 *    RECONCILE_SNAP_DISTANCE_M): then the picture snaps too.
 *
 * Inputs are replayed from S+1, not from the ack: a snapshot's state already contains every
 * tick up to S, including the ones where the host had to substitute an input, so replaying an
 * input for a tick <= S would apply it twice. The ack (`ackInputTick`) feeds `InputTiming`.
 *
 * Edge cases: a snapshot older than the last one used is ignored (unordered channel); if the
 * client is BEHIND the host (tick <= S) there is nothing to replay and the dragon is simply set
 * to the host's state until `InputTiming` has moved the clock; a tick with no stored input (a
 * stall, a clock jump) replays as "no input", the same rule the sim uses; a snapshot without an
 * owner block (dead and despawned, spectating) switches prediction off.
 *
 * Deterministic. Nothing here allocates per tick, per snapshot or per frame; what a predicted or
 * replayed tick does cost is what `stepDragon` costs on the host too (the flight functions take
 * a few floats as plain arguments, which the JIT boxes: see the "hot path allocations" tests).
 * The float-heavy methods follow the rules written above `SnapshotBuffer.sampleInto`.
 */

import {
  CLASS_TUNING,
  DEFAULT_DRAGON_CLASS,
  DRAGON_FLAG_ALIVE,
  FLIGHT_TUNING,
  NO_PLAYER,
  RECONCILE_SMOOTH_MS,
  TEAM_EMBER,
  copyInputFrame,
  createInputFrame,
  createQuat,
  createVec3,
} from '../../shared';
import type {
  ClassTuning,
  DragonClassId,
  FlightTuning,
  InputFrame,
  MutableDragonView,
  MutableQuat,
  MutableVec3,
  PlayerId,
  TeamId,
} from '../../shared';
import {
  NULL_COLLISION_WORLD,
  copyDragonState,
  createDragonState,
  finalizeDragon,
  resetDragonState,
  stepDragon,
} from '../../sim';
import type { DragonState, SimCollisionWorld } from '../../sim';
import { applySnapshotOwner } from '../codec/fast';
import { snapInputFrame } from '../codec/quantize';
import { INPUT_FRAMES_PER_PACKET } from '../protocol';
import type { InputMessage, SnapshotMessage, SnapshotOwner } from '../protocol';

/** Inputs and predicted states kept, in ticks (about 2 s; power of two). */
export const PREDICTION_HISTORY_TICKS = 64;
/** More unconfirmed ticks than this are not replayed: the client clock is far off (resync). */
export const PREDICTION_MAX_REPLAY_TICKS = 48;
/** A visual error beyond this is a teleport, not a misprediction: snap, do not smooth. */
export const RECONCILE_SNAP_DISTANCE_M = 12;
/**
 * Predicted and authoritative state count as equal within these. The owner block is `f32`, so
 * an exact comparison would "correct" every snapshot by rounding noise.
 */
export const RECONCILE_POSITION_EPSILON_M = 0.005;
export const RECONCILE_ANGLE_EPSILON_RAD = 2e-4;
export const RECONCILE_VALUE_EPSILON = 2e-3;

/** `reconcile` results. */
/** Not used: older than the last snapshot applied, or the predictor is not configured. */
export const RECONCILE_IGNORED = 0;
/** Prediction agreed with the host; nothing changed. */
export const RECONCILE_MATCHED = 1;
/** State corrected, the visual error is being smoothed out. */
export const RECONCILE_CORRECTED = 2;
/** State corrected and the picture snapped (first state, respawn, teleport, huge error). */
export const RECONCILE_SNAPPED = 3;
/** The snapshot has no dragon for this player: prediction is off. */
export const RECONCILE_NO_OWNER = 4;

export type ReconcileResult =
  | typeof RECONCILE_IGNORED
  | typeof RECONCILE_MATCHED
  | typeof RECONCILE_CORRECTED
  | typeof RECONCILE_SNAPPED
  | typeof RECONCILE_NO_OWNER;

export interface ClientPredictorOptions {
  /** Must be the tables the host uses. Default: the shared ones. */
  flightTuning?: FlightTuning;
  classTuning?: Record<DragonClassId, ClassTuning>;
  /** The same map collision the host sim uses. Default: open sky. */
  collisionWorld?: SimCollisionWorld;
}

const HISTORY_MASK = PREDICTION_HISTORY_TICKS - 1;
/** Time constant of the visual error: 5 % left after RECONCILE_SMOOTH_MS. */
const SMOOTH_TAU_MS = RECONCILE_SMOOTH_MS / 3;
const OFFSET_EPSILON_M = 5e-4;
const OFFSET_EPSILON_QUAT = 1e-7;
const TWO_PI = Math.PI * 2;

function near(a: number, b: number, epsilon: number): boolean {
  const d = a - b;
  return d <= epsilon && d >= -epsilon;
}

function nearAngle(a: number, b: number): boolean {
  let d = a - b;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d <= RECONCILE_ANGLE_EPSILON_RAD && d >= -RECONCILE_ANGLE_EPSILON_RAD;
}

/** True when a predicted state is the host's state, up to the wire's `f32` rounding. */
function ownerMatches(predicted: Readonly<DragonState>, owner: Readonly<SnapshotOwner>): boolean {
  return (
    predicted.flags === owner.flags &&
    predicted.prevButtons === owner.prevButtons &&
    predicted.boostLocked === owner.boostLocked &&
    predicted.dodgeDir === owner.dodgeDir &&
    predicted.dodgeTicks === owner.dodgeTicks &&
    predicted.dodgeTotalTicks === owner.dodgeTotalTicks &&
    predicted.dodgeImmunityTicks === owner.dodgeImmunityTicks &&
    predicted.dodgeCooldownTicks === owner.dodgeCooldownTicks &&
    predicted.flapCooldownTicks === owner.flapCooldownTicks &&
    predicted.staminaRegenDelayTicks === owner.staminaRegenDelayTicks &&
    predicted.spawnProtectTicks === owner.spawnProtectTicks &&
    predicted.hitTicks === owner.hitTicks &&
    predicted.terrainGraceTicks === owner.terrainGraceTicks &&
    near(predicted.position.x, owner.position.x, RECONCILE_POSITION_EPSILON_M) &&
    near(predicted.position.y, owner.position.y, RECONCILE_POSITION_EPSILON_M) &&
    near(predicted.position.z, owner.position.z, RECONCILE_POSITION_EPSILON_M) &&
    nearAngle(predicted.yaw, owner.yaw) &&
    nearAngle(predicted.pitch, owner.pitch) &&
    nearAngle(predicted.roll, owner.roll) &&
    near(predicted.yawRate, owner.yawRate, RECONCILE_VALUE_EPSILON) &&
    near(predicted.pitchRate, owner.pitchRate, RECONCILE_VALUE_EPSILON) &&
    near(predicted.speed, owner.speed, RECONCILE_VALUE_EPSILON) &&
    near(predicted.burst.x, owner.burst.x, RECONCILE_VALUE_EPSILON) &&
    near(predicted.burst.y, owner.burst.y, RECONCILE_VALUE_EPSILON) &&
    near(predicted.burst.z, owner.burst.z, RECONCILE_VALUE_EPSILON) &&
    near(predicted.stamina, owner.stamina, RECONCILE_VALUE_EPSILON) &&
    near(predicted.health, owner.health, RECONCILE_VALUE_EPSILON) &&
    near(predicted.maxHealth, owner.maxHealth, RECONCILE_VALUE_EPSILON)
  );
}

export class ClientPredictor {
  private readonly flight: FlightTuning;
  private readonly classes: Record<DragonClassId, ClassTuning>;
  private collision: SimCollisionWorld;

  private readonly current: DragonState = createDragonState();
  private readonly previous: DragonState = createDragonState();
  private readonly scratch: MutableVec3 = createVec3();

  private readonly inputs: InputFrame[] = [];
  /** Tick held by each input slot, -1 = empty. */
  private readonly inputTicks = new Int32Array(PREDICTION_HISTORY_TICKS).fill(-1);
  private readonly states: DragonState[] = [];
  private readonly stateTicks = new Int32Array(PREDICTION_HISTORY_TICKS).fill(-1);

  private id: PlayerId = NO_PLAYER;
  private team: TeamId = TEAM_EMBER;
  private classId: DragonClassId = DEFAULT_DRAGON_CLASS;
  private lastTick = -1;
  private authTick = -1;
  /** Ticks before this one are recorded but not simulated (see `setSimStartTick`). */
  private simStart = 0;

  private readonly positionOffset: MutableVec3 = createVec3();
  private readonly rotationOffset: MutableQuat = createQuat();

  private lastCorrection = 0;
  private largestCorrection = 0;
  private corrections = 0;
  private snaps = 0;
  private matches = 0;
  private replayed = 0;

  constructor(options: ClientPredictorOptions = {}) {
    this.flight = options.flightTuning ?? FLIGHT_TUNING;
    this.classes = options.classTuning ?? CLASS_TUNING;
    this.collision = options.collisionWorld ?? NULL_COLLISION_WORLD;
    for (let i = 0; i < PREDICTION_HISTORY_TICKS; i++) {
      this.inputs.push(createInputFrame());
      this.states.push(createDragonState());
    }
  }

  /**
   * Says which dragon is predicted. Team and class come from the match roster (the snapshot's
   * owner block does not repeat them). Clears all state; the tick is kept.
   */
  configure(playerId: PlayerId, team: TeamId, classId: DragonClassId): void {
    this.reset();
    this.id = playerId;
    this.team = team;
    this.classId = classId;
  }

  /**
   * Drops the dragon, the input and state history and the visual offset (reconnect, new round
   * of spawning, leaving the match). Identity and tick are kept; the next owner block starts
   * prediction again.
   */
  reset(): void {
    resetDragonState(this.current);
    resetDragonState(this.previous);
    this.inputTicks.fill(-1);
    this.stateTicks.fill(-1);
    this.authTick = -1;
    this.clearOffset();
    this.lastCorrection = 0;
    this.largestCorrection = 0;
    this.corrections = 0;
    this.snaps = 0;
    this.matches = 0;
    this.replayed = 0;
  }

  /** Swaps the collision world (map load/unload); null = open sky. */
  setCollisionWorld(world: SimCollisionWorld | null): void {
    this.collision = world ?? NULL_COLLISION_WORLD;
  }

  /** The player this predictor flies, or NO_PLAYER before `configure`. */
  get playerId(): PlayerId {
    return this.id;
  }

  /** True while there is an authoritative state to predict from. */
  get active(): boolean {
    return this.current.active;
  }

  /** The last tick simulated (or reserved by `setTick`); the next `step` is `tick + 1`. */
  get tick(): number {
    return this.lastTick;
  }

  /** Full tick of the last snapshot `reconcile` used, or -1. */
  get lastSnapshotTick(): number {
    return this.authTick;
  }

  /**
   * Sets the clock: the next `step` simulates `tick + 1`. Use it once at match start with
   * `floor(ClockSync.hostTickAt(now)) + initialInputLeadTicks(...)`.
   */
  setTick(tick: number): void {
    this.lastTick = Math.floor(tick);
    this.stateTicks.fill(-1);
  }

  /**
   * Moves the clock by `delta` ticks (`InputTiming.resyncTicks`). The dragon is not touched, but
   * the predicted states are forgotten: none of them belongs to its tick any more, so the next
   * snapshot resets and replays (ticks skipped by a forward jump replay as "no input") and the
   * difference is smoothed like any other correction.
   */
  shiftTick(delta: number): void {
    const ticks = Math.trunc(delta);
    if (ticks === 0) return;
    this.lastTick += ticks;
    this.stateTicks.fill(-1);
  }

  /**
   * First tick the host simulates. Before it (the countdown: dragons are held at their gates)
   * `step` and the replay in `reconcile` still record and send inputs, so `InputTiming` can
   * settle, but leave the dragon where the host put it. Default 0: every tick is simulated.
   */
  setSimStartTick(tick: number): void {
    this.simStart = Math.floor(tick);
  }

  /** See `setSimStartTick`. */
  get simStartTick(): number {
    return this.simStart;
  }

  /** The predicted dragon after the last tick (read only; null-like when `active` is false). */
  get dragon(): Readonly<DragonState> {
    return this.current;
  }

  /** The predicted dragon one tick earlier, for render interpolation. */
  get previousDragon(): Readonly<DragonState> {
    return this.previous;
  }

  /**
   * Simulates the next tick with `input` and returns that tick. `input` is REWRITTEN to what
   * the host will see: `tick` is set, steer is snapped to the wire grid and unknown buttons are
   * dropped. Call once per fixed step, then `writeInputMessage` to send it.
   *
   * Without an authoritative state yet (`active` false) the input is still recorded and should
   * still be sent: the host needs it, and the first snapshot replays it.
   */
  step(input: InputFrame): number {
    const tick = this.lastTick + 1;
    this.lastTick = tick;
    input.tick = tick;
    snapInputFrame(input);

    const index = tick & HISTORY_MASK;
    const stored = this.inputs[index];
    if (stored !== undefined) {
      copyInputFrame(stored, input);
      this.inputTicks[index] = tick;
    }

    const dragon = this.current;
    if (dragon.active) {
      copyDragonState(this.previous, dragon);
      if (tick >= this.simStart) {
        stepDragon(
          dragon,
          input,
          this.flight,
          this.classes[dragon.classId],
          this.collision,
          this.scratch,
        );
      }
      const state = this.states[index];
      if (state !== undefined) {
        copyDragonState(state, dragon);
        this.stateTicks[index] = tick;
      }
    }
    return tick;
  }

  /**
   * Fills an INPUT message with the newest input and as many of the frames before it as are
   * stored and consecutive (up to the packet's redundancy). Returns the frame count; 0 means
   * there is nothing to send yet.
   *
   * @param hasAck False until a snapshot has been received.
   * @param ackSnapshotTick Tick (full or wire) of the newest snapshot received.
   */
  writeInputMessage(msg: InputMessage, hasAck: boolean, ackSnapshotTick: number): number {
    let count = 0;
    for (let i = 0; i < INPUT_FRAMES_PER_PACKET; i++) {
      const tick = this.lastTick - i;
      const index = tick & HISTORY_MASK;
      const stored = this.inputs[index];
      const out = msg.frames[i];
      if (
        tick < 0 ||
        this.inputTicks[index] !== tick ||
        stored === undefined ||
        out === undefined
      ) {
        break;
      }
      copyInputFrame(out, stored);
      count++;
    }
    msg.frameCount = count;
    msg.tick = this.lastTick & 0xffff;
    msg.hasAck = hasAck;
    msg.ackSnapshotTick = hasAck ? ackSnapshotTick & 0xffff : 0;
    return count;
  }

  /**
   * Applies a decoded snapshot (see the top of the file). `snapshotTick` is its FULL tick, as
   * returned by `SnapshotBuffer.push`.
   */
  reconcile(snapshot: Readonly<SnapshotMessage>, snapshotTick: number): ReconcileResult {
    if (this.id === NO_PLAYER) return RECONCILE_IGNORED;
    if (snapshotTick <= this.authTick) return RECONCILE_IGNORED;
    this.authTick = snapshotTick;

    const dragon = this.current;
    const owner = snapshot.owner;
    if (!snapshot.hasOwner || owner.id !== this.id) {
      if (dragon.active) {
        resetDragonState(dragon);
        resetDragonState(this.previous);
        this.stateTicks.fill(-1);
        this.clearOffset();
      }
      return RECONCILE_NO_OWNER;
    }

    const wasActive = dragon.active;
    const present = this.lastTick;
    const index = snapshotTick & HISTORY_MASK;
    const predicted = this.states[index];
    const hasPredicted =
      wasActive && predicted !== undefined && this.stateTicks[index] === snapshotTick;

    if (hasPredicted && present >= snapshotTick && ownerMatches(predicted, owner)) {
      this.matches++;
      this.lastCorrection = 0;
      return RECONCILE_MATCHED;
    }

    // A respawn is not a misprediction to smooth: the dragon really is somewhere else now.
    const respawned =
      hasPredicted &&
      (((owner.flags & DRAGON_FLAG_ALIVE) !== 0 && (predicted.flags & DRAGON_FLAG_ALIVE) === 0) ||
        owner.spawnProtectTicks > predicted.spawnProtectTicks + 1);

    // --- Where the dragon is drawn right now (state + offset) -----------------------------------
    const offset = this.positionOffset;
    const rotation = this.rotationOffset;
    const oldX = dragon.position.x;
    const oldY = dragon.position.y;
    const oldZ = dragon.position.z;
    const drawnX = oldX + offset.x;
    const drawnY = oldY + offset.y;
    const drawnZ = oldZ + offset.z;
    // drawn = rotationOffset * orientation
    const ox = dragon.orientation.x;
    const oy = dragon.orientation.y;
    const oz = dragon.orientation.z;
    const ow = dragon.orientation.w;
    const drawnQx = rotation.w * ox + rotation.x * ow + rotation.y * oz - rotation.z * oy;
    const drawnQy = rotation.w * oy - rotation.x * oz + rotation.y * ow + rotation.z * ox;
    const drawnQz = rotation.w * oz + rotation.x * oy - rotation.y * ox + rotation.z * ow;
    const drawnQw = rotation.w * ow - rotation.x * ox - rotation.y * oy - rotation.z * oz;

    // --- Reset to the host's state --------------------------------------------------------------
    const cls = this.classes[this.classId];
    dragon.active = true;
    dragon.team = this.team;
    dragon.classId = this.classId;
    applySnapshotOwner(dragon, owner);
    // The fallback position is only used for a non-finite position, which the decoder already
    // refuses.
    finalizeDragon(dragon, this.flight, cls, null);
    if (predicted !== undefined) {
      copyDragonState(predicted, dragon);
      this.stateTicks[index] = snapshotTick;
    }

    // --- Replay the inputs the host has not simulated yet ---------------------------------------
    const pending = present - snapshotTick;
    let replayed = 0;
    if (pending > 0 && pending <= PREDICTION_MAX_REPLAY_TICKS) {
      for (let tick = snapshotTick + 1; tick <= present; tick++) {
        const slot = tick & HISTORY_MASK;
        const stored = this.inputs[slot];
        const input = this.inputTicks[slot] === tick ? stored : undefined;
        if (tick === present) copyDragonState(this.previous, dragon);
        if (tick >= this.simStart) {
          stepDragon(dragon, input, this.flight, cls, this.collision, this.scratch);
        }
        const state = this.states[slot];
        if (state !== undefined) {
          copyDragonState(state, dragon);
          this.stateTicks[slot] = tick;
        }
        replayed++;
      }
    } else {
      // Behind the host (or hopelessly ahead): nothing to replay. Keep the last tick's motion in
      // `previous` by moving it along with the correction, so render interpolation carries on.
      const previous = this.previous;
      if (wasActive) {
        previous.position.x += dragon.position.x - oldX;
        previous.position.y += dragon.position.y - oldY;
        previous.position.z += dragon.position.z - oldZ;
        const px = previous.position.x;
        const py = previous.position.y;
        const pz = previous.position.z;
        copyDragonState(previous, dragon);
        previous.position.x = px;
        previous.position.y = py;
        previous.position.z = pz;
      } else {
        copyDragonState(previous, dragon);
      }
    }
    this.replayed = replayed;

    // --- Visual error ---------------------------------------------------------------------------
    const errorX = drawnX - dragon.position.x;
    const errorY = drawnY - dragon.position.y;
    const errorZ = drawnZ - dragon.position.z;
    const errorSq = errorX * errorX + errorY * errorY + errorZ * errorZ;

    if (!wasActive || respawned || !(errorSq <= RECONCILE_SNAP_DISTANCE_M ** 2)) {
      this.clearOffset();
      this.snaps++;
      if (wasActive) this.lastCorrection = Math.sqrt(errorSq);
      else this.lastCorrection = 0;
      return RECONCILE_SNAPPED;
    }

    offset.x = errorX;
    offset.y = errorY;
    offset.z = errorZ;
    // rotationOffset = drawn * conjugate(new orientation), kept on the short side (w >= 0).
    const nx = -dragon.orientation.x;
    const ny = -dragon.orientation.y;
    const nz = -dragon.orientation.z;
    const nw = dragon.orientation.w;
    const rx = drawnQw * nx + drawnQx * nw + drawnQy * nz - drawnQz * ny;
    const ry = drawnQw * ny - drawnQx * nz + drawnQy * nw + drawnQz * nx;
    const rz = drawnQw * nz + drawnQx * ny - drawnQy * nx + drawnQz * nw;
    const rw = drawnQw * nw - drawnQx * nx - drawnQy * ny - drawnQz * nz;
    const lengthSq = rx * rx + ry * ry + rz * rz + rw * rw;
    if (lengthSq > 1e-12) {
      const inverse = (rw < 0 ? -1 : 1) / Math.sqrt(lengthSq);
      rotation.x = rx * inverse;
      rotation.y = ry * inverse;
      rotation.z = rz * inverse;
      rotation.w = rw * inverse;
    } else {
      rotation.x = 0;
      rotation.y = 0;
      rotation.z = 0;
      rotation.w = 1;
    }

    const magnitude = Math.sqrt(errorSq);
    this.lastCorrection = magnitude;
    if (magnitude > this.largestCorrection) this.largestCorrection = magnitude;
    this.corrections++;
    return RECONCILE_CORRECTED;
  }

  /**
   * Decays the visual offset. Call once per rendered frame with the frame time in ms
   * (unscaled: this is about what the eye sees, not about sim time).
   */
  updateSmoothing(dtMs: number): void {
    if (!(dtMs > 0)) return;
    const keep = Math.exp(-dtMs / SMOOTH_TAU_MS);
    const offset = this.positionOffset;
    offset.x *= keep;
    offset.y *= keep;
    offset.z *= keep;
    if (
      offset.x * offset.x + offset.y * offset.y + offset.z * offset.z <
      OFFSET_EPSILON_M * OFFSET_EPSILON_M
    ) {
      offset.x = 0;
      offset.y = 0;
      offset.z = 0;
    }
    // nlerp toward the identity; `w` is kept >= 0, so this is the short way.
    const rotation = this.rotationOffset;
    const x = rotation.x * keep;
    const y = rotation.y * keep;
    const z = rotation.z * keep;
    const w = rotation.w * keep + (1 - keep);
    const vectorSq = x * x + y * y + z * z;
    if (vectorSq < OFFSET_EPSILON_QUAT) {
      rotation.x = 0;
      rotation.y = 0;
      rotation.z = 0;
      rotation.w = 1;
      return;
    }
    const inverse = 1 / Math.sqrt(vectorSq + w * w);
    rotation.x = x * inverse;
    rotation.y = y * inverse;
    rotation.z = z * inverse;
    rotation.w = w * inverse;
  }

  /**
   * Writes the dragon as it should be drawn: `previous` -> `current` blended by `alpha` (the
   * fixed loop's banked fraction of a tick), plus the decaying reconciliation offset. Every
   * field of `out` is written. Only meaningful while `active`.
   */
  writeView(out: MutableDragonView, alpha: number): void {
    const now = this.current;
    const before = this.previous.active ? this.previous : now;
    const t = Math.max(0, Math.min(1, alpha));
    const offset = this.positionOffset;

    out.id = now.id;
    out.team = now.team;
    out.classId = now.classId;
    out.position.x = before.position.x + (now.position.x - before.position.x) * t + offset.x;
    out.position.y = before.position.y + (now.position.y - before.position.y) * t + offset.y;
    out.position.z = before.position.z + (now.position.z - before.position.z) * t + offset.z;
    out.velocity.x = before.velocity.x + (now.velocity.x - before.velocity.x) * t;
    out.velocity.y = before.velocity.y + (now.velocity.y - before.velocity.y) * t;
    out.velocity.z = before.velocity.z + (now.velocity.z - before.velocity.z) * t;

    // nlerp previous -> current, shorter arc.
    const qa = before.orientation;
    const qb = now.orientation;
    const sign = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w < 0 ? -1 : 1;
    const u = 1 - t;
    const st = sign * t;
    const qx = qa.x * u + qb.x * st;
    const qy = qa.y * u + qb.y * st;
    const qz = qa.z * u + qb.z * st;
    const qw = qa.w * u + qb.w * st;
    // Then the offset on top: drawn = rotationOffset * q.
    const r = this.rotationOffset;
    const dx = r.w * qx + r.x * qw + r.y * qz - r.z * qy;
    const dy = r.w * qy - r.x * qz + r.y * qw + r.z * qx;
    const dz = r.w * qz + r.x * qy - r.y * qx + r.z * qw;
    const dw = r.w * qw - r.x * qx - r.y * qy - r.z * qz;
    const lengthSq = dx * dx + dy * dy + dz * dz + dw * dw;
    if (lengthSq > 1e-12) {
      const inverse = 1 / Math.sqrt(lengthSq);
      out.orientation.x = dx * inverse;
      out.orientation.y = dy * inverse;
      out.orientation.z = dz * inverse;
      out.orientation.w = dw * inverse;
    } else {
      out.orientation.x = qb.x;
      out.orientation.y = qb.y;
      out.orientation.z = qb.z;
      out.orientation.w = qb.w;
    }

    // maxHealth is 0 only for a dragon that is not there; the floor keeps the division finite.
    out.health = Math.max(0, Math.min(1, now.health / Math.max(now.maxHealth, 1e-6)));
    out.stamina = Math.max(0, Math.min(1, now.stamina));
    out.flags = now.flags;
    out.anim = now.anim;
  }

  /** Length of the visual position offset still to be smoothed out, in metres. */
  get visualOffsetM(): number {
    const offset = this.positionOffset;
    return Math.sqrt(offset.x * offset.x + offset.y * offset.y + offset.z * offset.z);
  }

  /** Angle of the visual orientation offset still to be smoothed out, in radians. */
  get visualOffsetRad(): number {
    const w = this.rotationOffset.w;
    return 2 * Math.acos(w > 1 ? 1 : w < -1 ? -1 : w);
  }

  /** Size (m) of the correction the last `reconcile` made; 0 if it matched. */
  get lastCorrectionM(): number {
    return this.lastCorrection;
  }

  /** Largest smoothed correction since the last reset (snaps are not counted). */
  get largestCorrectionM(): number {
    return this.largestCorrection;
  }

  /** Snapshots that needed a smoothed correction. */
  get correctionCount(): number {
    return this.corrections;
  }

  /** Snapshots after which the picture snapped. */
  get snapCount(): number {
    return this.snaps;
  }

  /** Snapshots that agreed with the prediction. */
  get matchCount(): number {
    return this.matches;
  }

  /** Ticks the last correcting `reconcile` replayed. */
  get replayedTicks(): number {
    return this.replayed;
  }

  private clearOffset(): void {
    this.positionOffset.x = 0;
    this.positionOffset.y = 0;
    this.positionOffset.z = 0;
    this.rotationOffset.x = 0;
    this.rotationOffset.y = 0;
    this.rotationOffset.z = 0;
    this.rotationOffset.w = 1;
  }
}
