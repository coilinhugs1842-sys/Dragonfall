/**
 * UiIntent → lobby operation. The host's own lobby panel and the intents that arrive from
 * clients on `ctrl` both go through `applyLobbyIntent`, so there is one set of rules. Network
 * intents are untrusted JSON: run them through `parseLobbyIntent` first.
 */

import { isDragonClassId } from '../../shared/classes';
import type { PlayerId } from '../../shared/constants';
import type { LobbySwitchSideIntent } from '../../shared/lobby';
import type { UiIntent } from '../../shared/ui';
import type { HostLobby, LobbyResult } from './lobby';
import {
  autoBalance,
  isLobbySide,
  kickPlayer,
  leaveLobby,
  lockTeams,
  movePlayer,
  pickClass,
  setAllowedClasses,
  setFriendlyFire,
  setMap,
  setMode,
  setReady,
  setScoreLimit,
  setTeamSize,
  setTimeLimit,
  setUnevenTeams,
  shuffleTeams,
  startMatch,
  switchSide,
} from './lobby';
import type { IntentRateLimiter } from './rate-limit';
import { allowIntent } from './rate-limit';

/** The intents a client may send to the host (and the host's own panel raises). */
export type LobbyIntent =
  | Exclude<
      Extract<UiIntent, { readonly type: `lobby.${string}` | `host.${string}` }>,
      { readonly type: 'lobby.focusPlayer' }
    >
  | LobbySwitchSideIntent;

export interface LobbyIntentContext {
  /** Current host lobby tick (drives the rate limiter). */
  readonly tick: number;
  /** Seed for `host.shuffle`; the caller picks a new one per shuffle. */
  readonly seed: number;
  /** When given, intents from anyone but the host spend a token and are refused when it runs dry. */
  readonly limiter?: IntentRateLimiter;
  /** Lets `host.start` skip the ready check (see `canStart`). */
  readonly forceStart?: boolean;
}

/**
 * Applies one intent on behalf of `actorId`. `host.*` intents from anyone but the host are
 * refused with `notHost` (the caller just drops refusals: clients are never told). Anything that
 * is not a lobby or host intent, including the local-only `lobby.focusPlayer`, is refused with
 * `unsupportedIntent`.
 */
export function applyLobbyIntent(
  lobby: HostLobby,
  actorId: PlayerId,
  intent: UiIntent | LobbySwitchSideIntent,
  ctx: LobbyIntentContext,
): LobbyResult {
  if (
    ctx.limiter !== undefined &&
    actorId !== lobby.state.hostId &&
    !allowIntent(ctx.limiter, actorId, ctx.tick)
  ) {
    return { ok: false, lobby, reason: 'rateLimited' };
  }
  switch (intent.type) {
    case 'lobby.ready':
      return setReady(lobby, actorId, intent.ready);
    case 'lobby.pickClass':
      return pickClass(lobby, actorId, intent.classId);
    case 'lobby.switchSide':
      return switchSide(lobby, actorId, intent.side);
    case 'lobby.leave':
      return leaveLobby(lobby, actorId);
    case 'host.setMode':
      return setMode(lobby, actorId, intent.mode);
    case 'host.setMap':
      return setMap(lobby, actorId, intent.map);
    case 'host.setTeamSize':
      return setTeamSize(lobby, actorId, intent.teamSize);
    case 'host.setUnevenTeams':
      return setUnevenTeams(lobby, actorId, intent.enabled);
    case 'host.setScoreLimit':
      return setScoreLimit(lobby, actorId, intent.scoreLimit);
    case 'host.setTimeLimit':
      return setTimeLimit(lobby, actorId, intent.timeLimitS);
    case 'host.setFriendlyFire':
      return setFriendlyFire(lobby, actorId, intent.enabled);
    case 'host.setAllowedClasses':
      return setAllowedClasses(lobby, actorId, intent.classes);
    case 'host.movePlayer':
      return movePlayer(lobby, actorId, intent.playerId, intent.side);
    case 'host.autoBalance':
      return autoBalance(lobby, actorId);
    case 'host.shuffle':
      return shuffleTeams(lobby, actorId, ctx.seed);
    case 'host.lockTeams':
      return lockTeams(lobby, actorId, intent.locked);
    case 'host.kick':
      return kickPlayer(lobby, actorId, intent.playerId);
    case 'host.start':
      return startMatch(lobby, actorId, { force: ctx.forceStart === true });
    default:
      return { ok: false, lobby, reason: 'unsupportedIntent' };
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlayerIdValue(value: unknown): value is PlayerId {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * Decodes an intent a client sent as JSON. Returns a fresh object with only the known fields, or
 * null for anything that is not a well-formed lobby/host intent. Field types are checked here;
 * ranges and permissions are the operations' job (they clamp or refuse).
 */
export function parseLobbyIntent(raw: unknown): LobbyIntent | null {
  if (!isRecord(raw)) return null;
  const type = raw['type'];
  switch (type) {
    case 'lobby.ready':
      return typeof raw['ready'] === 'boolean' ? { type, ready: raw['ready'] } : null;
    case 'lobby.pickClass':
      return isDragonClassId(raw['classId']) ? { type, classId: raw['classId'] } : null;
    case 'lobby.switchSide':
      return isLobbySide(raw['side']) ? { type, side: raw['side'] } : null;
    case 'lobby.leave':
    case 'host.autoBalance':
    case 'host.shuffle':
    case 'host.start':
      return { type };
    case 'host.setMode': {
      const mode = raw['mode'];
      // Cast: the id is only known to be a string here; `setMode` rejects unknown modes.
      return typeof mode === 'string' ? ({ type, mode } as LobbyIntent) : null;
    }
    case 'host.setMap': {
      const map = raw['map'];
      // Cast: as above, `setMap` rejects unknown maps.
      return typeof map === 'string' ? ({ type, map } as LobbyIntent) : null;
    }
    case 'host.setTeamSize':
      return isFiniteNumber(raw['teamSize']) ? { type, teamSize: raw['teamSize'] } : null;
    case 'host.setScoreLimit':
      return isFiniteNumber(raw['scoreLimit']) ? { type, scoreLimit: raw['scoreLimit'] } : null;
    case 'host.setTimeLimit':
      return isFiniteNumber(raw['timeLimitS']) ? { type, timeLimitS: raw['timeLimitS'] } : null;
    case 'host.setUnevenTeams':
    case 'host.setFriendlyFire':
      return typeof raw['enabled'] === 'boolean' ? { type, enabled: raw['enabled'] } : null;
    case 'host.lockTeams':
      return typeof raw['locked'] === 'boolean' ? { type, locked: raw['locked'] } : null;
    case 'host.setAllowedClasses': {
      const classes = raw['classes'];
      if (!Array.isArray(classes) || classes.length > 32) return null;
      return { type, classes: classes.filter(isDragonClassId) };
    }
    case 'host.movePlayer': {
      const playerId = raw['playerId'];
      const side = raw['side'];
      return isPlayerIdValue(playerId) && isLobbySide(side) ? { type, playerId, side } : null;
    }
    case 'host.kick': {
      const playerId = raw['playerId'];
      return isPlayerIdValue(playerId) ? { type, playerId } : null;
    }
    default:
      return null;
  }
}
