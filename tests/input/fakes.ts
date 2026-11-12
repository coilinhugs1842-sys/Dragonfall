/**
 * Hand-made stand-ins for the browser objects the input module touches (the test environment is
 * node: no real DOM, no real gamepads). Each implements only what the module uses.
 */

export class FakeTarget {
  readonly listeners = new Map<string, Set<EventListenerObject>>();

  addEventListener(type: string, listener: EventListenerObject): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  /** Returns the event so a test can check `defaultPrevented`. */
  dispatch(type: string, props: Record<string, unknown> = {}): FakeEvent {
    const event = new FakeEvent(type, props);
    for (const listener of this.listeners.get(type) ?? []) {
      listener.handleEvent(event as unknown as Event);
    }
    return event;
  }
}

export class FakeEvent {
  defaultPrevented = false;
  returnValue: unknown = undefined;
  readonly type: string;
  [key: string]: unknown;

  constructor(type: string, props: Record<string, unknown>) {
    this.type = type;
    Object.assign(this, props);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

export type LockBehaviour = 'grant' | 'rawUnsupported' | 'deny' | 'legacy';

export class FakeDocument extends FakeTarget {
  pointerLockElement: unknown = null;
  visibilityState = 'visible';
  exitCalls = 0;

  exitPointerLock(): void {
    this.exitCalls++;
    this.pointerLockElement = null;
    this.dispatch('pointerlockchange');
  }
}

export class FakeCanvas extends FakeTarget {
  behaviour: LockBehaviour = 'grant';
  readonly requests: (PointerLockOptions | undefined)[] = [];

  constructor(private readonly doc: FakeDocument) {
    super();
  }

  requestPointerLock(options?: PointerLockOptions): Promise<void> | undefined {
    this.requests.push(options);
    const raw = options?.unadjustedMovement === true;
    if (this.behaviour === 'legacy') {
      this.grant();
      return undefined;
    }
    if (this.behaviour === 'deny') {
      return Promise.reject(Object.assign(new Error('denied'), { name: 'SecurityError' }));
    }
    if (this.behaviour === 'rawUnsupported' && raw) {
      return Promise.reject(Object.assign(new Error('no raw'), { name: 'NotSupportedError' }));
    }
    this.grant();
    return Promise.resolve();
  }

  private grant(): void {
    this.doc.pointerLockElement = this;
    this.doc.dispatch('pointerlockchange');
  }
}

/** Button indices of the standard gamepad mapping, by their Xbox names. */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
} as const;

export interface FakeButton {
  pressed: boolean;
  value: number;
}

/**
 * A gamepad as `navigator.getGamepads()` would return it. The same object is handed out on every
 * call (a browser makes new ones), which is the stricter case for "keeps no stale numbers".
 */
export class FakePad {
  connected = true;
  mapping = 'standard';
  axes: number[];
  buttons: (FakeButton | null)[];
  vibrationActuator: unknown = undefined;

  constructor(
    readonly id = 'Fake Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    buttonCount = 17,
    axisCount = 4,
  ) {
    this.axes = new Array<number>(axisCount).fill(0);
    this.buttons = [];
    for (let i = 0; i < buttonCount; i++) this.buttons.push({ pressed: false, value: 0 });
  }

  /** `value`: 1 for a digital button, anything in 0..1 for a trigger. */
  press(index: number, value = 1): this {
    const button = this.buttons[index];
    if (button) {
      button.value = value;
      // Browsers report `pressed` from a low threshold of their own.
      button.pressed = value > 0.12;
    }
    return this;
  }

  release(index: number): this {
    return this.press(index, 0);
  }

  /** Left stick, x right and y UP (the Gamepad API's own y points down). */
  left(x: number, yUp = 0): this {
    this.axes[0] = x;
    this.axes[1] = -yUp;
    return this;
  }

  /** Right stick, x right and y UP. */
  right(x: number, yUp = 0): this {
    this.axes[2] = x;
    this.axes[3] = -yUp;
    return this;
  }
}

export class FakeNavigator {
  pads: (FakePad | null)[] = [];
  calls = 0;

  getGamepads(): (FakePad | null)[] {
    this.calls++;
    return this.pads;
  }
}
