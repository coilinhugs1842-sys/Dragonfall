import type { Object3D, ShaderMaterial, SkinnedMesh, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_FLAG_ALIVE,
  NO_PLAYER,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type { DragonClassId, MutableWorldView, TeamId } from '../../src/shared';
import { createDragons } from '../../src/dragons';
import type { Dragons } from '../../src/dragons';
import { fakeDragonLibrary } from './fake-dragon';

const DT = 1 / 60;

interface Spawn {
  id: number;
  classId: DragonClassId;
  team?: TeamId;
  x?: number;
  z?: number;
  anim?: number;
  climb?: number;
}

function fill(view: MutableWorldView, dragons: readonly Spawn[], localId = NO_PLAYER): void {
  beginWorldView(view);
  view.localDragonId = localId;
  for (const spawn of dragons) {
    const slot = acquireDragonView(view);
    slot.id = spawn.id;
    slot.team = spawn.team ?? (spawn.id % 2 === 0 ? TEAM_EMBER : TEAM_FROST);
    slot.classId = spawn.classId;
    slot.position.x = spawn.x ?? 0;
    slot.position.y = 300;
    slot.position.z = spawn.z ?? 0;
    slot.orientation.x = 0;
    slot.orientation.y = 0;
    slot.orientation.z = 0;
    slot.orientation.w = 1;
    slot.velocity.x = 0;
    slot.velocity.y = (spawn.climb ?? 0) * 45;
    slot.velocity.z = 45;
    slot.health = 1;
    slot.stamina = 1;
    slot.flags = DRAGON_FLAG_ALIVE;
    slot.anim = spawn.anim ?? DRAGON_ANIM_GLIDE;
  }
}

/** Rig roots in the view (pooled or in use), by class. */
function rigRoots(dragons: Dragons, classId?: DragonClassId): Object3D[] {
  return dragons.object.children.filter((child) =>
    classId === undefined ? child.name.startsWith('dragon-') : child.name === `dragon-${classId}`,
  );
}

function shown(dragons: Dragons): number {
  return rigRoots(dragons).filter((root) => root.visible).length;
}

describe('prewarm', () => {
  it('builds one rig per listed dragon at load time, hidden and in the scene', () => {
    const library = fakeDragonLibrary();
    library.arrive('talon');
    library.arrive('wraith');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    expect(dragons.revision).toBe(0);
    expect(dragons.stats.rigs).toBe(0);

    dragons.prewarm(['talon', 'talon', 'wraith', 'talon']);
    expect(dragons.stats.rigs).toBe(4);
    expect(rigRoots(dragons, 'talon')).toHaveLength(3);
    expect(rigRoots(dragons, 'wraith')).toHaveLength(1);
    expect(rigRoots(dragons, 'bastion')).toHaveLength(0);
    // Hidden, but children of the view: a warm-up that walks the scene finds their materials.
    for (const root of rigRoots(dragons)) {
      expect(root.visible).toBe(false);
      expect(root.parent).toBe(dragons.object);
    }
    expect(dragons.revision).toBeGreaterThan(0);
    dragons.dispose();
  });

  it('never builds a rig inside update for the dragons it was told about', () => {
    const library = fakeDragonLibrary();
    for (const classId of ['talon', 'bastion', 'tempest', 'wraith'] as const) library.arrive(classId);
    const dragons = createDragons(QUALITY_PRESETS.high, { library });
    const view = createWorldView();
    // A 5v5: ids 0..9, classes mixed.
    const classes: DragonClassId[] = [
      'talon', 'talon', 'bastion', 'tempest', 'wraith',
      'talon', 'bastion', 'bastion', 'tempest', 'wraith',
    ];
    dragons.prewarm(classes);
    expect(dragons.stats.rigs).toBe(10);
    const revision = dragons.revision;

    for (let frame = 0; frame < 240; frame++) {
      // Dragons die, respawn and wander in and out of the view.
      const alive = classes
        .map((classId, id) => ({ id, classId, x: id * 12 }))
        .filter((spawn) => (frame + spawn.id * 7) % 50 > 8);
      fill(view, alive, 0);
      dragons.update(view, DT);
      expect(dragons.stats.rigs).toBe(10);
      expect(dragons.revision).toBe(revision);
    }
    expect(dragons.stats.skinned).toBeGreaterThan(0);
    dragons.dispose();
  });

  it('is cumulative: a second call raises the pool, never shrinks or rebuilds it', () => {
    const library = fakeDragonLibrary();
    library.arrive('talon');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    dragons.prewarm(['talon', 'talon']);
    const first = rigRoots(dragons, 'talon');
    const revision = dragons.revision;

    dragons.prewarm(['talon']);
    dragons.prewarm([]);
    expect(rigRoots(dragons, 'talon')).toEqual(first);
    expect(dragons.revision).toBe(revision);

    dragons.prewarm(['talon', 'talon', 'talon']);
    expect(rigRoots(dragons, 'talon')).toHaveLength(3);
    expect(rigRoots(dragons, 'talon').slice(0, 2)).toEqual(first);
    expect(dragons.revision).toBeGreaterThan(revision);
    dragons.dispose();
  });

  it('builds a class that is still loading when it arrives, between frames', () => {
    const library = fakeDragonLibrary();
    library.arrive('talon');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    dragons.prewarm(['talon', 'tempest', 'tempest']);
    expect(dragons.stats.rigs).toBe(1);
    // It waits for the loader; it does not start a second load of its own (the page's library
    // loads every class, after the map, one transcoder pool at a time).
    expect(library.loadCalls).toEqual([]);
    expect(library.listenerCount).toBe(1);

    const view = createWorldView();
    fill(view, [{ id: 0, classId: 'talon' }, { id: 1, classId: 'tempest' }]);
    for (let i = 0; i < 5; i++) dragons.update(view, DT);
    expect(dragons.stats.rigs).toBe(1);
    const revision = dragons.revision;

    library.arrive('tempest');
    // Built by the loader's continuation, not by the next update.
    expect(dragons.stats.rigs).toBe(3);
    expect(rigRoots(dragons, 'tempest')).toHaveLength(2);
    expect(dragons.revision).toBeGreaterThan(revision);
    // Nothing left to wait for.
    expect(library.listenerCount).toBe(0);

    const after = dragons.revision;
    for (let i = 0; i < 5; i++) dragons.update(view, DT);
    expect(dragons.stats.rigs).toBe(3);
    expect(dragons.revision).toBe(after);
    dragons.dispose();
  });

  it('retries a class whose load failed, and survives it failing again', () => {
    const library = fakeDragonLibrary();
    library.fail('bastion');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    dragons.prewarm(['bastion', 'talon']);
    // Only the failed class is asked for again; an idle one is left to the library.
    expect(library.loadCalls).toEqual(['bastion']);

    library.fail('bastion');
    expect(dragons.stats.rigs).toBe(0);
    const view = createWorldView();
    fill(view, [{ id: 0, classId: 'bastion' }]);
    dragons.update(view, DT);
    // The placeholder covers for it.
    expect(dragons.stats.skinned).toBe(0);
    expect(dragons.stats.dragons).toBe(1);

    library.arrive('bastion');
    expect(dragons.stats.rigs).toBe(1);
    dragons.dispose();
  });

  it('does nothing without a library or after dispose, and stops listening on dispose', () => {
    const bare = createDragons(QUALITY_PRESETS.low);
    bare.prewarm(['talon', 'wraith']);
    expect(bare.stats.rigs).toBe(0);
    expect(bare.revision).toBe(0);
    bare.dispose();

    const library = fakeDragonLibrary();
    const dragons = createDragons(QUALITY_PRESETS.low, { library });
    dragons.prewarm(['talon']);
    expect(library.listenerCount).toBe(1);
    dragons.dispose();
    expect(library.listenerCount).toBe(0);
    library.arrive('talon');
    dragons.prewarm(['talon']);
    expect(dragons.stats.rigs).toBe(0);
    expect(rigRoots(dragons)).toHaveLength(0);
  });
});

describe('revision and the warm-up frames', () => {
  it('does not draw a new class skinned until two updates after its rigs were built', () => {
    const library = fakeDragonLibrary();
    library.arrive('talon');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    const view = createWorldView();
    fill(view, [{ id: 0, classId: 'talon' }]);
    dragons.prewarm(['talon']);
    const revision = dragons.revision;

    // The frame in which whoever polls `revision` runs the warm-up.
    dragons.update(view, DT);
    expect(dragons.stats.skinned).toBe(0);
    expect(dragons.stats.dragons).toBe(1);
    expect(shown(dragons)).toBe(0);
    // From the next one on it is drawn.
    dragons.update(view, DT);
    expect(dragons.stats.skinned).toBe(1);
    expect(shown(dragons)).toBe(1);
    expect(dragons.revision).toBe(revision);
    dragons.dispose();
  });

  it('holds a late class the same way, without disturbing the ones already flying', () => {
    const library = fakeDragonLibrary();
    library.arrive('talon');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    const view = createWorldView();
    fill(view, [{ id: 0, classId: 'talon' }, { id: 1, classId: 'wraith' }]);
    dragons.prewarm(['talon', 'wraith']);
    for (let i = 0; i < 4; i++) dragons.update(view, DT);
    expect(dragons.stats.skinned).toBe(1);

    library.arrive('wraith');
    dragons.update(view, DT);
    expect(dragons.stats.skinned).toBe(1);
    dragons.update(view, DT);
    expect(dragons.stats.skinned).toBe(2);
    expect(dragons.stats.dragons).toBe(2);
    dragons.dispose();
  });

  it('the fallback: a class nobody prewarmed is built on first sight and reported', () => {
    const library = fakeDragonLibrary();
    library.arrive('tempest');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    const view = createWorldView();
    fill(view, [{ id: 4, classId: 'tempest' }]);

    dragons.update(view, DT);
    expect(dragons.stats.rigs).toBe(1);
    expect(dragons.revision).toBe(1);
    expect(dragons.stats.skinned).toBe(0);
    dragons.update(view, DT);
    expect(dragons.stats.skinned).toBe(0);
    dragons.update(view, DT);
    expect(dragons.stats.skinned).toBe(1);

    // A second dragon of the class, beyond the pool: built when needed, and reported.
    fill(view, [{ id: 4, classId: 'tempest' }, { id: 5, classId: 'tempest', x: 10 }]);
    dragons.update(view, DT);
    expect(dragons.stats.rigs).toBe(2);
    expect(dragons.revision).toBe(2);
    expect(dragons.stats.skinned).toBe(2);
    dragons.dispose();
  });

  it('goes up when the preset changes (other shader variants), not when it stays', () => {
    const library = fakeDragonLibrary();
    library.arrive('talon');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    dragons.prewarm(['talon']);
    const revision = dragons.revision;
    dragons.setQuality(QUALITY_PRESETS.medium);
    expect(dragons.revision).toBe(revision);
    dragons.setQuality(QUALITY_PRESETS.low);
    expect(dragons.revision).toBe(revision + 1);
    dragons.dispose();
  });

  it('passes the preset texture limit on to the library', () => {
    const library = fakeDragonLibrary();
    const dragons = createDragons(QUALITY_PRESETS.low, { library });
    dragons.setQuality(QUALITY_PRESETS.high);
    expect(library.textureSizes).toEqual([
      QUALITY_PRESETS.low.maxTextureSize,
      QUALITY_PRESETS.high.maxTextureSize,
    ]);
    dragons.dispose();
  });
});

describe('animation state across a short spell as the far model', () => {
  /** A flapping dragon, drawn skinned for half a second; returns the view and its phase. */
  function flying(): { dragons: Dragons; view: MutableWorldView; step: () => number } {
    const library = fakeDragonLibrary();
    library.arrive('talon');
    const dragons = createDragons(QUALITY_PRESETS.medium, { library });
    dragons.prewarm(['talon']);
    const view = createWorldView();
    fill(view, [{ id: 3, classId: 'talon', anim: DRAGON_ANIM_FLAP, climb: 0.5 }]);
    const step = (): number => {
      dragons.update(view, DT);
      return dragons.flapPhase(3);
    };
    return { dragons, view, step };
  }

  /** Phase distance on the circle. */
  function apart(a: number, b: number): number {
    const d = Math.abs(a - b) % 1;
    return Math.min(d, 1 - d);
  }

  it('carries on from where it was after a few far frames', () => {
    const { dragons, step } = flying();
    step();
    const first = step(); // the first skinned frame: the phase a fresh dragon starts with
    expect(first).toBeGreaterThanOrEqual(0);
    let phase = first;
    let perFrame = 0;
    for (let i = 0; i < 37; i++) {
      const next = step();
      perFrame = apart(next, phase);
      phase = next;
    }
    expect(perFrame).toBeGreaterThan(0);

    // Twenty frames over the skinned cap: the far model draws it.
    dragons.setDebug({ lod: 3 });
    for (let i = 0; i < 20; i++) expect(step()).toBe(-1);
    expect(dragons.stats.skinned).toBe(0);
    dragons.setDebug(null);

    const back = step();
    // One frame further than where it left off; not the phase it would restart with.
    expect(apart(back, phase)).toBeCloseTo(perFrame, 4);
    expect(apart(back, first)).toBeGreaterThan(0.05);
    dragons.dispose();
  });

  it('starts over after a long absence', () => {
    const { dragons, step } = flying();
    step();
    const first = step();
    for (let i = 0; i < 37; i++) step();

    dragons.setDebug({ lod: 3 });
    for (let i = 0; i < 150; i++) step(); // 2.5 s
    dragons.setDebug(null);
    expect(step()).toBeCloseTo(first, 5);
    dragons.dispose();
  });

  /** Local rotation of the drawn rig's head bone: where the neck's look-into-the-turn ends up. */
  function headPose(dragons: Dragons): number[] {
    const root = rigRoots(dragons).find((candidate) => candidate.visible);
    const head = root?.getObjectByName('head');
    if (head === undefined) throw new Error('no skinned dragon is drawn');
    return head.quaternion.toArray();
  }

  /** The hit-flash uniform (uFx.z) of the drawn rig. */
  function hitFlash(dragons: Dragons): number {
    const root = rigRoots(dragons).find((candidate) => candidate.visible);
    const mesh = root?.children.find(
      (child) => child.visible && (child as SkinnedMesh).isSkinnedMesh === true,
    ) as SkinnedMesh | undefined;
    if (mesh === undefined) throw new Error('no skinned dragon is drawn');
    const fx = (mesh.material as ShaderMaterial).uniforms['uFx']?.value as Vector4;
    return fx.z;
  }

  /** Half a second skinned, ten frames far (during which `change` happens), three frames back. */
  function acrossTheGap(change: (view: MutableWorldView) => void): Dragons {
    const { dragons, view, step } = flying();
    for (let i = 0; i < 30; i++) step();
    dragons.setDebug({ lod: 3 });
    for (let i = 0; i < 5; i++) step();
    change(view);
    for (let i = 0; i < 5; i++) step();
    dragons.setDebug(null);
    for (let i = 0; i < 3; i++) step();
    expect(dragons.stats.skinned).toBe(1);
    return dragons;
  }

  it('reads no turn rate out of the gap', () => {
    const steady = acrossTheGap(() => undefined);
    // It turned right round while it was the far model. Read as one frame's turn that is
    // ~190 rad/s of yaw, and the neck would swing toward its limit.
    const turned = acrossTheGap((view) => {
      const slot = view.dragons[0];
      if (slot === undefined) throw new Error('no dragon in the view');
      slot.orientation.y = 1;
      slot.orientation.w = 0;
    });
    const a = headPose(steady);
    const b = headPose(turned);
    for (let k = 0; k < 4; k++) expect(b[k]).toBeCloseTo(a[k] as number, 6);
    steady.dispose();
    turned.dispose();
  });

  it('reads a turn made while it is drawn (the check above is not blind)', () => {
    const { dragons, view, step } = flying();
    for (let i = 0; i < 30; i++) step();
    const before = headPose(dragons);
    const slot = view.dragons[0];
    if (slot === undefined) throw new Error('no dragon in the view');
    slot.orientation.y = Math.sin(0.4);
    slot.orientation.w = Math.cos(0.4);
    for (let i = 0; i < 3; i++) step();
    const after = headPose(dragons);
    let moved = 0;
    for (let k = 0; k < 4; k++) moved = Math.max(moved, Math.abs((after[k] as number) - (before[k] as number)));
    expect(moved).toBeGreaterThan(1e-3);
    dragons.dispose();
  });

  it('shows no hit flash for health lost during the gap, but does for health lost in view', () => {
    const lose = (view: MutableWorldView): void => {
      const slot = view.dragons[0];
      if (slot === undefined) throw new Error('no dragon in the view');
      slot.health = 0.4;
    };
    const gap = acrossTheGap(lose);
    expect(hitFlash(gap)).toBe(0);
    gap.dispose();

    const { dragons, view, step } = flying();
    for (let i = 0; i < 30; i++) step();
    expect(hitFlash(dragons)).toBe(0);
    lose(view);
    step();
    expect(hitFlash(dragons)).toBe(1);
    dragons.dispose();
  });
});
