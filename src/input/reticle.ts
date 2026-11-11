/**
 * Mouse-aim maths: a virtual reticle inside a unit circle. Plain numbers in, plain numbers out.
 *
 * THE MODEL ("the dragon turns toward the reticle", docs/GAME_DESIGN.md). With pointer lock the
 * mouse has no position, only deltas. The deltas move a virtual reticle whose offset from the
 * screen centre is the steering stick: offset / radius = steer vector. Pushing the mouse right
 * moves the reticle right and the dragon keeps turning right for as long as the reticle stays
 * there, at a rate set by how far out it is. Left alone, the reticle eases back to the centre,
 * so the dragon levels out by itself and a new player cannot get stuck in a spiral.
 *
 * - Dead zone: a small disc round the centre gives no steer, so hand tremor does not wobble the
 *   dragon. The response starts at 0 on its edge (no jump).
 * - Response curve: `gain = t ^ exponent` with t = 0..1 across the rest of the radius. An
 *   exponent above 1 gives fine control near the centre and full rate at the rim.
 * - The offset is clamped to the circle, so overshooting the rim never has to be "unwound".
 *
 * Coordinates: x right, y UP (screen y is flipped by the caller), both in [-1, 1].
 */

/** Below this magnitude an offset counts as centred (avoids 0/0). */
const CENTRE_EPSILON = 1e-9;
/** A dead zone can never swallow the whole circle. */
const MAX_DEAD_ZONE = 0.95;

/** Reticle units for one mouse count: `sensitivity / radiusCounts`, 0 for unusable values. */
export function reticleUnitsPerCount(sensitivity: number, radiusCounts: number): number {
  if (!(sensitivity > 0) || !(radiusCounts > 0)) return 0;
  const units = sensitivity / radiusCounts;
  return Number.isFinite(units) ? units : 0;
}

/**
 * Factor that brings (x, y) back onto the unit circle: 1 inside it, 1 / length outside.
 * Multiply both components by it.
 */
export function unitCircleScale(x: number, y: number): number {
  const lengthSq = x * x + y * y;
  if (!(lengthSq > 1)) return 1;
  return 1 / Math.sqrt(lengthSq);
}

/**
 * Steer gain for a reticle at `magnitude` (0..1) from the centre: multiply BOTH offset
 * components by the result to get the steer vector. 0 inside the dead zone; at the rim the
 * steer vector has length 1. Returning a scalar keeps the direction exact and allocates nothing.
 */
export function reticleSteerGain(magnitude: number, deadZone: number, exponent: number): number {
  if (!(magnitude > CENTRE_EPSILON)) return 0;
  const dead = deadZone > 0 ? (deadZone < MAX_DEAD_ZONE ? deadZone : MAX_DEAD_ZONE) : 0;
  if (magnitude <= dead) return 0;
  const m = magnitude < 1 ? magnitude : 1;
  const t = (m - dead) / (1 - dead);
  const curved = exponent > 0 && exponent !== 1 ? Math.pow(t, exponent) : t;
  return curved / magnitude;
}

/**
 * Multiplier for the reticle offset after `dtS` seconds of easing back to the centre at
 * `recenterRate` (1/s, exponential). Frame-rate independent; 1 (no change) for a rate of 0.
 */
export function reticleDecay(recenterRate: number, dtS: number): number {
  if (!(recenterRate > 0) || !(dtS > 0)) return 1;
  return Math.exp(-recenterRate * dtS);
}
