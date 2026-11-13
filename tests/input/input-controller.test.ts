/**
 * The DOM shell against hand-made fakes (the test environment is node: no real DOM). The fakes
 * (./fakes.ts) implement only what InputController touches.
 */
import { describe, expect, it } from 'vitest';
import { InputController } from '../../src/input';
import type { InputControllerOptions } from '../../src/input';
import { BUTTON_PRIMARY, createInputFrame } from '../../src/shared';
import { FakeCanvas, FakeDocument, FakeTarget } from './fakes';

interface Rig {
  doc: FakeDocument;
  win: FakeTarget;
  canvas: FakeCanvas;
  controller: InputController;
  lockChanges: boolean[];
  lockErrors: unknown[];
}

function createRig(options: InputControllerOptions = {}): Rig {
  const doc = new FakeDocument();
  const win = new FakeTarget();
  const canvas = new FakeCanvas(doc);
  const lockChanges: boolean[] = [];
  const lockErrors: unknown[] = [];
  const controller = new InputController(canvas as unknown as HTMLElement, {
    document: doc as unknown as Document,
    window: win as unknown as Window,
    onLockChange: (locked) => lockChanges.push(locked),
    onLockError: (error) => lockErrors.push(error),
    ...options,
  });
  return { doc, win, canvas, controller, lockChanges, lockErrors };
}

/** Lets promise callbacks (the rejected lock request and its retry) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function lockedRig(options: InputControllerOptions = {}): Rig {
  const rig = createRig(options);
  rig.canvas.dispatch('click');
  expect(rig.controller.locked).toBe(true);
  return rig;
}

describe('pointer lock', () => {
  it('requests raw input on a canvas click and reports the lock', () => {
    const rig = createRig();
    expect(rig.controller.locked).toBe(false);
    rig.canvas.dispatch('click');
    expect(rig.canvas.requests).toEqual([{ unadjustedMovement: true }]);
    expect(rig.controller.locked).toBe(true);
    expect(rig.controller.rawMouse).toBe(true);
    expect(rig.lockChanges).toEqual([true]);
  });

  it('falls back to a plain lock when raw input is unsupported, and remembers it', async () => {
    const rig = createRig();
    rig.canvas.behaviour = 'rawUnsupported';
    rig.canvas.dispatch('click');
    expect(rig.controller.locked).toBe(false);
    await flush();
    expect(rig.canvas.requests).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(rig.controller.locked).toBe(true);
    expect(rig.controller.rawMouse).toBe(false);
    expect(rig.lockErrors).toEqual([]);

    rig.doc.exitPointerLock();
    rig.canvas.dispatch('click');
    expect(rig.canvas.requests[2]).toBeUndefined();
    expect(rig.controller.locked).toBe(true);
  });

  it('reports a refused lock without retrying or throwing', async () => {
    const rig = createRig();
    rig.canvas.behaviour = 'deny';
    rig.canvas.dispatch('click');
    await flush();
    expect(rig.canvas.requests.length).toBe(1);
    expect(rig.controller.locked).toBe(false);
    expect(rig.lockErrors.length).toBe(1);
  });

  it('works with browsers whose requestPointerLock returns nothing', () => {
    const rig = createRig();
    rig.canvas.behaviour = 'legacy';
    rig.canvas.dispatch('click');
    expect(rig.controller.locked).toBe(true);
  });

  it('honours rawMouse: false', () => {
    const rig = createRig({ rawMouse: false });
    rig.canvas.dispatch('click');
    expect(rig.canvas.requests).toEqual([undefined]);
    expect(rig.controller.rawMouse).toBe(false);
  });

  it('does not request again while locked, or while disabled', () => {
    const rig = lockedRig();
    rig.canvas.dispatch('click');
    expect(rig.canvas.requests.length).toBe(1);

    rig.controller.setEnabled(false);
    expect(rig.controller.locked).toBe(false);
    expect(rig.doc.exitCalls).toBe(1);
    rig.canvas.dispatch('click');
    expect(rig.canvas.requests.length).toBe(1);
    rig.controller.setEnabled(true);
    rig.canvas.dispatch('click');
    expect(rig.controller.locked).toBe(true);
  });
});

describe('input while locked', () => {
  it('ignores keys, buttons and movement until locked', () => {
    const rig = createRig();
    const frame = createInputFrame();
    const key = rig.doc.dispatch('keydown', { code: 'Space', repeat: false });
    rig.doc.dispatch('mousedown', { button: 0 });
    rig.doc.dispatch('mousemove', { movementX: 80, movementY: 0 });
    rig.controller.sample(1, frame);
    expect(frame.buttons).toBe(0);
    expect(frame.steerX).toBe(0);
    expect(key.defaultPrevented).toBe(false);
  });

  it('reads keys, mouse buttons and movement once locked', () => {
    const rig = lockedRig();
    const frame = createInputFrame();
    rig.doc.dispatch('keydown', { code: 'Space', repeat: false });
    rig.doc.dispatch('mousedown', { button: 0 });
    rig.doc.dispatch('mousemove', { movementX: 120, movementY: -60 });
    rig.controller.sample(5, frame);
    expect(frame.tick).toBe(5);
    expect(frame.buttons).toBe(BUTTON_PRIMARY);
    expect(frame.steerX).toBeGreaterThan(0);
    expect(frame.steerY).toBeGreaterThan(0);
    expect(rig.controller.state.reticleX).toBeGreaterThan(0);

    rig.doc.dispatch('keyup', { code: 'Space' });
    rig.doc.dispatch('mouseup', { button: 0 });
    rig.controller.sample(6, frame);
    expect(frame.buttons).toBe(0);
  });

  it('prevents the default action of bound keys only', () => {
    const rig = lockedRig();
    expect(rig.doc.dispatch('keydown', { code: 'Space', repeat: false }).defaultPrevented).toBe(
      true,
    );
    expect(rig.doc.dispatch('keydown', { code: 'Tab', repeat: false }).defaultPrevented).toBe(true);
    expect(rig.doc.dispatch('keyup', { code: 'Tab' }).defaultPrevented).toBe(true);
    expect(rig.doc.dispatch('keydown', { code: 'F5', repeat: false }).defaultPrevented).toBe(false);
    expect(rig.doc.dispatch('keydown', { code: 'KeyP', repeat: false }).defaultPrevented).toBe(
      false,
    );
    expect(rig.doc.dispatch('contextmenu').defaultPrevented).toBe(true);
    expect(rig.doc.dispatch('mousedown', { button: 3 }).defaultPrevented).toBe(true);
  });

  it('ignores auto-repeat but still blocks its default action', () => {
    const rig = lockedRig();
    const frame = createInputFrame();
    rig.doc.dispatch('keydown', { code: 'KeyQ', repeat: false });
    rig.controller.sample(1, frame);
    rig.doc.dispatch('keyup', { code: 'KeyQ' });
    // A late repeat event after the release must not press the key again.
    const repeat = rig.doc.dispatch('keydown', { code: 'KeyQ', repeat: true });
    rig.controller.sample(2, frame);
    expect(frame.buttons).toBe(0);
    expect(repeat.defaultPrevented).toBe(true);
  });
});

describe('no stuck keys', () => {
  function holdKeys(rig: Rig): void {
    rig.doc.dispatch('keydown', { code: 'Space', repeat: false });
    rig.doc.dispatch('keydown', { code: 'ShiftLeft', repeat: false });
    rig.doc.dispatch('mousedown', { button: 0 });
  }

  it('releases everything and the lock on window blur', () => {
    const rig = lockedRig();
    holdKeys(rig);
    rig.win.dispatch('blur');
    expect(rig.controller.locked).toBe(false);
    expect(rig.controller.sample(1, createInputFrame()).buttons).toBe(0);
    expect(rig.lockChanges).toEqual([true, false]);
  });

  it('releases everything when the tab is hidden', () => {
    const rig = lockedRig();
    holdKeys(rig);
    rig.doc.visibilityState = 'hidden';
    rig.doc.dispatch('visibilitychange');
    expect(rig.controller.locked).toBe(false);
    expect(rig.controller.sample(1, createInputFrame()).buttons).toBe(0);
  });

  it('releases everything when the browser ends the lock (Esc)', () => {
    const rig = lockedRig();
    holdKeys(rig);
    rig.doc.dispatch('mousemove', { movementX: 100, movementY: 0 });
    rig.doc.pointerLockElement = null;
    rig.doc.dispatch('pointerlockchange');
    const frame = rig.controller.sample(1, createInputFrame());
    expect(frame.buttons).toBe(0);
    expect(frame.steerX).toBe(0);
    // The keyups arrive unlocked and are ignored; relocking starts clean.
    rig.canvas.dispatch('click');
    expect(rig.controller.sample(2, createInputFrame()).buttons).toBe(0);
  });

  it('ignores a lock taken by another element', () => {
    const rig = createRig();
    rig.doc.pointerLockElement = {};
    rig.doc.dispatch('pointerlockchange');
    expect(rig.controller.locked).toBe(false);
  });
});

describe('unload guard and dispose', () => {
  it('asks before unloading only while locked', () => {
    const rig = createRig();
    expect(rig.win.dispatch('beforeunload').defaultPrevented).toBe(false);
    rig.canvas.dispatch('click');
    const event = rig.win.dispatch('beforeunload');
    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBe(true);

    const unguarded = lockedRig({ guardUnload: false });
    expect(unguarded.win.dispatch('beforeunload').defaultPrevented).toBe(false);
  });

  it('removes every listener and releases the lock on dispose', () => {
    const rig = lockedRig();
    expect(rig.doc.listenerCount()).toBeGreaterThan(0);
    rig.controller.dispose();
    expect(rig.doc.listenerCount()).toBe(0);
    expect(rig.win.listenerCount()).toBe(0);
    expect(rig.canvas.listenerCount()).toBe(0);
    expect(rig.doc.pointerLockElement).toBeNull();
    expect(rig.controller.locked).toBe(false);
    rig.controller.requestLock();
    expect(rig.canvas.requests.length).toBe(1);
  });
});
