/**
 * `?viewer=cine:skim`: a low pass over the cloud sea, for the trailer. A flight of dragons runs
 * Ember's canyon from its mouth to the middle (under the great arch at its bend), low over the
 * clouds, and the camera follows a little above and behind them. The canyon's centre line is
 * kept free of rock by the map generator, so neither the dragons nor the camera need collision.
 *   &t=<seconds>     start time (the run takes about 11 s, then starts again)
 *   &n=<1..5>        dragons in the flight (default 3)
 *   &team=frost      their team (default ember), which is also whose canyon it is
 *   &y=<metres>      the flight's height above the cloud sea (default 26)
 *   &camy=<metres>   the camera's height (default 40; below the flight it looks up at the
 *                    canyon walls and the arch instead of down at the clouds)
 *   &back=<metres>   how far behind the leader the camera flies (default 36)
 *   &side=<metres>   the camera's offset to the right of the line (default 5)
 *   &speed2=<m/s>    flight speed (default 46; `&speed=` is the viewer's time scale)
 *   &fov=<degrees>   (default 56)
 *   &front=1         the camera flies ahead of the flight and looks back at it
 */
import type { PerspectiveCamera } from 'three';
import {
  catmullRomPoint,
  catmullRomTangent,
  createSplineLengthTable,
  measureSpline,
  splineParamAtFraction,
  wrapAngle,
} from '../../cinematics/camera-math';
import {
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  acquireZoneView,
  beginWorldView,
  createVec3,
  createWorldView,
} from '../../shared';
import type { DragonClassId, MutableDragonView, TeamId, Vec3 } from '../../shared';
import { createShatteredSpires } from '../../shared/maps/shattered-spires';
import type { CineFrame, CineHarness } from '../cine-viewer';

const MAX_FLIGHT = 5;
/** Each wing pair sits this far behind and beside the one in front (a V). */
const ROW_BACK_M = 11;
const ROW_SIDE_M = 9;
/** Metres ahead on the line at which the turn is read, for the bank. */
const BANK_LOOKAHEAD_M = 30;
const BANK_GAIN = 2.2;
const MAX_BANK = 0.6;
/** Seconds of each flap cycle spent gliding (the wings rest between beats). */
const FLAP_EVERY_S = 3.2;
const FLAP_FOR_S = 1.6;

function numberParam(params: URLSearchParams, key: string, fallback: number): number {
  const value = Number(params.get(key) ?? '');
  return params.has(key) && Number.isFinite(value) ? value : fallback;
}

/** Yaw about +Y (0 = +Z), then roll about the nose (positive = right wing down). */
function writeYawRoll(dragon: MutableDragonView, yaw: number, roll: number): void {
  const sy = Math.sin(yaw * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sr = Math.sin(roll * 0.5);
  const cr = Math.cos(roll * 0.5);
  dragon.orientation.x = sy * sr;
  dragon.orientation.y = sy * cr;
  dragon.orientation.z = cy * sr;
  dragon.orientation.w = cy * cr;
}

export function start(harness: CineHarness): void {
  const params = harness.params;
  const assets = harness.loadMatch();
  const map = assets.map;
  const count = Math.min(Math.max(Math.round(numberParam(params, 'n', 3)), 1), MAX_FLIGHT);
  const team: TeamId = params.get('team') === 'frost' ? TEAM_FROST : TEAM_EMBER;
  const flightY = numberParam(params, 'y', 26);
  const cameraY = numberParam(params, 'camy', 40);
  const back = numberParam(params, 'back', 36);
  const side = numberParam(params, 'side', 5);
  const speed = Math.max(numberParam(params, 'speed2', 46), 1);
  const fov = numberParam(params, 'fov', 56);
  const front = params.get('front') === '1';

  // The line: the canyon of the chosen team (the map is point-symmetric), flattened to the
  // cloud sea; heights come from the URL.
  const canyon = createShatteredSpires(map.seed).canyons[team === TEAM_FROST ? 1 : 0] ?? [];
  const line: Vec3[] = canyon.map((p) => ({ x: p.x, y: 0, z: p.z }));
  const table = createSplineLengthTable(96);
  const length = measureSpline(table, line);
  // The whole flight stays on the line: the last row starts at its beginning.
  const lead = ROW_BACK_M * Math.ceil((count - 1) / 2) + back + 4;
  const span = Math.max(length - lead - BANK_LOOKAHEAD_M, 1);
  const period = span / speed;

  const view = createWorldView();
  view.clock.phase = 'playing';
  view.localDragonId = NO_PLAYER;
  const frame: CineFrame = { kind: 'match', view };

  const at = createVec3();
  const tangent = createVec3();
  const ahead = createVec3();
  const eye = createVec3();
  const target = createVec3();
  /** Metres along the line of the leader this frame. */
  let leaderM = lead;

  /** Point and direction `metres` along the line (clamped to it). */
  const sample = (metres: number): void => {
    const u = splineParamAtFraction(table, metres / (length > 0 ? length : 1));
    catmullRomPoint(at, line, u);
    catmullRomTangent(tangent, line, u);
  };

  harness.setDirector({
    direct(camera: PerspectiveCamera): boolean {
      sample(leaderM);
      const lx = at.x;
      const lz = at.z;
      sample(front ? leaderM + back * 0.55 : leaderM - back);
      // Right of the direction of travel: (tz, 0, -tx) for a +Y up, +Z forward world.
      eye.x = at.x - tangent.z * side;
      eye.y = cameraY;
      eye.z = at.z + tangent.x * side;
      target.x = lx;
      target.y = flightY + (front ? 1 : 4);
      target.z = lz;
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(target.x, target.y, target.z);
      camera.fov = fov;
      return true;
    },
  });
  harness.setInfo(`${count} dragons, ${length.toFixed(0)} m, ${period.toFixed(1)} s`);

  harness.run((_dtS, timeS) => {
    const runS = period > 0 ? timeS % period : 0;
    leaderM = lead + runS * speed;

    beginWorldView(view);
    for (let i = 0; i < count; i++) {
      // 0 leads; 1 and 2 are the first pair, 3 and 4 the second.
      const row = (i + 1) >> 1;
      const wing = i === 0 ? 0 : i % 2 === 1 ? -1 : 1;
      const metres = leaderM - row * ROW_BACK_M;
      sample(metres + BANK_LOOKAHEAD_M);
      ahead.x = tangent.x;
      ahead.z = tangent.z;
      sample(metres);
      const yaw = Math.atan2(tangent.x, tangent.z);
      const turn = wrapAngle(Math.atan2(ahead.x, ahead.z) - yaw);
      const bank = Math.max(-MAX_BANK, Math.min(MAX_BANK, turn * BANK_GAIN));
      const classId: DragonClassId = DRAGON_CLASS_IDS[i % DRAGON_CLASS_IDS.length] ?? 'talon';

      const dragon = acquireDragonView(view);
      dragon.id = i;
      dragon.team = team;
      dragon.classId = classId;
      // A slow breath up and down, each dragon on its own beat.
      dragon.position.x = at.x - tangent.z * wing * row * ROW_SIDE_M;
      dragon.position.y = flightY + Math.sin(timeS * 0.9 + i * 1.7) * 1.2 - row * 1.5;
      dragon.position.z = at.z + tangent.x * wing * row * ROW_SIDE_M;
      writeYawRoll(dragon, yaw, bank);
      dragon.velocity.x = tangent.x * speed;
      dragon.velocity.y = 0;
      dragon.velocity.z = tangent.z * speed;
      dragon.health = 1;
      dragon.stamina = 1;
      dragon.flags = DRAGON_FLAG_ALIVE;
      const beat = (timeS + i * 0.9) % FLAP_EVERY_S;
      dragon.anim = beat < FLAP_FOR_S ? DRAGON_ANIM_FLAP : DRAGON_ANIM_GLIDE;
    }
    // The storm wall, as a real match draws it: it closes the far end of the view.
    const wall = acquireZoneView(view);
    wall.id = 0;
    wall.kind = 'stormWall';
    wall.team = null;
    wall.position.x = map.colliders.stormCenter.x;
    wall.position.y = 0;
    wall.position.z = map.colliders.stormCenter.z;
    wall.radius = map.colliders.stormRadius;
    return frame;
  });
}
