/**
 * The effect sprite atlas, generated at load (no asset file). Pure numbers: tested in node, and
 * the view wraps the bytes in a DataTexture. Phase 4 can replace the bytes with painted sprites
 * as long as the grid and the conventions below stay.
 *
 * Two channels per texel:
 *   R = shape (alpha / brightness of the sprite)
 *   G = core (the hot centre: the shader pushes it toward white for additive sprites)
 *
 * Conventions:
 * - Directional sprites (wisp, spark, shade) point along +U: the head is on the right. The
 *   particle shader lines +U up with the particle's velocity.
 * - Every sprite fades to exactly 0 at its cell border, so mip levels do not bleed between
 *   cells and a quad never shows its edge.
 */

import { createRng, nextFloat, nextRange } from './rng';

export const ATLAS_COLUMNS = 4;
export const ATLAS_ROWS = 2;
export const ATLAS_CHANNELS = 2;
/** Texels per sprite edge. Soft shapes at a 0.6 render scale need no more. */
export const ATLAS_CELL_SIZE = 64;

/** Index = cell (column + row * ATLAS_COLUMNS). Append only: recipes store these numbers. */
export const SPRITES = [
  'dot',
  'wisp',
  'spark',
  'smoke',
  'flake',
  'ring',
  'shard',
  'shade',
] as const;

export type SpriteName = (typeof SPRITES)[number];

export const SPRITE_DOT = 0;
export const SPRITE_WISP = 1;
export const SPRITE_SPARK = 2;
export const SPRITE_SMOKE = 3;
export const SPRITE_FLAKE = 4;
export const SPRITE_RING = 5;
export const SPRITE_SHARD = 6;
export const SPRITE_SHADE = 7;

export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * UV rectangle of a sprite's cell. The shader does the same maths:
 * `(vec2(mod(s, COLUMNS), floor(s / COLUMNS)) + local) / vec2(COLUMNS, ROWS)`.
 */
export function atlasCellRect(sprite: number, out: AtlasRect): AtlasRect {
  const column = sprite % ATLAS_COLUMNS;
  const row = Math.floor(sprite / ATLAS_COLUMNS);
  out.u0 = column / ATLAS_COLUMNS;
  out.v0 = row / ATLAS_ROWS;
  out.u1 = (column + 1) / ATLAS_COLUMNS;
  out.v1 = (row + 1) / ATLAS_ROWS;
  return out;
}

/** Byte offset of a texel inside the atlas (row 0 is V = 0). */
export function atlasTexelOffset(sprite: number, x: number, y: number, cell: number): number {
  const column = sprite % ATLAS_COLUMNS;
  const row = Math.floor(sprite / ATLAS_COLUMNS);
  return ((row * cell + y) * ATLAS_COLUMNS * cell + column * cell + x) * ATLAS_CHANNELS;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// --- Value noise on a small seeded lattice (load-time only) -------------------------------------

const LATTICE = 16;

function makeLattice(seed: number): Float32Array {
  const rng = createRng(seed);
  const values = new Float32Array(LATTICE * LATTICE);
  for (let i = 0; i < values.length; i++) values[i] = nextFloat(rng);
  return values;
}

function latticeAt(lattice: Float32Array, x: number, y: number): number {
  const xi = ((x % LATTICE) + LATTICE) % LATTICE;
  const yi = ((y % LATTICE) + LATTICE) % LATTICE;
  return lattice[yi * LATTICE + xi] ?? 0;
}

function valueNoise(lattice: Float32Array, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = latticeAt(lattice, x0, y0);
  const b = latticeAt(lattice, x0 + 1, y0);
  const c = latticeAt(lattice, x0, y0 + 1);
  const d = latticeAt(lattice, x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Three octaves, 0..1. */
function fbm(lattice: Float32Array, x: number, y: number): number {
  return (
    valueNoise(lattice, x, y) * 0.55 +
    valueNoise(lattice, x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.3 +
    valueNoise(lattice, x * 4.3 + 9.7, y * 4.3 + 3.1) * 0.15
  );
}

function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq > 0 ? clamp01(((px - ax) * abx + (py - ay) * aby) / lengthSq) : 0;
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/** A jagged lightning figure: one crooked spine and two forks, as line segments in -1..1. */
function makeFlakeSegments(seed: number): Float32Array {
  const rng = createRng(seed);
  const segments: number[] = [];
  const steps = 6;
  let x = -0.72;
  let y = nextRange(rng, -0.12, 0.12);
  for (let i = 0; i < steps; i++) {
    const nx = -0.72 + (1.44 * (i + 1)) / steps;
    const ny = i === steps - 1 ? nextRange(rng, -0.1, 0.1) : nextRange(rng, -0.3, 0.3);
    segments.push(x, y, nx, ny);
    if (i === 1 || i === 3) {
      // A fork leaving the spine at an angle, in two crooked pieces.
      const side = i === 1 ? 1 : -1;
      const mx = nx + nextRange(rng, 0.12, 0.2);
      const my = ny + side * nextRange(rng, 0.2, 0.3);
      const ex = mx + nextRange(rng, 0.08, 0.18);
      const ey = my + side * nextRange(rng, 0.1, 0.22);
      segments.push(
        nx,
        ny,
        mx,
        my,
        mx,
        my,
        Math.min(ex, 0.74),
        Math.max(-0.74, Math.min(ey, 0.74)),
      );
    }
    x = nx;
    y = ny;
  }
  return Float32Array.from(segments);
}

interface Texel {
  shape: number;
  core: number;
}

/**
 * The atlas as bytes: `ATLAS_COLUMNS * cell` wide, `ATLAS_ROWS * cell` high, 2 channels.
 * Deterministic for a seed.
 */
export function generateEffectAtlas(cell: number = ATLAS_CELL_SIZE, seed = 0xdf17): Uint8Array {
  const width = ATLAS_COLUMNS * cell;
  const height = ATLAS_ROWS * cell;
  const data = new Uint8Array(width * height * ATLAS_CHANNELS);
  const noiseA = makeLattice(seed);
  const noiseB = makeLattice(seed ^ 0x51ed);
  const flake = makeFlakeSegments(seed ^ 0x0f1a);
  const texel: Texel = { shape: 0, core: 0 };

  for (let sprite = 0; sprite < SPRITES.length; sprite++) {
    for (let py = 0; py < cell; py++) {
      for (let px = 0; px < cell; px++) {
        // Texel centre in -1..1. The outermost texels sit just inside the border.
        const u = ((px + 0.5) / cell) * 2 - 1;
        const v = ((py + 0.5) / cell) * 2 - 1;
        shade(sprite, u, v, noiseA, noiseB, flake, texel);
        // Hard guarantee of the zero border, whatever the shape function did.
        const edge = Math.max(Math.abs(u), Math.abs(v));
        const border = px === 0 || py === 0 || px === cell - 1 || py === cell - 1;
        const fade = border ? 0 : 1 - smoothstep(0.86, 0.985, edge);
        const o = atlasTexelOffset(sprite, px, py, cell);
        data[o] = Math.round(clamp01(texel.shape * fade) * 255);
        data[o + 1] = Math.round(clamp01(texel.core * fade) * 255);
      }
    }
  }
  return data;
}

function shade(
  sprite: number,
  u: number,
  v: number,
  noiseA: Float32Array,
  noiseB: Float32Array,
  flake: Float32Array,
  out: Texel,
): void {
  const r = Math.sqrt(u * u + v * v);
  switch (sprite) {
    case SPRITE_DOT: {
      const f = clamp01(1 - r / 0.92);
      out.shape = f * f * (3 - 2 * f);
      out.core = Math.pow(f, 5);
      return;
    }
    case SPRITE_WISP: {
      // A flame tongue: round head at +U, a tail that thins and curls toward -U.
      const along = (u + 0.85) / 1.7; // 0 at the tail tip, 1 at the head
      if (along <= 0 || along >= 1) {
        out.shape = 0;
        out.core = 0;
        return;
      }
      const curl = Math.sin(along * 5.5 + 0.6) * 0.16 * (1 - along);
      const lick = (fbm(noiseA, u * 3.2 + 3, v * 3.2) - 0.5) * 0.3 * (1 - along * 0.6);
      const half = 0.56 * Math.pow(along, 0.62) * Math.sqrt(clamp01((1 - along) * 4.5));
      const d = Math.abs(v - curl - lick);
      const body = 1 - smoothstep(half * 0.3, half + 0.02, d);
      out.shape = body * smoothstep(0, 0.22, along);
      out.core = Math.pow(clamp01(1 - d / (half * 0.62 + 0.001)), 2) * smoothstep(0.42, 0.9, along);
      return;
    }
    case SPRITE_SPARK: {
      // A streak: bright head at +U, thinning to nothing at -U. Also the bolt ribbon.
      const along = (u + 0.9) / 1.8;
      if (along <= 0 || along >= 1) {
        out.shape = 0;
        out.core = 0;
        return;
      }
      const taper = Math.pow(along, 1.3) * Math.sqrt(clamp01((1 - along) * 9));
      const half = 0.05 + 0.3 * taper;
      const d = Math.abs(v) / half;
      out.shape = Math.exp(-d * d * 1.9) * Math.pow(along, 0.75);
      out.core = Math.exp(-d * d * 8) * Math.pow(along, 2.4);
      return;
    }
    case SPRITE_SMOKE: {
      // A lumpy puff with a few bold lobes rather than fine grain.
      const lobes = fbm(noiseA, u * 1.9 + 7.3, v * 1.9 + 2.1);
      const edge = 0.5 + 0.42 * lobes;
      const body = 1 - smoothstep(edge * 0.45, edge, r);
      const density = 0.62 + 0.38 * fbm(noiseB, u * 3.3, v * 3.3 + 4);
      out.shape = body * density;
      out.core = body * body * 0.35;
      return;
    }
    case SPRITE_FLAKE: {
      let nearest = 10;
      for (let i = 0; i + 3 < flake.length; i += 4) {
        const d = segmentDistance(
          u,
          v,
          flake[i] ?? 0,
          flake[i + 1] ?? 0,
          flake[i + 2] ?? 0,
          flake[i + 3] ?? 0,
        );
        if (d < nearest) nearest = d;
      }
      const line = Math.exp(-(nearest * nearest) / (0.045 * 0.045));
      const glow = Math.exp(-(nearest * nearest) / (0.11 * 0.11)) * 0.3;
      out.shape = clamp01(line + glow);
      out.core = Math.exp(-(nearest * nearest) / (0.026 * 0.026));
      return;
    }
    case SPRITE_RING: {
      const d = (r - 0.74) / 0.11;
      const band = Math.exp(-d * d);
      // A soft inner haze so an expanding ring reads as a pressure wave, not a wire.
      const haze = r < 0.74 ? 0.16 * smoothstep(0.2, 0.74, r) : 0;
      out.shape = clamp01(band + haze);
      out.core = Math.exp(-d * d * 6) * 0.6;
      return;
    }
    case SPRITE_SHARD: {
      // An angular four-point chip, long along U: the Talon's bolt and flash shape.
      const a = Math.pow(Math.abs(u) / 0.9, 0.62) + Math.pow(Math.abs(v) / 0.52, 0.62);
      const f = clamp01(1 - a);
      out.shape = Math.pow(f, 0.85) * 1.25;
      out.core = Math.pow(f, 2.2) * 1.6;
      return;
    }
    case SPRITE_SHADE: {
      // Tattered smoke: a long body torn into strands along U. The Wraith's breath.
      const along = (u + 0.88) / 1.76;
      if (along <= 0 || along >= 1) {
        out.shape = 0;
        out.core = 0;
        return;
      }
      const half = 0.06 + 0.6 * Math.pow(Math.sin(along * Math.PI), 0.8) * (0.55 + 0.45 * along);
      const wave = (fbm(noiseB, u * 1.6 + 1.7, v * 1.2 + 6.1) - 0.5) * 0.4;
      const d = Math.abs(v - wave) / half;
      const body = 1 - smoothstep(0.35, 1, d);
      // Ridged noise stretched along U tears holes into the body.
      const ridged = 1 - Math.abs(fbm(noiseA, u * 1.4 + 2.2, v * 5.5 + 8.8) * 2 - 1);
      const strands = smoothstep(0.38, 0.86, ridged);
      out.shape =
        body * (0.25 + 0.75 * strands) * smoothstep(0, 0.25, along) * smoothstep(1, 0.82, along);
      out.core = body * body * strands * 0.5 * along;
      return;
    }
    default:
      out.shape = 0;
      out.core = 0;
  }
}
