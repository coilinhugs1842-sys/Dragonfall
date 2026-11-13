/**
 * Reconnect and spectator scenarios against real pages (T-6.5): one headless browser per
 * player, the real transport (PeerJS signaling + WebRTC), the room driven the way a player
 * drives it. Every scenario reports pass / fail per check with its evidence: what each page's
 * `window.__dragonfall.game.report()` said before and after, a timeline of both pages through
 * the event, and screenshots.
 *
 *   node tools/capture/rejoin.mjs                         every scenario (about 15 minutes)
 *   node tools/capture/rejoin.mjs --only reload-playing,drop
 *   node tools/capture/rejoin.mjs --list
 *   node tools/capture/rejoin.mjs --base http://localhost:5199 --out art-source/_scratch/net/rejoin
 *
 * Needs a dev server (`--base`, default http://localhost:5199) and the internet (the public
 * signaling broker). Exit code 1 when a check fails, 2 when a scenario could not run.
 *
 * What cuts a link here:
 * - `Page.reload` / a navigation: the page's peer connection closes, the host hears it within
 *   a fraction of a second and holds the seat.
 * - DevTools' offline mode does NOT touch an open WebRTC data channel (the `drop` scenario
 *   measures it), so a silent network drop is made by `NET_GATE` in net-pages.mjs: the page's
 *   data channels become black holes while DevTools' offline mode cuts signaling.
 * - `__netGate.closeAll()`: the page closes its peer connections (a link that dies with notice).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  click,
  closeAll,
  inRoom,
  installNetGate,
  intent,
  navigate,
  openGuest,
  openHost,
  parseArgs,
  read,
  realProblems,
  setOffline,
  shot,
  sleep,
  waitRead,
} from './net-pages.mjs';

const args = parseArgs(process.argv.slice(2));
const BASE = args.base ?? 'http://localhost:5199';
const OUT = args.out ?? 'art-source/_scratch/net/rejoin';
const NO_PLAYER = 255;
const GRACE_S = 30;

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...parts) => console.log(stamp(), ...parts);

/** One line of a reading, for the log and the timelines. */
function brief(r) {
  if (r === null || r === undefined) return '(no page)';
  const hud = Object.entries(r.hud)
    .filter(([, value]) => value !== null && value !== false && value !== 0)
    .map(([key, value]) => `${key}=${value === true ? 'yes' : JSON.stringify(value)}`)
    .join(' ');
  const cl = r.client
    ? ` cl[snap=${r.client.snapshots} starved=${r.client.starved} rec=${r.client.reconnects} corr=${r.client.corrections}/${r.client.snaps} max=${r.client.largestM}m]`
    : '';
  return (
    `${r.screen}/${r.status} lobby=${r.lobby} phase=${r.phase} t=${r.t} fade=${r.fade}` +
    `${r.warming ? ' warming' : ''}${r.aerie ? ' aerie' : ''}${r.directed ? ' directed' : ''} card=${r.card}` +
    ` map=${r.drawnMap || '-'} id=${r.id} rider=${r.isRider}` +
    ` own=${r.own ? `${r.own.id}:t${r.own.team}:${r.own.classId}${r.own.alive ? '' : ':dead'}@${r.own.at}` : '-'}` +
    ` watching=${r.watching} dragons=${r.dragons} score=${r.scores} stats=[${r.stats}]${cl}` +
    ` hud{${hud}} roster=${JSON.stringify(r.players)}`
  );
}

// --- A scenario's context -----------------------------------------------------------------------

function makeContext(name) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const ctx = {
    name,
    dir,
    pages: [],
    checks: [],
    notes: [],
    evidence: {},
    timeline: [],
    shots: [],
    t0: Date.now(),
    /** Registers a page of the scenario and marks its document (see `undisturbed`). */
    async add(page) {
      ctx.pages.push(page);
      await page.session.evaluate('(window.__sameDocument = true)').catch(() => {});
    },
    check(label, ok, detail = '') {
      ctx.checks.push({ label, ok: Boolean(ok), detail: String(detail) });
      log(`  [${ok ? 'pass' : 'FAIL'}] ${label}${detail === '' ? '' : `: ${detail}`}`);
      return Boolean(ok);
    },
    /** Something measured that is neither right nor wrong: goes into the report as found. */
    note(text) {
      ctx.notes.push(text);
      log(`  [note] ${text}`);
    },
    async keep(label, ...pages) {
      for (const page of pages) {
        const reading = await read(page);
        ctx.evidence[`${label}.${page.name}`] = reading;
        log(`  ${label} ${page.name}: ${brief(reading)}`);
      }
    },
    async shot(label, page) {
      const file = join(dir, `${label}-${page.name}.png`);
      await shot(page, file);
      ctx.shots.push(file);
    },
    mark(label, readings) {
      const at = Number(((Date.now() - ctx.t0) / 1000).toFixed(2));
      const row = { at, label };
      for (const [who, reading] of Object.entries(readings)) row[who] = brief(reading);
      ctx.timeline.push(row);
    },
  };
  return ctx;
}

/** A reload or a navigation the scenario makes itself. */
async function reloadPage(page) {
  page.onPurpose = true;
  await page.session.send('Page.reload');
}

async function goTo(page, url) {
  page.onPurpose = true;
  await navigate(page, url);
}

/**
 * False when a page the scenario never reloaded has a new document: the dev server reloaded
 * it (another save in the checkout), which closes the room under the test. Such a run says
 * nothing about the game and is repeated.
 */
async function undisturbed(ctx) {
  for (const page of ctx.pages) {
    if (page.onPurpose === true) continue;
    let same = false;
    try {
      same = (await page.session.evaluate('window.__sameDocument === true')) === true;
    } catch {
      same = false;
    }
    if (!same) return false;
  }
  return true;
}

/** Samples `pages` every `everyMs` for `seconds`; `onSample(readings, elapsedS)` may return true to stop. */
async function trace(ctx, label, pages, seconds, everyMs, onSample) {
  const from = Date.now();
  const samples = [];
  for (;;) {
    const readings = {};
    const list = await Promise.all(pages.map((page) => read(page)));
    pages.forEach((page, i) => {
      readings[page.name] = list[i];
    });
    const elapsedS = (Date.now() - from) / 1000;
    ctx.mark(label, readings);
    samples.push({ at: elapsedS, ...readings });
    if (onSample !== undefined && onSample(readings, elapsedS) === true) break;
    if (elapsedS >= seconds) break;
    await sleep(everyMs);
  }
  return samples;
}

const HOST_BASE = 'quality=low&autopilot=bot';
const GUEST_QUERY = 'autopilot=bot&quality=low';

async function openRoom(ctx, hostQuery, { guests = ['guest'], gate = [], gateHost = false } = {}) {
  const { page: host, code } = await openHost(BASE, `${HOST_BASE}&${hostQuery}`, {
    log,
    prepare: gateHost ? installNetGate : undefined,
  });
  await ctx.add(host);
  log(`  room ${code} (${hostQuery})`);
  const opened = [];
  for (const name of guests) {
    const guest = await openGuest(BASE, code, GUEST_QUERY, name, {
      log,
      prepare: gate.includes(name) ? installNetGate : undefined,
    });
    await ctx.add(guest);
    opened.push(guest);
  }
  return { host, code, guests: opened };
}

const seatOf = (reading, id) => reading?.roster.find((p) => p.id === id) ?? null;

/** Riders ready up, the host starts. Returns false (and fails a check) when the match does not start. */
async function startMatch(ctx, host, riders) {
  // The lobby's buttons appear with the screen; a join that has just landed may not have them yet.
  for (const page of riders) {
    const me = await waitRead(page, (r) => inRoom(r) && seatOf(r, r.id) !== null, 10000);
    if (me.ok && seatOf(me.read, me.read.id).side !== 'spectator') {
      await page.session.evaluate(intent({ type: 'lobby.ready', ready: true }));
    }
  }
  const ready = await waitRead(
    host,
    (r) => r.roster.every((p) => p.host || p.side === 'spectator' || p.ready),
    15000,
  );
  if (!ready.ok) log(`  not everyone ready: ${JSON.stringify(ready.read?.players)}`);
  let started = { ok: false, read: null };
  for (let attempt = 0; attempt < 5 && !started.ok; attempt++) {
    await host.session.evaluate(click('Start match'));
    started = await waitRead(host, (r) => r.lobby !== 'lobby' || r.inMatch, 3000);
  }
  return ctx.check('the match starts', started.ok, started.ok ? '' : brief(started.read));
}

async function waitPlaying(ctx, page, timeoutMs = 40000) {
  const result = await waitRead(page, (r) => r.inMatch && r.phase === 'playing', timeoutMs);
  if (!result.ok) ctx.check(`${page.name} reaches the playing phase`, false, brief(result.read));
  return result;
}

function sameSeat(ctx, who, before, after) {
  const was = seatOf(before, before.id);
  const now = seatOf(after, after.id);
  ctx.check(
    `${who} has its seat back (id, team, class, name)`,
    was !== null && now !== null && after.id === before.id && now.side === was.side && now.classId === was.classId && now.name === was.name,
    `before ${JSON.stringify(was)} after ${JSON.stringify(now)}`,
  );
}

function statsRow(reading, id) {
  const row = (reading?.stats ?? '').split(' ').find((part) => part.startsWith(`${id}:`));
  if (row === undefined) return null;
  const [takedowns, deaths, assists] = row.split(':')[1].split('/').map(Number);
  return { takedowns, deaths, assists, gone: row.endsWith(':gone') };
}

function noGhosts(ctx, hostReading, expectedMembers, expectedDragons) {
  const ids = hostReading.roster.map((p) => p.id);
  const unique = new Set(ids).size === ids.length;
  const away = hostReading.roster.filter((p) => !p.connected);
  const dragons = hostReading.dragons === '' ? 0 : hostReading.dragons.split(',').length;
  ctx.check(
    'the host has no ghost or duplicate',
    unique && away.length === 0 && ids.length === expectedMembers && (expectedDragons === null || dragons === expectedDragons),
    `${ids.length} members (expected ${expectedMembers}), ${away.length} away, ${dragons} dragons (expected ${expectedDragons ?? 'any'}): ${JSON.stringify(hostReading.players)}`,
  );
}

function clocksAgree(ctx, who, hostReading, pageReading, toleranceS = 0.8) {
  const samePhase = hostReading.phase === pageReading.phase;
  const apart = Math.abs(hostReading.t - pageReading.t);
  ctx.check(
    `${who} is at the host's moment of the match`,
    samePhase && apart <= toleranceS,
    `host ${hostReading.phase} t=${hostReading.t}, ${who} ${pageReading.phase} t=${pageReading.t}`,
  );
}

/** The own dragon answers the controls: it moves, and the autopilot's input reaches it. */
async function controlReturns(ctx, page) {
  let moved = 0;
  let detail = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const a = await waitRead(page, (r) => r.own !== null && r.own.alive && r.phase === 'playing', 15000);
    if (!a.ok) {
      detail = `no living own dragon: ${brief(a.read)}`;
      continue;
    }
    await sleep(2000);
    const b = await read(page);
    if (b === null || b.own === null || !b.own.alive) continue;
    moved = Math.hypot(b.own.at[0] - a.read.own.at[0], b.own.at[1] - a.read.own.at[1], b.own.at[2] - a.read.own.at[2]);
    detail = `moved ${moved.toFixed(0)} m in 2 s, input steer ${b.input.steerX}/${b.input.steerY} buttons ${b.input.buttons}, casts ${b.casts}`;
    if (moved > 15) break;
  }
  ctx.check(`${page.name} flies its dragon again`, moved > 15, detail);
}

function cleanConsole(ctx, pages) {
  for (const page of pages) {
    const problems = realProblems(page.problems);
    ctx.check(`${page.name}: no console errors or warnings`, problems.length === 0, problems.slice(0, 6).join(' | '));
  }
}

// --- Part A: a guest reloads ---------------------------------------------------------------------

/**
 * A guest reloads its page when `when(guestReading)` first holds, and must come back to its
 * seat at the host's moment of the show.
 */
async function reloadScenario(ctx, { hostQuery, when, expectMap, expectScreen, relay = false }) {
  const { host, guests } = await openRoom(ctx, hostQuery);
  const guest = guests[0];
  if (!(await startMatch(ctx, host, [guest]))) return;
  const trigger = await waitRead(guest, (r) => when(r) || r.screen === 'title', 150000, 100);
  // The room died under the test (a hot reload of the dev server's pages): run it again.
  if (trigger.read?.screen === 'title') throw new Error('the guest fell back to the title before the test began');
  if (!ctx.check('the moment to reload at arrives', trigger.ok, brief(trigger.read))) return;
  await ctx.keep('before', host, guest);
  await ctx.shot('before', guest);
  const before = ctx.evidence['before.guest'];
  const hostBefore = ctx.evidence['before.host'];
  const membersBefore = hostBefore.roster.length;
  const dragonsBefore = hostBefore.dragons === '' ? null : hostBefore.dragons.split(',').length;

  const reloadedAt = Date.now();
  await reloadPage(guest);
  let backS = -1;
  let clearS = -1;
  let awayS = -1;
  let stuckHalfState = '';
  const samples = await trace(ctx, 'reload', [host, guest], 12, 250, (now, elapsedS) => {
    const h = now.host;
    const g = now.guest;
    if (h !== null && awayS < 0 && seatOf(h, before.id)?.connected === false) awayS = elapsedS;
    if (g === null) return false;
    const there = g.status === 'connected' && (h === null || !h.inMatch || g.inMatch);
    if (backS < 0 && there) backS = elapsedS;
    if (backS >= 0 && clearS < 0 && g.fade === 0 && !g.warming) clearS = elapsedS;
    // A half-state: the pages disagree about the scene for longer than a blink.
    if (backS >= 0 && elapsedS - backS > 3 && h !== null && h.inMatch !== g.inMatch) {
      stuckHalfState = `at +${elapsedS.toFixed(1)} s host inMatch=${h.inMatch}, guest inMatch=${g.inMatch}`;
    }
    return false;
  });
  log(`  reload took ${((Date.now() - reloadedAt) / 1000).toFixed(1)} s to trace`);
  await ctx.keep('after', host, guest);
  await ctx.shot('after', guest);
  const after = ctx.evidence['after.guest'];
  const hostAfter = ctx.evidence['after.host'];

  ctx.check('the guest is back in the room within 6 s', backS >= 0 && backS <= 6, `back after ${backS.toFixed(2)} s (host saw it away after ${awayS.toFixed(2)} s)`);
  ctx.check('the cream fade clears within 3 s of the join', clearS >= 0 && clearS - backS <= 3, `clear ${clearS.toFixed(2)} s after the reload, ${(clearS - backS).toFixed(2)} s after the join`);
  ctx.check('no half-state between the pages', stuckHalfState === '', stuckHalfState);
  if (after === null || hostAfter === null) return;
  sameSeat(ctx, 'the guest', before, after);
  noGhosts(ctx, hostAfter, membersBefore, hostAfter.inMatch ? dragonsBefore : null);
  if (hostAfter.inMatch) {
    ctx.check('the guest is a rider with its own dragon', after.isRider && (after.own !== null || after.phase === 'results'), brief(after));
    clocksAgree(ctx, 'the guest', hostAfter, after);
    ctx.check(
      'the guest drew the right map',
      after.drawnMap === hostAfter.drawnMap && (expectMap === undefined || after.drawnMap === expectMap),
      `guest ${after.drawnMap}, host ${hostAfter.drawnMap}${expectMap === undefined ? '' : `, expected ${expectMap}`}`,
    );
    const was = statsRow(before, before.id);
    const now = statsRow(after, before.id);
    if (was !== null) {
      ctx.check(
        'the score row survived',
        now !== null && !now.gone && now.takedowns >= was.takedowns && now.deaths >= was.deaths,
        `before ${JSON.stringify(was)} after ${JSON.stringify(now)}`,
      );
    }
    ctx.check('guest and host show the same score', String(after.scores) === String(hostAfter.scores), `guest ${after.scores} host ${hostAfter.scores}`);
  }
  // The intro card belongs to the intro: the same on both pages, gone when play starts.
  const cardOff = samples.filter(
    (s) => s.host !== null && s.guest !== null && s.guest.inMatch && s.host.phase === s.guest.phase && Math.abs(s.host.card - s.guest.card) > 0.5,
  );
  ctx.check('the intro card matches the host', cardOff.length <= 2, cardOff.length === 0 ? '' : `${cardOff.length} samples apart, first at +${cardOff[0].at.toFixed(1)} s: host ${cardOff[0].host.card} guest ${cardOff[0].guest.card}`);

  if (relay) {
    const both = await waitRead(guest, (r) => r.hud.relay !== null, 8000);
    const hostNow = await read(host);
    ctx.check(
      'the guest shows the shard state the host shows',
      both.ok && hostNow !== null && both.read.hud.relay === hostNow.hud.relay,
      `guest "${both.read?.hud.relay}" host "${hostNow?.hud.relay}" (before the reload: "${before.hud.relay}")`,
    );
  }

  if (expectScreen === 'results') {
    const table = samples.find((s) => s.guest !== null && s.guest.hud.resultsRows > 0);
    ctx.check('the results table appears after the reload', table !== undefined, table === undefined ? brief(after) : `at +${table.at.toFixed(1)} s with ${table.guest.hud.resultsRows} rows`);
    const lobby = await waitRead(guest, (r) => r.screen === 'lobby' && r.aerie && r.fade === 0, 25000);
    const hostLobby = await waitRead(host, (r) => r.screen === 'lobby', 5000);
    ctx.check('both return to the lobby', lobby.ok && hostLobby.ok, `guest ${brief(lobby.read)}`);
    await ctx.keep('lobby', host, guest);
    await ctx.shot('lobby', guest);
    if (lobby.ok) sameSeat(ctx, 'the guest (in the lobby)', before, lobby.read);
  } else {
    const playing = await waitPlaying(ctx, guest);
    if (playing.ok) {
      const hostThen = await read(host);
      if (hostThen !== null) clocksAgree(ctx, 'the guest (once playing)', hostThen, playing.read);
      ctx.check('the intro card is gone in play', playing.read.hud.introCard === null && playing.read.card === 0, `card=${playing.read.card} "${playing.read.hud.introCard}"`);
      await controlReturns(ctx, guest);
      await ctx.keep('playing', host, guest);
      await ctx.shot('playing', guest);
    }
  }
  cleanConsole(ctx, [host, guest]);
}

// --- Part A: the network drops -------------------------------------------------------------------

/** Path length of a dragon on the host over a list of samples. */
function travelled(samples, id) {
  let metres = 0;
  let last = null;
  for (const sample of samples) {
    const at = sample.host?.at?.[id];
    if (at === undefined) continue;
    if (last !== null) metres += Math.hypot(at[0] - last[0], at[1] - last[1], at[2] - last[2]);
    last = at;
  }
  return metres;
}

async function dropScenario(ctx) {
  const { host, guests } = await openRoom(ctx, 'bots=2&teamsize=2&nocine&score=200&time=0', { gate: ['guest'] });
  const guest = guests[0];
  if (!(await startMatch(ctx, host, [guest]))) return;
  if (!(await waitPlaying(ctx, guest)).ok) return;
  await sleep(5000);
  await guest.session.evaluate('(window.__sameDocument = true)');
  await ctx.keep('before', host, guest);
  const before = ctx.evidence['before.guest'];
  const membersBefore = ctx.evidence['before.host'].roster.length;

  // 1. DevTools' offline mode alone.
  await guest.session.send('Network.enable').catch(() => {});
  await guest.session.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(3000);
  const offlineOnly = await read(guest);
  await guest.session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const got = offlineOnly.client.snapshots - before.client.snapshots;
  ctx.note(`DevTools offline mode alone for 3 s: the guest still received ${got} snapshots (status ${offlineOnly.status}); it does not cut WebRTC, so the drop below gates the data channels in the page.`);
  await sleep(1500);

  // 2. Eight silent seconds.
  await ctx.shot('drop-before', guest);
  await setOffline(guest, true);
  let hostAwayS = -1;
  let stripS = -1;
  let stripText = '';
  let guestStatuses = [];
  // What the corner chip says in the seconds before the link is given up (still `connected`).
  const quietChips = [];
  const away = await trace(ctx, 'silent', [host, guest], 8, 500, (now, elapsedS) => {
    if (now.host !== null && hostAwayS < 0 && seatOf(now.host, before.id)?.connected === false) hostAwayS = elapsedS;
    if (now.guest !== null) {
      if (now.guest.status === 'connected' && elapsedS > 3) quietChips.push(now.guest.hud.chip);
      if (stripS < 0 && now.guest.hud.strip !== null) {
        stripS = elapsedS;
        stripText = now.guest.hud.strip;
      }
      if (guestStatuses[guestStatuses.length - 1] !== now.guest.status) guestStatuses.push(now.guest.status);
    }
    return false;
  });
  await ctx.keep('silent', host, guest);
  await ctx.shot('silent', guest);
  await ctx.shot('silent', host);
  const hostSilent = ctx.evidence['silent.host'];
  const guestSilent = ctx.evidence['silent.guest'];
  const flown = travelled(away, before.id);
  const stillThere = hostSilent.dragons.split(',').some((d) => d === String(before.id) || d === `${before.id}x`);
  ctx.note(
    `While the guest was silent: the host marked it away after ${hostAwayS < 0 ? 'more than 8' : hostAwayS.toFixed(1)} s; its dragon ${stillThere ? 'stayed in the match' : 'left the match'} and flew ${flown.toFixed(0)} m in 8 s on the host. ` +
      `The guest went ${guestStatuses.join(' -> ')}; its strip said "${stripText}" from ${stripS < 0 ? 'never' : `${stripS.toFixed(1)} s`}. ` +
      `Host roster entry: ${JSON.stringify(seatOf(hostSilent, before.id))}; host chip/strip: ${JSON.stringify({ chip: hostSilent.hud.chip, strip: hostSilent.hud.strip })}.`,
  );
  ctx.check('the host notices the silent guest and holds its seat', hostAwayS >= 0 && seatOf(hostSilent, before.id) !== null, `away after ${hostAwayS.toFixed(1)} s`);
  ctx.check('the dragon of the absent guest stays in the match on the host', stillThere, hostSilent.dragons);
  ctx.check('the guest tells its player what is going on', stripS >= 0, `"${stripText}" (status ${guestSilent.status})`);
  ctx.check(
    'before the link is given up the chip no longer shows the last good ping',
    quietChips.length > 0 && quietChips.every((chip) => chip !== before.hud.chip && /\d{3,}/.test(chip ?? '')),
    `chip before "${before.hud.chip}", from 3 s of silence on: ${JSON.stringify([...new Set(quietChips)])}`,
  );

  await setOffline(guest, false);
  let backS = -1;
  await trace(ctx, 'return', [host, guest], 20, 250, (now, elapsedS) => {
    const g = now.guest;
    if (g !== null && g.status === 'connected' && g.inMatch && g.own !== null && seatOf(now.host, before.id)?.connected === true) {
      backS = elapsedS;
      return true;
    }
    return false;
  });
  await sleep(1500);
  await ctx.keep('after', host, guest);
  await ctx.shot('after', guest);
  const after = ctx.evidence['after.guest'];
  const hostAfter = ctx.evidence['after.host'];
  ctx.check('the match resumes without a reload', backS >= 0 && (await guest.session.evaluate('window.__sameDocument === true')), `back ${backS.toFixed(2)} s after the network returned, reconnects ${after.client?.reconnects}`);
  sameSeat(ctx, 'the guest', before, after);
  noGhosts(ctx, hostAfter, membersBefore, 4);
  clocksAgree(ctx, 'the guest', hostAfter, after);
  ctx.check('the rejoin strip is gone', after.hud.strip === null, `strip "${after.hud.strip}" chip "${after.hud.chip}"`);
  await controlReturns(ctx, guest);

  // 3. The link closes with notice (the page's peer connection is closed under it).
  await sleep(2000);
  const closed = await guest.session.evaluate('window.__netGate.closeAll()');
  let lostS = -1;
  let againS = -1;
  await trace(ctx, 'closed', [host, guest], 20, 250, (now, elapsedS) => {
    const g = now.guest;
    if (g === null) return false;
    if (lostS < 0 && g.status !== 'connected') lostS = elapsedS;
    if (lostS >= 0 && g.status === 'connected' && g.own !== null && seatOf(now.host, before.id)?.connected === true) {
      againS = elapsedS;
      return true;
    }
    return false;
  });
  await sleep(1000);
  await ctx.keep('after-close', host, guest);
  const afterClose = ctx.evidence['after-close.guest'];
  ctx.check(
    'a closed peer connection is rejoined without a reload',
    againS >= 0 && (await guest.session.evaluate('window.__sameDocument === true')),
    `${closed} connection(s) closed; the guest noticed after ${lostS.toFixed(2)} s and was back after ${againS.toFixed(2)} s`,
  );
  sameSeat(ctx, 'the guest (after the closed link)', before, afterClose);
  noGhosts(ctx, ctx.evidence['after-close.host'], membersBefore, 4);
  cleanConsole(ctx, [host, guest]);
}

/** Away for longer than the grace: the seat goes, and coming back is a clean join. */
async function awayLongScenario(ctx) {
  const { host, guests, code } = await openRoom(ctx, 'bots=2&teamsize=2&nocine&score=200&time=0', { gate: ['guest'] });
  const guest = guests[0];
  if (!(await startMatch(ctx, host, [guest]))) return;
  if (!(await waitPlaying(ctx, guest)).ok) return;
  await sleep(4000);
  await ctx.keep('before', host, guest);
  const before = ctx.evidence['before.guest'];
  await setOffline(guest, true);
  let hostAwayS = -1;
  let freedS = -1;
  let dragonGoneS = -1;
  let gaveUpS = -1;
  let notice = '';
  const statuses = [];
  await trace(ctx, 'away', [host, guest], GRACE_S + 16, 1000, (now, elapsedS) => {
    const h = now.host;
    const g = now.guest;
    if (h !== null) {
      const seat = seatOf(h, before.id);
      if (hostAwayS < 0 && seat?.connected === false) hostAwayS = elapsedS;
      if (freedS < 0 && seat === null) freedS = elapsedS;
      if (dragonGoneS < 0 && !h.dragons.split(',').some((d) => d === String(before.id) || d === `${before.id}x`)) dragonGoneS = elapsedS;
    }
    if (g !== null) {
      if (statuses[statuses.length - 1] !== g.status) statuses.push(g.status);
      if (gaveUpS < 0 && g.screen === 'title') {
        gaveUpS = elapsedS;
        notice = `${g.hud.notice ?? ''} / ${g.hud.noticeHint ?? ''} / error=${JSON.stringify(g.error)}`;
      }
    }
    return freedS >= 0 && gaveUpS >= 0 && elapsedS - Math.max(freedS, gaveUpS) > 2;
  });
  await ctx.keep('expired', host, guest);
  await ctx.shot('expired', guest);
  await ctx.shot('expired', host);
  const hostExpired = ctx.evidence['expired.host'];
  const guestExpired = ctx.evidence['expired.guest'];
  ctx.check(
    `the seat is freed after the ${GRACE_S} s grace`,
    freedS >= 0 && freedS - hostAwayS >= GRACE_S - 2 && freedS - hostAwayS <= GRACE_S + 3,
    `away at ${hostAwayS.toFixed(1)} s, freed at ${freedS.toFixed(1)} s (${(freedS - hostAwayS).toFixed(1)} s held)`,
  );
  ctx.check('its dragon leaves the match with the seat', dragonGoneS >= 0 && Math.abs(dragonGoneS - freedS) <= 2.5, `dragon gone at ${dragonGoneS.toFixed(1)} s; host dragons now ${hostExpired.dragons}`);
  ctx.check("the host's roster shows the seat gone", seatOf(hostExpired, before.id) === null, JSON.stringify(hostExpired.players));
  const row = statsRow(hostExpired, before.id);
  ctx.note(`The score row of the rider who left: ${JSON.stringify(row)} (kept and marked as gone, or dropped).`);
  ctx.check(
    'the guest gives up with a clear message',
    gaveUpS >= 0 && (guestExpired.hud.notice !== null || guestExpired.error !== null),
    `went ${statuses.join(' -> ')}; at the title after ${gaveUpS.toFixed(1)} s with: ${notice}`,
  );

  // Coming back: the network returns, the player joins the same room again.
  await setOffline(guest, false);
  await goTo(guest, `${BASE}/?join=${code}&${GUEST_QUERY}`);
  const again = await waitRead(guest, inRoom, 45000);
  await sleep(2500);
  await ctx.keep('again', host, guest);
  await ctx.shot('again', guest);
  const guestAgain = ctx.evidence['again.guest'];
  const hostAgain = ctx.evidence['again.host'];
  if (!ctx.check('coming back joins the room again', again.ok && guestAgain !== null, brief(again.read))) return;
  const seat = seatOf(hostAgain, guestAgain.id);
  ctx.check(
    'a match is running, so the returning player watches',
    seat !== null && seat.side === 'spectator' && !guestAgain.isRider && guestAgain.inMatch && guestAgain.own === null,
    `seat ${JSON.stringify(seat)}; ${brief(guestAgain)}`,
  );
  noGhosts(ctx, hostAgain, 4, 3);
  ctx.check('the watcher sees the match', guestAgain.dragons === hostAgain.dragons || guestAgain.dragons.split(',').length === 3, `guest dragons ${guestAgain.dragons}, host ${hostAgain.dragons}`);
  cleanConsole(ctx, [host, guest]);
}

/** A guest leaves the lobby (its page goes away) and comes back: before and after the grace. */
async function awayLobbyScenario(ctx) {
  const { host, guests, code } = await openRoom(ctx, 'bots=1&teamsize=2&nocine');
  const guest = guests[0];
  await ctx.keep('before', host, guest);
  const before = ctx.evidence['before.guest'];
  await goTo(guest, 'about:blank');
  const held = await waitRead(host, (r) => seatOf(r, before.id)?.connected === false || seatOf(r, before.id) === null, 10000);
  const heldSeat = seatOf(held.read, before.id);
  ctx.note(`A guest whose page goes away in the lobby: the host ${heldSeat === null ? 'removes it at once' : 'holds its seat (shown as away)'} after ${(held.waitedMs / 1000).toFixed(1)} s.`);
  const blocked = await read(host);
  ctx.note(`While it is away the host's start button says: ${JSON.stringify(await host.session.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((e) => (e.textContent ?? '').includes('Start match')); return b ? { disabled: b.disabled, title: b.title, near: (b.parentElement?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 160) } : null; })()`))}; roster ${JSON.stringify(blocked.players)}`);
  await sleep(3000);
  await goTo(guest, `${BASE}/?join=${code}&${GUEST_QUERY}`);
  const back = await waitRead(guest, inRoom, 45000);
  await sleep(1000);
  await ctx.keep('back', host, guest);
  if (ctx.check('the guest is back in the lobby', back.ok, brief(back.read))) {
    sameSeat(ctx, 'the guest', before, ctx.evidence['back.guest']);
    noGhosts(ctx, ctx.evidence['back.host'], ctx.evidence['before.host'].roster.length, null);
  }
  // And for longer than the grace.
  await goTo(guest, 'about:blank');
  const from = Date.now();
  const freed = await waitRead(host, (r) => r.screen === 'lobby' && r.roster.length > 0 && seatOf(r, before.id) === null, (GRACE_S + 8) * 1000, 500);
  ctx.check(`the lobby seat is freed after the grace`, freed.ok && freed.waitedMs > (GRACE_S - 3) * 1000, `freed after ${((Date.now() - from) / 1000).toFixed(1)} s`);
  await goTo(guest, `${BASE}/?join=${code}&${GUEST_QUERY}`);
  const fresh = await waitRead(guest, inRoom, 45000);
  await sleep(1000);
  await ctx.keep('fresh', host, guest);
  const guestFresh = ctx.evidence['fresh.guest'];
  const hostFresh = ctx.evidence['fresh.host'];
  if (ctx.check('coming back after the grace is a fresh join', fresh.ok && guestFresh !== null, brief(fresh.read))) {
    const seat = seatOf(hostFresh, guestFresh.id);
    ctx.check('with a seat free in the lobby the returning player rides', seat !== null && seat.side !== 'spectator', JSON.stringify(seat));
    noGhosts(ctx, hostFresh, ctx.evidence['before.host'].roster.length, null);
  }
  cleanConsole(ctx, [host, guest]);
}

// --- Part A: the host goes away ------------------------------------------------------------------

async function hostGoneScenario(ctx, how) {
  const { host, guests } = await openRoom(ctx, 'bots=2&teamsize=2&nocine&score=200&time=0', { guests: ['guest', 'guest2'] });
  if (!(await startMatch(ctx, host, guests))) return;
  if (!(await waitPlaying(ctx, guests[0])).ok) return;
  await sleep(4000);
  await ctx.keep('before', host, ...guests);
  const from = Date.now();
  if (how === 'reload') await reloadPage(host);
  else if (how === 'navigate') await goTo(host, 'about:blank');
  else {
    // The browser dies: no unload handler runs, nothing is said.
    await host.session.close();
    ctx.pages.splice(ctx.pages.indexOf(host), 1);
  }
  const outcome = {};
  await trace(ctx, 'host-gone', guests, 45, 500, (now, elapsedS) => {
    let all = true;
    for (const page of guests) {
      const g = now[page.name];
      if (g === null) {
        all = false;
        continue;
      }
      const entry = (outcome[page.name] ??= { statuses: [], titleS: -1, firstSignS: -1, sign: '', notice: '' });
      if (entry.statuses[entry.statuses.length - 1] !== g.status) entry.statuses.push(g.status);
      if (entry.firstSignS < 0 && (g.hud.strip !== null || g.hud.notice !== null || g.screen === 'title')) {
        entry.firstSignS = elapsedS;
        entry.sign = g.hud.strip ?? g.hud.notice ?? 'title';
      }
      if (entry.titleS < 0 && g.screen === 'title') {
        entry.titleS = elapsedS;
        entry.notice = `${g.hud.notice ?? ''} — ${g.hud.noticeHint ?? ''}`;
      }
      if (entry.titleS < 0) all = false;
    }
    return all && elapsedS > 2;
  });
  log(`  host gone ${((Date.now() - from) / 1000).toFixed(1)} s ago`);
  await ctx.keep('after', ...guests);
  for (const page of guests) {
    await ctx.shot('after', page);
    const entry = outcome[page.name];
    const after = ctx.evidence[`after.${page.name}`];
    ctx.check(
      `${page.name} ends at the title with a clear message`,
      entry !== undefined && entry.titleS >= 0 && after.hud.notice !== null && after.hud.notice.length > 3,
      entry === undefined ? 'no reading' : `${entry.statuses.join(' -> ')}; first sign "${entry.sign}" after ${entry.firstSignS.toFixed(1)} s; title after ${entry.titleS.toFixed(1)} s: "${entry.notice}"`,
    );
    ctx.check(`${page.name} is told quickly (10 s)`, entry !== undefined && entry.firstSignS >= 0 && entry.firstSignS <= 10, entry === undefined ? '' : `${entry.firstSignS.toFixed(1)} s`);
    ctx.check(`${page.name} left the match scene`, after.screen === 'title' && !after.inMatch && after.fade === 0, brief(after));
    // The guest's own network is fine here, so the message must be about the host. How soon
    // depends on the signaling server: it says "no such room" to some attempts and nothing
    // to others, so a guest learns it between about 15 s and the end of the 30 s window.
    ctx.check(
      `${page.name} is told it was the host who went`,
      /host/i.test(after.hud.notice ?? '') && entry !== undefined && entry.titleS >= 0 && entry.titleS <= GRACE_S + 8,
      `"${after.hud.notice}" after ${entry?.titleS.toFixed(1)} s`,
    );
  }
  // A guest that reloads now must not try to get back into the dead room for ever.
  const guest = guests[0];
  await reloadPage(guest);
  const settled = await waitRead(guest, (r) => r.screen === 'title' && r.status !== 'connecting' && r.status !== 'reconnecting', 30000);
  ctx.check('a guest reloading afterwards lands on the title', settled.ok, `after ${(settled.waitedMs / 1000).toFixed(1)} s: ${brief(settled.read)}`);
  cleanConsole(ctx, guests);
}

/** The host's network goes silent for 8 s: every guest loses it at once, and all must come back. */
async function hostDropScenario(ctx) {
  const { host, guests } = await openRoom(ctx, 'bots=1&teamsize=2&nocine&score=200&time=0', { guests: ['guest', 'guest2'], gate: [] , gateHost: true });
  if (!(await startMatch(ctx, host, guests))) return;
  if (!(await waitPlaying(ctx, guests[0])).ok) return;
  await sleep(4000);
  await ctx.keep('before', host, ...guests);
  const before = guests.map((page) => ctx.evidence[`before.${page.name}`]);
  const membersBefore = ctx.evidence['before.host'].roster.length;
  await setOffline(host, true);
  const seen = { awayS: -1, strips: {}, hostSays: '' };
  await trace(ctx, 'silent', [host, ...guests], 8, 500, (now, elapsedS) => {
    if (now.host !== null) {
      if (seen.awayS < 0 && now.host.roster.some((p) => !p.connected)) seen.awayS = elapsedS;
      if (now.host.hud.strip !== null || now.host.hud.notice !== null) seen.hostSays = now.host.hud.strip ?? now.host.hud.notice;
    }
    for (const page of guests) {
      const g = now[page.name];
      if (g !== null && g.hud.strip !== null && seen.strips[page.name] === undefined) seen.strips[page.name] = elapsedS;
    }
    return false;
  });
  await ctx.keep('silent', host, ...guests);
  await ctx.shot('silent', host);
  await ctx.shot('silent', guests[0]);
  const hostSilent = ctx.evidence['silent.host'];
  ctx.note(
    `While the host was silent for 8 s: it marked its guests away after ${seen.awayS.toFixed(1)} s (${JSON.stringify(hostSilent.players)}) and kept flying with its bots; ` +
      `its own screen said "${seen.hostSays}" (chip "${hostSilent.hud.chip}"). The guests showed the rejoin strip after ${JSON.stringify(seen.strips)} s.`,
  );
  await setOffline(host, false);
  const backS = {};
  await trace(ctx, 'return', [host, ...guests], 25, 250, (now, elapsedS) => {
    let all = true;
    for (const page of guests) {
      const g = now[page.name];
      const ok = g !== null && g.status === 'connected' && g.inMatch && g.own !== null && seatOf(now.host, g.id)?.connected === true;
      if (ok && backS[page.name] === undefined) backS[page.name] = elapsedS;
      if (!ok) all = false;
    }
    return all;
  });
  await sleep(1500);
  await ctx.keep('after', host, ...guests);
  const hostAfter = ctx.evidence['after.host'];
  guests.forEach((page, i) => {
    const after = ctx.evidence[`after.${page.name}`];
    ctx.check(`${page.name} is back in the match without a reload`, backS[page.name] !== undefined, `back ${backS[page.name]?.toFixed(2)} s after the host's network returned`);
    if (after !== null && before[i] !== null) {
      sameSeat(ctx, page.name, before[i], after);
      clocksAgree(ctx, page.name, hostAfter, after);
      ctx.check(`${page.name}: the rejoin strip is gone`, after.hud.strip === null, `"${after.hud.strip}"`);
    }
  });
  noGhosts(ctx, hostAfter, membersBefore, 4);
  await controlReturns(ctx, guests[0]);
  cleanConsole(ctx, [host, ...guests]);
}

// --- Part B: watchers ----------------------------------------------------------------------------

async function clickPicture(page, x = 320, y = 150) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function pressKey(page, code, key, vk) {
  const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** A pad whose A button the test can press: the game polls `navigator.getGamepads()`. */
const FAKE_PAD = `(() => {
  const pad = { id: 'Test pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__pad = pad;
  navigator.getGamepads = () => [pad, null, null, null];
  window.dispatchEvent(new Event('gamepadconnected'));
  return true;
})()`;

async function pressPadA(page) {
  await page.session.evaluate(`(() => { const b = window.__pad.buttons[0]; b.pressed = true; b.value = 1; window.__pad.timestamp = performance.now(); return true; })()`);
  await sleep(150);
  await page.session.evaluate(`(() => { const b = window.__pad.buttons[0]; b.pressed = false; b.value = 0; window.__pad.timestamp = performance.now(); return true; })()`);
  await sleep(150);
}

function watcherChecks(ctx, label, w, hostReading) {
  ctx.check(`${label}: the watcher has no dragon and is not a rider`, w.inMatch && !w.isRider && w.own === null && w.local === null, brief(w));
  ctx.check(`${label}: the watcher follows a rider`, w.watching !== NO_PLAYER && w.watching !== null, `watching ${w.watching}`);
  ctx.check(
    `${label}: the HUD says "Spectating" and hides the rider-only parts`,
    w.hud.spectating !== null && !w.hud.vitals && !w.hud.abilities,
    `label "${w.hud.spectating}", vitals ${w.hud.vitals}, abilities ${w.hud.abilities}, prompt "${w.hud.watchPrompt}"`,
  );
  if (hostReading !== null) {
    const seat = seatOf(hostReading, w.id);
    ctx.check(`${label}: the host lists it as a spectator`, seat !== null && seat.side === 'spectator', JSON.stringify(seat));
    ctx.check(`${label}: the watcher sees every dragon the host has`, w.dragons.split(',').length === hostReading.dragons.split(',').length, `watcher ${w.dragons} host ${hostReading.dragons}`);
  }
}

/** The eleventh page in a full 5v5 watches the whole show: aerie, launch, intro, match, podium. */
async function spectatorFullScenario(ctx) {
  const { page: host, code } = await openHost(BASE, `${HOST_BASE}&bots=9&teamsize=5&score=12&time=150`, { log });
  await ctx.add(host);
  const full = await waitRead(host, (r) => r.roster.filter((p) => p.side !== 'spectator').length === 10, 30000);
  if (!ctx.check('the room is a full 5v5 (host + 9 bots)', full.ok, JSON.stringify(full.read?.players))) return;
  const watcher = await openGuest(BASE, code, GUEST_QUERY, 'watcher', { log });
  await ctx.add(watcher);
  await sleep(1500);
  await ctx.keep('lobby', host, watcher);
  await ctx.shot('lobby', watcher);
  const inLobby = ctx.evidence['lobby.watcher'];
  const seat = seatOf(ctx.evidence['lobby.host'], inLobby.id);
  ctx.check('the eleventh player joins as a spectator', seat !== null && seat.side === 'spectator', JSON.stringify(seat));
  ctx.check('the watcher sees the lobby (the aerie)', inLobby.screen === 'lobby' && inLobby.aerie && inLobby.fade === 0, brief(inLobby));
  const lobbyButtons = await watcher.session.evaluate(`[...document.querySelectorAll('button')].filter((b) => !b.disabled && b.offsetParent !== null).map((b) => (b.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter((t) => t !== '').slice(0, 30)`);
  ctx.note(`Lobby buttons a watcher can press in a full room: ${JSON.stringify(lobbyButtons)}`);
  // A watcher cannot take a seat that is not there, and cannot ready.
  await watcher.session.evaluate(intent({ type: 'lobby.switchSide', side: 0 }));
  await watcher.session.evaluate(intent({ type: 'lobby.ready', ready: true }));
  await sleep(800);
  const refused = seatOf(await read(host), inLobby.id);
  ctx.check('a full room refuses the watcher a team seat and a ready flag', refused !== null && refused.side === 'spectator' && !refused.ready, JSON.stringify(refused));

  await watcher.session.evaluate(FAKE_PAD);
  if (!(await startMatch(ctx, host, []))) return;
  const seen = { starting: false, intro: false, countdown: false, introDirected: false, introCard: false, worstApartS: 0 };
  await trace(ctx, 'show', [host, watcher], 30, 250, (now) => {
    const h = now.host;
    const w = now.watcher;
    if (h === null || w === null) return false;
    if (w.lobby === 'starting' && w.screen === 'lobby') seen.starting = true;
    if (w.inMatch && w.phase === 'intro') {
      seen.intro = true;
      if (w.directed) seen.introDirected = true;
      if (w.card > 0.5) seen.introCard = true;
    }
    if (w.inMatch && w.phase === 'countdown') seen.countdown = true;
    if (w.inMatch && h.inMatch && w.phase === h.phase) seen.worstApartS = Math.max(seen.worstApartS, Math.abs(w.t - h.t));
    return w.inMatch && w.phase === 'playing' && w.t > 1.5;
  });
  ctx.check('the watcher sees the launch, the intro and the countdown', seen.starting && seen.intro && seen.introDirected && seen.introCard && seen.countdown, JSON.stringify(seen));
  ctx.check("the watcher's show runs on the host's clock", seen.worstApartS < 0.8, `at most ${seen.worstApartS.toFixed(2)} s apart`);
  await ctx.keep('playing', host, watcher);
  await ctx.shot('playing', watcher);
  let w = ctx.evidence['playing.watcher'];
  let h = ctx.evidence['playing.host'];
  watcherChecks(ctx, 'in the match', w, h);
  ctx.check('the host flies ten dragons, none for the watcher', h.dragons.split(',').length === 10 && !h.dragons.split(',').some((d) => d.replace('x', '') === String(w.id)), h.dragons);

  // Following the next rider: a click on the picture, Space, a pad's A.
  const follow = [w.watching];
  await clickPicture(watcher);
  await sleep(400);
  follow.push((await read(watcher)).watching);
  await pressKey(watcher, 'Space', ' ', 32);
  await sleep(400);
  follow.push((await read(watcher)).watching);
  await pressPadA(watcher);
  await sleep(400);
  follow.push((await read(watcher)).watching);
  ctx.check('a click follows the next rider', follow[1] !== follow[0] && follow[1] !== NO_PLAYER, `${follow[0]} -> ${follow[1]}`);
  ctx.check('Space follows the next rider', follow[2] !== follow[1] && follow[2] !== NO_PLAYER, `${follow[1]} -> ${follow[2]}`);
  ctx.check("a pad's A follows the next rider", follow[3] !== follow[2] && follow[3] !== NO_PLAYER, `${follow[2]} -> ${follow[3]}`);

  // The followed rider dies.
  let death = null;
  await trace(ctx, 'followed-death', [watcher], 60, 200, (now, elapsedS) => {
    const r = now.watcher;
    if (r === null) return false;
    const dead = r.dragons.split(',').includes(`${r.watching}x`);
    if (death === null && dead) death = { at: elapsedS, watching: r.watching, then: [] };
    if (death !== null) {
      death.then.push(`${(elapsedS - death.at).toFixed(1)}s:${r.watching}${r.dragons.split(',').includes(`${r.watching}x`) ? 'x' : ''}${r.directed ? ':directed' : ''}`);
      if (death.then.length === 3) void ctx.shot('followed-death', watcher);
      return elapsedS - death.at > 7;
    }
    return false;
  });
  if (death === null) ctx.note('The followed rider did not die within 60 s; nothing observed about that case.');
  else {
    const last = await read(watcher);
    ctx.note(`The followed rider (${death.watching}) died: the watcher's camera then went ${death.then.filter((_, i) => i % 5 === 0).join(' ')}.`);
    ctx.check('the watcher keeps a picture when the followed rider dies', last !== null && last.watching !== NO_PLAYER && last.fade === 0, brief(last));
  }

  // A watcher reloads in the middle of the match.
  const beforeReload = await read(watcher);
  await reloadPage(watcher);
  const back = await waitRead(watcher, (r) => r.status === 'connected' && r.inMatch && r.fade === 0, 15000);
  await sleep(1000);
  await ctx.keep('reloaded', host, watcher);
  await ctx.shot('reloaded', watcher);
  w = ctx.evidence['reloaded.watcher'];
  h = ctx.evidence['reloaded.host'];
  if (ctx.check('a watcher who reloads mid-match is back within 6 s', back.ok && back.waitedMs < 6000, `${(back.waitedMs / 1000).toFixed(1)} s`)) {
    watcherChecks(ctx, 'after the reload', w, h);
    ctx.check('it is the same watcher seat', w.id === beforeReload.id, `before ${beforeReload.id} after ${w.id}`);
    noGhosts(ctx, h, 11, 10);
    clocksAgree(ctx, 'the watcher', h, w);
  }

  // The podium, and back to the lobby.
  let results = null;
  let podiumDirected = false;
  await trace(ctx, 'to-results', [host, watcher], 200, 1000, (now) => {
    const r = now.watcher;
    if (r === null) return false;
    if (r.phase === 'results') {
      if (r.directed) podiumDirected = true;
      if (r.hud.resultsRows > 0) results = r;
    }
    return results !== null && podiumDirected && r.t > 6;
  });
  await ctx.shot('results', watcher);
  ctx.check('the watcher sees the podium and the results table', results !== null && podiumDirected, results === null ? 'no results table' : `${results.hud.resultsRows} rows, "${results.hud.resultsTitle}"`);
  const lobby = await waitRead(watcher, (r) => r.screen === 'lobby' && r.aerie && r.fade === 0, 30000);
  await ctx.keep('lobby-again', host, watcher);
  await ctx.shot('lobby-again', watcher);
  ctx.check('the watcher returns to the lobby with the room', lobby.ok && seatOf(lobby.read, lobby.read.id)?.side === 'spectator', brief(lobby.read));
  cleanConsole(ctx, [host, watcher]);
}

/** A page that joins a running match watches it, and takes a free seat in the next lobby. */
async function spectatorMidMatchScenario(ctx) {
  const { host, guests, code } = await openRoom(ctx, 'bots=2&teamsize=3&nocine&score=4&time=60');
  const rider = guests[0];
  if (!(await startMatch(ctx, host, [rider]))) return;
  if (!(await waitPlaying(ctx, rider)).ok) return;
  await sleep(3000);
  const watcher = await openGuest(BASE, code, GUEST_QUERY, 'watcher', { log });
  await ctx.add(watcher);
  await sleep(2000);
  await ctx.keep('joined', host, watcher);
  await ctx.shot('joined', watcher);
  let w = ctx.evidence['joined.watcher'];
  let h = ctx.evidence['joined.host'];
  const freeSeats = 6 - h.roster.filter((p) => p.side !== 'spectator').length;
  ctx.note(`Joined a running match (teams of 3) with ${freeSeats} team seat(s) free: the host seated the page as ${JSON.stringify(seatOf(h, w.id))}.`);
  watcherChecks(ctx, 'joining mid-match', w, h);
  clocksAgree(ctx, 'the watcher', h, w);
  ctx.check('the watcher got the running score', String(w.scores) === String(h.scores) && w.stats === h.stats, `watcher ${w.scores} [${w.stats}] host ${h.scores} [${h.stats}]`);

  // It cannot take the free seat while the match runs, and nothing it sends flies a dragon.
  const dragonsBefore = h.dragons.split(',').length;
  await watcher.session.evaluate(intent({ type: 'lobby.switchSide', side: 0 }));
  await watcher.session.evaluate(intent({ type: 'lobby.switchSide', side: 1 }));
  await sleep(1200);
  h = await read(host);
  ctx.check(
    'no team seat is given while the match runs',
    seatOf(h, w.id)?.side === 'spectator' && h.dragons.split(',').length === dragonsBefore,
    `${JSON.stringify(seatOf(h, w.id))}, dragons ${h.dragons}`,
  );

  const lobby = await waitRead(watcher, (r) => r.screen === 'lobby' && r.aerie && r.fade === 0, 150000, 500);
  if (!ctx.check('the match ends and the watcher is back in the lobby', lobby.ok, brief(lobby.read))) return;
  await sleep(1000);
  h = await read(host);
  const sides = [0, 1].map((side) => h.roster.filter((p) => p.side === side).length);
  const open = sides[0] <= sides[1] ? 0 : 1;
  await watcher.session.evaluate(intent({ type: 'lobby.switchSide', side: open }));
  const seated = await waitRead(host, (r) => seatOf(r, w.id)?.side === open, 5000);
  await ctx.keep('seated', host, watcher);
  await ctx.shot('seated', watcher);
  if (!ctx.check('in the lobby the watcher takes the free team seat', seated.ok, `teams were ${sides}; now ${JSON.stringify(seatOf(seated.read, w.id))}`)) return;
  // Three against two now: the host allows uneven teams for the next match.
  await host.session.evaluate(intent({ type: 'host.setUnevenTeams', enabled: true }));
  if (!(await startMatch(ctx, host, [rider, watcher]))) return;
  const flying = await waitRead(watcher, (r) => r.inMatch && r.phase === 'playing' && r.isRider && r.own !== null, 40000);
  ctx.check('the former watcher rides in the next match', flying.ok, brief(flying.read));
  if (flying.ok) await controlReturns(ctx, watcher);
  await ctx.keep('riding', host, watcher);
  cleanConsole(ctx, [host, rider, watcher]);
}

// --- The table -----------------------------------------------------------------------------------

const NOCINE_ROOM = 'bots=2&teamsize=2&nocine&score=200&time=0';
const CINE_ROOM = 'bots=2&teamsize=2&score=200&time=0';

const SCENARIOS = [
  {
    name: 'reload-playing',
    about: 'A guest reloads during play',
    run: (ctx) => reloadScenario(ctx, { hostQuery: NOCINE_ROOM, when: (r) => r.inMatch && r.phase === 'playing' && r.t > 8 && r.own !== null }),
  },
  {
    name: 'reload-starting',
    about: 'A guest reloads while the aerie launches (lobby `starting`)',
    run: (ctx) => reloadScenario(ctx, { hostQuery: CINE_ROOM, when: (r) => r.lobby === 'starting' }),
  },
  {
    name: 'reload-intro',
    about: 'A guest reloads during the intro flyby',
    run: (ctx) => reloadScenario(ctx, { hostQuery: CINE_ROOM, when: (r) => r.inMatch && r.phase === 'intro' && r.t > 0.8 }),
  },
  {
    name: 'reload-countdown',
    about: 'A guest reloads during the 3-2-1',
    run: (ctx) => reloadScenario(ctx, { hostQuery: CINE_ROOM, when: (r) => r.inMatch && r.phase === 'countdown' && r.t > 0.2 }),
  },
  {
    name: 'reload-results',
    about: 'A guest reloads on the podium',
    run: (ctx) =>
      reloadScenario(ctx, {
        hostQuery: 'bots=2&teamsize=2&nocine&score=3&time=45',
        when: (r) => r.inMatch && r.phase === 'results' && r.t > 1.5,
        expectScreen: 'results',
      }),
  },
  {
    name: 'reload-caldera',
    about: 'A guest reloads on the second map',
    run: (ctx) =>
      reloadScenario(ctx, {
        hostQuery: `${NOCINE_ROOM}&map=emberfall-caldera`,
        when: (r) => r.inMatch && r.phase === 'playing' && r.t > 6 && r.own !== null,
        expectMap: 'emberfall-caldera',
      }),
  },
  {
    name: 'reload-relay',
    about: 'A guest reloads in Ember Relay while a shard is away from home',
    run: (ctx) =>
      reloadScenario(ctx, {
        hostQuery: 'bots=2&teamsize=2&nocine&mode=emberRelay&time=0',
        // A shard carried or dropped; after 75 s whatever the state is.
        when: (r) => r.inMatch && r.phase === 'playing' && r.own !== null && r.hud.relay !== null && (/carried|dropped/.test(r.hud.relay) || r.t > 75),
        relay: true,
      }),
  },
  { name: 'drop', about: 'The guest\'s network goes silent for 8 s, then its link is closed', run: dropScenario },
  { name: 'away-long', about: 'The guest is away for longer than the grace', run: awayLongScenario },
  { name: 'away-lobby', about: 'A guest leaves the lobby and returns, inside and outside the grace', run: awayLobbyScenario },
  { name: 'host-drop', about: "The host's network goes silent for 8 s", run: hostDropScenario },
  { name: 'host-reload', about: 'The host reloads its page mid-match', run: (ctx) => hostGoneScenario(ctx, 'reload') },
  { name: 'host-close', about: "The host's browser dies mid-match", run: (ctx) => hostGoneScenario(ctx, 'kill') },
  { name: 'spectator-full', about: 'The eleventh page in a full 5v5 watches the whole show', run: spectatorFullScenario },
  { name: 'spectator-midmatch', about: 'A page joins a running match, then takes a seat in the lobby', run: spectatorMidMatchScenario },
];

if (args.list === 'true') {
  for (const scenario of SCENARIOS) console.log(`${scenario.name.padEnd(20)} ${scenario.about}`);
  process.exit(0);
}

const only = args.only === undefined ? null : args.only.split(',').map((part) => part.trim());
const chosen = SCENARIOS.filter((scenario) => only === null || only.includes(scenario.name));
if (chosen.length === 0) {
  console.error(`no scenario matches --only ${args.only}; try --list`);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const results = [];
/** Runs that died for a reason outside the game (the broker, a hot reload) and were repeated. */
const disturbances = [];
for (const scenario of chosen) {
  log(`=== ${scenario.name}: ${scenario.about}`);
  let ctx = makeContext(scenario.name);
  // A scenario that dies (the broker, a hot reload of the dev server under it) is run once more.
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let crashed = null;
    try {
      await scenario.run(ctx);
      if (ctx.checks.some((c) => !c.ok) && !(await undisturbed(ctx))) {
        crashed = new Error('a page was reloaded under the test (the dev server pushed a change)');
      }
    } catch (error) {
      crashed = error;
    } finally {
      await closeAll(ctx.pages);
    }
    if (crashed === null) break;
    log(`  scenario disturbed (attempt ${attempt}): ${crashed?.stack ?? crashed}`);
    disturbances.push(`${scenario.name} attempt ${attempt}: ${crashed?.message ?? crashed}`);
    if (attempt === ATTEMPTS) ctx.check('the scenario ran undisturbed', false, String(crashed?.message ?? crashed));
    else ctx = makeContext(scenario.name);
  }
  const failed = ctx.checks.filter((c) => !c.ok);
  const result = {
    name: scenario.name,
    about: scenario.about,
    pass: ctx.checks.length > 0 && failed.length === 0,
    checks: ctx.checks,
    notes: ctx.notes,
    evidence: ctx.evidence,
    timeline: ctx.timeline,
    shots: ctx.shots,
  };
  results.push(result);
  writeFileSync(join(ctx.dir, 'report.json'), JSON.stringify(result, null, 1));
  log(`=== ${scenario.name}: ${result.pass ? 'PASS' : `FAIL (${failed.length} of ${ctx.checks.length} checks)`}`);
}

const lines = [];
for (const result of results) {
  lines.push(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}: ${result.about}`);
  for (const c of result.checks) lines.push(`    [${c.ok ? 'pass' : 'FAIL'}] ${c.label}${c.detail === '' ? '' : `: ${c.detail}`}`);
  for (const note of result.notes) lines.push(`    [note] ${note}`);
}
for (const line of disturbances) lines.push(`repeated: ${line}`);
const summary = lines.join('\n');
writeFileSync(join(OUT, `summary${only === null ? '' : `-${only.join('+')}`}.txt`), `${summary}\n`);
console.log(`\n${summary}\n\nevidence: ${OUT}/<scenario>/report.json and screenshots`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
