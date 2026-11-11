/**
 * HostCore: everything the hosting page runs at 30 Hz, in one DOM-free object, so the same code
 * runs on the main thread (`DirectHost`) and inside the host worker (`HostWorkerServer`):
 *
 * - the `HostSession` (lobby, inputs -> sim -> collision -> snapshot encode),
 * - the in-page network of `?bots=N` and of a solo room: a loopback hub next to the room's real
 *   transport (bots are test load, so they live wherever the sim lives),
 * - `?autostart` / solo (start as soon as the room and its bots are ready) and `?skip`,
 * - the smoothed per-tick cost figures for the perf HUD.
 *
 * Driven like the session it wraps: `update(nowMs)` for wall-clock work (once per frame on the
 * main thread, once per pulse and per arriving batch in the worker) and `tick()` once per fixed
 * step. No timers, no clock reads beyond the injected ones.
 */

import { TICK_DT_S, copyInputFrame, createInputFrame } from '../../shared';
import type { BotDifficulty, GameEventSink, InputFrame, ModeId, Vec3 } from '../../shared';
import { createNetBots } from '../bots';
import type { NetBots } from '../bots';
import { createHostSession } from '../session';
import type { HostSession, HostSessionOptions, MatchWorldFactory } from '../session';
import { createCompositeHostTransport, createLoopbackHub } from '../transport';
import type { HostTransport, LoopbackHub } from '../transport';

/** What a local pilot reads of its own dragon. `DragonState` and a `HostViewDragon` both fit. */
export interface LocalInputSubject {
  readonly position: Vec3;
  readonly velocity: Vec3;
}

/**
 * Where the host player's input comes from: the devices (`src/input`) or `?autopilot`.
 * `dtS` is the time the sample covers: one tick on the direct path, one rendered frame when the
 * page samples for a worker.
 */
export interface LocalInputSource {
  sample(tick: number, subject: LocalInputSubject | undefined, out: InputFrame, dtS: number): void;
}

/**
 * Host settings applied once, when the room opens (the dev params `?mode=`, `?score=`,
 * `?time=`, `?botlevel=`, `?fill`): a headless test or a soak run configures its match without
 * clicking through the host panel. Plain data, so it crosses to the host worker.
 */
export interface HostAutoSettings {
  readonly mode?: ModeId;
  /** Riders per side. Left out with `autoStart`: just enough for the host and its bots. */
  readonly teamSize?: number;
  readonly scoreLimit?: number;
  /** Seconds; 0 = no limit. */
  readonly timeLimitS?: number;
  readonly botDifficulty?: BotDifficulty;
  /** Seat a host-flown bot in every empty team slot before starting. */
  readonly fillBots?: boolean;
}

/** EMA weight for the HUD's per-tick cost figures. */
export const HOST_COST_SMOOTHING = 0.05;
/** `autoStart`: give up waiting for the bots after this long and start with who is there. */
export const AUTOSTART_PATIENCE_MS = 8000;

export interface HostCoreOptions {
  /** `solo`: one member, no countdown; the room lives on the in-page network alone. */
  readonly kind: 'host' | 'solo';
  /** The room's real transport (PeerJS, or the worker's port). Null: in-page only. */
  readonly transport: HostTransport | null;
  readonly hostName: string;
  /** In-page net-bots (`?bots=N`). */
  readonly bots: number;
  readonly botSeed?: number;
  /** Start the match as soon as the room and its bots are ready (solo, `?autostart`). */
  readonly autoStart: boolean;
  /** Ticks to fast-forward when the match begins (`?skip`). */
  readonly skipTicks: number;
  readonly createMatchWorld?: MatchWorldFactory;
  readonly mapSeed?: number;
  /** See `HostSessionOptions.now`. */
  readonly now?: () => number;
  /** Measure the per-tick cost with this clock (ms). */
  readonly profileClock?: () => number;
  /** `transport` recycles delivered buffers. */
  readonly recycledBuffers?: boolean;
  /** Samples the host player's input inside `tick`. Without it `tick` takes the input. */
  readonly localInput?: LocalInputSource | null;
  /** Called after every tick (debug probe). */
  readonly onTick?: ((core: HostCore) => void) | null;
  /** Every GameEvent of the match, for the host's own views (VFX, audio, HUD). */
  readonly events?: GameEventSink | null;
  /** `?autopilot=bot`: a bot brain flies the host's own dragon. */
  readonly localBot?: boolean;
  /** False: no lag compensation (`?lagcomp=0`). */
  readonly lagCompensation?: boolean;
  readonly autoSettings?: HostAutoSettings | null;
  /** Extra session options (tests: `roomCode`, `random`, `countdownTicks`). */
  readonly session?: Partial<HostSessionOptions>;
}

export class HostCore {
  readonly session: HostSession;
  readonly bots: NetBots | null;
  /** Smoothed cost of one tick inside the session, ms (0 without a profile clock). */
  stepMs = 0;
  simMs = 0;
  snapshotMs = 0;
  /** The steer applied for the host's dragon on the latest tick (camera look-ahead). */
  aimX = 0;
  aimY = 0;

  private readonly hub: LoopbackHub | null;
  private readonly localInput: LocalInputSource | null;
  private readonly onTick: ((core: HostCore) => void) | null;
  private readonly measure: boolean;
  private readonly frame: InputFrame = createInputFrame();
  private autoStart: boolean;
  private autoSettings: HostAutoSettings | null;
  private readonly botCount: number;
  private autoStartSinceMs = -1;
  private skipTicks: number;
  private botsJoined = false;
  private fillPending = false;

  constructor(options: HostCoreOptions) {
    const botCount = Math.max(0, Math.floor(options.bots));
    const outer = options.transport;
    // A solo room and the bots live on an in-page hub; real players arrive on `outer`.
    const hub = outer === null || botCount > 0 ? createLoopbackHub({ recycleBuffers: true }) : null;
    this.hub = hub;
    let transport: HostTransport;
    if (outer === null) {
      if (hub === null) throw new Error('HostCore: no transport');
      transport = hub.createHost();
    } else {
      transport = hub === null ? outer : createCompositeHostTransport(outer, hub.createHost());
    }

    this.localInput = options.localInput ?? null;
    this.onTick = options.onTick ?? null;
    this.measure = options.profileClock !== undefined;
    this.autoStart = options.autoStart;
    this.autoSettings = options.autoSettings ?? null;
    this.botCount = botCount;
    this.skipTicks = Math.max(0, Math.floor(options.skipTicks));

    this.session = createHostSession({
      ...options.session,
      transport,
      hostName: options.hostName,
      recycledBuffers: hub !== null || options.recycledBuffers === true,
      // A solo flight has nobody to wait for at the gate.
      ...(options.kind === 'solo' ? { countdownTicks: 0 } : {}),
      ...(options.createMatchWorld !== undefined
        ? { createMatchWorld: options.createMatchWorld }
        : {}),
      ...(options.mapSeed !== undefined ? { mapSeed: options.mapSeed } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.profileClock !== undefined ? { profileClock: options.profileClock } : {}),
      ...(options.events !== undefined && options.events !== null
        ? { events: options.events }
        : {}),
      ...(options.localBot === true ? { localBot: true } : {}),
      ...(options.lagCompensation === false ? { lagCompensation: false } : {}),
    });
    this.bots =
      hub !== null && botCount > 0
        ? createNetBots({
            count: botCount,
            createTransport: () => hub.createClient(),
            ...(options.botSeed !== undefined ? { seed: options.botSeed } : {}),
          })
        : null;
  }

  /** The host's own player has a dragon in the running match. */
  get localIsRider(): boolean {
    const session = this.session;
    return session.sim?.getDragon(session.localPlayerId) !== undefined;
  }

  open(): void {
    this.session.open();
  }

  /** Ends the room: bots first, then HOST_LEFT to every client and the transports. Final. */
  close(): void {
    this.bots?.dispose();
    this.session.close();
  }

  /** Wall-clock work: session housekeeping, the in-page network, the bots, auto-start. */
  update(nowMs: number): void {
    const session = this.session;
    session.update(nowMs);
    const hub = this.hub;
    if (hub !== null) hub.pump();
    if (session.state !== 'open') return;
    // Before the bots take their seats, so they are dealt onto teams of the final size.
    if (this.autoSettings !== null) this.applyAutoSettings(this.autoSettings);
    const bots = this.bots;
    if (bots !== null && hub !== null) {
      if (!this.botsJoined) {
        this.botsJoined = true;
        bots.connect(session.roomCode, nowMs);
      }
      bots.update(nowMs);
      bots.markOnHost(session);
      // The bots' inputs and intents reach the host before the next tick, not a pump later.
      hub.pump();
    }
    if (this.autoStart) this.driveAutoStart(nowMs);
    if (this.skipTicks > 0 && session.inMatch) {
      // `?skip`: fly that far before the first state is shown.
      const ticks = this.skipTicks;
      this.skipTicks = 0;
      for (let i = 0; i < ticks; i++) this.tick();
    }
  }

  /**
   * One fixed step. `input` is the host player's input when no `localInput` source samples it
   * here; `away` = the page stopped sending input (see `HostSession.tick`).
   */
  tick(input?: Readonly<InputFrame>, away = false): void {
    const session = this.session;
    if (session.state !== 'open') return;
    if (!session.inMatch) {
      session.tick();
      return;
    }
    const tick = session.hostTick + 1;
    const frame = this.frame;
    const source = this.localInput;
    let local: Readonly<InputFrame> | undefined;
    if (source !== null) {
      source.sample(tick, session.sim?.getDragon(session.localPlayerId), frame, TICK_DT_S);
      frame.tick = tick;
      local = frame;
    } else if (input !== undefined && !away) {
      copyInputFrame(frame, input);
      frame.tick = tick;
      local = frame;
    }
    this.aimX = local !== undefined ? local.steerX : 0;
    this.aimY = local !== undefined ? local.steerY : 0;
    session.tick(local, source === null && away);
    if (this.measure) {
      const timing = session.timing;
      this.stepMs += (timing.lastTotalUs / 1000 - this.stepMs) * HOST_COST_SMOOTHING;
      this.simMs += (timing.lastSimUs / 1000 - this.simMs) * HOST_COST_SMOOTHING;
      this.snapshotMs += (timing.lastSnapshotUs / 1000 - this.snapshotMs) * HOST_COST_SMOOTHING;
    }
    if (this.onTick !== null) this.onTick(this);
  }

  private applyAutoSettings(settings: HostAutoSettings): void {
    this.autoSettings = null;
    const session = this.session;
    if (settings.mode !== undefined)
      session.applyIntent({ type: 'host.setMode', mode: settings.mode });
    const teamSize =
      settings.teamSize ?? (this.autoStart ? Math.ceil((this.botCount + 1) / 2) : undefined);
    if (teamSize !== undefined) session.applyIntent({ type: 'host.setTeamSize', teamSize });
    if (settings.scoreLimit !== undefined) {
      session.applyIntent({ type: 'host.setScoreLimit', scoreLimit: settings.scoreLimit });
    }
    if (settings.timeLimitS !== undefined) {
      session.applyIntent({ type: 'host.setTimeLimit', timeLimitS: settings.timeLimitS });
    }
    if (settings.botDifficulty !== undefined) {
      session.applyIntent({ type: 'host.setBotDifficulty', difficulty: settings.botDifficulty });
    }
    this.fillPending = settings.fillBots === true;
  }

  private driveAutoStart(nowMs: number): void {
    const session = this.session;
    if (session.inMatch || session.lobby.phase !== 'lobby') {
      this.autoStart = false;
      return;
    }
    if (this.autoStartSinceMs < 0) this.autoStartSinceMs = nowMs;
    const bots = this.bots;
    const waited = nowMs - this.autoStartSinceMs;
    if (bots !== null && bots.connectedCount < bots.count && waited < AUTOSTART_PATIENCE_MS) {
      return;
    }
    if (this.fillPending) {
      this.fillPending = false;
      session.applyIntent({ type: 'host.fillBots' });
    }
    const blocker = session.startBlocker();
    if (blocker === 'teamsUneven') {
      // Host + an even number of bots: fly 5 v 4 rather than refuse to start.
      session.applyIntent({ type: 'host.setUnevenTeams', enabled: true });
      return;
    }
    if (blocker !== null) return;
    if (session.applyIntent({ type: 'host.start' })) this.autoStart = false;
  }
}

export function createHostCore(options: HostCoreOptions): HostCore {
  return new HostCore(options);
}
