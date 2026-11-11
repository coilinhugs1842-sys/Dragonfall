/**
 * The whole chain a player's hand goes through, checked end to end with the real modules:
 * device input -> InputFrame -> sim -> WorldView -> dragon instance matrix and chase camera.
 * Each module has its own tests; this one is about the SIGNS agreeing between them (mouse
 * forward climbs, mouse right turns right and drops the right wing, the camera is behind and
 * the same way up), and about the autopilot that stands in for the hand.
 */
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { writeInstanceMatrix } from '../../src/dragons';
import { AUTOPILOT_CYCLE_TICKS, writeAutopilotFrame } from '../../src/game/autopilot';
import type { AutopilotCourse } from '../../src/game/autopilot';
import { buildWorldView } from '../../src/game/world-view-builder';
import type { WorldViewBuildOptions } from '../../src/game/world-view-builder';
import {
  DEFAULT_INPUT_OPTIONS,
  createInputState,
  inputCodeDown,
  inputMouseMove,
  sampleInput,
} from '../../src/input';
import type { InputState } from '../../src/input';
import { ChaseCamera } from '../../src/render';
import {
  BUTTON_MASK,
  DRAGON_FLAG_ALIVE,
  TEAM_EMBER,
  TICK_DT_S,
  TICK_HZ,
  createGreyboxSpires,
  createInputFrame,
  createWorldView,
  findDragonView,
} from '../../src/shared';
import type { DragonView, InputFrame } from '../../src/shared';
import { createMapCollisionWorld, createSim } from '../../src/sim';

const ID = 0;
const OPTIONS: WorldViewBuildOptions = { localDragonId: ID, stormWall: null, phase: 'playing' };

interface Flight {
  dragon: DragonView;
  camera: ChaseCamera;
  frame: InputFrame;
}

/** Flies `ticks` ticks of open sky, facing +Z, with whatever `drive` does to the devices. */
function fly(ticks: number, drive: (state: InputState) => void): Flight {
  const state = createInputState();
  const sim = createSim();
  sim.spawnDragon(ID, TEAM_EMBER, 'talon', { x: 0, y: 300, z: 0 }, 0);
  const frame = createInputFrame();
  const inputs: InputFrame[] = [frame];
  const view = createWorldView();
  const camera = new ChaseCamera();
  for (let tick = 0; tick < ticks; tick++) {
    drive(state);
    sampleInput(state, tick, frame);
    sim.step(tick, inputs);
    buildWorldView(view, sim.prev, sim.current, 1, OPTIONS);
    const dragon = findDragonView(view, ID);
    if (dragon === undefined) throw new Error('no dragon in the view');
    camera.setAim(frame.steerX, frame.steerY);
    camera.update(dragon, TICK_DT_S);
  }
  const dragon = findDragonView(view, ID);
  if (dragon === undefined) throw new Error('no dragon in the view');
  return { dragon, camera, frame };
}

/** World-space axes of the dragon MODEL as the instanced mesh will draw it. */
function modelAxes(dragon: DragonView): { left: Vector3; up: Vector3; nose: Vector3 } {
  const elements = new Float32Array(16);
  writeInstanceMatrix(elements, 0, dragon.position, dragon.orientation);
  const matrix = new Matrix4().fromArray(elements);
  return {
    left: new Vector3(1, 0, 0).transformDirection(matrix),
    up: new Vector3(0, 1, 0).transformDirection(matrix),
    nose: new Vector3(0, 0, 1).transformDirection(matrix),
  };
}

describe('input -> sim -> view sign chain', () => {
  it('has invert-Y off by default', () => {
    expect(DEFAULT_INPUT_OPTIONS.invertY).toBe(false);
    expect(DEFAULT_INPUT_OPTIONS.invertKeyPitch).toBe(false);
  });

  it('hands off: level along +Z, right way up, camera behind and above looking forward', () => {
    const { dragon, camera } = fly(30, () => {});
    const { nose, up, left } = modelAxes(dragon);
    expect(nose.z).toBeGreaterThan(0.999);
    expect(up.y).toBeGreaterThan(0.999);
    expect(left.x).toBeGreaterThan(0.999);
    expect(dragon.velocity.z).toBeGreaterThan(40);
    expect(dragon.position.z).toBeGreaterThan(40);

    // Behind (smaller z) and above; looking down its own -Z toward +Z, so the dragon's tail
    // faces the camera and the dragon flies INTO the screen.
    expect(camera.position.z).toBeLessThan(dragon.position.z - 8);
    expect(camera.position.y).toBeGreaterThan(dragon.position.y);
    const lookDirection = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(lookDirection.z).toBeGreaterThan(0.99);
    const cameraUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    expect(cameraUp.y).toBeGreaterThan(0.99);
    // Screen right is the dragon's right (-X while facing +Z): no mirror image.
    const cameraRight = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    expect(cameraRight.x).toBeLessThan(-0.99);
    expect(cameraRight.dot(left)).toBeLessThan(-0.99);
  });

  it('mouse pushed forward (screen up) raises the nose and climbs', () => {
    const { dragon, frame } = fly(30, (state) => inputMouseMove(state, 0, -40));
    expect(frame.steerY).toBeGreaterThan(0.5);
    expect(modelAxes(dragon).nose.y).toBeGreaterThan(0.3);
    expect(dragon.velocity.y).toBeGreaterThan(5);
    expect(dragon.position.y).toBeGreaterThan(300);
  });

  it('mouse pulled back lowers the nose and dives', () => {
    const { dragon, frame } = fly(30, (state) => inputMouseMove(state, 0, 40));
    expect(frame.steerY).toBeLessThan(-0.5);
    expect(modelAxes(dragon).nose.y).toBeLessThan(-0.3);
    expect(dragon.position.y).toBeLessThan(300);
  });

  it('W climbs and S dives, like the mouse', () => {
    const up = fly(30, (state) => inputCodeDown(state, 'KeyW'));
    expect(up.dragon.position.y).toBeGreaterThan(300);
    const down = fly(30, (state) => inputCodeDown(state, 'KeyS'));
    expect(down.dragon.position.y).toBeLessThan(300);
  });

  it('mouse right turns right: screen right, right wing down, camera leaning with it', () => {
    const { dragon, camera, frame } = fly(45, (state) => inputMouseMove(state, 40, 0));
    expect(frame.steerX).toBeGreaterThan(0.5);
    const { nose, left } = modelAxes(dragon);
    // Facing +Z the dragon's right is -X.
    expect(nose.x).toBeLessThan(-0.3);
    expect(dragon.position.x).toBeLessThan(-5);
    // Banked into the turn: the left wing is the high one.
    expect(left.y).toBeGreaterThan(0.2);

    // On screen the dragon's nose points to the right of the camera's view direction.
    const cameraRight = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    expect(nose.dot(cameraRight)).toBeGreaterThan(0.05);
    // And the camera leans the same way as the dragon (its right side is the low one).
    expect(cameraRight.y).toBeLessThan(-0.01);
  });

  it('D turns right and A turns left', () => {
    const right = fly(45, (state) => inputCodeDown(state, 'KeyD'));
    expect(right.dragon.position.x).toBeLessThan(-1);
    expect(modelAxes(right.dragon).left.y).toBeGreaterThan(0.1);
    const left = fly(45, (state) => inputCodeDown(state, 'KeyA'));
    expect(left.dragon.position.x).toBeGreaterThan(1);
    expect(modelAxes(left.dragon).left.y).toBeLessThan(-0.1);
  });
});

describe('autopilot', () => {
  const map = createGreyboxSpires();
  const course: AutopilotCourse = {
    centerX: map.colliders.stormCenter.x,
    centerZ: map.colliders.stormCenter.z,
    radius: 380,
    altitude: 400,
  };

  it('is neutral without a dragon and always writes a legal frame', () => {
    const frame = createInputFrame();
    frame.steerX = 1;
    frame.buttons = 3;
    writeAutopilotFrame(12, undefined, course, frame);
    expect(frame).toEqual({
      tick: 12,
      steerX: 0,
      steerY: 0,
      buttons: 0,
      aimYaw: 0,
      aimPitch: 0,
    });
    const still = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
    expect(writeAutopilotFrame(3, still, course, frame).steerX).toBe(0);
    const lost = { position: { x: NaN, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 40 } };
    writeAutopilotFrame(3, lost, course, frame);
    expect(Number.isFinite(frame.steerX) && Number.isFinite(frame.steerY)).toBe(true);
  });

  it('uses every flight button over one cycle', () => {
    const frame = createInputFrame();
    const subject = { position: { x: 0, y: 400, z: -380 }, velocity: { x: 45, y: 0, z: 0 } };
    let seen = 0;
    for (let tick = 0; tick < AUTOPILOT_CYCLE_TICKS; tick++) {
      writeAutopilotFrame(tick, subject, course, frame);
      expect(Math.abs(frame.steerX)).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.steerY)).toBeLessThanOrEqual(1);
      expect(frame.buttons & ~BUTTON_MASK).toBe(0);
      seen |= frame.buttons;
    }
    // boost, flap, dive, dodge left, dodge right
    expect(seen & 0b11111).toBe(0b11111);
  });

  it('flies the greybox map for three minutes inside the arena, the same way every time', () => {
    const ticks = 180 * TICK_HZ;
    const run = (): Record<string, number | string> => {
      const collision = createMapCollisionWorld(map);
      const sim = createSim({ collisionWorld: collision });
      const slot = map.spawnGates[TEAM_EMBER]?.slots[2];
      if (slot === undefined) throw new Error('no spawn slot');
      sim.spawnDragon(ID, TEAM_EMBER, 'talon', slot, 0);
      const frame = createInputFrame();
      const inputs: InputFrame[] = [frame];
      let deaths = 0;
      let terrainHits = 0;
      let stormTicks = 0;
      let travelled = 0;
      let maxRadius = 0;
      let minY = Infinity;
      let maxY = -Infinity;
      collision.onTerrainHit = () => {
        terrainHits++;
      };
      for (let tick = 0; tick < ticks; tick++) {
        writeAutopilotFrame(tick, sim.getDragon(ID), course, frame);
        sim.step(tick, inputs);
        const dragon = sim.getDragon(ID);
        if (dragon === undefined) throw new Error('dragon vanished');
        if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0) {
          deaths++;
          sim.spawnDragon(ID, TEAM_EMBER, 'talon', slot, 0);
          continue;
        }
        const { x, y, z } = dragon.position;
        const radius = Math.hypot(x, z);
        travelled +=
          Math.hypot(dragon.velocity.x, dragon.velocity.y, dragon.velocity.z) * TICK_DT_S;
        maxRadius = Math.max(maxRadius, radius);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        if (radius > map.colliders.stormRadius) stormTicks++;
      }
      const end = JSON.stringify(sim.getDragon(ID));
      return { deaths, terrainHits, stormTicks, travelled, maxRadius, minY, maxY, end };
    };
    const first = run();
    expect(first['stormTicks']).toBe(0);
    expect(first['maxRadius']).toBeLessThan(map.colliders.stormRadius);
    expect(first['minY']).toBeGreaterThan(map.colliders.cloudSeaY);
    expect(first['maxY']).toBeLessThan(map.colliders.ceilingY);
    // It really flew: three minutes at cruise speed is about 8 km.
    expect(first['travelled']).toBeGreaterThan(6000);
    expect(first['deaths']).toBe(0);
    expect(run()).toEqual(first);
  });
});
