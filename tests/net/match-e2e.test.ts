/**
 * Modes and lag compensation end to end (T-3.3 / T-3.4): a HostSession and real ClientSessions
 * on the loopback hub. The host decides; the phase, the round, the winner, the score and the
 * storm reach the client through MATCH_PHASE, the reliable events and the snapshot clock, and
 * the client's prediction stands still through every countdown.
 */

import { describe, expect, it } from 'vitest';
import { createNetsimProfile } from '../../src/dev/netsim';
import { createGreyboxMatchWorld } from '../../src/net/session';
import {
  DRAGON_FLAG_ALIVE,
  LAG_COMP_MAX_REWIND_MS,
  MODE_TUNING,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
} from '../../src/shared';
import type {
  GameEvent,
  MatchPhase,
  MatchPhaseEvent,
  ModeTuning,
  PlayerId,
  TeamId,
  UiIntent,
} from '../../src/shared';
import { DAMAGE_IGNORE_IMMUNITY } from '../../src/sim';
import { Rig, startMatch } from './session-harness';
import type { RigClient, RigOptions } from './session-harness';

/** Short beats so a whole match fits in a test. */
function fastTuning(): ModeTuning {
  return {
    ...MODE_TUNING,
    roundEndS: 0.5,
    resultsS: 1,
    forfeitGraceS: 1,
    skirmish: { overtimeS: 2 },
    duel: { ...MODE_TUNING.duel, stormHoldS: 0.5, stormShrinkS: 4 },
  };
}

interface Room {
  readonly rig: Rig;
  readonly client: RigClient;
  /** matchPhase events as the CLIENT received them. */
  readonly phaseEvents: MatchPhaseEvent[];
  readonly clientEvents: GameEvent[];
  readonly hostId: PlayerId;
  readonly clientId: PlayerId;
  readonly hostTeam: TeamId;
  readonly clientTeam: TeamId;
}

function room1v1(intents: UiIntent[], options: RigOptions = {}): Room {
  const rig = new Rig({
    ...options,
    host: { modeTuning: fastTuning(), respawnTicks: TICK_HZ, ...options.host },
  }).open();
  const clientEvents: GameEvent[] = [];
  const phaseEvents: MatchPhaseEvent[] = [];
  const client = rig.join('Rider 1', {
    events: {
      emit: (event) => {
        const copy = structuredClone(event);
        clientEvents.push(copy);
        if (copy.type === 'matchPhase') phaseEvents.push(copy);
      },
    },
  });
  for (const intent of [{ type: 'host.setTeamSize', teamSize: 1 } as UiIntent, ...intents]) {
    if (!rig.host.applyIntent(intent)) throw new Error(`refused: ${intent.type}`);
  }
  startMatch(rig);
  const hostId = rig.host.localPlayerId;
  const clientId = client.session.localPlayerId;
  const sideOf = (id: PlayerId): TeamId => {
    const side = rig.host.lobby.players.find((player) => player.id === id)?.side;
    if (side !== TEAM_EMBER && side !== TEAM_FROST) throw new Error('not on a team');
    return side;
  };
  return {
    rig,
    client,
    phaseEvents,
    clientEvents,
    hostId,
    clientId,
    hostTeam: sideOf(hostId),
    clientTeam: sideOf(clientId),
  };
}

function kill(rig: Rig, victim: PlayerId, killer: PlayerId): void {
  const removed = rig.host.sim?.applyDamage(victim, 1e6, killer, 'primary', DAMAGE_IGNORE_IMMUNITY);
  if (!(removed !== undefined && removed > 0)) throw new Error('kill failed');
}

function isAlive(rig: Rig, id: PlayerId): boolean {
  const dragon = rig.host.sim?.getDragon(id);
  return dragon !== undefined && (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
}

function scoreOf(room: Room, team: TeamId, where: 'host' | 'client'): number {
  if (where === 'host') {
    const clock = room.rig.host.matchClock;
    return team === TEAM_EMBER ? clock.scoreEmber : clock.scoreFrost;
  }
  const sample = room.client.session.sample;
  return team === TEAM_EMBER ? sample.scoreEmber : sample.scoreFrost;
}

function untilPhase(rig: Rig, phase: MatchPhase, maxMs = 60_000): void {
  rig.runUntil(() => rig.host.matchPhase === phase, maxMs);
}

describe('Skirmish over the loopback', () => {
  it('scores, the winner and the whole timeline reach the client; then back to the lobby', () => {
    const room = room1v1([
      { type: 'host.setMode', mode: 'skirmish' },
      { type: 'host.setScoreLimit', scoreLimit: 2 },
      { type: 'host.setTimeLimit', timeLimitS: 120 },
    ]);
    const { rig, client, hostId, clientId, hostTeam, clientTeam } = room;
    expect(rig.host.modeConfig).toMatchObject({ mode: 'skirmish', scoreLimit: 2, sandbox: false });
    expect(rig.host.lobby.phase).toBe('inMatch');
    // The clock counts the time limit down, on the client too.
    rig.run(500);
    expect(client.session.matchPhase).toBe('playing');
    expect(rig.host.matchClock.timeRemainingS).toBeLessThan(120);
    expect(client.view.clock.timeRemainingS).toBeLessThan(120);
    expect(client.view.clock.timeRemainingS).toBeGreaterThan(115);
    expect(client.view.clock.round).toBe(1);

    kill(rig, clientId, hostId);
    rig.run(400);
    expect(scoreOf(room, hostTeam, 'host')).toBe(1);
    expect(scoreOf(room, hostTeam, 'client')).toBe(1);
    expect(scoreOf(room, clientTeam, 'client')).toBe(0);
    expect(rig.host.matchPhase).toBe('playing');

    // Respawn at the gate, then the deciding takedown.
    rig.runUntil(() => isAlive(rig, clientId), 5000);
    kill(rig, clientId, hostId);
    untilPhase(rig, 'roundEnd');
    rig.run(300);
    expect(client.session.matchPhase).toBe('roundEnd');
    expect(client.session.matchWinner).toBe(hostTeam);
    expect(scoreOf(room, hostTeam, 'client')).toBe(2);
    expect(client.view.clock.phase).toBe('roundEnd');

    untilPhase(rig, 'results');
    expect(rig.host.matchWinner).toBe(hostTeam);
    rig.run(300);
    expect(client.session.matchPhase).toBe('results');
    expect(client.session.matchWinner).toBe(hostTeam);

    // The host's score sheet for the scoreboard and the podium.
    const stats = rig.host.matchStats.slice(0, rig.host.matchStatsCount);
    expect(stats.find((row) => row.playerId === hostId)).toMatchObject({
      takedowns: 2,
      deaths: 0,
      team: hostTeam,
    });
    expect(stats.find((row) => row.playerId === clientId)).toMatchObject({
      takedowns: 0,
      deaths: 2,
    });
    expect(stats.find((row) => row.playerId === hostId)?.damage).toBeGreaterThan(100);

    // Results over: everyone is back in the lobby, teams kept, nobody ready.
    rig.runUntil(() => !rig.host.inMatch, 10_000);
    rig.run(300);
    expect(rig.host.lobby.phase).toBe('lobby');
    expect(rig.host.matchPhase).toBe('lobby');
    expect(client.session.inMatch).toBe(false);
    expect(client.session.lobby?.phase).toBe('lobby');
    expect(client.session.matchWinner).toBeNull();

    // What the client's event bus saw, in order.
    const seen = room.phaseEvents.map((event) => [event.phase, event.round, event.winner]);
    expect(seen).toEqual([
      ['countdown', 1, null],
      ['playing', 1, null],
      ['roundEnd', 1, hostTeam],
      ['results', 1, hostTeam],
      ['lobby', 1, null],
    ]);
    expect(room.clientEvents.filter((event) => event.type === 'takedown')).toHaveLength(2);

    // And the room can start another match.
    client.session.sendIntent({ type: 'lobby.ready', ready: true });
    rig.run(300);
    expect(rig.host.applyIntent({ type: 'host.start' })).toBe(true);
    untilPhase(rig, 'playing');
    expect(scoreOf(room, hostTeam, 'host')).toBe(0);
    expect(rig.host.matchStats[0]?.takedowns).toBe(0);
    rig.dispose();
  });

  it('the host can still end a match by hand in any phase', () => {
    const room = room1v1([{ type: 'host.setScoreLimit', scoreLimit: 1 }]);
    const { rig, client, hostId, clientId } = room;
    kill(rig, clientId, hostId);
    untilPhase(rig, 'roundEnd');
    expect(rig.host.endMatch()).toBe(true);
    rig.run(300);
    expect(rig.host.inMatch).toBe(false);
    expect(client.session.inMatch).toBe(false);
    expect(rig.host.lobby.phase).toBe('lobby');
    rig.dispose();
  });
});

describe('veil over the loopback', () => {
  it('events that would give a veiled dragon away reach its own side only', () => {
    const hostEvents: GameEvent[] = [];
    const room = room1v1(
      [
        { type: 'host.setMode', mode: 'skirmish' },
        { type: 'host.setScoreLimit', scoreLimit: 50 },
      ],
      { host: { events: { emit: (event) => void hostEvents.push(structuredClone(event)) } } },
    );
    const { rig, clientEvents, hostId, clientId } = room;
    untilPhase(rig, 'playing');
    // Past spawn protection, which stops a status.
    rig.run(2500);
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    const hitsOn = (events: GameEvent[], id: PlayerId): number =>
      events.filter((event) => event.type === 'hit' && event.targetId === id).length;
    const statusesOn = (events: GameEvent[], id: PlayerId): number =>
      events.filter((event) => event.type === 'statusApplied' && event.targetId === id).length;
    const veil = (id: PlayerId): void => {
      const dragon = sim.getDragon(id);
      if (dragon === undefined) throw new Error('no dragon');
      dragon.veilTicks = TICK_HZ;
    };

    // In plain sight: both sides get the hit.
    sim.applyDamage(clientId, 5, hostId, 'primary', DAMAGE_IGNORE_IMMUNITY);
    rig.run(300);
    expect(hitsOn(hostEvents, clientId)).toBe(1);
    expect(hitsOn(clientEvents, clientId)).toBe(1);

    // The client's dragon is veiled: the host's page (its enemy) is told nothing.
    veil(clientId);
    sim.applyDamage(clientId, 5, hostId, 'primary', DAMAGE_IGNORE_IMMUNITY);
    sim.applyStatus(clientId, 'burn', 2, 5, hostId);
    rig.run(100);
    expect(hitsOn(hostEvents, clientId)).toBe(1);
    expect(statusesOn(hostEvents, clientId)).toBe(0);
    expect(hitsOn(clientEvents, clientId)).toBeGreaterThanOrEqual(2);
    expect(statusesOn(clientEvents, clientId)).toBe(1);

    // The host's dragon is veiled: the client (its enemy) is told nothing, the host is.
    const clientDragon = sim.getDragon(clientId);
    if (clientDragon !== undefined) clientDragon.veilTicks = 0;
    veil(hostId);
    const before = hitsOn(clientEvents, hostId);
    sim.applyDamage(hostId, 5, clientId, 'primary', DAMAGE_IGNORE_IMMUNITY);
    rig.run(100);
    expect(hitsOn(clientEvents, hostId)).toBe(before);
    expect(hitsOn(hostEvents, hostId)).toBe(before + 1);

    // A takedown is never hidden: the score and the killfeed need it.
    veil(hostId);
    kill(rig, hostId, clientId);
    rig.run(300);
    expect(clientEvents.filter((event) => event.type === 'takedown')).toHaveLength(1);
    expect(hostEvents.filter((event) => event.type === 'takedown')).toHaveLength(1);
    rig.dispose();
  });
});

describe('Duel over the loopback', () => {
  it('rounds, resets and countdowns: the client follows and its prediction stays exact', () => {
    const room = room1v1([{ type: 'host.setMode', mode: 'duel' }]);
    const { rig, client, hostId, clientId, hostTeam, clientTeam } = room;
    expect(rig.host.modeConfig).toMatchObject({ mode: 'duel', scoreLimit: 3, respawns: false });
    const firstStart = rig.host.matchStartTick;

    // Round 1 to the host.
    rig.run(1000);
    kill(rig, clientId, hostId);
    untilPhase(rig, 'roundEnd');
    expect(rig.host.matchWinner).toBe(hostTeam);
    // No respawn inside the round, however long the beat.
    expect(isAlive(rig, clientId)).toBe(false);

    // Round 2: everyone back at the gates, held for the countdown.
    untilPhase(rig, 'countdown');
    expect(rig.host.matchRound).toBe(2);
    expect(isAlive(rig, clientId)).toBe(true);
    const secondStart = rig.host.matchStartTick;
    expect(secondStart).toBeGreaterThan(firstStart);
    expect(secondStart - rig.host.hostTick).toBe(45);
    const gate = { ...(rig.host.sim?.getDragon(clientId)?.position ?? { x: 0, y: 0, z: 0 }) };
    rig.run(700);
    expect(rig.host.matchPhase).toBe('countdown');
    expect(client.session.matchPhase).toBe('countdown');
    expect(client.session.matchRound).toBe(2);
    expect(client.session.matchStartTick).toBe(secondStart);
    expect(client.session.predictor.simStartTick).toBe(secondStart);
    // The client's own dragon stands at its gate: prediction is not running ahead of the host.
    const predicted = client.session.predictor.dragon.position;
    expect(
      Math.hypot(predicted.x - gate.x, predicted.y - gate.y, predicted.z - gate.z),
    ).toBeLessThan(0.01);
    expect(scoreOf(room, hostTeam, 'client')).toBe(1);
    expect(client.view.clock.round).toBe(2);

    // Into round 2: prediction picks up on the right tick, with nothing to correct.
    untilPhase(rig, 'playing');
    expect(rig.host.hostTick).toBe(secondStart);
    rig.run(1500);
    expect(client.session.matchPhase).toBe('playing');
    expect(client.session.predictor.lastCorrectionM).toBeLessThan(0.05);
    const hostSees = rig.host.sim?.getDragon(clientId)?.position;
    expect(hostSees).toBeDefined();
    expect(Math.hypot((hostSees?.x ?? 0) - gate.x, (hostSees?.z ?? 0) - gate.z)).toBeGreaterThan(
      20,
    );

    // Round 2 to the client, rounds 3 and 4 to the host: 3-1.
    kill(rig, hostId, clientId);
    untilPhase(rig, 'roundEnd');
    expect(rig.host.matchWinner).toBe(clientTeam);
    for (let round = 3; round <= 4; round++) {
      untilPhase(rig, 'playing');
      expect(rig.host.matchRound).toBe(round);
      rig.run(200);
      kill(rig, clientId, hostId);
      untilPhase(rig, 'roundEnd');
    }
    expect(scoreOf(room, hostTeam, 'host')).toBe(3);
    expect(scoreOf(room, clientTeam, 'host')).toBe(1);
    untilPhase(rig, 'results');
    rig.run(300);
    expect(client.session.matchPhase).toBe('results');
    expect(client.session.matchWinner).toBe(hostTeam);
    expect(client.session.matchRound).toBe(4);
    expect(scoreOf(room, hostTeam, 'client')).toBe(3);
    expect(scoreOf(room, clientTeam, 'client')).toBe(1);

    rig.runUntil(() => !rig.host.inMatch, 10_000);
    rig.run(300);
    expect(client.session.inMatch).toBe(false);

    const seen = room.phaseEvents.map((event) => `${event.phase}${event.round}`);
    expect(seen).toEqual([
      'countdown1',
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
      'lobby4',
    ]);
    const winners = room.phaseEvents
      .filter((event) => event.phase === 'roundEnd' || event.phase === 'results')
      .map((event) => event.winner);
    expect(winners).toEqual([hostTeam, clientTeam, hostTeam, hostTeam, hostTeam]);
    rig.dispose();
  });

  it('the shrinking storm wall reaches the client in snapshots', () => {
    const world = createGreyboxMatchWorld();
    const room = room1v1([{ type: 'host.setMode', mode: 'duel' }], {
      createMatchWorld: () => world,
    });
    const { rig, client } = room;
    const director = rig.host.director;
    // Round 1 starts on the map's own radius...
    expect(director.stormRadius).toBeCloseTo(world.radius, 6);
    rig.runUntil(() => director.stormRadius < world.radius - 50 || !rig.host.inMatch, 10_000);
    expect(rig.host.inMatch).toBe(true);
    // ...and closes; the client's snapshots carry the same wall (0.1 m steps on the wire).
    rig.run(150);
    const onHost = rig.host.sim?.current.stormRadius ?? -1;
    expect(onHost).toBe(director.stormRadius);
    expect(client.session.sample.stormRadius).toBeGreaterThan(0);
    expect(client.session.sample.stormRadius).toBeLessThan(world.radius - 50);
    // The client trails the host by its interpolation delay: a few ticks of shrinking.
    expect(Math.abs(client.session.sample.stormRadius - onHost)).toBeLessThan(80);
    rig.dispose();
  });

  it('a rider who drops forfeits rounds after the grace, and the match is decided', () => {
    const room = room1v1([{ type: 'host.setMode', mode: 'duel' }]);
    const { rig, client, hostTeam } = room;
    rig.run(500);
    client.running = false;
    rig.hostTransport.sever(rig.clients.indexOf(client) + 1);
    rig.run(100);
    // The seat is held (the dragon circles), so the round goes on for the grace.
    expect(rig.host.lobby.players.some((player) => !player.connected)).toBe(true);
    expect(rig.host.matchPhase).toBe('playing');
    untilPhase(rig, 'roundEnd', 5000);
    expect(rig.host.matchWinner).toBe(hostTeam);
    expect(rig.host.director.endReason).toBe('forfeit');
    expect(rig.host.matchClock.scoreEmber + rig.host.matchClock.scoreFrost).toBe(1);

    // Nobody comes back: round after round is given up until the match is over.
    untilPhase(rig, 'results', 40_000);
    expect(rig.host.matchWinner).toBe(hostTeam);
    rig.runUntil(() => !rig.host.inMatch, 10_000);
    expect(rig.host.lobby.phase).toBe('lobby');
    rig.dispose();
  });
});

describe('lag compensation over the loopback', () => {
  it('measures each client from its INPUT packets; the host and bots get none', () => {
    // 50 ms each way.
    const rig = new Rig({
      netsim: createNetsimProfile(50),
      host: { modeTuning: fastTuning() },
    }).open();
    const human = rig.join('Human');
    const bot = rig.join('Bot');
    rig.host.setPlayerIsBot(bot.session.localPlayerId, true);
    rig.host.applyIntent({ type: 'host.setTeamSize', teamSize: 2 });
    rig.host.applyIntent({ type: 'host.setUnevenTeams', enabled: true });
    startMatch(rig);
    rig.run(3000);

    const lagComp = rig.host.lagComp;
    const rewindMs = lagComp.rewindMsOf(human.session.localPlayerId);
    // Round trip (100 ms) + input margin + interpolation delay (100 ms) is past the cap.
    expect(rewindMs).toBeGreaterThan(150);
    expect(rewindMs).toBeLessThanOrEqual(LAG_COMP_MAX_REWIND_MS);
    expect(lagComp.rewindMsOf(rig.host.localPlayerId)).toBe(0);
    expect(lagComp.rewindMsOf(bot.session.localPlayerId)).toBe(0);
    // The history follows the sim.
    expect(lagComp.historyLengthOf(human.session.localPlayerId)).toBeGreaterThanOrEqual(10);
    rig.dispose();
  });

  it('on a clean link the rewind is about the interpolation delay plus the input lead', () => {
    const rig = new Rig({ host: { modeTuning: fastTuning() } }).open();
    const client = rig.join('Rider 1');
    startMatch(rig);
    rig.run(2000);
    const rewindMs = rig.host.lagComp.rewindMsOf(client.session.localPlayerId);
    expect(rewindMs).toBeGreaterThan(90);
    expect(rewindMs).toBeLessThan(190);
    // A session can run without it.
    const plain = new Rig({ host: { lagCompensation: false } }).open();
    plain.join('Rider 1');
    startMatch(plain);
    expect(plain.host.lagComp.enabled).toBe(false);
    rig.dispose();
    plain.dispose();
  });
});
