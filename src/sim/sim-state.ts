/**
 * The simulation's state for one tick: time plus a fixed pool of dragons (Phase 1 flight).
 * Projectiles, zones and the match clock are added by the phases that implement them.
 *
 * Everything stays mutable and fixed-size so a state can be copied into a reused buffer without
 * allocating. Every field added here must also be copied in `copySimState`.
 */

import { MAX_PLAYERS } from '../shared';
import type { PlayerId } from '../shared';
import { copyDragonState, createDragonState, resetDragonState } from './dragon-state';
import type { DragonState } from './dragon-state';

export interface SimState {
  /** Index of the last tick applied to this state; -1 before the first step. */
  tick: number;
  /** Simulated seconds since the sim was created or reset. */
  timeS: number;
  /**
   * Pool of exactly MAX_PLAYERS slots; the array never grows or shrinks. A slot is live only
   * when `active` is true, and live slots are NOT packed at the front: loop over all of them
   * and skip the inactive ones. The slot index is not the player id (use `findDragon`).
   */
  dragons: DragonState[];
  /** Number of active slots. */
  dragonCount: number;
}

export function createSimState(): SimState {
  const dragons: DragonState[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) dragons.push(createDragonState());
  return { tick: -1, timeS: 0, dragons, dragonCount: 0 };
}

export function resetSimState(state: SimState): SimState {
  state.tick = -1;
  state.timeS = 0;
  for (let i = 0; i < state.dragons.length; i++) {
    const dragon = state.dragons[i];
    if (dragon !== undefined) resetDragonState(dragon);
  }
  state.dragonCount = 0;
  return state;
}

export function copySimState(out: SimState, from: Readonly<SimState>): SimState {
  out.tick = from.tick;
  out.timeS = from.timeS;
  for (let i = 0; i < out.dragons.length; i++) {
    const target = out.dragons[i];
    const source = from.dragons[i];
    if (target !== undefined && source !== undefined) copyDragonState(target, source);
  }
  out.dragonCount = from.dragonCount;
  return out;
}

/** Linear scan (at most MAX_PLAYERS slots). Returns undefined when the player has no dragon. */
export function findDragon(state: Readonly<SimState>, id: PlayerId): DragonState | undefined {
  for (let i = 0; i < state.dragons.length; i++) {
    const dragon = state.dragons[i];
    if (dragon !== undefined && dragon.active && dragon.id === id) return dragon;
  }
  return undefined;
}

/** Slot index of the player's dragon, or -1. The same index is valid in `prev` and `current`. */
export function findDragonSlot(state: Readonly<SimState>, id: PlayerId): number {
  for (let i = 0; i < state.dragons.length; i++) {
    const dragon = state.dragons[i];
    if (dragon !== undefined && dragon.active && dragon.id === id) return i;
  }
  return -1;
}
