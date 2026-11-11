import { describe, expect, it } from 'vitest';
import {
  REJOIN_STORAGE_KEY,
  RECONNECT_TOKEN_KEY_PREFIX,
  createStorageTokenStore,
  loadSettings,
  parseSettings,
  readRejoin,
  saveSettings,
  writeRejoin,
} from '../../src/game/storage';
import { SETTINGS_STORAGE_KEY, readStoredQuality } from '../../src/game/stored-quality';
import { DEFAULT_SETTINGS } from '../../src/shared';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const BROKEN: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('createStorageTokenStore', () => {
  it('keeps a token per room and survives a new store on the same storage (a reload)', () => {
    const storage = memoryStorage();
    const store = createStorageTokenStore(storage);
    expect(store.load('KH7P2')).toBe('');
    store.save('KH7P2', 'aaaa');
    store.save('ABCDE', 'bbbb');
    expect(storage.data.get(`${RECONNECT_TOKEN_KEY_PREFIX}KH7P2`)).toBe('aaaa');

    const reloaded = createStorageTokenStore(storage);
    expect(reloaded.load('KH7P2')).toBe('aaaa');
    expect(reloaded.load('ABCDE')).toBe('bbbb');
    reloaded.clear('KH7P2');
    expect(reloaded.load('KH7P2')).toBe('');
    expect(createStorageTokenStore(storage).load('KH7P2')).toBe('');
  });

  it('still works for the life of the page when storage is missing or throws', () => {
    for (const storage of [null, BROKEN]) {
      const store = createStorageTokenStore(storage);
      expect(store.load('KH7P2')).toBe('');
      store.save('KH7P2', 'aaaa');
      expect(store.load('KH7P2')).toBe('aaaa');
      store.clear('KH7P2');
      expect(store.load('KH7P2')).toBe('');
    }
  });
});

describe('rejoin record', () => {
  it('round-trips and clears', () => {
    const storage = memoryStorage();
    expect(readRejoin(storage)).toBeNull();
    writeRejoin(storage, { roomCode: 'KH7P2', name: 'Brook' });
    expect(readRejoin(storage)).toEqual({ roomCode: 'KH7P2', name: 'Brook' });
    writeRejoin(storage, null);
    expect(readRejoin(storage)).toBeNull();
    expect(storage.data.has(REJOIN_STORAGE_KEY)).toBe(false);
  });

  it('ignores anything that is not a record with a real room code', () => {
    const storage = memoryStorage();
    for (const raw of [
      '',
      'nope',
      '[]',
      '{"roomCode":5,"name":"x"}',
      '{"roomCode":"lol","name":"x"}',
    ]) {
      storage.setItem(REJOIN_STORAGE_KEY, raw);
      expect(readRejoin(storage), raw).toBeNull();
    }
    expect(readRejoin(null)).toBeNull();
    expect(readRejoin(BROKEN)).toBeNull();
    expect(() => writeRejoin(BROKEN, { roomCode: 'KH7P2', name: 'x' })).not.toThrow();
  });
});

describe('settings', () => {
  it('falls back to the defaults for missing or broken data', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('7')).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(BROKEN)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips what the game saves, in the place the boot code reads the quality from', () => {
    const storage = memoryStorage();
    const settings = {
      ...DEFAULT_SETTINGS,
      quality: 'low' as const,
      signaling: 'lan' as const,
      lanHost: '192.168.1.20',
      invertY: true,
      turn: { url: 'turn:relay.example:3478', username: 'u', credential: 'c' },
    };
    saveSettings(storage, settings);
    expect(storage.data.has(SETTINGS_STORAGE_KEY)).toBe(true);
    expect(loadSettings(storage)).toEqual(settings);
    expect(readStoredQuality(storage)).toBe('low');
  });

  it('repairs fields one by one', () => {
    const parsed = parseSettings(
      JSON.stringify({
        quality: 'ultra',
        fpsCap: 31,
        masterVolume: 4,
        musicVolume: 0.25,
        mouseSensitivity: -1,
        invertY: 'yes',
        signaling: 'carrier-pigeon',
        lanHost: 12,
        turn: { url: '' },
      }),
    );
    expect(parsed).toEqual({ ...DEFAULT_SETTINGS, musicVolume: 0.25 });
  });
});
