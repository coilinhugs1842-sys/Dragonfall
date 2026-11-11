import { describe, expect, it } from 'vitest';
import {
  BUTTON_BOOST,
  BUTTON_DODGE_LEFT,
  BUTTON_FLAP,
  BUTTON_MASK,
  DRAGON_ANIM_CLIPS,
  DRAGON_ANIM_GLIDE,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  INPUT_REDUNDANCY,
  MAX_PLAYERS,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  createInputFrame,
} from '../../src/shared';
import type { InputFrame } from '../../src/shared';
import { createSim } from '../../src/sim';
import type { Sim } from '../../src/sim';
import {
  Reader,
  Writer,
  applySnapshotOwner,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  expandTick,
  fillSnapshotDragons,
  inputByteLength,
  setSnapshotOwner,
  snapInputFrame,
  snapshotByteLength,
  wrapTick,
} from '../../src/net/codec';
import {
  DECODE_BAD_VALUE,
  DECODE_OK,
  DECODE_OVERSIZED,
  DECODE_TRUNCATED,
  DECODE_UNSUPPORTED,
  DECODE_WRONG_TYPE,
  FAST_MAX_BYTES,
  INPUT_FRAMES_PER_PACKET,
  INPUT_MAX_BYTES,
  MSG_INPUT,
  MSG_INVALID,
  MSG_SNAPSHOT,
  SNAPSHOT_DRAGON_BYTES,
  SNAPSHOT_FIXED_BYTES,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_PROJECTILES,
  SNAPSHOT_MAX_ZONES,
  SNAPSHOT_OWNER_BYTES,
  SNAPSHOT_OWNER_MASK_BYTES,
  SNAPSHOT_OWNER_MAX_WIRE_BYTES,
  SNAPSHOT_PROJECTILE_BYTES,
  SNAPSHOT_ZONE_BYTES,
  WIRE_POSITION_STEP_M,
  WIRE_VELOCITY_STEP_MPS,
  createInputMessage,
  createSnapshotMessage,
} from '../../src/net/protocol';

function viewOf(w: Writer, length: number): DataView {
  return new DataView(w.buffer, 0, length);
}

/** A sim with `count` dragons that has flown for a while under varied inputs. */
function flownSim(count: number, ticks: number): Sim {
  const sim = createSim();
  for (let id = 0; id < count; id++) {
    const team = id % 2 === 0 ? TEAM_EMBER : TEAM_FROST;
    const classId = DRAGON_CLASS_IDS[id % DRAGON_CLASS_IDS.length] ?? 'talon';
    sim.spawnDragon(
      id,
      team,
      classId,
      { x: id * 40 - 200, y: 300 + id * 5, z: -700 + id * 30 },
      id,
    );
  }
  const inputs: InputFrame[] = [];
  for (let id = 0; id < count; id++) inputs.push(createInputFrame());
  for (let tick = 0; tick < ticks; tick++) {
    for (let id = 0; id < count; id++) {
      const frame = inputs[id];
      if (frame === undefined) continue;
      frame.tick = tick;
      frame.steerX = Math.sin(tick * 0.05 + id);
      frame.steerY = Math.cos(tick * 0.03 + id) * 0.6;
      frame.buttons =
        (tick % 40 < 20 ? BUTTON_BOOST : 0) |
        (tick % 50 === id ? BUTTON_DODGE_LEFT : 0) |
        (tick % 30 === id ? BUTTON_FLAP : 0);
    }
    sim.step(tick, inputs);
  }
  return sim;
}

describe('INPUT', () => {
  it('has the documented sizes', () => {
    expect(INPUT_FRAMES_PER_PACKET).toBe(1 + INPUT_REDUNDANCY);
    expect(inputByteLength(1)).toBe(16);
    expect(inputByteLength(3)).toBe(36);
    expect(INPUT_MAX_BYTES).toBe(36);
  });

  it('round-trips the newest frame and its two repeats', () => {
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = createInputMessage();
    const fullTick = 65536 * 2 + 1; // just past a wrap: the repeats are on the other side
    msg.frameCount = 3;
    msg.hasAck = true;
    msg.ackSnapshotTick = wrapTick(fullTick - 4);
    msg.frames.forEach((frame, i) => {
      frame.tick = fullTick - i;
      frame.steerX = 0.25 * (i + 1);
      frame.steerY = -0.3 * (i + 1);
      frame.buttons = BUTTON_BOOST << i;
      frame.aimYaw = 0.7 * (i + 1) - 2;
      frame.aimPitch = 0.4 * (i - 1);
      snapInputFrame(frame);
    });

    const length = encodeInput(w, msg);
    expect(length).toBe(36);

    const out = createInputMessage();
    expect(decodeInput(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(r.error).toBe(DECODE_OK);
    expect(r.peekType()).toBe(MSG_INPUT);
    expect(out.tick).toBe(1);
    expect(out.frameCount).toBe(3);
    expect(out.hasAck).toBe(true);
    expect(expandTick(out.ackSnapshotTick, fullTick)).toBe(fullTick - 4);
    out.frames.forEach((frame, i) => {
      const sent = msg.frames[i];
      expect(expandTick(frame.tick, fullTick + 2)).toBe(fullTick - i);
      // Snapped on the client, so the host sees bit-identical values.
      expect(frame.steerX).toBe(sent?.steerX);
      expect(frame.steerY).toBe(sent?.steerY);
      expect(frame.buttons).toBe(sent?.buttons);
    });
  });

  it('sends fewer frames while there is no history, and no ack before the first snapshot', () => {
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = createInputMessage();
    msg.frameCount = 1;
    msg.ackSnapshotTick = 1234; // ignored: hasAck is false
    const first = msg.frames[0];
    if (first !== undefined) {
      first.tick = 7;
      first.steerX = 5; // out of range: clamped
      first.steerY = NaN;
      first.buttons = 0xffff;
    }
    const length = encodeInput(w, msg);
    expect(length).toBe(16);
    const out = createInputMessage();
    expect(decodeInput(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(out.frameCount).toBe(1);
    expect(out.hasAck).toBe(false);
    expect(out.ackSnapshotTick).toBe(0);
    expect(out.frames[0]).toEqual({
      tick: 7,
      steerX: 1,
      steerY: 0,
      buttons: BUTTON_MASK,
      aimYaw: 0,
      aimPitch: 0,
    });
  });

  it('rejects malformed packets with a typed error', () => {
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = createInputMessage();
    msg.frameCount = 2;
    const length = encodeInput(w, msg);
    const out = createInputMessage();

    expect(decodeInput(r.reset(viewOf(w, length - 1)), out)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    expect(decodeInput(r.reset(viewOf(w, length + 1)), out)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
    expect(decodeInput(r.reset(new DataView(new ArrayBuffer(0))), out)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    expect(r.peekType()).toBe(MSG_INVALID);
    expect(decodeInput(r.reset(new DataView(new ArrayBuffer(FAST_MAX_BYTES + 1))), out)).toBe(
      false,
    );
    expect(r.error).toBe(DECODE_OVERSIZED);

    w.view.setUint8(5, 0); // frame count 0
    expect(decodeInput(r.reset(viewOf(w, length)), out)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    w.view.setUint8(5, 2 | 0x10); // unknown meta bit
    expect(decodeInput(r.reset(viewOf(w, length)), out)).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    w.view.setUint8(5, 2);
    w.view.setUint8(0, MSG_SNAPSHOT);
    expect(decodeInput(r.reset(viewOf(w, length)), out)).toBe(false);
    expect(r.error).toBe(DECODE_WRONG_TYPE);
  });

  it('never lets a hostile steer or button value through', () => {
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const length = encodeInput(w, createInputMessage());
    w.view.setInt16(6, -32768, true);
    w.view.setInt16(8, 32767, true);
    w.view.setUint16(10, 0xffff, true);
    const out = createInputMessage();
    expect(decodeInput(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(out.frames[0]?.steerX).toBe(-1);
    expect(out.frames[0]?.steerY).toBe(1);
    expect(out.frames[0]?.buttons).toBe(BUTTON_MASK);
  });
});

describe('SNAPSHOT', () => {
  it('has the documented sizes and fits the 360 B budget for 10 dragons', () => {
    expect(SNAPSHOT_DRAGON_BYTES).toBe(19);
    expect(SNAPSHOT_OWNER_BYTES).toBe(140);
    expect(SNAPSHOT_FIXED_BYTES).toBe(19);
    expect(SNAPSHOT_PROJECTILE_BYTES).toBe(13);
    expect(SNAPSHOT_ZONE_BYTES).toBe(11);
    // 10 dragons and nothing else in the air: the budget of docs/NETWORKING.md.
    // The owner block is packed on the wire: an 18-byte mask and the non-zero bytes of its
    // 140-byte image, so 158 at the very worst.
    expect(SNAPSHOT_OWNER_MASK_BYTES).toBe(18);
    expect(SNAPSHOT_OWNER_MAX_WIRE_BYTES).toBe(158);
    expect(snapshotByteLength(10, 0)).toBe(209);
    // A busy fight: 6 slow projectiles and 8 zones.
    expect(snapshotByteLength(10, 100, 6, 8)).toBe(309 + 6 * 13 + 8 * 11);
    // The cap: every record slot used. One SCTP message either way.
    expect(SNAPSHOT_MAX_BYTES).toBe(367 + SNAPSHOT_MAX_PROJECTILES * 13 + SNAPSHOT_MAX_ZONES * 11);
    expect(FAST_MAX_BYTES).toBe(SNAPSHOT_MAX_BYTES);
  });

  it('encodes a full 5v5 sim state in about 290 bytes and round-trips it', () => {
    const sim = flownSim(MAX_PLAYERS, 90);
    const state = sim.current;
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();

    const msg = createSnapshotMessage();
    fillSnapshotDragons(msg, state);
    setSnapshotOwner(msg, sim.getDragon(3));
    msg.hasAck = true;
    msg.ackInputTick = wrapTick(88);
    msg.phase = 'playing';
    msg.round = 2;
    msg.phaseTimeS = 61.5;
    msg.timeRemainingS = 418.5;
    msg.scoreEmber = 12;
    msg.scoreFrost = 9;

    const length = encodeSnapshot(w, msg);
    // 209 without the owner; its packed block is about half of the 140-byte image in flight.
    expect(length).toBeGreaterThan(209 + SNAPSHOT_OWNER_MASK_BYTES);
    expect(length).toBeLessThan(305);
    expect(msg.dragonCount).toBe(MAX_PLAYERS);

    const out = createSnapshotMessage();
    expect(decodeSnapshot(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(r.peekType()).toBe(MSG_SNAPSHOT);
    expect(r.peekTick()).toBe(wrapTick(state.tick));
    expect(out.tick).toBe(wrapTick(state.tick));
    expect(out.hasAck).toBe(true);
    expect(out.ackInputTick).toBe(88);
    expect(out.phase).toBe('playing');
    expect(out.round).toBe(2);
    expect(out.phaseTimeS).toBeCloseTo(61.5, 5);
    expect(out.timeRemainingS).toBeCloseTo(418.5, 5);
    expect(out.scoreEmber).toBe(12);
    expect(out.scoreFrost).toBe(9);
    expect(out.dragonCount).toBe(MAX_PLAYERS);
    expect(out.projectileCount).toBe(0);
    expect(out.zoneCount).toBe(0);

    for (let i = 0; i < out.dragonCount; i++) {
      const got = out.dragons[i];
      const dragon = got === undefined ? undefined : sim.getDragon(got.id);
      if (got === undefined || dragon === undefined) throw new Error('missing dragon');
      const half = WIRE_POSITION_STEP_M / 2 + 1e-9;
      expect(Math.abs(got.position.x - dragon.position.x)).toBeLessThanOrEqual(half);
      expect(Math.abs(got.position.y - dragon.position.y)).toBeLessThanOrEqual(half);
      expect(Math.abs(got.position.z - dragon.position.z)).toBeLessThanOrEqual(half);
      const halfV = WIRE_VELOCITY_STEP_MPS / 2 + 1e-9;
      expect(Math.abs(got.velocity.x - dragon.velocity.x)).toBeLessThanOrEqual(halfV);
      expect(Math.abs(got.velocity.y - dragon.velocity.y)).toBeLessThanOrEqual(halfV);
      expect(Math.abs(got.velocity.z - dragon.velocity.z)).toBeLessThanOrEqual(halfV);
      const q = dragon.orientation;
      const dot = Math.abs(
        got.orientation.x * q.x +
          got.orientation.y * q.y +
          got.orientation.z * q.z +
          got.orientation.w * q.w,
      );
      expect((2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI).toBeLessThan(0.28);
      expect(Math.abs(got.health - dragon.health / dragon.maxHealth)).toBeLessThanOrEqual(1 / 255);
      expect(Math.abs(got.stamina - dragon.stamina)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      expect(got.flags).toBe(dragon.flags);
      expect(got.anim).toBe(dragon.anim);
    }

    // The owner block: floats at f32 precision, integers exact.
    const owner = sim.getDragon(3);
    if (owner === undefined) throw new Error('missing owner');
    expect(out.hasOwner).toBe(true);
    expect(out.owner.id).toBe(3);
    expect(out.owner.position.x).toBe(Math.fround(owner.position.x));
    expect(out.owner.position.y).toBe(Math.fround(owner.position.y));
    expect(out.owner.position.z).toBe(Math.fround(owner.position.z));
    expect(out.owner.yaw).toBe(Math.fround(owner.yaw));
    expect(out.owner.pitch).toBe(Math.fround(owner.pitch));
    expect(out.owner.roll).toBe(Math.fround(owner.roll));
    expect(out.owner.yawRate).toBe(Math.fround(owner.yawRate));
    expect(out.owner.pitchRate).toBe(Math.fround(owner.pitchRate));
    expect(out.owner.speed).toBe(Math.fround(owner.speed));
    expect(out.owner.burst.x).toBe(Math.fround(owner.burst.x));
    expect(out.owner.stamina).toBe(Math.fround(owner.stamina));
    expect(out.owner.health).toBe(Math.fround(owner.health));
    expect(out.owner.maxHealth).toBe(Math.fround(owner.maxHealth));
    expect(out.owner.flags).toBe(owner.flags);
    expect(out.owner.prevButtons).toBe(owner.prevButtons);
    expect(out.owner.boostLocked).toBe(owner.boostLocked);
    expect(out.owner.dodgeDir).toBe(owner.dodgeDir);
    expect(out.owner.dodgeTicks).toBe(owner.dodgeTicks);
    expect(out.owner.dodgeTotalTicks).toBe(owner.dodgeTotalTicks);
    expect(out.owner.dodgeImmunityTicks).toBe(owner.dodgeImmunityTicks);
    expect(out.owner.dodgeCooldownTicks).toBe(owner.dodgeCooldownTicks);
    expect(out.owner.flapCooldownTicks).toBe(owner.flapCooldownTicks);
    expect(out.owner.staminaRegenDelayTicks).toBe(owner.staminaRegenDelayTicks);
    expect(out.owner.spawnProtectTicks).toBe(owner.spawnProtectTicks);
    expect(out.owner.hitTicks).toBe(owner.hitTicks);
    expect(out.owner.terrainGraceTicks).toBe(owner.terrainGraceTicks);
  });

  it('round-trips every owner field, including the packed ones', () => {
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = createSnapshotMessage();
    msg.hasOwner = true;
    const o = msg.owner;
    o.id = 9;
    o.position.x = -812.5;
    o.position.y = 433.25;
    o.position.z = 77.125;
    o.yaw = -1.5;
    o.pitch = 0.25;
    o.roll = -0.75;
    o.yawRate = 0.5;
    o.pitchRate = -0.125;
    o.speed = 88.5;
    o.burst.x = 1.5;
    o.burst.y = -2.5;
    o.burst.z = 3.5;
    o.stamina = 0.625;
    o.health = 71.5;
    o.maxHealth = 120;
    o.flags = 0x1a5;
    o.prevButtons = BUTTON_MASK;
    o.boostLocked = true;
    o.dodgeTicks = 11;
    o.dodgeTotalTicks = 18;
    o.dodgeImmunityTicks = 5;
    o.dodgeCooldownTicks = 300;
    o.flapCooldownTicks = 7;
    o.staminaRegenDelayTicks = 31;
    o.spawnProtectTicks = 60;
    o.hitTicks = 3;
    o.terrainGraceTicks = 15;
    for (const dodgeDir of [-1, 0, 1]) {
      o.dodgeDir = dodgeDir;
      const length = encodeSnapshot(w, msg);
      expect(length).toBeLessThanOrEqual(snapshotByteLength(0, SNAPSHOT_OWNER_MAX_WIRE_BYTES));
      const out = createSnapshotMessage();
      expect(decodeSnapshot(r.reset(viewOf(w, length)), out)).toBe(true);
      // Every value above is exactly representable as an f32.
      expect(out.owner).toEqual(o);
    }
  });

  it('carries spectators (no owner), an empty world and an untimed clock', () => {
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = createSnapshotMessage();
    msg.tick = 65535;
    msg.phase = 'results';
    const length = encodeSnapshot(w, msg);
    expect(length).toBe(SNAPSHOT_FIXED_BYTES);
    const out = createSnapshotMessage();
    out.hasOwner = true;
    out.hasAck = true;
    out.dragonCount = 4;
    expect(decodeSnapshot(r.reset(viewOf(w, length)), out)).toBe(true);
    expect(out.tick).toBe(65535);
    expect(out.hasOwner).toBe(false);
    expect(out.hasAck).toBe(false);
    expect(out.dragonCount).toBe(0);
    expect(out.phase).toBe('results');
    expect(out.timeRemainingS).toBe(Infinity);
  });

  it('skips inactive sim slots and keeps a dead dragon distinguishable from a hurt one', () => {
    const sim = flownSim(4, 10);
    sim.despawnDragon(1);
    const hurt = sim.getDragon(2);
    const dead = sim.getDragon(3);
    if (hurt === undefined || dead === undefined) throw new Error('missing dragon');
    hurt.health = 0.01;
    dead.health = 0;
    dead.flags &= ~DRAGON_FLAG_ALIVE;

    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = fillSnapshotDragons(createSnapshotMessage(), sim.current);
    expect(msg.dragonCount).toBe(3);
    const length = encodeSnapshot(w, msg);
    const out = createSnapshotMessage();
    expect(decodeSnapshot(r.reset(viewOf(w, length)), out)).toBe(true);
    const ids = out.dragons.slice(0, out.dragonCount).map((dragon) => dragon.id);
    expect(ids).toEqual([0, 2, 3]);
    expect(out.dragons[1]?.health).toBeGreaterThan(0);
    expect(out.dragons[2]?.health).toBe(0);
  });

  it('rejects malformed snapshots with a typed error', () => {
    const sim = flownSim(3, 5);
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = fillSnapshotDragons(createSnapshotMessage(), sim.current);
    setSnapshotOwner(msg, sim.getDragon(0));
    const length = encodeSnapshot(w, msg);
    const out = createSnapshotMessage();
    const bytes = new Uint8Array(w.buffer);
    const pristine = bytes.slice(0, length);
    const restore = (): void => bytes.set(pristine);
    const decode = (size = length): boolean => decodeSnapshot(r.reset(viewOf(w, size)), out);

    expect(decode()).toBe(true);
    expect(decode(length - 1)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    expect(decode(length + 1)).toBe(false);
    expect(r.error).toBe(DECODE_OVERSIZED);
    expect(decode(2)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);

    bytes[16] = 200; // dragon count far beyond the buffer and the pool
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    restore();

    bytes[16] = 4; // one more dragon than the bytes hold
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    restore();

    bytes[17] = 1; // a projectile record the bytes do not hold
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    restore();

    bytes[17] = SNAPSHOT_MAX_PROJECTILES + 1;
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    restore();

    bytes[18] = SNAPSHOT_MAX_ZONES + 1;
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    restore();

    bytes[6] = 99; // phase
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    restore();

    // The owner block is packed, so a bad value is put in through the encoder.
    const reencode = (change: () => void): void => {
      const kept = structuredClone(msg.owner);
      change();
      const size = encodeSnapshot(w, msg);
      expect(decode(size)).toBe(false);
      expect(r.error).toBe(DECODE_BAD_VALUE);
      Object.assign(msg.owner, kept);
      restore();
    };
    reencode(() => (msg.owner.position.x = NaN));
    reencode(() => (msg.owner.speed = Infinity));

    // The owner mask: bits past the end of the image, and a bit that changes the length.
    const lastMask = SNAPSHOT_FIXED_BYTES + SNAPSHOT_OWNER_MASK_BYTES - 1;
    bytes[lastMask] = (bytes[lastMask] ?? 0) | 0x80;
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    restore();
    bytes[SNAPSHOT_FIXED_BYTES + 2] = (bytes[SNAPSHOT_FIXED_BYTES + 2] ?? 0) ^ 0x01;
    expect(decode()).toBe(false);
    expect([DECODE_TRUNCATED, DECODE_OVERSIZED]).toContain(r.error);
    restore();
    expect(decode(SNAPSHOT_FIXED_BYTES + 4)).toBe(false);
    expect(r.error).toBe(DECODE_TRUNCATED);
    expect(decode()).toBe(true);

    const firstDragon = length - 3 * SNAPSHOT_DRAGON_BYTES;
    bytes[firstDragon] = NO_PLAYER; // not a player id
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    restore();

    bytes[firstDragon + SNAPSHOT_DRAGON_BYTES] = bytes[firstDragon] ?? 0; // duplicate id
    expect(decode()).toBe(false);
    expect(r.error).toBe(DECODE_BAD_VALUE);
    restore();

    bytes[firstDragon + SNAPSHOT_DRAGON_BYTES - 1] = 250; // unknown animation: tolerated
    expect(decode()).toBe(true);
    expect(out.dragons[0]?.anim).toBe(DRAGON_ANIM_GLIDE);
    expect(DRAGON_ANIM_CLIPS.length).toBeLessThan(250);
  });

  it('reports a buffer that is too small instead of throwing', () => {
    const sim = flownSim(MAX_PLAYERS, 3);
    const msg = fillSnapshotDragons(createSnapshotMessage(), sim.current);
    const small = new Writer(100);
    expect(encodeSnapshot(small, msg)).toBe(0);
    expect(small.overflow).toBe(true);
    // The writer recovers on the next message.
    msg.dragonCount = 1;
    expect(encodeSnapshot(small, msg)).toBe(snapshotByteLength(1, 0));
  });
});

describe('reconciliation from the owner block', () => {
  it('lets a client replay inputs and land where the host does', () => {
    const host = flownSim(2, 75);
    const hostDragon = host.getDragon(1);
    if (hostDragon === undefined) throw new Error('missing dragon');

    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = fillSnapshotDragons(createSnapshotMessage(), host.current);
    setSnapshotOwner(msg, hostDragon);
    const length = encodeSnapshot(w, msg);
    const snapshot = createSnapshotMessage();
    expect(decodeSnapshot(r.reset(viewOf(w, length)), snapshot)).toBe(true);

    // The client only knows the lobby data (team, class) and whatever its prediction had.
    const client = createSim();
    const predicted = client.spawnDragon(
      1,
      hostDragon.team,
      hostDragon.classId,
      { x: 0, y: 300, z: 0 },
      0,
    );
    if (predicted === null) throw new Error('spawn failed');
    applySnapshotOwner(predicted, snapshot.owner);

    const frame = createInputFrame();
    const inputs: (InputFrame | undefined)[] = [undefined, frame];
    for (let tick = 75; tick < 75 + 45; tick++) {
      frame.tick = tick;
      frame.steerX = Math.sin(tick * 0.11);
      frame.steerY = Math.cos(tick * 0.07) * 0.5;
      frame.buttons = tick % 20 < 8 ? BUTTON_BOOST : tick % 20 === 12 ? BUTTON_DODGE_LEFT : 0;
      snapInputFrame(frame);
      host.step(tick, inputs);
      client.step(tick, inputs);
    }

    // 1.5 s of replay from an f32-rounded state: still within a couple of millimetres.
    expect(Math.abs(predicted.position.x - hostDragon.position.x)).toBeLessThan(0.005);
    expect(Math.abs(predicted.position.y - hostDragon.position.y)).toBeLessThan(0.005);
    expect(Math.abs(predicted.position.z - hostDragon.position.z)).toBeLessThan(0.005);
    expect(Math.abs(predicted.speed - hostDragon.speed)).toBeLessThan(1e-3);
    expect(Math.abs(predicted.stamina - hostDragon.stamina)).toBeLessThan(1e-5);
    expect(predicted.dodgeCooldownTicks).toBe(hostDragon.dodgeCooldownTicks);
    expect(predicted.flags).toBe(hostDragon.flags);
    expect(predicted.anim).toBe(hostDragon.anim);
  });
});

describe('hot path allocations', () => {
  it('encodes and decodes inputs and snapshots without creating garbage', () => {
    const sim = flownSim(MAX_PLAYERS, 30);
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const snapshot = fillSnapshotDragons(createSnapshotMessage(), sim.current);
    setSnapshotOwner(snapshot, sim.getDragon(4));
    const snapshotOut = createSnapshotMessage();
    const input = createInputMessage();
    input.frameCount = 3;
    input.hasAck = true;
    input.frames.forEach((frame, i) => {
      frame.steerX = 0.37 - i * 0.21;
      frame.steerY = -0.83 + i * 0.4;
    });
    const inputOut = createInputMessage();
    // One view over the whole buffer per size, made up front: the loop itself must not allocate.
    // Nothing but the ack changes per cycle, so the packed owner block keeps its length.
    const snapshotView = viewOf(w, encodeSnapshot(w, snapshot));
    const inputView = viewOf(w, inputByteLength(3));

    let ok = 0;
    const cycle = (i: number): void => {
      fillSnapshotDragons(snapshot, sim.current);
      snapshot.ackInputTick = i & 0xffff;
      const snapshotLength = encodeSnapshot(w, snapshot);
      w.packet(snapshotLength);
      if (decodeSnapshot(r.reset(snapshotView), snapshotOut)) ok++;

      // Only integers change per cycle: float arithmetic in this test closure would itself
      // allocate whenever the closure runs unoptimised, and that is not what is being measured.
      const newest = input.frames[0];
      if (newest !== undefined) {
        newest.tick = i;
        newest.buttons = i & BUTTON_MASK;
      }
      const inputLength = encodeInput(w, input);
      w.packet(inputLength);
      if (decodeInput(r.reset(inputView), inputOut)) ok++;
    };

    // Warm up so the JIT has settled and every lazily made object exists.
    for (let i = 0; i < 100_000; i++) cycle(i);
    expect(ok).toBe(200_000);

    // A cycle that allocated even one small object (16 B) would add 32 KB per trial; a clean
    // one adds nothing but the few hundred bytes `memoryUsage()` itself costs. Other activity in
    // the process (a GC, the JIT) can disturb single trials, so the median counts.
    const iterations = 2_000;
    const growth: number[] = [];
    for (let trial = 0; trial < 9; trial++) {
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < iterations; i++) cycle(i);
      growth.push(process.memoryUsage().heapUsed - before);
    }
    growth.sort((a, b) => a - b);
    expect(growth[4]).toBeLessThan(8 * 1024);
  });
});
