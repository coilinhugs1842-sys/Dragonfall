#!/usr/bin/env node
// npm run assets:inspect -- <file|dir> [--kind dragon|rock|prop] [--json]
//
// Prints triangles per LOD node, bones, clips, materials, textures and file sizes; exits 1 when
// ASSET_BUDGETS (src/shared/manifests.ts, mirrored in budgets.json) are exceeded.
import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { BUDGETS, formatBytes, isMain, parseArgs, table } from './lib/common.mjs';
import { analyzeFile, checkGlbBudgets, inferKind } from './lib/glb.mjs';
import { readKtx2InfoFromFile } from './lib/ktx.mjs';

const AUDIO_EXTENSIONS = new Set(['.ogg']);
/** Source formats that must not sit in a runtime folder (CLAUDE.md golden rule 6). */
const RAW_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.wav', '.gltf', '.blend', '.fbx']);

function printFindings(findings) {
  let errors = 0;
  for (const finding of findings) {
    if (finding.level === 'error') errors += 1;
    console.log(`  ${finding.level === 'error' ? 'OVER BUDGET' : 'note'}: ${finding.message}`);
  }
  return errors;
}

/** Prints one GLB's report; returns the number of budget errors. */
export function printGlbReport(path, analysis, kind, findings) {
  console.log(
    `\n${path}  [${kind ?? 'no kind: budgets not checked'}]  ${formatBytes(analysis.fileBytes)}`,
  );
  const rows = [];
  for (const lod of analysis.lods) {
    rows.push([
      `  LOD${lod.index}`,
      `${lod.triangles} tris`,
      `${lod.vertices} verts`,
      `${lod.primitives} prims`,
      lod.nodes.join(', '),
    ]);
  }
  rows.push([
    '  scene',
    `${analysis.total.triangles} tris`,
    `${analysis.total.vertices} verts`,
    `${analysis.total.primitives} prims`,
    analysis.lods.length === 0 ? '(no LOD nodes)' : '(all LODs)',
  ]);
  console.log(table(rows));
  console.log(
    `  bones: ${analysis.bones.length}` +
      (analysis.bones.length > 0 ? ` (${analysis.bones.join(', ')})` : ''),
  );
  console.log(
    `  clips: ${analysis.clips.length}` +
      (analysis.clips.length > 0
        ? ` (${analysis.clips.map((clip) => `${clip.name} ${clip.duration.toFixed(2)}s`).join(', ')})`
        : ''),
  );
  console.log(`  materials: ${analysis.materials.length} (${analysis.materials.join(', ')})`);
  console.log(
    `  vertex colours: ${analysis.colorPrimitives} of ${analysis.primitiveCount} primitives`,
  );
  if (analysis.textures.length === 0) {
    console.log('  textures: none');
  } else {
    console.log(
      table(
        analysis.textures.map((texture) => [
          '  texture',
          texture.name,
          `${texture.width}x${texture.height}`,
          texture.mimeType,
          formatBytes(texture.bytes),
          texture.slots.join(', '),
        ]),
      ),
    );
  }
  console.log(`  extensions: ${analysis.extensionsUsed.join(', ') || 'none'}`);
  return printFindings(findings);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function isSkyPanorama(path) {
  return /(^|[\\/_.-])(sky|panorama)([\\/_.-]|$)/i.test(path);
}

/** Budget findings for a standalone .ktx2 file. */
export function checkKtx2Budgets(path, info, bytes) {
  const findings = [];
  if (isSkyPanorama(path)) {
    if (bytes > BUDGETS.skyPanoramaMaxFileBytes) {
      findings.push({
        level: 'error',
        message: `sky panorama is ${formatBytes(bytes)}, budget ${formatBytes(BUDGETS.skyPanoramaMaxFileBytes)}`,
      });
    }
    if (info.width > 4096 || info.height > 2048) {
      findings.push({
        level: 'error',
        message: `sky panorama is ${info.width}x${info.height}, budget 4096x2048`,
      });
    }
  } else if (Math.max(info.width, info.height) > 2048) {
    findings.push({
      level: 'warn',
      message: `${info.width}x${info.height} is large for a shared texture`,
    });
  }
  if (info.levels === 1 && !isSkyPanorama(path)) {
    findings.push({ level: 'warn', message: 'no mipmaps' });
  }
  return findings;
}

/**
 * Inspects one file or every asset under a directory.
 * @returns {Promise<{ errors: number, files: object[] }>}
 */
export async function inspectPath(target, { kind, quiet = false } = {}) {
  const stat = statSync(target);
  const files = stat.isDirectory() ? walk(target).sort() : [target];
  const log = quiet ? () => {} : console.log;
  let errors = 0;
  const report = [];
  const totals = { glb: 0, ktx2: 0, audio: 0, other: 0 };

  for (const file of files) {
    const extension = extname(file).toLowerCase();
    const bytes = statSync(file).size;
    const shown = stat.isDirectory() ? relative(target, file).replace(/\\/g, '/') : file;
    if (extension === '.glb') {
      totals.glb += bytes;
      const analysis = await analyzeFile(file);
      const fileKind = kind ?? inferKind(file, analysis);
      const findings = checkGlbBudgets(analysis, fileKind);
      const fileErrors = findings.filter((finding) => finding.level === 'error').length;
      if (!quiet) printGlbReport(shown, analysis, fileKind, findings);
      errors += fileErrors;
      report.push({ file: shown, type: 'glb', kind: fileKind, bytes, analysis, findings });
    } else if (extension === '.ktx2') {
      totals.ktx2 += bytes;
      const info = readKtx2InfoFromFile(file);
      const findings = checkKtx2Budgets(file, info, bytes);
      log(
        `\n${shown}  [ktx2]  ${formatBytes(bytes)}  ${info.width}x${info.height}  ${info.codec}` +
          `  ${info.srgb ? 'sRGB' : 'linear'}  ${info.levels} mip level(s)  super: ${info.supercompression}`,
      );
      if (!quiet) printFindings(findings);
      errors += findings.filter((finding) => finding.level === 'error').length;
      report.push({ file: shown, type: 'ktx2', bytes, info, findings });
    } else if (AUDIO_EXTENSIONS.has(extension)) {
      totals.audio += bytes;
      log(`\n${shown}  [audio]  ${formatBytes(bytes)}`);
      report.push({ file: shown, type: 'audio', bytes, findings: [] });
    } else {
      totals.other += bytes;
      const findings = [];
      if (stat.isDirectory() && RAW_EXTENSIONS.has(extension)) {
        findings.push({
          level: 'warn',
          message: 'raw source format in a runtime folder; run it through the pipeline',
        });
        log(`\n${shown}  [raw]  ${formatBytes(bytes)}`);
        if (!quiet) printFindings(findings);
      }
      report.push({ file: shown, type: 'other', bytes, findings });
    }
  }

  if (stat.isDirectory()) {
    const sum = totals.glb + totals.ktx2 + totals.audio + totals.other;
    log(
      `\nTotal ${formatBytes(sum)} in ${files.length} file(s): GLB ${formatBytes(totals.glb)}, ` +
        `KTX2 ${formatBytes(totals.ktx2)}, audio ${formatBytes(totals.audio)}, other ${formatBytes(totals.other)}`,
    );
    // A directory that is one map's folder is held to the map download budgets.
    if (/[\\/]maps[\\/][^\\/]+[\\/]?$/.test(target)) {
      if (sum > BUDGETS.mapMaxDownloadBytes) {
        errors += 1;
        log(
          `  OVER BUDGET: map download ${formatBytes(sum)}, budget ${formatBytes(BUDGETS.mapMaxDownloadBytes)}`,
        );
      }
      if (totals.audio > BUDGETS.mapMaxAudioBytes) {
        errors += 1;
        log(
          `  OVER BUDGET: map audio ${formatBytes(totals.audio)}, budget ${formatBytes(BUDGETS.mapMaxAudioBytes)}`,
        );
      }
    }
  }
  return { errors, files: report, totals };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2), ['json']);
  const [target] = positional;
  if (!target) {
    console.error('usage: npm run assets:inspect -- <file|dir> [--kind dragon|rock|prop] [--json]');
    process.exit(2);
  }
  const result = await inspectPath(target, { kind: options.kind, quiet: options.json === true });
  if (options.json === true) console.log(JSON.stringify(result, null, 2));
  else
    console.log(result.errors === 0 ? '\nWithin budget.' : `\n${result.errors} budget error(s).`);
  process.exit(result.errors === 0 ? 0 : 1);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`assets:inspect failed: ${error.message}`);
    process.exit(1);
  });
}
