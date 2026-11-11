import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BINDINGS,
  DEFAULT_INPUT_OPTIONS,
  clearInputState,
  createInputState,
  inputCodeDown,
  inputCodeUp,
  inputMouseMove,
  isActionActive,
  isCodeBound,
  rebindAction,
  releaseAllInput,
  reticleDecay,
  reticleSteerGain,
  reticleUnitsPerCount,
  sampleInput,
  setInputBindings,
  unitCircleScale,
} from '../../src/input';
import {
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_DODGE_RIGHT,
  BUTTON_FLAP,
  BUTTON_MASK,
  BUTTON_PRIMARY,
  BUTTON_ROLL_LEFT,
  BUTTON_ROLL_RIGHT,
  BUTTON_SECONDARY,
  BUTTON_ULTIMATE,
  BUTTON_UTILITY,
  TICK_DT_S,
  createInputFrame,
} from '../../src/shared';

const RADIUS = DEFAULT_INPUT_OPTIONS.reticleRadiusCounts;

describe('reticle maths', () => {
  it('clamps to the unit circle and keeps the direction', () => {
    expect(unitCircleScale(0.3, 0.4)).toBe(1);
    const s = unitCircleScale(3, 4);
    expect(3 * s).toBeCloseTo(0.6, 12);
    expect(4 * s).toBeCloseTo(0.8, 12);
    expect(unitCircleScale(NaN, 0)).toBe(1);
  });

  it('has a dead zone, starts at zero on its edge and reaches 1 at the rim', () => {
    expect(reticleSteerGain(0, 0.1, 1.5)).toBe(0);
    expect(reticleSteerGain(0.05, 0.1, 1.5)).toBe(0);
    expect(reticleSteerGain(0.1, 0.1, 1.5)).toBe(0);
    expect(0.1001 * reticleSteerGain(0.1001, 0.1, 1.5)).toBeLessThan(0.001);
    expect(1 * reticleSteerGain(1, 0.1, 1.5)).toBeCloseTo(1, 12);
    expect(2 * reticleSteerGain(2, 0.1, 1.5)).toBeCloseTo(1, 12);
  });

  it('is monotonic and below linear for an exponent above 1', () => {
    let last = 0;
    for (let m = 0.01; m <= 1; m += 0.01) {
      const steer = m * reticleSteerGain(m, 0.06, 1.5);
      expect(steer).toBeGreaterThanOrEqual(last);
      expect(steer).toBeLessThanOrEqual(m + 1e-12);
      last = steer;
    }
  });

  it('survives bad parameters', () => {
    expect(reticleSteerGain(NaN, 0.1, 1.5)).toBe(0);
    expect(Number.isFinite(reticleSteerGain(0.5, 5, 1.5))).toBe(true);
    expect(0.5 * reticleSteerGain(0.5, 0, NaN)).toBeCloseTo(0.5, 12);
    expect(reticleUnitsPerCount(1, 0)).toBe(0);
    expect(reticleUnitsPerCount(NaN, 100)).toBe(0);
    expect(reticleUnitsPerCount(2, 100)).toBeCloseTo(0.02, 12);
  });

  it('decays independently of the step size', () => {
    const whole = reticleDecay(1.2, 1);
    let stepped = 1;
    for (let i = 0; i < 30; i++) stepped *= reticleDecay(1.2, TICK_DT_S);
    expect(stepped).toBeCloseTo(whole, 12);
    expect(reticleDecay(0, 1)).toBe(1);
    expect(reticleDecay(1, -1)).toBe(1);
  });
});

describe('mouse -> reticle -> steer', () => {
  it('moves right/up for mouse right/forward and clamps at the rim', () => {
    const state = createInputState();
    inputMouseMove(state, RADIUS / 2, -RADIUS / 4);
    expect(state.reticleX).toBeCloseTo(0.5, 12);
    expect(state.reticleY).toBeCloseTo(0.25, 12);
    inputMouseMove(state, RADIUS * 1.2, 0);
    expect(Math.hypot(state.reticleX, state.reticleY)).toBeCloseTo(1, 12);

    const frame = sampleInput(state, 7, createInputFrame());
    expect(frame.tick).toBe(7);
    expect(frame.steerX).toBeGreaterThan(0.9);
    expect(frame.steerY).toBeGreaterThan(0);
    expect(Math.hypot(frame.steerX, frame.steerY)).toBeLessThanOrEqual(1 + 1e-12);
  });

  it('honours sensitivity and invert-Y', () => {
    const state = createInputState(DEFAULT_BINDINGS, { sensitivity: 2, invertY: true });
    inputMouseMove(state, RADIUS / 8, -RADIUS / 8);
    expect(state.reticleX).toBeCloseTo(0.25, 12);
    expect(state.reticleY).toBeCloseTo(-0.25, 12);
  });

  it('ignores non-finite and absurd deltas', () => {
    const state = createInputState();
    inputMouseMove(state, NaN, 3);
    inputMouseMove(state, 3, Infinity);
    inputMouseMove(state, 50_000, 0);
    expect(state.reticleX).toBe(0);
    expect(state.reticleY).toBe(0);
  });

  it('eases back to the centre and gives no steer inside the dead zone', () => {
    const state = createInputState();
    const frame = createInputFrame();
    inputMouseMove(state, RADIUS, 0);
    sampleInput(state, 0, frame);
    expect(frame.steerX).toBeCloseTo(1, 12);
    for (let tick = 1; tick <= 30; tick++) sampleInput(state, tick, frame);
    expect(state.reticleX).toBeCloseTo(
      Math.exp(-DEFAULT_INPUT_OPTIONS.recenterRate * (31 / 30)),
      9,
    );
    for (let tick = 31; tick < 400; tick++) sampleInput(state, tick, frame);
    expect(state.reticleX).toBeLessThan(DEFAULT_INPUT_OPTIONS.deadZone);
    expect(frame.steerX).toBe(0);
  });

  it('keeps the reticle when the recentre rate is 0', () => {
    const state = createInputState(DEFAULT_BINDINGS, { recenterRate: 0 });
    inputMouseMove(state, RADIUS / 2, 0);
    for (let tick = 0; tick < 60; tick++) sampleInput(state, tick, createInputFrame());
    expect(state.reticleX).toBeCloseTo(0.5, 12);
  });
});

describe('keys -> buttons and fine steer', () => {
  it('maps every default binding to its button bit', () => {
    const cases: readonly (readonly [string, number])[] = [
      ['ShiftLeft', BUTTON_BOOST],
      ['ShiftRight', BUTTON_BOOST],
      ['Space', BUTTON_FLAP],
      ['ControlLeft', BUTTON_DIVE],
      ['KeyC', BUTTON_DIVE],
      ['KeyQ', BUTTON_DODGE_LEFT],
      ['KeyE', BUTTON_DODGE_RIGHT],
      ['Mouse0', BUTTON_PRIMARY],
      ['Mouse2', BUTTON_SECONDARY],
      ['KeyF', BUTTON_UTILITY],
      ['KeyR', BUTTON_ULTIMATE],
      ['KeyA', BUTTON_ROLL_LEFT],
      ['KeyD', BUTTON_ROLL_RIGHT],
    ];
    for (const [code, button] of cases) {
      const state = createInputState();
      expect(inputCodeDown(state, code)).toBe(true);
      const frame = sampleInput(state, 0, createInputFrame());
      expect(frame.buttons).toBe(button);
      expect(frame.buttons & ~BUTTON_MASK).toBe(0);
    }
  });

  it('W/S pitch and A/D yaw + roll', () => {
    const state = createInputState();
    const frame = createInputFrame();
    inputCodeDown(state, 'KeyW');
    inputCodeDown(state, 'KeyD');
    sampleInput(state, 0, frame);
    expect(frame.steerY).toBeCloseTo(DEFAULT_INPUT_OPTIONS.keyPitchSteer, 12);
    expect(frame.steerX).toBeCloseTo(DEFAULT_INPUT_OPTIONS.keyYawSteer, 12);
    expect(frame.buttons).toBe(BUTTON_ROLL_RIGHT);

    inputCodeUp(state, 'KeyW');
    inputCodeUp(state, 'KeyD');
    inputCodeDown(state, 'KeyS');
    inputCodeDown(state, 'KeyA');
    sampleInput(state, 1, frame);
    expect(frame.steerY).toBeCloseTo(-DEFAULT_INPUT_OPTIONS.keyPitchSteer, 12);
    expect(frame.steerX).toBeCloseTo(-DEFAULT_INPUT_OPTIONS.keyYawSteer, 12);
    expect(frame.buttons).toBe(BUTTON_ROLL_LEFT);
  });

  it('opposite keys cancel, invertKeyPitch flips W/S, and steer stays in range', () => {
    const state = createInputState(DEFAULT_BINDINGS, { invertKeyPitch: true });
    const frame = createInputFrame();
    inputCodeDown(state, 'KeyW');
    sampleInput(state, 0, frame);
    expect(frame.steerY).toBeLessThan(0);
    inputCodeDown(state, 'KeyS');
    sampleInput(state, 1, frame);
    expect(frame.steerY).toBe(0);

    const full = createInputState(DEFAULT_BINDINGS, { keyYawSteer: 9 });
    inputMouseMove(full, RADIUS, 0);
    inputCodeDown(full, 'KeyD');
    expect(sampleInput(full, 0, frame).steerX).toBe(1);
  });

  it('reports the scoreboard without a sim button', () => {
    const state = createInputState();
    inputCodeDown(state, 'Tab');
    const frame = sampleInput(state, 0, createInputFrame());
    expect(frame.buttons).toBe(0);
    expect(isActionActive(state, 'scoreboard')).toBe(true);
    inputCodeUp(state, 'Tab');
    sampleInput(state, 1, frame);
    expect(isActionActive(state, 'scoreboard')).toBe(false);
  });

  it('keeps a tap that starts and ends between two samples, for one frame', () => {
    const state = createInputState();
    const frame = createInputFrame();
    inputCodeDown(state, 'KeyQ');
    inputCodeUp(state, 'KeyQ');
    expect(sampleInput(state, 0, frame).buttons).toBe(BUTTON_DODGE_LEFT);
    expect(sampleInput(state, 1, frame).buttons).toBe(0);
  });

  it('holds an action while any of its keys is down', () => {
    const state = createInputState();
    const frame = createInputFrame();
    inputCodeDown(state, 'ShiftLeft');
    inputCodeDown(state, 'ShiftRight');
    inputCodeUp(state, 'ShiftLeft');
    sampleInput(state, 0, frame);
    expect(sampleInput(state, 1, frame).buttons).toBe(BUTTON_BOOST);
    inputCodeUp(state, 'ShiftRight');
    sampleInput(state, 2, frame);
    expect(sampleInput(state, 3, frame).buttons).toBe(0);
  });

  it('ignores unbound codes', () => {
    const state = createInputState();
    expect(inputCodeDown(state, 'KeyP')).toBe(false);
    expect(inputCodeUp(state, 'KeyP')).toBe(false);
    expect(isCodeBound(state, 'KeyP')).toBe(false);
    expect(isCodeBound(state, 'Space')).toBe(true);
    expect(sampleInput(state, 0, createInputFrame()).buttons).toBe(0);
  });

  it('releases everything on demand', () => {
    const state = createInputState();
    const frame = createInputFrame();
    inputCodeDown(state, 'Space');
    inputCodeDown(state, 'Mouse0');
    inputMouseMove(state, 50, 0);
    releaseAllInput(state);
    expect(sampleInput(state, 0, frame).buttons).toBe(0);
    expect(state.reticleX).toBeGreaterThan(0);
    // The key is physically still down, but only a new keydown counts.
    inputCodeUp(state, 'Mouse0');
    expect(sampleInput(state, 1, frame).buttons).toBe(0);
    clearInputState(state);
    expect(state.reticleX).toBe(0);
  });

  it('follows a rebind and drops held keys when the table changes', () => {
    const state = createInputState();
    const frame = createInputFrame();
    inputCodeDown(state, 'Space');
    setInputBindings(state, rebindAction(DEFAULT_BINDINGS, 'flap', 0, 'KeyV'));
    expect(sampleInput(state, 0, frame).buttons).toBe(0);
    expect(inputCodeDown(state, 'Space')).toBe(false);
    inputCodeDown(state, 'KeyV');
    expect(sampleInput(state, 1, frame).buttons).toBe(BUTTON_FLAP);
  });

  it('lets one code drive two actions when the table shares it', () => {
    const shared = rebindAction(DEFAULT_BINDINGS, 'boost', 0, 'Space', { steal: false });
    const state = createInputState(shared);
    inputCodeDown(state, 'Space');
    expect(sampleInput(state, 0, createInputFrame()).buttons).toBe(BUTTON_FLAP | BUTTON_BOOST);
  });

  it('writes into the frame it is given and returns it', () => {
    const state = createInputState();
    const frame = createInputFrame();
    expect(sampleInput(state, 3, frame)).toBe(frame);
  });

  it('recovers from a corrupted reticle', () => {
    const state = createInputState();
    state.reticleX = NaN;
    const frame = sampleInput(state, 0, createInputFrame());
    expect(frame.steerX).toBe(0);
    expect(frame.steerY).toBe(0);
    expect(state.reticleX).toBe(0);
  });
});
