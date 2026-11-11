/**
 * Lobby panel layout: turns the broadcast LobbyState into fixed slot grids (two terraces of
 * MAX_TEAM_SIZE perches, one watcher list) plus "what may the local player press". DOM-free. The
 * output object is created once and refilled in place, so recomputing every frame allocates
 * nothing.
 *
 * The permission flags only decide what the panel offers. The host re-checks every intent.
 */

import type { DragonClassId } from '../../shared/classes';
import { DEFAULT_DRAGON_CLASS } from '../../shared/classes';
import type { LobbySide, PlayerId, TeamId } from '../../shared/constants';
import {
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../shared/constants';
import type { LobbyPlayer, LobbyState } from '../../shared/lobby';
import { MAX_LOBBY_MEMBERS, MAX_SPECTATORS } from '../../shared/lobby';
import type { ModeId } from '../../shared/match';
import { MODES } from '../../shared/match';

/** A perch beyond the current team size. */
export const SLOT_CLOSED = 0;
/** A free perch. */
export const SLOT_OPEN = 1;
export const SLOT_PLAYER = 2;
export type SlotKind = typeof SLOT_CLOSED | typeof SLOT_OPEN | typeof SLOT_PLAYER;

export interface SlotView {
  kind: SlotKind;
  playerId: PlayerId;
  name: string;
  classId: DragonClassId;
  ready: boolean;
  isHost: boolean;
  isLocal: boolean;
  isBot: boolean;
  /** False while the seat is held for a reconnect. */
  connected: boolean;
  /** Whole ms, or -1 when unknown. */
  pingMs: number;
  // Host-only row actions (always false for everyone else).
  canMoveToEmber: boolean;
  canMoveToFrost: boolean;
  canMoveToSpectator: boolean;
  canKick: boolean;
}

export interface LobbyView {
  /** Indexed by TeamId, then by perch: always MAX_TEAM_SIZE entries each. */
  readonly teams: readonly [SlotView[], SlotView[]];
  /** MAX_LOBBY_MEMBERS entries; the first `spectatorCount` are players. */
  readonly spectators: SlotView[];
  spectatorCount: number;
  /** Riders per team, indexed by TeamId. */
  readonly counts: [number, number];
  memberCount: number;
  teamSize: number;
  /** The local player's side, or null when they are not in the list (yet). */
  localSide: LobbySide | null;
  localReady: boolean;
  localClassId: DragonClassId;
  localIsHost: boolean;
  /** Teams, classes and settings can change (lobby phase). */
  editable: boolean;
  /** Indexed by TeamId: the local player may switch to that team. */
  readonly canJoin: [boolean, boolean];
  canSpectate: boolean;
  canReady: boolean;
}

function createSlot(): SlotView {
  return {
    kind: SLOT_CLOSED,
    playerId: NO_PLAYER,
    name: '',
    classId: DEFAULT_DRAGON_CLASS,
    ready: false,
    isHost: false,
    isLocal: false,
    isBot: false,
    connected: true,
    pingMs: -1,
    canMoveToEmber: false,
    canMoveToFrost: false,
    canMoveToSpectator: false,
    canKick: false,
  };
}

function createSlots(count: number): SlotView[] {
  const slots: SlotView[] = [];
  for (let i = 0; i < count; i++) slots.push(createSlot());
  return slots;
}

export function createLobbyView(): LobbyView {
  return {
    teams: [createSlots(MAX_TEAM_SIZE), createSlots(MAX_TEAM_SIZE)],
    spectators: createSlots(MAX_LOBBY_MEMBERS),
    spectatorCount: 0,
    counts: [0, 0],
    memberCount: 0,
    teamSize: MAX_TEAM_SIZE,
    localSide: null,
    localReady: false,
    localClassId: DEFAULT_DRAGON_CLASS,
    localIsHost: false,
    editable: false,
    canJoin: [false, false],
    canSpectate: false,
    canReady: false,
  };
}

function clearSlot(slot: SlotView, kind: SlotKind): void {
  slot.kind = kind;
  slot.playerId = NO_PLAYER;
  slot.name = '';
  slot.classId = DEFAULT_DRAGON_CLASS;
  slot.ready = false;
  slot.isHost = false;
  slot.isLocal = false;
  slot.isBot = false;
  slot.connected = true;
  slot.pingMs = -1;
  slot.canMoveToEmber = false;
  slot.canMoveToFrost = false;
  slot.canMoveToSpectator = false;
  slot.canKick = false;
}

function pingOf(player: LobbyPlayer, pings: readonly number[] | undefined): number {
  if (!player.connected || player.isBot) return -1;
  if (player.isHost) return 0;
  const ping = pings?.[player.id];
  if (ping === undefined || !(ping >= 0)) return -1;
  return Math.min(999, Math.round(ping));
}

function fillSlot(
  slot: SlotView,
  player: LobbyPlayer,
  localPlayerId: PlayerId,
  pings: readonly number[] | undefined,
): void {
  slot.kind = SLOT_PLAYER;
  slot.playerId = player.id;
  slot.name = player.name;
  slot.classId = player.classId;
  slot.ready = player.ready;
  slot.isHost = player.isHost;
  slot.isLocal = player.id === localPlayerId;
  slot.isBot = player.isBot;
  slot.connected = player.connected;
  slot.pingMs = pingOf(player, pings);
}

/** Riders per side a mode allows, intersected with the game's 1..5. */
export function teamSizeRange(mode: ModeId): { readonly min: number; readonly max: number } {
  return TEAM_SIZE_RANGES[mode];
}

const TEAM_SIZE_RANGES: Readonly<Record<ModeId, { readonly min: number; readonly max: number }>> = {
  skirmish: rangeFor('skirmish'),
  duel: rangeFor('duel'),
  emberRelay: rangeFor('emberRelay'),
  skyCrown: rangeFor('skyCrown'),
};

function rangeFor(mode: ModeId): { readonly min: number; readonly max: number } {
  const info = MODES[mode];
  return Object.freeze({
    min: Math.max(MIN_TEAM_SIZE, info.minTeamSize),
    max: Math.min(MAX_TEAM_SIZE, info.maxTeamSize),
  });
}

/**
 * Refills `out` from the lobby state.
 *
 * Perch placement: a rider sits at their `perch` when it is a free index inside the terrace;
 * anyone whose perch is missing, taken or out of range takes the first free perch instead, so a
 * malformed state still shows every player exactly once. Perches at or beyond `teamSize` are
 * closed unless someone is sitting there.
 */
export function computeLobbyView(
  out: LobbyView,
  lobby: LobbyState,
  localPlayerId: PlayerId,
  localIsHost: boolean,
  pings?: readonly number[],
): LobbyView {
  const players = lobby.players;
  const settings = lobby.settings;
  const teamSize = Math.max(MIN_TEAM_SIZE, Math.min(MAX_TEAM_SIZE, settings.teamSize | 0));
  const editable = lobby.phase === 'lobby';
  const isHost = localIsHost || (localPlayerId !== NO_PLAYER && lobby.hostId === localPlayerId);

  for (let team = 0; team < 2; team++) {
    const slots = out.teams[team as TeamId];
    for (let i = 0; i < MAX_TEAM_SIZE; i++) {
      const slot = slots[i];
      if (slot !== undefined) clearSlot(slot, i < teamSize ? SLOT_OPEN : SLOT_CLOSED);
    }
  }
  out.counts[0] = 0;
  out.counts[1] = 0;
  out.spectatorCount = 0;
  out.localSide = null;
  out.localReady = false;
  out.localClassId = DEFAULT_DRAGON_CLASS;

  // Pass 1: riders whose perch is valid and free. Pass 2: everyone else, into the gaps.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (player === undefined) continue;
      const side = player.side;
      if (side !== TEAM_EMBER && side !== TEAM_FROST) {
        if (pass === 0 && out.spectatorCount < out.spectators.length) {
          const slot = out.spectators[out.spectatorCount];
          if (slot !== undefined) {
            fillSlot(slot, player, localPlayerId, pings);
            out.spectatorCount += 1;
          }
        }
        continue;
      }
      const slots = out.teams[side];
      const perch = player.perch;
      const preferred = perch >= 0 && perch < MAX_TEAM_SIZE ? slots[perch] : undefined;
      if (pass === 0) {
        if (preferred !== undefined && preferred.kind !== SLOT_PLAYER) {
          fillSlot(preferred, player, localPlayerId, pings);
          out.counts[side] += 1;
        }
        continue;
      }
      if (preferred !== undefined && preferred.playerId === player.id) continue;
      for (let s = 0; s < MAX_TEAM_SIZE; s++) {
        const slot = slots[s];
        if (slot !== undefined && slot.kind !== SLOT_PLAYER) {
          fillSlot(slot, player, localPlayerId, pings);
          out.counts[side] += 1;
          break;
        }
      }
    }
  }
  for (let i = out.spectatorCount; i < out.spectators.length; i++) {
    const slot = out.spectators[i];
    if (slot !== undefined && slot.kind !== SLOT_CLOSED) clearSlot(slot, SLOT_CLOSED);
  }

  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (player !== undefined && player.id === localPlayerId) {
      out.localSide = player.side;
      out.localReady = player.ready;
      out.localClassId = player.classId;
      break;
    }
  }

  const unlocked = editable && !settings.teamsLocked;
  const emberRoom = out.counts[TEAM_EMBER] < teamSize;
  const frostRoom = out.counts[TEAM_FROST] < teamSize;
  const watcherRoom = out.spectatorCount < MAX_SPECTATORS;
  const hostMoves = isHost && unlocked;

  for (let team = 0; team < 2; team++) {
    const slots = out.teams[team as TeamId];
    for (let i = 0; i < MAX_TEAM_SIZE; i++) {
      const slot = slots[i];
      if (slot === undefined || slot.kind !== SLOT_PLAYER) continue;
      slot.canMoveToEmber = hostMoves && team !== TEAM_EMBER && emberRoom;
      slot.canMoveToFrost = hostMoves && team !== TEAM_FROST && frostRoom;
      slot.canMoveToSpectator = hostMoves && watcherRoom;
      slot.canKick = isHost && !slot.isHost;
    }
  }
  for (let i = 0; i < out.spectatorCount; i++) {
    const slot = out.spectators[i];
    if (slot === undefined) continue;
    slot.canMoveToEmber = hostMoves && emberRoom;
    slot.canMoveToFrost = hostMoves && frostRoom;
    slot.canMoveToSpectator = false;
    slot.canKick = isHost && !slot.isHost;
  }

  const localSide = out.localSide;
  const present = localSide !== null;
  out.memberCount = players.length;
  out.teamSize = teamSize;
  out.localIsHost = isHost;
  out.editable = editable;
  out.canJoin[TEAM_EMBER] = present && unlocked && localSide !== TEAM_EMBER && emberRoom;
  out.canJoin[TEAM_FROST] = present && unlocked && localSide !== TEAM_FROST && frostRoom;
  out.canSpectate = present && unlocked && localSide !== 'spectator' && watcherRoom;
  out.canReady = present && editable && localSide !== 'spectator';
  return out;
}

/** Time-limit choices offered by the panel, in seconds (0 = none). */
export const TIME_LIMIT_CHOICES_S: readonly number[] = [0, 180, 300, 360, 480, 600, 900, 1200];

/** "8 min", "No limit", or "7:30" for a value that is not on the list. */
export function formatTimeLimit(seconds: number): string {
  if (!(seconds > 0)) return 'No limit';
  const whole = Math.round(seconds);
  if (whole % 60 === 0) return `${whole / 60} min`;
  const rest = whole % 60;
  return `${Math.floor(whole / 60)}:${rest < 10 ? '0' : ''}${rest}`;
}
