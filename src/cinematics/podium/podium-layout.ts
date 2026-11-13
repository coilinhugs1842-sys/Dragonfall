/**
 * Where everything of the results show stands, in the podium's own frame, and where that frame
 * sits in the world.
 *
 * THE FRAME ("site"): origin on the middle of the rock's top, +Y up, +Z toward the camera
 * (the dragons on the steps face +Z), +X to the right of the picture. A dragon's own left is
 * +X, so the MVP's right-hand neighbour stands at -X, on the LEFT of the picture.
 *
 * The site is turned so the low sun stands about 65 degrees off the camera axis on the camera's
 * side: it lights the dragons' faces from the side and the camera never looks into it.
 *
 * Pure data and load-time code; no three.js.
 */
import type { ArenaMap, DragonClassId, MutableVec3, TerrainQuery } from '../../shared';

// --- The steps -------------------------------------------------------------------------------------

/** Seat index of each award. The lower the index, the higher the step. */
export const SEAT_MVP = 0;
export const SEAT_TAKEDOWNS = 1;
export const SEAT_DAMAGE = 2;
export const SEAT_COUNT = 3;

/**
 * Where a dragon stands on each step (site frame) and the height of the stone under its feet.
 * A perched dragon is about 5 m across with its wings folded, so 8 m between seats leaves air
 * between neighbours and still keeps all three in the middle of the picture.
 */
export const SEAT_X: readonly number[] = [0, -8, 8];
export const SEAT_Z: readonly number[] = [0, 0.9, 0.9];
export const SEAT_TOP_Y: readonly number[] = [5.6, 4.1, 3.2];
/** The side dragons turn a little toward the middle. */
export const SEAT_HEADING: readonly number[] = [0, 0.16, -0.16];
/**
 * How far the stone of a step reaches behind and in front of the dragon's origin. The claws
 * of a perched dragon are 1 to 2 m behind its origin and its tail hangs lower than its feet
 * from about 2.5 m back, so the step ends there and the tail hangs free behind it.
 */
export const STEP_BACK = 2.3;
export const STEP_FRONT = 2.9;
/** From where an award winner dives onto its step, relative to the step: above and behind. */
export const SEAT_APPROACH_X = 0;
export const SEAT_APPROACH_Y = 72;
export const SEAT_APPROACH_Z = -38;

/**
 * Metres from a dragon's origin down to its claws in the perched pose (the last frame of
 * `land`), per class. The legs have no bones, so the number is a property of the mesh and the
 * clip. `?viewer=cine:podium&measure=1` (src/dev/cine/podium.ts) prints the underside of each
 * perched dragon metre by metre; the values were then checked in side-on close-ups (`&cam=`).
 * Check again when a dragon's mesh or its `land` clip changes.
 */
const PERCH_DROP: Readonly<Record<DragonClassId, number>> = {
  talon: 1.45,
  bastion: 1.55,
  tempest: 1.5,
  wraith: 1.45,
  verdant: 1.48,
  aureate: 1.46,
  zephyr: 1.4,
  granite: 1.6,
  mirage: 1.45,
};

export function perchDrop(classId: DragonClassId): number {
  return PERCH_DROP[classId];
}

/**
 * The MVP roars in the air, this far above where it will stand: the roar rears it up with its
 * tail hanging 5 to 7 m under it, which needs the room (and would go through the stone).
 */
export const ROAR_HOVER_M = 5;

// --- The hover arcs --------------------------------------------------------------------------------

/**
 * Arc 0: the winners, nearer, arriving from above. Arc 1: the others, further back and higher,
 * arriving from below. Both are centred on the far side of the podium as the three-quarter
 * camera sees it (`ARC_BEARING`). In the picture they stand to the left and right of the steps,
 * the far arc as a row above the near one. Both leave `ARC_GAP` open in the middle: the MVP
 * roars in the air over its step, wings spread, and needs clear sky behind it.
 */
export const ARC_WINNERS = 0;
export const ARC_OTHERS = 1;
export const ARC_RADIUS: readonly number[] = [29, 42];
export const ARC_Y: readonly number[] = [11.5, 17.5];
/** Angle between neighbours on an arc, radians (about 10 m and 12 m apart). */
export const ARC_STEP: readonly number[] = [0.34, 0.28];
/** Angle from the middle of an arc to the first dragon on either side. */
export const ARC_GAP: readonly number[] = [0.56, 0.42];
/** Neighbours hang alternately this much above and below the arc's height. */
export const ARC_STAGGER_Y = 1.6;
/** From where a hoverer comes to its place, relative to the place. */
export const ARC_APPROACH_SIDE: readonly number[] = [16, 0];
export const ARC_APPROACH_Y: readonly number[] = [77, -72];
export const ARC_APPROACH_Z: readonly number[] = [-38, -30];
/** How much of its bearing from the podium a hoverer turns back toward the middle. */
export const ARC_TURN_IN = 0.3;

// --- The formation pass ----------------------------------------------------------------------------

/**
 * The pass is one quadratic curve (site frame, for a site with the sun on the right; mirrored
 * in X otherwise): in from high on the far left, over the empty podium, then over the camera.
 */
export const PASS_P0: readonly number[] = [-58, 40, -95];
export const PASS_P1: readonly number[] = [-8, 23, -10];
export const PASS_P2: readonly number[] = [6, 12, 112];
/**
 * The V: each row sits this far out, back and up from the one before. The camera sees the pass
 * almost head-on, where a level V is just a row: it is the step up that draws the V on screen.
 */
export const PASS_ROW_SIDE = 12.5;
export const PASS_ROW_BACK = 9.5;
export const PASS_ROW_UP = 4.5;
/** In a draw both teams fly, the second V behind and above the first. */
export const PASS_GROUP_BACK = 34;
export const PASS_GROUP_UP = 7;

// --- The camera ------------------------------------------------------------------------------------

/** Wide shot of the pass: position at the start and the end of its slow push-in, and the aim. */
export const CAM_WIDE_FROM: readonly number[] = [12, 6.5, 64];
export const CAM_WIDE_TO: readonly number[] = [10.5, 7, 58];
export const CAM_WIDE_AIM: readonly number[] = [-2, 12, 0];
export const CAM_WIDE_FOV = 46;
/** Three-quarter shot of the podium: bearing from the front (toward the sun), distance, height. */
export const CAM_PODIUM_BEARING = 0.42;
export const CAM_PODIUM_DISTANCE = 40;
export const CAM_PODIUM_Y = 9;
export const CAM_PODIUM_AIM: readonly number[] = [0, 7, -1];
export const CAM_PODIUM_FOV = 41;
/**
 * The podium shot aims this many metres to the right of the steps (the camera's right, on any
 * site), which puts them a little left of the middle of the picture: the result screen's score
 * table stands at the right edge.
 */
export const CAM_PODIUM_SHIFT = 3;
/** What the slow drift of the hold adds by the end of the show. */
export const CAM_DRIFT_BEARING = 0.13;
export const CAM_DRIFT_DISTANCE = -4;
export const CAM_DRIFT_Y = 1.2;
/** Where the hover arcs are centred: opposite the podium shot's camera, halfway through its drift. */
export const ARC_BEARING = CAM_PODIUM_BEARING + CAM_DRIFT_BEARING * 0.5;

// --- The site --------------------------------------------------------------------------------------

/** Scale of the `island-small` rock the podium stands on, and how deep it then hangs. */
export const ISLAND_SCALE = 0.82;
export const ISLAND_DEPTH = 80 * ISLAND_SCALE;

/** Angle between the camera axis and the sun, radians. */
const SUN_OFF_AXIS = 1.134;
/** How far up between the cloud sea and the flight ceiling the podium floats by default. */
const SITE_HEIGHT_FRACTION = 0.66;
/** The rock, the parked dragons under it and the cloud sea need this much room below the top. */
const SITE_MIN_ABOVE_SEA = 130;

export interface PodiumSite {
  /** World position of the origin of the site frame. */
  x: number;
  y: number;
  z: number;
  /** World heading of the site's +Z axis (0 = world +Z, turning toward world +X). */
  yaw: number;
  sin: number;
  cos: number;
  /** +1: the sun is on the picture's right; -1: on its left (pass and camera are mirrored). */
  mirror: number;
}

export function createPodiumSite(): PodiumSite {
  return { x: 0, y: 0, z: 0, yaw: 0, sin: 0, cos: 1, mirror: 1 };
}

/** A point of the site frame in world space. Allocation-free. */
export function siteToWorld(out: MutableVec3, site: PodiumSite, x: number, y: number, z: number): MutableVec3 {
  out.x = site.x + x * site.cos + z * site.sin;
  out.y = site.y + y;
  out.z = site.z - x * site.sin + z * site.cos;
  return out;
}

/** A direction of the site frame in world space. Allocation-free. */
export function siteDirection(out: MutableVec3, site: PodiumSite, x: number, y: number, z: number): MutableVec3 {
  out.x = x * site.cos + z * site.sin;
  out.y = y;
  out.z = -x * site.sin + z * site.cos;
  return out;
}

/**
 * Points of the site frame that must be free of rock, with the radius of free air each needs:
 * x (mirrored with the site), y, z, radius. The pass curve with the width of the V, the two
 * camera positions, the columns the dragons dive down and climb up, and the hover arcs.
 */
const SITE_PROBES: readonly number[] = [
  PASS_P0[0] ?? 0, PASS_P0[1] ?? 0, PASS_P0[2] ?? 0, 30,
  -35, 32, -55, 30,
  -18, 25, -5, 30,
  -6, 19, 45, 30,
  PASS_P2[0] ?? 0, PASS_P2[1] ?? 0, PASS_P2[2] ?? 0, 30,
  CAM_WIDE_FROM[0] ?? 0, CAM_WIDE_FROM[1] ?? 0, CAM_WIDE_FROM[2] ?? 0, 8,
  17, 9, 37, 8,
  0, 50, -30, 35,
  0, 88, -55, 35,
  0, -45, -62, 38,
  12, 16, -30, 16,
  -36, 16, -14, 16,
  -24, 18, -32, 16,
  2, 18, -42, 14,
];

/** Height steps and sideways moves tried, in order, when the first place is not clear. */
const SITE_LIFTS: readonly number[] = [0, 50, 100, -50];
const SITE_MOVES: readonly number[] = [0, 0, 160, 0, -160, 0, 0, 160, 0, -160];

function setSite(
  out: PodiumSite,
  x: number,
  y: number,
  z: number,
  sunYaw: number,
  mirror: number,
): void {
  out.x = x;
  out.y = y;
  out.z = z;
  out.mirror = mirror;
  // The camera axis (+Z) stands SUN_OFF_AXIS away from the sun, the sun on the `mirror` side.
  out.yaw = sunYaw - mirror * SUN_OFF_AXIS;
  out.sin = Math.sin(out.yaw);
  out.cos = Math.cos(out.yaw);
}

const probe = { x: 0, y: 0, z: 0 };

function siteIsClear(site: PodiumSite, terrain: TerrainQuery): boolean {
  // The rock itself, as a ball round its middle.
  const rockRadius = ISLAND_DEPTH * 0.6;
  if (terrain.clearance(site.x, site.y - ISLAND_DEPTH * 0.45, site.z, rockRadius) >= 0) return false;
  for (let i = 0; i + 3 < SITE_PROBES.length; i += 4) {
    siteToWorld(
      probe,
      site,
      (SITE_PROBES[i] ?? 0) * site.mirror,
      SITE_PROBES[i + 1] ?? 0,
      SITE_PROBES[i + 2] ?? 0,
    );
    if (terrain.clearance(probe.x, probe.y, probe.z, SITE_PROBES[i + 3] ?? 0) >= 0) return false;
  }
  return true;
}

/**
 * Picks the place of the show: above the middle of the arena (the storm's centre), about two
 * thirds of the way up to the flight ceiling, turned by the sun. With `terrain` the place, the
 * pass, the landing approaches and the camera positions are checked against the rock; when
 * something is in the way it tries higher, then lower, then to the sides, then the mirrored
 * picture, and falls back to the first place when nothing is clear. Without `terrain` (node
 * tests) the first place is taken as it is. Load-time.
 */
export function choosePodiumSite(out: PodiumSite, map: ArenaMap, terrain: TerrainQuery | null): PodiumSite {
  const sun = map.sky.sunDirection;
  const sunLength = Math.hypot(sun.x, sun.z);
  // A sun straight overhead has no side: any bearing will do.
  const sunYaw = sunLength > 1e-3 ? Math.atan2(sun.x, sun.z) : Math.PI * 0.5;
  const colliders = map.colliders;
  const center = colliders.stormCenter;
  const sea = colliders.cloudSeaY;
  const baseY = Math.max(
    sea + (colliders.ceilingY - sea) * SITE_HEIGHT_FRACTION,
    sea + SITE_MIN_ABOVE_SEA,
  );
  setSite(out, center.x, baseY, center.z, sunYaw, 1);
  if (terrain === null) return out;

  for (let mirror = 1; mirror >= -1; mirror -= 2) {
    for (let m = 0; m + 1 < SITE_MOVES.length; m += 2) {
      for (let l = 0; l < SITE_LIFTS.length; l++) {
        const y = baseY + (SITE_LIFTS[l] ?? 0);
        if (y < sea + SITE_MIN_ABOVE_SEA) continue;
        setSite(
          out,
          center.x + (SITE_MOVES[m] ?? 0),
          y,
          center.z + (SITE_MOVES[m + 1] ?? 0),
          sunYaw,
          mirror,
        );
        if (siteIsClear(out, terrain)) return out;
      }
    }
  }
  setSite(out, center.x, baseY, center.z, sunYaw, 1);
  return out;
}
