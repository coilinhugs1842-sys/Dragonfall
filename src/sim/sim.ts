/**
 * Sim skeleton: the seam the fixed loop drives. It keeps the previous and current tick states
 * so `game/` can interpolate between them with the loop's alpha when it builds the WorldView.
 *
 * There is deliberately no gameplay here yet. Later phases add systems inside `step`.
 */

import { TICK_DT_S } from '../shared';
import type { InputFrame } from '../shared';
import { copySimState, createSimState, resetSimState } from './sim-state';
import type { SimState } from './sim-state';

/**
 * Inputs for one tick, indexed by `PlayerId` (a `u8`, so a plain array lookup with no hashing).
 * A missing entry means no input arrived for that player this tick.
 */
export type SimInputs = readonly (Readonly<InputFrame> | undefined)[];

export interface Sim {
  /** State after the tick before the latest one (the initial state until two steps have run). */
  readonly prev: Readonly<SimState>;
  /** State after the latest tick. */
  readonly current: Readonly<SimState>;
  /** Advances exactly one fixed tick (`TICK_DT_S`). Must stay deterministic and allocation-free. */
  step(tick: number, inputs: SimInputs): void;
  reset(): void;
}

export function createSim(): Sim {
  // Two buffers swapped each tick: interpolation needs both ends and must not allocate.
  let prev = createSimState();
  let current = createSimState();

  return {
    get prev() {
      return prev;
    },
    get current() {
      return current;
    },
    step(tick, _inputs) {
      const next = prev;
      prev = current;
      current = copySimState(next, prev);

      current.tick = tick;
      // Derived from the tick rather than summed, so float error cannot build up over a match.
      current.timeS = (tick + 1) * TICK_DT_S;
      // Phase 1+: apply `_inputs` to dragons, then projectiles, zones, scoring.
    },
    reset() {
      resetSimState(prev);
      resetSimState(current);
    },
  };
}
