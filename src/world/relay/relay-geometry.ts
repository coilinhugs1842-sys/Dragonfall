/**
 * The shapes of Ember Relay's objects, built in code at load time (no asset, no texture):
 *
 * - a SHARD STAND per team: a dais of old masonry on a floating root of rock, with stone claws
 *   that cradle the shard hovering above it and a band of glowing panels in the team colour;
 * - a BRAZIER per team: a wide bowl of coals on the same kind of floating root, horned at the rim;
 * - the two SKY-SHARDS: a long crystal with two splinters at its side.
 *
 * Team identity is in the form as well as the colour, the way the HUD pairs the colour with a
 * triangle or a diamond: everything of the Ember Order is built on THREES (three claws, three
 * horns, a three-sided crystal) and everything of the Frost Order on FOURS.
 *
 * Faceted on purpose (every triangle has its own normal): chunky readable forms that light like
 * the map's rock. Colours are painted per face from the palette in docs/ART_DIRECTION.md.
 *
 * Pure numbers, no three.js: the view turns the arrays into two geometries. Vertices are stored
 * relative to their ANCHOR (the stand's or brazier's site, the shard's own centre); the vertex
 * shader adds the anchor's world position, so nothing is rebuilt when a match puts the sites
 * somewhere else.
 */

import { TEAMS, TEAM_EMBER, TEAM_FROST, createSeededRandom } from '../../shared';
import type { TeamId } from '../../shared';
import { setPaintedColor } from '../light/light-math';

/** Anchor slots of the shared `uAnchor` uniform array: add the TeamId. */
export const ANCHOR_STAND = 0;
export const ANCHOR_BRAZIER = 2;
export const ANCHOR_SHARD = 4;
export const ANCHOR_COUNT = 6;

/** Metres from a stand's site (where the shard hovers) down to the top of its dais. */
export const STAND_DAIS_DEPTH_M = 7;
/** Metres from a brazier's site (the heart of its flame) down to the coals. */
export const BRAZIER_COALS_DEPTH_M = 4;
/** Tip to tip of the main crystal, metres. */
export const SHARD_LENGTH_M = 8;

/** Sides of a team's lathes and the number of its claws and horns (see the file comment). */
export function teamFold(team: TeamId): number {
  return team === TEAM_EMBER ? 3 : 4;
}

export interface RelayMeshData {
  /** xyz per vertex, relative to the vertex's anchor. Three vertices per triangle. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** rgb = scene-linear colour, a = how much of it glows (0 = lit stone, 1 = pure light). */
  readonly colors: Float32Array;
  /** Anchor slot per vertex. */
  readonly anchors: Float32Array;
  readonly triangles: number;
}

type Point = readonly [x: number, y: number, z: number];
type Rgba = readonly [r: number, g: number, b: number, glow: number];

function srgbChannel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** A lit surface colour: scene-linear albedo of an sRGB hex. */
function paint(hex: number, shade = 1): Rgba {
  return [
    srgbChannel((hex >> 16) & 0xff) * shade,
    srgbChannel((hex >> 8) & 0xff) * shade,
    srgbChannel(hex & 0xff) * shade,
    0,
  ];
}

/** A glowing colour: what the post pass shows as `hex`, times `gain`. */
function light(hex: number, gain: number): Rgba {
  const target = setPaintedColor({ r: 0, g: 0, b: 0 }, hex, gain);
  return [target.r, target.g, target.b, 1];
}

// docs/ART_DIRECTION.md, "Palette by role".
const SLATE = 0x4e6a86;
const DEEP = 0x2a3346;
const EDGE = 0xc9b79a;
const MOSS = 0x3f8f7a;

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly anchors: number[] = [];
  anchor = 0;

  /** A flat triangle, wound so that it faces away from `inside`. Slivers are dropped. */
  tri(a: Point, b: Point, c: Point, inside: Point, color: Rgba): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-6) return;
    nx /= length;
    ny /= length;
    nz /= length;
    const ox = (a[0] + b[0] + c[0]) / 3 - inside[0];
    const oy = (a[1] + b[1] + c[1]) / 3 - inside[1];
    const oz = (a[2] + b[2] + c[2]) / 3 - inside[2];
    const outward = nx * ox + ny * oy + nz * oz >= 0;
    const second = outward ? b : c;
    const third = outward ? c : b;
    const sign = outward ? 1 : -1;
    for (const p of [a, second, third]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nx * sign, ny * sign, nz * sign);
      this.colors.push(color[0], color[1], color[2], color[3]);
      this.anchors.push(this.anchor);
    }
  }

  quad(a: Point, b: Point, c: Point, d: Point, inside: Point, color: Rgba): void {
    this.tri(a, b, c, inside, color);
    this.tri(a, c, d, inside, color);
  }

  build(): RelayMeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Float32Array(this.colors),
      anchors: new Float32Array(this.anchors),
      triangles: this.positions.length / 9,
    };
  }
}

interface Ring {
  readonly r: number;
  readonly y: number;
  /** Colour of the band between the ring below and this one. */
  readonly color: Rgba;
  /** Every other face of that band takes this colour instead (glowing panels). */
  readonly panel?: Rgba;
  /** A flat or dished band: which way its faces look. Left out = away from the axis. */
  readonly face?: 'up' | 'down';
}

interface LatheOptions {
  readonly sides: number;
  /** Turn of the first corner, radians. */
  readonly phase: number;
  /** 0 = cut masonry, 0.2 = broken rock: each corner moves in or out by up to this share. */
  readonly jitter: number;
  /** How much the faces of one band differ in brightness (painterly facets). */
  readonly vary: number;
  readonly random: () => number;
}

function shaded(color: Rgba, factor: number): Rgba {
  // Light keeps its colour: only lit stone is varied.
  if (color[3] > 0) return color;
  return [color[0] * factor, color[1] * factor, color[2] * factor, 0];
}

/** The corners of one ring. */
function ringPoints(ring: Ring, options: LatheOptions): Point[] {
  const points: Point[] = [];
  for (let j = 0; j < options.sides; j++) {
    const angle = options.phase + (j / options.sides) * Math.PI * 2;
    const k = 1 + (options.random() - 0.5) * 2 * options.jitter;
    const lift = (options.random() - 0.5) * 2 * options.jitter * ring.r * 0.35;
    points.push([Math.cos(angle) * ring.r * k, ring.y + lift, Math.sin(angle) * ring.r * k]);
  }
  return points;
}

/**
 * A faceted solid of revolution through `rings` (bottom to top, or along any profile). Returns
 * the corners of every ring so caps and claws can join them exactly.
 */
function lathe(builder: MeshBuilder, rings: readonly Ring[], options: LatheOptions): Point[][] {
  const all: Point[][] = rings.map((ring) => ringPoints(ring, options));
  for (let i = 1; i < rings.length; i++) {
    const ring = rings[i];
    const below = rings[i - 1];
    const upper = all[i];
    const lower = all[i - 1];
    if (ring === undefined || below === undefined || upper === undefined || lower === undefined) {
      continue;
    }
    const midY = (ring.y + below.y) / 2;
    for (let j = 0; j < options.sides; j++) {
      const next = (j + 1) % options.sides;
      const a = lower[j];
      const b = lower[next];
      const c = upper[next];
      const d = upper[j];
      if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
      const inside: Point =
        ring.face === undefined
          ? [0, midY, 0]
          : [
              (a[0] + c[0]) / 2,
              (a[1] + c[1]) / 2 + (ring.face === 'up' ? -1 : 1),
              (a[2] + c[2]) / 2,
            ];
      const base = ring.panel !== undefined && j % 2 === 0 ? ring.panel : ring.color;
      builder.quad(a, b, c, d, inside, shaded(base, 1 + (options.random() - 0.5) * options.vary));
    }
  }
  return all;
}

/** Closes a ring with a fan to a point on the axis at `y`. */
function cap(
  builder: MeshBuilder,
  ring: readonly Point[],
  y: number,
  face: 'up' | 'down',
  color: Rgba,
  vary: number,
  random: () => number,
): void {
  const centre: Point = [0, y, 0];
  const inside: Point = [0, y + (face === 'up' ? -1 : 1), 0];
  for (let j = 0; j < ring.length; j++) {
    const a = ring[j];
    const b = ring[(j + 1) % ring.length];
    if (a === undefined || b === undefined) continue;
    builder.tri(centre, a, b, inside, shaded(color, 1 + (random() - 0.5) * vary));
  }
}

interface Section {
  /** Distance from the axis, height, and half the thickness of the claw there. */
  readonly r: number;
  readonly y: number;
  readonly half: number;
}

/** A four-sided horn through `sections`, standing at `angle` round the axis, closed at the tip. */
function horn(
  builder: MeshBuilder,
  angle: number,
  sections: readonly Section[],
  color: Rgba,
  tip: Rgba,
  random: () => number,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = (section: Section): Point[] => {
    const x = cos * section.r;
    const z = sin * section.r;
    const h = section.half;
    // A diamond section: an edge, not a flat, faces outward and catches the light.
    return [
      [x + cos * h, section.y, z + sin * h],
      [x - sin * h, section.y, z + cos * h],
      [x - cos * h, section.y, z - sin * h],
      [x + sin * h, section.y, z - cos * h],
    ];
  };
  for (let i = 1; i < sections.length; i++) {
    const from = sections[i - 1];
    const to = sections[i];
    if (from === undefined || to === undefined) continue;
    const lower = corners(from);
    const upper = corners(to);
    const inside: Point = [
      (cos * (from.r + to.r)) / 2,
      (from.y + to.y) / 2,
      (sin * (from.r + to.r)) / 2,
    ];
    const band = i === sections.length - 1 ? tip : color;
    for (let j = 0; j < 4; j++) {
      const next = (j + 1) % 4;
      const a = lower[j];
      const b = lower[next];
      const c = upper[next];
      const d = upper[j];
      if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
      builder.quad(a, b, c, d, inside, shaded(band, 0.9 + random() * 0.25));
    }
  }
}

/** The floating root both sites stand on: broken rock narrowing to a point below. */
function rockRoot(top: number, radius: number, depth: number): Ring[] {
  return [
    { r: radius * 0.1, y: top - depth, color: paint(DEEP) },
    { r: radius * 0.42, y: top - depth * 0.68, color: paint(DEEP, 1.6) },
    { r: radius * 0.8, y: top - depth * 0.3, color: paint(SLATE, 0.8) },
    { r: radius, y: top, color: paint(SLATE, 0.95) },
  ];
}

function buildStand(builder: MeshBuilder, team: TeamId, random: () => number): void {
  builder.anchor = ANCHOR_STAND + team;
  const fold = teamFold(team);
  const sides = fold * 2;
  const phase = Math.PI / sides;
  const glow = light(TEAMS[team].color, 1.5);
  const top = -STAND_DAIS_DEPTH_M;

  const rock = { sides, phase, jitter: 0.2, vary: 0.3, random };
  const root = lathe(builder, rockRoot(top - 1.6, 6.3, 13), rock);
  // The rock's flat top shows as a ledge round the dais.
  const shoulder = root[root.length - 1];
  if (shoulder !== undefined) cap(builder, shoulder, top - 1.6, 'up', paint(MOSS, 0.55), 0.3, random);

  const cut = { sides, phase, jitter: 0, vary: 0.14, random };
  const dais = lathe(
    builder,
    [
      { r: 6.9, y: top - 1.9, color: paint(DEEP) },
      // The band of panels: every other one is lit in the team's colour.
      { r: 7.3, y: top - 0.5, color: paint(SLATE, 0.85), panel: glow },
      { r: 6.8, y: top, color: paint(EDGE), face: 'up' },
    ],
    cut,
  );
  const deck = dais[dais.length - 1];
  if (deck !== undefined) cap(builder, deck, top, 'up', paint(SLATE, 1.05), 0.2, random);

  // The socket the shard hovers over: a low plinth with a lit top.
  const plinth = lathe(
    builder,
    [
      { r: 2.7, y: top, color: paint(SLATE) },
      { r: 2.3, y: top + 1.3, color: paint(SLATE, 0.9) },
      { r: 1.7, y: top + 1.5, color: paint(EDGE), face: 'up' },
    ],
    { ...cut, phase: 0 },
  );
  const socket = plinth[plinth.length - 1];
  if (socket !== undefined) cap(builder, socket, top + 1.5, 'up', glow, 0, random);

  // Claws that lean out and curl back in under the shard. They stop short of the site's own
  // height: a dragon flies through the shard, not through stone.
  for (let i = 0; i < fold; i++) {
    horn(
      builder,
      (i / fold) * Math.PI * 2,
      [
        { r: 5.2, y: top - 0.2, half: 1.15 },
        { r: 6.4, y: top + 2.4, half: 0.9 },
        { r: 5.9, y: top + 4.4, half: 0.55 },
        { r: 4.5, y: top + 5.6, half: 0.08 },
      ],
      paint(SLATE, 0.95),
      paint(EDGE),
      random,
    );
  }
}

function buildBrazier(builder: MeshBuilder, team: TeamId, random: () => number): void {
  builder.anchor = ANCHOR_BRAZIER + team;
  const fold = teamFold(team);
  const sides = fold * 2;
  const phase = Math.PI / sides;
  const glow = light(TEAMS[team].color, 1.5);
  const coals = -BRAZIER_COALS_DEPTH_M;
  const rim = coals + 1.1;

  const rock = { sides, phase, jitter: 0.2, vary: 0.3, random };
  const base = coals - 6.5;
  const root = lathe(builder, rockRoot(base, 7, 14), rock);
  const shoulder = root[root.length - 1];
  if (shoulder !== undefined) cap(builder, shoulder, base, 'up', paint(MOSS, 0.55), 0.3, random);

  const cut = { sides, phase, jitter: 0, vary: 0.14, random };
  const bowl = lathe(
    builder,
    [
      // A waisted stem, then the bowl flaring out to its rim.
      { r: 3.6, y: base, color: paint(DEEP) },
      { r: 2.8, y: base + 2.6, color: paint(SLATE, 0.7) },
      { r: 4.2, y: base + 4.4, color: paint(SLATE, 0.85) },
      // Panels under the rim, lit like the stand's.
      { r: 8.4, y: rim - 0.9, color: paint(SLATE, 0.9), panel: glow },
      { r: 8.9, y: rim, color: paint(SLATE, 1.05) },
      { r: 8.2, y: rim + 0.15, color: paint(EDGE), face: 'up' },
      // Inside, down to the coals.
      { r: 7.2, y: coals, color: paint(DEEP, 1.2), face: 'up' },
    ],
    cut,
  );
  const bed = bowl[bowl.length - 1];
  if (bed !== undefined) cap(builder, bed, coals, 'up', glow, 0, random);

  for (let i = 0; i < fold; i++) {
    horn(
      builder,
      (i / fold) * Math.PI * 2,
      [
        { r: 8.1, y: rim - 0.8, half: 1.2 },
        { r: 9.8, y: rim + 1.6, half: 0.85 },
        { r: 10.4, y: rim + 3.6, half: 0.45 },
        { r: 9.9, y: rim + 5.2, half: 0.06 },
      ],
      paint(SLATE, 0.95),
      paint(EDGE),
      random,
    );
  }
}

/** Both stands and both braziers, as one mesh: about 700 triangles, one draw call. */
export function buildRelayStone(seed = 0x5ad1): RelayMeshData {
  const builder = new MeshBuilder();
  const random = createSeededRandom(seed);
  for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
    buildStand(builder, team, random);
    buildBrazier(builder, team, random);
  }
  return builder.build();
}

/** A double-ended crystal of `fold` sides round its own axis, centred at `at`. */
function crystal(
  builder: MeshBuilder,
  fold: number,
  at: Point,
  radius: number,
  up: number,
  down: number,
  turn: number,
  color: Rgba,
): void {
  const waist: Point[] = [];
  for (let j = 0; j < fold; j++) {
    const angle = turn + (j / fold) * Math.PI * 2;
    waist.push([at[0] + Math.cos(angle) * radius, at[1], at[2] + Math.sin(angle) * radius]);
  }
  const top: Point = [at[0], at[1] + up, at[2]];
  const bottom: Point = [at[0], at[1] - down, at[2]];
  for (let j = 0; j < fold; j++) {
    const a = waist[j];
    const b = waist[(j + 1) % fold];
    if (a === undefined || b === undefined) continue;
    // The facets alternate a little in brightness so the turning crystal glints.
    const facet: Rgba = [color[0], color[1], color[2], j % 2 === 0 ? 1 : 0.62];
    builder.tri(a, b, top, at, facet);
    builder.tri(a, b, bottom, at, [facet[0] * 0.8, facet[1] * 0.8, facet[2] * 0.8, facet[3]]);
  }
}

/**
 * Both sky-shards, each centred on its own anchor: a long crystal (the waist above the middle,
 * so it hangs like a drop) and two splinters beside it. Three-sided for Ember, four for Frost.
 */
export function buildRelayShards(): RelayMeshData {
  const builder = new MeshBuilder();
  for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
    builder.anchor = ANCHOR_SHARD + team;
    const fold = teamFold(team);
    const color = light(TEAMS[team].color, 1.3);
    const up = SHARD_LENGTH_M * 0.38;
    const down = SHARD_LENGTH_M - up;
    // Centred on the anchor: the waist sits above the middle.
    crystal(builder, fold, [0, down - SHARD_LENGTH_M / 2, 0], 1.9, up, down, 0, color);
    crystal(builder, fold, [2.7, -0.4, 0.6], 0.55, 1.1, 1.9, 0.5, color);
    crystal(builder, fold, [-1.7, 1.5, -2.1], 0.42, 0.9, 1.4, 1.1, color);
  }
  return builder.build();
}
