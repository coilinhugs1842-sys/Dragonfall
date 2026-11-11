/**
 * Headless screenshot + health check of a running dev / preview server.
 *
 *   node tools/capture/shot.mjs --url "http://localhost:5173/?solo&autopilot&skip=20&perf" \
 *        --out art-source/_scratch/shots/solo.png [--wait 8000] [--size 1280x720] \
 *        [--shots 3 --interval 2000] [--eval "expression returning JSON-able value"] \
 *        [--gesture [ms]]   click the page centre after ms (default 3000): unlocks audio
 *
 * Prints one JSON object: the files written, the GPU the page got, every console error or
 * warning, and the `--eval` result (evaluated just before the last screenshot).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectProblems, launch, sleep } from './cdp.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = 'true';
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.out) {
  console.error('usage: shot.mjs --url <url> --out <file.png> [--wait ms] [--size WxH] [--shots n --interval ms] [--eval expr]');
  process.exit(2);
}
const [width, height] = (args.size ?? '1280x720').split('x').map(Number);
const waitMs = Number(args.wait ?? 8000);
const shots = Math.max(1, Number(args.shots ?? 1));
const intervalMs = Number(args.interval ?? 2000);
const out = resolve(args.out);
mkdirSync(dirname(out), { recursive: true });

const session = await launch({ width, height });
const problems = collectProblems(session);
const report = { url: args.url, files: [], gpu: null, eval: null, problems };
try {
  await session.send('Page.navigate', { url: args.url });
  if (args.gesture) {
    // A real (trusted) click, so the page gets the user activation that audio waits for.
    const gestureAt = Math.min(waitMs, Number(args.gesture === 'true' ? 3000 : args.gesture));
    await sleep(gestureAt);
    const point = { x: Math.round(width / 2), y: Math.round(height / 2), button: 'left', clickCount: 1 };
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    await sleep(waitMs - gestureAt);
  } else {
    await sleep(waitMs);
  }
  report.gpu = await session.evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'webgl2 unavailable';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  })()`);
  for (let i = 0; i < shots; i++) {
    if (i > 0) await sleep(intervalMs);
    if (i === shots - 1 && args.eval) {
      try {
        report.eval = await session.evaluate(args.eval);
      } catch (error) {
        report.eval = `eval failed: ${error.message}`;
      }
    }
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    const file = shots === 1 ? out : out.replace(/\.png$/i, `-${i + 1}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    report.files.push(file);
  }
} finally {
  await session.close();
}
console.log(JSON.stringify(report, null, 2));
