/**
 * The dragons of a match (T-4.4): every dragon of a WorldView drawn with the real, skinned,
 * animated assets, with the instanced placeholder as the far representation and the fallback.
 *
 * WHO DRAWS WHAT (per dragon, per frame; dragon-lod.ts)
 * - Skinned LOD0 / LOD1 / LOD2 by screen-size distance, with per-preset caps.
 * - FAR (beyond the last LOD distance, or over the skinned cap), or the class's GLB is still
 *   loading / failed to load: the placeholder dragon (placeholder-dragons.ts), which draws all
 *   such dragons of a class in one instanced call.
 *
 * COST
 * - One draw call per skinned dragon (the three material slots are merged, dragon-assets.ts),
 *   plus the same again in the sun shadow pass for those inside the shadow range. Ten dragons:
 *   at most 10 + 10 calls; triangles at Medium at most 2 x LOD0 + 8 x LOD1, about 35k.
 * - Geometry and textures are shared per class; a dragon owns a small "rig": 24 bones, one
 *   skeleton (a 24-matrix texture), three SkinnedMesh shells (one visible) and a material
 *   object that shares the one compiled program.
 * - Animation is our own baked-clip blend (dragon-animator.ts), not AnimationMixer: about
 *   3 clips x 24 quaternion lerps per dragon. Far dragons re-pose at 15-30 Hz, dragons outside
 *   the view (and outside shadow range) not at all.
 * - `update` allocates nothing. Rigs are pooled per class and only created the first time more
 *   dragons of a class are on screen than ever before (a spawn, never mid-fight churn).
 *
 * It reads ONLY the WorldView and the camera. Per-dragon memory is keyed by player id.
 */

import {
  Color,
  Frustum,
  Group,
  Matrix4,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3,
} from 'three';
import type { Bone, PerspectiveCamera } from 'three';
import {
  CLASS_TUNING,
  DRAGON_ANIM_CLIPS,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  FLIGHT_TUNING,
  TEAMS,
  TEAM_EMBER,
  TEAM_IDS,
} from '../shared';
import type {
  DragonAnimClip,
  DragonClassId,
  DragonView,
  PlayerId,
  QualityPreset,
  WorldView,
} from '../shared';
import {
  advanceDragonAnim,
  breathScale,
  createDragonAnimInput,
  createDragonAnimState,
  resetDragonAnimState,
  writeDragonPose,
} from './dragon-animator';
import type { DragonAnimState } from './dragon-animator';
import type { DragonAsset, DragonAssetLibrary } from './dragon-assets';
import { DRAGON_LOD_FAR, dragonLodPolicy, lodFovScale, selectDragonLods } from './dragon-lod';
import type { DragonLodPolicy } from './dragon-lod';
import {
  MEMBRANE_GLOW,
  RUNE_GLOW,
  createDragonMaterial,
  setDragonMaterialQuality,
} from './dragon-material';
import type { DragonMaterial } from './dragon-material';
import { writeInstanceMatrix } from './instance-matrix';
import { createPlaceholderDragons } from './placeholder-dragons';
import { bodyAngularVelocity, createPoseAccumulator, ease, saturate } from './pose-math';
import type { PoseAccumulator } from './pose-math';

const ID_SLOTS = 256;
const NO_TEAM = -1;
/** A longer frame than this (tab switch, hitch) is animated as this long, seconds. */
const MAX_ANIMATION_DT_S = 0.1;
/** Fraction of its pixels a veiled dragon keeps for the players who may still see it. */
const VEILED_FADE = 0.38;
/** The same for a dragon passing through terrain (phase dive). */
const PHASING_FADE = 0.55;
const HIT_FLASH_S = 0.16;
/** Health below this fraction starts to grey the hide; fully grey this much lower. */
const HURT_START = 0.38;
const HURT_RANGE = 0.28;
/** A health drop of at least this fraction is a hit worth a flinch and a flash. */
const HIT_THRESHOLD = 0.004;
/** Dragons nearer than this keep animating when off screen: their shadow is still visible. */
const SHADOW_ANIMATION_RANGE = 60;
/** Glow colours of the two teams (docs/ART_DIRECTION.md palette), sRGB hex by TeamId. */
const TEAM_GLOW_HEX: readonly number[] = [0xffb15c, 0xa8f0ff];
/** Smoothing of the measured angular velocity, per second. */
const ANGULAR_SMOOTHING = 12;

export interface DragonsOptions {
  /** Draw dragons whose ALIVE flag is clear (they play `death_fall`). Default false. */
  readonly showDead?: boolean;
  /**
   * Where the skinned assets come from (`sharedDragonAssetLibrary`). Null or absent: every
   * dragon is drawn as the placeholder.
   */
  readonly library?: DragonAssetLibrary | null;
}

/** Live numbers for the perf HUD. One object, mutated in place by `update`. */
export interface DragonsStats {
  /** Dragons drawn by the last `update` (skinned + far). */
  readonly dragons: number;
  readonly skinned: number;
  /** Dragons per level: LOD0, LOD1, LOD2, far. */
  readonly lods: readonly number[];
  /** Draw calls of the colour pass if every dragon is in view. */
  readonly drawCalls: number;
  readonly triangles: number;
  /** Skeleton poses written by the last `update`. */
  readonly posed: number;
  /** Rigs ever created (the pool size). */
  readonly rigs: number;
}

/** Viewer / test overrides. Every field optional; `setDebug(null)` clears them. */
export interface DragonsDebug {
  /** Force this level (0..2 skinned, 3 far) for every dragon. */
  readonly lod?: number;
  /** Play only this clip. */
  readonly clip?: DragonAnimClip | null;
  /** Hold the forced clip at this fraction (0..1) of its length. */
  readonly phase?: number;
  /** Show the material slots and the emissive mask instead of the lit colour. */
  readonly showSlots?: boolean;
}

export interface Dragons {
  /** Add to the scene once. */
  readonly object: Group;
  readonly stats: DragonsStats;
  /**
   * Per frame, after the WorldView is built and the camera is placed. `dtS` is the real frame
   * time. `camera` drives LOD and culling (null: everything near and in view).
   * `localPlayerId` defaults to `view.localDragonId`; it decides which veiled dragons are
   * hidden and which dragon is always LOD0.
   */
  update(
    view: WorldView,
    dtS: number,
    camera?: PerspectiveCamera | null,
    localPlayerId?: PlayerId,
  ): void;
  setQuality(preset: QualityPreset): void;
  setDebug(debug: DragonsDebug | null): void;
  /**
   * Wing-beat phase (0..1, 0 = top of the up-stroke) of a dragon drawn skinned this frame and
   * actually beating its wings; -1 otherwise. For syncing the flap sound.
   */
  flapPhase(id: PlayerId): number;
  /**
   * World position of a skinned dragon's muzzle (manifest `muzzleOffset`) into `out`; false
   * when the dragon is not drawn skinned this frame.
   */
  muzzleWorld(id: PlayerId, out: Vector3): boolean;
  dispose(): void;
}

interface Rig {
  readonly asset: DragonAsset;
  readonly root: Group;
  readonly bones: readonly Bone[];
  readonly skeleton: Skeleton;
  readonly meshes: readonly [SkinnedMesh, SkinnedMesh, SkinnedMesh];
  readonly material: DragonMaterial;
  readonly pose: PoseAccumulator;
}

interface Actor {
  readonly id: number;
  readonly anim: DragonAnimState;
  rig: Rig | null;
  lastSeenFrame: number;
  /** The level chosen on frame `lodFrame` (hysteresis needs last frame's). */
  lod: number;
  lodFrame: number;
  hasPrev: boolean;
  px: number;
  py: number;
  pz: number;
  pw: number;
  pitchRate: number;
  yawRate: number;
  rollRate: number;
  prevHealth: number;
  flash: number;
  cast: number;
  spawn: number;
  shield: number;
  dim: number;
  /** Seconds since the pose was last written. */
  poseAge: number;
  posed: boolean;
}

interface MutableStats {
  dragons: number;
  skinned: number;
  lods: number[];
  drawCalls: number;
  triangles: number;
  posed: number;
  rigs: number;
}

function createRig(asset: DragonAsset, preset: QualityPreset): Rig {
  const root = new Group();
  root.name = `dragon-${asset.classId}`;
  root.matrixAutoUpdate = false;
  root.visible = false;

  const boneRoot = asset.templateRoot.clone(true);
  const byName = new Map<string, Bone>();
  boneRoot.traverse((object) => {
    if ((object as Bone).isBone === true) byName.set(object.name, object as Bone);
  });
  const bones: Bone[] = [];
  for (const name of asset.boneNames) {
    const bone = byName.get(name);
    if (bone === undefined) throw new Error(`dragon rig: bone "${name}" missing from the template`);
    bones.push(bone);
  }
  // The inverse bind matrices are shared by every rig of the class (read-only).
  const skeleton = new Skeleton(bones, asset.boneInverses as Matrix4[]);
  const material = createDragonMaterial(asset.baseMap, asset.emissiveMap, preset.id);
  const identity = new Matrix4();
  const makeMesh = (level: 0 | 1 | 2): SkinnedMesh => {
    const mesh = new SkinnedMesh(asset.lods[level], material.material);
    mesh.name = `${asset.classId}-lod${level}`;
    // An explicit bind matrix: without one `bind` would recompute the shared inverses.
    mesh.bind(skeleton, identity);
    mesh.matrixAutoUpdate = false;
    // A fixed sphere that holds every pose: three would otherwise skin every vertex on the CPU
    // to find the bounds (and then never refresh them).
    mesh.boundingSphere = new Sphere(new Vector3(0, 0, 0), asset.radius);
    mesh.frustumCulled = true;
    mesh.visible = false;
    mesh.receiveShadow = false;
    return mesh;
  };
  const meshes: [SkinnedMesh, SkinnedMesh, SkinnedMesh] = [makeMesh(0), makeMesh(1), makeMesh(2)];
  root.add(boneRoot, meshes[0], meshes[1], meshes[2]);
  return {
    asset,
    root,
    bones,
    skeleton,
    meshes,
    material,
    pose: createPoseAccumulator(asset.boneCount),
  };
}

function applyPose(rig: Rig, breath: number): void {
  const quats = rig.pose.quats;
  const bones = rig.bones;
  for (let b = 0; b < bones.length; b++) {
    const o = b * 4;
    (bones[b] as Bone).quaternion.set(
      quats[o] as number,
      quats[o + 1] as number,
      quats[o + 2] as number,
      quats[o + 3] as number,
    );
  }
  const asset = rig.asset;
  const rp = rig.pose.rootPos;
  bones[asset.rootBone]?.position.set(rp[0] as number, rp[1] as number, rp[2] as number);
  if (asset.chestBone >= 0) bones[asset.chestBone]?.scale.setScalar(breath);
}

/** Creates the view. Load-time; call `setQuality` on preset changes. */
export function createDragons(preset: QualityPreset, options: DragonsOptions = {}): Dragons {
  const showDead = options.showDead ?? false;
  const library = options.library ?? null;

  const object = new Group();
  object.name = 'dragons';
  object.matrixAutoUpdate = false;

  const skipIds = new Uint8Array(ID_SLOTS);
  const placeholder = createPlaceholderDragons(preset, { showDead, skipIds });
  object.add(placeholder.object);

  let quality = preset;
  let policy: DragonLodPolicy = dragonLodPolicy(preset);
  let castShadows = preset.shadowCasters !== 'none';

  // Linear team colours, by TeamId.
  const teamColors: Color[] = [];
  const teamGlows: Color[] = [];
  for (const team of TEAM_IDS) {
    teamColors[team] = new Color().setHex(TEAMS[team].color);
    teamGlows[team] = new Color().setHex(TEAM_GLOW_HEX[team] ?? TEAMS[team].color);
  }
  const fallbackColor = teamColors[TEAM_EMBER] as Color;

  const actors: (Actor | undefined)[] = new Array<Actor | undefined>(ID_SLOTS).fill(undefined);
  /** Actors that hold a rig, for the release sweep. */
  const active: Actor[] = [];
  const freeRigs = new Map<DragonClassId, Rig[]>();
  for (const classId of DRAGON_CLASS_IDS) freeRigs.set(classId, []);
  const allRigs: Rig[] = [];

  // Per-frame scratch, sized for the most dragons a view can hold.
  const candidateIndex = new Int16Array(ID_SLOTS);
  const candidateDistance = new Float32Array(ID_SLOTS);
  const candidateScreen = new Float32Array(ID_SLOTS);
  const candidateLevel = new Int8Array(ID_SLOTS);
  const input = createDragonAnimInput();
  const angular = new Float32Array(3);
  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const cameraInverse = new Matrix4();
  const cameraPosition = new Vector3();
  const sphere = new Sphere();

  let frame = 0;
  let timeS = 0;
  let debugLod = -1;
  let debugClip = -1;
  let debugPhase = -1;
  let debugSlots = false;

  const stats: MutableStats = {
    dragons: 0,
    skinned: 0,
    lods: [0, 0, 0, 0],
    drawCalls: 0,
    triangles: 0,
    posed: 0,
    rigs: 0,
  };

  function actorOf(id: number): Actor {
    let actor = actors[id];
    if (actor === undefined) {
      actor = {
        id,
        anim: createDragonAnimState(),
        rig: null,
        lastSeenFrame: -2,
        lod: -1,
        lodFrame: -2,
        hasPrev: false,
        px: 0,
        py: 0,
        pz: 0,
        pw: 1,
        pitchRate: 0,
        yawRate: 0,
        rollRate: 0,
        prevHealth: 1,
        flash: 0,
        cast: 0,
        spawn: 0,
        shield: 0,
        dim: 0,
        poseAge: 1,
        posed: false,
      };
      actors[id] = actor;
    }
    return actor;
  }

  function releaseRig(actor: Actor): void {
    const rig = actor.rig;
    if (rig === null) return;
    rig.root.visible = false;
    freeRigs.get(rig.asset.classId)?.push(rig);
    actor.rig = null;
    actor.lod = -1;
  }

  function acquireRig(actor: Actor, asset: DragonAsset): Rig {
    const current = actor.rig;
    if (current !== null) {
      if (current.asset === asset) return current;
      releaseRig(actor);
    } else {
      active.push(actor);
    }
    let rig = freeRigs.get(asset.classId)?.pop();
    if (rig === undefined) {
      // Pool growth: the first time this many dragons of the class are on screen.
      rig = createRig(asset, quality);
      rig.material.uniforms.uDebug.value.r = debugSlots ? 1 : 0;
      for (const mesh of rig.meshes) mesh.castShadow = castShadows;
      allRigs.push(rig);
      object.add(rig.root);
      stats.rigs = allRigs.length;
    }
    actor.rig = rig;
    actor.posed = false;
    return rig;
  }

  function update(
    view: WorldView,
    dtS: number,
    camera?: PerspectiveCamera | null,
    localPlayerId?: PlayerId,
  ): void {
    const dt = dtS > 0 ? (dtS < MAX_ANIMATION_DT_S ? dtS : MAX_ANIMATION_DT_S) : 0;
    frame++;
    timeS += dt;

    const localId = localPlayerId ?? view.localDragonId;
    let localTeam = NO_TEAM;
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon !== undefined && dragon.id === localId) localTeam = dragon.team;
    }

    // --- Camera -------------------------------------------------------------------------------
    let fovScale = 1;
    const haveCamera = camera !== undefined && camera !== null;
    if (haveCamera) {
      camera.updateMatrixWorld();
      cameraPosition.setFromMatrixPosition(camera.matrixWorld);
      cameraInverse.copy(camera.matrixWorld).invert();
      viewProjection.multiplyMatrices(camera.projectionMatrix, cameraInverse);
      frustum.setFromProjectionMatrix(viewProjection);
      fovScale = lodFovScale(camera.fov / (camera.zoom > 0 ? camera.zoom : 1));
    }

    // --- Who is drawn, and at what level -------------------------------------------------------
    skipIds.fill(0);
    let count = 0;
    let localCandidate = -1;
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon === undefined) continue;
      const flags = dragon.flags;
      if ((flags & DRAGON_FLAG_ALIVE) === 0 && !showDead) continue;
      if (
        (flags & DRAGON_FLAG_VEILED) !== 0 &&
        localTeam !== NO_TEAM &&
        dragon.team !== localTeam
      ) {
        continue;
      }
      if (library === null || library.get(dragon.classId) === null) {
        // Loading, failed, or no library: the placeholder draws it.
        continue;
      }
      if (count >= ID_SLOTS) break;
      let distance = 0;
      if (haveCamera) {
        const p = dragon.position;
        const dx = p.x - cameraPosition.x;
        const dy = p.y - cameraPosition.y;
        const dz = p.z - cameraPosition.z;
        distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      const id = dragon.id & (ID_SLOTS - 1);
      const actor = actors[id];
      candidateIndex[count] = i;
      candidateDistance[count] = distance;
      candidateScreen[count] = distance * fovScale;
      candidateLevel[count] =
        actor !== undefined && actor.lodFrame === frame - 1 ? actor.lod : -1;
      if (dragon.id === localId) localCandidate = count;
      count++;
    }
    selectDragonLods(candidateScreen, candidateLevel, count, localCandidate, policy);

    // --- Skinned dragons ----------------------------------------------------------------------
    const lods = stats.lods;
    lods[0] = 0;
    lods[1] = 0;
    lods[2] = 0;
    let skinned = 0;
    let triangles = 0;
    let posedCount = 0;
    for (let c = 0; c < count; c++) {
      const dragon = view.dragons[candidateIndex[c] as number] as DragonView;
      let level = candidateLevel[c] as number;
      if (debugLod >= 0) level = debugLod;
      const id = dragon.id & (ID_SLOTS - 1);
      if (level >= DRAGON_LOD_FAR) {
        // The placeholder draws it (its id stays clear in `skipIds`).
        const actor = actors[id];
        if (actor !== undefined) {
          actor.lod = DRAGON_LOD_FAR;
          actor.lodFrame = frame;
        }
        continue;
      }
      const asset = library?.get(dragon.classId);
      if (asset === null || asset === undefined) continue;
      const actor = actorOf(id);
      const fresh = actor.lastSeenFrame !== frame - 1 || actor.rig === null;
      const rig = acquireRig(actor, asset);
      skipIds[id] = 1;
      actor.lastSeenFrame = frame;
      actor.lod = level;
      actor.lodFrame = frame;
      skinned++;
      lods[level] = (lods[level] as number) + 1;
      triangles += asset.lodTriangles[level] ?? 0;

      const flags = dragon.flags;
      const alive = (flags & DRAGON_FLAG_ALIVE) !== 0;
      const orientation = dragon.orientation;
      const velocity = dragon.velocity;

      // --- Transform --------------------------------------------------------------------------
      const root = rig.root;
      writeInstanceMatrix(root.matrix.elements, 0, dragon.position, orientation);
      root.matrixWorldNeedsUpdate = true;
      root.visible = true;
      const meshes = rig.meshes;
      meshes[0].visible = level === 0;
      meshes[1].visible = level === 1;
      meshes[2].visible = level === 2;

      // --- Animation inputs ---------------------------------------------------------------------
      if (fresh) {
        resetDragonAnimState(actor.anim, id);
        actor.hasPrev = false;
        actor.pitchRate = 0;
        actor.yawRate = 0;
        actor.rollRate = 0;
        actor.prevHealth = dragon.health;
        actor.flash = 0;
        actor.cast = 0;
        actor.spawn = (flags & DRAGON_FLAG_SPAWN_PROTECTED) !== 0 ? 1 : 0;
        actor.shield = (flags & DRAGON_FLAG_SHIELDED) !== 0 ? 1 : 0;
        actor.dim = alive ? 0 : 1;
        actor.poseAge = 1;
      }
      if (actor.hasPrev) {
        bodyAngularVelocity(
          angular,
          actor.px,
          actor.py,
          actor.pz,
          actor.pw,
          orientation.x,
          orientation.y,
          orientation.z,
          orientation.w,
          dt,
        );
        actor.pitchRate = ease(actor.pitchRate, angular[0] as number, ANGULAR_SMOOTHING, dt);
        actor.yawRate = ease(actor.yawRate, angular[1] as number, ANGULAR_SMOOTHING, dt);
        actor.rollRate = ease(actor.rollRate, angular[2] as number, ANGULAR_SMOOTHING, dt);
      }
      actor.px = orientation.x;
      actor.py = orientation.y;
      actor.pz = orientation.z;
      actor.pw = orientation.w;
      actor.hasPrev = true;

      const speed = Math.sqrt(
        velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
      );
      const cruise = FLIGHT_TUNING.cruiseSpeed * CLASS_TUNING[dragon.classId].speedScale;
      const speedRatio = cruise > 0 ? speed / cruise : 1;
      // Dragon-space +X (left) and +Z (forward) in the world: their Y parts give bank and climb.
      const leftY = 2 * (orientation.x * orientation.y + orientation.w * orientation.z);
      const forwardY = 2 * (orientation.y * orientation.z - orientation.w * orientation.x);
      const hit = alive && dragon.health < actor.prevHealth - HIT_THRESHOLD;
      actor.prevHealth = dragon.health;

      input.anim = dragon.anim;
      input.flags = flags;
      input.speedRatio = speedRatio;
      input.climb = speed > 1 ? velocity.y / speed : forwardY;
      input.roll = Math.asin(leftY < -1 ? -1 : leftY > 1 ? 1 : leftY);
      input.pitchRate = actor.pitchRate;
      input.yawRate = actor.yawRate;
      input.rollRate = actor.rollRate;
      input.hit = hit;
      const anim = actor.anim;
      anim.forceClip = debugClip;
      anim.forcePhase = debugPhase;
      advanceDragonAnim(anim, input, asset, dt);

      // --- Pose (throttled by level, skipped when neither it nor its shadow can be seen) -------
      actor.poseAge += dt;
      const distance = candidateDistance[c] as number;
      let inView = true;
      if (haveCamera) {
        sphere.center.set(dragon.position.x, dragon.position.y, dragon.position.z);
        sphere.radius = asset.radius;
        inView = frustum.intersectsSphere(sphere);
      }
      const hz = level === 0 ? 0 : level === 1 ? policy.lod1PoseHz : policy.lod2PoseHz;
      const due = hz <= 0 || actor.poseAge >= 1 / hz - 1e-4;
      const wanted = inView || (castShadows && distance < SHADOW_ANIMATION_RANGE);
      if (!actor.posed || (wanted && due)) {
        writeDragonPose(anim, asset, rig.pose, level < 2 || policy.lod2Procedural);
        applyPose(rig, breathScale(anim));
        actor.poseAge = 0;
        actor.posed = true;
        posedCount++;
      }

      // --- Look ---------------------------------------------------------------------------------
      if (hit) actor.flash = 1;
      else actor.flash = Math.max(0, actor.flash - dt / HIT_FLASH_S);
      const charging = alive && (flags & DRAGON_FLAG_CHARGING) !== 0;
      actor.cast = ease(actor.cast, charging ? 1 : 0, 10, dt);
      actor.spawn = ease(actor.spawn, (flags & DRAGON_FLAG_SPAWN_PROTECTED) !== 0 ? 1 : 0, 8, dt);
      actor.shield = ease(actor.shield, (flags & DRAGON_FLAG_SHIELDED) !== 0 ? 1 : 0, 10, dt);
      actor.dim = ease(actor.dim, alive ? 0 : 1, 4, dt);

      const veiled = (flags & DRAGON_FLAG_VEILED) !== 0;
      const fade = veiled ? VEILED_FADE : (flags & DRAGON_FLAG_PHASING) !== 0 ? PHASING_FADE : 1;
      const pulse = 0.5 + 0.5 * Math.sin(timeS * 17 + id);
      let glow = 1 + actor.cast * (0.6 + 1.4 * pulse) + actor.shield * 0.5;
      if (alive && (flags & DRAGON_FLAG_FIRING) !== 0) glow += 0.5;
      if (veiled) glow *= 0.25;
      glow *= 1 - 0.85 * actor.dim;
      const boost = alive && (flags & DRAGON_FLAG_BOOSTING) !== 0 ? 1.6 : 1;

      const uniforms = rig.material.uniforms;
      const team = teamColors[dragon.team] ?? fallbackColor;
      const teamGlow = teamGlows[dragon.team] ?? fallbackColor;
      uniforms.uTeam.value.set(team.r, team.g, team.b, 1);
      uniforms.uTeamGlow.value.set(teamGlow.r, teamGlow.g, teamGlow.b, 1);
      uniforms.uFx.value.set(MEMBRANE_GLOW * glow * boost, RUNE_GLOW * glow, actor.flash, fade);
      uniforms.uFx2.value.set(
        alive ? saturate((HURT_START - dragon.health) / HURT_RANGE) : 1,
        actor.shield,
        actor.spawn,
        timeS,
      );
      uniforms.uMotion.value.set(timeS, alive ? 0.35 + 0.65 * saturate(speedRatio) : 1, id * 1.7, 0);

      // A see-through dragon casts no shadow (and the far one never did).
      const cast = castShadows && fade >= 1;
      const mesh = meshes[level as 0 | 1 | 2];
      if (mesh.castShadow !== cast) mesh.castShadow = cast;
    }

    // --- Rigs whose dragon is gone, hidden or drawn far this frame --------------------------------
    for (let i = active.length - 1; i >= 0; i--) {
      const actor = active[i] as Actor;
      if (actor.lastSeenFrame === frame) continue;
      releaseRig(actor);
      active[i] = active[active.length - 1] as Actor;
      active.pop();
    }

    placeholder.update(view, dt, localId);

    lods[3] = placeholder.stats.dragons;
    stats.skinned = skinned;
    stats.dragons = skinned + placeholder.stats.dragons;
    stats.drawCalls = skinned + placeholder.stats.drawCalls;
    stats.triangles = triangles + placeholder.stats.triangles;
    stats.posed = posedCount;
  }

  function setQuality(next: QualityPreset): void {
    quality = next;
    policy = dragonLodPolicy(next);
    castShadows = next.shadowCasters !== 'none';
    for (const rig of allRigs) {
      setDragonMaterialQuality(rig.material, next.id);
      for (const mesh of rig.meshes) mesh.castShadow = castShadows;
    }
    placeholder.setQuality(next);
  }

  function setDebug(debug: DragonsDebug | null): void {
    debugLod = debug?.lod !== undefined && debug.lod >= 0 ? Math.min(3, Math.floor(debug.lod)) : -1;
    const clip = debug?.clip ?? null;
    debugClip = clip === null ? -1 : DRAGON_ANIM_CLIPS.indexOf(clip);
    debugPhase = debug?.phase !== undefined && debug.phase >= 0 ? Math.min(1, debug.phase) : -1;
    debugSlots = debug?.showSlots === true;
    for (const rig of allRigs) rig.material.uniforms.uDebug.value.r = debugSlots ? 1 : 0;
  }

  function flapPhase(id: PlayerId): number {
    const actor = actors[id & (ID_SLOTS - 1)];
    if (actor === undefined || actor.lastSeenFrame !== frame || actor.rig === null) return -1;
    return actor.anim.beatWeight > 0.3 ? actor.anim.beatPhase : -1;
  }

  function muzzleWorld(id: PlayerId, out: Vector3): boolean {
    const actor = actors[id & (ID_SLOTS - 1)];
    if (actor === undefined || actor.lastSeenFrame !== frame || actor.rig === null) return false;
    const muzzle = actor.rig.asset.muzzle;
    out.set(muzzle.x, muzzle.y, muzzle.z).applyMatrix4(actor.rig.root.matrix);
    return true;
  }

  function dispose(): void {
    for (const rig of allRigs) {
      rig.skeleton.dispose();
      rig.material.material.dispose();
      rig.root.removeFromParent();
    }
    allRigs.length = 0;
    active.length = 0;
    actors.fill(undefined);
    for (const list of freeRigs.values()) list.length = 0;
    placeholder.dispose();
    object.clear();
    // Geometry and textures belong to the asset library and outlive the match.
  }

  return { object, stats, update, setQuality, setDebug, flapPhase, muzzleWorld, dispose };
}
