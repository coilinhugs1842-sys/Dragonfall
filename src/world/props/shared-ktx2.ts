/**
 * One KTX2 texture transcoder for the page. A `KTX2Loader` owns a pool of Basis workers; the
 * map loader and the dragon loader each used to make their own, and when a match's map and its
 * dragons loaded at the same moment the page ran two pools (three.js warns about exactly
 * that). Both now borrow the same loader here.
 *
 * The loader lives only while somebody holds a lease: the workers are needed while files are
 * being decoded and are freed when the last load hands its lease back, as each loader did on
 * its own before.
 *
 * Load-time code only.
 */
import type { WebGLRenderer } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

export interface Ktx2Lease {
  readonly loader: KTX2Loader;
  /** Hands the loader back. Call it once the load is over; calling it again does nothing. */
  release(): void;
}

/** Makes a loader for a renderer; a parameter so the tests can count without a GPU. */
export type Ktx2Factory = (renderer: WebGLRenderer, transcoderUrl: string) => KTX2Loader;

interface Shared {
  readonly loader: KTX2Loader;
  readonly renderer: WebGLRenderer;
  readonly transcoderUrl: string;
  users: number;
}

let shared: Shared | null = null;

const createLoader: Ktx2Factory = (renderer, transcoderUrl) =>
  new KTX2Loader().setTranscoderPath(transcoderUrl).detectSupport(renderer);

/**
 * Borrows the page's KTX2 loader for one load, making it when nobody holds it. A request for
 * another renderer or transcoder folder than the one in use (a viewer, a test) gets a loader of
 * its own, which is freed with its lease.
 */
export function acquireKtx2(
  renderer: WebGLRenderer,
  transcoderUrl: string,
  create: Ktx2Factory = createLoader,
): Ktx2Lease {
  let held = shared;
  if (held === null || held.renderer !== renderer || held.transcoderUrl !== transcoderUrl) {
    const made: Shared = { loader: create(renderer, transcoderUrl), renderer, transcoderUrl, users: 0 };
    if (held === null) shared = made;
    held = made;
  }
  const entry = held;
  entry.users++;
  let released = false;
  return {
    loader: entry.loader,
    release(): void {
      if (released) return;
      released = true;
      entry.users--;
      if (entry.users > 0) return;
      entry.loader.dispose();
      if (shared === entry) shared = null;
    },
  };
}

/** How many loads hold the page's loader right now (0 = there is none). For the tests. */
export function sharedKtx2Users(): number {
  return shared?.users ?? 0;
}
