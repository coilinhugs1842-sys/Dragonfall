/** Barrel for the greybox map view: chunked render meshes and the optional debug overlay. */

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
export { createMapView, mapDrawDistance } from './map-view';
export type { MapView, MapViewOptions, MapViewStats } from './map-view';
