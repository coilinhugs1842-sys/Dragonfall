/**
 * The Phase 5 screens through the real `createUi` (T-5.2 .. T-5.6), on the small fake DOM in
 * `fake-dom.ts`: which layout a state gets, what a click or a key sends back, and that a frame
 * with nothing new writes nothing to the page.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_PLAYER, TEAM_EMBER, TEAM_FROST } from '../../src/shared/constants';
import type { LobbySide, PlayerId } from '../../src/shared/constants';
import { DEFAULT_HOST_SETTINGS } from '../../src/shared/lobby';
import type { LobbyPhase, LobbyPlayer, LobbyState } from '../../src/shared/lobby';
import { MODES } from '../../src/shared/match';
import type { MatchPhase, MatchWinner } from '../../src/shared/match';
import { DEFAULT_SETTINGS } from '../../src/shared/ui';
import type { LobbyPlate, ResultsState, ScoreboardRow, UiIntent, UiState } from '../../src/shared/ui';
import { createUi } from '../../src/ui';
import type { Ui } from '../../src/ui';
import { createHudState } from '../../src/ui/hud';
import type { MutableHudState } from '../../src/ui/hud';
import { UNIT_STRINGS } from '../../src/ui/hud/hud-model';
import {
  PLATE_PERCENT_STRINGS,
  PLATE_POOL_SIZE,
  PLATE_POSITION_STEPS,
} from '../../src/ui/view-model/aerie-view';
import {
  LOADING_FADE_OUT_MS,
  LOADING_MIN_VISIBLE_MS,
} from '../../src/ui/view-model/cinematic';
import { REVEAL_TIMES_S } from '../../src/ui/view-model/results-view';
import type { FakeElement } from './fake-dom';
import { createUiRoot, installFakeDom, pressKey, resetWrites, writeCount } from './fake-dom';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const LOCAL_ID: PlayerId = 0;

function member(id: PlayerId, name: string, side: LobbySide, perch: number): LobbyPlayer {
  return {
    id,
    name,
    side,
    perch,
    classId: 'talon',
    ready: id !== 2,
    isHost: id === LOCAL_ID,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: id === 3,
  };
}

function lobbyState(phase: LobbyPhase = 'lobby'): LobbyState {
  return {
    roomCode: 'K7WQD',
    phase,
    hostId: LOCAL_ID,
    players: [
      member(0, 'Aman', TEAM_EMBER, 0),
      member(1, 'Kestrel', TEAM_FROST, 0),
      member(2, 'Miro', TEAM_EMBER, 1),
      member(3, 'Ashka', TEAM_FROST, 1),
      member(9, 'Oriel', 'spectator', -1),
    ],
    settings: DEFAULT_HOST_SETTINGS,
  };
}

/** A lobby state as `src/game` built it before Phase 5: none of the new optional fields. */
function baseState(extra?: Partial<UiState>): Mutable<UiState> {
  return {
    screen: 'lobby',
    connection: {
      status: 'connected',
      isHost: true,
      localPlayerId: LOCAL_ID,
      pingMs: 0,
      error: null,
    },
    settings: DEFAULT_SETTINGS,
    lobby: lobbyState(),
    loading: null,
    hud: null,
    results: null,
    startBlocker: 'notAllReady',
    ...extra,
  };
}

function matchHud(phase: MatchPhase): MutableHudState {
  const hud = createHudState();
  hud.phase = phase;
  hud.localPlayerId = LOCAL_ID;
  hud.local = hud.localPool;
  return hud;
}

function matchState(hud: MutableHudState, extra?: Partial<UiState>): Mutable<UiState> {
  return baseState({ screen: 'match', hud, ...extra });
}

function plate(playerId: PlayerId, x: number, y: number, visible = true): Mutable<LobbyPlate> {
  return { playerId, x, y, scale: 1, visible };
}

function scoreRow(playerId: PlayerId, name: string, team: 0 | 1, takedowns: number): ScoreboardRow {
  return {
    playerId,
    name,
    team,
    classId: 'talon',
    takedowns,
    deaths: 2,
    damage: takedowns * 200,
    pingMs: 20,
    alive: true,
    assists: 1,
  };
}

function resultsState(winner: MatchWinner, extra?: Partial<ResultsState>): ResultsState {
  return {
    winner,
    scores: [12, 9],
    mvpId: 0,
    mostTakedownsId: 1,
    mostDamageId: 1,
    scoreboard: [
      scoreRow(0, 'Aman', TEAM_EMBER, 7),
      scoreRow(1, 'Kestrel', TEAM_FROST, 9),
      scoreRow(2, 'Miro', TEAM_EMBER, 3),
      scoreRow(3, 'Ashka', TEAM_FROST, 2),
    ],
    ...extra,
  };
}

describe('Phase 5 screens', () => {
  let uninstall: () => void = () => {};
  let root: FakeElement;
  let ui: Ui;
  let intents: UiIntent[] = [];
  let nowMs = 0;

  const one = (selector: string): FakeElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`no element matches ${selector}`);
    return found;
  };
  const all = (selector: string): FakeElement[] => root.querySelectorAll(selector);
  const attached = (selector: string): boolean => root.querySelector(selector) !== null;
  const rowOf = (playerId: PlayerId): FakeElement => one(`.dfu-slot[data-pid="${playerId}"]`);
  const lastIntent = (): UiIntent | undefined => intents[intents.length - 1];
  const shownCards = (): FakeElement[] => all('.dfa-plate-wrap').filter((wrap) => !wrap.hidden);

  beforeEach(() => {
    uninstall = installFakeDom();
    const page = createUiRoot();
    root = page.fake;
    intents = [];
    nowMs = 1000;
    ui = createUi(page.element, (intent) => intents.push(intent), {
      nameStore: { load: () => 'Aman', save: () => undefined },
      now: () => nowMs,
    });
  });

  afterEach(() => {
    ui.dispose();
    uninstall();
  });

  describe('lobby layout (T-5.3)', () => {
    it('keeps the flat panel when the aerie field is absent or false', () => {
      for (const state of [baseState(), baseState({ aerie: false })]) {
        ui.update(state);
        const lobby = one('.dfu-lobby');
        expect(lobby.hidden).toBe(false);
        expect(lobby.children.map((child) => child.className)).toEqual([
          'dfu-lobby-main',
          'dfu-panel dfu-rules',
        ]);
        expect(lobby.classList.contains('df-interactive')).toBe(true);
        expect(attached('.dfa-top')).toBe(false);
        expect(attached('.dfa-dock')).toBe(false);
        expect(attached('.dfa-plates')).toBe(false);
        // Start and its note are where they were: at the foot of the rules column.
        expect(one('.dfu-start').children).toHaveLength(2);
      }
    });

    it('docks the rosters at the sides and the controls along the edges in the aerie', () => {
      ui.update(baseState({ aerie: true }));
      const lobby = one('.dfu-lobby');
      expect(lobby.dataset['layout']).toBe('aerie');
      expect(lobby.children.map((child) => child.className.split(' ')[0])).toEqual([
        'dfu-panel',
        'dfa-dock',
        'dfa-dock',
        'dfa-plates',
        'dfu-btn',
        'dfa-notice',
        'dfu-panel',
      ]);
      // The frame lets the pointer through to the scene; only its panels take it.
      expect(lobby.classList.contains('df-interactive')).toBe(false);
      expect(attached('.dfu-lobby-main')).toBe(false);
      const ember = one('.dfu-team[data-team="ember"]');
      const frost = one('.dfu-team[data-team="frost"]');
      expect(ember.parentElement?.dataset['side']).toBe('ember');
      expect(frost.parentElement?.dataset['side']).toBe('frost');
      expect(one('.dfu-watchers').parentElement?.dataset['side']).toBe('ember');
      expect(one('.dfu-code').closest('.dfa-top')).not.toBeNull();
      expect(one('button[data-act="leave"]').closest('.dfa-top')).not.toBeNull();
      expect(one('.dfu-classes').closest('.dfa-bottom')).not.toBeNull();
      expect(one('button[data-act="ready"]').closest('.dfa-bottom')).not.toBeNull();
      expect(one('button[data-act="start"]').closest('.dfa-bottom')).not.toBeNull();
      // The host panel is a drawer, closed until asked for.
      expect(one('.dfu-rules').closest('.dfa-drawer')).not.toBeNull();
      expect(one('.dfa-drawer').hidden).toBe(true);
    });

    it('moves the same controls back when the aerie goes away', () => {
      ui.update(baseState({ aerie: true }));
      const ready = one('button[data-act="ready"]');
      const emberTeam = one('.dfu-team[data-team="ember"]');
      ui.update(baseState());
      expect(one('.dfu-lobby').dataset['layout']).toBe('flat');
      expect(attached('.dfa-top')).toBe(false);
      expect(one('button[data-act="ready"]')).toBe(ready);
      expect(one('.dfu-team[data-team="ember"]')).toBe(emberTeam);
      expect(emberTeam.parentElement?.className).toBe('dfu-teams');
      expect(one('.dfu-lobby').classList.contains('df-interactive')).toBe(true);
      expect(one('.dfu-rules').parentElement).toBe(one('.dfu-lobby'));
    });

    it('opens and closes the rules drawer, with Escape too', () => {
      ui.update(baseState({ aerie: true }));
      const toggle = one('button[data-act="rulesToggle"]');
      toggle.click();
      expect(one('.dfa-drawer').hidden).toBe(false);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const escape = pressKey('Escape', 'Escape');
      expect(escape.defaultPrevented).toBe(true);
      expect(one('.dfa-drawer').hidden).toBe(true);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      // Closing the drawer is not "leave the close-up".
      expect(intents).toEqual([]);
    });

    it('shows modes that are not built yet as "coming soon" until their flag turns true', () => {
      ui.update(baseState({ aerie: true }));
      const unavailable = Object.values(MODES).find((mode) => !mode.available);
      if (unavailable === undefined) return;
      const pick = one(`button[data-pick="${unavailable.id}"]`);
      expect(pick.disabled).toBe(true);
      expect(pick.dataset['soon']).toBe('1');
      expect(pick.getAttribute('aria-label')).toContain('coming soon');
      pick.click();
      expect(intents).toEqual([]);

      const flag = unavailable as { available: boolean };
      flag.available = true;
      try {
        // Nothing but the table changed; the next lobby refresh picks it up.
        ui.update(baseState({ aerie: true }));
        expect(pick.disabled).toBe(false);
        expect(pick.dataset['soon']).toBe('0');
        pick.click();
        expect(lastIntent()).toEqual({ type: 'host.setMode', mode: unavailable.id });
      } finally {
        flag.available = false;
      }
    });

    it('tells the host why Start is unavailable', () => {
      ui.update(baseState({ aerie: true }));
      expect(one('button[data-act="start"]').disabled).toBe(true);
      expect(one('.dfu-start-note').textContent).not.toBe('');
      ui.update(baseState({ aerie: true, startBlocker: null }));
      expect(one('button[data-act="start"]').disabled).toBe(false);
      one('button[data-act="start"]').click();
      expect(lastIntent()).toEqual({ type: 'host.start' });
    });

    it('gives way to "Taking off" while the launch plays', () => {
      ui.update(baseState({ aerie: true, lobby: lobbyState('starting') }));
      expect(one('.dfa-bottom').hidden).toBe(true);
      expect(one('.dfa-notice').hidden).toBe(false);
      expect(one('.dfa-notice-text').textContent).toBe('Taking off');
      // Rows cannot be pressed during the take-off.
      const focus = rowOf(1).querySelector('.dfu-slot-focus');
      expect(focus?.disabled).toBe(true);
      focus?.click();
      expect(intents).toEqual([]);
      // Back in the room, the controls return.
      ui.update(baseState({ aerie: true }));
      expect(one('.dfa-bottom').hidden).toBe(false);
      expect(one('.dfa-notice').hidden).toBe(true);
    });
  });

  describe('close-up focus (T-5.3)', () => {
    it('asks for a rider on a row click and lets go on the second click', () => {
      const state = baseState({ aerie: true });
      ui.update(state);
      const focus = rowOf(3).querySelector('.dfu-slot-focus');
      focus?.click();
      expect(lastIntent()).toEqual({ type: 'lobby.focusPlayer', playerId: 3 });

      state.lobbyFocusId = 3;
      ui.update(state);
      expect(rowOf(3).dataset['focus']).toBe('1');
      expect(focus?.getAttribute('aria-pressed')).toBe('true');
      expect(rowOf(1).dataset['focus']).not.toBe('1');
      expect(one('.dfa-back').hidden).toBe(false);

      focus?.click();
      expect(lastIntent()).toEqual({ type: 'lobby.focusPlayer', playerId: null });
      // Another rider while one is focused: straight to them.
      rowOf(1).querySelector('.dfu-slot-focus')?.click();
      expect(lastIntent()).toEqual({ type: 'lobby.focusPlayer', playerId: 1 });
    });

    it('lets go with Escape and with the back control', () => {
      const state = baseState({ aerie: true, lobbyFocusId: 1 });
      ui.update(state);
      const escape = pressKey('Escape', 'Escape');
      expect(escape.defaultPrevented).toBe(true);
      expect(intents).toEqual([{ type: 'lobby.focusPlayer', playerId: null }]);
      one('.dfa-back').click();
      expect(intents).toHaveLength(2);
      expect(lastIntent()).toEqual({ type: 'lobby.focusPlayer', playerId: null });

      // Nobody focused: Escape has nothing to do here and the control is gone.
      state.lobbyFocusId = NO_PLAYER;
      ui.update(state);
      expect(one('.dfa-back').hidden).toBe(true);
      expect(pressKey('Escape', 'Escape').defaultPrevented).toBe(false);
      expect(intents).toHaveLength(2);
    });

    it('focuses from a name card too', () => {
      const state = baseState({
        aerie: true,
        lobbyPlates: [plate(1, 0.6, 0.5)],
        lobbyPlateCount: 1,
      });
      ui.update(state);
      one('.dfa-plate[data-pid="1"]').click();
      expect(lastIntent()).toEqual({ type: 'lobby.focusPlayer', playerId: 1 });
      state.lobbyFocusId = 1;
      ui.update(state);
      expect(one('.dfa-plate[data-pid="1"]').dataset['focus']).toBe('1');
      one('.dfa-plate[data-pid="1"]').click();
      expect(lastIntent()).toEqual({ type: 'lobby.focusPlayer', playerId: null });
    });

    it('has no close-up in the flat lobby', () => {
      ui.update(baseState({ lobbyFocusId: 1 }));
      expect(rowOf(1).dataset['focus']).not.toBe('1');
      rowOf(1).querySelector('.dfu-slot-focus')?.click();
      expect(pressKey('Escape', 'Escape').defaultPrevented).toBe(false);
      expect(intents).toEqual([]);
    });
  });

  describe('name cards (T-5.2)', () => {
    it('draws the first lobbyPlateCount plates from a fixed pool', () => {
      const plates = [plate(0, 0.25, 0.5), plate(1, 0.75, 0.4), plate(2, 0.5, 0.6), plate(3, 0.9, 0.9)];
      const state = baseState({ aerie: true, lobbyPlates: plates, lobbyPlateCount: 3 });
      ui.update(state);
      const pool = all('.dfa-plate-wrap');
      expect(pool).toHaveLength(PLATE_POOL_SIZE);
      expect(shownCards()).toHaveLength(3);
      expect(pool[3]?.hidden).toBe(true);

      const first = pool[0];
      expect(first?.style.getPropertyValue('--dfa-x')).toBe('25%');
      expect(first?.style.getPropertyValue('--dfa-y')).toBe('50%');
      expect(first?.style.getPropertyValue('--dfa-x')).toBe(
        PLATE_PERCENT_STRINGS[PLATE_POSITION_STEPS / 4],
      );
      const card = first?.querySelector('.dfa-plate');
      expect(card?.querySelector('.dfa-plate-name')?.textContent).toBe('Aman');
      expect(card?.querySelector('.dfa-plate-class')?.textContent).toBe('Talon');
      expect(card?.dataset['team']).toBe('ember');
      // The host counts as ready; rider 2 has not readied up; rider 1 flies for Frost.
      expect(card?.dataset['state']).toBe('ready');
      expect(pool[1]?.querySelector('.dfa-plate')?.dataset['team']).toBe('frost');
      expect(pool[2]?.querySelector('.dfa-plate')?.dataset['state']).toBe('waiting');
      // Host and "you" marks on the local host's card only.
      const badges = (wrap: FakeElement | undefined): string[] =>
        (wrap?.querySelectorAll('.dfu-badge') ?? [])
          .filter((badge) => !badge.hidden)
          .map((badge) => badge.textContent);
      expect(badges(pool[0])).toEqual(['Host', 'You']);
      expect(badges(pool[1])).toEqual([]);

      // Fewer plates, then none: the same nodes, hidden.
      state.lobbyPlateCount = 1;
      ui.update(state);
      expect(shownCards()).toHaveLength(1);
      state.lobbyPlateCount = 0;
      ui.update(state);
      expect(shownCards()).toHaveLength(0);
      expect(all('.dfa-plate-wrap')).toEqual(pool);
    });

    it('hides a card that is off screen or belongs to nobody on a terrace', () => {
      const plates = [plate(0, 0.3, 0.5, false), plate(9, 0.5, 0.5), plate(77, 0.6, 0.5), plate(3, 0.7, 0.5)];
      ui.update(baseState({ aerie: true, lobbyPlates: plates, lobbyPlateCount: 4 }));
      const pool = all('.dfa-plate-wrap');
      // Not visible; a watcher; an id the lobby does not know; a bot on Frost.
      expect(pool.slice(0, 4).map((wrap) => wrap.hidden)).toEqual([true, true, true, false]);
      const bot = pool[3]?.querySelectorAll('.dfu-badge').filter((badge) => !badge.hidden);
      expect(bot?.map((badge) => badge.textContent)).toEqual(['Bot']);
    });

    it('moves a card with one write and leaves the rest of the page alone', () => {
      const plates = [plate(0, 0.25, 0.5), plate(1, 0.75, 0.4)];
      const state = baseState({ aerie: true, lobbyPlates: plates, lobbyPlateCount: 2 });
      ui.update(state);
      ui.update(state);

      resetWrites();
      ui.update(state);
      expect(writeCount()).toBe(0);

      const moved = plates[1];
      if (moved !== undefined) moved.x = 0.7;
      resetWrites();
      ui.update(state);
      expect(writeCount()).toBe(1);
      expect(all('.dfa-plate-wrap')[1]?.style.getPropertyValue('--dfa-x')).toBe('70%');

      // A move smaller than one step of the table is not written at all.
      if (moved !== undefined) moved.x = 0.70001;
      resetWrites();
      ui.update(state);
      expect(writeCount()).toBe(0);
    });

    it('rewrites a card when the lobby changes, not otherwise', () => {
      const state = baseState({ aerie: true, lobbyPlates: [plate(2, 0.4, 0.5)], lobbyPlateCount: 1 });
      ui.update(state);
      const card = one('.dfa-plate[data-pid="2"]');
      expect(card.dataset['state']).toBe('waiting');
      const before = lobbyState();
      state.lobby = {
        ...before,
        players: before.players.map((player) =>
          player.id === 2 ? { ...player, ready: true, name: 'Miro the Bold' } : player,
        ),
      };
      ui.update(state);
      expect(card.dataset['state']).toBe('ready');
      expect(card.querySelector('.dfa-plate-name')?.textContent).toBe('Miro the Bold');
    });

    it('draws no cards in the flat lobby even if plates are given', () => {
      ui.update(baseState({ lobbyPlates: [plate(0, 0.5, 0.5)], lobbyPlateCount: 1 }));
      expect(attached('.dfa-plates')).toBe(false);
    });
  });

  describe('match intro (T-5.4)', () => {
    it('shows the title card at the state\'s opacity and hides the combat HUD', () => {
      const hud = matchHud('intro');
      hud.introCard = hud.introCardPool;
      hud.introCardPool.mapName = 'Shattered Spires';
      hud.introCardPool.modeName = 'Skirmish';
      hud.introCardPool.opacity = 0.5;
      const state = matchState(hud);
      ui.update(state);
      const card = one('.dfh-intro');
      expect(card.hidden).toBe(false);
      expect(card.style.getPropertyValue('opacity')).toBe('0.5');
      expect(one('.dfh-intro-map').textContent).toBe('Shattered Spires');
      expect(one('.dfh-intro-mode').textContent).toBe('Skirmish');
      expect(one('.dfh-root').dataset['chrome']).toBe('cine');
      // The connection chip stays.
      expect(one('.dfu-chip').hidden).toBe(false);

      hud.introCardPool.opacity = 1;
      ui.update(state);
      expect(card.style.getPropertyValue('opacity')).toBe(UNIT_STRINGS[UNIT_STRINGS.length - 1]);
      hud.introCardPool.opacity = 0;
      ui.update(state);
      expect(card.hidden).toBe(true);

      // The 3-2-1 that follows gets the gauges back.
      hud.phase = 'countdown';
      hud.countdown = 3;
      hud.introCard = null;
      ui.update(state);
      expect(one('.dfh-root').dataset['chrome']).toBe('full');
      expect(card.hidden).toBe(true);
    });

    it('draws no card when the field is absent, as before', () => {
      const hud = matchHud('playing');
      ui.update(matchState(hud));
      expect(one('.dfh-intro').hidden).toBe(true);
      expect(one('.dfh-skip').hidden).toBe(true);
      // Never switched to the cinematic look, so nothing about the HUD's frame changed.
      expect(one('.dfh-root').dataset['chrome']).toBeUndefined();
    });

    it('offers the skip only when the client may skip, and sends it once', () => {
      const hud = matchHud('intro');
      const state = matchState(hud);
      ui.update(state);
      expect(one('.dfh-skip').hidden).toBe(true);
      expect(pressKey(' ', 'Space').defaultPrevented).toBe(false);
      expect(intents).toEqual([]);

      hud.canSkipIntro = true;
      ui.update(state);
      expect(one('.dfh-skip').hidden).toBe(false);
      const space = pressKey(' ', 'Space');
      expect(space.defaultPrevented).toBe(true);
      expect(intents).toEqual([{ type: 'match.skipIntro' }]);
      pressKey('Enter', 'Enter');
      pressKey(' ', 'Space');
      expect(intents).toHaveLength(1);
    });

    it('accepts Enter, ignores key repeat, and re-arms for the next match', () => {
      const hud = matchHud('intro');
      hud.canSkipIntro = true;
      const state = matchState(hud);
      ui.update(state);
      pressKey('Enter', 'Enter', true);
      expect(intents).toEqual([]);
      pressKey('Enter', 'Enter');
      expect(intents).toEqual([{ type: 'match.skipIntro' }]);

      hud.phase = 'playing';
      ui.update(state);
      pressKey(' ', 'Space');
      expect(intents).toHaveLength(1);
      hud.phase = 'intro';
      ui.update(state);
      pressKey(' ', 'Space');
      expect(intents).toHaveLength(2);
    });

    it('does not skip while the escape menu or the settings are open', () => {
      const hud = matchHud('intro');
      hud.canSkipIntro = true;
      const state = matchState(hud, { pauseMenuOpen: true });
      ui.update(state);
      pressKey(' ', 'Space');
      expect(intents).toEqual([]);
      state.pauseMenuOpen = false;
      state.settingsOpen = true;
      ui.update(state);
      pressKey('Enter', 'Enter');
      expect(intents).toEqual([]);
      state.settingsOpen = false;
      ui.update(state);
      pressKey(' ', 'Space');
      expect(intents).toEqual([{ type: 'match.skipIntro' }]);
    });
  });

  describe('results (T-5.5)', () => {
    const cards = (): FakeElement[] => all('.dfr-award');
    const on = (node: FakeElement | undefined): boolean => node?.dataset['on'] === '1';

    it('frames the podium: banner, three awards, the table with the local row marked', () => {
      const hud = matchHud('results');
      const state = matchState(hud, { results: resultsState(TEAM_EMBER) });
      ui.update(state);
      const panel = one('.dfu-results');
      expect(panel.hidden).toBe(false);
      expect(panel.dataset['winner']).toBe('ember');
      expect(one('.dfr-title').textContent).toBe('Ember Order');
      expect(one('.dfr-overline').textContent).toBe('Victory');
      // One rider holds two awards: both cards name them.
      expect(cards().map((card) => card.hidden)).toEqual([false, false, false]);
      expect(cards().map((card) => card.querySelector('.dfr-award-name')?.textContent)).toEqual([
        'Aman',
        'Kestrel',
        'Kestrel',
      ]);
      expect(cards().map((card) => card.dataset['team'])).toEqual(['ember', 'frost', 'frost']);
      const mine = all('.dfr-row').filter((row) => row.dataset['me'] === '1' && !row.hidden);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.querySelector('.dfr-row-name')?.textContent).toBe('Aman');
      expect(mine[0]?.querySelector('.dfr-row-marks')?.textContent).toBe('MVP');
      expect(all('.dfr-row').filter((row) => !row.hidden)).toHaveLength(4);
      // The combat HUD is out of the way.
      expect(one('.dfh-root').dataset['chrome']).toBe('cine');
    });

    it('shows no card for an award nobody earned, and a draw as a draw', () => {
      const hud = matchHud('results');
      const state = matchState(hud, { results: resultsState('draw', { mvpId: NO_PLAYER }) });
      ui.update(state);
      expect(one('.dfu-results').dataset['winner']).toBe('draw');
      expect(one('.dfr-title').textContent).toBe('Draw');
      expect(cards().map((card) => card.hidden)).toEqual([true, false, false]);
    });

    it('reveals the banner, then the awards, then the table, on its own clock', () => {
      const hud = matchHud('results');
      const state = matchState(hud, { results: resultsState(TEAM_FROST) });
      const start = nowMs;
      const at = (seconds: number): void => {
        nowMs = start + seconds * 1000;
        ui.update(state);
      };
      at(0);
      expect(on(one('.dfr-banner'))).toBe(false);
      at(1);
      expect(on(one('.dfr-banner'))).toBe(true);
      expect(cards().map(on)).toEqual([false, false, false]);
      expect(on(one('.dfr-table'))).toBe(false);
      at((REVEAL_TIMES_S[1] ?? 0) + 0.1);
      expect(cards().map(on)).toEqual([true, false, false]);
      at((REVEAL_TIMES_S[3] ?? 0) + 0.1);
      expect(cards().map(on)).toEqual([true, true, true]);
      expect(on(one('.dfr-table'))).toBe(false);
      at(20);
      expect(on(one('.dfr-table'))).toBe(true);

      // A frame with nothing new writes nothing.
      resetWrites();
      at(21);
      expect(writeCount()).toBe(0);

      // The next match's results start from an empty frame again.
      state.results = null;
      at(30);
      expect(one('.dfu-results').hidden).toBe(true);
      state.results = resultsState(TEAM_EMBER);
      at(40);
      expect(on(one('.dfr-banner'))).toBe(false);
      at(41);
      expect(on(one('.dfr-banner'))).toBe(true);
      expect(on(one('.dfr-table'))).toBe(false);
    });

    it('shows everything at once with reduced motion', () => {
      const hud = matchHud('results');
      ui.update(
        matchState(hud, {
          results: resultsState(TEAM_EMBER),
          settings: { ...DEFAULT_SETTINGS, reduceMotion: true },
        }),
      );
      expect(on(one('.dfr-banner'))).toBe(true);
      expect(cards().map(on)).toEqual([true, true, true]);
      expect(on(one('.dfr-table'))).toBe(true);
    });
  });

  describe('fade and loading (T-5.6)', () => {
    it('draws the fade straight from the state and nothing when it is absent', () => {
      const state = baseState();
      ui.update(state);
      const fade = one('.dfu-fade');
      expect(fade.hidden).toBe(true);
      state.fade = 0.5;
      ui.update(state);
      expect(fade.hidden).toBe(false);
      expect(fade.style.getPropertyValue('opacity')).toBe('0.5');
      state.fade = 1;
      ui.update(state);
      expect(fade.style.getPropertyValue('opacity')).toBe('1');
      state.fade = 0;
      ui.update(state);
      expect(fade.hidden).toBe(true);
    });

    it('stacks the fade over the page and under the escape menu', () => {
      ui.update(baseState());
      const layers = one('.dfu-root').children.map((child) => child.className.split(' ')[0]);
      const fade = layers.indexOf('dfu-fade');
      expect(fade).toBeGreaterThan(layers.indexOf('dfu-base'));
      expect(layers.indexOf('dfu-screen')).toBeGreaterThan(fade);
      // Everything after the loading layer is a dialog (escape menu, session notice).
      expect(layers.length - 1).toBeGreaterThan(layers.indexOf('dfu-screen'));
    });

    it('shows loading over a match with its label and progress', () => {
      const hud = matchHud('playing');
      const state = matchState(hud, { loading: { progress: 0.4, label: 'Charting the spires…' } });
      ui.update(state);
      const loading = one('.dfu-loading');
      expect(loading.hidden).toBe(false);
      expect(one('.dfu-loading-label').textContent).toBe('Charting the spires…');
      expect(one('.dfu-progress').getAttribute('aria-valuenow')).toBe('40');
      expect(one('.dfu-progress-fill').style.getPropertyValue('transform')).toBe('scaleX(0.4)');
    });

    it('does not flash for a single frame', () => {
      const state = baseState({ screen: 'match', hud: matchHud('playing') });
      state.loading = { progress: 1, label: '' };
      ui.update(state);
      const loading = one('.dfu-loading');
      expect(loading.hidden).toBe(false);
      // Gone from the state on the very next frame: still on screen.
      state.loading = null;
      nowMs += 16;
      ui.update(state);
      expect(loading.hidden).toBe(false);
      nowMs += LOADING_MIN_VISIBLE_MS;
      ui.update(state);
      expect(loading.hidden).toBe(false);
      nowMs += LOADING_FADE_OUT_MS;
      ui.update(state);
      expect(loading.hidden).toBe(true);
    });

    it('is the whole screen on the loading screen', () => {
      ui.update(baseState({ screen: 'loading', lobby: null }));
      expect(one('.dfu-loading').hidden).toBe(false);
      expect(one('.dfu-loading-label').textContent).not.toBe('');
    });
  });

  describe('a state without the Phase 5 fields', () => {
    it('renders the lobby with no cinematic layer showing', () => {
      ui.update(baseState());
      expect(one('.dfu-lobby').hidden).toBe(false);
      expect(one('.dfu-fade').hidden).toBe(true);
      expect(one('.dfu-loading').hidden).toBe(true);
      expect(one('.dfu-results').hidden).toBe(true);
      expect(one('.dfh-intro').hidden).toBe(true);
      expect(attached('.dfa-plates')).toBe(false);
    });

    it('writes nothing on a frame whose state did not change', () => {
      const lobby = baseState();
      ui.update(lobby);
      ui.update(lobby);
      resetWrites();
      ui.update(lobby);
      expect(writeCount()).toBe(0);

      const match = matchState(matchHud('playing'));
      ui.update(match);
      ui.update(match);
      resetWrites();
      ui.update(match);
      expect(writeCount()).toBe(0);
    });

    it('still sends the lobby intents it always sent', () => {
      ui.update(baseState());
      one('button[data-act="ready"]').click();
      // The local rider is ready in this state, so the button takes it back.
      expect(lastIntent()).toEqual({ type: 'lobby.ready', ready: false });
      one('button[data-act="leave"]').click();
      expect(lastIntent()).toEqual({ type: 'lobby.leave' });
      one('button[data-act="teamSize"][data-size="3"]').click();
      expect(lastIntent()).toEqual({ type: 'host.setTeamSize', teamSize: 3 });
    });
  });
});
