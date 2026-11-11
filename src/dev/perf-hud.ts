/**
 * `?perf` HUD: the numbers every phase gate is measured with (docs/PERFORMANCE.md "How we
 * measure"). stats-gl draws the fps / cpu / gpu graphs; a text panel below adds what stats-gl
 * does not know: 1 % lows, draw calls, triangles, memory counts, heap, render scale, sim ms.
 *
 * Heavy module (pulls in stats-gl): only ever load it with a dynamic import, see ./boot.ts.
 */
import Stats from 'stats-gl';
import type { GameRenderer } from '../render';
import { FrameStats, createFrameStatsSummary } from './frame-stats';

/** `begin`/`end` bracket the render work of one frame. */
export interface PerfHud {
  /**
   * `frameMs` is the frame driver's rAF-to-rAF interval: the frame time the HUD reports. The
   * HUD does not time frames itself, because `begin` runs after the sim steps and its own clock
   * would add this frame's sim cost and subtract the last one's (at 30 Hz sim on a 60 Hz
   * display that alternates every frame and inflates max and the 1 % low).
   */
  begin(frameMs: number): void;
  end(): void;
  dispose(): void;
}

export interface PerfHudOptions {
  renderer: GameRenderer;
  /**
   * Averaged cost of one frame's fixed steps in ms (on the host: inputs + sim + snapshot
   * encode). Sampled at the text rate, not per frame.
   */
  getSimMs?: () => number;
  /**
   * The network lines under the sim line, already formatted (`src/game` builds them: on the host
   * the sim / snapshot split and KB/s up and down, on a client ping, interpolation delay,
   * snapshot loss and prediction error). Called at the text rate; '' = no session.
   */
  getNetText?: () => string;
  /** Where to mount. Defaults to `#ui`, then `document.body`. */
  parent?: HTMLElement;
}

/** Text refresh interval: 4 Hz is readable, and DOM writes every frame would cost frame time. */
const TEXT_INTERVAL_MS = 250;

/**
 * A gap this long between frames is a pause (hidden tab, breakpoint, loading stall), not a frame.
 * Leaving it out keeps one alt-tab from owning the max and 1 % low for the next 10 seconds.
 */
const PAUSE_GAP_MS = 1000;

const BYTES_PER_MB = 1024 * 1024;

/** Em dash: "no value yet" (no sim callback, no session). */
const NO_VALUE = '—';

/**
 * `performance.memory` is Chrome-only and non-standard, so it is missing from the DOM typings.
 * Returns -1 where it does not exist. Re-read on every call: Chrome hands out a fresh snapshot.
 */
function readHeapBytes(): number {
  const memory: unknown = Reflect.get(performance, 'memory');
  if (typeof memory !== 'object' || memory === null || !('usedJSHeapSize' in memory)) return -1;
  const used = memory.usedJSHeapSize;
  return typeof used === 'number' ? used : -1;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export async function createPerfHud(opts: PerfHudOptions): Promise<PerfHud> {
  const { renderer, getSimMs, getNetText } = opts;
  const webgl = renderer.webgl;
  const canvas = webgl.domElement;
  const info = webgl.info;
  const gl = webgl.getContext();

  // stats-gl adds the GPU panel whenever trackGPU is set, even without the timer extension, and
  // the panel would then sit at zero forever. So detect first. (Browsers often disable this
  // extension; the HUD then simply has no GPU graph.)
  const hasGpuTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null;
  const stats = new Stats({ trackGPU: hasGpuTimer, horizontal: true, logsPerSecond: 4 });
  // Given the raw GL context (not the three renderer), stats-gl does not monkey-patch
  // `renderer.render`: our begin/end bracket the whole frame, so a frame with several passes
  // is timed as one.
  await stats.init(gl);

  const root = document.createElement('div');
  root.className = 'df-perf-hud';
  // `contain` keeps the 4 Hz text write from invalidating layout outside this box.
  root.style.cssText =
    'position:absolute;top:0;left:0;z-index:1000;pointer-events:none;user-select:none;' +
    'contain:layout style paint;';

  // stats-gl positions itself `fixed` and its panels `absolute`; re-seat it inside our box.
  const panelCount = hasGpuTimer ? 3 : 2;
  stats.dom.style.cssText = `position:relative;width:${panelCount * 90}px;height:48px;opacity:0.9;`;
  root.appendChild(stats.dom);

  const pre = document.createElement('pre');
  pre.style.cssText =
    'margin:0;padding:3px 5px;min-width:270px;white-space:pre;' +
    'font:11px/1.35 ui-monospace,Consolas,Menlo,monospace;' +
    'color:#d7f7ff;background:rgba(0,0,16,0.72);';
  // One text node, updated through `data`: no element churn, no HTML parsing.
  const text = document.createTextNode('');
  pre.appendChild(text);
  root.appendChild(pre);

  (opts.parent ?? document.getElementById('ui') ?? document.body).appendChild(root);

  const frames = new FrameStats();
  const summary = createFrameStatsSummary();
  let lastText = -Infinity;
  let disposed = false;

  /** Runs at 4 Hz only: all the string building of the HUD happens here. */
  function refreshText(): void {
    frames.read(summary);
    const heap = readHeapBytes();
    const heapText = heap < 0 ? 'n/a' : `${(heap / BYTES_PER_MB).toFixed(0)} MB`;
    // Three decimals: a 10-dragon tick is tens of microseconds.
    const simText = getSimMs ? `${getSimMs().toFixed(3)} ms` : NO_VALUE;
    const netText = getNetText ? getNetText() : '';
    text.data =
      `fps ${summary.fps.toFixed(1)}  1% low ${summary.onePercentLowFps.toFixed(1)}\n` +
      `ms  avg ${summary.avgMs.toFixed(2)}  1% ${summary.onePercentLowMs.toFixed(2)}` +
      `  max ${summary.maxMs.toFixed(2)}\n` +
      `draw ${info.render.calls}  tri ${formatCount(info.render.triangles)}\n` +
      `geo ${info.memory.geometries}  tex ${info.memory.textures}  heap ${heapText}\n` +
      `scale ${renderer.resolution.scale.toFixed(2)}  ${canvas.width}x${canvas.height}` +
      `  ${renderer.presetId}\n` +
      `sim ${simText}
` +
      `${netText === '' ? `net ${NO_VALUE}` : netText}`;
  }

  return {
    begin(frameMs: number): void {
      if (disposed) return;
      // The presentation interval includes the vsync wait, the sim and everything else outside
      // the begin/end bracket: it is what the player sees, unlike the CPU graph (render work
      // only; the sim has its own line in the text).
      if (frameMs < PAUSE_GAP_MS) frames.push(frameMs);
      stats.begin();
    },

    end(): void {
      if (disposed) return;
      stats.end();
      stats.update();
      // Read renderer.info here, after the frame's render calls. GameRenderer turns autoReset off
      // and resets once per frame, so the counts are whole-frame totals, not the last pass only.
      const now = performance.now();
      if (now - lastText >= TEXT_INTERVAL_MS) {
        lastText = now;
        refreshText();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stats.dispose();
      root.remove();
    },
  };
}
