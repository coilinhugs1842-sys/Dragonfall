import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerspectiveCamera, Scene } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_SHIELDED,
  NO_PLAYER,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  acquireProjectileView,
  acquireZoneView,
  beginWorldView,
  createGameEventBus,
  createWorldView,
} from '../../src/shared';
import type {
  AbilityCastEvent,
  DragonClassId,
  GameEvent,
  MutableWorldView,
  TeamId,
} from '../../src/shared';
import { FRAME_SPRITE_CAPACITY, createVfx } from '../../src/vfx';
import type { Vfx } from '../../src/vfx';
import { PROJECTILE_SPRITES } from '../../src/vfx/recipes';

const DT = 1 / 60;

interface Rig {
  vfx: Vfx;
  scene: Scene;
  camera: PerspectiveCamera;
  view: MutableWorldView;
  frame(): void;
}

function addDragon(
  view: MutableWorldView,
  id: number,
  team: TeamId,
  classId: DragonClassId,
  x: number,
  flags: number,
  health = 1,
): void {
  const d = acquireDragonView(view);
  d.id = id;
  d.team = team;
  d.classId = classId;
  d.position.x = x;
  d.position.y = 0;
  d.position.z = 0;
  d.orientation.x = 0;
  d.orientation.y = 0;
  d.orientation.z = 0;
  d.orientation.w = 1;
  d.velocity.x = 0;
  d.velocity.y = 0;
  d.velocity.z = 40;
  d.health = health;
  d.stamina = 1;
  d.flags = flags;
  d.anim = 0;
}

let rigs: Rig[] = [];

function createRig(quality: 'low' | 'medium' | 'high' = 'medium'): Rig {
  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 16 / 9, 0.5, 6000);
  camera.position.set(0, 10, -60);
  const view = createWorldView();
  const vfx = createVfx({ scene, quality: QUALITY_PRESETS[quality], seed: 1 });
  const rig: Rig = {
    vfx,
    scene,
    camera,
    view,
    frame: () => vfx.update(view, 0, DT, camera),
  };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs) rig.vfx.dispose();
  rigs = [];
});

const cast = (
  dragonId: number,
  classId: DragonClassId,
  slot: AbilityCastEvent['slot'],
): GameEvent => ({
  type: 'abilityCast',
  tick: 1,
  dragonId,
  classId,
  slot,
  position: { x: 0, y: 0, z: 0 },
  direction: { x: 0, y: 0, z: 1 },
});

describe('createVfx', () => {
  it('adds at most four meshes to the scene and removes them on dispose', () => {
    const rig = createRig();
    expect(rig.scene.children.length).toBe(4);
    rig.vfx.dispose();
    expect(rig.scene.children.length).toBe(0);
    // Disposed: further calls are ignored.
    rig.frame();
    rig.vfx.onEvent(cast(1, 'talon', 'primary'));
  });

  it('costs no draw call while nothing is happening', () => {
    const rig = createRig();
    beginWorldView(rig.view);
    addDragon(rig.view, 1, TEAM_EMBER, 'talon', 0, DRAGON_FLAG_ALIVE);
    rig.frame();
    rig.frame();
    expect(rig.vfx.stats.drawCalls).toBe(0);
    expect(rig.vfx.stats.aliveParticles).toBe(0);
    for (const child of rig.scene.children) expect(child.visible).toBe(false);
  });

  it('starts with the cap of its preset and follows setQuality', () => {
    const rig = createRig('low');
    expect(rig.vfx.stats.particleCapacity).toBe(600);
    rig.vfx.setQuality(QUALITY_PRESETS.high);
    expect(rig.vfx.stats.particleCapacity).toBe(3000);
    rig.vfx.setQuality(QUALITY_PRESETS.medium);
    expect(rig.vfx.stats.particleCapacity).toBe(1200);
  });

  it('turns events into particles', () => {
    const events: GameEvent[] = [
      cast(1, 'talon', 'primary'),
      cast(1, 'bastion', 'ultimate'),
      {
        type: 'hit',
        tick: 1,
        attackerId: 1,
        targetId: 2,
        source: 'primary',
        damage: 9,
        position: { x: 0, y: 0, z: 30 },
      },
      {
        type: 'takedown',
        tick: 1,
        killerId: 1,
        victimId: 2,
        source: 'primary',
        position: { x: 0, y: 0, z: 30 },
      },
      {
        type: 'spawn',
        tick: 1,
        dragonId: 2,
        team: TEAM_FROST,
        classId: 'wraith',
        position: { x: 0, y: 0, z: 0 },
      },
      {
        type: 'statusApplied',
        tick: 1,
        targetId: 2,
        sourceId: 1,
        status: 'burn',
        durationS: 2,
        position: { x: 0, y: 0, z: 0 },
      },
      {
        type: 'impact',
        tick: 1,
        projectile: 'meteorBomb',
        ownerId: 1,
        targetId: NO_PLAYER,
        position: { x: 0, y: 0, z: 0 },
      },
    ];
    for (const event of events) {
      const rig = createRig();
      beginWorldView(rig.view);
      rig.frame();
      rig.vfx.onEvent(event);
      rig.frame();
      expect(rig.vfx.stats.spawned, event.type).toBeGreaterThan(0);
      expect(rig.vfx.stats.aliveParticles, event.type).toBeGreaterThan(0);
      expect(rig.vfx.stats.drawCalls, event.type).toBe(1);
    }
  });

  it('ignores events it has no picture for', () => {
    const rig = createRig();
    beginWorldView(rig.view);
    rig.frame();
    rig.vfx.onEvent({ type: 'assist', tick: 1, assisterId: 1, killerId: 2, victimId: 3 });
    rig.vfx.onEvent({ type: 'matchPhase', tick: 1, phase: 'playing', round: 1, winner: null });
    rig.vfx.onEvent({
      type: 'statusApplied',
      tick: 1,
      targetId: 1,
      sourceId: 1,
      status: 'shield',
      durationS: 3,
      position: { x: 0, y: 0, z: 0 },
    });
    rig.frame();
    expect(rig.vfx.stats.spawned).toBe(0);
  });

  it('a bigger hit throws more sparks', () => {
    const sparks = (damage: number): number => {
      let total = 0;
      for (let seed = 0; seed < 20; seed++) {
        const scene = new Scene();
        const vfx = createVfx({ scene, quality: QUALITY_PRESETS.high, seed });
        vfx.onEvent({
          type: 'hit',
          tick: 1,
          attackerId: 1,
          targetId: 2,
          source: 'primary',
          damage,
          position: { x: 0, y: 0, z: 0 },
        });
        total += vfx.stats.spawned;
        // `spawned` is copied into the stats on update.
        const camera = new PerspectiveCamera();
        vfx.update(createWorldView(), 0, DT, camera);
        total += vfx.stats.spawned;
        vfx.dispose();
      }
      return total;
    };
    expect(sparks(40)).toBeGreaterThan(sparks(4) * 2);
  });

  it('draws the lance as a beam and forks', () => {
    const rig = createRig();
    beginWorldView(rig.view);
    rig.frame();
    rig.vfx.onEvent(cast(3, 'tempest', 'primary'));
    rig.frame();
    expect(rig.vfx.stats.beams).toBeGreaterThanOrEqual(2);
    expect(rig.vfx.stats.drawCalls).toBe(2);
    // It is a flash: gone within half a second.
    for (let i = 0; i < 30; i++) rig.frame();
    expect(rig.vfx.stats.beams).toBe(0);
  });

  it('stops a beam at terrain when it is given a terrain query', () => {
    const scene = new Scene();
    const rays: number[] = [];
    const vfx = createVfx({
      scene,
      quality: QUALITY_PRESETS.medium,
      terrain: {
        raycast: (_x, _y, _z, _dx, _dy, _dz, max) => {
          rays.push(max);
          return 25;
        },
        clearance: () => -1,
      },
    });
    vfx.onEvent(cast(3, 'tempest', 'primary'));
    expect(rays.length).toBe(1);
    expect(rays[0]).toBeGreaterThan(100);
    vfx.dispose();
  });

  it('reads continuous effects from the dragon flags', () => {
    const run = (classId: DragonClassId, flags: number, health = 1) => {
      const rig = createRig('high');
      for (let i = 0; i < 30; i++) {
        beginWorldView(rig.view);
        addDragon(rig.view, 1, TEAM_EMBER, classId, 0, DRAGON_FLAG_ALIVE | flags, health);
        rig.frame();
      }
      return { ...rig.vfx.stats };
    };
    expect(run('talon', 0).spawned).toBe(0);
    expect(run('talon', DRAGON_FLAG_BOOSTING).spawned).toBeGreaterThan(5);
    expect(run('bastion', DRAGON_FLAG_FIRING).spawned).toBeGreaterThan(20);
    expect(run('wraith', DRAGON_FLAG_FIRING).spawned).toBeGreaterThan(10);
    // The Talon's primary is bolts (projectiles), not a breath.
    expect(run('talon', DRAGON_FLAG_FIRING).spawned).toBe(0);
    expect(run('talon', 0, 0.2).spawned).toBeGreaterThan(0);
    expect(run('talon', 0, 0.2).spawned).toBeLessThan(run('bastion', DRAGON_FLAG_FIRING).spawned);
    const shield = run('bastion', DRAGON_FLAG_SHIELDED);
    expect(shield.shells).toBe(1);
    expect(shield.drawCalls).toBe(1);
    const charge = run('tempest', DRAGON_FLAG_CHARGING);
    expect(charge.frameSprites).toBe(2);
    expect(run('talon', DRAGON_FLAG_CHARGING).frameSprites).toBe(1);
  });

  it('plays a dodge swirl once, on the frame the roll starts', () => {
    const rig = createRig('high');
    const frame = (flags: number): number => {
      beginWorldView(rig.view);
      addDragon(rig.view, 1, TEAM_EMBER, 'talon', 0, DRAGON_FLAG_ALIVE | flags);
      rig.frame();
      return rig.vfx.stats.spawned;
    };
    expect(frame(0)).toBe(0);
    const started = frame(DRAGON_FLAG_DODGING);
    expect(started).toBeGreaterThan(5);
    expect(frame(DRAGON_FLAG_DODGING)).toBe(started);
    expect(frame(0)).toBe(started);
    // A dragon that appears already rolling (first frame in view) does not replay it.
    const other = createRig('high');
    beginWorldView(other.view);
    addDragon(other.view, 1, TEAM_EMBER, 'talon', 0, DRAGON_FLAG_ALIVE | DRAGON_FLAG_DODGING);
    other.frame();
    expect(other.vfx.stats.spawned).toBe(0);
  });

  it('draws projectiles as frame sprites, capped', () => {
    const rig = createRig();
    const frame = (bolts: number): void => {
      beginWorldView(rig.view);
      for (let i = 0; i < bolts; i++) {
        const p = acquireProjectileView(rig.view);
        p.id = i;
        p.kind = 'fireBolt';
        p.ownerId = 1;
        p.team = TEAM_EMBER;
        p.position.x = i;
        p.position.y = 0;
        p.position.z = 20;
        p.velocity.x = 0;
        p.velocity.y = 0;
        p.velocity.z = 240;
      }
      rig.frame();
    };
    frame(4);
    expect(rig.vfx.stats.frameSprites).toBe(4 * PROJECTILE_SPRITES.fireBolt.length);
    expect(rig.vfx.stats.drawCalls).toBe(1);
    // Bolts leave no particles behind: their ribbon is part of the sprite.
    expect(rig.vfx.stats.spawned).toBe(0);
    frame(500);
    expect(rig.vfx.stats.frameSprites).toBe(FRAME_SPRITE_CAPACITY);
    frame(0);
    expect(rig.vfx.stats.frameSprites).toBe(0);
    expect(rig.vfx.stats.drawCalls).toBe(0);
  });

  it('hints zones with a shell and particles, and leaves the storm wall alone', () => {
    const rig = createRig('high');
    for (let i = 0; i < 20; i++) {
      beginWorldView(rig.view);
      const wall = acquireZoneView(rig.view);
      wall.id = 1;
      wall.kind = 'stormWall';
      wall.team = null;
      wall.radius = 900;
      rig.frame();
    }
    expect(rig.vfx.stats.shells).toBe(0);
    expect(rig.vfx.stats.spawned).toBe(0);
    for (let i = 0; i < 20; i++) {
      beginWorldView(rig.view);
      const field = acquireZoneView(rig.view);
      field.id = 2;
      field.kind = 'staticField';
      field.team = TEAM_FROST;
      field.position.x = 0;
      field.position.y = 0;
      field.position.z = 100;
      field.radius = 26;
      field.ownerId = 4;
      field.remainingS = 5;
      rig.frame();
    }
    expect(rig.vfx.stats.shells).toBe(1);
    expect(rig.vfx.stats.spawned).toBeGreaterThan(0);
  });

  it('never exceeds the particle cap, however much happens', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      const rig = createRig(quality);
      const cap = QUALITY_PRESETS[quality].maxParticles;
      let peak = 0;
      for (let f = 0; f < 120; f++) {
        beginWorldView(rig.view);
        for (let id = 0; id < 10; id++) {
          addDragon(
            rig.view,
            id,
            id < 5 ? TEAM_EMBER : TEAM_FROST,
            id % 2 === 0 ? 'bastion' : 'wraith',
            id * 20,
            DRAGON_FLAG_ALIVE | DRAGON_FLAG_FIRING | DRAGON_FLAG_BOOSTING,
            0.1,
          );
        }
        for (let id = 0; id < 10; id++) {
          rig.vfx.onEvent({
            type: 'takedown',
            tick: f,
            killerId: 0,
            victimId: id,
            source: 'primary',
            position: { x: id * 20, y: 0, z: 0 },
          });
        }
        rig.frame();
        peak = Math.max(peak, rig.vfx.stats.aliveParticles);
      }
      expect(peak, quality).toBeLessThanOrEqual(cap);
      // The flood really did fill the pool.
      expect(peak, quality).toBeGreaterThan(cap * 0.9);
      expect(rig.vfx.stats.drawCalls, quality).toBeLessThanOrEqual(4);
    }
  });

  it('clear drops everything', () => {
    const rig = createRig();
    beginWorldView(rig.view);
    rig.frame();
    rig.vfx.onEvent(cast(1, 'bastion', 'ultimate'));
    rig.vfx.onEvent(cast(3, 'tempest', 'primary'));
    rig.frame();
    expect(rig.vfx.stats.aliveParticles).toBeGreaterThan(0);
    rig.vfx.clear();
    rig.frame();
    expect(rig.vfx.stats.aliveParticles).toBe(0);
    expect(rig.vfx.stats.beams).toBe(0);
  });
});

describe('local shot prediction', () => {
  function localRig(): Rig {
    const rig = createRig('high');
    beginWorldView(rig.view);
    rig.view.localDragonId = 7;
    addDragon(rig.view, 7, TEAM_FROST, 'talon', 0, DRAGON_FLAG_ALIVE);
    rig.frame();
    return rig;
  }
  const origin = { x: 0, y: 0, z: 0 };
  const forward = { x: 0, y: 0, z: 1 };
  const spawnedAfterFrame = (rig: Rig): number => {
    beginWorldView(rig.view);
    rig.view.localDragonId = 7;
    addDragon(rig.view, 7, TEAM_FROST, 'talon', 0, DRAGON_FLAG_ALIVE);
    rig.frame();
    return rig.vfx.stats.spawned;
  };

  it('shows the shot at once and skips the echo from the host', () => {
    const rig = localRig();
    rig.vfx.spawnLocalShot('talon', 'primary', origin, forward);
    const shown = spawnedAfterFrame(rig);
    expect(shown).toBeGreaterThan(0);
    rig.vfx.onEvent(cast(7, 'talon', 'primary'));
    expect(spawnedAfterFrame(rig)).toBe(shown);
    // The next event for that slot is not a predicted one: it is drawn.
    rig.vfx.onEvent(cast(7, 'talon', 'primary'));
    expect(spawnedAfterFrame(rig)).toBeGreaterThan(shown);
  });

  it('matches echoes per slot and per shot', () => {
    const rig = localRig();
    rig.vfx.spawnLocalShot('talon', 'primary', origin, forward);
    rig.vfx.spawnLocalShot('talon', 'primary', origin, forward);
    const shown = spawnedAfterFrame(rig);
    // Another slot's event is not an echo of these.
    rig.vfx.onEvent(cast(7, 'talon', 'secondary'));
    const withDash = spawnedAfterFrame(rig);
    expect(withDash).toBeGreaterThan(shown);
    rig.vfx.onEvent(cast(7, 'talon', 'primary'));
    rig.vfx.onEvent(cast(7, 'talon', 'primary'));
    expect(spawnedAfterFrame(rig)).toBe(withDash);
    rig.vfx.onEvent(cast(7, 'talon', 'primary'));
    expect(spawnedAfterFrame(rig)).toBeGreaterThan(withDash);
  });

  it("never swallows another dragon's cast", () => {
    const rig = localRig();
    rig.vfx.spawnLocalShot('talon', 'primary', origin, forward);
    const shown = spawnedAfterFrame(rig);
    rig.vfx.onEvent(cast(8, 'talon', 'primary'));
    expect(spawnedAfterFrame(rig)).toBeGreaterThan(shown);
  });

  it('forgets a prediction the host never confirmed', () => {
    const rig = localRig();
    rig.vfx.spawnLocalShot('talon', 'primary', origin, forward);
    let shown = 0;
    // Two seconds pass with no echo.
    for (let i = 0; i < 120; i++) shown = spawnedAfterFrame(rig);
    rig.vfx.onEvent(cast(7, 'talon', 'primary'));
    expect(spawnedAfterFrame(rig)).toBeGreaterThan(shown);
  });
});

describe('event bus wiring', () => {
  it('connect subscribes to the bus and the returned function unsubscribes', () => {
    const rig = createRig();
    const bus = createGameEventBus();
    const off = rig.vfx.connect(bus);
    beginWorldView(rig.view);
    rig.frame();
    bus.emit(cast(1, 'bastion', 'ultimate'));
    bus.flush();
    rig.frame();
    const shown = rig.vfx.stats.spawned;
    expect(shown).toBeGreaterThan(0);
    off();
    bus.emit(cast(1, 'bastion', 'ultimate'));
    bus.flush();
    rig.frame();
    expect(rig.vfx.stats.spawned).toBe(shown);
  });
});

describe('module boundary', () => {
  it('the effects read only the shared contracts (no sim, net, game or other views)', () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/vfx');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(dir, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
      for (const path of imports) {
        const allowed =
          path === 'three' ||
          path === '../shared' ||
          path.startsWith('./') ||
          // The dev preview page stands in for the game: it borrows the sky and the dragons.
          (file === 'dev-preview.ts' && (path === '../dragons' || path === '../world/sky'));
        expect(allowed, `${file} imports ${path}`).toBe(true);
      }
      if (file !== 'dev-preview.ts') {
        expect(source.includes('Math.random('), `${file} uses Math.random`).toBe(false);
        expect(/\bdocument\b|\bwindow\b/.test(source), `${file} touches the DOM`).toBe(false);
      }
    }
  });
});
