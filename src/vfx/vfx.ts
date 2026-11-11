/**
 * The effects view (T-3.5). It reads ONLY the shared contracts: the frame's WorldView (dragon
 * flags, projectiles, zones) and GameEvents (casts, hits, takedowns, spawns, statuses, impacts).
 * It never decides anything: every effect is a picture of something the host already decided.
 *
 * Draw calls (each hidden while it has nothing to draw), at most four:
 *   1. particles        one instanced quad batch, GPU-simulated, capped per preset
 *   2. frame sprites    the same program: bolts, bombs, mines, charge glows (rewritten per frame)
 *   3. beams            lightning strips
 *   4. shells           zone and shield volumes
 *
 * Per frame, in `src/game`:
 *   bus.flush()                      -> `onEvent` (or `connect(bus)` once)
 *   vfx.update(view, timeS, dtS, camera)   after the WorldView is built and the camera is placed
 *
 * Nothing allocates after `createVfx`.
 */

import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGFormat,
  UnsignedByteType,
} from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import {
  ABILITY_SLOTS,
  ABILITY_TABLE,
  CLASS_TUNING,
  COMBAT_TUNING,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BLINDED,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_BURNING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_HASTED,
  DRAGON_FLAG_IN_STORM,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_REGEN,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SLOWED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  NO_PLAYER,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  ZONE_KINDS,
} from '../shared';
import type {
  AbilitySlot,
  DragonClassId,
  DragonView,
  GameEvent,
  GameEventSource,
  PlayerId,
  QualityPreset,
  TeamId,
  TerrainQuery,
  Unsubscribe,
  Vec3,
  WorldView,
} from '../shared';
import {
  ATLAS_CELL_SIZE,
  ATLAS_COLUMNS,
  ATLAS_ROWS,
  SPRITE_DOT,
  SPRITE_FLAKE,
  generateEffectAtlas,
} from './atlas';
import { BeamBatch } from './beams';
import { Emitter, VFX_QUALITY } from './emitter';
import type { EmitterRecipe, VfxQuality } from './emitter';
import { COLOR_GLOW, COLOR_HOT, COLOR_TEAM, PALETTE, paletteOffset } from './palette';
import type { ColorRole } from './palette';
import {
  PARTICLE_STRIDE,
  P_ANCHOR,
  P_ASPECT,
  P_B0,
  P_B1,
  P_BIRTH,
  P_BLEND,
  P_DRAG,
  P_FADE_IN,
  P_FADE_OUT,
  P_G0,
  P_G1,
  P_GRAVITY,
  P_LIFE,
  P_R0,
  P_R1,
  P_ROTATION,
  P_SIZE_END,
  P_SIZE_START,
  P_SPIN,
  P_SPRITE_SEED,
  P_STRETCH,
  P_TURBULENCE,
  P_VX,
  P_VY,
  P_VZ,
  P_X,
  P_Y,
  P_Z,
  ParticlePool,
  packBlend,
} from './particle-pool';
import {
  BEAM_STYLES,
  PROJECTILE_SPRITES,
  PROJECTILE_TRAILS,
  RECIPES,
  SPAWN_EFFECT,
  TAKEDOWN_EFFECT,
  ZONE_STYLES,
  castEffectFor,
  hitEffectFor,
  hitScale,
  impactEffectFor,
  statusEffectFor,
} from './recipes';
import { hash01, nextFloat } from './rng';
import { ShellBatch } from './shells';
import { SpriteLayer, createSpriteMaterial, createVfxUniforms } from './sprite-layer';

/** Per-frame sprites (3 per bolt, and a 5v5 holds about 65 bolts in the air). */
export const FRAME_SPRITE_CAPACITY = 320;
/** Below this health fraction a dragon trails smoke. */
export const LOW_HEALTH_FRACTION = 0.35;
/** A local shot's host echo is skipped if it arrives within this long (docs/NETWORKING.md). */
export const LOCAL_SHOT_DEDUPE_S = 1;
/** A beam is cut to the point of a `hit` that follows its cast within this long. */
const BEAM_HIT_WINDOW_S = 0.15;
/** A dragon not in the view for this many frames is "unknown" to event effects. */
const STALE_FRAMES = 30;
/** Streams run at this fraction of their rate beyond LOD_NEAR_M / LOD_FAR_M from the camera. */
const LOD_NEAR_M = 150;
const LOD_FAR_M = 400;
const LOD_MID_RATE = 0.6;
const LOD_FAR_RATE = 0.35;
/** The muzzle sits this far in front of the hit sphere. */
const MUZZLE_GAP_M = 1.5;
const MAX_FRAME_DT_S = 0.1;
/** Bolts and glows: mostly "over" so they keep their team colour against a bright sky. */
const FRAME_SPRITE_BLEND = packBlend(1, 0.25);
const IDS = 256;
const MAX_TRACKED_ZONES = 64;

const RENDER_ORDER_SHELLS = 10;
const RENDER_ORDER_BEAMS = 11;
const RENDER_ORDER_PARTICLES = 12;
const RENDER_ORDER_SPRITES = 13;

export interface VfxOptions {
  readonly scene: Scene;
  readonly quality: QualityPreset;
  /** Lets beams stop at rock. Without it a lance is drawn to its full range or to its hit. */
  readonly terrain?: TerrainQuery | null;
  /** Seed of the effect variation. */
  readonly seed?: number;
}

/** Live numbers for the perf HUD. One object, mutated in place. */
export interface VfxStats {
  /** Particles alive now, and the preset's hard cap. */
  aliveParticles: number;
  particleCapacity: number;
  /** Bolts, bombs, mines and glows drawn this frame. */
  frameSprites: number;
  beams: number;
  shells: number;
  /** Draw calls the effects cost this frame (0..4). */
  drawCalls: number;
  /** Particles spawned since creation. */
  spawned: number;
}

export interface Vfx {
  readonly stats: Readonly<VfxStats>;
  /**
   * One frame. `timeS` is unused for motion (the effects keep their own clock from `dtS`, which
   * stays precise in a float32 and cannot jump): it is accepted so callers pass the same
   * arguments to every view. `camera` must already be placed for this frame.
   */
  update(view: WorldView, timeS: number, dtS: number, camera: Camera): void;
  /** A game event (from `GameEventSource` handlers or forwarded by hand). */
  onEvent(event: GameEvent): void;
  /** Subscribes `onEvent` to every event type it uses. Returns the unsubscribe function. */
  connect(source: GameEventSource): Unsubscribe;
  /**
   * The local rider's own cast, shown at once (docs/NETWORKING.md: "the client shows its own
   * shot instantly"). The host's `abilityCast` echo for the same slot is then skipped once.
   * Only clients call this; on the host the event is already immediate.
   */
  spawnLocalShot(classId: DragonClassId, slot: AbilitySlot, origin: Vec3, direction: Vec3): void;
  setQuality(preset: QualityPreset): void;
  /** Drops every live effect (scene change, round reset). */
  clear(): void;
  /** Compiles the effect shaders now (loading screen), so the first shot does not hitch. */
  warmUp(renderer: WebGLRenderer, camera: Camera): void;
  dispose(): void;
}

function classIndex(classId: DragonClassId): number {
  return DRAGON_CLASS_IDS.indexOf(classId);
}

export function createVfx(options: VfxOptions): Vfx {
  const scene = options.scene;
  const terrain = options.terrain ?? null;
  let quality: VfxQuality = VFX_QUALITY[options.quality.id];

  // --- GPU objects -------------------------------------------------------------------------------
  const atlas = new DataTexture(
    generateEffectAtlas(ATLAS_CELL_SIZE),
    ATLAS_COLUMNS * ATLAS_CELL_SIZE,
    ATLAS_ROWS * ATLAS_CELL_SIZE,
    RGFormat,
    UnsignedByteType,
  );
  atlas.magFilter = LinearFilter;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.needsUpdate = true;

  const uniforms = createVfxUniforms();
  uniforms.uMaxScreen.value = quality.maxScreenSize;
  const material = createSpriteMaterial(atlas, uniforms);

  const pool = new ParticlePool(QUALITY_PRESETS.high.maxParticles, options.quality.maxParticles);
  const em = new Emitter(pool, options.seed ?? 0x5eed);
  em.countScale = quality.countScale;
  em.sizeScale = quality.sizeScale;
  const particles = new SpriteLayer(pool.data, material, 'VfxParticles', RENDER_ORDER_PARTICLES);
  particles.setInstanceCount(pool.capacity);
  particles.mesh.visible = false;

  const frameData = new Float32Array(FRAME_SPRITE_CAPACITY * PARTICLE_STRIDE);
  const frameSprites = new SpriteLayer(
    frameData,
    material,
    'VfxFrameSprites',
    RENDER_ORDER_SPRITES,
  );
  frameSprites.mesh.visible = false;
  let frameCount = 0;

  const beams = new BeamBatch(uniforms, RENDER_ORDER_BEAMS);
  const shells = new ShellBatch(uniforms, RENDER_ORDER_SHELLS);
  scene.add(shells.mesh, beams.mesh, particles.mesh, frameSprites.mesh);

  // --- What the last frames said about each dragon, by id ----------------------------------------
  const dFlags = new Uint16Array(IDS);
  const dSeen = new Int32Array(IDS).fill(-1_000_000);
  const dTeam = new Uint8Array(IDS);
  const dClass = new Uint8Array(IDS).fill(255);
  const dPos = new Float32Array(IDS * 3);
  const dVel = new Float32Array(IDS * 3);
  const dChargeStart = new Float32Array(IDS);

  // --- Last frame's zones ------------------------------------------------------------------------
  const zId = new Int32Array(MAX_TRACKED_ZONES);
  const zKind = new Uint8Array(MAX_TRACKED_ZONES);
  const zOwner = new Uint8Array(MAX_TRACKED_ZONES);
  const zPos = new Float32Array(MAX_TRACKED_ZONES * 4);
  const zPrevId = new Int32Array(MAX_TRACKED_ZONES);
  let zCount = 0;
  let zPrevCount = 0;
  const THUNDERHEAD = ZONE_KINDS.indexOf('thunderhead');

  // --- Local shot prediction ---------------------------------------------------------------------
  const localPending = new Uint8Array(ABILITY_SLOTS.length);
  const localPendingAt = new Float32Array(ABILITY_SLOTS.length);
  let localId: PlayerId = NO_PLAYER;

  let clock = 0;
  let frame = 0;
  let needsFullUpload = true;
  let disposed = false;

  const stats: VfxStats = {
    aliveParticles: 0,
    particleCapacity: pool.capacity,
    frameSprites: 0,
    beams: 0,
    shells: 0,
    drawCalls: 0,
    spawned: 0,
  };

  function known(id: PlayerId): boolean {
    return id !== NO_PLAYER && frame - (dSeen[id] ?? -1_000_000) <= STALE_FRAMES;
  }

  function teamOf(id: PlayerId): TeamId {
    return id !== NO_PLAYER && dTeam[id] === TEAM_FROST ? TEAM_FROST : TEAM_EMBER;
  }

  function classOf(id: PlayerId): DragonClassId | null {
    if (id === NO_PLAYER) return null;
    return DRAGON_CLASS_IDS[dClass[id] ?? 255] ?? null;
  }

  /** The emitter's source becomes dragon `id` (if it is in view), for `inherit`. */
  function sourceFromDragon(id: PlayerId): void {
    if (known(id)) {
      em.setSource(dVel[id * 3] ?? 0, dVel[id * 3 + 1] ?? 0, dVel[id * 3 + 2] ?? 0, 0);
    } else {
      em.clearSource();
    }
  }

  function burstAll(
    list: readonly EmitterRecipe[],
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    team: TeamId,
    size: number,
    count: number,
  ): void {
    for (let i = 0; i < list.length; i++) {
      const recipe = list[i];
      if (recipe !== undefined) em.burst(recipe, x, y, z, dx, dy, dz, team, size, count);
    }
  }

  /** One sprite for this frame only (see FRAME_SPRITE_CAPACITY). */
  function frameSprite(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    sprite: number,
    size: number,
    length: number,
    anchor: number,
    rotation: number,
    team: TeamId,
    role: ColorRole,
    intensity: number,
    seed: number,
  ): void {
    if (frameCount >= FRAME_SPRITE_CAPACITY) return;
    const data = frameData;
    const o = frameCount * PARTICLE_STRIDE;
    frameCount++;
    const c = paletteOffset(team, role);
    const r = (PALETTE[c] ?? 0) * intensity;
    const g = (PALETTE[c + 1] ?? 0) * intensity;
    const b = (PALETTE[c + 2] ?? 0) * intensity;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const stretched = length > size && speed > 0.01;
    data[o + P_X] = x;
    data[o + P_Y] = y;
    data[o + P_Z] = z;
    // Born this instant: the shader sees age 0, so the sprite sits exactly here.
    data[o + P_BIRTH] = clock;
    data[o + P_VX] = vx;
    data[o + P_VY] = vy;
    data[o + P_VZ] = vz;
    data[o + P_LIFE] = 1;
    data[o + P_SIZE_START] = size;
    data[o + P_SIZE_END] = size;
    data[o + P_ROTATION] = rotation;
    data[o + P_SPIN] = 0;
    data[o + P_DRAG] = 0;
    data[o + P_GRAVITY] = 0;
    data[o + P_TURBULENCE] = 0;
    data[o + P_STRETCH] = stretched ? (length / size - 1) / speed : 0;
    data[o + P_R0] = r;
    data[o + P_G0] = g;
    data[o + P_B0] = b;
    data[o + P_BLEND] = FRAME_SPRITE_BLEND;
    data[o + P_R1] = r;
    data[o + P_G1] = g;
    data[o + P_B1] = b;
    data[o + P_SPRITE_SEED] = sprite + seed * 0.998;
    data[o + P_FADE_IN] = 0;
    data[o + P_FADE_OUT] = 0.99;
    data[o + P_ANCHOR] = anchor;
    data[o + P_ASPECT] = 1;
  }

  // --- Events ------------------------------------------------------------------------------------

  function playCast(
    dragonId: PlayerId,
    classId: DragonClassId,
    slot: AbilitySlot,
    team: TeamId,
    position: Vec3,
    direction: Vec3,
  ): void {
    const effect = castEffectFor(classId, slot);
    const reach = effect.centred ? 0 : CLASS_TUNING[classId].hitRadius + MUZZLE_GAP_M;
    const x = position.x + direction.x * reach;
    const y = position.y + direction.y * reach;
    const z = position.z + direction.z * reach;
    sourceFromDragon(dragonId);
    burstAll(effect.bursts, x, y, z, direction.x, direction.y, direction.z, team, 1, 1);
    em.clearSource();
    if (effect.beam !== null) {
      let range = ABILITY_TABLE[classId][slot].range;
      if (terrain !== null) {
        const hit = terrain.raycast(x, y, z, direction.x, direction.y, direction.z, range);
        if (hit >= 0) range = hit;
      }
      beams.spawn(
        effect.beam,
        clock,
        em.rng,
        dragonId,
        team,
        x,
        y,
        z,
        x + direction.x * range,
        y + direction.y * range,
        z + direction.z * range,
      );
    }
  }

  /** A thunderhead of `ownerId` that reaches the point, as an index into the zone cache, or -1. */
  function thunderheadOver(ownerId: PlayerId, x: number, y: number, z: number): number {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < zCount; i++) {
      if (zKind[i] !== THUNDERHEAD || zOwner[i] !== ownerId) continue;
      const dx = x - (zPos[i * 4] ?? 0);
      const dy = y - (zPos[i * 4 + 1] ?? 0);
      const dz = z - (zPos[i * 4 + 2] ?? 0);
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < bestDistance && distance < (zPos[i * 4 + 3] ?? 0) * 1.5) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  function onEvent(event: GameEvent): void {
    if (disposed) return;
    switch (event.type) {
      case 'abilityCast': {
        const slot = ABILITY_SLOTS.indexOf(event.slot);
        if (event.dragonId === localId && localId !== NO_PLAYER && (localPending[slot] ?? 0) > 0) {
          const fresh = clock - (localPendingAt[slot] ?? 0) <= LOCAL_SHOT_DEDUPE_S;
          // A stale prediction is forgotten, and this event is drawn as usual.
          localPending[slot] = fresh ? (localPending[slot] ?? 1) - 1 : 0;
          if (fresh) return;
        }
        if (dClass[event.dragonId] === 255) dClass[event.dragonId] = classIndex(event.classId);
        playCast(
          event.dragonId,
          event.classId,
          event.slot,
          teamOf(event.dragonId),
          event.position,
          event.direction,
        );
        return;
      }
      case 'hit': {
        const attacker = event.attackerId;
        const position = event.position;
        let dx = 0;
        let dy = 1;
        let dz = 0;
        if (known(attacker)) {
          dx = position.x - (dPos[attacker * 3] ?? 0);
          dy = position.y - (dPos[attacker * 3 + 1] ?? 0);
          dz = position.z - (dPos[attacker * 3 + 2] ?? 0);
        }
        const attackerClass = classOf(attacker);
        const scale = hitScale(event.damage);
        // The attacker's colour says who did it; the environment has its own colours.
        const team = attacker === NO_PLAYER ? teamOf(event.targetId) : teamOf(attacker);
        sourceFromDragon(event.targetId);
        burstAll(
          hitEffectFor(event.source, attackerClass),
          position.x,
          position.y,
          position.z,
          dx,
          dy,
          dz,
          team,
          0.7 + 0.3 * scale,
          scale,
        );
        em.clearSource();
        if (attackerClass === 'tempest' && event.source === 'primary') {
          beams.shorten(attacker, clock, BEAM_HIT_WINDOW_S, position.x, position.y, position.z);
        } else if (attackerClass === 'tempest' && event.source === 'ultimate') {
          const cloud = thunderheadOver(attacker, position.x, position.y, position.z);
          if (cloud >= 0) {
            const radius = zPos[cloud * 4 + 3] ?? 0;
            beams.spawn(
              BEAM_STYLES.zap,
              clock,
              em.rng,
              NO_PLAYER,
              team,
              (zPos[cloud * 4] ?? 0) + (nextFloat(em.rng) - 0.5) * radius * 0.5,
              (zPos[cloud * 4 + 1] ?? 0) + radius * 0.45,
              (zPos[cloud * 4 + 2] ?? 0) + (nextFloat(em.rng) - 0.5) * radius * 0.5,
              position.x,
              position.y,
              position.z,
            );
          }
        }
        return;
      }
      case 'takedown': {
        const position = event.position;
        sourceFromDragon(event.victimId);
        burstAll(
          TAKEDOWN_EFFECT,
          position.x,
          position.y,
          position.z,
          0,
          1,
          0,
          teamOf(event.victimId),
          1,
          1,
        );
        em.clearSource();
        return;
      }
      case 'spawn': {
        dTeam[event.dragonId] = event.team;
        dClass[event.dragonId] = classIndex(event.classId);
        const position = event.position;
        sourceFromDragon(event.dragonId);
        burstAll(SPAWN_EFFECT, position.x, position.y, position.z, 0, 1, 0, event.team, 1, 1);
        em.clearSource();
        return;
      }
      case 'statusApplied': {
        const list = statusEffectFor(event.status);
        if (list.length === 0) return;
        const position = event.position;
        sourceFromDragon(event.targetId);
        burstAll(
          list,
          position.x,
          position.y,
          position.z,
          0,
          1,
          0,
          teamOf(event.sourceId === NO_PLAYER ? event.targetId : event.sourceId),
          1,
          1,
        );
        em.clearSource();
        return;
      }
      case 'impact': {
        const position = event.position;
        em.clearSource();
        burstAll(
          impactEffectFor(event.projectile),
          position.x,
          position.y,
          position.z,
          0,
          1,
          0,
          teamOf(event.ownerId),
          1,
          1,
        );
        return;
      }
      default:
        return;
    }
  }

  // --- Per frame: dragons ------------------------------------------------------------------------

  function updateDragon(dragon: DragonView, dtS: number, cx: number, cy: number, cz: number): void {
    const id = dragon.id;
    if (id < 0 || id >= IDS) return;
    const flags = dragon.flags;
    const team = dragon.team;
    const other: TeamId = team === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
    const position = dragon.position;
    const velocity = dragon.velocity;
    const q = dragon.orientation;
    const px = position.x;
    const py = position.y;
    const pz = position.z;
    // Nose direction: +Z turned by the orientation.
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fy = 2 * (q.y * q.z - q.w * q.x);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const hitRadius = CLASS_TUNING[dragon.classId].hitRadius;

    const wasSeen = dSeen[id] === frame - 1;
    const before = wasSeen ? (dFlags[id] ?? 0) : flags;
    const rising = flags & ~before;
    const falling = before & ~flags;

    const ddx = px - cx;
    const ddy = py - cy;
    const ddz = pz - cz;
    const distance = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    const cosmetic = distance < quality.cosmeticRange;
    const rate = distance < LOD_NEAR_M ? 1 : distance < LOD_FAR_M ? LOD_MID_RATE : LOD_FAR_RATE;

    em.setSource(velocity.x, velocity.y, velocity.z, dtS);
    const tail = hitRadius * 1.3;
    const tx = px - fx * tail;
    const ty = py - fy * tail;
    const tz = pz - fz * tail;
    const reach = hitRadius + MUZZLE_GAP_M;
    const mx = px + fx * reach;
    const my = py + fy * reach;
    const mz = pz + fz * reach;

    if ((flags & DRAGON_FLAG_ALIVE) === 0) {
      if (cosmetic) {
        em.stream(RECIPES.wreckSmoke, dtS, px, py, pz, 0, 1, 0, team, 1, rate);
        em.stream(RECIPES.wreckEmbers, dtS, px, py, pz, 0, 1, 0, team, 1, rate);
      }
    } else {
      if ((flags & DRAGON_FLAG_BOOSTING) !== 0) {
        em.stream(RECIPES.boostTrail, dtS, tx, ty, tz, fx, fy, fz, team, 1, rate);
      }
      if ((flags & DRAGON_FLAG_HASTED) !== 0) {
        em.stream(RECIPES.hasteTrail, dtS, tx, ty, tz, fx, fy, fz, team, 1, rate);
      }
      if ((flags & DRAGON_FLAG_FIRING) !== 0) {
        if (dragon.classId === 'bastion') {
          em.stream(RECIPES.flameCone, dtS, mx, my, mz, fx, fy, fz, team, 1, rate);
          em.stream(RECIPES.flameConeSparks, dtS, mx, my, mz, fx, fy, fz, team, 1, rate);
        } else if (dragon.classId === 'wraith') {
          em.stream(RECIPES.shadeBreath, dtS, mx, my, mz, fx, fy, fz, team, 1, rate);
          em.stream(RECIPES.shadeGlints, dtS, mx, my, mz, fx, fy, fz, team, 1, rate);
        }
      }
      if ((flags & DRAGON_FLAG_PHASING) !== 0) {
        em.stream(RECIPES.phaseGhost, dtS, px, py, pz, -fx, -fy, -fz, team, 1, rate);
        em.stream(RECIPES.phaseGlints, dtS, px, py, pz, 0, 1, 0, team, 1, rate);
      }
      if ((flags & DRAGON_FLAG_CHARGING) !== 0) {
        if ((rising & DRAGON_FLAG_CHARGING) !== 0 || !wasSeen) dChargeStart[id] = clock;
        const charged = Math.min(1, (clock - (dChargeStart[id] ?? clock)) / 0.5);
        const seed = hash01(id);
        frameSprite(
          mx,
          my,
          mz,
          0,
          0,
          0,
          SPRITE_DOT,
          0.9 + 1.8 * charged,
          0,
          0,
          0,
          team,
          COLOR_TEAM,
          0.9 + charged,
          seed,
        );
        if (dragon.classId === 'tempest') {
          frameSprite(
            mx,
            my,
            mz,
            0,
            0,
            0,
            SPRITE_FLAKE,
            1 + 1.6 * charged,
            0,
            0,
            clock * 11,
            team,
            COLOR_HOT,
            2,
            seed,
          );
          em.stream(RECIPES.chargeFlakes, dtS, mx, my, mz, fx, fy, fz, team, 1, rate);
        }
      }
      if ((rising & DRAGON_FLAG_DODGING) !== 0) {
        em.burst(RECIPES.dodgeSwirl, px, py, pz, fx, fy, fz, team);
      }
      if ((falling & DRAGON_FLAG_VEILED) !== 0) {
        em.burst(RECIPES.veilGlints, px, py, pz, fx, fy, fz, team);
      }
      if ((flags & DRAGON_FLAG_SHIELDED) !== 0) {
        shells.add(
          px + fx * hitRadius * 0.4,
          py + fy * hitRadius * 0.4,
          pz + fz * hitRadius * 0.4,
          hitRadius * 2.5,
          q,
          team,
          COLOR_TEAM,
          0.9,
          Math.cos(COMBAT_TUNING.shieldHalfAngle),
          2,
          0.1,
          true,
        );
      }
      if ((flags & DRAGON_FLAG_SPAWN_PROTECTED) !== 0) {
        shells.add(px, py, pz, hitRadius * 2.4, null, team, COLOR_GLOW, 0.55, -1, 5, 0.01, false);
      }
      if (cosmetic) {
        if ((flags & DRAGON_FLAG_VEILED) !== 0) {
          em.stream(RECIPES.veilShimmer, dtS, px, py, pz, 0, 1, 0, team, 1, rate);
        }
        if ((flags & DRAGON_FLAG_IN_STORM) !== 0) {
          em.stream(RECIPES.stormCrackle, dtS, px, py, pz, 0, 1, 0, team, 1, rate);
        }
        if ((flags & DRAGON_FLAG_BURNING) !== 0) {
          em.stream(RECIPES.burnWisps, dtS, px, py, pz, 0, 1, 0, other, 1, rate);
        }
        if ((flags & DRAGON_FLAG_SLOWED) !== 0) {
          em.stream(RECIPES.slowFlakes, dtS, px, py, pz, 0, 1, 0, other, 1, rate);
        }
        if ((flags & DRAGON_FLAG_BLINDED) !== 0) {
          em.stream(RECIPES.blindShade, dtS, mx, my, mz, 0, 1, 0, other, 1, rate);
        }
        if ((flags & DRAGON_FLAG_REGEN) !== 0) {
          em.stream(RECIPES.regenMotes, dtS, px, py, pz, 0, 1, 0, team, 1, rate);
        }
        if (dragon.health < LOW_HEALTH_FRACTION) {
          const severity = 1 + (LOW_HEALTH_FRACTION - dragon.health) / LOW_HEALTH_FRACTION;
          em.stream(RECIPES.lowHealthSmoke, dtS, tx, ty, tz, 0, 1, 0, team, 1, rate * severity);
        }
      }
    }

    dFlags[id] = flags;
    dSeen[id] = frame;
    dTeam[id] = team;
    dClass[id] = classIndex(dragon.classId);
    dPos[id * 3] = px;
    dPos[id * 3 + 1] = py;
    dPos[id * 3 + 2] = pz;
    dVel[id * 3] = velocity.x;
    dVel[id * 3 + 1] = velocity.y;
    dVel[id * 3 + 2] = velocity.z;
  }

  // --- Per frame: projectiles and zones ----------------------------------------------------------

  function updateProjectiles(
    view: WorldView,
    dtS: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    for (let i = 0; i < view.projectileCount; i++) {
      const projectile = view.projectiles[i];
      if (projectile === undefined) continue;
      const position = projectile.position;
      const velocity = projectile.velocity;
      const dx = position.x - cx;
      const dy = position.y - cy;
      const dz = position.z - cz;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      const seed = hash01(projectile.id);
      const sprites = PROJECTILE_SPRITES[projectile.kind];
      for (let s = 0; s < sprites.length; s++) {
        const def = sprites[s];
        if (def === undefined || distanceSq > def.maxDistance * def.maxDistance) continue;
        frameSprite(
          position.x,
          position.y,
          position.z,
          velocity.x,
          velocity.y,
          velocity.z,
          def.sprite,
          def.size,
          def.length,
          def.anchor,
          def.spin * clock + seed * 6.28,
          projectile.team,
          def.color,
          def.intensity,
          seed,
        );
      }
      const trails = PROJECTILE_TRAILS[projectile.kind];
      if (trails.length > 0) {
        em.setSource(velocity.x, velocity.y, velocity.z, dtS);
        for (let t = 0; t < trails.length; t++) {
          const recipe = trails[t];
          if (recipe === undefined) continue;
          em.stream(
            recipe,
            dtS,
            position.x,
            position.y,
            position.z,
            -velocity.x,
            -velocity.y,
            -velocity.z,
            projectile.team,
          );
        }
      }
    }
    em.clearSource();
  }

  function updateZones(view: WorldView, dtS: number): void {
    for (let i = 0; i < zCount; i++) zPrevId[i] = zId[i] ?? 0;
    zPrevCount = zCount;
    zCount = 0;
    em.clearSource();
    for (let i = 0; i < view.zoneCount; i++) {
      const zone = view.zones[i];
      if (zone === undefined) continue;
      const style = ZONE_STYLES[zone.kind];
      const team: TeamId = zone.team ?? TEAM_EMBER;
      let x = zone.position.x;
      let y = zone.position.y;
      let z = zone.position.z;
      // A following zone (rally aura) is drawn on its owner, where the owner is drawn.
      if (
        zone.kind === 'rallyAura' &&
        zone.ownerId !== NO_PLAYER &&
        dSeen[zone.ownerId] === frame
      ) {
        x = dPos[zone.ownerId * 3] ?? x;
        y = dPos[zone.ownerId * 3 + 1] ?? y;
        z = dPos[zone.ownerId * 3 + 2] ?? z;
      }
      const radius = zone.radius;
      const ending = zone.remainingS < 0.6 ? Math.max(0, zone.remainingS / 0.6) : 1;

      if (zCount < MAX_TRACKED_ZONES) {
        zId[zCount] = zone.id;
        zKind[zCount] = ZONE_KINDS.indexOf(zone.kind);
        zOwner[zCount] = zone.ownerId;
        zPos[zCount * 4] = x;
        zPos[zCount * 4 + 1] = y;
        zPos[zCount * 4 + 2] = z;
        zPos[zCount * 4 + 3] = radius;
        zCount++;
      }
      if (style.shell > 0) {
        shells.add(
          x,
          y,
          z,
          radius,
          null,
          team,
          style.shellColor,
          style.shell * ending,
          -1,
          style.rimPower,
          0.03,
          false,
        );
      }
      const inner = radius * style.interiorRadius;
      const lift = radius * style.interiorLift;
      for (let r = 0; r < style.interior.length; r++) {
        const recipe = style.interior[r];
        if (recipe !== undefined)
          em.stream(recipe, dtS, x, y + lift, z, 0, 1, 0, team, 1, ending, inner);
      }
      if (style.flickerPerS > 0 && nextFloat(em.rng) < style.flickerPerS * dtS * ending) {
        const angle = nextFloat(em.rng) * Math.PI * 2;
        const out = radius * 0.5 * nextFloat(em.rng);
        const sx = x + Math.cos(angle) * out;
        const sz = z + Math.sin(angle) * out;
        beams.spawn(
          BEAM_STYLES.flicker,
          clock,
          em.rng,
          NO_PLAYER,
          team,
          sx,
          y + radius * 0.45,
          sz,
          sx + (nextFloat(em.rng) - 0.5) * radius * 0.6,
          y - radius * (0.2 + 0.4 * nextFloat(em.rng)),
          sz + (nextFloat(em.rng) - 0.5) * radius * 0.6,
        );
      }
      if (style.appear.length > 0 && frame > 0) {
        let seen = false;
        for (let p = 0; p < zPrevCount; p++) {
          if (zPrevId[p] === zone.id) {
            seen = true;
            break;
          }
        }
        if (!seen) burstAll(style.appear, x, y, z, 0, 1, 0, team, 1.6, 1);
      }
    }
  }

  // --- Public ------------------------------------------------------------------------------------

  function applyQuality(preset: QualityPreset): void {
    quality = VFX_QUALITY[preset.id];
    em.countScale = quality.countScale;
    em.sizeScale = quality.sizeScale;
    uniforms.uMaxScreen.value = quality.maxScreenSize;
    if (preset.maxParticles !== pool.capacity) {
      pool.setCapacity(preset.maxParticles);
      particles.setInstanceCount(pool.capacity);
      needsFullUpload = true;
    }
    stats.particleCapacity = pool.capacity;
  }

  const handler = (event: GameEvent): void => onEvent(event);

  return {
    stats,

    update(view: WorldView, _timeS: number, dtS: number, camera: Camera): void {
      if (disposed) return;
      const dt = dtS > 0 ? (dtS < MAX_FRAME_DT_S ? dtS : MAX_FRAME_DT_S) : 0;
      clock += dt;
      uniforms.uTime.value = clock;
      em.time = clock;
      pool.beginFrame(clock);
      localId = view.localDragonId;

      frameCount = 0;
      shells.begin();
      const cx = camera.position.x;
      const cy = camera.position.y;
      const cz = camera.position.z;
      for (let i = 0; i < view.dragonCount; i++) {
        const dragon = view.dragons[i];
        if (dragon !== undefined) updateDragon(dragon, dt, cx, cy, cz);
      }
      em.clearSource();
      updateProjectiles(view, dt, cx, cy, cz);
      updateZones(view, dt);
      shells.end();
      beams.update(clock);

      // Upload what changed.
      if (needsFullUpload) {
        particles.uploadAll();
        needsFullUpload = false;
      } else {
        const runs = pool.dirtyRangeCount;
        if (runs > 0) {
          particles.upload(
            pool.dirtyRangeStart(0),
            pool.dirtyRangeLength(0),
            runs > 1 ? pool.dirtyRangeStart(1) : 0,
            runs > 1 ? pool.dirtyRangeLength(1) : 0,
          );
        }
      }
      pool.clearDirty();
      particles.mesh.visible = pool.alive > 0;
      frameSprites.setInstanceCount(frameCount);
      frameSprites.mesh.visible = frameCount > 0;
      if (frameCount > 0) frameSprites.upload(0, frameCount, 0, 0);

      stats.aliveParticles = pool.alive;
      stats.frameSprites = frameCount;
      stats.beams = beams.alive;
      stats.shells = shells.count;
      stats.spawned = em.spawned;
      stats.drawCalls =
        (particles.mesh.visible ? 1 : 0) +
        (frameSprites.mesh.visible ? 1 : 0) +
        (beams.mesh.visible ? 1 : 0) +
        (shells.mesh.visible ? 1 : 0);
      frame++;
    },

    onEvent,

    connect(source: GameEventSource): Unsubscribe {
      const off = [
        source.on('abilityCast', handler),
        source.on('hit', handler),
        source.on('takedown', handler),
        source.on('spawn', handler),
        source.on('statusApplied', handler),
        source.on('impact', handler),
      ];
      return () => {
        for (const unsubscribe of off) unsubscribe();
      };
    },

    spawnLocalShot(classId: DragonClassId, slot: AbilitySlot, origin: Vec3, direction: Vec3): void {
      if (disposed) return;
      const index = ABILITY_SLOTS.indexOf(slot);
      if (index < 0) return;
      // An echo that never came (the host refused the cast) must not eat a later event.
      if (clock - (localPendingAt[index] ?? 0) > LOCAL_SHOT_DEDUPE_S) localPending[index] = 0;
      if ((localPending[index] ?? 0) < 255) localPending[index] = (localPending[index] ?? 0) + 1;
      localPendingAt[index] = clock;
      const team = localId !== NO_PLAYER ? teamOf(localId) : TEAM_EMBER;
      playCast(localId, classId, slot, team, origin, direction);
    },

    setQuality(preset: QualityPreset): void {
      if (disposed) return;
      applyQuality(preset);
    },

    clear(): void {
      pool.clear();
      beams.clear();
      needsFullUpload = true;
      localPending.fill(0);
      dSeen.fill(-1_000_000);
      zCount = 0;
    },

    warmUp(renderer: WebGLRenderer, camera: Camera): void {
      if (disposed) return;
      const meshes = [particles.mesh, frameSprites.mesh, beams.mesh, shells.mesh];
      const shown = meshes.map((mesh) => mesh.visible);
      for (const mesh of meshes) mesh.visible = true;
      renderer.compile(scene, camera);
      meshes.forEach((mesh, i) => {
        mesh.visible = shown[i] ?? false;
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(shells.mesh, beams.mesh, particles.mesh, frameSprites.mesh);
      particles.dispose();
      frameSprites.dispose();
      beams.dispose();
      shells.dispose();
      material.dispose();
      atlas.dispose();
    },
  };
}
