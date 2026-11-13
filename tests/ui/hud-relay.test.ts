/**
 * Ember Relay on the HUD (T-6.3): the wording and ordering rules (hud-model), the pooled state
 * (hud-state), and the HUD itself on the fake DOM: the shard strip, the announcement, the carry
 * call-out, feed lines, compass marks and the captures column, all without touching the page
 * on a frame where nothing changed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BURNING,
  DRAGON_FLAG_SLOWED,
  HUD_COMPASS_MARKERS,
  NO_PLAYER,
  OBJECTIVE_KINDS,
  SHARD_CARRIED,
  SHARD_DROPPED,
  SHARD_HOME,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../src/shared';
import type { HudState, ScoreboardRow, TeamId } from '../../src/shared';
import { createHud, createHudState, pushKillfeed, pushShardEvent, resetHudState } from '../../src/ui/hud';
import type { Hud, MutableHudState } from '../../src/ui/hud';
import { ageHudState } from '../../src/ui/hud';
import { BRAZIER_SHAPE, OBJECTIVE_GLYPHS, SHARD_SHAPES } from '../../src/ui/hud/glyphs';
import {
  OPACITY_STEPS,
  RELAY_NOTICE_LIFE_S,
  relayNoticeGood,
  relayNoticeStep,
  relayNoticeText,
  scoreNoun,
  shardLine,
  shardStatusIndex,
  sortTeamRows,
} from '../../src/ui/hud/hud-model';
import { FakeElement, createUiRoot, installFakeDom, resetWrites, writeCount } from './fake-dom';

const SHARD_EVENTS = ['pickedUp', 'dropped', 'returned', 'captured'] as const;

describe('relay wording (hud-model)', () => {
  it('names the count of each mode', () => {
    expect(scoreNoun('emberRelay')).toBe('captures');
    expect(scoreNoun('skirmish')).toBe('takedowns');
    expect(scoreNoun('duel')).toBe('rounds');
  });

  it('has a feed line for every shard event of both teams, and all differ', () => {
    const lines = new Set<string>();
    for (const kind of SHARD_EVENTS) {
      for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
        const line = shardLine(kind, team);
        expect(line).toContain(team === TEAM_EMBER ? 'Ember' : 'Frost');
        lines.add(line);
      }
    }
    expect(lines.size).toBe(8);
    expect(shardLine('zoneTaken', TEAM_EMBER)).toBe('');
  });

  it('words the announcement for whoever reads it', () => {
    // Frost's shard is taken: Frost reads a warning, Ember good news, a spectator the facts.
    const frost = relayNoticeText('pickedUp', TEAM_FROST, TEAM_FROST);
    const ember = relayNoticeText('pickedUp', TEAM_FROST, TEAM_EMBER);
    const watcher = relayNoticeText('pickedUp', TEAM_FROST, null);
    expect(frost).toMatch(/^Your shard/);
    expect(ember).toMatch(/enemy shard/);
    expect(watcher).toBe('Frost shard taken');
    expect(new Set([frost, ember, watcher]).size).toBe(3);
    expect(relayNoticeGood('pickedUp', TEAM_FROST, TEAM_FROST)).toBe(false);
    expect(relayNoticeGood('pickedUp', TEAM_FROST, TEAM_EMBER)).toBe(true);
    expect(relayNoticeGood('pickedUp', TEAM_FROST, null)).toBeNull();
    // A capture is good for whoever is not the shard's owner; a return for the owner.
    expect(relayNoticeGood('captured', TEAM_EMBER, TEAM_FROST)).toBe(true);
    expect(relayNoticeGood('captured', TEAM_EMBER, TEAM_EMBER)).toBe(false);
    expect(relayNoticeGood('returned', TEAM_EMBER, TEAM_EMBER)).toBe(true);
    expect(relayNoticeGood('dropped', TEAM_EMBER, TEAM_FROST)).toBe(false);
    // Every sentence exists.
    for (const kind of SHARD_EVENTS) {
      for (const reader of [TEAM_EMBER, TEAM_FROST, null] as const) {
        expect(relayNoticeText(kind, TEAM_EMBER, reader).length).toBeGreaterThan(8);
      }
    }
  });

  it('shows an announcement for a few seconds, then fades and drops it', () => {
    expect(relayNoticeStep(null, 0)).toBe(0);
    expect(relayNoticeStep('zoneTaken', 0)).toBe(0);
    expect(relayNoticeStep('captured', 0)).toBe(OPACITY_STEPS);
    expect(relayNoticeStep('captured', RELAY_NOTICE_LIFE_S - 0.2)).toBeGreaterThan(0);
    expect(relayNoticeStep('captured', RELAY_NOTICE_LIFE_S - 0.2)).toBeLessThan(OPACITY_STEPS);
    expect(relayNoticeStep('captured', RELAY_NOTICE_LIFE_S)).toBe(0);
    expect(relayNoticeStep('captured', Infinity)).toBe(0);
    expect(relayNoticeStep('captured', Number.NaN)).toBe(0);
  });

  it('reads any status number as one of the three', () => {
    expect(shardStatusIndex(SHARD_HOME)).toBe(0);
    expect(shardStatusIndex(SHARD_CARRIED)).toBe(1);
    expect(shardStatusIndex(SHARD_DROPPED)).toBe(2);
    expect(shardStatusIndex(7)).toBe(0);
    expect(shardStatusIndex(Number.NaN)).toBe(0);
  });

  it('ranks captures above takedowns on the board, and changes nothing without them', () => {
    const row = (playerId: number, takedowns: number, captures?: number): ScoreboardRow => ({
      playerId,
      name: `P${playerId}`,
      team: TEAM_EMBER,
      classId: 'talon',
      takedowns,
      deaths: 0,
      damage: 0,
      pingMs: 0,
      alive: true,
      ...(captures === undefined ? {} : { captures }),
    });
    const order = [0, 0, 0];
    expect(sortTeamRows([row(1, 9, 0), row(2, 1, 2), row(3, 4, 1)], 3, TEAM_EMBER, order)).toBe(3);
    expect(order).toEqual([1, 2, 0]);
    expect(sortTeamRows([row(1, 2), row(2, 9), row(3, 4)], 3, TEAM_EMBER, order)).toBe(3);
    expect(order).toEqual([1, 2, 0]);
  });

  it('has a glyph for every objective kind and marks that tell the teams apart', () => {
    for (const kind of OBJECTIVE_KINDS) expect(OBJECTIVE_GLYPHS[kind].length).toBeGreaterThan(10);
    expect(new Set(Object.values(OBJECTIVE_GLYPHS)).size).toBe(OBJECTIVE_KINDS.length);
    // The team's shape is cut into the crystal: the same outline, a different hole.
    expect(SHARD_SHAPES.ember).not.toBe(SHARD_SHAPES.frost);
    expect(SHARD_SHAPES.ember.startsWith(SHARD_SHAPES.none.slice(0, -1))).toBe(true);
    expect(SHARD_SHAPES.frost.startsWith(SHARD_SHAPES.none.slice(0, -1))).toBe(true);
    expect(BRAZIER_SHAPE).not.toBe(SHARD_SHAPES.none);
  });
});

describe('relay state (hud-state)', () => {
  it('starts without a relay and with room for its markers', () => {
    const hud = createHudState();
    expect(hud.relay).toBeNull();
    expect(hud.relayPool.shards).toHaveLength(2);
    expect(hud.relayPool.noticeKind).toBeNull();
    expect(hud.compass).toHaveLength(HUD_COMPASS_MARKERS);
    // Four team mates, two shards, one brazier.
    expect(HUD_COMPASS_MARKERS).toBeGreaterThanOrEqual(7);
    expect(hud.scoreboard[0]?.captures).toBe(0);
  });

  it('a shard event is a feed line and the announcement; a takedown line is not', () => {
    const hud = createHudState();
    const line = pushShardEvent(hud, 'pickedUp', TEAM_FROST, 4, 'Aman', TEAM_EMBER);
    expect(line).toBe(hud.killfeed[0]);
    expect(hud.killfeedCount).toBe(1);
    expect(hud.killfeed[0]).toMatchObject({
      objective: 'pickedUp',
      killerId: 4,
      killerName: 'Aman',
      killerTeam: TEAM_EMBER,
      victimId: NO_PLAYER,
      victimTeam: TEAM_FROST,
      ageS: 0,
    });
    expect(hud.relayPool).toMatchObject({ noticeKind: 'pickedUp', noticeTeam: TEAM_FROST, noticeAgeS: 0 });

    // The pooled entry is reused by a takedown: the objective must not stick to it.
    for (let i = 0; i < hud.killfeed.length; i++) {
      pushKillfeed(hud, 1, 'A', TEAM_EMBER, 'talon', 2, 'B', TEAM_FROST, 'primary');
    }
    expect(hud.killfeed.every((entry) => entry.objective === null)).toBe(true);
  });

  it('ages the announcement with the frame and forgets it on a new match', () => {
    const hud = createHudState();
    pushShardEvent(hud, 'captured', TEAM_EMBER, NO_PLAYER, '', null);
    ageHudState(hud, 1.25);
    expect(hud.relayPool.noticeAgeS).toBeCloseTo(1.25, 9);
    ageHudState(hud, 100);
    const settled = hud.relayPool.noticeAgeS;
    ageHudState(hud, 100);
    // Past its life it stops counting (no creeping toward Infinity arithmetic every frame).
    expect(hud.relayPool.noticeAgeS).toBe(settled);

    hud.relay = hud.relayPool;
    hud.relayPool.carrying = true;
    hud.relayPool.shards[1].status = SHARD_DROPPED;
    hud.relayPool.shards[1].returnInS = 9;
    hud.relayPool.shards[0].carrierName = 'Somebody';
    resetHudState(hud);
    expect(hud.relay).toBeNull();
    expect(hud.relayPool).toEqual(createHudState().relayPool);
  });
});

// --- The HUD on the fake page ----------------------------------------------------------------------

const LOCAL_ID = 3;

describe('relay HUD (DOM)', () => {
  let uninstall: () => void = () => {};
  let root: FakeElement;
  let hud: Hud;
  let state: MutableHudState;
  let nowMs = 0;
  // The HUD hides with the `hidden` ATTRIBUTE (it also hides SVG nodes); the fake page only
  // models the property, so the attribute is tracked here.
  let hiddenNodes = new WeakSet<FakeElement>();
  const realSet = FakeElement.prototype.setAttribute;
  const realRemove = FakeElement.prototype.removeAttribute;

  const one = (selector: string): FakeElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`no element matches ${selector}`);
    return found;
  };
  const shown = (node: FakeElement): boolean => {
    for (let at: FakeElement | null = node; at !== null && at !== root; at = at.parentElement) {
      if (hiddenNodes.has(at)) return false;
    }
    return true;
  };
  const draw = (advanceMs = 200): void => {
    nowMs += advanceMs;
    hud.update(state as HudState, nowMs);
  };
  const shardCell = (team: TeamId): FakeElement =>
    one(team === TEAM_EMBER ? '.dfh-shard-ember' : '.dfh-shard-frost');
  const pathOf = (node: FakeElement): string =>
    node.querySelector('path')?.getAttribute('d') ?? '';

  function addRow(playerId: number, name: string, team: TeamId, captures: number): void {
    const row = state.scoreboard[state.scoreboardCount++];
    if (row === undefined) throw new Error('board full');
    row.playerId = playerId;
    row.name = name;
    row.team = team;
    row.captures = captures;
    row.takedowns = playerId;
  }

  beforeEach(() => {
    uninstall = installFakeDom();
    hiddenNodes = new WeakSet();
    FakeElement.prototype.setAttribute = function (name: string, value: string): void {
      if (name === 'hidden') hiddenNodes.add(this);
      realSet.call(this, name, value);
    };
    FakeElement.prototype.removeAttribute = function (name: string): void {
      if (name === 'hidden') hiddenNodes.delete(this);
      realRemove.call(this, name);
    };
    const page = createUiRoot();
    root = page.fake;
    hud = createHud(page.element, { listenForTab: false });
    nowMs = 1000;
    state = createHudState();
    state.mode = 'emberRelay';
    state.scoreLimit = 3;
    state.phase = 'playing';
    state.localPlayerId = LOCAL_ID;
    state.local = state.localPool;
    state.relay = state.relayPool;
    addRow(LOCAL_ID, 'Aman', TEAM_EMBER, 1);
    addRow(4, 'Miro', TEAM_EMBER, 0);
    addRow(7, 'Kestrel', TEAM_FROST, 2);
  });

  afterEach(() => {
    hud.dispose();
    FakeElement.prototype.setAttribute = realSet;
    FakeElement.prototype.removeAttribute = realRemove;
    uninstall();
  });

  it('is not drawn outside Ember Relay', () => {
    state.mode = 'skirmish';
    state.relay = null;
    draw();
    expect(shown(one('.dfh-relay'))).toBe(false);
    expect(shown(one('.dfh-notice'))).toBe(false);
    expect(shown(one('.dfh-carry'))).toBe(false);
    expect(one('.dfh-clock-note').textContent).toBe('First to 3');
  });

  it('says in words where each shard is', () => {
    draw();
    expect(shown(one('.dfh-relay'))).toBe(true);
    for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
      const cell = shardCell(team);
      expect(cell.dataset['status']).toBe('home');
      expect(one(`.dfh-shard-${team === TEAM_EMBER ? 'ember' : 'frost'}`).textContent).toBe('Home');
      expect(pathOf(cell)).toBe(team === TEAM_EMBER ? SHARD_SHAPES.ember : SHARD_SHAPES.frost);
    }

    state.relayPool.shards[1].status = SHARD_CARRIED;
    state.relayPool.shards[1].carrierName = 'Aman';
    state.relayPool.shards[0].status = SHARD_DROPPED;
    state.relayPool.shards[0].returnInS = 13.2;
    draw();
    const frost = shardCell(TEAM_FROST);
    expect(frost.dataset['status']).toBe('carried');
    expect(frost.querySelector('.dfh-shard-word')?.textContent).toBe('Taken');
    expect(frost.querySelector('.dfh-shard-who')?.textContent).toBe('Aman');
    const frostWho = frost.querySelector('.dfh-shard-who');
    expect(frostWho !== null && shown(frostWho)).toBe(true);
    const ember = shardCell(TEAM_EMBER);
    expect(ember.dataset['status']).toBe('dropped');
    expect(ember.querySelector('.dfh-shard-word')?.textContent).toBe('Dropped');
    expect(ember.querySelector('.dfh-shard-secs')?.textContent).toBe('14');
    const emberWho = ember.querySelector('.dfh-shard-who');
    expect(emberWho !== null && shown(emberWho)).toBe(false);

    // The seconds tick down; home again clears the extras.
    state.relayPool.shards[0].returnInS = 8;
    draw();
    expect(ember.querySelector('.dfh-shard-secs')?.textContent).toBe('8');
    state.relayPool.shards[0].status = SHARD_HOME;
    draw();
    const secs = ember.querySelector('.dfh-shard-secs');
    expect(secs !== null && shown(secs)).toBe(false);
    expect(ember.querySelector('.dfh-shard-word')?.textContent).toBe('Home');
  });

  it('announces a shard event in the reader\'s terms and lets it go', () => {
    pushShardEvent(state, 'pickedUp', TEAM_EMBER, 7, 'Kestrel', TEAM_FROST);
    draw();
    const notice = one('.dfh-notice');
    expect(shown(notice)).toBe(true);
    // The local rider is Ember: its own shard.
    expect(notice.textContent).toBe(relayNoticeText('pickedUp', TEAM_EMBER, TEAM_EMBER));
    expect(notice.dataset['tone']).toBe('bad');

    pushShardEvent(state, 'captured', TEAM_FROST, LOCAL_ID, 'Aman', TEAM_EMBER);
    draw();
    expect(notice.textContent).toBe('Shard captured');
    expect(notice.dataset['tone']).toBe('good');

    ageHudState(state, RELAY_NOTICE_LIFE_S + 0.1);
    draw();
    expect(shown(notice)).toBe(false);
  });

  it('names the teams for a spectator', () => {
    state.local = null;
    state.localPlayerId = NO_PLAYER;
    pushShardEvent(state, 'returned', TEAM_FROST, NO_PLAYER, '', null);
    draw();
    expect(one('.dfh-notice').textContent).toBe('Frost shard returned');
    expect(one('.dfh-notice').dataset['tone']).toBe('plain');
    state.relayPool.carrying = true;
    draw();
    expect(shown(one('.dfh-carry'))).toBe(false);
  });

  it('keeps the carry call-out up while the shard is in hand, with the way home', () => {
    draw();
    const carry = one('.dfh-carry');
    expect(shown(carry)).toBe(false);
    state.relayPool.carrying = true;
    state.relayPool.brazierDistanceM = 437;
    // Even between two text ticks the distance is there with the call-out.
    draw(16);
    expect(shown(carry)).toBe(true);
    expect(carry.textContent).toContain('You carry the shard');
    expect(carry.textContent).toContain('Bring it to your brazier');
    expect(one('.dfh-carry-dist').textContent).toBe('440');
    // An Ember rider carries Frost's shard, and heads for a brazier mark.
    expect(carry.dataset['team']).toBe('frost');
    expect(pathOf(one('.dfh-carry-mark'))).toBe(SHARD_SHAPES.frost);
    expect(pathOf(one('.dfh-carry-brazier'))).toBe(BRAZIER_SHAPE);

    state.relayPool.brazierDistanceM = 60;
    draw();
    expect(one('.dfh-carry-dist').textContent).toBe('60');
    // Not during the round's end.
    state.phase = 'roundEnd';
    draw();
    expect(shown(carry)).toBe(false);
    state.phase = 'playing';
    state.relayPool.carrying = false;
    draw();
    expect(shown(carry)).toBe(false);
  });

  it('writes shard events into the feed with who, what and whose', () => {
    pushShardEvent(state, 'pickedUp', TEAM_FROST, LOCAL_ID, 'Aman', TEAM_EMBER);
    pushShardEvent(state, 'returned', TEAM_EMBER, NO_PLAYER, '', null);
    draw();
    const rows = root.querySelectorAll('.dfh-feed-row');
    const [newest, older] = rows;
    if (newest === undefined || older === undefined) throw new Error('no feed rows');
    // Newest first: the shard that went home by itself has no actor.
    expect(shown(newest)).toBe(true);
    const whoNewest = newest.querySelectorAll('.dfh-feed-who');
    expect(whoNewest[0] !== undefined && shown(whoNewest[0])).toBe(false);
    expect(whoNewest[1]?.textContent).toBe('Ember shard returned');
    expect(whoNewest[1]?.dataset['team']).toBe('ember');
    expect(pathOf(newest.querySelector('.dfh-feed-glyph') ?? newest)).toBe(OBJECTIVE_GLYPHS.returned);

    const whoOlder = older.querySelectorAll('.dfh-feed-who');
    expect(whoOlder[0]?.textContent).toBe('Aman');
    expect(whoOlder[0]?.dataset['team']).toBe('ember');
    expect(whoOlder[1]?.textContent).toBe('Frost shard taken');
    expect(pathOf(whoOlder[1] ?? older)).toBe(SHARD_SHAPES.frost);
    expect(older.dataset['own']).toBe('1');

    // A takedown after it draws as a takedown again in the same pooled row.
    pushKillfeed(state, 7, 'Kestrel', TEAM_FROST, 'talon', 4, 'Miro', TEAM_EMBER, 'primary');
    draw();
    const top = root.querySelectorAll('.dfh-feed-row')[0];
    expect(top?.querySelectorAll('.dfh-feed-who')[1]?.textContent).toBe('Miro');
  });

  it('draws shards and the brazier on the compass with their own marks', () => {
    const fill = (index: number, kind: 'ally' | 'shard' | 'brazier', team: TeamId): void => {
      const marker = state.compass[index];
      if (marker === undefined) throw new Error('no marker');
      marker.kind = kind;
      marker.team = team;
      marker.angle = 0.2 * index;
      marker.distanceM = 100 + index * 50;
      marker.alive = true;
    };
    fill(0, 'shard', TEAM_FROST);
    fill(1, 'shard', TEAM_EMBER);
    fill(2, 'brazier', TEAM_EMBER);
    fill(3, 'ally', TEAM_EMBER);
    state.compassCount = 4;
    draw();
    const marks = root.querySelectorAll('.dfh-mark');
    expect(marks).toHaveLength(HUD_COMPASS_MARKERS);
    expect(marks.filter(shown)).toHaveLength(4);
    expect(marks[0]?.dataset).toMatchObject({ kind: 'shard', team: 'frost' });
    expect(pathOf(marks[0] ?? root)).toBe(SHARD_SHAPES.frost);
    expect(pathOf(marks[1] ?? root)).toBe(SHARD_SHAPES.ember);
    expect(marks[2]?.dataset).toMatchObject({ kind: 'brazier', team: 'ember' });
    expect(pathOf(marks[2] ?? root)).toBe(BRAZIER_SHAPE);
    expect(marks[3]?.dataset['kind']).toBe('ally');
    expect(pathOf(marks[3] ?? root)).not.toBe(SHARD_SHAPES.ember);
    expect(marks[0]?.querySelector('.dfh-mark-dist')?.textContent).toBe('100');
  });

  it('keeps the distance figures of close compass markers apart', () => {
    const fill = (
      index: number,
      kind: 'ally' | 'shard' | 'brazier',
      angle: number,
      distanceM: number,
    ): void => {
      const marker = state.compass[index];
      if (marker === undefined) throw new Error('no marker');
      marker.kind = kind;
      marker.team = TEAM_EMBER;
      marker.angle = angle;
      marker.distanceM = distanceM;
      marker.alive = true;
    };
    // A team mate carrying the shard: two markers on one spot, the same distance away. Another
    // mate a little further on the same bearing, the brazier well away from all of them.
    fill(0, 'ally', 0.3, 282);
    fill(1, 'shard', 0.3, 280);
    fill(2, 'ally', 0.32, 300);
    fill(3, 'brazier', -1, 600);
    state.compassCount = 4;
    draw();
    const marks = root.querySelectorAll('.dfh-mark');
    const lane = (index: number): string | undefined => marks[index]?.dataset['lane'];
    // The shard keeps its figure; the mate on it shares that figure (the same "280");
    // the mate behind them puts "300" a line lower; the brazier is not touched.
    expect(lane(1)).toBe('0');
    expect(lane(0)).toBe('2');
    expect(lane(2)).toBe('1');
    expect(lane(3)).toBe('0');
    expect(marks[2]?.querySelector('.dfh-mark-dist')?.textContent).toBe('300');

    // Nothing is written while they stay where they are.
    resetWrites();
    draw();
    expect(writeCount()).toBe(0);

    // The carrier's escort peels off: every figure is back on the first line.
    fill(0, 'ally', -0.4, 150);
    fill(2, 'ally', 0.9, 300);
    draw();
    expect([lane(0), lane(1), lane(2), lane(3)]).toEqual(['0', '0', '0', '0']);
  });

  it('shows the carrier "Carrying the shard" instead of "Slowed"', () => {
    const chip = (label: string): FakeElement => {
      const found = root
        .querySelectorAll('.dfh-chip')
        .find((node) => node.querySelector('.dfh-chip-label')?.textContent === label);
      if (found === undefined) throw new Error(`no chip ${label}`);
      return found;
    };
    state.localPool.alive = true;
    state.localPool.flags = DRAGON_FLAG_ALIVE;
    draw();
    expect(shown(chip('Carrying the shard'))).toBe(false);
    expect(shown(chip('Slowed'))).toBe(false);

    // The shard's weight arrives as the ordinary slow status.
    state.relayPool.carrying = true;
    state.localPool.flags = DRAGON_FLAG_ALIVE | DRAGON_FLAG_SLOWED | DRAGON_FLAG_BURNING;
    draw(16);
    expect(shown(chip('Carrying the shard'))).toBe(true);
    expect(shown(chip('Slowed'))).toBe(false);
    // Other statuses are not touched, and the carry chip is not drawn as harm.
    expect(shown(chip('Burning'))).toBe(true);
    expect(chip('Carrying the shard').className).not.toContain('dfh-chip-harm');
    // Up for the whole carry, also on a tick where the slow flag is not set yet.
    state.localPool.flags = DRAGON_FLAG_ALIVE;
    draw(16);
    expect(shown(chip('Carrying the shard'))).toBe(true);

    // The shard is gone and an enemy's slow is running: that one is a debuff and says so.
    state.relayPool.carrying = false;
    state.localPool.flags = DRAGON_FLAG_ALIVE | DRAGON_FLAG_SLOWED;
    draw(16);
    expect(shown(chip('Carrying the shard'))).toBe(false);
    expect(shown(chip('Slowed'))).toBe(true);

    // Another mode: never.
    state.relay = null;
    draw(16);
    expect(shown(chip('Carrying the shard'))).toBe(false);
    expect(shown(chip('Slowed'))).toBe(true);
  });

  it('counts captures on the scoreboard and puts the capturers first', () => {
    state.scoreboardOpen = true;
    state.scores[0] = 1;
    state.scores[1] = 2;
    draw();
    const board = one('.dfh-board');
    expect(shown(board)).toBe(true);
    expect(board.dataset['mode']).toBe('relay');
    expect(one('.dfh-board-note').textContent).toBe('First to 3 captures');
    const ember = board.querySelectorAll('.dfh-team')[0];
    const rows = ember?.querySelectorAll('.dfh-row').filter(shown) ?? [];
    // The caption row, then Aman (1 capture) before Miro (more takedowns, none brought home).
    expect(rows[0]?.querySelector('.dfh-cell-cap')?.textContent).toBe('Cap');
    expect(rows[1]?.querySelector('.dfh-cell-name')?.textContent).toBe('Aman');
    expect(rows[1]?.querySelector('.dfh-cell-cap')?.textContent).toBe('1');
    expect(rows[2]?.querySelector('.dfh-cell-name')?.textContent).toBe('Miro');
    expect(rows[2]?.querySelector('.dfh-cell-cap')?.textContent).toBe('0');

    state.mode = 'skirmish';
    state.relay = null;
    draw(400);
    expect(board.dataset['mode']).toBe('plain');
    expect(one('.dfh-board-note').textContent).toBe('First to 3 takedowns');
  });

  it('touches nothing on a frame where nothing changed', () => {
    state.relayPool.shards[1].status = SHARD_CARRIED;
    state.relayPool.shards[1].carrierName = 'Aman';
    state.relayPool.shards[0].status = SHARD_DROPPED;
    state.relayPool.shards[0].returnInS = 12;
    state.relayPool.carrying = true;
    state.relayPool.brazierDistanceM = 300;
    pushShardEvent(state, 'pickedUp', TEAM_FROST, LOCAL_ID, 'Aman', TEAM_EMBER);
    const marker = state.compass[0];
    if (marker !== undefined) {
      marker.kind = 'brazier';
      marker.team = TEAM_EMBER;
    }
    state.compassCount = 1;
    draw();
    draw();
    resetWrites();
    for (let i = 0; i < 5; i++) draw();
    expect(writeCount()).toBe(0);
  });
});
