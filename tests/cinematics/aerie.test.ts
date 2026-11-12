/**
 * The aerie as `src/game` uses it, without a renderer: the contract of `createAerie`, the
 * camera's shots, the name-card projection and the fixed pools.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  AERIE_PERCH_COUNT,
  PLATE_HEIGHT,
  SHOT_EASE_S,
  WIDE_FOV,
  createAerie,
  createAerieLayout,
  perchSlot,
  projectToViewport,
  wideDistance,
} from '../../src/cinematics/aerie';
import type { Aerie, MutableLobbyPlate } from '../../src/cinematics/types';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_CLASS_IDS,
  MATCH_TUNING,
  NO_PLAYER,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  createShatteredSpires,
} from '../../src/shared';
import type { LobbyPhase, LobbyPlayer, LobbyState, PlayerId } from '../../src/shared';

const map = createShatteredSpires();
const layout = createAerieLayout(map);
const DT = 1 / 60;

function rider(id: PlayerId, ready = false): LobbyPlayer {
  return {
    id,
    name: `Rider ${id}`,
    side: id < 5 ? TEAM_EMBER : TEAM_FROST,
    perch: id % 5,
    classId: DRAGON_CLASS_IDS[id % DRAGON_CLASS_IDS.length] ?? 'talon',
    ready,
    isHost: id === 0,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: false,
  };
}

function room(ids: readonly PlayerId[], phase: LobbyPhase = 'lobby', ready = false): LobbyState {
  return {
    roomCode: 'TESTS',
    phase,
    hostId: 0,
    players: ids.map((id) => rider(id, ready)),
    settings: DEFAULT_HOST_SETTINGS,
  };
}

const ALL: readonly PlayerId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function newAerie(): Aerie {
  return createAerie({ map, quality: QUALITY_PRESETS.medium, webgl: null });
}

function newCamera(aspect = 16 / 9): PerspectiveCamera {
  const camera = new PerspectiveCamera(55, aspect, 0.5, 6000);
  camera.updateProjectionMatrix();
  return camera;
}

/** One lobby frame as the game runs it: update, direct, then the stage refreshes the matrices. */
function frame(aerie: Aerie, camera: PerspectiveCamera, lobby: LobbyState, local: PlayerId = NO_PLAYER): void {
  aerie.update(lobby, local, DT);
  expect(aerie.direct(camera, null, DT)).toBe(true);
  camera.updateMatrixWorld();
}

function run(aerie: Aerie, camera: PerspectiveCamera, lobby: LobbyState, seconds: number): void {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) frame(aerie, camera, lobby);
}

describe('createAerie without a renderer', () => {
  it('builds a set object, perches the cast and places the camera', () => {
    const aerie = newAerie();
    const camera = newCamera();
    frame(aerie, camera, room(ALL));
    expect(aerie.object.children.length).toBeGreaterThan(0);
    expect(aerie.view.dragonCount).toBe(10);
    expect(aerie.focusId).toBe(NO_PLAYER);
    expect(aerie.launchProgress).toBe(0);
    expect(camera.fov).toBeCloseTo(WIDE_FOV, 6);
    // In front of the terraces, above the cloud sea, looking into the picture.
    expect(camera.position.y).toBeGreaterThan(layout.cloudSeaY + 50);
    const forward = camera.getWorldDirection(new Vector3());
    const into = { x: -layout.sinYaw, z: -layout.cosYaw };
    expect(forward.x * into.x + forward.z * into.z).toBeGreaterThan(0.9);
    aerie.setQuality(QUALITY_PRESETS.low);
    aerie.setQuality(QUALITY_PRESETS.high);
    aerie.dispose();
  });

  it('reports the launch as 0..1 over lobbyLaunchS, 1 in the match, 0 back in the lobby', () => {
    const aerie = newAerie();
    const camera = newCamera();
    frame(aerie, camera, room(ALL));
    const starting = room(ALL, 'starting');
    const half = Math.round(MATCH_TUNING.lobbyLaunchS / 2 / DT);
    for (let i = 0; i < half; i++) frame(aerie, camera, starting);
    expect(aerie.launchProgress).toBeCloseTo(0.5, 2);
    for (let i = 0; i < half + 5; i++) frame(aerie, camera, starting);
    expect(aerie.launchProgress).toBe(1);
    expect(aerie.view.dragonCount).toBe(0);
    frame(aerie, camera, room(ALL, 'inMatch'));
    expect(aerie.launchProgress).toBe(1);
    frame(aerie, camera, room(ALL));
    expect(aerie.launchProgress).toBe(0);
    expect(aerie.view.dragonCount).toBe(10);
  });

  it('empties on reset', () => {
    const aerie = newAerie();
    const camera = newCamera();
    frame(aerie, camera, room(ALL));
    aerie.focus(2);
    aerie.reset();
    expect(aerie.view.dragonCount).toBe(0);
    expect(aerie.focusId).toBe(NO_PLAYER);
    expect(aerie.launchProgress).toBe(0);
  });
});

describe('aerie camera', () => {
  it('keeps every perch inside the middle band of the wide shot, from 4:3 to 21:9', () => {
    for (const aspect of [4 / 3, 16 / 10, 16 / 9, 21 / 9]) {
      const aerie = newAerie();
      const camera = newCamera(aspect);
      const lobby = room(ALL);
      const at = { x: 0, y: 0 };
      // All round the drift loop.
      for (let step = 0; step < 90; step++) {
        frame(aerie, camera, lobby);
        for (const perch of layout.perches) {
          // The dragon's chest, a few metres above the stone.
          const seen = projectToViewport(camera, perch.position.x, perch.position.y + 3, perch.position.z, at);
          expect(seen).toBe(true);
          expect(at.x, `aspect ${aspect}`).toBeGreaterThan(0.1);
          expect(at.x, `aspect ${aspect}`).toBeLessThan(0.9);
          expect(at.y).toBeGreaterThan(0.12);
          expect(at.y).toBeLessThan(0.88);
        }
        // Jump a second ahead between samples.
        for (let i = 0; i < 59; i++) aerie.direct(camera, null, DT);
        camera.updateMatrixWorld();
      }
    }
  });

  it('stands further back for a narrower picture', () => {
    expect(wideDistance(4 / 3)).toBeGreaterThan(wideDistance(16 / 9));
    expect(wideDistance(16 / 9)).toBeGreaterThanOrEqual(wideDistance(21 / 9));
  });

  it('drifts slowly and never jumps', () => {
    const aerie = newAerie();
    const camera = newCamera();
    const lobby = room(ALL);
    frame(aerie, camera, lobby);
    const start = camera.position.clone();
    const before = camera.position.clone();
    let moved = 0;
    for (let i = 0; i < 600; i++) {
      frame(aerie, camera, lobby);
      const step = camera.position.distanceTo(before);
      // Under 3 m/s.
      expect(step).toBeLessThan(3 * DT);
      moved += step;
      before.copy(camera.position);
    }
    expect(moved).toBeGreaterThan(1);
    expect(camera.position.distanceTo(start)).toBeGreaterThan(0.5);
  });

  it('eases to a close-up of a rider and back', () => {
    const aerie = newAerie();
    const camera = newCamera();
    const lobby = room(ALL);
    frame(aerie, camera, lobby);
    const wide = camera.position.clone();
    const perch = layout.perches[perchSlot(TEAM_FROST, 1)];
    if (perch === undefined) throw new Error('missing perch');
    const seat = new Vector3(perch.position.x, perch.position.y, perch.position.z);

    aerie.focus(6);
    expect(aerie.focusId).toBe(6);
    // An ease, not a cut: the first frame has hardly moved.
    frame(aerie, camera, lobby);
    expect(camera.position.distanceTo(wide)).toBeLessThan(2);
    run(aerie, camera, lobby, SHOT_EASE_S + 0.1);
    const distance = camera.position.distanceTo(seat);
    expect(distance).toBeGreaterThan(8);
    expect(distance).toBeLessThan(25);
    // Three-quarter front: in front of the dragon, off to one side.
    const facing = new Vector3(Math.sin(perch.yaw), 0, Math.cos(perch.yaw));
    const toCamera = camera.position.clone().sub(seat).setY(0).normalize();
    const cos = facing.dot(toCamera);
    expect(cos).toBeGreaterThan(0.5);
    expect(cos).toBeLessThan(0.95);
    // Slightly below the eye line: under the card anchor, looking up at it.
    expect(camera.position.y).toBeLessThan(perch.position.y + PLATE_HEIGHT - 2);
    expect(camera.position.y).toBeGreaterThan(perch.position.y);
    // The dragon is in the middle of the picture.
    const at = { x: 0, y: 0 };
    expect(projectToViewport(camera, seat.x, seat.y + 4, seat.z, at)).toBe(true);
    expect(Math.abs(at.x - 0.5)).toBeLessThan(0.15);
    expect(Math.abs(at.y - 0.5)).toBeLessThan(0.2);

    aerie.focus(null);
    expect(aerie.focusId).toBe(NO_PLAYER);
    run(aerie, camera, lobby, SHOT_EASE_S + 0.1);
    expect(camera.position.distanceTo(wide)).toBeLessThan(3);
    expect(camera.fov).toBeCloseTo(WIDE_FOV, 6);
  });

  it('lets go of the close-up when its rider leaves', () => {
    const aerie = newAerie();
    const camera = newCamera();
    frame(aerie, camera, room(ALL));
    aerie.focus(3);
    expect(aerie.focusId).toBe(3);
    frame(aerie, camera, room(ALL));
    expect(aerie.focusId).toBe(3);
    frame(aerie, camera, room(ALL.filter((id) => id !== 3)));
    expect(aerie.focusId).toBe(NO_PLAYER);
  });

  it('cannot focus on somebody without a perch', () => {
    const aerie = newAerie();
    const camera = newCamera();
    frame(aerie, camera, room([0, 5]));
    aerie.focus(7);
    expect(aerie.focusId).toBe(NO_PLAYER);
    aerie.focus(NO_PLAYER);
    expect(aerie.focusId).toBe(NO_PLAYER);
  });

  it('pushes in and tilts up during the launch', () => {
    const aerie = newAerie();
    const camera = newCamera();
    frame(aerie, camera, room(ALL));
    const wide = camera.position.clone();
    const wideForward = camera.getWorldDirection(new Vector3());
    const middle = new Vector3(layout.origin.x, layout.origin.y + 10, layout.origin.z);
    aerie.focus(2);
    run(aerie, camera, room(ALL, 'starting'), MATCH_TUNING.lobbyLaunchS * 0.9);
    // The launch drops the close-up.
    expect(aerie.focusId).toBe(NO_PLAYER);
    expect(camera.position.distanceTo(middle)).toBeLessThan(wide.distanceTo(middle) - 10);
    const forward = camera.getWorldDirection(new Vector3());
    expect(forward.y).toBeGreaterThan(wideForward.y + 0.3);
  });

  it('holds one fixed wide shot and cuts under reduce motion', () => {
    const aerie = newAerie();
    aerie.setReduceMotion(true);
    const camera = newCamera();
    const lobby = room(ALL);
    frame(aerie, camera, lobby);
    const wide = camera.position.clone();
    run(aerie, camera, lobby, 5);
    expect(camera.position.distanceTo(wide)).toBe(0);
    // A close-up is a cut: there on the next frame.
    aerie.focus(6);
    frame(aerie, camera, lobby);
    const close = camera.position.clone();
    expect(close.distanceTo(wide)).toBeGreaterThan(20);
    frame(aerie, camera, lobby);
    expect(camera.position.distanceTo(close)).toBe(0);
    aerie.focus(null);
    frame(aerie, camera, lobby);
    expect(camera.position.distanceTo(wide)).toBe(0);
    // The launch does not move it either.
    run(aerie, camera, room(ALL, 'starting'), 2);
    expect(camera.position.distanceTo(wide)).toBe(0);
  });
});

describe('aerie plates', () => {
  it('projects a point in front of the camera to viewport fractions from the top-left', () => {
    const camera = new PerspectiveCamera(90, 2, 0.5, 1000);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const at = { x: 0, y: 0 };
    expect(projectToViewport(camera, 0, 0, -10, at)).toBe(true);
    expect(at.x).toBeCloseTo(0.5, 6);
    expect(at.y).toBeCloseTo(0.5, 6);
    // 90 degrees vertical: at 10 m the picture is 20 m tall and (aspect 2) 40 m wide.
    expect(projectToViewport(camera, 10, 5, -10, at)).toBe(true);
    expect(at.x).toBeCloseTo(0.75, 6);
    expect(at.y).toBeCloseTo(0.25, 6);
    expect(projectToViewport(camera, -19, -9, -10, at)).toBe(true);
    expect(at.x).toBeCloseTo(0.025, 6);
    expect(at.y).toBeCloseTo(0.95, 6);
    // Off the side of the screen, and behind the camera.
    expect(projectToViewport(camera, 30, 0, -10, at)).toBe(false);
    expect(at.x).toBeGreaterThan(1);
    expect(projectToViewport(camera, 0, 0, 10, at)).toBe(false);
  });

  it('agrees with three.js on the projection', () => {
    const camera = newCamera(1.6);
    camera.position.set(12, 40, -7);
    camera.lookAt(-30, 20, 55);
    camera.updateMatrixWorld();
    const at = { x: 0, y: 0 };
    const point = new Vector3(-20, 25, 30);
    projectToViewport(camera, point.x, point.y, point.z, at);
    const ndc = point.clone().project(camera);
    expect(at.x).toBeCloseTo(ndc.x * 0.5 + 0.5, 5);
    expect(at.y).toBeCloseTo(0.5 - ndc.y * 0.5, 5);
  });

  it('writes one plate per seated rider, above its perch, at scale 1 in the wide shot', () => {
    const aerie = newAerie();
    aerie.setReduceMotion(true);
    const camera = newCamera();
    const lobby = room([0, 1, 7]);
    frame(aerie, camera, lobby);
    const plates: MutableLobbyPlate[] = [];
    expect(aerie.writePlates(camera, plates)).toBe(3);
    expect(plates).toHaveLength(3);
    expect(plates.map((plate) => plate.playerId).sort()).toEqual([0, 1, 7]);
    const at = { x: 0, y: 0 };
    for (const plate of plates) {
      const perch = layout.perches[perchSlot(plate.playerId < 5 ? TEAM_EMBER : TEAM_FROST, plate.playerId % 5)];
      if (perch === undefined) throw new Error('missing perch');
      expect(plate.visible).toBe(true);
      projectToViewport(camera, perch.position.x, perch.position.y + PLATE_HEIGHT, perch.position.z, at);
      expect(plate.x).toBeCloseTo(at.x, 9);
      expect(plate.y).toBeCloseTo(at.y, 9);
      // Ember is on the left of the screen, Frost on the right.
      if (plate.playerId < 5) expect(plate.x).toBeLessThan(0.5);
      else expect(plate.x).toBeGreaterThan(0.5);
      expect(plate.scale).toBeCloseTo(1, 6);
    }
  });

  it('grows the card of a rider in close-up and hides the ones off screen', () => {
    const aerie = newAerie();
    aerie.setReduceMotion(true);
    const camera = newCamera();
    const lobby = room(ALL);
    frame(aerie, camera, lobby);
    aerie.focus(0);
    frame(aerie, camera, lobby);
    const plates: MutableLobbyPlate[] = [];
    expect(aerie.writePlates(camera, plates)).toBe(10);
    const focused = plates.find((plate) => plate.playerId === 0);
    expect(focused?.visible).toBe(true);
    expect(focused?.scale).toBeGreaterThan(2);
    expect(plates.some((plate) => !plate.visible)).toBe(true);
    for (const plate of plates) {
      if (!plate.visible) continue;
      expect(plate.x).toBeGreaterThanOrEqual(0);
      expect(plate.x).toBeLessThanOrEqual(1);
      expect(plate.y).toBeGreaterThanOrEqual(0);
      expect(plate.y).toBeLessThanOrEqual(1);
    }
  });

  it('has no plate for a rider who has taken off', () => {
    const aerie = newAerie();
    const camera = newCamera();
    frame(aerie, camera, room(ALL));
    const plates: MutableLobbyPlate[] = [];
    expect(aerie.writePlates(camera, plates)).toBe(10);
    run(aerie, camera, room(ALL, 'starting'), 0.5);
    const live = aerie.writePlates(camera, plates);
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThan(10);
    run(aerie, camera, room(ALL, 'starting'), MATCH_TUNING.lobbyLaunchS);
    expect(aerie.writePlates(camera, plates)).toBe(0);
    // A leaver loses its plate at once.
    frame(aerie, camera, room(ALL));
    frame(aerie, camera, room(ALL.slice(1)));
    expect(aerie.writePlates(camera, plates)).toBe(9);
  });

  it('reuses the pool: nothing grows once ten seats have been seen', () => {
    const aerie = newAerie();
    const camera = newCamera();
    const plates: MutableLobbyPlate[] = [];
    frame(aerie, camera, room(ALL));
    expect(aerie.writePlates(camera, plates)).toBe(AERIE_PERCH_COUNT);
    const first = plates.slice();
    const dragons = aerie.view.dragons.slice();
    for (let round = 0; round < 3; round++) {
      run(aerie, camera, room([0, 5]), 0.4);
      aerie.writePlates(camera, plates);
      run(aerie, camera, room(ALL, 'lobby', true), 0.4);
      aerie.writePlates(camera, plates);
      run(aerie, camera, room(ALL, 'starting', true), MATCH_TUNING.lobbyLaunchS);
      aerie.writePlates(camera, plates);
      frame(aerie, camera, room(ALL, 'inMatch'));
      run(aerie, camera, room(ALL), 0.4);
      expect(aerie.writePlates(camera, plates)).toBe(AERIE_PERCH_COUNT);
    }
    expect(plates).toHaveLength(AERIE_PERCH_COUNT);
    for (let i = 0; i < first.length; i++) expect(plates[i]).toBe(first[i]);
    expect(aerie.view.dragons).toHaveLength(dragons.length);
    for (let i = 0; i < dragons.length; i++) expect(aerie.view.dragons[i]).toBe(dragons[i]);
  });
});
