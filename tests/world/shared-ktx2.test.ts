/**
 * The page's one KTX2 loader (src/world/props/shared-ktx2.ts): loads that overlap borrow the
 * same loader, and it is freed when the last of them hands it back.
 */
import type { WebGLRenderer } from 'three';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { describe, expect, it } from 'vitest';
import { acquireKtx2, sharedKtx2Users } from '../../src/world/props/shared-ktx2';
import type { Ktx2Factory } from '../../src/world/props/shared-ktx2';

interface FakeLoader {
  disposed: number;
  dispose(): void;
}

function counting(): { create: Ktx2Factory; made: FakeLoader[] } {
  const made: FakeLoader[] = [];
  const create: Ktx2Factory = () => {
    const loader: FakeLoader = {
      disposed: 0,
      dispose() {
        this.disposed++;
      },
    };
    made.push(loader);
    // Only `dispose` is ever called on it here.
    return loader as unknown as KTX2Loader;
  };
  return { create, made };
}

const RENDERER = {} as WebGLRenderer;
const URL = '/vendor/basis/';

describe('the shared KTX2 loader', () => {
  it('gives overlapping loads one loader and frees it with the last of them', () => {
    const { create, made } = counting();
    expect(sharedKtx2Users()).toBe(0);
    const map = acquireKtx2(RENDERER, URL, create);
    const dragons = acquireKtx2(RENDERER, URL, create);
    const otherMap = acquireKtx2(RENDERER, URL, create);
    expect(made.length).toBe(1);
    expect(dragons.loader).toBe(map.loader);
    expect(otherMap.loader).toBe(map.loader);
    expect(sharedKtx2Users()).toBe(3);

    map.release();
    dragons.release();
    expect(made[0]?.disposed).toBe(0);
    expect(sharedKtx2Users()).toBe(1);
    otherMap.release();
    expect(made[0]?.disposed).toBe(1);
    expect(sharedKtx2Users()).toBe(0);
  });

  it('a lease handed back twice counts once', () => {
    const { create, made } = counting();
    const first = acquireKtx2(RENDERER, URL, create);
    const second = acquireKtx2(RENDERER, URL, create);
    first.release();
    first.release();
    expect(sharedKtx2Users()).toBe(1);
    expect(made[0]?.disposed).toBe(0);
    second.release();
    second.release();
    expect(made[0]?.disposed).toBe(1);
  });

  it('makes a new loader for the next load after everything was handed back', () => {
    const { create, made } = counting();
    acquireKtx2(RENDERER, URL, create).release();
    const later = acquireKtx2(RENDERER, URL, create);
    expect(made.length).toBe(2);
    expect(made[0]?.disposed).toBe(1);
    expect(later.loader).toBe(made[1]);
    later.release();
    expect(made[1]?.disposed).toBe(1);
  });

  it('another renderer or transcoder folder gets a loader of its own, freed with its lease', () => {
    const { create, made } = counting();
    const page = acquireKtx2(RENDERER, URL, create);
    const viewer = acquireKtx2({} as WebGLRenderer, URL, create);
    const elsewhere = acquireKtx2(RENDERER, '/other/', create);
    expect(made.length).toBe(3);
    expect(viewer.loader).not.toBe(page.loader);
    expect(elsewhere.loader).not.toBe(page.loader);
    viewer.release();
    elsewhere.release();
    expect(made[1]?.disposed).toBe(1);
    expect(made[2]?.disposed).toBe(1);
    // The page's own is untouched by them.
    expect(made[0]?.disposed).toBe(0);
    expect(sharedKtx2Users()).toBe(1);
    page.release();
    expect(made[0]?.disposed).toBe(1);
  });
});
