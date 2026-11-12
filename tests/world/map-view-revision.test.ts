import {
  BufferAttribute,
  BufferGeometry,
  CompressedTexture,
  InstancedMesh,
  RGBA_BPTC_Format,
} from 'three';
import type { CompressedTextureMipmap, Mesh, Object3D, WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUALITY_PRESETS,
  buildPlacementInstances,
  createGreyboxSpires,
  createShatteredSpires,
} from '../../src/shared';
import type { MapTexture } from '../../src/shared';
import { createMapView } from '../../src/world/map';
import type { MapView } from '../../src/world/map';
import type {
  LoadedMapTexture,
  MapAssetBundle,
  PropAsset,
  PropLodGeometry,
} from '../../src/world/props/prop-loader';

/** The loads the view started; the test settles them when it wants the assets to "arrive". */
const loader = vi.hoisted(() => ({
  jobs: [] as { resolve(bundle: unknown): void; reject(error: unknown): void }[],
}));

vi.mock('../../src/world/props/prop-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/world/props/prop-loader')>();
  return {
    ...actual,
    loadedMapAssets: () => null,
    loadMapAssets: () =>
      new Promise((resolve, reject) => {
        loader.jobs.push({ resolve, reject });
      }),
  };
});

const map = createShatteredSpires();
const renderer = {} as WebGLRenderer;
const EYE = { x: 0, y: 300, z: 0 };

function fakeGeometry(triangles: number): BufferGeometry {
  const vertices = triangles * 3;
  const geometry = new BufferGeometry();
  const position = new Float32Array(vertices * 3);
  for (let i = 0; i < position.length; i++) position[i] = Math.sin(i * 1.7) * 3;
  const normal = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) normal[v * 3 + 1] = 1;
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(vertices * 2), 2));
  geometry.setAttribute('aColor', new BufferAttribute(new Uint8Array(vertices * 4), 4, true));
  geometry.setAttribute('aMasks', new BufferAttribute(new Float32Array(vertices * 4), 4));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A bundle that fits the map's placements, with tiny geometries and 1024 texture chains. */
function fakeBundle(): MapAssetBundle {
  const assets = new Map<string, PropAsset>();
  for (const set of buildPlacementInstances(map.placements ?? [])) {
    const type = set.type;
    const lods: PropLodGeometry[] = [];
    for (let level = 0; level < (type.kind === 'rock' ? 3 : 2); level++) {
      lods.push({
        stone: fakeGeometry(2),
        tint: type.hasTint ? fakeGeometry(1) : null,
        triangles: type.hasTint ? 3 : 2,
      });
    }
    assets.set(type.id, { id: type.id, lods });
  }
  const textures = new Map<string, LoadedMapTexture>();
  for (const id of ['stone', 'masonry', 'moss', 'cliff', 'brush']) {
    const mipmaps: CompressedTextureMipmap[] = [];
    for (let edge = 1024; edge >= 1; edge /= 2) {
      mipmaps.push({ data: new Uint8Array(16), width: edge, height: edge });
    }
    const info: MapTexture = {
      id,
      url: `textures/${id}.ktx2`,
      tileMetres: 8,
      meanLinear: [0.5, 0.5, 0.5],
      colorSpace: 'srgb',
    };
    textures.set(id, {
      info,
      texture: new CompressedTexture(mipmaps, 1024, 1024, RGBA_BPTC_Format),
    });
  }
  return { mapId: map.id, assets, textures, loadMs: 12, geometryBytes: 0 };
}

/** The real assets' group inside the view, or undefined while only the stand-in exists. */
function fieldOf(view: MapView): Object3D | undefined {
  return view.object.children.find((child) => child.name === 'map-props');
}

/** The stand-in's chunk meshes. */
function chunksOf(view: MapView): Mesh[] {
  return view.object.children.filter(
    (child) => child.name !== 'map-props' && (child as Mesh).isMesh === true,
  ) as Mesh[];
}

function lateView(preset = QUALITY_PRESETS.medium): MapView {
  return createMapView(map, preset, { renderer, debug: {} });
}

beforeEach(() => {
  loader.jobs.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MapView.revision', () => {
  it('stays 0 for a greybox map, whatever is updated', () => {
    const view = createMapView(createGreyboxSpires(), QUALITY_PRESETS.medium, { debug: {} });
    expect(view.loadState).toBe('static');
    expect(view.revision).toBe(0);
    for (let i = 0; i < 5; i++) view.update(EYE);
    expect(view.revision).toBe(0);
    expect(loader.jobs).toHaveLength(0);
    view.dispose();
  });

  it('stays 0 when the assets were there at creation: they are shown at once', async () => {
    const view = createMapView(map, QUALITY_PRESETS.medium, { assets: fakeBundle(), debug: {} });
    expect(view.loadState).toBe('ready');
    expect(await view.ready).toBe('ready');
    expect(view.revision).toBe(0);
    expect(fieldOf(view)?.visible).toBe(true);
    expect(chunksOf(view)).toHaveLength(0);
    expect(view.stats.props).not.toBeNull();
    expect(loader.jobs).toHaveLength(0);
    view.dispose();
  });

  it('goes up when the preset changes, not when it stays', () => {
    const view = createMapView(map, QUALITY_PRESETS.medium, { assets: fakeBundle(), debug: {} });
    view.setQuality(QUALITY_PRESETS.medium);
    expect(view.revision).toBe(0);
    view.setQuality(QUALITY_PRESETS.low);
    expect(view.revision).toBe(1);
    view.setQuality(QUALITY_PRESETS.high);
    expect(view.revision).toBe(2);
    view.dispose();
  });
});

describe('assets that arrive mid-match', () => {
  it('are built hidden, announced through revision, and swapped in two updates later', async () => {
    const view = lateView();
    expect(view.loadState).toBe('loading');
    expect(loader.jobs).toHaveLength(1);
    const standIn = chunksOf(view);
    expect(standIn.length).toBeGreaterThan(0);
    let chunksFreed = 0;
    for (const mesh of standIn) {
      mesh.geometry.addEventListener('dispose', () => {
        chunksFreed++;
      });
    }
    // Frames on the stand-in while the files load.
    for (let i = 0; i < 3; i++) view.update(EYE);
    expect(view.revision).toBe(0);
    expect(view.stats.props).toBeNull();

    loader.jobs[0]?.resolve(fakeBundle());
    expect(await view.ready).toBe('ready');
    expect(view.loadState).toBe('ready');
    expect(view.stats.loadMs).toBe(12);

    // Built and in the scene, where a warm-up that walks the scene compiles it, but not drawn.
    expect(view.revision).toBe(1);
    const field = fieldOf(view);
    expect(field).toBeDefined();
    expect(field?.parent).toBe(view.object);
    expect(field?.visible).toBe(false);
    expect(field?.children.some((child) => child instanceof InstancedMesh)).toBe(true);
    // The stand-in is still what the player sees.
    expect(chunksOf(view)).toEqual(standIn);
    expect(chunksFreed).toBe(0);
    expect(view.stats.props).toBeNull();

    // The frame in which whoever polls `revision` runs the warm-up: still the stand-in.
    view.update(EYE);
    expect(field?.visible).toBe(false);
    expect(chunksOf(view)).toEqual(standIn);
    expect(view.stats.chunksInRange).toBeGreaterThan(0);

    // The next frame: the swap.
    view.update(EYE);
    expect(field?.visible).toBe(true);
    expect(chunksOf(view)).toHaveLength(0);
    expect(chunksFreed).toBe(standIn.length);
    expect(view.stats.props).not.toBeNull();
    expect(view.stats.chunkCount).toBe(view.stats.props?.meshCount);
    expect(view.stats.props?.meshesDrawn).toBeGreaterThan(0);
    // The swap itself put nothing new in front of the GPU.
    expect(view.revision).toBe(1);

    for (let i = 0; i < 3; i++) view.update(EYE);
    expect(view.revision).toBe(1);
    expect(field?.visible).toBe(true);
    view.dispose();
  });

  it('a preset change while they wait reaches them too', async () => {
    const view = lateView(QUALITY_PRESETS.high);
    const bundle = fakeBundle();
    loader.jobs[0]?.resolve(bundle);
    await view.ready;
    const top = (): number =>
      (bundle.textures.get('stone')?.texture.mipmaps as CompressedTextureMipmap[])[0]?.width ?? 0;
    expect(top()).toBe(1024);
    const revision = view.revision;

    view.setQuality(QUALITY_PRESETS.low);
    expect(top()).toBe(512);
    expect(view.revision).toBe(revision + 1);
    // The wait is not restarted: the swap still comes on the second update.
    view.update(EYE);
    view.update(EYE);
    expect(fieldOf(view)?.visible).toBe(true);
    view.dispose();
  });

  it('disposing while they wait frees them and cancels the swap', async () => {
    const view = lateView();
    loader.jobs[0]?.resolve(fakeBundle());
    await view.ready;
    const field = fieldOf(view);
    const meshes = (field?.children ?? []).filter(
      (child): child is InstancedMesh => child instanceof InstancedMesh,
    );
    expect(meshes.length).toBeGreaterThan(0);
    let freed = 0;
    for (const mesh of meshes) {
      mesh.addEventListener('dispose', () => {
        freed++;
      });
    }
    view.dispose();
    expect(freed).toBe(meshes.length);
    expect(view.object.children).toHaveLength(0);
  });

  it('assets that arrive after the view was disposed are not built', async () => {
    const view = lateView();
    view.dispose();
    loader.jobs[0]?.resolve(fakeBundle());
    await view.ready;
    expect(view.revision).toBe(0);
    expect(view.object.children).toHaveLength(0);
  });

  it('a failed load keeps the stand-in and leaves revision alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = lateView();
    const standIn = chunksOf(view);
    loader.jobs[0]?.reject(new Error('rock_a.glb: HTTP 404'));
    expect(await view.ready).toBe('fallback');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(view.revision).toBe(0);
    for (let i = 0; i < 3; i++) view.update(EYE);
    expect(chunksOf(view)).toEqual(standIn);
    expect(fieldOf(view)).toBeUndefined();
    view.dispose();
  });

  it('a bundle that does not fit the map keeps the stand-in and leaves revision alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = lateView();
    const bundle = fakeBundle();
    const assets = new Map(bundle.assets);
    assets.delete([...assets.keys()][0] as string);
    loader.jobs[0]?.resolve({ ...bundle, assets });
    expect(await view.ready).toBe('fallback');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(view.revision).toBe(0);
    view.update(EYE);
    view.update(EYE);
    expect(fieldOf(view)).toBeUndefined();
    expect(chunksOf(view).length).toBeGreaterThan(0);
    view.dispose();
  });
});
