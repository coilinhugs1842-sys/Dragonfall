import { describe, expect, it } from 'vitest';
import { AUTO_QUALITY_SCALE, AUTO_QUALITY_TUNING } from '../../src/game/auto-quality';
import { createAutoQualityRun } from '../../src/game/auto-quality-run';
import type { AutoQualityPatch, AutoQualityRun } from '../../src/game/auto-quality-run';
import { AUTO_QUALITY_LINE_KEY } from '../../src/game/stored-quality';
import type { QualityPresetId } from '../../src/shared/quality';
import { effectiveQuality } from '../../src/shared/ui';
import type { QualityChoice } from '../../src/shared/ui';

const INTEL = 'ANGLE (Intel, Intel(R) Graphics (0x00007D45) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFTSHADER =
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';

interface World {
  run: AutoQualityRun;
  /** Console lines. */
  readonly lines: string[];
  /** Everything the test saved, in order. */
  readonly saves: AutoQualityPatch[];
  readonly storage: Map<string, string>;
  /** `probe.start` calls as "scale x repeats". */
  readonly starts: string[];
  settings: { quality: QualityChoice; autoQuality: QualityPresetId | null };
  preset: QualityPresetId;
  probeActive: boolean;
  titleIdle: boolean;
  visible: boolean;
  contextLost: boolean;
  sceneWidth: number;
  sceneHeight: number;
  /** GPU ms of one test frame (all repeats). */
  costMs: number;
  frameMs: number;
  /** Rendered frames: advances the clock and calls `run.frame()`. */
  frames(count: number): void;
  /** Runs frames until the test is no longer measuring (or `max` frames). */
  untilSettled(max?: number): number;
}

interface WorldOptions {
  readonly gpu?: string;
  readonly blocked?: string;
  readonly force?: boolean;
  readonly timer?: boolean;
  readonly quality?: QualityChoice;
  readonly autoQuality?: QualityPresetId | null;
  /** false: saving changes the settings but the renderer keeps its preset (`?quality=`). */
  readonly presetFollows?: boolean;
  readonly titleIdle?: boolean;
}

function createWorld(options: WorldOptions = {}): World {
  const lines: string[] = [];
  const saves: AutoQualityPatch[] = [];
  const starts: string[] = [];
  const storage = new Map<string, string>();
  let nowMs = 1000;
  const quality = options.quality ?? 'auto';
  const autoQuality = options.autoQuality ?? null;

  const world: World = {
    run: undefined as unknown as AutoQualityRun,
    lines,
    saves,
    storage,
    starts,
    settings: { quality, autoQuality },
    preset: effectiveQuality(quality, autoQuality),
    probeActive: false,
    titleIdle: options.titleIdle ?? true,
    visible: true,
    contextLost: false,
    sceneWidth: 1632,
    sceneHeight: 918,
    costMs: 11.2,
    frameMs: 1000 / 60,
    frames(count: number): void {
      for (let i = 0; i < count; i++) {
        nowMs += world.frameMs;
        world.run.frame();
      }
    },
    untilSettled(max = 5000): number {
      let count = 0;
      do {
        world.frames(1);
        count++;
      } while (world.run.report.state === 'measuring' && count < max);
      return count;
    },
  };

  const probe = {
    supported: options.timer ?? true,
    get active(): boolean {
      return world.probeActive;
    },
    scale: 1,
    repeats: 1,
    start(scale: number, repeats: number): void {
      probe.scale = scale;
      probe.repeats = repeats;
      world.probeActive = true;
      starts.push(`${scale} x ${repeats}`);
    },
    stop(): void {
      world.probeActive = false;
    },
    take(): number {
      return probe.supported && world.probeActive ? world.costMs : -1;
    },
  };

  world.run = createAutoQualityRun({
    renderer: {
      get presetId(): QualityPresetId {
        return world.preset;
      },
      gpuName: options.gpu ?? INTEL,
      costProbe: probe,
      stats: {
        get sceneWidth(): number {
          return world.sceneWidth;
        },
        get sceneHeight(): number {
          return world.sceneHeight;
        },
        get contextLost(): boolean {
          return world.contextLost;
        },
      },
    },
    blocked: options.blocked ?? '',
    force: options.force ?? false,
    titleIdle: () => world.titleIdle,
    settings: () => world.settings,
    save: (patch) => {
      saves.push(patch);
      // What the settings store does: a new object, and the renderer follows at once.
      world.settings = { ...world.settings, ...patch };
      if (options.presetFollows !== false) {
        world.preset = effectiveQuality(world.settings.quality, world.settings.autoQuality);
      }
    },
    visible: () => world.visible,
    now: () => nowMs,
    log: (line) => {
      lines.push(line);
    },
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
    },
    today: () => '2026-11-11',
  });
  return world;
}

describe('the automatic quality pick on a first launch', () => {
  it('measures behind the title, saves the result and says one line', () => {
    const w = createWorld();
    expect(w.lines).toEqual([]);
    expect(w.run.report.state).toBe('waiting');

    w.frames(1);
    expect(w.run.report.state).toBe('measuring');
    expect(w.starts).toEqual([`${AUTO_QUALITY_SCALE} x ${AUTO_QUALITY_TUNING.repeats}`]);
    // Nothing is written to start a first-launch test: the page is already on the default.
    expect(w.saves).toEqual([]);

    const frames = w.untilSettled();
    // Half a second of warm-up and three seconds measured, at 60 Hz.
    expect(frames).toBeGreaterThanOrEqual(210);
    expect(frames).toBeLessThan(220);
    expect(w.probeActive).toBe(false);
    expect(w.saves).toEqual([{ quality: 'auto', autoQuality: 'medium' }]);
    expect(w.settings).toEqual({ quality: 'auto', autoQuality: 'medium' });
    expect(w.preset).toBe('medium');

    expect(w.lines).toHaveLength(1);
    const line = w.lines[0] ?? '';
    expect(line.startsWith(`[quality] auto pick: medium | gpu ${INTEL} | `)).toBe(true);
    expect(line).toContain('1.40 ms per title draw at 1080p');
    expect(line).toContain('(high <= 0.68, low > 2.20)');
    expect(line).toContain('inside the Medium range');
    expect(line).toContain('ms GPU for 8 draws at medium 0.85 1632x918');
    expect(line).toContain('frames 16.7 ms');
    expect(line).not.toContain('was ');
  });

  it('does not run again once it has a result', () => {
    const w = createWorld();
    w.untilSettled();
    w.frames(2000);
    expect(w.lines).toHaveLength(1);
    expect(w.starts).toHaveLength(1);
    expect(w.run.report.state).toBe('idle');
  });

  it('keeps the line, with the date, for a tester to copy later', () => {
    const w = createWorld();
    w.untilSettled();
    const kept = w.storage.get(AUTO_QUALITY_LINE_KEY) ?? '';
    expect(kept).toBe(`2026-11-11 ${w.lines[0] ?? ''}`);
    const report = w.run.report;
    expect(report.savedLine).toBe(kept);
    expect(report.line).toBe(w.lines[0]);
    expect(report.preset).toBe('medium');
    expect(report.gpu).toBe(INTEL);
    expect(report.measurement?.method).toBe('gpu-timer');
    expect(report.decision?.preset).toBe('medium');
  });

  it('picks High on a fast machine and Low on a slow one', () => {
    const fast = createWorld();
    fast.costMs = 3;
    fast.untilSettled();
    expect(fast.settings).toEqual({ quality: 'auto', autoQuality: 'high' });
    expect(fast.preset).toBe('high');
    expect(fast.lines[0]).toContain('auto pick: high');

    const slow = createWorld();
    slow.costMs = 26;
    slow.frameMs = 1000 / 30;
    slow.untilSettled();
    expect(slow.settings).toEqual({ quality: 'auto', autoQuality: 'low' });
    expect(slow.preset).toBe('low');
    expect(slow.lines[0]).toContain('too slow for Medium');
  });

  it('draws more often in a small window, so the load and the pick are the same', () => {
    const w = createWorld();
    // A quarter of the reference pixels: four times the draws push the same pixels per frame,
    // and the same machine takes the same time over them.
    w.sceneWidth = 816;
    w.sceneHeight = 459;
    w.costMs = 11.2;
    w.untilSettled();
    expect(w.starts).toEqual([`${AUTO_QUALITY_SCALE} x 32`]);
    expect(w.settings.autoQuality).toBe('medium');
    expect(w.lines[0]).toContain('for 32 draws at medium 0.85 816x459');
    expect(w.lines[0]).toContain('1.40 ms per title draw at 1080p');
  });

  it('keeps the eight draws in a window with more pixels than the reference', () => {
    const w = createWorld();
    w.sceneWidth = 2176;
    w.sceneHeight = 918;
    w.costMs = 11.2 * (2176 / 1632);
    w.untilSettled();
    expect(w.starts).toEqual([`${AUTO_QUALITY_SCALE} x 8`]);
    // More to draw per frame, in the test as in a match: the reading is not scaled down.
    expect(w.lines[0]).toContain('1.87 ms per title draw at 1080p');
  });
});

describe('when the test does not run', () => {
  it('leaves a saved choice alone and only names the GPU', () => {
    const w = createWorld({ quality: 'high' });
    expect(w.lines).toEqual([`[quality] preset high (chosen in Settings) | gpu ${INTEL}`]);
    w.frames(600);
    expect(w.starts).toEqual([]);
    expect(w.saves).toEqual([]);
    expect(w.lines).toHaveLength(1);
    expect(w.run.report.state).toBe('idle');
  });

  it('leaves a saved automatic result alone', () => {
    const w = createWorld({ quality: 'auto', autoQuality: 'low' });
    expect(w.lines).toEqual([`[quality] preset low (automatic pick, saved) | gpu ${INTEL}`]);
    w.frames(600);
    expect(w.starts).toEqual([]);
    expect(w.preset).toBe('low');
  });

  it.each(['forced by ?quality=', '?bench', '?autopilot', 'automated browser'])(
    'never runs when blocked (%s), even with ?autoquality and no saved choice',
    (reason) => {
      const w = createWorld({ blocked: reason, force: true });
      expect(w.lines).toEqual([`[quality] preset medium, not tested (${reason}) | gpu ${INTEL}`]);
      w.frames(600);
      w.run.requestRetest();
      w.frames(600);
      expect(w.starts).toEqual([]);
      expect(w.saves).toEqual([]);
      expect(w.lines).toHaveLength(1);
      expect(w.run.report.state).toBe('blocked');
    },
  );

  it('waits while the title is not idle, and while the tab is hidden', () => {
    const w = createWorld({ titleIdle: false });
    w.frames(300);
    expect(w.starts).toEqual([]);
    w.titleIdle = true;
    w.visible = false;
    w.frames(300);
    expect(w.starts).toEqual([]);
    expect(w.run.report.state).toBe('waiting');
    w.visible = true;
    w.frames(1);
    expect(w.starts).toHaveLength(1);
  });

  it('waits while the WebGL context is lost', () => {
    const w = createWorld();
    w.contextLost = true;
    w.frames(100);
    expect(w.starts).toEqual([]);
    w.contextLost = false;
    w.frames(1);
    expect(w.starts).toHaveLength(1);
  });
});

describe('a test that is disturbed', () => {
  it('stops when the player starts or joins a room, and keeps the default', () => {
    const w = createWorld();
    w.costMs = 3;
    w.frames(100);
    expect(w.probeActive).toBe(true);
    w.titleIdle = false;
    w.frames(1);
    expect(w.probeActive).toBe(false);
    expect(w.saves).toEqual([]);
    expect(w.preset).toBe('medium');
    expect(w.lines).toEqual([
      `[quality] test flight stopped: a room was started; staying on medium | gpu ${INTEL}`,
    ]);
    // A whole match later nothing has been measured.
    w.frames(5000);
    expect(w.starts).toHaveLength(1);
    expect(w.settings.autoQuality).toBeNull();

    // Back on the title screen the test runs from the start.
    w.titleIdle = true;
    const frames = w.untilSettled();
    expect(frames).toBeGreaterThanOrEqual(210);
    expect(w.starts).toHaveLength(2);
    expect(w.settings.autoQuality).toBe('high');
    expect(w.lines).toHaveLength(2);
  });

  it('gives no result while the tab is hidden and starts over when it is back', () => {
    const w = createWorld();
    // The first second is drawn while the browser is already slowing the page down.
    w.costMs = 40;
    w.frames(90);
    w.visible = false;
    w.frames(500);
    expect(w.run.report.state).toBe('measuring');
    expect(w.saves).toEqual([]);
    expect(w.lines).toEqual([]);

    w.visible = true;
    w.costMs = 11.2;
    const frames = w.untilSettled();
    // A whole new warm-up and three seconds: nothing from before the absence counts.
    expect(frames).toBeGreaterThanOrEqual(210);
    expect(w.settings.autoQuality).toBe('medium');
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain('1.40 ms per title draw');
    expect(w.starts).toHaveLength(1);
  });

  it('does not take the long first frame after a hidden tab for a slow machine', () => {
    const w = createWorld();
    w.frames(120);
    w.visible = false;
    w.frames(1);
    w.visible = true;
    // Half a minute passed on the clock while no frames ran.
    w.frameMs = 30_000;
    w.frames(1);
    w.frameMs = 1000 / 60;
    w.untilSettled();
    expect(w.settings.autoQuality).toBe('medium');
    expect(w.run.report.measurement?.frameMs).toBeCloseTo(1000 / 60, 3);
  });

  it('starts over when the frames simply stopped for a while (the frame driver of a hidden tab)', () => {
    const w = createWorld();
    w.costMs = 40;
    w.frames(120);
    // No frame at all for a minute, then the page is visible again.
    w.frameMs = 60_000;
    w.frames(1);
    expect(w.run.report.state).toBe('measuring');
    w.frameMs = 1000 / 60;
    w.costMs = 11.2;
    const frames = w.untilSettled();
    expect(frames).toBeGreaterThanOrEqual(210);
    expect(w.settings.autoQuality).toBe('medium');
    expect(w.lines[0]).toContain('1.40 ms per title draw');
  });

  it('starts over when the window is resized', () => {
    const w = createWorld();
    w.costMs = 40;
    w.frames(120);
    w.sceneWidth = 1280;
    w.sceneHeight = 720;
    // The smaller scene gets 13 draws instead of 8; each costs its share of the pixels.
    w.costMs = 13 * 1.4 * ((1280 * 720) / (1632 * 918));
    const frames = w.untilSettled();
    expect(frames).toBeGreaterThanOrEqual(210);
    expect(w.starts).toEqual([`${AUTO_QUALITY_SCALE} x 8`, `${AUTO_QUALITY_SCALE} x 13`]);
    expect(w.settings.autoQuality).toBe('medium');
    expect(w.lines[0]).toContain('for 13 draws at medium 0.85 1280x720');
    expect(w.lines[0]).toContain('1.40 ms per title draw');
  });

  it('starts over while the context is lost', () => {
    const w = createWorld();
    w.frames(120);
    w.contextLost = true;
    w.frames(30);
    w.contextLost = false;
    const frames = w.untilSettled();
    expect(frames).toBeGreaterThanOrEqual(210);
    expect(w.settings.autoQuality).toBe('medium');
  });

  it('stops quietly when the player picks a preset by hand', () => {
    const w = createWorld();
    w.frames(100);
    // The Settings menu: the store replaces its object and the renderer follows.
    w.settings = { quality: 'low', autoQuality: null };
    w.preset = 'low';
    w.frames(1);
    expect(w.probeActive).toBe(false);
    w.frames(1000);
    expect(w.saves).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(w.settings).toEqual({ quality: 'low', autoQuality: null });
    expect(w.run.report.state).toBe('idle');
  });

  it('gives up for this page load after too many interruptions', () => {
    const w = createWorld();
    w.frames(1);
    for (let i = 0; i <= AUTO_QUALITY_TUNING.maxRestarts; i++) {
      w.frames(20);
      w.visible = false;
      w.frames(1);
      w.visible = true;
    }
    w.frames(1);
    expect(w.run.report.state).toBe('gaveUp');
    expect(w.probeActive).toBe(false);
    expect(w.saves).toEqual([]);
    expect(w.lines).toEqual([
      `[quality] test flight gave up: interrupted too often to measure; staying on medium | gpu ${INTEL}`,
    ]);
    w.frames(2000);
    expect(w.starts).toHaveLength(1);
  });

  it('lets go of the renderer when disposed in the middle', () => {
    const w = createWorld();
    w.frames(50);
    expect(w.probeActive).toBe(true);
    w.run.dispose();
    expect(w.probeActive).toBe(false);
  });
});

describe('a software renderer', () => {
  it('gets Low at once, unmeasured, and the line says why', () => {
    const w = createWorld({ gpu: SWIFTSHADER });
    w.frames(1);
    expect(w.starts).toEqual([]);
    expect(w.saves).toEqual([{ quality: 'auto', autoQuality: 'low' }]);
    expect(w.preset).toBe('low');
    expect(w.lines).toEqual([
      `[quality] auto pick: low | gpu ${SWIFTSHADER} | software renderer, not measured`,
    ]);
    w.frames(600);
    expect(w.lines).toHaveLength(1);
  });

  it.each([
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ])('knows %s', (gpu) => {
    const w = createWorld({ gpu });
    w.frames(1);
    expect(w.settings).toEqual({ quality: 'auto', autoQuality: 'low' });
  });
});

describe('a browser without the GPU timer', () => {
  it('draws the title once per frame and picks Medium', () => {
    const w = createWorld({ timer: false });
    w.frames(1);
    expect(w.starts).toEqual([`${AUTO_QUALITY_SCALE} x 1`]);
    w.untilSettled();
    expect(w.settings.autoQuality).toBe('medium');
    expect(w.lines[0]).toContain('auto pick: medium');
    expect(w.lines[0]).toContain('no GPU timer; frame time cannot show headroom');
  });

  it('picks Low when the title itself is slow', () => {
    const w = createWorld({ timer: false });
    w.frameMs = 60;
    w.untilSettled();
    expect(w.settings.autoQuality).toBe('low');
    expect(w.lines[0]).toContain('no GPU timer; the title runs below 25 fps');
  });
});

describe('testing again', () => {
  it('"Test again" forgets the result, measures on Medium and leans towards what it had', () => {
    const w = createWorld({ quality: 'auto', autoQuality: 'high' });
    expect(w.preset).toBe('high');
    // 5 % inside the High limit: not enough to move up to High, enough to stay on it.
    w.costMs = AUTO_QUALITY_TUNING.highMaxDrawMs * 0.95 * AUTO_QUALITY_TUNING.repeats;
    w.run.requestRetest();
    w.frames(1);
    expect(w.saves).toEqual([{ quality: 'auto', autoQuality: null }]);
    // The test runs on Medium, reached through the settings.
    expect(w.preset).toBe('medium');
    expect(w.probeActive).toBe(true);
    w.untilSettled();
    expect(w.settings).toEqual({ quality: 'auto', autoQuality: 'high' });
    expect(w.preset).toBe('high');
    expect(w.lines.at(-1)).toContain('auto pick: high');
    expect(w.lines.at(-1)).toContain('| was high');
  });

  it('the same reading on a first launch stays on Medium', () => {
    const w = createWorld();
    w.costMs = AUTO_QUALITY_TUNING.highMaxDrawMs * 0.95 * AUTO_QUALITY_TUNING.repeats;
    w.untilSettled();
    expect(w.settings.autoQuality).toBe('medium');
  });

  it('"Test again" also replaces a preset chosen by hand', () => {
    const w = createWorld({ quality: 'low' });
    w.costMs = 3;
    w.run.requestRetest();
    w.untilSettled();
    expect(w.saves).toEqual([
      { quality: 'auto', autoQuality: null },
      { quality: 'auto', autoQuality: 'high' },
    ]);
    expect(w.preset).toBe('high');
    // A hand-picked preset is not an earlier measurement: nothing to lean towards.
    expect(w.lines.at(-1)).not.toContain('was ');
  });

  it('"Test again" during a match waits for the title screen', () => {
    const w = createWorld({ quality: 'auto', autoQuality: 'medium', titleIdle: false });
    w.run.requestRetest();
    w.frames(600);
    expect(w.saves).toEqual([]);
    expect(w.preset).toBe('medium');
    expect(w.run.report.state).toBe('waiting');
    w.titleIdle = true;
    w.untilSettled();
    expect(w.saves).toHaveLength(2);
    expect(w.settings.autoQuality).toBe('medium');
  });

  it('?autoquality tests once even though a choice is saved', () => {
    const w = createWorld({ quality: 'high', force: true });
    // No "preset high (chosen in Settings)" line: the test's own line follows.
    expect(w.lines).toEqual([]);
    w.costMs = 26;
    w.untilSettled();
    expect(w.settings).toEqual({ quality: 'auto', autoQuality: 'low' });
    expect(w.lines).toHaveLength(1);
    w.frames(1000);
    expect(w.starts).toHaveLength(1);
  });

  it('a re-test stopped by a room finishes the next time the title is idle', () => {
    const w = createWorld({ quality: 'auto', autoQuality: 'low' });
    w.run.requestRetest();
    w.frames(60);
    w.titleIdle = false;
    w.frames(60);
    expect(w.settings).toEqual({ quality: 'auto', autoQuality: null });
    expect(w.preset).toBe('medium');
    w.titleIdle = true;
    w.untilSettled();
    expect(w.settings.autoQuality).toBe('medium');
  });

  it('"Test again" is ignored while a test is running', () => {
    const w = createWorld();
    w.frames(50);
    w.run.requestRetest();
    w.untilSettled();
    w.frames(600);
    expect(w.starts).toHaveLength(1);
    expect(w.lines).toHaveLength(1);
  });

  it('"Test again" tries once more after the test gave up', () => {
    // The renderer does not follow the settings (it cannot happen through the real settings
    // path without `?quality=`, which blocks the test: this is the guard for the unexpected).
    const w = createWorld({ quality: 'high', presetFollows: false, force: true });
    w.frames(1);
    expect(w.run.report.state).toBe('gaveUp');
    expect(w.lines).toEqual([
      `[quality] test flight gave up: the page is not on Medium; staying on high | gpu ${INTEL}`,
    ]);
    w.frames(600);
    expect(w.starts).toEqual([]);
    w.preset = 'medium';
    w.run.requestRetest();
    w.untilSettled();
    expect(w.settings.autoQuality).toBe('medium');
  });

  it('does not loop when the result cannot be saved', () => {
    const w = createWorld();
    const run = createAutoQualityRun({
      renderer: {
        presetId: 'medium',
        gpuName: SWIFTSHADER,
        costProbe: {
          supported: true,
          active: false,
          scale: 1,
          repeats: 1,
          start: () => undefined,
          stop: () => undefined,
          take: () => -1,
        },
        stats: { sceneWidth: 1632, sceneHeight: 918, contextLost: false },
      },
      blocked: '',
      force: false,
      titleIdle: () => true,
      settings: () => ({ quality: 'auto', autoQuality: null }),
      save: () => undefined,
      visible: () => true,
      now: () => 0,
      log: (line) => {
        w.lines.push(line);
      },
      storage: null,
    });
    for (let i = 0; i < 100; i++) run.frame();
    expect(w.lines).toHaveLength(1);
    expect(run.report.state).toBe('gaveUp');
  });
});
