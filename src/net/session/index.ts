/** Barrel for the sessions: the two classes `src/game` drives, and what they need injected. */

export {
  CLIENT_CONNECT_TIMEOUT_MS,
  CLIENT_HANDSHAKE_TIMEOUT_MS,
  CLIENT_LINK_TIMEOUT_MS,
  CLIENT_MAX_TICKS_PER_ADVANCE,
  CLIENT_RECONNECT_DELAY_MS,
  CLIENT_RECONNECT_RETRY_MS,
  CLIENT_ROOM_GONE_ATTEMPTS,
  CLIENT_STALL_MS,
  CLIENT_SYNC_PING_INTERVAL_MS,
  ClientSession,
  createClientSession,
} from './client-session';
export type {
  ClientInputSampler,
  ClientMatchInfo,
  ClientSessionCounters,
  ClientSessionListener,
  ClientSessionOptions,
  ClientStatus,
} from './client-session';
export {
  DEFAULT_COUNTDOWN_TICKS,
  DEFAULT_RESPAWN_TICKS,
  HOST_CLOSE_GRACE_MS,
  HOST_HELLO_TIMEOUT_MS,
  HOST_LINK_TIMEOUT_MS,
  HOST_MAX_PINGS_PER_S,
  HOST_ROOM_CODE_ATTEMPTS,
  HOST_STALL_MS,
  HOST_STALE_LINK_MS,
  HostSession,
  createHostSession,
} from './host-session';
export type {
  HostMatchInfo,
  HostSessionCounters,
  HostSessionListener,
  HostSessionOptions,
  HostSessionState,
  HostTickTiming,
} from './host-session';
export {
  DEFAULT_MATCH_SEED,
  createGreyboxMatchWorld,
  createOpenSkyMatchWorld,
  greyboxMatchWorldFactory,
  openSkyMatchWorldFactory,
  spawnPointOf,
  spawnYawOf,
  yawOfOrientation,
} from './match-world';
export type { MatchWorld, MatchWorldFactory } from './match-world';
export { NET_RATE_INTERVAL_MS, NetRate, formatNetRate } from './net-rate';
export {
  PLAYER_PINGS_MAX_BYTES,
  PLAYER_PINGS_MAX_PLAYERS,
  addPlayerPing,
  applyPlayerPings,
  createPlayerPingsMessage,
  decodePlayerPings,
  encodePlayerPings,
} from './pings';
export type { PlayerPingsMessage } from './pings';
export {
  SCOREBOARD_MAX_BYTES,
  SCOREBOARD_MAX_ROWS,
  createScoreTable,
  decodeScoreboard,
  encodeScoreboard,
} from './scores';
export type { ScoreTable } from './scores';
export { steerToCourse } from './pilot';
export type { PilotCourse, PilotSubject } from './pilot';
export {
  PING_RTT_UNKNOWN,
  ViewCache,
  createMemoryTokenStore,
  createReconnectToken,
  rttFromWire,
  rttToWire,
} from './wire';
export type { ReconnectTokenStore } from './wire';
