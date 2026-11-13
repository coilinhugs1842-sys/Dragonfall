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
  pushShardEvent,
  resetHudState,
  writeHudClock,
  writeHudLocal,
} from './hud-state';
export { createDragonTagWriter } from './dragon-tags';
export type { DragonTagFrame, DragonTagWriter, TagViewer } from './dragon-tags';
export { TAG_TUNING } from './tag-model';
export type {
  MutableHudCompassMarker,
  MutableHudDamageArc,
  MutableHudDragonTag,
  MutableHudLocalState,
  MutableHudRelayState,
  MutableHudReticleState,
  MutableHudShardState,
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
