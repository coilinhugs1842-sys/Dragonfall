/**
 * Asset manifests: which runtime files to load and the gameplay metadata that goes with them
 * (docs/ASSET_PIPELINE.md). The pipeline tools write these as JSON under public/assets; the
 * loaders in world/ and dragons/ and the sim (gates, colliders) read them.
 * All URLs are relative to `public/assets/`.
 *
 * The exact JSON layout is TBD in T-4.x (pipeline tooling): treat optional fields as "not
 * produced yet" and keep additions backwards compatible.
 */

import type { DragonClassId } from './classes';
import type { TeamId } from './constants';
import type { MapPlacement } from './maps/placements';
import type { MapSolid } from './maps/solids';
import type { MapId } from './match';
import type { Quat, Vec3 } from './math-types';
import type { DragonAnimClip } from './world-view';

// --- Dragons ------------------------------------------------------------------------------------

/** Bone names the procedural animation layer drives on top of the baked clips. */
export interface DragonBones {
  readonly root: string;
  readonly head: string;
  /** Root to tip. */
  readonly neck: readonly string[];
  readonly wingLeft: readonly string[];
  readonly wingRight: readonly string[];
  readonly tail: readonly string[];
}

/** Material slot names split in Blender so runtime team tinting can find them. */
export interface DragonTintSlots {
  readonly hide: string;
  readonly membrane: string;
  readonly runes: string;
}

export interface DragonLod {
  /** Node name inside the GLB (`LOD0`..`LOD2`). */
  readonly node: string;
  /**
   * Set only if this LOD ships as its own file; by default all LODs are nodes of
   * `DragonManifest.glb`.
   */
  readonly url?: string;
  readonly triangles: number;
}

export interface DragonManifest {
  readonly classId: DragonClassId;
  /** e.g. `dragons/talon/talon.glb`. */
  readonly glb: string;
  /** LOD0, LOD1, LOD2 (about 8k / 3k / 1k triangles). */
  readonly lods: readonly [DragonLod, DragonLod, DragonLod];
  /** Sprite shown beyond the last LOD distance. */
  readonly impostor?: string;
  /** Animation state name -> clip name in the GLB (normally identical). */
  readonly clips: Readonly<Record<DragonAnimClip, string>>;
  readonly bones: DragonBones;
  readonly tintSlots: DragonTintSlots;
  /** Metres, for the scale check (about 14). */
  readonly wingspan: number;
  /** Dragon-space offset of the breath/projectile origin. */
  readonly muzzleOffset: Vec3;
  /** Where this asset came from in art-source/ (LOG.md entry), for traceability. */
  readonly source?: string;
}

// --- Maps ---------------------------------------------------------------------------------------

/** A team's aerie gate: where its riders spawn and respawn. Gates are mirror-balanced. */
export interface SpawnGate {
  readonly team: TeamId;
  readonly position: Vec3;
  /** Launch direction. */
  readonly orientation: Quat;
  /** One spawn point per rider (MAX_TEAM_SIZE), world space. */
  readonly slots: readonly Vec3[];
}

/** Merged static geometry for one world chunk (about 250 m). */
export interface MapChunk {
  readonly id: string;
  /** One URL per LOD, nearest first (2-3 entries). */
  readonly lods: readonly string[];
  /** Bounding sphere, for culling and LOD selection without loading the mesh. */
  readonly center: Vec3;
  readonly radius: number;
}

/** One instanced prop type and where its instances are. */
export interface MapPropSet {
  readonly id: string;
  readonly glb: string;
  /**
   * Binary instance transforms: `count` 4x4 matrices, 16 little-endian float32 each, column-major
   * (three.js `InstancedMesh.instanceMatrix`). Baked from `MapManifest.placements` for tools; at
   * runtime `buildPlacementInstances(map.placements)` gives the same data without a fetch.
   */
  readonly instances: string;
  readonly count: number;
  /** `rock` | `prop` | `gate` | `backdrop` (T-4.5). Absent = prop. */
  readonly kind?: string;
  /** Triangles per LOD node (`LOD0`, `LOD1`, ...) of the GLB, nearest first. */
  readonly lodTriangles?: readonly number[];
  /** The GLB has a second material `TeamTint` that takes the instance's team colour. */
  readonly hasTint?: boolean;
  /** Bounding sphere radius of one instance at scale 1, metres. */
  readonly radius?: number;
}

/** A shared tileable texture a map's materials use (public/assets/textures/textures.json). */
export interface MapTexture {
  readonly id: string;
  /** KTX2, relative to `public/assets/`. */
  readonly url: string;
  /** World metres one repeat should cover (triplanar or UV scale). */
  readonly tileMetres: number;
  /** Mean colour, linear RGB: `texel / mean` is a detail factor for painted vertex colours. */
  readonly meanLinear: readonly number[];
  readonly colorSpace: 'srgb' | 'linear';
}

export interface MapColliders {
  /**
   * Low-poly collision mesh the sim builds its BVH from (no textures). Absent on a greybox map,
   * whose collision mesh is triangulated from `MapManifest.solids` instead.
   */
  readonly terrain?: string;
  /**
   * Storm wall: a vertical cylinder around the arena, from `floorY` to `ceilingY`. The sim seeds
   * the `stormWall` zone (world-view.ts) from `stormCenter` + `stormRadius`.
   */
  readonly stormCenter: Vec3;
  readonly stormRadius: number;
  /** Flight ceiling and the hazard floor inside the cloud sea, world Y in metres. */
  readonly ceilingY: number;
  readonly floorY: number;
  /**
   * World Y of the cloud-sea surface the view draws. At or a little above `floorY`, so a dragon
   * can skim the cloud tops before the floor hazard applies. Defaults to `floorY` when absent.
   */
  readonly cloudSeaY?: number;
}

export interface MapSky {
  /**
   * 2:1 KTX2 panorama of distant clouds and mountains (no sun disk). Absent on a greybox map:
   * the view falls back to its procedural gradient sky.
   */
  readonly panorama?: string;
  /** Unit vector pointing toward the sun. */
  readonly sunDirection: Vec3;
  /** sRGB hex. */
  readonly sunColor: number;
  readonly fogColor: number;
  readonly fogDensity: number;
}

export interface MapAudio {
  readonly ambience: readonly string[];
  readonly music: readonly string[];
}

export interface MapManifest {
  readonly id: MapId;
  readonly name: string;
  /** Playable extent in metres (Shattered Spires is 2000 x 2000). */
  readonly size: number;
  /** Authored chunk files. Empty on a greybox map (see `solids`). */
  readonly chunks: readonly MapChunk[];
  readonly props: readonly MapPropSet[];
  readonly sky: MapSky;
  /** One gate per team, indexed by TeamId. */
  readonly spawnGates: readonly SpawnGate[];
  readonly colliders: MapColliders;
  /**
   * Greybox geometry as primitive solids. When present, both the collision mesh and the render
   * meshes are built from it with `buildMapTriangles` (src/shared/maps), instead of from
   * `colliders.terrain` and `chunks`.
   */
  readonly solids?: readonly MapSolid[];
  /**
   * Placed assets of a real map (T-4.5): hero rocks, props, gates and backdrop pieces, one entry
   * per instance. When present, collision is built from the asset types' hulls at these
   * transforms (`buildMapTriangles`, src/shared/maps) and the view draws the GLBs of `props` at
   * the same transforms; `solids`, `chunks` and `colliders.terrain` are then unused.
   */
  readonly placements?: readonly MapPlacement[];
  /**
   * Gates for Duel, closer to the centre than `spawnGates` so the per-round storm fractions
   * apply (DECISIONS 34). Indexed by TeamId; absent = Duel uses `spawnGates`.
   */
  readonly duelSpawnGates?: readonly SpawnGate[];
  /** Shared tileable textures the map's materials use. */
  readonly textures?: readonly MapTexture[];
  /** Edge of a world chunk in metres (about 250, docs/PERFORMANCE.md); the grid spans `size`. */
  readonly chunkSize?: number;
  /** Camera path for the match-intro flyby (format TBD in T-5.x). */
  readonly introSpline?: readonly Vec3[];
  readonly audio?: MapAudio;
}

// --- Root manifest (public/assets/manifest.json) ---------------------------------------------------

/** "What exists": the entry point that lists every per-asset manifest. */
export interface AssetManifest {
  readonly version: number;
  /** Class id -> URL of its DragonManifest JSON. */
  readonly dragons: Readonly<Partial<Record<DragonClassId, string>>>;
  /** Map id -> URL of its MapManifest JSON. */
  readonly maps: Readonly<Partial<Record<MapId, string>>>;
}

/**
 * File and size budgets from the "Budgets summary" table of docs/ASSET_PIPELINE.md, for the
 * inspect tooling and tests.
 *
 * Deliberately NOT here: the "Map total" row's on-screen triangle and VRAM figures. Those are
 * per-quality scene budgets and their single source is QUALITY_PRESETS (`maxTriangles`,
 * `textureVramBudgetMb`), which follows docs/PERFORMANCE.md. Check maps against those.
 */
export const ASSET_BUDGETS = {
  dragonLodTriangles: [8_000, 3_000, 1_000],
  dragonMaxTextureSize: 1024,
  dragonMaxFileBytes: 2 * 1024 * 1024,
  dragonMaxBones: 24,
  heroRockLodTriangles: [8_000, 3_000, 800],
  heroRockMaxFileBytes: 1024 * 1024,
  propMaxTriangles: 3_000,
  propMaxFileBytes: 300 * 1024,
  skyPanoramaMaxFileBytes: 6 * 1024 * 1024,
  mapMaxDownloadBytes: 60 * 1024 * 1024,
  mapMaxAudioBytes: 15 * 1024 * 1024,
} as const;
