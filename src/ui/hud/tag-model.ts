/**
 * Friend-or-foe markers over the dragons: the arithmetic (projection, who gets a marker, how
 * large, how faint). No DOM and no allocation, so it runs every frame and is unit-tested in
 * node (tests/ui/dragon-tags.test.ts). `dragon-tags.ts` applies it to a WorldView; `tags-hud.ts`
 * draws the result.
 *
 * Why the markers exist: team identity in the 3D picture used to rest on a small wing and cape
 * tint, which nearly merges with some dragon bodies for colour-blind players. The marker
 * repeats the team as a SHAPE (triangle = Ember, diamond = Frost) as well as a colour.
 */

/** The numbers behind the rules. Display only: none of this changes what the sim does. */
export const TAG_TUNING = {
  /** Metres above the dragon's centre where the marker stands (clear of the back and wings). */
  liftM: 5,
  /**
   * ...but never more than this many metres per metre of distance from the camera. Five metres
   * over a team mate who flies ten metres ahead is far up the picture, or out of it: close by
   * the marker comes down to the dragon's back.
   */
  liftPerM: 0.22,
  /** A dragon closer than this in front of the lens (or behind it) gets nothing. */
  minDepthM: 2,
  /**
   * How far past the picture's edge (in half-pictures) a marker is still drawn, so it slides
   * out with its dragon instead of vanishing at the border.
   */
  edgeMargin: 0.03,
  /**
   * Full-size marker (and a team mate's name) inside this distance from the camera. Two numbers:
   * a dragon hovering at the boundary must not flicker between the sizes.
   */
  nearInM: 200,
  nearOutM: 240,
  /**
   * "Aimed at": this close to the middle of the picture, in half picture heights (0.2 is a
   * tenth of the picture's height). The second number is for letting go again.
   */
  aimIn: 0.2,
  aimOut: 0.26,
  /** How faint a far team mate's small marker is. */
  farOpacity: 0.85,
  /**
   * Enemies are marked up to here: a little past the longest attack (the 420 m lance), so
   * whoever can hit you is marked, and a speck across the map is not.
   */
  foeRangeM: 450,
  /** The marker fades out over the last metres of that range. */
  foeFadeM: 70,
  /**
   * Without a terrain query nothing can tell whether rock is in the way, so enemies are marked
   * only this close, where a dragon behind rock is rare and the marker gives little away.
   */
  foeBlindRangeM: 150,
  /** The sight line stops this short of the enemy: the rock it perches on does not hide it. */
  sightSlackM: 4,
  /** Sight lines tested per frame (the others keep their last answer). */
  sightChecksPerFrame: 2,
  /** A sight line older than this many frames is not trusted: the enemy waits for a new one. */
  sightStaleFrames: 30,
} as const;

/** Where a point lands in the picture. Reused: `projectPoint` writes into it. */
export interface ScreenPoint {
  /** Picture fractions, 0..1 from the top-left corner. */
  x: number;
  y: number;
  /** Metres in front of the lens along its axis; zero or less is behind the camera. */
  depth: number;
  /** Metres from the camera. */
  distance: number;
  /** Offset from the middle of the picture, squared, in half picture heights. */
  centre2: number;
  /** In front of the lens and inside the picture (plus the margin). */
  visible: boolean;
}

export function createScreenPoint(): ScreenPoint {
  return { x: 0, y: 0, depth: 0, distance: 0, centre2: 0, visible: false };
}

/** Metres over a dragon's centre where its marker stands, for a dragon this far from the camera. */
export function tagLiftM(distanceM: number): number {
  const lift = distanceM * TAG_TUNING.liftPerM;
  return lift < TAG_TUNING.liftM ? (lift > 0 ? lift : 0) : TAG_TUNING.liftM;
}

/**
 * Projects a world point with a camera given as the two matrices three.js keeps for it, both
 * column-major 4x4: `world` is `camera.matrixWorld` (its columns are the camera's right, up and
 * back axes and its position; it must not be scaled) and `projection` is
 * `camera.projectionMatrix`. Writes `out` and returns `out.visible`.
 *
 * The view transform is taken from `world` directly (rotation transposed, position
 * subtracted), so nothing has to invert a matrix and the result is valid as soon as the camera
 * has been placed.
 */
export function projectPoint(
  out: ScreenPoint,
  world: ArrayLike<number>,
  projection: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): boolean {
  const dx = x - (world[12] ?? 0);
  const dy = y - (world[13] ?? 0);
  const dz = z - (world[14] ?? 0);
  // Camera space: +X right, +Y up, the lens looks down -Z.
  const vx = dx * (world[0] ?? 0) + dy * (world[1] ?? 0) + dz * (world[2] ?? 0);
  const vy = dx * (world[4] ?? 0) + dy * (world[5] ?? 0) + dz * (world[6] ?? 0);
  const vz = dx * (world[8] ?? 0) + dy * (world[9] ?? 0) + dz * (world[10] ?? 0);
  out.depth = -vz;
  out.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const w =
    (projection[3] ?? 0) * vx +
    (projection[7] ?? 0) * vy +
    (projection[11] ?? 0) * vz +
    (projection[15] ?? 0);
  if (!(out.depth >= TAG_TUNING.minDepthM) || !(w > 1e-6)) {
    out.visible = false;
    return false;
  }
  const clipX =
    (projection[0] ?? 0) * vx +
    (projection[4] ?? 0) * vy +
    (projection[8] ?? 0) * vz +
    (projection[12] ?? 0);
  const clipY =
    (projection[1] ?? 0) * vx +
    (projection[5] ?? 0) * vy +
    (projection[9] ?? 0) * vz +
    (projection[13] ?? 0);
  const ndcX = clipX / w;
  const ndcY = clipY / w;
  out.x = ndcX * 0.5 + 0.5;
  // The picture's y runs down.
  out.y = 0.5 - ndcY * 0.5;
  // Width over height of the picture, from the lens: both scale factors are 1 / tan(fov / 2).
  const fx = projection[0] ?? 0;
  const aspect = fx !== 0 ? (projection[5] ?? 0) / fx : 1;
  const ax = ndcX * aspect;
  out.centre2 = ax * ax + ndcY * ndcY;
  const limit = 1 + TAG_TUNING.edgeMargin;
  out.visible = ndcX >= -limit && ndcX <= limit && ndcY >= -limit && ndcY <= limit;
  return out.visible;
}

/**
 * Full size (true) or the small far marker (false). `wasLarge` is last frame's answer for the
 * same dragon: the thresholds for staying large are a little wider than for becoming large.
 */
export function tagLarge(distanceM: number, centre2: number, wasLarge: boolean): boolean {
  const near = wasLarge ? TAG_TUNING.nearOutM : TAG_TUNING.nearInM;
  if (distanceM < near) return true;
  const aim = wasLarge ? TAG_TUNING.aimOut : TAG_TUNING.aimIn;
  return centre2 < aim * aim;
}

/**
 * The range an enemy is marked in. `hasTerrain` false: nothing can test the sight line, so the
 * range is short instead (see TAG_TUNING.foeBlindRangeM).
 */
export function foeRangeM(hasTerrain: boolean): number {
  return hasTerrain ? TAG_TUNING.foeRangeM : TAG_TUNING.foeBlindRangeM;
}

/** 0..1 for an enemy's marker: full inside the range, fading out over its last metres, then 0. */
export function foeOpacity(distanceM: number, rangeM: number): number {
  if (!(distanceM < rangeM)) return 0;
  const left = (rangeM - distanceM) / TAG_TUNING.foeFadeM;
  return left < 1 ? left : 1;
}

/** 0..1 for a team mate's marker: they are marked at any distance, a little fainter when far. */
export function mateOpacity(large: boolean): number {
  return large ? 1 : TAG_TUNING.farOpacity;
}

// --- Steps for the page -------------------------------------------------------------------------------

/**
 * Positions are written as strings from a table, one step per 0.05 % of the picture (about a
 * pixel at 1920 wide). 0 % is step TAG_POSITION_PAD: the table starts a little before the
 * left / top edge, for markers sliding out.
 *
 * x and y each have their own table (one table of every pair would be millions of strings, and
 * putting a pair together per frame would make a new string per marker per frame). CSS has two
 * properties that move an element, `translate` and `transform`, and they add up: x goes in the
 * first and y in the second, on the same node.
 */
export const TAG_POSITION_STEPS_PER_UNIT = 2000;
export const TAG_POSITION_PAD = 80;
export const TAG_POSITION_STEPS = TAG_POSITION_STEPS_PER_UNIT + TAG_POSITION_PAD * 2;

/** Table index for a picture fraction (0..1, a little beyond at the edges). */
export function tagPositionStep(fraction: number): number {
  if (!Number.isFinite(fraction)) return TAG_POSITION_PAD;
  const step = Math.round(fraction * TAG_POSITION_STEPS_PER_UNIT) + TAG_POSITION_PAD;
  return step < 0 ? 0 : step > TAG_POSITION_STEPS ? TAG_POSITION_STEPS : step;
}

function buildPositions(unit: 'cqw' | 'cqh'): readonly string[] {
  const table: string[] = [];
  for (let i = 0; i <= TAG_POSITION_STEPS; i++) {
    const percent = ((i - TAG_POSITION_PAD) * 100) / TAG_POSITION_STEPS_PER_UNIT;
    // Container units of the marker layer: no pixel size has to be known or read back.
    const value = `${Number(percent.toFixed(2))}${unit}`;
    table.push(unit === 'cqw' ? value : `translate3d(0,${value},0)`);
  }
  return table;
}

/** A marker's place: `translate` values for x, `transform` values for y. */
export const TAG_X_STRINGS = buildPositions('cqw');
export const TAG_Y_STRINGS = buildPositions('cqh');
