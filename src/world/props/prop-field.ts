/**
 * Draws every placed asset of a map (hero rocks, ruins, gates, banners, backdrops) from the
 * loaded geometries (prop-loader.ts) with the world material (world-material.ts).
 *
 * TWO KINDS OF MESH
 * - Near: one `InstancedMesh` per asset type, instanced LOD and material slot. Each frame the
 *   instances are bucketed by apparent size (prop-lod.ts) and culled against the camera frustum
 *   by their bounding spheres; a bucket with no instance is not drawn.
 * - Far: the LAST LOD of every instance, merged at load into one static world-space mesh per
 *   500 m map cluster (three's own frustum culling, one draw call each). Each vertex carries its
 *   placement index; a 1-row texture holds one fade per placement, so an instance leaves or
 *   joins the far mesh (dithered) without touching the geometry. Backdrops live only here.
 *
 * So a rock costs 1 call per type and LOD near the camera and nothing extra far away: the
 * whole of Shattered Spires is at most 12 x 2 + 13 + 3 tint + about 14 clusters, and in play
 * about 25-40 calls.
 *
 * PER FRAME (`update`): 165 sphere tests and at most as many 16-float copies into preallocated
 * instance buffers; a bucket is re-uploaded only when its contents changed (rolling hash), the
 * far-state texture only when a far fade changed. No allocation.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  NearestFilter,
  RGFormat,
  UnsignedByteType,
} from 'three';
import type { Camera, ShaderMaterial } from 'three';
import {
  PLACEMENT_TEAM_NEUTRAL,
  TEAMS,
  TEAM_EMBER,
  TEAM_FROST,
  buildPlacementInstances,
} from '../../shared';
import type { MapPlacement, MapPlacementInstances, QualityPreset, Vec3 } from '../../shared';
import type { MapAssetBundle, PropLodGeometry } from './prop-loader';
import {
  encodeFarFade,
  farClusterKey,
  pickTiers,
  propLodSettings,
  sphereOutsidePlanes,
} from './prop-lod';
import type { PropLodSettings, TierFades } from './prop-lod';
import { fitTextureToLimit } from './texture-mips';
import { TINT_NEUTRAL_INDEX, createWorldMaterials, srgbHexToLinear } from './world-material';
import type { WorldMaterials } from './world-material';

/** Edge of a far-mesh cluster, metres. */
export const FAR_CLUSTER_SIZE = 500;
/** Props smaller than this (bounding radius at scale 1, metres) vanish past the prop draw distance. */
const CULLABLE_PROP_RADIUS = 25;
/** Backdrops stand 1.1-1.75 km out: their fog distance is scaled so the silhouettes survive. */
const BACKDROP_FOG_SCALE = 0.62;
/** Cloth swing as a fraction of the banner's height. */
const CLOTH_SWING = 0.045;

export interface PropFieldStats {
  /** Instanced meshes + far clusters that exist (the worst-case draw calls, before shadows). */
  readonly meshCount: number;
  readonly farClusters: number;
  /** After the last `update`: meshes with something to draw (far clusters before frustum culling). */
  readonly meshesDrawn: number;
  /** After the last `update`: triangles submitted by those meshes. */
  readonly trianglesDrawn: number;
  /** After the last `update`: instances per tier (an instance in a fade band counts twice). */
  readonly lod0Instances: number;
  readonly lod1Instances: number;
  readonly farInstances: number;
  /** Triangles if every instance were drawn at LOD0 / at its far LOD. */
  readonly lod0Triangles: number;
  readonly farTriangles: number;
  readonly placementCount: number;
}

export interface PropField {
  /** Add to the scene once. Static: world-space matrices, never recomputed. */
  readonly object: Group;
  readonly stats: PropFieldStats;
  /**
   * Per frame, after the camera is placed. `camera` null = no frustum culling (tests, tools).
   * Allocation-free.
   */
  update(eye: Vec3, camera: Camera | null, timeS: number): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

interface MutableStats {
  meshCount: number;
  farClusters: number;
  meshesDrawn: number;
  trianglesDrawn: number;
  lod0Instances: number;
  lod1Instances: number;
  farInstances: number;
  lod0Triangles: number;
  farTriangles: number;
  placementCount: number;
}

/** One instanced LOD of one type: up to two meshes (stone, tint) sharing the instance buffers. */
interface Bucket {
  readonly meshes: InstancedMesh<BufferGeometry, ShaderMaterial>[];
  readonly matrices: InstancedBufferAttribute;
  readonly inst: InstancedBufferAttribute;
  readonly triangles: number;
  count: number;
  hash: number;
  lastCount: number;
  lastHash: number;
}

interface TypeEntry {
  readonly set: MapPlacementInstances;
  readonly buckets: Bucket[];
  readonly isRock: boolean;
  readonly cullable: boolean;
  readonly glowMode: number;
  /** Far cluster index per instance. */
  readonly clusters: Uint16Array;
  readonly farTriangles: number;
}

interface FarCluster {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly triangles: number;
  /** Instances of this cluster the far mesh draws this frame. */
  live: number;
}

const scratchFades: TierFades = { near: 0, mid: 0, far: 0 };
const scratchMatrix = new Matrix4();
const scratchFrustum = new Frustum();
const scratchPlanes = new Float32Array(24);

/** A geometry that shares `source`'s vertex data and adds per-instance attributes of its own. */
function instancedGeometry(
  source: BufferGeometry,
  inst: InstancedBufferAttribute,
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex(source.getIndex());
  for (const name in source.attributes) {
    const attribute = source.attributes[name];
    if (attribute !== undefined) geometry.setAttribute(name, attribute);
  }
  geometry.setAttribute('aInst', inst);
  geometry.boundingSphere = source.boundingSphere;
  geometry.boundingBox = source.boundingBox;
  return geometry;
}

function slotTriangles(geometry: BufferGeometry | null): number {
  if (geometry === null) return 0;
  const index = geometry.getIndex();
  return (index !== null ? index.count : geometry.getAttribute('position').count) / 3;
}

/** Accumulates one far cluster's vertex data; grown by doubling at load time. */
class ClusterBuilder {
  positions = new Float32Array(3 * 4096);
  normals = new Int16Array(3 * 4096);
  uvs = new Float32Array(2 * 4096);
  colors = new Uint8Array(4 * 4096);
  masks = new Uint8Array(4 * 4096);
  far = new Float32Array(2 * 4096);
  indices = new Uint32Array(3 * 4096);
  vertexCount = 0;
  indexCount = 0;

  private growVertices(extra: number): void {
    const need = this.vertexCount + extra;
    let capacity = this.positions.length / 3;
    if (need <= capacity) return;
    while (capacity < need) capacity *= 2;
    const grow = <T extends Float32Array | Int16Array | Uint8Array>(old: T, size: number): T => {
      const next = new (old.constructor as new (n: number) => T)(capacity * size);
      next.set(old);
      return next;
    };
    this.positions = grow(this.positions, 3);
    this.normals = grow(this.normals, 3);
    this.uvs = grow(this.uvs, 2);
    this.colors = grow(this.colors, 4);
    this.masks = grow(this.masks, 4);
    this.far = grow(this.far, 2);
  }

  private growIndices(extra: number): void {
    const need = this.indexCount + extra;
    let capacity = this.indices.length;
    if (need <= capacity) return;
    while (capacity < need) capacity *= 2;
    const next = new Uint32Array(capacity);
    next.set(this.indices);
    this.indices = next;
  }

  /** Appends `geometry` under the column-major 4x4 at `matrices[offset..]`. */
  add(
    geometry: BufferGeometry,
    matrices: Float32Array,
    offset: number,
    scale: number,
    placementIndex: number,
    fogScale: number,
    tint: readonly number[] | null,
  ): void {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const color = geometry.getAttribute('aColor');
    const masks = geometry.getAttribute('aMasks');
    const index = geometry.getIndex();
    const count = position.count;
    this.growVertices(count);
    const base = this.vertexCount;
    const m = matrices;
    const inv = scale > 0 ? 1 / scale : 1;
    for (let i = 0; i < count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const v = base + i;
      this.positions[v * 3] =
        (m[offset] ?? 0) * x + (m[offset + 4] ?? 0) * y + (m[offset + 8] ?? 0) * z + (m[offset + 12] ?? 0);
      this.positions[v * 3 + 1] =
        (m[offset + 1] ?? 0) * x + (m[offset + 5] ?? 0) * y + (m[offset + 9] ?? 0) * z + (m[offset + 13] ?? 0);
      this.positions[v * 3 + 2] =
        (m[offset + 2] ?? 0) * x + (m[offset + 6] ?? 0) * y + (m[offset + 10] ?? 0) * z + (m[offset + 14] ?? 0);
      const nx = normal.getX(i);
      const ny = normal.getY(i);
      const nz = normal.getZ(i);
      let wx = ((m[offset] ?? 0) * nx + (m[offset + 4] ?? 0) * ny + (m[offset + 8] ?? 0) * nz) * inv;
      let wy = ((m[offset + 1] ?? 0) * nx + (m[offset + 5] ?? 0) * ny + (m[offset + 9] ?? 0) * nz) * inv;
      let wz = ((m[offset + 2] ?? 0) * nx + (m[offset + 6] ?? 0) * ny + (m[offset + 10] ?? 0) * nz) * inv;
      const length = Math.hypot(wx, wy, wz) || 1;
      wx /= length;
      wy /= length;
      wz /= length;
      this.normals[v * 3] = Math.round(wx * 32767);
      this.normals[v * 3 + 1] = Math.round(wy * 32767);
      this.normals[v * 3 + 2] = Math.round(wz * 32767);
      this.uvs[v * 2] = uv.getX(i);
      this.uvs[v * 2 + 1] = uv.getY(i);
      const tr = tint === null ? 1 : (tint[0] ?? 1);
      const tg = tint === null ? 1 : (tint[1] ?? 1);
      const tb = tint === null ? 1 : (tint[2] ?? 1);
      this.colors[v * 4] = Math.round(Math.min(1, color.getX(i) * tr) * 255);
      this.colors[v * 4 + 1] = Math.round(Math.min(1, color.getY(i) * tg) * 255);
      this.colors[v * 4 + 2] = Math.round(Math.min(1, color.getZ(i) * tb) * 255);
      this.colors[v * 4 + 3] = 255;
      this.masks[v * 4] = Math.round(Math.min(1, Math.max(0, masks.getX(i))) * 255);
      this.masks[v * 4 + 1] = Math.round(Math.min(1, Math.max(0, masks.getY(i))) * 255);
      this.masks[v * 4 + 2] = Math.round(Math.min(1, Math.max(0, masks.getZ(i))) * 255);
      this.masks[v * 4 + 3] = Math.round(Math.min(1, Math.max(0, masks.getW(i))) * 255);
      this.far[v * 2] = placementIndex;
      this.far[v * 2 + 1] = fogScale;
    }
    this.vertexCount += count;
    const indexCount = index !== null ? index.count : count;
    this.growIndices(indexCount);
    for (let i = 0; i < indexCount; i++) {
      this.indices[this.indexCount + i] = base + (index !== null ? index.getX(i) : i);
    }
    this.indexCount += indexCount;
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    const n = this.vertexCount;
    geometry.setAttribute('position', new BufferAttribute(this.positions.slice(0, n * 3), 3));
    geometry.setAttribute('normal', new BufferAttribute(this.normals.slice(0, n * 3), 3, true));
    geometry.setAttribute('uv', new BufferAttribute(this.uvs.slice(0, n * 2), 2));
    geometry.setAttribute('aColor', new BufferAttribute(this.colors.slice(0, n * 4), 4, true));
    geometry.setAttribute('aMasks', new BufferAttribute(this.masks.slice(0, n * 4), 4, true));
    geometry.setAttribute('aFar', new BufferAttribute(this.far.slice(0, n * 2), 2));
    geometry.setIndex(
      new BufferAttribute(
        n > 65535
          ? this.indices.slice(0, this.indexCount)
          : Uint16Array.from(this.indices.subarray(0, this.indexCount)),
        1,
      ),
    );
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/**
 * Leaves out the levels of the bundle's textures that are larger than the preset's
 * `maxTextureSize` (texture-mips.ts). At a field's creation that is before their first upload;
 * at a preset change they are freed and go up again at the new size on their next use. The
 * textures are shared by every field built from the bundle: the latest preset decides.
 */
function fitTextures(bundle: MapAssetBundle, preset: QualityPreset): void {
  for (const loaded of bundle.textures.values()) {
    fitTextureToLimit(loaded.texture, preset.maxTextureSize);
  }
}

/**
 * Builds the meshes for `placements` from a loaded bundle. Throws when the bundle lacks a type
 * the map places (the caller keeps its stand-in), leaving nothing allocated. Load-time:
 * allocates everything here.
 */
export function createPropField(
  placements: readonly MapPlacement[],
  bundle: MapAssetBundle,
  preset: QualityPreset,
): PropField {
  const stone = bundle.textures.get('stone');
  const masonry = bundle.textures.get('masonry') ?? stone;
  const moss = bundle.textures.get('moss') ?? stone;
  const cliff = bundle.textures.get('cliff') ?? stone;
  const brush = bundle.textures.get('brush') ?? stone;
  if (stone === undefined || masonry === undefined || moss === undefined || cliff === undefined || brush === undefined) {
    throw new Error('map assets: the "stone" texture is missing');
  }
  // Checked before anything is allocated: a bundle that does not fit the map leaves nothing
  // behind to free.
  const sets = buildPlacementInstances(placements);
  for (const set of sets) {
    const asset = bundle.assets.get(set.type.id);
    if (asset === undefined || asset.lods.length === 0) {
      throw new Error(`map assets: no geometry for "${set.type.id}"`);
    }
  }
  fitTextures(bundle, preset);

  const placementCount = placements.length;
  const farWidth = Math.max(1, placementCount);
  const farData = new Uint8Array(farWidth * 2);
  const farState = new DataTexture(farData, farWidth, 1, RGFormat, UnsignedByteType);
  farState.minFilter = NearestFilter;
  farState.magFilter = NearestFilter;
  farState.generateMipmaps = false;
  farState.needsUpdate = true;

  const materials: WorldMaterials = createWorldMaterials(
    { stone, masonry, moss, cliff, brush },
    farState,
    preset,
  );
  const teamLinear: readonly (readonly number[])[] = [
    srgbHexToLinear(TEAMS[TEAM_EMBER].color),
    srgbHexToLinear(TEAMS[TEAM_FROST].color),
    materials.shared.uTeam.value[TINT_NEUTRAL_INDEX]?.toArray() ?? [1, 1, 1],
  ];

  const object = new Group();
  object.name = 'map-props';
  object.matrixAutoUpdate = false;

  const types: TypeEntry[] = [];
  const builders = new Map<number, ClusterBuilder>();
  const clusterIndexOf = new Map<number, number>();
  const disposableGeometries: BufferGeometry[] = [];
  const instancedMeshes: InstancedMesh<BufferGeometry, ShaderMaterial>[] = [];
  const farClusters: FarCluster[] = [];
  let lod0Triangles = 0;
  let farTriangles = 0;
  let meshCount = 0;

  /** Frees everything this field put (or may have put) on the GPU. */
  function release(): void {
    // three frees an InstancedMesh's instance buffers and vertex array objects only when the
    // MESH is disposed; disposing its geometry and material is not enough.
    for (const mesh of instancedMeshes) mesh.dispose();
    instancedMeshes.length = 0;
    // The shared vertex attributes belong to the cached bundle; three re-uploads them on the
    // next use. Only the wrappers, the far meshes, the materials and the state texture go.
    for (const geometry of disposableGeometries) geometry.dispose();
    disposableGeometries.length = 0;
    materials.dispose();
    farState.dispose();
    object.clear();
    types.length = 0;
    farClusters.length = 0;
  }

  try {
    for (const set of sets) {
      const type = set.type;
      const asset = bundle.assets.get(type.id);
      if (asset === undefined || asset.lods.length === 0) {
        throw new Error(`map assets: no geometry for "${type.id}"`);
      }
      const isRock = type.kind === 'rock';
      const isBackdrop = type.kind === 'backdrop';
      const instancedLods = isBackdrop ? 0 : Math.min(asset.lods.length - 1, isRock ? 2 : 1);
      const farLod: PropLodGeometry | undefined = asset.lods[asset.lods.length - 1];
      if (farLod === undefined) throw new Error(`map assets: no far LOD for "${type.id}"`);
      const isCloth = type.hasTint && type.id.startsWith('banner');
      const height = type.boundsMax.y - type.boundsMin.y;
      const clothMaterial = isCloth
        ? materials.createCloth(
            type.boundsMax.y - height * 0.06,
            height * 0.85,
            height * CLOTH_SWING,
          )
        : null;

      const buckets: Bucket[] = [];
      for (let level = 0; level < instancedLods; level++) {
        const lod = asset.lods[level];
        if (lod === undefined) continue;
        const matrices = new InstancedBufferAttribute(new Float32Array(set.count * 16), 16);
        matrices.setUsage(DynamicDrawUsage);
        const inst = new InstancedBufferAttribute(new Float32Array(set.count * 4), 4);
        inst.setUsage(DynamicDrawUsage);
        const meshes: InstancedMesh<BufferGeometry, ShaderMaterial>[] = [];
        const slots: [BufferGeometry | null, ShaderMaterial][] = [
          [lod.stone, isRock ? materials.rock : materials.prop],
          [lod.tint, clothMaterial ?? materials.tint],
        ];
        for (const [source, material] of slots) {
          if (source === null) continue;
          const geometry = instancedGeometry(source, inst);
          disposableGeometries.push(geometry);
          const mesh = new InstancedMesh(geometry, material, set.count);
          mesh.instanceMatrix = matrices;
          mesh.name = `${type.id}-lod${level}-${material.name}`;
          mesh.matrixAutoUpdate = false;
          // Culled per instance in `update`; the mesh itself spans the map.
          mesh.frustumCulled = false;
          mesh.count = 0;
          mesh.visible = false;
          object.add(mesh);
          meshes.push(mesh);
          instancedMeshes.push(mesh);
          meshCount++;
        }
        buckets.push({
          meshes,
          matrices,
          inst,
          triangles: lod.triangles,
          count: 0,
          hash: 0,
          lastCount: -1,
          lastHash: 0,
        });
      }

      // Far tier: the last LOD of every instance into its cluster's builder.
      const clusters = new Uint16Array(set.count);
      for (let i = 0; i < set.count; i++) {
        const key = farClusterKey(
          set.spheres[i * 4] ?? 0,
          set.spheres[i * 4 + 2] ?? 0,
          FAR_CLUSTER_SIZE,
        );
        let clusterIndex = clusterIndexOf.get(key);
        let builder = builders.get(key);
        if (clusterIndex === undefined || builder === undefined) {
          clusterIndex = clusterIndexOf.size;
          clusterIndexOf.set(key, clusterIndex);
          builder = new ClusterBuilder();
          builders.set(key, builder);
        }
        clusters[i] = clusterIndex;
        const placementIndex = set.placementIndices[i] ?? 0;
        const scale = set.scales[i] ?? 1;
        const fogScale = isBackdrop ? BACKDROP_FOG_SCALE : 1;
        if (farLod.stone !== null) {
          builder.add(farLod.stone, set.matrices, i * 16, scale, placementIndex, fogScale, null);
        }
        if (farLod.tint !== null) {
          const team = set.teams[i] ?? PLACEMENT_TEAM_NEUTRAL;
          const tint =
            teamLinear[team === PLACEMENT_TEAM_NEUTRAL ? TINT_NEUTRAL_INDEX : team] ?? null;
          builder.add(farLod.tint, set.matrices, i * 16, scale, placementIndex, fogScale, tint);
        }
      }

      lod0Triangles += (asset.lods[0]?.triangles ?? 0) * set.count;
      farTriangles += farLod.triangles * set.count;
      types.push({
        set,
        buckets,
        isRock,
        cullable: type.kind === 'prop' && type.radius < CULLABLE_PROP_RADIUS,
        glowMode: type.id.startsWith('brazier') ? 1 : 0,
        clusters,
        farTriangles: farLod.triangles,
      });
    }

    for (const [key, builder] of builders) {
      const geometry = builder.build();
      disposableGeometries.push(geometry);
      const mesh = new Mesh(geometry, materials.far);
      mesh.name = `map-far-${key}`;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      object.add(mesh);
      farClusters[clusterIndexOf.get(key) ?? 0] = {
        mesh,
        triangles: builder.indexCount / 3,
        live: 0,
      };
      meshCount++;
    }
    builders.clear();
  } catch (error) {
    // A geometry the merge cannot read (an attribute missing, say): free what was built so far.
    release();
    throw error;
  }

  const stats: MutableStats = {
    meshCount,
    farClusters: farClusters.length,
    meshesDrawn: 0,
    trianglesDrawn: 0,
    lod0Instances: 0,
    lod1Instances: 0,
    farInstances: 0,
    lod0Triangles,
    farTriangles,
    placementCount,
  };

  let settings: PropLodSettings = propLodSettings(preset);
  let castShadows = preset.shadowCasters === 'all';

  function applyShadowFlags(): void {
    for (const entry of types) {
      const first = entry.buckets[0];
      if (first === undefined) continue;
      // Only LOD0 casts: the shadow map covers +-80 m, where nothing is at a lower LOD.
      for (const mesh of first.meshes) mesh.castShadow = castShadows;
    }
  }

  function writeInstance(
    bucket: Bucket,
    entry: TypeEntry,
    i: number,
    fade: number,
  ): void {
    const n = bucket.count++;
    const set = entry.set;
    const matrices = bucket.matrices.array;
    const src = set.matrices;
    const from = i * 16;
    const to = n * 16;
    for (let k = 0; k < 16; k++) matrices[to + k] = src[from + k] ?? 0;
    const inst = bucket.inst.array;
    const placementIndex = set.placementIndices[i] ?? 0;
    const team = set.teams[i] ?? PLACEMENT_TEAM_NEUTRAL;
    inst[n * 4] = fade;
    inst[n * 4 + 1] = (placementIndex * 0.618034) % 1;
    inst[n * 4 + 2] = entry.glowMode;
    inst[n * 4 + 3] = team === PLACEMENT_TEAM_NEUTRAL ? TINT_NEUTRAL_INDEX : team;
    const quantised = (fade * 127) | 0;
    bucket.hash = Math.imul(bucket.hash ^ (i * 256 + (quantised & 255)), 16777619) | 0;
  }

  function update(eye: Vec3, camera: Camera | null, timeS: number): void {
    materials.setTime(timeS);
    const cull = camera !== null;
    if (camera !== null) {
      camera.updateMatrixWorld();
      scratchMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      scratchFrustum.setFromProjectionMatrix(scratchMatrix);
      for (let p = 0; p < 6; p++) {
        const plane = scratchFrustum.planes[p];
        if (plane === undefined) continue;
        scratchPlanes[p * 4] = plane.normal.x;
        scratchPlanes[p * 4 + 1] = plane.normal.y;
        scratchPlanes[p * 4 + 2] = plane.normal.z;
        scratchPlanes[p * 4 + 3] = plane.constant;
      }
    }
    const ex = eye.x;
    const ey = eye.y;
    const ez = eye.z;
    for (let c = 0; c < farClusters.length; c++) {
      const cluster = farClusters[c];
      if (cluster !== undefined) cluster.live = 0;
    }
    let farChanged = false;
    let lod0 = 0;
    let lod1 = 0;
    let far = 0;
    let drawn = 0;
    let triangles = 0;

    for (let t = 0; t < types.length; t++) {
      const entry = types[t];
      if (entry === undefined) continue;
      const set = entry.set;
      const buckets = entry.buckets;
      const nearBucket = buckets[0];
      const midBucket = buckets[1];
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        if (bucket === undefined) continue;
        bucket.count = 0;
        bucket.hash = 0;
      }
      const spheres = set.spheres;
      for (let i = 0; i < set.count; i++) {
        const o = i * 4;
        const x = spheres[o] ?? 0;
        const y = spheres[o + 1] ?? 0;
        const z = spheres[o + 2] ?? 0;
        const radius = spheres[o + 3] ?? 0;
        const dx = x - ex;
        const dy = y - ey;
        const dz = z - ez;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const fades = pickTiers(
          scratchFades,
          distance,
          radius,
          buckets.length,
          entry.isRock,
          entry.cullable,
          settings,
        );
        if (fades.near !== 0 || fades.mid !== 0) {
          const hidden =
            cull &&
            distance - radius > settings.keepDistance &&
            sphereOutsidePlanes(scratchPlanes, x, y, z, radius);
          if (!hidden) {
            if (fades.near !== 0 && nearBucket !== undefined) {
              writeInstance(nearBucket, entry, i, fades.near);
              lod0++;
            }
            if (fades.mid !== 0 && midBucket !== undefined) {
              writeInstance(midBucket, entry, i, fades.mid);
              lod1++;
            }
          }
        }
        const f = (set.placementIndices[i] ?? 0) * 2;
        const before0 = farData[f];
        const before1 = farData[f + 1];
        encodeFarFade(fades.far, farData, f);
        if (farData[f] !== before0 || farData[f + 1] !== before1) farChanged = true;
        if (farData[f] !== 0) {
          far++;
          const cluster = farClusters[entry.clusters[i] ?? 0];
          if (cluster !== undefined) cluster.live++;
        }
      }
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        if (bucket === undefined) continue;
        const changed = bucket.count !== bucket.lastCount || bucket.hash !== bucket.lastHash;
        bucket.lastCount = bucket.count;
        bucket.lastHash = bucket.hash;
        if (changed && bucket.count > 0) {
          bucket.matrices.needsUpdate = true;
          bucket.inst.needsUpdate = true;
        }
        for (let m = 0; m < bucket.meshes.length; m++) {
          const mesh = bucket.meshes[m];
          if (mesh === undefined) continue;
          mesh.count = bucket.count;
          mesh.visible = bucket.count > 0;
          if (bucket.count > 0) drawn++;
        }
        triangles += bucket.triangles * bucket.count;
      }
    }

    if (farChanged) farState.needsUpdate = true;
    for (let c = 0; c < farClusters.length; c++) {
      const cluster = farClusters[c];
      if (cluster === undefined) continue;
      const visible = cluster.live > 0;
      cluster.mesh.visible = visible;
      if (visible) {
        drawn++;
        triangles += cluster.triangles;
      }
    }
    stats.lod0Instances = lod0;
    stats.lod1Instances = lod1;
    stats.farInstances = far;
    stats.meshesDrawn = drawn;
    stats.trianglesDrawn = triangles;
  }

  function setQuality(next: QualityPreset): void {
    settings = propLodSettings(next);
    castShadows = next.shadowCasters === 'all';
    materials.setQuality(next);
    applyShadowFlags();
    // A preset with another texture limit: the textures are freed and uploaded again at the
    // new size on their next use (a few milliseconds, at a settings change).
    fitTextures(bundle, next);
  }

  applyShadowFlags();

  return { object, stats, update, setQuality, dispose: release };
}
