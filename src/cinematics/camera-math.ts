/**
 * Camera maths the cinematics share: easing, a Catmull-Rom path with even speed, an orbit pose,
 * damping that is the same at any frame rate, and the terrain pull-in of a sight line.
 *
 * Everything here works on the plain `Vec3` shapes of `src/shared` and writes into out-params,
 * so it runs in node (tests/cinematics/camera-math.test.ts) and never allocates: the scripted
 * cameras call it every frame. three.js appears only as a type, in `aimCamera` at the bottom.
 *
 * CONVENTIONS (the same as the sim and the chase camera): +Y up, metres, radians. A heading is a
 * yaw about +Y with 0 = +Z, so its direction is (sin yaw, 0, cos yaw). A dragon's nose is its
 * local +Z.
 */
import type { PerspectiveCamera } from 'three';
import type { MutableVec3, Quat, TerrainQuery, Vec3 } from '../shared';

const TINY = 1e-9;
const TWO_PI = Math.PI * 2;

// --- Scalars and easing ----------------------------------------------------------------------------

/** Clamps to 0..1; NaN becomes 0. */
export function clamp01(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0 at `edge0` and before, 1 at `edge1` and after, with zero slope at both ends. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  // A zero-width edge is a step: nothing to ease over.
  if (!(Math.abs(span) > TINY)) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / span);
  return t * t * (3 - 2 * t);
}

/** Starts from rest: slow, then fast. `t` is clamped to 0..1. */
export function easeInCubic(t: number): number {
  const u = clamp01(t);
  return u * u * u;
}

/** Arrives at rest: fast, then slow. */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/** Rest to rest, with most of the travel in the middle (peak speed three times the mean). */
export function easeInOutCubic(t: number): number {
  const u = clamp01(t);
  if (u < 0.5) return 4 * u * u * u;
  const v = 1 - u;
  return 1 - 4 * v * v * v;
}

/**
 * Rest to rest at an even pace in between: speed ramps up over the first `ramp` of the move,
 * holds, and ramps down over the last `ramp`. Peak speed is `1 / (1 - ramp)` times the mean,
 * against 1.5 for `smoothstep`, so a big swing never whips. `ramp` is clamped to 0.05..0.5.
 */
export function easeRamp(t: number, ramp: number): number {
  const u = clamp01(t);
  const r = clamp(ramp, 0.05, 0.5) || 0.5;
  const peak = 1 / (1 - r);
  if (u < r) return (peak * u * u) / (2 * r);
  if (u > 1 - r) return 1 - (peak * (1 - u) * (1 - u)) / (2 * r);
  return peak * (u - r * 0.5);
}

/**
 * Travel 0..1 of a move that is already under way when the shot starts and slows toward its
 * end: speed `1 + brake` times the mean at t = 0, `1 - 2 * brake` times at t = 1. A cut onto a
 * moving camera reads as one confident move; a full stop before the next cut reads as a wait.
 * `brake` is clamped to 0..0.5 (at 0.5 the move just comes to rest).
 */
export function easeCoast(t: number, brake: number): number {
  const u = clamp01(t);
  const b = clamp(brake, 0, 0.5) || 0;
  return u + b * (u - u * u * u);
}

/**
 * Fraction of the remaining distance covered after `dtS` at `rate` (1/s): `1 - e^(-rate dt)`.
 * `value += (target - value) * damping(rate, dt)` follows the same curve at 30 and at 144 fps.
 */
export function damping(rate: number, dtS: number): number {
  if (!(rate > 0) || !(dtS > 0)) return 0;
  return 1 - Math.exp(-rate * dtS);
}

/** Brings an angle into -PI..PI. */
export function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

/** Eases `current` toward `target` the short way round and returns the new angle (-PI..PI). */
export function dampAngle(current: number, target: number, rate: number, dtS: number): number {
  return wrapAngle(current + wrapAngle(target - current) * damping(rate, dtS));
}

// --- Vectors ---------------------------------------------------------------------------------------

export function setVec3(out: MutableVec3, x: number, y: number, z: number): MutableVec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function lerpVec3(out: MutableVec3, a: Vec3, b: Vec3, t: number): MutableVec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function distanceVec3(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * The world direction of a dragon's nose (its local +Z) into `out`, unit length. The quaternion
 * need not be unit; a degenerate one gives +Z.
 */
export function forwardOfQuat(out: MutableVec3, q: Quat): MutableVec3 {
  const lengthSq = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (!(lengthSq > TINY) || !Number.isFinite(lengthSq)) return setVec3(out, 0, 0, 1);
  const s = 2 / lengthSq;
  const x = s * (q.x * q.z + q.w * q.y);
  const y = s * (q.y * q.z - q.w * q.x);
  const z = 1 - s * (q.x * q.x + q.y * q.y);
  const length = Math.sqrt(x * x + y * y + z * z);
  if (!(length > TINY)) return setVec3(out, 0, 0, 1);
  return setVec3(out, x / length, y / length, z / length);
}

/** Heading of a horizontal direction: 0 = +Z, PI/2 = +X. (0, 0) gives 0. */
export function yawOfDirection(x: number, z: number): number {
  return Math.atan2(x, z);
}

/**
 * The damped look-at: eases the point a camera looks at toward its subject, so a subject that
 * jerks, or a change of subject, turns the camera smoothly instead of snapping it. Keep
 * `current` between frames and hand it to `aimCamera`. Frame-rate independent.
 */
export function dampLookTarget(
  current: MutableVec3,
  subject: Vec3,
  rate: number,
  dtS: number,
): MutableVec3 {
  const k = damping(rate, dtS);
  current.x += (subject.x - current.x) * k;
  current.y += (subject.y - current.y) * k;
  current.z += (subject.z - current.z) * k;
  return current;
}

/**
 * Orbit pose: the point `radius` metres out from the centre at heading `azimuth` (0 = on the +Z
 * side, PI/2 = on the +X side) and `height` metres above it.
 */
export function writeOrbitPosition(
  out: MutableVec3,
  centre: Vec3,
  radius: number,
  azimuth: number,
  height: number,
): MutableVec3 {
  out.x = centre.x + Math.sin(azimuth) * radius;
  out.y = centre.y + height;
  out.z = centre.z + Math.cos(azimuth) * radius;
  return out;
}

// --- Catmull-Rom path ------------------------------------------------------------------------------
//
// Centripetal Catmull-Rom: the curve passes through every point, and unlike the uniform kind it
// cannot loop or overshoot where a short segment follows a long one, which is exactly what a
// hand-placed camera path looks like (a long approach, then tight points between the rocks). The
// two ends are extended by mirroring the neighbour, so the path starts at the first point and
// ends at the last.

// Results of `evalSegment`, read straight after the call.
let segX = 0;
let segY = 0;
let segZ = 0;

/** Math.hypot builds an argument array inside the engine; this stays on the stack. */
function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** One component of the cubic Hermite segment (or its derivative). */
function hermite(p1: number, m1: number, p2: number, m2: number, s: number, slope: boolean): number {
  const s2 = s * s;
  if (slope) {
    return (6 * s2 - 6 * s) * (p1 - p2) + (3 * s2 - 4 * s + 1) * m1 + (3 * s2 - 2 * s) * m2;
  }
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * p1 + (s3 - 2 * s2 + s) * m1 + (3 * s2 - 2 * s3) * p2 + (s3 - s2) * m2
  );
}

/**
 * Position (or, with `slope`, the derivative with respect to `u`) at `u` in 0..1 along the
 * whole path, into segX/Y/Z. Each segment between two points takes the same share of `u`.
 */
function evalSegment(points: readonly Vec3[], u: number, slope: boolean): void {
  const count = points.length;
  const first = points[0];
  if (first === undefined) {
    segX = 0;
    segY = 0;
    segZ = slope ? 1 : 0;
    return;
  }
  if (count === 1) {
    segX = slope ? 0 : first.x;
    segY = slope ? 0 : first.y;
    segZ = slope ? 1 : first.z;
    return;
  }
  const segments = count - 1;
  const scaled = clamp01(u) * segments;
  let index = Math.floor(scaled);
  if (index > segments - 1) index = segments - 1;
  const s = scaled - index;

  const p1 = points[index] ?? first;
  const p2 = points[index + 1] ?? p1;
  const before = points[index - 1];
  const after = points[index + 2];
  // Mirrored phantom ends: p0 = 2 p1 - p2, p3 = 2 p2 - p1.
  const p0x = before !== undefined ? before.x : 2 * p1.x - p2.x;
  const p0y = before !== undefined ? before.y : 2 * p1.y - p2.y;
  const p0z = before !== undefined ? before.z : 2 * p1.z - p2.z;
  const p3x = after !== undefined ? after.x : 2 * p2.x - p1.x;
  const p3y = after !== undefined ? after.y : 2 * p2.y - p1.y;
  const p3z = after !== undefined ? after.z : 2 * p2.z - p1.z;

  // Knot spacing = square root of the chord (centripetal).
  const d12 = Math.sqrt(length3(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z));
  if (!(d12 > TINY)) {
    // Two points on the same spot: nothing to travel along.
    segX = slope ? 0 : p1.x;
    segY = slope ? 0 : p1.y;
    segZ = slope ? 0 : p1.z;
    return;
  }
  let d01 = Math.sqrt(length3(p1.x - p0x, p1.y - p0y, p1.z - p0z));
  let d23 = Math.sqrt(length3(p3x - p2.x, p3y - p2.y, p3z - p2.z));
  if (!(d01 > TINY)) d01 = d12;
  if (!(d23 > TINY)) d23 = d12;

  // Tangents at p1 and p2 in Hermite form (Barry-Goldman, rearranged).
  const a1 = d12 / d01;
  const b1 = d12 / (d01 + d12);
  const a2 = d12 / d23;
  const b2 = d12 / (d12 + d23);
  const m1x = p2.x - p1.x + a1 * (p1.x - p0x) - b1 * (p2.x - p0x);
  const m1y = p2.y - p1.y + a1 * (p1.y - p0y) - b1 * (p2.y - p0y);
  const m1z = p2.z - p1.z + a1 * (p1.z - p0z) - b1 * (p2.z - p0z);
  const m2x = p2.x - p1.x + a2 * (p3x - p2.x) - b2 * (p3x - p1.x);
  const m2y = p2.y - p1.y + a2 * (p3y - p2.y) - b2 * (p3y - p1.y);
  const m2z = p2.z - p1.z + a2 * (p3z - p2.z) - b2 * (p3z - p1.z);

  // d/du = segments * d/ds.
  const scale = slope ? segments : 1;
  segX = hermite(p1.x, m1x, p2.x, m2x, s, slope) * scale;
  segY = hermite(p1.y, m1y, p2.y, m2y, s, slope) * scale;
  segZ = hermite(p1.z, m1z, p2.z, m2z, s, slope) * scale;
}

/**
 * The point at `u` (0 = first point, 1 = last; clamped) of the path through `points`. Each
 * segment takes an equal share of `u` whatever its length: for even speed go through
 * `splineParamAtFraction`. No points gives the origin, one point gives that point.
 */
export function catmullRomPoint(out: MutableVec3, points: readonly Vec3[], u: number): MutableVec3 {
  evalSegment(points, u, false);
  return setVec3(out, segX, segY, segZ);
}

/** The unit direction of travel at `u`. Where the path does not move it gives +Z. */
export function catmullRomTangent(
  out: MutableVec3,
  points: readonly Vec3[],
  u: number,
): MutableVec3 {
  evalSegment(points, u, true);
  const length = Math.sqrt(segX * segX + segY * segY + segZ * segZ);
  if (!(length > TINY)) return setVec3(out, 0, 0, 1);
  return setVec3(out, segX / length, segY / length, segZ / length);
}

/**
 * Distance travelled along a path at evenly spaced `u`: what turns "a fraction of the way
 * along" into the `u` to sample at, so the camera moves at an even speed however unevenly the
 * points are spaced.
 */
export interface SplineLengthTable {
  /** `lengths[i]` = metres from the start to `u = i / (lengths.length - 1)`. */
  readonly lengths: Float64Array;
  /** Whole length in metres; 0 until `measureSpline` ran. */
  total: number;
}

/** Load-time: allocates the table. 64 samples put the speed error of a typical path under 1 %. */
export function createSplineLengthTable(samples = 64): SplineLengthTable {
  const count = Number.isFinite(samples) && samples >= 2 ? Math.floor(samples) : 2;
  return { lengths: new Float64Array(count), total: 0 };
}

/** Fills `table` for the path through `points` and returns its length. Does not allocate. */
export function measureSpline(table: SplineLengthTable, points: readonly Vec3[]): number {
  const lengths = table.lengths;
  const last = lengths.length - 1;
  evalSegment(points, 0, false);
  let px = segX;
  let py = segY;
  let pz = segZ;
  let total = 0;
  lengths[0] = 0;
  for (let i = 1; i <= last; i++) {
    evalSegment(points, i / last, false);
    total += length3(segX - px, segY - py, segZ - pz);
    lengths[i] = total;
    px = segX;
    py = segY;
    pz = segZ;
  }
  table.total = Number.isFinite(total) ? total : 0;
  return table.total;
}

/**
 * The `u` at which the path has covered `fraction` (0..1, clamped) of its length. A table that
 * was never measured, or a path of no length, gives `fraction` itself.
 */
export function splineParamAtFraction(table: SplineLengthTable, fraction: number): number {
  const f = clamp01(fraction);
  const lengths = table.lengths;
  const last = lengths.length - 1;
  if (!(table.total > TINY)) return f;
  const want = f * table.total;
  // Binary search for the sample interval that holds `want`.
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((lengths[mid] ?? 0) <= want) low = mid;
    else high = mid;
  }
  const from = lengths[low] ?? 0;
  const span = (lengths[high] ?? from) - from;
  const within = span > TINY ? (want - from) / span : 0;
  return (low + clamp01(within)) / last;
}

// --- Terrain ---------------------------------------------------------------------------------------

/**
 * Keeps a camera out of the rock: looks along the line from the subject (`from`) to where the
 * camera wants to be (`position`), and when terrain is in the way, or closer to the camera than
 * `margin`, moves `position` back along that line toward the subject. Returns the fraction of
 * the distance that was kept (1 = untouched). At most one raycast and one clearance query.
 */
export function pullInFromTerrain(
  position: MutableVec3,
  from: Vec3,
  terrain: TerrainQuery | null,
  margin: number,
): number {
  if (terrain === null) return 1;
  const dx = position.x - from.x;
  const dy = position.y - from.y;
  const dz = position.z - from.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(length > 1e-4) || !Number.isFinite(length)) return 1;
  const gap = margin > 0 ? margin : 0;
  let keep = 1;
  const hit = terrain.raycast(from.x, from.y, from.z, dx, dy, dz, length + gap);
  if (hit >= 0) {
    // Stop short of the hit; half-way to it when it is closer than two margins.
    keep = clamp01((hit - Math.min(gap, hit * 0.5)) / length);
  } else if (gap > 0) {
    // A clear line can still end beside a wall: step in by what is missing of the margin.
    const near = terrain.clearance(position.x, position.y, position.z, gap);
    if (near >= 0) keep = clamp01((length - (gap - near)) / length);
  }
  if (keep < 1) {
    position.x = from.x + dx * keep;
    position.y = from.y + dy * keep;
    position.z = from.z + dz * keep;
  }
  return keep;
}

// --- Camera ----------------------------------------------------------------------------------------

/**
 * Places a camera: at `position`, looking at `target`, rolled by `roll` radians (positive =
 * right wing down, the horizon rises on the right), with a vertical FOV of `fovDeg`. The stage
 * updates the projection and world matrices afterwards (`CameraDirector.direct`). Uses three's
 * own scratch objects: no allocation.
 */
export function aimCamera(
  camera: PerspectiveCamera,
  position: Vec3,
  target: Vec3,
  roll: number,
  fovDeg: number,
): void {
  camera.position.set(position.x, position.y, position.z);
  camera.lookAt(target.x, target.y, target.z);
  // The camera looks down its own -Z, so "right wing down" is a negative turn about +Z.
  if (roll !== 0) camera.rotateZ(-roll);
  camera.fov = fovDeg;
}
