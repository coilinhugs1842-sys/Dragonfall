/**
 * The match timeline end to end (T-5.1): a HostSession and real ClientSessions on the loopback
 * hub. The host alone decides when each phase begins (lobby launch -> intro -> countdown ->
 * playing -> roundEnd -> results -> lobby) and every client learns the same phase with the same
 * first tick, so every browser can show the same moment of the same cinematic.
 */

import { describe, expect, it } from 'vitest';
import { isNetIntent } from '../../src/net/codec';
import type { HostSessionOptions } from '../../src/net/session';
import {
  DRAGON_FLAG_ALIVE,
  MATCH_TUNING,
  MODE_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  TICK_HZ,
} from '../../src/shared';
import type {
  GameEvent,
  LobbyState,
  MatchPhase,
  MatchPhaseEvent,
  ModeTuning,
  PlayerId,
  UiIntent,
} from '../../src/shared';
import { DAMAGE_IGNORE_IMMUNITY, secondsToTicks } from '../../src/sim';
import { Rig } from './session-harness';
import type { RigClient, RigOptions } from './session-harness';

// Short beats so a whole match fits in a test; every length is exact in host ticks.
const LAUNCH = 20;
const INTRO = 60;
const COUNTDOWN = 30;
const ROUND_END = 15;
const RESULTS = 30;

function fastTuning(): ModeTuning {
  return {
    ...MODE_TUNING,
    roundEndS: ROUND_END / TICK_HZ,
    resultsS: RESULTS / TICK_HZ,
    forfeitGraceS: 1,
  };
}

interface Timeline {
  readonly rig: Rig;
  readonly clients: RigClient[];
  /** `matchPhase` events on the HOST's own bus. */
  readonly hostPhases: MatchPhaseEvent[];
  readonly hostEvents: GameEvent[];
  /** Per client: every MATCH_PHASE as the session reported it, with the phase's first tick. */
  readonly clientPhases: [MatchPhase, number][][];
  readonly clientEvents: GameEvent[][];
}

/** A room with the cinematics ON (the harness default is off) and `count` clients in it. */
function timeline(
  count: number,
  host: Partial<HostSessionOptions> = {},
  options: RigOptions = {},
): Timeline {
  const hostPhases: MatchPhaseEvent[] = [];
  const hostEvents: GameEvent[] = [];
  const rig = new Rig({
    ...options,
    host: {
      cinematics: true,
      launchTicks: LAUNCH,
      introTicks: INTRO,
      countdownTicks: COUNTDOWN,
      modeTuning: fastTuning(),
      respawnTicks: TICK_HZ,
      events: {
        emit: (event) => {
          const copy = structuredClone(event);
          hostEvents.push(copy);
          if (copy.type === 'matchPhase') hostPhases.push(copy);
        },
      },
      ...host,
    },
  }).open();
  const made: Timeline = {
    rig,
    clients: [],
    hostPhases,
    hostEvents,
    clientPhases: [],
    clientEvents: [],
  };
  for (let i = 0; i < count; i++) joinClient(made, `Rider ${i + 1}`);
  return made;
}

function joinClient(made: Timeline, name: string): RigClient {
  const phases: [MatchPhase, number][] = [];
  const events: GameEvent[] = [];
  const rig = made.rig;
  const client: RigClient = rig.addClient({
    listener: {
      onMatchPhase: (phase) => void phases.push([phase, client.session.phaseStartTick]),
    },
    events: { emit: (event) => void events.push(structuredClone(event)) },
  });
  made.clients.push(client);
  made.clientPhases.push(phases);
  made.clientEvents.push(events);
  client.session.connect(rig.host.roomCode, name, rig.now + client.clockOffsetMs);
  rig.runUntil(() => client.session.status !== 'connecting', 20_000);
  return client;
}

function apply(rig: Rig, ...intents: UiIntent[]): void {
  for (const intent of intents) {
    if (!rig.host.applyIntent(intent)) throw new Error(`refused: ${intent.type}`);
  }
}

/** Every rider client readies up. */
function readyUp(rig: Rig): void {
  for (const client of rig.clients) {
    const me = client.session.lobby?.players.find((p) => p.id === client.session.localPlayerId);
    if (me !== undefined && me.side !== 'spectator') {
      client.session.sendIntent({ type: 'lobby.ready', ready: true });
    }
  }
  rig.run(300);
}

/** Presses Start; returns the first tick of the match that follows a full launch. */
function pressStart(rig: Rig, launchTicks = LAUNCH): number {
  const pressedAt = rig.host.hostTick;
  if (!rig.host.applyIntent({ type: 'host.start' })) {
    throw new Error(`start refused (${String(rig.host.startBlocker())})`);
  }
  return pressedAt + launchTicks + 1;
}

function untilPhase(rig: Rig, phase: MatchPhase, maxMs = 60_000): void {
  rig.runUntil(() => rig.host.matchPhase === phase, maxMs);
}

function kill(rig: Rig, victim: PlayerId, killer: PlayerId): void {
  const removed = rig.host.sim?.applyDamage(victim, 1e6, killer, 'primary', DAMAGE_IGNORE_IMMUNITY);
  if (!(removed !== undefined && removed > 0)) throw new Error('kill failed');
}

function teamsOf(lobby: LobbyState | null): unknown[] {
  return (lobby?.players ?? []).map((p) => [p.id, p.side, p.perch, p.classId]);
}

function phaseTicks(events: readonly GameEvent[]): [MatchPhase, number][] {
  const out: [MatchPhase, number][] = [];
  for (const event of events) if (event.type === 'matchPhase') out.push([event.phase, event.tick]);
  return out;
}

describe('the match timeline, host to client', () => {
  it('launch -> intro -> countdown -> playing -> roundEnd -> results -> lobby, tick-exact', () => {
    const made = timeline(1);
    const { rig, hostPhases } = made;
    const client = made.clients[0];
    if (client === undefined) throw new Error('no client');
    apply(
      rig,
      { type: 'host.setTeamSize', teamSize: 1 },
      { type: 'host.setScoreLimit', scoreLimit: 1 },
    );
    readyUp(rig);
    const teams = teamsOf(rig.host.lobby);
    const hostId = rig.host.localPlayerId;
    const clientId = client.session.localPlayerId;

    // --- The lobby launch: `starting` for LAUNCH ticks, no match yet ---------------------------
    const first = pressStart(rig);
    expect(rig.host.lobby.phase).toBe('starting');
    expect(rig.host.launching).toBe(true);
    expect(rig.host.inMatch).toBe(false);
    expect(rig.host.matchPhase).toBe('lobby');
    rig.runTicks(LAUNCH - 1);
    expect(rig.host.hostTick).toBe(first - 2);
    expect(rig.host.lobby.phase).toBe('starting');
    expect(rig.host.inMatch).toBe(false);
    expect(client.session.lobby?.phase).toBe('starting');
    expect(client.session.inMatch).toBe(false);
    rig.runTicks(1);
    // Loaded at the end of the launch's last tick; the match's first tick is the next one.
    expect(rig.host.hostTick).toBe(first - 1);
    expect(rig.host.launching).toBe(false);
    expect(rig.host.inMatch).toBe(true);
    expect(rig.host.lobby.phase).toBe('inMatch');
    expect(rig.host.matchPhase).toBe('intro');
    expect(rig.host.matchStartTick).toBe(first + INTRO + COUNTDOWN);

    // --- Intro and countdown: the dragons are held --------------------------------------------
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    const gate = { ...sim.getDragon(clientId)?.position };
    rig.runTicks(INTRO);
    expect(rig.host.hostTick).toBe(first + INTRO - 1);
    expect(rig.host.matchPhase).toBe('intro');
    expect(rig.host.matchClock.phaseTimeS).toBeCloseTo(INTRO * TICK_DT_S, 9);
    rig.runTicks(1);
    expect(rig.host.matchPhase).toBe('countdown');
    expect(rig.host.matchClock.phaseTimeS).toBeCloseTo(TICK_DT_S, 9);
    // The client predicts a few ticks ahead of the host, so look before the very end.
    rig.runTicks(COUNTDOWN - 12);
    expect(client.session.matchPhase).toBe('countdown');
    expect(client.session.predictor.dragon.position).toEqual(gate);
    rig.runTicks(11);
    expect(rig.host.matchPhase).toBe('countdown');
    expect(sim.getDragon(clientId)?.position).toEqual(gate);
    rig.runTicks(1);
    expect(rig.host.hostTick).toBe(first + INTRO + COUNTDOWN);
    expect(rig.host.matchPhase).toBe('playing');

    // --- Playing: control is handed over without a correction ---------------------------------
    rig.runTicks(90);
    expect(client.session.matchPhase).toBe('playing');
    expect(client.session.matchStartTick).toBe(first + INTRO + COUNTDOWN);
    expect(client.session.predictor.matchCount).toBeGreaterThan(40);
    expect(client.session.predictor.correctionCount).toBe(0);

    // --- The deciding takedown, the results, and home -----------------------------------------
    kill(rig, clientId, hostId);
    untilPhase(rig, 'roundEnd');
    // Decided on this tick; `roundEnd` starts on the next.
    const roundEnd = rig.host.hostTick + 1;
    untilPhase(rig, 'results');
    expect(rig.host.hostTick).toBe(roundEnd + ROUND_END);
    rig.runTicks(RESULTS - 1);
    expect(rig.host.matchPhase).toBe('results');
    expect(client.session.matchPhase).toBe('results');
    rig.runTicks(1);
    // `results` lasted exactly resultsS.
    expect(rig.host.hostTick).toBe(roundEnd + ROUND_END + RESULTS);
    expect(rig.host.inMatch).toBe(false);
    rig.run(300);
    expect(rig.host.lobby.phase).toBe('lobby');
    expect(client.session.inMatch).toBe(false);
    expect(client.session.lobby?.phase).toBe('lobby');
    // Teams and classes are kept; nobody is ready.
    expect(teamsOf(rig.host.lobby)).toEqual(teams);
    expect(teamsOf(client.session.lobby)).toEqual(teams);
    expect(rig.host.lobby.players.some((p) => p.ready)).toBe(false);

    // --- The same phases with the same first ticks, on the host and on the client -------------
    const expected: [MatchPhase, number][] = [
      ['intro', first],
      ['countdown', first + INTRO],
      ['playing', first + INTRO + COUNTDOWN],
      ['roundEnd', roundEnd],
      ['results', roundEnd + ROUND_END],
    ];
    expect(hostPhases.map((event) => [event.phase, event.tick])).toEqual([
      ...expected,
      ['lobby', roundEnd + ROUND_END + RESULTS + 1],
    ]);
    expect(made.clientPhases[0]).toEqual(expected);
    expect(phaseTicks(made.clientEvents[0] ?? [])).toEqual([
      ...expected,
      ['lobby', roundEnd + ROUND_END + RESULTS + 1],
    ]);
    rig.dispose();
  });

  it('reads the launch, intro and countdown lengths from MATCH_TUNING by default', () => {
    const made = timeline(1, {
      launchTicks: undefined,
      introTicks: undefined,
      countdownTicks: undefined,
    });
    const { rig, hostPhases } = made;
    readyUp(rig);
    const launch = secondsToTicks(MATCH_TUNING.lobbyLaunchS);
    const intro = secondsToTicks(MATCH_TUNING.matchIntroS);
    const countdown = secondsToTicks(MATCH_TUNING.countdownS);
    expect([launch, intro, countdown]).toEqual([3 * TICK_HZ, 6 * TICK_HZ, 3 * TICK_HZ]);
    const first = pressStart(rig, launch);
    untilPhase(rig, 'playing');
    expect(hostPhases.map((event) => [event.phase, event.tick])).toEqual([
      ['intro', first],
      ['countdown', first + intro],
      ['playing', first + intro + countdown],
    ]);
    rig.dispose();
  });

  it('host and client agree on phaseTimeS within one tick, in every phase', () => {
    const made = timeline(1);
    const { rig } = made;
    const client = made.clients[0];
    if (client === undefined) throw new Error('no client');
    apply(rig, { type: 'host.setTeamSize', teamSize: 1 });
    readyUp(rig);

    const hostClock = new Map<number, { phase: MatchPhase; phaseTimeS: number }>();
    rig.onHostTick = (tick): void => {
      if (!rig.host.inMatch) return;
      hostClock.set(tick, {
        phase: rig.host.matchPhase,
        phaseTimeS: rig.host.matchClock.phaseTimeS,
      });
    };
    const compared: Record<string, number> = { intro: 0, countdown: 0, playing: 0 };
    let ahead = 0;
    let worstLagS = 0;
    rig.onClientFrame = (): void => {
      const session = client.session;
      if (!session.inMatch || !session.sample.valid) return;
      const clock = client.view.clock;
      const host = hostClock.get(clock.tick);
      if (host === undefined) return;
      if (clock.phase === host.phase) {
        // The same tick of the same phase: the same time, up to the fraction being played.
        expect(Math.abs(clock.phaseTimeS - host.phaseTimeS)).toBeLessThanOrEqual(TICK_DT_S + 1e-9);
        compared[clock.phase] = (compared[clock.phase] ?? 0) + 1;
        // Against the host's own "now" the client is behind by its interpolation delay only.
        if (rig.host.matchPhase === clock.phase) {
          const lag = rig.host.matchClock.phaseTimeS - clock.phaseTimeS;
          expect(lag).toBeGreaterThan(-TICK_DT_S);
          if (lag > worstLagS) worstLagS = lag;
        }
      } else {
        // The reliable phase arrived before playback reached it: its clock has not started.
        expect(clock.phaseTimeS).toBeLessThanOrEqual(TICK_DT_S + 1e-9);
        ahead++;
      }
    };

    const first = pressStart(rig);
    untilPhase(rig, 'playing');
    rig.runTicks(60);
    rig.onClientFrame = null;
    rig.onHostTick = null;

    expect(hostClock.get(first)).toEqual({ phase: 'intro', phaseTimeS: TICK_DT_S });
    expect(hostClock.get(first + INTRO - 1)?.phaseTimeS).toBeCloseTo(INTRO * TICK_DT_S, 9);
    expect(hostClock.get(first + INTRO)).toEqual({ phase: 'countdown', phaseTimeS: TICK_DT_S });
    expect(compared['intro']).toBeGreaterThan(INTRO);
    expect(compared['countdown']).toBeGreaterThan(COUNTDOWN);
    expect(compared['playing']).toBeGreaterThan(40);
    // A handful of frames around each change, not a steady state.
    expect(ahead).toBeLessThan(40);
    expect(worstLagS).toBeLessThan(0.3);
    rig.dispose();
  });

  it('nothing moves and nothing is hurt during the intro, whatever the riders press', () => {
    const made = timeline(3);
    const { rig } = made;
    apply(rig, { type: 'host.setTeamSize', teamSize: 2 });
    readyUp(rig);
    // Everybody mashes every ability from the first tick.
    for (const client of rig.clients) client.pilot.abilityButtons = 0xffff;
    rig.hostPilot.abilityButtons = 0xffff;
    pressStart(rig);
    untilPhase(rig, 'intro');
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    const riders = rig.host.lobby.players.filter((p) => p.side !== 'spectator').map((p) => p.id);
    expect(riders).toHaveLength(4);
    const gates = riders.map((id) => ({ ...sim.getDragon(id)?.position }));

    rig.runTicks(INTRO - 2);
    expect(rig.host.matchPhase).toBe('intro');
    expect(sim.rules.ceasefire).toBe(true);
    expect(sim.applyDamage(riders[1] ?? NO_PLAYER, 1e6, riders[0] ?? NO_PLAYER, 'primary', 0)).toBe(
      0,
    );
    riders.forEach((id, index) => {
      const dragon = sim.getDragon(id);
      if (dragon === undefined) throw new Error('no dragon');
      expect(dragon.position).toEqual(gates[index]);
      expect(dragon.health).toBe(dragon.maxHealth);
      expect(dragon.flags & DRAGON_FLAG_ALIVE).not.toBe(0);
    });
    expect(sim.current.projectileCount).toBe(0);
    for (const events of [made.hostEvents, ...made.clientEvents]) {
      expect(events.filter((e) => e.type === 'hit' || e.type === 'abilityCast')).toHaveLength(0);
    }
    // The clients' own dragons stand still too: prediction agrees with the host.
    for (const client of rig.clients) {
      const id = client.session.localPlayerId;
      expect(client.session.matchPhase).toBe('intro');
      expect(client.session.predictor.dragon.position).toEqual(gates[riders.indexOf(id)]);
    }
    rig.dispose();
  });
});

describe('skipping the intro', () => {
  it('is refused on the room’s first match, except with force; clients cannot ask', () => {
    const made = timeline(1);
    const { rig, hostPhases } = made;
    const client = made.clients[0];
    if (client === undefined) throw new Error('no client');
    apply(rig, { type: 'host.setTeamSize', teamSize: 1 });
    readyUp(rig);
    const first = pressStart(rig);
    // Nothing to skip during the launch.
    expect(rig.host.canSkipIntro).toBe(false);
    expect(rig.host.requestSkipIntro(true)).toBe(false);
    untilPhase(rig, 'intro');
    rig.runTicks(10);

    expect(rig.host.canSkipIntro).toBe(false);
    expect(rig.host.requestSkipIntro()).toBe(false);
    expect(rig.host.applyIntent({ type: 'match.skipIntro' })).toBe(false);
    // The intent has no wire form: a client's Skip never leaves its page.
    expect(isNetIntent({ type: 'match.skipIntro' })).toBe(false);
    expect(client.session.sendIntent({ type: 'match.skipIntro' })).toBe(false);
    rig.runTicks(5);
    expect(rig.host.matchPhase).toBe('intro');

    // Forced (dev flag): the countdown starts on the very next tick, for everyone.
    const askedAt = rig.host.hostTick;
    expect(rig.host.requestSkipIntro(true)).toBe(true);
    expect(rig.host.matchPhase).toBe('countdown');
    expect(rig.host.matchStartTick).toBe(askedAt + 1 + COUNTDOWN);
    expect(rig.host.requestSkipIntro(true)).toBe(false);
    rig.run(200);
    expect(client.session.matchPhase).toBe('countdown');
    expect(client.session.phaseStartTick).toBe(askedAt + 1);
    expect(client.session.matchStartTick).toBe(askedAt + 1 + COUNTDOWN);

    untilPhase(rig, 'playing');
    expect(rig.host.hostTick).toBe(askedAt + 1 + COUNTDOWN);
    expect(rig.host.requestSkipIntro(true)).toBe(false);
    // The client let go of its dragon on the same tick: no correction at the handover.
    rig.runTicks(90);
    expect(client.session.matchStartTick).toBe(askedAt + 1 + COUNTDOWN);
    expect(client.session.predictor.matchCount).toBeGreaterThan(40);
    expect(client.session.predictor.correctionCount).toBe(0);
    expect(hostPhases.map((event) => [event.phase, event.tick])).toEqual([
      ['intro', first],
      ['countdown', askedAt + 1],
      ['playing', askedAt + 1 + COUNTDOWN],
    ]);
    expect(made.clientPhases[0]).toEqual([
      ['intro', first],
      ['countdown', askedAt + 1],
      ['playing', askedAt + 1 + COUNTDOWN],
    ]);
    rig.dispose();
  });

  it('is the host’s to use from the room’s second match on', () => {
    const made = timeline(1);
    const { rig } = made;
    const client = made.clients[0];
    if (client === undefined) throw new Error('no client');
    apply(rig, { type: 'host.setTeamSize', teamSize: 1 });
    readyUp(rig);
    pressStart(rig);
    untilPhase(rig, 'playing');
    expect(rig.host.endMatch()).toBe(true);
    rig.run(300);
    expect(rig.host.lobby.phase).toBe('lobby');

    // The second match of the same room.
    readyUp(rig);
    pressStart(rig);
    expect(rig.host.canSkipIntro).toBe(false);
    untilPhase(rig, 'intro');
    rig.runTicks(8);
    expect(rig.host.canSkipIntro).toBe(true);
    const askedAt = rig.host.hostTick;
    expect(rig.host.applyIntent({ type: 'match.skipIntro' })).toBe(true);
    expect(rig.host.canSkipIntro).toBe(false);
    expect(rig.host.matchPhase).toBe('countdown');
    rig.run(200);
    expect(client.session.matchPhase).toBe('countdown');
    expect(client.session.phaseStartTick).toBe(askedAt + 1);
    untilPhase(rig, 'playing');
    expect(rig.host.hostTick).toBe(askedAt + 1 + COUNTDOWN);
    expect(rig.host.canSkipIntro).toBe(false);
    rig.dispose();
  });
});

describe('cinematics: false', () => {
  it('has no launch delay and no intro: Start leads straight to the countdown', () => {
    const made = timeline(1, { cinematics: false });
    const { rig, hostPhases } = made;
    const client = made.clients[0];
    if (client === undefined) throw new Error('no client');
    apply(rig, { type: 'host.setTeamSize', teamSize: 1 });
    readyUp(rig);
    // The launch and intro lengths given to the session are ignored.
    const first = pressStart(rig, 0);
    expect(rig.host.launching).toBe(false);
    expect(rig.host.inMatch).toBe(true);
    expect(rig.host.lobby.phase).toBe('inMatch');
    expect(rig.host.matchPhase).toBe('countdown');
    expect(rig.host.matchStartTick).toBe(first + COUNTDOWN);
    expect(rig.host.canSkipIntro).toBe(false);
    expect(rig.host.requestSkipIntro(true)).toBe(false);
    untilPhase(rig, 'playing');
    expect(rig.host.hostTick).toBe(first + COUNTDOWN);
    rig.run(200);
    expect(hostPhases.map((event) => [event.phase, event.tick])).toEqual([
      ['countdown', first],
      ['playing', first + COUNTDOWN],
    ]);
    expect(made.clientPhases[0]).toEqual([
      ['countdown', first],
      ['playing', first + COUNTDOWN],
    ]);
    rig.dispose();
  });
});

describe('joining and reconnecting during the intro', () => {
  it('a late joiner gets the intro with its real first tick, and the handover tick', () => {
    const made = timeline(1);
    const { rig } = made;
    apply(rig, { type: 'host.setTeamSize', teamSize: 1 });
    readyUp(rig);
    const first = pressStart(rig);
    untilPhase(rig, 'intro');
    rig.runTicks(25);

    const late = joinClient(made, 'Late');
    rig.run(300);
    expect(rig.host.matchPhase).toBe('intro');
    expect(late.session.status).toBe('connected');
    expect(late.session.inMatch).toBe(true);
    expect(late.session.isRider).toBe(false);
    expect(late.session.matchPhase).toBe('intro');
    expect(late.session.phaseStartTick).toBe(first);
    expect(late.session.matchStartTick).toBe(first + INTRO + COUNTDOWN);
    // Its phase clock is the host's, not one that started when it joined.
    expect(late.session.sample.valid).toBe(true);
    const behind = rig.host.matchClock.phaseTimeS - late.view.clock.phaseTimeS;
    expect(late.view.clock.phase).toBe('intro');
    expect(late.view.clock.phaseTimeS).toBeGreaterThan(25 * TICK_DT_S);
    expect(behind).toBeGreaterThan(-TICK_DT_S);
    expect(behind).toBeLessThan(0.3);

    untilPhase(rig, 'playing');
    rig.run(200);
    expect(made.clientPhases[1]).toEqual([
      ['intro', first],
      ['countdown', first + INTRO],
      ['playing', first + INTRO + COUNTDOWN],
    ]);
    rig.dispose();
  });

  it('a late joiner after a skipped intro gets the countdown that replaced it', () => {
    const made = timeline(1);
    const { rig } = made;
    apply(rig, { type: 'host.setTeamSize', teamSize: 1 });
    readyUp(rig);
    pressStart(rig);
    untilPhase(rig, 'intro');
    rig.runTicks(5);
    const askedAt = rig.host.hostTick;
    expect(rig.host.requestSkipIntro(true)).toBe(true);
    rig.runTicks(4);

    const late = joinClient(made, 'Late');
    rig.run(200);
    expect(rig.host.matchPhase).toBe('countdown');
    expect(late.session.matchPhase).toBe('countdown');
    expect(late.session.phaseStartTick).toBe(askedAt + 1);
    expect(late.session.matchStartTick).toBe(askedAt + 1 + COUNTDOWN);
    rig.dispose();
  });

  it('a rider who drops and comes back during the intro is back in the same intro', () => {
    // Long enough for the client's reconnect delay to fit inside it.
    const INTRO = 8 * TICK_HZ;
    const made = timeline(1, { introTicks: INTRO });
    const { rig } = made;
    const client = made.clients[0];
    if (client === undefined) throw new Error('no client');
    apply(rig, { type: 'host.setTeamSize', teamSize: 1 });
    readyUp(rig);
    const id = client.session.localPlayerId;
    const first = pressStart(rig);
    untilPhase(rig, 'intro');
    rig.runTicks(10);

    rig.hostTransport.sever(1);
    rig.run(3);
    expect(client.session.status).toBe('reconnecting');
    rig.runUntil(() => client.session.status === 'connected', 10_000);
    rig.run(200);
    expect(rig.host.matchPhase).toBe('intro');
    expect(client.session.localPlayerId).toBe(id);
    expect(client.session.inMatch).toBe(true);
    expect(client.session.isRider).toBe(true);
    expect(client.session.matchPhase).toBe('intro');
    expect(client.session.phaseStartTick).toBe(first);
    expect(client.session.matchStartTick).toBe(first + INTRO + COUNTDOWN);

    // And it takes its dragon over cleanly when the countdown ends.
    untilPhase(rig, 'playing');
    expect(rig.host.hostTick).toBe(first + INTRO + COUNTDOWN);
    rig.runTicks(90);
    expect(client.session.matchPhase).toBe('playing');
    expect(client.session.predictor.correctionCount).toBe(0);
    rig.dispose();
  });
});

describe('the lobby launch', () => {
  it('refuses lobby edits while it runs, and seats a newcomer as a spectator', () => {
    const made = timeline(3);
    const { rig } = made;
    const [a, b] = made.clients;
    if (a === undefined || b === undefined) throw new Error('no clients');
    apply(rig, { type: 'host.setTeamSize', teamSize: 3 });
    readyUp(rig);
    pressStart(rig);
    rig.runTicks(3);
    const frozen = rig.host.lobby;
    expect(frozen.phase).toBe('starting');

    // The host's own panel.
    const hostEdits: UiIntent[] = [
      { type: 'host.start' },
      { type: 'host.setTeamSize', teamSize: 2 },
      { type: 'host.setMode', mode: 'duel' },
      { type: 'host.setScoreLimit', scoreLimit: 3 },
      { type: 'host.movePlayer', playerId: a.session.localPlayerId, side: 'spectator' },
      { type: 'host.shuffle' },
      { type: 'host.autoBalance' },
      { type: 'host.addBot', side: TEAM_FROST },
      { type: 'host.fillBots' },
      { type: 'lobby.pickClass', classId: 'wraith' },
    ];
    for (const intent of hostEdits) expect(rig.host.applyIntent(intent), intent.type).toBe(false);
    // The riders.
    const refused = rig.host.counters.intentsRefused;
    a.session.sendIntent({ type: 'lobby.ready', ready: false });
    a.session.sendIntent({ type: 'lobby.pickClass', classId: 'tempest' });
    b.session.sendIntent({ type: 'lobby.switchSide', side: 'spectator' });
    rig.runTicks(3);
    expect(rig.host.counters.intentsRefused).toBe(refused + 3);
    expect(rig.host.lobby).toBe(frozen);

    // Somebody arrives mid-launch: in the room, watching.
    const late = joinClient(made, 'Late');
    expect(late.session.status).toBe('connected');
    const lateId = late.session.localPlayerId;
    expect(rig.host.lobby.players.find((p) => p.id === lateId)?.side).toBe('spectator');
    expect(rig.host.lobby.phase).toBe('starting');

    untilPhase(rig, 'intro');
    rig.run(200);
    expect(rig.host.sim?.getDragon(lateId)).toBeUndefined();
    expect(late.session.inMatch).toBe(true);
    expect(late.session.isRider).toBe(false);
    for (const client of [a, b]) {
      expect(client.session.isRider).toBe(true);
      expect(rig.host.sim?.getDragon(client.session.localPlayerId)).toBeDefined();
    }
    rig.dispose();
  });

  it('a rider whose link drops during it keeps the seat: the match starts with its dragon', () => {
    const made = timeline(3);
    const { rig } = made;
    const [a] = made.clients;
    if (a === undefined) throw new Error('no client');
    apply(rig, { type: 'host.setTeamSize', teamSize: 2 });
    readyUp(rig);
    const id = a.session.localPlayerId;
    const first = pressStart(rig);
    rig.runTicks(4);
    rig.hostTransport.sever(1);
    // Kept away until the match is running.
    a.running = false;
    rig.runTicks(4);
    expect(rig.host.lobby.phase).toBe('starting');
    expect(rig.host.lobby.players.find((p) => p.id === id)?.connected).toBe(false);

    untilPhase(rig, 'intro');
    expect(rig.host.hostTick).toBe(first - 1);
    expect(rig.host.sim?.getDragon(id)).toBeDefined();
    untilPhase(rig, 'playing');
    expect(rig.host.hostTick).toBe(first + INTRO + COUNTDOWN);
    // The host flies the empty seat; the rider takes it back when the link returns.
    rig.runTicks(30);
    expect(rig.host.matchPhase).toBe('playing');
    a.running = true;
    rig.runUntil(() => a.session.status === 'connected', 10_000);
    rig.run(300);
    expect(a.session.inMatch).toBe(true);
    expect(a.session.isRider).toBe(true);
    expect(a.session.matchPhase).toBe('playing');
    rig.dispose();
  });

  it('riders leaving during it: fewer riders start, or nobody does when a team is empty', () => {
    const made = timeline(3);
    const { rig } = made;
    const [a, b, c] = made.clients;
    if (a === undefined || b === undefined || c === undefined) throw new Error('no clients');
    apply(
      rig,
      { type: 'host.setTeamSize', teamSize: 2 },
      { type: 'host.setUnevenTeams', enabled: true },
    );
    readyUp(rig);
    const sideOf = (client: RigClient): unknown =>
      rig.host.lobby.players.find((p) => p.id === client.session.localPlayerId)?.side;
    // Host + c on Ember, a + b on Frost (join order alternates, Ember first).
    const frost = [a, b, c].filter((client) => sideOf(client) === TEAM_FROST);
    const ember = [a, b, c].filter((client) => sideOf(client) === TEAM_EMBER);
    expect(frost).toHaveLength(2);
    expect(ember).toHaveLength(1);

    // One Frost rider leaves mid-launch: the match starts 2 v 1.
    pressStart(rig);
    rig.runTicks(5);
    const leaver = frost[0];
    if (leaver === undefined) throw new Error('no leaver');
    const leaverId = leaver.session.localPlayerId;
    leaver.session.sendIntent({ type: 'lobby.leave' });
    untilPhase(rig, 'intro');
    expect(rig.host.sim?.getDragon(leaverId)).toBeUndefined();
    expect(rig.host.director.statsCount).toBe(3);
    expect(rig.host.endMatch()).toBe(true);
    rig.run(300);
    expect(rig.host.lobby.phase).toBe('lobby');

    // Now the last Frost rider leaves mid-launch: there is no match to play.
    readyUp(rig);
    pressStart(rig);
    rig.runTicks(5);
    frost[1]?.session.sendIntent({ type: 'lobby.leave' });
    rig.runTicks(LAUNCH + 5);
    expect(rig.host.inMatch).toBe(false);
    expect(rig.host.launching).toBe(false);
    expect(rig.host.lobby.phase).toBe('lobby');
    expect(rig.host.lobby.players.some((p) => p.ready)).toBe(false);
    rig.run(200);
    for (const client of ember) {
      expect(client.session.inMatch).toBe(false);
      expect(client.session.lobby?.phase).toBe('lobby');
    }
    rig.dispose();
  });

  it('the host can call the start off during it', () => {
    const made = timeline(1);
    const { rig } = made;
    const client = made.clients[0];
    if (client === undefined) throw new Error('no client');
    apply(rig, { type: 'host.setTeamSize', teamSize: 1 });
    readyUp(rig);
    const teams = teamsOf(rig.host.lobby);
    pressStart(rig);
    rig.runTicks(6);
    expect(rig.host.endMatch()).toBe(true);
    expect(rig.host.launching).toBe(false);
    rig.runTicks(LAUNCH + 5);
    expect(rig.host.inMatch).toBe(false);
    expect(rig.host.lobby.phase).toBe('lobby');
    expect(client.session.lobby?.phase).toBe('lobby');
    expect(client.session.inMatch).toBe(false);
    expect(teamsOf(rig.host.lobby)).toEqual(teams);
    // And the room starts again as if nothing had happened: this is still its first match.
    readyUp(rig);
    pressStart(rig);
    untilPhase(rig, 'intro');
    expect(rig.host.canSkipIntro).toBe(false);
    rig.dispose();
  });
});

describe('after the round is over', () => {
  it('nobody can be hurt, and host-flown bots circle instead of flying off', () => {
    const made = timeline(0, { cinematics: false });
    const { rig } = made;
    apply(
      rig,
      { type: 'host.setTeamSize', teamSize: 2 },
      { type: 'host.setScoreLimit', scoreLimit: 1 },
      { type: 'host.fillBots' },
    );
    pressStart(rig, 0);
    untilPhase(rig, 'playing');
    const sim = rig.host.sim;
    if (sim === null) throw new Error('no sim');
    const hostId = rig.host.localPlayerId;
    const bots = rig.host.lobby.players.filter((p) => p.isBot).map((p) => p.id);
    expect(bots).toHaveLength(3);
    const enemy = rig.host.lobby.players.find((p) => p.isBot && p.side === TEAM_FROST);
    if (enemy === undefined) throw new Error('no enemy bot');
    kill(rig, enemy.id, hostId);
    untilPhase(rig, 'roundEnd');
    rig.runTicks(2);

    // From here to the lobby the damage gate is shut.
    expect(sim.rules.ceasefire).toBe(true);
    const healthAt = bots.map((id) => sim.getDragon(id)?.health ?? -1);
    for (const id of bots) {
      expect(sim.applyDamage(id, 1e6, hostId, 'primary', DAMAGE_IGNORE_IMMUNITY)).toBe(0);
    }
    const hitsBefore = made.hostEvents.filter((e) => e.type === 'hit').length;
    const takedownsBefore = made.hostEvents.filter((e) => e.type === 'takedown').length;

    untilPhase(rig, 'results');
    const turned = new Map<PlayerId, number>();
    const lastYaw = new Map<PlayerId, number>();
    rig.onHostTick = (): void => {
      for (const id of bots) {
        const dragon = rig.host.sim?.getDragon(id);
        if (dragon === undefined || (dragon.flags & DRAGON_FLAG_ALIVE) === 0) continue;
        const before = lastYaw.get(id);
        if (before !== undefined) {
          const delta = Math.abs(dragon.yaw - before);
          turned.set(id, (turned.get(id) ?? 0) + Math.min(delta, Math.PI * 2 - delta));
        }
        lastYaw.set(id, dragon.yaw);
      }
    };
    rig.runTicks(RESULTS - 2);
    rig.onHostTick = null;
    expect(rig.host.matchPhase).toBe('results');
    expect(sim.rules.ceasefire).toBe(true);
    // The two bots that were alive turned onto the holding circle (a resting brain alone
    // would fly dead straight).
    const living = bots.filter((id) => id !== enemy.id);
    for (const id of living) {
      expect(turned.get(id) ?? 0).toBeGreaterThan(0.05);
      expect(rig.host.hostBots.brainOf(id)?.targetId).toBe(NO_PLAYER);
    }
    bots.forEach((id, index) => {
      const health = sim.getDragon(id)?.health ?? -1;
      if (id !== enemy.id) expect(health).toBe(healthAt[index]);
    });
    expect(made.hostEvents.filter((e) => e.type === 'hit')).toHaveLength(hitsBefore);
    expect(made.hostEvents.filter((e) => e.type === 'takedown')).toHaveLength(takedownsBefore);
    rig.dispose();
  });
});
