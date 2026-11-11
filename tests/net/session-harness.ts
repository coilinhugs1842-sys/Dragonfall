/**
 * Test rig for the sessions: one HostSession and any number of ClientSessions on a loopback hub,
 * optionally behind dev/netsim, driven by a manual millisecond clock. No timers anywhere, so a
 * run is deterministic for a given seed.
 *
 * One loop iteration is one millisecond: pump the transports, `host.update`, the host's 30 Hz
 * ticks when due, and the clients' 60 fps frames when due.
 */

import { createNetsim } from '../../src/dev/netsim';
import type { Netsim, NetsimProfile } from '../../src/dev/netsim';
import { createLoopbackHub } from '../../src/net/transport';
import type {
  ClientTransport,
  LoopbackClientTransport,
  LoopbackHostTransport,
  LoopbackHub,
  LoopbackOptions,
} from '../../src/net/transport';
import type { SnapshotOwner } from '../../src/net/protocol';
import {
  ClientSession,
  HostSession,
  createMemoryTokenStore,
  openSkyMatchWorldFactory,
} from '../../src/net/session';
import type {
  ClientInputSampler,
  ClientSessionOptions,
  HostSessionOptions,
  MatchWorldFactory,
  ReconnectTokenStore,
} from '../../src/net/session';
import {
  BUTTON_BOOST,
  BUTTON_DODGE_LEFT,
  BUTTON_FLAP,
  TICK_MS,
  createInputFrame,
  createSeededRandom,
  createWorldView,
} from '../../src/shared';
import type { InputFrame, MutableWorldView } from '../../src/shared';

export const ROOM = 'KH7P2';
export const FRAME_MS = 1000 / 60;

/** Steer-Y that holds an altitude (what a pilot does without thinking about it). */
export function holdAltitude(own: Readonly<SnapshotOwner> | null, altitude: number): number {
  if (own === null) return 0;
  const wantedPitch = Math.max(-0.5, Math.min(0.5, (altitude - own.position.y) / 150));
  return Math.max(-1, Math.min(1, (wantedPitch - own.pitch) * 2));
}

/** A scripted pilot: a weaving loop with boosts, flaps and a dodge press every `dodgeEvery` ticks. */
export class ScriptPilot implements ClientInputSampler {
  step = 0;
  /** Dodge presses made so far (each is one tick of BUTTON_DODGE_LEFT). */
  dodgePresses = 0;

  constructor(
    private readonly variant: number,
    public dodgeEvery = 150,
    /** Flap bursts on (default). */
    public flaps = true,
  ) {}

  sample(frame: InputFrame, own: Readonly<SnapshotOwner> | null): void {
    const step = this.step++;
    const v = this.variant;
    frame.steerX = 0.3 + Math.sin(step * 0.05 + v) * 0.6;
    frame.steerY = holdAltitude(own, 300 + v * 25) * 0.7 + Math.sin(step * 0.031 + v * 2) * 0.3;
    let buttons = 0;
    if ((step + v * 40) % 200 < 60) buttons |= BUTTON_BOOST;
    if (this.flaps && step % 90 < 3) buttons |= BUTTON_FLAP;
    if (own !== null && step % this.dodgeEvery === 20) {
      buttons |= BUTTON_DODGE_LEFT;
      this.dodgePresses++;
    }
    frame.buttons = buttons;
  }
}

export interface RigClient {
  readonly session: ClientSession;
  /** The loopback end (inside netsim when there is one): `inner.close()` etc. for tests. */
  readonly inner: LoopbackClientTransport;
  readonly transport: ClientTransport;
  readonly pilot: ScriptPilot;
  readonly view: MutableWorldView;
  readonly tokens: ReconnectTokenStore;
  /** Added to the rig clock for this client: its clock is not the host's. */
  readonly clockOffsetMs: number;
  /** When false the client's frames are skipped (a frozen tab). */
  running: boolean;
  /**
   * > 0 while `running` is false: the tab is hidden, not frozen. `update` is called this often
   * (the frame driver's background timer), nothing else.
   */
  backgroundMs: number;
}

export interface RigOptions {
  readonly netsim?: NetsimProfile;
  readonly seed?: number;
  readonly createMatchWorld?: MatchWorldFactory;
  readonly host?: Partial<HostSessionOptions>;
  readonly loopback?: LoopbackOptions;
  readonly roomCode?: string | null;
}

export class Rig {
  readonly hub: LoopbackHub;
  readonly netsim: Netsim | null;
  readonly hostTransport: LoopbackHostTransport;
  readonly host: HostSession;
  readonly clients: RigClient[] = [];
  readonly world: MatchWorldFactory;
  readonly hostPilot = new ScriptPilot(0);
  readonly hostFrame = createInputFrame();
  /** The host's own dragon gets scripted input when true (default). */
  hostFlies = true;
  /**
   * False: a main-thread host whose tab is hidden. Neither `update` nor `tick` runs; transport
   * callbacks still do (the hub keeps pumping).
   */
  hostRunning = true;
  now = 0;
  /** Called right after every host tick. */
  onHostTick: ((tick: number) => void) | null = null;
  /** Called after a client's frame (advance + world view). */
  onClientFrame: ((client: RigClient, index: number, dtMs: number) => void) | null = null;
  /** Called after every tick a client ran, with the predicted tick. */
  onClientTick: ((client: RigClient, index: number, tick: number) => void) | null = null;

  private nextHostTickAt = 0;
  private nextFrameAt = 0;
  private lastFrameAt = 0;
  private readonly random: () => number;

  constructor(options: RigOptions = {}) {
    this.random = createSeededRandom(options.seed ?? 4242);
    this.hub = createLoopbackHub({ recycleBuffers: true, ...options.loopback });
    this.netsim =
      options.netsim !== undefined
        ? createNetsim({
            profile: options.netsim,
            seed: options.seed ?? 4242,
            now: () => this.now,
          })
        : null;
    this.world = options.createMatchWorld ?? openSkyMatchWorldFactory;
    this.hostTransport = this.hub.createHost();
    const fixedCode = options.roomCode === undefined ? ROOM : options.roomCode;
    this.host = new HostSession({
      transport: this.hostTransport,
      hostName: 'Host',
      createMatchWorld: this.world,
      random: this.random,
      recycledBuffers: true,
      countdownTicks: 45,
      ...(fixedCode !== null ? { roomCode: fixedCode } : {}),
      ...options.host,
    });
  }

  /** Opens the room and waits for it. */
  open(): this {
    this.host.open();
    this.run(5);
    return this;
  }

  addClient(options: Partial<ClientSessionOptions> = {}, clockOffsetMs?: number): RigClient {
    const inner = this.hub.createClient();
    const transport = this.netsim !== null ? this.netsim.wrapClient(inner) : inner;
    const tokens = options.tokenStore ?? createMemoryTokenStore();
    const session = new ClientSession({
      transport,
      createMatchWorld: this.world,
      recycledBuffers: true,
      ...options,
      tokenStore: tokens,
    });
    const index = this.clients.length;
    const client: RigClient = {
      session,
      inner,
      transport,
      pilot: new ScriptPilot(index + 1),
      view: createWorldView(),
      tokens,
      clockOffsetMs: clockOffsetMs ?? 5000 + index * 1234.5,
      running: true,
      backgroundMs: 0,
    };
    this.clients.push(client);
    return client;
  }

  /** Adds a client, connects it and runs until the handshake is over (either way). */
  join(
    name: string,
    options: Partial<ClientSessionOptions> = {},
    code = this.host.roomCode,
  ): RigClient {
    const client = this.addClient(options);
    client.session.connect(code, name, this.now + client.clockOffsetMs);
    this.runUntil(() => client.session.status !== 'connecting', 20_000);
    return client;
  }

  /** Runs the clock forward by `ms` milliseconds. */
  run(ms: number): void {
    const end = this.now + ms;
    while (this.now < end) this.stepMs();
  }

  /** Runs until `done()` is true; throws after `maxMs`. */
  runUntil(done: () => boolean, maxMs = 10_000): void {
    const end = this.now + maxMs;
    while (!done()) {
      if (this.now >= end) throw new Error(`rig: condition not met within ${maxMs} ms`);
      this.stepMs();
    }
  }

  /** Runs until the host has done `ticks` more fixed steps. */
  runTicks(ticks: number): void {
    const target = this.host.hostTick + ticks;
    this.runUntil(() => this.host.hostTick >= target, ticks * TICK_MS + 1000);
  }

  pumpAll(): void {
    this.hub.pump();
    if (this.netsim !== null) this.netsim.pump(this.now);
  }

  dispose(): void {
    for (const client of this.clients) client.session.dispose();
    this.host.close();
    this.hub.flush();
  }

  private stepMs(): void {
    this.now += 1;
    const now = this.now;
    this.pumpAll();

    if (this.hostRunning) this.host.update(now);
    while (now >= this.nextHostTickAt) {
      this.nextHostTickAt += TICK_MS;
      if (!this.hostRunning) continue;
      if (this.hostFlies && this.host.inMatch) {
        const own = this.host.sim?.getDragon(this.host.localPlayerId) ?? null;
        this.hostPilot.sample(this.hostFrame, own);
        this.host.tick(this.hostFrame);
      } else {
        this.host.tick();
      }
      if (this.onHostTick !== null) this.onHostTick(this.host.hostTick);
    }

    for (let i = 0; i < this.clients.length; i++) {
      const client = this.clients[i];
      if (client === undefined || client.running || client.backgroundMs <= 0) continue;
      if (now % client.backgroundMs === 0) client.session.update(now + client.clockOffsetMs);
    }

    if (now >= this.nextFrameAt) {
      this.nextFrameAt += FRAME_MS;
      const dtMs = now - this.lastFrameAt;
      this.lastFrameAt = now;
      for (let i = 0; i < this.clients.length; i++) {
        const client = this.clients[i];
        if (client === undefined || !client.running) continue;
        const session = client.session;
        const before = session.predictor.tick;
        session.advance(now + client.clockOffsetMs, client.pilot);
        if (this.onClientTick !== null && session.inMatch) {
          for (let tick = before + 1; tick <= session.predictor.tick; tick++) {
            // Only the last tick's state is still in the predictor; callers that need every
            // tick run at a frame rate where one frame is at most one tick (60 fps is).
            if (tick === session.predictor.tick) this.onClientTick(client, i, tick);
          }
        }
        if (session.inMatch) session.writeWorldView(client.view);
        if (this.onClientFrame !== null) this.onClientFrame(client, i, dtMs);
      }
    }
  }
}

/** Host + `count` clients in the lobby, everyone connected. */
export function createRoom(count: number, options: RigOptions = {}): Rig {
  const rig = new Rig(options).open();
  for (let i = 0; i < count; i++) rig.join(`Rider ${i + 1}`);
  return rig;
}

/** Everyone readies up and the host starts; runs until the countdown is over. */
export function startMatch(rig: Rig): void {
  for (const client of rig.clients) {
    const me = client.session.lobby?.players.find((p) => p.id === client.session.localPlayerId);
    if (me !== undefined && me.side !== 'spectator') {
      client.session.sendIntent({ type: 'lobby.ready', ready: true });
    }
  }
  rig.run(400);
  if (!rig.host.applyIntent({ type: 'host.start' })) {
    throw new Error(`rig: start refused (${String(rig.host.startBlocker())})`);
  }
  rig.runUntil(() => rig.host.matchPhase === 'playing', 20_000);
}
