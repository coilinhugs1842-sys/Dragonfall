/**
 * Entry of the host worker: the dedicated Web Worker that runs the authoritative sim, the
 * snapshot encoding and the `?bots=N` test load off the page's main thread
 * (docs/PERFORMANCE.md, "Host specifics"). Started by `../host-worker.ts`.
 *
 * This file is only wiring: `self`, one `setTimeout` and the clocks. The host itself is
 * `HostWorkerServer` in `src/net/worker`, which is DOM-free and unit-tested in node.
 *
 * A worker's timers are not tied to `requestAnimationFrame`, so the 30 Hz tick keeps running
 * when the host's tab is hidden.
 */

import { greyboxMatchWorldFactory } from '../../net/session';
import type { MatchWorld, MatchWorldFactory } from '../../net/session';
import { createHostWorkerServer } from '../../net/worker/host-worker-server';
import type { FromWorkerMessage, ToWorkerMessage } from '../../net/worker/messages';
import { writeAutopilotFrame } from '../autopilot';

/** The part of `DedicatedWorkerGlobalScope` used here (the project compiles against the DOM lib). */
interface WorkerScope {
  postMessage(message: FromWorkerMessage, transfer: ArrayBuffer[]): void;
  onmessage: ((event: { readonly data: ToWorkerMessage }) => void) | null;
}

const scope = self as unknown as WorkerScope;

/** One collision world (a BVH, tens of ms to build) per layout seed, kept across matches. */
function cachedMatchWorld(): MatchWorldFactory {
  let seedOf = -1;
  let world: MatchWorld | null = null;
  return (settings, seed) => {
    if (world === null || seedOf !== seed) {
      world = greyboxMatchWorldFactory(settings, seed);
      seedOf = seed;
    }
    return world;
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;

const server = createHostWorkerServer({
  post: (message, transfer) => scope.postMessage(message, transfer),
  now: () => performance.now(),
  epochNow: () => performance.timeOrigin + performance.now(),
  setTimer: (delayMs) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(onTimer, delayMs);
  },
  clearTimer: () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  },
  createMatchWorld: cachedMatchWorld(),
  createPilot: (course) => ({
    sample: (tick, subject, out) => {
      writeAutopilotFrame(tick, subject, course, out);
    },
  }),
});

function onTimer(): void {
  timer = null;
  server.pulse();
}

scope.onmessage = (event) => {
  server.handle(event.data);
};
