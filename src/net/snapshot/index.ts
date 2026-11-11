/** Barrel for snapshots: host-side building, client-side buffering and the client WorldView. */

export { CLIENT_BOLT_CAPACITY, CLIENT_BOLT_ID_BASE, ClientBolts } from './client-bolts';
export type { BoltLocalTarget, ClientBoltsOptions } from './client-bolts';
export { CLIENT_STORM_WALL_ZONE_ID, ClientRoster, buildClientWorldView } from './client-view';
export type { ClientStormWallSource, ClientWorldViewOptions } from './client-view';
export {
  HostSnapshotBuilder,
  SNAPSHOT_MAX_GAP_TICKS,
  createSnapshotClock,
  shouldSendSnapshot,
} from './host-snapshot';
export type { SnapshotClock } from './host-snapshot';
export {
  PLAYBACK_DELAY_FALL_MS_PER_S,
  PLAYBACK_DELAY_RISE_MS_PER_S,
  PLAYBACK_JITTER_MULTIPLIER,
  PLAYBACK_MAX_WARP,
  PLAYBACK_SNAP_MS,
  PlaybackClock,
} from './playback-clock';
export {
  REMOTE_BLEND_SNAP_M,
  SNAPSHOT_BUFFER_CAPACITY,
  SNAPSHOT_DISCONTINUITY_TICKS,
  SnapshotBuffer,
  TELEPORT_SLACK_M,
  createSnapshotSample,
  findSampledDragon,
} from './snapshot-buffer';
export type { SampledDragon, SnapshotSample } from './snapshot-buffer';
