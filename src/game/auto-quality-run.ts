/**
 * The automatic quality pick's boot flow (docs/PERFORMANCE.md, "Automatic quality pick"): when
 * the test runs, what it does to the renderer and the settings, and the console line. The
 * measuring and deciding are in ./auto-quality.ts.
 *
 * WHEN. The test is wanted while the quality setting is Automatic and no automatic result is
 * saved: a first launch, after "Reset all", or after "Test again" in Settings (which clears the
 * result on purpose). It runs only while the title screen is idle: it starts behind the title
 * without blocking it, and the moment the player hosts, joins or flies solo it stops and the
 * page stays on the default preset. Still wanted, it runs the next time the title is idle.
 *
 * WHAT IT TOUCHES. The preset is never set here. The test saves "Automatic, no result" through
 * the settings (which puts the page on the default preset, where it measures) and at the end
 * saves the result the same way, so the renderer always follows the settings by the one path
 * every other change takes. During the test the renderer's cost probe holds the render scale
 * and loads the frame (src/render/gpu-cost-probe.ts).
 *
 * A manual choice always wins: picking a preset in Settings while the test runs stops it, and
 * afterwards the result only applies while the setting says Automatic.
 *
 * `frame` is called once per rendered frame and does not allocate. Everything from the browser
 * comes in through the options, so the flow is tested in node with fakes.
 */
import type { GameRenderer, RenderStats } from '../render';
import { isSoftwareRenderer } from '../render/gpu-info';
import { QUALITY_PRESETS } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';
import type { GameSettings } from '../shared/ui';
import {
  AUTO_QUALITY_PRESET,
  AUTO_QUALITY_SCALE,
  AutoQualityMeter,
  createAutoQualityMeasurement,
  decideQuality,
  repeatsForScene,
} from './auto-quality';
import type { AutoQualityDecision, AutoQualityMeasurement } from './auto-quality';
import { readAutoQualityLine, writeAutoQualityLine } from './stored-quality';

/** The part of `GameRenderer` the test uses (so a test can hand in a fake). */
export type AutoQualityRenderer = Pick<GameRenderer, 'presetId' | 'gpuName' | 'costProbe'> & {
  readonly stats: Pick<RenderStats, 'sceneWidth' | 'sceneHeight' | 'contextLost'>;
};

/**
 * What the test saves: always "Automatic", with its result or with none yet. A re-test that is
 * stopped half way leaves "no result", so it is still wanted and finishes the next time the
 * title screen is idle (also after a reload).
 */
export interface AutoQualityPatch {
  readonly quality: 'auto';
  readonly autoQuality: QualityPresetId | null;
}

export interface AutoQualityRunOptions {
  readonly renderer: AutoQualityRenderer;
  /**
   * '' = the test may run. Otherwise the reason it must not on this page (`?quality=`, `?bench`,
   * `?autopilot`, a browser driven by a script): it goes into the console line, and nothing
   * else happens.
   */
  readonly blocked: string;
  /** `?autoquality`: test as soon as the title is idle, even when a choice is saved. */
  readonly force: boolean;
  /** The title screen is showing and no room is being started or joined. */
  readonly titleIdle: () => boolean;
  /** The current settings (the store's own object: replaced, never mutated). */
  readonly settings: () => Pick<GameSettings, 'quality' | 'autoQuality'>;
  /** Saves the way a manual choice is saved (a `settings.update` intent). Must apply at once. */
  readonly save: (patch: AutoQualityPatch) => void;
  /** `document.visibilityState === 'visible'`. */
  readonly visible: () => boolean;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** `console.info`. */
  readonly log: (line: string) => void;
  /** localStorage, where the last line is kept for testers; null where there is none. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** A date for the kept line. Default: today, from the system clock. */
  readonly today?: () => string;
}

export type AutoQualityRunState =
  /** This page never tests (see `AutoQualityRunOptions.blocked`). */
  | 'blocked'
  /** Nothing to do: a choice or a result is saved. */
  | 'idle'
  /** A test is wanted and waits for an idle, visible title screen. */
  | 'waiting'
  | 'measuring'
  /** The test could not finish on this page load; the default preset stays. */
  | 'gaveUp';

/** For `window.__dragonfall` and bug reports. A fresh copy on every read: not per frame. */
export interface AutoQualityReport {
  readonly state: AutoQualityRunState;
  readonly gpu: string;
  /** The preset the last test on this page chose, or null. */
  readonly preset: QualityPresetId | null;
  /** The console line of the last test on this page ('' = none yet). */
  readonly line: string;
  /** The line kept from the last finished test on this computer, with its date ('' = none). */
  readonly savedLine: string;
  readonly measurement: Readonly<AutoQualityMeasurement> | null;
  readonly decision: AutoQualityDecision | null;
}

export interface AutoQualityRun {
  /** Once per rendered frame, after the frame was drawn. Allocation-free. */
  frame(): void;
  /** "Test again": forget the result and test the next time the title screen is idle. */
  requestRetest(): void;
  readonly report: AutoQualityReport;
  /** Lets go of the renderer's probe if a test is running. */
  dispose(): void;
}

/** The tester's own calendar day (not UTC), as 2026-11-11. */
function today(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function createAutoQualityRun(options: AutoQualityRunOptions): AutoQualityRun {
  const { renderer, titleIdle, settings, save, visible, now, log, storage } = options;
  const probe = renderer.costProbe;
  const stats = renderer.stats;
  const gpu = renderer.gpuName;
  const blocked = options.blocked !== '';
  const meter = new AutoQualityMeter();
  const measurement = createAutoQualityMeasurement();

  let measuring = false;
  let gaveUp = false;
  /** `?autoquality` or "Test again": test even though a choice or a result is saved. */
  let retest = options.force && !blocked;
  /** The automatic result in use when this test began: the decision leans towards keeping it. */
  let held: QualityPresetId | null = null;
  let repeats = 1;
  let lastNowMs = -1;
  let sceneWidth = 0;
  let sceneHeight = 0;

  let lastPreset: QualityPresetId | null = null;
  let lastLine = '';
  let lastDecision: AutoQualityDecision | null = null;
  let hasMeasurement = false;
  let savedLine = readAutoQualityLine(storage);

  function wanted(): boolean {
    if (retest) return true;
    const s = settings();
    return s.quality === 'auto' && s.autoQuality === null;
  }

  /** A result: saved like a manual choice, said once in the console, kept for testers. */
  function conclude(preset: QualityPresetId, detail: string): void {
    measuring = false;
    probe.stop();
    lastPreset = preset;
    lastLine = `[quality] auto pick: ${preset} | gpu ${gpu} | ${detail}`;
    save({ quality: 'auto', autoQuality: preset });
    // A save that did not take must not make the test run in a loop.
    if (settings().autoQuality !== preset) gaveUp = true;
    log(lastLine);
    savedLine = `${(options.today ?? today)()} ${lastLine}`;
    writeAutoQualityLine(storage, savedLine);
  }

  /** No result. `forGood`: do not try again on this page load. */
  function stop(reason: string, forGood: boolean): void {
    measuring = false;
    probe.stop();
    if (forGood) gaveUp = true;
    lastLine =
      `[quality] test flight ${forGood ? 'gave up' : 'stopped'}: ${reason}; ` +
      `staying on ${renderer.presetId} | gpu ${gpu}`;
    log(lastLine);
  }

  function start(): void {
    const s = settings();
    held = s.quality === 'auto' ? s.autoQuality : null;
    retest = false;
    hasMeasurement = false;
    lastDecision = null;
    if (isSoftwareRenderer(gpu)) {
      // Drawn on the CPU: nothing to measure, and the test itself would crawl.
      conclude('low', 'software renderer, not measured');
      return;
    }
    // "Automatic, no result" puts the page on the default preset through the settings' own
    // path. On a first launch that is where it already is and nothing is written.
    if (s.quality !== 'auto' || s.autoQuality !== null)
      save({ quality: 'auto', autoQuality: null });
    if (renderer.presetId !== AUTO_QUALITY_PRESET) {
      stop(`the page is not on ${QUALITY_PRESETS[AUTO_QUALITY_PRESET].label}`, true);
      return;
    }
    sceneWidth = stats.sceneWidth;
    sceneHeight = stats.sceneHeight;
    loadProbe();
    meter.begin(probe.supported);
    lastNowMs = -1;
    measuring = true;
  }

  /**
   * Holds the scale and sets the draws per frame for the scene size as it is now: a small
   * window gets more draws, so the GPU has the same load whatever the window.
   */
  function loadProbe(): void {
    // Without the timer there is nothing to load the frame for.
    repeats = probe.supported ? repeatsForScene(sceneWidth * sceneHeight) : 1;
    probe.start(AUTO_QUALITY_SCALE, repeats);
  }

  function finish(): void {
    meter.read(measurement);
    hasMeasurement = true;
    const decision = decideQuality(measurement, repeats, sceneWidth * sceneHeight, held);
    lastDecision = decision;
    const m = measurement;
    const frames = `frames ${m.frameMs.toFixed(1)} ms, ${m.seconds.toFixed(1)} s`;
    const was = held === null ? '' : ` | was ${held}`;
    if (m.method === 'gpu-timer') {
      conclude(
        decision.preset,
        `${decision.drawMs.toFixed(2)} ms per title draw at 1080p ` +
          `(high <= ${decision.highLimitMs.toFixed(2)}, low > ${decision.lowLimitMs.toFixed(2)}): ` +
          `${decision.reason} | measured ${m.costMs.toFixed(2)} ms GPU for ${repeats} draws at ` +
          `${AUTO_QUALITY_PRESET} ${AUTO_QUALITY_SCALE} ${sceneWidth}x${sceneHeight}, ` +
          `p95 ${m.costP95Ms.toFixed(2)}, ${m.samples} samples, ${frames}${was}`,
      );
    } else {
      conclude(
        decision.preset,
        `${decision.reason} (low > ${decision.lowLimitMs.toFixed(1)} ms) | ` +
          `${frames}, ${m.frames} frames, ${m.samples} GPU times${was}`,
      );
    }
  }

  function measure(): void {
    const s = settings();
    if (s.quality !== 'auto' || s.autoQuality !== null) {
      // The player picked a preset while the test ran: theirs stands, quietly.
      measuring = false;
      probe.stop();
      return;
    }
    if (!titleIdle()) {
      stop('a room was started', false);
      return;
    }
    if (renderer.presetId !== AUTO_QUALITY_PRESET) {
      stop('the preset was changed', true);
      return;
    }
    let state = meter.state;
    const width = stats.sceneWidth;
    const height = stats.sceneHeight;
    if (!visible() || stats.contextLost) {
      // A hidden or throttled tab draws nothing worth measuring: start over when it is back.
      state = meter.interrupt();
      lastNowMs = -1;
    } else if (width !== sceneWidth || height !== sceneHeight) {
      // The scene changed size (the window was resized, or the held scale just took effect):
      // the frames before and after are not the same load.
      sceneWidth = width;
      sceneHeight = height;
      loadProbe();
      state = meter.interrupt();
      lastNowMs = -1;
    } else {
      const nowMs = now();
      // Results in flight are taken even on a frame that is not counted.
      const costMs = probe.take();
      if (lastNowMs >= 0) state = meter.push(nowMs - lastNowMs, costMs);
      lastNowMs = nowMs;
    }
    if (state === 'done') finish();
    else if (state === 'tooSlow') conclude('low', 'the title runs below 4 fps, not measured');
    else if (state === 'failed') stop('interrupted too often to measure', true);
  }

  if (blocked) {
    log(`[quality] preset ${renderer.presetId}, not tested (${options.blocked}) | gpu ${gpu}`);
  } else if (!wanted()) {
    const how = settings().quality === 'auto' ? 'automatic pick, saved' : 'chosen in Settings';
    log(`[quality] preset ${renderer.presetId} (${how}) | gpu ${gpu}`);
  }

  return {
    frame(): void {
      if (blocked) return;
      if (measuring) {
        measure();
        return;
      }
      if (gaveUp || !wanted()) return;
      if (!titleIdle() || !visible() || stats.contextLost) return;
      start();
    },

    requestRetest(): void {
      if (blocked || measuring) return;
      retest = true;
      gaveUp = false;
    },

    get report(): AutoQualityReport {
      return {
        state: blocked
          ? 'blocked'
          : measuring
            ? 'measuring'
            : gaveUp
              ? 'gaveUp'
              : wanted()
                ? 'waiting'
                : 'idle',
        gpu,
        preset: lastPreset,
        line: lastLine,
        savedLine,
        measurement: hasMeasurement ? { ...measurement } : null,
        decision: lastDecision,
      };
    },

    dispose(): void {
      if (!measuring) return;
      measuring = false;
      probe.stop();
    },
  };
}
