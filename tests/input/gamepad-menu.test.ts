/**
 * The gamepad in the menus (src/input/gamepad-menu.ts): D-pad or stick steps, A, B. Read through
 * a real InputController over the fakes of ./fakes.ts, the way the game layer reads it.
 */
import { describe, expect, it } from 'vitest';
import { InputController, createGamepadMenuState, pollGamepadMenu } from '../../src/input';
import type { GamepadMenuCommand, GamepadMenuState } from '../../src/input';
import { FakeCanvas, FakeDocument, FakeNavigator, FakePad, FakeTarget, PAD } from './fakes';

interface Rig {
  controller: InputController;
  pad: FakePad;
  menu: GamepadMenuState;
  /** One rendered frame at `nowMs` with a menu in front (or not). */
  step(nowMs: number, active?: boolean): GamepadMenuCommand | null;
}

function createRig(): Rig {
  const doc = new FakeDocument();
  const win = new FakeTarget();
  const nav = new FakeNavigator();
  const controller = new InputController(new FakeCanvas(doc) as unknown as HTMLElement, {
    document: doc as unknown as Document,
    window: win as unknown as Window,
    navigator: nav,
  });
  // Menus: the controller is not feeding the flight.
  controller.setEnabled(false);
  const pad = new FakePad();
  nav.pads = [pad];
  win.dispatch('gamepadconnected', { gamepad: { index: 0 } });
  const menu = createGamepadMenuState();
  const step = (nowMs: number, active = true): GamepadMenuCommand | null => {
    controller.poll(nowMs);
    return pollGamepadMenu(menu, controller.gamepad, nowMs, active);
  };
  // Seen once at rest, as a pad is on the frame it connects.
  expect(step(0)).toBeNull();
  return { controller, pad, menu, step };
}

describe('pollGamepadMenu', () => {
  it('gives one command per press of A and B', () => {
    const rig = createRig();
    rig.pad.press(PAD.A);
    expect(rig.step(16)).toBe('accept');
    expect(rig.step(32)).toBeNull();
    expect(rig.step(1000)).toBeNull();
    rig.pad.release(PAD.A);
    expect(rig.step(1016)).toBeNull();
    rig.pad.press(PAD.B);
    expect(rig.step(1032)).toBe('back');
    rig.pad.release(PAD.B).press(PAD.A);
    expect(rig.step(1048)).toBe('accept');
  });

  it('steps with the D-pad and repeats while held, after a longer first pause', () => {
    const rig = createRig();
    rig.pad.press(PAD.DOWN);
    expect(rig.step(100)).toBe('down');
    expect(rig.step(200)).toBeNull();
    expect(rig.step(499)).toBeNull();
    expect(rig.step(500)).toBe('down');
    expect(rig.step(600)).toBeNull();
    expect(rig.step(640)).toBe('down');
    expect(rig.step(780)).toBe('down');
    rig.pad.release(PAD.DOWN);
    expect(rig.step(800)).toBeNull();
    expect(rig.step(5000)).toBeNull();
    rig.pad.press(PAD.UP);
    expect(rig.step(5016)).toBe('up');
    rig.pad.release(PAD.UP).press(PAD.LEFT);
    expect(rig.step(5032)).toBe('left');
    rig.pad.release(PAD.LEFT).press(PAD.RIGHT);
    expect(rig.step(5048)).toBe('right');
  });

  it('steps with the left stick, with hysteresis and no step from a small push', () => {
    const rig = createRig();
    rig.pad.left(0, -0.5);
    expect(rig.step(16)).toBeNull();
    rig.pad.left(0, -0.7);
    expect(rig.step(32)).toBe('down');
    // Wobbling back to 0.5 keeps it held (no second step, no release).
    rig.pad.left(0, -0.5);
    expect(rig.step(48)).toBeNull();
    rig.pad.left(0, -0.7);
    expect(rig.step(64)).toBeNull();
    rig.pad.left(0, 0);
    expect(rig.step(80)).toBeNull();
    rig.pad.left(0, 0.9);
    expect(rig.step(96)).toBe('up');
    rig.pad.left(0.9, 0.2);
    expect(rig.step(112)).toBe('right');
    rig.pad.left(-0.9, 0);
    expect(rig.step(128)).toBe('left');
  });

  it('ignores what is held when the menus take over until it was let go', () => {
    const rig = createRig();
    // Flying: the menu is not read; A (flap) is down and the stick is over as the menu opens.
    expect(rig.step(16, false)).toBeNull();
    rig.pad.press(PAD.A).left(0, -1);
    expect(rig.step(32, false)).toBeNull();
    expect(rig.step(48)).toBeNull();
    expect(rig.step(64)).toBeNull();
    expect(rig.step(2000)).toBeNull();
    rig.pad.release(PAD.A).left(0, 0);
    expect(rig.step(2016)).toBeNull();
    rig.pad.press(PAD.A);
    expect(rig.step(2032)).toBe('accept');
    rig.pad.release(PAD.A).left(0, -1);
    expect(rig.step(2048)).toBe('down');
  });

  it('prefers A over B over a direction, and is silent without a pad', () => {
    const rig = createRig();
    rig.pad.press(PAD.A).press(PAD.B).press(PAD.DOWN);
    expect(rig.step(16)).toBe('accept');
    const menu = createGamepadMenuState();
    const doc = new FakeDocument();
    const bare = new InputController(new FakeCanvas(doc) as unknown as HTMLElement, {
      document: doc as unknown as Document,
      window: new FakeTarget() as unknown as Window,
      navigator: new FakeNavigator(),
    });
    bare.poll(0);
    expect(pollGamepadMenu(menu, bare.gamepad, 0, true)).toBeNull();
    expect(menu.active).toBe(false);
  });
});
