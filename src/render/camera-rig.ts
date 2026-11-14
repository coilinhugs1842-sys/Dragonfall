/**
 * Chase camera (T-1.3): follows the local dragon from behind and slightly above, at render rate.
 *
 * It reads the dragon ONLY through the WorldView contract (position, orientation, velocity,
 * flags), never from the sim. `ChaseCamera` is the maths on three's math classes (runs in node,
 * unit-tested); `createCameraRig` wraps it round a `PerspectiveCamera`.
 *
 * HOW IT MOVES
 * - Heading: the camera sits behind a SMOOTHED copy of the dragon's nose direction (critically
 *   damped spring), so the dragon visibly turns first and the camera swings round after it. The
 *   nose direction is taken from the orientation's forward axis, which the barrel-roll dodge
 *   (a spin about that axis) does not move.
 * - Position: a second critically damped spring, integrated in the frame that moves with the
 *   dragon's velocity. Steady flight has zero lag at any speed; accelerations (boost, flap kick,
 *   dodge burst, a hard turn) show as a short, bounded lag (`maxLag`).
 * - Look-ahead: the camera looks at a point ahead of the dragon, blended toward the real nose
 *   direction (`lookLead`) and shifted toward the steering input given to `setAim`.
 * - Bank: the camera rolls by a fraction of the dragon's bank, lagging. The bank is read as the
 *   height of the left wing axis (sine of the bank), which stays continuous through a dodge spin.
 * - Speed: FOV widens and the camera drops back with speed and boost, eased.
 * - Boost shake: two sine pairs on a clock, a few centimetres. Deterministic, no random numbers.
 * - Terrain: one raycast per frame from the dragon to the camera. A hit pulls the camera in at
 *   once to just in front of the hit; it eases back out slowly once the way is clear.
 * - Floor: the camera's free position is kept at or above `minY` (the opaque cloud sea plus a
 *   margin), so a low climb or a dip into the sea does not put it under the surface, looking at
 *   its underside. Only a terrain pull-in toward a dragon that is itself under the surface can.
 *
 * FRAME RATE: every smoothing step is an exact exponential or closed-form spring over `dt`, so
 * 30 fps and 144 fps follow the same path (tests/render/camera-rig.test.ts). `dt` is clamped to
 * `maxDt`; a target that jumps more than `snapDistance` (spawn, respawn, teleport) or any
 * non-finite internal value snaps the camera instead of sweeping it across the map. A non-finite
 * target pose is ignored and the camera stays where it was.
 *
 * REDUCE MOTION (accessibility): no shake, no camera roll, a smaller FOV change.
 *
 * QUALITY: none of this depends on the quality preset (it is a handful of multiplies and at most
 * one raycast per frame), so there is no `setQuality`.
 *
 * Nothing in `update` allocates: all scratch objects are instance fields.
 */
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { DRAGON_FLAG_BOOSTING, DRAGON_FLAG_DODGING, FLIGHT_TUNING, findDragonView } from '../shared';
import type { Quat, TerrainQuery, Vec3, WorldView } from '../shared';

/** What the camera needs from a dragon. `DragonView` satisfies it as-is. */
export interface ChaseTarget {
  readonly position: Vec3;
  readonly orientation: Quat;
  readonly velocity: Vec3;
  readonly flags: number;
}

/**
 * Terrain query the camera uses to stay out of rock: the `raycast` half of the shared
 * `TerrainQuery` contract (distance to the first hit within `maxDistance`, or -1). The rig
 * always passes a unit direction. Must not allocate: it runs every frame.
 */
export type CameraTerrainRaycaster = Pick<TerrainQuery, 'raycast'>;

/** Metres, radians, seconds; FOV in degrees (three's unit). Rates are 1/s. */
export interface CameraRigTuning {
  /** Distance behind the dragon at cruise speed and below. */
  distance: number;
  /** Height above the dragon. */
  height: number;
  /** Extra distance at top speed. */
  speedPullBack: number;
  distanceRate: number;
  /** How far ahead of the dragon the camera looks, and how high above it. */
  lookAhead: number;
  lookHeight: number;
  /** 0 = look along the smoothed heading, 1 = along the dragon's real nose direction. */
  lookLead: number;
  /** Metres the look point shifts sideways/up at full steer (`setAim`). */
  aimShift: number;
  aimRate: number;
  /** Spring frequency of the heading follow. Higher = the camera swings round sooner. */
  headingRate: number;
  /** Spring frequency of the position follow, and the cap on how far it may lag. */
  positionRate: number;
  maxLag: number;
  /** Camera roll = dragon bank times this, capped at `maxRoll`. */
  rollFraction: number;
  maxRoll: number;
  rollRate: number;
  /**
   * How fast the chase "up" blends between world-up and the dragon's local up through inverted
   * flight. Lower = less snap when looping upright again.
   */
  softUpRate: number;
  /** Degrees added at top speed, and while boosting. */
  fovSpeedKick: number;
  fovBoostKick: number;
  fovRate: number;
  /** Multiplier on both FOV kicks when "reduce motion" is on. */
  reduceMotionFovScale: number;
  /** Shake amplitude in metres at full boost, its base frequency in Hz, and its fade rate. */
  shakeAmplitude: number;
  shakeFrequency: number;
  boostRate: number;
  /** Gap kept between the camera and a terrain hit. */
  collisionMargin: number;
  /** How fast the camera eases back out after terrain pulled it in. */
  collisionEaseOutRate: number;
  /** A target that moves further than this in one frame is a teleport: snap. */
  snapDistance: number;
  /** Longest frame the camera integrates; longer frames are treated as this long. */
  maxDt: number;
}

/** First-pass feel values. Mutable so the dev GUI can tune them live. */
export const CAMERA_RIG_TUNING: CameraRigTuning = {
  distance: 15,
  height: 3.8,
  speedPullBack: 3.5,
  distanceRate: 2.5,
  lookAhead: 24,
  lookHeight: 1.6,
  lookLead: 0.45,
  aimShift: 4,
  aimRate: 6,
  headingRate: 6.5,
  positionRate: 12,
  maxLag: 3,
  rollFraction: 0.3,
  maxRoll: 0.35,
  rollRate: 4,
  softUpRate: 5,
  fovSpeedKick: 11,
  fovBoostKick: 6,
  fovRate: 3.5,
  reduceMotionFovScale: 0.4,
  shakeAmplitude: 0.05,
  shakeFrequency: 13,
  boostRate: 5,
  collisionMargin: 0.8,
  collisionEaseOutRate: 1.5,
  snapDistance: 40,
  maxDt: 0.1,
};

/** Vertical FOV in degrees. The Settings menu offers MIN_BASE_FOV..MAX_BASE_FOV. */
export const DEFAULT_BASE_FOV = 62;
export const MIN_BASE_FOV = 45;
export const MAX_BASE_FOV = 100;
/** Hard ceiling on base + speed + boost, whatever the tuning says. */
export const MAX_CAMERA_FOV = 120;
/** `updateProjectionMatrix` is skipped while the FOV moved less than this (degrees). */
export const FOV_EPSILON = 0.01;

const UP = /* @__PURE__ */ new Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;
const TINY = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamps to 0..1; NaN becomes 0. */
function clamp01(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

// --- Pure maths (exported for the tests and for other cameras) ----------------------------------

/**
 * Fraction of the remaining distance covered after `dtS` at `rate` (1/s): `1 - e^(-rate dt)`.
 * `value += (target - value) * dampFactor(rate, dt)` gives the same curve at any frame rate.
 */
export function dampFactor(rate: number, dtS: number): number {
  if (!(rate > 0) || !(dtS > 0)) return 0;
  return 1 - Math.exp(-rate * dtS);
}

/** Position and velocity of one spring axis. */
export interface SpringAxis {
  value: number;
  velocity: number;
}

/**
 * Exact step of a critically damped spring (no overshoot, no oscillation) toward a fixed
 * `target`: the closed-form solution over `dtS`, so two half steps equal one full step.
 * `omega` is the spring frequency in rad/s; the value covers about 63 % of a step change in
 * `2.15 / omega` seconds. Writes the result back into `axis`.
 */
export function stepCriticalSpring(
  axis: SpringAxis,
  target: number,
  omega: number,
  dtS: number,
): void {
  if (!(omega > 0) || !(dtS > 0)) return;
  const offset = axis.value - target;
  const a = axis.velocity + omega * offset;
  const decay = Math.exp(-omega * dtS);
  axis.value = target + (offset + a * dtS) * decay;
  axis.velocity = (axis.velocity - omega * a * dtS) * decay;
}

/** Keeps a base FOV setting inside MIN_BASE_FOV..MAX_BASE_FOV; NaN gives the default. */
export function clampBaseFov(fovDeg: number): number {
  if (!Number.isFinite(fovDeg)) return DEFAULT_BASE_FOV;
  return clamp(fovDeg, MIN_BASE_FOV, MAX_BASE_FOV);
}

/** 0 at cruise speed and below, 1 at top speed and above, smooth in between. */
export function speedFactor(speed: number, cruiseSpeed: number, maxSpeed: number): number {
  const span = maxSpeed - cruiseSpeed;
  if (!(span > 0)) return 0;
  const t = clamp01((speed - cruiseSpeed) / span);
  return t * t * (3 - 2 * t);
}

/**
 * FOV the camera eases toward: the base plus the speed and boost kicks. Always within
 * [base, MAX_CAMERA_FOV] (negative kicks in the tuning are ignored).
 */
export function chaseFovTarget(
  baseFovDeg: number,
  speedT: number,
  boosting: boolean,
  tuning: CameraRigTuning,
  reduceMotion: boolean,
): number {
  const base = clampBaseFov(baseFovDeg);
  let kick = Math.max(0, tuning.fovSpeedKick) * clamp01(speedT);
  if (boosting) kick += Math.max(0, tuning.fovBoostKick);
  if (reduceMotion) kick *= clamp01(tuning.reduceMotionFovScale);
  const fov = base + kick;
  return fov < MAX_CAMERA_FOV ? fov : MAX_CAMERA_FOV;
}

/**
 * Terrain pull-in. `pull` is where the camera sits along the dragon -> camera line, as a
 * fraction of `rayLength` (1 = at its free position). Returns the new fraction:
 * - a hit closer than the camera moves it IN at once, to `margin` in front of the hit (half the
 *   hit distance when the hit is closer than two margins), so `pull * rayLength` is never
 *   beyond `hitDistance`;
 * - otherwise it eases OUT toward the furthest allowed fraction at `easeOutRate`.
 * `hitDistance` < 0 (or NaN) means the ray hit nothing.
 */
export function resolveCameraPull(
  pull: number,
  hitDistance: number,
  rayLength: number,
  margin: number,
  easeOutRate: number,
  dtS: number,
): number {
  let allowed = 1;
  if (hitDistance >= 0 && rayLength > 0) {
    const gap = margin > 0 ? Math.min(margin, hitDistance * 0.5) : 0;
    allowed = clamp01((hitDistance - gap) / rayLength);
  }
  if (!(pull < allowed)) return allowed;
  const current = pull > 0 ? pull : 0;
  return current + (allowed - current) * dampFactor(easeOutRate, dtS);
}

/** Bank angle the camera eases toward, from the height of the dragon's left wing axis. */
export function cameraRollTarget(leftAxisY: number, tuning: CameraRigTuning): number {
  const bank = Math.asin(clamp(leftAxisY, -1, 1));
  const limit = Math.max(0, tuning.maxRoll);
  return clamp(bank * tuning.rollFraction, -limit, limit) || 0;
}

/**
 * Deterministic shake wave in [-1, 1]: two sines with unrelated frequencies. `timeS` is the
 * camera's own clock, `frequencyHz` the base frequency, `phase` separates the two axes.
 */
export function shakeWave(timeS: number, frequencyHz: number, phase: number): number {
  const w = TWO_PI * frequencyHz * timeS;
  return (Math.sin(w + phase) + 0.6 * Math.sin(w * 1.731 + phase * 2.3 + 1.1)) / 1.6;
}

// --- The camera state ----------------------------------------------------------------------------

export interface ChaseCameraOptions {
  /** Vertical FOV in degrees at cruise speed. Default DEFAULT_BASE_FOV. */
  baseFovDeg?: number;
  /** Accessibility: no shake, no roll, smaller FOV change. Default false. */
  reduceMotion?: boolean;
  terrain?: CameraTerrainRaycaster | null;
  /**
   * World Y the camera stays at or above: the cloud-sea surface plus a margin (the sea is an
   * opaque plane and is not part of `terrain`). Default: no floor.
   */
  minY?: number;
  /** Default: the shared CAMERA_RIG_TUNING table (live-tunable). */
  tuning?: CameraRigTuning;
}

export class ChaseCamera {
  /** Results of the last `update`: copy them onto the camera. */
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  fov: number;

  readonly tuning: CameraRigTuning;
  reduceMotion: boolean;
  /** 0..1 multiplier on the shake amplitude (the Settings menu's "camera shake"). */
  shakeScale = 1;
  terrain: CameraTerrainRaycaster | null;
  /** See `ChaseCameraOptions.minY`. -Infinity (or NaN) = no floor. */
  minY: number;

  private baseFov: number;
  private initialised = false;
  private snapPending = true;

  /** Smoothed unit heading the camera sits behind, and its spring velocity. */
  private readonly heading = new Vector3(0, 0, 1);
  private readonly headingVelocity = new Vector3();
  /** Camera position before shake and terrain pull-in, and its velocity. */
  private readonly springPosition = new Vector3();
  private readonly springVelocity = new Vector3();
  private readonly lastTarget = new Vector3();
  private distance: number;
  private roll = 0;
  private boost = 0;
  private aimX = 0;
  private aimY = 0;
  private aimTargetX = 0;
  private aimTargetY = 0;
  private pull = 1;
  private shakeTime = 0;

  private readonly axis: SpringAxis = { value: 0, velocity: 0 };
  private readonly right = new Vector3();
  private readonly camUp = new Vector3();
  /** Blended world/local up so the chase view can go inverted smoothly. */
  private readonly softUp = new Vector3(0, 1, 0);
  /**
   * Latched inverted state for soft-up. Soft `invertBlend` from bank-tilted `aligned` used to
   * chatter during hard upright turns (laptop pitch/yaw), flipping the horizon mid-bank.
   */
  private inverted = false;
  /** Last stable horizon reference; reused when the nose is near vertical so the basis does not whip. */
  private readonly lastHorizonRef = new Vector3(0, 1, 0);
  private readonly look = new Vector3();
  private readonly matrix = new Matrix4();
  private readonly rollQuat = new Quaternion();

  constructor(options: ChaseCameraOptions = {}) {
    this.tuning = options.tuning ?? CAMERA_RIG_TUNING;
    this.baseFov = clampBaseFov(options.baseFovDeg ?? DEFAULT_BASE_FOV);
    this.reduceMotion = options.reduceMotion ?? false;
    this.terrain = options.terrain ?? null;
    this.minY = options.minY ?? -Infinity;
    this.fov = this.baseFov;
    this.distance = this.tuning.distance;
  }

  get baseFovDeg(): number {
    return this.baseFov;
  }

  /** Clamped to MIN_BASE_FOV..MAX_BASE_FOV. The camera eases to the new value. */
  setBaseFov(fovDeg: number): void {
    this.baseFov = clampBaseFov(fovDeg);
  }

  /** Steering input (the InputFrame's steerX/steerY) for the look-ahead shift. Optional. */
  setAim(steerX: number, steerY: number): void {
    this.aimTargetX = clamp(steerX, -1, 1) || 0;
    this.aimTargetY = clamp(steerY, -1, 1) || 0;
  }

  /** Makes the next `update` place the camera directly (after a spawn, a cut, a new match). */
  snap(): void {
    this.snapPending = true;
  }

  /**
   * Advances the camera by `dtS` seconds toward its place behind `target` and writes
   * `position`, `quaternion` and `fov`. Returns false (and changes nothing the caller should
   * use) when the target pose is not finite.
   */
  update(target: ChaseTarget, dtS: number): boolean {
    const tuning = this.tuning;
    const px = target.position.x;
    const py = target.position.y;
    const pz = target.position.z;
    const q = target.orientation;
    const qLengthSq = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
    if (!Number.isFinite(px + py + pz) || !(qLengthSq > TINY) || !Number.isFinite(qLengthSq)) {
      return false;
    }

    // Dragon forward (+Z) and left (+X) axes in world space; the quaternion need not be unit.
    const s = 2 / qLengthSq;
    let fx = s * (q.x * q.z + q.w * q.y);
    let fy = s * (q.y * q.z - q.w * q.x);
    let fz = 1 - s * (q.x * q.x + q.y * q.y);
    const fLength = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (!(fLength > TINY)) return false;
    fx /= fLength;
    fy /= fLength;
    fz /= fLength;
    const leftY = s * (q.x * q.y + q.w * q.z);
    let ux = s * (q.x * q.y - q.w * q.z);
    let uy = 1 - s * (q.x * q.x + q.z * q.z);
    let uz = s * (q.y * q.z + q.w * q.x);
    const uLength = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (uLength > TINY) {
      ux /= uLength;
      uy /= uLength;
      uz /= uLength;
    } else {
      ux = 0;
      uy = 1;
      uz = 0;
    }
    // Soft up is BANK-FREE: ± the horizon up for this heading. Blending toward the dragon's full
    // local up made the camera roll with every turn while inverted (upright stayed world-locked).
    // `aligned` = how much the dragon's local up matches that horizon up (bank tilts it sideways
    // but keeps the sign until ~90°, so hard banks do not falsely flip the view).
    const dodging = (target.flags & DRAGON_FLAG_DODGING) !== 0;
    let refX = 0;
    let refY = 1;
    let refZ = 0;
    const fDotRef = fx * refX + fy * refY + fz * refZ;
    refX -= fx * fDotRef;
    refY -= fy * fDotRef;
    refZ -= fz * fDotRef;
    const refLen = Math.sqrt(refX * refX + refY * refY + refZ * refZ);
    if (refLen > 0.15) {
      refX /= refLen;
      refY /= refLen;
      refZ /= refLen;
      this.lastHorizonRef.set(refX, refY, refZ);
    } else if (refLen > TINY) {
      // Near vertical: keep the previous horizon axis so the basis does not spin with tiny noise.
      refX = this.lastHorizonRef.x;
      refY = this.lastHorizonRef.y;
      refZ = this.lastHorizonRef.z;
      const keep = refX * fx + refY * fy + refZ * fz;
      refX -= fx * keep;
      refY -= fy * keep;
      refZ -= fz * keep;
      const keepLen = Math.sqrt(refX * refX + refY * refY + refZ * refZ);
      if (keepLen > TINY) {
        refX /= keepLen;
        refY /= keepLen;
        refZ /= keepLen;
        this.lastHorizonRef.set(refX, refY, refZ);
      } else {
        refX = this.lastHorizonRef.x;
        refY = this.lastHorizonRef.y;
        refZ = this.lastHorizonRef.z;
      }
    } else {
      // Nose straight up/down: reuse last horizon, else a stable sideways in XZ.
      refX = this.lastHorizonRef.x;
      refY = this.lastHorizonRef.y;
      refZ = this.lastHorizonRef.z;
      const keep = refX * fx + refY * fy + refZ * fz;
      refX -= fx * keep;
      refY -= fy * keep;
      refZ -= fz * keep;
      const keepLen = Math.sqrt(refX * refX + refY * refY + refZ * refZ);
      if (keepLen > TINY) {
        refX /= keepLen;
        refY /= keepLen;
        refZ /= keepLen;
      } else {
        refX = -fz;
        refY = 0;
        refZ = fx;
        const sideLen = Math.sqrt(refX * refX + refZ * refZ);
        if (sideLen > TINY) {
          refX /= sideLen;
          refZ /= sideLen;
        } else {
          refX = 1;
          refY = 0;
          refZ = 0;
        }
      }
      this.lastHorizonRef.set(refX, refY, refZ);
    }
    const aligned = ux * refX + uy * refY + uz * refZ;
    // Hysteresis: hard banks while upright must not start flipping soft-up.
    if (dodging) {
      // Soft-up ignores local up while dodging so a 180° roll does not flip the horizon.
    } else if (!this.inverted && aligned < -0.2) {
      this.inverted = true;
    } else if (this.inverted && aligned > 0.35) {
      this.inverted = false;
    }
    const invertBlend = dodging ? 0 : this.inverted ? 1 : 0;
    // 0 = +ref (upright horizon), 1 = -ref (inverted horizon). No bank in either.
    const flip = 1 - 2 * invertBlend;
    let wantX = refX * flip;
    let wantY = refY * flip;
    let wantZ = refZ * flip;
    const wantLen = Math.sqrt(wantX * wantX + wantY * wantY + wantZ * wantZ);
    if (wantLen > TINY) {
      wantX /= wantLen;
      wantY /= wantLen;
      wantZ /= wantLen;
    } else {
      wantX = 0;
      wantY = 1;
      wantZ = 0;
    }

    let vx = target.velocity.x;
    let vy = target.velocity.y;
    let vz = target.velocity.z;
    if (!Number.isFinite(vx + vy + vz)) {
      vx = 0;
      vy = 0;
      vz = 0;
    }

    const dt = dtS > 0 ? (dtS < tuning.maxDt ? dtS : tuning.maxDt) : 0;
    const boosting = (target.flags & DRAGON_FLAG_BOOSTING) !== 0;
    const speedT = speedFactor(
      Math.sqrt(vx * vx + vy * vy + vz * vz),
      FLIGHT_TUNING.cruiseSpeed,
      FLIGHT_TUNING.maxSpeed,
    );
    const distanceTarget = tuning.distance + tuning.speedPullBack * speedT;
    const fovTarget = chaseFovTarget(this.baseFov, speedT, boosting, tuning, this.reduceMotion);
    // Mild bank lean only while upright. Inverted soft-up is already horizon-flipped; adding
    // leftY roll there made the camera tip with the dragon (unlike upright). Q/E dodge: none.
    const rollTarget =
      this.reduceMotion || dodging || invertBlend > 0.35
        ? 0
        : cameraRollTarget(leftY, tuning) * (1 - invertBlend);
    const boostTarget = boosting ? 1 : 0;

    const jumpX = px - this.lastTarget.x;
    const jumpY = py - this.lastTarget.y;
    const jumpZ = pz - this.lastTarget.z;
    const snap =
      this.snapPending ||
      !this.initialised ||
      !(
        jumpX * jumpX + jumpY * jumpY + jumpZ * jumpZ <=
        tuning.snapDistance * tuning.snapDistance
      ) ||
      !this.isStateFinite();

    const heading = this.heading;
    const soft = this.softUp;
    if (snap) {
      heading.set(fx, fy, fz);
      this.headingVelocity.set(0, 0, 0);
      this.inverted = !dodging && aligned < 0;
      soft.set(wantX, wantY, wantZ);
      this.distance = distanceTarget;
      this.fov = fovTarget;
      this.roll = rollTarget;
      this.boost = boostTarget;
      this.aimX = this.aimTargetX;
      this.aimY = this.aimTargetY;
      this.pull = 1;
    } else {
      this.springHeading(fx, fy, fz, dt);
      const softStep = dampFactor(tuning.softUpRate, dt);
      soft.x += (wantX - soft.x) * softStep;
      soft.y += (wantY - soft.y) * softStep;
      soft.z += (wantZ - soft.z) * softStep;
      const softLen = soft.length();
      if (softLen > TINY) soft.multiplyScalar(1 / softLen);
      else soft.set(0, 1, 0);
      this.distance += (distanceTarget - this.distance) * dampFactor(tuning.distanceRate, dt);
      this.fov += (fovTarget - this.fov) * dampFactor(tuning.fovRate, dt);
      this.roll += (rollTarget - this.roll) * dampFactor(tuning.rollRate, dt);
      this.boost += (boostTarget - this.boost) * dampFactor(tuning.boostRate, dt);
      const aimStep = dampFactor(tuning.aimRate, dt);
      this.aimX += (this.aimTargetX - this.aimX) * aimStep;
      this.aimY += (this.aimTargetY - this.aimY) * aimStep;
    }
    this.fov = clamp(this.fov, MIN_BASE_FOV, MAX_CAMERA_FOV);

    // Where the camera wants to be: behind the smoothed heading, lifted along soft up
    // (world up when upright, dragon local up when inverted).
    const camWantX = px - heading.x * this.distance + soft.x * tuning.height;
    const camWantY = py - heading.y * this.distance + soft.y * tuning.height;
    const camWantZ = pz - heading.z * this.distance + soft.z * tuning.height;
    if (snap) {
      this.springPosition.set(camWantX, camWantY, camWantZ);
      this.springVelocity.set(vx, vy, vz);
    } else {
      this.springFollow(camWantX, camWantY, camWantZ, vx, vy, vz, dt);
    }

    // Camera-space right and up: right = heading x softUp (handles inverted flight).
    // If softUp is nearly parallel to the heading (loop apex), fall back to world up for the
    // basis so lookAt does not whip.
    let basisUpX = soft.x;
    let basisUpY = soft.y;
    let basisUpZ = soft.z;
    if (Math.abs(heading.x * basisUpX + heading.y * basisUpY + heading.z * basisUpZ) > 0.95) {
      basisUpX = 0;
      basisUpY = 1;
      basisUpZ = 0;
    }
    const right = this.right.set(
      heading.y * basisUpZ - heading.z * basisUpY,
      heading.z * basisUpX - heading.x * basisUpZ,
      heading.x * basisUpY - heading.y * basisUpX,
    );
    if (right.lengthSq() > TINY) right.normalize();
    else right.set(-1, 0, 0);
    const camUp = this.camUp.crossVectors(right, heading);
    if (camUp.lengthSq() > TINY) camUp.normalize();
    else camUp.set(basisUpX, basisUpY, basisUpZ);

    const lead = clamp01(tuning.lookLead);
    const aimX = this.aimX * tuning.aimShift;
    const aimY = this.aimY * tuning.aimShift;
    this.look.set(
      px +
        (heading.x + (fx - heading.x) * lead) * tuning.lookAhead +
        right.x * aimX +
        camUp.x * aimY +
        soft.x * tuning.lookHeight,
      py +
        (heading.y + (fy - heading.y) * lead) * tuning.lookAhead +
        right.y * aimX +
        camUp.y * aimY +
        soft.y * tuning.lookHeight,
      pz +
        (heading.z + (fz - heading.z) * lead) * tuning.lookAhead +
        right.z * aimX +
        camUp.z * aimY +
        soft.z * tuning.lookHeight,
    );

    // Boost shake, on the camera's own clock so it is the same wave at any frame rate.
    this.shakeTime += dt;
    let outX = this.springPosition.x;
    let outY = this.springPosition.y;
    let outZ = this.springPosition.z;
    const shakeScale = this.shakeScale > 0 ? (this.shakeScale < 1 ? this.shakeScale : 1) : 0;
    if (!this.reduceMotion && this.boost > 0.001 && tuning.shakeAmplitude * shakeScale > 0) {
      const amplitude = tuning.shakeAmplitude * shakeScale * this.boost;
      const shakeX = amplitude * shakeWave(this.shakeTime, tuning.shakeFrequency, 0);
      const shakeY = amplitude * shakeWave(this.shakeTime, tuning.shakeFrequency * 1.17, 2.4);
      outX += right.x * shakeX + camUp.x * shakeY;
      outY += right.y * shakeX + camUp.y * shakeY;
      outZ += right.z * shakeX + camUp.z * shakeY;
    }

    // Floor first, so the terrain ray below covers the path to where the camera really goes.
    // The spring state is left alone: the camera rejoins its free path without a jump.
    if (outY < this.minY) outY = this.minY;

    // Terrain: one ray from the dragon to where the camera is about to be.
    const rayX = outX - px;
    const rayY = outY - py;
    const rayZ = outZ - pz;
    const rayLength = Math.sqrt(rayX * rayX + rayY * rayY + rayZ * rayZ);
    let hit = -1;
    if (this.terrain !== null && rayLength > TINY) {
      hit = this.terrain.raycast(
        px,
        py,
        pz,
        rayX / rayLength,
        rayY / rayLength,
        rayZ / rayLength,
        rayLength + Math.max(0, tuning.collisionMargin),
      );
    }
    this.pull = resolveCameraPull(
      this.pull,
      hit,
      rayLength,
      tuning.collisionMargin,
      tuning.collisionEaseOutRate,
      dt,
    );
    outX = px + rayX * this.pull;
    outY = py + rayY * this.pull;
    outZ = pz + rayZ * this.pull;

    if (!Number.isFinite(outX + outY + outZ + this.fov + this.roll)) {
      this.snapPending = true;
      return false;
    }

    this.position.set(outX, outY, outZ);
    // Prefer the eased soft up; if it is parallel to the view, lookAt with world up.
    const viewX = this.look.x - outX;
    const viewY = this.look.y - outY;
    const viewZ = this.look.z - outZ;
    const viewLen = Math.sqrt(viewX * viewX + viewY * viewY + viewZ * viewZ);
    let lookUpX = soft.x;
    let lookUpY = soft.y;
    let lookUpZ = soft.z;
    if (
      viewLen > TINY &&
      Math.abs((viewX * lookUpX + viewY * lookUpY + viewZ * lookUpZ) / viewLen) > 0.95
    ) {
      lookUpX = 0;
      lookUpY = 1;
      lookUpZ = 0;
    }
    this.camUp.set(lookUpX, lookUpY, lookUpZ);
    this.matrix.lookAt(this.position, this.look, this.camUp);
    this.quaternion.setFromRotationMatrix(this.matrix);
    if (this.roll !== 0) {
      // The camera looks down -Z: "right wing down" is a negative turn about its own +Z.
      const half = -this.roll * 0.5;
      this.quaternion.multiply(this.rollQuat.set(0, 0, Math.sin(half), Math.cos(half)));
    }

    this.lastTarget.set(px, py, pz);
    this.initialised = true;
    this.snapPending = false;
    return true;
  }

  private isStateFinite(): boolean {
    const h = this.heading;
    const hv = this.headingVelocity;
    const p = this.springPosition;
    const pv = this.springVelocity;
    return Number.isFinite(
      h.x +
        h.y +
        h.z +
        hv.x +
        hv.y +
        hv.z +
        p.x +
        p.y +
        p.z +
        pv.x +
        pv.y +
        pv.z +
        this.distance +
        this.fov +
        this.roll +
        this.boost +
        this.aimX +
        this.aimY +
        this.pull,
    );
  }

  /** Critically damped spring of the unit heading toward (fx, fy, fz), then renormalised. */
  private springHeading(fx: number, fy: number, fz: number, dt: number): void {
    const omega = this.tuning.headingRate;
    const heading = this.heading;
    const velocity = this.headingVelocity;
    const axis = this.axis;

    axis.value = heading.x;
    axis.velocity = velocity.x;
    stepCriticalSpring(axis, fx, omega, dt);
    heading.x = axis.value;
    velocity.x = axis.velocity;

    axis.value = heading.y;
    axis.velocity = velocity.y;
    stepCriticalSpring(axis, fy, omega, dt);
    heading.y = axis.value;
    velocity.y = axis.velocity;

    axis.value = heading.z;
    axis.velocity = velocity.z;
    stepCriticalSpring(axis, fz, omega, dt);
    heading.z = axis.value;
    velocity.z = axis.velocity;

    const length = heading.length();
    if (length > 0.05) {
      heading.multiplyScalar(1 / length);
    } else {
      // The dragon reversed (terrain bounce) and the blend passed through zero: cut to it.
      heading.set(fx, fy, fz);
      velocity.set(0, 0, 0);
    }
  }

  /**
   * Critically damped follow toward (wantX, wantY, wantZ), solved in the frame moving with the
   * target velocity (vx, vy, vz): a target in steady motion is followed with no lag.
   */
  private springFollow(
    wantX: number,
    wantY: number,
    wantZ: number,
    vx: number,
    vy: number,
    vz: number,
    dt: number,
  ): void {
    const omega = this.tuning.positionRate;
    const position = this.springPosition;
    const velocity = this.springVelocity;
    const axis = this.axis;

    // Error against where the wanted point was `dt` ago if it moved at the target velocity.
    axis.value = position.x - (wantX - vx * dt);
    axis.velocity = velocity.x - vx;
    stepCriticalSpring(axis, 0, omega, dt);
    let ex = axis.value;
    velocity.x = vx + axis.velocity;

    axis.value = position.y - (wantY - vy * dt);
    axis.velocity = velocity.y - vy;
    stepCriticalSpring(axis, 0, omega, dt);
    let ey = axis.value;
    velocity.y = vy + axis.velocity;

    axis.value = position.z - (wantZ - vz * dt);
    axis.velocity = velocity.z - vz;
    stepCriticalSpring(axis, 0, omega, dt);
    let ez = axis.value;
    velocity.z = vz + axis.velocity;

    const maxLag = this.tuning.maxLag > 0 ? this.tuning.maxLag : 0;
    const lagSq = ex * ex + ey * ey + ez * ez;
    if (lagSq > maxLag * maxLag) {
      const scale = maxLag / Math.sqrt(lagSq);
      ex *= scale;
      ey *= scale;
      ez *= scale;
    }
    position.set(wantX + ex, wantY + ey, wantZ + ez);
  }
}

// --- The view module -------------------------------------------------------------------------------

export interface CameraRigOptions extends ChaseCameraOptions {
  /** Use an existing camera. Default: a new one (near 0.5 m, far 6000 m). */
  camera?: PerspectiveCamera;
}

export interface CameraRig {
  readonly camera: PerspectiveCamera;
  /** The maths and its state; `chase.tuning` is the live tuning table. */
  readonly chase: ChaseCamera;
  /**
   * Once per rendered frame, after the WorldView is built: follows `view.localDragonId`. With
   * no local dragon in the view the camera keeps its pose. `dtS` is the frame time in seconds.
   */
  update(view: WorldView, dtS: number): void;
  /** Same, for an explicit target (spectating a team mate, the death cam's subject). */
  follow(target: ChaseTarget, dtS: number): void;
  /** Steering input for the look-ahead: pass the latest InputFrame's steerX/steerY. */
  setAim(steerX: number, steerY: number): void;
  /** Canvas width / height. */
  setAspect(aspect: number): void;
  /** Settings menu: vertical FOV in degrees at cruise speed. */
  setBaseFov(fovDeg: number): void;
  setReduceMotion(reduceMotion: boolean): void;
  /** Settings menu: 0..1 multiplier on the shake amplitude (0 = none). */
  setShakeScale(scale: number): void;
  /** Terrain for the pull-in; null (open sky) turns it off. */
  setTerrain(terrain: CameraTerrainRaycaster | null): void;
  /** Place the camera directly on the next update instead of easing (spawn, scene cut). */
  snap(): void;
  /** Nothing to free (no GPU resources); present for the view-module convention. */
  dispose(): void;
}

const DEFAULT_NEAR = 0.5;
const DEFAULT_FAR = 6000;

export function createCameraRig(options: CameraRigOptions = {}): CameraRig {
  const chase = new ChaseCamera(options);
  const camera = options.camera ?? new PerspectiveCamera(chase.fov, 1, DEFAULT_NEAR, DEFAULT_FAR);
  if (camera.fov !== chase.fov) {
    camera.fov = chase.fov;
    camera.updateProjectionMatrix();
  }

  function follow(target: ChaseTarget, dtS: number): void {
    if (!chase.update(target, dtS)) return;
    camera.position.copy(chase.position);
    camera.quaternion.copy(chase.quaternion);
    if (Math.abs(chase.fov - camera.fov) > FOV_EPSILON) {
      camera.fov = chase.fov;
      camera.updateProjectionMatrix();
    }
  }

  return {
    camera,
    chase,
    update(view: WorldView, dtS: number): void {
      const dragon = findDragonView(view, view.localDragonId);
      if (dragon !== undefined) follow(dragon, dtS);
    },
    follow,
    setAim(steerX: number, steerY: number): void {
      chase.setAim(steerX, steerY);
    },
    setAspect(aspect: number): void {
      if (!(aspect > 0) || !Number.isFinite(aspect) || aspect === camera.aspect) return;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
    setBaseFov(fovDeg: number): void {
      chase.setBaseFov(fovDeg);
    },
    setReduceMotion(reduceMotion: boolean): void {
      chase.reduceMotion = reduceMotion;
    },
    setShakeScale(scale: number): void {
      chase.shakeScale = Number.isFinite(scale) ? scale : 1;
    },
    setTerrain(terrain: CameraTerrainRaycaster | null): void {
      chase.terrain = terrain;
    },
    snap(): void {
      chase.snap();
    },
    dispose(): void {
      chase.terrain = null;
    },
  };
}
