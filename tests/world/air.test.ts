/**
 * What a map puts in its air and on its rock beyond the first map's look (Emberfall Caldera):
 * the heat vents' rising streaks, the ash, the lava's light on the world material, and the
 * marker glow. All of it counted against the particle budget and switched by preset.
 */
import { AdditiveBlending, DataTexture, InstancedMesh } from 'three';
import type { Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  EMBERFALL_VENTS,
  QUALITY_PRESETS,
  QUALITY_PRESET_IDS,
  VENT_TUNING,
  createEmberfallCaldera,
  createShatteredSpires,
  heatVentStrength,
} from '../../src/shared';
import type { MapTexture } from '../../src/shared';
import {
  ASH_FLAKE_COUNTS,
  VENT_CARDS_PER_WEIGHT,
  VENT_CARD_STRIDE,
  createAshFall,
  createVentColumns,
  placeVentCards,
  ventCardCount,
  ventCardWeight,
} from '../../src/world/air';
import { aerieGlowModeOf } from '../../src/cinematics/aerie/aerie-set-view';
import { createMapView } from '../../src/world/map';
import {
  GLOW_MODE_CARVED,
  GLOW_MODE_CRYSTAL,
  GLOW_MODE_FLAME,
  GLOW_MODE_MARKER,
  GLOW_MODE_STEADY,
  createWorldMaterials,
  glowModeOf,
} from '../../src/world/props';
import type { LoadedMapTexture } from '../../src/world/props';
import { skyLookOf } from '../../src/world/sky';

const CALDERA = createEmberfallCaldera();
const SPIRES = createShatteredSpires();
const SEA_Y = CALDERA.colliders.cloudSeaY ?? CALDERA.colliders.floorY;

/** Effect particles alive at once in a 5v5 on the first map (the `?bench` peaks, T-5.x). */
const EFFECT_PEAK = { low: 154, medium: 204, high: 374 } as const;

describe('vent streaks', () => {
  it('a wide vent gets two shares, a flank vent one', () => {
    const weights = EMBERFALL_VENTS.map((vent) => [vent.id, ventCardWeight(vent)]);
    expect(weights.filter(([, weight]) => weight === 2).map(([id]) => id)).toEqual(['main']);
    expect(weights.filter(([, weight]) => weight === 1)).toHaveLength(8);
    expect(ventCardCount(EMBERFALL_VENTS, 'low')).toBe(10 * VENT_CARDS_PER_WEIGHT.low);
    expect(ventCardCount(EMBERFALL_VENTS, 'high')).toBe(10 * VENT_CARDS_PER_WEIGHT.high);
    expect(ventCardCount([], 'high')).toBe(0);
  });

  it('places every streak on a vent of the map, deterministically', () => {
    const placed = placeVentCards(EMBERFALL_VENTS, 7);
    expect(placed.length).toBe(ventCardCount(EMBERFALL_VENTS, 'high') * VENT_CARD_STRIDE);
    expect(Array.from(placeVentCards(EMBERFALL_VENTS, 7))).toEqual(Array.from(placed));
    expect(Array.from(placeVentCards(EMBERFALL_VENTS, 8))).not.toEqual(Array.from(placed));
    for (let o = 0; o < placed.length; o += VENT_CARD_STRIDE) {
      // (the buffer is float32)
      const vent = EMBERFALL_VENTS.find(
        (candidate) =>
          Math.fround(candidate.position.x) === placed[o] &&
          Math.fround(candidate.position.y) === placed[o + 1] &&
          Math.fround(candidate.position.z) === placed[o + 2],
      );
      expect(vent).toBeDefined();
      expect(placed[o + 3]).toBe(Math.fround(vent?.radius ?? 0));
      expect(placed[o + 4]).toBe(Math.fround(vent?.height ?? 0));
      for (const seed of [placed[o + 5] ?? -1, placed[o + 6] ?? -1]) {
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThan(1);
      }
    }
  });

  it('any preset draws a prefix that gives every vent its share', () => {
    const placed = placeVentCards(EMBERFALL_VENTS, 7);
    for (const id of QUALITY_PRESET_IDS) {
      const count = ventCardCount(EMBERFALL_VENTS, id);
      const perVent = new Map<string, number>();
      for (let i = 0; i < count; i++) {
        const o = i * VENT_CARD_STRIDE;
        const key = `${placed[o]},${placed[o + 2]}`;
        perVent.set(key, (perVent.get(key) ?? 0) + 1);
      }
      for (const vent of EMBERFALL_VENTS) {
        const key = `${Math.fround(vent.position.x)},${Math.fround(vent.position.z)}`;
        expect(perVent.get(key), `${id} ${vent.id}`).toBe(
          ventCardWeight(vent) * VENT_CARDS_PER_WEIGHT[id],
        );
      }
    }
  });

  it('is one additive draw call that shows the push the sim applies', () => {
    const columns = createVentColumns(
      { vents: EMBERFALL_VENTS, sky: CALDERA.sky, cloudSeaY: SEA_Y },
      QUALITY_PRESETS.medium,
    );
    const material = columns.object.material;
    expect(material.blending).toBe(AdditiveBlending);
    expect(material.depthWrite).toBe(false);
    expect(material.depthTest).toBe(true);
    expect(columns.object.frustumCulled).toBe(false);
    expect(columns.object.matrixAutoUpdate).toBe(false);
    // The streaks fade toward the top from the same height the push does.
    const card = material.uniforms['uCard']?.value as Vector4;
    expect(card.w).toBe(VENT_TUNING.fullHeightFraction);
    const main = EMBERFALL_VENTS[0];
    if (main === undefined) throw new Error('no vent');
    const at = (fraction: number): number =>
      heatVentStrength(main, {
        x: main.position.x,
        y: main.position.y + main.height * fraction,
        z: main.position.z,
      });
    expect(at(card.w)).toBe(1);
    expect(at((1 + card.w) / 2)).toBeCloseTo(0.5, 6);
    // Magenta ("fly here"), not the lava's crimson and not team Ember's orange.
    const color = material.uniforms['uColor']?.value as { r: number; g: number; b: number };
    expect(color.r).toBeGreaterThan(color.b);
    expect(color.b).toBeGreaterThan(color.g * 3);

    for (const id of QUALITY_PRESET_IDS) {
      columns.setQuality(QUALITY_PRESETS[id]);
      expect(columns.activeCount).toBe(ventCardCount(EMBERFALL_VENTS, id));
      expect(columns.object.geometry.drawRange.count).toBe(columns.activeCount * 6);
      expect(columns.object.visible).toBe(true);
    }
    columns.update(6000 * 3 + 12.5);
    expect(material.uniforms['uTime']?.value).toBeCloseTo(12.5, 6);
    columns.dispose();
  });
});

describe('ash fall', () => {
  it('is one draw call of premultiplied quads, counted per preset', () => {
    const ash = createAshFall({ sky: CALDERA.sky, cloudSeaY: SEA_Y }, QUALITY_PRESETS.low);
    const material = ash.object.material;
    expect(material.premultipliedAlpha).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(ash.object.frustumCulled).toBe(false);
    for (const id of QUALITY_PRESET_IDS) {
      ash.setQuality(QUALITY_PRESETS[id]);
      expect(ash.activeCount).toBe(ASH_FLAKE_COUNTS[id]);
      expect(ash.object.geometry.drawRange.count).toBe(ASH_FLAKE_COUNTS[id] * 6);
    }
    expect(ASH_FLAKE_COUNTS.low).toBeLessThan(ASH_FLAKE_COUNTS.medium);
    expect(ASH_FLAKE_COUNTS.medium).toBeLessThan(ASH_FLAKE_COUNTS.high);
    // the sparks thin out above this map's sea, not above y = 0
    expect((material.uniforms['uSpark']?.value as Vector4).z).toBe(SEA_Y);
    ash.update(6000 + 3);
    expect(material.uniforms['uTime']?.value).toBeCloseTo(3, 6);
    ash.dispose();
  });

  it('with the vent streaks and a 5v5 of effects stays inside the particle budget', () => {
    for (const id of QUALITY_PRESET_IDS) {
      const air = ventCardCount(EMBERFALL_VENTS, id) + ASH_FLAKE_COUNTS[id];
      // Half the budget is left for effects that the benchmark's fight did not reach.
      expect(air + EFFECT_PEAK[id], id).toBeLessThan(QUALITY_PRESETS[id].maxParticles * 0.75);
    }
  });
});

describe('the map view of a map with vents and ash', () => {
  it('builds both on the caldera, switches them with the preset and frees them', () => {
    // No renderer: the view stays on its hull stand-in, the air needs no assets.
    const view = createMapView(CALDERA, QUALITY_PRESETS.medium);
    const names = view.object.children.map((child) => child.name);
    expect(names).toContain('VentColumns');
    expect(names).toContain('AshFall');
    expect(view.stats.airParticles).toBe(
      ventCardCount(EMBERFALL_VENTS, 'medium') + ASH_FLAKE_COUNTS.medium,
    );
    view.setQuality(QUALITY_PRESETS.low);
    expect(view.stats.airParticles).toBe(ventCardCount(EMBERFALL_VENTS, 'low') + ASH_FLAKE_COUNTS.low);
    view.update({ x: 0, y: 300, z: 0 }, null, 12);
    view.dispose();
    expect(view.object.children).toHaveLength(0);
  });

  it('builds neither on the first map', () => {
    const view = createMapView(SPIRES, QUALITY_PRESETS.medium);
    const names = view.object.children.map((child) => child.name);
    expect(names).not.toContain('VentColumns');
    expect(names).not.toContain('AshFall');
    expect(view.stats.airParticles).toBe(0);
    expect(view.object.children.some((child) => child instanceof InstancedMesh)).toBe(false);
    view.dispose();
  });
});

describe('the world material on another map', () => {
  function fakeTexture(id: string): LoadedMapTexture {
    const info: MapTexture = {
      id,
      url: `textures/${id}.ktx2`,
      tileMetres: 8,
      meanLinear: [0.5, 0.5, 0.5],
      colorSpace: 'srgb',
    };
    return { info, texture: new DataTexture(new Uint8Array(4), 1, 1) };
  }
  const textures = {
    stone: fakeTexture('stone'),
    masonry: fakeTexture('masonry'),
    moss: fakeTexture('moss'),
    cliff: fakeTexture('cliff'),
    brush: fakeTexture('brush'),
  };
  const farState = new DataTexture(new Uint8Array(2), 1, 1);
  const vec = (material: { uniforms: Record<string, { value: unknown }> }, name: string): Vector4 =>
    material.uniforms[name]?.value as Vector4;

  it('without a palette is the first map: slate grade, white-hot crystals, no light from below', () => {
    const materials = createWorldMaterials(textures, farState, QUALITY_PRESETS.medium);
    expect(vec(materials.rock, 'uGrade').x).toBe(1.3);
    expect(vec(materials.rock, 'uGlow').x).toBe(1.9);
    const bounce = vec(materials.rock, 'uBounce');
    expect([bounce.x, bounce.y, bounce.z]).toEqual([0, 0, 0]);
    materials.dispose();
  });

  it('with the caldera palette: crimson light from below on every material, lava that stays crimson', () => {
    const materials = createWorldMaterials(
      textures,
      farState,
      QUALITY_PRESETS.medium,
      skyLookOf(CALDERA.sky),
    );
    for (const material of [materials.rock, materials.prop, materials.tint, materials.far]) {
      const bounce = vec(material, 'uBounce');
      expect(bounce.x).toBeGreaterThan(0);
      // crimson: far more red than green, some blue (never team Ember's orange)
      expect(bounce.y / bounce.x).toBeLessThan(0.15);
      expect(bounce.z).toBeGreaterThan(bounce.y);
      expect(bounce.w).toBeGreaterThan(0);
      expect(vec(material, 'uGrade').x).toBe(1);
      expect(vec(material, 'uGlow').x).toBe(CALDERA.sky.glowGain);
      // the shader the uniforms are for
      expect(material.fragmentShader).toContain('uBounce');
      expect(material.fragmentShader).toContain('uMarkerColor');
    }
    materials.dispose();
  });

  it('knows a flame from a "fly here" marker from a crystal', () => {
    expect(glowModeOf('brazier')).toBe(GLOW_MODE_FLAME);
    expect(glowModeOf('vent-marker')).toBe(GLOW_MODE_MARKER);
    expect(glowModeOf('crystal-core')).toBe(GLOW_MODE_CRYSTAL);
    expect(glowModeOf('crystal-cluster')).toBe(GLOW_MODE_CRYSTAL);
    expect(glowModeOf('crown-base')).toBe(GLOW_MODE_CRYSTAL);
    // lava cracks and runes keep the steady glow they had
    expect(glowModeOf('vent-chimney')).toBe(GLOW_MODE_STEADY);
    expect(glowModeOf('ash-island-small')).toBe(GLOW_MODE_STEADY);
    expect(glowModeOf('standing-stone')).toBe(GLOW_MODE_STEADY);
    // every marker the caldera places is one the field recognises
    const markers = (CALDERA.placements ?? []).filter((p) => glowModeOf(p.type) === GLOW_MODE_MARKER);
    expect(markers.length).toBeGreaterThan(0);
    // both maps float a sky-well crystal that takes the crystal look
    for (const map of [SPIRES, CALDERA]) {
      expect((map.placements ?? []).some((p) => glowModeOf(p.type) === GLOW_MODE_CRYSTAL)).toBe(true);
    }
  });

  it('shades crystals and markers as cut stones, cheaper on Low, and carves the aerie runes', () => {
    const modes = [GLOW_MODE_STEADY, GLOW_MODE_FLAME, GLOW_MODE_MARKER, GLOW_MODE_CRYSTAL, GLOW_MODE_CARVED];
    expect(modes).toEqual([0, 1, 2, 3, 4]);
    const materials = createWorldMaterials(textures, farState, QUALITY_PRESETS.low);
    const fragment = materials.rock.fragmentShader;
    // one tone per facet and the run along the length on every preset ...
    expect(fragment).toContain('gemBody');
    expect(fragment).toContain('vLift');
    // ... the slanted edge and the sun flash only behind the Medium / High switch
    const extras = fragment.slice(fragment.indexOf('float slant'), fragment.indexOf('ember = mix(ember, gemBody, gem)'));
    expect(extras).toContain('flash');
    expect(fragment.lastIndexOf('#if WM_QUALITY >= 1', fragment.indexOf('float slant'))).toBeGreaterThan(
      fragment.indexOf('vec3 gemBody'),
    );
    // the merged far meshes read their glow mode from the colour's fourth byte
    expect(materials.far.vertexShader).toContain('aColor.a * 255.0');
    expect(materials.far.vertexShader).toContain('vLift = 0.0');
    // the aerie's perch stones: carved, everything else as on a map
    expect(aerieGlowModeOf('standing-stone')).toBe(GLOW_MODE_CARVED);
    expect(aerieGlowModeOf('brazier')).toBe(GLOW_MODE_FLAME);
    expect(aerieGlowModeOf('island-large')).toBe(GLOW_MODE_STEADY);
    materials.dispose();
  });
});
