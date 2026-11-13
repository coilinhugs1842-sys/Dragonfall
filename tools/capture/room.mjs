#!/usr/bin/env node
/**
 * Headless 5v5 load test (T-6.1): one host page and N guest pages, each in its own headless
 * browser, joined over the real transport (PeerJS signaling + WebRTC data channels). The host's
 * in-page net-bots take the seats the guests leave free, so the match is always a 5v5 with nine
 * links on the host. Every page flies itself (`?autopilot=bot`) at `quality=low` with the perf
 * HUD on, and the tool reads the game's own numbers every few seconds:
 *
 *   - frame time: the perf HUD's rolling window (avg, 1 % low, max) and the game's frame counters
 *   - host: cost per tick (sim + snapshots), worst tick, worker pulse and lateness, tick rate,
 *     bytes sent and received
 *   - each guest: bytes received, snapshot rate, frames drawn past the newest snapshot
 *     (starvation), prediction corrections and snaps, input margin on the host, ping, loss
 *   - the rig itself: CPU busy share of the whole machine, free memory, how long a reading took
 *
 * Usage (the dev server must be running):
 *   node tools/capture/room.mjs --guests 3 --seconds 150
 *   node tools/capture/room.mjs --guests 9 --seconds 180 --guest-size 320x180
 *
 * Options: --base URL (http://localhost:5199)  --out DIR (art-source/_scratch/net/room)
 *          --every S (10: seconds between readings)  --warmup S (15)
 *          --host-size WxH (640x360)  --guest-size WxH (480x270)
 *          --host-query "a=b&c" / --guest-query "a=b" (appended, e.g. netsim=bad or noworker)
 *          --ballast N (extra pages flying solo, outside the room: a control that loads the
 *            machine without loading the game's network, to tell the rig's limit from the game's)
 *          --hmr (leave the dev server's hot reload on in the pages)
 *
 * Writes `<out>/room-<N>g.json` (every reading), `<out>/room-<N>g.txt` (the table printed at
 * the end) and one screenshot of the host and of the first guest. Exit code 1 when a page fell
 * out of the match or the room never started.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import {
  click,
  closeAll,
  intent,
  openGuest,
  navigate,
  openHost,
  openPage,
  parseArgs,
  realProblems,
  shot,
  sleep,
  waitRead,
} from './net-pages.mjs';

const args = parseArgs(process.argv.slice(2));
const BASE = args.base ?? 'http://localhost:5199';
const OUT = args.out ?? 'art-source/_scratch/net/room';
const GUESTS = Math.max(0, Math.min(9, Number(args.guests ?? 3)));
const SECONDS = Math.max(20, Number(args.seconds ?? 150));
const EVERY_S = Math.max(2, Number(args.every ?? 10));
const WARMUP_S = Math.max(0, Number(args.warmup ?? 15));
const BALLAST = Math.max(0, Number(args.ballast ?? 0));
const size = (text, fallback) => {
  const m = /^(\d+)x(\d+)$/.exec(text ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : fallback;
};
const HOST_SIZE = size(args['host-size'], { width: 640, height: 360 });
const GUEST_SIZE = size(args['guest-size'], { width: 480, height: 270 });
const extra = (text) => (text ? `&${text}` : '');

/** Budgets the numbers are held against (docs/NETWORKING.md "Binary protocol", docs/PERFORMANCE.md). */
const BUDGET_KB_PER_CLIENT = 7;
const BUDGET_KB_WORST = 12;
const TICK_HZ = 30;
const SNAPSHOT_HZ = 20;

const log = (line) => console.log(line);

/** One reading of a page: the report's cost figures and the perf HUD's frame window. */
const PROBE = `(() => {
  const g = window.__dragonfall?.game;
  if (!g) return null;
  const r = g.report();
  const text = document.querySelector('.df-perf-hud pre')?.textContent ?? '';
  const fps = /fps ([\\d.]+)\\s+1% low ([\\d.]+)/.exec(text);
  const ms = /ms\\s+avg ([\\d.]+)\\s+1% ([\\d.]+)\\s+max ([\\d.]+)/.exec(text);
  return {
    at: performance.now(),
    screen: r.screen, status: r.status, phase: r.phase, inMatch: r.inMatch, isRider: r.isRider,
    id: r.localPlayerId, dragons: r.dragons.length, scores: r.match.scores,
    frame: fps && ms
      ? { fps: Number(fps[1]), lowFps: Number(fps[2]), avgMs: Number(ms[1]), lowMs: Number(ms[2]), maxMs: Number(ms[3]) }
      : null,
    render: { calls: r.render.calls, triangles: r.render.triangles, preset: r.render.preset, scale: r.render.scale },
    net: g.getNetText(),
    host: r.host
      ? { mode: r.host.mode, clients: r.host.clients, bots: r.host.bots, frames: r.host.frames, metrics: { ...r.host.metrics } }
      : null,
    client: r.client ? { ...r.client } : null,
  };
})()`;

async function probe(page) {
  const from = Date.now();
  try {
    const value = await page.session.evaluate(PROBE);
    return value === null ? null : { ...value, tookMs: Date.now() - from, wall: Date.now() };
  } catch {
    return null;
  }
}

/** Busy share of every core since the last call, 0..1 (the whole machine, not just this run). */
function cpuMeter() {
  const snap = () => {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }
    return { idle, total };
  };
  let last = snap();
  return () => {
    const now = snap();
    const total = now.total - last.total;
    const busy = total > 0 ? 1 - (now.idle - last.idle) / total : 0;
    last = now;
    return busy;
  };
}

const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
const max = (values) => (values.length === 0 ? 0 : Math.max(...values));
const min = (values) => (values.length === 0 ? 0 : Math.min(...values));
const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const f = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');
/** The host's "worst ever" figures are never reset: say whether the window set them. */
const worst = (value, inWindow) =>
  inWindow ? `${f(value, 1)} ms worst (inside the window)` : `worst below ${f(value, 1)} ms (set before the window)`;

/** Turns a page's readings (first = start of the window) into its line of the report. */
function summarise(name, readings, problems) {
  const got = readings.filter((r) => r !== null);
  const first = got[0];
  const last = got[got.length - 1];
  const out = { name, readings: got.length, lost: readings.length - got.length, problems: realProblems(problems) };
  if (first === undefined || last === undefined || first === last) return out;
  const seconds = (last.at - first.at) / 1000;
  const window = got.slice(1);
  const frames = window.map((r) => r.frame).filter((frame) => frame !== null);
  out.seconds = seconds;
  out.stayed = got.every((r) => r.inMatch && r.phase === 'playing');
  out.left = got.filter((r) => !(r.inMatch && r.phase === 'playing')).map((r) => `${r.screen}/${r.status}/${r.phase}`);
  out.frame = {
    avgMs: mean(frames.map((frame) => frame.avgMs)),
    lowMsMedian: median(frames.map((frame) => frame.lowMs)),
    lowMsWorst: max(frames.map((frame) => frame.lowMs)),
    maxMs: max(frames.map((frame) => frame.maxMs)),
  };
  out.render = last.render;
  out.probeMs = mean(got.map((r) => r.tookMs));
  if (first.host !== null && last.host !== null) {
    const m = window.map((r) => r.host.metrics);
    const a = first.host.metrics;
    const b = last.host.metrics;
    out.fps = (last.host.frames - first.host.frames) / seconds;
    out.host = {
      mode: last.host.mode,
      links: last.host.clients,
      bots: last.host.bots,
      tickHz: (b.ticks - a.ticks) / seconds,
      stepMs: mean(m.map((x) => x.stepMs)),
      stepMsPeak: max(m.map((x) => x.stepMs)),
      simMs: mean(m.map((x) => x.simMs)),
      snapshotMs: mean(m.map((x) => x.snapshotMs)),
      worstTickMs: b.maxStepMs,
      worstTickAtStartMs: a.maxStepMs,
      workerPulseMs: mean(m.map((x) => x.workerPulseMs)),
      workerPulseMsPeak: max(m.map((x) => x.workerPulseMs)),
      workerPulseMaxMs: b.workerPulseMaxMs,
      workerPulseMaxInWindow: b.workerPulseMaxMs > a.workerPulseMaxMs,
      workerLateMs: mean(m.map((x) => x.workerLateMs)),
      workerLateMsPeak: max(m.map((x) => x.workerLateMs)),
      workerLateMaxMs: b.workerLateMaxMs,
      workerLateMaxInWindow: b.workerLateMaxMs > a.workerLateMaxMs,
      arrivalLateMaxInWindow: b.arrivalLateMaxMs > a.arrivalLateMaxMs,
      inputAgeMs: mean(m.map((x) => x.inputAgeMs)),
      inputHeldTicks: b.inputHeldTicks - a.inputHeldTicks,
      mainMsPerFrame: (b.mainMs - a.mainMs) / Math.max(1, last.host.frames - first.host.frames),
      upKBps: mean(m.map((x) => x.sentBytesPerS)) / 1024,
      upKBpsPeak: max(m.map((x) => x.sentBytesPerS)) / 1024,
      downKBps: mean(m.map((x) => x.receivedBytesPerS)) / 1024,
      malformed: b.malformed - a.malformed,
      viewFrames: b.viewFrames - a.viewFrames,
      viewExtrapolatedFrames: b.viewExtrapolatedFrames - a.viewExtrapolatedFrames,
      viewStarvedFrames: b.viewStarvedFrames - a.viewStarvedFrames,
      arrivalLateMs: mean(m.map((x) => x.arrivalLateMs)),
      arrivalLateMaxMs: b.arrivalLateMaxMs,
    };
    out.host.upKBpsPerLink = out.host.links > 0 ? out.host.upKBps / out.host.links : 0;
  }
  if (first.client !== null && last.client !== null) {
    const c = window.map((r) => r.client);
    const a = first.client;
    const b = last.client;
    const drawn = b.matchFrames - a.matchFrames;
    out.fps = drawn / seconds;
    out.client = {
      rider: last.isRider,
      pingMs: mean(c.map((x) => x.pingMs)),
      pingMsPeak: max(c.map((x) => x.pingMs)),
      interpDelayMs: mean(c.map((x) => x.interpDelayMs)),
      lossPct: mean(c.map((x) => x.lossPct)),
      lossPctPeak: max(c.map((x) => x.lossPct)),
      downKBps: mean(c.map((x) => x.downKBps)),
      downKBpsPeak: max(c.map((x) => x.downKBps)),
      upKBps: mean(c.map((x) => x.upKBps)),
      snapshotHz: (b.snapshots - a.snapshots) / seconds,
      starvedFrames: b.starvedFrames - a.starvedFrames,
      starvedPct: drawn > 0 ? ((b.starvedFrames - a.starvedFrames) / drawn) * 100 : 0,
      starvedReadings: c.filter((x) => x.starved).length,
      corrections: b.corrections - a.corrections,
      correctionsPerMin: ((b.corrections - a.corrections) / seconds) * 60,
      snaps: b.snaps - a.snaps,
      largestCorrectionM: b.largestCorrectionM,
      inputMarginTicks: mean(c.map((x) => x.inputMarginTicks)),
      inputMarginTicksMin: min(c.map((x) => x.inputMarginTicks)),
      timeScaleMin: min(c.map((x) => x.timeScale)),
      timeScaleMax: max(c.map((x) => x.timeScale)),
      resyncs: b.resyncs - a.resyncs,
      reconnects: b.reconnects - a.reconnects,
      malformed: b.malformed - a.malformed,
    };
  }
  return out;
}

function table(summary) {
  const lines = [];
  const { host, guests, rig } = summary;
  lines.push(
    `5v5 load test: ${summary.guestCount} guest page(s) + ${summary.bots} in-page bot(s)${BALLAST > 0 ? ` + ${BALLAST} solo page(s) outside the room` : ''}, ` +
      `${f(summary.seconds, 0)} s measured, readings every ${EVERY_S} s`,
  );
  lines.push(
    `rig: ${rig.cores} x ${rig.cpu}; CPU busy ${f(rig.cpuBusyPct, 0)} % avg / ${f(rig.cpuBusyPctPeak, 0)} % peak ` +
      `(whole machine), free RAM ${f(rig.freeGbMin, 1)} GB min, a reading took ${f(rig.probeMs, 0)} ms avg / ${f(rig.probeMsPeak, 0)} ms worst`,
  );
  lines.push('');
  lines.push('page      fps   avg ms  1% ms(med/worst)  max ms   down KB/s  snap/s  starved  fixes/min  snaps  maxfix m  margin  ping  loss%  console');
  const row = (p) => {
    const frame = p.frame ?? { avgMs: NaN, lowMsMedian: NaN, lowMsWorst: NaN, maxMs: NaN };
    const c = p.client;
    return (
      `${p.name.padEnd(9)} ${f(p.fps ?? NaN).padStart(5)}  ${f(frame.avgMs, 2).padStart(6)}  ` +
      `${`${f(frame.lowMsMedian)}/${f(frame.lowMsWorst)}`.padStart(16)}  ${f(frame.maxMs).padStart(6)}  ` +
      (c
        ? `${f(c.downKBps, 2).padStart(9)}  ${f(c.snapshotHz).padStart(6)}  ${`${f(c.starvedPct, 2)}%`.padStart(7)}  ` +
          `${f(c.correctionsPerMin).padStart(9)}  ${String(c.snaps).padStart(5)}  ${f(c.largestCorrectionM, 2).padStart(8)}  ` +
          `${f(c.inputMarginTicks).padStart(6)}  ${f(c.pingMs, 0).padStart(4)}  ${f(c.lossPct).padStart(5)}  `
        : `${'-'.padStart(9)}  ${'-'.padStart(6)}  ${'-'.padStart(7)}  ${'-'.padStart(9)}  ${'-'.padStart(5)}  ${'-'.padStart(8)}  ${'-'.padStart(6)}  ${'-'.padStart(4)}  ${'-'.padStart(5)}  `) +
      `${p.problems.length}${p.stayed === false ? `  LEFT THE MATCH: ${p.left[0]}` : ''}${p.lost > 0 ? `  (${p.lost} readings lost)` : ''}`
    );
  };
  lines.push(row(host));
  for (const guest of guests) lines.push(row(guest));
  lines.push('');
  if (host.host) {
    const h = host.host;
    lines.push(
      `host sim (${h.mode}): ${f(h.tickHz)} ticks/s (target ${TICK_HZ}); per tick ${f(h.stepMs, 3)} ms avg ` +
        `(sim ${f(h.simMs, 3)} + snapshots ${f(h.snapshotMs, 3)}), smoothed peak ${f(h.stepMsPeak, 3)} ms, ` +
        (h.worstTickMs > h.worstTickAtStartMs
          ? `worst single tick ${f(h.worstTickMs, 2)} ms (inside the window)`
          : `worst single tick inside the window below ${f(h.worstTickAtStartMs, 2)} ms (the worst since the room opened, set before the window)`),
    );
    lines.push(
      `host worker: pulse ${f(h.workerPulseMs, 3)} ms avg / ${f(h.workerPulseMsPeak, 3)} smoothed peak / ${worst(h.workerPulseMaxMs, h.workerPulseMaxInWindow)}; ` +
        `timer late ${f(h.workerLateMs, 2)} ms avg / ${f(h.workerLateMsPeak, 2)} smoothed peak / ${worst(h.workerLateMaxMs, h.workerLateMaxInWindow)}; ` +
        `host input age ${f(h.inputAgeMs)} ms, ${h.inputHeldTicks} tick(s) on a held input; ` +
        `main thread ${f(h.mainMsPerFrame, 3)} ms/frame; state late ${f(h.arrivalLateMs, 2)} ms avg / ${worst(h.arrivalLateMaxMs, h.arrivalLateMaxInWindow)}; ` +
        `host view: ${h.viewExtrapolatedFrames} extrapolated, ${h.viewStarvedFrames} held of ${h.viewFrames} frames`,
    );
    lines.push(
      `host network: up ${f(h.upKBps)} KB/s avg / ${f(h.upKBpsPeak)} peak over ${h.links} link(s) ` +
        `(${h.links - h.bots} real, ${h.bots} in-page) = ${f(h.upKBpsPerLink, 2)} KB/s per link; down ${f(h.downKBps)} KB/s; malformed ${h.malformed}`,
    );
  }
  const clients = guests.map((g) => g.client).filter((c) => c !== undefined);
  if (clients.length > 0) {
    const down = clients.map((c) => c.downKBps);
    lines.push(
      `guests received: ${f(mean(down), 2)} KB/s avg (${f(min(down), 2)}..${f(max(down), 2)}), peak reading ${f(max(clients.map((c) => c.downKBpsPeak)), 2)} KB/s; ` +
        `budget ${BUDGET_KB_PER_CLIENT} KB/s per client in an average fight, ${BUDGET_KB_WORST} KB/s worst case; ` +
        `sum over ${clients.length} guest(s) ${f(down.reduce((a, b) => a + b, 0))} KB/s; snapshots ${f(mean(clients.map((c) => c.snapshotHz)))} /s (target ${SNAPSHOT_HZ})`,
    );
    lines.push(
      `guests: starved frames ${clients.reduce((a, c) => a + c.starvedFrames, 0)} ` +
        `(worst page ${f(max(clients.map((c) => c.starvedPct)), 2)} %), corrections ${clients.reduce((a, c) => a + c.corrections, 0)}, ` +
        `snaps ${clients.reduce((a, c) => a + c.snaps, 0)}, largest correction ${f(max(clients.map((c) => c.largestCorrectionM)), 2)} m, ` +
        `resyncs ${clients.reduce((a, c) => a + c.resyncs, 0)}, reconnects ${clients.reduce((a, c) => a + c.reconnects, 0)}, ` +
        `lowest input margin ${f(min(clients.map((c) => c.inputMarginTicksMin)))} ticks`,
    );
  }
  const problems = [host, ...guests].flatMap((p) => p.problems.map((line) => `  ${p.name}: ${line.slice(0, 220)}`));
  lines.push(problems.length === 0 ? 'console: no errors or warnings on any page' : `console problems (${problems.length}):`);
  for (const line of [...new Set(problems)].slice(0, 12)) lines.push(line);
  return lines.join('\n');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const bots = 9 - GUESTS;
  const pages = [];
  const ballast = [];
  let failed = false;
  try {
    const hostQuery =
      `bots=${bots}&teamsize=5&nocine&score=1000&time=0&quality=low&autopilot=bot&perf` + extra(args['host-query']);
    const guestQuery = `autopilot=bot&quality=low&perf${extra(args['guest-query'])}`;
    log(`host: ${BASE}/?${hostQuery}`);
    const { page: host, code } = await openHost(BASE, hostQuery, { ...HOST_SIZE, log });
    pages.push(host);
    log(`room ${code} open; ${GUESTS} guest(s) joining (${GUEST_SIZE.width}x${GUEST_SIZE.height} each)`);
    const guests = [];
    for (let i = 0; i < GUESTS; i++) {
      const from = Date.now();
      const guest = await openGuest(BASE, code, guestQuery, `guest${i + 1}`, { ...GUEST_SIZE, log });
      pages.push(guest);
      guests.push(guest);
      log(`  guest${i + 1} in the room after ${((Date.now() - from) / 1000).toFixed(1)} s`);
    }

    // Every seat taken: the host's bots ready themselves, the guests say so, the host starts.
    const full = await waitRead(host, (r) => r.roster.filter((p) => p.side !== 'spectator').length === 10, 30000);
    if (!full.ok) throw new Error(`the room never filled: ${JSON.stringify(full.read?.players)}`);
    for (const guest of guests) await guest.session.evaluate(intent({ type: 'lobby.ready', ready: true }));
    await waitRead(host, (r) => r.roster.every((p) => p.host || p.side === 'spectator' || p.ready), 20000);
    let started = { ok: false, read: null };
    for (let attempt = 0; attempt < 5 && !started.ok; attempt++) {
      await host.session.evaluate(click('Start match'));
      started = await waitRead(host, (r) => r.lobby !== 'lobby' || r.inMatch, 4000);
    }
    if (!started.ok) throw new Error(`the match never started: ${JSON.stringify(started.read?.players)}`);
    for (const page of pages) {
      const playing = await waitRead(page, (r) => r.inMatch && r.phase === 'playing', 90000, 500);
      if (!playing.ok) throw new Error(`${page.name} never reached the playing phase (${playing.read?.screen}/${playing.read?.status}/${playing.read?.phase})`);
    }
    for (let i = 0; i < BALLAST; i++) {
      const page = await openPage(`ballast${i + 1}`, GUEST_SIZE);
      ballast.push(page);
      await navigate(page, `${BASE}/?solo&autopilot=bot&quality=low`);
      const flying = await waitRead(page, (r) => r.inMatch, 60000, 500);
      log(`  ballast${i + 1}: ${flying.ok ? 'flying solo' : 'never took off'}`);
    }
    log(`all ${pages.length} page(s) playing${BALLAST > 0 ? ` (+ ${BALLAST} solo page(s) as ballast)` : ''}; warming up ${WARMUP_S} s`);
    await sleep(WARMUP_S * 1000);

    const cpu = cpuMeter();
    const readings = pages.map(() => []);
    const rig = { cpuBusy: [], freeGb: [], probeMs: [] };
    const rounds = Math.max(2, Math.round(SECONDS / EVERY_S) + 1);
    const startedAt = Date.now();
    for (let round = 0; round < rounds; round++) {
      const due = startedAt + round * EVERY_S * 1000;
      if (due > Date.now()) await sleep(due - Date.now());
      const now = await Promise.all(pages.map((page) => probe(page)));
      now.forEach((reading, i) => readings[i].push(reading));
      if (round > 0) rig.cpuBusy.push(cpu());
      else cpu();
      rig.freeGb.push(os.freemem() / 1024 ** 3);
      rig.probeMs.push(max(now.filter((r) => r !== null).map((r) => r.tookMs)));
      const h = now[0];
      const g = now.slice(1).filter((r) => r !== null);
      log(
        `  t=${String(Math.round((Date.now() - startedAt) / 1000)).padStart(3)} s  host ${h?.frame ? `${f(h.frame.fps)} fps (1% low ${f(h.frame.lowFps)})` : '?'}` +
          `  step ${h?.host ? f(h.host.metrics.stepMs, 3) : '?'} ms  up ${h?.host ? f(h.host.metrics.sentBytesPerS / 1024) : '?'} KB/s` +
          (g.length > 0
            ? `  guests ${f(mean(g.map((r) => r.frame?.fps ?? 0)))} fps avg / ${f(min(g.map((r) => r.frame?.fps ?? 0)))} worst, ` +
              `${f(mean(g.map((r) => r.client?.downKBps ?? 0)), 2)} KB/s each`
            : '') +
          `  score ${h?.scores?.join('-') ?? '?'}`,
      );
    }

    await shot(host, join(OUT, `room-${GUESTS}g-host.png`));
    if (guests[0]) await shot(guests[0], join(OUT, `room-${GUESTS}g-guest1.png`));

    const summaries = pages.map((page, i) => summarise(page.name, readings[i], page.problems));
    const cpus = os.cpus();
    const report = {
      guestCount: GUESTS,
      bots,
      seconds: summaries[0].seconds ?? 0,
      sizes: { host: HOST_SIZE, guest: GUEST_SIZE },
      rig: {
        cpu: cpus[0]?.model.trim() ?? 'unknown',
        cores: cpus.length,
        cpuBusyPct: mean(rig.cpuBusy) * 100,
        cpuBusyPctPeak: max(rig.cpuBusy) * 100,
        freeGbMin: min(rig.freeGb),
        probeMs: mean(rig.probeMs),
        probeMsPeak: max(rig.probeMs),
      },
      host: summaries[0],
      guests: summaries.slice(1),
    };
    const text = table(report);
    log('');
    log(text);
    writeFileSync(join(OUT, `room-${GUESTS}g.txt`), `${text}\n`);
    writeFileSync(
      join(OUT, `room-${GUESTS}g.json`),
      JSON.stringify({ ...report, lastNetText: readings.map((list) => list[list.length - 1]?.net ?? null), readings }, null, 1),
    );
    failed = summaries.some((s) => s.stayed === false || s.readings < 2);
  } catch (error) {
    failed = true;
    log(`FAILED: ${error?.message ?? error}`);
  } finally {
    await closeAll([...pages, ...ballast]);
  }
  process.exit(failed ? 1 : 0);
}

await main();
