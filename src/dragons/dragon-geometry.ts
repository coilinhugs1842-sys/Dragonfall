/**
 * Placeholder dragon mesh data (T-1.8): a lofted hexagonal body (tail, trunk, neck, head wedge),
 * two horns, optional fins, and two flat wings, as ONE non-indexed, flat-shaded triangle list
 * of about 150-180 triangles. Pure typed arrays: the view wraps them in a BufferGeometry.
 *
 * DRAGON SPACE (the sim's convention, src/sim/flight.ts): +Z is FORWARD (nose), +Y is UP and
 * +X is the dragon's LEFT. Metres. The origin is the middle of the trunk.
 *
 * WINDING: counter-clockwise seen from outside (three.js front faces). Body triangles are
 * oriented by construction (away from the spine), so a mistake in point order cannot flip a
 * face. Wings and fins are flat and emitted twice, once per side, so the material can stay
 * single-sided.
 *
 * WING ANIMATION DATA: the `wing` attribute (4 floats per vertex) feeds the vertex shader in
 * dragon-shader.ts:
 *   x  signed X of the shoulder hinge this vertex turns around (+ left wing, - right wing,
 *      0 = not a wing vertex). The hinge is at (x, WING_HINGE_Y, WING_HINGE_Z).
 *   y  0 at the wing root .. 1 at the tip (how much of the extra "tip" flap it takes)
 *   z  0 at the hips .. 1 at the tail tip (how much the tail sways)
 *   w  0..1 membrane mask: how much team-coloured emissive this vertex gets
 * Wings are modelled SPREAD FLAT in the hinge's horizontal plane.
 */

import { Color } from 'three';
import type { DragonShape } from './dragon-shapes';

export const WING_HINGE_Y = 0.3;
export const WING_HINGE_Z = 0.9;
export const DRAGON_WING_ITEM_SIZE = 4;
/** Hard cap of the task: a placeholder dragon stays at or under this many triangles. */
export const DRAGON_MAX_TRIANGLES = 300;

const RING_SIDES = 6;
const HIP_Z = -1.9;
const NECK_BASE_Z = 1.9;
/** Hinge X as a fraction of girth: just inside the flank so the wing root is never detached. */
const HINGE_X_PER_GIRTH = 0.5;
const BELLY_NORMAL_Y = -0.35;
/** Membrane mask along the wing's leading edge (the arm): almost no team glow. */
const LEADING_EDGE_MASK = 0.05;

export interface DragonGeometryData {
  /** xyz per vertex, dragon space. */
  readonly positions: Float32Array;
  /** Unit face normal per vertex. */
  readonly normals: Float32Array;
  /** Linear RGB per vertex. */
  readonly colors: Float32Array;
  /** See WING ANIMATION DATA at the top. */
  readonly wing: Float32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Radius around the origin that contains every vertex with the wings spread. */
  readonly boundingRadius: number;
}

// --- Writer (load-time scratch) ------------------------------------------------------------------

/** x y z, r g b, hingeX tip tail membrane. */
const CORNER_STRIDE = 10;
const corners = new Float64Array(3 * CORNER_STRIDE);
const normal = new Float64Array(3);

interface Writer {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly wing: Float32Array;
  vertex: number;
}

function setCorner(index: number, x: number, y: number, z: number): void {
  const o = index * CORNER_STRIDE;
  corners[o] = x;
  corners[o + 1] = y;
  corners[o + 2] = z;
  for (let i = 3; i < CORNER_STRIDE; i++) corners[o + i] = 0;
}

function setCornerColor(index: number, color: Color): void {
  const o = index * CORNER_STRIDE;
  corners[o + 3] = color.r;
  corners[o + 4] = color.g;
  corners[o + 5] = color.b;
}

function setCornerWing(index: number, hingeX: number, tip: number, membrane: number): void {
  const o = index * CORNER_STRIDE;
  corners[o + 6] = hingeX;
  corners[o + 7] = tip;
  corners[o + 9] = membrane;
}

function setCornerTail(index: number, tail: number): void {
  corners[index * CORNER_STRIDE + 8] = tail;
}

function corner(index: number, field: number): number {
  return corners[index * CORNER_STRIDE + field] ?? 0;
}

/** Normal of the scratch triangle in the order 0, 1, 2. Returns false when it has no area. */
function computeNormal(): boolean {
  const ux = corner(1, 0) - corner(0, 0);
  const uy = corner(1, 1) - corner(0, 1);
  const uz = corner(1, 2) - corner(0, 2);
  const vx = corner(2, 0) - corner(0, 0);
  const vy = corner(2, 1) - corner(0, 1);
  const vz = corner(2, 2) - corner(0, 2);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-9) return false;
  normal[0] = nx / length;
  normal[1] = ny / length;
  normal[2] = nz / length;
  return true;
}

/** Appends the scratch triangle in the corner order i0, i1, i2 with the normal times `sign`. */
function emit(w: Writer, i0: number, i1: number, i2: number, sign: number): void {
  const order = [i0, i1, i2];
  for (const index of order) {
    const o = w.vertex * 3;
    w.positions[o] = corner(index, 0);
    w.positions[o + 1] = corner(index, 1);
    w.positions[o + 2] = corner(index, 2);
    w.normals[o] = (normal[0] ?? 0) * sign;
    w.normals[o + 1] = (normal[1] ?? 0) * sign;
    w.normals[o + 2] = (normal[2] ?? 0) * sign;
    w.colors[o] = corner(index, 3);
    w.colors[o + 1] = corner(index, 4);
    w.colors[o + 2] = corner(index, 5);
    const a = w.vertex * DRAGON_WING_ITEM_SIZE;
    w.wing[a] = corner(index, 6);
    w.wing[a + 1] = corner(index, 7);
    w.wing[a + 2] = corner(index, 8);
    w.wing[a + 3] = corner(index, 9);
    w.vertex++;
  }
}

// --- Builder -------------------------------------------------------------------------------------

/** Builds one class's placeholder mesh. Load-time code. */
export function buildDragonGeometry(shape: DragonShape): DragonGeometryData {
  const capacity = DRAGON_MAX_TRIANGLES * 3;
  const w: Writer = {
    positions: new Float32Array(capacity * 3),
    normals: new Float32Array(capacity * 3),
    colors: new Float32Array(capacity * 3),
    wing: new Float32Array(capacity * DRAGON_WING_ITEM_SIZE),
    vertex: 0,
  };

  // `Color.setHex` decodes sRGB into the linear working space, which is what a `color`
  // vertex attribute must hold.
  const hide = new Color().setHex(shape.hideColor);
  const belly = new Color().setHex(shape.bellyColor);
  const membrane = new Color().setHex(shape.membraneColor);
  const horn = new Color().copy(belly).lerp(new Color(1, 1, 1), 0.35);
  const edge = new Color();

  const g = shape.girth;
  const tailLength = Math.max(shape.tailLength, 0.5);
  const tailWeight = (z: number): number => {
    const t = (HIP_Z - z) / tailLength;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };

  /**
   * A body triangle from the three scratch corners: wound so its normal points away from the
   * axis A -> B (the spine segment it wraps), coloured belly or hide by which way it faces.
   */
  const bodyTriangle = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: Color | null,
  ): void => {
    if (!computeNormal()) return;
    const cx = (corner(0, 0) + corner(1, 0) + corner(2, 0)) / 3;
    const cy = (corner(0, 1) + corner(1, 1) + corner(2, 1)) / 3;
    const cz = (corner(0, 2) + corner(1, 2) + corner(2, 2)) / 3;
    // Closest point of the axis line to the centroid.
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    const t = lengthSq > 0 ? ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / lengthSq : 0;
    const outX = cx - (ax + dx * t);
    const outY = cy - (ay + dy * t);
    const outZ = cz - (az + dz * t);
    const facing = (normal[0] ?? 0) * outX + (normal[1] ?? 0) * outY + (normal[2] ?? 0) * outZ;
    const sign = facing < 0 ? -1 : 1;
    const paint = color ?? ((normal[1] ?? 0) * sign < BELLY_NORMAL_Y ? belly : hide);
    for (let i = 0; i < 3; i++) {
      setCornerColor(i, paint);
      setCornerTail(i, tailWeight(corner(i, 2)));
    }
    if (sign > 0) emit(w, 0, 1, 2, 1);
    else emit(w, 0, 2, 1, -1);
  };

  /** A flat triangle from the scratch corners, emitted once per side. */
  const doubleTriangle = (): void => {
    if (!computeNormal()) return;
    emit(w, 0, 1, 2, 1);
    emit(w, 0, 2, 1, -1);
  };

  // --- Body: hexagonal rings along the spine, tail tip to snout -----------------------------------
  // Each ring: z, half width, half height, centre y.
  const neckEnd = NECK_BASE_Z + shape.neckLength;
  const rings: readonly (readonly [number, number, number, number])[] = [
    [HIP_Z - tailLength * 0.7, 0.13 * g, 0.12 * g, 0.08],
    [HIP_Z - tailLength * 0.35, 0.27 * g, 0.25 * g, 0.05],
    [HIP_Z, 0.5 * g, 0.48 * g, 0],
    [-0.6, 0.7 * g, 0.64 * g, -0.05],
    [0.8, 0.75 * g, 0.7 * g, 0],
    [NECK_BASE_Z, 0.48 * g, 0.5 * g, 0.12],
    [NECK_BASE_Z + shape.neckLength * 0.5, 0.31 * g, 0.34 * g, 0.32],
    [neckEnd, 0.36 * g, 0.36 * g, 0.48],
    [neckEnd + shape.headLength * 0.3, 0.44 * g, 0.36 * g, 0.5],
  ];
  const tailTipZ = HIP_Z - tailLength;
  const tailTipY = 0.1;
  const snoutZ = neckEnd + shape.headLength;
  const snoutY = 0.36;

  const ringX = (ring: readonly [number, number, number, number], k: number): number =>
    ring[1] * Math.cos((k * Math.PI * 2) / RING_SIDES);
  const ringY = (ring: readonly [number, number, number, number], k: number): number =>
    ring[3] + ring[2] * Math.sin((k * Math.PI * 2) / RING_SIDES);

  const first = rings[0];
  const last = rings[rings.length - 1];
  if (first !== undefined && last !== undefined) {
    for (let k = 0; k < RING_SIDES; k++) {
      // Tail tip cone.
      setCorner(0, 0, tailTipY, tailTipZ);
      setCorner(1, ringX(first, k), ringY(first, k), first[0]);
      setCorner(2, ringX(first, k + 1), ringY(first, k + 1), first[0]);
      bodyTriangle(0, tailTipY, tailTipZ, 0, first[3], first[0], null);
      // Snout wedge.
      setCorner(0, 0, snoutY, snoutZ);
      setCorner(1, ringX(last, k), ringY(last, k), last[0]);
      setCorner(2, ringX(last, k + 1), ringY(last, k + 1), last[0]);
      bodyTriangle(0, last[3], last[0], 0, snoutY, snoutZ, null);
    }
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    if (a === undefined || b === undefined) continue;
    for (let k = 0; k < RING_SIDES; k++) {
      setCorner(0, ringX(a, k), ringY(a, k), a[0]);
      setCorner(1, ringX(a, k + 1), ringY(a, k + 1), a[0]);
      setCorner(2, ringX(b, k + 1), ringY(b, k + 1), b[0]);
      bodyTriangle(0, a[3], a[0], 0, b[3], b[0], null);
      setCorner(0, ringX(a, k), ringY(a, k), a[0]);
      setCorner(1, ringX(b, k + 1), ringY(b, k + 1), b[0]);
      setCorner(2, ringX(b, k), ringY(b, k), b[0]);
      bodyTriangle(0, a[3], a[0], 0, b[3], b[0], null);
    }
  }

  /** Y of the top of the back at `z` (flat top face of the hexagonal rings). */
  const backTopY = (z: number): number => {
    const flatTop = Math.sin(Math.PI / 3);
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i];
      const b = rings[i + 1];
      if (a === undefined || b === undefined || z > b[0]) continue;
      const t = Math.min(Math.max((z - a[0]) / (b[0] - a[0]), 0), 1);
      return a[3] + a[2] * flatTop + (b[3] + b[2] * flatTop - a[3] - a[2] * flatTop) * t;
    }
    return last === undefined ? 0 : last[3] + last[2] * flatTop;
  };

  // --- Horns: two open three-sided spikes sweeping back from the skull -----------------------------
  if (last !== undefined && shape.hornLength > 0) {
    const baseRadius = 0.13 * g;
    for (let side = -1; side <= 1; side += 2) {
      const bx = side * 0.24 * g;
      const by = last[3] + last[2] * 0.6;
      const bz = last[0] - 0.05;
      const tx = side * 0.4 * g;
      const ty = by + shape.hornLength * 0.55;
      const tz = bz - shape.hornLength;
      for (let k = 0; k < 3; k++) {
        const a0 = (k * Math.PI * 2) / 3;
        const a1 = ((k + 1) * Math.PI * 2) / 3;
        setCorner(0, tx, ty, tz);
        setCorner(1, bx + Math.cos(a0) * baseRadius, by, bz + Math.sin(a0) * baseRadius);
        setCorner(2, bx + Math.cos(a1) * baseRadius, by, bz + Math.sin(a1) * baseRadius);
        bodyTriangle(bx, by - 0.2, bz, tx, ty, tz, horn);
      }
    }
  }

  // --- Fins in the dragon's mirror plane (x = 0), double-sided ------------------------------------
  const fin = (z0: number, z1: number, height: number, lean: number, color: Color): void => {
    const peakZ = (z0 + z1) * 0.5 - lean;
    setCorner(0, 0, backTopY(z0) - 0.08, z0);
    setCorner(1, 0, backTopY((z0 + z1) * 0.5) + height, peakZ);
    setCorner(2, 0, backTopY(z1) - 0.08, z1);
    for (let i = 0; i < 3; i++) {
      setCornerColor(i, color);
      setCornerTail(i, tailWeight(corner(i, 2)));
    }
    doubleTriangle();
  };
  if (shape.crestHeight > 0) {
    fin(NECK_BASE_Z + 0.1, neckEnd - 0.1, shape.crestHeight, shape.neckLength * 0.2, membrane);
    fin(neckEnd, neckEnd + shape.headLength * 0.3, shape.crestHeight * 0.7, 0.3, membrane);
  }
  for (let i = 0; i < shape.backPlates; i++) {
    const z = HIP_Z + 0.3 + ((NECK_BASE_Z - HIP_Z - 0.6) * (i + 0.5)) / shape.backPlates;
    fin(z - 0.38, z + 0.38, 0.5 * g, 0.2, horn);
  }

  // --- Wings: a triangle fan from the shoulder over a scalloped outline -----------------------------
  // Outline in wing space: x = outward from the hinge, z = forward. Per point: x, z, membrane.
  const span = shape.wingSpan;
  const chord = shape.wingChord;
  const fingers = Math.max(2, Math.floor(shape.wingFingers));
  const outline: number[] = [];
  const rootFrontZ = chord * 0.4;
  const wristX = span * 0.42;
  const wristZ = rootFrontZ + chord * 0.12;
  const tipX = span;
  const tipZ = -shape.wingSweep;
  const rootBackZ = -chord * 0.6;
  outline.push(wristX, wristZ, LEADING_EDGE_MASK);
  outline.push(tipX, tipZ, 0.2);
  let previousX = tipX;
  let previousZ = tipZ;
  for (let j = 1; j <= fingers; j++) {
    const u = j / fingers;
    // Finger tips run from the wing tip to the root's trailing corner, bulging backwards.
    const fx = tipX * (1 - u);
    const fz = tipZ + (rootBackZ - tipZ) * u - chord * 0.3 * Math.sin(Math.PI * u);
    // The notch between two finger tips is pulled toward the fan's origin (the root's leading
    // corner): a purely radial move, so the fan triangles can never overlap.
    const mx = (previousX + fx) * 0.5;
    const mz = (previousZ + fz) * 0.5;
    outline.push(mx * (1 - shape.wingNotch), mz + (rootFrontZ - mz) * shape.wingNotch, 0.55);
    outline.push(fx, fz, j === fingers ? 0.35 : 1);
    previousX = fx;
    previousZ = fz;
  }

  const hingeX = HINGE_X_PER_GIRTH * g;
  const wingCorner = (index: number, side: number, x: number, z: number, mask: number): void => {
    setCorner(index, side * (hingeX + x), WING_HINGE_Y, WING_HINGE_Z + z);
    // Leading edge reads as hide (the wing arm), the trailing membrane takes the glow.
    edge.copy(hide).lerp(membrane, mask);
    setCornerColor(index, edge);
    const tip = x / span;
    setCornerWing(index, side * hingeX, tip < 0 ? 0 : tip > 1 ? 1 : tip, mask);
  };
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i + 5 < outline.length; i += 3) {
      wingCorner(0, side, 0, rootFrontZ, LEADING_EDGE_MASK);
      wingCorner(1, side, outline[i] ?? 0, outline[i + 1] ?? 0, outline[i + 2] ?? 0);
      wingCorner(2, side, outline[i + 3] ?? 0, outline[i + 4] ?? 0, outline[i + 5] ?? 0);
      doubleTriangle();
    }
  }

  // --- Trim ------------------------------------------------------------------------------------------
  const vertexCount = w.vertex;
  let radiusSq = 0;
  for (let i = 0; i < vertexCount * 3; i += 3) {
    const x = w.positions[i] ?? 0;
    const y = w.positions[i + 1] ?? 0;
    const z = w.positions[i + 2] ?? 0;
    radiusSq = Math.max(radiusSq, x * x + y * y + z * z);
  }
  return {
    positions: w.positions.slice(0, vertexCount * 3),
    normals: w.normals.slice(0, vertexCount * 3),
    colors: w.colors.slice(0, vertexCount * 3),
    wing: w.wing.slice(0, vertexCount * DRAGON_WING_ITEM_SIZE),
    vertexCount,
    triangleCount: vertexCount / 3,
    boundingRadius: Math.sqrt(radiusSq),
  };
}
