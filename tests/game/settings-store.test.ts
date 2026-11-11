import { describe, expect, it } from 'vitest';
import {
  FrameCap,
  LEGACY_NAME_STORAGE_KEY,
  SETTINGS_SAVE_DELAY_MS,
  SETTINGS_SAVE_MAX_DELAY_MS,
  SETTINGS_VERSION,
  applyRebind,
  applyResetBindings,
  applySettings,
  applyUnbind,
  bindSettingsTargets,
  controlsUiStateFor,
  createDebounce,
  createSettingsNameStore,
  createSettingsStore,
  debounceDueMs,
  handleSettingsIntent,
  parseSettingsData,
} from '../../src/game/settings';
import type { DebounceTimers, SettingsTargets } from '../../src/game/settings';
import { SETTINGS_STORAGE_KEY, readStoredQuality } from '../../src/game/stored-quality';
import { DEFAULT_BINDINGS, findBindingConflicts } from '../../src/input/bindings';
import { DEFAULT_GAME_SETTINGS, DEFAULT_SETTINGS, MAX_PLAYER_NAME_LENGTH } from '../../src/shared';
import type { GameSettings } from '../../src/shared';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  let writes = 0;
  return {
    data,
    get writes(): number {
      return writes;
    },
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      writes++;
      data.set(key, value);
    },
  };
}

const BROKEN = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: (): void => {
    throw new Error('blocked');
  },
};

/** A clock and timer queue the test advances by hand. */
function fakeClock() {
  let nowMs = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const api: DebounceTimers = {
    set: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { at: nowMs + delayMs, callback });
      return handle;
    },
    clear: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    timers: api,
    now: (): number => nowMs,
    get pendingTimers(): number {
      return timers.size;
    },
    advance(ms: number): void {
      const end = nowMs + ms;
      for (;;) {
        let dueHandle = -1;
        let dueAt = Infinity;
        for (const [handle, timer] of timers) {
          if (timer.at <= end && timer.at < dueAt) {
            dueAt = timer.at;
            dueHandle = handle;
          }
        }
        const timer = timers.get(dueHandle);
        if (timer === undefined) break;
        timers.delete(dueHandle);
        nowMs = timer.at;
        timer.callback();
      }
      nowMs = end;
    },
  };
}

describe('debounce', () => {
  it('computes the due time: quiet period, capped from the first touch', () => {
    expect(debounceDueMs(0, 0, 400, 2000)).toBe(400);
    expect(debounceDueMs(0, 1000, 400, 2000)).toBe(1400);
    expect(debounceDueMs(0, 1900, 400, 2000)).toBe(2000);
  });

  it('runs once after the quiet period', () => {
    const clock = fakeClock();
    let runs = 0;
    const debounce = createDebounce({
      waitMs: 400,
      maxWaitMs: 2000,
      now: clock.now,
      timers: clock.timers,
      run: () => runs++,
    });
    debounce.touch();
    clock.advance(399);
    expect(runs).toBe(0);
    expect(debounce.pending).toBe(true);
    clock.advance(1);
    expect(runs).toBe(1);
    expect(debounce.pending).toBe(false);
    clock.advance(5000);
    expect(runs).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it('keeps waiting while touched, but not past the ceiling', () => {
    const clock = fakeClock();
    const ranAt: number[] = [];
    const debounce = createDebounce({
      waitMs: 400,
      maxWaitMs: 2000,
      now: clock.now,
      timers: clock.timers,
      run: () => ranAt.push(clock.now()),
    });
    // A slider dragged for 5 seconds, one change every 100 ms.
    for (let i = 0; i < 50; i++) {
      debounce.touch();
      clock.advance(100);
    }
    clock.advance(1000);
    expect(ranAt).toEqual([2000, 4000, 5300]);
    expect(clock.pendingTimers).toBe(0);
  });

  it('flush runs now, cancel never runs', () => {
    const clock = fakeClock();
    let runs = 0;
    const debounce = createDebounce({
      waitMs: 400,
      maxWaitMs: 2000,
      now: clock.now,
      timers: clock.timers,
      run: () => runs++,
    });
    expect(debounce.flush()).toBe(false);
    debounce.touch();
    expect(debounce.flush()).toBe(true);
    expect(runs).toBe(1);
    debounce.touch();
    debounce.cancel();
    clock.advance(5000);
    expect(runs).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it('waits out a timer that fires early', () => {
    let nowMs = 0;
    const queue: (() => void)[] = [];
    let runs = 0;
    const debounce = createDebounce({
      waitMs: 400,
      maxWaitMs: 2000,
      now: () => nowMs,
      timers: { set: (callback) => queue.push(callback), clear: () => undefined },
      run: () => runs++,
    });
    debounce.touch();
    nowMs = 390;
    queue.shift()?.();
    expect(runs).toBe(0);
    nowMs = 400;
    queue.shift()?.();
    expect(runs).toBe(1);
  });
});

describe('settings store', () => {
  function make(initial: Record<string, string> = {}) {
    const storage = memoryStorage(initial);
    const clock = fakeClock();
    const store = createSettingsStore({ storage, now: clock.now, timers: clock.timers });
    return { storage, clock, store };
  }

  it('starts from the defaults and writes nothing on load', () => {
    const { storage, clock, store } = make();
    expect(store.settings).toEqual(DEFAULT_GAME_SETTINGS);
    expect(store.bindings).toEqual(DEFAULT_BINDINGS);
    expect(store.controls.bindings).toBe(store.bindings);
    clock.advance(10_000);
    store.flush();
    expect(storage.writes).toBe(0);
  });

  it('survives missing and throwing storage', () => {
    for (const storage of [null, BROKEN]) {
      const clock = fakeClock();
      const store = createSettingsStore({ storage, now: clock.now, timers: clock.timers });
      expect(store.settings).toEqual(DEFAULT_GAME_SETTINGS);
      expect(store.update({ invertY: true })).toBe(true);
      expect(() => store.flush()).not.toThrow();
      expect(store.settings.invertY).toBe(true);
      store.dispose();
    }
  });

  it('applies at once, saves once after the debounce', () => {
    const { storage, clock, store } = make();
    const seen: number[] = [];
    store.subscribe((next, previous) => {
      expect(previous.settings).not.toBe(next.settings);
      seen.push(next.settings.fovDeg);
    });
    for (let fov = 70; fov <= 90; fov++) {
      expect(store.update({ fovDeg: fov })).toBe(true);
      clock.advance(16);
    }
    expect(seen).toHaveLength(21);
    expect(store.settings.fovDeg).toBe(90);
    expect(storage.writes).toBe(0);
    expect(store.dirty).toBe(true);
    clock.advance(SETTINGS_SAVE_DELAY_MS);
    expect(storage.writes).toBe(1);
    expect(store.dirty).toBe(false);
    const saved = parseSettingsData(storage.data.get(SETTINGS_STORAGE_KEY) ?? null);
    expect(saved.settings.fovDeg).toBe(90);
    clock.advance(SETTINGS_SAVE_MAX_DELAY_MS * 3);
    expect(storage.writes).toBe(1);
  });

  it('ignores patches that change nothing or are garbage', () => {
    const { storage, clock, store } = make();
    let calls = 0;
    store.subscribe(() => calls++);
    const before = store.settings;
    expect(store.update({})).toBe(false);
    expect(store.update(null)).toBe(false);
    expect(store.update('fovDeg=99')).toBe(false);
    expect(store.update({ fovDeg: 'wide', nonsense: 1 })).toBe(false);
    expect(store.update({ fovDeg: DEFAULT_GAME_SETTINGS.fovDeg })).toBe(false);
    expect(store.settings).toBe(before);
    expect(calls).toBe(0);
    clock.advance(10_000);
    expect(storage.writes).toBe(0);
  });

  it('clamps a hostile patch', () => {
    const { store } = make();
    store.update({ fovDeg: 1e12, masterVolume: -5, playerName: 'x'.repeat(1000) });
    expect(store.settings.fovDeg).toBe(100);
    expect(store.settings.masterVolume).toBe(0);
    expect(store.settings.playerName).toHaveLength(MAX_PLAYER_NAME_LENGTH);
  });

  it('flush on page hide saves a pending change immediately', () => {
    const { storage, store } = make();
    store.update({ invertY: true });
    store.flush();
    expect(storage.writes).toBe(1);
    store.flush();
    expect(storage.writes).toBe(1);
  });

  it('loads what another store saved, including bindings', () => {
    const first = make();
    first.store.update({ quality: 'high', uiScale: 1.25, turn: { url: 'turn:r:1' } });
    first.store.rebind('boost', 0, 'KeyV', false);
    first.store.flush();
    const text = first.storage.data.get(SETTINGS_STORAGE_KEY) ?? '';
    const second = make({ [SETTINGS_STORAGE_KEY]: text });
    expect(second.store.settings).toEqual(first.store.settings);
    expect(second.store.bindings.boost).toEqual(['KeyV', 'ShiftRight']);
    second.store.flush();
    expect(second.storage.writes).toBe(0);
  });

  it('rewrites an old save in the current format on the first flush, not on load', () => {
    const { storage, store } = make({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, quality: 'low' }),
      [LEGACY_NAME_STORAGE_KEY]: 'Kestrel',
    });
    expect(store.settings.quality).toBe('low');
    expect(store.settings.playerName).toBe('Kestrel');
    expect(storage.writes).toBe(0);
    store.flush();
    expect(storage.writes).toBe(1);
    const text = storage.data.get(SETTINGS_STORAGE_KEY) ?? '';
    expect(JSON.parse(text)).toMatchObject({ version: SETTINGS_VERSION, playerName: 'Kestrel' });
    expect(readStoredQuality(storage)).toBe('low');
  });

  it('edits bindings and replaces the controls object only when they change', () => {
    const { store } = make();
    const controls = store.controls;
    expect(store.rebind('boost', 0, 'ShiftLeft', false)).toBe(false);
    expect(store.rebind('nope', 0, 'KeyB', false)).toBe(false);
    expect(store.rebind('boost', 0, 'Escape', false)).toBe(false);
    expect(store.rebind('boost', 9, 'KeyB', false)).toBe(false);
    expect(store.unbind('utility', 1)).toBe(false);
    expect(store.controls).toBe(controls);
    expect(store.rebind('boost', 0, 'KeyB', false)).toBe(true);
    expect(store.controls).not.toBe(controls);
    expect(store.controls.bindings['boost']).toEqual(['KeyB', 'ShiftRight']);
    expect(store.unbind('boost', 1)).toBe(true);
    expect(store.bindings.boost).toEqual(['KeyB']);
    expect(store.resetBindings('boost')).toBe(true);
    expect(store.bindings).toEqual(DEFAULT_BINDINGS);
    expect(store.resetBindings(null)).toBe(false);
  });

  it('reset all restores settings and bindings', () => {
    const { store } = make();
    expect(store.reset()).toBe(false);
    store.update({ fovDeg: 95, signaling: 'lan' });
    store.rebind('flap', 0, 'KeyX', false);
    let last: unknown = null;
    store.subscribe((next) => {
      last = next;
    });
    expect(store.reset()).toBe(true);
    expect(store.settings).toEqual(DEFAULT_GAME_SETTINGS);
    expect(store.bindings).toEqual(DEFAULT_BINDINGS);
    expect(last).toBe(store.data);
  });

  it('dispose flushes and stops notifying', () => {
    const { storage, clock, store } = make();
    let calls = 0;
    store.subscribe(() => calls++);
    store.update({ invertY: true });
    store.dispose();
    expect(storage.writes).toBe(1);
    expect(store.update({ invertY: false })).toBe(false);
    clock.advance(10_000);
    expect(calls).toBe(1);
    expect(storage.writes).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it('never writes the relay credential anywhere but the settings key', () => {
    const { storage, store } = make();
    store.update({ turn: { url: 'turn:r:1', username: 'u', credential: 'hunter2' } });
    store.flush();
    for (const [key, value] of storage.data) {
      expect(value.includes('hunter2')).toBe(key === SETTINGS_STORAGE_KEY);
    }
  });

  it('serves the title screen as a name store', () => {
    const { store } = make();
    const names = createSettingsNameStore(store);
    names.save('  Wren  ');
    expect(names.load()).toBe('Wren');
    expect(store.settings.playerName).toBe('Wren');
  });
});

describe('binding bridge', () => {
  it('exposes the table for the UI', () => {
    const controls = controlsUiStateFor(DEFAULT_BINDINGS);
    expect(controls.actions).toContain('boost');
    expect(controls.reservedCodes).toContain('Escape');
    expect(controls.slotsPerAction).toBe(2);
    expect(controls.defaults).toBe(DEFAULT_BINDINGS);
  });

  it('steals a key without swap and trades keys with swap', () => {
    const stolen = applyRebind(DEFAULT_BINDINGS, 'pitchUp', 0, 'KeyS', false);
    expect(stolen.pitchUp).toEqual(['KeyS']);
    expect(stolen.pitchDown).toEqual([]);
    const swapped = applyRebind(DEFAULT_BINDINGS, 'pitchUp', 0, 'KeyS', true);
    expect(swapped.pitchUp).toEqual(['KeyS']);
    expect(swapped.pitchDown).toEqual(['KeyW']);
    expect(findBindingConflicts(swapped)).toEqual([]);
    // The traded key lands in the slot the other action lost.
    const second = applyRebind(DEFAULT_BINDINGS, 'utility', 0, 'KeyC', true);
    expect(second.utility).toEqual(['KeyC']);
    expect(second.dive).toEqual(['ControlLeft', 'KeyF']);
    const first = applyRebind(DEFAULT_BINDINGS, 'utility', 0, 'ShiftLeft', true);
    expect(first.boost).toEqual(['KeyF', 'ShiftRight']);
    // An empty slot has nothing to trade: the other action just loses the key.
    const added = applyRebind(DEFAULT_BINDINGS, 'utility', 1, 'KeyR', true);
    expect(added.utility).toEqual(['KeyF', 'KeyR']);
    expect(added.ultimate).toEqual([]);
    expect(DEFAULT_BINDINGS.pitchDown).toEqual(['KeyS']);
  });

  it('returns the same table for invalid requests', () => {
    const b = DEFAULT_BINDINGS;
    expect(applyRebind(b, 'boost', 0, '', false)).toBe(b);
    expect(applyRebind(b, 'boost', 0, 'MetaLeft', false)).toBe(b);
    expect(applyRebind(b, 'boost', 0, 'K'.repeat(500), false)).toBe(b);
    expect(applyRebind(b, 'boost', 0, 7, false)).toBe(b);
    expect(applyRebind(b, 'boost', 1.5, 'KeyB', false)).toBe(b);
    expect(applyRebind(b, 'boost', -1, 'KeyB', false)).toBe(b);
    expect(applyRebind(b, '__proto__', 0, 'KeyB', false)).toBe(b);
    expect(applyRebind(b, 'toString', 0, 'KeyB', false)).toBe(b);
    expect(applyUnbind(b, 'boost', 5)).toBe(b);
    expect(applyUnbind(b, 'constructor', 0)).toBe(b);
    expect(applyResetBindings(b, 'nope')).toBe(b);
    expect(applyResetBindings(b, undefined)).toBe(b);
  });

  it('resetting one action takes its default keys back from other actions', () => {
    let b = applyRebind(DEFAULT_BINDINGS, 'utility', 0, 'KeyG', false);
    b = applyRebind(b, 'ultimate', 0, 'KeyF', false);
    const reset = applyResetBindings(b, 'utility');
    expect(reset.utility).toEqual(['KeyF']);
    expect(reset.ultimate).toEqual([]);
    expect(findBindingConflicts(reset)).toEqual([]);
  });
});

describe('applySettings', () => {
  function recorder() {
    const calls: string[] = [];
    const targets: SettingsTargets = {
      setQuality: (preset) => calls.push(`quality ${preset}`),
      setResolution: (dynamic, min, cap) =>
        calls.push(`resolution ${dynamic} ${min.toFixed(2)} ${cap.toFixed(2)}`),
      setFrameCap: (fps) => calls.push(`frameCap ${fps}`),
      setCamera: (fov, shake, reduce) => calls.push(`camera ${fov} ${shake} ${reduce}`),
      setInput: (sens, invert, toggle) => calls.push(`input ${sens} ${invert} ${toggle}`),
      setBindings: (bindings) => calls.push(`bindings ${bindings.boost.join('+')}`),
      setVolumes: (master, sfx, music, ui) => calls.push(`volumes ${master} ${sfx} ${music} ${ui}`),
      setUi: (scale, markers, chip, reduce) =>
        calls.push(`ui ${scale} ${markers} ${chip} ${reduce}`),
      setTransport: (signaling, lanHost, turn) =>
        calls.push(`transport ${signaling} ${lanHost} ${turn === null ? 'direct' : 'relay'}`),
      setPlayerName: (name) => calls.push(`name ${name}`),
    };
    return { calls, targets };
  }
  const base = { settings: DEFAULT_GAME_SETTINGS, bindings: DEFAULT_BINDINGS };

  it('applies everything on the first call, quality before resolution', () => {
    const { calls, targets } = recorder();
    applySettings(targets, base, null);
    expect(calls).toEqual([
      'quality medium',
      'resolution true 0.60 0.85',
      'frameCap 0',
      'camera 62 1 false',
      'input 1 false false',
      'bindings ShiftLeft+ShiftRight',
      'volumes 1 1 0.7 0.8',
      'ui 1 false true false',
      'transport online  direct',
      'name ',
    ]);
  });

  it('calls only the targets whose values changed', () => {
    const { calls, targets } = recorder();
    const change = (patch: Partial<GameSettings>): string[] => {
      calls.length = 0;
      applySettings(
        targets,
        { settings: { ...DEFAULT_GAME_SETTINGS, ...patch }, bindings: DEFAULT_BINDINGS },
        base,
      );
      return [...calls];
    };
    expect(change({})).toEqual([]);
    expect(change({ quality: 'medium' })).toEqual([]);
    expect(change({ quality: 'high' })).toEqual(['quality high', 'resolution true 0.85 1.00']);
    expect(change({ renderScaleCap: 0.2 })).toEqual(['resolution true 0.60 0.65']);
    expect(change({ dynamicResolution: false })).toEqual(['resolution false 0.60 0.85']);
    expect(change({ fpsCap: 30 })).toEqual(['frameCap 30']);
    expect(change({ fovDeg: 90 })).toEqual(['camera 90 1 false']);
    expect(change({ reduceMotion: true })).toEqual(['camera 62 0 true', 'ui 1 false true true']);
    expect(change({ invertY: true })).toEqual(['input 1 true false']);
    expect(change({ boostToggle: true })).toEqual(['input 1 false true']);
    expect(change({ uiVolume: 0 })).toEqual(['volumes 1 1 0.7 0']);
    expect(change({ uiScale: 1.3 })).toEqual(['ui 1.3 false true false']);
    expect(change({ lanHost: 'pc' })).toEqual(['transport online pc direct']);
    expect(change({ playerName: 'Wren' })).toEqual(['name Wren']);
  });

  it('follows the store, and tolerates missing targets', () => {
    const clock = fakeClock();
    const store = createSettingsStore({ storage: null, now: clock.now, timers: clock.timers });
    const { calls, targets } = recorder();
    const stop = bindSettingsTargets(store, targets);
    expect(calls).toHaveLength(10);
    calls.length = 0;
    store.update({ sfxVolume: 0.5 });
    store.rebind('boost', 1, 'KeyB', false);
    expect(calls).toEqual(['volumes 1 0.5 0.7 0.8', 'bindings ShiftLeft+KeyB']);
    stop();
    store.update({ sfxVolume: 0.1 });
    expect(calls).toHaveLength(2);
    expect(() => applySettings({}, store.data, null)).not.toThrow();
  });
});

describe('handleSettingsIntent', () => {
  it('routes every settings intent and leaves the others alone', () => {
    const clock = fakeClock();
    const storage = memoryStorage();
    const store = createSettingsStore({ storage, now: clock.now, timers: clock.timers });
    const log: string[] = [];
    const hooks = {
      open: (tab: string | undefined) => log.push(`open ${tab ?? '-'}`),
      close: () => log.push('close'),
      redetectDisplay: () => log.push('redetect'),
    };
    expect(handleSettingsIntent(store, { type: 'match.pause' }, hooks)).toBe(false);
    expect(handleSettingsIntent(store, { type: 'settings.open', tab: 'audio' }, hooks)).toBe(true);
    handleSettingsIntent(store, { type: 'settings.update', patch: { invertY: true } }, hooks);
    expect(store.settings.invertY).toBe(true);
    handleSettingsIntent(
      store,
      { type: 'settings.rebind', action: 'pitchUp', slot: 0, code: 'KeyS', swap: true },
      hooks,
    );
    expect(store.bindings.pitchDown).toEqual(['KeyW']);
    handleSettingsIntent(store, { type: 'settings.unbind', action: 'dive', slot: 1 }, hooks);
    expect(store.bindings.dive).toEqual(['ControlLeft']);
    handleSettingsIntent(store, { type: 'settings.resetBindings', action: 'dive' }, hooks);
    expect(store.bindings.dive).toEqual(DEFAULT_BINDINGS.dive);
    handleSettingsIntent(store, { type: 'settings.resetBindings', action: null }, hooks);
    expect(store.bindings).toEqual(DEFAULT_BINDINGS);
    handleSettingsIntent(store, { type: 'settings.redetectDisplay' }, hooks);
    expect(storage.writes).toBe(0);
    handleSettingsIntent(store, { type: 'settings.close' }, hooks);
    expect(storage.writes).toBe(1);
    handleSettingsIntent(store, { type: 'settings.reset' }, hooks);
    expect(store.settings).toEqual(DEFAULT_GAME_SETTINGS);
    expect(log).toEqual(['open audio', 'redetect', 'close', 'redetect']);
    expect(() => handleSettingsIntent(store, { type: 'settings.close' })).not.toThrow();
  });
});

describe('FrameCap', () => {
  function drawn(cap: number, displayHz: number, seconds: number): number {
    const gate = new FrameCap();
    gate.setCap(cap);
    let count = 0;
    const frames = displayHz * seconds;
    for (let i = 0; i < frames; i++) if (gate.shouldRender((i * 1000) / displayHz)) count++;
    return count / seconds;
  }

  it('draws every frame with no cap', () => {
    expect(drawn(0, 60, 2)).toBe(60);
    expect(new FrameCap().shouldRender(0)).toBe(true);
  });

  it('holds the average at the cap on common displays', () => {
    expect(Math.abs(drawn(30, 60, 4) - 30)).toBeLessThan(1);
    expect(Math.abs(drawn(45, 60, 4) - 45)).toBeLessThan(1);
    expect(Math.abs(drawn(30, 144, 4) - 30)).toBeLessThan(1);
    expect(Math.abs(drawn(45, 120, 4) - 45)).toBeLessThan(1);
    // A display slower than the cap is not slowed further.
    expect(drawn(45, 30, 4)).toBe(30);
  });

  it('does not burst after a stall', () => {
    const gate = new FrameCap();
    gate.setCap(30);
    expect(gate.capFps).toBeCloseTo(30);
    expect(gate.shouldRender(0)).toBe(true);
    expect(gate.shouldRender(5000)).toBe(true);
    expect(gate.shouldRender(5016.7)).toBe(false);
    expect(gate.shouldRender(5033.3)).toBe(true);
  });
});
