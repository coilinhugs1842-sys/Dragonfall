/**
 * Match rules (T-3.4): lobby settings -> mode config, the phase timeline, Skirmish (limit, time,
 * sudden death, draw), Duel (rounds to three wins, no respawns inside a round, the storm
 * schedule, timeouts, replays), forfeits, per-rider stats and determinism. The director is
 * driven exactly as the host session drives it, around a real `Sim`.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_SPAWN_PROTECTED,
  HOST_SETTING_LIMITS,
  MATCH_TUNING,
  MODE_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  TICK_HZ,
  createInputFrame,
  isOvertime,
} from '../../src/shared';
import type {
  HostSettings,
  InputFrame,
  MatchPhase,
  MatchTuning,
  MatchWinner,
  ModeTuning,
  TeamId,
} from '../../src/shared';
import { DAMAGE_IGNORE_IMMUNITY, createSim } from '../../src/sim';
import type { DragonState, Sim } from '../../src/sim';
import {
  MatchDirector,
  createModeConfig,
  createStormRadii,
  isClassAllowed,
  roundsToWin,
  writeDuelStorm,
} from '../../src/sim/match';
import { LagCompensator } from '../../src/sim/lagcomp';
import type { MatchArena } from '../../src/sim/match';

// --- Rig -------------------------------------------------------------------------------------------

const COUNTDOWN = 3 * TICK_HZ;
const ROUND_END = 1 * TICK_HZ;
const RESULTS = 2 * TICK_HZ;

function testModeTuning(overrides: Partial<ModeTuning> = {}): ModeTuning {
  return {
    roundEndS: ROUND_END / TICK_HZ,
    resultsS: RESULTS / TICK_HZ,
    forfeitGraceS: 2,
    skirmish: { overtimeS: 5 },
    duel: {
      roundTimeS: 20,
      maxRounds: 7,
      stormRoundFractions: [1, 0.8, 0.6],
      stormHoldS: 5,
      stormShrinkS: 10,
      stormEndFraction: 0.15,
      stormMinRadiusM: 120,
      stormGateMarginM: 50,
      healthTieEpsilon: 0.01,
    },
    ...overrides,
  };
}

interface PhaseLog {
  phase: MatchPhase;
  tick: number;
  round: number;
  winner: MatchWinner | null;
}

interface MatchRig {
  readonly sim: Sim;
  readonly director: MatchDirector;
  readonly phases: PhaseLog[];
  readonly resets: number[];
  readonly ember: number[];
  readonly frost: number[];
  /** Sim steps run so far. */
  simSteps: number;
  tick: number;
  /** One host tick, the way the session does it. */
  step(ticks?: number): void;
  /** Steps until the director is in `phase` (throws after `max` ticks). */
  runTo(phase: MatchPhase, max?: number): void;
  dragon(id: number): DragonState;
  alive(id: number): boolean;
  /** `killer` takes `victim` down; credited on the next tick. */
  kill(victim: number, killer: number): void;
}

interface RigOptions {
  settings?: Partial<HostSettings>;
  ember?: number;
  frost?: number;
  solo?: boolean;
  modeTuning?: ModeTuning;
  matchTuning?: Partial<MatchTuning>;
  arena?: MatchArena | null;
  countdown?: number;
}

function makeMatch(options: RigOptions = {}): MatchRig {
  const matchTuning: MatchTuning = {
    ...MATCH_TUNING,
    respawnDelayS: 1,
    spawnProtectionS: 0.5,
    ...options.matchTuning,
  };
  const modeTuning = options.modeTuning ?? testModeTuning();
  const phases: PhaseLog[] = [];
  const resets: number[] = [];
  const director: MatchDirector = new MatchDirector({
    modeTuning,
    matchTuning,
    listener: {
      onPhase: (phase, tick, round, winner) => void phases.push({ phase, tick, round, winner }),
      onRoundReset: (round) => void resets.push(round),
    },
  });
  const sim = createSim({ matchTuning, events: { emit: (event) => director.onEvent(event) } });
  const settings: HostSettings = { ...DEFAULT_HOST_SETTINGS, ...options.settings };
  const config = createModeConfig(settings, options.solo === true, matchTuning, modeTuning);
  director.begin(sim, config, options.arena ?? null, 1, options.countdown ?? COUNTDOWN);

  const inputs: InputFrame[] = [];
  const ember: number[] = [];
  const frost: number[] = [];
  const add = (id: number, team: TeamId, index: number): void => {
    const side = team === TEAM_EMBER ? -1 : 1;
    sim.spawnDragon(
      id,
      team,
      'tempest',
      { x: (index - 1) * 40, y: 300 + index * 20, z: side * 300 },
      team === TEAM_EMBER ? 0 : Math.PI,
    );
    inputs[id] = createInputFrame();
    director.addRider(id, team);
    (team === TEAM_EMBER ? ember : frost).push(id);
  };
  for (let i = 0; i < (options.ember ?? 1); i++) add(i, TEAM_EMBER, i);
  for (let i = 0; i < (options.frost ?? (options.solo === true ? 0 : 1)); i++) {
    add(10 + i, TEAM_FROST, i);
  }

  const rig: MatchRig = {
    sim,
    director,
    phases,
    resets,
    ember,
    frost,
    simSteps: 0,
    tick: 0,
    step(ticks = 1) {
      for (let i = 0; i < ticks; i++) {
        const tick = ++rig.tick;
        director.beforeStep(tick, sim);
        if (director.finished) return;
        if (director.simRuns) {
          for (const input of inputs) if (input !== undefined) input.tick = tick;
          sim.step(tick, inputs);
          rig.simSteps++;
          director.afterStep(tick, sim);
        }
      }
    },
    runTo(phase, max = 20_000) {
      for (let i = 0; i < max; i++) {
        if (director.phase === phase) return;
        rig.step();
      }
      throw new Error(`never reached ${phase} (stuck in ${director.phase})`);
    },
    dragon(id) {
      const dragon = sim.getDragon(id);
      if (dragon === undefined) throw new Error(`player ${id} has no dragon`);
      return dragon;
    },
    alive(id) {
      return (rig.dragon(id).flags & DRAGON_FLAG_ALIVE) !== 0;
    },
    kill(victim, killer) {
      const removed = sim.applyDamage(victim, 1e6, killer, 'primary', DAMAGE_IGNORE_IMMUNITY);
      if (!(removed > 0)) throw new Error(`could not hurt ${victim}`);
    },
  };
  return rig;
}

function skirmish(scoreLimit: number, timeLimitS = 0, extra: RigOptions = {}): MatchRig {
  return makeMatch({
    ...extra,
    settings: { mode: 'skirmish', teamSize: 2, scoreLimit, timeLimitS, ...extra.settings },
  });
}

function duel(extra: RigOptions = {}): MatchRig {
  return makeMatch({ ...extra, settings: { mode: 'duel', teamSize: 2, ...extra.settings } });
}

// --- Mode config -----------------------------------------------------------------------------------

describe('createModeConfig: lobby settings -> match rules', () => {
  it('passes valid Skirmish settings through', () => {
    const config = createModeConfig({
      ...DEFAULT_HOST_SETTINGS,
      mode: 'skirmish',
      teamSize: 3,
      scoreLimit: 12,
      timeLimitS: 300,
      friendlyFire: true,
      allowedClasses: ['wraith', 'talon'],
    });
    expect(config.mode).toBe('skirmish');
    expect(config.sandbox).toBe(false);
    expect(config.teamSize).toBe(3);
    expect(config.scoreLimit).toBe(12);
    expect(config.timeLimitS).toBe(300);
    expect(config.maxRounds).toBe(1);
    expect(config.respawns).toBe(true);
    expect(config.stormShrinks).toBe(false);
    expect(config.friendlyFire).toBe(true);
    // In the canonical class order, whatever order the lobby had them in.
    expect(config.allowedClasses).toEqual(['talon', 'wraith']);
    expect(isClassAllowed(config, 'wraith')).toBe(true);
    expect(isClassAllowed(config, 'bastion')).toBe(false);
  });

  it('makes a Duel best of five: three round wins, no respawns, a shrinking storm, 1-2 a side', () => {
    const config = createModeConfig({
      ...DEFAULT_HOST_SETTINGS,
      mode: 'duel',
      teamSize: 5,
      scoreLimit: 77,
      timeLimitS: 900,
    });
    expect(config.mode).toBe('duel');
    expect(config.teamSize).toBe(2);
    expect(config.scoreLimit).toBe(3);
    expect(roundsToWin(MATCH_TUNING.duelRounds)).toBe(3);
    expect(config.timeLimitS).toBe(MODE_TUNING.duel.roundTimeS);
    expect(config.maxRounds).toBe(MODE_TUNING.duel.maxRounds);
    expect(config.respawns).toBe(false);
    expect(config.stormShrinks).toBe(true);
  });

  it('forces broken values into range instead of starting a broken match', () => {
    const limits = HOST_SETTING_LIMITS;
    const broken = createModeConfig({
      ...DEFAULT_HOST_SETTINGS,
      mode: 'emberRelay',
      teamSize: 99,
      scoreLimit: Number.NaN,
      timeLimitS: 5,
      allowedClasses: [],
      // Cast: what a corrupted settings object could hold.
      friendlyFire: 'yes' as unknown as boolean,
    });
    // A mode without rules yet falls back to Skirmish.
    expect(broken.mode).toBe('skirmish');
    expect(broken.teamSize).toBe(5);
    expect(broken.scoreLimit).toBe(DEFAULT_HOST_SETTINGS.scoreLimit);
    expect(broken.timeLimitS).toBe(limits.timeLimitMinS);
    expect(broken.allowedClasses).toEqual(DRAGON_CLASS_IDS);
    expect(broken.friendlyFire).toBe(false);

    const huge = createModeConfig({
      ...DEFAULT_HOST_SETTINGS,
      teamSize: -3,
      scoreLimit: 1e9,
      timeLimitS: 1e9,
    });
    expect(huge.teamSize).toBe(1);
    expect(huge.scoreLimit).toBe(limits.scoreLimitMax);
    expect(huge.timeLimitS).toBe(limits.timeLimitMaxS);
    expect(createModeConfig({ ...DEFAULT_HOST_SETTINGS, timeLimitS: 0 }).timeLimitS).toBe(0);
    expect(roundsToWin(1)).toBe(1);
    expect(roundsToWin(7)).toBe(4);
    expect(roundsToWin(Number.NaN)).toBe(1);
  });

  it('a solo room is a sandbox: respawns, no storm schedule', () => {
    const config = createModeConfig({ ...DEFAULT_HOST_SETTINGS, mode: 'duel' }, true);
    expect(config.sandbox).toBe(true);
    expect(config.respawns).toBe(true);
    expect(config.stormShrinks).toBe(false);
  });
});

// --- Timeline --------------------------------------------------------------------------------------

describe('phase timeline', () => {
  it('holds the sim for the countdown, then hands over control on the exact tick', () => {
    const match = skirmish(2);
    const { director } = match;
    expect(director.phase).toBe('countdown');
    expect(director.phaseStartTick).toBe(1);
    expect(director.liveTick).toBe(1 + COUNTDOWN);
    expect(director.simRuns).toBe(false);
    const startZ = match.dragon(0).position.z;

    match.step(COUNTDOWN);
    // Ticks 1..90 were countdown: nothing moved, nobody could act.
    expect(match.tick).toBe(COUNTDOWN);
    expect(director.phase).toBe('countdown');
    expect(match.simSteps).toBe(0);
    expect(match.dragon(0).position.z).toBe(startZ);
    expect(match.phases).toHaveLength(0);

    match.step();
    expect(director.phase).toBe('playing');
    expect(director.phaseStartTick).toBe(1 + COUNTDOWN);
    expect(director.liveTick).toBe(-1);
    expect(match.simSteps).toBe(1);
    expect(match.dragon(0).position.z).toBeGreaterThan(startZ);
    expect(match.phases).toEqual([
      { phase: 'playing', tick: 1 + COUNTDOWN, round: 1, winner: null },
    ]);
  });

  it('runs playing -> roundEnd -> results -> lobby on the tuned durations', () => {
    const match = skirmish(1);
    match.runTo('playing');
    match.step(10);
    match.kill(10, 0);
    match.step();
    // Decided on this tick; `roundEnd` starts on the next.
    const decided = match.tick;
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.phaseStartTick).toBe(decided + 1);
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.matchOver).toBe(true);

    match.step(ROUND_END);
    expect(match.director.phase).toBe('roundEnd');
    match.step();
    expect(match.director.phase).toBe('results');
    expect(match.director.phaseStartTick).toBe(decided + 1 + ROUND_END);
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.simRuns).toBe(true);

    match.step(RESULTS - 1);
    expect(match.director.phase).toBe('results');
    expect(match.director.finished).toBe(false);
    match.step();
    expect(match.director.finished).toBe(true);
    expect(match.director.phase).toBe('lobby');
    expect(match.director.simRuns).toBe(false);

    expect(match.phases.map((entry) => [entry.phase, entry.tick, entry.winner])).toEqual([
      ['playing', 1 + COUNTDOWN, null],
      ['roundEnd', decided + 1, TEAM_EMBER],
      ['results', decided + 1 + ROUND_END, TEAM_EMBER],
    ]);
    // Finished stays finished.
    const steps = match.simSteps;
    match.step(50);
    expect(match.simSteps).toBe(steps);
  });

  it('a countdown of zero ticks starts play at once', () => {
    const match = skirmish(1, 0, { countdown: 0 });
    match.step();
    expect(match.director.phase).toBe('playing');
    expect(match.simSteps).toBe(1);
  });
});

// --- Skirmish --------------------------------------------------------------------------------------

describe('Skirmish', () => {
  it('sets the rules on the sim: respawns on, friendly fire from the lobby, the map storm', () => {
    const match = skirmish(5, 0, { settings: { friendlyFire: true } });
    expect(match.sim.respawnPolicy.enabled).toBe(true);
    expect(match.sim.rules.friendlyFire).toBe(true);
    expect(match.sim.current.stormRadius).toBe(-1);
    expect(match.director.timeRemainingS).toBe(Infinity);
  });

  it('is won by the first team to the score limit, with respawns in between', () => {
    const match = skirmish(3, 0, { ember: 2, frost: 2 });
    match.runTo('playing');
    match.kill(10, 0);
    match.step();
    expect(match.director.scores).toEqual([1, 0]);
    expect(match.alive(10)).toBe(false);

    // Back at the gate after the respawn delay, protected.
    match.step(TICK_HZ + 1);
    expect(match.alive(10)).toBe(true);
    expect(match.dragon(10).flags & DRAGON_FLAG_SPAWN_PROTECTED).not.toBe(0);
    expect(match.dragon(10).health).toBe(match.dragon(10).maxHealth);

    match.kill(1, 11);
    match.step();
    expect(match.director.scores).toEqual([1, 1]);
    match.kill(11, 0);
    match.step();
    expect(match.director.scores).toEqual([2, 1]);
    expect(match.director.phase).toBe('playing');
    match.kill(10, 0);
    match.step();
    expect(match.director.scores).toEqual([3, 1]);
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.endReason).toBe('scoreLimit');

    match.runTo('results');
    expect(match.director.matchWinner).toBe(TEAM_EMBER);
    // Whatever happens after the deciding takedown does not count.
    match.kill(0, 11);
    match.step(3);
    expect(match.director.scores).toEqual([3, 1]);
    expect(match.director.statsOf(11)?.takedowns).toBe(1);
  });

  it('counts only takedowns of an enemy (the environment scores for nobody)', () => {
    const match = skirmish(3);
    match.runTo('playing');
    match.sim.applyDamage(10, 1e6, NO_PLAYER, 'terrain', DAMAGE_IGNORE_IMMUNITY);
    match.step(2);
    expect(match.director.scores).toEqual([0, 0]);
    expect(match.director.statsOf(10)?.deaths).toBe(1);
  });

  it('goes to the higher score when the time limit runs out', () => {
    const match = skirmish(50, 60);
    expect(match.director.timeRemainingS).toBe(60);
    match.runTo('playing');
    match.step();
    // Two ticks played (the one that started `playing` and this one).
    expect(match.director.timeRemainingS).toBeCloseTo(60 - 2 * TICK_DT_S, 9);
    match.kill(0, 10);
    match.step(100);
    expect(match.director.scores).toEqual([0, 1]);

    const live = match.director.roundTicks;
    match.step(60 * TICK_HZ - live - 1);
    expect(match.director.phase).toBe('playing');
    expect(match.director.timeRemainingS).toBeCloseTo(TICK_DT_S, 9);
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe(TEAM_FROST);
    expect(match.director.endReason).toBe('timeLimit');
    expect(match.director.roundTicks).toBe(60 * TICK_HZ);
  });

  it('level at the time limit: sudden death, the next takedown wins', () => {
    const match = skirmish(50, 60);
    match.runTo('playing');
    match.kill(0, 10);
    match.step(40);
    match.kill(10, 0);
    match.step(60 * TICK_HZ - match.director.roundTicks);
    expect(match.director.scores).toEqual([1, 1]);
    expect(match.director.phase).toBe('playing');
    expect(match.director.overtime).toBe(true);
    // The clock now counts the overtime down.
    expect(match.director.timeRemainingS).toBeCloseTo(5, 9);
    expect(isOvertime('playing', 60 + TICK_DT_S, 'skirmish', 60)).toBe(true);
    expect(isOvertime('playing', 59, 'skirmish', 60)).toBe(false);
    expect(isOvertime('playing', 500, 'skirmish', 0)).toBe(false);

    match.step(30);
    expect(match.director.timeRemainingS).toBeCloseTo(4, 9);
    match.kill(10, 0);
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.endReason).toBe('suddenDeath');
    expect(match.director.overtime).toBe(false);
  });

  it('still level when sudden death runs out: a draw', () => {
    const match = skirmish(50, 60);
    match.runTo('playing');
    match.step(65 * TICK_HZ - match.director.roundTicks - 1);
    expect(match.director.phase).toBe('playing');
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe('draw');
    match.runTo('results');
    expect(match.director.matchWinner).toBe('draw');
    expect(match.phases.at(-1)).toMatchObject({ phase: 'results', winner: 'draw' });
  });

  it('with no overtime tuned, level at the limit is a draw at once', () => {
    const match = skirmish(50, 60, {
      modeTuning: testModeTuning({ skirmish: { overtimeS: 0 } }),
    });
    match.runTo('playing');
    match.step(60 * TICK_HZ - match.director.roundTicks - 1);
    expect(match.director.phase).toBe('playing');
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe('draw');
  });

  it('both teams passing the limit on one tick play on until one leads', () => {
    const match = skirmish(1);
    match.runTo('playing');
    match.kill(10, 0);
    match.kill(0, 10);
    match.step();
    expect(match.director.scores).toEqual([1, 1]);
    expect(match.director.phase).toBe('playing');
    match.step(TICK_HZ + 2);
    match.kill(10, 0);
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe(TEAM_EMBER);
  });

  it('a solo sandbox never ends and has no clock', () => {
    const match = makeMatch({ solo: true, settings: { scoreLimit: 1, timeLimitS: 60 } });
    match.runTo('playing');
    match.step(70 * TICK_HZ);
    expect(match.director.phase).toBe('playing');
    expect(match.director.timeRemainingS).toBe(Infinity);
    expect(match.director.finished).toBe(false);
  });
});

// --- Duel ------------------------------------------------------------------------------------------

describe('Duel', () => {
  it('sets the rules on the sim: no respawns', () => {
    const match = duel();
    expect(match.sim.respawnPolicy.enabled).toBe(false);
    expect(match.director.timeRemainingS).toBe(20);
    expect(match.director.config.scoreLimit).toBe(3);
  });

  it('plays rounds until a team has three, resetting everyone in between', () => {
    const match = duel();
    const homeZ = match.dragon(10).position.z;
    const rounds: MatchWinner[] = [];
    // Frost takes round 2, Ember the rest: 3-1 after four rounds.
    const script: [victim: number, killer: number][] = [
      [10, 0],
      [0, 10],
      [10, 0],
      [10, 0],
    ];
    for (let round = 1; round <= script.length; round++) {
      match.runTo('playing');
      expect(match.director.round).toBe(round);
      // Everyone starts a round alive, at full health, at the gate.
      for (const id of [0, 10]) {
        expect(match.alive(id)).toBe(true);
        expect(match.dragon(id).health).toBe(match.dragon(id).maxHealth);
      }
      match.step(20);
      const [victim, killer] = script[round - 1] as [number, number];
      match.kill(victim, killer);
      match.step();
      expect(match.director.phase).toBe('roundEnd');
      expect(match.director.endReason === 'elimination' || match.director.matchOver).toBe(true);
      rounds.push(match.director.winner as MatchWinner);
      if (round < script.length) {
        expect(match.director.matchOver).toBe(false);
        match.runTo('countdown');
        // Held at the gate for the countdown: the sim does not step.
        const steps = match.simSteps;
        expect(match.dragon(10).position.z).toBe(homeZ);
        match.step(COUNTDOWN - 1);
        expect(match.director.phase).toBe('countdown');
        expect(match.simSteps).toBe(steps);
      }
    }
    expect(rounds).toEqual([TEAM_EMBER, TEAM_FROST, TEAM_EMBER, TEAM_EMBER]);
    expect(match.director.scores).toEqual([3, 1]);
    expect(match.director.matchOver).toBe(true);
    expect(match.director.matchWinner).toBe(TEAM_EMBER);
    expect(match.director.endReason).toBe('roundsWon');
    expect(match.resets).toEqual([2, 3, 4]);

    match.runTo('results');
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.round).toBe(4);
    match.runTo('lobby');
    expect(match.director.finished).toBe(true);
    // The whole timeline, in order.
    expect(match.phases.map((entry) => `${entry.phase}${entry.round}`)).toEqual([
      'playing1',
      'roundEnd1',
      'countdown2',
      'playing2',
      'roundEnd2',
      'countdown3',
      'playing3',
      'roundEnd3',
      'countdown4',
      'playing4',
      'roundEnd4',
      'results4',
    ]);
    expect(match.director.statsOf(0)).toMatchObject({ takedowns: 3, deaths: 1 });
    expect(match.director.statsOf(10)).toMatchObject({ takedowns: 1, deaths: 3 });
  });

  it('three straight rounds end it 3-0', () => {
    const match = duel();
    for (let round = 0; round < 3; round++) {
      match.runTo('playing');
      match.kill(0, 10);
      match.step();
    }
    expect(match.director.scores).toEqual([0, 3]);
    expect(match.director.matchWinner).toBe(TEAM_FROST);
    expect(match.director.round).toBe(3);
  });

  it('has no respawns inside a round, and the round ends when a team is eliminated', () => {
    const match = duel({ ember: 2, frost: 2 });
    match.runTo('playing');
    match.kill(10, 0);
    // Far longer than the respawn delay (1 s in this rig).
    match.step(5 * TICK_HZ);
    expect(match.alive(10)).toBe(false);
    expect(match.director.phase).toBe('playing');
    expect(match.director.scores).toEqual([0, 0]);

    match.kill(11, 1);
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.endReason).toBe('elimination');
    expect(match.director.scores).toEqual([1, 0]);
    // Still down during the beat after the round.
    expect(match.alive(10)).toBe(false);
  });

  it('between rounds: full health, effects cleared, ultimate charge kept', () => {
    const match = duel({ ember: 2, frost: 2 });
    match.runTo('playing');
    match.dragon(0).ultCharge = 0.6;
    match.sim.applyDamage(1, 30, 10, 'primary', DAMAGE_IGNORE_IMMUNITY);
    match.sim.applyStatus(1, 'burn', 20, 1, 10);
    match.kill(10, 0);
    match.kill(11, 0);
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    const charge = match.dragon(0).ultCharge;
    expect(charge).toBeGreaterThanOrEqual(0.6);

    match.runTo('countdown');
    for (const id of [0, 1, 10, 11]) {
      const dragon = match.dragon(id);
      expect(match.alive(id)).toBe(true);
      expect(dragon.health).toBe(dragon.maxHealth);
      expect(dragon.burnTicks).toBe(0);
      expect(dragon.position.x).toBe(dragon.home.x);
      expect(dragon.position.z).toBe(dragon.home.z);
    }
    expect(match.dragon(0).ultCharge).toBe(charge);
    expect(match.sim.current.projectileCount).toBe(0);
    expect(match.sim.current.zoneCount).toBe(0);
    expect(match.director.round).toBe(2);
    expect(match.director.timeRemainingS).toBe(20);
  });

  it('both teams down on the same tick: a drawn round, replayed with no point', () => {
    const match = duel();
    match.runTo('playing');
    match.kill(10, 0);
    match.kill(0, 10);
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe('draw');
    expect(match.director.scores).toEqual([0, 0]);
    expect(match.director.matchOver).toBe(false);
    match.runTo('playing');
    expect(match.director.round).toBe(2);
  });

  it('a round that times out goes to the team with more health left', () => {
    const match = duel({ ember: 2, frost: 2 });
    match.runTo('playing');
    expect(match.director.timeRemainingS).toBeCloseTo(20 - TICK_DT_S, 9);
    // Ember: one dragon at 60 %. Frost: one dead, one untouched: 50 % of the team.
    const hurt = match.dragon(0);
    match.sim.applyDamage(0, hurt.maxHealth * 0.4, 10, 'primary', DAMAGE_IGNORE_IMMUNITY);
    match.kill(11, 1);
    match.step(20 * TICK_HZ - match.director.roundTicks - 1);
    expect(match.director.phase).toBe('playing');
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.endReason).toBe('timeLimit');
    // (0.6 + 1) / 2 = 0.8 against (0 + 1) / 2 = 0.5.
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.scores).toEqual([1, 0]);
  });

  it('a timeout on equal health is a draw; the match ends after the round cap', () => {
    const match = duel({
      modeTuning: testModeTuning({
        duel: { ...testModeTuning().duel, roundTimeS: 2, maxRounds: 4 },
      }),
    });
    // Round 1 to Frost, then nobody touches anybody.
    match.runTo('playing');
    match.kill(0, 10);
    match.step();
    for (let round = 2; round <= 4; round++) {
      match.runTo('playing');
      expect(match.director.round).toBe(round);
      match.runTo('roundEnd');
      expect(match.director.winner).toBe('draw');
      expect(match.director.roundTicks).toBe(2 * TICK_HZ);
    }
    expect(match.director.matchOver).toBe(true);
    expect(match.director.endReason).toBe('maxRounds');
    expect(match.director.scores).toEqual([0, 1]);
    expect(match.director.matchWinner).toBe(TEAM_FROST);
    match.runTo('results');
    expect(match.director.winner).toBe(TEAM_FROST);
  });

  it('the round cap on level rounds is a drawn match', () => {
    const match = duel({
      modeTuning: testModeTuning({
        duel: { ...testModeTuning().duel, roundTimeS: 1, maxRounds: 3 },
      }),
    });
    match.runTo('results');
    expect(match.director.matchWinner).toBe('draw');
    expect(match.director.round).toBe(3);
  });
});

// --- Storm -----------------------------------------------------------------------------------------

describe('Duel storm schedule', () => {
  const tuning = testModeTuning().duel;
  const arena: MatchArena = { stormRadius: 1000, gateRadius: 300 };

  it('starts each round smaller, holds, then closes to the end radius', () => {
    const out = createStormRadii();
    expect(writeDuelStorm(out, tuning, arena, 1, 0)).toBe(true);
    expect(out).toEqual({ start: 1000, end: 150, radius: 1000 });
    // Held for 5 s.
    writeDuelStorm(out, tuning, arena, 1, 5 * TICK_HZ);
    expect(out.radius).toBe(1000);
    // Halfway through the 10 s of closing.
    writeDuelStorm(out, tuning, arena, 1, 10 * TICK_HZ);
    expect(out.radius).toBeCloseTo(575, 6);
    writeDuelStorm(out, tuning, arena, 1, 15 * TICK_HZ);
    expect(out.radius).toBeCloseTo(150, 6);
    writeDuelStorm(out, tuning, arena, 1, 500 * TICK_HZ);
    expect(out.radius).toBeCloseTo(150, 6);

    writeDuelStorm(out, tuning, arena, 2, 0);
    expect(out.radius).toBeCloseTo(800, 6);
    writeDuelStorm(out, tuning, arena, 3, 0);
    expect(out.radius).toBeCloseTo(600, 6);
    // Later rounds reuse the last entry; a silly round number does not break it.
    writeDuelStorm(out, tuning, arena, 9, 0);
    expect(out.radius).toBeCloseTo(600, 6);
    writeDuelStorm(out, tuning, arena, 0, 0);
    expect(out.radius).toBe(1000);
  });

  it('only ever closes within a round and never starts inside the gates', () => {
    const out = createStormRadii();
    let last = Infinity;
    for (let ticks = 0; ticks < 30 * TICK_HZ; ticks++) {
      writeDuelStorm(out, tuning, arena, 2, ticks);
      expect(out.radius).toBeLessThanOrEqual(last);
      last = out.radius;
    }
    // Gates 700 m out: a 600 m start would put every spawn in the storm.
    const wide: MatchArena = { stormRadius: 1000, gateRadius: 700 };
    writeDuelStorm(out, tuning, wide, 3, 0);
    expect(out.start).toBe(750);
    // ...but never beyond the map's own wall.
    writeDuelStorm(out, tuning, { stormRadius: 1000, gateRadius: 990 }, 3, 0);
    expect(out.start).toBe(1000);
    // The end radius respects the minimum, and a map without a wall is left alone.
    writeDuelStorm(out, tuning, { stormRadius: 400, gateRadius: 100 }, 1, 9999);
    expect(out.radius).toBe(120);
    expect(writeDuelStorm(out, tuning, { stormRadius: -1, gateRadius: 0 }, 1, 0)).toBe(false);
  });

  it('survives broken tuning', () => {
    const out = createStormRadii();
    const broken = {
      ...tuning,
      stormRoundFractions: [Number.NaN, 7],
      stormShrinkS: 0,
      stormEndFraction: Number.NaN,
    };
    writeDuelStorm(out, broken, arena, 1, 0);
    expect(out.radius).toBe(1000);
    writeDuelStorm(out, broken, arena, 2, 6 * TICK_HZ);
    expect(out.radius).toBe(120);
    writeDuelStorm(out, { ...tuning, stormRoundFractions: [] }, arena, 1, 0);
    expect(out.radius).toBe(1000);
  });

  it('the director moves the sim wall along the schedule, round by round', () => {
    const match = duel({ arena });
    expect(match.sim.current.stormRadius).toBe(1000);
    match.runTo('playing');
    match.step(5 * TICK_HZ - 1);
    expect(match.sim.current.stormRadius).toBe(1000);
    match.step(5 * TICK_HZ);
    const mid = match.sim.current.stormRadius;
    expect(mid).toBeLessThan(600);
    expect(mid).toBeGreaterThan(540);
    expect(match.director.stormRadius).toBe(mid);
    match.step(6 * TICK_HZ);
    expect(match.sim.current.stormRadius).toBeCloseTo(150, 6);

    match.kill(10, 0);
    match.step();
    match.runTo('countdown');
    expect(match.sim.current.stormRadius).toBeCloseTo(800, 6);
    match.runTo('playing');
    match.kill(10, 0);
    match.step();
    match.runTo('countdown');
    expect(match.sim.current.stormRadius).toBeCloseTo(600, 6);
  });

  it('Skirmish leaves the map storm alone', () => {
    const match = skirmish(3, 0, { arena });
    match.runTo('playing');
    match.step(20 * TICK_HZ);
    expect(match.sim.current.stormRadius).toBe(-1);
    expect(match.director.stormRadius).toBe(-1);
  });
});

// --- Disconnects -----------------------------------------------------------------------------------

describe('forfeits', () => {
  const GRACE = 2 * TICK_HZ;

  it('Duel: a team with nobody connected for the grace gives up the round', () => {
    const match = duel({ ember: 2, frost: 2 });
    match.runTo('playing');
    match.director.setRiderConnected(10, false);
    match.step(GRACE + 10);
    // One of two is still there: nothing happens.
    expect(match.director.phase).toBe('playing');
    match.director.setRiderConnected(11, false);
    match.step(GRACE - 1);
    expect(match.director.phase).toBe('playing');
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.endReason).toBe('forfeit');
    expect(match.director.scores).toEqual([1, 0]);
    expect(match.director.matchOver).toBe(false);
  });

  it('a reconnect inside the grace cancels the forfeit', () => {
    const match = duel();
    match.runTo('playing');
    match.director.setRiderConnected(10, false);
    match.step(GRACE - 1);
    match.director.setRiderConnected(10, true);
    match.step(GRACE * 2);
    expect(match.director.phase).toBe('playing');
    // The count starts again from zero.
    match.director.setRiderConnected(10, false);
    match.step(GRACE - 1);
    expect(match.director.phase).toBe('playing');
  });

  it('Skirmish: the absent team forfeits the match', () => {
    const match = skirmish(30, 0, { ember: 2, frost: 1 });
    match.runTo('playing');
    match.kill(0, 10);
    match.step();
    match.director.setRiderConnected(10, false);
    match.step(GRACE);
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe(TEAM_EMBER);
    expect(match.director.endReason).toBe('forfeit');
    match.runTo('results');
    // The score says Frost led; the forfeit decides.
    expect(match.director.scores).toEqual([0, 1]);
    expect(match.director.matchWinner).toBe(TEAM_EMBER);
  });

  it('a side with no riders left ends the match at once, in any phase', () => {
    const playing = duel();
    playing.runTo('playing');
    playing.step(10);
    expect(playing.director.removeRider(10)).toBe(true);
    expect(playing.director.removeRider(10)).toBe(false);
    playing.step();
    expect(playing.director.phase).toBe('results');
    expect(playing.director.winner).toBe(TEAM_EMBER);
    expect(playing.director.endReason).toBe('forfeit');
    // The row is kept for the results screen.
    expect(playing.director.statsOf(10)).toMatchObject({ playerId: 10, present: false });
    playing.runTo('lobby');
    expect(playing.director.finished).toBe(true);

    const counting = duel();
    counting.step(5);
    counting.director.removeRider(0);
    counting.step();
    expect(counting.director.phase).toBe('results');
    expect(counting.director.winner).toBe(TEAM_FROST);

    const between = duel();
    between.runTo('playing');
    between.kill(10, 0);
    between.step();
    expect(between.director.phase).toBe('roundEnd');
    between.director.removeRider(10);
    between.step();
    expect(between.director.phase).toBe('results');
    expect(between.director.matchWinner).toBe(TEAM_EMBER);
  });

  it('one of two leaving does not end a 2v2', () => {
    const match = duel({ ember: 2, frost: 2 });
    match.runTo('playing');
    match.director.removeRider(11);
    match.sim.despawnDragon(11);
    match.step(GRACE * 2);
    expect(match.director.phase).toBe('playing');
    // The one that is left is the whole team now.
    match.kill(10, 0);
    match.step();
    expect(match.director.phase).toBe('roundEnd');
    expect(match.director.winner).toBe(TEAM_EMBER);
  });

  it('a sandbox has no forfeits', () => {
    const match = makeMatch({ solo: true });
    match.runTo('playing');
    match.director.setRiderConnected(0, false);
    match.step(GRACE * 3);
    expect(match.director.phase).toBe('playing');
  });
});

// --- Stats -----------------------------------------------------------------------------------------

describe('per-rider stats', () => {
  it('tracks takedowns, deaths, assists and damage', () => {
    const match = skirmish(30, 0, { ember: 2, frost: 2 });
    match.runTo('playing');
    expect(match.director.statsCount).toBe(4);
    expect(match.director.stats.slice(0, 4).map((row) => [row.playerId, row.team])).toEqual([
      [0, TEAM_EMBER],
      [1, TEAM_EMBER],
      [10, TEAM_FROST],
      [11, TEAM_FROST],
    ]);
    const maxHp = match.dragon(10).maxHealth;
    match.sim.applyDamage(10, 40, 1, 'primary', DAMAGE_IGNORE_IMMUNITY);
    match.step();
    match.kill(10, 0);
    match.step();
    expect(match.director.statsOf(0)).toMatchObject({ takedowns: 1, deaths: 0, assists: 0 });
    expect(match.director.statsOf(0)?.damage).toBeCloseTo(maxHp - 40, 6);
    expect(match.director.statsOf(1)).toMatchObject({ takedowns: 0, assists: 1 });
    expect(match.director.statsOf(1)?.damage).toBeCloseTo(40, 6);
    expect(match.director.statsOf(10)).toMatchObject({ deaths: 1, takedowns: 0, present: true });
    expect(match.director.statsOf(99)).toBeNull();
  });

  it('credits healing to whoever gave the regen, and never counts a respawn as healing', () => {
    const match = skirmish(30, 0, { ember: 2, frost: 1 });
    match.runTo('playing');
    match.sim.applyDamage(0, 60, 10, 'primary', DAMAGE_IGNORE_IMMUNITY);
    match.step();
    match.sim.applyStatus(0, 'regen', 3, 10, 1);
    const before = match.dragon(0).health;
    match.step(4 * TICK_HZ);
    const healed = match.dragon(0).health - before;
    expect(healed).toBeGreaterThan(20);
    expect(healed).toBeLessThanOrEqual(35);
    expect(match.director.statsOf(1)?.healing).toBeCloseTo(healed, 6);
    expect(match.director.statsOf(0)?.healing).toBe(0);

    // Dying and coming back at full health heals nobody.
    match.kill(0, 10);
    match.step(2 * TICK_HZ);
    expect(match.alive(0)).toBe(true);
    expect(match.director.statsOf(1)?.healing).toBeCloseTo(healed, 6);
    expect(match.director.statsOf(0)?.healing).toBe(0);
  });

  it('does not count the full health of a new round as healing', () => {
    const match = duel({ ember: 2, frost: 1 });
    match.runTo('playing');
    match.sim.applyDamage(0, 50, 10, 'primary', DAMAGE_IGNORE_IMMUNITY);
    match.sim.applyStatus(0, 'regen', 60, 0.001, 1);
    match.step(5);
    match.kill(10, 0);
    match.step();
    match.runTo('playing');
    match.step(5);
    expect(match.director.statsOf(1)?.healing).toBeLessThan(1);
  });
});

// --- Determinism -----------------------------------------------------------------------------------

describe('determinism', () => {
  function play(): string {
    const match = duel({ ember: 2, frost: 2, arena: { stormRadius: 1000, gateRadius: 300 } });
    const log: unknown[] = [];
    for (let i = 0; i < 4000 && !match.director.finished; i++) {
      // A scripted fight: who goes down depends only on the tick.
      if (match.director.phase === 'playing') {
        const live = match.director.roundTicks;
        const round = match.director.round;
        if (live === 40) match.sim.applyDamage(0, 35, 10, 'primary', DAMAGE_IGNORE_IMMUNITY);
        if (live === 70 && round % 2 === 1) match.kill(10, 0);
        if (live === 90 && round % 2 === 1) match.kill(11, 1);
        if (live === 80 && round % 2 === 0) match.kill(0, 11);
        if (live === 120 && round % 2 === 0) match.kill(1, 10);
        if (live === 60) match.director.setRiderConnected(11, round !== 3);
      }
      match.step();
      if (i % 50 === 0) {
        log.push([
          match.director.phase,
          match.director.round,
          match.director.scores.slice(),
          match.director.timeRemainingS,
          match.sim.current.stormRadius,
        ]);
      }
    }
    return JSON.stringify({
      log,
      phases: match.phases,
      stats: match.director.stats.slice(0, match.director.statsCount),
      winner: match.director.matchWinner,
      dragons: match.sim.current.dragons.map((dragon) => [dragon.position, dragon.health]),
    });
  }

  it('the same script gives the same match, to the bit', () => {
    const first = play();
    expect(play()).toBe(first);
    const parsed = JSON.parse(first) as { winner: MatchWinner | null; phases: PhaseLog[] };
    // And it is a real match: it was decided and reached the results.
    expect(parsed.winner).not.toBeNull();
    expect(parsed.phases.at(-1)?.phase).toBe('results');
  });
});

// --- Cost ------------------------------------------------------------------------------------------

describe('per-tick cost', () => {
  it('the director and lag compensation add no garbage to a tick', () => {
    // The sim is not stepped here: its own cost is measured in combat.test.ts. What runs is
    // exactly what the session adds per tick for a 5v5 (Duel rules, so the storm moves too).
    const tuning = testModeTuning({
      duel: { ...testModeTuning().duel, roundTimeS: 0, stormHoldS: 0, stormShrinkS: 1e6 },
    });
    const match = makeMatch({
      settings: { mode: 'duel', teamSize: 2 },
      ember: 5,
      frost: 5,
      modeTuning: tuning,
      matchTuning: { spawnProtectionS: 0 },
      arena: { stormRadius: 1000, gateRadius: 300 },
      countdown: 0,
    });
    const comp = new LagCompensator();
    match.sim.setTargetPositions(comp);
    match.step(5);
    const ids = [...match.ember, ...match.frost];
    for (const id of ids) comp.setRewindTicks(id, 4.5);
    const out = { x: 0, y: 0, z: 0 };
    const state = match.sim.current;
    const run = (ticks: number): void => {
      for (let i = 0; i < ticks; i++) {
        const tick = ++match.tick;
        match.director.beforeStep(tick, match.sim);
        // Cast: the sim is not stepped here, so the test moves its tick by hand.
        (state as { tick: number }).tick = tick;
        comp.observeLatency(ids[i % ids.length] ?? 0, 3 + (i & 1));
        // Every dragon shoots at every other one: 90 samples a tick, far more than a fight has.
        for (let d = 0; d < state.dragons.length; d++) {
          const dragon = state.dragons[d];
          if (dragon === undefined || !dragon.active) continue;
          for (let s = 0; s < ids.length; s++) {
            const id = ids[s] ?? 0;
            if (id !== dragon.id) comp.sample(id, dragon, tick, out);
          }
        }
        comp.record(state);
        match.director.afterStep(tick, match.sim);
      }
    };
    run(20_000);
    expect(match.director.phase).toBe('playing');
    let least = Infinity;
    for (let trial = 0; trial < 8; trial++) {
      const before = process.memoryUsage().heapUsed;
      run(2000);
      const grown = process.memoryUsage().heapUsed - before;
      if (grown >= 0 && grown < least) least = grown;
    }
    const start = performance.now();
    run(20_000);
    const usPerTick = ((performance.now() - start) * 1000) / 20_000;
    console.log(
      `[match] director + lag comp, 10 riders: ${usPerTick.toFixed(2)} us/tick, ` +
        `${(least / 2000).toFixed(1)} B garbage per tick`,
    );
    expect(comp.rewoundCount).toBeGreaterThan(0);
    // The wall really moved every tick.
    expect(match.director.stormRadius).toBeLessThan(1000);
    if (Number.isFinite(least)) expect(least / 2000).toBeLessThan(64);
    expect(usPerTick).toBeLessThan(100);
  }, 60_000);
});
