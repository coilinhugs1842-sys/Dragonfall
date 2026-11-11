/**
 * Greybox map renderer (T-1.6, view half): turns the shared map solids into chunked, merged,
 * vertex-coloured meshes. It calls the same `buildMapTriangles` as the sim's collision world
 * at full prism detail, so what is drawn is exactly what is hit.
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
import { buildMapTriangles, sliceMapChunk } from '../../shared';
import type { MapManifest, QualityPreset, Vec3 } from '../../shared';
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
}

export interface MapView {
  /** Add to the scene once. Static: its matrices are never recomputed. */
  readonly object: Group;
  readonly stats: MapViewStats;
  /** Per frame, before rendering: distance-culls chunks around the camera. Allocation-free. */
  update(cameraPosition: Vec3): void;
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
  preset: QualityPreset,
  options: MapViewOptions = {},
): MapView {
  const fogDensity = options.fogDensity ?? map.sky.fogDensity;
  const shade: MapShadeOptions = {
    ...DEFAULT_MAP_SHADE,
    baseY: map.colliders.cloudSeaY ?? map.colliders.floorY,
    ...options.shade,
  };

  // Full prism detail (no maxPrismSides): identical to the collision mesh.
  const triangles = buildMapTriangles(
    map,
    options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize },
  );
  const palette = createRolePalette();
  const glowMask = createGlowRoleMask();

  const object = new Group();
  object.name = 'map';
  object.matrixAutoUpdate = false;

  // Baked face normals and baked colours: no flatShading derivative work, no textures.
  const material = new MeshLambertMaterial({ vertexColors: true });
  material.name = 'map-greybox';

  const chunkCount = triangles.chunks.length;
  const meshes: Mesh<BufferGeometry, MeshLambertMaterial>[] = [];
  // xyz + radius per chunk, read by `update` without touching the meshes' objects.
  const spheres = new Float32Array(chunkCount * 4);
  let maxChunkTriangles = 0;

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

    const mesh = new Mesh(geometry, material);
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

  const stats: MutableStats = {
    chunkCount: meshes.length,
    triangleCount: triangles.triangleCount,
    vertexCount: triangles.vertexCount,
    maxChunkTriangles,
    chunksInRange: meshes.length,
    drawDistance: mapDrawDistance(fogDensity),
  };

  function setQuality(next: QualityPreset): void {
    const castShadow = next.shadowCasters === 'all';
    const receiveShadow = next.shadowMapSize > 0;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (mesh === undefined) continue;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
    }
  }

  function update(cameraPosition: Vec3): void {
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
    for (let i = 0; i < meshes.length; i++) meshes[i]?.geometry.dispose();
    material.dispose();
    object.clear();
    meshes.length = 0;
  }

  setQuality(preset);

  return { object, stats, update, setQuality, dispose };
}
