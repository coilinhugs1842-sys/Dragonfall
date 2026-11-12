/**
 * Frame-exact video of the game, for the trailer: every frame is rendered exactly once at a
 * fixed time step, however slow the capture is. Nothing here films the screen in real time.
 *
 *   node tools/capture/record.mjs --url "http://localhost:5199/?viewer=cine:intro" \
 *        --out art-source/_scratch/trailer/shots/intro.mp4 --seconds 6
 *        [--fps 60] [--size 1920x1080]
 *        [--start <s>]        let the page run this many (virtual) seconds first
 *        [--from "<expr>"]    then wait until this expression is true; the shot begins there
 *        [--pre <s>]          with --from: also keep this many seconds from BEFORE it came true
 *        [--until "<expr>"]   stop early when this becomes true
 *        [--max <s>]          give up waiting for --from after this many virtual seconds (180)
 *        [--ui game|cine|none|all]   what of the game's own interface stays in the picture:
 *                             game = the HUD and menus as a player sees them (default);
 *                             cine = only the scene fade and the intro's title card;
 *                             none = nothing; all = also the dev overlays
 *        [--css "<rules>"]    extra CSS for the page (hide one more element, for example)
 *        [--setup "<expr>" | --setup-file <file.js>]   run once in the page before the first
 *                             frame (tools/trailer/cameras.mjs puts a camera on a live match so)
 *        [--crf 15] [--preset medium] [--format png|jpeg] [--jpeg-quality 95]
 *        [--seed <n>]         seed the page's Math.random (the same seed, the same match)
 *        [--stamp]            self-test: frame numbers are drawn into the picture and read back
 *        [--eval "<expr>"]    evaluated once at the end; goes into the report
 *        [--no-default-quality]  do not add quality=high to the URL
 *
 * How: the URL gets `record=<fps>` (src/dev/record.ts). With it the page takes no frames from
 * requestAnimationFrame and reads no real clock; `window.__dfRecord.step()` advances the whole
 * game by 1/fps s and draws one frame. This script calls it, takes `Page.captureScreenshot`,
 * and pipes the picture straight into ffmpeg (H.264, yuv420p, constant frame rate). No frame
 * is ever written to disk. Between frames it waits while the page is fetching, decoding or
 * compiling shaders, so loading never eats game time and two takes of one shot match.
 *
 * Prints progress to stderr and one JSON report to stdout; also writes `<out>.json` (the
 * report plus a SHA-1 of every frame's picture, for comparing takes). Exit code 0 = the file
 * has exactly the frames asked for.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProblems, launch, sleep } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Browser profile and anything else temporary: on the project's drive, never the system one. */
const TEMP_DIR = resolve(ROOT, 'art-source/_scratch/trailer/tmp');

/** What stays of the page's own interface. Dev overlays are never part of the game's picture. */
const UI_CSS = {
  all: '',
  game: '.df-bench,.dfh-prompt,.dfu-chip{display:none!important}',
  cine:
    '.df-bench{display:none!important}' +
    '.dfu-root>:not(.dfu-base):not(.dfu-fade){display:none!important}' +
    '.dfu-base>:not(.dfh-root){display:none!important}' +
    '.dfh-root>:not(.dfh-intro){display:none!important}',
  none: '#ui{display:none!important}',
};

/**
 * A dev server reloads the page whenever a source file changes, and other people edit this
 * checkout while a take runs: a reload in the middle would throw the take away. The page's
 * hot-reload socket is replaced by one that never opens, so the take keeps the code it loaded.
 * (`--hmr` leaves it alone. A production build has no such socket.)
 */
const MUTE_HOT_RELOAD = `(() => {
  const Native = window.WebSocket;
  window.WebSocket = new Proxy(Native, {
    construct(target, list) {
      const protocols = list[1];
      const names = Array.isArray(protocols) ? protocols : [protocols];
      if (!names.includes('vite-hmr') && !names.includes('vite-ping')) return Reflect.construct(target, list);
      const socket = new EventTarget();
      return Object.assign(socket, {
        url: String(list[0]), protocol: '', readyState: 0, bufferedAmount: 0, send() {}, close() {},
      });
    },
  });
})()`;

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
  process.stderr.write(`record: ${text}\n`);
}

/** Adds the flags the recorder needs to the page URL, keeping what is already there. */
function pageUrl(raw, { fps, seed, stamp, defaultQuality }) {
  const url = new URL(raw);
  const has = (name) => url.searchParams.has(name);
  let search = url.search;
  const add = (pair) => {
    search += (search === '' ? '?' : '&') + pair;
  };
  if (!has('record')) add(`record=${fps}`);
  if (defaultQuality && !has('quality')) add('quality=high');
  if (seed !== null && !has('recordseed')) add(`recordseed=${seed}`);
  if (stamp && !has('recordstamp')) add('recordstamp=1');
  // Appended as text: URLSearchParams would rewrite bare flags (`?autostart`) as `autostart=`.
  return `${url.origin}${url.pathname}${search}${url.hash}`;
}

/** Requests the page has open, from the DevTools network events. WebSockets are not in it. */
function trackNetwork(session) {
  const open = new Map();
  let lastActivity = Date.now();
  session.on('Network.requestWillBeSent', (params) => {
    lastActivity = Date.now();
    // An event stream never ends, and a worker started from a blob never reports its end.
    const address = params.request.url;
    if (params.type === 'EventSource' || address.startsWith('data:') || address.startsWith('blob:')) return;
    open.set(params.requestId, { url: params.request.url, since: Date.now() });
  });
  const done = (params) => {
    lastActivity = Date.now();
    open.delete(params.requestId);
  };
  session.on('Network.loadingFinished', done);
  session.on('Network.loadingFailed', done);
  return {
    /** Requests in flight, not counting ones stuck for longer than `staleMs`. */
    pending(staleMs = 20000) {
      const now = Date.now();
      let count = 0;
      for (const entry of open.values()) if (now - entry.since < staleMs) count++;
      return count;
    },
    idleMs: () => Date.now() - lastActivity,
    urls: () => [...open.values()].map((entry) => entry.url),
  };
}

/** Feeds pictures to ffmpeg's stdin and resolves when the file is written. */
function startEncoder({ out, fps, crf, preset, format }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', format === 'jpeg' ? 'mjpeg' : 'png',
    '-i', 'pipe:0',
    // Full-range sRGB pictures to broadcast-range BT.709, tagged as such: players agree on it.
    '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-fps_mode', 'cfr', '-g', String(Math.round(fps)), '-bf', '2',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-an', out,
  ];
  const child = spawn('ffmpeg', args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, TEMP: TEMP_DIR, TMP: TEMP_DIR },
  });
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  let failed = null;
  child.stdin.on('error', (error) => {
    failed = error;
  });
  const exited = new Promise((done) => {
    child.on('error', (error) => done({ code: -1, error: error.message }));
    child.on('exit', (code) => done({ code, error: errors.trim() }));
  });
  return {
    async write(buffer) {
      if (failed !== null) throw new Error(`ffmpeg stopped reading: ${failed.message} ${errors}`);
      if (!child.stdin.write(buffer)) await new Promise((drained) => child.stdin.once('drain', drained));
    },
    async finish() {
      child.stdin.end();
      return exited;
    },
    kill() {
      child.kill();
    },
  };
}

function probeVideo(file) {
  const result = spawnSync(
    'ffprobe',
    [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames,r_frame_rate,avg_frame_rate,width,height,pix_fmt,codec_name,duration',
      '-of', 'json', file,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return { error: (result.stderr ?? '').trim() || 'ffprobe failed' };
  const stream = JSON.parse(result.stdout).streams?.[0] ?? {};
  return {
    frames: Number(stream.nb_read_frames),
    frameRate: stream.r_frame_rate,
    avgFrameRate: stream.avg_frame_rate,
    durationS: Number(stream.duration),
    width: stream.width,
    height: stream.height,
    pixFmt: stream.pix_fmt,
    codec: stream.codec_name,
  };
}

/**
 * `--stamp`: reads the frame numbers back out of the encoded file (16 squares of 8 px in the
 * top-left corner, most significant first) and checks they go up by one, with none missing
 * and none twice.
 */
function verifyStamps(file, expectedFrames) {
  const cell = 8;
  const bits = 16;
  const result = spawnSync(
    'ffmpeg',
    [
      '-v', 'error', '-i', file, '-vf', `crop=${bits * cell}:${cell}:0:0,format=gray`,
      '-f', 'rawvideo', 'pipe:1',
    ],
    { maxBuffer: 1 << 30 },
  );
  if (result.status !== 0) return { ok: false, error: String(result.stderr).trim() };
  const frameBytes = bits * cell * cell;
  const count = Math.floor(result.stdout.length / frameBytes);
  const numbers = [];
  for (let f = 0; f < count; f++) {
    let value = 0;
    for (let bit = 0; bit < bits; bit++) {
      // The middle of each square, away from its edges.
      const at = f * frameBytes + (cell >> 1) * bits * cell + bit * cell + (cell >> 1);
      value = (value << 1) | (result.stdout[at] > 127 ? 1 : 0);
    }
    numbers.push(value);
  }
  const breaks = [];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) breaks.push({ at: i, was: numbers[i - 1], is: numbers[i] });
  }
  return {
    ok: count === expectedFrames && breaks.length === 0,
    frames: count,
    first: numbers[0] ?? null,
    last: numbers[numbers.length - 1] ?? null,
    breaks: breaks.slice(0, 10),
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.out || !args.seconds) {
  console.error(
    'usage: record.mjs --url <page url> --out <file.mp4> --seconds <n> [--fps 60] [--size 1920x1080]\n' +
      '       [--start <s>] [--from "<expr>"] [--pre <s>] [--until "<expr>"] [--max <s>]\n' +
      '       [--ui game|cine|none|all] [--css "<rules>"] [--crf 15] [--preset medium]\n' +
      '       [--format png|jpeg] [--seed <n>] [--stamp] [--eval "<expr>"]',
  );
  process.exit(2);
}
const fps = Number(args.fps ?? 60);
const [width, height] = (args.size ?? '1920x1080').split('x').map(Number);
const seconds = Number(args.seconds);
const frameTotal = Math.round(seconds * fps);
const startFrames = Math.round(Number(args.start ?? 0) * fps);
const preFrames = args.from ? Math.round(Number(args.pre ?? 0) * fps) : 0;
const maxWaitFrames = Math.round(Number(args.max ?? 180) * fps);
const format = args.format === 'jpeg' ? 'jpeg' : 'png';
const ui = args.ui ?? 'game';
if (!(ui in UI_CSS)) {
  console.error(`record: --ui must be one of ${Object.keys(UI_CSS).join(', ')}`);
  process.exit(2);
}
if (!(frameTotal > 0) || !(fps > 0) || !(width > 0) || !(height > 0)) {
  console.error('record: --seconds, --fps and --size must be positive');
  process.exit(2);
}
const out = resolve(args.out);
mkdirSync(dirname(out), { recursive: true });
mkdirSync(TEMP_DIR, { recursive: true });
// The browser's throwaway profile goes where `os.tmpdir()` points: keep it off the system drive.
process.env.TEMP = TEMP_DIR;
process.env.TMP = TEMP_DIR;

const url = pageUrl(args.url, {
  fps,
  seed: args.seed !== undefined ? Number(args.seed) : null,
  stamp: args.stamp === 'true',
  defaultQuality: args['no-default-quality'] !== 'true',
});
const css = UI_CSS[ui] + (args.css && args.css !== 'true' ? args.css : '');
const setup = args['setup-file']
  ? readFileSync(resolve(args['setup-file']), 'utf8')
  : args.setup && args.setup !== 'true'
    ? args.setup
    : '';

const report = {
  url,
  out,
  fps,
  size: `${width}x${height}`,
  ui,
  framesAsked: frameTotal,
  framesWritten: 0,
  preRollFrames: 0,
  shotStartS: 0,
  fromReached: args.from ? false : null,
  heldMs: 0,
  holds: 0,
  recordSeconds: 0,
  msPerFrame: 0,
  uniquePictures: 0,
  attempts: 0,
  video: null,
  stamp: null,
  eval: null,
  ok: false,
  error: null,
  problems: [],
};

const screenshotParams =
  format === 'jpeg'
    ? { format: 'jpeg', quality: Number(args['jpeg-quality'] ?? 95), optimizeForSpeed: true }
    : { format: 'png', optimizeForSpeed: true };

/** One whole take. Throws when the page could not be recorded (the caller may try again). */
async function take() {
  const session = await launch({ width, height });
  const problems = collectProblems(session);
  report.problems = problems;
  const hashes = [];
  let encoder = null;
  try {
    await session.send('Network.enable');
    const network = trackNetwork(session);
    if (css !== '') {
      const source =
        `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)};` +
        ` const add = () => (document.head ?? document.documentElement).appendChild(s);` +
        ` if (document.head) add(); else document.addEventListener('DOMContentLoaded', add); })()`;
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source });
    }
    if (args.hmr !== 'true') {
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: MUTE_HOT_RELOAD });
    }
    await session.send('Page.navigate', { url });

    // The page's stepping hook. A page that is mid-edit by someone else may fail to compile:
    // reload it a few times before giving up.
    let hooked = false;
    for (let attempt = 0; attempt < 4 && !hooked; attempt++) {
      const giveUpAt = Date.now() + 45000;
      while (Date.now() < giveUpAt) {
        try {
          if (await session.evaluate('typeof window.__dfRecord === "object" && window.__dfRecord !== null')) {
            hooked = true;
            break;
          }
        } catch {
          // Navigating: the context is not there yet.
        }
        await sleep(200);
      }
      if (!hooked) {
        log(`the page has no recording hook yet (${problems.slice(-2).join(' | ') || 'no errors'}); reloading`);
        await sleep(4000);
        await session.send('Page.reload', { ignoreCache: true });
      }
    }
    if (!hooked) throw new Error('the page never exposed window.__dfRecord (does it compile?)');

    // A shot's own preparation (a camera for a live match, for example), before any frame.
    if (setup !== '') {
      try {
        report.setup = (await session.evaluate(setup)) ?? 'done';
      } catch (error) {
        throw new Error(`--setup failed: ${error.message}`);
      }
    }

    const state = () => session.evaluate('window.__dfRecord.state()');
    /**
     * Waits (in real time, the virtual clock stands still) until nothing is being fetched,
     * decoded or compiled. `quietMs`: how long it must have been calm.
     */
    async function settle(quietMs, timeoutMs) {
      const began = Date.now();
      let waited = false;
      let lastNote = began;
      for (;;) {
        const now = await state();
        const calm =
          network.pending() === 0 && !now.busy && now.quietMs >= quietMs && network.idleMs() >= quietMs;
        if (calm) break;
        if (Date.now() - began > timeoutMs) {
          log(`still busy after ${timeoutMs} ms (requests: ${network.urls().slice(0, 3).join(', ') || 'none'}; busy=${now.busy}); going on`);
          break;
        }
        waited = true;
        if (args.verbose === 'true' && Date.now() - lastNote > 2000) {
          lastNote = Date.now();
          log(`holding: ${network.pending()} requests, busy=${now.busy}, workers quiet ${now.quietMs.toFixed(0)} ms, network quiet ${network.idleMs()} ms ${network.urls().slice(0, 4).join(' ')}`);
        }
        await sleep(quietMs > 100 ? 100 : 15);
      }
      if (waited) {
        report.holds++;
        report.heldMs += Date.now() - began;
      }
    }
    /** One frame forward; then the clock is held while the page loads or compiles. */
    async function step(expression) {
      const result = await session.evaluate(
        expression
          ? `window.__dfRecord.step(1).then((s) => { let hit = false; try { hit = Boolean(${expression}); } catch { hit = false; } return { ...s, hit }; })`
          : 'window.__dfRecord.step(1)',
      );
      if (result.busy || result.quietMs < 60 || network.pending() > 0) await settle(60, 30000);
      return result;
    }
    async function grab() {
      const { data } = await session.send('Page.captureScreenshot', screenshotParams);
      const buffer = Buffer.from(data, 'base64');
      return buffer;
    }

    // Everything the page preloads behind its first screen (the map, the dragons) arrives
    // before the first frame is stepped, so no take starts with half of it missing.
    await settle(1200, 90000);

    // --- Pre-roll: not recorded -------------------------------------------------------------
    let frame = 0;
    for (; frame < startFrames; frame++) await step(null);
    /** With --pre: the newest pictures from before the start condition, oldest first. */
    const ring = [];
    if (args.from) {
      let reached = false;
      for (let waited = 0; waited < maxWaitFrames; waited++, frame++) {
        const result = await step(args.from);
        if (result.hit) {
          reached = true;
          frame++;
          break;
        }
        if (preFrames > 0) {
          ring.push(await grab());
          if (ring.length > preFrames) ring.shift();
        }
        if (waited % (fps * 10) === fps * 10 - 1) log(`waiting for --from: ${((waited + 1) / fps).toFixed(0)} s of game time`);
      }
      report.fromReached = reached;
      if (!reached) throw new Error(`--from never became true in ${args.max ?? 180} s of game time`);
    }
    report.preRollFrames = frame;
    report.shotStartS = (frame - ring.length) / fps;

    // --- The shot -----------------------------------------------------------------------------
    encoder = startEncoder({
      out,
      fps,
      crf: Number(args.crf ?? 15),
      preset: args.preset ?? 'medium',
      format,
    });
    const began = Date.now();
    let written = 0;
    const put = async (picture) => {
      hashes.push(createHash('sha1').update(picture).digest('hex'));
      await encoder.write(picture);
      written++;
    };
    // The frame on which --from came true is the first frame after the kept lead-in.
    for (const picture of ring) {
      if (written < frameTotal) await put(picture);
    }
    ring.length = 0;
    if (args.from && written < frameTotal) await put(await grab());
    const spent = { step: 0, grab: 0, encode: 0 };
    while (written < frameTotal) {
      const t0 = Date.now();
      const result = await step(args.until ?? null);
      const t1 = Date.now();
      const picture = await grab();
      const t2 = Date.now();
      await put(picture);
      spent.step += t1 - t0;
      spent.grab += t2 - t1;
      spent.encode += Date.now() - t2;
      if (written % (fps * 2) === 0) {
        const rate = (Date.now() - began) / written;
        log(`${written} / ${frameTotal} frames, ${rate.toFixed(0)} ms each`);
      }
      if (args.until && result.hit) break;
    }
    report.framesWritten = written;
    if (args.eval) {
      try {
        report.eval = await session.evaluate(args.eval);
      } catch (error) {
        report.eval = `eval failed: ${error.message}`;
      }
    }
    const encoded = await encoder.finish();
    encoder = null;
    report.recordSeconds = Number(((Date.now() - began) / 1000).toFixed(1));
    report.msPerFrame = Number(((Date.now() - began) / written).toFixed(1));
    // Where the time went, per frame: stepping the page (with its holds), the screenshot, ffmpeg.
    report.msPerFrameParts = {
      step: Number((spent.step / written).toFixed(1)),
      screenshot: Number((spent.grab / written).toFixed(1)),
      encode: Number((spent.encode / written).toFixed(1)),
    };
    if (encoded.code !== 0) throw new Error(`ffmpeg failed (${encoded.code}): ${encoded.error}`);
    report.uniquePictures = new Set(hashes).size;
    return hashes;
  } finally {
    if (encoder !== null) encoder.kill();
    await session.close();
  }
}

let hashes = [];
const attempts = Math.max(1, Number(args.attempts ?? 2));
for (let attempt = 1; attempt <= attempts; attempt++) {
  report.attempts = attempt;
  try {
    hashes = await take();
    report.error = null;
    break;
  } catch (error) {
    report.error = error.message;
    log(`take ${attempt} failed: ${error.message}`);
    rmSync(out, { force: true });
    if (attempt < attempts) await sleep(5000);
  }
}

if (report.error === null) {
  report.video = probeVideo(out);
  const early = Boolean(args.until) && report.framesWritten < frameTotal;
  report.ok =
    report.video.frames === report.framesWritten &&
    (early || report.framesWritten === frameTotal) &&
    report.video.width === width &&
    report.video.height === height;
  if (args.stamp === 'true') {
    report.stamp = verifyStamps(out, report.framesWritten);
    report.ok = report.ok && report.stamp.ok;
  }
}
writeFileSync(`${out}.json`, JSON.stringify({ ...report, frameHashes: hashes }, null, 1));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
