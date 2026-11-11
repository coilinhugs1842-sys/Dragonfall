/**
 * Placeholder dragons (T-1.8): every dragon of a WorldView drawn from a fixed pool, with wings
 * that flap in the vertex shader.
 *
 * COST: one `InstancedMesh` per class (4 in total, each with room for MAX_PLAYERS), all sharing
 * ONE patched `MeshLambertMaterial`. A frame costs at most 4 draw calls for 10 dragons (one per
 * class that is present) and about 1.7k triangles, plus the same again in the shadow pass on
 * presets where dragons cast shadows. Nothing is created or destroyed during play, and `update`
 * allocates nothing: it writes instance matrices and two small instanced attributes.
 *
 * It reads ONLY the WorldView: the pose comes from `position` + `orientation` (dragon space:
 * +Z forward, +Y up, +X left), the wing animation from `anim`, `flags` and the length of
 * `velocity`. Per-dragon animation memory is keyed by `id`; no WorldView object is kept.
 *
 * QUALITY: the mesh is a single ~170-triangle LOD at every preset (cheaper than any LOD switch
 * would be); the preset only decides whether dragons render into the sun shadow map.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshDepthMaterial,
  MeshLambertMaterial,
} from 'three';
import {
  CLASS_TUNING,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  FLIGHT_TUNING,
  MAX_PLAYERS,
  TEAMS,
  TEAM_IDS,
} from '../shared';
import type { DragonClassId, PlayerId, QualityPreset, WorldView } from '../shared';
import { DRAGON_WING_ITEM_SIZE, buildDragonGeometry } from './dragon-geometry';
import { writeInstanceMatrix } from './instance-matrix';
import { DRAGON_SHADER_CACHE_KEY, patchDragonShader } from './dragon-shader';
import { DRAGON_SHAPES } from './dragon-shapes';
import {
  POSE_AMPLITUDE,
  POSE_BEAT_HZ,
  POSE_BIAS,
  POSE_BLEND_RATE,
  POSE_GLOW,
  POSE_STRIDE,
  POSE_SWEEP,
  POSE_TIP_GAIN,
  advancePhase,
  approach,
  flapAngle,
  initialPhase,
  tipFlapAngle,
  writeWingPoseTarget,
} from './wing-pose';

/** Player ids are a `u8`: per-id animation memory covers every possible id. */
const ID_SLOTS = 256;
/** Linear emissive strength of the team accent at glow 1 (before tone mapping). */
const ACCENT_STRENGTH = 0.45;
/** Metres the tail tip swings per radian of wing amplitude (it counters the wing beat). */
const TAIL_LIFT_PER_AMPLITUDE = 0.9;
/** Radians per second of the spawn-protection shimmer. */
const SPAWN_PULSE_RATE = 14;
/** Accent multiplier for a veiled dragon the local player is still allowed to see. */
const VEILED_ACCENT = 0.2;
/** Fraction of its pixels a veiled dragon keeps for the players who may still see it. */
const VEILED_FADE = 0.38;
/** The same for a dragon passing through terrain (phase dive): ghostly for everyone. */
const PHASING_FADE = 0.55;
/** Accent multiplier while the wing shield is up. */
const SHIELDED_ACCENT = 1.7;
/** A longer frame than this (tab switch, hitch) is animated as this long, seconds. */
const MAX_ANIMATION_DT_S = 0.1;
const NO_TEAM = -1;

export interface PlaceholderDragonsOptions {
  /**
   * Draw dragons whose ALIVE flag is clear (the sim keeps them falling with the `death_fall`
   * hint until respawn). Default false: only living dragons are drawn.
   */
  readonly showDead?: boolean;
}

/** Live numbers for the perf HUD. One object, mutated in place by `update`. */
export interface PlaceholderDragonsStats {
  /** Dragons drawn by the last `update`. */
  readonly dragons: number;
  /** Class batches with at least one dragon = draw calls of the colour pass. */
  readonly drawCalls: number;
  /** Triangles submitted by the colour pass. */
  readonly triangles: number;
}

export interface PlaceholderDragons {
  /** Add to the scene once. */
  readonly object: Group;
  readonly stats: PlaceholderDragonsStats;
  /**
   * Per frame, after the WorldView is built. `dtS` is the real frame time (it drives the wing
   * beat). `localPlayerId` defaults to `view.localDragonId`; it decides which veiled dragons are
   * hidden (enemies of the local player's team).
   */
  update(view: WorldView, dtS: number, localPlayerId?: PlayerId): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

interface ClassBatch {
  readonly mesh: InstancedMesh<BufferGeometry, MeshLambertMaterial>;
  readonly geometry: BufferGeometry;
  readonly pose: InstancedBufferAttribute;
  readonly accent: InstancedBufferAttribute;
  readonly fade: InstancedBufferAttribute;
  readonly triangles: number;
  count: number;
}

interface MutableStats {
  dragons: number;
  drawCalls: number;
  triangles: number;
}

function createClassIndex(): Record<DragonClassId, number> {
  const index: Record<DragonClassId, number> = { talon: 0, bastion: 0, tempest: 0, wraith: 0 };
  for (let i = 0; i < DRAGON_CLASS_IDS.length; i++) {
    const id = DRAGON_CLASS_IDS[i];
    if (id !== undefined) index[id] = i;
  }
  return index;
}

/** Creates the whole pool up front. Load-time code; call `setQuality` on preset changes. */
export function createPlaceholderDragons(
  preset: QualityPreset,
  options: PlaceholderDragonsOptions = {},
): PlaceholderDragons {
  const showDead = options.showDead ?? false;

  const object = new Group();
  object.name = 'dragons';
  object.matrixAutoUpdate = false;

  const material = new MeshLambertMaterial({ vertexColors: true });
  material.name = 'dragon-placeholder';
  material.onBeforeCompile = (shader) => patchDragonShader(shader, 'lit');
  material.customProgramCacheKey = () => `${DRAGON_SHADER_CACHE_KEY}-lit`;

  // Shadow pass: the same wing motion, or the shadow would show the wings frozen.
  const depthMaterial = new MeshDepthMaterial();
  depthMaterial.name = 'dragon-placeholder-depth';
  depthMaterial.onBeforeCompile = (shader) => patchDragonShader(shader, 'depth');
  depthMaterial.customProgramCacheKey = () => `${DRAGON_SHADER_CACHE_KEY}-depth`;

  const classIndex = createClassIndex();
  const batches: ClassBatch[] = [];
  for (const classId of DRAGON_CLASS_IDS) {
    const data = buildDragonGeometry(DRAGON_SHAPES[classId]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
    geometry.setAttribute('aWing', new BufferAttribute(data.wing, DRAGON_WING_ITEM_SIZE));
    const pose = new InstancedBufferAttribute(new Float32Array(MAX_PLAYERS * 4), 4);
    pose.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aPose', pose);
    const accent = new InstancedBufferAttribute(new Float32Array(MAX_PLAYERS * 3), 3);
    accent.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aAccent', accent);
    const fade = new InstancedBufferAttribute(new Float32Array(MAX_PLAYERS).fill(1), 1);
    fade.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aFade', fade);

    const mesh = new InstancedMesh(geometry, material, MAX_PLAYERS);
    mesh.name = `dragons-${classId}`;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.customDepthMaterial = depthMaterial;
    mesh.count = 0;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    // Ten small meshes that move every frame: a per-frame bounds rebuild would cost more than
    // drawing an off-screen dragon does.
    mesh.frustumCulled = false;
    object.add(mesh);
    batches.push({ mesh, geometry, pose, accent, fade, triangles: data.triangleCount, count: 0 });
  }

  // Linear RGB per team id.
  const teamColors = new Float32Array(TEAM_IDS.length * 3);
  const scratchColor = new Color();
  for (const team of TEAM_IDS) {
    scratchColor.setHex(TEAMS[team].color);
    teamColors[team * 3] = scratchColor.r;
    teamColors[team * 3 + 1] = scratchColor.g;
    teamColors[team * 3 + 2] = scratchColor.b;
  }

  // Animation memory per player id (never per WorldView slot: slots are reshuffled).
  const poses = new Float32Array(ID_SLOTS * POSE_STRIDE);
  const phases = new Float32Array(ID_SLOTS);
  const lastSeenFrame = new Int32Array(ID_SLOTS).fill(-2);
  const target = new Float32Array(POSE_STRIDE);
  let frame = 0;
  let timeS = 0;

  const stats: MutableStats = { dragons: 0, drawCalls: 0, triangles: 0 };

  function update(view: WorldView, dtS: number, localPlayerId?: PlayerId): void {
    const dt = dtS > 0 ? (dtS < MAX_ANIMATION_DT_S ? dtS : MAX_ANIMATION_DT_S) : 0;
    frame++;
    timeS += dt;

    const localId = localPlayerId ?? view.localDragonId;
    let localTeam = NO_TEAM;
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon !== undefined && dragon.id === localId) localTeam = dragon.team;
    }

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (batch !== undefined) batch.count = 0;
    }

    const spawnPulse = 0.6 + 0.4 * Math.sin(timeS * SPAWN_PULSE_RATE);
    let drawn = 0;

    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon === undefined) continue;
      const flags = dragon.flags;
      if ((flags & DRAGON_FLAG_ALIVE) === 0 && !showDead) continue;
      const veiled = (flags & DRAGON_FLAG_VEILED) !== 0;
      if (veiled && localTeam !== NO_TEAM && dragon.team !== localTeam) continue;
      const batch = batches[classIndex[dragon.classId]];
      if (batch === undefined || batch.count >= MAX_PLAYERS) continue;
      const slot = batch.count++;
      drawn++;

      // --- Wing pose: ease toward the target for this dragon's state ----------------------------
      const id = dragon.id & (ID_SLOTS - 1);
      const velocity = dragon.velocity;
      const speed = Math.sqrt(
        velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
      );
      const cruise = FLIGHT_TUNING.cruiseSpeed * CLASS_TUNING[dragon.classId].speedScale;
      writeWingPoseTarget(target, dragon.anim, flags, cruise > 0 ? speed / cruise : 1);

      const p = id * POSE_STRIDE;
      if (lastSeenFrame[id] !== frame - 1) {
        // New (or back after being hidden): start in the target pose instead of blending from
        // whatever this id last looked like.
        for (let k = 0; k < POSE_STRIDE; k++) poses[p + k] = target[k] ?? 0;
        phases[id] = initialPhase(id);
      } else {
        for (let k = 0; k < POSE_STRIDE; k++) {
          poses[p + k] = approach(poses[p + k] ?? 0, target[k] ?? 0, POSE_BLEND_RATE, dt);
        }
      }
      lastSeenFrame[id] = frame;

      const phase = advancePhase(phases[id] ?? 0, poses[p + POSE_BEAT_HZ] ?? 0, dt);
      phases[id] = phase;
      const amplitude = poses[p + POSE_AMPLITUDE] ?? 0;

      const poseArray = batch.pose.array;
      const q = slot * 4;
      poseArray[q] = flapAngle(phase, amplitude, poses[p + POSE_BIAS] ?? 0);
      poseArray[q + 1] = tipFlapAngle(phase, amplitude, poses[p + POSE_TIP_GAIN] ?? 0);
      poseArray[q + 2] = poses[p + POSE_SWEEP] ?? 0;
      poseArray[q + 3] = -Math.sin(phase) * amplitude * TAIL_LIFT_PER_AMPLITUDE;

      // --- Team accent ----------------------------------------------------------------------------
      let glow = ACCENT_STRENGTH * (poses[p + POSE_GLOW] ?? 0);
      if ((flags & DRAGON_FLAG_SPAWN_PROTECTED) !== 0) glow *= spawnPulse;
      if (veiled) glow *= VEILED_ACCENT;
      else if ((flags & DRAGON_FLAG_SHIELDED) !== 0) glow *= SHIELDED_ACCENT;
      // Seen through: a veiled dragon by its own team (and by spectators), anyone mid-phase.
      batch.fade.array[slot] = veiled
        ? VEILED_FADE
        : (flags & DRAGON_FLAG_PHASING) !== 0
          ? PHASING_FADE
          : 1;
      const accentArray = batch.accent.array;
      const a = slot * 3;
      const t = dragon.team * 3;
      accentArray[a] = (teamColors[t] ?? 0) * glow;
      accentArray[a + 1] = (teamColors[t + 1] ?? 0) * glow;
      accentArray[a + 2] = (teamColors[t + 2] ?? 0) * glow;

      // --- Transform ------------------------------------------------------------------------------
      writeInstanceMatrix(
        batch.mesh.instanceMatrix.array,
        slot * 16,
        dragon.position,
        dragon.orientation,
      );
    }

    let drawCalls = 0;
    let triangles = 0;
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (batch === undefined) continue;
      const mesh = batch.mesh;
      mesh.count = batch.count;
      mesh.visible = batch.count > 0;
      if (batch.count === 0) continue;
      mesh.instanceMatrix.needsUpdate = true;
      batch.pose.needsUpdate = true;
      batch.accent.needsUpdate = true;
      batch.fade.needsUpdate = true;
      drawCalls++;
      triangles += batch.triangles * batch.count;
    }
    stats.dragons = drawn;
    stats.drawCalls = drawCalls;
    stats.triangles = triangles;
  }

  function setQuality(next: QualityPreset): void {
    const castShadow = next.shadowCasters !== 'none';
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (batch === undefined) continue;
      batch.mesh.castShadow = castShadow;
      // Low-poly self-shadowing only adds acne; the dragons never receive.
      batch.mesh.receiveShadow = false;
    }
  }

  function dispose(): void {
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      if (batch === undefined) continue;
      batch.geometry.dispose();
      // Frees the instance-matrix buffer (InstancedMesh owns it, not the geometry).
      batch.mesh.dispose();
    }
    material.dispose();
    depthMaterial.dispose();
    object.clear();
    batches.length = 0;
  }

  setQuality(preset);

  return { object, stats, update, setQuality, dispose };
}
