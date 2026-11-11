/**
 * Combat over the wire (T-3.1 / T-3.2): the new snapshot records and owner fields, veiled
 * dragons kept out of enemy snapshots, client-flown bolts, the host worker's view state, and end
 * to end on a loopback link: prediction stays exact while the riders use the abilities that move
 * them, and a real fight reaches every client.
 */

import { describe, expect, it } from 'vitest';
import {
  Reader,
  Writer,
  beginGameEvents,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  endGameEvents,
  fillSnapshotDragons,
  fillSnapshotEffects,
  setSnapshotOwner,
  snapInputFrame,
  snapshotByteLength,
  writeGameEvent,
} from '../../src/net/codec';
import {
  CTRL_MAX_BYTES,
  FAST_MAX_BYTES,
  SNAPSHOT_MAX_PROJECTILES,
  SNAPSHOT_MAX_ZONES,
  SNAPSHOT_OWNER_MAX_WIRE_BYTES,
  SNAPSHOT_ZONE_FRESH_TICKS,
  SNAPSHOT_ZONE_REFRESH,
  WIRE_POSITION_STEP_M,
  WIRE_VELOCITY_STEP_MPS,
  createInputMessage,
  createSnapshotMessage,
  staticZoneDue,
} from '../../src/net/protocol';
import { createGreyboxMatchWorld } from '../../src/net/session';
import type { MatchWorld } from '../../src/net/session';
import {
  CLIENT_BOLT_ID_BASE,
  ClientBolts,
  ClientRoster,
  HostSnapshotBuilder,
  SnapshotBuffer,
  createSnapshotClock,
  createSnapshotSample,
  shouldSendSnapshot,
} from '../../src/net/snapshot';
import type { SnapshotSample } from '../../src/net/snapshot';
import {
  appendHostEffects,
  createHostTickInfo,
  createHostViewState,
  decodeHostState,
  encodeHostState,
  hostStateBytes,
} from '../../src/net/worker';
import {
  ABILITY_TABLE,
  BUTTON_AIM,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_ULTIMATE,
  BUTTON_UTILITY,
  CLASS_TUNING,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  MAX_PLAYERS,
  NO_PLAYER,
  PROJECTILE_DEFS,
  PROJECTILE_KINDS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  ZONE_DEFS,
  ZONE_KINDS,
  beginWorldView,
  createInputFrame,
  createSeededRandom,
  createWorldView,
} from '../../src/shared';
import type { AbilityCastEvent, GameEvent, InputFrame, PlayerId } from '../../src/shared';
import { createSim, secondsToTicks } from '../../src/sim';
import type { Sim } from '../../src/sim';
import { createMapCollisionWorld } from '../../src/sim/collision';
import { createRoom, startMatch } from './session-harness';
import type { Rig } from './session-harness';

function viewOf(w: Writer, length: number): DataView {
  return new DataView(w.buffer, 0, length);
}

/** Four dragons; a Tempest that has thrown a mine and raised a thunderhead, a hasted Talon. */
function fightSim(): Sim {
  const sim = createSim();
  sim.spawnDragon(0, TEAM_EMBER, 'tempest', { x: 0, y: 300, z: 0 }, 0);
  sim.spawnDragon(1, TEAM_FROST, 'talon', { x: 40, y: 300, z: 300 }, Math.PI);
  sim.spawnDragon(2, TEAM_EMBER, 'wraith', { x: -60, y: 320, z: 0 }, 0);
  sim.spawnDragon(3, TEAM_FROST, 'bastion', { x: 0, y: 280, z: 400 }, Math.PI);
  const inputs: InputFrame[] = [0, 1, 2, 3].map(() => createInputFrame());
  const tempest = sim.getDragon(0);
  if (tempest !== undefined) tempest.ultCharge = 1;
  for (let tick = 0; tick < 24; tick++) {
    const pressed = tick === 2;
    (inputs[0] as InputFrame).buttons = pressed ? BUTTON_SECONDARY | BUTTON_ULTIMATE : 0;
    (inputs[1] as InputFrame).buttons = BUTTON_PRIMARY | (pressed ? BUTTON_UTILITY : 0);
    (inputs[2] as InputFrame).buttons = pressed ? BUTTON_SECONDARY : 0;
    (inputs[3] as InputFrame).buttons = pressed ? BUTTON_UTILITY : 0;
    sim.step(tick, inputs);
  }
  return sim;
}

// --- Codec -----------------------------------------------------------------------------------------

describe('codec: aim in INPUT', () => {
  it('round-trips the aim on the wire grid and clamps what is out of range', () => {
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    const msg = createInputMessage();
    msg.frameCount = 1;
    const frame = msg.frames[0];
    if (frame === undefined) throw new Error('no frame');
    frame.tick = 9;
    frame.buttons = BUTTON_AIM | BUTTON_PRIMARY;
    frame.aimYaw = -2.345678;
    frame.aimPitch = 0.6543;
    const sent = { ...frame };
    snapInputFrame(frame);
    // The grid is far finer than any aim needs.
    expect(Math.abs(frame.aimYaw - sent.aimYaw)).toBeLessThan(1e-4);
    expect(Math.abs(frame.aimPitch - sent.aimPitch)).toBeLessThan(1e-4);
    const out = createInputMessage();
    expect(decodeInput(r.reset(viewOf(w, encodeInput(w, msg))), out)).toBe(true);
    // Snapped on the client, so the host sees bit-identical values.
    expect(out.frames[0]?.aimYaw).toBe(frame.aimYaw);
    expect(out.frames[0]?.aimPitch).toBe(frame.aimPitch);
    expect(out.frames[0]?.buttons).toBe(BUTTON_AIM | BUTTON_PRIMARY);

    frame.aimYaw = 40;
    frame.aimPitch = Number.NaN;
    snapInputFrame(frame);
    expect(frame.aimYaw).toBeGreaterThanOrEqual(-Math.PI);
    expect(frame.aimYaw).toBeLessThanOrEqual(Math.PI);
    expect(frame.aimPitch).toBe(0);
    frame.aimYaw = Infinity;
    frame.aimPitch = 99;
    expect(decodeInput(r.reset(viewOf(w, encodeInput(w, msg))), out)).toBe(true);
    expect(Math.abs(out.frames[0]?.aimYaw ?? NaN)).toBeLessThanOrEqual(Math.PI);
    expect(out.frames[0]?.aimPitch).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('codec: combat in SNAPSHOT', () => {
  it("carries the owner block's combat state exactly", () => {
    const sim = fightSim();
    const w = new Writer(FAST_MAX_BYTES);
    const r = new Reader();
    for (const id of [0, 1, 2, 3]) {
      const dragon = sim.getDragon(id);
      if (dragon === undefined) throw new Error('no dragon');
      dragon.ultCharge = 0.25 + id * 0.125;
      dragon.lastDamagerId = (id + 1) % 4;
      dragon.blindTicks = 7 + id;
      dragon.burnTicks = 3 * id;
      dragon.regenTicks = 11;
      dragon.slowTicks = 40;
      dragon.slowScale = 0.5;
      dragon.shieldTicks = 12;
      dragon.deadTicks = id;
      const msg = fillSnapshotDragons(createSnapshotMessage(), sim.current);
      setSnapshotOwner(msg, dragon);
      const out = createSnapshotMessage();
      expect(decodeSnapshot(r.reset(viewOf(w, encodeSnapshot(w, msg))), out)).toBe(true);
      const o = out.owner;
      // Everything here is an integer or a float that f32 holds exactly.
      expect(o.abilityCooldownTicks).toEqual(dragon.abilityCooldownTicks);
      expect(o.abilityActiveTicks).toEqual(dragon.abilityActiveTicks);
      expect(o.abilityChargesUsed).toEqual(dragon.abilityChargesUsed);
      expect(o.castSlot).toBe(dragon.castSlot);
      expect(o.castTicks).toBe(dragon.castTicks);
      expect(o.ultCharge).toBe(dragon.ultCharge);
      expect(o.slowScale).toBe(dragon.slowScale);
      expect(o.hasteScale).toBeCloseTo(dragon.hasteScale, 6);
      for (const key of [
        'firingTicks',
        'slowTicks',
        'hasteTicks',
        'burnTicks',
        'regenTicks',
        'blindTicks',
        'veilTicks',
        'phaseTicks',
        'shieldTicks',
        'deadTicks',
        'lastDamagerId',
      ] as const) {
        expect(o[key], key).toBe(dragon[key]);
      }
    }
    // The scenario really set these up.
    expect(sim.getDragon(1)?.hasteTicks).toBeGreaterThan(0);
    expect(sim.getDragon(1)?.firingTicks).toBeGreaterThan(0);
    expect(sim.getDragon(0)?.abilityChargesUsed[1]).toBe(1);
    expect(sim.getDragon(2)?.veilTicks).toBeGreaterThan(0);
  });

  it('carries zones, slow projectiles and the storm radius; bolts are left to their events', () => {
    const sim = fightSim();
    sim.setStormRadius(512.3);
    const state = sim.current;
    const bolts = state.projectiles.filter(
      (p) => p.active && PROJECTILE_KINDS[p.kind] === 'fireBolt',
    );
    const mines = state.projectiles.filter(
      (p) => p.active && PROJECTILE_KINDS[p.kind] === 'staticMine',
    );
    const zones = state.zones.filter((z) => z.active);
    expect(bolts.length).toBeGreaterThan(0);
    expect(mines).toHaveLength(1);
    // thunderhead, rally aura, burn trail
    expect(zones.length).toBeGreaterThanOrEqual(3);

    // Standing zones are only listed while new and then now and again (the next test); here
    // they are all made new, so every record is on the wire.
    for (const zone of zones) zone.ageTicks = 0;
    const msg = fillSnapshotDragons(createSnapshotMessage(), state);
    fillSnapshotEffects(msg, state);
    expect(msg.projectileCount).toBe(1);
    expect(msg.zoneCount).toBe(zones.length);
    const w = new Writer(FAST_MAX_BYTES);
    const length = encodeSnapshot(w, msg);
    expect(length).toBe(snapshotByteLength(4, 0, 1, zones.length));
    const out = createSnapshotMessage();
    expect(decodeSnapshot(new Reader().reset(viewOf(w, length)), out)).toBe(true);
    expect(out.stormRadius).toBeCloseTo(512.3, 6);
    expect(out.projectileCount).toBe(1);
    expect(out.zoneCount).toBe(zones.length);

    const mine = mines[0];
    const gotMine = out.projectiles[0];
    if (mine === undefined || gotMine === undefined) throw new Error('no mine');
    expect(gotMine.id).toBe(mine.id);
    expect(PROJECTILE_KINDS[gotMine.kind]).toBe('staticMine');
    expect(gotMine.ownerId).toBe(0);
    expect(gotMine.team).toBe(TEAM_EMBER);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(gotMine.position[axis] - mine.position[axis])).toBeLessThanOrEqual(
        WIRE_POSITION_STEP_M / 2 + 1e-9,
      );
      expect(Math.abs(gotMine.velocity[axis] - mine.velocity[axis])).toBeLessThanOrEqual(
        WIRE_VELOCITY_STEP_MPS / 2 + 1e-9,
      );
    }
    zones.forEach((zone, i) => {
      const got = out.zones[i];
      if (got === undefined) throw new Error('missing zone');
      expect(got.id).toBe(zone.id);
      expect(got.kind).toBe(zone.kind);
      expect(got.ownerId).toBe(zone.ownerId);
      expect(got.team).toBe(zone.team);
      expect(got.radius).toBeCloseTo(zone.radius, 0);
      expect(Math.abs(got.radius - zone.radius)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(got.remainingS - zone.ticksLeft * TICK_DT_S)).toBeLessThanOrEqual(
        0.05 + 1e-9,
      );
      expect(Math.abs(got.position.x - zone.position.x)).toBeLessThanOrEqual(
        WIRE_POSITION_STEP_M / 2 + 1e-9,
      );
    });

    // The map's own radius is "no radius" on the wire.
    sim.setStormRadius(-1);
    fillSnapshotEffects(msg, sim.current);
    expect(decodeSnapshot(new Reader().reset(viewOf(w, encodeSnapshot(w, msg))), out)).toBe(true);
    expect(out.stormRadius).toBe(-1);
  });

  it('never lists more records than the limits, whatever the pools hold', () => {
    const sim = createSim({
      projectileDefs: {
        ...PROJECTILE_DEFS,
        fireBolt: { ...PROJECTILE_DEFS.fireBolt, lifeS: 60, speed: 2, replication: 'snapshot' },
      },
      abilityTable: {
        ...ABILITY_TABLE,
        talon: {
          ...ABILITY_TABLE.talon,
          primary: { ...ABILITY_TABLE.talon.primary, cooldownS: 1 / 30 },
        },
      },
    });
    const inputs: InputFrame[] = [];
    for (let id = 0; id < MAX_PLAYERS; id++) {
      sim.spawnDragon(
        id,
        id % 2 === 0 ? TEAM_EMBER : TEAM_FROST,
        'talon',
        { x: id * 500, y: 300, z: 0 },
        0,
      );
      const frame = createInputFrame();
      frame.buttons = BUTTON_PRIMARY;
      inputs.push(frame);
    }
    for (let tick = 0; tick < 30; tick++) sim.step(tick, inputs);
    expect(sim.current.projectileCount).toBeGreaterThan(SNAPSHOT_MAX_PROJECTILES);
    const msg = fillSnapshotDragons(createSnapshotMessage(), sim.current);
    // The defaults say bolts are not snapshot material; this sim's table says they are.
    fillSnapshotEffects(msg, sim.current, {
      ...PROJECTILE_DEFS,
      fireBolt: { ...PROJECTILE_DEFS.fireBolt, replication: 'snapshot' },
    });
    expect(msg.projectileCount).toBe(SNAPSHOT_MAX_PROJECTILES);
    setSnapshotOwner(msg, sim.getDragon(0));
    const w = new Writer(FAST_MAX_BYTES);
    const length = encodeSnapshot(w, msg);
    expect(length).toBeLessThanOrEqual(
      snapshotByteLength(MAX_PLAYERS, SNAPSHOT_OWNER_MAX_WIRE_BYTES, SNAPSHOT_MAX_PROJECTILES, 0),
    );
    expect(length).toBeGreaterThan(snapshotByteLength(MAX_PLAYERS, 0, SNAPSHOT_MAX_PROJECTILES, 0));
    expect(length).toBeLessThanOrEqual(FAST_MAX_BYTES);
    expect(decodeSnapshot(new Reader().reset(viewOf(w, length)), createSnapshotMessage())).toBe(
      true,
    );
    expect(SNAPSHOT_MAX_ZONES).toBeGreaterThan(0);
  });
});

describe('bandwidth of a fight', () => {
  it('10 dragons spamming every ability: bytes per client, reported', () => {
    // The worst case on purpose: nobody plays like this (every button, an ultimate whenever the
    // dice say so), so real fights sit between the quiet figure and this one.
    const random = createSeededRandom(5);
    const w = new Writer(FAST_MAX_BYTES);
    const eventWriter = new Writer(CTRL_MAX_BYTES);
    let eventBytes = 0;
    let events = 0;
    beginGameEvents(eventWriter, 0);
    const sim = createSim({
      events: {
        emit(event) {
          events++;
          if (!writeGameEvent(eventWriter, event)) {
            eventBytes += endGameEvents(eventWriter);
            beginGameEvents(eventWriter, 0);
            writeGameEvent(eventWriter, event);
          }
        },
      },
    });
    const classes = ['talon', 'bastion', 'tempest', 'wraith'] as const;
    const frames: InputFrame[] = [];
    let quiet = 0;
    const calm = createSim();
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const angle = (id / MAX_PLAYERS) * Math.PI * 2;
      for (const target of [sim, calm]) {
        target.spawnDragon(
          id,
          id % 2 === 0 ? TEAM_EMBER : TEAM_FROST,
          classes[id % 4] ?? 'talon',
          { x: Math.sin(angle) * 150, y: 300 + (id % 3) * 20, z: Math.cos(angle) * 150 },
          angle + Math.PI,
        );
      }
      frames.push(createInputFrame());
    }
    const msg = createSnapshotMessage();
    // The floor: ten dragons cruising, nothing in the air, three seconds in.
    for (let tick = 0; tick < 90; tick++) calm.step(tick, []);
    fillSnapshotDragons(msg, calm.current);
    fillSnapshotEffects(msg, calm.current);
    setSnapshotOwner(msg, calm.getDragon(0));
    quiet = encodeSnapshot(w, msg);
    const ticks = 60 * 30;
    let snapshots = 0;
    let snapshotBytes = 0;
    let largest = 0;
    let records = 0;
    let zoneRecords = 0;
    for (let tick = 0; tick < ticks; tick++) {
      for (let id = 0; id < MAX_PLAYERS; id++) {
        const frame = frames[id];
        const dragon = sim.getDragon(id);
        if (frame === undefined || dragon === undefined || random() >= 0.1) continue;
        const home = Math.atan2(-dragon.position.x, -dragon.position.z);
        const error = Math.atan2(Math.sin(home - dragon.yaw), Math.cos(home - dragon.yaw));
        frame.steerX = Math.max(-1, Math.min(1, -error + random() - 0.5));
        frame.steerY = Math.max(-1, Math.min(1, (300 - dragon.position.y) / 100));
        frame.buttons = Math.floor(random() * 4096);
        if (random() < 0.2) dragon.ultCharge = 1;
      }
      sim.step(tick, frames);
      if (!shouldSendSnapshot(tick)) continue;
      fillSnapshotDragons(msg, sim.current);
      fillSnapshotEffects(msg, sim.current);
      setSnapshotOwner(msg, sim.getDragon(0));
      const length = encodeSnapshot(w, msg);
      expect(length).toBeGreaterThan(0);
      snapshots++;
      snapshotBytes += length;
      records += msg.projectileCount + msg.zoneCount;
      zoneRecords += msg.zoneCount;
      if (length > largest) largest = length;
    }
    eventBytes += endGameEvents(eventWriter);
    const seconds = ticks / 30;
    const snapshotRate = snapshotBytes / seconds;
    const eventRate = eventBytes / seconds;
    console.log(
      `[net] 10 dragons spamming abilities, per client: snapshots ${(snapshotRate / 1024).toFixed(1)} KB/s ` +
        `(avg ${(snapshotBytes / snapshots).toFixed(0)} B, max ${largest} B, ` +
        `${(records / snapshots).toFixed(1)} projectile+zone records), ` +
        `events ${(eventRate / 1024).toFixed(1)} KB/s (${(events / seconds).toFixed(0)}/s); ` +
        `(${(zoneRecords / snapshots).toFixed(1)} zones); quiet: ${quiet} B, ${((quiet * 20) / 1024).toFixed(1)} KB/s`,
    );
    expect(largest).toBeLessThanOrEqual(FAST_MAX_BYTES);
    // Every snapshot is still one small datagram-sized message.
    expect(largest).toBeLessThan(1000);
    // The floor is well inside the 7 KB/s budget of docs/NETWORKING.md, which a real fight
    // keeps on average (tests/net/bots-load.test.ts asserts that). This synthetic ceiling is
    // nearly all meteor bombs (an ultimate every few seconds for everyone): about 12 KB/s.
    expect(quiet * 20).toBeLessThan(5.5 * 1024);
    expect(snapshotRate + eventRate).toBeLessThan(12.5 * 1024);
  });
});

// --- Veil ------------------------------------------------------------------------------------------

describe('host snapshots: veil', () => {
  it('leaves a veiled dragon out of enemy snapshots only', () => {
    const sim = fightSim();
    const veiled = sim.getDragon(2);
    expect((veiled?.flags ?? 0) & DRAGON_FLAG_VEILED).toBe(DRAGON_FLAG_VEILED);
    const builder = new HostSnapshotBuilder();
    builder.begin(sim.current, createSnapshotClock());
    const idsFor = (recipient: PlayerId): number[] => {
      const msg = builder.forRecipient(recipient, false, 0);
      // What goes on the wire, not what the struct holds.
      const w = new Writer(FAST_MAX_BYTES);
      const out = createSnapshotMessage();
      expect(decodeSnapshot(new Reader().reset(viewOf(w, encodeSnapshot(w, msg))), out)).toBe(true);
      return out.dragons.slice(0, out.dragonCount).map((d) => d.id);
    };
    // Its own team, itself and spectators see it; the other team does not.
    expect(idsFor(0)).toEqual([0, 1, 2, 3]);
    expect(idsFor(1)).toEqual([0, 1, 3]);
    expect(idsFor(2)).toEqual([0, 1, 2, 3]);
    expect(idsFor(3)).toEqual([0, 1, 3]);
    expect(idsFor(NO_PLAYER)).toEqual([0, 1, 2, 3]);
    expect(idsFor(1)).toEqual([0, 1, 3]);
    expect(idsFor(0)).toEqual([0, 1, 2, 3]);
    // The owner block of the veiled dragon itself is still there.
    const own = builder.forRecipient(2, false, 0);
    expect(own.hasOwner).toBe(true);
    expect(own.owner.veilTicks).toBeGreaterThan(0);

    // Next tick it attacks: everyone sees it again.
    const inputs: InputFrame[] = [0, 1, 2, 3].map(() => createInputFrame());
    (inputs[2] as InputFrame).buttons = BUTTON_PRIMARY;
    sim.step(sim.current.tick + 1, inputs);
    builder.begin(sim.current, createSnapshotClock());
    expect(idsFor(1)).toEqual([0, 1, 2, 3]);
    expect(idsFor(3)).toEqual([0, 1, 2, 3]);
  });
});

// --- Client side -----------------------------------------------------------------------------------

describe('snapshot buffer: projectiles and zones', () => {
  it('samples them at the playhead: lerped while both ends have them, carried when only one does', () => {
    const buffer = new SnapshotBuffer();
    const msg = createSnapshotMessage();
    const push = (tick: number, mineZ: number | null, auraX: number): void => {
      msg.tick = tick;
      msg.dragonCount = 0;
      msg.stormRadius = 700;
      msg.projectileCount = mineZ === null ? 0 : 1;
      const mine = msg.projectiles[0];
      if (mine === undefined) throw new Error('no slot');
      mine.id = 5;
      mine.kind = PROJECTILE_KINDS.indexOf('staticMine');
      mine.ownerId = 3;
      mine.team = TEAM_FROST;
      mine.position.x = 0;
      mine.position.y = 300;
      mine.position.z = mineZ ?? 0;
      mine.velocity.x = 0;
      mine.velocity.y = 0;
      mine.velocity.z = 90;
      msg.zoneCount = 1;
      const aura = msg.zones[0];
      if (aura === undefined) throw new Error('no slot');
      aura.id = 9;
      aura.kind = ZONE_KINDS.indexOf('rallyAura');
      aura.ownerId = 3;
      aura.team = TEAM_FROST;
      aura.position.x = auraX;
      aura.position.y = 300;
      aura.position.z = 0;
      aura.radius = 48;
      aura.remainingS = 5 - tick * TICK_DT_S;
      buffer.push(msg, 0, tick);
    };
    push(100, 0, 0);
    push(102, 6, 10);
    push(104, null, 20);

    const sample = createSnapshotSample();
    buffer.sampleAt(sample, 101);
    expect(sample.stormRadius).toBe(700);
    expect(sample.projectileCount).toBe(1);
    expect(sample.projectiles[0]?.position.z).toBeCloseTo(3, 9);
    expect(sample.projectiles[0]?.ownerId).toBe(3);
    expect(sample.zoneCount).toBe(1);
    // A zone on its owner moves between snapshots.
    expect(sample.zones[0]?.position.x).toBeCloseTo(5, 9);
    expect(sample.zones[0]?.remainingS).toBeCloseTo(5 - 101 * TICK_DT_S, 6);

    // Between 102 and 104 the mine is gone from the later one: it flies on along its velocity.
    buffer.sampleAt(sample, 103);
    expect(sample.projectileCount).toBe(1);
    expect(sample.projectiles[0]?.position.z).toBeCloseTo(6 + 90 * TICK_DT_S, 6);
    buffer.sampleAt(sample, 104);
    expect(sample.projectileCount).toBe(0);
    expect(sample.zones[0]?.position.x).toBeCloseTo(20, 9);
  });
});

describe('standing zones: sent now and again, carried by the client', () => {
  it('the host lists one while it is new, then every fifth snapshot; a zone on its owner always', () => {
    const sim = createSim();
    sim.spawnDragon(0, TEAM_EMBER, 'tempest', { x: 0, y: 300, z: 0 }, 0);
    sim.spawnDragon(1, TEAM_EMBER, 'bastion', { x: 60, y: 300, z: 0 }, 0);
    const tempest = sim.getDragon(0);
    if (tempest === undefined) throw new Error('no dragon');
    tempest.ultCharge = 1;
    const inputs = [createInputFrame(), createInputFrame()];
    (inputs[0] as InputFrame).buttons = BUTTON_ULTIMATE;
    (inputs[1] as InputFrame).buttons = BUTTON_UTILITY;
    const thunderhead = ZONE_KINDS.indexOf('thunderhead');
    const aura = ZONE_KINDS.indexOf('rallyAura');
    const msg = createSnapshotMessage();
    const listed = { thunderhead: 0, aura: 0, snapshots: 0, early: 0 };
    let longestGap = 0;
    let gap = 0;
    const auraTicks = secondsToTicks(ZONE_DEFS.rallyAura.durationS);
    for (let tick = 0; tick < auraTicks - 3; tick++) {
      sim.step(tick, inputs);
      (inputs[0] as InputFrame).buttons = 0;
      (inputs[1] as InputFrame).buttons = 0;
      if (!shouldSendSnapshot(tick)) continue;
      fillSnapshotEffects(msg, sim.current);
      const kinds = msg.zones.slice(0, msg.zoneCount).map((zone) => zone.kind);
      const zone = sim.current.zones.find((z) => z.active && z.kind === thunderhead);
      if (zone === undefined) continue;
      listed.snapshots++;
      if (kinds.includes(aura)) listed.aura++;
      if (kinds.includes(thunderhead)) {
        listed.thunderhead++;
        if (zone.ageTicks < SNAPSHOT_ZONE_FRESH_TICKS) listed.early++;
        expect(zone.ageTicks < SNAPSHOT_ZONE_FRESH_TICKS || staticZoneDue(tick, zone.id)).toBe(
          true,
        );
        gap = 0;
      } else {
        longestGap = Math.max(longestGap, ++gap);
      }
    }
    expect(listed.snapshots).toBeGreaterThan(80);
    // Every snapshot of its first ticks, so a lost one does not delay the picture.
    expect(listed.early).toBeGreaterThanOrEqual(3);
    expect(longestGap).toBe(SNAPSHOT_ZONE_REFRESH - 1);
    expect(listed.thunderhead).toBeLessThan(listed.snapshots / 4);
    // The aura moves with its owner: every snapshot.
    expect(listed.aura).toBe(listed.snapshots);
  });

  it('the client carries it between refreshes, counts it down and drops it when it has ended', () => {
    const buffer = new SnapshotBuffer();
    const msg = createSnapshotMessage();
    const zoneId = 7;
    const push = (tick: number, remainingS: number | null): void => {
      msg.tick = tick;
      msg.dragonCount = 0;
      msg.projectileCount = 0;
      msg.zoneCount = remainingS === null ? 0 : 1;
      const zone = msg.zones[0];
      if (zone === undefined) throw new Error('no slot');
      zone.id = zoneId;
      zone.kind = ZONE_KINDS.indexOf('thunderhead');
      zone.ownerId = 2;
      zone.team = TEAM_EMBER;
      zone.position.x = 40;
      zone.position.y = 310;
      zone.position.z = -20;
      zone.radius = 42;
      zone.remainingS = remainingS ?? 0;
      buffer.push(msg, 0, tick);
    };
    const sample = createSnapshotSample();
    const zoneAt = (tick: number): SnapshotSample['zones'][number] | undefined => {
      buffer.sampleAt(sample, tick);
      return sample.zoneCount > 0 ? sample.zones[0] : undefined;
    };
    // Snapshot ticks on which this zone is not due, and the first one on which it is.
    const ticks: number[] = [];
    let tick = 300;
    while (ticks.length < 3) {
      if (shouldSendSnapshot(tick) && !staticZoneDue(tick, zoneId)) ticks.push(tick);
      tick++;
    }
    while (!(shouldSendSnapshot(tick) && staticZoneDue(tick, zoneId))) tick++;
    const dueTick = tick;
    const [first, second, third] = ticks as [number, number, number];

    push(first, 6);
    push(second, null);
    push(third, null);
    // Not listed, not due: still there, where it was, with less time left.
    const carried = zoneAt(third);
    expect(carried?.id).toBe(zoneId);
    expect(carried?.position.x).toBe(40);
    expect(carried?.radius).toBe(42);
    expect(carried?.remainingS).toBeCloseTo(6 - (third - first) * TICK_DT_S, 6);
    expect(zoneAt((second + third) / 2)?.remainingS).toBeCloseTo(
      6 - ((second + third) / 2 - first) * TICK_DT_S,
      6,
    );

    // Refreshed when due: the host's number replaces the carried one.
    push(dueTick, 5);
    expect(zoneAt(dueTick)?.remainingS).toBeCloseTo(5, 6);

    // Due and missing (a Duel round was reset): it has ended.
    let next = dueTick + 1;
    while (!(shouldSendSnapshot(next) && staticZoneDue(next, zoneId))) {
      if (shouldSendSnapshot(next)) push(next, null);
      next++;
    }
    expect(zoneAt(next - 1)).toBeDefined();
    push(next, null);
    expect(zoneAt(next)).toBeUndefined();

    // And one that simply runs out is not carried past its time.
    const later = next + 300;
    const laterTicks: number[] = [];
    for (let t = later; laterTicks.length < 2; t++) {
      if (shouldSendSnapshot(t) && !staticZoneDue(t, zoneId)) laterTicks.push(t);
    }
    const [seen, after] = laterTicks as [number, number];
    push(seen, 0.01);
    push(after, null);
    expect(zoneAt(seen)).toBeDefined();
    expect(zoneAt(after)).toBeUndefined();
  });
});

describe('client bolts', () => {
  const cast: AbilityCastEvent = {
    type: 'abilityCast',
    tick: 100,
    dragonId: 4,
    classId: 'talon',
    slot: 'primary',
    position: { x: 0, y: 300, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
  };
  const speed = PROJECTILE_DEFS.fireBolt.speed;

  it('flies a bolt from a cast event, starting when the playhead reaches the cast', () => {
    const bolts = new ClientBolts();
    const roster = new ClientRoster();
    const view = createWorldView();
    // The playhead is 3 ticks (100 ms) behind the event.
    bolts.onAbilityCast(cast, TEAM_EMBER, 97, NO_PLAYER);
    expect(bolts.count).toBe(1);
    bolts.update(50, null, null, roster, null);
    beginWorldView(view);
    bolts.writeView(view);
    expect(view.projectileCount).toBe(0);
    // 100 ms in it launches; 50 ms later it has flown for 50 ms.
    bolts.update(100, null, null, roster, null);
    beginWorldView(view);
    bolts.writeView(view);
    expect(view.projectileCount).toBe(1);
    const drawn = view.projectiles[0];
    expect(drawn?.kind).toBe('fireBolt');
    expect(drawn?.ownerId).toBe(4);
    expect(drawn?.team).toBe(TEAM_EMBER);
    expect(drawn?.id).toBeGreaterThanOrEqual(CLIENT_BOLT_ID_BASE);
    const muzzle = CLASS_TUNING.talon.hitRadius + PROJECTILE_DEFS.fireBolt.radius + 0.5;
    expect(drawn?.position.z).toBeCloseTo(muzzle + speed * 0.05, 6);
    expect(drawn?.velocity.z).toBeCloseTo(speed, 9);
    // It ends with its life.
    for (let i = 0; i < 80; i++) bolts.update(16, null, null, roster, null);
    expect(bolts.count).toBe(0);
  });

  it("ignores casts that launch no bolt, and the local rider's own echo", () => {
    const bolts = new ClientBolts();
    bolts.onAbilityCast({ ...cast, slot: 'secondary' }, TEAM_EMBER, 100, NO_PLAYER);
    bolts.onAbilityCast({ ...cast, classId: 'bastion' }, TEAM_EMBER, 100, NO_PLAYER);
    // A mine is a snapshot record, not a client bolt.
    bolts.onAbilityCast(
      { ...cast, classId: 'tempest', slot: 'secondary' },
      TEAM_EMBER,
      100,
      NO_PLAYER,
    );
    bolts.onAbilityCast(cast, TEAM_EMBER, 100, 4);
    expect(bolts.count).toBe(0);
    bolts.onAbilityCast(cast, TEAM_EMBER, 100, 5);
    expect(bolts.count).toBe(1);
    bolts.reset();
    expect(bolts.count).toBe(0);
  });

  it("shows the local rider's shot at once, from the predicted dragon", () => {
    const sim = createSim();
    const dragon = sim.spawnDragon(4, TEAM_EMBER, 'talon', { x: 10, y: 300, z: 20 }, 0);
    if (dragon === null) throw new Error('no dragon');
    const bolts = new ClientBolts();
    bolts.spawnLocal(dragon, 1);
    expect(bolts.count).toBe(0);
    bolts.spawnLocal(dragon, 0);
    expect(bolts.count).toBe(1);
    const view = createWorldView();
    bolts.update(1000 / 60, null, null, new ClientRoster(), null);
    bolts.writeView(view);
    expect(view.projectiles[0]?.position.x).toBeCloseTo(10, 6);
    expect(view.projectiles[0]?.position.z).toBeGreaterThan(20);
  });

  it('stops on terrain and on an enemy it touches, and passes teammates', () => {
    const wall = createMapCollisionWorld({
      size: 2000,
      solids: [
        {
          kind: 'box',
          role: 'stone',
          position: { x: 0, y: 300, z: 60 },
          yaw: 0,
          pitch: 0,
          roll: 0,
          size: { x: 100, y: 100, z: 10 },
        },
      ],
      chunkSize: 250,
      colliders: {
        stormCenter: { x: 0, y: 0, z: 0 },
        stormRadius: 1000,
        ceilingY: 700,
        floorY: -40,
      },
    });
    const roster = new ClientRoster();
    const flyFor = (
      bolts: ClientBolts,
      frames: number,
      world: typeof wall | null,
      sample: ReturnType<typeof createSnapshotSample> | null,
    ): number => {
      for (let i = 0; i < frames; i++) bolts.update(1000 / 60, world, sample, roster, null);
      return bolts.count;
    };
    const blocked = new ClientBolts();
    blocked.onAbilityCast(cast, TEAM_EMBER, 100, NO_PLAYER);
    expect(flyFor(blocked, 20, wall, null)).toBe(0);
    const open = new ClientBolts();
    open.onAbilityCast(cast, TEAM_EMBER, 100, NO_PLAYER);
    expect(flyFor(open, 20, null, null)).toBe(1);

    // A dragon in the way, 80 m out.
    const sample = createSnapshotSample();
    sample.valid = true;
    sample.dragonCount = 1;
    const target = sample.dragons[0];
    if (target === undefined) throw new Error('no slot');
    target.id = 7;
    target.flags = DRAGON_FLAG_ALIVE;
    target.position.x = 0;
    target.position.y = 300;
    target.position.z = 80;
    roster.set(7, TEAM_FROST, 'bastion');
    const hits = new ClientBolts();
    hits.onAbilityCast(cast, TEAM_EMBER, 100, NO_PLAYER);
    expect(flyFor(hits, 30, null, sample)).toBe(0);
    roster.set(7, TEAM_EMBER, 'bastion');
    const passes = new ClientBolts();
    passes.onAbilityCast(cast, TEAM_EMBER, 100, NO_PLAYER);
    expect(flyFor(passes, 30, null, sample)).toBe(1);
  });
});

// --- Host worker view state ------------------------------------------------------------------------

describe('host view state: combat', () => {
  it('mirrors projectiles, zones and the local combat fields, and builds the view from them', () => {
    const sim = fightSim();
    sim.setStormRadius(640);
    sim.step(sim.current.tick + 1, []);
    const bytes = hostStateBytes(sim.prev, sim.current);
    const data = new DataView(new ArrayBuffer(bytes));
    expect(encodeHostState(data, 0, createHostTickInfo(), sim.prev, sim.current)).toBe(bytes);
    const prev = createHostViewState();
    const current = createHostViewState();
    expect(decodeHostState(data, 0, bytes, createHostTickInfo(), prev, current)).toBe(true);
    // Cut short anywhere, it is refused.
    expect(
      decodeHostState(
        data,
        0,
        bytes - 1,
        createHostTickInfo(),
        createHostViewState(),
        createHostViewState(),
      ),
    ).toBe(false);

    expect(current.stormRadius).toBe(640);
    const live = sim.current.projectiles.filter((p) => p.active);
    const mirrored = current.projectiles.filter((p) => p.active);
    expect(mirrored).toHaveLength(live.length);
    expect(mirrored.map((p) => p.id).sort()).toEqual(live.map((p) => p.id).sort());
    const zones = sim.current.zones.filter((z) => z.active);
    expect(current.zones.filter((z) => z.active)).toHaveLength(zones.length);
    const tempest = sim.getDragon(0);
    const mirror = current.dragons.find((d) => d.active && d.id === 0);
    if (tempest === undefined || mirror === undefined) throw new Error('no dragon');
    expect(mirror.abilityCooldownTicks).toEqual(tempest.abilityCooldownTicks);
    expect(mirror.abilityChargesUsed).toEqual(tempest.abilityChargesUsed);
    expect(mirror.abilityActiveTicks).toEqual(tempest.abilityActiveTicks);
    expect(mirror.ultCharge).toBe(tempest.ultCharge);
    expect(mirror.castSlot).toBe(tempest.castSlot);

    // The same picture from the sim's own states (direct host) and from the mirror (worker host).
    const direct = createWorldView();
    const viaWorker = createWorldView();
    appendHostEffects(direct, sim.current, 0.5, { localDragonId: 0 });
    appendHostEffects(viaWorker, current, 0.5, { localDragonId: 0 });
    expect(direct.projectileCount).toBe(live.length);
    expect(direct.zoneCount).toBe(zones.length);
    expect(viaWorker.projectileCount).toBe(direct.projectileCount);
    expect(viaWorker.zoneCount).toBe(direct.zoneCount);
    const kinds = (view: typeof direct): string[] =>
      view.zones
        .slice(0, view.zoneCount)
        .map((z) => `${z.kind}:${z.team}:${z.ownerId}`)
        .sort();
    expect(kinds(viaWorker)).toEqual(kinds(direct));
    expect(kinds(direct).some((k) => k.startsWith('thunderhead'))).toBe(true);
    for (const zone of direct.zones.slice(0, direct.zoneCount)) {
      expect(zone.remainingS).toBeGreaterThan(0);
      expect(zone.remainingS).toBeLessThan(10);
    }
    // Half a tick before `current`: half a tick back along the velocity.
    const mine = live.find((p) => PROJECTILE_KINDS[p.kind] === 'staticMine');
    const drawn = direct.projectiles
      .slice(0, direct.projectileCount)
      .find((p) => p.kind === 'staticMine');
    if (mine === undefined || drawn === undefined) throw new Error('no mine');
    expect(drawn.position.z).toBeCloseTo(mine.position.z - mine.velocity.z * 0.5 * TICK_DT_S, 6);

    for (const view of [direct, viaWorker]) {
      const local = view.local;
      expect(local.valid).toBe(true);
      // The Tempest spent its ultimate and one of two mines.
      expect(local.ultimateCharge).toBe(0);
      expect(local.charges[1]).toBe(1);
      expect(local.maxCharges[1]).toBe(2);
      expect(local.ready[1]).toBe(true);
      expect(local.ready[3]).toBe(false);
      expect(local.cooldowns[0]).toBe(0);
      expect(local.respawnInS).toBe(0);
    }
    // A spectator has no local combat view.
    const spectator = createWorldView();
    appendHostEffects(spectator, current, 1, { localDragonId: NO_PLAYER });
    expect(spectator.local.valid).toBe(false);
  });
});

// --- End to end ------------------------------------------------------------------------------------

let sharedWorld: MatchWorld | null = null;
function greybox(): MatchWorld {
  sharedWorld ??= createGreyboxMatchWorld();
  return sharedWorld;
}

/** Host (talon) + tempest, bastion and wraith clients. */
function room(world: boolean): Rig {
  const rig = createRoom(3, world ? { createMatchWorld: () => greybox() } : {});
  const [a, b, c] = rig.clients;
  if (a === undefined || b === undefined || c === undefined) throw new Error('no clients');
  a.session.sendIntent({ type: 'lobby.pickClass', classId: 'tempest' });
  b.session.sendIntent({ type: 'lobby.pickClass', classId: 'bastion' });
  c.session.sendIntent({ type: 'lobby.pickClass', classId: 'wraith' });
  rig.host.applyIntent({ type: 'host.setTeamSize', teamSize: 2 });
  rig.run(300);
  return rig;
}

interface PredictionResult {
  maxError: number;
  compared: number;
  casts: number[];
  largestCorrection: number[];
}

/** Flies `ticks` and compares every client's predicted position per tick with the host's. */
function measurePrediction(rig: Rig, ticks: number, settleTicks: number): PredictionResult {
  const sim = rig.host.sim;
  if (sim === null) throw new Error('no match');
  const ids = rig.clients.map((c) => c.session.localPlayerId);
  const predicted: Map<number, { x: number; y: number; z: number }>[] = ids.map(() => new Map());
  const casts = ids.map(() => 0);
  const settleTick = rig.host.hostTick + settleTicks;
  let maxError = 0;
  let compared = 0;
  rig.onClientTick = (client, index, tick) => {
    const predictor = client.session.predictor;
    if (!predictor.active) return;
    const p = predictor.dragon.position;
    predicted[index]?.set(tick, { x: p.x, y: p.y, z: p.z });
    predicted[index]?.delete(tick - 300);
    if (predictor.castStarted !== 0) casts[index] = (casts[index] ?? 0) + 1;
  };
  rig.onHostTick = (tick) => {
    ids.forEach((id, i) => {
      const dragon = sim.getDragon(id);
      const mine = predicted[i]?.get(tick);
      if (dragon === undefined || mine === undefined || tick < settleTick) return;
      const error = Math.hypot(
        mine.x - dragon.position.x,
        mine.y - dragon.position.y,
        mine.z - dragon.position.z,
      );
      if (error > maxError) maxError = error;
      compared++;
    });
  };
  rig.runTicks(ticks);
  rig.onClientTick = null;
  rig.onHostTick = null;
  return {
    maxError,
    compared,
    casts,
    largestCorrection: rig.clients.map((c) => c.session.predictor.largestCorrectionM),
  };
}

describe('end to end on a clean link', () => {
  it('prediction stays exact while riders use the abilities that move them', () => {
    for (const world of [false, true]) {
      const rig = room(world);
      // Updraft; shield + rally; veil + phase dive; (host) dash + afterburn. Nothing here pushes
      // or slows ANOTHER dragon, so every client can know its own flight in advance.
      const [tempest, bastion, wraith] = rig.clients;
      if (tempest === undefined || bastion === undefined || wraith === undefined) throw new Error();
      tempest.pilot.abilityButtons = BUTTON_UTILITY;
      bastion.pilot.abilityButtons = BUTTON_SECONDARY | BUTTON_UTILITY;
      wraith.pilot.abilityButtons = BUTTON_SECONDARY | BUTTON_UTILITY;
      rig.hostPilot.abilityButtons = BUTTON_SECONDARY | BUTTON_UTILITY;
      startMatch(rig);
      const result = measurePrediction(rig, 900, 45);
      expect(result.compared).toBeGreaterThan(3 * 800);
      // Every client really cast, several times.
      for (const count of result.casts) expect(count).toBeGreaterThanOrEqual(3);
      expect(result.maxError).toBeLessThan(0.01);
      for (const correction of result.largestCorrection) expect(correction).toBeLessThan(0.01);
      rig.dispose();
    }
  });

  it('a real fight reaches every client: events, bolts, zones, the HUD state, the storm wall', () => {
    const hostEvents: GameEvent[] = [];
    const clientEvents: GameEvent[][] = [[], [], []];
    const rig = createRoom(0, {
      host: { events: { emit: (event) => void hostEvents.push(structuredClone(event)) } },
    });
    const classes = ['tempest', 'bastion', 'wraith'] as const;
    for (let i = 0; i < 3; i++) {
      const log = clientEvents[i] ?? [];
      const client = rig.join(`Rider ${i + 1}`, {
        events: { emit: (event) => void log.push(structuredClone(event)) },
      });
      client.session.sendIntent({ type: 'lobby.pickClass', classId: classes[i] ?? 'talon' });
    }
    rig.host.applyIntent({ type: 'host.setTeamSize', teamSize: 2 });
    rig.run(300);
    const all = BUTTON_PRIMARY | BUTTON_SECONDARY | BUTTON_UTILITY | BUTTON_ULTIMATE;
    rig.hostPilot.abilityButtons = all;
    for (const client of rig.clients) client.pilot.abilityButtons = all;
    startMatch(rig);
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no match');
    // Everybody has an ultimate to use.
    for (const dragon of sim.current.dragons) if (dragon.active) dragon.ultCharge = 1;
    sim.setStormRadius(650);

    let mostBolts = 0;
    let mostSlow = 0;
    let mostZones = 0;
    let localValid = 0;
    let sawCooldown = false;
    let stormRadius = 0;
    rig.onClientFrame = (client) => {
      const view = client.view;
      let bolts = 0;
      let slow = 0;
      for (let i = 0; i < view.projectileCount; i++) {
        if (view.projectiles[i]?.kind === 'fireBolt') bolts++;
        else slow++;
      }
      mostBolts = Math.max(mostBolts, bolts);
      mostSlow = Math.max(mostSlow, slow);
      let zones = 0;
      for (let i = 0; i < view.zoneCount; i++) {
        const zone = view.zones[i];
        if (zone !== undefined && zone.kind !== 'stormWall') zones++;
      }
      mostZones = Math.max(mostZones, zones);
      if (view.local.valid) {
        localValid++;
        if (view.local.cooldowns.some((c) => c > 0)) sawCooldown = true;
      }
      stormRadius = client.session.sample.stormRadius;
    };
    rig.runTicks(20 * 30);
    rig.onClientFrame = null;
    rig.run(300);

    // The reliable channel carried every event to every client, in order.
    const key = (event: GameEvent): string => `${event.type}@${event.tick}`;
    expect(hostEvents.length).toBeGreaterThan(100);
    for (const log of clientEvents) expect(log.map(key)).toEqual(hostEvents.map(key));
    const types = new Set(hostEvents.map((event) => event.type));
    for (const type of ['abilityCast', 'statusApplied', 'spawn', 'matchPhase']) {
      expect(types.has(type as GameEvent['type']), type).toBe(true);
    }
    // The host's own bolts (it is the only Talon) flew on the clients.
    expect(mostBolts).toBeGreaterThan(0);
    expect(mostZones).toBeGreaterThan(0);
    expect(mostSlow).toBeGreaterThan(0);
    expect(localValid).toBeGreaterThan(1000);
    expect(sawCooldown).toBe(true);
    expect(stormRadius).toBeCloseTo(650, 1);
    // The riders' aim reached the host with their inputs.
    for (const client of rig.clients) {
      const dragon = sim.getDragon(client.session.localPlayerId);
      expect((dragon?.prevButtons ?? 0) & BUTTON_AIM).toBe(BUTTON_AIM);
      expect(dragon?.aimYaw).not.toBe(0);
      // The pilot aims within 0.2 rad of its nose (the difference may wrap at +-PI).
      const off = (dragon?.aimYaw ?? 0) - (dragon?.yaw ?? 9);
      expect(Math.abs(Math.atan2(Math.sin(off), Math.cos(off)))).toBeLessThan(0.6);
    }
    // Nobody fell out of step for good: every client still predicts its dragon.
    for (const client of rig.clients) {
      expect(client.session.predictor.active).toBe(true);
      expect(client.session.status).toBe('connected');
    }
    expect(rig.host.matchClock.scoreEmber + rig.host.matchClock.scoreFrost).toBe(
      (sim.current.teamTakedowns[0] ?? 0) + (sim.current.teamTakedowns[1] ?? 0),
    );
    rig.dispose();
  });

  it("a client rider's own bolts are drawn at once and not a second time from the echo", () => {
    const rig = createRoom(1);
    const client = rig.clients[0];
    if (client === undefined) throw new Error('no client');
    // The client keeps the default class: a Talon.
    startMatch(rig);
    rig.runTicks(30);
    let most = 0;
    let frames = 0;
    client.pilot.abilityButtons = BUTTON_PRIMARY;
    rig.onClientFrame = (c) => {
      frames++;
      most = Math.max(most, c.session.bolts.count);
    };
    rig.runTicks(120);
    rig.onClientFrame = null;
    expect(frames).toBeGreaterThan(100);
    // About 1.1 s of life at one bolt per 6 ticks: at most 6 in the air. Twice that would be
    // the echo drawn on top.
    const perSecond = 30 / secondsToTicks(ABILITY_TABLE.talon.primary.cooldownS);
    const atOnce = Math.ceil(perSecond * PROJECTILE_DEFS.fireBolt.lifeS);
    expect(most).toBeGreaterThanOrEqual(2);
    expect(most).toBeLessThanOrEqual(atOnce + 1);
    rig.dispose();
  });
});
