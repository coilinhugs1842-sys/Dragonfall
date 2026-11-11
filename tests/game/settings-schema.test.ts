import { describe, expect, it } from 'vitest';
import {
  MAX_SETTINGS_TEXT_LENGTH,
  SETTINGS_VERSION,
  applyRebind,
  clampSetting,
  parseSettingsData,
  redactSettings,
  sanitizeLanHost,
  sanitizePlayerName,
  sanitizeSettings,
  sanitizeTurn,
  serializeSettingsData,
} from '../../src/game/settings';
import { parseSettings } from '../../src/game/storage';
import { readStoredQuality } from '../../src/game/stored-quality';
import { DEFAULT_BINDINGS } from '../../src/input/bindings';
import {
  DEFAULT_GAME_SETTINGS,
  DEFAULT_SETTINGS,
  MAX_PLAYER_NAME_LENGTH,
  MAX_TURN_FIELD_LENGTH,
  SETTINGS_LIMITS,
  effectiveQuality,
  renderScaleCapFor,
  renderScaleCapFraction,
  resolveSettings,
} from '../../src/shared';
import type { GameSettings } from '../../src/shared';

describe('shared settings helpers', () => {
  it('keeps the Phase 0-2 defaults and adds the rest', () => {
    expect(DEFAULT_GAME_SETTINGS).toMatchObject(DEFAULT_SETTINGS);
    expect(resolveSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_GAME_SETTINGS);
    expect(resolveSettings({ ...DEFAULT_SETTINGS, fovDeg: 80 }).fovDeg).toBe(80);
  });

  it('resolves auto to Medium and maps the cap fraction onto the preset bounds', () => {
    expect(effectiveQuality('auto')).toBe('medium');
    expect(effectiveQuality('high')).toBe('high');
    expect(renderScaleCapFor('medium', 1)).toBeCloseTo(0.85);
    expect(renderScaleCapFor('medium', 0)).toBeCloseTo(0.6);
    expect(renderScaleCapFor('low', 0.5)).toBeCloseTo(0.6);
    expect(renderScaleCapFor('high', 7)).toBeCloseTo(1);
    expect(renderScaleCapFor('high', -1)).toBeCloseTo(0.85);
    expect(renderScaleCapFraction('medium', 0.85)).toBeCloseTo(1);
    expect(renderScaleCapFraction('medium', 0.2)).toBe(0);
    expect(renderScaleCapFraction('low', 0.6)).toBeCloseTo(0.5);
  });
});

describe('sanitizeSettings', () => {
  it('returns the base for anything that is not a plain object', () => {
    for (const junk of [null, undefined, 7, 'x', true, [], [1, 2], () => 1]) {
      expect(sanitizeSettings(junk)).toBe(DEFAULT_GAME_SETTINGS);
    }
  });

  it('falls back field by field on wrong types', () => {
    const out = sanitizeSettings({
      quality: 'ultra',
      fpsCap: 60,
      dynamicResolution: 'yes',
      renderScaleCap: '1',
      fovDeg: null,
      cameraShake: {},
      reduceMotion: 1,
      masterVolume: [],
      musicVolume: Number.NaN,
      sfxVolume: Number.POSITIVE_INFINITY,
      uiVolume: '0.5',
      mouseSensitivity: false,
      invertY: 'true',
      boostToggle: 0,
      uiScale: undefined,
      colorBlindMarkers: null,
      showNetChip: 'no',
      signaling: 'bluetooth',
      lanHost: 12,
      turn: 'turn:x',
      playerName: 42,
    });
    expect(out).toEqual(DEFAULT_GAME_SETTINGS);
  });

  it('clamps out-of-range numbers and snaps to the step', () => {
    const out = sanitizeSettings({
      fovDeg: 500,
      cameraShake: -3,
      masterVolume: 9,
      musicVolume: -0.2,
      mouseSensitivity: 1e9,
      uiScale: 0.01,
      renderScaleCap: 2,
    });
    expect(out.fovDeg).toBe(SETTINGS_LIMITS.fovDeg.max);
    expect(out.cameraShake).toBe(0);
    expect(out.masterVolume).toBe(1);
    expect(out.musicVolume).toBe(0);
    expect(out.mouseSensitivity).toBe(SETTINGS_LIMITS.mouseSensitivity.max);
    expect(out.uiScale).toBe(SETTINGS_LIMITS.uiScale.min);
    expect(out.renderScaleCap).toBe(1);
    expect(sanitizeSettings({ fovDeg: 71.6 }).fovDeg).toBe(72);
    expect(sanitizeSettings({ uiScale: 1.149 }).uiScale).toBe(1.15);
    expect(sanitizeSettings({ mouseSensitivity: 0.0001 }).mouseSensitivity).toBe(0.1);
    expect(clampSetting(0.15000000000000002, SETTINGS_LIMITS.cameraShake, 1)).toBe(0.15);
    expect(clampSetting('3', SETTINGS_LIMITS.volume, 0.4)).toBe(0.4);
  });

  it('accepts every valid value', () => {
    const wanted: GameSettings = {
      quality: 'low',
      fpsCap: 45,
      dynamicResolution: false,
      renderScaleCap: 0.4,
      fovDeg: 90,
      cameraShake: 0.5,
      reduceMotion: true,
      masterVolume: 0.3,
      musicVolume: 0,
      sfxVolume: 0.55,
      uiVolume: 1,
      mouseSensitivity: 2.5,
      invertY: true,
      boostToggle: true,
      uiScale: 1.3,
      colorBlindMarkers: true,
      showNetChip: false,
      signaling: 'lan',
      lanHost: '192.168.1.20',
      turn: { url: 'turns:relay.example.org:5349', username: 'u', credential: 'p w' },
      playerName: 'Ash Rider',
    };
    expect(sanitizeSettings(wanted)).toEqual(wanted);
  });

  it('ignores inherited and prototype-polluting keys', () => {
    const hostile: unknown = JSON.parse(
      '{"__proto__":{"invertY":true,"quality":"low"},"constructor":{"prototype":{"fovDeg":99}}}',
    );
    expect(sanitizeSettings(hostile)).toEqual(DEFAULT_GAME_SETTINGS);
    expect(({} as Record<string, unknown>)['invertY']).toBeUndefined();
    const inherited = Object.create({ invertY: true, fovDeg: 99 }) as object;
    expect(sanitizeSettings(inherited)).toEqual(DEFAULT_GAME_SETTINGS);
  });

  it('a patch keeps what it does not mention and can clear the relay', () => {
    const base = sanitizeSettings({
      fovDeg: 80,
      turn: { url: 'turn:a.b:1', username: 'u', credential: 'c' },
    });
    const next = sanitizeSettings({ invertY: true, fovDeg: 'wide' }, base);
    expect(next.fovDeg).toBe(80);
    expect(next.invertY).toBe(true);
    expect(next.turn).toBe(base.turn);
    expect(sanitizeSettings({ turn: null }, base).turn).toBeNull();
    expect(sanitizeSettings({ turn: { url: 'http://x' } }, base).turn).toBeNull();
  });
});

describe('string fields', () => {
  it('cuts huge strings and drops control characters', () => {
    const huge = 'a'.repeat(5_000_000);
    expect(sanitizePlayerName(huge, '')).toHaveLength(MAX_PLAYER_NAME_LENGTH);
    expect(sanitizeLanHost(huge, 'x')).toHaveLength(253);
    const turn = sanitizeTurn({ url: 'turn:host', username: huge, credential: `p\u0000q${huge}` });
    expect(turn?.username).toHaveLength(MAX_TURN_FIELD_LENGTH);
    expect(turn?.credential.startsWith('pq')).toBe(true);
    expect(turn?.credential).toHaveLength(MAX_TURN_FIELD_LENGTH);
    expect(sanitizeTurn({ url: `turn:${huge}` })).toBeNull();
  });

  it('tidies the rider name', () => {
    expect(sanitizePlayerName('  Ash \t\n  Rider  ', '')).toBe('Ash Rider');
    expect(sanitizePlayerName('a\u0007b\u009fc', '')).toBe('abc');
    expect(sanitizePlayerName('🐉'.repeat(40), '')).toBe('🐉'.repeat(16));
    expect(sanitizePlayerName('x\ud800y', '')).toBe('xy');
    expect(sanitizePlayerName(null, 'kept')).toBe('kept');
  });

  it('only takes host names and addresses for the LAN relay', () => {
    expect(sanitizeLanHost(' my-laptop.local ', '')).toBe('my-laptop.local');
    expect(sanitizeLanHost('[fe80::1]', '')).toBe('[fe80::1]');
    expect(sanitizeLanHost('http://evil.example/x?y', 'old')).toBe('old');
    expect(sanitizeLanHost('a b', 'old')).toBe('old');
    expect(sanitizeLanHost('<script>', 'old')).toBe('old');
    expect(sanitizeLanHost('', 'old')).toBe('');
  });

  it('only takes turn: and turns: relay addresses', () => {
    expect(sanitizeTurn({ url: ' TURN:relay.example.org:3478?transport=udp ' })).toEqual({
      url: 'TURN:relay.example.org:3478?transport=udp',
      username: '',
      credential: '',
    });
    for (const url of ['', 'stun:x', 'https://x', 'javascript:alert(1)', 'turn:', 'turn: x', 5]) {
      expect(sanitizeTurn({ url })).toBeNull();
    }
    expect(sanitizeTurn(['turn:x'])).toBeNull();
  });

  it('masks the relay login for printing', () => {
    const settings = sanitizeSettings({
      turn: { url: 'turn:h', username: 'someuser', credential: 'hunter2' },
    });
    expect(JSON.stringify(redactSettings(settings))).not.toContain('hunter2');
    expect(JSON.stringify(redactSettings(settings))).not.toContain('someuser');
    expect(redactSettings(DEFAULT_GAME_SETTINGS)).toBe(DEFAULT_GAME_SETTINGS);
  });
});

describe('parseSettingsData', () => {
  it('gives the defaults for missing, corrupt and hostile text', () => {
    const junk = [
      null,
      '',
      '{',
      'null',
      '7',
      '"low"',
      '[]',
      '[{"quality":"low"}]',
      '{"version":99}',
      `{"quality":"${'x'.repeat(100)}"}`,
      '{"bindings":"none"}',
      '{"bindings":[["KeyW"]]}',
      `{"a":${'['.repeat(5000)}`,
    ];
    for (const text of junk) {
      const data = parseSettingsData(text);
      expect(data.settings).toEqual(DEFAULT_GAME_SETTINGS);
      expect(data.bindings).toEqual(DEFAULT_BINDINGS);
    }
  });

  it('does not parse text beyond the size limit', () => {
    const padded = `{"invertY":true,"pad":"${'x'.repeat(MAX_SETTINGS_TEXT_LENGTH)}"}`;
    expect(parseSettingsData(padded).settings.invertY).toBe(false);
  });

  it('migrates a version 1 save and takes the rider name from its old key', () => {
    const v1 = JSON.stringify({
      ...DEFAULT_SETTINGS,
      quality: 'high',
      fpsCap: 30,
      mouseSensitivity: 2,
      invertY: true,
      signaling: 'lan',
      lanHost: 'host-pc',
    });
    const data = parseSettingsData(v1, '  Old   Name ');
    expect(data.settings).toEqual({
      ...DEFAULT_GAME_SETTINGS,
      quality: 'high',
      fpsCap: 30,
      mouseSensitivity: 2,
      invertY: true,
      signaling: 'lan',
      lanHost: 'host-pc',
      playerName: 'Old Name',
    });
    expect(data.bindings).toEqual(DEFAULT_BINDINGS);
    // A name already in the save wins over the old key.
    expect(parseSettingsData('{"playerName":"New"}', 'Old').settings.playerName).toBe('New');
  });

  it('round-trips, and old readers still understand the new save', () => {
    const settings = sanitizeSettings({ quality: 'low', fovDeg: 88, uiScale: 1.2, invertY: true });
    const bindings = applyRebind(DEFAULT_BINDINGS, 'utility', 0, 'KeyG', false);
    const text = serializeSettingsData({ settings, bindings });
    expect(text.startsWith(`{"version":${SETTINGS_VERSION},`)).toBe(true);
    const back = parseSettingsData(text);
    expect(back.settings).toEqual(settings);
    expect(back.bindings).toEqual(bindings);
    // stored-quality.ts (boot) and the Phase 2 reader in storage.ts.
    expect(readStoredQuality({ getItem: () => text })).toBe('low');
    expect(parseSettings(text)).toMatchObject({ quality: 'low', invertY: true });
  });

  it('sanitises stored bindings through the input table reader', () => {
    const text = JSON.stringify({
      bindings: {
        boost: ['Escape', 'KeyB', 'KeyB', 'KeyN', 'KeyM'],
        flap: [],
        dive: 'Space',
        hack: ['KeyH'],
        primary: [5, null, 'Mouse1'],
      },
    });
    const { bindings } = parseSettingsData(text);
    expect(bindings.boost).toEqual(['KeyB', 'KeyN']);
    expect(bindings.flap).toEqual([]);
    expect(bindings.dive).toEqual(DEFAULT_BINDINGS.dive);
    expect(bindings.primary).toEqual(['Mouse1']);
    expect(Object.keys(bindings)).toEqual(Object.keys(DEFAULT_BINDINGS));
  });
});
