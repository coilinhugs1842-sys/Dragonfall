/**
 * The friend-or-foe markers over the dragons (T-6.6): the projection (against three.js's own),
 * the rules for who gets a marker (`dragon-tags.ts`), and the markers on the fake page: placed
 * by `transform` alone, hidden when unused, nothing written on a frame where nothing moved.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  HUD_DRAGON_TAGS,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type { HudState, MatchPhase, MutableWorldView, TeamId, TerrainQuery } from '../../src/shared';
import { createDragonTagWriter, createHud, createHudState } from '../../src/ui/hud';
import type { DragonTagFrame, Hud, MutableHudDragonTag, MutableHudState } from '../../src/ui/hud';
import { TEAM_SHAPES } from '../../src/ui/hud/glyphs';
import {
  TAG_POSITION_PAD,
  TAG_TUNING,
  TAG_X_STRINGS,
  TAG_Y_STRINGS,
  createScreenPoint,
  foeOpacity,
  foeRangeM,
  mateOpacity,
  projectPoint,
  tagLarge,
  tagLiftM,
  tagPositionStep,
} from '../../src/ui/hud/tag-model';
import { FakeElement, createUiRoot, installFakeDom, resetWrites, writeCount } from './fake-dom';

/** A camera at `from` looking at `to`, with its matrices up to date. */
function cameraAt(
  from: [number, number, number],
  to: [number, number, number],
  aspect = 16 / 9,
): PerspectiveCamera {
  const camera = new PerspectiveCamera(70, aspect, 0.5, 5000);
  camera.position.set(...from);
  camera.lookAt(...to);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

describe('marker projection (tag-model)', () => {
  it('lands where three.js projects the same point', () => {
    const camera = cameraAt([40, 320, -90], [10, 300, 200]);
    const out = createScreenPoint();
    const points: [number, number, number][] = [
      [10, 300, 200],
      [-60, 340, 150],
      [120, 250, 400],
      [0, 310, 30],
    ];
    for (const [x, y, z] of points) {
      const expected = new Vector3(x, y, z).project(camera);
      projectPoint(out, camera.matrixWorld.elements, camera.projectionMatrix.elements, x, y, z);
      expect(out.x).toBeCloseTo(expected.x * 0.5 + 0.5, 5);
      expect(out.y).toBeCloseTo(0.5 - expected.y * 0.5, 5);
      expect(out.distance).toBeCloseTo(camera.position.distanceTo(new Vector3(x, y, z)), 4);
    }
  });

  it('puts the point looked at in the middle, and up is up', () => {
    const camera = cameraAt([0, 300, 0], [0, 300, 100]);
    const world = camera.matrixWorld.elements;
    const projection = camera.projectionMatrix.elements;
    const out = createScreenPoint();
    expect(projectPoint(out, world, projection, 0, 300, 100)).toBe(true);
    expect(out.x).toBeCloseTo(0.5, 6);
    expect(out.y).toBeCloseTo(0.5, 6);
    expect(out.depth).toBeCloseTo(100, 4);
    expect(out.centre2).toBeCloseTo(0, 6);
    // Higher in the world is nearer the top of the picture (a smaller y).
    projectPoint(out, world, projection, 0, 320, 100);
    expect(out.y).toBeLessThan(0.5);
    // Looking along +Z, +X is on the left of the picture.
    projectPoint(out, world, projection, 20, 300, 100);
    expect(out.x).toBeLessThan(0.5);
  });

  it('gives nothing behind the camera, too close to the lens or outside the picture', () => {
    const camera = cameraAt([0, 300, 0], [0, 300, 100]);
    const world = camera.matrixWorld.elements;
    const projection = camera.projectionMatrix.elements;
    const out = createScreenPoint();
    // Behind: a naive divide would mirror it back into the picture.
    expect(projectPoint(out, world, projection, 0, 300, -100)).toBe(false);
    expect(out.depth).toBeLessThan(0);
    expect(projectPoint(out, world, projection, 0, 300, TAG_TUNING.minDepthM - 0.5)).toBe(false);
    // Far off to the side and far above.
    expect(projectPoint(out, world, projection, 400, 300, 100)).toBe(false);
    expect(projectPoint(out, world, projection, 0, 700, 100)).toBe(false);
    // Just past the edge still counts (the marker slides out), a little further does not.
    const halfWidth = 100 * Math.tan((35 * Math.PI) / 180) * (16 / 9);
    expect(projectPoint(out, world, projection, -halfWidth * 1.02, 300, 100)).toBe(true);
    expect(out.x).toBeGreaterThan(1);
    expect(projectPoint(out, world, projection, -halfWidth * 1.06, 300, 100)).toBe(false);
  });

  it('measures "aimed at" in half picture heights whatever the picture\'s shape', () => {
    const out = createScreenPoint();
    for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      const camera = cameraAt([0, 300, 0], [0, 300, 100], aspect);
      const halfHeight = 100 * Math.tan((35 * Math.PI) / 180);
      projectPoint(
        out,
        camera.matrixWorld.elements,
        camera.projectionMatrix.elements,
        halfHeight * 0.5,
        300,
        100,
      );
      expect(Math.sqrt(out.centre2)).toBeCloseTo(0.5, 5);
      projectPoint(
        out,
        camera.matrixWorld.elements,
        camera.projectionMatrix.elements,
        0,
        300 + halfHeight * 0.25,
        100,
      );
      expect(Math.sqrt(out.centre2)).toBeCloseTo(0.25, 5);
    }
  });
});

describe('marker sizes and fades (tag-model)', () => {
  it('is large when near or aimed at, and does not flicker at the boundary', () => {
    const far2 = 0.6 * 0.6;
    expect(tagLarge(TAG_TUNING.nearInM - 1, far2, false)).toBe(true);
    expect(tagLarge(TAG_TUNING.nearInM + 1, far2, false)).toBe(false);
    // Once large it stays large a little further out.
    expect(tagLarge(TAG_TUNING.nearInM + 1, far2, true)).toBe(true);
    expect(tagLarge(TAG_TUNING.nearOutM + 1, far2, true)).toBe(false);
    // Far away but under the middle of the picture.
    const aimed = (TAG_TUNING.aimIn * 0.9) ** 2;
    expect(tagLarge(900, aimed, false)).toBe(true);
    const between = ((TAG_TUNING.aimIn + TAG_TUNING.aimOut) / 2) ** 2;
    expect(tagLarge(900, between, false)).toBe(false);
    expect(tagLarge(900, between, true)).toBe(true);
  });

  it('stands five metres over a dragon, lower over one close to the camera', () => {
    expect(tagLiftM(400)).toBe(TAG_TUNING.liftM);
    expect(tagLiftM(TAG_TUNING.liftM / TAG_TUNING.liftPerM + 1)).toBe(TAG_TUNING.liftM);
    expect(tagLiftM(10)).toBeCloseTo(10 * TAG_TUNING.liftPerM, 6);
    expect(tagLiftM(10)).toBeLessThan(TAG_TUNING.liftM);
    expect(tagLiftM(0)).toBe(0);
    expect(tagLiftM(Number.NaN)).toBe(TAG_TUNING.liftM);
  });

  it('marks enemies only inside their range, fading out at its end', () => {
    const range = foeRangeM(true);
    expect(range).toBe(TAG_TUNING.foeRangeM);
    expect(foeOpacity(100, range)).toBe(1);
    expect(foeOpacity(range - TAG_TUNING.foeFadeM, range)).toBe(1);
    expect(foeOpacity(range - TAG_TUNING.foeFadeM / 2, range)).toBeCloseTo(0.5, 6);
    expect(foeOpacity(range, range)).toBe(0);
    expect(foeOpacity(range + 200, range)).toBe(0);
    expect(foeOpacity(Number.NaN, range)).toBe(0);
    // Nothing to test the sight line with: a much shorter range.
    expect(foeRangeM(false)).toBe(TAG_TUNING.foeBlindRangeM);
    expect(foeRangeM(false)).toBeLessThan(TAG_TUNING.nearInM);
    expect(mateOpacity(true)).toBe(1);
    expect(mateOpacity(false)).toBeGreaterThan(0.5);
  });

  it('turns picture fractions into table steps, with room past the edges', () => {
    expect(tagPositionStep(0)).toBe(TAG_POSITION_PAD);
    // x is a `translate` value, y a `transform` value: two properties of one node.
    expect(TAG_X_STRINGS[tagPositionStep(0)]).toBe('0cqw');
    expect(TAG_X_STRINGS[tagPositionStep(0.5)]).toBe('50cqw');
    expect(TAG_Y_STRINGS[tagPositionStep(1)]).toBe('translate3d(0,100cqh,0)');
    expect(TAG_Y_STRINGS[tagPositionStep(0.25)]).toBe('translate3d(0,25cqh,0)');
    expect(TAG_X_STRINGS[tagPositionStep(-0.01)]).toBe('-1cqw');
    // Whatever arrives, the step is in the table.
    for (const value of [-5, 9, Number.NaN, Infinity, -Infinity]) {
      expect(TAG_X_STRINGS[tagPositionStep(value)]).toBeTypeOf('string');
    }
  });
});

// --- The rules ----------------------------------------------------------------------------------------

const ME = 1;
const MATE = 2;
const FAR_MATE = 3;
const FOE = 6;
const FAR_FOE = 7;

interface Rider {
  id: number;
  team: TeamId;
  x: number;
  y: number;
  z: number;
  flags: number;
}

/** The camera sits 14 m behind and 4 m above the local dragon, looking along +Z. */
function riders(): Rider[] {
  const alive = DRAGON_FLAG_ALIVE;
  return [
    { id: ME, team: TEAM_EMBER, x: 0, y: 300, z: 0, flags: alive },
    { id: MATE, team: TEAM_EMBER, x: -30, y: 300, z: 90, flags: alive },
    { id: FAR_MATE, team: TEAM_EMBER, x: 200, y: 330, z: 700, flags: alive },
    { id: FOE, team: TEAM_FROST, x: 25, y: 310, z: 150, flags: alive },
    { id: FAR_FOE, team: TEAM_FROST, x: -150, y: 320, z: 360, flags: alive },
  ];
}

const NAMES: string[] = [];
NAMES[ME] = 'Aman';
NAMES[MATE] = 'Miro';
NAMES[FAR_MATE] = 'Juno';
NAMES[FOE] = 'Kestrel';
NAMES[FAR_FOE] = 'Ashka';

/** Rock nowhere, or rock in front of the listed positions (matched by the ray's direction). */
function terrainHiding(hidden: () => readonly Rider[]): TerrainQuery & { rays: number } {
  const terrain = {
    rays: 0,
    raycast(
      ox: number,
      oy: number,
      oz: number,
      dx: number,
      dy: number,
      dz: number,
      maxDistance: number,
    ): number {
      terrain.rays++;
      for (const rider of hidden()) {
        const tx = rider.x - ox;
        const ty = rider.y - oy;
        const tz = rider.z - oz;
        const same = Math.abs(tx - dx) + Math.abs(ty - dy) + Math.abs(tz - dz) < 1e-6;
        if (same) return Math.min(maxDistance, 40);
      }
      return -1;
    },
    clearance(): number {
      return -1;
    },
  };
  return terrain;
}

interface TagScene {
  view: MutableWorldView;
  tags: MutableHudDragonTag[];
  frame: DragonTagFrame;
  list: Rider[];
  /** Runs `count` frames and returns the tag of a rider (undefined: none in the pool). */
  run(count?: number): void;
  tagOf(id: number): MutableHudDragonTag | undefined;
  shownIds(): number[];
}

function tagScene(phase: MatchPhase = 'playing'): TagScene {
  const view = createWorldView();
  const camera = cameraAt([0, 304, -14], [0, 302, 100]);
  const writer = createDragonTagWriter();
  const tags = createHudState().dragonTags;
  const list = riders();
  const frame: DragonTagFrame = {
    cameraWorld: camera.matrixWorld.elements,
    cameraProjection: camera.projectionMatrix.elements,
    terrain: terrainHiding(() => []),
    viewer: TEAM_EMBER,
    localId: ME,
    watchedId: ME,
    blinded: false,
  };
  const build = (): void => {
    beginWorldView(view);
    view.localDragonId = ME;
    view.clock.phase = phase;
    for (const rider of list) {
      const dragon = acquireDragonView(view);
      dragon.id = rider.id;
      dragon.team = rider.team;
      dragon.classId = 'talon';
      dragon.position.x = rider.x;
      dragon.position.y = rider.y;
      dragon.position.z = rider.z;
      dragon.flags = rider.flags;
    }
  };
  const slotOf = (id: number): number => list.findIndex((rider) => rider.id === id);
  return {
    view,
    tags,
    frame,
    list,
    run(count = 3): void {
      for (let i = 0; i < count; i++) {
        build();
        writer.write(tags, view, frame, NAMES);
      }
    },
    tagOf(id: number): MutableHudDragonTag | undefined {
      const tag = tags[slotOf(id)];
      return tag !== undefined && tag.shown ? tag : undefined;
    },
    shownIds(): number[] {
      return list.filter((rider) => tags[slotOf(rider.id)]?.shown === true).map((rider) => rider.id);
    },
  };
}

function rider(scene: TagScene, id: number): Rider {
  const found = scene.list.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no rider ${id}`);
  return found;
}

describe('who gets a marker (dragon-tags)', () => {
  it('has one pooled tag per dragon of a full room', () => {
    expect(createHudState().dragonTags).toHaveLength(HUD_DRAGON_TAGS);
    expect(HUD_DRAGON_TAGS).toBeGreaterThanOrEqual(9);
  });

  it('marks team mates with their name when near and with a small shape when far', () => {
    const s = tagScene();
    s.run();
    expect(s.tagOf(ME)).toBeUndefined();
    expect(s.tagOf(MATE)).toMatchObject({
      team: TEAM_EMBER,
      foe: false,
      near: true,
      name: 'Miro',
      opacity: 1,
    });
    // 700 m away: far beyond any range an enemy would be marked at, still marked.
    const far = s.tagOf(FAR_MATE);
    expect(far).toMatchObject({ team: TEAM_EMBER, foe: false, near: false, name: '' });
    expect(far?.opacity).toBe(TAG_TUNING.farOpacity);
    // The marker stands over the dragon: above its projected centre, same column.
    const mate = s.tagOf(MATE);
    expect(mate?.x).toBeGreaterThan(0.5);
    expect(mate?.y).toBeLessThan(0.52);
  });

  it('still marks a team mate who flies between the camera and the local dragon', () => {
    // 4 m in front of the lens: five metres over that dragon would be far out of the top of the
    // picture (and it was: such a team mate had no marker), so the marker comes down to its back.
    const s = tagScene();
    const mate = rider(s, MATE);
    mate.x = 0.5;
    mate.y = 303;
    mate.z = -10;
    s.run();
    const tag = s.tagOf(MATE);
    expect(tag).toMatchObject({ foe: false, near: true, name: 'Miro' });
    expect(tag?.y).toBeGreaterThan(0.3);
    expect(tag?.y).toBeLessThan(0.7);
  });

  it('names a far team mate while it is aimed at', () => {
    const s = tagScene();
    const far = rider(s, FAR_MATE);
    far.x = 0;
    far.y = 302;
    s.run();
    expect(s.tagOf(FAR_MATE)).toMatchObject({ near: true, name: 'Juno' });
  });

  it('marks enemies in range by shape only, never by name', () => {
    const s = tagScene();
    s.run();
    expect(s.tagOf(FOE)).toMatchObject({ team: TEAM_FROST, foe: true, near: true, name: '' });
    expect(s.tagOf(FAR_FOE)).toMatchObject({ team: TEAM_FROST, foe: true, near: false, name: '' });
    // Aimed at: larger, still unnamed.
    const foe = rider(s, FAR_FOE);
    foe.x = 0;
    foe.y = 302;
    s.run();
    expect(s.tagOf(FAR_FOE)).toMatchObject({ foe: true, near: true, name: '' });
  });

  it('does not mark an enemy beyond its range, and fades the marker out towards it', () => {
    const s = tagScene();
    const foe = rider(s, FAR_FOE);
    foe.x = 0;
    foe.y = 330;
    foe.z = TAG_TUNING.foeRangeM + 40;
    s.run();
    expect(s.tagOf(FAR_FOE)).toBeUndefined();
    foe.z = TAG_TUNING.foeRangeM - 50;
    s.run();
    const opacity = s.tagOf(FAR_FOE)?.opacity ?? 0;
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
  });

  it('never marks a veiled enemy, and still marks a veiled team mate', () => {
    const s = tagScene();
    rider(s, FOE).flags |= DRAGON_FLAG_VEILED;
    rider(s, MATE).flags |= DRAGON_FLAG_VEILED;
    s.run(40);
    expect(s.tagOf(FOE)).toBeUndefined();
    expect(s.tagOf(MATE)).toMatchObject({ foe: false, name: 'Miro' });
    // The veil drops: marked again.
    rider(s, FOE).flags = DRAGON_FLAG_ALIVE;
    s.run();
    expect(s.tagOf(FOE)).toBeDefined();
  });

  it('does not mark an enemy behind rock, and does mark a team mate there', () => {
    const s = tagScene();
    let hidden: Rider[] = [rider(s, FOE), rider(s, MATE)];
    s.frame.terrain = terrainHiding(() => hidden);
    s.run(6);
    expect(s.tagOf(FOE)).toBeUndefined();
    expect(s.tagOf(FAR_FOE)).toBeDefined();
    expect(s.tagOf(MATE)).toBeDefined();
    // It flies out from behind the rock: marked within a few frames.
    hidden = [];
    s.run(4);
    expect(s.tagOf(FOE)).toBeDefined();
    // And back behind it: gone again as quickly.
    hidden = [rider(s, FOE)];
    s.run(4);
    expect(s.tagOf(FOE)).toBeUndefined();
  });

  it('waits for a sight line before marking an enemy, and tests few per frame', () => {
    const s = tagScene();
    const terrain = terrainHiding(() => []);
    s.frame.terrain = terrain;
    // Frame one: nothing is known about either enemy yet.
    s.run(1);
    expect(s.tagOf(FOE)).toBeUndefined();
    expect(s.tagOf(FAR_FOE)).toBeUndefined();
    expect(s.tagOf(MATE)).toBeDefined();
    expect(terrain.rays).toBe(2);
    s.run(1);
    expect(s.shownIds()).toEqual([MATE, FAR_MATE, FOE, FAR_FOE]);
    // Never more than the budget, however many enemies are in the picture.
    for (let i = 0; i < 4; i++) {
      s.list.push({
        id: 20 + i,
        team: TEAM_FROST,
        x: -40 + i * 25,
        y: 320,
        z: 220,
        flags: DRAGON_FLAG_ALIVE,
      });
    }
    terrain.rays = 0;
    s.run(10);
    expect(terrain.rays).toBe(10 * TAG_TUNING.sightChecksPerFrame);
    expect(s.shownIds()).toHaveLength(8);
    // Team mates cost no rays at all.
    s.frame.viewer = 'spectator';
    terrain.rays = 0;
    s.run(5);
    expect(terrain.rays).toBe(0);
  });

  it('marks enemies only close by when there is no terrain to test against', () => {
    const s = tagScene();
    s.frame.terrain = null;
    s.run();
    // 150 m and 390 m away.
    expect(s.tagOf(FOE)).toBeUndefined();
    expect(s.tagOf(FAR_FOE)).toBeUndefined();
    const foe = rider(s, FOE);
    foe.z = 90;
    s.run();
    expect(s.tagOf(FOE)).toMatchObject({ foe: true, name: '' });
    expect(s.tagOf(FAR_MATE)).toBeDefined();
  });

  it('gives the dead, the local dragon, the watched dragon and anything off screen nothing', () => {
    const s = tagScene();
    rider(s, MATE).flags = 0;
    const foe = rider(s, FOE);
    foe.z = -200;
    const far = rider(s, FAR_MATE);
    far.x = 2000;
    s.run();
    expect(s.shownIds()).toEqual([FAR_FOE]);
    // Down and watching the dragon that got the takedown: that one carries no marker either.
    s.frame.watchedId = FAR_FOE;
    s.run();
    expect(s.shownIds()).toEqual([]);
  });

  it('shows nothing outside play, while blinded, or without a camera or a known side', () => {
    for (const phase of ['intro', 'countdown', 'roundEnd', 'results', 'lobby'] as const) {
      const s = tagScene(phase);
      s.run();
      expect(s.shownIds()).toEqual([]);
    }
    const s = tagScene();
    s.run();
    expect(s.shownIds()).not.toEqual([]);
    s.frame.blinded = true;
    s.run();
    expect(s.shownIds()).toEqual([]);
    s.frame.blinded = false;
    s.frame.viewer = null;
    s.run();
    expect(s.shownIds()).toEqual([]);
    s.frame.viewer = TEAM_EMBER;
    s.frame.cameraWorld = [];
    s.run();
    expect(s.shownIds()).toEqual([]);
  });

  it('shows a spectator both teams, named like team mates', () => {
    const s = tagScene();
    s.frame.viewer = 'spectator';
    s.frame.localId = NO_PLAYER;
    s.frame.watchedId = ME;
    rider(s, FOE).flags |= DRAGON_FLAG_VEILED;
    s.run();
    expect(s.shownIds()).toEqual([MATE, FAR_MATE, FOE, FAR_FOE]);
    expect(s.tagOf(FOE)).toMatchObject({ team: TEAM_FROST, foe: false, near: true, name: 'Kestrel' });
    expect(s.tagOf(MATE)).toMatchObject({ team: TEAM_EMBER, foe: false, name: 'Miro' });
    // A free camera (nobody watched): the dragon it was on is marked too.
    s.frame.watchedId = NO_PLAYER;
    s.run();
    expect(s.shownIds()).toEqual([ME, MATE, FAR_MATE, FOE, FAR_FOE]);
  });

  it('clears the tags of dragons that left the picture', () => {
    const s = tagScene();
    s.run();
    expect(s.shownIds()).toHaveLength(4);
    s.list.length = 2;
    s.run();
    expect(s.tags.filter((tag) => tag.shown)).toHaveLength(1);
  });
});

// --- On the page ----------------------------------------------------------------------------------------

describe('markers on the HUD (tags-hud)', () => {
  let uninstall: () => void = () => {};
  let root: FakeElement;
  let hud: Hud;
  let state: MutableHudState;
  let nowMs = 0;
  // The HUD hides with the `hidden` ATTRIBUTE; the fake page only models the property.
  let hiddenNodes = new WeakSet<FakeElement>();
  const realSet = FakeElement.prototype.setAttribute;
  const realRemove = FakeElement.prototype.removeAttribute;

  const columns = (): FakeElement[] => root.querySelectorAll('.dfh-tag');
  const draw = (advanceMs = 16): void => {
    nowMs += advanceMs;
    hud.update(state as HudState, nowMs);
  };
  const place = (
    index: number,
    change: Partial<MutableHudDragonTag>,
  ): MutableHudDragonTag => {
    const tag = state.dragonTags[index];
    if (tag === undefined) throw new Error('no such tag');
    Object.assign(tag, { shown: true, opacity: 1 }, change);
    return tag;
  };

  beforeEach(() => {
    uninstall = installFakeDom();
    hiddenNodes = new WeakSet();
    FakeElement.prototype.setAttribute = function (name: string, value: string): void {
      if (name === 'hidden') hiddenNodes.add(this);
      realSet.call(this, name, value);
    };
    FakeElement.prototype.removeAttribute = function (name: string): void {
      if (name === 'hidden') hiddenNodes.delete(this);
      realRemove.call(this, name);
    };
    const page = createUiRoot();
    root = page.fake;
    hud = createHud(page.element, { listenForTab: false });
    nowMs = 1000;
    state = createHudState();
    state.phase = 'playing';
    state.localPlayerId = 1;
    state.local = state.localPool;
  });

  afterEach(() => {
    hud.dispose();
    FakeElement.prototype.setAttribute = realSet;
    FakeElement.prototype.removeAttribute = realRemove;
    uninstall();
  });

  it('is a fixed pool under everything else, hidden while unused', () => {
    draw();
    expect(columns()).toHaveLength(HUD_DRAGON_TAGS);
    expect(columns().every((node) => hiddenNodes.has(node))).toBe(true);
    // The first child of the HUD: every panel and veil is drawn over the markers.
    const layer = root.querySelector('.dfh-tags');
    expect(layer?.parentElement?.childNodes[0]).toBe(layer);
  });

  it('draws a team mate: shape, colour key, name, placed by transform', () => {
    place(0, { team: TEAM_EMBER, foe: false, near: true, name: 'Miro', x: 0.25, y: 0.4 });
    draw();
    const column = columns()[0];
    if (column === undefined) throw new Error('no column');
    expect(hiddenNodes.has(column)).toBe(false);
    expect(column.style.getPropertyValue('translate')).toBe('25cqw');
    expect(column.style.getPropertyValue('transform')).toBe('translate3d(0,40cqh,0)');
    const body = column.querySelector('.dfh-tag-in');
    expect(body?.dataset['team']).toBe('ember');
    expect(body?.dataset['foe']).toBe('0');
    expect(body?.dataset['size']).toBe('near');
    expect(body?.style.getPropertyValue('opacity')).toBe('1');
    expect(column.querySelector('.dfh-tag-name')?.textContent).toBe('Miro');
    expect(column.querySelector('path')?.getAttribute('d')).toBe(TEAM_SHAPES.ember);
    // The others stay hidden.
    expect(columns().filter((node) => !hiddenNodes.has(node))).toHaveLength(1);
  });

  it('draws an enemy as its team shape with no name, and a far marker small', () => {
    place(3, { team: TEAM_FROST, foe: true, near: false, name: '', x: 0.7, y: 0.2, opacity: 0.5 });
    draw();
    const column = columns()[3];
    const body = column?.querySelector('.dfh-tag-in');
    expect(body?.dataset['team']).toBe('frost');
    expect(body?.dataset['foe']).toBe('1');
    expect(body?.dataset['size']).toBe('far');
    expect(body?.style.getPropertyValue('opacity')).toBe('0.5');
    expect(column?.querySelector('.dfh-tag-name')?.textContent).toBe('');
    expect(column?.querySelector('path')?.getAttribute('d')).toBe(TEAM_SHAPES.frost);
  });

  it('writes nothing when nothing moved, and only transforms when a marker moves', () => {
    const tag = place(0, { team: TEAM_EMBER, near: true, name: 'Miro', x: 0.25, y: 0.4 });
    place(1, { team: TEAM_FROST, foe: true, near: true, x: 0.6, y: 0.3 });
    draw();
    resetWrites();
    draw();
    expect(writeCount()).toBe(0);
    // Less than a table step: still nothing.
    tag.x += 0.0001;
    draw();
    expect(writeCount()).toBe(0);
    tag.x = 0.3;
    tag.y = 0.45;
    draw();
    const column = columns()[0];
    expect(column?.style.getPropertyValue('translate')).toBe('30cqw');
    expect(column?.style.getPropertyValue('transform')).toBe('translate3d(0,45cqh,0)');
    // The name, the shape and the keys were not touched again.
    expect(column?.querySelector('.dfh-tag-name')?.textContent).toBe('Miro');
  });

  it('hides a marker again, and all of them in a cinematic phase', () => {
    const tag = place(0, { team: TEAM_EMBER, near: true, name: 'Miro', x: 0.25, y: 0.4 });
    draw();
    expect(hiddenNodes.has(columns()[0] as FakeElement)).toBe(false);
    tag.shown = false;
    draw();
    expect(hiddenNodes.has(columns()[0] as FakeElement)).toBe(true);
    tag.shown = true;
    draw();
    expect(hiddenNodes.has(columns()[0] as FakeElement)).toBe(false);
    // The results podium: the combat HUD (the marker layer with it) is taken off the page.
    state.phase = 'results';
    draw();
    expect(root.querySelector('.dfh-root')?.dataset['chrome']).toBe('cine');
  });
});
