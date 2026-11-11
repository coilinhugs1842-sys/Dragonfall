/**
 * "May the host press Start?" and the roster a start produces. Pure functions of the broadcast
 * LobbyState, so a client can run `canStart` too and grey out the button with the same reason.
 */

import { MAX_TEAM_SIZE, TEAM_EMBER, TEAM_FROST } from '../../shared/constants';
import type { PlayerId, TeamId } from '../../shared/constants';
import type { LobbyPlayer, LobbyState, MatchRoster, MatchRosterEntry } from '../../shared/lobby';
import { MODES } from '../../shared/match';

export type StartBlocker =
  /** A match is already starting or running. */
  | 'wrongPhase'
  /** Nobody is on a team. */
  | 'noRiders'
  /** One team has riders and the other has none (and it is not a solo sandbox). */
  | 'teamEmpty'
  /** A team has fewer riders than the mode needs. */
  | 'teamTooSmall'
  /** A team has more riders than the team size (cannot happen through the lobby operations). */
  | 'teamOverSize'
  /** The teams differ in size and the host has not allowed uneven teams. */
  | 'teamsUneven'
  /** A rider's slot is being held for a reconnect: wait, move them to spectators or kick. */
  | 'playerReconnecting'
  /** A rider other than the host has not readied up. */
  | 'notAllReady';

export type StartCheck =
  | { readonly ok: true; readonly solo: boolean }
  | { readonly ok: false; readonly reason: StartBlocker };

export interface StartOptions {
  /** Skips only the ready check; every structural rule still applies. */
  readonly force?: boolean;
}

// Shared results, so checking every frame for the Start button allocates nothing.
const OK_TEAMS: StartCheck = Object.freeze({ ok: true, solo: false });
const OK_SOLO: StartCheck = Object.freeze({ ok: true, solo: true });
const BLOCKED: Readonly<Record<StartBlocker, StartCheck>> = {
  wrongPhase: Object.freeze({ ok: false, reason: 'wrongPhase' }),
  noRiders: Object.freeze({ ok: false, reason: 'noRiders' }),
  teamEmpty: Object.freeze({ ok: false, reason: 'teamEmpty' }),
  teamTooSmall: Object.freeze({ ok: false, reason: 'teamTooSmall' }),
  teamOverSize: Object.freeze({ ok: false, reason: 'teamOverSize' }),
  teamsUneven: Object.freeze({ ok: false, reason: 'teamsUneven' }),
  playerReconnecting: Object.freeze({ ok: false, reason: 'playerReconnecting' }),
  notAllReady: Object.freeze({ ok: false, reason: 'notAllReady' }),
};

/**
 * Start rules:
 * - a lone player on a team with nobody else in the room may start a solo sandbox;
 * - otherwise both teams need at least one rider (and the mode's minimum), at most `teamSize`,
 *   and equal counts unless the host allowed uneven teams;
 * - no rider may be mid-reconnect;
 * - every rider except the host and bots must be ready, unless `force` is set. Pressing Start is
 *   the host's own ready signal. Spectators never block a start.
 */
export function canStart(state: LobbyState, options?: StartOptions): StartCheck {
  if (state.phase !== 'lobby') return BLOCKED.wrongPhase;
  const players = state.players;
  let ember = 0;
  let frost = 0;
  let reconnecting = false;
  let unready = false;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (player === undefined || player.side === 'spectator') continue;
    if (player.side === TEAM_EMBER) ember += 1;
    else frost += 1;
    if (!player.connected) reconnecting = true;
    else if (!player.ready && !player.isHost && !player.isBot) unready = true;
  }
  const riders = ember + frost;
  if (riders === 0) return BLOCKED.noRiders;
  if (riders === 1 && players.length === 1) return OK_SOLO;
  if (ember === 0 || frost === 0) return BLOCKED.teamEmpty;
  const { teamSize, unevenTeams, mode } = state.settings;
  const minTeamSize = MODES[mode].minTeamSize;
  if (ember < minTeamSize || frost < minTeamSize) return BLOCKED.teamTooSmall;
  if (ember > teamSize || frost > teamSize) return BLOCKED.teamOverSize;
  if (ember !== frost && !unevenTeams) return BLOCKED.teamsUneven;
  if (reconnecting) return BLOCKED.playerReconnecting;
  if (unready && options?.force !== true) return BLOCKED.notAllReady;
  return OK_TEAMS;
}

/**
 * Spawn-fan order: the first rider of a team takes the centre slot of the gate, the next ones
 * alternate outwards, so a 1v1 or 2v2 launches from the middle of the gate instead of one edge.
 */
const GATE_SLOT_ORDER: readonly number[] = buildGateSlotOrder(MAX_TEAM_SIZE);

function buildGateSlotOrder(count: number): number[] {
  const order: number[] = [];
  const centre = Math.floor((count - 1) / 2);
  for (let step = 0; order.length < count; step++) {
    if (step === 0) order.push(centre);
    else {
      if (centre - step >= 0) order.push(centre - step);
      if (centre + step < count) order.push(centre + step);
    }
  }
  return order;
}

function byPerch(a: LobbyPlayer, b: LobbyPlayer): number {
  return a.perch - b.perch || a.id - b.id;
}

/**
 * The match roster for the current teams: riders ordered Ember first, each team by perch, with a
 * gate slot each. It does not check `canStart`.
 */
export function buildMatchRoster(state: LobbyState): MatchRoster {
  const riders: MatchRosterEntry[] = [];
  const spectators: PlayerId[] = [];
  const teams: readonly TeamId[] = [TEAM_EMBER, TEAM_FROST];
  for (const team of teams) {
    const members = state.players.filter((player) => player.side === team).sort(byPerch);
    members.forEach((player, index) => {
      riders.push({
        playerId: player.id,
        name: player.name,
        team,
        classId: player.classId,
        gateSlot: GATE_SLOT_ORDER[index] ?? index,
        isBot: player.isBot,
      });
    });
  }
  for (const player of state.players) {
    if (player.side === 'spectator') spectators.push(player.id);
  }
  return {
    settings: { ...state.settings, allowedClasses: [...state.settings.allowedClasses] },
    riders,
    spectators,
    solo: riders.length === 1 && state.players.length === 1,
  };
}
