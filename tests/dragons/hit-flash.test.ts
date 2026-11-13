import { describe, expect, it } from 'vitest';
import { DRAGON_SHADER_SOURCE } from '../../src/dragons/dragon-material';
import {
  HIT_FLASH_TUNING,
  advanceHitFlash,
  createHitFlashState,
  hitFlashStrength,
  resetHitFlash,
} from '../../src/dragons/hit-flash';

const FRAME_S = 1 / 60;

describe('hit flash timing', () => {
  it('pops in full on the frame of the hit and is gone within about a tenth of a second', () => {
    const state = createHitFlashState();
    expect(hitFlashStrength(state, false)).toBe(0);
    advanceHitFlash(state, true, FRAME_S);
    expect(hitFlashStrength(state, false)).toBe(1);

    let frames = 0;
    while (hitFlashStrength(state, false) > 0) {
      advanceHitFlash(state, false, FRAME_S);
      frames++;
      expect(frames).toBeLessThan(60);
    }
    const lastsS = frames * FRAME_S;
    expect(lastsS).toBeGreaterThanOrEqual(0.08);
    expect(lastsS).toBeLessThanOrEqual(0.13);
  });

  it('decays fast: under a third of the peak left halfway through', () => {
    const state = createHitFlashState();
    advanceHitFlash(state, true, FRAME_S);
    advanceHitFlash(state, false, HIT_FLASH_TUNING.durationS * 0.5);
    expect(hitFlashStrength(state, false)).toBeLessThan(0.3);
    expect(hitFlashStrength(state, false)).toBeGreaterThan(0);
  });

  it('is not held up by damage on every frame (fire breath)', () => {
    const state = createHitFlashState();
    let pops = 0;
    let bright = 0;
    const seconds = 10;
    const frames = Math.round(seconds / FRAME_S);
    let previous = 0;
    for (let i = 0; i < frames; i++) {
      advanceHitFlash(state, true, FRAME_S);
      const strength = hitFlashStrength(state, false);
      if (strength === 1 && previous < 1) pops++;
      if (strength > 0.5) bright++;
      previous = strength;
    }
    // Photosensitivity: at most three full flashes a second, and bright for a small part of it.
    expect(pops / seconds).toBeGreaterThan(1);
    expect(pops / seconds).toBeLessThan(3);
    expect(bright / frames).toBeLessThan(0.2);
    // Between the pops it shimmers low rather than going dark: still clearly "being hit".
    expect(previous).toBeGreaterThan(0);
    expect(HIT_FLASH_TUNING.sustain * HIT_FLASH_TUNING.sustain).toBeLessThan(0.3);
  });

  it('pops again once the re-arm time has passed', () => {
    const state = createHitFlashState();
    advanceHitFlash(state, true, FRAME_S);
    advanceHitFlash(state, false, HIT_FLASH_TUNING.rearmS * 0.5);
    advanceHitFlash(state, true, FRAME_S);
    expect(hitFlashStrength(state, false)).toBeLessThan(0.3);
    advanceHitFlash(state, false, HIT_FLASH_TUNING.rearmS);
    advanceHitFlash(state, true, FRAME_S);
    expect(hitFlashStrength(state, false)).toBe(1);
  });

  it('is gentler with reduce motion on, and reset clears it', () => {
    const state = createHitFlashState();
    advanceHitFlash(state, true, FRAME_S);
    expect(hitFlashStrength(state, true)).toBeLessThanOrEqual(0.5);
    expect(hitFlashStrength(state, true)).toBeGreaterThan(0);
    resetHitFlash(state);
    expect(hitFlashStrength(state, false)).toBe(0);
    advanceHitFlash(state, true, FRAME_S);
    expect(hitFlashStrength(state, false)).toBe(1);
  });
});

describe('hit flash shading', () => {
  const fragment = DRAGON_SHADER_SOURCE.fragment;
  const start = fragment.indexOf('// Hit flash');
  const block = fragment.slice(start, fragment.indexOf('uDebug.x > 0.5', start));

  it('adds to the lit colour instead of replacing it with a fill', () => {
    expect(start).toBeGreaterThan(0);
    expect(block).not.toMatch(/mix\s*\(\s*color/);
    expect(block).toContain('HIT_TINT');
  });

  it('puts the heat on the silhouette, on every preset, with a cheaper Low branch', () => {
    expect(block).toMatch(/#if DRAGON_QUALITY == 0[\s\S]*fresnel3[\s\S]*#else[\s\S]*fresnel2[\s\S]*#endif/);
    // Low: the rim only, no lift of the whole body.
    const low = block.slice(block.indexOf('#if DRAGON_QUALITY == 0'), block.indexOf('#else'));
    expect(low).not.toMatch(/color\s*=\s*color\s*\*/);
  });

  it('is a warm tint, not white', () => {
    const tint = /const vec3 HIT_TINT = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(fragment);
    expect(tint).not.toBeNull();
    const [r, g, b] = [Number(tint?.[1]), Number(tint?.[2]), Number(tint?.[3])];
    expect(r).toBeLessThanOrEqual(1);
    expect(g).toBeLessThan(r * 0.7);
    expect(b).toBeLessThan(g * 0.6);
  });
});
