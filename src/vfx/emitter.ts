/**
 * Emitter recipes and their expansion into particles. An effect is DATA: a recipe says which
 * sprite, how many, how fast, how big and which colour role; `Emitter` turns it into slots of
 * the particle pool. Pure (no three.js) and allocation-free after construction.
 *
 * Counts are authored for the High preset. `spawnCount` scales them by the preset factor and by
 * how full the pool is, so Low draws the same effects with fewer, slightly larger sprites and a
 * crowded fight thins every emitter out before the ring has to overwrite live particles.
 */

import type { QualityPresetId, TeamId } from '../shared';
import { COLOR_GLOW, COLOR_TEAM, PALETTE, paletteOffset } from './palette';
import type { ColorRole } from './palette';
import {
  P_ANCHOR,
  P_ASPECT,
  P_B0,
  P_B1,
  P_BIRTH,
  P_BLEND,
  P_DRAG,
  P_FADE_IN,
  P_FADE_OUT,
  P_G0,
  P_G1,
  P_GRAVITY,
  P_LIFE,
  P_R0,
  P_R1,
  P_ROTATION,
  P_SIZE_END,
  P_SIZE_START,
  P_SPIN,
  P_SPRITE_SEED,
  P_STRETCH,
  P_TURBULENCE,
  P_VX,
  P_VY,
  P_VZ,
  P_X,
  P_Y,
  P_Z,
  packBlend,
} from './particle-pool';
import type { ParticlePool } from './particle-pool';
import { createRng, nextFloat } from './rng';
import type { Rng } from './rng';

/**
 * Where particles start and which way they go:
 * - `cone`: from a ball of `radius` at the origin, within `spread` radians of the direction.
 * - `line`: like `cone`, but starting anywhere along `radius` metres of the direction.
 * - `sphere`: anywhere inside a ball of `radius`, moving straight outward.
 * - `ring`: on a circle of `radius` square to the direction, moving outward in its plane (a
 *   negative speed pulls inward), with `swirl` m/s round the circle.
 */
export type EmitShape = 'cone' | 'line' | 'sphere' | 'ring';

export interface EmitterRecipe {
  /** Atlas sprite (SPRITE_*). */
  readonly sprite: number;
  /** Particles per burst at High, or per second for a stream. */
  readonly count: number;
  /** A burst never spawns fewer than this, at any preset or pressure (0 = may vanish). */
  readonly minCount: number;
  readonly shape: EmitShape;
  /** Metres. */
  readonly radius: number;
  /** Radians (cone, line). */
  readonly spread: number;
  /** m/s. */
  readonly speedMin: number;
  readonly speedMax: number;
  /** m/s round the ring. */
  readonly swirl: number;
  /** Fraction of the source's velocity the particle keeps. */
  readonly inherit: number;
  /** Seconds. */
  readonly lifeMin: number;
  readonly lifeMax: number;
  /** Half-size in metres at birth. */
  readonly sizeMin: number;
  readonly sizeMax: number;
  /** Size at the end of life, as a multiple of the birth size. */
  readonly sizeEnd: number;
  /** Largest turn rate in rad/s (either way). Ignored by stretched sprites. */
  readonly spin: number;
  /** 1/s: velocity decays as exp(-drag * t). */
  readonly drag: number;
  /** m/s² downward; negative rises. */
  readonly gravity: number;
  /** Metres of wobble. */
  readonly turbulence: number;
  /**
   * > 0: the sprite lines up with its velocity and grows longer with speed: half-length =
   * size * (1 + stretch * speed). Use a tiny value to only line it up.
   */
  readonly stretch: number;
  /** Width across the long axis as a fraction of the size. */
  readonly aspect: number;
  /** Stretched sprites: 0 = centred on the particle, 1 = the head sits on it. */
  readonly anchor: number;
  /** 1 = additive glow, 0 = alpha-blended (smoke). Keep the alpha-blended ones few. */
  readonly additive: number;
  /** 0..1: scales the sprite's alpha. Below 1 for soft things (rings, haze). */
  readonly opacity: number;
  readonly colorStart: ColorRole;
  readonly colorEnd: ColorRole;
  /** Brightness multipliers (above 1 = HDR-ish core). */
  readonly intensityStart: number;
  readonly intensityEnd: number;
  /** Fractions of the life: fade in until `fadeIn`, fade out from `fadeOut`. */
  readonly fadeIn: number;
  readonly fadeOut: number;
}

const RECIPE_DEFAULTS: EmitterRecipe = {
  sprite: 0,
  count: 1,
  minCount: 0,
  shape: 'cone',
  radius: 0,
  spread: 0,
  speedMin: 0,
  speedMax: 0,
  swirl: 0,
  inherit: 0,
  lifeMin: 0.5,
  lifeMax: 0.5,
  sizeMin: 1,
  sizeMax: 1,
  sizeEnd: 1,
  spin: 0,
  drag: 0,
  gravity: 0,
  turbulence: 0,
  stretch: 0,
  aspect: 1,
  anchor: 0,
  additive: 1,
  opacity: 1,
  colorStart: COLOR_GLOW,
  colorEnd: COLOR_TEAM,
  intensityStart: 1,
  intensityEnd: 1,
  fadeIn: 0.08,
  fadeOut: 0.45,
};

/**
 * How additive each sprite is unless a recipe says otherwise, by atlas index (dot, wisp, spark,
 * smoke, flake, ring, shard, shade). The sky is bright: a purely additive flame would wash out
 * to white against it, so flames mostly REPLACE what is behind them (their dark, saturated
 * edges give them a silhouette) and only small hot things (sparks, lightning) lean additive.
 */
export const SPRITE_ADDITIVE: readonly number[] = [0.35, 0.15, 0.4, 0, 0.4, 0.3, 0.25, 0];

/** A recipe from the defaults plus overrides (load-time only). */
export function defineRecipe(values: Partial<EmitterRecipe>): EmitterRecipe {
  const sprite = values.sprite ?? RECIPE_DEFAULTS.sprite;
  return {
    ...RECIPE_DEFAULTS,
    additive: SPRITE_ADDITIVE[sprite] ?? RECIPE_DEFAULTS.additive,
    ...values,
  };
}

// --- Preset and pressure scaling -------------------------------------------------------------------

export interface VfxQuality {
  /** Spawn counts are multiplied by this. */
  readonly countScale: number;
  /** Sprites grow a little when there are fewer of them, so the effect keeps its volume. */
  readonly sizeScale: number;
  /** Largest on-screen half-size of a sprite, as a fraction of the screen's half-height. */
  readonly maxScreenSize: number;
  /** Cosmetic status effects (smoke, crackle, shimmer) are skipped beyond this many metres. */
  readonly cosmeticRange: number;
}

export const VFX_QUALITY: Readonly<Record<QualityPresetId, VfxQuality>> = {
  low: { countScale: 0.4, sizeScale: 1.2, maxScreenSize: 0.3, cosmeticRange: 140 },
  medium: { countScale: 0.65, sizeScale: 1.1, maxScreenSize: 0.38, cosmeticRange: 220 },
  high: { countScale: 1, sizeScale: 1, maxScreenSize: 0.5, cosmeticRange: 400 },
};

/** Emitters spawn at full strength up to this pool pressure... */
export const PRESSURE_SOFT_LIMIT = 0.5;
/** ...and at this fraction of it when the pool is full. */
export const PRESSURE_FLOOR = 0.15;

/** 1 while the pool has room, falling linearly to PRESSURE_FLOOR as it fills. */
export function pressureScale(pressure: number): number {
  if (!(pressure > PRESSURE_SOFT_LIMIT)) return 1;
  if (pressure >= 1) return PRESSURE_FLOOR;
  return 1 - ((1 - PRESSURE_FLOOR) * (pressure - PRESSURE_SOFT_LIMIT)) / (1 - PRESSURE_SOFT_LIMIT);
}

/**
 * How many particles to spawn for an authored count. `roll` in [0, 1) rounds the fraction at
 * random, so a stream of 0.3 particles per frame still averages 0.3.
 */
export function spawnCount(
  base: number,
  countScale: number,
  pressure: number,
  minCount: number,
  roll: number,
): number {
  const exact = base * countScale * pressureScale(pressure);
  const n = exact > 0 ? Math.floor(exact + roll) : 0;
  return n < minCount ? minCount : n;
}

// --- Expansion -------------------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;

export class Emitter {
  readonly pool: ParticlePool;
  readonly rng: Rng;
  /** Preset factors (see VFX_QUALITY). */
  countScale = 1;
  sizeScale = 1;
  /** Effect clock in seconds: the birth time of what is spawned now. */
  time = 0;
  /** Particles spawned since construction (tests, perf HUD). */
  spawned = 0;

  private srcVx = 0;
  private srcVy = 0;
  private srcVz = 0;
  private trailDt = 0;

  constructor(pool: ParticlePool, seed = 0x5eed) {
    this.pool = pool;
    this.rng = createRng(seed);
  }

  /**
   * The moving thing the next particles come from. Recipes keep `inherit` of its velocity, and
   * with `trailDt` (the frame time) particles are spread back along the last frame of its path,
   * so a fast source leaves an even trail instead of one clump per frame.
   */
  setSource(vx: number, vy: number, vz: number, trailDt = 0): void {
    this.srcVx = vx;
    this.srcVy = vy;
    this.srcVz = vz;
    this.trailDt = trailDt;
  }

  clearSource(): void {
    this.srcVx = 0;
    this.srcVy = 0;
    this.srcVz = 0;
    this.trailDt = 0;
  }

  /**
   * One burst of a recipe at a point, aimed along (dx, dy, dz) (need not be unit length; zero =
   * straight up). `size` scales the sprites, `count` the number, `radius` replaces the recipe's.
   * Returns how many particles were spawned.
   */
  burst(
    recipe: EmitterRecipe,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    team: TeamId,
    size = 1,
    count = 1,
    radius: number = recipe.radius,
  ): number {
    const n = spawnCount(
      recipe.count * count,
      this.countScale,
      this.pool.pressure,
      recipe.minCount,
      nextFloat(this.rng),
    );
    if (n > 0) this.emit(n, recipe, x, y, z, dx, dy, dz, team, size, radius);
    return n;
  }

  /**
   * A continuous emitter for one frame: `recipe.count * rate` particles per second. Call it
   * every frame the effect is on; the random rounding keeps the long-run rate exact.
   */
  stream(
    recipe: EmitterRecipe,
    dtS: number,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    team: TeamId,
    size = 1,
    rate = 1,
    radius: number = recipe.radius,
  ): number {
    const n = spawnCount(
      recipe.count * rate * dtS,
      this.countScale,
      this.pool.pressure,
      0,
      nextFloat(this.rng),
    );
    if (n > 0) this.emit(n, recipe, x, y, z, dx, dy, dz, team, size, radius);
    return n;
  }

  private emit(
    n: number,
    recipe: EmitterRecipe,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    team: TeamId,
    size: number,
    radius: number,
  ): void {
    const rng = this.rng;
    const pool = this.pool;
    const data = pool.data;
    const time = this.time;

    // Unit direction and two axes square to it.
    let length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length > 1e-6)) {
      dx = 0;
      dy = 1;
      dz = 0;
      length = 1;
    }
    dx /= length;
    dy /= length;
    dz /= length;
    let ax: number;
    let ay: number;
    let az: number;
    if (Math.abs(dy) < 0.9) {
      // d x up
      ax = -dz;
      ay = 0;
      az = dx;
    } else {
      // d x right
      ax = 0;
      ay = dz;
      az = -dy;
    }
    const aLength = Math.sqrt(ax * ax + ay * ay + az * az);
    ax /= aLength;
    ay /= aLength;
    az /= aLength;
    const bx = dy * az - dz * ay;
    const by = dz * ax - dx * az;
    const bz = dx * ay - dy * ax;

    const c0 = paletteOffset(team, recipe.colorStart);
    const c1 = paletteOffset(team, recipe.colorEnd);
    const r0 = (PALETTE[c0] ?? 0) * recipe.intensityStart;
    const g0 = (PALETTE[c0 + 1] ?? 0) * recipe.intensityStart;
    const b0 = (PALETTE[c0 + 2] ?? 0) * recipe.intensityStart;
    const r1 = (PALETTE[c1] ?? 0) * recipe.intensityEnd;
    const g1 = (PALETTE[c1 + 1] ?? 0) * recipe.intensityEnd;
    const b1 = (PALETTE[c1 + 2] ?? 0) * recipe.intensityEnd;
    const blend = packBlend(recipe.opacity, recipe.additive);
    const sizeScale = size * this.sizeScale;
    const cosSpread = Math.cos(recipe.spread);
    const shape = recipe.shape;
    const inherit = recipe.inherit;
    const svx = this.srcVx;
    const svy = this.srcVy;
    const svz = this.srcVz;

    for (let i = 0; i < n; i++) {
      const speed = recipe.speedMin + (recipe.speedMax - recipe.speedMin) * nextFloat(rng);
      const phi = nextFloat(rng) * TWO_PI;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      let px = x;
      let py = y;
      let pz = z;
      let vx: number;
      let vy: number;
      let vz: number;

      if (shape === 'sphere') {
        const nz = nextFloat(rng) * 2 - 1;
        const flat = Math.sqrt(1 - nz * nz);
        const ux = flat * cosPhi;
        const uy = nz;
        const uz = flat * sinPhi;
        const reach = radius * Math.cbrt(nextFloat(rng));
        px += ux * reach;
        py += uy * reach;
        pz += uz * reach;
        vx = ux * speed;
        vy = uy * speed;
        vz = uz * speed;
      } else if (shape === 'ring') {
        const ux = ax * cosPhi + bx * sinPhi;
        const uy = ay * cosPhi + by * sinPhi;
        const uz = az * cosPhi + bz * sinPhi;
        px += ux * radius;
        py += uy * radius;
        pz += uz * radius;
        const swirl = recipe.swirl;
        vx = ux * speed + (bx * cosPhi - ax * sinPhi) * swirl;
        vy = uy * speed + (by * cosPhi - ay * sinPhi) * swirl;
        vz = uz * speed + (bz * cosPhi - az * sinPhi) * swirl;
      } else {
        const cosT = 1 - nextFloat(rng) * (1 - cosSpread);
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const ux = dx * cosT + (ax * cosPhi + bx * sinPhi) * sinT;
        const uy = dy * cosT + (ay * cosPhi + by * sinPhi) * sinT;
        const uz = dz * cosT + (az * cosPhi + bz * sinPhi) * sinT;
        if (shape === 'line') {
          const along = radius * nextFloat(rng);
          px += dx * along;
          py += dy * along;
          pz += dz * along;
        } else if (radius > 0) {
          // A cheap ball: three independent offsets, good enough for a muzzle.
          px += (nextFloat(rng) - 0.5) * radius * 1.4;
          py += (nextFloat(rng) - 0.5) * radius * 1.4;
          pz += (nextFloat(rng) - 0.5) * radius * 1.4;
        }
        vx = ux * speed;
        vy = uy * speed;
        vz = uz * speed;
      }

      let birth = time;
      if (this.trailDt > 0) {
        const back = nextFloat(rng) * this.trailDt;
        px -= svx * back;
        py -= svy * back;
        pz -= svz * back;
        birth -= back;
      }
      vx += svx * inherit;
      vy += svy * inherit;
      vz += svz * inherit;

      const life = recipe.lifeMin + (recipe.lifeMax - recipe.lifeMin) * nextFloat(rng);
      const size0 =
        (recipe.sizeMin + (recipe.sizeMax - recipe.sizeMin) * nextFloat(rng)) * sizeScale;
      const seed = nextFloat(rng);

      const o = pool.allocate(birth, life);
      data[o + P_X] = px;
      data[o + P_Y] = py;
      data[o + P_Z] = pz;
      data[o + P_BIRTH] = birth;
      data[o + P_VX] = vx;
      data[o + P_VY] = vy;
      data[o + P_VZ] = vz;
      data[o + P_LIFE] = life;
      data[o + P_SIZE_START] = size0;
      data[o + P_SIZE_END] = size0 * recipe.sizeEnd;
      data[o + P_ROTATION] = seed * TWO_PI;
      data[o + P_SPIN] = (nextFloat(rng) * 2 - 1) * recipe.spin;
      data[o + P_DRAG] = recipe.drag;
      data[o + P_GRAVITY] = recipe.gravity;
      data[o + P_TURBULENCE] = recipe.turbulence;
      data[o + P_STRETCH] = recipe.stretch;
      data[o + P_R0] = r0;
      data[o + P_G0] = g0;
      data[o + P_B0] = b0;
      data[o + P_BLEND] = blend;
      data[o + P_R1] = r1;
      data[o + P_G1] = g1;
      data[o + P_B1] = b1;
      data[o + P_SPRITE_SEED] = recipe.sprite + seed * 0.998;
      data[o + P_FADE_IN] = recipe.fadeIn;
      data[o + P_FADE_OUT] = recipe.fadeOut;
      data[o + P_ANCHOR] = recipe.anchor;
      data[o + P_ASPECT] = recipe.aspect;
    }
    this.spawned += n;
  }
}
