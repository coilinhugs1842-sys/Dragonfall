/**
 * The simulation: the seam the fixed loop drives. It keeps the previous and current tick states
 * so `game/` can interpolate between them with the loop's alpha when it builds the WorldView.
 *
 * Phase 1: dragons fly (flight.ts) and are handed to an optional collision world. Later phases
 * add projectiles, zones and scoring inside `step`.
 */

import { CLASS_TUNING, FLIGHT_TUNING, MATCH_TUNING, NO_PLAYER, TICK_DT_S } from '../shared';
import type {
  ClassTuning,
  DragonClassId,
  FlightTuning,
  InputFrame,
  MatchTuning,
  MutableVec3,
  PlayerId,
  TeamId,
  Vec3,
} from '../shared';
import { NULL_COLLISION_WORLD } from './collision-world';
import type { SimCollisionWorld } from './collision-world';
import { copyDragonState, resetDragonState } from './dragon-state';
import type { DragonState } from './dragon-state';
import { finalizeDragon, initDragon, integrateDragon } from './flight';
import { copySimState, createSimState, findDragonSlot, resetSimState } from './sim-state';
import type { SimState } from './sim-state';

/**
 * Inputs for one tick, indexed by `PlayerId` (a `u8`, so a plain array lookup with no hashing).
 * A missing entry means no input arrived for that player this tick: the dragon then flies
 * straight with the buttons it held last tick (no new presses), so a lost packet neither drops
 * a boost nor fakes a dodge.
 */
export type SimInputs = readonly (Readonly<InputFrame> | undefined)[];

export interface SimOptions {
  /** Tuning tables, read live every tick. Default: the shared tables the dev GUI edits. */
  flightTuning?: FlightTuning;
  classTuning?: Record<DragonClassId, ClassTuning>;
  matchTuning?: MatchTuning;
  /** Default: open sky (NULL_COLLISION_WORLD). */
  collisionWorld?: SimCollisionWorld;
}

export interface Sim {
  /** State after the tick before the latest one (the initial state until two steps have run). */
  readonly prev: Readonly<SimState>;
  /** State after the latest tick. */
  readonly current: Readonly<SimState>;
  /** The flight table this sim reads (mutate it to tune live). */
  readonly flightTuning: FlightTuning;
  /**
   * Advances exactly one fixed tick (`TICK_DT_S`): every active dragon is integrated with its
   * input, resolved against the collision world and finalised. Deterministic, allocation-free.
   */
  step(tick: number, inputs: SimInputs): void;
  /** Despawns everything and rewinds time. Tuning and the collision world are kept. */
  reset(): void;
  /**
   * Puts a living dragon into the world at cruise speed, level, facing `yaw` (radians about +Y,
   * 0 = +Z). If the player already has a dragon it is re-initialised in place (respawn). The
   * dragon is written to `prev` as well, so the view does not interpolate it in from stale data.
   * Returns the dragon in `current`, or null if the id is not a valid player id or all
   * MAX_PLAYERS slots are taken. Call between steps, not from inside one.
   */
  spawnDragon(
    playerId: PlayerId,
    team: TeamId,
    classId: DragonClassId,
    position: Vec3,
    yaw: number,
  ): DragonState | null;
  /** Frees the player's slot in both states. Returns false if the player had no dragon. */
  despawnDragon(playerId: PlayerId): boolean;
  /** The player's dragon in `current` (mutable, for systems and tests), or undefined. */
  getDragon(playerId: PlayerId): DragonState | undefined;
  /** Swaps the collision world (map load/unload); null = open sky. */
  setCollisionWorld(world: SimCollisionWorld | null): void;
}

/**
 * One dragon, one fixed tick: flight integration, collision, then the derived fields. This is
 * the whole per-dragon part of `Sim.step`, exported so client prediction (`src/net/prediction`)
 * replays exactly the code the host ran instead of a copy of it.
 *
 * `input` undefined = no input for this tick: the dragon flies straight with the buttons it held
 * last tick (see `SimInputs`). `scratch` is overwritten with the position before the step.
 * Deterministic and allocation-free.
 */
export function stepDragon(
  dragon: DragonState,
  input: Readonly<InputFrame> | undefined,
  flight: FlightTuning,
  cls: ClassTuning,
  collision: SimCollisionWorld,
  scratch: MutableVec3,
): void {
  scratch.x = dragon.position.x;
  scratch.y = dragon.position.y;
  scratch.z = dragon.position.z;
  integrateDragon(dragon, input, flight, cls);
  collision.resolveDragon(dragon, scratch, TICK_DT_S, flight);
  finalizeDragon(dragon, flight, cls, scratch);
}

export function createSim(options: SimOptions = {}): Sim {
  const flight = options.flightTuning ?? FLIGHT_TUNING;
  const classes = options.classTuning ?? CLASS_TUNING;
  const match = options.matchTuning ?? MATCH_TUNING;
  let collision = options.collisionWorld ?? NULL_COLLISION_WORLD;

  // Two buffers swapped each tick: interpolation needs both ends and must not allocate.
  let prev = createSimState();
  let current = createSimState();
  /** Reused for the `prevPosition` argument of the collision world. */
  const prevPosition: MutableVec3 = { x: 0, y: 0, z: 0 };

  return {
    get prev() {
      return prev;
    },
    get current() {
      return current;
    },
    flightTuning: flight,

    step(tick, inputs) {
      const next = prev;
      prev = current;
      current = copySimState(next, prev);

      current.tick = tick;
      // Derived from the tick rather than summed, so float error cannot build up over a match.
      current.timeS = (tick + 1) * TICK_DT_S;

      // Slot order, which is the same on every machine that saw the same spawns.
      const dragons = current.dragons;
      for (let i = 0; i < dragons.length; i++) {
        const dragon = dragons[i];
        if (dragon === undefined || !dragon.active) continue;
        stepDragon(
          dragon,
          inputs[dragon.id],
          flight,
          classes[dragon.classId],
          collision,
          prevPosition,
        );
      }
      // Phase 3+: projectiles, zones, scoring.
    },

    reset() {
      resetSimState(prev);
      resetSimState(current);
    },

    spawnDragon(playerId, team, classId, position, yaw) {
      if (!Number.isInteger(playerId) || playerId < 0 || playerId >= NO_PLAYER) return null;
      let slot = findDragonSlot(current, playerId);
      const isNew = slot < 0;
      if (isNew) {
        for (let i = 0; i < current.dragons.length; i++) {
          if (current.dragons[i]?.active === false) {
            slot = i;
            break;
          }
        }
        if (slot < 0) return null;
      }
      const dragon = current.dragons[slot];
      const prevDragon = prev.dragons[slot];
      if (dragon === undefined || prevDragon === undefined) return null;

      initDragon(
        dragon,
        playerId,
        team,
        classId,
        position.x,
        position.y,
        position.z,
        yaw,
        flight,
        classes[classId],
        match,
      );
      const wasActiveInPrev = prevDragon.active;
      copyDragonState(prevDragon, dragon);
      if (isNew) current.dragonCount++;
      if (!wasActiveInPrev) prev.dragonCount++;
      return dragon;
    },

    despawnDragon(playerId) {
      const slot = findDragonSlot(current, playerId);
      if (slot < 0) return false;
      const dragon = current.dragons[slot];
      const prevDragon = prev.dragons[slot];
      if (dragon !== undefined) {
        resetDragonState(dragon);
        current.dragonCount--;
      }
      if (prevDragon !== undefined && prevDragon.active) {
        resetDragonState(prevDragon);
        prev.dragonCount--;
      }
      return true;
    },

    getDragon(playerId) {
      const slot = findDragonSlot(current, playerId);
      return slot < 0 ? undefined : current.dragons[slot];
    },

    setCollisionWorld(world) {
      collision = world ?? NULL_COLLISION_WORLD;
    },
  };
}
