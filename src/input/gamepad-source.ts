/**
 * The browser side of the gamepad: asks `navigator.getGamepads()`, picks the pad to read and
 * hands it to ./gamepad-state.ts, which holds all the logic and is tested without a browser.
 *
 * WHEN TO LOOK. Browsers only show a pad to a page after a button was pressed on it, and say so
 * with `gamepadconnected` (./input-controller.ts forwards that here as `watching = true`).
 * While no pad is known the list is not asked for every frame (each call makes new objects):
 * only on the first poll and then about once a second, which also finds a pad on a browser
 * that never sent the event. With a pad, the list is read once per poll and nothing is kept
 * from it but numbers.
 *
 * WHICH PAD. The one already in use stays in use. Otherwise the first connected pad, a
 * "standard" one before any other: laptops often list a sensor or a headset as a pad with no
 * known layout, and that must not win over the real controller that woke up after it.
 *
 * NO PAD API (an old browser, a page that is not a secure context, a permissions policy that
 * forbids it): everything here is a no-op.
 */
import type { InputBindings } from './bindings';
import { createGamepadState, pollGamepad } from './gamepad-state';
import type { GamepadLike, GamepadOptions, GamepadState } from './gamepad-state';
import type { InputState } from './input-state';

/** The part of `navigator` that is used; a real `Navigator` fits. */
export interface GamepadProvider {
  getGamepads?(): ArrayLike<GamepadLike | null | undefined>;
}

interface RumbleParams {
  startDelay: number;
  duration: number;
  weakMagnitude: number;
  strongMagnitude: number;
}

interface RumbleActuator {
  playEffect(type: 'dual-rumble', params: RumbleParams): unknown;
}

export interface GamepadSource {
  readonly state: GamepadState;
  /** null: no gamepad API here, or the browser refused it. */
  provider: GamepadProvider | null;
  /** A pad is (or may be) there: read the list on every poll. */
  watching: boolean;
  /** Polls left until the next look while not watching. */
  probeIn: number;
  /** Reused for every rumble, so shaking the pad allocates nothing here. */
  readonly rumbleParams: RumbleParams;
}

/** About a second of frames, two of sim ticks. */
const PROBE_INTERVAL_POLLS = 60;
/** Longest single rumble; a caller's mistake must not leave the pad buzzing. */
const MAX_RUMBLE_MS = 1000;

function ignoreRejection(): void {
  // A rumble that could not play (pad just unplugged, effect unsupported) is not an error.
}

function isRumbleActuator(value: unknown): value is RumbleActuator {
  return (
    typeof value === 'object' &&
    value !== null &&
    'playEffect' in value &&
    typeof value.playEffect === 'function'
  );
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

/**
 * Whether gamepads can be read here at all, for the settings page ("no gamepad support" is a
 * different message from "no gamepad yet"). False without the API (an old browser; Firefox on a
 * page that is not a secure context) and once the browser has refused a call.
 */
export function gamepadSourceSupported(source: GamepadSource): boolean {
  const provider = source.provider;
  return provider !== null && typeof provider.getGamepads === 'function';
}

/** `provider`: defaults to the real `navigator`; pass null for "no gamepads". */
export function createGamepadSource(
  provider?: GamepadProvider | null,
  bindings?: InputBindings,
  options?: Partial<GamepadOptions>,
): GamepadSource {
  const fallback: GamepadProvider | null = typeof navigator === 'undefined' ? null : navigator;
  return {
    state: createGamepadState(bindings, options),
    provider: provider === undefined ? fallback : provider,
    watching: false,
    probeIn: 1,
    rumbleParams: { startDelay: 0, duration: 0, weakMagnitude: 0, strongMagnitude: 0 },
  };
}

function readPads(source: GamepadSource): ArrayLike<GamepadLike | null | undefined> | null {
  const provider = source.provider;
  if (provider === null || typeof provider.getGamepads !== 'function') return null;
  try {
    return provider.getGamepads();
  } catch {
    // Forbidden for this page (SecurityError): asking again every frame would only throw again.
    source.provider = null;
    return null;
  }
}

/**
 * Reads the gamepad for this frame into `input`. `flight` and `nowMs`: see `pollGamepad`.
 * Allocation-free apart from what the browser itself makes inside `getGamepads()`.
 */
export function pollGamepadSource(
  source: GamepadSource,
  input: InputState,
  nowMs: number,
  flight: boolean,
): void {
  const gp = source.state;
  if (!source.watching) {
    if (--source.probeIn > 0) return;
    source.probeIn = PROBE_INTERVAL_POLLS;
  }
  const pads = readPads(source);
  let chosen: GamepadLike | null = null;
  let chosenIndex = -1;
  let chosenRank = -1;
  if (pads !== null) {
    const count = pads.length;
    for (let i = 0; i < count; i++) {
      const pad = pads[i];
      if (pad === null || pad === undefined || pad.connected === false) continue;
      // The pad in use keeps its place, except that a known layout beats an unknown one.
      const rank = (pad.mapping === 'standard' ? 2 : 0) + (i === gp.index ? 1 : 0);
      if (rank > chosenRank) {
        chosen = pad;
        chosenIndex = i;
        chosenRank = rank;
      }
    }
  }
  source.watching = chosen !== null;
  pollGamepad(gp, input, chosen, chosenIndex, nowMs, flight);
}

/**
 * Shakes the pad in use: `strength` 0..1 for `ms` milliseconds. A no-op unless
 * `options.rumble` is on, a pad is connected and the browser and the pad can do it
 * (`Gamepad.vibrationActuator`: Chromium and Safari today, not Firefox). Call it on an event
 * (damage taken), never every frame.
 */
export function rumbleGamepad(source: GamepadSource, strength: number, ms: number): void {
  const gp = source.state;
  if (!gp.options.rumble || !gp.connected || !(strength > 0) || !(ms > 0)) return;
  const pad = readPads(source)?.[gp.index];
  if (pad === null || pad === undefined) return;
  const actuator = pad.vibrationActuator;
  if (!isRumbleActuator(actuator)) return;
  const params = source.rumbleParams;
  params.duration = ms < MAX_RUMBLE_MS ? ms : MAX_RUMBLE_MS;
  params.strongMagnitude = strength < 1 ? strength : 1;
  params.weakMagnitude = params.strongMagnitude;
  try {
    const playing = actuator.playEffect('dual-rumble', params);
    if (isThenable(playing)) playing.catch(ignoreRejection);
  } catch {
    // An effect type this pad does not know throws on some browsers.
  }
}
