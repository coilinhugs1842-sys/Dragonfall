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
import type { DragonView, PlayerId, TerrainQuery, WorldView } from '../shared';
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
}

export const DEATH_CAM_TUNING: DeathCamTuning = {
  radiusStart: 27,
  radiusEnd: 20,
  heightStart: 7.5,
  heightEnd: 5,
  lookLift: 1.5,
  minRate: 0.25,
  maxRate: 0.6,
  fovDeg: 50,
  leadS: 0.1,
  maxLead: 6,
  leadRate: 4,
  rockMargin: 1.5,
  rockEaseOutRate: 1.5,
  maxDt: 0.1,
};

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

  // Per-frame scratch.
  const forward = createVec3();
  const centre = createVec3();
  const position = createVec3();
  const target = createVec3();
  const wantLead = createVec3();

  function forget(): void {
    down = false;
    downForS = 0;
    orbitId = NO_PLAYER;
    pull = 1;
  }

  /** Starts circling `killer`: from the victim's side, turning toward the killer's tail. */
  function startOrbit(killer: DragonView): void {
    orbitId = killer.id;
    orbitStartS = downForS;
    pull = 1;
    setVec3(lead, 0, 0, 0);

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
      if (!(downForS < MATCH_TUNING.deathCamS)) {
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
