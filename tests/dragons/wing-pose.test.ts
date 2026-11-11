import { Matrix4, Quaternion, ShaderLib, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DRAGON_ANIM_BANK_L,
  DRAGON_ANIM_BOOST,
  DRAGON_ANIM_CLIPS,
  DRAGON_ANIM_DEATH_FALL,
  DRAGON_ANIM_DIVE,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_ANIM_HIT,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_STALLED,
} from '../../src/shared';
import {
  POSE_AMPLITUDE,
  POSE_BEAT_HZ,
  POSE_BIAS,
  POSE_GLOW,
  POSE_STRIDE,
  POSE_SWEEP,
  POSE_TIP_GAIN,
  TIP_PHASE_LAG,
  WING_HINGE_Y,
  WING_HINGE_Z,
  advancePhase,
  approach,
  flapAngle,
  initialPhase,
  patchDragonShader,
  tipFlapAngle,
  writeInstanceMatrix,
  writeWingPoseTarget,
} from '../../src/dragons';

function target(anim: number, flags = DRAGON_FLAG_ALIVE, speedRatio = 1): Float32Array {
  const out = new Float32Array(POSE_STRIDE);
  writeWingPoseTarget(out, anim, flags, speedRatio);
  return out;
}

function at(pose: Float32Array, field: number): number {
  return pose[field] ?? Number.NaN;
}

describe('writeWingPoseTarget', () => {
  it('gives every animation hint a finite, bounded pose', () => {
    for (let anim = 0; anim < DRAGON_ANIM_CLIPS.length + 2; anim++) {
      for (const flags of [0, DRAGON_FLAG_ALIVE, 0xffff]) {
        for (const speed of [0, 0.5, 1, 2.5, Number.NaN, Infinity]) {
          const pose = target(anim, flags, speed);
          expect(pose.every(Number.isFinite)).toBe(true);
          expect(at(pose, POSE_BEAT_HZ)).toBeGreaterThanOrEqual(0);
          expect(at(pose, POSE_BEAT_HZ)).toBeLessThan(5);
          expect(Math.abs(at(pose, POSE_BIAS)) + at(pose, POSE_AMPLITUDE)).toBeLessThan(1.3);
          expect(at(pose, POSE_SWEEP)).toBeGreaterThanOrEqual(0);
          expect(at(pose, POSE_SWEEP)).toBeLessThan(1.4);
          expect(at(pose, POSE_GLOW)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('spreads for a glide, beats for a flap, sweeps for a boost, folds for a dive', () => {
    const glide = target(DRAGON_ANIM_GLIDE);
    const flap = target(DRAGON_ANIM_FLAP);
    const boost = target(DRAGON_ANIM_BOOST, DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING);
    const dive = target(DRAGON_ANIM_DIVE);
    expect(at(glide, POSE_AMPLITUDE)).toBeLessThan(0.12);
    expect(at(glide, POSE_SWEEP)).toBeLessThan(0.1);
    expect(at(flap, POSE_AMPLITUDE)).toBeGreaterThan(at(glide, POSE_AMPLITUDE) * 5);
    expect(at(flap, POSE_BEAT_HZ)).toBeGreaterThan(at(glide, POSE_BEAT_HZ) * 3);
    expect(at(boost, POSE_SWEEP)).toBeGreaterThan(at(glide, POSE_SWEEP) + 0.3);
    expect(at(dive, POSE_SWEEP)).toBeGreaterThan(at(boost, POSE_SWEEP) + 0.3);
    expect(at(dive, POSE_AMPLITUDE)).toBeLessThan(0.05);
    expect(at(boost, POSE_GLOW)).toBeGreaterThan(at(glide, POSE_GLOW));
  });

  it('beats harder in a slow glide and sweeps in a fast one', () => {
    const slow = target(DRAGON_ANIM_GLIDE, DRAGON_FLAG_ALIVE, 0.5);
    const cruise = target(DRAGON_ANIM_GLIDE, DRAGON_FLAG_ALIVE, 1);
    const fast = target(DRAGON_ANIM_GLIDE, DRAGON_FLAG_ALIVE, 1.8);
    expect(at(slow, POSE_AMPLITUDE)).toBeGreaterThan(at(cruise, POSE_AMPLITUDE));
    expect(at(slow, POSE_BEAT_HZ)).toBeGreaterThan(at(cruise, POSE_BEAT_HZ));
    expect(at(fast, POSE_SWEEP)).toBeGreaterThan(at(cruise, POSE_SWEEP));
    expect(target(DRAGON_ANIM_BANK_L)).toEqual(cruise);
  });

  it('tucks for the dodge roll, thrashes in a stall, flinches on a hit', () => {
    const glide = target(DRAGON_ANIM_GLIDE);
    const dodge = target(DRAGON_ANIM_BANK_L, DRAGON_FLAG_ALIVE | DRAGON_FLAG_DODGING);
    const stall = target(DRAGON_ANIM_GLIDE, DRAGON_FLAG_ALIVE | DRAGON_FLAG_STALLED);
    const hit = target(DRAGON_ANIM_HIT);
    expect(at(dodge, POSE_SWEEP)).toBeGreaterThan(0.6);
    expect(at(dodge, POSE_AMPLITUDE)).toBeLessThan(at(glide, POSE_AMPLITUDE));
    expect(at(stall, POSE_AMPLITUDE)).toBeGreaterThan(0.5);
    expect(at(stall, POSE_BEAT_HZ)).toBeGreaterThan(2.5);
    expect(at(hit, POSE_BIAS)).toBeGreaterThan(at(glide, POSE_BIAS));
  });

  it('goes limp and dark when dead, whatever the hint says', () => {
    const fall = target(DRAGON_ANIM_DEATH_FALL);
    const notAlive = target(DRAGON_ANIM_FLAP, 0);
    expect(at(fall, POSE_GLOW)).toBe(0);
    expect(at(fall, POSE_BIAS)).toBeGreaterThan(0.6);
    expect(notAlive).toEqual(fall);
  });
});

describe('beat maths', () => {
  it('eases toward the target independently of the frame rate', () => {
    let coarse = 0;
    for (let i = 0; i < 30; i++) coarse = approach(coarse, 1, 9, 1 / 30);
    let fine = 0;
    for (let i = 0; i < 240; i++) fine = approach(fine, 1, 9, 1 / 240);
    expect(coarse).toBeCloseTo(fine, 6);
    expect(coarse).toBeGreaterThan(0.99);
    expect(coarse).toBeLessThanOrEqual(1);
    expect(approach(0.3, 1, 9, 0)).toBe(0.3);
    expect(approach(0.3, 1, 9, Number.NaN)).toBe(0.3);
  });

  it('advances and wraps the phase', () => {
    expect(advancePhase(0, 1, 0.25)).toBeCloseTo(Math.PI / 2, 9);
    let phase = 0;
    for (let i = 0; i < 1000; i++) {
      phase = advancePhase(phase, 2.6, 1 / 60);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(Math.PI * 2);
    }
    expect(advancePhase(1, 2, 0)).toBe(1);
    expect(advancePhase(Number.NaN, 2, 0.1)).toBe(0);
    expect(advancePhase(1, Number.NaN, 0.1)).toBe(1);
  });

  it('swings the root around the bias and lets the tip trail', () => {
    expect(flapAngle(Math.PI / 2, 0.5, 0.1)).toBeCloseTo(0.6, 9);
    expect(flapAngle(-Math.PI / 2, 0.5, 0.1)).toBeCloseTo(-0.4, 9);
    expect(tipFlapAngle(Math.PI / 2 + TIP_PHASE_LAG, 0.5, 0.4)).toBeCloseTo(0.2, 9);
    expect(tipFlapAngle(TIP_PHASE_LAG, 0.5, 0.4)).toBeCloseTo(0, 9);
  });

  it('spreads the start phases', () => {
    const phases = new Set<number>();
    for (let id = 0; id < 10; id++) {
      const phase = initialPhase(id);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(Math.PI * 2);
      phases.add(Math.round(phase * 100));
    }
    expect(phases.size).toBe(10);
  });
});

describe('writeInstanceMatrix', () => {
  it('equals Matrix4.compose with unit scale', () => {
    const out = new Float32Array(32);
    const quaternion = new Quaternion(0.3, -0.5, 0.2, 0.7).normalize();
    const position = new Vector3(12, 340, -780);
    writeInstanceMatrix(out, 16, position, quaternion);
    const reference = new Matrix4().compose(position, quaternion, new Vector3(1, 1, 1));
    for (let i = 0; i < 16; i++) expect(out[16 + i]).toBeCloseTo(reference.elements[i] ?? 0, 5);
    expect(Array.from(out.subarray(0, 16)).every((value) => value === 0)).toBe(true);
  });
});

// --- Shader patch --------------------------------------------------------------------------------

/** The GLSL `dfTurnWing` + hinge maths of dragon-shader.ts, transcribed for a sign check. */
function turnWingVertex(
  p: readonly [number, number, number],
  hingeX: number,
  tipWeight: number,
  flap: number,
  tipFlap: number,
  sweep: number,
): [number, number, number] {
  const side = Math.sign(hingeX);
  const flapAngleRad = side * (flap + tipWeight * tipFlap);
  const sweepAngle = side * sweep;
  const fc = Math.cos(flapAngleRad);
  const fs = Math.sin(flapAngleRad);
  const sc = Math.cos(sweepAngle);
  const ss = Math.sin(sweepAngle);
  const vx = p[0] - hingeX;
  const vy = p[1] - WING_HINGE_Y;
  const vz = p[2] - WING_HINGE_Z;
  const sx = sc * vx + ss * vz;
  const sz = sc * vz - ss * vx;
  return [hingeX + fc * sx - fs * vy, WING_HINGE_Y + fs * sx + fc * vy, WING_HINGE_Z + sz];
}

describe('wing rotation convention (+X left, +Y up, +Z forward)', () => {
  const leftTip: [number, number, number] = [6.5, WING_HINGE_Y, WING_HINGE_Z];
  const rightTip: [number, number, number] = [-6.5, WING_HINGE_Y, WING_HINGE_Z];

  it('raises both tips for a positive flap and keeps them mirrored', () => {
    const left = turnWingVertex(leftTip, 0.5, 1, 0.4, 0.1, 0);
    const right = turnWingVertex(rightTip, -0.5, 1, 0.4, 0.1, 0);
    expect(left[1]).toBeGreaterThan(WING_HINGE_Y + 2);
    expect(right[1]).toBeCloseTo(left[1], 9);
    expect(right[0]).toBeCloseTo(-left[0], 9);
    expect(left[0]).toBeGreaterThan(0);
  });

  it('moves both tips toward the tail for a positive sweep', () => {
    const left = turnWingVertex(leftTip, 0.5, 1, 0, 0, 1.2);
    const right = turnWingVertex(rightTip, -0.5, 1, 0, 0, 1.2);
    expect(left[2]).toBeLessThan(WING_HINGE_Z - 5);
    expect(right[2]).toBeCloseTo(left[2], 9);
    expect(right[0]).toBeCloseTo(-left[0], 9);
    expect(Math.abs(left[0])).toBeLessThan(3.5);
  });

  it('leaves body vertices (hinge 0) where they are', () => {
    const p: [number, number, number] = [0.4, -0.3, 2.5];
    const moved = turnWingVertex(p, 0, 0, 0.9, 0.3, 1.1);
    expect(moved[0]).toBeCloseTo(p[0], 12);
    expect(moved[1]).toBeCloseTo(p[1], 12);
    expect(moved[2]).toBeCloseTo(p[2], 12);
  });
});

describe('patchDragonShader', () => {
  it('hooks the lit pass of three r187 MeshLambertMaterial', () => {
    const shader = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
    };
    patchDragonShader(shader, 'lit');
    const v = shader.vertexShader;
    const f = shader.fragmentShader;
    // Declarations sit before main(), the pose setup before its first use.
    const main = v.indexOf('void main()');
    expect(v.indexOf('attribute vec4 aWing;')).toBeLessThan(main);
    expect(v.indexOf('attribute vec3 aAccent;')).toBeLessThan(main);
    expect(v.indexOf('vec3 dfTurnWing(')).toBeLessThan(main);
    expect(v.indexOf('vec3 dfTurnWing(')).toBeGreaterThan(v.indexOf('#include <common>'));
    const setup = v.indexOf('float dfSide = sign( aWing.x );');
    const normal = v.indexOf('objectNormal = dfTurnWing(');
    const position = v.indexOf('transformed = dfHinge + dfTurnWing(');
    expect(setup).toBeGreaterThan(v.indexOf('#include <beginnormal_vertex>'));
    expect(normal).toBeGreaterThan(setup);
    expect(normal).toBeLessThan(v.indexOf('#include <defaultnormal_vertex>'));
    expect(position).toBeGreaterThan(v.indexOf('#include <begin_vertex>'));
    expect(position).toBeLessThan(v.indexOf('#include <project_vertex>'));
    expect(v.match(/float dfSide/g)?.length).toBe(1);
    expect(v).toContain(`vec3( aWing.x, ${WING_HINGE_Y.toFixed(4)}, ${WING_HINGE_Z.toFixed(4)} )`);
    expect(v).toContain('vDfAccent = aAccent * aWing.w;');
    expect(f.indexOf('varying vec3 vDfAccent;')).toBeLessThan(f.indexOf('void main()'));
    const emissive = f.indexOf('totalEmissiveRadiance += vDfAccent;');
    expect(emissive).toBeGreaterThan(f.indexOf('vec3 totalEmissiveRadiance = emissive;'));
    expect(emissive).toBeLessThan(f.indexOf('#include <lights_lambert_fragment>'));
  });

  it('hooks the shadow depth pass without the accent', () => {
    const shader = {
      vertexShader: ShaderLib.depth.vertexShader,
      fragmentShader: ShaderLib.depth.fragmentShader,
    };
    patchDragonShader(shader, 'depth');
    const v = shader.vertexShader;
    const setup = v.indexOf('float dfSide = sign( aWing.x );');
    expect(setup).toBeGreaterThan(v.indexOf('#include <begin_vertex>'));
    expect(v.indexOf('transformed = dfHinge + dfTurnWing(')).toBeGreaterThan(setup);
    expect(v.indexOf('transformed = dfHinge')).toBeLessThan(v.indexOf('#include <project_vertex>'));
    expect(v).not.toContain('aAccent');
    expect(v).not.toContain('objectNormal = dfTurnWing');
    expect(shader.fragmentShader).toBe(ShaderLib.depth.fragmentShader);
  });

  it('fails loudly if three.js renames a chunk', () => {
    expect(() =>
      patchDragonShader({ vertexShader: 'void main() {}', fragmentShader: '' }, 'lit'),
    ).toThrow(/not found/);
  });
});
