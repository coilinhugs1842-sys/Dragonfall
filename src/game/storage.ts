/**
 * What the game keeps in browser storage for the network flow. Everything here takes the
 * `Storage` as an argument (null where there is none) and never throws: private mode, blocked
 * third-party storage and a full quota all just mean "not remembered".
 *
 * - Reconnect tokens: per tab (`sessionStorage`), keyed by room code. A page reload within the
 *   host's 30 s grace takes the old seat back (docs/NETWORKING.md, "Lobby protocol" 5).
 * - The client id: one per browser (`localStorage`), sent in HELLO so a kick sticks across tabs.
 * - The rejoin record: which room this tab was in, so a reload goes straight back to it instead
 *   of leaving the player on the title screen typing the code again.
 * - Settings: the whole `SettingsState` as JSON in `localStorage` (the key `stored-quality.ts`
 *   reads the quality preset from at boot).
 */

import { isValidRoomCode } from '../net/room-code';
import type { ReconnectTokenStore } from '../net';
import { DEFAULT_SETTINGS, isQualityPresetId } from '../shared';
import type { SettingsState, TurnSettings } from '../shared';
import { SETTINGS_STORAGE_KEY } from './stored-quality';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const RECONNECT_TOKEN_KEY_PREFIX = 'dragonfall.token.';
export const REJOIN_STORAGE_KEY = 'dragonfall.rejoin';
export const CLIENT_ID_STORAGE_KEY = 'dragonfall.clientId';

function read(storage: StorageLike | null, key: string): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string | null): void {
  if (storage === null) return;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Blocked or full: nothing is remembered, nothing breaks.
  }
}

/**
 * A `ReconnectTokenStore` on `storage`, with a memory copy in front so a session that cannot
 * write storage still reconnects for as long as the page lives.
 */
export function createStorageTokenStore(storage: StorageLike | null): ReconnectTokenStore {
  const memory = new Map<string, string>();
  return {
    load(roomCode: string): string {
      return memory.get(roomCode) ?? read(storage, RECONNECT_TOKEN_KEY_PREFIX + roomCode) ?? '';
    },
    save(roomCode: string, token: string): void {
      memory.set(roomCode, token);
      write(storage, RECONNECT_TOKEN_KEY_PREFIX + roomCode, token);
    },
    clear(roomCode: string): void {
      memory.delete(roomCode);
      write(storage, RECONNECT_TOKEN_KEY_PREFIX + roomCode, null);
    },
  };
}

/**
 * This browser's client id for HELLO: the stored one, or `fresh` (which is then stored). It is
 * the same in every tab and survives reloads, which is the point: the host bans it on a kick.
 * Without storage every page load has a new one.
 */
export function loadClientId(storage: StorageLike | null, fresh: string): string {
  const stored = read(storage, CLIENT_ID_STORAGE_KEY);
  if (stored !== null && /^[0-9a-f]{16,64}$/.test(stored)) return stored;
  write(storage, CLIENT_ID_STORAGE_KEY, fresh);
  return fresh;
}

/** The room a tab was last in as a client. */
export interface RejoinRecord {
  readonly roomCode: string;
  readonly name: string;
}

export function readRejoin(storage: StorageLike | null): RejoinRecord | null {
  const raw = read(storage, REJOIN_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const roomCode: unknown = Reflect.get(parsed, 'roomCode');
    const name: unknown = Reflect.get(parsed, 'name');
    if (typeof roomCode !== 'string' || typeof name !== 'string') return null;
    if (!isValidRoomCode(roomCode)) return null;
    return { roomCode, name };
  } catch {
    return null;
  }
}

export function writeRejoin(storage: StorageLike | null, record: RejoinRecord | null): void {
  write(storage, REJOIN_STORAGE_KEY, record === null ? null : JSON.stringify(record));
}

function unitOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback;
}

function readTurn(value: unknown): TurnSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const url: unknown = Reflect.get(value, 'url');
  const username: unknown = Reflect.get(value, 'username');
  const credential: unknown = Reflect.get(value, 'credential');
  if (typeof url !== 'string' || url === '') return null;
  return {
    url,
    username: typeof username === 'string' ? username : '',
    credential: typeof credential === 'string' ? credential : '',
  };
}

/** Field by field: anything missing or malformed falls back to its default. */
export function parseSettings(raw: string | null): SettingsState {
  if (raw === null) return DEFAULT_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
  const get = (key: keyof SettingsState): unknown => Reflect.get(parsed, key);
  const quality = get('quality');
  const fpsCap = get('fpsCap');
  const sensitivity = get('mouseSensitivity');
  const lanHost = get('lanHost');
  return {
    quality: isQualityPresetId(quality) ? quality : DEFAULT_SETTINGS.quality,
    fpsCap: fpsCap === 30 || fpsCap === 45 ? fpsCap : 0,
    masterVolume: unitOr(get('masterVolume'), DEFAULT_SETTINGS.masterVolume),
    musicVolume: unitOr(get('musicVolume'), DEFAULT_SETTINGS.musicVolume),
    sfxVolume: unitOr(get('sfxVolume'), DEFAULT_SETTINGS.sfxVolume),
    mouseSensitivity:
      typeof sensitivity === 'number' && sensitivity > 0 && sensitivity <= 10
        ? sensitivity
        : DEFAULT_SETTINGS.mouseSensitivity,
    invertY: get('invertY') === true,
    signaling: get('signaling') === 'lan' ? 'lan' : 'online',
    lanHost: typeof lanHost === 'string' ? lanHost.slice(0, 253) : '',
    turn: readTurn(get('turn')),
  };
}

export function loadSettings(storage: StorageLike | null): SettingsState {
  return parseSettings(read(storage, SETTINGS_STORAGE_KEY));
}

export function saveSettings(storage: StorageLike | null, settings: SettingsState): void {
  write(storage, SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
