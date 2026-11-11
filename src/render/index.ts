/** Barrel for the render base: the one renderer, quality application and dynamic resolution. */

export { DYNRES_SCALE_STEP, DYNRES_TARGET_FRAME_MS, DynamicResolution } from './dynamic-resolution';
export * from './post';
export { computePixelRatio } from './render-scale';
export { createGameRenderer, WebGL2UnavailableError } from './renderer';
export type { GameRenderer, PresetChangeListener, RenderStats } from './renderer';
export * from './camera-rig';
export type { CameraDirector } from './camera-director';
