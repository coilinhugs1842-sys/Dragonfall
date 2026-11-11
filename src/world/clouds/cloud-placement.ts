/**
 * Deterministic, seeded placement of the cloud puffs (T-1.5): the same map and seed give the
 * same clouds on every machine, so players can call out "the cloud by the north arch".
 * Pure data, load-time only: no three.js, tested in node.
 */
import { createSeededRandom, distanceToSolidBound } from '../../shared';
import type { MapManifest, MapSolid, Vec3 } from '../../shared';
import { PUFF_BASE_Y, PUFF_VARIANT_COUNT } from './cloud-noise';

/** A sphere no puff centre may fall inside. */
export interface CloudKeepOut {
  readonly position: Vec3;
  readonly radius: number;
}

/** The volume the puffs are scattered in. */
export interface CloudField {
  /** Centre of the arena; only x and z are used. */
  readonly center: Vec3;
  /** Arena radius in metres (the storm wall). Layer radii are fractions of it. */
  readonly radius: number;
  /** World Y of the cloud-sea surface: puffs never dip below it. */
  readonly cloudSeaY: number;
  /** Flight ceiling: puff tops stay under it. */
  readonly ceilingY: number;
  /** Greybox solids to keep clear of (a billboard cut by a pillar shows a hard edge). */
  readonly solids: readonly MapSolid[];
  readonly keepOuts: readonly CloudKeepOut[];
}

/** One layer = one InstancedMesh = one draw call. */
export interface CloudLayerSpec {
  readonly name: string;
  /** Hard cap on instances: the layer never has more, whatever the preset. */
  readonly count: number;
  /** Half-width of a puff in metres. */
  readonly minRadius: number;
  readonly maxRadius: number;
  /** Half-height as a fraction of the half-width. */
  readonly minAspect: number;
  readonly maxAspect: number;
  /** Height of the puff's centre above the cloud sea, in metres. */
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Ring the centres fall in, as fractions of `CloudField.radius`. */
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly minOpacity: number;
  readonly maxOpacity: number;
  /**
   * A puff centre keeps this fraction of its half-width clear of solids. At 1 the billboard
   * can never be cut by a pillar (the cut is a hard line); the big sea banks cannot afford that
   * between the spires and accept being split by them.
   */
  readonly solidClearance: number;
}

/**
 * The three layers, in the order presets enable them (Low 1, Medium 2, High 3).
 * - banks: big mounds resting on the cloud sea, which give the flat sea a broken skyline;
 * - drifters: mid-altitude puffs between the spires, the ones players fly around;
 * - wisps: long flat streaks under the ceiling.
 */
export const CLOUD_LAYER_SPECS: readonly CloudLayerSpec[] = [
  {
    name: 'banks',
    count: 44,
    minRadius: 70,
    maxRadius: 150,
    minAspect: 0.5,
    maxAspect: 0.7,
    minHeight: 8,
    maxHeight: 60,
    innerRadius: 0.12,
    outerRadius: 1.15,
    minOpacity: 0.85,
    maxOpacity: 1,
    solidClearance: 0.35,
  },
  {
    name: 'drifters',
    count: 36,
    minRadius: 45,
    maxRadius: 95,
    minAspect: 0.5,
    maxAspect: 0.75,
    minHeight: 140,
    maxHeight: 460,
    innerRadius: 0.15,
    outerRadius: 1.05,
    minOpacity: 0.7,
    maxOpacity: 0.95,
    solidClearance: 1,
  },
  {
    name: 'wisps',
    count: 28,
    minRadius: 90,
    maxRadius: 180,
    minAspect: 0.26,
    maxAspect: 0.38,
    minHeight: 480,
    maxHeight: 680,
    innerRadius: 0,
    outerRadius: 1.1,
    minOpacity: 0.55,
    maxOpacity: 0.8,
    solidClearance: 1,
  },
];

/** Floats per puff in `CloudLayerPlacement.data`. */
export const CLOUD_PUFF_STRIDE = 9;
/** Field offsets inside one puff record. */
export const PUFF_X = 0;
export const PUFF_Y = 1;
export const PUFF_Z = 2;
/** Half-width and half-height in metres. */
export const PUFF_HALF_WIDTH = 3;
export const PUFF_HALF_HEIGHT = 4;
/** Atlas sprite index, 0..PUFF_VARIANT_COUNT-1. */
export const PUFF_VARIANT = 5;
/** 1 or -1 (mirrored sprite). */
export const PUFF_FLIP = 6;
/** 0..1, offsets the idle sway. */
export const PUFF_PHASE = 7;
export const PUFF_OPACITY = 8;

export interface CloudLayerPlacement {
  /** Puffs actually placed: `spec.count`, or fewer when the field is too crowded. */
  readonly count: number;
  /** `count * CLOUD_PUFF_STRIDE` floats. */
  readonly data: Float32Array;
}

/** Two puffs of one layer stay at least this fraction of their summed half-widths apart. */
const PUFF_SPACING = 0.7;
/** How far the sprite's flat base sits below the centre, as a fraction of the half-height. */
const PUFF_BASE_DROP = -PUFF_BASE_Y;
const ATTEMPTS_PER_PUFF = 40;
/** Decorrelates the layers of one seed. */
const LAYER_SEED_STEP = 0x9e3779b1;
/** Spawn slots are kept clear by this radius so nobody launches into a white-out. */
const GATE_KEEP_OUT_RADIUS = 90;

export const CLOUD_DEFAULT_SEED = 0xc10d5;

/** The cloud field of a map: storm cylinder, sea level, ceiling, solids, and clear spawn slots. */
export function cloudFieldFromMap(
  map: Pick<MapManifest, 'colliders' | 'spawnGates' | 'solids'>,
): CloudField {
  const keepOuts: CloudKeepOut[] = [];
  for (const gate of map.spawnGates) {
    for (const slot of gate.slots) keepOuts.push({ position: slot, radius: GATE_KEEP_OUT_RADIUS });
  }
  return {
    center: map.colliders.stormCenter,
    radius: map.colliders.stormRadius,
    cloudSeaY: map.colliders.cloudSeaY ?? map.colliders.floorY,
    ceilingY: map.colliders.ceilingY,
    solids: map.solids ?? [],
    keepOuts,
  };
}

/**
 * Scatters one layer. Area-uniform inside the layer's ring, rejecting spots that are inside a
 * keep-out, too close to a solid, or crowding another puff of the same layer (stacked
 * billboards are pure overdraw). Deterministic for a given field, spec, seed and layer index.
 */
export function placeCloudLayer(
  field: CloudField,
  spec: CloudLayerSpec,
  seed: number = CLOUD_DEFAULT_SEED,
  layerIndex = 0,
): CloudLayerPlacement {
  const random = createSeededRandom((seed + Math.imul(layerIndex + 1, LAYER_SEED_STEP)) >>> 0);
  const wanted = Math.max(0, Math.floor(spec.count));
  const data = new Float32Array(wanted * CLOUD_PUFF_STRIDE);
  const inner = Math.max(0, spec.innerRadius) * field.radius;
  const outer = Math.max(spec.innerRadius, spec.outerRadius) * field.radius;
  const innerSq = inner * inner;
  const outerSq = outer * outer;

  let count = 0;
  for (let attempt = 0; attempt < wanted * ATTEMPTS_PER_PUFF && count < wanted; attempt++) {
    // Every candidate draws the same nine numbers, accepted or not.
    const ring = Math.sqrt(innerSq + (outerSq - innerSq) * random());
    const angle = random() * Math.PI * 2;
    const halfWidth = spec.minRadius + (spec.maxRadius - spec.minRadius) * random();
    const aspect = spec.minAspect + (spec.maxAspect - spec.minAspect) * random();
    const heightT = random();
    const variant = Math.min(Math.floor(random() * PUFF_VARIANT_COUNT), PUFF_VARIANT_COUNT - 1);
    const flip = random() < 0.5 ? -1 : 1;
    const phase = random();
    const opacity = spec.minOpacity + (spec.maxOpacity - spec.minOpacity) * random();

    const halfHeight = halfWidth * aspect;
    const x = field.center.x + Math.cos(angle) * ring;
    const z = field.center.z + Math.sin(angle) * ring;
    // Base above the sea, top under the ceiling.
    const lowest = field.cloudSeaY + halfHeight * PUFF_BASE_DROP + spec.minHeight;
    const highest = Math.min(
      field.cloudSeaY + halfHeight * PUFF_BASE_DROP + spec.maxHeight,
      field.ceilingY - halfHeight,
    );
    if (highest < lowest) continue;
    const y = lowest + (highest - lowest) * heightT;

    if (!isClear(field, data, count, x, y, z, halfWidth, spec.solidClearance)) continue;

    const o = count * CLOUD_PUFF_STRIDE;
    data[o + PUFF_X] = x;
    data[o + PUFF_Y] = y;
    data[o + PUFF_Z] = z;
    data[o + PUFF_HALF_WIDTH] = halfWidth;
    data[o + PUFF_HALF_HEIGHT] = halfHeight;
    data[o + PUFF_VARIANT] = variant;
    data[o + PUFF_FLIP] = flip;
    data[o + PUFF_PHASE] = phase;
    data[o + PUFF_OPACITY] = opacity;
    count++;
  }

  return { count, data: count === wanted ? data : data.slice(0, count * CLOUD_PUFF_STRIDE) };
}

function isClear(
  field: CloudField,
  placed: Float32Array,
  placedCount: number,
  x: number,
  y: number,
  z: number,
  halfWidth: number,
  solidClearance: number,
): boolean {
  for (const keepOut of field.keepOuts) {
    const dx = x - keepOut.position.x;
    const dy = y - keepOut.position.y;
    const dz = z - keepOut.position.z;
    if (dx * dx + dy * dy + dz * dz < keepOut.radius * keepOut.radius) return false;
  }
  for (let i = 0; i < placedCount; i++) {
    const o = i * CLOUD_PUFF_STRIDE;
    const dx = x - (placed[o + PUFF_X] ?? 0);
    const dy = y - (placed[o + PUFF_Y] ?? 0);
    const dz = z - (placed[o + PUFF_Z] ?? 0);
    const gap = (halfWidth + (placed[o + PUFF_HALF_WIDTH] ?? 0)) * PUFF_SPACING;
    if (dx * dx + dy * dy + dz * dz < gap * gap) return false;
  }
  const clearance = halfWidth * solidClearance;
  for (const solid of field.solids) {
    if (distanceToSolidBound(solid, x, y, z) < clearance) return false;
  }
  return true;
}

/** Places every layer of `specs` with one seed. */
export function placeCloudLayers(
  field: CloudField,
  specs: readonly CloudLayerSpec[] = CLOUD_LAYER_SPECS,
  seed: number = CLOUD_DEFAULT_SEED,
): CloudLayerPlacement[] {
  return specs.map((spec, index) => placeCloudLayer(field, spec, seed, index));
}
