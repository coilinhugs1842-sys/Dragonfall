/**
 * Net-bots: N in-page fake clients, each a real ClientSession on the loopback transport going
 * through the real codec. The load test at the end is the Phase 2 measurement: the host's cost
 * per tick with 9 clients (inputs + sim + 9 snapshot encodes) and the bytes per client against
 * the 7 KB/s budget of docs/NETWORKING.md.
 */

import { describe, expect, it } from 'vitest';
import { NETSIM_PROFILES, createNetsim } from '../../src/dev/netsim';
import { BotPilot, GREYBOX_BOT_ARENA, NetBots } from '../../src/net/bots';
import { createSnapshotOwner } from '../../src/net/protocol';
import { HostSession, createGreyboxMatchWorld } from '../../src/net/session';
import type { MatchWorld } from '../../src/net/session';
import { createLoopbackHub } from '../../src/net/transport';
import type { LoopbackHub } from '../../src/net/transport';
import {
  BUTTON_MASK,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  MAX_CLIENT_RIDERS,
  TICK_HZ,
  TICK_MS,
  createInputFrame,
} from '../../src/shared';

let sharedWorld: MatchWorld | null = null;
function greybox(): MatchWorld {
  sharedWorld ??= createGreyboxMatchWorld();
  return sharedWorld;
}

interface BotRoom {
  hub: LoopbackHub;
  host: HostSession;
  bots: NetBots;
  now: number;
  /** Runs `ms` of time: pump, host update + due ticks, bots at 60 fps. */
  run(ms: number): void;
  runUntil(done: () => boolean, maxMs: number): void;
}

function createBotRoom(
  count: number,
  options: { netsim?: boolean; predict?: boolean; seed?: number; fight?: boolean } = {},
): BotRoom {
  const hub = createLoopbackHub({ recycleBuffers: true });
  const room = { now: 0 } as BotRoom;
  const netsim =
    options.netsim === true
      ? createNetsim({ profile: NETSIM_PROFILES.wifi, seed: 5, now: () => room.now })
      : null;
  const host = new HostSession({
    transport: hub.createHost(),
    hostName: 'Host',
    roomCode: 'BTS22',
    createMatchWorld: () => greybox(),
    profileClock: () => performance.now(),
    recycledBuffers: true,
    countdownTicks: 45,
    cinematics: false,
  });
  const bots = new NetBots({
    count,
    seed: options.seed ?? 1,
    predict: options.predict === true,
    fight: options.fight !== false,
    createMatchWorld: () => greybox(),
    createTransport: () =>
      netsim !== null ? netsim.wrapClient(hub.createClient()) : hub.createClient(),
  });
  const hostFrame = createInputFrame();
  const hostPilot = new BotPilot(999);
  let nextTickAt = 0;
  let nextFrameAt = 0;
  const step = (): void => {
    room.now += 1;
    hub.pump();
    if (netsim !== null) netsim.pump(room.now);
    host.update(room.now);
    while (room.now >= nextTickAt) {
      nextTickAt += TICK_MS;
      const own = host.sim?.getDragon(host.localPlayerId) ?? null;
      hostPilot.sample(hostFrame, own);
      host.tick(hostFrame);
    }
    if (room.now >= nextFrameAt) {
      nextFrameAt += 1000 / 60;
      bots.update(room.now);
      bots.markOnHost(host);
    }
  };
  room.hub = hub;
  room.host = host;
  room.bots = bots;
  room.run = (ms) => {
    const end = room.now + ms;
    while (room.now < end) step();
  };
  room.runUntil = (done, maxMs) => {
    const end = room.now + maxMs;
    while (!done()) {
      if (room.now >= end) throw new Error(`bot room: condition not met in ${maxMs} ms`);
      step();
    }
  };
  host.open();
  room.run(5);
  bots.connect(host.roomCode, room.now);
  return room;
}

describe('BotPilot', () => {
  it('is deterministic per seed, stays in range and uses the whole move set', () => {
    const run = (seed: number): { digest: number; buttons: number } => {
      const pilot = new BotPilot(seed);
      const frame = createInputFrame();
      const own = createSnapshotOwner();
      // Dive only applies above half the floor..ceiling band (see BotPilot).
      const band = GREYBOX_BOT_ARENA.ceilingY - GREYBOX_BOT_ARENA.floorY;
      own.position.y = GREYBOX_BOT_ARENA.floorY + band * 0.65;
      let digest = 0;
      let buttons = 0;
      for (let i = 0; i < 3000; i++) {
        own.position.x = Math.sin(i * 0.01) * 300;
        own.position.z = Math.cos(i * 0.013) * 300;
        own.yaw = Math.sin(i * 0.02) * 3;
        pilot.sample(frame, own);
        expect(Math.abs(frame.steerX)).toBeLessThanOrEqual(1);
        expect(Math.abs(frame.steerY)).toBeLessThanOrEqual(1);
        expect(frame.buttons & ~BUTTON_MASK).toBe(0);
        buttons |= frame.buttons;
        digest = (Math.imul(digest, 31) + Math.round(frame.steerX * 1e6) + frame.buttons) | 0;
      }
      return { digest, buttons };
    };
    const a = run(7);
    expect(run(7)).toEqual(a);
    expect(run(8).digest).not.toBe(a.digest);
    // Boost, flap, dive and both dodges all came up within 100 s.
    expect(a.buttons & 0b11111).toBe(0b11111);
  });

  it('turns for home when far out, too low or too high, and gives a neutral frame without a dragon', () => {
    const pilot = new BotPilot(3);
    const frame = createInputFrame();
    frame.steerX = 0.7;
    frame.buttons = 5;
    pilot.sample(frame, null);
    expect(frame).toMatchObject({ steerX: 0, steerY: 0, buttons: 0 });

    const own = createSnapshotOwner();
    // Far out on +X, flying further out (+X is yaw PI/2): it must turn, with no tricks.
    own.position.x = GREYBOX_BOT_ARENA.radius * 0.9;
    own.position.y = 350;
    own.yaw = Math.PI / 2;
    for (let i = 0; i < 50; i++) {
      pilot.sample(frame, own);
      expect(Math.abs(frame.steerX)).toBeGreaterThan(0.9);
      expect(frame.buttons).toBe(0);
    }
    // Low over the cloud sea: pull up.
    own.position.x = 0;
    own.position.y = 40;
    own.pitch = -0.2;
    pilot.sample(frame, own);
    expect(frame.steerY).toBeGreaterThan(0.5);
    // At the ceiling: push down.
    own.position.y = 690;
    own.pitch = 0.2;
    pilot.sample(frame, own);
    expect(frame.steerY).toBeLessThan(-0.5);
  });
});

describe('net-bots', () => {
  it('join by code, pick a class, ready up and are flagged as bots on the host', () => {
    const room = createBotRoom(5);
    room.runUntil(() => room.bots.connectedCount === 5, 5000);
    room.run(3000);
    const lobby = room.host.lobby;
    expect(lobby.players).toHaveLength(6);
    const seats = lobby.players.filter((p) => !p.isHost);
    expect(seats.map((p) => p.name)).toEqual(['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4', 'Bot 5']);
    for (const seat of seats) {
      expect(seat.isBot).toBe(true);
      expect(seat.ready).toBe(true);
      expect(seat.side).not.toBe('spectator');
      expect(DRAGON_CLASS_IDS).toContain(seat.classId);
    }
    // Seeded class picks: not everyone on the default.
    expect(new Set(seats.map((p) => p.classId)).size).toBeGreaterThan(1);
    expect(room.host.startBlocker()).toBeNull();
    // The bots stayed inside the intent rate limit while doing it.
    expect(room.host.counters.intentsRefused).toBe(0);

    // A dropped bot's seat is not held.
    room.bots.clients[0]?.dispose();
    room.run(200);
    expect(room.host.lobby.players).toHaveLength(5);
    room.bots.dispose();
    room.host.close();
  });

  it('with prediction on, a bot is a full client and predicts exactly', () => {
    const room = createBotRoom(3, { predict: true });
    room.runUntil(() => room.bots.connectedCount === 3, 5000);
    room.run(3000);
    expect(room.host.applyIntent({ type: 'host.start' })).toBe(true);
    room.runUntil(() => room.host.matchPhase === 'playing', 10_000);
    room.run(10_000);
    for (const client of room.bots.clients) {
      expect(client.predictor.active).toBe(true);
      expect(client.predictor.matchCount).toBeGreaterThan(150);
      // Host-only combat (AOE zones, snapshot bombs) can force a couple of reconciles over a
      // long fight; the bar is "almost exact", not zero corrections forever.
      expect(client.predictor.correctionCount).toBeLessThanOrEqual(3);
      expect(client.matchWorld).toBe(greybox());
    }
    room.bots.dispose();
    room.host.close();
  });

  it('fly through netsim too (wrapped loopback transports)', () => {
    const room = createBotRoom(5, { netsim: true });
    room.runUntil(() => room.bots.connectedCount === 5, 5000);
    room.run(3000);
    expect(room.host.applyIntent({ type: 'host.start' })).toBe(true);
    room.runUntil(() => room.host.matchPhase === 'playing', 10_000);
    room.run(8000);
    for (const client of room.bots.clients) {
      expect(client.status).toBe('connected');
      expect(client.pingMs).toBeGreaterThan(25);
      expect(client.pingMs).toBeLessThan(80);
      const buffer = room.host.inputBufferOf(client.localPlayerId);
      expect(buffer?.storedCount).toBeGreaterThan(200);
      expect(buffer?.emptyCount).toBeLessThan(15);
    }
    room.bots.dispose();
    room.host.close();
  });
});

describe('load: host + 9 bots for 600 ticks', () => {
  it('stays far inside the tick budget and inside 7 KB/s per client', () => {
    // The quiet-sky baseline of Phase 2: these bots only fly (`fight: false`). The fighting
    // room is measured in the next test.
    const room = createBotRoom(MAX_CLIENT_RIDERS, { fight: false });
    room.runUntil(() => room.bots.connectedCount === MAX_CLIENT_RIDERS, 5000);
    room.run(4000);
    expect(room.host.lobby.players).toHaveLength(10);
    expect(room.host.startBlocker()).toBeNull();
    expect(room.host.applyIntent({ type: 'host.start' })).toBe(true);
    room.runUntil(() => room.host.matchPhase === 'playing', 10_000);
    const sim = room.host.sim;
    if (sim === null) throw new Error('no sim');
    expect(sim.current.dragonCount).toBe(10);

    // Warm up (JIT, input timing), then measure 600 ticks.
    room.run(3000);
    room.host.resetTiming();
    const startTick = room.host.hostTick;
    const sentBefore = room.host.stats.sentBytes;
    const receivedBefore = room.host.stats.receivedBytes;
    const botReceivedBefore = room.bots.clients.map((c) => c.stats.receivedBytes);
    const botSentBefore = room.bots.clients.map((c) => c.stats.sentBytes);
    const storedBefore = room.bots.clients.map(
      (c) => room.host.inputBufferOf(c.localPlayerId)?.storedCount ?? 0,
    );
    let deaths = 0;
    const alive = new Map<number, boolean>();
    room.runUntil(() => {
      for (const dragon of sim.current.dragons) {
        if (!dragon.active) continue;
        const now = (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
        if (alive.get(dragon.id) === true && !now) deaths++;
        alive.set(dragon.id, now);
      }
      return room.host.hostTick >= startTick + 600;
    }, 30_000);

    const ticks = room.host.hostTick - startTick;
    const seconds = ticks / TICK_HZ;
    const timing = room.host.timing;
    const avgTotalUs = timing.sumTotalUs / timing.ticks;
    const avgInputsUs = timing.sumInputsUs / timing.ticks;
    const avgSimUs = timing.sumSimUs / timing.ticks;
    const avgSnapshotUs = timing.sumSnapshotUs / timing.ticks;
    const downPerClient = (room.host.stats.sentBytes - sentBefore) / seconds / MAX_CLIENT_RIDERS;
    const upPerClient =
      (room.host.stats.receivedBytes - receivedBefore) / seconds / MAX_CLIENT_RIDERS;
    const botDown = room.bots.clients.map(
      (c, i) => (c.stats.receivedBytes - (botReceivedBefore[i] ?? 0)) / seconds,
    );
    const botUp = room.bots.clients.map(
      (c, i) => (c.stats.sentBytes - (botSentBefore[i] ?? 0)) / seconds,
    );

    console.log(
      `[load] host + ${MAX_CLIENT_RIDERS} bots, ${ticks} ticks: ` +
        `avg ${avgTotalUs.toFixed(0)} us/tick (inputs ${avgInputsUs.toFixed(0)}, ` +
        `sim ${avgSimUs.toFixed(0)}, snapshots ${avgSnapshotUs.toFixed(0)}), ` +
        `max ${timing.maxTotalUs.toFixed(0)} us; ` +
        `per client down ${downPerClient.toFixed(0)} B/s, up ${upPerClient.toFixed(0)} B/s; ` +
        `host up total ${(downPerClient * MAX_CLIENT_RIDERS).toFixed(0)} B/s; deaths ${deaths}`,
    );

    // --- CPU: the tick budget is 33.3 ms; a loose bound that still catches a regression of
    // an order of magnitude on any machine ---------------------------------------------------
    expect(timing.ticks).toBe(ticks);
    expect(avgTotalUs).toBeLessThan(3000);
    expect(avgSnapshotUs).toBeLessThan(1500);

    // --- Bytes: the budget is about 7 KB/s per client in a fight (docs/NETWORKING.md). A
    // quiet 5v5 is 20 snapshots of about 255 B (209 + the packed owner block) = 5 KB/s; zones,
    // slow projectiles and events come on top in a fight. These bots only fly. ------------------
    expect(downPerClient).toBeLessThan(6.5 * 1024);
    // 20 snapshots/s of 209 B + the owner mask is the floor: the real codec ran for everyone.
    expect(downPerClient).toBeGreaterThan(20 * 227);
    for (let i = 0; i < MAX_CLIENT_RIDERS; i++) {
      expect(botDown[i]).toBeLessThan(6.5 * 1024);
      expect(botDown[i]).toBeGreaterThan(20 * 227);
      // 30 inputs/s of 36 B (three frames with aim) plus pings.
      expect(botUp[i]).toBeGreaterThan(30 * 36 * 0.95);
      expect(botUp[i]).toBeLessThan(1280);
    }
    expect(upPerClient).toBeLessThan(1280);

    // --- The host did the full per-client work ------------------------------------------------
    room.bots.clients.forEach((client, i) => {
      const buffer = room.host.inputBufferOf(client.localPlayerId);
      const stored = (buffer?.storedCount ?? 0) - (storedBefore[i] ?? 0);
      expect(stored).toBeGreaterThanOrEqual(ticks - 3);
      expect(stored).toBeLessThanOrEqual(ticks + 3);
      expect(room.host.playerPings[client.localPlayerId]).toBeGreaterThanOrEqual(0);
    });

    // --- The bots fly sanely: nobody ends up in the storm, few die at all ----------------------
    const world = greybox();
    let aliveNow = 0;
    for (const dragon of sim.current.dragons) {
      if (!dragon.active) continue;
      expect(Number.isFinite(dragon.position.x)).toBe(true);
      if ((dragon.flags & DRAGON_FLAG_ALIVE) !== 0) {
        aliveNow++;
        expect(Math.hypot(dragon.position.x, dragon.position.z)).toBeLessThan(world.radius);
      }
    }
    expect(aliveNow).toBeGreaterThanOrEqual(8);
    expect(deaths).toBeLessThanOrEqual(6);
    room.bots.dispose();
    room.host.close();
  });
});

describe('load: host + 9 FIGHTING bots (T-3.10)', () => {
  it('the bots fight through the real codec path, inside the tick and byte budgets', () => {
    const room = createBotRoom(MAX_CLIENT_RIDERS, { seed: 3 });
    room.runUntil(() => room.bots.connectedCount === MAX_CLIENT_RIDERS, 5000);
    room.run(4000);
    expect(room.host.applyIntent({ type: 'host.start' })).toBe(true);
    // Nobody presses anything during the countdown (the host would ignore it anyway).
    room.runUntil(() => room.host.matchPhase === 'playing', 10_000);
    const sim = room.host.sim;
    if (sim === null) throw new Error('no sim');
    expect(sim.current.dragonCount).toBe(10);

    // The teams meet in the middle after about 10 s; measure the 60 s after that.
    room.run(12_000);
    room.host.resetTiming();
    const startTick = room.host.hostTick;
    const sentBefore = room.host.stats.sentBytes;
    const takedownsBefore =
      (sim.current.teamTakedowns[0] ?? 0) + (sim.current.teamTakedowns[1] ?? 0);
    room.runUntil(() => room.host.hostTick >= startTick + 60 * TICK_HZ, 120_000);

    const ticks = room.host.hostTick - startTick;
    const seconds = ticks / TICK_HZ;
    const timing = room.host.timing;
    const downPerClient = (room.host.stats.sentBytes - sentBefore) / seconds / MAX_CLIENT_RIDERS;
    const takedowns =
      (sim.current.teamTakedowns[0] ?? 0) + (sim.current.teamTakedowns[1] ?? 0) - takedownsBefore;
    let damage = 0;
    for (const score of sim.current.scores) damage += score.damage;
    console.log(
      `[load] host + ${MAX_CLIENT_RIDERS} fighting bots, ${ticks} ticks: ` +
        `avg ${(timing.sumTotalUs / timing.ticks).toFixed(0)} us/tick ` +
        `(sim ${(timing.sumSimUs / timing.ticks).toFixed(0)}, ` +
        `snapshots ${(timing.sumSnapshotUs / timing.ticks).toFixed(0)}), ` +
        `max ${timing.maxTotalUs.toFixed(0)} us; per client down ${downPerClient.toFixed(0)} B/s; ` +
        `takedowns ${takedowns}, damage ${damage.toFixed(0)}`,
    );

    // The fight is real: inputs with ability buttons crossed the codec and the host acted.
    expect(takedowns).toBeGreaterThanOrEqual(3);
    expect(damage).toBeGreaterThan(500);
    // A loose bound on time: an order of magnitude inside the 33 ms tick. Bytes: a 5v5 fight,
    // averaged, stays inside the 7 KB/s per client of docs/NETWORKING.md (about 6.5 here).
    expect(timing.sumTotalUs / timing.ticks).toBeLessThan(3000);
    expect(downPerClient).toBeLessThan(7 * 1024);
    for (const dragon of sim.current.dragons) {
      if (!dragon.active) continue;
      expect(Number.isFinite(dragon.position.x + dragon.position.y + dragon.position.z)).toBe(true);
    }
    for (const client of room.bots.clients) expect(client.status).toBe('connected');
    room.bots.dispose();
    room.host.close();
  });
});
