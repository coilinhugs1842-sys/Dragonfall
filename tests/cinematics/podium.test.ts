import { Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  SEAT_COUNT,
  SEAT_DAMAGE,
  SEAT_MVP,
  SEAT_TAKEDOWNS,
  SEAT_TOP_Y,
  SEAT_X,
  SEAT_Z,
  choosePodiumSite,
  createPodium,
  createPodiumPlan,
  createPodiumSite,
  perchDrop,
  planPodium,
} from '../../src/cinematics/podium';
import type { PodiumSite } from '../../src/cinematics/podium';
import type { Podium, PodiumCast } from '../../src/cinematics/types';
import {
  DRAGON_ANIM_GLIDE,
  DRAGON_ANIM_LAND,
  DRAGON_ANIM_ROAR,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_BURNING,
  DRAGON_FLAG_SHIELDED,
  MODE_TUNING,
  NO_PLAYER,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  acquireProjectileView,
  acquireZoneView,
  beginWorldView,
  createShatteredSpires,
  createWorldView,
  findDragonView,
} from '../../src/shared';
import type {
  MatchPhase,
  MatchWinner,
  MutableWorldView,
  PlayerId,
  TerrainQuery,
  Vec3,
} from '../../src/shared';

const map = createShatteredSpires();
/** Dragons are about 12 m across and at most 3.2 m in hit radius: nearer than this is a clash. */
const SAFE_DISTANCE_M = 7;
/** A moment of the hold: everyone has arrived, the MVP has roared and settled. */
const HOLD_S = 11.9;

function newPodium(): Podium {
  return createPodium({ quality: QUALITY_PRESETS.medium, webgl: null });
}

function castOf(
  winner: MatchWinner,
  mvpId: PlayerId,
  mostTakedownsId: PlayerId,
  mostDamageId: PlayerId,
): PodiumCast {
  return { winner, mvpId, mostTakedownsId, mostDamageId };
}

/**
 * A frame as the game builds it at the end of a fight: `size` riders per team (Ember ids
 * 0..size-1, Frost size..2*size-1) scattered over the arena, some of them down, with a shot in
 * the air and the storm wall up.
 */
function buildFrame(view: MutableWorldView, size: number, phaseTimeS: number, phase: MatchPhase = 'results'): void {
  beginWorldView(view);
  for (let i = 0; i < size * 2; i++) {
    const dragon = acquireDragonView(view);
    dragon.id = i;
    dragon.team = i < size ? TEAM_EMBER : TEAM_FROST;
    dragon.classId = DRAGON_CLASS_IDS[i % DRAGON_CLASS_IDS.length] ?? 'talon';
    dragon.position.x = Math.sin(i * 2.1) * 300;
    dragon.position.y = 150 + i * 20;
    dragon.position.z = Math.cos(i * 1.3) * 300;
    dragon.orientation.x = 0;
    dragon.orientation.y = Math.sin(i);
    dragon.orientation.z = 0;
    dragon.orientation.w = Math.cos(i);
    dragon.velocity.x = 30;
    dragon.velocity.y = 0;
    dragon.velocity.z = -20;
    dragon.health = i % 3 === 2 ? 0 : 0.2;
    dragon.stamina = 0.3;
    dragon.flags =
      i % 3 === 2 ? DRAGON_FLAG_BURNING : DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING | DRAGON_FLAG_SHIELDED;
    dragon.anim = DRAGON_ANIM_GLIDE;
  }
  const shot = acquireProjectileView(view);
  shot.id = 1;
  shot.kind = 'fireBolt';
  shot.ownerId = 0;
  shot.team = TEAM_EMBER;
  const wall = acquireZoneView(view);
  wall.id = 0;
  wall.kind = 'stormWall';
  wall.team = null;
  wall.radius = 1000;
  view.clock.phase = phase;
  view.clock.phaseTimeS = phaseTimeS;
}

function showAt(podium: Podium, view: MutableWorldView, size: number, tS: number): void {
  buildFrame(view, size, tS);
  podium.apply(view, 0);
}

/** A world position in the podium's own frame (see podium-layout.ts). */
function toSite(site: PodiumSite, position: Vec3): { x: number; y: number; z: number } {
  const dx = position.x - site.x;
  const dz = position.z - site.z;
  return { x: dx * site.cos - dz * site.sin, y: position.y - site.y, z: dx * site.sin + dz * site.cos };
}

function snapshot(view: MutableWorldView): number[] {
  const numbers: number[] = [];
  for (let i = 0; i < view.dragonCount; i++) {
    const dragon = view.dragons[i];
    if (dragon === undefined) continue;
    numbers.push(
      dragon.id,
      dragon.position.x,
      dragon.position.y,
      dragon.position.z,
      dragon.orientation.x,
      dragon.orientation.y,
      dragon.orientation.z,
      dragon.orientation.w,
      dragon.velocity.x,
      dragon.velocity.y,
      dragon.velocity.z,
      dragon.anim,
      dragon.flags,
    );
  }
  return numbers;
}

/** Smallest distance between any two dragons of the frame. */
function nearestPair(view: MutableWorldView): number {
  let nearest = Infinity;
  for (let a = 0; a < view.dragonCount; a++) {
    for (let b = a + 1; b < view.dragonCount; b++) {
      const p = view.dragons[a]?.position;
      const q = view.dragons[b]?.position;
      if (p === undefined || q === undefined) continue;
      nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
    }
  }
  return nearest;
}

/** Award line-ups for a room of `size` per team: on the winning side, across teams, repeats, nobody. */
function awardSets(size: number): [PlayerId, PlayerId, PlayerId][] {
  const frost = size;
  return [
    [0, 1, 2],
    [frost, 0, frost + 1],
    [0, 0, 0],
    [0, 1, 1],
    [0, frost, frost],
    [1, 0, 0],
    [0, 0, frost],
    [NO_PLAYER, NO_PLAYER, NO_PLAYER],
    [0, NO_PLAYER, 1],
    [NO_PLAYER, frost, frost],
    // Riders who have left the room.
    [40, 41, 0],
  ];
}

const WINNERS: readonly MatchWinner[] = [TEAM_EMBER, TEAM_FROST, 'draw'];

describe('podium: the show as a function of the clock', () => {
  it('gives the same frame for the same clock, whatever was shown before', () => {
    const cast = castOf(TEAM_EMBER, 0, 1, 6);
    const first = newPodium();
    const second = newPodium();
    first.begin(cast, map, null);
    second.begin(cast, map, null);
    const view = createWorldView();
    const other = createWorldView();
    for (const tS of [0, 0.7, 3.3, 4.4, 5.2, 6.9, 7.6, 9, 11.5]) {
      showAt(first, view, 5, tS);
      const direct = snapshot(view);
      // The second podium wanders about the timeline first.
      showAt(second, other, 5, 11);
      showAt(second, other, 5, 2);
      showAt(second, other, 5, tS);
      expect(snapshot(other)).toEqual(direct);
    }
  });

  it('does not depend on the order of the dragons in the view', () => {
    const cast = castOf('draw', 6, 1, 3);
    const podium = newPodium();
    podium.begin(cast, map, null);
    const view = createWorldView();
    const shuffled = createWorldView();
    for (const tS of [1.5, 5.5, HOLD_S]) {
      showAt(podium, view, 4, tS);
      // The same riders, pool order reversed.
      buildFrame(shuffled, 4, tS);
      for (let i = 0; i < 4; i++) {
        const a = shuffled.dragons[i];
        const b = shuffled.dragons[7 - i];
        if (a === undefined || b === undefined) continue;
        [a.id, b.id] = [b.id, a.id];
        [a.team, b.team] = [b.team, a.team];
        [a.classId, b.classId] = [b.classId, a.classId];
      }
      podium.apply(shuffled, 0);
      for (let i = 0; i < view.dragonCount; i++) {
        const dragon = view.dragons[i];
        if (dragon === undefined) continue;
        const twin = findDragonView(shuffled, dragon.id);
        expect(twin?.position).toEqual(dragon.position);
        expect(twin?.anim).toBe(dragon.anim);
      }
    }
  });

  it('keeps every dragon (id, team, class), alive and clean, and drops shots and zones', () => {
    for (const size of [1, 3, 5]) {
      const podium = newPodium();
      podium.begin(castOf(TEAM_FROST, size, 0, 1), map, null);
      const view = createWorldView();
      for (let tS = 0; tS <= MODE_TUNING.resultsS; tS += 0.37) {
        showAt(podium, view, size, tS);
        expect(view.dragonCount).toBe(size * 2);
        expect(view.projectileCount).toBe(0);
        expect(view.zoneCount).toBe(0);
        for (let i = 0; i < view.dragonCount; i++) {
          const dragon = view.dragons[i];
          expect(dragon?.id).toBe(i);
          expect(dragon?.team).toBe(i < size ? TEAM_EMBER : TEAM_FROST);
          expect(dragon?.classId).toBe(DRAGON_CLASS_IDS[i % DRAGON_CLASS_IDS.length]);
          expect(dragon?.flags).toBe(DRAGON_FLAG_ALIVE);
          expect(dragon?.health).toBe(1);
          for (const value of snapshot(view)) expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it('leaves a frame of another phase alone, and does nothing before begin or after end', () => {
    const podium = newPodium();
    const view = createWorldView();
    buildFrame(view, 2, 3);
    const untouched = snapshot(view);
    podium.apply(view, 0);
    expect(snapshot(view)).toEqual(untouched);
    expect(view.zoneCount).toBe(1);

    podium.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    buildFrame(view, 2, 3, 'roundEnd');
    podium.apply(view, 0);
    expect(snapshot(view)).toEqual(untouched);
    expect(view.projectileCount).toBe(1);

    podium.end();
    buildFrame(view, 2, 3);
    podium.apply(view, 0);
    expect(snapshot(view)).toEqual(untouched);
  });

  it('follows a tick-stepped clock smoothly: the dragons move on every drawn frame', () => {
    const podium = newPodium();
    podium.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    const view = createWorldView();
    const exact = createWorldView();
    const reference = newPodium();
    reference.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    let last = Infinity;
    for (let frame = 0; frame < 120; frame++) {
      const timeS = 1 + frame / 60;
      // The host's phase clock: whole sim ticks.
      buildFrame(view, 5, Math.floor(timeS * 30) / 30);
      podium.apply(view, 1 / 60);
      showAt(reference, exact, 5, timeS);
      const drawn = view.dragons[0]?.position;
      const wanted = exact.dragons[0]?.position;
      if (drawn === undefined || wanted === undefined) throw new Error('no dragon');
      // Never the same place twice, and never far from where the phase clock says.
      expect(drawn.z).not.toBe(last);
      last = drawn.z;
      expect(Math.hypot(drawn.x - wanted.x, drawn.y - wanted.y, drawn.z - wanted.z)).toBeLessThan(3);
    }
  });
});

describe('podium: the cast', () => {
  it('never lets two dragons closer than a safe distance, 1v1 to 5v5, any awards', () => {
    const view = createWorldView();
    for (const size of [1, 2, 3, 4, 5]) {
      for (const winner of WINNERS) {
        for (const [mvp, takedowns, damage] of awardSets(size)) {
          const podium = newPodium();
          podium.begin(castOf(winner, mvp, takedowns, damage), map, null);
          let nearest = Infinity;
          let nearestAt = 0;
          for (let tS = 0; tS <= MODE_TUNING.resultsS + 0.001; tS += 0.05) {
            showAt(podium, view, size, tS);
            const distance = nearestPair(view);
            if (distance < nearest) {
              nearest = distance;
              nearestAt = tS;
            }
          }
          expect(
            nearest,
            `${size}v${size} winner=${winner} awards=${mvp},${takedowns},${damage} at ${nearestAt.toFixed(2)} s`,
          ).toBeGreaterThanOrEqual(SAFE_DISTANCE_M);
        }
      }
    }
    // Forty thousand frames: a second or two, more on a machine that is busy with other things.
  }, 60_000);

  /** Who is expected on each step: [MVP step, takedowns step, damage step], NO_PLAYER = empty. */
  const seatings: {
    name: string;
    size: number;
    winner: MatchWinner;
    awards: [PlayerId, PlayerId, PlayerId];
    steps: [PlayerId, PlayerId, PlayerId];
  }[] = [
    { name: 'three riders of the winning team', size: 5, winner: TEAM_EMBER, awards: [0, 1, 2], steps: [0, 1, 2] },
    { name: 'awards across both teams', size: 5, winner: TEAM_FROST, awards: [2, 7, 9], steps: [2, 7, 9] },
    { name: 'one rider with all three', size: 5, winner: TEAM_EMBER, awards: [3, 3, 3], steps: [3, NO_PLAYER, NO_PLAYER] },
    { name: 'the MVP also has the takedowns', size: 3, winner: TEAM_EMBER, awards: [0, 0, 4], steps: [0, NO_PLAYER, 4] },
    { name: 'the MVP also has the damage', size: 3, winner: TEAM_FROST, awards: [4, 1, 4], steps: [4, 1, NO_PLAYER] },
    { name: 'takedowns and damage on one rider', size: 4, winner: TEAM_EMBER, awards: [0, 5, 5], steps: [0, 5, NO_PLAYER] },
    { name: 'nobody earned anything', size: 2, winner: TEAM_EMBER, awards: [NO_PLAYER, NO_PLAYER, NO_PLAYER], steps: [NO_PLAYER, NO_PLAYER, NO_PLAYER] },
    { name: 'no MVP', size: 2, winner: TEAM_FROST, awards: [NO_PLAYER, 1, 2], steps: [NO_PLAYER, 1, 2] },
    { name: 'a draw still has its awards', size: 5, winner: 'draw', awards: [6, 0, 8], steps: [6, 0, 8] },
    { name: 'a draw, one rider with everything', size: 1, winner: 'draw', awards: [1, 1, 1], steps: [1, NO_PLAYER, NO_PLAYER] },
    { name: 'an award for a rider who left', size: 1, winner: TEAM_EMBER, awards: [0, 7, 1], steps: [0, NO_PLAYER, 1] },
    { name: '1v1, the loser did the damage', size: 1, winner: TEAM_EMBER, awards: [0, 0, 1], steps: [0, NO_PLAYER, 1] },
  ];

  for (const seating of seatings) {
    it(`seats ${seating.name}`, () => {
      const podium = newPodium();
      const [mvp, takedowns, damage] = seating.awards;
      podium.begin(castOf(seating.winner, mvp, takedowns, damage), map, null);
      const site = choosePodiumSite(createPodiumSite(), map, null);
      const view = createWorldView();
      showAt(podium, view, seating.size, HOLD_S);
      for (let seat = 0; seat < SEAT_COUNT; seat++) {
        const holder = seating.steps[seat] ?? NO_PLAYER;
        // Whoever stands over this step.
        let found: PlayerId = NO_PLAYER;
        for (let i = 0; i < view.dragonCount; i++) {
          const dragon = view.dragons[i];
          if (dragon === undefined) continue;
          const at = toSite(site, dragon.position);
          if (Math.hypot(at.x - (SEAT_X[seat] ?? 0), at.z - (SEAT_Z[seat] ?? 0)) < 6) {
            expect(found, 'two dragons over one step').toBe(NO_PLAYER);
            found = dragon.id;
            // Its feet are on the stone, and it is standing still in the perched pose.
            expect(at.y - perchDrop(dragon.classId)).toBeCloseTo(SEAT_TOP_Y[seat] ?? 0, 6);
            expect(dragon.anim).toBe(DRAGON_ANIM_LAND);
            expect(Math.hypot(dragon.velocity.x, dragon.velocity.y, dragon.velocity.z)).toBe(0);
          }
        }
        expect(found, `step ${seat}`).toBe(holder);
      }
    });
  }

  it('puts the MVP highest, most takedowns at its right hand, most damage at its left', () => {
    const podium = newPodium();
    podium.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    const view = createWorldView();
    showAt(podium, view, 5, HOLD_S);
    const mvp = findDragonView(view, 0);
    const takedowns = findDragonView(view, 1);
    const damage = findDragonView(view, 2);
    if (mvp === undefined || takedowns === undefined || damage === undefined) throw new Error('missing');
    expect(SEAT_TOP_Y[SEAT_MVP]).toBeGreaterThan(SEAT_TOP_Y[SEAT_TAKEDOWNS] ?? Infinity);
    expect(SEAT_TOP_Y[SEAT_TAKEDOWNS]).toBeGreaterThan(SEAT_TOP_Y[SEAT_DAMAGE] ?? Infinity);
    // The MVP's own left: +X turned by its orientation.
    const q = mvp.orientation;
    const leftX = 1 - 2 * (q.y * q.y + q.z * q.z);
    const leftZ = 2 * (q.x * q.z - q.w * q.y);
    const side = (other: Vec3): number =>
      (other.x - mvp.position.x) * leftX + (other.z - mvp.position.z) * leftZ;
    expect(side(takedowns.position)).toBeLessThan(-5);
    expect(side(damage.position)).toBeGreaterThan(5);
  });

  it('has the MVP roar once, in the air over its step, and land once after it', () => {
    const podium = newPodium();
    podium.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    const site = choosePodiumSite(createPodiumSite(), map, null);
    const view = createWorldView();
    let roars = 0;
    let landings = 0;
    let last = DRAGON_ANIM_GLIDE as number;
    let others = 0;
    for (let tS = 0; tS <= MODE_TUNING.resultsS; tS += 0.05) {
      showAt(podium, view, 5, tS);
      for (let i = 0; i < view.dragonCount; i++) {
        const dragon = view.dragons[i];
        if (dragon === undefined || dragon.anim !== DRAGON_ANIM_ROAR) continue;
        if (dragon.id !== 0) others++;
      }
      const mvp = findDragonView(view, 0);
      if (mvp === undefined) throw new Error('missing');
      if (mvp.anim === DRAGON_ANIM_ROAR) {
        if (last !== DRAGON_ANIM_ROAR) roars++;
        // The roar hangs the tail far under the dragon: it needs the air.
        expect(toSite(site, mvp.position).y - (SEAT_TOP_Y[SEAT_MVP] ?? 0)).toBeGreaterThan(5);
      }
      // The animator replays `land` every time the clip is asked for again.
      if (mvp.anim === DRAGON_ANIM_LAND && last !== DRAGON_ANIM_LAND) landings++;
      last = mvp.anim;
    }
    expect(roars).toBe(1);
    expect(landings).toBe(1);
    expect(others).toBe(0);
    expect(last).toBe(DRAGON_ANIM_LAND);
  });

  it('lands every award winner once and has all three standing by 9.5 s', () => {
    const podium = newPodium();
    podium.begin(castOf(TEAM_FROST, 5, 6, 0), map, null);
    const view = createWorldView();
    const landings = [0, 0, 0];
    const last = [-1, -1, -1];
    const holders = [5, 6, 0];
    for (let tS = 0; tS <= MODE_TUNING.resultsS; tS += 0.05) {
      showAt(podium, view, 5, tS);
      holders.forEach((id, seat) => {
        const anim = findDragonView(view, id)?.anim ?? -1;
        if (anim === DRAGON_ANIM_LAND && last[seat] !== DRAGON_ANIM_LAND) landings[seat] = (landings[seat] ?? 0) + 1;
        last[seat] = anim;
      });
      if (tS < 9.5) continue;
      for (const id of holders) {
        const velocity = findDragonView(view, id)?.velocity;
        expect(Math.hypot(velocity?.x ?? 1, velocity?.y ?? 1, velocity?.z ?? 1)).toBe(0);
      }
    }
    expect(landings).toEqual([1, 1, 1]);
  });

  it('never puts an award winner lower than its step, and nobody leaves the stone again', () => {
    const podium = newPodium();
    podium.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    const site = choosePodiumSite(createPodiumSite(), map, null);
    const view = createWorldView();
    const down = [false, false, false];
    for (let tS = 4.5; tS <= MODE_TUNING.resultsS; tS += 0.05) {
      showAt(podium, view, 5, tS);
      for (const [id, seat] of [
        [0, SEAT_MVP],
        [1, SEAT_TAKEDOWNS],
        [2, SEAT_DAMAGE],
      ] as const) {
        const dragon = findDragonView(view, id);
        if (dragon === undefined) throw new Error('missing');
        const lift = toSite(site, dragon.position).y - perchDrop(dragon.classId) - (SEAT_TOP_Y[seat] ?? 0);
        expect(lift).toBeGreaterThan(-1e-6);
        if (down[seat] === true) expect(lift).toBeLessThan(1e-6);
        else if (lift < 1e-6) down[seat] = true;
      }
    }
    expect(down).toEqual([true, true, true]);
  });

  it('flies the whole winning team in the pass, the fallen included, led by the MVP', () => {
    const view = createWorldView();
    buildFrame(view, 5, 0);
    const plan = planPodium(createPodiumPlan(), view, castOf(TEAM_FROST, 7, 0, 9));
    for (let i = 0; i < view.dragonCount; i++) {
      const frost = view.dragons[i]?.team === TEAM_FROST;
      expect(plan.passGroup[i]).toBe(frost ? 0 : -1);
      if (view.dragons[i]?.id === 7) expect(plan.passRow[i]).toBe(0);
    }
    // In a draw both teams fly, the MVP's team in front.
    const draw = planPodium(createPodiumPlan(), view, castOf('draw', 7, 0, 9));
    for (let i = 0; i < view.dragonCount; i++) {
      expect(draw.passGroup[i]).toBe(view.dragons[i]?.team === TEAM_FROST ? 0 : 1);
    }
  });
});

describe('podium: per-frame cost', () => {
  it('allocates nothing in the view after the first frame: the pools keep their size', () => {
    const podium = newPodium();
    podium.begin(castOf(TEAM_EMBER, 0, 1, 6), map, null);
    const view = createWorldView();
    showAt(podium, view, 5, 0);
    const dragons = view.dragons.length;
    const projectiles = view.projectiles.length;
    const zones = view.zones.length;
    const positions = view.dragons.map((dragon) => dragon.position);
    const orientations = view.dragons.map((dragon) => dragon.orientation);
    for (let frame = 1; frame <= 720; frame++) {
      buildFrame(view, 5, frame / 60);
      podium.apply(view, 1 / 60);
    }
    expect(view.dragons.length).toBe(dragons);
    expect(view.projectiles.length).toBe(projectiles);
    expect(view.zones.length).toBe(zones);
    view.dragons.forEach((dragon, i) => {
      expect(dragon.position).toBe(positions[i]);
      expect(dragon.orientation).toBe(orientations[i]);
    });
  });
});

describe('podium: the camera', () => {
  function cameraAt(podium: Podium, view: MutableWorldView, aspect: number): PerspectiveCamera {
    const camera = new PerspectiveCamera(55, aspect, 0.5, 6000);
    expect(podium.direct(camera, view, 0)).toBe(true);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return camera;
  }

  function frustumOf(camera: PerspectiveCamera): Frustum {
    return new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
  }

  it('directs only while active and in the results phase', () => {
    const podium = newPodium();
    const camera = new PerspectiveCamera();
    const view = createWorldView();
    buildFrame(view, 2, 1);
    expect(podium.active).toBe(false);
    expect(podium.object.visible).toBe(false);
    expect(podium.direct(camera, view, 0)).toBe(false);

    podium.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    expect(podium.active).toBe(true);
    expect(podium.object.visible).toBe(true);
    expect(podium.direct(camera, null, 0)).toBe(false);
    for (const phase of ['lobby', 'intro', 'countdown', 'playing', 'roundEnd'] as const) {
      buildFrame(view, 2, 1, phase);
      expect(podium.direct(camera, view, 0)).toBe(false);
    }
    buildFrame(view, 2, 1);
    expect(podium.direct(camera, view, 0)).toBe(true);
    expect(Number.isFinite(camera.position.x + camera.position.y + camera.position.z)).toBe(true);
    expect(camera.position.y).toBeGreaterThan(map.colliders.cloudSeaY + 50);

    podium.end();
    expect(podium.active).toBe(false);
    expect(podium.object.visible).toBe(false);
    expect(podium.direct(camera, view, 0)).toBe(false);
    podium.dispose();
  });

  it('keeps the sun on the camera side, off to one side of the dragons', () => {
    const site = choosePodiumSite(createPodiumSite(), map, null);
    const sun = map.sky.sunDirection;
    const flat = Math.hypot(sun.x, sun.z);
    // The site's +Z is where the seated dragons look and where the camera stands.
    const facing = (sun.x * site.sin + sun.z * site.cos) / flat;
    const right = (sun.x * site.cos - sun.z * site.sin) / flat;
    expect(facing).toBeGreaterThan(0.2);
    expect(facing).toBeLessThan(0.8);
    expect(right * site.mirror).toBeGreaterThan(0.5);
    expect(site.y).toBeLessThan(map.colliders.ceilingY);
    expect(site.y).toBeGreaterThan(map.colliders.cloudSeaY + 100);
  });

  it('moves to a place the rock leaves free', () => {
    const open = choosePodiumSite(createPodiumSite(), map, null);
    // Solid rock up to 10 m above the first choice: the site has to go up.
    const top = open.y + 10;
    const terrain: TerrainQuery = {
      raycast: () => -1,
      clearance: (_x, y, _z, maxDistance) => (y - top <= maxDistance ? Math.max(0, y - top) : -1),
    };
    const lifted = choosePodiumSite(createPodiumSite(), map, terrain);
    expect(lifted.y).toBeGreaterThan(open.y + 40);
    expect(lifted.x).toBe(open.x);
    // Nothing free anywhere: back to the first choice rather than nowhere.
    const solid: TerrainQuery = { raycast: () => 0, clearance: () => 0 };
    expect(choosePodiumSite(createPodiumSite(), map, solid).y).toBe(open.y);
  });

  it('looks at the steps for the landings, with all three well inside the frame', () => {
    const podium = newPodium();
    podium.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    const view = createWorldView();
    for (const tS of [7.6, 9, HOLD_S]) {
      showAt(podium, view, 5, tS);
      const camera = cameraAt(podium, view, 16 / 9);
      for (const id of [0, 1, 2]) {
        const dragon = findDragonView(view, id);
        if (dragon === undefined) throw new Error('missing');
        const projected = new Vector3(dragon.position.x, dragon.position.y, dragon.position.z).project(camera);
        // The middle band: clear of the screen's edges, of the score table at the right, of
        // the banner along the top and of the award cards along the bottom.
        expect(projected.x).toBeGreaterThan(-0.62);
        expect(projected.x).toBeLessThan(0.34);
        expect(projected.y).toBeGreaterThan(-0.5);
        expect(projected.y).toBeLessThan(0.5);
      }
    }
  });

  it('hides every jump: a dragon changes place only outside the frame', () => {
    for (const winner of WINNERS) {
      for (const aspect of [16 / 9, 21 / 9, 4 / 3]) {
        const cast = castOf(winner, 0, 6, 2);
        const podium = newPodium();
        podium.begin(cast, map, null);
        const view = createWorldView();
        buildFrame(view, 5, 0);
        const plan = planPodium(createPodiumPlan(), view, cast);
        const body = new Sphere(new Vector3(), 7);
        for (let i = 0; i < view.dragonCount; i++) {
          if ((plan.passGroup[i] ?? -1) < 0) {
            // Not in the pass: it waits where it will come from, unseen until it leaves.
            for (let tS = 0; tS < (plan.startS[i] ?? 0); tS += 0.1) {
              showAt(podium, view, 5, tS);
              const at = view.dragons[i]?.position;
              if (at === undefined) throw new Error('missing');
              body.center.set(at.x, at.y, at.z);
              expect(
                frustumOf(cameraAt(podium, view, aspect)).intersectsSphere(body),
                `rider ${view.dragons[i]?.id} waiting in frame at ${tS.toFixed(1)} s (winner ${winner})`,
              ).toBe(false);
            }
            continue;
          }
          // In the pass: out of frame just before its pass ends and just after.
          const cut = plan.cutS[i] ?? 0;
          for (const tS of [cut - 0.02, cut + 0.02]) {
            showAt(podium, view, 5, tS);
            const at = view.dragons[i]?.position;
            if (at === undefined) throw new Error('missing');
            body.center.set(at.x, at.y, at.z);
            expect(
              frustumOf(cameraAt(podium, view, aspect)).intersectsSphere(body),
              `rider ${view.dragons[i]?.id} jumps in frame at ${tS.toFixed(2)} s (winner ${winner}, aspect ${aspect.toFixed(2)})`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('with reduced motion holds two still shots with one cut between them', () => {
    const podium = newPodium();
    podium.setReduceMotion(true);
    podium.begin(castOf(TEAM_EMBER, 0, 1, 2), map, null);
    const view = createWorldView();
    const poseAt = (tS: number): number[] => {
      showAt(podium, view, 5, tS);
      const camera = cameraAt(podium, view, 16 / 9);
      return [...camera.position.toArray(), ...camera.quaternion.toArray(), camera.fov];
    };
    const wide = poseAt(0.2);
    expect(poseAt(2)).toEqual(wide);
    expect(poseAt(4.2)).toEqual(wide);
    const steps = poseAt(5);
    expect(steps).not.toEqual(wide);
    expect(poseAt(8)).toEqual(steps);
    expect(poseAt(HOLD_S)).toEqual(steps);

    // The ordinary version keeps moving.
    podium.setReduceMotion(false);
    expect(poseAt(8)).not.toEqual(poseAt(HOLD_S));
  });
});
