/**
 * The match intro: the timeline is a pure function of the match clock, the title card's curve is
 * continuous, the flyby of Shattered Spires stays out of the rock with the sky-well in frame,
 * the gate shots frame the riders, and the last frame is the chase camera's.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MATCH_INTRO_TIMELINE,
  createMatchIntro,
  matchIntroCardOpacity,
  matchIntroShot,
  writeDefaultIntroSpline,
} from '../../src/cinematics/match-intro';
import { catmullRomPoint } from '../../src/cinematics/camera-math';
import type { MatchIntro } from '../../src/cinematics/types';
import { ChaseCamera, DEFAULT_BASE_FOV } from '../../src/render';
import {
  DRAGON_ANIM_HOVER,
  DRAGON_FLAG_ALIVE,
  MATCH_PHASES,
  MATCH_TUNING,
  MAX_TEAM_SIZE,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createGreyboxSpires,
  createShatteredSpires,
  createVec3,
  createWorldView,
  spawnGatesForMode,
} from '../../src/shared';
import type {
  ArenaMap,
  MutableVec3,
  MutableWorldView,
  PlayerId,
  SpawnGate,
  TeamId,
  Vec3,
} from '../../src/shared';
import { createMapCollisionWorld } from '../../src/sim';

const MAP = createShatteredSpires();
const WORLD = createMapCollisionWorld(MAP);
const INTRO_S = MATCH_TUNING.matchIntroS;
const SEA_Y = MAP.colliders.cloudSeaY;
const FLYBY_END_S = INTRO_S * MATCH_INTRO_TIMELINE.flybyEnd;
const FAR_END_S = INTRO_S * MATCH_INTRO_TIMELINE.farGateEnd;
/** Just inside each shot: clear of the cut on either side. */
const EDGE_S = 1e-4;

afterEach(() => {
  MATCH_TUNING.matchIntroS = INTRO_S;
});

/** Ember ids 0..size-1, Frost ids size..2*size-1, hovering in their gate slots. */
function castAtGates(
  gates: readonly SpawnGate[],
  size: number,
  localId: PlayerId,
): MutableWorldView {
  const view = createWorldView();
  beginWorldView(view);
  for (const gate of gates) {
    for (let slot = 0; slot < size; slot++) {
      const dragon = acquireDragonView(view);
      dragon.id = gate.team * size + slot;
      dragon.team = gate.team;
      dragon.classId = 'talon';
      const at = gate.slots[slot + ((MAX_TEAM_SIZE - size) >> 1)] ?? gate.position;
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
  view.localDragonId = localId;
  view.clock.phase = 'intro';
  view.clock.phaseTimeS = 0;
  return view;
}

function fullCast(localId: PlayerId = 2): MutableWorldView {
  return castAtGates(MAP.spawnGates, MAX_TEAM_SIZE, localId);
}

function createCamera(): PerspectiveCamera {
  return new PerspectiveCamera(60, 16 / 9, 0.5, 6000);
}

function begun(map: ArenaMap = MAP, withTerrain = true): MatchIntro {
  const intro = createMatchIntro();
  intro.begin(map, withTerrain ? WORLD : null);
  return intro;
}

function at(intro: MatchIntro, camera: PerspectiveCamera, view: MutableWorldView, timeS: number): boolean {
  view.clock.phaseTimeS = timeS;
  return intro.direct(camera, view, 1 / 60);
}

function forwardOf(camera: PerspectiveCamera): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
}

/** Radians the horizon is tilted: 0 = level. */
function rollOf(camera: PerspectiveCamera): number {
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  return Math.asin(Math.max(-1, Math.min(1, right.y)));
}

/** Where a world point lands on screen: -1..1 in both axes when it is in frame; z < 1 in front. */
function project(camera: PerspectiveCamera, point: Vec3): Vector3 {
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return new Vector3(point.x, point.y, point.z).project(camera);
}

function centroidOf(view: MutableWorldView, team: TeamId): Vector3 {
  const sum = new Vector3();
  let count = 0;
  for (let i = 0; i < view.dragonCount; i++) {
    const dragon = view.dragons[i];
    if (dragon === undefined || dragon.team !== team) continue;
    sum.add(dragon.position as Vector3);
    count++;
  }
  return sum.multiplyScalar(1 / Math.max(count, 1));
}

/** True when rock is within `margin` metres of the point, or the point is inside rock. */
function nearRock(point: Vec3, margin: number): boolean {
  const terrain = WORLD.terrain;
  if (terrain === null) throw new Error('map has no terrain');
  return (
    terrain.solidDepth(point.x, point.y, point.z) > 0 ||
    WORLD.clearance(point.x, point.y, point.z, margin) >= 0
  );
}

describe('the timeline', () => {
  it('runs flyby, far gate, local gate in that order, the flyby about 55 % of it', () => {
    expect(MATCH_INTRO_TIMELINE.flybyEnd).toBeGreaterThan(0.5);
    expect(MATCH_INTRO_TIMELINE.flybyEnd).toBeLessThan(0.6);
    expect(MATCH_INTRO_TIMELINE.farGateEnd).toBeGreaterThan(MATCH_INTRO_TIMELINE.flybyEnd);
    expect(MATCH_INTRO_TIMELINE.farGateEnd).toBeLessThan(1);
    expect(matchIntroShot(0)).toBe('flyby');
    expect(matchIntroShot(MATCH_INTRO_TIMELINE.flybyEnd - 1e-6)).toBe('flyby');
    expect(matchIntroShot(MATCH_INTRO_TIMELINE.flybyEnd)).toBe('farGate');
    expect(matchIntroShot(MATCH_INTRO_TIMELINE.farGateEnd)).toBe('localGate');
    expect(matchIntroShot(1)).toBe('localGate');
    // Every shot is long enough to read (at least 0.9 s of a 6 s intro).
    expect((MATCH_INTRO_TIMELINE.farGateEnd - MATCH_INTRO_TIMELINE.flybyEnd) * INTRO_S).toBeGreaterThan(0.9);
    expect((1 - MATCH_INTRO_TIMELINE.farGateEnd) * INTRO_S).toBeGreaterThan(1.5);
  });

  it('is a pure function of the clock: same inputs, same camera, whatever came before', () => {
    const view = fullCast();
    const intro = begun();
    const reference = createCamera();
    const again = createCamera();
    const times = [0, 0.5, 1.5, 3, FLYBY_END_S - EDGE_S, 3.6, 4.5, 5.5, INTRO_S];
    for (const timeS of times) {
      expect(at(intro, reference, view, timeS)).toBe(true);
      const card = intro.cardOpacity;
      // Other frames in between, in another order, with other frame times.
      for (const other of [5.9, 0.1, 4.4, 2.2]) {
        view.clock.phaseTimeS = other;
        intro.direct(again, view, other);
      }
      view.clock.phaseTimeS = timeS;
      expect(intro.direct(again, view, 0.5)).toBe(true);
      expect(again.position.toArray()).toEqual(reference.position.toArray());
      expect(again.quaternion.toArray()).toEqual(reference.quaternion.toArray());
      expect(again.fov).toBe(reference.fov);
      expect(intro.cardOpacity).toBe(card);
      // And a second director that has seen nothing else agrees.
      const fresh = begun();
      const other = createCamera();
      expect(at(fresh, other, view, timeS)).toBe(true);
      expect(other.position.toArray()).toEqual(reference.position.toArray());
      expect(other.quaternion.toArray()).toEqual(reference.quaternion.toArray());
    }
  });

  it('scales with MATCH_TUNING.matchIntroS, read live', () => {
    const view = fullCast();
    const intro = begun();
    const normal = createCamera();
    const stretched = createCamera();
    for (const timeS of [0.7, 2.9, 3.9, 5.2]) {
      MATCH_TUNING.matchIntroS = INTRO_S;
      at(intro, normal, view, timeS);
      const card = intro.cardOpacity;
      MATCH_TUNING.matchIntroS = INTRO_S * 2;
      at(intro, stretched, view, timeS * 2);
      expect(stretched.position.distanceTo(normal.position)).toBeLessThan(1e-6);
      expect(stretched.quaternion.angleTo(normal.quaternion)).toBeLessThan(1e-6);
      expect(intro.cardOpacity).toBeCloseTo(card, 9);
    }
  });

  it('leaves the frame to the chase camera without a view and outside the intro phase', () => {
    const view = fullCast();
    const intro = begun();
    const camera = createCamera();
    camera.position.set(1, 2, 3);
    expect(intro.direct(camera, null, 1 / 60)).toBe(false);
    expect(intro.cardOpacity).toBe(0);
    for (const phase of MATCH_PHASES) {
      view.clock.phase = phase;
      view.clock.phaseTimeS = 1;
      camera.position.set(1, 2, 3);
      expect(intro.direct(camera, view, 1 / 60), phase).toBe(phase === 'intro');
      if (phase !== 'intro') {
        expect(intro.cardOpacity, phase).toBe(0);
        expect(camera.position.toArray(), phase).toEqual([1, 2, 3]);
      }
    }
    // Before `begin` there is no path to fly: the card still follows the clock.
    const unbegun = createMatchIntro();
    view.clock.phase = 'intro';
    expect(unbegun.direct(camera, view, 1 / 60)).toBe(false);
    expect(unbegun.cardOpacity).toBeGreaterThan(0.99);
  });

  it('holds the first frame for a clock that is not a number and the last one past the end', () => {
    const view = fullCast();
    const intro = begun();
    const camera = createCamera();
    const reference = createCamera();
    at(intro, reference, view, 0);
    for (const broken of [Number.NaN, -1]) {
      expect(at(intro, camera, view, broken)).toBe(true);
      expect(camera.position.toArray()).toEqual(reference.position.toArray());
    }
    at(intro, reference, view, INTRO_S);
    expect(at(intro, camera, view, INTRO_S + 3)).toBe(true);
    expect(camera.position.toArray()).toEqual(reference.position.toArray());
    expect(at(intro, camera, view, Infinity)).toBe(true);
    expect(camera.position.toArray()).toEqual(reference.position.toArray());
  });

  it('moves smoothly inside each shot: the only jumps are the two cuts', () => {
    const view = fullCast();
    const intro = begun();
    const camera = createCamera();
    const step = 1 / 120;
    const last = new Vector3();
    const lastForward = new Vector3();
    let cuts = 0;
    let fastestTurn = 0;
    for (let timeS = 0; timeS <= INTRO_S; timeS += step) {
      at(intro, camera, view, timeS);
      const forward = forwardOf(camera);
      if (timeS > 0) {
        const moved = camera.position.distanceTo(last);
        const turned = forward.angleTo(lastForward);
        if (moved > 50) {
          cuts++;
        } else {
          // Under 450 m/s everywhere else, and never a whip: the swing in behind the local
          // dragon is the fastest turn (166 degrees per second at its peak) and stays under 170.
          expect(moved / step).toBeLessThan(450);
          fastestTurn = Math.max(fastestTurn, turned / step);
        }
      }
      last.copy(camera.position);
      lastForward.copy(forward);
    }
    expect(cuts).toBe(2);
    expect((fastestTurn * 180) / Math.PI).toBeLessThan(170);
  });
});

describe('the title card', () => {
  it('is 0 at the start, up within about 0.4 s, held, and gone before the first cut', () => {
    expect(matchIntroCardOpacity(0)).toBe(0);
    expect(matchIntroCardOpacity(0.4 / 6)).toBeCloseTo(1, 2);
    expect(matchIntroCardOpacity(0.2 / 6)).toBeGreaterThan(0.2);
    expect(matchIntroCardOpacity(0.2 / 6)).toBeLessThan(0.8);
    for (const fraction of [0.1, 0.2, 0.3, 0.4]) expect(matchIntroCardOpacity(fraction)).toBe(1);
    expect(MATCH_INTRO_TIMELINE.cardOutEnd).toBeLessThan(MATCH_INTRO_TIMELINE.flybyEnd);
    for (const fraction of [MATCH_INTRO_TIMELINE.cardOutEnd, MATCH_INTRO_TIMELINE.flybyEnd, 0.8, 1]) {
      expect(matchIntroCardOpacity(fraction)).toBe(0);
    }
    for (const outside of [-0.5, 1.5, Number.NaN, Infinity]) {
      expect(matchIntroCardOpacity(outside)).toBe(0);
    }
  });

  it('is continuous and stays within 0..1', () => {
    const steps = 6000;
    let last = matchIntroCardOpacity(-1 / steps);
    for (let i = 0; i <= steps + 1; i++) {
      const value = matchIntroCardOpacity(i / steps);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      // One millisecond of a 6 s intro never changes it by more than 1 %.
      expect(Math.abs(value - last)).toBeLessThan(0.01);
      last = value;
    }
  });

  it('comes out of the director the same', () => {
    const view = fullCast();
    const intro = begun();
    const camera = createCamera();
    for (const timeS of [0, 0.1, 0.4, 2, 2.8, 3.2, 4, 6]) {
      at(intro, camera, view, timeS);
      expect(intro.cardOpacity).toBe(matchIntroCardOpacity(timeS / INTRO_S));
    }
  });
});

describe('the flyby of Shattered Spires', () => {
  it('has an authored spline that stays out of the rock, above the clouds, inside the storm', () => {
    const spline = MAP.introSpline;
    expect(spline).toBeDefined();
    if (spline === undefined) return;
    expect(spline.length).toBeGreaterThanOrEqual(4);
    const point = createVec3();
    for (let i = 0; i <= 600; i++) {
      catmullRomPoint(point, spline, i / 600);
      expect(nearRock(point, 15), `spline at ${i / 600}`).toBe(false);
      expect(point.y).toBeGreaterThan(SEA_Y + 100);
      expect(Math.hypot(point.x, point.z)).toBeLessThan(MAP.colliders.stormRadius);
    }
  });

  it('never puts a frame in rock or under the cloud sea, with or without reduce motion', () => {
    const view = fullCast();
    const camera = createCamera();
    for (const reduce of [false, true]) {
      const intro = begun();
      intro.setReduceMotion(reduce);
      for (let timeS = 0; timeS <= INTRO_S; timeS += 1 / 60) {
        expect(at(intro, camera, view, timeS)).toBe(true);
        const where = `t=${timeS.toFixed(2)} reduce=${reduce}`;
        expect(Number.isFinite(camera.position.x + camera.quaternion.w + camera.fov), where).toBe(true);
        // The near plane is 0.5 m; the flyby keeps 15 m, the gate shots at least 2.
        expect(nearRock(camera.position, timeS < FLYBY_END_S ? 15 : 2), where).toBe(false);
        expect(camera.position.y, where).toBeGreaterThan(SEA_Y + 1.5);
      }
    }
  });

  it('starts wide and high outside the spires with the low sun in frame', () => {
    const view = fullCast();
    const camera = createCamera();
    at(begun(), camera, view, 0);
    // Outside the rim's rock (nothing solid beyond 965 m; the rim spires stand near 800 m).
    expect(Math.hypot(camera.position.x, camera.position.z)).toBeGreaterThan(900);
    expect(camera.position.y).toBeGreaterThan(400);
    const sun = MAP.sky.sunDirection;
    const far = {
      x: camera.position.x + sun.x * 5000,
      y: camera.position.y + sun.y * 5000,
      z: camera.position.z + sun.z * 5000,
    };
    const onScreen = project(camera, far);
    expect(Math.abs(onScreen.x)).toBeLessThan(0.8);
    // In the upper half, not cut off by the top edge.
    expect(onScreen.y).toBeGreaterThan(0);
    expect(onScreen.y).toBeLessThan(0.9);
  });

  it('keeps the sky-well in frame and the horizon level the whole way, descending', () => {
    const view = fullCast();
    const intro = begun();
    const camera = createCamera();
    const well = MAP.skyWell.position;
    let lastY = Infinity;
    let lastDistance = Infinity;
    for (let timeS = 0; timeS < FLYBY_END_S; timeS += 1 / 30) {
      at(intro, camera, view, timeS);
      const onScreen = project(camera, well);
      expect(onScreen.z, `t=${timeS}`).toBeLessThan(1);
      expect(Math.abs(onScreen.x), `t=${timeS}`).toBeLessThan(0.85);
      expect(Math.abs(onScreen.y), `t=${timeS}`).toBeLessThan(0.85);
      // Under 3 degrees of bank: it reads as level.
      expect(Math.abs(rollOf(camera))).toBeLessThan(0.05);
      // One move: always down and always closer to the sky-well.
      expect(camera.position.y).toBeLessThanOrEqual(lastY);
      const distance = camera.position.distanceTo(well as Vector3);
      expect(distance).toBeLessThan(lastDistance);
      lastY = camera.position.y;
      lastDistance = distance;
    }
    // It ends close beside the sky-well, between the claws.
    expect(lastDistance).toBeLessThan(160);
  });

  it('becomes a slow straight push-in with reduce motion: no roll, no fast move', () => {
    const view = fullCast();
    const intro = begun();
    intro.setReduceMotion(true);
    const camera = createCamera();
    at(intro, camera, view, 0);
    const start = camera.position.clone();
    const orientation = camera.quaternion.clone();
    at(intro, camera, view, FLYBY_END_S - EDGE_S);
    const end = camera.position.clone();
    const travel = end.distanceTo(start);
    expect(travel).toBeGreaterThan(20);
    expect(travel / FLYBY_END_S).toBeLessThan(25);
    const direction = end.clone().sub(start).normalize();
    for (let timeS = 0; timeS < FLYBY_END_S; timeS += 0.1) {
      at(intro, camera, view, timeS);
      // On the straight line from start to end, at an even pace.
      const along = camera.position.clone().sub(start);
      expect(along.clone().cross(direction).length()).toBeLessThan(1e-6);
      expect(along.dot(direction)).toBeCloseTo((travel * timeS) / (FLYBY_END_S - EDGE_S), 3);
      expect(rollOf(camera)).toBeCloseTo(0, 9);
      // The view turns by less than 5 degrees over the whole shot.
      expect(camera.quaternion.angleTo(orientation)).toBeLessThan(0.09);
    }
  });
});

describe('the gate shots', () => {
  /** Every rider of `team` is on screen, in front of the camera. */
  function expectTeamInFrame(camera: PerspectiveCamera, view: MutableWorldView, team: TeamId, label: string): void {
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon === undefined || dragon.team !== team) continue;
      const onScreen = project(camera, dragon.position);
      expect(onScreen.z, label).toBeLessThan(1);
      expect(Math.abs(onScreen.x), label).toBeLessThan(0.9);
      expect(Math.abs(onScreen.y), label).toBeLessThan(0.9);
    }
  }

  it('shows the far team first, from in front and below, pushing in slowly', () => {
    for (const localTeam of [TEAM_EMBER, TEAM_FROST] as const) {
      const farTeam = localTeam === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
      const view = fullCast(localTeam * MAX_TEAM_SIZE + 1);
      const intro = begun();
      const camera = createCamera();
      const centre = centroidOf(view, farTeam);
      // Frost at +Z faces -Z; Ember at -Z faces +Z.
      const facing = new Vector3(0, 0, farTeam === TEAM_EMBER ? 1 : -1);
      let lastDistance = Infinity;
      for (let timeS = FLYBY_END_S; timeS < FAR_END_S - EDGE_S; timeS += 0.05) {
        at(intro, camera, view, timeS);
        const toCamera = camera.position.clone().sub(centre);
        const distance = toCamera.length();
        // In front of the riders (within 30 degrees of their nose line) and a little below.
        expect(toCamera.clone().setY(0).normalize().dot(facing)).toBeGreaterThan(Math.cos(Math.PI / 6));
        expect(camera.position.y).toBeLessThan(centre.y - 3);
        expect(camera.position.y).toBeGreaterThan(centre.y - distance * 0.3);
        // Looking up at them: sky behind.
        expect(forwardOf(camera).y).toBeGreaterThan(0.05);
        expectTeamInFrame(camera, view, farTeam, `local ${localTeam} t=${timeS}`);
        expect(distance).toBeLessThan(lastDistance);
        lastDistance = distance;
        expect(rollOf(camera)).toBeCloseTo(0, 9);
      }
      // A slow push-in: a few metres per second.
      at(intro, camera, view, FLYBY_END_S);
      const first = camera.position.clone();
      at(intro, camera, view, FAR_END_S - EDGE_S);
      const speed = camera.position.distanceTo(first) / (FAR_END_S - FLYBY_END_S);
      expect(speed).toBeGreaterThan(2);
      expect(speed).toBeLessThan(15);
    }
  });

  it('then shows the local team from in front, and ends on the chase camera pose', () => {
    for (const localId of [0, 2, 4, 5, 7, 9]) {
      const view = fullCast(localId);
      const local = view.dragons[localId];
      if (local === undefined) throw new Error('missing dragon');
      const intro = begun();
      const camera = createCamera();
      const team = local.team;
      const centre = centroidOf(view, team);
      const facing = new Vector3(0, 0, team === TEAM_EMBER ? 1 : -1);

      at(intro, camera, view, FAR_END_S);
      const toCamera = camera.position.clone().sub(centre);
      expect(toCamera.clone().setY(0).normalize().dot(facing), `local ${localId}`).toBeGreaterThan(0.5);
      expect(camera.position.y).toBeLessThan(centre.y);
      expectTeamInFrame(camera, view, team, `local ${localId} first frame`);

      // What the chase rig shows for this hovering dragon on its first frame.
      const chase = new ChaseCamera({ terrain: WORLD, minY: SEA_Y + 1.5 });
      expect(chase.update(local, 1 / 60)).toBe(true);
      at(intro, camera, view, INTRO_S);
      expect(camera.position.distanceTo(chase.position), `local ${localId}`).toBeLessThan(0.01);
      expect(camera.quaternion.angleTo(chase.quaternion), `local ${localId}`).toBeLessThan(1e-3);
      expect(camera.fov).toBe(DEFAULT_BASE_FOV);
      expect(chase.fov).toBe(DEFAULT_BASE_FOV);
      // Behind and above the local dragon, looking along its heading.
      expect(camera.position.clone().sub(local.position as Vector3).dot(facing)).toBeLessThan(-10);
      expect(camera.position.y).toBeGreaterThan(local.position.y);
      expect(forwardOf(camera).dot(facing)).toBeGreaterThan(0.99);

      // Half a second before the end it is already close: the last stretch is a settle.
      at(intro, camera, view, INTRO_S - 0.3);
      expect(camera.position.distanceTo(chase.position), `local ${localId}`).toBeLessThan(6);

      // The swing goes over the row, not through it: never within a wing of any dragon.
      for (let timeS = FAR_END_S; timeS <= INTRO_S; timeS += 1 / 60) {
        at(intro, camera, view, timeS);
        for (let i = 0; i < view.dragonCount; i++) {
          const dragon = view.dragons[i];
          if (dragon === undefined) continue;
          const gap = camera.position.distanceTo(dragon.position as Vector3);
          expect(gap, `local ${localId} t=${timeS.toFixed(2)} dragon ${dragon.id}`).toBeGreaterThan(9);
        }
      }
    }
  });

  it('gives a spectator Ember as the local team', () => {
    const view = fullCast(NO_PLAYER);
    const intro = begun();
    const camera = createCamera();
    at(intro, camera, view, FLYBY_END_S + 0.3);
    // The far gate is Frost's, at +Z.
    expect(camera.position.z).toBeGreaterThan(500);
    at(intro, camera, view, INTRO_S);
    // It ends behind Ember's first rider.
    const first = view.dragons[0];
    if (first === undefined) throw new Error('missing dragon');
    expect(first.team).toBe(TEAM_EMBER);
    expect(camera.position.z).toBeLessThan(first.position.z);
    expect(Math.abs(camera.position.x - first.position.x)).toBeLessThan(0.01);
    // A local id that is not in the view is a spectator too.
    const stray = createCamera();
    view.localDragonId = 77;
    at(intro, stray, view, INTRO_S);
    expect(stray.position.toArray()).toEqual(camera.position.toArray());
  });

  it('finds the gates from the dragons: Duel gates and short teams frame as well', () => {
    const duelGates = spawnGatesForMode(MAP, 'duel');
    expect(duelGates).not.toBe(MAP.spawnGates);
    for (const size of [1, 2, 3]) {
      const view = castAtGates(duelGates, size, 0);
      const intro = begun();
      const camera = createCamera();
      const far = centroidOf(view, TEAM_FROST);
      at(intro, camera, view, FLYBY_END_S + 0.4);
      const distance = camera.position.distanceTo(far);
      // A lone rider is framed from close by, not from across the terrace.
      expect(distance).toBeGreaterThan(20);
      expect(distance).toBeLessThan(size === 1 ? 35 : 70);
      expect(nearRock(camera.position, 2)).toBe(false);
      const onScreen = project(camera, far);
      expect(Math.abs(onScreen.x)).toBeLessThan(0.2);
      expect(Math.abs(onScreen.y)).toBeLessThan(0.2);
      for (let timeS = FAR_END_S; timeS <= INTRO_S; timeS += 0.05) {
        at(intro, camera, view, timeS);
        expect(nearRock(camera.position, 0.5), `size ${size} t=${timeS}`).toBe(false);
      }
    }
  });

  it('falls back to the map gate for a team with nobody in the view', () => {
    const view = fullCast(0);
    // Only Ember is here.
    view.dragonCount = MAX_TEAM_SIZE;
    const intro = begun();
    const camera = createCamera();
    at(intro, camera, view, FLYBY_END_S + 0.3);
    const gate = MAP.spawnGates[TEAM_FROST];
    if (gate === undefined) throw new Error('missing gate');
    const onScreen = project(camera, gate.position);
    expect(Math.abs(onScreen.x)).toBeLessThan(0.2);
    expect(Math.abs(onScreen.y)).toBeLessThan(0.2);
    // Nobody at all: still a finite camera on every frame.
    view.dragonCount = 0;
    for (let timeS = 0; timeS <= INTRO_S; timeS += 0.25) {
      expect(at(intro, camera, view, timeS)).toBe(true);
      expect(Number.isFinite(camera.position.x + camera.position.y + camera.position.z)).toBe(true);
      expect(Number.isFinite(camera.quaternion.x + camera.quaternion.w)).toBe(true);
    }
  });

  it('holds still with reduce motion, and cuts to the chase pose instead of swinging round', () => {
    const view = fullCast(2);
    const intro = begun();
    intro.setReduceMotion(true);
    const camera = createCamera();
    const poses: Vector3[] = [];
    const reference = createCamera();
    at(intro, reference, view, FLYBY_END_S);
    for (let timeS = FLYBY_END_S; timeS < FAR_END_S - EDGE_S; timeS += 0.05) {
      at(intro, camera, view, timeS);
      expect(camera.position.toArray()).toEqual(reference.position.toArray());
      expect(camera.quaternion.toArray()).toEqual(reference.quaternion.toArray());
    }
    for (let timeS = FAR_END_S; timeS <= INTRO_S; timeS += 0.02) {
      at(intro, camera, view, timeS);
      const known = poses.find((pose) => pose.distanceTo(camera.position) < 1e-9);
      if (known === undefined) poses.push(camera.position.clone());
      expect(rollOf(camera)).toBeCloseTo(0, 9);
    }
    // Exactly two still shots: the gate view, then the chase pose.
    expect(poses.length).toBe(2);
    const local = view.dragons[2];
    if (local === undefined) throw new Error('missing dragon');
    const chase = new ChaseCamera({ terrain: WORLD, minY: SEA_Y + 1.5 });
    chase.update(local, 1 / 60);
    expect((poses[1] as Vector3).distanceTo(chase.position)).toBeLessThan(0.01);
  });
});

describe('a map without an authored spline', () => {
  function expectSensible(points: readonly Vec3[], map: ArenaMap): void {
    expect(points.length).toBeGreaterThanOrEqual(4);
    const colliders = map.colliders;
    const point = createVec3();
    for (let i = 0; i <= 200; i++) {
      catmullRomPoint(point, points, i / 200);
      expect(Number.isFinite(point.x + point.y + point.z)).toBe(true);
      expect(point.y).toBeGreaterThan(colliders.cloudSeaY + 20);
      const fromCentre = Math.hypot(point.x - colliders.stormCenter.x, point.z - colliders.stormCenter.z);
      expect(fromCentre).toBeLessThan(colliders.stormRadius);
    }
    // From the rim, on the side away from the sun, toward the sky-well.
    const first = points[0] as Vec3;
    const last = points[points.length - 1] as Vec3;
    const sun = map.sky.sunDirection;
    expect((first.x - colliders.stormCenter.x) * sun.x + (first.z - colliders.stormCenter.z) * sun.z).toBeLessThan(0);
    const well = map.skyWell.position;
    expect(Math.hypot(last.x - well.x, last.z - well.z)).toBeLessThan(colliders.stormRadius * 0.5);
    expect(first.y).toBeGreaterThan(last.y);
  }

  it('derives a path from the colliders, the sun and the sky-well', () => {
    const out: MutableVec3[] = [];
    expectSensible(writeDefaultIntroSpline(out, MAP, null), MAP);
    const greybox = createGreyboxSpires();
    expect(greybox.introSpline).toBeUndefined();
    expectSensible(writeDefaultIntroSpline(out, greybox, null), greybox);
  });

  it('lifts the derived path clear of the rock when it has a terrain query', () => {
    const out: MutableVec3[] = [];
    writeDefaultIntroSpline(out, MAP, WORLD);
    expectSensible(out, MAP);
    const point = createVec3();
    for (let i = 0; i <= 400; i++) {
      catmullRomPoint(point, out, i / 400);
      expect(nearRock(point, 15), `derived path at ${i / 400}`).toBe(false);
    }
  });

  it('flies the derived path when the spline is missing, too short, or blocked', () => {
    const view = fullCast();
    const authored = createCamera();
    at(begun(), authored, view, 1);

    const { introSpline: _dropped, ...bare } = MAP;
    const short: ArenaMap = { ...MAP, introSpline: (MAP.introSpline ?? []).slice(0, 3) };
    // A path straight through the sky-well crystal.
    const blocked: ArenaMap = {
      ...MAP,
      introSpline: [
        { x: -300, y: 260, z: 0 },
        { x: -100, y: 260, z: 0 },
        { x: 100, y: 260, z: 0 },
        { x: 300, y: 260, z: 0 },
      ],
    };
    const derived = createCamera();
    at(begun(bare), derived, view, 1);
    expect(derived.position.distanceTo(authored.position)).toBeGreaterThan(20);
    for (const map of [short, blocked]) {
      const camera = createCamera();
      const intro = begun(map);
      at(intro, camera, view, 1);
      expect(camera.position.toArray()).toEqual(derived.position.toArray());
      for (let timeS = 0; timeS < FLYBY_END_S; timeS += 0.1) {
        at(intro, camera, view, timeS);
        expect(nearRock(camera.position, 15)).toBe(false);
      }
    }
    // Without a terrain query the authored spline is taken on trust.
    const trusted = createCamera();
    at(begun(blocked, false), trusted, view, 0);
    expect(trusted.position.x).toBeCloseTo(-300, 6);
  });
});
