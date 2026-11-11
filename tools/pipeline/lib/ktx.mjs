// PNG/JPEG -> KTX2 (Basis Universal) through KTX-Software's toktx, plus a tiny KTX2 header reader.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { findKtxTool, run } from './common.mjs';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KTX2_SIGNATURE = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes, signature) {
  return signature.every((value, i) => bytes[i] === value);
}

/** Width/height from a PNG's IHDR chunk. */
export function readPngSize(bytes) {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new Error('not a PNG file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * KTX2 header fields we report and budget on.
 * `codec` is 'ETC1S' (BasisLZ), 'UASTC', or 'other'; `srgb` comes from the data format descriptor.
 */
export function readKtx2Info(bytes) {
  if (!startsWith(bytes, KTX2_SIGNATURE)) throw new Error('not a KTX2 file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const levels = Math.max(1, view.getUint32(40, true));
  const supercompression = view.getUint32(44, true);
  const dfdOffset = view.getUint32(48, true);
  // DFD: u32 total size, then the basic block: u32 vendor/type, u16 version, u16 size, u8 model,
  // u8 primaries, u8 transfer.
  const colorModel = view.getUint8(dfdOffset + 12);
  const transfer = view.getUint8(dfdOffset + 14);
  const codec = colorModel === 163 ? 'ETC1S' : colorModel === 166 ? 'UASTC' : 'other';
  const superNames = ['none', 'BasisLZ', 'Zstd', 'ZLIB'];
  return {
    width,
    height,
    levels,
    codec,
    srgb: transfer === 2,
    supercompression: superNames[supercompression] ?? String(supercompression),
  };
}

/** Reads only the first bytes of a .ktx2 file (enough for the header and DFD). */
export function readKtx2InfoFromFile(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = new Uint8Array(512);
    readSync(fd, buffer, 0, buffer.length, 0);
    return readKtx2Info(buffer);
  } finally {
    closeSync(fd);
  }
}

/**
 * Size after capping the longer edge to `maxSize`, keeping the aspect ratio. Both edges are
 * rounded to a multiple of 4 (block-compressed GPU formats need it on some drivers).
 */
export function fitTextureSize(width, height, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const round4 = (value) => Math.max(4, Math.round((value * scale) / 4) * 4);
  return { width: round4(width), height: round4(height) };
}

/**
 * Picks the Basis codec. UASTC keeps detail (normal/data maps, small colour maps where ETC1S
 * blocks show); ETC1S is several times smaller and fine for large painterly colour maps.
 */
export function chooseKtxMode({ mode = 'auto', srgb, normal = false, width, height }) {
  if (mode === 'uastc' || mode === 'etc1s') return mode;
  if (mode !== 'auto') throw new Error(`unknown texture mode "${mode}" (auto|uastc|etc1s)`);
  if (normal || !srgb) return 'uastc';
  return Math.max(width, height) >= 512 ? 'etc1s' : 'uastc';
}

/**
 * Encodes one PNG/JPEG file to KTX2.
 * @param {object} o
 * @param {string} o.input PNG or JPEG path
 * @param {string} o.output .ktx2 path
 * @param {number} o.srcWidth
 * @param {number} o.srcHeight
 * @param {boolean} o.srgb colour data (base colour, emissive) vs linear data (normal, ORM, masks)
 * @param {boolean} [o.normal] tangent-space normal map (forces UASTC in auto mode)
 * @param {'auto'|'uastc'|'etc1s'} [o.mode]
 * @param {number} o.maxSize edge cap in pixels
 * @param {boolean} [o.mipmaps] default true
 * @returns {{ mode: string, width: number, height: number, bytes: number }}
 */
export function encodeKtx2(o) {
  const size = fitTextureSize(o.srcWidth, o.srcHeight, o.maxSize);
  const mode = chooseKtxMode({ ...o, width: size.width, height: size.height });
  const args = ['--t2', '--assign_oetf', o.srgb ? 'srgb' : 'linear'];
  if (o.mipmaps !== false) args.push('--genmipmap');
  if (size.width !== o.srcWidth || size.height !== o.srcHeight) {
    args.push('--resize', `${size.width}x${size.height}`);
  }
  if (mode === 'etc1s') {
    args.push('--encode', 'etc1s', '--clevel', '4', '--qlevel', '200');
  } else {
    // RDO + Zstd roughly halves UASTC on disk; the GPU size is the same either way.
    args.push('--encode', 'uastc', '--uastc_quality', '3', '--uastc_rdo_l', '0.75', '--zcmp', '18');
  }
  args.push(o.output, o.input);
  run(findKtxTool('toktx'), args);
  const bytes = readFileSync(o.output);
  const info = readKtx2Info(bytes);
  return { mode, width: info.width, height: info.height, levels: info.levels, bytes: bytes.length };
}
