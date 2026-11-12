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

import { ABILITY_TABLE } from './abilities';
import type { AbilityTable } from './abilities';
import { ABILITY_SLOTS } from './classes';
import type { DragonClassId } from './classes';
import type { PlayerId, TeamId } from './constants';
import { NO_PLAYER, TEAM_EMBER, TEAM_FROST, TICK_DT_S, TICK_HZ } from './constants';
import type { MatchPhase } from './match';
import type { MutableQuat, MutableVec3, Quat, Vec3 } from './math-types';
import { createQuat, createVec3 } from './math-types';

// --- Dragon flags (a `u16` in the snapshot) ---------------------------------------------------------
//
// All 16 bits are taken (DECISIONS 14 widened the field from `u8`). Never renumber a shipped bit.

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
/** Below stall speed: the nose is dropping and steering is weak until speed recovers. */
export const DRAGON_FLAG_STALLED = 1 << 8;
/** Slowed (static field). */
export const DRAGON_FLAG_SLOWED = 1 << 9;
/** Taking damage over time (shade breath, burn trail). */
export const DRAGON_FLAG_BURNING = 1 << 10;
/** Blinded (night terror). On the local dragon the HUD/post darkens the screen. */
export const DRAGON_FLAG_BLINDED = 1 << 11;
/** Speed buff (afterburn). */
export const DRAGON_FLAG_HASTED = 1 << 12;
/** Winding up an ability (lance charge, shield, veil, phase dive): play the wind-up. */
export const DRAGON_FLAG_CHARGING = 1 << 13;
/** Holding fire with a sustained primary (the breath or bolt stream is on). */
export const DRAGON_FLAG_FIRING = 1 << 14;
/** Being healed (rally roar). */
export const DRAGON_FLAG_REGEN = 1 << 15;

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
 * What kind of thing a projectile is, for picking its mesh/trail. The numbers of each kind are
 * in PROJECTILE_DEFS (./abilities.ts). Index = `u8` wire value (at most 16). Append only.
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
 * Area volumes the views draw. `stormWall` is the arena edge, a vertical cylinder (its radius
 * shrinks per Duel round); every other kind is a sphere. The numbers of the ability zones are in
 * ZONE_DEFS (./abilities.ts); objective zones are T-6.x.
 * Index = `u8` wire value (at most 16). Append only.
 */
export const ZONE_KINDS = [
  'stormWall',
  'thunderhead',
  'staticField',
  'controlZone',
  'burnTrail',
  'rallyAura',
] as const;

export type ZoneKind = (typeof ZONE_KINDS)[number];

export interface ZoneView {
  readonly id: number;
  readonly kind: ZoneKind;
  /** Owning team, or null for neutral zones such as the storm wall. */
  readonly team: TeamId | null;
  readonly position: Vec3;
  /** Metres. */
  readonly radius: number;
  /** Who made it, or NO_PLAYER. A `rallyAura` stays on its owner: draw it at that dragon. */
  readonly ownerId: PlayerId;
  /** Seconds until it ends; Infinity for permanent zones (the storm wall). */
  readonly remainingS: number;
}

/**
 * The local rider's combat state, for the HUD (cooldowns, ultimate, respawn) and the death cam.
 * Only this browser's own dragon has it: the numbers travel in the snapshot's owner block.
 * Arrays are indexed like ABILITY_SLOTS (primary, secondary, utility, ultimate).
 */
export interface LocalCombatView {
  /** False for spectators, outside a match, and when the builder had no data: ignore the rest. */
  readonly valid: boolean;
  /** Cooldown left per slot as a 0..1 fraction of the full cooldown (0 = ready). */
  readonly cooldowns: readonly number[];
  /** The same in seconds. */
  readonly cooldownS: readonly number[];
  /** Uses in store per slot (0 or 1 for a plain cooldown) and the most it can store. */
  readonly charges: readonly number[];
  readonly maxCharges: readonly number[];
  /** True when pressing the slot's button now would start the ability. */
  readonly ready: readonly boolean[];
  /** The slot's effect is running (dash window, shield up, a held breath, a zone trail). */
  readonly active: readonly boolean[];
  /** 0..1; the ultimate is ready at 1. */
  readonly ultimateCharge: number;
  /** Slot index of the ability being wound up, or -1; and how far along it is (0..1). */
  readonly castSlot: number;
  readonly castProgress: number;
  /** Barrel-roll cooldown left, 0..1. */
  readonly dodgeCooldown: number;
  /** Seconds until respawn; 0 while alive. Infinity when respawns are off (Duel). */
  readonly respawnInS: number;
  /** Who last hurt this dragon (the death cam target), or NO_PLAYER. */
  readonly killerId: PlayerId;
  /** Seconds of blindness left (0 = can see). */
  readonly blindS: number;
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

// --- Ember Relay (T-6.3) ---------------------------------------------------------------------------

/** Where a sky-shard is. The same numbers in the sim's state and on the wire. Append only. */
export const SHARD_HOME = 0;
export const SHARD_CARRIED = 1;
export const SHARD_DROPPED = 2;
export const SHARD_STATUS_COUNT = 3;

export interface ShardView {
  /** The team that owns it (its enemies carry it away). */
  readonly team: TeamId;
  /** SHARD_HOME, SHARD_CARRIED or SHARD_DROPPED. */
  readonly status: number;
  /** Who carries it, or NO_PLAYER. */
  readonly carrierId: PlayerId;
  /** Its stand while home, the carrier's position while carried, where it lies while dropped. */
  readonly position: Vec3;
  /** Dropped: seconds until it goes home by itself. Otherwise 0. */
  readonly returnInS: number;
}

/**
 * The objective state of an Ember Relay match. Fixed size (two teams), so nothing here is
 * pooled by count: when `active` is false (any other mode) ignore the rest.
 */
export interface RelayView {
  readonly active: boolean;
  /** Index = owning TeamId. */
  readonly shards: readonly ShardView[];
  /** Where each team's shard rests. Index = TeamId. */
  readonly stands: readonly Vec3[];
  /** Where each team scores. Index = TeamId. */
  readonly braziers: readonly Vec3[];
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
  readonly local: LocalCombatView;
  /** Ember Relay's shards and braziers; `relay.active` is false in every other mode. */
  readonly relay: RelayView;
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
  ownerId: PlayerId;
  remainingS: number;
}

export interface MutableLocalCombatView {
  valid: boolean;
  cooldowns: number[];
  cooldownS: number[];
  charges: number[];
  maxCharges: number[];
  ready: boolean[];
  active: boolean[];
  ultimateCharge: number;
  castSlot: number;
  castProgress: number;
  dodgeCooldown: number;
  respawnInS: number;
  killerId: PlayerId;
  blindS: number;
}

export interface MutableMatchClockView {
  tick: number;
  phase: MatchPhase;
  phaseTimeS: number;
  timeRemainingS: number;
  round: number;
}

export interface MutableShardView {
  team: TeamId;
  status: number;
  carrierId: PlayerId;
  position: MutableVec3;
  returnInS: number;
}

export interface MutableRelayView {
  active: boolean;
  shards: MutableShardView[];
  stands: MutableVec3[];
  braziers: MutableVec3[];
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
  local: MutableLocalCombatView;
  relay: MutableRelayView;
}

/** Both shards at the origin and `active` false: what every mode but Ember Relay shows. */
export function createRelayView(): MutableRelayView {
  return {
    active: false,
    shards: [
      {
        team: TEAM_EMBER,
        status: SHARD_HOME,
        carrierId: NO_PLAYER,
        position: createVec3(),
        returnInS: 0,
      },
      {
        team: TEAM_FROST,
        status: SHARD_HOME,
        carrierId: NO_PLAYER,
        position: createVec3(),
        returnInS: 0,
      },
    ],
    stands: [createVec3(), createVec3()],
    braziers: [createVec3(), createVec3()],
  };
}

export function createLocalCombatView(): MutableLocalCombatView {
  return {
    valid: false,
    cooldowns: [0, 0, 0, 0],
    cooldownS: [0, 0, 0, 0],
    charges: [0, 0, 0, 0],
    maxCharges: [1, 1, 1, 1],
    ready: [false, false, false, false],
    active: [false, false, false, false],
    ultimateCharge: 0,
    castSlot: -1,
    castProgress: 0,
    dodgeCooldown: 0,
    respawnInS: 0,
    killerId: NO_PLAYER,
    blindS: 0,
  };
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
    local: createLocalCombatView(),
    relay: createRelayView(),
  };
}

/** Start of a frame's build: marks every slot free but keeps the pooled objects. */
export function beginWorldView(view: MutableWorldView): void {
  view.dragonCount = 0;
  view.projectileCount = 0;
  view.zoneCount = 0;
  // A builder that knows the local dragon's combat state calls `writeLocalCombatView` after this.
  view.local.valid = false;
  // A builder of an Ember Relay match fills it again after this (`writeRelayView`).
  view.relay.active = false;
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

/**
 * Same contract as acquireDragonView: the caller must write every field, except `ownerId` and
 * `remainingS`, which come back as "nobody" and "permanent" (what the storm wall wants).
 */
export function acquireZoneView(view: MutableWorldView): MutableZoneView {
  let slot = view.zones[view.zoneCount];
  if (slot === undefined) {
    slot = {
      id: 0,
      kind: 'stormWall',
      team: null,
      position: createVec3(),
      radius: 0,
      ownerId: NO_PLAYER,
      remainingS: Infinity,
    };
    view.zones.push(slot);
  }
  slot.ownerId = NO_PLAYER;
  slot.remainingS = Infinity;
  view.zoneCount++;
  return slot;
}

/**
 * What `writeLocalCombatView` reads of a dragon. The sim's `DragonState`, the client predictor's
 * dragon and the host worker's view dragon all fit.
 */
export interface LocalCombatSource {
  readonly classId: DragonClassId;
  readonly flags: number;
  readonly stamina: number;
  readonly abilityCooldownTicks: ArrayLike<number>;
  readonly abilityChargesUsed: ArrayLike<number>;
  readonly abilityActiveTicks: ArrayLike<number>;
  readonly castSlot: number;
  readonly castTicks: number;
  readonly ultCharge: number;
  readonly dodgeCooldownTicks: number;
  readonly deadTicks: number;
  readonly lastDamagerId: PlayerId;
  readonly blindTicks: number;
}

function ticksFor(seconds: number): number {
  return seconds > 0 ? Math.ceil(seconds * TICK_HZ - 1e-6) : 0;
}

/**
 * Fills the frame's `view.local` from the local dragon (see LocalCombatView). Call it after
 * `beginWorldView`, once per frame; without the call the HUD sees `valid: false`.
 *
 * @param respawnDelayS MATCH_TUNING.respawnDelayS, or Infinity while respawns are off.
 * @param dodgeCooldownS FLIGHT_TUNING.dodgeCooldownS.
 */
export function writeLocalCombatView(
  out: MutableLocalCombatView,
  dragon: LocalCombatSource,
  respawnDelayS: number,
  dodgeCooldownS: number,
  abilities: AbilityTable = ABILITY_TABLE,
): MutableLocalCombatView {
  const defs = abilities[dragon.classId];
  const castFree = dragon.castSlot < 0;
  const alive = (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
  for (let i = 0; i < ABILITY_SLOTS.length; i++) {
    const slot = ABILITY_SLOTS[i];
    if (slot === undefined) continue;
    const def = defs[slot];
    const left = dragon.abilityCooldownTicks[i] ?? 0;
    const used = dragon.abilityChargesUsed[i] ?? 0;
    const max = def.maxCharges > 1 ? Math.floor(def.maxCharges) : 1;
    const full = ticksFor(def.cooldownS);
    const charges = max > 1 ? Math.max(0, max - used) : left > 0 ? 0 : 1;
    // With charges in store the slot is usable although the next charge is still loading.
    const waiting = max > 1 ? (charges > 0 ? 0 : left) : left;
    out.cooldowns[i] = full > 0 ? Math.max(0, Math.min(1, waiting / full)) : 0;
    out.cooldownS[i] = waiting * TICK_DT_S;
    out.charges[i] = charges;
    out.maxCharges[i] = max;
    out.ready[i] =
      alive &&
      castFree &&
      charges > 0 &&
      (dragon.abilityActiveTicks[i] ?? 0) === 0 &&
      dragon.stamina >= def.staminaCost &&
      (def.ultCost <= 0 || dragon.ultCharge >= def.ultCost);
    out.active[i] = alive && (dragon.abilityActiveTicks[i] ?? 0) > 0;
  }
  out.valid = true;
  out.ultimateCharge = Math.max(0, Math.min(1, dragon.ultCharge));
  out.castSlot = dragon.castSlot;
  out.castProgress = 0;
  if (dragon.castSlot >= 0) {
    const slot = ABILITY_SLOTS[dragon.castSlot];
    const windup = slot !== undefined ? ticksFor(defs[slot].windupS) : 0;
    out.castProgress = windup > 0 ? Math.max(0, Math.min(1, 1 - dragon.castTicks / windup)) : 1;
  }
  const dodgeFull = ticksFor(dodgeCooldownS);
  out.dodgeCooldown =
    dodgeFull > 0 ? Math.max(0, Math.min(1, dragon.dodgeCooldownTicks / dodgeFull)) : 0;
  if (!alive) {
    const left = respawnDelayS - dragon.deadTicks * TICK_DT_S;
    out.respawnInS = left > 0 ? left : 0;
  } else {
    out.respawnInS = 0;
  }
  out.killerId = dragon.lastDamagerId;
  out.blindS = dragon.blindTicks * TICK_DT_S;
  return out;
}

/** Linear scan (at most 10 dragons). Returns undefined when the dragon is not in this view. */
export function findDragonView(view: WorldView, id: PlayerId): DragonView | undefined {
  for (let i = 0; i < view.dragonCount; i++) {
    const dragon = view.dragons[i];
    if (dragon !== undefined && dragon.id === id) return dragon;
  }
  return undefined;
}

/**
 * What `writeRelayView` reads of Ember Relay's state. The sim's `RelayState` fits, and so does
 * the copy of it a client keeps from the host's RELAY messages.
 */
export interface RelaySource {
  readonly active: boolean;
  /** Index = owning TeamId. */
  readonly shards: readonly {
    readonly status: number;
    readonly carrierId: PlayerId;
    readonly position: Vec3;
    /** Dropped: the tick on which it goes home by itself. */
    readonly returnTick: number;
  }[];
  readonly stands: readonly Vec3[];
  readonly braziers: readonly Vec3[];
}

/**
 * Fills the frame's `view.relay`. Call it after the dragons were written, once per frame;
 * without the call the views see `active: false` (`beginWorldView`).
 *
 * A carried shard is put on its carrier as this frame draws it (interpolated or predicted), so
 * it never trails a tick behind the dragon; the state's own position is only the fallback.
 *
 * @param tick The tick this frame shows, on the clock `returnTick` counts in (host ticks).
 */
export function writeRelayView(
  view: MutableWorldView,
  relay: RelaySource,
  tick: number,
): MutableWorldView {
  const out = view.relay;
  out.active = relay.active;
  if (!relay.active) return view;
  for (let team = 0; team < 2; team++) {
    const stand = relay.stands[team];
    const outStand = out.stands[team];
    if (stand !== undefined && outStand !== undefined) {
      outStand.x = stand.x;
      outStand.y = stand.y;
      outStand.z = stand.z;
    }
    const brazier = relay.braziers[team];
    const outBrazier = out.braziers[team];
    if (brazier !== undefined && outBrazier !== undefined) {
      outBrazier.x = brazier.x;
      outBrazier.y = brazier.y;
      outBrazier.z = brazier.z;
    }
    const shard = relay.shards[team];
    const outShard = out.shards[team];
    if (shard === undefined || outShard === undefined) continue;
    outShard.status = shard.status;
    outShard.carrierId = shard.carrierId;
    const carrier =
      shard.status === SHARD_CARRIED ? findDragonView(view, shard.carrierId) : undefined;
    const at = carrier !== undefined ? carrier.position : shard.position;
    outShard.position.x = at.x;
    outShard.position.y = at.y;
    outShard.position.z = at.z;
    const left = shard.status === SHARD_DROPPED ? (shard.returnTick - tick) * TICK_DT_S : 0;
    outShard.returnInS = left > 0 ? left : 0;
  }
  return view;
}
