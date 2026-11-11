/**
 * Quality presets: the "Scene budgets per quality preset" table in docs/PERFORMANCE.md as data.
 * Every row of that table has a field here and the values must stay identical to the doc
 * (tests/shared/quality.test.ts checks them). Change the doc and this file together.
 */

export type QualityPresetId = 'low' | 'medium' | 'high';

/** Ordered weakest to strongest; the automatic quality pick walks this list. */
export const QUALITY_PRESET_IDS: readonly QualityPresetId[] = ['low', 'medium', 'high'];

/** Medium is the U-series target and must hold 60 fps there. */
export const DEFAULT_QUALITY: QualityPresetId = 'medium';

/** Render scale is a fraction of this output height (the table says "of 1080p"). */
export const RENDER_SCALE_REFERENCE_HEIGHT = 1080;

/** Which objects render into the sun shadow map. `none` means blob shadows only. */
export type ShadowCasters = 'none' | 'dragons' | 'all';

export interface QualityPreset {
  readonly id: QualityPresetId;
  readonly label: string;

  /** Dynamic resolution moves the render scale inside these bounds to hold 60 fps. */
  readonly renderScaleMin: number;
  readonly renderScaleMax: number;

  readonly maxDrawCalls: number;
  /** Triangles on screen. */
  readonly maxTriangles: number;

  /** Sun shadow map edge in texels (near cascade only); 0 = no shadow map. */
  readonly shadowMapSize: number;
  readonly shadowCasters: ShadowCasters;
  /** Cheap blob decals wherever a caster has no real shadow. */
  readonly blobShadows: boolean;

  /** False = no post pass at all; tone mapping then happens in the materials. */
  readonly postPass: boolean;
  readonly toneMapInMaterial: boolean;
  /** The three effects of the single combined pass. */
  readonly fxaa: boolean;
  readonly colorGrade: boolean;
  readonly vignette: boolean;
  readonly bloom: boolean;
  /** Bloom buffer size relative to the render target; 0 when bloom is off. Never full-res. */
  readonly bloomResolutionScale: number;

  readonly maxParticles: number;
  /** Soft (depth-fading) particles cost overdraw, so they are High only ("Overdraw control"). */
  readonly softParticles: boolean;

  /**
   * Metres: a dragon uses LOD0 up to [0], LOD1 up to [1], LOD2 up to [2], and a sprite
   * impostor beyond that.
   */
  readonly dragonLodDistances: readonly [lod0: number, lod1: number, lod2: number];
  /** Metres. */
  readonly propDrawDistance: number;
  readonly cloudLayers: number;

  /** Texture edge in texels; larger mips are skipped at load. */
  readonly maxTextureSize: number;
  /** Megabytes of KTX2 texture memory. */
  readonly textureVramBudgetMb: number;

  readonly audioVoices: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityPresetId, QualityPreset>> = {
  low: {
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
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    renderScaleMin: 0.6,
    renderScaleMax: 0.85,
    maxDrawCalls: 180,
    maxTriangles: 450_000,
    shadowMapSize: 1024,
    shadowCasters: 'dragons',
    // The world casts no real shadow at Medium, so it keeps the blobs.
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
  },
  high: {
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
  },
};

export function isQualityPresetId(value: unknown): value is QualityPresetId {
  return value === 'low' || value === 'medium' || value === 'high';
}
