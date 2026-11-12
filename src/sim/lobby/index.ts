/** Barrel for the host's lobby logic. Pure: no transport, no DOM, no clock. */

export { applyLobbyIntent, parseLobbyBotIntent, parseLobbyIntent } from './intents';
export type { LobbyIntent, LobbyIntentContext } from './intents';
export {
  HOST_PLAYER_ID,
  MAX_KICKED_TOKENS,
  MAX_RECONNECT_TOKEN_LENGTH,
  RECONNECT_GRACE_TICKS,
  addBot,
  autoBalance,
  clearBots,
  countLobbySide,
  createLobby,
  disconnectPlayer,
  enterMatch,
  expireReconnects,
  fillBots,
  findLobbyPlayer,
  handleHello,
  isLobbySide,
  joinLobby,
  kickPlayer,
  launchMatch,
  leaveLobby,
  lockTeams,
  movePlayer,
  nextReconnectDeadline,
  pickClass,
  removeBot,
  returnToLobby,
  setAllowedClasses,
  setBotDifficulty,
  setFriendlyFire,
  setMap,
  setMode,
  setReady,
  setRoomCode,
  setScoreLimit,
  setTeamSize,
  setTimeLimit,
  setUnevenTeams,
  shuffleTeams,
  startMatch,
  switchSide,
} from './lobby';
export type {
  AdmitContext,
  AdmitResult,
  CreateLobbyOptions,
  HelloRequest,
  HostLobby,
  JoinRequest,
  LobbyEffect,
  LobbyRefusal,
  LobbyResult,
  LobbySeat,
  PlayerRemovalCause,
} from './lobby';
export { dedupePlayerName, sanitizePlayerName } from './names';
export {
  INTENT_BURST,
  INTENT_REFILL_PER_S,
  allowIntent,
  createIntentRateLimiter,
  resetIntentRateLimiter,
} from './rate-limit';
export type { IntentRateLimiter, IntentRateLimiterOptions } from './rate-limit';
export { buildMatchRoster, canStart } from './start';
export type { StartBlocker, StartCheck, StartOptions } from './start';
export { validateHostSettings, validateLobbyState } from './validate';
