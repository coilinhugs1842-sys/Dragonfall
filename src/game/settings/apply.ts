/**
 * Settings -> the modules that act on them, and `settings.*` intents -> the store.
 *
 * `applySettings` is the one mapping from a `GameSettings` to calls on the renderer, camera,
 * input, audio, UI and transport. Those modules are handed in as a `SettingsTargets` of plain
 * callbacks (each optional), so this file imports none of them and is tested in node. It calls a
 * target only when one of the values it takes changed; pass `previous = null` to apply all.
 *
 * Call order matters in one place: the quality preset goes first, because
 * `GameRenderer.setPreset` resets the render-scale bounds that `setResolution` then narrows.
 */

import type { InputBindings } from '../../input/bindings';
import { QUALITY_PRESETS, effectiveQuality, renderScaleCapFor } from '../../shared';
import type {
  FpsCap,
  QualityPresetId,
  SettingsTab,
  SignalingMode,
  TurnSettings,
  UiIntent,
} from '../../shared';
import type { SettingsData } from './schema';
import type { SettingsStore } from './store';

export interface SettingsTargets {
  /** `renderer.setPreset(preset)`. `auto` has already been resolved. */
  setQuality?(preset: QualityPresetId): void;
  /**
   * Render-scale bounds for the dynamic-resolution scaler: `minScale` is the preset's floor,
   * `capScale` the player's ceiling (both absolute scales, e.g. 0.6 and 0.8). With `dynamic`
   * false the scale is pinned at `capScale`.
   */
  setResolution?(dynamic: boolean, minScale: number, capScale: number): void;
  /** 0 = follow the display. */
  setFrameCap?(fps: FpsCap): void;
  setCamera?(fovDeg: number, shake: number, reduceMotion: boolean): void;
  setInput?(sensitivity: number, invertY: boolean, boostToggle: boolean): void;
  setBindings?(bindings: InputBindings): void;
  /** The gamepad's feel: `InputController.gamepad.options`. */
  setGamepad?(
    sensitivity: number,
    invertY: boolean,
    deadZone: number,
    curveExponent: number,
    rumble: boolean,
  ): void;
  /** The gamepad's own rebind table: `InputController.setGamepadBindings`. */
  setGamepadBindings?(bindings: InputBindings): void;
  /** All 0..1. */
  setVolumes?(master: number, sfx: number, music: number, ui: number): void;
  setUi?(
    uiScale: number,
    colorBlindMarkers: boolean,
    showNetChip: boolean,
    reduceMotion: boolean,
  ): void;
  /** Used by the NEXT host / join; a live connection is not touched. `turn` holds a secret. */
  setTransport?(signaling: SignalingMode, lanHost: string, turn: TurnSettings | null): void;
  setPlayerName?(name: string): void;
}

export function applySettings(
  targets: SettingsTargets,
  next: SettingsData,
  previous: SettingsData | null,
): void {
  const s = next.settings;
  const p = previous === null ? null : previous.settings;
  const all = p === null;

  const preset = effectiveQuality(s.quality, s.autoQuality);
  const presetChanged = all || effectiveQuality(p.quality, p.autoQuality) !== preset;
  if (presetChanged) targets.setQuality?.(preset);
  if (
    presetChanged ||
    p.dynamicResolution !== s.dynamicResolution ||
    p.renderScaleCap !== s.renderScaleCap
  ) {
    targets.setResolution?.(
      s.dynamicResolution,
      QUALITY_PRESETS[preset].renderScaleMin,
      renderScaleCapFor(preset, s.renderScaleCap),
    );
  }
  if (all || p.fpsCap !== s.fpsCap) targets.setFrameCap?.(s.fpsCap);
  if (
    all ||
    p.fovDeg !== s.fovDeg ||
    p.cameraShake !== s.cameraShake ||
    p.reduceMotion !== s.reduceMotion
  ) {
    targets.setCamera?.(s.fovDeg, s.reduceMotion ? 0 : s.cameraShake, s.reduceMotion);
  }
  if (
    all ||
    p.mouseSensitivity !== s.mouseSensitivity ||
    p.invertY !== s.invertY ||
    p.boostToggle !== s.boostToggle
  ) {
    targets.setInput?.(s.mouseSensitivity, s.invertY, s.boostToggle);
  }
  if (previous === null || previous.bindings !== next.bindings) {
    targets.setBindings?.(next.bindings);
  }
  if (
    all ||
    p.gamepadSensitivity !== s.gamepadSensitivity ||
    p.gamepadInvertY !== s.gamepadInvertY ||
    p.gamepadDeadZone !== s.gamepadDeadZone ||
    p.gamepadCurve !== s.gamepadCurve ||
    p.gamepadRumble !== s.gamepadRumble
  ) {
    targets.setGamepad?.(
      s.gamepadSensitivity,
      s.gamepadInvertY,
      s.gamepadDeadZone,
      s.gamepadCurve,
      s.gamepadRumble,
    );
  }
  if (previous === null || previous.gamepadBindings !== next.gamepadBindings) {
    targets.setGamepadBindings?.(next.gamepadBindings);
  }
  if (
    all ||
    p.masterVolume !== s.masterVolume ||
    p.sfxVolume !== s.sfxVolume ||
    p.musicVolume !== s.musicVolume ||
    p.uiVolume !== s.uiVolume
  ) {
    targets.setVolumes?.(s.masterVolume, s.sfxVolume, s.musicVolume, s.uiVolume);
  }
  if (
    all ||
    p.uiScale !== s.uiScale ||
    p.colorBlindMarkers !== s.colorBlindMarkers ||
    p.showNetChip !== s.showNetChip ||
    p.reduceMotion !== s.reduceMotion
  ) {
    targets.setUi?.(s.uiScale, s.colorBlindMarkers, s.showNetChip, s.reduceMotion);
  }
  if (all || p.signaling !== s.signaling || p.lanHost !== s.lanHost || p.turn !== s.turn) {
    targets.setTransport?.(s.signaling, s.lanHost, s.turn);
  }
  if (all || p.playerName !== s.playerName) targets.setPlayerName?.(s.playerName);
}

/** Applies everything now and again on every change. Returns the unsubscribe. */
export function bindSettingsTargets(store: SettingsStore, targets: SettingsTargets): () => void {
  applySettings(targets, store.data, null);
  return store.subscribe((next, previous) => applySettings(targets, next, previous));
}

export interface SettingsIntentHooks {
  /** `settings.open`: show the panel; in a match also release the pointer and mute flight input. */
  open?(tab: SettingsTab | undefined): void;
  close?(): void;
  /** `settings.redetectDisplay`: `renderer.resolution.reset()` (docs/DECISIONS.md 16). */
  redetectDisplay?(): void;
  /** `settings.retestQuality`: run the automatic quality pick again (T-6.2). */
  retestQuality?(): void;
}

/**
 * Handles every `settings.*` intent. Returns false for any other intent, so it slots in front of
 * the game's own intent switch: `if (handleSettingsIntent(store, intent, hooks)) return;`.
 */
export function handleSettingsIntent(
  store: SettingsStore,
  intent: UiIntent,
  hooks: SettingsIntentHooks = {},
): boolean {
  switch (intent.type) {
    case 'settings.update':
      store.update(intent.patch);
      return true;
    case 'settings.reset':
      store.reset();
      hooks.redetectDisplay?.();
      return true;
    case 'settings.rebind':
      store.rebind(intent.action, intent.slot, intent.code, intent.swap, intent.device);
      return true;
    case 'settings.unbind':
      store.unbind(intent.action, intent.slot, intent.device);
      return true;
    case 'settings.resetBindings':
      store.resetBindings(intent.action, intent.device);
      return true;
    case 'settings.redetectDisplay':
      hooks.redetectDisplay?.();
      return true;
    case 'settings.retestQuality':
      hooks.retestQuality?.();
      return true;
    case 'settings.open':
      hooks.open?.(intent.tab);
      return true;
    case 'settings.close':
      store.flush();
      hooks.close?.();
      return true;
    default:
      return false;
  }
}

/** A `NameStore` for the title screen (`createUi(root, onIntent, { nameStore })`) on the store. */
export function createSettingsNameStore(store: SettingsStore): {
  load(): string;
  save(name: string): void;
} {
  return {
    load: () => store.settings.playerName,
    save: (name) => {
      store.update({ playerName: name });
    },
  };
}
