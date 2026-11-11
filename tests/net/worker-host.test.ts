/**
 * The host in a (fake) worker: the real `HostWorkerServer` and `WorkerHost` over an in-memory
 * port that clones and transfers like `postMessage` (see `worker-harness.ts`).
 *
 * - The worker path gives the page bit-identical authoritative states to the direct path for a
 *   seeded run on the real map (5 bots, terrain collision).
 * - Real clients join, fly and are told goodbye through the page's transport.
 * - A hidden page does not stop the match; a stalled page freezes it without dropping anyone.
 * - A worker that cannot start falls back to the main thread behind the same handle.
 */

import { describe, expect, it } from 'vitest';
import { createGreyboxMatchWorld } from '../../src/net/session';
import type { MatchWorld } from '../../src/net/session';
import { NOOP_HOST_HANDLERS } from '../../src/net/transport';
import type { HostTransport, HostTransportHandlers } from '../../src/net/transport';
import {
  HostCore,
  INPUT_HOLD_TICKS,
  PortHostTransport,
  VIEW_EXTRAPOLATE_TICKS,
  WORKER_START_TIMEOUT_MS,
} from '../../src/net/worker';
import type { HostViewState, WorkerLike } from '../../src/net/worker';
import {
  DRAGON_FLAG_ALIVE,
  TICK_HZ,
  TICK_MS,
  copyInputFrame,
  createInputFrame,
} from '../../src/shared';
import type { InputFrame } from '../../src/shared';
import { FakeWorker, WORKER_ROOM, WorkerRoom, startRoomMatch } from './worker-harness';

let sharedWorld: MatchWorld | null = null;
function greybox(): MatchWorld {
  sharedWorld ??= createGreyboxMatchWorld();
  return sharedWorld;
}

/** A copy of what the views read of a state: every number, exactly. */
function snapshotOf(state: Readonly<HostViewState>): unknown {
  return {
    tick: state.tick,
    timeS: state.timeS,
    dragons: state.dragons.map((dragon, slot) =>
      dragon.active
        ? {
            slot,
            id: dragon.id,
            team: dragon.team,
            classId: dragon.classId,
            flags: dragon.flags,
            anim: dragon.anim,
            position: { ...dragon.position },
            velocity: { ...dragon.velocity },
            orientation: { ...dragon.orientation },
            health: dragon.health,
            maxHealth: dragon.maxHealth,
            stamina: dragon.stamina,
          }
        : null,
    ),
  };
}

type Call =
  | { readonly kind: 'update'; readonly at: number; readonly nowMs: number }
  | {
      readonly kind: 'tick';
      readonly at: number;
      readonly input: InputFrame | undefined;
      readonly away: boolean;
    }
  | { readonly kind: 'open'; readonly at: number; readonly roomCode: string };

/** A transport that opens when the test says so and carries nothing. */
class ManualTransport implements HostTransport {
  handlers: HostTransportHandlers = NOOP_HOST_HANDLERS;
  state: HostTransport['state'] = 'idle';
  roomCode = '';
  setHandlers(handlers: HostTransportHandlers): void {
    this.handlers = handlers;
  }
  open(roomCode: string): void {
    this.state = 'opening';
    this.roomCode = roomCode;
  }
  send(): boolean {
    return false;
  }
  close(): void {}
  dispose(): void {
    this.handlers = NOOP_HOST_HANDLERS;
  }
  emitOpen(roomCode: string): void {
    this.state = 'open';
    this.handlers.onOpen(roomCode);
  }
}

describe('host worker vs direct host', () => {
  it('mirrors bit-identical states for a seeded run with bots on the real map', () => {
    const room = new WorkerRoom({
      createMatchWorld: () => greybox(),
      host: { bots: 5, botSeed: 77, autoStart: true },
    });
    const clock = room.clock;

    // Record everything that drives the worker's core, in order.
    const calls: { readonly core: unknown; readonly call: Call }[] = [];
    const realUpdate = HostCore.prototype.update;
    const realTick = HostCore.prototype.tick;
    const realEmitOpen = PortHostTransport.prototype.emitOpen;
    let recording = true;
    HostCore.prototype.update = function (this: HostCore, nowMs: number): void {
      if (recording) calls.push({ core: this, call: { kind: 'update', at: clock.now, nowMs } });
      realUpdate.call(this, nowMs);
    };
    HostCore.prototype.tick = function (
      this: HostCore,
      input?: Readonly<InputFrame>,
      away = false,
    ): void {
      if (recording) {
        calls.push({
          core: this,
          call: {
            kind: 'tick',
            at: clock.now,
            input: input === undefined ? undefined : copyInputFrame(createInputFrame(), input),
            away,
          },
        });
      }
      realTick.call(this, input, away);
    };
    PortHostTransport.prototype.emitOpen = function (
      this: PortHostTransport,
      roomCode: string,
    ): void {
      if (recording) calls.push({ core: null, call: { kind: 'open', at: clock.now, roomCode } });
      realEmitOpen.call(this, roomCode);
    };

    const seen = new Map<number, unknown>();
    const seenPrev = new Map<number, unknown>();
    try {
      room.onState = (tick, current): void => {
        seen.set(tick, snapshotOf(current));
      };
      room.open();
      room.runUntil(() => room.host.matchPhase === 'playing', 20_000);
      const end = clock.now + 25_000;
      while (clock.now < end) {
        room.run(1);
        const prev = room.host.prev;
        if (prev !== null) seenPrev.set(room.host.hostTick, snapshotOf(prev));
      }
    } finally {
      recording = false;
      HostCore.prototype.update = realUpdate;
      HostCore.prototype.tick = realTick;
      PortHostTransport.prototype.emitOpen = realEmitOpen;
    }

    const worker = room.worker;
    if (worker === null) throw new Error('no worker');
    expect(room.host.mode).toBe('worker');
    expect(room.fallbacks).toEqual([]);
    expect(room.host.botsConnected).toBe(5);
    expect(seen.size).toBeGreaterThan(25 * TICK_HZ - 5);

    // The same calls, in the same order, on a host that never left this thread.
    let replayNow = 0;
    const outer = new ManualTransport();
    const direct = new HostCore({
      kind: 'host',
      transport: outer,
      hostName: 'Host',
      bots: 5,
      botSeed: 77,
      autoStart: true,
      skipTicks: 0,
      createMatchWorld: () => greybox(),
      now: () => replayNow,
      recycledBuffers: true,
      session: { roomCode: WORKER_ROOM, countdownTicks: 30 },
    });
    direct.open();
    let compared = 0;
    let comparedPrev = 0;
    for (const entry of calls) {
      const call = entry.call;
      if (call.kind !== 'open' && entry.core !== worker.server.core) continue;
      replayNow = call.at;
      if (call.kind === 'open') {
        outer.emitOpen(call.roomCode);
      } else if (call.kind === 'update') {
        direct.update(call.nowMs);
      } else {
        direct.tick(call.input, call.away);
        const sim = direct.session.sim;
        const tick = direct.session.hostTick;
        if (sim === null) continue;
        const mirrored = seen.get(tick);
        if (mirrored !== undefined) {
          expect(mirrored).toEqual(snapshotOf(sim.current));
          compared++;
        }
        const mirroredPrev = seenPrev.get(tick);
        if (mirroredPrev !== undefined) {
          expect(mirroredPrev).toEqual(snapshotOf(sim.prev));
          comparedPrev++;
        }
      }
    }
    expect(compared).toBe(seen.size);
    expect(comparedPrev).toBeGreaterThan(20 * TICK_HZ);
    expect(direct.session.hostTick).toBe(worker.server.core?.session.hostTick);
    // The run is not a trivial one: six dragons flew for 25 s and the host really steered.
    expect(direct.session.sim?.current.dragonCount).toBe(6);
    const own = direct.session.sim?.getDragon(direct.session.localPlayerId);
    expect(own).toBeDefined();
    expect(Math.hypot(own?.position.x ?? 0, own?.position.z ?? 0)).toBeGreaterThan(100);

    // The cost of the hop, as the page saw it.
    const metrics = room.host.metrics;
    expect(metrics.malformed).toBe(0);
    // One post per tick plus the stats: nowhere near one per packet.
    const seconds = clock.now / 1000;
    expect(metrics.postedMessagesDown / seconds).toBeLessThan(TICK_HZ + 8);
    expect(metrics.postedMessagesUp / seconds).toBeLessThan(60 + 8);
    // The buffers ping-pong: a handful were ever made.
    expect(metrics.buffersAllocated).toBeLessThanOrEqual(6);
    // The host player's input reaches its tick within a frame.
    expect(metrics.inputAgeMs).toBeGreaterThan(0);
    expect(metrics.inputAgeMaxMs).toBeLessThanOrEqual(18);
    expect(metrics.viewStarvedFrames).toBe(0);
    room.dispose();
  });

  it('blends the view from the tick time stamps, like the fixed loop alpha', () => {
    const room = new WorkerRoom({ host: { bots: 1, autoStart: true } }).open();
    room.runUntil(() => room.host.matchPhase === 'playing' && room.host.current !== null, 20_000);
    room.run(500);
    room.recordAlpha = true;
    room.run(3000);
    const alphas = room.alphas;
    expect(alphas.length).toBeGreaterThan(150);
    let ups = 0;
    for (let i = 0; i < alphas.length; i++) {
      const alpha = alphas[i] ?? 0;
      expect(alpha).toBeGreaterThanOrEqual(0);
      // A state that is a hair late is bridged by blending a little past it.
      expect(alpha).toBeLessThanOrEqual(1.1);
      if (i > 0 && alpha > (alphas[i - 1] ?? 0)) ups++;
    }
    // 60 fps over 30 Hz: the fraction rises within a tick about every other frame.
    expect(ups).toBeGreaterThan(alphas.length * 0.3);
    const metrics = room.host.metrics;
    expect(metrics.viewStarvedFrames).toBe(0);
    expect(metrics.viewExtrapolatedMaxMs).toBeLessThan(4);

    // The worker goes quiet (its thread is busy): the view carries the last motion on for half
    // a tick, then holds still rather than fly off on a guess.
    const worker = room.worker;
    if (worker === null) throw new Error('no worker');
    const realRun = worker.runWorker.bind(worker);
    worker.runWorker = (): void => {};
    room.alphas.length = 0;
    room.run(120);
    worker.runWorker = realRun;
    const late = room.alphas;
    expect(Math.max(...late)).toBe(1 + VIEW_EXTRAPOLATE_TICKS);
    expect(late.some((alpha) => alpha > 1 && alpha < 1 + VIEW_EXTRAPOLATE_TICKS)).toBe(true);
    expect(room.host.metrics.viewStarvedFrames).toBeGreaterThan(0);
    room.dispose();
  });
});

describe('host worker with real clients on the page transport', () => {
  it('runs the lobby and a match through the port', () => {
    const room = new WorkerRoom({ host: { bots: 1 } }).open();
    expect(room.host.mode).toBe('worker');
    expect(room.host.roomCode).toBe(WORKER_ROOM);
    const a = room.join('Ada');
    const b = room.join('Bo');
    expect(a.session.status).toBe('connected');
    expect(b.session.status).toBe('connected');
    room.run(1500);

    const lobby = room.host.lobby;
    expect(lobby?.players.map((player) => player.name)).toEqual(['Host', 'Ada', 'Bo', 'Bot 1']);
    expect(lobby?.players.find((player) => player.name === 'Bot 1')?.isBot).toBe(true);
    expect(a.session.lobby?.players.length).toBe(4);
    expect(room.host.startBlocker).toBe('notAllReady');
    expect(room.host.clientCount).toBe(3);
    expect(room.host.botsConnected).toBe(1);

    startRoomMatch(room);
    room.run(8000);
    expect(room.host.inMatch).toBe(true);
    expect(room.host.localIsRider).toBe(true);
    expect(a.session.inMatch).toBe(true);
    expect(a.session.counters.snapshots).toBeGreaterThan(140);
    expect(b.session.counters.snapshots).toBeGreaterThan(140);
    expect(a.session.counters.malformed).toBe(0);
    expect(room.host.metrics.malformed).toBe(0);
    expect(room.host.playerPings[a.session.localPlayerId]).toBeGreaterThanOrEqual(0);

    // Both sides agree on where the host's dragon is, give or take the interpolation delay.
    const current = room.host.current;
    const hostId = room.host.localPlayerId;
    const mine = current?.dragons.find((dragon) => dragon.active && dragon.id === hostId);
    let theirs: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < a.view.dragonCount; i++) {
      const dragon = a.view.dragons[i];
      if (dragon !== undefined && dragon.id === hostId) theirs = dragon.position;
    }
    expect(mine).toBeDefined();
    expect(theirs).not.toBeNull();
    if (mine !== undefined && theirs !== null) {
      const distance = Math.hypot(
        mine.position.x - theirs.x,
        mine.position.y - theirs.y,
        mine.position.z - theirs.z,
      );
      expect(distance).toBeLessThan(25);
    }
    // The clients' own inputs made it to the sim on time: prediction holds.
    expect(a.session.counters.resyncs).toBeLessThanOrEqual(1);
    expect(a.session.predictor.largestCorrectionM).toBeLessThan(2);

    // Kick: the worker closes the link on the page and the client is told why.
    room.host.applyIntent({ type: 'host.kick', playerId: b.session.localPlayerId });
    room.runUntil(() => b.session.status === 'kicked', 5000);
    room.run(1000);
    expect(room.host.lobby?.players.some((player) => player.name === 'Bo')).toBe(false);

    // Closing from the page says goodbye at once, without a trip through the worker.
    room.host.close();
    expect(room.host.state).toBe('closed');
    expect(room.worker?.terminated).toBe(true);
    room.runUntil(() => a.session.status === 'hostLeft', 2000);
    room.dispose();
  });

  it('keeps the match running while the page is hidden', () => {
    const room = new WorkerRoom().open();
    const a = room.join('Ada');
    startRoomMatch(room);
    room.run(2000);
    const server = room.worker?.server;
    if (server === undefined) throw new Error('no worker');

    room.visible = false;
    const tickBefore = server.core?.session.hostTick ?? 0;
    const snapshotsBefore = a.session.counters.snapshots;
    const inputsBefore = server.core?.session.inputBufferOf(a.session.localPlayerId);
    room.run(5000);
    const ticks = (server.core?.session.hostTick ?? 0) - tickBefore;
    // No animation frames for five seconds, and not a tick was lost.
    expect(ticks).toBeGreaterThanOrEqual(5 * TICK_HZ - 1);
    expect(ticks).toBeLessThanOrEqual(5 * TICK_HZ + 1);
    expect(a.session.counters.snapshots - snapshotsBefore).toBeGreaterThan(90);
    expect(a.session.status).toBe('connected');
    expect(inputsBefore).not.toBeNull();
    // The client's inputs still arrive in time (they ride on the worker's beat now).
    expect(server.core?.session.inputMarginOf(a.session.localPlayerId)).toBeGreaterThanOrEqual(0);
    expect(a.session.predictor.largestCorrectionM).toBeLessThan(2);
    // Nobody is at the host's controls: its dragon is flown on the holding circle and lives.
    const own = server.core?.session.sim?.getDragon(0);
    expect(own).toBeDefined();
    expect((own?.flags ?? 0) & DRAGON_FLAG_ALIVE).toBe(DRAGON_FLAG_ALIVE);

    room.visible = true;
    room.run(1000);
    expect(room.host.hostTick).toBeGreaterThan(tickBefore + 5 * TICK_HZ);
    expect(room.host.state).toBe('open');
    room.dispose();
  });

  it('flies the hidden host on the holding circle only after the hold window', () => {
    const room = new WorkerRoom({ host: { bots: 1, autoStart: true } }).open();
    room.runUntil(() => room.host.matchPhase === 'playing', 20_000);
    room.run(1000);
    const server = room.worker?.server;
    if (server === undefined) throw new Error('no worker');
    const held = server.stats.inputHeldTicks;
    room.visible = false;
    room.run(2000);
    // The last sample was held for the window, then the seat counted as away.
    expect(server.stats.inputHeldTicks - held).toBe(INPUT_HOLD_TICKS);
    room.dispose();
  });

  it('freezes with a stalled page and drops nobody when it returns', () => {
    const room = new WorkerRoom().open();
    const a = room.join('Ada', { linkTimeoutMs: 60_000 });
    startRoomMatch(room);
    room.run(1000);
    const server = room.worker?.server;
    if (server === undefined) throw new Error('no worker');
    const session = server.core?.session;
    if (session === undefined) throw new Error('no session');

    room.pageAlive = false;
    const tickBefore = session.hostTick;
    room.run(9000);
    // It ran on for the stall threshold, then held the world.
    const ticksWhileStalled = session.hostTick - tickBefore;
    expect(ticksWhileStalled).toBeGreaterThan(20);
    expect(ticksWhileStalled).toBeLessThan(TICK_HZ + 6);

    room.pageAlive = true;
    room.run(3000);
    // Nine seconds of silence the worker could not hear did not time the link out.
    expect(session.counters.linkTimeouts).toBe(0);
    expect(room.host.clientCount).toBe(1);
    expect(session.hostTick - tickBefore).toBeGreaterThan(ticksWhileStalled + 2 * TICK_HZ);
    expect(a.session.status).toBe('connected');
    room.dispose();
  });

  it('a solo room needs no transport: autostart, skip and autopilot run in the worker', () => {
    const room = new WorkerRoom({
      transport: false,
      host: {
        autoStart: true,
        skipTicks: 90,
        autopilot: { centerX: 0, centerZ: 0, radius: 300, altitude: 320 },
      },
      worker: {
        createPilot: (course) => ({
          sample(tick, subject, out): void {
            out.tick = tick;
            out.steerX = 0.5;
            out.steerY = subject !== undefined && subject.position.y < course.altitude ? 0.25 : 0;
            out.buttons = 0;
          },
        }),
      },
    });
    room.host.open();
    room.runUntil(() => room.host.current !== null, 5000);
    expect(room.host.mode).toBe('worker');
    expect(room.host.matchPhase).toBe('playing');
    expect(room.host.localIsRider).toBe(true);
    // The first state the page sees is already past the skipped ticks.
    expect(room.host.hostTick).toBeGreaterThanOrEqual(90);
    expect(room.host.hostTick).toBeLessThan(90 + 12);
    room.run(500);
    // The worker's pilot steers; the page learns the steer for its camera.
    expect(room.host.aimX).toBeCloseTo(0.5, 6);
    expect(room.host.metrics.inputAgeMs).toBe(0);
    room.dispose();
  });
});

describe('fallback to the main thread', () => {
  function expectHostsDirectly(room: WorkerRoom): void {
    expect(room.host.mode).toBe('direct');
    room.runUntil(() => room.host.state === 'open', 2000);
    const client = room.join('Ada');
    expect(client.session.status).toBe('connected');
    startRoomMatch(room);
    room.run(1000);
    expect(room.host.current).not.toBeNull();
    expect(room.host.localIsRider).toBe(true);
    expect(client.session.counters.snapshots).toBeGreaterThan(10);
    room.dispose();
  }

  it('hosts directly when no worker is offered (?noworker)', () => {
    const room = new WorkerRoom({ spawnWorker: null }).open();
    expect(room.fallbacks).toEqual([]);
    expectHostsDirectly(room);
  });

  it('hosts directly when the worker cannot be constructed', () => {
    const room = new WorkerRoom({
      spawnWorker: (): WorkerLike => {
        throw new Error('SecurityError: blocked by CSP');
      },
    });
    expect(room.fallbacks).toEqual(['SecurityError: blocked by CSP']);
    room.host.open();
    expectHostsDirectly(room);
  });

  it('hosts directly when the worker script fails before it is ready', () => {
    let worker: FakeWorker | null = null;
    const room = new WorkerRoom({
      spawnWorker: (): WorkerLike => {
        worker = new FakeWorker({ now: 0 }, { start: 'error' });
        return worker;
      },
    });
    // The game asked for the room before anybody knew the worker was broken.
    room.host.open();
    expect(room.host.mode).toBe('worker');
    expect(room.host.state).toBe('opening');
    (worker as FakeWorker | null)?.runWorker();
    expect(room.fallbacks).toEqual(['SyntaxError: the host worker script is broken']);
    expect((worker as FakeWorker | null)?.terminated).toBe(true);
    expectHostsDirectly(room);
  });

  it('hosts directly when the worker never answers', () => {
    const room = new WorkerRoom({
      spawnWorker: (): WorkerLike => new FakeWorker({ now: 0 }, { start: 'silent' }),
    });
    room.host.open();
    room.run(WORKER_START_TIMEOUT_MS - 200);
    expect(room.host.mode).toBe('worker');
    room.run(400);
    expect(room.fallbacks).toEqual(['the worker did not start']);
    expectHostsDirectly(room);
  });

  it('closes the room with a reason when a running worker dies', () => {
    const room = new WorkerRoom().open();
    const client = room.join('Ada');
    room.run(500);
    room.worker?.raise('RangeError: something broke in a tick');
    expect(room.host.mode).toBe('worker');
    expect(room.host.state).toBe('closed');
    expect(room.host.error?.fatal).toBe(true);
    expect(room.host.error?.message).toContain('RangeError');
    expect(room.fallbacks).toEqual([]);
    // The page still held the links: the client hears HOST_LEFT, not a timeout.
    room.runUntil(() => client.session.status === 'hostLeft', 2000);
    room.dispose();
  });

  it('a host on this thread ticks only from the fixed loop', () => {
    const room = new WorkerRoom({ spawnWorker: null, host: { bots: 2, autoStart: true } }).open();
    room.runUntil(() => room.host.matchPhase === 'playing', 20_000);
    const before = room.host.hostTick;
    room.run(1000);
    expect(room.host.hostTick - before).toBeGreaterThanOrEqual(TICK_HZ - 2);
    expect(room.host.viewAlpha(0.25, room.clock.now)).toBe(0.25);
    expect(room.host.metrics.ticks).toBeGreaterThan(0);
    // Hidden: no frames, no fixed loop, no ticks. This is what the worker path fixes.
    room.visible = false;
    const hidden = room.host.hostTick;
    room.run(2000);
    expect(room.host.hostTick).toBe(hidden);
    expect(Math.abs(TICK_MS - 1000 / TICK_HZ)).toBeLessThan(1e-9);
    room.dispose();
  });
});
