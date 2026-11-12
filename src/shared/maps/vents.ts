/**
 * Heat vents (docs/GAME_DESIGN.md, Emberfall Caldera): the one formula for "how strongly does
 * this point feel that vent". The sim uses it to push dragons (`applyHeatVents`,
 * src/sim/flight.ts) and the views use it to show and sound the same thing, so what a rider
 * sees is what the host simulates.
 *
 * A vent is a vertical column over its mouth: `radius` wide, `height` tall.
 * - Across: full on the axis, nothing at the edge (1 - (d / radius)^2: a soft edge, so brushing
 *   the column is a nudge and its centre is the place to be).
 * - Up: full from the mouth to `VENT_TUNING.fullHeightFraction` of the height, then fading in a
 *   straight line to nothing at the top. Nothing below the mouth (that is the chimney's rock).
 *
 * Pure, deterministic, allocation-free.
 */

import type { MapVent } from '../manifests';
import type { Vec3 } from '../math-types';
import { VENT_TUNING } from '../tuning';
import type { VentTuning } from '../tuning';

/** 0 outside the vent's column .. 1 on its axis near the mouth. NaN-safe: a bad vent gives 0. */
export function heatVentStrength(
  vent: Readonly<MapVent>,
  position: Readonly<Vec3>,
  tuning: Readonly<VentTuning> = VENT_TUNING,
): number {
  const up = position.y - vent.position.y;
  // `!(a >= b)` also catches NaN, here and below.
  if (!(up >= 0) || !(up < vent.height)) return 0;
  const dx = position.x - vent.position.x;
  const dz = position.z - vent.position.z;
  const radiusSq = vent.radius * vent.radius;
  const distanceSq = dx * dx + dz * dz;
  if (!(distanceSq < radiusSq)) return 0;
  const across = 1 - distanceSq / radiusSq;

  const full = tuning.fullHeightFraction;
  const fraction = up / vent.height;
  if (!(fraction > full)) return across;
  const fade = 1 - full;
  return fade > 0 ? across * ((1 - fraction) / fade) : 0;
}

/**
 * The strongest pull any of the map's vents has on a point: what a view shows and sounds for a
 * dragon there. (The sim applies every vent on its own; columns do not overlap on the shipped
 * map, so the two agree.)
 */
export function heatVentStrengthAt(
  vents: readonly MapVent[] | undefined,
  position: Readonly<Vec3>,
): number {
  if (vents === undefined) return 0;
  let best = 0;
  for (let i = 0; i < vents.length; i++) {
    const vent = vents[i];
    if (vent === undefined) continue;
    const strength = heatVentStrength(vent, position);
    if (strength > best) best = strength;
  }
  return best;
}
