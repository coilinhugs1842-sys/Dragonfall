/**
 * Scout a shot: a quick small recording of it and a contact sheet, to pick its times from.
 *
 *   node tools/trailer/scout.mjs <shot id> [--seconds 60] [--seed <n>] [--tiles 1]
 *        [--from "<expression>"] [--start <seconds>] [--base http://localhost:5199]
 *
 * Records the shot's page from the start of the fight (or `--from` / `--start`) at 960x540,
 * 60 steps a second (the same steps as the real recording, so a seeded match plays out the
 * same), with the shot's own seed, camera and UI, and writes
 *   art-source/_scratch/trailer/scout/<id>[-<seed>].mp4   and   .jpg (one tile every 1/tiles s).
 * Tile n of the sheet is n / tiles seconds after the start: put that in the shot's `from`.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAMERAS } from './cameras.mjs';
import { SHOTS } from './shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRATCH = resolve(ROOT, 'art-source/_scratch/trailer');
const TEMP_DIR = resolve(SCRATCH, 'tmp');
const OUT_DIR = resolve(SCRATCH, 'scout');

const argv = process.argv.slice(2);
const id = argv[0];
const args = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i] ?? 'true';
}
const shot = SHOTS.find((entry) => entry.id === id);
if (shot === undefined) {
  process.stderr.write(`scout: no shot "${id}". Shots: ${SHOTS.map((entry) => entry.id).join(', ')}\n`);
  process.exit(2);
}

const base = (args.base ?? process.env.DRAGONFALL_URL ?? 'http://localhost:5199').replace(/\/$/, '');
const seconds = Number(args.seconds ?? 60);
const tiles = Number(args.tiles ?? 1);
const seed = args.seed ?? shot.seed;
const live = shot.url.includes('autostart');
const from = args.from ?? (live ? `window.__dragonfall.report().phase === 'playing'` : undefined);

mkdirSync(TEMP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
const name = seed === undefined ? id : `${id}-${seed}`;
const video = resolve(OUT_DIR, `${name}.mp4`);
const sheet = resolve(OUT_DIR, `${name}.jpg`);

const recorderArgs = [
  resolve(ROOT, 'tools/capture/record.mjs'), '--url', base + shot.url, '--out', video,
  '--seconds', String(seconds), '--fps', '60', '--size', '960x540', '--format', 'jpeg',
  '--crf', '24', '--ui', shot.ui ?? 'game',
];
if (seed !== undefined) recorderArgs.push('--seed', String(seed));
if (from !== undefined) recorderArgs.push('--from', from, '--max', '240');
if (args.start !== undefined) recorderArgs.push('--start', args.start);
if (shot.camera) {
  const setupFile = resolve(TEMP_DIR, `scout-${id}.setup.js`);
  writeFileSync(setupFile, CAMERAS[shot.camera]);
  recorderArgs.push('--setup-file', setupFile);
}

const env = { ...process.env, TEMP: TEMP_DIR, TMP: TEMP_DIR };
const take = spawnSync('node', recorderArgs, { env, encoding: 'utf8', maxBuffer: 1 << 26 });
let report = null;
try {
  report = JSON.parse(take.stdout);
} catch {
  // No report: the recorder itself died.
}
if (report === null || !report.ok) {
  process.stderr.write(`scout: the recording failed: ${report?.error ?? take.stderr.slice(-600)}\n`);
  process.exit(1);
}
const count = Math.ceil(seconds * tiles);
const columns = Math.min(count, 6);
spawnSync(
  'ffmpeg',
  [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
    '-vf', `fps=${tiles},scale=480:-1,tile=${columns}x${Math.ceil(count / columns)}`,
    '-frames:v', '1', '-q:v', '3', sheet,
  ],
  { env },
);
process.stdout.write(
  `${JSON.stringify({ shot: id, seed: seed ?? null, startS: report.shotStartS, seconds, video, sheet }, null, 1)}\n`,
);
