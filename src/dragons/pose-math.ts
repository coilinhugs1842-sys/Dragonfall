/**
 * Quaternion and baked-clip maths for the skinned dragons, on plain typed arrays. Pure and
 * allocation-free (node-testable, no three.js): the per-frame animation of ten dragons runs
 * entirely through these functions.
 *
 * Quaternions are stored `x, y, z, w`, four floats per bone.
 */

/** A clip sampled at a fixed rate at load time: local bone rotations and the root's position. */
export interface BakedClip {
  readonly name: string;
  /** Seconds. */
  readonly duration: number;
  /** A loop's last sample equals its first. */
  readonly loop: boolean;
  /** Samples per second. */
  readonly fps: number;
  /** Samples, at least 2: `round(duration * fps) + 1`. */
  readonly frameCount: number;
  readonly boneCount: number;
  /** `frameCount * boneCount * 4`, all in the hemisphere of the rest pose. */
  readonly quats: Float32Array;
  /** `frameCount * 3`: local position of the root bone. */
  readonly rootPos: Float32Array;
}

/** A weighted sum of poses being built; `finishPose` turns it into unit quaternions. */
export interface PoseAccumulator {
  readonly boneCount: number;
  /** `boneCount * 4`. */
  readonly quats: Float32Array;
  readonly rootPos: Float32Array;
  weight: number;
}

export function createPoseAccumulator(boneCount: number): PoseAccumulator {
  return {
    boneCount,
    quats: new Float32Array(boneCount * 4),
    rootPos: new Float32Array(3),
    weight: 0,
  };
}

export function resetPose(pose: PoseAccumulator): void {
  pose.quats.fill(0);
  pose.rootPos[0] = 0;
  pose.rootPos[1] = 0;
  pose.rootPos[2] = 0;
  pose.weight = 0;
}

/** Wraps a loop's time into `[0, duration)`; clamps a one-shot's into `[0, duration]`. */
export function clipTime(clip: BakedClip, timeS: number): number {
  const duration = clip.duration;
  if (!(duration > 0) || !Number.isFinite(timeS)) return 0;
  if (clip.loop) {
    const t = timeS % duration;
    return t < 0 ? t + duration : t;
  }
  return timeS < 0 ? 0 : timeS > duration ? duration : timeS;
}

/**
 * Adds `weight` times the clip's pose at `timeS` (linear between the two nearest samples).
 * The clips of one dragon are baked into the same hemisphere, so a plain weighted sum followed
 * by `finishPose` is a normalized-lerp blend.
 */
export function accumulateClip(
  pose: PoseAccumulator,
  clip: BakedClip,
  timeS: number,
  weight: number,
): void {
  if (!(weight > 0)) return;
  const last = clip.frameCount - 1;
  const f = clipTime(clip, timeS) * clip.fps;
  let i0 = Math.floor(f);
  if (i0 >= last) i0 = last - 1;
  if (i0 < 0) i0 = 0;
  const a = Math.min(1, Math.max(0, f - i0));
  const w0 = (1 - a) * weight;
  const w1 = a * weight;
  const stride = clip.boneCount * 4;
  const src = clip.quats;
  const dst = pose.quats;
  const o0 = i0 * stride;
  const o1 = o0 + stride;
  const n = Math.min(stride, dst.length);
  for (let k = 0; k < n; k++) {
    dst[k] = (dst[k] as number) + (src[o0 + k] as number) * w0 + (src[o1 + k] as number) * w1;
  }
  const rp = clip.rootPos;
  const r0 = i0 * 3;
  const out = pose.rootPos;
  out[0] = (out[0] as number) + (rp[r0] as number) * w0 + (rp[r0 + 3] as number) * w1;
  out[1] = (out[1] as number) + (rp[r0 + 1] as number) * w0 + (rp[r0 + 4] as number) * w1;
  out[2] = (out[2] as number) + (rp[r0 + 2] as number) * w0 + (rp[r0 + 5] as number) * w1;
  pose.weight += weight;
}

/**
 * Normalizes the accumulated pose. A bone whose sum collapsed (or a pose with no weight at
 * all) falls back to `rest`.
 */
export function finishPose(pose: PoseAccumulator, rest: Float32Array, restRootPos: Float32Array): void {
  const q = pose.quats;
  const n = pose.boneCount;
  for (let b = 0; b < n; b++) {
    const o = b * 4;
    const x = q[o] as number;
    const y = q[o + 1] as number;
    const z = q[o + 2] as number;
    const w = q[o + 3] as number;
    const len2 = x * x + y * y + z * z + w * w;
    if (len2 > 1e-10) {
      const inv = 1 / Math.sqrt(len2);
      q[o] = x * inv;
      q[o + 1] = y * inv;
      q[o + 2] = z * inv;
      q[o + 3] = w * inv;
    } else {
      q[o] = rest[o] as number;
      q[o + 1] = rest[o + 1] as number;
      q[o + 2] = rest[o + 2] as number;
      q[o + 3] = rest[o + 3] as number;
    }
  }
  const rp = pose.rootPos;
  if (pose.weight > 1e-6) {
    const inv = 1 / pose.weight;
    rp[0] = (rp[0] as number) * inv;
    rp[1] = (rp[1] as number) * inv;
    rp[2] = (rp[2] as number) * inv;
  } else {
    rp[0] = restRootPos[0] as number;
    rp[1] = restRootPos[1] as number;
    rp[2] = restRootPos[2] as number;
  }
}

/**
 * Turns bone `bone` by the rotation vector `(rx, ry, rz)` (radians, axis * angle) given in
 * MODEL space, about the bone's own origin. `parentRestWorld` holds, per bone, the model-space
 * rotation of its parent in the rest pose; the turn is exact when the parent chain is at rest
 * and a close approximation for the small procedural angles this is used for.
 */
export function rotateBoneModelSpace(
  quats: Float32Array,
  bone: number,
  parentRestWorld: Float32Array,
  rx: number,
  ry: number,
  rz: number,
): void {
  if (bone < 0) return;
  const o = bone * 4;
  // v' = conj(P) * v * P: the rotation vector in the parent's frame.
  const px = -(parentRestWorld[o] as number);
  const py = -(parentRestWorld[o + 1] as number);
  const pz = -(parentRestWorld[o + 2] as number);
  const pw = parentRestWorld[o + 3] as number;
  const tx = 2 * (py * rz - pz * ry);
  const ty = 2 * (pz * rx - px * rz);
  const tz = 2 * (px * ry - py * rx);
  const vx = rx + pw * tx + (py * tz - pz * ty);
  const vy = ry + pw * ty + (pz * tx - px * tz);
  const vz = rz + pw * tz + (px * ty - py * tx);
  // Rotation vector -> quaternion.
  const angle = Math.sqrt(vx * vx + vy * vy + vz * vz);
  let dx = vx * 0.5;
  let dy = vy * 0.5;
  let dz = vz * 0.5;
  let dw = 1;
  if (angle > 1e-4) {
    const s = Math.sin(angle * 0.5) / angle;
    dx = vx * s;
    dy = vy * s;
    dz = vz * s;
    dw = Math.cos(angle * 0.5);
  }
  // q' = d * q
  const qx = quats[o] as number;
  const qy = quats[o + 1] as number;
  const qz = quats[o + 2] as number;
  const qw = quats[o + 3] as number;
  const nx = dw * qx + dx * qw + dy * qz - dz * qy;
  const ny = dw * qy - dx * qz + dy * qw + dz * qx;
  const nz = dw * qz + dx * qy - dy * qx + dz * qw;
  const nw = dw * qw - dx * qx - dy * qy - dz * qz;
  const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
  quats[o] = nx * inv;
  quats[o + 1] = ny * inv;
  quats[o + 2] = nz * inv;
  quats[o + 3] = nw * inv;
}

/**
 * Post-multiplies bone `bone` by `amount` of the local delta rotation `delta` (4 floats at
 * `deltaOffset`): `q' = q * nlerp(identity, delta, amount)`. Used for the jaw.
 */
export function applyLocalDelta(
  quats: Float32Array,
  bone: number,
  delta: Float32Array,
  deltaOffset: number,
  amount: number,
): void {
  if (bone < 0 || !(amount > 0)) return;
  const sign = (delta[deltaOffset + 3] as number) < 0 ? -1 : 1;
  let dx = (delta[deltaOffset] as number) * sign * amount;
  let dy = (delta[deltaOffset + 1] as number) * sign * amount;
  let dz = (delta[deltaOffset + 2] as number) * sign * amount;
  let dw = 1 - amount + (delta[deltaOffset + 3] as number) * sign * amount;
  const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);
  dx *= dl;
  dy *= dl;
  dz *= dl;
  dw *= dl;
  const o = bone * 4;
  const qx = quats[o] as number;
  const qy = quats[o + 1] as number;
  const qz = quats[o + 2] as number;
  const qw = quats[o + 3] as number;
  quats[o] = qw * dx + qx * dw + qy * dz - qz * dy;
  quats[o + 1] = qw * dy - qx * dz + qy * dw + qz * dx;
  quats[o + 2] = qw * dz + qx * dy - qy * dx + qz * dw;
  quats[o + 3] = qw * dw - qx * dx - qy * dy - qz * dz;
}

/**
 * Body-frame angular velocity (radians per second) that takes orientation `prev` to `next` in
 * `dtS`, written to `out[0..2]`. In dragon space (+X left, +Y up, +Z forward): x > 0 pitches
 * the nose down, y > 0 yaws left, z > 0 rolls the left wing up (a right bank).
 */
export function bodyAngularVelocity(
  out: Float32Array,
  px: number,
  py: number,
  pz: number,
  pw: number,
  nx: number,
  ny: number,
  nz: number,
  nw: number,
  dtS: number,
): void {
  if (!(dtS > 1e-5)) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return;
  }
  // d = conj(prev) * next
  let dx = pw * nx - px * nw - py * nz + pz * ny;
  let dy = pw * ny + px * nz - py * nw - pz * nx;
  let dz = pw * nz - px * ny + py * nx - pz * nw;
  const dw = pw * nw + px * nx + py * ny + pz * nz;
  if (dw < 0) {
    dx = -dx;
    dy = -dy;
    dz = -dz;
  }
  const k = 2 / dtS;
  out[0] = dx * k;
  out[1] = dy * k;
  out[2] = dz * k;
}

/** Frame-rate independent ease of `current` toward `target` at `rate` per second. */
export function ease(current: number, target: number, rate: number, dtS: number): number {
  if (!(dtS > 0)) return current;
  return target + (current - target) * Math.exp(-rate * dtS);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function saturate(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
