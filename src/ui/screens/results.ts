/**
 * The match result (T-3.4): who won, the score, and every rider's totals. A plain panel over the
 * match while the host holds the `results` phase; the podium flight is T-5.5. When the phase
 * ends the room goes back to the lobby with its teams kept.
 *
 * `update` rebuilds the table only when it is handed a different results object (`src/game`
 * makes one per match), so calling it every frame costs one comparison.
 */

import { DRAGON_CLASSES } from '../../shared/classes';
import type { PlayerId, TeamId } from '../../shared/constants';
import { NO_PLAYER, TEAMS, TEAM_EMBER, TEAM_FROST } from '../../shared/constants';
import type { ResultsState, ScoreboardRow, UiState } from '../../shared/ui';
import { append, el } from '../dom';

const TEAM_ORDER: readonly TeamId[] = [TEAM_EMBER, TEAM_FROST];

function headline(results: ResultsState, localTeam: TeamId | null): string {
  if (results.winner === 'draw') return 'A drawn match';
  if (localTeam === null) return `${TEAMS[results.winner].name} takes the match`;
  return results.winner === localTeam ? 'Victory' : 'Defeat';
}

function awardText(results: ResultsState, id: PlayerId): string {
  const awards: string[] = [];
  if (id === results.mvpId) awards.push('MVP');
  if (id === results.mostTakedownsId) awards.push('Most takedowns');
  if (id === results.mostDamageId) awards.push('Most damage');
  return awards.join(' · ');
}

export class ResultsPanel {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly score: HTMLElement;
  private readonly tables: HTMLElement;
  private shown: ResultsState | null = null;
  private shownLocalId: PlayerId = NO_PLAYER;

  constructor() {
    this.root = el('div', 'dfu-results');
    this.root.setAttribute('role', 'status');
    const card = el('div', 'dfu-panel dfu-results-card');
    this.title = el('h2', 'dfu-heading dfu-results-title');
    this.score = el('p', 'dfu-results-score dfu-num');
    this.tables = el('div', 'dfu-results-tables');
    append(
      card,
      el('p', 'dfu-overline', 'Match result'),
      this.title,
      this.score,
      this.tables,
      el('p', 'dfu-hint', 'Back to the lobby in a moment. Teams are kept.'),
    );
    this.root.appendChild(card);
  }

  update(state: UiState): void {
    const results = state.results;
    const localId = state.connection.localPlayerId;
    if (results === null || (results === this.shown && localId === this.shownLocalId)) return;
    this.shown = results;
    this.shownLocalId = localId;

    let localTeam: TeamId | null = null;
    for (const row of results.scoreboard) {
      if (row.playerId === localId) localTeam = row.team;
    }
    this.title.textContent = headline(results, localTeam);
    this.root.dataset['winner'] =
      results.winner === 'draw' ? 'draw' : results.winner === TEAM_EMBER ? 'ember' : 'frost';
    this.score.textContent = `${TEAMS[TEAM_EMBER].name} ${results.scores[0]}  –  ${results.scores[1]} ${TEAMS[TEAM_FROST].name}`;

    this.tables.replaceChildren();
    for (const team of TEAM_ORDER) {
      const rows = results.scoreboard
        .filter((row) => row.team === team)
        .sort((a, b) => b.takedowns - a.takedowns || b.damage - a.damage);
      if (rows.length === 0) continue;
      this.tables.appendChild(this.teamTable(results, team, rows, localId));
    }
  }

  private teamTable(
    results: ResultsState,
    team: TeamId,
    rows: readonly ScoreboardRow[],
    localId: PlayerId,
  ): HTMLElement {
    const table = el('table', 'dfu-results-table');
    table.dataset['team'] = team === TEAM_EMBER ? 'ember' : 'frost';
    const head = el('tr');
    append(
      head,
      el('th', 'dfu-results-team', TEAMS[team].name),
      el('th', 'dfu-num', 'Takedowns'),
      el('th', 'dfu-num', 'Deaths'),
      el('th', 'dfu-num', 'Assists'),
      el('th', 'dfu-num', 'Damage'),
    );
    table.appendChild(head);
    for (const row of rows) {
      const line = el('tr');
      if (row.playerId === localId) line.className = 'dfu-results-me';
      const who = el('td');
      const name = el('div', 'dfu-results-name');
      append(
        name,
        el('span', '', row.name),
        el('span', 'dfu-results-class', DRAGON_CLASSES[row.classId].name),
      );
      const award = awardText(results, row.playerId);
      if (award !== '') name.appendChild(el('span', 'dfu-results-award', award));
      who.appendChild(name);
      append(
        line,
        who,
        el('td', 'dfu-num', String(row.takedowns)),
        el('td', 'dfu-num', String(row.deaths)),
        el('td', 'dfu-num', String(row.assists ?? 0)),
        el('td', 'dfu-num', String(Math.round(row.damage))),
      );
      table.appendChild(line);
    }
    return table;
  }
}
