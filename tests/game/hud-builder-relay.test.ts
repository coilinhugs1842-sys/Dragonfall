/**
 * The HUD builder in an Ember Relay match (T-6.3): the shard states, the carry call-out, the
 * compass markers, the feed lines from `objective` events, captures on the board and in the
 * results, all from the WorldView and the stats every kind of session offers.
 */

import { describe, expect, it } from 'vitest';
import { createHudBuilder, createHudFrameInput } from '../../src/game/hud-builder';
import type { HudBuilder, HudFrameInput } from '../../src/game/hud-builder';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_FLAG_ALIVE,
  NO_PLAYER,
  SHARD_CARRIED,
  SHARD_DROPPED,
  SHARD_HOME,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createGameEventBus,
  createWorldView,
  writeRelayView,
} from '../../src/shared';
import type {
  GameEventBus,
  LobbyPlayer,
  LobbyState,
  MatchPlayerStats,
  MutableWorldView,
  ObjectiveKind,
  TeamId,
} from '../../src/shared';
import { createRelayState } from '../../src/sim';
import type { RelayState } from '../../src/sim';

const ME = 2;
const MATE = 4;
const FOE = 7;

function lobby(): LobbyState {
  const player = (id: number, name: string, side: TeamId, perch: number): LobbyPlayer => ({
    id,
    name,
    side,
    perch,
    classId: 'talon',
    ready: true,
    isHost: id === ME,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: false,
  });
  return {
    roomCode: 'K7WQD',
    phase: 'inMatch',
    hostId: ME,
    players: [
      player(ME, 'Aman', TEAM_EMBER, 0),
      player(MATE, 'Miro', TEAM_EMBER, 1),
      player(FOE, 'Kestrel', TEAM_FROST, 0),
    ],
    settings: { ...DEFAULT_HOST_SETTINGS, mode: 'emberRelay', teamSize: 2, scoreLimit: 3 },
  };
}

function relayState(): RelayState {
  const relay = createRelayState();
  relay.active = true;
  relay.stands[0] = { x: 0, y: 300, z: -500 };
  relay.stands[1] = { x: 0, y: 300, z: 500 };
  relay.braziers[0] = { x: 60, y: 300, z: -580 };
  relay.braziers[1] = { x: -60, y: 300, z: 580 };
  for (const team of [0, 1]) {
    const shard = relay.shards[team];
    const stand = relay.stands[team];
    if (shard === undefined || stand === undefined) throw new Error('no shard');
    shard.position = { ...stand };
  }
  return relay;
}

interface Scene {
  view: MutableWorldView;
  relay: RelayState;
  builder: HudBuilder;
  bus: GameEventBus;
  input: HudFrameInput;
  /** Rebuilds the view (dragons, then the relay) and runs one HUD frame. */
  frame(dtS?: number): void;
  at: Map<number, { x: number; y: number; z: number }>;
}

function scene(): Scene {
  const view = createWorldView();
  const relay = relayState();
  const builder = createHudBuilder(view);
  const bus = createGameEventBus();
  const input = createHudFrameInput();
  input.isRider = true;
  input.cameraYaw = 0;
  const at = new Map([
    [ME, { x: 0, y: 300, z: 0 }],
    [MATE, { x: 100, y: 300, z: 0 }],
    [FOE, { x: 0, y: 300, z: 400 }],
  ]);
  builder.begin('emberRelay', 3, ME);
  builder.setLobby(lobby());
  builder.connect(bus);
  const frame = (dtS = 1 / 60): void => {
    beginWorldView(view);
    view.localDragonId = ME;
    for (const [id, position] of at) {
      const dragon = acquireDragonView(view);
      dragon.id = id;
      dragon.team = id === FOE ? TEAM_FROST : TEAM_EMBER;
      dragon.classId = 'talon';
      dragon.position.x = position.x;
      dragon.position.y = position.y;
      dragon.position.z = position.z;
      dragon.flags = DRAGON_FLAG_ALIVE;
    }
    view.clock.phase = 'playing';
    view.clock.tick = 900;
    if (relay.active) writeRelayView(view, relay, view.clock.tick);
    bus.flush();
    builder.frame(dtS, input);
  };
  return { view, relay, builder, bus, input, frame, at };
}

function emit(bus: GameEventBus, kind: ObjectiveKind, team: TeamId, dragonId: number): void {
  bus.emit({ type: 'objective', tick: 1, kind, team, dragonId, position: { x: 0, y: 0, z: 0 } });
}

function shardOf(relay: RelayState, team: TeamId): RelayState['shards'][number] {
  const shard = relay.shards[team];
  if (shard === undefined) throw new Error('no shard');
  return shard;
}

describe('HUD builder: Ember Relay', () => {
  it('has no relay state outside the mode', () => {
    const s = scene();
    s.relay.active = false;
    s.frame();
    expect(s.builder.hud.relay).toBeNull();
    expect(s.builder.hud.compassCount).toBe(1);
    expect(s.builder.hud.compass[0]?.kind).toBe('ally');
  });

  it('reports both shards, who carries one and how long a dropped one stays', () => {
    const s = scene();
    s.frame();
    const relay = s.builder.hud.relay;
    expect(relay).not.toBeNull();
    expect(relay?.shards.map((shard) => shard.status)).toEqual([SHARD_HOME, SHARD_HOME]);
    expect(relay?.carrying).toBe(false);

    const frost = shardOf(s.relay, TEAM_FROST);
    frost.status = SHARD_CARRIED;
    frost.carrierId = MATE;
    const ember = shardOf(s.relay, TEAM_EMBER);
    ember.status = SHARD_DROPPED;
    ember.position = { x: 300, y: 250, z: 0 };
    ember.returnTick = 900 + 30 * 12;
    s.frame();
    expect(relay?.shards[TEAM_FROST]).toMatchObject({ status: SHARD_CARRIED, carrierName: 'Miro' });
    expect(relay?.shards[TEAM_EMBER].status).toBe(SHARD_DROPPED);
    expect(relay?.shards[TEAM_EMBER].returnInS).toBeCloseTo(12, 6);
    expect(relay?.shards[TEAM_EMBER].carrierName).toBe('');
    // A mate has it, not the local rider.
    expect(relay?.carrying).toBe(false);
  });

  it('raises the carry call-out for the local carrier only, with the distance home', () => {
    const s = scene();
    const frost = shardOf(s.relay, TEAM_FROST);
    frost.status = SHARD_CARRIED;
    frost.carrierId = ME;
    s.at.set(ME, { x: 60, y: 300, z: -280 });
    s.frame();
    expect(s.builder.hud.relay?.carrying).toBe(true);
    expect(s.builder.hud.relay?.brazierDistanceM).toBeCloseTo(300, 6);

    // A spectator never carries.
    s.input.isRider = false;
    s.frame();
    expect(s.builder.hud.relay?.carrying).toBe(false);
    expect(s.builder.hud.relay?.brazierDistanceM).toBe(0);
    expect(s.builder.hud.relay?.shards[TEAM_FROST].carrierName).toBe('Aman');
  });

  it('points the compass at the enemy shard and the own brazier, and at the own shard once it is gone', () => {
    const s = scene();
    s.frame();
    const hud = s.builder.hud;
    const kinds = (): string[] =>
      hud.compass.slice(0, hud.compassCount).map((marker) => `${marker.kind}:${marker.team}`);
    // Enemy shard, own brazier, then the team mate.
    expect(kinds()).toEqual([`shard:${TEAM_FROST}`, `brazier:${TEAM_EMBER}`, `ally:${TEAM_EMBER}`]);
    // The Frost stand is 500 m dead ahead (camera yaw 0 looks along +Z), the brazier behind.
    expect(hud.compass[0]?.distanceM).toBeCloseTo(500, 6);
    expect(hud.compass[0]?.angle).toBeCloseTo(0, 6);
    expect(Math.abs(hud.compass[1]?.angle ?? 0)).toBeGreaterThan(Math.PI / 2);
    expect(hud.compass[0]?.alive).toBe(true);

    // Own shard stolen: its marker follows the thief.
    const ember = shardOf(s.relay, TEAM_EMBER);
    ember.status = SHARD_CARRIED;
    ember.carrierId = FOE;
    s.frame();
    expect(kinds()).toEqual([
      `shard:${TEAM_FROST}`,
      `shard:${TEAM_EMBER}`,
      `brazier:${TEAM_EMBER}`,
      `ally:${TEAM_EMBER}`,
    ]);
    expect(hud.compass[1]?.distanceM).toBeCloseTo(400, 6);

    // In the local rider's own claws the enemy shard needs no marker.
    const frost = shardOf(s.relay, TEAM_FROST);
    frost.status = SHARD_CARRIED;
    frost.carrierId = ME;
    s.frame();
    expect(kinds()).toEqual([`shard:${TEAM_EMBER}`, `brazier:${TEAM_EMBER}`, `ally:${TEAM_EMBER}`]);
  });

  it('turns objective events into feed lines about the right shard', () => {
    const s = scene();
    s.frame();
    const hud = s.builder.hud;
    // An Ember rider takes it: good for Ember, the shard is Frost's.
    emit(s.bus, 'pickedUp', TEAM_EMBER, ME);
    s.frame();
    expect(hud.killfeedCount).toBe(1);
    expect(hud.killfeed[0]).toMatchObject({
      objective: 'pickedUp',
      killerId: ME,
      killerName: 'Aman',
      killerTeam: TEAM_EMBER,
      victimTeam: TEAM_FROST,
    });
    expect(hud.relayPool).toMatchObject({ noticeKind: 'pickedUp', noticeTeam: TEAM_FROST });
    // Not a takedown: no hit marker for it.
    expect(hud.takedownSeq).toBe(0);

    // The carrier goes down: good for Frost, whose shard it is.
    emit(s.bus, 'dropped', TEAM_FROST, ME);
    // It goes home by itself: nobody did it.
    emit(s.bus, 'returned', TEAM_FROST, NO_PLAYER);
    // Frost captures Ember's.
    emit(s.bus, 'captured', TEAM_FROST, FOE);
    s.frame();
    expect(hud.killfeedCount).toBe(4);
    expect(hud.killfeed[2]).toMatchObject({ objective: 'dropped', killerId: ME, victimTeam: TEAM_FROST });
    expect(hud.killfeed[1]).toMatchObject({
      objective: 'returned',
      killerId: NO_PLAYER,
      killerTeam: null,
      victimTeam: TEAM_FROST,
    });
    expect(hud.killfeed[0]).toMatchObject({
      objective: 'captured',
      killerName: 'Kestrel',
      killerTeam: TEAM_FROST,
      victimTeam: TEAM_EMBER,
    });
    expect(hud.relayPool).toMatchObject({ noticeKind: 'captured', noticeTeam: TEAM_EMBER });
    // Sky Crown's kind is not Ember Relay's business.
    emit(s.bus, 'zoneTaken', TEAM_EMBER, ME);
    s.frame();
    expect(hud.killfeedCount).toBe(4);
  });

  it('shows captures on the board and names the best carrier in the results', () => {
    const s = scene();
    const row = (playerId: number, takedowns: number, captures?: number): MatchPlayerStats =>
      ({
        playerId,
        takedowns,
        deaths: 1,
        assists: 0,
        damage: takedowns * 100,
        healing: 0,
        ...(captures === undefined ? {} : { captures }),
      }) as MatchPlayerStats;
    s.input.stats = [row(ME, 1, 2), row(MATE, 6, 0), row(FOE, 3)];
    s.input.statsCount = 3;
    s.input.scoreEmber = 2;
    s.input.scoreFrost = 0;
    s.frame();
    const hud = s.builder.hud;
    const board = hud.scoreboard.slice(0, hud.scoreboardCount);
    expect(board.map((entry) => [entry.playerId, entry.captures])).toEqual([
      [ME, 2],
      [MATE, 0],
      // A row without the field (an older table) counts none.
      [FOE, 0],
    ]);

    const results = s.builder.buildResults(TEAM_EMBER);
    expect(results.mode).toBe('emberRelay');
    expect(results.scores).toEqual([2, 0]);
    expect(results.mostCapturesId).toBe(ME);
    expect(results.mostTakedownsId).toBe(MATE);
    // Two shards home outweigh five more takedowns.
    expect(results.mvpId).toBe(ME);
    expect(results.scoreboard.find((entry) => entry.playerId === ME)?.captures).toBe(2);

    // Another mode's results carry no captures award.
    s.builder.begin('skirmish', 30, ME);
    s.builder.setLobby(lobby());
    s.relay.active = false;
    s.frame();
    const plain = s.builder.buildResults(TEAM_EMBER);
    expect(plain.mode).toBe('skirmish');
    expect('mostCapturesId' in plain).toBe(false);
  });

  it('builds the frame without allocating', () => {
    const s = scene();
    const frost = shardOf(s.relay, TEAM_FROST);
    frost.status = SHARD_CARRIED;
    frost.carrierId = ME;
    for (let i = 0; i < 50; i++) s.frame();
    const hud = s.builder.hud;
    const relayBefore = hud.relay;
    const shardBefore = hud.relay?.shards[0];
    const markerBefore = hud.compass[0];
    s.frame();
    // The same pooled objects, rewritten in place.
    expect(hud.relay).toBe(relayBefore);
    expect(hud.relay?.shards[0]).toBe(shardBefore);
    expect(hud.compass[0]).toBe(markerBefore);
  });
});
