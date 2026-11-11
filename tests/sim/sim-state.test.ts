import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, TEAM_EMBER, TEAM_FROST } from '../../src/shared';
import {
  copyDragonState,
  copySimState,
  createDragonState,
  createSim,
  createSimState,
  findDragon,
  findDragonSlot,
  resetDragonState,
  resetSimState,
} from '../../src/sim';
import type { DragonState } from '../../src/sim';

/**
 * Writes a different non-default value into every leaf of a dragon, whatever fields it has, so
 * a field that copy/reset forgets shows up as a mismatch.
 */
function scramble(dragon: DragonState): DragonState {
  let next = 1;
  const visit = (node: Record<string, unknown>): void => {
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'number') node[key] = next++ + 0.5;
      else if (typeof value === 'boolean') node[key] = !value;
      else if (typeof value === 'object' && value !== null) visit(value as Record<string, unknown>);
    }
  };
  visit(dragon as unknown as Record<string, unknown>);
  dragon.classId = 'wraith';
  dragon.team = TEAM_FROST;
  return dragon;
}

describe('DragonState helpers', () => {
  it('copies every field', () => {
    const source = scramble(createDragonState());
    const target = createDragonState();
    expect(copyDragonState(target, source)).toBe(target);
    expect(target).toEqual(source);
    // A deep copy: the vectors are separate objects.
    expect(target.position).not.toBe(source.position);
    expect(target.orientation).not.toBe(source.orientation);
    expect(target.velocity).not.toBe(source.velocity);
    expect(target.burst).not.toBe(source.burst);
  });

  it('resets every field to the value of a new slot', () => {
    const dragon = scramble(createDragonState());
    expect(resetDragonState(dragon)).toEqual(createDragonState());
    expect(dragon.active).toBe(false);
    expect(dragon.team).toBe(TEAM_EMBER);
  });
});

describe('SimState', () => {
  it('has a fixed pool of MAX_PLAYERS free slots', () => {
    const state = createSimState();
    expect(state.dragons).toHaveLength(MAX_PLAYERS);
    expect(state.dragonCount).toBe(0);
    expect(state.tick).toBe(-1);
    for (const dragon of state.dragons) expect(dragon.active).toBe(false);
    expect(new Set(state.dragons).size).toBe(MAX_PLAYERS);
  });

  it('copies and resets the whole state without sharing objects', () => {
    const source = createSimState();
    source.tick = 41;
    source.timeS = 1.4;
    source.dragonCount = 2;
    const first = source.dragons[0];
    const seventh = source.dragons[7];
    if (first === undefined || seventh === undefined) throw new Error('pool too small');
    scramble(first);
    scramble(seventh);

    const target = createSimState();
    const slots = [...target.dragons];
    expect(copySimState(target, source)).toBe(target);
    expect(target).toEqual(source);
    target.dragons.forEach((dragon, index) => {
      expect(dragon).toBe(slots[index]);
      expect(dragon).not.toBe(source.dragons[index]);
    });

    expect(resetSimState(target)).toEqual(createSimState());
  });

  it('finds dragons by player id, not by slot', () => {
    const sim = createSim();
    sim.spawnDragon(9, TEAM_EMBER, 'talon', { x: 0, y: 100, z: 0 }, 0);
    sim.spawnDragon(3, TEAM_FROST, 'bastion', { x: 5, y: 100, z: 0 }, 0);
    expect(findDragonSlot(sim.current, 9)).toBe(0);
    expect(findDragonSlot(sim.current, 3)).toBe(1);
    expect(findDragon(sim.current, 3)?.classId).toBe('bastion');
    expect(findDragon(sim.current, 0)).toBeUndefined();
    expect(findDragonSlot(sim.current, 0)).toBe(-1);
  });
});
