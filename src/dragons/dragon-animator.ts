/**
 * Dragon animation: which baked clips play at what weight, plus the procedural layers on top.
 * Pure and allocation-free (typed arrays only, no three.js), so it is unit-tested in node and
 * cheap enough to run for ten dragons every frame.
 *
 * Two steps, so far dragons can skip the expensive half:
 * - `advanceDragonAnim` every frame: eases the clip weights toward the targets for the dragon's
 *   state, advances the clip clocks and the springs (look, tail, wing lag, jaw). A few dozen
 *   floating-point operations.
 * - `writeDragonPose` when the dragon is drawn (and at a reduced rate when far): samples the
 *   weighted clips into a pose and applies the procedural rotations.
 *
 * LAYERS
 * - Locomotion: glide / flap / boost / dive / hover / bank_l / bank_r as one normalized blend.
 *   Flap, boost and hover share ONE wing-beat phase, so a cross-fade between them never shows
 *   two beats fighting. `death_fall` replaces everything when the dragon is down.
 * - One-shots: hit, roar, land, takeoff fade in over the locomotion and out again.
 * - Procedural: the neck and head turn into the turn, the tail trails it on a spring, the wing
 *   tips lag a roll, the jaw opens while breathing fire, the chest breathes.
 */

import {
  DRAGON_ANIM_BANK_L,
  DRAGON_ANIM_BANK_R,
  DRAGON_ANIM_BOOST,
  DRAGON_ANIM_CLIPS,
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
} from '../shared/world-view';
import {
  accumulateClip,
  applyLocalDelta,
  clamp,
  ease,
  finishPose,
  resetPose,
  rotateBoneModelSpace,
  saturate,
} from './pose-math';
import type { BakedClip, PoseAccumulator } from './pose-math';

export const DRAGON_CLIP_COUNT = DRAGON_ANIM_CLIPS.length;

/** Weight eases toward its target at this rate per second (about 0.3 s to settle). */
export const ANIM_BLEND_RATE = 7;
/** The fall takes over faster than that. */
const DEATH_BLEND_RATE = 10;
const ONE_SHOT_FADE_IN_S = 0.08;
const ONE_SHOT_FADE_OUT_S = 0.2;
/** A hit reaction leaves this much of the flight animation showing. */
const HIT_PEAK_WEIGHT = 0.8;

/** Radians of neck + head turn per radian/second of yaw and pitch, and the caps. */
const LOOK_YAW_GAIN = 0.42;
const LOOK_PITCH_GAIN = 0.3;
const LOOK_YAW_MAX = 0.6;
const LOOK_PITCH_MAX = 0.4;
const LOOK_RATE = 5;
/** Tail spring: stiffness (1/s^2), damping (1/s), and radians of bend per radian/second. */
const TAIL_STIFFNESS = 42;
const TAIL_DAMPING = 7.5;
const TAIL_GAIN = 0.5;
const TAIL_MAX = 0.9;
/** Wing-tip lag spring, driven by the roll rate. */
const WING_STIFFNESS = 90;
const WING_DAMPING = 12;
const WING_GAIN = 0.11;
const WING_MAX = 0.35;
/** Breaths per second and the chest's scale swing. */
const BREATH_HZ = 0.45;
export const BREATH_SCALE = 0.014;
const JAW_RATE = 12;
/** Longest step the springs integrate in one go, seconds. */
const MAX_SPRING_DT_S = 1 / 30;

/** Bone indices (into the asset's joint order) the procedural layers drive; -1 = absent. */
export interface DragonAnimBones {
  readonly head: number;
  /** Root to tip. */
  readonly neck: readonly number[];
  readonly tail: readonly number[];
  readonly wristLeft: number;
  readonly wristRight: number;
  readonly fingersLeft: readonly number[];
  readonly fingersRight: readonly number[];
  readonly jaw: number;
}

/** What the animator needs of a loaded dragon. `DragonAsset` satisfies it. */
export interface DragonAnimRig {
  readonly boneCount: number;
  /** Indexed like DRAGON_ANIM_CLIPS; null where the GLB had no such clip. */
  readonly clips: readonly (BakedClip | null)[];
  /** Rest pose, `boneCount * 4`. */
  readonly restQuats: Float32Array;
  readonly restRootPos: Float32Array;
  /** Model-space rest rotation of each bone's parent, `boneCount * 4`. */
  readonly parentRestWorld: Float32Array;
  readonly animBones: DragonAnimBones;
  /** Local rotation that opens the jaw fully (identity when the rig has no jaw). */
  readonly jawOpen: Float32Array;
}

/** Per-frame inputs, derived from the DragonView by the view. One scratch object is reused. */
export interface DragonAnimInput {
  /** DragonView.anim: the sim's dominant state. */
  anim: number;
  flags: number;
  /** Speed over the class's cruise speed. */
  speedRatio: number;
  /** Vertical share of the velocity, -1 (straight down) .. 1 (straight up). */
  climb: number;
  /** Bank in radians; positive = right wing down. */
  roll: number;
  /** Body-frame angular velocity, radians per second (see `bodyAngularVelocity`). */
  pitchRate: number;
  yawRate: number;
  rollRate: number;
  /** True on the frame the dragon lost health. */
  hit: boolean;
}

export function createDragonAnimInput(): DragonAnimInput {
  return {
    anim: DRAGON_ANIM_GLIDE,
    flags: DRAGON_FLAG_ALIVE,
    speedRatio: 1,
    climb: 0,
    roll: 0,
    pitchRate: 0,
    yawRate: 0,
    rollRate: 0,
    hit: false,
  };
}

export interface DragonAnimState {
  /** Locomotion weights, indexed like DRAGON_ANIM_CLIPS; they sum to 1 once started. */
  readonly weights: Float32Array;
  /** Clip clocks in seconds. */
  readonly times: Float32Array;
  readonly targets: Float32Array;
  /** Shared wing-beat phase of flap / boost / hover, 0..1. 0 is the top of the up-stroke. */
  beatPhase: number;
  /** How much of the pose is a wing-beat clip, 0..1 (for syncing a flap sound). */
  beatWeight: number;
  /** Clip index of the playing one-shot, or -1. */
  oneShot: number;
  oneShotTime: number;
  oneShotWeight: number;
  lastAnim: number;
  started: boolean;
  lookYaw: number;
  lookPitch: number;
  tailYaw: number;
  tailYawVel: number;
  tailPitch: number;
  tailPitchVel: number;
  wingLag: number;
  wingLagVel: number;
  breathPhase: number;
  jaw: number;
  /** Viewer override: play only this clip (index), or -1. */
  forceClip: number;
  /** Viewer override: hold the forced clip at this fraction of its length, or -1 to play. */
  forcePhase: number;
}

export function createDragonAnimState(): DragonAnimState {
  return {
    weights: new Float32Array(DRAGON_CLIP_COUNT),
    times: new Float32Array(DRAGON_CLIP_COUNT),
    targets: new Float32Array(DRAGON_CLIP_COUNT),
    beatPhase: 0,
    beatWeight: 0,
    oneShot: -1,
    oneShotTime: 0,
    oneShotWeight: 0,
    lastAnim: DRAGON_ANIM_GLIDE,
    started: false,
    lookYaw: 0,
    lookPitch: 0,
    tailYaw: 0,
    tailYawVel: 0,
    tailPitch: 0,
    tailPitchVel: 0,
    wingLag: 0,
    wingLagVel: 0,
    breathPhase: 0,
    jaw: 0,
    forceClip: -1,
    forcePhase: -1,
  };
}

/** Back to "never animated": the next advance starts in the target pose with still springs. */
export function resetDragonAnimState(state: DragonAnimState, seed = 0): void {
  state.weights.fill(0);
  state.targets.fill(0);
  // Spread the clocks so dragons that appear together do not beat in step.
  const offset = ((seed * 0.6180339887) % 1) * 4;
  state.times.fill(offset);
  state.beatPhase = (seed * 0.6180339887) % 1;
  state.beatWeight = 0;
  state.oneShot = -1;
  state.oneShotTime = 0;
  state.oneShotWeight = 0;
  state.lastAnim = DRAGON_ANIM_GLIDE;
  state.started = false;
  state.lookYaw = 0;
  state.lookPitch = 0;
  state.tailYaw = 0;
  state.tailYawVel = 0;
  state.tailPitch = 0;
  state.tailPitchVel = 0;
  state.wingLag = 0;
  state.wingLagVel = 0;
  state.breathPhase = (seed * 0.37) % 1;
  state.jaw = 0;
}

/**
 * The locomotion blend a dragon in this state should settle on: writes DRAGON_CLIP_COUNT
 * weights that sum to 1 (one-shot clips stay 0).
 */
export function writeLocomotionTargets(out: Float32Array, input: DragonAnimInput): void {
  out.fill(0);
  const flags = input.flags;
  const anim = input.anim;
  if ((flags & DRAGON_FLAG_ALIVE) === 0 || anim === DRAGON_ANIM_DEATH_FALL) {
    out[DRAGON_ANIM_DEATH_FALL] = 1;
    return;
  }
  const boosting = (flags & DRAGON_FLAG_BOOSTING) !== 0 || anim === DRAGON_ANIM_BOOST ? 1 : 0;
  const dive = Math.max(anim === DRAGON_ANIM_DIVE ? 1 : 0, saturate((-input.climb - 0.3) / 0.3));
  const hover = Math.max(
    anim === DRAGON_ANIM_HOVER ? 1 : 0,
    saturate((0.42 - input.speedRatio) / 0.2),
  );
  const flap = Math.max(
    anim === DRAGON_ANIM_FLAP ? 1 : 0,
    saturate((input.climb - 0.06) / 0.22),
    saturate((0.85 - input.speedRatio) / 0.3) * 0.8,
  );

  let rest = 1;
  const wHover = hover;
  rest -= wHover;
  // A boosted dive stays mostly tucked.
  const wDive = dive * rest * (boosting === 1 ? 0.75 : 1);
  rest -= wDive;
  const wBoost = boosting * rest;
  rest -= wBoost;
  let wFlap = flap * rest;
  rest -= wFlap;
  let wGlide = rest;

  // Bank: the wing asymmetry of a turn, taken out of the glide (and half out of the flap).
  const dodging =
    (flags & DRAGON_FLAG_DODGING) !== 0 &&
    (anim === DRAGON_ANIM_BANK_L || anim === DRAGON_ANIM_BANK_R);
  let bank = saturate(Math.abs(input.roll) / 0.8) * 0.7;
  let right = input.roll > 0;
  if (dodging) {
    bank = 0.9;
    right = anim === DRAGON_ANIM_BANK_R;
  } else if (anim === DRAGON_ANIM_BANK_L || anim === DRAGON_ANIM_BANK_R) {
    bank = Math.max(bank, 0.45);
    right = anim === DRAGON_ANIM_BANK_R;
  }
  const wBank = bank * wGlide + 0.5 * bank * wFlap;
  wGlide *= 1 - bank;
  wFlap *= 1 - 0.5 * bank;

  out[DRAGON_ANIM_HOVER] = wHover;
  out[DRAGON_ANIM_DIVE] = wDive;
  out[DRAGON_ANIM_BOOST] = wBoost;
  out[DRAGON_ANIM_FLAP] = wFlap;
  out[DRAGON_ANIM_GLIDE] = wGlide;
  out[right ? DRAGON_ANIM_BANK_R : DRAGON_ANIM_BANK_L] = wBank;
}

function isOneShot(anim: number): boolean {
  return (
    anim === DRAGON_ANIM_HIT ||
    anim === DRAGON_ANIM_ROAR ||
    anim === DRAGON_ANIM_LAND ||
    anim === DRAGON_ANIM_TAKEOFF
  );
}

function durationOf(rig: DragonAnimRig, clip: number): number {
  return rig.clips[clip]?.duration ?? 0;
}

function springStep(
  position: number,
  velocity: number,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): number {
  // Semi-implicit Euler; returns the new velocity (the caller adds velocity * dt).
  return velocity + (stiffness * (target - position) - damping * velocity) * dt;
}

/** Step 1 (every frame): weights, clocks and springs. See the file comment. */
export function advanceDragonAnim(
  state: DragonAnimState,
  input: DragonAnimInput,
  rig: DragonAnimRig,
  dtS: number,
): void {
  const dt = dtS > 0 ? dtS : 0;
  const weights = state.weights;
  const times = state.times;
  const targets = state.targets;
  const alive = (input.flags & DRAGON_FLAG_ALIVE) !== 0;

  // --- Locomotion weights ---------------------------------------------------------------------
  if (state.forceClip >= 0) {
    targets.fill(0);
    targets[state.forceClip] = 1;
  } else {
    writeLocomotionTargets(targets, input);
  }
  if (!state.started || state.forceClip >= 0) {
    weights.set(targets);
    state.started = true;
  } else {
    const rate = (targets[DRAGON_ANIM_DEATH_FALL] as number) > 0 ? DEATH_BLEND_RATE : ANIM_BLEND_RATE;
    let sum = 0;
    for (let i = 0; i < DRAGON_CLIP_COUNT; i++) {
      let w = ease(weights[i] as number, targets[i] as number, rate, dt);
      if (w < 1e-4) w = 0;
      weights[i] = w;
      sum += w;
    }
    if (sum > 1e-6) {
      const inv = 1 / sum;
      for (let i = 0; i < DRAGON_CLIP_COUNT; i++) weights[i] = (weights[i] as number) * inv;
    } else {
      weights.set(targets);
    }
  }

  // --- Clocks ---------------------------------------------------------------------------------
  const wFlap = weights[DRAGON_ANIM_FLAP] as number;
  const wBoost = weights[DRAGON_ANIM_BOOST] as number;
  const wHover = weights[DRAGON_ANIM_HOVER] as number;
  const beat = wFlap + wBoost + wHover;
  state.beatWeight = beat;
  const dFlap = durationOf(rig, DRAGON_ANIM_FLAP) || 1;
  const dBoost = durationOf(rig, DRAGON_ANIM_BOOST) || dFlap;
  const dHover = durationOf(rig, DRAGON_ANIM_HOVER) || dFlap;
  const beatDuration =
    beat > 1e-4 ? (wFlap * dFlap + wBoost * dBoost + wHover * dHover) / beat : dFlap;
  // A steep climb beats a little faster.
  const effort = 1 + 0.25 * saturate(input.climb * 2.5);
  let phase = state.beatPhase + (dt * effort) / beatDuration;
  phase -= Math.floor(phase);
  state.beatPhase = phase;
  times[DRAGON_ANIM_FLAP] = phase * dFlap;
  times[DRAGON_ANIM_BOOST] = phase * dBoost;
  times[DRAGON_ANIM_HOVER] = phase * dHover;
  times[DRAGON_ANIM_GLIDE] = (times[DRAGON_ANIM_GLIDE] as number) + dt;
  times[DRAGON_ANIM_DIVE] = (times[DRAGON_ANIM_DIVE] as number) + dt;
  // The two bank clips are mirrors: one clock, so a roll reversal does not jump.
  const bankTime = (times[DRAGON_ANIM_BANK_L] as number) + dt;
  times[DRAGON_ANIM_BANK_L] = bankTime;
  times[DRAGON_ANIM_BANK_R] = bankTime;
  times[DRAGON_ANIM_DEATH_FALL] =
    (weights[DRAGON_ANIM_DEATH_FALL] as number) > 0
      ? (times[DRAGON_ANIM_DEATH_FALL] as number) + dt
      : 0;

  if (state.forceClip >= 0) {
    const duration = durationOf(rig, state.forceClip);
    if (state.forcePhase >= 0) {
      times[state.forceClip] = state.forcePhase * duration;
    } else if (isOneShot(state.forceClip)) {
      // Replay a one-shot with a short hold at its end.
      let t = (times[state.forceClip] as number) + dt;
      if (t > duration + 0.5) t = 0;
      times[state.forceClip] = t;
    }
    state.oneShot = -1;
    state.oneShotWeight = 0;
  } else {
    // --- One-shots ----------------------------------------------------------------------------
    const anim = input.anim;
    if (!alive) {
      state.oneShot = -1;
    } else {
      const entered = anim !== state.lastAnim && isOneShot(anim);
      const flinch = input.hit && state.oneShot !== DRAGON_ANIM_HIT && state.oneShot < 0;
      if (entered || flinch) {
        const clip = entered ? anim : DRAGON_ANIM_HIT;
        if (rig.clips[clip] != null) {
          state.oneShot = clip;
          state.oneShotTime = 0;
        }
      }
    }
    if (state.oneShot >= 0) {
      const clip = state.oneShot;
      const duration = durationOf(rig, clip);
      state.oneShotTime += dt;
      // `land` ends perched: hold its last frame for as long as the sim says "land".
      const holding = clip === DRAGON_ANIM_LAND && anim === DRAGON_ANIM_LAND;
      if (state.oneShotTime >= duration && !holding) {
        state.oneShot = -1;
        state.oneShotWeight = 0;
      } else {
        const t = Math.min(state.oneShotTime, duration);
        const fadeIn = saturate(t / ONE_SHOT_FADE_IN_S);
        const fadeOut = holding ? 1 : saturate((duration - t) / ONE_SHOT_FADE_OUT_S);
        const peak = clip === DRAGON_ANIM_HIT ? HIT_PEAK_WEIGHT : 1;
        state.oneShotWeight = Math.min(fadeIn, fadeOut) * peak;
        times[clip] = t;
      }
    } else {
      state.oneShotWeight = ease(state.oneShotWeight, 0, 20, dt);
    }
    state.lastAnim = anim;
  }

  // --- Procedural springs -----------------------------------------------------------------------
  const dead = !alive;
  const lookYawTarget = dead ? 0 : clamp(input.yawRate * LOOK_YAW_GAIN, -LOOK_YAW_MAX, LOOK_YAW_MAX);
  const lookPitchTarget = dead
    ? 0
    : clamp(input.pitchRate * LOOK_PITCH_GAIN, -LOOK_PITCH_MAX, LOOK_PITCH_MAX);
  state.lookYaw = ease(state.lookYaw, lookYawTarget, LOOK_RATE, dt);
  state.lookPitch = ease(state.lookPitch, lookPitchTarget, LOOK_RATE, dt);

  const tailYawTarget = clamp(-input.yawRate * TAIL_GAIN, -TAIL_MAX, TAIL_MAX);
  const tailPitchTarget = clamp(-input.pitchRate * TAIL_GAIN, -TAIL_MAX, TAIL_MAX);
  const wingTarget = clamp(-input.rollRate * WING_GAIN, -WING_MAX, WING_MAX);
  let left = dt;
  while (left > 1e-6) {
    const h = left > MAX_SPRING_DT_S ? MAX_SPRING_DT_S : left;
    left -= h;
    state.tailYawVel = springStep(
      state.tailYaw,
      state.tailYawVel,
      tailYawTarget,
      TAIL_STIFFNESS,
      TAIL_DAMPING,
      h,
    );
    state.tailYaw = clamp(state.tailYaw + state.tailYawVel * h, -TAIL_MAX, TAIL_MAX);
    state.tailPitchVel = springStep(
      state.tailPitch,
      state.tailPitchVel,
      tailPitchTarget,
      TAIL_STIFFNESS,
      TAIL_DAMPING,
      h,
    );
    state.tailPitch = clamp(state.tailPitch + state.tailPitchVel * h, -TAIL_MAX, TAIL_MAX);
    state.wingLagVel = springStep(
      state.wingLag,
      state.wingLagVel,
      wingTarget,
      WING_STIFFNESS,
      WING_DAMPING,
      h,
    );
    state.wingLag = clamp(state.wingLag + state.wingLagVel * h, -WING_MAX, WING_MAX);
  }

  let breath = state.breathPhase + dt * BREATH_HZ * (1 + 0.8 * beat);
  breath -= Math.floor(breath);
  state.breathPhase = breath;

  const jawTarget = dead
    ? 0.35
    : (input.flags & DRAGON_FLAG_FIRING) !== 0
      ? 0.6
      : (input.flags & DRAGON_FLAG_CHARGING) !== 0
        ? 0.3
        : 0;
  state.jaw = ease(state.jaw, jawTarget, JAW_RATE, dt);
}

/** Chest scale of the breathing layer for this state (1 +- BREATH_SCALE). */
export function breathScale(state: DragonAnimState): number {
  return 1 + BREATH_SCALE * Math.sin(state.breathPhase * Math.PI * 2);
}

const NECK_SHARE = 0.6;
const TAIL_SHARES = [0.45, 0.8, 1.1, 1.35];
const FINGER_SHARE = 0.6;

/**
 * Step 2: samples the weighted clips into `pose` (unit local quaternions per bone and the root
 * position) and applies the procedural layers. `detail` false skips the procedural layers
 * (the far LOD).
 */
export function writeDragonPose(
  state: DragonAnimState,
  rig: DragonAnimRig,
  pose: PoseAccumulator,
  detail = true,
): void {
  resetPose(pose);
  const clips = rig.clips;
  const weights = state.weights;
  const times = state.times;
  const shot = state.oneShot >= 0 ? state.oneShotWeight : 0;
  const base = 1 - shot;
  for (let i = 0; i < DRAGON_CLIP_COUNT; i++) {
    const w = (weights[i] as number) * base;
    if (w <= 0) continue;
    const clip = clips[i];
    if (clip != null) accumulateClip(pose, clip, times[i] as number, w);
  }
  if (shot > 0) {
    const clip = clips[state.oneShot];
    if (clip != null) accumulateClip(pose, clip, state.oneShotTime, shot);
  }
  finishPose(pose, rig.restQuats, rig.restRootPos);
  if (!detail) return;

  const quats = pose.quats;
  const parents = rig.parentRestWorld;
  const bones = rig.animBones;

  // Neck and head look into the turn: yaw about model +Y, pitch about model +X.
  const neck = bones.neck;
  const links = neck.length + 1;
  const yawEach = (state.lookYaw * (neck.length > 0 ? NECK_SHARE : 0)) / Math.max(1, neck.length);
  const pitchEach =
    (state.lookPitch * (neck.length > 0 ? NECK_SHARE : 0)) / Math.max(1, neck.length);
  if (Math.abs(state.lookYaw) + Math.abs(state.lookPitch) > 1e-3) {
    for (let i = 0; i < neck.length; i++) {
      rotateBoneModelSpace(quats, neck[i] as number, parents, pitchEach, yawEach, 0);
    }
    const headShare = links > 1 ? 1 - NECK_SHARE : 1;
    rotateBoneModelSpace(
      quats,
      bones.head,
      parents,
      state.lookPitch * headShare,
      state.lookYaw * headShare,
      0,
    );
  }

  // Tail follow-through: more bend toward the tip.
  const tail = bones.tail;
  if (Math.abs(state.tailYaw) + Math.abs(state.tailPitch) > 1e-3) {
    const per = tail.length > 0 ? 1 / tail.length : 0;
    for (let i = 0; i < tail.length; i++) {
      const share = (TAIL_SHARES[i] ?? 1) * per;
      rotateBoneModelSpace(
        quats,
        tail[i] as number,
        parents,
        state.tailPitch * share,
        state.tailYaw * share,
        0,
      );
    }
  }

  // Wing tips lag a roll: both wrists turn about the roll axis (+Z), the fingers a bit more.
  const lag = state.wingLag;
  if (Math.abs(lag) > 1e-3) {
    rotateBoneModelSpace(quats, bones.wristLeft, parents, 0, 0, lag);
    rotateBoneModelSpace(quats, bones.wristRight, parents, 0, 0, lag);
    const fl = bones.fingersLeft;
    const fr = bones.fingersRight;
    // The trailing fingers (2, 3) carry the membrane: they lag most.
    for (let i = 1; i < fl.length; i++) {
      rotateBoneModelSpace(quats, fl[i] as number, parents, 0, 0, lag * FINGER_SHARE);
    }
    for (let i = 1; i < fr.length; i++) {
      rotateBoneModelSpace(quats, fr[i] as number, parents, 0, 0, lag * FINGER_SHARE);
    }
  }

  if (state.jaw > 1e-3) applyLocalDelta(quats, bones.jaw, rig.jawOpen, 0, state.jaw);
}
