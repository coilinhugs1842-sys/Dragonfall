/**
 * Which cinematic has the stage (Phase 5). `src/game/game.ts` tells this module where the
 * session is (lobby frame, match loaded, match frame, room left); it owns the aerie, the match
 * intro, the death cam and the podium, hands the camera to the right one through the stage's
 * one `CameraDirector`, and works out the cream fade between scenes.
 *
 * Nothing here decides WHEN: the lobby phase and the match clock come from the host, so every
 * browser in the room shows the same moment (src/cinematics/types.ts).
 *
 * What lives when ("Scenes and memory", docs/ARCHITECTURE.md):
 * - the aerie is built the first time a lobby is shown and kept while the page is in that room;
 *   its dragons are in the scene only while no match is loaded, and it is freed with the room;
 * - the podium is built with each match (so the match's shader warm-up covers it) and freed
 *   with it; the intro and the death cam hold no GPU objects.
 *
 * The per-frame functions do not allocate.
 */
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { createAerie, createDeathCam, createMatchIntro, createPodium } from '../cinematics';
import type { Aerie, MutableLobbyPlate, Podium, PodiumCast } from '../cinematics';
import type { CameraDirector } from '../render';
import { MODE_TUNING, NO_PLAYER, QUALITY_PRESETS } from '../shared';
import type {
  ArenaMap,
  LobbyState,
  MutableWorldView,
  PlayerId,
  QualityPresetId,
  ResultsState,
  WorldView,
} from '../shared';
import type { MatchAssets } from './match-assets';
import type { Stage } from './stage';

/** What the frame drew. A change of scene is a cut, and every cut goes through the cream. */
export type ShowScene = 'title' | 'lobby' | 'match';

/** Seconds from full cream back to the picture once the new scene is ready. */
export const FADE_OUT_S = 0.45;
/** The launch fades out over the last part of the aerie's take-off (0..1 of `launchProgress`). */
export const LAUNCH_FADE_FROM = 0.78;
/** The results fade to cream over their last moment, so the cut back to the aerie is hidden. */
export const RESULTS_FADE_S = 0.7;
/**
 * A scene that is still not ready after this long is shown anyway: a broken warm-up must not
 * leave the player looking at a blank screen for ever.
 */
export const CUT_HOLD_MAX_S = 6;

export interface ShowOptions {
  readonly stage: Stage;
  /** The map the aerie is cut from (the default layout's data, like the stage's sky). */
  readonly map: ArenaMap;
  readonly quality: QualityPresetId;
  /** Null in tests: nothing is fetched and the sets stay empty. */
  readonly webgl: WebGLRenderer | null;
}

export interface Show {
  /** A dev tool (`?bench`, a viewer) takes the camera from every cinematic; null gives it back. */
  setDevDirector(director: CameraDirector | null): void;
  /**
   * One lobby frame, instead of `stage.updateBackdrop`: the riders on their perches, the
   * aerie's camera and the name-card anchors.
   */
  lobbyFrame(lobby: LobbyState, localPlayerId: PlayerId, dtS: number): void;
  /** Close-up on this rider's perch; null or NO_PLAYER goes back to the drift. */
  focus(playerId: PlayerId | null): void;
  /** The rider in the close-up, or NO_PLAYER. */
  readonly focusId: PlayerId;
  /** Name-card anchors of the last lobby frame: read `plateCount` entries. */
  readonly plates: readonly MutableLobbyPlate[];
  readonly plateCount: number;
  /** Call before `stage.loadMatch`: the lobby's dragons are freed, the podium is built. */
  beginMatch(assets: MatchAssets): void;
  /** Call when the match views are unloaded. */
  endMatch(): void;
  /**
   * One match frame, after the WorldView is built and before `stage.updateMatch`. `results` is
   * the finished match's table (the awards cast the podium), null while it is still played.
   */
  matchFrame(view: MutableWorldView, results: ResultsState | null, dtS: number): void;
  /** Opacity of the intro's title card, 0..1. Valid after `stage.updateMatch`. */
  readonly cardOpacity: number;
  /** The page left the room: the aerie is freed. */
  leaveRoom(): void;
  /**
   * The cream fade for this frame, 0..1. `ready` = the scene on screen is complete (its picture
   * exists and no shader is still compiling). Call once per frame, after the scene was updated.
   */
  updateFade(scene: ShowScene, ready: boolean, view: WorldView | null, dtS: number): number;
  /** True while a cut is held at full cream because the new scene is not ready. */
  readonly holding: boolean;
  /** Seconds the current hold has lasted (0 when not holding). */
  readonly holdS: number;
  setQuality(id: QualityPresetId): void;
  setReduceMotion(on: boolean): void;
  dispose(): void;
}

function smoothstep01(x: number): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

export function createShow(options: ShowOptions): Show {
  const { stage, map, webgl } = options;
  let quality = options.quality;
  let reduceMotion = false;
  let dev: CameraDirector | null = null;

  const intro = createMatchIntro();
  const deathCam = createDeathCam();
  let aerie: Aerie | null = null;
  /** The aerie is in the scene (no match is loaded and a lobby frame asked for it). */
  let lobbyOn = false;
  let podium: Podium | null = null;
  let matchAssets: MatchAssets | null = null;
  const cast = { winner: 'draw', mvpId: NO_PLAYER, mostTakedownsId: NO_PLAYER, mostDamageId: NO_PLAYER } as {
    -readonly [K in keyof PodiumCast]: PodiumCast[K];
  };

  const plates: MutableLobbyPlate[] = [];
  let plateCount = 0;

  // --- The fade ----------------------------------------------------------------------------------
  let lastScene: ShowScene = 'title';
  /** 1 from the frame of a cut until the new scene is ready, then down to 0 over FADE_OUT_S. */
  let cut = 0;
  let holding = false;
  let holdS = 0;

  const director: CameraDirector = {
    direct(camera: PerspectiveCamera, view: WorldView | null, dtS: number): boolean {
      if (dev !== null) return dev.direct(camera, view, dtS);
      if (view === null) return lobbyOn && aerie !== null && aerie.direct(camera, null, dtS);
      if (intro.direct(camera, view, dtS)) return true;
      if (podium !== null && podium.active && podium.direct(camera, view, dtS)) return true;
      return deathCam.direct(camera, view, dtS);
    },
  };
  stage.setCameraDirector(director);

  function closeLobby(): void {
    if (!lobbyOn) return;
    lobbyOn = false;
    plateCount = 0;
    // Frees the lobby's dragon rigs; the set itself stays with the aerie for the next lobby.
    stage.setLobbySet(null);
  }

  function endPodium(): void {
    if (podium === null) return;
    if (podium.active) podium.end();
    stage.removeProp(podium.object);
    podium.dispose();
    podium = null;
  }

  return {
    setDevDirector(next: CameraDirector | null): void {
      dev = next;
    },

    lobbyFrame(lobby: LobbyState, localPlayerId: PlayerId, dtS: number): void {
      if (aerie === null) {
        aerie = createAerie({ map, quality: QUALITY_PRESETS[quality], webgl });
        aerie.setReduceMotion(reduceMotion);
      }
      if (!lobbyOn) {
        lobbyOn = true;
        stage.setLobbySet(aerie.object);
      }
      aerie.update(lobby, localPlayerId, dtS);
      stage.updateLobby(aerie.view, dtS);
      plateCount = aerie.writePlates(stage.camera, plates);
    },

    focus(playerId: PlayerId | null): void {
      aerie?.focus(playerId);
    },
    get focusId() {
      return aerie !== null && lobbyOn ? aerie.focusId : NO_PLAYER;
    },
    plates,
    get plateCount() {
      return plateCount;
    },

    beginMatch(assets: MatchAssets): void {
      closeLobby();
      endPodium();
      matchAssets = assets;
      intro.begin(assets.map, assets.collision);
      deathCam.begin(assets.collision);
      // In the scene (hidden) before the stage's warm-up, so its programs are compiled with the
      // match's and the first results frame does not stop for them.
      podium = createPodium({ quality: QUALITY_PRESETS[quality], webgl });
      podium.setReduceMotion(reduceMotion);
      stage.addProp(podium.object);
    },

    endMatch(): void {
      endPodium();
      deathCam.reset();
      matchAssets = null;
    },

    matchFrame(view: MutableWorldView, results: ResultsState | null, dtS: number): void {
      const show = podium;
      if (show === null || matchAssets === null) return;
      if (view.clock.phase === 'results' && results !== null) {
        if (!show.active) {
          cast.winner = results.winner;
          cast.mvpId = results.mvpId;
          cast.mostTakedownsId = results.mostTakedownsId;
          cast.mostDamageId = results.mostDamageId;
          show.begin(cast, matchAssets.map, matchAssets.collision);
          deathCam.reset();
        }
        show.apply(view, dtS);
      } else if (show.active) {
        // A rematch from the results: the puppets go, the dragons are the sim's again.
        show.end();
      }
    },

    get cardOpacity() {
      return dev === null ? intro.cardOpacity : 0;
    },

    leaveRoom(): void {
      closeLobby();
      if (aerie !== null) {
        aerie.dispose();
        aerie = null;
      }
    },

    updateFade(scene: ShowScene, ready: boolean, view: WorldView | null, dtS: number): number {
      // Leaving to the title is not hidden: an error or a goodbye should be on screen at once.
      if (scene !== lastScene && scene !== 'title') {
        cut = 1;
        holdS = 0;
      }
      lastScene = scene;
      holding = false;
      if (cut > 0) {
        if (!ready && holdS < CUT_HOLD_MAX_S && scene !== 'title') {
          holding = true;
          holdS += dtS;
          cut = 1;
        } else {
          cut -= dtS / FADE_OUT_S;
          if (cut < 0) cut = 0;
        }
      }
      if (!holding) holdS = 0;

      let fade = cut;
      if (scene === 'lobby' && aerie !== null) {
        // The last dragons are leaving the terraces: out to cream, and the match loads behind it.
        const launch = smoothstep01((aerie.launchProgress - LAUNCH_FADE_FROM) / (1 - LAUNCH_FADE_FROM));
        if (launch > fade) fade = launch;
      } else if (scene === 'match' && view !== null && view.clock.phase === 'results') {
        const left = MODE_TUNING.resultsS - view.clock.phaseTimeS;
        const out = smoothstep01(1 - left / RESULTS_FADE_S);
        if (out > fade) fade = out;
      }
      return fade;
    },
    get holding() {
      return holding;
    },
    get holdS() {
      return holdS;
    },

    setQuality(id: QualityPresetId): void {
      quality = id;
      aerie?.setQuality(QUALITY_PRESETS[id]);
      podium?.setQuality(QUALITY_PRESETS[id]);
    },

    setReduceMotion(on: boolean): void {
      reduceMotion = on;
      intro.setReduceMotion(on);
      deathCam.setReduceMotion(on);
      aerie?.setReduceMotion(on);
      podium?.setReduceMotion(on);
    },

    dispose(): void {
      stage.setCameraDirector(null);
      endPodium();
      closeLobby();
      aerie?.dispose();
      aerie = null;
    },
  };
}
