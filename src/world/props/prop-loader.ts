/**
 * Loads a map's placed-asset GLBs (meshopt + quantised attributes) and the shared tileable KTX2
 * textures, and hands back plain geometries: one per asset type, LOD and material slot.
 *
 * The scene graphs and materials of the GLBs are thrown away. The view draws every type with
 * its own instanced world material (world-material.ts), so all it needs are the attributes:
 *
 *   position, normal, uv       as exported
 *   aColor  (vec4 u8 norm)     COLOR_0: the painted albedo, linear
 *   aMasks  (vec4)             _MASKS: r AO, g moss, b lit edge, a glow
 *
 * CACHE: one bundle per map id and renderer, kept for the life of the page (a rematch must not
 * fetch or decode anything). `releaseMapAssets` frees it.
 *
 * Load-time code: everything here allocates.
 */

import { BufferAttribute, LinearMipmapLinearFilter, LinearFilter, RepeatWrapping } from 'three';
import type {
  BufferGeometry,
  InterleavedBufferAttribute,
  Mesh,
  Object3D,
  Texture,
  TypedArray,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MapManifest, MapPropSet, MapTexture } from '../../shared';

/** Material slot names the map art uses (T-4.5 contract). */
export const STONE_MATERIAL = 'Stone';
export const TINT_MATERIAL = 'TeamTint';

/** One LOD of one asset type, split by material slot. */
export interface PropLodGeometry {
  readonly stone: BufferGeometry | null;
  readonly tint: BufferGeometry | null;
  readonly triangles: number;
}

export interface PropAsset {
  readonly id: string;
  /** Nearest first: `LOD0`, `LOD1`, ... as many as the GLB has. */
  readonly lods: readonly PropLodGeometry[];
}

export interface LoadedMapTexture {
  readonly info: MapTexture;
  readonly texture: Texture;
}

export interface MapAssetBundle {
  readonly mapId: string;
  readonly assets: ReadonlyMap<string, PropAsset>;
  /** By material slot (`textureSlotOf`): 'stone', 'masonry', 'moss', 'cliff', 'brush'. */
  readonly textures: ReadonlyMap<string, LoadedMapTexture>;
  /** Wall-clock milliseconds the fetch + decode took. */
  readonly loadMs: number;
  /** Bytes of vertex + index data held by the geometries (CPU side; the GPU copy is the same). */
  readonly geometryBytes: number;
}

export interface MapAssetLoadOptions {
  /** URL prefix of `public/assets/`. Default: `<vite base>assets/`. */
  readonly baseUrl?: string;
  /** URL prefix of the Basis transcoder files. Default: `<vite base>vendor/basis/`. */
  readonly transcoderUrl?: string;
}

function defaultBase(): string {
  const base: unknown = import.meta.env.BASE_URL;
  return typeof base === 'string' && base.length > 0 ? base : '/';
}

function isMesh(object: Object3D): object is Mesh<BufferGeometry> {
  return (object as { isMesh?: boolean }).isMesh === true;
}

function materialName(mesh: Mesh): string {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return material?.name ?? '';
}

function geometryBytes(geometry: BufferGeometry | null): number {
  if (geometry === null) return 0;
  let bytes = geometry.getIndex()?.array.byteLength ?? 0;
  for (const name in geometry.attributes) {
    bytes += geometry.attributes[name]?.array.byteLength ?? 0;
  }
  return bytes;
}

/** A plain copy of an interleaved attribute, same component type and normalisation. */
function deinterleave(source: InterleavedBufferAttribute): BufferAttribute {
  const size = source.itemSize;
  const stride = source.data.stride;
  const from = source.data.array;
  const Ctor = from.constructor as new (length: number) => TypedArray;
  const array = new Ctor(source.count * size);
  for (let i = 0; i < source.count; i++) {
    for (let k = 0; k < size; k++) array[i * size + k] = from[i * stride + source.offset + k] ?? 0;
  }
  return new BufferAttribute(array, size, source.normalized);
}

/**
 * The attributes the world material reads, in a fresh geometry; anything else is dropped. A
 * primitive without `_MASKS` (not expected) gets neutral masks: full AO light, nothing else.
 */
function toWorldGeometry(mesh: Mesh<BufferGeometry>): BufferGeometry {
  const geometry = mesh.geometry.clone();
  mesh.updateWorldMatrix(true, false);
  geometry.applyMatrix4(mesh.matrixWorld);
  // meshopt buffers arrive interleaved; the far-mesh merge and `mergeGeometries` want plain ones.
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name];
    if (attribute !== undefined && 'isInterleavedBufferAttribute' in attribute) {
      geometry.setAttribute(name, deinterleave(attribute));
    }
  }
  const count = geometry.getAttribute('position').count;

  const color = geometry.getAttribute('color');
  if (color !== undefined && color.itemSize === 4) {
    geometry.setAttribute('aColor', color);
  } else {
    const data = new Uint8Array(count * 4).fill(255);
    if (color !== undefined) {
      for (let i = 0; i < count; i++) {
        data[i * 4] = Math.round(color.getX(i) * 255);
        data[i * 4 + 1] = Math.round(color.getY(i) * 255);
        data[i * 4 + 2] = Math.round(color.getZ(i) * 255);
      }
    }
    geometry.setAttribute('aColor', new BufferAttribute(data, 4, true));
  }
  geometry.deleteAttribute('color');

  const masks = geometry.getAttribute('_masks');
  if (masks !== undefined) {
    geometry.setAttribute('aMasks', masks);
    geometry.deleteAttribute('_masks');
  } else {
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) data[i * 4] = 1;
    geometry.setAttribute('aMasks', new BufferAttribute(data, 4));
  }
  if (geometry.getAttribute('uv') === undefined) {
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  }
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'aColor' && name !== 'aMasks') {
      geometry.deleteAttribute(name);
    }
  }
  geometry.computeBoundingSphere();
  return geometry;
}

function mergeSlot(parts: BufferGeometry[]): BufferGeometry | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return merged;
}

function triangleCount(geometry: BufferGeometry | null): number {
  if (geometry === null) return 0;
  const index = geometry.getIndex();
  return (index !== null ? index.count : geometry.getAttribute('position').count) / 3;
}

/** Splits one `LODn` node (a mesh, or a group of per-material meshes) by material slot. */
export function extractLod(node: Object3D): PropLodGeometry {
  const stone: BufferGeometry[] = [];
  const tint: BufferGeometry[] = [];
  node.traverse((child) => {
    if (!isMesh(child)) return;
    (materialName(child) === TINT_MATERIAL ? tint : stone).push(toWorldGeometry(child));
  });
  const stoneGeometry = mergeSlot(stone);
  const tintGeometry = mergeSlot(tint);
  return {
    stone: stoneGeometry,
    tint: tintGeometry,
    triangles: triangleCount(stoneGeometry) + triangleCount(tintGeometry),
  };
}

/** Every `LOD0..n` node of a loaded GLB scene, nearest first. */
export function extractLods(scene: Object3D): PropLodGeometry[] {
  scene.updateMatrixWorld(true);
  const lods: PropLodGeometry[] = [];
  for (let level = 0; level < 4; level++) {
    const node = scene.getObjectByName(`LOD${level}`);
    if (node === undefined) break;
    lods.push(extractLod(node));
  }
  return lods;
}

function disposeScene(scene: Object3D): void {
  scene.traverse((child) => {
    if (!isMesh(child)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
}

/** Index of the shared tileable textures, written by tools/textures/make_textures.py. */
export const TEXTURE_INDEX_URL = 'textures/textures.json';

/**
 * The shared texture list for a map object that does not carry `textures` itself (the runtime
 * `createShatteredSpires()` map; the baked manifest JSON does).
 */
async function fetchTextureList(base: string): Promise<readonly MapTexture[]> {
  const response = await fetch(base + TEXTURE_INDEX_URL);
  if (!response.ok) throw new Error(`${TEXTURE_INDEX_URL}: HTTP ${response.status}`);
  const json = (await response.json()) as { textures?: readonly MapTexture[] };
  if (!Array.isArray(json.textures)) throw new Error(`${TEXTURE_INDEX_URL}: no "textures" list`);
  return json.textures;
}

interface CacheEntry {
  readonly renderer: WebGLRenderer;
  readonly promise: Promise<MapAssetBundle>;
  bundle: MapAssetBundle | null;
}

const cache = new Map<string, CacheEntry>();

/** Where a bundle's files come from. The real one decodes GLB and KTX2; tests hand in fakes. */
export interface MapAssetSource {
  loadAsset(set: MapPropSet): Promise<PropAsset>;
  /** The shared texture list, asked for only when the map does not carry `textures` itself. */
  loadTextureList(): Promise<readonly MapTexture[]>;
  loadTexture(info: MapTexture): Promise<LoadedMapTexture>;
}

function disposeAsset(asset: PropAsset): void {
  for (const lod of asset.lods) {
    lod.stone?.dispose();
    lod.tint?.dispose();
  }
}

/** The material slot a texture fills: its `role`, or its own id (the first map's textures). */
export function textureSlotOf(info: MapTexture): string {
  return info.role ?? info.id;
}

/**
 * The textures of the shared list that `mapId` draws with, one per material slot: a texture
 * made for this map wins its slot, a texture made for another map is left out, and the shared
 * ones (no `map`) fill what is left. So the caldera gets basalt in the `stone` slot and never
 * downloads the first map's slate, and a map with no textures of its own gets the shared set.
 */
export function texturesForMap(list: readonly MapTexture[], mapId: string): MapTexture[] {
  const own = new Set<string>();
  for (const info of list) if (info.map === mapId) own.add(textureSlotOf(info));
  const picked: MapTexture[] = [];
  const taken = new Set<string>();
  for (const info of list) {
    const slot = textureSlotOf(info);
    if (info.map !== undefined ? info.map !== mapId : own.has(slot)) continue;
    if (taken.has(slot)) continue;
    taken.add(slot);
    picked.push(info);
  }
  return picked;
}

/** What a group of load jobs came to: everything that did load, and the first failure if any. */
interface Settled<T> {
  readonly loaded: T[];
  readonly failed: boolean;
  readonly error: unknown;
}

/**
 * Waits for every job, whatever the others do. `Promise.all` would give up at the first
 * failure and drop the results of the jobs still running, with nobody left to dispose them.
 */
async function settle<T>(jobs: readonly Promise<T>[]): Promise<Settled<T>> {
  const results = await Promise.allSettled(jobs);
  const loaded: T[] = [];
  let failed = false;
  let error: unknown;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      loaded.push(result.value);
    } else if (!failed) {
      failed = true;
      error = result.reason;
    }
  }
  return { loaded, failed, error };
}

/**
 * Loads every asset and texture of `map` from `source` into a bundle. All or nothing: when any
 * file fails, the geometries and textures that did load are disposed and the first failure is
 * rethrown. Every job has a handler from the moment it starts, so no failure order (a GLB
 * failing while the texture list is still on its way, say) leaves an unhandled rejection.
 */
export async function collectMapAssets(
  map: MapManifest,
  source: MapAssetSource,
): Promise<MapAssetBundle> {
  const started = performance.now();
  // Both groups start now and run side by side; `settle` is the handler of the first.
  const assetsDone = settle(map.props.map((set) => source.loadAsset(set)));
  let textureGroup: Settled<LoadedMapTexture>;
  try {
    const list = texturesForMap(map.textures ?? (await source.loadTextureList()), map.id);
    textureGroup = await settle(list.map((info) => source.loadTexture(info)));
  } catch (error) {
    // The list itself failed: no texture job ever started.
    textureGroup = { loaded: [], failed: true, error };
  }
  const assetGroup = await assetsDone;
  if (assetGroup.failed || textureGroup.failed) {
    for (const asset of assetGroup.loaded) disposeAsset(asset);
    for (const entry of textureGroup.loaded) entry.texture.dispose();
    throw assetGroup.failed ? assetGroup.error : textureGroup.error;
  }
  const assets = new Map<string, PropAsset>();
  let bytes = 0;
  for (const asset of assetGroup.loaded) {
    assets.set(asset.id, asset);
    for (const lod of asset.lods) bytes += geometryBytes(lod.stone) + geometryBytes(lod.tint);
  }
  const textures = new Map<string, LoadedMapTexture>();
  // Keyed by slot, so every reader asks for 'stone' and gets this map's rock texture.
  for (const entry of textureGroup.loaded) textures.set(textureSlotOf(entry.info), entry);
  return {
    mapId: map.id,
    assets,
    textures,
    loadMs: performance.now() - started,
    geometryBytes: bytes,
  };
}

/**
 * One texture transcoder for all the map loads that overlap. With two maps in the game the
 * default map (lobby, podium) and the match's own map can load at the same time, and two
 * loaders would mean two sets of transcoder workers (three.js warns about exactly that).
 */
interface SharedKtx2 {
  readonly loader: KTX2Loader;
  readonly renderer: WebGLRenderer;
  readonly transcoderUrl: string;
  users: number;
}

let sharedKtx2: SharedKtx2 | null = null;

function acquireKtx2(renderer: WebGLRenderer, transcoderUrl: string): SharedKtx2 {
  const shared = sharedKtx2;
  if (shared !== null && shared.renderer === renderer && shared.transcoderUrl === transcoderUrl) {
    shared.users++;
    return shared;
  }
  // A different renderer or path (tests, viewers) gets its own loader, never shared.
  const own: SharedKtx2 = {
    loader: new KTX2Loader().setTranscoderPath(transcoderUrl).detectSupport(renderer),
    renderer,
    transcoderUrl,
    users: 1,
  };
  if (shared === null) sharedKtx2 = own;
  return own;
}

function releaseKtx2(held: SharedKtx2): void {
  held.users--;
  if (held.users > 0) return;
  // The transcoder workers are only needed while loading.
  held.loader.dispose();
  if (sharedKtx2 === held) sharedKtx2 = null;
}

async function loadBundle(
  map: MapManifest,
  renderer: WebGLRenderer,
  options: MapAssetLoadOptions,
): Promise<MapAssetBundle> {
  const base = options.baseUrl ?? `${defaultBase()}assets/`;
  const held = acquireKtx2(renderer, options.transcoderUrl ?? `${defaultBase()}vendor/basis/`);
  const ktx2 = held.loader;
  const gltf = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const source: MapAssetSource = {
    async loadAsset(set) {
      const file = await gltf.loadAsync(base + set.glb);
      let lods: PropLodGeometry[];
      try {
        lods = extractLods(file.scene);
      } finally {
        disposeScene(file.scene);
      }
      if (lods.length === 0) throw new Error(`map asset "${set.id}" has no LOD0 node (${set.glb})`);
      return { id: set.id, lods };
    },
    loadTextureList: () => fetchTextureList(base),
    async loadTexture(info) {
      // Every level of the file is kept here; `createPropField` leaves out the ones above the
      // preset's `maxTextureSize` before the first upload (texture-mips.ts).
      const texture = await ktx2.loadAsync(base + info.url);
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.magFilter = LinearFilter;
      texture.minFilter = texture.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      texture.name = `map-${info.id}`;
      texture.needsUpdate = true;
      return { info, texture };
    },
  };
  try {
    return await collectMapAssets(map, source);
  } finally {
    releaseKtx2(held);
  }
}

/**
 * The map's geometries and textures, fetched and decoded once per page. Rejects when any file
 * fails; the caller then keeps its stand-in (map-view.ts logs it). A failed load is not cached,
 * so the next match tries again.
 */
export function loadMapAssets(
  map: MapManifest,
  renderer: WebGLRenderer,
  options: MapAssetLoadOptions = {},
): Promise<MapAssetBundle> {
  const known = cache.get(map.id);
  if (known !== undefined && known.renderer === renderer) return known.promise;
  const promise = loadBundle(map, renderer, options);
  const entry: CacheEntry = { renderer, promise, bundle: null };
  cache.set(map.id, entry);
  promise.then(
    (bundle) => {
      entry.bundle = bundle;
    },
    () => {
      if (cache.get(map.id) === entry) cache.delete(map.id);
    },
  );
  return promise;
}

/** The bundle if it has finished loading (so a match that starts later can build at once). */
export function loadedMapAssets(mapId: string, renderer: WebGLRenderer): MapAssetBundle | null {
  const entry = cache.get(mapId);
  return entry !== undefined && entry.renderer === renderer ? entry.bundle : null;
}

/** Frees a cached bundle's geometries and textures. Only when no view uses them any more. */
export function releaseMapAssets(mapId: string): void {
  const entry = cache.get(mapId);
  if (entry === undefined) return;
  cache.delete(mapId);
  void entry.promise.then(
    (bundle) => {
      for (const asset of bundle.assets.values()) disposeAsset(asset);
      for (const loaded of bundle.textures.values()) loaded.texture.dispose();
    },
    () => undefined,
  );
}
