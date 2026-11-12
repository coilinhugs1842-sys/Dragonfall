/**
 * The automatic pick's result as a setting: how it is stored, what "Automatic" then means, and
 * what the settings panel says about it.
 */
import { describe, expect, it } from 'vitest';
import { applySettings, handleSettingsIntent } from '../../src/game/settings/apply';
import {
  parseSettingsData,
  sanitizeSettings,
  serializeSettingsData,
  settingsEqual,
} from '../../src/game/settings/schema';
import { createSettingsStore } from '../../src/game/settings/store';
import { SETTINGS_STORAGE_KEY, readStoredQuality } from '../../src/game/stored-quality';
import { DEFAULT_GAME_SETTINGS, effectiveQuality } from '../../src/shared/ui';
import type { GameSettings } from '../../src/shared/ui';
import { qualityHint, rangeView, createRangeView } from '../../src/ui/settings/settings-model';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe('effectiveQuality', () => {
  it('is the automatic result while the choice is Automatic, the default before one exists', () => {
    expect(effectiveQuality('auto')).toBe('medium');
    expect(effectiveQuality('auto', null)).toBe('medium');
    expect(effectiveQuality('auto', 'low')).toBe('low');
    expect(effectiveQuality('auto', 'high')).toBe('high');
  });

  it('is the preset chosen by hand, whatever the test found', () => {
    expect(effectiveQuality('high', 'low')).toBe('high');
    expect(effectiveQuality('low', 'high')).toBe('low');
    expect(effectiveQuality('medium')).toBe('medium');
  });
});

describe('the autoQuality setting', () => {
  it('defaults to "not tested yet"', () => {
    expect(DEFAULT_GAME_SETTINGS.autoQuality).toBeNull();
    expect(sanitizeSettings({}).autoQuality).toBeNull();
    // A save from before the field existed.
    expect(
      parseSettingsData('{"version":3,"quality":"auto","fpsCap":0}').settings.autoQuality,
    ).toBeNull();
  });

  it('accepts a preset or an explicit null, and nothing else', () => {
    const tested: GameSettings = { ...DEFAULT_GAME_SETTINGS, autoQuality: 'low' };
    expect(sanitizeSettings({ autoQuality: 'high' }).autoQuality).toBe('high');
    expect(sanitizeSettings({ autoQuality: null }, tested).autoQuality).toBeNull();
    expect(sanitizeSettings({ autoQuality: 'ultra' }, tested).autoQuality).toBe('low');
    expect(sanitizeSettings({ autoQuality: 'auto' }, tested).autoQuality).toBe('low');
    expect(sanitizeSettings({ autoQuality: 2 }, tested).autoQuality).toBe('low');
    // A patch that does not mention it leaves it alone.
    expect(sanitizeSettings({ invertY: true }, tested).autoQuality).toBe('low');
  });

  it('counts as a difference between two settings', () => {
    expect(
      settingsEqual(DEFAULT_GAME_SETTINGS, { ...DEFAULT_GAME_SETTINGS, autoQuality: 'medium' }),
    ).toBe(false);
    expect(
      settingsEqual(
        { ...DEFAULT_GAME_SETTINGS, autoQuality: 'low' },
        { ...DEFAULT_GAME_SETTINGS, autoQuality: 'low' },
      ),
    ).toBe(true);
  });

  it('survives a save and a reload, and boot reads the same preset from the same text', () => {
    const storage = memoryStorage();
    const store = createSettingsStore({ storage });
    expect(store.update({ quality: 'auto', autoQuality: 'low' })).toBe(true);
    store.flush();
    const text = storage.getItem(SETTINGS_STORAGE_KEY) ?? '';
    expect(text).toContain('"autoQuality":"low"');
    expect(readStoredQuality(storage)).toBe('low');

    const reloaded = createSettingsStore({ storage });
    expect(reloaded.settings.quality).toBe('auto');
    expect(reloaded.settings.autoQuality).toBe('low');
    store.dispose();
    reloaded.dispose();
  });

  it('is saved as null before a test, which boot reads as "use the default"', () => {
    const text = serializeSettingsData(parseSettingsData(null));
    expect(text).toContain('"autoQuality":null');
    const storage = memoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, text);
    expect(readStoredQuality(storage)).toBeNull();
  });

  it('"Reset all" forgets the result, so the test runs again', () => {
    const store = createSettingsStore({ storage: null });
    store.update({ autoQuality: 'high' });
    expect(store.reset()).toBe(true);
    expect(store.settings.autoQuality).toBeNull();
    store.dispose();
  });

  it('a manual choice keeps the result for when the player goes back to Automatic', () => {
    const store = createSettingsStore({ storage: null });
    store.update({ autoQuality: 'low' });
    store.update({ quality: 'high' });
    expect(effectiveQuality(store.settings.quality, store.settings.autoQuality)).toBe('high');
    store.update({ quality: 'auto' });
    expect(effectiveQuality(store.settings.quality, store.settings.autoQuality)).toBe('low');
    store.dispose();
  });
});

describe('applying the result', () => {
  it('sets the preset when the automatic result arrives, and only when it changes it', () => {
    const store = createSettingsStore({ storage: null });
    const presets: string[] = [];
    const bounds: string[] = [];
    const unsubscribe = store.subscribe((next, previous) => {
      applySettings(
        {
          setQuality: (preset) => presets.push(preset),
          setResolution: (dynamic, min, cap) => bounds.push(`${min}-${cap}`),
        },
        next,
        previous,
      );
    });
    store.update({ autoQuality: 'medium' });
    // Automatic was already using Medium: nothing to do.
    expect(presets).toEqual([]);
    store.update({ autoQuality: 'low' });
    expect(presets).toEqual(['low']);
    expect(bounds).toEqual(['0.5-0.7']);
    store.update({ quality: 'high' });
    store.update({ autoQuality: 'medium' });
    // A hand-picked preset is not moved by a test result.
    expect(presets).toEqual(['low', 'high']);
    unsubscribe();
    store.dispose();
  });

  it('routes "Test again" to its hook and treats it as a settings intent', () => {
    const store = createSettingsStore({ storage: null });
    const before = store.settings;
    let calls = 0;
    const handled = handleSettingsIntent(
      store,
      { type: 'settings.retestQuality' },
      {
        retestQuality: () => {
          calls++;
        },
      },
    );
    expect(handled).toBe(true);
    expect(calls).toBe(1);
    // Without a hook it is still swallowed, not passed on to the game's own intents.
    expect(handleSettingsIntent(store, { type: 'settings.retestQuality' })).toBe(true);
    // The intent itself changes no setting: the test does, when it starts.
    expect(store.settings).toBe(before);
    store.dispose();
  });
});

describe('the settings panel', () => {
  it('says the preset was chosen automatically once the test has run', () => {
    expect(qualityHint(DEFAULT_GAME_SETTINGS)).toBe('Automatic is using Medium.');
    expect(qualityHint({ ...DEFAULT_GAME_SETTINGS, autoQuality: 'low' })).toBe(
      'Chosen automatically for this computer: Low.',
    );
    expect(qualityHint({ ...DEFAULT_GAME_SETTINGS, autoQuality: 'medium' })).toBe(
      'Chosen automatically for this computer: Medium.',
    );
  });

  it('does not say so for a preset chosen by hand', () => {
    const hint = qualityHint({ ...DEFAULT_GAME_SETTINGS, quality: 'high', autoQuality: 'low' });
    expect(hint.startsWith('High: resolution')).toBe(true);
  });

  it('draws the resolution slider for the preset Automatic resolved to', () => {
    const view = rangeView(
      'renderScaleCap',
      { ...DEFAULT_GAME_SETTINGS, autoQuality: 'low' },
      createRangeView(),
    );
    expect(view.min).toBe(50);
    expect(view.max).toBe(70);
  });
});
