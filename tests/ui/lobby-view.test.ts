import { describe, expect, it } from 'vitest';
import type { LobbySide, PlayerId } from '../../src/shared/constants';
import { MAX_TEAM_SIZE, NO_PLAYER, TEAM_EMBER, TEAM_FROST } from '../../src/shared/constants';
import type { HostSettings, LobbyPlayer, LobbyState } from '../../src/shared/lobby';
import { DEFAULT_HOST_SETTINGS, MAX_LOBBY_MEMBERS, MAX_SPECTATORS } from '../../src/shared/lobby';
import type { LobbyView, SlotView } from '../../src/ui/view-model/lobby-view';
import {
  SLOT_CLOSED,
  SLOT_OPEN,
  SLOT_PLAYER,
  TIME_LIMIT_CHOICES_S,
  computeLobbyView,
  createLobbyView,
  formatTimeLimit,
  teamSizeRange,
} from '../../src/ui/view-model/lobby-view';

function player(id: PlayerId, side: LobbySide, perch: number, extra?: Partial<LobbyPlayer>) {
  const base: LobbyPlayer = {
    id,
    name: `Rider ${id}`,
    side,
    perch,
    classId: 'talon',
    ready: false,
    isHost: id === 0,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: false,
  };
  return { ...base, ...extra };
}

function lobbyOf(players: LobbyPlayer[], settings?: Partial<HostSettings>): LobbyState {
  return {
    roomCode: 'KH7P2',
    phase: 'lobby',
    hostId: 0,
    players,
    settings: { ...DEFAULT_HOST_SETTINGS, ...settings },
  };
}

function view(lobby: LobbyState, localId: PlayerId, pings?: readonly number[]): LobbyView {
  return computeLobbyView(createLobbyView(), lobby, localId, localId === lobby.hostId, pings);
}

function ids(slots: readonly SlotView[]): number[] {
  return slots.map((slot) => (slot.kind === SLOT_PLAYER ? slot.playerId : -slot.kind - 1));
}

/** Every player id that appears anywhere in the view. */
function shownIds(v: LobbyView): number[] {
  const out: number[] = [];
  for (const slots of v.teams) {
    for (const slot of slots) if (slot.kind === SLOT_PLAYER) out.push(slot.playerId);
  }
  for (let i = 0; i < v.spectatorCount; i++) out.push(v.spectators[i]?.playerId ?? -1);
  return out.sort((a, b) => a - b);
}

const OPEN = -SLOT_OPEN - 1;
const CLOSED = -SLOT_CLOSED - 1;

describe('lobby slot layout', () => {
  it('always has MAX_TEAM_SIZE perches per team and MAX_LOBBY_MEMBERS watcher rows', () => {
    const v = createLobbyView();
    expect(v.teams[TEAM_EMBER]).toHaveLength(MAX_TEAM_SIZE);
    expect(v.teams[TEAM_FROST]).toHaveLength(MAX_TEAM_SIZE);
    expect(v.spectators).toHaveLength(MAX_LOBBY_MEMBERS);
  });

  it('seats riders at their perch', () => {
    const v = view(
      lobbyOf([
        player(0, TEAM_EMBER, 0),
        player(1, TEAM_FROST, 0),
        player(2, TEAM_EMBER, 2),
        player(3, TEAM_FROST, 4),
      ]),
      0,
    );
    expect(ids(v.teams[TEAM_EMBER])).toEqual([0, OPEN, 2, OPEN, OPEN]);
    expect(ids(v.teams[TEAM_FROST])).toEqual([1, OPEN, OPEN, OPEN, 3]);
    expect(v.counts).toEqual([2, 2]);
    expect(v.spectatorCount).toBe(0);
  });

  it('closes perches beyond the team size', () => {
    const v = view(lobbyOf([player(0, TEAM_EMBER, 0)], { teamSize: 2 }), 0);
    expect(ids(v.teams[TEAM_EMBER])).toEqual([0, OPEN, CLOSED, CLOSED, CLOSED]);
    expect(ids(v.teams[TEAM_FROST])).toEqual([OPEN, OPEN, CLOSED, CLOSED, CLOSED]);
    expect(v.teamSize).toBe(2);
  });

  it('clamps a nonsense team size into 1..5', () => {
    expect(view(lobbyOf([player(0, TEAM_EMBER, 0)], { teamSize: 0 }), 0).teamSize).toBe(1);
    expect(view(lobbyOf([player(0, TEAM_EMBER, 0)], { teamSize: 99 }), 0).teamSize).toBe(5);
  });

  it('lists watchers in join order', () => {
    const v = view(
      lobbyOf([
        player(0, TEAM_EMBER, 0),
        player(4, 'spectator', -1),
        player(2, 'spectator', -1),
        player(1, TEAM_FROST, 0),
      ]),
      0,
    );
    expect(v.spectatorCount).toBe(2);
    expect(v.spectators[0]?.playerId).toBe(4);
    expect(v.spectators[1]?.playerId).toBe(2);
    expect(v.spectators[2]?.kind).toBe(SLOT_CLOSED);
  });

  it('shows every player exactly once even when perches collide or are out of range', () => {
    const lobby = lobbyOf([
      player(0, TEAM_EMBER, 0),
      player(1, TEAM_EMBER, 0), // same perch as the host
      player(2, TEAM_EMBER, 9), // out of range
      player(3, TEAM_EMBER, -1), // missing
      player(4, TEAM_FROST, 3),
      player(5, 'spectator', 2), // perch is ignored for watchers
    ]);
    const v = view(lobby, 0);
    expect(shownIds(v)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(v.teams[TEAM_EMBER][0]?.playerId).toBe(0);
    expect(v.counts).toEqual([4, 1]);
    expect(v.teams[TEAM_FROST][3]?.playerId).toBe(4);
  });

  it('keeps a rider visible on a perch beyond the team size', () => {
    const v = view(
      lobbyOf([player(0, TEAM_EMBER, 0), player(1, TEAM_EMBER, 4)], { teamSize: 2 }),
      0,
    );
    expect(ids(v.teams[TEAM_EMBER])).toEqual([0, OPEN, CLOSED, CLOSED, 1]);
  });

  it('clears everything a previous state wrote', () => {
    const out = createLobbyView();
    const full: LobbyPlayer[] = [];
    for (let i = 0; i < 5; i++) full.push(player(i, TEAM_EMBER, i, { ready: true }));
    for (let i = 5; i < 10; i++) full.push(player(i, TEAM_FROST, i - 5));
    for (let i = 10; i < 16; i++) full.push(player(i, 'spectator', -1));
    computeLobbyView(out, lobbyOf(full), 3, false, [0, 10, 20, 30]);
    expect(shownIds(out)).toHaveLength(16);

    computeLobbyView(out, lobbyOf([player(0, TEAM_EMBER, 0)]), 0, true);
    expect(shownIds(out)).toEqual([0]);
    expect(out.spectatorCount).toBe(0);
    expect(out.counts).toEqual([1, 0]);
    for (const slot of out.spectators) expect(slot.kind).toBe(SLOT_CLOSED);
    const empty = out.teams[TEAM_EMBER][3];
    expect(empty).toMatchObject({
      kind: SLOT_OPEN,
      playerId: NO_PLAYER,
      name: '',
      ready: false,
      isLocal: false,
      canKick: false,
      canMoveToFrost: false,
    });
  });

  it('copies the row fields', () => {
    const v = view(
      lobbyOf([
        player(0, TEAM_EMBER, 0),
        player(1, TEAM_FROST, 0, { name: 'Vex', classId: 'wraith', ready: true }),
        player(2, TEAM_FROST, 1, { connected: false, reconnectDeadlineTick: 900 }),
        player(3, TEAM_EMBER, 1, { isBot: true }),
      ]),
      1,
      [0, 41.6, 77, 5],
    );
    expect(v.teams[TEAM_FROST][0]).toMatchObject({
      name: 'Vex',
      classId: 'wraith',
      ready: true,
      isLocal: true,
      isHost: false,
      connected: true,
      pingMs: 42,
    });
    expect(v.teams[TEAM_EMBER][0]).toMatchObject({ isHost: true, isLocal: false, pingMs: 0 });
    // No ping for a held seat or a bot, whatever the array says.
    expect(v.teams[TEAM_FROST][1]).toMatchObject({ connected: false, pingMs: -1 });
    expect(v.teams[TEAM_EMBER][1]).toMatchObject({ isBot: true, pingMs: -1 });
  });

  it('treats missing, negative and huge pings sensibly', () => {
    const lobby = lobbyOf([
      player(0, TEAM_EMBER, 0),
      player(1, TEAM_FROST, 0),
      player(2, TEAM_FROST, 1),
      player(3, TEAM_FROST, 2),
    ]);
    const v = view(lobby, 0, [0, -1, 123456]);
    expect(v.teams[TEAM_FROST][0]?.pingMs).toBe(-1);
    expect(v.teams[TEAM_FROST][1]?.pingMs).toBe(999);
    expect(v.teams[TEAM_FROST][2]?.pingMs).toBe(-1);
    expect(view(lobby, 0).teams[TEAM_FROST][0]?.pingMs).toBe(-1);
  });
});

describe('lobby permissions', () => {
  const players = [
    player(0, TEAM_EMBER, 0),
    player(1, TEAM_EMBER, 1),
    player(2, TEAM_FROST, 0),
    player(3, 'spectator', -1),
  ];

  it('gives the host move and kick actions, but never a kick on themselves', () => {
    const v = view(lobbyOf(players), 0);
    expect(v.localIsHost).toBe(true);
    expect(v.teams[TEAM_EMBER][0]).toMatchObject({
      canKick: false,
      canMoveToEmber: false,
      canMoveToFrost: true,
      canMoveToSpectator: true,
    });
    expect(v.teams[TEAM_EMBER][1]).toMatchObject({ canKick: true, canMoveToFrost: true });
    expect(v.teams[TEAM_FROST][0]).toMatchObject({
      canKick: true,
      canMoveToEmber: true,
      canMoveToFrost: false,
    });
    expect(v.spectators[0]).toMatchObject({
      canKick: true,
      canMoveToEmber: true,
      canMoveToFrost: true,
      canMoveToSpectator: false,
    });
  });

  it('gives a guest no row actions at all', () => {
    const v = view(lobbyOf(players), 1);
    expect(v.localIsHost).toBe(false);
    for (const slot of [...v.teams[0], ...v.teams[1], ...v.spectators]) {
      expect(
        slot.canKick || slot.canMoveToEmber || slot.canMoveToFrost || slot.canMoveToSpectator,
      ).toBe(false);
    }
  });

  it('recognises the host from the lobby even when the connection flag lags', () => {
    const v = computeLobbyView(createLobbyView(), lobbyOf(players), 0, false);
    expect(v.localIsHost).toBe(true);
    expect(
      computeLobbyView(createLobbyView(), lobbyOf(players), NO_PLAYER, false).localIsHost,
    ).toBe(false);
  });

  it('offers no move into a full team', () => {
    const v = view(lobbyOf(players, { teamSize: 2 }), 0);
    expect(v.teams[TEAM_FROST][0]?.canMoveToEmber).toBe(false);
    expect(v.spectators[0]).toMatchObject({ canMoveToEmber: false, canMoveToFrost: true });
    expect(view(lobbyOf(players, { teamSize: 2 }), 3).canJoin).toEqual([false, true]);
  });

  it('offers no move to the watchers when the watcher seats are full', () => {
    const crowd = [player(0, TEAM_EMBER, 0), player(1, TEAM_FROST, 0)];
    for (let i = 0; i < MAX_SPECTATORS; i++) crowd.push(player(10 + i, 'spectator', -1));
    const v = view(lobbyOf(crowd), 0);
    expect(v.teams[TEAM_FROST][0]?.canMoveToSpectator).toBe(false);
    expect(view(lobbyOf(crowd), 1).canSpectate).toBe(false);
  });

  it('blocks every team change while locked, but still lets the host kick', () => {
    const locked = lobbyOf(players, { teamsLocked: true });
    const host = view(locked, 0);
    expect(host.teams[TEAM_EMBER][1]).toMatchObject({
      canKick: true,
      canMoveToFrost: false,
      canMoveToSpectator: false,
    });
    const guest = view(locked, 3);
    expect(guest.canJoin).toEqual([false, false]);
    expect(guest.canSpectate).toBe(false);
    expect(view(locked, 1).canReady).toBe(true);
  });

  it('freezes teams and ready outside the lobby phase, but not kick', () => {
    const starting: LobbyState = { ...lobbyOf(players), phase: 'starting' };
    const host = view(starting, 0);
    expect(host.editable).toBe(false);
    expect(host.teams[TEAM_EMBER][1]).toMatchObject({ canKick: true, canMoveToFrost: false });
    const guest = view(starting, 1);
    expect(guest.canReady).toBe(false);
    expect(guest.canJoin).toEqual([false, false]);
  });

  it('describes the local player', () => {
    const lobby = lobbyOf([
      player(0, TEAM_EMBER, 0),
      player(1, TEAM_FROST, 0, { classId: 'bastion', ready: true }),
      player(2, 'spectator', -1),
    ]);
    const rider = view(lobby, 1);
    expect(rider).toMatchObject({
      localSide: TEAM_FROST,
      localReady: true,
      localClassId: 'bastion',
      canReady: true,
      canSpectate: true,
      memberCount: 3,
    });
    expect(rider.canJoin).toEqual([true, false]);
    const watcher = view(lobby, 2);
    expect(watcher).toMatchObject({ localSide: 'spectator', canReady: false, canSpectate: false });
    expect(watcher.canJoin).toEqual([true, true]);
  });

  it('offers nothing to someone who is not in the list', () => {
    const v = view(lobbyOf(players), 77);
    expect(v.localSide).toBeNull();
    expect(v.canJoin).toEqual([false, false]);
    expect(v.canSpectate).toBe(false);
    expect(v.canReady).toBe(false);
  });
});

describe('rules helpers', () => {
  it('limits team sizes per mode', () => {
    expect(teamSizeRange('skirmish')).toEqual({ min: 1, max: 5 });
    expect(teamSizeRange('duel')).toEqual({ min: 1, max: 5 });
    expect(teamSizeRange('emberRelay')).toEqual({ min: 2, max: 5 });
    expect(teamSizeRange('duel')).toBe(teamSizeRange('duel'));
  });

  it('formats time limits', () => {
    expect(formatTimeLimit(0)).toBe('No limit');
    expect(formatTimeLimit(-5)).toBe('No limit');
    expect(formatTimeLimit(480)).toBe('8 min');
    expect(formatTimeLimit(450)).toBe('7:30');
    expect(formatTimeLimit(65)).toBe('1:05');
  });

  it('offers the default time limit and "none"', () => {
    expect(TIME_LIMIT_CHOICES_S).toContain(0);
    expect(TIME_LIMIT_CHOICES_S).toContain(DEFAULT_HOST_SETTINGS.timeLimitS);
    expect([...TIME_LIMIT_CHOICES_S].sort((a, b) => a - b)).toEqual([...TIME_LIMIT_CHOICES_S]);
  });
});
