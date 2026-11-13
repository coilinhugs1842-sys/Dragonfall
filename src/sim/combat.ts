/**
 * Combat on the host (T-3.1 / T-3.2): everything an ability does to the world, the one damage
 * pipeline, takedowns, assists and respawns. `Sim.step` runs it once per tick AFTER every dragon
 * has been stepped; clients never run it (they predict only their own dragon's flight and cast
 * state, `abilities.ts`), so every hit, takedown and score is decided here and nowhere else.
 *
 * ORDER WITHIN A TICK
 *   1. casts: for every slot bit in a dragon's `castStarted` / `castPulse`, the executor of the
 *      ability's kind (projectile, cone, beam, dash, zone, wave; a buff has no world part);
 *   2. projectiles: swept spheres, one terrain ray and one segment-vs-sphere per dragon each;
 *   3. zones: pulses of damage / statuses to the dragons inside;
 *   4. statuses: burn and regen pulses, the ultimate's passive charge;
 *   5. deaths: `takedown` + `assist` events and credit, then respawns;
 *   6. the status flag bits are rewritten, so a snapshot never shows last tick's.
 *
 * HIT SHAPES. A dragon is a sphere: its class's terrain radius times
 * `COMBAT_TUNING.hitRadiusScale` (one test per target; a capsule along the body bought nothing
 * at these speeds). Aimed shots (projectiles, cones, beams) ask the `TargetPositionSource` where
 * each target is: the lag-compensation seam. Area effects (blasts, zones, waves, a dash) use the
 * current positions.
 *
 * DAMAGE goes through `applyDamage`, whatever its origin: see the method. Terrain and storm
 * damage is taken inside the dragon's own step (the collision world, so that a client predicts
 * its own crashes) and joins the pipeline here through `DragonState.envDamage`: the `hit` event
 * and the takedown credit.
 *
 * Deterministic (no randomness, no clock) and allocation-free: fixed pools in `SimState`,
 * instance scratch, events through the pooled bus.
 */

import {
  ABILITY_SLOTS,
  ABILITY_TAG_ALLIES,
  DAMAGE_SOURCES,
  DRAGON_FLAG_ALIVE,
  NO_PLAYER,
  PROJECTILE_KINDS,
  TEAM_EMBER,
  TICK_DT_S,
  ZONE_KINDS,
} from '../shared';
import type {
  AbilityCastEvent,
  AbilityDef,
  AbilityTable,
  AssistEvent,
  ClassTuning,
  CombatTuning,
  DragonClassId,
  FlightTuning,
  GameEventSink,
  HitEvent,
  ImpactEvent,
  MatchTuning,
  MutableVec3,
  PlayerId,
  ProjectileDef,
  ProjectileKind,
  SpawnEvent,
  StatusAppliedEvent,
  StatusKind,
  TakedownEvent,
  Vec3,
  ZoneDef,
  ZoneKind,
} from '../shared';
import { abilityOfSlot, cancelAbilities, resolveFireDirection } from './abilities';
import { ENV_SOURCE_NONE, ENV_SOURCE_TERRAIN, createTerrainRay } from './collision-world';
import type { SimCollisionWorld, TerrainRay } from './collision-world';
import { copyDragonState } from './dragon-state';
import type { DragonState } from './dragon-state';
import { initDragon, writeStatusFlags } from './flight';
import type { ProjectileState, SimState, ZoneState } from './sim-state';
import { durationTicksOf, lifeTicksOf, pulseTicksOf, secondsToTicks } from './ticks';

// --- Seams ---------------------------------------------------------------------------------------

/**
 * THE LAG-COMPENSATION HOOK. Aimed shots ask this where a target's hit sphere is before testing
 * it: "the target's position at the time the shooter saw it". The default answers with the
 * current position; the host's history rewind answers with the position RTT/2 + interpolation
 * delay ago (docs/NETWORKING.md), per shooter.
 */
export interface TargetPositionSource {
  /**
   * Writes the centre of `target`'s hit sphere, as `shooterId` saw it, into `out`.
   *
   * @param shooterId Whose shot is being tested (NO_PLAYER never asks).
   * @param target The target's CURRENT state (`target.id` is the player to look up).
   * @param tick The sim tick being simulated.
   */
  sample(shooterId: PlayerId, target: Readonly<DragonState>, tick: number, out: MutableVec3): void;
}

/** No rewind: targets are where they are. */
export const CURRENT_TARGET_POSITIONS: TargetPositionSource = {
  sample(_shooterId, target, _tick, out) {
    out.x = target.position.x;
    out.y = target.position.y;
    out.z = target.position.z;
  },
};

/** Match rules the sim reads every tick. A mode sets them; the object is mutable on purpose. */
export interface SimRules {
  /** The lobby's friendly-fire setting. Off: teammates cannot hurt or debuff each other. */
  friendlyFire: boolean;
  /**
   * No round is in play (the mode sets it outside `playing`: intro, countdown, `roundEnd`,
   * `results`): nothing gets through the damage gate, so no ability, zone or burn hurts or
   * debuffs anyone while the sim keeps flying the dragons. Terrain and the storm are the
   * collision world's and are not stopped by it.
   */
  ceasefire: boolean;
}

export interface SpawnPose {
  x: number;
  y: number;
  z: number;
  /** Heading about +Y, 0 = +Z. */
  yaw: number;
}

/** How the dead come back. A mode sets it; read every tick. */
export interface RespawnPolicy {
  /**
   * True (Skirmish): a dead dragon respawns after MATCH_TUNING.respawnDelayS. False (Duel): it
   * stays down until the mode calls `Sim.respawnDragon` or turns this back on.
   */
  enabled: boolean;
  /**
   * Where a dragon respawns. `out` arrives holding its home pose (the gate slot it first
   * spawned at); change it or leave it. Null = always the home pose. Must not allocate.
   */
  place: ((dragon: Readonly<DragonState>, out: SpawnPose) => void) | null;
}

/** `applyDamage` flags. */
/** Not blocked by a wing shield (damage that has no direction: burns, zones). */
export const DAMAGE_IGNORE_SHIELD = 1 << 0;
/** Not stopped by dodge immunity or spawn protection. */
export const DAMAGE_IGNORE_IMMUNITY = 1 << 1;
/** A tick of damage over time: no hit animation. */
export const DAMAGE_OVER_TIME = 1 << 2;
/** Applies to teammates whatever the friendly-fire rule says (mode-dealt damage). */
export const DAMAGE_IGNORE_TEAM = 1 << 3;

const SOURCE_TERRAIN = DAMAGE_SOURCES.indexOf('terrain');
const SOURCE_STORM = DAMAGE_SOURCES.indexOf('storm');
const SOURCE_ULTIMATE = DAMAGE_SOURCES.indexOf('ultimate');
const EPSILON = 1e-6;
/** A zone placed along the aim stops this far short of the terrain it would hit. */
const ZONE_TERRAIN_GAP_M = 2;
/** A projectile leaves the caster this far in front of its terrain sphere. */
const MUZZLE_GAP_M = 0.5;

export interface CombatTables {
  readonly flight: FlightTuning;
  readonly classes: Record<DragonClassId, ClassTuning>;
  readonly match: MatchTuning;
  readonly abilities: AbilityTable;
  readonly projectiles: Record<ProjectileKind, ProjectileDef>;
  readonly zones: Record<ZoneKind, ZoneDef>;
  readonly combat: CombatTuning;
}

// Durations read from their table inside a small function: a float handed to a call the JIT did
// not inline is boxed, a field read is not (see ./ticks.ts).
function hitAnimTicksOf(flight: FlightTuning): number {
  return secondsToTicks(flight.hitAnimS);
}
function creditTicksOf(combat: CombatTuning): number {
  return secondsToTicks(combat.creditWindowS);
}
function assistTicksOf(combat: CombatTuning): number {
  return secondsToTicks(combat.assistWindowS);
}
function statusPulseTicksOf(combat: CombatTuning): number {
  return secondsToTicks(combat.statusPulseS);
}
function respawnTicksOf(match: MatchTuning): number {
  return secondsToTicks(match.respawnDelayS);
}
function statusTicksOf(holder: { readonly statusS: number }): number {
  return secondsToTicks(holder.statusS);
}

type Mutable<E> = { -readonly [K in keyof E]: E[K] extends Vec3 ? MutableVec3 : E[K] };

function vec(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

export class CombatSystem {
  /** Where the events go (the host session's `emitEvent`); null = nobody listens. */
  events: GameEventSink | null = null;
  targets: TargetPositionSource = CURRENT_TARGET_POSITIONS;
  collision: SimCollisionWorld;
  readonly rules: SimRules = { friendlyFire: false, ceasefire: false };
  readonly respawnPolicy: RespawnPolicy = { enabled: true, place: null };

  private readonly tables: CombatTables;
  // The states of the tick being simulated; only valid inside `step` and the public methods.
  private state: SimState;
  private prev: SimState;
  private tick = 0;

  // Scratch. Float parameters are boxed by the JIT when a call is not inlined, so the hot
  // helpers below read these fields instead of taking coordinates as arguments.
  private readonly ray: TerrainRay = createTerrainRay();
  /** Fire direction of the cast being executed. */
  private readonly dir = vec();
  /** Where the damage being applied comes from (for the shield's angle check). */
  private readonly origin = vec();
  /** A target's sampled position / the point something happened at. */
  private readonly targetPos = vec();
  private readonly point = vec();
  private readonly pose: SpawnPose = { x: 0, y: 0, z: 0, yaw: 0 };
  /**
   * Arguments and results of the damage and status helpers (see `deal`). `statusS` is not
   * private only so the tick helper above can read it.
   */
  private amount = 0;
  private applied = 0;
  private through = 0;
  statusS = 0;
  private statusPower = 0;
  private losDistance = 0;
  private losRadius = 0;

  private readonly hitEvent: Mutable<HitEvent> = {
    type: 'hit',
    tick: 0,
    attackerId: NO_PLAYER,
    targetId: NO_PLAYER,
    source: 'primary',
    damage: 0,
    position: vec(),
  };
  private readonly takedownEvent: Mutable<TakedownEvent> = {
    type: 'takedown',
    tick: 0,
    killerId: NO_PLAYER,
    victimId: NO_PLAYER,
    source: 'primary',
    position: vec(),
  };
  private readonly spawnEvent: Mutable<SpawnEvent> = {
    type: 'spawn',
    tick: 0,
    dragonId: NO_PLAYER,
    team: TEAM_EMBER,
    classId: 'talon',
    position: vec(),
  };
  private readonly castEvent: Mutable<AbilityCastEvent> = {
    type: 'abilityCast',
    tick: 0,
    dragonId: NO_PLAYER,
    classId: 'talon',
    slot: 'primary',
    position: vec(),
    direction: vec(),
  };
  private readonly assistEvent: Mutable<AssistEvent> = {
    type: 'assist',
    tick: 0,
    assisterId: NO_PLAYER,
    killerId: NO_PLAYER,
    victimId: NO_PLAYER,
  };
  private readonly statusEvent: Mutable<StatusAppliedEvent> = {
    type: 'statusApplied',
    tick: 0,
    targetId: NO_PLAYER,
    sourceId: NO_PLAYER,
    status: 'slow',
    durationS: 0,
    position: vec(),
  };
  private readonly impactEvent: Mutable<ImpactEvent> = {
    type: 'impact',
    tick: 0,
    projectile: 'fireBolt',
    ownerId: NO_PLAYER,
    targetId: NO_PLAYER,
    position: vec(),
  };

  constructor(tables: CombatTables, collision: SimCollisionWorld, state: SimState) {
    this.tables = tables;
    this.collision = collision;
    this.state = state;
    this.prev = state;
  }

  /** Points the public methods at the sim's current buffers (they swap every tick). */
  bind(state: SimState, prev: SimState): void {
    this.state = state;
    this.prev = prev;
    this.tick = state.tick;
  }

  /**
   * Metres: the sphere abilities hit this dragon with. (The tick's own loops repeat the formula
   * inline: a float returned from a call that is not inlined is boxed.)
   */
  hitRadiusOf(dragon: Readonly<DragonState>): number {
    const radius =
      this.tables.classes[dragon.classId].hitRadius * this.tables.combat.hitRadiusScale;
    return radius > 0 ? radius : 0;
  }

  // --- The tick ---------------------------------------------------------------------------------

  /** One tick of combat on `state` (already stepped dragons). `prev` is the tick before. */
  step(state: SimState, prev: SimState, tick: number): void {
    this.state = state;
    this.prev = prev;
    this.tick = tick;
    const dragons = state.dragons;

    for (let i = 0; i < dragons.length; i++) {
      const dragon = dragons[i];
      if (dragon === undefined || !dragon.active) continue;
      // What the environment did inside the dragon's own step.
      if (dragon.envSource !== ENV_SOURCE_NONE) this.noteEnvironmentDamage(dragon);
      if (
        (dragon.castPulse | dragon.castStarted) !== 0 &&
        (dragon.flags & DRAGON_FLAG_ALIVE) !== 0
      ) {
        this.executeCasts(dragon);
      }
    }

    if (state.projectileCount > 0) this.stepProjectiles();
    if (state.zoneCount > 0) this.stepZones();
    this.stepStatuses();
    this.stepDeaths();

    for (let i = 0; i < dragons.length; i++) {
      const dragon = dragons[i];
      if (dragon !== undefined && dragon.active) writeStatusFlags(dragon);
    }
  }

  // --- The damage pipeline ----------------------------------------------------------------------

  /**
   * Does an effect from `attacker` get through to `target`? False = nothing does (a ceasefire,
   * dead, its own caster, a teammate with friendly fire off, dodging, spawn-protected, phasing,
   * or fully shielded from `this.origin`). True = `this.through` holds the multiplier
   * (friendly-fire scale, a partial shield). Damage and hostile statuses share it.
   */
  private gate(target: DragonState, attacker: DragonState | null, flags: number): boolean {
    this.through = 0;
    if (this.rules.ceasefire) return false;
    if ((target.flags & DRAGON_FLAG_ALIVE) === 0) return false;
    let scale = 1;
    if (attacker !== null) {
      if (attacker === target) return false;
      if (attacker.team === target.team && (flags & DAMAGE_IGNORE_TEAM) === 0) {
        if (!this.rules.friendlyFire) return false;
        scale = this.tables.combat.friendlyFireScale;
      }
    }
    // The timers, not the flag bits: the bits are only refreshed at the end of the tick.
    if (
      (flags & DAMAGE_IGNORE_IMMUNITY) === 0 &&
      (target.dodgeImmunityTicks > 0 || target.spawnProtectTicks > 0)
    ) {
      return false;
    }
    if (target.phaseTicks > 0) return false;
    if (target.shieldTicks > 0 && (flags & DAMAGE_IGNORE_SHIELD) === 0) {
      const toX = this.origin.x - target.position.x;
      const toY = this.origin.y - target.position.y;
      const toZ = this.origin.z - target.position.z;
      const distance = Math.sqrt(toX * toX + toY * toY + toZ * toZ);
      const cosPitch = Math.cos(target.pitch);
      // On top of the shield bearer counts as in front of it.
      const facing =
        distance > EPSILON
          ? (Math.sin(target.yaw) * cosPitch * toX +
              Math.sin(target.pitch) * toY +
              Math.cos(target.yaw) * cosPitch * toZ) /
            distance
          : 1;
      if (facing >= Math.cos(this.tables.combat.shieldHalfAngle)) {
        scale *= 1 - this.tables.combat.shieldBlock;
      }
    }
    // `!(> 0)` also turns a NaN from broken tuning into "nothing gets through".
    if (!(scale > 0)) return false;
    this.through = scale;
    return true;
  }

  /**
   * THE damage pipeline: every HP an ability, a status, a zone or a mode takes goes through
   * here. In order: the target must be alive; nothing hurts its own caster; teammates only with
   * friendly fire on (then scaled); dodge immunity and spawn protection stop it; a phasing
   * dragon cannot be hit; a wing shield blocks what comes from its front (`setDamageOrigin`
   * says where from). Then the HP is removed, death is flagged (the takedown itself is credited
   * at the end of the tick), the attacker is remembered for takedown and assist credit, the
   * attacker's ultimate charges, and a `hit` event goes out.
   *
   * @param attacker The dragon to credit, or null for the environment.
   * @param source Index into DAMAGE_SOURCES (an ability slot index, or terrain / storm).
   * @param flags DAMAGE_* bits.
   * @returns The HP actually removed.
   */
  applyDamage(
    target: DragonState,
    amount: number,
    attacker: DragonState | null,
    source: number,
    flags: number,
  ): number {
    this.amount = amount;
    this.deal(target, attacker, source, flags);
    return this.applied;
  }

  /**
   * `applyDamage` for the tick's own callers: the amount comes in `this.amount` and the HP
   * removed goes out in `this.applied`, because a float passed to or returned from a call the
   * JIT does not inline is a heap number, and this runs for every hit.
   */
  private deal(
    target: DragonState,
    attacker: DragonState | null,
    source: number,
    flags: number,
  ): void {
    const amount = this.amount;
    this.applied = 0;
    if (!(amount > 0)) return;
    if (!this.gate(target, attacker, flags)) return;
    const wanted = amount * this.through;
    const applied = wanted < target.health ? wanted : target.health;
    if (!(applied > 0)) return;
    this.applied = applied;
    target.health -= applied;
    if ((flags & DAMAGE_OVER_TIME) === 0) {
      target.hitTicks = hitAnimTicksOf(this.tables.flight);
    }
    if (!(target.health > 0)) {
      target.health = 0;
      target.flags &= ~DRAGON_FLAG_ALIVE;
    }
    target.lastDamageSource = source;
    if (attacker !== null) this.creditDamage(target, attacker, source);
    this.emitHit(target, attacker !== null ? attacker.id : NO_PLAYER, source);
  }

  /** Where the next `applyDamage` / hostile status comes from (the shield's angle check). */
  setDamageOrigin(x: number, y: number, z: number): void {
    this.origin.x = x;
    this.origin.y = y;
    this.origin.z = z;
  }

  /** Credit for `this.applied` HP of damage. */
  private creditDamage(target: DragonState, attacker: DragonState, source: number): void {
    const combat = this.tables.combat;
    const applied = this.applied;
    target.lastDamagerId = attacker.id;
    target.lastDamagerTicks = creditTicksOf(combat);

    // Assist list: refresh this attacker's entry, else take the entry closest to running out.
    const ids = target.assistIds;
    const ticks = target.assistTicks;
    let entry = 0;
    let least = Infinity;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === attacker.id) {
        entry = i;
        break;
      }
      const left = ticks[i] ?? 0;
      if (left < least) {
        least = left;
        entry = i;
      }
    }
    ids[entry] = attacker.id;
    ticks[entry] = assistTicksOf(combat);

    if (attacker.team === target.team) return;
    const slot = this.slotOf(attacker);
    const score = this.state.scores[slot];
    if (score !== undefined) score.damage += applied;
    if (source !== SOURCE_ULTIMATE) {
      const charge = attacker.ultCharge + applied * combat.ultChargePerDamage;
      attacker.ultCharge = charge < 1 ? charge : 1;
    }
  }

  /**
   * Gives `target` a timed effect. Hostile effects (slow, burn, blind) pass the same gate as
   * damage from `source`; helpful ones always land on a living dragon. A longer remaining time
   * is never shortened. Emits `statusApplied` when the effect was not already running.
   *
   * @param power Speed scale (slow, haste) or HP per second (burn, regen); unused otherwise.
   * @param slot Ability slot index to credit burn damage to.
   */
  applyStatus(
    target: DragonState,
    kind: StatusKind,
    seconds: number,
    power: number,
    source: DragonState | null,
    slot: number,
    flags: number,
  ): boolean {
    this.statusS = seconds;
    this.statusPower = power;
    return this.inflict(target, kind, source, slot, flags);
  }

  /** `applyStatus` with the duration in `this.statusS` and the power in `this.statusPower`. */
  private inflict(
    target: DragonState,
    kind: StatusKind,
    source: DragonState | null,
    slot: number,
    flags: number,
  ): boolean {
    const power = this.statusPower;
    const ticks = statusTicksOf(this);
    if (ticks <= 0 || (target.flags & DRAGON_FLAG_ALIVE) === 0) return false;
    const hostile = kind === 'slow' || kind === 'burn' || kind === 'blind';
    if (hostile && !this.gate(target, source, flags)) return false;

    let before = 0;
    switch (kind) {
      case 'slow':
        before = target.slowTicks;
        if (ticks > before) target.slowTicks = ticks;
        target.slowScale = power;
        break;
      case 'burn':
        before = target.burnTicks;
        if (ticks > before) target.burnTicks = ticks;
        target.burnDps = power;
        target.burnSourceId = source !== null ? source.id : NO_PLAYER;
        target.burnSlot = slot;
        break;
      case 'blind':
        before = target.blindTicks;
        if (ticks > before) target.blindTicks = ticks;
        break;
      case 'regen':
        before = target.regenTicks;
        if (ticks > before) target.regenTicks = ticks;
        target.regenPerS = power;
        break;
      case 'haste':
        before = target.hasteTicks;
        if (ticks > before) target.hasteTicks = ticks;
        target.hasteScale = power;
        break;
      case 'shield':
        before = target.shieldTicks;
        if (ticks > before) target.shieldTicks = ticks;
        break;
      case 'veil':
        before = target.veilTicks;
        if (ticks > before) target.veilTicks = ticks;
        break;
      case 'phase':
        before = target.phaseTicks;
        if (ticks > before) target.phaseTicks = ticks;
        break;
    }
    if (before <= 0) this.emitStatus(target, source !== null ? source.id : NO_PLAYER, kind);
    return true;
  }

  /** Adds to a dragon's ultimate charge (objectives). */
  addUltimateCharge(dragon: DragonState, amount: number): void {
    if (!(amount > 0)) return;
    const charge = dragon.ultCharge + amount;
    dragon.ultCharge = charge < 1 ? charge : 1;
  }

  // --- Casts ------------------------------------------------------------------------------------

  private executeCasts(caster: DragonState): void {
    const defs = this.tables.abilities[caster.classId];
    const started = caster.castStarted;
    const pulse = caster.castPulse;
    for (let slot = 0; slot < ABILITY_SLOTS.length; slot++) {
      const bit = 1 << slot;
      if (((started | pulse) & bit) === 0) continue;
      const def = abilityOfSlot(defs, slot);
      if (def === undefined) continue;
      resolveFireDirection(caster, def.aimLimit, this.dir);

      if ((started & bit) !== 0) {
        this.emitCast(caster, slot);
        if (def.selfStatus !== null) {
          this.statusS = def.durationS;
          this.emitStatus(caster, caster.id, def.selfStatus);
        }
      }
      if ((pulse & bit) === 0) continue;

      switch (def.kind) {
        case 'projectile':
          if (def.projectile !== null) this.launchProjectile(caster, slot, def, def.projectile);
          break;
        case 'cone':
          this.castCone(caster, slot, def);
          break;
        case 'beam':
          this.castBeam(caster, slot, def);
          break;
        case 'dash':
          if (def.damage > 0) this.castDash(caster, slot, def);
          break;
        case 'zone':
          if (def.zone !== null) this.castZone(caster, slot, def, def.zone);
          break;
        case 'wave':
          this.castWave(caster, slot, def);
          break;
        case 'buff':
          break;
      }
    }
  }

  /** May `caster`'s ability touch `target` at all? Enemies, or anyone else with friendly fire. */
  private hostileTo(caster: Readonly<DragonState>, target: Readonly<DragonState>): boolean {
    if (target === caster || !target.active || (target.flags & DRAGON_FLAG_ALIVE) === 0)
      return false;
    return target.team !== caster.team || this.rules.friendlyFire;
  }

  private launchProjectile(
    caster: DragonState,
    slot: number,
    def: AbilityDef,
    kind: ProjectileKind,
  ): void {
    const state = this.state;
    const pdef = this.tables.projectiles[kind];
    // Pool full: the shot is simply not fired (the cooldown is spent all the same).
    if (state.projectileCount >= state.projectiles.length) return;
    let projectile: ProjectileState | undefined;
    for (let i = 0; i < state.projectiles.length; i++) {
      const candidate = state.projectiles[i];
      if (candidate !== undefined && !candidate.active) {
        projectile = candidate;
        break;
      }
    }
    if (projectile === undefined) return;

    const dir = this.dir;
    const muzzle = this.tables.classes[caster.classId].hitRadius + pdef.radius + MUZZLE_GAP_M;
    projectile.active = true;
    projectile.id = state.nextProjectileId;
    state.nextProjectileId = (state.nextProjectileId + 1) & 0xffff;
    projectile.kind = PROJECTILE_KINDS.indexOf(kind);
    projectile.ownerId = caster.id;
    projectile.team = caster.team;
    projectile.slot = slot;
    projectile.damage = def.damage;
    projectile.position.x = caster.position.x + dir.x * muzzle;
    projectile.position.y = caster.position.y + dir.y * muzzle;
    projectile.position.z = caster.position.z + dir.z * muzzle;
    projectile.velocity.x = dir.x * pdef.speed + caster.velocity.x * pdef.inheritVelocity;
    projectile.velocity.y = dir.y * pdef.speed + caster.velocity.y * pdef.inheritVelocity;
    projectile.velocity.z = dir.z * pdef.speed + caster.velocity.z * pdef.inheritVelocity;
    const life = lifeTicksOf(pdef);
    projectile.ticksLeft = life > 0 ? life : 1;
    state.projectileCount++;
  }

  /**
   * Is the straight line from the caster to the sampled target (`this.targetPos`) clear?
   * `this.losDistance` is the distance to it and `this.losRadius` its hit radius.
   */
  private lineOfSight(caster: Readonly<DragonState>): boolean {
    const distance = this.losDistance;
    const targetRadius = this.losRadius;
    const collision = this.collision;
    if (collision.raycastRay === undefined) return true;
    const reach = distance - targetRadius;
    if (!(reach > 0)) return true;
    const ray = this.ray;
    ray.originX = caster.position.x;
    ray.originY = caster.position.y;
    ray.originZ = caster.position.z;
    ray.directionX = this.targetPos.x - caster.position.x;
    ray.directionY = this.targetPos.y - caster.position.y;
    ray.directionZ = this.targetPos.z - caster.position.z;
    ray.maxDistance = reach;
    return collision.raycastRay(ray) < 0;
  }

  /** Damage plus the ability's status on one target, from the caster's position. */
  private strike(caster: DragonState, target: DragonState, slot: number, def: AbilityDef): void {
    this.origin.x = caster.position.x;
    this.origin.y = caster.position.y;
    this.origin.z = caster.position.z;
    if (def.damage > 0) {
      this.amount = def.damage;
      this.deal(target, caster, slot, 0);
    }
    if (def.status !== null) {
      this.statusS = def.statusS;
      this.statusPower = def.statusPower;
      this.inflict(target, def.status, caster, slot, 0);
    }
  }

  private castCone(caster: DragonState, slot: number, def: AbilityDef): void {
    const dragons = this.state.dragons;
    const dir = this.dir;
    const pos = this.targetPos;
    const tan = Math.tan(
      def.coneHalfAngle < 1.5 ? (def.coneHalfAngle > 0 ? def.coneHalfAngle : 0) : 1.5,
    );
    for (let i = 0; i < dragons.length; i++) {
      const target = dragons[i];
      if (target === undefined || !this.hostileTo(caster, target)) continue;
      this.targets.sample(caster.id, target, this.tick, pos);
      const radius =
        this.tables.classes[target.classId].hitRadius * this.tables.combat.hitRadiusScale;
      const toX = pos.x - caster.position.x;
      const toY = pos.y - caster.position.y;
      const toZ = pos.z - caster.position.z;
      const along = toX * dir.x + toY * dir.y + toZ * dir.z;
      if (along < -radius) continue;
      const distanceSq = toX * toX + toY * toY + toZ * toZ;
      const reach = def.range + radius;
      if (distanceSq > reach * reach) continue;
      // The cone, widened by the target's radius: its sphere only has to touch it.
      const perpSq = distanceSq - along * along;
      const width = (along > 0 ? along : 0) * tan + radius;
      if (perpSq > width * width) continue;
      this.losDistance = Math.sqrt(distanceSq);
      this.losRadius = radius;
      if (!this.lineOfSight(caster)) continue;
      this.strike(caster, target, slot, def);
    }
  }

  private castBeam(caster: DragonState, slot: number, def: AbilityDef): void {
    const dir = this.dir;
    const collision = this.collision;
    let reach = def.range;
    if (!(reach > 0)) return;
    if (collision.raycastRay !== undefined) {
      const ray = this.ray;
      ray.originX = caster.position.x;
      ray.originY = caster.position.y;
      ray.originZ = caster.position.z;
      ray.directionX = dir.x;
      ray.directionY = dir.y;
      ray.directionZ = dir.z;
      ray.maxDistance = reach;
      const blocked = collision.raycastRay(ray);
      if (blocked >= 0) reach = blocked;
    }

    // The first dragon along the ray takes it.
    const dragons = this.state.dragons;
    const pos = this.targetPos;
    let best: DragonState | null = null;
    let bestAlong = reach;
    for (let i = 0; i < dragons.length; i++) {
      const target = dragons[i];
      if (target === undefined || !this.hostileTo(caster, target) || target.phaseTicks > 0)
        continue;
      this.targets.sample(caster.id, target, this.tick, pos);
      const radius =
        this.tables.classes[target.classId].hitRadius * this.tables.combat.hitRadiusScale +
        def.radius;
      const toX = pos.x - caster.position.x;
      const toY = pos.y - caster.position.y;
      const toZ = pos.z - caster.position.z;
      const along = toX * dir.x + toY * dir.y + toZ * dir.z;
      const perpSq = toX * toX + toY * toY + toZ * toZ - along * along;
      if (perpSq > radius * radius) continue;
      // Where the ray enters the sphere (0 if it starts inside).
      const enter = along - Math.sqrt(radius * radius - perpSq);
      const hitAt = enter > 0 ? enter : 0;
      if (along + radius < 0 || hitAt > bestAlong) continue;
      bestAlong = hitAt;
      best = target;
    }
    if (best !== null) this.strike(caster, best, slot, def);
  }

  private castDash(caster: DragonState, slot: number, def: AbilityDef): void {
    const dragons = this.state.dragons;
    for (let i = 0; i < dragons.length; i++) {
      const target = dragons[i];
      if (target === undefined || !this.hostileTo(caster, target)) continue;
      const bit = 1 << i;
      if ((caster.abilityHitMask & bit) !== 0) continue;
      const reach =
        def.radius +
        this.tables.classes[target.classId].hitRadius * this.tables.combat.hitRadiusScale;
      const toX = target.position.x - caster.position.x;
      const toY = target.position.y - caster.position.y;
      const toZ = target.position.z - caster.position.z;
      if (toX * toX + toY * toY + toZ * toZ > reach * reach) continue;
      // Once per dash, whether or not the hit got through.
      caster.abilityHitMask |= bit;
      this.strike(caster, target, slot, def);
    }
  }

  private castWave(caster: DragonState, slot: number, def: AbilityDef): void {
    const dragons = this.state.dragons;
    const dir = this.dir;
    const allies = (def.tags & ABILITY_TAG_ALLIES) !== 0;
    const allAround = !(def.coneHalfAngle < Math.PI);
    const cosCone = allAround ? -1 : Math.cos(def.coneHalfAngle);
    for (let i = 0; i < dragons.length; i++) {
      const target = dragons[i];
      if (target === undefined || !target.active) continue;
      if ((target.flags & DRAGON_FLAG_ALIVE) === 0) continue;
      if (allies ? target.team !== caster.team : !this.hostileTo(caster, target)) continue;
      const reach =
        def.range +
        this.tables.classes[target.classId].hitRadius * this.tables.combat.hitRadiusScale;
      let toX = target.position.x - caster.position.x;
      let toY = target.position.y - caster.position.y;
      let toZ = target.position.z - caster.position.z;
      const distanceSq = toX * toX + toY * toY + toZ * toZ;
      if (distanceSq > reach * reach) continue;
      const distance = Math.sqrt(distanceSq);
      if (distance > EPSILON) {
        toX /= distance;
        toY /= distance;
        toZ /= distance;
      } else {
        toX = dir.x;
        toY = dir.y;
        toZ = dir.z;
      }
      if (!allAround && toX * dir.x + toY * dir.y + toZ * dir.z < cosCone) continue;

      if (allies) {
        if (def.status !== null) {
          this.statusS = def.statusS;
          this.statusPower = def.statusPower;
          this.inflict(target, def.status, caster, slot, 0);
        }
        continue;
      }
      this.origin.x = caster.position.x;
      this.origin.y = caster.position.y;
      this.origin.z = caster.position.z;
      // What the gate lets through of the damage also decides the push and the status.
      if (!this.gate(target, caster, 0)) continue;
      const through = this.through;
      // All-around proximity bursts fall off with distance; full-power waves (Bastion bulwark)
      // keep flat damage when knockback is the main feel.
      const falloff =
        allAround && def.knockback < 30
          ? 1 - 0.7 * (distance / Math.max(reach, EPSILON))
          : 1;
      if (def.damage > 0) {
        this.amount = def.damage * falloff * through;
        this.deal(target, caster, slot, 0);
      }
      if (def.status !== null) {
        this.statusS = def.statusS;
        this.statusPower = def.statusPower;
        this.inflict(target, def.status, caster, slot, 0);
      }
      if (def.knockback > 0) {
        const push = def.knockback * through * falloff;
        target.burst.x += toX * push;
        target.burst.y += toY * push;
        target.burst.z += toZ * push;
        const maxBurst = this.tables.flight.maxBurstSpeed;
        if (maxBurst > 0) {
          const burst = target.burst;
          const mag = Math.sqrt(burst.x * burst.x + burst.y * burst.y + burst.z * burst.z);
          if (mag > maxBurst) {
            const scale = maxBurst / mag;
            burst.x *= scale;
            burst.y *= scale;
            burst.z *= scale;
          }
        }
      }
    }
  }

  private castZone(caster: DragonState, slot: number, def: AbilityDef, kind: ZoneKind): void {
    const dir = this.dir;
    let distance = def.zoneOffset > 0 ? def.zoneOffset : 0;
    const collision = this.collision;
    if (distance > 0 && collision.raycastRay !== undefined) {
      const ray = this.ray;
      ray.originX = caster.position.x;
      ray.originY = caster.position.y;
      ray.originZ = caster.position.z;
      ray.directionX = dir.x;
      ray.directionY = dir.y;
      ray.directionZ = dir.z;
      ray.maxDistance = distance;
      const blocked = collision.raycastRay(ray);
      if (blocked >= 0) distance = blocked > ZONE_TERRAIN_GAP_M ? blocked - ZONE_TERRAIN_GAP_M : 0;
    }
    this.point.x = caster.position.x + dir.x * distance;
    this.point.y = caster.position.y + dir.y * distance;
    this.point.z = caster.position.z + dir.z * distance;
    this.placeZone(kind, caster.id, caster.team, slot);
  }

  // --- Projectiles ------------------------------------------------------------------------------

  private stepProjectiles(): void {
    const state = this.state;
    const projectiles = state.projectiles;
    const dragons = state.dragons;
    const collision = this.collision;
    const dt = TICK_DT_S;
    const pos = this.targetPos;
    const ray = this.ray;
    const friendlyFire = this.rules.friendlyFire;

    for (let p = 0; p < projectiles.length; p++) {
      const projectile = projectiles[p];
      if (projectile === undefined || !projectile.active) continue;
      const kind = PROJECTILE_KINDS[projectile.kind];
      if (kind === undefined) {
        projectile.active = false;
        state.projectileCount--;
        continue;
      }
      const pdef = this.tables.projectiles[kind];
      const position = projectile.position;
      const velocity = projectile.velocity;
      velocity.y -= pdef.gravity * dt;
      const speed = Math.sqrt(
        velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
      );
      // `speed - speed` is NaN for NaN and Infinity: a broken projectile just ends.
      if (speed - speed !== 0) {
        projectile.active = false;
        state.projectileCount--;
        continue;
      }
      const travel = speed * dt;
      const ux = speed > EPSILON ? velocity.x / speed : 0;
      const uy = speed > EPSILON ? velocity.y / speed : 0;
      const uz = speed > EPSILON ? velocity.z / speed : 1;

      // Terrain along this tick's segment.
      let stopAt = travel;
      let stopped = false;
      if (!pdef.passThrough && collision.raycastRay !== undefined && travel > EPSILON) {
        ray.originX = position.x;
        ray.originY = position.y;
        ray.originZ = position.z;
        ray.directionX = ux;
        ray.directionY = uy;
        ray.directionZ = uz;
        ray.maxDistance = travel;
        const blocked = collision.raycastRay(ray);
        if (blocked >= 0) {
          stopAt = blocked;
          stopped = true;
        }
      }

      // Dragons along the segment up to there: the nearest one wins.
      let victim: DragonState | null = null;
      for (let i = 0; !pdef.passThrough && i < dragons.length; i++) {
        const target = dragons[i];
        if (target === undefined || !target.active) continue;
        if ((target.flags & DRAGON_FLAG_ALIVE) === 0 || target.id === projectile.ownerId) continue;
        if (target.team === projectile.team && !friendlyFire) continue;
        // Out of phase: the shot passes through.
        if (target.phaseTicks > 0) continue;
        this.targets.sample(projectile.ownerId, target, this.tick, pos);
        const radius =
          this.tables.classes[target.classId].hitRadius * this.tables.combat.hitRadiusScale +
          pdef.radius;
        const mx = position.x - pos.x;
        const my = position.y - pos.y;
        const mz = position.z - pos.z;
        const b = mx * ux + my * uy + mz * uz;
        const c = mx * mx + my * my + mz * mz - radius * radius;
        // Outside the sphere and moving away from it.
        if (c > 0 && b > 0) continue;
        const discriminant = b * b - c;
        if (discriminant < 0) continue;
        let enter = -b - Math.sqrt(discriminant);
        if (enter < 0) enter = 0;
        if (enter > stopAt) continue;
        stopAt = enter;
        victim = target;
      }

      if (victim !== null || stopped) {
        this.point.x = position.x + ux * stopAt;
        this.point.y = position.y + uy * stopAt;
        this.point.z = position.z + uz * stopAt;
        this.endProjectile(projectile, kind, pdef, victim);
        continue;
      }
      position.x += velocity.x * dt;
      position.y += velocity.y * dt;
      position.z += velocity.z * dt;
      projectile.ticksLeft--;
      if (projectile.ticksLeft <= 0) {
        this.point.x = position.x;
        this.point.y = position.y;
        this.point.z = position.z;
        this.endProjectile(projectile, kind, pdef, null);
      }
    }
  }

  /** The projectile ends at `this.point`: direct hit, blast, the zone it leaves, the event. */
  private endProjectile(
    projectile: ProjectileState,
    kind: ProjectileKind,
    pdef: ProjectileDef,
    victim: DragonState | null,
  ): void {
    const state = this.state;
    const point = this.point;
    const owner = this.findActive(projectile.ownerId);
    projectile.active = false;
    state.projectileCount--;

    if (pdef.blastRadius > 0) {
      const dragons = state.dragons;
      const edge = pdef.blastEdgeScale;
      for (let i = 0; i < dragons.length; i++) {
        const target = dragons[i];
        if (target === undefined || !target.active) continue;
        if ((target.flags & DRAGON_FLAG_ALIVE) === 0 || target.id === projectile.ownerId) continue;
        if (target.team === projectile.team && !this.rules.friendlyFire) continue;
        const dx = target.position.x - point.x;
        const dy = target.position.y - point.y;
        const dz = target.position.z - point.z;
        const reach =
          pdef.blastRadius +
          this.tables.classes[target.classId].hitRadius * this.tables.combat.hitRadiusScale;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq > reach * reach) continue;
        const fraction = Math.sqrt(distanceSq) / reach;
        this.origin.x = point.x;
        this.origin.y = point.y;
        this.origin.z = point.z;
        if (projectile.damage > 0) {
          this.amount = projectile.damage * (1 - (1 - edge) * fraction);
          this.deal(target, owner, projectile.slot, 0);
        }
        if (pdef.status !== null) {
          this.statusS = pdef.statusS;
          this.statusPower = pdef.statusPower;
          this.inflict(target, pdef.status, owner, projectile.slot, 0);
        }
      }
    } else if (victim !== null) {
      // From where the projectile came, so a shield facing the shooter blocks it.
      this.origin.x = point.x - projectile.velocity.x;
      this.origin.y = point.y - projectile.velocity.y;
      this.origin.z = point.z - projectile.velocity.z;
      if (projectile.damage > 0) {
        this.amount = projectile.damage;
        this.deal(victim, owner, projectile.slot, 0);
      }
      if (pdef.status !== null) {
        this.statusS = pdef.statusS;
        this.statusPower = pdef.statusPower;
        this.inflict(victim, pdef.status, owner, projectile.slot, 0);
      }
    }

    if (pdef.zoneOnEnd !== null) {
      this.placeZone(pdef.zoneOnEnd, projectile.ownerId, projectile.team, projectile.slot);
    }
    // A plain bolt needs no event: clients fly their own copy and the `hit` event marks a hit.
    if (pdef.blastRadius > 0 || pdef.zoneOnEnd !== null) {
      const events = this.events;
      if (events !== null) {
        const event = this.impactEvent;
        event.tick = this.tick;
        event.projectile = kind;
        event.ownerId = projectile.ownerId;
        event.targetId = victim !== null ? victim.id : NO_PLAYER;
        event.position.x = point.x;
        event.position.y = point.y;
        event.position.z = point.z;
        events.emit(event);
      }
    }
  }

  // --- Zones ------------------------------------------------------------------------------------

  /** Puts a zone at `this.point`. With the pool full, the zone closest to ending makes room. */
  private placeZone(
    kind: ZoneKind,
    ownerId: PlayerId,
    team: DragonState['team'],
    slot: number,
  ): void {
    const state = this.state;
    const zdef = this.tables.zones[kind];
    const life = durationTicksOf(zdef);
    if (life <= 0 || !(zdef.radius > 0)) return;
    let zone: ZoneState | undefined;
    let oldest: ZoneState | undefined;
    for (let i = 0; i < state.zones.length; i++) {
      const candidate = state.zones[i];
      if (candidate === undefined) continue;
      if (!candidate.active) {
        zone = candidate;
        break;
      }
      if (oldest === undefined || candidate.ticksLeft < oldest.ticksLeft) oldest = candidate;
    }
    if (zone === undefined) {
      if (oldest === undefined) return;
      zone = oldest;
    } else {
      state.zoneCount++;
    }
    // 1..255: 0 is the storm wall in the views.
    state.nextZoneId = (state.nextZoneId % 255) + 1;
    zone.active = true;
    zone.id = state.nextZoneId;
    zone.kind = ZONE_KINDS.indexOf(kind);
    zone.ownerId = ownerId;
    zone.team = team;
    zone.slot = slot;
    zone.position.x = this.point.x;
    zone.position.y = this.point.y;
    zone.position.z = this.point.z;
    zone.radius = zdef.radius;
    zone.ticksLeft = life;
    zone.ageTicks = 0;
  }

  private stepZones(): void {
    const state = this.state;
    const zones = state.zones;
    for (let z = 0; z < zones.length; z++) {
      const zone = zones[z];
      if (zone === undefined || !zone.active) continue;
      const kind = ZONE_KINDS[zone.kind];
      const owner = this.findActive(zone.ownerId);
      let ended = kind === undefined;
      if (kind !== undefined) {
        const zdef = this.tables.zones[kind];
        if (zdef.follow) {
          if (owner === null || (owner.flags & DRAGON_FLAG_ALIVE) === 0) ended = true;
          else {
            zone.position.x = owner.position.x;
            zone.position.y = owner.position.y;
            zone.position.z = owner.position.z;
          }
        }
        if (!ended) {
          const interval = pulseTicksOf(zdef);
          if (interval > 0 && zone.ageTicks % interval === 0) this.pulseZone(zone, zdef, owner);
          zone.ageTicks++;
          zone.ticksLeft--;
          if (zone.ticksLeft <= 0) ended = true;
        }
      }
      if (ended) {
        zone.active = false;
        state.zoneCount--;
      }
    }
  }

  private pulseZone(zone: ZoneState, zdef: ZoneDef, owner: DragonState | null): void {
    const dragons = this.state.dragons;
    const allyStatus =
      zdef.allyStatus !== null
        ? zdef.allyStatus
        : zdef.status === 'regen' || zdef.status === 'haste'
          ? zdef.status
          : null;
    const allyS = zdef.allyStatus !== null ? zdef.allyStatusS : zdef.statusS;
    const allyPower = zdef.allyStatus !== null ? zdef.allyStatusPower : zdef.statusPower;
    const enemyStatus =
      zdef.status !== null && zdef.status !== 'regen' && zdef.status !== 'haste'
        ? zdef.status
        : null;
    this.origin.x = zone.position.x;
    this.origin.y = zone.position.y;
    this.origin.z = zone.position.z;
    for (let i = 0; i < dragons.length; i++) {
      const target = dragons[i];
      if (target === undefined || !target.active) continue;
      if ((target.flags & DRAGON_FLAG_ALIVE) === 0) continue;
      const dx = target.position.x - zone.position.x;
      const dy = target.position.y - zone.position.y;
      const dz = target.position.z - zone.position.z;
      const reach =
        zone.radius +
        this.tables.classes[target.classId].hitRadius * this.tables.combat.hitRadiusScale;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;

      if (target.team === zone.team) {
        if (allyStatus !== null) {
          this.statusS = allyS;
          this.statusPower = allyPower;
          this.inflict(target, allyStatus, owner, zone.slot, DAMAGE_IGNORE_SHIELD);
        }
        continue;
      }
      if (target.id === zone.ownerId) continue;
      // A zone is all around its victim: no shield helps.
      if (zdef.damage > 0) {
        this.amount = zdef.damage;
        this.deal(target, owner, zone.slot, DAMAGE_IGNORE_SHIELD);
      }
      if (enemyStatus !== null) {
        this.statusS = zdef.statusS;
        this.statusPower = zdef.statusPower;
        this.inflict(target, enemyStatus, owner, zone.slot, DAMAGE_IGNORE_SHIELD);
      }
      if (zdef.driftPower > 0) {
        // Deterministic nudge from id + tick so host and predicted clients stay aligned.
        const seed = ((this.tick * 1103515245 + target.id * 12345) >>> 0) & 0xffff;
        const ang = (seed / 0xffff) * Math.PI * 2;
        const lift = (((seed >> 8) & 0xff) / 255) * 2 - 1;
        const push = zdef.driftPower;
        target.burst.x += Math.cos(ang) * push;
        target.burst.y += lift * push * 0.65;
        target.burst.z += Math.sin(ang) * push;
      }
    }
  }

  // --- Statuses ---------------------------------------------------------------------------------

  private stepStatuses(): void {
    const dragons = this.state.dragons;
    const combat = this.tables.combat;
    let interval = statusPulseTicksOf(combat);
    if (interval < 1) interval = 1;
    const pulseS = interval * TICK_DT_S;
    const passive = combat.ultChargePerS * TICK_DT_S;
    for (let i = 0; i < dragons.length; i++) {
      const dragon = dragons[i];
      if (dragon === undefined || !dragon.active) continue;
      if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0) continue;
      if (passive > 0 && dragon.ultCharge < 1) {
        const charge = dragon.ultCharge + passive;
        dragon.ultCharge = charge < 1 ? charge : 1;
      }
      // Pulses run on the sim tick (staggered by slot), so refreshing a status cannot starve them.
      if ((this.tick + i) % interval !== 0) continue;
      if (dragon.regenTicks > 0 && dragon.regenPerS > 0 && dragon.health < dragon.maxHealth) {
        const health = dragon.health + dragon.regenPerS * pulseS;
        dragon.health = health < dragon.maxHealth ? health : dragon.maxHealth;
      }
      if (dragon.burnTicks > 0 && dragon.burnDps > 0) {
        this.amount = dragon.burnDps * pulseS;
        this.deal(
          dragon,
          this.findActive(dragon.burnSourceId),
          dragon.burnSlot,
          DAMAGE_IGNORE_SHIELD | DAMAGE_OVER_TIME,
        );
      }
    }
  }

  // --- Environment, deaths, respawns ------------------------------------------------------------

  /** Terrain or storm damage the collision world took inside this dragon's step. */
  private noteEnvironmentDamage(dragon: DragonState): void {
    const terrain = dragon.envSource === ENV_SOURCE_TERRAIN;
    dragon.lastDamageSource = terrain ? SOURCE_TERRAIN : SOURCE_STORM;
    // The storm ticks every tick: its damage shows on the health bar, not as 30 events a second.
    if (terrain && dragon.envDamage > 0) {
      this.applied = dragon.envDamage;
      this.emitHit(dragon, NO_PLAYER, SOURCE_TERRAIN);
    }
  }

  private stepDeaths(): void {
    const state = this.state;
    const dragons = state.dragons;
    const policy = this.respawnPolicy;
    const delay = respawnTicksOf(this.tables.match);
    for (let i = 0; i < dragons.length; i++) {
      const dragon = dragons[i];
      if (dragon === undefined || !dragon.active) continue;
      if ((dragon.flags & DRAGON_FLAG_ALIVE) !== 0) {
        dragon.downed = false;
        continue;
      }
      if (!dragon.downed) {
        dragon.downed = true;
        this.onDeath(dragon, i);
      }
      // `deadTicks` is counted by the dragon's own step (a client predicts it).
      if (policy.enabled && dragon.deadTicks >= delay) this.respawn(dragon, i);
    }
  }

  private onDeath(victim: DragonState, slot: number): void {
    const state = this.state;
    const score = state.scores[slot];
    if (score !== undefined) score.deaths++;

    // Whoever hurt it last within the credit window gets the takedown, also when terrain or the
    // storm finished the job. Otherwise the environment did it.
    let killer: DragonState | null = null;
    if (victim.lastDamagerTicks > 0 && victim.lastDamagerId !== victim.id) {
      killer = this.findActive(victim.lastDamagerId);
    }
    const killerId = killer !== null ? killer.id : NO_PLAYER;
    if (killer !== null && killer.team !== victim.team) {
      const killerScore = state.scores[this.slotOf(killer)];
      if (killerScore !== undefined) killerScore.takedowns++;
      state.teamTakedowns[killer.team] = (state.teamTakedowns[killer.team] ?? 0) + 1;
      this.addUltimateCharge(killer, this.tables.combat.ultChargePerTakedown);
    }
    // Kept after death: the death cam orbits this dragon.
    victim.lastDamagerId = killerId;
    victim.lastDamagerTicks = 0;

    const events = this.events;
    if (events !== null) {
      const event = this.takedownEvent;
      event.tick = this.tick;
      event.killerId = killerId;
      event.victimId = victim.id;
      event.source = DAMAGE_SOURCES[victim.lastDamageSource] ?? 'terrain';
      event.position.x = victim.position.x;
      event.position.y = victim.position.y;
      event.position.z = victim.position.z;
      events.emit(event);
    }

    const ids = victim.assistIds;
    const ticks = victim.assistTicks;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] ?? NO_PLAYER;
      const live = (ticks[i] ?? 0) > 0;
      ids[i] = NO_PLAYER;
      ticks[i] = 0;
      if (!live || id === NO_PLAYER || id === killerId || id === victim.id) continue;
      const assister = this.findActive(id);
      if (assister === null || assister.team === victim.team) continue;
      const assistScore = state.scores[this.slotOf(assister)];
      if (assistScore !== undefined) assistScore.assists++;
      if (events !== null) {
        const event = this.assistEvent;
        event.tick = this.tick;
        event.assisterId = id;
        event.killerId = killerId;
        event.victimId = victim.id;
        events.emit(event);
      }
    }

    cancelAbilities(victim);
    victim.slowTicks = 0;
    victim.hasteTicks = 0;
    victim.burnTicks = 0;
    victim.regenTicks = 0;
    victim.blindTicks = 0;
    victim.veilTicks = 0;
    victim.phaseTicks = 0;
    victim.shieldTicks = 0;
  }

  /**
   * Brings a dragon back at its home pose (or where the policy puts it) with full health, fresh
   * cooldowns and spawn protection. Its ultimate charge and score are kept. The slot in `prev`
   * is rewritten too, so no view interpolates it in from where it died.
   */
  respawn(dragon: DragonState, slot: number): void {
    const tables = this.tables;
    const pose = this.pose;
    pose.x = dragon.home.x;
    pose.y = dragon.home.y;
    pose.z = dragon.home.z;
    pose.yaw = dragon.homeYaw;
    const homeX = pose.x;
    const homeY = pose.y;
    const homeZ = pose.z;
    const homeYaw = pose.yaw;
    const place = this.respawnPolicy.place;
    if (place !== null) place(dragon, pose);

    const ultCharge = dragon.ultCharge;
    const lastDamagerId = dragon.lastDamagerId;
    initDragon(
      dragon,
      dragon.id,
      dragon.team,
      dragon.classId,
      pose.x,
      pose.y,
      pose.z,
      pose.yaw,
      tables.flight,
      tables.classes[dragon.classId],
      tables.match,
    );
    dragon.ultCharge = ultCharge;
    dragon.lastDamagerId = lastDamagerId;
    dragon.home.x = homeX;
    dragon.home.y = homeY;
    dragon.home.z = homeZ;
    dragon.homeYaw = homeYaw;

    const before = this.prev.dragons[slot];
    if (before !== undefined && before !== dragon && before.active) copyDragonState(before, dragon);

    const events = this.events;
    if (events !== null) {
      const event = this.spawnEvent;
      event.tick = this.tick;
      event.dragonId = dragon.id;
      event.team = dragon.team;
      event.classId = dragon.classId;
      event.position.x = dragon.position.x;
      event.position.y = dragon.position.y;
      event.position.z = dragon.position.z;
      events.emit(event);
    }
  }

  // --- Helpers ----------------------------------------------------------------------------------

  private findActive(id: PlayerId): DragonState | null {
    if (id === NO_PLAYER) return null;
    const dragons = this.state.dragons;
    for (let i = 0; i < dragons.length; i++) {
      const dragon = dragons[i];
      if (dragon !== undefined && dragon.active && dragon.id === id) return dragon;
    }
    return null;
  }

  private slotOf(dragon: DragonState): number {
    return this.state.dragons.indexOf(dragon);
  }

  /** A `hit` event for `this.applied` HP. */
  private emitHit(target: DragonState, attackerId: PlayerId, source: number): void {
    const events = this.events;
    if (events === null) return;
    const event = this.hitEvent;
    event.tick = this.tick;
    event.attackerId = attackerId;
    event.targetId = target.id;
    event.source = DAMAGE_SOURCES[source] ?? 'terrain';
    event.damage = this.applied;
    event.position.x = target.position.x;
    event.position.y = target.position.y;
    event.position.z = target.position.z;
    events.emit(event);
  }

  private emitCast(caster: DragonState, slot: number): void {
    const events = this.events;
    const name = ABILITY_SLOTS[slot];
    if (events === null || name === undefined) return;
    const event = this.castEvent;
    event.tick = this.tick;
    event.dragonId = caster.id;
    event.classId = caster.classId;
    event.slot = name;
    event.position.x = caster.position.x;
    event.position.y = caster.position.y;
    event.position.z = caster.position.z;
    event.direction.x = this.dir.x;
    event.direction.y = this.dir.y;
    event.direction.z = this.dir.z;
    events.emit(event);
  }

  /** A `statusApplied` event lasting `this.statusS`. */
  private emitStatus(target: DragonState, sourceId: PlayerId, status: StatusKind): void {
    const events = this.events;
    if (events === null) return;
    const event = this.statusEvent;
    event.tick = this.tick;
    event.targetId = target.id;
    event.sourceId = sourceId;
    event.status = status;
    event.durationS = this.statusS;
    event.position.x = target.position.x;
    event.position.y = target.position.y;
    event.position.z = target.position.z;
    events.emit(event);
  }
}
