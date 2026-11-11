import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_SETTINGS, SETTINGS_TABS } from '../../src/shared/ui';
import type { ControlsUiState, GameSettings, UiIntent } from '../../src/shared/ui';
import {
  actionLabel,
  beginCapture,
  canSwap,
  cancelCapture,
  captureCode,
  SHORT_CODE_LABEL_MAX,
  codeLabel,
  codeShortLabel,
  createRebindModel,
  findHolder,
  mouseCode,
  rebindPrompt,
  reconcileRebind,
  resolveConflict,
} from '../../src/ui/settings/rebind-model';
import {
  RANGE_FIELDS,
  SELECT_OPTIONS,
  SETTINGS_TAB_LABELS,
  TOGGLE_FIELDS,
  createRangeView,
  isSettingsTab,
  neighbourTab,
  qualityHint,
  rangeIntent,
  rangeSetting,
  rangeText,
  rangeView,
  selectIntent,
  selectValue,
  textIntent,
  toggleIntent,
  turnIntent,
} from '../../src/ui/settings/settings-model';

const DEFAULTS = {
  pitchUp: ['KeyW'],
  pitchDown: ['KeyS'],
  boost: ['ShiftLeft', 'ShiftRight'],
  utility: ['KeyF'],
  flare: [],
};

function controlsWith(bindings: Record<string, readonly string[]> = DEFAULTS): ControlsUiState {
  return {
    actions: Object.keys(DEFAULTS),
    bindings,
    defaults: DEFAULTS,
    reservedCodes: ['Escape', 'MetaLeft', 'MetaRight'],
    slotsPerAction: 2,
  };
}

function patchOf(intent: UiIntent | null): Record<string, unknown> {
  if (intent === null || intent.type !== 'settings.update') throw new Error('not an update');
  return intent.patch as Record<string, unknown>;
}

const withSettings = (patch: Partial<GameSettings>): GameSettings => ({
  ...DEFAULT_GAME_SETTINGS,
  ...patch,
});

describe('tabs', () => {
  it('has a label for every tab and steps round the list', () => {
    for (const tab of SETTINGS_TABS) expect(SETTINGS_TAB_LABELS[tab].length).toBeGreaterThan(0);
    expect(neighbourTab('video', 1)).toBe('controls');
    expect(neighbourTab('video', -1)).toBe('game');
    expect(neighbourTab('game', 1)).toBe('video');
    expect(isSettingsTab('audio')).toBe(true);
    expect(isSettingsTab('cheats')).toBe(false);
    expect(isSettingsTab(undefined)).toBe(false);
  });
});

describe('sliders', () => {
  const view = createRangeView();

  it('shows every slider inside its own range with a caption', () => {
    for (const field of RANGE_FIELDS) {
      rangeView(field, DEFAULT_GAME_SETTINGS, view);
      expect(view.min).toBeLessThan(view.max);
      expect(view.value).toBeGreaterThanOrEqual(view.min);
      expect(view.value).toBeLessThanOrEqual(view.max);
      expect(Number.isInteger(view.value)).toBe(true);
      expect((view.value - view.min) % view.step).toBe(0);
      expect(view.text).not.toBe('');
    }
  });

  it('round-trips every slider position through the setting', () => {
    const presets = ['auto', 'low', 'medium', 'high'] as const;
    for (const quality of presets) {
      const settings = withSettings({ quality });
      for (const field of RANGE_FIELDS) {
        rangeView(field, settings, view);
        const { min, max, step } = view;
        for (let raw = min; raw <= max; raw += step) {
          const next = { ...settings, ...patchOf(rangeIntent(field, raw, settings)) };
          expect(rangeView(field, next as GameSettings, view).value).toBe(raw);
        }
      }
    }
  });

  it('shows the resolution limit as the real scale of the preset', () => {
    expect(rangeView('renderScaleCap', withSettings({ quality: 'medium' }), view)).toMatchObject({
      min: 60,
      max: 85,
      step: 5,
      value: 85,
      text: '85 %',
    });
    const low = withSettings({ quality: 'low', renderScaleCap: 0 });
    expect(rangeView('renderScaleCap', low, view)).toMatchObject({ min: 50, max: 70, value: 50 });
    expect(rangeSetting('renderScaleCap', 60, low)).toBe(0.5);
    expect(rangeSetting('renderScaleCap', 999, low)).toBe(1);
    // The same fraction means the top of whichever preset is chosen.
    const high = withSettings({ quality: 'high', renderScaleCap: 1 });
    expect(rangeView('renderScaleCap', high, view).value).toBe(100);
  });

  it('maps slider units to setting units', () => {
    const s = DEFAULT_GAME_SETTINGS;
    expect(patchOf(rangeIntent('fovDeg', 75, s))).toEqual({ fovDeg: 75 });
    expect(patchOf(rangeIntent('mouseSensitivity', 125, s))).toEqual({ mouseSensitivity: 1.25 });
    expect(patchOf(rangeIntent('musicVolume', 40, s))).toEqual({ musicVolume: 0.4 });
    expect(patchOf(rangeIntent('uiScale', 130, s))).toEqual({ uiScale: 1.3 });
    expect(patchOf(rangeIntent('cameraShake', 0, s))).toEqual({ cameraShake: 0 });
    expect(patchOf(rangeIntent('sfxVolume', Number.NaN, s))).toEqual({ sfxVolume: 0 });
  });

  it('captions', () => {
    const s = DEFAULT_GAME_SETTINGS;
    expect(rangeText('fovDeg', 90, s)).toBe('90°');
    expect(rangeText('mouseSensitivity', 250, s)).toBe('2.50×');
    expect(rangeText('masterVolume', 0, s)).toBe('Muted');
    expect(rangeText('masterVolume', 35, s)).toBe('35 %');
    expect(rangeText('cameraShake', 0, s)).toBe('Off');
    expect(rangeText('uiScale', 80, s)).toBe('80 %');
    expect(rangeText('renderScaleCap', 70, s)).toBe('70 %');
  });
});

describe('switches, selects and text', () => {
  it('raises one patch per switch', () => {
    for (const field of TOGGLE_FIELDS) {
      expect(toggleIntent(field, true)).toEqual({
        type: 'settings.update',
        patch: { [field]: true },
      });
    }
  });

  it('maps select values to typed patches and refuses unknown values', () => {
    expect(patchOf(selectIntent('quality', 'auto'))).toEqual({ quality: 'auto' });
    expect(patchOf(selectIntent('quality', 'high'))).toEqual({ quality: 'high' });
    expect(patchOf(selectIntent('fpsCap', '45'))).toEqual({ fpsCap: 45 });
    expect(patchOf(selectIntent('fpsCap', '0'))).toEqual({ fpsCap: 0 });
    expect(patchOf(selectIntent('signaling', 'lan'))).toEqual({ signaling: 'lan' });
    expect(selectIntent('quality', 'ultra')).toBeNull();
    expect(selectIntent('fpsCap', '60')).toBeNull();
    expect(selectIntent('signaling', '')).toBeNull();
    for (const field of ['quality', 'fpsCap', 'signaling'] as const) {
      const values = SELECT_OPTIONS[field].map((option) => option.value);
      expect(values).toContain(selectValue(field, DEFAULT_GAME_SETTINGS));
    }
  });

  it('describes what the preset means', () => {
    expect(qualityHint(DEFAULT_GAME_SETTINGS)).toBe('Automatic is using Medium.');
    expect(qualityHint(withSettings({ quality: 'low' }))).toBe('Low: resolution 50–70 %.');
  });

  it('cuts text before it is sent', () => {
    expect(patchOf(textIntent('lanHost', '  host-pc  '))).toEqual({ lanHost: 'host-pc' });
    expect(patchOf(textIntent('playerName', 'x'.repeat(5000)))['playerName']).toHaveLength(64);
    expect(patchOf(textIntent('lanHost', 'h'.repeat(5000)))['lanHost']).toHaveLength(253);
  });

  it('turns the relay form into one patch', () => {
    expect(turnIntent('', 'user', 'secret')).toEqual({
      intent: { type: 'settings.update', patch: { turn: null } },
      problem: '',
    });
    expect(turnIntent('   ', '', '').intent).not.toBeNull();
    for (const url of ['relay.example.org', 'http://x', 'stun:x', 'turn:', 'turn:a b']) {
      expect(turnIntent(url, 'u', 'c')).toEqual({ intent: null, problem: 'url' });
    }
    expect(turnIntent(` turns:r.example:5349 `, 'u', 'c')).toEqual({
      intent: {
        type: 'settings.update',
        patch: { turn: { url: 'turns:r.example:5349', username: 'u', credential: 'c' } },
      },
      problem: '',
    });
    expect(turnIntent(`turn:${'h'.repeat(600)}`, '', '').problem).toBe('url');
    const long = turnIntent('turn:r', 'u'.repeat(900), 'c'.repeat(900));
    const turn = patchOf(long.intent)['turn'] as { username: string; credential: string };
    expect(turn.username).toHaveLength(512);
    expect(turn.credential).toHaveLength(512);
  });
});

describe('rebind capture flow', () => {
  it('binds a free key and returns to idle', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    expect(model.phase).toBe('idle');
    expect(beginCapture(model, controls, 'utility', 0)).toBe(true);
    expect(model.phase).toBe('listening');
    expect(rebindPrompt(model)).toContain('Utility ability');
    const revision = model.revision;
    expect(captureCode(model, controls, 'KeyG')).toEqual({
      type: 'settings.rebind',
      action: 'utility',
      slot: 0,
      code: 'KeyG',
      swap: false,
    });
    expect(model.phase).toBe('idle');
    expect(model.revision).toBeGreaterThan(revision);
    expect(rebindPrompt(model)).toBe('');
    // Nothing is captured while idle.
    expect(captureCode(model, controls, 'KeyH')).toBeNull();
  });

  it('refuses slots and actions that do not exist', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    expect(beginCapture(model, controls, 'nope', 0)).toBe(false);
    expect(beginCapture(model, controls, 'utility', 2)).toBe(false);
    expect(beginCapture(model, controls, 'utility', -1)).toBe(false);
    expect(beginCapture(model, controls, 'utility', 0.5)).toBe(false);
    expect(model.phase).toBe('idle');
  });

  it('aims an "add" at the first free slot', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'flare', 1);
    expect(model.slot).toBe(0);
    beginCapture(model, controls, 'utility', 1);
    expect(model.slot).toBe(1);
    expect(captureCode(model, controls, 'Mouse3')).toMatchObject({ slot: 1, code: 'Mouse3' });
  });

  it('Escape cancels and never binds', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'boost', 0);
    expect(captureCode(model, controls, 'Escape')).toBeNull();
    expect(model.phase).toBe('idle');
    beginCapture(model, controls, 'boost', 0);
    expect(cancelCapture(model)).toBe(true);
    expect(cancelCapture(model)).toBe(false);
  });

  it('keeps listening after a reserved key and says so', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'boost', 0);
    expect(captureCode(model, controls, 'MetaLeft')).toBeNull();
    expect(model.phase).toBe('listening');
    expect(model.note).toBe('reserved');
    expect(rebindPrompt(model)).toContain('cannot be used');
    expect(captureCode(model, controls, '')).toBeNull();
    expect(model.phase).toBe('listening');
    expect(captureCode(model, controls, 'KeyB')).toMatchObject({ code: 'KeyB' });
    expect(model.note).toBe('');
  });

  it('pressing the key the slot already has changes nothing', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'boost', 1);
    expect(captureCode(model, controls, 'ShiftRight')).toBeNull();
    expect(model.phase).toBe('idle');
  });

  it('moves a key between the slots of one action without a conflict', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'boost', 0);
    expect(captureCode(model, controls, 'ShiftRight')).toMatchObject({
      action: 'boost',
      slot: 0,
      code: 'ShiftRight',
      swap: false,
    });
  });

  it('Backspace clears a slot that has a key', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'boost', 1);
    expect(captureCode(model, controls, 'Backspace')).toEqual({
      type: 'settings.unbind',
      action: 'boost',
      slot: 1,
    });
    beginCapture(model, controls, 'flare', 0);
    expect(captureCode(model, controls, 'Backspace')).toBeNull();
    expect(model.phase).toBe('idle');
  });

  it('stops on a conflict and offers swap or cancel', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'pitchUp', 0);
    expect(captureCode(model, controls, 'KeyS')).toBeNull();
    expect(model).toMatchObject({
      phase: 'conflict',
      action: 'pitchUp',
      slot: 0,
      code: 'KeyS',
      holder: 'pitchDown',
      holderSlot: 0,
    });
    expect(rebindPrompt(model)).toBe('S is already Nose down.');
    expect(canSwap(model, controls)).toBe(true);
    // Keys pressed while the question is open are not captured.
    expect(captureCode(model, controls, 'KeyZ')).toBeNull();
    expect(model.phase).toBe('conflict');
    expect(resolveConflict(model, 'swap')).toEqual({
      type: 'settings.rebind',
      action: 'pitchUp',
      slot: 0,
      code: 'KeyS',
      swap: true,
    });
    expect(model.phase).toBe('idle');
    expect(resolveConflict(model, 'swap')).toBeNull();

    beginCapture(model, controls, 'pitchUp', 0);
    captureCode(model, controls, 'ShiftRight');
    expect(model.holder).toBe('boost');
    expect(model.holderSlot).toBe(1);
    expect(resolveConflict(model, 'cancel')).toBeNull();
    expect(model.phase).toBe('idle');
  });

  it('a conflict on an empty slot has nothing to swap back', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'flare', 0);
    captureCode(model, controls, 'KeyF');
    expect(model.phase).toBe('conflict');
    expect(canSwap(model, controls)).toBe(false);
    expect(resolveConflict(model, 'swap')).toMatchObject({ action: 'flare', code: 'KeyF' });
  });

  it('drops a capture when the table it pointed at goes away', () => {
    const model = createRebindModel();
    const controls = controlsWith();
    beginCapture(model, controls, 'flare', 0);
    reconcileRebind(model, controls);
    expect(model.phase).toBe('listening');
    reconcileRebind(model, { ...controls, actions: ['boost'] });
    expect(model.phase).toBe('idle');
    beginCapture(model, controls, 'boost', 0);
    reconcileRebind(model, undefined);
    expect(model.phase).toBe('idle');
  });

  it('finds who holds a code', () => {
    const controls = controlsWith();
    expect(findHolder(controls, 'ShiftRight', 'utility')).toEqual({ action: 'boost', slot: 1 });
    expect(findHolder(controls, 'ShiftRight', 'boost')).toBeNull();
    expect(findHolder(controls, 'KeyZ', 'boost')).toBeNull();
  });
});

describe('words', () => {
  it('names mouse buttons and keys', () => {
    expect(mouseCode(0)).toBe('Mouse0');
    expect(mouseCode(4)).toBe('Mouse4');
    expect(mouseCode(5)).toBeNull();
    expect(mouseCode(-1)).toBeNull();
    expect(mouseCode(1.5)).toBeNull();
    expect(codeLabel('KeyW')).toBe('W');
    expect(codeLabel('Digit7')).toBe('7');
    expect(codeLabel('Mouse2')).toBe('Right mouse');
    expect(codeLabel('ShiftLeft')).toBe('Left Shift');
    // The HUD's ability slots get the short form, one line whatever is bound.
    expect(codeShortLabel('Mouse0')).toBe('LMB');
    expect(codeShortLabel('Mouse2')).toBe('RMB');
    expect(codeShortLabel('Mouse4')).toBe('M5');
    expect(codeShortLabel('KeyF')).toBe('F');
    expect(codeShortLabel('ShiftRight')).toBe('RShift');
    expect(codeShortLabel('Numpad7')).toBe('N7');
    expect(codeShortLabel('NumpadEnter')).toBe('NEnter');
    expect(codeShortLabel('Space')).toBe('Space');
    for (const code of ['ScrollLock', 'ContextMenu', 'IntlBackslash', 'Mouse1', 'F12', 'Quote']) {
      expect(codeShortLabel(code).length, code).toBeGreaterThan(0);
      expect(codeShortLabel(code).length, code).toBeLessThanOrEqual(SHORT_CODE_LABEL_MAX);
    }
    expect(codeLabel('F11')).toBe('F11');
    expect(codeLabel('Numpad4')).toBe('Num 4');
    expect(codeLabel('NumpadEnter')).toBe('Num Enter');
    expect(codeLabel('ScrollLock')).toBe('Scroll Lock');
    expect(codeLabel('X'.repeat(200)).length).toBeLessThanOrEqual(24);
  });

  it('names actions, including ones it has never heard of', () => {
    expect(actionLabel('pitchUp')).toBe('Nose up');
    expect(actionLabel('airBrake')).toBe('Air brake');
    expect(actionLabel('toString')).toBe('To string');
  });
});
