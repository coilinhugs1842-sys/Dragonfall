/**
 * Honours a preset's `maxTextureSize` (src/shared/quality.ts) on compressed textures that carry
 * a mip chain, which every KTX2 file of the pipeline does: the top level(s) are left out of the
 * upload, so the GPU never holds them. A 1024 texture under Low's 512 limit then takes a
 * quarter of the memory. Nothing is decoded or resized: the smaller levels are already there.
 *
 * The full chain stays referenced on the CPU side (three keeps `mipmaps` after an upload
 * anyway), so a later, higher limit puts the levels back.
 *
 * A texture that is already on the GPU has immutable storage, so changing its levels means
 * freeing it first (`dispose`); three uploads it again the next time it is used. That makes
 * this load-time and preset-change code, never per-frame code.
 *
 * No three.js at runtime (types only): the dragon loader imports this file without pulling the
 * map loaders into its chunk.
 */

import type { CompressedTextureMipmap, Texture } from 'three';

/** The chain as the file had it, by texture. Only textures that were ever fitted are in here. */
const fullChains = new WeakMap<Texture, readonly CompressedTextureMipmap[]>();

/**
 * How many leading levels to leave out so that the first one kept is at most `maxSize` texels
 * on its longer edge. The last level is always kept, whatever the limit.
 */
export function mipLevelsToSkip(
  mipmaps: readonly { readonly width: number; readonly height: number }[],
  maxSize: number,
): number {
  let skip = 0;
  while (skip < mipmaps.length - 1) {
    const mip = mipmaps[skip];
    if (mip === undefined || Math.max(mip.width, mip.height) <= maxSize) break;
    skip++;
  }
  return skip;
}

/**
 * Makes `texture` start at the largest level that fits `maxSize` (0 or less = no limit). True
 * when the levels changed: the GPU copy, if there was one, is freed and the texture is flagged
 * for upload. False for anything that is not a compressed texture with a mip chain, and when
 * the texture already starts at the right level.
 */
export function fitTextureToLimit(texture: Texture, maxSize: number): boolean {
  if ((texture as { isCompressedTexture?: boolean }).isCompressedTexture !== true) return false;
  let full = fullChains.get(texture);
  if (full === undefined) {
    const mipmaps = texture.mipmaps as CompressedTextureMipmap[];
    // A single level has nothing smaller to fall back to.
    if (!Array.isArray(mipmaps) || mipmaps.length < 2) return false;
    full = mipmaps.slice();
    fullChains.set(texture, full);
  }
  const skip = mipLevelsToSkip(full, maxSize > 0 ? maxSize : Infinity);
  const first = full[skip];
  if (first === undefined || texture.mipmaps[0] === first) return false;
  texture.dispose();
  texture.mipmaps = full.slice(skip);
  const image = texture.image as { width: number; height: number } | null;
  if (image !== null && typeof image === 'object') {
    image.width = first.width;
    image.height = first.height;
  }
  texture.needsUpdate = true;
  return true;
}

/**
 * Bytes of the levels `texture` uploads now. For a block-compressed texture that is exactly
 * what it takes on the GPU; 0 for a texture without CPU-side levels.
 */
export function textureLevelBytes(texture: Texture): number {
  const mipmaps = texture.mipmaps as readonly CompressedTextureMipmap[];
  if (!Array.isArray(mipmaps)) return 0;
  let bytes = 0;
  for (const mip of mipmaps) bytes += mip.data?.byteLength ?? 0;
  return bytes;
}
