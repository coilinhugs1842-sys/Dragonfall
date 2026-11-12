/**
 * `?viewer=cine:podium`: the results podium and the winners' formation pass
 * (src/cinematics/podium) on their own, looping every 12 s. It loads the match map, scatters
 * two teams where a fight might have ended (some of them down), and each frame hands that view
 * to `podium.apply`, exactly as the game does during the `results` phase.
 *   &t=<seconds>          start time (with &speed=0 the scene is frozen on that frame)
 *   &hold=<seconds>       run up to this moment of the show and stay there: the dragons' clips
 *                         have then really played (a frozen scene never finishes a landing),
 *                         which is what a screenshot of a late moment needs
 *   &winner=0|1|draw      the winning team (default 0, Ember)
 *   &mvp=<id>&td=<id>&dmg=<id>   who holds each award; `none` = nobody (ids: Ember 0..n-1,
 *                         Frost n..2n-1; defaults 0, 1 and the first Frost rider)
 *   &n=<1..5>             riders per team (default 5)
 *   &class=<id>           every dragon of one class (default: mixed)
 *   &reduce=1             the reduce-motion version
 *   &cam=x,y,z,tx,ty,tz[,fov]   a fixed scouting camera in the podium's own frame (origin on
 *                         the rock's top, +Z toward the show's camera)
 *   &measure=1            reads the underside of every dragon, metre by metre along its body,
 *                         into `window.__podium` (`window.__podiumMeasure()` reads it at once):
 *                         how `PERCH_DROP` and the step's depth in podium-layout.ts were found
 */
import { Vector3 } from 'three';
import type { Object3D, PerspectiveCamera, SkinnedMesh } from 'three';
import {
  STEP_BACK,
  STEP_FRONT,
  choosePodiumSite,
  createPodium,
  createPodiumSite,
  siteToWorld,
} from '../../cinematics/podium';
import type { PodiumCast } from '../../cinematics/types';
import {
  DRAGON_ANIM_GLIDE,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  MAX_TEAM_SIZE,
  MODE_TUNING,
  NO_PLAYER,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  TEAM_IDS,
  acquireDragonView,
  acquireZoneView,
  beginWorldView,
  createVec3,
  createWorldView,
} from '../../shared';
import type { DragonClassId, MatchWinner, PlayerId } from '../../shared';
import type { CineFrame, CineHarness } from '../cine-viewer';

function numberParam(params: URLSearchParams, key: string, fallback: number): number {
  const value = Number(params.get(key) ?? '');
  return params.has(key) && Number.isFinite(value) ? value : fallback;
}

/** An award holder from the URL: an id, or `none`. */
function awardParam(params: URLSearchParams, key: string, fallback: PlayerId): PlayerId {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return raw !== '' && Number.isInteger(value) && value >= 0 ? value : NO_PLAYER;
}

/** A repeatable 0..1 number, for the scatter. */
function scatter(index: number, salt: number): number {
  const x = Math.sin(index * 91.7 + salt * 47.3) * 15731.743;
  return x - Math.floor(x);
}

function isSkinned(object: Object3D): object is SkinnedMesh {
  return (object as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
}

function shownInScene(object: Object3D): boolean {
  for (let at: Object3D | null = object; at !== null; at = at.parent) {
    if (!at.visible) return false;
  }
  return true;
}

export function start(harness: CineHarness): void {
  const params = harness.params;
  const assets = harness.loadMatch();
  const map = assets.map;
  const size = Math.min(Math.max(Math.round(numberParam(params, 'n', MAX_TEAM_SIZE)), 1), MAX_TEAM_SIZE);
  const count = size * TEAM_IDS.length;

  const winnerParam = params.get('winner');
  const winner: MatchWinner = winnerParam === 'draw' ? 'draw' : winnerParam === '1' ? TEAM_FROST : TEAM_EMBER;
  const cast: PodiumCast = {
    winner,
    mvpId: awardParam(params, 'mvp', 0),
    mostTakedownsId: awardParam(params, 'td', size > 1 ? 1 : NO_PLAYER),
    mostDamageId: awardParam(params, 'dmg', size),
  };
  const forcedClass = DRAGON_CLASS_IDS.find((id) => id === params.get('class'));

  const podium = createPodium({
    quality: QUALITY_PRESETS[harness.renderer.presetId],
    webgl: harness.renderer.webgl,
  });
  podium.setReduceMotion(params.get('reduce') === '1');
  harness.renderer.onPresetChange((id) => {
    podium.setQuality(QUALITY_PRESETS[id]);
  });
  podium.begin(cast, map, assets.collision);
  harness.stage.addProp(podium.object);

  // The same site the podium picked (the choice is a pure function of the map and its rock).
  const site = choosePodiumSite(createPodiumSite(), map, assets.collision);
  const scout = (params.get('cam') ?? '').split(',').map(Number);
  if (scout.length >= 6 && scout.every(Number.isFinite)) {
    const [x = 0, y = 0, z = 0, tx = 0, ty = 0, tz = 0, fov = 50] = scout;
    const eye = siteToWorld(createVec3(), site, x, y, z);
    const aim = siteToWorld(createVec3(), site, tx, ty, tz);
    harness.setDirector({
      direct(camera: PerspectiveCamera): boolean {
        camera.position.set(eye.x, eye.y, eye.z);
        camera.up.set(0, 1, 0);
        camera.lookAt(aim.x, aim.y, aim.z);
        camera.fov = fov;
        return true;
      },
    });
  } else {
    harness.setDirector(podium);
  }

  const view = createWorldView();
  const frame: CineFrame = { kind: 'match', view };
  const centre = map.colliders.stormCenter;
  const period = MODE_TUNING.resultsS;
  let hold = numberParam(params, 'hold', -1);
  // `window.__podiumSeek(fromS, holdS)`: jump to a moment and (with `holdS`) stop at a later
  // one, without a reload. For a capture script that takes several moments in one session.
  let seekS = 0;
  let nowS = 0;
  Reflect.set(window, '__podiumSeek', (fromS: number, holdS?: number): void => {
    seekS = fromS - nowS;
    hold = holdS ?? -1;
  });
  harness.setInfo(
    `winner=${winner === 'draw' ? 'draw' : winner}  mvp=${cast.mvpId} td=${cast.mostTakedownsId} dmg=${cast.mostDamageId}`,
  );

  // --- &measure=1: where the feet really are ---------------------------------------------------
  const measure = params.get('measure') === '1';
  const vertex = new Vector3();
  let frames = 0;
  function measureFeet(): void {
    const rows: Record<string, number | string>[] = [];
    harness.stage.scene.traverse((object) => {
      if (!isSkinned(object) || !shownInScene(object)) return;
      object.updateWorldMatrix(true, false);
      const positions = object.geometry.getAttribute('position');
      let lowest = Infinity;
      for (let i = 0; i < positions.count; i++) {
        object.getVertexPosition(i, vertex).applyMatrix4(object.matrixWorld);
        if (vertex.y < lowest) lowest = vertex.y;
      }
      // Whose mesh is it: the dragon of the view standing nearest to its root.
      vertex.setFromMatrixPosition(object.matrixWorld);
      let nearest = -1;
      let nearestDistance = Infinity;
      for (let i = 0; i < view.dragonCount; i++) {
        const dragon = view.dragons[i];
        if (dragon === undefined) continue;
        const distance = Math.hypot(
          dragon.position.x - vertex.x,
          dragon.position.y - vertex.y,
          dragon.position.z - vertex.z,
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = i;
        }
      }
      const dragon = view.dragons[nearest];
      if (dragon === undefined) return;
      // The underside as a profile: the lowest point below the origin in each metre along the
      // site's Z (the way the seated dragons face), from 9 m behind the origin to 7 m ahead.
      // The feet are the low points near the origin; further back it is the tail.
      const profile: number[] = new Array<number>(16).fill(0);
      // The same from 4 m behind the origin to 2 m ahead, split by the distance from the middle
      // line (0.3 m lanes out to 1.8 m): the tail hangs on the middle line, the legs stand
      // out to the sides, so the claws are the low points of the outer lanes.
      const lanes: number[][] = [];
      for (let lane = 0; lane < 6; lane++) lanes.push(new Array<number>(6).fill(0));
      // The lowest point over the depth of a step: how high the origin has to be above the
      // stone for nothing to be in it.
      let overStep = 0;
      for (let i = 0; i < positions.count; i++) {
        object.getVertexPosition(i, vertex).applyMatrix4(object.matrixWorld);
        const dx = vertex.x - dragon.position.x;
        const dz = vertex.z - dragon.position.z;
        const along = dx * site.sin + dz * site.cos;
        const across = Math.abs(dx * site.cos - dz * site.sin);
        const band = Math.floor(along + 9);
        const below = dragon.position.y - vertex.y;
        if (along > -STEP_BACK && along < STEP_FRONT && across < 3.6 && below > overStep) overStep = below;
        if (band < 0 || band >= profile.length) continue;
        if (below > (profile[band] ?? 0)) profile[band] = below;
        const lane = lanes[Math.min(5, Math.floor(across / 0.3))];
        const near = band - 5;
        if (lane !== undefined && near >= 0 && near < 6 && below > (lane[near] ?? 0)) lane[near] = below;
      }
      rows.push({
        id: dragon.id,
        classId: dragon.classId,
        anim: dragon.anim,
        drop: Number((dragon.position.y - lowest).toFixed(3)),
        overStep: Number(overStep.toFixed(2)),
        aboveSite: Number((dragon.position.y - site.y).toFixed(2)),
        profile: profile.map((value) => value.toFixed(2)).join(' '),
        lanes: lanes.map((lane) => lane.map((value) => value.toFixed(2)).join(' ')).join(' | '),
      });
    });
    Reflect.set(window, '__podium', rows);
  }
  // For a capture script: measure now rather than wait for the next automatic reading.
  if (measure) Reflect.set(window, '__podiumMeasure', measureFeet);

  harness.run((dtS, timeS) => {
    beginWorldView(view);
    for (let i = 0; i < count; i++) {
      const team = i < size ? TEAM_EMBER : TEAM_FROST;
      const classId: DragonClassId = forcedClass ?? DRAGON_CLASS_IDS[i % DRAGON_CLASS_IDS.length] ?? 'talon';
      const dragon = acquireDragonView(view);
      dragon.id = i;
      dragon.team = team;
      dragon.classId = classId;
      // Where the fight left them: all over the middle of the arena, a third of them down.
      const bearing = scatter(i, 1) * Math.PI * 2;
      const range = 80 + scatter(i, 2) * 320;
      dragon.position.x = centre.x + Math.sin(bearing) * range;
      dragon.position.y = 140 + scatter(i, 3) * 260;
      dragon.position.z = centre.z + Math.cos(bearing) * range;
      const yaw = scatter(i, 4) * Math.PI * 2;
      dragon.orientation.x = 0;
      dragon.orientation.y = Math.sin(yaw * 0.5);
      dragon.orientation.z = 0;
      dragon.orientation.w = Math.cos(yaw * 0.5);
      dragon.velocity.x = Math.sin(yaw) * 40;
      dragon.velocity.y = 0;
      dragon.velocity.z = Math.cos(yaw) * 40;
      const down = i % 3 === 2;
      dragon.health = down ? 0 : 0.25 + scatter(i, 5) * 0.75;
      dragon.stamina = scatter(i, 6);
      dragon.flags = down ? 0 : DRAGON_FLAG_ALIVE;
      dragon.anim = DRAGON_ANIM_GLIDE;
    }
    // The storm wall of a real match: `apply` has to drop it.
    const wall = acquireZoneView(view);
    wall.id = 0;
    wall.kind = 'stormWall';
    wall.team = null;
    wall.position.x = centre.x;
    wall.position.y = 0;
    wall.position.z = centre.z;
    wall.radius = map.colliders.stormRadius;

    view.clock.phase = 'results';
    nowS = timeS;
    const showS = timeS + seekS;
    view.clock.phaseTimeS = hold >= 0 ? Math.min(showS, hold) : showS % period;
    // For a capture script: the moment of the show on screen.
    Reflect.set(window, '__podiumShowS', view.clock.phaseTimeS);
    podium.apply(view, dtS);

    if (measure && ++frames % 30 === 0) measureFeet();
    return frame;
  });
}
