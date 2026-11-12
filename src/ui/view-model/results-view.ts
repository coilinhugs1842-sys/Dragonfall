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
/** The short mark next to a name in the table, indexed by AwardId. */
export const AWARD_MARKS: readonly string[] = ['MVP', 'Takedowns', 'Damage'];

export interface AwardView {
  /** False when nobody earned it (NO_PLAYER) or the rider is not in the table. */
  shown: boolean;
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
  readonly awards: AwardView[];
}

function createAward(): AwardView {
  return {
    shown: false,
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
    awards: [createAward(), createAward(), createAward()],
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

function fillAward(
  out: AwardView,
  award: AwardId,
  row: ScoreboardRow | null,
  localId: PlayerId,
): void {
  out.shown = row !== null;
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
  } else if (award === AWARD_TAKEDOWNS) {
    out.value = String(takedowns);
    out.unit = takedowns === 1 ? 'takedown' : 'takedowns';
    out.detail = `${plural(deaths, 'death', 'deaths')}  ·  ${plural(assists, 'assist', 'assists')}`;
  } else {
    // The MVP is judged on the whole line, so the whole line is shown.
    out.value = `${takedowns} / ${deaths} / ${assists}`;
    out.unit = 'takedowns / deaths / assists';
    out.detail = `${damage} damage`;
  }
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
  const mvp = out.awards[AWARD_MVP];
  const takedowns = out.awards[AWARD_TAKEDOWNS];
  const damage = out.awards[AWARD_DAMAGE];
  if (mvp !== undefined) fillAward(mvp, AWARD_MVP, findRow(rows, results.mvpId), localId);
  if (takedowns !== undefined) {
    fillAward(takedowns, AWARD_TAKEDOWNS, findRow(rows, results.mostTakedownsId), localId);
  }
  if (damage !== undefined) {
    fillAward(damage, AWARD_DAMAGE, findRow(rows, results.mostDamageId), localId);
  }
  return out;
}

/** The awards a rider holds, as the short marks for the table ("MVP · Damage"), or ''. */
export function awardMarks(results: Readonly<ResultsState>, playerId: PlayerId): string {
  if (playerId === NO_PLAYER) return '';
  let text = '';
  if (playerId === results.mvpId) text = AWARD_MARKS[AWARD_MVP] ?? '';
  if (playerId === results.mostTakedownsId) {
    text = text === '' ? (AWARD_MARKS[AWARD_TAKEDOWNS] ?? '') : `${text} · ${AWARD_MARKS[AWARD_TAKEDOWNS]}`;
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
