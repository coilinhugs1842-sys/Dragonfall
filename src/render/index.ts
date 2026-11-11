/** Barrel for the render base: the one renderer, quality application and dynamic resolution. */

export { DYNRES_SCALE_STEP, DYNRES_TARGET_FRAME_MS, DynamicResolution } from './dynamic-resolution';
export { computePixelRatio } from './render-scale';
export { createGameRenderer, WebGL2UnavailableError } from './renderer';
export type { GameRenderer, RenderStats } from './renderer';
