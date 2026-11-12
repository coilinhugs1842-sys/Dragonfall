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
      benchSeconds: 0,
      autopilot: false,
      skipSeconds: 0,
      quality: null,
      autoQuality: false,
      netsim: null,
      bots: 0,
      lan: false,
      solo: false,
      autostart: false,
      noWorker: false,
      autopilotBot: false,
      mode: null,
      map: null,
      scoreLimit: 0,
      timeLimitS: -1,
      teamSize: 0,
      botLevel: null,
      fillBots: false,
      lagCompensation: true,
      joinCode: '',
      noCinematics: false,
      record: false,
      viewer: '',
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

  it('reads ?bench as a length in seconds, 60 by default', () => {
    expect(parseQueryFlags('?bench').benchSeconds).toBe(60);
    expect(parseQueryFlags('?bench=1').benchSeconds).toBe(60);
    expect(parseQueryFlags('?bench=20').benchSeconds).toBe(20);
    expect(parseQueryFlags('?bench=2').benchSeconds).toBe(5);
    expect(parseQueryFlags('?bench=99999').benchSeconds).toBe(MAX_SKIP_SECONDS);
    expect(parseQueryFlags('?bench=0')).toMatchObject({ bench: false, benchSeconds: 0 });
    expect(parseQueryFlags('?bench=junk').benchSeconds).toBe(60);
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

  it('reads ?autoquality as a switch of its own, apart from ?quality=', () => {
    expect(parseQueryFlags('?autoquality').autoQuality).toBe(true);
    expect(parseQueryFlags('?autoquality=0').autoQuality).toBe(false);
    expect(parseQueryFlags('?quality=low').autoQuality).toBe(false);
    expect(parseQueryFlags('?autoquality&quality=low')).toMatchObject({
      autoQuality: true,
      quality: 'low',
    });
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

describe('match set-up flags', () => {
  it('reads the mode, limits, team size, bot skill and fill', () => {
    const flags = parseQueryFlags('?mode=Duel&score=5&time=0&teamsize=2&botlevel=hard&fill');
    expect(flags).toMatchObject({
      mode: 'duel',
      scoreLimit: 5,
      timeLimitS: 0,
      teamSize: 2,
      botLevel: 'hard',
      fillBots: true,
    });
    // A mode that has not shipped, and junk, are ignored.
    expect(parseQueryFlags('?mode=skyCrown').mode).toBeNull();
    expect(parseQueryFlags('?mode=x&score=-3&teamsize=9&botlevel=god')).toMatchObject({
      mode: null,
      scoreLimit: 0,
      teamSize: 5,
      botLevel: null,
    });
  });

  it('reads ?map as a map id, in any letter case, next to the other set-up flags', () => {
    expect(parseQueryFlags('?map=emberfall-caldera').map).toBe('emberfall-caldera');
    expect(parseQueryFlags('?map=Emberfall-Caldera%20').map).toBe('emberfall-caldera');
    expect(parseQueryFlags('?map=shattered-spires').map).toBe('shattered-spires');
    expect(parseQueryFlags('?solo&map=emberfall-caldera&autopilot')).toMatchObject({
      solo: true,
      map: 'emberfall-caldera',
      autopilot: true,
    });
    expect(parseQueryFlags('?bench=20&map=emberfall-caldera')).toMatchObject({
      bench: true,
      map: 'emberfall-caldera',
    });
    // Junk, an empty value and a bare flag pick no map.
    expect(parseQueryFlags('?map=greybox').map).toBeNull();
    expect(parseQueryFlags('?map=').map).toBeNull();
    expect(parseQueryFlags('?map').map).toBeNull();
    expect(parseQueryFlags('?map=toString').map).toBeNull();
  });

  it('reads ?autopilot=bot, ?lagcomp=0 and ?join', () => {
    expect(parseQueryFlags('?autopilot=bot')).toMatchObject({
      autopilot: true,
      autopilotBot: true,
    });
    expect(parseQueryFlags('?autopilot').autopilotBot).toBe(false);
    expect(parseQueryFlags('?lagcomp=0').lagCompensation).toBe(false);
    expect(parseQueryFlags('?lagcomp').lagCompensation).toBe(true);
    expect(parseQueryFlags('?join=abcde').joinCode).toBe('ABCDE');
  });

  it('reads ?record, with or without a frame rate', () => {
    expect(parseQueryFlags('?record').record).toBe(true);
    expect(parseQueryFlags('?record=30').record).toBe(true);
    expect(parseQueryFlags('?record=0').record).toBe(false);
  });
});

describe('getQueryFlags', () => {
  it('is all off where there is no location (node)', () => {
    expect(getQueryFlags()).toEqual({
      perf: false,
      debug: false,
      bench: false,
      benchSeconds: 0,
      autopilot: false,
      skipSeconds: 0,
      quality: null,
      autoQuality: false,
      netsim: null,
      bots: 0,
      lan: false,
      solo: false,
      autostart: false,
      noWorker: false,
      autopilotBot: false,
      mode: null,
      map: null,
      scoreLimit: 0,
      timeLimitS: -1,
      teamSize: 0,
      botLevel: null,
      fillBots: false,
      lagCompensation: true,
      joinCode: '',
      noCinematics: false,
      record: false,
      viewer: '',
    });
  });
});
