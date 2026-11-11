/**
 * The one 3D stage of the app. It always holds the sky, the fog, the lights, the cloud sea and
 * the cloud puffs; a match adds the map, the dragons and the chase camera on top and takes them
 * away again when it ends (docs/ARCHITECTURE.md, "Scenes and memory").
 *
 * - Title and lobby: `updateBackdrop` drifts a camera slowly over the cloud sea. Cheap: two
 *   fullscreen-ish passes and the puffs, no map, no dragons. (The aerie scene is Phase 5.)
 * - Match: `updateMatch` moves every view to the frame's WorldView. The camera follows the local
 *   dragon; a spectator follows one rider at a time (`cycleSpectateTarget`).
 *
 * The views only ever see the WorldView, the map data and a terrain query: whether the picture
 * comes from the host's authoritative sim or from a client's prediction and snapshots is
 * invisible here. Nothing in the per-frame functions allocates.
 */

import { PerspectiveCamera, Scene } from 'three';
import { createPlaceholderDragons } from '../dragons';
import type { PlaceholderDragons } from '../dragons';
import { createCameraRig } from '../render';
import type { CameraRig } from '../render';
import { DRAGON_FLAG_ALIVE, NO_PLAYER, QUALITY_PRESETS, findDragonView } from '../shared';
import type { DragonView, GreyboxMap, PlayerId, QualityPresetId, WorldView } from '../shared';
import { cloudFieldFromMap, createCloudBillboards, createCloudSea } from '../world/clouds';
import { createMapView } from '../world/map';
import type { MapView } from '../world/map';
import { applySkyFog, createSkyDome, createSkyLights } from '../world/sky';
import type { MatchAssets } from './match-assets';

/**
 * Render chunk edge in metres. The greybox is about 5k triangles: 500 m chunks draw it in at
 * most 16 calls instead of 48 at the map's own 250 m, and the triangles are the same.
 */
export const STAGE_MAP_CHUNK_SIZE = 500;
/** Metres the camera stays above the cloud-sea surface (the near plane is 0.5 m). */
const CAMERA_SEA_CLEARANCE = 1.5;
/** Squared metres in one frame beyond which the camera's subject was respawned, not flown. */
const TELEPORT_DISTANCE_SQ = 60 * 60;

// --- Backdrop drift (title, lobby) -----------------------------------------------------------------
const BACKDROP_FOV = 55;
const BACKDROP_HEIGHT = 240;
const BACKDROP_ORBIT_RADIUS = 620;
/** Radians per second round the arena centre: one lap in about 26 minutes. */
const BACKDROP_ORBIT_RATE = 0.004;
/** The view swings this far (radians) either side of its mean heading, slowly. */
const BACKDROP_SWING = 0.35;
const BACKDROP_SWING_RATE = 0.045;
/** Mean heading relative to the sun: the sun sits right of centre, clear of the menu card. */
const BACKDROP_SUN_OFFSET = -0.42;
const BACKDROP_LOOK_DISTANCE = 1000;
const BACKDROP_LOOK_RISE = 70;

export interface StageOptions {
  readonly quality: QualityPresetId;
  /** The sky, fog and cloud field come from this map's data (every map shares them for now). */
  readonly map: GreyboxMap;
}

export interface Stage {
  readonly scene: Scene;
  /** The camera to render with this frame: the chase rig's in a match, the backdrop's otherwise. */
  readonly camera: PerspectiveCamera;
  readonly matchLoaded: boolean;
  /** Seed of the loaded match map, or -1. */
  readonly matchSeed: number;
  /** Builds the map view, the dragons and the chase camera. Load-time: allocates. */
  loadMatch(assets: MatchAssets): void;
  /** Frees what `loadMatch` built. Safe to call when nothing is loaded. */
  unloadMatch(): void;
  /** One title / lobby frame. */
  updateBackdrop(dtS: number): void;
  /**
   * One match frame, after the WorldView is built. `steerX/Y` is the local player's latest
   * input (camera look-ahead); pass 0 for a spectator.
   */
  updateMatch(view: WorldView, steerX: number, steerY: number, dtS: number): void;
  /** Next camera subject for a spectator (wraps round). */
  cycleSpectateTarget(): void;
  /** Place the camera directly on the next match frame (spawn, scene cut). */
  snapCamera(): void;
  setAspect(aspect: number): void;
  /** Forwards a preset change to every view. Not per frame: sky and sea recompile a shader. */
  setQuality(id: QualityPresetId): void;
  dispose(): void;
}

interface MatchViews {
  readonly seed: number;
  readonly mapView: MapView;
  readonly dragons: PlaceholderDragons;
  readonly rig: CameraRig;
}

export function createStage(options: StageOptions): Stage {
  const map = options.map;
  let preset = QUALITY_PRESETS[options.quality];
  let aspect = 1;
  let timeS = 0;
  let disposed = false;

  const scene = new Scene();
  // The sea and the puffs hide their edges in this fog, and the sky's horizon band matches it.
  applySkyFog(scene, map.sky);
  const sky = createSkyDome(map.sky);
  const lights = createSkyLights(map.sky);
  const cloudSeaY = map.colliders.cloudSeaY ?? map.colliders.floorY;
  const sea = createCloudSea({ cloudSeaY, sky: map.sky });
  const clouds = createCloudBillboards({ field: cloudFieldFromMap(map), sky: map.sky });
  scene.add(sky.object, lights.sun, lights.hemisphere, sea.object);
  for (const layer of clouds.objects) scene.add(layer);

  const backdropCamera = new PerspectiveCamera(BACKDROP_FOV, 1, 0.5, 6000);
  const centerX = map.colliders.stormCenter.x;
  const centerZ = map.colliders.stormCenter.z;
  const sunYaw = Math.atan2(map.sky.sunDirection.x, map.sky.sunDirection.z);

  let match: MatchViews | null = null;
  let spectateId: PlayerId = NO_PLAYER;
  /** True on a frame where the chase camera had somebody to follow. */
  let chasing = false;

  function applyQuality(): void {
    sky.setQuality(preset);
    lights.setQuality(preset);
    sea.setQuality(preset);
    clouds.setQuality(preset);
    match?.mapView.setQuality(preset);
    match?.dragons.setQuality(preset);
  }

  function placeBackdropCamera(): void {
    const orbit = timeS * BACKDROP_ORBIT_RATE;
    const x = centerX + Math.cos(orbit) * BACKDROP_ORBIT_RADIUS;
    const z = centerZ + Math.sin(orbit) * BACKDROP_ORBIT_RADIUS;
    const y = cloudSeaY + BACKDROP_HEIGHT;
    const heading =
      sunYaw + BACKDROP_SUN_OFFSET + BACKDROP_SWING * Math.sin(timeS * BACKDROP_SWING_RATE);
    backdropCamera.position.set(x, y, z);
    backdropCamera.lookAt(
      x + Math.sin(heading) * BACKDROP_LOOK_DISTANCE,
      y + BACKDROP_LOOK_RISE,
      z + Math.cos(heading) * BACKDROP_LOOK_DISTANCE,
    );
  }

  function updateSky(camera: PerspectiveCamera): void {
    sea.update(camera.position, timeS);
    clouds.update(timeS);
  }

  /** The rider a spectator watches: the chosen one while it is in the view, else the first. */
  function spectateSubject(view: WorldView): DragonView | undefined {
    const chosen = findDragonView(view, spectateId);
    if (chosen !== undefined) return chosen;
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon !== undefined && (dragon.flags & DRAGON_FLAG_ALIVE) !== 0) {
        spectateId = dragon.id;
        return dragon;
      }
    }
    const first = view.dragonCount > 0 ? view.dragons[0] : undefined;
    if (first !== undefined) spectateId = first.id;
    return first;
  }

  /** Ids in the last match view, kept so `cycleSpectateTarget` works between frames. */
  const seenIds: PlayerId[] = [];
  let seenCount = 0;

  // A subject that moved further than this in one frame was respawned: cut, do not sweep.
  let lastSubjectId: PlayerId = NO_PLAYER;
  let lastX = 0;
  let lastY = 0;
  let lastZ = 0;

  function followSubject(rig: CameraRig, subject: DragonView, dtS: number): void {
    const position = subject.position;
    const dx = position.x - lastX;
    const dy = position.y - lastY;
    const dz = position.z - lastZ;
    if (subject.id !== lastSubjectId || dx * dx + dy * dy + dz * dz > TELEPORT_DISTANCE_SQ) {
      rig.snap();
    }
    lastSubjectId = subject.id;
    lastX = position.x;
    lastY = position.y;
    lastZ = position.z;
    rig.follow(subject, dtS);
    chasing = true;
  }

  function unloadMatch(): void {
    if (match === null) return;
    scene.remove(match.mapView.object, match.dragons.object);
    match.mapView.dispose();
    match.dragons.dispose();
    match.rig.dispose();
    match = null;
    chasing = false;
    lastSubjectId = NO_PLAYER;
  }

  applyQuality();
  placeBackdropCamera();

  return {
    scene,
    get camera() {
      return match !== null && chasing ? match.rig.camera : backdropCamera;
    },
    get matchLoaded() {
      return match !== null;
    },
    get matchSeed() {
      return match === null ? -1 : match.seed;
    },

    loadMatch(assets: MatchAssets): void {
      if (disposed) return;
      if (match !== null) {
        if (match.seed === assets.seed) return;
        unloadMatch();
      }
      const mapView = createMapView(assets.map, preset, { chunkSize: STAGE_MAP_CHUNK_SIZE });
      // The dead are drawn: there is no death cam yet, so the fall is the only feedback.
      const dragons = createPlaceholderDragons(preset, { showDead: true });
      const rig = createCameraRig({
        terrain: assets.collision,
        minY: cloudSeaY + CAMERA_SEA_CLEARANCE,
      });
      rig.setAspect(aspect);
      rig.snap();
      scene.add(mapView.object, dragons.object);
      match = { seed: assets.seed, mapView, dragons, rig };
      spectateId = NO_PLAYER;
      seenCount = 0;
      chasing = false;
      lastSubjectId = NO_PLAYER;
    },

    unloadMatch,

    updateBackdrop(dtS: number): void {
      if (disposed) return;
      timeS += dtS;
      chasing = false;
      placeBackdropCamera();
      updateSky(backdropCamera);
    },

    updateMatch(view: WorldView, steerX: number, steerY: number, dtS: number): void {
      if (disposed) return;
      timeS += dtS;
      const views = match;
      if (views === null) {
        chasing = false;
        placeBackdropCamera();
        updateSky(backdropCamera);
        return;
      }
      const rig = views.rig;
      seenCount = view.dragonCount;
      for (let i = 0; i < seenCount; i++) seenIds[i] = view.dragons[i]?.id ?? NO_PLAYER;

      const local = findDragonView(view, view.localDragonId);
      if (local !== undefined) {
        rig.setAim(steerX, steerY);
        followSubject(rig, local, dtS);
      } else {
        const subject = spectateSubject(view);
        if (subject !== undefined) {
          rig.setAim(0, 0);
          followSubject(rig, subject, dtS);
        } else if (!chasing) {
          // Nobody to watch yet (the first snapshot has not arrived): keep drifting.
          placeBackdropCamera();
        }
      }
      const camera = chasing ? rig.camera : backdropCamera;
      updateSky(camera);
      views.mapView.update(camera.position);
      views.dragons.update(view, dtS);
    },

    cycleSpectateTarget(): void {
      if (seenCount === 0) return;
      let index = 0;
      for (let i = 0; i < seenCount; i++) {
        if (seenIds[i] === spectateId) {
          index = (i + 1) % seenCount;
          break;
        }
      }
      spectateId = seenIds[index] ?? NO_PLAYER;
    },

    snapCamera(): void {
      lastSubjectId = NO_PLAYER;
    },

    setAspect(next: number): void {
      if (!(next > 0) || !Number.isFinite(next)) return;
      aspect = next;
      if (backdropCamera.aspect !== next) {
        backdropCamera.aspect = next;
        backdropCamera.updateProjectionMatrix();
      }
      match?.rig.setAspect(next);
    },

    setQuality(id: QualityPresetId): void {
      if (disposed) return;
      preset = QUALITY_PRESETS[id];
      applyQuality();
    },

    dispose(): void {
      if (disposed) return;
      unloadMatch();
      disposed = true;
      scene.clear();
      scene.fog = null;
      sky.dispose();
      lights.dispose();
      sea.dispose();
      clouds.dispose();
    },
  };
}
