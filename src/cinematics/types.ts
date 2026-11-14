/**
 * Contracts of the cinematics module (Phase 5): what `src/game` calls and what each piece under
 * this folder implements. All of them are view code: they read the WorldView, the lobby and the
 * map data, place a camera through the `CameraDirector` seam (src/render/camera-director.ts) and
 * never touch the sim. The host decides WHEN a cinematic runs (the match phase and its start
 * tick are in `WorldView.clock`, the lobby phase in `LobbyState`); every browser plays it from
 * that clock, so all screens show the same moment without any cinematic state on the wire.
 *
 * Per-frame methods (`direct`, `update`, `apply`, `writePlates`) must not allocate.
 */
import type { Object3D, PerspectiveCamera } from 'three';
import type { CameraDirector } from '../render';
import type {
  ArenaMap,
  LobbyState,
  MatchWinner,
  MutableWorldView,
  PlayerId,
  QualityPreset,
  TerrainQuery,
  WorldView,
} from '../shared';

// --- Match intro (T-5.4) ---------------------------------------------------------------------------

/**
 * The `intro` match phase: a flyby of the map along its intro spline with the title card up,
 * then a cut to each team's gate (the far team first, the local team last), ending on the pose
 * the chase camera takes over from when the 3-2-1 starts. `direct` returns false outside the
 * `intro` phase.
 */
export interface MatchIntro extends CameraDirector {
  /**
   * A match's views were loaded: read the flyby path of this map. `terrain` (when there is
   * one) keeps the gate shots out of the rock. Load-time.
   */
  begin(map: ArenaMap, terrain: TerrainQuery | null): void;
  /** Title-card opacity for this frame, 0..1; 0 outside the intro. Valid after `direct`. */
  readonly cardOpacity: number;
  /** Accessibility: slower, straighter moves and no roll. */
  setReduceMotion(on: boolean): void;
}

// --- Death cam (T-5.5) -----------------------------------------------------------------------------

/**
 * While the local dragon is down: a slow orbit round whoever got the takedown, for
 * MATCH_TUNING.deathCamS, then `direct` returns false and the chase rig follows the killer until
 * the respawn. Returns false at once when there is nobody to show (terrain, storm, an enemy
 * that is veiled, a spectator).
 */
export interface DeathCam extends CameraDirector {
  /** A match's views were loaded. `terrain` pulls the orbit in where rock is in the way. */
  begin(terrain: TerrainQuery | null): void;
  /** Forget the current orbit (round reset, match unload). */
  reset(): void;
  /**
   * End the orbit immediately (Space / click). Local only — other players keep their own cam.
   * Returns true when an orbit was actually cut short.
   */
  requestSkip(): boolean;
  /** True while `direct` would own the camera this fall. */
  readonly active: boolean;
  setReduceMotion(on: boolean): void;
}

// --- Results podium (T-5.5) ------------------------------------------------------------------------

export interface PodiumCast {
  readonly winner: MatchWinner;
  /** NO_PLAYER when nobody earned the place. */
  readonly mvpId: PlayerId;
  readonly mostTakedownsId: PlayerId;
  readonly mostDamageId: PlayerId;
}

/**
 * The `results` match phase. The winning team flies a formation pass, then the MVP, the rider
 * with the most takedowns and the one with the most damage land on the podium; everyone else
 * hovers behind it. It is a puppet show on top of the real picture: `apply` rewrites the frame's
 * dragons in place (position, orientation, velocity, anim, flags) and drops shots and zones, so
 * the ordinary dragon renderer draws it and nothing new goes over the network.
 */
export interface Podium extends CameraDirector {
  /** The podium rock itself. The stage adds it to the scene while `active`. */
  readonly object: Object3D;
  /** True between `begin` and `end`. */
  readonly active: boolean;
  /** The results phase began. `terrain` lets it find a clear spot above the map. Load-time. */
  begin(cast: PodiumCast, map: ArenaMap, terrain: TerrainQuery | null): void;
  /** Call on every `results` frame after the WorldView is built and before the stage draws it. */
  apply(view: MutableWorldView, dtS: number): void;
  end(): void;
  setQuality(preset: QualityPreset): void;
  setReduceMotion(on: boolean): void;
  dispose(): void;
}

// --- The Aerie lobby (T-5.2) -----------------------------------------------------------------------

/** One name card anchor; the pool `writePlates` fills (`LobbyPlate` in src/shared/ui.ts). */
export interface MutableLobbyPlate {
  playerId: PlayerId;
  x: number;
  y: number;
  scale: number;
  visible: boolean;
}

/**
 * The lobby scene: a cliffside aerie with two terraces (Ember left, Frost right) of five perches
 * each. Every rider in the lobby is a dragon on its perch, drawn by the ordinary dragon renderer
 * from `view`: a new rider flies in and lands, a ready rider rears and its team glow lights up,
 * and when the host starts (`LobbyState.phase === 'starting'`) the dragons take off in sequence.
 * As a CameraDirector it drifts along a spline, frames one rider in a close-up (`focus`), and
 * pushes in during the launch.
 */
export interface Aerie extends CameraDirector {
  /** Terraces, perches, braziers. The stage adds it to the scene while the lobby is shown. */
  readonly object: Object3D;
  /** The perched cast as a WorldView for the dragon renderer. Rewritten by `update`. */
  readonly view: WorldView;
  /**
   * One lobby frame: follow who is in the lobby, advance the landings, the ready rears and the
   * launch, and rewrite `view`. Call before `direct`.
   */
  update(lobby: LobbyState, localPlayerId: PlayerId, dtS: number): void;
  /** Frame this rider in a close-up; null or NO_PLAYER goes back to the drift. */
  focus(playerId: PlayerId | null): void;
  /** The rider in the close-up, or NO_PLAYER. Falls back by itself when that rider leaves. */
  readonly focusId: PlayerId;
  /**
   * Projects the occupied perches through `camera` into `out` (the pool grows on demand, at load
   * rather than per frame once every seat has been seen) and returns how many entries are live.
   */
  writePlates(camera: PerspectiveCamera, out: MutableLobbyPlate[]): number;
  /**
   * 0 while the lobby is open; rises 0..1 over the launch once the host has started. `src/game`
   * fades the screen out over the last part of it.
   */
  readonly launchProgress: number;
  /** Back to an empty aerie (left the room). */
  reset(): void;
  setQuality(preset: QualityPreset): void;
  setReduceMotion(on: boolean): void;
  dispose(): void;
}
