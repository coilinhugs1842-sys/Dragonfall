/**
 * End to end: a host and three clients over the loopback transport and the real codec, from
 * the room code to 300+ ticks of flight on the greybox map.
 *
 * The metrics (the same as tests/net/prediction-netsim.test.ts, which defines them):
 * - view error: |a client's drawn position of a REMOTE dragon - where the host had that dragon
 *   at the client's playback time|;
 * - prediction error: |position a client predicted for its own dragon at tick T - the host's
 *   position for T|;
 * - visual discontinuity ("rubber-banding"): per rendered frame, how far a drawn dragon is from
 *   where its last drawn position and velocity said it would be. Smooth flight gives
 *   centimetres, a pop gives metres;
 * - backward frames: frames in which a remote dragon moved against its own velocity.
 */

import { describe, expect, it, vi } from 'vitest';
import { NETSIM_PROFILES, createNetsimProfile } from '../../src/dev/netsim';
import { createGreyboxMatchWorld } from '../../src/net/session';
import type { MatchWorld } from '../../src/net/session';
import { DAMAGE_IGNORE_IMMUNITY } from '../../src/sim';
import { DRAGON_FLAG_ALIVE, NO_PLAYER, TICK_HZ } from '../../src/shared';
import type { PlayerId } from '../../src/shared';
import { createRoom, startMatch } from './session-harness';
import type { Rig } from './session-harness';
import type { RigOptions } from './session-harness';

/** Built once: every session of every test flies the same greybox collision world. */
let sharedWorld: MatchWorld | null = null;
function greybox(): MatchWorld {
  sharedWorld ??= createGreyboxMatchWorld();
  return sharedWorld;
}

interface Position {
  x: number;
  y: number;
  z: number;
}

interface FlightResult {
  ticks: number;
  /** Largest view error of any remote dragon on any client (m). */
  maxViewError: number;
  viewSamples: number;
  /** Largest own-dragon prediction error on any client (m), and how many ticks were compared. */
  maxPredictionError: number;
  predictedTicks: number;
  remoteDiscontinuity: number;
  remoteBackwardFrames: number;
  ownDiscontinuity: number;
  /** Per client: corrections and the largest one, after settling. */
  corrections: number[];
  largestCorrection: number[];
  resyncs: number[];
  /** Per client, from the host's input buffer. */
  hostStored: number[];
  hostRepeated: number[];
  hostEmpty: number[];
  hostLate: number[];
  inputsSent: number[];
  /** Ticks on which `take` was called more than once or out of order (must be 0). */
  doubleTakes: number;
  /** Dodges the host simulated per client, and presses the client made. */
  hostDodges: number[];
  dodgePresses: number[];
  deaths: number;
  starvedFrames: number;
  delayMs: number[];
  pingMs: number[];
}

function fly(rig: Rig, ticks: number, settleTicks: number): FlightResult {
  const host = rig.host;
  const sim = host.sim;
  if (sim === null) throw new Error('no match');
  const ids: PlayerId[] = rig.clients.map((c) => c.session.localPlayerId);

  // --- Host history: every dragon's position per tick ------------------------------------------
  const history = new Map<number, Map<PlayerId, Position>>();
  const predicted: Map<number, Position>[] = rig.clients.map(() => new Map());
  const startTick = host.hostTick;
  const settleTick = startTick + settleTicks;

  let maxViewError = 0;
  let viewSamples = 0;
  let maxPredictionError = 0;
  let predictedTicks = 0;
  let remoteDiscontinuity = 0;
  let remoteBackwardFrames = 0;
  let ownDiscontinuity = 0;
  let deaths = 0;
  let starvedFrames = 0;
  let doubleTakes = 0;

  // --- "Never twice": every client's buffer is asked exactly once per tick, in order -----------
  const hostDodges = ids.map(() => 0);
  const wasDodging = ids.map(() => false);
  const spies = ids.map((id) => {
    const buffer = host.inputBufferOf(id);
    if (buffer === null) throw new Error(`no input buffer for ${id}`);
    let lastTake = -1;
    const original = buffer.take.bind(buffer);
    return vi.spyOn(buffer, 'take').mockImplementation((tick: number) => {
      if (tick !== lastTake + 1 && lastTake >= 0) doubleTakes++;
      lastTake = tick;
      const frame = original(tick);
      // Whatever the host applies for tick T is stamped T: never an older frame replayed as is.
      if (frame !== undefined && frame.tick !== tick) doubleTakes++;
      return frame;
    });
  });
  const baseStored = ids.map((id) => host.inputBufferOf(id)?.storedCount ?? 0);
  const baseRepeated = ids.map((id) => host.inputBufferOf(id)?.repeatedCount ?? 0);
  const baseEmpty = ids.map((id) => host.inputBufferOf(id)?.emptyCount ?? 0);
  const baseLate = ids.map((id) => host.inputBufferOf(id)?.lateCount ?? 0);
  const baseSent = rig.clients.map((c) => c.session.counters.inputsSent);
  const basePresses = rig.clients.map((c) => c.pilot.dodgePresses);
  const baseCorrections = rig.clients.map(() => 0);
  const baseResyncs = rig.clients.map((c) => c.session.counters.resyncs);
  let settled = false;

  rig.onHostTick = (tick) => {
    const row = new Map<PlayerId, Position>();
    for (const dragon of sim.current.dragons) {
      if (!dragon.active) continue;
      row.set(dragon.id, { x: dragon.position.x, y: dragon.position.y, z: dragon.position.z });
    }
    history.set(tick, row);
    history.delete(tick - 400);

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === undefined) continue;
      const dragon = sim.getDragon(id);
      if (dragon === undefined) continue;
      const dodging = dragon.dodgeTicks > 0;
      if (dodging && wasDodging[i] === false) hostDodges[i] = (hostDodges[i] ?? 0) + 1;
      wasDodging[i] = dodging;
      if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0 && dragon.health <= 0) deaths++;

      const mine = predicted[i]?.get(tick);
      if (mine !== undefined && tick >= settleTick) {
        const error = Math.hypot(
          mine.x - dragon.position.x,
          mine.y - dragon.position.y,
          mine.z - dragon.position.z,
        );
        if (error > maxPredictionError) maxPredictionError = error;
        predictedTicks++;
      }
      predicted[i]?.delete(tick);
    }

    if (!settled && tick >= settleTick) {
      settled = true;
      rig.clients.forEach((client, i) => {
        baseCorrections[i] = client.session.predictor.correctionCount;
      });
    }
  };

  rig.onClientTick = (client, index, tick) => {
    const predictor = client.session.predictor;
    if (!predictor.active) return;
    const p = predictor.dragon.position;
    predicted[index]?.set(tick, { x: p.x, y: p.y, z: p.z });
    predicted[index]?.delete(tick - 400);
  };

  const lastDrawn: Map<PlayerId, Position & { vx: number; vy: number; vz: number }>[] =
    rig.clients.map(() => new Map());

  rig.onClientFrame = (client, index, dtMs) => {
    const session = client.session;
    if (!session.inMatch) return;
    const sample = session.sample;
    const ownId = session.localDragonId;
    if (sample.starved && host.hostTick >= settleTick) starvedFrames++;

    // --- View error against the host at the playback time ------------------------------------
    if (sample.valid && !sample.starved && host.hostTick >= settleTick) {
      const t0 = Math.floor(sample.playTick);
      const f = sample.playTick - t0;
      const a = history.get(t0);
      const b = history.get(t0 + 1);
      if (a !== undefined && b !== undefined) {
        for (let i = 0; i < sample.dragonCount; i++) {
          const drawn = sample.dragons[i];
          if (drawn === undefined || drawn.id === ownId) continue;
          const pa = a.get(drawn.id);
          const pb = b.get(drawn.id);
          if (pa === undefined || pb === undefined) continue;
          const error = Math.hypot(
            drawn.position.x - (pa.x + (pb.x - pa.x) * f),
            drawn.position.y - (pa.y + (pb.y - pa.y) * f),
            drawn.position.z - (pa.z + (pb.z - pa.z) * f),
          );
          if (error > maxViewError) maxViewError = error;
          viewSamples++;
        }
      }
    }

    // --- Rubber-banding ----------------------------------------------------------------------
    const dtS = dtMs / 1000;
    const drawnBefore = lastDrawn[index];
    if (drawnBefore === undefined) return;
    const view = client.view;
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon === undefined) continue;
      const before = drawnBefore.get(dragon.id);
      const own = dragon.id === ownId;
      if (before !== undefined && dtS > 0 && dtS < 0.1 && host.hostTick >= settleTick) {
        const dx = dragon.position.x - before.x;
        const dy = dragon.position.y - before.y;
        const dz = dragon.position.z - before.z;
        const scale = own ? session.timeScale : session.buffer.clock.rate;
        const discontinuity = Math.hypot(
          dx - before.vx * dtS * scale,
          dy - before.vy * dtS * scale,
          dz - before.vz * dtS * scale,
        );
        if (own) {
          if (discontinuity > ownDiscontinuity) ownDiscontinuity = discontinuity;
        } else if (!sample.starved) {
          if (discontinuity > remoteDiscontinuity) remoteDiscontinuity = discontinuity;
          const along = dx * before.vx + dy * before.vy + dz * before.vz;
          const speed = Math.hypot(before.vx, before.vy, before.vz);
          if (speed > 5 && along < -0.02 * speed) remoteBackwardFrames++;
        }
      }
      drawnBefore.set(dragon.id, {
        x: dragon.position.x,
        y: dragon.position.y,
        z: dragon.position.z,
        vx: dragon.velocity.x,
        vy: dragon.velocity.y,
        vz: dragon.velocity.z,
      });
    }
  };

  rig.runTicks(ticks);
  rig.onHostTick = null;
  rig.onClientFrame = null;
  rig.onClientTick = null;
  for (const spy of spies) spy.mockRestore();

  const buffers = ids.map((id) => host.inputBufferOf(id));
  return {
    ticks: host.hostTick - startTick,
    maxViewError,
    viewSamples,
    maxPredictionError,
    predictedTicks,
    remoteDiscontinuity,
    remoteBackwardFrames,
    ownDiscontinuity,
    corrections: rig.clients.map(
      (c, i) => c.session.predictor.correctionCount - (baseCorrections[i] ?? 0),
    ),
    largestCorrection: rig.clients.map((c) => c.session.predictor.largestCorrectionM),
    resyncs: rig.clients.map((c, i) => c.session.counters.resyncs - (baseResyncs[i] ?? 0)),
    hostStored: buffers.map((b, i) => (b?.storedCount ?? 0) - (baseStored[i] ?? 0)),
    hostRepeated: buffers.map((b, i) => (b?.repeatedCount ?? 0) - (baseRepeated[i] ?? 0)),
    hostEmpty: buffers.map((b, i) => (b?.emptyCount ?? 0) - (baseEmpty[i] ?? 0)),
    hostLate: buffers.map((b, i) => (b?.lateCount ?? 0) - (baseLate[i] ?? 0)),
    inputsSent: rig.clients.map((c, i) => c.session.counters.inputsSent - (baseSent[i] ?? 0)),
    doubleTakes,
    hostDodges,
    dodgePresses: rig.clients.map((c, i) => c.pilot.dodgePresses - (basePresses[i] ?? 0)),
    deaths,
    starvedFrames,
    delayMs: rig.clients.map((c) => c.session.buffer.clock.delayMs),
    pingMs: rig.clients.map((c) => c.session.pingMs),
  };
}

function room(options: RigOptions = {}): Rig {
  const rig = createRoom(3, options);
  // Lobby operations on the way in, as a real room would have.
  const [a, b, c] = rig.clients;
  if (a === undefined || b === undefined || c === undefined) throw new Error('no clients');
  a.session.sendIntent({ type: 'lobby.pickClass', classId: 'tempest' });
  b.session.sendIntent({ type: 'lobby.pickClass', classId: 'bastion' });
  rig.host.applyIntent({ type: 'host.setTeamSize', teamSize: 2 });
  rig.run(300);
  return rig;
}

/** Steady flight only: dodges and flaps are real velocity jumps, not network artefacts. */
function calm(rig: Rig): void {
  for (const pilot of [rig.hostPilot, ...rig.clients.map((c) => c.pilot)]) {
    pilot.dodgeEvery = Infinity;
    pilot.flaps = false;
  }
}

describe('host + 3 clients, clean link', () => {
  it('joins by code, starts and flies 300 ticks with every view matching the host', () => {
    // Open sky: nothing but the netcode between the host's state and a client's picture.
    const rig = room();
    expect(rig.host.lobby.players).toHaveLength(4);
    expect(rig.clients.map((c) => c.session.lobby)).toEqual([
      rig.host.lobby,
      rig.host.lobby,
      rig.host.lobby,
    ]);
    startMatch(rig);
    expect(rig.host.sim?.current.dragonCount).toBe(4);
    for (const client of rig.clients) {
      expect(client.session.isRider).toBe(true);
      expect(client.session.matchStartTick).toBe(rig.host.matchStartTick);
    }

    const result = fly(rig, 300, 45);

    expect(result.ticks).toBe(300);
    // Every client draws 3 remote dragons on (almost) every frame.
    expect(result.viewSamples).toBeGreaterThan(3 * 3 * 400);
    // Remote dragons: interpolation between quantized snapshots against the host's exact path.
    // The largest term is the dodge impulse inside a two-tick snapshot gap.
    expect(result.maxViewError).toBeLessThan(0.4);
    // Own dragon: the same code on the same inputs.
    expect(result.predictedTicks).toBeGreaterThan(3 * 240);
    expect(result.maxPredictionError).toBeLessThan(0.001);
    expect(result.corrections).toEqual([0, 0, 0]);
    expect(result.resyncs).toEqual([0, 0, 0]);
    expect(result.remoteBackwardFrames).toBe(0);
    // About half a metre is the dodge impulse itself (the own dragon shows the same).
    expect(result.remoteDiscontinuity).toBeLessThan(0.7);
    expect(result.starvedFrames).toBe(0);
    // Inputs: one per tick arrived in time, none guessed, none applied twice.
    expect(result.doubleTakes).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(result.hostEmpty[i]).toBe(0);
      expect(result.hostRepeated[i]).toBe(0);
      expect(result.hostStored[i]).toBe(300);
      expect(result.inputsSent[i]).toBe(300);
      expect(result.hostDodges[i]).toBe(result.dodgePresses[i]);
      expect(result.dodgePresses[i]).toBeGreaterThanOrEqual(1);
    }

    // Every client's world view has all four dragons, with roster data from the lobby.
    for (const client of rig.clients) {
      expect(client.view.dragonCount).toBe(4);
      expect(client.view.localDragonId).toBe(client.session.localPlayerId);
      expect(client.view.clock.phase).toBe('playing');
      for (let i = 0; i < client.view.dragonCount; i++) {
        const dragon = client.view.dragons[i];
        if (dragon === undefined) continue;
        const seat = rig.host.lobby.players.find((p) => p.id === dragon.id);
        expect(seat?.side).toBe(dragon.team);
        expect(seat?.classId).toBe(dragon.classId);
      }
    }
    rig.dispose();
  });

  it('steady flight is drawn within centimetres of the host, with no visible steps', () => {
    const rig = room();
    calm(rig);
    startMatch(rig);
    const result = fly(rig, 300, 45);
    expect(result.maxViewError).toBeLessThan(0.1);
    expect(result.remoteDiscontinuity).toBeLessThan(0.15);
    expect(result.remoteBackwardFrames).toBe(0);
    rig.dispose();
  });

  it('predicts exactly on the greybox map too (real terrain collision on both sides)', () => {
    const rig = room({ createMatchWorld: () => greybox() });
    startMatch(rig);
    const result = fly(rig, 600, 45);
    expect(result.predictedTicks).toBeGreaterThan(3 * 500);
    expect(result.maxPredictionError).toBeLessThan(0.01);
    expect(result.corrections).toEqual([0, 0, 0]);
    expect(result.doubleTakes).toBe(0);
    for (const client of rig.clients) expect(client.session.matchWorld).toBe(greybox());
    rig.dispose();
  });

  it('holds dragons at their gates during the countdown and hands over on the start tick', () => {
    const rig = room({ host: { countdownTicks: 60 } });
    for (const client of rig.clients) {
      client.session.sendIntent({ type: 'lobby.ready', ready: true });
    }
    rig.run(300);
    expect(rig.host.applyIntent({ type: 'host.start' })).toBe(true);
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    const startTick = rig.host.matchStartTick;
    const spawn = new Map<PlayerId, Position>();
    for (const dragon of sim.current.dragons) {
      if (dragon.active) spawn.set(dragon.id, { ...dragon.position });
    }
    expect(spawn.size).toBe(4);

    // Late in the countdown (the clients run a few ticks ahead of the host, so stop short of
    // the hand-over): nobody has moved, on the host or in any client's prediction, although
    // inputs have been flowing and acked the whole time.
    rig.runUntil(() => rig.host.hostTick === startTick - 12);
    expect(rig.host.matchPhase).toBe('countdown');
    for (const dragon of sim.current.dragons) {
      if (dragon.active) expect(dragon.position).toEqual(spawn.get(dragon.id));
    }
    for (const client of rig.clients) {
      const session = client.session;
      expect(session.matchPhase).toBe('countdown');
      expect(session.predictor.active).toBe(true);
      expect(session.predictor.tick).toBeLessThan(startTick);
      const mine = spawn.get(session.localPlayerId);
      expect(session.predictor.dragon.position.x).toBeCloseTo(mine?.x ?? NaN, 3);
      expect(session.predictor.dragon.position.z).toBeCloseTo(mine?.z ?? NaN, 3);
      expect(session.counters.inputsSent).toBeGreaterThan(20);
      expect(rig.host.inputBufferOf(session.localPlayerId)?.hasAck).toBe(true);
      expect(session.timing.sampleCount).toBeGreaterThan(5);
    }

    // After it: everyone flies, and prediction agrees from the first tick.
    const result = fly(rig, 100, 12);
    expect(rig.host.matchPhase).toBe('playing');
    expect(result.maxPredictionError).toBeLessThan(0.001);
    expect(result.corrections).toEqual([0, 0, 0]);
    for (const dragon of sim.current.dragons) {
      if (!dragon.active) continue;
      const from = spawn.get(dragon.id);
      const moved = Math.hypot(
        dragon.position.x - (from?.x ?? 0),
        dragon.position.z - (from?.z ?? 0),
      );
      expect(moved).toBeGreaterThan(50);
    }
    rig.dispose();
  });

  it('delivers the match events to every client reliably and in order', () => {
    const seen: string[][] = [[], [], []];
    const hostEvents: string[] = [];
    // A plain recorder stands in for each side's event bus.
    const rig = createRoom(0, {
      createMatchWorld: () => greybox(),
      host: {
        respawnTicks: 30,
        events: { emit: (event) => hostEvents.push(`${event.type}@${event.tick}`) },
      },
    });
    for (let i = 0; i < 3; i++) {
      const log = seen[i] ?? [];
      rig.join(`Rider ${i + 1}`, {
        events: { emit: (event) => log.push(`${event.type}@${event.tick}`) },
      });
    }
    startMatch(rig);
    // Kill one rider, then wait for its respawn. A held dive stick now loops (inverted flight)
    // instead of driving into the cloud sea, so the test applies a lethal hit directly.
    const victim = rig.clients[0];
    if (victim === undefined) throw new Error('no client');
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    expect(
      sim.applyDamage(
        victim.session.localPlayerId,
        1e6,
        NO_PLAYER,
        'terrain',
        DAMAGE_IGNORE_IMMUNITY,
      ),
    ).toBeGreaterThan(0);
    rig.runUntil(() => hostEvents.filter((e) => e.startsWith('spawn')).length >= 5, 10_000);
    rig.run(200);

    expect(hostEvents.filter((e) => e.startsWith('spawn')).length).toBe(5);
    expect(hostEvents.filter((e) => e.startsWith('takedown'))).toHaveLength(1);
    expect(hostEvents.filter((e) => e.startsWith('matchPhase'))).toHaveLength(2);
    for (const log of seen) expect(log).toEqual(hostEvents);
    // The victim's client followed the respawn: alive again, prediction on and in agreement.
    const dragon = rig.host.sim?.getDragon(victim.session.localPlayerId);
    expect((dragon?.flags ?? 0) & DRAGON_FLAG_ALIVE).toBe(DRAGON_FLAG_ALIVE);
    expect(victim.session.predictor.active).toBe(true);
    rig.dispose();
  });
});

describe('snapshot loss figure (the "loss %" of the perf HUD)', () => {
  it('reads zero on a clean link and about the real rate on a lossy one', () => {
    const clean = room();
    calm(clean);
    startMatch(clean);
    fly(clean, 8 * TICK_HZ, TICK_HZ);
    for (const client of clean.clients) expect(client.session.lossPct).toBe(0);
    clean.dispose();

    const lossy = room({ netsim: createNetsimProfile(20, 5, 10), seed: 31 });
    calm(lossy);
    startMatch(lossy);
    fly(lossy, 12 * TICK_HZ, TICK_HZ);
    for (const client of lossy.clients) {
      expect(client.session.lossPct).toBeGreaterThan(3);
      expect(client.session.lossPct).toBeLessThan(20);
    }
    lossy.dispose();
  });
});

describe('host + 3 clients behind netsim "bad" (80 +- 20 ms, 2 % loss, each way)', () => {
  it('shows no rubber-banding: remote dragons stay smooth and never move backwards', () => {
    for (const seed of [99, 7]) {
      const rig = room({ netsim: NETSIM_PROFILES.bad, seed });
      calm(rig);
      startMatch(rig);
      const result = fly(rig, 20 * TICK_HZ, 3 * TICK_HZ);
      // Smooth flight is centimetres per frame; a pop or a rubber-band would be metres.
      expect(result.remoteDiscontinuity).toBeLessThan(0.3);
      expect(result.remoteBackwardFrames).toBe(0);
      expect(result.maxViewError).toBeLessThan(0.5);
      // The own dragon never needed a visible correction.
      expect(result.ownDiscontinuity).toBeLessThan(0.1);
      for (let i = 0; i < 3; i++) {
        expect(result.corrections[i]).toBeLessThanOrEqual(3);
        expect(result.largestCorrection[i]).toBeLessThan(0.5);
        expect(result.resyncs[i]).toBe(0);
        // The interpolation delay adapted inside its band; pings read about 2 x 80 ms.
        expect(result.delayMs[i]).toBeGreaterThanOrEqual(70);
        expect(result.delayMs[i]).toBeLessThanOrEqual(150);
        expect(result.pingMs[i]).toBeGreaterThan(120);
        expect(result.pingMs[i]).toBeLessThan(230);
        // ...and the host knows them, for the ping column.
        const id = rig.clients[i]?.session.localPlayerId ?? 0;
        expect(rig.host.playerPings[id]).toBeGreaterThan(120);
        expect(rig.host.playerPings[id]).toBeLessThan(230);
        expect(rig.clients[i]?.session.lossPct).toBeLessThan(15);
        // ...and so does every other client, about a second behind.
        for (const other of rig.clients) {
          expect(other.session.playerPings[id]).toBeGreaterThan(120);
          expect(other.session.playerPings[id]).toBeLessThan(230);
          expect(other.session.playerPings[rig.host.localPlayerId]).toBe(0);
        }
      }
      rig.dispose();
    }
  });

  it('loses no input (repeat-2 covers the lost packets) and never applies one twice', () => {
    const rig = room({ netsim: NETSIM_PROFILES.bad, seed: 99, createMatchWorld: () => greybox() });
    startMatch(rig);
    const result = fly(rig, 20 * TICK_HZ, 3 * TICK_HZ);
    console.log('[e2e bad]', JSON.stringify(result));

    expect(result.doubleTakes).toBe(0);
    const ticks = result.ticks;
    for (let i = 0; i < 3; i++) {
      // 2 % of the packets were lost on the way up...
      expect(result.inputsSent[i]).toBeGreaterThan(ticks * 0.97);
      // ...yet the host had the client's real frame for (nearly) every tick, each exactly once.
      expect(result.hostStored[i]).toBeGreaterThan(ticks * 0.99);
      expect(result.hostStored[i]).toBeLessThanOrEqual((result.inputsSent[i] ?? 0) + 4);
      expect(result.hostEmpty[i]).toBe(0);
      expect(result.hostRepeated[i]).toBeLessThan(ticks * 0.01);
      // A dodge is one tick of a button: every press arrived, none was doubled.
      expect(result.dodgePresses[i]).toBeGreaterThanOrEqual(3);
      expect(result.hostDodges[i]).toBe(result.dodgePresses[i]);
      expect(result.corrections[i]).toBeLessThanOrEqual(3);
      expect(result.resyncs[i]).toBe(0);
    }
    expect(result.maxPredictionError).toBeLessThan(0.5);
    rig.dispose();
  });
});
