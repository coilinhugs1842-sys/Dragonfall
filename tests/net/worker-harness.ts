/**
 * Test rig for the host worker: the real `HostWorkerServer` and the real `WorkerHost` joined by
 * an in-memory port instead of a `Worker`. Every message goes through `structuredClone` with its
 * transfer list, so a buffer used after it was transferred, or transferred twice, fails here as
 * it would in a browser. Nothing is delivered until the rig pumps, and there are no timers: one
 * loop step is one millisecond on a manual clock.
 *
 * The page's real transport is a loopback hub host, so real `ClientSession`s can join through
 * the page exactly as WebRTC peers would.
 */

import {
  ClientSession,
  createMemoryTokenStore,
  openSkyMatchWorldFactory,
} from '../../src/net/session';
import type { ClientSessionOptions, MatchWorldFactory } from '../../src/net/session';
import { createLoopbackHub } from '../../src/net/transport';
import type { LoopbackHostTransport, LoopbackHub } from '../../src/net/transport';
import { HostWorkerServer, createHost } from '../../src/net/worker';
import type {
  CreateHostOptions,
  FromWorkerMessage,
  HostHandle,
  HostViewState,
  LocalInputSource,
  ToWorkerMessage,
  WorkerLike,
  WorkerPilotCourse,
} from '../../src/net/worker';
import {
  BUTTON_BOOST,
  BUTTON_DODGE_LEFT,
  BUTTON_FLAP,
  TICK_MS,
  createWorldView,
} from '../../src/shared';
import type { MutableWorldView } from '../../src/shared';
import { FRAME_MS, ScriptPilot } from './session-harness';

/** The two threads share an epoch clock; it is far from either one's `now()`. */
export const EPOCH_MS = 1_731_300_000_000;
export const WORKER_ROOM = 'WKR22';

export interface Clock {
  now: number;
}

export interface FakeWorkerOptions {
  readonly createMatchWorld?: MatchWorldFactory;
  readonly createPilot?: (course: WorkerPilotCourse) => LocalInputSource;
  /** `error`: the script throws while starting. `silent`: it never says anything. */
  readonly start?: 'ok' | 'error' | 'silent';
}

/** A `Worker` stand-in whose "thread" runs when the rig says so. */
export class FakeWorker implements WorkerLike {
  readonly server: HostWorkerServer;
  terminated = false;
  /** Messages posted to the page, in total. */
  postedToPage = 0;
  private readonly toWorker: ToWorkerMessage[] = [];
  private readonly toPage: FromWorkerMessage[] = [];
  private timerAtMs = Number.NaN;
  private onMessage: (message: FromWorkerMessage) => void = () => {};
  private onError: (message: string) => void = () => {};
  private readonly start: 'ok' | 'error' | 'silent';
  private failed = false;

  constructor(
    private readonly clock: Clock,
    options: FakeWorkerOptions = {},
  ) {
    this.start = options.start ?? 'ok';
    this.server = new HostWorkerServer({
      post: (message, transfer): void => {
        this.postedToPage++;
        this.toPage.push(structuredClone(message, { transfer }));
      },
      now: () => clock.now,
      epochNow: () => clock.now + EPOCH_MS,
      setTimer: (delayMs): void => {
        this.timerAtMs = clock.now + delayMs;
      },
      clearTimer: (): void => {
        this.timerAtMs = Number.NaN;
      },
      createMatchWorld: options.createMatchWorld ?? openSkyMatchWorldFactory,
      ...(options.createPilot !== undefined ? { createPilot: options.createPilot } : {}),
    });
  }

  post(message: ToWorkerMessage, transfer: ArrayBuffer[]): void {
    if (this.terminated) return;
    this.toWorker.push(structuredClone(message, { transfer }));
  }

  listen(
    onMessage: (message: FromWorkerMessage) => void,
    onError: (message: string) => void,
  ): void {
    this.onMessage = onMessage;
    this.onError = onError;
  }

  terminate(): void {
    this.terminated = true;
    this.server.dispose();
    this.toWorker.length = 0;
    this.toPage.length = 0;
  }

  /** The worker thread's turn: its queued messages, then its timer if due. */
  runWorker(): void {
    if (this.terminated) return;
    if (this.start !== 'ok') {
      this.toWorker.length = 0;
      if (this.start === 'error' && !this.failed) {
        this.failed = true;
        this.raise('SyntaxError: the host worker script is broken');
      }
      return;
    }
    while (this.toWorker.length > 0) {
      const message = this.toWorker.shift();
      if (message !== undefined) this.server.handle(message);
      if (this.terminated) return;
    }
    if (this.clock.now >= this.timerAtMs) {
      this.timerAtMs = Number.NaN;
      this.server.pulse();
    }
  }

  /** The page's turn to receive. */
  deliverToPage(): number {
    let delivered = 0;
    while (this.toPage.length > 0 && !this.terminated) {
      const message = this.toPage.shift();
      if (message !== undefined) {
        this.onMessage(message);
        delivered++;
      }
    }
    return delivered;
  }

  /** An uncaught error in the worker, as the page hears of it. */
  raise(message: string): void {
    this.onError(message);
  }

  get queuedToPage(): number {
    return this.toPage.length;
  }
}

/** A deterministic pilot for the host's own dragon: a function of the tick and the dragon only. */
export const scriptedHostInput: LocalInputSource = {
  sample(tick, subject, out): void {
    out.tick = tick;
    out.steerX = 0.35 + 0.5 * Math.sin(tick * 0.05);
    const climb = subject === undefined ? 0 : (350 - subject.position.y) / 120;
    out.steerY = Math.max(-1, Math.min(1, climb)) * 0.6 + 0.2 * Math.sin(tick * 0.031);
    let buttons = 0;
    if (tick % 200 < 60) buttons |= BUTTON_BOOST;
    if (tick % 90 < 3) buttons |= BUTTON_FLAP;
    if (tick % 150 === 20) buttons |= BUTTON_DODGE_LEFT;
    out.buttons = buttons;
  },
};

export interface RoomClient {
  readonly session: ClientSession;
  readonly pilot: ScriptPilot;
  readonly view: MutableWorldView;
  readonly clockOffsetMs: number;
}

export interface WorkerRoomOptions {
  readonly host?: Partial<CreateHostOptions>;
  readonly worker?: FakeWorkerOptions;
  /** False: a solo room (no transport on the page). */
  readonly transport?: boolean;
  /** Left out: host through a `FakeWorker`. `null`: no worker at all (the direct path). */
  readonly spawnWorker?: (() => WorkerLike) | null;
  /** The world the clients predict in (the same one the worker builds). */
  readonly createMatchWorld?: MatchWorldFactory;
}

export class WorkerRoom {
  readonly clock: Clock = { now: 0 };
  readonly hub: LoopbackHub = createLoopbackHub();
  readonly transport: LoopbackHostTransport | null;
  /** Null when the room was made without a `FakeWorker`. */
  readonly worker: FakeWorker | null;
  readonly host: HostHandle;
  readonly clients: RoomClient[] = [];
  readonly fallbacks: string[] = [];
  /** Every state the page received (or the direct host produced), by host tick. */
  onState: ((hostTick: number, current: Readonly<HostViewState>) => void) | null = null;
  /** False: the tab is hidden, `update` is not called (no animation frames). */
  visible = true;
  /** False: the page's main thread is stalled; it neither sends nor receives. */
  pageAlive = true;
  /** Alphas the page blended with, newest last (only while `recordAlpha`). */
  recordAlpha = false;
  readonly alphas: number[] = [];

  private nextFrameAt = 0;
  private nextTickAt = 0;
  private readonly world: MatchWorldFactory;

  constructor(options: WorkerRoomOptions = {}) {
    this.world = options.createMatchWorld ?? openSkyMatchWorldFactory;
    this.transport = options.transport === false ? null : this.hub.createHost();
    let made: FakeWorker | null = null;
    const spawn =
      options.spawnWorker !== undefined
        ? options.spawnWorker
        : (): WorkerLike => {
            made = new FakeWorker(this.clock, {
              createMatchWorld: this.world,
              ...options.worker,
            });
            return made;
          };
    this.host = createHost({
      kind: this.transport === null ? 'solo' : 'host',
      transport: this.transport,
      hostName: 'Host',
      bots: 0,
      autoStart: false,
      skipTicks: 0,
      createMatchWorld: this.world,
      now: () => this.clock.now,
      epochNow: () => this.clock.now + EPOCH_MS,
      profileClock: () => this.clock.now,
      localInput: scriptedHostInput,
      spawnWorker: spawn,
      onWorkerFallback: (reason) => {
        this.fallbacks.push(reason);
      },
      onState: (tick, current) => {
        this.onState?.(tick, current);
      },
      session: { roomCode: WORKER_ROOM, countdownTicks: 30 },
      // Start leads straight to the countdown; the timeline tests turn the cinematics on.
      cinematics: false,
      ...options.host,
    });
    this.worker = made;
  }

  /** Opens the room and runs until it is open (or closed). */
  open(): this {
    this.host.open();
    this.runUntil(() => this.host.state === 'open' || this.host.state === 'closed', 12_000);
    return this;
  }

  addClient(name: string, options: Partial<ClientSessionOptions> = {}): RoomClient {
    const index = this.clients.length;
    const client: RoomClient = {
      session: new ClientSession({
        transport: this.hub.createClient(),
        createMatchWorld: this.world,
        tokenStore: createMemoryTokenStore(),
        ...options,
      }),
      pilot: new ScriptPilot(index + 1),
      view: createWorldView(),
      clockOffsetMs: 5000 + index * 1234.5,
    };
    this.clients.push(client);
    client.session.connect(this.host.roomCode, name, this.clock.now + client.clockOffsetMs);
    return client;
  }

  join(name: string, options: Partial<ClientSessionOptions> = {}): RoomClient {
    const client = this.addClient(name, options);
    this.runUntil(() => client.session.status !== 'connecting', 20_000);
    return client;
  }

  run(ms: number): void {
    const end = this.clock.now + ms;
    while (this.clock.now < end) this.step();
  }

  runUntil(done: () => boolean, maxMs = 10_000): void {
    const end = this.clock.now + maxMs;
    while (!done()) {
      if (this.clock.now >= end) throw new Error(`room: condition not met within ${maxMs} ms`);
      this.step();
    }
  }

  dispose(): void {
    for (const client of this.clients) client.session.dispose();
    this.host.close();
  }

  private step(): void {
    this.clock.now += 1;
    const now = this.clock.now;
    const host = this.host;

    // The page's main thread: data-channel tasks, an animation frame, worker messages.
    if (this.pageAlive) {
      this.hub.pump();
      if (now >= this.nextFrameAt) {
        this.nextFrameAt += FRAME_MS;
        if (this.nextFrameAt < now) this.nextFrameAt = now + FRAME_MS;
        if (this.visible) {
          // The page's fixed loop: it steps a host on this thread, and a worker ignores it.
          while (now >= this.nextTickAt) {
            this.nextTickAt += TICK_MS;
            host.fixedStep();
          }
          host.update(now);
          if (this.recordAlpha && host.current !== null) {
            this.alphas.push(host.viewAlpha(0, now));
          }
        } else {
          this.nextTickAt = now;
        }
      }
      this.worker?.deliverToPage();
    }

    // Other machines: they run whatever the host's page is doing.
    if (now % 16 === 0) {
      for (const client of this.clients) {
        const session = client.session;
        session.advance(now + client.clockOffsetMs, client.pilot);
        if (session.inMatch) session.writeWorldView(client.view);
      }
    }

    // The worker thread.
    this.worker?.runWorker();
  }
}

/** Everybody readies up and the host starts; runs until the countdown is over. */
export function startRoomMatch(room: WorkerRoom): void {
  for (const client of room.clients) {
    client.session.sendIntent({ type: 'lobby.ready', ready: true });
  }
  room.runUntil(() => room.host.startBlocker === null, 5000);
  room.host.applyIntent({ type: 'host.start' });
  room.runUntil(() => room.host.matchPhase === 'playing', 20_000);
}
