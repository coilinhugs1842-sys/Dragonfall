/**
 * SCOREBOARD (per-rider totals, host -> clients) and the host's own slot-fill bots at session
 * level: the wire round trip, the table reaching a real client, and a room filled with bots the
 * host flies itself playing a match that is decided by its score, not by a forfeit.
 */

import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/net/codec/io';
import { MSG_SCOREBOARD, isMessageType } from '../../src/net/protocol';
import {
  SCOREBOARD_MAX_BYTES,
  SCOREBOARD_MAX_ROWS,
  createScoreTable,
  decodeScoreboard,
  encodeScoreboard,
} from '../../src/net/session';
import { MODE_TUNING, TEAM_EMBER, TEAM_FROST, TICK_HZ } from '../../src/shared';
import type { GameEvent, MatchPlayerStats, ModeTuning } from '../../src/shared';
import { DAMAGE_IGNORE_IMMUNITY } from '../../src/sim';
import { Rig, startMatch } from './session-harness';

function row(playerId: number, team: 0 | 1, takedowns: number): MatchPlayerStats {
  return {
    playerId,
    team,
    present: playerId % 2 === 0,
    takedowns,
    deaths: takedowns + 1,
    assists: takedowns * 2,
    damage: 123.4 * (playerId + 1),
    healing: 7.6,
  };
}

function readerFor(writer: Writer, length: number): Reader {
  const bytes = writer.packet(length).slice();
  return new Reader().reset(new DataView(bytes.buffer));
}

describe('SCOREBOARD codec', () => {
  it('is a known message type', () => {
    expect(isMessageType(MSG_SCOREBOARD)).toBe(true);
  });

  it('round-trips every row (damage and healing as whole HP)', () => {
    const stats = [row(0, TEAM_EMBER, 3), row(1, TEAM_FROST, 0), row(7, TEAM_FROST, 12)];
    const writer = new Writer(SCOREBOARD_MAX_BYTES);
    const length = encodeScoreboard(writer, 4242, stats, stats.length);
    expect(length).toBe(4 + 3 * 13);
    const table = createScoreTable();
    expect(decodeScoreboard(readerFor(writer, length), table)).toBe(true);
    expect(table.count).toBe(3);
    // Rows without `captures` (any mode but Ember Relay) arrive as 0.
    expect(table.rows.slice(0, 3).map((entry) => entry.captures)).toEqual([0, 0, 0]);
    for (let i = 0; i < stats.length; i++) {
      const sent = stats[i];
      const got = table.rows[i];
      expect(got).toMatchObject({
        playerId: sent?.playerId,
        team: sent?.team,
        present: sent?.present,
        takedowns: sent?.takedowns,
        deaths: sent?.deaths,
        assists: sent?.assists,
        damage: Math.round(sent?.damage ?? 0),
        healing: Math.round(sent?.healing ?? 0),
      });
    }
  });

  it('saturates instead of wrapping and honours the live count', () => {
    const huge: MatchPlayerStats = { ...row(2, TEAM_EMBER, 70_000), damage: 1e9, healing: -5 };
    const writer = new Writer(SCOREBOARD_MAX_BYTES);
    // Two rows are in the array; only the first is live.
    const length = encodeScoreboard(writer, 0, [huge, row(3, TEAM_FROST, 1)], 1);
    const table = createScoreTable();
    expect(decodeScoreboard(readerFor(writer, length), table)).toBe(true);
    expect(table.count).toBe(1);
    expect(table.rows[0]).toMatchObject({ takedowns: 0xffff, damage: 0xffff, healing: 0 });
  });

  it('carries Ember Relay captures per rider', () => {
    const stats = [
      { ...row(0, TEAM_EMBER, 3), captures: 2 },
      { ...row(1, TEAM_FROST, 0), captures: 0 },
      { ...row(4, TEAM_FROST, 1), captures: 999 },
    ];
    const writer = new Writer(SCOREBOARD_MAX_BYTES);
    const length = encodeScoreboard(writer, 7, stats, stats.length);
    const table = createScoreTable();
    expect(decodeScoreboard(readerFor(writer, length), table)).toBe(true);
    expect(table.rows.slice(0, 3).map((entry) => entry.captures)).toEqual([2, 0, 255]);
  });

  it('fits the largest table and refuses malformed input', () => {
    const stats: MatchPlayerStats[] = [];
    for (let i = 0; i < SCOREBOARD_MAX_ROWS + 5; i++) stats.push(row(i, TEAM_EMBER, i));
    const writer = new Writer(SCOREBOARD_MAX_BYTES);
    const length = encodeScoreboard(writer, 1, stats, stats.length);
    expect(length).toBe(SCOREBOARD_MAX_BYTES);
    const table = createScoreTable();
    expect(decodeScoreboard(readerFor(writer, length), table)).toBe(true);
    expect(table.count).toBe(SCOREBOARD_MAX_ROWS);

    // Truncated, padded, and a count beyond the table.
    const good = writer.packet(length).slice();
    for (const bytes of [good.slice(0, length - 3), new Uint8Array([...good, 0])]) {
      expect(decodeScoreboard(new Reader().reset(new DataView(bytes.buffer)), table)).toBe(false);
    }
    const lying = good.slice();
    lying[3] = 255;
    expect(decodeScoreboard(new Reader().reset(new DataView(lying.buffer)), table)).toBe(false);
  });
});

function fastTuning(): ModeTuning {
  return { ...MODE_TUNING, roundEndS: 0.5, resultsS: 1, forfeitGraceS: 2 };
}

describe('scoreboard and slot-fill bots in a session', () => {
  it('sends the host-counted totals to a client with the result', () => {
    const rig = new Rig({ host: { modeTuning: fastTuning(), respawnTicks: TICK_HZ } }).open();
    const client = rig.join('Rider 1');
    for (const intent of [
      { type: 'host.setTeamSize', teamSize: 1 } as const,
      { type: 'host.setScoreLimit', scoreLimit: 1 } as const,
    ]) {
      expect(rig.host.applyIntent(intent)).toBe(true);
    }
    startMatch(rig);
    const hostId = rig.host.localPlayerId;
    const clientId = client.session.localPlayerId;
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    // The host takes the client down: one takedown, the score limit.
    sim.applyDamage(clientId, 10_000, hostId, 'primary', DAMAGE_IGNORE_IMMUNITY);
    rig.runUntil(() => rig.host.matchPhase === 'results', 10_000);
    rig.run(300);
    const scores = client.session.scores;
    expect(scores.count).toBe(2);
    const byId = (id: number): MatchPlayerStats | undefined =>
      scores.rows.slice(0, scores.count).find((entry) => entry.playerId === id);
    expect(byId(hostId)).toMatchObject({ takedowns: 1, deaths: 0, present: true });
    expect(byId(clientId)).toMatchObject({ takedowns: 0, deaths: 1, present: true });
    expect(byId(hostId)?.damage).toBeGreaterThan(0);
    expect(client.session.matchWinner).toBe(rig.host.matchWinner);
  });

  it('flies the bots the host seated, and never counts them as disconnected', () => {
    const events: GameEvent[] = [];
    const rig = new Rig({
      host: {
        modeTuning: fastTuning(),
        localBot: true,
        events: { emit: (event) => events.push(structuredClone(event)) },
      },
    }).open();
    for (const intent of [
      { type: 'host.setTeamSize', teamSize: 2 } as const,
      { type: 'host.setTimeLimit', timeLimitS: 0 } as const,
      { type: 'host.setScoreLimit', scoreLimit: 200 } as const,
      { type: 'host.setBotDifficulty', difficulty: 'hard' } as const,
      { type: 'host.fillBots' } as const,
    ]) {
      expect(rig.host.applyIntent(intent)).toBe(true);
    }
    expect(rig.host.lobby.players.filter((player) => player.isBot)).toHaveLength(3);
    expect(rig.host.lobby.settings.botDifficulty).toBe('hard');
    startMatch(rig);
    // Three seated bots plus the host's own dragon (`localBot`).
    expect(rig.host.hostBots.count).toBe(4);
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');

    // Well past the forfeit grace (2 s here): a team of bots has not "left".
    rig.run(45_000);
    expect(rig.host.inMatch).toBe(true);
    expect(rig.host.matchPhase).toBe('playing');
    // They fly (nobody sits at the gate) and they fight.
    const casts = events.filter((event) => event.type === 'abilityCast').length;
    const hits = events.filter(
      (event) => event.type === 'hit' && event.source !== 'terrain' && event.source !== 'storm',
    ).length;
    expect(casts).toBeGreaterThan(10);
    expect(hits).toBeGreaterThan(0);
    for (const player of rig.host.lobby.players) {
      const dragon = sim.getDragon(player.id);
      expect(dragon).toBeDefined();
      if (dragon === undefined) continue;
      const speed = Math.hypot(dragon.velocity.x, dragon.velocity.y, dragon.velocity.z);
      // Alive and moving, or down and waiting to respawn.
      if (dragon.health > 0) expect(speed).toBeGreaterThan(5);
    }

    // Removing a bot mid-match frees its dragon and its brain.
    const bot = rig.host.lobby.players.find((player) => player.isBot);
    if (bot === undefined) throw new Error('no bot');
    rig.host.endMatch();
    expect(rig.host.hostBots.count).toBe(0);
    expect(rig.host.applyIntent({ type: 'host.removeBot', playerId: bot.id })).toBe(true);
    expect(rig.host.applyIntent({ type: 'host.clearBots' })).toBe(true);
    expect(rig.host.lobby.players.filter((player) => player.isBot)).toHaveLength(0);
  });

  it('host-flown bots stop fighting once the round is decided', () => {
    const events: GameEvent[] = [];
    const rig = new Rig({
      host: {
        modeTuning: { ...fastTuning(), roundEndS: 2, resultsS: 4 },
        localBot: true,
        events: { emit: (event) => events.push(structuredClone(event)) },
      },
    }).open();
    for (const intent of [
      { type: 'host.setTeamSize', teamSize: 2 } as const,
      { type: 'host.setTimeLimit', timeLimitS: 0 } as const,
      { type: 'host.setScoreLimit', scoreLimit: 1 } as const,
      { type: 'host.setBotDifficulty', difficulty: 'hard' } as const,
      { type: 'host.fillBots' } as const,
    ]) {
      expect(rig.host.applyIntent(intent)).toBe(true);
    }
    startMatch(rig);
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    const casts = (): number => events.filter((event) => event.type === 'abilityCast').length;
    // Let the fight start, then decide the match under their noses.
    rig.runUntil(() => casts() > 10 || rig.host.matchPhase !== 'playing', 60_000);
    if (rig.host.matchPhase === 'playing') {
      const [first, ...others] = rig.host.lobby.players;
      const enemy = others.find((player) => player.side !== first?.side);
      if (first === undefined || enemy === undefined) throw new Error('no teams');
      sim.applyDamage(enemy.id, 1e6, first.id, 'primary', DAMAGE_IGNORE_IMMUNITY);
    }
    rig.runUntil(() => rig.host.matchPhase === 'roundEnd', 5000);
    const decidedAt = rig.host.hostTick;
    // Through the rest of `roundEnd` and well into `results`.
    rig.run(4000);
    expect(rig.host.matchPhase).toBe('results');
    const late = events.filter((event) => event.type === 'abilityCast' && event.tick > decidedAt);
    expect(late).toHaveLength(0);
    rig.dispose();
  });
});
