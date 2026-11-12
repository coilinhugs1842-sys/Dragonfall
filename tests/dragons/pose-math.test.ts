import { describe, expect, it } from 'vitest';
import {
  accumulateClip,
  applyLocalDelta,
  bodyAngularVelocity,
  clamp,
  clipTime,
  createPoseAccumulator,
  ease,
  finishPose,
  resetPose,
  rotateBoneModelSpace,
  saturate,
} from '../../src/dragons/pose-math';
import type { BakedClip } from '../../src/dragons/pose-math';
import { FAKE_BONE_COUNT, fakeAnimRig, fakeClip } from './fake-dragon';

type Quat = readonly [number, number, number, number];

function axisAngle(x: number, y: number, z: number, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/** a * b (apply b first, then a, for column vectors). */
function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quatAt(quats: Float32Array, bone: number): Quat {
  const o = bone * 4;
  return [quats[o] as number, quats[o + 1] as number, quats[o + 2] as number, quats[o + 3] as number];
}

function length(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

function expectQuat(actual: Quat, expected: Quat, digits = 5): void {
  // q and -q are the same rotation.
  const sign = actual[0] * expected[0] + actual[1] * expected[1] + actual[2] * expected[2] +
    actual[3] * expected[3] < 0 ? -1 : 1;
  for (let i = 0; i < 4; i++) expect((actual[i] as number) * sign).toBeCloseTo(expected[i] as number, digits);
}

function expectUnitPose(quats: Float32Array, bones: number): void {
  for (let b = 0; b < bones; b++) {
    const q = quatAt(quats, b);
    expect(Number.isFinite(q[0] + q[1] + q[2] + q[3])).toBe(true);
    expect(length(q)).toBeCloseTo(1, 5);
  }
}

const REST = fakeAnimRig().restQuats;
const REST_ROOT = new Float32Array([0, 1, 0]);

describe('clipTime', () => {
  const loop: BakedClip = fakeClip(0, 2);
  const once: BakedClip = fakeClip(10, 2);

  it.each([
    // time -> a loop wraps
    [0, 0],
    [0.5, 0.5],
    [2, 0],
    [2.5, 0.5],
    [7.25, 1.25],
    [-0.5, 1.5],
    [-4.5, 1.5],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('loop: %f s -> %f s', (time, expected) => {
    expect(loop.loop).toBe(true);
    expect(clipTime(loop, time)).toBeCloseTo(expected, 6);
  });

  it.each([
    // time -> a one-shot clamps
    [0, 0],
    [1.2, 1.2],
    [2, 2],
    [9, 2],
    [-3, 0],
    [Number.NaN, 0],
  ])('one-shot: %f s -> %f s', (time, expected) => {
    expect(once.loop).toBe(false);
    expect(clipTime(once, time)).toBeCloseTo(expected, 6);
  });

  it('gives 0 for a clip without a length', () => {
    expect(clipTime({ ...loop, duration: 0 }, 1)).toBe(0);
    expect(clipTime({ ...loop, duration: Number.NaN }, 1)).toBe(0);
  });
});

describe('accumulateClip and finishPose', () => {
  it('reproduces a sample exactly and the first sample again one loop later', () => {
    const clip = fakeClip(1, 1);
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    for (const [time, frame] of [
      [0, 0],
      [7 / clip.fps, 7],
      [clip.duration, 0],
    ] as const) {
      resetPose(pose);
      accumulateClip(pose, clip, time, 1);
      finishPose(pose, REST, REST_ROOT);
      for (let b = 0; b < FAKE_BONE_COUNT; b++) {
        expectQuat(quatAt(pose.quats, b), quatAt(clip.quats, frame * FAKE_BONE_COUNT + b));
      }
      expect(pose.rootPos[1]).toBeCloseTo(clip.rootPos[frame * 3 + 1] as number, 5);
    }
  });

  it('blends between two samples instead of stepping', () => {
    const clip = fakeClip(1, 1);
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    const sample = (time: number): Float32Array => {
      resetPose(pose);
      accumulateClip(pose, clip, time, 1);
      finishPose(pose, REST, REST_ROOT);
      return pose.quats.slice();
    };
    const a = sample(3 / clip.fps);
    const b = sample(4 / clip.fps);
    const mid = sample(3.5 / clip.fps);
    for (let k = 0; k < mid.length; k++) {
      const low = Math.min(a[k] as number, b[k] as number) - 1e-4;
      const high = Math.max(a[k] as number, b[k] as number) + 1e-4;
      expect(mid[k] as number).toBeGreaterThanOrEqual(low);
      expect(mid[k] as number).toBeLessThanOrEqual(high);
    }
  });

  it.each([
    // weights of two clips: any positive pair gives unit quaternions
    [1, 0],
    [0.5, 0.5],
    [0.3, 0.7],
    [0.001, 0.999],
    [0.6, 0.6],
    [3, 5],
    [1e-5, 1e-5],
  ])('weights %f + %f give unit quaternions and a finite root', (w0, w1) => {
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    resetPose(pose);
    accumulateClip(pose, fakeClip(0, 1), 0.31, w0);
    accumulateClip(pose, fakeClip(3, 1.3), 0.77, w1);
    finishPose(pose, REST, REST_ROOT);
    expectUnitPose(pose.quats, FAKE_BONE_COUNT);
    expect(Number.isFinite((pose.rootPos[0] as number) + (pose.rootPos[1] as number))).toBe(true);
  });

  it('normalises: weights that do not sum to 1 give the same pose as those that do', () => {
    const a = createPoseAccumulator(FAKE_BONE_COUNT);
    const b = createPoseAccumulator(FAKE_BONE_COUNT);
    resetPose(a);
    resetPose(b);
    accumulateClip(a, fakeClip(0, 1), 0.2, 0.25);
    accumulateClip(a, fakeClip(2, 1), 0.6, 0.75);
    accumulateClip(b, fakeClip(0, 1), 0.2, 1);
    accumulateClip(b, fakeClip(2, 1), 0.6, 3);
    finishPose(a, REST, REST_ROOT);
    finishPose(b, REST, REST_ROOT);
    for (let k = 0; k < a.quats.length; k++) expect(a.quats[k]).toBeCloseTo(b.quats[k] as number, 5);
    for (let k = 0; k < 3; k++) expect(a.rootPos[k]).toBeCloseTo(b.rootPos[k] as number, 5);
  });

  it('weights the root position as a plain average', () => {
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    const c0 = fakeClip(0, 1);
    const c4 = fakeClip(4, 1);
    resetPose(pose);
    accumulateClip(pose, c0, 0, 0.25);
    accumulateClip(pose, c4, 0, 0.75);
    finishPose(pose, REST, REST_ROOT);
    for (let k = 0; k < 3; k++) {
      const expected = 0.25 * (c0.rootPos[k] as number) + 0.75 * (c4.rootPos[k] as number);
      expect(pose.rootPos[k]).toBeCloseTo(expected, 5);
    }
  });

  it('falls back to the rest pose when nothing was accumulated', () => {
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    pose.quats.fill(7);
    resetPose(pose);
    accumulateClip(pose, fakeClip(0, 1), 0.3, 0);
    accumulateClip(pose, fakeClip(0, 1), 0.3, -1);
    accumulateClip(pose, fakeClip(0, 1), 0.3, Number.NaN);
    finishPose(pose, REST, REST_ROOT);
    expect(Array.from(pose.quats)).toEqual(Array.from(REST));
    expect(Array.from(pose.rootPos)).toEqual([0, 1, 0]);
  });

  it('never reads past the last sample', () => {
    const clip = fakeClip(10, 0.5);
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    for (const time of [0.5, 0.50001, 99, -99, 1e12]) {
      resetPose(pose);
      accumulateClip(pose, clip, time, 1);
      finishPose(pose, REST, REST_ROOT);
      expectUnitPose(pose.quats, FAKE_BONE_COUNT);
    }
  });
});

describe('rotateBoneModelSpace', () => {
  const identityParents = new Float32Array(8);
  identityParents[3] = 1;
  identityParents[7] = 1;

  it('leaves the bone alone for a zero rotation and for a missing bone', () => {
    const quats = new Float32Array([...axisAngle(1, 0, 0, 0.4), ...axisAngle(0, 1, 0, 0.2)]);
    const before = quats.slice();
    rotateBoneModelSpace(quats, 1, identityParents, 0, 0, 0);
    rotateBoneModelSpace(quats, -1, identityParents, 1, 2, 3);
    for (let k = 0; k < 8; k++) expect(quats[k]).toBeCloseTo(before[k] as number, 6);
  });

  it.each([
    // rotation vector (model space)
    [0, 0.5, 0],
    [0.3, 0, 0],
    [0, 0, -0.8],
    [0.2, -0.4, 0.1],
    [1e-5, 0, 0], // below the small-angle switch
    [0, 2e-4, 0], // just above it
  ])('with an unrotated parent turns the bone by (%f, %f, %f)', (rx, ry, rz) => {
    const start = axisAngle(0, 0, 1, 0.3);
    const quats = new Float32Array([...start]);
    rotateBoneModelSpace(quats, 0, identityParents, rx, ry, rz);
    const angle = Math.hypot(rx, ry, rz);
    const delta = axisAngle(rx / angle, ry / angle, rz / angle, angle);
    expectQuat(quatAt(quats, 0), multiply(delta, start));
    expect(length(quatAt(quats, 0))).toBeCloseTo(1, 6);
  });

  it('expresses the turn in the parent frame', () => {
    // Parent turned 90 degrees about Y: model +X is the parent's +Z.
    const parents = new Float32Array([...axisAngle(0, 1, 0, Math.PI / 2)]);
    const quats = new Float32Array([0, 0, 0, 1]);
    rotateBoneModelSpace(quats, 0, parents, 0.4, 0, 0);
    expectQuat(quatAt(quats, 0), axisAngle(0, 0, 1, 0.4));
  });

  it('keeps unit length through a thousand arbitrary turns', () => {
    const rig = fakeAnimRig();
    const quats = rig.restQuats.slice();
    for (let i = 0; i < 1000; i++) {
      rotateBoneModelSpace(
        quats,
        i % FAKE_BONE_COUNT,
        rig.parentRestWorld,
        Math.sin(i * 1.1) * 0.9,
        Math.sin(i * 2.3) * 0.9,
        Math.sin(i * 0.7) * 0.9,
      );
    }
    expectUnitPose(quats, FAKE_BONE_COUNT);
  });
});

describe('applyLocalDelta', () => {
  const open = axisAngle(1, 0, 0, 0.6);

  it.each([0, -1, Number.NaN])('does nothing for amount %f', (amount) => {
    const quats = new Float32Array([...axisAngle(0, 1, 0, 0.3)]);
    const before = quats.slice();
    applyLocalDelta(quats, 0, new Float32Array(open), 0, amount);
    expect(Array.from(quats)).toEqual(Array.from(before));
  });

  it('does nothing for a missing bone', () => {
    const quats = new Float32Array([0, 0, 0, 1]);
    applyLocalDelta(quats, -1, new Float32Array(open), 0, 1);
    expect(Array.from(quats)).toEqual([0, 0, 0, 1]);
  });

  it('applies the whole delta at amount 1, after the bone own rotation', () => {
    const start = axisAngle(0, 1, 0, 0.3);
    const quats = new Float32Array([...start]);
    applyLocalDelta(quats, 0, new Float32Array(open), 0, 1);
    expectQuat(quatAt(quats, 0), multiply(start, open));
  });

  it('takes the short way round for a delta stored with negative w', () => {
    const a = new Float32Array([0, 0, 0, 1]);
    const b = new Float32Array([0, 0, 0, 1]);
    applyLocalDelta(a, 0, new Float32Array(open), 0, 0.5);
    applyLocalDelta(b, 0, new Float32Array(open.map((v) => -v)), 0, 0.5);
    expectQuat(quatAt(a, 0), quatAt(b, 0));
  });

  it('opens monotonically and stays unit for every amount', () => {
    let last = 0;
    for (let amount = 0.05; amount <= 1.0001; amount += 0.05) {
      const quats = new Float32Array([0, 0, 0, 1]);
      applyLocalDelta(quats, 0, new Float32Array(open), 0, amount);
      const q = quatAt(quats, 0);
      expect(length(q)).toBeCloseTo(1, 6);
      const angle = 2 * Math.atan2(q[0], q[3]);
      expect(angle).toBeGreaterThan(last);
      last = angle;
    }
    expect(last).toBeCloseTo(0.6, 4);
  });
});

describe('bodyAngularVelocity', () => {
  const out = new Float32Array(3);

  function rate(prev: Quat, next: Quat, dt: number): number[] {
    out.fill(99);
    bodyAngularVelocity(out, prev[0], prev[1], prev[2], prev[3], next[0], next[1], next[2], next[3], dt);
    return Array.from(out);
  }

  it.each([
    // axis, component: dragon space +X pitch, +Y yaw, +Z roll
    [[1, 0, 0], 0],
    [[0, 1, 0], 1],
    [[0, 0, 1], 2],
  ] as const)('a turn about %j shows up in component %i', (axis, component) => {
    const dt = 1 / 60;
    const angle = 0.02;
    const result = rate([0, 0, 0, 1], axisAngle(axis[0], axis[1], axis[2], angle), dt);
    for (let k = 0; k < 3; k++) {
      // 2 sin(angle / 2) / dt: the angle over time for small steps.
      const expected = k === component ? (2 * Math.sin(angle / 2)) / dt : 0;
      expect(result[k]).toBeCloseTo(expected, 4);
    }
    // The sign follows the turn.
    const back = rate([0, 0, 0, 1], axisAngle(axis[0], axis[1], axis[2], -angle), dt);
    expect(back[component]).toBeCloseTo(-(result[component] as number), 4);
  });

  it('is measured in the body frame: the same local turn reads the same from any heading', () => {
    const local = axisAngle(0, 1, 0, 0.03);
    const reference = rate([0, 0, 0, 1], local, 1 / 60);
    for (const heading of [
      axisAngle(0, 1, 0, 1.9),
      axisAngle(1, 0, 0, -0.7),
      multiply(axisAngle(0, 0, 1, 2.4), axisAngle(1, 0, 0, 0.6)),
    ]) {
      const result = rate(heading, multiply(heading, local), 1 / 60);
      for (let k = 0; k < 3; k++) expect(result[k]).toBeCloseTo(reference[k] as number, 3);
    }
  });

  it('is zero for no turn, and blind to the sign of the quaternion', () => {
    const q = axisAngle(0.6, 0, 0.8, 1.1);
    expect(rate(q, q, 1 / 60).map((v) => Math.abs(v))).toEqual([0, 0, 0]);
    const negated: Quat = [-q[0], -q[1], -q[2], -q[3]];
    for (const v of rate(q, negated, 1 / 60)) expect(Math.abs(v)).toBeLessThan(1e-4);
    const next = multiply(q, axisAngle(0, 1, 0, 0.02));
    const flipped: Quat = [-next[0], -next[1], -next[2], -next[3]];
    const a = rate(q, next, 1 / 60);
    const b = rate(q, flipped, 1 / 60);
    for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k] as number, 4);
  });

  it.each([0, -1, 1e-6, Number.NaN])('gives zero, not NaN or infinity, for dt = %f', (dt) => {
    expect(rate([0, 0, 0, 1], axisAngle(0, 1, 0, 0.5), dt)).toEqual([0, 0, 0]);
  });
});

describe('ease, clamp, saturate', () => {
  it('ease approaches the target without overshoot and at the same pace for any frame rate', () => {
    let coarse = 0;
    let fine = 0;
    for (let i = 0; i < 30; i++) coarse = ease(coarse, 1, 7, 1 / 30);
    for (let i = 0; i < 120; i++) fine = ease(fine, 1, 7, 1 / 120);
    expect(coarse).toBeCloseTo(fine, 5);
    expect(coarse).toBeCloseTo(1 - Math.exp(-7), 5);
    expect(coarse).toBeLessThan(1);
  });

  it.each([0, -0.1, Number.NaN])('ease does not move for dt = %f', (dt) => {
    expect(ease(0.25, 1, 7, dt)).toBe(0.25);
  });

  it.each([
    [5, 0, 1, 1],
    [-5, 0, 1, 0],
    [0.4, 0, 1, 0.4],
    [2, -3, 3, 2],
  ])('clamp(%f, %f, %f) = %f', (value, min, max, expected) => {
    expect(clamp(value, min, max)).toBe(expected);
  });

  it.each([
    [-1, 0],
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [9, 1],
  ])('saturate(%f) = %f', (value, expected) => {
    expect(saturate(value)).toBe(expected);
  });
});
