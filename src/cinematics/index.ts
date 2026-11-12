/**
 * Cinematics (Phase 5): the aerie lobby, the match intro, the death cam and the results podium.
 * View code only: each piece places a camera through the `CameraDirector` seam and reads the
 * host's clocks; `src/game/show.ts` decides which one has the camera on a frame.
 */
export { createAerie } from './aerie';
export type { AerieOptions } from './aerie';
export { createDeathCam } from './death-cam';
export { createMatchIntro } from './match-intro';
export { createPodium } from './podium';
export type { PodiumOptions } from './podium';
export type {
  Aerie,
  DeathCam,
  MatchIntro,
  MutableLobbyPlate,
  Podium,
  PodiumCast,
} from './types';
