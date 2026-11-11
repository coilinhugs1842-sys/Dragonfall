/**
 * DEV ONLY: a stand-alone page that plays every effect on a scripted timeline against the real
 * sky, fog and placeholder dragons, without a sim or a network. Served by Vite at
 * `/tools/vfx-preview.html`; never imported by the game.
 *
 *   ?scene=talon|bastion|tempest|wraith|misc|stress   which timeline (default talon)
 *   ?quality=low|medium|high                          preset (default medium)
 *   ?t=3.2        simulate to this time in fixed 1/60 s steps, draw one frame and stop
 *                 (repeatable screenshots); without it the timeline loops live
 *   ?scale=0.7    render scale, to judge the look at gameplay resolution
 *
 * `window.__vfxPreview` holds the live stats and the peaks seen so far.
 * This file is a script, not a module of the game: it may allocate.
 */

import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
} from 'three';
import { createPlaceholderDragons } from '../dragons';
import {
  DRAGON_ANIM_DEATH_FALL,
  DRAGON_ANIM_GLIDE,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BLINDED,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_BURNING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_DODGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_HASTED,
  DRAGON_FLAG_IN_STORM,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_REGEN,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SLOWED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  NO_PLAYER,
  PROJECTILE_DEFS,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  ZONE_DEFS,
  acquireDragonView,
  acquireProjectileView,
  acquireZoneView,
  beginWorldView,
  createWorldView,
  isQualityPresetId,
} from '../shared';
import type {
  AbilitySlot,
  DamageSource,
  DragonClassId,
  GameEvent,
  ProjectileKind,
  StatusKind,
  TeamId,
  ZoneKind,
} from '../shared';
import { applySkyFog, createSkyDome, createSkyLights } from '../world/sky';
import { createVfx } from './vfx';

const SPEED = 45;
const STEP = 1 / 60;

interface Actor {
  id: number;
  team: TeamId;
  classId: DragonClassId;
  /** Offset from the moving focus point. */
  x: number;
  y: number;
  z: number;
  flags: number;
  health: number;
}

interface Shot {
  id: number;
  kind: ProjectileKind;
  owner: number;
  team: TeamId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  target: number;
}

interface Area {
  id: number;
  kind: ZoneKind;
  owner: number;
  team: TeamId;
  x: number;
  y: number;
  z: number;
  radius: number;
  until: number;
}

interface World {
  t: number;
  prev: number;
  focusX: number;
  actors: Actor[];
  shots: Shot[];
  areas: Area[];
  emit(event: GameEvent): void;
}

type Script = (w: World) => void;

interface SceneDef {
  loop: number;
  /** Camera offset from the focus and the point (offset) it looks at. */
  eye: [number, number, number];
  look: [number, number, number];
  actors: Actor[];
  script: Script;
}

const actor = (
  id: number,
  team: TeamId,
  classId: DragonClassId,
  x: number,
  y: number,
  z: number,
): Actor => ({ id, team, classId, x, y, z, flags: DRAGON_FLAG_ALIVE, health: 1 });

// --- Script helpers ---------------------------------------------------------------------------------

const at = (w: World, time: number): boolean => w.prev < time && w.t >= time;
const during = (w: World, from: number, to: number): boolean => w.t >= from && w.t < to;
const every = (w: World, period: number, from: number, to: number): boolean =>
  w.t >= from &&
  w.t < to &&
  Math.floor((w.t - from) / period) !== Math.floor((w.prev - from) / period);

function setFlag(a: Actor, flag: number, on: boolean): void {
  a.flags = on ? a.flags | flag : a.flags & ~flag;
}

const posOf = (w: World, a: Actor) => ({ x: w.focusX + a.x, y: a.y, z: a.z });
const FORWARD = { x: 1, y: 0, z: 0 };
let nextId = 1;

function castEvent(w: World, a: Actor, slot: AbilitySlot, direction = FORWARD): void {
  w.emit({
    type: 'abilityCast',
    tick: 0,
    dragonId: a.id,
    classId: a.classId,
    slot,
    position: posOf(w, a),
    direction,
  });
}

function hitEvent(
  w: World,
  from: Actor | null,
  to: Actor,
  source: DamageSource,
  damage: number,
): void {
  w.emit({
    type: 'hit',
    tick: 0,
    attackerId: from === null ? NO_PLAYER : from.id,
    targetId: to.id,
    source,
    damage,
    position: posOf(w, to),
  });
}

function statusEvent(w: World, from: Actor, to: Actor, status: StatusKind): void {
  w.emit({
    type: 'statusApplied',
    tick: 0,
    targetId: to.id,
    sourceId: from.id,
    status,
    durationS: 2,
    position: posOf(w, to),
  });
}

function shoot(
  w: World,
  a: Actor,
  kind: ProjectileKind,
  target: number,
  life: number,
  dirY = 0,
): void {
  const def = PROJECTILE_DEFS[kind];
  const p = posOf(w, a);
  const inherit = def.inheritVelocity * SPEED;
  w.shots.push({
    id: nextId++,
    kind,
    owner: a.id,
    team: a.team,
    x: p.x + 4,
    y: p.y,
    z: p.z,
    vx: def.speed * Math.cos(dirY) + inherit,
    vy: def.speed * Math.sin(dirY),
    vz: 0,
    life,
    target,
  });
}

function area(
  w: World,
  a: Actor,
  kind: ZoneKind,
  x: number,
  y: number,
  z: number,
  life: number,
): void {
  w.areas.push({
    id: nextId++,
    kind,
    owner: a.id,
    team: a.team,
    x,
    y,
    z,
    radius: ZONE_DEFS[kind].radius,
    until: w.t + life,
  });
}

// --- Timelines --------------------------------------------------------------------------------------

const SIDE_EYE: [number, number, number] = [18, 9, 62];
const SIDE_LOOK: [number, number, number] = [30, 0, 0];

const SCENES: Record<string, SceneDef> = {
  talon: {
    loop: 9,
    eye: SIDE_EYE,
    look: SIDE_LOOK,
    actors: [actor(1, TEAM_EMBER, 'talon', 0, 0, 0), actor(2, TEAM_FROST, 'bastion', 70, 0, 0)],
    script(w) {
      const [me, foe] = w.actors as [Actor, Actor];
      // Fire bolts.
      if (every(w, 0.17, 0.1, 2.4)) {
        castEvent(w, me, 'primary');
        shoot(w, me, 'fireBolt', foe.id, 1.1);
      }
      // Searing dash.
      if (at(w, 2.8)) castEvent(w, me, 'secondary');
      setFlag(me, DRAGON_FLAG_BOOSTING, during(w, 2.8, 3.4));
      // Afterburn: haste and a trail of burning zones.
      if (at(w, 3.8)) castEvent(w, me, 'utility');
      setFlag(me, DRAGON_FLAG_HASTED, during(w, 3.8, 6.2));
      if (every(w, 0.5, 3.8, 6.2)) {
        const p = posOf(w, me);
        area(w, me, 'burnTrail', p.x, p.y, p.z, 3);
      }
      // Meteor strafe.
      if (every(w, 0.15, 6.4, 7.3)) {
        castEvent(w, me, 'ultimate');
        shoot(w, me, 'meteorBomb', -1, 0.75, -0.4);
      }
    },
  },
  bastion: {
    loop: 9,
    eye: SIDE_EYE,
    look: SIDE_LOOK,
    actors: [
      actor(1, TEAM_FROST, 'bastion', 0, 0, 0),
      actor(2, TEAM_EMBER, 'talon', 36, 1, 0),
      actor(3, TEAM_FROST, 'talon', -8, 4, -14),
    ],
    script(w) {
      const [me, foe, friend] = w.actors as [Actor, Actor, Actor];
      if (at(w, 0.1)) castEvent(w, me, 'primary');
      setFlag(me, DRAGON_FLAG_FIRING, during(w, 0.1, 2.6));
      if (every(w, 0.2, 0.6, 2.6)) hitEvent(w, me, foe, 'primary', 9);
      // Wing shield.
      setFlag(me, DRAGON_FLAG_CHARGING, during(w, 2.8, 3.0));
      if (at(w, 3.0)) castEvent(w, me, 'secondary');
      setFlag(me, DRAGON_FLAG_SHIELDED, during(w, 3.0, 5.4));
      // Rally roar.
      if (at(w, 4.6)) {
        castEvent(w, me, 'utility');
        const p = posOf(w, me);
        area(w, me, 'rallyAura', p.x, p.y, p.z, 3);
      }
      setFlag(me, DRAGON_FLAG_REGEN, during(w, 4.6, 7.6));
      setFlag(friend, DRAGON_FLAG_REGEN, during(w, 4.6, 7.6));
      // Bulwark charge.
      if (at(w, 7.8)) {
        castEvent(w, me, 'ultimate');
        hitEvent(w, me, foe, 'ultimate', 40);
      }
    },
  },
  tempest: {
    loop: 10,
    eye: [10, 14, 78],
    look: [42, 4, 0],
    actors: [actor(1, TEAM_FROST, 'tempest', 0, 0, 0), actor(2, TEAM_EMBER, 'wraith', 85, 3, 0)],
    script(w) {
      const [me, foe] = w.actors as [Actor, Actor];
      const aim = { x: 0.9994, y: 0.0353, z: 0 };
      // Lightning lance, twice: charge, then the bolt.
      for (const start of [0.1, 1.4]) {
        setFlag(me, DRAGON_FLAG_CHARGING, during(w, 0.1, 0.6) || during(w, 1.4, 1.9));
        if (at(w, start + 0.5)) {
          castEvent(w, me, 'primary', aim);
          hitEvent(w, me, foe, 'primary', 42);
        }
      }
      // Static mine -> static field.
      if (at(w, 2.6)) {
        castEvent(w, me, 'secondary');
        shoot(w, me, 'staticMine', -1, 0.75);
      }
      setFlag(foe, DRAGON_FLAG_SLOWED, during(w, 3.5, 6));
      // Updraft.
      if (at(w, 4.4)) castEvent(w, me, 'utility', { x: 0, y: 1, z: 0 });
      // Thunderhead.
      if (at(w, 5.6)) {
        castEvent(w, me, 'ultimate');
        const p = posOf(w, foe);
        area(w, me, 'thunderhead', p.x + SPEED * 2, p.y + 4, p.z - 10, 4.2);
      }
      if (every(w, 0.5, 6.4, 9.6)) hitEvent(w, me, foe, 'ultimate', 13);
    },
  },
  wraith: {
    loop: 9,
    eye: SIDE_EYE,
    look: SIDE_LOOK,
    actors: [actor(1, TEAM_EMBER, 'wraith', 0, 0, 0), actor(2, TEAM_FROST, 'tempest', 48, 1, 0)],
    script(w) {
      const [me, foe] = w.actors as [Actor, Actor];
      if (at(w, 0.1)) castEvent(w, me, 'primary');
      setFlag(me, DRAGON_FLAG_FIRING, during(w, 0.1, 2.6));
      if (every(w, 0.25, 0.7, 2.6)) hitEvent(w, me, foe, 'primary', 4);
      if (at(w, 0.7)) statusEvent(w, me, foe, 'burn');
      setFlag(foe, DRAGON_FLAG_BURNING, during(w, 0.7, 4.5));
      // Veil.
      if (at(w, 3.1)) castEvent(w, me, 'secondary');
      setFlag(me, DRAGON_FLAG_VEILED, during(w, 3.1, 5));
      // Phase dive.
      if (at(w, 5.4)) castEvent(w, me, 'utility');
      setFlag(me, DRAGON_FLAG_PHASING, during(w, 5.4, 6.4));
      // Night terror.
      if (at(w, 7)) {
        castEvent(w, me, 'ultimate');
        statusEvent(w, me, foe, 'blind');
      }
      setFlag(foe, DRAGON_FLAG_BLINDED, during(w, 7, 9));
    },
  },
  misc: {
    loop: 8,
    eye: [10, 16, 92],
    look: [10, 2, 0],
    actors: [
      actor(1, TEAM_EMBER, 'talon', -48, 6, 0),
      actor(2, TEAM_FROST, 'tempest', -24, 6, 0),
      actor(3, TEAM_EMBER, 'bastion', 0, 6, 0),
      actor(4, TEAM_FROST, 'wraith', 24, 6, 0),
      actor(5, TEAM_EMBER, 'talon', 48, 6, 0),
      actor(6, TEAM_FROST, 'bastion', 70, 6, 0),
    ],
    script(w) {
      const [boost, dodge, storm, hurt, dying, fresh] = w.actors as [
        Actor,
        Actor,
        Actor,
        Actor,
        Actor,
        Actor,
      ];
      setFlag(boost, DRAGON_FLAG_BOOSTING, true);
      setFlag(
        dodge,
        DRAGON_FLAG_DODGING,
        during(w, 1, 1.4) || during(w, 3, 3.4) || during(w, 5, 5.4),
      );
      setFlag(storm, DRAGON_FLAG_IN_STORM, true);
      if (every(w, 1, 0.5, 8)) hitEvent(w, null, storm, 'storm', 6);
      hurt.health = 0.15;
      if (every(w, 1.5, 0.8, 8)) hitEvent(w, null, hurt, 'terrain', 12);
      // A takedown, the fall, and the respawn.
      if (at(w, 0.1)) {
        dying.health = 1;
        dying.y = 6;
      }
      if (at(w, 2)) {
        hitEvent(w, boost, dying, 'primary', 30);
        w.emit({
          type: 'takedown',
          tick: 0,
          killerId: boost.id,
          victimId: dying.id,
          source: 'primary',
          position: posOf(w, dying),
        });
      }
      setFlag(dying, DRAGON_FLAG_ALIVE, !during(w, 2, 5.5));
      if (during(w, 2, 5.5)) dying.y -= 9 * STEP;
      if (at(w, 5.5)) {
        dying.y = 6;
        w.emit({
          type: 'spawn',
          tick: 0,
          dragonId: dying.id,
          team: dying.team,
          classId: dying.classId,
          position: posOf(w, dying),
        });
      }
      setFlag(dying, DRAGON_FLAG_SPAWN_PROTECTED, during(w, 5.5, 8));
      if (at(w, 1) || at(w, 4.5)) {
        w.emit({
          type: 'spawn',
          tick: 0,
          dragonId: fresh.id,
          team: fresh.team,
          classId: fresh.classId,
          position: posOf(w, fresh),
        });
      }
      setFlag(fresh, DRAGON_FLAG_SPAWN_PROTECTED, during(w, 1, 3) || during(w, 4.5, 6.5));
    },
  },
  // Ten dragons doing everything at once: the busiest a match can look.
  stress: {
    loop: 6,
    eye: [20, 40, 150],
    look: [30, 0, 0],
    actors: [
      actor(1, TEAM_EMBER, 'talon', -40, 10, -20),
      actor(2, TEAM_EMBER, 'bastion', -30, 0, 10),
      actor(3, TEAM_EMBER, 'tempest', -50, -8, 0),
      actor(4, TEAM_EMBER, 'wraith', -20, 6, 25),
      actor(5, TEAM_EMBER, 'talon', -35, -4, -40),
      actor(6, TEAM_FROST, 'talon', 60, 8, -15),
      actor(7, TEAM_FROST, 'bastion', 20, 2, 12),
      actor(8, TEAM_FROST, 'tempest', 80, -6, 5),
      actor(9, TEAM_FROST, 'wraith', 40, 5, 30),
      actor(10, TEAM_FROST, 'bastion', 50, -3, -35),
    ],
    script(w) {
      const n = w.actors.length;
      for (let i = 0; i < n; i++) {
        const a = w.actors[i] as Actor;
        const foe = w.actors[(i + 5) % n] as Actor;
        const phase = i * 0.37;
        a.health = i % 3 === 0 ? 0.2 : 1;
        setFlag(a, DRAGON_FLAG_BOOSTING, true);
        setFlag(a, DRAGON_FLAG_BURNING, i % 2 === 0);
        setFlag(a, DRAGON_FLAG_SLOWED, i % 2 === 1);
        setFlag(a, DRAGON_FLAG_REGEN, true);
        if (a.classId === 'talon') {
          if (every(w, 0.17, phase, 99)) {
            castEvent(w, a, 'primary');
            shoot(w, a, 'fireBolt', foe.id, 1.1);
          }
          setFlag(a, DRAGON_FLAG_HASTED, true);
          if (every(w, 0.75, phase, 99)) {
            const p = posOf(w, a);
            area(w, a, 'burnTrail', p.x, p.y, p.z, 3);
          }
          if (every(w, 0.15, 2 + phase, 2.9 + phase)) shoot(w, a, 'meteorBomb', -1, 0.8, -0.4);
          if (every(w, 2, phase, 99)) castEvent(w, a, 'secondary');
        } else if (a.classId === 'bastion') {
          setFlag(a, DRAGON_FLAG_FIRING, true);
          setFlag(a, DRAGON_FLAG_SHIELDED, true);
          if (every(w, 0.2, phase, 99)) hitEvent(w, a, foe, 'primary', 9);
          if (every(w, 2.5, phase, 99)) {
            castEvent(w, a, 'ultimate');
            const p = posOf(w, a);
            area(w, a, 'rallyAura', p.x, p.y, p.z, 2.5);
          }
        } else if (a.classId === 'tempest') {
          setFlag(a, DRAGON_FLAG_CHARGING, (w.t + phase) % 1.2 < 0.5);
          if (every(w, 1.2, phase, 99)) {
            castEvent(w, a, 'primary');
            hitEvent(w, a, foe, 'primary', 42);
          }
          if (every(w, 1.5, phase, 99)) shoot(w, a, 'staticMine', -1, 0.6);
          if (every(w, 3, 0.5 + phase, 99)) {
            const p = posOf(w, foe);
            area(w, a, 'thunderhead', p.x + SPEED * 2, p.y, p.z, 3);
          }
          if (every(w, 0.5, phase, 99)) hitEvent(w, a, foe, 'ultimate', 13);
        } else {
          setFlag(a, DRAGON_FLAG_FIRING, true);
          setFlag(a, DRAGON_FLAG_PHASING, (w.t + phase) % 3 < 1);
          if (every(w, 0.25, phase, 99)) hitEvent(w, a, foe, 'primary', 4);
          if (every(w, 2, 1 + phase, 99)) castEvent(w, a, 'ultimate');
        }
        if (every(w, 3, 1.5 + phase, 99)) {
          w.emit({
            type: 'takedown',
            tick: 0,
            killerId: foe.id,
            victimId: a.id,
            source: 'primary',
            position: posOf(w, a),
          });
        }
      }
    },
  },
};

// --- The page ---------------------------------------------------------------------------------------

interface PreviewReport {
  ready: boolean;
  scene: string;
  quality: string;
  time: number;
  stats: unknown;
  peakParticles: number;
  peakDrawCalls: number;
  peakFrameSprites: number;
  rendererCalls: number;
  rendererTriangles: number;
  updateMsAvg: number;
}

function main(): void {
  const params = new URLSearchParams(location.search);
  const sceneName = params.get('scene') ?? 'talon';
  const def = SCENES[sceneName] ?? (SCENES['talon'] as SceneDef);
  const qualityParam = params.get('quality');
  const presetId = isQualityPresetId(qualityParam) ? qualityParam : 'medium';
  const preset = QUALITY_PRESETS[presetId];
  const freezeAt = params.has('t') ? Number(params.get('t')) : NaN;
  const scale = Number(params.get('scale') ?? '1') || 1;

  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.info.autoReset = false;

  const scene = new Scene();
  applySkyFog(scene);
  const sky = createSkyDome();
  sky.setQuality(preset);
  const lights = createSkyLights();
  const dragons = createPlaceholderDragons(preset, { showDead: true });
  scene.add(sky.object, lights.sun, lights.hemisphere, dragons.object);
  const camera = new PerspectiveCamera(55, 16 / 9, 0.5, 6000);

  const vfx = createVfx({ scene, quality: preset });
  // This preview draws straight to the canvas, so the plain compile builds the right programs.
  vfx.warmUp(() => {
    renderer.compile(scene, camera);
  });

  const view = createWorldView();
  const world: World = {
    t: 0,
    prev: -1,
    focusX: 0,
    actors: def.actors,
    shots: [],
    areas: [],
    emit: (event) => vfx.onEvent(event),
  };
  const report: PreviewReport = {
    ready: false,
    scene: sceneName,
    quality: presetId,
    time: 0,
    stats: vfx.stats,
    peakParticles: 0,
    peakDrawCalls: 0,
    peakFrameSprites: 0,
    rendererCalls: 0,
    rendererTriangles: 0,
    updateMsAvg: 0,
  };
  (window as unknown as { __vfxPreview: PreviewReport }).__vfxPreview = report;
  let updateMs = 0;
  let updates = 0;

  function resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setPixelRatio(scale);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function step(dt: number): void {
    const w = world;
    w.prev = w.t;
    w.t += dt;
    if (w.t >= def.loop && Number.isNaN(freezeAt)) {
      w.t -= def.loop;
      w.prev = -1;
    }
    w.focusX += SPEED * dt;
    def.script(w);

    // Fly the shots; a shot that reaches its target or its end reports it like the host would.
    for (let i = w.shots.length - 1; i >= 0; i--) {
      const s = w.shots[i] as Shot;
      const pdef = PROJECTILE_DEFS[s.kind];
      s.vy -= pdef.gravity * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.life -= dt;
      const target = w.actors.find((a) => a.id === s.target);
      let ended = s.life <= 0;
      if (target !== undefined) {
        const p = posOf(w, target);
        const dx = s.x - p.x;
        const dy = s.y - p.y;
        const dz = s.z - p.z;
        if (dx * dx + dy * dy + dz * dz < 36 || s.x > p.x) {
          ended = true;
          const owner = w.actors.find((a) => a.id === s.owner) ?? null;
          hitEvent(w, owner, target, 'primary', 9);
        }
      }
      if (ended) {
        if (s.kind !== 'fireBolt') {
          w.emit({
            type: 'impact',
            tick: 0,
            projectile: s.kind,
            ownerId: s.owner,
            targetId: NO_PLAYER,
            position: { x: s.x, y: s.y, z: s.z },
          });
          const zone = pdef.zoneOnEnd;
          const owner = w.actors.find((a) => a.id === s.owner);
          if (zone !== null && owner !== undefined) area(w, owner, zone, s.x, s.y, s.z, 4);
        }
        w.shots.splice(i, 1);
      }
    }
    w.areas = w.areas.filter((a) => a.until > w.t);

    // The WorldView, exactly as the game would hand it over.
    beginWorldView(view);
    view.localDragonId = NO_PLAYER;
    for (const a of w.actors) {
      const d = acquireDragonView(view);
      d.id = a.id;
      d.team = a.team;
      d.classId = a.classId;
      d.position.x = w.focusX + a.x;
      d.position.y = a.y;
      d.position.z = a.z;
      // Facing +X.
      d.orientation.x = 0;
      d.orientation.y = Math.SQRT1_2;
      d.orientation.z = 0;
      d.orientation.w = Math.SQRT1_2;
      d.velocity.x = SPEED;
      d.velocity.y = 0;
      d.velocity.z = 0;
      d.health = a.health;
      d.stamina = 1;
      d.flags = a.flags;
      d.anim = (a.flags & DRAGON_FLAG_ALIVE) !== 0 ? DRAGON_ANIM_GLIDE : DRAGON_ANIM_DEATH_FALL;
    }
    for (const s of w.shots) {
      const p = acquireProjectileView(view);
      p.id = s.id;
      p.kind = s.kind;
      p.ownerId = s.owner;
      p.team = s.team;
      p.position.x = s.x;
      p.position.y = s.y;
      p.position.z = s.z;
      p.velocity.x = s.vx;
      p.velocity.y = s.vy;
      p.velocity.z = s.vz;
    }
    for (const a of w.areas) {
      const z = acquireZoneView(view);
      z.id = a.id;
      z.kind = a.kind;
      z.team = a.team;
      z.position.x = a.x;
      z.position.y = a.y;
      z.position.z = a.z;
      z.radius = a.radius;
      z.ownerId = a.owner;
      z.remainingS = a.until - w.t;
    }

    camera.position.set(w.focusX + def.eye[0], def.eye[1], def.eye[2]);
    camera.lookAt(w.focusX + def.look[0], def.look[1], def.look[2]);
    camera.updateMatrixWorld();
    dragons.update(view, dt);
    const before = performance.now();
    vfx.update(view, w.t, dt, camera);
    updateMs += performance.now() - before;
    updates++;

    const stats = vfx.stats;
    report.time = w.t;
    report.peakParticles = Math.max(report.peakParticles, stats.aliveParticles);
    report.peakDrawCalls = Math.max(report.peakDrawCalls, stats.drawCalls);
    report.peakFrameSprites = Math.max(report.peakFrameSprites, stats.frameSprites);
    report.updateMsAvg = updateMs / updates;
  }

  function draw(): void {
    renderer.info.reset();
    renderer.render(scene, camera);
    report.rendererCalls = renderer.info.render.calls;
    report.rendererTriangles = renderer.info.render.triangles;
  }

  const label = document.getElementById('label');
  function describe(): void {
    if (label === null) return;
    const s = vfx.stats;
    label.textContent =
      `${sceneName} · ${presetId} · t=${world.t.toFixed(2)}  particles ${s.aliveParticles}/${s.particleCapacity}` +
      ` (peak ${report.peakParticles})  sprites ${s.frameSprites}  beams ${s.beams}  shells ${s.shells}` +
      `  vfx draws ${s.drawCalls}  update ${report.updateMsAvg.toFixed(3)} ms`;
  }

  resize();
  window.addEventListener('resize', resize);

  if (!Number.isNaN(freezeAt)) {
    // Draw a few frames on the way so buffers are created and uploaded like in a live run.
    let drawn = 0;
    while (world.t < freezeAt) {
      step(STEP);
      if (freezeAt - world.t < STEP * 3 || drawn++ % 30 === 0) draw();
    }
    draw();
    describe();
    report.ready = true;
    return;
  }

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    draw();
    describe();
    report.ready = true;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
