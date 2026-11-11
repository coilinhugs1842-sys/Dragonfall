import { describe, expect, it } from 'vitest';
import {
  ABILITY_SLOTS,
  ABILITY_TABLE,
  DAMAGE_SOURCES,
  DRAGON_CLASS_IDS,
  PROJECTILE_KINDS,
  QUALITY_PRESETS,
  QUALITY_PRESET_IDS,
  STATUS_KINDS,
  ZONE_KINDS,
} from '../../src/shared';
import { SPRITES, SPRITE_SHADE, SPRITE_SMOKE } from '../../src/vfx/atlas';
import { VFX_QUALITY, spawnCount } from '../../src/vfx/emitter';
import type { EmitterRecipe } from '../../src/vfx/emitter';
import { COLOR_ROLE_COUNT } from '../../src/vfx/palette';
import {
  BEAM_STYLES,
  CAST_EFFECTS,
  HIT_MAX_SCALE,
  HIT_MIN_SCALE,
  PROJECTILE_SPRITES,
  PROJECTILE_TRAILS,
  RECIPES,
  SPAWN_EFFECT,
  TAKEDOWN_EFFECT,
  ZONE_STYLES,
  castEffectFor,
  hitEffectFor,
  hitScale,
  impactEffectFor,
  statusEffectFor,
} from '../../src/vfx/recipes';

const all = Object.entries(RECIPES) as [string, EmitterRecipe][];

describe('recipes', () => {
  it('are all well formed', () => {
    for (const [name, r] of all) {
      expect(r.sprite, name).toBeGreaterThanOrEqual(0);
      expect(r.sprite, name).toBeLessThan(SPRITES.length);
      expect(r.count, name).toBeGreaterThan(0);
      expect(r.minCount, name).toBeLessThanOrEqual(r.count);
      expect(r.lifeMin, name).toBeGreaterThan(0);
      expect(r.lifeMax, name).toBeGreaterThanOrEqual(r.lifeMin);
      expect(r.sizeMin, name).toBeGreaterThan(0);
      expect(r.sizeMax, name).toBeGreaterThanOrEqual(r.sizeMin);
      expect(r.speedMax, name).toBeGreaterThanOrEqual(r.speedMin);
      expect(r.additive, name).toBeGreaterThanOrEqual(0);
      expect(r.additive, name).toBeLessThanOrEqual(1);
      expect(r.opacity, name).toBeGreaterThan(0);
      expect(r.opacity, name).toBeLessThanOrEqual(1);
      // smoothstep(fadeOut, 1, u) needs fadeOut < 1.
      expect(r.fadeOut, name).toBeLessThan(1);
      expect(r.fadeIn, name).toBeLessThan(1);
      expect(r.colorStart, name).toBeLessThan(COLOR_ROLE_COUNT);
      expect(r.colorEnd, name).toBeLessThan(COLOR_ROLE_COUNT);
      expect(r.aspect, name).toBeGreaterThan(0);
    }
  });

  it('keep effects short: nothing lives longer than 2.5 s', () => {
    for (const [name, r] of all) expect(r.lifeMax, name).toBeLessThanOrEqual(2.5);
  });

  it('only smoke and shade are alpha-blended, and those never glow', () => {
    for (const [name, r] of all) {
      const dark = r.sprite === SPRITE_SMOKE || r.sprite === SPRITE_SHADE;
      if (dark) expect(r.additive, name).toBe(0);
      else expect(r.additive, name).toBeGreaterThan(0);
    }
  });

  it('bursts stay small: no single burst is more than 30 particles at High', () => {
    for (const [name, r] of all) {
      // Streams are per second; they are bounded by the steady-state check below.
      if (r.minCount > 0) expect(r.count, name).toBeLessThanOrEqual(30);
    }
  });
});

describe('cast effects', () => {
  it('every ability of every class has an effect', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        const effect = castEffectFor(classId, slot);
        expect(effect, `${classId}.${slot}`).toBe(CAST_EFFECTS[classId][slot]);
        expect(effect.bursts.length, `${classId}.${slot}`).toBeGreaterThan(0);
        for (const recipe of effect.bursts) expect(recipe).toBeDefined();
      }
    }
  });

  it('beams belong to beam abilities, with a range to draw them to', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        const effect = castEffectFor(classId, slot);
        const def = ABILITY_TABLE[classId][slot];
        expect(effect.beam !== null, `${classId}.${slot}`).toBe(def.kind === 'beam');
        if (effect.beam !== null) expect(def.range).toBeGreaterThan(0);
      }
    }
    expect(castEffectFor('tempest', 'primary').beam).toBe(BEAM_STYLES.lance);
  });

  it('each class breathes with its own sprite', () => {
    const lead = (classId: (typeof DRAGON_CLASS_IDS)[number]): string =>
      SPRITES[castEffectFor(classId, 'primary').bursts[0]?.sprite ?? -1] ?? '';
    expect(lead('talon')).toBe('shard');
    expect(lead('bastion')).toBe('wisp');
    expect(lead('tempest')).toBe('dot');
    expect(SPRITES[RECIPES.lanceMuzzle.sprite]).toBe('flake');
    expect(SPRITES[RECIPES.flameCone.sprite]).toBe('wisp');
    expect(SPRITES[RECIPES.shadeBreath.sprite]).toBe('shade');
  });

  it('abilities that act around the dragon are centred on it', () => {
    expect(castEffectFor('bastion', 'ultimate').centred).toBe(true);
    expect(castEffectFor('talon', 'secondary').centred).toBe(true);
    expect(castEffectFor('talon', 'primary').centred).toBe(false);
    expect(castEffectFor('wraith', 'ultimate').centred).toBe(false);
  });
});

describe('event effects', () => {
  it('hits take their shape from the source and the attacker', () => {
    expect(hitEffectFor('terrain', null)).toContain(RECIPES.terrainDust);
    expect(hitEffectFor('storm', null)).toContain(RECIPES.stormBite);
    // The environment wins over whoever is credited.
    expect(hitEffectFor('storm', 'tempest')).toContain(RECIPES.stormBite);
    expect(hitEffectFor('primary', 'tempest')).toContain(RECIPES.zapFlakes);
    expect(hitEffectFor('primary', 'wraith')).toContain(RECIPES.blindShade);
    expect(hitEffectFor('primary', 'talon')).toContain(RECIPES.hitSparks);
    expect(hitEffectFor('primary', null)).toContain(RECIPES.hitSparks);
    for (const source of DAMAGE_SOURCES) {
      for (const classId of [...DRAGON_CLASS_IDS, null]) {
        expect(hitEffectFor(source, classId).length).toBeGreaterThan(0);
      }
    }
  });

  it('hit size follows the damage inside its bounds', () => {
    expect(hitScale(0)).toBe(HIT_MIN_SCALE);
    expect(hitScale(20)).toBe(1);
    expect(hitScale(1000)).toBe(HIT_MAX_SCALE);
    expect(hitScale(4)).toBeLessThan(hitScale(9));
    expect(hitScale(9)).toBeLessThan(hitScale(42));
  });

  it('every projectile kind has an impact and a picture', () => {
    for (const kind of PROJECTILE_KINDS) {
      expect(impactEffectFor(kind).length, kind).toBeGreaterThan(0);
      expect(PROJECTILE_SPRITES[kind].length, kind).toBeGreaterThan(0);
      expect(PROJECTILE_TRAILS[kind], kind).toBeDefined();
      for (const sprite of PROJECTILE_SPRITES[kind]) {
        expect(sprite.sprite).toBeLessThan(SPRITES.length);
        expect(sprite.size).toBeGreaterThan(0);
      }
    }
    expect(impactEffectFor('meteorBomb')).toContain(RECIPES.blastFlash);
    expect(impactEffectFor('staticMine')).toContain(RECIPES.mineRing);
  });

  it('a fire bolt has a ribbon that trails behind its head', () => {
    const ribbon = PROJECTILE_SPRITES.fireBolt[0];
    expect(ribbon?.length).toBeGreaterThan((ribbon?.size ?? 0) * 4);
    expect(ribbon?.anchor).toBeGreaterThan(0.5);
  });

  it('every status and zone kind is mapped', () => {
    for (const status of STATUS_KINDS) expect(statusEffectFor(status)).toBeDefined();
    expect(statusEffectFor('burn').length).toBeGreaterThan(0);
    expect(statusEffectFor('slow').length).toBeGreaterThan(0);
    expect(statusEffectFor('blind').length).toBeGreaterThan(0);
    // Self-buffs are covered by their cast effect.
    expect(statusEffectFor('shield').length).toBe(0);
    for (const kind of ZONE_KINDS) expect(ZONE_STYLES[kind], kind).toBeDefined();
    for (const kind of ['thunderhead', 'staticField', 'burnTrail', 'rallyAura'] as const) {
      expect(ZONE_STYLES[kind].interior.length, kind).toBeGreaterThan(0);
    }
    // The world and the modes draw these.
    expect(ZONE_STYLES.stormWall.shell).toBe(0);
    expect(ZONE_STYLES.controlZone.interior.length).toBe(0);
  });

  it('takedowns are the biggest burst, with embers that fall', () => {
    expect(TAKEDOWN_EFFECT).toContain(RECIPES.takedownEmbers);
    expect(RECIPES.takedownEmbers.gravity).toBeGreaterThan(0);
    expect(RECIPES.takedownEmbers.lifeMax).toBeGreaterThan(1.5);
    expect(SPAWN_EFFECT).toContain(RECIPES.spawnRing);
    const size = (list: readonly EmitterRecipe[]): number =>
      list.reduce((sum, r) => sum + r.count, 0);
    expect(size(TAKEDOWN_EFFECT)).toBeGreaterThan(size(hitEffectFor('primary', 'talon')) * 4);
  });
});

describe('budget per preset', () => {
  /** Particles alive in the steady state of a stream. */
  const steady = (r: EmitterRecipe, scale: number): number =>
    r.count * scale * ((r.lifeMin + r.lifeMax) / 2);
  const burstCount = (list: readonly EmitterRecipe[], scale: number): number =>
    list.reduce((sum, r) => sum + spawnCount(r.count, scale, 0, r.minCount, 0.5), 0);

  it('expands the same effect to fewer particles on weaker presets', () => {
    const counts = QUALITY_PRESET_IDS.map((id) =>
      burstCount(TAKEDOWN_EFFECT, VFX_QUALITY[id].countScale),
    );
    expect(counts[0]).toBeLessThan(counts[1] ?? 0);
    expect(counts[1]).toBeLessThan(counts[2] ?? 0);
    // The effect never disappears: every piece with a minimum is still there on Low.
    for (const r of TAKEDOWN_EFFECT) {
      expect(
        spawnCount(r.count, VFX_QUALITY.low.countScale, 1, r.minCount, 0),
      ).toBeGreaterThanOrEqual(r.minCount);
    }
  });

  it('ten dragons breathing at once use well under half of each preset cap', () => {
    for (const id of QUALITY_PRESET_IDS) {
      const scale = VFX_QUALITY[id].countScale;
      const bastion = steady(RECIPES.flameCone, scale) + steady(RECIPES.flameConeSparks, scale);
      const wraith = steady(RECIPES.shadeBreath, scale) + steady(RECIPES.shadeGlints, scale);
      const heaviest = Math.max(bastion, wraith);
      expect(heaviest * 10, id).toBeLessThan(QUALITY_PRESETS[id].maxParticles * 0.5);
    }
  });

  it('a 5v5 worth of takedowns at the same instant still fits the Low cap', () => {
    const low = burstCount(TAKEDOWN_EFFECT, VFX_QUALITY.low.countScale);
    expect(low * 10).toBeLessThan(QUALITY_PRESETS.low.maxParticles);
  });
});
