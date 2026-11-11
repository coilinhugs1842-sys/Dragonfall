/**
 * The seam every scripted camera goes through: the match intro flyby, the death-cam orbit, the
 * results podium, the aerie lobby, the `?bench` path and the trailer capture.
 *
 * The stage (`src/game/stage.ts`) owns ONE camera for all of them and offers it to the current
 * director each frame, after the chase rig has followed its subject. A director that returns
 * false leaves that frame to the chase rig (in a match) or the backdrop drift (title, lobby);
 * the chase rig keeps following underneath, so handing the camera back never jumps.
 */
import type { PerspectiveCamera } from 'three';
import type { WorldView } from '../shared';

export interface CameraDirector {
  /**
   * Places `camera` (position, orientation, fov) for this frame and returns true; or returns
   * false to leave the frame to the chase rig / the backdrop. `view` is null when there is no
   * match picture. The stage keeps the camera above the cloud sea and updates the projection
   * and world matrices afterwards. Runs every frame: must not allocate.
   */
  direct(camera: PerspectiveCamera, view: WorldView | null, dtS: number): boolean;
}
