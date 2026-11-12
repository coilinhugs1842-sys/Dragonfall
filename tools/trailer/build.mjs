/**
 * Builds the trailer's rough cut from ./shots.mjs: records every shot that is not there yet
 * (tools/capture/record.mjs, frame-exact), then cuts them with ffmpeg and lays the game's own
 * music under the picture.
 *
 *   node tools/trailer/build.mjs
 *        [--base http://localhost:5199]   the dev server (or a built copy of the game)
 *        [--force]                        record every shot again
 *        [--only id,id]                   record only these (again); the cut is still made
 *        [--no-record]                    cut what is already recorded
 *        [--no-cut]                       only record
 *        [--list]                         print the plan and stop
 *        [--jobs 2]                       shots recorded at the same time
 *        [--format jpeg|png]              what the browser hands over per frame: jpeg (quality
 *                                         95, about three times faster; the default, for a
 *                                         rough cut) or png (lossless, for the final)
 *        [--fps 60] [--size 1920x1080] [--crf 18]   (the shots themselves are CRF 15)
 *        [--out art-source/trailer/dragonfall-trailer-rough.mp4]
 *
 * A shot is recorded again by itself when its entry in shots.mjs changed. Recordings, their
 * contact sheets and everything temporary stay in art-source/_scratch/trailer (git-ignored, on
 * the project's drive); only the cut and its plan (`<out>.json`) go to art-source/trailer.
 * Shots marked `placeholder` are skipped, with every piece of the cut that uses them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMERAS } from './cameras.mjs';
import { CUT, MUSIC, SHOTS } from './shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRATCH = resolve(ROOT, 'art-source/_scratch/trailer');
const SHOT_DIR = resolve(SCRATCH, 'shots');
const TEMP_DIR = resolve(SCRATCH, 'tmp');
const AUDIO_DIR = resolve(ROOT, 'public/assets/audio');
const RECORDER = resolve(ROOT, 'tools/capture/record.mjs');
/** A take that died of someone else's half-saved edit is tried again after this long. */
const RETRY_WAIT_MS = 20000;
const RECORD_RUNS = 3;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[token.slice(2)] = 'true';
    else {
      args[token.slice(2)] = next;
      i++;
    }
  }
  return args;
}

function log(text) {
  process.stderr.write(`trailer: ${text}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rel = (file) => relative(ROOT, file).replaceAll('\\', '/');

const args = parseArgs(process.argv.slice(2));
const base = (args.base ?? process.env.DRAGONFALL_URL ?? 'http://localhost:5199').replace(/\/$/, '');
const fps = Number(args.fps ?? 60);
const size = args.size ?? '1920x1080';
const format = args.format === 'png' ? 'png' : 'jpeg';
const jobs = Math.max(1, Number(args.jobs ?? 2));
const out = resolve(ROOT, args.out ?? 'art-source/trailer/dragonfall-trailer-rough.mp4');
const only = args.only ? new Set(args.only.split(',').map((id) => id.trim())) : null;
// ffmpeg and ffprobe write their temporary files where these point: not the system drive.
const toolEnv = { ...process.env, TEMP: TEMP_DIR, TMP: TEMP_DIR };

// ---- The plan ------------------------------------------------------------------------------------

const shotById = new Map(SHOTS.map((shot) => [shot.id, shot]));
for (const piece of CUT) {
  if (!shotById.has(piece.shot)) throw new Error(`shots.mjs: the cut names an unknown shot "${piece.shot}"`);
}
const skipped = CUT.filter((piece) => shotById.get(piece.shot).placeholder);
const pieces = [];
{
  let at = 0;
  for (const piece of CUT) {
    const shot = shotById.get(piece.shot);
    if (shot.placeholder) continue;
    // Every boundary is rounded on its own, so rounding never adds up along the cut.
    const startFrame = Math.round(at * fps);
    at += piece.length;
    const frames = Math.round(at * fps) - startFrame;
    const xfadeFrames = pieces.length === 0 ? 0 : Math.round((piece.xfade ?? 0) * fps);
    const inFrame = Math.round((piece.in ?? 0) * fps);
    // A cross-fade happens over the end of the piece before: this one starts that much earlier.
    const takeFrames = frames + xfadeFrames;
    if (inFrame + takeFrames > Math.round(shot.seconds * fps)) {
      throw new Error(
        `shots.mjs: "${shot.id}" is ${shot.seconds} s long but the cut wants ` +
          `${((inFrame + takeFrames) / fps).toFixed(2)} s of it`,
      );
    }
    pieces.push({ ...piece, shotInfo: shot, startFrame, frames, xfadeFrames, inFrame, takeFrames });
  }
}
const totalFrames = pieces.reduce((sum, piece) => sum + piece.frames, 0);
const totalS = totalFrames / fps;
const startOf = (shotId) => {
  const piece = pieces.find((entry) => entry.shot === shotId);
  if (piece === undefined) throw new Error(`shots.mjs: MUSIC names "${shotId}", which is not in the cut`);
  return piece.startFrame / fps;
};

function printPlan() {
  log(`the cut: ${totalS.toFixed(2)} s, ${totalFrames} frames at ${fps} fps, ${size}`);
  for (const piece of pieces) {
    const join = piece.xfadeFrames > 0 ? `cross-fade ${(piece.xfadeFrames / fps).toFixed(2)} s` : 'cut';
    log(
      `  ${(piece.startFrame / fps).toFixed(2).padStart(6)} s  ${(piece.frames / fps).toFixed(2).padStart(5)} s  ` +
        `${piece.shot.padEnd(14)} ${join.padEnd(18)} ${piece.shotInfo.what}`,
    );
  }
  for (const piece of skipped) {
    log(`  skipped (placeholder): ${piece.shot}: ${shotById.get(piece.shot).placeholder}`);
  }
}
printPlan();
if (args.list === 'true') process.exit(0);

mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync(TEMP_DIR, { recursive: true });
mkdirSync(dirname(out), { recursive: true });

// ---- Recording -----------------------------------------------------------------------------------

const shotFile = (shot) => resolve(SHOT_DIR, `${shot.id}.mp4`);
const specFile = (shot) => resolve(SHOT_DIR, `${shot.id}.spec.json`);

/** Everything a recording depends on: a change here means the shot is recorded again. */
function specOf(shot) {
  return JSON.stringify({
    url: base + shot.url,
    seconds: shot.seconds,
    ui: shot.ui ?? 'game',
    start: shot.start ?? 0,
    from: shot.from ?? '',
    pre: shot.pre ?? 0,
    max: shot.max ?? 180,
    camera: shot.camera ? CAMERAS[shot.camera] : '',
    seed: shot.seed ?? null,
    check: shot.check ?? '',
    fps,
    size,
    format,
  });
}

function isRecorded(shot) {
  if (!existsSync(shotFile(shot)) || !existsSync(specFile(shot))) return false;
  try {
    return JSON.parse(readFileSync(specFile(shot), 'utf8')).spec === specOf(shot);
  } catch {
    return false;
  }
}

function run(command, commandArgs) {
  return new Promise((done) => {
    const child = spawn(command, commandArgs, { env: toolEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => done({ code: -1, stdout, stderr: stderr + error.message }));
    child.on('exit', (code) => done({ code, stdout, stderr }));
  });
}

/** A sheet of small frames (`rate` a second) to look a shot over without playing it. */
async function contactSheet(file, sheet, seconds, rate = 2) {
  const tiles = Math.max(1, Math.ceil(seconds * rate));
  const columns = Math.min(tiles, 6);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-vf', `fps=${rate},scale=480:-1,tile=${columns}x${Math.ceil(tiles / columns)}`,
    '-frames:v', '1', '-q:v', '3', sheet,
  ]);
}

async function record(shot) {
  const file = shotFile(shot);
  const recorderArgs = [
    RECORDER, '--url', base + shot.url, '--out', file, '--seconds', String(shot.seconds),
    '--fps', String(fps), '--size', size, '--ui', shot.ui ?? 'game', '--format', format,
  ];
  if (shot.start) recorderArgs.push('--start', String(shot.start));
  if (shot.from) recorderArgs.push('--from', shot.from, '--max', String(shot.max ?? 180));
  if (shot.from && shot.pre) recorderArgs.push('--pre', String(shot.pre));
  if (shot.seed !== undefined) recorderArgs.push('--seed', String(shot.seed));
  if (shot.check) recorderArgs.push('--eval', shot.check);
  if (shot.camera) {
    const source = CAMERAS[shot.camera];
    if (source === undefined) throw new Error(`shots.mjs: "${shot.id}" names an unknown camera "${shot.camera}"`);
    const setupFile = resolve(TEMP_DIR, `${shot.id}.setup.js`);
    writeFileSync(setupFile, source);
    recorderArgs.push('--setup-file', setupFile);
  }
  const failures = [];
  for (let attempt = 1; attempt <= RECORD_RUNS; attempt++) {
    const began = Date.now();
    const result = await run('node', recorderArgs);
    let report = null;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      // No report: the recorder itself died.
    }
    if (result.code === 0 && report !== null && report.ok) {
      const takes = report.attempts + failures.length * 2;
      writeFileSync(
        specFile(shot),
        JSON.stringify(
          {
            spec: specOf(shot),
            recordedAt: new Date().toISOString(),
            wallSeconds: Number(((Date.now() - began) / 1000).toFixed(1)),
            msPerFrame: report.msPerFrame,
            shotStartS: report.shotStartS,
            takes,
            failures,
            check: shot.check ? Boolean(report.eval) : null,
            problems: report.problems,
          },
          null,
          1,
        ),
      );
      await contactSheet(file, resolve(SHOT_DIR, `${shot.id}.sheet.jpg`), shot.seconds);
      log(
        `recorded ${shot.id}: ${report.framesWritten} frames in ${((Date.now() - began) / 1000).toFixed(0)} s` +
          (takes > 1 ? ` (take ${takes}; earlier ones failed: ${failures.join(' | ') || 'see the recorder log'})` : ''),
      );
      if (shot.check && !report.eval) {
        // A seeded match plays out the same only while the simulation's code is the same.
        log(
          `WARNING ${shot.id}: its check is false after the last frame, so the match no longer plays out ` +
            `the way it did when the shot was timed. Look at ${rel(resolve(SHOT_DIR, `${shot.id}.sheet.jpg`))} ` +
            `and pick new times with tools/trailer/scout.mjs.`,
        );
      }
      return true;
    }
    const why = report?.error ?? result.stderr.trim().split('\n').slice(-2).join(' ');
    failures.push(String(why).slice(0, 300));
    log(`${shot.id}: recording failed (${String(why).slice(0, 200)})`);
    if (attempt < RECORD_RUNS) await sleep(RETRY_WAIT_MS);
  }
  rmSync(file, { force: true });
  return false;
}

if (args['no-record'] !== 'true') {
  const used = new Set(pieces.map((piece) => piece.shot));
  const queue = SHOTS.filter((shot) => {
    if (shot.placeholder) return false;
    if (only !== null) return only.has(shot.id);
    if (!used.has(shot.id)) return false;
    return args.force === 'true' || !isRecorded(shot);
  });
  for (const shot of SHOTS) {
    if (!shot.placeholder && used.has(shot.id) && !queue.includes(shot)) log(`${shot.id}: already recorded`);
  }
  let failed = 0;
  const worker = async () => {
    for (;;) {
      const shot = queue.shift();
      if (shot === undefined) return;
      log(`recording ${shot.id} (${shot.seconds} s): ${shot.what}`);
      if (!(await record(shot))) failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  if (failed > 0) {
    log(`${failed} shot(s) could not be recorded; run again to retry them`);
    process.exit(1);
  }
}
if (args['no-cut'] === 'true') process.exit(0);

// ---- The cut -------------------------------------------------------------------------------------

for (const piece of pieces) {
  if (!existsSync(shotFile(piece.shotInfo))) {
    log(`the cut needs ${piece.shot}, which is not recorded`);
    process.exit(1);
  }
}

const inputs = [];
const filters = [];
pieces.forEach((piece, index) => {
  inputs.push('-i', shotFile(piece.shotInfo));
  const lengthS = piece.takeFrames / fps;
  let chain =
    `[${index}:v]trim=start_frame=${piece.inFrame}:end_frame=${piece.inFrame + piece.takeFrames},` +
    'setpts=PTS-STARTPTS';
  if (piece.fadeIn) chain += `,fade=t=in:st=0:d=${piece.fadeIn}`;
  if (piece.fadeOut) chain += `,fade=t=out:st=${(lengthS - piece.fadeOut).toFixed(4)}:d=${piece.fadeOut}`;
  // `fps` puts every piece back on one constant frame rate and time base: xfade insists on it.
  filters.push(`${chain},fps=${fps},format=yuv420p[p${index}]`);
});
// Runs of hard cuts are joined in one go; the runs are then cross-faded into each other.
const runs = [];
pieces.forEach((piece, index) => {
  if (index === 0 || piece.xfadeFrames > 0) runs.push([index]);
  else runs[runs.length - 1].push(index);
});
runs.forEach((members, r) => {
  const labels = members.map((index) => `[p${index}]`).join('');
  filters.push(
    members.length === 1
      ? `${labels}null[r${r}]`
      : `${labels}concat=n=${members.length}:v=1:a=0,fps=${fps}[r${r}]`,
  );
});
let video = '[r0]';
for (let r = 1; r < runs.length; r++) {
  const first = pieces[runs[r][0]];
  const d = first.xfadeFrames / fps;
  const offset = (first.startFrame - first.xfadeFrames) / fps;
  filters.push(`${video}[r${r}]xfade=transition=fade:duration=${d.toFixed(4)}:offset=${offset.toFixed(4)}[x${r}]`);
  video = `[x${r}]`;
}

// ---- The soundtrack ------------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(resolve(AUDIO_DIR, 'manifest.json'), 'utf8'));
const audioIn = [];
const addAudio = (file) => {
  audioIn.push('-i', resolve(AUDIO_DIR, file));
  return pieces.length + audioIn.length / 2 - 1;
};
/** A looping track from its loop start, `lengthS` long (the loop region repeats as needed). */
function looped(input, entry, lengthS) {
  const rate = 44100;
  const start = Math.round(entry.loop.startS * rate);
  const sizeSamples = Math.round((entry.loop.endS - entry.loop.startS) * rate);
  const repeats = Math.ceil(lengthS / (entry.loop.endS - entry.loop.startS));
  return (
    `[${input}:a]aresample=${rate},aloop=loop=${repeats}:size=${sizeSamples}:start=${start},` +
    `atrim=start=${entry.loop.startS}:end=${(entry.loop.startS + lengthS).toFixed(4)},asetpts=PTS-STARTPTS`
  );
}
const ms = (seconds) => Math.round(seconds * 1000);
const matchAt = startOf(MUSIC.matchFrom);
const battleAt = startOf(MUSIC.battleFrom);
const stingAt = startOf(MUSIC.stingAt);
const mix = [];
{
  // Opening: the lobby theme, quiet, out as the match music comes in.
  const entry = manifest.music[MUSIC.opening.track];
  const lengthS = matchAt + 1;
  filters.push(
    `${looped(addAudio(entry.file), entry, lengthS)},volume=${MUSIC.opening.gain},` +
      `afade=t=in:st=0:d=${MUSIC.opening.fadeInS},afade=t=out:st=${(matchAt - 0.7).toFixed(3)}:d=1.5[opening]`,
  );
  mix.push('[opening]');
}
if (MUSIC.air) {
  const entry = manifest.ambience[MUSIC.air.ambience];
  filters.push(
    `${looped(addAudio(entry.file), entry, matchAt + 0.5)},volume=${MUSIC.air.gain},` +
      `afade=t=in:st=0:d=1.5,afade=t=out:st=${(matchAt - 1).toFixed(3)}:d=1.5[air]`,
  );
  mix.push('[air]');
}
{
  // The match music: two layers of the same bars. The calm one alone, then the battle one over it.
  const { calm, battle, gain, calmUnderBattle, blendS } = MUSIC.match;
  const lengthS = stingAt - matchAt + MUSIC.sting.musicOutS;
  const blendFrom = Math.max(battleAt - matchAt - blendS, 0);
  const blendTo = battleAt - matchAt;
  const span = Math.max(blendTo - blendFrom, 0.01);
  const rise = `if(lt(t\\,${blendFrom})\\,0\\,if(lt(t\\,${blendTo})\\,(t-${blendFrom})/${span}\\,1))`;
  const tail = `afade=t=out:st=${(stingAt - matchAt).toFixed(3)}:d=${MUSIC.sting.musicOutS},adelay=delays=${ms(matchAt)}:all=1`;
  filters.push(
    `${looped(addAudio(manifest.music[calm].file), manifest.music[calm], lengthS)},` +
      `volume=eval=frame:volume='${gain}*(1-${1 - calmUnderBattle}*${rise})',${tail}[calm]`,
    `${looped(addAudio(manifest.music[battle].file), manifest.music[battle], lengthS)},` +
      `volume=eval=frame:volume='${gain}*${rise}',${tail}[battle]`,
  );
  mix.push('[calm]', '[battle]');
}
{
  const entry = manifest.sounds[MUSIC.sting.sound];
  filters.push(
    `[${addAudio(entry.files[0])}:a]aresample=44100,volume=${MUSIC.sting.gain},adelay=delays=${ms(stingAt)}:all=1[sting]`,
  );
  mix.push('[sting]');
}
const lastFade = pieces[pieces.length - 1].fadeOut ?? 0;
filters.push(
  `${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest,` +
    `volume=${MUSIC.master ?? 1},alimiter=limit=0.94,` +
    `atrim=start=0:end=${totalS.toFixed(4)},apad=whole_dur=${totalS.toFixed(4)}` +
    (lastFade > 0 ? `,afade=t=out:st=${(totalS - lastFade).toFixed(3)}:d=${lastFade}` : '') +
    '[aout]',
);

const graphFile = resolve(TEMP_DIR, 'cut.filter.txt');
writeFileSync(graphFile, filters.join(';\n'));
log(`cutting ${pieces.length} pieces into ${rel(out)}`);
const cut = await run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', ...inputs, ...audioIn,
  // `-/option file`: the option's value is read from the file (the graph is long).
  '-/filter_complex', graphFile, '-map', video, '-map', '[aout]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', String(args.crf ?? 18), '-pix_fmt', 'yuv420p',
  '-r', String(fps), '-fps_mode', 'cfr', '-g', String(fps), '-bf', '2',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-frames:v', String(totalFrames), '-t', totalS.toFixed(4), '-movflags', '+faststart', out,
]);
if (cut.code !== 0) {
  log(`ffmpeg failed:\n${cut.stderr.trim()}`);
  process.exit(1);
}

const probe = spawnSync(
  'ffprobe',
  [
    '-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_name,codec_type,width,height,r_frame_rate,nb_read_frames,pix_fmt,sample_rate,channels:format=duration,size',
    '-of', 'json', out,
  ],
  { encoding: 'utf8', env: toolEnv },
);
const info = JSON.parse(probe.stdout);
const videoStream = info.streams.find((stream) => stream.codec_type === 'video');
const audioStream = info.streams.find((stream) => stream.codec_type === 'audio');
const summary = {
  file: rel(out),
  seconds: Number(Number(info.format.duration).toFixed(3)),
  frames: Number(videoStream.nb_read_frames),
  framesPlanned: totalFrames,
  size: `${videoStream.width}x${videoStream.height}`,
  frameRate: videoStream.r_frame_rate,
  video: `${videoStream.codec_name} ${videoStream.pix_fmt}`,
  audio: audioStream ? `${audioStream.codec_name} ${audioStream.sample_rate} Hz ${audioStream.channels} ch` : 'none',
  megabytes: Number((statSync(out).size / (1024 * 1024)).toFixed(1)),
  frameSource: format,
  base,
  cut: pieces.map((piece) => ({
    atS: Number((piece.startFrame / fps).toFixed(3)),
    lengthS: Number((piece.frames / fps).toFixed(3)),
    shot: piece.shot,
    inS: piece.in ?? 0,
    join: piece.xfadeFrames > 0 ? `cross-fade ${piece.xfade} s` : 'cut',
    what: piece.shotInfo.what,
  })),
  skippedPlaceholders: skipped.map((piece) => ({ shot: piece.shot, why: shotById.get(piece.shot).placeholder })),
  music: { matchAtS: matchAt, battleAtS: battleAt, stingAtS: stingAt },
};
writeFileSync(out.replace(/\.mp4$/, '.json'), JSON.stringify(summary, null, 1));
await contactSheet(out, resolve(SCRATCH, 'rough-cut.sheet.jpg'), totalS, 1);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.frames === totalFrames ? 0 : 1);
