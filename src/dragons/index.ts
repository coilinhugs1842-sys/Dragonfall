/** Barrel for the dragon views. Phase 1: the instanced placeholder dragon. */

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
