/**
 * dev/netsim barrel. Light (no lil-gui, no stats-gl at runtime), but still dev-only: load it
 * with a dynamic import behind `?netsim` / `?debug` so normal play does not download it.
 * `./profile` and `./stats` are import-free and safe to import statically on their own.
 */

export { addNetsimFolder, createNetsimGuiModel } from './gui';
export type { NetsimGuiModel, NetsimGuiParent } from './gui';
export {
  DEFAULT_NETSIM_CAPACITY,
  DEFAULT_NETSIM_SEED,
  DEFAULT_REORDER_DELAY_MS,
  JITTER_SHAPES,
  Netsim,
  NetsimClientTransport,
  NetsimHostTransport,
  createManualClock,
  createNetsim,
  startNetsimTimer,
} from './netsim';
export type {
  JitterShape,
  ManualClock,
  NetsimCounters,
  NetsimDirection,
  NetsimOptions,
  NetsimSettings,
} from './netsim';
export {
  DEFAULT_NETSIM_PROFILE,
  NETSIM_LIMITS,
  NETSIM_PROFILES,
  NETSIM_PROFILE_NAMES,
  createNetsimProfile,
  describeNetsimProfile,
  isNetsimProfileName,
  parseNetsimProfile,
} from './profile';
export type { NetsimProfile, NetsimProfileName } from './profile';
export {
  DEFAULT_NET_STATS_WINDOW_MS,
  createNetStats,
  formatNetStats,
  netStatsFastLoss,
  netStatsReceivedKBps,
  netStatsSentKBps,
  recordDropped,
  recordReceived,
  recordSent,
  resetNetStats,
  updateNetStats,
} from './stats';
export type { NetChannelStats, NetStats, NetStatsChannel } from './stats';
