/**
 * Stand-ins for a loaded dragon, for the node tests of the animator and the dragon view: a rig
 * of eighteen bones with made-up (but well-formed) baked clips, and an asset library that
 * loads when the test says so. No GLB, no WebGL.
 */

import { Bone, BufferAttribute, BufferGeometry, DataTexture, Matrix4 } from 'three';
import { DRAGON_ANIM_CLIPS } from '../../src/shared';
import type { DragonClassId } from '../../src/shared';
import type {
  DragonAnimRig,
  DragonAsset,
  DragonAssetLibrary,
  DragonAssetStatus,
  DragonManifestFile,
} from '../../src/dragons';
import type { BakedClip } from '../../src/dragons';

export const FAKE_BONE_NAMES = [
  'root',
  'chest',
  'neck0',
  'neck1',
  'head',
  'jaw',
  'tail0',
  'tail1',
  'tail2',
  'tail3',
  'wristL',
  'wristR',
  'fingerL0',
  'fingerL1',
  'fingerL2',
  'fingerR0',
  'fingerR1',
  'fingerR2',
] as const;
export const FAKE_BONE_COUNT = FAKE_BONE_NAMES.length;

const ONE_SHOTS = new Set(['roar', 'land', 'takeoff', 'hit']);
const FPS = 30;

/** A clip whose bones swing a few tenths of a radian about changing axes, w > 0 throughout. */
export function fakeClip(index: number, durationS: number): BakedClip {
  const name = DRAGON_ANIM_CLIPS[index] ?? `clip${index}`;
  const loop = !ONE_SHOTS.has(name);
  const frameCount = Math.round(durationS * FPS) + 1;
  const quats = new Float32Array(frameCount * FAKE_BONE_COUNT * 4);
  const rootPos = new Float32Array(frameCount * 3);
  for (let f = 0; f < frameCount; f++) {
    // A loop's last sample equals its first.
    const turn = (f / (frameCount - 1)) * Math.PI * 2;
    for (let b = 0; b < FAKE_BONE_COUNT; b++) {
      const angle = 0.15 * (index + 1) * 0.2 + 0.35 * Math.sin(turn + b * 0.7 + index);
      const axis = (b + index) % 3;
      const o = (f * FAKE_BONE_COUNT + b) * 4;
      quats[o + axis] = Math.sin(angle / 2);
      quats[o + 3] = Math.cos(angle / 2);
    }
    rootPos[f * 3] = 0.1 * index;
    rootPos[f * 3 + 1] = 0.5 * Math.sin(turn) + index;
    rootPos[f * 3 + 2] = -0.05 * index;
  }
  return {
    name,
    duration: durationS,
    loop,
    fps: FPS,
    frameCount,
    boneCount: FAKE_BONE_COUNT,
    quats,
    rootPos,
  };
}

/** What the animator needs of a dragon. `missing` lists clip indices the "GLB" did not have. */
export function fakeAnimRig(missing: readonly number[] = []): DragonAnimRig {
  const clips: (BakedClip | null)[] = [];
  for (let i = 0; i < DRAGON_ANIM_CLIPS.length; i++) {
    clips.push(missing.includes(i) ? null : fakeClip(i, 0.6 + 0.1 * i));
  }
  const restQuats = new Float32Array(FAKE_BONE_COUNT * 4);
  const parentRestWorld = new Float32Array(FAKE_BONE_COUNT * 4);
  for (let b = 0; b < FAKE_BONE_COUNT; b++) {
    restQuats[b * 4 + 3] = 1;
    // Parents turned a little about Y, as a real rig's are not all axis-aligned.
    const angle = 0.2 * b;
    parentRestWorld[b * 4 + 1] = Math.sin(angle / 2);
    parentRestWorld[b * 4 + 3] = Math.cos(angle / 2);
  }
  const jawAngle = 0.5;
  return {
    boneCount: FAKE_BONE_COUNT,
    clips,
    restQuats,
    restRootPos: new Float32Array([0, 1, 0]),
    parentRestWorld,
    animBones: {
      head: 4,
      neck: [2, 3],
      tail: [6, 7, 8, 9],
      wristLeft: 10,
      wristRight: 11,
      fingersLeft: [12, 13, 14],
      fingersRight: [15, 16, 17],
      jaw: 5,
    },
    jawOpen: new Float32Array([Math.sin(jawAngle / 2), 0, 0, Math.cos(jawAngle / 2)]),
  };
}

function fakeGeometry(triangles: number): BufferGeometry {
  const vertices = triangles * 3;
  const geometry = new BufferGeometry();
  const position = new Float32Array(vertices * 3);
  for (let i = 0; i < position.length; i++) position[i] = Math.sin(i * 1.3);
  const skinWeight = new Float32Array(vertices * 4);
  for (let v = 0; v < vertices; v++) skinWeight[v * 4] = 1;
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(vertices * 4), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  return geometry;
}

/** A dragon as `buildDragonAsset` would hand it over, small enough to build hundreds of. */
export function fakeDragonAsset(classId: DragonClassId): DragonAsset {
  const templateRoot = new Bone();
  templateRoot.name = FAKE_BONE_NAMES[0];
  for (let b = 1; b < FAKE_BONE_COUNT; b++) {
    const bone = new Bone();
    bone.name = FAKE_BONE_NAMES[b] as string;
    templateRoot.add(bone);
  }
  const boneInverses: Matrix4[] = [];
  for (let b = 0; b < FAKE_BONE_COUNT; b++) boneInverses.push(new Matrix4());
  const lods: [BufferGeometry, BufferGeometry, BufferGeometry] = [
    fakeGeometry(8),
    fakeGeometry(4),
    fakeGeometry(2),
  ];
  const baseMap = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const emissiveMap = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  return {
    ...fakeAnimRig(),
    classId,
    // The view never reads the manifest; only the loader does.
    manifest: { id: classId } as unknown as DragonManifestFile,
    lods,
    lodTriangles: [8, 4, 2],
    baseMap,
    emissiveMap,
    boneNames: FAKE_BONE_NAMES,
    templateRoot,
    boneInverses,
    chestBone: 1,
    rootBone: 0,
    radius: 6,
    muzzle: { x: 0, y: 0.5, z: 3 },
    dispose(): void {
      for (const geometry of lods) geometry.dispose();
      baseMap.dispose();
      emissiveMap.dispose();
    },
  };
}

export interface FakeDragonLibrary extends DragonAssetLibrary {
  /** The class finishes loading now (as the real library: status, revision, listeners). */
  arrive(classId: DragonClassId): DragonAsset;
  /** The class's load fails now. */
  fail(classId: DragonClassId): void;
  /** Classes `load` was called for, in order. */
  readonly loadCalls: DragonClassId[];
  /** Sizes `setMaxTextureSize` was called with, in order. */
  readonly textureSizes: number[];
  readonly listenerCount: number;
}

/** An asset library whose loads finish when the test calls `arrive` or `fail`. */
export function fakeDragonLibrary(): FakeDragonLibrary {
  const assets = new Map<DragonClassId, DragonAsset>();
  const statuses = new Map<DragonClassId, DragonAssetStatus>();
  const listeners = new Set<() => void>();
  const loadCalls: DragonClassId[] = [];
  const textureSizes: number[] = [];
  let revision = 0;
  const bump = (): void => {
    revision++;
    for (const listener of listeners) listener();
  };
  return {
    loadCalls,
    textureSizes,
    get listenerCount() {
      return listeners.size;
    },
    get revision() {
      return revision;
    },
    get: (classId) => assets.get(classId) ?? null,
    status: (classId) => statuses.get(classId) ?? 'idle',
    load(classId) {
      loadCalls.push(classId);
      const asset = assets.get(classId);
      if (asset !== undefined) return Promise.resolve(asset);
      statuses.set(classId, 'loading');
      // Never settles by itself: the test decides with `arrive` / `fail`.
      return new Promise<DragonAsset>(() => undefined);
    },
    loadAll: () => Promise.resolve(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMaxTextureSize(size) {
      textureSizes.push(size);
    },
    dispose() {
      listeners.clear();
    },
    arrive(classId) {
      const asset = fakeDragonAsset(classId);
      assets.set(classId, asset);
      statuses.set(classId, 'ready');
      bump();
      return asset;
    },
    fail(classId) {
      statuses.set(classId, 'failed');
      bump();
    },
  };
}
