#!/usr/bin/env node
// npm run assets:texture -- <in.png> <out.ktx2> [--kind dragon|rock|prop|sky] [--max <px>]
//                           [--mode auto|uastc|etc1s] [--linear] [--normal] [--no-mipmaps]
//
// PNG/JPEG -> KTX2 with mipmaps and an edge cap. auto: UASTC for normal/data maps and for colour
// maps under 512 px, ETC1S for larger colour maps.
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { Document } from '@gltf-transform/core';
import { TEXTURE_CAPS, formatBytes, isMain, parseArgs } from './lib/common.mjs';
import { encodeKtx2, readPngSize } from './lib/ktx.mjs';

function readImageSize(path) {
  const bytes = readFileSync(path);
  const extension = extname(path).toLowerCase();
  if (extension === '.png') return readPngSize(bytes);
  if (extension === '.jpg' || extension === '.jpeg') {
    // Reuse glTF-Transform's JPEG header parser through a throwaway texture.
    const size = new Document().createTexture().setImage(bytes).setMimeType('image/jpeg').getSize();
    if (size) return { width: size[0], height: size[1] };
    throw new Error('could not read the JPEG size');
  }
  throw new Error(`unsupported source format "${extension}" (PNG or JPEG)`);
}

/**
 * @param {string} input PNG or JPEG
 * @param {string} output .ktx2
 * @param {object} [options]
 * @param {'dragon'|'rock'|'prop'|'sky'} [options.kind] edge cap preset (default 1024)
 * @param {number} [options.maxSize] overrides the preset
 * @param {'auto'|'uastc'|'etc1s'} [options.mode]
 * @param {boolean} [options.linear] data map (roughness, masks, noise), not colour
 * @param {boolean} [options.normal] tangent-space normal map (implies linear)
 * @param {boolean} [options.mipmaps] default true
 */
export function convertTexture(input, output, options = {}) {
  const size = readImageSize(input);
  const maxSize = options.maxSize ?? (options.kind ? TEXTURE_CAPS[options.kind] : 1024);
  if (!Number.isFinite(maxSize) || maxSize < 4) throw new Error('bad size cap');
  mkdirSync(dirname(resolve(output)), { recursive: true });
  const normal = options.normal === true;
  const encoded = encodeKtx2({
    input,
    output,
    srcWidth: size.width,
    srcHeight: size.height,
    srgb: !(normal || options.linear === true),
    normal,
    mode: options.mode ?? 'auto',
    maxSize,
    mipmaps: options.mipmaps,
  });
  return {
    ...encoded,
    srcWidth: size.width,
    srcHeight: size.height,
    srcBytes: statSync(input).size,
  };
}

function main() {
  const { positional, options } = parseArgs(process.argv.slice(2), [
    'linear',
    'normal',
    'no-mipmaps',
  ]);
  const [input, output] = positional;
  if (!input || !output) {
    console.error(
      'usage: npm run assets:texture -- <in.png> <out.ktx2> [--kind dragon|rock|prop|sky] [--max <px>]\n' +
        '         [--mode auto|uastc|etc1s] [--linear] [--normal] [--no-mipmaps]',
    );
    process.exit(2);
  }
  if (options.kind !== undefined && !(options.kind in TEXTURE_CAPS)) {
    throw new Error(`--kind must be one of ${Object.keys(TEXTURE_CAPS).join(', ')}`);
  }
  const result = convertTexture(input, output, {
    kind: options.kind,
    maxSize: options.max ? Number(options.max) : undefined,
    mode: options.mode,
    linear: options.linear === true,
    normal: options.normal === true,
    mipmaps: options['no-mipmaps'] !== true,
  });
  console.log(
    `${input} ${result.srcWidth}x${result.srcHeight} ${formatBytes(result.srcBytes)} -> ` +
      `${output} ${result.width}x${result.height} ${result.mode} ${result.levels} mip level(s) ` +
      `${formatBytes(result.bytes)}`,
  );
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`assets:texture failed: ${error.message}`);
    process.exit(1);
  }
}
