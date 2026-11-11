import { describe, expect, it } from 'vitest';
import {
  ABILITY_SLOTS,
  BUTTON_BOOST,
  BUTTON_MASK,
  BUTTON_PRIMARY,
  BUTTON_ULTIMATE,
  CLASS_TUNING,
  DAMAGE_SOURCES,
  DRAGON_ANIM_CLIPS,
  DRAGON_ANIM_DEATH_FALL,
  DRAGON_CLASS_IDS,
  DRAGON_CLASSES,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_IN_STORM,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  FLIGHT_TUNING,
  NO_PLAYER,
  OBJECTIVE_KINDS,
  PROJECTILE_KINDS,
  ZONE_KINDS,
  acquireDragonView,
  beginWorldView,
  createGameEventBus,
  createInputFrame,
  createWorldView,
  findDragonView,
  hasButton,
  resetInputFrame,
  sanitizeInputFrame,
} from '../../src/shared';
import type { AbilityCastEvent, GameEvent, HitEvent, WorldView } from '../../src/shared';

const takedown: GameEvent = {
  type: 'takedown',
  tick: 7,
  killerId: 1,
  victimId: 2,
  source: 'primary',
  position: { x: 0, y: 0, z: 0 },
};
const phase: GameEvent = { type: 'matchPhase', tick: 8, phase: 'playing', round: 1, winner: null };

describe('InputFrame', () => {
  it('resets in place for reuse', () => {
    const frame = createInputFrame();
    frame.steerX = 0.5;
    frame.buttons = BUTTON_BOOST | BUTTON_PRIMARY;
    expect(hasButton(frame, BUTTON_BOOST)).toBe(true);
    expect(resetInputFrame(frame, 42)).toBe(frame);
    expect(frame).toEqual({ tick: 42, steerX: 0, steerY: 0, buttons: 0 });
  });

  it('sanitizes out-of-range and NaN input', () => {
    const frame = createInputFrame();
    frame.steerX = 9;
    frame.steerY = Number.NaN;
    frame.buttons = 0xffff;
    sanitizeInputFrame(frame);
    expect(frame.steerX).toBe(1);
    expect(frame.steerY).toBe(0);
    expect(frame.buttons).toBe(BUTTON_MASK);
    frame.steerX = -Infinity;
    expect(sanitizeInputFrame(frame).steerX).toBe(-1);
  });

  it('fits the button mask in a u16', () => {
    expect(BUTTON_MASK & BUTTON_ULTIMATE).toBe(BUTTON_ULTIMATE);
    expect(BUTTON_MASK).toBeLessThanOrEqual(0xffff);
  });
});

describe('WorldView pool', () => {
  it('reuses dragon slots across frames', () => {
    const view = createWorldView();
    const first = acquireDragonView(view);
    first.id = 3;
    acquireDragonView(view).id = 4;
    expect(view.dragonCount).toBe(2);

    const readOnly: WorldView = view;
    expect(findDragonView(readOnly, 4)?.id).toBe(4);
    expect(findDragonView(readOnly, 9)).toBeUndefined();

    beginWorldView(view);
    expect(view.dragonCount).toBe(0);
    // A stale slot beyond the count must not be found.
    expect(findDragonView(readOnly, 3)).toBeUndefined();
    expect(acquireDragonView(view)).toBe(first);
    expect(view.dragons.length).toBe(2);
    expect(view.localDragonId).toBe(NO_PLAYER);
  });
});

describe('GameEventBus', () => {
  it('queues until flush and delivers by type in order', () => {
    const bus = createGameEventBus();
    const seen: string[] = [];
    bus.on('takedown', (e) => seen.push(`takedown:${e.victimId}`));
    bus.on('matchPhase', (e) => seen.push(`phase:${e.phase}`));
    bus.emit(takedown);
    bus.emit(phase);
    expect(seen).toEqual([]);
    expect(bus.pending).toBe(2);
    bus.flush();
    expect(seen).toEqual(['takedown:2', 'phase:playing']);
    expect(bus.pending).toBe(0);
    bus.flush();
    expect(seen.length).toBe(2);
  });

  it('stops delivering after unsubscribe and delivers events emitted by handlers', () => {
    const bus = createGameEventBus();
    let takedowns = 0;
    let phases = 0;
    const off = bus.on('takedown', () => {
      takedowns++;
      bus.emit(phase);
    });
    bus.on('matchPhase', () => phases++);
    bus.emit(takedown);
    bus.flush();
    expect([takedowns, phases]).toEqual([1, 1]);
    off();
    off();
    bus.emit(takedown);
    bus.flush();
    expect([takedowns, phases]).toEqual([1, 1]);
  });

  it('copies on emit, so one scratch event can be reused before the flush', () => {
    const bus = createGameEventBus();
    const position = { x: 1, y: 2, z: 3 };
    const scratch = {
      type: 'hit' as const,
      tick: 1,
      attackerId: 1,
      targetId: 2,
      source: 'primary' as const,
      damage: 10,
      position,
    };
    const seen: string[] = [];
    bus.on('hit', (e) => seen.push(`${e.tick}:${e.targetId}:${e.damage}:${e.position.x}`));

    bus.emit(scratch);
    // Two targets in one flame cone, then the next sim tick, all before one rendered frame.
    scratch.targetId = 3;
    scratch.damage = 20;
    position.x = 7;
    bus.emit(scratch);
    scratch.tick = 2;
    scratch.damage = 30;
    position.x = 9;
    bus.emit(scratch);
    scratch.damage = 99;
    position.x = 99;

    bus.flush();
    expect(seen).toEqual(['1:2:10:1', '1:3:20:7', '2:3:30:9']);
  });

  it('copies every vector of an event', () => {
    const bus = createGameEventBus();
    const direction = { x: 0, y: 0, z: 1 };
    const cast: AbilityCastEvent = {
      type: 'abilityCast',
      tick: 3,
      dragonId: 4,
      classId: 'tempest',
      slot: 'ultimate',
      position: { x: 1, y: 1, z: 1 },
      direction,
    };
    let received: AbilityCastEvent | undefined;
    bus.on('abilityCast', (e) => {
      received = { ...e, position: { ...e.position }, direction: { ...e.direction } };
    });
    bus.emit(cast);
    direction.z = -1;
    bus.flush();
    expect(received).toEqual({ ...cast, direction: { x: 0, y: 0, z: 1 } });
  });

  it('recycles its event slots after a flush instead of allocating new ones', () => {
    const bus = createGameEventBus();
    const delivered: HitEvent[] = [];
    bus.on('hit', (e) => delivered.push(e));
    const hit: HitEvent = {
      type: 'hit',
      tick: 1,
      attackerId: 1,
      targetId: 2,
      source: 'storm',
      damage: 5,
      position: { x: 0, y: 0, z: 0 },
    };
    bus.emit(hit);
    bus.emit(hit);
    bus.flush();
    bus.emit(hit);
    bus.clear();
    bus.emit(hit);
    bus.emit(hit);
    bus.flush();
    expect(delivered).toHaveLength(4);
    expect(delivered[0]).not.toBe(hit);
    expect(delivered[0]).not.toBe(delivered[1]);
    expect(delivered[2]).toBe(delivered[0]);
    expect(delivered[3]).toBe(delivered[1]);
    expect(delivered[2]?.position).toBe(delivered[0]?.position);
  });

  it('keeps the event being delivered intact when a handler emits or clears', () => {
    const bus = createGameEventBus();
    const seen: number[] = [];
    bus.on('takedown', (e) => {
      if (e.victimId === 2) {
        bus.clear();
        bus.emit({ ...takedown, victimId: 5 });
      }
    });
    bus.on('takedown', (e) => seen.push(e.victimId));
    bus.emit(takedown);
    bus.flush();
    expect(seen).toEqual([2, 5]);
  });

  it('clear drops queued events', () => {
    const bus = createGameEventBus();
    let count = 0;
    bus.on('takedown', () => count++);
    bus.emit(takedown);
    bus.clear();
    bus.flush();
    expect(count).toBe(0);
  });
});

describe('classes and tuning', () => {
  it('has info and tuning for every class', () => {
    expect(DRAGON_CLASS_IDS).toHaveLength(4);
    for (const id of DRAGON_CLASS_IDS) {
      expect(DRAGON_CLASSES[id].id).toBe(id);
      expect(CLASS_TUNING[id].maxHp).toBeGreaterThan(0);
    }
  });

  it('keeps the HP and speed ordering from GAME_DESIGN.md', () => {
    const { talon, bastion, tempest, wraith } = CLASS_TUNING;
    expect(talon.maxHp).toBeLessThan(wraith.maxHp);
    expect(wraith.maxHp).toBeLessThan(tempest.maxHp);
    expect(tempest.maxHp).toBeLessThan(bastion.maxHp);
    expect(bastion.speedScale).toBeLessThan(tempest.speedScale);
    expect(tempest.speedScale).toBeLessThan(talon.speedScale);
    expect(wraith.diveSpeedScale).toBeGreaterThan(1);
  });

  it('uses the flight speeds from GAME_DESIGN.md', () => {
    expect(FLIGHT_TUNING.stallSpeed).toBe(25);
    expect(FLIGHT_TUNING.cruiseSpeed).toBe(45);
    expect(FLIGHT_TUNING.maxSpeed).toBe(95);
    expect(FLIGHT_TUNING.dodgeImmunityS).toBe(0.25);
    expect(FLIGHT_TUNING.dodgeCooldownS).toBe(4);
  });

  it('fits the dragon flags in the snapshot u16, one bit each', () => {
    const flags = [
      DRAGON_FLAG_ALIVE,
      DRAGON_FLAG_BOOSTING,
      DRAGON_FLAG_DODGING,
      DRAGON_FLAG_SPAWN_PROTECTED,
      DRAGON_FLAG_SHIELDED,
      DRAGON_FLAG_VEILED,
      DRAGON_FLAG_PHASING,
      DRAGON_FLAG_IN_STORM,
    ];
    let mask = 0;
    for (const flag of flags) {
      // A power of two that no earlier flag uses.
      expect(flag & (flag - 1)).toBe(0);
      expect(mask & flag).toBe(0);
      mask |= flag;
    }
    expect(mask).toBeLessThanOrEqual(0xffff);
  });

  it('has a u8 wire table without duplicates for every kind that crosses the network', () => {
    for (const table of [DAMAGE_SOURCES, OBJECTIVE_KINDS, PROJECTILE_KINDS, ZONE_KINDS]) {
      expect(table.length).toBeGreaterThan(0);
      expect(table.length).toBeLessThanOrEqual(256);
      expect(new Set<string>(table).size).toBe(table.length);
    }
    // Ability damage is encoded as the ability's slot index.
    expect(DAMAGE_SOURCES.slice(0, ABILITY_SLOTS.length)).toEqual(ABILITY_SLOTS);
  });

  it('keeps animation state constants aligned with the clip list', () => {
    expect(DRAGON_ANIM_CLIPS[DRAGON_ANIM_DEATH_FALL]).toBe('death_fall');
    expect(DRAGON_ANIM_CLIPS.length).toBeLessThanOrEqual(256);
  });
});
