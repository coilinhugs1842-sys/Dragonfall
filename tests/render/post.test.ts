import { describe, expect, it } from 'vitest';
import {
  BLOOM_LEVELS,
  bloomLevelSize,
  createPostSettings,
  inverseTonemapFilmic,
  liftGammaGain,
  luma,
  postPlanFor,
  scaledSize,
  srgbDecode,
  srgbEncode,
  tonemapFilmic,
  vignetteGain,
} from '../../src/render/post';
import {
  BLOOM_BLUR_FRAGMENT_SHADER,
  BLOOM_PREFILTER_FRAGMENT_SHADER,
  COMPOSITE_FRAGMENT_SHADER,
} from '../../src/render/post/post-shaders';
import { QUALITY_PRESETS } from '../../src/shared';

describe('tone curve', () => {
  it('is monotonic, starts at black and rolls off below 1', () => {
    expect(tonemapFilmic(0)).toBe(0);
    expect(tonemapFilmic(-3)).toBe(0);
    let previous = 0;
    for (let x = 0.01; x < 16; x *= 1.3) {
      const y = tonemapFilmic(x);
      // Strictly rising until the fit reaches white (a little above 7), flat after.
      if (previous < 1) expect(y).toBeGreaterThan(previous);
      expect(y).toBeLessThanOrEqual(1);
      previous = y;
    }
    expect(tonemapFilmic(3)).toBeLessThan(1);
    // Mid grey stays a mid tone; a value of 1 is bright but not clipped.
    expect(tonemapFilmic(0.18)).toBeGreaterThan(0.2);
    expect(tonemapFilmic(0.18)).toBeLessThan(0.35);
    expect(tonemapFilmic(1)).toBeGreaterThan(0.75);
    expect(tonemapFilmic(1)).toBeLessThan(0.85);
  });

  it('has an inverse over the range painted colours use', () => {
    for (const y of [0, 0.02, 0.1, 0.3, 0.5, 0.8, 0.95, 0.98]) {
      expect(tonemapFilmic(inverseTonemapFilmic(y))).toBeCloseTo(y, 8);
    }
    // Clamped just under the ceiling instead of running away to infinity.
    expect(Number.isFinite(inverseTonemapFilmic(1))).toBe(true);
    expect(inverseTonemapFilmic(1)).toBe(inverseTonemapFilmic(2));
    expect(inverseTonemapFilmic(-1)).toBe(0);
  });

  it('round-trips the sRGB transfer', () => {
    for (const v of [0, 0.001, 0.0031308, 0.02, 0.2, 0.5, 1]) {
      expect(srgbDecode(srgbEncode(v))).toBeCloseTo(v, 8);
    }
    expect(srgbEncode(0.5)).toBeCloseTo(0.7354, 3);
    expect(srgbEncode(2)).toBeCloseTo(1, 12);
  });
});

describe('grade', () => {
  it('leaves the colour alone at neutral settings', () => {
    for (const x of [0, 0.2, 0.7, 1]) expect(liftGammaGain(x, 0, 1, 1)).toBeCloseTo(x, 12);
  });

  it('lifts blacks, scales whites and bends mids', () => {
    expect(liftGammaGain(0, 0.05, 1, 1)).toBeCloseTo(0.05, 12);
    expect(liftGammaGain(1, 0.05, 1, 1)).toBeCloseTo(1, 12);
    expect(liftGammaGain(1, 0, 1, 0.9)).toBeCloseTo(0.9, 12);
    expect(liftGammaGain(0.5, 0, 1.2, 1)).toBeGreaterThan(0.5);
    expect(liftGammaGain(-1, 0, 1, 1)).toBe(0);
  });

  it('defaults to cool shadows and warm highlights, gently', () => {
    const s = createPostSettings();
    expect(s.lift.z).toBeGreaterThan(s.lift.x);
    expect(s.gain.x).toBeGreaterThan(s.gain.z);
    for (const v of [s.lift.x, s.lift.y, s.lift.z]) expect(v).toBeLessThan(0.05);
    expect(s.sunDirection.length()).toBeCloseTo(1, 6);
    expect(luma(1, 1, 1)).toBeCloseTo(1, 12);
  });

  it('darkens the corners equally on any aspect ratio and never the centre', () => {
    for (const aspect of [1, 16 / 9, 21 / 9]) {
      expect(vignetteGain(0, 0, 0.3, aspect)).toBe(1);
      expect(vignetteGain(1, 1, 0.3, aspect)).toBeCloseTo(0.7, 12);
      expect(vignetteGain(-1, 1, 0.3, aspect)).toBeCloseTo(0.7, 12);
      expect(vignetteGain(0.5, 0.2, 0.3, aspect)).toBeGreaterThan(0.7);
    }
    expect(vignetteGain(1, 1, 0)).toBe(1);
  });
});

describe('post plan', () => {
  it('is one pass on Low and Medium, and adds the bloom chain on High', () => {
    const low = postPlanFor(QUALITY_PRESETS.low);
    const medium = postPlanFor(QUALITY_PRESETS.medium);
    const high = postPlanFor(QUALITY_PRESETS.high);

    expect(low.passes).toBe(1);
    expect(low.fxaa).toBe(false);
    expect(low.sharpen).toBe(false);
    expect(low.grade && low.vignette).toBe(true);
    expect(low.bloomLevels).toBe(0);

    expect(medium.passes).toBe(1);
    expect(medium.fxaa && medium.sharpen && medium.grade && medium.vignette).toBe(true);
    expect(medium.bloomLevels).toBe(0);
    expect(medium.sunShafts).toBe(false);

    expect(high.fxaa).toBe(true);
    expect(high.bloomLevels).toBe(BLOOM_LEVELS);
    expect(high.sunShafts).toBe(true);
    // prefilter + 2 down + 2 up + composite
    expect(high.passes).toBe(6);
    // Never full-resolution bloom (docs/PERFORMANCE.md "Never in gameplay").
    expect(high.bloomScale).toBeLessThanOrEqual(0.5);
    expect(high.bloomScale).toBeGreaterThan(0);
  });

  it('sizes the scene and bloom buffers in whole pixels', () => {
    expect(scaledSize(1920, 0.85)).toBe(1632);
    expect(scaledSize(1, 0.5)).toBe(1);
    expect(scaledSize(0, 1)).toBe(1);
    expect(bloomLevelSize(1632, 0.5, 0)).toBe(816);
    expect(bloomLevelSize(1632, 0.5, 1)).toBe(408);
    expect(bloomLevelSize(1632, 0.5, 2)).toBe(204);
    expect(bloomLevelSize(3, 0.5, 2)).toBe(2);
  });
});

describe('post shaders', () => {
  it('keeps every optional stage of the composite behind its define', () => {
    const src = COMPOSITE_FRAGMENT_SHADER;
    for (const define of [
      'POST_FXAA',
      'POST_BLOOM',
      'POST_SHAFTS',
      'POST_VIGNETTE',
      'POST_GRADE',
    ]) {
      expect(src).toContain(`#ifdef ${define}`);
    }
    // The sun shafts read the bloom buffer: they must sit inside the bloom block.
    expect(src.indexOf('#ifdef POST_SHAFTS', src.indexOf('vec3 glow'))).toBeGreaterThan(
      src.indexOf('#ifdef POST_BLOOM', src.indexOf('void main')),
    );
  });

  it('reads the scene only inside its dynamic-resolution rectangle', () => {
    // Every scene fetch is clamped to uRect.zw, so a scale step never samples stale texels.
    const fetches = [...COMPOSITE_FRAGMENT_SHADER.matchAll(/texture2D\(tScene,\s*([^)]*\))/g)];
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches) expect(fetch[1]).toContain('uRect.zw');
    expect(BLOOM_PREFILTER_FRAGMENT_SHADER).toContain('min(uv, uRect.zw)');
    expect(BLOOM_BLUR_FRAGMENT_SHADER).toContain('uOffset');
  });
});
