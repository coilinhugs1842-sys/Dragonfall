/**
 * Defensive decoding of a LOBBY_STATE a client received as JSON. The host is trusted, but a
 * client must never crash or render nonsense because of a bad or stale message, so the whole
 * structure is checked and rebuilt from known fields only.
 */

import type { DragonClassId } from '../../shared/classes';
import { DRAGON_CLASS_IDS, isDragonClassId } from '../../shared/classes';
import type { LobbySide } from '../../shared/constants';
import {
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../shared/constants';
import type { HostSettings, LobbyPhase, LobbyPlayer, LobbyState } from '../../shared/lobby';
import { HOST_SETTING_LIMITS, LOBBY_PHASES, MAX_LOBBY_MEMBERS } from '../../shared/lobby';
import type { MapId, ModeId } from '../../shared/match';
import { MAPS, MODES } from '../../shared/match';
import { isLobbySide } from './lobby';
import { sanitizePlayerName } from './names';

/**
 * Room codes are 5 characters; the code may be empty before the broker has registered the room,
 * and dev rooms may use other short labels. Its alphabet is the transport's business.
 */
const MAX_ROOM_CODE_LENGTH = 16;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isModeId(value: unknown): value is ModeId {
  return typeof value === 'string' && Object.hasOwn(MODES, value);
}

function isMapId(value: unknown): value is MapId {
  return typeof value === 'string' && Object.hasOwn(MAPS, value);
}

function isLobbyPhase(value: unknown): value is LobbyPhase {
  return typeof value === 'string' && (LOBBY_PHASES as readonly string[]).includes(value);
}

/** Checks and copies host settings. Null if any field is missing, mistyped or out of range. */
export function validateHostSettings(raw: unknown): HostSettings | null {
  if (!isRecord(raw)) return null;
  const { mode, map, teamSize, unevenTeams, scoreLimit, timeLimitS, friendlyFire, teamsLocked } =
    raw;
  const classesRaw = raw['allowedClasses'];
  const limits = HOST_SETTING_LIMITS;
  if (!isModeId(mode) || !isMapId(map)) return null;
  if (!isInt(teamSize, MIN_TEAM_SIZE, MAX_TEAM_SIZE)) return null;
  if (!isInt(scoreLimit, limits.scoreLimitMin, limits.scoreLimitMax)) return null;
  if (timeLimitS !== 0 && !isInt(timeLimitS, limits.timeLimitMinS, limits.timeLimitMaxS)) {
    return null;
  }
  if (
    typeof unevenTeams !== 'boolean' ||
    typeof friendlyFire !== 'boolean' ||
    typeof teamsLocked !== 'boolean'
  ) {
    return null;
  }
  if (!Array.isArray(classesRaw) || classesRaw.length === 0) return null;
  if (classesRaw.length > DRAGON_CLASS_IDS.length) return null;
  const allowedClasses: DragonClassId[] = [];
  for (const entry of classesRaw as readonly unknown[]) {
    if (!isDragonClassId(entry) || allowedClasses.includes(entry)) return null;
    allowedClasses.push(entry);
  }
  return {
    mode,
    map,
    teamSize,
    unevenTeams,
    scoreLimit,
    timeLimitS,
    friendlyFire,
    allowedClasses,
    teamsLocked,
  };
}

function validatePlayer(raw: unknown): LobbyPlayer | null {
  if (!isRecord(raw)) return null;
  const { id, name, side, perch, classId, ready, isHost, connected, isBot } = raw;
  const deadline = raw['reconnectDeadlineTick'];
  if (!isInt(id, 0, NO_PLAYER - 1)) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (!isLobbySide(side) || !isDragonClassId(classId)) return null;
  if (side === 'spectator' ? perch !== -1 : !isInt(perch, 0, MAX_TEAM_SIZE - 1)) return null;
  if (
    typeof ready !== 'boolean' ||
    typeof isHost !== 'boolean' ||
    typeof connected !== 'boolean' ||
    typeof isBot !== 'boolean'
  ) {
    return null;
  }
  if (!isInt(deadline, -1, Number.MAX_SAFE_INTEGER)) return null;
  return {
    id,
    // Cleaned again on the client, so even a misbehaving host cannot inject control characters.
    name: sanitizePlayerName(name),
    side,
    // Narrowed by the check above: -1 for spectators, a perch index otherwise.
    perch: perch as number,
    classId,
    ready,
    isHost,
    connected,
    reconnectDeadlineTick: connected ? -1 : deadline,
    isBot,
  };
}

/**
 * Returns a clean copy of a received lobby state, or null when it is not one. Besides field
 * types and ranges it checks the invariants the views rely on: unique player ids, exactly one
 * host and it is `hostId`, no team larger than `teamSize`, no perch used twice on a team.
 */
export function validateLobbyState(raw: unknown): LobbyState | null {
  if (!isRecord(raw)) return null;
  const { roomCode, phase, hostId } = raw;
  const playersRaw = raw['players'];
  if (typeof roomCode !== 'string' || roomCode.length > MAX_ROOM_CODE_LENGTH) return null;
  if (!isLobbyPhase(phase)) return null;
  if (!isInt(hostId, 0, NO_PLAYER - 1)) return null;
  const settings = validateHostSettings(raw['settings']);
  if (settings === null) return null;
  if (!Array.isArray(playersRaw) || playersRaw.length === 0) return null;
  if (playersRaw.length > MAX_LOBBY_MEMBERS) return null;

  const players: LobbyPlayer[] = [];
  const ids = new Set<number>();
  const perches = new Set<string>();
  const counts: Record<LobbySide, number> = { [TEAM_EMBER]: 0, [TEAM_FROST]: 0, spectator: 0 };
  let hosts = 0;
  for (const entry of playersRaw as readonly unknown[]) {
    const player = validatePlayer(entry);
    if (player === null || ids.has(player.id)) return null;
    ids.add(player.id);
    counts[player.side] += 1;
    if (player.side !== 'spectator') {
      const key = `${player.side}:${player.perch}`;
      if (perches.has(key)) return null;
      perches.add(key);
    }
    if (player.isHost) {
      if (player.id !== hostId) return null;
      hosts += 1;
    }
    players.push(player);
  }
  if (hosts !== 1) return null;
  if (counts[TEAM_EMBER] > settings.teamSize || counts[TEAM_FROST] > settings.teamSize) {
    return null;
  }
  return { roomCode, phase, hostId, players, settings };
}
