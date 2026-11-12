import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BINDINGS,
  DEFAULT_GAMEPAD_BINDINGS,
  GAMEPAD_BUTTON_CODES,
  GAMEPAD_BUTTON_COUNT,
  GAMEPAD_FLICK_LEFT,
  GAMEPAD_FLICK_RIGHT,
  INPUT_ACTIONS,
  MAX_CODES_PER_ACTION,
  RESERVED_CODES,
  bindingsEqual,
  findBindingConflicts,
  findUnboundActions,
  gamepadButtonCode,
  gamepadButtonIndex,
  gamepadCodeLabel,
  gamepadCodeShortLabel,
  isBindableCode,
  isGamepadCode,
  parseBindings,
  parseGamepadBindings,
  rebindAction,
  resetActionBinding,
  resetGamepadBindings,
  serializeBindings,
  unbindAction,
} from '../../src/input';

describe('default gamepad bindings', () => {
  it('follow the controls table', () => {
    expect(DEFAULT_GAMEPAD_BINDINGS.boost).toEqual(['Pad4']); // LB
    expect(DEFAULT_GAMEPAD_BINDINGS.flap).toEqual(['Pad0']); // A
    expect(DEFAULT_GAMEPAD_BINDINGS.dive).toEqual(['Pad1']); // B
    expect(DEFAULT_GAMEPAD_BINDINGS.primary).toEqual(['Pad7']); // RT
    expect(DEFAULT_GAMEPAD_BINDINGS.secondary).toEqual(['Pad6']); // LT
    expect(DEFAULT_GAMEPAD_BINDINGS.utility).toEqual(['Pad2']); // X
    expect(DEFAULT_GAMEPAD_BINDINGS.ultimate).toEqual(['Pad3']); // Y
    expect(DEFAULT_GAMEPAD_BINDINGS.scoreboard).toEqual(['Pad8']); // View
    expect(DEFAULT_GAMEPAD_BINDINGS.dodgeLeft).toEqual([GAMEPAD_FLICK_LEFT]);
    expect(DEFAULT_GAMEPAD_BINDINGS.dodgeRight).toEqual([GAMEPAD_FLICK_RIGHT]);
  });

  it('bind every action, to gamepad codes only, without conflicts', () => {
    expect(findBindingConflicts(DEFAULT_GAMEPAD_BINDINGS)).toEqual([]);
    expect(findUnboundActions(DEFAULT_GAMEPAD_BINDINGS)).toEqual([]);
    for (const action of INPUT_ACTIONS) {
      const codes = DEFAULT_GAMEPAD_BINDINGS[action];
      expect(codes.length).toBeLessThanOrEqual(MAX_CODES_PER_ACTION);
      for (const code of codes) {
        expect(isGamepadCode(code)).toBe(true);
        expect(isBindableCode(code)).toBe(true);
      }
    }
  });

  it('share no code with the keyboard table', () => {
    for (const action of INPUT_ACTIONS) {
      for (const code of DEFAULT_BINDINGS[action]) expect(isGamepadCode(code)).toBe(false);
    }
  });
});

describe('gamepad codes', () => {
  it('map button indices to codes and back', () => {
    expect(GAMEPAD_BUTTON_CODES.length).toBe(GAMEPAD_BUTTON_COUNT);
    for (let i = 0; i < GAMEPAD_BUTTON_COUNT; i++) {
      const code = gamepadButtonCode(i);
      expect(code).toBe(`Pad${i}`);
      expect(gamepadButtonIndex(code ?? '')).toBe(i);
    }
    expect(gamepadButtonCode(17)).toBeUndefined();
    expect(gamepadButtonCode(-1)).toBeUndefined();
    expect(gamepadButtonIndex('KeyW')).toBe(-1);
    expect(gamepadButtonIndex(GAMEPAD_FLICK_LEFT)).toBe(-1);
    expect(isGamepadCode(GAMEPAD_FLICK_RIGHT)).toBe(true);
    expect(isGamepadCode('Pad17')).toBe(false);
    expect(isGamepadCode('Mouse0')).toBe(false);
  });

  it('reserve Menu (pause) and Home (the OS)', () => {
    expect(RESERVED_CODES).toContain('Pad9');
    expect(RESERVED_CODES).toContain('Pad16');
    expect(isBindableCode('Pad9')).toBe(false);
    const refused = rebindAction(DEFAULT_GAMEPAD_BINDINGS, 'flap', 0, 'Pad9');
    expect(bindingsEqual(refused, DEFAULT_GAMEPAD_BINDINGS)).toBe(true);
  });

  it('label the standard buttons, short enough for a HUD slot', () => {
    const short = GAMEPAD_BUTTON_CODES.map(gamepadCodeShortLabel);
    expect(short.slice(0, 12)).toEqual([
      'A',
      'B',
      'X',
      'Y',
      'LB',
      'RB',
      'LT',
      'RT',
      'View',
      'Menu',
      'LS',
      'RS',
    ]);
    const all = [...GAMEPAD_BUTTON_CODES, GAMEPAD_FLICK_LEFT, GAMEPAD_FLICK_RIGHT];
    for (const code of all) {
      expect(gamepadCodeLabel(code).length).toBeGreaterThan(0);
      const label = gamepadCodeShortLabel(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(6);
    }
    expect(new Set(all.map(gamepadCodeShortLabel)).size).toBe(all.length);
    expect(new Set(all.map(gamepadCodeLabel)).size).toBe(all.length);
    expect(gamepadCodeLabel('Pad12')).toBe('D-pad up');
    // Not a gamepad code: the caller falls through to its keyboard labels.
    expect(gamepadCodeLabel('KeyW')).toBe('');
    expect(gamepadCodeShortLabel('Mouse0')).toBe('');
  });
});

describe('the shared table functions on the gamepad table', () => {
  it('rebind, steal, unbind and reset a row', () => {
    const onButton = rebindAction(DEFAULT_GAMEPAD_BINDINGS, 'dodgeLeft', 0, 'Pad5');
    expect(onButton.dodgeLeft).toEqual(['Pad5']);
    const stolen = rebindAction(DEFAULT_GAMEPAD_BINDINGS, 'flap', 0, 'Pad1');
    expect(stolen.flap).toEqual(['Pad1']);
    expect(stolen.dive).toEqual([]);
    expect(unbindAction(DEFAULT_GAMEPAD_BINDINGS, 'dodgeRight', 0).dodgeRight).toEqual([]);

    const back = resetActionBinding(onButton, 'dodgeLeft', DEFAULT_GAMEPAD_BINDINGS);
    expect(bindingsEqual(back, DEFAULT_GAMEPAD_BINDINGS)).toBe(true);
    // Without the table it still means the keyboard's defaults.
    expect(resetActionBinding(onButton, 'dodgeLeft').dodgeLeft).toEqual(['KeyQ']);
    expect(bindingsEqual(resetGamepadBindings(), DEFAULT_GAMEPAD_BINDINGS)).toBe(true);
    expect(resetGamepadBindings()).not.toBe(DEFAULT_GAMEPAD_BINDINGS);
  });

  it('round-trips through the serialised form', () => {
    const table = rebindAction(
      unbindAction(DEFAULT_GAMEPAD_BINDINGS, 'dive', 0),
      'flap',
      1,
      'Pad5',
    );
    const parsed = parseGamepadBindings(serializeBindings(table));
    expect(bindingsEqual(parsed, table)).toBe(true);
    expect(parsed.dive).toEqual([]);
  });

  it('falls back to the gamepad defaults, never the keyboard ones', () => {
    for (const text of [null, undefined, '', '{', '42', '{"version":99,"bindings":{}}']) {
      expect(bindingsEqual(parseGamepadBindings(text), DEFAULT_GAMEPAD_BINDINGS)).toBe(true);
    }
    const partial = parseGamepadBindings(
      JSON.stringify({ version: 1, bindings: { flap: ['Pad5'], boost: 'Pad4' } }),
    );
    expect(partial.flap).toEqual(['Pad5']);
    expect(partial.boost).toEqual(['Pad4']);
    expect(partial.primary).toEqual(['Pad7']);
    // The keyboard reader is unchanged by the new parameter.
    expect(bindingsEqual(parseBindings(null), DEFAULT_BINDINGS)).toBe(true);
  });

  it('drops keyboard, reserved and unknown codes from a gamepad table', () => {
    const parsed = parseGamepadBindings(
      JSON.stringify({
        version: 1,
        bindings: { flap: ['KeyV', 'Pad5'], dive: ['Pad9'], utility: ['Pad99'], ultimate: [] },
      }),
    );
    expect(parsed.flap).toEqual(['Pad5']);
    expect(parsed.dive).toEqual([]);
    expect(parsed.utility).toEqual([]);
    expect(parsed.ultimate).toEqual([]);
  });
});
