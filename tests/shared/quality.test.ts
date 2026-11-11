import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY,
  QUALITY_PRESET_IDS,
  QUALITY_PRESETS,
  SNAPSHOT_HZ,
  SNAPSHOT_INTERVAL_MS,
  TICK_DT_S,
  TICK_HZ,
  TICK_MS,
  MAX_PLAYERS,
  MAX_TEAM_SIZE,
  ROOM_CODE_ALPHABET,
} from '../../src/shared';
import type { QualityPreset } from '../../src/shared';

const { low, medium, high } = QUALITY_PRESETS;
const ordered: readonly QualityPreset[] = [low, medium, high];

describe('QUALITY_PRESETS', () => {
  it('has one preset per id and defaults to medium', () => {
    expect(QUALITY_PRESET_IDS).toEqual(['low', 'medium', 'high']);
    expect(Object.keys(QUALITY_PRESETS).sort()).toEqual(['high', 'low', 'medium']);
    for (const id of QUALITY_PRESET_IDS) expect(QUALITY_PRESETS[id].id).toBe(id);
    expect(DEFAULT_QUALITY).toBe('medium');
  });

  it('keeps render scale bounds valid', () => {
    for (const preset of ordered) {
      expect(preset.renderScaleMin).toBeGreaterThan(0);
      expect(preset.renderScaleMin).toBeLessThanOrEqual(preset.renderScaleMax);
      expect(preset.renderScaleMax).toBeLessThanOrEqual(1);
    }
  });

  it('has budgets that never shrink from low to medium to high', () => {
    const budgets: readonly ((p: QualityPreset) => number)[] = [
      (p) => p.renderScaleMin,
      (p) => p.renderScaleMax,
      (p) => p.maxDrawCalls,
      (p) => p.maxTriangles,
      (p) => p.shadowMapSize,
      (p) => p.bloomResolutionScale,
      (p) => p.maxParticles,
      (p) => p.dragonLodDistances[0],
      (p) => p.dragonLodDistances[1],
      (p) => p.dragonLodDistances[2],
      (p) => p.propDrawDistance,
      (p) => p.cloudLayers,
      (p) => p.maxTextureSize,
      (p) => p.textureVramBudgetMb,
      (p) => p.audioVoices,
    ];
    for (const read of budgets) {
      expect(read(low)).toBeLessThanOrEqual(read(medium));
      expect(read(medium)).toBeLessThanOrEqual(read(high));
    }
  });

  it('orders dragon LOD distances near to far', () => {
    for (const preset of ordered) {
      const [lod0, lod1, lod2] = preset.dragonLodDistances;
      expect(lod0).toBeLessThan(lod1);
      expect(lod1).toBeLessThan(lod2);
    }
  });

  it('keeps shadow and post flags consistent', () => {
    for (const preset of ordered) {
      expect(preset.shadowMapSize === 0).toBe(preset.shadowCasters === 'none');
      // Exactly one place does tone mapping.
      expect(preset.toneMapInMaterial).toBe(!preset.postPass);
      if (!preset.postPass) {
        expect(preset.fxaa || preset.colorGrade || preset.vignette || preset.bloom).toBe(false);
      }
      expect(preset.bloomResolutionScale > 0).toBe(preset.bloom);
      // Full-resolution bloom is on the "never in gameplay" list.
      expect(preset.bloomResolutionScale).toBeLessThan(1);
    }
  });

  // The literal values of the "Scene budgets per quality preset" table in docs/PERFORMANCE.md.
  it('matches the PERFORMANCE.md table', () => {
    expect(low).toEqual({
      id: 'low',
      label: 'Low',
      renderScaleMin: 0.5,
      renderScaleMax: 0.7,
      maxDrawCalls: 120,
      maxTriangles: 250_000,
      shadowMapSize: 0,
      shadowCasters: 'none',
      blobShadows: true,
      postPass: false,
      toneMapInMaterial: true,
      fxaa: false,
      colorGrade: false,
      vignette: false,
      bloom: false,
      bloomResolutionScale: 0,
      maxParticles: 600,
      softParticles: false,
      dragonLodDistances: [25, 70, 200],
      propDrawDistance: 500,
      cloudLayers: 1,
      maxTextureSize: 512,
      textureVramBudgetMb: 180,
      audioVoices: 16,
    });
    expect(medium).toEqual({
      id: 'medium',
      label: 'Medium',
      renderScaleMin: 0.6,
      renderScaleMax: 0.85,
      maxDrawCalls: 180,
      maxTriangles: 450_000,
      shadowMapSize: 1024,
      shadowCasters: 'dragons',
      blobShadows: true,
      postPass: true,
      toneMapInMaterial: false,
      fxaa: true,
      colorGrade: true,
      vignette: true,
      bloom: false,
      bloomResolutionScale: 0,
      maxParticles: 1_200,
      softParticles: false,
      dragonLodDistances: [40, 120, 320],
      propDrawDistance: 800,
      cloudLayers: 2,
      maxTextureSize: 1024,
      textureVramBudgetMb: 300,
      audioVoices: 24,
    });
    expect(high).toEqual({
      id: 'high',
      label: 'High',
      renderScaleMin: 0.85,
      renderScaleMax: 1.0,
      maxDrawCalls: 350,
      maxTriangles: 1_200_000,
      shadowMapSize: 2048,
      shadowCasters: 'all',
      blobShadows: false,
      postPass: true,
      toneMapInMaterial: false,
      fxaa: true,
      colorGrade: true,
      vignette: true,
      bloom: true,
      bloomResolutionScale: 0.5,
      maxParticles: 3_000,
      softParticles: true,
      dragonLodDistances: [80, 220, 600],
      propDrawDistance: 1_500,
      cloudLayers: 3,
      maxTextureSize: 2048,
      textureVramBudgetMb: 600,
      audioVoices: 32,
    });
  });
});

describe('constants', () => {
  it('has a tick length consistent with the tick rate', () => {
    expect(TICK_HZ).toBe(30);
    expect(TICK_MS * TICK_HZ).toBeCloseTo(1000, 9);
    expect(TICK_DT_S * 1000).toBeCloseTo(TICK_MS, 9);
  });

  it('sends snapshots at 20 Hz, no faster than the sim ticks', () => {
    expect(SNAPSHOT_HZ).toBe(20);
    expect(SNAPSHOT_INTERVAL_MS * SNAPSHOT_HZ).toBeCloseTo(1000, 9);
    expect(SNAPSHOT_HZ).toBeLessThanOrEqual(TICK_HZ);
  });

  it('caps a match at 5v5', () => {
    expect(MAX_TEAM_SIZE).toBe(5);
    expect(MAX_PLAYERS).toBe(10);
  });

  it('uses an unambiguous room code alphabet', () => {
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[0O1I]/);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
  });
});
