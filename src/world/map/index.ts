/** Barrel for the map view: real assets or greybox chunks, and the optional debug overlays. */

export {
  DEFAULT_MAP_SHADE,
  bakeMapVertexColors,
  createGlowRoleMask,
  createRolePalette,
  fogHiddenDistance,
  mapVertexShade,
  sphereWithinDistance,
  srgbChannelToLinear,
  writeLinearFromSrgbHex,
} from './map-colors';
export type { MapShadeOptions } from './map-colors';
export { createMapDebugMarkers } from './map-debug-markers';
export type { MapDebugMarkers } from './map-debug-markers';
export { createMapCollisionOverlay } from './map-collision-overlay';
export type { MapCollisionOverlay } from './map-collision-overlay';
export {
  createMapView,
  mapDebugFromLocation,
  mapDrawDistance,
  preloadMapAssets,
} from './map-view';
export type {
  MapDebugOptions,
  MapLoadState,
  MapView,
  MapViewOptions,
  MapViewStats,
} from './map-view';
