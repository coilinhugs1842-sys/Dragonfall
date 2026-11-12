/**
 * The results podium (T-5.5): the `Podium` of src/cinematics/types.ts.
 *
 * It is a puppet show on top of the real picture. On every `results` frame `apply` moves the
 * frame's dragons to where the show wants them (podium-choreography.ts) and `direct` places the
 * camera (podium-camera.ts); the ordinary dragon renderer, shadows and sound then do the rest.
 * Both are functions of `WorldView.clock.phaseTimeS`, so every browser shows the same moment
 * and nothing about the show travels over the network.
 *
 * THE CLOCK. The host's `phaseTimeS` moves in sim ticks (30 a second); drawn at 60 fps that
 * would move the dragons on every other frame only. `apply` therefore follows it with a clock
 * of its own that advances by the frame time and is pulled gently toward the phase clock (and
 * jumps to it when they disagree by more than a moment: the first frame, a seek, a stalled
 * tab). That is smoothing only: the show never runs ahead of or away from the phase clock.
 *
 * `apply` and `direct` do not allocate (the plan's arrays grow once, to the number of dragons).
 */
import type { Object3D, PerspectiveCamera, WebGLRenderer } from 'three';
import { DRAGON_FLAG_ALIVE, NO_PLAYER, createVec3 } from '../../shared';
import type {
  ArenaMap,
  MatchWinner,
  MutableWorldView,
  PlayerId,
  QualityPreset,
  TerrainQuery,
  WorldView,
} from '../../shared';
import type { Podium, PodiumCast } from '../types';
import { createShowCamera, writeShowCamera } from './podium-camera';
import { createPodiumPlan, planIsCurrent, planPodium } from './podium-cast';
import { createPuppetPose, writePuppetPose } from './podium-choreography';
import { choosePodiumSite, createPodiumSite, siteDirection, siteToWorld } from './podium-layout';
import { writeYawPitchRoll } from './podium-math';
import { createPodiumRock } from './podium-rock';

export interface PodiumOptions {
  readonly quality: QualityPreset;
  /** The game's renderer, for the map's rock; null (node tests, tools) keeps the stand-in. */
  readonly webgl: WebGLRenderer | null;
}

/** The show clock jumps to the phase clock when they are further apart than this, seconds. */
const CLOCK_SNAP_S = 0.25;
/** How fast the show clock closes on the phase clock otherwise, per second. */
const CLOCK_PULL = 6;

export function createPodium(options: PodiumOptions): Podium {
  const rock = createPodiumRock(options.quality, options.webgl);
  rock.object.visible = false;

  const site = createPodiumSite();
  const plan = createPodiumPlan();
  const pose = createPuppetPose();
  const shot = createShowCamera();
  const eye = createVec3();
  const aim = createVec3();
  // A copy: the caller's cast object is its own to reuse.
  const cast: { winner: MatchWinner; mvpId: PlayerId; mostTakedownsId: PlayerId; mostDamageId: PlayerId } = {
    winner: 'draw',
    mvpId: NO_PLAYER,
    mostTakedownsId: NO_PLAYER,
    mostDamageId: NO_PLAYER,
  };

  let active = false;
  let reduceMotion = false;
  /** The smoothed show clock, and the phase time of the frame it was last advanced for. */
  let showS = 0;
  let appliedPhaseS = -1;
  let hasClock = false;
  /** Free-running, for the cloth and the flames only. */
  let dressingS = 0;

  function forgetShow(): void {
    hasClock = false;
    appliedPhaseS = -1;
    // Forces a new plan on the next `apply`.
    plan.count = -1;
  }

  function advanceClock(phaseS: number, dtS: number): void {
    if (!hasClock || !(dtS > 0)) {
      showS = phaseS;
    } else {
      const predicted = showS + dtS;
      const error = phaseS - predicted;
      showS =
        Math.abs(error) > CLOCK_SNAP_S ? phaseS : predicted + error * (1 - Math.exp(-CLOCK_PULL * dtS));
    }
    hasClock = true;
    appliedPhaseS = phaseS;
  }

  return {
    object: rock.object as Object3D,
    get active(): boolean {
      return active;
    },

    begin(next: PodiumCast, map: ArenaMap, terrain: TerrainQuery | null): void {
      cast.winner = next.winner;
      cast.mvpId = next.mvpId;
      cast.mostTakedownsId = next.mostTakedownsId;
      cast.mostDamageId = next.mostDamageId;
      choosePodiumSite(site, map, terrain);
      rock.place(site, map);
      rock.setWinner(cast.winner);
      rock.object.visible = true;
      forgetShow();
      active = true;
    },

    apply(view: MutableWorldView, dtS: number): void {
      if (!active || view.clock.phase !== 'results') return;
      advanceClock(view.clock.phaseTimeS, dtS);
      if (!planIsCurrent(plan, view, cast)) planPodium(plan, view, cast);
      for (let i = 0; i < view.dragonCount; i++) {
        const dragon = view.dragons[i];
        if (dragon === undefined) continue;
        writePuppetPose(pose, plan, i, dragon.classId, showS, site.mirror);
        siteToWorld(dragon.position, site, pose.x, pose.y, pose.z);
        siteDirection(dragon.velocity, site, pose.vx, pose.vy, pose.vz);
        writeYawPitchRoll(dragon.orientation, site.yaw + pose.heading, pose.pitch, pose.roll);
        dragon.anim = pose.anim;
        // Everyone flies in the show, the fallen too, and nobody shields, burns or boosts.
        dragon.flags = DRAGON_FLAG_ALIVE;
        // A hurt dragon is drawn greyed and trailing smoke: not on the podium.
        dragon.health = 1;
        dragon.stamina = 1;
      }
      view.projectileCount = 0;
      view.zoneCount = 0;
      if (dtS > 0) dressingS += dtS;
      rock.setTime(dressingS);
    },

    direct(camera: PerspectiveCamera, view: WorldView | null, _dtS: number): boolean {
      if (!active || view === null || view.clock.phase !== 'results') return false;
      const phaseS = view.clock.phaseTimeS;
      // The same smoothed moment `apply` just put the dragons at, when it ran for this frame.
      const tS = hasClock && phaseS === appliedPhaseS ? showS : phaseS;
      writeShowCamera(shot, tS, site.mirror, reduceMotion);
      siteToWorld(eye, site, shot.x, shot.y, shot.z);
      siteToWorld(aim, site, shot.aimX, shot.aimY, shot.aimZ);
      camera.position.set(eye.x, eye.y, eye.z);
      // Another director may have rolled the camera.
      camera.up.set(0, 1, 0);
      camera.lookAt(aim.x, aim.y, aim.z);
      camera.fov = shot.fov;
      return true;
    },

    end(): void {
      active = false;
      rock.object.visible = false;
      forgetShow();
    },

    setQuality(preset: QualityPreset): void {
      rock.setQuality(preset);
    },

    setReduceMotion(on: boolean): void {
      reduceMotion = on;
    },

    dispose(): void {
      active = false;
      rock.object.visible = false;
      rock.dispose();
    },
  };
}
