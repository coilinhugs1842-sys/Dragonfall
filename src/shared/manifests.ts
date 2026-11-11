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
  /** Binary instance transforms (layout TBD in T-4.x). */
  readonly instances: string;
  readonly count: number;
}

export interface MapColliders {
  /** Low-poly collision mesh the sim builds its BVH from (no textures). */
  readonly terrain: string;
  /** Storm wall: a vertical cylinder around the arena. */
  readonly stormCenter: Vec3;
  readonly stormRadius: number;
  /** Flight ceiling and the cloud-sea floor, metres. */
  readonly ceilingY: number;
  readonly floorY: number;
}

export interface MapSky {
  /** 2:1 KTX2 panorama of distant clouds and mountains (no sun disk). */
  readonly panorama: string;
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
  readonly chunks: readonly MapChunk[];
  readonly props: readonly MapPropSet[];
  readonly sky: MapSky;
  readonly spawnGates: readonly SpawnGate[];
  readonly colliders: MapColliders;
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
