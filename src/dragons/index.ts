/**
 * Barrel for the dragon views: the skinned, animated dragons (T-4.4) and the instanced
 * placeholder they fall back to (loading, far distance).
 */

export {
  ANIM_BLEND_RATE,
  BREATH_SCALE,
  DRAGON_CLIP_COUNT,
  advanceDragonAnim,
  breathScale,
  createDragonAnimInput,
  createDragonAnimState,
  resetDragonAnimState,
  writeDragonPose,
  writeLocomotionTargets,
} from './dragon-animator';
export type {
  DragonAnimBones,
  DragonAnimInput,
  DragonAnimRig,
  DragonAnimState,
} from './dragon-animator';
export {
  CLOAK_UV_RECT,
  DRAGON_BAKE_FPS,
  buildDragonAsset,
  cloakFlutterWeight,
  createDragonAssetLibrary,
  parseDragonManifest,
  sharedDragonAssetLibrary,
} from './dragon-assets';
export type {
  DragonAsset,
  DragonAssetLibrary,
  DragonAssetLibraryOptions,
  DragonAssetStatus,
  DragonManifestExtras,
  DragonManifestFile,
} from './dragon-assets';
export {
  DRAGON_LOD_FAR,
  LOD_HYSTERESIS,
  LOD_REFERENCE_FOV_DEG,
  dragonLodPolicy,
  lodForDistance,
  lodFovScale,
  selectDragonLods,
} from './dragon-lod';
export type { DragonLodLevel, DragonLodPolicy } from './dragon-lod';
export {
  DRAGON_SHADER_SOURCE,
  MEMBRANE_GLOW,
  RUNE_GLOW,
  createDragonMaterial,
  setDragonMaterialQuality,
} from './dragon-material';
export type { DragonMaterial, DragonUniforms } from './dragon-material';
export { createDragons } from './dragons';
export type { Dragons, DragonsDebug, DragonsOptions, DragonsStats } from './dragons';
export {
  accumulateClip,
  applyLocalDelta,
  bodyAngularVelocity,
  clipTime,
  createPoseAccumulator,
  finishPose,
  resetPose,
  rotateBoneModelSpace,
} from './pose-math';
export type { BakedClip, PoseAccumulator } from './pose-math';


export {
  DRAGON_MAX_TRIANGLES,
  DRAGON_WING_ITEM_SIZE,
  WING_HINGE_Y,
  WING_HINGE_Z,
  buildDragonGeometry,
} from './dragon-geometry';
export type { DragonGeometryData } from './dragon-geometry';
export { DRAGON_SHADER_CACHE_KEY, patchDragonShader } from './dragon-shader';
export type { DragonShaderVariant, PatchableShader } from './dragon-shader';
export { DRAGON_SHAPES } from './dragon-shapes';
export type { DragonShape } from './dragon-shapes';
export { writeInstanceMatrix } from './instance-matrix';
export { createPlaceholderDragons } from './placeholder-dragons';
export type {
  PlaceholderDragons,
  PlaceholderDragonsOptions,
  PlaceholderDragonsStats,
} from './placeholder-dragons';
export {
  POSE_AMPLITUDE,
  POSE_BEAT_HZ,
  POSE_BIAS,
  POSE_BLEND_RATE,
  POSE_GLOW,
  POSE_STRIDE,
  POSE_SWEEP,
  POSE_TIP_GAIN,
  TIP_PHASE_LAG,
  advancePhase,
  approach,
  flapAngle,
  initialPhase,
  tipFlapAngle,
  writeWingPoseTarget,
} from './wing-pose';
