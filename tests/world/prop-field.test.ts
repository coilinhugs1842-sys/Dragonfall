import {
  BufferAttribute,
  BufferGeometry,
  CompressedTexture,
  Group,
  InstancedMesh,
  Material,
  RGBA_BPTC_Format,
  Texture,
} from 'three';
import type { CompressedTextureMipmap, Mesh, Object3D } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUALITY_PRESETS, buildPlacementInstances, createShatteredSpires } from '../../src/shared';
import type { MapPlacement, MapTexture } from '../../src/shared';
import { createPropField } from '../../src/world/props/prop-field';
import type {
  LoadedMapTexture,
  MapAssetBundle,
  PropAsset,
  PropLodGeometry,
} from '../../src/world/props/prop-loader';

const placements: readonly MapPlacement[] = createShatteredSpires().placements ?? [];

/** A geometry with the attributes the loader hands over; `broken` leaves the normals out. */
function fakeGeometry(triangles: number, broken = false): BufferGeometry {
  const vertices = triangles * 3;
  const geometry = new BufferGeometry();
  const position = new Float32Array(vertices * 3);
  for (let i = 0; i < position.length; i++) position[i] = Math.sin(i * 1.7) * 3;
  const normal = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) normal[v * 3 + 1] = 1;
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  if (!broken) geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(vertices * 2), 2));
  geometry.setAttribute(
    'aColor',
    new BufferAttribute(new Uint8Array(vertices * 4).fill(200), 4, true),
  );
  geometry.setAttribute('aMasks', new BufferAttribute(new Float32Array(vertices * 4).fill(1), 4));
  const index = new Uint16Array(vertices);
  for (let i = 0; i < vertices; i++) index[i] = i;
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function fakeTexture(id: string): LoadedMapTexture {
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
  return { info, texture: new CompressedTexture(mipmaps, 1024, 1024, RGBA_BPTC_Format) };
}

interface FakeBundleOptions {
  /** Leave this type out of the bundle. */
  readonly omit?: string;
  /** Give this type a far LOD the merge cannot read. */
  readonly breakType?: string;
}

/** A bundle that fits the map: three LODs per rock, two per anything else, tiny geometries. */
function fakeBundle(options: FakeBundleOptions = {}): MapAssetBundle {
  const assets = new Map<string, PropAsset>();
  for (const set of buildPlacementInstances(placements)) {
    const type = set.type;
    if (type.id === options.omit) continue;
    const levels = type.kind === 'rock' ? 3 : 2;
    const lods: PropLodGeometry[] = [];
    for (let level = 0; level < levels; level++) {
      const triangles = (levels - level) * 2;
      const broken = type.id === options.breakType && level === levels - 1;
      lods.push({
        stone: fakeGeometry(triangles, broken),
        tint: type.hasTint ? fakeGeometry(1) : null,
        triangles: triangles + (type.hasTint ? 1 : 0),
      });
    }
    assets.set(type.id, { id: type.id, lods });
  }
  const textures = new Map<string, LoadedMapTexture>();
  for (const id of ['stone', 'masonry', 'moss', 'cliff', 'brush']) textures.set(id, fakeTexture(id));
  return { mapId: 'test', assets, textures, loadMs: 0, geometryBytes: 0 };
}

function instancedMeshes(root: Object3D): InstancedMesh[] {
  return root.children.filter((child): child is InstancedMesh => child instanceof InstancedMesh);
}

/** Counts `dispose` events of an event-dispatching three object. */
function watch(target: {
  addEventListener(type: 'dispose', listener: () => void): void;
}): () => number {
  let count = 0;
  target.addEventListener('dispose', () => {
    count++;
  });
  return () => count;
}

function bundleGeometries(bundle: MapAssetBundle): BufferGeometry[] {
  const all: BufferGeometry[] = [];
  for (const asset of bundle.assets.values()) {
    for (const lod of asset.lods) {
      if (lod.stone !== null) all.push(lod.stone);
      if (lod.tint !== null) all.push(lod.tint);
    }
  }
  return all;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPropField', () => {
  it('the map places something of every kind (the fixture is worth testing against)', () => {
    const kinds = new Set(buildPlacementInstances(placements).map((set) => set.type.kind));
    expect(placements.length).toBeGreaterThan(100);
    expect(kinds).toContain('rock');
    expect(kinds).toContain('prop');
  });

  it('dispose frees every InstancedMesh, wrapper geometry, far mesh and material it made', () => {
    const bundle = fakeBundle();
    const field = createPropField(placements, bundle, QUALITY_PRESETS.medium);
    const meshes = instancedMeshes(field.object);
    const farMeshes = field.object.children.filter(
      (child) => !(child instanceof InstancedMesh),
    ) as Mesh[];
    expect(meshes.length).toBeGreaterThan(10);
    expect(farMeshes.length).toBe(field.stats.farClusters);
    expect(meshes.length + farMeshes.length).toBe(field.stats.meshCount);

    const meshDisposed = meshes.map((mesh) => watch(mesh));
    const wrapperDisposed = meshes.map((mesh) => watch(mesh.geometry));
    const farDisposed = farMeshes.map((mesh) => watch(mesh.geometry));
    const materials = new Set<Material>();
    for (const child of field.object.children) materials.add((child as Mesh).material as Material);
    const materialDisposed = [...materials].map((material) => watch(material));
    const sharedDisposed = bundleGeometries(bundle).map((geometry) => watch(geometry));
    const textureDisposed = [...bundle.textures.values()].map((entry) => watch(entry.texture));

    field.update({ x: 0, y: 300, z: 0 }, null, 0);
    field.dispose();

    // three frees the instance buffers and vertex array objects of an InstancedMesh only on
    // the mesh's own dispose event.
    expect(meshDisposed.map((count) => count())).toEqual(meshes.map(() => 1));
    expect(wrapperDisposed.map((count) => count())).toEqual(meshes.map(() => 1));
    expect(farDisposed.map((count) => count())).toEqual(farMeshes.map(() => 1));
    expect(materialDisposed.map((count) => count())).toEqual([...materials].map(() => 1));
    expect(field.object.children).toHaveLength(0);
    // The bundle is the page's cache, shared with the next match: it stays.
    expect(sharedDisposed.every((count) => count() === 0)).toBe(true);
    expect(textureDisposed.every((count) => count() === 0)).toBe(true);

    // A second dispose has nothing left to free.
    field.dispose();
    expect(meshDisposed.map((count) => count())).toEqual(meshes.map(() => 1));
  });

  it('a bundle that lacks a placed type throws before anything is allocated', () => {
    const last = buildPlacementInstances(placements).at(-1)?.type.id;
    expect(last).toBeDefined();
    const bundle = fakeBundle({ omit: last as string });
    const add = vi.spyOn(Group.prototype, 'add');
    const textureDispose = vi.spyOn(Texture.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');

    expect(() => createPropField(placements, bundle, QUALITY_PRESETS.low)).toThrow(
      `no geometry for "${last}"`,
    );
    // No mesh was made, so there is nothing to free, and nothing was freed.
    expect(add).not.toHaveBeenCalled();
    expect(textureDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
    // The shared textures were not touched either (Low would have trimmed them).
    for (const entry of bundle.textures.values()) {
      expect(entry.texture.mipmaps).toHaveLength(11);
      expect(entry.texture.version).toBe(0);
    }
  });

  it('a missing "stone" texture throws before anything is allocated', () => {
    const bundle = fakeBundle();
    const textures = new Map(bundle.textures);
    textures.delete('stone');
    const add = vi.spyOn(Group.prototype, 'add');
    expect(() => createPropField(placements, { ...bundle, textures }, QUALITY_PRESETS.low)).toThrow(
      'texture is missing',
    );
    expect(add).not.toHaveBeenCalled();
  });

  it('a failure half-way through the build frees what was built so far', () => {
    // The last type's far LOD has no normals: the far-mesh merge throws on it, after every
    // other type's instanced meshes exist.
    const last = buildPlacementInstances(placements).at(-1)?.type.id as string;
    const bundle = fakeBundle({ breakType: last });
    const add = vi.spyOn(Group.prototype, 'add');
    const meshDispose = vi.spyOn(InstancedMesh.prototype, 'dispose');
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');

    expect(() => createPropField(placements, bundle, QUALITY_PRESETS.medium)).toThrow();

    const built = add.mock.calls
      .map((call) => call[0])
      .filter((child): child is InstancedMesh => child instanceof InstancedMesh);
    expect(built.length).toBeGreaterThan(10);
    // Every instanced mesh that was made got its dispose, and so did its wrapper geometry.
    expect(new Set(meshDispose.mock.contexts)).toEqual(new Set(built));
    const freedGeometries = new Set(geometryDispose.mock.contexts);
    for (const mesh of built) {
      expect(freedGeometries.has(mesh.geometry)).toBe(true);
      // ... and none is left in a scene graph.
      expect(mesh.parent).toBeNull();
    }
    expect(materialDispose.mock.calls.length).toBeGreaterThanOrEqual(4);
    // The shared geometries of the bundle are not among the freed ones.
    for (const geometry of bundleGeometries(bundle)) expect(freedGeometries.has(geometry)).toBe(false);
  });
});

describe('the preset texture limit', () => {
  function tops(bundle: MapAssetBundle): number[] {
    return [...bundle.textures.values()].map(
      (entry) => (entry.texture.mipmaps as CompressedTextureMipmap[])[0]?.width ?? 0,
    );
  }

  it.each([
    ['low', 512],
    ['medium', 1024],
    ['high', 1024],
  ] as const)('%s uploads the map textures at %i', (id, top) => {
    const bundle = fakeBundle();
    const field = createPropField(placements, bundle, QUALITY_PRESETS[id]);
    expect(QUALITY_PRESETS[id].maxTextureSize).toBeGreaterThanOrEqual(top);
    expect(tops(bundle)).toEqual([top, top, top, top, top]);
    for (const entry of bundle.textures.values()) {
      // The size three allocates the texture at follows the first level kept.
      expect((entry.texture.image as { width: number }).width).toBe(top);
    }
    field.dispose();
  });

  it('follows a preset change in both directions', () => {
    const bundle = fakeBundle();
    const field = createPropField(placements, bundle, QUALITY_PRESETS.high);
    expect(tops(bundle)).toEqual([1024, 1024, 1024, 1024, 1024]);
    const disposed = [...bundle.textures.values()].map((entry) => watch(entry.texture));

    field.setQuality(QUALITY_PRESETS.low);
    expect(tops(bundle)).toEqual([512, 512, 512, 512, 512]);
    // Freed, to go up again at the new size on their next use.
    expect(disposed.map((count) => count())).toEqual([1, 1, 1, 1, 1]);

    field.setQuality(QUALITY_PRESETS.low);
    expect(disposed.map((count) => count())).toEqual([1, 1, 1, 1, 1]);

    field.setQuality(QUALITY_PRESETS.medium);
    expect(tops(bundle)).toEqual([1024, 1024, 1024, 1024, 1024]);
    expect(disposed.map((count) => count())).toEqual([2, 2, 2, 2, 2]);
    field.dispose();
  });
});
