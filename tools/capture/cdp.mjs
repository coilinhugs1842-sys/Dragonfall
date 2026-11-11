/**
 * Minimal Chrome DevTools Protocol driver for headless Edge / Chrome. No dependencies: Node 22's
 * built-in WebSocket and fetch. Used by `shot.mjs` (screenshots + console check) and `record.mjs`
 * (frame capture for the trailer).
 *
 * The GPU flags matter: without them headless falls back to SwiftShader and the game either
 * refuses to start or renders at a frame rate that says nothing.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * `close()` kills the browser and deletes its throwaway profile.
 */
export async function launch({ width = 1280, height = 720, extraArgs = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'dragonfall-cdp-'));
  const child = spawn(
    findBrowser(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
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
    child.kill();
    throw new Error('The browser did not open a DevTools port within 15 s.');
  }

  let target;
  for (let i = 0; i < 50 && target === undefined; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((entry) => entry.type === 'page');
    if (target === undefined) await sleep(100);
  }
  if (target === undefined) {
    child.kill();
    throw new Error('The browser has no page target.');
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed to open')), {
      once: true,
    });
  });

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

  function send(method, params = {}) {
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
    child.kill();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // The profile is in the temp folder; a leftover is harmless.
    }
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
