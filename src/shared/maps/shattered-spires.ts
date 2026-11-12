/**
 * Shattered Spires, the real map (T-4.5): a seeded layout of placed hero rocks and props. The
 * sim collides with the assets' convex hulls at these placements, the view draws their GLBs at
 * the same transforms (./placements.ts), so what you see is what you hit.
 *
 * THE PLACE (docs/GAME_DESIGN.md "Maps", docs/ART_DIRECTION.md)
 * - No ground: stone rises out of an endless cloud sea (y = 0) or floats above it.
 * - Centre: the Sundered Crown. Six great claws stand in a ring and lean in over the sky-well, a
 *   floating magenta crystal cradled by two crescents of a broken basin. The gaps between the
 *   claws are wide enough to dive through; the widest two face the team gates.
 * - Around it an open ring of sky for duels (a few drifting shard clusters, nothing else).
 * - Mid ring: floating islands with ruins at different heights, two arches to thread on each
 *   side, spires and broken stumps for cover.
 * - Each side has a canyon on its right flank: two walls of cliff from near the gate toward the
 *   middle, flown low over the clouds, with an arch spanning it.
 * - Rim: tall spires and cliff slabs just inside the storm wall; far silhouettes beyond it.
 * - Gates: Ember's aerie at -Z, Frost's at +Z, each a landing terrace under a ruined arch with a
 *   clear launch lane. Duel uses the smaller perches closer in (`duelSpawnGates`, DECISIONS 34).
 *
 * BALANCE: the map is its own image under a HALF TURN about the vertical axis through the centre
 * (not a mirror image): only Ember's half is generated, Frost's is `rotatePlacementHalfTurn` of
 * it, placement by placement. Both teams therefore see exactly the same map from their gate
 * (the canyon is on everybody's right), and no mirrored meshes are needed. The one piece on the
 * axis itself, the sky-well crystal, is not twinned.
 *
 * Load-time code: allocates freely, runs once per match. Same seed, same map (a seeded integer
 * PRNG plus `Math` trigonometry, like the greybox).
 */

import type { TeamId } from '../constants';
import { MAX_TEAM_SIZE, TEAM_EMBER, TEAM_FROST } from '../constants';
import type { MapPropSet, SpawnGate } from '../manifests';
import type { Vec3 } from '../math-types';
import type { ArenaMap } from './arena-map';
import {
  mapAssetType,
  mapAssetTypes,
  placementPoint,
  rotatePlacementHalfTurn,
} from './placements';
import type { MapAssetType, MapPlacement } from './placements';
import { createSeededRandom } from './seeded-random';

// --- Contract --------------------------------------------------------------------------------------

export interface ShatteredSpiresMap extends ArenaMap {
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
  /** Centre lines of the two canyons (Ember's right flank, then its twin), cloud level to rim. */
  readonly canyons: readonly (readonly Vec3[])[];
}

export const SHATTERED_SPIRES_DEFAULT_SEED = 0x5a1e57;

/** Same arena envelope as the greybox, so wire quantisation and bot bounds stay valid. */
export const SPIRES_MAP_SIZE = 2000;
export const SPIRES_STORM_RADIUS = 1000;
export const SPIRES_CHUNK_SIZE = 250;
export const SPIRES_CLOUD_SEA_Y = 0;
export const SPIRES_FLOOR_Y = -4;
export const SPIRES_CEILING_Y = 700;
/** No collision geometry reaches beyond this radius: a lane stays free inside the storm wall. */
export const SPIRES_SOLID_MAX_RADIUS = 965;

/** Team gates: distance from the centre, altitude of the spawn slots. */
export const SPIRES_GATE_DISTANCE = 780;
export const SPIRES_GATE_Y = 300;
/** Duel gates sit closer in, so the Duel storm fractions bite (DECISIONS 34). */
export const SPIRES_DUEL_GATE_DISTANCE = 430;
export const SPIRES_DUEL_GATE_Y = 270;
/**
 * Guaranteed launch lane in front of every spawn slot (both gate sets): straight ahead for this
 * long, nothing solid within this radius of the line.
 */
export const SPIRES_GATE_CORRIDOR_LENGTH = 350;
export const SPIRES_GATE_CORRIDOR_RADIUS = 30;
export const SPIRES_DUEL_CORRIDOR_LENGTH = 200;
/** Altitude of the sky-well crystal and the radius of the ring of claws around it. */
export const SPIRES_SKY_WELL_Y = 260;
export const SPIRES_CROWN_RADIUS = 200;
/** The open ring of sky around the crown: between these radii only drifting shards. */
export const SPIRES_DUEL_RING_INNER = 262;
export const SPIRES_DUEL_RING_OUTER = 350;

// --- Layout tuning (internal) ------------------------------------------------------------------------

/** Rocks that stand in the cloud sea are rooted here, below the storm's hard floor limit. */
const ROOT_Y = -58;
const SLOT_SPACING = 16;
const SLOT_STAGGER = 10;
const DUEL_SLOT_SPACING = 14;
const DUEL_SLOT_STAGGER = 8;
/** Half-width the generator keeps free along the launch lanes (wider than the guarantee). */
const LANE_HALF_WIDTH = 78;
const LANE_END_Z = -190;
const CANYON_GAP = 92;
const CANYON_HALF_WIDTH = 50;
const FILL_PER_HALF = 15;
const FILL_GAP = 46;
const COVER_DISTANCE = 185;
const COVER_STEP = 60;
const PROP_SCALE = 1.5;

interface Disc {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

interface PlaceOptions {
  readonly pitch?: number;
  readonly roll?: number;
  readonly team?: TeamId;
  readonly group?: string;
  /** Keep fillers away from it (default true). */
  readonly reserve?: boolean;
}

function slotOffset(slot: number): number {
  return slot - (MAX_TEAM_SIZE - 1) / 2;
}

function createGate(
  team: TeamId,
  distance: number,
  y: number,
  spacing: number,
  stagger: number,
): SpawnGate {
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

function distanceToSegment(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / lengthSq, 0), 1) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/**
 * Camera path of the match-intro flyby (src/cinematics/match-intro.ts), Catmull-Rom through
 * these points. It comes in from the west, so the low sun (+X) is in frame: wide and high outside
 * the rim, down through the gap between two rim spires, and on between the claws of the Sundered
 * Crown to end beside the sky-well. Drawn for the default seed; tests/cinematics/match-intro.test.ts
 * keeps it out of the rock.
 */
const INTRO_SPLINE: readonly Vec3[] = [
  { x: -950, y: 440, z: 190 },
  { x: -800, y: 418, z: 60 },
  { x: -570, y: 368, z: -12 },
  { x: -340, y: 322, z: -52 },
  { x: -175, y: 305, z: -47 },
  { x: -88, y: 300, z: -42 },
];

/** Ember's canyon centre line (XZ), from its mouth near the gate toward the middle. */
const CANYON_LINE: readonly (readonly [number, number])[] = [
  [280, -740],
  [430, -590],
  [545, -415],
  [610, -235],
];

/**
 * Builds Shattered Spires. Same seed, same map; the default seed is the layout the baked
 * manifest (public/assets/maps/shattered-spires/manifest.json) describes.
 */
export function createShatteredSpires(
  seed: number = SHATTERED_SPIRES_DEFAULT_SEED,
): ShatteredSpiresMap {
  const random = createSeededRandom(seed);
  const range = (min: number, max: number): number => min + (max - min) * random();
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

  const center: MapPlacement[] = [];
  const half: MapPlacement[] = [];
  /** XZ discs of everything placed, both halves. */
  const reserved: Disc[] = [];

  const reserve = (x: number, z: number, r: number): void => {
    reserved.push({ x, z, r });
    reserved.push({ x: -x, z: -z, r });
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
    if (options.reserve !== false) reserve(x, z, footprint(mapAssetType(type)) * scale);
    return placement;
  };

  /** True when a disc touches a lane that must stay free (either team's, by symmetry). */
  const inLane = (x: number, z: number, r: number): boolean => {
    for (const sign of [1, -1]) {
      const px = x * sign;
      const pz = z * sign;
      if (distanceToSegment(px, pz, 0, -860, 0, LANE_END_Z) < LANE_HALF_WIDTH + r) return true;
      for (let i = 0; i + 1 < CANYON_LINE.length; i++) {
        const a = CANYON_LINE[i];
        const b = CANYON_LINE[i + 1];
        if (a === undefined || b === undefined) continue;
        if (distanceToSegment(px, pz, a[0], a[1], b[0], b[1]) < CANYON_HALF_WIDTH + r) return true;
      }
    }
    return false;
  };

  const clearOfReserved = (x: number, z: number, r: number, gap: number): boolean => {
    for (const disc of reserved) {
      if (Math.hypot(x - disc.x, z - disc.z) < r + disc.r + gap) return false;
    }
    return true;
  };

  /** Stands props on a host's flat top: seeded spots with a little spacing, random headings. */
  const dress = (host: MapPlacement, props: readonly string[], team?: TeamId): void => {
    const hostType = mapAssetType(host.type);
    const top = hostType.top;
    if (top === null) return;
    const spots: Disc[] = [];
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
        const at = placementPoint(host, lx, top.y, lz);
        place(prop, at.x, at.y - 0.5, at.z, yaw, PROP_SCALE, {
          group: host.group ?? 'ruins',
          reserve: false,
          ...(team !== undefined && propType.hasTint ? { team } : {}),
        });
        break;
      }
    }
  };

  // --- The Sundered Crown ---------------------------------------------------------------------------

  center.push({
    type: 'crystal-core',
    position: { x: 0, y: SPIRES_SKY_WELL_Y, z: 0 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    scale: 2.0,
    group: 'crown',
  });
  reserve(0, 0, SPIRES_DUEL_RING_INNER - 20);
  // One crescent of the basin on +X; its twin closes the ring on -X. The gaps face the gates.
  place('crown-base', 0, SPIRES_SKY_WELL_Y - 40, 0, 0, 1.0, { group: 'crown', reserve: false });
  // Claws at 0, -60 and -120 degrees (twins at 180, 120, 60): the gaps on the team axis stay open.
  for (const degrees of [0, -60, -120]) {
    const phi = (degrees * Math.PI) / 180;
    place(
      'crown-claw',
      Math.cos(phi) * SPIRES_CROWN_RADIUS,
      ROOT_Y,
      Math.sin(phi) * SPIRES_CROWN_RADIUS,
      // local +X (the way the claw curves) points at the centre
      Math.PI - phi + range(-0.05, 0.05),
      1.75,
      { group: 'crown', reserve: false },
    );
  }
  // Drifting shards in the duelling ring, low, middle and high.
  const ringRadius = (SPIRES_DUEL_RING_INNER + SPIRES_DUEL_RING_OUTER) * 0.5 - 20;
  for (const [degrees, y] of [
    [-30, 345],
    [-90, 140],
    [-150, 235],
  ] as const) {
    const phi = ((degrees + range(-4, 4)) * Math.PI) / 180;
    place(
      'shard-cluster',
      Math.cos(phi) * ringRadius,
      y + range(-10, 10),
      Math.sin(phi) * ringRadius,
      range(-Math.PI, Math.PI),
      range(0.8, 0.95),
      { group: 'ring', roll: range(-0.25, 0.25) },
    );
  }

  // --- Ember's aerie gate ---------------------------------------------------------------------------

  const gateScale = 1.3;
  const gate = place('aerie-gate', 0, SPIRES_GATE_Y - 44, -(SPIRES_GATE_DISTANCE + 30), 0, gateScale, {
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
    place('chain', hang.x, hang.y, hang.z, range(-Math.PI, Math.PI), 1.6, {
      group: 'gate',
      reserve: false,
    });
  }
  const behind = placementPoint(gate, 0, 0.7, -6);
  place('banner-wide', behind.x, behind.y - 0.3, behind.z, 0, 2.2, {
    team: TEAM_EMBER,
    group: 'gate',
    reserve: false,
  });
  // Two spires flank the launch lane like gateposts; the leaning one leans away from the lane.
  place('spire-twin', 178, ROOT_Y, -672, range(-0.4, 0.4), 1.25, { group: 'gate' });
  place('spire-lean', -186, ROOT_Y, -690, Math.PI + range(-0.3, 0.3), 1.3, { group: 'gate' });

  // --- Duel perch -----------------------------------------------------------------------------------

  const perch = place(
    'island-small',
    0,
    SPIRES_DUEL_GATE_Y - 46,
    -(SPIRES_DUEL_GATE_DISTANCE + 22),
    0.4,
    1.3,
    { group: 'duel' },
  );
  for (const side of [-1, 1]) {
    place('banner-tall', side * 17, perch.position.y - 0.5, perch.position.z - 18, side > 0 ? 0 : Math.PI, PROP_SCALE, {
      team: TEAM_EMBER,
      group: 'duel',
      reserve: false,
    });
    place('brazier', side * 23, perch.position.y - 0.5, perch.position.z + 6, 0, PROP_SCALE, {
      group: 'duel',
      reserve: false,
    });
  }
  place('standing-stone', 4, perch.position.y - 0.5, perch.position.z - 24, 0.3, PROP_SCALE, {
    group: 'duel',
    reserve: false,
  });

  // --- Canyon on the right flank --------------------------------------------------------------------

  const wallScale = 1.35;
  for (let i = 0; i + 1 < CANYON_LINE.length; i++) {
    const a = CANYON_LINE[i];
    const b = CANYON_LINE[i + 1];
    if (a === undefined || b === undefined) continue;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    const ux = dx / length;
    const uz = dz / length;
    const mx = (a[0] + b[0]) * 0.5;
    const mz = (a[1] + b[1]) * 0.5;
    // local +X along the canyon: (cos yaw, -sin yaw) = (ux, uz)
    const yaw = Math.atan2(-uz, ux);
    const offset = CANYON_GAP * 0.5 + 34;
    for (const side of [-1, 1]) {
      place(
        'cliff-wall',
        mx - uz * offset * side + range(-6, 6),
        ROOT_Y,
        mz + ux * offset * side + range(-6, 6),
        yaw + (side > 0 ? 0 : Math.PI) + range(-0.06, 0.06),
        wallScale * range(0.96, 1.06),
        { group: 'canyon' },
      );
    }
  }
  {
    const a = CANYON_LINE[1];
    const b = CANYON_LINE[3];
    const at = CANYON_LINE[2];
    if (a !== undefined && b !== undefined && at !== undefined) {
      // an arch spans the canyon at its bend; its flight axis (local +Z) follows the canyon
      place('arch-great', at[0], 44, at[1], Math.atan2(b[0] - a[0], b[1] - a[1]), 1.45, {
        group: 'canyon',
      });
    }
  }

  // --- Mid ring: arches, islands with ruins, spires and stumps ---------------------------------------

  const towardCentre = (x: number, z: number): number => Math.atan2(-x, -z);
  place('arch-great', -292, 168, -300, towardCentre(-292, -300), 1.15, { group: 'arch' });
  place('arch-broken', 352, 232, -262, towardCentre(352, -262) + 0.2, 1.1, { group: 'arch' });
  // tangent to the rim: a gate on the long way round
  place('arch-great', -655, 110, -335, towardCentre(-655, -335) + Math.PI / 2, 1.3, { group: 'arch' });

  const ruinIsle = place('island-large', -455, 255, -150, range(-Math.PI, Math.PI), 1.05, {
    group: 'ruins',
  });
  dress(ruinIsle, [
    'wall-fragment',
    'column-ruined',
    'column-ruined',
    'column-broken',
    'stairs',
    'standing-stone',
    'standing-stone',
    'crystal-cluster',
    'brazier',
  ]);
  const highIsle = place('island-large', 286, 348, -548, range(-Math.PI, Math.PI), 0.9, {
    group: 'ruins',
  });
  dress(highIsle, ['column-ruined', 'column-ruined', 'column-broken', 'standing-stone', 'crystal-cluster']);
  {
    // a broken bridge reaches out from the high island toward the centre
    const yaw = Math.atan2(548, -286);
    const edge = mapAssetType('island-large').top;
    const reach = (edge?.radius ?? 50) * highIsle.scale + 30;
    place(
      'bridge-span',
      highIsle.position.x + Math.cos(yaw) * reach,
      highIsle.position.y - 1.5,
      highIsle.position.z - Math.sin(yaw) * reach,
      yaw,
      PROP_SCALE,
      { group: 'ruins', reserve: false },
    );
  }
  const lowIsle = place('island-small', -140, 392, -592, range(-Math.PI, Math.PI), 1.1, { group: 'ruins' });
  dress(lowIsle, ['standing-stone', 'crystal-cluster', 'column-broken']);
  const farIsle = place('island-small', -610, 330, -470, range(-Math.PI, Math.PI), 1.2, { group: 'ruins' });
  dress(farIsle, ['column-ruined', 'standing-stone', 'brazier']);
  const nearIsle = place('island-small', 190, 176, -318, range(-Math.PI, Math.PI), 1.0, { group: 'ruins' });
  dress(nearIsle, ['crystal-cluster', 'standing-stone']);

  place('spire-tall', -545, ROOT_Y, -415, range(-Math.PI, Math.PI), 1.55, { group: 'spire' });
  place('spire-lean', -222, ROOT_Y, -478, range(-Math.PI, Math.PI), 1.2, { group: 'spire' });
  const stumpA = place('stump-broken', -368, ROOT_Y, -562, range(-Math.PI, Math.PI), 1.3, { group: 'spire' });
  dress(stumpA, ['standing-stone', 'crystal-cluster']);
  const stumpB = place('stump-broken', 462, ROOT_Y, -118, range(-Math.PI, Math.PI), 1.45, { group: 'spire' });
  dress(stumpB, ['column-broken', 'brazier', 'standing-stone']);

  // --- Rim -------------------------------------------------------------------------------------------

  const rimTypes = ['spire-tall', 'cliff-wall', 'spire-twin', 'spire-lean', 'cliff-wall', 'spire-tall'];
  const rimAngles = [-12, -100, -114, -128, -142, -156, -170];
  for (let i = 0; i < rimAngles.length; i++) {
    const type = rimTypes[i % rimTypes.length] ?? 'spire-tall';
    const phi = (((rimAngles[i] ?? 0) + range(-2.5, 2.5)) * Math.PI) / 180;
    const wall = type === 'cliff-wall';
    const scale = wall ? range(1.35, 1.6) : range(1.6, 2.0);
    const reach = footprint(mapAssetType(type)) * scale;
    const radius = Math.min(wall ? 880 : 850, SPIRES_SOLID_MAX_RADIUS - 12 - (wall ? 60 * scale : reach));
    const x = Math.cos(phi) * radius;
    const z = Math.sin(phi) * radius;
    // walls lie along the rim (local +X tangent), spires turn freely
    const yaw = wall ? Math.atan2(-Math.cos(phi), -Math.sin(phi)) : range(-Math.PI, Math.PI);
    place(type, x, ROOT_Y, z, yaw, scale, { group: 'rim' });
  }

  // --- Seeded filler: drifting shards, small islands, lone spires -------------------------------------

  const floating = ['shard-cluster', 'shard-cluster', 'island-small'];
  const rooted = ['spire-lean', 'spire-twin', 'spire-tall', 'stump-broken'];
  let filled = 0;
  for (let attempt = 0; attempt < 900 && filled < FILL_PER_HALF; attempt++) {
    const floats = random() < 0.6;
    const type = floats ? pick(floating) : pick(rooted);
    const assetType = mapAssetType(type);
    const scale = floats ? range(0.75, 1.3) : range(0.85, 1.3);
    const reach = footprint(assetType) * scale;
    const radius = range(SPIRES_DUEL_RING_OUTER + 40, 830);
    const phi = range(-Math.PI, 0);
    const x = Math.cos(phi) * radius;
    const z = Math.sin(phi) * radius;
    if (radius + reach > SPIRES_SOLID_MAX_RADIUS - 20) continue;
    if (inLane(x, z, reach) || !clearOfReserved(x, z, reach, FILL_GAP)) continue;
    const y = floats ? range(110, 470) : ROOT_Y;
    const host = place(type, x, y, z, range(-Math.PI, Math.PI), scale, {
      group: 'fill',
      ...(type === 'shard-cluster' ? { roll: range(-0.3, 0.3), pitch: range(-0.2, 0.2) } : {}),
    });
    if (type === 'island-small') dress(host, [pick(['standing-stone', 'column-broken', 'crystal-cluster'])]);
    if (type === 'stump-broken') dress(host, ['crystal-cluster']);
    filled++;
  }

  // --- Cover pass: no big hole in the bowl -------------------------------------------------------------

  for (let gz = -840; gz <= 0; gz += COVER_STEP) {
    for (let gx = -840; gx <= 840; gx += COVER_STEP) {
      const radius = Math.hypot(gx, gz);
      if (radius > 820 || radius < SPIRES_DUEL_RING_OUTER + 60) continue;
      if (gz === 0 && gx <= 0) continue;
      let nearest = Infinity;
      for (const disc of reserved) {
        nearest = Math.min(nearest, Math.hypot(gx - disc.x, gz - disc.z) - disc.r);
      }
      if (nearest < COVER_DISTANCE) continue;
      const scale = range(0.9, 1.25);
      const reach = footprint(mapAssetType('shard-cluster')) * scale;
      if (inLane(gx, gz, reach)) continue;
      place('shard-cluster', gx, range(150, 420), gz, range(-Math.PI, Math.PI), scale, {
        group: 'fill',
        roll: range(-0.3, 0.3),
      });
    }
  }

  // --- Backdrop: silhouettes far outside the arena (no collision) --------------------------------------

  for (let i = 0; i < 7; i++) {
    const phi = -Math.PI * ((i + range(0.15, 0.85)) / 7);
    const type = i % 2 === 0 ? 'backdrop-a' : 'backdrop-b';
    const scale = range(0.7, 1.1);
    // the whole piece stays outside the storm wall, however wide it is
    const radius = SPIRES_STORM_RADIUS + 90 + footprint(mapAssetType(type)) * scale + range(0, 260);
    place(type, Math.cos(phi) * radius, -140, Math.sin(phi) * radius, range(-Math.PI, Math.PI), scale, {
      group: 'backdrop',
      reserve: false,
    });
  }

  // --- Assemble --------------------------------------------------------------------------------------

  const placements: MapPlacement[] = [...center, ...half];
  for (const placement of half) placements.push(rotatePlacementHalfTurn(placement));

  const canyon: Vec3[] = CANYON_LINE.map(([x, z]) => ({ x, y: 70, z }));

  return {
    id: 'shattered-spires',
    name: 'Shattered Spires',
    seed,
    size: SPIRES_MAP_SIZE,
    chunkSize: SPIRES_CHUNK_SIZE,
    chunks: [],
    props: summarizePlacements(placements),
    placements,
    centerPlacementCount: center.length,
    halfPlacementCount: half.length,
    sky: {
      // Golden hour, 18 degrees above the horizon, from +X: side light for both teams alike.
      sunDirection: { x: 0.9510565, y: 0.309017, z: 0 },
      sunColor: 0xffd9a0,
      fogColor: 0xe9d9c0,
      // exp2 fog: the far rim (1 km) still reads at about a quarter strength, 2 km is gone.
      fogDensity: 0.0012,
    },
    spawnGates: [
      createGate(TEAM_EMBER, SPIRES_GATE_DISTANCE, SPIRES_GATE_Y, SLOT_SPACING, SLOT_STAGGER),
      createGate(TEAM_FROST, SPIRES_GATE_DISTANCE, SPIRES_GATE_Y, SLOT_SPACING, SLOT_STAGGER),
    ],
    duelSpawnGates: [
      createGate(TEAM_EMBER, SPIRES_DUEL_GATE_DISTANCE, SPIRES_DUEL_GATE_Y, DUEL_SLOT_SPACING, DUEL_SLOT_STAGGER),
      createGate(TEAM_FROST, SPIRES_DUEL_GATE_DISTANCE, SPIRES_DUEL_GATE_Y, DUEL_SLOT_SPACING, DUEL_SLOT_STAGGER),
    ],
    colliders: {
      stormCenter: { x: 0, y: 0, z: 0 },
      stormRadius: SPIRES_STORM_RADIUS,
      ceilingY: SPIRES_CEILING_Y,
      floorY: SPIRES_FLOOR_Y,
      cloudSeaY: SPIRES_CLOUD_SEA_Y,
    },
    skyWell: { position: { x: 0, y: SPIRES_SKY_WELL_Y, z: 0 }, ringRadius: ringRadius },
    introSpline: INTRO_SPLINE,
    canyons: [canyon, canyon.map((p) => ({ x: -p.x, y: p.y, z: -p.z }))],
  };
}

/**
 * One MapPropSet per asset type used, in first-appearance order. `instances` names the baked
 * matrix file of the default layout (tools/blender/map/export_map_manifest.mjs writes it).
 */
export function summarizePlacements(placements: readonly MapPlacement[]): readonly MapPropSet[] {
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
      instances: `maps/shattered-spires/instances/${id}.bin`,
      count,
      kind: type.kind,
      lodTriangles: type.lodTriangles,
      hasTint: type.hasTint,
      radius: type.radius,
    });
  }
  return sets;
}

/** The gate set a mode launches from: Duel uses the perches when the map has them. */
export function spawnGatesForMode(
  map: { readonly spawnGates: readonly SpawnGate[]; readonly duelSpawnGates?: readonly SpawnGate[] },
  mode: string,
): readonly SpawnGate[] {
  return mode === 'duel' && map.duelSpawnGates !== undefined ? map.duelSpawnGates : map.spawnGates;
}
