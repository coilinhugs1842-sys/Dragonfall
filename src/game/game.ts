/**
 * The game controller: everything between the menus, the sessions and the 3D stage.
 *
 *   title -> (Host | Join by code | Fly solo) -> lobby -> match -> (leave | lost | host left)
 *         -> title
 *
 * ONE CODE PATH. Hosting, joining and flying solo all run a session from `src/net`:
 * - Host: a `HostHandle` (a `HostSession` plus the in-page bots of `?bots=N`) with the PeerJS
 *   transport as its link to real players.
 * - Fly solo: the same `HostHandle` with no transport at all. No network is touched, the room
 *   has one member and the match starts at once.
 * - Join: a `ClientSession` on the PeerJS transport.
 * The views cannot tell which one is running: each frame this file builds the same WorldView,
 * on the host from the two newest authoritative states and on a client from the session (own
 * dragon predicted and smoothed, the others interpolated from snapshots).
 *
 * WHERE THE HOST'S SIM RUNS is hidden behind `HostHandle` (`src/net/worker`): in a Web Worker
 * with its own 30 Hz clock by default, on this thread with `?noworker` or when the worker
 * cannot start. Nothing below asks which.
 *
 * POLLING, NOT CALLBACKS. The sessions change state inside transport callbacks and ticks. This
 * file does not react there: once per frame `syncRun` reads what the session says (state,
 * lobby, in a match or not) and moves the app state machine, the stage and the UiState to
 * match. A session that ended is torn down in the same place, so every exit goes through
 * `endRun` and frees the same things: bots, session, transports, match views, input.
 *
 * PER FIXED TICK (30 Hz, from the frame driver's loop), host on this thread only:
 *   `host.fixedStep()`: local input for tick T (devices or `?autopilot`) -> inputs of every
 *   rider -> sim.step -> snapshots out. A host worker runs the same step on its own timer.
 * PER FRAME:
 *   host:   pump netsim -> `host.update(now)` -> syncRun -> events -> buildWorldView +
 *           `appendHostEffects` (projectiles, zones, the local rider's combat state)
 *   client: pump netsim -> `client.advance(now, sampler)` (pings, due ticks: predict + send
 *           input) -> syncRun -> events -> `client.writeWorldView` -> the rider's own predicted
 *           casts shown and heard at once (`takeLocalCasts`)
 *   both:   stage update (camera, dragons, effects) -> aim for the next input sample -> audio
 *           -> HUD state -> render -> UiState -> `ui.update` (+ the settings panel)
 *
 * EVENTS. Every GameEvent of the match lands in ONE bus on this page, whatever the session:
 * the host session emits into it on this thread, a host worker's batches are decoded into it,
 * a client's GAME_EVENTS messages are. It is flushed once per frame, before the WorldView is
 * built; the effects, the audio and the HUD feed subscribe while a match is loaded.
 * WHILE THE TAB IS HIDDEN no frames run. `background()` (about once a second, from the frame
 * driver's timer) keeps a client's link alive instead: pings out, reconnect if it drops. A
 * host needs nothing here: its worker has its own clock, and on the main thread its transport
 * callbacks answer pings by themselves.
 */

import type { AudioEngine } from '../audio';
import { createFlightOverlay, createInputController, isActionActive } from '../input';
import type { FlightOverlay, InputController } from '../input';
import {
  VIEW_EXTRAPOLATE_TICKS,
  appendHostEffects,
  createClientSession,
  createHost,
  createReconnectToken,
  formatNetRate,
  normalizeRoomCode,
} from '../net';
import type {
  ClientInputSampler,
  ClientSession,
  ClientTransport,
  HostAutoSettings,
  HostEffectsOptions,
  HostHandle,
  HostMetrics,
  HostTransport,
  LocalInputSource,
  LocalInputSubject,
  ReconnectTokenStore,
} from '../net';
import type { SnapshotOwner } from '../net/protocol';
import type { GameRenderer } from '../render';
import {
  ABILITY_SLOTS,
  ABILITY_TABLE,
  DRAGON_FLAG_ALIVE,
  FALLBACK_PLAYER_NAME,
  MAPS,
  MATCH_TUNING,
  MODES,
  NO_PLAYER,
  QUALITY_PRESETS,
  TICK_DT_S,
  TICK_HZ,
  DEFAULT_HOST_SETTINGS,
  DEFAULT_MAP_ID,
  matchSeedOfMap,
  copyInputFrame,
  createGameEventBus,
  createInputFrame,
  createVec3,
  beginWorldView,
  createWorldView,
  findDragonView,
  resetInputFrame,
} from '../shared';
import type {
  DragonClassId,
  GameEventBus,
  GameSettings,
  InputFrame,
  LobbyState,
  MatchPhase,
  MatchPhaseEvent,
  MatchPlayerStats,
  MatchWinner,
  ModeId,
  MutableWorldView,
  PlayerId,
  QualityPresetId,
  ResultsState,
  SettingsState,
  SettingsTab,
  UiError,
  UiIntent,
  Unsubscribe,
  Vec3,
  WorldView,
} from '../shared';
import { fireDirectionOf } from '../sim';
import { createModeConfig } from '../sim/match';
import { createUi } from '../ui';
import type { Ui } from '../ui';
import type { SettingsPanel } from '../ui/settings';
import { applyPageSettings } from '../ui/settings/page-settings';
import { codeShortLabel } from '../ui/settings/rebind-model';
import { App } from './app';
import type { AppStateId } from './app';
import { writeAutopilotFrame } from './autopilot';
import type { AutopilotCourse } from './autopilot';
import { createDebugProbe } from './debug-probe';
import type { DebugProbe, MotionReport } from './debug-probe';
import { hostWorkerSupported, spawnHostWorker } from './host-worker';
import { createHudBuilder, createHudFrameInput } from './hud-builder';
import type { HudBuilder } from './hud-builder';
import { createMatchAssetsCache } from './match-assets';
import type { MatchAssets } from './match-assets';
import { createShow } from './show';
import type { Show, ShowScene } from './show';
import { createStage } from './stage';
import type { CameraDirector, Stage } from './stage';
import {
  FrameCap,
  bindSettingsTargets,
  createGamepadLink,
  createSettingsNameStore,
  createSettingsStore,
  handleSettingsIntent,
} from './settings';
import type { GamepadLink, SettingsStore } from './settings';
import { createStorageTokenStore, loadClientId, readRejoin, writeRejoin } from './storage';
import {
  applySessionFacts,
  connectFailure,
  createSessionFacts,
  createUiState,
  peerConfigFor,
} from './ui-model';
import { writeViewPilotFrame } from './view-pilot';
import { buildWorldView } from './world-view-builder';
import type { StormWallSource } from './world-view-builder';

/** The circle the `?autopilot` pilot flies, relative to the storm centre. */
const AUTOPILOT_RADIUS = 380;
const AUTOPILOT_ALTITUDE = 400;
/** EMA weight for the HUD's per-tick cost figures. */
const COST_SMOOTHING = 0.05;
/** A gap between two frames longer than this makes the events queued meanwhile stale. */
const STALE_EVENTS_GAP_S = 0.5;
/** Keys with which a watcher follows the next rider (a click and a pad's A do the same). */
const WATCH_NEXT_CODES: readonly string[] = ['Space', 'ArrowRight'];
/**
 * Metres ahead of the camera at which shots cross the reticle (`InputFrame.aimYaw`): the camera
 * sits behind and above the dragon, so the aim is the direction from the dragon to this point
 * on the reticle's ray.
 */
const AIM_CONVERGENCE_M = 170;
/** Radius of the on-screen steering circle in CSS pixels (the HUD and the overlay draw it). */
const RETICLE_RADIUS_PX = 110;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Artificial network conditions for this page's transport (`dev/netsim` fits). `src/game` does
 * not import the dev tools: the boot code loads the chunk and hands the object in.
 */
export interface TransportShaper {
  wrapHost(inner: HostTransport): HostTransport;
  wrapClient(inner: ClientTransport): ClientTransport;
  /** Delivers what is due. Called once per frame. */
  pump(nowMs: number): number;
}

/** The URL switches the game layer reads (a subset of `dev/query-flags`). */
export interface GameFlags {
  readonly autopilot: boolean;
  /** `?autopilot=bot`: a fighting bot flies the local dragon (see `dev/query-flags`). */
  readonly autopilotBot?: boolean;
  /** `?quality=`: the settings store does not override a preset forced by the URL. */
  readonly forcedQuality?: QualityPresetId | null;
  /** `?mode=`, `?score=`, `?time=`, `?teamsize=`, `?botlevel=`, `?fill`: the host's room set-up. */
  readonly autoSettings?: HostAutoSettings | null;
  /** `?lagcomp=0`: host without lag compensation. */
  readonly lagCompensation?: boolean;
  /** `?join=CODE`: join this room at boot. */
  readonly joinCode?: string;
  readonly skipSeconds: number;
  readonly bots: number;
  readonly lan: boolean;
  readonly solo: boolean;
  readonly autostart: boolean;
  /** `?noworker`: run the host's sim on the main thread instead of in the host worker. */
  readonly noWorker: boolean;
  /**
   * False (`?nocine`, `?bench`): a hosted match starts at once, with no lobby launch and no
   * intro. The aerie, the death cam and the podium are views and stay. Default true.
   */
  readonly cinematics?: boolean;
  /** Measure per-tick cost and keep a debug probe (`?perf`, `?debug`, dev builds). */
  readonly measure: boolean;
}

export interface GameStorage {
  /** Settings and the rider name. */
  readonly local: Storage | null;
  /** Reconnect tokens and the rejoin record (per tab). */
  readonly session: Storage | null;
}

export interface GameOptions {
  /** The game canvas: pointer lock target. */
  readonly canvas: HTMLCanvasElement;
  /** `#ui`: menus and overlays mount here. */
  readonly uiRoot: HTMLElement;
  readonly renderer: GameRenderer;
  readonly flags: GameFlags;
  readonly storage: GameStorage;
  /** `location.hostname`: where LAN mode looks for the PeerServer. */
  readonly pageHostname: string;
  /** Monotonic milliseconds, e.g. `() => performance.now()`. */
  readonly now: () => number;
  /** Resolves with the netsim (or null) before the first transport is made. */
  readonly shaper?: Promise<TransportShaper | null>;
  /** Settings > "Test again": run the automatic quality pick again (T-6.2, ./auto-quality-run.ts). */
  readonly onRetestQuality?: () => void;
}

/** What `Game.report` returns: a plain copy for the test driver and the devtools console. */
export interface GameReport {
  readonly app: AppStateId;
  readonly screen: string;
  readonly kind: string;
  readonly status: string;
  readonly error: UiError | null;
  readonly roomCode: string;
  readonly localPlayerId: PlayerId;
  readonly inMatch: boolean;
  readonly isRider: boolean;
  readonly phase: MatchPhase;
  /** What the cinematics run on: the host's clocks, and what this page made of them. */
  readonly show: {
    /** Seconds into `phase`, from the frame's WorldView. */
    readonly phaseTimeS: number;
    readonly lobbyPhase: string;
    /** The cream between scenes, 0..1. */
    readonly fade: number;
    /** The aerie is drawn behind the lobby. */
    readonly aerie: boolean;
    /** A cinematic placed this frame's camera. */
    readonly directed: boolean;
    readonly introCard: number;
    /** A scene is held under the cream until its shaders are compiled. */
    readonly warming: boolean;
    /** Shader warm-ups since the page loaded. */
    readonly warmUps: number;
    /** The map that is loaded and drawn ('' outside a match): proof of what a rejoin rebuilt. */
    readonly map: string;
    /** The rider a watcher's camera follows (`NO_PLAYER` for a rider, or with nobody to follow). */
    readonly watching: PlayerId;
  };
  /** The match clock and score as the HUD shows them. */
  readonly match: {
    readonly mode: string;
    readonly round: number;
    readonly scores: readonly [number, number];
    readonly scoreLimit: number;
    readonly timeRemainingS: number;
    readonly winner: MatchWinner | null;
    readonly stormRadius: number;
    readonly killfeed: readonly string[];
    readonly stats: readonly MatchPlayerStats[];
    readonly results: ResultsState | null;
    readonly projectiles: number;
    readonly zones: number;
    /** Events of each type delivered since the page loaded. */
    readonly events: Readonly<Record<string, number>>;
    /** Hits the local rider landed / took, and its own casts, since the page loaded. */
    readonly localHits: number;
    readonly localHitsTaken: number;
    readonly localCasts: number;
  };
  /** The local rider's HUD gauges, or null. */
  readonly local: {
    readonly classId: string;
    readonly alive: boolean;
    readonly health: number;
    readonly ultimateCharge: number;
    readonly cooldownS: readonly number[];
    readonly respawnInS: number;
  } | null;
  /** The newest local input sample. */
  readonly input: InputFrame;
  readonly camera: { readonly fov: number; readonly yaw: number };
  readonly vfx: {
    readonly particles: number;
    /** The map's own particles (vent streaks, ash); `peak` counts them too. */
    readonly map: number;
    readonly peak: number;
    readonly capacity: number;
    readonly drawCalls: number;
  } | null;
  readonly audio: {
    readonly voices: number;
    readonly peak: number;
    readonly capacity: number;
    readonly ready: boolean;
    /** The master gain node's live value (the master volume squared). */
    readonly masterGain: number;
    readonly errors: number;
    /** Sounds playing from decoded .ogg files / whose files failed (those stay procedural). */
    readonly samplesReady: number;
    readonly samplesFailed: number;
    /** Music and ambience tracks sounding, and the 0..1 intensity mixing the music layers. */
    readonly tracksPlaying: number;
    readonly intensity: number;
  } | null;
  readonly render: {
    readonly calls: number;
    readonly triangles: number;
    readonly preset: string;
    readonly scale: number;
  };
  readonly settings: SettingsState;
  /** Action id -> key codes, as the input layer has them. */
  readonly bindings: Readonly<Record<string, readonly string[]>>;
  readonly settingsOpen: boolean;
  /** Host: the host tick. Client: the snapshot playback tick (fractional). */
  readonly tick: number;
  readonly dragons: readonly {
    readonly id: PlayerId;
    readonly team: number;
    readonly classId: string;
    readonly local: boolean;
    readonly alive: boolean;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }[];
  readonly lobby: LobbyState | null;
  readonly host: {
    /** Where the sim runs: `worker`, or `direct` (this thread). */
    readonly mode: 'direct' | 'worker';
    readonly clients: number;
    readonly bots: number;
    readonly stepMs: number;
    readonly simMs: number;
    readonly snapshotMs: number;
    readonly maxStepMs: number;
    readonly upKBps: number;
    readonly downKBps: number;
    readonly malformed: number;
    /** Frames this page has drawn while hosting (to turn `metrics.mainMs` into ms per frame). */
    readonly frames: number;
    /** Every cost figure of the handle (see `HostMetrics`), copied. */
    readonly metrics: HostMetrics;
  } | null;
  readonly client: {
    readonly pingMs: number;
    readonly interpDelayMs: number;
    readonly lossPct: number;
    readonly snapshots: number;
    readonly starved: boolean;
    /** Frames drawn past the newest snapshot (extrapolating), and frames drawn in the match. */
    readonly starvedFrames: number;
    readonly matchFrames: number;
    readonly corrections: number;
    readonly snaps: number;
    readonly lastCorrectionM: number;
    readonly largestCorrectionM: number;
    readonly visualOffsetM: number;
    readonly inputMarginTicks: number;
    readonly timeScale: number;
    readonly resyncs: number;
    readonly reconnects: number;
    readonly upKBps: number;
    readonly downKBps: number;
    readonly malformed: number;
  } | null;
  readonly remoteMotion: MotionReport | null;
  readonly localMotion: MotionReport | null;
}

export interface Game {
  readonly app: App;
  /** Null unless `flags.measure`. */
  readonly probe: DebugProbe | null;
  /** One fixed 30 Hz step (the frame driver's loop calls it). Allocation-free. */
  fixedStep(): void;
  /** One rendered frame: sessions, WorldView, stage, draw, UI. Allocation-free. */
  frame(alpha: number, frameMs: number): void;
  /**
   * The beat of a hidden tab (about once a second, while no frames run): keeps a client's link
   * to the host alive. Allocation-free.
   */
  background(): void;
  /** Canvas width / height. */
  setAspect(aspect: number): void;
  /** Canvas size in CSS pixels (the reticle's place on screen, for the aim). */
  setViewportSize(width: number, height: number): void;
  /**
   * The "30 / 45 fps" cap: false = skip this animation-frame callback altogether. `nowMs` is
   * the callback's timestamp.
   */
  shouldRender(nowMs: number): boolean;
  /** The perf HUD's effect lines (particles alive, audio voices). Builds a string. */
  getFxText(): string;
  /** Every menu action arrives here; also callable by tests and the debug console. */
  handleIntent(intent: UiIntent): void;
  /** Averaged cost of the fixed-step work in ms, for the perf HUD's `sim` line. */
  getSimMs(): number;
  /** A match is on screen (its views are loaded and a picture was built this frame). */
  readonly inMatch: boolean;
  /**
   * The title screen is showing and nothing else is going on: no room, no solo flight, no host
   * or join attempt under way. The automatic quality pick (T-6.2) only measures while this holds.
   */
  readonly titleIdle: boolean;
  /** The player's settings as they stand (the store's own object: read it, do not keep it). */
  readonly settings: GameSettings;
  /** The middle of the arena at fight height: what a fly-round camera circles. */
  readonly arenaFocus: Readonly<Vec3>;
  /**
   * Most particles on screen (the effects' own plus the map's vent streaks and ash) and most
   * voices playing in one frame so far (needs `flags.measure`).
   */
  getPeaks(): { readonly particles: number; readonly voices: number };
  /**
   * Hands the camera to a dev tool (`?bench`, the trailer capture) or takes it back with null.
   * The game's own cinematics give way while one is set.
   */
  setDevCameraDirector(director: CameraDirector | null): void;
  /** The perf HUD's network lines ('' with no session). Builds strings: call at text rate. */
  getNetText(): string;
  /** A copy of the current state for tests. Allocates: never call it per frame. */
  report(): GameReport;
  /** `pagehide`: tells the other side and lets go, keeping what a reload needs to rejoin. */
  shutdown(): void;
  dispose(): void;
}

interface HostRun {
  readonly kind: 'host' | 'solo';
  /** The room: session, bots and sim, on this thread or in the host worker. */
  readonly session: HostHandle;
  /** The match begins some way in (`?skip`): place the camera when its views load. */
  snapOnLoad: boolean;
  wasOpen: boolean;
  /** Frames drawn while this run was live. */
  frames: number;
}

interface ClientRun {
  readonly kind: 'client';
  readonly session: ClientSession;
  readonly name: string;
  wasConnected: boolean;
}

type Run = HostRun | ClientRun;

/** `WorldViewBuildOptions` with the fields rewritten each frame. */
interface HostViewOptions {
  localDragonId: PlayerId;
  stormWall: StormWallSource | null;
  phase: MatchPhase;
  maxAlpha: number;
}

/** `HostEffectsOptions` with the fields rewritten each frame. */
interface MutableEffectsOptions {
  localDragonId: PlayerId;
  respawnDelayS: number;
}

/** What the page remembers about the match on screen (set when its views load). */
interface MatchFacts {
  mode: ModeId;
  scoreLimit: number;
  /** Seconds a dead dragon waits; Infinity while the mode has no respawns (Duel). */
  respawnDelayS: number;
  round: number;
  results: ResultsState | null;
}

/**
 * A cut held under the cream this long shows the loading card on top of it. Shorter loads (the
 * usual case: everything was fetched behind the title) pass as a plain fade.
 */
const LOADING_CARD_AFTER_S = 0.6;

const EVENT_TYPES = [
  'hit',
  'takedown',
  'spawn',
  'abilityCast',
  'objective',
  'matchPhase',
  'assist',
  'statusApplied',
  'impact',
] as const;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGame(options: GameOptions): Game {
  const { canvas, renderer, flags, storage, now } = options;
  const app = new App('title');
  const assets = createMatchAssetsCache();
  /** Every GameEvent of the match on screen (see the file header). */
  const bus: GameEventBus = createGameEventBus();
  const stage: Stage = createStage({
    quality: renderer.presetId,
    map: assets.defaultMap,
    events: bus,
    webgl: renderer.webgl,
    precompile: (scene, camera) => renderer.precompile(scene, camera),
  });
  /** The aerie, the intro, the death cam and the podium, and which of them has the camera. */
  const show: Show = createShow({
    stage,
    map: assets.defaultMap,
    quality: renderer.presetId,
    webgl: renderer.webgl,
  });
  const probe = flags.measure ? createDebugProbe() : null;
  const tokenStore: ReconnectTokenStore = createStorageTokenStore(storage.session);
  // One per browser, so a kick also keeps out a new tab that has no token.
  const clientId = loadClientId(storage.local, createReconnectToken());
  const shaperPromise: Promise<TransportShaper | null> = options.shaper ?? Promise.resolve(null);
  let shaper: TransportShaper | null = null;

  // --- Settings ------------------------------------------------------------------------------------
  const store: SettingsStore = createSettingsStore({ storage: storage.local });
  const forcedQuality = flags.forcedQuality ?? null;
  /**
   * What the menus show. `?lan` is not written into the store (it would be saved): it is laid
   * over the stored settings here, and read again when a room is hosted or joined.
   */
  function shownSettingsOf(): SettingsState {
    return flags.lan ? { ...store.settings, signaling: 'lan' } : store.settings;
  }
  let shownSettings: SettingsState = shownSettingsOf();
  const frameCap = new FrameCap();
  let settingsOpen = false;
  let settingsTab: SettingsTab = 'video';
  let settingsPanel: SettingsPanel | null = null;
  let settingsPanelLoading = false;
  let audio: AudioEngine | null = null;
  let audioUnsubscribe: Unsubscribe | null = null;
  let audioScene: 'title' | 'lobby' | 'match' = 'title';

  const facts = createSessionFacts();
  const uiState = createUiState(shownSettings);
  uiState.lobbyPlates = show.plates;
  let lastError: UiError | null = null;
  let pauseOpen = false;

  let run: Run | null = null;
  /** Bumped by every new attempt and every teardown; an async step that sees it moved stops. */
  let attempt = 0;
  /** An attempt is loading its chunks: there is no session object yet. */
  let pendingKind: 'none' | 'solo' | 'host' | 'client' = 'none';

  // --- Local input ---------------------------------------------------------------------------------
  const worldView: MutableWorldView = createWorldView();
  const hudBuilder: HudBuilder = createHudBuilder(worldView);
  const hudInput = createHudFrameInput();
  let hudUnsubscribe: Unsubscribe | null = null;
  const matchFacts: MatchFacts = {
    mode: 'skirmish',
    scoreLimit: 0,
    respawnDelayS: MATCH_TUNING.respawnDelayS,
    round: 1,
    results: null,
  };
  const effectsOptions: MutableEffectsOptions = {
    localDragonId: NO_PLAYER,
    respawnDelayS: MATCH_TUNING.respawnDelayS,
  };
  /** The newest local input sample (HUD button lights, the test report). */
  const lastInput: InputFrame = createInputFrame();
  let viewportWidth = 0;
  let viewportHeight = 0;
  let cameraYaw = 0;
  const shotDirection = createVec3();
  const listener = { position: createVec3(), forward: createVec3(), up: createVec3() };
  // Counters for the test driver.
  const eventCounts: Record<string, number> = {};
  for (const type of EVENT_TYPES) eventCounts[type] = 0;
  let localHits = 0;
  let localHitsTaken = 0;
  let localCastCount = 0;
  let particlePeak = 0;
  let voicePeak = 0;
  for (const type of EVENT_TYPES) {
    bus.on(type, () => {
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    });
  }
  bus.on('hit', (event) => {
    const me = uiState.connection.localPlayerId;
    if (me === NO_PLAYER) return;
    if (event.attackerId === me && event.targetId !== me) localHits++;
    if (event.targetId === me) {
      localHitsTaken++;
      // Does nothing unless the rumble setting is on and the player flies with a gamepad.
      if (event.damage > 0) input.rumble(0.5, 120);
    }
  });
  bus.on('takedown', (event) => {
    const me = uiState.connection.localPlayerId;
    if (me === NO_PLAYER) return;
    if (event.victimId === me) input.rumble(1, 320);
    else if (event.killerId === me) input.rumble(0.7, 200);
  });
  bus.on('abilityCast', (event) => {
    // A client counts its casts when its prediction fires them (`showLocalCasts`).
    const hosting = run !== null && run.kind !== 'client';
    if (hosting && event.dragonId === uiState.connection.localPlayerId) localCastCount++;
  });
  bus.on('matchPhase', (event: MatchPhaseEvent) => {
    // A new round starts clean: no smoke of the last one hanging over the gates.
    if (event.phase === 'countdown' && event.round !== matchFacts.round) stage.clearEffects();
    matchFacts.round = event.round;
  });
  const course: AutopilotCourse = {
    centerX: assets.defaultMap.colliders.stormCenter.x,
    centerZ: assets.defaultMap.colliders.stormCenter.z,
    radius: AUTOPILOT_RADIUS,
    altitude: AUTOPILOT_ALTITUDE,
  };
  const arenaFocus: Vec3 = { x: course.centerX, y: AUTOPILOT_ALTITUDE, z: course.centerZ };
  /** The rider classes of the match being loaded (the dragon rigs built at load). */
  const riderClasses: DragonClassId[] = [];
  /** The cover over a match that is still fetching or compiling (see `frame`). */
  const loadingState = { progress: 0, label: '' };
  /** The aerie is what this frame drew behind the lobby panels. */
  let lobbyOnScreen = false;
  /** `buildView` gave a match picture this frame. */
  let matchOnScreen = false;
  /** The local player's latest steer, for the camera's look-ahead. */
  let aimX = 0;
  let aimY = 0;
  let wasLocked = false;
  let inputActive = false;
  /** True while an intent raised by a gamepad button is being handled (see `frame`). */
  let padActing = false;
  let isRider = false;
  let matchAssets: MatchAssets | null = null;
  /** The map whose models were last asked for ahead of a match (the stage loads the default at boot). */
  let preloadedMap = DEFAULT_MAP_ID;

  const input: InputController = createInputController(canvas, {
    onLockChange: (locked: boolean): void => {
      // Esc while flying only releases the pointer (the browser keeps the key), so losing the
      // lock is what opens the escape menu.
      if (!locked && wasLocked && stage.matchLoaded && isRider) pauseOpen = true;
      wasLocked = locked;
    },
  });
  input.setEnabled(false);
  // A rider's steering ring and "click to fly" prompt are the HUD's; this overlay is only the
  // spectator's prompt.
  const watchOverlay: FlightOverlay = createFlightOverlay({
    promptText: 'Watching · click or press Space to follow the next rider',
  });
  watchOverlay.setVisible(false);
  watchOverlay.update(0, 0, false);
  let watchOverlayShown = false;

  /** Lobby spectator, or a rider out for the round (Duel): cycle the camera subject. */
  const canCycleWatch = (): boolean => {
    if (!stage.matchLoaded || pauseOpen || settingsOpen) return false;
    if (!isRider) return true;
    if (!worldView.local.valid || worldView.local.respawnInS !== Infinity) return false;
    const local = findDragonView(worldView, worldView.localDragonId);
    return local !== undefined && (local.flags & DRAGON_FLAG_ALIVE) === 0;
  };

  const onCanvasClick = (): void => {
    if (canCycleWatch()) stage.cycleSpectateTarget();
  };
  canvas.addEventListener('click', onCanvasClick);

  // The scoreboard is the `scoreboard` input action (rebindable, default Tab). While the pointer
  // is locked the input controller reads it with every other action; a spectator, a rider who is
  // down or anyone with the pointer free has no lock, so the same binding is read here.
  let scoreboardCodes: readonly string[] = [];
  let scoreboardKeyHeld = false;
  const boardKeyUsable = (): boolean =>
    stage.matchLoaded && !pauseOpen && !settingsOpen && !input.locked;
  const onBoardKeyDown = (event: KeyboardEvent): void => {
    // A watcher's Space (or right arrow) is the click on the picture: follow the next rider.
    if (
      !event.repeat &&
      WATCH_NEXT_CODES.includes(event.code) &&
      boardKeyUsable() &&
      canCycleWatch()
    ) {
      event.preventDefault();
      stage.cycleSpectateTarget();
      return;
    }
    if (!scoreboardCodes.includes(event.code) || !boardKeyUsable()) return;
    // Tab would otherwise walk the focus through the page behind the HUD.
    event.preventDefault();
    scoreboardKeyHeld = true;
  };
  const onBoardKeyUp = (event: KeyboardEvent): void => {
    if (scoreboardCodes.includes(event.code)) scoreboardKeyHeld = false;
  };
  const onBoardBlur = (): void => {
    scoreboardKeyHeld = false;
  };
  document.addEventListener('keydown', onBoardKeyDown);
  document.addEventListener('keyup', onBoardKeyUp);
  window.addEventListener('blur', onBoardBlur);

  /**
   * Writes the local player's input for one tick. `subject` is the own dragon, if any; `dtS`
   * is the time the sample covers (a tick, or a frame when the host worker is fed per frame).
   */
  function sampleLocal(
    tick: number,
    subject: LocalInputSubject | undefined,
    out: InputFrame,
    dtS: number,
  ): void {
    const current = run;
    if (flags.autopilotBot === true && current !== null && current.kind === 'client') {
      // A client has no sim state for the real bot brain: a simple pilot flies from the view.
      writeViewPilotFrame(tick, worldView, worldView.localDragonId, course, out);
    } else if (flags.autopilot) {
      writeAutopilotFrame(tick, subject, course, out);
    } else if (inputActive) {
      input.sample(tick, out, dtS);
    } else {
      resetInputFrame(out, tick);
    }
    aimX = out.steerX;
    aimY = out.steerY;
    copyInputFrame(lastInput, out);
  }

  const clientSampler: ClientInputSampler = {
    sample(frame: InputFrame, _own: Readonly<SnapshotOwner> | null): void {
      const session = run !== null && run.kind === 'client' ? run.session : null;
      if (session === null) return;
      const predictor = session.predictor;
      sampleLocal(
        predictor.tick,
        predictor.active ? predictor.dragon : undefined,
        frame,
        TICK_DT_S,
      );
    },
  };

  /** The host player's input, sampled on whichever thread's schedule the host runs. */
  const hostInput: LocalInputSource = { sample: sampleLocal };
  const epochNow = (): number => performance.timeOrigin + performance.now();

  const hostViewOptions: HostViewOptions = {
    localDragonId: NO_PLAYER,
    stormWall: null,
    phase: 'lobby',
    // A host worker's state can be a few ms late; `viewAlpha` then runs a little past 1.
    maxAlpha: 1 + VIEW_EXTRAPOLATE_TICKS,
  };

  // --- Cost figures for the perf HUD -----------------------------------------------------------------
  /** Client only: the smoothed cost of `session.advance`. A host's figures are its metrics. */
  let stepMs = 0;
  let lastFrameNowMs = -1;
  // Client, measured only with a probe: how often playback ran out of snapshots.
  let starvedFrames = 0;
  let matchFrames = 0;

  const ui: Ui = createUi(options.uiRoot, handleIntent, {
    nameStore: createSettingsNameStore(store),
  });
  const unsubscribePreset = renderer.onPresetChange((id) => {
    stage.setQuality(id);
    show.setQuality(id);
    audio?.setQuality(id);
  });

  // --- Settings -> the modules that act on them ------------------------------------------------------
  function applyVolumes(): void {
    const s = store.settings;
    audio?.setVolumes({
      master: s.masterVolume,
      sfx: s.sfxVolume,
      music: s.musicVolume,
      ui: s.uiVolume,
    });
  }

  // The gamepad's settings, menu steps and HUD captions (made before the targets below, whose
  // first run hands it the keyboard's captions).
  const padLink: GamepadLink = createGamepadLink({
    input,
    store,
    setKeyLabels: (labels) => hudBuilder.setKeyLabels(labels),
    onPresence: (connected) => {
      // For the "click to fly" prompt's style sheet: with a pad it also says "or press a button".
      document.documentElement.dataset['dfPad'] = connected ? 'connected' : 'none';
    },
  });
  // What the Controls tab shows of the pad: one object the link rewrites in place, so it is
  // handed over once. (`MutableUiState` in ui-model.ts has no such field yet.)
  (uiState as { gamepad?: GamepadLink['ui'] }).gamepad = padLink.ui;
  const unbindSettings = bindSettingsTargets(store, {
    setQuality(preset): void {
      // `?quality=` pins the preset for this page load, whatever is saved.
      if (forcedQuality === null && renderer.presetId !== preset) renderer.setPreset(preset);
    },
    setResolution(dynamic, minScale, capScale): void {
      const preset = QUALITY_PRESETS[renderer.presetId];
      // With a forced preset the saved cap still applies, inside that preset's own bounds.
      const min = forcedQuality === null ? minScale : preset.renderScaleMin;
      const cap =
        forcedQuality === null
          ? capScale
          : preset.renderScaleMin +
            (preset.renderScaleMax - preset.renderScaleMin) * store.settings.renderScaleCap;
      renderer.resolution.setBounds(min, cap > min ? cap : min);
      renderer.resolution.enabled = dynamic;
      if (!dynamic) renderer.resolution.setScale(cap);
    },
    setFrameCap(fps): void {
      frameCap.setCap(fps);
      // The scaler must know: capped frames are slow by choice, not a GPU over budget.
      renderer.resolution.setFrameCap(fps);
    },
    setCamera(fovDeg, shake, reduceMotion): void {
      stage.setCameraSettings(fovDeg, shake, reduceMotion);
      show.setReduceMotion(reduceMotion);
    },
    setInput(sensitivity, invertY, boostToggle): void {
      const inputOptions = input.state.options;
      inputOptions.sensitivity = sensitivity;
      inputOptions.invertY = invertY;
      inputOptions.boostToggle = boostToggle;
    },
    setBindings(bindings): void {
      input.setBindings(bindings);
      const labels: string[] = [];
      for (const slot of ABILITY_SLOTS) {
        const code = bindings[slot][0];
        // The short caption: the slots were laid out for "LMB", not "Left mouse".
        labels.push(code === undefined ? '' : codeShortLabel(code));
      }
      // Through the gamepad link: it shows these or the pad's, whichever device is in use.
      padLink.setKeyboardLabels(labels);
      scoreboardCodes = bindings.scoreboard;
      scoreboardKeyHeld = false;
    },
    setVolumes(): void {
      applyVolumes();
    },
    setUi(uiScale, colorBlindMarkers, _showNetChip, reduceMotion): void {
      applyPageSettings(document.documentElement, uiScale, colorBlindMarkers, reduceMotion);
    },
  });
  const unsubscribeShown = store.subscribe(() => {
    shownSettings = shownSettingsOf();
  });

  /** The settings panel is its own chunk: fetched the first time it is opened. */
  function ensureSettingsPanel(): void {
    if (settingsPanel !== null || settingsPanelLoading) return;
    settingsPanelLoading = true;
    import('../ui/settings').then(
      (module) => {
        settingsPanelLoading = false;
        if (disposed) return;
        settingsPanel = module.createSettingsPanel(options.uiRoot, handleIntent);
      },
      (error: unknown) => {
        settingsPanelLoading = false;
        settingsOpen = false;
        console.warn('The settings panel failed to load', error);
      },
    );
  }

  /** The audio engine (synthesis tables and all) is its own chunk too, fetched after boot. */
  function loadAudio(): void {
    import('../audio').then(
      (module) => {
        if (disposed) return;
        const engine = module.createAudio({ quality: renderer.presetId });
        audio = engine;
        audioUnsubscribe = engine.connect(bus);
        applyVolumes();
        engine.setScene(audioScene);
      },
      (error: unknown) => {
        console.warn('Audio failed to load', error);
      },
    );
  }
  const unlockAudio = (): void => {
    audio?.unlock();
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
  loadAudio();

  // --- Starting and ending a run -------------------------------------------------------------------

  function cleanName(name: string): string {
    const trimmed = name.trim();
    return trimmed === '' ? FALLBACK_PLAYER_NAME : trimmed;
  }

  /** Every exit path ends here: bots, session, transports, match views and input are let go. */
  function endRun(keepRejoin: boolean): void {
    attempt++;
    pendingKind = 'none';
    const ended = run;
    run = null;
    if (ended !== null) {
      if (ended.kind === 'client') {
        // `leave` tells the host (the seat is freed at once) when the link is still up.
        if (!keepRejoin) ended.session.leave();
        ended.session.dispose();
      } else {
        // Sends HOST_LEFT to every client, then releases the bots, the transport and the worker.
        ended.session.close();
      }
    }
    if (!keepRejoin) writeRejoin(storage.session, null);
    stage.unloadMatch();
    show.endMatch();
    show.leaveRoom();
    endMatchViews();
    bus.clear();
    matchAssets = null;
    pauseOpen = false;
    isRider = false;
    setInputActive(false);
    aimX = 0;
    aimY = 0;
  }

  function fail(error: UiError): void {
    endRun(false);
    lastError = error;
  }

  function setInputActive(active: boolean): void {
    if (active === inputActive) return;
    inputActive = active;
    input.setEnabled(active);
  }

  /**
   * `transport` is the room's link to real players (null for a solo room). The bots of
   * `?bots=N` are made inside the handle, next to the sim.
   */
  function beginHostRun(
    kind: 'host' | 'solo',
    name: string,
    transport: HostTransport | null,
    autoStart: boolean,
  ): void {
    const skipTicks = kind === 'solo' ? Math.floor(flags.skipSeconds * TICK_HZ) : 0;
    const session = createHost({
      kind,
      transport,
      hostName: name,
      bots: transport !== null ? flags.bots : 0,
      autoStart,
      skipTicks,
      createMatchWorld: assets.factory,
      mapSeed: assets.defaultMap.seed,
      now,
      epochNow,
      recycledBuffers: shaper !== null,
      localInput: hostInput,
      events: bus,
      localBot: flags.autopilotBot === true,
      lagCompensation: flags.lagCompensation !== false,
      // A solo flight takes only the map of the dev flags (`?solo&map=`); the team size is
      // named so the rule "auto-start = seats for the host and its bots" does not shrink it.
      autoSettings:
        kind === 'host'
          ? (flags.autoSettings ?? null)
          : flags.autoSettings?.map !== undefined
            ? { map: flags.autoSettings.map, teamSize: DEFAULT_HOST_SETTINGS.teamSize }
            : null,
      autopilot: flags.autopilot && flags.autopilotBot !== true ? course : null,
      spawnWorker: !flags.noWorker && hostWorkerSupported() ? spawnHostWorker : null,
      cinematics: flags.cinematics !== false,
      onWorkerFallback: (reason: string): void => {
        console.warn(`Host worker unavailable (${reason}); hosting on the main thread.`);
      },
      ...(probe !== null
        ? {
            onState: (tick, current): void => {
              probe.trackHostTick(tick, current);
            },
          }
        : {}),
      ...(flags.measure ? { profileClock: now } : {}),
    });
    run = { kind, session, snapOnLoad: skipTicks > 0, wasOpen: false, frames: 0 };
    session.open();
  }

  function startSolo(name: string): void {
    endRun(false);
    lastError = null;
    beginHostRun('solo', cleanName(name), null, true);
  }

  function startHost(name: string, autoStart: boolean): void {
    endRun(false);
    lastError = null;
    const mine = ++attempt;
    pendingKind = 'host';
    const hostName = cleanName(name);
    const config = peerConfigFor(
      shownSettings.signaling,
      shownSettings.lanHost,
      shownSettings.turn,
      options.pageHostname,
    );
    Promise.all([import('../net/transport/peerjs'), shaperPromise]).then(
      ([peer, loadedShaper]) => {
        if (mine !== attempt) return;
        pendingKind = 'none';
        shaper = loadedShaper;
        let transport = peer.createPeerJsHostTransport(config);
        // `?netsim` shapes the links to real players; the in-page bots stay on a clean wire.
        if (loadedShaper !== null) transport = loadedShaper.wrapHost(transport);
        beginHostRun('host', hostName, transport, autoStart);
      },
      (error: unknown) => {
        if (mine !== attempt) return;
        fail({ kind: 'signalingFailed', detail: errorDetail(error) });
      },
    );
  }

  function startJoin(name: string, roomCode: string): void {
    // The rejoin record survives the attempt: it is rewritten on success and cleared on failure.
    endRun(true);
    lastError = null;
    const mine = ++attempt;
    pendingKind = 'client';
    const riderName = cleanName(name);
    const code = normalizeRoomCode(roomCode);
    const config = peerConfigFor(
      shownSettings.signaling,
      shownSettings.lanHost,
      shownSettings.turn,
      options.pageHostname,
    );
    Promise.all([import('../net/transport/peerjs'), shaperPromise]).then(
      ([peer, loadedShaper]) => {
        if (mine !== attempt) return;
        pendingKind = 'none';
        shaper = loadedShaper;
        let transport = peer.createPeerJsClientTransport(config);
        if (loadedShaper !== null) transport = loadedShaper.wrapClient(transport);
        const session = createClientSession({
          transport,
          tokenStore,
          clientId,
          createMatchWorld: assets.factory,
          now,
          recycledBuffers: loadedShaper !== null,
          events: bus,
        });
        run = { kind: 'client', session, name: riderName, wasConnected: false };
        session.connect(code, riderName, now());
      },
      (error: unknown) => {
        if (mine !== attempt) return;
        fail({ kind: 'signalingFailed', detail: errorDetail(error) });
      },
    );
  }

  // --- Intents ---------------------------------------------------------------------------------------

  const settingsHooks = {
    open(tab: SettingsTab | undefined): void {
      settingsOpen = true;
      if (tab !== undefined) settingsTab = tab;
      ensureSettingsPanel();
      // In a match the panel needs the pointer: flight input is muted until it closes.
      input.releaseLock();
    },
    close(): void {
      // Back to whichever of the flight menu or the title was showing underneath.
      settingsOpen = false;
    },
    redetectDisplay(): void {
      renderer.resolution.reset();
    },
    retestQuality(): void {
      options.onRetestQuality?.();
    },
  };

  function handleIntent(intent: UiIntent): void {
    if (handleSettingsIntent(store, intent, settingsHooks)) return;
    if (audio !== null) {
      if (intent.type === 'lobby.ready' && intent.ready) audio.playUi('ready');
      else if (intent.type !== 'title.dismissError') audio.playUi('click');
    }
    switch (intent.type) {
      case 'title.host':
        startHost(intent.name, false);
        return;
      case 'title.join':
        startJoin(intent.name, intent.roomCode);
        return;
      case 'title.solo':
        startSolo(intent.name);
        return;
      case 'title.cancel':
        endRun(false);
        return;
      case 'title.dismissError':
        lastError = null;
        return;
      case 'lobby.leave':
      case 'match.leave':
        // For a host this closes the room: every client is told HOST_LEFT.
        endRun(false);
        return;
      case 'match.end': {
        // Host only: back to the lobby with the room, the seats and the teams intact.
        const current = run;
        if (current !== null && current.kind === 'host') current.session.endMatch();
        return;
      }
      case 'match.pause':
        pauseOpen = true;
        input.releaseLock();
        return;
      case 'match.resume':
        pauseOpen = false;
        // The click on Resume is the user gesture pointer lock needs. A gamepad button is not
        // one (the browser would refuse), and a pad flies without the lock anyway.
        if (isRider && !flags.autopilot) {
          setInputActive(true);
          if (!padActing) input.requestLock();
        }
        return;
      case 'lobby.focusPlayer':
        // Local only: which perch this player's camera frames.
        show.focus(intent.playerId);
        return;
      case 'match.skipIntro': {
        // The host decides (and only from the room's second match on); a guest cannot ask.
        const current = run;
        if (current !== null && current.kind !== 'client') current.session.requestSkipIntro();
        return;
      }
      default: {
        // Lobby and host-panel intents: the host applies its own, a client asks the host.
        const current = run;
        if (current === null) return;
        if (current.kind === 'client') current.session.sendIntent(intent);
        else current.session.applyIntent(intent);
      }
    }
  }

  // --- Per frame: follow what the session says -------------------------------------------------------

  function updateHost(host: HostRun, nowMs: number): void {
    const session = host.session;
    // First, so what the netsim releases this frame is in the batch `update` hands on.
    if (shaper !== null) shaper.pump(nowMs);
    session.update(nowMs);
    host.frames++;
    if (session.state === 'open') host.wasOpen = true;
    aimX = session.aimX;
    aimY = session.aimY;
  }

  /** A session that ended by itself is torn down here; returns false when it was. */
  function reapRun(current: Run): boolean {
    if (current.kind === 'client') {
      const session = current.session;
      const status = session.status;
      if (status === 'connected') {
        if (!current.wasConnected) {
          current.wasConnected = true;
          writeRejoin(storage.session, { roomCode: session.roomCode, name: current.name });
        }
        return true;
      }
      if (status === 'connecting' || status === 'reconnecting' || status === 'idle') return true;
      const error = session.error;
      endRun(false);
      // `left` has no error: the player asked for it.
      lastError = status === 'left' ? null : (error ?? { kind: 'connectionLost' });
      return false;
    }
    const session = current.session;
    if (session.state !== 'closed') return true;
    const error = session.error;
    const opened = current.wasOpen;
    endRun(false);
    lastError =
      error !== null
        ? opened
          ? { kind: 'signalingFailed', detail: error.message }
          : connectFailure(error.reason)
        : null;
    return false;
  }

  function walkApp(target: AppStateId): void {
    if (app.state === target) return;
    if (target === 'match' && app.state === 'title') app.transition('lobby');
    if (target === 'lobby' && app.state === 'results') app.transition('lobby');
    app.transition(target);
  }

  /** Moves the stage, the app state and the input to where the session is. */
  function syncRun(): void {
    const current = run;
    facts.kind = current === null ? (pendingKind === 'none' ? 'none' : pendingKind) : current.kind;
    facts.connecting = current === null && pendingKind !== 'none';
    facts.reconnecting = false;
    facts.lobby = null;
    facts.inMatch = false;

    let inMatch = false;
    let seed = -1;
    let mapId = DEFAULT_MAP_ID;
    let rider = false;
    if (current !== null) {
      if (current.kind === 'client') {
        const session = current.session;
        facts.lobby = session.lobby;
        facts.connecting = session.status === 'connecting' || session.status === 'idle';
        facts.reconnecting = session.status === 'reconnecting';
        inMatch = session.inMatch;
        seed = session.matchSeed;
        mapId = session.matchMap;
        rider = session.isRider;
      } else {
        const session = current.session;
        facts.lobby = session.state === 'open' ? session.lobby : null;
        facts.connecting = session.state !== 'open';
        inMatch = session.inMatch;
        // The same rule the host session sends in MATCH_START (it cannot change mid-match:
        // the lobby is locked while one runs).
        mapId = session.lobby?.settings.map ?? DEFAULT_MAP_ID;
        seed = matchSeedOfMap(mapId, assets.defaultMap.seed);
        rider = inMatch && session.localIsRider;
      }
    }

    // The map the host has picked starts loading on every page while the room is still in the
    // lobby, so the match start is a fade and not a loading screen. Only when the pick changes.
    const lobbyMap = facts.lobby !== null && !inMatch ? facts.lobby.settings.map : preloadedMap;
    if (lobbyMap !== preloadedMap) {
      preloadedMap = lobbyMap;
      stage.preloadMap(assets.get(matchSeedOfMap(lobbyMap, assets.defaultMap.seed), lobbyMap).map);
    }

    // A client that reconnects mid-match is told about the match again a moment after its
    // WELCOME; the views stay up across that gap instead of being torn down and rebuilt.
    const lobbyPhase = facts.lobby === null ? 'lobby' : facts.lobby.phase;
    const keepMatch = current !== null && stage.matchLoaded && lobbyPhase !== 'lobby';
    const wantMatch = inMatch || keepMatch || (facts.reconnecting && stage.matchLoaded);

    const otherWorld = stage.matchSeed !== seed >>> 0 || matchAssets?.mapId !== mapId;
    if (inMatch && (!stage.matchLoaded || otherWorld)) {
      matchAssets = assets.get(seed, mapId);
      // One rig per rider is built now, so the warm-up compiles them with the map.
      riderClasses.length = 0;
      if (facts.lobby !== null) {
        for (const player of facts.lobby.players) {
          if (player.side !== 'spectator') riderClasses.push(player.classId);
        }
      }
      show.beginMatch(matchAssets);
      stage.loadMatch(matchAssets, riderClasses);
      pauseOpen = false;
      beginMatchViews(current);
      if (current !== null && current.kind !== 'client' && current.snapOnLoad) {
        // `?skip`: the host flew that far before its first state was shown.
        current.snapOnLoad = false;
        stage.snapCamera();
      }
    } else if (!wantMatch && stage.matchLoaded) {
      stage.unloadMatch();
      show.endMatch();
      matchAssets = null;
      pauseOpen = false;
      endMatchViews();
    }
    facts.inMatch = stage.matchLoaded;
    // In that same gap the session has no match and so no rider. The controls are not let go
    // for it: dropping them would release the pointer lock (the cursor pops free mid-fight and
    // the player has to click the canvas again) and flash the spectator prompt.
    const rejoining = current !== null && current.kind === 'client' && !inMatch && keepMatch;
    if (!rejoining) isRider = stage.matchLoaded && rider;

    setInputActive(isRider && !flags.autopilot && !pauseOpen && !settingsOpen);
    // Overlay visibility for downed Duel riders is refreshed after the WorldView is built.

    walkApp(
      stage.matchLoaded
        ? 'match'
        : current !== null && facts.lobby !== null && current.kind !== 'solo'
          ? 'lobby'
          : 'title',
    );
    const scene = stage.matchLoaded ? 'match' : app.state === 'lobby' ? 'lobby' : 'title';
    if (scene !== audioScene) {
      audioScene = scene;
      audio?.setScene(scene);
    }
  }

  /** The match views were just loaded: what is fixed for the match, and the HUD's feed. */
  function beginMatchViews(current: Run | null): void {
    const lobby = facts.lobby;
    const localId = current === null ? NO_PLAYER : current.session.localPlayerId;
    if (lobby !== null) {
      const config = createModeConfig(lobby.settings, current !== null && current.kind === 'solo');
      matchFacts.mode = config.mode;
      matchFacts.scoreLimit = config.sandbox ? 0 : config.scoreLimit;
      matchFacts.respawnDelayS = config.respawns ? MATCH_TUNING.respawnDelayS : Infinity;
      hudBuilder.begin(config.mode, matchFacts.scoreLimit, localId);
    } else {
      matchFacts.mode = 'skirmish';
      matchFacts.scoreLimit = 0;
      matchFacts.respawnDelayS = MATCH_TUNING.respawnDelayS;
      hudBuilder.begin('skirmish', 0, localId);
    }
    matchFacts.round = 1;
    matchFacts.results = null;
    hudUnsubscribe?.();
    hudUnsubscribe = hudBuilder.connect(bus);
    if (current !== null && current.kind === 'client') {
      current.session.respawnDelayS = matchFacts.respawnDelayS;
    }
    uiState.hud = hudBuilder.hud;
    uiState.results = null;
  }

  function endMatchViews(): void {
    hudUnsubscribe?.();
    hudUnsubscribe = null;
    uiState.hud = null;
    uiState.results = null;
    matchFacts.results = null;
    input.clearAim();
    // Nothing of this match is left for the next one to draw.
    beginWorldView(worldView);
    worldView.localDragonId = NO_PLAYER;
  }

  /** The frame's WorldView. Returns false when there is no match picture to draw. */
  function buildView(alpha: number, nowMs: number): boolean {
    const current = run;
    if (current === null || !stage.matchLoaded || matchAssets === null) return false;
    if (current.kind === 'client') {
      const session = current.session;
      // While the link is being restored the last picture stays up.
      if (session.inMatch) session.writeWorldView(worldView, matchAssets.collision);
      return true;
    }
    const session = current.session;
    const before = session.prev;
    const latest = session.current;
    // A host worker's first state is a moment behind the news that the match began: there is
    // no picture of this match yet (and the view still holds the end of the last one, which
    // must not be shown with this match's freshly made views).
    if (before === null || latest === null) return false;
    const view = hostViewOptions;
    view.localDragonId = isRider ? session.localPlayerId : NO_PLAYER;
    view.stormWall = matchAssets.collision;
    view.phase = session.matchPhase;
    const blend = session.viewAlpha(alpha, nowMs);
    buildWorldView(worldView, before, latest, blend, view);
    const effects: HostEffectsOptions = effectsOptions;
    effectsOptions.localDragonId = view.localDragonId;
    effectsOptions.respawnDelayS = matchFacts.respawnDelayS;
    appendHostEffects(worldView, latest, blend, effects);
    // The same clock a client reads from its snapshots.
    const clock = worldView.clock;
    clock.phaseTimeS = session.phaseTimeS;
    clock.tick = session.hostTick;
    clock.round = session.matchRound;
    clock.timeRemainingS = session.timeRemainingS;
    return true;
  }

  /**
   * A client's own casts, as its prediction fired them: shown and heard now. (The host's echo
   * of each arrives a round trip later and is skipped once by the effects and the audio.)
   */
  function showLocalCasts(session: ClientSession): void {
    const casts = session.takeLocalCasts();
    if (casts === 0 || !session.predictor.active) return;
    const dragon = session.predictor.dragon;
    const vfx = stage.vfx;
    const abilities = ABILITY_TABLE[dragon.classId];
    for (let i = 0; i < ABILITY_SLOTS.length; i++) {
      const slot = ABILITY_SLOTS[i];
      if (slot === undefined || (casts & (1 << i)) === 0) continue;
      fireDirectionOf(dragon, abilities[slot], shotDirection);
      vfx?.spawnLocalShot(dragon.classId, slot, dragon.position, shotDirection);
      audio?.playLocalCast(dragon.classId, slot);
      localCastCount++;
    }
  }

  /**
   * Where the next input samples aim: from the local dragon to the point where the camera's ray
   * through the reticle reaches the convergence range. Allocation-free.
   */
  function updateAim(): void {
    const local = isRider ? findDragonView(worldView, worldView.localDragonId) : undefined;
    if (
      local === undefined ||
      flags.autopilot ||
      !input.flying ||
      viewportHeight <= 0 ||
      (local.flags & DRAGON_FLAG_ALIVE) === 0
    ) {
      input.clearAim();
      return;
    }
    const camera = stage.camera;
    const state = input.state;
    const tan = Math.tan(camera.fov * 0.5 * DEG_TO_RAD);
    // The reticle sits `reticle * radius` pixels from the centre; NDC is +-1 at half the height.
    const scale = (RETICLE_RADIUS_PX * 2) / viewportHeight;
    const rx = state.reticleX * scale * tan;
    const ry = state.reticleY * scale * tan;
    // Camera space (-Z forward) into the world.
    const e = camera.matrixWorld.elements;
    let dx = (e[0] ?? 0) * rx + (e[4] ?? 0) * ry - (e[8] ?? 0);
    let dy = (e[1] ?? 0) * rx + (e[5] ?? 0) * ry - (e[9] ?? 0);
    let dz = (e[2] ?? 0) * rx + (e[6] ?? 0) * ry - (e[10] ?? 0);
    const rayLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(rayLength > 1e-6)) {
      input.clearAim();
      return;
    }
    const reach = AIM_CONVERGENCE_M / rayLength;
    dx = camera.position.x + dx * reach - local.position.x;
    dy = camera.position.y + dy * reach - local.position.y;
    dz = camera.position.z + dz * reach - local.position.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length > 1e-3)) {
      input.clearAim();
      return;
    }
    input.setAim(Math.atan2(dx, dz), Math.asin(dy / length));
  }

  /** The HUD state and the results table for the frame just built. */
  function writeHud(dtS: number): void {
    const current = run;
    if (current === null) return;
    const info = hudInput;
    info.cameraYaw = cameraYaw;
    // This frame's camera (placed by `stage.updateMatch`) and the map's rock, for the
    // friend-or-foe markers over the dragons. The arrays are the camera's own: nothing is copied.
    info.cameraWorld = stage.camera.matrixWorld.elements;
    info.cameraProjection = stage.camera.projectionMatrix.elements;
    info.terrain = matchAssets !== null ? matchAssets.collision : null;
    info.isRider = isRider;
    info.buttons = lastInput.buttons;
    info.showReticle = isRider && !flags.autopilot && !pauseOpen && !settingsOpen;
    info.reticleX = input.state.reticleX;
    info.reticleY = input.state.reticleY;
    // "Has control", by pointer lock or by gamepad: what hides the "click to fly" prompt.
    info.pointerLocked = input.flying;
    info.watchedId = stage.watchedId;
    info.canSkipIntro = current.kind !== 'client' && current.session.canSkipIntro;
    let phase: MatchPhase;
    if (current.kind === 'client') {
      const session = current.session;
      const sample = session.sample;
      info.scoreEmber = sample.scoreEmber;
      info.scoreFrost = sample.scoreFrost;
      info.winner = session.matchWinner;
      info.stats = session.scores.rows;
      info.statsCount = session.scores.count;
      info.pings = session.playerPings;
      phase = session.matchPhase;
    } else {
      const session = current.session;
      info.scoreEmber = session.scoreEmber;
      info.scoreFrost = session.scoreFrost;
      info.winner = session.matchWinner;
      info.stats = session.matchStats;
      info.statsCount = session.matchStatsCount;
      info.pings = session.playerPings;
      phase = session.matchPhase;
    }
    hudBuilder.setLobby(facts.lobby);
    hudBuilder.frame(dtS, info);
    // Held, not toggled; never over the pause menu or the settings.
    if (pauseOpen || settingsOpen || !stage.matchLoaded) scoreboardKeyHeld = false;
    hudBuilder.hud.scoreboardOpen =
      !pauseOpen &&
      !settingsOpen &&
      (scoreboardKeyHeld ||
        (input.flying && isActionActive(input.state, 'scoreboard')) ||
        // The pad's button also counts with no control: a spectator, a rider who is down.
        input.isGamepadActionHeld('scoreboard'));
    // The results panel is the headline of a finished match: no second banner behind it.
    if (phase === 'results') hudBuilder.hud.winner = null;
    // The intro's title card: the map and the mode, at the opacity the cinematic gives it.
    const cardOpacity = show.cardOpacity;
    if (cardOpacity > 0) {
      const card = hudBuilder.hud.introCardPool;
      card.mapName = MAPS[facts.lobby?.settings.map ?? 'shattered-spires'].name;
      card.modeName = MODES[matchFacts.mode].name;
      card.opacity = cardOpacity;
      hudBuilder.hud.introCard = card;
    } else {
      hudBuilder.hud.introCard = null;
    }
    // The results table is made once, when the match is decided (allocates: once per match).
    if (phase === 'results' && info.winner !== null) {
      if (matchFacts.results === null) {
        matchFacts.results = hudBuilder.buildResults(info.winner);
        uiState.results = matchFacts.results;
      }
    } else if (matchFacts.results !== null && phase !== 'lobby') {
      matchFacts.results = null;
      uiState.results = null;
    }
  }

  function writeUiState(): void {
    applySessionFacts(uiState, facts);
    uiState.settings = shownSettings;
    uiState.controls = store.controls;
    uiState.settingsOpen = settingsOpen;
    uiState.settingsTab = settingsTab;
    if (!stage.matchLoaded) {
      uiState.hud = null;
      uiState.results = null;
    }
    uiState.connection.error = lastError;
    uiState.pauseMenuOpen = pauseOpen && stage.matchLoaded;
    uiState.aerie = lobbyOnScreen;
    uiState.lobbyPlateCount = lobbyOnScreen ? show.plateCount : 0;
    uiState.lobbyFocusId = show.focusId;
    const current = run;
    if (current === null) return;
    if (current.kind === 'client') {
      const session = current.session;
      uiState.connection.localPlayerId = session.localPlayerId;
      uiState.connection.pingMs = session.pingMs;
      uiState.playerPings = session.playerPings;
      // The host decides; a guest's Start button does not exist.
      uiState.startBlocker = null;
    } else {
      const session = current.session;
      uiState.connection.localPlayerId = session.localPlayerId;
      uiState.connection.pingMs = 0;
      uiState.playerPings = session.playerPings;
      uiState.startBlocker = session.state === 'open' ? session.startBlocker : null;
    }
  }

  // --- The two entry points ----------------------------------------------------------------------------

  function fixedStep(): void {
    const current = run;
    if (current === null || current.kind === 'client') return;
    // The host on this thread steps here; a host worker steps on its own timer.
    current.session.fixedStep();
  }

  /** This frame's gamepad buttons that are not flight: Menu (Start) and the menu steps. */
  function readGamepad(nowMs: number): void {
    // Polls the pad once per frame; without one this is two comparisons.
    padLink.frame(nowMs, !inputActive, settingsOpen);
    if (padLink.pausePressed && stage.matchLoaded && !settingsOpen) {
      // Menu opens the flight menu and closes it again, as Esc does.
      padActing = true;
      handleIntent({ type: pauseOpen ? 'match.resume' : 'match.pause' });
      padActing = false;
      ui.markPadUsed();
    }
    const step = padLink.nav;
    if (step === null) return;
    if (step === 'accept' && canCycleWatch()) {
      // A spectator's (or downed Duel rider's) A is the click on the picture: next rider.
      stage.cycleSpectateTarget();
      return;
    }
    padActing = true;
    ui.navigate(step);
    padActing = false;
  }

  function frame(alpha: number, frameMs: number): void {
    const nowMs = now();
    const elapsedS = lastFrameNowMs < 0 ? 0 : (nowMs - lastFrameNowMs) / 1000;
    lastFrameNowMs = nowMs;
    const dtS = frameMs / 1000;
    readGamepad(nowMs);
    // Frames stopped for a while (a hidden tab, a long stall) but a host worker's or a client's
    // messages kept arriving: what happened meanwhile is not shown all at once on the first
    // frame back. The state (score, health, who is where) comes from the view, not from events.
    // Before this frame's own update, so what that produces is still heard.
    if (elapsedS > STALE_EVENTS_GAP_S) bus.dropExcept('matchPhase');

    let current = run;
    if (current !== null) {
      if (current.kind === 'client') {
        if (shaper !== null) shaper.pump(nowMs);
        const before = flags.measure ? now() : 0;
        current.session.advance(nowMs, clientSampler);
        if (flags.measure) stepMs += (now() - before - stepMs) * COST_SMOOTHING;
      } else {
        updateHost(current, nowMs);
      }
      if (!reapRun(current)) current = null;
    }
    syncRun();
    // Before the picture is built: the effects, the audio and the HUD feed hear this frame's
    // events and the frame then draws what they started.
    bus.flush();

    matchOnScreen = buildView(alpha, nowMs);
    if (matchOnScreen) {
      if (current !== null && current.kind === 'client') showLocalCasts(current.session);
      // The results: the podium rewrites this frame's dragons before anything draws them.
      show.matchFrame(worldView, matchFacts.results, dtS);
      stage.updateMatch(worldView, aimX, aimY, dtS);
      const camera = stage.camera;
      const e = camera.matrixWorld.elements;
      // The camera looks down its -Z: heading about +Y with 0 = +Z, like a dragon's yaw.
      cameraYaw = Math.atan2(-(e[8] ?? 0), -(e[10] ?? 1));
      updateAim();
      if (audio !== null) {
        listener.position.x = camera.position.x;
        listener.position.y = camera.position.y;
        listener.position.z = camera.position.z;
        listener.forward.x = -(e[8] ?? 0);
        listener.forward.y = -(e[9] ?? 0);
        listener.forward.z = -(e[10] ?? 1);
        listener.up.x = e[4] ?? 0;
        listener.up.y = e[5] ?? 1;
        listener.up.z = e[6] ?? 0;
        audio.update(worldView, listener, dtS);
        if (flags.measure) {
          const voices = audio.stats().activeVoices;
          if (voices > voicePeak) voicePeak = voices;
        }
      }
      if (flags.measure) {
        // Everything the particle budget is for: the effects' own and what the map draws itself.
        const alive = (stage.vfxStats?.aliveParticles ?? 0) + stage.mapAirParticles;
        if (alive > particlePeak) particlePeak = alive;
      }
      const showWatch = canCycleWatch();
      if (showWatch !== watchOverlayShown) {
        watchOverlayShown = showWatch;
        watchOverlay.setVisible(showWatch);
      }
      writeHud(dtS);
      if (probe !== null) {
        probe.trackFrame(worldView, elapsedS);
        if (current !== null && current.kind === 'client' && current.session.sample.valid) {
          matchFrames++;
          if (current.session.sample.starved) starvedFrames++;
        }
      }
    } else if (
      current !== null &&
      current.kind !== 'solo' &&
      facts.lobby !== null &&
      !stage.matchLoaded
    ) {
      // The lobby: the room's riders on their perches in the aerie.
      lobbyOnScreen = true;
      show.lobbyFrame(facts.lobby, current.session.localPlayerId, dtS);
    } else {
      stage.updateBackdrop(dtS);
    }
    if (matchOnScreen || stage.matchLoaded || current === null) lobbyOnScreen = false;
    else if (current.kind === 'solo' || facts.lobby === null) lobbyOnScreen = false;
    if (!matchOnScreen && watchOverlayShown) {
      watchOverlayShown = false;
      watchOverlay.setVisible(false);
    }

    // Every change of scene goes through the cream: the cut is held there until the new scene
    // has its picture and its shaders, then fades in.
    const scene: ShowScene = stage.matchLoaded ? 'match' : lobbyOnScreen ? 'lobby' : 'title';
    const sceneReady =
      !stage.warming &&
      (scene !== 'match' || (matchOnScreen && stage.mapLoadState !== 'loading'));
    uiState.fade = show.updateFade(scene, sceneReady, matchOnScreen ? worldView : null, dtS);
    if (show.holding && show.holdS > LOADING_CARD_AFTER_S) {
      loadingState.progress = stage.mapLoadState === 'loading' ? 0.4 : matchOnScreen ? 0.85 : 0.6;
      uiState.loading = loadingState;
    } else {
      uiState.loading = null;
    }
    // Under the full cream nothing of the picture is seen, and drawing a scene whose programs
    // are still linking would make the GPU finish them inside this frame: the stall the
    // warm-up exists to avoid. So the frame is not drawn until they are done.
    if (!(show.holding && stage.warming)) {
      renderer.render(stage.scene, stage.camera, frameMs);
    }

    writeUiState();
    ui.update(uiState);
    settingsPanel?.update(uiState);
  }

  function background(): void {
    // Nobody is watching: the bus must not grow with every cast and hit of the time away.
    bus.dropExcept('matchPhase');
    const current = run;
    if (current === null) return;
    const nowMs = now();
    // Nothing else delivers what the netsim holds while frames are stopped.
    if (shaper !== null) shaper.pump(nowMs);
    if (current.kind === 'client') current.session.update(nowMs);
  }

  // --- The test driver's report (allocates: never per frame) -------------------------------------------

  function reportMatch(): GameReport['match'] {
    const hud = hudBuilder.hud;
    const killfeed: string[] = [];
    for (let i = 0; i < hud.killfeedCount; i++) {
      const entry = hud.killfeed[i];
      if (entry !== undefined) killfeed.push(`${entry.killerName} > ${entry.victimName}`);
    }
    const stats: MatchPlayerStats[] = [];
    for (let i = 0; i < hudInput.statsCount; i++) {
      const row = hudInput.stats[i];
      if (row !== undefined) stats.push({ ...row });
    }
    let stormRadius = -1;
    for (let i = 0; i < worldView.zoneCount; i++) {
      const zone = worldView.zones[i];
      if (zone !== undefined && zone.kind === 'stormWall') stormRadius = zone.radius;
    }
    const loaded = stage.matchLoaded;
    return {
      mode: matchFacts.mode,
      round: loaded ? worldView.clock.round : 1,
      scores: [hud.scores[0], hud.scores[1]],
      scoreLimit: matchFacts.scoreLimit,
      timeRemainingS: loaded ? worldView.clock.timeRemainingS : Infinity,
      winner: loaded ? hudInput.winner : null,
      stormRadius,
      killfeed,
      stats,
      results: matchFacts.results,
      projectiles: loaded ? worldView.projectileCount : 0,
      zones: loaded ? worldView.zoneCount : 0,
      events: { ...eventCounts },
      localHits,
      localHitsTaken,
      localCasts: localCastCount,
    };
  }

  function reportLocal(): GameReport['local'] {
    const local = stage.matchLoaded ? hudBuilder.hud.local : null;
    if (local === null) return null;
    return {
      classId: local.classId,
      alive: local.alive,
      health: local.health,
      ultimateCharge: local.ultimateCharge,
      cooldownS: [...local.cooldownS],
      respawnInS: local.respawnInS,
    };
  }

  function reportAudio(): GameReport['audio'] {
    if (audio === null) return null;
    const stats = audio.stats();
    return {
      voices: stats.activeVoices,
      peak: voicePeak,
      capacity: stats.capacity,
      ready: stats.ready,
      masterGain: stats.masterGain,
      errors: stats.errors,
      samplesReady: stats.samplesReady,
      samplesFailed: stats.samplesFailed,
      tracksPlaying: stats.tracksPlaying,
      intensity: stats.intensity,
    };
  }

  // --- Boot-time shortcuts -----------------------------------------------------------------------------

  function bootName(): string {
    return store.settings.playerName;
  }

  // Declared before the boot shortcuts below: they can load chunks that check it.
  let disposed = false;
  const flushSettings = (): void => {
    store.flush();
  };
  window.addEventListener('pagehide', flushSettings);

  const joinCode = flags.joinCode ?? '';
  if (flags.solo) {
    startSolo(bootName());
  } else if (flags.autostart) {
    startHost(bootName(), true);
  } else if (joinCode !== '') {
    startJoin(bootName(), joinCode);
  } else {
    // A reload inside a room goes straight back to it; the stored token returns the old seat.
    const rejoin = readRejoin(storage.session);
    if (rejoin !== null) startJoin(rejoin.name, rejoin.roomCode);
  }

  return {
    app,
    probe,
    fixedStep,
    frame,
    background,
    handleIntent,

    setAspect(aspect: number): void {
      stage.setAspect(aspect);
    },

    setViewportSize(width: number, height: number): void {
      viewportWidth = width;
      viewportHeight = height;
    },

    shouldRender(nowMs: number): boolean {
      return frameCap.shouldRender(nowMs);
    },

    getFxText(): string {
      const vfx = stage.vfxStats;
      const stats = audio !== null ? audio.stats() : null;
      const fx =
        vfx === null
          ? 'fx —'
          : `fx ${vfx.aliveParticles}/${vfx.particleCapacity} particles + ${stage.mapAirParticles} map` +
            ` (peak ${particlePeak})  ${vfx.drawCalls} calls`;
      const sound =
        stats === null
          ? 'audio —'
          : `audio ${stats.activeVoices}/${stats.capacity} voices (peak ${voicePeak})` +
            `  ${stats.tracksPlaying} tracks  mix ${stats.intensity.toFixed(2)}` +
            (stats.ready ? '' : '  loading');
      return `${fx}\n${sound}`;
    },

    getSimMs(): number {
      const current = run;
      return current !== null && current.kind !== 'client'
        ? current.session.metrics.stepMs
        : stepMs;
    },

    get inMatch() {
      return matchOnScreen;
    },

    get titleIdle() {
      return run === null && pendingKind === 'none' && !stage.matchLoaded;
    },

    get settings() {
      return store.settings;
    },

    arenaFocus,

    getPeaks() {
      return { particles: particlePeak, voices: voicePeak };
    },

    setDevCameraDirector(director: CameraDirector | null): void {
      show.setDevDirector(director);
    },

    getNetText(): string {
      const current = run;
      if (current === null) return '';
      if (current.kind === 'client') {
        const session = current.session;
        const predictor = session.predictor;
        return (
          `ping ${session.pingMs.toFixed(0)} ms  delay ${session.buffer.clock.delayMs.toFixed(0)} ms` +
          `  loss ${session.lossPct.toFixed(1)}%\n` +
          `pred err ${predictor.lastCorrectionM.toFixed(2)} m  max ` +
          `${predictor.largestCorrectionM.toFixed(2)} m  fixes ${predictor.correctionCount}\n` +
          `net ${formatNetRate(session.stats)}`
        );
      }
      const session = current.session;
      const metrics = session.metrics;
      const clients = session.clientCount;
      const up = metrics.sentBytesPerS / 1024;
      const down = metrics.receivedBytesPerS / 1024;
      const each = clients > 0 ? up / clients : 0;
      const frames = current.frames > 0 ? current.frames : 1;
      const where =
        session.mode === 'worker'
          ? `worker ${metrics.workerPulseMs.toFixed(3)} ms  input +${metrics.inputAgeMs.toFixed(1)} ms`
          : 'main thread';
      return (
        `    = sim ${metrics.simMs.toFixed(3)} + snap ${metrics.snapshotMs.toFixed(3)} ms\n` +
        `host ${where}  main ${(metrics.mainMs / frames).toFixed(3)} ms/frame\n` +
        `net up ${up.toFixed(1)} down ${down.toFixed(1)} KB/s\n` +
        `clients ${clients}  ${each.toFixed(1)} KB/s each`
      );
    },

    report(): GameReport {
      const current = run;
      const dragons: GameReport['dragons'][number][] = [];
      const view: WorldView = worldView;
      if (stage.matchLoaded) {
        for (let i = 0; i < view.dragonCount; i++) {
          const dragon = view.dragons[i];
          if (dragon === undefined) continue;
          dragons.push({
            id: dragon.id,
            team: dragon.team,
            classId: dragon.classId,
            local: dragon.id === view.localDragonId,
            alive: (dragon.flags & DRAGON_FLAG_ALIVE) !== 0,
            x: dragon.position.x,
            y: dragon.position.y,
            z: dragon.position.z,
          });
        }
      }
      const host = current !== null && current.kind !== 'client' ? current : null;
      const client = current !== null && current.kind === 'client' ? current.session : null;
      return {
        show: {
          phaseTimeS: stage.matchLoaded ? view.clock.phaseTimeS : 0,
          lobbyPhase: facts.lobby === null ? 'none' : facts.lobby.phase,
          fade: uiState.fade,
          aerie: lobbyOnScreen,
          directed: stage.directed,
          introCard: show.cardOpacity,
          warming: stage.warming,
          warmUps: stage.warmUps,
          map: stage.matchLoaded && matchAssets !== null ? matchAssets.mapId : '',
          watching: isRider ? NO_PLAYER : stage.watchedId,
        },
        app: app.state,
        screen: uiState.screen,
        kind: facts.kind,
        status: client !== null ? client.status : host !== null ? host.session.state : 'none',
        error: lastError,
        roomCode: client !== null ? client.roomCode : host !== null ? host.session.roomCode : '',
        localPlayerId: uiState.connection.localPlayerId,
        inMatch: stage.matchLoaded,
        isRider,
        phase:
          client !== null ? client.matchPhase : host !== null ? host.session.matchPhase : 'lobby',
        match: reportMatch(),
        local: reportLocal(),
        input: { ...lastInput },
        camera: { fov: stage.camera.fov, yaw: cameraYaw },
        vfx:
          stage.vfxStats === null
            ? null
            : {
                particles: stage.vfxStats.aliveParticles,
                map: stage.mapAirParticles,
                peak: particlePeak,
                capacity: stage.vfxStats.particleCapacity,
                drawCalls: stage.vfxStats.drawCalls,
              },
        audio: reportAudio(),
        render: {
          calls: renderer.webgl.info.render.calls,
          triangles: renderer.webgl.info.render.triangles,
          preset: renderer.presetId,
          scale: renderer.resolution.scale,
        },
        settings: { ...store.settings, turn: null },
        bindings: store.bindings,
        settingsOpen,
        tick: client !== null ? client.sample.playTick : host !== null ? host.session.hostTick : 0,
        dragons,
        lobby: facts.lobby,
        host:
          host === null
            ? null
            : {
                mode: host.session.mode,
                clients: host.session.clientCount,
                bots: host.session.botsConnected,
                stepMs: host.session.metrics.stepMs,
                simMs: host.session.metrics.simMs,
                snapshotMs: host.session.metrics.snapshotMs,
                maxStepMs: host.session.metrics.maxStepMs,
                upKBps: host.session.metrics.sentBytesPerS / 1024,
                downKBps: host.session.metrics.receivedBytesPerS / 1024,
                malformed: host.session.metrics.malformed,
                frames: host.frames,
                metrics: { ...host.session.metrics },
              },
        client:
          client === null
            ? null
            : {
                pingMs: client.pingMs,
                interpDelayMs: client.buffer.clock.delayMs,
                lossPct: client.lossPct,
                snapshots: client.counters.snapshots,
                starved: client.sample.starved,
                starvedFrames,
                matchFrames,
                corrections: client.predictor.correctionCount,
                snaps: client.predictor.snapCount,
                lastCorrectionM: client.predictor.lastCorrectionM,
                largestCorrectionM: client.predictor.largestCorrectionM,
                visualOffsetM: client.predictor.visualOffsetM,
                inputMarginTicks: client.timing.lowestMarginTicks,
                timeScale: client.timeScale,
                resyncs: client.counters.resyncs,
                reconnects: client.counters.reconnects,
                upKBps: client.stats.sentBytesPerS / 1024,
                downKBps: client.stats.receivedBytesPerS / 1024,
                malformed: client.counters.malformed,
              },
        remoteMotion: probe === null ? null : probe.remoteMotion(),
        localMotion: probe === null ? null : probe.localMotion(),
      };
    },

    shutdown(): void {
      // A client keeps its rejoin record and token: the host holds the seat for a reload. So
      // does a join that is still loading its chunks (`run` is null until they arrive): a
      // second reload during an auto-rejoin must not wipe the record the first one came back by.
      endRun((run !== null && run.kind === 'client') || pendingKind === 'client');
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      endRun(false);
      window.removeEventListener('pagehide', flushSettings);
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      unbindSettings();
      padLink.dispose();
      unsubscribeShown();
      store.dispose();
      settingsPanel?.dispose();
      hudUnsubscribe?.();
      audioUnsubscribe?.();
      audio?.dispose();
      canvas.removeEventListener('click', onCanvasClick);
      document.removeEventListener('keydown', onBoardKeyDown);
      document.removeEventListener('keyup', onBoardKeyUp);
      window.removeEventListener('blur', onBoardBlur);
      unsubscribePreset();
      ui.dispose();
      input.dispose();
      watchOverlay.dispose();
      show.dispose();
      stage.dispose();
    },
  };
}
