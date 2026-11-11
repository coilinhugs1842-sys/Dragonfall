/**
 * Wing pose maths for the placeholder dragon: pure, allocation-free, node-testable.
 *
 * A pose TARGET is picked from the WorldView animation hint + flags + airspeed; the view eases
 * its per-dragon pose toward the target (so clips blend instead of popping) and advances a
 * beat phase. Angles are radians in the vertex shader's convention (dragon-shader.ts):
 *   flap   + = wing tips UP (dihedral), turning each wing about the dragon's forward axis
 *   sweep  + = wings swept BACK toward the tail, turning each wing about the up axis
 */

import {
  DRAGON_ANIM_BOOST,
  DRAGON_ANIM_DEATH_FALL,
  DRAGON_ANIM_DIVE,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_HIT,
  DRAGON_ANIM_HOVER,
  DRAGON_ANIM_LAND,
  DRAGON_ANIM_ROAR,
  DRAGON_ANIM_TAKEOFF,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_STALLED,
} from '../shared';
import type { DragonAnimState } from '../shared';

/** Layout of a pose (target or eased): one float each. */
export const POSE_BEAT_HZ = 0;
/** Radians: half the stroke. */
export const POSE_AMPLITUDE = 1;
/** Radians: the angle the stroke swings around. */
export const POSE_BIAS = 2;
/** Radians. */
export const POSE_SWEEP = 3;
/** Extra stroke of the wing tip, as a multiple of the amplitude (the tip lags the root). */
export const POSE_TIP_GAIN = 4;
/** Emissive strength of the team accent on the membranes (1 = normal). */
export const POSE_GLOW = 5;
export const POSE_STRIDE = 6;

const TWO_PI = Math.PI * 2;
/** Radians the wing tip trails the root by. */
export const TIP_PHASE_LAG = 0.9;
/** How fast a pose eases to its target, 1/s (about 0.25 s to settle). */
export const POSE_BLEND_RATE = 9;

function set(
  out: Float32Array,
  hz: number,
  amplitude: number,
  bias: number,
  sweep: number,
  tipGain: number,
  glow: number,
): void {
  out[POSE_BEAT_HZ] = hz;
  out[POSE_AMPLITUDE] = amplitude;
  out[POSE_BIAS] = bias;
  out[POSE_SWEEP] = sweep;
  out[POSE_TIP_GAIN] = tipGain;
  out[POSE_GLOW] = glow;
}

/**
 * Writes the pose target for a dragon to `out[0..POSE_STRIDE)`.
 * `speedRatio` is airspeed / cruise speed (1 = cruising).
 *
 * - glide (and the bank hints): wings spread, slow shallow beat; beats harder when slow,
 *   sweeps a little when fast
 * - flap / hover / takeoff / land: strong fast beat
 * - boost: swept back, stiff, bright accent
 * - dive: folded along the body
 * - dodge (flag): wings tucked for the barrel roll (the roll itself is in the orientation)
 * - stalled (flag): frantic beat
 * - hit: flinch; death fall or not alive: limp, trailing upward, accent off
 */
export function writeWingPoseTarget(
  out: Float32Array,
  anim: DragonAnimState,
  flags: number,
  speedRatio: number,
): void {
  if ((flags & DRAGON_FLAG_ALIVE) === 0 || anim === DRAGON_ANIM_DEATH_FALL) {
    set(out, 2.6, 0.12, 0.85, 0.5, 1.2, 0);
    return;
  }
  const ratio = Number.isFinite(speedRatio) ? speedRatio : 1;
  const slow = ratio < 1 ? (ratio < 0 ? 1 : 1 - ratio) : 0;
  const fast = ratio > 1 ? (ratio > 2 ? 1 : ratio - 1) : 0;

  switch (anim) {
    case DRAGON_ANIM_FLAP:
    case DRAGON_ANIM_TAKEOFF:
      set(out, 2.6, 0.75, 0.05, 0, 0.5, 1);
      break;
    case DRAGON_ANIM_HOVER:
    case DRAGON_ANIM_LAND:
      set(out, 2.1, 0.6, 0.1, 0, 0.5, 1);
      break;
    case DRAGON_ANIM_BOOST:
      set(out, 1.3, 0.1, 0, 0.55, 0.3, 1.6);
      break;
    case DRAGON_ANIM_DIVE:
      set(out, 0.6, 0.03, -0.12, 1.2, 0.2, 0.8);
      break;
    case DRAGON_ANIM_ROAR:
      set(out, 0.8, 0.08, 0.35, 0, 0.3, 1.4);
      break;
    case DRAGON_ANIM_HIT:
      set(out, 3, 0.08, 0.4, 0.3, 0.6, 1.8);
      break;
    default:
      // glide, bank_l, bank_r and anything a newer sim adds.
      set(out, 0.55 + 1.3 * slow, 0.07 + 0.3 * slow, 0.1, 0.05 + 0.25 * fast, 0.4, 1);
      break;
  }

  if ((flags & DRAGON_FLAG_STALLED) !== 0) {
    out[POSE_BEAT_HZ] = 3.2;
    out[POSE_AMPLITUDE] = Math.max(out[POSE_AMPLITUDE] ?? 0, 0.55);
    out[POSE_SWEEP] = 0;
  }
  if ((flags & DRAGON_FLAG_DODGING) !== 0) {
    out[POSE_AMPLITUDE] = (out[POSE_AMPLITUDE] ?? 0) * 0.3;
    out[POSE_BIAS] = 0.2;
    out[POSE_SWEEP] = Math.max(out[POSE_SWEEP] ?? 0, 0.8);
  }
  if ((flags & DRAGON_FLAG_BOOSTING) !== 0) {
    out[POSE_GLOW] = Math.max(out[POSE_GLOW] ?? 0, 1.6);
  }
}

/** Frame-rate independent ease of `current` toward `target` at `rate` per second. */
export function approach(current: number, target: number, rate: number, dtS: number): number {
  if (!(dtS > 0) || !(rate > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-rate * dtS));
}

/** Advances a beat phase by `hz * dtS` turns and wraps it to [0, 2*PI). */
export function advancePhase(phase: number, hz: number, dtS: number): number {
  if (!Number.isFinite(phase)) return 0;
  if (!(dtS > 0) || !Number.isFinite(hz)) return phase;
  let next = (phase + TWO_PI * hz * dtS) % TWO_PI;
  if (next < 0) next += TWO_PI;
  return next;
}

/** Wing-root flap angle at `phase`: `bias + amplitude * sin(phase)`. */
export function flapAngle(phase: number, amplitude: number, bias: number): number {
  return bias + amplitude * Math.sin(phase);
}

/** EXTRA flap angle of the wing tip on top of the root's: it trails the root. */
export function tipFlapAngle(phase: number, amplitude: number, tipGain: number): number {
  return amplitude * tipGain * Math.sin(phase - TIP_PHASE_LAG);
}

/** Start phase per dragon id, so a team does not beat in unison (golden-angle spread). */
export function initialPhase(id: number): number {
  return (id * 2.399963) % TWO_PI;
}
