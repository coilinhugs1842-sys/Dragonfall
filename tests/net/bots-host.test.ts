/**
 * HostBots (T-3.10): the driver of the bot riders that fill team slots. The host session asks it
 * for one input per bot per tick; here the same loop is run against a bare sim, from a roster
 * the real lobby produced.
 */

import { describe, expect, it } from 'vitest';
import { HostBots, NetBotPilot, botSeedOf } from '../../src/net/bots';
import { createSnapshotOwner } from '../../src/net/protocol';
import {
  createGreyboxMatchWorld,
  createOpenSkyMatchWorld,
  spawnPointOf,
  spawnYawOf,
} from '../../src/net/session';
import type { MatchWorld } from '../../src/net/session';
import {
  BUTTON_ABILITY_MASK,
  NO_PLAYER,
  TEAM_FROST,
  TICK_HZ,
  createInputFrame,
} from '../../src/shared';
import type { InputFrame, MatchRoster } from '../../src/shared';
import { createSim } from '../../src/sim';
import type { Sim } from '../../src/sim';
import { BOT_MODE_ENGAGE } from '../../src/sim/bots';
import {
  HOST_PLAYER_ID,
  createLobby,
  fillBots,
  setBotDifficulty,
  setTeamSize,
  startMatch,
} from '../../src/sim/lobby';
import type { LobbyResult } from '../../src/sim/lobby';

let sharedWorld: MatchWorld | null = null;
function greybox(): MatchWorld {
  sharedWorld ??= createGreyboxMatchWorld();
  return sharedWorld;
}

function must(result: LobbyResult) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

/** The roster of a room the host filled with bots: host + (2 * teamSize - 1) bots. */
function botRoster(
  teamSize: number,
  difficulty: 'easy' | 'normal' | 'hard' = 'normal',
): MatchRoster {
  let lobby = createLobby({ roomCode: 'BOTS1', hostName: 'Host' });
  lobby = must(setTeamSize(lobby, HOST_PLAYER_ID, teamSize)).lobby;
  lobby = must(setBotDifficulty(lobby, HOST_PLAYER_ID, difficulty)).lobby;
  lobby = must(fillBots(lobby, HOST_PLAYER_ID, 12)).lobby;
  const started = must(startMatch(lobby, HOST_PLAYER_ID));
  const effect = started.effects[0];
  if (effect?.type !== 'matchStart') throw new Error('no roster');
  return effect.roster;
}

function spawnRoster(sim: Sim, roster: MatchRoster, world: MatchWorld): void {
  for (const rider of roster.riders) {
    sim.spawnDragon(
      rider.playerId,
      rider.team,
      rider.classId,
      spawnPointOf(world, rider.team, rider.gateSlot),
      spawnYawOf(world, rider.team),
    );
  }
}

/** The host's tick loop, as `HostSession.stepMatch` runs it for riders without a link. */
function runMatch(
  sim: Sim,
  bots: HostBots,
  roster: MatchRoster,
  ticks: number,
  onFrame?: (id: number, frame: Readonly<InputFrame>) => void,
): void {
  const inputs: (Readonly<InputFrame> | undefined)[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    for (const rider of roster.riders) {
      const frame = bots.sample(sim.current, rider.playerId, tick, true);
      if (frame !== undefined) onFrame?.(rider.playerId, frame);
      inputs[rider.playerId] = frame;
    }
    sim.step(tick, inputs);
  }
}

describe('HostBots', () => {
  it('flies the bot riders of a roster that have no connection, and nobody else', () => {
    const roster = botRoster(2);
    expect(roster.riders).toHaveLength(4);
    const world = createOpenSkyMatchWorld();
    const bots = new HostBots();
    // Pretend rider 2 is a `?bots=N` fake client: it has a link, so it brings its own input.
    bots.beginRoster(roster, world, 99, (id) => id === 2);
    expect(bots.count).toBe(2);
    expect(bots.has(HOST_PLAYER_ID)).toBe(false);
    expect(bots.has(1)).toBe(true);
    expect(bots.has(2)).toBe(false);
    expect(bots.has(3)).toBe(true);
    expect(bots.has(200)).toBe(false);
    expect(bots.difficulty).toBe('normal');

    const sim = createSim();
    spawnRoster(sim, roster, world);
    expect(bots.sample(sim.current, HOST_PLAYER_ID, 5, true)).toBeUndefined();
    expect(bots.sample(sim.current, 2, 5, true)).toBeUndefined();
    const a = bots.sample(sim.current, 1, 5, true);
    const b = bots.sample(sim.current, 3, 6, true);
    // One frame per bot: the sim reads them all in the same step.
    expect(a).not.toBe(b);
    expect(a?.tick).toBe(5);
    expect(b?.tick).toBe(6);
    expect(bots.sample(sim.current, 1, 7, true)).toBe(a);

    bots.remove(1);
    expect(bots.has(1)).toBe(false);
    expect(bots.count).toBe(1);
    expect(bots.sample(sim.current, 1, 8, true)).toBeUndefined();
    expect(bots.add(1)).toBe(true);
    expect(bots.add(NO_PLAYER)).toBe(false);
    expect(bots.add(-1)).toBe(false);
    expect(bots.count).toBe(2);
    bots.end();
    expect(bots.count).toBe(0);
    expect(bots.has(3)).toBe(false);
  });

  it('gives neutral frames while the match is not being played', () => {
    const roster = botRoster(1);
    const world = createOpenSkyMatchWorld();
    const bots = new HostBots();
    bots.beginRoster(roster, world, 4);
    const sim = createSim();
    spawnRoster(sim, roster, world);
    for (let tick = 0; tick < 90; tick++) {
      const frame = bots.sample(sim.current, 1, tick, false);
      expect(frame).toMatchObject({ steerX: 0, steerY: 0, buttons: 0, tick });
    }
    expect(bots.brainOf(1)?.targetId).toBe(NO_PLAYER);
  });

  it('a filled 2v2 on the greybox map fights and resolves; the lobby difficulty reaches the brains', () => {
    const roster = botRoster(2, 'hard');
    const world = greybox();
    const bots = new HostBots();
    bots.beginRoster(roster, world, 7);
    // Nobody is at the host seat in this test: a bot flies that dragon too.
    bots.add(HOST_PLAYER_ID);
    expect(bots.count).toBe(4);
    expect(bots.difficulty).toBe('hard');
    for (const rider of roster.riders)
      expect(bots.brainOf(rider.playerId)?.difficulty).toBe('hard');

    const sim = createSim({ collisionWorld: world.collisionWorld });
    spawnRoster(sim, roster, world);
    let abilityPresses = 0;
    runMatch(sim, bots, roster, 120 * TICK_HZ, (_id, frame) => {
      if ((frame.buttons & BUTTON_ABILITY_MASK) !== 0) abilityPresses++;
    });
    const takedowns = (sim.current.teamTakedowns[0] ?? 0) + (sim.current.teamTakedowns[1] ?? 0);
    expect(abilityPresses).toBeGreaterThan(100);
    expect(takedowns).toBeGreaterThanOrEqual(2);
    for (const dragon of sim.current.dragons) {
      if (!dragon.active) continue;
      expect(Number.isFinite(dragon.position.x + dragon.position.y + dragon.position.z)).toBe(true);
    }

    bots.difficulty = 'easy';
    for (const rider of roster.riders)
      expect(bots.brainOf(rider.playerId)?.difficulty).toBe('easy');
  });

  it('the same match seed plays the same match; another seed another one', () => {
    const roster = botRoster(2);
    const world = greybox();
    const digestOf = (seed: number, bots: HostBots): number => {
      bots.beginRoster(roster, world, seed);
      bots.add(HOST_PLAYER_ID);
      const sim = createSim({ collisionWorld: world.collisionWorld });
      spawnRoster(sim, roster, world);
      let digest = 0;
      runMatch(sim, bots, roster, 45 * TICK_HZ, (id, frame) => {
        digest =
          (Math.imul(digest, 31) + Math.round(frame.steerX * 1e6) + frame.buttons * 7 + id) | 0;
      });
      return digest;
    };
    const bots = new HostBots();
    const first = digestOf(5, bots);
    // The same driver again (its brains are reused and reset), and a brand new one.
    expect(digestOf(5, bots)).toBe(first);
    expect(digestOf(5, new HostBots())).toBe(first);
    expect(digestOf(6, bots)).not.toBe(first);
    expect(botSeedOf(5, 1)).not.toBe(botSeedOf(5, 2));
    expect(botSeedOf(5, 1)).not.toBe(botSeedOf(6, 1));
  });

  it('a removed rider stops being flown and the others carry on', () => {
    const roster = botRoster(2);
    const world = greybox();
    const bots = new HostBots();
    bots.beginRoster(roster, world, 3);
    const sim = createSim({ collisionWorld: world.collisionWorld });
    spawnRoster(sim, roster, world);
    runMatch(sim, bots, roster, 5 * TICK_HZ);
    bots.remove(3);
    sim.despawnDragon(3);
    const flown = new Set<number>();
    let engaged = false;
    runMatch(sim, bots, roster, 30 * TICK_HZ, (id) => {
      flown.add(id);
      if (bots.brainOf(id)?.mode === BOT_MODE_ENGAGE) engaged = true;
    });
    expect(sim.getDragon(3)).toBeUndefined();
    expect(sim.current.dragonCount).toBe(3);
    // The host seat (0) is a person and rider 3 is gone: bots 1 and 2 are the ones flown.
    expect([...flown].sort()).toEqual([1, 2]);
    expect(engaged).toBe(true);
    const frost = roster.riders.filter((rider) => rider.team === TEAM_FROST);
    expect(frost.length).toBe(2);
    expect(sim.getDragon(1)?.active).toBe(true);
  });
});

describe('NetBotPilot', () => {
  it('without a host to look at it flies the plain weave from its own snapshot', () => {
    const pilot = new NetBotPilot(7);
    const frame = createInputFrame();
    frame.buttons = 9;
    pilot.sample(frame, null);
    expect(frame).toMatchObject({ steerX: 0, steerY: 0, buttons: 0 });
    const own = createSnapshotOwner();
    own.position.y = 30;
    own.pitch = -0.2;
    pilot.sample(frame, own);
    // Low over the cloud sea: the weave pulls up, and it never touches an ability.
    expect(frame.steerY).toBeGreaterThan(0.5);
    for (let i = 0; i < 600; i++) {
      pilot.sample(frame, own);
      expect(frame.buttons & BUTTON_ABILITY_MASK).toBe(0);
    }
  });
});
