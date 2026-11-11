/**
 * `fast` channel messages: INPUT (client -> host, 30 Hz) and SNAPSHOT (host -> client, 20 Hz).
 * Encode and decode are allocation-free: they only touch the caller's Writer/Reader and message
 * structs.
 *
 * INPUT layout (6 + 10 per frame = 16..36 bytes):
 *   0  header             u8 type, u16 tick      tick of the newest frame
 *   3  u16 ackSnapshotTick                       newest snapshot the client had (lag compensation)
 *   5  u8  meta                                  bits 0-1 frame count (1..3), bit 7 hasAck
 *   6  per frame, newest first (frame i is for tick - i):
 *        i16 steerX, i16 steerY, u16 buttons, i16 aimYaw, i16 aimPitch
 *
 * SNAPSHOT layout (19 + the packed owner block + 19 per dragon + 13 per projectile + 11 per
 * zone; about 290 bytes for 10 dragons with owner and nothing else in the air):
 *   0  header             u8 type, u16 tick      tick of the sim state
 *   3  u16 ackInputTick                          lastProcessedInputTick of the recipient
 *   5  u8  flags                                 bit 0 hasAck, bit 1 hasOwner
 *   6  clock              u8 phase, u8 round, u16 phaseTicks, u16 remainingTicks,
 *                         u8 scoreEmber, u8 scoreFrost
 *   14 u16 stormRadius                           0.1 m steps; 0xffff = the map's own
 *   16 u8  dragonCount, u8 projectileCount, u8 zoneCount
 *   19 owner block (if hasOwner): the 140-byte image of `writeOwner`, packed by `packOwner`
 *      (18-byte mask + its non-zero bytes; typically 70 to 90 bytes)
 *      dragon records, 19 bytes each: see `writeDragon`
 *      projectile records, 13 bytes each: u16 id, u8 kind | team << 4, u8 ownerId, 3 x i16
 *        position, 3 x i8 velocity. Only the slow kinds (`replication: 'snapshot'`): a fast bolt
 *        is its `abilityCast` event and every client flies its own copy (`ClientBolts`).
 *      zone records, 11 bytes each: u8 id, u8 kind | team << 4, u8 ownerId, 3 x i16 position,
 *        u8 radius (0.5 m), u8 remaining (0.1 s). A zone that stands still is only in some
 *        snapshots (SNAPSHOT_ZONE_REFRESH in `../protocol`); the client carries it in between.
 *
 * WHY THE BODIES ARE WRITTEN WITH RAW DataView CALLS: a float passed to, or returned from, a
 * function the JIT did not inline is boxed on the heap. Going through `Writer.f32()` and the
 * `quantize*` helpers cost about 200 B of garbage per snapshot once the functions grew past the
 * inlining budget. So the size is checked once, and then the records are read and written with
 * DataView methods and `Math.*` only (both compile to machine code without a call), and helpers
 * take objects instead of numbers. The formulas are the ones in `./quantize`. Every quantized
 * value ends in `| 0`: it turns NaN into 0, and it turns the -0 that `Math.round(-0.1)` yields
 * into a plain integer (a -0 is a float to the engine and was boxed, 16 B per packet).
 * tests/net/codec-fast.test.ts ("hot path allocations") measures all of this.
 */

import {
  BUTTON_MASK,
  DRAGON_ANIM_CLIPS,
  DRAGON_ANIM_GLIDE,
  MATCH_PHASES,
  NO_PLAYER,
  PROJECTILE_DEFS,
  PROJECTILE_KINDS,
  TICK_DT_S,
  TICK_HZ,
  ZONE_DEFS,
  ZONE_KINDS,
} from '../../shared';
import type { ProjectileDef, ProjectileKind, ZoneDef, ZoneKind } from '../../shared';
import type { DragonState, SimState } from '../../sim';
import {
  DECODE_BAD_VALUE,
  DECODE_OVERSIZED,
  DECODE_TRUNCATED,
  FAST_MAX_BYTES,
  INPUT_FIXED_BYTES,
  INPUT_FRAMES_PER_PACKET,
  INPUT_FRAME_BYTES,
  MSG_INPUT,
  MSG_SNAPSHOT,
  SNAPSHOT_DRAGON_BYTES,
  SNAPSHOT_FIXED_BYTES,
  SNAPSHOT_MAX_DRAGONS,
  SNAPSHOT_MAX_PROJECTILES,
  SNAPSHOT_MAX_ZONES,
  SNAPSHOT_OWNER_BYTES,
  SNAPSHOT_OWNER_FLIGHT_BYTES,
  SNAPSHOT_OWNER_MASK_BYTES,
  SNAPSHOT_OWNER_MAX_WIRE_BYTES,
  SNAPSHOT_PROJECTILE_BYTES,
  SNAPSHOT_ZONE_BYTES,
  SNAPSHOT_ZONE_FRESH_TICKS,
  WIRE_AIM_UNITS,
  WIRE_POSITION_CENTER_Y_M,
  WIRE_POSITION_STEP_M,
  WIRE_STORM_RADIUS_DEFAULT,
  WIRE_STORM_RADIUS_STEP_M,
  WIRE_TIME_INFINITE,
  WIRE_VELOCITY_STEP_MPS,
  WIRE_ZONE_RADIUS_STEP_M,
  WIRE_ZONE_TIME_STEP_S,
  staticZoneDue,
} from '../protocol';
import type {
  InputMessage,
  SnapshotDragon,
  SnapshotMessage,
  SnapshotOwner,
  SnapshotProjectile,
  SnapshotZone,
} from '../protocol';
import type { Reader, Writer } from './io';
import {
  POSITION_UNITS_PER_M,
  STEER_UNITS,
  VELOCITY_UNITS_PER_MPS,
  readQuat,
  writeQuat,
} from './quantize';

const INPUT_FLAG_HAS_ACK = 0x80;
const INPUT_COUNT_MASK = 0x03;
const SNAPSHOT_FLAG_HAS_ACK = 1 << 0;
const SNAPSHOT_FLAG_HAS_OWNER = 1 << 1;
const OWNER_BIT_BOOST_LOCKED = 1 << 0;
const AIM_YAW_UNITS = WIRE_AIM_UNITS / Math.PI;
const AIM_PITCH_UNITS = WIRE_AIM_UNITS / (Math.PI / 2);
const KIND_MASK = 0x0f;
const TEAM_SHIFT = 4;

/** Integer in [0, max]; NaN and negatives become 0. For counts, not for floats in the hot path. */
function clampCount(value: number, max: number): number {
  // `!(> 0)` also catches NaN.
  if (!(value > 0)) return 0;
  return value >= max ? max : value | 0;
}

// --- INPUT ---------------------------------------------------------------------------------------

export function inputByteLength(frameCount: number): number {
  return INPUT_FIXED_BYTES + frameCount * INPUT_FRAME_BYTES;
}

/**
 * Writes an INPUT message and returns its byte length (0 if it did not fit). The header tick is
 * `msg.frames[0].tick`; `msg.tick` is ignored (decode fills it). `frames[i]` must be the input
 * for tick `frames[0].tick - i`; send fewer frames (`frameCount`) until that history exists.
 * Steer is clamped and quantized, unknown button bits are dropped.
 */
export function encodeInput(w: Writer, msg: Readonly<InputMessage>): number {
  w.reset();
  const count = msg.frameCount < 1 ? 1 : clampCount(msg.frameCount, INPUT_FRAMES_PER_PACKET);
  const length = INPUT_FIXED_BYTES + count * INPUT_FRAME_BYTES;
  const newest = msg.frames[0];
  if (length > w.capacity || newest === undefined) {
    w.overflow = true;
    return 0;
  }
  const view = w.view;
  view.setUint8(0, MSG_INPUT);
  view.setUint16(1, newest.tick & 0xffff, true);
  view.setUint16(3, msg.hasAck ? msg.ackSnapshotTick & 0xffff : 0, true);
  view.setUint8(5, count | (msg.hasAck ? INPUT_FLAG_HAS_ACK : 0));
  let at = INPUT_FIXED_BYTES;
  for (let i = 0; i < count; i++) {
    const frame = msg.frames[i];
    if (frame === undefined) {
      w.overflow = true;
      return 0;
    }
    // quantizeSteer, inline.
    view.setInt16(
      at,
      Math.max(-32767, Math.min(32767, Math.round(frame.steerX * STEER_UNITS))) | 0,
      true,
    );
    view.setInt16(
      at + 2,
      Math.max(-32767, Math.min(32767, Math.round(frame.steerY * STEER_UNITS))) | 0,
      true,
    );
    view.setUint16(at + 4, frame.buttons & BUTTON_MASK, true);
    // quantizeAimYaw / quantizeAimPitch, inline.
    view.setInt16(
      at + 6,
      Math.max(-32767, Math.min(32767, Math.round(frame.aimYaw * AIM_YAW_UNITS))) | 0,
      true,
    );
    view.setInt16(
      at + 8,
      Math.max(-32767, Math.min(32767, Math.round(frame.aimPitch * AIM_PITCH_UNITS))) | 0,
      true,
    );
    at += INPUT_FRAME_BYTES;
  }
  w.offset = length;
  return length;
}

/**
 * Reads an INPUT message from untrusted bytes. On success `into.frames[0..frameCount)` hold
 * legal values (steer in [-1, 1], known buttons only) and each frame's `tick` is its 16-bit
 * wire tick; expand it with `expandTick(frame.tick, hostTick)`. On failure `into` may be
 * partly overwritten and `r.error` says why.
 */
export function decodeInput(r: Reader, into: InputMessage): boolean {
  const tick = r.header(MSG_INPUT, FAST_MAX_BYTES);
  const ack = r.u16();
  const meta = r.u8();
  if (!r.ok) return false;
  const count = meta & INPUT_COUNT_MASK;
  if (
    count < 1 ||
    count > INPUT_FRAMES_PER_PACKET ||
    (meta & ~(INPUT_COUNT_MASK | INPUT_FLAG_HAS_ACK)) !== 0
  ) {
    return r.fail(DECODE_BAD_VALUE);
  }
  const length = INPUT_FIXED_BYTES + count * INPUT_FRAME_BYTES;
  if (r.byteLength !== length) {
    return r.fail(r.byteLength < length ? DECODE_TRUNCATED : DECODE_OVERSIZED);
  }
  into.tick = tick;
  into.frameCount = count;
  into.hasAck = (meta & INPUT_FLAG_HAS_ACK) !== 0;
  into.ackSnapshotTick = into.hasAck ? ack : 0;
  const view = r.view;
  let at = INPUT_FIXED_BYTES;
  for (let i = 0; i < count; i++) {
    const frame = into.frames[i];
    if (frame === undefined) return r.fail(DECODE_BAD_VALUE);
    frame.tick = (tick - i) & 0xffff;
    // dequantizeSteer, inline: -32768 clamps to -1.
    frame.steerX = Math.max(-1, view.getInt16(at, true) / STEER_UNITS);
    frame.steerY = Math.max(-1, view.getInt16(at + 2, true) / STEER_UNITS);
    frame.buttons = view.getUint16(at + 4, true) & BUTTON_MASK;
    // -32768 clamps to the lower end, like steer.
    frame.aimYaw = Math.max(-Math.PI, view.getInt16(at + 6, true) / AIM_YAW_UNITS);
    frame.aimPitch = Math.max(-Math.PI / 2, view.getInt16(at + 8, true) / AIM_PITCH_UNITS);
    at += INPUT_FRAME_BYTES;
  }
  r.offset = length;
  return true;
}

// --- SNAPSHOT ------------------------------------------------------------------------------------

/**
 * Bytes of a snapshot with these record counts. `ownerBytes` is the size of the owner block on
 * the wire: 0 without one, what `packOwner` wrote (it depends on the state), or
 * SNAPSHOT_OWNER_MAX_WIRE_BYTES for an upper bound.
 */
export function snapshotByteLength(
  dragonCount: number,
  ownerBytes: number,
  projectileCount = 0,
  zoneCount = 0,
): number {
  return (
    SNAPSHOT_FIXED_BYTES +
    ownerBytes +
    dragonCount * SNAPSHOT_DRAGON_BYTES +
    projectileCount * SNAPSHOT_PROJECTILE_BYTES +
    zoneCount * SNAPSHOT_ZONE_BYTES
  );
}

function writeProjectile(
  view: DataView,
  at: number,
  projectile: Readonly<SnapshotProjectile>,
): void {
  const position = projectile.position;
  const velocity = projectile.velocity;
  view.setUint16(at, projectile.id & 0xffff, true);
  view.setUint8(at + 2, (projectile.kind & KIND_MASK) | (projectile.team << TEAM_SHIFT));
  view.setUint8(at + 3, projectile.ownerId);
  view.setInt16(
    at + 4,
    Math.max(-32767, Math.min(32767, Math.round(position.x * POSITION_UNITS_PER_M))) | 0,
    true,
  );
  view.setInt16(
    at + 6,
    Math.max(
      -32767,
      Math.min(32767, Math.round((position.y - WIRE_POSITION_CENTER_Y_M) * POSITION_UNITS_PER_M)),
    ) | 0,
    true,
  );
  view.setInt16(
    at + 8,
    Math.max(-32767, Math.min(32767, Math.round(position.z * POSITION_UNITS_PER_M))) | 0,
    true,
  );
  view.setInt8(
    at + 10,
    Math.max(-127, Math.min(127, Math.round(velocity.x * VELOCITY_UNITS_PER_MPS))) | 0,
  );
  view.setInt8(
    at + 11,
    Math.max(-127, Math.min(127, Math.round(velocity.y * VELOCITY_UNITS_PER_MPS))) | 0,
  );
  view.setInt8(
    at + 12,
    Math.max(-127, Math.min(127, Math.round(velocity.z * VELOCITY_UNITS_PER_MPS))) | 0,
  );
}

/** False for a kind or team this build does not know. */
function readProjectile(view: DataView, at: number, into: SnapshotProjectile): boolean {
  const packed = view.getUint8(at + 2);
  const kind = packed & KIND_MASK;
  const team = packed >> TEAM_SHIFT;
  if (kind >= PROJECTILE_KINDS.length || team > 1) return false;
  into.id = view.getUint16(at, true);
  into.kind = kind;
  into.team = team === 0 ? 0 : 1;
  into.ownerId = view.getUint8(at + 3);
  into.position.x = view.getInt16(at + 4, true) * WIRE_POSITION_STEP_M;
  into.position.y = view.getInt16(at + 6, true) * WIRE_POSITION_STEP_M + WIRE_POSITION_CENTER_Y_M;
  into.position.z = view.getInt16(at + 8, true) * WIRE_POSITION_STEP_M;
  into.velocity.x = view.getInt8(at + 10) * WIRE_VELOCITY_STEP_MPS;
  into.velocity.y = view.getInt8(at + 11) * WIRE_VELOCITY_STEP_MPS;
  into.velocity.z = view.getInt8(at + 12) * WIRE_VELOCITY_STEP_MPS;
  return true;
}

function writeZone(view: DataView, at: number, zone: Readonly<SnapshotZone>): void {
  const position = zone.position;
  view.setUint8(at, zone.id & 0xff);
  view.setUint8(at + 1, (zone.kind & KIND_MASK) | (zone.team << TEAM_SHIFT));
  view.setUint8(at + 2, zone.ownerId);
  view.setInt16(
    at + 3,
    Math.max(-32767, Math.min(32767, Math.round(position.x * POSITION_UNITS_PER_M))) | 0,
    true,
  );
  view.setInt16(
    at + 5,
    Math.max(
      -32767,
      Math.min(32767, Math.round((position.y - WIRE_POSITION_CENTER_Y_M) * POSITION_UNITS_PER_M)),
    ) | 0,
    true,
  );
  view.setInt16(
    at + 7,
    Math.max(-32767, Math.min(32767, Math.round(position.z * POSITION_UNITS_PER_M))) | 0,
    true,
  );
  view.setUint8(
    at + 9,
    Math.max(0, Math.min(255, Math.round(zone.radius / WIRE_ZONE_RADIUS_STEP_M))) | 0,
  );
  // 255 = beyond the range (or NaN/Infinity, which `| 0` would turn into 0).
  const remaining = zone.remainingS / WIRE_ZONE_TIME_STEP_S;
  view.setUint8(at + 10, remaining < 254.5 ? Math.max(0, Math.round(remaining)) | 0 : 255);
}

function readZone(view: DataView, at: number, into: SnapshotZone): boolean {
  const packed = view.getUint8(at + 1);
  const kind = packed & KIND_MASK;
  const team = packed >> TEAM_SHIFT;
  if (kind >= ZONE_KINDS.length || team > 1) return false;
  into.id = view.getUint8(at);
  into.kind = kind;
  into.team = team === 0 ? 0 : 1;
  into.ownerId = view.getUint8(at + 2);
  into.position.x = view.getInt16(at + 3, true) * WIRE_POSITION_STEP_M;
  into.position.y = view.getInt16(at + 5, true) * WIRE_POSITION_STEP_M + WIRE_POSITION_CENTER_Y_M;
  into.position.z = view.getInt16(at + 7, true) * WIRE_POSITION_STEP_M;
  into.radius = view.getUint8(at + 9) * WIRE_ZONE_RADIUS_STEP_M;
  const remaining = view.getUint8(at + 10);
  into.remainingS = remaining === 255 ? Infinity : remaining * WIRE_ZONE_TIME_STEP_S;
  return true;
}

/**
 * 19 bytes: u8 id, i16 x, i16 y, i16 z, u32 orientation, i8 vx, i8 vy, i8 vz, u8 health
 * (rounded up), u8 stamina, u16 flags, u8 anim. Out-of-range values clamp; NaN writes 0.
 */
function writeDragon(view: DataView, at: number, dragon: Readonly<SnapshotDragon>): void {
  const position = dragon.position;
  const velocity = dragon.velocity;
  view.setUint8(at, dragon.id);
  view.setInt16(
    at + 1,
    Math.max(-32767, Math.min(32767, Math.round(position.x * POSITION_UNITS_PER_M))) | 0,
    true,
  );
  view.setInt16(
    at + 3,
    Math.max(
      -32767,
      Math.min(32767, Math.round((position.y - WIRE_POSITION_CENTER_Y_M) * POSITION_UNITS_PER_M)),
    ) | 0,
    true,
  );
  view.setInt16(
    at + 5,
    Math.max(-32767, Math.min(32767, Math.round(position.z * POSITION_UNITS_PER_M))) | 0,
    true,
  );
  writeQuat(view, at + 7, dragon.orientation);
  view.setInt8(
    at + 11,
    Math.max(-127, Math.min(127, Math.round(velocity.x * VELOCITY_UNITS_PER_MPS))) | 0,
  );
  view.setInt8(
    at + 12,
    Math.max(-127, Math.min(127, Math.round(velocity.y * VELOCITY_UNITS_PER_MPS))) | 0,
  );
  view.setInt8(
    at + 13,
    Math.max(-127, Math.min(127, Math.round(velocity.z * VELOCITY_UNITS_PER_MPS))) | 0,
  );
  view.setUint8(at + 14, Math.max(0, Math.min(255, Math.ceil(dragon.health * 255))) | 0);
  view.setUint8(at + 15, Math.max(0, Math.min(255, Math.round(dragon.stamina * 255))) | 0);
  view.setUint16(at + 16, dragon.flags & 0xffff, true);
  view.setUint8(at + 18, dragon.anim);
}

function readDragon(view: DataView, at: number, into: SnapshotDragon): void {
  into.id = view.getUint8(at);
  into.position.x = view.getInt16(at + 1, true) * WIRE_POSITION_STEP_M;
  into.position.y = view.getInt16(at + 3, true) * WIRE_POSITION_STEP_M + WIRE_POSITION_CENTER_Y_M;
  into.position.z = view.getInt16(at + 5, true) * WIRE_POSITION_STEP_M;
  readQuat(view, at + 7, into.orientation);
  into.velocity.x = view.getInt8(at + 11) * WIRE_VELOCITY_STEP_MPS;
  into.velocity.y = view.getInt8(at + 12) * WIRE_VELOCITY_STEP_MPS;
  into.velocity.z = view.getInt8(at + 13) * WIRE_VELOCITY_STEP_MPS;
  into.health = view.getUint8(at + 14) / 255;
  into.stamina = view.getUint8(at + 15) / 255;
  into.flags = view.getUint16(at + 16, true);
  const anim = view.getUint8(at + 18);
  // An animation this build does not know is not worth losing the snapshot over.
  into.anim = anim < DRAGON_ANIM_CLIPS.length ? anim : DRAGON_ANIM_GLIDE;
}

/**
 * 140 bytes. Flight, 84: u8 id, f32 x 15 (position xyz, yaw, pitch, roll, yawRate, pitchRate,
 * speed, burst xyz, stamina, health, maxHealth), u16 flags, u16 prevButtons, u8 bits (bit 0
 * boostLocked, bits 1-2 dodgeDir + 1), then 9 x u16 timers in DragonState order. Combat, 56:
 * f32 ultCharge, f32 slowScale, f32 hasteScale, 4 x u16 cooldowns, 4 x u16 active timers,
 * 4 x u8 charges used, u8 castSlot + 1, u16 castTicks, 10 x u16 (firing, slow, haste, burn,
 * regen, blind, veil, phase, shield, dead), u8 lastDamagerId.
 */
function writeOwner(view: DataView, at: number, owner: Readonly<SnapshotOwner>): void {
  view.setUint8(at, owner.id);
  view.setFloat32(at + 1, owner.position.x, true);
  view.setFloat32(at + 5, owner.position.y, true);
  view.setFloat32(at + 9, owner.position.z, true);
  view.setFloat32(at + 13, owner.yaw, true);
  view.setFloat32(at + 17, owner.pitch, true);
  view.setFloat32(at + 21, owner.roll, true);
  view.setFloat32(at + 25, owner.yawRate, true);
  view.setFloat32(at + 29, owner.pitchRate, true);
  view.setFloat32(at + 33, owner.speed, true);
  view.setFloat32(at + 37, owner.burst.x, true);
  view.setFloat32(at + 41, owner.burst.y, true);
  view.setFloat32(at + 45, owner.burst.z, true);
  view.setFloat32(at + 49, owner.stamina, true);
  view.setFloat32(at + 53, owner.health, true);
  view.setFloat32(at + 57, owner.maxHealth, true);
  view.setUint16(at + 61, owner.flags & 0xffff, true);
  view.setUint16(at + 63, owner.prevButtons & BUTTON_MASK, true);
  const dodgeDir = owner.dodgeDir < 0 ? 0 : owner.dodgeDir > 0 ? 2 : 1;
  view.setUint8(at + 65, (owner.boostLocked ? OWNER_BIT_BOOST_LOCKED : 0) | (dodgeDir << 1));
  // Timers are small whole numbers; the clamp only guards against a corrupted state.
  view.setUint16(at + 66, Math.max(0, Math.min(0xffff, owner.dodgeTicks)) | 0, true);
  view.setUint16(at + 68, Math.max(0, Math.min(0xffff, owner.dodgeTotalTicks)) | 0, true);
  view.setUint16(at + 70, Math.max(0, Math.min(0xffff, owner.dodgeImmunityTicks)) | 0, true);
  view.setUint16(at + 72, Math.max(0, Math.min(0xffff, owner.dodgeCooldownTicks)) | 0, true);
  view.setUint16(at + 74, Math.max(0, Math.min(0xffff, owner.flapCooldownTicks)) | 0, true);
  view.setUint16(at + 76, Math.max(0, Math.min(0xffff, owner.staminaRegenDelayTicks)) | 0, true);
  view.setUint16(at + 78, Math.max(0, Math.min(0xffff, owner.spawnProtectTicks)) | 0, true);
  view.setUint16(at + 80, Math.max(0, Math.min(0xffff, owner.hitTicks)) | 0, true);
  view.setUint16(at + 82, Math.max(0, Math.min(0xffff, owner.terrainGraceTicks)) | 0, true);

  let o = at + SNAPSHOT_OWNER_FLIGHT_BYTES;
  view.setFloat32(o, owner.ultCharge, true);
  view.setFloat32(o + 4, owner.slowScale, true);
  view.setFloat32(o + 8, owner.hasteScale, true);
  o += 12;
  for (let i = 0; i < 4; i++) {
    view.setUint16(
      o + i * 2,
      Math.max(0, Math.min(0xffff, owner.abilityCooldownTicks[i] ?? 0)) | 0,
      true,
    );
    view.setUint16(
      o + 8 + i * 2,
      Math.max(0, Math.min(0xffff, owner.abilityActiveTicks[i] ?? 0)) | 0,
      true,
    );
    view.setUint8(o + 16 + i, Math.max(0, Math.min(255, owner.abilityChargesUsed[i] ?? 0)) | 0);
  }
  o += 20;
  view.setUint8(o, owner.castSlot >= 0 && owner.castSlot < 4 ? owner.castSlot + 1 : 0);
  view.setUint16(o + 1, Math.max(0, Math.min(0xffff, owner.castTicks)) | 0, true);
  o += 3;
  view.setUint16(o, Math.max(0, Math.min(0xffff, owner.firingTicks)) | 0, true);
  view.setUint16(o + 2, Math.max(0, Math.min(0xffff, owner.slowTicks)) | 0, true);
  view.setUint16(o + 4, Math.max(0, Math.min(0xffff, owner.hasteTicks)) | 0, true);
  view.setUint16(o + 6, Math.max(0, Math.min(0xffff, owner.burnTicks)) | 0, true);
  view.setUint16(o + 8, Math.max(0, Math.min(0xffff, owner.regenTicks)) | 0, true);
  view.setUint16(o + 10, Math.max(0, Math.min(0xffff, owner.blindTicks)) | 0, true);
  view.setUint16(o + 12, Math.max(0, Math.min(0xffff, owner.veilTicks)) | 0, true);
  view.setUint16(o + 14, Math.max(0, Math.min(0xffff, owner.phaseTicks)) | 0, true);
  view.setUint16(o + 16, Math.max(0, Math.min(0xffff, owner.shieldTicks)) | 0, true);
  view.setUint16(o + 18, Math.max(0, Math.min(0xffff, owner.deadTicks)) | 0, true);
  view.setUint8(o + 20, owner.lastDamagerId & 0xff);
}

/** Returns false if any float is NaN or infinite, or a packed field is out of range. */
function readOwner(view: DataView, at: number, into: SnapshotOwner): boolean {
  const px = view.getFloat32(at + 1, true);
  const py = view.getFloat32(at + 5, true);
  const pz = view.getFloat32(at + 9, true);
  const yaw = view.getFloat32(at + 13, true);
  const pitch = view.getFloat32(at + 17, true);
  const roll = view.getFloat32(at + 21, true);
  const yawRate = view.getFloat32(at + 25, true);
  const pitchRate = view.getFloat32(at + 29, true);
  const speed = view.getFloat32(at + 33, true);
  const bx = view.getFloat32(at + 37, true);
  const by = view.getFloat32(at + 41, true);
  const bz = view.getFloat32(at + 45, true);
  const stamina = view.getFloat32(at + 49, true);
  const health = view.getFloat32(at + 53, true);
  const maxHealth = view.getFloat32(at + 57, true);
  const combat = at + SNAPSHOT_OWNER_FLIGHT_BYTES;
  const ultCharge = view.getFloat32(combat, true);
  const slowScale = view.getFloat32(combat + 4, true);
  const hasteScale = view.getFloat32(combat + 8, true);
  const castSlot = view.getUint8(combat + 32);
  // `v - v` is 0 for a finite v and NaN for NaN and both infinities, so the sum is 0 only if
  // every value is finite.
  const finite =
    px -
    px +
    (py - py) +
    (pz - pz) +
    (yaw - yaw) +
    (pitch - pitch) +
    (roll - roll) +
    (yawRate - yawRate) +
    (pitchRate - pitchRate) +
    (speed - speed) +
    (bx - bx) +
    (by - by) +
    (bz - bz) +
    (stamina - stamina) +
    (health - health) +
    (maxHealth - maxHealth) +
    (ultCharge - ultCharge) +
    (slowScale - slowScale) +
    (hasteScale - hasteScale);
  const id = view.getUint8(at);
  const bits = view.getUint8(at + 65);
  const dodgeDir = (bits >> 1) & 3;
  if (finite !== 0 || dodgeDir > 2 || (bits & ~0x07) !== 0 || id === NO_PLAYER) return false;
  if (castSlot > 4) return false;

  into.id = id;
  into.position.x = px;
  into.position.y = py;
  into.position.z = pz;
  into.yaw = yaw;
  into.pitch = pitch;
  into.roll = roll;
  into.yawRate = yawRate;
  into.pitchRate = pitchRate;
  into.speed = speed;
  into.burst.x = bx;
  into.burst.y = by;
  into.burst.z = bz;
  into.stamina = stamina;
  into.health = health;
  into.maxHealth = maxHealth;
  into.flags = view.getUint16(at + 61, true);
  into.prevButtons = view.getUint16(at + 63, true) & BUTTON_MASK;
  into.boostLocked = (bits & OWNER_BIT_BOOST_LOCKED) !== 0;
  into.dodgeDir = dodgeDir - 1;
  into.dodgeTicks = view.getUint16(at + 66, true);
  into.dodgeTotalTicks = view.getUint16(at + 68, true);
  into.dodgeImmunityTicks = view.getUint16(at + 70, true);
  into.dodgeCooldownTicks = view.getUint16(at + 72, true);
  into.flapCooldownTicks = view.getUint16(at + 74, true);
  into.staminaRegenDelayTicks = view.getUint16(at + 76, true);
  into.spawnProtectTicks = view.getUint16(at + 78, true);
  into.hitTicks = view.getUint16(at + 80, true);
  into.terrainGraceTicks = view.getUint16(at + 82, true);

  into.ultCharge = ultCharge;
  into.slowScale = slowScale;
  into.hasteScale = hasteScale;
  let o = combat + 12;
  for (let i = 0; i < 4; i++) {
    into.abilityCooldownTicks[i] = view.getUint16(o + i * 2, true);
    into.abilityActiveTicks[i] = view.getUint16(o + 8 + i * 2, true);
    into.abilityChargesUsed[i] = view.getUint8(o + 16 + i);
  }
  o += 20;
  into.castSlot = castSlot - 1;
  into.castTicks = view.getUint16(o + 1, true);
  o += 3;
  into.firingTicks = view.getUint16(o, true);
  into.slowTicks = view.getUint16(o + 2, true);
  into.hasteTicks = view.getUint16(o + 4, true);
  into.burnTicks = view.getUint16(o + 6, true);
  into.regenTicks = view.getUint16(o + 8, true);
  into.blindTicks = view.getUint16(o + 10, true);
  into.veilTicks = view.getUint16(o + 12, true);
  into.phaseTicks = view.getUint16(o + 14, true);
  into.shieldTicks = view.getUint16(o + 16, true);
  into.deadTicks = view.getUint16(o + 18, true);
  into.lastDamagerId = view.getUint8(o + 20);
  return true;
}

// The 140-byte owner image is built here and then packed into (or unpacked from) the message.
const ownerImage = new Uint8Array(SNAPSHOT_OWNER_BYTES);
const ownerImageView = new DataView(ownerImage.buffer);

/**
 * Writes the owner block packed (see SNAPSHOT_OWNER_MASK_BYTES): the mask, then every byte of
 * the image that is not zero. Returns the bytes written. Integers only, so nothing is boxed.
 */
function packOwner(view: DataView, at: number, owner: Readonly<SnapshotOwner>): number {
  writeOwner(ownerImageView, 0, owner);
  let out = at + SNAPSHOT_OWNER_MASK_BYTES;
  for (let m = 0; m < SNAPSHOT_OWNER_MASK_BYTES; m++) {
    const base = m * 8;
    let bits = 0;
    for (let b = 0; b < 8 && base + b < SNAPSHOT_OWNER_BYTES; b++) {
      const byte = ownerImage[base + b] ?? 0;
      if (byte === 0) continue;
      bits |= 1 << b;
      view.setUint8(out++, byte);
    }
    view.setUint8(at + m, bits);
  }
  return out - at;
}

/**
 * Bytes of the packed owner block whose mask starts at `at`, or -1 if the mask names bytes past
 * the end of the image. The caller has checked that the mask itself is inside the message.
 */
function packedOwnerBytes(view: DataView, at: number): number {
  let count = SNAPSHOT_OWNER_MASK_BYTES;
  for (let m = 0; m < SNAPSHOT_OWNER_MASK_BYTES; m++) {
    let bits = view.getUint8(at + m);
    if (m === SNAPSHOT_OWNER_MASK_BYTES - 1) {
      const used = SNAPSHOT_OWNER_BYTES - m * 8;
      if (used < 8 && bits >> used !== 0) return -1;
    }
    while (bits !== 0) {
      bits &= bits - 1;
      count++;
    }
  }
  return count;
}

/** Unpacks the owner block at `at` (its length already checked) and validates it. */
function unpackOwner(view: DataView, at: number, into: SnapshotOwner): boolean {
  let from = at + SNAPSHOT_OWNER_MASK_BYTES;
  for (let m = 0; m < SNAPSHOT_OWNER_MASK_BYTES; m++) {
    const base = m * 8;
    const bits = view.getUint8(at + m);
    for (let b = 0; b < 8 && base + b < SNAPSHOT_OWNER_BYTES; b++) {
      ownerImage[base + b] = (bits & (1 << b)) !== 0 ? view.getUint8(from++) : 0;
    }
  }
  return readOwner(ownerImageView, 0, into);
}

/**
 * Writes a SNAPSHOT for one recipient and returns its byte length (0 if it did not fit).
 *
 * The recipient's own dragon travels twice: quantized in `dragons` like everyone else's (what
 * the views of other players get), and in the OWNER block with every primary flight field at
 * `f32` precision plus the exact integer timers. Reconciliation overwrites the predicted dragon
 * with the owner block (`applySnapshotOwner`) and replays its inputs for the ticks after the
 * snapshot's (from snapshot tick + 1, not from the ack: see `ClientPredictor`). Sending the
 * full state was chosen over "quantize identically on both sides": the host would otherwise have
 * to simulate from quantized state too, or every replay would start from a state the host never
 * had. `f32` (not `f64`) keeps the block small; the rounding it adds is about 1e-7
 * relative (0.1 mm at the map edge) and is replaced by the next snapshot, so compare predicted
 * and authoritative state with a tolerance, never with `===`.
 */
export function encodeSnapshot(w: Writer, msg: Readonly<SnapshotMessage>): number {
  w.reset();
  const dragonCount = clampCount(msg.dragonCount, SNAPSHOT_MAX_DRAGONS);
  const projectileCount = clampCount(msg.projectileCount, SNAPSHOT_MAX_PROJECTILES);
  const zoneCount = clampCount(msg.zoneCount, SNAPSHOT_MAX_ZONES);
  const hasOwner = msg.hasOwner;
  // The packed owner block is as long as its state makes it: check against its worst case.
  const bound = snapshotByteLength(
    dragonCount,
    hasOwner ? SNAPSHOT_OWNER_MAX_WIRE_BYTES : 0,
    projectileCount,
    zoneCount,
  );
  if (bound > w.capacity) {
    w.overflow = true;
    return 0;
  }
  const view = w.view;
  view.setUint8(0, MSG_SNAPSHOT);
  view.setUint16(1, msg.tick & 0xffff, true);
  view.setUint16(3, msg.hasAck ? msg.ackInputTick & 0xffff : 0, true);
  view.setUint8(
    5,
    (msg.hasAck ? SNAPSHOT_FLAG_HAS_ACK : 0) | (hasOwner ? SNAPSHOT_FLAG_HAS_OWNER : 0),
  );

  const phase = MATCH_PHASES.indexOf(msg.phase);
  view.setUint8(6, phase < 0 ? 0 : phase);
  view.setUint8(7, Math.max(0, Math.min(255, msg.round)) | 0);
  // quantizeClockS, inline.
  view.setUint16(
    8,
    Math.max(0, Math.min(WIRE_TIME_INFINITE - 1, Math.round(msg.phaseTimeS * TICK_HZ))) | 0,
    true,
  );
  view.setUint16(
    10,
    msg.timeRemainingS === Infinity
      ? WIRE_TIME_INFINITE
      : Math.max(0, Math.min(WIRE_TIME_INFINITE - 1, Math.round(msg.timeRemainingS * TICK_HZ))) | 0,
    true,
  );
  view.setUint8(12, Math.max(0, Math.min(255, msg.scoreEmber)) | 0);
  view.setUint8(13, Math.max(0, Math.min(255, msg.scoreFrost)) | 0);
  // `>= 0` is false for NaN too: both mean "the map's own radius".
  view.setUint16(
    14,
    msg.stormRadius >= 0
      ? Math.min(
          WIRE_STORM_RADIUS_DEFAULT - 1,
          Math.round(msg.stormRadius / WIRE_STORM_RADIUS_STEP_M),
        ) | 0
      : WIRE_STORM_RADIUS_DEFAULT,
    true,
  );
  view.setUint8(16, dragonCount);
  view.setUint8(17, projectileCount);
  view.setUint8(18, zoneCount);

  let at = SNAPSHOT_FIXED_BYTES;
  if (hasOwner) at += packOwner(view, at, msg.owner);
  for (let i = 0; i < dragonCount; i++) {
    const dragon = msg.dragons[i];
    if (dragon === undefined) {
      w.overflow = true;
      return 0;
    }
    writeDragon(view, at, dragon);
    at += SNAPSHOT_DRAGON_BYTES;
  }
  for (let i = 0; i < projectileCount; i++) {
    const projectile = msg.projectiles[i];
    if (projectile === undefined) {
      w.overflow = true;
      return 0;
    }
    writeProjectile(view, at, projectile);
    at += SNAPSHOT_PROJECTILE_BYTES;
  }
  for (let i = 0; i < zoneCount; i++) {
    const zone = msg.zones[i];
    if (zone === undefined) {
      w.overflow = true;
      return 0;
    }
    writeZone(view, at, zone);
    at += SNAPSHOT_ZONE_BYTES;
  }
  w.offset = at;
  return at;
}

/**
 * Reads a SNAPSHOT. On success every number in `into` is finite, ids are valid player ids with
 * no duplicates, orientations are unit quaternions and `dragonCount <= SNAPSHOT_MAX_DRAGONS`.
 * On failure `into` may be partly overwritten (do not use it) and `r.error` says why.
 */
export function decodeSnapshot(r: Reader, into: SnapshotMessage): boolean {
  const tick = r.header(MSG_SNAPSHOT, FAST_MAX_BYTES);
  const ack = r.u16();
  const flags = r.u8();
  const phase = r.u8();
  const round = r.u8();
  const phaseTicks = r.u16();
  const remainingTicks = r.u16();
  const scoreEmber = r.u8();
  const scoreFrost = r.u8();
  const stormRadius = r.u16();
  const dragonCount = r.u8();
  const projectileCount = r.u8();
  const zoneCount = r.u8();
  if (!r.ok) return false;

  const phaseId = MATCH_PHASES[phase];
  if (
    phaseId === undefined ||
    dragonCount > SNAPSHOT_MAX_DRAGONS ||
    projectileCount > SNAPSHOT_MAX_PROJECTILES ||
    zoneCount > SNAPSHOT_MAX_ZONES ||
    (flags & ~(SNAPSHOT_FLAG_HAS_ACK | SNAPSHOT_FLAG_HAS_OWNER)) !== 0
  ) {
    return r.fail(DECODE_BAD_VALUE);
  }
  const hasOwner = (flags & SNAPSHOT_FLAG_HAS_OWNER) !== 0;
  // The counts fix the exact length, so a lying count is caught here and everything below can
  // read the view directly without further bounds checks.
  let ownerBytes = 0;
  if (hasOwner) {
    if (r.byteLength < SNAPSHOT_FIXED_BYTES + SNAPSHOT_OWNER_MASK_BYTES) {
      return r.fail(DECODE_TRUNCATED);
    }
    ownerBytes = packedOwnerBytes(r.view, SNAPSHOT_FIXED_BYTES);
    if (ownerBytes < 0) return r.fail(DECODE_BAD_VALUE);
  }
  const length = snapshotByteLength(dragonCount, ownerBytes, projectileCount, zoneCount);
  if (r.byteLength !== length) {
    return r.fail(r.byteLength < length ? DECODE_TRUNCATED : DECODE_OVERSIZED);
  }

  into.tick = tick;
  into.hasAck = (flags & SNAPSHOT_FLAG_HAS_ACK) !== 0;
  into.ackInputTick = into.hasAck ? ack : 0;
  into.phase = phaseId;
  into.round = round;
  // dequantizeClockS, inline.
  into.phaseTimeS = phaseTicks * TICK_DT_S;
  into.timeRemainingS =
    remainingTicks === WIRE_TIME_INFINITE ? Infinity : remainingTicks * TICK_DT_S;
  into.scoreEmber = scoreEmber;
  into.scoreFrost = scoreFrost;
  into.stormRadius =
    stormRadius === WIRE_STORM_RADIUS_DEFAULT ? -1 : stormRadius * WIRE_STORM_RADIUS_STEP_M;
  into.hasOwner = hasOwner;
  into.dragonCount = dragonCount;
  into.projectileCount = projectileCount;
  into.zoneCount = zoneCount;

  const view = r.view;
  let at = SNAPSHOT_FIXED_BYTES;
  if (hasOwner) {
    if (!unpackOwner(view, at, into.owner)) return r.fail(DECODE_BAD_VALUE);
    at += ownerBytes;
  }
  for (let i = 0; i < dragonCount; i++) {
    const dragon = into.dragons[i];
    if (dragon === undefined) return r.fail(DECODE_BAD_VALUE);
    readDragon(view, at, dragon);
    at += SNAPSHOT_DRAGON_BYTES;
    if (dragon.id === NO_PLAYER) return r.fail(DECODE_BAD_VALUE);
    for (let j = 0; j < i; j++) {
      if (into.dragons[j]?.id === dragon.id) return r.fail(DECODE_BAD_VALUE);
    }
  }
  for (let i = 0; i < projectileCount; i++) {
    const projectile = into.projectiles[i];
    if (projectile === undefined || !readProjectile(view, at, projectile)) {
      return r.fail(DECODE_BAD_VALUE);
    }
    at += SNAPSHOT_PROJECTILE_BYTES;
  }
  for (let i = 0; i < zoneCount; i++) {
    const zone = into.zones[i];
    if (zone === undefined || !readZone(view, at, zone)) return r.fail(DECODE_BAD_VALUE);
    at += SNAPSHOT_ZONE_BYTES;
  }
  r.offset = length;
  return true;
}

// --- Sim <-> snapshot helpers ----------------------------------------------------------------------

/** Field-by-field copy; `from` may be the sim's `DragonState`. */
export function copySnapshotOwner(
  out: SnapshotOwner,
  from: Readonly<SnapshotOwner>,
): SnapshotOwner {
  out.id = from.id;
  out.position.x = from.position.x;
  out.position.y = from.position.y;
  out.position.z = from.position.z;
  out.yaw = from.yaw;
  out.pitch = from.pitch;
  out.roll = from.roll;
  out.yawRate = from.yawRate;
  out.pitchRate = from.pitchRate;
  out.speed = from.speed;
  out.burst.x = from.burst.x;
  out.burst.y = from.burst.y;
  out.burst.z = from.burst.z;
  out.stamina = from.stamina;
  out.health = from.health;
  out.maxHealth = from.maxHealth;
  out.flags = from.flags;
  out.prevButtons = from.prevButtons;
  out.boostLocked = from.boostLocked;
  out.dodgeDir = from.dodgeDir;
  out.dodgeTicks = from.dodgeTicks;
  out.dodgeTotalTicks = from.dodgeTotalTicks;
  out.dodgeImmunityTicks = from.dodgeImmunityTicks;
  out.dodgeCooldownTicks = from.dodgeCooldownTicks;
  out.flapCooldownTicks = from.flapCooldownTicks;
  out.staminaRegenDelayTicks = from.staminaRegenDelayTicks;
  out.spawnProtectTicks = from.spawnProtectTicks;
  out.hitTicks = from.hitTicks;
  out.terrainGraceTicks = from.terrainGraceTicks;
  out.ultCharge = from.ultCharge;
  out.slowScale = from.slowScale;
  out.hasteScale = from.hasteScale;
  for (let i = 0; i < 4; i++) {
    out.abilityCooldownTicks[i] = from.abilityCooldownTicks[i] ?? 0;
    out.abilityActiveTicks[i] = from.abilityActiveTicks[i] ?? 0;
    out.abilityChargesUsed[i] = from.abilityChargesUsed[i] ?? 0;
  }
  out.castSlot = from.castSlot;
  out.castTicks = from.castTicks;
  out.firingTicks = from.firingTicks;
  out.slowTicks = from.slowTicks;
  out.hasteTicks = from.hasteTicks;
  out.burnTicks = from.burnTicks;
  out.regenTicks = from.regenTicks;
  out.blindTicks = from.blindTicks;
  out.veilTicks = from.veilTicks;
  out.phaseTicks = from.phaseTicks;
  out.shieldTicks = from.shieldTicks;
  out.deadTicks = from.deadTicks;
  out.lastDamagerId = from.lastDamagerId;
  return out;
}

/**
 * Client reconciliation, step 1: overwrites the predicted dragon's primary fields with the
 * host's. `active`, `team` and `classId` are left alone (lobby data), and so are the derived
 * fields (`orientation`, `velocity`, `anim`): the next `finalizeDragon` rewrites them, so call
 * it yourself if no input is replayed afterwards. The block is the state AFTER the snapshot's
 * tick whatever input the host used for it, so replay the inputs of snapshot tick + 1 onwards
 * (replaying from `ackInputTick` would apply an input twice).
 */
export function applySnapshotOwner(
  dragon: DragonState,
  owner: Readonly<SnapshotOwner>,
): DragonState {
  copySnapshotOwner(dragon, owner);
  return dragon;
}

/**
 * Host side: fills `msg.tick`, `msg.dragons` and `msg.dragonCount` from a sim state (every
 * active dragon, in slot order). The per-recipient fields (ack, owner) and the clock are the
 * caller's to set before each `encodeSnapshot`.
 */
export function fillSnapshotDragons(
  msg: SnapshotMessage,
  state: Readonly<SimState>,
): SnapshotMessage {
  let count = 0;
  for (let i = 0; i < state.dragons.length && count < SNAPSHOT_MAX_DRAGONS; i++) {
    const dragon = state.dragons[i];
    const out = msg.dragons[count];
    if (dragon === undefined || !dragon.active || out === undefined) continue;
    out.id = dragon.id;
    out.position.x = dragon.position.x;
    out.position.y = dragon.position.y;
    out.position.z = dragon.position.z;
    out.orientation.x = dragon.orientation.x;
    out.orientation.y = dragon.orientation.y;
    out.orientation.z = dragon.orientation.z;
    out.orientation.w = dragon.orientation.w;
    out.velocity.x = dragon.velocity.x;
    out.velocity.y = dragon.velocity.y;
    out.velocity.z = dragon.velocity.z;
    out.health = dragon.maxHealth > 0 ? dragon.health / dragon.maxHealth : 0;
    out.stamina = dragon.stamina;
    out.flags = dragon.flags;
    out.anim = dragon.anim;
    count++;
  }
  msg.tick = state.tick & 0xffff;
  msg.dragonCount = count;
  return msg;
}

/**
 * Host side: fills the storm radius and the projectile and zone records from a sim state. Only
 * projectiles whose kind is replicated by snapshot are listed (see `ProjectileDef.replication`);
 * beyond the record limits the rest is left out (clients then miss a zone's picture, not its
 * effect: the host decides every hit).
 */
export function fillSnapshotEffects(
  msg: SnapshotMessage,
  state: Readonly<SimState>,
  projectileDefs: Readonly<Record<ProjectileKind, ProjectileDef>> = PROJECTILE_DEFS,
  zoneDefs: Readonly<Record<ZoneKind, ZoneDef>> = ZONE_DEFS,
): SnapshotMessage {
  msg.stormRadius = state.stormRadius;

  let count = 0;
  if (state.projectileCount > 0) {
    for (let i = 0; i < state.projectiles.length && count < SNAPSHOT_MAX_PROJECTILES; i++) {
      const projectile = state.projectiles[i];
      const out = msg.projectiles[count];
      if (projectile === undefined || !projectile.active || out === undefined) continue;
      const kind = PROJECTILE_KINDS[projectile.kind];
      if (kind === undefined || projectileDefs[kind].replication !== 'snapshot') continue;
      out.id = projectile.id;
      out.kind = projectile.kind;
      out.ownerId = projectile.ownerId;
      out.team = projectile.team;
      out.position.x = projectile.position.x;
      out.position.y = projectile.position.y;
      out.position.z = projectile.position.z;
      out.velocity.x = projectile.velocity.x;
      out.velocity.y = projectile.velocity.y;
      out.velocity.z = projectile.velocity.z;
      count++;
    }
  }
  msg.projectileCount = count;

  count = 0;
  if (state.zoneCount > 0) {
    for (let i = 0; i < state.zones.length && count < SNAPSHOT_MAX_ZONES; i++) {
      const zone = state.zones[i];
      const out = msg.zones[count];
      if (zone === undefined || !zone.active || out === undefined) continue;
      // A zone that stands still is listed while it is new and then only now and again.
      const kind = ZONE_KINDS[zone.kind];
      if (
        kind !== undefined &&
        !zoneDefs[kind].follow &&
        zone.ageTicks >= SNAPSHOT_ZONE_FRESH_TICKS &&
        !staticZoneDue(state.tick, zone.id)
      ) {
        continue;
      }
      out.id = zone.id;
      out.kind = zone.kind;
      out.ownerId = zone.ownerId;
      out.team = zone.team;
      out.position.x = zone.position.x;
      out.position.y = zone.position.y;
      out.position.z = zone.position.z;
      out.radius = zone.radius;
      out.remainingS = zone.ticksLeft * TICK_DT_S;
      count++;
    }
  }
  msg.zoneCount = count;
  return msg;
}

/** Host side: sets or clears the owner block for the next recipient. */
export function setSnapshotOwner(
  msg: SnapshotMessage,
  dragon: Readonly<SnapshotOwner> | null | undefined,
): SnapshotMessage {
  msg.hasOwner = dragon !== null && dragon !== undefined;
  if (dragon !== null && dragon !== undefined) copySnapshotOwner(msg.owner, dragon);
  return msg;
}
