/**
 * The death cam keeps out of dragons: the victim's falling body or a wing mate of the killer
 * at the camera's starting place, and the killer's own wings when rock pulls the camera in.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEATH_CAM_HALF_SPAN,
  DEATH_CAM_TUNING,
  createDeathCam,
  deathCamKeepOut,
} from '../../src/cinematics/death-cam';
import {
  DRAGON_ANIM_GLIDE,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type {
  DragonClassId,
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
const T = DEATH_CAM_TUNING;

function addDragon(
  view: MutableWorldView,
  id: PlayerId,
  team: TeamId,
  classId: DragonClassId,
  x: number,
  y: number,
  z: number,
  flags: number,
): MutableDragonView {
  const dragon = acquireDragonView(view);
  dragon.id = id;
  dragon.team = team;
  dragon.classId = classId;
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

interface Cast {
  view: MutableWorldView;
  local: MutableDragonView;
  killer: MutableDragonView;
  other: MutableDragonView;
}

/**
 * The killer hovers at (0, 300, 0). The victim went down on -X, `range` metres away and as high
 * as the camera starts, so at `range` = the orbit's radius the camera's start is the victim.
 * Another Frost dragon is far away until a test moves it.
 */
function createCast(range: number, otherClass: DragonClassId = 'bastion'): Cast {
  const view = createWorldView();
  beginWorldView(view);
  const local = addDragon(view, LOCAL, TEAM_EMBER, 'talon', -range, 300 + T.heightStart, 0, 0);
  const killer = addDragon(view, KILLER, TEAM_FROST, 'tempest', 0, 300, 0, DRAGON_FLAG_ALIVE);
  const other = addDragon(view, OTHER, TEAM_FROST, otherClass, 900, 300, 900, DRAGON_FLAG_ALIVE);
  view.localDragonId = LOCAL;
  view.clock.phase = 'playing';
  view.local.valid = true;
  view.local.killerId = KILLER;
  return { view, local, killer, other };
}

function createCamera(): PerspectiveCamera {
  return new PerspectiveCamera(60, 16 / 9, 0.5, 6000);
}

function distanceTo(camera: PerspectiveCamera, dragon: MutableDragonView): number {
  return Math.hypot(
    camera.position.x - dragon.position.x,
    camera.position.y - dragon.position.y,
    camera.position.z - dragon.position.z,
  );
}

function begun(terrain: TerrainQuery | null = null): ReturnType<typeof createDeathCam> {
  const cam = createDeathCam();
  cam.begin(terrain);
  return cam;
}

describe('the keep-out sizes', () => {
  it('cover the wingspan every class is built with', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      const file = resolve(__dirname, `../../public/assets/dragons/${classId}/manifest.json`);
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { wingspan: number };
      expect(manifest.wingspan, classId).toBeGreaterThan(5);
      expect(DEATH_CAM_HALF_SPAN[classId], classId).toBeGreaterThanOrEqual(manifest.wingspan / 2);
      expect(DEATH_CAM_HALF_SPAN[classId], classId).toBeLessThan(manifest.wingspan / 2 + 1);
      expect(deathCamKeepOut(classId)).toBeCloseTo(DEATH_CAM_HALF_SPAN[classId] + T.wingClearance, 9);
    }
  });

  it('leave the orbit itself outside the killer at every point', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      expect(Math.min(T.radiusStart, T.radiusEnd)).toBeGreaterThan(deathCamKeepOut(classId));
    }
  });
});

describe('the start of the orbit', () => {
  it('is untouched when no dragon is near it', () => {
    const { view, killer } = createCast(80);
    const camera = createCamera();
    expect(begun().direct(camera, view, FRAME_S)).toBe(true);
    expect(camera.position.x).toBeCloseTo(killer.position.x - T.radiusStart, 6);
    expect(camera.position.y).toBeCloseTo(killer.position.y + T.heightStart, 6);
    expect(camera.position.z).toBeCloseTo(killer.position.z, 6);
  });

  it('is outside the body of a victim that fell exactly there, on the very first frame', () => {
    const { view, local, killer } = createCast(T.radiusStart);
    const camera = createCamera();
    expect(begun().direct(camera, view, FRAME_S)).toBe(true);
    expect(distanceTo(camera, local)).toBeGreaterThanOrEqual(deathCamKeepOut('talon') - 1e-6);
    // It went up and out, not through the killer or miles away.
    expect(camera.position.y).toBeGreaterThan(local.position.y);
    expect(distanceTo(camera, killer)).toBeGreaterThan(deathCamKeepOut('tempest'));
    expect(distanceTo(camera, local)).toBeLessThan(deathCamKeepOut('talon') + 0.01);
  });

  it('is outside a wing mate of the killer at that place, by that class\'s wingspan', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      const { view, other, killer } = createCast(80, classId);
      // Nearly on the camera, a little to one side and below.
      other.position.x = killer.position.x - T.radiusStart + 1;
      other.position.y = killer.position.y + T.heightStart - 0.5;
      other.position.z = killer.position.z + 1.5;
      const camera = createCamera();
      expect(begun().direct(camera, view, FRAME_S)).toBe(true);
      expect(distanceTo(camera, other), classId).toBeGreaterThanOrEqual(deathCamKeepOut(classId) - 1e-6);
    }
    expect(deathCamKeepOut('bastion')).toBeGreaterThan(deathCamKeepOut('talon'));
  });

  it('does not swerve round a veiled enemy (that would give it away), but does round a veiled team mate', () => {
    const hidden = createCast(80);
    hidden.other.position.x = hidden.killer.position.x - T.radiusStart;
    hidden.other.position.y = hidden.killer.position.y + T.heightStart;
    hidden.other.position.z = hidden.killer.position.z;
    hidden.other.flags |= DRAGON_FLAG_VEILED;
    const camera = createCamera();
    begun().direct(camera, hidden.view, FRAME_S);
    expect(distanceTo(camera, hidden.other)).toBeCloseTo(0, 6);

    hidden.other.team = TEAM_EMBER;
    begun().direct(camera, hidden.view, FRAME_S);
    expect(distanceTo(camera, hidden.other)).toBeGreaterThanOrEqual(deathCamKeepOut('bastion') - 1e-6);
  });
});

describe('after the first frame', () => {
  /** Largest move of the camera relative to the killer between two frames, over the orbit. */
  function largestStep(cast: Cast, perFrame: (frame: number) => void): number {
    const cam = begun();
    const camera = createCamera();
    let largest = 0;
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let frame = 0; frame < 170; frame++) {
      perFrame(frame);
      if (!cam.direct(camera, cast.view, FRAME_S)) break;
      const x = camera.position.x - cast.killer.position.x;
      const y = camera.position.y - cast.killer.position.y;
      const z = camera.position.z - cast.killer.position.z;
      if (frame > 0) largest = Math.max(largest, Math.hypot(x - px, y - py, z - pz));
      px = x;
      py = y;
      pz = z;
    }
    return largest;
  }

  it('never pops: a dragon flying through the camera moves it a little each frame', () => {
    const plain = createCast(80);
    const calm = largestStep(plain, () => undefined);

    const cast = createCast(80);
    // From 60 m out, straight through the camera's starting place at 50 m/s, and on.
    const crossing = largestStep(cast, (frame) => {
      cast.other.position.x = cast.killer.position.x - T.radiusStart;
      cast.other.position.y = cast.killer.position.y + T.heightStart;
      cast.other.position.z = cast.killer.position.z - 60 + frame * FRAME_S * 50;
    });
    // The orbit alone moves the camera about 0.27 m a frame at its fastest. Getting out of the
    // way may add to that, but nothing like the 8 to 10 m a switch on or off would be.
    expect(calm).toBeLessThan(0.5);
    expect(crossing).toBeLessThan(2.5);
  });

  it('settles back onto the orbit once the dragon has gone', () => {
    const cast = createCast(T.radiusStart);
    const cam = begun();
    const camera = createCamera();
    cam.direct(camera, cast.view, FRAME_S);
    const lifted = camera.position.y;
    // The body falls away.
    for (let frame = 1; frame < 150; frame++) {
      cast.local.position.y -= 0.5;
      cam.direct(camera, cast.view, FRAME_S);
    }
    expect(camera.position.y).toBeLessThan(lifted - 2);
    expect(Math.hypot(camera.position.x, camera.position.z)).toBeLessThan(T.radiusStart + 0.3);
    expect(Math.hypot(camera.position.x, camera.position.z)).toBeGreaterThan(T.radiusEnd - 0.3);
  });

  it('snaps again when the killer changes (a new orbit is a cut)', () => {
    const cast = createCast(80);
    const cam = begun();
    const camera = createCamera();
    for (let frame = 0; frame < 30; frame++) cam.direct(camera, cast.view, FRAME_S);
    // The other dragon takes over as the killer; the first one now sits where its orbit starts.
    cast.other.position.x = 400;
    cast.other.position.y = 300;
    cast.other.position.z = 0;
    cast.local.position.x = 0;
    cast.view.local.killerId = OTHER;
    cast.killer.position.x = 400 - T.radiusStart;
    cast.killer.position.y = 300 + T.heightStart;
    cast.killer.position.z = 0;
    cam.direct(camera, cast.view, FRAME_S);
    expect(distanceTo(camera, cast.killer)).toBeGreaterThanOrEqual(deathCamKeepOut('tempest') - 1e-6);
  });
});

describe('rock that pulls the camera in', () => {
  /** A wall `distance` metres from the ray's origin along any level ray; open sky above. */
  function wallAt(distance: number, roof = -1): TerrainQuery {
    return {
      raycast(_ox, _oy, _oz, dx, dy, dz, maxDistance): number {
        const length = Math.hypot(dx, dy, dz);
        if (!(length > 0)) return -1;
        const steep = Math.abs(dy) / length;
        if (steep > 0.9) return roof >= 0 && roof <= maxDistance ? roof : -1;
        return distance <= maxDistance ? distance : -1;
      },
      clearance(): number {
        return -1;
      },
    };
  }

  it('lifts the camera over the killer\'s wings instead of putting it inside them', () => {
    const { view, killer } = createCast(80);
    const camera = createCamera();
    expect(begun(wallAt(4)).direct(camera, view, FRAME_S)).toBe(true);
    // Still in front of the rock ...
    expect(Math.hypot(camera.position.x - killer.position.x, camera.position.z - killer.position.z)).toBeLessThan(4);
    // ... and a wingspan clear of the dragon.
    expect(distanceTo(camera, killer)).toBeGreaterThanOrEqual(deathCamKeepOut('tempest') - 1e-6);
    expect(camera.position.y).toBeGreaterThan(killer.position.y + DEATH_CAM_HALF_SPAN.tempest);
  });

  it('but never lifts it into a roof: rock wins', () => {
    const { view, killer } = createCast(80);
    const camera = createCamera();
    expect(begun(wallAt(4, 3)).direct(camera, view, FRAME_S)).toBe(true);
    // The roof is 3 m above the pulled-in camera: it rises no more than that less the margin.
    expect(camera.position.y).toBeLessThanOrEqual(killer.position.y + T.lookLift + 2 + 3 - T.rockMargin + 1e-6);
  });

  it('leaves a camera the rock did not pull inside the wings where it was', () => {
    const { view, killer } = createCast(80);
    const camera = createCamera();
    expect(begun(wallAt(20)).direct(camera, view, FRAME_S)).toBe(true);
    expect(distanceTo(camera, killer)).toBeGreaterThan(deathCamKeepOut('tempest'));
    expect(camera.position.y).toBeLessThan(killer.position.y + T.heightStart);
  });
});

describe('the frame loop', () => {
  it('reads only the live dragons of the view', () => {
    const { view, killer } = createCast(80);
    // A stale pool entry beyond dragonCount, right on the camera: it must be ignored.
    const stale = addDragon(view, 99, TEAM_FROST, 'bastion', -T.radiusStart, 300 + T.heightStart, 0, DRAGON_FLAG_ALIVE);
    view.dragonCount -= 1;
    const camera = createCamera();
    begun().direct(camera, view, FRAME_S);
    expect(distanceTo(camera, stale)).toBeCloseTo(0, 6);
    expect(camera.position.x).toBeCloseTo(killer.position.x - T.radiusStart, 6);
  });
});
