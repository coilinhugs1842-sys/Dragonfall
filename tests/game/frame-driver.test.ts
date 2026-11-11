import { describe, expect, it } from 'vitest';
import { FrameDriver } from '../../src/game/frame-driver';
import type { FrameHost } from '../../src/game/frame-driver';
import { FixedStepLoop } from '../../src/sim';

/** Hand-cranked stand-in for the browser: the test decides when frames fire and what time it is. */
class FakeHost implements FrameHost {
  hidden = false;
  clock = 0;
  cancelled = 0;
  private nextHandle = 1;
  private pending = new Map<number, (timeMs: number) => void>();
  private visibilityListeners = new Set<() => void>();

  requestFrame(callback: (timeMs: number) => void): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    if (this.pending.delete(handle)) this.cancelled++;
  }

  now(): number {
    return this.clock;
  }

  isHidden(): boolean {
    return this.hidden;
  }

  onVisibilityChange(listener: () => void): () => void {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  timers = new Map<number, () => void>();

  startTimer(callback: () => void, _intervalMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, callback);
    return handle;
  }

  stopTimer(handle: number): void {
    this.timers.delete(handle);
  }

  /** Fires every running timer once. */
  timerBeat(): void {
    for (const callback of [...this.timers.values()]) callback();
  }

  get pendingFrames(): number {
    return this.pending.size;
  }

  get listenerCount(): number {
    return this.visibilityListeners.size;
  }

  /** Fires the queued frame callbacks with the given rAF timestamp. */
  frame(timeMs: number): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback(timeMs);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of [...this.visibilityListeners]) listener();
  }
}

interface Rig {
  host: FakeHost;
  loop: FixedStepLoop;
  driver: FrameDriver;
  ticks: number[];
  renders: { alpha: number; frameMs: number }[];
}

function createRig(onStep?: (host: FakeHost) => void): Rig {
  const host = new FakeHost();
  const ticks: number[] = [];
  const renders: { alpha: number; frameMs: number }[] = [];
  const loop = new FixedStepLoop(10, (tick) => {
    ticks.push(tick);
    onStep?.(host);
  });
  const driver = new FrameDriver({
    loop,
    host,
    render: (alpha, frameMs) => renders.push({ alpha, frameMs }),
  });
  return { host, loop, driver, ticks, renders };
}

describe('FrameDriver', () => {
  it('does nothing until started', () => {
    const { host, driver } = createRig();
    expect(driver.running).toBe(false);
    expect(host.pendingFrames).toBe(0);
    expect(host.listenerCount).toBe(0);
  });

  it('renders the first frame without simulating, then steps by elapsed time', () => {
    const { host, driver, ticks, renders } = createRig();
    driver.start();

    // rAF timestamps start at an arbitrary large value; none of it may be simulated.
    host.frame(50_000);
    expect(ticks).toEqual([]);
    expect(renders).toHaveLength(1);
    expect(renders[0]?.alpha).toBe(0);

    host.frame(50_016);
    expect(ticks).toEqual([0]);
    expect(renders[1]?.alpha).toBeCloseTo(0.6, 9);
    expect(renders[1]?.frameMs).toBe(16);

    host.frame(50_032);
    expect(ticks).toEqual([0, 1, 2]);
    expect(renders[2]?.alpha).toBeCloseTo(0.2, 9);
  });

  it('renders exactly once per frame and keeps one frame queued', () => {
    const { host, driver, renders } = createRig();
    driver.start();
    for (let i = 0; i < 10; i++) {
      host.frame(1000 + i * 16);
      expect(host.pendingFrames).toBe(1);
    }
    expect(renders).toHaveLength(10);
  });

  it('start() twice does not double the frame rate', () => {
    const { host, driver, renders } = createRig();
    driver.start();
    driver.start();
    expect(host.pendingFrames).toBe(1);
    expect(host.listenerCount).toBe(1);
    host.frame(0);
    expect(renders).toHaveLength(1);
  });

  it('does not fast-forward after the tab was hidden', () => {
    const { host, driver, ticks, renders } = createRig();
    driver.start();
    host.frame(1000);
    host.frame(1016);
    expect(ticks).toEqual([0]);

    host.setHidden(true);
    expect(driver.paused).toBe(true);
    expect(host.pendingFrames).toBe(0);

    // Ten minutes later.
    host.setHidden(false);
    expect(driver.paused).toBe(false);
    host.frame(601_016);
    expect(ticks).toEqual([0]);
    // The unmeasured frame reports the last real frame time, not the gap and not zero.
    expect(renders.at(-1)).toEqual({ alpha: 0, frameMs: 16 });

    host.frame(601_032);
    expect(ticks).toEqual([0, 1]);
  });

  it('does not schedule when started in a hidden tab, and begins on reveal', () => {
    const { host, driver, renders } = createRig();
    host.hidden = true;
    driver.start();
    expect(driver.running).toBe(true);
    expect(driver.paused).toBe(true);
    expect(host.pendingFrames).toBe(0);

    host.setHidden(false);
    expect(host.pendingFrames).toBe(1);
    host.frame(5);
    expect(renders).toHaveLength(1);
  });

  it('ignores repeated visibility events', () => {
    const { host, driver } = createRig();
    driver.start();
    host.setHidden(false);
    host.setHidden(false);
    expect(host.pendingFrames).toBe(1);
    host.setHidden(true);
    host.setHidden(true);
    expect(host.pendingFrames).toBe(0);
  });

  it('stop() cancels the frame, drops the listener and can be restarted cleanly', () => {
    const { host, driver, ticks, renders } = createRig();
    driver.start();
    host.frame(0);
    host.frame(16);

    driver.stop();
    expect(driver.running).toBe(false);
    expect(host.pendingFrames).toBe(0);
    expect(host.listenerCount).toBe(0);
    host.setHidden(false);
    expect(host.pendingFrames).toBe(0);

    const rendersBefore = renders.length;
    const ticksBefore = ticks.length;
    driver.start();
    host.frame(90_000);
    expect(renders).toHaveLength(rendersBefore + 1);
    expect(ticks).toHaveLength(ticksBefore);
  });

  it('survives a clock that goes backwards', () => {
    const { host, driver, ticks, renders } = createRig();
    driver.start();
    host.frame(1000);
    host.frame(900);
    expect(ticks).toEqual([]);
    expect(renders).toHaveLength(2);
    host.frame(920);
    expect(ticks).toEqual([0, 1]);
  });

  it('lets the loop clamp one long frame while the tab stayed visible', () => {
    const { host, driver, ticks, loop } = createRig();
    driver.start();
    host.frame(0);
    host.frame(5000);
    expect(ticks).toHaveLength(5);
    expect(loop.droppedMs).toBe(4950);
  });

  it('keeps running after the render callback throws', () => {
    const host = new FakeHost();
    const loop = new FixedStepLoop(10, () => {});
    let frames = 0;
    const driver = new FrameDriver({
      loop,
      host,
      render: () => {
        frames++;
        if (frames === 1) throw new Error('render failed');
      },
    });
    driver.start();
    expect(() => host.frame(0)).toThrow('render failed');
    expect(host.pendingFrames).toBe(1);
    host.frame(16);
    expect(frames).toBe(2);
  });

  it('runs the background callback on a timer while hidden, and only then', () => {
    const host = new FakeHost();
    const loop = new FixedStepLoop(10, () => {});
    let frames = 0;
    let beats = 0;
    const driver = new FrameDriver({
      loop,
      host,
      render: () => frames++,
      background: () => beats++,
    });
    driver.start();
    expect(host.timers.size).toBe(0);
    host.frame(0);

    host.setHidden(true);
    expect(host.pendingFrames).toBe(0);
    expect(host.timers.size).toBe(1);
    host.timerBeat();
    host.timerBeat();
    expect(beats).toBe(2);
    expect(frames).toBe(1);

    host.setHidden(false);
    expect(host.timers.size).toBe(0);
    expect(host.pendingFrames).toBe(1);

    // Started hidden: the beat runs from the start; stopping ends it.
    host.setHidden(true);
    driver.stop();
    expect(host.timers.size).toBe(0);
    driver.start();
    expect(host.timers.size).toBe(1);
    driver.dispose();
    expect(host.timers.size).toBe(0);
  });

  it('starts no timer without a background callback', () => {
    const { host, driver } = createRig();
    driver.start();
    host.setHidden(true);
    expect(host.timers.size).toBe(0);
  });

  it('reports the time spent in sim steps', () => {
    const { host, driver } = createRig((h) => {
      h.clock += 2;
    });
    driver.start();
    host.frame(0);
    expect(driver.simMs).toBe(0);
    host.frame(25);
    expect(driver.simMs).toBe(4);
    host.frame(26);
    expect(driver.simMs).toBe(0);
  });
});
