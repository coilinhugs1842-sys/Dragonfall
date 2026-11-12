/**
 * Which control a D-pad press moves to: plain rectangle geometry with no DOM, so it can be
 * tested with numbers. `../pad-nav.ts` measures the controls on the page and asks here.
 *
 * The rule, for "down" (the other three are the same turned round): a control qualifies when
 * its centre is clearly lower; among those the nearest wins, where being off to the side costs
 * three times as much as being further down. So a column of rows steps row by row and stays in
 * its column, and a control straight below beats a nearer one diagonally below.
 */

export interface NavRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type NavDirection = 'up' | 'down' | 'left' | 'right';

/** How much a sideways offset costs against distance in the direction of travel. */
const SIDE_WEIGHT = 3;
/** A centre must be at least this many px further along to count as "in that direction". */
const MIN_STEP_PX = 2;

function gap(aLow: number, aHigh: number, bLow: number, bHigh: number): number {
  // 0 when the two spans overlap; otherwise the distance between their nearest ends.
  if (bLow > aHigh) return bLow - aHigh;
  if (aLow > bHigh) return aLow - bHigh;
  return 0;
}

/**
 * The index in `rects` of the control to move to from `from`, or -1 when there is none that
 * way. An entry equal to `from` itself never qualifies (its centre is not further along).
 */
export function pickNeighbour(
  from: NavRect,
  rects: readonly NavRect[],
  direction: NavDirection,
): number {
  const fromX = (from.left + from.right) / 2;
  const fromY = (from.top + from.bottom) / 2;
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'down' || direction === 'right' ? 1 : -1;
  const fromSize = vertical ? from.bottom - from.top : from.right - from.left;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect === undefined) continue;
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    const along = (vertical ? y - fromY : x - fromX) * sign;
    const size = vertical ? rect.bottom - rect.top : rect.right - rect.left;
    // Two controls side by side in one row are not "below" each other because one is taller.
    const step = Math.max(MIN_STEP_PX, Math.min(fromSize, size) * 0.25);
    if (!(along > step)) continue;
    const side = vertical
      ? gap(from.left, from.right, rect.left, rect.right)
      : gap(from.top, from.bottom, rect.top, rect.bottom);
    const score = along + side * SIDE_WEIGHT;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
