/**
 * The combat contracts of src/shared (T-3.1 / T-3.2): the ability, projectile and zone tables
 * stay inside what the sim, the wire format and the client-flown bolts assume, and the new
 * InputFrame, WorldView and GameEvent pieces behave.
 */

import { describe, expect, it } from 'vitest';
import {
  ABILITY_KINDS,
  ABILITY_SLOTS,
  ABILITY_TABLE,
  ABILITY_TAG_ATTACK,
  ABILITY_TAG_AUTO,
  BUTTON_ABILITY_MASK,
  BUTTON_AIM,
  BUTTON_MASK,
  BUTTON_PRIMARY,
  BUTTON_ULTIMATE,
  CLASS_TUNING,
  COMBAT_TUNING,
  DAMAGE_SOURCES,
  DRAGON_CLASSES,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BLINDED,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_BURNING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_HASTED,
  DRAGON_FLAG_IN_STORM,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_REGEN,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SLOWED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_STALLED,
  DRAGON_FLAG_VEILED,
  FLIGHT_TUNING,
  MATCH_TUNING,
  MAX_ASSISTS,
  MAX_PROJECTILES,
  MAX_ZONES,
  NO_PLAYER,
  PROJECTILE_DEFS,
  PROJECTILE_KINDS,
  SNAPSHOT_MAX_PROJECTILES,
  SNAPSHOT_MAX_ZONES,
  STATUS_KINDS,
  TICK_HZ,
  ZONE_DEFS,
  ZONE_KINDS,
  acquireZoneView,
  beginWorldView,
  clampAimPitch,
  clampAimYaw,
  copyInputFrame,
  createGameEventBus,
  createInputFrame,
  createLocalCombatView,
  createWorldView,
  sanitizeInputFrame,
  writeLocalCombatView,
} from '../../src/shared';
import type { GameEvent, LocalCombatSource } from '../../src/shared';

describe('ability table', () => {
  it('has all four slots for every class, named in the class list', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        const def = ABILITY_TABLE[classId][slot];
        expect(ABILITY_KINDS, `${classId}.${slot}`).toContain(def.kind);
        expect(DRAGON_CLASSES[classId].abilities[slot].name.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every number finite and every duration inside the wire range', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        const def = ABILITY_TABLE[classId][slot];
        const label = `${classId}.${slot}`;
        for (const [key, value] of Object.entries(def)) {
          if (typeof value === 'number') {
            expect(Number.isFinite(value), `${label}.${key}`).toBe(true);
            expect(value, `${label}.${key}`).toBeGreaterThanOrEqual(0);
          }
        }
        // u16 ticks in the owner block.
        expect(def.cooldownS * TICK_HZ, label).toBeLessThan(0xffff);
        expect(def.durationS * TICK_HZ, label).toBeLessThan(0xffff);
        expect(def.windupS * TICK_HZ, label).toBeLessThan(0xffff);
        expect(def.cooldownS, label).toBeGreaterThan(0);
        expect(def.maxCharges, label).toBeGreaterThanOrEqual(1);
        expect(def.maxCharges, label).toBeLessThanOrEqual(255);
        expect(def.aimLimit, label).toBeLessThan(Math.PI / 2);
        if (def.status !== null) expect(def.statusS, label).toBeGreaterThan(0);
        if (def.selfStatus !== null) expect(def.durationS, label).toBeGreaterThan(0);
        if (def.pulseIntervalS > 0)
          expect(def.durationS, label).toBeGreaterThan(def.pulseIntervalS);
      }
    }
  });

  it('gives each kind what its executor needs', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        const def = ABILITY_TABLE[classId][slot];
        const label = `${classId}.${slot}`;
        if (def.kind === 'projectile') expect(def.projectile, label).not.toBeNull();
        if (def.kind === 'zone') expect(def.zone, label).not.toBeNull();
        if (def.kind === 'cone') {
          expect(def.range, label).toBeGreaterThan(0);
          expect(def.coneHalfAngle, label).toBeGreaterThan(0);
        }
        if (def.kind === 'beam' || def.kind === 'wave') expect(def.range, label).toBeGreaterThan(0);
        if (def.kind === 'buff') expect(def.selfStatus, label).not.toBeNull();
        if (def.zone !== null) {
          expect(ZONE_DEFS[def.zone].durationS, label).toBeGreaterThan(0);
          expect(ZONE_DEFS[def.zone].radius, label).toBeGreaterThan(0);
        }
      }
    }
  });

  it('makes ultimates cost a full charge and primaries free and held', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      const defs = ABILITY_TABLE[classId];
      expect(defs.ultimate.ultCost, classId).toBe(1);
      expect(defs.primary.ultCost, classId).toBe(0);
      expect(defs.secondary.ultCost, classId).toBe(0);
      expect(defs.utility.ultCost, classId).toBe(0);
      expect(defs.primary.tags & ABILITY_TAG_AUTO, classId).toBe(ABILITY_TAG_AUTO);
      expect(defs.primary.tags & ABILITY_TAG_ATTACK, classId).toBe(ABILITY_TAG_ATTACK);
      expect(defs.primary.staminaCost, classId).toBe(0);
    }
  });

  it('follows the doc: HP order, the 1 s phase dive, respawn and spawn protection', () => {
    expect(CLASS_TUNING.talon.maxHp).toBeLessThan(CLASS_TUNING.wraith.maxHp);
    expect(CLASS_TUNING.wraith.maxHp).toBeLessThan(CLASS_TUNING.tempest.maxHp);
    expect(CLASS_TUNING.tempest.maxHp).toBeLessThan(CLASS_TUNING.bastion.maxHp);
    expect(ABILITY_TABLE.wraith.utility.durationS).toBe(1);
    expect(ABILITY_TABLE.wraith.utility.selfStatus).toBe('phase');
    expect(ABILITY_TABLE.wraith.secondary.selfStatus).toBe('veil');
    expect(ABILITY_TABLE.bastion.secondary.selfStatus).toBe('shield');
    expect(ABILITY_TABLE.wraith.ultimate.status).toBe('blind');
    expect(MATCH_TUNING.respawnDelayS).toBe(5);
    expect(MATCH_TUNING.spawnProtectionS).toBe(2);
    // The beam outranges every other attack.
    const lance = ABILITY_TABLE.tempest.primary.range;
    expect(lance).toBeGreaterThan(PROJECTILE_DEFS.fireBolt.speed * PROJECTILE_DEFS.fireBolt.lifeS);
    expect(lance).toBeGreaterThan(ABILITY_TABLE.bastion.primary.range * 5);
  });
});

describe('projectile and zone tables', () => {
  it('fit the wire: 4-bit kinds, u8 zone radius and time', () => {
    expect(PROJECTILE_KINDS.length).toBeLessThanOrEqual(16);
    expect(ZONE_KINDS.length).toBeLessThanOrEqual(16);
    expect(STATUS_KINDS.length).toBeLessThanOrEqual(255);
    for (const kind of ZONE_KINDS) {
      const def = ZONE_DEFS[kind];
      expect(def.radius, kind).toBeLessThanOrEqual(127.5);
      expect(def.durationS, kind).toBeLessThanOrEqual(25.4);
    }
    for (const kind of PROJECTILE_KINDS) {
      const def = PROJECTILE_DEFS[kind];
      expect(def.speed, kind).toBeGreaterThan(0);
      expect(def.lifeS, kind).toBeGreaterThan(0);
      expect(def.radius, kind).toBeGreaterThanOrEqual(0);
    }
  });

  it('only replicates by event what a client can fly from the cast event alone', () => {
    // An `abilityCast` event has a position and a direction: no caster velocity. A bolt that
    // inherits velocity, or that explodes or leaves a zone (the host says where), must be a
    // snapshot record.
    for (const kind of PROJECTILE_KINDS) {
      const def = PROJECTILE_DEFS[kind];
      if (def.replication !== 'event') continue;
      expect(def.inheritVelocity, kind).toBe(0);
      expect(def.blastRadius, kind).toBe(0);
      expect(def.zoneOnEnd, kind).toBeNull();
    }
    expect(PROJECTILE_DEFS.fireBolt.replication).toBe('event');
    expect(PROJECTILE_DEFS.meteorBomb.replication).toBe('snapshot');
  });

  it('sizes the pools for 10 dragons holding fire', () => {
    const talon = ABILITY_TABLE.talon.primary;
    const boltsEach = Math.ceil(PROJECTILE_DEFS.fireBolt.lifeS / talon.cooldownS);
    expect(MAX_PROJECTILES).toBeGreaterThanOrEqual(boltsEach * 10);
    expect(SNAPSHOT_MAX_PROJECTILES).toBeLessThanOrEqual(MAX_PROJECTILES);
    expect(SNAPSHOT_MAX_ZONES).toBeLessThanOrEqual(MAX_ZONES);
    expect(MAX_ASSISTS).toBeGreaterThanOrEqual(4);
    expect(COMBAT_TUNING.shieldBlock).toBeGreaterThan(0);
    expect(COMBAT_TUNING.hitRadiusScale).toBeGreaterThanOrEqual(1);
  });
});

describe('dragon flags', () => {
  it('are sixteen distinct bits', () => {
    const flags = [
      DRAGON_FLAG_ALIVE,
      DRAGON_FLAG_BOOSTING,
      DRAGON_FLAG_DODGING,
      DRAGON_FLAG_SPAWN_PROTECTED,
      DRAGON_FLAG_SHIELDED,
      DRAGON_FLAG_VEILED,
      DRAGON_FLAG_PHASING,
      DRAGON_FLAG_IN_STORM,
      DRAGON_FLAG_STALLED,
      DRAGON_FLAG_SLOWED,
      DRAGON_FLAG_BURNING,
      DRAGON_FLAG_BLINDED,
      DRAGON_FLAG_HASTED,
      DRAGON_FLAG_CHARGING,
      DRAGON_FLAG_FIRING,
      DRAGON_FLAG_REGEN,
    ];
    let all = 0;
    for (const flag of flags) {
      expect(flag & (flag - 1)).toBe(0);
      expect(all & flag).toBe(0);
      all |= flag;
    }
    expect(all).toBe(0xffff);
  });
});

describe('InputFrame aim', () => {
  it('has an aim bit inside the mask and ability buttons in slot order', () => {
    expect(BUTTON_MASK & BUTTON_AIM).toBe(BUTTON_AIM);
    expect(BUTTON_MASK).toBeLessThanOrEqual(0xffff);
    ABILITY_SLOTS.forEach((_slot, i) => {
      expect(BUTTON_ABILITY_MASK & (BUTTON_PRIMARY << i)).toBe(BUTTON_PRIMARY << i);
    });
    expect(BUTTON_PRIMARY << 3).toBe(BUTTON_ULTIMATE);
    // Ability slots double as damage sources.
    ABILITY_SLOTS.forEach((slot, i) => expect(DAMAGE_SOURCES[i]).toBe(slot));
  });

  it('copies and sanitizes the aim', () => {
    const frame = createInputFrame();
    frame.aimYaw = 7;
    frame.aimPitch = -3;
    const copy = copyInputFrame(createInputFrame(), frame);
    expect(copy.aimYaw).toBe(7);
    expect(copy.aimPitch).toBe(-3);
    sanitizeInputFrame(frame);
    expect(frame.aimYaw).toBeCloseTo(7 - Math.PI * 2, 12);
    expect(frame.aimPitch).toBe(-Math.PI / 2);
    expect(clampAimYaw(Number.NaN)).toBe(0);
    expect(clampAimYaw(Infinity)).toBe(0);
    expect(clampAimYaw(-Math.PI)).toBe(-Math.PI);
    expect(clampAimYaw(Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(clampAimPitch(Number.NaN)).toBe(0);
    expect(clampAimPitch(Infinity)).toBe(Math.PI / 2);
    expect(clampAimPitch(0.3)).toBe(0.3);
  });
});

describe('WorldView combat pieces', () => {
  it('hands out zone slots as permanent and ownerless until told otherwise', () => {
    const view = createWorldView();
    const zone = acquireZoneView(view);
    expect(zone.ownerId).toBe(NO_PLAYER);
    expect(zone.remainingS).toBe(Infinity);
    zone.ownerId = 3;
    zone.remainingS = 2;
    beginWorldView(view);
    // The slot is reused: a builder that does not know the new fields still gets sane values.
    const again = acquireZoneView(view);
    expect(again).toBe(zone);
    expect(again.ownerId).toBe(NO_PLAYER);
    expect(again.remainingS).toBe(Infinity);
  });

  it('marks the local combat view invalid at the start of every frame', () => {
    const view = createWorldView();
    expect(view.local.valid).toBe(false);
    view.local.valid = true;
    beginWorldView(view);
    expect(view.local.valid).toBe(false);
  });

  function source(overrides: Partial<LocalCombatSource> = {}): LocalCombatSource {
    return {
      classId: 'tempest',
      flags: DRAGON_FLAG_ALIVE,
      stamina: 1,
      abilityCooldownTicks: [0, 0, 0, 0],
      abilityChargesUsed: [0, 0, 0, 0],
      abilityActiveTicks: [0, 0, 0, 0],
      castSlot: -1,
      castTicks: 0,
      ultCharge: 0,
      dodgeCooldownTicks: 0,
      deadTicks: 0,
      lastDamagerId: NO_PLAYER,
      blindTicks: 0,
      ...overrides,
    };
  }

  it('turns the local dragon into HUD numbers', () => {
    const out = createLocalCombatView();
    const respawn = MATCH_TUNING.respawnDelayS;
    const dodge = FLIGHT_TUNING.dodgeCooldownS;

    writeLocalCombatView(out, source(), respawn, dodge);
    expect(out.valid).toBe(true);
    expect(out.cooldowns).toEqual([0, 0, 0, 0]);
    expect(out.ready).toEqual([true, true, true, false]);
    expect(out.charges).toEqual([1, 2, 1, 1]);
    expect(out.maxCharges).toEqual([1, 2, 1, 1]);
    expect(out.castSlot).toBe(-1);
    expect(out.respawnInS).toBe(0);
    expect(out.killerId).toBe(NO_PLAYER);

    // Half a cooldown left on the utility, one mine thrown and recharging, the ultimate full.
    const utilityTicks = Math.ceil(ABILITY_TABLE.tempest.utility.cooldownS * TICK_HZ);
    writeLocalCombatView(
      out,
      source({
        abilityCooldownTicks: [0, 100, utilityTicks / 2, 0],
        abilityChargesUsed: [0, 1, 0, 0],
        ultCharge: 1,
        dodgeCooldownTicks: Math.ceil(dodge * TICK_HZ) / 4,
        blindTicks: 45,
      }),
      respawn,
      dodge,
    );
    expect(out.cooldowns[2]).toBeCloseTo(0.5, 6);
    expect(out.cooldownS[2]).toBeCloseTo(ABILITY_TABLE.tempest.utility.cooldownS / 2, 6);
    expect(out.ready).toEqual([true, true, false, true]);
    // A charge in store: usable, so no cooldown is shown although one is recharging.
    expect(out.charges[1]).toBe(1);
    expect(out.cooldowns[1]).toBe(0);
    expect(out.ultimateCharge).toBe(1);
    expect(out.dodgeCooldown).toBeCloseTo(0.25, 6);
    expect(out.blindS).toBeCloseTo(1.5, 9);

    // Both mines out: now the recharge is the cooldown.
    writeLocalCombatView(
      out,
      source({ abilityCooldownTicks: [0, 100, 0, 0], abilityChargesUsed: [0, 2, 0, 0] }),
      respawn,
      dodge,
    );
    expect(out.charges[1]).toBe(0);
    expect(out.ready[1]).toBe(false);
    expect(out.cooldowns[1]).toBeGreaterThan(0);

    // Winding up the lance: nothing else is ready, progress runs 0 -> 1.
    const windup = Math.ceil(ABILITY_TABLE.tempest.primary.windupS * TICK_HZ);
    writeLocalCombatView(out, source({ castSlot: 0, castTicks: windup / 3 }), respawn, dodge);
    expect(out.castSlot).toBe(0);
    expect(out.castProgress).toBeCloseTo(2 / 3, 6);
    expect(out.ready).toEqual([false, false, false, false]);

    // Dead for 2 s, killed by player 4.
    writeLocalCombatView(
      out,
      source({ flags: 0, deadTicks: 2 * TICK_HZ, lastDamagerId: 4 }),
      respawn,
      dodge,
    );
    expect(out.respawnInS).toBeCloseTo(respawn - 2, 9);
    expect(out.killerId).toBe(4);
    expect(out.ready).toEqual([false, false, false, false]);
    // Respawns off: no countdown to show.
    writeLocalCombatView(out, source({ flags: 0, deadTicks: 90 }), Infinity, dodge);
    expect(out.respawnInS).toBe(Infinity);
  });
});

describe('GameEventBus: combat events', () => {
  it('delivers assist, statusApplied and impact events as copies, in order', () => {
    const bus = createGameEventBus();
    const seen: GameEvent[] = [];
    bus.on('assist', (event) => seen.push(structuredClone(event)));
    bus.on('statusApplied', (event) => seen.push(structuredClone(event)));
    bus.on('impact', (event) => seen.push(structuredClone(event)));
    const position = { x: 1, y: 2, z: 3 };
    const status: GameEvent = {
      type: 'statusApplied',
      tick: 5,
      targetId: 2,
      sourceId: 1,
      status: 'burn',
      durationS: 2.5,
      position,
    };
    bus.emit(status);
    // The emitter may reuse its objects straight away.
    position.x = 99;
    bus.emit({ type: 'assist', tick: 6, assisterId: 3, killerId: 1, victimId: 2 });
    bus.emit({
      type: 'impact',
      tick: 7,
      projectile: 'meteorBomb',
      ownerId: 1,
      targetId: NO_PLAYER,
      position,
    });
    expect(bus.pending).toBe(3);
    bus.flush();
    expect(bus.pending).toBe(0);
    expect(seen).toEqual([
      { ...status, position: { x: 1, y: 2, z: 3 } },
      { type: 'assist', tick: 6, assisterId: 3, killerId: 1, victimId: 2 },
      {
        type: 'impact',
        tick: 7,
        projectile: 'meteorBomb',
        ownerId: 1,
        targetId: NO_PLAYER,
        position: { x: 99, y: 2, z: 3 },
      },
    ]);
    // Nothing is delivered twice, and a cleared queue stays empty.
    bus.flush();
    expect(seen).toHaveLength(3);
    bus.emit({ type: 'assist', tick: 8, assisterId: 3, killerId: 1, victimId: 2 });
    bus.clear();
    bus.flush();
    expect(seen).toHaveLength(3);
  });
});
