/**
 * The one 3D stage of the app. It always holds the sky, the fog, the lights, the cloud sea and
 * the cloud puffs; a match adds the map, the dragons and the chase camera on top and takes them
 * away again when it ends (docs/ARCHITECTURE.md, "Scenes and memory").
 *
 * - Title: `updateBackdrop` drifts a camera slowly over the cloud sea. Cheap: two
 *   fullscreen-ish passes and the puffs, no map, no dragons.
 * - Lobby: `setLobbySet` puts the aerie's terraces into the same sky and `updateLobby` draws
 *   the riders perched on them. The set is hidden, and its dragons are freed by the caller,
 *   while a match is loaded.
 * - Match: `updateMatch` moves every view to the frame's WorldView. The camera follows the local
 *   dragon; a spectator (or a rider out for the round in Duel) follows one rider at a time
 *   (`cycleSpectateTarget`), teammates only when the watcher is a downed rider.
 *
 * The views only ever see the WorldView, the map data and a terrain query: whether the picture
 * comes from the host's authoritative sim or from a client's prediction and snapshots is
 * invisible here. Nothing in the per-frame functions allocates.
 */

import { PerspectiveCamera, Scene } from 'three';
import type { Object3D, WebGLRenderer } from 'three';
import { createDragons, sharedDragonAssetLibrary } from '../dragons';
import type { Dragons } from '../dragons';
import { createCameraRig } from '../render';
import type { CameraDirector, CameraRig } from '../render';
import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  MAX_PLAYERS,
  NO_PLAYER,
  QUALITY_PRESETS,
  findDragonView,
} from '../shared';
import type {
  DragonClassId,
  DragonView,
  GameEventSource,
  ArenaMap,
  PlayerId,
  QualityPresetId,
  TeamId,
  Unsubscribe,
  WorldView,
} from '../shared';
import { createVfx } from '../vfx';
import type { Vfx, VfxStats } from '../vfx';
import { cloudFieldFromMap, createCloudBillboards, createCloudSea } from '../world/clouds';
import { createMapView, preloadMapAssets } from '../world/map';
import { createMapLook } from '../world/map-look';
import { loadMapAssets } from '../world/props';
import type { MapLoadState, MapView } from '../world/map';
import { createWorldLighting } from '../world/light';
import { applySkyFog, createSkyDome, createSkyLights } from '../world/sky';
import { createEmberRelayView } from '../world/relay';
import type { EmberRelayView } from '../world/relay';
import { createStormWallView } from '../world/storm';
import type { StormWallView } from '../world/storm';
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

export type { CameraDirector };

export interface StageOptions {
  readonly quality: QualityPresetId;
  /** The sky, fog and cloud field come from this map's data (every map shares them for now). */
  readonly map: ArenaMap;
  /** The match's GameEvents: the effects subscribe while a match is loaded. */
  readonly events?: GameEventSource | null;
  /** The loaders need it (KTX2 support detection). Null in tests: no assets are fetched. */
  readonly webgl?: WebGLRenderer | null;
  /**
   * `GameRenderer.precompile`: builds the scene's shader programs against the real scene target
   * without drawing. The stage calls it whenever a load put new materials into the scene, so
   * the first frame that shows them does not stop to compile.
   */
  readonly precompile?: ((scene: Scene, camera: PerspectiveCamera) => Promise<void>) | null;
}

export interface Stage {
  readonly scene: Scene;
  /** The camera to render with this frame: the chase rig's in a match, the backdrop's otherwise. */
  readonly camera: PerspectiveCamera;
  readonly matchLoaded: boolean;
  /** Seed of the loaded match map, or -1. */
  readonly matchSeed: number;
  /** What the map view draws: `ready` = the real assets; null with no match loaded. */
  readonly mapLoadState: MapLoadState | null;
  /**
   * Builds the map view, the dragons and the chase camera. Load-time: allocates. `riders` is the
   * class of every dragon that is going to fly (one entry each): their rigs are built now, so
   * the shader warm-up covers them and no frame of the match has to make one.
   */
  loadMatch(assets: MatchAssets, riders?: readonly DragonClassId[]): void;
  /** Frees what `loadMatch` built. Safe to call when nothing is loaded. */
  unloadMatch(): void;
  /** One title / lobby frame. */
  updateBackdrop(dtS: number): void;
  /**
   * Shows a lobby set (the aerie's terraces) with its own dragon renderer, or takes it away with
   * null. Only drawn while no match is loaded. The caller keeps ownership of `object`.
   */
  setLobbySet(object: Object3D | null): void;
  /** One lobby frame: the backdrop plus the lobby set's dragons, read from `view`. */
  updateLobby(view: WorldView, dtS: number): void;
  /** Adds a cinematic's own object (the results podium) to the scene; `removeProp` takes it out. */
  addProp(object: Object3D): void;
  removeProp(object: Object3D): void;
  /**
   * One match frame, after the WorldView is built. `steerX/Y` is the local player's latest
   * input (camera look-ahead); pass 0 for a spectator.
   */
  updateMatch(view: WorldView, steerX: number, steerY: number, dtS: number): void;
  /** Next camera subject for a spectator or a downed Duel rider (wraps round). */
  cycleSpectateTarget(): void;
  /**
   * Whose dragon the chase camera is on this frame: the local rider's own, the rider a
   * spectator (or downed Duel teammate-watch) follows, the killer while waiting to respawn;
   * NO_PLAYER while it holds still or drifts.
   */
  readonly watchedId: PlayerId;
  /** The effects of the loaded match (cosmetic local shots); null with none loaded. */
  readonly vfx: Vfx | null;
  /** Live effect counters for the perf HUD; null with no match loaded. */
  readonly vfxStats: Readonly<VfxStats> | null;
  /**
   * Particles the loaded map draws itself at the current preset (vent streaks, ash): they
   * count against the particle budget with the effects' own. 0 with no match loaded.
   */
  readonly mapAirParticles: number;
  /**
   * Starts fetching and decoding a map's models and textures (once per map and page; nothing
   * happens for one that is loaded or loading). For the map the lobby has picked, so the match
   * start finds them ready.
   */
  preloadMap(map: ArenaMap): void;
  /** Settings: base FOV in degrees, shake 0..1, and the reduce-motion switch. */
  setCameraSettings(fovDeg: number, shake: number, reduceMotion: boolean): void;
  /** Drops every live effect (a new round). */
  clearEffects(): void;
  /** Place the camera directly on the next match frame (spawn, scene cut). */
  snapCamera(): void;
  /**
   * Who places the camera, or null for the chase rig / backdrop drift. The chase rig keeps
   * following underneath, so handing the camera back is seamless.
   */
  setCameraDirector(director: CameraDirector | null): void;
  /** True on a frame the director placed the camera. */
  readonly directed: boolean;
  /** Seconds this stage has been drawing (the clock of the sky, the sea and the clouds). */
  readonly timeS: number;
  /**
   * Compiles the shaders of everything in the scene now, hidden effect meshes included. Runs by
   * itself at match load and when late assets arrive; resolves when the GPU is done.
   */
  warmUp(): Promise<void>;
  /** True while a `warmUp` is still linking programs (the loading screen stays up). */
  readonly warming: boolean;
  /** Warm-ups started since the stage was made (a diagnostic: each one after a load is a late asset). */
  readonly warmUps: number;
  setAspect(aspect: number): void;
  /** Forwards a preset change to every view. Not per frame: sky and sea recompile a shader. */
  setQuality(id: QualityPresetId): void;
  dispose(): void;
}

interface MatchViews {
  readonly seed: number;
  readonly mapId: ArenaMap['id'];
  /** The match map's own sea level (the camera stays above it). */
  readonly seaY: number;
  readonly mapView: MapView;
  readonly dragons: Dragons;
  readonly rig: CameraRig;
  readonly vfx: Vfx;
  readonly storm: StormWallView;
  /** Ember Relay's shards, braziers and beacons; draws nothing in other modes. */
  readonly relay: EmberRelayView;
  readonly unsubscribe: Unsubscribe | null;
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
  // Shared sun / fog / shadow uniforms for every `useWorldLight` material, and the light shafts.
  const lighting = createWorldLighting({
    sky: map.sky,
    lights,
    cloudSeaY,
    shafts: {
      center: map.colliders.stormCenter,
      radius: map.colliders.stormRadius,
      topY: map.colliders.ceilingY + 200,
    },
  });
  scene.add(sky.object, lights.sun, lights.hemisphere, sea.object, lighting.object);
  for (const layer of clouds.objects) scene.add(layer);
  // A match on another map repaints these views for its own sky (dusk over the caldera) while
  // it is loaded; the title and the lobby always show `map`'s.
  const look = createMapLook({ scene, sky, sea, clouds, lighting }, map);

  const backdropCamera = new PerspectiveCamera(BACKDROP_FOV, 1, 0.5, 6000);
  // The camera a CameraDirector places. Its own object, so the chase rig's smoothing state and
  // the backdrop's drift are untouched while a cinematic runs.
  const directedCamera = new PerspectiveCamera(BACKDROP_FOV, 1, 0.5, 6000);
  let director: CameraDirector | null = null;
  let directed = false;
  let directedFov = BACKDROP_FOV;

  /** Runs the director for this frame; true when it placed `directedCamera`. */
  function runDirector(view: WorldView | null, dtS: number): boolean {
    if (director === null || !director.direct(directedCamera, view, dtS)) return false;
    // Above the cloud sea whatever the path says: under it the screen is one flat colour.
    const minY = (match !== null ? match.seaY : cloudSeaY) + CAMERA_SEA_CLEARANCE;
    if (directedCamera.position.y < minY) directedCamera.position.y = minY;
    if (directedCamera.fov !== directedFov) {
      directedFov = directedCamera.fov;
      directedCamera.updateProjectionMatrix();
    }
    directedCamera.updateMatrixWorld();
    return true;
  }
  const centerX = map.colliders.stormCenter.x;
  const centerZ = map.colliders.stormCenter.z;
  const sunYaw = Math.atan2(map.sky.sunDirection.x, map.sky.sunDirection.z);

  let match: MatchViews | null = null;
  // The lobby set (the aerie) and the dragons perched on it. Hidden while a match is loaded:
  // the map takes the same sky.
  let lobbySet: Object3D | null = null;
  let lobbyDragons: Dragons | null = null;
  const events = options.events ?? null;
  const webgl = options.webgl ?? null;
  const precompile = options.precompile ?? null;
  /** Warm-ups still waiting for the GPU. */
  let warmingCount = 0;
  let warmUps = 0;
  const warmDone = (): void => {
    warmingCount--;
  };

  // What the views had put in front of the GPU when the last warm-up ran. A rig or a map model
  // that arrives later (a slow download, a class nobody listed) moves its view's revision, and
  // the frame that sees that warms up again before the new programs are needed.
  let warmDragons = -1;
  let warmMap = -1;
  let warmLobby = -1;

  function noteRevisions(): void {
    warmDragons = match !== null ? match.dragons.revision : -1;
    warmMap = match !== null ? match.mapView.revision : -1;
    warmLobby = lobbyDragons !== null ? lobbyDragons.revision : -1;
  }

  function warmUp(): Promise<void> {
    if (disposed || precompile === null) return Promise.resolve();
    const camera = match !== null ? match.rig.camera : backdropCamera;
    let pending: Promise<void> | null = null;
    const compile = (): void => {
      pending = precompile(scene, camera);
    };
    // The compile walks hidden objects too; the effects still show their meshes for it, so
    // the programs are the ones a visible draw asks for.
    if (match !== null) match.vfx.warmUp(compile);
    else compile();
    noteRevisions();
    const started: Promise<void> = pending ?? Promise.resolve();
    warmingCount++;
    warmUps++;
    return started.then(warmDone, warmDone);
  }
  // Fetch and decode the map's GLBs and textures now, behind the title: a match that starts
  // later builds its map view from the cache (until then it flies on the hull stand-in).
  if (webgl !== null) preloadMapAssets(map, webgl);
  // The dragon GLBs start loading now (title screen), long before the first match needs them.
  // They queue behind the map's assets: one KTX2 transcoder pool at a time.
  const dragonAssets =
    webgl !== null
      ? sharedDragonAssetLibrary(
          webgl,
          map.placements !== undefined && map.placements.length > 0
            ? loadMapAssets(map, webgl)
            : undefined,
        )
      : null;
  let cameraFov = Number.NaN;
  let cameraShake = 1;
  let cameraReduceMotion = false;
  let watchedId: PlayerId = NO_PLAYER;
  let spectateId: PlayerId = NO_PLAYER;
  /** When set, spectate subjects must be on this team (downed Duel rider watching mates). */
  let spectateTeam: TeamId | null = null;
  /** Skip this id while cycling (the watcher's own corpse). */
  let spectateSkipId: PlayerId = NO_PLAYER;
  /** True on a frame where the chase camera had somebody to follow. */
  let chasing = false;

  function showLobby(visible: boolean): void {
    if (lobbySet !== null) lobbySet.visible = visible;
    if (lobbyDragons !== null) lobbyDragons.object.visible = visible;
  }

  function clearLobbySet(): void {
    if (lobbySet !== null) scene.remove(lobbySet);
    if (lobbyDragons !== null) {
      scene.remove(lobbyDragons.object);
      lobbyDragons.dispose();
    }
    lobbySet = null;
    lobbyDragons = null;
  }

  function applyQuality(): void {
    sky.setQuality(preset);
    lights.setQuality(preset);
    lighting.setQuality(preset);
    sea.setQuality(preset);
    clouds.setQuality(preset);
    lobbyDragons?.setQuality(preset);
    match?.mapView.setQuality(preset);
    match?.dragons.setQuality(preset);
    match?.vfx.setQuality(preset);
    match?.storm.setQuality(preset);
    match?.relay.setQuality(preset);
  }

  function applyCameraSettings(rig: CameraRig): void {
    if (Number.isFinite(cameraFov)) rig.setBaseFov(cameraFov);
    rig.setShakeScale(cameraShake);
    rig.setReduceMotion(cameraReduceMotion);
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
    sky.update(timeS);
    sea.update(camera.position, timeS);
    clouds.update(timeS);
    lighting.update(camera, timeS);
  }

  function matchesSpectateFilter(dragon: DragonView): boolean {
    if (dragon.id === spectateSkipId) return false;
    if (spectateTeam !== null && dragon.team !== spectateTeam) return false;
    return true;
  }

  /** The rider a watcher follows: the chosen one while it is alive and allowed, else the next. */
  function spectateSubject(view: WorldView): DragonView | undefined {
    const chosen = findDragonView(view, spectateId);
    if (
      chosen !== undefined &&
      matchesSpectateFilter(chosen) &&
      (chosen.flags & DRAGON_FLAG_ALIVE) !== 0
    ) {
      return chosen;
    }
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (
        dragon !== undefined &&
        matchesSpectateFilter(dragon) &&
        (dragon.flags & DRAGON_FLAG_ALIVE) !== 0
      ) {
        spectateId = dragon.id;
        return dragon;
      }
    }
    // Lobby spectators may still sit on a corpse if nobody is flying; downed riders do not.
    if (spectateTeam !== null) return undefined;
    const first = view.dragonCount > 0 ? view.dragons[0] : undefined;
    if (first !== undefined && matchesSpectateFilter(first)) {
      spectateId = first.id;
      return first;
    }
    return undefined;
  }

  /** Ids / teams / alive flags in the last match view, for `cycleSpectateTarget`. */
  const seenIds: PlayerId[] = [];
  const seenTeams: TeamId[] = [];
  const seenAlive: boolean[] = [];
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
    scene.remove(match.mapView.object, match.dragons.object, match.storm.object, match.relay.object);
    match.unsubscribe?.();
    match.vfx.dispose();
    match.storm.dispose();
    match.relay.dispose();
    match.mapView.dispose();
    match.dragons.dispose();
    match.rig.dispose();
    match = null;
    // Back to the sky of the title and the lobby.
    look.use(map);
    chasing = false;
    watchedId = NO_PLAYER;
    lastSubjectId = NO_PLAYER;
    showLobby(true);
  }

  applyQuality();
  placeBackdropCamera();

  return {
    scene,
    get camera() {
      if (directed) return directedCamera;
      return match !== null && chasing ? match.rig.camera : backdropCamera;
    },
    get directed() {
      return directed;
    },
    get timeS() {
      return timeS;
    },
    warmUp,
    get warming() {
      return warmingCount > 0;
    },
    get warmUps() {
      return warmUps;
    },
    setCameraDirector(next: CameraDirector | null): void {
      director = next;
      if (next === null) directed = false;
    },
    get matchLoaded() {
      return match !== null;
    },
    get matchSeed() {
      return match === null ? -1 : match.seed;
    },
    get mapLoadState() {
      return match === null ? null : match.mapView.loadState;
    },

    loadMatch(assets: MatchAssets, riders?: readonly DragonClassId[]): void {
      if (disposed) return;
      if (match !== null) {
        if (match.seed === assets.seed && match.mapId === assets.map.id) return;
        unloadMatch();
      }
      // The match is flown under its own map's sky, fog and light.
      look.use(assets.map);
      const seaY = assets.map.colliders.cloudSeaY ?? assets.map.colliders.floorY;
      const mapView = createMapView(assets.map, preset, {
        chunkSize: STAGE_MAP_CHUNK_SIZE,
        renderer: webgl,
      });
      // The dead are drawn (they fall). Skinned dragons from the GLBs; the placeholder shows
      // while a class is still loading.
      const dragons = createDragons(preset, { showDead: true, library: dragonAssets });
      dragons.setReduceMotion(cameraReduceMotion);
      if (riders !== undefined && riders.length > 0) dragons.prewarm(riders);
      const rig = createCameraRig({
        terrain: assets.collision,
        minY: seaY + CAMERA_SEA_CLEARANCE,
      });
      rig.setAspect(aspect);
      rig.snap();
      applyCameraSettings(rig);
      const storm = createStormWallView(preset, {
        floorY: seaY,
        ceilingY: assets.map.colliders.ceilingY,
      });
      const relay = createEmberRelayView(preset);
      scene.add(mapView.object, dragons.object, storm.object, relay.object);
      // The effects add their own objects to the scene (and take them out again on dispose).
      const vfx = createVfx({
        scene,
        quality: preset,
        terrain: assets.collision,
        seed: assets.seed,
      });
      const unsubscribe = events !== null ? vfx.connect(events) : null;
      match = { seed: assets.seed, mapId: assets.map.id, seaY, mapView, dragons, rig, vfx, storm, relay, unsubscribe };
      showLobby(false);
      void warmUp();
      watchedId = NO_PLAYER;
        spectateId = NO_PLAYER;
        spectateTeam = null;
        spectateSkipId = NO_PLAYER;
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
      directed = runDirector(null, dtS);
      updateSky(directed ? directedCamera : backdropCamera);
    },

    setLobbySet(object: Object3D | null): void {
      if (disposed || object === lobbySet) return;
      clearLobbySet();
      if (object === null) return;
      lobbySet = object;
      // No dead dragons in a lobby; skinned dragons from the same library as the match. All
      // ten stay skinned on every preset: there is no map and no fight to pay for here.
      lobbyDragons = createDragons(preset, {
        showDead: false,
        library: dragonAssets,
        minSkinned: MAX_PLAYERS,
      });
      lobbyDragons.setReduceMotion(cameraReduceMotion);
      scene.add(object, lobbyDragons.object);
      showLobby(match === null);
      if (match === null) void warmUp();
    },

    updateLobby(view: WorldView, dtS: number): void {
      if (disposed) return;
      timeS += dtS;
      chasing = false;
      placeBackdropCamera();
      directed = runDirector(null, dtS);
      const camera = directed ? directedCamera : backdropCamera;
      updateSky(camera);
      if (lobbyDragons !== null && match === null) {
        lobbyDragons.update(view, dtS, camera);
        lighting.setBlobCasters(view.dragons, view.dragonCount, camera.position);
        if (lobbyDragons.revision !== warmLobby) void warmUp();
      }
    },

    addProp(object: Object3D): void {
      if (!disposed) scene.add(object);
    },

    removeProp(object: Object3D): void {
      scene.remove(object);
    },

    updateMatch(view: WorldView, steerX: number, steerY: number, dtS: number): void {
      if (disposed) return;
      timeS += dtS;
      const views = match;
      if (views === null) {
        chasing = false;
        placeBackdropCamera();
        directed = runDirector(null, dtS);
        updateSky(directed ? directedCamera : backdropCamera);
        return;
      }
      const rig = views.rig;
      seenCount = view.dragonCount;
      for (let i = 0; i < seenCount; i++) {
        const dragon = view.dragons[i];
        seenIds[i] = dragon?.id ?? NO_PLAYER;
        seenTeams[i] = dragon?.team ?? 0;
        seenAlive[i] = dragon !== undefined && (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
      }

      const followKillerOrHold = (victim: DragonView): void => {
        // The death cam orbits the killer on the directed camera; the chase rig tracks them
        // underneath so the hand-back is seamless. With no killer to show (terrain, storm, a
        // veiled enemy) the camera stays where it was.
        const killer = view.local.valid ? findDragonView(view, view.local.killerId) : undefined;
        if (
          killer !== undefined &&
          killer.id !== victim.id &&
          (killer.flags & DRAGON_FLAG_ALIVE) !== 0 &&
          ((killer.flags & DRAGON_FLAG_VEILED) === 0 || killer.team === victim.team)
        ) {
          watchedId = killer.id;
          rig.setAim(0, 0);
          followSubject(rig, killer, dtS);
        } else {
          watchedId = NO_PLAYER;
          if (!chasing) {
            rig.setAim(0, 0);
            followSubject(rig, victim, dtS);
          } else {
            lastSubjectId = NO_PLAYER;
          }
        }
      };

      const local = findDragonView(view, view.localDragonId);
      if (local !== undefined && (local.flags & DRAGON_FLAG_ALIVE) !== 0) {
        spectateTeam = null;
        spectateSkipId = NO_PLAYER;
        watchedId = local.id;
        rig.setAim(steerX, steerY);
        followSubject(rig, local, dtS);
      } else if (local !== undefined) {
        // Out for the round (Duel): after the death cam, follow living teammates and let the
        // rider cycle them. While waiting to respawn (Skirmish), keep the killer chase.
        const outForRound = view.local.valid && view.local.respawnInS === Infinity;
        if (outForRound) {
          spectateTeam = local.team;
          spectateSkipId = local.id;
          const mate = spectateSubject(view);
          if (mate !== undefined) {
            watchedId = mate.id;
            rig.setAim(0, 0);
            followSubject(rig, mate, dtS);
          } else {
            followKillerOrHold(local);
          }
        } else {
          spectateTeam = null;
          spectateSkipId = NO_PLAYER;
          followKillerOrHold(local);
        }
      } else {
        spectateTeam = null;
        spectateSkipId = NO_PLAYER;
        const subject = spectateSubject(view);
        if (subject !== undefined) {
          watchedId = subject.id;
          rig.setAim(0, 0);
          followSubject(rig, subject, dtS);
        } else {
          watchedId = NO_PLAYER;
          if (!chasing) placeBackdropCamera();
        }
      }
      // After the chase rig: it keeps following underneath, so the cut back is seamless.
      directed = runDirector(view, dtS);
      const camera = directed ? directedCamera : chasing ? rig.camera : backdropCamera;
      updateSky(camera);
      views.mapView.update(camera.position, camera, timeS);
      views.dragons.update(view, dtS, camera);
      lighting.setBlobCasters(view.dragons, view.dragonCount, camera.position);
      views.storm.update(view, camera.position, timeS);
      views.relay.update(view, timeS);
      // Last: the effects read the placed camera (billboards, near fade).
      camera.updateMatrixWorld();
      views.vfx.update(view, timeS, dtS, camera);
      // Something new reached the scene this frame (a late model, a rig nobody listed).
      if (views.dragons.revision !== warmDragons || views.mapView.revision !== warmMap) {
        void warmUp();
      }
    },

    cycleSpectateTarget(): void {
      if (seenCount === 0) return;
      const eligible: number[] = [];
      for (let i = 0; i < seenCount; i++) {
        const id = seenIds[i];
        if (id === undefined || id === NO_PLAYER || id === spectateSkipId) continue;
        if (spectateTeam !== null && seenTeams[i] !== spectateTeam) continue;
        if (!seenAlive[i]) continue;
        eligible.push(i);
      }
      if (eligible.length === 0) return;
      let at = 0;
      for (let i = 0; i < eligible.length; i++) {
        const index = eligible[i] ?? 0;
        if (seenIds[index] === spectateId) {
          at = (i + 1) % eligible.length;
          break;
        }
      }
      const next = eligible[at] ?? eligible[0];
      if (next === undefined) return;
      spectateId = seenIds[next] ?? NO_PLAYER;
    },

    snapCamera(): void {
      lastSubjectId = NO_PLAYER;
    },

    get watchedId() {
      return watchedId;
    },
    get vfx() {
      return match === null ? null : match.vfx;
    },
    get vfxStats() {
      return match === null ? null : match.vfx.stats;
    },
    get mapAirParticles() {
      return match === null ? 0 : match.mapView.stats.airParticles;
    },
    preloadMap(next: ArenaMap): void {
      if (webgl !== null) preloadMapAssets(next, webgl);
    },

    setCameraSettings(fovDeg: number, shake: number, reduceMotion: boolean): void {
      cameraFov = fovDeg;
      cameraShake = shake;
      cameraReduceMotion = reduceMotion;
      if (match !== null) {
        applyCameraSettings(match.rig);
        match.dragons.setReduceMotion(reduceMotion);
      }
      lobbyDragons?.setReduceMotion(reduceMotion);
    },

    clearEffects(): void {
      match?.vfx.clear();
    },

    setAspect(next: number): void {
      if (!(next > 0) || !Number.isFinite(next)) return;
      aspect = next;
      if (backdropCamera.aspect !== next) {
        backdropCamera.aspect = next;
        backdropCamera.updateProjectionMatrix();
        directedCamera.aspect = next;
        directedCamera.updateProjectionMatrix();
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
      clearLobbySet();
      disposed = true;
      scene.clear();
      scene.fog = null;
      sky.dispose();
      lighting.dispose();
      lights.dispose();
      sea.dispose();
      clouds.dispose();
    },
  };
}
