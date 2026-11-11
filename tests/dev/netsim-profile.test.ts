import { describe, expect, it } from 'vitest';
import { addNetsimFolder, createNetsim, createNetsimGuiModel } from '../../src/dev/netsim';
import type { NetsimGuiParent } from '../../src/dev/netsim';
import {
  DEFAULT_NETSIM_PROFILE,
  NETSIM_LIMITS,
  NETSIM_PROFILES,
  NETSIM_PROFILE_NAMES,
  createNetsimProfile,
  describeNetsimProfile,
  isNetsimProfileName,
  parseNetsimProfile,
} from '../../src/dev/netsim/profile';

describe('netsim profiles', () => {
  it('has the named profiles with the documented numbers', () => {
    expect(NETSIM_PROFILE_NAMES).toEqual(['off', 'lan', 'wifi', 'bad', 'awful']);
    const row = (name: (typeof NETSIM_PROFILE_NAMES)[number]): number[] => {
      const p = NETSIM_PROFILES[name];
      expect(p.name).toBe(name);
      expect(p.duplicatePct).toBe(0);
      expect(p.reorderPct).toBe(0);
      return [p.latencyMs, p.jitterMs, p.lossPct];
    };
    expect(row('off')).toEqual([0, 0, 0]);
    expect(row('lan')).toEqual([2, 1, 0]);
    expect(row('wifi')).toEqual([20, 8, 0.5]);
    // The standard profile of docs/NETWORKING.md.
    expect(row('bad')).toEqual([80, 20, 2]);
    expect(row('awful')).toEqual([150, 50, 5]);
    expect(DEFAULT_NETSIM_PROFILE).toBe(NETSIM_PROFILES.bad);
    expect(Object.isFrozen(NETSIM_PROFILES.bad)).toBe(true);
  });

  it('recognises profile names only', () => {
    expect(isNetsimProfileName('bad')).toBe(true);
    expect(isNetsimProfileName('custom')).toBe(false);
    expect(isNetsimProfileName('toString')).toBe(false);
    expect(isNetsimProfileName(3)).toBe(false);
  });

  it('describes a profile for logs', () => {
    expect(describeNetsimProfile(NETSIM_PROFILES.bad)).toBe('bad (80 ms ±20, 2% loss)');
    expect(describeNetsimProfile(createNetsimProfile(10, 2, 1, 3, 4))).toBe(
      'custom (10 ms ±2, 1% loss, 3% dup, 4% reorder)',
    );
  });
});

describe('parseNetsimProfile', () => {
  it('parses names, case-insensitively and trimmed', () => {
    expect(parseNetsimProfile('bad')).toBe(NETSIM_PROFILES.bad);
    expect(parseNetsimProfile(' WiFi ')).toBe(NETSIM_PROFILES.wifi);
    expect(parseNetsimProfile('awful')).toBe(NETSIM_PROFILES.awful);
    expect(parseNetsimProfile('lan')).toBe(NETSIM_PROFILES.lan);
    expect(parseNetsimProfile('off')).toBe(NETSIM_PROFILES.off);
  });

  it('treats a bare flag as the standard profile and 0 / false / no as off', () => {
    for (const v of ['', '1', 'true', 'on'])
      expect(parseNetsimProfile(v)).toBe(NETSIM_PROFILES.bad);
    for (const v of ['0', 'false', 'no']) expect(parseNetsimProfile(v)).toBe(NETSIM_PROFILES.off);
    expect(parseNetsimProfile(null)).toBeNull();
    expect(parseNetsimProfile(undefined)).toBeNull();
  });

  it('parses latency,jitter,loss with optional duplicate and reorder', () => {
    expect(parseNetsimProfile('80,20,2')).toEqual({
      name: 'custom',
      latencyMs: 80,
      jitterMs: 20,
      lossPct: 2,
      duplicatePct: 0,
      reorderPct: 0,
    });
    expect(parseNetsimProfile(' 120 , 30.5 , 0.5 , 1 , 2 ')).toMatchObject({
      latencyMs: 120,
      jitterMs: 30.5,
      lossPct: 0.5,
      duplicatePct: 1,
      reorderPct: 2,
    });
    expect(parseNetsimProfile('45')).toMatchObject({ latencyMs: 45, jitterMs: 0, lossPct: 0 });
    expect(parseNetsimProfile('45,5')).toMatchObject({ latencyMs: 45, jitterMs: 5, lossPct: 0 });
  });

  it('clamps numbers to the legal ranges', () => {
    expect(parseNetsimProfile('99999,99999,500,500,500')).toMatchObject({
      latencyMs: NETSIM_LIMITS.latencyMaxMs,
      jitterMs: NETSIM_LIMITS.jitterMaxMs,
      lossPct: 100,
      duplicatePct: 100,
      reorderPct: 100,
    });
    expect(createNetsimProfile(NaN, -4, Infinity)).toMatchObject({
      latencyMs: 0,
      jitterMs: 0,
      lossPct: 0,
    });
  });

  it('rejects junk instead of guessing', () => {
    for (const v of [
      'terrible',
      '80,,2',
      '80,x,2',
      '-80,20,2',
      '80,20,2,0,0,0',
      ',',
      '80ms',
      'NaN',
    ]) {
      expect(parseNetsimProfile(v), v).toBeNull();
    }
  });
});

/** Stands in for lil-gui (which needs a DOM): records what the folder was asked to show. */
function fakeGui(): { parent: NetsimGuiParent; added: string[]; closed: () => boolean } {
  const added: string[] = [];
  let closed = false;
  const controller = {
    name: () => controller,
    listen: () => controller,
    disable: () => controller,
  };
  const folder = {
    add: (_model: object, key: string) => {
      added.push(key);
      return controller;
    },
    close: () => {
      closed = true;
      return folder;
    },
  };
  // Only the members used by addNetsimFolder exist; lil-gui's real GUI cannot be built in node.
  const parent = { addFolder: () => folder } as unknown as NetsimGuiParent;
  return { parent, added, closed: () => closed };
}

describe('netsim debug panel', () => {
  it('adds one collapsed folder with the live controls', () => {
    const gui = fakeGui();
    addNetsimFolder(gui.parent, createNetsim());
    expect(gui.added).toEqual([
      'profile',
      'latencyMs',
      'jitterMs',
      'lossPct',
      'duplicatePct',
      'reorderPct',
      'jitterShape',
      'queued',
      'lost',
      'overflowDropped',
    ]);
    expect(gui.closed()).toBe(true);
  });

  it('the model drives both directions of the live netsim', () => {
    const netsim = createNetsim({ profile: NETSIM_PROFILES.wifi });
    const model = createNetsimGuiModel(netsim);
    expect(model.profile).toBe('wifi');
    expect(model.latencyMs).toBe(20);

    model.latencyMs = 123;
    model.lossPct = 7;
    expect(netsim.outbound.latencyMs).toBe(123);
    expect(netsim.inbound.latencyMs).toBe(123);
    expect(netsim.inbound.lossPct).toBe(7);
    expect(model.profile).toBe('custom');

    model.profile = 'awful';
    expect(model.profile).toBe('awful');
    expect(netsim.inbound).toMatchObject({ latencyMs: 150, jitterMs: 50, lossPct: 5 });
    model.profile = 'custom';
    expect(model.profile).toBe('awful');

    model.jitterMs = -5;
    expect(netsim.outbound.jitterMs).toBe(0);
    model.jitterShape = 'normal';
    expect(netsim.inbound.jitterShape).toBe('normal');
    expect(model.queued).toBe(0);
    expect(model.lost).toBe(0);
    expect(model.overflowDropped).toBe(0);
  });

  it('setProfile can target one direction', () => {
    const netsim = createNetsim();
    netsim.setProfile(NETSIM_PROFILES.bad, 'outbound');
    expect(netsim.outbound.latencyMs).toBe(80);
    expect(netsim.inbound.latencyMs).toBe(0);
    expect(netsim.idle).toBe(false);
    netsim.setProfile(NETSIM_PROFILES.off, 'outbound');
    netsim.setProfile(NETSIM_PROFILES.lan, 'inbound');
    expect(netsim.outbound.latencyMs).toBe(0);
    expect(netsim.inbound.latencyMs).toBe(2);
  });
});
