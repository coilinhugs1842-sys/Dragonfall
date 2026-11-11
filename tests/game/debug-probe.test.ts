import { describe, expect, it } from 'vitest';
import { createDebugProbe } from '../../src/game/debug-probe';
import {
  DRAGON_FLAG_ALIVE,
  TEAM_EMBER,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type { MutableWorldView } from '../../src/shared';
import { createSim } from '../../src/sim';

const DT = 1 / 60;

function frame(view: MutableWorldView, id: number, x: number, vx: number, alive = true): void {
  beginWorldView(view);
  const dragon = acquireDragonView(view);
  dragon.id = id;
  dragon.team = TEAM_EMBER;
  dragon.classId = 'talon';
  dragon.position.x = x;
  dragon.position.y = 0;
  dragon.position.z = 0;
  dragon.velocity.x = vx;
  dragon.velocity.y = 0;
  dragon.velocity.z = 0;
  dragon.flags = alive ? DRAGON_FLAG_ALIVE : 0;
}

describe('debug probe: motion', () => {
  it('reads zero for straight flight and the size of a pop when there is one', () => {
    const probe = createDebugProbe();
    const view = createWorldView();
    let x = 0;
    for (let i = 0; i < 60; i++) {
      frame(view, 4, x, 60);
      probe.trackFrame(view, DT);
      x += 60 * DT;
    }
    const smooth = probe.remoteMotion();
    expect(smooth.frames).toBe(59);
    expect(smooth.maxJumpM).toBeLessThan(1e-9);
    expect(smooth.backwardFrames).toBe(0);

    // Rubber band: 3 m back along the path in one frame.
    frame(view, 4, x - 3, 60);
    probe.trackFrame(view, DT);
    const popped = probe.remoteMotion();
    expect(popped.maxJumpM).toBeCloseTo(3, 6);
    expect(popped.backwardFrames).toBe(1);
    expect(popped.maxBackwardM).toBeCloseTo(2, 6);
  });

  it('keeps the local dragon apart and skips respawns, deaths and pauses', () => {
    const probe = createDebugProbe();
    const view = createWorldView();
    view.localDragonId = 2;
    frame(view, 2, 0, 60);
    view.localDragonId = 2;
    probe.trackFrame(view, DT);
    frame(view, 2, 1.5, 60);
    probe.trackFrame(view, DT);
    expect(probe.localMotion().frames).toBe(1);
    expect(probe.localMotion().maxJumpM).toBeCloseTo(0.5, 6);
    expect(probe.remoteMotion().frames).toBe(0);

    // Respawn at the gate: a teleport, not a jump.
    frame(view, 2, 900, 60);
    probe.trackFrame(view, DT);
    expect(probe.localMotion().teleports).toBe(1);
    expect(probe.localMotion().frames).toBe(1);

    // A dead dragon's fall is not counted, nor is the first frame after it lives again.
    frame(view, 2, 905, 60, false);
    probe.trackFrame(view, DT);
    frame(view, 2, 910, 60);
    probe.trackFrame(view, DT);
    expect(probe.localMotion().frames).toBe(1);

    // A long frame (tab switch) is not a motion sample.
    frame(view, 2, 990, 60);
    probe.trackFrame(view, 0.5);
    expect(probe.localMotion().frames).toBe(1);

    probe.resetMotion();
    expect(probe.localMotion()).toEqual({
      frames: 0,
      maxJumpM: 0,
      meanJumpM: 0,
      backwardFrames: 0,
      maxBackwardM: 0,
      teleports: 0,
    });
  });
});

describe('debug probe: host history', () => {
  it('returns the host position at whole and fractional ticks', () => {
    const probe = createDebugProbe();
    const sim = createSim();
    sim.spawnDragon(3, TEAM_EMBER, 'talon', { x: 0, y: 300, z: 0 }, 0);
    const z: number[] = [];
    for (let tick = 100; tick < 110; tick++) {
      sim.step(tick, []);
      probe.trackHostTick(tick, sim.current);
      z[tick] = sim.getDragon(3)?.position.z ?? NaN;
    }
    expect(probe.hostPositionAt(3, 104)?.z).toBeCloseTo(z[104] ?? NaN, 3);
    const mid = probe.hostPositionAt(3, 104.5);
    expect(mid?.z).toBeCloseTo(((z[104] ?? NaN) + (z[105] ?? NaN)) / 2, 3);
    expect(probe.hostPositionAt(3, 99)).toBeNull();
    expect(probe.hostPositionAt(3, 109.5)).toBeNull();
    expect(probe.hostPositionAt(7, 104)).toBeNull();
  });
});
