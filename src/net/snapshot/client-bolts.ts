/**
 * Fast projectiles on a client. A bolt lives about a second and there can be sixty of them in
 * the air, so they are NOT in snapshots: the host's `abilityCast` event (reliable channel,
 * position + direction + tick) is the launch, and every client flies its own copy from it with
 * the numbers of the shared tables. The copies are pictures only: the host alone decides what a
 * bolt hit, and its `hit` event is what the HUD and the effects react to.
 *
 * TIMING. Other dragons are drawn in the past (the snapshot playhead), so a bolt from an event
 * starts when the playhead reaches the event's tick: it leaves the dragon that fired it at the
 * moment that dragon is drawn firing. The local rider's own bolts start at once, from the
 * predicted dragon (`spawnLocal`), and the host's echo of that cast is ignored (`onAbilityCast`
 * with `skipLocal`), which is the "client shows its own shot instantly" of docs/NETWORKING.md.
 *
 * A bolt ends at the end of its life, on terrain (the same BVH ray the host uses) or when it
 * touches a dragon it could hurt (an enemy of its team; where that dragon is DRAWN, so the
 * picture is consistent with what the player sees, give or take the interpolation delay).
 *
 * Nothing allocates after construction. Runs once per rendered frame.
 */

import {
  ABILITY_SLOTS,
  ABILITY_TABLE,
  CLASS_TUNING,
  COMBAT_TUNING,
  DRAGON_FLAG_ALIVE,
  NO_PLAYER,
  PROJECTILE_DEFS,
  TEAM_EMBER,
  TICK_DT_S,
  acquireProjectileView,
  createVec3,
} from '../../shared';
import type {
  AbilityCastEvent,
  AbilityTable,
  ClassTuning,
  CombatTuning,
  DragonClassId,
  MutableVec3,
  MutableWorldView,
  PlayerId,
  ProjectileDef,
  ProjectileKind,
  TeamId,
  Vec3,
} from '../../shared';
import { abilityOfSlot, createTerrainRay, resolveFireDirection } from '../../sim';
import type { DragonState, SimCollisionWorld, TerrainRay } from '../../sim';
import type { ClientRoster } from './client-view';
import type { SnapshotSample } from './snapshot-buffer';

/** Bolts flown at once; a shot beyond it is not drawn. */
export const CLIENT_BOLT_CAPACITY = 128;
/** First id of client-flown bolts in the WorldView (snapshot projectile ids are below it). */
export const CLIENT_BOLT_ID_BASE = 0x10000;
/** An event this far ahead of the playhead (seconds) is not waited for: the bolt starts now. */
const MAX_START_DELAY_S = 0.5;
/** A projectile leaves the caster this far in front of its terrain sphere (as on the host). */
const MUZZLE_GAP_M = 0.5;

interface Bolt {
  active: boolean;
  id: number;
  kind: ProjectileKind;
  ownerId: PlayerId;
  team: TeamId;
  position: MutableVec3;
  velocity: MutableVec3;
  /** Seconds until it starts flying (it is not drawn before). */
  delayS: number;
  lifeS: number;
}

export interface ClientBoltsOptions {
  /** Must be the tables the host uses. Default: the shared ones. */
  abilityTable?: AbilityTable;
  projectileDefs?: Record<ProjectileKind, ProjectileDef>;
  classTuning?: Record<DragonClassId, ClassTuning>;
  combatTuning?: CombatTuning;
}

/** The local dragon as the bolts need it for a hit test; a predicted `DragonState` fits. */
export interface BoltLocalTarget {
  readonly id: PlayerId;
  readonly team: TeamId;
  readonly classId: DragonClassId;
  readonly flags: number;
  readonly position: Vec3;
}

export class ClientBolts {
  private readonly abilities: AbilityTable;
  private readonly defs: Record<ProjectileKind, ProjectileDef>;
  private readonly classes: Record<DragonClassId, ClassTuning>;
  private readonly combat: CombatTuning;
  private readonly bolts: Bolt[] = [];
  private readonly ray: TerrainRay = createTerrainRay();
  private readonly dir = createVec3();
  private live = 0;
  private nextId = 0;

  constructor(options: ClientBoltsOptions = {}) {
    this.abilities = options.abilityTable ?? ABILITY_TABLE;
    this.defs = options.projectileDefs ?? PROJECTILE_DEFS;
    this.classes = options.classTuning ?? CLASS_TUNING;
    this.combat = options.combatTuning ?? COMBAT_TUNING;
    for (let i = 0; i < CLIENT_BOLT_CAPACITY; i++) {
      this.bolts.push({
        active: false,
        id: 0,
        kind: 'fireBolt',
        ownerId: NO_PLAYER,
        team: TEAM_EMBER,
        position: createVec3(),
        velocity: createVec3(),
        delayS: 0,
        lifeS: 0,
      });
    }
  }

  /** Bolts in the air (or waiting for the playhead). */
  get count(): number {
    return this.live;
  }

  reset(): void {
    for (let i = 0; i < this.bolts.length; i++) {
      const bolt = this.bolts[i];
      if (bolt !== undefined) bolt.active = false;
    }
    this.live = 0;
  }

  /** The projectile kind `slot` of `classId` launches as an event-replicated bolt, or null. */
  boltKindOf(classId: DragonClassId, slot: number): ProjectileKind | null {
    const def = abilityOfSlot(this.abilities[classId], slot);
    if (def === undefined || def.kind !== 'projectile' || def.projectile === null) return null;
    return this.defs[def.projectile].replication === 'event' ? def.projectile : null;
  }

  /**
   * A host `abilityCast` event. Starts a bolt if the ability launches one.
   *
   * @param team The caster's team (the roster knows).
   * @param playTick The snapshot playhead (`SnapshotSample.playTick`): the bolt waits until it
   *   reaches the event's tick.
   * @param skipLocal The local player's id while its casts are predicted (`spawnLocal` already
   *   drew them), otherwise NO_PLAYER.
   */
  onAbilityCast(
    event: Readonly<AbilityCastEvent>,
    team: TeamId,
    playTick: number,
    skipLocal: PlayerId,
  ): void {
    if (event.dragonId === skipLocal) return;
    const slot = ABILITY_SLOTS.indexOf(event.slot);
    const kind = this.boltKindOf(event.classId, slot);
    if (kind === null) return;
    const bolt = this.acquire();
    if (bolt === null) return;
    const pdef = this.defs[kind];
    const muzzle = this.classes[event.classId].hitRadius + pdef.radius + MUZZLE_GAP_M;
    const direction = event.direction;
    bolt.kind = kind;
    bolt.ownerId = event.dragonId;
    bolt.team = team;
    bolt.position.x = event.position.x + direction.x * muzzle;
    bolt.position.y = event.position.y + direction.y * muzzle;
    bolt.position.z = event.position.z + direction.z * muzzle;
    // The event does not carry the caster's velocity: `inheritVelocity` bolts would need it.
    bolt.velocity.x = direction.x * pdef.speed;
    bolt.velocity.y = direction.y * pdef.speed;
    bolt.velocity.z = direction.z * pdef.speed;
    const delay = (event.tick - playTick) * TICK_DT_S;
    // `>= 0` is false for NaN: then it simply starts now.
    bolt.delayS = delay >= 0 ? (delay < MAX_START_DELAY_S ? delay : 0) : 0;
    bolt.lifeS = pdef.lifeS;
  }

  /**
   * The local rider's own shot, the moment it is predicted: call for each bolt slot in
   * `ClientPredictor.castPulse` right after `ClientPredictor.step`.
   */
  spawnLocal(dragon: Readonly<DragonState>, slot: number): void {
    const kind = this.boltKindOf(dragon.classId, slot);
    const def = abilityOfSlot(this.abilities[dragon.classId], slot);
    if (kind === null || def === undefined) return;
    const bolt = this.acquire();
    if (bolt === null) return;
    const pdef = this.defs[kind];
    const dir = resolveFireDirection(dragon, def.aimLimit, this.dir);
    const muzzle = this.classes[dragon.classId].hitRadius + pdef.radius + MUZZLE_GAP_M;
    bolt.kind = kind;
    bolt.ownerId = dragon.id;
    bolt.team = dragon.team;
    bolt.position.x = dragon.position.x + dir.x * muzzle;
    bolt.position.y = dragon.position.y + dir.y * muzzle;
    bolt.position.z = dragon.position.z + dir.z * muzzle;
    bolt.velocity.x = dir.x * pdef.speed + dragon.velocity.x * pdef.inheritVelocity;
    bolt.velocity.y = dir.y * pdef.speed + dragon.velocity.y * pdef.inheritVelocity;
    bolt.velocity.z = dir.z * pdef.speed + dragon.velocity.z * pdef.inheritVelocity;
    bolt.delayS = 0;
    bolt.lifeS = pdef.lifeS;
  }

  private acquire(): Bolt | null {
    if (this.live >= this.bolts.length) return null;
    for (let i = 0; i < this.bolts.length; i++) {
      const bolt = this.bolts[i];
      if (bolt !== undefined && !bolt.active) {
        bolt.active = true;
        bolt.id = CLIENT_BOLT_ID_BASE + this.nextId;
        this.nextId = (this.nextId + 1) & 0xffff;
        this.live++;
        return bolt;
      }
    }
    return null;
  }

  /**
   * Flies every bolt for one rendered frame.
   *
   * @param dtMs Frame time in milliseconds (an integer-ish number in a field of the caller).
   * @param collision The map the client predicts against, or null (no terrain test).
   * @param sample This frame's snapshot sample: where the other dragons are drawn.
   * @param local The local predicted dragon, or null.
   */
  update(
    dtMs: number,
    collision: SimCollisionWorld | null,
    sample: Readonly<SnapshotSample> | null,
    roster: ClientRoster,
    local: BoltLocalTarget | null,
  ): void {
    if (this.live === 0 || !(dtMs > 0)) return;
    const frameS = dtMs / 1000;
    const ray = this.ray;
    const scale = this.combat.hitRadiusScale;
    for (let i = 0; i < this.bolts.length; i++) {
      const bolt = this.bolts[i];
      if (bolt === undefined || !bolt.active) continue;
      let dt = frameS;
      if (bolt.delayS > 0) {
        bolt.delayS -= dt;
        if (bolt.delayS > 0) continue;
        dt = -bolt.delayS;
        bolt.delayS = 0;
      }
      const pdef = this.defs[bolt.kind];
      const position = bolt.position;
      const velocity = bolt.velocity;
      velocity.y -= pdef.gravity * dt;
      const speed = Math.sqrt(
        velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
      );
      const travel = speed * dt;
      bolt.lifeS -= dt;
      // `speed - speed` is NaN for NaN and Infinity.
      let ended = !(bolt.lifeS > 0) || speed - speed !== 0;

      if (!ended && travel > 1e-6) {
        const ux = velocity.x / speed;
        const uy = velocity.y / speed;
        const uz = velocity.z / speed;
        if (collision !== null && collision.raycastRay !== undefined) {
          ray.originX = position.x;
          ray.originY = position.y;
          ray.originZ = position.z;
          ray.directionX = ux;
          ray.directionY = uy;
          ray.directionZ = uz;
          ray.maxDistance = travel;
          if (collision.raycastRay(ray) >= 0) ended = true;
        }
        if (!ended && sample !== null && sample.valid) {
          for (let d = 0; d < sample.dragonCount; d++) {
            const target = sample.dragons[d];
            if (target === undefined || target.id === bolt.ownerId) continue;
            if (local !== null && target.id === local.id) continue;
            if ((target.flags & DRAGON_FLAG_ALIVE) === 0) continue;
            if (roster.teamOf(target.id) === bolt.team) continue;
            const radius = this.classes[roster.classOf(target.id)].hitRadius * scale + pdef.radius;
            const mx = position.x - target.position.x;
            const my = position.y - target.position.y;
            const mz = position.z - target.position.z;
            const b = mx * ux + my * uy + mz * uz;
            const c = mx * mx + my * my + mz * mz - radius * radius;
            if (c > 0 && b > 0) continue;
            const discriminant = b * b - c;
            if (discriminant < 0) continue;
            if (-b - Math.sqrt(discriminant) <= travel) {
              ended = true;
              break;
            }
          }
        }
        if (
          !ended &&
          local !== null &&
          local.id !== bolt.ownerId &&
          local.team !== bolt.team &&
          (local.flags & DRAGON_FLAG_ALIVE) !== 0
        ) {
          const radius = this.classes[local.classId].hitRadius * scale + pdef.radius;
          const mx = position.x - local.position.x;
          const my = position.y - local.position.y;
          const mz = position.z - local.position.z;
          const b = mx * ux + my * uy + mz * uz;
          const c = mx * mx + my * my + mz * mz - radius * radius;
          if (!(c > 0 && b > 0)) {
            const discriminant = b * b - c;
            if (discriminant >= 0 && -b - Math.sqrt(discriminant) <= travel) ended = true;
          }
        }
      }

      if (ended) {
        bolt.active = false;
        this.live--;
        continue;
      }
      position.x += velocity.x * dt;
      position.y += velocity.y * dt;
      position.z += velocity.z * dt;
    }
  }

  /** Appends the flying bolts to the frame's WorldView (after the snapshot projectiles). */
  writeView(view: MutableWorldView): void {
    if (this.live === 0) return;
    for (let i = 0; i < this.bolts.length; i++) {
      const bolt = this.bolts[i];
      if (bolt === undefined || !bolt.active || bolt.delayS > 0) continue;
      const out = acquireProjectileView(view);
      out.id = bolt.id;
      out.kind = bolt.kind;
      out.ownerId = bolt.ownerId;
      out.team = bolt.team;
      out.position.x = bolt.position.x;
      out.position.y = bolt.position.y;
      out.position.z = bolt.position.z;
      out.velocity.x = bolt.velocity.x;
      out.velocity.y = bolt.velocity.y;
      out.velocity.z = bolt.velocity.z;
    }
  }
}
