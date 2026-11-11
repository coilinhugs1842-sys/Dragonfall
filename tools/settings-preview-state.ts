import { NO_PLAYER } from '../src/shared';
import type { ConnectionState } from '../src/shared';

/** A title-screen connection for the settings preview. */
export const CONNECTION_OFFLINE_PREVIEW: ConnectionState = {
  status: 'offline',
  isHost: false,
  localPlayerId: NO_PLAYER,
  pingMs: 0,
  error: null,
};
