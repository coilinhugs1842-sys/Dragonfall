/**
 * The shared camera maths of the cinematics: easing, the Catmull-Rom path and its even-speed
 * table, the orbit pose, frame-rate independent damping and the terrain pull-in.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  aimCamera,
  catmullRomPoint,
  catmullRomTangent,
  clamp01,
  createSplineLengthTable,
  dampAngle,
  dampLookTarget,
  damping,
  distanceVec3,
  easeCoast,
  easeInCubic,
  easeInOutCubic,
  easeOutCubic,
  easeRamp,
  forwardOfQuat,
  lerpVec3,
  measureSpline,
  pullInFromTerrain,
  smoothstep,
  splineParamAtFraction,
  wrapAngle,
  writeOrbitPosition,
  yawOfDirection,
} from '../../src/cinematics/camera-math';
import { createVec3 } from '../../src/shared';
import type { TerrainQuery, Vec3 } from '../../src/shared';

/** Long approach, then tight points: the shape that makes a uniform Catmull-Rom overshoot. */
const PATH: readonly Vec3[] = [
  { x: -900, y: 450, z: 200 },
  { x: -300, y: 380, z: 0 },
  { x: -250, y: 370, z: -30 },
  { x: -100, y: 320, z: -40 },
  { x: 0, y: 300, z: 60 },
];

/** A wall: everything at x >= `wallX` is rock. */
function wallTerrain(wallX: number): TerrainQuery {
  return {
    raycast(ox, _oy, _oz, dx, dy, dz, maxDistance) {
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(length > 0)) return -1;
      const ux = dx / length;
      if (ox >= wallX) return 0;
      if (ux <= 0) return -1;
      const distance = (wallX - ox) / ux;
      return distance <= maxDistance ? distance : -1;
    },
    clearance(x, _y, _z, maxDistance) {
      const distance = Math.abs(wallX - x);
      return distance < maxDistance ? distance : -1;
    },
  };
}

describe('easing', () => {
  it('clamps and hits its end values', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    for (const ease of [easeInCubic, easeOutCubic, easeInOutCubic]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      expect(ease(-3)).toBe(0);
      expect(ease(7)).toBe(1);
    }
    expect(smoothstep(2, 4, 1)).toBe(0);
    expect(smoothstep(2, 4, 3)).toBeCloseTo(0.5, 12);
    expect(smoothstep(2, 4, 5)).toBe(1);
    // A zero-width edge is a step, not a division by zero.
    expect(smoothstep(1, 1, 0.5)).toBe(0);
    expect(smoothstep(1, 1, 1.5)).toBe(1);
  });

  it('never runs backwards', () => {
    const eases: ((t: number) => number)[] = [
      easeInCubic,
      easeOutCubic,
      easeInOutCubic,
      (t) => smoothstep(0, 1, t),
      (t) => easeCoast(t, 0.3),
      (t) => easeCoast(t, 0.5),
    ];
    for (const ease of eases) {
      let last = ease(0);
      for (let i = 1; i <= 200; i++) {
        const value = ease(i / 200);
        expect(value).toBeGreaterThanOrEqual(last);
        last = value;
      }
    }
  });

  it('easeInOutCubic is symmetric and meets itself in the middle', () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    for (const t of [0.1, 0.25, 0.4]) {
      expect(easeInOutCubic(t) + easeInOutCubic(1 - t)).toBeCloseTo(1, 12);
    }
  });

  it('easeCoast starts fast and ends slow, by the stated factors', () => {
    const h = 1e-5;
    const brake = 0.3;
    expect(easeCoast(0, brake)).toBe(0);
    expect(easeCoast(1, brake)).toBeCloseTo(1, 12);
    expect(easeCoast(h, brake) / h).toBeCloseTo(1 + brake, 3);
    expect((1 - easeCoast(1 - h, brake)) / h).toBeCloseTo(1 - 2 * brake, 3);
    // No brake is plain linear time.
    expect(easeCoast(0.37, 0)).toBeCloseTo(0.37, 12);
  });

  it('easeRamp goes rest to rest, symmetric, and never faster than 1 / (1 - ramp)', () => {
    const h = 1e-5;
    for (const ramp of [0.1, 0.32, 0.5]) {
      expect(easeRamp(0, ramp)).toBe(0);
      expect(easeRamp(1, ramp)).toBe(1);
      expect(easeRamp(-2, ramp)).toBe(0);
      expect(easeRamp(3, ramp)).toBe(1);
      expect(easeRamp(0.5, ramp)).toBeCloseTo(0.5, 12);
      // At rest at both ends.
      expect(easeRamp(h, ramp) / h).toBeLessThan(1e-3);
      expect((1 - easeRamp(1 - h, ramp)) / h).toBeLessThan(1e-3);
      let last = 0;
      let peak = 0;
      for (let i = 1; i <= 1000; i++) {
        const value = easeRamp(i / 1000, ramp);
        expect(value + easeRamp(1 - i / 1000, ramp)).toBeCloseTo(1, 12);
        expect(value).toBeGreaterThanOrEqual(last);
        peak = Math.max(peak, (value - last) * 1000);
        last = value;
      }
      expect(peak).toBeLessThanOrEqual(1 / (1 - ramp) + 1e-9);
      expect(peak).toBeGreaterThan(1 / (1 - ramp) - 0.01);
    }
    // A ramp that is not a number or out of range still gives a usable curve.
    expect(easeRamp(0.5, Number.NaN)).toBeCloseTo(0.5, 12);
    expect(easeRamp(0.5, 9)).toBeCloseTo(0.5, 12);
    expect(easeRamp(0.5, 0)).toBeCloseTo(0.5, 12);
  });
});

describe('damping', () => {
  it('is the same curve in one step or in many', () => {
    let value = 0;
    for (let i = 0; i < 144; i++) value += (10 - value) * damping(3, 1 / 144);
    const once = 10 * damping(3, 1);
    expect(value).toBeCloseTo(once, 9);
    expect(damping(0, 1)).toBe(0);
    expect(damping(3, 0)).toBe(0);
    expect(damping(3, -1)).toBe(0);
  });

  it('turns an angle the short way round', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(-Math.PI, 12);
    expect(wrapAngle(-0.25)).toBeCloseTo(-0.25, 12);
    // From 170 degrees to -170 degrees is 20 degrees through 180, not 340 back through 0.
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    const next = dampAngle(from, to, 5, 0.05);
    const moved = wrapAngle(next - from);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan((20 * Math.PI) / 180);
  });

  it('eases a look target toward its subject at any frame rate', () => {
    const subject = { x: 40, y: 10, z: -20 };
    const slow = createVec3();
    const fast = createVec3();
    for (let i = 0; i < 30; i++) dampLookTarget(slow, subject, 6, 1 / 30);
    for (let i = 0; i < 120; i++) dampLookTarget(fast, subject, 6, 1 / 120);
    expect(distanceVec3(slow, fast)).toBeLessThan(1e-9);
    // One second at rate 6 covers all but e^-6 of the way.
    expect(distanceVec3(slow, subject)).toBeCloseTo(distanceVec3(createVec3(), subject) * Math.exp(-6), 9);
  });
});

describe('vectors and orbit', () => {
  it('reads the nose direction of a quaternion, unit or not', () => {
    const out = createVec3();
    expect(forwardOfQuat(out, { x: 0, y: 0, z: 0, w: 1 })).toMatchObject({ x: 0, y: 0, z: 1 });
    // Half a turn about +Y: Frost's gate faces -Z.
    forwardOfQuat(out, { x: 0, y: 1, z: 0, w: 0 });
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(-1, 12);
    // A quarter turn about +Y, scaled by 3: +Z goes to +X.
    const h = Math.SQRT1_2 * 3;
    forwardOfQuat(out, { x: 0, y: h, z: 0, w: h });
    expect(out.x).toBeCloseTo(1, 12);
    expect(out.z).toBeCloseTo(0, 12);
    // Degenerate input falls back to +Z instead of NaN.
    expect(forwardOfQuat(out, { x: 0, y: 0, z: 0, w: 0 })).toMatchObject({ x: 0, y: 0, z: 1 });
    expect(forwardOfQuat(out, { x: Number.NaN, y: 0, z: 0, w: 1 })).toMatchObject({ x: 0, y: 0, z: 1 });
  });

  it('agrees on what a heading is', () => {
    expect(yawOfDirection(0, 1)).toBeCloseTo(0, 12);
    expect(yawOfDirection(1, 0)).toBeCloseTo(Math.PI / 2, 12);
    const out = createVec3();
    const centre = { x: 10, y: 100, z: -5 };
    writeOrbitPosition(out, centre, 20, 0, 3);
    expect(out).toMatchObject({ x: 10, y: 103, z: 15 });
    writeOrbitPosition(out, centre, 20, Math.PI / 2, -2);
    expect(out.x).toBeCloseTo(30, 12);
    expect(out.y).toBeCloseTo(98, 12);
    expect(out.z).toBeCloseTo(-5, 12);
    // Round trip: the heading from the centre to the orbit point is the azimuth.
    writeOrbitPosition(out, centre, 20, 2.1, 0);
    expect(yawOfDirection(out.x - centre.x, out.z - centre.z)).toBeCloseTo(2.1, 12);
  });

  it('lerps into the out-param and returns it', () => {
    const out = createVec3();
    expect(lerpVec3(out, { x: 0, y: 2, z: 4 }, { x: 10, y: 4, z: 0 }, 0.25)).toBe(out);
    expect(out).toMatchObject({ x: 2.5, y: 2.5, z: 3 });
  });
});

describe('Catmull-Rom path', () => {
  it('passes through every control point, the two ends included', () => {
    const out = createVec3();
    const segments = PATH.length - 1;
    PATH.forEach((point, index) => {
      catmullRomPoint(out, PATH, index / segments);
      expect(out.x).toBeCloseTo(point.x, 9);
      expect(out.y).toBeCloseTo(point.y, 9);
      expect(out.z).toBeCloseTo(point.z, 9);
    });
    // Outside 0..1 is clamped to the ends.
    expect(catmullRomPoint(out, PATH, -5)).toMatchObject(PATH[0] as Vec3);
    catmullRomPoint(out, PATH, 5);
    expect(out.x).toBeCloseTo(0, 9);
  });

  it('is a straight, evenly paced line through collinear, evenly spaced points', () => {
    const line: Vec3[] = [0, 1, 2, 3, 4].map((i) => ({ x: i * 10, y: 5, z: -i * 20 }));
    const out = createVec3();
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      catmullRomPoint(out, line, u);
      expect(out.x).toBeCloseTo(u * 40, 9);
      expect(out.y).toBeCloseTo(5, 9);
      expect(out.z).toBeCloseTo(-u * 80, 9);
    }
  });

  it('does not overshoot where a short segment follows a long one (centripetal)', () => {
    // x only ever grows along PATH's points, so the curve must not double back in x.
    const out = createVec3();
    let lastX = -Infinity;
    for (let i = 0; i <= 400; i++) {
      catmullRomPoint(out, PATH, i / 400);
      expect(out.x).toBeGreaterThanOrEqual(lastX - 1e-9);
      lastX = out.x;
    }
  });

  it('is continuous in position and direction across the joints', () => {
    const before = createVec3();
    const after = createVec3();
    const segments = PATH.length - 1;
    const h = 1e-6;
    for (let joint = 1; joint < segments; joint++) {
      const u = joint / segments;
      catmullRomPoint(before, PATH, u - h);
      catmullRomPoint(after, PATH, u + h);
      expect(distanceVec3(before, after)).toBeLessThan(0.02);
      catmullRomTangent(before, PATH, u - h);
      catmullRomTangent(after, PATH, u + h);
      expect(distanceVec3(before, after)).toBeLessThan(1e-3);
    }
  });

  it('gives a unit tangent that matches the finite difference', () => {
    const tangent = createVec3();
    const a = createVec3();
    const b = createVec3();
    const h = 1e-5;
    for (const u of [0, 0.07, 0.33, 0.5, 0.81, 1 - h]) {
      catmullRomTangent(tangent, PATH, u);
      expect(Math.hypot(tangent.x, tangent.y, tangent.z)).toBeCloseTo(1, 9);
      catmullRomPoint(a, PATH, u);
      catmullRomPoint(b, PATH, u + h);
      const length = distanceVec3(a, b);
      expect((b.x - a.x) / length).toBeCloseTo(tangent.x, 3);
      expect((b.y - a.y) / length).toBeCloseTo(tangent.y, 3);
      expect((b.z - a.z) / length).toBeCloseTo(tangent.z, 3);
    }
  });

  it('survives degenerate input', () => {
    const out = createVec3(1, 2, 3);
    expect(catmullRomPoint(out, [], 0.5)).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(catmullRomTangent(out, [], 0.5)).toMatchObject({ x: 0, y: 0, z: 1 });
    const one = [{ x: 4, y: 5, z: 6 }];
    expect(catmullRomPoint(out, one, 0.5)).toMatchObject({ x: 4, y: 5, z: 6 });
    expect(catmullRomTangent(out, one, 0.5)).toMatchObject({ x: 0, y: 0, z: 1 });
    // Two points: a straight line.
    const two = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
    ];
    catmullRomPoint(out, two, 0.3);
    expect(out.x).toBeCloseTo(3, 9);
    // Doubled points do not produce NaN.
    const doubled = [two[0] as Vec3, two[0] as Vec3, two[1] as Vec3, two[1] as Vec3];
    for (let i = 0; i <= 30; i++) {
      catmullRomPoint(out, doubled, i / 30);
      expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
      catmullRomTangent(out, doubled, i / 30);
      expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
    }
  });
});

describe('even speed along the path', () => {
  it('measures the length of a straight path exactly', () => {
    const table = createSplineLengthTable(16);
    const line: Vec3[] = [0, 1, 2, 3].map((i) => ({ x: i * 30, y: 0, z: i * 40 }));
    expect(measureSpline(table, line)).toBeCloseTo(150, 6);
    expect(table.total).toBeCloseTo(150, 6);
    expect(splineParamAtFraction(table, 0)).toBe(0);
    expect(splineParamAtFraction(table, 1)).toBe(1);
    expect(splineParamAtFraction(table, 0.4)).toBeCloseTo(0.4, 9);
  });

  it('turns equal fractions into equal distances on an uneven path', () => {
    const table = createSplineLengthTable(128);
    const total = measureSpline(table, PATH);
    expect(total).toBeGreaterThan(900);

    const a = createVec3();
    const b = createVec3();
    const steps = 50;
    let shortest = Infinity;
    let longest = 0;
    let raw = 0;
    let rawLongest = 0;
    for (let i = 0; i < steps; i++) {
      catmullRomPoint(a, PATH, splineParamAtFraction(table, i / steps));
      catmullRomPoint(b, PATH, splineParamAtFraction(table, (i + 1) / steps));
      const step = distanceVec3(a, b);
      shortest = Math.min(shortest, step);
      longest = Math.max(longest, step);
      // The same without the table: the long first segment is crossed many times faster.
      catmullRomPoint(a, PATH, i / steps);
      catmullRomPoint(b, PATH, (i + 1) / steps);
      raw = distanceVec3(a, b);
      rawLongest = Math.max(rawLongest, raw);
    }
    expect(longest / shortest).toBeLessThan(1.06);
    expect(longest).toBeCloseTo(total / steps, 0);
    expect(rawLongest).toBeGreaterThan(longest * 2);
  });

  it('is monotonic, clamps its input, and passes an unmeasured table through', () => {
    const table = createSplineLengthTable(32);
    expect(splineParamAtFraction(table, 0.3)).toBe(0.3);
    measureSpline(table, PATH);
    let last = 0;
    for (let i = 0; i <= 300; i++) {
      const u = splineParamAtFraction(table, i / 300);
      expect(u).toBeGreaterThanOrEqual(last);
      expect(u).toBeLessThanOrEqual(1);
      last = u;
    }
    expect(splineParamAtFraction(table, -1)).toBe(0);
    expect(splineParamAtFraction(table, 9)).toBe(1);
    expect(splineParamAtFraction(table, Number.NaN)).toBe(0);
    // A path with no length at all.
    const still = [
      { x: 1, y: 1, z: 1 },
      { x: 1, y: 1, z: 1 },
    ];
    expect(measureSpline(table, still)).toBe(0);
    expect(splineParamAtFraction(table, 0.5)).toBe(0.5);
    // A silly sample count still gives a usable table.
    expect(createSplineLengthTable(0).lengths.length).toBe(2);
  });
});

describe('pullInFromTerrain', () => {
  const subject = { x: 0, y: 100, z: 0 };

  it('leaves a clear camera alone', () => {
    const position = createVec3(-30, 110, 5);
    expect(pullInFromTerrain(position, subject, wallTerrain(50), 3)).toBe(1);
    expect(position).toMatchObject({ x: -30, y: 110, z: 5 });
    expect(pullInFromTerrain(position, subject, null, 3)).toBe(1);
  });

  it('stops a camera short of rock on the sight line', () => {
    const position = createVec3(40, 100, 0);
    const kept = pullInFromTerrain(position, subject, wallTerrain(20), 3);
    expect(kept).toBeCloseTo(17 / 40, 9);
    expect(position.x).toBeCloseTo(17, 9);
    expect(position.y).toBeCloseTo(100, 9);
  });

  it('steps in from a wall that a clear line ends beside', () => {
    // The camera is 1 m short of the wall: the ray does not reach it, the margin does.
    const position = createVec3(19, 100, 0);
    const kept = pullInFromTerrain(position, subject, wallTerrain(20), 3);
    expect(kept).toBeLessThan(1);
    expect(position.x).toBeCloseTo(17, 9);
  });

  it('goes half-way when the rock is closer than two margins, and never past the subject', () => {
    const position = createVec3(40, 100, 0);
    pullInFromTerrain(position, subject, wallTerrain(4), 3);
    expect(position.x).toBeCloseTo(2, 9);
    // The subject itself inside rock: the camera collapses onto it rather than flying off.
    const inside = createVec3(40, 100, 0);
    expect(pullInFromTerrain(inside, subject, wallTerrain(-5), 3)).toBe(0);
    expect(inside).toMatchObject({ x: 0, y: 100, z: 0 });
    // Camera on the subject: nothing to do.
    const same = createVec3(0, 100, 0);
    expect(pullInFromTerrain(same, subject, wallTerrain(20), 3)).toBe(1);
  });
});

describe('aimCamera', () => {
  it('places the camera, looks at the target and sets the FOV', () => {
    const camera = new PerspectiveCamera(50, 16 / 9, 0.5, 6000);
    aimCamera(camera, { x: 10, y: 20, z: 30 }, { x: 10, y: 20, z: -70 }, 0, 42);
    expect(camera.position.toArray()).toEqual([10, 20, 30]);
    expect(camera.fov).toBe(42);
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(forward.x).toBeCloseTo(0, 9);
    expect(forward.y).toBeCloseTo(0, 9);
    expect(forward.z).toBeCloseTo(-1, 9);
  });

  it('rolls right wing down for a positive roll, without moving the view axis', () => {
    const camera = new PerspectiveCamera();
    aimCamera(camera, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 }, 0.2, 50);
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(forward.z).toBeCloseTo(-1, 9);
    // Looking down -Z, the camera's right is +X: right wing down = its right axis dips.
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    expect(right.y).toBeCloseTo(-Math.sin(0.2), 9);
  });
});
