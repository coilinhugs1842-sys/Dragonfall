/**
 * Loads the dragon GLBs (docs/ASSET_PIPELINE.md) and turns each into what the renderer wants:
 *
 * - ONE merged geometry per LOD. The GLB splits a LOD into three primitives (Hide, Membrane,
 *   Runes) that share one texture pair; they are merged and the slot becomes a vertex attribute
 *   (`aParams`), so a dragon is one draw call instead of three.
 * - The two textures (base colour, emissive mask), KTX2.
 * - Every clip baked to fixed-rate samples of local bone rotations (`BakedClip`), which the
 *   animator blends without an AnimationMixer.
 * - A template bone tree to clone per on-screen dragon.
 *
 * One load per class, cached for the life of the page: `get` answers synchronously (null while
 * loading or after a failure, and the caller draws the placeholder dragon instead), `load` /
 * `loadAll` give promises for a loading screen. The loaders themselves (GLTFLoader, KTX2Loader,
 * the meshopt decoder) are fetched as a separate chunk on first use. The KTX2 loader is the
 * page's shared one (src/world/props/shared-ktx2.ts), so a map that loads at the same moment
 * uses the same transcoder workers.
 *
 * Load-time code: it allocates freely. Nothing here runs per frame.
 */

import {
  AnimationMixer,
  Bone,
  BufferAttribute,
  BufferGeometry,
  LoopOnce,
  Matrix4,
  Quaternion,
  SRGBColorSpace,
} from 'three';
import type {
  AnimationClip,
  InterleavedBufferAttribute,
  Material,
  Object3D,
  SkinnedMesh,
  Texture,
  WebGLRenderer,
} from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { Ktx2Lease } from '../world/props/shared-ktx2';
import { DRAGON_ANIM_CLIPS, DRAGON_ANIM_ROAR, DRAGON_CLASS_IDS } from '../shared';
import type { AssetManifest, DragonClassId, DragonManifest, Vec3 } from '../shared';
// The file, not the `world/props` barrel: the barrel would pull the map loaders into this chunk.
import { fitTextureToLimit } from '../world/props/texture-mips';
import type { DragonAnimBones, DragonAnimRig } from './dragon-animator';
import type { BakedClip } from './pose-math';

/** Samples per second of the baked clips (the GLB clips are authored at 30 fps). */
export const DRAGON_BAKE_FPS = 30;

/**
 * The rider's cloak in the dragon atlas, as glTF UVs (`u0, v0, u1, v1`, v down): the `cloak`
 * rectangle of RECTS in tools/blender/dragons/dragonlib/geom.py (160, 832, 160 x 192 px of
 * 1024). v runs from the shoulders (v0) to the free end (v1). Vertices of the membrane slot
 * inside it get the flutter weight.
 */
export const CLOAK_UV_RECT: readonly [number, number, number, number] = [
  160 / 1024,
  832 / 1024,
  320 / 1024,
  1,
];

/** Fields the dragon generator adds to DragonManifest (all optional). */
export interface DragonManifestExtras {
  readonly clipInfo?: Readonly<
    Record<string, { readonly duration: number; readonly loop: boolean; readonly frames?: number }>
  >;
  readonly bodyLength?: number;
  readonly cloakSlot?: string;
}

export type DragonManifestFile = DragonManifest &
  DragonManifestExtras & {
    readonly bones: DragonManifest['bones'] & {
      readonly jaw?: string;
      readonly chest?: string;
      readonly hips?: string;
    };
  };

/** Clips that repeat, when the manifest has no `clipInfo`. */
const DEFAULT_LOOPS: Readonly<Record<string, boolean>> = {
  glide: true,
  flap: true,
  boost: true,
  dive: true,
  bank_l: true,
  bank_r: true,
  hover: true,
  death_fall: true,
  roar: false,
  land: false,
  takeoff: false,
  hit: false,
};

export interface DragonAsset extends DragonAnimRig {
  readonly classId: DragonClassId;
  readonly manifest: DragonManifestFile;
  /** Merged geometry per LOD (position, normal, uv, skinIndex, skinWeight, aParams). */
  readonly lods: readonly [BufferGeometry, BufferGeometry, BufferGeometry];
  readonly lodTriangles: readonly [number, number, number];
  readonly baseMap: Texture;
  readonly emissiveMap: Texture;
  /** Joint order of the skin: every per-bone array uses it. */
  readonly boneNames: readonly string[];
  /** The root of a bone tree in the rest pose; clone it (deep) per rig. Never add it to a scene. */
  readonly templateRoot: Bone;
  readonly boneInverses: readonly Matrix4[];
  /** Index of the chest bone (the breathing layer scales it), or -1. */
  readonly chestBone: number;
  /** Index of the bone that carries the root motion (the body bob). */
  readonly rootBone: number;
  /** Radius of a sphere at the dragon's origin that holds it in every pose, metres. */
  readonly radius: number;
  /** Dragon-space origin of breath and bolts. */
  readonly muzzle: Vec3;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`dragon manifest: ${what} must be a list of names`);
  }
  return value as string[];
}

/** Checks the fields the loader relies on. Throws with a readable message on a bad file. */
export function parseDragonManifest(json: unknown, classId: DragonClassId): DragonManifestFile {
  if (!isRecord(json)) throw new Error('dragon manifest: not an object');
  if (json['classId'] !== classId) {
    throw new Error(`dragon manifest: classId is "${String(json['classId'])}", wanted "${classId}"`);
  }
  if (typeof json['glb'] !== 'string' || json['glb'] === '') {
    throw new Error('dragon manifest: glb is missing');
  }
  const lods = json['lods'];
  if (!Array.isArray(lods) || lods.length !== 3) throw new Error('dragon manifest: 3 lods wanted');
  for (const lod of lods) {
    if (!isRecord(lod) || typeof lod['node'] !== 'string') {
      throw new Error('dragon manifest: a lod has no node name');
    }
  }
  const clips = json['clips'];
  if (!isRecord(clips)) throw new Error('dragon manifest: clips is missing');
  const bones = json['bones'];
  if (!isRecord(bones) || typeof bones['root'] !== 'string' || typeof bones['head'] !== 'string') {
    throw new Error('dragon manifest: bones.root / bones.head missing');
  }
  stringList(bones['neck'], 'bones.neck');
  stringList(bones['tail'], 'bones.tail');
  stringList(bones['wingLeft'], 'bones.wingLeft');
  stringList(bones['wingRight'], 'bones.wingRight');
  const tint = json['tintSlots'];
  if (
    !isRecord(tint) ||
    typeof tint['hide'] !== 'string' ||
    typeof tint['membrane'] !== 'string' ||
    typeof tint['runes'] !== 'string'
  ) {
    throw new Error('dragon manifest: tintSlots missing');
  }
  const muzzle = json['muzzleOffset'];
  if (!isRecord(muzzle) || typeof muzzle['z'] !== 'number') {
    throw new Error('dragon manifest: muzzleOffset missing');
  }
  return json as unknown as DragonManifestFile;
}

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

interface SlotMesh {
  readonly mesh: SkinnedMesh;
  readonly membrane: boolean;
  readonly runes: boolean;
}

/** Flutter weight (0..1) of a membrane-slot vertex from its UV; 0 outside the cloak. */
export function cloakFlutterWeight(u: number, v: number): number {
  const [u0, v0, u1, v1] = CLOAK_UV_RECT;
  if (u < u0 || u > u1 || v < v0 || v > v1) return 0;
  const along = (v - v0) / (v1 - v0);
  return along < 0 ? 0 : along > 1 ? 1 : along;
}

/** Merges the slot meshes of one LOD into a single geometry (see the file comment). */
function mergeLod(slots: readonly SlotMesh[]): { geometry: BufferGeometry; triangles: number } {
  let vertexCount = 0;
  let indexCount = 0;
  for (const slot of slots) {
    const g = slot.mesh.geometry;
    const position = g.getAttribute('position');
    vertexCount += position.count;
    indexCount += g.getIndex()?.count ?? position.count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const skinIndices = new Uint16Array(vertexCount * 4);
  const skinWeights = new Float32Array(vertexCount * 4);
  const params = new Uint8Array(vertexCount * 4);
  const indices =
    vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  let v = 0;
  let k = 0;
  for (const slot of slots) {
    const g = slot.mesh.geometry;
    const position = g.getAttribute('position') as AnyAttribute;
    const normal = g.getAttribute('normal') as AnyAttribute | undefined;
    const uv = g.getAttribute('uv') as AnyAttribute | undefined;
    const skinIndex = g.getAttribute('skinIndex') as AnyAttribute | undefined;
    const skinWeight = g.getAttribute('skinWeight') as AnyAttribute | undefined;
    const count = position.count;
    for (let i = 0; i < count; i++) {
      const o = v + i;
      positions[o * 3] = position.getX(i);
      positions[o * 3 + 1] = position.getY(i);
      positions[o * 3 + 2] = position.getZ(i);
      if (normal !== undefined) {
        normals[o * 3] = normal.getX(i);
        normals[o * 3 + 1] = normal.getY(i);
        normals[o * 3 + 2] = normal.getZ(i);
      }
      let tu = 0;
      let tv = 0;
      if (uv !== undefined) {
        tu = uv.getX(i);
        tv = uv.getY(i);
        uvs[o * 2] = tu;
        uvs[o * 2 + 1] = tv;
      }
      if (skinIndex !== undefined && skinWeight !== undefined) {
        let sum = 0;
        for (let c = 0; c < 4; c++) {
          const w = skinWeight.getComponent(i, c);
          skinIndices[o * 4 + c] = skinIndex.getComponent(i, c);
          skinWeights[o * 4 + c] = w;
          sum += w;
        }
        // Quantized weights rarely sum to exactly 1.
        if (sum > 1e-6) {
          for (let c = 0; c < 4; c++) {
            skinWeights[o * 4 + c] = (skinWeights[o * 4 + c] as number) / sum;
          }
        } else {
          skinWeights[o * 4] = 1;
        }
      }
      params[o * 4] = slot.membrane ? 255 : 0;
      params[o * 4 + 1] = slot.runes ? 255 : 0;
      params[o * 4 + 2] = slot.membrane ? Math.round(cloakFlutterWeight(tu, tv) * 255) : 0;
    }
    const index = g.getIndex();
    if (index !== null) {
      for (let i = 0; i < index.count; i++) indices[k++] = index.getX(i) + v;
    } else {
      for (let i = 0; i < count; i++) indices[k++] = i + v;
    }
    v += count;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeights, 4));
  geometry.setAttribute('aParams', new BufferAttribute(params, 4, true));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return { geometry, triangles: indexCount / 3 };
}

function collectSkinned(node: Object3D): SkinnedMesh[] {
  const found: SkinnedMesh[] = [];
  node.traverse((object) => {
    if ((object as SkinnedMesh).isSkinnedMesh === true) found.push(object as SkinnedMesh);
  });
  return found;
}

function materialOf(mesh: SkinnedMesh): Material & { map?: Texture | null; emissiveMap?: Texture | null } {
  const material = mesh.material;
  const one = Array.isArray(material) ? material[0] : material;
  if (one === undefined) throw new Error('dragon GLB: a mesh has no material');
  return one;
}

/** Samples `clip` on the bones (through a throwaway mixer) into a BakedClip. */
function bakeClip(
  mixer: AnimationMixer,
  clip: AnimationClip,
  name: string,
  loop: boolean,
  bones: readonly Bone[],
  rootBone: number,
  rest: Float32Array,
): BakedClip {
  const duration = clip.duration > 0 ? clip.duration : 1 / DRAGON_BAKE_FPS;
  const frameCount = Math.max(2, Math.round(duration * DRAGON_BAKE_FPS) + 1);
  const boneCount = bones.length;
  const quats = new Float32Array(frameCount * boneCount * 4);
  const rootPos = new Float32Array(frameCount * 3);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const root = bones[rootBone];
  for (let f = 0; f < frameCount; f++) {
    // A loop's last sample is its first: sample time 0 again rather than trust the last key.
    const t = loop && f === frameCount - 1 ? 0 : Math.min(f / DRAGON_BAKE_FPS, duration);
    action.paused = false;
    action.enabled = true;
    action.time = 0;
    mixer.setTime(0);
    mixer.update(t);
    for (let b = 0; b < boneCount; b++) {
      const q = (bones[b] as Bone).quaternion;
      const o = (f * boneCount + b) * 4;
      const r = b * 4;
      const dot =
        q.x * (rest[r] as number) +
        q.y * (rest[r + 1] as number) +
        q.z * (rest[r + 2] as number) +
        q.w * (rest[r + 3] as number);
      const s = dot < 0 ? -1 : 1;
      quats[o] = q.x * s;
      quats[o + 1] = q.y * s;
      quats[o + 2] = q.z * s;
      quats[o + 3] = q.w * s;
    }
    if (root !== undefined) {
      rootPos[f * 3] = root.position.x;
      rootPos[f * 3 + 1] = root.position.y;
      rootPos[f * 3 + 2] = root.position.z;
    }
  }
  action.stop();
  mixer.uncacheAction(clip);
  mixer.uncacheClip(clip);
  return { name, duration, loop, fps: DRAGON_BAKE_FPS, frameCount, boneCount, quats, rootPos };
}

function indexOfName(names: readonly string[], name: string | undefined): number {
  return name === undefined ? -1 : names.indexOf(name);
}

function indicesOf(names: readonly string[], wanted: readonly string[]): number[] {
  const out: number[] = [];
  for (const name of wanted) {
    const index = names.indexOf(name);
    if (index >= 0) out.push(index);
  }
  return out;
}

/**
 * Builds the runtime asset from a loaded GLB scene. Exported for tests and tools; the scene is
 * consumed (its skeleton's root bone is detached and kept as the template).
 */
export function buildDragonAsset(
  manifest: DragonManifestFile,
  scene: Object3D,
  animations: readonly AnimationClip[],
): DragonAsset {
  scene.updateMatrixWorld(true);

  // --- LOD meshes ---------------------------------------------------------------------------------
  const slotLists: SlotMesh[][] = [];
  let skinned: SkinnedMesh | undefined;
  for (const lod of manifest.lods) {
    const node = scene.getObjectByName(lod.node);
    if (node === undefined) throw new Error(`dragon GLB: node "${lod.node}" not found`);
    const meshes = collectSkinned(node);
    if (meshes.length === 0) throw new Error(`dragon GLB: "${lod.node}" has no skinned mesh`);
    skinned ??= meshes[0];
    slotLists.push(
      meshes.map((mesh) => {
        const name = materialOf(mesh).name;
        return {
          mesh,
          membrane: name === manifest.tintSlots.membrane,
          runes: name === manifest.tintSlots.runes,
        };
      }),
    );
  }
  if (skinned === undefined) throw new Error('dragon GLB: no skinned mesh');

  // --- Textures: every slot shares one pair -------------------------------------------------------
  let baseMap: Texture | null = null;
  let emissiveMap: Texture | null = null;
  const oldMaterials = new Set<Material>();
  const oldGeometries = new Set<BufferGeometry>();
  for (const slots of slotLists) {
    for (const slot of slots) {
      const material = materialOf(slot.mesh);
      oldMaterials.add(material);
      oldGeometries.add(slot.mesh.geometry);
      baseMap ??= material.map ?? null;
      emissiveMap ??= material.emissiveMap ?? null;
    }
  }
  if (baseMap === null) throw new Error('dragon GLB: no base colour texture');
  if (emissiveMap === null) throw new Error('dragon GLB: no emissive texture');
  baseMap.colorSpace = SRGBColorSpace;
  baseMap.anisotropy = 2;

  // --- Skeleton -----------------------------------------------------------------------------------
  const skeleton = skinned.skeleton;
  const bones = skeleton.bones;
  const boneCount = bones.length;
  const boneNames = bones.map((bone) => bone.name);
  const boneInverses = skeleton.boneInverses.map((m) => m.clone());
  const rootBone = Math.max(0, boneNames.indexOf(manifest.bones.root));
  const root = bones[rootBone];
  if (root === undefined) throw new Error('dragon GLB: the skin has no bones');

  const armature = root.parent;
  if (armature !== null) {
    const e = armature.matrixWorld.elements;
    const identity = new Matrix4().elements;
    if (e.some((value, i) => Math.abs(value - (identity[i] as number)) > 1e-4)) {
      console.warn(`dragon ${manifest.classId}: the armature node is not at identity`);
    }
  }

  const restQuats = new Float32Array(boneCount * 4);
  const parentRestWorld = new Float32Array(boneCount * 4);
  const scratch = new Quaternion();
  for (let b = 0; b < boneCount; b++) {
    const bone = bones[b] as Bone;
    bone.quaternion.toArray(restQuats, b * 4);
    if (bone.parent !== null) bone.parent.getWorldQuaternion(scratch);
    else scratch.identity();
    scratch.toArray(parentRestWorld, b * 4);
  }
  const restRootPos = new Float32Array([root.position.x, root.position.y, root.position.z]);

  // --- Clips --------------------------------------------------------------------------------------
  const mixer = new AnimationMixer(scene);
  const clips: (BakedClip | null)[] = [];
  for (const name of DRAGON_ANIM_CLIPS) {
    const clipName = manifest.clips[name];
    const source = animations.find((clip) => clip.name === clipName);
    if (source === undefined) {
      console.warn(`dragon ${manifest.classId}: clip "${clipName}" is not in the GLB`);
      clips.push(null);
      continue;
    }
    const loop = manifest.clipInfo?.[name]?.loop ?? DEFAULT_LOOPS[name] ?? true;
    clips.push(bakeClip(mixer, source, name, loop, bones, rootBone, restQuats));
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);
  for (let b = 0; b < boneCount; b++) {
    const bone = bones[b] as Bone;
    bone.quaternion.fromArray(restQuats, b * 4);
    bone.scale.set(1, 1, 1);
  }
  root.position.set(restRootPos[0] as number, restRootPos[1] as number, restRootPos[2] as number);

  // --- Jaw: the widest frame of the roar is "fully open" ------------------------------------------
  const jaw = indexOfName(boneNames, manifest.bones.jaw);
  const jawOpen = new Float32Array([0, 0, 0, 1]);
  const roar = clips[DRAGON_ANIM_ROAR];
  if (jaw >= 0 && roar != null) {
    const r = jaw * 4;
    const rest = new Quaternion().fromArray(restQuats, r);
    const sample = new Quaternion();
    let widest = 1;
    for (let f = 0; f < roar.frameCount; f++) {
      sample.fromArray(roar.quats, (f * roar.boneCount + jaw) * 4);
      const dot = Math.abs(sample.dot(rest));
      if (dot < widest) {
        widest = dot;
        // delta = conj(rest) * sample
        scratch.copy(rest).conjugate().multiply(sample).toArray(jawOpen, 0);
      }
    }
  }

  // --- Geometry -----------------------------------------------------------------------------------
  const merged = slotLists.map((slots) => mergeLod(slots));
  let radius = 0;
  const lod0Positions = (merged[0] as { geometry: BufferGeometry }).geometry.getAttribute(
    'position',
  );
  for (let i = 0; i < lod0Positions.count; i++) {
    const x = lod0Positions.getX(i);
    const y = lod0Positions.getY(i);
    const z = lod0Positions.getZ(i);
    radius = Math.max(radius, Math.sqrt(x * x + y * y + z * z));
  }
  // Margin for the poses that reach further than the rest pose (tail swing, body bob).
  radius *= 1.3;

  for (const geometry of oldGeometries) geometry.dispose();
  for (const material of oldMaterials) material.dispose();
  root.removeFromParent();

  const wingLeft = indicesOf(boneNames, manifest.bones.wingLeft);
  const wingRight = indicesOf(boneNames, manifest.bones.wingRight);
  const animBones: DragonAnimBones = {
    head: indexOfName(boneNames, manifest.bones.head),
    neck: indicesOf(boneNames, manifest.bones.neck),
    tail: indicesOf(boneNames, manifest.bones.tail),
    wristLeft: wingLeft[2] ?? -1,
    wristRight: wingRight[2] ?? -1,
    fingersLeft: wingLeft.slice(3),
    fingersRight: wingRight.slice(3),
    jaw,
  };

  const lods = merged.map((m) => m.geometry) as [BufferGeometry, BufferGeometry, BufferGeometry];
  const base = baseMap;
  const emissive = emissiveMap;
  return {
    classId: manifest.classId,
    manifest,
    lods,
    lodTriangles: merged.map((m) => m.triangles) as [number, number, number],
    baseMap: base,
    emissiveMap: emissive,
    boneNames,
    templateRoot: root,
    boneInverses,
    boneCount,
    clips,
    restQuats,
    restRootPos,
    parentRestWorld,
    animBones,
    jawOpen,
    chestBone: indexOfName(boneNames, manifest.bones.chest),
    rootBone,
    radius,
    muzzle: manifest.muzzleOffset,
    dispose(): void {
      for (const geometry of lods) geometry.dispose();
      base.dispose();
      emissive.dispose();
    },
  };
}

// --- Library ------------------------------------------------------------------------------------

export type DragonAssetStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface DragonAssetLibrary {
  /** The loaded asset, or null while it is loading / when it failed (draw the placeholder). */
  get(classId: DragonClassId): DragonAsset | null;
  status(classId: DragonClassId): DragonAssetStatus;
  /** Starts (or joins) the load of one class. Rejects when the files are missing or broken. */
  load(classId: DragonClassId): Promise<DragonAsset>;
  /** Loads every class; resolves when each has either loaded or failed. Never rejects. */
  loadAll(): Promise<void>;
  /** Bumped whenever a class finishes loading, so a view can notice without polling each one. */
  readonly revision: number;
  /**
   * Calls `listener` every time `revision` goes up, from the load's own continuation (between
   * frames, never inside one). Returns the function that removes it again.
   */
  subscribe(listener: () => void): () => void;
  /**
   * The preset's `maxTextureSize`: larger levels of the dragon textures are left out of the
   * upload (src/world/props/texture-mips.ts). Classes that load later come up at this size;
   * the ones already loaded are freed and uploaded again, so call it at load time or on a
   * preset change, not per frame. 0 (the start value) = no limit.
   */
  setMaxTextureSize(size: number): void;
  dispose(): void;
}

export interface DragonAssetLibraryOptions {
  /** Used to detect the GPU's compressed-texture formats and to upload textures at load. */
  readonly webgl: WebGLRenderer;
  /** URL of `public/assets/`, with a trailing slash. Default: `<base>assets/`. */
  readonly assetsUrl?: string;
  /** Folder of the Basis transcoder. Default: `<base>vendor/basis/`. */
  readonly transcoderUrl?: string;
  /**
   * Use this KTX2Loader (a viewer's own) instead of the page's shared one. The library then
   * never frees it.
   */
  readonly ktx2?: KTX2Loader;
}

interface Entry {
  status: DragonAssetStatus;
  asset: DragonAsset | null;
  promise: Promise<DragonAsset> | null;
}

function baseUrl(): string {
  const base: unknown = import.meta.env?.BASE_URL;
  return typeof base === 'string' && base !== '' ? base : '/';
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

export function createDragonAssetLibrary(options: DragonAssetLibraryOptions): DragonAssetLibrary {
  const webgl = options.webgl;
  const assetsUrl = options.assetsUrl ?? `${baseUrl()}assets/`;
  const transcoderUrl = options.transcoderUrl ?? `${baseUrl()}vendor/basis/`;
  const entries = new Map<DragonClassId, Entry>();
  let revision = 0;
  let disposed = false;
  /** `lease`: our hold on the page's shared KTX2 loader (null with `options.ktx2`). */
  let loaders: Promise<{ gltf: GLTFLoader; lease: Ktx2Lease | null }> | null = null;
  let rootManifest: Promise<AssetManifest> | null = null;
  let pending = 0;
  let maxTextureSize = 0;
  const listeners = new Set<() => void>();

  function bump(): void {
    revision++;
    for (const listener of listeners) listener();
  }

  /**
   * Upload now, at load time, instead of on the first frame the dragon is seen, and without
   * the levels the preset has no room for. A texture that is already up at the right size is
   * left alone.
   */
  function uploadTextures(asset: DragonAsset): void {
    fitTextureToLimit(asset.baseMap, maxTextureSize);
    fitTextureToLimit(asset.emissiveMap, maxTextureSize);
    webgl.initTexture(asset.baseMap);
    webgl.initTexture(asset.emissiveMap);
  }

  function entryOf(classId: DragonClassId): Entry {
    let entry = entries.get(classId);
    if (entry === undefined) {
      entry = { status: 'idle', asset: null, promise: null };
      entries.set(classId, entry);
    }
    return entry;
  }

  function getLoaders(): Promise<{ gltf: GLTFLoader; lease: Ktx2Lease | null }> {
    loaders ??= Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      // The file, not the `world/props` barrel (see the import of texture-mips above).
      import('../world/props/shared-ktx2'),
      import('three/addons/libs/meshopt_decoder.module.js'),
    ]).then(([gltfModule, shared, meshopt]) => {
      // One transcoder for the page: a map loading right now already holds the same loader.
      const lease = options.ktx2 === undefined ? shared.acquireKtx2(webgl, transcoderUrl) : null;
      const ktx2 = options.ktx2 ?? lease?.loader;
      if (ktx2 === undefined) throw new Error('no KTX2 loader');
      const gltf = new gltfModule.GLTFLoader()
        .setKTX2Loader(ktx2)
        .setMeshoptDecoder(meshopt.MeshoptDecoder);
      return { gltf, lease };
    });
    return loaders;
  }

  /** The transcoder workers are only needed while something is loading. */
  function releaseLoaders(): void {
    if (pending > 0 || loaders === null) return;
    const done = loaders;
    loaders = null;
    void done.then(
      ({ lease }) => {
        lease?.release();
      },
      // The loader chunk itself failed to arrive: nothing to free, and the load that wanted
      // it has already reported the error.
      () => undefined,
    );
  }

  async function loadClass(classId: DragonClassId): Promise<DragonAsset> {
    const manifestJob = (rootManifest ??= fetchJson(
      `${assetsUrl}manifest.json`,
    ) as Promise<AssetManifest>);
    let rootFile: AssetManifest;
    try {
      rootFile = await manifestJob;
    } catch (error) {
      // A failed fetch is not kept: the next load asks for the manifest again.
      if (rootManifest === manifestJob) rootManifest = null;
      throw error;
    }
    const manifestUrl = rootFile.dragons?.[classId];
    if (typeof manifestUrl !== 'string') {
      throw new Error(`assets manifest has no dragon "${classId}"`);
    }
    const manifest = parseDragonManifest(await fetchJson(assetsUrl + manifestUrl), classId);
    const { gltf } = await getLoaders();
    const file = await gltf.loadAsync(assetsUrl + manifest.glb);
    const asset = buildDragonAsset(manifest, file.scene, file.animations);
    if (!disposed) uploadTextures(asset);
    return asset;
  }

  function load(classId: DragonClassId): Promise<DragonAsset> {
    const entry = entryOf(classId);
    if (entry.promise !== null) return entry.promise;
    if (disposed) return Promise.reject(new Error('dragon asset library is disposed'));
    entry.status = 'loading';
    pending++;
    entry.promise = loadClass(classId).then(
      (asset) => {
        pending--;
        if (disposed) {
          asset.dispose();
          releaseLoaders();
          throw new Error('dragon asset library is disposed');
        }
        entry.asset = asset;
        entry.status = 'ready';
        releaseLoaders();
        bump();
        return asset;
      },
      (error: unknown) => {
        pending--;
        entry.status = 'failed';
        // Not kept: a later `load` (the next match) tries again instead of getting this
        // failure back for the rest of the page's life.
        entry.promise = null;
        releaseLoaders();
        bump();
        throw error;
      },
    );
    return entry.promise;
  }

  return {
    get(classId) {
      return entries.get(classId)?.asset ?? null;
    },
    status(classId) {
      return entries.get(classId)?.status ?? 'idle';
    },
    load,
    loadAll(): Promise<void> {
      return Promise.all(
        DRAGON_CLASS_IDS.map((classId) =>
          load(classId).catch((error: unknown) => {
            console.warn(`Dragon "${classId}" failed to load; using the placeholder.`, error);
          }),
        ),
      ).then(() => undefined);
    },
    get revision() {
      return revision;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMaxTextureSize(size: number): void {
      if (disposed || size === maxTextureSize) return;
      maxTextureSize = size;
      for (const entry of entries.values()) {
        if (entry.asset !== null) uploadTextures(entry.asset);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      for (const entry of entries.values()) {
        entry.asset?.dispose();
        entry.asset = null;
        entry.status = 'idle';
      }
      releaseLoaders();
    },
  };
}

const sharedLibraries = new WeakMap<WebGLRenderer, DragonAssetLibrary>();

/**
 * The page's one library for a renderer: created (and the load of every class started) on the
 * first call, then shared by every stage and viewer. It lives as long as the renderer.
 *
 * `after`: start loading only once this settles. The stage passes the default map's asset
 * load: the map is needed first. (Both borrow the page's one KTX2 loader, so a load that does
 * overlap, such as another map's at a match start, shares its transcoder workers.)
 */
export function sharedDragonAssetLibrary(
  webgl: WebGLRenderer,
  after?: Promise<unknown>,
): DragonAssetLibrary {
  let library = sharedLibraries.get(webgl);
  if (library === undefined) {
    const created = createDragonAssetLibrary({ webgl });
    library = created;
    sharedLibraries.set(webgl, created);
    const start = (): void => {
      void created.loadAll();
    };
    if (after === undefined) start();
    else after.then(start, start);
  }
  return library;
}
