/**
 * The host's own bot riders (T-3.10): the bots that fill empty team slots (`host.addBot`,
 * `host.fillBots`). They have no connection, no codec and no snapshot stream: the host session
 * asks this for one `InputFrame` per bot per tick and hands it to the sim like a rider's input.
 * Up to nine of them cost the host a few microseconds each per tick.
 *
 * (`?bots=N` is the other kind: `NetBots`, real client sessions on a loopback transport, kept
 * for load testing because they exercise everything a real client costs the host. Both kinds
 * fly with the same `BotBrain`.)
 *
 * Use, from the host session:
 *   match start   `begin(world, seed, settings.botDifficulty)`, then `add(id)` per bot rider
 *   every tick    `sample(sim.current, id, tick, playing)` for each rider with `has(id)`
 *   rider removed `remove(id)`;   match over `end()`
 * `sample` allocates nothing; `add` may (once per bot, at match start).
 */

import { DEFAULT_BOT_DIFFICULTY, NO_PLAYER, createInputFrame } from '../../shared';
import type { BotDifficulty, InputFrame, MatchRoster, PlayerId } from '../../shared';
import type { SimCollisionWorld, SimState } from '../../sim';
import { BotBrain } from '../../sim/bots';
import type { BotArena, BotBrainOptions, BotContext } from '../../sim/bots';

/** What the bots need of the map; a session's `MatchWorld` fits. */
export interface BotWorld extends BotArena {
  readonly collisionWorld: SimCollisionWorld | null;
}

export const DEFAULT_HOST_BOT_SEED = 0x51a7e;

const OPEN_SKY: BotWorld = {
  collisionWorld: null,
  centerX: 0,
  centerZ: 0,
  radius: 1000,
  floorY: 0,
  ceilingY: 800,
};

interface HostBot {
  readonly brain: BotBrain;
  readonly frame: InputFrame;
  active: boolean;
}

/** A different stream per bot and per match from one match seed. */
export function botSeedOf(matchSeed: number, playerId: PlayerId): number {
  return ((matchSeed >>> 0) ^ Math.imul(playerId + 1, 0x9e3779b1)) >>> 0;
}

export class HostBots {
  private readonly brainOptions: BotBrainOptions;
  /** Indexed by PlayerId (a `u8`): a plain array lookup. Brains are kept between matches. */
  private readonly bots: (HostBot | undefined)[] = [];
  private readonly context: BotContext;
  private seed = DEFAULT_HOST_BOT_SEED;
  private level: BotDifficulty = DEFAULT_BOT_DIFFICULTY;
  private active = 0;

  constructor(brainOptions: BotBrainOptions = {}) {
    this.brainOptions = brainOptions;
    this.context = {
      // Cast: replaced on every `sample` before anything reads it.
      state: null as unknown as SimState,
      collision: null,
      arena: OPEN_SKY,
      playing: false,
    };
  }

  /** Bots flying right now. */
  get count(): number {
    return this.active;
  }

  get difficulty(): BotDifficulty {
    return this.level;
  }

  /** The lobby rule; takes effect on the next tick, also in the middle of a match. */
  set difficulty(level: BotDifficulty) {
    this.level = level;
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      if (bot !== undefined) bot.brain.difficulty = level;
    }
  }

  /** A new match: nobody flies yet. `seed` makes the same match play out the same way. */
  begin(world: BotWorld, seed: number, difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY): void {
    this.end();
    this.seed = seed >>> 0;
    this.level = difficulty;
    this.context.collision = world.collisionWorld;
    this.context.arena = world;
  }

  /** `begin` plus every bot rider of the roster that has no connection of its own. */
  beginRoster(
    roster: MatchRoster,
    world: BotWorld,
    seed: number,
    hasLink?: (playerId: PlayerId) => boolean,
  ): void {
    this.begin(world, seed, roster.settings.botDifficulty);
    for (const rider of roster.riders) {
      if (rider.isBot && (hasLink === undefined || !hasLink(rider.playerId))) {
        this.add(rider.playerId);
      }
    }
  }

  /** Starts flying the rider's dragon. False for an id that cannot be a player. */
  add(playerId: PlayerId): boolean {
    if (!Number.isInteger(playerId) || playerId < 0 || playerId >= NO_PLAYER) return false;
    let bot = this.bots[playerId];
    const seed = botSeedOf(this.seed, playerId);
    if (bot === undefined) {
      bot = {
        brain: new BotBrain(seed, this.brainOptions),
        frame: createInputFrame(),
        active: false,
      };
      this.bots[playerId] = bot;
    } else {
      bot.brain.reset(seed);
    }
    bot.brain.difficulty = this.level;
    if (!bot.active) {
      bot.active = true;
      this.active++;
    }
    return true;
  }

  remove(playerId: PlayerId): void {
    const bot = this.bots[playerId];
    if (bot !== undefined && bot.active) {
      bot.active = false;
      this.active--;
    }
  }

  has(playerId: PlayerId): boolean {
    return this.bots[playerId]?.active === true;
  }

  /** The brain of a flying bot (tests, a debug overlay). */
  brainOf(playerId: PlayerId): BotBrain | undefined {
    const bot = this.bots[playerId];
    return bot !== undefined && bot.active ? bot.brain : undefined;
  }

  /**
   * The bot's input for this tick, or undefined when `playerId` is not one of its bots. The
   * frame is the bot's own (valid until its next `sample`). `playing` false (countdown, between
   * rounds) gives a neutral frame.
   */
  sample(
    state: Readonly<SimState>,
    playerId: PlayerId,
    tick: number,
    playing: boolean,
  ): Readonly<InputFrame> | undefined {
    const bot = this.bots[playerId];
    if (bot === undefined || !bot.active) return undefined;
    const context = this.context;
    context.state = state;
    context.playing = playing;
    const frame = bot.brain.think(context, playerId, bot.frame);
    frame.tick = tick;
    return frame;
  }

  /** The match is over: nobody flies. */
  end(): void {
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      if (bot !== undefined) bot.active = false;
    }
    this.active = 0;
    this.context.collision = null;
    this.context.arena = OPEN_SKY;
  }
}

export function createHostBots(brainOptions?: BotBrainOptions): HostBots {
  return new HostBots(brainOptions);
}
