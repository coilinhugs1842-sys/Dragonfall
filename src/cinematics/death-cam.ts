/**
 * The death cam (T-5.5): while the local dragon is down, a slow orbit round whoever got the
 * takedown, for MATCH_TUNING.deathCamS from the moment it went down. After that `direct`
 * returns false and the chase rig, which followed the killer underneath all along, takes over
 * until the respawn (src/game/stage.ts, the death branch of `updateMatch`).
 *
 * WHO MAY BE SHOWN (`deathCamSubject`). The killer is `view.local.killerId`, and only when it is
 * a living dragon of this frame other than the victim. An enemy with DRAGON_FLAG_VEILED is never
 * shown: the veil hides it from the other team, and a camera circling it would give it away. A
 * veiled team mate (friendly fire) may be shown: its own team sees it anyway. With nobody to
 * show (terrain, the storm, a veiled enemy, a spectator) `direct` returns false at once and the
 * stage holds the camera where it was.
 *
 * THE ORBIT. The camera rides along with the killer, so the killer stays in frame at any speed.
 * It starts on the side the victim was on (the first frame is the killer seen from where you
 * fell, the place of death behind the camera) and circles slowly toward the killer's tail, where
 * the chase camera is waiting, closing in a little as it goes. Rock between the killer and the
 * camera pulls the camera in at once; it eases back out when the way is clear.
 *
 * NEVER INSIDE A DRAGON. The victim's falling body is drawn, and a kill at about the orbit's
 * radius puts the starting place right on it; a wing mate of the killer can be there too. Every
 * dragon but the killer has a keep-out sphere (its class's half wingspan plus a clearance) and
 * the camera is moved out of each, up and away: at once on the orbit's first frame (it is a
 * cut), eased afterwards. Round the killer itself the same sphere is kept when rock pulls the
 * camera in: it goes up instead of into the wings. Rock still wins over both.
 *
 * Checked again every frame: a killer that dies, veils or leaves stops the orbit on that frame,
 * a different killer restarts it round the new one (a cut, not a sweep across the map), and the
 * clock keeps running from the fall either way. A respawn, a phase other than `playing` or
 * `roundEnd`, and `reset()` forget everything.
 *
 * REDUCE MOTION: the camera keeps its starting side and distance (no circling, no push-in, no
 * lead); it only travels with the killer, like the chase camera does.
 *
 * Nothing in `direct` allocates.
 */
import type { PerspectiveCamera } from 'three';
import { resolveCameraPull } from '../render';
import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  MATCH_TUNING,
  NO_PLAYER,
  createVec3,
  findDragonView,
} from '../shared';
import type {
  DragonClassId,
  DragonView,
  MutableVec3,
  PlayerId,
  TerrainQuery,
  Vec3,
  WorldView,
} from '../shared';
import {
  aimCamera,
  clamp,
  clamp01,
  dampLookTarget,
  forwardOfQuat,
  lerp,
  setVec3,
  smoothstep,
  wrapAngle,
  writeOrbitPosition,
  yawOfDirection,
} from './camera-math';
import type { DeathCam } from './types';

/** Feel values of the orbit. Metres, radians, seconds; FOV in degrees. Mutable for dev tuning. */
export interface DeathCamTuning {
  /** Level distance from the killer at the start and at the end (a 10 m dragon, 14 m of wing). */
  radiusStart: number;
  radiusEnd: number;
  /** Height above the killer at the start and at the end. */
  heightStart: number;
  heightEnd: number;
  /** The camera aims this far above the killer's origin (its back and rider). */
  lookLift: number;
  /** Slowest and fastest circling, radians per second. */
  minRate: number;
  maxRate: number;
  fovDeg: number;
  /** The view leads the killer by this many seconds of its flight, capped at `maxLead` metres. */
  leadS: number;
  maxLead: number;
  /** How fast the lead follows a change of the killer's velocity (1/s). */
  leadRate: number;
  /** Gap kept between the camera and a terrain hit, and how fast it eases back out (1/s). */
  rockMargin: number;
  rockEaseOutRate: number;
  /** Longest step the orbit and its easing take in one frame (the 3 s clock is not capped). */
  maxDt: number;
  /** Air kept between the camera and the wing tips of any dragon (`DEATH_CAM_HALF_SPAN`). */
  wingClearance: number;
  /** How fast the camera moves out of a dragon's way, and how fast it settles back (1/s). */
  avoidInRate: number;
  avoidOutRate: number;
}

export const DEATH_CAM_TUNING: DeathCamTuning = {
  radiusStart: 34,
  radiusEnd: 18,
  heightStart: 11,
  heightEnd: 4.5,
  lookLift: 1.5,
  minRate: 0.22,
  maxRate: 0.55,
  fovDeg: 48,
  leadS: 0.1,
  maxLead: 6,
  leadRate: 4,
  rockMargin: 1.5,
  rockEaseOutRate: 1.5,
  maxDt: 0.1,
  wingClearance: 2.5,
  avoidInRate: 14,
  avoidOutRate: 2.5,
};

/**
 * Half the wingspan of each class, metres: `wingspan / 2` of
 * public/assets/dragons/<class>/manifest.json, rounded up (tests/cinematics/death-cam-avoid
 * checks them against the files). A table and not the asset library: the camera must not wait
 * for a download, and `src/cinematics` reads no assets.
 */
export const DEATH_CAM_HALF_SPAN: Readonly<Record<DragonClassId, number>> = {
  talon: 6.1,
  wraith: 6.7,
  bastion: 7.9,
  tempest: 7,
  verdant: 7.3,
  aureate: 6.5,
  zephyr: 7.8,
  granite: 6.4,
  mirage: 7.2,
};

/** The sphere round a dragon the death cam stays out of: wings spread, plus the clearance. */
export function deathCamKeepOut(classId: DragonClassId, tuning: DeathCamTuning = DEATH_CAM_TUNING): number {
  return (DEATH_CAM_HALF_SPAN[classId] ?? DEATH_CAM_HALF_SPAN.bastion) + tuning.wingClearance;
}

/**
 * The dragon the death cam may show for this frame's local dragon, or undefined when there is
 * nobody: the local dragon is alive or not in the view (a spectator), there is no killer, the
 * killer is not in the view, is dead, is the victim itself, or is a veiled enemy.
 */
export function deathCamSubject(view: WorldView): DragonView | undefined {
  if (view.localDragonId === NO_PLAYER) return undefined;
  const local = findDragonView(view, view.localDragonId);
  if (local === undefined || (local.flags & DRAGON_FLAG_ALIVE) !== 0) return undefined;
  if (!view.local.valid || view.local.killerId === NO_PLAYER) return undefined;
  const killer = findDragonView(view, view.local.killerId);
  if (killer === undefined || killer.id === local.id) return undefined;
  if ((killer.flags & DRAGON_FLAG_ALIVE) === 0) return undefined;
  // A veiled enemy must never be revealed; a veiled team mate is no secret to its own team.
  if ((killer.flags & DRAGON_FLAG_VEILED) !== 0 && killer.team !== local.team) return undefined;
  return killer;
}

export function createDeathCam(): DeathCam {
  const tuning = DEATH_CAM_TUNING;
  let terrain: TerrainQuery | null = null;
  let reduceMotion = false;

  /** True while the local dragon is down; the clock of this fall. */
  let down = false;
  let downForS = 0;
  /** Where the local dragon was when it went down. */
  const deathPlace = createVec3();

  /** The dragon being circled, or NO_PLAYER while no orbit is running. */
  let orbitId: PlayerId = NO_PLAYER;
  /** Where the camera is round the killer (heading from the killer to the camera). */
  let azimuth = 0;
  /** Radians per second, signed: which way round and how fast. */
  let rate = 0;
  /** `downForS` when this orbit started: its radius and height ease from there. */
  let orbitStartS = 0;
  /** Terrain pull-in: fraction of the killer-to-camera line the camera sits at. */
  let pull = 1;
  /** Look-ahead offset from the killer, eased. */
  const lead = createVec3();
  /** Offset that keeps the camera out of the other dragons, eased. */
  const avoid = createVec3();
  /** The orbit's first frame is a cut: the offset is taken as it is, not eased toward. */
  let avoidFresh = true;

  // Per-frame scratch.
  const forward = createVec3();
  const centre = createVec3();
  const position = createVec3();
  const target = createVec3();
  const wantLead = createVec3();
  const wantAvoid = createVec3();

  let skipped = false;

  function forget(): void {
    down = false;
    downForS = 0;
    orbitId = NO_PLAYER;
    pull = 1;
    skipped = false;
  }

  /**
   * Into `out`: how far `from` (the camera's place on the orbit) has to move to be outside the
   * keep-out sphere of every dragon but the killer. The victim's own falling body is one of
   * them, and the usual one: a kill at the orbit's radius puts the camera's start right on it.
   *
   * The way out of a sphere is away from its dragon with a bias upward, so a camera exactly on
   * a dragon still has a direction to go, and it lands exactly on the sphere, so the offset
   * fades to nothing as the dragon moves off instead of switching off.
   */
  function writeAvoidance(
    out: MutableVec3,
    view: WorldView,
    killer: DragonView,
    local: DragonView,
    from: Vec3,
  ): void {
    setVec3(out, 0, 0, 0);
    for (let i = 0; i < view.dragonCount; i++) {
      const other = view.dragons[i];
      if (other === undefined || other.id === killer.id) continue;
      // A veiled enemy is not drawn for this player, and a camera that swerves round empty air
      // would say where it is.
      if (
        other.team !== local.team &&
        (other.flags & DRAGON_FLAG_VEILED) !== 0 &&
        (other.flags & DRAGON_FLAG_ALIVE) !== 0
      ) {
        continue;
      }
      const keepOut = deathCamKeepOut(other.classId, tuning);
      const dx = from.x - other.position.x;
      const dy = from.y - other.position.y;
      const dz = from.z - other.position.z;
      const gap = keepOut * keepOut - (dx * dx + dy * dy + dz * dz);
      // Outside the sphere (or a position that is not a number): nothing to do.
      if (!(gap > 0)) continue;
      const wayY = dy + keepOut * 0.35;
      const wayLength = Math.sqrt(dx * dx + wayY * wayY + dz * dz);
      const ux = wayLength > 1e-4 ? dx / wayLength : 0;
      const uy = wayLength > 1e-4 ? wayY / wayLength : 1;
      const uz = wayLength > 1e-4 ? dz / wayLength : 0;
      // Distance along that way to the sphere's surface.
      const along = dx * ux + dy * uy + dz * uz;
      const step = Math.sqrt(along * along + gap) - along;
      out.x += ux * step;
      out.y += uy * step;
      out.z += uz * step;
    }
  }

  /** Starts circling `killer`: from the victim's side, turning toward the killer's tail. */
  function startOrbit(killer: DragonView): void {
    orbitId = killer.id;
    orbitStartS = downForS;
    pull = 1;
    setVec3(lead, 0, 0, 0);
    setVec3(avoid, 0, 0, 0);
    avoidFresh = true;

    forwardOfQuat(forward, killer.orientation);
    const tail = yawOfDirection(-forward.x, -forward.z);
    const dx = deathPlace.x - killer.position.x;
    const dz = deathPlace.z - killer.position.z;
    // Straight above or below the killer there is no side to speak of: start at its tail.
    azimuth = dx * dx + dz * dz > 1 ? yawOfDirection(dx, dz) : tail;

    // The short way round to the tail, at a pace that gets most of the way there in the time
    // left, so the chase camera's first frame is not a jump to the far side.
    const swing = wrapAngle(tail - azimuth);
    const leftS = Math.max(MATCH_TUNING.deathCamS - downForS, 0.5);
    const pace = clamp(Math.abs(swing) / leftS, tuning.minRate, tuning.maxRate);
    rate = swing < 0 ? -pace : pace;
  }

  return {
    begin(mapTerrain: TerrainQuery | null): void {
      terrain = mapTerrain;
      forget();
    },

    reset(): void {
      forget();
    },

    requestSkip(): boolean {
      if (!down || skipped) return false;
      skipped = true;
      orbitId = NO_PLAYER;
      return true;
    },

    get active(): boolean {
      return down && !skipped && downForS < MATCH_TUNING.deathCamS;
    },

    setReduceMotion(on: boolean): void {
      reduceMotion = on;
    },

    direct(camera: PerspectiveCamera, view: WorldView | null, dtS: number): boolean {
      if (view === null || (view.clock.phase !== 'playing' && view.clock.phase !== 'roundEnd')) {
        forget();
        return false;
      }
      const local =
        view.localDragonId !== NO_PLAYER ? findDragonView(view, view.localDragonId) : undefined;
      if (local === undefined || (local.flags & DRAGON_FLAG_ALIVE) !== 0) {
        // Alive (or respawned), or a spectator: nothing to show, and the next fall starts fresh.
        forget();
        return false;
      }
      const elapsed = dtS > 0 ? dtS : 0;
      // The orbit never takes a bigger step than this; the 3 s clock counts a hitch in full.
      const dt = elapsed < tuning.maxDt ? elapsed : tuning.maxDt;
      if (!down) {
        down = true;
        downForS = 0;
        setVec3(deathPlace, local.position.x, local.position.y, local.position.z);
      } else {
        downForS += elapsed;
      }
      if (skipped || !(downForS < MATCH_TUNING.deathCamS)) {
        orbitId = NO_PLAYER;
        return false;
      }

      const killer = deathCamSubject(view);
      if (
        killer === undefined ||
        !Number.isFinite(killer.position.x + killer.position.y + killer.position.z)
      ) {
        // Nobody to show this frame. If the killer comes back it is a new orbit (a cut).
        orbitId = NO_PLAYER;
        return false;
      }
      if (killer.id !== orbitId) startOrbit(killer);
      else if (!reduceMotion) azimuth = wrapAngle(azimuth + rate * dt);

      // 0..1 over what was left of the death cam when this orbit started.
      const spanS = Math.max(MATCH_TUNING.deathCamS - orbitStartS, 1e-3);
      const progress = reduceMotion ? 0 : smoothstep(0, 1, clamp01((downForS - orbitStartS) / spanS));
      const radius = lerp(tuning.radiusStart, tuning.radiusEnd, progress);
      const height = lerp(tuning.heightStart, tuning.heightEnd, progress);

      setVec3(centre, killer.position.x, killer.position.y + tuning.lookLift, killer.position.z);
      writeOrbitPosition(position, centre, radius, azimuth, height - tuning.lookLift);

      // Other dragons: out of their way before anything else. In fast, back slowly.
      writeAvoidance(wantAvoid, view, killer, local, position);
      if (avoidFresh) {
        setVec3(avoid, wantAvoid.x, wantAvoid.y, wantAvoid.z);
        avoidFresh = false;
      } else {
        const growing =
          wantAvoid.x * wantAvoid.x + wantAvoid.y * wantAvoid.y + wantAvoid.z * wantAvoid.z >
          avoid.x * avoid.x + avoid.y * avoid.y + avoid.z * avoid.z;
        dampLookTarget(avoid, wantAvoid, growing ? tuning.avoidInRate : tuning.avoidOutRate, dt);
      }
      position.x += avoid.x;
      position.y += avoid.y;
      position.z += avoid.z;

      // Rock: one ray from the killer to the camera, like the chase rig.
      const rayX = position.x - centre.x;
      const rayY = position.y - centre.y;
      const rayZ = position.z - centre.z;
      const rayLength = Math.sqrt(rayX * rayX + rayY * rayY + rayZ * rayZ);
      let hit = -1;
      if (terrain !== null && rayLength > 1e-3) {
        hit = terrain.raycast(
          centre.x,
          centre.y,
          centre.z,
          rayX,
          rayY,
          rayZ,
          rayLength + tuning.rockMargin,
        );
      }
      pull = resolveCameraPull(pull, hit, rayLength, tuning.rockMargin, tuning.rockEaseOutRate, dt);
      position.x = centre.x + rayX * pull;
      position.y = centre.y + rayY * pull;
      position.z = centre.z + rayZ * pull;

      // The killer's own wings. Rock may have pulled the camera in to any distance; what it
      // lost in distance it takes in height (the wings spread sideways, the sky above a flying
      // dragon is nearly always open), up to the keep-out sphere and never into a roof. It
      // follows the pull, which is continuous on the way out, so it adds no jump of its own.
      const keepOut = deathCamKeepOut(killer.classId, tuning);
      const offX = position.x - killer.position.x;
      const offY = position.y - killer.position.y;
      const offZ = position.z - killer.position.z;
      const level = offX * offX + offZ * offZ;
      if (level + offY * offY < keepOut * keepOut) {
        let rise = Math.sqrt(keepOut * keepOut - level) - offY;
        if (terrain !== null) {
          const roof = terrain.raycast(
            position.x,
            position.y,
            position.z,
            0,
            1,
            0,
            rise + tuning.rockMargin,
          );
          if (roof >= 0) rise = Math.min(rise, Math.max(roof - tuning.rockMargin, 0));
        }
        position.y += rise;
      }

      // Look a little ahead of the killer, eased so a dodge or a bounce does not jerk the view.
      const velocity = killer.velocity;
      const speed = Math.sqrt(
        velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
      );
      if (!reduceMotion && speed > 1e-3 && Number.isFinite(speed)) {
        const reach = Math.min(speed * tuning.leadS, tuning.maxLead) / speed;
        setVec3(wantLead, velocity.x * reach, velocity.y * reach, velocity.z * reach);
      } else {
        setVec3(wantLead, 0, 0, 0);
      }
      dampLookTarget(lead, wantLead, tuning.leadRate, dt);
      setVec3(target, centre.x + lead.x, centre.y + lead.y, centre.z + lead.z);

      aimCamera(camera, position, target, 0, tuning.fovDeg);
      return true;
    },
  };
}
