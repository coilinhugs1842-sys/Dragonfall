/**
 * The Aerie (T-5.2): the lobby scene. A cliffside roost with two terraces, Ember's on the left
 * and Frost's on the right, five perches each; every rider in the room is a dragon on a perch.
 *
 * The pieces, each in its own file:
 * - ./aerie-layout.ts    where it stands in the sky and where the ten perches are (pure data)
 * - ./aerie-set.ts       the set as a list of placed map assets, per quality preset (pure data)
 * - ./aerie-set-view.ts  that list drawn by the map's prop renderer, plus a stand-in
 * - ./aerie-glow.ts      the team-coloured shards and brazier fire (one instanced mesh)
 * - ./aerie-cast.ts      who is on which perch and what it is doing (pure state machine)
 * - ./aerie-camera.ts    the drift, the close-up, the launch shot
 * - ./aerie-plates.ts    name-card anchors projected to the screen
 *
 * `src/game` calls, per lobby frame: `update(lobby, me, dt)`, then the stage runs `direct` as
 * its camera director and draws `view` with the ordinary dragon renderer; the UI then calls
 * `writePlates`. None of those allocate.
 */
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { NO_PLAYER } from '../../shared';
import type { ArenaMap, LobbyState, PlayerId, QualityPreset, WorldView } from '../../shared';
import type { Aerie, MutableLobbyPlate } from '../types';
import { createAerieCamera } from './aerie-camera';
import { createAerieCast } from './aerie-cast';
import { AERIE_PERCH_COUNT, createAerieLayout } from './aerie-layout';
import { writeAeriePlates } from './aerie-plates';
import { createAerieSetView } from './aerie-set-view';

export * from './aerie-camera';
export * from './aerie-cast';
export * from './aerie-layout';
export * from './aerie-math';
export * from './aerie-plates';
export * from './aerie-set';
export type { AerieSetStats } from './aerie-set-view';

export interface AerieOptions {
  /** The default map: its sky gives the sun the aerie is turned to, its assets build the set. */
  readonly map: ArenaMap;
  readonly quality: QualityPreset;
  /** Null (tests, a headless host): no assets are loaded; perches, cast and camera still work. */
  readonly webgl: WebGLRenderer | null;
}

/** Load-time: allocates everything the lobby scene needs. */
export function createAerie(options: AerieOptions): Aerie {
  const layout = createAerieLayout(options.map);
  const set = createAerieSetView({
    map: options.map,
    layout,
    quality: options.quality,
    webgl: options.webgl,
  });
  const cast = createAerieCast(layout);
  const camera = createAerieCamera(layout);
  /** The scene's own clock: drives the shards' bob, the fire and the banners' cloth. */
  let timeS = 0;

  return {
    object: set.object,
    get view(): WorldView {
      return cast.view;
    },
    get focusId(): PlayerId {
      return camera.focusId;
    },
    get launchProgress(): number {
      return cast.launchProgress;
    },

    update(lobby: LobbyState, localPlayerId: PlayerId, dtS: number): void {
      cast.update(lobby, localPlayerId, dtS);
      for (let slot = 0; slot < AERIE_PERCH_COUNT; slot++) {
        set.setPerchGlow(slot, cast.perchGlow[slot] ?? 0);
      }
      // The close-up follows its rider to a new perch, and lets go when the rider is gone.
      const focusId = camera.focusId;
      if (focusId !== NO_PLAYER) {
        const member = cast.seated(focusId);
        const perch = member !== null ? layout.perches[member.slot] : undefined;
        if (perch === undefined) camera.focus(NO_PLAYER, null);
        else camera.retarget(perch);
      }
    },

    focus(playerId: PlayerId | null): void {
      if (playerId === null || playerId === NO_PLAYER) {
        camera.focus(NO_PLAYER, null);
        return;
      }
      const member = cast.seated(playerId);
      const perch = member !== null ? layout.perches[member.slot] : undefined;
      // Somebody without a perch (a spectator, a rider who has left) cannot be framed.
      camera.focus(perch !== undefined ? playerId : NO_PLAYER, perch ?? null);
    },

    direct(target: PerspectiveCamera, _view: WorldView | null, dtS: number): boolean {
      timeS += dtS > 0 ? dtS : 0;
      camera.direct(target, cast.launchProgress, dtS);
      set.update(target.position, target, timeS);
      return true;
    },

    writePlates(target: PerspectiveCamera, out: MutableLobbyPlate[]): number {
      return writeAeriePlates(target, cast, layout, camera.wideEye, out);
    },

    reset(): void {
      cast.reset();
      camera.reset();
      for (let slot = 0; slot < AERIE_PERCH_COUNT; slot++) set.setPerchGlow(slot, 0);
    },

    setQuality(preset: QualityPreset): void {
      set.setQuality(preset);
    },

    setReduceMotion(on: boolean): void {
      camera.setReduceMotion(on);
    },

    dispose(): void {
      set.dispose();
    },
  };
}
