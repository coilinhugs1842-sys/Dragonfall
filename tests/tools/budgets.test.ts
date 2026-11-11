/**
 * The Node pipeline tools cannot import TypeScript, so they read tools/pipeline/budgets.json.
 * This test fails when that mirror drifts from the contracts in src/shared.
 */
import { describe, expect, it } from 'vitest';
import { DRAGON_CLASS_IDS as CLASS_IDS } from '../../src/shared/classes';
import { MAX_TEAM_SIZE, TEAM_COUNT } from '../../src/shared/constants';
import { ASSET_BUDGETS } from '../../src/shared/manifests';
import { MAPS } from '../../src/shared/match';
import { DRAGON_ANIM_CLIPS as ANIM_CLIPS } from '../../src/shared/world-view';
import {
  BUDGETS,
  DRAGON_ANIM_CLIPS,
  DRAGON_CLASS_IDS,
  MAP_IDS,
  TEXTURE_CAPS,
} from '../../tools/pipeline/lib/common.mjs';

describe('tools/pipeline/budgets.json mirrors src/shared', () => {
  it('has the same ASSET_BUDGETS', () => {
    expect(BUDGETS).toEqual(JSON.parse(JSON.stringify(ASSET_BUDGETS)));
  });

  it('has the same animation clip names, in order', () => {
    expect(DRAGON_ANIM_CLIPS).toEqual([...ANIM_CLIPS]);
  });

  it('has the same dragon class and map ids', () => {
    expect(DRAGON_CLASS_IDS).toEqual([...CLASS_IDS]);
    expect([...MAP_IDS].sort()).toEqual(Object.keys(MAPS).sort());
  });

  it('caps dragon textures at the dragon budget', () => {
    expect(TEXTURE_CAPS.dragon).toBe(ASSET_BUDGETS.dragonMaxTextureSize);
  });

  it('assumes the team shape manifest.mjs hard-codes', () => {
    // tools/pipeline/manifest.mjs: MAX_TEAM_SIZE = 5, TEAM_COUNT = 2.
    expect(MAX_TEAM_SIZE).toBe(5);
    expect(TEAM_COUNT).toBe(2);
  });
});
