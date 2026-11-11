import { describe, expect, it } from 'vitest';
import {
  BUTTON_PRIMARY,
  CLASS_TUNING,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BURNING,
  HUD_COMPASS_MARKERS,
  HUD_DAMAGE_ARCS,
  HUD_KILLFEED_ROWS,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  createLocalCombatView,
} from '../../src/shared';
import type { DragonView, HudState, MatchClockView } from '../../src/shared';
import { DAMAGE_ARC_LIFE_S, KILLFEED_LIFE_S } from '../../src/ui/hud/hud-model';
import {
  ageHudState,
  createHudState,
  pushDamageArc,
  pushKillfeed,
  resetHudState,
  writeHudClock,
  writeHudLocal,
} from '../../src/ui/hud/hud-state';
import type { MutableHudState } from '../../src/ui/hud/hud-state';

function kill(hud: MutableHudState, victimId: number): void {
  pushKillfeed(
    hud,
    1,
    'Killer',
    TEAM_EMBER,
    'talon',
    victimId,
    `V${victimId}`,
    TEAM_FROST,
    'primary',
  );
}

function dragon(overrides: Partial<DragonView> = {}): DragonView {
  return {
    id: 0,
    team: TEAM_EMBER,
    classId: 'bastion',
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 3, y: 0, z: 4 },
    health: 0.5,
    stamina: 0.25,
    flags: DRAGON_FLAG_ALIVE | DRAGON_FLAG_BURNING,
    anim: 0,
    ...overrides,
  };
}

describe('createHudState', () => {
  it('is assignable to HudState and sized to the HUD pools', () => {
    const hud = createHudState();
    const asContract: HudState = hud;
    expect(asContract.killfeed).toHaveLength(HUD_KILLFEED_ROWS);
    expect(hud.damageArcs).toHaveLength(HUD_DAMAGE_ARCS);
    expect(hud.compass).toHaveLength(HUD_COMPASS_MARKERS);
    expect(hud.scoreboard).toHaveLength(10);
    expect(hud.killfeedCount).toBe(0);
    expect(hud.local).toBeNull();
    expect(hud.localPlayerId).toBe(NO_PLAYER);
    for (const arc of hud.damageArcs) expect(arc.ageS).toBeGreaterThanOrEqual(DAMAGE_ARC_LIFE_S);
  });
});

describe('killfeed ring', () => {
  it('keeps the newest first and drops the oldest past five', () => {
    const hud = createHudState();
    for (let victim = 10; victim < 17; victim++) kill(hud, victim);
    expect(hud.killfeedCount).toBe(HUD_KILLFEED_ROWS);
    expect(hud.killfeed.map((entry) => entry.victimId)).toEqual([16, 15, 14, 13, 12]);
  });

  it('reuses the pooled entries instead of allocating', () => {
    const hud = createHudState();
    const pool = new Set(hud.killfeed);
    for (let victim = 0; victim < 23; victim++) kill(hud, victim);
    expect(hud.killfeed).toHaveLength(HUD_KILLFEED_ROWS);
    for (const entry of hud.killfeed) expect(pool.has(entry)).toBe(true);
    expect(new Set(hud.killfeed).size).toBe(HUD_KILLFEED_ROWS);
  });

  it('fills every field of the new entry', () => {
    const hud = createHudState();
    const entry = pushKillfeed(hud, NO_PLAYER, '', null, null, 4, 'Wren', TEAM_FROST, 'storm');
    expect(entry).toBe(hud.killfeed[0]);
    expect(entry).toMatchObject({
      killerId: NO_PLAYER,
      killerTeam: null,
      killerClassId: null,
      victimId: 4,
      victimName: 'Wren',
      victimTeam: TEAM_FROST,
      source: 'storm',
      ageS: 0,
    });
  });

  it('ages entries and expires them from the end', () => {
    const hud = createHudState();
    kill(hud, 1);
    ageHudState(hud, KILLFEED_LIFE_S - 1);
    kill(hud, 2);
    expect(hud.killfeedCount).toBe(2);
    ageHudState(hud, 0.5);
    expect(hud.killfeedCount).toBe(2);
    expect(hud.killfeed[0]?.ageS).toBeCloseTo(0.5);
    ageHudState(hud, 0.6);
    expect(hud.killfeedCount).toBe(1);
    expect(hud.killfeed[0]?.victimId).toBe(2);
    ageHudState(hud, KILLFEED_LIFE_S);
    expect(hud.killfeedCount).toBe(0);
    // A paused or backwards frame changes nothing.
    kill(hud, 3);
    ageHudState(hud, 0);
    ageHudState(hud, -1);
    ageHudState(hud, Number.NaN);
    expect(hud.killfeed[0]?.ageS).toBe(0);
  });
});

describe('damage arcs', () => {
  it('takes free entries, then merges hits from the same side', () => {
    const hud = createHudState();
    expect(pushDamageArc(hud, -1.5, 0.5)).toBe(0);
    expect(pushDamageArc(hud, 1.5, 0.5)).toBe(1);
    ageHudState(hud, 0.4);
    // Same attacker keeps firing from the left: the first arc is refreshed, not a third one lit.
    expect(pushDamageArc(hud, -1.45, 0.2)).toBe(0);
    expect(hud.damageArcs[0]?.ageS).toBe(0);
    expect(hud.damageArcs[0]?.angle).toBe(-1.45);
    // It keeps the harder of the two hits.
    expect(hud.damageArcs[0]?.strength).toBe(0.5);
    expect(hud.damageArcs[1]?.ageS).toBeCloseTo(0.4);
  });

  it('clamps strength and recycles the oldest when all four are lit', () => {
    const hud = createHudState();
    pushDamageArc(hud, 0, 5);
    expect(hud.damageArcs[0]?.strength).toBe(1);
    ageHudState(hud, 0.3);
    pushDamageArc(hud, 1.5, -1);
    expect(hud.damageArcs[1]?.strength).toBe(0);
    ageHudState(hud, 0.1);
    pushDamageArc(hud, 3, 0.5);
    pushDamageArc(hud, -1.5, 0.5);
    expect(pushDamageArc(hud, 0.75, 0.5)).toBe(0);
  });

  it('stops ageing an arc once it has expired', () => {
    const hud = createHudState();
    pushDamageArc(hud, 0, 1);
    ageHudState(hud, DAMAGE_ARC_LIFE_S + 0.1);
    const settled = hud.damageArcs[0]?.ageS;
    ageHudState(hud, 100);
    expect(hud.damageArcs[0]?.ageS).toBe(settled);
  });
});

describe('writeHudLocal', () => {
  it('copies the dragon and its combat view', () => {
    const hud = createHudState();
    const combat = createLocalCombatView();
    combat.valid = true;
    combat.ultimateCharge = 0.4;
    combat.cooldowns[1] = 0.5;
    combat.cooldownS[1] = 4;
    combat.charges[1] = 0;
    combat.maxCharges[1] = 2;
    combat.ready[0] = true;
    combat.castSlot = 2;
    combat.castProgress = 0.3;
    combat.blindS = 1.5;
    combat.killerId = 7;
    const local = writeHudLocal(hud.localPool, dragon(), combat, BUTTON_PRIMARY, 0b0100);
    expect(local).toBe(hud.localPool);
    expect(local).toMatchObject({
      classId: 'bastion',
      alive: true,
      health: 0.5,
      stamina: 0.25,
      speed: 5,
      healthMax: CLASS_TUNING.bastion.maxHp,
      ultimateCharge: 0.4,
      castSlot: 2,
      castProgress: 0.3,
      blindS: 1.5,
      killerId: 7,
      buttons: BUTTON_PRIMARY,
    });
    expect(local.flags & DRAGON_FLAG_BURNING).not.toBe(0);
    expect(local.cooldowns.secondary).toBe(0.5);
    expect(local.cooldownS[1]).toBe(4);
    expect(local.maxCharges[1]).toBe(2);
    expect(local.ready[0]).toBe(true);
    expect(local.active).toEqual([false, false, true, false]);
  });

  it('shows no health for a downed dragon and keeps old gauges without a valid combat view', () => {
    const hud = createHudState();
    hud.localPool.ultimateCharge = 0.8;
    const local = writeHudLocal(
      hud.localPool,
      dragon({ flags: 0, health: 0.3 }),
      createLocalCombatView(),
      0,
    );
    expect(local.alive).toBe(false);
    expect(local.health).toBe(0);
    expect(local.ultimateCharge).toBe(0.8);
  });
});

describe('writeHudClock and reset', () => {
  const clock = (overrides: Partial<MatchClockView>): MatchClockView => ({
    tick: 0,
    phase: 'playing',
    phaseTimeS: 0,
    timeRemainingS: 300,
    round: 1,
    ...overrides,
  });

  it('derives the whole-second 3-2-1', () => {
    const hud = createHudState();
    writeHudClock(hud, clock({ phase: 'countdown', phaseTimeS: 0.2, round: 2 }), 3);
    expect(hud.countdown).toBe(3);
    expect(hud.round).toBe(2);
    writeHudClock(hud, clock({ phase: 'countdown', phaseTimeS: 2.01 }), 3);
    expect(hud.countdown).toBe(1);
    writeHudClock(hud, clock({ phase: 'countdown', phaseTimeS: 3 }), 3);
    expect(hud.countdown).toBe(0);
    writeHudClock(hud, clock({ phaseTimeS: 1 }), 3);
    expect(hud.countdown).toBe(0);
    expect(hud.phase).toBe('playing');
    expect(hud.timeRemainingS).toBe(300);
  });

  it('resets for a new match without replacing the pools', () => {
    const hud = createHudState();
    const feed = hud.killfeed;
    const arcs = hud.damageArcs;
    kill(hud, 3);
    pushDamageArc(hud, 1, 1);
    hud.local = hud.localPool;
    hud.hitSeq = 9;
    hud.scores[0] = 4;
    hud.spectators.push('x');
    resetHudState(hud);
    expect(hud.killfeed).toBe(feed);
    expect(hud.damageArcs).toBe(arcs);
    expect(hud.killfeedCount).toBe(0);
    expect(hud.local).toBeNull();
    expect(hud.hitSeq).toBe(0);
    expect(hud.scores).toEqual([0, 0]);
    expect(hud.spectators).toEqual([]);
    for (const arc of hud.damageArcs) expect(arc.ageS).toBe(Infinity);
  });
});
