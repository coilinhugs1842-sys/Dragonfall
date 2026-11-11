import { describe, expect, it } from 'vitest';
import { NETSIM_PROFILES } from '../../src/dev/netsim/profile';
import {
  MAX_BOTS,
  MAX_SKIP_SECONDS,
  getQueryFlags,
  parseQueryFlags,
} from '../../src/dev/query-flags';

describe('parseQueryFlags', () => {
  it('has everything off for an empty query', () => {
    const off = {
      perf: false,
      debug: false,
      bench: false,
      autopilot: false,
      skipSeconds: 0,
      quality: null,
      netsim: null,
      bots: 0,
      lan: false,
      solo: false,
      autostart: false,
      noWorker: false,
    };
    expect(parseQueryFlags('')).toEqual(off);
    expect(parseQueryFlags('?')).toEqual(off);
    expect(parseQueryFlags('?other=1')).toEqual(off);
  });

  it('turns on bare flags, with or without the leading question mark', () => {
    expect(parseQueryFlags('?perf')).toMatchObject({ perf: true, debug: false, bench: false });
    expect(parseQueryFlags('perf&debug')).toMatchObject({ perf: true, debug: true });
    expect(parseQueryFlags('?bench&perf=1')).toMatchObject({ perf: true, bench: true });
    expect(parseQueryFlags('?perf&autopilot')).toMatchObject({ perf: true, autopilot: true });
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

  it('reads ?skip as seconds, ignoring junk and capping the value', () => {
    expect(parseQueryFlags('?skip=20').skipSeconds).toBe(20);
    expect(parseQueryFlags('?skip=2.5').skipSeconds).toBe(2.5);
    expect(parseQueryFlags('?skip').skipSeconds).toBe(0);
    expect(parseQueryFlags('?skip=-3').skipSeconds).toBe(0);
    expect(parseQueryFlags('?skip=soon').skipSeconds).toBe(0);
    expect(parseQueryFlags('?skip=Infinity').skipSeconds).toBe(MAX_SKIP_SECONDS);
    expect(parseQueryFlags('?skip=99999').skipSeconds).toBe(MAX_SKIP_SECONDS);
  });

  it('accepts only known quality presets', () => {
    expect(parseQueryFlags('?quality=low').quality).toBe('low');
    expect(parseQueryFlags('?quality=HIGH').quality).toBe('high');
    expect(parseQueryFlags('?quality=ultra').quality).toBeNull();
    expect(parseQueryFlags('?quality').quality).toBeNull();
  });

  it('reads ?netsim as a profile name or as latency,jitter,loss', () => {
    expect(parseQueryFlags('?netsim=bad').netsim).toBe(NETSIM_PROFILES.bad);
    expect(parseQueryFlags('?netsim=AWFUL&perf').netsim).toBe(NETSIM_PROFILES.awful);
    expect(parseQueryFlags('?netsim').netsim).toBe(NETSIM_PROFILES.bad);
    expect(parseQueryFlags('?netsim=off').netsim).toBe(NETSIM_PROFILES.off);
    expect(parseQueryFlags('?netsim=0').netsim).toBe(NETSIM_PROFILES.off);
    expect(parseQueryFlags('?netsim=80,20,2').netsim).toEqual({
      name: 'custom',
      latencyMs: 80,
      jitterMs: 20,
      lossPct: 2,
      duplicatePct: 0,
      reorderPct: 0,
    });
    expect(parseQueryFlags('?netsim=80%2C20%2C2').netsim).toMatchObject({ latencyMs: 80 });
    expect(parseQueryFlags('?netsim=dreadful').netsim).toBeNull();
    expect(parseQueryFlags('?netsimulator=bad').netsim).toBeNull();
  });

  it('reads ?bots as a whole number, ignoring junk and capping the value', () => {
    expect(MAX_BOTS).toBe(9);
    expect(parseQueryFlags('?bots=8').bots).toBe(8);
    expect(parseQueryFlags('?bots=2.9').bots).toBe(2);
    expect(parseQueryFlags('?bots').bots).toBe(0);
    expect(parseQueryFlags('?bots=0').bots).toBe(0);
    expect(parseQueryFlags('?bots=-2').bots).toBe(0);
    expect(parseQueryFlags('?bots=many').bots).toBe(0);
    expect(parseQueryFlags('?bots=50').bots).toBe(MAX_BOTS);
    expect(parseQueryFlags('?bots=Infinity').bots).toBe(MAX_BOTS);
  });

  it('reads ?lan like the other on/off flags', () => {
    expect(parseQueryFlags('?lan').lan).toBe(true);
    expect(parseQueryFlags('?lan=1&bots=3')).toMatchObject({ lan: true, bots: 3 });
    expect(parseQueryFlags('?solo&autostart=0')).toMatchObject({ solo: true, autostart: false });
    expect(parseQueryFlags('?autostart&bots=8')).toMatchObject({ autostart: true, bots: 8 });
    expect(parseQueryFlags('?lan=0').lan).toBe(false);
    expect(parseQueryFlags('?plan').lan).toBe(false);
  });

  it('reads ?noworker (the host sim stays on the main thread)', () => {
    expect(parseQueryFlags('?noworker').noWorker).toBe(true);
    expect(parseQueryFlags('?noworker=0').noWorker).toBe(false);
    expect(parseQueryFlags('?worker').noWorker).toBe(false);
    expect(parseQueryFlags('?autostart&bots=9&noworker')).toMatchObject({
      autostart: true,
      bots: 9,
      noWorker: true,
    });
  });
});

describe('getQueryFlags', () => {
  it('is all off where there is no location (node)', () => {
    expect(getQueryFlags()).toEqual({
      perf: false,
      debug: false,
      bench: false,
      autopilot: false,
      skipSeconds: 0,
      quality: null,
      netsim: null,
      bots: 0,
      lan: false,
      solo: false,
      autostart: false,
      noWorker: false,
    });
  });
});
