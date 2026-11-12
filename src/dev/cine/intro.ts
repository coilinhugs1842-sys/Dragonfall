/**
 * `?viewer=cine:intro`: the match intro (src/cinematics/match-intro.ts) on its own, looping. It
 * loads the match map, hovers two teams at their real gates and plays the `intro` phase from the
 * harness clock, then a short stretch of `countdown` so the hand-over to the chase camera can be
 * judged, then starts again.
 *   &t=<seconds>     start time (with &speed=0 the scene is frozen on that frame)
 *   &team=frost      the local rider's team (default ember)
 *   &slot=<0..4>     the local rider's place in its row (default 2, the middle)
 *   &size=<1..5>     riders per team (default 5)
 *   &spectate=1      no local rider
 *   &mode=duel       the Duel gates (closer in)
 *   &reduce=1        the reduce-motion version
 *   &path=1          draws the flyby spline
 *   &cam=x,y,z,tx,ty,tz[,fov]   a fixed scouting camera instead of the intro's
 */
import { BufferGeometry, Float32BufferAttribute, Line, LineBasicMaterial } from 'three';
import type { PerspectiveCamera } from 'three';
import { catmullRomPoint } from '../../cinematics/camera-math';
import { createMatchIntro, matchIntroShot } from '../../cinematics/match-intro';
import {
  DRAGON_ANIM_HOVER,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  MATCH_TUNING,
  MAX_TEAM_SIZE,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  TEAM_IDS,
  acquireDragonView,
  acquireZoneView,
  beginWorldView,
  createVec3,
  createWorldView,
  spawnGatesForMode,
} from '../../shared';
import type { DragonClassId, TeamId, Vec3 } from '../../shared';
import type { CineFrame, CineHarness } from '../cine-viewer';

/** Seconds of `countdown` (chase camera) shown after the intro before it loops. */
const HANDOVER_S = 1.5;
const PATH_SAMPLES = 120;

function numberParam(params: URLSearchParams, key: string, fallback: number): number {
  const value = Number(params.get(key) ?? '');
  return params.has(key) && Number.isFinite(value) ? value : fallback;
}

/** The flyby spline as a line, for scouting it from a `&cam=` viewpoint. */
function createPathLine(points: readonly Vec3[]): Line {
  const positions: number[] = [];
  const at = createVec3();
  for (let i = 0; i <= PATH_SAMPLES; i++) {
    catmullRomPoint(at, points, i / PATH_SAMPLES);
    positions.push(at.x, at.y, at.z);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const line = new Line(geometry, new LineBasicMaterial({ color: 0xff3fa4, fog: false }));
  line.frustumCulled = false;
  return line;
}

export function start(harness: CineHarness): void {
  const params = harness.params;
  const assets = harness.loadMatch();
  const map = assets.map;
  const gates = spawnGatesForMode(map, params.get('mode') === 'duel' ? 'duel' : 'skirmish');

  const size = Math.min(Math.max(Math.round(numberParam(params, 'size', MAX_TEAM_SIZE)), 1), MAX_TEAM_SIZE);
  const localTeam: TeamId = params.get('team') === 'frost' ? TEAM_FROST : TEAM_EMBER;
  const localSlot = Math.min(Math.max(Math.round(numberParam(params, 'slot', 2)), 0), size - 1);
  const spectate = params.get('spectate') === '1';
  // Ids: Ember 0..size-1, Frost size..2*size-1, in slot order.
  const localId = spectate ? NO_PLAYER : localTeam * size + localSlot;

  const intro = createMatchIntro();
  intro.setReduceMotion(params.get('reduce') === '1');
  intro.begin(map, assets.collision);

  const scout = (params.get('cam') ?? '').split(',').map(Number);
  if (scout.length >= 6 && scout.every(Number.isFinite)) {
    const [x = 0, y = 0, z = 0, tx = 0, ty = 0, tz = 0, fov = 55] = scout;
    harness.setDirector({
      direct(camera: PerspectiveCamera): boolean {
        camera.position.set(x, y, z);
        camera.lookAt(tx, ty, tz);
        camera.fov = fov;
        return true;
      },
    });
  } else {
    harness.setDirector(intro);
  }
  if (params.get('path') === '1' && map.introSpline !== undefined) {
    harness.stage.addProp(createPathLine(map.introSpline));
  }

  const view = createWorldView();
  view.localDragonId = localId;
  const frame: CineFrame = { kind: 'match', view };
  const period = MATCH_TUNING.matchIntroS + HANDOVER_S;
  let shownShot = '';
  let shownCard = -1;

  harness.run((_dtS, timeS) => {
    const loopS = timeS % period;
    const inIntro = loopS < MATCH_TUNING.matchIntroS;

    beginWorldView(view);
    for (let t = 0; t < TEAM_IDS.length; t++) {
      const team = TEAM_IDS[t];
      const gate = team !== undefined ? gates[team] : undefined;
      if (team === undefined || gate === undefined) continue;
      for (let slot = 0; slot < size; slot++) {
        // A short team stands in the middle of the row.
        const place = gate.slots[slot + ((MAX_TEAM_SIZE - size) >> 1)];
        const classId: DragonClassId = DRAGON_CLASS_IDS[(slot + team) % DRAGON_CLASS_IDS.length] ?? 'talon';
        const dragon = acquireDragonView(view);
        dragon.id = team * size + slot;
        dragon.team = team;
        dragon.classId = classId;
        const at = place ?? gate.position;
        dragon.position.x = at.x;
        dragon.position.y = at.y;
        dragon.position.z = at.z;
        dragon.orientation.x = gate.orientation.x;
        dragon.orientation.y = gate.orientation.y;
        dragon.orientation.z = gate.orientation.z;
        dragon.orientation.w = gate.orientation.w;
        dragon.velocity.x = 0;
        dragon.velocity.y = 0;
        dragon.velocity.z = 0;
        dragon.health = 1;
        dragon.stamina = 1;
        dragon.flags = DRAGON_FLAG_ALIVE;
        dragon.anim = DRAGON_ANIM_HOVER;
      }
    }
    // The storm wall, as a real match draws it: it shows behind the gates.
    const wall = acquireZoneView(view);
    wall.id = 0;
    wall.kind = 'stormWall';
    wall.team = null;
    wall.position.x = map.colliders.stormCenter.x;
    wall.position.y = 0;
    wall.position.z = map.colliders.stormCenter.z;
    wall.radius = map.colliders.stormRadius;

    view.clock.phase = inIntro ? 'intro' : 'countdown';
    view.clock.phaseTimeS = inIntro ? loopS : loopS - MATCH_TUNING.matchIntroS;

    // The caption only changes with the shot and the card's first decimal: no per-frame strings.
    const shot = inIntro ? matchIntroShot(loopS / MATCH_TUNING.matchIntroS) : 'countdown';
    const card = Math.round(intro.cardOpacity * 10);
    if (shot !== shownShot || card !== shownCard) {
      shownShot = shot;
      shownCard = card;
      harness.setInfo(`${shot}  card=${(card / 10).toFixed(1)}`);
    }
    return frame;
  });
}
