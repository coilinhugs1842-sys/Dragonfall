/**
 * Reads the quality preset the player's saved settings stand for, so boot can create the
 * renderer with it before anything else exists, and keeps the last automatic pick's console
 * line so a tester can still copy it after a reload.
 *
 * The Settings menu (T-3.9) writes the whole `SettingsState` as JSON under
 * `SETTINGS_STORAGE_KEY`. Two of its fields decide the preset:
 * - `quality`: a preset the player chose by hand, or `'auto'`;
 * - `autoQuality`: what the automatic quality pick (T-6.2, ./auto-quality-run.ts) chose for
 *   this computer, used while `quality` is `'auto'`.
 * `readStoredQuality` returns null when neither gives a preset: a first launch, where boot uses
 * `DEFAULT_QUALITY` and the automatic pick runs behind the title screen.
 */
import { isQualityPresetId } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';

export const SETTINGS_STORAGE_KEY = 'dragonfall.settings';

/** `storage` is null where there is none (node, blocked third-party storage). Never throws. */
export function readStoredQuality(
  storage: Pick<Storage, 'getItem'> | null,
): QualityPresetId | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // A preset chosen by hand wins. Anything else in the field ('auto', missing, garbage) is
    // Automatic, the same way the settings store reads it.
    if ('quality' in parsed && isQualityPresetId(parsed.quality)) return parsed.quality;
    if ('autoQuality' in parsed && isQualityPresetId(parsed.autoQuality)) return parsed.autoQuality;
    return null;
  } catch {
    // Corrupt JSON, or a browser that throws on storage access in private mode.
    return null;
  }
}

/**
 * Where the console line of the last automatic pick is kept. Its own key, not a setting: it is
 * a note for testers ("which GPU, what was measured, when"), nothing reads it to decide.
 */
export const AUTO_QUALITY_LINE_KEY = 'dragonfall.autoQuality';
/** A real line is about 300 characters; anything much longer in the key is not ours. */
const MAX_LINE_LENGTH = 1000;

/** The last automatic pick's line, or '' when there is none. Never throws. */
export function readAutoQualityLine(storage: Pick<Storage, 'getItem'> | null): string {
  if (storage === null) return '';
  try {
    const line = storage.getItem(AUTO_QUALITY_LINE_KEY);
    return line !== null && line.length <= MAX_LINE_LENGTH ? line : '';
  } catch {
    return '';
  }
}

/** Never throws: blocked or full storage only means the line is not kept. */
export function writeAutoQualityLine(storage: Pick<Storage, 'setItem'> | null, line: string): void {
  if (storage === null) return;
  try {
    storage.setItem(AUTO_QUALITY_LINE_KEY, line.slice(0, MAX_LINE_LENGTH));
  } catch {
    // Nothing to do, and nothing the player needs to know.
  }
}
