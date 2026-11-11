/** Barrel for the pure simulation. Nothing here may import a view module, scene objects or the DOM. */

export {
  ABILITY_SLOT_COUNT,
  abilityOfSlot,
  cancelAbilities,
  fireDirectionOf,
  moveScaleOf,
  resolveFireDirection,
  stepAbilities,
} from './abilities';
export * from './collision';
export {
  ENV_SOURCE_NONE,
  ENV_SOURCE_STORM,
  ENV_SOURCE_TERRAIN,
  NULL_COLLISION_WORLD,
  createTerrainRay,
} from './collision-world';
export type { SimCollisionWorld, TerrainRay } from './collision-world';
export {
  CURRENT_TARGET_POSITIONS,
  CombatSystem,
  DAMAGE_IGNORE_IMMUNITY,
  DAMAGE_IGNORE_SHIELD,
  DAMAGE_IGNORE_TEAM,
  DAMAGE_OVER_TIME,
} from './combat';
export type {
  CombatTables,
  RespawnPolicy,
  SimRules,
  SpawnPose,
  TargetPositionSource,
} from './combat';
export { copyDragonState, createDragonState, resetDragonState } from './dragon-state';
export type { DragonState } from './dragon-state';
export { DEFAULT_MAX_STEPS_PER_ADVANCE, FixedStepLoop } from './fixed-loop';
export type { FixedStepFn } from './fixed-loop';
export {
  damageDragon,
  finalizeDragon,
  initDragon,
  integrateDragon,
  maxFlightSpeed,
  minFlightSpeed,
  secondsToTicks,
  setDragonVelocity,
  writeStatusFlags,
} from './flight';
export * from './lobby';
export { createSim, stepDragon } from './sim';
export type { Sim, SimInputs, SimOptions } from './sim';
export {
  clearSimEffects,
  copySimState,
  createProjectileState,
  createSimState,
  createZoneState,
  findDragon,
  findDragonSlot,
  resetSimState,
} from './sim-state';
export type { ProjectileState, ScoreState, SimState, ZoneState } from './sim-state';
