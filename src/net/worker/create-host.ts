/**
 * `createHost`: the one way `src/game` gets a `HostHandle`. It hosts in a Web Worker when a
 * `spawnWorker` is given and falls back to the main thread when
 *
 * - none is given (`?noworker`, or the browser has no `Worker`),
 * - spawning throws (a CSP or a `file:` origin that refuses the script),
 * - the worker reports an error or stays silent before it has said `ready`.
 *
 * The fallback happens behind the same object: the handle the caller holds keeps working, so
 * the game layer has no second code path. A worker that fails AFTER it started cannot be
 * replaced (the room's state lived in it): the room closes with an error, like a lost host.
 */

import type {
  LobbyState,
  MatchPhase,
  MatchPlayerStats,
  MatchWinner,
  PlayerId,
  UiIntent,
} from '../../shared';
import type { StartBlocker } from '../../sim/lobby';
import type { HostSessionState } from '../session';
import type { TransportError } from '../transport';
import type { HostCoreOptions } from './host-core';
import { DirectHost } from './host-handle';
import type { HostHandle, HostMetrics } from './host-handle';
import type { HostWorkerConfig, WorkerPilotCourse } from './messages';
import type { HostViewState } from './view-state';
import { WorkerHost } from './worker-host';
import type { WorkerLike } from './worker-host';

export interface CreateHostOptions extends Omit<HostCoreOptions, 'onTick'> {
  /** Starts the host worker. Null or left out: host on the main thread. */
  readonly spawnWorker?: (() => WorkerLike) | null;
  /** A clock the worker shares; needed with `spawnWorker`. */
  readonly epochNow?: () => number;
  /**
   * `?autopilot`: the worker flies the host's dragon on this course itself. On the direct path
   * `localInput` is asked instead, so it must fly the same course.
   */
  readonly autopilot?: WorkerPilotCourse | null;
  /** Called after every tick (direct) or for every state that arrives (worker). */
  readonly onState?: ((hostTick: number, current: Readonly<HostViewState>) => void) | null;
  /** The worker could not be used and the host now runs on the main thread. */
  readonly onWorkerFallback?: ((reason: string) => void) | null;
  readonly workerStartTimeoutMs?: number;
}

function createDirect(options: CreateHostOptions): DirectHost {
  const onState = options.onState ?? null;
  return new DirectHost({
    ...options,
    onTick:
      onState === null
        ? null
        : (core): void => {
            const sim = core.session.sim;
            if (sim !== null) onState(core.session.hostTick, sim.current);
          },
  });
}

function workerConfig(options: CreateHostOptions): HostWorkerConfig {
  const session = options.session;
  return {
    kind: options.kind,
    hostName: options.hostName,
    hasTransport: options.transport !== null,
    bots: options.bots,
    autoStart: options.autoStart,
    skipTicks: options.skipTicks,
    measure: options.profileClock !== undefined,
    autopilot: options.autopilot ?? null,
    localBot: options.localBot === true,
    lagCompensation: options.lagCompensation !== false,
    wantEvents: options.events !== undefined && options.events !== null,
    autoSettings: options.autoSettings ?? null,
    cinematics: options.cinematics !== false && session?.cinematics !== false,
    ...(options.botSeed !== undefined ? { botSeed: options.botSeed } : {}),
    ...(options.mapSeed !== undefined ? { mapSeed: options.mapSeed } : {}),
    ...(session?.roomCode !== undefined ? { roomCode: session.roomCode } : {}),
    ...(session?.countdownTicks !== undefined ? { countdownTicks: session.countdownTicks } : {}),
    ...(session?.introTicks !== undefined ? { introTicks: session.introTicks } : {}),
    ...(session?.launchTicks !== undefined ? { launchTicks: session.launchTicks } : {}),
  };
}

/** A handle that can swap the host behind it once, from the worker to the main thread. */
class SwitchingHost implements HostHandle {
  private inner: HostHandle;
  private opened = false;
  private closed = false;

  constructor(options: CreateHostOptions, spawnWorker: () => WorkerLike) {
    // Set when the worker fails while it is still being constructed.
    let early: HostHandle | null = null;
    const fallBack = (reason: string): void => {
      options.onWorkerFallback?.(reason);
      const direct = createDirect(options);
      early = direct;
      this.inner = direct;
      if (this.closed) direct.close();
      else if (this.opened) direct.open();
    };
    let worker: WorkerLike | null = null;
    let reason = '';
    try {
      worker = spawnWorker();
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (worker === null) {
      options.onWorkerFallback?.(reason);
      this.inner = createDirect(options);
      return;
    }
    const now = options.now ?? ((): number => 0);
    const hosted = new WorkerHost({
      worker,
      transport: options.transport,
      config: workerConfig(options),
      now,
      epochNow: options.epochNow ?? now,
      localInput: options.localInput ?? null,
      events: options.events ?? null,
      onState: options.onState ?? null,
      onStartFailed: fallBack,
      ...(options.profileClock !== undefined ? { profileClock: options.profileClock } : {}),
      ...(options.workerStartTimeoutMs !== undefined
        ? { startTimeoutMs: options.workerStartTimeoutMs }
        : {}),
    });
    this.inner = early ?? hosted;
  }

  get mode(): 'direct' | 'worker' {
    return this.inner.mode;
  }

  get state(): HostSessionState {
    return this.inner.state;
  }

  get error(): TransportError | null {
    return this.inner.error;
  }

  get roomCode(): string {
    return this.inner.roomCode;
  }

  get lobby(): LobbyState | null {
    return this.inner.lobby;
  }

  get localPlayerId(): PlayerId {
    return this.inner.localPlayerId;
  }

  get hostTick(): number {
    return this.inner.hostTick;
  }

  get inMatch(): boolean {
    return this.inner.inMatch;
  }

  get matchPhase(): MatchPhase {
    return this.inner.matchPhase;
  }

  get phaseTimeS(): number {
    return this.inner.phaseTimeS;
  }

  get matchRound(): number {
    return this.inner.matchRound;
  }

  get matchWinner(): MatchWinner | null {
    return this.inner.matchWinner;
  }

  get timeRemainingS(): number {
    return this.inner.timeRemainingS;
  }

  get scoreEmber(): number {
    return this.inner.scoreEmber;
  }

  get scoreFrost(): number {
    return this.inner.scoreFrost;
  }

  get matchStats(): readonly Readonly<MatchPlayerStats>[] {
    return this.inner.matchStats;
  }

  get matchStatsCount(): number {
    return this.inner.matchStatsCount;
  }

  get localIsRider(): boolean {
    return this.inner.localIsRider;
  }

  get prev(): Readonly<HostViewState> | null {
    return this.inner.prev;
  }

  get current(): Readonly<HostViewState> | null {
    return this.inner.current;
  }

  get startBlocker(): StartBlocker | null {
    return this.inner.startBlocker;
  }

  get canSkipIntro(): boolean {
    return this.inner.canSkipIntro;
  }

  get canSkipCinematic(): boolean {
    return this.inner.canSkipCinematic;
  }

  get playerPings(): readonly number[] {
    return this.inner.playerPings;
  }

  get clientCount(): number {
    return this.inner.clientCount;
  }

  get botCount(): number {
    return this.inner.botCount;
  }

  get botsConnected(): number {
    return this.inner.botsConnected;
  }

  get aimX(): number {
    return this.inner.aimX;
  }

  get aimY(): number {
    return this.inner.aimY;
  }

  get metrics(): Readonly<HostMetrics> {
    return this.inner.metrics;
  }

  open(): void {
    this.opened = true;
    this.inner.open();
  }

  close(): void {
    this.closed = true;
    this.inner.close();
  }

  applyIntent(intent: UiIntent): void {
    this.inner.applyIntent(intent);
  }

  endMatch(): void {
    this.inner.endMatch();
  }

  requestSkipIntro(force = false): boolean {
    return this.inner.requestSkipIntro(force);
  }

  requestSkipCinematic(force = false): boolean {
    return this.inner.requestSkipCinematic(force);
  }

  update(nowMs: number): void {
    this.inner.update(nowMs);
  }

  fixedStep(): void {
    this.inner.fixedStep();
  }

  viewAlpha(loopAlpha: number, nowMs: number): number {
    return this.inner.viewAlpha(loopAlpha, nowMs);
  }
}

export function createHost(options: CreateHostOptions): HostHandle {
  const spawnWorker = options.spawnWorker ?? null;
  return spawnWorker === null ? createDirect(options) : new SwitchingHost(options, spawnWorker);
}
