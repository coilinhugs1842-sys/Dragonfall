/**
 * Combat (T-3.1 / T-3.2): the damage pipeline, the ability executors, statuses, takedown and
 * assist credit, respawns, the pools, determinism and robustness. Everything runs through
 * `Sim.step`, i.e. the code the host runs.
 */

import { describe, expect, it } from 'vitest';
import {
  ABILITY_SLOTS,
  ABILITY_TABLE,
  ABILITY_TAG_ALLIES,
  ABILITY_TAG_ATTACK,
  BUTTON_ABILITY_MASK,
  BUTTON_AIM,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_ULTIMATE,
  BUTTON_UTILITY,
  CLASS_TUNING,
  COMBAT_TUNING,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BLINDED,
  DRAGON_FLAG_BURNING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_HASTED,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_REGEN,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SLOWED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  MATCH_TUNING,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  MAX_ZONES,
  NO_PLAYER,
  PROJECTILE_DEFS,
  PROJECTILE_KINDS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
  ZONE_DEFS,
  ZONE_KINDS,
  createGameEventBus,
  createInputFrame,
  createSeededRandom,
} from '../../src/shared';
import type {
  AbilityTable,
  BoxSolid,
  DragonClassId,
  GameEvent,
  GameEventOf,
  GameEventType,
  InputFrame,
  MapSolid,
  ProjectileDef,
  ProjectileKind,
  TeamId,
  ZoneKind,
} from '../../src/shared';
import {
  DAMAGE_IGNORE_IMMUNITY,
  DAMAGE_IGNORE_TEAM,
  createSim,
  resolveFireDirection,
  secondsToTicks,
} from '../../src/sim';
import type { DragonState, Sim, SimOptions, TargetPositionSource } from '../../src/sim';
import { createMapCollisionWorld } from '../../src/sim/collision';
import type { CollisionMapSource } from '../../src/sim/collision';

// --- Rig -------------------------------------------------------------------------------------------

interface Rig {
  readonly sim: Sim;
  readonly events: GameEvent[];
  readonly inputs: InputFrame[];
  tick: number;
  add(
    id: number,
    team: TeamId,
    classId: DragonClassId,
    x: number,
    z: number,
    yaw?: number,
  ): DragonState;
  dragon(id: number): DragonState;
  /** Steps `ticks` ticks with the current inputs. */
  step(ticks?: number): void;
  /** Holds `buttons` on player `id` for `ticks` ticks, then releases them. */
  hold(id: number, buttons: number, ticks: number): void;
  eventsOf<T extends GameEventType>(type: T): GameEventOf<T>[];
}

const ALTITUDE = 300;

function makeRig(options: SimOptions & { spawnProtectionS?: number } = {}): Rig {
  const events: GameEvent[] = [];
  const sim = createSim({
    matchTuning: { ...MATCH_TUNING, spawnProtectionS: options.spawnProtectionS ?? 0 },
    events: { emit: (event) => void events.push(structuredClone(event)) },
    ...options,
  });
  const inputs: InputFrame[] = [];
  const rig: Rig = {
    sim,
    events,
    inputs,
    tick: 0,
    add(id, team, classId, x, z, yaw = 0) {
      const dragon = sim.spawnDragon(id, team, classId, { x, y: ALTITUDE, z }, yaw);
      if (dragon === null) throw new Error('no free slot');
      inputs[id] = createInputFrame();
      return dragon;
    },
    dragon(id) {
      const dragon = sim.getDragon(id);
      if (dragon === undefined) throw new Error(`player ${id} has no dragon`);
      return dragon;
    },
    step(ticks = 1) {
      for (let i = 0; i < ticks; i++) {
        for (const input of inputs) if (input !== undefined) input.tick = rig.tick;
        sim.step(rig.tick++, inputs);
      }
    },
    hold(id, buttons, ticks) {
      const input = inputs[id];
      if (input === undefined) throw new Error('no input');
      input.buttons |= buttons;
      rig.step(ticks);
      input.buttons &= ~buttons;
    },
    eventsOf<T extends GameEventType>(type: T): GameEventOf<T>[] {
      return events.filter((event): event is GameEventOf<T> => event.type === type);
    },
  };
  return rig;
}

function has(dragon: DragonState, flag: number): boolean {
  return (dragon.flags & flag) !== 0;
}

function lost(dragon: DragonState): number {
  return dragon.maxHealth - dragon.health;
}

function box(x: number, y: number, z: number, sx: number, sy: number, sz: number): BoxSolid {
  return {
    kind: 'box',
    role: 'stone',
    position: { x, y, z },
    yaw: 0,
    pitch: 0,
    roll: 0,
    size: { x: sx, y: sy, z: sz },
  };
}

function makeMap(solids: readonly MapSolid[]): CollisionMapSource {
  return {
    size: 4000,
    solids,
    chunkSize: 250,
    colliders: {
      stormCenter: { x: 0, y: 0, z: 0 },
      stormRadius: 3000,
      ceilingY: 2000,
      floorY: -500,
    },
  };
}

function zoneCountOf(sim: Sim, kind: ZoneKind): number {
  const index = ZONE_KINDS.indexOf(kind);
  return sim.current.zones.filter((zone) => zone.active && zone.kind === index).length;
}

function projectileCountOf(sim: Sim, kind: ProjectileKind): number {
  const index = PROJECTILE_KINDS.indexOf(kind);
  return sim.current.projectiles.filter((p) => p.active && p.kind === index).length;
}

const ticksOf = secondsToTicks;

// --- The damage pipeline ---------------------------------------------------------------------------

describe('damage pipeline', () => {
  function duel(friendlyFire = false): Rig {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 60);
    rig.add(2, TEAM_EMBER, 'tempest', 40, 0);
    rig.sim.rules.friendlyFire = friendlyFire;
    rig.step();
    return rig;
  }

  it('removes HP, emits a hit event and remembers the attacker', () => {
    const rig = duel();
    expect(rig.sim.applyDamage(1, 30, 0, 'primary')).toBe(30);
    const target = rig.dragon(1);
    expect(lost(target)).toBe(30);
    expect(target.lastDamagerId).toBe(0);
    expect(target.hitTicks).toBeGreaterThan(0);
    const hits = rig.eventsOf('hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ attackerId: 0, targetId: 1, source: 'primary', damage: 30 });
    expect(rig.sim.current.scores[0]?.damage).toBe(30);
  });

  it('ignores zero, negative and NaN amounts and targets that are not there', () => {
    const rig = duel();
    expect(rig.sim.applyDamage(1, 0, 0, 'primary')).toBe(0);
    expect(rig.sim.applyDamage(1, -5, 0, 'primary')).toBe(0);
    expect(rig.sim.applyDamage(1, Number.NaN, 0, 'primary')).toBe(0);
    expect(rig.sim.applyDamage(9, 10, 0, 'primary')).toBe(0);
    expect(rig.events).toHaveLength(0);
  });

  it('never hurts the caster itself', () => {
    const rig = duel();
    expect(rig.sim.applyDamage(0, 30, 0, 'primary')).toBe(0);
  });

  it('is stopped by dodge immunity and spawn protection, unless told to ignore them', () => {
    const rig = duel();
    rig.dragon(1).dodgeImmunityTicks = 3;
    expect(rig.sim.applyDamage(1, 30, 0, 'primary')).toBe(0);
    expect(rig.sim.applyDamage(1, 30, 0, 'primary', DAMAGE_IGNORE_IMMUNITY)).toBe(30);
    rig.dragon(1).dodgeImmunityTicks = 0;
    rig.dragon(1).spawnProtectTicks = 10;
    expect(rig.sim.applyDamage(1, 30, 0, 'primary')).toBe(0);
    rig.dragon(1).spawnProtectTicks = 0;
    expect(rig.sim.applyDamage(1, 30, 0, 'primary')).toBe(30);
  });

  it('cannot touch a phasing dragon', () => {
    const rig = duel();
    rig.dragon(1).phaseTicks = 5;
    expect(rig.sim.applyDamage(1, 30, 0, 'primary')).toBe(0);
    expect(rig.sim.applyStatus(1, 'slow', 2, 0.5, 0)).toBe(false);
  });

  it('is blocked by a wing shield from the front and not from behind', () => {
    const rig = duel();
    const target = rig.dragon(1);
    target.shieldTicks = 60;
    const p = target.position;
    // The target faces +Z.
    const front = { x: p.x, y: p.y, z: p.z + 50 };
    const behind = { x: p.x, y: p.y, z: p.z - 50 };
    const side = { x: p.x + 50, y: p.y, z: p.z };
    const edge = COMBAT_TUNING.shieldHalfAngle;
    const inside = {
      x: p.x + Math.sin(edge - 0.05) * 50,
      y: p.y,
      z: p.z + Math.cos(edge - 0.05) * 50,
    };
    const outside = {
      x: p.x + Math.sin(edge + 0.05) * 50,
      y: p.y,
      z: p.z + Math.cos(edge + 0.05) * 50,
    };
    expect(rig.sim.applyDamage(1, 20, 0, 'primary', 0, front)).toBe(0);
    expect(rig.sim.applyDamage(1, 20, 0, 'primary', 0, inside)).toBe(0);
    expect(rig.sim.applyDamage(1, 20, 0, 'primary', 0, outside)).toBe(20);
    expect(rig.sim.applyDamage(1, 20, 0, 'primary', 0, side)).toBe(20);
    expect(rig.sim.applyDamage(1, 20, 0, 'primary', 0, behind)).toBe(20);
  });

  it('respects the friendly fire setting', () => {
    const off = duel(false);
    expect(off.sim.applyDamage(2, 30, 0, 'primary')).toBe(0);
    expect(off.sim.applyStatus(2, 'burn', 2, 5, 0)).toBe(false);
    // Mode-dealt damage may ignore the rule.
    expect(off.sim.applyDamage(2, 30, 0, 'primary', DAMAGE_IGNORE_TEAM)).toBe(30);

    const on = duel(true);
    expect(on.sim.applyDamage(2, 30, 0, 'primary')).toBe(30 * COMBAT_TUNING.friendlyFireScale);
    // Hurting a teammate earns nothing.
    expect(on.sim.current.scores[0]?.damage).toBe(0);
    expect(on.dragon(0).ultCharge).toBe(0);
  });

  it('caps at the health left and flags death at once', () => {
    const rig = duel();
    const target = rig.dragon(1);
    expect(rig.sim.applyDamage(1, 1e9, 0, 'secondary')).toBe(target.maxHealth);
    expect(target.health).toBe(0);
    expect(has(target, DRAGON_FLAG_ALIVE)).toBe(false);
    expect(rig.sim.applyDamage(1, 10, 0, 'secondary')).toBe(0);
  });

  it('charges the attacker ultimate by damage dealt, but not with the ultimate itself', () => {
    const rig = duel();
    rig.sim.applyDamage(1, 45, 0, 'primary');
    expect(rig.dragon(0).ultCharge).toBeCloseTo(45 * COMBAT_TUNING.ultChargePerDamage, 10);
    const before = rig.dragon(0).ultCharge;
    rig.sim.applyDamage(1, 45, 0, 'ultimate');
    expect(rig.dragon(0).ultCharge).toBe(before);
    rig.sim.addUltimateCharge(0, 5);
    expect(rig.dragon(0).ultCharge).toBe(1);
  });
});

// --- Statuses --------------------------------------------------------------------------------------

describe('statuses', () => {
  it('burn deals damage over time and credits its source', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 500);
    rig.step();
    expect(rig.sim.applyStatus(1, 'burn', 3, 10, 0)).toBe(true);
    rig.step(1);
    expect(has(rig.dragon(1), DRAGON_FLAG_BURNING)).toBe(true);
    rig.step(ticksOf(3) + 20);
    const target = rig.dragon(1);
    expect(has(target, DRAGON_FLAG_BURNING)).toBe(false);
    // 3 s of 10 HP/s, applied in half-second steps: within one step of 30.
    expect(lost(target)).toBeGreaterThanOrEqual(25);
    expect(lost(target)).toBeLessThanOrEqual(30);
    const hits = rig.eventsOf('hit');
    expect(hits.length).toBeGreaterThanOrEqual(5);
    for (const hit of hits) expect(hit).toMatchObject({ attackerId: 0, targetId: 1 });
    expect(rig.eventsOf('statusApplied')).toHaveLength(1);
    expect(rig.eventsOf('statusApplied')[0]).toMatchObject({
      targetId: 1,
      sourceId: 0,
      status: 'burn',
    });
    // Damage over time shows no hit animation.
    expect(target.lastDamagerId).toBe(0);
  });

  it('a refreshed burn keeps ticking (the pulses do not restart with it)', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 500);
    rig.step();
    for (let i = 0; i < 60; i++) {
      rig.sim.applyStatus(1, 'burn', 1, 10, 0);
      rig.step();
    }
    expect(lost(rig.dragon(1))).toBeGreaterThanOrEqual(15);
    // Only the first application is an event.
    expect(rig.eventsOf('statusApplied')).toHaveLength(1);
  });

  it('regen heals over time up to max health', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'bastion', 0, 0);
    rig.step();
    const dragon = rig.dragon(0);
    dragon.health = dragon.maxHealth - 50;
    rig.sim.applyStatus(0, 'regen', 2, 12, NO_PLAYER);
    rig.step(2);
    expect(has(rig.dragon(0), DRAGON_FLAG_REGEN)).toBe(true);
    rig.step(ticksOf(2) + 20);
    const healed = 50 - lost(rig.dragon(0));
    expect(healed).toBeGreaterThanOrEqual(18);
    expect(healed).toBeLessThanOrEqual(24);
    rig.sim.applyStatus(0, 'regen', 60, 1000, NO_PLAYER);
    rig.step(40);
    expect(rig.dragon(0).health).toBe(rig.dragon(0).maxHealth);
  });

  it('slow lowers the speed a dragon settles at, haste raises it', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    rig.add(1, TEAM_EMBER, 'tempest', 200, 0);
    rig.add(2, TEAM_EMBER, 'tempest', 400, 0);
    rig.step();
    rig.sim.applyStatus(1, 'slow', 30, 0.6, NO_PLAYER);
    rig.sim.applyStatus(2, 'haste', 30, 1.4, NO_PLAYER);
    rig.step(10 * TICK_HZ);
    const normal = rig.dragon(0).speed;
    expect(has(rig.dragon(1), DRAGON_FLAG_SLOWED)).toBe(true);
    expect(has(rig.dragon(2), DRAGON_FLAG_HASTED)).toBe(true);
    expect(rig.dragon(1).speed).toBeLessThan(normal * 0.75);
    expect(rig.dragon(2).speed).toBeGreaterThan(normal * 1.3);
  });

  it('blind is a flag with a timer', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.add(1, TEAM_FROST, 'talon', 0, 500);
    rig.step();
    rig.sim.applyStatus(1, 'blind', 1, 0, 0);
    rig.step(5);
    expect(has(rig.dragon(1), DRAGON_FLAG_BLINDED)).toBe(true);
    rig.step(ticksOf(1));
    expect(has(rig.dragon(1), DRAGON_FLAG_BLINDED)).toBe(false);
  });
});

// --- Ability executors -----------------------------------------------------------------------------

describe('projectiles (Talon fire bolts)', () => {
  it('hits an enemy ahead, at the fire rate of the table', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(1, TEAM_FROST, 'talon', 0, 100);
    rig.hold(0, BUTTON_PRIMARY, 60);
    expect(has(rig.dragon(0), DRAGON_FLAG_FIRING)).toBe(true);
    const casts = rig.eventsOf('abilityCast');
    const interval = ticksOf(ABILITY_TABLE.talon.primary.cooldownS);
    expect(casts).toHaveLength(Math.ceil(60 / interval));
    for (const cast of casts) expect(cast).toMatchObject({ dragonId: 0, slot: 'primary' });
    const hits = rig.eventsOf('hit');
    expect(hits.length).toBeGreaterThanOrEqual(casts.length - 3);
    expect(lost(rig.dragon(1))).toBe(hits.length * ABILITY_TABLE.talon.primary.damage);
    expect(hits[0]).toMatchObject({ attackerId: 0, targetId: 1, source: 'primary' });
    rig.step(10);
    expect(has(rig.dragon(0), DRAGON_FLAG_FIRING)).toBe(false);
  });

  it('misses a target off to the side and does not hit teammates', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(1, TEAM_FROST, 'talon', 40, 100);
    rig.add(2, TEAM_EMBER, 'talon', 0, 60);
    rig.hold(0, BUTTON_PRIMARY, 60);
    rig.step(40);
    expect(lost(rig.dragon(1))).toBe(0);
    expect(lost(rig.dragon(2))).toBe(0);
    expect(rig.eventsOf('hit')).toHaveLength(0);
    // Every bolt flew its life out.
    expect(rig.sim.current.projectileCount).toBe(0);
  });

  it('hits teammates when friendly fire is on', () => {
    const rig = makeRig();
    rig.sim.rules.friendlyFire = true;
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(2, TEAM_EMBER, 'talon', 0, 60);
    rig.hold(0, BUTTON_PRIMARY, 30);
    expect(lost(rig.dragon(2))).toBeGreaterThan(0);
  });

  it('is stopped by terrain', () => {
    const fly = (solids: MapSolid[]): number => {
      const rig = makeRig({ collisionWorld: createMapCollisionWorld(makeMap(solids)) });
      rig.add(0, TEAM_EMBER, 'talon', 0, 0);
      // Head-on, so the range closes while both stay clear of the wall between them.
      rig.add(1, TEAM_FROST, 'talon', 0, 260, Math.PI);
      rig.hold(0, BUTTON_PRIMARY, 35);
      return lost(rig.dragon(1));
    };
    expect(fly([])).toBeGreaterThan(0);
    expect(fly([box(0, ALTITUDE, 90, 200, 200, 40)])).toBe(0);
  });

  it('follows the aim within the limit of the ability, and the nose without an aim', () => {
    const rig = makeRig();
    const dragon = rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    const out = { x: 0, y: 0, z: 0 };
    const limit = ABILITY_TABLE.talon.primary.aimLimit;
    rig.step();
    resolveFireDirection(dragon, limit, out);
    expect(out.z).toBeCloseTo(1, 6);

    const input = rig.inputs[0];
    if (input === undefined) throw new Error('no input');
    input.buttons = BUTTON_AIM;
    input.aimYaw = 0.1;
    input.aimPitch = 0.05;
    rig.step();
    resolveFireDirection(rig.dragon(0), limit, out);
    expect(Math.atan2(out.x, out.z)).toBeCloseTo(0.1, 6);
    expect(Math.asin(out.y)).toBeCloseTo(0.05, 6);

    // Far outside the window: clamped to its edge, on the aim's side.
    input.aimYaw = 2;
    input.aimPitch = 0;
    rig.step();
    resolveFireDirection(rig.dragon(0), limit, out);
    const nose = rig.dragon(0);
    const angle = Math.acos(
      out.x * Math.sin(nose.yaw) * Math.cos(nose.pitch) +
        out.y * Math.sin(nose.pitch) +
        out.z * Math.cos(nose.yaw) * Math.cos(nose.pitch),
    );
    expect(angle).toBeCloseTo(limit, 6);
    expect(out.x).toBeGreaterThan(0);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 9);
    // An ability with no aim window fires along the nose whatever the aim.
    resolveFireDirection(rig.dragon(0), 0, out);
    expect(out.x).toBeCloseTo(Math.sin(nose.yaw) * Math.cos(nose.pitch), 9);
  });

  it('a shot aimed at an off-axis target lands, the same shot unaimed does not', () => {
    const shoot = (aim: boolean): number => {
      const rig = makeRig();
      rig.add(0, TEAM_EMBER, 'talon', 0, 0);
      // Same class, same heading: it keeps its place 25 m to the side and 100 m ahead.
      rig.add(1, TEAM_FROST, 'talon', 25, 100);
      const input = rig.inputs[0];
      if (input === undefined) throw new Error('no input');
      if (aim) {
        // Lead it: in the shooter's frame the bolt flies at (speed * dir - own velocity), and
        // that has to point at the target. Solved by bisection on the aim angle.
        const bolt = PROJECTILE_DEFS.fireBolt.speed;
        const own = rig.dragon(0).speed;
        let low = 0;
        let high = ABILITY_TABLE.talon.primary.aimLimit;
        for (let i = 0; i < 40; i++) {
          const mid = (low + high) / 2;
          const side = bolt * Math.sin(mid) * 100 - (bolt * Math.cos(mid) - own) * 25;
          if (side < 0) low = mid;
          else high = mid;
        }
        input.buttons = BUTTON_AIM;
        input.aimYaw = (low + high) / 2;
      }
      rig.hold(0, BUTTON_PRIMARY, 40);
      return lost(rig.dragon(1));
    };
    expect(shoot(false)).toBe(0);
    expect(shoot(true)).toBeGreaterThan(0);
  });
});

describe('cone (Bastion flame cone)', () => {
  const def = ABILITY_TABLE.bastion.primary;

  function breathe(x: number, z: number, solids: MapSolid[] = []): Rig {
    const rig = makeRig(
      solids.length > 0 ? { collisionWorld: createMapCollisionWorld(makeMap(solids)) } : {},
    );
    rig.add(0, TEAM_EMBER, 'bastion', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', x, z);
    rig.hold(0, BUTTON_PRIMARY, 1);
    return rig;
  }

  it('hits inside the cone', () => {
    const rig = breathe(0, 30);
    expect(lost(rig.dragon(1))).toBe(def.damage);
    expect(rig.eventsOf('hit')[0]).toMatchObject({ attackerId: 0, targetId: 1, source: 'primary' });
  });

  it('misses outside the angle and beyond the range', () => {
    expect(lost(breathe(40, 30).dragon(1))).toBe(0);
    expect(lost(breathe(0, 80).dragon(1))).toBe(0);
    expect(lost(breathe(0, -30).dragon(1))).toBe(0);
  });

  it('needs a clear line: terrain between the two blocks it', () => {
    expect(lost(breathe(0, 30, [box(0, ALTITUDE, 15, 60, 60, 2)]).dragon(1))).toBe(0);
  });

  it('is sustained: one cast event for a held breath, damage at the tick rate', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'bastion', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 25);
    rig.hold(0, BUTTON_PRIMARY, 30);
    expect(rig.eventsOf('abilityCast')).toHaveLength(1);
    const pulses = Math.ceil(30 / ticksOf(def.cooldownS));
    expect(lost(rig.dragon(1))).toBeCloseTo(pulses * def.damage, 6);
    // Released and pressed again: a new cast.
    rig.step(15);
    rig.hold(0, BUTTON_PRIMARY, 3);
    expect(rig.eventsOf('abilityCast')).toHaveLength(2);
  });
});

describe('beam (Tempest lightning lance)', () => {
  const def = ABILITY_TABLE.tempest.primary;
  const windup = ticksOf(def.windupS);

  it('charges up, then hits the first enemy along the ray', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    rig.add(1, TEAM_FROST, 'tempest', 0, 200);
    rig.add(2, TEAM_FROST, 'tempest', 0, 300);
    rig.hold(0, BUTTON_PRIMARY, windup);
    expect(has(rig.dragon(0), DRAGON_FLAG_CHARGING)).toBe(true);
    expect(lost(rig.dragon(1))).toBe(0);
    expect(rig.eventsOf('abilityCast')).toHaveLength(0);
    rig.step(1);
    expect(has(rig.dragon(0), DRAGON_FLAG_CHARGING)).toBe(false);
    expect(lost(rig.dragon(1))).toBe(def.damage);
    expect(lost(rig.dragon(2))).toBe(0);
    expect(rig.eventsOf('abilityCast')).toHaveLength(1);
  });

  it('misses beside the ray, beyond the range, and behind terrain', () => {
    const fire = (x: number, z: number, solids: MapSolid[] = []): number => {
      const rig = makeRig(
        solids.length > 0 ? { collisionWorld: createMapCollisionWorld(makeMap(solids)) } : {},
      );
      rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
      rig.add(1, TEAM_FROST, 'tempest', x, z);
      rig.hold(0, BUTTON_PRIMARY, windup + 1);
      return lost(rig.dragon(1));
    };
    expect(fire(0, 200)).toBe(def.damage);
    expect(fire(15, 200)).toBe(0);
    expect(fire(0, def.range + 60)).toBe(0);
    expect(fire(0, 200, [box(0, ALTITUDE, 120, 100, 100, 10)])).toBe(0);
  });

  it('fires again only after its cooldown and a new charge', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 200);
    const cycle = windup + ticksOf(def.cooldownS);
    rig.hold(0, BUTTON_PRIMARY, cycle * 3 + 1);
    expect(rig.eventsOf('abilityCast')).toHaveLength(3);
  });
});

describe('dash and vertical burst', () => {
  it('Talon searing dash lunges and hurts what it touches, once', () => {
    const def = ABILITY_TABLE.talon.secondary;
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(1, TEAM_FROST, 'talon', 0, 10);
    rig.add(2, TEAM_FROST, 'talon', 0, 400);
    rig.step();
    const speedBefore = rig.dragon(0).speed;
    const gapBefore = rig.dragon(1).position.z - rig.dragon(0).position.z;
    rig.hold(0, BUTTON_SECONDARY, 1);
    expect(rig.dragon(0).speed).toBeGreaterThan(speedBefore + def.speedGain * 0.5);
    expect(rig.dragon(0).burst.z).toBeGreaterThan(def.impulseForward * 0.5);
    rig.step(ticksOf(def.durationS) + 5);
    // It really lunged past the dragon in front of it.
    expect(rig.dragon(1).position.z - rig.dragon(0).position.z).toBeLessThan(gapBefore - 10);
    expect(lost(rig.dragon(1))).toBe(def.damage);
    expect(lost(rig.dragon(2))).toBe(0);
    expect(rig.eventsOf('hit')).toHaveLength(1);
    expect(rig.eventsOf('hit')[0]).toMatchObject({ source: 'secondary', attackerId: 0 });
    // On cooldown: a second press does nothing.
    rig.hold(0, BUTTON_SECONDARY, 1);
    expect(rig.eventsOf('abilityCast')).toHaveLength(1);
    expect(rig.dragon(0).abilityCooldownTicks[1]).toBeGreaterThan(0);
    rig.step(ticksOf(def.cooldownS));
    rig.hold(0, BUTTON_SECONDARY, 1);
    expect(rig.eventsOf('abilityCast')).toHaveLength(2);
  });

  it('Talon searing dash still hits once when other abilities fire during it', () => {
    const def = ABILITY_TABLE.talon.secondary;
    // Every phase of the bolt cooldown against the dash window, with Afterburn on top.
    for (let lead = 0; lead <= ticksOf(ABILITY_TABLE.talon.primary.cooldownS) + 1; lead++) {
      const rig = makeRig();
      rig.add(0, TEAM_EMBER, 'talon', 0, 0);
      rig.add(1, TEAM_FROST, 'bastion', 0, 14);
      rig.step();
      const input = rig.inputs[0];
      if (input === undefined) throw new Error('no input');
      input.buttons |= BUTTON_PRIMARY;
      rig.step(lead);
      input.buttons |= BUTTON_SECONDARY;
      rig.step(2);
      input.buttons |= BUTTON_UTILITY;
      rig.step(ticksOf(def.durationS) + 5);
      const dashHits = rig.eventsOf('hit').filter((hit) => hit.source === 'secondary');
      expect(dashHits, `lead ${lead}`).toHaveLength(1);
      expect(dashHits[0]?.damage).toBe(def.damage);
    }
  });

  it('a held button does not repeat an ability that needs a press', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.hold(0, BUTTON_SECONDARY, ticksOf(ABILITY_TABLE.talon.secondary.cooldownS) + 30);
    expect(rig.eventsOf('abilityCast')).toHaveLength(1);
  });

  it('Tempest updraft throws the dragon upward', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    rig.add(1, TEAM_EMBER, 'tempest', 300, 0);
    rig.step();
    rig.hold(0, BUTTON_UTILITY, 1);
    rig.step(20);
    expect(rig.dragon(0).position.y - rig.dragon(1).position.y).toBeGreaterThan(8);
  });
});

describe('self buffs', () => {
  it('Bastion wing shield comes up after its wind-up and blocks frontal bolts', () => {
    const def = ABILITY_TABLE.bastion.secondary;
    const rig = makeRig();
    // Facing each other.
    rig.add(0, TEAM_EMBER, 'bastion', 0, 0);
    rig.add(1, TEAM_FROST, 'talon', 0, 300, Math.PI);
    rig.hold(0, BUTTON_SECONDARY, 1);
    expect(has(rig.dragon(0), DRAGON_FLAG_CHARGING)).toBe(true);
    expect(has(rig.dragon(0), DRAGON_FLAG_SHIELDED)).toBe(false);
    rig.step(ticksOf(def.windupS));
    expect(has(rig.dragon(0), DRAGON_FLAG_SHIELDED)).toBe(true);
    expect(rig.eventsOf('statusApplied')[0]).toMatchObject({ targetId: 0, status: 'shield' });
    rig.hold(1, BUTTON_PRIMARY, 45);
    expect(lost(rig.dragon(0))).toBe(0);
    // The shield runs out; the next bolts land.
    rig.step(ticksOf(def.durationS));
    expect(has(rig.dragon(0), DRAGON_FLAG_SHIELDED)).toBe(false);
  });

  it('a shield does not cover the back', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'bastion', 0, 100);
    rig.add(1, TEAM_FROST, 'talon', 0, 0);
    rig.dragon(0).shieldTicks = 300;
    rig.hold(1, BUTTON_PRIMARY, 45);
    expect(lost(rig.dragon(0))).toBeGreaterThan(0);
  });

  it('Wraith veil hides it until it attacks', () => {
    const def = ABILITY_TABLE.wraith.secondary;
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.hold(0, BUTTON_SECONDARY, 1);
    rig.step(ticksOf(def.windupS));
    expect(has(rig.dragon(0), DRAGON_FLAG_VEILED)).toBe(true);
    rig.step(30);
    expect(has(rig.dragon(0), DRAGON_FLAG_VEILED)).toBe(true);
    rig.hold(0, BUTTON_PRIMARY, 1);
    expect(has(rig.dragon(0), DRAGON_FLAG_VEILED)).toBe(false);
    // And it runs out by itself.
    rig.step(ticksOf(def.cooldownS));
    rig.hold(0, BUTTON_SECONDARY, 1);
    rig.step(ticksOf(def.windupS));
    expect(has(rig.dragon(0), DRAGON_FLAG_VEILED)).toBe(true);
    rig.step(ticksOf(def.durationS));
    expect(has(rig.dragon(0), DRAGON_FLAG_VEILED)).toBe(false);
  });

  it('Wraith phase dive passes through terrain for its duration and comes out clear', () => {
    const def = ABILITY_TABLE.wraith.utility;
    const wall = box(0, ALTITUDE, 60, 400, 400, 16);
    const fly = (phase: boolean): DragonState => {
      const world = createMapCollisionWorld(makeMap([wall]));
      const rig = makeRig({ collisionWorld: world });
      rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
      if (phase) rig.hold(0, BUTTON_UTILITY, 1);
      rig.step(ticksOf(def.windupS) + 1);
      if (phase) expect(has(rig.dragon(0), DRAGON_FLAG_PHASING)).toBe(true);
      rig.step(ticksOf(def.durationS) + 20);
      expect(has(rig.dragon(0), DRAGON_FLAG_PHASING)).toBe(false);
      const p = rig.dragon(0).position;
      expect(world.clearance(p.x, p.y, p.z, 2)).toBe(-1);
      return rig.dragon(0);
    };
    // Without the phase the wall stops it (it bounces back); with it, it is on the far side.
    expect(fly(false).position.z).toBeLessThan(52);
    const through = fly(true);
    expect(through.position.z).toBeGreaterThan(68);
    expect(lost(through)).toBe(0);
  });

  it('a phase that ends inside the rock puts the dragon outside it', () => {
    const world = createMapCollisionWorld(makeMap([box(0, ALTITUDE, 200, 400, 400, 300)]));
    const rig = makeRig({ collisionWorld: world });
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.hold(0, BUTTON_UTILITY, 1);
    // Deep inside the 300 m block when the second runs out.
    rig.step(ticksOf(ABILITY_TABLE.wraith.utility.windupS) + ticksOf(1) + 3);
    const dragon = rig.dragon(0);
    expect(dragon.phaseTicks).toBe(0);
    const p = dragon.position;
    expect(world.clearance(p.x, p.y, p.z, CLASS_TUNING.wraith.hitRadius)).toBe(-1);
    expect(p.z < 50 || p.z > 350).toBe(true);
    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
  });

  it('a phase that ends inside stacked solids still puts the dragon outside them', () => {
    // Two blocks on top of each other: their touching faces are inside the rock, and whichever
    // of the two is "the closest face" says nothing about being inside.
    const lower = box(0, ALTITUDE - 100, 200, 400, 200, 300);
    const upper = box(0, ALTITUDE + 100, 200, 400, 200, 300);
    const radius = CLASS_TUNING.wraith.hitRadius;
    // And one reaching 20 m into the block above it: under that block's bottom face (which
    // looks at the dragon) but still inside the rock.
    const tall = box(0, ALTITUDE - 90, 200, 400, 220, 300);
    for (const solids of [
      [lower, upper],
      [upper, lower],
      [tall, upper],
    ]) {
      for (const offsetY of [4, -4, 0.5, -0.5, 30, 12]) {
        const world = createMapCollisionWorld(makeMap(solids));
        const rig = makeRig({ collisionWorld: world });
        rig.add(0, TEAM_EMBER, 'wraith', 0, 0).phaseTicks = 3;
        rig.step();
        // (The sim swaps its two state buffers every tick: ask for the dragon again.)
        const placed = rig.dragon(0);
        placed.position.x = 10;
        placed.position.y = ALTITUDE + offsetY;
        placed.position.z = 200;
        rig.step(4);
        const dragon = rig.dragon(0);
        expect(dragon.phaseTicks).toBe(0);
        const p = dragon.position;
        const label = `offset ${offsetY}: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
        for (const solid of solids) {
          const inside =
            Math.abs(p.x - solid.position.x) < solid.size.x / 2 &&
            Math.abs(p.y - solid.position.y) < solid.size.y / 2 &&
            Math.abs(p.z - solid.position.z) < solid.size.z / 2;
          expect(inside, label).toBe(false);
        }
        expect(world.clearance(p.x, p.y, p.z, radius * 0.99), label).toBe(-1);
      }
    }
  });

  it('an attack cannot be started while phasing', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.dragon(0).phaseTicks = 20;
    rig.hold(0, BUTTON_PRIMARY, 5);
    expect(rig.eventsOf('abilityCast')).toHaveLength(0);
  });
});

describe('zones', () => {
  it('Tempest static mine flies out, becomes a field and slows who enters; two charges', () => {
    const def = ABILITY_TABLE.tempest.secondary;
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    // Flying toward the tempest: it runs into the field.
    rig.add(1, TEAM_FROST, 'tempest', 0, 260, Math.PI);
    rig.add(2, TEAM_EMBER, 'tempest', 5, 250, Math.PI);
    rig.hold(0, BUTTON_SECONDARY, 1);
    expect(projectileCountOf(rig.sim, 'staticMine')).toBe(1);
    expect(rig.dragon(0).abilityChargesUsed[1]).toBe(1);
    rig.step(ticksOf(PROJECTILE_DEFS.staticMine.lifeS) + 1);
    expect(projectileCountOf(rig.sim, 'staticMine')).toBe(0);
    expect(zoneCountOf(rig.sim, 'staticField')).toBe(1);
    expect(rig.eventsOf('impact')).toHaveLength(1);
    expect(rig.eventsOf('impact')[0]).toMatchObject({ projectile: 'staticMine', ownerId: 0 });
    let slowed = false;
    for (let i = 0; i < 90; i++) {
      rig.step();
      if (has(rig.dragon(1), DRAGON_FLAG_SLOWED)) slowed = true;
      // The owner's teammate flies through untouched.
      expect(has(rig.dragon(2), DRAGON_FLAG_SLOWED)).toBe(false);
    }
    expect(slowed).toBe(true);
    expect(rig.eventsOf('statusApplied').some((e) => e.status === 'slow' && e.targetId === 1)).toBe(
      true,
    );

    // The second charge is there at once, a third is not.
    rig.hold(0, BUTTON_SECONDARY, 1);
    expect(rig.dragon(0).abilityChargesUsed[1]).toBe(2);
    rig.step(2);
    rig.hold(0, BUTTON_SECONDARY, 1);
    expect(rig.dragon(0).abilityChargesUsed[1]).toBe(2);
    expect(rig.eventsOf('abilityCast').filter((e) => e.slot === 'secondary')).toHaveLength(2);
    // Charges come back one cooldown at a time.
    rig.step(ticksOf(def.cooldownS) * 2);
    expect(rig.dragon(0).abilityChargesUsed[1]).toBe(0);
  });

  it('Tempest thunderhead needs a full ultimate, spends it and zaps the area', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 130, Math.PI);
    rig.hold(0, BUTTON_ULTIMATE, 1);
    expect(rig.eventsOf('abilityCast')).toHaveLength(0);
    rig.dragon(0).ultCharge = 1;
    // Released for a tick: an ultimate needs a fresh press.
    rig.step();
    rig.hold(0, BUTTON_ULTIMATE, 1);
    expect(rig.eventsOf('abilityCast')).toHaveLength(1);
    expect(rig.dragon(0).ultCharge).toBe(0);
    expect(zoneCountOf(rig.sim, 'thunderhead')).toBe(1);
    const zone = rig.sim.current.zones.find((z) => z.active);
    expect(zone?.position.z).toBeGreaterThan(100);
    expect(zone?.team).toBe(TEAM_EMBER);
    rig.step(30);
    const target = rig.dragon(1);
    expect(lost(target)).toBeGreaterThan(0);
    expect(rig.eventsOf('hit')[0]).toMatchObject({
      attackerId: 0,
      targetId: 1,
      source: 'ultimate',
    });
    // Ultimate damage does not charge the next ultimate.
    expect(rig.dragon(0).ultCharge).toBe(0);
    rig.step(ticksOf(8));
    expect(zoneCountOf(rig.sim, 'thunderhead')).toBe(0);
  });

  it('a zone placed along the aim stops short of terrain', () => {
    const world = createMapCollisionWorld(makeMap([box(0, ALTITUDE, 100, 200, 200, 20)]));
    const rig = makeRig({ collisionWorld: world });
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    rig.dragon(0).ultCharge = 1;
    rig.hold(0, BUTTON_ULTIMATE, 1);
    const zone = rig.sim.current.zones.find((z) => z.active);
    expect(zone?.position.z).toBeLessThan(90);
    expect(zone?.position.z).toBeGreaterThan(70);
  });

  it('Bastion rally roar follows its owner and heals allies near it, not enemies', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'bastion', 0, 0);
    rig.add(1, TEAM_EMBER, 'bastion', 20, 0);
    rig.add(2, TEAM_FROST, 'bastion', -20, 0);
    rig.add(3, TEAM_EMBER, 'bastion', 400, 0);
    rig.step();
    for (const id of [0, 1, 2, 3]) rig.dragon(id).health -= 60;
    rig.hold(0, BUTTON_UTILITY, 1);
    expect(zoneCountOf(rig.sim, 'rallyAura')).toBe(1);
    rig.step(60);
    const zone = rig.sim.current.zones.find((z) => z.active);
    expect(zone?.position.z).toBeCloseTo(rig.dragon(0).position.z, 6);
    expect(has(rig.dragon(1), DRAGON_FLAG_REGEN)).toBe(true);
    rig.step(ticksOf(6));
    expect(zoneCountOf(rig.sim, 'rallyAura')).toBe(0);
    expect(lost(rig.dragon(0))).toBeLessThan(30);
    expect(lost(rig.dragon(1))).toBeLessThan(30);
    expect(lost(rig.dragon(2))).toBe(60);
    expect(lost(rig.dragon(3))).toBe(60);
  });

  it('the rally aura ends when its owner dies', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'bastion', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 500);
    rig.hold(0, BUTTON_UTILITY, 1);
    rig.step(5);
    rig.sim.applyDamage(0, 1e9, 1, 'primary');
    rig.step(2);
    expect(zoneCountOf(rig.sim, 'rallyAura')).toBe(0);
  });

  it('Talon afterburn speeds it up and leaves a trail that burns a pursuer', () => {
    const def = ABILITY_TABLE.talon.utility;
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(1, TEAM_FROST, 'talon', 0, -40);
    rig.add(2, TEAM_EMBER, 'talon', 3, -40);
    rig.hold(0, BUTTON_UTILITY, 1);
    expect(has(rig.dragon(0), DRAGON_FLAG_HASTED)).toBe(true);
    let most = 0;
    let burning = false;
    for (let i = 0; i < ticksOf(def.durationS) + 30; i++) {
      rig.step();
      most = Math.max(most, zoneCountOf(rig.sim, 'burnTrail'));
      if (has(rig.dragon(1), DRAGON_FLAG_BURNING)) burning = true;
    }
    expect(most).toBeGreaterThanOrEqual(3);
    expect(burning).toBe(true);
    expect(lost(rig.dragon(1))).toBeGreaterThan(0);
    expect(lost(rig.dragon(0))).toBe(0);
    expect(lost(rig.dragon(2))).toBe(0);
    expect(
      rig.eventsOf('hit').every((hit) => hit.source === 'utility' && hit.attackerId === 0),
    ).toBe(true);
    expect(has(rig.dragon(0), DRAGON_FLAG_HASTED)).toBe(false);
    // One cast event for the whole trail.
    expect(rig.eventsOf('abilityCast')).toHaveLength(1);
  });
});

describe('waves and bursts', () => {
  it('Bastion bulwark charge hurts and throws back every enemy around it', () => {
    const def = ABILITY_TABLE.bastion.ultimate;
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'bastion', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 30, 0);
    rig.add(2, TEAM_FROST, 'bastion', 0, -30);
    rig.add(3, TEAM_EMBER, 'bastion', -30, 0);
    rig.add(4, TEAM_FROST, 'bastion', 0, 200);
    rig.dragon(0).ultCharge = 1;
    rig.hold(0, BUTTON_ULTIMATE, 1);
    expect(lost(rig.dragon(1))).toBe(def.damage);
    expect(lost(rig.dragon(2))).toBe(def.damage);
    expect(lost(rig.dragon(3))).toBe(0);
    expect(lost(rig.dragon(4))).toBe(0);
    expect(rig.dragon(1).burst.x).toBeGreaterThan(def.knockback * 0.8);
    expect(rig.dragon(2).burst.z).toBeLessThan(-def.knockback * 0.8);
    expect(rig.dragon(3).burst.x).toBe(0);
    expect(rig.dragon(0).burst.z).toBeGreaterThan(0);
    rig.step(3);
    expect(has(rig.dragon(0), DRAGON_FLAG_SHIELDED)).toBe(true);
    expect(rig.dragon(1).position.x).toBeGreaterThan(31);
  });

  it('Talon meteor strafe drops a line of bombs that explode on what is below', () => {
    const def = ABILITY_TABLE.talon.ultimate;
    // A floor 60 m under the flight path.
    const world = createMapCollisionWorld(makeMap([box(0, ALTITUDE - 110, 0, 3000, 100, 3000)]));
    const rig = makeRig({ collisionWorld: world });
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.dragon(0).ultCharge = 1;
    rig.hold(0, BUTTON_ULTIMATE, 1);
    let most = projectileCountOf(rig.sim, 'meteorBomb');
    for (let i = 0; i < 40; i++) {
      rig.step();
      most = Math.max(most, projectileCountOf(rig.sim, 'meteorBomb'));
    }
    const bombs = Math.ceil(ticksOf(def.durationS) / ticksOf(def.pulseIntervalS));
    expect(most).toBe(bombs);
    rig.step(ticksOf(4));
    expect(projectileCountOf(rig.sim, 'meteorBomb')).toBe(0);
    const impacts = rig.eventsOf('impact');
    expect(impacts).toHaveLength(bombs);
    // A line along the flight path, on the floor.
    for (let i = 1; i < impacts.length; i++) {
      expect(impacts[i]?.position.z).toBeGreaterThan((impacts[i - 1]?.position.z ?? 0) + 3);
    }
    for (const impact of impacts) expect(impact.position.y).toBeCloseTo(ALTITUDE - 60, 0);
    expect(rig.eventsOf('abilityCast')).toHaveLength(1);
  });

  it('a blast hurts by distance, and never its owner', () => {
    const rig = makeRig({
      projectileDefs: {
        ...PROJECTILE_DEFS,
        meteorBomb: {
          ...PROJECTILE_DEFS.meteorBomb,
          gravity: 0,
          speed: 100,
          inheritVelocity: 0,
          lifeS: 0.5,
        },
      },
    });
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    // Head-on in the bomb's path: it goes off on this one.
    rig.add(1, TEAM_FROST, 'bastion', 0, 60, Math.PI);
    rig.add(2, TEAM_FROST, 'bastion', 14, 50, Math.PI);
    rig.dragon(0).ultCharge = 1;
    rig.hold(0, BUTTON_ULTIMATE, 1);
    rig.step(12);
    const damage = ABILITY_TABLE.talon.ultimate.damage;
    expect(lost(rig.dragon(1))).toBeGreaterThan(damage * 0.8);
    expect(lost(rig.dragon(2))).toBeGreaterThan(0);
    expect(lost(rig.dragon(2))).toBeLessThan(lost(rig.dragon(1)));
    expect(lost(rig.dragon(0))).toBe(0);
  });

  it('Wraith night terror blinds enemies in its cone only', () => {
    const def = ABILITY_TABLE.wraith.ultimate;
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.add(1, TEAM_FROST, 'talon', 10, 80);
    rig.add(2, TEAM_FROST, 'talon', 0, -80);
    rig.add(3, TEAM_FROST, 'talon', 90, 30);
    rig.add(4, TEAM_EMBER, 'talon', -10, 80);
    rig.dragon(0).ultCharge = 1;
    rig.hold(0, BUTTON_ULTIMATE, 1);
    expect(has(rig.dragon(1), DRAGON_FLAG_BLINDED)).toBe(true);
    expect(lost(rig.dragon(1))).toBe(def.damage);
    for (const id of [2, 3, 4]) {
      expect(has(rig.dragon(id), DRAGON_FLAG_BLINDED)).toBe(false);
      expect(lost(rig.dragon(id))).toBe(0);
    }
    rig.step(ticksOf(def.statusS) + 1);
    expect(has(rig.dragon(1), DRAGON_FLAG_BLINDED)).toBe(false);
  });

  it('Wraith shade breath burns', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 40);
    rig.hold(0, BUTTON_PRIMARY, 2);
    expect(has(rig.dragon(1), DRAGON_FLAG_BURNING)).toBe(true);
    const direct = lost(rig.dragon(1));
    rig.step(ticksOf(ABILITY_TABLE.wraith.primary.statusS) + 20);
    expect(lost(rig.dragon(1))).toBeGreaterThan(direct + 10);
  });
});

describe('costs', () => {
  it('a stamina cost is paid when the ability fires and blocks it when it cannot be paid', () => {
    const table: AbilityTable = {
      ...ABILITY_TABLE,
      tempest: {
        ...ABILITY_TABLE.tempest,
        utility: { ...ABILITY_TABLE.tempest.utility, staminaCost: 0.6, cooldownS: 0.1 },
      },
    };
    const rig = makeRig({ abilityTable: table });
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    rig.hold(0, BUTTON_UTILITY, 1);
    expect(rig.dragon(0).stamina).toBeCloseTo(0.4, 6);
    rig.step(10);
    rig.hold(0, BUTTON_UTILITY, 1);
    expect(rig.eventsOf('abilityCast')).toHaveLength(1);
  });

  it('only one ability winds up at a time', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'wraith', 0, 0);
    rig.hold(0, BUTTON_SECONDARY | BUTTON_UTILITY, 1);
    expect(rig.dragon(0).castSlot).toBe(1);
    rig.step(ticksOf(ABILITY_TABLE.wraith.secondary.windupS) + 2);
    expect(has(rig.dragon(0), DRAGON_FLAG_VEILED)).toBe(true);
    expect(has(rig.dragon(0), DRAGON_FLAG_PHASING)).toBe(false);
  });
});

// --- Takedowns, assists, respawns ------------------------------------------------------------------

describe('takedowns and assists', () => {
  function trio(): Rig {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(1, TEAM_EMBER, 'tempest', 50, 0);
    rig.add(2, TEAM_FROST, 'bastion', 0, 500);
    rig.step();
    return rig;
  }

  it('credits the killer, the assist, the team and the score sheet', () => {
    const rig = trio();
    rig.sim.applyDamage(2, 40, 0, 'primary');
    rig.step(30);
    rig.sim.applyDamage(2, 1e9, 1, 'secondary');
    rig.step();
    const takedowns = rig.eventsOf('takedown');
    expect(takedowns).toHaveLength(1);
    expect(takedowns[0]).toMatchObject({ killerId: 1, victimId: 2, source: 'secondary' });
    const assists = rig.eventsOf('assist');
    expect(assists).toHaveLength(1);
    expect(assists[0]).toMatchObject({ assisterId: 0, killerId: 1, victimId: 2 });
    const state = rig.sim.current;
    expect(state.scores[0]).toMatchObject({ takedowns: 0, assists: 1, deaths: 0 });
    expect(state.scores[1]).toMatchObject({ takedowns: 1, assists: 0, deaths: 0 });
    expect(state.scores[2]).toMatchObject({ takedowns: 0, assists: 0, deaths: 1 });
    expect(state.teamTakedowns).toEqual([1, 0]);
    expect(rig.dragon(1).ultCharge).toBeGreaterThanOrEqual(COMBAT_TUNING.ultChargePerTakedown);
    // The death cam target stays on the corpse.
    expect(rig.dragon(2).lastDamagerId).toBe(1);
    // Announced once.
    rig.step(20);
    expect(rig.eventsOf('takedown')).toHaveLength(1);
  });

  it('an old hit is no assist', () => {
    const rig = trio();
    rig.sim.applyDamage(2, 40, 0, 'primary');
    rig.step(ticksOf(COMBAT_TUNING.assistWindowS) + 5);
    rig.sim.applyDamage(2, 1e9, 1, 'secondary');
    rig.step();
    expect(rig.eventsOf('assist')).toHaveLength(0);
    expect(rig.sim.current.scores[0]?.assists).toBe(0);
  });

  it('terrain or the storm finishing a wounded dragon is credited to who wounded it', () => {
    const rig = trio();
    rig.sim.applyDamage(2, 40, 0, 'primary');
    rig.step(10);
    // What the storm does: health straight to zero inside the dragon's own step.
    const victim = rig.dragon(2);
    victim.health = 0;
    victim.envSource = 2;
    rig.step();
    expect(rig.eventsOf('takedown')[0]).toMatchObject({ killerId: 0, victimId: 2 });
    expect(rig.sim.current.scores[0]?.takedowns).toBe(1);
  });

  it('a dragon that just crashes is an environment takedown: nobody scores', () => {
    const world = createMapCollisionWorld(makeMap([box(0, ALTITUDE, 120, 400, 400, 40)]));
    const rig = makeRig({
      collisionWorld: world,
      flightTuning: { ...createSim().flightTuning, terrainLethalSpeed: 20 },
    });
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.step(90);
    const takedowns = rig.eventsOf('takedown');
    expect(takedowns).toHaveLength(1);
    expect(takedowns[0]).toMatchObject({ killerId: NO_PLAYER, victimId: 0, source: 'terrain' });
    expect(rig.eventsOf('hit')[0]).toMatchObject({ attackerId: NO_PLAYER, source: 'terrain' });
    expect(rig.sim.current.teamTakedowns).toEqual([0, 0]);
    expect(rig.sim.current.scores[0]).toMatchObject({ deaths: 1, takedowns: 0 });
  });

  it('a credit older than the window is forgotten', () => {
    const rig = trio();
    rig.sim.applyDamage(2, 40, 0, 'primary');
    rig.step(ticksOf(COMBAT_TUNING.creditWindowS) + 5);
    rig.dragon(2).health = 0;
    rig.step();
    expect(rig.eventsOf('takedown')[0]).toMatchObject({ killerId: NO_PLAYER });
  });

  it('a team kill scores nothing', () => {
    const rig = trio();
    rig.sim.rules.friendlyFire = true;
    rig.sim.applyDamage(1, 1e9, 0, 'primary');
    rig.step();
    expect(rig.eventsOf('takedown')[0]).toMatchObject({ killerId: 0, victimId: 1 });
    expect(rig.sim.current.teamTakedowns).toEqual([0, 0]);
    expect(rig.sim.current.scores[0]?.takedowns).toBe(0);
  });
});

describe('respawn', () => {
  const delay = secondsToTicks(MATCH_TUNING.respawnDelayS);

  function kill(rig: Rig): void {
    rig.sim.applyDamage(1, 1e9, 0, 'primary');
  }

  function pair(spawnProtectionS = MATCH_TUNING.spawnProtectionS): Rig {
    const rig = makeRig({ spawnProtectionS });
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(1, TEAM_FROST, 'tempest', 100, 700, 1.5);
    rig.step(ticksOf(spawnProtectionS) + 1);
    return rig;
  }

  it('brings the dragon back at its gate after the delay, protected, and says so', () => {
    const rig = pair();
    rig.dragon(1).ultCharge = 0.5;
    rig.step(30);
    kill(rig);
    rig.step(delay - 1);
    expect(has(rig.dragon(1), DRAGON_FLAG_ALIVE)).toBe(false);
    expect(rig.dragon(1).deadTicks).toBe(delay - 1);
    expect(rig.eventsOf('spawn')).toHaveLength(0);
    rig.step(1);
    const dragon = rig.dragon(1);
    expect(has(dragon, DRAGON_FLAG_ALIVE)).toBe(true);
    expect(has(dragon, DRAGON_FLAG_SPAWN_PROTECTED)).toBe(true);
    expect(dragon.health).toBe(dragon.maxHealth);
    expect(dragon.position).toEqual({ x: 100, y: ALTITUDE, z: 700 });
    expect(dragon.yaw).toBeCloseTo(1.5, 9);
    expect(dragon.deadTicks).toBe(0);
    expect(dragon.ultCharge).toBe(0.5);
    expect(dragon.spawnProtectTicks).toBe(secondsToTicks(MATCH_TUNING.spawnProtectionS));
    // The view must not sweep it in from where it died.
    const slot = rig.sim.current.dragons.indexOf(dragon);
    expect(rig.sim.prev.dragons[slot]?.position).toEqual(dragon.position);
    const spawns = rig.eventsOf('spawn');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ dragonId: 1, team: TEAM_FROST, classId: 'tempest' });
    // Protected: nothing hurts it for 2 s.
    expect(rig.sim.applyDamage(1, 50, 0, 'primary')).toBe(0);
    rig.step(secondsToTicks(MATCH_TUNING.spawnProtectionS));
    expect(has(rig.dragon(1), DRAGON_FLAG_SPAWN_PROTECTED)).toBe(false);
    expect(rig.sim.applyDamage(1, 50, 0, 'primary')).toBe(50);
    // The score sheet survived the respawn.
    expect(rig.sim.current.scores[slot]?.deaths).toBe(1);
  });

  it('Talon afterburn is an attack: its burning trail gives up spawn protection', () => {
    const rig = pair();
    rig.sim.applyDamage(0, 1e9, 1, 'primary');
    rig.step(delay + 1);
    expect(rig.dragon(0).spawnProtectTicks).toBeGreaterThan(0);
    rig.hold(0, BUTTON_UTILITY, 1);
    expect(rig.dragon(0).spawnProtectTicks).toBe(0);
    // Every ability that can hurt an enemy carries the tag.
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        const def = ABILITY_TABLE[classId][slot];
        const pdef = def.projectile !== null ? PROJECTILE_DEFS[def.projectile] : null;
        const hurts =
          (def.tags & ABILITY_TAG_ALLIES) === 0 &&
          (def.damage > 0 ||
            (pdef !== null && !pdef.passThrough) ||
            (def.zone !== null && ZONE_DEFS[def.zone].damage > 0));
        if (hurts) expect(def.tags & ABILITY_TAG_ATTACK, `${classId} ${slot}`).not.toBe(0);
      }
    }
  });

  it('spawn protection ends the moment the dragon attacks', () => {
    const rig = pair();
    kill(rig);
    rig.step(delay + 1);
    expect(rig.dragon(1).spawnProtectTicks).toBeGreaterThan(0);
    // A utility is not an attack.
    rig.hold(1, BUTTON_UTILITY, 1);
    expect(rig.dragon(1).spawnProtectTicks).toBeGreaterThan(0);
    rig.hold(1, BUTTON_PRIMARY, 1);
    // The lance winds up first; protection lasts until it fires.
    rig.hold(1, BUTTON_PRIMARY, ticksOf(ABILITY_TABLE.tempest.primary.windupS));
    expect(rig.dragon(1).spawnProtectTicks).toBe(0);
    expect(has(rig.dragon(1), DRAGON_FLAG_SPAWN_PROTECTED)).toBe(false);
  });

  it('stays down while the policy says so, and comes back on request', () => {
    const rig = pair(0);
    rig.sim.respawnPolicy.enabled = false;
    kill(rig);
    rig.step(delay * 2);
    expect(has(rig.dragon(1), DRAGON_FLAG_ALIVE)).toBe(false);
    expect(rig.eventsOf('takedown')).toHaveLength(1);
    expect(rig.sim.respawnDragon(1)).toBe(true);
    expect(has(rig.dragon(1), DRAGON_FLAG_ALIVE)).toBe(true);
    expect(rig.eventsOf('spawn')).toHaveLength(1);
    expect(rig.sim.respawnDragon(9)).toBe(false);
    // A second death is a second takedown.
    kill(rig);
    rig.step(2);
    expect(rig.eventsOf('takedown')).toHaveLength(2);
    rig.sim.respawnPolicy.enabled = true;
    rig.step(delay);
    expect(has(rig.dragon(1), DRAGON_FLAG_ALIVE)).toBe(true);
  });

  it('lets the policy place the dragon, without moving its home', () => {
    const rig = pair(0);
    rig.sim.respawnPolicy.place = (dragon, out) => {
      expect(out).toEqual({ x: 100, y: ALTITUDE, z: 700, yaw: dragon.homeYaw });
      out.x = -50;
      out.yaw = 0;
    };
    kill(rig);
    rig.step(delay + 1);
    expect(rig.dragon(1).position.x).toBe(-50);
    expect(rig.dragon(1).home).toEqual({ x: 100, y: ALTITUDE, z: 700 });
  });

  it('a wind-up dies with the dragon and statuses do not survive it', () => {
    const rig = pair(0);
    rig.hold(1, BUTTON_PRIMARY, 3);
    rig.sim.applyStatus(1, 'burn', 20, 5, 0);
    rig.sim.applyStatus(1, 'slow', 20, 0.5, 0);
    kill(rig);
    rig.step(3);
    const dragon = rig.dragon(1);
    expect(dragon.castSlot).toBe(-1);
    expect(dragon.burnTicks).toBe(0);
    expect(dragon.slowTicks).toBe(0);
    expect(dragon.flags).toBe(0);
    expect(rig.eventsOf('abilityCast')).toHaveLength(0);
  });
});

// --- Seams -----------------------------------------------------------------------------------------

describe('seams', () => {
  it('asks the target position source for every aimed shot (the lag-compensation hook)', () => {
    const asked: { shooter: number; target: number; tick: number }[] = [];
    // Pretend the target was 40 m to the side when the shooter saw it.
    const rewind: TargetPositionSource = {
      sample(shooterId, target, tick, out) {
        asked.push({ shooter: shooterId, target: target.id, tick });
        out.x = target.position.x - 40;
        out.y = target.position.y;
        out.z = target.position.z;
      },
    };
    const rig = makeRig({ targetPositions: rewind });
    rig.add(0, TEAM_EMBER, 'tempest', 0, 0);
    rig.add(1, TEAM_FROST, 'tempest', 40, 200);
    rig.hold(0, BUTTON_PRIMARY, ticksOf(ABILITY_TABLE.tempest.primary.windupS) + 1);
    // The beam goes straight ahead; the target is 40 m to the side NOW, but was in the way.
    expect(lost(rig.dragon(1))).toBe(ABILITY_TABLE.tempest.primary.damage);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]).toMatchObject({ shooter: 0, target: 1 });
    expect(asked[0]?.tick).toBe(rig.tick - 1);

    rig.sim.setTargetPositions(null);
    rig.step(ticksOf(ABILITY_TABLE.tempest.primary.cooldownS));
    rig.hold(0, BUTTON_PRIMARY, ticksOf(ABILITY_TABLE.tempest.primary.windupS) + 2);
    expect(lost(rig.dragon(1))).toBe(ABILITY_TABLE.tempest.primary.damage);
  });

  it('moves the storm wall and remembers the radius in the state', () => {
    const world = createMapCollisionWorld(makeMap([]));
    const rig = makeRig({ collisionWorld: world });
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    expect(rig.sim.current.stormRadius).toBe(-1);
    rig.sim.setStormRadius(400);
    rig.step(3);
    expect(world.stormRadius).toBe(400);
    expect(rig.sim.current.stormRadius).toBe(400);
    expect(rig.sim.prev.stormRadius).toBe(400);
    rig.sim.setStormRadius(-1);
    expect(world.stormRadius).toBe(3000);
    expect(rig.sim.current.stormRadius).toBe(-1);
  });

  it('clears projectiles and zones on request and everything on reset', () => {
    const rig = makeRig();
    rig.add(0, TEAM_EMBER, 'talon', 0, 0);
    rig.add(1, TEAM_FROST, 'bastion', 0, 300);
    rig.hold(0, BUTTON_PRIMARY | BUTTON_UTILITY, 20);
    expect(rig.sim.current.projectileCount).toBeGreaterThan(0);
    expect(rig.sim.current.zoneCount).toBeGreaterThan(0);
    rig.sim.clearEffects();
    expect(rig.sim.current.projectileCount).toBe(0);
    expect(rig.sim.current.zoneCount).toBe(0);
    rig.step(5);
    rig.sim.applyDamage(1, 1e9, 0, 'primary');
    rig.step();
    rig.sim.reset();
    expect(rig.sim.current).toEqual(createSim().current);
    expect(rig.sim.prev).toEqual(createSim().prev);
  });

  it('counts only enemy projectiles and zones the pools can hold: exhaustion is graceful', () => {
    const slow: Record<ProjectileKind, ProjectileDef> = {
      ...PROJECTILE_DEFS,
      fireBolt: { ...PROJECTILE_DEFS.fireBolt, lifeS: 60, speed: 5 },
    };
    const table: AbilityTable = {
      ...ABILITY_TABLE,
      talon: {
        ...ABILITY_TABLE.talon,
        primary: { ...ABILITY_TABLE.talon.primary, cooldownS: 1 / 30 },
        utility: {
          ...ABILITY_TABLE.talon.utility,
          cooldownS: 0.1,
          durationS: 0.1,
          pulseIntervalS: 0,
        },
      },
    };
    const rig = makeRig({
      projectileDefs: slow,
      abilityTable: table,
      zoneDefs: { ...ZONE_DEFS, burnTrail: { ...ZONE_DEFS.burnTrail, durationS: 60 } },
    });
    for (let id = 0; id < MAX_PLAYERS; id++) {
      rig.add(id, id % 2 === 0 ? TEAM_EMBER : TEAM_FROST, 'talon', id * 400, 0);
    }
    for (let i = 0; i < 400; i++) {
      for (const input of rig.inputs) {
        if (input === undefined) continue;
        // Utility needs a fresh press each time.
        input.buttons = BUTTON_PRIMARY | (i % 2 === 0 ? BUTTON_UTILITY : 0);
      }
      rig.step();
      expect(rig.sim.current.projectileCount).toBeLessThanOrEqual(MAX_PROJECTILES);
      expect(rig.sim.current.zoneCount).toBeLessThanOrEqual(MAX_ZONES);
    }
    const state = rig.sim.current;
    expect(state.projectileCount).toBe(MAX_PROJECTILES);
    expect(state.projectiles.filter((p) => p.active)).toHaveLength(MAX_PROJECTILES);
    expect(state.zoneCount).toBe(MAX_ZONES);
    expect(state.zones.filter((z) => z.active)).toHaveLength(MAX_ZONES);
    // Zone ids stay unique among the live ones, and none is the storm wall's 0.
    const ids = new Set(state.zones.filter((z) => z.active).map((z) => z.id));
    expect(ids.size).toBe(MAX_ZONES);
    expect(ids.has(0)).toBe(false);
  });
});

// --- Determinism and robustness --------------------------------------------------------------------

const ALL_BUTTONS = 0xfff;

/** 10 dragons of mixed classes close enough to fight, flown by seeded random inputs. */
function brawl(
  seed: number,
  options: SimOptions = {},
  buttonMask = ALL_BUTTONS,
): { sim: Sim; step(ticks: number): void } {
  const random = createSeededRandom(seed);
  const sim = createSim(options);
  const frames: InputFrame[] = [];
  for (let id = 0; id < MAX_PLAYERS; id++) {
    const classId = DRAGON_CLASS_IDS[id % DRAGON_CLASS_IDS.length] ?? 'talon';
    const angle = (id / MAX_PLAYERS) * Math.PI * 2;
    sim.spawnDragon(
      id,
      id % 2 === 0 ? TEAM_EMBER : TEAM_FROST,
      classId,
      { x: Math.sin(angle) * 150, y: 300 + (id % 3) * 20, z: Math.cos(angle) * 150 },
      angle + Math.PI,
    );
    frames.push(createInputFrame());
  }
  let tick = 0;
  return {
    sim,
    step(ticks) {
      for (let i = 0; i < ticks; i++) {
        for (let id = 0; id < MAX_PLAYERS; id++) {
          const frame = frames[id];
          const dragon = sim.getDragon(id);
          if (frame === undefined || dragon === undefined) continue;
          frame.tick = tick;
          if (random() < 0.1) {
            // Steer back toward the middle so the fight stays together.
            const home = Math.atan2(-dragon.position.x, -dragon.position.z);
            let error = home - dragon.yaw;
            error -= Math.PI * 2 * Math.floor((error + Math.PI) / (Math.PI * 2));
            frame.steerX = Math.max(-1, Math.min(1, -error + (random() - 0.5)));
            frame.steerY = Math.max(
              -1,
              Math.min(1, (300 - dragon.position.y) / 100 + random() - 0.5),
            );
            frame.buttons = Math.floor(random() * (ALL_BUTTONS + 1)) & buttonMask;
            frame.aimYaw = dragon.yaw + (random() - 0.5);
            frame.aimPitch = dragon.pitch + (random() - 0.5) * 0.5;
            // Ultimates get used: fill the charge now and then.
            if (random() < 0.2) dragon.ultCharge = 1;
          }
        }
        sim.step(tick++, frames);
      }
    },
  };
}

function collectNumbers(node: unknown, path: string, out: [string, number][]): void {
  if (typeof node === 'number') out.push([path, node]);
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) collectNumbers(value, `${path}.${key}`, out);
  }
}

describe('determinism', () => {
  it('two sims with the same inputs stay identical, projectiles and zones included', () => {
    const a = brawl(7);
    const b = brawl(7);
    let casts = 0;
    a.sim.setEventSink({
      emit: (event) => {
        if (event.type === 'abilityCast') casts++;
      },
    });
    let sawProjectiles = 0;
    let sawZones = 0;
    for (let i = 0; i < 40; i++) {
      a.step(50);
      b.step(50);
      expect(a.sim.current).toEqual(b.sim.current);
      sawProjectiles = Math.max(sawProjectiles, a.sim.current.projectileCount);
      sawZones = Math.max(sawZones, a.sim.current.zoneCount);
    }
    expect(a.sim.prev).toEqual(b.sim.prev);
    // The run really was a fight.
    expect(casts).toBeGreaterThan(200);
    expect(sawProjectiles).toBeGreaterThan(5);
    expect(sawZones).toBeGreaterThan(1);
    const sheet = a.sim.current.scores.reduce((sum, score) => sum + score.damage, 0);
    expect(sheet).toBeGreaterThan(250);
    // A different seed is a different fight.
    const c = brawl(8);
    c.step(2000);
    expect(c.sim.current).not.toEqual(a.sim.current);
  });
});

describe('robustness', () => {
  it('10 dragons spamming abilities with hostile input for 20k ticks: nothing is NaN, pools hold', () => {
    const NASTY = [Number.NaN, Infinity, -Infinity, 1e308, -1e308, 2 ** 31, -0, 1e21];
    const random = createSeededRandom(99);
    const world = createMapCollisionWorld(
      makeMap([box(0, 150, 0, 120, 300, 120), box(250, 300, 0, 40, 600, 40)]),
    );
    world.setStormRadius(700);
    const sim = createSim({ collisionWorld: world });
    const bus = createGameEventBus();
    const seen = new Map<string, number>();
    for (const type of [
      'hit',
      'takedown',
      'spawn',
      'abilityCast',
      'assist',
      'statusApplied',
      'impact',
    ] as const) {
      bus.on(type, (event) => {
        seen.set(type, (seen.get(type) ?? 0) + 1);
        const numbers: [string, number][] = [];
        collectNumbers(event, type, numbers);
        for (const [path, value] of numbers) {
          if (!Number.isFinite(value)) throw new Error(`${path} is ${value}`);
        }
      });
    }
    sim.setEventSink(bus);
    const frames: InputFrame[] = [];
    const inputs: (InputFrame | undefined)[] = [];
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const classId = DRAGON_CLASS_IDS[id % DRAGON_CLASS_IDS.length] ?? 'talon';
      sim.spawnDragon(
        id,
        id % 2 === 0 ? TEAM_EMBER : TEAM_FROST,
        classId,
        { x: (id - 5) * 30, y: 350, z: id % 2 === 0 ? -150 : 150 },
        id % 2 === 0 ? 0 : Math.PI,
      );
      frames.push(createInputFrame());
    }
    const pick = (): number => NASTY[Math.floor(random() * NASTY.length)] ?? Number.NaN;
    for (let tick = 0; tick < 20_000; tick++) {
      if (tick === 6000) sim.rules.friendlyFire = true;
      if (tick === 12_000) sim.respawnPolicy.enabled = false;
      if (tick === 14_000) sim.respawnPolicy.enabled = true;
      for (let id = 0; id < MAX_PLAYERS; id++) {
        const frame = frames[id];
        if (frame === undefined) continue;
        frame.tick = tick;
        if (random() < 0.08) {
          frame.steerX = random() < 0.1 ? pick() : random() * 4 - 2;
          frame.steerY = random() < 0.1 ? pick() : random() * 4 - 2;
          frame.buttons = random() < 0.05 ? pick() : Math.floor(random() * 0x1ffff);
          frame.aimYaw = random() < 0.1 ? pick() : random() * 20 - 10;
          frame.aimPitch = random() < 0.1 ? pick() : random() * 8 - 4;
        }
        inputs[id] = random() < 0.03 ? undefined : frame;
        if (random() < 0.002) {
          const dragon = sim.getDragon(id);
          if (dragon !== undefined) dragon.ultCharge = 1;
        }
      }
      sim.step(tick, inputs);
      bus.flush();

      const state = sim.current;
      if (tick % 7 === 0 || tick > 19_900) {
        const numbers: [string, number][] = [];
        collectNumbers(state.dragons, 'dragons', numbers);
        collectNumbers(state.scores, 'scores', numbers);
        for (const projectile of state.projectiles) {
          if (projectile.active) collectNumbers(projectile, 'projectile', numbers);
        }
        for (const zone of state.zones) if (zone.active) collectNumbers(zone, 'zone', numbers);
        for (const [path, value] of numbers) {
          if (!Number.isFinite(value)) throw new Error(`tick ${tick}: ${path} is ${value}`);
        }
      }
      expect(state.projectileCount).toBe(state.projectiles.filter((p) => p.active).length);
      expect(state.zoneCount).toBe(state.zones.filter((z) => z.active).length);
      for (const dragon of state.dragons) {
        if (!dragon.active) continue;
        if (dragon.health < 0 || dragon.health > dragon.maxHealth) {
          throw new Error(`tick ${tick}: health ${dragon.health}`);
        }
        if (dragon.ultCharge < 0 || dragon.ultCharge > 1) throw new Error('ultimate out of range');
      }
    }
    // The run exercised the events (assists need two riders on one target: the chaos here
    // rarely manages, and the takedown tests cover them).
    for (const type of ['hit', 'takedown', 'spawn', 'abilityCast', 'statusApplied', 'impact']) {
      expect(seen.get(type) ?? 0, type).toBeGreaterThan(0);
    }
    expect(seen.get('abilityCast') ?? 0).toBeGreaterThan(5000);
  }, 120_000);
});

describe('host tick cost', () => {
  it('10 dragons spamming abilities on the greybox-sized terrain stay far under 1 ms a tick', () => {
    const world = createMapCollisionWorld(
      makeMap([
        box(0, 150, 0, 120, 300, 120),
        box(250, 300, 0, 40, 600, 40),
        box(-250, 300, 100, 40, 600, 40),
        box(0, 300, 300, 40, 600, 40),
      ]),
    );
    const bus = createGameEventBus();
    const fight = brawl(3, { collisionWorld: world, events: bus });
    // Warm up: JIT, pools, the bus's slots.
    for (let i = 0; i < 40; i++) {
      fight.step(50);
      bus.flush();
    }
    let projectiles = 0;
    let zones = 0;
    const ticks = 6000;
    const start = performance.now();
    for (let i = 0; i < ticks / 10; i++) {
      fight.step(10);
      bus.flush();
      projectiles += fight.sim.current.projectileCount;
      zones += fight.sim.current.zoneCount;
    }
    const usPerTick = ((performance.now() - start) * 1000) / ticks;

    // Garbage per tick, measured like the codec's hot-path test (best of a few trials), in open
    // sky and against the same flight without ability buttons: what is left is what the flight
    // model and this harness cost anyway, the difference is combat's.
    const garbage = (mask: number): number => {
      const events = createGameEventBus();
      const run = brawl(3, { events }, mask);
      for (let i = 0; i < 3000; i++) {
        run.step(1);
        events.flush();
      }
      let least = Infinity;
      for (let trial = 0; trial < 8; trial++) {
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 500; i++) {
          run.step(1);
          events.flush();
        }
        const grown = process.memoryUsage().heapUsed - before;
        if (grown >= 0 && grown < least) least = grown;
      }
      return least / 500;
    };
    const flightOnly = garbage(ALL_BUTTONS & ~BUTTON_ABILITY_MASK);
    const withCombat = garbage(ALL_BUTTONS);
    console.log(
      `[combat] 10 dragons spamming abilities: ${usPerTick.toFixed(1)} us/tick, ` +
        `avg ${(projectiles / (ticks / 10)).toFixed(1)} projectiles and ` +
        `${(zones / (ticks / 10)).toFixed(1)} zones alive; garbage per tick ` +
        `${withCombat.toFixed(0)} B with abilities, ${flightOnly.toFixed(0)} B without`,
    );
    // What is left with abilities on comes from code that runs too rarely for the JIT to
    // compile it (a death fall, a respawn, a blast): unoptimised JS boxes every float. One
    // object per projectile per tick in the hot loops would be several KB instead.
    if (Number.isFinite(withCombat) && Number.isFinite(flightOnly)) {
      expect(withCombat - flightOnly).toBeLessThan(1500);
    }
    expect(usPerTick).toBeLessThan(500);
  }, 60_000);
});
