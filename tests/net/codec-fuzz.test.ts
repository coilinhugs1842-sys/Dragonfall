/**
 * The host parses bytes from untrusted clients, so every decoder must survive anything: random
 * buffers, valid messages cut short, valid messages with flipped bytes. "Survive" means it never
 * throws, never reads out of bounds (a DataView would throw a RangeError), and whatever it
 * accepts holds only legal values.
 */

import { describe, expect, it } from 'vitest';
import {
  BUTTON_AIM,
  BUTTON_MASK,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_ULTIMATE,
  BUTTON_UTILITY,
  DRAGON_ANIM_CLIPS,
  DRAGON_CLASS_IDS,
  MATCH_PHASES,
  PROJECTILE_KINDS,
  STATUS_KINDS,
  ZONE_KINDS,
  MAX_PLAYERS,
  MAX_PLAYER_NAME_LENGTH,
  NO_PLAYER,
  PROTOCOL_VERSION,
  TEAM_EMBER,
  TEAM_FROST,
  createInputFrame,
} from '../../src/shared';
import type { GameEvent } from '../../src/shared';
import { createSeededRandom } from '../../src/shared/maps/seeded-random';
import { createSim } from '../../src/sim';
import { createLobby, joinLobby } from '../../src/sim/lobby';
import {
  Reader,
  Writer,
  beginGameEvents,
  decodeGameEvents,
  decodeHello,
  decodeHostLeft,
  decodeInput,
  decodeIntent,
  decodeKick,
  decodeLobbyState,
  decodeMatchPhase,
  decodeMatchStart,
  decodePing,
  decodePong,
  decodeReject,
  decodeSnapshot,
  decodeWelcome,
  encodeHello,
  encodeInput,
  encodeIntent,
  encodeLobbyState,
  encodeMatchPhase,
  encodeMatchStart,
  encodePing,
  encodePong,
  encodeReject,
  encodeSnapshot,
  encodeWelcome,
  endGameEvents,
  fillSnapshotDragons,
  fillSnapshotEffects,
  isReconnectToken,
  setSnapshotOwner,
  writeGameEvent,
} from '../../src/net/codec';
import {
  CTRL_MAX_BYTES,
  DECODE_OK,
  INPUT_FRAMES_PER_PACKET,
  MSG_GAME_EVENTS,
  MSG_HELLO,
  MSG_HOST_LEFT,
  MSG_INPUT,
  MSG_INTENT,
  MSG_KICK,
  MSG_LOBBY_STATE,
  MSG_MATCH_PHASE,
  MSG_MATCH_START,
  MSG_PING,
  MSG_PONG,
  MSG_REJECT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  NET_INTENT_TYPES,
  REJECT_REASONS,
  SNAPSHOT_MAX_DRAGONS,
  SNAPSHOT_MAX_PROJECTILES,
  SNAPSHOT_MAX_ZONES,
  createHelloMessage,
  createInputMessage,
  createIntentMessage,
  createLobbyStateMessage,
  createMatchPhaseMessage,
  createMatchStartMessage,
  createNoticeMessage,
  createPingMessage,
  createPongMessage,
  createRejectMessage,
  createSnapshotMessage,
  createWelcomeMessage,
} from '../../src/net/protocol';

const reader = new Reader();
const input = createInputMessage();
const snapshot = createSnapshotMessage();
const hello = createHelloMessage();
const welcome = createWelcomeMessage();
const reject = createRejectMessage();
const lobbyState = createLobbyStateMessage();
const intent = createIntentMessage();
const ping = createPingMessage();
const pong = createPongMessage();
const matchStart = createMatchStartMessage();
const matchPhase = createMatchPhaseMessage();
const notice = createNoticeMessage();

function finite(...values: number[]): void {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(`non-finite value ${value}`);
  }
}

function playerId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= NO_PLAYER) {
    throw new Error(`bad player id ${value}`);
  }
}

function wireTick(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`bad tick ${value}`);
}

function checkEvent(event: GameEvent): void {
  if (!Number.isInteger(event.tick) || event.tick < 0) throw new Error('bad event tick');
  switch (event.type) {
    case 'hit':
      playerId(event.targetId);
      finite(event.damage, event.position.x, event.position.y, event.position.z);
      if (event.damage < 0) throw new Error('negative damage');
      break;
    case 'takedown':
      playerId(event.victimId);
      finite(event.position.x, event.position.y, event.position.z);
      break;
    case 'spawn':
      playerId(event.dragonId);
      if (event.team !== TEAM_EMBER && event.team !== TEAM_FROST) throw new Error('bad team');
      if (!DRAGON_CLASS_IDS.includes(event.classId)) throw new Error('bad class');
      break;
    case 'abilityCast': {
      playerId(event.dragonId);
      const length = Math.hypot(event.direction.x, event.direction.y, event.direction.z);
      if (Math.abs(length - 1) > 1e-6) throw new Error('direction is not a unit vector');
      break;
    }
    case 'objective':
      if (event.team !== TEAM_EMBER && event.team !== TEAM_FROST) throw new Error('bad team');
      break;
    case 'matchPhase':
      if (!MATCH_PHASES.includes(event.phase)) throw new Error('bad phase');
      break;
    case 'assist':
      playerId(event.assisterId);
      playerId(event.victimId);
      break;
    case 'statusApplied':
      playerId(event.targetId);
      if (!STATUS_KINDS.includes(event.status)) throw new Error('bad status');
      finite(event.durationS, event.position.x, event.position.y, event.position.z);
      if (event.durationS < 0) throw new Error('negative duration');
      break;
    case 'impact':
      if (!PROJECTILE_KINDS.includes(event.projectile)) throw new Error('bad projectile');
      finite(event.position.x, event.position.y, event.position.z);
      break;
  }
}

const eventSink = { emit: checkEvent };

/**
 * Runs every decoder on the buffer. Returns how many accepted it. Throws (failing the test) if a
 * decoder throws or accepts a message with an illegal value in it.
 */
function decodeAll(view: DataView): number {
  let accepted = 0;
  reader.reset(view);

  if (decodeInput(reader, input)) {
    accepted++;
    wireTick(input.tick);
    wireTick(input.ackSnapshotTick);
    if (input.frameCount < 1 || input.frameCount > INPUT_FRAMES_PER_PACKET) {
      throw new Error(`bad frame count ${input.frameCount}`);
    }
    for (let i = 0; i < input.frameCount; i++) {
      const frame = input.frames[i];
      if (frame === undefined) throw new Error('missing frame');
      wireTick(frame.tick);
      if (!(frame.steerX >= -1 && frame.steerX <= 1)) throw new Error(`steerX ${frame.steerX}`);
      if (!(frame.steerY >= -1 && frame.steerY <= 1)) throw new Error(`steerY ${frame.steerY}`);
      if ((frame.buttons & ~BUTTON_MASK) !== 0) throw new Error('unknown button bits');
      if (!(frame.aimYaw >= -Math.PI && frame.aimYaw <= Math.PI)) throw new Error('bad aimYaw');
      if (!(Math.abs(frame.aimPitch) <= Math.PI / 2)) throw new Error('bad aimPitch');
    }
  } else if (reader.error === DECODE_OK) throw new Error('failed without an error code');

  if (decodeSnapshot(reader, snapshot)) {
    accepted++;
    wireTick(snapshot.tick);
    wireTick(snapshot.ackInputTick);
    if (!MATCH_PHASES.includes(snapshot.phase)) throw new Error('bad phase');
    finite(snapshot.phaseTimeS, snapshot.round, snapshot.scoreEmber, snapshot.scoreFrost);
    if (Number.isNaN(snapshot.timeRemainingS) || snapshot.timeRemainingS < 0) {
      throw new Error('bad time remaining');
    }
    if (snapshot.dragonCount > SNAPSHOT_MAX_DRAGONS) throw new Error('too many dragons');
    if (Number.isNaN(snapshot.stormRadius)) throw new Error('bad storm radius');
    if (snapshot.projectileCount > SNAPSHOT_MAX_PROJECTILES)
      throw new Error('too many projectiles');
    if (snapshot.zoneCount > SNAPSHOT_MAX_ZONES) throw new Error('too many zones');
    for (let i = 0; i < snapshot.projectileCount; i++) {
      const projectile = snapshot.projectiles[i];
      if (projectile === undefined) throw new Error('missing projectile');
      if (projectile.kind < 0 || projectile.kind >= PROJECTILE_KINDS.length)
        throw new Error('kind');
      if (projectile.team !== TEAM_EMBER && projectile.team !== TEAM_FROST) throw new Error('team');
      finite(projectile.position.x, projectile.position.y, projectile.position.z);
      finite(projectile.velocity.x, projectile.velocity.y, projectile.velocity.z);
    }
    for (let i = 0; i < snapshot.zoneCount; i++) {
      const zone = snapshot.zones[i];
      if (zone === undefined) throw new Error('missing zone');
      if (zone.kind < 0 || zone.kind >= ZONE_KINDS.length) throw new Error('bad zone kind');
      if (zone.team !== TEAM_EMBER && zone.team !== TEAM_FROST) throw new Error('bad zone team');
      finite(zone.position.x, zone.position.y, zone.position.z, zone.radius);
      if (Number.isNaN(zone.remainingS) || zone.remainingS < 0) throw new Error('bad zone time');
    }
    const seen = new Set<number>();
    for (let i = 0; i < snapshot.dragonCount; i++) {
      const dragon = snapshot.dragons[i];
      if (dragon === undefined) throw new Error('missing dragon');
      playerId(dragon.id);
      if (seen.has(dragon.id)) throw new Error('duplicate dragon id');
      seen.add(dragon.id);
      const q = dragon.orientation;
      finite(dragon.position.x, dragon.position.y, dragon.position.z);
      finite(dragon.velocity.x, dragon.velocity.y, dragon.velocity.z);
      if (Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 1e-6) throw new Error('not a unit quat');
      if (!(dragon.health >= 0 && dragon.health <= 1)) throw new Error('bad health');
      if (!(dragon.stamina >= 0 && dragon.stamina <= 1)) throw new Error('bad stamina');
      if (dragon.anim < 0 || dragon.anim >= DRAGON_ANIM_CLIPS.length) throw new Error('bad anim');
      if (dragon.flags < 0 || dragon.flags > 0xffff) throw new Error('bad flags');
    }
    if (snapshot.hasOwner) {
      const o = snapshot.owner;
      playerId(o.id);
      finite(o.position.x, o.position.y, o.position.z, o.yaw, o.pitch, o.roll);
      finite(o.yawRate, o.pitchRate, o.speed, o.burst.x, o.burst.y, o.burst.z);
      finite(o.stamina, o.health, o.maxHealth, o.ultCharge, o.slowScale, o.hasteScale);
      if (o.castSlot < -1 || o.castSlot > 3) throw new Error('bad castSlot');
      if (o.dodgeDir < -1 || o.dodgeDir > 1) throw new Error('bad dodgeDir');
      if ((o.prevButtons & ~BUTTON_MASK) !== 0) throw new Error('unknown button bits');
    }
  } else if (reader.error === DECODE_OK) throw new Error('failed without an error code');

  if (decodeHello(reader, hello)) {
    accepted++;
    if (Array.from(hello.name).length > MAX_PLAYER_NAME_LENGTH) throw new Error('name too long');
    if (/[\u0000-\u001f\u007f]/.test(hello.name)) throw new Error('control character in name');
    if (hello.reconnectToken !== '' && !isReconnectToken(hello.reconnectToken)) {
      throw new Error('bad token');
    }
    if (hello.clientId !== '' && !isReconnectToken(hello.clientId)) {
      throw new Error('bad client id');
    }
    if (hello.protocolVersion !== PROTOCOL_VERSION && hello.name !== '') {
      throw new Error('parsed a foreign version');
    }
  } else if (reader.error === DECODE_OK) throw new Error('failed without an error code');

  if (decodeWelcome(reader, welcome)) {
    accepted++;
    playerId(welcome.playerId);
    if (welcome.lobbyState === null) throw new Error('welcome without a lobby');
  }
  if (decodeLobbyState(reader, lobbyState)) {
    accepted++;
    if (lobbyState.lobbyState === null) throw new Error('lobby message without a lobby');
    for (const player of lobbyState.lobbyState.players) playerId(player.id);
  }
  if (decodeReject(reader, reject)) {
    accepted++;
    if (!REJECT_REASONS.includes(reject.reason)) throw new Error('bad reason');
  }
  if (decodeIntent(reader, intent)) {
    accepted++;
    const decoded = intent.intent;
    if (decoded === null || !NET_INTENT_TYPES.includes(decoded.type)) throw new Error('bad intent');
    if (decoded.type === 'host.kick' || decoded.type === 'host.movePlayer') {
      playerId(decoded.playerId);
    }
  }
  if (decodePing(reader, ping)) {
    accepted++;
    finite(ping.clientTimeMs);
  }
  if (decodePong(reader, pong)) {
    accepted++;
    finite(pong.clientTimeMs, pong.hostTimeMs, pong.hostTick);
  }
  if (decodeMatchStart(reader, matchStart)) {
    accepted++;
    finite(matchStart.startTick, matchStart.seed);
  }
  if (decodeMatchPhase(reader, matchPhase)) {
    accepted++;
    if (!MATCH_PHASES.includes(matchPhase.phase)) throw new Error('bad phase');
  }
  if (decodeGameEvents(reader, eventSink)) accepted++;
  if (decodeKick(reader, notice)) accepted++;
  if (decodeHostLeft(reader, notice)) accepted++;

  if (accepted > 1) throw new Error('one buffer decoded as two message types');
  return accepted;
}

/** One valid encoding of every message type. */
function sampleMessages(): Uint8Array[] {
  const w = new Writer(CTRL_MAX_BYTES);
  const out: Uint8Array[] = [];
  const keep = (length: number): void => {
    if (length <= 0) throw new Error('sample did not encode');
    out.push(new Uint8Array(w.buffer.slice(0, length)));
  };

  const sim = createSim();
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const classId = DRAGON_CLASS_IDS[id % DRAGON_CLASS_IDS.length] ?? 'talon';
    sim.spawnDragon(
      id,
      id % 2 === 0 ? TEAM_EMBER : TEAM_FROST,
      classId,
      { x: id * 30, y: 300, z: 0 },
      id,
    );
  }
  const frame = createInputFrame();
  frame.steerX = 0.4;
  for (let tick = 0; tick < 20; tick++) sim.step(tick, [frame, frame, frame]);

  const inputMsg = createInputMessage();
  inputMsg.frameCount = 3;
  inputMsg.hasAck = true;
  inputMsg.ackSnapshotTick = 17;
  keep(encodeInput(w, inputMsg));

  const snapshotMsg = fillSnapshotDragons(createSnapshotMessage(), sim.current);
  setSnapshotOwner(snapshotMsg, sim.getDragon(2));
  snapshotMsg.phase = 'playing';
  keep(encodeSnapshot(w, snapshotMsg));
  snapshotMsg.hasOwner = false;
  snapshotMsg.dragonCount = 2;
  keep(encodeSnapshot(w, snapshotMsg));

  // A fight: slow projectiles, zones, statuses and timers in the owner block, a moved storm wall.
  const fight = createInputFrame();
  fight.buttons = BUTTON_PRIMARY | BUTTON_SECONDARY | BUTTON_UTILITY | BUTTON_ULTIMATE | BUTTON_AIM;
  fight.aimYaw = 0.2;
  for (const dragon of sim.current.dragons) if (dragon.active) dragon.ultCharge = 1;
  sim.setStormRadius(640);
  for (let tick = 20; tick < 45; tick++) {
    fight.buttons ^= BUTTON_SECONDARY | BUTTON_UTILITY | BUTTON_ULTIMATE;
    sim.step(tick, [fight, fight, fight, fight, fight, fight, fight, fight, fight, fight]);
  }
  const fightMsg = fillSnapshotDragons(createSnapshotMessage(), sim.current);
  fillSnapshotEffects(fightMsg, sim.current);
  if (fightMsg.projectileCount === 0 || fightMsg.zoneCount === 0) {
    throw new Error('the sample fight produced no projectile or zone records');
  }
  setSnapshotOwner(fightMsg, sim.getDragon(3));
  fightMsg.phase = 'playing';
  keep(encodeSnapshot(w, fightMsg));

  let lobby = createLobby({ roomCode: 'K7QXM', hostName: 'Aurelia' });
  const joined = joinLobby(lobby, { name: 'Bram', token: 'token-1' });
  if (joined.ok) lobby = joined.lobby;

  keep(
    encodeHello(w, {
      tick: 0,
      protocolVersion: PROTOCOL_VERSION,
      name: 'Ysolde',
      reconnectToken: '00112233445566778899aabbccddeeff',
      clientId: 'ffeeddccbbaa99887766554433221100',
    }),
  );
  keep(
    encodeWelcome(w, {
      tick: 1,
      playerId: 1,
      reconnectToken: 'token-1',
      hostTick: 9000,
      lobbyState: lobby.state,
    }),
  );
  keep(encodeReject(w, { tick: 1, reason: 'full' }));
  keep(encodeLobbyState(w, { tick: 1, lobbyState: lobby.state }));
  keep(encodeIntent(w, { tick: 1, intent: { type: 'host.movePlayer', playerId: 1, side: 1 } }));
  keep(encodeIntent(w, { tick: 1, intent: { type: 'host.setTimeLimit', timeLimitS: 480 } }));
  keep(encodePing(w, { tick: 1, clientTimeMs: 1234.5 }));
  keep(encodePong(w, { tick: 1, clientTimeMs: 1234.5, hostTimeMs: 999.25, hostTick: 9001 }));
  keep(encodeMatchStart(w, { tick: 1, startTick: 9100, seed: 42, map: 'emberfall-caldera' }));
  keep(
    encodeMatchPhase(w, { tick: 1, phaseStartTick: 9100, phase: 'results', round: 1, winner: 0 }),
  );

  beginGameEvents(w, 1);
  writeGameEvent(w, {
    type: 'hit',
    tick: 9200,
    attackerId: 1,
    targetId: 2,
    source: 'primary',
    damage: 12,
    position: { x: 1, y: 2, z: 3 },
  });
  writeGameEvent(w, {
    type: 'abilityCast',
    tick: 9201,
    dragonId: 1,
    classId: 'talon',
    slot: 'utility',
    position: { x: 1, y: 2, z: 3 },
    direction: { x: 0, y: 1, z: 0 },
  });
  writeGameEvent(w, { type: 'matchPhase', tick: 9202, phase: 'playing', round: 1, winner: null });
  writeGameEvent(w, { type: 'assist', tick: 9203, assisterId: 3, killerId: 1, victimId: 2 });
  writeGameEvent(w, {
    type: 'statusApplied',
    tick: 9204,
    targetId: 2,
    sourceId: 1,
    status: 'slow',
    durationS: 1.5,
    position: { x: 4, y: 5, z: 6 },
  });
  writeGameEvent(w, {
    type: 'impact',
    tick: 9205,
    projectile: 'staticMine',
    ownerId: 1,
    targetId: 255,
    position: { x: 7, y: 8, z: 9 },
  });
  keep(endGameEvents(w));
  return out;
}

const MESSAGE_TYPES = [
  MSG_INPUT,
  MSG_SNAPSHOT,
  MSG_HELLO,
  MSG_WELCOME,
  MSG_REJECT,
  MSG_LOBBY_STATE,
  MSG_INTENT,
  MSG_PING,
  MSG_PONG,
  MSG_MATCH_START,
  MSG_MATCH_PHASE,
  MSG_GAME_EVENTS,
  MSG_KICK,
  MSG_HOST_LEFT,
];

describe('decoder fuzzing', () => {
  it('accepts every sample exactly once (the fuzz inputs below start from real messages)', () => {
    for (const sample of sampleMessages()) {
      expect(decodeAll(new DataView(sample.buffer))).toBe(1);
    }
  });

  it('survives 10 000 random buffers', () => {
    const random = createSeededRandom(0xf022);
    const scratch = new Uint8Array(400);
    for (let i = 0; i < 10_000; i++) {
      const length = Math.floor(random() * random() * scratch.length);
      for (let b = 0; b < length; b++) scratch[b] = Math.floor(random() * 256);
      // Half of them get a real type byte, so the bodies are reached and not just the header check.
      if (length > 0 && i % 2 === 0) {
        scratch[0] = MESSAGE_TYPES[Math.floor(random() * MESSAGE_TYPES.length)] ?? 0;
      }
      expect(() => decodeAll(new DataView(scratch.buffer, 0, length))).not.toThrow();
    }
  });

  it('survives every truncation of every message', () => {
    for (const sample of sampleMessages()) {
      for (let length = 0; length < sample.length; length++) {
        const view = new DataView(sample.buffer, 0, length);
        let accepted = -1;
        expect(() => (accepted = decodeAll(view))).not.toThrow();
        expect(accepted).toBe(0);
      }
    }
  });

  it('survives messages with trailing garbage', () => {
    const random = createSeededRandom(31);
    for (const sample of sampleMessages()) {
      const padded = new Uint8Array(sample.length + 9);
      padded.set(sample);
      for (let extra = 1; extra <= 9; extra++) {
        padded[sample.length + extra - 1] = Math.floor(random() * 256);
        const view = new DataView(padded.buffer, 0, sample.length + extra);
        let accepted = -1;
        expect(() => (accepted = decodeAll(view))).not.toThrow();
        expect(accepted).toBe(0);
      }
    }
  });

  it('survives 20 000 mutations of valid messages', () => {
    const random = createSeededRandom(0xbadc0de);
    const samples = sampleMessages();
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      const sample = samples[i % samples.length];
      if (sample === undefined) continue;
      const mutated = sample.slice();
      const flips = 1 + Math.floor(random() * 4);
      for (let f = 0; f < flips; f++) {
        const at = Math.floor(random() * mutated.length);
        mutated[at] =
          random() < 0.5
            ? Math.floor(random() * 256)
            : (mutated[at] ?? 0) ^ (1 << Math.floor(random() * 8));
      }
      const length = random() < 0.2 ? Math.floor(random() * (mutated.length + 1)) : mutated.length;
      const view = new DataView(mutated.buffer, 0, length);
      expect(() => (accepted += decodeAll(view))).not.toThrow();
    }
    // Most single-byte changes still give a legal message; the point is that none gives an illegal one.
    expect(accepted).toBeGreaterThan(1000);
  });

  it('rejects an oversized buffer before reading it', () => {
    const huge = new DataView(new ArrayBuffer(CTRL_MAX_BYTES + 1));
    for (const type of MESSAGE_TYPES) {
      huge.setUint8(0, type);
      expect(decodeAll(huge)).toBe(0);
    }
  });
});
