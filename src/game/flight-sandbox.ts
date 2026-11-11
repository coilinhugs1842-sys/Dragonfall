/**
 * The Phase 1 flight sandbox: one dragon flying the greybox map. It is the `match` scene until
 * the real match flow exists (lobby, teams, rounds: Phase 2/3), and it owns everything a match
 * scene owns:
 *
 *   map data -> collision world -> sim (the local dragon, spawned at its team's gate)
 *   input (devices or the `?autopilot` script) -> one InputFrame per tick
 *   WorldView (interpolated from sim.prev / sim.current) -> the views:
 *   sky + fog + lights, cloud sea, cloud billboards, map, dragons, chase camera
 *
 * The sim and the views never see each other: the sim side is reached through `src/sim`, the
 * views only get the WorldView, the map data and (the camera) a `TerrainQuery`.
 *
 * `step` runs once per fixed tick, `update` once per rendered frame; neither allocates.
 * Everything is created in `createFlightSandbox` and freed in `dispose`.
 */

import { Scene } from 'three';
import type { PerspectiveCamera } from 'three';
import { createPlaceholderDragons } from '../dragons';
import { createFlightOverlay, createInputController } from '../input';
import { createCameraRig } from '../render';
import {
  DEFAULT_DRAGON_CLASS,
  DRAGON_FLAG_ALIVE,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TICK_HZ,
  TICK_MS,
  createGreyboxSpires,
  createInputFrame,
  createWorldView,
  resetInputFrame,
} from '../shared';
import type {
  DragonClassId,
  InputFrame,
  PlayerId,
  QualityPresetId,
  Quat,
  TeamId,
  WorldView,
} from '../shared';
import { createMapCollisionWorld, createSim } from '../sim';
import type { DragonState } from '../sim';
import { cloudFieldFromMap, createCloudBillboards, createCloudSea } from '../world/clouds';
import { createMapView } from '../world/map';
import { applySkyFog, createSkyDome, createSkyLights } from '../world/sky';
import { writeAutopilotFrame } from './autopilot';
import type { AutopilotCourse } from './autopilot';
import { buildWorldView } from './world-view-builder';
import type { WorldViewBuildOptions } from './world-view-builder';

/** The one rider of the sandbox. */
export const SANDBOX_PLAYER_ID: PlayerId = 0;
/**
 * Render chunk edge in metres. The greybox is about 5k triangles: 500 m chunks draw it in at
 * most 16 calls instead of 48 at the map's own 250 m, and the triangles are the same.
 */
export const SANDBOX_MAP_CHUNK_SIZE = 500;
/**
 * Ticks a dead dragon keeps falling before it is put back at the gate. Sandbox rule only: the
 * real respawn (delay, death cam, spawn choice) is T-3.1.
 */
export const SANDBOX_RESPAWN_TICKS = 2 * TICK_HZ;
/** Middle slot of the gate (slots are spread left to right). */
const SPAWN_SLOT = 2;
/** The circle the `?autopilot` pilot flies, relative to the storm centre. */
const AUTOPILOT_RADIUS = 380;
const AUTOPILOT_ALTITUDE = 400;
/** Metres the camera stays above the cloud-sea surface (the near plane is 0.5 m). */
const CAMERA_SEA_CLEARANCE = 1.5;

export interface FlightSandboxOptions {
  /** The game canvas: pointer lock is requested on it. */
  readonly canvas: HTMLElement;
  readonly quality: QualityPresetId;
  /** `?autopilot`: the scripted pilot flies; devices are ignored and no prompt is shown. */
  readonly autopilot?: boolean;
  /**
   * `?skip`: seconds of flight to run before the first frame. Every tick is simulated and the
   * camera and views are updated for it (nothing is drawn), so the scene the first frame shows
   * is the one a player would see that far into the flight.
   */
  readonly skipSeconds?: number;
  readonly team?: TeamId;
  readonly classId?: DragonClassId;
}

export interface FlightSandbox {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** The view of the latest `update`. Same object every frame (see the WorldView pooling rules). */
  readonly worldView: WorldView;
  /** One fixed sim tick: sample input, step the sim, respawn a dead dragon. */
  step(): void;
  /**
   * One rendered frame, before `renderer.render(scene, camera)`: rebuilds the WorldView at
   * `alpha` between the last two ticks and moves the camera and every view to it.
   */
  update(alpha: number, frameMs: number): void;
  /** Canvas width / height. */
  setAspect(aspect: number): void;
  /** Forwards a preset change to every view. Not per frame: sky and sea recompile a shader. */
  setQuality(id: QualityPresetId): void;
  dispose(): void;
}

/** Heading (radians about +Y, 0 = +Z) of a spawn gate's launch direction. */
function yawOfOrientation(q: Quat): number {
  // The rotated +Z axis, as in the sim's and the camera's convention.
  const forwardX = 2 * (q.x * q.z + q.w * q.y);
  const forwardZ = 1 - 2 * (q.x * q.x + q.y * q.y);
  return Math.atan2(forwardX, forwardZ);
}

export function createFlightSandbox(options: FlightSandboxOptions): FlightSandbox {
  const team = options.team ?? TEAM_EMBER;
  const classId = options.classId ?? DEFAULT_DRAGON_CLASS;
  const autopilot = options.autopilot ?? false;
  let preset = QUALITY_PRESETS[options.quality];

  // --- Sim side -----------------------------------------------------------------------------------
  const map = createGreyboxSpires();
  const collision = createMapCollisionWorld(map);
  const sim = createSim({ collisionWorld: collision });

  const gate = map.spawnGates[team];
  if (gate === undefined) throw new Error(`Map ${map.id} has no spawn gate for team ${team}`);
  const spawnPosition = gate.slots[SPAWN_SLOT] ?? gate.position;
  const spawnYaw = yawOfOrientation(gate.orientation);

  const frame = createInputFrame();
  // Indexed by player id; the one entry is the reused frame.
  const inputs: InputFrame[] = [];
  inputs[SANDBOX_PLAYER_ID] = frame;
  const course: AutopilotCourse = {
    centerX: map.colliders.stormCenter.x,
    centerZ: map.colliders.stormCenter.z,
    radius: AUTOPILOT_RADIUS,
    altitude: AUTOPILOT_ALTITUDE,
  };
  let tick = 0;
  let deadTicks = 0;

  // --- View side ----------------------------------------------------------------------------------
  const scene = new Scene();
  // The sea and the puffs hide their edges in this fog, and the sky's horizon band matches it.
  applySkyFog(scene, map.sky);
  const sky = createSkyDome(map.sky);
  const lights = createSkyLights(map.sky);
  const cloudSeaY = map.colliders.cloudSeaY ?? map.colliders.floorY;
  const sea = createCloudSea({ cloudSeaY, sky: map.sky });
  const clouds = createCloudBillboards({ field: cloudFieldFromMap(map), sky: map.sky });
  const mapView = createMapView(map, preset, { chunkSize: SANDBOX_MAP_CHUNK_SIZE });
  // The dead are drawn: the sandbox has no death cam, so the fall is the only feedback.
  const dragons = createPlaceholderDragons(preset, { showDead: true });
  scene.add(sky.object, lights.sun, lights.hemisphere, sea.object, mapView.object, dragons.object);
  for (const layer of clouds.objects) scene.add(layer);

  const rig = createCameraRig({ terrain: collision, minY: cloudSeaY + CAMERA_SEA_CLEARANCE });
  const camera = rig.camera;

  const input = createInputController(options.canvas);
  const overlay = createFlightOverlay();
  if (autopilot) {
    input.setEnabled(false);
    overlay.setVisible(false);
  }

  const worldView = createWorldView();
  const buildOptions: WorldViewBuildOptions = {
    localDragonId: SANDBOX_PLAYER_ID,
    stormWall: collision,
    phase: 'playing',
  };

  function spawn(): DragonState | null {
    const dragon = sim.spawnDragon(SANDBOX_PLAYER_ID, team, classId, spawnPosition, spawnYaw);
    // A new life starts with the camera behind the dragon, not sweeping in from the wreck.
    rig.snap();
    deadTicks = 0;
    return dragon;
  }

  function applyQuality(): void {
    sky.setQuality(preset);
    lights.setQuality(preset);
    sea.setQuality(preset);
    clouds.setQuality(preset);
    mapView.setQuality(preset);
    dragons.setQuality(preset);
  }

  applyQuality();
  spawn();

  let disposed = false;

  const sandbox: FlightSandbox = {
    scene,
    camera,
    worldView,

    step(): void {
      if (disposed) return;
      const now = tick++;
      if (autopilot) writeAutopilotFrame(now, sim.getDragon(SANDBOX_PLAYER_ID), course, frame);
      else input.sample(now, frame);
      sim.step(now, inputs);

      const dragon = sim.getDragon(SANDBOX_PLAYER_ID);
      if (dragon === undefined) {
        spawn();
      } else if ((dragon.flags & DRAGON_FLAG_ALIVE) !== 0) {
        deadTicks = 0;
      } else if (++deadTicks >= SANDBOX_RESPAWN_TICKS) {
        spawn();
      }
    },

    update(alpha: number, frameMs: number): void {
      if (disposed) return;
      const dtS = frameMs / 1000;
      buildWorldView(worldView, sim.prev, sim.current, alpha, buildOptions);

      rig.setAim(frame.steerX, frame.steerY);
      rig.update(worldView, dtS);

      // Interpolated sim time: the clouds stop when the sim does and never jump with a hitch.
      const timeS = worldView.clock.phaseTimeS;
      sea.update(camera.position, timeS);
      clouds.update(timeS);
      mapView.update(camera.position);
      dragons.update(worldView, dtS);
      if (!autopilot) overlay.update(input.state.reticleX, input.state.reticleY, input.locked);
    },

    setAspect(aspect: number): void {
      rig.setAspect(aspect);
    },

    setQuality(id: QualityPresetId): void {
      if (disposed) return;
      preset = QUALITY_PRESETS[id];
      applyQuality();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      input.dispose();
      overlay.dispose();
      resetInputFrame(frame);
      sim.setCollisionWorld(null);
      scene.clear();
      scene.fog = null;
      sky.dispose();
      lights.dispose();
      sea.dispose();
      clouds.dispose();
      mapView.dispose();
      dragons.dispose();
      rig.dispose();
    },
  };

  const skipTicks = Math.floor((options.skipSeconds ?? 0) * TICK_HZ);
  for (let i = 0; i < skipTicks; i++) {
    sandbox.step();
    sandbox.update(1, TICK_MS);
  }
  return sandbox;
}
