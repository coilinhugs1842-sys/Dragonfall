/**
 * Emberfall Caldera, the second map (T-6.4): a seeded layout of placed hero rocks and props, built
 * the same way as Shattered Spires (./shattered-spires.ts): the sim collides with the assets'
 * convex hulls at these placements, the view draws their GLBs at the same transforms.
 *
 * THE PLACE (docs/GAME_DESIGN.md "Maps", docs/ART_DIRECTION.md "Emberfall Caldera")
 * - A broken volcanic crater at dusk. No ground: basalt rises out of a lava-lit ash sea (y = 0).
 * - Rim: a ring of crater wall, six slabs per half with two of them breached to a low saddle. It
 *   is the arena's edge, just inside the storm wall, where Shattered Spires has free-standing
 *   spires. Each gate stands in a gap of the rim between two hooked rim teeth.
 * - Centre: the broken cone. Four leaning wall segments around the main vent, a chimney with a
 *   lava throat, the sky-well crystal floating in its updraft. Wide gaps face the team gates,
 *   narrow slits face +-X.
 * - Around the cone an open ring of sky for duels (drifting obsidian, one vent per side).
 * - Right flank of each team: the trench, flown low between the rim wall and a row of basalt
 *   columns, a lava arch across it and a vent at its far end.
 * - Left flank: a staircase of ash islands spiralling up around a tall bundle of columns.
 * - Heat vents (`vents`, `EMBERFALL_VENTS`): columns of rising hot air that give lift, free
 *   speed and stamina (`applyHeatVents`, src/sim/flight.ts, stepped by host and predictor
 *   alike). Each stands over a small chimney, is marked with magenta rings, and has rock within
 *   a few seconds of flight.
 *
 * BALANCE: like Shattered Spires the map is its own image under a HALF TURN about the vertical
 * axis through the centre. Only Ember's half is generated; Frost's is `rotatePlacementHalfTurn`
 * of it, placement by placement, and the vents are twinned the same way. The pieces on the axis
 * (sky-well crystal, main chimney, its two marker rings) are not twinned.
 *
 * Load-time code: allocates freely, runs once per match. Same seed, same map.
 */

import type { TeamId } from '../constants';
import { MAX_TEAM_SIZE, TEAM_EMBER, TEAM_FROST } from '../constants';
import type { MapPodium, MapPropSet, MapSky, MapVent, SpawnGate } from '../manifests';
import type { Vec3 } from '../math-types';
import type { ArenaMap } from './arena-map';
import { mapAssetType, mapAssetTypes, placementPoint, rotatePlacementHalfTurn } from './placements';
import type { MapAssetType, MapPlacement } from './placements';
import { createSeededRandom } from './seeded-random';

// --- Contract --------------------------------------------------------------------------------------

/**
 * The dusk look, every optional `MapSky` field filled in: the view reads them through
 * `skyLookOf` (src/world/sky/sky-look.ts). sRGB hex like `sunColor`.
 */
export type CalderaSky = Required<Omit<MapSky, 'panorama'>>;

export interface EmberfallCalderaMap extends ArenaMap {
  /**
   * Order: the pieces on the axis (not twinned), then Ember's half, then Frost's half in the same
   * order: `placements[centerPlacementCount + i]` and
   * `placements[centerPlacementCount + halfPlacementCount + i]` are half-turn twins.
   */
  readonly placements: readonly MapPlacement[];
  readonly centerPlacementCount: number;
  readonly halfPlacementCount: number;
  /** Indexed by TeamId. */
  readonly duelSpawnGates: readonly SpawnGate[];
  readonly sky: CalderaSky;
  /** The heat vents (`EMBERFALL_VENTS`): the main vent first, then Ember's four, then their twins. */
  readonly vents: readonly MapVent[];
  /** Centre lines of the two trenches (Ember's right flank, then its twin), from mouth to vent. */
  readonly trenches: readonly (readonly Vec3[])[];
}

export const EMBERFALL_CALDERA_DEFAULT_SEED = 0xe3be7fa1;

/** The same arena envelope as Shattered Spires and the greybox: wire quantisation and bot bounds stay valid. */
export const CALDERA_MAP_SIZE = 2000;
export const CALDERA_STORM_RADIUS = 1000;
export const CALDERA_CHUNK_SIZE = 250;
/** Surface of the ash sea (the first map's cloud sea). */
export const CALDERA_ASH_SEA_Y = 0;
export const CALDERA_FLOOR_Y = -4;
export const CALDERA_CEILING_Y = 800;
/** No collision geometry reaches beyond this radius: a lane stays free inside the storm wall. */
export const CALDERA_SOLID_MAX_RADIUS = 965;

/** Team gates: distance from the centre, altitude of the spawn slots (as on the first map). */
export const CALDERA_GATE_DISTANCE = 780;
export const CALDERA_GATE_Y = 300;
/** Duel gates sit closer in, so the Duel storm fractions bite (DECISIONS 34). */
export const CALDERA_DUEL_GATE_DISTANCE = 430;
export const CALDERA_DUEL_GATE_Y = 270;
/** Guaranteed launch lane in front of every spawn slot: this long, nothing solid within this radius. */
export const CALDERA_GATE_CORRIDOR_LENGTH = 350;
export const CALDERA_GATE_CORRIDOR_RADIUS = 30;
export const CALDERA_DUEL_CORRIDOR_LENGTH = 200;
/** Altitude of the sky-well crystal, and the radius of the ring of cone walls around it. */
export const CALDERA_SKY_WELL_Y = 260;
export const CALDERA_CONE_RADIUS = 210;
/** The open ring of sky around the cone: only drifting obsidian and one vent chimney per side. */
export const CALDERA_DUEL_RING_INNER = 270;
export const CALDERA_DUEL_RING_OUTER = 350;
/** Radius the crater walls stand on (their inner faces are about 55 m further in). */
export const CALDERA_RIM_RADIUS = 825;
/** The cover rule: rock within this many seconds of flight at cruise speed (45 m/s) on every route. */
export const CALDERA_COVER_SECONDS = 4;

// --- Heat vents --------------------------------------------------------------------------------------

/** Local Y of the lava throat of `vent-chimney` (tools/blender/map/build_caldera_rocks.py `pool_z`). */
const VENT_THROAT_Y = 56;
const MAIN_CHIMNEY_SCALE = 1.3;
/** The sky-well crystal hangs in the main vent: smaller than on the first map, so the column stays rideable around it. */
const CRYSTAL_SCALE = 1.5;
const MAIN_CHIMNEY_Y = -34;
const VENT_CHIMNEY_SCALE = 1.15;
const VENT_CHIMNEY_Y = -36;

interface VentSeed {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly height: number;
}

/** Ember's four vents (XZ); Frost's are the half-turn twins. */
const HALF_VENTS: readonly VentSeed[] = [
  // in the duelling ring, to the right of Ember's line to the cone
  { id: 'ring', x: 150, z: -260, height: 300 },
  // at the far end of the trench on the right flank
  { id: 'trench', x: 662, z: -105, height: 260 },
  // at the foot of the ash staircase on the left flank
  { id: 'stairs', x: -610, z: -290, height: 310 },
  // just inside the rim, left of the gate: the first climb after launch
  { id: 'home', x: -280, z: -610, height: 280 },
];

function buildVents(): readonly MapVent[] {
  const flankY = VENT_CHIMNEY_Y + VENT_THROAT_Y * VENT_CHIMNEY_SCALE;
  const vents: MapVent[] = [
    {
      id: 'main',
      position: { x: 0, y: MAIN_CHIMNEY_Y + VENT_THROAT_Y * MAIN_CHIMNEY_SCALE, z: 0 },
      radius: 70,
      height: 340,
      lift: 20,
      boost: 6,
    },
  ];
  for (const twin of [false, true]) {
    for (const seed of HALF_VENTS) {
      vents.push({
        id: `${seed.id}-${twin ? 'frost' : 'ember'}`,
        position: { x: twin ? -seed.x : seed.x, y: flankY, z: twin ? -seed.z : seed.z },
        radius: 38,
        height: seed.height,
        lift: 14,
        boost: 10,
      });
    }
  }
  return vents;
}

/**
 * The heat vents of Emberfall Caldera. Authored, so they do not move with the seed. Index 0 is
 * the main vent in the cone; then Ember's four and, in the same order, their half-turn twins.
 */
export const EMBERFALL_VENTS: readonly MapVent[] = buildVents();

/**
 * The results podium stands on one of the caldera's own drifting ash islands. The island's
 * dune is 2 m high in the middle at this scale, so it sits lower and the steps stand in the
 * ash; the turns put the gap between its rim boulders toward the camera (found by eye in
 * `?viewer=cine:podium&map=emberfall-caldera`).
 */
export const CALDERA_PODIUM: MapPodium = {
  island: 'ash-island-small',
  scale: 0.82,
  y: -1.5,
  yaw: 0,
  yawMirrored: 0,
};

// --- Layout tuning (internal) ------------------------------------------------------------------------

/** Rocks that stand in the ash sea are rooted here, below the storm's hard floor limit. */
const ROOT_Y = -58;
/** Walls are rooted a little higher: their feet are only 10 m deep at scale 1. */
const WALL_ROOT_Y = -40;
const SLOT_SPACING = 16;
const SLOT_STAGGER = 10;
const DUEL_SLOT_SPACING = 14;
const DUEL_SLOT_STAGGER = 8;
/** Half-width the generator keeps free along the launch lanes (wider than the guarantee). */
const LANE_HALF_WIDTH = 78;
const LANE_END_Z = -250;
const TRENCH_RADIUS = 695;
const TRENCH_HALF_WIDTH = 46;
/** The row of columns on the inner side of the trench. */
const TRENCH_ROW_RADIUS = 598;
const FILL_PER_HALF = 12;
const FILL_GAP = 30;
/** Share of a type's bounding radius the filler keeps clear (the cylinders are generous). */
const FILL_REACH = 0.9;
/** The generator's own, conservative, estimate of "too far from rock" (bounding cylinders). */
const COVER_DISTANCE = 140;
const COVER_STEP = 60;
const COVER_LEVELS: readonly number[] = [150, 255, 360];
const PROP_SCALE = 1.5;
/** Ash islands carry a dune: this fraction of the island's radius high in the middle. */
const DUNE_LIFT = 0.07;
const DUNE_RIM = 0.84;
const ISLAND_RADIUS: Readonly<Record<string, number>> = { 'ash-island-large': 74, 'ash-island-small': 37 };

interface Disc {
  readonly x: number;
  readonly z: number;
  readonly r: number;
  readonly y0: number;
  readonly y1: number;
  /** Radius the rock really fills, for the cover estimate (bounding cylinders are generous). */
  readonly cover: number;
}

interface PlaceOptions {
  readonly pitch?: number;
  readonly roll?: number;
  readonly team?: TeamId;
  readonly group?: string;
  /** Keep fillers away from it and count it as cover (default true). */
  readonly reserve?: boolean;
}

const DEG = Math.PI / 180;

function slotOffset(slot: number): number {
  return slot - (MAX_TEAM_SIZE - 1) / 2;
}

function createGate(team: TeamId, distance: number, y: number, spacing: number, stagger: number): SpawnGate {
  // Ember stands at -Z and launches toward +Z (identity); Frost is the half-turn twin.
  const sign = team === TEAM_EMBER ? -1 : 1;
  const slots: Vec3[] = [];
  for (let slot = 0; slot < MAX_TEAM_SIZE; slot++) {
    const offset = slotOffset(slot);
    slots.push({
      x: offset === 0 ? 0 : -sign * offset * spacing,
      y,
      z: sign * (distance + Math.abs(offset) * stagger),
    });
  }
  return {
    team,
    position: { x: 0, y, z: sign * distance },
    orientation: team === TEAM_EMBER ? { x: 0, y: 0, z: 0, w: 1 } : { x: 0, y: 1, z: 0, w: 0 },
    slots,
  };
}

/** Horizontal reach of a type around its origin at scale 1. */
function footprint(type: MapAssetType): number {
  return Math.max(
    Math.hypot(type.boundsMin.x, type.boundsMin.z),
    Math.hypot(type.boundsMax.x, type.boundsMax.z),
    Math.hypot(type.boundsMin.x, type.boundsMax.z),
    Math.hypot(type.boundsMax.x, type.boundsMin.z),
  );
}

/** Half-width of a type along its wider horizontal axis at scale 1 (tighter than `footprint`). */
function extent(type: MapAssetType): number {
  return Math.max(-type.boundsMin.x, type.boundsMax.x, -type.boundsMin.z, type.boundsMax.z);
}

function distanceToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / lengthSq, 0), 1) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/** Yaw that turns an asset's local +Z (a wall's inner face, a backdrop's lit side) to the centre. */
function faceCentre(phi: number): number {
  return Math.atan2(-Math.cos(phi), -Math.sin(phi));
}

/** Yaw that turns an asset's local +X (the way a cone wall or a rim tooth leans) to the centre. */
function leanToCentre(phi: number): number {
  return Math.atan2(Math.sin(phi), -Math.cos(phi));
}

/**
 * Camera path of the match-intro flyby, Catmull-Rom through these points (the same contract as
 * the first map's). From the west, so the low sun (+X) is in frame: high outside the rim, over
 * the crater wall, down across the bowl to end in front of the cone's western slit, the sky-well
 * glowing behind it. Drawn for the default seed; the map's test keeps it out of the rock.
 */
const INTRO_SPLINE: readonly Vec3[] = [
  { x: -960, y: 440, z: -150 },
  { x: -820, y: 415, z: -110 },
  { x: -640, y: 375, z: -60 },
  { x: -480, y: 335, z: -35 },
  { x: -385, y: 312, z: -28 },
  { x: -320, y: 302, z: -24 },
];

/** Ember's trench (degrees around the centre, -90 = Ember's gate): mouth, bend, bend, end. */
const TRENCH_ANGLES: readonly number[] = [-62, -47, -32, -18];

const TRENCH_LINE: readonly (readonly [number, number])[] = TRENCH_ANGLES.map(
  (degrees) => [Math.cos(degrees * DEG) * TRENCH_RADIUS, Math.sin(degrees * DEG) * TRENCH_RADIUS] as const,
);

/**
 * Builds Emberfall Caldera. Same seed, same map; the default seed is the layout the baked
 * manifest (public/assets/maps/emberfall-caldera/manifest.json) describes.
 */
export function createEmberfallCaldera(seed: number = EMBERFALL_CALDERA_DEFAULT_SEED): EmberfallCalderaMap {
  const random = createSeededRandom(seed);
  const range = (min: number, max: number): number => min + (max - min) * random();
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

  const center: MapPlacement[] = [];
  const half: MapPlacement[] = [];
  /** Bounding cylinders of everything solid placed, both halves. */
  const reserved: Disc[] = [];

  const reserve = (x: number, z: number, r: number, y0: number, y1: number, cover = r * 0.7): void => {
    reserved.push({ x, z, r, y0, y1, cover });
    reserved.push({ x: -x, z: -z, r, y0, y1, cover });
  };

  const reservePlacement = (placement: MapPlacement): void => {
    const type = mapAssetType(placement.type);
    const s = placement.scale;
    const y0 = placement.position.y + type.boundsMin.y * s;
    const y1 = placement.position.y + type.boundsMax.y * s;
    // Long pieces are three cylinders in a row rather than one huge one.
    const long = placement.type === 'crater-wall' || placement.type === 'crater-breach' ? 'x' : placement.type === 'cone-wall' ? 'z' : null;
    if (long === null) {
      reserve(placement.position.x, placement.position.z, extent(type) * s, y0, y1);
      return;
    }
    for (const offset of [-84, 0, 84]) {
      const at = placementPoint(placement, long === 'x' ? offset : 20, 0, long === 'z' ? offset * 0.85 : -10);
      reserve(at.x, at.z, 76 * s, y0, y1);
    }
  };

  const place = (
    type: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
    options: PlaceOptions = {},
  ): MapPlacement => {
    const placement: MapPlacement = {
      type,
      position: { x, y, z },
      yaw,
      pitch: options.pitch ?? 0,
      roll: options.roll ?? 0,
      scale,
      ...(options.team !== undefined ? { team: options.team } : {}),
      ...(options.group !== undefined ? { group: options.group } : {}),
    };
    half.push(placement);
    if (options.reserve !== false) reservePlacement(placement);
    return placement;
  };

  /** True when a disc touches a lane, a trench or a vent column that must stay free (either team's). */
  const inLane = (x: number, z: number, r: number): boolean => {
    for (const sign of [1, -1]) {
      const px = x * sign;
      const pz = z * sign;
      if (distanceToSegment(px, pz, 0, -860, 0, LANE_END_Z) < LANE_HALF_WIDTH + r) return true;
      for (let i = 0; i + 1 < TRENCH_LINE.length; i++) {
        const a = TRENCH_LINE[i];
        const b = TRENCH_LINE[i + 1];
        if (a === undefined || b === undefined) continue;
        if (distanceToSegment(px, pz, a[0], a[1], b[0], b[1]) < TRENCH_HALF_WIDTH + r) return true;
      }
    }
    for (const vent of EMBERFALL_VENTS) {
      if (Math.hypot(x - vent.position.x, z - vent.position.z) < vent.radius + 12 + r) return true;
    }
    // the intro flyby's line (authored on the west side; a filler's twin must stay off it too)
    for (let i = 0; i + 1 < INTRO_SPLINE.length; i++) {
      const a = INTRO_SPLINE[i];
      const b = INTRO_SPLINE[i + 1];
      if (a === undefined || b === undefined) continue;
      if (distanceToSegment(x, z, a.x, a.z, b.x, b.z) < 45 + r || distanceToSegment(-x, -z, a.x, a.z, b.x, b.z) < 45 + r) return true;
    }
    return false;
  };

  /**
   * True when a cylinder (radius `r`, from `y0` to `y1`) keeps `gap` metres from everything placed.
   * Height counts: obsidian may drift over a column's top or under an island, just not through them.
   */
  const clearOfReserved = (x: number, z: number, r: number, gap: number, y0: number, y1: number): boolean => {
    for (const disc of reserved) {
      if (y0 > disc.y1 + gap || y1 < disc.y0 - gap) continue;
      if (Math.hypot(x - disc.x, z - disc.z) < r + disc.r + gap) return false;
    }
    return true;
  };

  /** Distance from a point to the nearest placed rock, estimated from the cylinders' cover radii. */
  const coverDistance = (x: number, y: number, z: number): number => {
    let nearest = Infinity;
    for (const disc of reserved) {
      const flat = Math.max(Math.hypot(x - disc.x, z - disc.z) - disc.cover, 0);
      const up = y < disc.y0 ? disc.y0 - y : y > disc.y1 ? y - disc.y1 : 0;
      nearest = Math.min(nearest, Math.hypot(flat, up));
    }
    return nearest;
  };

  /** Stands props on an ash island's dune: seeded spots with a little spacing, random headings. */
  const dress = (host: MapPlacement, props: readonly string[], team?: TeamId): void => {
    const hostType = mapAssetType(host.type);
    const top = hostType.top;
    if (top === null) return;
    const islandRadius = ISLAND_RADIUS[host.type] ?? top.radius / 0.7;
    const spots: { x: number; z: number; r: number }[] = [];
    for (const prop of props) {
      const propType = mapAssetType(prop);
      const reach = Math.min(footprint(propType) * PROP_SCALE, top.radius * host.scale * 0.5);
      for (let attempt = 0; attempt < 24; attempt++) {
        const angle = range(0, Math.PI * 2);
        const distance = Math.sqrt(random()) * Math.max(top.radius * host.scale - reach * 0.7, 1);
        const lx = (Math.cos(angle) * distance) / host.scale;
        const lz = (Math.sin(angle) * distance) / host.scale;
        const yaw = range(-Math.PI, Math.PI);
        let free = true;
        for (const spot of spots) {
          if (Math.hypot(lx * host.scale - spot.x, lz * host.scale - spot.z) < reach * 0.6 + spot.r) {
            free = false;
            break;
          }
        }
        if (!free && attempt < 23) continue;
        spots.push({ x: lx * host.scale, z: lz * host.scale, r: reach * 0.6 });
        // the dune under the prop, minus a little so its foot is buried rather than hovering
        const t = Math.min(Math.hypot(lx, lz) / (islandRadius * DUNE_RIM), 1);
        const dune = islandRadius * DUNE_LIFT * (1 - t * t);
        const at = placementPoint(host, lx, top.y + dune * 0.6 - 0.9, lz);
        place(prop, at.x, at.y, at.z, yaw, PROP_SCALE, {
          group: host.group ?? 'stairs',
          reserve: false,
          ...(team !== undefined && propType.hasTint ? { team } : {}),
        });
        break;
      }
    }
  };

  /** A vent's chimney (collides) and its stack of magenta marker rings (no collision). */
  const placeVentMarkers = (vent: MapVent, into: (placement: MapPlacement) => void, levels: readonly number[]): void => {
    levels.forEach((level, i) => {
      into({
        type: 'vent-marker',
        position: { x: vent.position.x, y: vent.position.y + vent.height * level, z: vent.position.z },
        yaw: range(-Math.PI, Math.PI),
        pitch: 0,
        roll: 0,
        // well inside the column, narrowing upward; never so large that the sign outshouts the teams
        scale: Math.min((vent.radius / 10) * (0.62 - i * 0.1), 3.6),
        group: 'vent',
      });
    });
  };

  // --- The broken cone and the main vent --------------------------------------------------------------

  const mainVent = EMBERFALL_VENTS[0];
  if (mainVent === undefined) throw new Error('emberfall caldera: no main vent');
  center.push({
    type: 'crystal-core',
    position: { x: 0, y: CALDERA_SKY_WELL_Y, z: 0 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    scale: CRYSTAL_SCALE,
    group: 'cone',
  });
  center.push({
    type: 'vent-chimney',
    position: { x: 0, y: MAIN_CHIMNEY_Y, z: 0 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    scale: MAIN_CHIMNEY_SCALE,
    group: 'cone',
  });
  // one ring under the sky-well crystal, one over it (clear of the chimney's drifting fragments)
  placeVentMarkers(mainVent, (placement) => center.push({ ...placement, group: 'cone' }), [0.46, 0.86]);
  reserve(0, 0, CALDERA_DUEL_RING_INNER - 20, ROOT_Y, 320, CALDERA_DUEL_RING_INNER - 20);
  // Two segments per half: wide gaps on the team axis (to dive through), slits toward +-X.
  for (const degrees of [-41.5, -138.5]) {
    const phi = degrees * DEG;
    place(
      'cone-wall',
      Math.cos(phi) * CALDERA_CONE_RADIUS,
      WALL_ROOT_Y,
      Math.sin(phi) * CALDERA_CONE_RADIUS,
      leanToCentre(phi) + range(-0.03, 0.03),
      1.25,
      { group: 'cone', reserve: false },
    );
  }
  // Drifting obsidian in the duelling ring: high, low and very high (under and over the Duel
  // launch lane, which runs between them at 270 m) and middle.
  const ringRadius = (CALDERA_DUEL_RING_INNER + CALDERA_DUEL_RING_OUTER) * 0.5;
  for (const [degrees, y] of [
    [-28, 350],
    [-92, 140],
    [-84, 410],
    [-152, 240],
  ] as const) {
    const phi = (degrees + range(-4, 4)) * DEG;
    place('obsidian-shards', Math.cos(phi) * ringRadius, y + range(-10, 10), Math.sin(phi) * ringRadius, range(-Math.PI, Math.PI), range(0.8, 0.95), {
      group: 'ring',
      roll: range(-0.25, 0.25),
    });
  }

  // --- Heat vents: a chimney under each, marker rings up its column -----------------------------------

  for (const seedVent of HALF_VENTS) {
    const vent = EMBERFALL_VENTS.find((v) => v.id === `${seedVent.id}-ember`);
    if (vent === undefined) continue;
    place('vent-chimney', vent.position.x, VENT_CHIMNEY_Y, vent.position.z, range(-Math.PI, Math.PI), VENT_CHIMNEY_SCALE, {
      group: 'vent',
    });
    // the rings start above the chimney's staves and drifting fragments, where the column is free air
    placeVentMarkers(vent, (placement) => half.push(placement), [0.52, 0.7, 0.88]);
  }

  // --- Ember's gate, in a gap of the rim ---------------------------------------------------------------

  const gateScale = 1.3;
  const gate = place('caldera-gate', 0, CALDERA_GATE_Y - 44, -(CALDERA_GATE_DISTANCE + 30), 0, gateScale, {
    team: TEAM_EMBER,
    group: 'gate',
  });
  for (const side of [-1, 1]) {
    const corner = placementPoint(gate, side * 20, 0.7, 14);
    place('banner-tall', corner.x, corner.y - 0.3, corner.z, side > 0 ? 0 : Math.PI, PROP_SCALE, {
      team: TEAM_EMBER,
      group: 'gate',
      reserve: false,
    });
    const hang = placementPoint(gate, side * 26, -9, -6);
    place('chain', hang.x, hang.y, hang.z, range(-Math.PI, Math.PI), 1.6, { group: 'gate', reserve: false });
    // Rim teeth as gateposts: they hook forward, along the launch lane, never over it.
    place('rim-tooth', side * 190, ROOT_Y, -775 + side * 8, -Math.PI / 2 + range(-0.12, 0.12), side > 0 ? 1.25 : 1.15, {
      group: 'gate',
    });
  }

  // --- Duel perch -----------------------------------------------------------------------------------

  const perch = place('ash-island-small', 0, CALDERA_DUEL_GATE_Y - 46, -(CALDERA_DUEL_GATE_DISTANCE + 22), 0.4, 1.3, {
    group: 'duel',
  });
  for (const side of [-1, 1]) {
    place('banner-tall', side * 17, perch.position.y - 0.5, perch.position.z - 18, side > 0 ? 0 : Math.PI, PROP_SCALE, {
      team: TEAM_EMBER,
      group: 'duel',
      reserve: false,
    });
    // behind the slots and short: the launch lane keeps its 30 m of free air
    place('basalt-pylon', side * 27, perch.position.y - 0.8, perch.position.z - 12, range(-Math.PI, Math.PI), 1.2, {
      group: 'duel',
      reserve: false,
    });
  }
  place('obsidian-cluster', 4, perch.position.y + 1.2, perch.position.z - 24, 0.3, PROP_SCALE, { group: 'duel', reserve: false });

  // --- Rim: the crater wall ---------------------------------------------------------------------------

  const rim: readonly (readonly [number, string])[] = [
    [-13, 'crater-wall'],
    [-39, 'crater-breach'],
    [-65, 'crater-wall'],
    // the gate stands in the gap at -90
    [-115, 'crater-wall'],
    [-141, 'crater-breach'],
    [-167, 'crater-wall'],
  ];
  for (const [degrees, type] of rim) {
    const phi = (degrees + range(-1.2, 1.2)) * DEG;
    const wallType = mapAssetType(type);
    const scale = range(1.36, 1.44);
    const halfLength = Math.max(-wallType.boundsMin.x, wallType.boundsMax.x) * scale;
    const outer = -wallType.boundsMin.z * scale;
    // the far corners of the slab stay inside the solid limit
    const radius = Math.min(
      CALDERA_RIM_RADIUS,
      Math.sqrt((CALDERA_SOLID_MAX_RADIUS - 8) ** 2 - halfLength ** 2) - outer,
    );
    place(type, Math.cos(phi) * radius, WALL_ROOT_Y, Math.sin(phi) * radius, faceCentre(phi) + range(-0.04, 0.04), scale, {
      group: 'rim',
    });
  }

  // --- The trench on the right flank: rim wall on one side, a row of columns on the other ---------------

  const rowAngles = [-62, -51, -40, -29, -18];
  rowAngles.forEach((degrees, i) => {
    const phi = (degrees + range(-1, 1)) * DEG;
    const tall = i % 2 === 1;
    place(
      tall ? 'basalt-tall' : 'basalt-columns',
      Math.cos(phi) * TRENCH_ROW_RADIUS + range(-5, 5),
      ROOT_Y,
      Math.sin(phi) * TRENCH_ROW_RADIUS + range(-5, 5),
      range(-Math.PI, Math.PI),
      tall ? range(1.1, 1.2) : range(1.25, 1.35),
      { group: 'trench' },
    );
  });
  {
    // a lava arch spans the trench at its middle; its flight axis (local +Z) follows the trench
    const phi = -40 * DEG;
    place('lava-arch', Math.cos(phi) * (TRENCH_RADIUS - 4), 62, Math.sin(phi) * (TRENCH_RADIUS - 4), Math.atan2(-Math.sin(phi), Math.cos(phi)), 1.4, {
      group: 'trench',
    });
  }

  // --- The ash staircase on the left flank --------------------------------------------------------------

  const stairsX = -450;
  const stairsZ = -330;
  place('basalt-tall', stairsX, ROOT_Y, stairsZ, range(-Math.PI, Math.PI), 1.4, { group: 'stairs' });
  const steps: readonly (readonly [number, number, string, number])[] = [
    [215, 130, 'ash-island-small', 1.2],
    [290, 200, 'ash-island-small', 1.1],
    [5, 270, 'ash-island-large', 0.85],
    [80, 340, 'ash-island-small', 1.15],
  ];
  const stairs: MapPlacement[] = [];
  for (const [degrees, y, type, scale] of steps) {
    const phi = degrees * DEG;
    stairs.push(
      place(type, stairsX + Math.cos(phi) * 152, y, stairsZ + Math.sin(phi) * 152, range(-Math.PI, Math.PI), scale, { group: 'stairs' }),
    );
  }
  const [stepLow, stepSecond, stepWide, stepTop] = stairs;
  if (stepLow !== undefined) dress(stepLow, ['basalt-pylon', 'fumarole']);
  if (stepSecond !== undefined) dress(stepSecond, ['obsidian-cluster', 'basalt-pylon']);
  if (stepWide !== undefined) {
    dress(stepWide, ['basalt-pylon', 'basalt-pylon', 'basalt-pylon', 'obsidian-cluster', 'obsidian-cluster', 'fumarole', 'fumarole']);
  }
  if (stepTop !== undefined) dress(stepTop, ['obsidian-cluster', 'basalt-pylon', 'fumarole']);

  // --- Mid bowl: arches to thread, a high island, obsidian fans ------------------------------------------

  const towardCentre = (x: number, z: number): number => Math.atan2(-x, -z);
  place('lava-arch', -190, 190, -450, towardCentre(-190, -450), 1.15, { group: 'arch' });
  place('lava-arch', 352, 232, -262, towardCentre(352, -262) + 0.2, 1.1, { group: 'arch' });
  const highIsle = place('ash-island-large', 228, 350, -562, range(-Math.PI, Math.PI), 0.9, { group: 'isle' });
  dress(highIsle, ['basalt-pylon', 'basalt-pylon', 'obsidian-cluster', 'obsidian-cluster', 'fumarole']);
  place('obsidian-fan', 420, ROOT_Y, -110, range(-Math.PI, Math.PI), 1.25, { group: 'fan' });
  place('obsidian-fan', -660, ROOT_Y, -100, range(-Math.PI, Math.PI), 1.1, { group: 'fan' });

  // --- Seeded filler: drifting obsidian, small ash islands, columns and fans -----------------------------

  const floating = ['obsidian-shards', 'obsidian-shards', 'ash-island-small'];
  const rooted = ['basalt-columns', 'obsidian-fan', 'basalt-tall', 'basalt-columns'];
  let filled = 0;
  for (let attempt = 0; attempt < 2400 && filled < FILL_PER_HALF; attempt++) {
    const floats = random() < 0.6;
    const type = floats ? pick(floating) : pick(rooted);
    const assetType = mapAssetType(type);
    const scale = floats ? range(0.8, 1.3) : range(0.8, 1.15);
    const reach = extent(assetType) * scale * FILL_REACH;
    const radius = range(CALDERA_DUEL_RING_OUTER + 40, 720);
    const phi = range(-Math.PI, 0);
    const x = Math.cos(phi) * radius;
    const z = Math.sin(phi) * radius;
    const y = floats ? range(110, 440) : ROOT_Y;
    if (inLane(x, z, reach)) continue;
    if (!clearOfReserved(x, z, reach, FILL_GAP, y + assetType.boundsMin.y * scale, y + assetType.boundsMax.y * scale)) continue;
    const host = place(type, x, y, z, range(-Math.PI, Math.PI), scale, {
      group: 'fill',
      ...(type === 'obsidian-shards' ? { roll: range(-0.3, 0.3), pitch: range(-0.2, 0.2) } : {}),
    });
    if (type === 'ash-island-small') dress(host, [pick(['basalt-pylon', 'obsidian-cluster', 'fumarole'])]);
    filled++;
  }

  // --- Cover pass: no big hole in the bowl, at any of three flight levels ---------------------------------

  for (const level of COVER_LEVELS) {
    for (let gz = -780; gz <= 0; gz += COVER_STEP) {
      for (let gx = -780; gx <= 780; gx += COVER_STEP) {
        const radius = Math.hypot(gx, gz);
        if (radius > 760 || radius < CALDERA_DUEL_RING_OUTER + 30) continue;
        if (gz === 0 && gx <= 0) continue;
        if (coverDistance(gx, level, gz) < COVER_DISTANCE) continue;
        const scale = range(0.9, 1.25);
        const reach = extent(mapAssetType('obsidian-shards')) * scale;
        if (inLane(gx, gz, reach)) continue;
        place('obsidian-shards', gx, level + range(-25, 25), gz, range(-Math.PI, Math.PI), scale, {
          group: 'fill',
          roll: range(-0.3, 0.3),
        });
      }
    }
  }

  // --- Backdrop: the outer rim and neighbouring cones, far outside the arena (no collision) ----------------

  for (let i = 0; i < 7; i++) {
    const phi = -Math.PI * ((i + range(0.15, 0.85)) / 7);
    const type = i % 3 === 1 ? 'backdrop-cone' : 'backdrop-ridge';
    const scale = range(0.75, 1.05);
    // the whole piece stays outside the storm wall, however wide it is
    const radius = CALDERA_STORM_RADIUS + 90 + footprint(mapAssetType(type)) * scale + range(0, type === 'backdrop-cone' ? 420 : 160);
    place(type, Math.cos(phi) * radius, -120, Math.sin(phi) * radius, faceCentre(phi) + range(-0.25, 0.25), scale, {
      group: 'backdrop',
      reserve: false,
    });
  }

  // --- Assemble --------------------------------------------------------------------------------------

  const placements: MapPlacement[] = [...center, ...half];
  for (const placement of half) placements.push(rotatePlacementHalfTurn(placement));

  const trench: Vec3[] = TRENCH_LINE.map(([x, z]) => ({ x, y: 60, z }));

  return {
    id: 'emberfall-caldera',
    name: 'Emberfall Caldera',
    seed,
    size: CALDERA_MAP_SIZE,
    chunkSize: CALDERA_CHUNK_SIZE,
    chunks: [],
    props: summarizeCalderaPlacements(placements),
    placements,
    centerPlacementCount: center.length,
    halfPlacementCount: half.length,
    sky: CALDERA_SKY,
    spawnGates: [
      createGate(TEAM_EMBER, CALDERA_GATE_DISTANCE, CALDERA_GATE_Y, SLOT_SPACING, SLOT_STAGGER),
      createGate(TEAM_FROST, CALDERA_GATE_DISTANCE, CALDERA_GATE_Y, SLOT_SPACING, SLOT_STAGGER),
    ],
    duelSpawnGates: [
      createGate(TEAM_EMBER, CALDERA_DUEL_GATE_DISTANCE, CALDERA_DUEL_GATE_Y, DUEL_SLOT_SPACING, DUEL_SLOT_STAGGER),
      createGate(TEAM_FROST, CALDERA_DUEL_GATE_DISTANCE, CALDERA_DUEL_GATE_Y, DUEL_SLOT_SPACING, DUEL_SLOT_STAGGER),
    ],
    colliders: {
      stormCenter: { x: 0, y: 0, z: 0 },
      stormRadius: CALDERA_STORM_RADIUS,
      ceilingY: CALDERA_CEILING_Y,
      floorY: CALDERA_FLOOR_Y,
      cloudSeaY: CALDERA_ASH_SEA_Y,
    },
    skyWell: { position: { x: 0, y: CALDERA_SKY_WELL_Y, z: 0 }, ringRadius },
    introSpline: INTRO_SPLINE,
    vents: EMBERFALL_VENTS,
    podium: CALDERA_PODIUM,
    trenches: [trench, trench.map((p) => ({ x: -p.x, y: p.y, z: -p.z }))],
  };
}

/**
 * Dusk (docs/ART_DIRECTION.md "Lighting recipe", Emberfall column): the sun 12 degrees above the
 * horizon, from +X like the first map, so it side-lights both teams alike. The lava is crimson,
 * a hue between the hazard magenta and red and well away from team Ember's orange, and dimmer
 * than either team accent.
 */
export const CALDERA_SKY: CalderaSky = {
  sunDirection: { x: 0.9781476, y: 0.2079117, z: 0 },
  sunColor: 0xff9a5c,
  fogColor: 0x7a4e5a,
  // exp2 fog, the first map's density: the far rim (1 km) still reads, 2 km is gone.
  fogDensity: 0.0012,
  hemisphereSkyColor: 0x6b5a8c,
  hemisphereGroundColor: 0x4a2a20,
  zenithColor: 0x241a44,
  midSkyColor: 0x6a4070,
  horizonColor: 0xf08a4a,
  seaDeepColor: 0x2a1a24,
  seaShadowColor: 0x4a3440,
  seaLitColor: 0x9a7068,
  seaCrestColor: 0xd8b0a0,
  seaGlowColor: 0x8a1c34,
  bounceColor: 0xa02c3c,
  stoneColor: 0x3a3848,
  ashColor: 0xa39c9c,
  edgeColor: 0xb08a90,
  airColor: 0x3c2c54,
  airWarmColor: 0x8e4a48,
  // The rocks' undersides are painted with the lava's crimson: more saturation turns it to plastic.
  stoneSaturation: 1,
  // Lava cracks stay crimson: brighter, they burn out to the pale pink of a "fly here" marker.
  glowGain: 1.3,
  // The caldera's accent is the glow from below, not shafts of sun (ART_DIRECTION, "Accents").
  lightShafts: false,
  ashFall: true,
};

/**
 * One MapPropSet per asset type used, in first-appearance order. `instances` names the baked
 * matrix file of the default layout (tools/blender/map/export_caldera_manifest.mjs writes it).
 * Banners, chains and the sky-well crystal are the first map's GLBs, used from where they are.
 */
export function summarizeCalderaPlacements(placements: readonly MapPlacement[]): readonly MapPropSet[] {
  const counts = new Map<string, number>();
  for (const placement of placements) {
    counts.set(placement.type, (counts.get(placement.type) ?? 0) + 1);
  }
  const types = mapAssetTypes();
  const sets: MapPropSet[] = [];
  for (const [id, count] of counts) {
    const type = types.get(id);
    if (type === undefined) continue;
    sets.push({
      id,
      glb: type.glb,
      instances: `maps/emberfall-caldera/instances/${id}.bin`,
      count,
      kind: type.kind,
      lodTriangles: type.lodTriangles,
      hasTint: type.hasTint,
      radius: type.radius,
    });
  }
  return sets;
}
