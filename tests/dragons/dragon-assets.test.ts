import type { WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDragonAssetLibrary } from '../../src/dragons';
import type { DragonAssetLibrary } from '../../src/dragons';

const ASSETS = 'http://test.invalid/assets/';
const ROOT = `${ASSETS}manifest.json`;

type Reply = () => Response | Promise<Response>;

/** Replaces `fetch`: each URL answers from its own queue of replies, the last one repeating. */
function stubFetch(replies: Record<string, Reply[]>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: unknown): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const queue = replies[url];
    if (queue === undefined || queue.length === 0) {
      return Promise.reject(new TypeError(`fetch failed: ${url}`));
    }
    const reply = queue.length > 1 ? (queue.shift() as Reply) : (queue[0] as Reply);
    try {
      return Promise.resolve(reply());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  return { calls };
}

const offline: Reply = () => {
  throw new TypeError('network down');
};
const notFound: Reply = () => new Response('missing', { status: 404 });
const json = (body: unknown): Reply => () => new Response(JSON.stringify(body), { status: 200 });

/** The library never touches the renderer before a GLB has been decoded. */
function library(): DragonAssetLibrary {
  return createDragonAssetLibrary({ webgl: {} as WebGLRenderer, assetsUrl: ASSETS });
}

function count(calls: readonly string[], url: string): number {
  return calls.filter((call) => call === url).length;
}

async function failure(job: Promise<unknown>): Promise<Error> {
  try {
    await job;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the load did not fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a failed dragon load is tried again', () => {
  it('does not hand the old rejection back, and fetches the manifest again', async () => {
    const { calls } = stubFetch({
      [ROOT]: [offline, json({ dragons: {} })],
    });
    const assets = library();
    expect(assets.status('talon')).toBe('idle');

    const first = assets.load('talon');
    expect(assets.status('talon')).toBe('loading');
    // While it is in flight a second caller joins it.
    expect(assets.load('talon')).toBe(first);
    expect((await failure(first)).message).toContain('network down');
    expect(assets.status('talon')).toBe('failed');
    expect(assets.get('talon')).toBeNull();
    expect(count(calls, ROOT)).toBe(1);

    // The next match asks again: a new attempt, a new request, and this time an answer (which
    // happens to list no dragons, so the attempt fails further along).
    const second = assets.load('talon');
    expect(second).not.toBe(first);
    expect(assets.status('talon')).toBe('loading');
    expect((await failure(second)).message).toContain('has no dragon "talon"');
    expect(count(calls, ROOT)).toBe(2);
    expect(assets.status('talon')).toBe('failed');
    assets.dispose();
  });

  it('retries after an HTTP error on the manifest as well', async () => {
    const { calls } = stubFetch({ [ROOT]: [notFound, notFound, json({ dragons: {} })] });
    const assets = library();
    expect((await failure(assets.load('wraith'))).message).toContain('HTTP 404');
    expect((await failure(assets.load('wraith'))).message).toContain('HTTP 404');
    expect((await failure(assets.load('wraith'))).message).toContain('has no dragon');
    expect(count(calls, ROOT)).toBe(3);
    assets.dispose();
  });

  it('keeps a manifest that did arrive: only the file that failed is asked for again', async () => {
    const classUrl = `${ASSETS}dragons/talon/talon.json`;
    const { calls } = stubFetch({
      [ROOT]: [json({ dragons: { talon: 'dragons/talon/talon.json' } })],
      [classUrl]: [notFound, offline],
    });
    const assets = library();
    expect((await failure(assets.load('talon'))).message).toContain('HTTP 404');
    expect((await failure(assets.load('talon'))).message).toContain('network down');
    expect(count(calls, ROOT)).toBe(1);
    expect(count(calls, classUrl)).toBe(2);
    assets.dispose();
  });

  it('one failed class does not poison the others', async () => {
    const { calls } = stubFetch({
      [ROOT]: [offline, json({ dragons: { bastion: 'dragons/bastion/bastion.json' } })],
    });
    const assets = library();
    await failure(assets.load('talon'));
    // Another class, after the manifest fetch failed for the first: it gets its own attempt
    // (and fails on its own file, which this test does not serve).
    const error = await failure(assets.load('bastion'));
    expect(error.message).toContain('dragons/bastion/bastion.json');
    expect(count(calls, ROOT)).toBe(2);
    assets.dispose();
  });

  it('loads that run side by side share one manifest request, failed or not', async () => {
    const { calls } = stubFetch({ [ROOT]: [offline] });
    const assets = library();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await assets.loadAll();
    expect(count(calls, ROOT)).toBe(1);
    for (const classId of ['talon', 'bastion', 'tempest', 'wraith'] as const) {
      expect(assets.status(classId)).toBe('failed');
    }
    // loadAll never rejects, and it can simply be called again.
    await assets.loadAll();
    expect(count(calls, ROOT)).toBe(2);
    assets.dispose();
  });
});

describe('revision and subscribe', () => {
  it('tell a view that a load ended, including a failed one', async () => {
    stubFetch({ [ROOT]: [offline] });
    const assets = library();
    let heard = 0;
    const stop = assets.subscribe(() => {
      heard++;
    });
    expect(assets.revision).toBe(0);
    await failure(assets.load('talon'));
    expect(assets.revision).toBe(1);
    expect(heard).toBe(1);

    stop();
    await failure(assets.load('talon'));
    expect(assets.revision).toBe(2);
    expect(heard).toBe(1);
    assets.dispose();
  });

  it('a listener may remove itself while being called', async () => {
    stubFetch({ [ROOT]: [offline] });
    const assets = library();
    const heard: string[] = [];
    const stopA = assets.subscribe(() => {
      heard.push('a');
      stopA();
    });
    assets.subscribe(() => {
      heard.push('b');
    });
    await failure(assets.load('talon'));
    await failure(assets.load('talon'));
    expect(heard).toEqual(['a', 'b', 'b']);
    assets.dispose();
  });
});

describe('dispose', () => {
  it('refuses new loads and drops its listeners', async () => {
    const { calls } = stubFetch({ [ROOT]: [offline] });
    const assets = library();
    let heard = 0;
    assets.subscribe(() => {
      heard++;
    });
    assets.dispose();
    expect((await failure(assets.load('talon'))).message).toContain('disposed');
    expect(calls).toHaveLength(0);
    expect(heard).toBe(0);
    expect(assets.status('talon')).toBe('idle');
    // Harmless afterwards.
    assets.setMaxTextureSize(512);
    assets.dispose();
  });

  it('a load that fails after dispose still settles, quietly', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch({
      [ROOT]: [
        async () => {
          await gate;
          throw new TypeError('network down');
        },
      ],
    });
    const assets = library();
    const job = assets.load('tempest');
    assets.dispose();
    release?.();
    expect((await failure(job)).message).toContain('network down');
    assets.dispose();
  });
});
