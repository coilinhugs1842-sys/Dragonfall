import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  CAMERA_RIG_TUNING,
  ChaseCamera,
  DEFAULT_BASE_FOV,
  MAX_BASE_FOV,
  MAX_CAMERA_FOV,
  MIN_BASE_FOV,
  cameraRollTarget,
  chaseFovTarget,
  clampBaseFov,
  createCameraRig,
  dampFactor,
  resolveCameraPull,
  shakeWave,
  speedFactor,
  stepCriticalSpring,
} from '../../src/render/camera-rig';
import type { CameraTerrainRaycaster, ChaseTarget } from '../../src/render/camera-rig';
import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_DODGING,
  FLIGHT_TUNING,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';

interface Pose extends ChaseTarget {
  position: Vector3;
  orientation: Quaternion;
  velocity: Vector3;
  flags: number;
}

const EULER = new Euler();

function createPose(): Pose {
  return {
    position: new Vector3(),
    orientation: new Quaternion(),
    velocity: new Vector3(),
    flags: DRAGON_FLAG_ALIVE,
  };
}

/** The sim's convention: yaw about +Y (0 = +Z), pitch + = nose up, roll + = right wing down. */
function setHeading(pose: Pose, yaw: number, pitch: number, roll: number): void {
  pose.orientation.setFromEuler(EULER.set(-pitch, yaw, roll, 'YXZ'));
}

/** Level flight along +Z at `speed`, at point (0, 300, z). */
function straightPose(pose: Pose, z: number, speed: number): Pose {
  pose.position.set(0, 300, z);
  setHeading(pose, 0, 0, 0);
  pose.velocity.set(0, 0, speed);
  return pose;
}

/**
 * A lively but analytic flight: a banked turn whose rate, climb and speed all vary, with boost
 * on for the middle second. Position is integrated in closed form per call so both frame rates
 * see exactly the same path.
 */
function manoeuvrePose(pose: Pose, t: number): Pose {
  const yaw = 0.9 * Math.sin(t * 1.3);
  const pitch = 0.35 * Math.sin(t * 0.9 + 0.4);
  const speed = 55 + 20 * Math.sin(t * 0.7);
  // A smooth path that is consistent with the heading only roughly; the camera does not care.
  pose.position.set(
    40 * Math.sin(t * 0.8),
    300 + 15 * Math.sin(t * 1.1),
    60 * t + 10 * Math.cos(t),
  );
  setHeading(pose, yaw, pitch, -0.8 * Math.cos(t * 1.3));
  pose.velocity.set(
    Math.sin(yaw) * Math.cos(pitch) * speed,
    Math.sin(pitch) * speed,
    Math.cos(yaw) * Math.cos(pitch) * speed,
  );
  pose.flags = DRAGON_FLAG_ALIVE | (t > 0.5 && t < 1.5 ? DRAGON_FLAG_BOOSTING : 0);
  return pose;
}

function runManoeuvre(fps: number, seconds: number, camera = new ChaseCamera()): ChaseCamera {
  const pose = createPose();
  const frames = Math.round(fps * seconds);
  camera.update(manoeuvrePose(pose, 0), 0);
  for (let i = 1; i <= frames; i++) {
    camera.setAim(Math.sin(i / fps), 0.3);
    camera.update(manoeuvrePose(pose, i / fps), 1 / fps);
  }
  return camera;
}

describe('pure maths', () => {
  it('dampFactor composes over sub-steps', () => {
    const whole = 1 - dampFactor(3, 0.1);
    const halves = (1 - dampFactor(3, 0.05)) ** 2;
    expect(halves).toBeCloseTo(whole, 12);
    expect(dampFactor(0, 1)).toBe(0);
    expect(dampFactor(3, NaN)).toBe(0);
    expect(dampFactor(3, 1e9)).toBe(1);
  });

  it('the critical spring is step-size independent and never overshoots', () => {
    const one = { value: 0, velocity: 0 };
    stepCriticalSpring(one, 10, 8, 0.5);
    const many = { value: 0, velocity: 0 };
    for (let i = 0; i < 50; i++) stepCriticalSpring(many, 10, 8, 0.01);
    expect(many.value).toBeCloseTo(one.value, 9);
    expect(many.velocity).toBeCloseTo(one.velocity, 9);

    const axis = { value: 0, velocity: 0 };
    let last = 0;
    for (let i = 0; i < 600; i++) {
      stepCriticalSpring(axis, 10, 8, 1 / 144);
      expect(axis.value).toBeGreaterThanOrEqual(last);
      expect(axis.value).toBeLessThanOrEqual(10);
      last = axis.value;
    }
    expect(axis.value).toBeCloseTo(10, 6);
  });

  it('speedFactor is 0 at cruise, 1 at top speed, monotonic', () => {
    expect(speedFactor(0, 45, 95)).toBe(0);
    expect(speedFactor(45, 45, 95)).toBe(0);
    expect(speedFactor(95, 45, 95)).toBe(1);
    expect(speedFactor(500, 45, 95)).toBe(1);
    expect(speedFactor(70, 45, 45)).toBe(0);
    expect(speedFactor(NaN, 45, 95)).toBe(0);
    let last = 0;
    for (let s = 45; s <= 95; s++) {
      const f = speedFactor(s, 45, 95);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });

  it('FOV target stays within [base, MAX_CAMERA_FOV] for any input', () => {
    const tuning = { ...CAMERA_RIG_TUNING };
    for (const base of [-50, 0, MIN_BASE_FOV, 62, MAX_BASE_FOV, 400, NaN]) {
      for (const speedT of [-1, 0, 0.5, 1, 7, NaN]) {
        for (const boosting of [false, true]) {
          for (const reduce of [false, true]) {
            const fov = chaseFovTarget(base, speedT, boosting, tuning, reduce);
            expect(fov).toBeGreaterThanOrEqual(clampBaseFov(base));
            expect(fov).toBeLessThanOrEqual(MAX_CAMERA_FOV);
          }
        }
      }
    }
    expect(chaseFovTarget(62, 0, false, tuning, false)).toBe(62);
    expect(chaseFovTarget(62, 1, true, tuning, false)).toBe(
      62 + tuning.fovSpeedKick + tuning.fovBoostKick,
    );
    expect(chaseFovTarget(62, 1, true, tuning, true)).toBeLessThan(
      chaseFovTarget(62, 1, true, tuning, false),
    );
    tuning.fovSpeedKick = 900;
    expect(chaseFovTarget(62, 1, false, tuning, false)).toBe(MAX_CAMERA_FOV);
    tuning.fovSpeedKick = -900;
    expect(chaseFovTarget(62, 1, false, tuning, false)).toBe(62);
  });

  it('clampBaseFov', () => {
    expect(clampBaseFov(10)).toBe(MIN_BASE_FOV);
    expect(clampBaseFov(500)).toBe(MAX_BASE_FOV);
    expect(clampBaseFov(NaN)).toBe(DEFAULT_BASE_FOV);
    expect(clampBaseFov(70)).toBe(70);
  });

  it('roll target follows the bank, capped', () => {
    const tuning = CAMERA_RIG_TUNING;
    expect(cameraRollTarget(0, tuning)).toBe(0);
    expect(cameraRollTarget(Math.sin(0.5), tuning)).toBeCloseTo(0.5 * tuning.rollFraction, 12);
    expect(cameraRollTarget(1, tuning)).toBeLessThanOrEqual(tuning.maxRoll);
    expect(cameraRollTarget(-1, tuning)).toBeGreaterThanOrEqual(-tuning.maxRoll);
    expect(cameraRollTarget(NaN, tuning)).toBe(0);
  });

  it('the shake wave is bounded and repeatable', () => {
    for (let t = 0; t < 5; t += 0.013) {
      const w = shakeWave(t, 13, 0.7);
      expect(Math.abs(w)).toBeLessThanOrEqual(1);
      expect(shakeWave(t, 13, 0.7)).toBe(w);
    }
  });
});

describe('resolveCameraPull', () => {
  it('pulls in at once, never beyond the hit', () => {
    for (const length of [0.5, 5, 13.4, 40]) {
      for (const hit of [0, 0.01, 0.5, 1, 4, 13.3, length]) {
        for (const pull of [0, 0.3, 1, 5, NaN]) {
          const next = resolveCameraPull(pull, hit, length, 0.8, 1.5, 1 / 60);
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThanOrEqual(1);
          expect(next * length).toBeLessThanOrEqual(hit + 1e-12);
        }
      }
    }
    expect(resolveCameraPull(1, 5, 10, 1, 1.5, 0.016)).toBeCloseTo(0.4, 12);
  });

  it('keeps the margin when there is room for it', () => {
    expect(resolveCameraPull(1, 6, 12, 0.8, 1.5, 0.016) * 12).toBeCloseTo(5.2, 12);
    // Closer than two margins: half way to the hit.
    expect(resolveCameraPull(1, 1, 12, 0.8, 1.5, 0.016) * 12).toBeCloseTo(0.5, 12);
  });

  it('eases out slowly when the way is clear, at any frame rate', () => {
    let at30 = 0.3;
    for (let i = 0; i < 30; i++) at30 = resolveCameraPull(at30, -1, 12, 0.8, 1.5, 1 / 30);
    let at144 = 0.3;
    for (let i = 0; i < 144; i++) at144 = resolveCameraPull(at144, -1, 12, 0.8, 1.5, 1 / 144);
    expect(at30).toBeCloseTo(at144, 9);
    expect(at30).toBeGreaterThan(0.3);
    expect(at30).toBeLessThan(0.9);
    expect(resolveCameraPull(0.3, -1, 12, 0.8, 1.5, 1 / 60)).toBeLessThan(0.33);
  });

  it('treats NaN and a far hit as allowed', () => {
    expect(resolveCameraPull(1, NaN, 12, 0.8, 1.5, 0.016)).toBe(1);
    expect(resolveCameraPull(1, 30, 12, 0.8, 1.5, 0.016)).toBe(1);
    expect(resolveCameraPull(1, -1, 12, 0.8, 1.5, 0.016)).toBe(1);
  });
});

describe('ChaseCamera', () => {
  it('sits behind and above with zero lag in steady flight', () => {
    const camera = new ChaseCamera();
    const pose = createPose();
    const speed = FLIGHT_TUNING.cruiseSpeed;
    for (let i = 0; i <= 120; i++)
      camera.update(straightPose(pose, (i / 60) * speed, speed), 1 / 60);
    const t = CAMERA_RIG_TUNING;
    expect(camera.position.x).toBeCloseTo(0, 6);
    expect(camera.position.y).toBeCloseTo(300 + t.height, 6);
    expect(camera.position.z).toBeCloseTo(pose.position.z - t.distance, 6);
    expect(camera.fov).toBeCloseTo(DEFAULT_BASE_FOV, 6);
    // Looks forward (+Z) and slightly down at the point ahead of the dragon.
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(forward.z).toBeGreaterThan(0.99);
    expect(forward.y).toBeLessThan(0);
    expect(forward.x).toBeCloseTo(0, 6);
  });

  it('follows the same path at 30 fps and 144 fps', () => {
    const slow = runManoeuvre(30, 2);
    const fast = runManoeuvre(144, 2);
    expect(slow.position.distanceTo(fast.position)).toBeLessThan(0.25);
    expect(slow.quaternion.angleTo(fast.quaternion)).toBeLessThan(0.02);
    expect(Math.abs(slow.fov - fast.fov)).toBeLessThan(0.15);

    const mid = runManoeuvre(60, 2);
    expect(mid.position.distanceTo(fast.position)).toBeLessThan(0.12);
  });

  it('keeps the FOV within bounds through a boost and eases it', () => {
    const camera = new ChaseCamera({ baseFovDeg: 70 });
    const pose = createPose();
    camera.update(straightPose(pose, 0, 45), 0);
    expect(camera.fov).toBe(70);
    let last = camera.fov;
    let z = 0;
    for (let i = 0; i < 300; i++) {
      z += 95 / 60;
      straightPose(pose, z, 95).flags = DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING;
      camera.update(pose, 1 / 60);
      expect(camera.fov).toBeGreaterThanOrEqual(last - 1e-9);
      expect(camera.fov - last).toBeLessThan(1.5);
      expect(camera.fov).toBeLessThanOrEqual(MAX_CAMERA_FOV);
      last = camera.fov;
    }
    const top = 70 + CAMERA_RIG_TUNING.fovSpeedKick + CAMERA_RIG_TUNING.fovBoostKick;
    expect(camera.fov).toBeCloseTo(top, 2);

    camera.setBaseFov(1000);
    expect(camera.baseFovDeg).toBe(MAX_BASE_FOV);
    for (let i = 0; i < 600; i++) {
      z += 95 / 60;
      straightPose(pose, z, 95).flags = DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING;
      camera.update(pose, 1 / 60);
      expect(camera.fov).toBeLessThanOrEqual(MAX_CAMERA_FOV);
    }
  });

  it('snaps when the target teleports', () => {
    const camera = runManoeuvre(60, 1);
    const pose = createPose();
    pose.position.set(-700, 320, 500);
    setHeading(pose, 2.1, 0.2, 0);
    pose.velocity.set(0, 0, 0);
    expect(camera.update(pose, 1 / 60)).toBe(true);
    const t = CAMERA_RIG_TUNING;
    const forward = new Vector3(0, 0, 1).applyQuaternion(pose.orientation);
    // Soft-up is the bank-free horizon for this heading (not always world +Y).
    const soft = new Vector3(0, 1, 0).addScaledVector(forward, -forward.y);
    if (soft.lengthSq() > 1e-8) soft.normalize();
    else soft.set(0, 1, 0);
    const expected = pose.position
      .clone()
      .addScaledVector(forward, -t.distance)
      .addScaledVector(soft, t.height);
    expect(camera.position.distanceTo(expected)).toBeLessThan(1e-6);
    expect(camera.fov).toBe(DEFAULT_BASE_FOV);
  });

  it('eases (does not snap) for ordinary movement and snaps on request', () => {
    const camera = new ChaseCamera();
    const pose = createPose();
    camera.update(straightPose(pose, 0, 45), 0);
    setHeading(pose, 1.2, 0, 0);
    pose.position.z = 1.5;
    camera.update(pose, 1 / 60);
    // Still nearly behind the OLD heading: the heading spring lags.
    expect(camera.position.z).toBeLessThan(pose.position.z - CAMERA_RIG_TUNING.distance * 0.9);

    camera.snap();
    camera.update(pose, 1 / 60);
    const forward = new Vector3(0, 0, 1).applyQuaternion(pose.orientation);
    expect(camera.position.x).toBeCloseTo(-forward.x * CAMERA_RIG_TUNING.distance, 6);
  });

  it('clamps a dt spike', () => {
    const spike = new ChaseCamera();
    const clamped = new ChaseCamera();
    const pose = createPose();
    spike.update(manoeuvrePose(pose, 0), 0);
    clamped.update(manoeuvrePose(pose, 0), 0);
    manoeuvrePose(pose, 0.1);
    spike.update(pose, 30);
    clamped.update(pose, CAMERA_RIG_TUNING.maxDt);
    expect(spike.position.distanceTo(clamped.position)).toBe(0);
    expect(spike.fov).toBe(clamped.fov);
  });

  it('ignores a non-finite pose and survives bad dt and velocity', () => {
    const camera = runManoeuvre(60, 0.5);
    const before = camera.position.clone();
    const beforeFov = camera.fov;
    const bad = createPose();
    bad.position.set(NaN, 0, 0);
    expect(camera.update(bad, 1 / 60)).toBe(false);
    bad.position.set(0, 0, 0);
    bad.orientation.set(0, 0, 0, 0);
    expect(camera.update(bad, 1 / 60)).toBe(false);
    bad.orientation.set(NaN, 0, 0, 1);
    expect(camera.update(bad, 1 / 60)).toBe(false);
    expect(camera.position.equals(before)).toBe(true);
    expect(camera.fov).toBe(beforeFov);

    const pose = manoeuvrePose(createPose(), 0.5);
    pose.velocity.set(NaN, Infinity, 0);
    for (const dt of [NaN, -1, Infinity, 0]) {
      expect(camera.update(pose, dt)).toBe(true);
      expect(Number.isFinite(camera.position.x + camera.position.y + camera.position.z)).toBe(true);
      expect(Number.isFinite(camera.quaternion.x + camera.quaternion.w + camera.fov)).toBe(true);
    }
  });

  it('accepts a non-unit orientation', () => {
    const a = new ChaseCamera();
    const b = new ChaseCamera();
    const pose = manoeuvrePose(createPose(), 0.7);
    a.update(pose, 0);
    pose.orientation.set(
      pose.orientation.x * 3,
      pose.orientation.y * 3,
      pose.orientation.z * 3,
      pose.orientation.w * 3,
    );
    b.update(pose, 0);
    expect(a.position.distanceTo(b.position)).toBeLessThan(1e-9);
  });

  it('rolls with the dragon, by a fraction, and lags', () => {
    const camera = new ChaseCamera();
    const pose = createPose();
    camera.update(straightPose(pose, 0, 45), 0);
    const bank = 0.9;
    let z = 0;
    const rightY = (): number => new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).y;
    z += 0.75;
    straightPose(pose, z, 45);
    setHeading(pose, 0, 0, bank);
    camera.update(pose, 1 / 60);
    const first = rightY();
    // Right wing down -> the camera's right side dips, but only a little after one frame.
    expect(first).toBeLessThan(0);
    expect(first).toBeGreaterThan(-0.05);
    for (let i = 0; i < 300; i++) {
      z += 0.75;
      straightPose(pose, z, 45);
      setHeading(pose, 0, 0, bank);
      camera.update(pose, 1 / 60);
    }
    expect(Math.asin(-rightY())).toBeCloseTo(bank * CAMERA_RIG_TUNING.rollFraction, 2);
  });

  it('stays continuous through a dodge spin', () => {
    const camera = new ChaseCamera();
    const pose = createPose();
    camera.update(straightPose(pose, 0, 45), 0);
    const previous = camera.quaternion.clone();
    for (let i = 1; i <= 60; i++) {
      straightPose(pose, i * 0.75, 45);
      setHeading(pose, 0, 0, (Math.min(i, 30) / 30) * Math.PI * 2);
      // Soft-up ignores local up while dodging so a 180° roll does not flip the horizon.
      pose.flags = DRAGON_FLAG_ALIVE | DRAGON_FLAG_DODGING;
      camera.update(pose, 1 / 60);
      expect(camera.quaternion.angleTo(previous)).toBeLessThan(0.03);
      previous.copy(camera.quaternion);
    }
  });

  it('eases through an inverted-to-upright loop without whipping', () => {
    const camera = new ChaseCamera();
    const pose = createPose();
    camera.update(straightPose(pose, 0, 45), 0);
    const previous = camera.quaternion.clone();
    for (let i = 1; i <= 120; i++) {
      const pitch = (i / 120) * Math.PI * 2;
      straightPose(pose, i * 0.75, 45);
      setHeading(pose, 0, pitch, 0);
      pose.flags = DRAGON_FLAG_ALIVE;
      camera.update(pose, 1 / 60);
      expect(camera.quaternion.angleTo(previous), `frame ${i}`).toBeLessThan(0.2);
      previous.copy(camera.quaternion);
    }
  });

  it('does not tip with bank while inverted (horizon stays bank-free)', () => {
    const camera = new ChaseCamera();
    const pose = createPose();
    // Settle inverted and level.
    for (let i = 0; i < 90; i++) {
      straightPose(pose, i * 0.75, 45);
      setHeading(pose, 0, Math.PI, 0);
      pose.flags = DRAGON_FLAG_ALIVE;
      camera.update(pose, 1 / 60);
    }
    const level = camera.quaternion.clone();
    // Hard bank while still inverted: camera should barely move (unlike following local up).
    for (let i = 0; i < 90; i++) {
      straightPose(pose, (90 + i) * 0.75, 45);
      setHeading(pose, 0, Math.PI, 0.9);
      pose.flags = DRAGON_FLAG_ALIVE;
      camera.update(pose, 1 / 60);
    }
    expect(camera.quaternion.angleTo(level)).toBeLessThan(0.08);
  });

  it('does not flip soft-up during hard upright banks (no turn spasm)', () => {
    const camera = new ChaseCamera();
    const pose = createPose();
    camera.update(straightPose(pose, 0, 45), 0);
    const previous = camera.quaternion.clone();
    for (let i = 1; i <= 120; i++) {
      const yaw = (i / 120) * Math.PI * 2;
      const bank = Math.sin(i / 8) * 1.1;
      straightPose(pose, i * 0.75, 45);
      setHeading(pose, yaw, 0.15 * Math.sin(i / 11), bank);
      pose.flags = DRAGON_FLAG_ALIVE;
      camera.update(pose, 1 / 60);
      expect(camera.quaternion.angleTo(previous), `frame ${i}`).toBeLessThan(0.12);
      previous.copy(camera.quaternion);
    }
  });

  it('reduce motion: no roll and no shake', () => {
    const steady = new ChaseCamera({ reduceMotion: true });
    const shaky = new ChaseCamera();
    const pose = createPose();
    let moved = 0;
    for (let i = 0; i <= 120; i++) {
      straightPose(pose, (i / 60) * 45, 45);
      setHeading(pose, 0, 0, 0.9);
      pose.flags = DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING;
      steady.update(pose, 1 / 60);
      shaky.update(pose, 1 / 60);
      expect(steady.position.x).toBeCloseTo(0, 9);
      expect(steady.position.y).toBeCloseTo(300 + CAMERA_RIG_TUNING.height, 9);
      moved = Math.max(moved, Math.abs(shaky.position.x));
      expect(Math.abs(shaky.position.x)).toBeLessThanOrEqual(CAMERA_RIG_TUNING.shakeAmplitude);
    }
    expect(moved).toBeGreaterThan(0.005);
    expect(new Vector3(1, 0, 0).applyQuaternion(steady.quaternion).y).toBeCloseTo(0, 9);
  });

  it('never ends up beyond a terrain hit, and eases back out', () => {
    let hitDistance = -1;
    let calls = 0;
    const origin = new Vector3();
    const direction = new Vector3();
    const terrain: CameraTerrainRaycaster = {
      raycast(ox, oy, oz, dx, dy, dz, maxDist) {
        calls++;
        origin.set(ox, oy, oz);
        direction.set(dx, dy, dz);
        return hitDistance >= 0 && hitDistance <= maxDist ? hitDistance : -1;
      },
    };
    const camera = new ChaseCamera({ terrain });
    const pose = createPose();
    camera.update(manoeuvrePose(pose, 0), 0);
    const free = camera.position.distanceTo(pose.position);
    expect(free).toBeGreaterThan(CAMERA_RIG_TUNING.distance);

    // A pseudo-random wall that comes and goes.
    let seed = 12345;
    for (let i = 1; i <= 600; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const roll = seed / 0x7fffffff;
      hitDistance = roll < 0.4 ? -1 : roll * 16;
      const before = calls;
      camera.update(manoeuvrePose(pose, i / 60), 1 / 60);
      expect(calls - before).toBe(1);
      expect(origin.distanceTo(pose.position)).toBe(0);
      expect(direction.length()).toBeCloseTo(1, 9);
      const distance = camera.position.distanceTo(pose.position);
      if (hitDistance >= 0 && hitDistance <= free + 5) {
        expect(distance).toBeLessThanOrEqual(hitDistance + 1e-9);
      }
      // The camera stays on the ray it tested.
      const along = camera.position.clone().sub(pose.position).normalize();
      expect(along.dot(direction)).toBeGreaterThan(0.999999);
    }

    // Wall at 4 m, then clear: in at once, out slowly.
    hitDistance = 4;
    camera.update(manoeuvrePose(pose, 10), 1 / 60);
    const pulled = camera.position.distanceTo(pose.position);
    expect(pulled).toBeLessThan(4);
    hitDistance = -1;
    camera.update(manoeuvrePose(pose, 10 + 1 / 60), 1 / 60);
    const next = camera.position.distanceTo(pose.position);
    expect(next).toBeGreaterThan(pulled);
    expect(next).toBeLessThan(pulled + 1);
    for (let i = 2; i < 600; i++) camera.update(manoeuvrePose(pose, 10 + i / 60), 1 / 60);
    expect(camera.position.distanceTo(pose.position)).toBeGreaterThan(
      CAMERA_RIG_TUNING.distance - 3,
    );
  });

  it('stays above its floor (the cloud sea) in a low climb, a skim and a dip under it', () => {
    const minY = 1.5;
    const speed = FLIGHT_TUNING.cruiseSpeed;
    const origin = new Vector3();
    const reach = new Vector3();
    const terrain: CameraTerrainRaycaster = {
      raycast(ox, oy, oz, dx, dy, dz, maxDist) {
        origin.set(ox, oy, oz);
        reach.set(dx, dy, dz).multiplyScalar(maxDist - CAMERA_RIG_TUNING.collisionMargin);
        return -1;
      },
    };
    const camera = new ChaseCamera({ minY, terrain });
    const free = new ChaseCamera();
    const pose = createPose();
    const fly = (y: number, pitch: number, frames: number): void => {
      for (let i = 0; i < frames; i++) {
        pose.position.set(0, y, pose.position.z + (speed * Math.cos(pitch)) / 60);
        setHeading(pose, 0, pitch, 0);
        pose.velocity.set(0, 0, speed * Math.cos(pitch));
        expect(camera.update(pose, 1 / 60)).toBe(true);
        free.update(pose, 1 / 60);
        expect(camera.position.y).toBeGreaterThanOrEqual(minY);
        // The terrain ray was cast to where the camera ended up, floor included.
        expect(origin.clone().add(reach).distanceTo(camera.position)).toBeLessThan(1e-6);
      }
    };

    // High up the floor changes nothing.
    fly(300, 0, 60);
    expect(camera.position.distanceTo(free.position)).toBe(0);
    // Nose up 60 degrees just over the surface: the free camera would be about 9 m under it.
    fly(4, 1.05, 90);
    expect(free.position.y).toBeLessThan(-5);
    expect(camera.position.y).toBe(minY);
    expect(camera.position.x).toBe(free.position.x);
    expect(camera.position.z).toBe(free.position.z);
    // Skimming half-sunk, then well under the surface: still above it, looking down at the dragon.
    fly(-3, 0, 60);
    expect(camera.position.y).toBe(minY);
    fly(-40, 0, 60);
    expect(camera.position.y).toBe(minY);
    expect(new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).y).toBeLessThan(-0.5);
    // Back up: it rejoins the free path with no jump (the spring state was never clamped).
    fly(-10, 0, 1);
    fly(20, 0, 30);
    expect(camera.position.distanceTo(free.position)).toBe(0);

    // A NaN floor is no floor.
    const broken = new ChaseCamera({ minY: NaN });
    pose.position.set(0, -40, 0);
    setHeading(pose, 0, 0, 0);
    expect(broken.update(pose, 1 / 60)).toBe(true);
    expect(broken.position.y).toBeCloseTo(-40 + CAMERA_RIG_TUNING.height, 6);
  });
});

describe('createCameraRig', () => {
  function viewWithDragon(z: number, speed: number, flags = DRAGON_FLAG_ALIVE) {
    const view = createWorldView();
    beginWorldView(view);
    const dragon = acquireDragonView(view);
    dragon.id = 3;
    dragon.team = 0;
    dragon.classId = 'talon';
    dragon.position.x = 0;
    dragon.position.y = 300;
    dragon.position.z = z;
    dragon.orientation.x = 0;
    dragon.orientation.y = 0;
    dragon.orientation.z = 0;
    dragon.orientation.w = 1;
    dragon.velocity.x = 0;
    dragon.velocity.y = 0;
    dragon.velocity.z = speed;
    dragon.health = 1;
    dragon.stamina = 1;
    dragon.flags = flags;
    dragon.anim = 0;
    view.localDragonId = 3;
    return view;
  }

  it('drives the camera from the local dragon in a WorldView', () => {
    const rig = createCameraRig();
    rig.update(viewWithDragon(100, 45), 1 / 60);
    expect(rig.camera.position.z).toBeCloseTo(100 - CAMERA_RIG_TUNING.distance, 6);
    expect(rig.camera.position.y).toBeCloseTo(300 + CAMERA_RIG_TUNING.height, 6);
    expect(rig.camera.fov).toBe(DEFAULT_BASE_FOV);
  });

  it('keeps its pose when the view has no local dragon', () => {
    const rig = createCameraRig();
    rig.update(viewWithDragon(100, 45), 1 / 60);
    const before = rig.camera.position.clone();
    const view = viewWithDragon(900, 45);
    view.localDragonId = 9;
    rig.update(view, 1 / 60);
    rig.update(createWorldView(), 1 / 60);
    expect(rig.camera.position.equals(before)).toBe(true);
  });

  it('updates the projection only when the FOV really changes', () => {
    const rig = createCameraRig();
    const spy = vi.spyOn(rig.camera, 'updateProjectionMatrix');
    let z = 0;
    for (let i = 0; i < 120; i++) {
      z += 45 / 60;
      rig.update(viewWithDragon(z, 45), 1 / 60);
    }
    expect(spy).toHaveBeenCalledTimes(0);

    for (let i = 0; i < 30; i++) {
      z += 95 / 60;
      rig.update(viewWithDragon(z, 95, DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING), 1 / 60);
    }
    const whileChanging = spy.mock.calls.length;
    expect(whileChanging).toBeGreaterThan(0);
    expect(rig.camera.fov).toBeGreaterThan(DEFAULT_BASE_FOV);

    // Long after the FOV has settled no further projection updates happen.
    for (let i = 0; i < 1200; i++) {
      z += 95 / 60;
      rig.update(viewWithDragon(z, 95, DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING), 1 / 60);
    }
    const settled = spy.mock.calls.length;
    for (let i = 0; i < 300; i++) {
      z += 95 / 60;
      rig.update(viewWithDragon(z, 95, DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING), 1 / 60);
    }
    expect(spy.mock.calls.length).toBe(settled);
  });

  it('applies settings', () => {
    const rig = createCameraRig({ baseFovDeg: 80 });
    expect(rig.camera.fov).toBe(80);
    const spy = vi.spyOn(rig.camera, 'updateProjectionMatrix');
    rig.setAspect(16 / 9);
    rig.setAspect(16 / 9);
    rig.setAspect(0);
    rig.setAspect(NaN);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rig.camera.aspect).toBeCloseTo(16 / 9, 12);
    rig.setBaseFov(50);
    rig.setReduceMotion(true);
    expect(rig.chase.baseFovDeg).toBe(50);
    expect(rig.chase.reduceMotion).toBe(true);
    const terrain: CameraTerrainRaycaster = { raycast: () => -1 };
    rig.setTerrain(terrain);
    expect(rig.chase.terrain).toBe(terrain);
    rig.dispose();
    expect(rig.chase.terrain).toBeNull();
  });
});
