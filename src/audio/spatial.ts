/**
 * Cheap spatialisation maths (T-3.8): a stereo pan, a distance gain and a distance low-pass per
 * voice, instead of an HRTF PannerNode per voice (too costly x24 on the target CPU). Pure
 * functions on numbers, no WebAudio, allocation-free.
 */

import type { Vec3 } from '../shared';

/** Where the ears are: the camera. `forward` and `up` need not be unit length. */
export interface AudioListener {
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
}

/** The mix numbers of the spatialiser. Mutable so a dev GUI can tune them live. */
export interface SpatialTuning {
  /** Widest pan a sound gets (1 = hard left/right, which is tiring on headphones). */
  panWidth: number;
  /** Sounds closer than about this (metres) drift to the centre instead of flipping sides. */
  panNearM: number;
  /** Loudness falls as (ref / distance) to this power beyond the reference distance. */
  rolloff: number;
  /** Low-pass cutoff of a sound at its reference distance and at its max distance (Hz). */
  nearCutoffHz: number;
  farCutoffHz: number;
  /** A sound straight behind the listener keeps this fraction of its cutoff (a cheap rear cue). */
  rearCutoffScale: number;
}

export const SPATIAL_TUNING: SpatialTuning = {
  panWidth: 0.8,
  panNearM: 6,
  rolloff: 0.75,
  nearCutoffHz: 18_000,
  farCutoffHz: 900,
  rearCutoffScale: 0.55,
};

/** The listener as plain numbers with an orthonormal right/forward pair, filled once a frame. */
export interface ListenerFrame {
  x: number;
  y: number;
  z: number;
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  rightX: number;
  rightY: number;
  rightZ: number;
}

export function createListenerFrame(): ListenerFrame {
  // Looking down +Z with +Y up, so right is -X (the convention is in `writeListenerFrame`).
  return {
    x: 0,
    y: 0,
    z: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: 1,
    rightX: -1,
    rightY: 0,
    rightZ: 0,
  };
}

/**
 * Copies the listener into `out`. Right = forward x up (right-handed, as three.js cameras:
 * forward -Z and up +Y give right +X). A degenerate input (zero vectors, forward parallel to
 * up, NaN) keeps the previous axes, so a bad camera frame can never produce NaN pans.
 */
export function writeListenerFrame(out: ListenerFrame, listener: AudioListener): ListenerFrame {
  const p = listener.position;
  if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
  }
  const f = listener.forward;
  const u = listener.up;
  const forwardLength = Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z);
  if (!(forwardLength > 1e-6) || !Number.isFinite(forwardLength)) return out;
  const fx = f.x / forwardLength;
  const fy = f.y / forwardLength;
  const fz = f.z / forwardLength;
  const rx = fy * u.z - fz * u.y;
  const ry = fz * u.x - fx * u.z;
  const rz = fx * u.y - fy * u.x;
  const rightLength = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (!(rightLength > 1e-6) || !Number.isFinite(rightLength)) return out;
  out.forwardX = fx;
  out.forwardY = fy;
  out.forwardZ = fz;
  out.rightX = rx / rightLength;
  out.rightY = ry / rightLength;
  out.rightZ = rz / rightLength;
  return out;
}

/**
 * Loudness of a sound `distance` metres away: 1 inside `refDistance`, an inverse-power fall
 * beyond it, and a smooth window that reaches exactly 0 at `maxDistance` (so culling a sound
 * past its max distance never cuts an audible one).
 */
export function distanceGain(
  distance: number,
  refDistance: number,
  maxDistance: number,
  tuning: SpatialTuning = SPATIAL_TUNING,
): number {
  if (!(distance > refDistance)) return 1;
  if (!(distance < maxDistance)) return 0;
  const inverse = Math.pow(refDistance / distance, tuning.rolloff);
  const u = (distance - refDistance) / (maxDistance - refDistance);
  return inverse * (1 - u * u);
}

/** Air absorption: the cutoff slides (in pitch, not Hz) from near to far with distance. */
export function distanceCutoffHz(
  distance: number,
  refDistance: number,
  maxDistance: number,
  tuning: SpatialTuning = SPATIAL_TUNING,
): number {
  if (!(distance > refDistance)) return tuning.nearCutoffHz;
  if (!(distance < maxDistance)) return tuning.farCutoffHz;
  const u = (distance - refDistance) / (maxDistance - refDistance);
  return tuning.nearCutoffHz * Math.pow(tuning.farCutoffHz / tuning.nearCutoffHz, u);
}

/** What one voice needs from the spatialiser. Reused scratch: read it before the next call. */
export interface SpatialResult {
  /** Metres from the listener. */
  distance: number;
  /** -1 (left) .. 1 (right), for a StereoPannerNode. */
  pan: number;
  /** 0..1 multiplier on the sound's own gain. */
  gain: number;
  /** Low-pass cutoff in Hz. */
  cutoffHz: number;
}

export function createSpatialResult(): SpatialResult {
  return { distance: 0, pan: 0, gain: 1, cutoffHz: SPATIAL_TUNING.nearCutoffHz };
}

/** Pan, gain and cutoff of a sound at (x, y, z) for this listener. Never returns NaN. */
export function spatialise(
  out: SpatialResult,
  listener: ListenerFrame,
  x: number,
  y: number,
  z: number,
  refDistance: number,
  maxDistance: number,
  tuning: SpatialTuning = SPATIAL_TUNING,
): SpatialResult {
  const dx = x - listener.x;
  const dy = y - listener.y;
  const dz = z - listener.z;
  let distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(distance)) distance = maxDistance;
  out.distance = distance;
  out.gain = distanceGain(distance, refDistance, maxDistance, tuning);
  let cutoff = distanceCutoffHz(distance, refDistance, maxDistance, tuning);
  if (distance > 1e-4 && distance < maxDistance) {
    const inverse = 1 / distance;
    const side = (dx * listener.rightX + dy * listener.rightY + dz * listener.rightZ) * inverse;
    const front =
      (dx * listener.forwardX + dy * listener.forwardY + dz * listener.forwardZ) * inverse;
    const pan = side * tuning.panWidth * (distance / (distance + tuning.panNearM));
    out.pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    if (front < 0) cutoff *= 1 - front * (tuning.rearCutoffScale - 1);
  } else {
    out.pan = 0;
  }
  out.cutoffHz = cutoff;
  return out;
}
