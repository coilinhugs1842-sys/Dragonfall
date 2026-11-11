import { describe, expect, it } from 'vitest';
import { getQueryFlags, parseQueryFlags } from '../../src/dev/query-flags';

describe('parseQueryFlags', () => {
  it('has everything off for an empty query', () => {
    const off = { perf: false, debug: false, bench: false, quality: null };
    expect(parseQueryFlags('')).toEqual(off);
    expect(parseQueryFlags('?')).toEqual(off);
    expect(parseQueryFlags('?other=1')).toEqual(off);
  });

  it('turns on bare flags, with or without the leading question mark', () => {
    expect(parseQueryFlags('?perf')).toMatchObject({ perf: true, debug: false, bench: false });
    expect(parseQueryFlags('perf&debug')).toMatchObject({ perf: true, debug: true });
    expect(parseQueryFlags('?bench&perf=1')).toMatchObject({ perf: true, bench: true });
  });

  it('treats 0 / false / off / no as off', () => {
    for (const v of ['0', 'false', 'OFF', 'no']) {
      expect(parseQueryFlags(`?perf=${v}&debug`)).toMatchObject({ perf: false, debug: true });
    }
  });

  it('does not match flag names inside other parameters', () => {
    const flags = parseQueryFlags('?performance&room=debug');
    expect(flags.perf).toBe(false);
    expect(flags.debug).toBe(false);
  });

  it('accepts only known quality presets', () => {
    expect(parseQueryFlags('?quality=low').quality).toBe('low');
    expect(parseQueryFlags('?quality=HIGH').quality).toBe('high');
    expect(parseQueryFlags('?quality=ultra').quality).toBeNull();
    expect(parseQueryFlags('?quality').quality).toBeNull();
  });
});

describe('getQueryFlags', () => {
  it('is all off where there is no location (node)', () => {
    expect(getQueryFlags()).toEqual({ perf: false, debug: false, bench: false, quality: null });
  });
});
