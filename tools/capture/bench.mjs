/**
 * Runs the `?bench` flight (src/dev/bench.ts) in a headless browser on each quality preset, one
 * after the other, and prints the table for docs/PROGRESS.md.
 *
 *   node tools/capture/bench.mjs [--base http://localhost:5173/] [--seconds 60]
 *        [--presets low,medium,high] [--size 1920x1080] [--shots art-source/_scratch/shots]
 *
 * The numbers are those of THIS machine's GPU (printed with the table), and a headless browser
 * does not wait for a display, so fps here is headroom, not the 60 a monitor would show. The
 * U-series laptops are measured by opening the same URL on them: `<game url>?bench&quality=low`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
const base = args.base ?? 'http://localhost:5173/';
const seconds = Number(args.seconds ?? 60);
const presets = (args.presets ?? 'low,medium,high').split(',');
const [width, height] = (args.size ?? '1920x1080').split('x').map(Number);
const shotDir = args.shots ? resolve(args.shots) : null;
if (shotDir !== null) mkdirSync(shotDir, { recursive: true });
const results = [];
for (const preset of presets) {
  const session = await launch({ width, height });
  const problems = collectProblems(session);
  const url = `${base}?bench=${seconds}&quality=${preset}`;
  let result = null;
  try {
    await session.send('Page.navigate', { url });
    // A trusted click once the match is up: audio (and its voices) only start after a gesture.
    await sleep(6000);
    const point = { x: Math.round(width / 2), y: Math.round(height / 2), button: 'left', clickCount: 1 };
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    // Loading + warm-up + the run, with slack for a slow machine.
    const deadline = Date.now() + (seconds + 90) * 1000;
    let shot = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      result = await session.evaluate('window.__dragonfallBench ?? null');
      if (result !== null) break;
      if (!shot && shotDir !== null && Date.now() > deadline - (seconds / 2 + 80) * 1000) {
        shot = true;
        const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(resolve(shotDir, `bench-${preset}.png`), Buffer.from(data, 'base64'));
      }
    }
  } finally {
    await session.close();
  }
  results.push({ preset, url, result, problems });
  if (result === null) console.error(`bench ${preset}: no result (see problems)`);
}

const done = results.filter((r) => r.result !== null);
console.log(JSON.stringify(results, null, 2));
if (done.length > 0) {
  console.log(`\nGPU: ${done[0].result.gpu}   canvas ${done[0].result.canvas}   ${seconds} s each`);
  console.log('| preset | fps | 1% low | max ms | draws | tris | scale min | sim ms | particles | voices |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of done) console.log(r.result.row);
}
process.exit(done.length === presets.length ? 0 : 1);
