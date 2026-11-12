import { BufferAttribute, BufferGeometry, DataTexture } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGreyboxSpires } from '../../src/shared';
import type { MapManifest, MapPropSet, MapTexture } from '../../src/shared';
import { collectMapAssets } from '../../src/world/props/prop-loader';
import type {
  LoadedMapTexture,
  MapAssetSource,
  PropAsset,
} from '../../src/world/props/prop-loader';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise reaction run, and node report rejections nobody handled. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

const PROP_IDS = ['rock_a', 'rock_b', 'gate'] as const;
const TEXTURES: readonly MapTexture[] = ['stone', 'moss'].map((id) => ({
  id,
  url: `textures/${id}.ktx2`,
  tileMetres: 8,
  meanLinear: [0.5, 0.5, 0.5],
  colorSpace: 'srgb',
}));

function mapWith(textures: readonly MapTexture[] | undefined): MapManifest {
  const props: MapPropSet[] = PROP_IDS.map((id) => ({
    id,
    glb: `props/${id}.glb`,
    instances: `props/${id}.bin`,
    count: 1,
  }));
  const { textures: _dropped, ...base } = createGreyboxSpires() as MapManifest;
  return textures === undefined ? { ...base, props } : { ...base, props, textures };
}

/** A fake source: every file is a promise the test settles, in the order it chooses. */
class Source implements MapAssetSource {
  readonly assets = new Map<string, Deferred<PropAsset>>();
  readonly textures = new Map<string, Deferred<LoadedMapTexture>>();
  readonly list = deferred<readonly MapTexture[]>();
  listAsked = 0;
  /** Everything handed out, with whether it was disposed since. */
  readonly made: { name: string; disposed: boolean }[] = [];

  loadAsset(set: MapPropSet): Promise<PropAsset> {
    const job = deferred<PropAsset>();
    this.assets.set(set.id, job);
    return job.promise;
  }

  loadTextureList(): Promise<readonly MapTexture[]> {
    this.listAsked++;
    return this.list.promise;
  }

  loadTexture(info: MapTexture): Promise<LoadedMapTexture> {
    const job = deferred<LoadedMapTexture>();
    this.textures.set(info.id, job);
    return job.promise;
  }

  private track(name: string, target: BufferGeometry | DataTexture): void {
    const entry = { name, disposed: false };
    this.made.push(entry);
    target.addEventListener('dispose', () => {
      entry.disposed = true;
    });
  }

  /** The GLB of `id` finishes decoding: two LODs, the first with a tint slot. */
  finishAsset(id: string): PropAsset {
    const geometry = (name: string): BufferGeometry => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
      g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
      this.track(`${id}/${name}`, g);
      return g;
    };
    const asset: PropAsset = {
      id,
      lods: [
        { stone: geometry('lod0-stone'), tint: geometry('lod0-tint'), triangles: 2 },
        { stone: geometry('lod1-stone'), tint: null, triangles: 1 },
      ],
    };
    this.assets.get(id)?.resolve(asset);
    return asset;
  }

  finishTexture(id: string): void {
    const info = TEXTURES.find((texture) => texture.id === id);
    if (info === undefined) throw new Error(`no texture "${id}"`);
    const texture = new DataTexture(new Uint8Array(4), 1, 1);
    this.track(`texture/${id}`, texture);
    this.textures.get(id)?.resolve({ info, texture });
  }

  failAsset(id: string): void {
    this.assets.get(id)?.reject(new Error(`${id}.glb: HTTP 404`));
  }

  failTexture(id: string): void {
    this.textures.get(id)?.reject(new Error(`${id}.ktx2: HTTP 404`));
  }

  leaked(): string[] {
    return this.made.filter((entry) => !entry.disposed).map((entry) => entry.name);
  }
}

describe('collectMapAssets', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    await drain();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('gathers every asset and texture into a bundle', async () => {
    const source = new Source();
    const job = collectMapAssets(mapWith(TEXTURES), source);
    // Assets and textures are asked for at once, side by side.
    expect([...source.assets.keys()]).toEqual([...PROP_IDS]);
    await drain();
    expect([...source.textures.keys()]).toEqual(['stone', 'moss']);
    expect(source.listAsked).toBe(0);

    for (const id of PROP_IDS) source.finishAsset(id);
    source.finishTexture('moss');
    source.finishTexture('stone');
    const bundle = await job;
    expect([...bundle.assets.keys()]).toEqual([...PROP_IDS]);
    expect([...bundle.textures.keys()]).toEqual(['stone', 'moss']);
    expect(bundle.mapId).toBe(mapWith(TEXTURES).id);
    // 3 assets x 3 geometries x (9 floats + 3 u16 indices).
    expect(bundle.geometryBytes).toBe(3 * 3 * (36 + 6));
    expect(bundle.loadMs).toBeGreaterThanOrEqual(0);
    expect(source.leaked()).toHaveLength(source.made.length);
  });

  it('asks the source for the texture list only when the map has none', async () => {
    const source = new Source();
    const job = collectMapAssets(mapWith(undefined), source);
    expect(source.listAsked).toBe(1);
    expect(source.textures.size).toBe(0);
    source.list.resolve(TEXTURES);
    await drain();
    expect([...source.textures.keys()]).toEqual(['stone', 'moss']);
    for (const id of PROP_IDS) source.finishAsset(id);
    source.finishTexture('stone');
    source.finishTexture('moss');
    expect((await job).textures.size).toBe(2);
  });

  it.each([
    // name, the order in which things finish or fail, the error that must come out
    [
      'a GLB fails first, everything else loads afterwards',
      ['fail:rock_a', 'asset:rock_b', 'texture:stone', 'asset:gate', 'texture:moss'],
      'rock_a.glb',
    ],
    [
      'a GLB fails last',
      ['asset:rock_a', 'texture:stone', 'texture:moss', 'asset:rock_b', 'fail:gate'],
      'gate.glb',
    ],
    [
      'a texture fails first, the GLBs load afterwards',
      ['failTexture:stone', 'asset:rock_a', 'asset:rock_b', 'asset:gate', 'texture:moss'],
      'stone.ktx2',
    ],
    [
      'a texture fails last',
      ['asset:rock_a', 'asset:rock_b', 'asset:gate', 'texture:moss', 'failTexture:stone'],
      'stone.ktx2',
    ],
    [
      'two GLBs and a texture fail',
      ['fail:rock_b', 'failTexture:moss', 'asset:rock_a', 'fail:gate', 'texture:stone'],
      'rock_b.glb',
    ],
    [
      'a texture fails before a GLB does: the GLB is the one reported',
      ['failTexture:moss', 'texture:stone', 'asset:rock_a', 'fail:rock_b', 'asset:gate'],
      'rock_b.glb',
    ],
    [
      'everything fails',
      ['fail:rock_a', 'fail:rock_b', 'fail:gate', 'failTexture:stone', 'failTexture:moss'],
      'rock_a.glb',
    ],
  ] as const)('%s', async (_name, steps, expected) => {
    const source = new Source();
    const job = collectMapAssets(mapWith(TEXTURES), source);
    let settled = false;
    const outcome = job.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await drain();
    for (let i = 0; i < steps.length; i++) {
      const [kind, id] = (steps[i] as string).split(':') as [string, string];
      if (kind === 'asset') source.finishAsset(id);
      else if (kind === 'texture') source.finishTexture(id);
      else if (kind === 'fail') source.failAsset(id);
      else source.failTexture(id);
      await drain();
      // It waits for every file, so nothing that is still decoding can be dropped undisposed.
      expect(settled).toBe(i === steps.length - 1);
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    // Whatever did load (how much depends on the order) has been freed again.
    const loaded = steps.filter((step) => step.startsWith('asset:')).length * 3 +
      steps.filter((step) => step.startsWith('texture:')).length;
    expect(source.made).toHaveLength(loaded);
    expect(source.leaked()).toEqual([]);
  });

  it('a GLB fails while the texture list is still on its way', async () => {
    const source = new Source();
    const job = collectMapAssets(mapWith(undefined), source);
    const outcome = job.then(
      () => null,
      (error: unknown) => error,
    );
    source.failAsset('rock_a');
    // The failure sits there with the list unanswered: this is where an unhandled rejection
    // used to come from.
    await drain();
    expect(unhandled).toEqual([]);
    source.finishAsset('rock_b');
    source.finishAsset('gate');
    source.list.resolve(TEXTURES);
    await drain();
    source.finishTexture('stone');
    source.finishTexture('moss');
    const error = await outcome;
    expect((error as Error).message).toContain('rock_a.glb');
    expect(source.made).toHaveLength(8);
    expect(source.leaked()).toEqual([]);
  });

  it('the texture list fails: the GLBs that load afterwards are freed', async () => {
    const source = new Source();
    const job = collectMapAssets(mapWith(undefined), source);
    const outcome = job.then(
      () => null,
      (error: unknown) => error,
    );
    source.list.reject(new Error('textures.json: HTTP 500'));
    await drain();
    for (const id of PROP_IDS) source.finishAsset(id);
    const error = await outcome;
    expect((error as Error).message).toContain('textures.json');
    expect(source.textures.size).toBe(0);
    expect(source.made).toHaveLength(9);
    expect(source.leaked()).toEqual([]);
  });

  it('the texture list and a GLB both fail', async () => {
    const source = new Source();
    const job = collectMapAssets(mapWith(undefined), source);
    const outcome = job.then(
      () => null,
      (error: unknown) => error,
    );
    source.list.reject(new Error('textures.json: HTTP 500'));
    source.failAsset('gate');
    source.finishAsset('rock_a');
    source.finishAsset('rock_b');
    const error = await outcome;
    expect((error as Error).message).toContain('gate.glb');
    expect(source.leaked()).toEqual([]);
  });
});
