/**
 * The match result (T-5.5). During the `results` phase the 3D podium is in the middle of the
 * screen (three winners landing on its steps), so this frames it instead of covering it: the
 * winner banner along the top, the three award cards in a row along the bottom (under the
 * dragons they belong to), and the full table as a compact panel at the right edge. Nothing is
 * drawn over the centre and nothing takes the pointer.
 *
 * Every node is built once: three cards and 2 × MAX_TEAM_SIZE table rows. `update` refills them
 * only when it is handed a different results object (`src/game` makes one per match). After
 * that a frame costs one comparison and the reveal check.
 *
 * The parts arrive in turn (banner, then the awards as the dragons land, then the table). The
 * clock for that is the time since this panel appeared, kept here: no timers, no state from
 * outside. With reduced motion everything is there at once.
 */

import '../results.css';
import { DRAGON_CLASSES } from '../../shared/classes';
import type { PlayerId, TeamId } from '../../shared/constants';
import { MAX_TEAM_SIZE, NO_PLAYER, TEAMS, TEAM_EMBER, TEAM_FROST } from '../../shared/constants';
import type { ResultsState, ScoreboardRow, UiState } from '../../shared/ui';
import { append, el, icon } from '../dom';
import { intString, sortTeamRows } from '../hud/hud-model';
import type { AwardView, ResultsView } from '../view-model/results-view';
import {
  AWARD_COUNT,
  AWARD_TITLES,
  awardMarks,
  computeResultsView,
  createResultsView,
  revealStage,
} from '../view-model/results-view';

const TEAM_ORDER: readonly TeamId[] = [TEAM_EMBER, TEAM_FROST];

interface AwardDom {
  readonly card: HTMLElement;
  /** The heading: "Most takedowns" becomes "Most captures" in Ember Relay. */
  readonly title: HTMLElement;
  readonly name: HTMLElement;
  readonly you: HTMLElement;
  readonly classLabel: HTMLElement;
  readonly value: HTMLElement;
  readonly unit: HTMLElement;
  readonly detail: HTMLElement;
}

interface RowDom {
  readonly row: HTMLElement;
  readonly name: HTMLElement;
  readonly you: HTMLElement;
  readonly classLabel: HTMLElement;
  readonly marks: HTMLElement;
  /** Shards brought home: a column only Ember Relay's table shows. */
  readonly captures: HTMLElement;
  readonly takedowns: HTMLElement;
  readonly deaths: HTMLElement;
  readonly assists: HTMLElement;
  readonly damage: HTMLElement;
}

interface TeamDom {
  readonly block: HTMLElement;
  readonly score: HTMLElement;
  readonly rows: RowDom[];
  readonly order: number[];
}

/** Both team shapes; CSS shows the one that matches the nearest `data-team`. */
function teamShapes(parent: HTMLElement): void {
  append(
    parent,
    icon('triangle', 'dfr-shape dfr-shape-ember'),
    icon('diamond', 'dfr-shape dfr-shape-frost'),
  );
}

function buildAward(title: string): AwardDom {
  const card = el('article', 'dfr-award dfr-part');
  card.hidden = true;
  const who = el('p', 'dfr-award-who');
  const name = el('span', 'dfr-award-name');
  const you = el('span', 'dfu-badge dfu-badge-you', 'You');
  you.hidden = true;
  teamShapes(who);
  append(who, name, you);
  const classLabel = el('p', 'dfr-award-class');
  const figure = el('p', 'dfr-award-figure');
  const value = el('span', 'dfr-award-value dfu-num');
  const unit = el('span', 'dfr-award-unit');
  append(figure, value, unit);
  const detail = el('p', 'dfr-award-detail dfu-num');
  const heading = el('h3', 'dfu-overline dfr-award-title', title);
  append(card, heading, who, classLabel, figure, detail);
  return { card, title: heading, name, you, classLabel, value, unit, detail };
}

function buildRow(): RowDom {
  const row = el('tr', 'dfr-row');
  row.hidden = true;
  const who = el('th', 'dfr-cell-who');
  who.setAttribute('scope', 'row');
  const name = el('span', 'dfr-row-name');
  const you = el('span', 'dfu-badge dfu-badge-you', 'You');
  you.hidden = true;
  const classLabel = el('span', 'dfr-row-class');
  const marks = el('span', 'dfr-row-marks');
  // One line that gives way in a fixed order when the name is long: class stays, the award
  // marks and then the name are cut short.
  const line = el('div', 'dfr-who');
  append(line, name, you, marks, classLabel);
  who.appendChild(line);
  const captures = el('td', 'dfu-num dfr-cell-cap');
  const takedowns = el('td', 'dfu-num dfr-cell-key');
  const deaths = el('td', 'dfu-num');
  const assists = el('td', 'dfu-num');
  const damage = el('td', 'dfu-num');
  append(row, who, captures, takedowns, deaths, assists, damage);
  return { row, name, you, classLabel, marks, captures, takedowns, deaths, assists, damage };
}

function buildTeam(team: TeamId, withColumns: boolean): TeamDom {
  const info = TEAMS[team];
  const block = el('table', 'dfr-team');
  block.dataset['team'] = info.key;
  const head = el('thead');
  const line = el('tr');
  const title = el('th', 'dfr-team-head');
  title.setAttribute('scope', 'col');
  const score = el('span', 'dfr-team-score dfu-num', '0');
  teamShapes(title);
  append(title, el('span', 'dfr-team-name', info.name), score);
  // The column captions are spelled out for screen readers and abbreviated on screen. Only
  // the first team's header shows them; the second lines up under it.
  const caption = (short: string, long: string, extra = ''): HTMLElement => {
    const cell = el('th', `dfr-col dfu-num${extra}`, withColumns ? short : '');
    cell.setAttribute('scope', 'col');
    cell.setAttribute('aria-label', long);
    cell.title = long;
    return cell;
  };
  append(
    line,
    title,
    // Ember Relay only (results.css hides it in the other modes): what that mode is won by.
    caption('Cap', 'Captures', ' dfr-cell-cap'),
    caption('Tkd', 'Takedowns'),
    caption('Dth', 'Deaths'),
    caption('Ast', 'Assists'),
    caption('Dmg', 'Damage'),
  );
  head.appendChild(line);
  const body = el('tbody');
  const rows: RowDom[] = [];
  const order: number[] = [];
  for (let i = 0; i < MAX_TEAM_SIZE; i++) {
    const row = buildRow();
    rows.push(row);
    order.push(0);
    body.appendChild(row.row);
  }
  append(block, head, body);
  return { block, score, rows, order };
}

export class ResultsPanel {
  readonly root: HTMLElement;
  private readonly overline: HTMLElement;
  private readonly title: HTMLElement;
  private readonly emberScore: HTMLElement;
  private readonly frostScore: HTMLElement;
  private readonly score: HTMLElement;
  private readonly awards: AwardDom[] = [];
  private readonly teams: TeamDom[] = [];
  private readonly table: HTMLElement;
  /** In reveal order: banner, the three cards, the table. */
  private readonly parts: HTMLElement[] = [];
  private readonly partOn: boolean[] = [];
  private readonly view: ResultsView = createResultsView();

  private shown: ResultsState | null = null;
  private shownLocalId: PlayerId = NO_PLAYER;
  /** When the panel appeared (`nowMs` scale), or -1 while it is not showing. */
  private startMs = -1;

  constructor() {
    this.root = el('section', 'dfu-results');
    this.root.setAttribute('aria-label', 'Match result');

    // --- Banner -----------------------------------------------------------------------------
    const banner = el('header', 'dfr-banner dfr-part');
    banner.setAttribute('role', 'status');
    this.overline = el('p', 'dfu-overline dfr-overline');
    const heading = el('h2', 'dfr-title');
    this.title = el('span');
    teamShapes(heading);
    heading.appendChild(this.title);
    this.score = el('p', 'dfr-score dfu-num');
    const ember = el('span', 'dfr-score-side');
    ember.dataset['team'] = 'ember';
    this.emberScore = el('span', '', '0');
    teamShapes(ember);
    ember.appendChild(this.emberScore);
    const frost = el('span', 'dfr-score-side');
    frost.dataset['team'] = 'frost';
    this.frostScore = el('span', '', '0');
    frost.appendChild(this.frostScore);
    teamShapes(frost);
    const dash = el('span', 'dfr-score-dash', '–');
    dash.setAttribute('aria-hidden', 'true');
    append(this.score, ember, dash, frost);
    append(banner, this.overline, heading, this.score);

    // --- Awards -----------------------------------------------------------------------------
    const awardRow = el('div', 'dfr-awards');
    for (let i = 0; i < AWARD_COUNT; i++) {
      const award = buildAward(AWARD_TITLES[i] ?? '');
      award.card.dataset['award'] = String(i);
      this.awards.push(award);
      awardRow.appendChild(award.card);
    }

    // --- Table ------------------------------------------------------------------------------
    const table = el('div', 'dfu-panel dfr-table dfr-part');
    table.dataset['captures'] = '0';
    this.table = table;
    for (const team of TEAM_ORDER) {
      const dom = buildTeam(team, team === TEAM_EMBER);
      this.teams.push(dom);
      table.appendChild(dom.block);
    }
    table.appendChild(el('p', 'dfu-hint dfr-foot', 'Back to the aerie in a moment. Teams are kept.'));

    this.parts.push(banner);
    for (const award of this.awards) this.parts.push(award.card);
    this.parts.push(table);
    for (let i = 0; i < this.parts.length; i++) this.partOn.push(false);

    append(this.root, banner, awardRow, table);
  }

  /** `nowMs` is the frame time; it only drives the reveal. */
  update(state: UiState, nowMs: number): void {
    const results = state.results;
    if (results === null) return;
    const localId = state.connection.localPlayerId;
    if (results !== this.shown || localId !== this.shownLocalId) {
      // A different match's results start their own reveal; a late local id does not.
      if (results !== this.shown) this.startMs = -1;
      this.shown = results;
      this.shownLocalId = localId;
      this.fill(results, localId);
    }
    if (this.startMs < 0) this.startMs = nowMs;
    const stage = revealStage((nowMs - this.startMs) / 1000, state.settings.reduceMotion === true);
    for (let i = 0; i < this.parts.length; i++) {
      const on = stage > i;
      if (on === this.partOn[i]) continue;
      this.partOn[i] = on;
      const part = this.parts[i];
      if (part !== undefined) part.dataset['on'] = on ? '1' : '0';
    }
  }

  /** The panel was taken off screen: the next results start from an empty frame. */
  reset(): void {
    if (this.startMs < 0) return;
    this.startMs = -1;
    this.shown = null;
    for (let i = 0; i < this.parts.length; i++) {
      if (this.partOn[i] !== true) continue;
      this.partOn[i] = false;
      const part = this.parts[i];
      if (part !== undefined) part.dataset['on'] = '0';
    }
  }

  /** Once per results object: may format text and touch every cell. */
  private fill(results: ResultsState, localId: PlayerId): void {
    const view = computeResultsView(this.view, results, localId);
    this.root.dataset['winner'] = view.winner;
    this.overline.textContent = view.overline;
    this.title.textContent = view.title;
    const ember = results.scores[0];
    const frost = results.scores[1];
    this.emberScore.textContent = intString(ember);
    this.frostScore.textContent = intString(frost);
    this.score.setAttribute(
      'aria-label',
      `${TEAMS[TEAM_EMBER].name} ${intString(ember)}, ${TEAMS[TEAM_FROST].name} ${intString(frost)}`,
    );

    for (let i = 0; i < this.awards.length; i++) {
      const dom = this.awards[i];
      const award: AwardView | undefined = view.awards[i];
      if (dom === undefined || award === undefined) continue;
      dom.card.hidden = !award.shown;
      if (!award.shown) continue;
      dom.card.dataset['team'] = TEAMS[award.team].key;
      dom.title.textContent = award.title;
      // Names are player-chosen text: always set as text, never as markup.
      dom.name.textContent = award.name;
      dom.you.hidden = !award.isLocal;
      dom.classLabel.textContent = `${DRAGON_CLASSES[award.classId].name}  ·  ${TEAMS[award.team].name}`;
      dom.value.textContent = award.value;
      dom.unit.textContent = award.unit;
      dom.detail.textContent = award.detail;
    }

    // The captures column and its emphasis: only where captures decide the match.
    this.table.dataset['captures'] = view.captures ? '1' : '0';

    const rows = results.scoreboard;
    for (let t = 0; t < this.teams.length; t++) {
      const dom = this.teams[t];
      const team = TEAM_ORDER[t];
      if (dom === undefined || team === undefined) continue;
      dom.score.textContent = intString(results.scores[t] ?? 0);
      const written = sortTeamRows(rows, rows.length, team, dom.order);
      // A team nobody flew for (a solo flight) has no block at all.
      dom.block.hidden = written === 0;
      for (let i = 0; i < dom.rows.length; i++) {
        const line = dom.rows[i];
        if (line === undefined) continue;
        const row: ScoreboardRow | undefined = i < written ? rows[dom.order[i] ?? -1] : undefined;
        line.row.hidden = row === undefined;
        if (row === undefined) continue;
        const mine = localId !== NO_PLAYER && row.playerId === localId;
        line.row.dataset['me'] = mine ? '1' : '0';
        line.name.textContent = row.name;
        line.you.hidden = !mine;
        line.classLabel.textContent = DRAGON_CLASSES[row.classId].name;
        line.marks.textContent = awardMarks(results, row.playerId);
        line.captures.textContent = intString(row.captures ?? 0);
        line.takedowns.textContent = intString(row.takedowns);
        line.deaths.textContent = intString(row.deaths);
        line.assists.textContent = intString(row.assists ?? 0);
        line.damage.textContent = intString(row.damage);
      }
    }
  }
}
