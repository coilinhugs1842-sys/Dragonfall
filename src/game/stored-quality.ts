/**
 * Reads the quality preset the player saved, so boot can create the renderer with it.
 *
 * Phase 0 only reads. The Settings menu (T-3.9) writes the whole `SettingsState` as JSON under
 * `SETTINGS_STORAGE_KEY`; this picks out its `quality` field. `'auto'`, a missing key and
 * anything malformed all return null, and the caller falls back to `DEFAULT_QUALITY` until the
 * automatic quality pick (docs/PERFORMANCE.md) exists.
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
    if (typeof parsed !== 'object' || parsed === null || !('quality' in parsed)) return null;
    return isQualityPresetId(parsed.quality) ? parsed.quality : null;
  } catch {
    // Corrupt JSON, or a browser that throws on storage access in private mode.
    return null;
  }
}
