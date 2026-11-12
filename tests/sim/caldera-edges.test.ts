/**
 * The edges of Emberfall Caldera in the real sim (T-6.4): the ash sea is a floor, the ceiling
 * and the storm wall hold, on this map's own collision world. (The rock itself: spawn lanes,
 * tunnelling and random pilots are in tests/shared/maps-emberfall-caldera.test.ts.)
 */

import { describe, expect, it } from 'vitest';
import {
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_FLAP,
  COLLISION_TUNING,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_IN_STORM,
  MATCH_TUNING,
  TEAM_EMBER,
  TICK_DT_S,
  TICK_HZ,
  createEmberfallCaldera,
  createInputFrame,
} from '../../src/shared';
import { createMapCollisionWorld, createSim } from '../../src/sim';
import type { DragonState, Sim } from '../../src/sim';

const MAP = createEmberfallCaldera();
const WORLD = createMapCollisionWorld(MAP);
const FLOOR_Y = MAP.colliders.floorY;
const CEILING_Y = MAP.colliders.ceilingY;
const RADIUS = MAP.colliders.stormRadius;

function inStorm(dragon: DragonState): boolean {
  return (dragon.flags & DRAGON_FLAG_IN_STORM) !== 0;
}

function spawn(x: number, y: number, z: number, yaw: number): { sim: Sim; dragon: () => DragonState } {
  const sim = createSim({ collisionWorld: WORLD });
  sim.spawnDragon(0, TEAM_EMBER, 'tempest', { x, y, z }, yaw);
  return {
    sim,
    dragon: () => {
      const dragon = sim.getDragon(0);
      if (dragon === undefined) throw new Error('no dragon');
      return dragon;
    },
  };
}

/** A spot of the bowl with no rock within `clear` metres at height `y` (first found, fixed order). */
function openSpot(y: number, clear: number): { x: number; z: number } {
  for (let r = 150; r < 800; r += 50) {
    for (let a = 0; a < 16; a++) {
      const angle = (a * Math.PI) / 8 + 0.2;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      if (WORLD.clearance(x, y, z, clear) === -1) return { x, z };
    }
  }
  throw new Error(`no open spot at y = ${y}`);
}

describe('the edges of Emberfall Caldera', () => {
  it('has the same envelope as the first map: sea at 0, floor just under it, ceiling 700, storm 1000 m', () => {
    expect(MAP.colliders.cloudSeaY).toBe(0);
    expect(FLOOR_Y).toBeLessThan(0);
    expect(CEILING_Y).toBe(700);
    expect(RADIUS).toBe(1000);
    expect(WORLD.stormRadius).toBe(RADIUS);
  });

  it('a folded dive into the ash sea is stopped a little under the floor, and hurts while under', () => {
    const spot = openSpot(60, 120);
    const rig = spawn(spot.x, 90, spot.z, 0);
    const input = createInputFrame();
    input.steerY = -1;
    input.buttons = BUTTON_DIVE;
    let minY = Infinity;
    let under = 0;
    let hurt = 0;
    for (let tick = 0; tick < 20 * TICK_HZ; tick++) {
      const dragon = rig.dragon();
      dragon.health = dragon.maxHealth;
      // Fresh from the gate a dragon is protected: the sea only hurts once that has run out.
      const shielded = dragon.spawnProtectTicks > 0;
      input.tick = tick;
      rig.sim.step(tick, [input]);
      const after = rig.dragon();
      minY = Math.min(minY, after.position.y);
      expect(inStorm(after), `tick ${tick}`).toBe(after.position.y < FLOOR_Y);
      if (inStorm(after)) {
        under++;
        if (!shielded) {
          hurt++;
          // At least the sea's own damage (the dive may also scrape rock on the way along).
          const seaDamage = MATCH_TUNING.stormDamagePerS * TICK_DT_S;
          expect(after.health).toBeLessThanOrEqual(after.maxHealth - seaDamage + 1e-6);
        }
      }
    }
    expect(under).toBeGreaterThan(0);
    expect(hurt).toBeGreaterThan(0);
    expect(minY).toBeLessThan(FLOOR_Y);
    expect(minY).toBeGreaterThanOrEqual(FLOOR_Y - COLLISION_TUNING.stormVerticalMaxDepth);
  });

  it('a boosted climb is stopped a little over the ceiling', () => {
    const spot = openSpot(660, 60);
    const rig = spawn(spot.x, 650, spot.z, 0);
    const input = createInputFrame();
    input.steerY = 1;
    input.buttons = BUTTON_BOOST | BUTTON_FLAP;
    let maxY = -Infinity;
    for (let tick = 0; tick < 20 * TICK_HZ; tick++) {
      const dragon = rig.dragon();
      dragon.health = dragon.maxHealth;
      dragon.stamina = 1;
      input.tick = tick;
      rig.sim.step(tick, [input]);
      maxY = Math.max(maxY, rig.dragon().position.y);
      expect(inStorm(rig.dragon()), `tick ${tick}`).toBe(rig.dragon().position.y > CEILING_Y);
    }
    expect(maxY).toBeGreaterThan(CEILING_Y);
    expect(maxY).toBeLessThanOrEqual(CEILING_Y + COLLISION_TUNING.stormVerticalMaxDepth);
  });

  it('the storm wall flags, hurts and turns back a dragon that flies out over the rim', () => {
    // Over the rim (the crater wall stands below this height) on a heading with open air ahead.
    let start: { x: number; z: number; yaw: number } | null = null;
    for (let a = 0; a < 16 && start === null; a++) {
      const yaw = (a * Math.PI) / 8 + 0.1;
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      if (WORLD.raycast(dx * 880, 640, dz * 880, dx, 0, dz, 400) === -1) {
        start = { x: dx * 900, z: dz * 900, yaw };
      }
    }
    if (start === null) throw new Error('no open heading over the rim');
    const rig = spawn(start.x, 640, start.z, start.yaw);
    const input = createInputFrame();
    const startHealth = rig.dragon().health;
    let maxDistance = 0;
    let stormTicks = 0;
    let returnedAt = -1;
    for (let tick = 0; tick < 20 * TICK_HZ; tick++) {
      input.tick = tick;
      rig.sim.step(tick, [input]);
      const dragon = rig.dragon();
      const distance = Math.hypot(dragon.position.x, dragon.position.z);
      maxDistance = Math.max(maxDistance, distance);
      expect(inStorm(dragon), `tick ${tick}`).toBe(distance > RADIUS);
      if (inStorm(dragon)) stormTicks++;
      else if (stormTicks > 0 && returnedAt < 0) returnedAt = tick;
    }
    expect(stormTicks).toBeGreaterThan(10);
    expect(maxDistance).toBeGreaterThan(RADIUS);
    expect(maxDistance).toBeLessThan(RADIUS + 150);
    expect(returnedAt).toBeGreaterThan(0);
    expect(returnedAt).toBeLessThan(10 * TICK_HZ);
    const dragon = rig.dragon();
    expect(startHealth - dragon.health).toBeCloseTo(stormTicks * MATCH_TUNING.stormDamagePerS * TICK_DT_S, 6);
    expect((dragon.flags & DRAGON_FLAG_ALIVE) !== 0).toBe(true);
  });
});
