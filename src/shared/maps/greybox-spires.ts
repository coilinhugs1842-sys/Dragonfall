/**
 * Greybox "Shattered Spires" (T-1.6): a deterministic procedural stand-in for the real map,
 * described purely as primitive solids so the sim and the views build from the same data.
 *
 * LAYOUT (docs/GAME_DESIGN.md, "Maps")
 * - A 2 x 2 km bowl: stone pillars rise out of the cloud sea, low around the centre and tall at
 *   the rim; some lean, some carry moss or sun-lit crowns, a few are joined by bridge slabs.
 * - Centre: the sky-well (a glowing core over a floating basin) inside a ring of floating stones.
 * - Arches to fly through: one on each team's approach, two more on each flank.
 * - Teams: Ember's aerie gate is at -Z, Frost's at +Z, both facing the centre.
 * - MIRROR BALANCE: the map is its own reflection in the plane z = 0 (halfway between the
 *   gates). Only the -Z half is generated; the +Z half is `mirrorSolidZ` of it, solid by solid.
 * - COVER: no point of the play area is more than about 4 s of cruise flight (180 m) from a
 *   solid; a fill pass plants thin "needle" pillars wherever the jittered grid left a hole.
 * - Each spawn slot has a clear launch corridor (GREYBOX_GATE_CORRIDOR_*), and the arch on the
 *   team axis is wide enough for the whole slot fan (GREYBOX_GATE_ARCH_*).
 *
 * Load-time code: allocates freely, runs once per match.
 */

import type { TeamId } from '../constants';
import { MAX_TEAM_SIZE, TEAM_EMBER, TEAM_FROST } from '../constants';
import type { MapColliders, MapManifest, SpawnGate } from '../manifests';
import type { Vec3 } from '../math-types';
import { createSeededRandom } from './seeded-random';
import type { MapSolid, MapSurfaceRole } from './solids';
import { distanceToSolidBound, mirrorSolidZ } from './solids';

// --- Contract --------------------------------------------------------------------------------------

export interface GreyboxColliders extends MapColliders {
  readonly cloudSeaY: number;
}

/** A MapManifest whose geometry is the `solids` list (no asset files). */
export interface GreyboxMap extends MapManifest {
  readonly seed: number;
  /** Order: the self-mirrored centre pieces, then the -Z half, then its mirror in the same order. */
  readonly solids: readonly MapSolid[];
  /** `solids[centerSolidCount + i]` and `solids[centerSolidCount + halfSolidCount + i]` mirror each other. */
  readonly centerSolidCount: number;
  readonly halfSolidCount: number;
  readonly chunkSize: number;
  readonly colliders: GreyboxColliders;
  /** Indexed by TeamId: `[TEAM_EMBER]` at -Z, `[TEAM_FROST]` at +Z. */
  readonly spawnGates: readonly SpawnGate[];
  /** The central objective: where the glowing core floats, and the radius of its stone ring. */
  readonly skyWell: { readonly position: Vec3; readonly ringRadius: number };
}

export const GREYBOX_SPIRES_DEFAULT_SEED = 0x5a1e57;

/** Playable extent and the storm wall (a vertical cylinder around the world origin). */
export const GREYBOX_MAP_SIZE = 2000;
export const GREYBOX_STORM_RADIUS = 1000;
/** No solid reaches beyond this radius, leaving a lane between the rim and the storm wall. */
export const GREYBOX_SOLID_MAX_RADIUS = 960;
export const GREYBOX_CHUNK_SIZE = 250;
/**
 * Cloud-sea surface (drawn), the hazard floor and the flight ceiling. The sea is an opaque
 * plane, so the floor sits just under it: the storm takes hold as soon as a dragon (hit radius
 * up to 3.2 m) is wholly under the surface, not after 40 m of flying blind inside the cloud.
 */
export const GREYBOX_CLOUD_SEA_Y = 0;
export const GREYBOX_FLOOR_Y = -4;
export const GREYBOX_CEILING_Y = 700;

/** Gates sit this far from the centre on the Z axis, at this altitude. */
export const GREYBOX_GATE_DISTANCE = 780;
export const GREYBOX_GATE_Y = 300;
/**
 * From every spawn slot, the segment of this length along the launch direction keeps at least
 * this much clearance from every solid (350 m is about 8 s at cruise speed).
 */
export const GREYBOX_GATE_CORRIDOR_LENGTH = 350;
export const GREYBOX_GATE_CORRIDOR_RADIUS = 30;
/**
 * The team-axis arch stands this far in front of the gate, just past the launch corridor. Every
 * slot's straight launch line passes through its opening with at least this much free air to
 * the stone on either side.
 */
export const GREYBOX_GATE_ARCH_DISTANCE = 450;
export const GREYBOX_GATE_ARCH_CLEARANCE = 16;
/** Design rule "cover within 4 seconds of flight" at the 45 m/s cruise speed. */
export const GREYBOX_COVER_DISTANCE = 180;

// --- Layout tuning (internal) ------------------------------------------------------------------------

/** Pillars are rooted this deep, out of sight under the cloud sea. */
const ROOT_Y = -60;
const SLOT_SPACING = 16;
/** Outer slots sit a little further back: a shallow V behind the leader. */
const SLOT_STAGGER = 10;
/** Pillar bases stay inside this radius (leaning and crowns add up to ~75 m on top). */
const PILLAR_MAX_RADIUS = 870;
/** Nothing rooted closer to the sky-well than this: the centre is the open duelling space. */
const CENTER_CLEAR_RADIUS = 250;
const PILLAR_SPACING = 175;
const PILLAR_JITTER = 30;
/** Free air between the feet of two neighbouring pillars. */
const PILLAR_GAP = 40;
/** Pillar axes keep this far from the mirror plane so a pillar never merges with its twin. */
const MIRROR_GAP = 50;
/** The generator keeps a longer and wider corridor than the exported guarantee. */
const CORRIDOR_BUILD_LENGTH = 480;
const CORRIDOR_BUILD_RADIUS = GREYBOX_GATE_CORRIDOR_RADIUS + 6;
const CORRIDOR_STEP = 10;
/** Fill pass: plant a needle when a sample point is further than this from every anchor. */
const FILL_DISTANCE = 140;
const FILL_STEP = 40;
/** Height of an arch's legs (its opening) as a multiple of the opening's width. */
const ARCH_LEG_HEIGHT_RATIO = 1.15;
const SKY_WELL_Y = 260;
const RING_RADIUS = 150;
const RING_STONES_PER_HALF = 6;
const MAX_BRIDGES_PER_HALF = 7;
const MAX_CROSSINGS_PER_HALF = 2;
const SHARDS_PER_HALF = 8;

interface Disc {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

interface Pillar {
  /** Base centre (at ROOT_Y). */
  readonly x: number;
  readonly z: number;
  /** Unit axis, pointing up the shaft. */
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  /** World Y of the shaft top. */
  readonly topY: number;
  readonly radius: number;
  bridged: boolean;
}

function slotX(slot: number): number {
  return (slot - (MAX_TEAM_SIZE - 1) / 2) * SLOT_SPACING;
}

/** Ember-side (z < 0) slot z; Frost's is the negation. */
function slotZ(slot: number): number {
  return -(GREYBOX_GATE_DISTANCE + Math.abs(slot - (MAX_TEAM_SIZE - 1) / 2) * SLOT_STAGGER);
}

/** True when the solid keeps `radius` clear of both teams' launch corridors over `length`. */
function clearOfCorridors(solid: MapSolid, length: number, radius: number): boolean {
  for (let slot = 0; slot < MAX_TEAM_SIZE; slot++) {
    const x = slotX(slot);
    const z0 = slotZ(slot);
    for (let d = 0; d <= length; d += CORRIDOR_STEP) {
      const z = z0 + d;
      if (distanceToSolidBound(solid, x, GREYBOX_GATE_Y, z) < radius) return false;
      if (distanceToSolidBound(solid, x, GREYBOX_GATE_Y, -z) < radius) return false;
    }
  }
  return true;
}

function createGate(team: TeamId): SpawnGate {
  const sign = team === TEAM_EMBER ? 1 : -1;
  const slots: Vec3[] = [];
  for (let slot = 0; slot < MAX_TEAM_SIZE; slot++) {
    slots.push({ x: slotX(slot), y: GREYBOX_GATE_Y, z: sign * slotZ(slot) });
  }
  return {
    team,
    position: { x: 0, y: GREYBOX_GATE_Y, z: -sign * GREYBOX_GATE_DISTANCE },
    // Dragon forward is +Z: Ember launches toward +Z (identity), Frost is yawed half a turn.
    orientation: team === TEAM_EMBER ? { x: 0, y: 0, z: 0, w: 1 } : { x: 0, y: 1, z: 0, w: 0 },
    slots,
  };
}

/**
 * Builds the greybox Shattered Spires. Same seed, same map (the layout only uses a seeded
 * integer PRNG plus `Math` trigonometry).
 */
export function createGreyboxSpires(seed: number = GREYBOX_SPIRES_DEFAULT_SEED): GreyboxMap {
  const random = createSeededRandom(seed);
  const range = (min: number, max: number): number => min + (max - min) * random();

  const center: MapSolid[] = [];
  const half: MapSolid[] = [];
  /** Structures (gate, arches, shards) that pillars must keep out of (-Z half only). */
  const reserved: Disc[] = [];
  /** XZ points that count as cover, both halves. */
  const anchors: Disc[] = [];
  const pillars: Pillar[] = [];

  const addAnchor = (x: number, z: number, r: number): void => {
    anchors.push({ x, z, r });
    if (z !== 0) anchors.push({ x, z: -z, r });
  };

  // --- Sky-well: floating basin, rim and the glowing core (all on the mirror plane) -----------------

  const upright = { yaw: 0, pitch: 0, roll: 0 } as const;
  center.push(
    {
      kind: 'prism',
      role: 'stoneShadow',
      position: { x: 0, y: SKY_WELL_Y - 107, z: 0 },
      ...upright,
      radiusBottom: 6,
      radiusTop: 30,
      height: 60,
      sides: 8,
    },
    {
      kind: 'prism',
      role: 'stone',
      position: { x: 0, y: SKY_WELL_Y - 64, z: 0 },
      ...upright,
      radiusBottom: 30,
      radiusTop: 64,
      height: 26,
      sides: 8,
    },
    {
      kind: 'prism',
      role: 'litEdge',
      position: { x: 0, y: SKY_WELL_Y - 49, z: 0 },
      ...upright,
      radiusBottom: 67,
      radiusTop: 67,
      height: 4,
      sides: 8,
    },
    {
      kind: 'prism',
      role: 'skyWell',
      position: { x: 0, y: SKY_WELL_Y - 15, z: 0 },
      ...upright,
      radiusBottom: 3,
      radiusTop: 16,
      height: 30,
      sides: 8,
    },
    {
      kind: 'prism',
      role: 'skyWell',
      position: { x: 0, y: SKY_WELL_Y + 15, z: 0 },
      ...upright,
      radiusBottom: 16,
      radiusTop: 3,
      height: 30,
      sides: 8,
    },
  );
  addAnchor(0, 0, 67);

  // --- Ring of floating stones around the well -------------------------------------------------------

  for (let k = 0; k < RING_STONES_PER_HALF; k++) {
    const angle = -((k + 0.5) * Math.PI) / RING_STONES_PER_HALF;
    const x = RING_RADIUS * Math.cos(angle);
    const z = RING_RADIUS * Math.sin(angle);
    const radius = range(10, 16);
    half.push({
      kind: 'prism',
      role: k % 2 === 0 ? 'stone' : 'litEdge',
      position: { x, y: SKY_WELL_Y + (k % 2 === 0 ? -14 : 14) + range(-5, 5), z },
      yaw: range(0, Math.PI * 2),
      pitch: range(-0.2, 0.2),
      roll: range(-0.2, 0.2),
      radiusBottom: radius * 0.45,
      radiusTop: radius,
      height: range(16, 26),
      sides: 5 + Math.floor(random() * 2),
    });
    addAnchor(x, z, radius);
  }

  // --- Aerie gate (Ember side; the mirror turns it into Frost's) -------------------------------------

  const gateZ = -GREYBOX_GATE_DISTANCE;
  const ledgeTopY = GREYBOX_GATE_Y - 42;
  half.push(
    // Launch ledge behind and below the slots, on a floating keel.
    {
      kind: 'box',
      role: 'litEdge',
      position: { x: 0, y: ledgeTopY - 3, z: gateZ - 55 },
      ...upright,
      size: { x: 120, y: 6, z: 50 },
    },
    {
      kind: 'prism',
      role: 'stoneShadow',
      position: { x: 0, y: ledgeTopY - 46, z: gateZ - 55 },
      ...upright,
      radiusBottom: 10,
      radiusTop: 42,
      height: 80,
      sides: 6,
    },
  );
  for (const side of [-1, 1]) {
    const x = side * 84;
    const z = gateZ - 10;
    // Team-coloured horns flanking the launch corridor.
    half.push(
      {
        kind: 'prism',
        role: 'stone',
        position: { x, y: (ROOT_Y + 360) / 2, z },
        ...upright,
        radiusBottom: 12,
        radiusTop: 8,
        height: 360 - ROOT_Y,
        sides: 5,
      },
      {
        kind: 'prism',
        role: 'ember',
        position: { x, y: 368, z },
        ...upright,
        radiusBottom: 10,
        radiusTop: 13,
        height: 16,
        sides: 5,
      },
    );
    reserved.push({ x, z, r: 40 });
    addAnchor(x, z, 12);
  }
  reserved.push({ x: 0, z: gateZ - 55, r: 80 });

  // --- Arches -----------------------------------------------------------------------------------------

  /** A floating ruin arch; the opening spans local X and is flown through along local Z. */
  const addArch = (x: number, y: number, z: number, yaw: number, width: number): void => {
    const legHeight = width * ARCH_LEG_HEIGHT_RATIO;
    const thickness = 14;
    const depth = 16;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const at = (lx: number, ly: number): Vec3 => ({ x: x + lx * cy, y: y + ly, z: z - lx * sy });
    const legX = width / 2 + thickness / 2;
    for (const side of [-1, 1]) {
      half.push(
        {
          kind: 'box',
          role: 'stone',
          position: at(side * legX, legHeight / 2),
          yaw,
          pitch: 0,
          roll: 0,
          size: { x: thickness, y: legHeight, z: depth },
        },
        {
          kind: 'prism',
          role: 'stoneShadow',
          position: at(side * legX, -20),
          yaw,
          pitch: 0,
          roll: 0,
          radiusBottom: thickness * 0.25,
          radiusTop: thickness * 0.9,
          height: 40,
          sides: 5,
        },
        // Corner brace: turns the square opening into an arch.
        {
          kind: 'box',
          role: 'stone',
          position: at(side * (width / 2 - width * 0.1), legHeight - width * 0.1),
          yaw,
          pitch: 0,
          roll: (side * Math.PI) / 4,
          size: { x: thickness * 0.8, y: width * 0.36, z: depth * 0.8 },
        },
      );
    }
    half.push({
      kind: 'box',
      role: 'litEdge',
      position: at(0, legHeight + thickness / 2),
      yaw,
      pitch: 0,
      roll: 0,
      size: { x: width + thickness * 2 + 10, y: thickness, z: depth * 1.15 },
    });
    reserved.push({ x, z, r: width / 2 + thickness + 40 });
    addAnchor(x, z, width / 2 + thickness);
  };

  // On the team axis, just past the launch corridor. The opening spans the whole slot fan (the
  // outer slots would otherwise launch straight into a leg) and is centred on the gate altitude.
  const teamArchWidth = 2 * (slotX(MAX_TEAM_SIZE - 1) + GREYBOX_GATE_ARCH_CLEARANCE);
  addArch(
    0,
    GREYBOX_GATE_Y - (teamArchWidth * ARCH_LEG_HEIGHT_RATIO) / 2,
    gateZ + GREYBOX_GATE_ARCH_DISTANCE,
    0,
    teamArchWidth,
  );
  // One on each flank, turned toward the centre.
  for (const side of [-1, 1]) {
    const radius = range(430, 520);
    const angle = range(0.38, 0.62);
    const x = side * radius * Math.cos(angle);
    const z = -radius * Math.sin(angle);
    // Local Z (the way through) points at the sky-well.
    addArch(x, range(250, 330), z, Math.atan2(x, z), range(52, 64));
  }

  // --- Pillars ----------------------------------------------------------------------------------------

  /** Pillar tops form the bowl: low near the sky-well, tall at the rim. */
  const bowlHeight = (x: number, z: number): number =>
    170 + 350 * Math.pow(Math.min(Math.hypot(x, z) / PILLAR_MAX_RADIUS, 1), 1.3);

  const pillarSiteFree = (x: number, z: number, radius: number): boolean => {
    const r = Math.hypot(x, z);
    if (r > PILLAR_MAX_RADIUS || r < CENTER_CLEAR_RADIUS || z > -MIRROR_GAP) return false;
    for (const disc of reserved) {
      if (Math.hypot(x - disc.x, z - disc.z) < disc.r + radius) return false;
    }
    for (const other of pillars) {
      const spacing = other.radius * 1.35 + PILLAR_GAP + radius;
      if (Math.hypot(x - other.x, z - other.z) < spacing) return false;
    }
    return true;
  };

  /** Adds shaft + optional collar and crown; false (and nothing added) if the site is taken. */
  const addPillar = (
    x: number,
    z: number,
    topY: number,
    radiusBottom: number,
    taper: number,
    sides: number,
    yaw: number,
    lean: number,
    leanDirection: number,
    collar: boolean,
    crownRole: MapSurfaceRole | null,
    crownHeight: number,
  ): boolean => {
    if (!pillarSiteFree(x, z, radiusBottom * 1.35)) return false;
    const pitch = lean * Math.cos(leanDirection);
    const roll = lean * Math.sin(leanDirection);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cx = Math.cos(pitch);
    const sx = Math.sin(pitch);
    const cz = Math.cos(roll);
    const sz = Math.sin(roll);
    // Local +Y in world space (second column of the solid rotation).
    const ax = sy * sx * cz - cy * sz;
    const ay = cx * cz;
    const az = sy * sz + cy * sx * cz;
    const length = (topY - ROOT_Y) / ay;
    const along = (s: number): Vec3 => ({ x: x + ax * s, y: ROOT_Y + ay * s, z: z + az * s });
    const radiusTop = radiusBottom * taper;
    const parts: MapSolid[] = [
      {
        kind: 'prism',
        role: 'stone',
        position: along(length / 2),
        yaw,
        pitch,
        roll,
        radiusBottom,
        radiusTop,
        height: length,
        sides,
      },
    ];
    if (collar) {
      const collarLength = Math.min(length * 0.4, 120);
      parts.push({
        kind: 'prism',
        role: 'stoneShadow',
        position: along(collarLength / 2),
        yaw,
        pitch,
        roll,
        radiusBottom: radiusBottom * 1.35,
        radiusTop: radiusBottom * 1.1,
        height: collarLength,
        sides,
      });
    }
    if (crownRole !== null) {
      parts.push({
        kind: 'prism',
        role: crownRole,
        position: along(length + crownHeight / 2),
        yaw,
        pitch,
        roll,
        radiusBottom: radiusTop * 1.15,
        radiusTop: radiusTop * 1.3,
        height: crownHeight,
        sides,
      });
    }
    for (const part of parts) {
      if (!clearOfCorridors(part, CORRIDOR_BUILD_LENGTH, CORRIDOR_BUILD_RADIUS)) return false;
    }
    half.push(...parts);
    pillars.push({ x, z, ax, ay, az, topY, radius: radiusBottom, bridged: false });
    addAnchor(x, z, radiusBottom);
    return true;
  };

  const pickCrown = (roll: number): MapSurfaceRole | null => {
    if (roll < 0.45) return 'moss';
    if (roll < 0.6) return 'mossLight';
    if (roll < 0.85) return 'litEdge';
    return null;
  };

  // Jittered hex grid over the -Z half disc.
  const rowHeight = PILLAR_SPACING * Math.sqrt(3) * 0.5;
  const rows = Math.ceil(PILLAR_MAX_RADIUS / rowHeight);
  const columns = Math.ceil(PILLAR_MAX_RADIUS / PILLAR_SPACING) + 1;
  for (let row = 0; row < rows; row++) {
    for (let column = -columns; column <= columns; column++) {
      // Every number is drawn before any rejection, so one rejected site does not reshuffle the rest.
      const jitterX = range(-PILLAR_JITTER, PILLAR_JITTER);
      const jitterZ = range(-PILLAR_JITTER, PILLAR_JITTER);
      const heightJitter = range(-60, 60);
      const radiusBottom = range(15, 30);
      const taper = range(0.5, 0.8);
      const sides = 5 + Math.floor(random() * 3);
      const yaw = range(0, Math.PI * 2);
      const leans = random() < 0.3;
      const leanAmount = random();
      const leanDirection = range(0, Math.PI * 2);
      const collar = random() < 0.55;
      const crownRole = pickCrown(random());
      const crownHeight = range(8, 16);

      const x = (column + (row % 2 === 0 ? 0 : 0.5)) * PILLAR_SPACING + jitterX;
      // The first row only jitters away from the mirror plane.
      const z = -(row + 0.5) * rowHeight + (row === 0 ? -Math.abs(jitterZ) : jitterZ);
      const topY = Math.min(Math.max(bowlHeight(x, z) + heightJitter, 140), 600);
      // Cap the lean so the top never drifts more than ~35 m off its base.
      const lean = leans ? leanAmount * Math.min(0.11, Math.atan(35 / (topY - ROOT_Y))) : 0;
      addPillar(
        x,
        z,
        topY,
        radiusBottom,
        taper,
        sides,
        yaw,
        lean,
        leanDirection,
        collar,
        crownRole,
        crownHeight,
      );
    }
  }

  // --- Cover fill: thin needles wherever the grid left a hole ----------------------------------------

  const offsets: { x: number; z: number; d: number }[] = [];
  for (let ox = -120; ox <= 120; ox += 20) {
    for (let oz = -120; oz <= 120; oz += 20) {
      const d = Math.hypot(ox, oz);
      if (d <= FILL_DISTANCE - 10) offsets.push({ x: ox, z: oz, d });
    }
  }
  offsets.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);

  const covered = (x: number, z: number): boolean => {
    for (const anchor of anchors) {
      if (Math.hypot(x - anchor.x, z - anchor.z) <= FILL_DISTANCE) return true;
    }
    return false;
  };

  const fillExtent = Math.ceil(PILLAR_MAX_RADIUS / FILL_STEP) * FILL_STEP;
  for (let z = 0; z >= -fillExtent; z -= FILL_STEP) {
    for (let x = -fillExtent; x <= fillExtent; x += FILL_STEP) {
      if (Math.hypot(x, z) > PILLAR_MAX_RADIUS || covered(x, z)) continue;
      const heightScale = range(0.7, 1);
      const radiusBottom = range(10, 16);
      const sides = 5 + Math.floor(random() * 2);
      const yaw = range(0, Math.PI * 2);
      const crownRole = pickCrown(random());
      for (const offset of offsets) {
        const px = x + offset.x;
        const pz = z + offset.z;
        const topY = Math.max(bowlHeight(px, pz) * heightScale, 140);
        if (addPillar(px, pz, topY, radiusBottom, 0.6, sides, yaw, 0, 0, false, crownRole, 8)) {
          break;
        }
      }
    }
  }

  // --- Bridges ----------------------------------------------------------------------------------------

  const bridgeThickness = 5;
  /** Point on a pillar's axis at world height `y`. */
  const axisAt = (pillar: Pillar, y: number): Vec3 => {
    const s = (y - ROOT_Y) / pillar.ay;
    return { x: pillar.x + pillar.ax * s, y, z: pillar.z + pillar.az * s };
  };
  const addIfClear = (parts: readonly MapSolid[]): boolean => {
    for (const part of parts) {
      if (!clearOfCorridors(part, CORRIDOR_BUILD_LENGTH, CORRIDOR_BUILD_RADIUS)) return false;
    }
    half.push(...parts);
    return true;
  };

  let bridges = 0;
  for (let i = 0; i < pillars.length && bridges < MAX_BRIDGES_PER_HALF; i++) {
    for (let j = i + 1; j < pillars.length && bridges < MAX_BRIDGES_PER_HALF; j++) {
      const a = pillars[i];
      const b = pillars[j];
      if (a === undefined || b === undefined) continue;
      const gap = Math.hypot(a.x - b.x, a.z - b.z);
      if (gap < 120 || gap > 230) continue;
      const chance = random();
      const heightFraction = range(0.5, 0.8);
      const width = range(12, 18);
      const broken = random() < 0.4;
      if (chance > 0.3 || a.bridged || b.bridged) continue;
      const y = Math.min(a.topY, b.topY) * heightFraction;
      if (y < 110) continue;
      const from = axisAt(a, y);
      const to = axisAt(b, y);
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const span = Math.hypot(dx, dz);
      const ux = dx / span;
      const uz = dz / span;
      // Local +X runs from `from` to `to`.
      const yaw = Math.atan2(-dz, dx);
      const parts: MapSolid[] = [];
      if (broken) {
        // Two stubs with a gap to fly through; each ends in a ramp-shaped broken tip.
        const stub = span * 0.28;
        const tip = 14;
        for (const end of [0, 1]) {
          const origin = end === 0 ? from : to;
          const dir = end === 0 ? 1 : -1;
          const stubYaw = end === 0 ? yaw : yaw + Math.PI;
          parts.push(
            {
              kind: 'box',
              role: 'litEdge',
              position: {
                x: origin.x + dir * ux * stub * 0.5,
                y,
                z: origin.z + dir * uz * stub * 0.5,
              },
              yaw: stubYaw,
              pitch: 0,
              roll: 0,
              size: { x: stub, y: bridgeThickness, z: width },
            },
            {
              kind: 'wedge',
              role: 'litEdge',
              position: {
                x: origin.x + dir * ux * (stub + tip * 0.5),
                y,
                z: origin.z + dir * uz * (stub + tip * 0.5),
              },
              yaw: stubYaw,
              pitch: 0,
              roll: 0,
              size: { x: tip, y: bridgeThickness, z: width },
            },
          );
        }
      } else {
        parts.push({
          kind: 'box',
          role: 'litEdge',
          position: { x: (from.x + to.x) * 0.5, y, z: (from.z + to.z) * 0.5 },
          yaw,
          pitch: 0,
          roll: 0,
          size: { x: span, y: bridgeThickness, z: width },
        });
      }
      if (addIfClear(parts)) {
        a.bridged = true;
        b.bridged = true;
        bridges++;
      }
    }
  }

  // Crossings: a slab from a first-row pillar to the mirror plane meets its twin from the far side.
  let crossings = 0;
  for (const pillar of pillars) {
    if (crossings >= MAX_CROSSINGS_PER_HALF) break;
    const chance = random();
    const heightFraction = range(0.55, 0.8);
    if (pillar.bridged || pillar.z < -110 || chance > 0.5) continue;
    const y = pillar.topY * heightFraction;
    const from = axisAt(pillar, y);
    if (y < 110 || from.z >= -20) continue;
    const slab: MapSolid = {
      kind: 'box',
      role: 'litEdge',
      position: { x: from.x, y, z: from.z * 0.5 },
      yaw: Math.PI / 2,
      pitch: 0,
      roll: 0,
      size: { x: -from.z, y: bridgeThickness, z: 14 },
    };
    if (addIfClear([slab])) {
      pillar.bridged = true;
      crossings++;
    }
  }

  // --- Floating shards: cover at altitude, above the lower pillars ------------------------------------

  let shards = 0;
  for (let attempt = 0; attempt < SHARDS_PER_HALF * 6 && shards < SHARDS_PER_HALF; attempt++) {
    const radial = range(300, 800);
    const angle = range(0.08, Math.PI - 0.08);
    const y = range(330, 520);
    const size = range(12, 22);
    const height = range(20, 36);
    const yaw = range(0, Math.PI * 2);
    const pitch = range(-0.25, 0.25);
    const roll = range(-0.25, 0.25);
    const sides = 5 + Math.floor(random() * 2);
    const role: MapSurfaceRole = random() < 0.5 ? 'stone' : 'moss';
    const x = radial * Math.cos(angle);
    const z = -radial * Math.sin(angle);
    if (z > -MIRROR_GAP) continue;
    let free = true;
    for (const disc of reserved) {
      if (Math.hypot(x - disc.x, z - disc.z) < disc.r + size) free = false;
    }
    // Only pillars tall enough to reach the shard are in its way.
    for (const pillar of pillars) {
      const near = Math.hypot(x - pillar.x, z - pillar.z) < pillar.radius + size + 30;
      if (near && pillar.topY > y - height - 40) free = false;
    }
    if (!free) continue;
    const shard: MapSolid = {
      kind: 'prism',
      role,
      position: { x, y, z },
      yaw,
      pitch,
      roll,
      radiusBottom: size * 0.35,
      radiusTop: size,
      height,
      sides,
    };
    if (addIfClear([shard])) {
      shards++;
      reserved.push({ x, z, r: size + 40 });
      addAnchor(x, z, size);
    }
  }

  // --- Assemble ---------------------------------------------------------------------------------------

  const solids: MapSolid[] = [...center, ...half];
  for (const solid of half) solids.push(mirrorSolidZ(solid));

  return {
    id: 'shattered-spires',
    name: 'Shattered Spires',
    seed,
    size: GREYBOX_MAP_SIZE,
    chunks: [],
    props: [],
    sky: {
      // Golden hour, 18 degrees above the horizon, from +X: side light for both teams alike.
      sunDirection: { x: 0.9510565, y: 0.309017, z: 0 },
      sunColor: 0xffd9a0,
      fogColor: 0xe9d9c0,
      // exp2 fog that is ~98 % opaque at 1.2 km.
      fogDensity: 0.00165,
    },
    spawnGates: [createGate(TEAM_EMBER), createGate(TEAM_FROST)],
    colliders: {
      stormCenter: { x: 0, y: 0, z: 0 },
      stormRadius: GREYBOX_STORM_RADIUS,
      ceilingY: GREYBOX_CEILING_Y,
      floorY: GREYBOX_FLOOR_Y,
      cloudSeaY: GREYBOX_CLOUD_SEA_Y,
    },
    solids,
    centerSolidCount: center.length,
    halfSolidCount: half.length,
    chunkSize: GREYBOX_CHUNK_SIZE,
    skyWell: { position: { x: 0, y: SKY_WELL_Y, z: 0 }, ringRadius: RING_RADIUS },
  };
}
