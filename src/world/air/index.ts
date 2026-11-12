/** Barrel for what a map puts in its air: the heat vents' rising streaks and drifting ash. */

export {
  ASH_FALL_RENDER_ORDER,
  ASH_FLAKE_COUNTS,
  createAshFall,
} from './ash-fall';
export type { AshFall, AshFallOptions } from './ash-fall';
export {
  VENT_CARDS_PER_WEIGHT,
  VENT_CARD_STRIDE,
  VENT_COLUMN_RENDER_ORDER,
  VENT_GLOW_COLOR,
  createVentColumns,
  placeVentCards,
  ventCardCount,
  ventCardWeight,
} from './vent-columns';
export type { VentColumns, VentColumnsOptions } from './vent-columns';
