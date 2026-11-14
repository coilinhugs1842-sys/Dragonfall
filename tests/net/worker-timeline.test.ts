/**
 * The match timeline through the `HostHandle` (T-5.1), on both hosts the game can get: the
 * `HostCore` in a (fake) worker and on the page's own thread (`?noworker`). The `cinematics`
 * option, `canSkipIntro` and `requestSkipIntro` must behave the same behind either.
 */

import { describe, expect, it } from 'vitest';
import type { CreateHostOptions } from '../../src/net/worker';
import { TICK_MS } from '../../src/shared';
import type { MatchPhase } from '../../src/shared';
import { WORKER_ROOM, WorkerRoom } from './worker-harness';
import type { RoomClient } from './worker-harness';

const LAUNCH = 15;
const INTRO = 60;
const COUNTDOWN = 30;

interface TimelineRoom {
  readonly room: WorkerRoom;
  readonly client: RoomClient;
  /** Every MATCH_PHASE the client got, with the phase's first host tick. */
  readonly phases: [MatchPhase, number][];
}

function timelineRoom(direct: boolean, host: Partial<CreateHostOptions> = {}): TimelineRoom {
  const room = new WorkerRoom({
    ...(direct ? { spawnWorker: null } : {}),
    host: {
      cinematics: true,
      session: {
        roomCode: WORKER_ROOM,
        countdownTicks: COUNTDOWN,
        introTicks: INTRO,
        launchTicks: LAUNCH,
      },
      ...host,
    },
  }).open();
  const phases: [MatchPhase, number][] = [];
  const client = room.join('Rider', {
    listener: {
      onMatchPhase: (phase) => {
        const session = room.clients[0]?.session;
        if (session !== undefined) phases.push([phase, session.phaseStartTick]);
      },
    },
  });
  room.host.applyIntent({ type: 'host.setTeamSize', teamSize: 1 });
  return { room, client, phases };
}

/** The rider readies up and the host presses Start. */
function start(made: TimelineRoom): void {
  const { room, client } = made;
  room.runUntil(() => room.host.lobby?.phase === 'lobby', 5000);
  client.session.sendIntent({ type: 'lobby.ready', ready: true });
  room.runUntil(() => room.host.startBlocker === null, 5000);
  room.host.applyIntent({ type: 'host.start' });
}

function untilPhase(room: WorkerRoom, phase: MatchPhase, maxMs = 20_000): void {
  room.runUntil(() => room.host.matchPhase === phase, maxMs);
}

describe.each([
  ['in a worker', false],
  ['on the main thread', true],
])('the timeline through the host handle, %s', (_name, direct) => {
  it('runs launch -> intro -> countdown -> playing on the host ticks', () => {
    const made = timelineRoom(direct);
    const { room, client, phases } = made;
    expect(room.host.mode).toBe(direct ? 'direct' : 'worker');
    expect(room.fallbacks).toEqual([]);
    start(made);

    // The lobby launch: `starting`, no match yet, for LAUNCH ticks.
    room.runUntil(() => room.host.lobby?.phase === 'starting', 1000);
    const startingAt = room.clock.now;
    expect(room.host.inMatch).toBe(false);
    expect(room.host.matchPhase).toBe('lobby');
    expect(room.host.canSkipIntro).toBe(false);
    room.runUntil(() => room.host.inMatch, 5000);
    const launchMs = room.clock.now - startingAt;
    expect(launchMs).toBeGreaterThan((LAUNCH - 3) * TICK_MS);
    expect(launchMs).toBeLessThan((LAUNCH + 4) * TICK_MS);
    expect(room.host.lobby?.phase).toBe('inMatch');
    expect(room.host.matchPhase).toBe('intro');

    // First match: intro is skippable; without a skip it runs its full length.
    room.run(300);
    expect(room.host.matchPhase).toBe('intro');
    expect(room.host.canSkipIntro).toBe(true);
    expect(room.host.canSkipCinematic).toBe(true);
    expect(client.session.matchPhase).toBe('intro');
    expect(room.host.phaseTimeS).toBeGreaterThan(0.2);

    untilPhase(room, 'playing');
    room.run(300);
    expect(client.session.matchPhase).toBe('playing');
    const [intro, countdown, playing] = phases;
    expect(phases.map((entry) => entry[0])).toEqual(['intro', 'countdown', 'playing']);
    expect((countdown?.[1] ?? 0) - (intro?.[1] ?? 0)).toBe(INTRO);
    expect((playing?.[1] ?? 0) - (countdown?.[1] ?? 0)).toBe(COUNTDOWN);
    room.dispose();
  });

  it('skips the intro on the first match and again on later matches', () => {
    const made = timelineRoom(direct);
    const { room, client, phases } = made;
    start(made);
    untilPhase(room, 'intro');
    room.run(200);
    expect(room.host.canSkipIntro).toBe(true);
    expect(room.host.requestSkipIntro()).toBe(true);
    room.runUntil(() => room.host.matchPhase === 'countdown', 500);
    expect(room.host.canSkipIntro).toBe(false);
    expect(room.host.requestSkipIntro(true)).toBe(false);
    untilPhase(room, 'playing');
    room.run(200);
    expect(phases.map((entry) => entry[0])).toEqual(['intro', 'countdown', 'playing']);
    // Cut short: the countdown began well before the intro's own end, and kept its length.
    expect((phases[1]?.[1] ?? 0) - (phases[0]?.[1] ?? 0)).toBeLessThan(INTRO - 20);
    expect((phases[2]?.[1] ?? 0) - (phases[1]?.[1] ?? 0)).toBe(COUNTDOWN);
    expect(client.session.matchStartTick).toBe(phases[2]?.[1]);

    // Back to the lobby and off again: still skippable.
    room.host.endMatch();
    room.runUntil(() => !room.host.inMatch && room.host.lobby?.phase === 'lobby', 5000);
    phases.length = 0;
    start(made);
    untilPhase(room, 'intro');
    room.runUntil(() => room.host.canSkipIntro, 1000);
    room.run(100);
    expect(room.host.requestSkipCinematic()).toBe(true);
    room.runUntil(() => room.host.matchPhase === 'countdown', 500);
    expect(room.host.canSkipIntro).toBe(false);
    room.run(200);
    expect(client.session.matchPhase).toBe('countdown');
    expect((phases[1]?.[1] ?? 0) - (phases[0]?.[1] ?? 0)).toBeLessThan(INTRO - 20);

    // The Skip intent of the host's own UI does the same.
    room.host.endMatch();
    room.runUntil(() => !room.host.inMatch && room.host.lobby?.phase === 'lobby', 5000);
    phases.length = 0;
    start(made);
    untilPhase(room, 'intro');
    room.runUntil(() => room.host.canSkipIntro, 1000);
    room.host.applyIntent({ type: 'match.skipCinematic' });
    room.runUntil(() => room.host.matchPhase === 'countdown', 500);
    room.dispose();
  });

  it('cinematics: false starts on the countdown with no launch delay', () => {
    const made = timelineRoom(direct, { cinematics: false });
    const { room, client, phases } = made;
    const seen = new Set<string>();
    start(made);
    const pressedAt = room.clock.now;
    room.runUntil(() => {
      seen.add(`${String(room.host.lobby?.phase)}/${room.host.matchPhase}`);
      return room.host.inMatch;
    }, 1000);
    // Within a tick or two (a worker answers through its message queue), not LAUNCH ticks.
    expect(room.clock.now - pressedAt).toBeLessThan(4 * TICK_MS);
    expect(room.host.matchPhase).toBe('countdown');
    expect(room.host.canSkipIntro).toBe(false);
    expect(room.host.requestSkipIntro(true)).toBe(false);
    untilPhase(room, 'playing');
    room.run(200);
    expect(client.session.matchPhase).toBe('playing');
    expect(phases.map((entry) => entry[0])).toEqual(['countdown', 'playing']);
    expect((phases[1]?.[1] ?? 0) - (phases[0]?.[1] ?? 0)).toBe(COUNTDOWN);
    expect([...seen].some((entry) => entry.endsWith('/intro'))).toBe(false);
    room.dispose();
  });
});
