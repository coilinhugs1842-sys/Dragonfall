import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BINDINGS,
  INPUT_ACTIONS,
  MAX_CODES_PER_ACTION,
  bindingsEqual,
  cloneBindings,
  findBindingConflicts,
  findUnboundActions,
  inputActionBit,
  isBindableCode,
  isMouseCode,
  mouseButtonCode,
  parseBindings,
  rebindAction,
  resetActionBinding,
  resetBindings,
  serializeBindings,
  unbindAction,
} from '../../src/input';

describe('default bindings', () => {
  it('follow the controls table and have no conflicts', () => {
    expect(DEFAULT_BINDINGS.boost).toContain('ShiftLeft');
    expect(DEFAULT_BINDINGS.flap).toEqual(['Space']);
    expect(DEFAULT_BINDINGS.dive).toContain('ControlLeft');
    expect(DEFAULT_BINDINGS.dodgeLeft).toEqual(['KeyQ']);
    expect(DEFAULT_BINDINGS.dodgeRight).toEqual(['KeyE']);
    expect(DEFAULT_BINDINGS.primary).toEqual(['Mouse0']);
    expect(DEFAULT_BINDINGS.secondary).toEqual(['Mouse2']);
    expect(DEFAULT_BINDINGS.utility).toEqual(['KeyF']);
    expect(DEFAULT_BINDINGS.ultimate).toEqual(['KeyR']);
    expect(DEFAULT_BINDINGS.scoreboard).toEqual(['Tab']);
    expect(findBindingConflicts(DEFAULT_BINDINGS)).toEqual([]);
    expect(findUnboundActions(DEFAULT_BINDINGS)).toEqual([]);
    for (const action of INPUT_ACTIONS) {
      expect(DEFAULT_BINDINGS[action].length).toBeLessThanOrEqual(MAX_CODES_PER_ACTION);
      for (const code of DEFAULT_BINDINGS[action]) expect(isBindableCode(code)).toBe(true);
    }
  });

  it('gives every action its own bit', () => {
    const bits = INPUT_ACTIONS.map(inputActionBit);
    expect(new Set(bits).size).toBe(INPUT_ACTIONS.length);
    expect(INPUT_ACTIONS.length).toBeLessThanOrEqual(31);
  });

  it('maps mouse buttons to codes', () => {
    expect(mouseButtonCode(0)).toBe('Mouse0');
    expect(mouseButtonCode(2)).toBe('Mouse2');
    expect(mouseButtonCode(7)).toBeUndefined();
    expect(isMouseCode('Mouse1')).toBe(true);
    expect(isMouseCode('KeyW')).toBe(false);
  });
});

describe('rebindAction', () => {
  it('replaces a slot without touching the input table', () => {
    const before = serializeBindings(DEFAULT_BINDINGS);
    const next = rebindAction(DEFAULT_BINDINGS, 'flap', 0, 'KeyV');
    expect(next.flap).toEqual(['KeyV']);
    expect(serializeBindings(DEFAULT_BINDINGS)).toBe(before);
    expect(next).not.toBe(DEFAULT_BINDINGS);
  });

  it('appends an alternative in slot 1 and replaces an existing alternative', () => {
    const added = rebindAction(DEFAULT_BINDINGS, 'flap', 1, 'KeyV');
    expect(added.flap).toEqual(['Space', 'KeyV']);
    const replaced = rebindAction(added, 'flap', 1, 'KeyB');
    expect(replaced.flap).toEqual(['Space', 'KeyB']);
  });

  it('steals the code from other actions by default', () => {
    const next = rebindAction(DEFAULT_BINDINGS, 'flap', 0, 'KeyF');
    expect(next.flap).toEqual(['KeyF']);
    expect(next.utility).toEqual([]);
    expect(findBindingConflicts(next)).toEqual([]);
    expect(findUnboundActions(next)).toEqual(['utility']);
  });

  it('can leave a conflict for the UI to report', () => {
    const next = rebindAction(DEFAULT_BINDINGS, 'flap', 0, 'KeyF', { steal: false });
    expect(findBindingConflicts(next)).toEqual([{ code: 'KeyF', actions: ['flap', 'utility'] }]);
  });

  it('does not duplicate a code inside one action', () => {
    const next = rebindAction(DEFAULT_BINDINGS, 'boost', 0, 'ShiftRight');
    expect(next.boost).toEqual(['ShiftRight']);
    const same = rebindAction(DEFAULT_BINDINGS, 'boost', 1, 'ShiftRight');
    expect(same.boost).toEqual(['ShiftLeft', 'ShiftRight']);
  });

  it('refuses reserved codes and bad slots', () => {
    expect(
      bindingsEqual(rebindAction(DEFAULT_BINDINGS, 'flap', 0, 'Escape'), DEFAULT_BINDINGS),
    ).toBe(true);
    expect(bindingsEqual(rebindAction(DEFAULT_BINDINGS, 'flap', 0, ''), DEFAULT_BINDINGS)).toBe(
      true,
    );
    expect(bindingsEqual(rebindAction(DEFAULT_BINDINGS, 'flap', 5, 'KeyV'), DEFAULT_BINDINGS)).toBe(
      true,
    );
    expect(
      bindingsEqual(rebindAction(DEFAULT_BINDINGS, 'flap', -1, 'KeyV'), DEFAULT_BINDINGS),
    ).toBe(true);
  });
});

describe('unbind and reset', () => {
  it('unbinds one slot', () => {
    expect(unbindAction(DEFAULT_BINDINGS, 'boost', 0).boost).toEqual(['ShiftRight']);
    expect(unbindAction(DEFAULT_BINDINGS, 'flap', 0).flap).toEqual([]);
  });

  it('resets one action or the whole table', () => {
    let table = rebindAction(DEFAULT_BINDINGS, 'flap', 0, 'KeyV');
    table = rebindAction(table, 'ultimate', 0, 'KeyG');
    const one = resetActionBinding(table, 'flap');
    expect(one.flap).toEqual(['Space']);
    expect(one.ultimate).toEqual(['KeyG']);
    expect(bindingsEqual(resetBindings(), DEFAULT_BINDINGS)).toBe(true);
    expect(resetBindings()).not.toBe(DEFAULT_BINDINGS);
    expect(resetBindings().flap).not.toBe(DEFAULT_BINDINGS.flap);
  });
});

describe('serialise / parse', () => {
  it('round-trips', () => {
    const table = rebindAction(unbindAction(DEFAULT_BINDINGS, 'scoreboard', 0), 'dive', 1, 'KeyX');
    const parsed = parseBindings(serializeBindings(table));
    expect(bindingsEqual(parsed, table)).toBe(true);
    expect(parsed.scoreboard).toEqual([]);
  });

  it('falls back to the defaults on broken input and never throws', () => {
    for (const text of [
      null,
      undefined,
      '',
      '{',
      '42',
      'null',
      '[]',
      '{"version":99,"bindings":{}}',
    ]) {
      expect(bindingsEqual(parseBindings(text), DEFAULT_BINDINGS)).toBe(true);
    }
  });

  it('repairs a partly valid table', () => {
    const parsed = parseBindings(
      JSON.stringify({
        version: 1,
        bindings: {
          flap: ['KeyV', 'KeyV', 7, 'Escape', 'KeyB', 'KeyN'],
          boost: 'ShiftLeft',
          madeUp: ['KeyZ'],
        },
      }),
    );
    expect(parsed.flap).toEqual(['KeyV', 'KeyB']);
    expect(parsed.boost).toEqual(DEFAULT_BINDINGS.boost);
    expect(parsed.dive).toEqual(DEFAULT_BINDINGS.dive);
    expect(Object.keys(parsed).sort()).toEqual([...INPUT_ACTIONS].sort());
  });

  it('cloneBindings copies deeply', () => {
    const copy = cloneBindings(DEFAULT_BINDINGS);
    expect(copy).toEqual(DEFAULT_BINDINGS);
    expect(copy.boost).not.toBe(DEFAULT_BINDINGS.boost);
  });
});
