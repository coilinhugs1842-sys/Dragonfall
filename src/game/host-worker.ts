/**
 * Starts the host worker (`./worker/host.worker.ts`) and adapts it to the `WorkerLike` the net
 * layer talks to. The `new Worker(new URL(..., import.meta.url))` form is what Vite recognises:
 * it bundles the worker into its own file and resolves the URL relative to this chunk, so the
 * build works under a sub-path (`base: './'`).
 */

import type { FromWorkerMessage, WorkerLike } from '../net';

/** False where dedicated workers do not exist; the host then runs on the main thread. */
export function hostWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/** Throws when the browser refuses the script (the caller falls back to the main thread). */
export function spawnHostWorker(): WorkerLike {
  const worker = new Worker(new URL('./worker/host.worker.ts', import.meta.url), {
    type: 'module',
    name: 'dragonfall-host',
  });
  return {
    post: (message, transfer) => {
      worker.postMessage(message, transfer);
    },
    listen: (onMessage, onError) => {
      worker.onmessage = (event: MessageEvent<FromWorkerMessage>): void => {
        onMessage(event.data);
      };
      worker.onerror = (event: ErrorEvent): void => {
        // Handled here (fallback or a closed room with a reason), not as an uncaught error.
        event.preventDefault();
        // A script that failed to load fires a plain Event with no message.
        const message: unknown = event.message;
        onError(
          typeof message === 'string' && message !== '' ? message : 'the worker script failed',
        );
      };
      worker.onmessageerror = (): void => {
        onError('a worker message could not be read');
      };
    },
    terminate: () => {
      worker.terminate();
    },
  };
}
