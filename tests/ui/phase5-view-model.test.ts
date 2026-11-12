/**
 * The Phase 5 view-models (T-5.2 .. T-5.6): pure functions, no DOM. The screens that draw them
 * are covered in `phase5-screens.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, NO_PLAYER, TEAM_EMBER, TEAM_FROST } from '../../src/shared/constants';
import type { PlayerId, TeamId } from '../../src/shared/constants';
import { DEFAULT_HOST_SETTINGS } from '../../src/shared/lobby';
import type { LobbyPlayer, LobbyState } from '../../src/shared/lobby';
import type { MatchPhase, MatchWinner } from '../../src/shared/match';
import type { HudState, LobbyPlate, ResultsState, ScoreboardRow } from '../../src/shared/ui';
import { createHudState } from '../../src/ui/hud';
import { UNIT_STEPS, combatHudVisible, introCardStep } from '../../src/ui/hud/hud-model';
import {
  PLATE_PERCENT_STRINGS,
  PLATE_POOL_SIZE,
  PLATE_POSITION_STEPS,
  PLATE_SCALE_MAX,
  PLATE_SCALE_MIN,
  PLATE_SCALE_STEPS,
  PLATE_SCALE_STRINGS,
  aerieNotice,
  clampPlateScale,
  createPlateBand,
  createPlatePlacement,
  findLobbyPlayer,
  focusTarget,
  lobbyLayoutFor,
  measurePlateBand,
  placePlate,
} from '../../src/ui/view-model/aerie-view';
import {
  FADE_STEPS,
  LOADING_FADE_OUT_MS,
  LOADING_MIN_VISIBLE_MS,
  LOADING_OPACITY_STEPS,
  createLoadingGate,
  createSkipLatch,
  fadeStep,
  isSkipKey,
  loadingPercent,
  rearmSkip,
  skipHintShown,
  takeSkip,
  updateLoadingGate,
} from '../../src/ui/view-model/cinematic';
import {
  AWARD_DAMAGE,
  AWARD_MVP,
  AWARD_TAKEDOWNS,
  REVEAL_ALL,
  REVEAL_BANNER,
  REVEAL_FIRST_AWARD,
  REVEAL_TIMES_S,
  awardMarks,
  computeResultsView,
  createResultsView,
  revealStage,
} from '../../src/ui/view-model/results-view';

function plate(x: number, y: number, extra?: Partial<LobbyPlate>): LobbyPlate {
  return { playerId: 1, x, y, scale: 1, visible: true, ...extra };
}

function hudIn(phase: MatchPhase, canSkipIntro: boolean): HudState {
  const hud = createHudState();
  hud.phase = phase;
  hud.canSkipIntro = canSkipIntro;
  return hud;
}

function row(playerId: PlayerId, team: TeamId, extra?: Partial<ScoreboardRow>): ScoreboardRow {
  return {
    playerId,
    name: `Rider ${playerId}`,
    team,
    classId: 'talon',
    takedowns: 3,
    deaths: 2,
    damage: 800,
    pingMs: 20,
    alive: true,
    assists: 1,
    ...extra,
  };
}

function results(winner: MatchWinner, extra?: Partial<ResultsState>): ResultsState {
  return {
    winner,
    scores: [12, 9],
    mvpId: 1,
    mostTakedownsId: 2,
    mostDamageId: 3,
    scoreboard: [
      row(1, TEAM_EMBER, { name: 'Aman', takedowns: 9, deaths: 4, assists: 6, damage: 2140 }),
      row(2, TEAM_FROST, { name: 'Kestrel', takedowns: 11, deaths: 3, assists: 2, damage: 1985 }),
      row(3, TEAM_EMBER, { name: 'Miro', takedowns: 1, deaths: 6, assists: 1, damage: 2410 }),
      row(4, TEAM_FROST, { name: 'Juno' }),
    ],
    ...extra,
  };
}

describe('aerie lobby layout', () => {
  it('docks only when the state says the 3D aerie is behind the UI', () => {
    expect(lobbyLayoutFor(true)).toBe('aerie');
    expect(lobbyLayoutFor(false)).toBe('flat');
    // Absent = the lobby of before Phase 5.
    expect(lobbyLayoutFor(undefined)).toBe('flat');
  });

  it('gives way to one line while the room is not gathering', () => {
    expect(aerieNotice('lobby')).toBe('');
    expect(aerieNotice('starting')).toBe('Taking off');
    expect(aerieNotice('inMatch')).not.toBe('');
  });

  it('finds a lobby member by id', () => {
    const member: LobbyPlayer = {
      id: 4,
      name: 'Juno',
      side: TEAM_FROST,
      perch: 0,
      classId: 'wraith',
      ready: true,
      isHost: false,
      connected: true,
      reconnectDeadlineTick: -1,
      isBot: false,
    };
    const lobby: LobbyState = {
      roomCode: 'ABCDE',
      phase: 'lobby',
      hostId: 4,
      players: [member],
      settings: DEFAULT_HOST_SETTINGS,
    };
    expect(findLobbyPlayer(lobby, 4)).toBe(member);
    expect(findLobbyPlayer(lobby, 5)).toBeNull();
    expect(findLobbyPlayer(lobby, NO_PLAYER)).toBeNull();
  });
});

describe('close-up focus', () => {
  it('asks for the clicked rider', () => {
    expect(focusTarget(NO_PLAYER, 3)).toBe(3);
    expect(focusTarget(2, 3)).toBe(3);
  });

  it('lets go when the focused rider is clicked again', () => {
    expect(focusTarget(3, 3)).toBeNull();
  });

  it('never focuses nobody', () => {
    expect(focusTarget(3, NO_PLAYER)).toBeNull();
    expect(focusTarget(NO_PLAYER, NO_PLAYER)).toBeNull();
  });
});

describe('name card placement', () => {
  const free = createPlateBand();

  it('has one card per rider and ready-made CSS values', () => {
    expect(PLATE_POOL_SIZE).toBe(MAX_PLAYERS);
    expect(PLATE_PERCENT_STRINGS).toHaveLength(PLATE_POSITION_STEPS + 1);
    expect(PLATE_PERCENT_STRINGS[0]).toBe('0%');
    expect(PLATE_PERCENT_STRINGS[PLATE_POSITION_STEPS]).toBe('100%');
    expect(PLATE_PERCENT_STRINGS[PLATE_POSITION_STEPS / 2]).toBe('50%');
    expect(PLATE_SCALE_STRINGS).toHaveLength(PLATE_SCALE_STEPS + 1);
    expect(Number(PLATE_SCALE_STRINGS[0])).toBeCloseTo(PLATE_SCALE_MIN);
    expect(Number(PLATE_SCALE_STRINGS[PLATE_SCALE_STEPS])).toBeCloseTo(PLATE_SCALE_MAX);
  });

  it('turns a viewport fraction into a table step', () => {
    const out = placePlate(createPlatePlacement(), plate(0.25, 0.5), free);
    expect(out.shown).toBe(true);
    expect(PLATE_PERCENT_STRINGS[out.xStep]).toBe('25%');
    expect(PLATE_PERCENT_STRINGS[out.yStep]).toBe('50%');
    expect(Number(PLATE_SCALE_STRINGS[out.scaleStep])).toBeCloseTo(1);
  });

  it('reuses the placement object', () => {
    const out = createPlatePlacement();
    expect(placePlate(out, plate(0.4, 0.4), free)).toBe(out);
  });

  it('hides a card whose perch is off screen, behind the camera or not a number', () => {
    const out = createPlatePlacement();
    expect(placePlate(out, plate(0.5, 0.5, { visible: false }), free).shown).toBe(false);
    expect(placePlate(out, plate(Number.NaN, 0.5), free).shown).toBe(false);
    expect(placePlate(out, plate(0.5, Number.POSITIVE_INFINITY), free).shown).toBe(false);
    expect(placePlate(out, plate(-0.1, 0.5), free).shown).toBe(false);
    expect(placePlate(out, plate(0.5, 1.2), free).shown).toBe(false);
  });

  it('clamps the scale to a readable range', () => {
    expect(clampPlateScale(0.1)).toBe(PLATE_SCALE_MIN);
    expect(clampPlateScale(9)).toBe(PLATE_SCALE_MAX);
    expect(clampPlateScale(1.2)).toBe(1.2);
    expect(clampPlateScale(Number.NaN)).toBe(1);
    expect(clampPlateScale(0)).toBe(1);
    const out = placePlate(createPlatePlacement(), plate(0.5, 0.5, { scale: 40 }), free);
    expect(out.scaleStep).toBe(PLATE_SCALE_STEPS);
  });

  it('keeps cards out from under the docked panels', () => {
    const band = createPlateBand();
    // 1000×500 viewport; docks end at 200 and start at 800; bars at 50 and 450; card 100×40.
    expect(measurePlateBand(band, 1000, 500, 200, 800, 50, 450, 100, 40)).toBe(true);
    expect(band.left).toBeCloseTo(0.2);
    expect(band.right).toBeCloseTo(0.8);
    const out = createPlatePlacement();
    // Under the left dock: no card (the roster beside it names the rider).
    expect(placePlate(out, plate(0.1, 0.5), band).shown).toBe(false);
    expect(placePlate(out, plate(0.9, 0.5), band).shown).toBe(false);
    expect(placePlate(out, plate(0.5, 0.95), band).shown).toBe(false);
    // Just inside the band: shown, nudged inward by half a card (50 px = 5 %).
    placePlate(out, plate(0.21, 0.5), band);
    expect(out.shown).toBe(true);
    expect(PLATE_PERCENT_STRINGS[out.xStep]).toBe('25%');
    placePlate(out, plate(0.79, 0.5), band);
    expect(PLATE_PERCENT_STRINGS[out.xStep]).toBe('75%');
    // Near the top bar: pushed down so the whole card (40 px = 8 %) is below it.
    placePlate(out, plate(0.5, 0.11), band);
    expect(PLATE_PERCENT_STRINGS[out.yStep]).toBe('18%');
  });

  it('falls back to the whole screen when the layout could not be measured', () => {
    const band = createPlateBand();
    measurePlateBand(band, 1000, 500, 200, 800, 50, 450, 100, 40);
    // A hidden lobby measures as nothing.
    expect(measurePlateBand(band, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN)).toBe(false);
    expect(band).toEqual(createPlateBand());
    expect(placePlate(createPlatePlacement(), plate(0.05, 0.5), band).shown).toBe(true);
  });
});

describe('match intro', () => {
  it('hides the combat HUD while a cinematic owns the screen', () => {
    expect(combatHudVisible('intro')).toBe(false);
    expect(combatHudVisible('results')).toBe(false);
    for (const phase of ['countdown', 'playing', 'roundEnd', 'lobby'] as const) {
      expect(combatHudVisible(phase)).toBe(true);
    }
  });

  it('draws the title card at the opacity the state gives', () => {
    expect(introCardStep(undefined)).toBe(0);
    expect(introCardStep(0)).toBe(0);
    expect(introCardStep(-1)).toBe(0);
    expect(introCardStep(Number.NaN)).toBe(0);
    expect(introCardStep(1)).toBe(UNIT_STEPS);
    expect(introCardStep(7)).toBe(UNIT_STEPS);
    expect(introCardStep(0.5)).toBe(UNIT_STEPS / 2);
    // A card that has started to appear is never rounded away.
    expect(introCardStep(0.0001)).toBeGreaterThan(0);
  });

  it('offers the skip only during the intro and only when allowed', () => {
    expect(skipHintShown(hudIn('intro', true))).toBe(true);
    expect(skipHintShown(hudIn('intro', false))).toBe(false);
    expect(skipHintShown(hudIn('countdown', true))).toBe(false);
    expect(skipHintShown(null)).toBe(false);
  });

  it('skips on Space and Enter only', () => {
    expect(isSkipKey('Space')).toBe(true);
    expect(isSkipKey('Enter')).toBe(true);
    expect(isSkipKey('NumpadEnter')).toBe(true);
    expect(isSkipKey('Escape')).toBe(false);
    expect(isSkipKey('KeyW')).toBe(false);
  });

  it('sends one skip per intro', () => {
    const latch = createSkipLatch();
    const intro = hudIn('intro', true);
    expect(takeSkip(latch, 'match', intro, false)).toBe(true);
    expect(takeSkip(latch, 'match', intro, false)).toBe(false);
    // Still the same intro: the latch holds.
    rearmSkip(latch, intro);
    expect(takeSkip(latch, 'match', intro, false)).toBe(false);
    // The next match's intro can be skipped again.
    rearmSkip(latch, hudIn('playing', true));
    expect(takeSkip(latch, 'match', intro, false)).toBe(true);
  });

  it('does not skip behind a menu, outside the intro, or when not allowed', () => {
    const latch = createSkipLatch();
    expect(takeSkip(latch, 'match', hudIn('intro', true), true)).toBe(false);
    expect(takeSkip(latch, 'match', hudIn('intro', false), false)).toBe(false);
    expect(takeSkip(latch, 'match', hudIn('playing', true), false)).toBe(false);
    expect(takeSkip(latch, 'lobby', hudIn('intro', true), false)).toBe(false);
    expect(takeSkip(latch, 'match', null, false)).toBe(false);
    // None of those used the latch up.
    expect(takeSkip(latch, 'match', hudIn('intro', true), false)).toBe(true);
  });
});

describe('results', () => {
  it('names the winner and how it went for the local rider', () => {
    const view = createResultsView();
    computeResultsView(view, results(TEAM_EMBER), 1);
    expect(view.winner).toBe('ember');
    expect(view.title).toBe('Ember Order');
    expect(view.overline).toBe('Victory');
    expect(view.localTeam).toBe(TEAM_EMBER);
    computeResultsView(view, results(TEAM_EMBER), 2);
    expect(view.overline).toBe('Defeat');
    // A watcher is on neither side.
    computeResultsView(view, results(TEAM_FROST), 99);
    expect(view.winner).toBe('frost');
    expect(view.title).toBe('Frost Order');
    expect(view.localTeam).toBeNull();
    expect(view.overline).not.toMatch(/Victory|Defeat/);
  });

  it('calls a draw a draw', () => {
    const view = computeResultsView(createResultsView(), results('draw'), 1);
    expect(view.winner).toBe('draw');
    expect(view.title).toBe('Draw');
    expect(view.overline).not.toMatch(/Victory|Defeat/);
    // The awards are still given.
    expect(view.awards.every((award) => award.shown)).toBe(true);
  });

  it('fills each award from the scoreboard row of its rider', () => {
    const view = computeResultsView(createResultsView(), results(TEAM_EMBER), 2);
    const mvp = view.awards[AWARD_MVP];
    const takedowns = view.awards[AWARD_TAKEDOWNS];
    const damage = view.awards[AWARD_DAMAGE];
    expect(mvp).toMatchObject({ shown: true, name: 'Aman', team: TEAM_EMBER, isLocal: false });
    expect(mvp?.value).toBe('9 / 4 / 6');
    expect(mvp?.detail).toContain('2140');
    expect(takedowns).toMatchObject({ shown: true, name: 'Kestrel', value: '11', isLocal: true });
    expect(damage).toMatchObject({ shown: true, name: 'Miro', value: '2410', unit: 'damage' });
    // Singular where it is one.
    expect(damage?.detail).toContain('1 takedown ');
  });

  it('lets one rider hold several awards', () => {
    const state = results(TEAM_FROST, { mvpId: 2, mostTakedownsId: 2, mostDamageId: 2 });
    const view = computeResultsView(createResultsView(), state, 1);
    expect(view.awards.map((award) => award.name)).toEqual(['Kestrel', 'Kestrel', 'Kestrel']);
    expect(view.awards.every((award) => award.shown)).toBe(true);
    expect(awardMarks(state, 2)).toBe('MVP · Takedowns · Damage');
    expect(awardMarks(state, 1)).toBe('');
  });

  it('shows no card for an award nobody earned', () => {
    const state = results(TEAM_EMBER, { mvpId: NO_PLAYER, mostDamageId: 77 });
    const view = computeResultsView(createResultsView(), state, 1);
    expect(view.awards[AWARD_MVP]?.shown).toBe(false);
    expect(view.awards[AWARD_TAKEDOWNS]?.shown).toBe(true);
    // A rider who is not in the table (left before the end) gets no card either.
    expect(view.awards[AWARD_DAMAGE]?.shown).toBe(false);
    expect(awardMarks(state, NO_PLAYER)).toBe('');
    expect(awardMarks(state, 2)).toBe('Takedowns');
  });

  it('forgets the previous match when the view is refilled', () => {
    const view = computeResultsView(createResultsView(), results(TEAM_EMBER), 1);
    computeResultsView(view, results('draw', { mvpId: NO_PLAYER }), 1);
    expect(view.awards[AWARD_MVP]).toMatchObject({ shown: false, name: '', value: '' });
  });

  it('reveals the banner, then the awards, then the table', () => {
    expect(revealStage(0, false)).toBe(0);
    expect(revealStage(1, false)).toBe(REVEAL_BANNER);
    expect(revealStage(4.9, false)).toBe(REVEAL_BANNER);
    expect(revealStage(5, false)).toBe(REVEAL_FIRST_AWARD);
    expect(revealStage(7.5, false)).toBe(REVEAL_ALL - 1);
    expect(revealStage(60, false)).toBe(REVEAL_ALL);
    // The awards arrive in the 5 to 8 s window the podium landings take.
    expect(REVEAL_TIMES_S[REVEAL_FIRST_AWARD - 1]).toBeGreaterThanOrEqual(5);
    expect(REVEAL_TIMES_S[REVEAL_ALL - 2]).toBeLessThanOrEqual(8);
    let last = 0;
    for (let t = 0; t < 12; t += 0.1) {
      const stage = revealStage(t, false);
      expect(stage).toBeGreaterThanOrEqual(last);
      last = stage;
    }
  });

  it('shows everything at once with reduced motion, and never hides on a clock jump', () => {
    expect(revealStage(0, true)).toBe(REVEAL_ALL);
    expect(revealStage(-3, false)).toBe(REVEAL_ALL);
    expect(revealStage(Number.NaN, false)).toBe(REVEAL_ALL);
  });
});

describe('fade and loading', () => {
  it('draws no fade when the field is absent or zero', () => {
    expect(fadeStep(undefined)).toBe(0);
    expect(fadeStep(0)).toBe(0);
    expect(fadeStep(-0.5)).toBe(0);
    expect(fadeStep(Number.NaN)).toBe(0);
  });

  it('follows the state from barely there to solid', () => {
    expect(fadeStep(0.5)).toBe(FADE_STEPS / 2);
    expect(fadeStep(1)).toBe(FADE_STEPS);
    expect(fadeStep(3)).toBe(FADE_STEPS);
    // Started is never nothing; unfinished is never solid.
    expect(fadeStep(0.0001)).toBe(1);
    expect(fadeStep(0.9999)).toBe(FADE_STEPS - 1);
  });

  it('shows loading at once and at full strength', () => {
    const gate = createLoadingGate();
    expect(gate.visible).toBe(false);
    updateLoadingGate(gate, true, 1000);
    expect(gate.visible).toBe(true);
    expect(gate.opacityStep).toBe(LOADING_OPACITY_STEPS);
  });

  it('never flashes: a one-frame load stays up for the minimum time, then fades', () => {
    const gate = createLoadingGate();
    updateLoadingGate(gate, true, 1000);
    updateLoadingGate(gate, false, 1016);
    expect(gate.visible).toBe(true);
    expect(gate.opacityStep).toBe(LOADING_OPACITY_STEPS);
    updateLoadingGate(gate, false, 1000 + LOADING_MIN_VISIBLE_MS);
    expect(gate.opacityStep).toBe(LOADING_OPACITY_STEPS);
    updateLoadingGate(gate, false, 1000 + LOADING_MIN_VISIBLE_MS + LOADING_FADE_OUT_MS / 2);
    expect(gate.visible).toBe(true);
    expect(gate.opacityStep).toBeGreaterThan(0);
    expect(gate.opacityStep).toBeLessThan(LOADING_OPACITY_STEPS);
    updateLoadingGate(gate, false, 1000 + LOADING_MIN_VISIBLE_MS + LOADING_FADE_OUT_MS);
    expect(gate.visible).toBe(false);
    expect(gate.opacityStep).toBe(0);
  });

  it('fades from the moment a long load ends', () => {
    const gate = createLoadingGate();
    updateLoadingGate(gate, true, 0);
    updateLoadingGate(gate, true, 5000);
    updateLoadingGate(gate, false, 5000);
    expect(gate.opacityStep).toBe(LOADING_OPACITY_STEPS);
    updateLoadingGate(gate, false, 5000 + LOADING_FADE_OUT_MS - 1);
    expect(gate.visible).toBe(true);
    updateLoadingGate(gate, false, 5000 + LOADING_FADE_OUT_MS);
    expect(gate.visible).toBe(false);
  });

  it('comes back to full when loading is asked for again mid-fade', () => {
    const gate = createLoadingGate();
    updateLoadingGate(gate, true, 0);
    updateLoadingGate(gate, false, 2000);
    updateLoadingGate(gate, false, 2000 + LOADING_FADE_OUT_MS / 2);
    expect(gate.opacityStep).toBeLessThan(LOADING_OPACITY_STEPS);
    updateLoadingGate(gate, true, 2200);
    expect(gate.visible).toBe(true);
    expect(gate.opacityStep).toBe(LOADING_OPACITY_STEPS);
  });

  it('stays down while nobody asks for it', () => {
    const gate = createLoadingGate();
    updateLoadingGate(gate, false, 0);
    updateLoadingGate(gate, false, 99999);
    expect(gate.visible).toBe(false);
  });

  it('rounds progress to a whole percent', () => {
    expect(loadingPercent(0.4)).toBe(40);
    expect(loadingPercent(0.996)).toBe(100);
    expect(loadingPercent(1.5)).toBe(100);
    expect(loadingPercent(-1)).toBe(0);
    expect(loadingPercent(Number.NaN)).toBe(0);
    expect(loadingPercent(undefined)).toBe(0);
  });
});
