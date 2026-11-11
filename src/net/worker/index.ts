/**
 * Barrel for the host-in-a-worker layer: the `HostHandle` the game layer hosts through, its two
 * implementations, and the page <-> worker protocol. All of it is DOM-free (the worker entry
 * that touches `self` lives in `src/game/worker/`).
 */

export {
  AUX_CTRL,
  AUX_FAST,
  BATCH_BUFFER_BYTES,
  BATCH_HEADER_BYTES,
  BatchReader,
  BatchWriter,
  BufferPool,
  ExactBuffers,
  RECORD_HEADER_BYTES,
  RECORD_MAX_PAYLOAD,
  REC_CLOSE,
  REC_INPUT,
  REC_KEEPALIVE,
  REC_PACKET,
  REC_PEER_GONE,
  REC_PEER_OPEN,
  REC_STATE,
  REC_STATS,
  REC_TEXT,
} from './batch';
export type { BatchMessage } from './batch';
export { createHost } from './create-host';
export type { CreateHostOptions } from './create-host';
export { AUTOSTART_PATIENCE_MS, HOST_COST_SMOOTHING, HostCore, createHostCore } from './host-core';
export type { HostCoreOptions, LocalInputSource, LocalInputSubject } from './host-core';
export { DirectHost, MeteredHostTransport, WorkMeter, createHostMetrics } from './host-handle';
export type { HostHandle, HostMetrics } from './host-handle';
export {
  HostWorkerServer,
  WORKER_MAX_TICKS_PER_PULSE,
  WORKER_MAX_TIMER_MS,
  WORKER_TIMER_EARLY_MS,
  createHostWorkerServer,
} from './host-worker-server';
export type { HostWorkerEnv } from './host-worker-server';
export {
  INPUT_HOLD_TICKS,
  INPUT_RECORD_BYTES,
  PAGE_KEEPALIVE_MS,
  PAGE_STALL_MS,
  STATS_FIXED_BYTES,
  WORKER_STATS_INTERVAL_MS,
} from './messages';
export type {
  FromWorkerMessage,
  HostMeta,
  HostWorkerConfig,
  ToWorkerMessage,
  WorkerPilotCourse,
} from './messages';
export { PortHostTransport } from './port-transport';
export type { PortTransportCommands } from './port-transport';
export {
  createHostWorkerStats,
  decodeHostStats,
  encodeHostStats,
  hostStatsBytes,
} from './stats-record';
export type { HostWorkerStats } from './stats-record';
export {
  STATE_INFO_BYTES,
  STATE_RECORD_MAX_BYTES,
  createHostTickInfo,
  createHostViewDragon,
  createHostViewState,
  decodeHostState,
  encodeHostState,
  findViewDragon,
  hostStateBytes,
} from './view-state';
export type { HostTickInfo, HostViewDragon, HostViewState } from './view-state';
export {
  VIEW_EXTRAPOLATE_TICKS,
  WORKER_SILENT_MS,
  WORKER_START_TIMEOUT_MS,
  WorkerHost,
} from './worker-host';
export type { WorkerHostOptions, WorkerLike } from './worker-host';
