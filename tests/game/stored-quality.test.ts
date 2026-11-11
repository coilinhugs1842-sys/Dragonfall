import { describe, expect, it } from 'vitest';
import { SETTINGS_STORAGE_KEY, readStoredQuality } from '../../src/game/stored-quality';

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
