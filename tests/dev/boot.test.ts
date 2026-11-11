import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDevTools } from '../../src/dev/boot';
import type { DevToolsOptions } from '../../src/dev/boot';
import type { DebugGui } from '../../src/dev/debug-gui';
import type { PerfHud } from '../../src/dev/perf-hud';

/** What the two dev chunks do in the current test. The real modules need a DOM and WebGL. */
const chunks = vi.hoisted(() => ({
  perfHud: null as PerfHud | null,
  debugGui: null as DebugGui | null,
  perfHudLoads: 0,
  debugGuiLoads: 0,
}));

vi.mock('../../src/dev/perf-hud', () => ({
  createPerfHud: async (): Promise<PerfHud> => {
    chunks.perfHudLoads++;
    if (chunks.perfHud === null) throw new Error('perf-hud chunk failed');
    return chunks.perfHud;
  },
}));

vi.mock('../../src/dev/debug-gui', () => ({
  createDebugGui: (): DebugGui => {
    chunks.debugGuiLoads++;
    if (chunks.debugGui === null) throw new Error('debug-gui chunk failed');
    return chunks.debugGui;
  },
}));

// The mocked factories ignore their options, so the test needs no renderer.
const OPTIONS = {} as DevToolsOptions;

function fakePerfHud(): PerfHud {
  return { begin: vi.fn(), end: vi.fn(), dispose: vi.fn() };
}

function fakeDebugGui(): DebugGui {
  // Only `dispose` is reached through DevTools.
  return { dispose: vi.fn() } as unknown as DebugGui;
}

describe('loadDevTools', () => {
  afterEach(() => {
    chunks.perfHud = null;
    chunks.debugGui = null;
    chunks.perfHudLoads = 0;
    chunks.debugGuiLoads = 0;
    vi.restoreAllMocks();
  });

  it('loads nothing without a flag', async () => {
    const tools = await loadDevTools({ perf: false, debug: false }, OPTIONS);
    expect(tools.perfHud).toBeNull();
    expect(tools.debugGui).toBeNull();
    expect(chunks.perfHudLoads + chunks.debugGuiLoads).toBe(0);
    tools.dispose();
  });

  it('loads only the tool whose flag is set', async () => {
    chunks.perfHud = fakePerfHud();
    const tools = await loadDevTools({ perf: true, debug: false }, OPTIONS);
    expect(tools.perfHud).toBe(chunks.perfHud);
    expect(tools.debugGui).toBeNull();
    expect(chunks.debugGuiLoads).toBe(0);
  });

  it('disposes both tools', async () => {
    const perfHud = (chunks.perfHud = fakePerfHud());
    const debugGui = (chunks.debugGui = fakeDebugGui());
    const tools = await loadDevTools({ perf: true, debug: true }, OPTIONS);
    tools.dispose();
    expect(perfHud.dispose).toHaveBeenCalledTimes(1);
    expect(debugGui.dispose).toHaveBeenCalledTimes(1);
  });

  it('still hands over the perf HUD when the debug GUI fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const perfHud = (chunks.perfHud = fakePerfHud());
    const tools = await loadDevTools({ perf: true, debug: true }, OPTIONS);
    // The HUD is already mounted by now: it must reach the caller so it is driven and disposable.
    expect(tools.perfHud).toBe(perfHud);
    expect(tools.debugGui).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    tools.dispose();
    expect(perfHud.dispose).toHaveBeenCalledTimes(1);
  });

  it('still hands over the debug GUI when the perf HUD fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debugGui = (chunks.debugGui = fakeDebugGui());
    const tools = await loadDevTools({ perf: true, debug: true }, OPTIONS);
    expect(tools.perfHud).toBeNull();
    expect(tools.debugGui).toBe(debugGui);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
