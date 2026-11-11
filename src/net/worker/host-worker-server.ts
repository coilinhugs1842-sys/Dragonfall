/**
 * The worker's side of the host: a `HostCore` behind the page <-> worker protocol. The worker
 * entry file (`src/game/worker/host.worker.ts`) only wires this to `self`, a timer and the
 * clocks; everything else is here, DOM-free, so the node tests run the very same object over an
 * in-memory port.
 *
 * ITS OWN CLOCK. `pulse()` is the timer callback. It runs every tick that is due on a fixed
 * 30 Hz schedule (a late timer is caught up, a long stall is dropped, never replayed), so the
 * match keeps its pace when the page's `requestAnimationFrame` stops (hidden tab).
 *
 * ONE POST PER TICK. A tick's snapshots to every client, its events and the state the host's
 * own page draws leave in one transferred buffer. Replies to what the page forwarded (a PONG, a
 * WELCOME) leave as soon as that batch is handled, not at the next tick.
 *
 * THE HOST PLAYER'S INPUT arrives as samples the page takes once per rendered frame. A tick
 * uses the newest steer and every button seen since the previous tick (so a tap between two
 * ticks is not lost); with no fresh sample the last one is held for `INPUT_HOLD_TICKS`, after
 * which nobody is at the controls and the session flies the dragon on its holding circle.
 */

import { TICK_MS, createInputFrame } from '../../shared';
import type { InputFrame, LobbyState } from '../../shared';
import type { MatchWorldFactory } from '../session';
import {
  AUX_FAST,
  AUX_REASON_LOCAL,
  AUX_REASON_LOST,
  BatchReader,
  BatchWriter,
  BufferPool,
  ExactBuffers,
  REC_INPUT,
  REC_KEEPALIVE,
  REC_PACKET,
  REC_PEER_GONE,
  REC_PEER_OPEN,
  REC_STATE,
  REC_STATS,
  REC_TEXT,
} from './batch';
import type { BatchMessage } from './batch';
import { HostCore } from './host-core';
import type { LocalInputSource } from './host-core';
import {
  INPUT_HOLD_TICKS,
  INPUT_RECORD_BYTES,
  PAGE_STALL_MS,
  WORKER_STATS_INTERVAL_MS,
} from './messages';
import type {
  FromWorkerMessage,
  HostMeta,
  HostWorkerConfig,
  ToWorkerMessage,
  WorkerPilotCourse,
} from './messages';
import { PortHostTransport } from './port-transport';
import { createHostWorkerStats, encodeHostStats, hostStatsBytes } from './stats-record';
import type { HostWorkerStats } from './stats-record';
import { createHostTickInfo, encodeHostState, hostStateBytes } from './view-state';
import type { HostTickInfo } from './view-state';

/** Ticks a late timer may catch up in one pulse; anything beyond is dropped. */
export const WORKER_MAX_TICKS_PER_PULSE = 3;
/**
 * The longest single timer wait. Browsers serve long timeouts from a coarse clock (Chromium on
 * Windows: 32 ms and up may land on the 15.6 ms system tick), which would put a 33.3 ms tick up
 * to half a tick late. So the wait for a tick is cut in two hops, and only the last, short one
 * decides when the tick runs.
 */
export const WORKER_MAX_TIMER_MS = 16;
/** A timer that fires this close before a tick is due runs it rather than waiting again. */
export const WORKER_TIMER_EARLY_MS = 1;
const METRIC_SMOOTHING = 0.05;

/** What the worker entry provides. */
export interface HostWorkerEnv {
  /** `postMessage` with a transfer list. The message is cloned before this returns. */
  post(message: FromWorkerMessage, transfer: ArrayBuffer[]): void;
  /** Monotonic milliseconds. */
  now(): number;
  /** Milliseconds on a clock the page shares (`performance.timeOrigin + performance.now()`). */
  epochNow(): number;
  /** Arms the one timer: call `pulse()` in about `delayMs`. Replaces an armed one. */
  setTimer(delayMs: number): void;
  clearTimer(): void;
  /** Default: the greybox map with terrain collision, built inside the worker. */
  readonly createMatchWorld?: MatchWorldFactory;
  /** Builds the `?autopilot` pilot. Without it the autopilot config is ignored. */
  createPilot?(course: WorkerPilotCourse): LocalInputSource;
}

export class HostWorkerServer {
  /** Null until `init` arrived. */
  core: HostCore | null = null;
  readonly stats: HostWorkerStats = createHostWorkerStats();

  private readonly env: HostWorkerEnv;
  private readonly pool = new BufferPool();
  private readonly writer = new BatchWriter(this.pool);
  private readonly reader = new BatchReader();
  private readonly exact = new ExactBuffers();
  /** The page's buffers this side has finished reading; they go back with the next batch. */
  private readonly returns: ArrayBuffer[] = [];
  private readonly transfer: ArrayBuffer[] = [];
  private readonly batchMessage: BatchMessage = { t: 'b', b: new ArrayBuffer(0), r: [] };
  private port: PortHostTransport | null = null;
  private stopped = false;
  private hasPilot = false;
  private measure = false;
  private epochOffsetMs = 0;

  // The 30 Hz schedule, on `env.now()`.
  private nextTickAtMs = Number.NaN;
  private lastStatsMs = -Infinity;
  private lastPulseUs = 0;

  // The session's clock: `env.now()` minus the time the page was not listening.
  private lastPageMs = 0;
  private stalledMs = 0;

  // The host player's input mailbox.
  private readonly mailFrame: InputFrame = createInputFrame();
  private mailFresh = false;
  private mailEver = false;
  private mailOrButtons = 0;
  private mailLastButtons = 0;
  private mailSampledAtMs = 0;
  private mailStaleTicks = 0;

  private readonly info: HostTickInfo = createHostTickInfo();
  private meta: HostMeta | null = null;
  private metaLobby: LobbyState | null = null;
  private metaBlocker: HostMeta['startBlocker'] = null;

  constructor(env: HostWorkerEnv) {
    this.env = env;
    this.writer.flush = (): void => this.flush();
  }

  /** A message from the page. */
  handle(message: ToWorkerMessage): void {
    if (this.stopped) return;
    const now = this.env.now();
    if (message.t === 'init') {
      this.init(message.config, now);
      return;
    }
    const core = this.core;
    if (core === null) return;
    this.notePage(now);
    switch (message.t) {
      case 'b':
        this.onBatch(message);
        break;
      case 'open':
        core.open();
        break;
      case 'intent':
        core.session.applyIntent(message.intent);
        break;
      case 'endMatch':
        core.session.endMatch();
        break;
      case 'transportOpen':
        this.port?.emitOpen(message.roomCode);
        break;
      case 'transportError':
        this.port?.emitError(message.error);
        break;
      case 'close':
        this.stopped = true;
        this.env.clearTimer();
        core.close();
        this.flush();
        return;
    }
    this.afterWork();
  }

  /** The timer callback: due ticks, housekeeping, stats, and the next timer. */
  pulse(): void {
    const core = this.core;
    if (this.stopped || core === null) return;
    const env = this.env;
    const start = env.now();
    const pageStalled = start - this.lastPageMs >= PAGE_STALL_MS;
    const statsDue = start - this.lastStatsMs >= WORKER_STATS_INTERVAL_MS;
    if (
      !pageStalled &&
      !statsDue &&
      !Number.isNaN(this.nextTickAtMs) &&
      start < this.nextTickAtMs - WORKER_TIMER_EARLY_MS
    ) {
      // The first hop of a split wait: nothing is due yet.
      this.arm(start);
      return;
    }
    core.update(this.sessionNowAt(start));

    if (pageStalled) {
      // Nothing can come in or go out: hold the world until the page is back.
      this.nextTickAtMs = Number.NaN;
    } else {
      if (Number.isNaN(this.nextTickAtMs)) this.nextTickAtMs = start;
      const due = start + WORKER_TIMER_EARLY_MS;
      let steps = 0;
      while (due >= this.nextTickAtMs && steps < WORKER_MAX_TICKS_PER_PULSE) {
        this.runTick(core, this.nextTickAtMs, start);
        this.nextTickAtMs += TICK_MS;
        steps++;
      }
      // Further behind than the cap: that time is dropped, not replayed.
      if (due >= this.nextTickAtMs) this.nextTickAtMs = start + TICK_MS;
    }

    if (statsDue) {
      this.lastStatsMs = start;
      this.writeStats(core);
    }
    this.afterWork();

    const end = env.now();
    if (this.measure) {
      const pulseMs = end - start;
      this.lastPulseUs = pulseMs * 1000;
      const stats = this.stats;
      stats.pulseMs += (pulseMs - stats.pulseMs) * METRIC_SMOOTHING;
      if (pulseMs > stats.pulseMaxMs) stats.pulseMaxMs = pulseMs;
    }
    if (this.stopped) return;
    this.arm(end);
  }

  /** Arms the timer for whatever is due next: a tick, or the stats (which are the heartbeat). */
  private arm(now: number): void {
    const untilStats = this.lastStatsMs + WORKER_STATS_INTERVAL_MS - now;
    const untilTick = Number.isNaN(this.nextTickAtMs) ? untilStats : this.nextTickAtMs - now;
    let delay = untilTick < untilStats ? untilTick : untilStats;
    if (delay > 2 * WORKER_MAX_TIMER_MS) delay = WORKER_MAX_TIMER_MS;
    else if (delay > WORKER_MAX_TIMER_MS) delay /= 2;
    this.env.setTimer(delay > 0 ? Math.floor(delay) : 0);
  }

  /** Stops ticking and lets go (the page is about to terminate the worker). */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.env.clearTimer();
  }

  // --- Setup -----------------------------------------------------------------------------------

  private init(config: HostWorkerConfig, now: number): void {
    if (this.core !== null) return;
    const env = this.env;
    this.epochOffsetMs = env.epochNow() - now;
    this.lastPageMs = now;
    this.measure = config.measure;
    const pilot =
      config.autopilot !== null && env.createPilot !== undefined
        ? env.createPilot(config.autopilot)
        : null;
    this.hasPilot = pilot !== null;
    const port = config.hasTransport
      ? new PortHostTransport(this.writer, {
          open: (roomCode: string): void => {
            this.flush();
            env.post({ t: 'transportOpen', roomCode }, []);
          },
          dispose: (): void => {
            this.flush();
            env.post({ t: 'transportDispose' }, []);
          },
        })
      : null;
    this.port = port;
    try {
      this.core = new HostCore({
        kind: config.kind,
        transport: port,
        hostName: config.hostName,
        bots: config.bots,
        autoStart: config.autoStart,
        skipTicks: config.skipTicks,
        now: (): number => this.sessionNowAt(env.now()),
        // Packets are delivered from per-size scratch buffers: cache their DataViews.
        recycledBuffers: true,
        localInput: pilot,
        ...(config.botSeed !== undefined ? { botSeed: config.botSeed } : {}),
        ...(config.mapSeed !== undefined ? { mapSeed: config.mapSeed } : {}),
        ...(env.createMatchWorld !== undefined ? { createMatchWorld: env.createMatchWorld } : {}),
        ...(config.measure ? { profileClock: (): number => env.now() } : {}),
        session: {
          ...(config.roomCode !== undefined ? { roomCode: config.roomCode } : {}),
          ...(config.countdownTicks !== undefined ? { countdownTicks: config.countdownTicks } : {}),
        },
      });
    } catch (error) {
      this.stopped = true;
      env.post(
        { t: 'failed', message: error instanceof Error ? error.message : String(error) },
        [],
      );
      return;
    }
    env.post({ t: 'ready' }, []);
    this.afterWork();
    env.setTimer(0);
  }

  // --- The session clock -------------------------------------------------------------------------

  /**
   * `now` minus the time the page was stalled. While the page is silent past `PAGE_STALL_MS`
   * the clock stands still, so links are not timed out for silence the worker could not hear.
   */
  private sessionNowAt(now: number): number {
    const silent = now - this.lastPageMs;
    const frozen = silent > PAGE_STALL_MS ? silent - PAGE_STALL_MS : 0;
    return now - this.stalledMs - frozen;
  }

  private notePage(now: number): void {
    const silent = now - this.lastPageMs;
    if (silent > PAGE_STALL_MS) this.stalledMs += silent - PAGE_STALL_MS;
    this.lastPageMs = now;
  }

  // --- Page -> worker ----------------------------------------------------------------------------

  private onBatch(message: BatchMessage): void {
    const returned = message.r;
    for (let i = 0; i < returned.length; i++) {
      const buffer = returned[i];
      if (buffer !== undefined) this.pool.release(buffer);
    }
    const reader = this.reader;
    const port = this.port;
    if (reader.open(message.b)) {
      while (reader.next()) {
        switch (reader.kind) {
          case REC_PACKET:
            if (port !== null) {
              const packet = this.exact.filled(reader.bytes, reader.offset, reader.length);
              port.deliver(reader.link, reader.aux === AUX_FAST ? 'fast' : 'ctrl', packet.buffer);
            }
            break;
          case REC_TEXT:
            port?.deliver(reader.link, reader.aux === AUX_FAST ? 'fast' : 'ctrl', '');
            break;
          case REC_PEER_OPEN:
            port?.peerOpen(reader.link);
            break;
          case REC_PEER_GONE:
            port?.peerGone(
              reader.link,
              reader.aux === AUX_REASON_LOCAL
                ? 'local'
                : reader.aux === AUX_REASON_LOST
                  ? 'lost'
                  : 'remote',
            );
            break;
          case REC_INPUT:
            if (reader.length >= INPUT_RECORD_BYTES) this.onInput(reader.view, reader.offset);
            break;
          case REC_KEEPALIVE:
          default:
            break;
        }
      }
    }
    reader.close();
    this.returns.push(message.b);
  }

  private onInput(view: DataView, at: number): void {
    const frame = this.mailFrame;
    frame.steerX = view.getFloat32(at, true);
    frame.steerY = view.getFloat32(at + 4, true);
    const buttons = view.getUint16(at + 8, true);
    this.mailOrButtons |= buttons;
    this.mailLastButtons = buttons;
    this.mailSampledAtMs = view.getFloat64(at + 12, true);
    this.mailFresh = true;
    this.mailEver = true;
  }

  // --- Ticks -------------------------------------------------------------------------------------

  private runTick(core: HostCore, dueMs: number, nowMs: number): void {
    const session = core.session;
    const stats = this.stats;
    const info = this.info;
    let input: InputFrame | undefined;
    let away = false;
    info.inputAgeMs = -1;
    if (session.inMatch && !this.hasPilot) {
      const frame = this.mailFrame;
      if (this.mailFresh) {
        this.mailFresh = false;
        this.mailStaleTicks = 0;
        frame.buttons = this.mailOrButtons;
        this.mailOrButtons = 0;
        input = frame;
        const age = dueMs + this.epochOffsetMs - this.mailSampledAtMs;
        info.inputAgeMs = age;
        stats.inputAgeMs += (age - stats.inputAgeMs) * METRIC_SMOOTHING;
        if (age > stats.inputAgeMaxMs) stats.inputAgeMaxMs = age;
      } else if (++this.mailStaleTicks > INPUT_HOLD_TICKS) {
        // The page is not sampling at all (hidden tab): nobody is at the controls.
        away = true;
      } else if (this.mailEver) {
        // No sample since the last tick (a slow frame): keep flying on the last one.
        frame.buttons = this.mailLastButtons;
        input = frame;
        stats.inputHeldTicks++;
      }
    } else if (!session.inMatch) {
      this.mailFresh = false;
      this.mailEver = false;
      this.mailOrButtons = 0;
      this.mailStaleTicks = 0;
    }

    core.tick(input, away);

    const late = nowMs > dueMs ? nowMs - dueMs : 0;
    stats.lateMs += (late - stats.lateMs) * METRIC_SMOOTHING;
    if (late > stats.lateMaxMs) stats.lateMaxMs = late;

    const sim = session.sim;
    if (sim !== null) {
      const timing = session.timing;
      info.hostTick = session.hostTick;
      info.tickAtMs = dueMs + this.epochOffsetMs;
      info.phase = session.matchPhase;
      info.phaseTimeS = session.matchClock.phaseTimeS;
      info.localIsRider = core.localIsRider;
      info.aimX = core.aimX;
      info.aimY = core.aimY;
      info.stepUs = timing.lastTotalUs;
      info.simUs = timing.lastSimUs;
      info.snapshotUs = timing.lastSnapshotUs;
      info.pulseUs = this.lastPulseUs;
      const prev = sim.prev;
      const current = sim.current;
      const at = this.writer.begin(REC_STATE, 0, 0, hostStateBytes(prev, current));
      if (at >= 0) encodeHostState(this.writer.view, at, info, prev, current);
    }
    // One post per tick: this tick's packets and its state together.
    this.flush();
  }

  private writeStats(core: HostCore): void {
    const session = core.session;
    const stats = this.stats;
    stats.sentBytesPerS = session.stats.sentBytesPerS;
    stats.receivedBytesPerS = session.stats.receivedBytesPerS;
    stats.malformed = session.counters.malformed;
    stats.ticks = session.hostTick;
    stats.clientCount = session.clientCount;
    stats.botCount = core.bots?.count ?? 0;
    stats.botsConnected = core.bots?.connectedCount ?? 0;
    stats.stepMs = core.stepMs;
    stats.simMs = core.simMs;
    stats.snapshotMs = core.snapshotMs;
    stats.maxStepMs = session.timing.maxTotalUs / 1000;
    const lobby = session.lobby;
    const at = this.writer.begin(REC_STATS, 0, 0, hostStatsBytes(lobby));
    if (at >= 0) encodeHostStats(this.writer.view, at, stats, lobby, session.playerPings);
  }

  // --- Worker -> page ----------------------------------------------------------------------------

  /** Posts what the work just done produced, then the room's slow state if it changed. */
  private afterWork(): void {
    this.flush();
    const core = this.core;
    if (core === null) return;
    const session = core.session;
    const lobby = session.lobby;
    if (lobby !== this.metaLobby) {
      this.metaLobby = lobby;
      this.metaBlocker = session.startBlocker();
    }
    const blocker = session.state === 'open' ? this.metaBlocker : null;
    const last = this.meta;
    if (
      last !== null &&
      last.state === session.state &&
      last.error === session.error &&
      last.roomCode === session.roomCode &&
      last.lobby === lobby &&
      last.inMatch === session.inMatch &&
      last.matchPhase === session.matchPhase &&
      last.startBlocker === blocker
    ) {
      return;
    }
    const meta: HostMeta = {
      state: session.state,
      error: session.error,
      roomCode: session.roomCode,
      lobby,
      localPlayerId: session.localPlayerId,
      hostTick: session.hostTick,
      inMatch: session.inMatch,
      matchPhase: session.matchPhase,
      startBlocker: blocker,
    };
    this.meta = meta;
    this.env.post({ t: 'meta', meta }, []);
  }

  private flush(): void {
    // The page's buffers ride back with whatever is posted next (a tick, or the stats).
    const buffer = this.writer.take(this.env.epochNow());
    if (buffer === null) return;
    const message = this.batchMessage;
    const transfer = this.transfer;
    const returns = this.returns;
    transfer.length = 0;
    transfer.push(buffer);
    for (let i = 0; i < returns.length; i++) {
      const returned = returns[i];
      if (returned !== undefined) transfer.push(returned);
    }
    message.b = buffer;
    message.r = returns;
    this.env.post(message, transfer);
    returns.length = 0;
    transfer.length = 0;
  }
}

export function createHostWorkerServer(env: HostWorkerEnv): HostWorkerServer {
  return new HostWorkerServer(env);
}
