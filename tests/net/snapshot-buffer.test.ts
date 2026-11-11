import { describe, expect, it } from 'vitest';
import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_SPAWN_PROTECTED,
  INTERP_DELAY_MAX_MS,
  INTERP_DELAY_MIN_MS,
  MAX_EXTRAPOLATION_MS,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  TICK_MS,
  createSeededRandom,
  createWorldView,
  findDragonView,
} from '../../src/shared';
import type { MatchRoster } from '../../src/shared';
import { createSim } from '../../src/sim';
import { ClientPredictor } from '../../src/net/prediction';
import { createSnapshotMessage } from '../../src/net/protocol';
import type { SnapshotMessage } from '../../src/net/protocol';
import {
  ClientRoster,
  HostSnapshotBuilder,
  PLAYBACK_MAX_WARP,
  PlaybackClock,
  SNAPSHOT_BUFFER_CAPACITY,
  SNAPSHOT_MAX_GAP_TICKS,
  SnapshotBuffer,
  buildClientWorldView,
  createSnapshotClock,
  createSnapshotSample,
  findSampledDragon,
  shouldSendSnapshot,
} from '../../src/net/snapshot';

// --- Helpers -----------------------------------------------------------------------------------------

/** A snapshot with one dragon per entry: straight flight along +X at `speed`, y = 100 * id. */
function straight(tick: number, ids: readonly number[], speed = 30): SnapshotMessage {
  const msg = createSnapshotMessage();
  msg.tick = tick & 0xffff;
  msg.phase = 'playing';
  msg.dragonCount = ids.length;
  ids.forEach((id, i) => {
    const dragon = msg.dragons[i];
    if (dragon === undefined) throw new Error('no slot');
    dragon.id = id;
    dragon.position.x = tick * TICK_DT_S * speed;
    dragon.position.y = 100 * id;
    dragon.position.z = 0;
    dragon.velocity.x = speed;
    dragon.velocity.y = 0;
    dragon.velocity.z = 0;
    dragon.flags = DRAGON_FLAG_ALIVE;
    dragon.health = 1;
    dragon.stamina = 0.5;
  });
  return msg;
}

function xAt(buffer: SnapshotBuffer, playTick: number, id = 1): number | undefined {
  const sample = buffer.sampleAt(createSnapshotSample(), playTick);
  return findSampledDragon(sample, id)?.position.x;
}

// --- Schedule ----------------------------------------------------------------------------------------

describe('shouldSendSnapshot', () => {
  it('sends 20 of every 30 ticks, never more than two ticks apart', () => {
    let sent = 0;
    let gap = 0;
    let longestGap = 0;
    for (let tick = 0; tick < 3000; tick++) {
      gap++;
      if (shouldSendSnapshot(tick)) {
        sent++;
        longestGap = Math.max(longestGap, gap);
        gap = 0;
      }
    }
    expect(sent).toBe(2000);
    expect(longestGap).toBe(SNAPSHOT_MAX_GAP_TICKS);
    expect(SNAPSHOT_MAX_GAP_TICKS).toBe(2);
  });

  it('is exact for any second, including past the 16-bit wrap and for huge ticks', () => {
    for (const start of [0, 65520, 1_000_000_020, 2 ** 40]) {
      let sent = 0;
      for (let tick = start; tick < start + 30; tick++) if (shouldSendSnapshot(tick)) sent++;
      expect(sent).toBe(20);
    }
    expect(shouldSendSnapshot(0)).toBe(true);
  });

  it('says no to ticks that are not ticks', () => {
    expect(shouldSendSnapshot(-1)).toBe(false);
    expect(shouldSendSnapshot(1.5)).toBe(false);
    expect(shouldSendSnapshot(Number.NaN)).toBe(false);
  });
});

// --- Host builder ------------------------------------------------------------------------------------

describe('HostSnapshotBuilder', () => {
  it('fills the shared part once and the owner and ack per recipient', () => {
    const sim = createSim();
    sim.spawnDragon(0, TEAM_EMBER, 'talon', { x: 0, y: 300, z: 0 }, 0);
    sim.spawnDragon(3, TEAM_FROST, 'bastion', { x: 50, y: 310, z: 20 }, 1);
    for (let tick = 0; tick < 5; tick++) sim.step(tick, []);

    const builder = new HostSnapshotBuilder();
    const clock = createSnapshotClock();
    clock.phase = 'countdown';
    clock.round = 2;
    clock.phaseTimeS = 1.5;
    clock.timeRemainingS = 90;
    clock.scoreEmber = 4;
    clock.scoreFrost = 7;
    builder.begin(sim.current, clock);

    const forThree = builder.forRecipient(3, true, 70_000);
    expect(forThree).toBe(builder.message);
    expect(forThree.tick).toBe(4);
    expect(forThree.dragonCount).toBe(2);
    expect(forThree.phase).toBe('countdown');
    expect(forThree.round).toBe(2);
    expect(forThree.phaseTimeS).toBe(1.5);
    expect(forThree.timeRemainingS).toBe(90);
    expect(forThree.scoreEmber).toBe(4);
    expect(forThree.scoreFrost).toBe(7);
    expect(forThree.hasAck).toBe(true);
    expect(forThree.ackInputTick).toBe(70_000 & 0xffff);
    expect(forThree.hasOwner).toBe(true);
    expect(forThree.owner.id).toBe(3);
    expect(forThree.owner.position.x).toBe(sim.getDragon(3)?.position.x);

    // The next recipient reuses the struct: nothing of the previous one may leak.
    const forZero = builder.forRecipient(0, false, 1234);
    expect(forZero.hasAck).toBe(false);
    expect(forZero.ackInputTick).toBe(0);
    expect(forZero.owner.id).toBe(0);
    expect(forZero.dragonCount).toBe(2);

    // Spectators and riders without a dragon get no owner block.
    expect(builder.forRecipient(NO_PLAYER, false, 0).hasOwner).toBe(false);
    expect(builder.forRecipient(9, true, 5).hasOwner).toBe(false);
  });
});

// --- Storage -----------------------------------------------------------------------------------------

describe('SnapshotBuffer storage', () => {
  it('is empty until the first snapshot', () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.count).toBe(0);
    expect(buffer.newestTick).toBe(-1);
    expect(buffer.oldestTick).toBe(-1);
    const sample = buffer.sample(createSnapshotSample());
    expect(sample.valid).toBe(false);
    expect(sample.dragonCount).toBe(0);
  });

  it('returns the full tick and copies the message', () => {
    const buffer = new SnapshotBuffer();
    const msg = straight(10, [1]);
    expect(buffer.push(msg, 0)).toBe(10);
    // Reusing the caller's struct must not change what is stored.
    const slot = msg.dragons[0];
    if (slot !== undefined) slot.position.x = 99_999;
    expect(xAt(buffer, 10)).toBeCloseTo(10 * TICK_DT_S * 30, 9);
  });

  it('drops duplicates and files out-of-order packets where they belong', () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.push(straight(10, [1]), 0)).toBe(10);
    expect(buffer.push(straight(14, [1]), 10)).toBe(14);
    expect(buffer.push(straight(12, [1]), 20)).toBe(12); // late, but still useful
    expect(buffer.push(straight(12, [1]), 30)).toBe(-1); // duplicate
    expect(buffer.push(straight(14, [1]), 30)).toBe(-1);
    expect(buffer.count).toBe(3);
    expect(buffer.duplicateCount).toBe(2);
    expect(buffer.outOfOrderCount).toBe(1);
    expect(buffer.oldestTick).toBe(10);
    expect(buffer.newestTick).toBe(14);
    // 11 lies between 10 and 12 now, not between 10 and 14.
    expect(xAt(buffer, 11)).toBeCloseTo(11 * TICK_DT_S * 30, 6);
  });

  it('keeps the newest `capacity` snapshots and drops what is older than all of them', () => {
    const buffer = new SnapshotBuffer(4);
    for (let tick = 10; tick < 20; tick += 2) buffer.push(straight(tick, [1]), tick);
    expect(buffer.count).toBe(4);
    expect(buffer.oldestTick).toBe(12);
    expect(buffer.newestTick).toBe(18);
    expect(buffer.push(straight(11, [1]), 99)).toBe(-1);
    expect(buffer.tooOldCount).toBe(1);
    // A late packet inside the window pushes the oldest out and stays sorted.
    expect(buffer.push(straight(15, [1]), 99)).toBe(15);
    expect(buffer.count).toBe(4);
    expect(buffer.oldestTick).toBe(14);
    expect(buffer.newestTick).toBe(18);
    expect(xAt(buffer, 15)).toBeCloseTo(15 * TICK_DT_S * 30, 9);
    expect(new SnapshotBuffer().count).toBe(0);
    expect(SNAPSHOT_BUFFER_CAPACITY).toBeGreaterThanOrEqual(16);
  });

  it('expands wire ticks across the 16-bit wrap', () => {
    const buffer = new SnapshotBuffer();
    // The reference says we are just under the second wrap.
    expect(buffer.push(straight(65_530, [1]), 0, 131_060)).toBe(131_066);
    expect(buffer.push(straight(65_534, [1]), 0)).toBe(131_070);
    expect(buffer.push(straight(2, [1]), 0)).toBe(131_074); // wire 2 = 65536 * 2 + 2
    expect(buffer.push(straight(65_532, [1]), 0)).toBe(131_068); // late, from before the wrap
    expect(buffer.count).toBe(4);
    expect(buffer.newestTick).toBe(131_074);
    // Interpolating across the wrap: the positions were built from the wire tick, so the
    // dragon "jumps back"; what matters is that 131072 lies between 131070 and 131074.
    const sample = buffer.sampleAt(createSnapshotSample(), 131_072);
    expect(sample.valid).toBe(true);
    expect(sample.starved).toBe(false);
    expect(sample.dragonCount).toBe(1);
  });

  it('starts over when the tick jumps to a different timeline', () => {
    const buffer = new SnapshotBuffer();
    for (let tick = 5000; tick < 5010; tick += 2) buffer.push(straight(tick, [1]), tick * TICK_MS);
    // New match: the host counts from 0 again.
    expect(buffer.push(straight(2, [1]), 200_000)).toBe(2);
    expect(buffer.restartCount).toBe(1);
    expect(buffer.count).toBe(1);
    expect(buffer.newestTick).toBe(2);
  });

  it('reset empties it', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(straight(10, [1]), 0);
    buffer.update(100);
    buffer.reset();
    expect(buffer.count).toBe(0);
    expect(buffer.receivedCount).toBe(0);
    expect(buffer.clock.running).toBe(false);
    expect(buffer.sample(createSnapshotSample()).valid).toBe(false);
  });
});

// --- Sampling ----------------------------------------------------------------------------------------

describe('SnapshotBuffer sampling', () => {
  it('interpolates position, velocity and orientation between the bracketing snapshots', () => {
    const buffer = new SnapshotBuffer();
    const a = straight(30, [1]);
    const b = straight(32, [1]);
    const qa = a.dragons[0];
    const qb = b.dragons[0];
    if (qa === undefined || qb === undefined) throw new Error('no slot');
    // Yaw 0 -> yaw 0.2 rad, with the second quaternion negated (same rotation, other sign).
    qb.orientation.y = -Math.sin(0.1);
    qb.orientation.w = -Math.cos(0.1);
    qb.velocity.z = 6;
    buffer.push(a, 0);
    buffer.push(b, 0);

    const sample = buffer.sampleAt(createSnapshotSample(), 31);
    const dragon = findSampledDragon(sample, 1);
    expect(sample.valid).toBe(true);
    expect(sample.starved).toBe(false);
    expect(dragon?.extrapolated).toBe(false);
    expect(dragon?.position.x).toBeCloseTo(31 * TICK_DT_S * 30, 6);
    expect(dragon?.velocity.z).toBeCloseTo(3, 9);
    // Halfway along the shorter arc: yaw 0.1.
    expect(Math.abs(dragon?.orientation.y ?? 0)).toBeCloseTo(Math.sin(0.05), 6);
    expect(Math.abs(dragon?.orientation.w ?? 0)).toBeCloseTo(Math.cos(0.05), 6);
    const q = dragon?.orientation ?? { x: 0, y: 0, z: 0, w: 0 };
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
  });

  it('follows a curve between snapshots (Hermite), which a lerp would cut', () => {
    // A circle of radius 100 m at 40 m/s, sampled every 2 ticks.
    const radius = 100;
    const omega = 0.4;
    const circle = (tick: number): SnapshotMessage => {
      const msg = straight(tick, [1]);
      const dragon = msg.dragons[0];
      if (dragon === undefined) throw new Error('no slot');
      const angle = omega * tick * TICK_DT_S;
      dragon.position.x = radius * Math.cos(angle);
      dragon.position.z = radius * Math.sin(angle);
      dragon.velocity.x = -radius * omega * Math.sin(angle);
      dragon.velocity.z = radius * omega * Math.cos(angle);
      return msg;
    };
    const buffer = new SnapshotBuffer();
    buffer.push(circle(30), 0);
    buffer.push(circle(32), 0);
    const sample = buffer.sampleAt(createSnapshotSample(), 31);
    const dragon = findSampledDragon(sample, 1);
    const angle = omega * 31 * TICK_DT_S;
    const error = Math.hypot(
      (dragon?.position.x ?? 0) - radius * Math.cos(angle),
      (dragon?.position.z ?? 0) - radius * Math.sin(angle),
    );
    // The chord's midpoint is 9 mm inside the circle; the Hermite curve is 100x closer.
    const lerpError = radius * (1 - Math.cos(omega * TICK_DT_S));
    expect(lerpError).toBeGreaterThan(0.008);
    expect(error).toBeLessThan(lerpError / 50);
  });

  it('falls back to a straight blend when the velocities do not describe the path (a bounce)', () => {
    const buffer = new SnapshotBuffer();
    const a = straight(30, [1], 60);
    const b = straight(32, [1], 60);
    const da = a.dragons[0];
    const db = b.dragons[0];
    if (da === undefined || db === undefined) throw new Error('no slot');
    // Flew into a wall and came back: almost no net movement, velocity reversed.
    db.position.x = da.position.x + 0.3;
    db.velocity.x = -30;
    buffer.push(a, 0);
    buffer.push(b, 0);
    const x = xAt(buffer, 31) ?? 0;
    expect(x).toBeCloseTo(da.position.x + 0.15, 6);
  });

  it('does not blend across a respawn: holds the old state, then snaps', () => {
    const buffer = new SnapshotBuffer();
    const dead = straight(30, [1], 0);
    const alive = straight(32, [1], 0);
    const before = dead.dragons[0];
    const after = alive.dragons[0];
    if (before === undefined || after === undefined) throw new Error('no slot');
    before.flags = 0;
    before.position.x = 100;
    after.flags = DRAGON_FLAG_ALIVE | DRAGON_FLAG_SPAWN_PROTECTED;
    after.position.x = 110; // close by: only the flags say it is a respawn
    buffer.push(dead, 0);
    buffer.push(alive, 0);
    expect(xAt(buffer, 30.5)).toBe(100);
    expect(xAt(buffer, 31.9)).toBe(100);
    expect(xAt(buffer, 32)).toBe(110);
  });

  it('does not blend across a jump no dragon could fly', () => {
    const buffer = new SnapshotBuffer();
    const a = straight(30, [1], 30);
    const b = straight(32, [1], 30);
    const db = b.dragons[0];
    if (db === undefined) throw new Error('no slot');
    db.position.x += 400;
    buffer.push(a, 0);
    buffer.push(b, 0);
    // Carries on along its own velocity instead of sweeping 400 m in 67 ms.
    expect(xAt(buffer, 31)).toBeCloseTo(31 * TICK_DT_S * 30, 6);
    expect(xAt(buffer, 32)).toBeCloseTo(32 * TICK_DT_S * 30 + 400, 6);
  });

  it('shows a dragon from the snapshot it first appears in and drops it after its last', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(straight(30, [1]), 0);
    buffer.push(straight(32, [1, 2]), 0);
    buffer.push(straight(34, [2]), 0);
    const sample = createSnapshotSample();
    buffer.sampleAt(sample, 31);
    expect(sample.dragonCount).toBe(1);
    expect(findSampledDragon(sample, 2)).toBeUndefined();
    buffer.sampleAt(sample, 32.5);
    expect(sample.dragonCount).toBe(2);
    // 1 is leaving: it carries on from its last state until the snapshot without it.
    expect(findSampledDragon(sample, 1)?.position.x).toBeCloseTo(32.5 * TICK_DT_S * 30, 6);
    buffer.sampleAt(sample, 34);
    expect(sample.dragonCount).toBe(1);
    expect(findSampledDragon(sample, 1)).toBeUndefined();
    expect(findSampledDragon(sample, 2)).toBeDefined();
  });

  it('shows the oldest snapshot as it is while the play tick is still before it', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(straight(30, [1]), 0);
    buffer.push(straight(32, [1]), 0);
    const sample = buffer.sampleAt(createSnapshotSample(), 27);
    expect(sample.starved).toBe(false);
    expect(findSampledDragon(sample, 1)?.position.x).toBeCloseTo(30 * TICK_DT_S * 30, 9);
    expect(findSampledDragon(sample, 1)?.extrapolated).toBe(false);
  });

  it('starved: extrapolates along the velocity for 150 ms, then holds', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(straight(30, [1]), 0);
    const sample = createSnapshotSample();
    const base = 30 * TICK_DT_S * 30;

    buffer.sampleAt(sample, 33); // 100 ms past the newest
    expect(sample.starved).toBe(true);
    expect(sample.extrapolatedMs).toBeCloseTo(100, 6);
    expect(findSampledDragon(sample, 1)?.extrapolated).toBe(true);
    expect(findSampledDragon(sample, 1)?.position.x).toBeCloseTo(base + 3, 6);

    const cap = base + (MAX_EXTRAPOLATION_MS / 1000) * 30;
    for (const playTick of [34.5, 36, 60, 600]) {
      buffer.sampleAt(sample, playTick);
      expect(sample.extrapolatedMs).toBe(MAX_EXTRAPOLATION_MS);
      expect(findSampledDragon(sample, 1)?.position.x).toBeCloseTo(cap, 9);
    }
  });

  it('blends out the extrapolation error when snapshots return, instead of popping', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(straight(30, [1]), 0);
    const sample = createSnapshotSample();
    // 4 ticks of extrapolation along +X...
    let playTick = 30;
    for (; playTick <= 34; playTick += 0.5) buffer.sampleAt(sample, playTick);
    const drawnBefore = findSampledDragon(sample, 1)?.position.z ?? 0;
    expect(drawnBefore).toBe(0);
    // ...but the dragon had turned: the truth is 3 m to the side.
    const truth = (tick: number): SnapshotMessage => {
      const msg = straight(tick, [1]);
      const dragon = msg.dragons[0];
      if (dragon !== undefined) dragon.position.z = 3;
      return msg;
    };
    buffer.push(truth(34), 0);
    buffer.push(truth(36), 0);
    buffer.push(truth(42), 0);

    let previous = drawnBefore;
    let largestStep = 0;
    for (; playTick <= 41; playTick += 0.5) {
      buffer.sampleAt(sample, playTick);
      const z = findSampledDragon(sample, 1)?.position.z ?? 0;
      expect(z).toBeGreaterThanOrEqual(previous - 1e-9); // monotonic toward the truth
      largestStep = Math.max(largestStep, z - previous);
      previous = z;
    }
    // Spread over several frames (a pop would be the whole 3 m at once) and done in 200 ms.
    expect(largestStep).toBeLessThan(1.5);
    expect(previous).toBeCloseTo(3, 2);
  });

  it('snaps instead of blending when the error is huge', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(straight(30, [1]), 0);
    const sample = createSnapshotSample();
    for (let playTick = 30; playTick <= 40; playTick += 0.5) buffer.sampleAt(sample, playTick);
    const far = straight(40, [1]);
    const far2 = straight(44, [1]);
    for (const msg of [far, far2]) {
      const dragon = msg.dragons[0];
      if (dragon !== undefined) dragon.position.z = 500;
    }
    buffer.push(far, 0);
    buffer.push(far2, 0);
    buffer.sampleAt(sample, 40.5);
    expect(findSampledDragon(sample, 1)?.position.z).toBe(500);
  });

  it('runs the clock on between snapshots and takes the scores from the newest', () => {
    const buffer = new SnapshotBuffer();
    const a = straight(30, [1]);
    a.phase = 'countdown';
    a.round = 3;
    a.phaseTimeS = 2;
    a.timeRemainingS = 10;
    a.scoreEmber = 1;
    const b = straight(33, [1]);
    b.phase = 'countdown';
    b.round = 3;
    b.phaseTimeS = 2.1;
    b.timeRemainingS = 9.9;
    b.scoreEmber = 2;
    b.scoreFrost = 5;
    buffer.push(a, 0);
    buffer.push(b, 0);
    const sample = buffer.sampleAt(createSnapshotSample(), 31.5);
    expect(sample.phase).toBe('countdown');
    expect(sample.round).toBe(3);
    expect(sample.phaseTimeS).toBeCloseTo(2.05, 9);
    expect(sample.timeRemainingS).toBeCloseTo(9.95, 9);
    expect(sample.scoreEmber).toBe(2);
    expect(sample.scoreFrost).toBe(5);
    expect(sample.playTick).toBe(31.5);

    // No time limit stays infinite; a phase change is not run into.
    const c = straight(35, [1]);
    c.phase = 'playing';
    c.phaseTimeS = 0;
    c.timeRemainingS = Infinity;
    buffer.push(c, 0);
    buffer.sampleAt(sample, 34);
    expect(sample.phase).toBe('countdown');
    expect(sample.phaseTimeS).toBeCloseTo(2.1, 9);
    buffer.sampleAt(sample, 35);
    expect(sample.phase).toBe('playing');
    expect(sample.timeRemainingS).toBe(Infinity);
  });
});

// --- Playback clock ----------------------------------------------------------------------------------

/** Feeds arrivals every 50 ms with the given jitter and frames at 60 Hz. */
function playback(
  clock: PlaybackClock,
  fromMs: number,
  toMs: number,
  jitterMs: number,
  seed: number,
  onFrame?: (nowMs: number) => void,
): void {
  const random = createSeededRandom(seed);
  const arrivals: { at: number; tick: number }[] = [];
  for (let sent = fromMs; sent < toMs; sent += 50) {
    arrivals.push({ at: sent + 80 + (random() * 2 - 1) * jitterMs, tick: sent / TICK_MS });
  }
  arrivals.sort((p, q) => p.at - q.at);
  let next = 0;
  for (let now = fromMs; now < toMs; now += 1000 / 60) {
    for (let arrival = arrivals[next]; arrival !== undefined && arrival.at <= now;) {
      clock.onSnapshot(arrival.tick, arrival.at);
      arrival = arrivals[++next];
    }
    clock.update(now);
    onFrame?.(now);
  }
}

describe('PlaybackClock', () => {
  it('does nothing before the first snapshot', () => {
    const clock = new PlaybackClock();
    clock.update(1000);
    expect(clock.playTick).toBe(0);
    expect(clock.running).toBe(false);
  });

  it('sits at the minimum delay on a clean link', () => {
    const clock = new PlaybackClock();
    playback(clock, 0, 10_000, 0, 1);
    expect(clock.jitterMs).toBeLessThan(0.5);
    expect(clock.delayMs).toBeCloseTo(INTERP_DELAY_MIN_MS, 3);
    // Host tick time of "now" is now - 80 ms latency; the playhead trails it by the delay.
    const expected = (10_000 - 80 - INTERP_DELAY_MIN_MS) / TICK_MS;
    expect(Math.abs(clock.playTick - expected)).toBeLessThan(1);
  });

  it('raises the delay with jitter, to about 100 ms at +-20 ms, and never past 150 ms', () => {
    const clock = new PlaybackClock();
    playback(clock, 0, 20_000, 20, 2);
    expect(clock.jitterMs).toBeGreaterThan(6);
    expect(clock.jitterMs).toBeLessThan(14);
    expect(clock.delayMs).toBeGreaterThan(85);
    expect(clock.delayMs).toBeLessThan(115);

    const rough = new PlaybackClock();
    playback(rough, 0, 20_000, 200, 3);
    expect(rough.delayMs).toBe(INTERP_DELAY_MAX_MS);
  });

  it('never runs backwards or jumps: the rate stays within the warp limit', () => {
    const clock = new PlaybackClock();
    let previous = -Infinity;
    let frames = 0;
    // Calm, then jittery, then calm again: the delay moves both ways.
    let lastNow = 0;
    const check = (nowMs: number): void => {
      if (!clock.running) return;
      const dtMs = nowMs - lastNow;
      lastNow = nowMs;
      // (The three phases below share a frame at their seams: skip the zero-length one.)
      if (frames++ > 0 && dtMs > 1) {
        expect(clock.playTick).toBeGreaterThan(previous);
        const advance = (clock.playTick - previous) * TICK_MS;
        expect(advance).toBeLessThanOrEqual(dtMs * (1 + PLAYBACK_MAX_WARP) + 1e-6);
        expect(advance).toBeGreaterThanOrEqual(dtMs * (1 - PLAYBACK_MAX_WARP) - 1e-6);
      }
      previous = clock.playTick;
      expect(clock.rate).toBeGreaterThanOrEqual(1 - PLAYBACK_MAX_WARP);
      expect(clock.rate).toBeLessThanOrEqual(1 + PLAYBACK_MAX_WARP);
    };
    playback(clock, 0, 5000, 0, 4, check);
    const calm = clock.delayMs;
    playback(clock, 5000, 12_000, 25, 5, check);
    expect(clock.delayMs).toBeGreaterThan(calm + 15);
    const rough = clock.delayMs;
    playback(clock, 12_000, 30_000, 0, 6, check);
    expect(clock.delayMs).toBeLessThan(rough - 15);
    expect(clock.snapCount).toBe(0);
  });

  it('follows a host clock that runs 0.5 % fast without ever snapping', () => {
    const clock = new PlaybackClock();
    for (let now = 0; now < 30_000; now += 1000 / 60) {
      // A snapshot every 3rd frame, stamped with a host tick that gains 5 ms per second.
      if (Math.round(now / (1000 / 60)) % 3 === 0) clock.onSnapshot((now * 1.005) / TICK_MS, now);
      clock.update(now);
    }
    expect(clock.snapCount).toBe(0);
    const target = (30_000 * 1.005 - clock.delayMs) / TICK_MS;
    expect(Math.abs(clock.playTick - target)).toBeLessThan(1);
    expect(clock.rate).toBeGreaterThan(1.002);
  });

  it('jumps when it is hopelessly off (the tab was asleep)', () => {
    const clock = new PlaybackClock();
    playback(clock, 0, 3000, 0, 7);
    const before = clock.playTick;
    // 5 s without a frame.
    clock.onSnapshot(8000 / TICK_MS, 8080);
    clock.update(8100);
    expect(clock.snapCount).toBe(1);
    expect((clock.playTick - before) * TICK_MS).toBeGreaterThan(4500);
  });

  it('ignores a single wildly late arrival', () => {
    const clock = new PlaybackClock();
    playback(clock, 0, 5000, 0, 8);
    const before = clock.estimatedArrivalTick(5000);
    clock.onSnapshot(4900 / TICK_MS, 4900 + 80 + 700);
    expect(Math.abs(clock.estimatedArrivalTick(5000) - before) * TICK_MS).toBeLessThan(5);
  });

  /**
   * Snapshots every 50 ms arriving 80 ms after their tick time, then `shiftMs` later still from
   * `shiftAtMs` on. Returns how long after the shift the last starved frame was (the playhead
   * past the newest snapshot), and the starved frame count.
   */
  function starvationAfterShift(
    clock: PlaybackClock,
    shiftAtMs: number,
    shiftMs: number,
    endMs: number,
  ): { lastStarvedAfterMs: number; starvedFrames: number } {
    const arrivals: { at: number; tick: number }[] = [];
    for (let sent = 0; sent < endMs; sent += 50) {
      arrivals.push({ at: sent + 80 + (sent >= shiftAtMs ? shiftMs : 0), tick: sent / TICK_MS });
    }
    let next = 0;
    let newestTick = -1;
    let lastStarvedMs = shiftAtMs;
    let starvedFrames = 0;
    for (let now = 0; now < endMs; now += 1000 / 60) {
      for (let arrival = arrivals[next]; arrival !== undefined && arrival.at <= now;) {
        clock.onSnapshot(arrival.tick, arrival.at);
        newestTick = arrival.tick;
        arrival = arrivals[++next];
      }
      clock.update(now);
      if (now >= shiftAtMs && clock.playTick > newestTick) {
        starvedFrames++;
        lastStarvedMs = now;
      }
    }
    return { lastStarvedAfterMs: lastStarvedMs - shiftAtMs, starvedFrames };
  }

  it('re-anchors when the whole timeline moves later (latency step, host hitch)', () => {
    // Warping alone closes 50 ms per second: a 280 ms shift used to starve playback for 6 s.
    for (const shiftMs of [150, 200, 280]) {
      const clock = new PlaybackClock();
      const result = starvationAfterShift(clock, 5000, shiftMs, 15_000);
      expect(clock.snapCount, `${shiftMs} ms`).toBe(1);
      expect(result.lastStarvedAfterMs, `${shiftMs} ms`).toBeLessThan(shiftMs + 300);
      expect(result.starvedFrames, `${shiftMs} ms`).toBeLessThan(40);
      // Settled on the new timeline: the playhead trails the newest arrivals by the delay.
      const expected = (15_000 - 80 - shiftMs - clock.delayMs) / TICK_MS;
      expect(Math.abs(clock.playTick - expected), `${shiftMs} ms`).toBeLessThan(1.5);
    }
  });

  it('does not re-anchor for a shift the delay already covers, nor for late stragglers', () => {
    const small = new PlaybackClock();
    starvationAfterShift(small, 5000, 40, 12_000);
    expect(small.snapCount).toBe(0);

    // Two late newest arrivals in a row, then normal again: one short of a re-anchor.
    const clock = new PlaybackClock();
    playback(clock, 0, 5000, 0, 9);
    const late = [
      { at: 5000 + 80 + 200, tick: 5000 / TICK_MS },
      { at: 5050 + 80 + 200, tick: 5050 / TICK_MS },
      { at: 5300 + 80, tick: 5300 / TICK_MS },
      { at: 5350 + 80, tick: 5350 / TICK_MS },
    ];
    let next = 0;
    for (let now = 5000; now < 5600; now += 1000 / 60) {
      for (let arrival = late[next]; arrival !== undefined && arrival.at <= now;) {
        clock.onSnapshot(arrival.tick, arrival.at);
        arrival = late[++next];
      }
      clock.update(now);
    }
    expect(next).toBe(late.length);
    expect(clock.snapCount).toBe(0);
  });
});

// --- Client WorldView ----------------------------------------------------------------------------------

describe('buildClientWorldView', () => {
  const roster = new ClientRoster();
  const matchRoster: MatchRoster = {
    settings: {} as MatchRoster['settings'],
    riders: [
      { playerId: 1, name: 'A', team: TEAM_FROST, classId: 'tempest', gateSlot: 2, isBot: false },
      { playerId: 2, name: 'B', team: TEAM_EMBER, classId: 'bastion', gateSlot: 2, isBot: true },
    ],
    spectators: [],
    solo: false,
  };
  roster.setFromMatchRoster(matchRoster);

  it('ClientRoster answers by id and falls back for strangers', () => {
    expect(roster.has(1)).toBe(true);
    expect(roster.teamOf(1)).toBe(TEAM_FROST);
    expect(roster.classOf(2)).toBe('bastion');
    expect(roster.has(7)).toBe(false);
    expect(roster.teamOf(7)).toBe(TEAM_EMBER);
    expect(roster.classOf(7)).toBe('talon');
    const other = new ClientRoster();
    other.set(4, TEAM_FROST, 'wraith');
    other.set(-1, TEAM_FROST, 'wraith');
    other.set(300, TEAM_FROST, 'wraith');
    expect(other.classOf(4)).toBe('wraith');
    other.remove(4);
    expect(other.has(4)).toBe(false);
  });

  it('draws every sampled dragon with roster team and class, the storm wall and the clock', () => {
    const buffer = new SnapshotBuffer();
    const a = straight(30, [1, 2, 7]);
    a.phase = 'playing';
    a.round = 2;
    a.phaseTimeS = 12;
    a.timeRemainingS = 48;
    buffer.push(a, 0);
    buffer.push(straight(32, [1, 2, 7]), 0);
    const sample = buffer.sampleAt(createSnapshotSample(), 31);

    const view = createWorldView();
    buildClientWorldView(view, sample, null, 0.5, roster, {
      localDragonId: NO_PLAYER,
      stormWall: { stormCenterX: 3, stormCenterZ: -4, stormRadius: 900 },
    });
    expect(view.dragonCount).toBe(3);
    expect(view.localDragonId).toBe(NO_PLAYER);
    const one = findDragonView(view, 1);
    expect(one?.team).toBe(TEAM_FROST);
    expect(one?.classId).toBe('tempest');
    expect(one?.position.x).toBeCloseTo(31 * TICK_DT_S * 30, 6);
    expect(one?.position.y).toBe(100);
    expect(one?.health).toBe(1);
    expect(one?.stamina).toBe(0.5);
    expect(one?.flags).toBe(DRAGON_FLAG_ALIVE);
    expect(findDragonView(view, 2)?.classId).toBe('bastion');
    expect(findDragonView(view, 7)?.classId).toBe('talon');
    expect(view.zoneCount).toBe(1);
    expect(view.zones[0]).toMatchObject({ id: 0, kind: 'stormWall', team: null, radius: 900 });
    expect(view.zones[0]?.position).toMatchObject({ x: 3, y: 0, z: -4 });
    expect(view.clock).toMatchObject({ tick: 31, phase: 'playing', round: 2 });
    expect(view.clock.phaseTimeS).toBeCloseTo(12 + TICK_DT_S, 9);
    expect(view.clock.timeRemainingS).toBeCloseTo(48 - TICK_DT_S, 9);

    // Options: hide strangers, override the phase, no storm wall.
    buildClientWorldView(view, sample, null, 0.5, roster, {
      localDragonId: NO_PLAYER,
      stormWall: null,
      phase: 'roundEnd',
      showUnknown: false,
    });
    expect(view.dragonCount).toBe(2);
    expect(view.zoneCount).toBe(0);
    expect(view.clock.phase).toBe('roundEnd');
  });

  it('takes the local dragon from the predictor and skips its snapshot copy', () => {
    const sim = createSim();
    sim.spawnDragon(1, TEAM_FROST, 'tempest', { x: 500, y: 300, z: 0 }, 0);
    sim.step(40, []);
    const builder = new HostSnapshotBuilder();
    builder.begin(sim.current, createSnapshotClock());
    const snapshot = builder.forRecipient(1, false, 0);

    const predictor = new ClientPredictor();
    predictor.configure(1, TEAM_FROST, 'tempest');
    predictor.setTick(40);
    const buffer = new SnapshotBuffer();
    const view = createWorldView();
    const options = { localDragonId: 1, stormWall: null };

    // Before the first owner block the predictor has nothing: nothing is drawn at all.
    buildClientWorldView(
      view,
      buffer.sample(createSnapshotSample()),
      predictor,
      0,
      roster,
      options,
    );
    expect(view.dragonCount).toBe(0);
    expect(view.clock.phase).toBe('lobby');
    expect(view.localDragonId).toBe(1);

    const tick = buffer.push(snapshot, 0);
    predictor.reconcile(snapshot, tick);
    const sample = buffer.sampleAt(createSnapshotSample(), tick);
    buildClientWorldView(view, sample, predictor, 1, roster, options);
    expect(view.dragonCount).toBe(1);
    const own = findDragonView(view, 1);
    // Full precision from the predictor, not the 6 cm grid of the snapshot's copy.
    expect(own?.position.x).toBeCloseTo(sim.getDragon(1)?.position.x ?? 0, 3);
    expect(own?.team).toBe(TEAM_FROST);
    expect(own?.classId).toBe('tempest');

    // A spectator's predictor is simply not passed, or not active: the snapshot copy is drawn.
    buildClientWorldView(view, sample, null, 1, roster, options);
    expect(view.dragonCount).toBe(1);
    const other = new ClientPredictor();
    other.configure(9, TEAM_EMBER, 'talon');
    buildClientWorldView(view, sample, other, 1, roster, { localDragonId: 9, stormWall: null });
    expect(view.dragonCount).toBe(1);
    expect(findDragonView(view, 1)).toBeDefined();
  });
});
