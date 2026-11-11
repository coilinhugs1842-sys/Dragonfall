#!/usr/bin/env node
// npm run assets:optimize -- <in.glb> <out.glb> [--kind dragon|rock|prop] [options]
//
// Raw GLB (Blender export) -> runtime GLB: dedup, prune, weld, resample animations, KTX2 textures,
// meshopt compression. The structure the runtime addresses by name is kept and verified: nodes
// (LOD0..LOD2, sockets), bones, animation clips, materials and vertex colours.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  EXTMeshoptCompression,
  KHRMeshQuantization,
  KHRTextureBasisu,
} from '@gltf-transform/extensions';
import {
  dedup,
  listTextureSlots,
  prune,
  quantize,
  reorder,
  resample,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { TEXTURE_CAPS, formatBytes, isMain, parseArgs } from './lib/common.mjs';
import { analyzeDocument, analyzeFile, checkGlbBudgets, getIO, inferKind } from './lib/glb.mjs';
import { encodeKtx2 } from './lib/ktx.mjs';
import { printGlbReport } from './inspect.mjs';

const KINDS = ['dragon', 'rock', 'prop'];
const SRGB_SLOTS = /^(baseColor|emissive|sheenColor|specularColor)Texture$/;
const NORMAL_SLOTS = /normalTexture$/i;

/** glTF logs every transform at info level; keep the CLI output to warnings. */
const QUIET_LOGGER = {
  debug() {},
  info() {},
  warn: (message) => console.warn(`  warn: ${message}`),
  error: (message) => console.error(`  error: ${message}`),
};

/** Converts every PNG/JPEG texture in the document to KTX2 in place. */
function compressTextures(document, { maxTextureSize, textureMode }) {
  const textures = document.getRoot().listTextures();
  const results = [];
  if (textures.length === 0) return results;
  const workDir = mkdtempSync(join(tmpdir(), 'dragonfall-ktx-'));
  try {
    textures.forEach((texture, index) => {
      const mimeType = texture.getMimeType();
      const label = texture.getName() || texture.getURI() || `texture${index}`;
      if (mimeType === 'image/ktx2') {
        const size = texture.getSize();
        if (size && Math.max(size[0], size[1]) > maxTextureSize) {
          throw new Error(
            `texture "${label}" is already KTX2 at ${size[0]}x${size[1]}, over the ` +
              `${maxTextureSize} cap; re-export it as PNG so it can be resized`,
          );
        }
        return;
      }
      if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
        throw new Error(
          `texture "${label}" is ${mimeType}; only PNG and JPEG sources are supported`,
        );
      }
      const image = texture.getImage();
      const size = texture.getSize();
      if (!image || !size) throw new Error(`texture "${label}" has no readable image data`);
      const slots = listTextureSlots(texture);
      const srgb = slots.some((slot) => SRGB_SLOTS.test(slot));
      const normal = slots.some((slot) => NORMAL_SLOTS.test(slot));
      if (srgb && slots.some((slot) => !SRGB_SLOTS.test(slot))) {
        throw new Error(
          `texture "${label}" is used as both colour and data (${slots.join(', ')}); split it`,
        );
      }
      const input = join(workDir, `${index}.${mimeType === 'image/png' ? 'png' : 'jpg'}`);
      const output = join(workDir, `${index}.ktx2`);
      writeFileSync(input, image);
      const encoded = encodeKtx2({
        input,
        output,
        srcWidth: size[0],
        srcHeight: size[1],
        srgb,
        normal,
        mode: textureMode,
        maxSize: maxTextureSize,
      });
      texture.setImage(readFileSync(output)).setMimeType('image/ktx2');
      const uri = texture.getURI();
      if (uri) texture.setURI(uri.replace(/\.(png|jpe?g)$/i, '.ktx2'));
      results.push({
        name: label,
        slots,
        from: `${size[0]}x${size[1]} ${formatBytes(image.byteLength)}`,
        to: `${encoded.width}x${encoded.height} ${encoded.mode} ${formatBytes(encoded.bytes)}`,
      });
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (results.length > 0) document.createExtension(KHRTextureBasisu).setRequired(true);
  return results;
}

/** What must survive optimisation, from an analysis. */
function structureOf(analysis) {
  return {
    nodes: new Set(analysis.nodeNames.filter((name) => name !== '')),
    bones: new Set(analysis.bones),
    clips: new Set(analysis.clips.map((clip) => clip.name)),
    materials: new Set(analysis.materials),
    colorPrimitives: analysis.colorPrimitives,
    lodTriangles: analysis.lods.map((lod) => `LOD${lod.index}=${lod.triangles}`).join(' '),
  };
}

/** Names present before and missing after, as messages (empty when the structure is intact). */
export function compareStructure(before, after) {
  const problems = [];
  for (const group of ['nodes', 'bones', 'clips', 'materials']) {
    const missing = [...before[group]].filter((name) => !after[group].has(name));
    if (missing.length > 0) problems.push(`${group} lost: ${missing.join(', ')}`);
  }
  if (before.colorPrimitives !== after.colorPrimitives) {
    problems.push(
      `primitives with vertex colours: ${before.colorPrimitives} before, ${after.colorPrimitives} after`,
    );
  }
  if (before.lodTriangles !== after.lodTriangles) {
    problems.push(`LOD triangles changed: "${before.lodTriangles}" -> "${after.lodTriangles}"`);
  }
  return problems;
}

/**
 * @param {string} input raw GLB
 * @param {string} output runtime GLB
 * @param {object} [options]
 * @param {'dragon'|'rock'|'prop'} [options.kind] sets the texture cap and the budget check
 * @param {number} [options.maxTextureSize] overrides the cap for the kind
 * @param {'auto'|'uastc'|'etc1s'} [options.textureMode]
 * @param {boolean} [options.quantizeAll] also quantise POSITION and TEXCOORD (smaller; rewrites
 *   node transforms / adds KHR_texture_transform, so off by default)
 */
export async function optimizeGlb(input, output, options = {}) {
  const io = await getIO();
  const document = await io.read(input);
  document.setLogger(QUIET_LOGGER);
  const inputBytes = statSync(input).size;
  const before = structureOf(analyzeDocument(document, inputBytes));
  const kind = options.kind ?? inferKind(output, analyzeDocument(document, inputBytes));
  const maxTextureSize =
    options.maxTextureSize ?? (kind ? TEXTURE_CAPS[kind] : TEXTURE_CAPS.dragon);

  await document.transform(
    // keepUniqueNames: two tint-slot materials with equal values must stay two materials.
    dedup({ keepUniqueNames: true }),
    // keepLeaves: empty named nodes are sockets (muzzle, rider seat). keepAttributes: COLOR_0 and
    // extra UV sets are read by our own shaders, which prune cannot see.
    prune({ keepLeaves: true, keepAttributes: true, keepSolidTextures: true, keepExtras: true }),
    weld(),
    resample(),
    prune({ keepLeaves: true, keepAttributes: true, keepSolidTextures: true, keepExtras: true }),
  );

  const textures = compressTextures(document, {
    maxTextureSize,
    textureMode: options.textureMode ?? 'auto',
  });

  await MeshoptEncoder.ready;
  const pattern = options.quantizeAll ? /.*/ : /^(NORMAL|TANGENT|COLOR|JOINTS|WEIGHTS)(_\d+)?$/;
  await document.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern, patternTargets: pattern }),
  );
  // Normalised integer normals/colours/weights are only legal glTF with this extension declared.
  document.createExtension(KHRMeshQuantization).setRequired(true);
  document
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

  mkdirSync(dirname(resolve(output)), { recursive: true });
  await io.write(output, document);

  // Verify from the file on disk, not from the in-memory document.
  const analysis = await analyzeFile(output);
  const problems = compareStructure(before, structureOf(analysis));
  if (problems.length > 0) {
    throw new Error(`optimize changed the asset structure:\n  ${problems.join('\n  ')}`);
  }
  return { kind, inputBytes, analysis, textures, findings: checkGlbBudgets(analysis, kind) };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2), ['quantize-all', 'no-budget']);
  const [input, output] = positional;
  if (!input || !output) {
    console.error(
      'usage: npm run assets:optimize -- <in.glb> <out.glb> [--kind dragon|rock|prop]\n' +
        '         [--max-texture <px>] [--texture-mode auto|uastc|etc1s] [--quantize-all] [--no-budget]',
    );
    process.exit(2);
  }
  if (options.kind !== undefined && !KINDS.includes(options.kind)) {
    throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  }
  if (resolve(input) === resolve(output)) throw new Error('input and output must differ');
  const result = await optimizeGlb(input, output, {
    kind: options.kind,
    maxTextureSize: options['max-texture'] ? Number(options['max-texture']) : undefined,
    textureMode: options['texture-mode'],
    quantizeAll: options['quantize-all'] === true,
  });
  console.log(
    `${input} (${formatBytes(result.inputBytes)}) -> ${output} ` +
      `(${formatBytes(result.analysis.fileBytes)})`,
  );
  for (const texture of result.textures) {
    console.log(
      `  texture ${texture.name} [${texture.slots.join(', ')}]: ${texture.from} -> ${texture.to}`,
    );
  }
  const errors = printGlbReport(output, result.analysis, result.kind, result.findings);
  if (errors > 0 && options['no-budget'] !== true) process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`assets:optimize failed: ${error.message}`);
    process.exit(1);
  });
}
