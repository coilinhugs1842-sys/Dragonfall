import { CompressedTexture, DataTexture, RGBA_BPTC_Format } from 'three';
import type { CompressedTextureMipmap } from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../src/shared';
import {
  fitTextureToLimit,
  mipLevelsToSkip,
  textureLevelBytes,
} from '../../src/world/props/texture-mips';

/** A full BC7 chain (8 bits per texel, 4x4 blocks) from `size` down to 1, as a KTX2 file has. */
function chain(size: number): CompressedTextureMipmap[] {
  const mipmaps: CompressedTextureMipmap[] = [];
  for (let edge = size; edge >= 1; edge = Math.floor(edge / 2)) {
    const blocks = Math.ceil(edge / 4);
    mipmaps.push({ data: new Uint8Array(blocks * blocks * 16), width: edge, height: edge });
  }
  return mipmaps;
}

function compressed(size: number): { texture: CompressedTexture; disposed: () => number } {
  const texture = new CompressedTexture(chain(size), size, size, RGBA_BPTC_Format);
  let count = 0;
  texture.addEventListener('dispose', () => {
    count++;
  });
  return { texture, disposed: () => count };
}

function sizes(texture: CompressedTexture): number[] {
  return (texture.mipmaps as CompressedTextureMipmap[]).map((mip) => mip.width);
}

describe('mipLevelsToSkip', () => {
  it.each([
    // chain top, limit -> levels left out
    [1024, 2048, 0],
    [1024, 1024, 0],
    [1024, 512, 1],
    [1024, 256, 2],
    [2048, 512, 2],
    [1024, 1, 10],
    [1024, 0.5, 10], // nothing fits: the last level is still kept
    [1024, Infinity, 0],
    [4, 512, 0],
  ])('a %i chain under a limit of %f skips %i', (size, limit, expected) => {
    expect(mipLevelsToSkip(chain(size), limit)).toBe(expected);
  });

  it('uses the longer edge of a non-square texture', () => {
    const wide = [
      { width: 2048, height: 512 },
      { width: 1024, height: 256 },
      { width: 512, height: 128 },
    ];
    expect(mipLevelsToSkip(wide, 512)).toBe(2);
    expect(mipLevelsToSkip(wide, 1024)).toBe(1);
  });

  it('handles an empty or single-level chain', () => {
    expect(mipLevelsToSkip([], 512)).toBe(0);
    expect(mipLevelsToSkip([{ width: 4096, height: 4096 }], 512)).toBe(0);
  });
});

describe('fitTextureToLimit', () => {
  it.each([
    ['low', [512, 256, 128, 64, 32, 16, 8, 4, 2, 1]],
    ['medium', [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]],
    ['high', [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]],
  ] as const)('a 1024 texture on %s uploads levels %j', (id, expected) => {
    const { texture } = compressed(1024);
    fitTextureToLimit(texture, QUALITY_PRESETS[id].maxTextureSize);
    expect(sizes(texture)).toEqual(expected);
    expect(texture.image.width).toBe(expected[0]);
    expect(texture.image.height).toBe(expected[0]);
  });

  it('leaves out the top level before the first upload and reports the change', () => {
    const { texture, disposed } = compressed(1024);
    const version = texture.version;
    const second = (texture.mipmaps as CompressedTextureMipmap[])[1];
    expect(fitTextureToLimit(texture, 512)).toBe(true);
    // The kept levels are the file's own data, not copies.
    expect((texture.mipmaps as CompressedTextureMipmap[])[0]).toBe(second);
    // Flagged for upload, and whatever was on the GPU (immutable storage) is released.
    expect(texture.version).toBeGreaterThan(version);
    expect(disposed()).toBe(1);
  });

  it('is a no-op when the texture already starts at the right level', () => {
    const { texture, disposed } = compressed(1024);
    fitTextureToLimit(texture, 512);
    const version = texture.version;
    expect(fitTextureToLimit(texture, 512)).toBe(false);
    expect(fitTextureToLimit(texture, 600)).toBe(false);
    expect(texture.version).toBe(version);
    expect(disposed()).toBe(1);
    // A fresh texture that fits is never touched at all.
    const small = compressed(256);
    expect(fitTextureToLimit(small.texture, 512)).toBe(false);
    expect(small.disposed()).toBe(0);
    expect(small.texture.version).toBe(0);
  });

  it('puts the levels back when a later preset allows them', () => {
    const { texture, disposed } = compressed(1024);
    const full = (texture.mipmaps as CompressedTextureMipmap[]).slice();
    fitTextureToLimit(texture, 256);
    expect(sizes(texture)[0]).toBe(256);
    expect(fitTextureToLimit(texture, 2048)).toBe(true);
    expect(texture.mipmaps).toEqual(full);
    expect(texture.image.width).toBe(1024);
    expect(disposed()).toBe(2);
    // 0 means "no limit".
    fitTextureToLimit(texture, 512);
    expect(fitTextureToLimit(texture, 0)).toBe(true);
    expect(sizes(texture)[0]).toBe(1024);
  });

  it('never drops below the last level', () => {
    const { texture } = compressed(1024);
    fitTextureToLimit(texture, 0.25);
    expect(sizes(texture)).toEqual([1]);
  });

  it('ignores textures it cannot trim', () => {
    const data = new DataTexture(new Uint8Array(4 * 1024 * 4), 1024, 4);
    expect(fitTextureToLimit(data, 512)).toBe(false);
    expect(data.image.width).toBe(1024);

    const single = new CompressedTexture(chain(1024).slice(0, 1), 1024, 1024, RGBA_BPTC_Format);
    expect(fitTextureToLimit(single, 512)).toBe(false);
    expect(single.mipmaps).toHaveLength(1);
    expect(single.version).toBe(0);
  });
});

describe('textureLevelBytes', () => {
  it('a 1024 chain takes a quarter of the memory under a 512 limit', () => {
    const { texture } = compressed(1024);
    const full = textureLevelBytes(texture);
    // 1024 x 1024 at one byte per texel, plus a third for the chain.
    expect(full).toBeGreaterThan(1024 * 1024 * 1.33);
    expect(full).toBeLessThan(1024 * 1024 * 1.34);
    fitTextureToLimit(texture, QUALITY_PRESETS.low.maxTextureSize);
    const low = textureLevelBytes(texture);
    expect(low / full).toBeGreaterThan(0.249);
    expect(low / full).toBeLessThan(0.251);
  });

  it('is 0 for a texture without CPU-side levels', () => {
    expect(textureLevelBytes(new DataTexture(new Uint8Array(4), 1, 1))).toBe(0);
  });
});
