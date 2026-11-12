/**
 * The results podium and the winners' formation pass (T-5.5). `createPodium` is all the game
 * needs; the rest is exported for the dev scene (`?viewer=cine:podium`) and the tests.
 */
export { createPodium } from './podium';
export type { PodiumOptions } from './podium';
export { createPodiumPlan, planPodium } from './podium-cast';
export type { PodiumAwards, PodiumPlan } from './podium-cast';
export { createPuppetPose, writePuppetPose } from './podium-choreography';
export type { PuppetPose } from './podium-choreography';
export { createShowCamera, writeShowCamera } from './podium-camera';
export type { ShowCamera } from './podium-camera';
export {
  SEAT_COUNT,
  SEAT_DAMAGE,
  SEAT_MVP,
  SEAT_TAKEDOWNS,
  SEAT_TOP_Y,
  SEAT_X,
  SEAT_Z,
  STEP_BACK,
  STEP_FRONT,
  choosePodiumSite,
  createPodiumSite,
  perchDrop,
  siteToWorld,
} from './podium-layout';
export type { PodiumSite } from './podium-layout';
export * from './podium-timeline';
