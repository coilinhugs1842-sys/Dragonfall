/**
 * Two pages, one room: a host page and a guest page that joins it over the real transport
 * (PeerJS signaling + WebRTC), watched side by side. For what only a second browser can show:
 * that a guest sees the same lobby, launch, intro, match and podium as the host.
 *
 *   node tools/capture/duo.mjs --base http://localhost:5173 --out art-source/_scratch/shots/duo \
 *        [--host "bots=3&quality=medium"] [--guest "autopilot=bot&quality=medium"] \
 *        [--start 9000]      ms after the guest is in the lobby before the host presses Start
 *        [--every 1000] [--count 24] [--size 960x540] [--sheet 6]
 *
 * Writes <out>-host-NN.png / <out>-guest-NN.png (and two sheets) and prints one JSON object:
 * per frame what each page's `game.report()` says, then both pages' console problems.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
if (!args.base || !args.out) {
  console.error('usage: duo.mjs --base <url> --out <prefix> [--host query] [--guest query] [--start ms] [--every ms] [--count n] [--sheet cols]');
  process.exit(2);
}
const [width, height] = (args.size ?? '960x540').split('x').map(Number);
const everyMs = Number(args.every ?? 1000);
const count = Math.max(1, Number(args.count ?? 24));
const startAfterMs = Number(args.start ?? 9000);
const out = resolve(args.out);
mkdirSync(dirname(out), { recursive: true });

const READ = `(() => {
  const g = window.__dragonfall?.game;
  if (!g) return null;
  const r = g.report();
  const me = r.dragons.find((d) => d.local);
  return {
    screen: r.screen, status: r.status, code: r.roomCode, lobby: r.show.lobbyPhase, phase: r.phase,
    t: Number(r.show.phaseTimeS.toFixed(2)), fade: Number(r.show.fade.toFixed(2)),
    aerie: r.show.aerie, directed: r.show.directed, card: Number(r.show.introCard.toFixed(2)),
    dragons: r.dragons.length, me: me ? [Math.round(me.x), Math.round(me.y), Math.round(me.z)] : null,
    scores: r.match.scores, error: r.error,
  };
})()`;
const click = (label) => `(() => {
  const b = [...document.querySelectorAll('button')].find((e) => (e.textContent ?? '').includes(${JSON.stringify(label)}) && !e.disabled);
  if (!b) return false;
  b.click();
  return true;
})()`;

async function waitFor(session, expression, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await session.evaluate(expression);
      if (value) return value;
    } catch {
      // Still booting.
    }
    if (Date.now() > until) return null;
    await sleep(250);
  }
}

const report = { steps: [], frames: [], problems: { host: [], guest: [] } };
const host = await launch({ width, height });
report.problems.host = collectProblems(host);
let guest = null;
try {
  await host.send('Page.navigate', { url: `${args.base}/?${args.host ?? 'bots=3&quality=medium'}` });
  await waitFor(host, click('Host a room'), 15000);
  const code = await waitFor(host, `(${READ})?.code || null`, 30000);
  report.steps.push({ step: 'room', code });
  if (!code) throw new Error('the host page never got a room code');

  guest = await launch({ width, height });
  report.problems.guest = collectProblems(guest);
  await guest.send('Page.navigate', {
    url: `${args.base}/?join=${code}&${args.guest ?? 'autopilot=bot&quality=medium'}`,
  });
  const joined = await waitFor(guest, `(${READ})?.screen === 'lobby'`, 40000);
  report.steps.push({ step: 'guest in lobby', ok: Boolean(joined) });

  const startAt = Date.now() + startAfterMs;
  let started = false;
  const firstAt = Date.now();
  for (let i = 0; i < count; i++) {
    const wait = firstAt + i * everyMs - Date.now();
    if (wait > 0) await sleep(wait);
    if (!started && Date.now() >= startAt) {
      started = true;
      // The guest readies up first: the host cannot start a room with an unready rider in it.
      report.steps.push({ step: 'guest ready', ok: await guest.evaluate(click('Ready up')) });
      await sleep(300);
      report.steps.push({ step: 'start', ok: await host.evaluate(click('Start match')), frame: i + 1 });
    }
    const [a, b, shotA, shotB] = await Promise.all([
      host.evaluate(READ),
      guest.evaluate(READ),
      host.send('Page.captureScreenshot', { format: 'png' }),
      guest.send('Page.captureScreenshot', { format: 'png' }),
    ]);
    const n = String(i + 1).padStart(2, '0');
    writeFileSync(`${out}-host-${n}.png`, Buffer.from(shotA.data, 'base64'));
    writeFileSync(`${out}-guest-${n}.png`, Buffer.from(shotB.data, 'base64'));
    report.frames.push({ n: i + 1, host: a, guest: b });
  }
} catch (error) {
  report.error = String(error?.message ?? error);
} finally {
  await host.close();
  if (guest) await guest.close();
}

if (args.sheet && report.frames.length > 0) {
  const columns = Math.max(1, Number(args.sheet === 'true' ? 6 : args.sheet));
  const rows = Math.ceil(report.frames.length / columns);
  const cell = Math.floor(1920 / columns);
  for (const who of ['host', 'guest']) {
    spawnSync(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error', '-start_number', '1', '-i', `${out}-${who}-%02d.png`,
        '-vf', `scale=${cell}:-1,tile=${columns}x${rows}`, '-frames:v', '1', `${out}-${who}-sheet.png`,
      ],
      { stdio: 'inherit' },
    );
  }
}
console.log(JSON.stringify(report));
