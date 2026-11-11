/**
 * The binary side of the page <-> host-worker protocol: record batches, the buffer ping-pong,
 * the per-tick view state and the stats record.
 */

import { describe, expect, it } from 'vitest';
import {
  AUX_CTRL,
  AUX_FAST,
  BATCH_BUFFER_BYTES,
  BATCH_HEADER_BYTES,
  BatchReader,
  BatchWriter,
  BufferPool,
  ExactBuffers,
  RECORD_HEADER_BYTES,
  RECORD_MAX_PAYLOAD,
  REC_CLOSE,
  REC_KEEPALIVE,
  REC_PACKET,
  REC_PEER_OPEN,
  STATE_RECORD_MAX_BYTES,
  STATS_FIXED_BYTES,
  createHostTickInfo,
  createHostViewState,
  createHostWorkerStats,
  decodeHostState,
  decodeHostStats,
  encodeHostState,
  encodeHostStats,
  findViewDragon,
  hostStateBytes,
  hostStatsBytes,
} from '../../src/net/worker';
import type { HostTickInfo, HostViewState } from '../../src/net/worker';
import {
  DEFAULT_HOST_SETTINGS,
  MATCH_PHASES,
  MAX_PLAYERS,
  createSeededRandom,
} from '../../src/shared';
import type { LobbyState } from '../../src/shared';
import { createSim } from '../../src/sim';

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('record batches', () => {
  it('round-trips records of every shape in order', () => {
    const pool = new BufferPool();
    const writer = new BatchWriter(pool);
    expect(writer.empty).toBe(true);
    expect(writer.take(0)).toBeNull();

    expect(writer.mark(REC_PEER_OPEN, 0, 7)).toBe(true);
    expect(writer.copy(REC_PACKET, AUX_FAST, 7, bytesOf(1, 2, 3, 4, 5))).toBe(true);
    expect(writer.copy(REC_PACKET, AUX_CTRL, 0xfffffffe, bytesOf())).toBe(true);
    expect(writer.mark(REC_CLOSE, 0, 9)).toBe(true);
    expect(writer.empty).toBe(false);

    const buffer = writer.take(1234.5);
    expect(buffer).not.toBeNull();
    if (buffer === null) return;
    expect(writer.takenBytes).toBe(BATCH_HEADER_BYTES + 4 * RECORD_HEADER_BYTES + 5);
    expect(writer.empty).toBe(true);

    const reader = new BatchReader();
    expect(reader.open(buffer)).toBe(true);
    expect(reader.sentAtMs).toBe(1234.5);
    expect(reader.byteLength).toBe(writer.takenBytes);
    const seen: [number, number, number, number[]][] = [];
    while (reader.next()) {
      seen.push([
        reader.kind,
        reader.aux,
        reader.link,
        [...reader.bytes.subarray(reader.offset, reader.offset + reader.length)],
      ]);
    }
    expect(seen).toEqual([
      [REC_PEER_OPEN, 0, 7, []],
      [REC_PACKET, AUX_FAST, 7, [1, 2, 3, 4, 5]],
      [REC_PACKET, AUX_CTRL, 0xfffffffe, []],
      [REC_CLOSE, 0, 9, []],
    ]);
    expect(reader.next()).toBe(false);
  });

  it('asks for a flush when the buffer is full and loses nothing', () => {
    const pool = new BufferPool(256);
    const writer = new BatchWriter(pool);
    const sent: ArrayBuffer[] = [];
    writer.flush = (): void => {
      const buffer = writer.take(0);
      if (buffer !== null) sent.push(buffer);
    };
    const payload = new Uint8Array(100);
    for (let i = 0; i < 10; i++) {
      payload.fill(i);
      expect(writer.copy(REC_PACKET, AUX_FAST, i, payload)).toBe(true);
    }
    writer.flush();

    const reader = new BatchReader();
    const links: number[] = [];
    for (const buffer of sent) {
      expect(buffer.byteLength).toBe(256);
      expect(reader.open(buffer)).toBe(true);
      while (reader.next()) {
        links.push(reader.link);
        expect(reader.bytes[reader.offset]).toBe(reader.link);
        expect(reader.bytes[reader.offset + 99]).toBe(reader.link);
      }
    }
    expect(links).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sent.length).toBe(5);
  });

  it('carries a record larger than a pool buffer in a one-off buffer', () => {
    const pool = new BufferPool(128);
    const writer = new BatchWriter(pool);
    const big = new Uint8Array(1000).fill(0xab);
    expect(writer.copy(REC_PACKET, AUX_CTRL, 1, big)).toBe(true);
    const buffer = writer.take(0);
    expect(buffer?.byteLength).toBe(BATCH_HEADER_BYTES + RECORD_HEADER_BYTES + 1000);
    // Not a pool size: it is not kept when it comes back.
    if (buffer !== null) pool.release(buffer);
    expect(pool.acquire(10).byteLength).toBe(128);
    expect(writer.begin(REC_PACKET, 0, 0, RECORD_MAX_PAYLOAD + 1)).toBe(-1);
  });

  it('refuses buffers that are not batches and stops at a cut record', () => {
    const reader = new BatchReader();
    expect(reader.open(new ArrayBuffer(4))).toBe(false);
    const lying = new ArrayBuffer(64);
    new DataView(lying).setUint32(0, 9999, true);
    expect(reader.open(lying)).toBe(false);

    const writer = new BatchWriter(new BufferPool(64));
    writer.copy(REC_PACKET, 0, 1, bytesOf(1, 2, 3));
    const buffer = writer.take(0);
    if (buffer === null) throw new Error('no batch');
    const view = new DataView(buffer);
    // Claims two records and a payload that runs past the used bytes.
    view.setUint16(4, 2, true);
    view.setUint16(BATCH_HEADER_BYTES + 2, 500, true);
    expect(reader.open(buffer)).toBe(true);
    expect(reader.next()).toBe(false);
  });

  it('reuses buffers that are handed back, so a steady exchange allocates none', () => {
    const pool = new BufferPool();
    const writer = new BatchWriter(pool);
    for (let i = 0; i < 200; i++) {
      writer.mark(REC_KEEPALIVE, 0, 0);
      const buffer = writer.take(i);
      if (buffer === null) throw new Error('no batch');
      expect(buffer.byteLength).toBe(BATCH_BUFFER_BYTES);
      // The other side reads it and hands it back with its next message.
      pool.release(buffer);
    }
    expect(pool.allocated).toBe(1);
  });

  it('hands out exact-size scratch buffers that are reused per size', () => {
    const exact = new ExactBuffers();
    const source = bytesOf(9, 8, 7, 6, 5, 4);
    const a = exact.filled(source, 1, 3);
    expect([...a]).toEqual([8, 7, 6]);
    expect(a.buffer.byteLength).toBe(3);
    const b = exact.filled(source, 3, 3);
    expect(b).toBe(a);
    expect([...b]).toEqual([6, 5, 4]);
    expect(exact.filled(source, 0, 2)).not.toBe(a);
  });
});

function flownSim(seed: number, dragons: number, ticks: number): ReturnType<typeof createSim> {
  const sim = createSim();
  const random = createSeededRandom(seed);
  const classes = ['talon', 'bastion', 'tempest', 'wraith'] as const;
  for (let i = 0; i < dragons; i++) {
    sim.spawnDragon(
      i * 3 + 1,
      i % 2 === 0 ? 0 : 1,
      classes[i % 4] ?? 'talon',
      { x: random() * 400 - 200, y: 300 + random() * 100, z: random() * 400 - 200 },
      random() * 6 - 3,
    );
  }
  const inputs: { tick: number; steerX: number; steerY: number; buttons: number }[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    for (let i = 0; i < dragons; i++) {
      inputs[i * 3 + 1] = {
        tick,
        steerX: random() * 2 - 1,
        steerY: random() * 2 - 1,
        buttons: Math.floor(random() * 2048),
      };
    }
    sim.step(tick, inputs);
  }
  return sim;
}

function expectSameState(mirror: Readonly<HostViewState>, state: Readonly<HostViewState>): void {
  expect(mirror.tick).toBe(state.tick);
  expect(mirror.timeS).toBe(state.timeS);
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const a = mirror.dragons[i];
    const b = state.dragons[i];
    if (a === undefined || b === undefined) throw new Error('missing slot');
    expect(a.active).toBe(b.active);
    if (!b.active) continue;
    expect(a.id).toBe(b.id);
    expect(a.team).toBe(b.team);
    expect(a.classId).toBe(b.classId);
    expect(a.flags).toBe(b.flags);
    expect(a.anim).toBe(b.anim);
    // Bit-identical, not merely close.
    expect(a.position).toEqual(b.position);
    expect(a.velocity).toEqual(b.velocity);
    expect(a.orientation).toEqual(b.orientation);
    expect(a.health).toBe(b.health);
    expect(a.maxHealth).toBe(b.maxHealth);
    expect(a.stamina).toBe(b.stamina);
  }
}

describe('view state record', () => {
  it('mirrors prev and current bit for bit, with unpacked slots', () => {
    const sim = flownSim(7, MAX_PLAYERS, 40);
    // A hole in the pool: live slots are not packed at the front.
    sim.despawnDragon(4);
    sim.despawnDragon(13);
    const info: HostTickInfo = {
      hostTick: 123456,
      tickAtMs: 1_731_300_000_123.25,
      phase: 'playing',
      phaseTimeS: 41.3,
      localIsRider: true,
      aimX: -0.5,
      aimY: 0.25,
      inputAgeMs: 7.5,
      stepUs: 80,
      simUs: 50,
      snapshotUs: 30,
      pulseUs: 120,
    };
    const bytes = hostStateBytes(sim.prev, sim.current);
    expect(bytes).toBeLessThanOrEqual(STATE_RECORD_MAX_BYTES);
    const buffer = new ArrayBuffer(bytes + 32);
    const view = new DataView(buffer);
    expect(encodeHostState(view, 16, info, sim.prev, sim.current)).toBe(bytes);

    const outInfo = createHostTickInfo();
    const prev = createHostViewState();
    const current = createHostViewState();
    // Stale content in the mirror must not survive a decode.
    for (const dragon of current.dragons) dragon.active = true;
    expect(decodeHostState(view, 16, bytes, outInfo, prev, current)).toBe(true);
    expect(outInfo).toEqual(info);
    expectSameState(prev, sim.prev);
    expectSameState(current, sim.current);
    expect(findViewDragon(current, 4)).toBeUndefined();
    expect(findViewDragon(current, 7)?.id).toBe(7);
  });

  it('fits the largest state and encodes an empty one', () => {
    const full = flownSim(3, MAX_PLAYERS, 2);
    expect(hostStateBytes(full.prev, full.current)).toBe(STATE_RECORD_MAX_BYTES);
    const empty = createSim();
    const bytes = hostStateBytes(empty.prev, empty.current);
    const view = new DataView(new ArrayBuffer(bytes));
    const info = createHostTickInfo();
    expect(encodeHostState(view, 0, info, empty.prev, empty.current)).toBe(bytes);
    const prev = createHostViewState();
    const current = createHostViewState();
    expect(decodeHostState(view, 0, bytes, createHostTickInfo(), prev, current)).toBe(true);
    expect(current.dragons.every((dragon) => !dragon.active)).toBe(true);
  });

  it('every match phase survives the trip', () => {
    const sim = createSim();
    const view = new DataView(new ArrayBuffer(STATE_RECORD_MAX_BYTES));
    for (const phase of MATCH_PHASES) {
      const info = { ...createHostTickInfo(), phase };
      const bytes = encodeHostState(view, 0, info, sim.prev, sim.current);
      const out = createHostTickInfo();
      expect(
        decodeHostState(view, 0, bytes, out, createHostViewState(), createHostViewState()),
      ).toBe(true);
      expect(out.phase).toBe(phase);
    }
  });

  it('refuses a cut or padded record', () => {
    const sim = flownSim(1, 3, 2);
    const bytes = hostStateBytes(sim.prev, sim.current);
    const view = new DataView(new ArrayBuffer(bytes + 8));
    encodeHostState(view, 0, createHostTickInfo(), sim.prev, sim.current);
    const decode = (length: number): boolean =>
      decodeHostState(
        view,
        0,
        length,
        createHostTickInfo(),
        createHostViewState(),
        createHostViewState(),
      );
    expect(decode(bytes)).toBe(true);
    expect(decode(bytes - 1)).toBe(false);
    expect(decode(bytes + 1)).toBe(false);
    expect(decode(10)).toBe(false);
    expect(decode(bytes + 100)).toBe(false);
  });
});

describe('stats record', () => {
  const lobby: LobbyState = {
    roomCode: 'KH7P2',
    hostId: 0,
    phase: 'lobby',
    settings: DEFAULT_HOST_SETTINGS,
    players: [
      {
        id: 0,
        name: 'Host',
        side: 0,
        perch: 0,
        classId: 'talon',
        ready: true,
        isHost: true,
        isBot: false,
        connected: true,
        reconnectDeadlineTick: -1,
      },
      {
        id: 3,
        name: 'Away',
        side: 1,
        perch: 0,
        classId: 'wraith',
        ready: false,
        isHost: false,
        isBot: false,
        connected: false,
        reconnectDeadlineTick: 900,
      },
      {
        id: 9,
        name: 'Guest',
        side: 1,
        perch: 1,
        classId: 'bastion',
        ready: true,
        isHost: false,
        isBot: false,
        connected: true,
        reconnectDeadlineTick: -1,
      },
    ],
  };

  it("round-trips the figures and everybody's ping", () => {
    const stats = createHostWorkerStats();
    stats.sentBytesPerS = 52_000;
    stats.receivedBytesPerS = 6_250;
    stats.malformed = 3;
    stats.ticks = 98_765;
    stats.clientCount = 9;
    stats.botCount = 8;
    stats.botsConnected = 7;
    stats.stepMs = 0.25;
    stats.simMs = 0.125;
    stats.snapshotMs = 0.0625;
    stats.maxStepMs = 1.5;
    stats.pulseMs = 0.5;
    stats.pulseMaxMs = 3;
    stats.lateMs = 0.75;
    stats.lateMaxMs = 4;
    stats.inputAgeMs = 8.5;
    stats.inputAgeMaxMs = 17;
    stats.inputHeldTicks = 12;
    const pings: number[] = new Array<number>(256).fill(-1);
    pings[0] = 0;
    pings[3] = 80;
    pings[9] = 42;

    const bytes = hostStatsBytes(lobby);
    expect(bytes).toBe(STATS_FIXED_BYTES + 9);
    const view = new DataView(new ArrayBuffer(bytes + 4));
    expect(encodeHostStats(view, 4, stats, lobby, pings)).toBe(bytes);

    const out = createHostWorkerStats();
    const outPings: number[] = new Array<number>(256).fill(123);
    expect(decodeHostStats(view, 4, bytes, out, outPings)).toBe(true);
    expect(out).toEqual(stats);
    expect(outPings[0]).toBe(0);
    // A player whose seat is held has no ping.
    expect(outPings[3]).toBe(-1);
    expect(outPings[9]).toBe(42);
    expect(outPings[5]).toBe(-1);
    expect(decodeHostStats(view, 4, bytes - 1, out, outPings)).toBe(false);
  });
});
