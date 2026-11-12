/**
 * The worked stone of the podium, built in code: a low plinth with three joined steps (the
 * middle one highest), plus the team-coloured inlays on their faces. Also the simple rock the
 * stand-in draws under them while the map's real rock is not there.
 *
 * The geometries carry what the painterly world material reads (src/world/props): `aColor`
 * (the painted albedo, linear), `aMasks` (r AO, g moss, b lit edge, a glow) and a box-projected
 * `uv` at the masonry texture's scale. `color` is the same data under the name three's own
 * materials read, for the stand-in. Flat-shaded, a little over a hundred triangles in all.
 *
 * Load-time code: everything here allocates.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { SEAT_COUNT, SEAT_MVP, SEAT_TOP_Y, SEAT_X, SEAT_Z, STEP_BACK, STEP_FRONT } from './podium-layout';
import { hash01 } from './podium-math';

/**
 * Half width (X) of each step's body: [MVP, takedowns, damage]. The three stand shoulder to
 * shoulder (the middle one ends where the side ones begin).
 */
const STEP_HALF_X: readonly number[] = [3.7, 4.3, 4.3];
/** The plinth all three stand on: it covers the low dome of the rock's top. */
const PLINTH_HALF_X = 13.6;
const PLINTH_MIN_Z = -3.5;
const PLINTH_MAX_Z = 5.6;
const PLINTH_BOTTOM_Y = -0.9;
const PLINTH_TOP_Y = 1.45;
/** Each step ends in a cap that stands out a little and is chamfered. */
const CAP_HEIGHT = 0.55;
const CAP_OVERHANG = 0.28;
const CHAMFER = 0.22;
/** Walls lean in by this much from foot to top. */
const BATTER = 0.14;
/** UVs per metre: the masonry texture tiles every 12 m. */
const UV_SCALE = 1 / 12;

/** Painted colours, linear (the values the map's ruin props carry). */
const WALL_LOW: readonly number[] = [0.056, 0.066, 0.092];
const WALL_HIGH: readonly number[] = [0.112, 0.13, 0.172];
const TOP_COLOR: readonly number[] = [0.265, 0.285, 0.32];
const EDGE_COLOR: readonly number[] = [0.5, 0.46, 0.4];
/** Lit-edge mask of the flat tops (the chamfers carry 1). */
const TOP_EDGE = 0.5;
/** The inlays: near white, multiplied by the team colour in the shader. */
const INLAY_COLOR: readonly number[] = [0.9, 0.9, 0.9];
/** Half glow, half lit paint: a full glow mask runs white-hot on a face turned to the camera. */
const INLAY_GLOW = 0.5;
/** How far the inlays stand off the stone, metres (no z-fighting at the podium shot's distance). */
const INLAY_LIFT = 0.05;

/** Rock colours of the stand-in: the map's slate and the moss of its tops. */
const ROCK_SIDE: readonly number[] = [0.114, 0.164, 0.239];
const ROCK_TOP: readonly number[] = [0.1, 0.33, 0.235];

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly colors: number[] = [];
  private readonly masks: number[] = [];
  private readonly indices: number[] = [];

  /** One vertex; returns its index. `masks`: AO, moss, lit edge, glow. */
  private vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    color: readonly number[],
    shade: number,
    ao: number,
    edge: number,
    glow: number,
  ): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    // Box projection: walls by their horizontal run and height, tops by X and Z.
    if (Math.abs(ny) > 0.7) this.uvs.push(x * UV_SCALE, z * UV_SCALE);
    else if (Math.abs(nx) > Math.abs(nz)) this.uvs.push(z * UV_SCALE, y * UV_SCALE);
    else this.uvs.push(x * UV_SCALE, y * UV_SCALE);
    this.colors.push((color[0] ?? 0) * shade, (color[1] ?? 0) * shade, (color[2] ?? 0) * shade);
    this.masks.push(ao, 0, edge, glow);
    return index;
  }

  /**
   * A flat quad a-b-c-d (counter-clockwise seen from outside). `lowColor` paints a and b,
   * `highColor` c and d, so a wall can run from a dark foot to a lighter top.
   */
  quad(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    lowColor: readonly number[],
    highColor: readonly number[],
    lowAo: number,
    edge: number,
    glow: number,
  ): void {
    const ux = (b[0] ?? 0) - (a[0] ?? 0);
    const uy = (b[1] ?? 0) - (a[1] ?? 0);
    const uz = (b[2] ?? 0) - (a[2] ?? 0);
    const vx = (d[0] ?? 0) - (a[0] ?? 0);
    const vy = (d[1] ?? 0) - (a[1] ?? 0);
    const vz = (d[2] ?? 0) - (a[2] ?? 0);
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    const i0 = this.vertex(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, nx, ny, nz, lowColor, 1, lowAo, edge, glow);
    const i1 = this.vertex(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, nx, ny, nz, lowColor, 1, lowAo, edge, glow);
    const i2 = this.vertex(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, nx, ny, nz, highColor, 1, 1, edge, glow);
    const i3 = this.vertex(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, nx, ny, nz, highColor, 1, 1, edge, glow);
    this.indices.push(i0, i1, i2, i0, i2, i3);
  }

  /** A flat triangle a-b-c (counter-clockwise seen from outside), one colour. */
  triangle(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    color: readonly number[],
    shade: number,
  ): void {
    const ux = (b[0] ?? 0) - (a[0] ?? 0);
    const uy = (b[1] ?? 0) - (a[1] ?? 0);
    const uz = (b[2] ?? 0) - (a[2] ?? 0);
    const vx = (c[0] ?? 0) - (a[0] ?? 0);
    const vy = (c[1] ?? 0) - (a[1] ?? 0);
    const vz = (c[2] ?? 0) - (a[2] ?? 0);
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    const i0 = this.vertex(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, nx, ny, nz, color, shade, 1, 0, 0);
    const i1 = this.vertex(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, nx, ny, nz, color, shade, 1, 0, 0);
    const i2 = this.vertex(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, nx, ny, nz, color, shade, 1, 0, 0);
    this.indices.push(i0, i1, i2);
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  build(): BufferGeometry {
    const count = this.positions.length / 3;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    const colors = new Uint8Array(count * 4);
    const masks = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        colors[i * 4 + k] = Math.round(Math.min(1, Math.max(0, this.colors[i * 3 + k] ?? 0)) * 255);
      }
      colors[i * 4 + 3] = 255;
      for (let k = 0; k < 4; k++) {
        masks[i * 4 + k] = Math.round(Math.min(1, Math.max(0, this.masks[i * 4 + k] ?? 0)) * 255);
      }
    }
    const color = new BufferAttribute(colors, 4, true);
    geometry.setAttribute('aColor', color);
    geometry.setAttribute('color', color);
    geometry.setAttribute('aMasks', new BufferAttribute(masks, 4, true));
    geometry.setIndex(new BufferAttribute(new Uint16Array(this.indices), 1));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }
}

/**
 * The four walls of a box from `y0` to `y1`, leaning in by `batter` at the top. Extents are
 * given at the foot.
 */
function walls(
  builder: MeshBuilder,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  y0: number,
  y1: number,
  batter: number,
  lowColor: readonly number[],
  highColor: readonly number[],
  lowAo: number,
  edge: number,
): void {
  const tx0 = minX + batter;
  const tx1 = maxX - batter;
  const tz0 = minZ + batter;
  const tz1 = maxZ - batter;
  // +Z (the front), +X, -Z, -X.
  builder.quad([minX, y0, maxZ], [maxX, y0, maxZ], [tx1, y1, tz1], [tx0, y1, tz1], lowColor, highColor, lowAo, edge, 0);
  builder.quad([maxX, y0, maxZ], [maxX, y0, minZ], [tx1, y1, tz0], [tx1, y1, tz1], lowColor, highColor, lowAo, edge, 0);
  builder.quad([maxX, y0, minZ], [minX, y0, minZ], [tx0, y1, tz0], [tx1, y1, tz0], lowColor, highColor, lowAo, edge, 0);
  builder.quad([minX, y0, minZ], [minX, y0, maxZ], [tx0, y1, tz1], [tx0, y1, tz0], lowColor, highColor, lowAo, edge, 0);
}

/** A block from `y0` up to a chamfered flat top at `y1`. Extents are given at the foot. */
function block(
  builder: MeshBuilder,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  y0: number,
  y1: number,
  batter: number,
): void {
  const shoulder = y1 - CHAMFER;
  walls(builder, minX, maxX, minZ, maxZ, y0, shoulder, batter, WALL_LOW, WALL_HIGH, 0.55, 0);
  const sx0 = minX + batter;
  const sx1 = maxX - batter;
  const sz0 = minZ + batter;
  const sz1 = maxZ - batter;
  // The chamfer: a cream edge the low sun catches.
  walls(builder, sx0, sx1, sz0, sz1, shoulder, y1, CHAMFER, EDGE_COLOR, EDGE_COLOR, 1, 1);
  const tx0 = sx0 + CHAMFER;
  const tx1 = sx1 - CHAMFER;
  const tz0 = sz0 + CHAMFER;
  const tz1 = sz1 - CHAMFER;
  // The world material grows moss on bare upward faces; the lit-edge mask keeps the worked
  // stone of the tops clean, so a dragon's feet read against pale stone.
  builder.quad([tx0, y1, tz1], [tx1, y1, tz1], [tx1, y1, tz0], [tx0, y1, tz0], TOP_COLOR, TOP_COLOR, 1, TOP_EDGE, 0);
}

/** A glowing inlay strip on a wall facing +Z, or (with `nx` = +1 / -1) on one facing +X / -X. */
function inlay(
  builder: MeshBuilder,
  from: number,
  to: number,
  y0: number,
  y1: number,
  wall: number,
  nx: number,
): void {
  if (nx === 0) {
    const z = wall + INLAY_LIFT;
    builder.quad([from, y0, z], [to, y0, z], [to, y1, z], [from, y1, z], INLAY_COLOR, INLAY_COLOR, 1, 0, INLAY_GLOW);
  } else if (nx > 0) {
    const x = wall + INLAY_LIFT;
    builder.quad([x, y0, to], [x, y0, from], [x, y1, from], [x, y1, to], INLAY_COLOR, INLAY_COLOR, 1, 0, INLAY_GLOW);
  } else {
    const x = wall - INLAY_LIFT;
    builder.quad([x, y0, from], [x, y0, to], [x, y1, to], [x, y1, from], INLAY_COLOR, INLAY_COLOR, 1, 0, INLAY_GLOW);
  }
}

export interface PodiumStepsGeometry {
  /** The stone: plinth, three steps and their caps. */
  readonly stone: BufferGeometry;
  /** The team-coloured inlays (drawn with the tint material; white until multiplied). */
  readonly accent: BufferGeometry;
  readonly triangles: number;
}

/** The plinth, the steps and their inlays, in the site frame. */
export function buildPodiumSteps(): PodiumStepsGeometry {
  const stone = new MeshBuilder();
  const accent = new MeshBuilder();
  block(stone, -PLINTH_HALF_X, PLINTH_HALF_X, PLINTH_MIN_Z, PLINTH_MAX_Z, PLINTH_BOTTOM_Y, PLINTH_TOP_Y, BATTER);

  for (let seat = 0; seat < SEAT_COUNT; seat++) {
    const cx = SEAT_X[seat] ?? 0;
    const cz = SEAT_Z[seat] ?? 0;
    const hx = STEP_HALF_X[seat] ?? 0;
    const minZ = cz - STEP_BACK;
    const maxZ = cz + STEP_FRONT;
    const top = SEAT_TOP_Y[seat] ?? 0;
    const capFoot = top - CAP_HEIGHT;
    // Body, then the cap standing out over it.
    walls(stone, cx - hx, cx + hx, minZ, maxZ, PLINTH_TOP_Y, capFoot, BATTER, WALL_LOW, WALL_HIGH, 0.6, 0);
    const bx = hx - BATTER + CAP_OVERHANG;
    const grow = CAP_OVERHANG - BATTER;
    block(stone, cx - bx, cx + bx, minZ - grow, maxZ + grow, capFoot, top, 0);

    // A band of team colour under the cap: on the front, and on each side wall that shows
    // (the middle step stands clear of its neighbours up there; the side steps show their
    // outer wall only).
    const bandTop = capFoot - 0.16;
    const bandFoot = bandTop - 0.34;
    // The walls lean in; the inlays stand straight, a few centimetres proud of them.
    const inset = BATTER * 0.45;
    inlay(accent, cx - hx + 0.7, cx + hx - 0.7, bandFoot, bandTop, maxZ - inset, 0);
    if (seat === SEAT_MVP || cx > 0) inlay(accent, minZ + 0.6, maxZ - 0.6, bandFoot, bandTop, cx + hx - inset, 1);
    if (seat === SEAT_MVP || cx < 0) inlay(accent, minZ + 0.6, maxZ - 0.6, bandFoot, bandTop, cx - hx + inset, -1);
    if (seat === SEAT_MVP) {
      // The winner's mark: a tall lozenge on the front of the highest step.
      const z = maxZ + INLAY_LIFT;
      const midY = (PLINTH_TOP_Y + bandFoot) * 0.5;
      const halfY = Math.min(1.05, (bandFoot - PLINTH_TOP_Y) * 0.5 - 0.35);
      accent.quad(
        [cx, midY - halfY, z],
        [cx + 0.62, midY, z],
        [cx, midY + halfY, z],
        [cx - 0.62, midY, z],
        INLAY_COLOR,
        INLAY_COLOR,
        1,
        0,
        INLAY_GLOW,
      );
    }
  }
  const triangles = stone.triangleCount + accent.triangleCount;
  return { stone: stone.build(), accent: accent.build(), triangles };
}

/**
 * The stand-in rock: a rough upside-down cone with a mossy top, about the size of the map's
 * small island. Site frame, top at y = 0.
 */
export function buildStandInRock(radius: number, depth: number): BufferGeometry {
  const builder = new MeshBuilder();
  const sides = 9;
  // Rings from the rim down to the tip: fraction of the radius, fraction of the depth.
  const rings: readonly number[] = [1, 0, 0.96, 0.06, 0.74, 0.3, 0.42, 0.66, 0.1, 1];
  const point = (ring: number, side: number): number[] => {
    const angle = ((side % sides) / sides) * Math.PI * 2;
    const wobble = 0.86 + 0.28 * hash01(side % sides, ring + 11);
    const r = radius * (rings[ring * 2] ?? 0) * wobble;
    return [Math.sin(angle) * r, -depth * (rings[ring * 2 + 1] ?? 0), Math.cos(angle) * r];
  };
  for (let side = 0; side < sides; side++) {
    builder.triangle([0, 0.6, 0], point(0, side), point(0, side + 1), ROCK_TOP, 1);
    for (let ring = 0; ring + 1 < rings.length / 2; ring++) {
      const shade = 1 - 0.45 * (ring / (rings.length / 2));
      builder.triangle(point(ring, side), point(ring + 1, side), point(ring + 1, side + 1), ROCK_SIDE, shade);
      builder.triangle(point(ring, side), point(ring + 1, side + 1), point(ring, side + 1), ROCK_SIDE, shade);
    }
  }
  return builder.build();
}
