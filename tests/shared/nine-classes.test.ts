import { describe, expect, it } from 'vitest';
import {
  ABILITY_SLOTS,
  ABILITY_TABLE,
  CLASS_TUNING,
  DRAGON_CLASSES,
  DRAGON_CLASS_IDS,
  ZONE_DEFS,
  ZONE_KINDS,
  isDragonClassId,
} from '../../src/shared';
import { CAST_EFFECTS, ZONE_STYLES } from '../../src/vfx/recipes';
import { DRAGON_SHAPES } from '../../src/dragons/dragon-shapes';
import { ABILITY_GLYPHS } from '../../src/ui/hud/glyphs';
import {
  ABILITY_SOUNDS,
  CHARGE_SOUNDS,
  FLAP_PERIOD_SCALE,
  FLAP_SOUNDS,
  ROAR_SOUNDS,
  SUSTAIN_SOUNDS,
} from '../../src/audio/sound-table';
import { PERCH_SEAT_HEIGHT } from '../../src/cinematics/aerie/aerie-layout';
import { DEATH_CAM_HALF_SPAN } from '../../src/cinematics/death-cam';

describe('nine dragon classes', () => {
  it('lists nine append-only ids', () => {
    expect(DRAGON_CLASS_IDS).toEqual([
      'talon',
      'bastion',
      'tempest',
      'wraith',
      'verdant',
      'aureate',
      'zephyr',
      'granite',
      'mirage',
    ]);
    for (const id of DRAGON_CLASS_IDS) expect(isDragonClassId(id)).toBe(true);
  });

  it('has tuning, abilities, shapes, glyphs, sounds, VFX, perch and death-cam for every class', () => {
    for (const id of DRAGON_CLASS_IDS) {
      expect(DRAGON_CLASSES[id].id).toBe(id);
      expect(CLASS_TUNING[id].maxHp).toBeGreaterThan(0);
      expect(ABILITY_TABLE[id].primary.kind.length).toBeGreaterThan(0);
      expect(DRAGON_SHAPES[id].wingSpan).toBeGreaterThan(0);
      expect(ABILITY_GLYPHS[id].primary.length).toBeGreaterThan(0);
      expect(ABILITY_SOUNDS[id].primary).toBeTruthy();
      expect(FLAP_SOUNDS[id]).toBeTruthy();
      expect(ROAR_SOUNDS[id]).toBeTruthy();
      expect(FLAP_PERIOD_SCALE[id]).toBeGreaterThan(0);
      expect(SUSTAIN_SOUNDS[id] === null || typeof SUSTAIN_SOUNDS[id] === 'string').toBe(true);
      expect(CHARGE_SOUNDS[id] === null || typeof CHARGE_SOUNDS[id] === 'string').toBe(true);
      expect(CAST_EFFECTS[id].ultimate).toBeTruthy();
      expect(PERCH_SEAT_HEIGHT[id]).toBeGreaterThan(0);
      expect(DEATH_CAM_HALF_SPAN[id]).toBeGreaterThan(0);
    }
  });

  it('defines zone kinds used by the new kits', () => {
    for (const kind of [
      'updraftGarden',
      'canopy',
      'solarLattice',
      'galeWall',
      'rootSnare',
      'quakeField',
      'crater',
      'afterimage',
      'phantasm',
    ] as const) {
      expect(ZONE_KINDS).toContain(kind);
      expect(ZONE_DEFS[kind].radius).toBeGreaterThan(0);
      expect(ZONE_STYLES[kind]).toBeTruthy();
    }
  });

  it('gives every class a unique kit signature (no shared ability fingerprints)', () => {
    const fingerprints = new Set<string>();
    for (const id of DRAGON_CLASS_IDS) {
      const kit = ABILITY_TABLE[id];
      const signature = ABILITY_SLOTS.map((slot) => {
        const def = kit[slot];
        return [
          slot,
          def.kind,
          def.projectile ?? '-',
          def.zone ?? '-',
          def.selfStatus ?? '-',
          def.status ?? '-',
        ].join(':');
      }).join('|');
      expect(fingerprints.has(signature), `${id} duplicates another kit`).toBe(false);
      fingerprints.add(signature);
    }
    // Mirage must not reuse Wraith's veil / phase / blind-cone identity.
    expect(ABILITY_TABLE.mirage.secondary.selfStatus).not.toBe('veil');
    expect(ABILITY_TABLE.mirage.utility.selfStatus).not.toBe('phase');
    expect(ABILITY_TABLE.mirage.ultimate.kind).not.toBe('wave');
    // Granite must not reuse Bastion's cone / knock-wave / shield / charge-wave shape.
    expect(ABILITY_TABLE.granite.primary.kind).not.toBe('cone');
    expect(ABILITY_TABLE.granite.utility.selfStatus).not.toBe('shield');
    expect(ABILITY_TABLE.granite.ultimate.kind).toBe('zone');
    // Aureate drift haze is a zone, not Zephyr's haste slipstream.
    expect(ABILITY_TABLE.aureate.utility.selfStatus).not.toBe('haste');
    expect(ABILITY_TABLE.aureate.utility.zone).toBe('solarLattice');
    expect(ABILITY_TABLE.aureate.secondary.projectile).toBe('flashOrb');
    expect(ABILITY_TABLE.zephyr.secondary.teleportForward).toBeGreaterThan(0);
    expect(ABILITY_TABLE.mirage.secondary.projectile).toBe('mirageDecoy');
    expect(ABILITY_TABLE.verdant.secondary.projectile).toBe('rootSeed');
    expect(ABILITY_TABLE.granite.secondary.kind).toBe('wave');
    // New primaries use their own projectiles, not Talon's fireBolt.
    expect(ABILITY_TABLE.verdant.primary.projectile).toBe('bloomBolt');
    expect(ABILITY_TABLE.aureate.primary.projectile).toBe('prismShard');
    expect(ABILITY_TABLE.zephyr.primary.projectile).toBe('galeBolt');
  });
});
