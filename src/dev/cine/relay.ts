/**
 * `?viewer=cine:relay`: Ember Relay's objects and HUD on their own (T-6.3), without a room or a
 * sim. It loads the match map, puts the sites where a real match would (the same pure function
 * the host uses), and plays a 40 s loop of everything a shard can do:
 *
 *    0 s  both shards on their stands
 *    6 s  an Ember rider takes the Frost shard and flies for home
 *   20 s  the carrier goes down: the shard is dropped in mid-air
 *   24 s  a Frost rider takes the Ember shard
 *   30 s  a Frost rider touches the dropped shard: it goes home
 *   34 s  the Frost rider reaches its brazier: captured
 *
 *   &cam=tour|stand|brazier|far|carrier|drop|overview   what the camera looks at (default tour:
 *                       one after the other, following the script)
 *   &team=0|1           whose stand / brazier `stand`, `brazier` and `far` look at (default 0)
 *   &state=home|carried|dropped   freeze the script in one state instead of playing it
 *   &as=0|3|watch       whose HUD is shown: the Ember carrier (default), the Frost carrier, or
 *                       a spectator
 *   &ui=0               no HUD
 *   &relay=0            the same scene without the mode (to read what the mode's view costs)
 *   &t=<seconds>&speed=0   freeze on one moment (the harness's own parameters)
 *
 * `window.__relay` holds the script time, both shard states and the renderer's draw calls and
 * triangles for the frame, for the capture scripts.
 */
import type { PerspectiveCamera } from 'three';
import { createHudBuilder, createHudFrameInput } from '../../game/hud-builder';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_ANIM_GLIDE,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_SLOWED,
  MODE_TUNING,
  NO_PLAYER,
  SHARD_CARRIED,
  SHARD_DROPPED,
  SHARD_HOME,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
  acquireDragonView,
  acquireZoneView,
  beginWorldView,
  createGameEventBus,
  createVec3,
  createWorldView,
  writeRelayView,
} from '../../shared';
import type {
  DragonClassId,
  LobbyPlayer,
  LobbyState,
  MatchPlayerStats,
  MutableVec3,
  ObjectiveKind,
  PlayerId,
  TeamId,
  Vec3,
} from '../../shared';
import { createRelayState } from '../../sim';
import { relayTerrainOf, writeRelaySites } from '../../sim/match';
import { createHud } from '../../ui/hud';
import type { CineFrame, CineHarness } from '../cine-viewer';

const LOOP_S = 40;
const TAKE_FROST_S = 6;
const DROP_S = 20;
const TAKE_EMBER_S = 24;
const RETURN_S = 30;
const CAPTURE_S = 34;

/** Riders per team. Ember 0..2, Frost 3..5. */
const TEAM_SIZE = 3;
const EMBER_RUNNER: PlayerId = 0;
const FROST_RUNNER: PlayerId = 3;
const FROST_KEEPER: PlayerId = 4;
const NAMES = ['Aman', 'Miro', 'Sable', 'Kestrel', 'Ashka', 'Oriel'];
const CLASSES: readonly DragonClassId[] = ['talon', 'bastion', 'tempest', 'wraith', 'talon', 'tempest'];

type Camera = 'tour' | 'stand' | 'brazier' | 'far' | 'carrier' | 'drop' | 'overview';
const CAMERAS: readonly Camera[] = ['tour', 'stand', 'brazier', 'far', 'carrier', 'drop', 'overview'];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(out: MutableVec3, a: Vec3, b: Vec3, t: number): MutableVec3 {
  out.x = lerp(a.x, b.x, t);
  out.y = lerp(a.y, b.y, t);
  out.z = lerp(a.z, b.z, t);
  return out;
}

function lobbyOf(): LobbyState {
  const players: LobbyPlayer[] = NAMES.map((name, id) => ({
    id,
    name,
    side: id < TEAM_SIZE ? TEAM_EMBER : TEAM_FROST,
    perch: id % TEAM_SIZE,
    classId: CLASSES[id] ?? 'talon',
    ready: true,
    isHost: id === 0,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: id !== 0,
  }));
  return {
    roomCode: 'RELAY',
    phase: 'inMatch',
    hostId: 0,
    players,
    settings: { ...DEFAULT_HOST_SETTINGS, mode: 'emberRelay', teamSize: TEAM_SIZE, scoreLimit: 3 },
  };
}

export function start(harness: CineHarness): void {
  const params = harness.params;
  const assets = harness.loadMatch();
  const map = assets.map;
  const world = assets.world;
  const tuning = MODE_TUNING.emberRelay;

  const cameraParam = params.get('cam') ?? 'tour';
  const cameraMode: Camera = CAMERAS.find((id) => id === cameraParam) ?? 'tour';
  const lookTeam: TeamId = params.get('team') === '1' ? TEAM_FROST : TEAM_EMBER;
  const frozen = params.get('state');
  const relayOn = params.get('relay') !== '0';
  const asParam = params.get('as');
  const localId: PlayerId = asParam === 'watch' ? NO_PLAYER : asParam === '3' ? FROST_RUNNER : EMBER_RUNNER;

  // The sites, exactly as the host's rules place them on this map.
  const relay = createRelayState();
  const gates = [TEAM_EMBER, TEAM_FROST].map((team) => {
    const gate = world.spawnGates[team];
    return gate !== undefined
      ? createVec3(gate.position.x, gate.position.y, gate.position.z)
      : createVec3(world.centerX, (world.floorY + world.ceilingY) * 0.5, world.centerZ);
  });
  writeRelaySites(
    relay.stands,
    relay.braziers,
    {
      gates,
      centerX: world.centerX,
      centerZ: world.centerZ,
      radius: world.radius,
      floorY: world.floorY,
      ceilingY: world.ceilingY,
      terrain: relayTerrainOf(world.collisionWorld),
    },
    tuning,
  );
  relay.active = relayOn;
  const stand = (team: TeamId): Vec3 => relay.stands[team] ?? createVec3();
  const brazier = (team: TeamId): Vec3 => relay.braziers[team] ?? createVec3();
  // Where the Ember runner is brought down: 55 % of the way home.
  const dropSpot = mix(createVec3(), stand(TEAM_FROST), brazier(TEAM_EMBER), 0.55);
  // Lifted clear of the spires in the middle of the map (a real match's rules do that themselves).
  dropSpot.y += 110;

  const view = createWorldView();
  const frame: CineFrame = { kind: 'match', view };
  const bus = createGameEventBus();
  const builder = createHudBuilder(view);
  const input = createHudFrameInput();
  const hud = params.get('ui') === '0' ? null : createHud(harness.uiRoot, { listenForTab: true });
  const lobby = lobbyOf();
  builder.begin('emberRelay', 3, localId);
  builder.setLobby(lobby);
  builder.connect(bus);
  const stats: MatchPlayerStats[] = NAMES.map((_name, playerId) => ({
    playerId,
    team: playerId < TEAM_SIZE ? TEAM_EMBER : TEAM_FROST,
    present: true,
    takedowns: (playerId * 3) % 5,
    deaths: playerId % 3,
    assists: playerId % 2,
    damage: 180 + playerId * 95,
    healing: 0,
  }));
  const captures = stats as (MatchPlayerStats & { captures?: number })[];
  input.stats = stats;
  input.statsCount = stats.length;
  input.isRider = localId !== NO_PLAYER;
  input.watchedId = localId;

  // --- The script --------------------------------------------------------------------------------
  const position: MutableVec3[] = NAMES.map(() => createVec3());
  const heading: number[] = NAMES.map(() => 0);
  const alive: boolean[] = NAMES.map(() => true);
  const scratch = createVec3();
  let lastScriptS = -1;
  let scoreFrost = 0;

  function emit(kind: ObjectiveKind, team: TeamId, dragonId: PlayerId, at: Vec3): void {
    bus.emit({ type: 'objective', tick: 0, kind, team, dragonId, position: at });
  }

  /** Fires the events the script passed between two frames (not when frozen or seeking back). */
  function crossed(from: number, to: number, at: number): boolean {
    return from < at && to >= at;
  }

  function fly(id: PlayerId, from: Vec3, to: Vec3, t: number): void {
    const at = position[id];
    if (at === undefined) return;
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    mix(at, from, to, k);
    // A shallow arc: riders do not fly ruler-straight.
    at.y += Math.sin(k * Math.PI) * 30;
    heading[id] = Math.atan2(to.x - from.x, to.z - from.z);
  }

  function circle(id: PlayerId, centre: Vec3, radius: number, timeS: number, lift: number): void {
    const at = position[id];
    if (at === undefined) return;
    const angle = timeS * 0.35 + id * 2.1;
    at.x = centre.x + Math.sin(angle) * radius;
    at.y = centre.y + lift + Math.sin(timeS * 0.5 + id) * 8;
    at.z = centre.z + Math.cos(angle) * radius;
    heading[id] = angle + Math.PI / 2;
  }

  function play(timeS: number): void {
    const s =
      frozen === 'home' ? 2 : frozen === 'carried' ? 13 : frozen === 'dropped' ? 22 : timeS % LOOP_S;
    const frost = relay.shards[TEAM_FROST];
    const ember = relay.shards[TEAM_EMBER];
    if (frost === undefined || ember === undefined) return;

    // Everybody else keeps to their own base.
    for (let id = 0; id < NAMES.length; id++) {
      const team = id < TEAM_SIZE ? TEAM_EMBER : TEAM_FROST;
      circle(id, stand(team), 70 + (id % TEAM_SIZE) * 25, timeS, 20 + (id % TEAM_SIZE) * 14);
      alive[id] = true;
    }

    // The Ember runner: out to the Frost stand, back toward home, down at the drop.
    if (s < TAKE_FROST_S) {
      fly(EMBER_RUNNER, mix(scratch, stand(TEAM_EMBER), stand(TEAM_FROST), 0.5), stand(TEAM_FROST), s / TAKE_FROST_S);
    } else if (s < DROP_S) {
      fly(EMBER_RUNNER, stand(TEAM_FROST), dropSpot, (s - TAKE_FROST_S) / (DROP_S - TAKE_FROST_S));
    } else if (s < RETURN_S) {
      const at = position[EMBER_RUNNER];
      if (at !== undefined) {
        at.x = dropSpot.x;
        at.y = dropSpot.y - (s - DROP_S) * 22;
        at.z = dropSpot.z;
      }
      alive[EMBER_RUNNER] = false;
    }
    frost.status = s >= TAKE_FROST_S && s < DROP_S ? SHARD_CARRIED : s >= DROP_S && s < RETURN_S ? SHARD_DROPPED : SHARD_HOME;
    frost.carrierId = frost.status === SHARD_CARRIED ? EMBER_RUNNER : NO_PLAYER;
    const frostAt = frost.status === SHARD_DROPPED ? dropSpot : stand(TEAM_FROST);
    frost.position.x = frostAt.x;
    frost.position.y = frostAt.y;
    frost.position.z = frostAt.z;
    // The view's clock stands at tick `timeS * TICK_HZ`.
    frost.returnTick =
      frost.status === SHARD_DROPPED
        ? Math.round((timeS + (DROP_S + tuning.dropReturnS - s)) * TICK_HZ)
        : -1;

    // The Frost runner: takes the Ember shard and brings it to its brazier.
    if (s >= TAKE_EMBER_S - 4 && s < TAKE_EMBER_S) {
      fly(FROST_RUNNER, mix(scratch, stand(TEAM_FROST), stand(TEAM_EMBER), 0.6), stand(TEAM_EMBER), (s - TAKE_EMBER_S + 4) / 4);
    } else if (s >= TAKE_EMBER_S && s < CAPTURE_S) {
      fly(FROST_RUNNER, stand(TEAM_EMBER), brazier(TEAM_FROST), (s - TAKE_EMBER_S) / (CAPTURE_S - TAKE_EMBER_S));
    }
    ember.status = s >= TAKE_EMBER_S && s < CAPTURE_S ? SHARD_CARRIED : SHARD_HOME;
    ember.carrierId = ember.status === SHARD_CARRIED ? FROST_RUNNER : NO_PLAYER;
    ember.position.x = stand(TEAM_EMBER).x;
    ember.position.y = stand(TEAM_EMBER).y;
    ember.position.z = stand(TEAM_EMBER).z;
    ember.returnTick = -1;

    // The Frost keeper goes for the dropped shard.
    if (s >= RETURN_S - 5 && s < RETURN_S) {
      fly(FROST_KEEPER, stand(TEAM_FROST), dropSpot, (s - RETURN_S + 5) / 5);
    }

    if (frozen === null && lastScriptS >= 0) {
      const from = lastScriptS;
      if (from > s) {
        // The loop came round: a new match.
        scoreFrost = 0;
        for (const row of captures) row.captures = 0;
      } else {
        if (crossed(from, s, TAKE_FROST_S)) emit('pickedUp', TEAM_EMBER, EMBER_RUNNER, stand(TEAM_FROST));
        if (crossed(from, s, DROP_S)) emit('dropped', TEAM_FROST, EMBER_RUNNER, dropSpot);
        if (crossed(from, s, TAKE_EMBER_S)) emit('pickedUp', TEAM_FROST, FROST_RUNNER, stand(TEAM_EMBER));
        if (crossed(from, s, RETURN_S)) emit('returned', TEAM_FROST, FROST_KEEPER, dropSpot);
        if (crossed(from, s, CAPTURE_S)) {
          emit('captured', TEAM_FROST, FROST_RUNNER, brazier(TEAM_FROST));
          scoreFrost++;
          const row = captures[FROST_RUNNER];
          if (row !== undefined) row.captures = (row.captures ?? 0) + 1;
        }
      }
    }
    lastScriptS = s;
    scriptS = s;
  }
  let scriptS = 0;

  // --- The camera --------------------------------------------------------------------------------
  let cameraYaw = 0;
  function aim(camera: PerspectiveCamera, eye: Vec3, at: Vec3, fov: number): void {
    camera.position.set(eye.x, eye.y, eye.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(at.x, at.y, at.z);
    camera.fov = fov;
    cameraYaw = Math.atan2(at.x - eye.x, at.z - eye.z);
  }
  const eye = createVec3();
  const target = createVec3();

  function orbit(camera: PerspectiveCamera, centre: Vec3, radius: number, lift: number, timeS: number, fov: number): void {
    const angle = timeS * 0.22 + 0.6;
    eye.x = centre.x + Math.sin(angle) * radius;
    eye.y = centre.y + lift;
    eye.z = centre.z + Math.cos(angle) * radius;
    aim(camera, eye, centre, fov);
  }

  function chase(camera: PerspectiveCamera, id: PlayerId): void {
    const at = position[id];
    const yaw = heading[id] ?? 0;
    if (at === undefined) return;
    eye.x = at.x - Math.sin(yaw) * 26 + Math.cos(yaw) * 7;
    eye.y = at.y + 9;
    eye.z = at.z - Math.cos(yaw) * 26 - Math.sin(yaw) * 7;
    target.x = at.x + Math.sin(yaw) * 20;
    target.y = at.y + 1;
    target.z = at.z + Math.cos(yaw) * 20;
    aim(camera, eye, target, 62);
  }

  harness.setDirector({
    direct(camera: PerspectiveCamera): boolean {
      const timeS = scriptClock;
      let mode: Camera = cameraMode;
      if (mode === 'tour') {
        const s = scriptS;
        mode = s < TAKE_FROST_S ? 'stand' : s < DROP_S ? 'carrier' : s < RETURN_S ? 'drop' : s < CAPTURE_S + 3 ? 'brazier' : 'far';
      }
      const tourTeam: TeamId =
        cameraMode === 'tour' ? (mode === 'brazier' ? TEAM_FROST : mode === 'stand' ? TEAM_FROST : TEAM_EMBER) : lookTeam;
      if (mode === 'stand') {
        target.x = stand(tourTeam).x;
        target.y = stand(tourTeam).y - 4;
        target.z = stand(tourTeam).z;
        orbit(camera, target, 34, 7, timeS, 50);
      } else if (mode === 'brazier') {
        target.x = brazier(tourTeam).x;
        target.y = brazier(tourTeam).y - 1;
        target.z = brazier(tourTeam).z;
        orbit(camera, target, 40, 9, timeS, 50);
      } else if (mode === 'carrier') {
        const ember = relay.shards[TEAM_EMBER];
        chase(camera, ember !== undefined && ember.status === SHARD_CARRIED ? FROST_RUNNER : EMBER_RUNNER);
      } else if (mode === 'drop') {
        orbit(camera, dropSpot, 46, 6, timeS, 50);
      } else if (mode === 'far') {
        // From beyond the middle of the map, above the spires: can the base be found from here?
        const away = Math.hypot(world.centerX - stand(tourTeam).x, world.centerZ - stand(tourTeam).z) || 1;
        eye.x = world.centerX + ((world.centerX - stand(tourTeam).x) / away) * 220;
        eye.y = stand(tourTeam).y + 110;
        eye.z = world.centerZ + ((world.centerZ - stand(tourTeam).z) / away) * 220;
        aim(camera, eye, stand(tourTeam), 60);
      } else {
        eye.x = world.centerX + 120;
        eye.y = world.ceilingY + 260;
        eye.z = world.centerZ + 40;
        target.x = world.centerX;
        target.y = stand(TEAM_EMBER).y;
        target.z = world.centerZ;
        aim(camera, eye, target, 70);
      }
      return true;
    },
  });
  let scriptClock = 0;

  const probe = { scriptS: 0, ember: SHARD_HOME, frost: SHARD_HOME, drawCalls: 0, triangles: 0 };
  Reflect.set(window, '__relay', probe);
  harness.setInfo(`cam=${cameraMode} relay=${relayOn ? 'on' : 'off'}`);

  harness.run((dtS, timeS) => {
    scriptClock = timeS;
    play(timeS);
    beginWorldView(view);
    view.localDragonId = localId;
    for (let id = 0; id < NAMES.length; id++) {
      const at = position[id];
      if (at === undefined) continue;
      const dragon = acquireDragonView(view);
      const yaw = heading[id] ?? 0;
      const carrying =
        (id === EMBER_RUNNER && relay.shards[TEAM_FROST]?.status === SHARD_CARRIED) ||
        (id === FROST_RUNNER && relay.shards[TEAM_EMBER]?.status === SHARD_CARRIED);
      dragon.id = id;
      dragon.team = id < TEAM_SIZE ? TEAM_EMBER : TEAM_FROST;
      dragon.classId = CLASSES[id] ?? 'talon';
      dragon.position.x = at.x;
      dragon.position.y = at.y;
      dragon.position.z = at.z;
      dragon.orientation.x = 0;
      dragon.orientation.y = Math.sin(yaw * 0.5);
      dragon.orientation.z = 0;
      dragon.orientation.w = Math.cos(yaw * 0.5);
      dragon.velocity.x = Math.sin(yaw) * 34;
      dragon.velocity.y = 0;
      dragon.velocity.z = Math.cos(yaw) * 34;
      dragon.health = alive[id] === true ? 0.8 : 0;
      dragon.stamina = 0.7;
      // The carrier's price shows on its HUD like any slow.
      dragon.flags = alive[id] === true ? DRAGON_FLAG_ALIVE | (carrying ? DRAGON_FLAG_SLOWED : 0) : 0;
      dragon.anim = DRAGON_ANIM_GLIDE;
    }
    const wall = acquireZoneView(view);
    wall.id = 0;
    wall.kind = 'stormWall';
    wall.team = null;
    wall.position.x = world.centerX;
    wall.position.y = 0;
    wall.position.z = world.centerZ;
    wall.radius = map.colliders.stormRadius;

    view.clock.phase = 'playing';
    view.clock.round = 1;
    view.clock.tick = Math.round(timeS * TICK_HZ);
    view.clock.phaseTimeS = timeS;
    view.clock.timeRemainingS = Math.max(0, 600 - timeS);
    if (relay.active) writeRelayView(view, relay, view.clock.tick);

    bus.flush();
    input.cameraYaw = cameraYaw;
    input.scoreEmber = 1;
    input.scoreFrost = 1 + scoreFrost;
    builder.frame(dtS, input);
    hud?.update(builder.hud);

    const info = harness.renderer.webgl.info.render;
    probe.scriptS = scriptS;
    probe.ember = relay.shards[TEAM_EMBER]?.status ?? SHARD_HOME;
    probe.frost = relay.shards[TEAM_FROST]?.status ?? SHARD_HOME;
    probe.drawCalls = info.calls;
    probe.triangles = info.triangles;
    return frame;
  });
}
