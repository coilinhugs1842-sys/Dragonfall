/**
 * The results presentation without the DOM (T-5.5): the winner banner's words, who holds each
 * of the three awards and the numbers that earned it, and when each part appears. The 3D podium
 * is in the middle of the screen during this phase, so the panels that draw this only frame it.
 *
 * `computeResultsView` runs once per results object (one per match), so it may format text.
 * `revealStage` runs every frame and only compares numbers.
 */

import type { DragonClassId } from '../../shared/classes';
import { DEFAULT_DRAGON_CLASS } from '../../shared/classes';
import type { PlayerId, TeamId } from '../../shared/constants';
import { NO_PLAYER, TEAMS, TEAM_EMBER } from '../../shared/constants';
import type { ResultsState, ScoreboardRow } from '../../shared/ui';

export const AWARD_MVP = 0;
export const AWARD_TAKEDOWNS = 1;
export const AWARD_DAMAGE = 2;
export const AWARD_COUNT = 3;
export type AwardId = 0 | 1 | 2;

/** Card titles, indexed by AwardId. */
export const AWARD_TITLES: readonly string[] = ['MVP', 'Most takedowns', 'Most damage'];
/**
 * The short mark next to a name in the table, indexed by AwardId. The same abbreviations as the
 * table's column headings: the full words did not fit beside a name at any interface size, and
 * the award cards spell them out.
 */
export const AWARD_MARKS: readonly string[] = ['MVP', 'TKD', 'DMG'];
/**
 * Ember Relay gives its second award for shards brought home instead of takedowns (the mode is
 * won by captures, and takedowns do not score there): the card's title and the table's mark.
 */
export const AWARD_TITLE_CAPTURES = 'Most captures';
export const AWARD_MARK_CAPTURES = 'CAP';

export interface AwardView {
  /** False when nobody earned it (NO_PLAYER) or the rider is not in the table. */
  shown: boolean;
  /** The card's heading ("MVP", "Most takedowns", in Ember Relay "Most captures"). */
  title: string;
  playerId: PlayerId;
  name: string;
  classId: DragonClassId;
  team: TeamId;
  isLocal: boolean;
  /** The number that earned the award, large, and what it counts. */
  value: string;
  unit: string;
  /** The rest of the rider's line, small. */
  detail: string;
}

export type WinnerKey = 'ember' | 'frost' | 'draw';

export interface ResultsView {
  winner: WinnerKey;
  /** Small line over the banner: how it went for the local rider, or just that it is over. */
  overline: string;
  /** The banner itself: the winning order's name, or "Draw". */
  title: string;
  /** The local rider's team, or null for a watcher. */
  localTeam: TeamId | null;
  /**
   * The match was won by captures (Ember Relay): the table has a captures column and the
   * second award is for captures.
   */
  captures: boolean;
  readonly awards: AwardView[];
}

function createAward(title: string): AwardView {
  return {
    shown: false,
    title,
    playerId: NO_PLAYER,
    name: '',
    classId: DEFAULT_DRAGON_CLASS,
    team: TEAM_EMBER,
    isLocal: false,
    value: '',
    unit: '',
    detail: '',
  };
}

export function createResultsView(): ResultsView {
  return {
    winner: 'draw',
    overline: '',
    title: '',
    localTeam: null,
    captures: false,
    awards: [
      createAward(AWARD_TITLES[AWARD_MVP] ?? ''),
      createAward(AWARD_TITLES[AWARD_TAKEDOWNS] ?? ''),
      createAward(AWARD_TITLES[AWARD_DAMAGE] ?? ''),
    ],
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function whole(value: number): number {
  return value > 0 ? Math.round(value) : 0;
}

function findRow(rows: readonly ScoreboardRow[], playerId: PlayerId): ScoreboardRow | null {
  if (playerId === NO_PLAYER) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row !== undefined && row.playerId === playerId) return row;
  }
  return null;
}

/** `captures`: an Ember Relay match, where slot AWARD_TAKEDOWNS is given for captures. */
function fillAward(
  out: AwardView,
  award: AwardId,
  row: ScoreboardRow | null,
  localId: PlayerId,
  captures: boolean,
): void {
  out.shown = row !== null;
  out.title =
    captures && award === AWARD_TAKEDOWNS ? AWARD_TITLE_CAPTURES : (AWARD_TITLES[award] ?? '');
  if (row === null) {
    out.playerId = NO_PLAYER;
    out.name = '';
    out.value = '';
    out.unit = '';
    out.detail = '';
    out.isLocal = false;
    return;
  }
  const takedowns = whole(row.takedowns);
  const deaths = whole(row.deaths);
  const assists = whole(row.assists ?? 0);
  const damage = whole(row.damage);
  out.playerId = row.playerId;
  out.name = row.name;
  out.classId = row.classId;
  out.team = row.team;
  out.isLocal = localId !== NO_PLAYER && row.playerId === localId;
  if (award === AWARD_DAMAGE) {
    out.value = String(damage);
    out.unit = 'damage';
    out.detail = `${plural(takedowns, 'takedown', 'takedowns')}  ·  ${plural(assists, 'assist', 'assists')}`;
  } else if (award === AWARD_TAKEDOWNS && captures) {
    const brought = whole(row.captures ?? 0);
    out.value = String(brought);
    out.unit = brought === 1 ? 'capture' : 'captures';
    out.detail = `${plural(takedowns, 'takedown', 'takedowns')}  ·  ${plural(deaths, 'death', 'deaths')}`;
  } else if (award === AWARD_TAKEDOWNS) {
    out.value = String(takedowns);
    out.unit = takedowns === 1 ? 'takedown' : 'takedowns';
    out.detail = `${plural(deaths, 'death', 'deaths')}  ·  ${plural(assists, 'assist', 'assists')}`;
  } else {
    // The MVP is judged on the whole line, so the whole line is shown.
    out.value = `${takedowns} / ${deaths} / ${assists}`;
    out.unit = 'takedowns / deaths / assists';
    // In Ember Relay the shards brought home weigh most in that judgement: they lead the line.
    out.detail = captures
      ? `${plural(whole(row.captures ?? 0), 'capture', 'captures')}  ·  ${damage} damage`
      : `${damage} damage`;
  }
}

/** The match was Ember Relay. Results without a mode (older callers, tests) count takedowns. */
function countsCaptures(results: Readonly<ResultsState>): boolean {
  return results.mode === 'emberRelay';
}

/**
 * Refills `out` for a finished match. One rider may hold several awards: each card names them
 * again. `localId` marks the local rider's cards and picks "Victory" / "Defeat".
 */
export function computeResultsView(
  out: ResultsView,
  results: Readonly<ResultsState>,
  localId: PlayerId,
): ResultsView {
  const rows = results.scoreboard;
  const local = findRow(rows, localId);
  const localTeam = local === null ? null : local.team;
  out.localTeam = localTeam;
  const winner = results.winner;
  if (winner === 'draw') {
    out.winner = 'draw';
    out.title = 'Draw';
    out.overline = 'Match over';
  } else {
    out.winner = TEAMS[winner].key;
    out.title = TEAMS[winner].name;
    out.overline = localTeam === null ? 'The match goes to' : localTeam === winner ? 'Victory' : 'Defeat';
  }
  const captures = countsCaptures(results);
  out.captures = captures;
  const mvp = out.awards[AWARD_MVP];
  const takedowns = out.awards[AWARD_TAKEDOWNS];
  const damage = out.awards[AWARD_DAMAGE];
  if (mvp !== undefined) {
    fillAward(mvp, AWARD_MVP, findRow(rows, results.mvpId), localId, captures);
  }
  if (takedowns !== undefined) {
    const holder = captures ? (results.mostCapturesId ?? NO_PLAYER) : results.mostTakedownsId;
    fillAward(takedowns, AWARD_TAKEDOWNS, findRow(rows, holder), localId, captures);
  }
  if (damage !== undefined) {
    fillAward(damage, AWARD_DAMAGE, findRow(rows, results.mostDamageId), localId, captures);
  }
  return out;
}

/** The awards a rider holds, as the short marks for the table ("MVP · DMG"), or ''. */
export function awardMarks(results: Readonly<ResultsState>, playerId: PlayerId): string {
  if (playerId === NO_PLAYER) return '';
  let text = '';
  if (playerId === results.mvpId) text = AWARD_MARKS[AWARD_MVP] ?? '';
  // The second award: captures in Ember Relay (the takedowns award is not given there).
  const captures = countsCaptures(results);
  const second = captures ? (results.mostCapturesId ?? NO_PLAYER) : results.mostTakedownsId;
  if (playerId === second) {
    const mark = captures ? AWARD_MARK_CAPTURES : (AWARD_MARKS[AWARD_TAKEDOWNS] ?? '');
    text = text === '' ? mark : `${text} · ${mark}`;
  }
  if (playerId === results.mostDamageId) {
    text = text === '' ? (AWARD_MARKS[AWARD_DAMAGE] ?? '') : `${text} · ${AWARD_MARKS[AWARD_DAMAGE]}`;
  }
  return text;
}

// --- Reveal -----------------------------------------------------------------------------------------

/**
 * What is on screen, as a count of parts revealed so far: 0 nothing, 1 the banner, 2..4 the
 * award cards (MVP first), 5 the table.
 */
export const REVEAL_BANNER = 1;
export const REVEAL_FIRST_AWARD = 2;
export const REVEAL_ALL = 5;

/**
 * Seconds after the results appear at which each stage begins. The awards come up while the
 * three dragons land on the podium (about 5 to 8 s into the phase), the table after them.
 */
export const REVEAL_TIMES_S: readonly number[] = [0.3, 5, 6, 7, 8.2];

/**
 * The stage for `elapsedS` seconds since the results appeared. With reduced motion everything
 * is there at once: nothing arrives piece by piece.
 */
export function revealStage(elapsedS: number, reduceMotion: boolean): number {
  if (reduceMotion) return REVEAL_ALL;
  // A clock that jumped backwards must not hide what was already shown.
  if (!(elapsedS >= 0)) return REVEAL_ALL;
  let stage = 0;
  for (let i = 0; i < REVEAL_TIMES_S.length; i++) {
    const at = REVEAL_TIMES_S[i];
    if (at !== undefined && elapsedS >= at) stage = i + 1;
  }
  return stage;
}
