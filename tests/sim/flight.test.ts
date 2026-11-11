/**
 * Flight model tests (T-1.9): the feel rules from GAME_DESIGN "Flight (arcade)" as numbers, plus
 * the properties prediction and replay depend on (bounded, NaN-free, deterministic, cheap).
 */

import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_DODGE_RIGHT,
  BUTTON_FLAP,
  BUTTON_ROLL_LEFT,
  BUTTON_ROLL_RIGHT,
  CLASS_TUNING,
  DRAGON_ANIM_BANK_L,
  DRAGON_ANIM_BANK_R,
  DRAGON_ANIM_BOOST,
  DRAGON_ANIM_DEATH_FALL,
  DRAGON_ANIM_DIVE,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_ANIM_HIT,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_STALLED,
  FLIGHT_TUNING,
  MATCH_TUNING,
  MAX_PLAYERS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  TICK_HZ,
  createInputFrame,
} from '../../src/shared';
import type { DragonClassId, FlightTuning, InputFrame, Vec3 } from '../../src/shared';
import {
  createSim,
  damageDragon,
  maxFlightSpeed,
  minFlightSpeed,
  secondsToTicks,
  setDragonVelocity,
} from '../../src/sim';
import type { DragonState, Sim, SimCollisionWorld } from '../../src/sim';

const SPAWN: Vec3 = { x: 0, y: 500, z: 0 };

/** Seeded LCG (Numerical Recipes constants): the same "random" inputs on every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface Rig {
  readonly sim: Sim;
  readonly flight: FlightTuning;
  /** Player 0's input, reused every tick: set fields, then `step`. */
  readonly input: InputFrame;
  /** Player 0's dragon in the CURRENT state (the buffers swap, so fetch it after each step). */
  dragon(): DragonState;
  step(ticks?: number): void;
  readonly tick: number;
}

interface RigOptions {
  classId?: DragonClassId;
  spawnProtectionS?: number;
  collisionWorld?: SimCollisionWorld;
  yaw?: number;
}

/** One dragon (player 0) on private copies of the tuning tables, so tests cannot leak tuning. */
function makeRig(options: RigOptions = {}): Rig {
  const flight: FlightTuning = { ...FLIGHT_TUNING };
  const sim = createSim({
    flightTuning: flight,
    matchTuning: { ...MATCH_TUNING, spawnProtectionS: options.spawnProtectionS ?? 0 },
    ...(options.collisionWorld ? { collisionWorld: options.collisionWorld } : {}),
  });
  sim.spawnDragon(0, TEAM_EMBER, options.classId ?? 'tempest', SPAWN, options.yaw ?? 0);
  const input = createInputFrame();
  const inputs = [input];
  let tick = 0;
  return {
    sim,
    flight,
    input,
    dragon() {
      const dragon = sim.getDragon(0);
      if (dragon === undefined) throw new Error('player 0 has no dragon');
      return dragon;
    },
    step(ticks = 1) {
      for (let i = 0; i < ticks; i++) {
        input.tick = tick;
        sim.step(tick++, inputs);
      }
    },
    get tick() {
      return tick;
    },
  };
}

function has(dragon: DragonState, flag: number): boolean {
  return (dragon.flags & flag) !== 0;
}

/** Every number anywhere inside the dragon, with its path, for "nothing is NaN" checks. */
function collectNumbers(node: unknown, path: string, out: [string, number][]): [string, number][] {
  if (typeof node === 'number') out.push([path, node]);
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) collectNumbers(value, `${path}.${key}`, out);
  }
  return out;
}

function expectSane(dragon: DragonState, flight: FlightTuning, label: string): void {
  for (const [path, value] of collectNumbers(dragon, 'dragon', [])) {
    if (!Number.isFinite(value)) throw new Error(`${label}: ${path} is ${value}`);
  }
  const cls = CLASS_TUNING[dragon.classId];
  const q = dragon.orientation;
  expect(Math.hypot(q.x, q.y, q.z, q.w), `${label}: |orientation|`).toBeCloseTo(1, 9);
  expect(dragon.speed, `${label}: speed`).toBeLessThanOrEqual(maxFlightSpeed(flight, cls) + 1e-9);
  if (has(dragon, DRAGON_FLAG_ALIVE)) {
    expect(dragon.speed, `${label}: speed`).toBeGreaterThanOrEqual(
      minFlightSpeed(flight, cls) - 1e-9,
    );
  } else {
    expect(dragon.speed, `${label}: speed`).toBeGreaterThanOrEqual(0);
  }
  expect(dragon.stamina, `${label}: stamina`).toBeGreaterThanOrEqual(0);
  expect(dragon.stamina, `${label}: stamina`).toBeLessThanOrEqual(1);
  expect(dragon.health, `${label}: health`).toBeGreaterThanOrEqual(0);
  expect(dragon.health, `${label}: health`).toBeLessThanOrEqual(dragon.maxHealth);
  expect(dragon.pitch, `${label}: pitch`).toBeLessThanOrEqual(flight.maxClimbPitch);
  expect(dragon.pitch, `${label}: pitch`).toBeGreaterThanOrEqual(-flight.maxDivePitch);
  expect(Math.abs(dragon.yaw), `${label}: yaw`).toBeLessThanOrEqual(Math.PI);
  expect(
    Math.hypot(dragon.burst.x, dragon.burst.y, dragon.burst.z),
    `${label}: burst`,
  ).toBeLessThanOrEqual(flight.maxBurstSpeed + 1e-9);
}

describe('spawning', () => {
  it('spawns a living dragon at cruise speed in both states', () => {
    const sim = createSim();
    const dragon = sim.spawnDragon(4, TEAM_FROST, 'talon', { x: 10, y: 200, z: -30 }, Math.PI / 2);
    expect(dragon).not.toBeNull();
    expect(sim.getDragon(4)).toBe(dragon);
    expect(dragon).toMatchObject({
      active: true,
      id: 4,
      team: TEAM_FROST,
      classId: 'talon',
      position: { x: 10, y: 200, z: -30 },
      stamina: 1,
      health: CLASS_TUNING.talon.maxHp,
      maxHealth: CLASS_TUNING.talon.maxHp,
      anim: DRAGON_ANIM_GLIDE,
    });
    expect(dragon?.speed).toBeCloseTo(FLIGHT_TUNING.cruiseSpeed * CLASS_TUNING.talon.speedScale, 9);
    expect(dragon?.flags).toBe(DRAGON_FLAG_ALIVE | DRAGON_FLAG_SPAWN_PROTECTED);
    // Facing +X, level.
    expect(dragon?.velocity.x).toBeCloseTo(dragon?.speed ?? NaN, 9);
    expect(dragon?.velocity.y).toBeCloseTo(0, 9);
    expect(dragon?.velocity.z).toBeCloseTo(0, 9);
    expect(sim.current.dragonCount).toBe(1);
    expect(sim.prev.dragonCount).toBe(1);
    expect(sim.prev.dragons[0]).toEqual(sim.current.dragons[0]);
    expect(sim.prev.dragons[0]).not.toBe(sim.current.dragons[0]);
  });

  it('fills the pool, refuses an eleventh dragon and frees slots on despawn', () => {
    const sim = createSim();
    for (let id = 0; id < MAX_PLAYERS; id++) {
      expect(sim.spawnDragon(id + 20, TEAM_EMBER, 'tempest', SPAWN, 0)).not.toBeNull();
    }
    expect(sim.current.dragonCount).toBe(MAX_PLAYERS);
    expect(sim.spawnDragon(99, TEAM_EMBER, 'tempest', SPAWN, 0)).toBeNull();

    expect(sim.despawnDragon(23)).toBe(true);
    expect(sim.despawnDragon(23)).toBe(false);
    expect(sim.getDragon(23)).toBeUndefined();
    expect(sim.current.dragonCount).toBe(MAX_PLAYERS - 1);
    expect(sim.prev.dragonCount).toBe(MAX_PLAYERS - 1);
    expect(sim.spawnDragon(99, TEAM_FROST, 'wraith', SPAWN, 0)).not.toBeNull();
    expect(sim.current.dragonCount).toBe(MAX_PLAYERS);
  });

  it('respawns in place and rejects ids that are not player ids', () => {
    const rig = makeRig();
    rig.input.steerX = 1;
    rig.input.buttons = BUTTON_BOOST;
    rig.step(40);
    damageDragon(rig.dragon(), 1e9, rig.flight);
    rig.step(5);
    expect(has(rig.dragon(), DRAGON_FLAG_ALIVE)).toBe(false);

    const again = rig.sim.spawnDragon(0, TEAM_FROST, 'bastion', { x: 1, y: 2, z: 3 }, 0);
    expect(again).toBe(rig.dragon());
    expect(rig.sim.current.dragonCount).toBe(1);
    expect(again).toMatchObject({
      team: TEAM_FROST,
      classId: 'bastion',
      position: { x: 1, y: 2, z: 3 },
      yaw: 0,
      roll: 0,
      stamina: 1,
      health: CLASS_TUNING.bastion.maxHp,
      flags: DRAGON_FLAG_ALIVE,
      prevButtons: 0,
    });

    for (const bad of [-1, 1.5, 255, 256, Number.NaN, Infinity]) {
      expect(rig.sim.spawnDragon(bad, TEAM_EMBER, 'talon', SPAWN, 0)).toBeNull();
    }
    // Garbage spawn data is sanitised, not stored.
    const odd = rig.sim.spawnDragon(
      7,
      TEAM_EMBER,
      'talon',
      { x: Number.NaN, y: 9, z: 0 },
      Infinity,
    );
    expect(odd?.position).toEqual({ x: 0, y: 9, z: 0 });
    expect(odd?.yaw).toBe(0);
  });

  it('keeps spawn protection for the tuned time', () => {
    const rig = makeRig({ spawnProtectionS: 2 });
    const ticks = 2 * TICK_HZ;
    expect(damageDragon(rig.dragon(), 10, rig.flight)).toBe(0);
    rig.step(ticks - 1);
    expect(has(rig.dragon(), DRAGON_FLAG_SPAWN_PROTECTED)).toBe(true);
    rig.step(1);
    expect(has(rig.dragon(), DRAGON_FLAG_SPAWN_PROTECTED)).toBe(false);
    expect(damageDragon(rig.dragon(), 10, rig.flight)).toBe(10);
  });

  it('reset despawns everything and rewinds time', () => {
    const rig = makeRig();
    rig.step(10);
    rig.sim.reset();
    expect(rig.sim.current.dragonCount).toBe(0);
    expect(rig.sim.prev.dragonCount).toBe(0);
    expect(rig.sim.current.tick).toBe(-1);
    expect(rig.sim.getDragon(0)).toBeUndefined();
  });
});

describe('level flight and steering', () => {
  it('holds cruise speed straight ahead with no input', () => {
    const rig = makeRig();
    rig.step(TICK_HZ);
    const dragon = rig.dragon();
    expect(dragon.speed).toBeCloseTo(FLIGHT_TUNING.cruiseSpeed, 9);
    expect(dragon.position.z).toBeCloseTo(FLIGHT_TUNING.cruiseSpeed, 6);
    expect(dragon.position.x).toBeCloseTo(0, 9);
    expect(dragon.position.y).toBeCloseTo(SPAWN.y, 9);
    expect(dragon.anim).toBe(DRAGON_ANIM_GLIDE);
    expect(rig.sim.current.timeS).toBeCloseTo(1, 9);
    // prev is exactly one tick behind.
    const prev = rig.sim.prev.dragons[0];
    expect(prev?.position.z).toBeCloseTo(dragon.position.z - dragon.speed * TICK_DT_S, 9);
  });

  it('turns right for positive steerX, banking into the turn', () => {
    const rig = makeRig();
    rig.input.steerX = 1;
    rig.step(TICK_HZ);
    const dragon = rig.dragon();
    // +X is the dragon's left, so a right turn lowers yaw and drifts toward -X.
    expect(dragon.yaw).toBeLessThan(-0.5);
    expect(dragon.position.x).toBeLessThan(-5);
    expect(dragon.roll).toBeGreaterThan(rig.flight.bankAnimAngle);
    expect(dragon.anim).toBe(DRAGON_ANIM_BANK_R);
    const leftWing = new Vector3(1, 0, 0).applyQuaternion(
      new Quaternion(
        dragon.orientation.x,
        dragon.orientation.y,
        dragon.orientation.z,
        dragon.orientation.w,
      ),
    );
    expect(leftWing.y).toBeGreaterThan(0.3);

    rig.input.steerX = -1;
    rig.step(2 * TICK_HZ);
    expect(rig.dragon().yawRate).toBeGreaterThan(0);
    expect(rig.dragon().roll).toBeLessThan(-rig.flight.bankAnimAngle);
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_BANK_L);
  });

  it('limits the turn rates and turns tighter when slow than when fast', () => {
    const slow = makeRig();
    const fast = makeRig();
    slow.dragon().speed = slow.flight.stallSpeed + 3;
    fast.dragon().speed = fast.flight.maxSpeed;
    slow.input.steerX = 1;
    fast.input.steerX = 1;
    fast.input.buttons = BUTTON_BOOST;
    slow.step(10);
    fast.step(10);
    expect(Math.abs(slow.dragon().yawRate)).toBeGreaterThan(Math.abs(fast.dragon().yawRate) * 1.3);

    const rig = makeRig();
    rig.input.steerX = -1;
    rig.input.steerY = 1;
    const limit = Math.max(rig.flight.turnScaleSlow, rig.flight.turnScaleFast);
    for (let i = 0; i < 300; i++) {
      rig.step();
      const dragon = rig.dragon();
      expect(Math.abs(dragon.yawRate)).toBeLessThanOrEqual(rig.flight.maxYawRate * limit + 1e-9);
      expect(dragon.pitchRate).toBeLessThanOrEqual(rig.flight.maxPitchRate * limit + 1e-9);
    }
  });

  it('adds bank and turn from the roll buttons', () => {
    const rig = makeRig();
    rig.input.buttons = BUTTON_ROLL_RIGHT;
    rig.step(TICK_HZ);
    expect(rig.dragon().roll).toBeGreaterThan(0.3);
    expect(rig.dragon().yaw).toBeLessThan(0);

    rig.input.buttons = BUTTON_ROLL_LEFT;
    rig.step(2 * TICK_HZ);
    expect(rig.dragon().roll).toBeLessThan(-0.3);
    expect(rig.dragon().yawRate).toBeGreaterThan(0);

    // Both at once cancel out.
    const both = makeRig();
    both.input.buttons = BUTTON_ROLL_LEFT | BUTTON_ROLL_RIGHT;
    both.step(TICK_HZ);
    expect(both.dragon().roll).toBe(0);
    expect(both.dragon().yaw).toBe(0);
  });

  it('never pitches past the limits: no loops', () => {
    const rig = makeRig();
    rig.input.steerY = 1;
    rig.input.buttons = BUTTON_BOOST;
    let top = -Infinity;
    for (let i = 0; i < 200; i++) {
      rig.step();
      top = Math.max(top, rig.dragon().pitch);
    }
    expect(top).toBeLessThanOrEqual(rig.flight.maxClimbPitch);
    expect(top).toBeGreaterThan(rig.flight.maxClimbPitch * 0.8);

    rig.input.steerY = -1;
    rig.input.buttons = BUTTON_DIVE;
    rig.step(200);
    expect(rig.dragon().pitch).toBeCloseTo(-rig.flight.maxDivePitch, 9);
    expect(rig.dragon().pitchRate).toBe(0);
  });

  it('builds an orientation whose +Z is the flight direction', () => {
    const rig = makeRig({ yaw: 2.2 });
    const random = lcg(11);
    const forward = new Vector3();
    const q = new Quaternion();
    for (let i = 0; i < 400; i++) {
      if (i % 20 === 0) {
        rig.input.steerX = random() * 2 - 1;
        rig.input.steerY = random() * 2 - 1;
      }
      rig.step();
      const dragon = rig.dragon();
      q.set(dragon.orientation.x, dragon.orientation.y, dragon.orientation.z, dragon.orientation.w);
      forward.set(0, 0, 1).applyQuaternion(q);
      expect(forward.x).toBeCloseTo(Math.sin(dragon.yaw) * Math.cos(dragon.pitch), 9);
      expect(forward.y).toBeCloseTo(Math.sin(dragon.pitch), 9);
      expect(forward.z).toBeCloseTo(Math.cos(dragon.yaw) * Math.cos(dragon.pitch), 9);
      // No burst in this flight, so velocity is exactly forward * speed.
      expect(dragon.velocity.x).toBeCloseTo(forward.x * dragon.speed, 9);
      expect(dragon.velocity.y).toBeCloseTo(forward.y * dragon.speed, 9);
      expect(dragon.velocity.z).toBeCloseTo(forward.z * dragon.speed, 9);
    }
  });
});

describe('energy', () => {
  it('gains speed in a dive and bleeds it in a climb', () => {
    const dive = makeRig();
    dive.input.steerY = -1;
    dive.step(2 * TICK_HZ);
    expect(dive.dragon().speed).toBeGreaterThan(FLIGHT_TUNING.cruiseSpeed + 10);
    expect(dive.dragon().position.y).toBeLessThan(SPAWN.y - 20);

    const climb = makeRig();
    climb.input.steerY = 1;
    climb.step(TICK_HZ);
    expect(climb.dragon().speed).toBeLessThan(FLIGHT_TUNING.cruiseSpeed - 5);
    expect(climb.dragon().position.y).toBeGreaterThan(SPAWN.y + 10);
  });

  it('trades the dive speed back for height, then settles at cruise', () => {
    const rig = makeRig();
    rig.input.steerY = -1;
    rig.step(3 * TICK_HZ);
    const diveSpeed = rig.dragon().speed;
    const low = rig.dragon().position.y;

    // Pull out, then zoom climb: speed carries the dragon up while it bleeds off.
    rig.input.steerY = 1;
    let lowest = low;
    for (let i = 0; i < 5 * TICK_HZ && rig.dragon().pitch < 0.5; i++) {
      rig.step();
      lowest = Math.min(lowest, rig.dragon().position.y);
    }
    expect(rig.dragon().pitch).toBeGreaterThanOrEqual(0.5);
    rig.step(TICK_HZ);
    expect(rig.dragon().position.y).toBeGreaterThan(lowest + 30);
    expect(rig.dragon().speed).toBeLessThan(diveSpeed - 15);

    // Level out by hand, then hands off: drag/wingbeats bring the speed back to cruise.
    for (let i = 0; i < 20 * TICK_HZ; i++) {
      rig.input.steerY = Math.max(-1, Math.min(1, -rig.dragon().pitch * 4));
      rig.step();
    }
    expect(rig.dragon().pitch).toBeCloseTo(0, 2);
    expect(rig.dragon().speed).toBeCloseTo(FLIGHT_TUNING.cruiseSpeed, 0);
  });

  it('tops out at max speed in a full folded-wing dive and never exceeds it', () => {
    const rig = makeRig();
    rig.input.steerY = -1;
    rig.input.buttons = BUTTON_DIVE;
    let top = 0;
    for (let i = 0; i < 20 * TICK_HZ; i++) {
      rig.step();
      top = Math.max(top, rig.dragon().speed);
    }
    expect(top).toBe(FLIGHT_TUNING.maxSpeed);
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_DIVE);

    // Without folding the wings the same dive is fast but below the cap.
    const open = makeRig();
    open.input.steerY = -1;
    open.step(20 * TICK_HZ);
    expect(open.dragon().speed).toBeGreaterThan(75);
    expect(open.dragon().speed).toBeLessThan(FLIGHT_TUNING.maxSpeed);
  });

  it('folds the wings on the dive button: nose down, sink, speed', () => {
    const rig = makeRig();
    rig.input.buttons = BUTTON_DIVE;
    rig.step(TICK_HZ);
    const dragon = rig.dragon();
    expect(dragon.pitch).toBeLessThan(-0.4);
    expect(dragon.burst.y).toBeLessThan(-2);
    expect(dragon.position.y).toBeLessThan(SPAWN.y - 10);
    expect(dragon.speed).toBeGreaterThan(FLIGHT_TUNING.cruiseSpeed);
    expect(dragon.anim).toBe(DRAGON_ANIM_DIVE);
  });

  it('gives each class its own speeds', () => {
    const cruise = (classId: DragonClassId): number => {
      const rig = makeRig({ classId });
      rig.step(TICK_HZ);
      return rig.dragon().speed;
    };
    expect(cruise('talon')).toBeGreaterThan(cruise('tempest'));
    expect(cruise('tempest')).toBeGreaterThan(cruise('bastion'));

    const topDive = (classId: DragonClassId): number => {
      const rig = makeRig({ classId });
      rig.input.steerY = -1;
      rig.input.buttons = BUTTON_DIVE;
      rig.step(20 * TICK_HZ);
      return rig.dragon().speed;
    };
    for (const classId of DRAGON_CLASS_IDS) {
      expect(topDive(classId)).toBeCloseTo(maxFlightSpeed(FLIGHT_TUNING, CLASS_TUNING[classId]), 6);
    }
    // "Fast in dives": Wraith out-dives Tempest although they cruise alike.
    expect(topDive('wraith')).toBeGreaterThan(topDive('tempest') + 5);
    expect(cruise('wraith')).toBeCloseTo(cruise('tempest'), 9);
  });
});

describe('stall', () => {
  it('stalls in a sustained climb: the nose drops against full back stick, then it recovers', () => {
    const rig = makeRig();
    const floor = minFlightSpeed(rig.flight, CLASS_TUNING.tempest);
    rig.input.steerY = 1;

    let onset = -1;
    for (let i = 0; i < 10 * TICK_HZ && onset < 0; i++) {
      rig.step();
      if (has(rig.dragon(), DRAGON_FLAG_STALLED)) onset = i;
    }
    expect(onset).toBeGreaterThan(0);
    expect(rig.dragon().speed).toBeLessThan(rig.flight.stallSpeed);
    const pitchAtOnset = rig.dragon().pitch;
    expect(pitchAtOnset).toBeGreaterThan(0.3);

    // Still pulling up as hard as possible: the nose comes down anyway and speed returns.
    let recovered = -1;
    let lowestPitch = pitchAtOnset;
    let lowestSpeed = rig.dragon().speed;
    for (let i = 0; i < 10 * TICK_HZ && recovered < 0; i++) {
      rig.step();
      lowestPitch = Math.min(lowestPitch, rig.dragon().pitch);
      lowestSpeed = Math.min(lowestSpeed, rig.dragon().speed);
      if (!has(rig.dragon(), DRAGON_FLAG_STALLED)) recovered = i;
    }
    expect(lowestPitch).toBeLessThan(0);
    expect(lowestSpeed).toBeGreaterThanOrEqual(floor);
    expect(recovered).toBeGreaterThan(0);
    expect(rig.dragon().speed).toBeGreaterThanOrEqual(
      rig.flight.stallSpeed * rig.flight.stallRecoverScale,
    );
  });

  it('weakens steering while stalled', () => {
    const normal = makeRig();
    const stalled = makeRig();
    normal.dragon().speed = normal.flight.stallSpeed + 0.5;
    stalled.dragon().speed = stalled.flight.stallSpeed - 0.5;
    normal.input.steerX = 1;
    stalled.input.steerX = 1;
    normal.step(5);
    stalled.step(5);
    expect(has(stalled.dragon(), DRAGON_FLAG_STALLED)).toBe(true);
    expect(has(normal.dragon(), DRAGON_FLAG_STALLED)).toBe(false);
    expect(Math.abs(stalled.dragon().yawRate)).toBeLessThan(Math.abs(normal.dragon().yawRate) / 2);
  });

  it('never drops below the speed floor, even with wings folded in a climb', () => {
    const rig = makeRig();
    const floor = minFlightSpeed(rig.flight, CLASS_TUNING.tempest);
    rig.dragon().pitch = rig.flight.maxClimbPitch;
    rig.dragon().speed = 0;
    rig.input.steerY = 1;
    for (let i = 0; i < 5 * TICK_HZ; i++) {
      rig.step();
      expect(rig.dragon().speed).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe('boost and stamina', () => {
  it('accelerates while it drains stamina, then locks out when empty', () => {
    const rig = makeRig();
    rig.input.buttons = BUTTON_BOOST;
    rig.step();
    expect(has(rig.dragon(), DRAGON_FLAG_BOOSTING)).toBe(true);
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_BOOST);
    expect(rig.dragon().stamina).toBeCloseTo(1 - rig.flight.staminaDrainPerS * TICK_DT_S, 12);
    expect(rig.dragon().speed).toBeCloseTo(
      rig.flight.cruiseSpeed + rig.flight.boostAccel * TICK_DT_S,
      9,
    );

    let boostTicks = 1;
    while (has(rig.dragon(), DRAGON_FLAG_BOOSTING) && boostTicks < 1000) {
      rig.step();
      if (has(rig.dragon(), DRAGON_FLAG_BOOSTING)) boostTicks++;
    }
    // 1 / 0.25 per second = 4 s of boost (±1 tick of float rounding).
    const expected = TICK_HZ / rig.flight.staminaDrainPerS;
    expect(Math.abs(boostTicks - expected)).toBeLessThanOrEqual(1);
    expect(rig.dragon().stamina).toBe(0);
    expect(rig.dragon().boostLocked).toBe(true);
    expect(rig.dragon().speed).toBeGreaterThan(80);
    expect(rig.dragon().speed).toBeLessThanOrEqual(rig.flight.maxSpeed);
  });

  it('regenerates only after the delay, and cannot boost again until partly refilled', () => {
    const rig = makeRig();
    rig.input.buttons = BUTTON_BOOST;
    rig.step(10 * TICK_HZ);
    expect(rig.dragon().stamina).toBeLessThan(rig.flight.boostRestartStamina);

    // Keep holding the button. Stamina must climb back to the restart level before any boost.
    let resumedAt = -1;
    let staminaBeforeResume = 0;
    for (let i = 0; i < 20 * TICK_HZ && resumedAt < 0; i++) {
      const before = rig.dragon().stamina;
      rig.step();
      if (has(rig.dragon(), DRAGON_FLAG_BOOSTING)) {
        resumedAt = i;
        staminaBeforeResume = before;
      }
    }
    expect(resumedAt).toBeGreaterThan(0);
    expect(staminaBeforeResume).toBeGreaterThanOrEqual(rig.flight.boostRestartStamina);
    expect(staminaBeforeResume).toBeLessThan(rig.flight.boostRestartStamina + 0.01);
  });

  it('waits exactly the regen delay after the last spend, then refills to full and stops', () => {
    const rig = makeRig();
    rig.input.buttons = BUTTON_BOOST;
    rig.step(TICK_HZ);
    rig.input.buttons = 0;
    const spent = rig.dragon().stamina;
    expect(spent).toBeCloseTo(1 - rig.flight.staminaDrainPerS, 9);

    const delay = secondsToTicks(rig.flight.staminaRegenDelayS);
    expect(delay).toBe(30);
    rig.step(delay);
    expect(rig.dragon().stamina).toBe(spent);
    expect(has(rig.dragon(), DRAGON_FLAG_BOOSTING)).toBe(false);
    rig.step();
    expect(rig.dragon().stamina).toBeCloseTo(spent + rig.flight.staminaRegenPerS * TICK_DT_S, 12);

    rig.step(10 * TICK_HZ);
    expect(rig.dragon().stamina).toBe(1);
  });
});

describe('flap', () => {
  it('kicks the dragon up for a stamina cost', () => {
    const rig = makeRig();
    rig.input.buttons = BUTTON_FLAP;
    rig.step();
    const dragon = rig.dragon();
    expect(dragon.stamina).toBeCloseTo(1 - rig.flight.flapStaminaCost, 12);
    expect(dragon.velocity.y).toBeGreaterThan(rig.flight.flapImpulse * 0.8);
    expect(dragon.position.y).toBeGreaterThan(SPAWN.y + 0.4);
    expect(dragon.speed).toBeGreaterThan(rig.flight.cruiseSpeed + 3);
    expect(dragon.anim).toBe(DRAGON_ANIM_FLAP);

    rig.input.buttons = 0;
    rig.step(2 * TICK_HZ);
    // About flapImpulse / burstDamping metres of height per flap, and the kick has faded.
    expect(rig.dragon().position.y).toBeGreaterThan(SPAWN.y + 3.5);
    expect(Math.abs(rig.dragon().velocity.y)).toBeLessThan(0.1);
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_GLIDE);
  });

  it('repeats once per cooldown while held and stops when stamina is short', () => {
    const rig = makeRig();
    const cooldown = secondsToTicks(rig.flight.flapCooldownS);
    expect(cooldown).toBe(21);
    rig.input.buttons = BUTTON_FLAP;
    rig.step(3 * cooldown);
    expect(rig.dragon().stamina).toBeCloseTo(1 - 3 * rig.flight.flapStaminaCost, 9);
    rig.step();
    expect(rig.dragon().stamina).toBeCloseTo(1 - 4 * rig.flight.flapStaminaCost, 9);

    // 8 flaps fit in a full bar (8 * 0.12 = 0.96); the 9th has to wait for regeneration.
    rig.step(4 * cooldown);
    expect(rig.dragon().stamina).toBeLessThan(rig.flight.flapStaminaCost);
    const low = rig.dragon().stamina;
    rig.step(cooldown);
    expect(rig.dragon().stamina).toBe(low);
  });
});

describe('barrel-roll dodge', () => {
  it('is immune for 0.25 s and bursts sideways', () => {
    const rig = makeRig();
    const immunityTicks = secondsToTicks(rig.flight.dodgeImmunityS);
    expect(immunityTicks).toBe(8);

    rig.input.buttons = BUTTON_DODGE_RIGHT;
    let flagged = 0;
    for (let i = 0; i < 3 * TICK_HZ; i++) {
      rig.step();
      const dragon = rig.dragon();
      if (has(dragon, DRAGON_FLAG_DODGING)) {
        flagged++;
        // The flag is on for the FIRST ticks after the press, with no gap.
        expect(i).toBe(flagged - 1);
        expect(damageDragon(dragon, 5, rig.flight)).toBe(0);
      }
    }
    expect(flagged).toBe(immunityTicks);
    // The dragon's right is -X when it faces +Z. About dodgeImpulse / burstDamping metres.
    expect(rig.dragon().position.x).toBeLessThan(-7);
    expect(rig.dragon().position.x).toBeGreaterThan(-12);
    expect(rig.dragon().position.y).toBeCloseTo(SPAWN.y, 9);
    expect(damageDragon(rig.dragon(), 5, rig.flight)).toBe(5);
  });

  it('spins a full turn and ends level', () => {
    const rig = makeRig();
    const duration = secondsToTicks(rig.flight.dodgeDurationS);
    rig.input.buttons = BUTTON_DODGE_LEFT;
    rig.step();
    expect(rig.dragon().orientation.w).toBeCloseTo(1, 9);
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_BANK_L);
    rig.input.buttons = 0;

    let minW = 1;
    let spunLeft = false;
    for (let i = 1; i < duration; i++) {
      rig.step();
      const dragon = rig.dragon();
      minW = Math.min(minW, Math.abs(dragon.orientation.w));
      // Rolling left = negative rotation about the forward (+Z) axis early in the spin.
      if (i === 3) spunLeft = dragon.orientation.z * dragon.orientation.w < 0;
      expect(dragon.anim).toBe(DRAGON_ANIM_BANK_L);
    }
    expect(spunLeft).toBe(true);
    // Upside down in the middle of the roll.
    expect(minW).toBeLessThan(0.2);
    rig.step();
    expect(Math.abs(rig.dragon().orientation.w)).toBeCloseTo(1, 9);
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_GLIDE);
    expect(rig.dragon().position.x).toBeGreaterThan(5);
    // The bank angle itself was never touched by the spin.
    expect(rig.dragon().roll).toBe(0);
  });

  it('respects the 4 s cooldown and needs a fresh press', () => {
    const rig = makeRig();
    const cooldown = secondsToTicks(rig.flight.dodgeCooldownS);
    expect(cooldown).toBe(120);

    // Tap the button on every even tick and note when a dodge actually starts.
    const starts: number[] = [];
    for (let i = 0; i < 2 * cooldown + 10; i++) {
      rig.input.buttons = i % 2 === 0 ? BUTTON_DODGE_RIGHT : 0;
      rig.step();
      if (rig.dragon().dodgeCooldownTicks === cooldown) starts.push(i);
    }
    expect(starts).toEqual([0, cooldown, 2 * cooldown]);

    // Holding the button never dodges again, however long.
    const held = makeRig();
    held.input.buttons = BUTTON_DODGE_LEFT | BUTTON_DODGE_RIGHT;
    held.step();
    // Both on the same tick: left wins.
    expect(held.dragon().dodgeDir).toBe(-1);
    let again = 0;
    for (let i = 0; i < 3 * cooldown; i++) {
      held.step();
      if (held.dragon().dodgeCooldownTicks === cooldown) again++;
    }
    expect(again).toBe(0);
    expect(held.dragon().dodgeCooldownTicks).toBe(0);
  });
});

describe('damage and death', () => {
  it('takes damage, shows the hit hint, and dies at zero', () => {
    const rig = makeRig();
    const maxHp = CLASS_TUNING.tempest.maxHp;
    expect(damageDragon(rig.dragon(), 30, rig.flight)).toBe(30);
    expect(damageDragon(rig.dragon(), -5, rig.flight)).toBe(0);
    expect(damageDragon(rig.dragon(), Number.NaN, rig.flight)).toBe(0);
    rig.step();
    expect(rig.dragon().health).toBe(maxHp - 30);
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_HIT);
    rig.step(secondsToTicks(rig.flight.hitAnimS));
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_GLIDE);

    expect(damageDragon(rig.dragon(), 1e9, rig.flight)).toBe(maxHp - 30);
    expect(has(rig.dragon(), DRAGON_FLAG_ALIVE)).toBe(false);
    expect(damageDragon(rig.dragon(), 10, rig.flight)).toBe(0);
  });

  it('falls without control once dead', () => {
    const rig = makeRig();
    rig.input.buttons = BUTTON_BOOST;
    rig.step(5);
    damageDragon(rig.dragon(), 1e9, rig.flight);
    const yaw = rig.dragon().yaw;
    const startY = rig.dragon().position.y;

    rig.input.steerX = 1;
    rig.input.steerY = 1;
    rig.input.buttons = BUTTON_BOOST | BUTTON_FLAP | BUTTON_DODGE_LEFT;
    for (let i = 0; i < 6 * TICK_HZ; i++) {
      rig.step();
      expectSane(rig.dragon(), rig.flight, `dead tick ${i}`);
    }
    const dragon = rig.dragon();
    expect(dragon.flags).toBe(0);
    expect(dragon.anim).toBe(DRAGON_ANIM_DEATH_FALL);
    expect(dragon.yaw).toBe(yaw);
    expect(dragon.health).toBe(0);
    expect(dragon.position.y).toBeLessThan(startY - 150);
    expect(dragon.burst.y).toBe(-rig.flight.deathFallMaxSpeed);
    expect(dragon.velocity.y).toBeLessThan(-rig.flight.deathFallMaxSpeed * 0.9);
    expect(dragon.speed).toBeLessThan(5);
    expect(dragon.dodgeCooldownTicks).toBe(0);
  });

  it('treats health written to zero by another system as death', () => {
    const rig = makeRig();
    rig.dragon().health = 0;
    rig.step();
    expect(has(rig.dragon(), DRAGON_FLAG_ALIVE)).toBe(false);
    expect(rig.dragon().anim).toBe(DRAGON_ANIM_DEATH_FALL);
  });
});

describe('collision seam', () => {
  it('calls the collision world once per active dragon per tick with the previous position', () => {
    const calls: { id: number; from: Vec3; to: Vec3; dtS: number; tuning: FlightTuning }[] = [];
    const world: SimCollisionWorld = {
      resolveDragon(dragon, prevPosition, dtS, tuning) {
        calls.push({
          id: dragon.id,
          from: { ...prevPosition },
          to: { ...dragon.position },
          dtS,
          tuning,
        });
      },
    };
    const rig = makeRig({ collisionWorld: world });
    rig.sim.spawnDragon(6, TEAM_FROST, 'talon', { x: 100, y: 300, z: 0 }, 0);
    rig.step(2);
    expect(calls.map((call) => call.id)).toEqual([0, 6, 0, 6]);
    const [first, , third] = calls;
    expect(first?.from).toEqual(SPAWN);
    expect(first?.to.z).toBeCloseTo(FLIGHT_TUNING.cruiseSpeed * TICK_DT_S, 9);
    expect(third?.from).toEqual(first?.to);
    expect(first?.dtS).toBe(TICK_DT_S);
    expect(first?.tuning).toBe(rig.flight);

    rig.sim.setCollisionWorld(null);
    rig.step();
    expect(calls).toHaveLength(4);
  });

  it('lets a collision world bounce and hurt the dragon through the helpers', () => {
    const floorY = 400;
    let bounces = 0;
    const world: SimCollisionWorld = {
      resolveDragon(dragon, prevPosition, dtS, tuning) {
        if (dragon.position.y >= floorY) return;
        bounces++;
        const vx = (dragon.position.x - prevPosition.x) / dtS;
        const vy = (dragon.position.y - prevPosition.y) / dtS;
        const vz = (dragon.position.z - prevPosition.z) / dtS;
        dragon.position.y = floorY;
        const keep = tuning.terrainBounceRestitution;
        setDragonVelocity(dragon, vx * keep, -vy * keep, vz * keep);
        damageDragon(dragon, 25, tuning, true);
      },
    };
    const rig = makeRig({ collisionWorld: world });
    rig.input.steerY = -1;
    while (bounces === 0 && rig.tick < 20 * TICK_HZ) {
      rig.step();
      expect(rig.dragon().position.y).toBeGreaterThanOrEqual(floorY);
    }
    const dragon = rig.dragon();
    expect(bounces).toBe(1);
    expect(dragon.health).toBe(CLASS_TUNING.tempest.maxHp - 25);
    expect(dragon.anim).toBe(DRAGON_ANIM_HIT);
    // Reflected: now climbing, slower than it came in, and the derived fields agree.
    expect(dragon.pitch).toBeGreaterThan(0.3);
    expect(dragon.velocity.y).toBeGreaterThan(5);
    expect(dragon.speed).toBeLessThan(FLIGHT_TUNING.maxSpeed * 0.6);
    expectSane(dragon, rig.flight, 'after bounce');
  });

  it('survives a collision world that writes garbage', () => {
    const world: SimCollisionWorld = {
      resolveDragon(dragon) {
        dragon.position.x = Number.NaN;
        dragon.position.y = Infinity;
        dragon.yaw = Number.NaN;
        dragon.pitch = -Infinity;
        dragon.roll = Number.NaN;
        dragon.speed = Number.NaN;
        dragon.yawRate = Infinity;
        dragon.pitchRate = Number.NaN;
        dragon.burst.x = Infinity;
        dragon.burst.y = 1e300;
        dragon.stamina = Number.NaN;
        setDragonVelocity(dragon, Number.NaN, 0, 0);
        setDragonVelocity(dragon, 0, 0, 0);
      },
    };
    const rig = makeRig({ collisionWorld: world });
    rig.input.steerX = 1;
    for (let i = 0; i < 20; i++) {
      rig.step();
      expectSane(rig.dragon(), rig.flight, `garbage tick ${i}`);
    }
    // The position fell back to where the tick started.
    expect(rig.dragon().position.x).toBe(SPAWN.x);
    expect(rig.dragon().position.y).toBe(SPAWN.y);
  });

  it('points the flight path along a velocity', () => {
    const rig = makeRig();
    const dragon = rig.dragon();
    setDragonVelocity(dragon, 30, 30, 0);
    expect(dragon.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(dragon.pitch).toBeCloseTo(Math.PI / 4, 12);
    expect(dragon.speed).toBeCloseTo(Math.hypot(30, 30), 12);
    // Straight down keeps the heading; finalize clamps the pitch to the dive limit.
    setDragonVelocity(dragon, 0, -50, 0);
    expect(dragon.yaw).toBeCloseTo(Math.PI / 2, 12);
    rig.step();
    expect(rig.dragon().pitch).toBeGreaterThanOrEqual(-rig.flight.maxDivePitch);
  });
});

describe('missing input', () => {
  it('keeps held buttons but makes no new presses and flies straight', () => {
    const rig = makeRig();
    rig.input.steerX = 1;
    rig.input.buttons = BUTTON_BOOST | BUTTON_DODGE_RIGHT;
    rig.step(3);
    const cooldown = secondsToTicks(rig.flight.dodgeCooldownS);

    const none: undefined[] = [];
    let tick = rig.tick;
    let dodges = 0;
    for (let i = 0; i < cooldown + 30; i++) {
      rig.sim.step(tick++, none);
      if (rig.dragon().dodgeCooldownTicks === cooldown) dodges++;
      if (i === 5) expect(has(rig.dragon(), DRAGON_FLAG_BOOSTING)).toBe(true);
    }
    expect(dodges).toBe(0);
    expect(rig.dragon().prevButtons).toBe(BUTTON_BOOST | BUTTON_DODGE_RIGHT);
    // Steer went back to neutral, so the turn died away.
    expect(Math.abs(rig.dragon().yawRate)).toBeLessThan(1e-6);
  });
});

/** Hostile values a broken client or a bug upstream could put into an InputFrame. */
const NASTY = [
  Number.NaN,
  Infinity,
  -Infinity,
  1e308,
  -1e308,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  5e-324,
  -0,
  1e21,
  -1e21,
];

function fillAdversarial(frame: InputFrame, random: () => number): void {
  const pick = (): number => NASTY[Math.floor(random() * NASTY.length)] ?? Number.NaN;
  frame.steerX = random() < 0.1 ? pick() : random() * 4 - 2;
  frame.steerY = random() < 0.1 ? pick() : random() * 4 - 2;
  frame.buttons = random() < 0.05 ? pick() : Math.floor(random() * 0x1ffff) - 0xff;
}

describe('adversarial inputs', () => {
  it('stays finite and bounded for 10k ticks of hostile input on every class', () => {
    const flight: FlightTuning = { ...FLIGHT_TUNING };
    const sim = createSim({ flightTuning: flight });
    const random = lcg(0xd4a60f);
    const frames: InputFrame[] = [];
    const inputs: (InputFrame | undefined)[] = [];
    DRAGON_CLASS_IDS.forEach((classId, id) => {
      sim.spawnDragon(id, id % 2 === 0 ? TEAM_EMBER : TEAM_FROST, classId, SPAWN, id);
      frames.push(createInputFrame());
    });
    // A fifth dragon is killed halfway, so the death fall gets the same treatment.
    sim.spawnDragon(4, TEAM_EMBER, 'talon', SPAWN, 0);
    frames.push(createInputFrame());

    let minSpeed = Infinity;
    let maxSpeed = 0;
    let stalls = 0;
    let dodges = 0;
    for (let tick = 0; tick < 10_000; tick++) {
      for (let id = 0; id < frames.length; id++) {
        const frame = frames[id];
        if (frame === undefined) continue;
        // Hold each random input for a while so dives, climbs and stalls actually develop.
        if (random() < 0.08) fillAdversarial(frame, random);
        inputs[id] = random() < 0.03 ? undefined : frame;
      }
      if (tick === 5000) {
        const victim = sim.getDragon(4);
        if (victim !== undefined) damageDragon(victim, 1e9, flight, true);
      }
      sim.step(tick, inputs);

      for (const dragon of sim.current.dragons) {
        if (!dragon.active) continue;
        expectSane(dragon, flight, `tick ${tick} dragon ${dragon.id}`);
        if (has(dragon, DRAGON_FLAG_ALIVE)) {
          minSpeed = Math.min(minSpeed, dragon.speed);
          maxSpeed = Math.max(maxSpeed, dragon.speed);
          if (has(dragon, DRAGON_FLAG_STALLED)) stalls++;
          if (has(dragon, DRAGON_FLAG_DODGING)) dodges++;
        }
      }
    }
    // The run really did visit the edges of the envelope.
    expect(minSpeed).toBeLessThan(flight.stallSpeed);
    expect(maxSpeed).toBeGreaterThan(flight.maxSpeed * 0.95);
    expect(stalls).toBeGreaterThan(0);
    expect(dodges).toBeGreaterThan(0);
    expect(sim.getDragon(4)?.anim).toBe(DRAGON_ANIM_DEATH_FALL);
  }, 60_000);

  it('survives broken tuning values without producing NaN', () => {
    const rig = makeRig();
    const random = lcg(77);
    const keys = Object.keys(rig.flight) as (keyof FlightTuning)[];
    const cls = CLASS_TUNING.tempest;
    for (let i = 0; i < 3000; i++) {
      if (i % 25 === 0) {
        // Restore, then break one value: the dev GUI can type anything into the live table.
        Object.assign(rig.flight, FLIGHT_TUNING);
        const key = keys[Math.floor(random() * keys.length)];
        if (key !== undefined) rig.flight[key] = NASTY[Math.floor(random() * NASTY.length)] ?? 0;
        fillAdversarial(rig.input, random);
      }
      rig.step();
      for (const [path, value] of collectNumbers(rig.dragon(), 'dragon', [])) {
        if (!Number.isFinite(value)) throw new Error(`tick ${i}: ${path} is ${value}`);
      }
      const q = rig.dragon().orientation;
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
      expect(rig.dragon().stamina).toBeGreaterThanOrEqual(0);
      expect(rig.dragon().stamina).toBeLessThanOrEqual(1);
    }
    expect(cls.maxHp).toBeGreaterThan(0);
  });
});

/** Ten dragons of mixed classes plus a per-player input stream from one seed. */
function makeCrowd(seed: number): { sim: Sim; advance(ticks: number): void } {
  const sim = createSim({ flightTuning: { ...FLIGHT_TUNING } });
  const random = lcg(seed);
  const frames: InputFrame[] = [];
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const classId = DRAGON_CLASS_IDS[id % DRAGON_CLASS_IDS.length] ?? 'talon';
    sim.spawnDragon(
      id,
      id < 5 ? TEAM_EMBER : TEAM_FROST,
      classId,
      { x: id * 40, y: 600, z: 0 },
      id,
    );
    frames.push(createInputFrame());
  }
  let tick = 0;
  return {
    sim,
    advance(ticks) {
      for (let i = 0; i < ticks; i++) {
        for (const frame of frames) {
          if (random() < 0.1) {
            frame.steerX = random() * 2 - 1;
            frame.steerY = random() * 2 - 1;
            frame.buttons = Math.floor(random() * 0x800);
          }
          frame.tick = tick;
        }
        if (tick === 900) {
          const victim = sim.getDragon(5);
          if (victim !== undefined) damageDragon(victim, 1e9, sim.flightTuning, true);
        }
        sim.step(tick++, frames);
      }
    },
  };
}

describe('determinism', () => {
  it('gives two sims with the same inputs identical states, field for field', () => {
    const a = makeCrowd(2024);
    const b = makeCrowd(2024);
    for (let checkpoint = 0; checkpoint < 12; checkpoint++) {
      a.advance(250);
      b.advance(250);
      expect(a.sim.current).toEqual(b.sim.current);
      expect(a.sim.prev).toEqual(b.sim.prev);
      // toEqual would let NaN === NaN and -0 === 0 slide; the JSON text does not hide a drift.
      expect(JSON.stringify(a.sim.current)).toBe(JSON.stringify(b.sim.current));
    }
    expect(a.sim.current.tick).toBe(2999);
    expect(a.sim.current.dragonCount).toBe(MAX_PLAYERS);

    // And a different seed really does produce a different flight.
    const c = makeCrowd(2025);
    c.advance(3000);
    expect(c.sim.current).not.toEqual(a.sim.current);
  });

  it('does not depend on how the run is split into calls', () => {
    const whole = makeCrowd(7);
    const pieces = makeCrowd(7);
    whole.advance(1200);
    for (let i = 0; i < 1200; i += 37) pieces.advance(Math.min(37, 1200 - i));
    expect(pieces.sim.current).toEqual(whole.sim.current);
  });

  it('replays identically after a reset', () => {
    const first = makeCrowd(99);
    first.advance(600);
    const snapshot = JSON.stringify(first.sim.current);

    const sim = first.sim;
    sim.reset();
    expect(sim.current.dragonCount).toBe(0);
    const replay = makeCrowd(99);
    replay.advance(600);
    expect(JSON.stringify(replay.sim.current)).toBe(snapshot);
  });
});

describe('step cost', () => {
  it('steps ten dragons far inside the host sim budget', () => {
    const crowd = makeCrowd(4242);
    // Warm up so the JIT has compiled the hot path before timing.
    crowd.advance(2000);

    const ticks = 1000;
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      crowd.advance(ticks);
      best = Math.min(best, performance.now() - start);
    }
    const microsPerTick = (best / ticks) * 1000;
    console.info(
      `[flight] 10 dragons: ${microsPerTick.toFixed(2)} us per tick ` +
        `(input generation included, best of 5 x ${ticks} ticks)`,
    );
    // Budget: sim + net <= 1.5 ms per frame on the host. Loose bound for slow CI machines; the
    // measured figure is two orders of magnitude lower.
    expect(microsPerTick).toBeLessThan(250);
  });
});
