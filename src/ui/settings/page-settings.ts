/**
 * The settings that are pure CSS: interface size, stronger markers, reduced motion. `src/game`
 * calls this from its `setUi` target with `document.documentElement`; the menus, the HUD and the
 * settings panel read the result (`--df-ui-scale`, `data-df-markers`, `data-df-motion`).
 */

export const UI_SCALE_PROPERTY = '--df-ui-scale';

export function applyPageSettings(
  target: HTMLElement,
  uiScale: number,
  colorBlindMarkers: boolean,
  reduceMotion: boolean,
): void {
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1;
  target.style.setProperty(UI_SCALE_PROPERTY, String(scale));
  target.dataset['dfMarkers'] = colorBlindMarkers ? 'strong' : 'normal';
  target.dataset['dfMotion'] = reduceMotion ? 'reduced' : 'full';
}
