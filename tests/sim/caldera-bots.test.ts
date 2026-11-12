/**
 * Bots on Emberfall Caldera (T-6.4): the heat vents push a dragon the bot brain did not ask to
 * be pushed. This checks that the push does not confuse it: bots that fly and fight through
 * the caldera do not kill themselves on rock or in the storm any more than on the same rock
 * with the vents switched off. (The brain itself is tests/sim/bots.test.ts.)
 */

import { describe, expect, it } from 'vitest';
import {
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_IN_STORM,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
  createEmberfallCaldera,
  createInputFrame,
  heatVentStrengthAt,
} from '../../src/shared';
import type { ArenaMap, GameEvent, InputFrame, TeamId } from '../../src/shared';
import { createMapCollisionWorld, createSim } from '../../src/sim';
import { BotBrain } from '../../src/sim/bots';
import type { BotArena, BotContext } from '../../src/sim/bots';

const CALDERA = createEmberfallCaldera();
const NO_VENTS: ArenaMap = { ...CALDERA, vents: [] };
/** Gate slots in the order riders take them (centre first). */
const SLOT_ORDER = [2, 1, 3, 0, 4];

interface Flown {
  takedowns: number;
  selfInflicted: number;
  terrainDamage: number;
  stormDamage: number;
  stormTicks: number;
  ventTicks: number;
  dragonTicks: number;
  highest: number;
}

/** A 3v3 of bots on `map` for `seconds`, everything through the real sim. */
function fly(map: ArenaMap, seed: number, seconds: number): Flown {
  const collision = createMapCollisionWorld(map);
  const arena: BotArena = {
    centerX: map.colliders.stormCenter.x,
    centerZ: map.colliders.stormCenter.z,
    radius: map.colliders.stormRadius,
    floorY: map.colliders.floorY,
    ceilingY: map.colliders.ceilingY,
  };
  const flown: Flown = {
    takedowns: 0,
    selfInflicted: 0,
    terrainDamage: 0,
    stormDamage: 0,
    stormTicks: 0,
    ventTicks: 0,
    dragonTicks: 0,
    highest: -Infinity,
  };
  const sim = createSim({
    collisionWorld: collision,
    events: {
      emit(event: GameEvent) {
        if (event.type === 'hit') {
          if (event.source === 'terrain') flown.terrainDamage += event.damage;
          else if (event.source === 'storm') flown.stormDamage += event.damage;
        } else if (event.type === 'takedown') {
          flown.takedowns++;
          if (event.killerId === NO_PLAYER) flown.selfInflicted++;
        }
      },
    },
  });
  const brains: BotBrain[] = [];
  const frames: InputFrame[] = [];
  const teams: readonly TeamId[] = [TEAM_EMBER, TEAM_FROST];
  let id = 0;
  for (const team of teams) {
    for (let i = 0; i < 3; i++) {
      const slot = map.spawnGates[team]?.slots[SLOT_ORDER[i] ?? 0];
      if (slot === undefined) throw new Error('no gate slot');
      const classId = DRAGON_CLASS_IDS[(id + seed) % DRAGON_CLASS_IDS.length] ?? 'talon';
      sim.spawnDragon(id, team, classId, slot, team === TEAM_EMBER ? 0 : Math.PI);
      brains.push(new BotBrain(seed * 1000 + id));
      frames.push(createInputFrame());
      id++;
    }
  }
  const ctx: BotContext = { state: sim.current, collision, arena, playing: true };
  const inputs: (InputFrame | undefined)[] = [];
  for (let tick = 0; tick < seconds * TICK_HZ; tick++) {
    ctx.state = sim.current;
    for (let b = 0; b < brains.length; b++) {
      const frame = frames[b];
      if (frame === undefined) continue;
      brains[b]?.think(ctx, b, frame);
      frame.tick = tick;
      inputs[b] = frame;
    }
    sim.step(tick, inputs);
    for (let b = 0; b < brains.length; b++) {
      const dragon = sim.getDragon(b);
      if (dragon === undefined || (dragon.flags & DRAGON_FLAG_ALIVE) === 0) continue;
      flown.dragonTicks++;
      if ((dragon.flags & DRAGON_FLAG_IN_STORM) !== 0) flown.stormTicks++;
      // Measured against the real vents on both maps, so the two runs can be compared.
      if (heatVentStrengthAt(CALDERA.vents, dragon.position) > 0) flown.ventTicks++;
      if (dragon.position.y > flown.highest) flown.highest = dragon.position.y;
    }
  }
  return flown;
}

function sum(runs: readonly Flown[], key: keyof Flown): number {
  let total = 0;
  for (const run of runs) total += run[key];
  return total;
}

describe('bots on Emberfall Caldera', () => {
  it('fight through the vents without flying themselves into rock, the ceiling or the storm', () => {
    const seeds = [21, 22, 23];
    const withVents = seeds.map((seed) => fly(CALDERA, seed, 180));
    const without = seeds.map((seed) => fly(NO_VENTS, seed, 180));
    const line = (name: string, runs: readonly Flown[]): string =>
      `${name}: ${sum(runs, 'takedowns')} takedowns (${sum(runs, 'selfInflicted')} self-inflicted), ` +
      `terrain damage ${sum(runs, 'terrainDamage').toFixed(0)}, storm damage ` +
      `${sum(runs, 'stormDamage').toFixed(0)} over ${sum(runs, 'stormTicks')} ticks, in a vent ` +
      `${((100 * sum(runs, 'ventTicks')) / sum(runs, 'dragonTicks')).toFixed(1)} % of the time, ` +
      `highest ${Math.max(...runs.map((run) => run.highest)).toFixed(0)} m`;
    console.info(line('caldera', withVents));
    console.info(line('caldera, vents off', without));

    // They fight (the map is not a maze they get lost in) and they do meet the vents.
    expect(sum(withVents, 'takedowns')).toBeGreaterThan(6);
    expect(sum(withVents, 'ventTicks')).toBeGreaterThan(0);
    // The lift never carries a bot through the ceiling.
    for (const run of withVents) expect(run.highest).toBeLessThan(CALDERA.colliders.ceilingY);
    // No worse than the same rock without the vents (with room for the luck of three fights).
    expect(sum(withVents, 'selfInflicted')).toBeLessThanOrEqual(sum(without, 'selfInflicted') + 1);
    expect(sum(withVents, 'stormDamage')).toBeLessThanOrEqual(sum(without, 'stormDamage') + 40);
    expect(sum(withVents, 'terrainDamage')).toBeLessThanOrEqual(sum(without, 'terrainDamage') * 1.5 + 150);
  }, 120_000);
});
