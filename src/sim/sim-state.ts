/**
 * The simulation's state for one tick. Phase 0 only tracks time: dragons, projectiles and the
 * match clock are added by the phases that implement them (Phase 1 flight onward).
 *
 * Fields stay flat and mutable so a state can be copied into a reused buffer without allocating.
 * Every field added here must also be copied in `copySimState`.
 */

export interface SimState {
  /** Index of the last tick applied to this state; -1 before the first step. */
  tick: number;
  /** Simulated seconds since the sim was created or reset. */
  timeS: number;
}

export function createSimState(): SimState {
  return { tick: -1, timeS: 0 };
}

export function resetSimState(state: SimState): SimState {
  state.tick = -1;
  state.timeS = 0;
  return state;
}

export function copySimState(out: SimState, from: Readonly<SimState>): SimState {
  out.tick = from.tick;
  out.timeS = from.timeS;
  return out;
}
