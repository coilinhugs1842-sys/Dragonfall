#!/usr/bin/env node
// npm run assets:audio -- <in.wav|dir> <out.ogg|dir> [--kind sfx|music|ambience] [--mono]
//                         [--quality 0..10] [--lufs <n>] [--peak <dBTP>]
//
// WAV -> Ogg Vorbis with loudness normalisation (docs/ASSET_PIPELINE.md section 4):
//   music     integrated loudness -16 LUFS (two-pass loudnorm, linear gain), true peak <= -1.5 dBTP
//   ambience  integrated loudness -23 LUFS, same method
//   sfx       true peak -1 dBTP (plain gain; loudness of short sounds is balanced in the mixer)
//
// Vorbis, not Opus: decodeAudioData in Chrome, Edge and Firefox all decode Ogg Vorbis, it keeps
// the source sample rate, and it has no encoder padding, so loops stay gapless.
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { findFfmpeg, formatBytes, isMain, parseArgs, run } from './lib/common.mjs';

export const AUDIO_PRESETS = {
  music: { method: 'loudness', lufs: -16, peak: -1.5, quality: 5 },
  ambience: { method: 'loudness', lufs: -23, peak: -1.5, quality: 4 },
  sfx: { method: 'peak', peak: -1, quality: 5 },
};

const SAMPLE_RATE = 44100;
/** Lossy encoding moves peaks a little; accept this much over the target before re-encoding. */
const PEAK_TOLERANCE_DB = 0.1;

/** EBU R128 measurement of a file: integrated loudness, true peak, range, threshold. */
export function measureLoudness(file) {
  const { stderr } = run(findFfmpeg(), [
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-af',
    'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
    '-f',
    'null',
    '-',
  ]);
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`no loudnorm measurement for ${file}`);
  const json = JSON.parse(stderr.slice(start, end + 1));
  return {
    lufs: Number(json.input_i),
    truePeak: Number(json.input_tp),
    range: Number(json.input_lra),
    threshold: Number(json.input_thresh),
    targetOffset: Number(json.target_offset),
  };
}

function encode(input, output, filter, { mono, quality }) {
  const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-i', input, '-vn'];
  args.push('-af', filter, '-ar', String(SAMPLE_RATE));
  if (mono) args.push('-ac', '1');
  args.push('-map_metadata', '-1', '-c:a', 'libvorbis', '-q:a', String(quality), output);
  run(findFfmpeg(), args);
}

/**
 * @param {string} input WAV (anything ffmpeg reads)
 * @param {string} output .ogg
 * @param {object} [options]
 * @param {'sfx'|'music'|'ambience'} [options.kind] default sfx
 * @param {boolean} [options.mono] downmix (use for positional SFX)
 * @param {number} [options.quality] libvorbis -q:a
 * @param {number} [options.lufs] loudness target override (music/ambience)
 * @param {number} [options.peak] true-peak target/ceiling override, dBTP
 */
export function convertAudio(input, output, options = {}) {
  const kind = options.kind ?? 'sfx';
  const preset = AUDIO_PRESETS[kind];
  if (!preset) throw new Error(`--kind must be one of ${Object.keys(AUDIO_PRESETS).join(', ')}`);
  const peak = options.peak ?? preset.peak;
  const quality = options.quality ?? preset.quality;
  const mono = options.mono === true;
  mkdirSync(dirname(resolve(output)), { recursive: true });

  const source = measureLoudness(input);
  if (!Number.isFinite(source.truePeak)) throw new Error(`${input} is silent`);

  // Gain in dB that the chosen method asks for; the loop below lowers it if the encoded file
  // overshoots the true-peak ceiling.
  let gain;
  if (preset.method === 'peak') {
    gain = peak - source.truePeak;
  } else {
    const lufs = options.lufs ?? preset.lufs;
    if (!Number.isFinite(source.lufs)) throw new Error(`${input} is too short or quiet to measure`);
    // Linear gain to the loudness target, limited so the true peak stays under the ceiling
    // (a quieter result is better than a limiter pumping the mix).
    gain = Math.min(lufs - source.lufs, peak - source.truePeak);
  }

  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    encode(input, output, `volume=${gain.toFixed(2)}dB`, { mono, quality });
    result = measureLoudness(output);
    const overshoot = result.truePeak - peak;
    if (overshoot <= PEAK_TOLERANCE_DB) break;
    gain -= overshoot;
  }
  return {
    kind,
    gainDb: gain,
    source,
    result,
    bytes: statSync(output).size,
    srcBytes: statSync(input).size,
  };
}

function describe(input, output, r) {
  const fmt = (value) => (Number.isFinite(value) ? value.toFixed(1) : '-inf');
  return (
    `${input} (${formatBytes(r.srcBytes)}, ${fmt(r.source.lufs)} LUFS, ${fmt(r.source.truePeak)} dBTP) -> ` +
    `${output} (${formatBytes(r.bytes)}, ${fmt(r.result.lufs)} LUFS, ${fmt(r.result.truePeak)} dBTP, ` +
    `gain ${r.gainDb >= 0 ? '+' : ''}${r.gainDb.toFixed(2)} dB, ${r.kind})`
  );
}

function main() {
  const { positional, options } = parseArgs(process.argv.slice(2), ['mono']);
  const [input, output] = positional;
  if (!input || !output) {
    console.error(
      'usage: npm run assets:audio -- <in.wav|dir> <out.ogg|dir> [--kind sfx|music|ambience] [--mono]\n' +
        '         [--quality 0..10] [--lufs <n>] [--peak <dBTP>]',
    );
    process.exit(2);
  }
  const convertOptions = {
    kind: options.kind,
    mono: options.mono === true,
    quality: options.quality !== undefined ? Number(options.quality) : undefined,
    lufs: options.lufs !== undefined ? Number(options.lufs) : undefined,
    peak: options.peak !== undefined ? Number(options.peak) : undefined,
  };
  if (statSync(input).isDirectory()) {
    const files = readdirSync(input)
      .filter((name) => /\.(wav|flac|aiff?)$/i.test(name))
      .sort();
    if (files.length === 0) throw new Error(`no .wav files in ${input}`);
    for (const name of files) {
      const from = join(input, name);
      const to = join(output, `${basename(name, extname(name))}.ogg`);
      console.log(describe(from, to, convertAudio(from, to, convertOptions)));
    }
  } else {
    if (extname(output).toLowerCase() !== '.ogg') throw new Error('output must end in .ogg');
    console.log(describe(input, output, convertAudio(input, output, convertOptions)));
  }
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`assets:audio failed: ${error.message}`);
    process.exit(1);
  }
}
