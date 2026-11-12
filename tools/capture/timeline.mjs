/**
 * A page watched over time: a screenshot every `--every` ms together with what an expression
 * says at that moment, so a sequence (lobby -> launch -> intro -> match -> podium) can be read
 * frame by frame against the game's own clocks.
 *
 *   node tools/capture/timeline.mjs --url "http://localhost:5173/?autostart&fill&autopilot=bot" \
 *        --out art-source/_scratch/shots/flow [--wait 2000] [--every 1000] [--count 20] \
 *        [--size 1280x720] [--eval "expression returning a JSON-able value"] \
 *        [--until "expression: stop when it is true"] [--sheet 4]   (contact sheet, 4 columns)
 *        [--from "expression"]   wait (up to --max seconds, default 180) until it is true, then start
 *        [--actions file.json]   things to do on the way: [[ms since the page opened, "expression"], ...]
 *                                (clicks: "click:Host a room" presses the button with that text)
 *
 * Writes <out>-NN.png (and <out>-sheet.png with --sheet; needs ffmpeg on PATH) and prints one
 * JSON object: per frame the time since the page was opened and the `--eval` value, then every
 * console error or warning.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectProblems, launch, sleep } from './cdp.mjs';

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

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.out) {
  console.error('usage: timeline.mjs --url <url> --out <prefix> [--wait ms] [--every ms] [--count n] [--eval expr] [--until expr] [--sheet cols]');
  process.exit(2);
}
const [width, height] = (args.size ?? '1280x720').split('x').map(Number);
const waitMs = Number(args.wait ?? 2000);
const everyMs = Number(args.every ?? 1000);
const count = Math.max(1, Number(args.count ?? 20));
const out = resolve(args.out);
mkdirSync(dirname(out), { recursive: true });

/** [ms, expression] pairs still to run, soonest first. */
const actions = args.actions
  ? JSON.parse(readFileSync(resolve(args.actions), 'utf8')).sort((a, b) => a[0] - b[0])
  : [];

function actionExpression(text) {
  if (!text.startsWith('click:')) return text;
  const label = JSON.stringify(text.slice('click:'.length));
  return `(() => { const b = [...document.querySelectorAll('button, [role="button"]')].find((e) => (e.textContent ?? '').includes(${label}) && !e.disabled); if (!b) return 'no button ' + ${label}; b.click(); return 'clicked'; })()`;
}

const session = await launch({ width, height });
const problems = collectProblems(session);
const report = { url: args.url, actions: [], frames: [], problems };
const files = [];
try {
  await session.send('Page.navigate', { url: args.url });
  const startedAt = Date.now();
  await sleep(waitMs);
  if (args.from) {
    const giveUpAt = startedAt + Number(args.max ?? 180) * 1000;
    for (;;) {
      let there = false;
      try {
        there = Boolean(await session.evaluate(args.from));
      } catch {
        // The page is still booting.
      }
      if (there || Date.now() > giveUpAt) {
        report.fromReached = there;
        break;
      }
      await sleep(200);
    }
  }
  const firstAt = Date.now();
  for (let i = 0; i < count; i++) {
    const dueAt = firstAt + i * everyMs;
    const lateBy = dueAt - Date.now();
    if (lateBy > 0) await sleep(lateBy);
    while (actions.length > 0 && Date.now() - startedAt >= actions[0][0]) {
      const [atMs, text] = actions.shift();
      let result;
      try {
        result = await session.evaluate(actionExpression(text));
      } catch (error) {
        result = `failed: ${error.message}`;
      }
      report.actions.push({ atMs, text, result });
    }
    let value = null;
    if (args.eval) {
      try {
        value = await session.evaluate(args.eval);
      } catch (error) {
        value = `eval failed: ${error.message}`;
      }
    }
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    const file = `${out}-${String(i + 1).padStart(2, '0')}.png`;
    writeFileSync(file, Buffer.from(data, 'base64'));
    files.push(file);
    report.frames.push({ n: i + 1, atS: Number(((Date.now() - startedAt) / 1000).toFixed(2)), value });
    if (args.until) {
      try {
        if (await session.evaluate(args.until)) break;
      } catch {
        // Not there yet (the page has no game object while it boots).
      }
    }
  }
} finally {
  await session.close();
}

if (args.sheet && files.length > 0) {
  const columns = Math.max(1, Number(args.sheet === 'true' ? 4 : args.sheet));
  const rows = Math.ceil(files.length / columns);
  const cell = Math.floor(1920 / columns);
  const made = spawnSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error', '-start_number', '1', '-i', `${out}-%02d.png`,
      '-vf', `scale=${cell}:-1,tile=${columns}x${rows}`, '-frames:v', '1', `${out}-sheet.png`,
    ],
    { stdio: 'inherit' },
  );
  if (made.status === 0) report.sheet = `${out}-sheet.png`;
}
console.log(JSON.stringify(report));
