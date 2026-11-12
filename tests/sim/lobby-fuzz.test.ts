/**
 * Seeded fuzz: thousands of random operations (legal and illegal, from hosts, clients and
 * strangers) must never break the lobby's invariants, whatever the operations answer.
 */

import { describe, expect, it } from 'vitest';
import {
  DRAGON_CLASS_IDS,
  MAX_LOBBY_MEMBERS,
  MAX_SPECTATORS,
  MAX_TEAM_SIZE,
  NO_PLAYER,
  PROTOCOL_VERSION,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../src/shared';
import type { DragonClassId, LobbySide, UiIntent } from '../../src/shared';
import { createSeededRandom } from '../../src/shared/maps/seeded-random';
import {
  applyLobbyIntent,
  canStart,
  countLobbySide,
  createLobby,
  disconnectPlayer,
  enterMatch,
  launchMatch,
  expireReconnects,
  handleHello,
  joinLobby,
  returnToLobby,
  validateLobbyState,
} from '../../src/sim/lobby';
import type { HostLobby, LobbyEffect, LobbyIntent } from '../../src/sim/lobby';

const SIDES: readonly LobbySide[] = [TEAM_EMBER, TEAM_FROST, 'spectator'];

function checkInvariants(lobby: HostLobby, label: string): void {
  const { state, seats } = lobby;
  const players = state.players;
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}\n${JSON.stringify(state)}`);
  };

  const ids = players.map((p) => p.id);
  if (new Set(ids).size !== ids.length) fail('duplicate player ids');
  if (ids.some((id) => !Number.isInteger(id) || id < 0 || id >= NO_PLAYER)) fail('id out of u8');
  if (players.length > MAX_LOBBY_MEMBERS) fail('too many members');

  const hosts = players.filter((p) => p.isHost);
  if (hosts.length !== 1 || hosts[0]?.id !== state.hostId) fail('not exactly one host');
  if (players[0]?.isHost !== true) fail('host is not first');
  if (hosts[0]?.connected !== true) fail('host disconnected');

  const { teamSize, allowedClasses } = state.settings;
  if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > MAX_TEAM_SIZE) fail('team size');
  for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
    const members = players.filter((p) => p.side === team);
    if (members.length > teamSize) fail(`team ${team} over size`);
    const perches = members.map((p) => p.perch);
    if (new Set(perches).size !== perches.length) fail(`team ${team} shares a perch`);
    if (perches.some((perch) => perch < 0 || perch >= MAX_TEAM_SIZE)) fail('perch out of range');
  }
  for (const player of players) {
    if (player.side === 'spectator' && player.perch !== -1) fail('spectator on a perch');
    if (player.side === 'spectator' && player.ready) fail('ready spectator');
    if (!allowedClasses.includes(player.classId)) fail('class not allowed');
    if (player.connected !== (player.reconnectDeadlineTick === -1)) fail('deadline mismatch');
    if (!player.connected && player.ready) fail('ready while disconnected');
    if (player.name.length === 0) fail('empty name');
  }
  const names = players.map((p) => p.name.toLowerCase());
  if (new Set(names).size !== names.length) fail('duplicate names');
  if (allowedClasses.length === 0) fail('no classes allowed');

  // The private half matches the public half, and tokens are unique.
  if (seats.length !== players.length) fail('seat count');
  if (seats.some((seat) => !ids.includes(seat.id))) fail('seat without player');
  const tokens = seats.map((seat) => seat.token).filter((token) => token.length > 0);
  if (new Set(tokens).size !== tokens.length) fail('duplicate tokens');
  if (tokens.some((token) => lobby.kickedTokens.includes(token))) fail('kicked token seated');

  // What goes on the wire must survive the client's validator unchanged.
  const parsed = validateLobbyState(JSON.parse(JSON.stringify(state)));
  if (parsed === null) fail('validateLobbyState rejected a host state');
  expect(parsed).toEqual(state);
  canStart(state);
}

function runFuzz(seed: number, steps: number): { joins: number; starts: number; kicks: number } {
  const random = createSeededRandom(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  let lobby = createLobby({ roomCode: 'FUZZY', hostName: 'Host' });
  let tick = 0;
  let tokenSeq = 0;
  const knownTokens: string[] = [];
  const stats = { joins: 0, starts: 0, kicks: 0 };

  const note = (effects: readonly LobbyEffect[]): void => {
    for (const effect of effects) {
      if (effect.type === 'matchStart') {
        stats.starts += 1;
        const riders = effect.roster.riders;
        expect(new Set(riders.map((r) => r.playerId)).size).toBe(riders.length);
        for (const team of [TEAM_EMBER, TEAM_FROST]) {
          const slots = riders.filter((r) => r.team === team).map((r) => r.gateSlot);
          expect(new Set(slots).size).toBe(slots.length);
          expect(slots.every((slot) => slot >= 0 && slot < MAX_TEAM_SIZE)).toBe(true);
        }
      }
      if (effect.type === 'playerRemoved' && effect.cause === 'kicked') stats.kicks += 1;
    }
  };

  const anyId = (): number => {
    // Mostly real players, sometimes a stranger.
    if (random() < 0.1) return int(40);
    return pick(lobby.state.players).id;
  };

  const randomIntent = (): LobbyIntent | UiIntent => {
    const classId = pick<DragonClassId | 'bogus'>([...DRAGON_CLASS_IDS, 'bogus']) as DragonClassId;
    const classes = DRAGON_CLASS_IDS.filter(() => random() < 0.6);
    const options: (LobbyIntent | UiIntent)[] = [
      { type: 'lobby.ready', ready: random() < 0.7 },
      { type: 'lobby.ready', ready: true },
      { type: 'lobby.pickClass', classId },
      { type: 'lobby.switchSide', side: pick(SIDES) },
      { type: 'lobby.switchSide', side: pick(SIDES) },
      { type: 'lobby.leave' },
      { type: 'lobby.focusPlayer', playerId: 1 },
      { type: 'host.setMode', mode: pick(['skirmish', 'duel', 'emberRelay'] as const) },
      { type: 'host.setMap', map: pick(['shattered-spires', 'emberfall-caldera'] as const) },
      { type: 'host.setTeamSize', teamSize: int(9) - 1 },
      { type: 'host.setTeamSize', teamSize: 5 },
      { type: 'host.setUnevenTeams', enabled: random() < 0.5 },
      { type: 'host.setScoreLimit', scoreLimit: int(400) - 50 },
      { type: 'host.setTimeLimit', timeLimitS: int(4000) - 100 },
      { type: 'host.setFriendlyFire', enabled: random() < 0.5 },
      { type: 'host.setAllowedClasses', classes },
      { type: 'host.movePlayer', playerId: anyId(), side: pick(SIDES) },
      { type: 'host.movePlayer', playerId: anyId(), side: pick(SIDES) },
      { type: 'host.autoBalance' },
      { type: 'host.shuffle' },
      { type: 'host.lockTeams', locked: random() < 0.3 },
      { type: 'host.kick', playerId: anyId() },
      { type: 'host.start' },
      { type: 'host.start' },
    ];
    return pick(options);
  };

  for (let step = 0; step < steps; step++) {
    tick += int(120);
    const before = lobby;
    const beforeJson = JSON.stringify(before);
    const roll = random();
    let label = '';

    if (roll < 0.22) {
      label = 'hello';
      const useOld = knownTokens.length > 0 && random() < 0.5;
      const newToken = `t${tokenSeq++}`;
      const result = handleHello(
        lobby,
        {
          name: pick(['Ash', 'ash', 'Bo', '', '  Cy  ', 'A very long name indeed here', 7]),
          protocolVersion: random() < 0.95 ? PROTOCOL_VERSION : 0,
          reconnectToken: useOld ? pick(knownTokens) : undefined,
        },
        { tick, newToken },
      );
      if (result.ok) {
        stats.joins += 1;
        knownTokens.push(result.token);
        note(result.effects);
        const seated = result.lobby.state.players.find((p) => p.id === result.playerId);
        expect(seated?.connected).toBe(true);
        expect(result.lobby.seats.find((s) => s.id === result.playerId)?.token).toBe(result.token);
      } else {
        expect(result.lobby).toBe(before);
        if (result.reject === 'full' || result.reject === 'matchInProgress') {
          const specs = countLobbySide(before.state.players, 'spectator');
          expect(specs >= MAX_SPECTATORS || before.state.players.length >= MAX_LOBBY_MEMBERS).toBe(
            true,
          );
        }
      }
      lobby = result.lobby;
    } else if (roll < 0.26) {
      label = 'bot';
      const result = joinLobby(lobby, { name: 'Bot', token: '', isBot: true });
      lobby = result.lobby;
    } else if (roll < 0.36) {
      label = 'disconnect';
      const result = disconnectPlayer(lobby, anyId(), tick);
      if (result.ok) note(result.effects);
      lobby = result.lobby;
    } else if (roll < 0.42) {
      label = 'expire';
      const result = expireReconnects(lobby, tick);
      if (result.ok) note(result.effects);
      lobby = result.lobby;
    } else if (roll < 0.44) {
      label = 'enterMatch';
      lobby = enterMatch(lobby).lobby;
    } else if (roll < 0.46) {
      // The end of the lobby launch: a match with whoever is still there, or back to the lobby.
      label = 'launchMatch';
      const wasStarting = lobby.state.phase === 'starting';
      const result = launchMatch(lobby, random() < 0.3);
      expect(result.ok).toBe(wasStarting);
      if (result.ok) {
        const launched = result.effects.find((effect) => effect.type === 'matchLaunch');
        expect(result.lobby.state.phase).toBe(launched !== undefined ? 'inMatch' : 'lobby');
        if (launched !== undefined && launched.type === 'matchLaunch') {
          const riders = launched.roster.riders;
          expect(riders.length).toBeGreaterThan(0);
          expect(new Set(riders.map((r) => r.playerId)).size).toBe(riders.length);
        }
      }
      lobby = result.lobby;
    } else if (roll < 0.52) {
      label = 'returnToLobby';
      lobby = returnToLobby(lobby).lobby;
    } else {
      const intent = randomIntent();
      // Mostly the host for host intents, otherwise anyone.
      const actor =
        intent.type.startsWith('host.') && random() < 0.75 ? lobby.state.hostId : anyId();
      label = `${intent.type} by ${actor}`;
      const result = applyLobbyIntent(lobby, actor, intent, {
        tick,
        seed: int(1_000_000),
        forceStart: random() < 0.3,
      });
      if (result.ok) {
        note(result.effects);
        expect(result.changed).toBe(result.lobby.state !== before.state);
        if (result.effects.some((effect) => effect.type === 'lobbyClosed')) {
          expect(actor).toBe(before.state.hostId);
          expect(result.lobby).toBe(before);
        }
      } else {
        expect(result.lobby).toBe(before);
        if (intent.type.startsWith('host.') && actor !== before.state.hostId) {
          expect(['notHost', 'unknownActor']).toContain(result.reason);
        }
      }
      lobby = result.lobby;
    }

    // Operations are pure: the lobby they were given is never modified.
    expect(JSON.stringify(before)).toBe(beforeJson);
    checkInvariants(lobby, `seed ${seed} step ${step} (${label})`);
  }
  return stats;
}

describe('lobby fuzz', () => {
  it.each([1, 2, 3, 42, 1337, 20261110])('holds its invariants for seed %i', (seed) => {
    const stats = runFuzz(seed, 2500);
    // The run must actually exercise the interesting paths, not just bounce off refusals.
    expect(stats.joins).toBeGreaterThan(50);
    expect(stats.starts).toBeGreaterThan(3);
    expect(stats.kicks).toBeGreaterThan(3);
  });

  it('is reproducible for a seed', () => {
    expect(runFuzz(7, 400)).toEqual(runFuzz(7, 400));
  });
});
