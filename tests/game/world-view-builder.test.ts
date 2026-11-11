import { describe, expect, it } from 'vitest';
import { STORM_WALL_ZONE_ID, buildWorldView, nlerpQuat } from '../../src/game/world-view-builder';
import type { WorldViewBuildOptions } from '../../src/game/world-view-builder';
import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  createInputFrame,
  createQuat,
  createWorldView,
  findDragonView,
} from '../../src/shared';
import { createSim } from '../../src/sim';

const OPTIONS: WorldViewBuildOptions = { localDragonId: 4, stormWall: null, phase: 'playing' };

function length4(q: { x: number; y: number; z: number; w: number }): number {
  return Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
}

describe('buildWorldView past the newest state', () => {
  it('holds at current by default and extrapolates only up to maxAlpha', () => {
    const sim = createSim();
    sim.spawnDragon(1, 0, 'talon', { x: 0, y: 300, z: 0 }, 0);
    sim.step(0, []);
    sim.step(1, []);
    const before = sim.prev.dragons.find((dragon) => dragon.active);
    const now = sim.current.dragons.find((dragon) => dragon.active);
    if (before === undefined || now === undefined) throw new Error('no dragon');
    const stepZ = now.position.z - before.position.z;
    expect(stepZ).toBeGreaterThan(0.5);

    const view = createWorldView();
    const options = { localDragonId: 1, stormWall: null, phase: 'playing' as const };
    buildWorldView(view, sim.prev, sim.current, 1.4, options);
    expect(view.dragons[0]?.position.z).toBeCloseTo(now.position.z, 9);

    buildWorldView(view, sim.prev, sim.current, 1.4, { ...options, maxAlpha: 1.5 });
    expect(view.dragons[0]?.position.z).toBeCloseTo(now.position.z + stepZ * 0.4, 9);
    const q = view.dragons[0]?.orientation;
    expect(Math.hypot(q?.x ?? 0, q?.y ?? 0, q?.z ?? 0, q?.w ?? 0)).toBeCloseTo(1, 9);

    buildWorldView(view, sim.prev, sim.current, 9, { ...options, maxAlpha: 1.5 });
    expect(view.dragons[0]?.position.z).toBeCloseTo(now.position.z + stepZ * 0.5, 9);

    // A dragon (re)spawned this tick has no motion to carry on: it stays where it is.
    sim.spawnDragon(1, 0, 'talon', { x: 50, y: 310, z: -20 }, 0);
    buildWorldView(view, sim.prev, sim.current, 1.5, { ...options, maxAlpha: 1.5 });
    expect(view.dragons[0]?.position).toEqual({ x: 50, y: 310, z: -20 });
  });
});

describe('nlerpQuat', () => {
  it('returns the ends at 0 and 1 and a unit quaternion in between', () => {
    const a = createQuat(0, 0, 0, 1);
    const b = createQuat(0, Math.sin(0.4), 0, Math.cos(0.4));
    const out = createQuat();
    expect(nlerpQuat(out, a, b, 0)).toEqual(a);
    nlerpQuat(out, a, b, 1);
    expect(out.y).toBeCloseTo(b.y, 12);
    expect(out.w).toBeCloseTo(b.w, 12);
    nlerpQuat(out, a, b, 0.5);
    expect(length4(out)).toBeCloseTo(1, 12);
    // Half way round the same axis.
    expect(out.y).toBeCloseTo(Math.sin(0.2), 6);
  });

  it('takes the shorter arc when the ends have opposite signs', () => {
    const a = createQuat(0, 0, 0, 1);
    const b = createQuat(0, -Math.sin(0.1), 0, -Math.cos(0.1));
    const out = nlerpQuat(createQuat(), a, b, 0.5);
    expect(length4(out)).toBeCloseTo(1, 12);
    expect(Math.abs(out.w)).toBeGreaterThan(0.99);
  });

  it('falls back to the target when the blend has no length', () => {
    const zero = createQuat(0, 0, 0, 0);
    const target = createQuat(0, 1, 0, 0);
    expect(nlerpQuat(createQuat(), zero, target, 0)).toEqual(target);
    // Orthogonal ends blend fine.
    expect(length4(nlerpQuat(createQuat(), createQuat(1, 0, 0, 0), target, 0.5))).toBeCloseTo(
      1,
      12,
    );
  });
});

describe('buildWorldView', () => {
  it('interpolates positions between the two latest ticks', () => {
    const sim = createSim();
    sim.spawnDragon(4, TEAM_EMBER, 'talon', { x: 0, y: 300, z: 0 }, 0);
    sim.step(0, []);
    sim.step(1, []);
    const prev = sim.prev.dragons[0];
    const current = sim.current.dragons[0];
    if (prev === undefined || current === undefined) throw new Error('no dragon');
    expect(current.position.z).toBeGreaterThan(prev.position.z);

    const view = createWorldView();
    buildWorldView(view, sim.prev, sim.current, 0, OPTIONS);
    expect(view.dragonCount).toBe(1);
    expect(view.dragons[0]?.position.z).toBeCloseTo(prev.position.z, 12);
    buildWorldView(view, sim.prev, sim.current, 1, OPTIONS);
    expect(view.dragons[0]?.position.z).toBeCloseTo(current.position.z, 12);
    buildWorldView(view, sim.prev, sim.current, 0.25, OPTIONS);
    expect(view.dragons[0]?.position.z).toBeCloseTo(
      prev.position.z + (current.position.z - prev.position.z) * 0.25,
      12,
    );
    expect(view.dragonCount).toBe(1);
    expect(view.dragons).toHaveLength(1);
  });

  it('leaves a veiled dragon out for the other team only, as a snapshot would', () => {
    const sim = createSim();
    sim.spawnDragon(4, TEAM_EMBER, 'talon', { x: 0, y: 300, z: 0 }, 0);
    sim.spawnDragon(5, TEAM_FROST, 'wraith', { x: 30, y: 300, z: 0 }, 0);
    sim.spawnDragon(6, TEAM_FROST, 'talon', { x: 60, y: 300, z: 0 }, 0);
    const wraith = sim.getDragon(5);
    if (wraith === undefined) throw new Error('no dragon');
    wraith.veilTicks = 90;
    sim.step(0, []);
    sim.step(1, []);
    expect(wraith.flags & DRAGON_FLAG_VEILED).not.toBe(0);

    const view = createWorldView();
    // An enemy rider: nothing of the veiled dragon reaches any view.
    buildWorldView(view, sim.prev, sim.current, 1, OPTIONS);
    expect(view.dragonCount).toBe(2);
    expect(findDragonView(view, 5)).toBeUndefined();
    // Its own team and a spectator still get it, flagged.
    buildWorldView(view, sim.prev, sim.current, 1, { ...OPTIONS, localDragonId: 6 });
    expect((findDragonView(view, 5)?.flags ?? 0) & DRAGON_FLAG_VEILED).not.toBe(0);
    buildWorldView(view, sim.prev, sim.current, 1, { ...OPTIONS, localDragonId: NO_PLAYER });
    expect(view.dragonCount).toBe(3);
    // The veil ends: it is back.
    for (let tick = 2; tick < 100; tick++) sim.step(tick, []);
    buildWorldView(view, sim.prev, sim.current, 1, OPTIONS);
    expect(findDragonView(view, 5)).toBeDefined();
  });

  it('clamps alpha and copies the discrete fields from the current tick', () => {
    const sim = createSim();
    sim.spawnDragon(4, TEAM_FROST, 'bastion', { x: 0, y: 300, z: 0 }, 1);
    sim.step(0, []);
    const current = sim.getDragon(4);
    if (current === undefined) throw new Error('no dragon');
    current.health = current.maxHealth / 4;
    current.stamina = 0.5;

    const view = buildWorldView(createWorldView(), sim.prev, sim.current, 7, OPTIONS);
    const dragon = findDragonView(view, 4);
    expect(dragon?.position.x).toBeCloseTo(current.position.x, 12);
    expect(dragon?.health).toBeCloseTo(0.25, 12);
    expect(dragon?.stamina).toBe(0.5);
    expect(dragon?.team).toBe(TEAM_FROST);
    expect(dragon?.classId).toBe('bastion');
    expect(dragon?.flags).toBe(current.flags);
    expect((dragon?.flags ?? 0) & DRAGON_FLAG_ALIVE).not.toBe(0);
    expect(dragon?.anim).toBe(current.anim);
    expect(view.localDragonId).toBe(4);
    expect(view.clock.tick).toBe(0);
    expect(view.clock.phase).toBe('playing');
  });

  it('shows a dragon spawned or respawned between the ticks at its new pose', () => {
    const sim = createSim();
    sim.spawnDragon(4, TEAM_EMBER, 'talon', { x: 0, y: 300, z: 0 }, 0);
    sim.step(0, []);
    sim.step(1, []);
    // Respawn far away: spawnDragon writes both buffers, so nothing sweeps across the map.
    sim.spawnDragon(4, TEAM_EMBER, 'talon', { x: 500, y: 200, z: -500 }, 0);
    const view = buildWorldView(createWorldView(), sim.prev, sim.current, 0.5, OPTIONS);
    expect(view.dragons[0]?.position).toEqual({ x: 500, y: 200, z: -500 });

    // A slot that is free in `prev` (or holds someone else) is not interpolated from.
    const prevSlot = sim.prev.dragons[0];
    if (prevSlot === undefined) throw new Error('no slot');
    prevSlot.id = 9;
    prevSlot.position.x = -9999;
    buildWorldView(view, sim.prev, sim.current, 0.5, OPTIONS);
    expect(view.dragons[0]?.position.x).toBe(500);
    prevSlot.active = false;
    buildWorldView(view, sim.prev, sim.current, 0.5, OPTIONS);
    expect(view.dragons[0]?.position.x).toBe(500);
  });

  it('skips free slots, keeps unit orientations and reuses its pool', () => {
    const sim = createSim();
    sim.spawnDragon(1, TEAM_EMBER, 'talon', { x: 0, y: 300, z: 0 }, 0);
    sim.spawnDragon(2, TEAM_FROST, 'wraith', { x: 50, y: 300, z: 0 }, 2);
    sim.spawnDragon(3, TEAM_FROST, 'tempest', { x: 90, y: 300, z: 0 }, -2);
    sim.despawnDragon(2);
    const frame = createInputFrame();
    frame.steerX = 1;
    frame.steerY = 0.5;
    const inputs = [undefined, frame, undefined, frame];
    const view = createWorldView();
    const spectator: WorldViewBuildOptions = { ...OPTIONS, localDragonId: NO_PLAYER };
    for (let tick = 0; tick < 40; tick++) {
      sim.step(tick, inputs);
      buildWorldView(view, sim.prev, sim.current, 0.37, spectator);
      expect(view.dragonCount).toBe(2);
      for (let i = 0; i < view.dragonCount; i++) {
        const dragon = view.dragons[i];
        if (dragon === undefined) throw new Error('missing slot');
        expect(length4(dragon.orientation)).toBeCloseTo(1, 9);
      }
    }
    const first = view.dragons[0];
    buildWorldView(view, sim.prev, sim.current, 0.5, OPTIONS);
    expect(view.dragons[0]).toBe(first);
    expect(view.dragons).toHaveLength(2);
    expect(findDragonView(view, 2)).toBeUndefined();
  });

  it('publishes the storm wall as a zone, read live', () => {
    const sim = createSim();
    const storm = { stormCenterX: 10, stormCenterZ: -20, stormRadius: 1000 };
    const options: WorldViewBuildOptions = { ...OPTIONS, stormWall: storm };
    const view = buildWorldView(createWorldView(), sim.prev, sim.current, 0, options);
    expect(view.zoneCount).toBe(1);
    expect(view.zones[0]).toEqual({
      id: STORM_WALL_ZONE_ID,
      kind: 'stormWall',
      team: null,
      position: { x: 10, y: 0, z: -20 },
      radius: 1000,
      ownerId: NO_PLAYER,
      remainingS: Infinity,
    });
    storm.stormRadius = 600;
    buildWorldView(view, sim.prev, sim.current, 0, options);
    expect(view.zones[0]?.radius).toBe(600);
    buildWorldView(view, sim.prev, sim.current, 0, OPTIONS);
    expect(view.zoneCount).toBe(0);
  });
});
