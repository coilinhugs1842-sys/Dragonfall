/**
 * `?bench`: the fixed benchmark of docs/PERFORMANCE.md ("How we measure"). The page hosts a 5v5
 * bot Skirmish (main.ts turns the flag into that room), the camera leaves the chase rig for a
 * fixed path round the middle of the map, and after a warm-up the frame times of the next 60 s
 * are summarised: average fps, 1 % low, slowest frame, plus the scene counters the budgets are
 * written against. The summary is printed to the console, shown on screen and left on
 * `window.__dragonfallBench` for the capture script (tools/capture/bench.mjs).
 *
 * The path is a function of bench time only, so two runs on the same build look at the same
 * things. Per frame this writes numbers into a ring buffer and places one camera; the strings
 * are built once, when the run ends.
 */
import type { PerspectiveCamera } from 'three';
import type { CameraDirector } from '../game/stage';
import type { GameRenderer } from '../render';
import type { Vec3 } from '../shared';
import { FrameStats, createFrameStatsSummary } from './frame-stats';

/** Seconds of match shown before measuring: the 3-2-1, shader warm-up, the first clash. */
export const BENCH_WARMUP_S = 10;
/** Frames longer than this are pauses (hidden tab), not frames: left out, and counted. */
const PAUSE_GAP_MS = 1000;
/** Room for 10 minutes at 240 Hz; longer runs keep the newest frames. */
const MAX_FRAMES = 144_000;

// The path: one lap round the arena centre per LAP_S, breathing in and out and up and down, always
// looking through the middle so the far side of the map, the centre fight and the sky are in view.
const LAP_S = 40;
const RADIUS_M = 420;
const RADIUS_SWING_M = 160;
const RADIUS_RATE = 0.19;
const HEIGHT_OFFSET_M = 70;
const HEIGHT_SWING_M = 90;
const HEIGHT_RATE = 0.13;
const BENCH_FOV = 62;

export interface BenchResult {
  readonly done: boolean;
  readonly seconds: number;
  readonly preset: string;
  readonly gpu: string;
  readonly canvas: string;
  readonly frames: number;
  readonly pauses: number;
  readonly avgFps: number;
  readonly onePercentLowFps: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly drawCallsMax: number;
  readonly drawCallsAvg: number;
  readonly trianglesMax: number;
  readonly renderScaleMin: number;
  readonly renderScaleAvg: number;
  /** Averaged host cost per frame of fixed-step work, ms. */
  readonly simMs: number;
  /** Most particles in one frame: the effects' own plus the map's vent streaks and ash. */
  readonly particlesPeak: number;
  readonly voicesPeak: number;
  readonly heapMb: number;
  /** One markdown table row for docs/PROGRESS.md. */
  readonly row: string;
}

export interface BenchOptions {
  readonly renderer: GameRenderer;
  /** Seconds to measure after the warm-up. */
  readonly seconds: number;
  /** The arena centre at fight height: the path circles it. */
  readonly focus: Readonly<Vec3>;
  /** True while a match is on screen (the clock only runs then). */
  readonly inMatch: () => boolean;
  readonly getSimMs: () => number;
  /** Peaks since the page loaded (read once, at the end). */
  readonly getPeaks: () => { readonly particles: number; readonly voices: number };
  /** Takes the camera for the run and gives it back at the end. */
  readonly setCameraDirector: (director: CameraDirector | null) => void;
  readonly parent?: HTMLElement;
}

export interface Bench {
  /** After the frame was drawn. `frameMs` is the frame driver's rAF-to-rAF interval. */
  frame(frameMs: number): void;
  readonly result: BenchResult | null;
  dispose(): void;
}

function readGpuName(gl: WebGL2RenderingContext | WebGLRenderingContext): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name: unknown = ext
    ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  return typeof name === 'string' ? name : 'unknown';
}

function readHeapMb(): number {
  const memory: unknown = Reflect.get(performance, 'memory');
  if (typeof memory !== 'object' || memory === null || !('usedJSHeapSize' in memory)) return -1;
  const used = memory.usedJSHeapSize;
  return typeof used === 'number' ? used / (1024 * 1024) : -1;
}

/** Where the bench camera is `t` seconds into the run. Pure; exported for the test. */
export function writeBenchPose(
  t: number,
  focus: Readonly<Vec3>,
  out: { x: number; y: number; z: number },
): void {
  const angle = (t / LAP_S) * Math.PI * 2;
  const radius = RADIUS_M + RADIUS_SWING_M * Math.sin(t * RADIUS_RATE);
  out.x = focus.x + Math.cos(angle) * radius;
  out.z = focus.z + Math.sin(angle) * radius;
  out.y = focus.y + HEIGHT_OFFSET_M + HEIGHT_SWING_M * Math.sin(t * HEIGHT_RATE);
}

export function createBench(options: BenchOptions): Bench {
  const { renderer, focus } = options;
  const info = renderer.webgl.info;
  const frames = new FrameStats(MAX_FRAMES);
  const pose = { x: 0, y: 0, z: 0 };

  /** Seconds of match shown so far (warm-up included). */
  let matchS = 0;
  let measuring = false;
  let measuredS = 0;
  let pauses = 0;
  let drawMax = 0;
  let drawSum = 0;
  let triMax = 0;
  let scaleMin = Infinity;
  let scaleSum = 0;
  let simSum = 0;
  let count = 0;
  let result: BenchResult | null = null;
  let disposed = false;

  const panel = document.createElement('pre');
  panel.className = 'df-bench';
  panel.style.cssText =
    'position:absolute;right:8px;bottom:8px;z-index:1000;margin:0;padding:6px 8px;' +
    'pointer-events:none;white-space:pre;font:12px/1.4 ui-monospace,Consolas,Menlo,monospace;' +
    'color:#fff6e8;background:rgba(20,24,36,0.8);';
  const text = document.createTextNode('bench: waiting for the match');
  panel.appendChild(text);
  (options.parent ?? document.getElementById('ui') ?? document.body).appendChild(panel);
  let shownSecond = -1;

  const director: CameraDirector = {
    direct(camera: PerspectiveCamera): boolean {
      writeBenchPose(matchS, focus, pose);
      camera.position.set(pose.x, pose.y, pose.z);
      camera.fov = BENCH_FOV;
      camera.lookAt(focus.x, focus.y, focus.z);
      return true;
    },
  };
  options.setCameraDirector(director);

  function finish(): void {
    const summary = frames.read(createFrameStatsSummary());
    const peaks = options.getPeaks();
    const canvas = renderer.webgl.domElement;
    const n = count > 0 ? count : 1;
    const base = {
      done: true,
      seconds: measuredS,
      preset: renderer.presetId,
      gpu: readGpuName(renderer.webgl.getContext()),
      canvas: `${canvas.width}x${canvas.height}`,
      frames: summary.count,
      pauses,
      avgFps: summary.fps,
      onePercentLowFps: summary.onePercentLowFps,
      avgMs: summary.avgMs,
      maxMs: summary.maxMs,
      drawCallsMax: drawMax,
      drawCallsAvg: drawSum / n,
      trianglesMax: triMax,
      renderScaleMin: scaleMin === Infinity ? renderer.resolution.scale : scaleMin,
      renderScaleAvg: scaleSum / n,
      simMs: simSum / n,
      particlesPeak: peaks.particles,
      voicesPeak: peaks.voices,
      heapMb: readHeapMb(),
    };
    const row =
      `| ${base.preset} | ${base.avgFps.toFixed(1)} | ${base.onePercentLowFps.toFixed(1)} | ` +
      `${base.maxMs.toFixed(1)} | ${base.drawCallsMax} | ${(base.trianglesMax / 1000).toFixed(1)}k | ` +
      `${base.renderScaleMin.toFixed(2)} | ${base.simMs.toFixed(3)} | ${base.particlesPeak} | ` +
      `${base.voicesPeak} |`;
    result = { ...base, row };
    Reflect.set(window, '__dragonfallBench', result);
    options.setCameraDirector(null);
    const lines =
      `bench done: ${base.preset}, ${base.seconds.toFixed(0)} s, ${base.frames} frames\n` +
      `fps avg ${base.avgFps.toFixed(1)}  1% low ${base.onePercentLowFps.toFixed(1)}` +
      `  max frame ${base.maxMs.toFixed(1)} ms\n` +
      `draw max ${base.drawCallsMax} (avg ${base.drawCallsAvg.toFixed(0)})` +
      `  tri max ${(base.trianglesMax / 1000).toFixed(1)}k\n` +
      `scale min ${base.renderScaleMin.toFixed(2)} avg ${base.renderScaleAvg.toFixed(2)}` +
      `  sim ${base.simMs.toFixed(3)} ms\n` +
      `particles peak ${base.particlesPeak}  voices peak ${base.voicesPeak}\n` +
      `gpu ${base.gpu}\n` +
      '| preset | fps | 1% low | max ms | draws | tris | scale min | sim ms | particles | voices |\n' +
      row;
    text.data = lines;
    console.info(`[bench]\n${lines}`);
  }

  return {
    frame(frameMs: number): void {
      if (disposed || result !== null || !options.inMatch()) return;
      if (frameMs >= PAUSE_GAP_MS) {
        if (measuring) pauses++;
        return;
      }
      const dtS = frameMs / 1000;
      matchS += dtS;
      if (!measuring) {
        if (matchS < BENCH_WARMUP_S) return;
        measuring = true;
      }
      measuredS += dtS;
      frames.push(frameMs);
      const calls = info.render.calls;
      const triangles = info.render.triangles;
      const scale = renderer.resolution.scale;
      if (calls > drawMax) drawMax = calls;
      if (triangles > triMax) triMax = triangles;
      if (scale < scaleMin) scaleMin = scale;
      drawSum += calls;
      scaleSum += scale;
      simSum += options.getSimMs();
      count++;
      const second = Math.floor(measuredS);
      if (second !== shownSecond) {
        // Once a second, not per frame.
        shownSecond = second;
        text.data = `bench: ${second} / ${options.seconds.toFixed(0)} s`;
      }
      if (measuredS >= options.seconds) finish();
    },

    get result() {
      return result;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (result === null) options.setCameraDirector(null);
      panel.remove();
    },
  };
}
