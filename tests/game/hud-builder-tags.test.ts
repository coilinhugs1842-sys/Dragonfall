/**
 * The HUD builder feeding the friend-or-foe markers (T-6.6): who is looking comes from the
 * lobby, the camera and the rock from the frame input, and a new match starts clean. The rules
 * themselves are tested in tests/ui/dragon-tags.test.ts.
 */

import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { createHudBuilder, createHudFrameInput } from '../../src/game/hud-builder';
import type { HudBuilder, HudFrameInput } from '../../src/game/hud-builder';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type {
  HudDragonTag,
  LobbyPlayer,
  LobbyState,
  MatchPhase,
  MutableWorldView,
  TeamId,
} from '../../src/shared';

const ME = 2;
const MATE = 4;
const FOE = 7;
const WATCHER = 9;

function lobby(): LobbyState {
  const player = (id: number, name: string, side: LobbyPlayer['side'], perch: number): LobbyPlayer => ({
    id,
    name,
    side,
    perch,
    classId: 'talon',
    ready: true,
    isHost: id === ME,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: false,
  });
  return {
    roomCode: 'K7WQD',
    phase: 'inMatch',
    hostId: ME,
    players: [
      player(ME, 'Aman', TEAM_EMBER, 0),
      player(MATE, 'Miro', TEAM_EMBER, 1),
      player(FOE, 'Kestrel', TEAM_FROST, 0),
      player(WATCHER, 'Juno', 'spectator', -1),
    ],
    settings: { ...DEFAULT_HOST_SETTINGS, teamSize: 2 },
  };
}

interface Scene {
  view: MutableWorldView;
  builder: HudBuilder;
  input: HudFrameInput;
  flags: Map<number, number>;
  phase: MatchPhase;
  frame(count?: number): void;
  tag(id: number): HudDragonTag | undefined;
}

function scene(localId: number = ME): Scene {
  const view = createWorldView();
  const builder = createHudBuilder(view);
  const input = createHudFrameInput();
  const camera = new PerspectiveCamera(70, 16 / 9, 0.5, 5000);
  camera.position.set(0, 304, -14);
  camera.lookAt(0, 302, 100);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  input.isRider = localId !== WATCHER;
  input.watchedId = ME;
  input.cameraWorld = camera.matrixWorld.elements;
  input.cameraProjection = camera.projectionMatrix.elements;
  const ids = [ME, MATE, FOE];
  const at: Record<number, [number, number, number]> = {
    [ME]: [0, 300, 0],
    [MATE]: [-30, 300, 90],
    [FOE]: [25, 310, 120],
  };
  const flags = new Map<number, number>(ids.map((id) => [id, DRAGON_FLAG_ALIVE]));
  builder.begin('skirmish', 30, localId);
  builder.setLobby(lobby());
  const s: Scene = {
    view,
    builder,
    input,
    flags,
    phase: 'playing',
    frame(count = 3): void {
      for (let i = 0; i < count; i++) {
        beginWorldView(view);
        view.localDragonId = localId === WATCHER ? NO_PLAYER : localId;
        for (const id of ids) {
          const dragon = acquireDragonView(view);
          const [x, y, z] = at[id] ?? [0, 0, 0];
          dragon.id = id;
          dragon.team = (id === FOE ? TEAM_FROST : TEAM_EMBER) as TeamId;
          dragon.classId = 'talon';
          dragon.position.x = x;
          dragon.position.y = y;
          dragon.position.z = z;
          dragon.flags = flags.get(id) ?? 0;
        }
        view.clock.phase = s.phase;
        builder.frame(1 / 60, input);
      }
    },
    tag(id: number): HudDragonTag | undefined {
      const found = builder.hud.dragonTags[ids.indexOf(id)];
      return found !== undefined && found.shown ? found : undefined;
    },
  };
  return s;
}

describe('HUD builder: markers over the dragons', () => {
  it('marks nobody without a camera', () => {
    const s = scene();
    s.input.cameraWorld = [];
    s.frame();
    expect(s.builder.hud.dragonTags.some((tag) => tag.shown)).toBe(false);
  });

  it('marks the team mate by name and the enemy by shape, close by, with no rock to test', () => {
    const s = scene();
    s.frame();
    expect(s.tag(ME)).toBeUndefined();
    expect(s.tag(MATE)).toMatchObject({ team: TEAM_EMBER, foe: false, near: true, name: 'Miro' });
    expect(s.tag(FOE)).toMatchObject({ team: TEAM_FROST, foe: true, name: '' });
  });

  it('asks the frame\'s terrain about enemies only', () => {
    const s = scene();
    const asked: number[] = [];
    s.input.terrain = {
      raycast: (_ox, _oy, _oz, _dx, _dy, dz): number => {
        asked.push(dz);
        return 30;
      },
      clearance: (): number => -1,
    };
    s.frame(4);
    // Rock in the way: the enemy is not marked, the team mate is.
    expect(s.tag(FOE)).toBeUndefined();
    expect(s.tag(MATE)).toBeDefined();
    expect(asked.length).toBeGreaterThan(0);
    // Every ray went to the enemy (120 m ahead of a camera 14 m behind the origin).
    expect(asked.every((dz) => Math.abs(dz - 134) < 1e-6)).toBe(true);
  });

  it('keeps a veiled enemy unmarked', () => {
    const s = scene();
    s.flags.set(FOE, DRAGON_FLAG_ALIVE | DRAGON_FLAG_VEILED);
    s.frame(10);
    expect(s.tag(FOE)).toBeUndefined();
    expect(s.tag(MATE)).toBeDefined();
  });

  it('shows nothing in the phases the cinematics own', () => {
    const s = scene();
    for (const phase of ['intro', 'countdown', 'roundEnd', 'results'] as const) {
      s.phase = phase;
      s.frame();
      expect(s.builder.hud.dragonTags.some((tag) => tag.shown)).toBe(false);
    }
    s.phase = 'playing';
    s.frame();
    expect(s.tag(MATE)).toBeDefined();
  });

  it('shows nothing while the local rider is blinded', () => {
    const s = scene();
    s.frame();
    expect(s.tag(MATE)).toBeDefined();
    const combat = s.view.local;
    const blind = (seconds: number): void => {
      // `beginWorldView` clears `valid`: the frame is built by hand here.
      s.frame(1);
      combat.valid = true;
      combat.blindS = seconds;
      s.builder.frame(1 / 60, s.input);
    };
    blind(2);
    expect(s.builder.hud.dragonTags.some((tag) => tag.shown)).toBe(false);
    blind(0);
    expect(s.tag(MATE)).toBeDefined();
  });

  it('shows a spectator both teams by name, except the dragon the camera is on', () => {
    const s = scene(WATCHER);
    s.frame();
    expect(s.tag(ME)).toBeUndefined();
    expect(s.tag(MATE)).toMatchObject({ foe: false, name: 'Miro' });
    expect(s.tag(FOE)).toMatchObject({ team: TEAM_FROST, foe: false, name: 'Kestrel' });
  });

  it('starts the next match with no marker left over', () => {
    const s = scene();
    s.frame();
    expect(s.builder.hud.dragonTags.some((tag) => tag.shown)).toBe(true);
    s.builder.begin('skirmish', 30, ME);
    expect(s.builder.hud.dragonTags.some((tag) => tag.shown)).toBe(false);
  });
});

describe('HUD builder: a new match after any other', () => {
  it('resets a HUD that never saw an Ember Relay match, and one that did', () => {
    const view = createWorldView();
    const builder = createHudBuilder(view);
    // Straight after creation, twice, in any mode: the relay pool is there from the start.
    builder.begin('skirmish', 30, ME);
    builder.begin('duel', 3, ME);
    expect(builder.hud.relay).toBeNull();
    expect(builder.hud.relayPool.shards).toHaveLength(2);
    expect(builder.hud.relayPool.noticeKind).toBeNull();

    // A relay match leaves its marks in the pool; the next `begin` wipes them.
    builder.begin('emberRelay', 3, ME);
    const pool = builder.hud.relayPool;
    pool.shards[0].status = 1;
    pool.shards[0].carrierName = 'Kestrel';
    pool.shards[1].returnInS = 12;
    pool.carrying = true;
    pool.brazierDistanceM = 400;
    pool.noticeKind = 'captured';
    pool.noticeAgeS = 0.5;
    builder.hud.relay = pool;
    builder.begin('skirmish', 30, ME);
    expect(builder.hud.relay).toBeNull();
    expect(builder.hud.relayPool).toBe(pool);
    expect(pool.shards.map((shard) => shard.status)).toEqual([0, 0]);
    expect(pool.shards[0].carrierName).toBe('');
    expect(pool.shards[1].returnInS).toBe(0);
    expect(pool.carrying).toBe(false);
    expect(pool.brazierDistanceM).toBe(0);
    expect(pool.noticeKind).toBeNull();
    expect(pool.noticeAgeS).toBe(Infinity);
  });
});
