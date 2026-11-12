/**
 * Ember Relay (T-6.3): where the stands and braziers go on any map, the shard rules (take,
 * carry, capture, drop, return, time out), what the carrier pays, how the match is won, and the
 * lobby's limits for the mode. The director is driven the way the host session drives it,
 * around a real `Sim`; riders are put where the test needs them and then fly on by themselves.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_SLOWED,
  DRAGON_FLAG_VEILED,
  MAPS,
  MATCH_TUNING,
  MODES,
  MODE_TUNING,
  NO_PLAYER,
  SHARD_CARRIED,
  SHARD_DROPPED,
  SHARD_HOME,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
  createArenaMap,
  createInputFrame,
  defaultSeedOfMap,
  spawnGatesForMode,
} from '../../src/shared';
import type {
  EmberRelayTuning,
  HostSettings,
  InputFrame,
  MapId,
  MatchPhase,
  MatchTuning,
  MatchWinner,
  ModeTuning,
  MutableVec3,
  ObjectiveEvent,
  TeamId,
  Vec3,
} from '../../src/shared';
import {
  DAMAGE_IGNORE_IMMUNITY,
  copySimState,
  createMapCollisionWorld,
  createSim,
  createSimState,
} from '../../src/sim';
import type { DragonState, RelayShardState, Sim } from '../../src/sim';
import { createLobby, setMode, setScoreLimit, setTeamSize, validateHostSettings } from '../../src/sim/lobby';
import {
  MatchDirector,
  capturesOf,
  createModeConfig,
  relayTerrainOf,
  resolveScoreLimit,
  scoreLimitRule,
  settleInOpenAir,
  writeRelaySites,
} from '../../src/sim/match';
import type { RelayArena, RelayTerrain } from '../../src/sim/match';

const RELAY = MODE_TUNING.emberRelay;

// --- Rig -------------------------------------------------------------------------------------------

const COUNTDOWN = 1 * TICK_HZ;

function testModeTuning(relay: Partial<EmberRelayTuning> = {}): ModeTuning {
  return {
    ...MODE_TUNING,
    roundEndS: 1,
    resultsS: 1,
    emberRelay: { ...RELAY, overtimeS: 5, ...relay },
  };
}

interface PhaseLog {
  phase: MatchPhase;
  winner: MatchWinner | null;
}

interface RelayRig {
  readonly sim: Sim;
  readonly director: MatchDirector;
  readonly phases: PhaseLog[];
  readonly objectives: ObjectiveEvent[];
  readonly ember: number[];
  readonly frost: number[];
  tick: number;
  step(ticks?: number): void;
  runTo(phase: MatchPhase, max?: number): void;
  dragon(id: number): DragonState;
  /** Puts a rider on a spot; it flies on from there. */
  place(id: number, at: Readonly<Vec3>, dx?: number): void;
  kill(victim: number, killer?: number): void;
  /** Kinds of the objective events since the last call. */
  drain(): string[];
}

interface RigOptions {
  settings?: Partial<HostSettings>;
  perTeam?: number;
  relay?: Partial<EmberRelayTuning>;
  arena?: RelayArena | null;
}

function makeRelay(options: RigOptions = {}): RelayRig {
  const matchTuning: MatchTuning = { ...MATCH_TUNING, respawnDelayS: 1, spawnProtectionS: 0.5 };
  const modeTuning = testModeTuning(options.relay);
  const phases: PhaseLog[] = [];
  const objectives: ObjectiveEvent[] = [];
  const director = new MatchDirector({
    modeTuning,
    matchTuning,
    listener: {
      onPhase: (phase, _tick, _round, winner) => void phases.push({ phase, winner }),
      onRoundReset: () => undefined,
    },
  });
  const sim = createSim({
    matchTuning,
    events: {
      emit(event) {
        director.onEvent(event);
        if (event.type === 'objective') {
          objectives.push({ ...event, position: { ...event.position } });
        }
      },
    },
  });
  const settings: HostSettings = {
    ...DEFAULT_HOST_SETTINGS,
    mode: 'emberRelay',
    teamSize: 2,
    scoreLimit: 3,
    timeLimitS: 0,
    ...options.settings,
  };
  const config = createModeConfig(settings, false, matchTuning, modeTuning);
  director.begin(sim, config, null, 1, COUNTDOWN, 0, options.arena ?? null);

  const inputs: InputFrame[] = [];
  const ember: number[] = [];
  const frost: number[] = [];
  const perTeam = options.perTeam ?? 2;
  const add = (id: number, team: TeamId, index: number): void => {
    const side = team === TEAM_EMBER ? -1 : 1;
    // Far from every site, so nothing happens until the test places somebody.
    sim.spawnDragon(
      id,
      team,
      'tempest',
      { x: 600 + index * 40, y: 500, z: side * 100 },
      team === TEAM_EMBER ? 0 : Math.PI,
    );
    inputs[id] = createInputFrame();
    director.addRider(id, team);
    (team === TEAM_EMBER ? ember : frost).push(id);
  };
  for (let i = 0; i < perTeam; i++) add(i, TEAM_EMBER, i);
  for (let i = 0; i < perTeam; i++) add(10 + i, TEAM_FROST, i);

  let drained = 0;
  const rig: RelayRig = {
    sim,
    director,
    phases,
    objectives,
    ember,
    frost,
    tick: 0,
    step(ticks = 1) {
      for (let i = 0; i < ticks; i++) {
        const tick = ++rig.tick;
        director.beforeStep(tick, sim);
        if (director.finished) return;
        if (director.simRuns) {
          for (const input of inputs) if (input !== undefined) input.tick = tick;
          sim.step(tick, inputs);
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
    place(id, at, dx = 0) {
      const dragon = rig.dragon(id);
      dragon.position.x = at.x + dx;
      dragon.position.y = at.y;
      dragon.position.z = at.z;
    },
    kill(victim, killer = NO_PLAYER) {
      const removed = sim.applyDamage(victim, 1e6, killer, 'primary', DAMAGE_IGNORE_IMMUNITY);
      if (!(removed > 0)) throw new Error(`could not hurt ${victim}`);
    },
    drain() {
      const kinds = objectives.slice(drained).map((event) => event.kind);
      drained = objectives.length;
      return kinds;
    },
  };
  rig.runTo('playing');
  return rig;
}

function distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** A team's shard as it is now (the sim swaps its two state buffers every tick). */
function shardOf(rig: RelayRig, team: TeamId): RelayShardState {
  const shard = rig.sim.relay.shards[team];
  if (shard === undefined) throw new Error('no shard');
  return shard;
}

/** Ember rider 0 takes Frost's shard. */
function emberTakes(rig: RelayRig): void {
  const stand = rig.sim.relay.stands[TEAM_FROST];
  if (stand === undefined) throw new Error('no stand');
  rig.place(0, stand);
  rig.step();
  expect(shardOf(rig, TEAM_FROST).status).toBe(SHARD_CARRIED);
}

/** Ember rider 0, carrying, flies into its brazier. */
function emberScores(rig: RelayRig): void {
  emberTakes(rig);
  const brazier = rig.sim.relay.braziers[TEAM_EMBER];
  if (brazier === undefined) throw new Error('no brazier');
  rig.place(0, brazier);
  rig.step();
}

// --- Sites -----------------------------------------------------------------------------------------

function openArena(overrides: Partial<RelayArena> = {}): RelayArena {
  return {
    gates: [
      { x: 0, y: 300, z: -780 },
      { x: 0, y: 300, z: 780 },
    ],
    centerX: 0,
    centerZ: 0,
    radius: 1000,
    floorY: -4,
    ceilingY: 700,
    terrain: null,
    ...overrides,
  };
}

function sites(arena: RelayArena): { stands: MutableVec3[]; braziers: MutableVec3[] } {
  const zero = (): MutableVec3 => ({ x: 0, y: 0, z: 0 });
  const stands = [zero(), zero()];
  const braziers = [zero(), zero()];
  writeRelaySites(stands, braziers, arena, RELAY);
  return { stands, braziers };
}

describe('relay sites', () => {
  it('puts each stand and brazier in front of its gate, one to each side', () => {
    const { stands, braziers } = sites(openArena());
    // Ember launches from -Z toward +Z; its right hand is -X.
    expect(stands[TEAM_EMBER]).toEqual({
      x: -RELAY.standSideM,
      y: 300,
      z: -780 + RELAY.standForwardM,
    });
    expect(braziers[TEAM_EMBER]).toEqual({
      x: -RELAY.brazierSideM,
      y: 300,
      z: -780 + RELAY.brazierForwardM,
    });
    // The stand is the deeper of the two: a thief flies past the brazier's guns to get out.
    expect(RELAY.standForwardM).toBeGreaterThan(RELAY.brazierForwardM);
    expect(distance(stands[TEAM_EMBER] as Vec3, braziers[TEAM_EMBER] as Vec3)).toBeGreaterThan(
      RELAY.pickupRadiusM + RELAY.captureRadiusM,
    );
  });

  it('is a half turn of itself: neither team has the shorter run', () => {
    const { stands, braziers } = sites(openArena());
    for (const list of [stands, braziers]) {
      const ember = list[TEAM_EMBER] as Vec3;
      const frost = list[TEAM_FROST] as Vec3;
      expect(frost.x).toBeCloseTo(-ember.x, 9);
      expect(frost.z).toBeCloseTo(-ember.z, 9);
      expect(frost.y).toBe(ember.y);
    }
    const run = (team: TeamId): number =>
      distance(stands[team === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER] as Vec3, braziers[team] as Vec3);
    expect(run(TEAM_EMBER)).toBeCloseTo(run(TEAM_FROST), 9);
  });

  it('never crosses the centre on a small map, and survives a missing gate', () => {
    const small = sites(
      openArena({
        gates: [
          { x: 0, y: 300, z: -100 },
          { x: 0, y: 300, z: 100 },
        ],
      }),
    );
    expect((small.stands[TEAM_EMBER] as Vec3).z).toBeLessThan(0);
    expect((small.stands[TEAM_FROST] as Vec3).z).toBeGreaterThan(0);

    const broken = sites(openArena({ gates: [] }));
    expect(broken.stands[TEAM_EMBER]).toEqual({ x: 0, y: 348, z: 0 });
    expect(Number.isFinite((broken.braziers[TEAM_FROST] as Vec3).x)).toBe(true);
  });

  it('keeps sites inside the height band and the storm wall', () => {
    const { stands, braziers } = sites(
      openArena({
        gates: [
          { x: 0, y: 5, z: -995 },
          { x: 0, y: 900, z: 995 },
        ],
      }),
    );
    for (const site of [...stands, ...braziers]) {
      expect(site.y).toBeGreaterThanOrEqual(-4 + RELAY.minAltitudeM);
      expect(site.y).toBeLessThanOrEqual(700 - RELAY.ceilingMarginM);
      expect(Math.hypot(site.x, site.z)).toBeLessThanOrEqual(1000 - RELAY.stormMarginM + 1e-6);
    }
  });

  it('moves a site out of rock, and gives up only when nothing is open', () => {
    // A pillar of rock, 60 m across, right where Ember's stand wants to be.
    const wanted = sites(openArena()).stands[TEAM_EMBER] as Vec3;
    const pillar: RelayTerrain = {
      solidDepth: (x, _y, z) => 60 - Math.hypot(x - wanted.x, z - wanted.z),
      closestPoint: (x, _y, z, max) => {
        const gap = Math.hypot(x - wanted.x, z - wanted.z) - 60;
        return gap >= 0 && gap <= max ? gap : -1;
      },
    };
    const moved = sites(openArena({ terrain: pillar })).stands[TEAM_EMBER] as Vec3;
    expect(Math.hypot(moved.x - wanted.x, moved.z - wanted.z)).toBeGreaterThanOrEqual(
      60 + RELAY.siteClearanceM,
    );
    expect(distance(moved, wanted)).toBeLessThan(200);

    const solid: RelayTerrain = { solidDepth: () => 1, closestPoint: () => 0 };
    const arena = openArena({ terrain: solid });
    const point: MutableVec3 = { x: 10, y: -500, z: 10 };
    expect(settleInOpenAir(point, arena, RELAY, RELAY.dropClearanceM)).toBe(false);
    // With everything solid a site falls back to the gate.
    expect(sites(arena).stands[TEAM_EMBER]).toEqual({ x: 0, y: 300, z: -780 });
  });

  it('finds open air for every site on every map, for both teams alike', () => {
    for (const id of Object.keys(MAPS) as MapId[]) {
      const map = createArenaMap(id, defaultSeedOfMap(id));
      const collision = createMapCollisionWorld(map);
      const terrain = relayTerrainOf(collision);
      expect(terrain, id).not.toBeNull();
      if (terrain === null) continue;
      const gates = spawnGatesForMode(map, 'emberRelay');
      const arena: RelayArena = {
        gates: [TEAM_EMBER, TEAM_FROST].map((team) => gates[team]?.position ?? { x: 0, y: 0, z: 0 }),
        centerX: map.colliders.stormCenter.x,
        centerZ: map.colliders.stormCenter.z,
        radius: map.colliders.stormRadius,
        floorY: map.colliders.floorY,
        ceilingY: map.colliders.ceilingY,
        terrain,
      };
      const { stands, braziers } = sites(arena);
      for (const team of [TEAM_EMBER, TEAM_FROST]) {
        const stand = stands[team] as Vec3;
        const brazier = braziers[team] as Vec3;
        for (const site of [stand, brazier]) {
          expect(terrain.solidDepth(site.x, site.y, site.z), id).toBeLessThanOrEqual(0);
          expect(terrain.closestPoint(site.x, site.y, site.z, RELAY.siteClearanceM), id).toBe(-1);
          expect(site.y, id).toBeGreaterThanOrEqual(map.colliders.floorY + RELAY.minAltitudeM);
        }
        // Far enough apart that taking the shard and scoring are two different places.
        expect(distance(stand, brazier), id).toBeGreaterThan(
          RELAY.pickupRadiusM + RELAY.captureRadiusM,
        );
      }
      // A fair run: both teams fly about the same distance from the enemy stand to their brazier.
      const emberRun = distance(stands[TEAM_FROST] as Vec3, braziers[TEAM_EMBER] as Vec3);
      const frostRun = distance(stands[TEAM_EMBER] as Vec3, braziers[TEAM_FROST] as Vec3);
      expect(Math.abs(emberRun - frostRun), id).toBeLessThan(0.1 * emberRun);
    }
  });
});

// --- Shard rules -----------------------------------------------------------------------------------

describe('shard rules', () => {
  it('starts with both shards home on their stands, and stays inert in other modes', () => {
    const rig = makeRelay();
    const relay = rig.sim.relay;
    expect(relay.active).toBe(true);
    for (const team of [TEAM_EMBER, TEAM_FROST]) {
      expect(relay.shards[team]?.status).toBe(SHARD_HOME);
      expect(relay.shards[team]?.position).toEqual(relay.stands[team]);
      expect(relay.shards[team]?.carrierId).toBe(NO_PLAYER);
    }
    rig.step(60);
    expect(rig.objectives).toEqual([]);

    const director = new MatchDirector();
    const sim = createSim();
    director.begin(sim, createModeConfig({ ...DEFAULT_HOST_SETTINGS, mode: 'skirmish' }), null, 1, 30);
    expect(sim.relay.active).toBe(false);
  });

  it('an enemy flying through the shard takes it; its own team cannot', () => {
    const rig = makeRelay();
    const relay = rig.sim.relay;
    const stand = relay.stands[TEAM_FROST] as Vec3;
    // A Frost rider on its own shard: nothing.
    rig.place(10, stand);
    rig.step();
    expect(shardOf(rig, TEAM_FROST).status).toBe(SHARD_HOME);
    rig.place(10, { x: 600, y: 500, z: 100 });
    // Just outside the radius: nothing.
    rig.place(0, stand, RELAY.pickupRadiusM + 6);
    rig.dragon(0).yaw = 0;
    rig.step();
    expect(shardOf(rig, TEAM_FROST).status).toBe(SHARD_HOME);

    const before = rig.sim.relay.revision;
    rig.place(0, stand);
    rig.step();
    const shard = (): RelayShardState => shardOf(rig, TEAM_FROST);
    expect(shard().status).toBe(SHARD_CARRIED);
    expect(shard().carrierId).toBe(0);
    expect(rig.sim.relay.revision).toBeGreaterThan(before);
    expect(rig.objectives).toHaveLength(1);
    expect(rig.objectives[0]).toMatchObject({
      kind: 'pickedUp',
      team: TEAM_EMBER,
      dragonId: 0,
      tick: rig.sim.current.tick,
    });
    // It rides with the carrier().
    rig.step(30);
    expect(shard().position).toEqual(rig.dragon(0).position);
  });

  it('a downed rider cannot take a shard', () => {
    const rig = makeRelay();
    rig.kill(0);
    rig.step();
    rig.place(0, rig.sim.relay.stands[TEAM_FROST] as Vec3);
    rig.step();
    expect(shardOf(rig, TEAM_FROST).status).toBe(SHARD_HOME);
  });

  it('the carrier is slowed and cannot stay veiled; both end with the carry', () => {
    const rig = makeRelay();
    const carrier = (): DragonState => rig.dragon(0);
    const free = (): DragonState => rig.dragon(1);
    carrier().veilTicks = 200;
    emberTakes(rig);
    expect(carrier().veilTicks).toBe(0);
    expect(carrier().flags & DRAGON_FLAG_VEILED).toBe(0);
    expect(carrier().flags & DRAGON_FLAG_SLOWED).not.toBe(0);
    expect(carrier().slowScale).toBe(RELAY.carrierSpeedScale);

    // Level flight, no boost: the carrier settles at the slower cruise speed.
    rig.step(8 * TICK_HZ);
    expect(carrier().slowTicks).toBeGreaterThan(0);
    expect(carrier().speed / free().speed).toBeCloseTo(RELAY.carrierSpeedScale, 1);
    // A veil cast while carrying ends at once.
    carrier().veilTicks = 90;
    rig.step();
    expect(carrier().veilTicks).toBe(0);

    // A stronger slow from an enemy still bites; a weaker one does not lift the burden.
    carrier().slowTicks = 60;
    carrier().slowScale = 0.5;
    rig.step();
    expect(carrier().slowScale).toBe(0.5);
    carrier().slowTicks = 60;
    carrier().slowScale = 0.95;
    rig.step();
    expect(carrier().slowScale).toBe(RELAY.carrierSpeedScale);
    carrier().slowTicks = 0;

    // Scoring lifts it on the same tick.
    rig.place(0, rig.sim.relay.braziers[TEAM_EMBER] as Vec3);
    rig.step();
    expect(carrier().slowTicks).toBe(0);
    expect(carrier().flags & DRAGON_FLAG_SLOWED).toBe(0);
  });

  it('carrying the shard to its own brazier scores a capture and sends the shard home', () => {
    const rig = makeRelay();
    const relay = rig.sim.relay;
    emberTakes(rig);
    rig.drain();
    // The enemy's brazier is not the place.
    rig.place(0, relay.braziers[TEAM_FROST] as Vec3);
    rig.step();
    expect(rig.director.scores).toEqual([0, 0]);

    rig.place(0, relay.braziers[TEAM_EMBER] as Vec3, RELAY.captureRadiusM - 4);
    rig.step();
    expect(rig.director.scores).toEqual([1, 0]);
    expect(rig.drain()).toEqual(['captured']);
    const event = rig.objectives[rig.objectives.length - 1];
    expect(event).toMatchObject({ kind: 'captured', team: TEAM_EMBER, dragonId: 0 });
    expect(event?.position).toEqual(relay.braziers[TEAM_EMBER]);
    expect(shardOf(rig, TEAM_FROST).status).toBe(SHARD_HOME);
    expect(shardOf(rig, TEAM_FROST).position).toEqual(relay.stands[TEAM_FROST]);
    expect(rig.director.statsOf(0)?.captures).toBe(1);
    expect(rig.director.statsOf(1)?.captures).toBe(0);
    const row = rig.director.stats[0];
    expect(row === undefined ? -1 : capturesOf(row)).toBe(1);
    // One capture per carry.
    rig.step(10);
    expect(rig.director.scores).toEqual([1, 0]);
  });

  it('scores while its own shard is away by default; the tuning can demand it home', () => {
    const loose = makeRelay();
    const frostStand = loose.sim.relay.stands[TEAM_EMBER] as Vec3;
    loose.place(10, frostStand);
    loose.step();
    expect(loose.sim.relay.shards[TEAM_EMBER]?.status).toBe(SHARD_CARRIED);
    loose.place(10, { x: -600, y: 500, z: 0 });
    emberScores(loose);
    expect(RELAY.captureNeedsShardHome).toBe(false);
    expect(loose.director.scores).toEqual([1, 0]);

    const strict = makeRelay({ relay: { captureNeedsShardHome: true } });
    strict.place(10, strict.sim.relay.stands[TEAM_EMBER] as Vec3);
    strict.step();
    strict.place(10, { x: -600, y: 500, z: 0 });
    emberScores(strict);
    expect(strict.director.scores).toEqual([0, 0]);
    expect(shardOf(strict, TEAM_FROST).status).toBe(SHARD_CARRIED);
    // The thief goes down, a mate touches the shard: now the capture counts.
    strict.kill(10, 1);
    strict.step();
    const own = (): RelayShardState => shardOf(strict, TEAM_EMBER);
    expect(own().status).toBe(SHARD_DROPPED);
    strict.place(1, own().position);
    strict.step();
    expect(own().status).toBe(SHARD_HOME);
    strict.place(0, strict.sim.relay.braziers[TEAM_EMBER] as Vec3);
    strict.step();
    expect(strict.director.scores).toEqual([1, 0]);
  });

  it('a downed carrier drops the shard where it fell', () => {
    const rig = makeRelay();
    const relay = rig.sim.relay;
    emberTakes(rig);
    rig.place(0, { x: 200, y: 400, z: 50 });
    rig.step();
    rig.drain();
    rig.kill(0, 10);
    rig.step();
    const shard = (): RelayShardState => shardOf(rig, TEAM_FROST);
    expect(shard().status).toBe(SHARD_DROPPED);
    expect(shard().carrierId).toBe(NO_PLAYER);
    expect(distance(shard().position, { x: 200, y: 400, z: 50 })).toBeLessThan(10);
    expect(shard().returnTick).toBe(rig.tick + RELAY.dropReturnS * TICK_HZ);
    expect(rig.drain()).toEqual(['dropped']);
    expect(rig.objectives[rig.objectives.length - 1]).toMatchObject({
      kind: 'dropped',
      team: TEAM_FROST,
      dragonId: 0,
    });
    // It stays put while the dragon falls away.
    const at = { ...shard().position };
    rig.step(20);
    expect(shard().position).toEqual(at);
    // The takedown is not a point in this mode.
    expect(rig.director.scores).toEqual([0, 0]);
  });

  it('a carrier that leaves the match drops it too', () => {
    const rig = makeRelay();
    emberTakes(rig);
    rig.sim.despawnDragon(0);
    rig.step();
    expect(shardOf(rig, TEAM_FROST).status).toBe(SHARD_DROPPED);
    expect(rig.drain()).toEqual(['pickedUp', 'dropped']);
  });

  it("the owner's mate touching a dropped shard sends it home", () => {
    const rig = makeRelay();
    const relay = rig.sim.relay;
    emberTakes(rig);
    rig.place(0, { x: 200, y: 400, z: 50 });
    rig.step();
    rig.kill(0, 10);
    rig.step();
    rig.drain();
    const shard = (): RelayShardState => shardOf(rig, TEAM_FROST);
    rig.place(11, shard().position);
    rig.step();
    expect(shard().status).toBe(SHARD_HOME);
    expect(shard().position).toEqual(relay.stands[TEAM_FROST]);
    expect(rig.drain()).toEqual(['returned']);
    expect(rig.objectives[rig.objectives.length - 1]).toMatchObject({
      kind: 'returned',
      team: TEAM_FROST,
      dragonId: 11,
    });
  });

  it('an enemy touching a dropped shard carries it again; the owner wins a tie', () => {
    const rig = makeRelay();
    const relay = rig.sim.relay;
    emberTakes(rig);
    rig.place(0, { x: 200, y: 400, z: 50 });
    rig.step();
    rig.kill(0, 10);
    rig.step();
    const shard = (): RelayShardState => shardOf(rig, TEAM_FROST);
    rig.place(1, shard().position);
    rig.step();
    expect(shard().status).toBe(SHARD_CARRIED);
    expect(shard().carrierId).toBe(1);

    rig.kill(1, 10);
    rig.step();
    expect(shard().status).toBe(SHARD_DROPPED);
    rig.drain();
    // Both sides on it on the same tick, the enemy nearer: it still goes home.
    rig.runTo('playing');
    rig.step(2 * TICK_HZ);
    rig.place(0, shard().position);
    rig.place(11, shard().position, 6);
    rig.step();
    expect(shard().status).toBe(SHARD_HOME);
    expect(rig.drain()).toEqual(['returned']);
  });

  it('a dropped shard goes home by itself after the timeout', () => {
    const rig = makeRelay({ relay: { dropReturnS: 2 } });
    const relay = rig.sim.relay;
    emberTakes(rig);
    rig.place(0, { x: 200, y: 400, z: 50 });
    rig.step();
    rig.kill(0, 10);
    rig.step();
    rig.drain();
    const shard = (): RelayShardState => shardOf(rig, TEAM_FROST);
    rig.step(2 * TICK_HZ - 1);
    expect(shard().status).toBe(SHARD_DROPPED);
    rig.step();
    expect(shard().status).toBe(SHARD_HOME);
    expect(rig.drain()).toEqual(['returned']);
    expect(rig.objectives[rig.objectives.length - 1]).toMatchObject({
      team: TEAM_FROST,
      dragonId: NO_PLAYER,
    });
  });

  it('never leaves a shard under the cloud sea, above the ceiling or outside the storm', () => {
    const arena = openArena();
    const low = arena.floorY + RELAY.minAltitudeM;
    for (const fall of [
      { x: 100, y: -300, z: 0 },
      { x: 100, y: 5, z: 0 },
      { x: 0, y: 2000, z: 100 },
      { x: 1500, y: 300, z: 0 },
      { x: -900, y: 1, z: 900 },
    ]) {
      const rig = makeRelay({ arena });
      emberTakes(rig);
      rig.place(0, fall);
      rig.step();
      rig.kill(0);
      rig.step();
      const shard = (): RelayShardState => shardOf(rig, TEAM_FROST);
      expect(shard().status).toBe(SHARD_DROPPED);
      const at = shard().position;
      expect(at.y).toBeGreaterThanOrEqual(low);
      expect(at.y).toBeLessThanOrEqual(arena.ceilingY - RELAY.ceilingMarginM);
      expect(Math.hypot(at.x, at.z)).toBeLessThanOrEqual(arena.radius - RELAY.stormMarginM + 1e-6);
    }
  });

  it('never leaves a shard inside rock: it lies beside it, or goes home when nothing is open', () => {
    // A wall of rock around x = 300, 100 m thick.
    const wall: RelayTerrain = {
      solidDepth: (x) => 50 - Math.abs(x - 300),
      closestPoint: (x, _y, _z, max) => {
        const gap = Math.abs(x - 300) - 50;
        return gap >= 0 && gap <= max ? gap : -1;
      },
    };
    const rig = makeRelay({ arena: openArena({ terrain: wall }) });
    emberTakes(rig);
    rig.place(0, { x: 300, y: 400, z: 0 });
    rig.kill(0);
    rig.step();
    const shard = (): RelayShardState => shardOf(rig, TEAM_FROST);
    expect(shard().status).toBe(SHARD_DROPPED);
    const at = shard().position;
    expect(wall.solidDepth(at.x, at.y, at.z)).toBeLessThanOrEqual(0);
    expect(Math.abs(at.x - 300)).toBeGreaterThanOrEqual(50 + RELAY.dropClearanceM);

    // Solid everywhere near the fall: dropped and returned on the same tick.
    let solid = false;
    const sometimes: RelayTerrain = {
      solidDepth: () => (solid ? 1 : -1),
      closestPoint: () => (solid ? 0 : -1),
    };
    const buried = makeRelay({ arena: openArena({ terrain: sometimes }) });
    emberTakes(buried);
    buried.drain();
    solid = true;
    buried.kill(0);
    buried.step();
    expect(shardOf(buried, TEAM_FROST).status).toBe(SHARD_HOME);
    expect(buried.drain()).toEqual(['dropped', 'returned']);
  });

  it('copies with the sim state, and a copy of an idle state costs nothing', () => {
    const rig = makeRelay();
    emberTakes(rig);
    const copy = createSimState();
    copySimState(copy, rig.sim.current);
    expect(copy.relay).toEqual(rig.sim.current.relay);
    expect(copy.relay.shards[TEAM_FROST]).not.toBe(rig.sim.current.relay.shards[TEAM_FROST]);
    // The two buffers the sim swaps agree after a step.
    rig.step();
    expect(rig.sim.prev.relay.shards[TEAM_FROST]?.status).toBe(SHARD_CARRIED);
  });
});

// --- Winning ---------------------------------------------------------------------------------------

describe('winning', () => {
  it('first to the capture limit wins', () => {
    const rig = makeRelay({ settings: { scoreLimit: 2 } });
    emberScores(rig);
    expect(rig.director.phase).toBe('playing');
    emberScores(rig);
    expect(rig.director.scores).toEqual([2, 0]);
    expect(rig.director.phase).toBe('roundEnd');
    expect(rig.director.matchWinner).toBe(TEAM_EMBER);
    expect(rig.director.endReason).toBe('scoreLimit');
    rig.runTo('results');
    expect(rig.phases.map((entry) => entry.phase)).toEqual(['playing', 'roundEnd', 'results']);
  });

  it('nothing happens to the shards outside play', () => {
    const rig = makeRelay({ settings: { scoreLimit: 1 } });
    emberScores(rig);
    expect(rig.director.phase).toBe('roundEnd');
    rig.drain();
    rig.place(1, rig.sim.relay.stands[TEAM_FROST] as Vec3);
    rig.step(5);
    expect(shardOf(rig, TEAM_FROST).status).toBe(SHARD_HOME);
    expect(rig.drain()).toEqual([]);
  });

  it('at the time limit the team with more captures wins', () => {
    const rig = makeRelay({ settings: { scoreLimit: 5, timeLimitS: 60 } });
    emberScores(rig);
    rig.runTo('roundEnd', 61 * TICK_HZ);
    expect(rig.director.matchWinner).toBe(TEAM_EMBER);
    expect(rig.director.endReason).toBe('timeLimit');
    expect(rig.director.overtime).toBe(false);
  });

  it('level at the time limit: sudden death, the next capture wins', () => {
    const rig = makeRelay({ settings: { scoreLimit: 5, timeLimitS: 60 } });
    rig.step(60 * TICK_HZ);
    expect(rig.director.phase).toBe('playing');
    expect(rig.director.overtime).toBe(true);
    emberScores(rig);
    expect(rig.director.phase).toBe('roundEnd');
    expect(rig.director.matchWinner).toBe(TEAM_EMBER);
  });

  it('nobody scores in sudden death: a draw', () => {
    const rig = makeRelay({ settings: { scoreLimit: 5, timeLimitS: 60 } });
    rig.runTo('roundEnd', 70 * TICK_HZ);
    expect(rig.director.matchWinner).toBe('draw');
    expect(rig.tick).toBeGreaterThan(64 * TICK_HZ);
  });

  it('riders respawn as in Skirmish', () => {
    const rig = makeRelay();
    rig.kill(10, 0);
    rig.step();
    expect(rig.dragon(10).flags & DRAGON_FLAG_ALIVE).toBe(0);
    rig.step(2 * TICK_HZ);
    expect(rig.dragon(10).flags & DRAGON_FLAG_ALIVE).not.toBe(0);
    expect(rig.director.statsOf(0)?.takedowns).toBe(1);
  });

  it('is deterministic', () => {
    const play = (): string => {
      const rig = makeRelay({ settings: { scoreLimit: 2 } });
      emberScores(rig);
      emberTakes(rig);
      rig.kill(0, 10);
      rig.step(40);
      return JSON.stringify([rig.sim.current.relay, rig.director.scores, rig.objectives]);
    };
    expect(play()).toBe(play());
  });
});

// --- Mode config and lobby -------------------------------------------------------------------------

describe('mode config and lobby', () => {
  it('is on the menu for 2v2 to 5v5', () => {
    expect(MODES.emberRelay.available).toBe(true);
    expect(MODES.emberRelay.minTeamSize).toBe(2);
    expect(MODES.emberRelay.maxTeamSize).toBe(5);
  });

  it('counts the score limit in captures, with its own range and default', () => {
    const rule = scoreLimitRule('emberRelay');
    expect(rule).toEqual({ min: 1, max: RELAY.maxCaptures, initial: RELAY.defaultCaptures });
    expect(resolveScoreLimit('emberRelay', 4)).toBe(4);
    expect(resolveScoreLimit('emberRelay', 0)).toBe(1);
    // Skirmish's 30 takedowns left in the box is not a capture limit: the mode's default.
    expect(resolveScoreLimit('emberRelay', 30)).toBe(RELAY.defaultCaptures);
    expect(resolveScoreLimit('emberRelay', Number.NaN)).toBe(RELAY.defaultCaptures);
    expect(resolveScoreLimit('skirmish', 30)).toBe(30);

    const config = createModeConfig({
      ...DEFAULT_HOST_SETTINGS,
      mode: 'emberRelay',
      teamSize: 1,
      scoreLimit: 30,
    });
    expect(config.mode).toBe('emberRelay');
    expect(config.teamSize).toBe(2);
    expect(config.scoreLimit).toBe(RELAY.defaultCaptures);
    expect(config.respawns).toBe(true);
    expect(config.maxRounds).toBe(1);
    expect(config.stormShrinks).toBe(false);
  });

  it('the lobby resets the limit when the mode changes and clamps it inside the mode', () => {
    const HOST = 0;
    let lobby = createLobby({ roomCode: 'ABCD', hostName: 'Host' });
    const must = (result: ReturnType<typeof setMode>): typeof lobby => {
      if (!result.ok) throw new Error(result.reason);
      return result.lobby;
    };
    lobby = must(setTeamSize(lobby, HOST, 1));
    lobby = must(setScoreLimit(lobby, HOST, 40));
    lobby = must(setMode(lobby, HOST, 'emberRelay'));
    expect(lobby.state.settings).toMatchObject({
      mode: 'emberRelay',
      teamSize: 2,
      scoreLimit: RELAY.defaultCaptures,
    });
    expect(validateHostSettings(lobby.state.settings)).not.toBeNull();
    expect(must(setScoreLimit(lobby, HOST, 99)).state.settings.scoreLimit).toBe(RELAY.maxCaptures);
    expect(must(setScoreLimit(lobby, HOST, 0)).state.settings.scoreLimit).toBe(1);
    lobby = must(setScoreLimit(lobby, HOST, 5));
    // 1v1 is not Ember Relay.
    expect(must(setTeamSize(lobby, HOST, 1)).state.settings.teamSize).toBe(2);
    expect(validateHostSettings({ ...lobby.state.settings, teamSize: 1 })).toBeNull();

    lobby = must(setMode(lobby, HOST, 'skirmish'));
    expect(lobby.state.settings.scoreLimit).toBe(scoreLimitRule('skirmish').initial);
  });
});
