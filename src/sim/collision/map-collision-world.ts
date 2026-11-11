/**
 * The collision world of a map (T-1.7): terrain bounces and the storm wall, behind the
 * `SimCollisionWorld` seam that `sim.ts` calls once per dragon per tick, plus the `TerrainQuery`
 * the camera rig uses.
 *
 * TERRAIN. A dragon is a sphere of its class's `hitRadius`. Each tick the sphere is marched
 * from the previous position to the integrated one:
 *   1. Broad phase: one closest-point query around the middle of the move. In open air that is
 *      the whole cost.
 *   2. March: at each sample the distance d to the terrain is known, so the sphere may advance
 *      d - radius without touching anything. It always advances at least MARCH_MIN_STEP radii,
 *      which is less than one radius, so the CENTRE can never cross a surface between two
 *      samples: no tunnelling at any speed. A sample closer than the radius is a contact.
 *   3. Contact: the sphere is pushed out along (centre - closest point), which is the right
 *      normal for faces, edges and corners alike, and re-checked a few times for a second
 *      surface (inner corners). If it cannot be freed it goes back to the last clear sample.
 *      The rest of the tick's movement is dropped.
 *   4. Bounce: the tick's velocity is reflected with restitution and friction, the burst is
 *      folded into it, and damage is taken from the speed INTO the surface.
 * The invariant "a dragon that starts a tick clear of the terrain ends it clear" holds by
 * construction. A dragon that starts inside the rock (bad spawn) is pushed out through the first
 * face it comes within a radius of; deep inside it is not noticed until then.
 *
 * RE-HIT GRACE lives in `dragon.terrainGraceTicks`: terrain does no damage while it runs, and a
 * damaging bounce sets it to `terrainRehitGraceS`. It is part of DragonState, so it is copied,
 * reset and rolled back with it. A lethal hit ignores the grace and dodge immunity.
 *
 * STORM WALL. Outside the storm cylinder, above the ceiling or below the floor a living dragon
 * gets DRAGON_FLAG_IN_STORM, is pushed back (burst, growing with depth), has its nose turned
 * toward the arena (also growing with depth, and faster than it can steer at full depth) and
 * loses health every tick (not during spawn protection). The floor and the ceiling only level
 * the nose, so they are also a HARD limit `stormVerticalMaxDepth` further out: a pilot who keeps
 * diving cannot sink out of the bottom of the map (the terrain ends a little below the floor).
 * The limit is applied before the terrain sweep, so it never moves a dragon into the rock.
 *
 * Deterministic and allocation-free per tick: scalars and instance scratch only.
 */

import {
  CLASS_TUNING,
  COLLISION_TUNING,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_IN_STORM,
  DRAGON_FLAG_PHASING,
  MATCH_TUNING,
  buildMapTriangles,
} from '../../shared';
import type {
  ClassTuning,
  CollisionTuning,
  DragonClassId,
  FlightTuning,
  MapManifest,
  MatchTuning,
  MutableVec3,
  TerrainQuery,
  Vec3,
} from '../../shared';
import { ENV_SOURCE_NONE, ENV_SOURCE_STORM, ENV_SOURCE_TERRAIN } from '../collision-world';
import type { SimCollisionWorld, TerrainRay } from '../collision-world';
import type { DragonState } from '../dragon-state';
import { damageDragon, secondsToTicks, setDragonVelocity } from '../flight';
import { TerrainBvh } from './terrain-bvh';

// Numeric guards, not tuning.
/** Metres the sphere is left clear of a surface after a push-out. */
const CONTACT_SKIN = 0.02;
/** Smallest radius the sweep works with (a broken tuning value must not stall the march). */
const MIN_RADIUS = 0.1;
/** Smallest march step in radii. Must stay below 1: see step 2 above. */
const MARCH_MIN_STEP = 0.5;
/** Cap on march samples per dragon per tick; past it the dragon stops at the last clear one. */
const MAX_MARCH_STEPS = 32;
/** Push-out attempts for one contact before giving up and going back. */
const MAX_PUSH_OUTS = 6;
const EPSILON = 1e-6;
/** Metres searched for the way out when a phase dive ends inside the rock. */
const PHASE_EJECT_REACH = 400;
/** Lines tried for the way out: along and against the velocity, then the six axes. */
const EJECT_DIRECTIONS = 8;
/** Surfaces a line may pass (stacked and overlapping solids) before it is given up. */
const MAX_EJECT_HOPS = 8;
/**
 * The centre counts as BEHIND the closest face (inside the rock) when the offset from the
 * closest point runs against the face normal by at least this cosine. It has to be this strict:
 * next to a sharp edge a point OUTSIDE the rock is behind the plane of one of the edge's faces.
 */
const BEHIND_FACE_COS = 0.99;
/** After a bounce the nose must point at least this much (cos) away from the surface. */
const MIN_AWAY_COS = 0.05;
/** Nose angle given to a bounce off a floor or ceiling whose reflected path was clamped flat. */
const VERTICAL_BOUNCE_PITCH = 0.1;
/** Same hard limit as flight.ts: pitch never reaches straight up or down. */
const PITCH_HARD_LIMIT = 1.5;
const TWO_PI = Math.PI * 2;

/** What the collision world needs from a map; a MapManifest (greybox or not) fits. */
export type CollisionMapSource = Pick<
  MapManifest,
  'size' | 'solids' | 'placements' | 'chunkSize' | 'colliders'
>;

/**
 * Called for every bounce of a LIVING dragon that was moving into the surface (not for resting
 * contact), after damage was applied. For VFX/audio events; must not allocate or keep `dragon`.
 * `damage` is the HP actually removed (0 inside the grace or under the damage speed).
 */
export type TerrainHitListener = (
  dragon: DragonState,
  impactSpeed: number,
  damage: number,
  pointX: number,
  pointY: number,
  pointZ: number,
  normalX: number,
  normalY: number,
  normalZ: number,
) => void;

export interface MapCollisionOptions {
  /** Default: the shared tables (read live every tick). */
  collisionTuning?: CollisionTuning;
  classTuning?: Record<DragonClassId, ClassTuning>;
  matchTuning?: MatchTuning;
  /**
   * Low-detail collision: prisms get at most this many sides (see `MapTriangleOptions`). The
   * coarse prism sits INSIDE the drawn one, so dragons then clip the drawn corners. Default:
   * full detail, collision == visuals.
   */
  maxPrismSides?: number;
  onTerrainHit?: TerrainHitListener;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Non-negative finite tuning value, else 0. */
function positive(value: number): number {
  return value > 0 && Number.isFinite(value) ? value : 0;
}

function pitchLimit(tuned: number): number {
  return tuned > 0 ? (tuned < PITCH_HARD_LIMIT ? tuned : PITCH_HARD_LIMIT) : 0;
}

function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

export class MapCollisionWorld implements SimCollisionWorld, TerrainQuery {
  /** The terrain tree, or null on a map without solids (storm wall only). */
  readonly terrain: TerrainBvh | null;
  /** The live table this world reads (mutate it to tune). */
  readonly tuning: CollisionTuning;
  /** Storm cylinder; `stormRadius` may be changed between ticks (Duel shrinks it per round). */
  stormCenterX: number;
  stormCenterZ: number;
  stormRadius: number;
  /** The map's own radius: what `setStormRadius` falls back to. */
  readonly mapStormRadius: number;
  ceilingY: number;
  floorY: number;
  onTerrainHit: TerrainHitListener | null;

  private readonly classes: Record<DragonClassId, ClassTuning>;
  private readonly match: MatchTuning;
  // Scratch of `contactNormal`.
  private normalX = 0;
  private normalY = 1;
  private normalZ = 0;

  constructor(map: CollisionMapSource, options: MapCollisionOptions = {}) {
    this.tuning = options.collisionTuning ?? COLLISION_TUNING;
    this.classes = options.classTuning ?? CLASS_TUNING;
    this.match = options.matchTuning ?? MATCH_TUNING;
    this.onTerrainHit = options.onTerrainHit ?? null;

    const colliders = map.colliders;
    this.stormCenterX = colliders.stormCenter.x;
    this.stormCenterZ = colliders.stormCenter.z;
    this.stormRadius = colliders.stormRadius;
    this.mapStormRadius = colliders.stormRadius;
    this.ceilingY = colliders.ceilingY;
    this.floorY = colliders.floorY;

    const hasSolids = map.solids !== undefined && map.solids.length > 0;
    const hasPlacements = map.placements !== undefined && map.placements.length > 0;
    if (hasSolids || hasPlacements) {
      const triangles = buildMapTriangles(
        map,
        options.maxPrismSides === undefined ? {} : { maxPrismSides: options.maxPrismSides },
      );
      const terrain = new TerrainBvh(triangles.positions, triangles.indices);
      this.terrain = terrain.triangleCount > 0 ? terrain : null;
    } else {
      this.terrain = null;
    }
  }

  // --- SimCollisionWorld ------------------------------------------------------------------------

  resolveDragon(dragon: DragonState, prevPosition: Vec3, dtS: number, tuning: FlightTuning): void {
    const position = dragon.position;
    // finalizeDragon repairs a non-finite position; nothing sensible can be resolved from one.
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return;
    }
    this.limitStormDepth(dragon);
    // The timer decides, not DRAGON_FLAG_PHASING: the bit is only refreshed at the end of the
    // tick. That makes the bit "was phasing last tick", which is how the end of a phase shows.
    if (this.terrain !== null && dragon.phaseTicks <= 0) {
      if (
        (dragon.flags & DRAGON_FLAG_PHASING) !== 0 &&
        this.ejectFromTerrain(this.terrain, dragon)
      ) {
        // Put back outside the rock this tick; the sweep carries on from there next tick.
      } else {
        this.resolveTerrain(this.terrain, dragon, prevPosition, dtS, tuning);
      }
    }
    this.resolveStorm(dragon, dtS);
  }

  /**
   * End of a phase dive: a dragon whose phase ran out inside the rock is put outside it (the
   * sweep alone would only notice it once it came within a radius of a face). Returns true when
   * it moved the dragon.
   *
   * "Inside" is `TerrainBvh.solidDepth`, not "behind the closest face": where solids overlap or
   * are stacked, the closest face can belong to another solid and face the dragon from within
   * the rock. The way out is the nearest surface if open air is behind it; otherwise (that
   * surface was such an inner face) the shortest of a few straight lines to open air.
   */
  private ejectFromTerrain(terrain: TerrainBvh, dragon: DragonState): boolean {
    const position = dragon.position;
    const tunedRadius = this.classes[dragon.classId].hitRadius;
    const radius = tunedRadius > MIN_RADIUS ? tunedRadius : MIN_RADIUS;
    const out = radius + CONTACT_SKIN;
    const startX = position.x;
    const startY = position.y;
    const startZ = position.z;

    if (terrain.solidDepth(startX, startY, startZ) <= 0) {
      // In open air. Touching a surface gets the ordinary contact answer.
      if (terrain.closestPoint(startX, startY, startZ, radius) < 0) return false;
      this.settleOutside(terrain, position, radius);
      return true;
    }

    // Through the nearest surface, if that is the way out.
    const distance = terrain.closestPoint(startX, startY, startZ, PHASE_EJECT_REACH);
    if (distance > EPSILON) {
      const scale = (distance + out) / distance;
      const x = startX + (terrain.closestX - startX) * scale;
      const y = startY + (terrain.closestY - startY) * scale;
      const z = startZ + (terrain.closestZ - startZ) * scale;
      if (terrain.solidDepth(x, y, z) <= 0) {
        position.x = x;
        position.y = y;
        position.z = z;
        this.settleOutside(terrain, position, radius);
        return true;
      }
    }

    // Straight lines to open air: the way it was going, the way it came, and the six axes.
    const speed = Math.sqrt(
      dragon.velocity.x * dragon.velocity.x +
        dragon.velocity.y * dragon.velocity.y +
        dragon.velocity.z * dragon.velocity.z,
    );
    let best = Infinity;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;
    for (let i = 0; i < EJECT_DIRECTIONS; i++) {
      let dx = 0;
      let dy = 0;
      let dz = 0;
      if (i < 2) {
        if (!(speed > EPSILON)) continue;
        const sign = i === 0 ? 1 : -1;
        dx = (dragon.velocity.x / speed) * sign;
        dy = (dragon.velocity.y / speed) * sign;
        dz = (dragon.velocity.z / speed) * sign;
      } else {
        const sign = (i & 1) === 0 ? 1 : -1;
        if (i < 4) dx = sign;
        else if (i < 6) dy = sign;
        else dz = sign;
      }
      // Hop from surface to surface until the far side of one is open air.
      let travelled = 0;
      for (let hop = 0; hop < MAX_EJECT_HOPS && travelled < best; hop++) {
        const hit = terrain.raycast(
          startX + dx * travelled,
          startY + dy * travelled,
          startZ + dz * travelled,
          dx,
          dy,
          dz,
          PHASE_EJECT_REACH,
        );
        if (hit < 0) break;
        travelled += hit + out;
        const x = startX + dx * travelled;
        const y = startY + dy * travelled;
        const z = startZ + dz * travelled;
        if (terrain.solidDepth(x, y, z) > 0) continue;
        if (travelled < best) {
          best = travelled;
          bestX = x;
          bestY = y;
          bestZ = z;
        }
        break;
      }
    }
    if (best === Infinity) return false;
    position.x = bestX;
    position.y = bestY;
    position.z = bestZ;
    this.settleOutside(terrain, position, radius);
    return true;
  }

  /** A centre in open air that may still touch a surface: pushed clear of it, a few times. */
  private settleOutside(terrain: TerrainBvh, position: MutableVec3, radius: number): void {
    for (let attempt = 0; attempt < MAX_PUSH_OUTS; attempt++) {
      const distance = terrain.closestPoint(position.x, position.y, position.z, radius);
      if (distance < 0) return;
      this.contactNormal(terrain, position.x, position.y, position.z, distance);
      const out = radius + CONTACT_SKIN;
      position.x = terrain.closestX + this.normalX * out;
      position.y = terrain.closestY + this.normalY * out;
      position.z = terrain.closestZ + this.normalZ * out;
    }
  }

  /** Moves the storm wall (a mode shrinking the arena). Not a number: back to the map's radius. */
  setStormRadius(radius: number): void {
    this.stormRadius = radius >= 0 && Number.isFinite(radius) ? radius : this.mapStormRadius;
  }

  // --- TerrainQuery -----------------------------------------------------------------------------

  raycast(
    originX: number,
    originY: number,
    originZ: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    maxDistance: number,
  ): number {
    if (this.terrain === null) return -1;
    return this.terrain.raycast(
      originX,
      originY,
      originZ,
      directionX,
      directionY,
      directionZ,
      maxDistance,
    );
  }

  /** `SimCollisionWorld.raycastRay`: the terrain ray of the abilities. */
  raycastRay(ray: Readonly<TerrainRay>): number {
    return this.terrain === null ? -1 : this.terrain.raycastRay(ray);
  }

  clearance(x: number, y: number, z: number, maxDistance: number): number {
    if (this.terrain === null) return -1;
    return this.terrain.closestPoint(x, y, z, maxDistance);
  }

  // --- Terrain ----------------------------------------------------------------------------------

  private resolveTerrain(
    terrain: TerrainBvh,
    dragon: DragonState,
    prevPosition: Vec3,
    dtS: number,
    flight: FlightTuning,
  ): void {
    const position = dragon.position;
    const tunedRadius = this.classes[dragon.classId].hitRadius;
    const radius = tunedRadius > MIN_RADIUS ? tunedRadius : MIN_RADIUS;

    // Start of the sweep; a broken previous position degrades to a discrete check at the end.
    let startX = prevPosition.x;
    let startY = prevPosition.y;
    let startZ = prevPosition.z;
    if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(startZ)) {
      startX = position.x;
      startY = position.y;
      startZ = position.z;
    }
    const moveX = position.x - startX;
    const moveY = position.y - startY;
    const moveZ = position.z - startZ;
    const moveLength = Math.sqrt(moveX * moveX + moveY * moveY + moveZ * moveZ);

    // 1. Broad phase: nothing within reach of any point of the move.
    const reach = moveLength * 0.5 + radius + CONTACT_SKIN;
    if (
      terrain.closestPoint(
        startX + moveX * 0.5,
        startY + moveY * 0.5,
        startZ + moveZ * 0.5,
        reach,
      ) < 0
    ) {
      return;
    }

    // 2. March.
    let dirX = 0;
    let dirY = 0;
    let dirZ = 0;
    if (moveLength > EPSILON) {
      dirX = moveX / moveLength;
      dirY = moveY / moveLength;
      dirZ = moveZ / moveLength;
    }
    const minStep = radius * MARCH_MIN_STEP;
    let x = startX;
    let y = startY;
    let z = startZ;
    let remaining = moveLength > EPSILON ? moveLength : 0;
    let clearX = startX;
    let clearY = startY;
    let clearZ = startZ;
    let hasClear = false;
    let contact = false;
    let distance = -1;

    for (let step = 0; step < MAX_MARCH_STEPS; step++) {
      distance = terrain.closestPoint(x, y, z, remaining + radius + CONTACT_SKIN);
      if (distance < 0) {
        // Nothing within reach of the rest of the move.
        return;
      }
      if (distance < radius) {
        contact = true;
        break;
      }
      clearX = x;
      clearY = y;
      clearZ = z;
      hasClear = true;
      if (remaining <= 0) return;
      let advance = distance - radius;
      if (advance < minStep) advance = minStep;
      if (advance > remaining) advance = remaining;
      x += dirX * advance;
      y += dirY * advance;
      z += dirZ * advance;
      remaining -= advance;
    }

    if (!contact) {
      // Out of samples (a teleport-sized move): stop at the last sample known to be clear.
      position.x = clearX;
      position.y = clearY;
      position.z = clearZ;
      return;
    }

    // 3. Contact: push out, re-check for a second surface, fall back to the last clear sample.
    this.contactNormal(terrain, x, y, z, distance);
    const normalX = this.normalX;
    const normalY = this.normalY;
    const normalZ = this.normalZ;
    const pointX = terrain.closestX;
    const pointY = terrain.closestY;
    const pointZ = terrain.closestZ;

    let freed = false;
    for (let attempt = 0; attempt < MAX_PUSH_OUTS; attempt++) {
      const out = radius + CONTACT_SKIN;
      x = terrain.closestX + this.normalX * out;
      y = terrain.closestY + this.normalY * out;
      z = terrain.closestZ + this.normalZ * out;
      distance = terrain.closestPoint(x, y, z, radius);
      if (distance < 0) {
        freed = true;
        break;
      }
      this.contactNormal(terrain, x, y, z, distance);
    }
    if (!freed && hasClear) {
      x = clearX;
      y = clearY;
      z = clearZ;
    }
    position.x = x;
    position.y = y;
    position.z = z;

    // 4. Response.
    if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0) {
      // A falling body comes to rest where it lands.
      dragon.speed = 0;
      dragon.burst.x = 0;
      dragon.burst.y = 0;
      dragon.burst.z = 0;
      return;
    }
    if (!(dtS > 0)) return;
    const velocityX = moveX / dtS;
    const velocityY = moveY / dtS;
    const velocityZ = moveZ / dtS;
    const intoSurface = -(velocityX * normalX + velocityY * normalY + velocityZ * normalZ);
    // Resting or leaving contact: the push-out was all it needed.
    if (!(intoSurface > 0)) return;

    const restitution = clamp(flight.terrainBounceRestitution, 0, 1) || 0;
    const tuning = this.tuning;
    const minBounce = positive(tuning.terrainMinBounceSpeed);
    let bounce = intoSurface * restitution;
    if (bounce < minBounce) bounce = minBounce;

    // Along the surface: lose speed in proportion to the bounce impulse (Coulomb friction), so a
    // graze keeps nearly all of it and a hard hit scrubs most.
    let alongX = velocityX + normalX * intoSurface;
    let alongY = velocityY + normalY * intoSurface;
    let alongZ = velocityZ + normalZ * intoSurface;
    const alongSpeed = Math.sqrt(alongX * alongX + alongY * alongY + alongZ * alongZ);
    const scrub = positive(tuning.terrainFriction) * (1 + restitution) * intoSurface;
    const keep = alongSpeed > scrub && alongSpeed > EPSILON ? (alongSpeed - scrub) / alongSpeed : 0;
    alongX *= keep;
    alongY *= keep;
    alongZ *= keep;

    // The whole reflected velocity becomes the flight path; the burst was part of the impact.
    dragon.burst.x = 0;
    dragon.burst.y = 0;
    dragon.burst.z = 0;
    setDragonVelocity(
      dragon,
      alongX + normalX * bounce,
      alongY + normalY * bounce,
      alongZ + normalZ * bounce,
    );
    this.pointNoseAway(dragon, normalX, normalY, normalZ, flight);

    // Damage from the speed into the surface.
    let damage = 0;
    const lethalSpeed = flight.terrainLethalSpeed;
    if (lethalSpeed > 0 && intoSurface >= lethalSpeed) {
      damage = damageDragon(dragon, dragon.health, flight, true);
    } else if (dragon.terrainGraceTicks <= 0) {
      const over = intoSurface - positive(tuning.terrainDamageMinSpeed);
      const amount = over * positive(tuning.terrainDamagePerSpeed);
      if (amount > 0) {
        damage = damageDragon(dragon, amount, flight);
        if (damage > 0) {
          dragon.terrainGraceTicks = secondsToTicks(tuning.terrainRehitGraceS);
        }
      }
    }

    if (damage > 0) {
      // For the host's damage pipeline: credit, the `hit` event, the takedown source.
      dragon.envDamage += damage;
      dragon.envSource = ENV_SOURCE_TERRAIN;
    }

    if (this.onTerrainHit !== null) {
      this.onTerrainHit(
        dragon,
        intoSurface,
        damage,
        pointX,
        pointY,
        pointZ,
        normalX,
        normalY,
        normalZ,
      );
    }
  }

  /**
   * Unit direction to push a sphere centre out of a contact, into `normalX/Y/Z`. Reads the
   * closest point the terrain just reported for (x, y, z) at `distance`.
   *
   * Normally that is (centre - closest point): exact for faces, edges and corners, and never
   * degenerate while the centre is off the surface. If the centre is ON the surface, or straight
   * BEHIND the closest face (inside the rock: a bad spawn), the face normal is used instead,
   * which moves it to the front of that face.
   */
  private contactNormal(
    terrain: TerrainBvh,
    x: number,
    y: number,
    z: number,
    distance: number,
  ): void {
    const o = terrain.closestTriangle;
    const faceX = terrain.faceNormalX(o);
    const faceY = terrain.faceNormalY(o);
    const faceZ = terrain.faceNormalZ(o);
    const offsetX = x - terrain.closestX;
    const offsetY = y - terrain.closestY;
    const offsetZ = z - terrain.closestZ;
    const facing = offsetX * faceX + offsetY * faceY + offsetZ * faceZ;
    if (distance > EPSILON && facing > -BEHIND_FACE_COS * distance) {
      const inverse = 1 / distance;
      this.normalX = offsetX * inverse;
      this.normalY = offsetY * inverse;
      this.normalZ = offsetZ * inverse;
    } else {
      this.normalX = faceX;
      this.normalY = faceY;
      this.normalZ = faceZ;
    }
  }

  /**
   * `finalizeDragon` clamps the pitch, which can bend a steep reflected path back toward the
   * surface it left (a bounce straight up off a ledge, say). If the clamped nose would not point
   * away from the surface, turn it to face along the surface normal instead.
   */
  private pointNoseAway(
    dragon: DragonState,
    normalX: number,
    normalY: number,
    normalZ: number,
    flight: FlightTuning,
  ): void {
    const pitch = clamp(
      dragon.pitch,
      -pitchLimit(flight.maxDivePitch),
      pitchLimit(flight.maxClimbPitch),
    );
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const away =
      Math.sin(dragon.yaw) * cosPitch * normalX +
      sinPitch * normalY +
      Math.cos(dragon.yaw) * cosPitch * normalZ;
    if (away >= MIN_AWAY_COS) return;

    const normalH = Math.sqrt(normalX * normalX + normalZ * normalZ);
    if (normalH > MIN_AWAY_COS) {
      dragon.yaw = Math.atan2(normalX, normalZ);
      // Facing along the normal's heading; drop the pitch too if it still works against it.
      dragon.pitch = cosPitch * normalH + sinPitch * normalY >= MIN_AWAY_COS ? pitch : 0;
    } else if (normalY > 0) {
      dragon.pitch = pitch > VERTICAL_BOUNCE_PITCH ? pitch : VERTICAL_BOUNCE_PITCH;
    } else {
      dragon.pitch = pitch < -VERTICAL_BOUNCE_PITCH ? pitch : -VERTICAL_BOUNCE_PITCH;
    }
  }

  // --- Storm wall -------------------------------------------------------------------------------

  /**
   * The hard limit past the floor and the ceiling: holds a living dragon at
   * `stormVerticalMaxDepth` and takes the outward part out of its motion (nose levelled, no
   * outward burst), so the push of `resolveStorm` is all that is left. Dead bodies fall through.
   */
  private limitStormDepth(dragon: DragonState): void {
    if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0) return;
    const maxDepth = positive(this.tuning.stormVerticalMaxDepth);
    if (!(maxDepth > 0)) return;
    const position = dragon.position;
    // Each comparison is false for a NaN bound, which then simply does not exist.
    if (position.y < this.floorY - maxDepth) {
      position.y = this.floorY - maxDepth;
      if (dragon.pitch < 0) dragon.pitch = 0;
      if (dragon.pitchRate < 0) dragon.pitchRate = 0;
      if (dragon.burst.y < 0) dragon.burst.y = 0;
    } else if (position.y > this.ceilingY + maxDepth) {
      position.y = this.ceilingY + maxDepth;
      if (dragon.pitch > 0) dragon.pitch = 0;
      if (dragon.pitchRate > 0) dragon.pitchRate = 0;
      if (dragon.burst.y > 0) dragon.burst.y = 0;
    }
  }

  private resolveStorm(dragon: DragonState, dtS: number): void {
    if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0) {
      dragon.flags &= ~DRAGON_FLAG_IN_STORM;
      return;
    }
    const position = dragon.position;
    const offsetX = position.x - this.stormCenterX;
    const offsetZ = position.z - this.stormCenterZ;
    const horizontal = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
    const outside = horizontal - this.stormRadius;
    const above = position.y - this.ceilingY;
    const below = this.floorY - position.y;

    // Each comparison is false for a NaN bound, which then simply does not exist.
    if (!(outside > 0) && !(above > 0) && !(below > 0)) {
      dragon.flags &= ~DRAGON_FLAG_IN_STORM;
      return;
    }
    dragon.flags |= DRAGON_FLAG_IN_STORM;
    if (!(dtS > 0)) return;

    const tuning = this.tuning;
    const pushAccel = positive(this.match.stormPushAccel);
    const depthScale = positive(tuning.stormPushDepthScale);
    const steerRate = positive(tuning.stormSteerRate);
    const steerDepth = positive(tuning.stormSteerFullDepth);
    const burst = dragon.burst;

    if (outside > 0 && horizontal > EPSILON) {
      const push = pushAccel * (depthScale > 0 ? 1 + outside / depthScale : 1) * dtS;
      burst.x -= (offsetX / horizontal) * push;
      burst.z -= (offsetZ / horizontal) * push;
      // Turn the nose toward the centre, at most `turn` this tick.
      const turn = steerRate * (steerDepth > 0 ? clamp(outside / steerDepth, 0, 1) : 1) * dtS;
      const error = wrapAngle(Math.atan2(-offsetX, -offsetZ) - dragon.yaw);
      dragon.yaw = wrapAngle(dragon.yaw + clamp(error, -turn, turn));
    }
    if (above > 0) {
      burst.y -= pushAccel * (depthScale > 0 ? 1 + above / depthScale : 1) * dtS;
      // Level a climbing nose.
      const turn = steerRate * (steerDepth > 0 ? clamp(above / steerDepth, 0, 1) : 1) * dtS;
      if (dragon.pitch > 0) dragon.pitch -= dragon.pitch < turn ? dragon.pitch : turn;
    } else if (below > 0) {
      burst.y += pushAccel * (depthScale > 0 ? 1 + below / depthScale : 1) * dtS;
      // Level a diving nose.
      const turn = steerRate * (steerDepth > 0 ? clamp(below / steerDepth, 0, 1) : 1) * dtS;
      if (dragon.pitch < 0) dragon.pitch += -dragon.pitch < turn ? -dragon.pitch : turn;
    }

    // Damage over time, written straight to health: no hit flash every tick, and the terrain
    // re-hit grace is not held open by the storm. Death is applied by finalizeDragon.
    if (dragon.spawnProtectTicks <= 0) {
      const damage = positive(this.match.stormDamagePerS) * dtS;
      const applied = dragon.health > damage ? damage : dragon.health;
      dragon.health -= applied;
      if (applied > 0) {
        dragon.envDamage += applied;
        if (dragon.envSource === ENV_SOURCE_NONE) dragon.envSource = ENV_SOURCE_STORM;
      }
    }
  }
}

/**
 * Builds the collision world for a map: triangulates its solids (the same triangles the view
 * draws), builds the BVH and reads the storm bounds from `map.colliders`. Load-time only (it
 * allocates). Pass the result to `createSim({ collisionWorld })` or `sim.setCollisionWorld`.
 */
export function createMapCollisionWorld(
  map: CollisionMapSource,
  options: MapCollisionOptions = {},
): MapCollisionWorld {
  return new MapCollisionWorld(map, options);
}
