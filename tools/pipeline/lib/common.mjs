// Shared helpers for the asset pipeline tools (Node, no browser APIs).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PIPELINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(PIPELINE_DIR, '..', '..');

const mirror = JSON.parse(readFileSync(join(PIPELINE_DIR, 'budgets.json'), 'utf8'));

/** Mirror of ASSET_BUDGETS (src/shared/manifests.ts); kept equal by tests/tools/budgets.test.ts. */
export const BUDGETS = mirror.assetBudgets;
export const DRAGON_ANIM_CLIPS = mirror.dragonAnimClips;
export const DRAGON_CLASS_IDS = mirror.dragonClassIds;
export const MAP_IDS = mirror.mapIds;

/** Texture edge cap per asset kind, in pixels (dragon follows ASSET_BUDGETS). */
export const TEXTURE_CAPS = {
  dragon: BUDGETS.dragonMaxTextureSize,
  rock: 1024,
  prop: 512,
  sky: 4096,
};

/** True when `metaUrl` is the script Node was started with. */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === metaUrl;
}

/**
 * Minimal argv parser: `--key value`, `--key=value`, bare `--flag` (for names listed in
 * `booleans`), everything else positional.
 */
export function parseArgs(argv, booleans = []) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (booleans.includes(key)) {
      options[key] = true;
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`option --${key} needs a value`);
      }
      options[key] = value;
      i++;
    }
  }
  return { positional, options };
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const KTX_DEFAULT_DIR = 'C:\\Program Files\\KTX-Software\\bin';

/** Finds a KTX-Software binary: $KTX_BIN, the default Windows install folder, then PATH. */
export function findKtxTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  if (process.env['KTX_BIN']) candidates.push(join(process.env['KTX_BIN'], exe));
  if (process.platform === 'win32') candidates.push(join(KTX_DEFAULT_DIR, exe));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return exe; // rely on PATH
}

export function findFfmpeg() {
  return process.env['FFMPEG'] ?? 'ffmpeg';
}

/** Runs a program without a shell; throws with its stderr when it fails. */
export function run(file, args, { allowFail = false } = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`could not start ${file}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `${file} exited with ${result.status}\n${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Prints rows as a padded text table. */
export function table(rows) {
  if (rows.length === 0) return '';
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, String(cell).length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => String(cell).padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
