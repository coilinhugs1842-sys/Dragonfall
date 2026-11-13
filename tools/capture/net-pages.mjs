/**
 * Shared pieces of the multiplayer capture tools (`rejoin.mjs`, `room.mjs`): one headless
 * browser per player, a host page that opens a room over the real transport (PeerJS signaling +
 * WebRTC), guest pages that join it, and a compact reading of what a page's
 * `window.__dragonfall.game.report()` and its DOM say.
 *
 * Every browser these tools start carries `OWNER_ARG` on its command line, so a clean-up can
 * tell them from the browsers of other capture runs on the same machine:
 *
 *   Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
 *     Where-Object { $_.CommandLine -like '*--dragonfall-net-tools*' }
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { collectProblems, launch, sleep } from './cdp.mjs';

export { sleep };

/** Marks the browsers of the net tools (Chromium ignores a switch it does not know). */
export const OWNER_ARG = '--dragonfall-net-tools';

export function parseArgs(argv) {
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

/**
 * What a page says about itself, small enough to keep per step. `hud` is read from the DOM:
 * what the player actually has on screen (the rejoin strip, the spectating label, the notice).
 */
export const READ = `(() => {
  const g = window.__dragonfall?.game;
  if (!g) return null;
  const r = g.report();
  const own = r.dragons.find((d) => d.local);
  const visible = (node) => {
    if (!node) return false;
    for (let up = node; up && up.nodeType === 1; up = up.parentElement) {
      if (up.hidden) return false;
      const style = getComputedStyle(up);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const shown = (selector) => {
    const node = document.querySelector(selector);
    return visible(node) ? (node.textContent ?? '').replace(/\\s+/g, ' ').trim() : null;
  };
  const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : v);
  const at = {};
  for (const d of r.dragons) at[d.id] = [Math.round(d.x), Math.round(d.y), Math.round(d.z)];
  const relayShown = visible(document.querySelector('.dfh-relay'));
  return {
    screen: r.screen, kind: r.kind, status: r.status, error: r.error, code: r.roomCode,
    id: r.localPlayerId, lobby: r.show.lobbyPhase, phase: r.phase, t: round(r.show.phaseTimeS),
    fade: round(r.show.fade), aerie: r.show.aerie, directed: r.show.directed,
    card: round(r.show.introCard), warming: r.show.warming,
    inMatch: r.inMatch, isRider: r.isRider, tick: round(r.tick, 1),
    map: r.lobby ? r.lobby.settings.map : null, drawnMap: r.show.map ?? null, watching: r.show.watching ?? null,
    mode: r.match.mode, round: r.match.round,
    scores: r.match.scores, timeLeft: round(r.match.timeRemainingS, 1),
    players: r.lobby
      ? r.lobby.players.map((p) =>
          [p.id, p.name, p.side, p.classId, p.connected ? 'on' : 'AWAY', p.ready ? 'ready' : '', p.isBot ? 'bot' : '', p.isHost ? 'host' : '']
            .filter((part) => part !== '').join(':'))
      : null,
    roster: r.lobby
      ? r.lobby.players.map((p) => ({ id: p.id, name: p.name, side: p.side, classId: p.classId, connected: p.connected, ready: p.ready, bot: p.isBot === true, host: p.isHost === true }))
      : [],
    dragons: r.dragons.map((d) => d.id + (d.alive ? '' : 'x')).join(','),
    at,
    own: own ? { id: own.id, team: own.team, classId: own.classId, alive: own.alive, at: at[own.id] } : null,
    local: r.local ? { classId: r.local.classId, alive: r.local.alive, health: round(r.local.health, 0) } : null,
    stats: r.match.stats.map((s) => s.playerId + ':' + s.takedowns + '/' + s.deaths + '/' + s.assists + (s.present ? '' : ':gone')).join(' '),
    winner: r.match.winner,
    input: { steerX: round(r.input.steerX), steerY: round(r.input.steerY), buttons: r.input.buttons },
    casts: r.match.localCasts, hits: r.match.localHits,
    client: r.client
      ? { ping: round(r.client.pingMs, 0), snapshots: r.client.snapshots, starved: r.client.starved,
          reconnects: r.client.reconnects, corrections: r.client.corrections, snaps: r.client.snaps,
          largestM: round(r.client.largestCorrectionM), loss: round(r.client.lossPct, 1) }
      : null,
    host: r.host ? { mode: r.host.mode, clients: r.host.clients, bots: r.host.bots } : null,
    hud: {
      strip: shown('.dfu-strip'), chip: shown('.dfu-chip'), spectating: shown('.dfh-spectate'),
      notice: shown('#dfu-notice-title'), noticeHint: shown('#dfu-notice-hint'),
      resultsRows: visible(document.querySelector('.dfu-results')) ? document.querySelectorAll('.dfu-results .dfr-row').length : 0,
      resultsTitle: shown('.dfu-results .dfr-title'),
      introCard: shown('.dfh-intro'),
      watchPrompt: shown('.df-flight-overlay'),
      vitals: visible(document.querySelector('.dfh-vitals')),
      abilities: visible(document.querySelector('.dfh-abilities')),
      relay: relayShown
        ? [...document.querySelectorAll('.dfh-relay .dfh-shard')].map((cell) => {
            const who = cell.querySelector('.dfh-shard-who');
            return cell.dataset.team + ':' + cell.dataset.status + (visible(who) && who.textContent ? ':' + who.textContent : '');
          }).join(' ')
        : null,
    },
  };
})()`;

/**
 * Installed before the page's own scripts (`installNetGate`): `window.__netGate.down = true`
 * makes every data channel of the page a black hole in both directions (sends vanish, received
 * messages are not delivered) while the peer connection itself stays up: what a Wi-Fi drop
 * looks like to the game until someone times out. `closeAll()` closes the page's peer
 * connections instead: a link that dies with notice.
 */
export const NET_GATE = `(() => {
  if (window.__netGate) return;
  const gate = { down: false, pcs: [], dropped: 0, ignored: 0,
    closeAll() { let n = 0; for (const pc of gate.pcs) { if (pc.connectionState !== 'closed') { pc.close(); n++; } } return n; },
    states() { return gate.pcs.map((pc) => pc.connectionState); } };
  window.__netGate = gate;
  const Native = window.RTCPeerConnection;
  const Wrapped = function RTCPeerConnection(...args) {
    const pc = new Native(...args);
    gate.pcs.push(pc);
    return pc;
  };
  Wrapped.prototype = Native.prototype;
  Object.setPrototypeOf(Wrapped, Native);
  window.RTCPeerConnection = Wrapped;
  const proto = RTCDataChannel.prototype;
  const send = proto.send;
  proto.send = function (data) {
    if (gate.down) { gate.dropped++; return; }
    return send.call(this, data);
  };
  const gated = (channel, listener) => function (event) {
    if (gate.down) { gate.ignored++; return; }
    return listener.call(channel, event);
  };
  const slot = Object.getOwnPropertyDescriptor(proto, 'onmessage');
  const handlers = new WeakMap();
  Object.defineProperty(proto, 'onmessage', {
    configurable: true, enumerable: true,
    get() { return handlers.get(this) ?? null; },
    set(handler) {
      handlers.set(this, handler);
      slot.set.call(this, typeof handler === 'function' ? gated(this, handler) : null);
    },
  });
  const add = proto.addEventListener;
  proto.addEventListener = function (type, listener, options) {
    if (type === 'message' && typeof listener === 'function') return add.call(this, type, gated(this, listener), options);
    return add.call(this, type, listener, options);
  };
})();`;

/** Call before the first navigation of a page whose link will be dropped. */
export async function installNetGate(page) {
  await page.session.send('Page.addScriptToEvaluateOnNewDocument', { source: NET_GATE });
}

/**
 * Takes the page off the network (`down` true) or brings it back: the data channels through
 * the gate, HTTP and new WebSockets (the signaling broker) through DevTools' offline mode.
 * DevTools' offline mode alone does not touch WebRTC (measured: snapshots keep arriving).
 */
export async function setOffline(page, down) {
  await page.session.send('Network.enable').catch(() => {});
  await page.session.send('Network.emulateNetworkConditions', {
    offline: down, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await page.session.evaluate(`(window.__netGate ? (window.__netGate.down = ${down ? 'true' : 'false'}, true) : false)`);
}

/** An expression that presses the first enabled button whose text contains `label`. */
export function click(label) {
  return `(() => {
  const b = [...document.querySelectorAll('button, [role="button"]')].find((e) => (e.textContent ?? '').includes(${JSON.stringify(label)}) && !e.disabled);
  if (!b) return false;
  b.click();
  return true;
})()`;
}

/** An expression that raises a UiIntent on the page's game (what a button would do). */
export function intent(object) {
  return `(window.__dragonfall.game.handleIntent(${JSON.stringify(object)}), true)`;
}

/** Polls `expression` until it is truthy; null on timeout. Never throws for a page that is booting. */
export async function waitFor(page, expression, timeoutMs, everyMs = 200) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await page.session.evaluate(expression);
      if (value) return value;
    } catch {
      // Still booting, or mid-navigation.
    }
    if (Date.now() > until) return null;
    await sleep(everyMs);
  }
}

export async function read(page) {
  try {
    return await page.session.evaluate(READ);
  } catch {
    return null;
  }
}

/** Polls `READ` until `test(reading)` is true. Returns `{ ok, read, waitedMs }`. */
export async function waitRead(page, test, timeoutMs, everyMs = 200) {
  const from = Date.now();
  let last = null;
  for (;;) {
    last = await read(page);
    let ok = false;
    try {
      ok = last !== null && Boolean(test(last));
    } catch {
      ok = false;
    }
    const waitedMs = Date.now() - from;
    if (ok) return { ok: true, read: last, waitedMs };
    if (waitedMs > timeoutMs) return { ok: false, read: last, waitedMs };
    await sleep(everyMs);
  }
}

export async function shot(page, file) {
  try {
    const { data } = await page.session.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  } catch (error) {
    return `shot failed: ${error.message}`;
  }
}

/**
 * Keeps a page on the code it loaded: the dev server's hot-reload socket never opens, so a
 * file saved in the checkout during a run (other work going on) does not reload the page and
 * close the room under the test. Only the socket of the Vite client is replaced; PeerJS's
 * signaling socket (no sub-protocol) is the real one.
 */
const QUIET_HMR = `(() => {
  const Native = window.WebSocket;
  function QuietSocket(url, protocols) {
    const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    if (!list.some((p) => p === 'vite-hmr' || p === 'vite-ping')) {
      return protocols === undefined ? new Native(url) : new Native(url, protocols);
    }
    const quiet = new EventTarget();
    quiet.url = String(url);
    quiet.readyState = 0;
    quiet.send = () => {};
    quiet.close = () => {};
    return quiet;
  }
  QuietSocket.prototype = Native.prototype;
  QuietSocket.CONNECTING = 0;
  QuietSocket.OPEN = 1;
  QuietSocket.CLOSING = 2;
  QuietSocket.CLOSED = 3;
  window.WebSocket = QuietSocket;
})();`;

/** `--hmr` on a tool's command line leaves the dev server's hot reload on in its pages. */
const KEEP_HMR = process.argv.includes('--hmr');

/** One headless browser with one page. `problems` fills with console errors and warnings. */
export async function openPage(name, { width = 640, height = 360, extraArgs = [] } = {}) {
  const session = await launch({ width, height, extraArgs: [OWNER_ARG, ...extraArgs] });
  const problems = collectProblems(session);
  if (!KEEP_HMR) await session.send('Page.addScriptToEvaluateOnNewDocument', { source: QUIET_HMR });
  return { name, session, problems, url: '' };
}

export async function navigate(page, url) {
  page.url = url;
  await page.session.send('Page.navigate', { url });
}

/**
 * Opens a host page and its room. The public signaling broker can take several seconds or
 * refuse outright, so the whole thing is retried. Returns `{ page, code }`.
 */
export async function openHost(base, query, { width, height, attempts = 3, log = () => {}, prepare } = {}) {
  let lastError = 'no attempt';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const page = await openPage('host', { width, height });
    try {
      if (prepare) await prepare(page);
      await navigate(page, `${base}/?${query}`);
      const pressed = await waitFor(page, click('Host a room'), 20000);
      if (!pressed) throw new Error('no "Host a room" button (is the dev server up?)');
      const code = await waitFor(page, `(${READ})?.code || null`, 30000);
      if (!code) {
        const now = await read(page);
        throw new Error(`no room code after 30 s (${JSON.stringify(now?.error ?? now?.status)})`);
      }
      return { page, code };
    } catch (error) {
      lastError = String(error?.message ?? error);
      log(`host attempt ${attempt} failed: ${lastError}`);
      await page.session.close();
      await sleep(1500);
    }
  }
  throw new Error(`the host page never opened a room: ${lastError}`);
}

/** True once a guest page is in the room: the lobby, or the match when one is running. */
export const inRoom = (r) => r.status === 'connected' && (r.screen === 'lobby' || r.screen === 'match');

/**
 * Opens a guest page that joins `code`. Waits until it is in the room; a failed join is
 * retried by loading the same URL again.
 */
export async function openGuest(base, code, query, name, { width, height, attempts = 3, log = () => {}, prepare } = {}) {
  const page = await openPage(name, { width, height });
  try {
    if (prepare) await prepare(page);
    const url = `${base}/?join=${code}&${query}`;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await navigate(page, url);
      const joined = await waitRead(page, inRoom, 45000);
      if (joined.ok) return page;
      log(`${name} join attempt ${attempt} failed: ${JSON.stringify({ status: joined.read?.status, error: joined.read?.error })}`);
      await sleep(1000);
    }
  } catch (error) {
    await page.session.close();
    throw error;
  }
  await page.session.close();
  throw new Error(`${name} never joined room ${code}`);
}

export async function closeAll(pages) {
  await Promise.all(
    pages
      .filter((page) => page !== null && page !== undefined)
      .map((page) => page.session.close().catch(() => {})),
  );
}

/**
 * Console problems that are the game's. Dropped: the dev server's own chatter, and what a
 * browser prints for a request the test itself cut off (offline mode, a navigation).
 */
export function realProblems(problems) {
  return problems.filter(
    (line) =>
      !line.includes('[vite]') &&
      !line.includes('favicon') &&
      !line.includes('net::ERR_INTERNET_DISCONNECTED') &&
      !line.includes('net::ERR_ABORTED'),
  );
}
