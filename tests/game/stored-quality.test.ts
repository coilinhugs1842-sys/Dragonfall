import { describe, expect, it } from 'vitest';
import {
  AUTO_QUALITY_LINE_KEY,
  SETTINGS_STORAGE_KEY,
  readAutoQualityLine,
  readStoredQuality,
  writeAutoQualityLine,
} from '../../src/game/stored-quality';

function storageWith(value: string | null): Pick<Storage, 'getItem'> {
  return { getItem: (key) => (key === SETTINGS_STORAGE_KEY ? value : null) };
}

describe('readStoredQuality', () => {
  it('returns the saved preset', () => {
    expect(readStoredQuality(storageWith('{"quality":"low"}'))).toBe('low');
    expect(readStoredQuality(storageWith('{"quality":"high","invertY":true}'))).toBe('high');
  });

  it('returns null for auto, unknown values and a missing field', () => {
    expect(readStoredQuality(storageWith('{"quality":"auto"}'))).toBeNull();
    expect(readStoredQuality(storageWith('{"quality":"ultra"}'))).toBeNull();
    expect(readStoredQuality(storageWith('{"invertY":true}'))).toBeNull();
  });

  it('returns what the automatic pick chose while the setting says Automatic', () => {
    expect(readStoredQuality(storageWith('{"quality":"auto","autoQuality":"low"}'))).toBe('low');
    expect(readStoredQuality(storageWith('{"quality":"auto","autoQuality":"high"}'))).toBe('high');
    // A save with no usable `quality` is Automatic, as the settings store reads it.
    expect(readStoredQuality(storageWith('{"autoQuality":"low"}'))).toBe('low');
    expect(readStoredQuality(storageWith('{"quality":"ultra","autoQuality":"low"}'))).toBe('low');
  });

  it('lets a preset chosen by hand win over an older automatic result', () => {
    expect(readStoredQuality(storageWith('{"quality":"high","autoQuality":"low"}'))).toBe('high');
  });

  it('returns null while the automatic pick has no result', () => {
    expect(readStoredQuality(storageWith('{"quality":"auto","autoQuality":null}'))).toBeNull();
    expect(readStoredQuality(storageWith('{"quality":"auto","autoQuality":"ultra"}'))).toBeNull();
    expect(readStoredQuality(storageWith('{"quality":"auto","autoQuality":3}'))).toBeNull();
  });

  it('returns null when nothing is stored or there is no storage', () => {
    expect(readStoredQuality(storageWith(null))).toBeNull();
    expect(readStoredQuality(null)).toBeNull();
  });

  it('returns null for corrupt JSON and non-object values', () => {
    expect(readStoredQuality(storageWith('{quality'))).toBeNull();
    expect(readStoredQuality(storageWith('"low"'))).toBeNull();
    expect(readStoredQuality(storageWith('null'))).toBeNull();
  });

  it('returns null when storage access throws', () => {
    const throwing: Pick<Storage, 'getItem'> = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readStoredQuality(throwing)).toBeNull();
  });
});

describe('the kept line of the last automatic pick', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
  }

  it('is written under its own key and read back', () => {
    const storage = memoryStorage();
    expect(readAutoQualityLine(storage)).toBe('');
    writeAutoQualityLine(storage, '2026-11-11 [quality] auto pick: medium | gpu Test');
    expect(storage.map.get(AUTO_QUALITY_LINE_KEY)).toBe(
      '2026-11-11 [quality] auto pick: medium | gpu Test',
    );
    expect(readAutoQualityLine(storage)).toBe('2026-11-11 [quality] auto pick: medium | gpu Test');
    expect(storage.map.has(SETTINGS_STORAGE_KEY)).toBe(false);
  });

  it('cuts an absurdly long line and ignores one somebody else stored', () => {
    const storage = memoryStorage();
    writeAutoQualityLine(storage, 'x'.repeat(5000));
    expect(readAutoQualityLine(storage).length).toBe(1000);
    storage.map.set(AUTO_QUALITY_LINE_KEY, 'y'.repeat(5000));
    expect(readAutoQualityLine(storage)).toBe('');
  });

  it('never throws without storage or when storage refuses', () => {
    expect(readAutoQualityLine(null)).toBe('');
    expect(() => {
      writeAutoQualityLine(null, 'line');
    }).not.toThrow();
    const refusing: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readAutoQualityLine(refusing)).toBe('');
    expect(() => {
      writeAutoQualityLine(refusing, 'line');
    }).not.toThrow();
  });
});
