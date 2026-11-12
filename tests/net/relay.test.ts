/**
 * Ember Relay on the wire (T-6.3): the RELAY message's round trip and what it refuses, and the
 * objective state reaching real clients over a session: at match start, on every change, for a
 * player who joins mid-match and for one who reconnects, and gone again when the match is over.
 */

import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/net/codec/io';
import { MSG_RELAY, isClientToHostMessage, isFastMessage, isMessageType } from '../../src/net/protocol';
import { RELAY_BYTES, decodeRelay, encodeRelay } from '../../src/net/session';
import {
  MODE_TUNING,
  NO_PLAYER,
  SHARD_CARRIED,
  SHARD_DROPPED,
  SHARD_HOME,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
  findDragonView,
} from '../../src/shared';
import type { ModeTuning, ObjectiveEvent, TeamId, Vec3 } from '../../src/shared';
import {
  STATE_RECORD_MAX_BYTES,
  createHostTickInfo,
  createHostViewState,
  decodeHostState,
  encodeHostState,
  hostStateBytes,
} from '../../src/net/worker';
import { DAMAGE_IGNORE_IMMUNITY, copyRelayState, createRelayState, createSim } from '../../src/sim';
import type { RelayState, Sim } from '../../src/sim';
import { capturesOf } from '../../src/sim/match';
import { Rig, startMatch } from './session-harness';
import type { RigClient } from './session-harness';

// --- Codec -----------------------------------------------------------------------------------------

function sampleState(): RelayState {
  const relay = createRelayState();
  relay.active = true;
  relay.revision = 7;
  relay.stands[0] = { x: -40, y: 300, z: -600 };
  relay.stands[1] = { x: 40, y: 300, z: 600 };
  relay.braziers[0] = { x: 40, y: 300.5, z: -680 };
  relay.braziers[1] = { x: -40, y: 300.5, z: 680 };
  const ember = relay.shards[0];
  const frost = relay.shards[1];
  if (ember === undefined || frost === undefined) throw new Error('no shards');
  ember.status = SHARD_CARRIED;
  ember.carrierId = 6;
  ember.position = { x: 12.5, y: 250.25, z: -90 };
  frost.status = SHARD_DROPPED;
  frost.position = { x: 300, y: 120, z: 44 };
  frost.returnTick = 123_456;
  return relay;
}

function readerOf(bytes: Uint8Array): Reader {
  return new Reader().reset(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

function encoded(relay: RelayState, tick = 99): Uint8Array {
  const writer = new Writer(RELAY_BYTES);
  const length = encodeRelay(writer, tick, relay);
  return writer.packet(length).slice();
}

describe('RELAY codec', () => {
  it('is a reliable host-to-client message of a fixed size', () => {
    expect(isMessageType(MSG_RELAY)).toBe(true);
    expect(isFastMessage(MSG_RELAY)).toBe(false);
    expect(isClientToHostMessage(MSG_RELAY)).toBe(false);
    expect(encoded(sampleState())).toHaveLength(RELAY_BYTES);
    expect(RELAY_BYTES).toBe(88);
  });

  it('round-trips the sites and both shards', () => {
    const sent = sampleState();
    const got = createRelayState();
    expect(decodeRelay(readerOf(encoded(sent)), got)).toBe(true);
    expect(got.active).toBe(true);
    expect(got.stands).toEqual(sent.stands);
    expect(got.braziers).toEqual(sent.braziers);
    expect(got.shards[0]).toEqual(sent.shards[0]);
    expect(got.shards[1]).toEqual(sent.shards[1]);
    // The receiver counts its own changes.
    expect(got.revision).toBe(1);
    expect(decodeRelay(readerOf(encoded(sent)), got)).toBe(true);
    expect(got.revision).toBe(2);
  });

  it('sends "home" without a return tick and "off" as off', () => {
    const home = sampleState();
    const frost = home.shards[1];
    if (frost === undefined) throw new Error('no shard');
    frost.status = SHARD_HOME;
    frost.returnTick = 555;
    const got = createRelayState();
    expect(decodeRelay(readerOf(encoded(home)), got)).toBe(true);
    expect(got.shards[1]?.returnTick).toBe(-1);

    const off = createRelayState();
    got.active = true;
    expect(decodeRelay(readerOf(encoded(off)), got)).toBe(true);
    expect(got.active).toBe(false);
  });

  it('refuses malformed input and leaves the state alone', () => {
    const good = encoded(sampleState());
    const untouched = (): RelayState => {
      const state = createRelayState();
      state.revision = 3;
      return state;
    };
    const cases: Uint8Array[] = [
      good.slice(0, good.length - 1),
      new Uint8Array([...good, 0]),
      good.slice(0, 3),
    ];
    // An unknown status.
    const badStatus = good.slice();
    badStatus[RELAY_BYTES - 36] = 9;
    cases.push(badStatus);
    // Carried by nobody, and home with a carrier.
    const noCarrier = good.slice();
    noCarrier[RELAY_BYTES - 35] = NO_PLAYER;
    cases.push(noCarrier);
    const ghostCarrier = good.slice();
    ghostCarrier[RELAY_BYTES - 17] = 4;
    cases.push(ghostCarrier);
    // A position that is not a number.
    const nan = good.slice();
    new DataView(nan.buffer).setFloat32(4, Number.NaN, true);
    cases.push(nan);
    // Another message's type byte.
    const wrongType = good.slice();
    wrongType[0] = 30;
    cases.push(wrongType);

    for (const bytes of cases) {
      const state = untouched();
      expect(decodeRelay(readerOf(bytes), state)).toBe(false);
      expect(state).toEqual(untouched());
    }
  });
});

// --- Worker host: the per-tick state record ----------------------------------------------------------

describe('relay state in the worker state record', () => {
  function roundTrip(relay: RelayState): RelayState {
    const sim = createSim();
    copyRelayState(sim.current.relay, relay);
    const bytes = hostStateBytes(sim.prev, sim.current);
    expect(bytes).toBeLessThanOrEqual(STATE_RECORD_MAX_BYTES);
    const data = new DataView(new ArrayBuffer(bytes));
    expect(encodeHostState(data, 0, createHostTickInfo(), sim.prev, sim.current)).toBe(bytes);
    const prev = createHostViewState();
    const current = createHostViewState();
    // What an earlier match left in the mirror must not survive.
    copyRelayState(current.relay, sampleState());
    expect(decodeHostState(data, 0, bytes, createHostTickInfo(), prev, current)).toBe(true);
    expect(decodeHostState(data, 0, bytes - 1, createHostTickInfo(), prev, current)).toBe(false);
    return current.relay;
  }

  it('mirrors an active relay exactly, revision included', () => {
    const sent = sampleState();
    expect(roundTrip(sent)).toEqual(sent);
  });

  it('costs five bytes when the mode is another one, and switches the mirror off', () => {
    const idle = createRelayState();
    const sim = createSim();
    const idleBytes = hostStateBytes(sim.prev, sim.current);
    copyRelayState(sim.current.relay, sampleState());
    expect(hostStateBytes(sim.prev, sim.current) - idleBytes).toBe(156);
    const got = roundTrip(idle);
    expect(got.active).toBe(false);
    expect(got.revision).toBe(0);
  });
});

// --- Sessions --------------------------------------------------------------------------------------

function fastTuning(): ModeTuning {
  return { ...MODE_TUNING, roundEndS: 0.5, resultsS: 1, forfeitGraceS: 600 };
}

interface RelayRoom {
  rig: Rig;
  sim: Sim;
  /** Where each dragon is held (it is put back there after every host tick). */
  pins: Map<number, Vec3>;
  teamOf(id: number): TeamId;
  /** A rider of `team` (the first, or the second with `index` 1). */
  rider(team: TeamId, index?: number): number;
  objectives: ObjectiveEvent[];
  watcher: RigClient;
}

/** Host + three clients, 2v2 Ember Relay, playing, every dragon parked far from every site. */
function relayRoom(): RelayRoom {
  const rig = new Rig({ host: { modeTuning: fastTuning(), respawnTicks: TICK_HZ } }).open();
  const objectives: ObjectiveEvent[] = [];
  const watcher = rig.join('Watcher', {
    events: {
      emit(event) {
        if (event.type === 'objective') objectives.push({ ...event, position: { ...event.position } });
      },
    },
  });
  rig.join('Rider 2');
  rig.join('Rider 3');
  for (const intent of [
    { type: 'host.setMode', mode: 'emberRelay' } as const,
    { type: 'host.setTeamSize', teamSize: 2 } as const,
    { type: 'host.setScoreLimit', scoreLimit: 2 } as const,
    { type: 'host.setTimeLimit', timeLimitS: 0 } as const,
  ]) {
    expect(rig.host.applyIntent(intent)).toBe(true);
  }
  expect(rig.host.lobby.settings).toMatchObject({ mode: 'emberRelay', teamSize: 2, scoreLimit: 2 });

  const pins = new Map<number, Vec3>();
  const hold = (): void => {
    const sim = rig.host.sim;
    if (sim === null) return;
    for (const [id, at] of pins) {
      const dragon = sim.getDragon(id);
      if (dragon === undefined) continue;
      dragon.position.x = at.x;
      dragon.position.y = at.y;
      dragon.position.z = at.z;
    }
  };
  rig.onHostTick = hold;
  // Parked before the first tick of play, so nobody drifts through a shard during the countdown.
  rig.host.lobby.players.forEach((player, index) => {
    pins.set(player.id, { x: 700, y: 560, z: -300 + index * 200 });
  });
  startMatch(rig);
  const sim = rig.host.sim;
  if (sim === null) throw new Error('no sim');
  rig.runTicks(15);

  const teamOf = (id: number): TeamId => {
    const side = rig.host.lobby.players.find((player) => player.id === id)?.side;
    if (side !== TEAM_EMBER && side !== TEAM_FROST) throw new Error(`player ${id} has no team`);
    return side;
  };
  const rider = (team: TeamId, index = 0): number => {
    const ids = rig.host.lobby.players.filter((player) => player.side === team).map((p) => p.id);
    const id = ids[index];
    if (id === undefined) throw new Error('no such rider');
    return id;
  };
  return { rig, sim, pins, teamOf, rider, objectives, watcher };
}

function other(team: TeamId): TeamId {
  return team === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
}

/** What a client holds is what the host has (positions travel as 32-bit floats). */
function expectMirrors(client: RigClient, sim: Sim): void {
  const mine = client.session.relay;
  const host = sim.current.relay;
  expect(mine.active).toBe(host.active);
  for (const team of [TEAM_EMBER, TEAM_FROST]) {
    const stand = host.stands[team] as Vec3;
    const brazier = host.braziers[team] as Vec3;
    expect(mine.stands[team]?.x).toBeCloseTo(stand.x, 3);
    expect(mine.stands[team]?.y).toBeCloseTo(stand.y, 3);
    expect(mine.stands[team]?.z).toBeCloseTo(stand.z, 3);
    expect(mine.braziers[team]?.x).toBeCloseTo(brazier.x, 3);
    expect(mine.braziers[team]?.z).toBeCloseTo(brazier.z, 3);
    const shard = host.shards[team];
    expect(mine.shards[team]?.status).toBe(shard?.status);
    expect(mine.shards[team]?.carrierId).toBe(shard?.carrierId);
    expect(mine.shards[team]?.returnTick).toBe(shard?.returnTick);
    if (shard?.status !== SHARD_CARRIED) {
      expect(mine.shards[team]?.position.x).toBeCloseTo(shard?.position.x ?? 0, 3);
      expect(mine.shards[team]?.position.y).toBeCloseTo(shard?.position.y ?? 0, 3);
      expect(mine.shards[team]?.position.z).toBeCloseTo(shard?.position.z ?? 0, 3);
    }
  }
}

describe('Ember Relay over a session', () => {
  it('clients get the sites at the start and every change of hands after it', () => {
    const room = relayRoom();
    const { rig, sim, pins, objectives, watcher } = room;
    expect(sim.current.relay.active).toBe(true);
    for (const client of rig.clients) {
      expectMirrors(client, sim);
      expect(client.view.relay.active).toBe(true);
      expect(client.view.relay.shards[TEAM_EMBER]?.status).toBe(SHARD_HOME);
      // The view shows the shard on its stand.
      expect(client.view.relay.shards[TEAM_FROST]?.position.z).toBeCloseTo(
        sim.current.relay.stands[TEAM_FROST]?.z ?? 0,
        3,
      );
    }

    // An Ember rider takes Frost's shard.
    const thief = room.rider(TEAM_EMBER);
    pins.set(thief, { ...(sim.current.relay.stands[TEAM_FROST] as Vec3) });
    rig.runUntil(() => sim.current.relay.shards[TEAM_FROST]?.status === SHARD_CARRIED, 2000);
    pins.set(thief, { x: 200, y: 400, z: 0 });
    rig.run(500);
    expect(sim.current.relay.shards[TEAM_FROST]?.carrierId).toBe(thief);
    for (const client of rig.clients) {
      expectMirrors(client, sim);
      const shard = client.view.relay.shards[TEAM_FROST];
      expect(shard?.status).toBe(SHARD_CARRIED);
      expect(shard?.carrierId).toBe(thief);
      // Drawn on the carrier as this client draws it (predicted for the thief itself).
      const carrier = findDragonView(client.view, thief);
      expect(carrier).toBeDefined();
      expect(shard?.position).toEqual(carrier?.position);
    }
    expect(objectives.map((event) => event.kind)).toEqual(['pickedUp']);
    expect(objectives[0]).toMatchObject({ team: TEAM_EMBER, dragonId: thief });

    // The carrier goes down: dropped, with the host's countdown.
    sim.applyDamage(thief, 1e6, room.rider(TEAM_FROST), 'primary', DAMAGE_IGNORE_IMMUNITY);
    rig.runUntil(() => sim.current.relay.shards[TEAM_FROST]?.status === SHARD_DROPPED, 2000);
    pins.set(thief, { x: 700, y: 560, z: 0 });
    rig.run(500);
    for (const client of rig.clients) {
      expectMirrors(client, sim);
      const shard = client.view.relay.shards[TEAM_FROST];
      expect(shard?.status).toBe(SHARD_DROPPED);
      expect(shard?.returnInS).toBeGreaterThan(MODE_TUNING.emberRelay.dropReturnS - 2);
      expect(shard?.returnInS).toBeLessThanOrEqual(MODE_TUNING.emberRelay.dropReturnS);
    }
    const before = watcher.view.relay.shards[TEAM_FROST]?.returnInS ?? 0;
    rig.run(2000);
    expect(watcher.view.relay.shards[TEAM_FROST]?.returnInS).toBeCloseTo(before - 2, 0);

    // A Frost rider touches it: home.
    const keeper = room.rider(TEAM_FROST);
    pins.set(keeper, { ...(sim.current.relay.shards[TEAM_FROST]?.position as Vec3) });
    rig.runUntil(() => sim.current.relay.shards[TEAM_FROST]?.status === SHARD_HOME, 2000);
    rig.run(300);
    for (const client of rig.clients) expectMirrors(client, sim);
    expect(objectives.map((event) => event.kind)).toEqual(['pickedUp', 'dropped', 'returned']);
    expect(objectives[2]).toMatchObject({ team: TEAM_FROST, dragonId: keeper });
    rig.dispose();
  });

  it('a capture reaches the score, the scoreboard and the events of every client', () => {
    const room = relayRoom();
    const { rig, sim, pins, objectives } = room;
    const runner = room.rider(TEAM_FROST);
    pins.set(runner, { ...(sim.current.relay.stands[TEAM_EMBER] as Vec3) });
    rig.runUntil(() => sim.current.relay.shards[TEAM_EMBER]?.status === SHARD_CARRIED, 2000);
    pins.set(runner, { ...(sim.current.relay.braziers[TEAM_FROST] as Vec3) });
    rig.runUntil(() => rig.host.matchClock.scoreFrost === 1, 2000);
    pins.set(runner, { x: 700, y: 560, z: 100 });
    // The scoreboard goes out at most once a second.
    rig.run(1500);
    expect(objectives.map((event) => event.kind)).toEqual(['pickedUp', 'captured']);
    expect(objectives[1]).toMatchObject({ team: TEAM_FROST, dragonId: runner });
    for (const client of rig.clients) {
      expectMirrors(client, sim);
      expect(client.view.relay.shards[TEAM_EMBER]?.status).toBe(SHARD_HOME);
      expect(client.session.sample.scoreFrost).toBe(1);
      expect(client.session.sample.scoreEmber).toBe(0);
      const scores = client.session.scores;
      const row = scores.rows.slice(0, scores.count).find((entry) => entry.playerId === runner);
      expect(row === undefined ? -1 : capturesOf(row)).toBe(1);
    }

    // The second capture is the limit: the match ends for everybody with Frost as the winner.
    pins.set(runner, { ...(sim.current.relay.stands[TEAM_EMBER] as Vec3) });
    rig.runUntil(() => sim.current.relay.shards[TEAM_EMBER]?.status === SHARD_CARRIED, 2000);
    pins.set(runner, { ...(sim.current.relay.braziers[TEAM_FROST] as Vec3) });
    rig.runUntil(() => rig.host.matchPhase === 'roundEnd', 2000);
    rig.run(300);
    expect(rig.host.matchWinner).toBe(TEAM_FROST);
    for (const client of rig.clients) {
      expect(client.session.matchPhase).toBe('roundEnd');
      expect(client.session.matchWinner).toBe(TEAM_FROST);
    }
    rig.dispose();
  });

  it('a player who joins mid-match gets the state as it is', () => {
    const room = relayRoom();
    const { rig, sim, pins } = room;
    const thief = room.rider(TEAM_EMBER);
    pins.set(thief, { ...(sim.current.relay.stands[TEAM_FROST] as Vec3) });
    rig.runUntil(() => sim.current.relay.shards[TEAM_FROST]?.status === SHARD_CARRIED, 2000);
    pins.set(thief, { x: 150, y: 420, z: 60 });
    rig.run(300);
    sim.applyDamage(thief, 1e6, NO_PLAYER, 'primary', DAMAGE_IGNORE_IMMUNITY);
    rig.runUntil(() => sim.current.relay.shards[TEAM_FROST]?.status === SHARD_DROPPED, 2000);
    pins.set(thief, { x: 700, y: 560, z: 0 });
    // Meanwhile Frost carries Ember's.
    const runner = room.rider(TEAM_FROST);
    pins.set(runner, { ...(sim.current.relay.stands[TEAM_EMBER] as Vec3) });
    rig.runUntil(() => sim.current.relay.shards[TEAM_EMBER]?.status === SHARD_CARRIED, 2000);
    pins.set(runner, { x: -200, y: 380, z: 0 });
    rig.run(300);

    const late = rig.join('Late');
    expect(late.session.status).toBe('connected');
    rig.runUntil(() => late.session.inMatch && late.session.relay.active, 5000);
    rig.run(500);
    expectMirrors(late, sim);
    expect(late.session.relay.shards[TEAM_FROST]?.status).toBe(SHARD_DROPPED);
    expect(late.session.relay.shards[TEAM_EMBER]?.carrierId).toBe(runner);
    // Its picture shows both: the dropped one where it lies, the carried one on its carrier.
    expect(late.view.relay.active).toBe(true);
    expect(late.view.relay.shards[TEAM_FROST]?.returnInS).toBeGreaterThan(0);
    expect(late.view.relay.shards[TEAM_EMBER]?.position).toEqual(
      findDragonView(late.view, runner)?.position,
    );
    rig.dispose();
  });

  it('a player who reconnects mid-match gets it again, changes made meanwhile included', () => {
    const room = relayRoom();
    const { rig, sim, pins, watcher } = room;
    const thief = room.rider(other(room.teamOf(watcher.session.localPlayerId)));
    const theirs = room.teamOf(watcher.session.localPlayerId);
    rig.hostTransport.sever(rig.clients.indexOf(watcher) + 1);
    rig.run(3);
    expect(watcher.session.status).toBe('reconnecting');
    // While it is away, its team's shard is taken.
    watcher.running = false;
    pins.set(thief, { ...(sim.current.relay.stands[theirs] as Vec3) });
    rig.runUntil(() => sim.current.relay.shards[theirs]?.status === SHARD_CARRIED, 2000);
    pins.set(thief, { x: 0, y: 450, z: 0 });
    rig.run(1000);
    expect(watcher.session.relay.shards[theirs]?.status).not.toBe(SHARD_CARRIED);

    watcher.running = true;
    rig.runUntil(() => watcher.session.status === 'connected', 10_000);
    rig.runUntil(() => watcher.session.inMatch && watcher.session.relay.active, 5000);
    rig.run(500);
    expect(watcher.session.counters.reconnects).toBe(1);
    expectMirrors(watcher, sim);
    expect(watcher.session.relay.shards[theirs]?.carrierId).toBe(thief);
    expect(watcher.view.relay.shards[theirs]?.status).toBe(SHARD_CARRIED);
    rig.dispose();
  });

  it('is gone when the match is over, and stays off in the next match of another mode', () => {
    const room = relayRoom();
    const { rig, sim, pins } = room;
    const thief = room.rider(TEAM_EMBER);
    pins.set(thief, { ...(sim.current.relay.stands[TEAM_FROST] as Vec3) });
    rig.runUntil(() => sim.current.relay.shards[TEAM_FROST]?.status === SHARD_CARRIED, 2000);
    rig.run(300);
    expect(rig.clients[0]?.session.relay.active).toBe(true);

    expect(rig.host.endMatch()).toBe(true);
    rig.run(500);
    for (const client of rig.clients) {
      expect(client.session.inMatch).toBe(false);
      expect(client.session.relay.active).toBe(false);
      expect(client.session.relay.shards[TEAM_FROST]?.status).toBe(SHARD_HOME);
    }

    pins.clear();
    expect(rig.host.applyIntent({ type: 'host.setMode', mode: 'skirmish' })).toBe(true);
    startMatch(rig);
    rig.runTicks(30);
    expect(rig.host.sim?.current.relay.active).toBe(false);
    for (const client of rig.clients) {
      expect(client.session.inMatch).toBe(true);
      expect(client.session.relay.active).toBe(false);
      expect(client.view.relay.active).toBe(false);
    }
    rig.dispose();
  });
});
