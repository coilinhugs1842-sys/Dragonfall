/**
 * Where the aerie stands and where its ten perches are. Pure data (no three.js), built once.
 *
 * THE AERIE'S OWN FRAME ("local"): the origin is the middle of the gap between the two
 * terraces at the height of the front terrace floor; +Z points out of the cliff toward the
 * lobby camera, +X to the right of the screen, +Y up. Ember's terrace is on the left (x < 0),
 * Frost's on the right (x > 0), and the two are mirror images of each other in x, so no team
 * has the better seats.
 *
 * IN THE WORLD: the lobby has no map loaded, so the aerie stands at the arena centre, where the
 * cloud puffs keep clear, high enough above the cloud sea to look down on it. It is turned so
 * the low sun stands behind the right-hand terrace, well off the camera's axis: the light rakes
 * across the stone from the side, and the camera looks past the dragons into the warm half of
 * the sky.
 */
import { MAX_TEAM_SIZE, TEAM_EMBER, TEAM_FROST } from '../../shared';
import type { DragonClassId, MutableVec3, TeamId, Vec3 } from '../../shared';

export const AERIE_PERCHES_PER_SIDE = MAX_TEAM_SIZE;
export const AERIE_PERCH_COUNT = AERIE_PERCHES_PER_SIDE * 2;

/**
 * Metres from the cloud sea up to the front terrace floor: low enough that the rock pillars
 * standing in the sea tower over the terraces, high enough that the terraces' undersides hang
 * clear of the clouds.
 */
export const AERIE_ALTITUDE = 60;
/**
 * Angle between the camera's axis and the sun, seen from above (radians, sun to the right). At
 * 0 the dragons would be black against the sun; at a right angle the sky behind them would be
 * the cool side. This keeps the sun's glow in the right of the frame and the stone side-lit.
 */
export const AERIE_SUN_OFFSET = 1.2;

/**
 * Metres from a perch's stone up to the dragon's origin when it sits in the last pose of the
 * `land` clip, per class (measured in the cine viewer: claws on the stone, not in it).
 */
export const PERCH_SEAT_HEIGHT: Readonly<Record<DragonClassId, number>> = {
  talon: 1.25,
  bastion: 1.55,
  tempest: 1.35,
  wraith: 1.25,
  verdant: 1.35,
  aureate: 1.32,
  zephyr: 1.2,
  granite: 1.6,
  mirage: 1.25,
};

/**
 * One terrace's perches in the local frame, for the RIGHT side (Frost); Ember's are the mirror
 * image. Index = `LobbyPlayer.perch`: 0 is the seat nearest the middle of the screen, so a 1v1
 * puts its two riders face to face across the gap. Three stones stand on the front terrace and
 * two on the raised one behind, in the gaps between the front three. A perched dragon with its
 * wings folded is about 5 m across, so 8 m between seats reads as two rows with air between
 * the dragons; a roar opens the wings over the neighbours for a moment, which is the point.
 * `y` is the top of the stone, `yaw` the way the dragon faces (0 = at the camera, negative =
 * turned toward the middle).
 */
const RIGHT_PERCHES: readonly {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}[] = [
  { x: 6.0, y: 3.4, z: 5.0, yaw: -0.18 },
  { x: 14.2, y: 3.9, z: 3.0, yaw: -0.28 },
  { x: 22.4, y: 3.5, z: 0.0, yaw: -0.4 },
  { x: 10.0, y: 8.7, z: -10.0, yaw: -0.22 },
  { x: 18.6, y: 9.4, z: -12.0, yaw: -0.34 },
];

export interface AeriePerch {
  /** `side * AERIE_PERCHES_PER_SIDE + index`: the perch's place in every fixed pool of ten. */
  readonly slot: number;
  readonly side: TeamId;
  /** `LobbyPlayer.perch`. */
  readonly index: number;
  /** World position of the top of the stone, where the claws rest. */
  readonly position: Vec3;
  /** World heading a perched dragon faces (0 = +Z, turning toward +X). */
  readonly yaw: number;
  /** The same in the aerie's own frame. */
  readonly local: Vec3;
  readonly localYaw: number;
}

export interface AerieLayout {
  /** World position of the local origin. */
  readonly origin: Vec3;
  /** World heading of the local +Z axis (the way the aerie faces). */
  readonly yaw: number;
  readonly cosYaw: number;
  readonly sinYaw: number;
  readonly cloudSeaY: number;
  /** Ten perches, index = `perchSlot(side, index)`. */
  readonly perches: readonly AeriePerch[];
}

/** What the layout reads of the map (`ArenaMap` fits). */
export interface AerieMapSource {
  readonly sky: { readonly sunDirection: Vec3 };
  readonly colliders: {
    readonly stormCenter: Vec3;
    readonly cloudSeaY?: number;
    readonly floorY: number;
  };
}

export function perchSlot(side: TeamId, index: number): number {
  return side * AERIE_PERCHES_PER_SIDE + index;
}

/** A local point in world space. Allocation-free. */
export function aerieToWorld(
  layout: AerieLayout,
  x: number,
  y: number,
  z: number,
  out: MutableVec3,
): MutableVec3 {
  out.x = layout.origin.x + x * layout.cosYaw + z * layout.sinYaw;
  out.y = layout.origin.y + y;
  out.z = layout.origin.z - x * layout.sinYaw + z * layout.cosYaw;
  return out;
}

/** Load-time: allocates the layout once. */
export function createAerieLayout(map: AerieMapSource): AerieLayout {
  const cloudSeaY = map.colliders.cloudSeaY ?? map.colliders.floorY;
  const sun = map.sky.sunDirection;
  const flat = Math.hypot(sun.x, sun.z);
  // Heading of the sun seen from above; a sun straight overhead has none, so any facing will do.
  const sunHeading = flat > 1e-6 ? Math.atan2(sun.x, -sun.z) : 0;
  // The camera looks along local -Z; the sun's horizontal direction in the local frame is then
  // (sin offset, -cos offset): to the right of that axis by AERIE_SUN_OFFSET.
  const yaw = AERIE_SUN_OFFSET - sunHeading;
  const base: AerieLayout = {
    origin: {
      x: map.colliders.stormCenter.x,
      y: cloudSeaY + AERIE_ALTITUDE,
      z: map.colliders.stormCenter.z,
    },
    yaw,
    cosYaw: Math.cos(yaw),
    sinYaw: Math.sin(yaw),
    cloudSeaY,
    perches: [],
  };
  const perches: AeriePerch[] = [];
  for (const side of [TEAM_EMBER, TEAM_FROST] as const) {
    // Ember is the mirror image: x and the heading change sign.
    const mirror = side === TEAM_EMBER ? -1 : 1;
    for (let index = 0; index < AERIE_PERCHES_PER_SIDE; index++) {
      const source = RIGHT_PERCHES[index];
      if (source === undefined) continue;
      const local = { x: source.x * mirror, y: source.y, z: source.z };
      const localYaw = source.yaw * mirror;
      perches.push({
        slot: perchSlot(side, index),
        side,
        index,
        position: aerieToWorld(base, local.x, local.y, local.z, { x: 0, y: 0, z: 0 }),
        yaw: localYaw + yaw,
        local,
        localYaw,
      });
    }
  }
  return { ...base, perches };
}
