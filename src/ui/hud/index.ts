/**
 * `src/ui/hud`: the match HUD and scoreboard (T-3.6, T-3.7). The screen manager mounts
 * `createHud` and feeds it `UiState.hud`; `src/game` builds that state with the helpers from
 * `hud-state` (and the angle helpers from `hud-model`).
 */

export { createHud } from './create-hud';
export type { Hud, HudOptions } from './create-hud';
export {
  ageHudState,
  createHudState,
  pushDamageArc,
  pushKillfeed,
  resetHudState,
  writeHudClock,
  writeHudLocal,
} from './hud-state';
export type {
  MutableHudCompassMarker,
  MutableHudDamageArc,
  MutableHudLocalState,
  MutableHudReticleState,
  MutableHudState,
  MutableIntroCardState,
  MutableKillfeedEntry,
  MutableScoreboardRow,
} from './hud-state';
export {
  DAMAGE_ARC_LIFE_S,
  KILLFEED_LIFE_S,
  formatClock,
  screenAngle,
  wrapAngle,
} from './hud-model';
