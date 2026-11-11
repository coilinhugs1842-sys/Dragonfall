/**
 * The Duel storm wall (docs/GAME_DESIGN.md: "the storm wall shrinks each round"). Two things
 * shrink it, both from MODE_TUNING.duel:
 *
 * - per ROUND: each round starts on a smaller radius (`stormRoundFractions` of the map's own),
 *   but never inside the spawn gates (`stormGateMarginM` outside the furthest slot), so nobody
 *   starts a round in the storm;
 * - over the ROUND'S TIME: after `stormHoldS` the wall closes over `stormShrinkS` to
 *   `stormEndFraction` of the map's radius (at least `stormMinRadiusM`), so a round cannot
 *   stall: two dragons that avoid each other end up in the same small sky.
 *
 * Dragons outside take storm damage and are pushed in by the collision world, as on the map's
 * own wall (`Sim.setStormRadius`).
 */

import { TICK_DT_S } from '../../shared';
import type { DuelTuning } from '../../shared';

/** What the schedule needs to know about the map. */
export interface MatchArena {
  /** The map's own storm radius in metres; <= 0 = the map has no wall (the mode leaves it). */
  stormRadius: number;
  /** Horizontal distance from the storm centre to the furthest spawn slot, in metres. */
  gateRadius: number;
}

export interface StormRadii {
  /** Radius at the start of the round. */
  start: number;
  /** Radius once fully closed. */
  end: number;
  /** Radius now. */
  radius: number;
}

export function createStormRadii(): StormRadii {
  return { start: 0, end: 0, radius: 0 };
}

/**
 * Writes the wall's radius for `round` (1-based) after `liveTicks` ticks of play into `out`.
 * Results go through `out` and time comes in as whole ticks so that no float crosses the call
 * (it runs every tick of a Duel). Returns false, with `out` untouched, when the map has no wall.
 */
export function writeDuelStorm(
  out: StormRadii,
  duel: Readonly<DuelTuning>,
  arena: Readonly<MatchArena>,
  round: number,
  liveTicks: number,
): boolean {
  const mapRadius = arena.stormRadius;
  if (!(mapRadius > 0)) return false;
  const fractions = duel.stormRoundFractions;
  const index = round - 1 < fractions.length ? (round > 1 ? round - 1 : 0) : fractions.length - 1;
  let fraction = fractions[index] ?? 1;
  if (!(fraction > 0)) fraction = 1;
  if (fraction > 1) fraction = 1;

  let start = mapRadius * fraction;
  const gate = arena.gateRadius + duel.stormGateMarginM;
  if (start < gate) start = gate;
  if (start > mapRadius) start = mapRadius;

  let end = mapRadius * duel.stormEndFraction;
  if (!(end >= duel.stormMinRadiusM)) end = duel.stormMinRadiusM;
  if (!(end > 0)) end = 0;
  if (end > start) end = start;

  const sinceHold = liveTicks * TICK_DT_S - duel.stormHoldS;
  let progress = duel.stormShrinkS > 0 ? sinceHold / duel.stormShrinkS : sinceHold >= 0 ? 1 : 0;
  if (!(progress > 0)) progress = 0;
  if (progress > 1) progress = 1;

  out.start = start;
  out.end = end;
  out.radius = start + (end - start) * progress;
  return true;
}
