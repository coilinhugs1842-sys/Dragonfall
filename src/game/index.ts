/** Barrel for app orchestration: the state machine, the frame driver, the game controller and the WorldView. */

export { APP_STATE_IDS, APP_TRANSITIONS, App } from './app';
export type { AppChangeListener, AppStateHandler, AppStateId } from './app';
export { AUTOPILOT_CYCLE_TICKS, writeAutopilotFrame } from './autopilot';
export type { AutopilotCourse, AutopilotSubject } from './autopilot';
export { createDebugProbe } from './debug-probe';
export type { DebugProbe, MotionReport } from './debug-probe';
export { FrameDriver, createBrowserFrameHost } from './frame-driver';
export type { FrameDriverOptions, FrameHost, FrameRenderFn } from './frame-driver';
export { createGame } from './game';
export type {
  Game,
  GameFlags,
  GameOptions,
  GameReport,
  GameStorage,
  TransportShaper,
} from './game';
export { createMatchAssetsCache } from './match-assets';
export type { MatchAssets, MatchAssetsCache } from './match-assets';
export { STAGE_MAP_CHUNK_SIZE, createStage } from './stage';
export type { CameraDirector, Stage, StageOptions } from './stage';
export {
  RECONNECT_TOKEN_KEY_PREFIX,
  REJOIN_STORAGE_KEY,
  createStorageTokenStore,
  loadSettings,
  parseSettings,
  readRejoin,
  saveSettings,
  writeRejoin,
} from './storage';
export type { RejoinRecord } from './storage';
export { SETTINGS_STORAGE_KEY, readStoredQuality } from './stored-quality';
export {
  applySessionFacts,
  connectFailure,
  connectionStatusFor,
  createSessionFacts,
  createUiState,
  peerConfigFor,
  uiScreenFor,
} from './ui-model';
export type { MutableUiState, RunKind, SessionFacts } from './ui-model';
export { STORM_WALL_ZONE_ID, buildWorldView, nlerpQuat } from './world-view-builder';
export type { StormWallSource, WorldViewBuildOptions } from './world-view-builder';
