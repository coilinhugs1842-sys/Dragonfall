import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, createGreyboxSpires, distanceToSolidBound } from '../../src/shared';
import {
  CLOUD_LAYER_SPECS,
  CLOUD_PUFF_STRIDE,
  CLOUD_QUALITY_LIMITS,
  CLOUD_RENDER_ORDER_BASE,
  CLOUD_SEA_MAX_HALF_EXTENT,
  CLOUD_SEA_RENDER_ORDER,
  CLOUD_SEA_SNAP_STEP,
  PUFF_ATLAS_GRID,
  PUFF_BASE_Y,
  PUFF_CONTENT_RADIUS,
  PUFF_FLIP,
  PUFF_HALF_HEIGHT,
  PUFF_HALF_WIDTH,
  PUFF_NEAR_FADE_END,
  PUFF_NEAR_FADE_START,
  PUFF_OPACITY,
  PUFF_VARIANT,
  PUFF_VARIANT_COUNT,
  PUFF_X,
  PUFF_Y,
  PUFF_Z,
  SIGNED_ZERO_BYTE,
  cloudFieldFromMap,
  cloudSeaHalfExtent,
  createCloudBillboards,
  createCloudSea,
  generateCloudSeaNoise,
  generatePuffAtlas,
  placeCloudLayer,
  placeCloudLayers,
  puffDistanceFade,
  puffScreenSize,
  smoothstep,
  snapToGrid,
  wrapScroll,
} from '../../src/world/clouds';
import type { CloudLayerPlacement } from '../../src/world/clouds';
import { SKY_RENDER_ORDER, fogDistanceForOpacity, fogOpacityAt } from '../../src/world/sky';

const map = createGreyboxSpires();
const field = cloudFieldFromMap(map);

function declaredUniforms(glsl: string): string[] {
  return [...glsl.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((match) => match[1] ?? '');
}

/** three's fog chunks declare these themselves. */
const FOG_UNIFORMS = ['fogColor', 'fogDensity', 'fogFar', 'fogNear'];

function at(placement: CloudLayerPlacement, index: number, field_: number): number {
  return placement.data[index * CLOUD_PUFF_STRIDE + field_] ?? Number.NaN;
}

describe('cloud maths', () => {
  it('snaps to the nearest grid line', () => {
    expect(snapToGrid(0, 64)).toBe(0);
    expect(snapToGrid(31.9, 64)).toBe(0);
    expect(snapToGrid(32.1, 64)).toBe(64);
    expect(snapToGrid(-33, 64)).toBe(-64);
    expect(Object.is(snapToGrid(-1, 64), 0)).toBe(true);
    expect(snapToGrid(12.5, 0)).toBe(12.5);
    // Small camera moves never move the result by anything but whole steps.
    for (let x = -500; x < 500; x += 7.3) {
      const snapped = snapToGrid(x, 64);
      expect(Math.abs(snapped - x)).toBeLessThanOrEqual(32);
      expect(Math.abs(snapped % 64)).toBe(0);
    }
  });

  it('wraps the scroll offset into [0, 1) for any time and direction', () => {
    expect(wrapScroll(0, 4, 900)).toBe(0);
    expect(wrapScroll(225, 4, 900)).toBe(0);
    expect(wrapScroll(112.5, 4, 900)).toBeCloseTo(0.5, 12);
    expect(wrapScroll(10, -9, 900)).toBeCloseTo(0.9, 12);
    expect(wrapScroll(5, 3, 0)).toBe(0);
    for (const time of [1e-9, 0.016, 3599.99, 86400, 1e7]) {
      for (const speed of [-4.6, -1e-12, 3.2]) {
        const offset = wrapScroll(time, speed, 310);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(1);
      }
    }
  });

  it('sizes the sea so fog hides its edge', () => {
    const density = map.sky.fogDensity;
    const halfExtent = cloudSeaHalfExtent(density, CLOUD_SEA_SNAP_STEP);
    // The nearest edge is at least halfExtent - step/2 away from the camera.
    expect(fogOpacityAt(density, halfExtent - CLOUD_SEA_SNAP_STEP / 2)).toBeGreaterThan(0.9999);
    expect(halfExtent).toBeLessThan(2500);
    expect(cloudSeaHalfExtent(0, CLOUD_SEA_SNAP_STEP)).toBe(CLOUD_SEA_MAX_HALF_EXTENT);
    expect(cloudSeaHalfExtent(1e-7, 64)).toBe(CLOUD_SEA_MAX_HALF_EXTENT);
  });

  it('caps the on-screen size of a puff and fades it out near the camera', () => {
    const projectionScale = 1 / Math.tan((60 * Math.PI) / 360);
    for (const limits of Object.values(CLOUD_QUALITY_LIMITS)) {
      for (const distance of [0, 1, 50, 200, 1000]) {
        const size = puffScreenSize(150, distance, projectionScale, limits.maxScreenSize);
        expect(size).toBeLessThanOrEqual(limits.maxScreenSize);
      }
    }
    expect(puffScreenSize(50, 1000, projectionScale, 0.42)).toBeCloseTo(0.0866, 3);

    const fade = (distance: number): number =>
      puffDistanceFade(distance, 100, PUFF_NEAR_FADE_START, PUFF_NEAR_FADE_END, 1000, 1300);
    // Inside the puff, and a little outside it, nothing is drawn at all.
    expect(fade(0)).toBe(0);
    expect(fade(100)).toBe(0);
    expect(fade(120)).toBe(0);
    expect(fade(200)).toBeGreaterThan(0);
    expect(fade(200)).toBeLessThan(1);
    expect(fade(300)).toBe(1);
    expect(fade(900)).toBe(1);
    expect(fade(1300)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
  });
});

describe('cloud sea noise', () => {
  const size = 64;
  const noise = generateCloudSeaNoise(size, 7);

  it('is deterministic per seed', () => {
    expect(noise.length).toBe(size * size * 4);
    expect(generateCloudSeaNoise(size, 7)).toEqual(noise);
    expect(generateCloudSeaNoise(size, 8)).not.toEqual(noise);
    expect(() => generateCloudSeaNoise(4, 1)).toThrow();
  });

  it('uses the whole height range, with centred slopes and opaque alpha', () => {
    let min = 255;
    let max = 0;
    let slopeSum = 0;
    let steepest = 0;
    for (let i = 0; i < size * size; i++) {
      const h = noise[i * 4] ?? 0;
      min = Math.min(min, h);
      max = Math.max(max, h);
      const du = (noise[i * 4 + 1] ?? 0) - SIGNED_ZERO_BYTE;
      const dv = (noise[i * 4 + 2] ?? 0) - SIGNED_ZERO_BYTE;
      slopeSum += du + dv;
      steepest = Math.max(steepest, Math.abs(du), Math.abs(dv));
      expect(noise[i * 4 + 3]).toBe(255);
    }
    expect(min).toBe(0);
    expect(max).toBe(255);
    expect(steepest).toBe(127);
    // A tiling height field has zero mean slope.
    expect(Math.abs(slopeSum / (size * size * 2))).toBeLessThan(1.5);
  });

  it('tiles: the step across the wrap edge is no bigger than steps inside', () => {
    const heightAt = (x: number, y: number): number => noise[(y * size + x) * 4] ?? 0;
    let inside = 0;
    let acrossU = 0;
    let acrossV = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size - 1; x++) {
        inside = Math.max(inside, Math.abs(heightAt(x + 1, y) - heightAt(x, y)));
      }
      acrossU = Math.max(acrossU, Math.abs(heightAt(0, y) - heightAt(size - 1, y)));
      acrossV = Math.max(acrossV, Math.abs(heightAt(y, 0) - heightAt(y, size - 1)));
    }
    expect(acrossU).toBeLessThanOrEqual(inside);
    expect(acrossV).toBeLessThanOrEqual(inside);
  });

  it('stores the slope of the stored height', () => {
    // Where the map says "rising along +u", the next texel is higher.
    let agree = 0;
    let total = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const du = (noise[(y * size + x) * 4 + 1] ?? 0) - SIGNED_ZERO_BYTE;
        if (Math.abs(du) < 40) continue;
        const next = noise[(y * size + ((x + 1) % size)) * 4] ?? 0;
        const previous = noise[(y * size + ((x + size - 1) % size)) * 4] ?? 0;
        total++;
        if (Math.sign(next - previous) === Math.sign(du)) agree++;
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(agree).toBe(total);
  });
});

describe('puff atlas', () => {
  const cell = 32;
  const atlasSize = cell * PUFF_ATLAS_GRID;
  const atlas = generatePuffAtlas(cell, 3);
  const texel = (variant: number, px: number, py: number, channel: number): number => {
    const x = (variant % PUFF_ATLAS_GRID) * cell + px;
    const y = Math.floor(variant / PUFF_ATLAS_GRID) * cell + py;
    return atlas[(y * atlasSize + x) * 4 + channel] ?? Number.NaN;
  };

  it('is deterministic per seed', () => {
    expect(atlas.length).toBe(atlasSize * atlasSize * 4);
    expect(generatePuffAtlas(cell, 3)).toEqual(atlas);
    expect(generatePuffAtlas(cell, 4)).not.toEqual(atlas);
    expect(() => generatePuffAtlas(2, 1)).toThrow();
  });

  it('keeps every sprite inside the content circle, with a solid core', () => {
    for (let variant = 0; variant < PUFF_VARIANT_COUNT; variant++) {
      let solid = 0;
      for (let py = 0; py < cell; py++) {
        for (let px = 0; px < cell; px++) {
          const cx = ((px + 0.5) / cell) * 2 - 1;
          const cy = ((py + 0.5) / cell) * 2 - 1;
          const alpha = texel(variant, px, py, 3);
          if (Math.hypot(cx, cy) > PUFF_CONTENT_RADIUS) expect(alpha).toBe(0);
          if (alpha === 255) solid++;
        }
      }
      // Not a speck and not a full square.
      expect(solid).toBeGreaterThan(cell * cell * 0.08);
      expect(solid).toBeLessThan(cell * cell * 0.6);
    }
  });

  it('makes the variants different shapes', () => {
    const cellAlpha = (variant: number): number[] => {
      const out: number[] = [];
      for (let py = 0; py < cell; py++) {
        for (let px = 0; px < cell; px++) out.push(texel(variant, px, py, 3));
      }
      return out;
    };
    for (let variant = 1; variant < PUFF_VARIANT_COUNT; variant++) {
      expect(cellAlpha(variant)).not.toEqual(cellAlpha(0));
    }
  });

  it('bakes normals that lean outward: left flank -x, right flank +x, top +y', () => {
    for (let variant = 0; variant < PUFF_VARIANT_COUNT; variant++) {
      let left = 0;
      let right = 0;
      let top = 0;
      for (let py = 0; py < cell; py++) {
        for (let px = 0; px < cell; px++) {
          if (texel(variant, px, py, 3) < 128) continue;
          const nx = texel(variant, px, py, 0) - SIGNED_ZERO_BYTE;
          const ny = texel(variant, px, py, 1) - SIGNED_ZERO_BYTE;
          if (px < cell * 0.3) left += nx;
          if (px > cell * 0.7) right += nx;
          if (py > cell * 0.6) top += ny;
        }
      }
      expect(left).toBeLessThan(0);
      expect(right).toBeGreaterThan(0);
      expect(top).toBeGreaterThan(0);
    }
  });
});

describe('cloud placement', () => {
  const placements = placeCloudLayers(field);

  it('is deterministic and differs per seed and per layer', () => {
    const again = placeCloudLayers(field);
    expect(again.length).toBe(CLOUD_LAYER_SPECS.length);
    for (let layer = 0; layer < placements.length; layer++) {
      expect(again[layer]?.data).toEqual(placements[layer]?.data);
    }
    const spec = CLOUD_LAYER_SPECS[0];
    if (spec === undefined) throw new Error('no layer spec');
    expect(placeCloudLayer(field, spec, 1, 0).data).not.toEqual(
      placeCloudLayer(field, spec, 2, 0).data,
    );
    expect(placeCloudLayer(field, spec, 1, 0).data).not.toEqual(
      placeCloudLayer(field, spec, 1, 1).data,
    );
  });

  it('never exceeds the hard instance cap and fills most of it', () => {
    for (let layer = 0; layer < placements.length; layer++) {
      const spec = CLOUD_LAYER_SPECS[layer];
      const placement = placements[layer];
      if (spec === undefined || placement === undefined) throw new Error('missing layer');
      expect(placement.count).toBeLessThanOrEqual(spec.count);
      expect(placement.count).toBeGreaterThanOrEqual(Math.floor(spec.count * 0.8));
      expect(placement.data.length).toBe(placement.count * CLOUD_PUFF_STRIDE);
    }
  });

  it('keeps puffs in their ring, above the sea, under the ceiling, in their size range', () => {
    for (let layer = 0; layer < placements.length; layer++) {
      const spec = CLOUD_LAYER_SPECS[layer];
      const placement = placements[layer];
      if (spec === undefined || placement === undefined) throw new Error('missing layer');
      for (let i = 0; i < placement.count; i++) {
        const x = at(placement, i, PUFF_X);
        const y = at(placement, i, PUFF_Y);
        const z = at(placement, i, PUFF_Z);
        const halfWidth = at(placement, i, PUFF_HALF_WIDTH);
        const halfHeight = at(placement, i, PUFF_HALF_HEIGHT);
        const ring = Math.hypot(x - field.center.x, z - field.center.z);
        expect(ring).toBeGreaterThanOrEqual(spec.innerRadius * field.radius - 1e-3);
        expect(ring).toBeLessThanOrEqual(spec.outerRadius * field.radius + 1e-3);
        expect(halfWidth).toBeGreaterThanOrEqual(spec.minRadius);
        expect(halfWidth).toBeLessThanOrEqual(spec.maxRadius);
        expect(halfHeight).toBeLessThan(halfWidth);
        // The sprite's flat base clears the sea.
        expect(y + halfHeight * PUFF_BASE_Y).toBeGreaterThanOrEqual(
          field.cloudSeaY + spec.minHeight - 1e-3,
        );
        expect(y + halfHeight).toBeLessThanOrEqual(field.ceilingY + 1e-3);
        expect([0, 1, 2, 3]).toContain(at(placement, i, PUFF_VARIANT));
        expect(Math.abs(at(placement, i, PUFF_FLIP))).toBe(1);
        expect(at(placement, i, PUFF_OPACITY)).toBeGreaterThan(0.5);
        expect(at(placement, i, PUFF_OPACITY)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps clear of solids, spawn slots and other puffs of the layer', () => {
    expect(field.solids.length).toBeGreaterThan(100);
    expect(field.keepOuts.length).toBe(10);
    for (let layer = 0; layer < placements.length; layer++) {
      const placement = placements[layer];
      const spec = CLOUD_LAYER_SPECS[layer];
      if (spec === undefined || placement === undefined) throw new Error('missing layer');
      for (let i = 0; i < placement.count; i++) {
        const x = at(placement, i, PUFF_X);
        const y = at(placement, i, PUFF_Y);
        const z = at(placement, i, PUFF_Z);
        const halfWidth = at(placement, i, PUFF_HALF_WIDTH);
        for (const solid of field.solids) {
          expect(distanceToSolidBound(solid, x, y, z)).toBeGreaterThanOrEqual(
            halfWidth * spec.solidClearance,
          );
        }
        for (const keepOut of field.keepOuts) {
          const distance = Math.hypot(
            x - keepOut.position.x,
            y - keepOut.position.y,
            z - keepOut.position.z,
          );
          expect(distance).toBeGreaterThanOrEqual(keepOut.radius);
        }
        for (let j = 0; j < i; j++) {
          const distance = Math.hypot(
            x - at(placement, j, PUFF_X),
            y - at(placement, j, PUFF_Y),
            z - at(placement, j, PUFF_Z),
          );
          const gap = (halfWidth + at(placement, j, PUFF_HALF_WIDTH)) * 0.7;
          expect(distance).toBeGreaterThanOrEqual(gap - 1e-3);
        }
      }
    }
  });

  it('returns fewer puffs instead of looping forever in a field with no room', () => {
    const spec = CLOUD_LAYER_SPECS[0];
    if (spec === undefined) throw new Error('no layer spec');
    const blocked = {
      ...field,
      keepOuts: [{ position: { x: 0, y: 0, z: 0 }, radius: 1e6 }],
    };
    expect(placeCloudLayer(blocked, spec).count).toBe(0);
    expect(placeCloudLayer(blocked, spec).data.length).toBe(0);
  });
});

describe('cloud billboards', () => {
  it('draws 1 / 2 / 3 layers and stays under the instance caps', () => {
    const clouds = createCloudBillboards({ field, sky: map.sky });
    expect(clouds.objects.length).toBe(3);
    const cap = CLOUD_LAYER_SPECS.reduce((sum, spec) => sum + spec.count, 0);
    let previous = 0;
    for (const preset of [QUALITY_PRESETS.low, QUALITY_PRESETS.medium, QUALITY_PRESETS.high]) {
      clouds.setQuality(preset);
      const visible = clouds.objects.filter((mesh) => mesh.visible);
      expect(visible.length).toBe(preset.cloudLayers);
      let drawn = 0;
      for (let layer = 0; layer < clouds.objects.length; layer++) {
        const mesh = clouds.objects[layer];
        const spec = CLOUD_LAYER_SPECS[layer];
        if (mesh === undefined || spec === undefined) throw new Error('missing layer');
        expect(mesh.count).toBeLessThanOrEqual(spec.count);
        expect(mesh.visible).toBe(layer < preset.cloudLayers);
        if (mesh.visible) drawn += mesh.count;
      }
      expect(clouds.activeInstances).toBe(drawn);
      expect(drawn).toBeLessThanOrEqual(cap);
      expect(drawn).toBeGreaterThan(previous);
      previous = drawn;
      expect(clouds.objects[0]?.material.uniforms['uMaxScreen']?.value).toBe(
        CLOUD_QUALITY_LIMITS[preset.id].maxScreenSize,
      );
    }
    clouds.dispose();
  });

  it('shares one blended, non-depth-writing material and draws before other transparents', () => {
    const clouds = createCloudBillboards({ field, sky: map.sky });
    const material = clouds.objects[0]?.material;
    if (material === undefined) throw new Error('no layer');
    for (let layer = 0; layer < clouds.objects.length; layer++) {
      const mesh = clouds.objects[layer];
      expect(mesh?.material).toBe(material);
      expect(mesh?.renderOrder).toBe(CLOUD_RENDER_ORDER_BASE + layer);
      expect(mesh?.renderOrder).toBeLessThan(0);
    }
    expect(material.transparent).toBe(true);
    expect(material.premultipliedAlpha).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.depthTest).toBe(true);
    expect(material.fog).toBe(true);
    const version = material.version;
    clouds.setQuality(QUALITY_PRESETS.low);
    clouds.setQuality(QUALITY_PRESETS.high);
    // Quality changes are uniforms and counts only: no shader recompile.
    expect(material.version).toBe(version);
    const declared = [
      ...declaredUniforms(material.vertexShader),
      ...declaredUniforms(material.fragmentShader),
      ...FOG_UNIFORMS,
    ].sort();
    expect(declared).toEqual(Object.keys(material.uniforms).sort());
    clouds.dispose();
  });

  it('bounds every puff of a layer for frustum culling', () => {
    const clouds = createCloudBillboards({ field, sky: map.sky });
    const placements = placeCloudLayers(field);
    const centre = new Vector3();
    for (let layer = 0; layer < clouds.objects.length; layer++) {
      const sphere = clouds.objects[layer]?.boundingSphere;
      const placement = placements[layer];
      if (sphere === null || sphere === undefined || placement === undefined) {
        throw new Error('missing bounds');
      }
      for (let i = 0; i < placement.count; i++) {
        centre.set(at(placement, i, PUFF_X), at(placement, i, PUFF_Y), at(placement, i, PUFF_Z));
        const reach = centre.distanceTo(sphere.center) + at(placement, i, PUFF_HALF_WIDTH);
        expect(reach).toBeLessThanOrEqual(sphere.radius + 1e-3);
      }
    }
    clouds.dispose();
  });

  it('fades puffs out before the fog-limited far distance and wraps the sway angle', () => {
    const clouds = createCloudBillboards({ field, sky: map.sky });
    const uniforms = clouds.objects[0]?.material.uniforms;
    const fade = uniforms?.['uFade']?.value as { x: number; y: number; z: number; w: number };
    expect(fade.x).toBe(PUFF_NEAR_FADE_START);
    expect(fade.y).toBe(PUFF_NEAR_FADE_END);
    expect(fade.z).toBeLessThan(fade.w);
    expect(fade.w).toBeCloseTo(fogDistanceForOpacity(map.sky.fogDensity, 0.99), 6);
    for (const time of [0, 0.5, 60, 3600, 1e6]) {
      clouds.update(time);
      const sway = uniforms?.['uSway']?.value as number;
      expect(sway).toBeGreaterThanOrEqual(0);
      expect(sway).toBeLessThan(Math.PI * 2);
    }
    clouds.dispose();
  });

  it('keeps the estimated overdraw of a horizontal view under one screen at Medium', () => {
    // Rough fill estimate: the camera looks at the arena centre with a 60 degree vertical FOV at
    // 16:9; every active puff within 50 degrees of the view axis counts with its capped
    // octagon area, whatever its opacity. Sum is in "screens".
    const projectionScale = 1 / Math.tan((60 * Math.PI) / 360);
    const aspect = 16 / 9;
    const placements = placeCloudLayers(field);
    const preset = QUALITY_PRESETS.medium;
    const limits = CLOUD_QUALITY_LIMITS.medium;
    const farEnd = fogDistanceForOpacity(map.sky.fogDensity, 0.99);
    const cameras = [
      { x: 0, y: 300, z: -780 },
      { x: 600, y: 60, z: 300 },
      { x: -200, y: 520, z: 100 },
      { x: 900, y: 150, z: 0 },
    ];
    let worst = 0;
    for (const camera of cameras) {
      const toCentre = Math.hypot(camera.x, camera.z);
      let screens = 0;
      for (let layer = 0; layer < preset.cloudLayers; layer++) {
        const placement = placements[layer];
        if (placement === undefined) continue;
        const active = Math.ceil(placement.count * limits.instanceFraction);
        for (let i = 0; i < active; i++) {
          const dx = at(placement, i, PUFF_X) - camera.x;
          const dy = at(placement, i, PUFF_Y) - camera.y;
          const dz = at(placement, i, PUFF_Z) - camera.z;
          const distance = Math.hypot(dx, dy, dz);
          const halfWidth = at(placement, i, PUFF_HALF_WIDTH);
          const fade = puffDistanceFade(
            distance,
            halfWidth,
            PUFF_NEAR_FADE_START,
            PUFF_NEAR_FADE_END,
            farEnd * 0.8,
            farEnd,
          );
          if (fade < 0.004) continue;
          const cos = (dx * -camera.x + dz * -camera.z) / (distance * toCentre);
          if (cos < Math.cos((50 * Math.PI) / 180)) continue;
          const size = puffScreenSize(halfWidth, distance, projectionScale, limits.maxScreenSize);
          const heightRatio = at(placement, i, PUFF_HALF_HEIGHT) / halfWidth;
          // Octagon area is ~0.83 of its bounding square; the screen is 2 x 2 in NDC.
          screens += ((2 * size) / aspect) * (2 * size * heightRatio) * 0.83 * 0.25;
        }
      }
      worst = Math.max(worst, screens);
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1);
  });
});

describe('cloud sea', () => {
  it('is one opaque fogged quad at the map sea level, drawn between terrain and sky', () => {
    const sea = createCloudSea({ cloudSeaY: field.cloudSeaY, sky: map.sky });
    const material = sea.object.material;
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
    expect(material.fog).toBe(true);
    expect(sea.object.position.y).toBe(field.cloudSeaY);
    expect(sea.object.geometry.getIndex()?.count).toBe(6);
    expect(sea.object.renderOrder).toBe(CLOUD_SEA_RENDER_ORDER);
    expect(CLOUD_SEA_RENDER_ORDER).toBeGreaterThan(0);
    expect(CLOUD_SEA_RENDER_ORDER).toBeLessThan(SKY_RENDER_ORDER);
    const declared = [
      ...declaredUniforms(material.vertexShader),
      ...declaredUniforms(material.fragmentShader),
      ...FOG_UNIFORMS,
    ].sort();
    expect(declared).toEqual(Object.keys(material.uniforms).sort());
    sea.dispose();
  });

  it('follows the camera in snapped XZ steps and keeps its height', () => {
    const sea = createCloudSea({ cloudSeaY: 12, sky: map.sky });
    const camera = { x: 130.2, y: 400, z: -700.9 };
    sea.update(camera, 10);
    expect(sea.object.position.x).toBe(128);
    expect(sea.object.position.y).toBe(12);
    expect(sea.object.position.z).toBe(-704);
    // A small move leaves the quad where it is.
    camera.x = 140;
    sea.update(camera, 10.016);
    expect(sea.object.position.x).toBe(128);
    const scroll = sea.object.material.uniforms['uScroll']?.value as {
      x: number;
      y: number;
      z: number;
      w: number;
    };
    for (const time of [0, 10, 5000, 1e6]) {
      sea.update(camera, time);
      for (const offset of [scroll.x, scroll.y, scroll.z, scroll.w]) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(1);
      }
    }
    sea.dispose();
  });

  it('uses 1 octave on Low, 2 on Medium, and adds the rim on High', () => {
    const sea = createCloudSea({ cloudSeaY: 0 });
    const material = sea.object.material;
    sea.setQuality(QUALITY_PRESETS.low);
    expect(material.defines['SEA_OCTAVES']).toBe(1);
    expect('SEA_RIM' in material.defines).toBe(false);
    const lowBump = material.uniforms['uBump']?.value as number;
    sea.setQuality(QUALITY_PRESETS.medium);
    expect(material.defines['SEA_OCTAVES']).toBe(2);
    expect('SEA_RIM' in material.defines).toBe(false);
    expect(material.uniforms['uBump']?.value as number).toBeGreaterThan(lowBump);
    const version = material.version;
    sea.setQuality(QUALITY_PRESETS.medium);
    expect(material.version).toBe(version);
    sea.setQuality(QUALITY_PRESETS.high);
    expect(material.defines['SEA_OCTAVES']).toBe(2);
    expect('SEA_RIM' in material.defines).toBe(true);
    expect(material.version).toBeGreaterThan(version);
    sea.dispose();
  });
});
