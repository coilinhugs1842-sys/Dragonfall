/**
 * WorldView: the read-only, already interpolated state that every view module renders from.
 * `src/game` builds one per frame (from the authoritative sim on the host, from the snapshot
 * buffer + prediction on a client) and hands the same object to render/world/dragons/vfx/ui.
 *
 * POOLING RULES (zero allocations per frame):
 * - The arrays only ever grow. Entries at index >= the matching `*Count` are stale pool
 *   slots: ALWAYS loop `for (let i = 0; i < view.dragonCount; i++)`, never `.length`/`for..of`.
 * - Views must not keep references to its arrays, or to any entry or vector inside them,
 *   between frames: the same objects are overwritten next frame and a slot may then describe a
 *   different entity. Copy the numbers you need, keyed by `id`.
 */

import type { DragonClassId } from './classes';
import type { PlayerId, TeamId } from './constants';
import { NO_PLAYER, TEAM_EMBER } from './constants';
import type { MatchPhase } from './match';
import type { MutableQuat, MutableVec3, Quat, Vec3 } from './math-types';
import { createQuat, createVec3 } from './math-types';

// --- Dragon flags (a `u16` in the snapshot) ---------------------------------------------------------
//
// Bits 0-7 are taken; bits 8-15 are free for later statuses (DECISIONS 14 widened the field from
// `u8` rather than dropping IN_STORM). Never renumber a shipped bit.

export const DRAGON_FLAG_ALIVE = 1 << 0;
export const DRAGON_FLAG_BOOSTING = 1 << 1;
/** Inside the barrel-roll immunity window. */
export const DRAGON_FLAG_DODGING = 1 << 2;
export const DRAGON_FLAG_SPAWN_PROTECTED = 1 << 3;
/** Bastion's wing shield is up. */
export const DRAGON_FLAG_SHIELDED = 1 << 4;
/** Wraith's veil: enemies should not draw this dragon or its nameplate. */
export const DRAGON_FLAG_VEILED = 1 << 5;
/** Wraith's phase dive: passing through terrain. */
export const DRAGON_FLAG_PHASING = 1 << 6;
/** Inside the storm wall and taking damage from it. */
export const DRAGON_FLAG_IN_STORM = 1 << 7;

// --- Dragon animation state (a `u8` in the snapshot) ---------------------------------------------

/**
 * Index = wire value, name = clip name in the dragon GLB (docs/ASSET_PIPELINE.md, step 2.3).
 * The sim picks the dominant state; `src/dragons` blends between clips. Append only.
 */
export const DRAGON_ANIM_CLIPS = [
  'glide',
  'flap',
  'boost',
  'dive',
  'bank_l',
  'bank_r',
  'hover',
  'roar',
  'land',
  'takeoff',
  'hit',
  'death_fall',
] as const;

export type DragonAnimClip = (typeof DRAGON_ANIM_CLIPS)[number];
/** Index into DRAGON_ANIM_CLIPS. */
export type DragonAnimState = number;

export const DRAGON_ANIM_GLIDE = 0;
export const DRAGON_ANIM_FLAP = 1;
export const DRAGON_ANIM_BOOST = 2;
export const DRAGON_ANIM_DIVE = 3;
export const DRAGON_ANIM_BANK_L = 4;
export const DRAGON_ANIM_BANK_R = 5;
export const DRAGON_ANIM_HOVER = 6;
export const DRAGON_ANIM_ROAR = 7;
export const DRAGON_ANIM_LAND = 8;
export const DRAGON_ANIM_TAKEOFF = 9;
export const DRAGON_ANIM_HIT = 10;
export const DRAGON_ANIM_DEATH_FALL = 11;

// --- Entities ----------------------------------------------------------------------------------

export interface DragonView {
  /** Same id as the rider's PlayerId. */
  readonly id: PlayerId;
  readonly team: TeamId;
  readonly classId: DragonClassId;
  /** World space, metres. Forward is +Z in dragon space (docs/ASSET_PIPELINE.md). */
  readonly position: Vec3;
  readonly orientation: Quat;
  /** World space, metres per second. */
  readonly velocity: Vec3;
  /** Fraction of the class's max HP, 0..1 (the snapshot carries it as a `u8`). */
  readonly health: number;
  /** Boost stamina, 0..1. */
  readonly stamina: number;
  /** Bitmask of DRAGON_FLAG_*. */
  readonly flags: number;
  readonly anim: DragonAnimState;
}

/**
 * What kind of thing a projectile is, for picking its mesh/trail.
 * TBD in T-3.x: the list follows the ability table and will change with the combat design.
 * Index = `u8` wire value. Append only.
 */
export const PROJECTILE_KINDS = ['fireBolt', 'meteorBomb', 'staticMine'] as const;

export type ProjectileKind = (typeof PROJECTILE_KINDS)[number];

export interface ProjectileView {
  readonly id: number;
  readonly kind: ProjectileKind;
  readonly ownerId: PlayerId;
  readonly team: TeamId;
  readonly position: Vec3;
  readonly velocity: Vec3;
}

/**
 * Area volumes the views draw. `stormWall` is the arena edge (its radius shrinks per Duel
 * round). The other kinds are TBD in T-3.x (ability areas) and T-6.x (objectives).
 * Index = `u8` wire value. Append only.
 */
export const ZONE_KINDS = ['stormWall', 'thunderhead', 'staticField', 'controlZone'] as const;

export type ZoneKind = (typeof ZONE_KINDS)[number];

export interface ZoneView {
  readonly id: number;
  readonly kind: ZoneKind;
  /** Owning team, or null for neutral zones such as the storm wall. */
  readonly team: TeamId | null;
  readonly position: Vec3;
  /** Metres. */
  readonly radius: number;
}

export interface MatchClockView {
  /** Latest sim tick this view was built from. */
  readonly tick: number;
  readonly phase: MatchPhase;
  /** Seconds since the current phase started (drives countdown and intro timing). */
  readonly phaseTimeS: number;
  /** Seconds left in the round/match, or Infinity when there is no time limit. */
  readonly timeRemainingS: number;
  /** 1-based round number (always 1 outside Duel). */
  readonly round: number;
}

export interface WorldView {
  /** Pool: only the first `dragonCount` entries are live. See the rules at the top of the file. */
  readonly dragons: readonly DragonView[];
  readonly dragonCount: number;
  readonly projectiles: readonly ProjectileView[];
  readonly projectileCount: number;
  readonly zones: readonly ZoneView[];
  readonly zoneCount: number;
  /** The dragon this browser controls, or NO_PLAYER for spectators and outside a match. */
  readonly localDragonId: PlayerId;
  readonly clock: MatchClockView;
}

// --- Writable side: only `src/game` (the builder) uses these ---------------------------------------

export interface MutableDragonView {
  id: PlayerId;
  team: TeamId;
  classId: DragonClassId;
  position: MutableVec3;
  orientation: MutableQuat;
  velocity: MutableVec3;
  health: number;
  stamina: number;
  flags: number;
  anim: DragonAnimState;
}

export interface MutableProjectileView {
  id: number;
  kind: ProjectileKind;
  ownerId: PlayerId;
  team: TeamId;
  position: MutableVec3;
  velocity: MutableVec3;
}

export interface MutableZoneView {
  id: number;
  kind: ZoneKind;
  team: TeamId | null;
  position: MutableVec3;
  radius: number;
}

export interface MutableMatchClockView {
  tick: number;
  phase: MatchPhase;
  phaseTimeS: number;
  timeRemainingS: number;
  round: number;
}

/** Structurally assignable to WorldView, so the builder passes it to views as-is. */
export interface MutableWorldView {
  dragons: MutableDragonView[];
  dragonCount: number;
  projectiles: MutableProjectileView[];
  projectileCount: number;
  zones: MutableZoneView[];
  zoneCount: number;
  localDragonId: PlayerId;
  clock: MutableMatchClockView;
}

export function createWorldView(): MutableWorldView {
  return {
    dragons: [],
    dragonCount: 0,
    projectiles: [],
    projectileCount: 0,
    zones: [],
    zoneCount: 0,
    localDragonId: NO_PLAYER,
    clock: { tick: 0, phase: 'lobby', phaseTimeS: 0, timeRemainingS: Infinity, round: 1 },
  };
}

/** Start of a frame's build: marks every slot free but keeps the pooled objects. */
export function beginWorldView(view: MutableWorldView): void {
  view.dragonCount = 0;
  view.projectileCount = 0;
  view.zoneCount = 0;
}

/**
 * Returns the next free dragon slot, allocating only when the pool grows. The slot still holds
 * LAST frame's values: the caller must write every field.
 */
export function acquireDragonView(view: MutableWorldView): MutableDragonView {
  let slot = view.dragons[view.dragonCount];
  if (slot === undefined) {
    slot = {
      id: NO_PLAYER,
      team: TEAM_EMBER,
      classId: 'talon',
      position: createVec3(),
      orientation: createQuat(),
      velocity: createVec3(),
      health: 0,
      stamina: 0,
      flags: 0,
      anim: DRAGON_ANIM_GLIDE,
    };
    view.dragons.push(slot);
  }
  view.dragonCount++;
  return slot;
}

/** Same contract as acquireDragonView: the caller must write every field. */
export function acquireProjectileView(view: MutableWorldView): MutableProjectileView {
  let slot = view.projectiles[view.projectileCount];
  if (slot === undefined) {
    slot = {
      id: 0,
      kind: 'fireBolt',
      ownerId: NO_PLAYER,
      team: TEAM_EMBER,
      position: createVec3(),
      velocity: createVec3(),
    };
    view.projectiles.push(slot);
  }
  view.projectileCount++;
  return slot;
}

/** Same contract as acquireDragonView: the caller must write every field. */
export function acquireZoneView(view: MutableWorldView): MutableZoneView {
  let slot = view.zones[view.zoneCount];
  if (slot === undefined) {
    slot = { id: 0, kind: 'stormWall', team: null, position: createVec3(), radius: 0 };
    view.zones.push(slot);
  }
  view.zoneCount++;
  return slot;
}

/** Linear scan (at most 10 dragons). Returns undefined when the dragon is not in this view. */
export function findDragonView(view: WorldView, id: PlayerId): DragonView | undefined {
  for (let i = 0; i < view.dragonCount; i++) {
    const dragon = view.dragons[i];
    if (dragon !== undefined && dragon.id === id) return dragon;
  }
  return undefined;
}
