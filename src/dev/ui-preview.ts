/**
 * Dev-only preview of the Phase 5 UI (T-5.2 .. T-5.6): mounts the real UI (`createUi`) and feeds
 * it hand-written UiStates, so every screen can be looked at without a room, a match or the 3D
 * aerie. Nothing here ships in the game flow; it is loaded on demand:
 *
 *   import('/src/dev/ui-preview.ts').then((m) =>
 *     m.startUiPreview(document.getElementById('ui'), new URLSearchParams('screen=aerie-host')));
 *
 * Parameters (all optional):
 *   screen   one of UI_PREVIEW_SCREENS (default `aerie-host`); `viewer=ui:<screen>` works too
 *   scale    interface size, 0.8 .. 1.3            motion=reduced   the reduce-motion setting
 *   markers=strong  the colour-blind markers       t        seconds to run the UI's clock ahead
 *   o        intro card opacity 0..1               fade     fade amount 0..1
 *   progress loading progress 0..1                 size     riders per team, 1..5
 *   still=1  name cards do not drift
 *   tab      `settings`: video | controls | audio | game
 *   pad=1    `settings`: a gamepad is connected     pad=0    no Gamepad API on this page
 *
 * Intents the UI sends are printed with `console.info` and otherwise ignored, except the few
 * that only change what this preview shows (focus a rider, ready, class, side).
 */

import type { DragonClassId } from '../shared/classes';
import type { LobbySide, PlayerId, TeamId } from '../shared/constants';
import { MAX_PLAYERS, MAX_TEAM_SIZE, NO_PLAYER, TEAM_EMBER, TEAM_FROST } from '../shared/constants';
import type { HostSettings, LobbyPhase, LobbyPlayer, LobbyState } from '../shared/lobby';
import { DEFAULT_HOST_SETTINGS } from '../shared/lobby';
import type { MatchPhase, MatchWinner } from '../shared/match';
import { MAPS, MODES } from '../shared/match';
import type {
  LoadingState,
  ResultsState,
  ScoreboardRow,
  SettingsState,
  UiIntent,
  UiScreen,
  UiState,
} from '../shared/ui';
import { DEFAULT_SETTINGS, HUD_DRAGON_TAGS } from '../shared/ui';
import { createSettingsStore, handleSettingsIntent } from '../game/settings';
import { createUi } from '../ui';
import type { Ui } from '../ui';
import { SHARD_CARRIED, SHARD_DROPPED } from '../shared/world-view';
import { createHudState, pushShardEvent } from '../ui/hud';
import type { MutableHudState } from '../ui/hud';
import { createSettingsPanel, isSettingsTab } from '../ui/settings';
import type { SettingsPanel } from '../ui/settings';
import { applyPageSettings } from '../ui/settings/page-settings';

export const UI_PREVIEW_SCREENS = [
  'aerie-host',
  'aerie-client',
  'aerie-focus',
  'aerie-rules',
  'aerie-starting',
  'lobby-flat',
  'intro',
  'intro-skip',
  'countdown',
  'results-win',
  'results-loss',
  'results-draw',
  'results-watch',
  'fade',
  'loading',
  'loading-over-match',
  // T-6.6 (accessibility sweep): the screens the list above did not reach.
  'title',
  'pause',
  'settings',
  // T-6.3 (Ember Relay): the HUD of a rider carrying the enemy shard, and that mode's results.
  'relay-hud',
  'results-relay',
  // T-6.6: the friend-or-foe markers over the dragons, drifting (`tags=0` shows the HUD without).
  'hud-tags',
] as const;
export type UiPreviewScreen = (typeof UI_PREVIEW_SCREENS)[number];

export interface UiPreview {
  readonly screen: UiPreviewScreen;
  /** Stops the frame loop and removes the UI. */
  stop(): void;
}

/** One preview at a time: starting another stops this one (hot reload, a second `--eval`). */
let running: UiPreview | null = null;

interface MutablePlate {
  playerId: PlayerId;
  x: number;
  y: number;
  scale: number;
  visible: boolean;
}

/** The fields this preview rewrites between frames. Structurally a UiState. */
interface MutableUiState {
  screen: UiScreen;
  connection: UiState['connection'];
  settings: SettingsState;
  lobby: LobbyState | null;
  loading: LoadingState | null;
  hud: MutableHudState | null;
  results: ResultsState | null;
  startBlocker: UiState['startBlocker'];
  playerPings: number[];
  aerie: boolean;
  lobbyPlates: MutablePlate[];
  lobbyPlateCount: number;
  lobbyFocusId: PlayerId;
  fade: number;
  pauseMenuOpen: boolean;
  settingsOpen: boolean;
  controls: UiState['controls'];
  gamepad: UiState['gamepad'];
}

// Ten riders: a host, four more people (one not ready, one reconnecting) and five bots.
const RIDERS: readonly {
  readonly name: string;
  readonly classId: DragonClassId;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly isBot: boolean;
}[] = [
  { name: 'Aman', classId: 'talon', ready: true, connected: true, isBot: false },
  { name: 'Kestrel', classId: 'wraith', ready: true, connected: true, isBot: false },
  { name: 'Wintermoon Vespa', classId: 'bastion', ready: false, connected: true, isBot: false },
  { name: 'Miro', classId: 'tempest', ready: true, connected: true, isBot: false },
  { name: 'Juno', classId: 'talon', ready: true, connected: false, isBot: false },
  { name: 'Ashka', classId: 'bastion', ready: true, connected: true, isBot: true },
  { name: 'Brennoch', classId: 'tempest', ready: true, connected: true, isBot: true },
  { name: 'Cindrael', classId: 'wraith', ready: true, connected: true, isBot: true },
  { name: 'Dravik', classId: 'talon', ready: true, connected: true, isBot: true },
  { name: 'Eskarin', classId: 'bastion', ready: true, connected: true, isBot: true },
];

/** Where the 3D aerie would put each perch on screen: Ember's arc at the left, Frost's at the right. */
const PERCH_X: readonly number[] = [0.44, 0.37, 0.31, 0.4, 0.26];
const PERCH_Y: readonly number[] = [0.52, 0.4, 0.58, 0.72, 0.3];

function clampNumber(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return value < min ? min : value > max ? max : value;
}

function screenOf(params: URLSearchParams): UiPreviewScreen {
  const viewer = params.get('viewer');
  const wanted =
    params.get('screen') ?? (viewer !== null && viewer.startsWith('ui:') ? viewer.slice(3) : '');
  const found = UI_PREVIEW_SCREENS.find((name) => name === wanted);
  return found ?? 'aerie-host';
}

function buildPlayers(teamSize: number, localId: PlayerId): LobbyPlayer[] {
  const players: LobbyPlayer[] = [];
  for (let i = 0; i < RIDERS.length; i++) {
    const rider = RIDERS[i];
    if (rider === undefined) continue;
    const team: TeamId = i % 2 === 0 ? TEAM_EMBER : TEAM_FROST;
    const perch = Math.floor(i / 2);
    if (perch >= teamSize) continue;
    players.push({
      id: i,
      name: rider.name,
      side: team,
      perch,
      classId: rider.classId,
      ready: rider.ready,
      isHost: i === 0,
      connected: rider.connected,
      reconnectDeadlineTick: rider.connected ? -1 : 900,
      isBot: rider.isBot,
    });
  }
  // Two people watching, so the watchers box is not empty.
  players.push(watcher(20, 'Oriel'), watcher(21, 'Tavish'));
  // The local player must exist even in a 1v1 preview.
  if (!players.some((player) => player.id === localId)) return buildPlayers(MAX_TEAM_SIZE, localId);
  return players;
}

function watcher(id: PlayerId, name: string): LobbyPlayer {
  return {
    id,
    name,
    side: 'spectator',
    perch: -1,
    classId: 'talon',
    ready: false,
    isHost: false,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: false,
  };
}

function buildLobby(
  phase: LobbyPhase,
  players: readonly LobbyPlayer[],
  settings: HostSettings,
): LobbyState {
  return { roomCode: 'K7WQD', phase, hostId: 0, players, settings };
}

function buildScoreboard(): ScoreboardRow[] {
  // [takedowns, deaths, assists, damage] per rider, in RIDERS order.
  const stats: readonly (readonly [number, number, number, number])[] = [
    [9, 4, 6, 2140],
    [7, 5, 3, 1985],
    [4, 6, 9, 1320],
    [11, 3, 2, 2410],
    [3, 7, 5, 990],
    [5, 5, 4, 1475],
    [6, 6, 1, 1610],
    [2, 8, 7, 870],
    [8, 4, 3, 1890],
    [1, 9, 2, 640],
  ];
  const rows: ScoreboardRow[] = [];
  for (let i = 0; i < RIDERS.length; i++) {
    const rider = RIDERS[i];
    const line = stats[i];
    if (rider === undefined || line === undefined) continue;
    rows.push({
      playerId: i,
      name: rider.name,
      team: i % 2 === 0 ? TEAM_EMBER : TEAM_FROST,
      classId: rider.classId,
      takedowns: line[0],
      deaths: line[1],
      assists: line[2],
      damage: line[3],
      pingMs: 20 + i * 7,
      alive: true,
    });
  }
  return rows;
}

/**
 * The `hud-tags` preview: where the nine other dragons' markers stand (picture fractions), by
 * RIDERS index. Even indices are the local rider's team mates, odd ones the enemies: two mates
 * near (named), one far, one far and aimed at; enemies near, far, and one fading at its range.
 */
const TAG_PREVIEW: readonly (readonly [x: number, y: number, near: boolean, opacity: number])[] = [
  [0, 0, false, 0],
  [0.62, 0.36, true, 1],
  [0.3, 0.46, true, 1],
  [0.74, 0.3, false, 1],
  [0.2, 0.3, false, 0.85],
  [0.8, 0.52, true, 1],
  [0.5, 0.42, true, 1],
  [0.56, 0.26, false, 0.35],
  [0.4, 0.62, true, 1],
  [0.68, 0.44, false, 1],
];

/** Shards captured per rider in the Ember Relay previews, in RIDERS order. */
const RELAY_CAPTURES: readonly number[] = [2, 0, 0, 1, 1, 0, 0, 0, 0, 0];

function buildResults(winner: MatchWinner): ResultsState {
  const scoreboard = buildScoreboard();
  if (winner === 'draw') {
    // A draw where one rider holds two awards and nobody is the MVP.
    return {
      winner,
      scores: [24, 24],
      mvpId: NO_PLAYER,
      mostTakedownsId: 3,
      mostDamageId: 3,
      scoreboard,
    };
  }
  return {
    winner,
    scores: winner === TEAM_EMBER ? [30, 26] : [26, 30],
    mvpId: winner === TEAM_EMBER ? 0 : 3,
    mostTakedownsId: 3,
    mostDamageId: winner === TEAM_EMBER ? 3 : 0,
    scoreboard,
  };
}

/**
 * Mounts the real UI into `uiRoot` and keeps feeding it the state `params` describes until
 * `stop()` is called. Calling it again stops the preview that was running.
 */
export function startUiPreview(uiRoot: HTMLElement, params: URLSearchParams): UiPreview {
  running?.stop();
  const screen = screenOf(params);
  const scale = clampNumber(params.get('scale'), 1, 0.5, 2);
  const reduceMotion = params.get('motion') === 'reduced';
  const strongMarkers = params.get('markers') === 'strong';
  const aheadMs = clampNumber(params.get('t'), 0, 0, 600) * 1000;
  const still = params.get('still') === '1';
  const teamSize = Math.round(clampNumber(params.get('size'), MAX_TEAM_SIZE, 1, MAX_TEAM_SIZE));

  const page = document.documentElement;
  applyPageSettings(page, scale, strongMarkers, reduceMotion);

  const isHost = screen !== 'aerie-client';
  const localId: PlayerId = screen === 'results-watch' ? 20 : isHost ? 0 : 3;
  const settings: SettingsState = {
    ...DEFAULT_SETTINGS,
    uiScale: scale,
    reduceMotion,
    colorBlindMarkers: strongMarkers,
  };
  const hostSettings: HostSettings = { ...DEFAULT_HOST_SETTINGS, teamSize };
  let players = buildPlayers(teamSize, localId);
  const lobbyPhase: LobbyPhase = screen === 'aerie-starting' ? 'starting' : 'lobby';

  const plates: MutablePlate[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    plates.push({ playerId: NO_PLAYER, x: 0, y: 0, scale: 1, visible: false });
  }

  const state: MutableUiState = {
    screen: 'lobby',
    connection: {
      status: 'connected',
      isHost,
      localPlayerId: localId,
      pingMs: isHost ? 0 : 38,
      error: null,
    },
    settings,
    lobby: buildLobby(lobbyPhase, players, hostSettings),
    loading: null,
    hud: null,
    results: null,
    startBlocker: isHost ? 'notAllReady' : null,
    playerPings: [0, 24, 61, 38, -1, 0, 0, 0, 0, 0],
    aerie: screen.startsWith('aerie'),
    lobbyPlates: plates,
    lobbyPlateCount: 0,
    lobbyFocusId: screen === 'aerie-focus' ? 1 : NO_PLAYER,
    fade: 0,
    pauseMenuOpen: false,
    settingsOpen: false,
    controls: undefined,
    gamepad: undefined,
  };

  const hud = createHudState(MAX_PLAYERS);
  const matchPhase = (phase: MatchPhase): void => {
    state.screen = 'match';
    state.hud = hud;
    hud.phase = phase;
    hud.mode = hostSettings.mode;
    hud.scoreLimit = hostSettings.scoreLimit;
    hud.timeRemainingS = hostSettings.timeLimitS;
    hud.localPlayerId = localId;
    hud.local = localId === 20 ? null : hud.localPool;
    hud.reticle = hud.reticlePool;
    hud.reticlePool.locked = true;
    const rows = buildScoreboard();
    hud.scoreboardCount = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const out = hud.scoreboard[i];
      if (row !== undefined && out !== undefined) Object.assign(out, row);
    }
  };
  /** `tags=<n>`: only the first n markers (0 = none), to compare the cost of the HUD with and without. */
  const tagLimit = clampNumber(params.get('tags'), HUD_DRAGON_TAGS, 0, HUD_DRAGON_TAGS);
  /** The markers of `hud-tags`, each drifting in a small circle like a dragon in flight. */
  const placeTags = (timeS: number): void => {
    for (let i = 0; i < hud.dragonTags.length; i++) {
      const tag = hud.dragonTags[i];
      const spot = TAG_PREVIEW[i];
      const rider = RIDERS[i];
      if (tag === undefined) continue;
      tag.shown = i <= tagLimit && spot !== undefined && rider !== undefined && i !== localId && spot[3] > 0;
      if (!tag.shown || spot === undefined || rider === undefined) continue;
      const foe = i % 2 === 1;
      tag.team = foe ? TEAM_FROST : TEAM_EMBER;
      tag.foe = foe;
      tag.near = spot[2];
      tag.name = foe || !spot[2] ? '' : rider.name;
      tag.x = spot[0] + Math.sin(timeS * 0.9 + i) * 0.03;
      tag.y = spot[1] + Math.cos(timeS * 0.7 + i * 2) * 0.03;
      tag.opacity = spot[3];
    }
  };
  const showIntroCard = (opacity: number): void => {
    hud.introCard = hud.introCardPool;
    hud.introCardPool.mapName = MAPS[hostSettings.map].name;
    hud.introCardPool.modeName = MODES[hostSettings.mode].name;
    hud.introCardPool.opacity = opacity;
  };

  switch (screen) {
    case 'intro':
      matchPhase('intro');
      showIntroCard(clampNumber(params.get('o'), 1, 0, 1));
      break;
    case 'intro-skip':
      matchPhase('intro');
      hud.canSkipIntro = true;
      showIntroCard(clampNumber(params.get('o'), 1, 0, 1));
      break;
    case 'countdown':
      matchPhase('countdown');
      hud.countdown = 3;
      break;
    case 'results-win':
    case 'results-watch':
      matchPhase('results');
      state.results = buildResults(TEAM_EMBER);
      hud.scores = [30, 26];
      break;
    case 'results-loss':
      matchPhase('results');
      state.results = buildResults(TEAM_FROST);
      hud.scores = [26, 30];
      break;
    case 'results-draw':
      matchPhase('results');
      state.results = buildResults('draw');
      hud.scores = [24, 24];
      break;
    case 'fade':
      matchPhase('playing');
      state.fade = clampNumber(params.get('fade'), 0.5, 0, 1);
      break;
    case 'loading':
      state.screen = 'loading';
      state.loading = {
        progress: clampNumber(params.get('progress'), 0.4, 0, 1),
        label: 'Waking the dragons…',
      };
      break;
    case 'loading-over-match':
      matchPhase('playing');
      state.loading = {
        progress: clampNumber(params.get('progress'), 0.4, 0, 1),
        label: `Charting ${MAPS[hostSettings.map].name}…`,
      };
      break;
    case 'title':
    case 'settings':
      state.screen = 'title';
      state.lobby = null;
      state.connection = { ...state.connection, status: 'offline', isHost: false };
      state.settingsOpen = screen === 'settings';
      break;
    case 'pause':
      matchPhase('playing');
      state.pauseMenuOpen = true;
      break;
    case 'relay-hud': {
      // Ember Relay: the local rider carries the Frost shard home while its own lies dropped.
      matchPhase('playing');
      hud.mode = 'emberRelay';
      hud.scoreLimit = 3;
      hud.scores = [2, 1];
      for (let i = 0; i < hud.scoreboardCount; i++) {
        const row = hud.scoreboard[i];
        if (row !== undefined) row.captures = RELAY_CAPTURES[i] ?? 0;
      }
      const relay = hud.relayPool;
      relay.shards[TEAM_EMBER].status = SHARD_DROPPED;
      relay.shards[TEAM_EMBER].returnInS = 14;
      relay.shards[TEAM_FROST].status = SHARD_CARRIED;
      relay.shards[TEAM_FROST].carrierName = RIDERS[0]?.name ?? '';
      relay.carrying = localId === 0;
      relay.brazierDistanceM = 640;
      hud.relay = relay;
      pushShardEvent(hud, 'pickedUp', TEAM_FROST, 0, RIDERS[0]?.name ?? '', TEAM_EMBER);
      pushShardEvent(hud, 'dropped', TEAM_EMBER, 3, RIDERS[3]?.name ?? '', TEAM_FROST);
      // The own shard where it fell, and the way home.
      const fallen = hud.compass[0];
      const home = hud.compass[1];
      if (fallen !== undefined && home !== undefined) {
        fallen.kind = 'shard';
        fallen.team = TEAM_EMBER;
        fallen.angle = 0.45;
        fallen.distanceM = 310;
        fallen.alive = true;
        home.kind = 'brazier';
        home.team = TEAM_EMBER;
        home.angle = -0.25;
        home.distanceM = 640;
        home.alive = true;
        hud.compassCount = 2;
      }
      break;
    }
    case 'hud-tags':
      matchPhase('playing');
      placeTags(0);
      break;
    case 'results-relay': {
      matchPhase('results');
      hud.mode = 'emberRelay';
      hud.scoreLimit = 3;
      hud.scores = [3, 1];
      const base = buildResults(TEAM_EMBER);
      state.results = {
        ...base,
        mode: 'emberRelay',
        scores: [3, 1],
        mostCapturesId: 0,
        scoreboard: base.scoreboard.map((row, i) => ({ ...row, captures: RELAY_CAPTURES[i] ?? 0 })),
      };
      break;
    }
    default:
      break;
  }

  // The settings panel is its own root beside the UI, as in the game. Here it runs on a store
  // that lives in memory, so sliders and rebinding work and nothing is saved.
  let panel: SettingsPanel | null = null;
  const store = screen === 'settings' ? createSettingsStore({ storage: null }) : null;
  const padParam = params.get('pad');
  const syncSettings = (): void => {
    if (store === null) return;
    state.settings = {
      ...store.settings,
      uiScale: scale,
      reduceMotion,
      colorBlindMarkers: strongMarkers,
    };
    state.controls = store.controls;
    state.gamepad = {
      supported: padParam !== '0',
      secure: padParam !== '0',
      connected: padParam === '1',
      name: padParam === '1' ? 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)' : '',
      standard: true,
      controls: store.gamepadControls,
      pressCode: '',
      pressSeq: 0,
    };
  };
  syncSettings();

  const replacePlayer = (id: PlayerId, change: Partial<LobbyPlayer>): void => {
    players = players.map((player) => (player.id === id ? { ...player, ...change } : player));
    state.lobby = buildLobby(lobbyPhase, players, hostSettings);
  };
  const onIntent = (intent: UiIntent): void => {
    console.info('[ui-preview] intent', JSON.stringify(intent));
    if (store !== null) {
      handleSettingsIntent(store, intent, {
        close: () => {
          state.settingsOpen = false;
        },
      });
      syncSettings();
    }
    switch (intent.type) {
      case 'lobby.focusPlayer':
        state.lobbyFocusId = intent.playerId ?? NO_PLAYER;
        break;
      case 'lobby.ready':
        replacePlayer(localId, { ready: intent.ready });
        break;
      case 'lobby.pickClass':
        replacePlayer(localId, { classId: intent.classId });
        break;
      case 'lobby.switchSide': {
        const side: LobbySide = intent.side;
        replacePlayer(localId, { side, perch: side === 'spectator' ? -1 : MAX_TEAM_SIZE - 1 });
        break;
      }
      default:
        break;
    }
  };

  const startMs = performance.now();
  // `t` runs the UI's clock ahead after its first frame, so that frame is "when the screen
  // appeared" and the next one is already `t` seconds into the results reveal.
  let clockAheadMs = 0;
  const ui: Ui = createUi(uiRoot, onIntent, {
    nameStore: { load: () => 'Aman', save: () => undefined },
    now: () => performance.now() + clockAheadMs,
  });

  /** Stand-in for the scene's perch projection: both arcs, drifting a little with the camera. */
  const placePlates = (timeS: number): void => {
    const focusId = state.lobbyFocusId;
    let count = 0;
    for (const player of players) {
      if (player.side !== TEAM_EMBER && player.side !== TEAM_FROST) continue;
      const plate = plates[count];
      if (plate === undefined) break;
      const perch = player.perch >= 0 ? player.perch % PERCH_X.length : 0;
      const baseX = PERCH_X[perch] ?? 0.4;
      const drift = still ? 0 : Math.sin(timeS * 0.5 + perch) * 0.012;
      plate.playerId = player.id;
      if (focusId === NO_PLAYER) {
        plate.x = (player.side === TEAM_EMBER ? baseX : 1 - baseX) + drift;
        plate.y = (PERCH_Y[perch] ?? 0.5) + (still ? 0 : Math.cos(timeS * 0.4 + perch) * 0.008);
        plate.scale = 1 - perch * 0.04;
        plate.visible = true;
      } else {
        // The close-up frames one perch: its card is larger, the others are off screen.
        plate.x = 0.5 + drift * 0.5;
        plate.y = 0.34;
        plate.scale = 1.4;
        plate.visible = player.id === focusId;
      }
      count++;
    }
    state.lobbyPlateCount = count;
  };

  let frame = 0;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    if (state.aerie) placePlates(still ? 0 : (performance.now() - startMs) / 1000);
    if (screen === 'hud-tags') placeTags(still ? 0 : (performance.now() - startMs) / 1000);
    ui.update(state);
    panel?.update(state);
    clockAheadMs = aheadMs;
    frame = requestAnimationFrame(tick);
  };
  if (store !== null) {
    panel = createSettingsPanel(uiRoot, onIntent);
    panel.update(state);
    const tab = params.get('tab');
    if (isSettingsTab(tab)) panel.open(tab);
  }
  tick();

  if (screen === 'aerie-rules') {
    // The drawer's state is local to the lobby screen, so the preview presses its button.
    const toggle = uiRoot.querySelector<HTMLButtonElement>('button[data-act="rulesToggle"]');
    toggle?.click();
  }

  const preview: UiPreview = {
    screen,
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      ui.dispose();
      panel?.dispose();
      if (running === preview) running = null;
    },
  };
  running = preview;
  return preview;
}
