/** Barrel for the net-bots: in-page fake clients for load testing (`?bots=N`). */

export { BotPilot, GREYBOX_BOT_ARENA } from './bot-pilot';
export type { BotArena } from './bot-pilot';
export { BOT_INTENT_INTERVAL_MS, DEFAULT_BOT_SEED, NetBots, createNetBots } from './net-bots';
export type { NetBotsOptions } from './net-bots';
