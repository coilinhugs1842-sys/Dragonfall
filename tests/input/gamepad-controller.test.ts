/**
 * The gamepad through InputController, against a fake `navigator.getGamepads` and the fake DOM
 * of ./fakes.ts. This covers the wiring (when the list is read, focus, enable, disconnect,
 * rumble calls); it cannot show how a real browser and a real controller behave.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GAMEPAD_BINDINGS, InputController, rebindAction } from '../../src/input';
import type { InputControllerOptions } from '../../src/input';
import {
  BUTTON_BOOST,
  BUTTON_FLAP,
  BUTTON_PRIMARY,
  BUTTON_UTILITY,
  createInputFrame,
} from '../../src/shared';
import { FakeCanvas, FakeDocument, FakeNavigator, FakePad, FakeTarget, PAD } from './fakes';

interface Rig {
  doc: FakeDocument;
  win: FakeTarget;
  canvas: FakeCanvas;
  nav: FakeNavigator;
  controller: InputController;
}

function createRig(options: InputControllerOptions = {}, doc = new FakeDocument()): Rig {
  const win = new FakeTarget();
  const canvas = new FakeCanvas(doc);
  const nav = new FakeNavigator();
  const controller = new InputController(canvas as unknown as HTMLElement, {
    document: doc as unknown as Document,
    window: win as unknown as Window,
    navigator: nav,
    ...options,
  });
  return { doc, win, canvas, nav, controller };
}

/** Plugs a pad into slot 0 the way a browser reports it, and lets the controller see it at rest. */
function connect(rig: Rig, pad = new FakePad()): FakePad {
  rig.nav.pads = [pad];
  rig.win.dispatch('gamepadconnected', { gamepad: { index: 0 } });
  rig.controller.poll();
  expect(rig.controller.gamepad.connected).toBe(true);
  return pad;
}

/** A rig whose pad is flying: A and LB held, the left stick pushed right. */
function flyingRig(options: InputControllerOptions = {}): Rig & { pad: FakePad } {
  const rig = createRig(options);
  const pad = connect(rig);
  pad.press(PAD.A).press(PAD.LB).left(0.9, 0);
  const frame = rig.controller.sample(0, createInputFrame());
  expect(frame.buttons).toBe(BUTTON_FLAP | BUTTON_BOOST);
  expect(frame.steerX).toBeGreaterThan(0.5);
  expect(rig.controller.gamepadFlying).toBe(true);
  return { ...rig, pad };
}

function expectNeutral(rig: Rig, tick = 1): void {
  const frame = rig.controller.sample(tick, createInputFrame());
  expect(frame.buttons).toBe(0);
  expect(frame.steerX).toBe(0);
  expect(frame.steerY).toBe(0);
  expect(rig.controller.state.reticleX).toBe(0);
  expect(rig.controller.state.reticleY).toBe(0);
}

/** Lets promise callbacks (a rejected rumble) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('flying by gamepad', () => {
  it('needs no pointer lock', () => {
    const rig = createRig();
    const pad = connect(rig);
    const frame = createInputFrame();
    // Connected, but nothing pressed yet: the prompt stays.
    expect(rig.controller.gamepadFlying).toBe(false);
    expect(rig.controller.flying).toBe(false);
    expect(rig.controller.activeDevice).toBe('keyboard');

    pad.press(PAD.A).left(0, 1);
    rig.controller.sample(1, frame);
    expect(frame.buttons).toBe(BUTTON_FLAP);
    expect(frame.steerY).toBeCloseTo(1, 12);
    expect(rig.controller.locked).toBe(false);
    expect(rig.controller.gamepadFlying).toBe(true);
    expect(rig.controller.flying).toBe(true);
    expect(rig.controller.activeDevice).toBe('gamepad');
    expect(rig.controller.gamepad.id).toContain('Fake Controller');
    expect(rig.controller.gamepad.standard).toBe(true);
    expect(rig.canvas.requests.length).toBe(0);
  });

  it('reports `flying` for the pointer lock too', () => {
    const rig = createRig();
    rig.canvas.dispatch('click');
    expect(rig.controller.locked).toBe(true);
    expect(rig.controller.flying).toBe(true);
    expect(rig.controller.gamepadFlying).toBe(false);
  });

  it('polls from sample(), so the game layer needs no extra call to fly', () => {
    const rig = createRig();
    const pad = new FakePad();
    rig.nav.pads = [pad];
    pad.press(PAD.RT, 1);
    // No event, no poll(): the first sample finds the pad and reads it.
    expect(rig.controller.sample(0, createInputFrame()).buttons).toBe(BUTTON_PRIMARY);
  });

  it('mixes with mouse and keyboard: actions are OR-ed, the last steering device steers', () => {
    const rig = createRig();
    const pad = connect(rig);
    const frame = createInputFrame();
    rig.canvas.dispatch('click');
    rig.doc.dispatch('keydown', { code: 'KeyF', repeat: false });
    pad.press(PAD.A).left(-0.9, 0);
    rig.controller.sample(1, frame);
    expect(frame.buttons).toBe(BUTTON_FLAP | BUTTON_UTILITY);
    expect(frame.steerX).toBeLessThan(-0.5);
    expect(rig.controller.state.steerDevice).toBe('gamepad');

    rig.doc.dispatch('mousemove', { movementX: 300, movementY: 0 });
    expect(rig.controller.state.steerDevice).toBe('keyboard');
    expect(rig.controller.activeDevice).toBe('keyboard');
    rig.controller.sample(2, frame);
    // The stick is still held left, but the mouse has the reticle now.
    expect(frame.steerX).toBeGreaterThan(0);
    expect(frame.buttons).toBe(BUTTON_FLAP | BUTTON_UTILITY);
    expect(rig.controller.flying).toBe(true);
  });

  it('keeps pad buttons held across a pointer-lock change', () => {
    const rig = flyingRig();
    rig.canvas.dispatch('click');
    expect(rig.controller.locked).toBe(true);
    expect(rig.controller.sample(1, createInputFrame()).buttons).toBe(BUTTON_FLAP | BUTTON_BOOST);
    rig.doc.exitPointerLock();
    expect(rig.controller.sample(2, createInputFrame()).buttons).toBe(BUTTON_FLAP | BUTTON_BOOST);
  });

  it('follows a rebind of the pad table', () => {
    const rig = createRig();
    const pad = connect(rig);
    rig.controller.setGamepadBindings(rebindAction(DEFAULT_GAMEPAD_BINDINGS, 'flap', 0, 'Pad5'));
    pad.press(PAD.A);
    expect(rig.controller.sample(1, createInputFrame()).buttons).toBe(0);
    pad.press(PAD.RB);
    expect(rig.controller.sample(2, createInputFrame()).buttons).toBe(BUTTON_FLAP);
  });

  it('takes the pad table and options at construction', () => {
    const rig = createRig({
      gamepadBindings: rebindAction(DEFAULT_GAMEPAD_BINDINGS, 'utility', 0, 'Pad5'),
      gamepad: { invertY: true },
    });
    const pad = connect(rig);
    pad.press(PAD.RB).left(0, 1);
    const frame = rig.controller.sample(1, createInputFrame());
    expect(frame.buttons).toBe(BUTTON_UTILITY);
    expect(frame.steerY).toBeCloseTo(-1, 12);
  });
});

describe('finding the pad', () => {
  it('asks for the list only now and then until a pad is announced', () => {
    const rig = createRig();
    rig.nav.pads = [null, null, null, null];
    rig.controller.poll();
    expect(rig.nav.calls).toBe(1);
    for (let i = 0; i < 59; i++) rig.controller.poll();
    expect(rig.nav.calls).toBe(1);
    rig.controller.poll();
    expect(rig.nav.calls).toBe(2);
    expect(rig.controller.gamepad.connected).toBe(false);
  });

  it('reads the list on every poll once a pad is there', () => {
    const rig = createRig();
    connect(rig);
    const before = rig.nav.calls;
    for (let i = 0; i < 10; i++) rig.controller.poll();
    expect(rig.nav.calls).toBe(before + 10);
  });

  it('sees a pad when the browser reveals it on the first button press', () => {
    const rig = createRig();
    rig.nav.pads = [null, null, null, null];
    const frame = createInputFrame();
    for (let tick = 0; tick < 5; tick++) rig.controller.sample(tick, frame);
    expect(rig.controller.gamepad.connected).toBe(false);
    expect(rig.controller.gamepad.id).toBe('');

    // The press that woke the pad is already down when the page first sees it.
    const pad = new FakePad();
    pad.press(PAD.A);
    rig.nav.pads = [pad, null, null, null];
    rig.win.dispatch('gamepadconnected', { gamepad: { index: 0 } });
    rig.controller.sample(5, frame);
    expect(frame.buttons).toBe(BUTTON_FLAP);
    expect(rig.controller.gamepadFlying).toBe(true);
  });

  it('prefers a pad with a known layout, then stays with the pad in use', () => {
    const rig = createRig();
    const sensor = new FakePad('Some HID sensor');
    sensor.mapping = '';
    const real = new FakePad('Real Controller');
    rig.nav.pads = [sensor, real];
    rig.win.dispatch('gamepadconnected', { gamepad: { index: 1 } });
    rig.controller.poll();
    expect(rig.controller.gamepad.index).toBe(1);
    expect(rig.controller.gamepad.id).toBe('Real Controller');

    // Another standard pad in a lower slot does not take over.
    rig.nav.pads = [new FakePad('Third'), real];
    rig.controller.poll();
    expect(rig.controller.gamepad.id).toBe('Real Controller');
  });

  it('uses an unknown layout when it is all there is, until a known one appears', () => {
    const rig = createRig();
    const odd = new FakePad('Odd Pad');
    odd.mapping = '';
    connect(rig, odd);
    expect(rig.controller.gamepad.standard).toBe(false);
    odd.press(PAD.A);
    expect(rig.controller.sample(0, createInputFrame()).buttons).toBe(BUTTON_FLAP);

    rig.nav.pads = [odd, new FakePad('Real Controller')];
    rig.controller.poll();
    expect(rig.controller.gamepad.id).toBe('Real Controller');
    expect(rig.controller.gamepad.standard).toBe(true);
    // The first pad's held button went with it.
    expect(rig.controller.sample(1, createInputFrame()).buttons).toBe(0);
  });

  it('skips pads the browser lists as disconnected', () => {
    const rig = createRig();
    const gone = new FakePad('Gone');
    gone.connected = false;
    rig.nav.pads = [gone];
    rig.controller.poll();
    expect(rig.controller.gamepad.connected).toBe(false);
  });
});

describe('no stuck pad input', () => {
  it('releases everything on window blur and reads nothing until focus returns', () => {
    const rig = flyingRig();
    rig.win.dispatch('blur');
    expect(rig.controller.gamepadFlying).toBe(false);
    expect(rig.controller.state.padActions).toBe(0);
    const calls = rig.nav.calls;
    expectNeutral(rig);
    expectNeutral(rig, 2);
    expect(rig.nav.calls).toBe(calls);

    rig.win.dispatch('focus');
    const frame = rig.controller.sample(3, createInputFrame());
    // The stick is a position and is live again; the buttons held through it all are not.
    expect(frame.steerX).toBeGreaterThan(0.5);
    expect(frame.buttons).toBe(0);
    expect(rig.controller.gamepadFlying).toBe(true);
    rig.pad.release(PAD.A).release(PAD.LB);
    rig.controller.sample(4, frame);
    rig.pad.press(PAD.A);
    expect(rig.controller.sample(5, frame).buttons).toBe(BUTTON_FLAP);
  });

  it('releases everything when the tab is hidden', () => {
    const rig = flyingRig();
    rig.doc.visibilityState = 'hidden';
    rig.doc.dispatch('visibilitychange');
    expect(rig.controller.gamepadFlying).toBe(false);
    expectNeutral(rig);
    rig.doc.visibilityState = 'visible';
    rig.doc.dispatch('visibilitychange');
    const frame = rig.controller.sample(2, createInputFrame());
    expect(frame.steerX).toBeGreaterThan(0.5);
    expect(frame.buttons).toBe(0);
  });

  it('releases everything the moment the pad is unplugged', () => {
    const rig = flyingRig();
    rig.nav.pads = [null];
    rig.win.dispatch('gamepaddisconnected', { gamepad: { index: 0 } });
    // Before any poll:
    expect(rig.controller.gamepad.connected).toBe(false);
    expect(rig.controller.gamepad.id).toBe('');
    expect(rig.controller.state.padActions).toBe(0);
    expect(rig.controller.gamepadFlying).toBe(false);
    expect(rig.controller.flying).toBe(false);
    expect(rig.controller.activeDevice).toBe('keyboard');
    expectNeutral(rig);
  });

  it('notices an unplugged pad without the event, on the next poll', () => {
    const rig = flyingRig();
    rig.nav.pads = [null];
    expectNeutral(rig);
    expect(rig.controller.gamepad.connected).toBe(false);
  });

  it('keeps the pad when a different one is unplugged', () => {
    const rig = flyingRig();
    rig.win.dispatch('gamepaddisconnected', { gamepad: { index: 3 } });
    expect(rig.controller.gamepad.connected).toBe(true);
    expect(rig.controller.sample(1, createInputFrame()).buttons).toBe(BUTTON_FLAP | BUTTON_BOOST);
  });

  it('does not read a pad on a page that never had the focus', () => {
    const doc = new FakeDocument();
    let focused = false;
    Object.assign(doc, { hasFocus: () => focused });
    const rig = createRig({}, doc);
    const pad = new FakePad();
    pad.press(PAD.A);
    rig.nav.pads = [pad];
    expect(rig.controller.sample(0, createInputFrame()).buttons).toBe(0);
    expect(rig.nav.calls).toBe(0);
    focused = true;
    rig.win.dispatch('focus');
    expect(rig.controller.sample(1, createInputFrame()).buttons).toBe(BUTTON_FLAP);
  });
});

describe('menus: enabled, pause, scoreboard, rebinding', () => {
  it('feeds no flight input while disabled and starts clean when enabled again', () => {
    const rig = flyingRig();
    rig.controller.setEnabled(false);
    expect(rig.controller.gamepadFlying).toBe(false);
    expectNeutral(rig);
    expectNeutral(rig, 2);

    rig.controller.setEnabled(true);
    const frame = rig.controller.sample(3, createInputFrame());
    // Still the pad player's dragon, at once: no prompt, the stick steers, but A and LB were
    // held through the menu and are not flight presses until pressed again.
    expect(rig.controller.gamepadFlying).toBe(true);
    expect(frame.steerX).toBeGreaterThan(0.5);
    expect(frame.buttons).toBe(0);
    rig.pad.release(PAD.LB);
    rig.controller.sample(4, frame);
    rig.pad.press(PAD.LB);
    expect(rig.controller.sample(5, frame).buttons).toBe(BUTTON_BOOST);
  });

  it('reports Menu once per press, also while disabled', () => {
    const rig = createRig();
    const pad = connect(rig);
    expect(rig.controller.consumePausePress()).toBe(false);
    pad.press(PAD.MENU);
    rig.controller.poll();
    expect(rig.controller.consumePausePress()).toBe(true);
    expect(rig.controller.consumePausePress()).toBe(false);

    // The game opens its menu and disables flight input; the same button closes the menu.
    rig.controller.setEnabled(false);
    rig.controller.poll();
    expect(rig.controller.consumePausePress()).toBe(false);
    pad.release(PAD.MENU);
    rig.controller.poll();
    pad.press(PAD.MENU);
    rig.controller.poll();
    expect(rig.controller.consumePausePress()).toBe(true);
    // Menu is never a flight action.
    rig.controller.setEnabled(true);
    expect(rig.controller.sample(0, createInputFrame()).buttons).toBe(0);
  });

  it('reports the scoreboard button while disabled (a spectator)', () => {
    const rig = createRig();
    const pad = connect(rig);
    rig.controller.setEnabled(false);
    expect(rig.controller.isGamepadActionHeld('scoreboard')).toBe(false);
    pad.press(PAD.VIEW);
    rig.controller.poll();
    expect(rig.controller.isGamepadActionHeld('scoreboard')).toBe(true);
    expect(rig.controller.isGamepadActionHeld('flap')).toBe(false);
    // Pressing buttons in a menu does not make the pad "the device that flies".
    expect(rig.controller.activeDevice).toBe('keyboard');
    pad.release(PAD.VIEW);
    rig.controller.poll();
    expect(rig.controller.isGamepadActionHeld('scoreboard')).toBe(false);
  });

  it('hands a pressed button to the rebind capture as a code', () => {
    const rig = createRig();
    const pad = connect(rig);
    rig.controller.setEnabled(false);
    expect(rig.controller.consumeGamepadPress()).toBeUndefined();
    pad.press(PAD.RB);
    rig.controller.poll();
    expect(rig.controller.consumeGamepadPress()).toBe('Pad5');
    rig.controller.poll();
    expect(rig.controller.consumeGamepadPress()).toBeUndefined();
  });
});

describe('rumble', () => {
  interface PlayedEffect {
    type: string;
    params: object;
    duration: number;
    strong: number;
    weak: number;
  }

  function actuator(result: () => unknown = () => Promise.resolve('complete')): {
    played: PlayedEffect[];
    playEffect(type: string, params: Record<string, number>): unknown;
  } {
    const played: PlayedEffect[] = [];
    return {
      played,
      playEffect(type: string, params: Record<string, number>): unknown {
        played.push({
          type,
          params,
          duration: params.duration ?? NaN,
          strong: params.strongMagnitude ?? NaN,
          weak: params.weakMagnitude ?? NaN,
        });
        return result();
      },
    };
  }

  it('is off until the option is switched on', () => {
    const rig = flyingRig();
    const motor = actuator();
    rig.pad.vibrationActuator = motor;
    rig.controller.rumble(1, 200);
    expect(motor.played.length).toBe(0);
    rig.controller.gamepad.options.rumble = true;
    rig.controller.rumble(0.6, 200);
    expect(motor.played.length).toBe(1);
    expect(motor.played[0]).toMatchObject({ type: 'dual-rumble', duration: 200, strong: 0.6 });
    expect(motor.played[0]?.weak).toBe(0.6);
  });

  it('clamps strength and length and reuses one parameter object', () => {
    const rig = flyingRig({ gamepad: { rumble: true } });
    const motor = actuator();
    rig.pad.vibrationActuator = motor;
    rig.controller.rumble(7, 60_000);
    rig.controller.rumble(0.2, 50);
    expect(motor.played[0]).toMatchObject({ duration: 1000, strong: 1 });
    expect(motor.played[1]).toMatchObject({ duration: 50, strong: 0.2 });
    expect(motor.played[1]?.params).toBe(motor.played[0]?.params);
    // Nothing to play.
    rig.controller.rumble(0, 100);
    rig.controller.rumble(0.5, 0);
    rig.controller.rumble(NaN, NaN);
    expect(motor.played.length).toBe(2);
  });

  it('only shakes the pad of a player who flies with it', () => {
    const rig = createRig({ gamepad: { rumble: true } });
    const pad = connect(rig);
    const motor = actuator();
    pad.vibrationActuator = motor;
    // Connected but lying on the desk: the player uses mouse and keyboard.
    rig.controller.rumble(1, 100);
    expect(motor.played.length).toBe(0);
    pad.press(PAD.A);
    rig.controller.poll();
    rig.controller.rumble(1, 100);
    expect(motor.played.length).toBe(1);
    rig.win.dispatch('blur');
    rig.controller.rumble(1, 100);
    expect(motor.played.length).toBe(1);
  });

  it('is a no-op where the pad or the browser cannot rumble', async () => {
    const rig = flyingRig({ gamepad: { rumble: true } });
    for (const unsupported of [undefined, null, {}, { playEffect: 'yes' }, 7]) {
      rig.pad.vibrationActuator = unsupported;
      expect(() => rig.controller.rumble(1, 100)).not.toThrow();
    }
    rig.pad.vibrationActuator = actuator(() => {
      throw new Error('unknown effect');
    });
    expect(() => rig.controller.rumble(1, 100)).not.toThrow();
    // A rejected effect must not surface as an unhandled rejection (vitest fails on those).
    rig.pad.vibrationActuator = actuator(() => Promise.reject(new Error('pad unplugged')));
    expect(() => rig.controller.rumble(1, 100)).not.toThrow();
    rig.pad.vibrationActuator = actuator(() => undefined);
    expect(() => rig.controller.rumble(1, 100)).not.toThrow();
    await flush();
  });
});

describe('without a usable gamepad API', () => {
  it('does nothing when there is no navigator or no getGamepads', () => {
    for (const navigator of [null, {}]) {
      const rig = createRig({ navigator });
      rig.win.dispatch('gamepadconnected', { gamepad: { index: 0 } });
      const frame = rig.controller.sample(0, createInputFrame());
      expect(frame.buttons).toBe(0);
      expect(rig.controller.gamepad.connected).toBe(false);
      expect(rig.controller.gamepadFlying).toBe(false);
      expect(rig.controller.consumePausePress()).toBe(false);
      expect(() => rig.controller.rumble(1, 100)).not.toThrow();
    }
  });

  it('stops asking after the browser refuses once', () => {
    let calls = 0;
    const rig = createRig({
      navigator: {
        getGamepads(): never {
          calls++;
          throw Object.assign(new Error('blocked by permissions policy'), {
            name: 'SecurityError',
          });
        },
      },
    });
    rig.win.dispatch('gamepadconnected', { gamepad: { index: 0 } });
    const frame = createInputFrame();
    expect(() => {
      for (let tick = 0; tick < 200; tick++) rig.controller.sample(tick, frame);
    }).not.toThrow();
    expect(calls).toBe(1);
  });

  it('survives a gamepad event with no pad in it', () => {
    const rig = flyingRig();
    expect(() => rig.win.dispatch('gamepaddisconnected')).not.toThrow();
    expect(() => rig.win.dispatch('gamepadconnected')).not.toThrow();
    expect(rig.controller.gamepad.connected).toBe(true);
  });
});

describe('dispose and allocation', () => {
  it('stops reading and removes the gamepad listeners on dispose', () => {
    const rig = flyingRig();
    expect(rig.win.listeners.get('gamepadconnected')?.size).toBe(1);
    rig.controller.dispose();
    expect(rig.win.listenerCount()).toBe(0);
    expect(rig.doc.listenerCount()).toBe(0);
    const calls = rig.nav.calls;
    const frame = rig.controller.sample(1, createInputFrame());
    expect(frame.buttons).toBe(0);
    expect(rig.nav.calls).toBe(calls);
    expect(rig.controller.gamepadFlying).toBe(false);
  });

  it('keeps its state objects and tables over many polled frames', () => {
    const rig = flyingRig();
    const controller = rig.controller;
    const { state, gamepad } = controller;
    const tables = [gamepad.buttonActions, gamepad.buttonDown, gamepad.buttonBlocked];
    const lengths = tables.map((table) => table.length);
    const stateKeys = Object.keys(state).length;
    const padKeys = Object.keys(gamepad).length;
    const options = gamepad.options;
    const frame = createInputFrame();
    for (let i = 0; i < 300; i++) {
      rig.pad.press(i % 17, (i % 4) / 3).left(Math.sin(i), Math.cos(i * 0.3));
      controller.poll();
      expect(controller.sample(i, frame)).toBe(frame);
      controller.consumePausePress();
      controller.consumeGamepadPress();
      if (i % 60 === 0) rig.win.dispatch(i % 120 === 0 ? 'blur' : 'focus');
    }
    expect(controller.state).toBe(state);
    expect(controller.gamepad).toBe(gamepad);
    expect(gamepad.options).toBe(options);
    expect(gamepad.buttonActions).toBe(tables[0]);
    expect(gamepad.buttonDown).toBe(tables[1]);
    expect(gamepad.buttonBlocked).toBe(tables[2]);
    expect(tables.map((table) => table.length)).toEqual(lengths);
    expect(Object.keys(state).length).toBe(stateKeys);
    expect(Object.keys(gamepad).length).toBe(padKeys);
    expect(rig.nav.pads.length).toBe(1);
    expect(rig.pad.buttons.length).toBe(17);
    expect(rig.pad.axes.length).toBe(4);
  });
});
