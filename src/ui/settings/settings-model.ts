/**
 * The settings panel without the DOM: which controls exist, how a setting maps to a slider
 * position and a caption, and how a control's new value maps to the UiIntent it raises. The panel
 * (./create-settings-panel.ts) is a thin layer of elements over these functions.
 *
 * Sliders work in whole numbers (percent, degrees) so their steps are exact; the functions here
 * convert to and from the units `GameSettings` stores.
 */

import { QUALITY_PRESETS } from '../../shared/quality';
import {
  MAX_LAN_HOST_LENGTH,
  MAX_TURN_FIELD_LENGTH,
  SETTINGS_LIMITS,
  SETTINGS_TABS,
  effectiveQuality,
  renderScaleCapFor,
  renderScaleCapFraction,
} from '../../shared/ui';
import type {
  FpsCap,
  GameSettings,
  QualityChoice,
  SettingsTab,
  SignalingMode,
  UiIntent,
} from '../../shared/ui';

export const SETTINGS_TAB_LABELS: Readonly<Record<SettingsTab, string>> = {
  video: 'Video',
  controls: 'Controls',
  audio: 'Audio',
  game: 'Game & network',
};

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value);
}

/** The tab `step` places along from `tab` (arrow keys on the tab list); wraps round. */
export function neighbourTab(tab: SettingsTab, step: number): SettingsTab {
  const count = SETTINGS_TABS.length;
  const index = SETTINGS_TABS.indexOf(tab);
  return SETTINGS_TABS[(((index + step) % count) + count) % count] ?? tab;
}

// --- Sliders ------------------------------------------------------------------------------------

export type RangeField =
  | 'renderScaleCap'
  | 'fovDeg'
  | 'cameraShake'
  | 'mouseSensitivity'
  | 'masterVolume'
  | 'sfxVolume'
  | 'musicVolume'
  | 'uiVolume'
  | 'uiScale';

export const RANGE_FIELDS: readonly RangeField[] = [
  'renderScaleCap',
  'fovDeg',
  'cameraShake',
  'mouseSensitivity',
  'masterVolume',
  'sfxVolume',
  'musicVolume',
  'uiVolume',
  'uiScale',
];

/** A slider's position and caption, in the slider's own whole-number units. */
export interface RangeView {
  min: number;
  max: number;
  step: number;
  value: number;
  text: string;
}

export function createRangeView(): RangeView {
  return { min: 0, max: 100, step: 1, value: 0, text: '' };
}

function percentRange(out: RangeView, limit: { min: number; max: number; step: number }): void {
  out.min = Math.round(limit.min * 100);
  out.max = Math.round(limit.max * 100);
  out.step = Math.max(1, Math.round(limit.step * 100));
}

function snap(value: number, out: RangeView): number {
  const stepped = out.min + Math.round((value - out.min) / out.step) * out.step;
  return stepped < out.min ? out.min : stepped > out.max ? out.max : stepped;
}

/** Fills `out` with where the slider for `field` stands under `settings`. */
export function rangeView(field: RangeField, settings: GameSettings, out: RangeView): RangeView {
  switch (field) {
    case 'renderScaleCap': {
      // The slider shows the real render scale between the preset's own bounds.
      const presetId = effectiveQuality(settings.quality);
      const preset = QUALITY_PRESETS[presetId];
      out.min = Math.round(preset.renderScaleMin * 100);
      out.max = Math.round(preset.renderScaleMax * 100);
      out.step = 5;
      out.value = snap(renderScaleCapFor(presetId, settings.renderScaleCap) * 100, out);
      out.text = `${out.value} %`;
      return out;
    }
    case 'fovDeg':
      out.min = SETTINGS_LIMITS.fovDeg.min;
      out.max = SETTINGS_LIMITS.fovDeg.max;
      out.step = SETTINGS_LIMITS.fovDeg.step;
      out.value = snap(settings.fovDeg, out);
      out.text = `${out.value}°`;
      return out;
    case 'mouseSensitivity':
      percentRange(out, SETTINGS_LIMITS.mouseSensitivity);
      out.value = snap(settings.mouseSensitivity * 100, out);
      out.text = `${(out.value / 100).toFixed(2)}×`;
      return out;
    case 'cameraShake':
      percentRange(out, SETTINGS_LIMITS.cameraShake);
      out.value = snap(settings.cameraShake * 100, out);
      out.text = out.value === 0 ? 'Off' : `${out.value} %`;
      return out;
    case 'uiScale':
      percentRange(out, SETTINGS_LIMITS.uiScale);
      out.value = snap(settings.uiScale * 100, out);
      out.text = `${out.value} %`;
      return out;
    default:
      percentRange(out, SETTINGS_LIMITS.volume);
      out.value = snap(settings[field] * 100, out);
      out.text = out.value === 0 ? 'Muted' : `${out.value} %`;
      return out;
  }
}

/** The caption for a slider position the player is dragging through (before it is applied). */
export function rangeText(field: RangeField, raw: number, settings: GameSettings): string {
  const view = rangeView(field, settingsWithRange(field, raw, settings), SCRATCH_VIEW);
  return view.text;
}

const SCRATCH_VIEW = createRangeView();

/** The setting value a slider position stands for. */
export function rangeSetting(field: RangeField, raw: number, settings: GameSettings): number {
  const value = Number.isFinite(raw) ? raw : 0;
  switch (field) {
    case 'renderScaleCap':
      return (
        Math.round(renderScaleCapFraction(effectiveQuality(settings.quality), value / 100) * 100) /
        100
      );
    case 'fovDeg':
      return value;
    default:
      return value / 100;
  }
}

function settingsWithRange(field: RangeField, raw: number, settings: GameSettings): GameSettings {
  return { ...settings, [field]: rangeSetting(field, raw, settings) };
}

export function rangeIntent(field: RangeField, raw: number, settings: GameSettings): UiIntent {
  return { type: 'settings.update', patch: { [field]: rangeSetting(field, raw, settings) } };
}

// --- Switches -----------------------------------------------------------------------------------

export type ToggleField =
  | 'dynamicResolution'
  | 'reduceMotion'
  | 'invertY'
  | 'boostToggle'
  | 'colorBlindMarkers'
  | 'showNetChip';

export const TOGGLE_FIELDS: readonly ToggleField[] = [
  'dynamicResolution',
  'reduceMotion',
  'invertY',
  'boostToggle',
  'colorBlindMarkers',
  'showNetChip',
];

export function toggleIntent(field: ToggleField, on: boolean): UiIntent {
  return { type: 'settings.update', patch: { [field]: on } };
}

// --- Selects ------------------------------------------------------------------------------------

export type SelectField = 'quality' | 'fpsCap' | 'signaling';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export const SELECT_OPTIONS: Readonly<Record<SelectField, readonly SelectOption[]>> = {
  quality: [
    { value: 'auto', label: 'Automatic' },
    { value: 'low', label: QUALITY_PRESETS.low.label },
    { value: 'medium', label: QUALITY_PRESETS.medium.label },
    { value: 'high', label: QUALITY_PRESETS.high.label },
  ],
  fpsCap: [
    { value: '0', label: 'Off (display rate)' },
    { value: '45', label: '45 fps' },
    { value: '30', label: '30 fps' },
  ],
  signaling: [
    { value: 'online', label: 'Online' },
    { value: 'lan', label: 'Local network' },
  ],
};

export function selectValue(field: SelectField, settings: GameSettings): string {
  return String(settings[field]);
}

/** Null for a value that is not one of the options (a tampered <select>). */
export function selectIntent(field: SelectField, value: string): UiIntent | null {
  if (!SELECT_OPTIONS[field].some((option) => option.value === value)) return null;
  switch (field) {
    case 'quality':
      return { type: 'settings.update', patch: { quality: value as QualityChoice } };
    case 'fpsCap':
      return { type: 'settings.update', patch: { fpsCap: Number(value) as FpsCap } };
    default:
      return { type: 'settings.update', patch: { signaling: value as SignalingMode } };
  }
}

/** What "Automatic" resolves to, for the hint under the preset. */
export function qualityHint(settings: GameSettings): string {
  const preset = QUALITY_PRESETS[effectiveQuality(settings.quality)];
  return settings.quality === 'auto'
    ? `Automatic is using ${preset.label}.`
    : `${preset.label}: resolution ${Math.round(preset.renderScaleMin * 100)}–${Math.round(
        preset.renderScaleMax * 100,
      )} %.`;
}

// --- Text ---------------------------------------------------------------------------------------

export type TextField = 'playerName' | 'lanHost';

export function textIntent(field: TextField, value: string): UiIntent {
  const cut = field === 'lanHost' ? value.trim().slice(0, MAX_LAN_HOST_LENGTH) : value.slice(0, 64);
  return { type: 'settings.update', patch: { [field]: cut } };
}

export type TurnProblem = '' | 'url';

export interface TurnFormResult {
  /** Null when the form is not in a state that can be applied yet. */
  readonly intent: UiIntent | null;
  readonly problem: TurnProblem;
}

const TURN_URL_PATTERN = /^turns?:[^\s]+$/i;

/**
 * The three relay fields as one patch. An empty URL means "no relay" (the other two are then
 * dropped); a URL that is not `turn:` / `turns:` raises nothing and reports the problem.
 */
export function turnIntent(url: string, username: string, credential: string): TurnFormResult {
  const trimmed = url.trim();
  if (trimmed === '') {
    return { intent: { type: 'settings.update', patch: { turn: null } }, problem: '' };
  }
  if (trimmed.length > MAX_TURN_FIELD_LENGTH || !TURN_URL_PATTERN.test(trimmed)) {
    return { intent: null, problem: 'url' };
  }
  return {
    intent: {
      type: 'settings.update',
      patch: {
        turn: {
          url: trimmed,
          username: username.slice(0, MAX_TURN_FIELD_LENGTH),
          credential: credential.slice(0, MAX_TURN_FIELD_LENGTH),
        },
      },
    },
    problem: '',
  };
}
