/**
 * Minimal Chrome DevTools Protocol driver for headless Edge / Chrome. No dependencies: Node 22's
 * built-in WebSocket and fetch. Used by `shot.mjs` (screenshots + console check) and `record.mjs`
 * (frame capture for the trailer).
 *
 * The GPU flags matter: without them headless falls back to SwiftShader and the game either
 * refuses to start or renders at a frame rate that says nothing.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROFILE_PREFIX = 'dragonfall-cdp-';
/** Written into each profile: the node process that owns it. */
const OWNER_FILE = 'dragonfall-owner.pid';
/** A profile with no readable owner is only swept once it is this old. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = it exists but is not ours to signal.
    return error.code === 'EPERM';
  }
}

/** Kills the browser and everything it started. `child.kill()` alone leaves Edge's GPU and
 * renderer processes alive on Windows, and they keep the profile's files locked. */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

/** Deletes a profile folder, waiting out files the dying browser still holds. True when gone. */
function removeProfile(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch {
    // Reported by the caller through the return value.
  }
  return !existsSync(dir);
}

/**
 * Removes profiles left behind by captures that were killed before they could clean up. A
 * profile is about 50 MB, and a leak of these once filled the system drive, so every launch
 * sweeps. Only profiles whose owning node process is gone are touched: another capture running
 * right now keeps its own.
 */
export function sweepStaleProfiles() {
  let removed = 0;
  let entries = [];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    let stale = false;
    try {
      const owner = Number(readFileSync(join(dir, OWNER_FILE), 'utf8'));
      stale = !(owner > 0) || !isRunning(owner);
    } catch {
      // No owner file: written by an older version of this tool, or still being created.
      try {
        stale = Date.now() - statSync(dir).mtimeMs > ORPHAN_AGE_MS;
      } catch {
        stale = false;
      }
    }
    if (stale && removeProfile(dir)) removed++;
  }
  return removed;
}

/** Sessions still open in this process, so an exit or Ctrl+C cleans them up too. */
const live = new Set();
let exitHooked = false;

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const cleanup = () => {
    for (const entry of live) {
      killTree(entry.child);
      removeProfile(entry.profile);
    }
    live.clear();
  };
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }
}

const BROWSER_CANDIDATES = [
  process.env.DRAGONFALL_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error('No Edge / Chrome found. Set DRAGONFALL_BROWSER to the executable path.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a headless browser with one blank page and returns a CDP session on that page.
 * `close()` kills the browser and deletes its throwaway profile; so does this process exiting
 * or being interrupted, and the next launch sweeps what a hard kill left behind.
 */
export async function launch({ width = 1280, height = 720, extraArgs = [] } = {}) {
  hookExit();
  sweepStaleProfiles();
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  writeFileSync(join(profile, OWNER_FILE), String(process.pid));
  const child = spawn(
    findBrowser(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      // A throwaway profile needs no caches: these keep it to a few MB instead of about 50.
      '--disk-cache-size=1',
      '--media-cache-size=1',
      '--disable-gpu-shader-disk-cache',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      `--window-size=${width},${height}`,
      '--use-angle=d3d11',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const entry = { child, profile };
  live.add(entry);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  /** Kills the browser tree, waits for it to go, deletes the profile. Safe to call twice. */
  async function destroy() {
    if (!live.has(entry)) return;
    killTree(child);
    await Promise.race([exited, sleep(3000)]);
    live.delete(entry);
    if (!removeProfile(profile)) {
      console.error(`capture: could not delete the browser profile ${profile}; delete it by hand.`);
    }
  }

  const portFile = join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 150 && port === 0; i++) {
    await sleep(100);
    if (existsSync(portFile)) {
      try {
        const first = readFileSync(portFile, 'utf8').split('\n')[0];
        port = Number(first) || 0;
      } catch {
        // The browser is still writing the file (EBUSY on Windows): try again next round.
      }
    }
  }
  if (port === 0) {
    await destroy();
    throw new Error('The browser did not open a DevTools port within 15 s.');
  }

  let target;
  for (let i = 0; i < 50 && target === undefined; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((entry) => entry.type === 'page');
    if (target === undefined) await sleep(100);
  }
  if (target === undefined) {
    await destroy();
    throw new Error('The browser has no page target.');
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed to open')), {
        once: true,
      });
    });
  } catch (error) {
    await destroy();
    throw error;
  }

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    const handlers = listeners.get(message.method);
    if (handlers !== undefined) for (const handler of handlers) handler(message.params);
  });

  // A browser that dies (or a page that crashes) takes the socket with it: every call still
  // waiting is failed, so the script reports it instead of ending silently with no output.
  let closed = false;
  socket.addEventListener('close', () => {
    closed = true;
    for (const entry of pending.values()) {
      entry.reject(new Error(`${entry.method}: the browser closed the connection`));
    }
    pending.clear();
  });

  function send(method, params = {}) {
    if (closed) return Promise.reject(new Error(`${method}: the browser closed the connection`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(method, handler) {
    let handlers = listeners.get(method);
    if (handlers === undefined) {
      handlers = [];
      listeners.set(method, handlers);
    }
    handlers.push(handler);
  }

  /** Evaluates an expression in the page; awaits promises; returns the value (JSON-able). */
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text ?? 'evaluate failed');
    }
    return result.result.value;
  }

  async function close() {
    try {
      await Promise.race([send('Browser.close'), sleep(1500)]);
    } catch {
      // Already gone.
    }
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    await destroy();
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  return { send, on, evaluate, close, port };
}

/** Collects console errors / warnings, uncaught exceptions and failed requests of a session. */
export function collectProblems(session) {
  const problems = [];
  session.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'warning') return;
    const text = params.args
      .map((arg) => arg.value ?? arg.description ?? arg.type)
      .join(' ')
      .slice(0, 500);
    problems.push(`[console.${params.type}] ${text}`);
  });
  session.on('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails;
    problems.push(`[exception] ${(detail.exception?.description ?? detail.text).slice(0, 500)}`);
  });
  session.on('Log.entryAdded', (params) => {
    const entry = params.entry;
    if (entry.level !== 'error' && entry.level !== 'warning') return;
    problems.push(`[log.${entry.level}] ${entry.text.slice(0, 400)} ${entry.url ?? ''}`.trim());
  });
  return problems;
}

export { sleep };
