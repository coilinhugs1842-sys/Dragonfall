/**
 * The gamepad logic against plain fake pads (./fakes.ts): no browser, no `navigator`. What a real
 * controller reports (trigger travel, stick noise, a vendor's odd layout) is NOT covered here.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAMEPAD_BINDINGS,
  DEFAULT_GAMEPAD_OPTIONS,
  DEFAULT_INPUT_OPTIONS,
  buttonIsDown,
  consumeGamepadPause,
  consumeGamepadPress,
  createGamepadState,
  createInputState,
  inputCodeDown,
  inputCodeUp,
  inputMouseMove,
  isActionActive,
  pollGamepad,
  rebindAction,
  releaseGamepad,
  sampleInput,
  setGamepadBindings,
  stickReticleGain,
  stickSteerGain,
} from '../../src/input';
import type { GamepadLike, GamepadOptions, GamepadState, InputState } from '../../src/input';
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
  createInputFrame,
} from '../../src/shared';
import type { InputFrame } from '../../src/shared';
import { FakePad, PAD } from './fakes';

const DEAD = DEFAULT_GAMEPAD_OPTIONS.deadZone;
const CURVE = DEFAULT_GAMEPAD_OPTIONS.curveExponent;

interface Rig {
  input: InputState;
  gp: GamepadState;
  pad: FakePad;
  frame: InputFrame;
  /** One poll, `dtMs` after the last. */
  poll(dtMs?: number): void;
  /** One poll and one sampled frame, as the controller does per tick. */
  sample(dtMs?: number): InputFrame;
  now(): number;
}

/** A connected pad that has been seen once at rest, with flight input on. */
function createRig(options: Partial<GamepadOptions> = {}, pad = new FakePad()): Rig {
  const input = createInputState();
  const gp = createGamepadState(DEFAULT_GAMEPAD_BINDINGS, options);
  const frame = createInputFrame();
  let now = 1000;
  let tick = 0;
  const rig: Rig = {
    input,
    gp,
    pad,
    frame,
    poll(dtMs = 16): void {
      now += dtMs;
      pollGamepad(gp, input, pad, 0, now, true);
    },
    sample(dtMs = 16): InputFrame {
      rig.poll(dtMs);
      return sampleInput(input, tick++, frame);
    },
    now: () => now,
  };
  rig.poll();
  return rig;
}

describe('stick maths', () => {
  it('gives nothing inside the dead zone and starts at zero on its edge', () => {
    for (const m of [0, 0.01, 0.1, DEAD]) {
      expect(stickReticleGain(m, DEAD, 1)).toBe(0);
      expect(stickSteerGain(m, DEAD, 1, CURVE)).toBe(0);
    }
    const justOutside = DEAD + 0.001;
    expect(justOutside * stickReticleGain(justOutside, DEAD, 1)).toBeLessThan(0.002);
    expect(justOutside * stickSteerGain(justOutside, DEAD, 1, CURVE)).toBeLessThan(0.001);
  });

  it('is monotonic and reaches exactly 1 at full deflection', () => {
    let lastReticle = 0;
    let lastSteer = 0;
    for (let m = 0; m <= 1.0001; m += 0.005) {
      const reticle = m * stickReticleGain(m, DEAD, 1);
      const steer = m * stickSteerGain(m, DEAD, 1, CURVE);
      expect(reticle).toBeGreaterThanOrEqual(lastReticle);
      expect(steer).toBeGreaterThanOrEqual(lastSteer);
      // An exponent above 1 is finer than linear near the centre.
      expect(steer).toBeLessThanOrEqual(reticle + 1e-12);
      lastReticle = reticle;
      lastSteer = steer;
    }
    expect(1 * stickReticleGain(1, DEAD, 1)).toBeCloseTo(1, 12);
    expect(1 * stickSteerGain(1, DEAD, 1, CURVE)).toBeCloseTo(1, 12);
    // Halfway: the rescaled travel, then the curve.
    const travel = (0.5 - DEAD) / (1 - DEAD);
    expect(0.5 * stickReticleGain(0.5, DEAD, 1)).toBeCloseTo(travel, 12);
    expect(0.5 * stickSteerGain(0.5, DEAD, 1, CURVE)).toBeCloseTo(Math.pow(travel, CURVE), 12);
  });

  it('is radial: a diagonal is not faster than an axis', () => {
    // The corner of a square gate reports (1, 1): length 1.41.
    const corner = Math.SQRT2;
    const gain = stickSteerGain(corner, DEAD, 1, CURVE);
    expect(Math.hypot(1 * gain, 1 * gain)).toBeCloseTo(1, 12);
    const reticle = stickReticleGain(corner, DEAD, 1);
    expect(Math.hypot(reticle, reticle)).toBeCloseTo(1, 12);
    // The same length in any direction gives the same amount of steer.
    const g = stickSteerGain(0.6, DEAD, 1, CURVE);
    const axis = 0.6 * g;
    const diagonal = Math.hypot(0.6 * Math.SQRT1_2 * g, 0.6 * Math.SQRT1_2 * g);
    expect(diagonal).toBeCloseTo(axis, 12);
    // A round gate's diagonal (length 1) is exactly as fast as full deflection on one axis.
    expect(Math.hypot(Math.SQRT1_2, Math.SQRT1_2) * stickSteerGain(1, DEAD, 1, CURVE)).toBeCloseTo(
      1 * stickSteerGain(1, DEAD, 1, CURVE),
      12,
    );
  });

  it('scales the reach with sensitivity and never leaves the unit circle', () => {
    const travel = (0.5 - DEAD) / (1 - DEAD);
    expect(0.5 * stickReticleGain(0.5, DEAD, 2)).toBeCloseTo(travel * 2, 12);
    expect(0.9 * stickReticleGain(0.9, DEAD, 2)).toBeCloseTo(1, 12);
    expect(1 * stickReticleGain(1, DEAD, 0.5)).toBeCloseTo(0.5, 12);
    expect(1 * stickSteerGain(1, DEAD, 0.5, CURVE)).toBeCloseTo(Math.pow(0.5, CURVE), 12);
    expect(1 * stickReticleGain(1, DEAD, Infinity)).toBeCloseTo(1, 12);
  });

  it('survives bad parameters', () => {
    expect(stickSteerGain(NaN, DEAD, 1, CURVE)).toBe(0);
    expect(stickSteerGain(0.5, DEAD, NaN, CURVE)).toBe(0);
    expect(stickSteerGain(0.5, DEAD, 0, CURVE)).toBe(0);
    expect(stickSteerGain(0.5, DEAD, -1, CURVE)).toBe(0);
    expect(Number.isFinite(stickSteerGain(0.5, 7, 1, CURVE))).toBe(true);
    expect(0.5 * stickSteerGain(0.5, 0, 1, NaN)).toBeCloseTo(0.5, 12);
    expect(0.5 * stickSteerGain(0.5, NaN, 1, 1)).toBeCloseTo(0.5, 12);
  });
});

describe('button and trigger hysteresis', () => {
  it('presses at the press threshold and releases only at the release threshold', () => {
    expect(buttonIsDown(0.49, false, 0.5, 0.35)).toBe(false);
    expect(buttonIsDown(0.5, false, 0.5, 0.35)).toBe(true);
    expect(buttonIsDown(0.36, true, 0.5, 0.35)).toBe(true);
    expect(buttonIsDown(0.35, true, 0.5, 0.35)).toBe(false);
    // A digital button is 0 or 1.
    expect(buttonIsDown(1, false, 0.5, 0.35)).toBe(true);
    expect(buttonIsDown(0, true, 0.5, 0.35)).toBe(false);
  });

  it('falls back to the defaults for unusable thresholds', () => {
    expect(buttonIsDown(0.1, false, 0, 0)).toBe(false);
    expect(buttonIsDown(0.6, false, NaN, NaN)).toBe(true);
    // A release above the press threshold would chatter: it is pulled below.
    expect(buttonIsDown(0.45, true, 0.5, 0.9)).toBe(true);
    expect(buttonIsDown(0.3, true, 0.5, 0.9)).toBe(false);
  });

  it('does not flutter a trigger under a resting finger', () => {
    const rig = createRig();
    rig.pad.press(PAD.RT, 0.3);
    expect(rig.sample().buttons).toBe(0);
    rig.pad.press(PAD.RT, 0.49);
    expect(rig.sample().buttons).toBe(0);
    rig.pad.press(PAD.RT, 0.5);
    expect(rig.sample().buttons).toBe(BUTTON_PRIMARY);
    // Hovering between the two thresholds changes nothing, frame after frame.
    for (const value of [0.4, 0.45, 0.36, 0.48, 0.38]) {
      rig.pad.press(PAD.RT, value);
      expect(rig.sample().buttons).toBe(BUTTON_PRIMARY);
    }
    rig.pad.press(PAD.RT, 0.35);
    expect(rig.sample().buttons).toBe(0);
    rig.pad.press(PAD.RT, 0.45);
    expect(rig.sample().buttons).toBe(0);
  });

  it('reads a button that only reports `pressed`', () => {
    const rig = createRig();
    rig.pad.buttons[PAD.A] = { pressed: true, value: 0 };
    expect(rig.sample().buttons).toBe(BUTTON_FLAP);
  });
});

describe('buttons -> InputFrame', () => {
  it('maps every default button to its bit', () => {
    const cases: readonly (readonly [number, number])[] = [
      [PAD.LB, BUTTON_BOOST],
      [PAD.A, BUTTON_FLAP],
      [PAD.B, BUTTON_DIVE],
      [PAD.RT, BUTTON_PRIMARY],
      [PAD.LT, BUTTON_SECONDARY],
      [PAD.X, BUTTON_UTILITY],
      [PAD.Y, BUTTON_ULTIMATE],
      [PAD.LEFT, BUTTON_ROLL_LEFT],
      [PAD.RIGHT, BUTTON_ROLL_RIGHT],
      // No sim button: pitch keys, the scoreboard, the pause button, the unbound buttons.
      [PAD.UP, 0],
      [PAD.DOWN, 0],
      [PAD.VIEW, 0],
      [PAD.MENU, 0],
      [PAD.RB, 0],
      [PAD.LS, 0],
      [PAD.RS, 0],
      [PAD.HOME, 0],
    ];
    expect(cases.length).toBe(17);
    for (const [button, bits] of cases) {
      const rig = createRig();
      rig.pad.press(button);
      const frame = rig.sample();
      expect(frame.buttons).toBe(bits);
      expect(frame.buttons & ~BUTTON_MASK).toBe(0);
      rig.pad.release(button);
      rig.sample();
      expect(rig.sample().buttons).toBe(0);
    }
  });

  it('uses the D-pad as W/S and A/D', () => {
    const rig = createRig();
    rig.pad.press(PAD.UP).press(PAD.RIGHT);
    let frame = rig.sample();
    expect(frame.steerY).toBeCloseTo(DEFAULT_INPUT_OPTIONS.keyPitchSteer, 12);
    expect(frame.steerX).toBeCloseTo(DEFAULT_INPUT_OPTIONS.keyYawSteer, 12);
    rig.pad.release(PAD.UP).release(PAD.RIGHT).press(PAD.DOWN).press(PAD.LEFT);
    rig.sample();
    frame = rig.sample();
    expect(frame.steerY).toBeCloseTo(-DEFAULT_INPUT_OPTIONS.keyPitchSteer, 12);
    expect(frame.steerX).toBeCloseTo(-DEFAULT_INPUT_OPTIONS.keyYawSteer, 12);
  });

  it('reports the scoreboard (View) without a sim button', () => {
    const rig = createRig();
    rig.pad.press(PAD.VIEW);
    expect(rig.sample().buttons).toBe(0);
    expect(isActionActive(rig.input, 'scoreboard')).toBe(true);
    rig.pad.release(PAD.VIEW);
    rig.sample();
    expect(isActionActive(rig.input, 'scoreboard')).toBe(false);
  });

  it('reports Menu once per press as the pause button, never as an action', () => {
    const rig = createRig();
    expect(consumeGamepadPause(rig.gp, rig.now())).toBe(false);
    rig.pad.press(PAD.MENU);
    rig.poll();
    rig.poll();
    expect(rig.gp.actions).toBe(0);
    expect(consumeGamepadPause(rig.gp, rig.now())).toBe(true);
    expect(consumeGamepadPause(rig.gp, rig.now())).toBe(false);
    // Still held: no second press.
    rig.poll();
    expect(consumeGamepadPause(rig.gp, rig.now())).toBe(false);
    rig.pad.release(PAD.MENU);
    rig.poll();
    rig.pad.press(PAD.MENU);
    rig.poll();
    expect(consumeGamepadPause(rig.gp, rig.now())).toBe(true);
  });

  it('forgets a pause press nobody asked about', () => {
    const rig = createRig();
    rig.pad.press(PAD.MENU);
    rig.poll();
    rig.pad.release(PAD.MENU);
    rig.poll(2000);
    expect(consumeGamepadPause(rig.gp, rig.now())).toBe(false);
  });

  it('reports the last pressed button once, for rebinding', () => {
    const rig = createRig();
    expect(consumeGamepadPress(rig.gp, rig.now())).toBe(-1);
    rig.pad.press(PAD.RB);
    rig.poll();
    expect(consumeGamepadPress(rig.gp, rig.now())).toBe(PAD.RB);
    rig.poll();
    expect(consumeGamepadPress(rig.gp, rig.now())).toBe(-1);
  });

  it('keeps a tap between two samples for one frame', () => {
    const rig = createRig();
    rig.pad.press(PAD.A);
    rig.poll();
    rig.pad.release(PAD.A);
    rig.poll();
    expect(sampleInput(rig.input, 0, rig.frame).buttons).toBe(BUTTON_FLAP);
    expect(rig.sample().buttons).toBe(0);
  });

  it('is OR-ed with the keyboard and mouse buttons', () => {
    const rig = createRig();
    inputCodeDown(rig.input, 'Space');
    rig.pad.press(PAD.RT);
    expect(rig.sample().buttons).toBe(BUTTON_FLAP | BUTTON_PRIMARY);
    // The same action from both devices holds until both let go.
    rig.pad.press(PAD.A);
    rig.sample();
    inputCodeUp(rig.input, 'Space');
    expect(rig.sample().buttons).toBe(BUTTON_FLAP | BUTTON_PRIMARY);
    rig.pad.release(PAD.A).release(PAD.RT);
    rig.sample();
    expect(rig.sample().buttons).toBe(0);
  });

  it('flips the boost latch like the boost key when boost is a toggle', () => {
    const rig = createRig();
    rig.input.options.boostToggle = true;
    rig.pad.press(PAD.LB);
    expect(rig.sample().buttons).toBe(BUTTON_BOOST);
    rig.pad.release(PAD.LB);
    rig.sample();
    expect(rig.sample().buttons).toBe(BUTTON_BOOST);
    rig.pad.press(PAD.LB);
    expect(rig.sample().buttons).toBe(0);
  });

  it('follows a rebind and drops held buttons when the table changes', () => {
    const rig = createRig();
    rig.pad.press(PAD.A);
    expect(rig.sample().buttons).toBe(BUTTON_FLAP);
    setGamepadBindings(
      rig.gp,
      rig.input,
      rebindAction(DEFAULT_GAMEPAD_BINDINGS, 'flap', 0, 'Pad5'),
    );
    // A is unbound now, and RB was not pressed yet.
    expect(rig.sample().buttons).toBe(0);
    rig.pad.release(PAD.A).press(PAD.RB);
    expect(rig.sample().buttons).toBe(BUTTON_FLAP);
  });

  it('never lets a hand-edited table turn Menu into an action', () => {
    const rig = createRig();
    setGamepadBindings(rig.gp, rig.input, { ...DEFAULT_GAMEPAD_BINDINGS, flap: ['Pad9'] });
    rig.pad.press(PAD.MENU);
    expect(rig.sample().buttons).toBe(0);
  });
});

describe('left stick -> the reticle', () => {
  it('sets the reticle to the stick position and steers through the curve', () => {
    const rig = createRig();
    rig.pad.left(1, 0);
    let frame = rig.sample();
    expect(rig.input.steerDevice).toBe('gamepad');
    expect(rig.input.reticleX).toBeCloseTo(1, 12);
    expect(frame.steerX).toBeCloseTo(1, 12);
    expect(frame.steerY).toBeCloseTo(0, 12);

    rig.pad.left(0.5, 0);
    frame = rig.sample();
    const travel = (0.5 - DEAD) / (1 - DEAD);
    expect(rig.input.reticleX).toBeCloseTo(travel, 12);
    expect(frame.steerX).toBeCloseTo(Math.pow(travel, CURVE), 12);
  });

  it('climbs when the stick is pushed forward, and dives with invert-Y', () => {
    const rig = createRig();
    // Forward on a real pad is axes[1] = -1.
    rig.pad.axes[1] = -1;
    expect(rig.sample().steerY).toBeCloseTo(1, 12);
    expect(rig.input.reticleY).toBeCloseTo(1, 12);

    const inverted = createRig({ invertY: true });
    inverted.pad.axes[1] = -1;
    expect(inverted.sample().steerY).toBeCloseTo(-1, 12);
    expect(inverted.input.reticleY).toBeCloseTo(-1, 12);
  });

  it('returns to the centre at once when the stick is released', () => {
    const rig = createRig();
    rig.pad.left(0.9, 0.3);
    rig.sample();
    rig.pad.left(0, 0);
    const frame = rig.sample();
    expect(frame.steerX).toBe(0);
    expect(frame.steerY).toBe(0);
    expect(rig.input.reticleX).toBe(0);
    expect(rig.input.reticleY).toBe(0);
  });

  it('does not ease the reticle between polls while the stick holds it', () => {
    const rig = createRig();
    rig.pad.left(0.7, 0);
    rig.sample();
    const held = rig.input.reticleX;
    // Catch-up ticks: several frames sampled from one poll.
    for (let tick = 0; tick < 10; tick++) sampleInput(rig.input, tick, rig.frame);
    expect(rig.input.reticleX).toBe(held);
  });

  it('applies the sensitivity like the mouse path: more reach per movement', () => {
    const rig = createRig({ sensitivity: 2 });
    rig.pad.left(0.5, 0);
    rig.sample();
    expect(rig.input.reticleX).toBeCloseTo(((0.5 - DEAD) / (1 - DEAD)) * 2, 12);
    rig.pad.left(1, 0);
    expect(rig.sample().steerX).toBeCloseTo(1, 12);
  });

  it('stays inside the unit circle in the corner of a square gate', () => {
    const rig = createRig();
    rig.pad.left(1, 1);
    const frame = rig.sample();
    expect(Math.hypot(frame.steerX, frame.steerY)).toBeCloseTo(1, 12);
    expect(Math.hypot(rig.input.reticleX, rig.input.reticleY)).toBeCloseTo(1, 12);
  });
});

describe('right stick -> fine pitch and yaw', () => {
  it('scales the same fine term as W/S and A/D', () => {
    const rig = createRig();
    rig.pad.right(0, 1);
    let frame = rig.sample();
    expect(frame.steerY).toBeCloseTo(DEFAULT_INPUT_OPTIONS.keyPitchSteer, 12);
    expect(frame.steerX).toBeCloseTo(0, 12);
    expect(frame.buttons).toBe(0);

    rig.pad.right(0.5, 0);
    frame = rig.sample();
    const travel = (0.5 - DEAD) / (1 - DEAD);
    expect(frame.steerX).toBeCloseTo(travel * DEFAULT_INPUT_OPTIONS.keyYawSteer, 12);
    expect(frame.buttons).toBe(0);
    // It does not take the reticle: that is the left stick's.
    expect(rig.input.steerDevice).toBe('keyboard');
    expect(rig.input.activeDevice).toBe('gamepad');
  });

  it('holds the roll of A/D at the far ends, with hysteresis', () => {
    const rig = createRig();
    rig.pad.right(1, 0);
    let frame = rig.sample();
    expect(frame.buttons).toBe(BUTTON_ROLL_RIGHT);
    expect(frame.steerX).toBeCloseTo(DEFAULT_INPUT_OPTIONS.keyYawSteer, 12);
    // Eased back a little: still rolling.
    rig.pad.right(0.75, 0);
    expect(rig.sample().buttons).toBe(BUTTON_ROLL_RIGHT);
    rig.pad.right(0.5, 0);
    rig.sample();
    expect(rig.sample().buttons).toBe(0);
    rig.pad.right(-1, 0);
    frame = rig.sample();
    expect(frame.buttons).toBe(BUTTON_ROLL_LEFT);
    expect(frame.steerX).toBeCloseTo(-DEFAULT_INPUT_OPTIONS.keyYawSteer, 12);
  });

  it('adds to the keys without exceeding one full key, and follows invert-Y', () => {
    const rig = createRig();
    inputCodeDown(rig.input, 'KeyW');
    rig.pad.right(0, 1);
    expect(rig.sample().steerY).toBeCloseTo(DEFAULT_INPUT_OPTIONS.keyPitchSteer, 12);

    const inverted = createRig({ invertY: true });
    inverted.pad.right(0, 1);
    expect(inverted.sample().steerY).toBeCloseTo(-DEFAULT_INPUT_OPTIONS.keyPitchSteer, 12);
  });

  it('gives nothing inside its dead zone', () => {
    const rig = createRig();
    rig.pad.right(0.1, -0.1);
    const frame = rig.sample();
    expect(frame.steerX).toBe(0);
    expect(frame.steerY).toBe(0);
    expect(rig.input.activeDevice).toBe('keyboard');
  });
});

describe('dodge: boost + flick', () => {
  /** Holds LB with the stick at rest, as a player about to dodge. */
  function boosting(options: Partial<GamepadOptions> = {}): Rig {
    const rig = createRig(options);
    rig.pad.press(PAD.LB);
    expect(rig.sample().buttons).toBe(BUTTON_BOOST);
    return rig;
  }

  it('dodges once per flick, to the side of the flick', () => {
    const rig = boosting();
    rig.pad.left(-1, 0);
    expect(rig.sample(33).buttons).toBe(BUTTON_BOOST | BUTTON_DODGE_LEFT);
    // The stick stays over: no second dodge, however long.
    for (let i = 0; i < 40; i++) expect(rig.sample().buttons).toBe(BUTTON_BOOST);

    rig.pad.left(0, 0);
    expect(rig.sample().buttons).toBe(BUTTON_BOOST);
    rig.pad.left(1, 0);
    expect(rig.sample(33).buttons).toBe(BUTTON_BOOST | BUTTON_DODGE_RIGHT);
    expect(rig.sample().buttons).toBe(BUTTON_BOOST);
  });

  it('follows a flick seen over several polls', () => {
    const rig = boosting();
    for (const x of [-0.3, -0.6, -0.9]) {
      rig.pad.left(x, 0);
      rig.poll(16);
    }
    expect(sampleInput(rig.input, 0, rig.frame).buttons).toBe(BUTTON_BOOST | BUTTON_DODGE_LEFT);
  });

  it('counts a swing from one side straight to the other', () => {
    const rig = boosting();
    rig.pad.left(0.6, 0);
    rig.sample(400);
    rig.pad.left(-1, 0);
    expect(rig.sample(33).buttons).toBe(BUTTON_BOOST | BUTTON_DODGE_LEFT);
  });

  it('needs the boost button', () => {
    const rig = createRig();
    rig.pad.left(-1, 0);
    expect(rig.sample(33).buttons).toBe(0);
    rig.pad.left(0, 0);
    rig.sample();
    rig.pad.left(1, 0);
    expect(rig.sample(33).buttons).toBe(0);
  });

  it('ignores a stick that was already over when boost went down', () => {
    const rig = createRig();
    rig.pad.left(1, 0);
    rig.sample();
    rig.pad.press(PAD.LB);
    for (let i = 0; i < 5; i++) expect(rig.sample().buttons).toBe(BUTTON_BOOST);
  });

  it('ignores a slow push: that is steering', () => {
    const rig = boosting();
    for (const x of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
      rig.pad.left(x, 0);
      expect(rig.sample(50).buttons).toBe(BUTTON_BOOST);
    }
  });

  it('counts any push to the edge when the window is 0', () => {
    const rig = boosting({ flickWindowMs: 0 });
    let seen = 0;
    for (const x of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
      rig.pad.left(x, 0);
      seen |= rig.sample(50).buttons;
    }
    expect(seen).toBe(BUTTON_BOOST | BUTTON_DODGE_RIGHT);
  });

  it('ignores a flick that is mostly up or down', () => {
    const rig = boosting();
    rig.pad.left(-0.8, 0.95);
    expect(rig.sample(33).buttons).toBe(BUTTON_BOOST);
  });

  it('can be unbound, or moved to a button', () => {
    const rig = boosting();
    let table = rebindAction(DEFAULT_GAMEPAD_BINDINGS, 'dodgeLeft', 0, 'Pad5');
    table = { ...table, dodgeRight: [] };
    setGamepadBindings(rig.gp, rig.input, table);
    rig.pad.release(PAD.LB);
    rig.sample();
    rig.pad.press(PAD.LB);
    rig.sample();
    rig.pad.left(-1, 0);
    expect(rig.sample(33).buttons).toBe(BUTTON_BOOST);
    rig.pad.left(0, 0);
    rig.sample();
    rig.pad.left(1, 0);
    expect(rig.sample(33).buttons).toBe(BUTTON_BOOST);
    rig.pad.press(PAD.RB);
    expect(rig.sample().buttons).toBe(BUTTON_BOOST | BUTTON_DODGE_LEFT);
  });
});

describe('which device steers', () => {
  it('starts with the keyboard and mouse and hands over when the stick moves', () => {
    const rig = createRig();
    expect(rig.input.activeDevice).toBe('keyboard');
    expect(rig.input.steerDevice).toBe('keyboard');
    inputMouseMove(rig.input, 100, 0);
    const mouseReticle = rig.input.reticleX;
    expect(rig.sample().steerX).toBeGreaterThan(0);
    expect(rig.input.steerDevice).toBe('keyboard');
    expect(mouseReticle).toBeGreaterThan(0);

    rig.pad.left(-0.8, 0);
    const frame = rig.sample();
    expect(rig.input.steerDevice).toBe('gamepad');
    expect(rig.input.activeDevice).toBe('gamepad');
    expect(frame.steerX).toBeLessThan(0);
    expect(rig.input.reticleX).toBeLessThan(0);
  });

  it('gives the reticle to the mouse the moment it moves, and does not take it back', () => {
    const rig = createRig();
    rig.pad.left(0.8, 0);
    rig.sample();
    const fromStick = rig.input.reticleX;
    inputMouseMove(rig.input, -20, 0);
    expect(rig.input.steerDevice).toBe('keyboard');
    expect(rig.input.activeDevice).toBe('keyboard');
    // The mouse carries on from where the stick had the reticle.
    expect(rig.input.reticleX).toBeLessThan(fromStick);
    expect(rig.input.reticleX).toBeGreaterThan(0);

    // The stick is still held where it was (with a little noise): the mouse keeps the reticle.
    for (const x of [0.8, 0.81, 0.79, 0.8]) {
      rig.pad.left(x, 0);
      rig.sample();
      expect(rig.input.steerDevice).toBe('keyboard');
    }
    // And the reticle eases back as it does for the mouse.
    expect(rig.input.reticleX).toBeLessThan(fromStick);

    rig.pad.left(0.4, 0);
    rig.sample();
    expect(rig.input.steerDevice).toBe('gamepad');
  });

  it('takes the reticle again after the stick was let go and pushed back to the same place', () => {
    const rig = createRig();
    rig.pad.left(0.8, 0);
    rig.sample();
    inputMouseMove(rig.input, -20, 0);
    rig.sample();
    rig.pad.left(0, 0);
    rig.sample();
    expect(rig.input.steerDevice).toBe('keyboard');
    rig.pad.left(0.8, 0);
    rig.sample();
    expect(rig.input.steerDevice).toBe('gamepad');
  });

  it('never lets a stick drifting inside the dead zone fight the mouse', () => {
    const rig = createRig();
    inputMouseMove(rig.input, 110, 0);
    const reticle = rig.input.reticleX;
    for (let i = 0; i < 50; i++) {
      rig.pad.left(0.1 * Math.sin(i), 0.1 * Math.cos(i * 1.3));
      rig.poll();
      expect(rig.input.steerDevice).toBe('keyboard');
      expect(rig.input.activeDevice).toBe('keyboard');
      expect(rig.input.reticleX).toBe(reticle);
    }
    expect(sampleInput(rig.input, 0, rig.frame).steerX).toBeGreaterThan(0);
  });

  it('ignores a worn stick that rests outside the dead zone until it is moved', () => {
    const pad = new FakePad();
    pad.left(0.3, 0);
    const rig = createRig({}, pad);
    for (let i = 0; i < 10; i++) {
      pad.left(0.3 + 0.02 * Math.sin(i), 0);
      expect(rig.sample().steerX).toBe(0);
    }
    expect(rig.input.steerDevice).toBe('keyboard');
    pad.left(-0.6, 0);
    expect(rig.sample().steerX).toBeLessThan(0);
    expect(rig.input.steerDevice).toBe('gamepad');
  });

  it('follows the last button for the active device, without moving the reticle', () => {
    const rig = createRig();
    inputMouseMove(rig.input, 50, 0);
    const reticle = rig.input.reticleX;
    rig.pad.press(PAD.A);
    rig.poll();
    expect(rig.input.activeDevice).toBe('gamepad');
    expect(rig.input.steerDevice).toBe('keyboard');
    expect(rig.input.reticleX).toBe(reticle);
    inputCodeDown(rig.input, 'KeyF');
    expect(rig.input.activeDevice).toBe('keyboard');
    // Holding the pad button is not new input.
    rig.poll();
    expect(rig.input.activeDevice).toBe('keyboard');
  });
});

describe('release, flight off and disconnect', () => {
  function flyingRig(): Rig {
    const rig = createRig();
    rig.pad.press(PAD.A).press(PAD.RT, 0.9).press(PAD.LB).left(0.9, 0.2).right(1, 0);
    const frame = rig.sample();
    expect(frame.buttons).toBe(BUTTON_FLAP | BUTTON_PRIMARY | BUTTON_BOOST | BUTTON_ROLL_RIGHT);
    expect(frame.steerX).toBeGreaterThan(0.5);
    return rig;
  }

  function expectNeutral(rig: Rig): void {
    const frame = sampleInput(rig.input, 0, rig.frame);
    expect(frame.buttons).toBe(0);
    expect(frame.steerX).toBe(0);
    expect(frame.steerY).toBe(0);
    expect(rig.input.reticleX).toBe(0);
    expect(rig.input.reticleY).toBe(0);
    expect(rig.input.padActions).toBe(0);
  }

  it('releases everything at once, like keys on blur', () => {
    const rig = flyingRig();
    releaseGamepad(rig.gp, rig.input);
    expectNeutral(rig);
    expect(isActionActive(rig.input, 'boost')).toBe(false);
  });

  it('counts a held button again only after it was let go; the sticks are live at once', () => {
    const rig = flyingRig();
    releaseGamepad(rig.gp, rig.input);
    let frame = rig.sample();
    // Buttons and the trigger are still physically down: ignored. The sticks are positions.
    expect(frame.buttons).toBe(BUTTON_ROLL_RIGHT);
    expect(frame.steerX).toBeGreaterThan(0.5);
    rig.pad.release(PAD.A).release(PAD.RT).release(PAD.LB).right(0, 0);
    rig.sample();
    rig.pad.press(PAD.A);
    frame = rig.sample();
    expect(frame.buttons).toBe(BUTTON_FLAP);
  });

  it('feeds nothing while flight input is off, but still follows the buttons', () => {
    const rig = flyingRig();
    pollGamepad(rig.gp, rig.input, rig.pad, 0, rig.now() + 16, false);
    expectNeutral(rig);
    rig.pad.release(PAD.A).press(PAD.VIEW).press(PAD.MENU);
    rig.input.activeDevice = 'keyboard';
    pollGamepad(rig.gp, rig.input, rig.pad, 0, rig.now() + 32, false);
    expectNeutral(rig);
    // A spectator's scoreboard and the pause button work; the HUD's device does not change.
    expect(rig.gp.actions).not.toBe(0);
    expect(isActionActive(rig.input, 'scoreboard')).toBe(false);
    expect(consumeGamepadPause(rig.gp, rig.now() + 32)).toBe(true);
    expect(rig.input.activeDevice).toBe('keyboard');

    // Flight comes back with View still down: not a flight press until it is pressed again.
    rig.poll(48);
    expect(isActionActive(rig.input, 'scoreboard')).toBe(false);
  });

  it('clears everything when the pad disconnects', () => {
    const rig = flyingRig();
    expect(rig.gp.connected).toBe(true);
    expect(rig.gp.id).toContain('Fake Controller');
    expect(rig.gp.standard).toBe(true);
    pollGamepad(rig.gp, rig.input, null, -1, rig.now() + 16, true);
    expectNeutral(rig);
    expect(rig.gp.connected).toBe(false);
    expect(rig.gp.index).toBe(-1);
    expect(rig.gp.id).toBe('');
    expect(rig.gp.actions).toBe(0);
    expect(rig.input.steerDevice).toBe('keyboard');
    expect(rig.input.activeDevice).toBe('keyboard');
    // Keys still work afterwards.
    inputCodeDown(rig.input, 'Space');
    expect(sampleInput(rig.input, 1, rig.frame).buttons).toBe(BUTTON_FLAP);
  });

  it('starts clean when another pad takes the place of the first', () => {
    const rig = flyingRig();
    const second = new FakePad('Second Pad');
    pollGamepad(rig.gp, rig.input, second, 1, rig.now() + 16, true);
    expectNeutral(rig);
    expect(rig.gp.index).toBe(1);
    expect(rig.gp.id).toBe('Second Pad');
  });
});

describe('non-standard and short pads', () => {
  it('reads a pad with an unknown layout by the same indices, and says so', () => {
    const pad = new FakePad('Generic USB Joystick');
    pad.mapping = '';
    const rig = createRig({}, pad);
    expect(rig.gp.standard).toBe(false);
    pad.press(PAD.A);
    expect(rig.sample().buttons).toBe(BUTTON_FLAP);
    pad.left(1, 0);
    const frame = rig.sample();
    expect(frame.buttons).toBe(BUTTON_FLAP);
    expect(frame.steerX).toBeCloseTo(1, 12);
  });

  it('ignores the axes of an unknown device until one of its buttons was pressed', () => {
    // A tilt sensor listed as a "gamepad": its axes wander and nobody ever presses a button.
    const pad = new FakePad('Some HID sensor', 4, 6);
    pad.mapping = '';
    const rig = createRig({}, pad);
    inputMouseMove(rig.input, 80, 0);
    for (let i = 0; i < 20; i++) {
      pad.left(Math.sin(i), Math.cos(i * 1.7)).right(Math.cos(i), Math.sin(i * 0.6));
      const frame = rig.sample();
      expect(frame.steerX).toBeGreaterThan(0);
      expect(frame.steerY).toBe(0);
      expect(frame.buttons).toBe(0);
    }
    expect(rig.input.steerDevice).toBe('keyboard');
    expect(rig.input.activeDevice).toBe('keyboard');

    // A real pad of an unknown make: the first button press wakes its sticks, measured from
    // where they are at that moment.
    pad.left(0.6, 0).right(0, 0).press(0);
    rig.sample();
    expect(rig.input.steerDevice).toBe('keyboard');
    pad.left(-0.6, 0);
    expect(rig.sample().steerX).toBeLessThan(0);
    expect(rig.input.steerDevice).toBe('gamepad');
  });

  it('does not let an axis that rests at -1 steer', () => {
    // Some pads put a trigger on an axis that idles at -1.
    const pad = new FakePad('Odd Pad');
    pad.mapping = '';
    pad.axes[0] = -1;
    const rig = createRig({}, pad);
    pad.press(PAD.A);
    for (let i = 0; i < 5; i++) expect(rig.sample().steerX).toBe(0);
    expect(rig.input.steerDevice).toBe('keyboard');
    expect(rig.frame.buttons).toBe(BUTTON_FLAP);
  });

  it('does not throw on missing buttons, axes or values', () => {
    const shapes: GamepadLike[] = [
      new FakePad('two buttons, one axis', 2, 1),
      new FakePad('nothing at all', 0, 0),
      new FakePad('many', 32, 10),
      { id: 'sparse', axes: [NaN, Infinity, -Infinity], buttons: [null, undefined, {}] },
      { id: 'odd values', axes: [5, -5], buttons: [{ value: NaN }, { value: -1 }, { value: 9 }] },
    ];
    for (const pad of shapes) {
      const input = createInputState();
      const gp = createGamepadState();
      const frame = createInputFrame();
      expect(() => {
        for (let i = 0; i < 4; i++) {
          pollGamepad(gp, input, pad, 0, 1000 + i * 16, true);
          sampleInput(input, i, frame);
        }
      }).not.toThrow();
      expect(Number.isFinite(frame.steerX)).toBe(true);
      expect(Number.isFinite(frame.steerY)).toBe(true);
      expect(Math.abs(frame.steerX)).toBeLessThanOrEqual(1);
      expect(frame.buttons & ~BUTTON_MASK).toBe(0);
      expect(gp.connected).toBe(true);
    }
  });

  it('uses what a short pad does have', () => {
    const pad = new FakePad('two buttons, two axes', 2, 2);
    const rig = createRig({}, pad);
    pad.press(PAD.A).press(PAD.B).left(0, -1);
    const frame = rig.sample();
    expect(frame.buttons).toBe(BUTTON_FLAP | BUTTON_DIVE);
    expect(frame.steerY).toBeCloseTo(-1, 12);
  });
});

describe('allocation', () => {
  it('keeps every state object and table across polls', () => {
    const rig = createRig();
    const { gp, input, frame } = rig;
    const tables = [gp.buttonActions, gp.buttonDown, gp.buttonBlocked, input.slotHeld];
    const lengths = tables.map((table) => table.length);
    const options = gp.options;
    const bindings = gp.bindings;
    const gpKeys = Object.keys(gp).length;
    const inputKeys = Object.keys(input).length;
    const padButtons = rig.pad.buttons.length;
    const padAxes = rig.pad.axes.length;

    for (let i = 0; i < 600; i++) {
      // Everything at once: buttons, triggers, both sticks, flicks, a release now and then.
      rig.pad.press(i % 17, (i % 5) / 4).left(Math.sin(i * 0.7), Math.cos(i * 0.4));
      rig.pad.right(Math.cos(i * 0.9), Math.sin(i * 0.2));
      if (i % 97 === 0) releaseGamepad(gp, input);
      if (i % 50 === 0) inputMouseMove(input, 3, -2);
      expect(rig.sample()).toBe(frame);
      consumeGamepadPause(gp, rig.now());
      consumeGamepadPress(gp, rig.now());
    }

    expect([gp.buttonActions, gp.buttonDown, gp.buttonBlocked, input.slotHeld]).toEqual(tables);
    expect(gp.buttonActions).toBe(tables[0]);
    expect(gp.buttonDown).toBe(tables[1]);
    expect(gp.buttonBlocked).toBe(tables[2]);
    expect(tables.map((table) => table.length)).toEqual(lengths);
    expect(gp.options).toBe(options);
    expect(gp.bindings).toBe(bindings);
    expect(Object.keys(gp).length).toBe(gpKeys);
    expect(Object.keys(input).length).toBe(inputKeys);
    // Nothing was written to the pad, and no reference to it is kept.
    expect(rig.pad.buttons.length).toBe(padButtons);
    expect(rig.pad.axes.length).toBe(padAxes);
    for (const value of Object.values(gp)) expect(value).not.toBe(rig.pad);
    for (const value of Object.values(gp)) expect(value).not.toBe(rig.pad.buttons);
    for (const value of Object.values(gp)) expect(value).not.toBe(rig.pad.axes);
  });
});
