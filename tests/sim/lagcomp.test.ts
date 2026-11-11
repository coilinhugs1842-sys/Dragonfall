/**
 * Host lag compensation (T-3.3): the history ring, the per-shooter rewind and its cap, the
 * veto for targets that could not be hit at the rewound time, and through `Sim.step`: a shot
 * fired where a lagged shooter saw a crossing target hits with compensation and misses without.
 */

import { describe, expect, it } from 'vitest';
import {
  ABILITY_TABLE,
  BUTTON_AIM,
  BUTTON_PRIMARY,
  CLASS_TUNING,
  COMBAT_TUNING,
  DRAGON_FLAG_ALIVE,
  FLIGHT_TUNING,
  LAG_COMP_HISTORY_MS,
  LAG_COMP_MAX_REWIND_MS,
  MATCH_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_MS,
  createInputFrame,
} from '../../src/shared';
import type { GameEvent, HitEvent, InputFrame, MutableVec3 } from '../../src/shared';
import { createSim, createSimState } from '../../src/sim';
import type { DragonState, Sim, SimState } from '../../src/sim';
import {
  LAG_COMP_HISTORY_TICKS,
  LAG_COMP_INTERP_DELAY_TICKS,
  LAG_COMP_MAX_REWIND_TICKS,
  LAG_COMP_NOWHERE,
  LAG_COMP_SNAPSHOT_AGE_TICKS,
  LagCompensator,
} from '../../src/sim/lagcomp';

// --- Unit rig: a hand-moved dragon ---------------------------------------------------------------

const SHOOTER = 1;
const TARGET = 2;
/** m per tick of the hand-moved target: 45 m/s. */
const STEP_M = 45 / 30;

function stateWithTarget(): { state: SimState; target: DragonState } {
  const state = createSimState();
  const target = state.dragons[3];
  if (target === undefined) throw new Error('no slot');
  target.active = true;
  target.id = TARGET;
  target.team = TEAM_FROST;
  target.flags = DRAGON_FLAG_ALIVE;
  target.position.y = 300;
  state.dragonCount = 1;
  return { state, target };
}

/** Moves the target to where it is on `tick` (x = tick * STEP_M) and records it. */
function recordTick(comp: LagCompensator, state: SimState, target: DragonState, tick: number) {
  state.tick = tick;
  target.position.x = tick * STEP_M;
  comp.record(state);
}

/** What `sample` answers for a shot on `tick` (the target is already at its `tick` position). */
function sampleOn(
  comp: LagCompensator,
  target: DragonState,
  tick: number,
  shooter = SHOOTER,
): MutableVec3 {
  target.position.x = tick * STEP_M;
  const out = { x: 0, y: 0, z: 0 };
  comp.sample(shooter, target, tick, out);
  return out;
}

describe('LagCompensator: history and rewind', () => {
  it('keeps at least 300 ms of history and caps the rewind at 200 ms', () => {
    expect(LAG_COMP_HISTORY_TICKS * TICK_MS).toBeGreaterThanOrEqual(LAG_COMP_HISTORY_MS);
    expect(LAG_COMP_HISTORY_TICKS).toBeGreaterThanOrEqual(10);
    expect(LAG_COMP_MAX_REWIND_TICKS * TICK_MS).toBeCloseTo(LAG_COMP_MAX_REWIND_MS, 9);
    // The ring must hold the oldest tick a capped rewind can ask for.
    expect(LAG_COMP_HISTORY_TICKS).toBeGreaterThan(LAG_COMP_MAX_REWIND_TICKS + 1);
  });

  it('answers with the current position for a shooter with no rewind (host, bots, unknown)', () => {
    const comp = new LagCompensator();
    const { state, target } = stateWithTarget();
    for (let tick = 0; tick < 20; tick++) recordTick(comp, state, target, tick);
    expect(sampleOn(comp, target, 20).x).toBe(20 * STEP_M);
    expect(sampleOn(comp, target, 20, NO_PLAYER).x).toBe(20 * STEP_M);
    expect(comp.rewindTicksOf(SHOOTER)).toBe(0);
    expect(comp.rewoundCount).toBe(0);
  });

  it('rewinds a target to where it was, interpolating between history ticks', () => {
    const comp = new LagCompensator();
    const { state, target } = stateWithTarget();
    for (let tick = 0; tick < 20; tick++) recordTick(comp, state, target, tick);

    comp.setRewindTicks(SHOOTER, 3);
    expect(sampleOn(comp, target, 20).x).toBeCloseTo(17 * STEP_M, 9);
    // 150 ms = 4.5 ticks: halfway between two recorded ticks.
    comp.setRewindTicks(SHOOTER, 4.5);
    const seen = sampleOn(comp, target, 20);
    expect(seen.x).toBeCloseTo(15.5 * STEP_M, 9);
    expect(seen.y).toBe(300);
    // Less than a tick: between the last recorded tick and the tick being simulated.
    comp.setRewindTicks(SHOOTER, 0.25);
    expect(sampleOn(comp, target, 20).x).toBeCloseTo(19.75 * STEP_M, 9);
    // The rewind is per shooter.
    expect(sampleOn(comp, target, 20, 7).x).toBe(20 * STEP_M);
  });

  it('clamps whatever a shooter asks for to the 200 ms cap', () => {
    const comp = new LagCompensator();
    const { state, target } = stateWithTarget();
    for (let tick = 0; tick < 40; tick++) recordTick(comp, state, target, tick);

    comp.setRewindTicks(SHOOTER, 30);
    expect(comp.rewindTicksOf(SHOOTER)).toBe(LAG_COMP_MAX_REWIND_TICKS);
    expect(comp.rewindMsOf(SHOOTER)).toBeCloseTo(LAG_COMP_MAX_REWIND_MS, 9);
    expect(sampleOn(comp, target, 40).x).toBeCloseTo((40 - LAG_COMP_MAX_REWIND_TICKS) * STEP_M, 9);

    for (const bad of [-5, Number.NaN, -Infinity]) {
      comp.setRewindTicks(SHOOTER, bad);
      expect(comp.rewindTicksOf(SHOOTER)).toBe(0);
    }
    comp.setRewindTicks(SHOOTER, Infinity);
    expect(comp.rewindTicksOf(SHOOTER)).toBe(LAG_COMP_MAX_REWIND_TICKS);
    // Ids outside the table are ignored, not written somewhere.
    comp.setRewindTicks(-1, 3);
    comp.setRewindTicks(4000, 3);
    expect(comp.rewindTicksOf(4000)).toBe(0);
  });

  it('turns reported latency into a smoothed, capped rewind', () => {
    const comp = new LagCompensator();
    // Input tick - acked snapshot tick = 2 ticks: rewind = 2 - mean snapshot age + interp delay.
    comp.observeLatency(SHOOTER, 2);
    const expected = 2 - LAG_COMP_SNAPSHOT_AGE_TICKS + LAG_COMP_INTERP_DELAY_TICKS;
    expect(comp.rewindTicksOf(SHOOTER)).toBeCloseTo(expected, 9);
    // One outlier moves it only a little.
    comp.observeLatency(SHOOTER, 3);
    expect(comp.rewindTicksOf(SHOOTER)).toBeGreaterThan(expected);
    expect(comp.rewindTicksOf(SHOOTER)).toBeLessThan(expected + 0.2);
    // A client claiming seconds of latency gets the cap, never more.
    for (let i = 0; i < 200; i++) comp.observeLatency(SHOOTER, 5000);
    expect(comp.rewindTicksOf(SHOOTER)).toBeLessThanOrEqual(LAG_COMP_MAX_REWIND_TICKS);
    expect(comp.rewindTicksOf(SHOOTER)).toBeCloseTo(LAG_COMP_MAX_REWIND_TICKS, 6);
    // Nonsense (a snapshot "from the future", NaN) is no rewind, not a negative one.
    const other = 9;
    comp.observeLatency(other, -500);
    expect(comp.rewindTicksOf(other)).toBe(0);
    comp.observeLatency(other, Number.NaN);
    expect(comp.rewindTicksOf(other)).toBe(0);
  });

  it('wraps its ring: old ticks are overwritten and never read as newer ones', () => {
    const comp = new LagCompensator();
    const { state, target } = stateWithTarget();
    comp.setRewindTicks(SHOOTER, 4.5);
    // Several times around the ring, sampling on every tick.
    for (let tick = 0; tick < LAG_COMP_HISTORY_TICKS * 5 + 3; tick++) {
      if (tick >= 5) {
        expect(sampleOn(comp, target, tick).x).toBeCloseTo((tick - 4.5) * STEP_M, 9);
      }
      recordTick(comp, state, target, tick);
    }
    expect(comp.historyLengthOf(TARGET)).toBe(LAG_COMP_HISTORY_TICKS);

    // The sim paused (a countdown) and resumed much later: what is in the ring is for other
    // ticks, so nothing is known about "4.5 ticks ago" and the target is where it is.
    const later = 1000;
    expect(sampleOn(comp, target, later).x).toBe(later * STEP_M);
    // One tick after the gap only the newer neighbour is known.
    recordTick(comp, state, target, later);
    comp.setRewindTicks(SHOOTER, 1.5);
    expect(sampleOn(comp, target, later + 1).x).toBeCloseTo(later * STEP_M, 9);
  });

  it('starts a fresh history when a slot changes hands, and forgets on reset', () => {
    const comp = new LagCompensator();
    const { state, target } = stateWithTarget();
    comp.setRewindTicks(SHOOTER, 3);
    for (let tick = 0; tick < 10; tick++) recordTick(comp, state, target, tick);
    expect(comp.historyLengthOf(TARGET)).toBe(10);

    // Another player takes the slot: the old player's positions are not theirs.
    target.id = 5;
    recordTick(comp, state, target, 10);
    expect(comp.historyLengthOf(TARGET)).toBe(0);
    expect(comp.historyLengthOf(5)).toBe(1);
    expect(sampleOn(comp, target, 11).x).toBe(11 * STEP_M);

    // The slot is freed.
    target.active = false;
    state.tick = 11;
    comp.record(state);
    expect(comp.historyLengthOf(5)).toBe(0);

    target.active = true;
    for (let tick = 12; tick < 20; tick++) recordTick(comp, state, target, tick);
    comp.reset();
    expect(comp.historyLengthOf(5)).toBe(0);
    expect(comp.rewindTicksOf(SHOOTER)).toBe(3);
    comp.resetAll();
    expect(comp.rewindTicksOf(SHOOTER)).toBe(0);
  });

  it('reports a target that could not be hit at the rewound time as out of reach', () => {
    const cases: { name: string; make: (target: DragonState) => () => void }[] = [
      {
        name: 'dodge immunity',
        make: (target) => {
          target.dodgeImmunityTicks = 1;
          return () => (target.dodgeImmunityTicks = 0);
        },
      },
      {
        name: 'spawn protection',
        make: (target) => {
          target.spawnProtectTicks = 1;
          return () => (target.spawnProtectTicks = 0);
        },
      },
      {
        name: 'phase dive',
        make: (target) => {
          target.phaseTicks = 1;
          return () => (target.phaseTicks = 0);
        },
      },
      {
        name: 'dead',
        make: (target) => {
          target.flags = 0;
          return () => (target.flags = DRAGON_FLAG_ALIVE);
        },
      },
    ];
    for (const { name, make } of cases) {
      const comp = new LagCompensator();
      const { state, target } = stateWithTarget();
      comp.setRewindTicks(SHOOTER, 4.5);
      for (let tick = 0; tick < 10; tick++) recordTick(comp, state, target, tick);
      // Untouchable on ticks 10..12 only.
      const restore = make(target);
      for (let tick = 10; tick <= 12; tick++) recordTick(comp, state, target, tick);
      restore();
      for (let tick = 13; tick < 30; tick++) {
        // The shot on `tick` looks at tick - 4.5, i.e. between tick - 5 and tick - 4.
        const seen = sampleOn(comp, target, tick);
        const touches = tick - 5 <= 12 && tick - 4 >= 10;
        if (touches) expect(seen.y, `${name} on tick ${tick}`).toBe(LAG_COMP_NOWHERE);
        else expect(seen.x, `${name} on tick ${tick}`).toBeCloseTo((tick - 4.5) * STEP_M, 9);
        recordTick(comp, state, target, tick);
      }
      expect(comp.vetoedCount, name).toBeGreaterThan(0);
    }
  });

  it('does nothing when disabled', () => {
    const comp = new LagCompensator();
    const { state, target } = stateWithTarget();
    comp.setRewindTicks(SHOOTER, 4.5);
    for (let tick = 0; tick < 20; tick++) recordTick(comp, state, target, tick);
    comp.enabled = false;
    expect(sampleOn(comp, target, 20).x).toBe(20 * STEP_M);
  });
});

// --- Through the sim: a real shot --------------------------------------------------------------

interface Duel {
  readonly sim: Sim;
  readonly comp: LagCompensator;
  readonly hits: HitEvent[];
  readonly inputs: InputFrame[];
  /** Target positions per tick, as recorded after each step (the "client's" history). */
  readonly seenX: number[];
  readonly seenY: number[];
  readonly seenZ: number[];
  tick: number;
}

const REWIND_150_MS = 150 / TICK_MS;

/**
 * A Tempest (the lance: a thin beam) flying +Z and a Tempest crossing its nose from left to
 * right at cruise speed, 45 m/s, about 280 m ahead when the lance fires.
 */
function makeDuel(compensate: boolean, spawnProtectionS = 0): Duel {
  const hits: HitEvent[] = [];
  const comp = new LagCompensator();
  const sim = createSim({
    matchTuning: { ...MATCH_TUNING, spawnProtectionS },
    events: {
      emit: (event: GameEvent) => {
        if (event.type === 'hit') hits.push(structuredClone(event));
      },
    },
    targetPositions: comp,
  });
  comp.enabled = compensate;
  comp.setRewindTicks(SHOOTER, REWIND_150_MS);
  sim.spawnDragon(SHOOTER, TEAM_EMBER, 'tempest', { x: 0, y: 300, z: 0 }, 0);
  sim.spawnDragon(TARGET, TEAM_FROST, 'tempest', { x: -30, y: 300, z: 300 }, Math.PI / 2);
  const inputs: InputFrame[] = [];
  inputs[SHOOTER] = createInputFrame();
  inputs[TARGET] = createInputFrame();
  return { sim, comp, hits, inputs, seenX: [], seenY: [], seenZ: [], tick: 0 };
}

/**
 * One tick. The shooter holds the lance and aims the way a client 150 ms behind would: at the
 * target's position `aimRewindTicks` before the tick being simulated.
 */
function stepDuel(duel: Duel, aimRewindTicks: number): void {
  const { sim, inputs } = duel;
  const tick = duel.tick;
  const shooter = sim.getDragon(SHOOTER);
  const input = inputs[SHOOTER];
  if (shooter === undefined || input === undefined) throw new Error('no shooter');
  input.tick = tick;
  input.buttons = BUTTON_PRIMARY;
  const time = tick - aimRewindTicks;
  const older = Math.floor(time);
  if (older >= 0 && older + 1 < duel.seenX.length + 1) {
    const f = time - older;
    const at = (list: number[]): number => {
      const a = list[older] ?? 0;
      const b = list[older + 1] ?? a;
      return a + (b - a) * f;
    };
    // The shooter fires from where it will be after this tick's step.
    const fromX = shooter.position.x + shooter.velocity.x / 30;
    const fromY = shooter.position.y + shooter.velocity.y / 30;
    const fromZ = shooter.position.z + shooter.velocity.z / 30;
    const dx = at(duel.seenX) - fromX;
    const dy = at(duel.seenY) - fromY;
    const dz = at(duel.seenZ) - fromZ;
    input.aimYaw = Math.atan2(dx, dz);
    input.aimPitch = Math.atan2(dy, Math.hypot(dx, dz));
    input.buttons |= BUTTON_AIM;
  }
  sim.step(tick, inputs);
  duel.comp.record(sim.current);
  const target = sim.getDragon(TARGET);
  if (target === undefined) throw new Error('no target');
  duel.seenX[tick] = target.position.x;
  duel.seenY[tick] = target.position.y;
  duel.seenZ[tick] = target.position.z;
  duel.tick = tick + 1;
}

/** Runs until the lance has fired once (its cooldown starts). Returns the tick it fired on. */
function fireOnce(duel: Duel, aimRewindTicks: number): number {
  for (let i = 0; i < 60; i++) {
    stepDuel(duel, aimRewindTicks);
    const shooter = duel.sim.getDragon(SHOOTER);
    if (shooter !== undefined && (shooter.abilityCooldownTicks[0] ?? 0) > 0) return duel.tick - 1;
  }
  throw new Error('the lance never fired');
}

describe('lag compensation through Sim.step', () => {
  it('the test geometry is a real miss: 150 ms of flight is wider than the hit shape', () => {
    const lance = ABILITY_TABLE.tempest.primary;
    const reach = CLASS_TUNING.tempest.hitRadius * COMBAT_TUNING.hitRadiusScale + lance.radius;
    const flown = FLIGHT_TUNING.cruiseSpeed * CLASS_TUNING.tempest.speedScale * 0.15;
    expect(FLIGHT_TUNING.cruiseSpeed * CLASS_TUNING.tempest.speedScale).toBeCloseTo(45, 6);
    expect(flown).toBeGreaterThan(reach + 0.3);
  });

  it('a 150 ms shooter firing where it saw a 45 m/s crossing target hits with compensation', () => {
    const duel = makeDuel(true);
    const firedOn = fireOnce(duel, REWIND_150_MS);
    const target = duel.sim.getDragon(TARGET);
    if (target === undefined) throw new Error('no target');
    // The target really is crossing at about 45 m/s.
    const speed = Math.hypot(target.velocity.x, target.velocity.y, target.velocity.z);
    expect(speed).toBeGreaterThan(43);
    expect(speed).toBeLessThan(47);
    expect(duel.hits.filter((hit) => hit.targetId === TARGET && hit.tick === firedOn)).toHaveLength(
      1,
    );
    expect(duel.hits[0]?.attackerId).toBe(SHOOTER);
    expect(duel.hits[0]?.source).toBe('primary');
    expect(target.health).toBeLessThan(target.maxHealth);
    expect(duel.comp.rewoundCount).toBeGreaterThan(0);
  });

  it('the same shot misses without compensation', () => {
    const duel = makeDuel(false);
    fireOnce(duel, REWIND_150_MS);
    const target = duel.sim.getDragon(TARGET);
    expect(duel.hits).toHaveLength(0);
    expect(target?.health).toBe(target?.maxHealth);
  });

  it('never moves the shooter: a shot aimed at the present misses a rewound target', () => {
    // The mirror case: the host rewinds, but this shooter aimed where the target IS.
    const duel = makeDuel(true);
    fireOnce(duel, 0);
    expect(duel.hits).toHaveLength(0);
  });

  it('a shooter cannot claim more than the cap: a 400 ms-old sighting misses', () => {
    const duel = makeDuel(true);
    duel.comp.setRewindTicks(SHOOTER, 400 / TICK_MS);
    expect(duel.comp.rewindMsOf(SHOOTER)).toBeCloseTo(LAG_COMP_MAX_REWIND_MS, 9);
    fireOnce(duel, 400 / TICK_MS);
    expect(duel.hits).toHaveLength(0);

    // Aiming at the capped sighting does hit: the cap is what the host uses.
    const capped = makeDuel(true);
    capped.comp.setRewindTicks(SHOOTER, 400 / TICK_MS);
    fireOnce(capped, LAG_COMP_MAX_REWIND_TICKS);
    expect(capped.hits).toHaveLength(1);
  });

  it('does not hit a target that was spawn-protected when the shooter saw it', () => {
    // Protection covers ticks 0..N-1; the lance fires on the first tick after it ended.
    const windupTicks = Math.ceil(ABILITY_TABLE.tempest.primary.windupS * 30);
    const protectionS = (windupTicks + 1) / 30;
    const duel = makeDuel(true, protectionS);
    const shooter = duel.sim.getDragon(SHOOTER);
    // The shooter's own protection is irrelevant here (attacking drops it anyway).
    if (shooter !== undefined) shooter.spawnProtectTicks = 0;
    const firedOn = fireOnce(duel, REWIND_150_MS);
    const target = duel.sim.getDragon(TARGET);
    if (target === undefined) throw new Error('no target');
    // Not protected NOW, so the damage pipeline alone would have let the hit through...
    expect(target.spawnProtectTicks).toBe(0);
    expect(firedOn).toBeGreaterThanOrEqual(windupTicks);
    // ...but it was protected at the rewound time.
    expect(duel.hits).toHaveLength(0);
    expect(duel.comp.vetoedCount).toBeGreaterThan(0);

    // Control: the same timing with no protection is a hit.
    const control = makeDuel(true, 0);
    fireOnce(control, REWIND_150_MS);
    expect(control.hits).toHaveLength(1);
  });

  it('is deterministic', () => {
    const run = (): string => {
      const duel = makeDuel(true);
      for (let i = 0; i < 90; i++) stepDuel(duel, REWIND_150_MS);
      const target = duel.sim.getDragon(TARGET);
      return JSON.stringify([duel.hits, target?.health, target?.position, duel.comp.rewoundCount]);
    };
    expect(run()).toBe(run());
  });
});
