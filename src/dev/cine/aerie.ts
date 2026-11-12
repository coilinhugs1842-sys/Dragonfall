/**
 * `?viewer=cine:aerie`: the lobby scene (src/cinematics/aerie) on its own, driven by a made-up
 * lobby instead of a room.
 *   &n=<0..10>        riders (default 10), seated Ember / Frost in turn
 *   &join=1           they join one by one instead of all being there on the first frame
 *   &ready=1          they ready up one after another from t = 1 s (&ready=all: ready at once)
 *   &focus=<index>    close-up on that rider (&focusAt=<s> to start it later, default at once)
 *   &launch=1         the host starts at t = 2 s (&launchAt=<s>); afterwards the lobby reopens
 *   &reduce=1         the reduce-motion version
 *   &class=<id>       everyone rides this class (default: the four classes in turn)
 *   &swap=1           rider 0 picks the next class every 3 s
 *   &leave=1          the last rider leaves at t = 3 s and comes back at t = 7 s
 *   &move=1           rider 1 changes perch at t = 3 s
 *   &local=<index>    which rider is "us" (default 0; -1 = a spectator)
 *   &plates=0         no name cards
 *   &freeze=<s>       stop the lobby's clock at this time (for screenshots of one moment)
 *   &cam=x,y,z,tx,ty,tz[,fov]   a fixed scouting camera, in the aerie's own frame
 * The caption shows the set's draw calls and triangles and the whole frame's.
 */
import type { PerspectiveCamera } from 'three';
import { aerieToWorld, createAerie, createAerieLayout } from '../../cinematics/aerie';
import type { AerieSetStats } from '../../cinematics/aerie';
import type { MutableLobbyPlate } from '../../cinematics/types';
import {
  BOT_RIDER_NAMES,
  DEFAULT_HOST_SETTINGS,
  DRAGON_CLASS_IDS,
  MATCH_TUNING,
  MAX_TEAM_SIZE,
  NO_PLAYER,
  QUALITY_PRESETS,
  TEAMS,
  TEAM_EMBER,
  TEAM_FROST,
  createVec3,
} from '../../shared';
import type { DragonClassId, LobbyPhase, LobbySide, PlayerId } from '../../shared';
import type { CineFrame, CineHarness } from '../cine-viewer';

/** The lobby types are read-only on purpose; the viewer owns these objects and edits them. */
interface FakePlayer {
  id: PlayerId;
  name: string;
  side: LobbySide;
  perch: number;
  classId: DragonClassId;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
  reconnectDeadlineTick: number;
  isBot: boolean;
}

interface FakeLobby {
  roomCode: string;
  phase: LobbyPhase;
  hostId: PlayerId;
  players: FakePlayer[];
  settings: typeof DEFAULT_HOST_SETTINGS;
}

const JOIN_EVERY_S = 1.1;
const READY_FROM_S = 1;
const READY_EVERY_S = 0.45;
/** Seconds of empty sky after the launch before the lobby reopens (the "back from a match" case). */
const AFTER_LAUNCH_S = 1.5;

function numberParam(params: URLSearchParams, key: string, fallback: number): number {
  const value = Number(params.get(key) ?? '');
  return params.has(key) && Number.isFinite(value) ? value : fallback;
}

function isClassId(value: string | null): value is DragonClassId {
  return value !== null && (DRAGON_CLASS_IDS as readonly string[]).includes(value);
}

export function start(harness: CineHarness): void {
  const params = harness.params;
  const aerie = createAerie({
    map: harness.map,
    quality: QUALITY_PRESETS[harness.renderer.presetId],
    webgl: harness.renderer.webgl,
  });
  aerie.setReduceMotion(params.get('reduce') === '1');
  harness.stage.setLobbySet(aerie.object);
  harness.renderer.onPresetChange((id) => {
    aerie.setQuality(QUALITY_PRESETS[id]);
  });

  const scout = (params.get('cam') ?? '').split(',').map(Number);
  const scouting = scout.length >= 6 && scout.every(Number.isFinite);
  if (scouting) {
    const layout = createAerieLayout(harness.map);
    const [x = 0, y = 0, z = 0, tx = 0, ty = 0, tz = 0, fov = 40] = scout;
    const eye = aerieToWorld(layout, x, y, z, createVec3());
    const target = aerieToWorld(layout, tx, ty, tz, createVec3());
    harness.setDirector({
      direct(camera: PerspectiveCamera, view, dtS): boolean {
        // The aerie still runs (it animates the set); the scouting pose then replaces its shot.
        aerie.direct(camera, view, dtS);
        camera.position.set(eye.x, eye.y, eye.z);
        camera.lookAt(target.x, target.y, target.z);
        camera.fov = fov;
        camera.updateProjectionMatrix();
        return true;
      },
    });
  } else {
    harness.setDirector(aerie);
  }

  const count = Math.min(Math.max(Math.round(numberParam(params, 'n', MAX_TEAM_SIZE * 2)), 0), MAX_TEAM_SIZE * 2);
  const join = params.get('join') === '1';
  const readyMode = params.get('ready');
  const focusIndex = Math.round(numberParam(params, 'focus', -1));
  const focusAtS = numberParam(params, 'focusAt', 0);
  const launch = params.get('launch') === '1';
  const launchAtS = numberParam(params, 'launchAt', 2);
  const freezeAtS = numberParam(params, 'freeze', Infinity);
  const swap = params.get('swap') === '1';
  const leave = params.get('leave') === '1';
  const move = params.get('move') === '1';
  const localIndex = Math.round(numberParam(params, 'local', 0));
  const localId: PlayerId = localIndex >= 0 && localIndex < count ? localIndex : NO_PLAYER;
  const classParam = params.get('class');
  const forcedClass = isClassId(classParam) ? classParam : null;

  // Every rider the scene can have; `lobby.players` holds the ones that are in the room now.
  const roster: FakePlayer[] = [];
  for (let i = 0; i < count; i++) {
    roster.push({
      id: i,
      name: BOT_RIDER_NAMES[i % BOT_RIDER_NAMES.length] ?? 'Rider',
      side: i % 2 === 0 ? TEAM_EMBER : TEAM_FROST,
      perch: i >> 1,
      classId: forcedClass ?? DRAGON_CLASS_IDS[(i + (i >> 1)) % DRAGON_CLASS_IDS.length] ?? 'talon',
      ready: false,
      isHost: i === 0,
      connected: true,
      reconnectDeadlineTick: -1,
      isBot: i !== 0,
    });
  }
  const lobby: FakeLobby = {
    roomCode: 'AERIE',
    phase: 'lobby',
    hostId: 0,
    players: [],
    settings: DEFAULT_HOST_SETTINGS,
  };

  // --- Name cards: plain DOM labels, enough to judge the anchors ---------------------------------
  const plates: MutableLobbyPlate[] = [];
  const labels: HTMLDivElement[] = [];
  const showPlates = params.get('plates') !== '0';
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  if (showPlates) harness.uiRoot.appendChild(layer);
  for (let i = 0; i < count; i++) {
    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute;left:0;top:0;padding:1px 7px;border-radius:3px;white-space:nowrap;' +
      'font:600 12px/1.5 system-ui,sans-serif;color:#fff6e8;background:rgba(20,24,36,0.72);' +
      'border-bottom:2px solid #fff;transform-origin:50% 100%;display:none;';
    layer.appendChild(label);
    labels.push(label);
  }

  const frame: CineFrame = { kind: 'lobby', view: aerie.view };
  const stats = aerie.object.userData['aerieStats'] as AerieSetStats | undefined;
  const info = harness.renderer.webgl.info.render;
  let shownSecond = -1;
  let focused = false;

  harness.run((frameDtS, harnessTimeS) => {
    // `&freeze=`: the lobby's own clock stops there (the camera and the clips play on), so a
    // capture script gets the same moment however long the page took to load.
    const timeS = harnessTimeS < freezeAtS ? harnessTimeS : freezeAtS;
    const dtS = harnessTimeS < freezeAtS ? frameDtS : 0;

    // --- Who is in the room, and in which state ---------------------------------------------------
    let phase: LobbyPhase = 'lobby';
    if (launch) {
      const period = launchAtS + MATCH_TUNING.lobbyLaunchS + AFTER_LAUNCH_S;
      const cycleS = timeS % period;
      if (cycleS >= launchAtS + MATCH_TUNING.lobbyLaunchS) phase = 'inMatch';
      else if (cycleS >= launchAtS) phase = 'starting';
    }
    lobby.phase = phase;
    lobby.players.length = 0;
    for (let i = 0; i < roster.length; i++) {
      const player = roster[i];
      if (player === undefined) continue;
      if (join && timeS < i * JOIN_EVERY_S) continue;
      if (leave && i === roster.length - 1 && timeS >= 3 && timeS < 7) continue;
      if (readyMode === 'all') player.ready = true;
      else if (readyMode === '1') player.ready = timeS >= READY_FROM_S + i * READY_EVERY_S;
      if (swap && i === 0 && forcedClass === null) {
        player.classId = DRAGON_CLASS_IDS[Math.floor(timeS / 3) % DRAGON_CLASS_IDS.length] ?? 'talon';
      }
      if (move && i === 1) player.perch = timeS >= 3 ? MAX_TEAM_SIZE - 1 : 0;
      lobby.players.push(player);
    }

    aerie.update(lobby, localId, dtS);
    if (focusIndex >= 0 && !focused && timeS >= focusAtS) {
      aerie.focus(focusIndex);
      // A rider who has not joined yet cannot be framed: try again next frame.
      focused = aerie.focusId === focusIndex;
    }

    // --- Name cards (a dev overlay: the style strings are its own garbage) -------------------------
    if (showPlates) {
      // One frame late (the camera of the frame before): fine for judging the anchors.
      const live = aerie.writePlates(harness.stage.camera, plates);
      for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        const plate = i < live ? plates[i] : undefined;
        if (label === undefined) continue;
        if (plate === undefined || !plate.visible) {
          label.style.display = 'none';
          continue;
        }
        const player = roster[plate.playerId];
        const scale = Math.min(Math.max(plate.scale, 0.75), 1.6);
        label.style.display = 'block';
        label.textContent = player !== undefined ? `${player.name}${player.ready ? '  READY' : ''}` : '?';
        label.style.borderBottomColor =
          player !== undefined && player.side !== 'spectator'
            ? `#${TEAMS[player.side].color.toString(16).padStart(6, '0')}`
            : '#fff';
        label.style.transform =
          `translate(${(plate.x * layer.clientWidth).toFixed(1)}px,${(plate.y * layer.clientHeight).toFixed(1)}px) ` +
          `translate(-50%,-100%) scale(${scale.toFixed(3)})`;
      }
    }

    const second = Math.floor(timeS * 2);
    if (second !== shownSecond) {
      shownSecond = second;
      harness.setInfo(
        `${lobby.players.length} riders  ${phase}  launch=${aerie.launchProgress.toFixed(2)}  ` +
          `set[${stats?.state ?? '?'}] calls=${stats?.drawCalls ?? 0} tris=${stats?.triangles ?? 0}  ` +
          `frame calls=${info.calls} tris=${info.triangles}`,
      );
    }
    return frame;
  });
}
