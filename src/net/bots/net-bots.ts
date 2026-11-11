/**
 * Net-bots (`?bots=N`, docs/NETWORKING.md "Testing without 10 laptops"): N fake clients living
 * in the host's page. Each one is a real `ClientSession` on its own transport (the loopback,
 * optionally wrapped by `dev/netsim`), so everything a bot does goes through the real codec and
 * the host does its full per-client work: handshake, input buffer, per-recipient snapshot. That
 * is what makes it a load test.
 *
 * A bot joins by room code, picks a class, readies up and, once the match runs, flies and
 * fights with a seeded `NetBotPilot`: the `BotBrain` of the bot riders, looking at the sim of
 * the host it was shown with `markOnHost` (the bots live next to the host). Until then, or with
 * `fight: false`, it flies the plain weave of `BotPilot`. By default it does not predict (no
 * flight sim, no map collision, no view smoothing), so the bots themselves cost the host page
 * almost nothing; pass `predict: true` to make them full clients.
 *
 * Driven by the caller like the sessions: `update(nowMs)` once per frame, after pumping the
 * transport the bots are on. No timers.
 */

import { NO_PLAYER, createSeededRandom } from '../../shared';
import type { DragonClassId, LobbyPlayer, LobbyState, PlayerId } from '../../shared';
import { ClientSession } from '../session/client-session';
import type { HostSession } from '../session/host-session';
import type { MatchWorldFactory } from '../session/match-world';
import type { ClientTransport } from '../transport/transport';
import type { BotBrainOptions } from '../../sim/bots';
import { BotPilot, GREYBOX_BOT_ARENA } from './bot-pilot';
import type { BotArena } from './bot-pilot';
import { NetBotPilot } from './fight-pilot';

/** A bot sends at most one lobby intent per this many ms (well inside the host's rate limit). */
export const BOT_INTENT_INTERVAL_MS = 400;
export const DEFAULT_BOT_SEED = 0xb075;

export interface NetBotsOptions {
  readonly count: number;
  /**
   * One transport per bot, e.g. `() => hub.createClient()` or
   * `() => netsim.wrapClient(hub.createClient())`.
   */
  readonly createTransport: (index: number) => ClientTransport;
  /** Seeds the pilots and the class picks. The same seed gives the same bots. */
  readonly seed?: number;
  /** Run client prediction in every bot (default false). */
  readonly predict?: boolean;
  /** Needed with `predict`: the same factory the host uses. */
  readonly createMatchWorld?: MatchWorldFactory;
  /** The bots' transports recycle delivered buffers (default true: the loopback hub should). */
  readonly recycledBuffers?: boolean;
  /** Default: the greybox bowl. */
  readonly arena?: BotArena;
  /** Bots are named `<prefix> 1`, `<prefix> 2`, ... Default `Bot`. */
  readonly namePrefix?: string;
  /** Ready up in the lobby (default true). */
  readonly autoReady?: boolean;
  /**
   * Fight (default true): chase, shoot and use abilities once `markOnHost` has shown the bots
   * their host. False = the weave only, the Phase 2 behaviour (a quiet-sky load baseline).
   */
  readonly fight?: boolean;
  /** Tables for the bots' brains (tests). Default: the live ones. */
  readonly brain?: BotBrainOptions;
}

interface Bot {
  readonly client: ClientSession;
  readonly pilot: BotPilot | NetBotPilot;
  readonly random: () => number;
  wantClass: DragonClassId | null;
  lastIntentMs: number;
  marked: boolean;
}

function findPlayer(lobby: LobbyState, id: PlayerId): LobbyPlayer | undefined {
  const players = lobby.players;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (player !== undefined && player.id === id) return player;
  }
  return undefined;
}

export class NetBots {
  /** The bots' sessions, in creation order (for stats and tests). */
  readonly clients: readonly ClientSession[];
  private readonly bots: Bot[] = [];
  private readonly autoReady: boolean;
  private readonly namePrefix: string;

  constructor(options: NetBotsOptions) {
    const count = Math.max(0, Math.floor(options.count));
    const seed = options.seed ?? DEFAULT_BOT_SEED;
    const arena = options.arena ?? GREYBOX_BOT_ARENA;
    this.autoReady = options.autoReady !== false;
    this.namePrefix = options.namePrefix ?? 'Bot';
    const clients: ClientSession[] = [];
    for (let i = 0; i < count; i++) {
      const botSeed = (seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
      const client = new ClientSession({
        transport: options.createTransport(i),
        predict: options.predict === true,
        recycledBuffers: options.recycledBuffers !== false,
        ...(options.createMatchWorld !== undefined
          ? { createMatchWorld: options.createMatchWorld }
          : {}),
      });
      clients.push(client);
      this.bots.push({
        client,
        pilot:
          options.fight === false
            ? new BotPilot(botSeed, arena)
            : new NetBotPilot(botSeed, arena, options.brain),
        random: createSeededRandom(botSeed ^ 0x5bd1e995),
        wantClass: null,
        lastIntentMs: -Infinity,
        marked: false,
      });
    }
    this.clients = clients;
  }

  get count(): number {
    return this.bots.length;
  }

  /** Bots that have completed the handshake. */
  get connectedCount(): number {
    let connected = 0;
    for (let i = 0; i < this.bots.length; i++) {
      if (this.bots[i]?.client.status === 'connected') connected++;
    }
    return connected;
  }

  /** Every bot joins the room. Call once the host session is `open`. */
  connect(roomCode: string, nowMs: number): void {
    for (let i = 0; i < this.bots.length; i++) {
      this.bots[i]?.client.connect(roomCode, `${this.namePrefix} ${i + 1}`, nowMs);
    }
  }

  /**
   * Flags the bots' seats on the host as bots (badge in the lobby, no ready check, no seat held
   * after a drop) and shows the bots their host, whose sim state they fight by. Cheap; call it
   * every frame or whenever `connectedCount` changes.
   */
  markOnHost(host: HostSession): void {
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (bot === undefined) continue;
      const pilot = bot.pilot;
      if (pilot instanceof NetBotPilot) {
        pilot.host = host;
        pilot.playerId = bot.client.status === 'connected' ? bot.client.localPlayerId : NO_PLAYER;
      }
      if (bot.marked) continue;
      const id = bot.client.localPlayerId;
      if (bot.client.status !== 'connected' || id === NO_PLAYER) continue;
      host.setPlayerIsBot(id, true);
      bot.marked = true;
    }
  }

  /** One frame for every bot: session housekeeping, due ticks with pilot input, lobby chores. */
  update(nowMs: number): void {
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (bot === undefined) continue;
      bot.client.advance(nowMs, bot.pilot);
      if (bot.client.status !== 'connected') {
        bot.marked = false;
        continue;
      }
      this.lobbyChores(bot, nowMs);
    }
  }

  dispose(): void {
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (bot === undefined) continue;
      if (bot.pilot instanceof NetBotPilot) bot.pilot.host = null;
      bot.client.dispose();
    }
  }

  private lobbyChores(bot: Bot, nowMs: number): void {
    const client = bot.client;
    const lobby = client.lobby;
    if (lobby === null || lobby.phase !== 'lobby') return;
    if (nowMs - bot.lastIntentMs < BOT_INTENT_INTERVAL_MS) return;
    const me = findPlayer(lobby, client.localPlayerId);
    if (me === undefined) return;

    const allowed = lobby.settings.allowedClasses;
    if (bot.wantClass === null || !allowed.includes(bot.wantClass)) {
      bot.wantClass = allowed[Math.floor(bot.random() * allowed.length)] ?? null;
    }
    if (bot.wantClass !== null && me.classId !== bot.wantClass) {
      bot.lastIntentMs = nowMs;
      client.sendIntent({ type: 'lobby.pickClass', classId: bot.wantClass });
      return;
    }
    if (this.autoReady && me.side !== 'spectator' && !me.ready) {
      bot.lastIntentMs = nowMs;
      client.sendIntent({ type: 'lobby.ready', ready: true });
    }
  }
}

export function createNetBots(options: NetBotsOptions): NetBots {
  return new NetBots(options);
}
