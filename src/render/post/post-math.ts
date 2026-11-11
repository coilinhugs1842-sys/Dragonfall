/**
 * Pure numbers behind the post pass (no three.js, no DOM: tested in node). The GLSL in
 * ./post-shaders.ts implements the same curves; change both together.
 */
import type { QualityPreset } from '../../shared/quality';

/** Display-referred tone curve: the Narkowicz fit of the ACES filmic response. */
export function tonemapFilmic(x: number): number {
  const v = x > 0 ? x : 0;
  const y = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/**
 * Inverse of `tonemapFilmic`: the scene-linear value that the curve shows as display-linear
 * `y`. World code uses it to author "painted" colours (sky, fog, clouds) as the colour wanted
 * on screen. `y` is clamped just below the curve's ceiling, where the inverse runs away.
 */
export function inverseTonemapFilmic(y: number): number {
  const v = y < 0 ? 0 : y > 0.985 ? 0.985 : y;
  const a = 2.51 - 2.43 * v;
  const b = 0.03 - 0.59 * v;
  const c = -0.14 * v;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/** sRGB -> linear transfer (the exact piecewise curve). */
export function srgbDecode(x: number): number {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear -> sRGB transfer (the exact piecewise curve). */
export function srgbEncode(x: number): number {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Lift / gamma / gain on one display-referred channel (0..1):
 * `pow(gain * (x + lift * (1 - x)), 1 / gamma)`. Lift moves the blacks, gain the whites, gamma
 * the mids; a per-channel difference tints that tonal range.
 */
export function liftGammaGain(x: number, lift: number, gamma: number, gain: number): number {
  const v = gain * (x + lift * (1 - x));
  return Math.pow(v > 0 ? v : 0, 1 / (gamma > 1e-3 ? gamma : 1e-3));
}

/** Rec. 709 luma of a linear colour. */
export function luma(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * Vignette gain at a screen position. `x`, `y` are -1..1 from the centre; the falloff is round
 * on any aspect ratio once x is multiplied by `aspect` and normalised by the corner distance.
 */
export function vignetteGain(x: number, y: number, strength: number, aspect = 1): number {
  const cx = x * aspect;
  const d2 = (cx * cx + y * y) / (aspect * aspect + 1);
  const t = d2 < 0 ? 0 : d2 > 1 ? 1 : d2;
  return 1 - strength * t * t * (3 - 2 * t);
}

/** Which parts of the combined pass a preset runs. */
export interface PostPlan {
  /** FXAA and the sharpen share their four neighbour fetches. */
  readonly fxaa: boolean;
  readonly sharpen: boolean;
  readonly grade: boolean;
  readonly vignette: boolean;
  /** Number of bloom buffers (each half the previous); 0 = no bloom. */
  readonly bloomLevels: number;
  /** Size of the first bloom buffer relative to the scene target. */
  readonly bloomScale: number;
  /** Screen-space sun shafts, read from the bloom buffers (so only with bloom). */
  readonly sunShafts: boolean;
  /** Full-screen draw calls the post adds to the frame. */
  readonly passes: number;
}

export const BLOOM_LEVELS = 3;

/**
 * Low: tone map + grade + vignette. Medium: + FXAA + sharpen, still ONE pass. High: + bloom
 * chain (prefilter, downsamples, additive upsamples) and sun shafts in the composite.
 */
export function postPlanFor(preset: QualityPreset): PostPlan {
  const bloom = preset.bloom && preset.bloomResolutionScale > 0;
  const bloomLevels = bloom ? BLOOM_LEVELS : 0;
  return {
    fxaa: preset.fxaa,
    sharpen: preset.fxaa,
    grade: true,
    vignette: true,
    bloomLevels,
    bloomScale: bloom ? Math.min(preset.bloomResolutionScale, 0.5) : 0,
    sunShafts: bloom,
    // prefilter + (levels - 1) down + (levels - 1) up + composite.
    passes: bloom ? 1 + (bloomLevels - 1) * 2 + 1 : 1,
  };
}

/** Whole pixels of a `scale` fraction of `size`, at least 1. */
export function scaledSize(size: number, scale: number): number {
  const v = Math.floor(size * scale);
  return v >= 1 ? v : 1;
}

/**
 * Edge of bloom buffer `level` (0 = largest) for a scene target edge of `sceneSize`.
 * Each level halves; never below 2 texels.
 */
export function bloomLevelSize(sceneSize: number, bloomScale: number, level: number): number {
  let v = Math.floor(sceneSize * bloomScale);
  for (let i = 0; i < level; i++) v = Math.floor(v / 2);
  return v >= 2 ? v : 2;
}
