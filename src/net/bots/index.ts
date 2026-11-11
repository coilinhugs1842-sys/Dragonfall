/**
 * Barrel for the bots of the net layer: the in-page fake clients for load testing (`?bots=N`)
 * and the driver of the host's own bot riders (slot fill).
 */

export { BotPilot, GREYBOX_BOT_ARENA } from './bot-pilot';
export type { BotArena } from './bot-pilot';
export { NetBotPilot } from './fight-pilot';
export { DEFAULT_HOST_BOT_SEED, HostBots, botSeedOf, createHostBots } from './host-bots';
export type { BotWorld } from './host-bots';
export { BOT_INTENT_INTERVAL_MS, DEFAULT_BOT_SEED, NetBots, createNetBots } from './net-bots';
export type { NetBotsOptions } from './net-bots';
