/**
 * The pilot of a fighting net-bot (`?bots=N`, T-3.10). A net-bot is a real `ClientSession`:
 * its input goes through the real codec and the host does its full per-client work for it,
 * which is the point of the load test. Only its EYES are a shortcut: the bots live in the
 * host's page (or worker), so the pilot reads the host's own sim state for its `BotBrain`
 * instead of rebuilding the world from its snapshots. The bot is a few ticks behind what it
 * sees, like anyone on a network.
 *
 * Without a host to look at (none attached yet, or no match running) it flies the plain seeded
 * weave of `BotPilot` from its own snapshot, as before.
 */

import { NO_PLAYER } from '../../shared';
import type { InputFrame, PlayerId } from '../../shared';
import type { SimState } from '../../sim';
import { BotBrain } from '../../sim/bots';
import type { BotBrainOptions, BotContext } from '../../sim/bots';
import type { SnapshotOwner } from '../protocol';
import type { ClientInputSampler } from '../session/client-session';
import type { HostSession } from '../session/host-session';
import { BotPilot, GREYBOX_BOT_ARENA } from './bot-pilot';
import type { BotArena } from './bot-pilot';

export class NetBotPilot implements ClientInputSampler {
  /** The host whose sim the bot looks at; null = fly blind (the weave). */
  host: HostSession | null = null;
  /** The bot's own player id, once its session has one. */
  playerId: PlayerId = NO_PLAYER;

  readonly brain: BotBrain;
  private readonly weave: BotPilot;
  private readonly context: BotContext;

  constructor(seed: number, arena: BotArena = GREYBOX_BOT_ARENA, options: BotBrainOptions = {}) {
    this.brain = new BotBrain(seed, options);
    this.weave = new BotPilot(seed, arena);
    this.context = {
      // Cast: replaced on every `sample` before anything reads it.
      state: null as unknown as SimState,
      collision: null,
      arena,
      playing: false,
    };
  }

  sample(frame: InputFrame, own: Readonly<SnapshotOwner> | null): void {
    const host = this.host;
    const sim = host !== null ? host.sim : null;
    const world = host !== null ? host.matchWorld : null;
    if (host === null || sim === null || world === null || this.playerId === NO_PLAYER) {
      this.weave.sample(frame, own);
      return;
    }
    const context = this.context;
    context.state = sim.current;
    context.collision = world.collisionWorld;
    context.arena = world;
    context.playing = host.matchPhase === 'playing';
    const brain = this.brain;
    brain.difficulty = host.lobby.settings.botDifficulty;
    brain.think(context, this.playerId, frame);
  }
}
