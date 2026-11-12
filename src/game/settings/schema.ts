/**
 * The saved form of the player's settings, and the one place that turns untrusted data (the
 * text in localStorage, a `settings.update` patch) into a valid `GameSettings`.
 *
 * Saved under `SETTINGS_STORAGE_KEY` as one flat JSON object:
 *
 *   { "version": 3, "quality": "auto", "fpsCap": 0, ..., "bindings": { "boost": ["ShiftLeft"] },
 *     "gamepadBindings": { "boost": ["Pad4"] } }
 *
 * The setting fields stay at the top level under their Phase 0-2 names, so `stored-quality.ts`
 * (which reads `quality` at boot, before anything else exists) and the old `parseSettings` in
 * `storage.ts` keep working on a save of any version.
 *
 * Version 1 is what `saveSettings` wrote before T-3.9: the same object with no `version`, no
 * bindings and only the first ten fields. Version 2 (T-3.9) has no gamepad: no `gamepad*` fields
 * and no `gamepadBindings`. Migration is the same for both and needs no version check: "read
 * what is there, default the rest". Keys this version does not know are ignored, so a save
 * written by a newer build loads too. The rider name moves in from its own key
 * (`dragonfall.name`) when the save has none.
 *
 * Rules for every field: a wrong type falls back (to the default on load, to the current value
 * in a patch); a number outside its range is clamped and snapped to the slider step; a string is
 * cut to its limit and stripped of control characters. Nothing here throws and nothing is logged:
 * the TURN credential must never reach the console.
 */

import { BINDINGS_FORMAT_VERSION, cloneBindings, parseBindings } from '../../input/bindings';
import type { InputBindings } from '../../input/bindings';
import { parseGamepadBindings } from '../../input/gamepad-bindings';
import {
  DEFAULT_GAME_SETTINGS,
  MAX_LAN_HOST_LENGTH,
  MAX_PLAYER_NAME_LENGTH,
  MAX_TURN_FIELD_LENGTH,
  SETTINGS_LIMITS,
  isQualityPresetId,
} from '../../shared';
import type { GameSettings, NumberLimit, TurnSettings } from '../../shared';

export const SETTINGS_VERSION = 3;

/** Saved text longer than this is not parsed at all (a real save is about 1 KB). */
export const MAX_SETTINGS_TEXT_LENGTH = 32_768;

/** Setting names that hold a secret: never print their values. */
export const SENSITIVE_SETTING_KEYS: readonly (keyof GameSettings)[] = ['turn'];

export interface SettingsData {
  readonly settings: GameSettings;
  /** The keyboard and mouse table. */
  readonly bindings: InputBindings;
  /** The gamepad's own table (`Pad0`..`Pad16` and the two flick codes). */
  readonly gamepadBindings: InputBindings;
}

/** A plain object's own property, or undefined. Inherited keys (`__proto__` tricks) do not count. */
function own(source: object, key: string): unknown {
  return Object.hasOwn(source, key) ? Reflect.get(source, key) : undefined;
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clamps into the limit and snaps to its step; anything that is not a finite number = fallback. */
export function clampSetting(value: unknown, limit: NumberLimit, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = value < limit.min ? limit.min : value > limit.max ? limit.max : value;
  const snapped = limit.min + Math.round((clamped - limit.min) / limit.step) * limit.step;
  // Rounding removes the binary noise of the multiply (0.15000000000000002).
  const rounded = Math.round(snapped * 10_000) / 10_000;
  return rounded > limit.max ? limit.max : rounded;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Drops control characters and cuts to `max` code units. Not a string = null. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const head = value.length > max * 2 ? value.slice(0, max * 2) : value;
  let out = '';
  for (let i = 0; i < head.length && out.length < max; i++) {
    const code = head.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += head.charAt(i);
  }
  return out;
}

/** Host name, IPv4 or bracketed IPv6. Anything else ('http://…', spaces, a path) is refused. */
const LAN_HOST_PATTERN = /^[A-Za-z0-9.\-:[\]]*$/;

export function sanitizeLanHost(value: unknown, fallback: string): string {
  const text = cleanText(value, MAX_LAN_HOST_LENGTH);
  if (text === null) return fallback;
  const trimmed = text.trim();
  return LAN_HOST_PATTERN.test(trimmed) ? trimmed : fallback;
}

/** `turn:` or `turns:` followed by a host, with no white space. */
const TURN_URL_PATTERN = /^turns?:[^\s]+$/i;

export function isValidTurnUrl(url: string): boolean {
  return url.length <= MAX_TURN_FIELD_LENGTH && TURN_URL_PATTERN.test(url);
}

/** Null (no relay) for anything that is not an object with a usable `turn:` URL. */
export function sanitizeTurn(value: unknown): TurnSettings | null {
  if (!isRecord(value)) return null;
  const rawUrl = own(value, 'url');
  // An address is never cut short: a longer one is refused whole.
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_TURN_FIELD_LENGTH + 64) return null;
  const url = cleanText(rawUrl.trim(), MAX_TURN_FIELD_LENGTH + 1) ?? '';
  if (!isValidTurnUrl(url)) return null;
  return {
    url,
    username: cleanText(own(value, 'username'), MAX_TURN_FIELD_LENGTH) ?? '',
    credential: cleanText(own(value, 'credential'), MAX_TURN_FIELD_LENGTH) ?? '',
  };
}

/**
 * Control characters dropped, white space collapsed, trimmed, cut to MAX_PLAYER_NAME_LENGTH code
 * points (the same tidy-up the title screen does; the host sanitises again).
 */
export function sanitizePlayerName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const head = value.length > 256 ? value.slice(0, 256) : value;
  let out = '';
  let count = 0;
  let pendingSpace = false;
  for (const char of head) {
    const code = char.codePointAt(0) ?? 0;
    if (/\s/.test(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    // A lone surrogate (broken text) cannot be sent as UTF-8.
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const needed = pendingSpace ? 2 : 1;
    if (count + needed > MAX_PLAYER_NAME_LENGTH) break;
    if (pendingSpace) out += ' ';
    out += char;
    count += needed;
    pendingSpace = false;
  }
  return out;
}

/**
 * Builds a full, valid `GameSettings` from anything. A field that is missing from `source` or has
 * the wrong type takes its value from `base`: the defaults when loading, the current settings
 * when applying a patch. `turn` is the exception in a patch: an explicit invalid value clears it.
 */
export function sanitizeSettings(
  source: unknown,
  base: GameSettings = DEFAULT_GAME_SETTINGS,
): GameSettings {
  if (!isRecord(source)) return base;
  const quality = own(source, 'quality');
  const fpsCap = own(source, 'fpsCap');
  const signaling = own(source, 'signaling');
  // The automatic pick's result (T-6.2): a preset, or an explicit null for "not tested yet".
  const autoQuality = own(source, 'autoQuality');
  const volume = SETTINGS_LIMITS.volume;
  return {
    quality: quality === 'auto' || isQualityPresetId(quality) ? quality : base.quality,
    autoQuality:
      autoQuality === null || isQualityPresetId(autoQuality) ? autoQuality : base.autoQuality,
    fpsCap: fpsCap === 0 || fpsCap === 30 || fpsCap === 45 ? fpsCap : base.fpsCap,
    dynamicResolution: bool(own(source, 'dynamicResolution'), base.dynamicResolution),
    renderScaleCap: clampSetting(
      own(source, 'renderScaleCap'),
      SETTINGS_LIMITS.renderScaleCap,
      base.renderScaleCap,
    ),
    fovDeg: clampSetting(own(source, 'fovDeg'), SETTINGS_LIMITS.fovDeg, base.fovDeg),
    cameraShake: clampSetting(
      own(source, 'cameraShake'),
      SETTINGS_LIMITS.cameraShake,
      base.cameraShake,
    ),
    reduceMotion: bool(own(source, 'reduceMotion'), base.reduceMotion),
    masterVolume: clampSetting(own(source, 'masterVolume'), volume, base.masterVolume),
    musicVolume: clampSetting(own(source, 'musicVolume'), volume, base.musicVolume),
    sfxVolume: clampSetting(own(source, 'sfxVolume'), volume, base.sfxVolume),
    uiVolume: clampSetting(own(source, 'uiVolume'), volume, base.uiVolume),
    mouseSensitivity: clampSetting(
      own(source, 'mouseSensitivity'),
      SETTINGS_LIMITS.mouseSensitivity,
      base.mouseSensitivity,
    ),
    invertY: bool(own(source, 'invertY'), base.invertY),
    boostToggle: bool(own(source, 'boostToggle'), base.boostToggle),
    uiScale: clampSetting(own(source, 'uiScale'), SETTINGS_LIMITS.uiScale, base.uiScale),
    colorBlindMarkers: bool(own(source, 'colorBlindMarkers'), base.colorBlindMarkers),
    showNetChip: bool(own(source, 'showNetChip'), base.showNetChip),
    signaling: signaling === 'lan' || signaling === 'online' ? signaling : base.signaling,
    lanHost: sanitizeLanHost(own(source, 'lanHost'), base.lanHost),
    turn: Object.hasOwn(source, 'turn') ? sanitizeTurn(own(source, 'turn')) : base.turn,
    playerName: sanitizePlayerName(own(source, 'playerName'), base.playerName),
    gamepadSensitivity: clampSetting(
      own(source, 'gamepadSensitivity'),
      SETTINGS_LIMITS.gamepadSensitivity,
      base.gamepadSensitivity,
    ),
    gamepadInvertY: bool(own(source, 'gamepadInvertY'), base.gamepadInvertY),
    gamepadDeadZone: clampSetting(
      own(source, 'gamepadDeadZone'),
      SETTINGS_LIMITS.gamepadDeadZone,
      base.gamepadDeadZone,
    ),
    gamepadCurve: clampSetting(
      own(source, 'gamepadCurve'),
      SETTINGS_LIMITS.gamepadCurve,
      base.gamepadCurve,
    ),
    gamepadRumble: bool(own(source, 'gamepadRumble'), base.gamepadRumble),
  };
}

/** True when both hold the same values (`turn` compared by its three fields). */
export function settingsEqual(a: GameSettings, b: GameSettings): boolean {
  if (a === b) return true;
  const ta = a.turn;
  const tb = b.turn;
  const sameTurn =
    ta === tb ||
    (ta !== null &&
      tb !== null &&
      ta.url === tb.url &&
      ta.username === tb.username &&
      ta.credential === tb.credential);
  return (
    sameTurn &&
    a.quality === b.quality &&
    a.autoQuality === b.autoQuality &&
    a.fpsCap === b.fpsCap &&
    a.dynamicResolution === b.dynamicResolution &&
    a.renderScaleCap === b.renderScaleCap &&
    a.fovDeg === b.fovDeg &&
    a.cameraShake === b.cameraShake &&
    a.reduceMotion === b.reduceMotion &&
    a.masterVolume === b.masterVolume &&
    a.musicVolume === b.musicVolume &&
    a.sfxVolume === b.sfxVolume &&
    a.uiVolume === b.uiVolume &&
    a.mouseSensitivity === b.mouseSensitivity &&
    a.invertY === b.invertY &&
    a.boostToggle === b.boostToggle &&
    a.uiScale === b.uiScale &&
    a.colorBlindMarkers === b.colorBlindMarkers &&
    a.showNetChip === b.showNetChip &&
    a.signaling === b.signaling &&
    a.lanHost === b.lanHost &&
    a.playerName === b.playerName &&
    a.gamepadSensitivity === b.gamepadSensitivity &&
    a.gamepadInvertY === b.gamepadInvertY &&
    a.gamepadDeadZone === b.gamepadDeadZone &&
    a.gamepadCurve === b.gamepadCurve &&
    a.gamepadRumble === b.gamepadRumble
  );
}

/**
 * Reads saved text of any version. Never throws. `legacyName` is the rider name from its old
 * key; it is used only when the save carries no name of its own.
 */
export function parseSettingsData(
  text: string | null,
  legacyName: string | null = null,
): SettingsData {
  let parsed: unknown = null;
  if (typeof text === 'string' && text.length <= MAX_SETTINGS_TEXT_LENGTH) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const root = isRecord(parsed) ? parsed : {};
  let settings = sanitizeSettings(root);
  if (settings.playerName === '' && legacyName !== null) {
    const name = sanitizePlayerName(legacyName, '');
    if (name !== '') settings = { ...settings, playerName: name };
  }
  // The table goes through src/input's own reader, which drops unknown actions and reserved or
  // duplicate codes. It takes text, so the stored object is wrapped back into its format.
  const table = own(root, 'bindings');
  let bindings: InputBindings;
  try {
    bindings = parseBindings(
      isRecord(table)
        ? JSON.stringify({ version: BINDINGS_FORMAT_VERSION, bindings: table })
        : null,
    );
  } catch {
    bindings = parseBindings(null);
  }
  // The pad's table: the same reader with the pad's defaults, which also drops any code that is
  // not a gamepad code. A save from before the gamepad has none and gets the defaults.
  const padTable = own(root, 'gamepadBindings');
  let gamepadBindings: InputBindings;
  try {
    gamepadBindings = parseGamepadBindings(
      isRecord(padTable)
        ? JSON.stringify({ version: BINDINGS_FORMAT_VERSION, bindings: padTable })
        : null,
    );
  } catch {
    gamepadBindings = parseGamepadBindings(null);
  }
  return { settings, bindings, gamepadBindings };
}

/** The text to store. Contains the TURN credential: write it to localStorage and nowhere else. */
export function serializeSettingsData(data: SettingsData): string {
  return JSON.stringify({
    version: SETTINGS_VERSION,
    ...data.settings,
    bindings: cloneBindings(data.bindings),
    gamepadBindings: cloneBindings(data.gamepadBindings),
  });
}

/** A copy that is safe to print: the TURN username and credential are masked. */
export function redactSettings(settings: GameSettings): GameSettings {
  if (settings.turn === null) return settings;
  return { ...settings, turn: { url: settings.turn.url, username: '***', credential: '***' } };
}
