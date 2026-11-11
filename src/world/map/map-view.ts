/**
 * Map renderer.
 *
 * REAL MAPS (T-4.6, `map.placements`): the placed GLB assets drawn by `createPropField`
 * (src/world/props: instanced LODs, merged far clusters, the painterly world material). The
 * geometries and textures load asynchronously (`loadMapAssets`, cached per page; the stage
 * starts the load when it is created, so a match normally finds them ready). Until they are
 * there, and for good if the load fails (logged once), the view shows the STAND-IN below built
 * from the map's collision hulls: the map is always flyable and what is drawn is never less
 * than what is hit. `loadState` / `ready` tell the caller which of the two is on screen.
 *
 * GREYBOX / STAND-IN (T-1.6): the shared map triangles (`buildMapTriangles`, the same call as
 * the sim's collision world, at full prism detail) as chunked, merged, vertex-coloured meshes.
 *
 * DEBUG (`?debug`): gate and storm markers; with `&collision` also the collision triangles
 * over the visuals (map-collision-overlay.ts).
 *
 * COST: one draw call per non-empty world chunk that is on screen (the greybox has about 48
 * chunks of 250 m and about 5k triangles in total), ONE shared `MeshLambertMaterial`, no
 * textures, no per-frame matrix work. Lighting comes from the scene's sun + hemisphere; depth
 * comes from a height/underside shade baked into the vertex colours (map-colors.ts), so the
 * greybox reads without shadows.
 *
 * QUALITY: world shadows follow `shadowCasters` / `shadowMapSize`. The draw distance does NOT
 * depend on the preset: a chunk is dropped only once exp2 fog hides 99.5 % of it, where
 * switching it on or off changes a pixel by about one 8-bit level. Dropping it earlier (97 %,
 * as Low and Medium once did) made whole pillar clusters pop in, and saves nothing on a map of
 * a few dozen draw calls. `propDrawDistance` is for props, not for the terrain.
 */

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial, Sphere } from 'three';
import type { Camera, WebGLRenderer } from 'three';
import { buildMapTriangles, sliceMapChunk } from '../../shared';
import type { MapManifest, QualityPreset, Vec3 } from '../../shared';
import { useWorldLight } from '../light';
import { createPropField, loadMapAssets, loadedMapAssets } from '../props';
import type { MapAssetBundle, PropField, PropFieldStats } from '../props';
import { createMapCollisionOverlay } from './map-collision-overlay';
import type { MapCollisionOverlay } from './map-collision-overlay';
import { createMapDebugMarkers } from './map-debug-markers';
import type { MapDebugMarkers } from './map-debug-markers';
import {
  DEFAULT_MAP_SHADE,
  bakeMapVertexColors,
  createGlowRoleMask,
  createRolePalette,
  fogHiddenDistance,
  sphereWithinDistance,
} from './map-colors';
import type { MapShadeOptions } from './map-colors';

/** Fog fraction past which a chunk is invisible and is no longer drawn (every preset). */
const FOG_HIDDEN = 0.995;
/** Slack on the culling spheres for float32 rounding of the vertex data, metres. */
const BOUNDS_MARGIN = 0.01;

export interface MapViewOptions {
  /**
   * Edge of a render chunk in metres. Default: the map's own `chunkSize` (250). A larger value
   * (500, 1000) trades culling precision for fewer draw calls; the triangles are identical.
   */
  readonly chunkSize?: number;
  /** exp2 fog density the scene uses. Default: `map.sky.fogDensity`. 0 = never cull by distance. */
  readonly fogDensity?: number;
  /** Overrides for the baked height/underside shade. `baseY` defaults to the cloud-sea surface. */
  readonly shade?: Partial<MapShadeOptions>;
  /**
   * The renderer the map's GLBs and KTX2 textures are loaded for. Without it (and without
   * `assets`) a map with placements stays on its hull stand-in: node tests, tools.
   */
  readonly renderer?: WebGLRenderer | null;
  /** An already loaded bundle (tools, tests); skips the loader. */
  readonly assets?: MapAssetBundle;
  /** Debug overlays. Default: read from the page URL (`?debug`, `&collision`). */
  readonly debug?: MapDebugOptions;
}

export interface MapDebugOptions {
  /** Gate, slot and storm-wall markers. */
  readonly markers?: boolean;
  /** The collision triangles over the visuals. */
  readonly collision?: boolean;
}

/**
 * What the view is drawing:
 * - `static`: a greybox map (solids); nothing to load.
 * - `loading`: the hull stand-in, while the real assets are on their way.
 * - `ready`: the real assets.
 * - `fallback`: the hull stand-in for good (no renderer given, or the load failed).
 */
export type MapLoadState = 'static' | 'loading' | 'ready' | 'fallback';

/** `?debug` / `&collision` of the page URL; all off where there is no page (node). */
export function mapDebugFromLocation(): MapDebugOptions {
  const search = (globalThis as { location?: { search?: string } }).location?.search;
  if (typeof search !== 'string' || search.length === 0) return {};
  const params = new URLSearchParams(search);
  const debug = params.has('debug');
  return {
    markers: debug,
    collision: debug && (params.has('collision') || params.get('debug') === 'collision'),
  };
}

/** Numbers for the perf HUD and the budget report. One object, mutated in place by `update`. */
export interface MapViewStats {
  /** Meshes in the view = worst-case draw calls (one material, no shadow pass). */
  readonly chunkCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly maxChunkTriangles: number;
  /** Chunks inside the draw distance after the last `update` (before frustum culling). */
  readonly chunksInRange: number;
  /** Metres; Infinity when distance culling is off. */
  readonly drawDistance: number;
  /** Counters of the real assets; null while the stand-in (or a greybox) is drawn. */
  readonly props: PropFieldStats | null;
  /** Milliseconds the asset load took (0 from the cache), -1 before it finished. */
  readonly loadMs: number;
}

export interface MapView {
  /** Add to the scene once. Static: its matrices are never recomputed. */
  readonly object: Group;
  readonly stats: MapViewStats;
  readonly loadState: MapLoadState;
  /** Settles (never rejects) once the view shows what it will keep showing. */
  readonly ready: Promise<MapLoadState>;
  /**
   * Per frame, before rendering: LOD buckets, culling, the material clock. `camera` adds
   * frustum culling of the instanced assets; `timeS` drives pulses and cloth. Allocation-free.
   */
  update(cameraPosition: Vec3, camera?: Camera | null, timeS?: number): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

interface MutableStats {
  chunkCount: number;
  triangleCount: number;
  vertexCount: number;
  maxChunkTriangles: number;
  chunksInRange: number;
  drawDistance: number;
  props: PropFieldStats | null;
  loadMs: number;
}

/**
 * Starts loading a real map's assets (no-op for a greybox, and when already loaded or loading).
 * Never rejects: a failure is reported by the map view that needs the assets.
 */
export function preloadMapAssets(map: MapManifest, renderer: WebGLRenderer): void {
  if (map.placements === undefined || map.placements.length === 0) return;
  loadMapAssets(map, renderer).catch(() => undefined);
}

/**
 * Chunk draw distance in metres for a fog density: where the fog hides the chunk, the same on
 * every preset (see QUALITY at the top). Infinity without fog.
 */
export function mapDrawDistance(fogDensity: number): number {
  return fogHiddenDistance(fogDensity, FOG_HIDDEN);
}

/**
 * Builds the render meshes for a map that carries `solids` (a map without them gives an empty
 * group). Load-time: allocates everything here, nothing afterwards.
 */
export function createMapView(
  map: MapManifest,
  initialPreset: QualityPreset,
  options: MapViewOptions = {},
): MapView {
  const fogDensity = options.fogDensity ?? map.sky.fogDensity;
  const shade: MapShadeOptions = {
    ...DEFAULT_MAP_SHADE,
    baseY: map.colliders.cloudSeaY ?? map.colliders.floorY,
    ...options.shade,
  };

  const object = new Group();
  object.name = 'map';
  object.matrixAutoUpdate = false;

  const placed = map.placements !== undefined && map.placements.length > 0;
  const renderer = options.renderer ?? null;
  const readyBundle =
    options.assets ?? (placed && renderer !== null ? loadedMapAssets(map.id, renderer) : null);

  // Baked face normals and baked colours: no flatShading derivative work, no textures.
  let material: MeshLambertMaterial | null = null;
  const meshes: Mesh<BufferGeometry, MeshLambertMaterial>[] = [];
  // xyz + radius per chunk, read by `update` without touching the meshes' objects.
  let spheres = new Float32Array(0);
  let maxChunkTriangles = 0;
  let standInTriangles = 0;
  let standInVertices = 0;

  /** The greybox itself, or a real map's hulls as a stand-in. */
  function buildChunks(): void {
    // Full prism detail (no maxPrismSides): identical to the collision mesh.
    const triangles = buildMapTriangles(
      map,
      options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize },
    );
    const palette = createRolePalette();
    const glowMask = createGlowRoleMask();
    const chunkMaterial = new MeshLambertMaterial({ vertexColors: true });
    chunkMaterial.name = 'map-greybox';
    // A real map's stand-in sits in the same fog and takes the same dragon shadows as the
    // assets that replace it; the greybox keeps three's plain fog (and its tests).
    if (placed) useWorldLight(chunkMaterial);
    material = chunkMaterial;
    const chunkCount = triangles.chunks.length;
    spheres = new Float32Array(chunkCount * 4);
    for (let i = 0; i < chunkCount; i++) {
      const chunk = triangles.chunks[i];
      if (chunk === undefined) continue;
      const slice = sliceMapChunk(triangles, chunk);

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(slice.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(slice.normals, 3));
      geometry.setAttribute(
        'color',
        new BufferAttribute(
          bakeMapVertexColors(slice.positions, slice.normals, slice.roles, palette, glowMask, shade),
          3,
        ),
      );
      geometry.setIndex(new BufferAttribute(slice.indices, 1));
      // World-space vertices under an identity matrix: the chunk's sphere IS the culling sphere.
      const radius = chunk.radius + BOUNDS_MARGIN;
      geometry.boundingSphere = new Sphere(undefined, radius);
      geometry.boundingSphere.center.set(chunk.center.x, chunk.center.y, chunk.center.z);

      const mesh = new Mesh(geometry, chunkMaterial);
      mesh.name = `map-chunk-${chunk.id}`;
      mesh.matrixAutoUpdate = false;
      object.add(mesh);
      meshes.push(mesh);

      spheres[i * 4] = chunk.center.x;
      spheres[i * 4 + 1] = chunk.center.y;
      spheres[i * 4 + 2] = chunk.center.z;
      spheres[i * 4 + 3] = radius;
      const chunkTriangles = chunk.indexCount / 3;
      if (chunkTriangles > maxChunkTriangles) maxChunkTriangles = chunkTriangles;
    }
    standInTriangles = triangles.triangleCount;
    standInVertices = triangles.vertexCount;
  }

  function disposeChunks(): void {
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (mesh === undefined) continue;
      object.remove(mesh);
      mesh.geometry.dispose();
    }
    meshes.length = 0;
    material?.dispose();
    material = null;
  }

  let preset = initialPreset;
  let disposed = false;
  let field: PropField | null = null;
  let loadState: MapLoadState = placed ? 'fallback' : 'static';

  const stats: MutableStats = {
    chunkCount: 0,
    triangleCount: 0,
    vertexCount: 0,
    maxChunkTriangles: 0,
    chunksInRange: 0,
    drawDistance: mapDrawDistance(fogDensity),
    props: null,
    loadMs: -1,
  };

  /** Swaps the stand-in for the real assets. False when the bundle does not fit the map. */
  function showAssets(bundle: MapAssetBundle, loadMs: number): boolean {
    let built: PropField;
    try {
      built = createPropField(map.placements ?? [], bundle, preset);
    } catch (error) {
      console.warn('[map] the loaded assets do not match the map; keeping the hull stand-in.', error);
      return false;
    }
    disposeChunks();
    field = built;
    object.add(built.object);
    stats.props = built.stats;
    stats.chunkCount = built.stats.meshCount;
    stats.chunksInRange = 0;
    stats.triangleCount = built.stats.lod0Triangles;
    stats.vertexCount = 0;
    stats.maxChunkTriangles = 0;
    stats.loadMs = loadMs;
    loadState = 'ready';
    return true;
  }

  function applyQuality(): void {
    field?.setQuality(preset);
    const castShadow = preset.shadowCasters === 'all';
    // The stand-in of a real map takes shadows through `useWorldLight`, not three's lookup.
    const receiveShadow = !placed && preset.shadowMapSize > 0;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (mesh === undefined) continue;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
    }
  }

  let ready: Promise<MapLoadState>;
  if (readyBundle !== null && showAssets(readyBundle, 0)) {
    ready = Promise.resolve<MapLoadState>('ready');
  } else {
    buildChunks();
    stats.chunkCount = meshes.length;
    stats.triangleCount = standInTriangles;
    stats.vertexCount = standInVertices;
    stats.maxChunkTriangles = maxChunkTriangles;
    stats.chunksInRange = meshes.length;
    if (placed && renderer !== null && readyBundle === null) {
      loadState = 'loading';
      ready = loadMapAssets(map, renderer).then(
        (bundle): MapLoadState => {
          if (disposed) return loadState;
          if (showAssets(bundle, bundle.loadMs)) applyQuality();
          else loadState = 'fallback';
          return loadState;
        },
        (error: unknown): MapLoadState => {
          loadState = 'fallback';
          console.warn('[map] asset load failed; flying on the collision-hull stand-in.', error);
          return loadState;
        },
      );
    } else {
      ready = Promise.resolve(loadState);
    }
  }

  // --- Debug overlays (never built in normal play) -------------------------------------------------
  const debug = options.debug ?? mapDebugFromLocation();
  let markers: MapDebugMarkers | null = null;
  let collision: MapCollisionOverlay | null = null;
  if (debug.markers === true) {
    markers = createMapDebugMarkers(map);
    markers.setVisible(true);
    object.add(markers.object);
  }
  if (debug.collision === true) {
    collision = createMapCollisionOverlay(map);
    collision.setVisible(true);
    object.add(collision.object);
  }

  function setQuality(next: QualityPreset): void {
    preset = next;
    applyQuality();
  }

  function update(cameraPosition: Vec3, camera: Camera | null = null, timeS = 0): void {
    if (field !== null) {
      field.update(cameraPosition, camera, timeS);
      stats.chunksInRange = field.stats.meshesDrawn;
      return;
    }
    const distance = stats.drawDistance;
    const eyeX = cameraPosition.x;
    const eyeY = cameraPosition.y;
    const eyeZ = cameraPosition.z;
    let inRange = 0;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (mesh === undefined) continue;
      const o = i * 4;
      const visible = sphereWithinDistance(
        eyeX,
        eyeY,
        eyeZ,
        spheres[o] ?? 0,
        spheres[o + 1] ?? 0,
        spheres[o + 2] ?? 0,
        spheres[o + 3] ?? 0,
        distance,
      );
      mesh.visible = visible;
      if (visible) inRange++;
    }
    stats.chunksInRange = inRange;
  }

  function dispose(): void {
    disposed = true;
    disposeChunks();
    field?.dispose();
    field = null;
    markers?.dispose();
    collision?.dispose();
    object.clear();
  }

  applyQuality();

  return {
    object,
    stats,
    get loadState() {
      return loadState;
    },
    ready,
    update,
    setQuality,
    dispose,
  };
}
