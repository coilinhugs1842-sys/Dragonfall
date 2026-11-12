import { describe, expect, it } from 'vitest';
import {
  DRAGON_ANIM_BANK_L,
  DRAGON_ANIM_BANK_R,
  DRAGON_ANIM_BOOST,
  DRAGON_ANIM_DEATH_FALL,
  DRAGON_ANIM_DIVE,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_ANIM_HIT,
  DRAGON_ANIM_HOVER,
  DRAGON_ANIM_LAND,
  DRAGON_ANIM_ROAR,
  DRAGON_ANIM_TAKEOFF,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_FIRING,
} from '../../src/shared';
import {
  ANIM_BLEND_RATE,
  BREATH_SCALE,
  DRAGON_CLIP_COUNT,
  advanceDragonAnim,
  breathScale,
  createDragonAnimInput,
  createDragonAnimState,
  createPoseAccumulator,
  resetDragonAnimState,
  writeDragonPose,
  writeLocomotionTargets,
} from '../../src/dragons';
import type { DragonAnimInput, DragonAnimState } from '../../src/dragons';
import { FAKE_BONE_COUNT, fakeAnimRig } from './fake-dragon';

const DT = 1 / 60;
const ONE_SHOTS = [DRAGON_ANIM_ROAR, DRAGON_ANIM_LAND, DRAGON_ANIM_TAKEOFF, DRAGON_ANIM_HIT];

function inputOf(overrides: Partial<DragonAnimInput> = {}): DragonAnimInput {
  return { ...createDragonAnimInput(), ...overrides };
}

function sum(values: Float32Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * One plain comparison instead of an `expect` per number: the sweeps below check a few
 * hundred thousand values, and that many matcher calls is seconds on a busy machine.
 */
function must(ok: boolean, what: string): void {
  if (!ok) expect.fail(what);
}

function expectWeights(weights: Float32Array): void {
  for (let i = 0; i < weights.length; i++) {
    const weight = weights[i] as number;
    must(Number.isFinite(weight), `weight ${i} is ${weight}`);
    must(weight >= 0 && weight <= 1 + 1e-5, `weight ${i} is ${weight}, outside 0..1`);
  }
  const total = sum(weights);
  must(Math.abs(total - 1) < 5e-5, `the weights sum to ${total}, not 1`);
}

function expectFiniteState(state: DragonAnimState): void {
  expectWeights(state.weights);
  for (let i = 0; i < state.times.length; i++) {
    must(Number.isFinite(state.times[i] as number), `clip time ${i} is ${state.times[i]}`);
  }
  const numbers: Record<string, number> = {
    beatPhase: state.beatPhase,
    beatWeight: state.beatWeight,
    oneShotTime: state.oneShotTime,
    oneShotWeight: state.oneShotWeight,
    lookYaw: state.lookYaw,
    lookPitch: state.lookPitch,
    tailYaw: state.tailYaw,
    tailYawVel: state.tailYawVel,
    tailPitch: state.tailPitch,
    tailPitchVel: state.tailPitchVel,
    wingLag: state.wingLag,
    wingLagVel: state.wingLagVel,
    breathPhase: state.breathPhase,
    jaw: state.jaw,
  };
  for (const name in numbers) must(Number.isFinite(numbers[name]), `${name} is ${numbers[name]}`);
  const within = (name: string, value: number, low: number, high: number): void => {
    must(value >= low && value <= high, `${name} is ${value}, outside ${low}..${high}`);
  };
  must(state.beatPhase >= 0 && state.beatPhase < 1, `beatPhase is ${state.beatPhase}`);
  must(state.breathPhase >= 0 && state.breathPhase < 1, `breathPhase is ${state.breathPhase}`);
  within('oneShotWeight', state.oneShotWeight, 0, 1);
  within('jaw', state.jaw, 0, 1);
  // The springs are clamped: a wild turn rate cannot fold the tail through the body.
  within('tailYaw', state.tailYaw, -0.9 - 1e-6, 0.9 + 1e-6);
  within('tailPitch', state.tailPitch, -0.9 - 1e-6, 0.9 + 1e-6);
  within('wingLag', state.wingLag, -0.35 - 1e-6, 0.35 + 1e-6);
  within('lookYaw', state.lookYaw, -0.6 - 1e-6, 0.6 + 1e-6);
  within('lookPitch', state.lookPitch, -0.4 - 1e-6, 0.4 + 1e-6);
}

function expectUnitPose(quats: Float32Array): void {
  for (let b = 0; b < FAKE_BONE_COUNT; b++) {
    const o = b * 4;
    const len = Math.hypot(
      quats[o] as number,
      quats[o + 1] as number,
      quats[o + 2] as number,
      quats[o + 3] as number,
    );
    must(Math.abs(len - 1) < 5e-6, `bone ${b} has a quaternion of length ${len}`);
  }
}

/** Largest change of any quaternion component between two poses (sign-insensitive per bone). */
function poseStep(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let bone = 0; bone < FAKE_BONE_COUNT; bone++) {
    const o = bone * 4;
    let dot = 0;
    for (let k = 0; k < 4; k++) dot += (a[o + k] as number) * (b[o + k] as number);
    const sign = dot < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) {
      worst = Math.max(worst, Math.abs((a[o + k] as number) - sign * (b[o + k] as number)));
    }
  }
  return worst;
}

/** A small deterministic generator, so a failure reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('writeLocomotionTargets', () => {
  const out = new Float32Array(DRAGON_CLIP_COUNT);

  it.each([
    // name, input, the clip that must lead
    ['cruising', {}, DRAGON_ANIM_GLIDE],
    ['dead', { flags: 0 }, DRAGON_ANIM_DEATH_FALL],
    ['death_fall from the sim', { anim: DRAGON_ANIM_DEATH_FALL }, DRAGON_ANIM_DEATH_FALL],
    ['boost flag', { flags: DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING }, DRAGON_ANIM_BOOST],
    ['boost anim', { anim: DRAGON_ANIM_BOOST }, DRAGON_ANIM_BOOST],
    ['steep descent', { climb: -0.8 }, DRAGON_ANIM_DIVE],
    ['dive anim', { anim: DRAGON_ANIM_DIVE }, DRAGON_ANIM_DIVE],
    ['nearly stopped', { speedRatio: 0.1 }, DRAGON_ANIM_HOVER],
    ['hover anim', { anim: DRAGON_ANIM_HOVER }, DRAGON_ANIM_HOVER],
    ['climbing', { climb: 0.5 }, DRAGON_ANIM_FLAP],
    ['flap anim', { anim: DRAGON_ANIM_FLAP }, DRAGON_ANIM_FLAP],
    ['hard right bank', { roll: 1.2 }, DRAGON_ANIM_BANK_R],
    ['hard left bank', { roll: -1.2 }, DRAGON_ANIM_BANK_L],
    [
      'dodge left while rolled right',
      { roll: 0.3, anim: DRAGON_ANIM_BANK_L, flags: DRAGON_FLAG_ALIVE | DRAGON_FLAG_DODGING },
      DRAGON_ANIM_BANK_L,
    ],
  ] as const)('%s', (_name, overrides, leader) => {
    writeLocomotionTargets(out, inputOf(overrides));
    expectWeights(out);
    for (const clip of ONE_SHOTS) expect(out[clip]).toBe(0);
    for (let i = 0; i < DRAGON_CLIP_COUNT; i++) {
      if (i !== leader) expect(out[leader] as number).toBeGreaterThan(out[i] as number);
    }
  });

  it('sums to 1 with no negative weight for every combination of inputs', () => {
    const anims = [
      DRAGON_ANIM_GLIDE,
      DRAGON_ANIM_FLAP,
      DRAGON_ANIM_BOOST,
      DRAGON_ANIM_DIVE,
      DRAGON_ANIM_BANK_L,
      DRAGON_ANIM_BANK_R,
      DRAGON_ANIM_HOVER,
      DRAGON_ANIM_ROAR,
      DRAGON_ANIM_LAND,
      DRAGON_ANIM_TAKEOFF,
      DRAGON_ANIM_HIT,
      DRAGON_ANIM_DEATH_FALL,
    ];
    const flagSets = [
      0,
      DRAGON_FLAG_ALIVE,
      DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING,
      DRAGON_FLAG_ALIVE | DRAGON_FLAG_DODGING,
      DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING | DRAGON_FLAG_DODGING,
    ];
    for (const anim of anims) {
      for (const flags of flagSets) {
        for (const speedRatio of [0, 0.3, 0.5, 0.9, 1, 2.5]) {
          for (const climb of [-1, -0.45, -0.1, 0, 0.1, 0.4, 1]) {
            for (const roll of [-1.5, -0.4, 0, 0.4, 1.5]) {
              writeLocomotionTargets(out, inputOf({ anim, flags, speedRatio, climb, roll }));
              expectWeights(out);
            }
          }
        }
      }
    }
  });
});

describe('advanceDragonAnim', () => {
  it('starts in the target blend, with no ease-in from nothing', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    resetDragonAnimState(state, 3);
    expect(sum(state.weights)).toBe(0);
    advanceDragonAnim(state, inputOf({ anim: DRAGON_ANIM_BOOST }), rig, DT);
    expectWeights(state.weights);
    expect(state.weights[DRAGON_ANIM_BOOST]).toBeCloseTo(1, 5);
  });

  it('keeps the weights normalised and everything finite through 4000 random frames', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    const random = lcg(12345);
    const input = inputOf();
    const steps = [DT, DT, DT, 1 / 30, 1 / 144, 0, 0.25, 2, -1, 1e-7];
    for (let frame = 0; frame < 4000; frame++) {
      if (random() < 0.05) input.anim = Math.floor(random() * DRAGON_CLIP_COUNT);
      if (random() < 0.05) {
        input.flags =
          (random() < 0.9 ? DRAGON_FLAG_ALIVE : 0) |
          (random() < 0.3 ? DRAGON_FLAG_BOOSTING : 0) |
          (random() < 0.2 ? DRAGON_FLAG_DODGING : 0) |
          (random() < 0.2 ? DRAGON_FLAG_FIRING : 0) |
          (random() < 0.2 ? DRAGON_FLAG_CHARGING : 0);
      }
      input.speedRatio = random() * 2.5;
      input.climb = random() * 2 - 1;
      input.roll = (random() * 2 - 1) * 1.5;
      // Turn rates far beyond anything the sim produces (a teleport read as a turn).
      input.pitchRate = (random() * 2 - 1) * 400;
      input.yawRate = (random() * 2 - 1) * 400;
      input.rollRate = (random() * 2 - 1) * 400;
      input.hit = random() < 0.03;
      advanceDragonAnim(state, input, rig, steps[frame % steps.length] as number);
      expectFiniteState(state);
      if (frame % 7 === 0) {
        writeDragonPose(state, rig, pose, frame % 2 === 0);
        expectUnitPose(pose.quats);
        for (const value of pose.rootPos) must(Number.isFinite(value), `root position ${value}`);
      }
    }
  });

  it.each([
    // from, to: a state change is a blend over about a third of a second, never a pop
    ['glide -> boost', {}, { anim: DRAGON_ANIM_BOOST, flags: DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING }],
    ['glide -> dive', {}, { anim: DRAGON_ANIM_DIVE, climb: -0.9 }],
    ['boost -> hover', { anim: DRAGON_ANIM_BOOST }, { anim: DRAGON_ANIM_HOVER, speedRatio: 0.1 }],
    ['bank left -> bank right', { roll: -1.2 }, { roll: 1.2 }],
    ['flap -> glide', { anim: DRAGON_ANIM_FLAP, climb: 0.6 }, {}],
    ['alive -> dead', {}, { flags: 0, anim: DRAGON_ANIM_DEATH_FALL }],
  ] as const)('%s blends', (_name, from, to) => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    const before = inputOf(from);
    const after = inputOf(to);
    for (let i = 0; i < 120; i++) advanceDragonAnim(state, before, rig, DT);

    // How much the pose moves per frame while nothing changes: the clips' own motion.
    writeDragonPose(state, rig, pose, false);
    let last = pose.quats.slice();
    let steady = 0;
    for (let i = 0; i < 60; i++) {
      advanceDragonAnim(state, before, rig, DT);
      writeDragonPose(state, rig, pose, false);
      steady = Math.max(steady, poseStep(last, pose.quats));
      last = pose.quats.slice();
    }

    const target = new Float32Array(DRAGON_CLIP_COUNT);
    writeLocomotionTargets(target, after);
    const dying = (target[DRAGON_ANIM_DEATH_FALL] as number) > 0;
    // The most a weight may move in one frame: the ease's own step (death eases faster).
    const maxWeightStep = 1 - Math.exp(-(dying ? 10 : ANIM_BLEND_RATE) * DT) + 1e-3;
    let previous = state.weights.slice();
    let worstPose = 0;
    for (let i = 0; i < 90; i++) {
      advanceDragonAnim(state, after, rig, DT);
      expectWeights(state.weights);
      for (let c = 0; c < DRAGON_CLIP_COUNT; c++) {
        const step = Math.abs((state.weights[c] as number) - (previous[c] as number));
        must(step <= maxWeightStep, `clip ${c} moved ${step} in one frame`);
      }
      previous = state.weights.slice();
      writeDragonPose(state, rig, pose, false);
      expectUnitPose(pose.quats);
      worstPose = Math.max(worstPose, poseStep(last, pose.quats));
      last = pose.quats.slice();
    }
    // The pose never jumps: a frame of the blend moves it little more than a frame of the
    // clips does anyway (a pop would be the whole distance between the two poses, ~0.3).
    expect(worstPose).toBeLessThan(steady + 0.06);
    // ... and after a second and a half it has arrived.
    for (let c = 0; c < DRAGON_CLIP_COUNT; c++) {
      expect(state.weights[c]).toBeCloseTo(target[c] as number, 2);
    }
  });

  it('is frame-rate independent: 60 and 120 frames per second reach the same blend', () => {
    const rig = fakeAnimRig();
    const a = createDragonAnimState();
    const b = createDragonAnimState();
    const glide = inputOf();
    const boost = inputOf({ anim: DRAGON_ANIM_BOOST });
    advanceDragonAnim(a, glide, rig, DT);
    advanceDragonAnim(b, glide, rig, DT);
    for (let i = 0; i < 12; i++) advanceDragonAnim(a, boost, rig, 1 / 60);
    for (let i = 0; i < 24; i++) advanceDragonAnim(b, boost, rig, 1 / 120);
    for (let c = 0; c < DRAGON_CLIP_COUNT; c++) {
      expect(a.weights[c]).toBeCloseTo(b.weights[c] as number, 2);
    }
    expect(a.beatPhase).toBeCloseTo(b.beatPhase, 3);
  });

  it('shares one wing-beat phase between flap, boost and hover', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    advanceDragonAnim(state, inputOf({ anim: DRAGON_ANIM_FLAP, climb: 0.5 }), rig, DT);
    for (let i = 0; i < 40; i++) {
      advanceDragonAnim(state, inputOf({ anim: DRAGON_ANIM_BOOST }), rig, DT);
      const phase = state.beatPhase;
      for (const clip of [DRAGON_ANIM_FLAP, DRAGON_ANIM_BOOST, DRAGON_ANIM_HOVER]) {
        const duration = rig.clips[clip]?.duration ?? 1;
        expect((state.times[clip] as number) / duration).toBeCloseTo(phase, 5);
      }
    }
  });
});

describe('one-shots', () => {
  it('a hit fades in over the flight animation, peaks below 1 and fades out again', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    const input = inputOf();
    for (let i = 0; i < 30; i++) advanceDragonAnim(state, input, rig, DT);
    expect(state.oneShot).toBe(-1);

    input.hit = true;
    advanceDragonAnim(state, input, rig, DT);
    input.hit = false;
    expect(state.oneShot).toBe(DRAGON_ANIM_HIT);
    // First frame: a fraction of the fade-in, not the full reaction.
    expect(state.oneShotWeight).toBeGreaterThan(0);
    expect(state.oneShotWeight).toBeLessThan(0.25);

    const duration = rig.clips[DRAGON_ANIM_HIT]?.duration ?? 0;
    let peak = state.oneShotWeight;
    let previous = state.oneShotWeight;
    let frames = 1;
    while (state.oneShot >= 0 && frames < 600) {
      advanceDragonAnim(state, input, rig, DT);
      frames++;
      if (state.oneShot < 0) break;
      expect(Math.abs(state.oneShotWeight - previous)).toBeLessThan(0.25);
      previous = state.oneShotWeight;
      peak = Math.max(peak, state.oneShotWeight);
    }
    expect(peak).toBeCloseTo(0.8, 5);
    // The last frame before it ended had all but faded out.
    expect(previous).toBeLessThan(0.1);
    expect(frames * DT).toBeGreaterThanOrEqual(duration);
    expect(frames * DT).toBeLessThan(duration + 3 * DT);
    expect(state.oneShotWeight).toBe(0);
  });

  it('a second hit during the flinch does not restart it', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    const input = inputOf({ hit: true });
    advanceDragonAnim(state, inputOf(), rig, DT);
    for (let i = 0; i < 10; i++) advanceDragonAnim(state, input, rig, DT);
    expect(state.oneShot).toBe(DRAGON_ANIM_HIT);
    expect(state.oneShotTime).toBeCloseTo(10 * DT, 5);
  });

  it('roar plays once when the sim enters it, and land holds its last frame', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    advanceDragonAnim(state, inputOf(), rig, DT);
    const roar = inputOf({ anim: DRAGON_ANIM_ROAR });
    for (let i = 0; i < 600; i++) advanceDragonAnim(state, roar, rig, DT);
    // Still "roar" in the sim, but the clip does not loop.
    expect(state.oneShot).toBe(-1);

    const land = inputOf({ anim: DRAGON_ANIM_LAND });
    for (let i = 0; i < 600; i++) advanceDragonAnim(state, land, rig, DT);
    expect(state.oneShot).toBe(DRAGON_ANIM_LAND);
    expect(state.oneShotWeight).toBe(1);
    expect(state.times[DRAGON_ANIM_LAND]).toBeCloseTo(rig.clips[DRAGON_ANIM_LAND]?.duration ?? 0, 5);
  });

  it('a dragon without the clip simply does not play it', () => {
    const rig = fakeAnimRig([DRAGON_ANIM_HIT, DRAGON_ANIM_ROAR]);
    const state = createDragonAnimState();
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    advanceDragonAnim(state, inputOf(), rig, DT);
    advanceDragonAnim(state, inputOf({ hit: true }), rig, DT);
    expect(state.oneShot).toBe(-1);
    advanceDragonAnim(state, inputOf({ anim: DRAGON_ANIM_ROAR }), rig, DT);
    expect(state.oneShot).toBe(-1);
    writeDragonPose(state, rig, pose);
    expectUnitPose(pose.quats);
  });

  it('death cancels a one-shot', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    advanceDragonAnim(state, inputOf(), rig, DT);
    advanceDragonAnim(state, inputOf({ hit: true }), rig, DT);
    expect(state.oneShot).toBe(DRAGON_ANIM_HIT);
    advanceDragonAnim(state, inputOf({ flags: 0, hit: true }), rig, DT);
    expect(state.oneShot).toBe(-1);
  });
});

describe('writeDragonPose', () => {
  it('falls back to the rest pose where every weighted clip is missing', () => {
    const all = Array.from({ length: DRAGON_CLIP_COUNT }, (_, i) => i);
    const rig = fakeAnimRig(all);
    const state = createDragonAnimState();
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    advanceDragonAnim(state, inputOf(), rig, DT);
    writeDragonPose(state, rig, pose, false);
    expect(Array.from(pose.quats)).toEqual(Array.from(rig.restQuats));
    expect(Array.from(pose.rootPos)).toEqual(Array.from(rig.restRootPos));
  });

  it('with still springs the detailed pose is the plain clip blend', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    const plain = createPoseAccumulator(FAKE_BONE_COUNT);
    const detailed = createPoseAccumulator(FAKE_BONE_COUNT);
    for (let i = 0; i < 20; i++) advanceDragonAnim(state, inputOf(), rig, DT);
    writeDragonPose(state, rig, plain, false);
    writeDragonPose(state, rig, detailed, true);
    expect(poseStep(plain.quats, detailed.quats)).toBeLessThan(1e-6);
  });

  it('the procedural layers move only their own bones, and by a bounded amount', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    const plain = createPoseAccumulator(FAKE_BONE_COUNT);
    const detailed = createPoseAccumulator(FAKE_BONE_COUNT);
    const input = inputOf({
      yawRate: 3,
      pitchRate: -2,
      rollRate: 4,
      flags: DRAGON_FLAG_ALIVE | DRAGON_FLAG_FIRING,
    });
    for (let i = 0; i < 90; i++) advanceDragonAnim(state, input, rig, DT);
    writeDragonPose(state, rig, plain, false);
    writeDragonPose(state, rig, detailed, true);
    expectUnitPose(detailed.quats);
    const moved: number[] = [];
    for (let b = 0; b < FAKE_BONE_COUNT; b++) {
      let delta = 0;
      for (let k = 0; k < 4; k++) {
        delta = Math.max(
          delta,
          Math.abs((plain.quats[b * 4 + k] as number) - (detailed.quats[b * 4 + k] as number)),
        );
      }
      if (delta > 1e-4) moved.push(b);
      expect(delta).toBeLessThan(0.6);
    }
    // neck0, neck1, head, jaw, the tail, both wrists and the trailing fingers; not the root,
    // the chest or the leading finger of each wing.
    expect(moved).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 16, 17]);
  });

  it('the viewer override plays exactly one clip, held at the asked phase', () => {
    const rig = fakeAnimRig();
    const state = createDragonAnimState();
    const pose = createPoseAccumulator(FAKE_BONE_COUNT);
    const expected = createPoseAccumulator(FAKE_BONE_COUNT);
    state.forceClip = DRAGON_ANIM_DIVE;
    state.forcePhase = 0.5;
    for (let i = 0; i < 5; i++) advanceDragonAnim(state, inputOf({ anim: DRAGON_ANIM_BOOST }), rig, DT);
    expect(state.weights[DRAGON_ANIM_DIVE]).toBe(1);
    expect(sum(state.weights)).toBe(1);
    const duration = rig.clips[DRAGON_ANIM_DIVE]?.duration ?? 0;
    expect(state.times[DRAGON_ANIM_DIVE]).toBeCloseTo(0.5 * duration, 5);
    writeDragonPose(state, rig, pose, false);
    // The same as sampling that clip alone.
    const lone = createDragonAnimState();
    lone.weights[DRAGON_ANIM_DIVE] = 1;
    lone.times[DRAGON_ANIM_DIVE] = 0.5 * duration;
    writeDragonPose(lone, rig, expected, false);
    expect(poseStep(pose.quats, expected.quats)).toBeLessThan(1e-6);
  });
});

describe('resetDragonAnimState and breathScale', () => {
  it('spreads the phases of dragons that appear together and keeps them in range', () => {
    const phases = new Set<number>();
    const state = createDragonAnimState();
    for (let id = 0; id < 10; id++) {
      state.started = true;
      state.oneShot = DRAGON_ANIM_HIT;
      state.tailYawVel = 5;
      resetDragonAnimState(state, id);
      expect(state.started).toBe(false);
      expect(state.oneShot).toBe(-1);
      expect(state.tailYawVel).toBe(0);
      expect(state.beatPhase).toBeGreaterThanOrEqual(0);
      expect(state.beatPhase).toBeLessThan(1);
      expect(state.breathPhase).toBeGreaterThanOrEqual(0);
      expect(state.breathPhase).toBeLessThan(1);
      phases.add(Math.round(state.beatPhase * 1000));
    }
    expect(phases.size).toBe(10);
  });

  it('breathScale stays within its swing', () => {
    const state = createDragonAnimState();
    for (let i = 0; i <= 100; i++) {
      state.breathPhase = i / 100;
      const scale = breathScale(state);
      expect(scale).toBeGreaterThanOrEqual(1 - BREATH_SCALE - 1e-9);
      expect(scale).toBeLessThanOrEqual(1 + BREATH_SCALE + 1e-9);
    }
  });
});
