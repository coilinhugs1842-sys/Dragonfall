/**
 * The simulation: the seam the fixed loop drives. It keeps the previous and current tick states
 * so `game/` can interpolate between them with the loop's alpha when it builds the WorldView.
 *
 * One tick (`step`):
 *   1. every active dragon: abilities + flight (flight.ts, abilities.ts), collision, derived
 *      fields. This is `stepDragon`, the part a client also runs to predict its own dragon;
 *   2. combat (combat.ts): what the casts do to the world, projectiles, zones, statuses, the
 *      damage pipeline, takedowns and respawns. Host only.
 *
 * Seams for the layers above (the session, the match modes, lag compensation):
 * - `setEventSink`: where GameEvents go (hit, takedown, assist, spawn, abilityCast,
 *   statusApplied, impact);
 * - `rules`, `respawnPolicy`, `setStormRadius`, `respawnDragon`, `clearEffects`: what a mode
 *   controls;
 * - `setTargetPositions`: the lag-compensation hook;
 * - `current.scores`, `current.teamTakedowns`: the running score sheet.
 */

import {
  ABILITY_TABLE,
  CLASS_TUNING,
  COMBAT_TUNING,
  FLIGHT_TUNING,
  MATCH_TUNING,
  NO_PLAYER,
  PROJECTILE_DEFS,
  TICK_DT_S,
  ZONE_DEFS,
} from '../shared';
import type {
  AbilityTable,
  ClassAbilities,
  ClassTuning,
  CombatTuning,
  DamageSource,
  DragonClassId,
  FlightTuning,
  GameEventSink,
  InputFrame,
  MatchTuning,
  MutableVec3,
  PlayerId,
  ProjectileDef,
  ProjectileKind,
  StatusKind,
  TeamId,
  Vec3,
  ZoneDef,
  ZoneKind,
} from '../shared';
import { DAMAGE_SOURCES } from '../shared';
import { NULL_COLLISION_WORLD } from './collision-world';
import type { SimCollisionWorld } from './collision-world';
import { CURRENT_TARGET_POSITIONS, CombatSystem } from './combat';
import type { RespawnPolicy, SimRules, TargetPositionSource } from './combat';
import { copyDragonState, resetDragonState } from './dragon-state';
import type { DragonState } from './dragon-state';
import { finalizeDragon, initDragon, integrateDragon } from './flight';
import {
  clearSimEffects,
  copySimState,
  createSimState,
  findDragonSlot,
  resetScoreState,
  resetSimState,
} from './sim-state';
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
  abilityTable?: AbilityTable;
  projectileDefs?: Record<ProjectileKind, ProjectileDef>;
  zoneDefs?: Record<ZoneKind, ZoneDef>;
  combatTuning?: CombatTuning;
  /** Default: open sky (NULL_COLLISION_WORLD). */
  collisionWorld?: SimCollisionWorld;
  /** Where GameEvents go. Default: nowhere. */
  events?: GameEventSink;
  /** The lag-compensation hook. Default: current positions. */
  targetPositions?: TargetPositionSource;
}

export interface Sim {
  /** State after the tick before the latest one (the initial state until two steps have run). */
  readonly prev: Readonly<SimState>;
  /** State after the latest tick. */
  readonly current: Readonly<SimState>;
  /** The flight table this sim reads (mutate it to tune live). */
  readonly flightTuning: FlightTuning;
  /** Match rules, read every tick (mutate them: `sim.rules.friendlyFire = true`). */
  readonly rules: SimRules;
  /** How the dead come back, read every tick (mutate it: `sim.respawnPolicy.enabled = false`). */
  readonly respawnPolicy: RespawnPolicy;
  /**
   * Advances exactly one fixed tick (`TICK_DT_S`): every active dragon is integrated with its
   * input, resolved against the collision world and finalised, then combat runs.
   * Deterministic, allocation-free.
   */
  step(tick: number, inputs: SimInputs): void;
  /** Despawns everything, clears scores and rewinds time. Tuning, rules and hooks are kept. */
  reset(): void;
  /**
   * Puts a living dragon into the world at cruise speed, level, facing `yaw` (radians about +Y,
   * 0 = +Z). The pose becomes its home: where it respawns. If the player already has a dragon it
   * is re-initialised in place (its score is kept). The dragon is written to `prev` as well, so
   * the view does not interpolate it in from stale data. Emits nothing (the caller announces
   * the first spawn). Returns the dragon in `current`, or null if the id is not a valid player
   * id or all MAX_PLAYERS slots are taken. Call between steps, not from inside one.
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

  // --- Combat seams -----------------------------------------------------------------------------
  /** Where GameEvents go from now on; null = nowhere. */
  setEventSink(sink: GameEventSink | null): void;
  /** The lag-compensation hook; null = current positions. */
  setTargetPositions(source: TargetPositionSource | null): void;
  /**
   * Moves the storm wall for the following ticks (a mode may call it every tick). A negative
   * radius restores the map's own. Stored in the state (`current.stormRadius`) for snapshots.
   */
  setStormRadius(radius: number): void;
  /**
   * Respawns the player's dragon now, dead or alive, at its home pose or where the respawn
   * policy puts it (a new Duel round). Emits `spawn`. False if the player has no dragon.
   */
  respawnDragon(playerId: PlayerId): boolean;
  /** Removes every projectile and zone (a new round). */
  clearEffects(): void;
  /**
   * The damage pipeline, for whatever is not an ability (objectives, modes, tests): see
   * `CombatSystem.applyDamage`. `attackerId` NO_PLAYER = the environment. `originX/Y/Z` is where
   * it comes from (a wing shield blocks its front). Returns the HP removed.
   */
  applyDamage(
    targetId: PlayerId,
    amount: number,
    attackerId: PlayerId,
    source: DamageSource,
    flags?: number,
    origin?: Vec3,
  ): number;
  /** Gives a dragon a timed effect: see `CombatSystem.applyStatus`. */
  applyStatus(
    targetId: PlayerId,
    status: StatusKind,
    seconds: number,
    power: number,
    sourceId: PlayerId,
  ): boolean;
  /** Adds ultimate charge (0..1) to a dragon: objectives charge the ultimate too. */
  addUltimateCharge(playerId: PlayerId, amount: number): void;
}

/**
 * One dragon, one fixed tick: abilities and flight integration, collision, then the derived
 * fields. This is the whole per-dragon part of `Sim.step`, exported so client prediction
 * (`src/net/prediction`) replays exactly the code the host ran instead of a copy of it.
 *
 * `input` undefined = no input for this tick: the dragon flies straight with the buttons it held
 * last tick (see `SimInputs`). `scratch` is overwritten with the position before the step.
 * `abilities` is the class's row of the ability table; without it the ability buttons do
 * nothing. Deterministic and allocation-free.
 */
export function stepDragon(
  dragon: DragonState,
  input: Readonly<InputFrame> | undefined,
  flight: FlightTuning,
  cls: ClassTuning,
  collision: SimCollisionWorld,
  scratch: MutableVec3,
  abilities?: ClassAbilities,
): void {
  scratch.x = dragon.position.x;
  scratch.y = dragon.position.y;
  scratch.z = dragon.position.z;
  integrateDragon(dragon, input, flight, cls, abilities);
  collision.resolveDragon(dragon, scratch, TICK_DT_S, flight);
  finalizeDragon(dragon, flight, cls, scratch);
}

export function createSim(options: SimOptions = {}): Sim {
  const flight = options.flightTuning ?? FLIGHT_TUNING;
  const classes = options.classTuning ?? CLASS_TUNING;
  const match = options.matchTuning ?? MATCH_TUNING;
  const abilities = options.abilityTable ?? ABILITY_TABLE;
  let collision = options.collisionWorld ?? NULL_COLLISION_WORLD;

  // Two buffers swapped each tick: interpolation needs both ends and must not allocate.
  let prev = createSimState();
  let current = createSimState();
  /** Reused for the `prevPosition` argument of the collision world. */
  const prevPosition: MutableVec3 = { x: 0, y: 0, z: 0 };

  const combat = new CombatSystem(
    {
      flight,
      classes,
      match,
      abilities,
      projectiles: options.projectileDefs ?? PROJECTILE_DEFS,
      zones: options.zoneDefs ?? ZONE_DEFS,
      combat: options.combatTuning ?? COMBAT_TUNING,
    },
    collision,
    current,
  );
  combat.events = options.events ?? null;
  combat.targets = options.targetPositions ?? CURRENT_TARGET_POSITIONS;

  return {
    get prev() {
      return prev;
    },
    get current() {
      return current;
    },
    flightTuning: flight,
    rules: combat.rules,
    respawnPolicy: combat.respawnPolicy,

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
          abilities[dragon.classId],
        );
      }
      combat.step(current, prev, tick);
    },

    reset() {
      resetSimState(prev);
      resetSimState(current);
      combat.bind(current, prev);
      collision.setStormRadius?.(-1);
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
      if (isNew) {
        current.dragonCount++;
        const score = current.scores[slot];
        const prevScore = prev.scores[slot];
        if (score !== undefined) resetScoreState(score);
        if (prevScore !== undefined) resetScoreState(prevScore);
      }
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
      combat.collision = collision;
      if (current.stormRadius >= 0) collision.setStormRadius?.(current.stormRadius);
    },

    setEventSink(sink) {
      combat.events = sink;
    },

    setTargetPositions(source) {
      combat.targets = source ?? CURRENT_TARGET_POSITIONS;
    },

    setStormRadius(radius) {
      const value = radius >= 0 && Number.isFinite(radius) ? radius : -1;
      current.stormRadius = value;
      collision.setStormRadius?.(value);
    },

    respawnDragon(playerId) {
      const slot = findDragonSlot(current, playerId);
      const dragon = current.dragons[slot];
      if (slot < 0 || dragon === undefined) return false;
      combat.bind(current, prev);
      combat.respawn(dragon, slot);
      return true;
    },

    clearEffects() {
      clearSimEffects(current);
    },

    applyDamage(targetId, amount, attackerId, source, flags = 0, origin) {
      const slot = findDragonSlot(current, targetId);
      const target = current.dragons[slot];
      if (slot < 0 || target === undefined) return 0;
      const attackerSlot = attackerId === NO_PLAYER ? -1 : findDragonSlot(current, attackerId);
      const attacker = attackerSlot < 0 ? null : (current.dragons[attackerSlot] ?? null);
      combat.bind(current, prev);
      // No origin: from straight ahead of the target, where its shield is.
      if (origin !== undefined) combat.setDamageOrigin(origin.x, origin.y, origin.z);
      else {
        combat.setDamageOrigin(target.position.x, target.position.y, target.position.z);
      }
      const index = DAMAGE_SOURCES.indexOf(source);
      return combat.applyDamage(target, amount, attacker, index < 0 ? 0 : index, flags);
    },

    applyStatus(targetId, status, seconds, power, sourceId) {
      const slot = findDragonSlot(current, targetId);
      const target = current.dragons[slot];
      if (slot < 0 || target === undefined) return false;
      const sourceSlot = sourceId === NO_PLAYER ? -1 : findDragonSlot(current, sourceId);
      const source = sourceSlot < 0 ? null : (current.dragons[sourceSlot] ?? null);
      combat.bind(current, prev);
      combat.setDamageOrigin(target.position.x, target.position.y, target.position.z);
      return combat.applyStatus(target, status, seconds, power, source, 0, 0);
    },

    addUltimateCharge(playerId, amount) {
      const slot = findDragonSlot(current, playerId);
      const dragon = current.dragons[slot];
      if (slot >= 0 && dragon !== undefined) combat.addUltimateCharge(dragon, amount);
    },
  };
}
