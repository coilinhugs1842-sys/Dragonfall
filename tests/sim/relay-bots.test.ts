/**
 * Bots play Ember Relay (T-6.3): whole matches on the real map with the real rules, driven the
 * way the host drives them (director around the sim, one brain per rider). What is asked of
 * them: they take the enemy's shard, bring it home, go after a thief, fetch their own dropped
 * shard, still fight, and a match ends by captures in reasonable time.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_CLASS_IDS,
  MAPS,
  NO_PLAYER,
  SHARD_CARRIED,
  SHARD_DROPPED,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
  createArenaMap,
  createInputFrame,
  defaultSeedOfMap,
  spawnGatesForMode,
} from '../../src/shared';
import type { InputFrame, MapId, ObjectiveKind, TeamId } from '../../src/shared';
import { createMapCollisionWorld, createSim } from '../../src/sim';
import type { Sim, SimCollisionWorld } from '../../src/sim';
import {
  BOT_ERRAND_CARRY,
  BOT_ERRAND_NONE,
  BOT_ERRAND_RETURN,
  BOT_ERRAND_TAKE,
  BOT_MODE_OBJECTIVE,
  BotBrain,
} from '../../src/sim/bots';
import type { BotArena, BotContext } from '../../src/sim/bots';
import { MatchDirector, createModeConfig, relayTerrainOf } from '../../src/sim/match';
import type { RelayArena } from '../../src/sim/match';

/** Gate slots in the order riders take them (centre first). */
const SLOT_ORDER = [2, 1, 3, 0, 4];

interface World {
  collision: SimCollisionWorld;
  bots: BotArena;
  relay: RelayArena;
  slot(team: TeamId, index: number): { x: number; y: number; z: number };
}

const worlds = new Map<MapId, World>();

/** One BVH per map for the whole file (it takes tens of ms to build). */
function worldOf(id: MapId): World {
  const known = worlds.get(id);
  if (known !== undefined) return known;
  const map = createArenaMap(id, defaultSeedOfMap(id));
  const collision = createMapCollisionWorld(map);
  const gates = spawnGatesForMode(map, 'emberRelay');
  const bounds = {
    centerX: map.colliders.stormCenter.x,
    centerZ: map.colliders.stormCenter.z,
    radius: map.colliders.stormRadius,
    floorY: map.colliders.floorY,
    ceilingY: map.colliders.ceilingY,
  };
  const world: World = {
    collision,
    bots: bounds,
    relay: {
      ...bounds,
      gates: [TEAM_EMBER, TEAM_FROST].map((team) => gates[team]?.position ?? { x: 0, y: 300, z: 0 }),
      terrain: relayTerrainOf(collision),
    },
    slot(team, index) {
      const slot = gates[team]?.slots[SLOT_ORDER[index] ?? 0];
      if (slot === undefined) throw new Error('no gate slot');
      return slot;
    },
  };
  worlds.set(id, world);
  return world;
}

interface Played {
  sim: Sim;
  director: MatchDirector;
  brains: BotBrain[];
  /** Seconds of play at each objective event. */
  events: { kind: ObjectiveKind; team: TeamId; dragonId: number; atS: number }[];
  takedowns: number;
  selfInflicted: number;
  /** Ticks some bot spent on each errand. */
  errandTicks: number[];
  /** Ticks an enemy carried a shard, and ticks a defender had that thief as its target. */
  thiefTicks: number;
  chasedTicks: number;
  playedS: number;
  /** Runs until the match is decided or `maxS` seconds of play have passed. */
  run(maxS: number): void;
}

function playMatch(id: MapId, perTeam: number, seed: number, scoreLimit: number): Played {
  const world = worldOf(id);
  const director = new MatchDirector();
  const played: Played = {
    sim: undefined as unknown as Sim,
    director,
    brains: [],
    events: [],
    takedowns: 0,
    selfInflicted: 0,
    errandTicks: [0, 0, 0, 0],
    thiefTicks: 0,
    chasedTicks: 0,
    playedS: 0,
    run: () => undefined,
  };
  let playTicks = 0;
  const sim = createSim({
    collisionWorld: world.collision,
    events: {
      emit(event) {
        director.onEvent(event);
        if (event.type === 'objective') {
          played.events.push({
            kind: event.kind,
            team: event.team,
            dragonId: event.dragonId,
            atS: playTicks / TICK_HZ,
          });
        } else if (event.type === 'takedown') {
          played.takedowns++;
          if (event.killerId === NO_PLAYER) played.selfInflicted++;
        }
      },
    },
  });
  played.sim = sim;
  const config = createModeConfig(
    { ...DEFAULT_HOST_SETTINGS, mode: 'emberRelay', map: id, teamSize: perTeam, scoreLimit, timeLimitS: 0 },
    false,
  );
  director.begin(sim, config, null, 1, 3 * TICK_HZ, 0, world.relay);

  const frames: InputFrame[] = [];
  const teams: TeamId[] = [];
  let playerId = 0;
  for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
    for (let i = 0; i < perTeam; i++) {
      const classId = DRAGON_CLASS_IDS[(playerId + seed) % DRAGON_CLASS_IDS.length] ?? 'talon';
      sim.spawnDragon(playerId, team, classId, world.slot(team, i), team === TEAM_EMBER ? 0 : Math.PI);
      director.addRider(playerId, team);
      played.brains.push(new BotBrain(seed * 1000 + playerId, { difficulty: 'normal' }));
      frames.push(createInputFrame());
      teams.push(team);
      playerId++;
    }
  }
  const ctx: BotContext = { state: sim.current, collision: world.collision, arena: world.bots, playing: false };
  let tick = 0;

  played.run = (maxS) => {
    const maxTicks = maxS * TICK_HZ;
    while (playTicks < maxTicks && !director.matchOver) {
      tick++;
      director.beforeStep(tick, sim);
      if (director.finished || !director.simRuns) continue;
      const playing = director.phase === 'playing';
      ctx.state = sim.current;
      ctx.playing = playing;
      for (let b = 0; b < played.brains.length; b++) {
        const frame = frames[b];
        const brain = played.brains[b];
        if (frame === undefined || brain === undefined) continue;
        brain.think(ctx, b, frame);
        frame.tick = tick;
      }
      sim.step(tick, frames);
      director.afterStep(tick, sim);
      if (!playing) continue;
      playTicks++;

      const relay = sim.current.relay;
      for (let b = 0; b < played.brains.length; b++) {
        const brain = played.brains[b];
        const team = teams[b];
        if (brain === undefined || team === undefined) continue;
        const errand = brain.errand;
        played.errandTicks[errand] = (played.errandTicks[errand] ?? 0) + 1;
        // An errand and the mode go together.
        if (errand === BOT_ERRAND_CARRY) expect(brain.mode).toBe(BOT_MODE_OBJECTIVE);
        const own = relay.shards[team];
        if (own !== undefined && own.status === SHARD_CARRIED) {
          played.thiefTicks++;
          if (brain.targetId === own.carrierId) played.chasedTicks++;
        }
      }
    }
    played.playedS = playTicks / TICK_HZ;
  };
  return played;
}

function count(played: Played, kind: ObjectiveKind): number {
  return played.events.filter((event) => event.kind === kind).length;
}

describe('bots play Ember Relay', () => {
  it('a 3v3 on Shattered Spires ends by captures in reasonable time', () => {
    const lines: string[] = [];
    let total = 0;
    const seeds = [1, 2, 3, 4];
    for (const seed of seeds) {
      const played = playMatch('shattered-spires', 3, seed, 3);
      played.run(12 * 60);
      const first = played.events.find((event) => event.kind === 'captured');
      lines.push(
        `seed ${seed}: ${played.director.scores.join('-')} in ${played.playedS.toFixed(0)} s, ` +
          `first capture ${first === undefined ? 'never' : `${first.atS.toFixed(0)} s`}, ` +
          `pickups ${count(played, 'pickedUp')}, drops ${count(played, 'dropped')}, ` +
          `returns ${count(played, 'returned')}, takedowns ${played.takedowns} ` +
          `(${played.selfInflicted} self-inflicted)`,
      );
      expect(played.director.matchOver, lines.join('\n')).toBe(true);
      expect(played.director.endReason).toBe('scoreLimit');
      expect(Math.max(...played.director.scores)).toBe(3);
      expect(first?.atS ?? Infinity).toBeLessThan(4 * 60);
      // They still fight on the way.
      expect(played.takedowns).toBeGreaterThan(0);
      total += played.playedS;
    }
    console.info(`Ember Relay, 3v3 bots, first to 3:\n${lines.join('\n')}`);
    // The lobby's default is 8 minutes: a typical match must fit well inside it.
    expect(total / seeds.length).toBeLessThan(8 * 60);
  }, 120_000);

  it('they do every job: take, carry, return, and go after the thief', () => {
    const errands = [0, 0, 0, 0];
    let thief = 0;
    let chased = 0;
    let returnedByHand = 0;
    for (const seed of [11, 12, 13]) {
      const played = playMatch('shattered-spires', 3, seed, 5);
      played.run(6 * 60);
      for (let i = 0; i < errands.length; i++) errands[i] = (errands[i] ?? 0) + (played.errandTicks[i] ?? 0);
      thief += played.thiefTicks;
      chased += played.chasedTicks;
      returnedByHand += played.events.filter(
        (event) => event.kind === 'returned' && event.dragonId !== NO_PLAYER,
      ).length;
    }
    expect(errands[BOT_ERRAND_TAKE]).toBeGreaterThan(0);
    expect(errands[BOT_ERRAND_CARRY]).toBeGreaterThan(0);
    expect(errands[BOT_ERRAND_RETURN]).toBeGreaterThan(0);
    // Not everybody runs for the shard: somebody is always free to fight.
    expect(errands[BOT_ERRAND_NONE]).toBeGreaterThan(errands[BOT_ERRAND_TAKE] ?? 0);
    expect(returnedByHand).toBeGreaterThan(0);
    // While their shard is being carried off, defenders have the thief as their target a good
    // part of the time (they cannot when it is out of sight or they are down).
    expect(thief).toBeGreaterThan(0);
    expect(chased / thief).toBeGreaterThan(0.2);
  }, 120_000);

  it('plays on every map and at every team size without wrecking itself', () => {
    const lines: string[] = [];
    for (const id of Object.keys(MAPS) as MapId[]) {
      for (const perTeam of [2, 5]) {
        const played = playMatch(id, perTeam, 7, 2);
        played.run(10 * 60);
        const label = `${id} ${perTeam}v${perTeam}: ${played.director.scores.join('-')} in ${played.playedS.toFixed(0)} s`;
        lines.push(label);
        expect(count(played, 'pickedUp'), label).toBeGreaterThan(0);
        expect(played.director.matchOver, label).toBe(true);
        // Running for a shard must not fly them into the rock.
        expect(played.selfInflicted, label).toBeLessThanOrEqual(Math.max(2, played.takedowns * 0.25));
        // A shard on the ground is never left in rock or under the sea.
        const relay = played.sim.current.relay;
        for (const shard of relay.shards) {
          if (shard.status !== SHARD_DROPPED) continue;
          expect(shard.position.y).toBeGreaterThan(0);
        }
      }
    }
    console.info(`Ember Relay, bots, first to 2:\n${lines.join('\n')}`);
  }, 180_000);

  it('is deterministic', () => {
    const play = (): string => {
      const played = playMatch('shattered-spires', 2, 5, 2);
      played.run(90);
      return JSON.stringify([played.events, played.sim.current.relay, played.director.scores]);
    };
    expect(play()).toBe(play());
  }, 60_000);
});
