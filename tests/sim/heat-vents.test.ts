/**
 * Heat vents (T-6.4): the strength formula, the push on one dragon, what flying through a vent
 * of Emberfall Caldera gives, and that a client's prediction agrees with the host tick for tick
 * while it does (no rubber-banding).
 */

import { describe, expect, it } from 'vitest';
import {
  BUTTON_BOOST,
  CLASS_TUNING,
  DRAGON_FLAG_ALIVE,
  EMBERFALL_VENTS,
  FLIGHT_TUNING,
  MATCH_TUNING,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  TICK_HZ,
  VENT_TUNING,
  createEmberfallCaldera,
  createInputFrame,
  createShatteredSpires,
  heatVentStrength,
  heatVentStrengthAt,
} from '../../src/shared';
import type { InputFrame, MapVent, VentTuning } from '../../src/shared';
import {
  applyHeatVents,
  createDragonState,
  createMapCollisionWorld,
  createSim,
  initDragon,
} from '../../src/sim';
import type { DragonState, Sim } from '../../src/sim';
import { ClientPredictor, RECONCILE_CORRECTED, RECONCILE_MATCHED } from '../../src/net/prediction';
import type { SnapshotMessage } from '../../src/net/protocol';
import { HostSnapshotBuilder, createSnapshotClock } from '../../src/net/snapshot';

const VENT: MapVent = {
  id: 'test',
  position: { x: 100, y: 40, z: -200 },
  radius: 40,
  height: 300,
  lift: 14,
  boost: 10,
};

const MAP = createEmberfallCaldera();
/** The same rock with the vents taken out: what the flight would be without them. */
const MAP_NO_VENTS = { ...MAP, vents: [] };

function ventOf(id: string): MapVent {
  const vent = EMBERFALL_VENTS.find((v) => v.id === id);
  if (vent === undefined) throw new Error(`no vent ${id}`);
  return vent;
}

function dragonAt(x: number, y: number, z: number): DragonState {
  const dragon = createDragonState();
  initDragon(dragon, 0, TEAM_EMBER, 'tempest', x, y, z, 0, FLIGHT_TUNING, CLASS_TUNING.tempest, MATCH_TUNING);
  return dragon;
}

describe('heatVentStrength', () => {
  const at = (dx: number, dy: number, dz = 0): number =>
    heatVentStrength(VENT, { x: VENT.position.x + dx, y: VENT.position.y + dy, z: VENT.position.z + dz });

  it('is 1 on the axis at the mouth and falls to 0 at the edge of the column', () => {
    expect(at(0, 0)).toBe(1);
    expect(at(0, 100)).toBe(1);
    expect(at(20, 50)).toBeCloseTo(0.75, 10); // 1 - (20 / 40)^2
    expect(at(0, 50, -20)).toBeCloseTo(0.75, 10);
    expect(at(39.9, 50)).toBeGreaterThan(0);
    expect(at(39.9, 50)).toBeLessThan(0.01);
    expect(at(40, 50)).toBe(0);
    expect(at(60, 50)).toBe(0);
    // never stronger off the axis, at any height
    for (let d = 0; d < 40; d += 5) expect(at(d + 5, 80)).toBeLessThan(at(d, 80));
  });

  it('holds full strength up to fullHeightFraction of the height, then fades to 0 at the top', () => {
    const full = VENT.height * VENT_TUNING.fullHeightFraction;
    expect(at(0, full)).toBe(1);
    expect(at(0, (full + VENT.height) / 2)).toBeCloseTo(0.5, 10);
    expect(at(0, VENT.height - 1e-6)).toBeGreaterThanOrEqual(0);
    expect(at(0, VENT.height - 1e-6)).toBeLessThan(1e-6);
    expect(at(0, VENT.height)).toBe(0);
    expect(at(0, VENT.height + 50)).toBe(0);
    // nothing below the mouth: that is the chimney's rock
    expect(at(0, -0.01)).toBe(0);
    expect(at(0, -80)).toBe(0);
  });

  it('follows the tuning it is given, and survives bad numbers', () => {
    const allTheWay: VentTuning = { ...VENT_TUNING, fullHeightFraction: 1 };
    const p = { x: VENT.position.x, y: VENT.position.y + VENT.height - 1, z: VENT.position.z };
    expect(heatVentStrength(VENT, p, allTheWay)).toBe(1);
    expect(heatVentStrength(VENT, p)).toBeLessThan(0.01);
    expect(heatVentStrength(VENT, { x: Number.NaN, y: 100, z: -200 })).toBe(0);
    expect(heatVentStrength(VENT, { x: 100, y: Number.NaN, z: -200 })).toBe(0);
    expect(heatVentStrength({ ...VENT, radius: 0 }, VENT.position)).toBe(0);
    expect(heatVentStrength({ ...VENT, height: Number.NaN }, VENT.position)).toBe(0);
  });

  it('heatVentStrengthAt takes the strongest vent, and 0 on a map without vents', () => {
    const main = ventOf('main');
    const onAxis = { x: main.position.x, y: main.position.y + 60, z: main.position.z };
    expect(heatVentStrengthAt(EMBERFALL_VENTS, onAxis)).toBe(1);
    expect(heatVentStrengthAt(EMBERFALL_VENTS, { x: 400, y: 300, z: 400 })).toBe(0);
    expect(heatVentStrengthAt(undefined, onAxis)).toBe(0);
    expect(heatVentStrengthAt(createShatteredSpires().vents, onAxis)).toBe(0);
  });
});

describe('applyHeatVents', () => {
  it('lifts, speeds up and refreshes a living dragon in proportion to the strength', () => {
    for (const [dx, strength] of [
      [0, 1],
      [20, 0.75],
    ] as const) {
      const dragon = dragonAt(VENT.position.x + dx, VENT.position.y + 50, VENT.position.z);
      dragon.stamina = 0.3;
      const speed = dragon.speed;
      applyHeatVents(dragon, [VENT], VENT_TUNING);
      expect(dragon.burst.y).toBeCloseTo(VENT.lift * VENT_TUNING.liftScale * strength * TICK_DT_S, 10);
      expect(dragon.burst.x).toBe(0);
      expect(dragon.burst.z).toBe(0);
      expect(dragon.speed - speed).toBeCloseTo(VENT.boost * VENT_TUNING.boostScale * strength * TICK_DT_S, 10);
      expect(dragon.stamina - 0.3).toBeCloseTo(VENT_TUNING.staminaPerS * strength * TICK_DT_S, 10);
    }
  });

  it('leaves a dragon outside every column, and a dead one, alone', () => {
    const outside = dragonAt(VENT.position.x + 41, VENT.position.y + 50, VENT.position.z);
    const before = JSON.stringify(outside);
    applyHeatVents(outside, [VENT], VENT_TUNING);
    expect(JSON.stringify(outside)).toBe(before);

    const dead = dragonAt(VENT.position.x, VENT.position.y + 50, VENT.position.z);
    dead.flags &= ~DRAGON_FLAG_ALIVE;
    const deadBefore = JSON.stringify(dead);
    applyHeatVents(dead, [VENT], VENT_TUNING);
    expect(JSON.stringify(dead)).toBe(deadBefore);

    const noVents = dragonAt(VENT.position.x, VENT.position.y + 50, VENT.position.z);
    const noneBefore = JSON.stringify(noVents);
    applyHeatVents(noVents, [], VENT_TUNING);
    expect(JSON.stringify(noVents)).toBe(noneBefore);
  });

  it('does not allocate', () => {
    const dragon = dragonAt(VENT.position.x + 5, VENT.position.y + 50, VENT.position.z);
    // Warm up, then compare the heap over many calls: a per-call object would show as megabytes.
    for (let i = 0; i < 20_000; i++) applyHeatVents(dragon, EMBERFALL_VENTS, VENT_TUNING);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    // Single-shot heapUsed is noisy under CI parallel workers; median of trials matches
    // codec-fast / combat allocation checks.
    const iterations = 40_000;
    const growth: number[] = [];
    for (let trial = 0; trial < 9; trial++) {
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < iterations; i++) {
        dragon.burst.y = 0;
        dragon.speed = 45;
        dragon.stamina = 0.5;
        applyHeatVents(dragon, [VENT], VENT_TUNING);
      }
      growth.push(process.memoryUsage().heapUsed - before);
    }
    growth.sort((a, b) => a - b);
    // 40k calls × one small object (16 B) would be ~640 KB; median stays far under that when clean.
    expect(growth[4]).toBeLessThan(256 * 1024);
  });
});

describe('flying through the vents of Emberfall Caldera', () => {
  /** Flies one dragon with fixed input from `start` and returns it after `ticks`. */
  function fly(
    map: typeof MAP | typeof MAP_NO_VENTS,
    start: { x: number; y: number; z: number },
    yaw: number,
    ticks: number,
    buttons = 0,
    steerY = 0,
  ): DragonState {
    const sim = createSim({ collisionWorld: createMapCollisionWorld(map) });
    sim.spawnDragon(0, TEAM_EMBER, 'tempest', start, yaw);
    const input = createInputFrame();
    input.buttons = buttons;
    input.steerY = steerY;
    for (let tick = 0; tick < ticks; tick++) {
      input.tick = tick;
      sim.step(tick, [input]);
    }
    const dragon = sim.getDragon(0);
    if (dragon === undefined) throw new Error('no dragon');
    return dragon;
  }

  it('a level pass across a flank vent is free speed and height, hands off', () => {
    for (const id of ['ring-ember', 'trench-ember', 'stairs-frost', 'home-frost']) {
      const vent = ventOf(id);
      // Start 60 m short of the column and fly straight across its axis, from the first side
      // where the same flight without the vent is a plain level cruise (no rock on the way).
      const ticks = Math.round(((vent.radius * 2 + 120) / FLIGHT_TUNING.cruiseSpeed) * TICK_HZ);
      const back = vent.radius + 60;
      let start = { x: 0, y: 0, z: 0 };
      let yaw = 0;
      let without: DragonState | null = null;
      for (let side = 0; side < 8 && without === null; side++) {
        yaw = (side * Math.PI) / 4;
        start = {
          x: vent.position.x - Math.sin(yaw) * back,
          y: vent.position.y + 110,
          z: vent.position.z - Math.cos(yaw) * back,
        };
        const flown = fly(MAP_NO_VENTS, start, yaw, ticks);
        const level = Math.abs(flown.position.y - start.y) < 1e-3;
        if (level && Math.abs(flown.speed - FLIGHT_TUNING.cruiseSpeed) < 1e-3) without = flown;
      }
      if (without === null) throw new Error(`no clear pass across vent ${id}`);
      const withVents = fly(MAP, start, yaw, ticks);
      const gainedSpeed = withVents.speed - without.speed;
      const gainedHeight = withVents.position.y - without.position.y;
      console.info(
        `vent ${id}: level pass gives +${gainedSpeed.toFixed(1)} m/s (still held after the pass) and ` +
          `+${gainedHeight.toFixed(1)} m of height`,
      );
      expect(gainedSpeed, id).toBeGreaterThan(6);
      expect(gainedHeight, id).toBeGreaterThan(8);
      // A boost, not a launch: nowhere near the top speed, and the dragon is still in the bowl.
      expect(withVents.speed, id).toBeLessThan(FLIGHT_TUNING.maxSpeed * 0.9);
      expect(gainedHeight, id).toBeLessThan(80);
      expect(withVents.health).toBe(withVents.maxHealth);
    }
  });

  it('a climbing turn in the main vent goes far higher, and stalls far later, than the same turn without it', () => {
    const main = ventOf('main');
    // Circle inside the column (a held turn and a held climb).
    const circle = (map: typeof MAP | typeof MAP_NO_VENTS): { top: number; stalledTicks: number } => {
      const sim = createSim({ collisionWorld: createMapCollisionWorld(map) });
      sim.spawnDragon(0, TEAM_EMBER, 'tempest', { x: 35, y: main.position.y + 30, z: 0 }, 0);
      const input = createInputFrame();
      input.steerX = 1;
      input.steerY = 0.55;
      let top = -Infinity;
      let stalledTicks = 0;
      for (let tick = 0; tick < 8 * TICK_HZ; tick++) {
        input.tick = tick;
        const before = sim.getDragon(0);
        // Soft-cap climb: free inverted pitch would turn a held stick into a loop.
        if (before !== undefined && before.pitch > 1.05) before.pitch = 1.05;
        sim.step(tick, [input]);
        const dragon = sim.getDragon(0);
        if (dragon === undefined) throw new Error('no dragon');
        if (dragon.pitch > 1.05) dragon.pitch = 1.05;
        top = Math.max(top, dragon.position.y);
        if (dragon.speed < FLIGHT_TUNING.stallSpeed) stalledTicks++;
      }
      return { top, stalledTicks };
    };
    const inVent = circle(MAP);
    const noVent = circle(MAP_NO_VENTS);
    console.info(
      `main vent: 8 s of climbing turn tops out at ${inVent.top.toFixed(0)} m (stalled ${inVent.stalledTicks} ticks); ` +
        `without the vent ${noVent.top.toFixed(0)} m (stalled ${noVent.stalledTicks} ticks)`,
    );
    // The vent is help, not a lift shaft: a hard enough climb still runs out of speed in the end,
    // only much later and much higher.
    expect(noVent.stalledTicks).toBeGreaterThan(0);
    expect(inVent.stalledTicks).toBeLessThan(noVent.stalledTicks * 0.5);
    expect(inVent.top).toBeGreaterThan(noVent.top + 100);
  });

  it('gives stamina back while boosting on the axis, and never more than a full bar', () => {
    const vent = ventOf('ring-ember');
    const base = { x: vent.position.x, y: vent.position.y + 40, z: vent.position.z };
    // A dragon parked on the axis (no flight step): the vent alone.
    const dragon = dragonAt(base.x, base.y, base.z);
    dragon.stamina = 0.2;
    const world = createMapCollisionWorld(MAP);
    const sim = createSim({ collisionWorld: world });
    sim.spawnDragon(0, TEAM_EMBER, 'tempest', base, 0);
    const own = sim.getDragon(0);
    if (own === undefined) throw new Error('no dragon');
    own.stamina = 0.2;
    const input = createInputFrame();
    input.buttons = BUTTON_BOOST;
    // First tick on the axis: the boost drains what the vent gives back.
    sim.step(0, [input]);
    expect(own.stamina).toBeCloseTo(
      0.2 - FLIGHT_TUNING.staminaDrainPerS * TICK_DT_S + VENT_TUNING.staminaPerS * TICK_DT_S * heatVentStrength(vent, own.position),
      6,
    );
    for (let i = 0; i < 2000; i++) applyHeatVents(dragon, [vent], VENT_TUNING);
    expect(dragon.stamina).toBeGreaterThan(1); // the raw step only adds...
    const sim2 = createSim({ collisionWorld: world });
    sim2.spawnDragon(0, TEAM_EMBER, 'tempest', base, 0);
    for (let tick = 0; tick < 20; tick++) sim2.step(tick, [createInputFrame()]);
    expect(sim2.getDragon(0)?.stamina).toBe(1); // ...and the end of the tick caps it
  });

  it('a dead dragon falls through a vent like through any air', () => {
    const vent = ventOf('home-ember');
    const start = { x: vent.position.x, y: vent.position.y + 200, z: vent.position.z };
    const fall = (map: typeof MAP | typeof MAP_NO_VENTS): number => {
      const sim = createSim({ collisionWorld: createMapCollisionWorld(map) });
      sim.spawnDragon(0, TEAM_EMBER, 'tempest', start, 0);
      const dragon = sim.getDragon(0);
      if (dragon === undefined) throw new Error('no dragon');
      dragon.health = 0;
      dragon.flags &= ~DRAGON_FLAG_ALIVE;
      for (let tick = 0; tick < 2 * TICK_HZ; tick++) sim.step(tick, [createInputFrame()]);
      return dragon.position.y;
    };
    expect(fall(MAP)).toBe(fall(MAP_NO_VENTS));
  });
});

describe('prediction through a vent', () => {
  const ID = 1;
  const vent = ventOf('ring-ember');

  /** Weaves and climbs through the column, boosting and flapping now and then. */
  function pilot(tick: number, frame: InputFrame): void {
    frame.steerX = Math.sin(tick * 0.11) * 0.8;
    frame.steerY = Math.cos(tick * 0.07) * 0.5 + 0.1;
    frame.buttons = tick % 50 < 14 ? BUTTON_BOOST : 0;
  }

  interface Rig {
    sim: Sim;
    predictor: ClientPredictor;
    hostStep(tick: number): void;
    clientStep(): void;
    snapshot(): SnapshotMessage;
  }

  function createRig(clientMap: typeof MAP | typeof MAP_NO_VENTS): Rig {
    // Host and client each build their own world from the map, as two machines do.
    const sim = createSim({ collisionWorld: createMapCollisionWorld(MAP) });
    // Enters the column from 50 m out, a little below the middle of its full-strength part.
    const start = { x: vent.position.x - 20, y: vent.position.y + 90, z: vent.position.z - vent.radius - 50 };
    sim.spawnDragon(ID, TEAM_FROST, 'tempest', start, 0.25);
    sim.spawnDragon(0, TEAM_EMBER, 'talon', { x: 0, y: 320, z: -500 }, 0);
    const builder = new HostSnapshotBuilder();
    const clock = createSnapshotClock();
    const predictor = new ClientPredictor();
    predictor.configure(ID, TEAM_FROST, 'tempest');
    predictor.setCollisionWorld(createMapCollisionWorld(clientMap));
    const frame = createInputFrame();
    const hostFrame = createInputFrame();
    const inputs: (InputFrame | undefined)[] = [];
    return {
      sim,
      predictor,
      hostStep(tick) {
        pilot(tick, hostFrame);
        // What the wire would deliver.
        hostFrame.steerX = Math.round(hostFrame.steerX * 32767) / 32767;
        hostFrame.steerY = Math.round(hostFrame.steerY * 32767) / 32767;
        inputs[ID] = hostFrame;
        sim.step(tick, inputs);
      },
      clientStep() {
        pilot(predictor.tick + 1, frame);
        predictor.step(frame);
      },
      snapshot() {
        builder.begin(sim.current, clock);
        return builder.forRecipient(ID, true, sim.current.tick);
      },
    };
  }

  function run(clientMap: typeof MAP | typeof MAP_NO_VENTS): {
    matched: number;
    corrected: number;
    largestM: number;
    ticksInVent: number;
    peakStrength: number;
  } {
    const rig = createRig(clientMap);
    for (let tick = 0; tick <= 4; tick++) rig.hostStep(tick);
    rig.predictor.setTick(4);
    for (let i = 0; i < 4; i++) rig.clientStep();
    rig.predictor.reconcile(rig.snapshot(), 4); // the first one snaps the client onto the host
    let matched = 0;
    let corrected = 0;
    let ticksInVent = 0;
    let peakStrength = 0;
    for (let tick = 5; tick <= 5 + 6 * TICK_HZ; tick++) {
      rig.clientStep(); // the client stays 4 ticks ahead of the host
      rig.hostStep(tick);
      const host = rig.sim.getDragon(ID);
      if (host === undefined) throw new Error('no dragon');
      const strength = heatVentStrength(vent, host.position);
      if (strength > 0) ticksInVent++;
      peakStrength = Math.max(peakStrength, strength);
      const result = rig.predictor.reconcile(rig.snapshot(), tick);
      if (result === RECONCILE_MATCHED) matched++;
      else if (result === RECONCILE_CORRECTED) corrected++;
      else throw new Error(`tick ${tick}: unexpected reconcile result ${result}`);
    }
    return { matched, corrected, largestM: rig.predictor.largestCorrectionM, ticksInVent, peakStrength };
  }

  it('agrees with the host on every tick of a weaving, boosting climb through the column', () => {
    const result = run(MAP);
    console.info(
      `prediction through vent ${vent.id}: ${result.ticksInVent} ticks inside (peak strength ` +
        `${result.peakStrength.toFixed(2)}), ${result.matched} snapshots matched, ${result.corrected} corrected`,
    );
    // The flight really went through the strong part of the column, for a good while.
    expect(result.ticksInVent).toBeGreaterThan(TICK_HZ);
    expect(result.peakStrength).toBeGreaterThan(0.6);
    expect(result.corrected).toBe(0);
    expect(result.largestM).toBe(0);
    expect(result.matched).toBe(6 * TICK_HZ + 1);
  });

  it('would rubber-band if the client did not know the vents (the test can tell)', () => {
    const result = run(MAP_NO_VENTS);
    expect(result.corrected).toBeGreaterThan(10);
    expect(result.largestM).toBeGreaterThan(0.05);
  });
});
