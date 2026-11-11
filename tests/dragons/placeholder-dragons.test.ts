import { Matrix4, Quaternion, Vector3 } from 'three';
import type { InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DRAGON_ANIM_DIVE,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  MAX_PLAYERS,
  NO_PLAYER,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type { DragonClassId, MutableWorldView, TeamId } from '../../src/shared';
import { DRAGON_MAX_TRIANGLES, createPlaceholderDragons } from '../../src/dragons';
import type { PlaceholderDragons } from '../../src/dragons';

interface Spawn {
  id: number;
  team: TeamId;
  classId: DragonClassId;
  flags?: number;
  anim?: number;
  x?: number;
  yaw?: number;
  speed?: number;
}

function fill(view: MutableWorldView, dragons: readonly Spawn[], localId = NO_PLAYER): void {
  beginWorldView(view);
  view.localDragonId = localId;
  for (const spawn of dragons) {
    const slot = acquireDragonView(view);
    slot.id = spawn.id;
    slot.team = spawn.team;
    slot.classId = spawn.classId;
    slot.position.x = spawn.x ?? 0;
    slot.position.y = 300;
    slot.position.z = 0;
    // The sim's heading: yaw about +Y, 0 faces +Z.
    const half = (spawn.yaw ?? 0) * 0.5;
    slot.orientation.x = 0;
    slot.orientation.y = Math.sin(half);
    slot.orientation.z = 0;
    slot.orientation.w = Math.cos(half);
    slot.velocity.x = 0;
    slot.velocity.y = 0;
    slot.velocity.z = spawn.speed ?? 45;
    slot.health = 1;
    slot.stamina = 1;
    slot.flags = spawn.flags ?? DRAGON_FLAG_ALIVE;
    slot.anim = spawn.anim ?? DRAGON_ANIM_GLIDE;
  }
}

function batch(dragons: PlaceholderDragons, classId: DragonClassId): InstancedMesh {
  return dragons.object.children[DRAGON_CLASS_IDS.indexOf(classId)] as InstancedMesh;
}

function pose(mesh: InstancedMesh, slot: number): number[] {
  const attribute = mesh.geometry.getAttribute('aPose');
  return [0, 1, 2, 3].map((c) => attribute.getComponent(slot, c));
}

function accent(mesh: InstancedMesh, slot: number): number[] {
  const attribute = mesh.geometry.getAttribute('aAccent');
  return [0, 1, 2].map((c) => attribute.getComponent(slot, c));
}

describe('createPlaceholderDragons', () => {
  it('creates the whole pool up front: one instanced batch per class, one material', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.medium);
    expect(dragons.object.children.length).toBe(DRAGON_CLASS_IDS.length);
    const material = batch(dragons, 'talon').material;
    for (const classId of DRAGON_CLASS_IDS) {
      const mesh = batch(dragons, classId);
      expect(mesh.isInstancedMesh).toBe(true);
      expect(mesh.instanceMatrix.count).toBe(MAX_PLAYERS);
      expect(mesh.count).toBe(0);
      expect(mesh.visible).toBe(false);
      expect(mesh.material).toBe(material);
      expect(mesh.customDepthMaterial).toBeDefined();
      expect(mesh.geometry.getAttribute('aWing').itemSize).toBe(4);
      expect(mesh.geometry.getAttribute('position').count / 3).toBeLessThanOrEqual(
        DRAGON_MAX_TRIANGLES,
      );
    }
    dragons.dispose();
    expect(dragons.object.children.length).toBe(0);
  });

  it('poses each living dragon from the WorldView and counts per class', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.medium);
    const view = createWorldView();
    fill(view, [
      { id: 0, team: TEAM_EMBER, classId: 'talon', x: 10, yaw: Math.PI / 2 },
      { id: 1, team: TEAM_FROST, classId: 'talon', x: 20 },
      { id: 2, team: TEAM_FROST, classId: 'wraith', x: 30 },
      { id: 3, team: TEAM_EMBER, classId: 'bastion', x: 40, flags: 0 },
    ]);
    dragons.update(view, 1 / 60);

    expect(batch(dragons, 'talon').count).toBe(2);
    expect(batch(dragons, 'wraith').count).toBe(1);
    // Dead: hidden by default.
    expect(batch(dragons, 'bastion').count).toBe(0);
    expect(batch(dragons, 'bastion').visible).toBe(false);
    expect(batch(dragons, 'tempest').visible).toBe(false);
    expect(batch(dragons, 'talon').visible).toBe(true);
    expect(dragons.stats.dragons).toBe(3);
    expect(dragons.stats.drawCalls).toBe(2);
    expect(dragons.stats.triangles).toBeGreaterThan(300);
    expect(dragons.stats.triangles).toBeLessThanOrEqual(3 * DRAGON_MAX_TRIANGLES);

    // Slot 0 of the talon batch: at x = 10, yawed a quarter turn so its nose (+Z) points to +X.
    const matrix = new Matrix4();
    batch(dragons, 'talon').getMatrixAt(0, matrix);
    const nose = new Vector3(0, 0, 1).transformDirection(matrix);
    const up = new Vector3(0, 1, 0).transformDirection(matrix);
    expect(nose.x).toBeCloseTo(1, 5);
    expect(nose.z).toBeCloseTo(0, 5);
    expect(up.y).toBeCloseTo(1, 5);
    const position = new Vector3();
    matrix.decompose(position, new Quaternion(), new Vector3());
    expect(position.x).toBeCloseTo(10, 5);
    expect(position.y).toBeCloseTo(300, 5);

    // Team accent: Ember is red-dominant, Frost blue-dominant, both lit.
    const ember = accent(batch(dragons, 'talon'), 0);
    const frost = accent(batch(dragons, 'talon'), 1);
    expect(ember[0]).toBeGreaterThan(ember[2] ?? 0);
    expect(frost[2]).toBeGreaterThan(frost[0] ?? 0);
    expect(Math.max(...ember)).toBeGreaterThan(0.3);
    dragons.dispose();
  });

  it('draws dead dragons only when asked', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.medium, { showDead: true });
    const view = createWorldView();
    fill(view, [{ id: 3, team: TEAM_EMBER, classId: 'bastion', flags: 0 }]);
    dragons.update(view, 1 / 60);
    expect(batch(dragons, 'bastion').count).toBe(1);
    // Limp wings up, accent out.
    expect(pose(batch(dragons, 'bastion'), 0)[0]).toBeGreaterThan(0.5);
    expect(accent(batch(dragons, 'bastion'), 0)).toEqual([0, 0, 0]);
    dragons.dispose();
  });

  it('hides veiled enemies of the local player, dims veiled allies', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.medium);
    const view = createWorldView();
    const veiled = DRAGON_FLAG_ALIVE | DRAGON_FLAG_VEILED;
    const spawns: Spawn[] = [
      { id: 0, team: TEAM_EMBER, classId: 'talon' },
      { id: 1, team: TEAM_FROST, classId: 'wraith', flags: veiled },
      { id: 2, team: TEAM_EMBER, classId: 'wraith', flags: veiled },
    ];
    fill(view, spawns, 0);
    dragons.update(view, 1 / 60);
    expect(batch(dragons, 'wraith').count).toBe(1);
    const dim = Math.max(...accent(batch(dragons, 'wraith'), 0));
    expect(dim).toBeGreaterThan(0);
    expect(dim).toBeLessThan(Math.max(...accent(batch(dragons, 'talon'), 0)) * 0.5);

    // The explicit argument wins over view.localDragonId.
    dragons.update(view, 1 / 60, 1);
    expect(batch(dragons, 'wraith').count).toBe(1);
    expect(batch(dragons, 'talon').count).toBe(1);

    // A spectator sees everyone.
    fill(view, spawns, NO_PLAYER);
    dragons.update(view, 1 / 60);
    expect(batch(dragons, 'wraith').count).toBe(2);
    dragons.dispose();
  });

  it('blends the wing pose over time and keeps it per id when slots reshuffle', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.medium);
    const view = createWorldView();
    fill(view, [{ id: 7, team: TEAM_EMBER, classId: 'tempest', anim: DRAGON_ANIM_GLIDE }]);
    dragons.update(view, 1 / 60);
    const glideSweep = pose(batch(dragons, 'tempest'), 0)[2] ?? 0;
    expect(glideSweep).toBeLessThan(0.1);

    // Now diving, and another tempest takes WorldView slot 0.
    const diving: Spawn[] = [
      { id: 4, team: TEAM_FROST, classId: 'tempest', anim: DRAGON_ANIM_GLIDE },
      { id: 7, team: TEAM_EMBER, classId: 'tempest', anim: DRAGON_ANIM_DIVE, speed: 80 },
    ];
    fill(view, diving);
    dragons.update(view, 1 / 60);
    const first = pose(batch(dragons, 'tempest'), 1)[2] ?? 0;
    expect(first).toBeGreaterThan(glideSweep);
    expect(first).toBeLessThan(0.5);
    // The newcomer starts in its own pose, not blended from id 7's.
    expect(pose(batch(dragons, 'tempest'), 0)[2]).toBeCloseTo(glideSweep, 5);
    for (let i = 0; i < 60; i++) {
      fill(view, diving);
      dragons.update(view, 1 / 60);
    }
    expect(pose(batch(dragons, 'tempest'), 1)[2]).toBeCloseTo(1.2, 2);
    dragons.dispose();
  });

  it('beats the wings: the flap angle oscillates and survives bad frame times', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.medium);
    const view = createWorldView();
    const spawns: Spawn[] = [{ id: 2, team: TEAM_FROST, classId: 'talon', anim: DRAGON_ANIM_FLAP }];
    let min = Infinity;
    let max = -Infinity;
    for (const dt of [Number.NaN, -1, 0, 5]) {
      fill(view, spawns);
      dragons.update(view, dt);
      expect(pose(batch(dragons, 'talon'), 0).every(Number.isFinite)).toBe(true);
    }
    for (let i = 0; i < 120; i++) {
      fill(view, spawns);
      dragons.update(view, 1 / 60);
      const values = pose(batch(dragons, 'talon'), 0);
      expect(values.every(Number.isFinite)).toBe(true);
      min = Math.min(min, values[0] ?? 0);
      max = Math.max(max, values[0] ?? 0);
    }
    expect(max).toBeGreaterThan(0.6);
    expect(min).toBeLessThan(-0.5);
    dragons.dispose();
  });

  it('shimmers the accent under spawn protection', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.medium);
    const view = createWorldView();
    const spawns: Spawn[] = [
      {
        id: 5,
        team: TEAM_EMBER,
        classId: 'talon',
        flags: DRAGON_FLAG_ALIVE | DRAGON_FLAG_SPAWN_PROTECTED,
      },
    ];
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      fill(view, spawns);
      dragons.update(view, 1 / 60);
      seen.add(Math.round((accent(batch(dragons, 'talon'), 0)[0] ?? 0) * 1000));
    }
    expect(seen.size).toBeGreaterThan(5);
    dragons.dispose();
  });

  it('holds a full lobby and never overflows a batch', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.medium);
    const view = createWorldView();
    const spawns: Spawn[] = [];
    for (let id = 0; id < MAX_PLAYERS + 3; id++) {
      spawns.push({ id, team: id % 2 === 0 ? TEAM_EMBER : TEAM_FROST, classId: 'talon', x: id });
    }
    fill(view, spawns);
    dragons.update(view, 1 / 60);
    expect(batch(dragons, 'talon').count).toBe(MAX_PLAYERS);
    expect(dragons.stats.dragons).toBe(MAX_PLAYERS);
    expect(dragons.stats.drawCalls).toBe(1);
    // An empty view hides everything again.
    beginWorldView(view);
    dragons.update(view, 1 / 60);
    expect(dragons.object.children.every((child) => !child.visible)).toBe(true);
    expect(dragons.stats.dragons).toBe(0);
    dragons.dispose();
  });

  it('casts shadows only on presets that give dragons a shadow map', () => {
    const dragons = createPlaceholderDragons(QUALITY_PRESETS.low);
    expect(dragons.object.children.every((child) => !child.castShadow)).toBe(true);
    dragons.setQuality(QUALITY_PRESETS.medium);
    expect(dragons.object.children.every((child) => child.castShadow)).toBe(true);
    expect(dragons.object.children.every((child) => !child.receiveShadow)).toBe(true);
    dragons.dispose();
  });
});
