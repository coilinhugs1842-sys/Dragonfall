/**
 * The cinematic beats around a match, without the DOM (T-5.4, T-5.6): when the intro may be
 * skipped, how opaque the scene-cut fade is, and how long the loading presentation stays up.
 * Pure and allocation-free, so the screen manager can ask every frame.
 */

import type { HudState, UiScreen } from '../../shared/ui';
import { OPACITY_STEPS, UNIT_STEPS } from '../hud/hud-model';

// --- Match intro ----------------------------------------------------------------------------------

/** The "Press Space to skip" hint: only while the flyby plays and this client may skip it. */
export function skipHintShown(hud: Readonly<HudState> | null): boolean {
  return hud !== null && hud.phase === 'intro' && hud.canSkipIntro;
}

/** Space or Enter (either Enter key). `code` is `KeyboardEvent.code`. */
export function isSkipKey(code: string): boolean {
  return code === 'Space' || code === 'Enter' || code === 'NumpadEnter';
}

/** One per screen manager: remembers that this intro's skip was already asked for. */
export interface SkipLatch {
  sent: boolean;
}

export function createSkipLatch(): SkipLatch {
  return { sent: false };
}

/**
 * Call on a skip key press. True when `match.skipIntro` should be sent now: the intro is
 * playing, this client may skip it, no menu is in front (`menuOpen`: the escape menu, the
 * settings or a session notice, where Space and Enter press buttons), and it was not already
 * sent for this intro. Latches, so holding or hammering the key sends one intent.
 */
export function takeSkip(
  latch: SkipLatch,
  screen: UiScreen,
  hud: Readonly<HudState> | null,
  menuOpen: boolean,
): boolean {
  if (latch.sent || menuOpen || screen !== 'match' || !skipHintShown(hud)) return false;
  latch.sent = true;
  return true;
}

/** Call every update: once the intro is over the latch is ready for the next match. */
export function rearmSkip(latch: SkipLatch, hud: Readonly<HudState> | null): void {
  if (latch.sent && (hud === null || hud.phase !== 'intro')) latch.sent = false;
}

// --- Scene-cut fade ---------------------------------------------------------------------------------

/**
 * Steps of the fade layer's opacity: 0.5 % each, fine enough that a slow fade does not band.
 * The layer looks its CSS value up in UNIT_STRINGS, so the two must stay the same size.
 */
export const FADE_STEPS = UNIT_STEPS;

/** 0..FADE_STEPS for `UiState.fade`. Absent, NaN and negatives are no fade. */
export function fadeStep(fade: number | undefined): number {
  if (fade === undefined || !(fade > 0)) return 0;
  if (fade >= 1) return FADE_STEPS;
  const step = Math.round(fade * FADE_STEPS);
  // A fade that has started is never drawn as nothing, nor an unfinished one as solid.
  return step < 1 ? 1 : step > FADE_STEPS - 1 ? FADE_STEPS - 1 : step;
}

// --- Loading ----------------------------------------------------------------------------------------

/** Once up, the loading presentation stays at least this long: no one-frame flash. */
export const LOADING_MIN_VISIBLE_MS = 600;
/** Then it fades out over this long. It appears at once (it covers a scene that is not ready). */
export const LOADING_FADE_OUT_MS = 300;
/** Looked up in OPACITY_STRINGS. */
export const LOADING_OPACITY_STEPS = OPACITY_STEPS;

/** Whether the loading presentation is up and how opaque. One mutable instance, refilled. */
export interface LoadingGate {
  visible: boolean;
  /** 0..LOADING_OPACITY_STEPS. */
  opacityStep: number;
  /** When it appeared and when loading stopped being asked for (-1 = still asked for). */
  shownAtMs: number;
  releasedAtMs: number;
}

export function createLoadingGate(): LoadingGate {
  return { visible: false, opacityStep: 0, shownAtMs: 0, releasedAtMs: -1 };
}

/**
 * Advances the gate. `wanted` = the state asks for loading this frame.
 * - wanted: up at full opacity, at once;
 * - no longer wanted: stays up until LOADING_MIN_VISIBLE_MS after it appeared, then fades out
 *   over LOADING_FADE_OUT_MS; asked for again meanwhile, it goes back to full without a blink.
 * A clock that runs backwards (a test, a suspended tab) is treated as time having passed.
 */
export function updateLoadingGate(gate: LoadingGate, wanted: boolean, nowMs: number): LoadingGate {
  if (wanted) {
    if (!gate.visible) {
      gate.visible = true;
      gate.shownAtMs = nowMs;
    }
    gate.releasedAtMs = -1;
    gate.opacityStep = LOADING_OPACITY_STEPS;
    return gate;
  }
  if (!gate.visible) return gate;
  if (gate.releasedAtMs < 0 || nowMs < gate.releasedAtMs) gate.releasedAtMs = nowMs;
  const minUntil = gate.shownAtMs + LOADING_MIN_VISIBLE_MS;
  const fadeFrom = minUntil > gate.releasedAtMs ? minUntil : gate.releasedAtMs;
  if (nowMs < gate.shownAtMs || nowMs >= fadeFrom + LOADING_FADE_OUT_MS) {
    gate.visible = false;
    gate.opacityStep = 0;
    return gate;
  }
  if (nowMs <= fadeFrom) {
    gate.opacityStep = LOADING_OPACITY_STEPS;
    return gate;
  }
  const left = 1 - (nowMs - fadeFrom) / LOADING_FADE_OUT_MS;
  const step = Math.ceil(left * LOADING_OPACITY_STEPS);
  gate.opacityStep = step < 1 ? 1 : step;
  return gate;
}

/** Whole percent 0..100 for the bar. NaN and negatives give 0. */
export function loadingPercent(progress: number | undefined): number {
  if (progress === undefined || !(progress > 0)) return 0;
  return progress >= 1 ? 100 : Math.round(progress * 100);
}
