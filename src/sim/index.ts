/** Barrel for the pure simulation. Nothing here may import a view module, scene objects or the DOM. */

export * from './collision';
export { NULL_COLLISION_WORLD } from './collision-world';
export type { SimCollisionWorld } from './collision-world';
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
} from './flight';
export { createSim } from './sim';
export type { Sim, SimInputs, SimOptions } from './sim';
export {
  copySimState,
  createSimState,
  findDragon,
  findDragonSlot,
  resetSimState,
} from './sim-state';
export type { SimState } from './sim-state';
