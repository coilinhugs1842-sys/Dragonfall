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
 *   host:   pump netsim -> `host.update(now)` -> syncRun -> buildWorldView
 *   client: pump netsim -> `client.advance(now, sampler)` (pings, due ticks: predict + send
 *           input) -> syncRun -> `client.writeWorldView`
 *   both:   stage update -> render -> UiState -> `ui.update`
 * WHILE THE TAB IS HIDDEN no frames run. `background()` (about once a second, from the frame
 * driver's timer) keeps a client's link alive instead: pings out, reconnect if it drops. A
 * host needs nothing here: its worker has its own clock, and on the main thread its transport
 * callbacks answer pings by themselves.
 */

import { createFlightOverlay, createInputController } from '../input';
import type { FlightOverlay, InputController } from '../input';
import {
  VIEW_EXTRAPOLATE_TICKS,
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
  DEFAULT_SETTINGS,
  DRAGON_FLAG_ALIVE,
  FALLBACK_PLAYER_NAME,
  NO_PLAYER,
  TICK_DT_S,
  TICK_HZ,
  createWorldView,
  resetInputFrame,
} from '../shared';
import type {
  InputFrame,
  LobbyState,
  MatchPhase,
  MutableWorldView,
  PlayerId,
  SettingsState,
  UiError,
  UiIntent,
  WorldView,
} from '../shared';
import { PLAYER_NAME_STORAGE_KEY, createUi } from '../ui';
import type { Ui } from '../ui';
import { App } from './app';
import type { AppStateId } from './app';
import { writeAutopilotFrame } from './autopilot';
import type { AutopilotCourse } from './autopilot';
import { createDebugProbe } from './debug-probe';
import type { DebugProbe, MotionReport } from './debug-probe';
import { hostWorkerSupported, spawnHostWorker } from './host-worker';
import { createMatchAssetsCache } from './match-assets';
import type { MatchAssets } from './match-assets';
import { createStage } from './stage';
import type { Stage } from './stage';
import {
  createStorageTokenStore,
  loadClientId,
  loadSettings,
  readRejoin,
  saveSettings,
  writeRejoin,
} from './storage';
import {
  applySessionFacts,
  connectFailure,
  createSessionFacts,
  createUiState,
  peerConfigFor,
} from './ui-model';
import { buildWorldView } from './world-view-builder';
import type { StormWallSource } from './world-view-builder';

/** The circle the `?autopilot` pilot flies, relative to the storm centre. */
const AUTOPILOT_RADIUS = 380;
const AUTOPILOT_ALTITUDE = 400;
/** EMA weight for the HUD's per-tick cost figures. */
const COST_SMOOTHING = 0.05;

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
  readonly skipSeconds: number;
  readonly bots: number;
  readonly lan: boolean;
  readonly solo: boolean;
  readonly autostart: boolean;
  /** `?noworker`: run the host's sim on the main thread instead of in the host worker. */
  readonly noWorker: boolean;
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
  /** Every menu action arrives here; also callable by tests and the debug console. */
  handleIntent(intent: UiIntent): void;
  /** Averaged cost of the fixed-step work in ms, for the perf HUD's `sim` line. */
  getSimMs(): number;
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

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGame(options: GameOptions): Game {
  const { canvas, renderer, flags, storage, now } = options;
  const app = new App('title');
  const assets = createMatchAssetsCache();
  const stage: Stage = createStage({ quality: renderer.presetId, map: assets.defaultMap });
  const probe = flags.measure ? createDebugProbe() : null;
  const tokenStore: ReconnectTokenStore = createStorageTokenStore(storage.session);
  // One per browser, so a kick also keeps out a new tab that has no token.
  const clientId = loadClientId(storage.local, createReconnectToken());
  const shaperPromise: Promise<TransportShaper | null> = options.shaper ?? Promise.resolve(null);
  let shaper: TransportShaper | null = null;

  let settings: SettingsState = loadSettings(storage.local);
  if (flags.lan) settings = { ...settings, signaling: 'lan' };

  const facts = createSessionFacts();
  const uiState = createUiState(settings);
  let lastError: UiError | null = null;
  let pauseOpen = false;

  let run: Run | null = null;
  /** Bumped by every new attempt and every teardown; an async step that sees it moved stops. */
  let attempt = 0;
  /** An attempt is loading its chunks: there is no session object yet. */
  let pendingKind: 'none' | 'solo' | 'host' | 'client' = 'none';

  // --- Local input ---------------------------------------------------------------------------------
  const worldView: MutableWorldView = createWorldView();
  const course: AutopilotCourse = {
    centerX: assets.defaultMap.colliders.stormCenter.x,
    centerZ: assets.defaultMap.colliders.stormCenter.z,
    radius: AUTOPILOT_RADIUS,
    altitude: AUTOPILOT_ALTITUDE,
  };
  /** The local player's latest steer, for the camera's look-ahead. */
  let aimX = 0;
  let aimY = 0;
  let wasLocked = false;
  let inputActive = false;
  let isRider = false;
  let matchAssets: MatchAssets | null = null;

  const input: InputController = createInputController(canvas, {
    onLockChange: (locked: boolean): void => {
      // Esc while flying only releases the pointer (the browser keeps the key), so losing the
      // lock is what opens the escape menu.
      if (!locked && wasLocked && stage.matchLoaded && isRider) pauseOpen = true;
      wasLocked = locked;
    },
  });
  input.setEnabled(false);
  const flightOverlay: FlightOverlay = createFlightOverlay();
  flightOverlay.setVisible(false);
  const watchOverlay: FlightOverlay = createFlightOverlay({
    promptText: 'Watching · click to follow the next rider',
  });
  watchOverlay.setVisible(false);
  watchOverlay.update(0, 0, false);
  let flightOverlayShown = false;
  let watchOverlayShown = false;

  const onCanvasClick = (): void => {
    if (stage.matchLoaded && !isRider) stage.cycleSpectateTarget();
  };
  canvas.addEventListener('click', onCanvasClick);

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
    if (flags.autopilot) {
      writeAutopilotFrame(tick, subject, course, out);
    } else if (inputActive) {
      input.sample(tick, out, dtS);
    } else {
      resetInputFrame(out, tick);
    }
    aimX = out.steerX;
    aimY = out.steerY;
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

  const ui: Ui = createUi(options.uiRoot, handleIntent);
  const unsubscribePreset = renderer.onPresetChange((id) => stage.setQuality(id));

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
      autopilot: flags.autopilot ? course : null,
      spawnWorker: !flags.noWorker && hostWorkerSupported() ? spawnHostWorker : null,
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
      settings.signaling,
      settings.lanHost,
      settings.turn,
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
      settings.signaling,
      settings.lanHost,
      settings.turn,
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

  function handleIntent(intent: UiIntent): void {
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
        // The click on Resume is the user gesture pointer lock needs.
        if (isRider && !flags.autopilot) {
          setInputActive(true);
          input.requestLock();
        }
        return;
      case 'settings.update':
        settings = { ...settings, ...intent.patch };
        saveSettings(storage.local, settings);
        return;
      case 'settings.reset':
        settings = DEFAULT_SETTINGS;
        saveSettings(storage.local, settings);
        return;
      case 'lobby.focusPlayer':
      case 'match.skipIntro':
        // Phase 5 (lobby camera, intro cinematic).
        return;
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
    let rider = false;
    if (current !== null) {
      if (current.kind === 'client') {
        const session = current.session;
        facts.lobby = session.lobby;
        facts.connecting = session.status === 'connecting' || session.status === 'idle';
        facts.reconnecting = session.status === 'reconnecting';
        inMatch = session.inMatch;
        seed = session.matchSeed;
        rider = session.isRider;
      } else {
        const session = current.session;
        facts.lobby = session.state === 'open' ? session.lobby : null;
        facts.connecting = session.state !== 'open';
        inMatch = session.inMatch;
        seed = assets.defaultMap.seed;
        rider = inMatch && session.localIsRider;
      }
    }

    // A client that reconnects mid-match is told about the match again a moment after its
    // WELCOME; the views stay up across that gap instead of being torn down and rebuilt.
    const lobbyPhase = facts.lobby === null ? 'lobby' : facts.lobby.phase;
    const keepMatch = current !== null && stage.matchLoaded && lobbyPhase !== 'lobby';
    const wantMatch = inMatch || keepMatch || (facts.reconnecting && stage.matchLoaded);

    if (inMatch && (!stage.matchLoaded || stage.matchSeed !== seed >>> 0)) {
      matchAssets = assets.get(seed);
      stage.loadMatch(matchAssets);
      pauseOpen = false;
      if (current !== null && current.kind !== 'client' && current.snapOnLoad) {
        // `?skip`: the host flew that far before its first state was shown.
        current.snapOnLoad = false;
        stage.snapCamera();
      }
    } else if (!wantMatch && stage.matchLoaded) {
      stage.unloadMatch();
      matchAssets = null;
      pauseOpen = false;
    }
    facts.inMatch = stage.matchLoaded;
    // In that same gap the session has no match and so no rider. The controls are not let go
    // for it: dropping them would release the pointer lock (the cursor pops free mid-fight and
    // the player has to click the canvas again) and flash the spectator prompt.
    const rejoining = current !== null && current.kind === 'client' && !inMatch && keepMatch;
    if (!rejoining) isRider = stage.matchLoaded && rider;

    setInputActive(isRider && !flags.autopilot && !pauseOpen);
    const showFlight = isRider && !flags.autopilot && !pauseOpen;
    if (showFlight !== flightOverlayShown) {
      flightOverlayShown = showFlight;
      flightOverlay.setVisible(showFlight);
    }
    const showWatch = stage.matchLoaded && !isRider && !pauseOpen;
    if (showWatch !== watchOverlayShown) {
      watchOverlayShown = showWatch;
      watchOverlay.setVisible(showWatch);
    }

    walkApp(
      stage.matchLoaded
        ? 'match'
        : current !== null && facts.lobby !== null && current.kind !== 'solo'
          ? 'lobby'
          : 'title',
    );
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
    // A host worker's first state is a moment behind the news that the match began.
    if (before === null || latest === null) return true;
    const view = hostViewOptions;
    view.localDragonId = isRider ? session.localPlayerId : NO_PLAYER;
    view.stormWall = matchAssets.collision;
    view.phase = session.matchPhase;
    buildWorldView(worldView, before, latest, session.viewAlpha(alpha, nowMs), view);
    // The same clock a client reads from its snapshots.
    worldView.clock.phaseTimeS = session.phaseTimeS;
    worldView.clock.tick = session.hostTick;
    return true;
  }

  function writeUiState(): void {
    applySessionFacts(uiState, facts);
    uiState.settings = settings;
    uiState.connection.error = lastError;
    uiState.pauseMenuOpen = pauseOpen && stage.matchLoaded;
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

  function frame(alpha: number, frameMs: number): void {
    const nowMs = now();
    const elapsedS = lastFrameNowMs < 0 ? 0 : (nowMs - lastFrameNowMs) / 1000;
    lastFrameNowMs = nowMs;
    const dtS = frameMs / 1000;

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

    if (buildView(alpha, nowMs)) {
      stage.updateMatch(worldView, aimX, aimY, dtS);
      if (probe !== null) {
        probe.trackFrame(worldView, elapsedS);
        if (current !== null && current.kind === 'client' && current.session.sample.valid) {
          matchFrames++;
          if (current.session.sample.starved) starvedFrames++;
        }
      }
    } else {
      stage.updateBackdrop(dtS);
    }
    if (flightOverlayShown) {
      flightOverlay.update(input.state.reticleX, input.state.reticleY, input.locked);
    }
    renderer.render(stage.scene, stage.camera, frameMs);

    writeUiState();
    ui.update(uiState);
  }

  function background(): void {
    const current = run;
    if (current === null) return;
    const nowMs = now();
    // Nothing else delivers what the netsim holds while frames are stopped.
    if (shaper !== null) shaper.pump(nowMs);
    if (current.kind === 'client') current.session.update(nowMs);
  }

  // --- Boot-time shortcuts -----------------------------------------------------------------------------

  function bootName(): string {
    try {
      return storage.local?.getItem(PLAYER_NAME_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  }

  if (flags.solo) {
    startSolo(bootName());
  } else if (flags.autostart) {
    startHost(bootName(), true);
  } else {
    // A reload inside a room goes straight back to it; the stored token returns the old seat.
    const rejoin = readRejoin(storage.session);
    if (rejoin !== null) startJoin(rejoin.name, rejoin.roomCode);
  }

  let disposed = false;

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

    getSimMs(): number {
      const current = run;
      return current !== null && current.kind !== 'client'
        ? current.session.metrics.stepMs
        : stepMs;
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
      canvas.removeEventListener('click', onCanvasClick);
      unsubscribePreset();
      ui.dispose();
      input.dispose();
      flightOverlay.dispose();
      watchOverlay.dispose();
      stage.dispose();
    },
  };
}
