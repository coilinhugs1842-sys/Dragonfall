/**
 * The bot rider (T-3.10): one `BotBrain` per bot turns a read-only look at the sim state into
 * the same `InputFrame` a person's devices produce. It has no other way to act: everything it
 * does goes through the flight model and the ability state machine like anyone's input, so the
 * host stays the only authority and a bot cannot do what a rider could not.
 *
 * WHAT IT DOES, in order of priority (later steps overrule earlier ones):
 *   1. a goal heading from its mode: PATROL (a weaving circle), ENGAGE (nose onto the lead
 *      point of its target), EXTEND (fly straight out of a turning fight, then come back),
 *      RETREAT (to a healthy ally or its own gate while it is badly hurt), OBJECTIVE (Ember
 *      Relay: to the enemy's shard, home to its brazier with it, to its own dropped shard);
 *   2. the storm wall: turn back before it;
 *   3. terrain: feeler rays along the flight path (the centre one every tick, two of six others
 *      in turn) pick a side to pass on and a way over or under;
 *   4. the altitude band above the cloud sea and under the ceiling;
 *   5. the stall: no climb the speed cannot pay for, nose down and boost when stalled.
 * On top of the steering: boost / flap / dive, the primary when the target is in range, in the
 * aim window, in sight and not spawn protected, the other three abilities by rules read from
 * the ability table's kinds and tags (not from class names), and the dodge roll.
 *
 * EMBER RELAY (T-6.3), decided on every re-plan from `state.relay`: the bot that carries the
 * enemy's shard flies it to its own brazier; the mate nearest to the team's own dropped shard
 * fetches it; while the enemy's shard can be taken the nearest half of the team goes for it;
 * everybody else fights as usual, preferring the enemy that carries their shard and enemies
 * near a mate who carries. A bot on such an errand still fires at what crosses its nose.
 *
 * COST: steering every tick; targets, mode and abilities every `replanS` (staggered per bot by
 * its seed). Three terrain rays per tick plus one per enemy in sight per re-plan.
 *
 * DETERMINISTIC: no clock, no `Math.random`; its own seeded generator. The same seed and the
 * same sequence of states give the same inputs. `think` allocates nothing.
 */

import {
  ABILITY_TABLE,
  ABILITY_TAG_ALLIES,
  BUTTON_AIM,
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_DODGE_RIGHT,
  BUTTON_FLAP,
  BUTTON_PRIMARY,
  BUTTON_ROLL_LEFT,
  BUTTON_ROLL_RIGHT,
  CLASS_TUNING,
  COMBAT_TUNING,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_STALLED,
  FLIGHT_TUNING,
  NO_PLAYER,
  PROJECTILE_DEFS,
  SHARD_CARRIED,
  SHARD_DROPPED,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  TICK_HZ,
  ZONE_DEFS,
} from '../../shared';
import type {
  AbilityDef,
  AbilityTable,
  ClassAbilities,
  ClassTuning,
  CombatTuning,
  DragonClassId,
  FlightTuning,
  InputFrame,
  PlayerId,
  ProjectileDef,
  ProjectileKind,
  ZoneDef,
  ZoneKind,
} from '../../shared';
import { DEFAULT_BOT_DIFFICULTY } from '../../shared/lobby';
import type { BotDifficulty } from '../../shared/lobby';
import { abilityOfSlot } from '../abilities';
import { createTerrainRay } from '../collision-world';
import type { SimCollisionWorld, TerrainRay } from '../collision-world';
import type { DragonState } from '../dragon-state';
import type { SimState } from '../sim-state';
import { BOT_DIFFICULTY_TUNING, BOT_TUNING } from './tuning';
import type { BotDifficultyTuning, BotTuning } from './tuning';

/** The part of the map a bot needs besides the terrain rays: the bowl. */
export interface BotArena {
  readonly centerX: number;
  readonly centerZ: number;
  /** The map's own storm radius (a mode's smaller one is read from the state). */
  readonly radius: number;
  readonly floorY: number;
  readonly ceilingY: number;
}

/**
 * What a brain looks at. One object, filled by the caller and reused for every bot and tick
 * (the brain keeps nothing of it between calls).
 */
export interface BotContext {
  /** The latest sim state (`sim.current`). Read only. */
  state: Readonly<SimState>;
  /** For the feelers and lines of sight; null or one without `raycastRay` = open sky. */
  collision: SimCollisionWorld | null;
  arena: BotArena;
  /**
   * False while the match is not being played (the countdown, between Duel rounds, results):
   * the bot then does nothing at all.
   */
  playing: boolean;
}

export interface BotBrainOptions {
  readonly difficulty?: BotDifficulty;
  /** Default: the live tables (BOT_TUNING, BOT_DIFFICULTY_TUNING and the shared ones). */
  readonly tuning?: BotTuning;
  readonly difficultyTuning?: Record<BotDifficulty, BotDifficultyTuning>;
  readonly flightTuning?: FlightTuning;
  readonly classTuning?: Record<DragonClassId, ClassTuning>;
  readonly abilityTable?: AbilityTable;
  readonly projectileDefs?: Record<ProjectileKind, ProjectileDef>;
  readonly zoneDefs?: Record<ZoneKind, ZoneDef>;
  readonly combatTuning?: CombatTuning;
}

export const BOT_MODE_PATROL = 0;
export const BOT_MODE_ENGAGE = 1;
export const BOT_MODE_EXTEND = 2;
export const BOT_MODE_RETREAT = 3;
/** Ember Relay: on its way to a shard or a brazier (see `BotBrain.errand`). */
export const BOT_MODE_OBJECTIVE = 4;
export type BotMode =
  | typeof BOT_MODE_PATROL
  | typeof BOT_MODE_ENGAGE
  | typeof BOT_MODE_EXTEND
  | typeof BOT_MODE_RETREAT
  | typeof BOT_MODE_OBJECTIVE;

/** What a bot in BOT_MODE_OBJECTIVE is doing. */
export const BOT_ERRAND_NONE = 0;
/** Flying to the enemy's shard (on its stand or dropped). */
export const BOT_ERRAND_TAKE = 1;
/** Carrying the enemy's shard to its own brazier. */
export const BOT_ERRAND_CARRY = 2;
/** Flying to its own team's dropped shard to send it home. */
export const BOT_ERRAND_RETURN = 3;
export type BotErrand =
  | typeof BOT_ERRAND_NONE
  | typeof BOT_ERRAND_TAKE
  | typeof BOT_ERRAND_CARRY
  | typeof BOT_ERRAND_RETURN;

/**
 * The feelers. CENTER runs along the flight path from the dragon. LEFT / RIGHT / UP / DOWN run
 * parallel to it from a point `feelerOffsetRadii` body radii to that side: together they sweep
 * the tube the body is about to fly through, so rock that the centre ray passes by a few metres
 * is still seen. The WIDE pair fans out from the dragon and tells which side is open.
 */
const FEEL_CENTER = 0;
const FEEL_LEFT = 1;
const FEEL_RIGHT = 2;
const FEEL_UP = 3;
const FEEL_DOWN = 4;
const FEEL_LEFT_WIDE = 5;
const FEEL_RIGHT_WIDE = 6;
const FEELER_COUNT = 7;

// Numeric guards and fixed shapes, not tuning.
const TWO_PI = Math.PI * 2;
const EPSILON = 1e-6;
/** Ticks a wanted ability press waits for a wind-up to end before it is forgotten. */
const PRESS_PATIENCE_TICKS = 20;
/** Ticks between two scans of the projectile pool. */
const PROJECTILE_SCAN_TICKS = 2;
/** A line of sight stops this short of the target (its own body is not in the way). */
const SIGHT_RAY_SLACK = 3;
/** Altitude hold of the patrol circle: radians of pitch per metre off, and the cap. */
const PATROL_ALTITUDE_GAIN = 0.004;
const PATROL_MAX_PITCH = 0.3;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clampUnit(value: number): number {
  if (!(value >= -1)) return value < -1 ? -1 : 0;
  return value > 1 ? 1 : value;
}

function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

function ticksOf(seconds: number): number {
  const ticks = Math.round(seconds * TICK_HZ);
  return ticks > 1 ? ticks : 1;
}

function isAlive(dragon: Readonly<DragonState>): boolean {
  return dragon.active && (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
}

export class BotBrain {
  /** Read on every think; set it when the lobby rule changes. */
  difficulty: BotDifficulty;

  private readonly tuning: BotTuning;
  private readonly levels: Record<BotDifficulty, BotDifficultyTuning>;
  private readonly flight: FlightTuning;
  private readonly classes: Record<DragonClassId, ClassTuning>;
  private readonly abilities: AbilityTable;
  private readonly projectiles: Record<ProjectileKind, ProjectileDef>;
  private readonly zones: Record<ZoneKind, ZoneDef>;
  private readonly combat: CombatTuning;

  private readonly ray: TerrainRay = createTerrainRay();
  /** Metres to rock along each feeler (Infinity = clear). */
  private readonly feel = new Float64Array(FEELER_COUNT);

  // --- Identity (from the seed) -------------------------------------------------------------------
  private rng = 0;
  private stagger = 0;
  private patrolSign = 1;
  private patrolScale = NaN;
  private patrolHeight = NaN;
  private weavePhase = NaN;

  // --- Memory -------------------------------------------------------------------------------------
  private age = 0;
  private botMode: BotMode = BOT_MODE_PATROL;
  private targetSlot = -1;
  private targetPlayer: PlayerId = NO_PLAYER;
  private targetLos = false;
  private reactTicks = 0;
  private stuckTicks = 0;
  private extendTicks = 0;
  private extendYaw = NaN;
  private extendPitch = NaN;
  private retreatTicks = 0;
  private retreatCooldownTicks = 0;
  private allySlot = -1;
  private enemiesAlive = 0;
  private chased = false;
  private lastHealth = NaN;
  private hurtTicks = 0;
  private hurtCheckTicks = -1;
  private avoidSide = 0;
  private avoidTicks = 0;
  private boosting = false;
  private burstTicks = 0;
  private burstOn = false;
  private errYaw = NaN;
  private errPitch = NaN;
  private errYawGoal = NaN;
  private errPitchGoal = NaN;
  private pressSlot = -1;
  private pressTicks = 0;
  private dodgeTicks = -1;
  private dodgeDir = 1;
  private lastButtons = 0;
  /** Ember Relay: the errand of the last plan, where it leads, and the state it was planned on. */
  private relayErrand: BotErrand = BOT_ERRAND_NONE;
  private errandX = NaN;
  private errandY = NaN;
  private errandZ = NaN;
  private relayRevision = -1;
  /** Living riders of its team, itself included, as of the last `matesNearer`. */
  private matesAlive = 1;

  // --- Scratch of one think (fields, not arguments: see `integrateDragon` on boxed floats) --------
  // Fields that hold fractions start as NaN, not 0: the engine then lays them out as doubles
  // from the first object on, instead of re-shaping every brain the first time one is written
  // (which keeps `think` out of the optimising compiler for the first minute of a match).
  // Each is written before it is read: by `reset` or at the top of `think`.
  private px = NaN;
  private py = NaN;
  private pz = NaN;
  private noseX = NaN;
  private noseY = NaN;
  private noseZ = NaN;
  /** Unit flight path. */
  private dirX = NaN;
  private dirY = NaN;
  private dirZ = NaN;
  private stormR = NaN;
  private healthFraction = NaN;
  /** Arguments of `headTo` and `castFeeler`. */
  private goX = NaN;
  private goY = NaN;
  private goZ = NaN;
  private feelReach = NaN;
  private feelOffset = NaN;
  /** Bottom of the altitude band. */
  private lowAltitude = NaN;
  private wantYaw = NaN;
  private wantPitch = NaN;
  /** Unit aim at the target's lead point, its distance and the cosine off the nose. */
  private aimX = NaN;
  private aimY = NaN;
  private aimZ = NaN;
  private targetDist = NaN;
  private targetCos = NaN;
  /** Query sphere of `countEnemies`. */
  private queryX = NaN;
  private queryY = NaN;
  private queryZ = NaN;
  private queryRadius = NaN;
  private queryCos = NaN;

  constructor(seed: number, options: BotBrainOptions = {}) {
    this.difficulty = options.difficulty ?? DEFAULT_BOT_DIFFICULTY;
    this.tuning = options.tuning ?? BOT_TUNING;
    this.levels = options.difficultyTuning ?? BOT_DIFFICULTY_TUNING;
    this.flight = options.flightTuning ?? FLIGHT_TUNING;
    this.classes = options.classTuning ?? CLASS_TUNING;
    this.abilities = options.abilityTable ?? ABILITY_TABLE;
    this.projectiles = options.projectileDefs ?? PROJECTILE_DEFS;
    this.zones = options.zoneDefs ?? ZONE_DEFS;
    this.combat = options.combatTuning ?? COMBAT_TUNING;
    this.reset(seed);
  }

  /** What the bot is doing (BOT_MODE_*), for tests and a debug overlay. */
  get mode(): BotMode {
    return this.botMode;
  }

  /** The player it is after, or NO_PLAYER. */
  get targetId(): PlayerId {
    return this.targetPlayer;
  }

  /** Its Ember Relay errand as of the last plan (BOT_ERRAND_*). */
  get errand(): BotErrand {
    return this.relayErrand;
  }

  /** A new life for the brain: a new seed and nothing remembered (a new match or round). */
  reset(seed: number): void {
    this.rng = seed >>> 0;
    this.lastHealth = -1;
    this.wantYaw = 0;
    this.wantPitch = 0;
    this.aimX = 0;
    this.aimY = 0;
    this.aimZ = 1;
    this.targetDist = Infinity;
    this.targetCos = -1;
    this.healthFraction = 1;
    this.stagger = Math.floor(this.random() * 1024);
    this.patrolSign = this.random() < 0.5 ? -1 : 1;
    this.patrolScale = 0.7 + this.random() * 0.6;
    this.patrolHeight = 0.75 + this.random() * 0.5;
    this.weavePhase = this.random() * TWO_PI;
    this.age = 0;
    this.retreatCooldownTicks = 0;
    this.stuckTicks = 0;
    this.extendYaw = 0;
    this.extendPitch = 0;
    // The first think flips this to "on" and starts the first burst.
    this.burstOn = false;
    this.burstTicks = 0;
    this.errYaw = 0;
    this.errPitch = 0;
    this.errYawGoal = 0;
    this.errPitchGoal = 0;
    this.dodgeDir = 1;
    this.errandX = 0;
    this.errandY = 0;
    this.errandZ = 0;
    this.rest();
  }

  /**
   * One tick: writes the bot's input for the dragon of `selfId` into `out` (steer, buttons and
   * aim; `tick` is the caller's) and returns it. Neutral while the bot has no living dragon or
   * the match is not being played.
   */
  think(ctx: Readonly<BotContext>, selfId: PlayerId, out: InputFrame): InputFrame {
    out.steerX = 0;
    out.steerY = 0;
    out.buttons = 0;
    out.aimYaw = 0;
    out.aimPitch = 0;

    const state = ctx.state;
    const dragons = state.dragons;
    let self: DragonState | undefined;
    let selfSlot = -1;
    for (let i = 0; i < dragons.length; i++) {
      const dragon = dragons[i];
      if (dragon !== undefined && dragon.active && dragon.id === selfId) {
        self = dragon;
        selfSlot = i;
        break;
      }
    }
    if (self === undefined || !ctx.playing || (self.flags & DRAGON_FLAG_ALIVE) === 0) {
      this.rest();
      return out;
    }

    const tune = this.tuning;
    const level = this.levels[this.difficulty];
    const flight = this.flight;
    const cls = this.classes[self.classId];
    const abilities = this.abilities[self.classId];
    const arena = ctx.arena;
    const collision = ctx.collision;
    const age = ++this.age;

    // --- Self ---------------------------------------------------------------------------------------
    const position = self.position;
    const px = position.x;
    const py = position.y;
    const pz = position.z;
    this.px = px;
    this.py = py;
    this.pz = pz;
    const cosPitch = Math.cos(self.pitch);
    const noseX = Math.sin(self.yaw) * cosPitch;
    const noseY = Math.sin(self.pitch);
    const noseZ = Math.cos(self.yaw) * cosPitch;
    this.noseX = noseX;
    this.noseY = noseY;
    this.noseZ = noseZ;
    const velocity = self.velocity;
    const pathSpeed = Math.sqrt(
      velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
    );
    if (pathSpeed > 1) {
      this.dirX = velocity.x / pathSpeed;
      this.dirY = velocity.y / pathSpeed;
      this.dirZ = velocity.z / pathSpeed;
    } else {
      this.dirX = noseX;
      this.dirY = noseY;
      this.dirZ = noseZ;
    }
    const speed = self.speed;
    const stallSpeed = flight.stallSpeed * cls.speedScale;
    const cruiseSpeed = flight.cruiseSpeed * cls.speedScale;
    const stalled = (self.flags & DRAGON_FLAG_STALLED) !== 0;
    const healthFraction = self.maxHealth > 0 ? self.health / self.maxHealth : 1;
    this.healthFraction = healthFraction;
    const low = arena.floorY + tune.bandLow;
    const high = arena.ceilingY - tune.bandHigh;
    const stormR = state.stormRadius >= 0 ? state.stormRadius : arena.radius;
    this.stormR = stormR;
    this.lowAltitude = low;

    // --- Timers and the hit memory --------------------------------------------------------------------
    if (this.reactTicks > 0) this.reactTicks--;
    if (this.hurtTicks > 0) this.hurtTicks--;
    if (this.retreatCooldownTicks > 0) this.retreatCooldownTicks--;
    if (this.avoidTicks > 0 && --this.avoidTicks === 0) this.avoidSide = 0;
    if (--this.burstTicks <= 0) {
      this.burstOn = !this.burstOn;
      this.burstTicks = ticksOf(this.burstOn ? level.burstOnS : level.burstOffS);
    }
    let hurtNow = false;
    if (this.lastHealth >= 0 && self.health < this.lastHealth - 0.01 && !(self.envDamage > 0)) {
      hurtNow = this.hurtTicks === 0;
      this.hurtTicks = ticksOf(tune.hurtMemoryS);
    }
    this.lastHealth = self.health;
    if (hurtNow) {
      // The answer to a hit (shield, escape, dodge) comes one reaction time later.
      const delay = ticksOf(level.reactionS);
      this.hurtCheckTicks = delay;
      if (this.dodgeTicks < 0 && self.dodgeCooldownTicks <= delay) {
        if (this.random() < level.dodgeChance) {
          this.dodgeTicks = delay;
          this.dodgeDir = this.random() < 0.5 ? -1 : 1;
        }
      }
    }

    // --- Plan: target, mode -------------------------------------------------------------------------
    let target = this.targetSlot >= 0 ? dragons[this.targetSlot] : undefined;
    let planned = false;
    if (target !== undefined && (!isAlive(target) || target.id !== this.targetPlayer)) {
      target = undefined;
      this.dropTarget();
      planned = true;
    }
    const replanTicks = ticksOf(tune.replanS);
    // A shard changed hands: what was planned a moment ago may now lead nowhere.
    const relay = state.relay;
    if (relay.active && relay.revision !== this.relayRevision) planned = true;
    if (planned || (age + this.stagger) % replanTicks === 0) {
      planned = true;
      this.plan(state, collision, arena, self, tune, level);
      target = this.targetSlot >= 0 ? dragons[this.targetSlot] : undefined;
    }

    if (this.botMode === BOT_MODE_RETREAT && --this.retreatTicks <= 0) {
      this.botMode = target !== undefined ? BOT_MODE_ENGAGE : BOT_MODE_PATROL;
    }
    if (this.botMode === BOT_MODE_EXTEND && --this.extendTicks <= 0) {
      this.botMode = target !== undefined ? BOT_MODE_ENGAGE : BOT_MODE_PATROL;
      this.stuckTicks = 0;
    }
    if (
      target === undefined &&
      this.botMode !== BOT_MODE_RETREAT &&
      this.botMode !== BOT_MODE_OBJECTIVE
    ) {
      this.botMode = BOT_MODE_PATROL;
    }

    // --- The target: lead point, aim, range --------------------------------------------------------
    const primary = abilities.primary;
    const bolt = primary.projectile !== null ? this.projectiles[primary.projectile] : undefined;
    let goalX = 0;
    let goalY = 0;
    let goalZ = 0;
    this.targetDist = Infinity;
    this.targetCos = -1;
    if (target !== undefined) {
      const tp = target.position;
      const tv = target.velocity;
      let relX = tp.x - px;
      let relY = tp.y - py;
      let relZ = tp.z - pz;
      let distance = Math.sqrt(relX * relX + relY * relY + relZ * relZ);
      this.targetDist = distance;
      // Where to put the shot: the target's place when a bolt gets there (bolts keep none of
      // the shooter's speed); a cone or beam lands at once and needs no lead.
      if (bolt !== undefined && bolt.speed > 1) {
        for (let pass = 0; pass < 2; pass++) {
          const lead = clamp(distance / bolt.speed, 0, tune.leadMaxS) * level.leadSkill;
          relX = tp.x + tv.x * lead - px;
          relY = tp.y + tv.y * lead - py;
          relZ = tp.z + tv.z * lead - pz;
          distance = Math.sqrt(relX * relX + relY * relY + relZ * relZ);
        }
      }
      if (distance > EPSILON) {
        this.aimX = relX / distance;
        this.aimY = relY / distance;
        this.aimZ = relZ / distance;
      } else {
        this.aimX = noseX;
        this.aimY = noseY;
        this.aimZ = noseZ;
      }
      this.targetCos = noseX * this.aimX + noseY * this.aimY + noseZ * this.aimZ;
      // Where to fly: onto the shot for bolts, a little ahead of the target otherwise.
      const pursuit = bolt !== undefined ? 0 : tune.pursuitLeadS;
      goalX = relX + tv.x * pursuit;
      goalY = relY + tv.y * pursuit;
      goalZ = relZ + tv.z * pursuit;
    }

    // --- 1. Goal heading by mode ----------------------------------------------------------------------
    let wantBoost = false;
    let mode = this.botMode;
    if (mode === BOT_MODE_ENGAGE && target !== undefined) {
      // A turning fight nobody wins: both chase a tail that stays out of reach.
      if (
        this.targetDist < tune.extendRange &&
        this.targetCos < Math.cos(tune.extendAngle) &&
        this.avoidTicks === 0
      ) {
        this.stuckTicks++;
      } else if (this.stuckTicks > 0) {
        this.stuckTicks--;
      }
      if (this.stuckTicks > ticksOf(tune.extendAfterS)) {
        this.botMode = BOT_MODE_EXTEND;
        mode = BOT_MODE_EXTEND;
        this.stuckTicks = 0;
        this.extendTicks = ticksOf(tune.extendS * (0.7 + this.random() * 0.8));
        this.extendYaw = self.yaw + (this.random() - 0.5) * 0.6;
        this.extendPitch = (this.random() - 0.4) * 0.5;
      }
    }

    if (mode === BOT_MODE_ENGAGE && target !== undefined) {
      // Not below the cloud sea or into the ceiling after a target that went there.
      this.goX = goalX;
      this.goY = clamp(py + goalY, low, high) - py;
      this.goZ = goalZ;
      this.headTo();
      wantBoost = this.targetDist > tune.boostChaseRange;
      // In a turning fight the slower dragon turns inside the faster one: pull up, bleed speed.
      if (this.stuckTicks > 0 && this.wantPitch < tune.turnFightPitch) {
        this.wantPitch = tune.turnFightPitch;
      }
    } else if (mode === BOT_MODE_EXTEND) {
      this.wantYaw = this.extendYaw;
      this.wantPitch = this.extendPitch;
      wantBoost = true;
    } else if (mode === BOT_MODE_OBJECTIVE) {
      const dx = this.errandX - px;
      const dy = this.errandY - py;
      const dz = this.errandZ - pz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const ahead = dx * noseX + dy * noseY + dz * noseZ;
      if (distance < tune.relayMinTurnM && ahead < Math.cos(tune.relayTurnAngle) * distance) {
        // Too close to turn onto it: straight on and level, round again from further out.
        this.wantYaw = self.yaw;
        this.wantPitch = 0;
      } else {
        this.goX = dx;
        this.goY = dy;
        this.goZ = dz;
        this.headTo();
      }
      wantBoost = distance > tune.relayMinTurnM;
    } else if (mode === BOT_MODE_RETREAT) {
      const ally = this.allySlot >= 0 ? dragons[this.allySlot] : undefined;
      const haven = ally !== undefined && isAlive(ally) ? ally.position : self.home;
      const dx = haven.x - px;
      const dy = clamp(haven.y, low, high) - py;
      const dz = haven.z - pz;
      if (dx * dx + dy * dy + dz * dz > tune.retreatArriveRange * tune.retreatArriveRange) {
        this.goX = dx;
        this.goY = dy;
        this.goZ = dz;
        this.headTo();
        wantBoost = true;
      } else {
        this.patrol(arena, self, tune);
      }
    } else {
      this.patrol(arena, self, tune);
    }

    // --- 2. The storm wall ----------------------------------------------------------------------------
    const offX = px - arena.centerX;
    const offZ = pz - arena.centerZ;
    const radial = Math.sqrt(offX * offX + offZ * offZ);
    let inStormTurn = false;
    if (radial > 1) {
      const margin = Math.min(tune.stormMargin, stormR * tune.stormMarginFraction);
      const outward = (offX * velocity.x + offZ * velocity.z) / radial;
      const ahead = radial + (outward > 0 ? outward * tune.stormLookaheadS : 0);
      const limit = stormR - margin;
      if (ahead > limit) {
        const weight = margin > 1 ? clamp((ahead - limit) / (margin * 0.5), 0, 1) : 1;
        const inward = Math.atan2(-offX, -offZ);
        this.wantYaw += wrapAngle(inward - this.wantYaw) * weight;
        inStormTurn = weight >= 1;
        if (radial > stormR) wantBoost = true;
      }
    }

    // --- 3. Terrain -----------------------------------------------------------------------------------
    const fastest = pathSpeed > speed ? pathSpeed : speed;
    const reach = fastest * tune.feelerLookaheadS + tune.feelerMin;
    const feel = this.feel;
    let urgency = 0;
    if (collision !== null && collision.raycastRay !== undefined) {
      // What was seen a few ticks ago is that much closer now.
      const travelled = pathSpeed * TICK_DT_S;
      for (let i = 1; i < FEELER_COUNT; i++) feel[i] = (feel[i] ?? Infinity) - travelled;
      const offset = cls.hitRadius * tune.feelerOffsetRadii;
      const others = FEELER_COUNT - 1;
      this.feelReach = reach;
      this.feelOffset = offset;
      this.castFeeler(collision, FEEL_CENTER, tune);
      this.castFeeler(collision, 1 + ((age * 2) % others), tune);
      this.castFeeler(collision, 1 + ((age * 2 + 1) % others), tune);

      const centre = feel[FEEL_CENTER] ?? Infinity;
      const left = feel[FEEL_LEFT] ?? Infinity;
      const right = feel[FEEL_RIGHT] ?? Infinity;
      const up = feel[FEEL_UP] ?? Infinity;
      const down = feel[FEEL_DOWN] ?? Infinity;
      const leftWide = feel[FEEL_LEFT_WIDE] ?? Infinity;
      const rightWide = feel[FEEL_RIGHT_WIDE] ?? Infinity;
      const wideReach = reach * tune.feelerWideScale;
      const yawError = wrapAngle(this.wantYaw - self.yaw);
      const leftNear = left < reach ? 1 - (left > 0 ? left : 0) / reach : 0;
      const rightNear = right < reach ? 1 - (right > 0 ? right : 0) / reach : 0;

      if (centre < reach) {
        urgency = clamp(1 - centre / reach, 0, 1);
        if (this.avoidSide === 0) {
          const leftClear =
            (left < reach ? left : reach) + (leftWide < wideReach ? leftWide : wideReach);
          const rightClear =
            (right < reach ? right : reach) + (rightWide < wideReach ? rightWide : wideReach);
          // Toward the open side; when both look alike, toward where it wanted to go anyway.
          if (Math.abs(leftClear - rightClear) < reach * 0.15) {
            this.avoidSide = yawError >= 0 ? 1 : -1;
          } else {
            this.avoidSide = leftClear > rightClear ? 1 : -1;
          }
        }
        this.avoidTicks = ticksOf(tune.avoidCommitS);
        const turn = tune.avoidTurnMin + (tune.avoidTurnMax - tune.avoidTurnMin) * urgency;
        const awayYaw = self.yaw + this.avoidSide * turn;
        this.wantYaw += wrapAngle(awayYaw - this.wantYaw) * clamp(urgency * 3, 0, 1);
        // Over or under when the obstacle ends within a body offset of the path.
        if (up > centre * 1.3 && up >= down && py < high) {
          const pitch = tune.avoidPitch * urgency;
          if (this.wantPitch < pitch) this.wantPitch = pitch;
        } else if (down > centre * 1.3 && py > low + tune.bandLow) {
          const pitch = -tune.avoidPitch * urgency;
          if (this.wantPitch > pitch) this.wantPitch = pitch;
        }
      } else {
        if (leftNear > 0 || rightNear > 0) {
          // The way ahead is clear but the body would clip rock beside it: ease away.
          const near = leftNear > rightNear ? leftNear : rightNear;
          const awayYaw = self.yaw + (rightNear - leftNear) * tune.avoidSideTurn;
          this.wantYaw += wrapAngle(awayYaw - this.wantYaw) * clamp(near * 3, 0, 1);
          urgency = near * 0.5;
        } else if (yawError > 0.3 && leftWide < wideReach * 0.6) {
          // Do not turn into rock beside the path.
          this.wantYaw = self.yaw + 0.15;
        } else if (yawError < -0.3 && rightWide < wideReach * 0.6) {
          this.wantYaw = self.yaw - 0.15;
        }
        // Rock just under or over the path: lift over it, duck under it.
        const upNear = up < reach ? 1 - (up > 0 ? up : 0) / reach : 0;
        const downNear = down < reach ? 1 - (down > 0 ? down : 0) / reach : 0;
        if (downNear > upNear) {
          const pitch = tune.avoidPitch * clamp(downNear * 2, 0, 1);
          if (this.wantPitch < pitch) this.wantPitch = pitch;
          if (urgency < downNear * 0.5) urgency = downNear * 0.5;
        } else if (upNear > 0) {
          const pitch = -tune.avoidPitch * clamp(upNear * 2, 0, 1);
          if (this.wantPitch > pitch) this.wantPitch = pitch;
          if (urgency < upNear * 0.5) urgency = upNear * 0.5;
        }
      }
    }

    // --- 4. The altitude band -------------------------------------------------------------------------
    const altitudeAhead = py + velocity.y * tune.bandLookaheadS;
    let mustClimb = false;
    if (altitudeAhead < low) {
      const pitch = clamp((low - altitudeAhead) * tune.bandPitchPerM, 0, tune.bandPitchMax);
      if (this.wantPitch < pitch) this.wantPitch = pitch;
      mustClimb = py < low;
    } else if (altitudeAhead > high) {
      const pitch = -clamp((altitudeAhead - high) * tune.bandPitchPerM, 0, tune.bandPitchMax);
      if (this.wantPitch > pitch) this.wantPitch = pitch;
    }

    // --- 5. Speed: no climb the speed cannot pay for -----------------------------------------------
    const maxClimb = flight.maxClimbPitch * tune.climbPitchFraction;
    const maxDive = flight.maxDivePitch * tune.divePitchFraction;
    const speedRatio = stallSpeed > EPSILON ? speed / stallSpeed : 2;
    let climbLimit =
      maxClimb *
      clamp(
        (speedRatio - tune.climbSpeedLow) / (tune.climbSpeedHigh - tune.climbSpeedLow + EPSILON),
        0,
        1,
      );
    // At cruise speed without boost a steep climb ends in a stall a few seconds later.
    if (speed <= cruiseSpeed * 1.05 && climbLimit > tune.sustainedClimbPitch) {
      const canBoost = !self.boostLocked && self.stamina > tune.boostStopStamina;
      if (!canBoost) climbLimit = tune.sustainedClimbPitch;
    }
    const wantsClimb = this.wantPitch > tune.sustainedClimbPitch;
    if (this.wantPitch > climbLimit) this.wantPitch = climbLimit;
    if (this.wantPitch < -maxDive) this.wantPitch = -maxDive;
    if (stalled) {
      // Trade height for speed: the sim drops the nose anyway, do not fight it.
      if (this.wantPitch > -0.35) this.wantPitch = -0.35;
    }

    // --- Steer ----------------------------------------------------------------------------------------
    const yawError = wrapAngle(this.wantYaw - self.yaw);
    // A right turn lowers yaw, and steerX > 0 turns right.
    out.steerX = clampUnit(-yawError * tune.yawGain);
    out.steerY = clampUnit((this.wantPitch - self.pitch) * tune.pitchGain);
    let buttons = 0;
    if (yawError > tune.rollAssistAngle) buttons |= BUTTON_ROLL_LEFT;
    else if (yawError < -tune.rollAssistAngle) buttons |= BUTTON_ROLL_RIGHT;

    // --- Boost, flap, dive ----------------------------------------------------------------------------
    const slow = speedRatio < tune.climbSpeedHigh;
    const emergency = stalled || mustClimb || (wantsClimb && slow) || radial > stormR;
    if (emergency) wantBoost = true;
    if (urgency > tune.avoidBoostCut && !stalled) wantBoost = false;
    if (inStormTurn && radial <= stormR) wantBoost = false;
    if (wantBoost && !self.boostLocked) {
      if (emergency || mode === BOT_MODE_RETREAT) this.boosting = self.stamina > 0.02;
      else if (this.boosting) this.boosting = self.stamina > tune.boostStopStamina;
      else this.boosting = self.stamina > tune.boostStartStamina;
    } else {
      this.boosting = false;
    }
    if (this.boosting) buttons |= BUTTON_BOOST;

    if (
      (stalled || mustClimb || (wantsClimb && slow) || (urgency > 0.5 && this.wantPitch > 0.2)) &&
      self.flapCooldownTicks === 0 &&
      self.stamina >= flight.flapStaminaCost + 0.05
    ) {
      buttons |= BUTTON_FLAP;
    }

    if (
      mode === BOT_MODE_ENGAGE &&
      target !== undefined &&
      urgency === 0 &&
      this.wantPitch < tune.divePitch &&
      goalY < -tune.diveGoalDrop &&
      py - arena.floorY > tune.diveMinAltitude &&
      (feel[FEEL_DOWN] ?? Infinity) >= reach
    ) {
      buttons |= BUTTON_DIVE;
    }

    // --- Fire -----------------------------------------------------------------------------------------
    if (target !== undefined) {
      // The aim wanders around the true one; a blinded bot can hardly aim at all.
      const errScale = self.blindTicks > 0 ? 4 : 1;
      this.errYaw += (this.errYawGoal - this.errYaw) * 0.12;
      this.errPitch += (this.errPitchGoal - this.errPitch) * 0.12;
      out.aimYaw = wrapAngle(Math.atan2(this.aimX, this.aimZ) + this.errYaw * errScale);
      out.aimPitch = clamp(
        Math.asin(clamp(this.aimY, -1, 1)) + this.errPitch * errScale,
        -Math.PI / 2,
        Math.PI / 2,
      );
      buttons |= BUTTON_AIM;
      if (
        this.burstOn &&
        this.reactTicks === 0 &&
        this.wantsPrimary(self, target, primary, bolt, tune, level)
      ) {
        buttons |= BUTTON_PRIMARY;
      }
    }

    // --- The other abilities ----------------------------------------------------------------------------
    let check = planned;
    if (this.hurtCheckTicks >= 0 && this.hurtCheckTicks-- === 0) check = true;
    if (check && this.pressSlot < 0) {
      this.considerAbilities(state, self, selfSlot, target, abilities, tune, level);
    }
    if (this.pressSlot >= 0) {
      const bit = BUTTON_PRIMARY << this.pressSlot;
      if (self.castSlot < 0 && (this.lastButtons & bit) === 0) {
        // A press is an edge, and a held primary that starts a wind-up would swallow it.
        buttons = (buttons & ~BUTTON_PRIMARY) | bit;
        this.pressSlot = -1;
      } else if (--this.pressTicks <= 0) {
        this.pressSlot = -1;
      }
    }

    // --- Dodge ----------------------------------------------------------------------------------------
    if (
      this.dodgeTicks < 0 &&
      self.dodgeCooldownTicks === 0 &&
      state.projectileCount > 0 &&
      (age + this.stagger) % PROJECTILE_SCAN_TICKS === 0
    ) {
      this.watchProjectiles(state, self, cls, tune, level);
    }
    if (this.dodgeTicks >= 0 && this.dodgeTicks-- === 0) {
      const bit = this.dodgeDir < 0 ? BUTTON_DODGE_LEFT : BUTTON_DODGE_RIGHT;
      if (self.dodgeCooldownTicks === 0 && (this.lastButtons & bit) === 0) buttons |= bit;
    }

    out.buttons = buttons;
    this.lastButtons = buttons;
    return out;
  }

  // --- Planning ---------------------------------------------------------------------------------------

  private plan(
    state: Readonly<SimState>,
    collision: SimCollisionWorld | null,
    arena: BotArena,
    self: Readonly<DragonState>,
    tune: BotTuning,
    level: BotDifficultyTuning,
  ): void {
    const dragons = state.dragons;
    const healthFraction = this.healthFraction;
    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    const stormR = this.stormR;
    const sight = self.blindTicks > 0 ? tune.blindSightRange : tune.sightRange;
    const ray = this.ray;
    const canSee = collision !== null && collision.raycastRay !== undefined;

    let best = -1;
    let bestScore = Infinity;
    let bestLos = false;
    let enemies = 0;
    let nearestEnemy = Infinity;
    let chased = false;
    let ally = -1;
    let allyDistance = Infinity;

    // Ember Relay: who has this team's shard, and where a mate is carrying the enemy's.
    const relay = state.relay;
    const ownShard = relay.active ? relay.shards[self.team] : undefined;
    const theirShard = relay.active
      ? relay.shards[self.team === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER]
      : undefined;
    const thiefId =
      ownShard !== undefined && ownShard.status === SHARD_CARRIED ? ownShard.carrierId : NO_PLAYER;
    const escorted =
      theirShard !== undefined &&
      theirShard.status === SHARD_CARRIED &&
      theirShard.carrierId !== self.id
        ? theirShard.position
        : undefined;

    for (let i = 0; i < dragons.length; i++) {
      const other = dragons[i];
      if (other === undefined || other === self || !isAlive(other)) continue;
      const op = other.position;
      const dx = op.x - px;
      const dy = op.y - py;
      const dz = op.z - pz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const otherHealth = other.maxHealth > 0 ? other.health / other.maxHealth : 1;
      if (other.team === self.team) {
        if (otherHealth > 0.5 && distance < allyDistance) {
          allyDistance = distance;
          ally = i;
        }
        continue;
      }
      enemies++;
      // An enemy it cannot know about: veiled and not right on top of it.
      if (other.veilTicks > 0 && distance > tune.veilSightRange) continue;
      if (distance < nearestEnemy) nearestEnemy = distance;
      if (
        distance < tune.chasedRange &&
        dx * this.noseX + dy * this.noseY + dz * this.noseZ < -0.3 * distance
      ) {
        chased = true;
      }
      const ox = op.x - arena.centerX;
      const oz = op.z - arena.centerZ;
      if (ox * ox + oz * oz > (stormR + tune.stormChaseSlack) * (stormR + tune.stormChaseSlack)) {
        continue;
      }
      let los = distance <= sight;
      if (los && canSee && collision !== null && distance > SIGHT_RAY_SLACK) {
        ray.originX = px;
        ray.originY = py;
        ray.originZ = pz;
        ray.directionX = dx;
        ray.directionY = dy;
        ray.directionZ = dz;
        ray.maxDistance = distance - SIGHT_RAY_SLACK;
        los = (collision.raycastRay?.(ray) ?? -1) < 0;
      }
      let score = distance * (tune.targetHealthBias + (1 - tune.targetHealthBias) * otherHealth);
      if (!los) score *= tune.targetHiddenPenalty;
      if (i === this.targetSlot) score *= tune.targetStickiness;
      if (other.spawnProtectTicks > 0) score *= tune.targetProtectedPenalty;
      if (other.id === thiefId) score *= tune.relayCarrierBias;
      else if (escorted !== undefined) {
        const ex = op.x - escorted.x;
        const ey = op.y - escorted.y;
        const ez = op.z - escorted.z;
        if (ex * ex + ey * ey + ez * ez < tune.relayEscortRange * tune.relayEscortRange) {
          score *= tune.relayEscortBias;
        }
      }
      if (score < bestScore) {
        bestScore = score;
        best = i;
        bestLos = los;
      }
    }

    this.enemiesAlive = enemies;
    this.chased = chased;
    this.allySlot = ally;

    const picked = best >= 0 ? dragons[best] : undefined;
    if (picked === undefined) {
      this.dropTarget();
    } else {
      if (picked.id !== this.targetPlayer || (bestLos && !this.targetLos)) {
        // New in its sights: a moment before the first shot.
        this.reactTicks = ticksOf(level.reactionS * (0.7 + this.random() * 0.6));
      }
      if (picked.id !== this.targetPlayer) this.stuckTicks = 0;
      this.targetSlot = best;
      this.targetPlayer = picked.id;
      this.targetLos = bestLos;
    }

    // Mode: an extend or a retreat in progress runs its time.
    if (this.botMode !== BOT_MODE_EXTEND && this.botMode !== BOT_MODE_RETREAT) {
      if (
        healthFraction < level.retreatHealth &&
        nearestEnemy < tune.retreatThreatRange &&
        this.retreatCooldownTicks === 0
      ) {
        this.botMode = BOT_MODE_RETREAT;
        this.retreatTicks = ticksOf(tune.retreatS);
        this.retreatCooldownTicks = ticksOf(tune.retreatS + tune.retreatCooldownS);
      } else {
        this.botMode = picked !== undefined ? BOT_MODE_ENGAGE : BOT_MODE_PATROL;
      }
    }

    // Ember Relay: an errand overrules the fight, except for a bot that is breaking off or
    // flying out of a turning fight. The carrier never waits: it flies home whatever it was doing.
    this.relayRevision = relay.revision;
    const errand = relay.active ? this.pickErrand(state, self, tune) : BOT_ERRAND_NONE;
    this.relayErrand = errand;
    if (
      errand === BOT_ERRAND_CARRY ||
      (errand !== BOT_ERRAND_NONE &&
        this.botMode !== BOT_MODE_RETREAT &&
        this.botMode !== BOT_MODE_EXTEND)
    ) {
      this.botMode = BOT_MODE_OBJECTIVE;
    }

    this.errYawGoal = (this.random() * 2 - 1) * level.aimError;
    this.errPitchGoal = (this.random() * 2 - 1) * level.aimError;
  }

  /**
   * What this bot should do about the shards, if anything, and where that leads (`errandX/Y/Z`).
   * In order: carry the enemy's shard home; fetch its own team's dropped shard (the nearest mate
   * does, and anyone close to it); go for the enemy's shard while it can be taken (the nearest
   * `relayRunnerShare` of the living team).
   */
  private pickErrand(
    state: Readonly<SimState>,
    self: Readonly<DragonState>,
    tune: BotTuning,
  ): BotErrand {
    const relay = state.relay;
    const team = self.team;
    const own = relay.shards[team];
    const theirs = relay.shards[team === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER];
    if (own === undefined || theirs === undefined) return BOT_ERRAND_NONE;

    if (theirs.status === SHARD_CARRIED && theirs.carrierId === self.id) {
      const brazier = relay.braziers[team];
      if (brazier === undefined) return BOT_ERRAND_NONE;
      this.errandX = brazier.x;
      this.errandY = brazier.y;
      this.errandZ = brazier.z;
      return BOT_ERRAND_CARRY;
    }

    if (own.status === SHARD_DROPPED) {
      const at = own.position;
      this.queryX = at.x;
      this.queryY = at.y;
      this.queryZ = at.z;
      const dx = at.x - this.px;
      const dy = at.y - this.py;
      const dz = at.z - this.pz;
      const near = dx * dx + dy * dy + dz * dz < tune.relayReturnRange * tune.relayReturnRange;
      if (near || this.matesNearer(state, self) === 0) {
        this.errandX = at.x;
        this.errandY = at.y;
        this.errandZ = at.z;
        return BOT_ERRAND_RETURN;
      }
    }

    if (theirs.status !== SHARD_CARRIED) {
      const at = theirs.position;
      this.queryX = at.x;
      this.queryY = at.y;
      this.queryZ = at.z;
      const nearer = this.matesNearer(state, self);
      const runners = Math.round(this.matesAlive * tune.relayRunnerShare);
      if (nearer < (runners > 1 ? runners : 1)) {
        this.errandX = at.x;
        this.errandY = at.y;
        this.errandZ = at.z;
        return BOT_ERRAND_TAKE;
      }
    }
    return BOT_ERRAND_NONE;
  }

  /**
   * How many living mates are nearer to the point in `queryX/Y/Z` than this bot is. Also counts
   * the living team, this bot included, into `matesAlive`.
   */
  private matesNearer(state: Readonly<SimState>, self: Readonly<DragonState>): number {
    const dragons = state.dragons;
    const x = this.queryX;
    const y = this.queryY;
    const z = this.queryZ;
    const mx = x - this.px;
    const my = y - this.py;
    const mz = z - this.pz;
    const mine = mx * mx + my * my + mz * mz;
    let nearer = 0;
    let alive = 1;
    for (let i = 0; i < dragons.length; i++) {
      const other = dragons[i];
      if (other === undefined || other === self || !isAlive(other)) continue;
      if (other.team !== self.team) continue;
      alive++;
      const dx = x - other.position.x;
      const dy = y - other.position.y;
      const dz = z - other.position.z;
      if (dx * dx + dy * dy + dz * dz < mine) nearer++;
    }
    this.matesAlive = alive;
    return nearer;
  }

  // --- Steering helpers ---------------------------------------------------------------------------------

  /** Heading and pitch along the offset in `goX/Y/Z` (it does not have to be unit length). */
  private headTo(): void {
    const dx = this.goX;
    const dy = this.goY;
    const dz = this.goZ;
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    if (horizontal > EPSILON) this.wantYaw = Math.atan2(dx, dz);
    this.wantPitch = Math.atan2(dy, horizontal);
  }

  /** The weaving circle around the arena centre, scaled to the storm wall as it is now. */
  private patrol(arena: BotArena, self: Readonly<DragonState>, tune: BotTuning): void {
    let radialX = this.px - arena.centerX;
    let radialZ = this.pz - arena.centerZ;
    const distance = Math.sqrt(radialX * radialX + radialZ * radialZ);
    if (distance > 1e-3) {
      radialX /= distance;
      radialZ /= distance;
    } else {
      radialX = 0;
      radialZ = -1;
    }
    const radius = this.stormR * tune.patrolRadiusFraction * this.patrolScale;
    const inward = clampUnit(
      (distance - radius) / (tune.patrolCapture > 1 ? tune.patrolCapture : 1),
    );
    const sign = this.patrolSign;
    const wantX = -radialZ * sign - radialX * inward * 1.5;
    const wantZ = radialX * sign - radialZ * inward * 1.5;
    const period = tune.patrolWeaveS > 0.1 ? tune.patrolWeaveS : 0.1;
    const weave =
      tune.patrolWeave * Math.sin((this.age * TWO_PI) / (period * TICK_HZ) + this.weavePhase);
    this.wantYaw = Math.atan2(wantX, wantZ) + weave;
    const band = arena.ceilingY - arena.floorY;
    const altitude =
      arena.floorY + band * clamp(tune.patrolAltitudeFraction * this.patrolHeight, 0.15, 0.85);
    this.wantPitch =
      clampUnit(((altitude - self.position.y) * PATROL_ALTITUDE_GAIN) / PATROL_MAX_PITCH) *
      PATROL_MAX_PITCH;
  }

  /**
   * Casts one feeler and stores what it met. `feelReach` is its length and `feelOffset` how far
   * beside the path the parallel ones start (see the FEEL_* constants).
   */
  private castFeeler(collision: SimCollisionWorld, index: number, tune: BotTuning): void {
    const reach = this.feelReach;
    const offset = this.feelOffset;
    const ray = this.ray;
    const dirX = this.dirX;
    const dirY = this.dirY;
    const dirZ = this.dirZ;
    let originX = this.px;
    let originY = this.py;
    let originZ = this.pz;
    let x = dirX;
    let z = dirZ;
    let length = reach;
    if (index === FEEL_LEFT || index === FEEL_RIGHT) {
      // Horizontal left of a heading (sin, cos) is (cos, -sin).
      const horizontal = Math.sqrt(dirX * dirX + dirZ * dirZ);
      if (horizontal > 1e-3) {
        const side = (index === FEEL_LEFT ? offset : -offset) / horizontal;
        originX += dirZ * side;
        originZ -= dirX * side;
      }
    } else if (index === FEEL_UP) {
      originY += offset;
    } else if (index === FEEL_DOWN) {
      originY -= offset;
    } else if (index === FEEL_LEFT_WIDE || index === FEEL_RIGHT_WIDE) {
      // A left turn raises yaw: x = sin(yaw), z = cos(yaw).
      const angle = index === FEEL_LEFT_WIDE ? tune.feelerWideAngle : -tune.feelerWideAngle;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      x = dirX * cos + dirZ * sin;
      z = dirZ * cos - dirX * sin;
      length = reach * tune.feelerWideScale;
    }
    ray.originX = originX;
    ray.originY = originY;
    ray.originZ = originZ;
    ray.directionX = x;
    ray.directionY = dirY;
    ray.directionZ = z;
    ray.maxDistance = length;
    const hit = collision.raycastRay?.(ray) ?? -1;
    this.feel[index] = hit < 0 ? Infinity : hit;
  }

  // --- Combat helpers -----------------------------------------------------------------------------------

  /** Hold the primary this tick? */
  private wantsPrimary(
    self: Readonly<DragonState>,
    target: Readonly<DragonState>,
    primary: AbilityDef,
    bolt: ProjectileDef | undefined,
    tune: BotTuning,
    level: BotDifficultyTuning,
  ): boolean {
    if (!this.targetLos) return false;
    // No point, and no manners, in shooting at what cannot be hurt yet.
    if (target.spawnProtectTicks > 0 || target.phaseTicks > 0) return false;
    const size = this.classes[target.classId].hitRadius * this.combat.hitRadiusScale;
    // A bolt at the end of its flight rarely lands; a cone or a beam reaches as far as it says.
    let range =
      bolt !== undefined
        ? bolt.speed * bolt.lifeS * tune.fireRangeFraction * (0.5 + 0.5 * level.aggression)
        : primary.range + size * 0.5;
    if (self.veilTicks > 0) range *= tune.veilAmbushFraction;
    if (this.targetDist > range) return false;
    // The sim bends the shot toward the aim by up to `aimLimit`; a cone also has its width.
    let aimWindow = primary.aimLimit;
    if (primary.kind === 'cone' || primary.kind === 'wave') {
      aimWindow += primary.coneHalfAngle * tune.coneAimFraction;
    } else {
      aimWindow += Math.atan2(size, this.targetDist > 1 ? this.targetDist : 1) * 0.5;
    }
    return this.targetCos >= Math.cos(aimWindow < Math.PI ? aimWindow : Math.PI);
  }

  private considerAbilities(
    state: Readonly<SimState>,
    self: Readonly<DragonState>,
    selfSlot: number,
    target: Readonly<DragonState> | undefined,
    abilities: ClassAbilities,
    tune: BotTuning,
    level: BotDifficultyTuning,
  ): void {
    // Slot 0 is the primary; the ultimate is looked at first (it is the rarest chance).
    for (let slot = 3; slot >= 1; slot--) {
      const def = abilityOfSlot(abilities, slot);
      if (def === undefined || !this.slotReady(self, slot, def)) continue;
      if (!this.wantsAbility(state, self, selfSlot, target, def, tune)) continue;
      if (this.random() >= level.abilityUse) continue;
      this.pressSlot = slot;
      this.pressTicks = PRESS_PATIENCE_TICKS;
      return;
    }
  }

  /** The sim's own readiness test (`abilities.ts`), so a press is never wasted. */
  private slotReady(self: Readonly<DragonState>, slot: number, def: AbilityDef): boolean {
    if ((self.abilityActiveTicks[slot] ?? 0) > 0) return false;
    const max = def.maxCharges > 1 ? Math.floor(def.maxCharges) : 1;
    if (max > 1) {
      if ((self.abilityChargesUsed[slot] ?? 0) >= max) return false;
    } else if ((self.abilityCooldownTicks[slot] ?? 0) > 0) {
      return false;
    }
    if (def.staminaCost > 0 && self.stamina < def.staminaCost) return false;
    if (def.ultCost > 0 && self.ultCharge < def.ultCost - EPSILON) return false;
    return self.phaseTicks <= 0;
  }

  /** The rule for one ability, read from what it is (kind, tags, what it creates). */
  private wantsAbility(
    state: Readonly<SimState>,
    self: Readonly<DragonState>,
    selfSlot: number,
    target: Readonly<DragonState> | undefined,
    def: AbilityDef,
    tune: BotTuning,
  ): boolean {
    const healthFraction = this.healthFraction;
    const mode = this.botMode;
    const hurt = this.hurtTicks > 0;
    const hasTarget = target !== undefined;
    const distance = this.targetDist;
    const inSight = hasTarget && this.targetLos;
    const escaping =
      mode === BOT_MODE_RETREAT || (hurt && healthFraction < tune.escapeHealthFraction);
    const need = this.enemiesAlive < tune.areaMinTargets ? 1 : Math.floor(tune.areaMinTargets);
    const centre = this.feel[FEEL_CENTER] ?? Infinity;
    const rockAhead = centre < self.speed * tune.phaseTerrainS;
    // Anything that throws the dragon forward needs room to do it in.
    if ((def.impulseForward > 0 || def.speedGain > 0) && def.selfStatus !== 'phase') {
      if (centre < Infinity || this.avoidTicks > 0) return false;
    }

    switch (def.kind) {
      case 'buff': {
        const status = def.selfStatus;
        if (status === 'shield') {
          // Under fire from the front, or about to be: nose to nose with someone shooting.
          if (hurt) return this.threatAhead(state, self);
          return (
            target !== undefined &&
            inSight &&
            distance < tune.chasedRange &&
            this.targetCos > Math.cos(this.combat.shieldHalfAngle) &&
            (target.flags & (DRAGON_FLAG_FIRING | DRAGON_FLAG_CHARGING)) !== 0
          );
        }
        if (status === 'veil') {
          if (mode === BOT_MODE_RETREAT) return true;
          return (
            mode === BOT_MODE_ENGAGE &&
            !hurt &&
            distance > tune.veilMinRange &&
            distance < tune.veilMaxRange
          );
        }
        if (status === 'phase') return rockAhead || escaping;
        if (status === 'haste') return escaping || (hasTarget && distance > tune.boostChaseRange);
        if (status === 'regen') return healthFraction < tune.allyHurtFraction;
        return false;
      }
      case 'dash': {
        if (def.damage > 0) {
          const reach = def.radius + tune.dashReach + def.impulseForward * def.durationS;
          return (
            target !== undefined &&
            inSight &&
            target.spawnProtectTicks <= 0 &&
            distance < reach &&
            this.targetCos >= tune.dashAimCos
          );
        }
        if (def.impulseUp > 0) {
          // Up and out: off the cloud sea, over a wall, away from a fight going badly.
          const upClear = (this.feel[FEEL_UP] ?? Infinity) > centre;
          return this.py < this.lowAltitude || (rockAhead && upClear) || escaping;
        }
        return escaping || (hasTarget && distance > tune.boostChaseRange);
      }
      case 'zone': {
        const zone = def.zone !== null ? this.zones[def.zone] : undefined;
        if (zone === undefined) return false;
        if ((def.tags & ABILITY_TAG_ALLIES) !== 0) {
          return this.countHurtAllies(state, self, zone.radius, tune) >= 1;
        }
        if (def.zoneOffset > 0) {
          if (!hasTarget) return false;
          this.queryX = this.px + this.aimX * def.zoneOffset;
          this.queryY = this.py + this.aimY * def.zoneOffset;
          this.queryZ = this.pz + this.aimZ * def.zoneOffset;
          this.queryRadius = zone.radius * tune.areaFillFraction;
          this.queryCos = -1;
          return this.countEnemies(state, self, selfSlot) >= need;
        }
        if (def.selfStatus === 'haste' || def.speedGain > 0) {
          // A trail behind it: for whoever is on its tail, or to close a long gap.
          return escaping || this.chased || (hasTarget && distance > tune.boostChaseRange * 1.5);
        }
        this.queryX = this.px;
        this.queryY = this.py;
        this.queryZ = this.pz;
        this.queryRadius = zone.radius * tune.areaFillFraction;
        this.queryCos = -1;
        return this.countEnemies(state, self, selfSlot) >= need;
      }
      case 'wave': {
        this.queryX = this.px;
        this.queryY = this.py;
        this.queryZ = this.pz;
        this.queryRadius = def.range * tune.areaFillFraction;
        this.queryCos = def.coneHalfAngle < Math.PI ? Math.cos(def.coneHalfAngle * 0.9) : -1;
        return this.countEnemies(state, self, selfSlot) >= need;
      }
      case 'projectile': {
        const shot = def.projectile !== null ? this.projectiles[def.projectile] : undefined;
        if (shot === undefined || target === undefined || !inSight) return false;
        if (target.spawnProtectTicks > 0) return false;
        if (shot.gravity > 0) {
          // Bombs fall: a run over a target that is below and ahead.
          const dx = target.position.x - this.px;
          const dz = target.position.z - this.pz;
          return (
            target.position.y < this.py - tune.bombDrop &&
            dx * dx + dz * dz < tune.bombReach * tune.bombReach &&
            dx * this.noseX + dz * this.noseZ > 0
          );
        }
        const reach = shot.speed * shot.lifeS;
        const lined = this.targetCos >= Math.cos(def.aimLimit + 0.08);
        // Something that leaves a field where it ends is thrown to land near the target.
        if (shot.zoneOnEnd !== null)
          return lined && distance > reach * 0.5 && distance < reach * 1.25;
        return lined && distance < reach * tune.fireRangeFraction;
      }
      case 'cone':
      case 'beam': {
        if (target === undefined || !inSight || target.spawnProtectTicks > 0) return false;
        const aimWindow = def.aimLimit + def.coneHalfAngle * tune.coneAimFraction;
        return (
          distance < def.range * tune.fireRangeFraction && this.targetCos >= Math.cos(aimWindow)
        );
      }
      default:
        return false;
    }
  }

  /** Is whoever hit it last in front of its shield? */
  private threatAhead(state: Readonly<SimState>, self: Readonly<DragonState>): boolean {
    const id = self.lastDamagerId;
    if (id === NO_PLAYER) return false;
    const dragons = state.dragons;
    for (let i = 0; i < dragons.length; i++) {
      const other = dragons[i];
      if (other === undefined || !other.active || other.id !== id) continue;
      const dx = other.position.x - this.px;
      const dy = other.position.y - this.py;
      const dz = other.position.z - this.pz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return (
        dx * this.noseX + dy * this.noseY + dz * this.noseZ >=
        Math.cos(this.combat.shieldHalfAngle) * distance
      );
    }
    return false;
  }

  /** Living enemies it knows of inside the query sphere (and cone, about the aim). */
  private countEnemies(
    state: Readonly<SimState>,
    self: Readonly<DragonState>,
    selfSlot: number,
  ): number {
    const dragons = state.dragons;
    const radius = this.queryRadius;
    const cos = this.queryCos;
    let count = 0;
    for (let i = 0; i < dragons.length; i++) {
      if (i === selfSlot) continue;
      const other = dragons[i];
      if (other === undefined || !isAlive(other) || other.team === self.team) continue;
      if (other.spawnProtectTicks > 0 || other.phaseTicks > 0) continue;
      const dx = other.position.x - this.queryX;
      const dy = other.position.y - this.queryY;
      const dz = other.position.z - this.queryZ;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq > radius * radius) continue;
      if (cos > -1) {
        const distance = Math.sqrt(distanceSq);
        if (dx * this.noseX + dy * this.noseY + dz * this.noseZ < cos * distance) continue;
      }
      count++;
    }
    return count;
  }

  /** Teammates (itself included) within `radius` who could use a heal. */
  private countHurtAllies(
    state: Readonly<SimState>,
    self: Readonly<DragonState>,
    radius: number,
    tune: BotTuning,
  ): number {
    const dragons = state.dragons;
    let count = 0;
    for (let i = 0; i < dragons.length; i++) {
      const other = dragons[i];
      if (other === undefined || !isAlive(other) || other.team !== self.team) continue;
      if (!(other.health < other.maxHealth * tune.allyHurtFraction)) continue;
      const dx = other.position.x - this.px;
      const dy = other.position.y - this.py;
      const dz = other.position.z - this.pz;
      if (dx * dx + dy * dy + dz * dz <= radius * radius) count++;
    }
    return count;
  }

  /** An enemy projectile about to pass very close: roll out of its way. */
  private watchProjectiles(
    state: Readonly<SimState>,
    self: Readonly<DragonState>,
    cls: ClassTuning,
    tune: BotTuning,
    level: BotDifficultyTuning,
  ): void {
    const projectiles = state.projectiles;
    const miss = tune.dodgeMissDistance + cls.hitRadius;
    const horizon = tune.dodgeProjectileS;
    const velocity = self.velocity;
    let left = state.projectileCount;
    for (let i = 0; i < projectiles.length && left > 0; i++) {
      const projectile = projectiles[i];
      if (projectile === undefined || !projectile.active) continue;
      left--;
      if (projectile.team === self.team) continue;
      // The dragon as seen from the projectile, and how fast the gap closes.
      const rx = this.px - projectile.position.x;
      const ry = this.py - projectile.position.y;
      const rz = this.pz - projectile.position.z;
      const vx = projectile.velocity.x - velocity.x;
      const vy = projectile.velocity.y - velocity.y;
      const vz = projectile.velocity.z - velocity.z;
      const speedSq = vx * vx + vy * vy + vz * vz;
      if (!(speedSq > 1)) continue;
      const time = (rx * vx + ry * vy + rz * vz) / speedSq;
      if (!(time > 0) || time > horizon) continue;
      const mx = rx - vx * time;
      const my = ry - vy * time;
      const mz = rz - vz * time;
      if (mx * mx + my * my + mz * mz > miss * miss) continue;
      // One roll of the dice per threat seen, not per tick it stays in view.
      if (this.random() < level.dodgeChance) {
        // Away from the line it flies on. Horizontal right of the heading is (-cos, 0, sin).
        const side = mx * -Math.cos(self.yaw) + mz * Math.sin(self.yaw);
        this.dodgeDir = side >= 0 ? 1 : -1;
        this.dodgeTicks = 0;
      } else {
        // Not this time: look away for as long as this one could still arrive.
        this.dodgeTicks = ticksOf(horizon);
      }
      return;
    }
  }

  // --- Small state ----------------------------------------------------------------------------------------

  private dropTarget(): void {
    this.targetSlot = -1;
    this.targetPlayer = NO_PLAYER;
    this.targetLos = false;
    this.stuckTicks = 0;
  }

  /** Nothing to do (dead, no dragon, countdown): forget the moment, keep the identity. */
  private rest(): void {
    this.dropTarget();
    this.botMode = BOT_MODE_PATROL;
    this.reactTicks = 0;
    this.extendTicks = 0;
    this.retreatTicks = 0;
    this.allySlot = -1;
    this.enemiesAlive = 0;
    this.chased = false;
    this.lastHealth = -1;
    this.hurtTicks = 0;
    this.hurtCheckTicks = -1;
    this.avoidSide = 0;
    this.avoidTicks = 0;
    this.boosting = false;
    this.pressSlot = -1;
    this.pressTicks = 0;
    this.dodgeTicks = -1;
    this.lastButtons = 0;
    this.relayErrand = BOT_ERRAND_NONE;
    this.relayRevision = -1;
    this.feel.fill(Infinity);
  }

  /** mulberry32, the same generator as `createSeededRandom`, kept in a field. */
  private random(): number {
    const state = (this.rng + 0x6d2b79f5) >>> 0;
    this.rng = state;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export function createBotBrain(seed: number, options?: BotBrainOptions): BotBrain {
  return new BotBrain(seed, options);
}
