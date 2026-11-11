/** Barrel for the effects view (T-3.5). */

export {
  ATLAS_CELL_SIZE,
  ATLAS_CHANNELS,
  ATLAS_COLUMNS,
  ATLAS_ROWS,
  SPRITES,
  atlasCellRect,
  atlasTexelOffset,
  generateEffectAtlas,
} from './atlas';
export type { AtlasRect, SpriteName } from './atlas';
export { BEAM_CAPACITY } from './beams';
export type { BeamStyle } from './beams';
export {
  Emitter,
  PRESSURE_FLOOR,
  PRESSURE_SOFT_LIMIT,
  VFX_QUALITY,
  defineRecipe,
  pressureScale,
  spawnCount,
} from './emitter';
export type { EmitShape, EmitterRecipe, VfxQuality } from './emitter';
export { PALETTE, hexToLinear, paletteOffset } from './palette';
export { PARTICLE_STRIDE, ParticlePool } from './particle-pool';
export {
  BEAM_STYLES,
  CAST_EFFECTS,
  IMPACT_EFFECTS,
  PROJECTILE_SPRITES,
  PROJECTILE_TRAILS,
  RECIPES,
  SPAWN_EFFECT,
  STATUS_EFFECTS,
  TAKEDOWN_EFFECT,
  ZONE_STYLES,
  castEffectFor,
  hitEffectFor,
  hitScale,
  impactEffectFor,
  statusEffectFor,
} from './recipes';
export type { CastEffect, ProjectileSprite, RecipeName, ZoneStyle } from './recipes';
export { SHELL_CAPACITY } from './shells';
export { FRAME_SPRITE_CAPACITY, LOCAL_SHOT_DEDUPE_S, LOW_HEALTH_FRACTION, createVfx } from './vfx';
export type { Vfx, VfxOptions, VfxStats } from './vfx';
