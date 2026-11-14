/**
 * The death cam: who may be shown (the truth table), how long, where the orbit starts and how it
 * behaves when the killer changes, dies or veils, with rock in the way, and with reduce motion.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { wrapAngle, yawOfDirection } from '../../src/cinematics/camera-math';
import {
  DEATH_CAM_TUNING,
  createDeathCam,
  deathCamSubject,
} from '../../src/cinematics/death-cam';
import type { DeathCam } from '../../src/cinematics/types';
import {
  DRAGON_ANIM_GLIDE,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  MATCH_PHASES,
  MATCH_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type {
  MutableDragonView,
  MutableWorldView,
  PlayerId,
  TeamId,
  TerrainQuery,
} from '../../src/shared';

const LOCAL: PlayerId = 3;
const KILLER: PlayerId = 7;
const OTHER: PlayerId = 8;
const FRAME_S = 1 / 60;
const DEATH_CAM_S = MATCH_TUNING.deathCamS;

afterEach(() => {
  MATCH_TUNING.deathCamS = DEATH_CAM_S;
});

interface Cast {
  view: MutableWorldView;
  local: MutableDragonView;
  killer: MutableDragonView;
  other: MutableDragonView;
}

function addDragon(
  view: MutableWorldView,
  id: PlayerId,
  team: TeamId,
  x: number,
  y: number,
  z: number,
  flags: number,
): MutableDragonView {
  const dragon = acquireDragonView(view);
  dragon.id = id;
  dragon.team = team;
  dragon.classId = 'talon';
  dragon.position.x = x;
  dragon.position.y = y;
  dragon.position.z = z;
  dragon.orientation.x = 0;
  dragon.orientation.y = 0;
  dragon.orientation.z = 0;
  dragon.orientation.w = 1;
  dragon.velocity.x = 0;
  dragon.velocity.y = 0;
  dragon.velocity.z = 0;
  dragon.health = 1;
  dragon.stamina = 1;
  dragon.flags = flags;
  dragon.anim = DRAGON_ANIM_GLIDE;
  return dragon;
}

/**
 * The usual case: the local Ember dragon is down at (0, 300, 0); the Frost dragon that got it
 * hovers 80 m away on +X, facing +Z; another Frost dragon is far off on -X.
 */
function createCast(): Cast {
  const view = createWorldView();
  beginWorldView(view);
  const local = addDragon(view, LOCAL, TEAM_EMBER, 0, 300, 0, 0);
  const killer = addDragon(view, KILLER, TEAM_FROST, 80, 310, 0, DRAGON_FLAG_ALIVE);
  const other = addDragon(view, OTHER, TEAM_FROST, -400, 280, 50, DRAGON_FLAG_ALIVE);
  view.localDragonId = LOCAL;
  view.clock.phase = 'playing';
  view.local.valid = true;
  view.local.killerId = KILLER;
  return { view, local, killer, other };
}

function createCamera(): PerspectiveCamera {
  return new PerspectiveCamera(60, 16 / 9, 0.5, 6000);
}

function begun(terrain: TerrainQuery | null = null): DeathCam {
  const cam = createDeathCam();
  cam.begin(terrain);
  return cam;
}

/** Degrees between the camera's view axis and the direction to a point. */
function offAxisDeg(camera: PerspectiveCamera, x: number, y: number, z: number): number {
  const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const to = new Vector3(x, y, z).sub(camera.position).normalize();
  return (Math.acos(Math.min(1, forward.dot(to))) * 180) / Math.PI;
}

/** Heading from the killer to the camera. */
function azimuthOf(camera: PerspectiveCamera, killer: MutableDragonView): number {
  return yawOfDirection(camera.position.x - killer.position.x, camera.position.z - killer.position.z);
}

function levelDistance(camera: PerspectiveCamera, killer: MutableDragonView): number {
  return Math.hypot(camera.position.x - killer.position.x, camera.position.z - killer.position.z);
}

describe('who the death cam may show', () => {
  it('shows a living enemy that got the takedown', () => {
    const { view, killer } = createCast();
    expect(deathCamSubject(view)).toBe(killer);
    expect(begun().direct(createCamera(), view, FRAME_S)).toBe(true);
  });

  it('has nobody to show in every other case, and says so at once', () => {
    const cases: [string, (cast: Cast) => void][] = [
      ['the local dragon is alive', (c) => (c.local.flags = DRAGON_FLAG_ALIVE)],
      ['there is no killer (terrain, the storm)', (c) => (c.view.local.killerId = NO_PLAYER)],
      ['the combat block is not valid', (c) => (c.view.local.valid = false)],
      ['the killer is not in the view', (c) => (c.view.local.killerId = 42)],
      ['the killer is dead', (c) => (c.killer.flags = 0)],
      ['the killer is the local dragon itself', (c) => (c.view.local.killerId = LOCAL)],
      ['the killer is a veiled enemy', (c) => (c.killer.flags |= DRAGON_FLAG_VEILED)],
      ['this browser is a spectator', (c) => (c.view.localDragonId = NO_PLAYER)],
      ['the local dragon is not in the view', (c) => (c.view.localDragonId = 99)],
    ];
    for (const [name, change] of cases) {
      const cast = createCast();
      change(cast);
      expect(deathCamSubject(cast.view), name).toBeUndefined();
      const camera = createCamera();
      camera.position.set(1, 2, 3);
      expect(begun().direct(camera, cast.view, FRAME_S), name).toBe(false);
      // A refused frame leaves the camera alone.
      expect(camera.position.toArray(), name).toEqual([1, 2, 3]);
    }
  });

  it('may show a veiled team mate (friendly fire): its own team sees it anyway', () => {
    const cast = createCast();
    cast.killer.team = TEAM_EMBER;
    cast.killer.flags |= DRAGON_FLAG_VEILED;
    expect(deathCamSubject(cast.view)).toBe(cast.killer);
    expect(begun().direct(createCamera(), cast.view, FRAME_S)).toBe(true);
  });

  it('never shows a veiled enemy, whatever else is true of it', () => {
    const cast = createCast();
    cast.local.team = TEAM_FROST;
    cast.killer.team = TEAM_EMBER;
    cast.killer.flags = 0xffff;
    expect(deathCamSubject(cast.view)).toBeUndefined();
  });

  it('runs only in the playing and roundEnd phases, and not without a view', () => {
    for (const phase of MATCH_PHASES) {
      const cast = createCast();
      cast.view.clock.phase = phase;
      const expected = phase === 'playing' || phase === 'roundEnd';
      expect(begun().direct(createCamera(), cast.view, FRAME_S), phase).toBe(expected);
    }
    expect(begun().direct(createCamera(), null, FRAME_S)).toBe(false);
  });
});

describe('death cam timing', () => {
  it('runs for MATCH_TUNING.deathCamS from the fall, then hands the camera back for good', () => {
    const { view } = createCast();
    const cam = begun();
    const camera = createCamera();
    let shown = 0;
    let lastShownFrame = -1;
    for (let frame = 0; frame < 60 * 5; frame++) {
      if (cam.direct(camera, view, FRAME_S)) {
        shown++;
        // No gap: once it stops it does not come back.
        expect(frame).toBe(lastShownFrame + 1);
        lastShownFrame = frame;
      }
    }
    expect(shown / 60).toBeGreaterThan(DEATH_CAM_S - 0.05);
    expect(shown / 60).toBeLessThanOrEqual(DEATH_CAM_S + 0.05);
  });

  it('reads the duration live', () => {
    MATCH_TUNING.deathCamS = 1;
    const { view } = createCast();
    const cam = begun();
    const camera = createCamera();
    let shown = 0;
    for (let frame = 0; frame < 180; frame++) if (cam.direct(camera, view, FRAME_S)) shown++;
    expect(shown).toBeGreaterThanOrEqual(59);
    expect(shown).toBeLessThanOrEqual(61);
  });

  it('ends the orbit early when requestSkip is called', () => {
    const { view } = createCast();
    const cam = begun();
    const camera = createCamera();
    expect(cam.direct(camera, view, FRAME_S)).toBe(true);
    expect(cam.active).toBe(true);
    expect(cam.requestSkip()).toBe(true);
    expect(cam.requestSkip()).toBe(false);
    expect(cam.active).toBe(false);
    expect(cam.direct(camera, view, FRAME_S)).toBe(false);
  });

  it('counts a long hitch in full: the clock is the wall clock', () => {
    const { view } = createCast();
    const cam = begun();
    const camera = createCamera();
    expect(cam.direct(camera, view, FRAME_S)).toBe(true);
    expect(cam.direct(camera, view, DEATH_CAM_S + 0.5)).toBe(false);
  });

  it('starts fresh after a respawn', () => {
    const cast = createCast();
    const cam = begun();
    const camera = createCamera();
    for (let frame = 0; frame < 60 * 4; frame++) cam.direct(camera, cast.view, FRAME_S);
    expect(cam.direct(camera, cast.view, FRAME_S)).toBe(false);
    cast.local.flags = DRAGON_FLAG_ALIVE;
    expect(cam.direct(camera, cast.view, FRAME_S)).toBe(false);
    cast.local.flags = 0;
    expect(cam.direct(camera, cast.view, FRAME_S)).toBe(true);
  });

  it('forgets the orbit on reset() and on a phase that is not the match', () => {
    const cast = createCast();
    const cam = begun();
    const camera = createCamera();
    for (let frame = 0; frame < 60 * 4; frame++) cam.direct(camera, cast.view, FRAME_S);
    expect(cam.direct(camera, cast.view, FRAME_S)).toBe(false);
    // A round reset: whatever is down afterwards is a new fall.
    cam.reset();
    expect(cam.direct(camera, cast.view, FRAME_S)).toBe(true);

    for (let frame = 0; frame < 60 * 4; frame++) cam.direct(camera, cast.view, FRAME_S);
    cast.view.clock.phase = 'countdown';
    expect(cam.direct(camera, cast.view, FRAME_S)).toBe(false);
    cast.view.clock.phase = 'playing';
    expect(cam.direct(camera, cast.view, FRAME_S)).toBe(true);
  });

  it('waits for a killer id that arrives a few frames after the fall, without extra time', () => {
    const cast = createCast();
    cast.view.local.killerId = NO_PLAYER;
    const cam = begun();
    const camera = createCamera();
    for (let frame = 0; frame < 30; frame++) {
      expect(cam.direct(camera, cast.view, FRAME_S)).toBe(false);
    }
    cast.view.local.killerId = KILLER;
    let shown = 0;
    for (let frame = 0; frame < 60 * 4; frame++) if (cam.direct(camera, cast.view, FRAME_S)) shown++;
    // Half a second was already spent waiting.
    expect(shown / 60).toBeGreaterThan(DEATH_CAM_S - 0.6);
    expect(shown / 60).toBeLessThan(DEATH_CAM_S - 0.4);
  });
});

describe('the orbit', () => {
  it('starts on the side the victim was on, looking at the killer', () => {
    const { view, killer, local } = createCast();
    const camera = createCamera();
    expect(begun().direct(camera, view, FRAME_S)).toBe(true);
    // The victim fell on the -X side of the killer: the camera is there too.
    const toCameraX = camera.position.x - killer.position.x;
    const toVictimX = local.position.x - killer.position.x;
    expect(toCameraX * toVictimX).toBeGreaterThan(0);
    expect(azimuthOf(camera, killer)).toBeCloseTo(-Math.PI / 2, 6);
    // A 10 m class dragon: close enough to read, far enough for its 14 m of wing.
    expect(levelDistance(camera, killer)).toBeCloseTo(DEATH_CAM_TUNING.radiusStart, 6);
    expect(camera.position.y).toBeCloseTo(killer.position.y + DEATH_CAM_TUNING.heightStart, 6);
    expect(offAxisDeg(camera, killer.position.x, killer.position.y, killer.position.z)).toBeLessThan(5);
    // The place of death is behind the camera on that first frame.
    expect(offAxisDeg(camera, local.position.x, local.position.y, local.position.z)).toBeGreaterThan(120);
    expect(camera.fov).toBe(DEATH_CAM_TUNING.fovDeg);
  });

  it('circles slowly toward the tail, closing in, and keeps the killer in the middle', () => {
    const { view, killer } = createCast();
    const cam = begun();
    const camera = createCamera();
    cam.direct(camera, view, FRAME_S);
    // The killer faces +Z, so its tail is at azimuth PI; the camera starts at -PI/2.
    let last = azimuthOf(camera, killer);
    let turned = 0;
    for (let frame = 1; frame < 60 * DEATH_CAM_S - 1; frame++) {
      // The killer flies on at 60 m/s: the camera rides along.
      killer.position.z += 60 * FRAME_S;
      killer.velocity.z = 60;
      expect(cam.direct(camera, view, FRAME_S)).toBe(true);
      const azimuth = azimuthOf(camera, killer);
      const step = wrapAngle(azimuth - last);
      // Toward the tail by the short way is a shrinking azimuth here; never faster than allowed.
      expect(step).toBeLessThan(0);
      expect(Math.abs(step) / FRAME_S).toBeLessThanOrEqual(DEATH_CAM_TUNING.maxRate + 1e-6);
      expect(Math.abs(step) / FRAME_S).toBeGreaterThanOrEqual(DEATH_CAM_TUNING.minRate - 1e-6);
      turned += step;
      last = azimuth;
      const distance = levelDistance(camera, killer);
      expect(distance).toBeLessThanOrEqual(DEATH_CAM_TUNING.radiusStart + 1e-6);
      expect(distance).toBeGreaterThanOrEqual(DEATH_CAM_TUNING.radiusEnd - 1e-6);
      expect(offAxisDeg(camera, killer.position.x, killer.position.y, killer.position.z)).toBeLessThan(16);
    }
    // A quarter turn to the tail in 3 s: most of it is covered.
    expect(Math.abs(turned)).toBeGreaterThan(Math.PI / 2 - 0.2);
    expect(Math.abs(turned)).toBeLessThan(Math.PI / 2 + 0.05);
    expect(levelDistance(camera, killer)).toBeLessThan(DEATH_CAM_TUNING.radiusStart - 5);
  });

  it('follows the same path at 30 and at 120 frames per second', () => {
    const run = (fps: number): PerspectiveCamera => {
      const { view, killer } = createCast();
      const cam = begun();
      const camera = createCamera();
      cam.direct(camera, view, 1 / fps);
      for (let frame = 1; frame <= fps * 2; frame++) {
        killer.position.z += 40 / fps;
        killer.velocity.z = 40;
        cam.direct(camera, view, 1 / fps);
      }
      return camera;
    };
    const slow = run(30);
    const fast = run(120);
    expect(slow.position.distanceTo(fast.position)).toBeLessThan(0.05);
    expect(slow.quaternion.angleTo(fast.quaternion)).toBeLessThan(0.01);
  });

  it('stops on the frame the killer dies, veils or leaves', () => {
    const changes: [string, (cast: Cast) => void][] = [
      ['dies', (c) => (c.killer.flags = 0)],
      ['veils', (c) => (c.killer.flags |= DRAGON_FLAG_VEILED)],
      ['leaves', (c) => (c.killer.id = 55)],
    ];
    for (const [name, change] of changes) {
      const cast = createCast();
      const cam = begun();
      const camera = createCamera();
      for (let frame = 0; frame < 60; frame++) {
        expect(cam.direct(camera, cast.view, FRAME_S), name).toBe(true);
      }
      change(cast);
      const before = camera.position.clone();
      expect(cam.direct(camera, cast.view, FRAME_S), name).toBe(false);
      expect(camera.position.equals(before), name).toBe(true);
    }
  });

  it('cuts to a new killer and keeps the clock of the fall', () => {
    const cast = createCast();
    const cam = begun();
    const camera = createCamera();
    let shown = 0;
    for (let frame = 0; frame < 90; frame++) if (cam.direct(camera, cast.view, FRAME_S)) shown++;
    expect(levelDistance(camera, cast.killer)).toBeLessThan(DEATH_CAM_TUNING.radiusStart + 1);

    cast.view.local.killerId = OTHER;
    expect(cam.direct(camera, cast.view, FRAME_S)).toBe(true);
    shown++;
    // Round the new one at once, 480 m away: a cut, from the victim's side again.
    expect(levelDistance(camera, cast.other)).toBeCloseTo(DEATH_CAM_TUNING.radiusStart, 6);
    expect(camera.position.x).toBeGreaterThan(cast.other.position.x);
    expect(offAxisDeg(camera, cast.other.position.x, cast.other.position.y, cast.other.position.z)).toBeLessThan(5);

    for (let frame = 0; frame < 60 * 4; frame++) if (cam.direct(camera, cast.view, FRAME_S)) shown++;
    expect(shown / 60).toBeGreaterThan(DEATH_CAM_S - 0.05);
    expect(shown / 60).toBeLessThanOrEqual(DEATH_CAM_S + 0.05);
  });

  it('pulls the camera in when rock is between it and the killer', () => {
    // A wall 10 m from the killer on the victim's side: everything at x <= 70 is rock.
    const wallX = 70;
    const terrain: TerrainQuery = {
      raycast(ox, _oy, _oz, dx, dy, dz, maxDistance) {
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const ux = dx / length;
        if (ox <= wallX) return 0;
        if (ux >= 0) return -1;
        const distance = (wallX - ox) / ux;
        return distance <= maxDistance ? distance : -1;
      },
      clearance: () => -1,
    };
    const { view, killer } = createCast();
    const camera = createCamera();
    expect(begun(terrain).direct(camera, view, FRAME_S)).toBe(true);
    // On the killer's side of the wall, a margin clear of it (measured along the rising sight
    // line, so a little less square to the wall), still looking at the killer.
    expect(camera.position.x).toBeGreaterThan(wallX + DEATH_CAM_TUNING.rockMargin * 0.9);
    expect(camera.position.x).toBeLessThan(killer.position.x);
    const lookY = killer.position.y + DEATH_CAM_TUNING.lookLift;
    expect(offAxisDeg(camera, killer.position.x, lookY, killer.position.z)).toBeLessThan(0.01);

    // Without the wall the same frame sits at the full radius.
    const free = createCamera();
    begun().direct(free, view, FRAME_S);
    expect(free.position.x).toBeLessThan(wallX);
  });

  it('holds its side and distance with reduce motion: it only travels with the killer', () => {
    const { view, killer } = createCast();
    const cam = begun();
    cam.setReduceMotion(true);
    const camera = createCamera();
    cam.direct(camera, view, FRAME_S);
    const offset = camera.position.clone().sub(new Vector3().copy(killer.position));
    const orientation = camera.quaternion.clone();
    for (let frame = 0; frame < 120; frame++) {
      killer.position.x += 50 * FRAME_S;
      killer.velocity.x = 50;
      expect(cam.direct(camera, view, FRAME_S)).toBe(true);
      const now = camera.position.clone().sub(new Vector3().copy(killer.position));
      expect(now.distanceTo(offset)).toBeLessThan(1e-6);
      expect(camera.quaternion.angleTo(orientation)).toBeLessThan(1e-6);
    }
  });

  it('copes with a killer right above the place of death and with broken numbers', () => {
    const cast = createCast();
    cast.killer.position.x = 0;
    cast.killer.position.z = 0;
    const camera = createCamera();
    expect(begun().direct(camera, cast.view, FRAME_S)).toBe(true);
    expect(Number.isFinite(camera.position.x + camera.position.y + camera.position.z)).toBe(true);
    // No side to start from: it starts at the tail (the killer faces +Z).
    expect(camera.position.z).toBeLessThan(cast.killer.position.z);

    const broken = createCast();
    broken.killer.position.y = Number.NaN;
    expect(begun().direct(createCamera(), broken.view, FRAME_S)).toBe(false);

    const still = createCast();
    const cam = begun();
    expect(cam.direct(camera, still.view, 0)).toBe(true);
    expect(cam.direct(camera, still.view, Number.NaN)).toBe(true);
    expect(Number.isFinite(camera.position.x + camera.quaternion.x + camera.fov)).toBe(true);
  });
});
