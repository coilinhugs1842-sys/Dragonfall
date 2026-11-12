/**
 * The lobby (T-2.8, T-5.3), in two layouts of the same controls:
 *
 * - `flat`: the 2D panel over the drifting sky, used when there is no 3D aerie behind the UI;
 * - `aerie` (`UiState.aerie`): the 3D aerie is on screen, so nothing may cover the middle. The
 *   Ember roster docks at the left edge and the Frost roster at the right (as the terraces
 *   stand), the room code and Leave run along the top, the player's own controls and Start
 *   along the bottom, and the match rules open as a drawer. Name cards float over the perches
 *   (`lobby-plates.ts`), and a click on a rider asks for the close-up camera.
 *
 * Everything is built once: 2 × MAX_TEAM_SIZE perch rows, MAX_LOBBY_MEMBERS watcher rows, the
 * rules controls and both layouts' frames. Switching layout moves the same nodes between the
 * frames (rare: once on entering the room), so a control keeps its state and its listeners.
 * `update` refills a reused LobbyView and writes only the cells whose value changed. One
 * delegated click listener turns `data-act` buttons into intents.
 */

import '../aerie.css';
import type { DragonClassId } from '../../shared/classes';
import { DRAGON_CLASSES, DRAGON_CLASS_IDS, isDragonClassId } from '../../shared/classes';
import type { LobbySide, PlayerId, TeamId } from '../../shared/constants';
import { MAX_TEAM_SIZE, NO_PLAYER, TEAMS, TEAM_EMBER, TEAM_FROST } from '../../shared/constants';
import type { BotDifficulty, HostSettings, LobbyPhase, LobbyState } from '../../shared/lobby';
import {
  BOT_DIFFICULTIES,
  HOST_SETTING_LIMITS,
  isBotDifficulty,
  isBotSide,
} from '../../shared/lobby';
import type { MapId, ModeId } from '../../shared/match';
import { MAPS, MODES } from '../../shared/match';
import type { UiIntentHandler, UiStartBlocker, UiState } from '../../shared/ui';
import { actionTarget, append, button, copyText, el, icon } from '../dom';
import type { IconName } from '../dom';
import { pingBars } from '../view-model/connection';
import type { LobbyLayout, PlateBand } from '../view-model/aerie-view';
import {
  aerieNotice,
  createPlateBand,
  focusTarget,
  lobbyLayoutFor,
  measurePlateBand,
} from '../view-model/aerie-view';
import type { LobbyView, SlotView } from '../view-model/lobby-view';
import {
  SLOT_CLOSED,
  SLOT_OPEN,
  SLOT_PLAYER,
  TIME_LIMIT_CHOICES_S,
  computeLobbyView,
  createLobbyView,
  formatTimeLimit,
  teamSizeRange,
} from '../view-model/lobby-view';
import { describeStart } from '../view-model/messages';
import { LobbyPlates } from './lobby-plates';

const MODE_IDS = Object.keys(MODES) as ModeId[];
const MAP_IDS = Object.keys(MAPS) as MapId[];
const TEAM_ICON: Readonly<Record<TeamId, IconName>> = {
  [TEAM_EMBER]: TEAMS[TEAM_EMBER].icon,
  [TEAM_FROST]: TEAMS[TEAM_FROST].icon,
};
const COPY_FEEDBACK_MS = 1600;
/**
 * A name card's footprint at scale 1, in em of the lobby's font size (aerie.css: `.dfa-plate`
 * is at most 12em wide and two lines tall, plus its pointer). Used to keep whole cards clear of
 * the docked panels.
 */
const PLATE_WIDTH_EM = 12;
const PLATE_HEIGHT_EM = 4;
/** Clear space kept between a docked panel and a card, in em. */
const PLATE_GAP_EM = 0.5;
/** Layout measurements taken after something that moves the panels (see `measureBand`). */
const BAND_MEASURES = 3;
const BAND_MEASURE_ATTEMPTS = 12;
const BOT_LEVEL_LABELS: Readonly<Record<BotDifficulty, string>> = {
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
};
const PHASE_TEXT: Readonly<Record<LobbyPhase, string>> = {
  lobby: 'Gathering riders',
  starting: 'Riders launching…',
  inMatch: 'Match under way',
};

type RowState = 'none' | 'ready' | 'waiting' | 'away' | 'host' | 'bot';
const ROW_STATE_TEXT: Readonly<Record<RowState, string>> = {
  none: '',
  ready: 'Ready',
  waiting: 'Not ready',
  away: 'Reconnecting…',
  host: 'Hosting',
  bot: 'Ready',
};

/** One perch or watcher row and the values last written to it. */
interface SlotDom {
  readonly row: HTMLLIElement;
  readonly name: HTMLElement;
  readonly hostBadge: HTMLElement;
  readonly youBadge: HTMLElement;
  readonly botBadge: HTMLElement;
  readonly classLabel: HTMLElement;
  readonly ping: HTMLElement;
  readonly pingText: HTMLElement;
  readonly stateText: HTMLElement;
  readonly empty: HTMLElement;
  readonly toEmber: HTMLButtonElement;
  readonly toFrost: HTMLButtonElement;
  readonly toWatch: HTMLButtonElement;
  readonly kick: HTMLButtonElement;
  /** Aerie layout: the row itself as a button that asks for the close-up. Perch rows only. */
  readonly focus: HTMLButtonElement | null;
  readonly isWatcher: boolean;
  focused: boolean;
  kind: number;
  playerId: PlayerId;
  shownName: string;
  classId: DragonClassId | null;
  state: RowState | null;
  isHost: boolean;
  isLocal: boolean;
  isBot: boolean;
  pingMs: number;
  canEmber: boolean;
  canFrost: boolean;
  canWatch: boolean;
  canKick: boolean;
}

function moveButton(action: string, glyph: IconName, team: string): HTMLButtonElement {
  const node = button('dfu-icon-btn', '', action);
  node.dataset['team'] = team;
  node.hidden = true;
  node.appendChild(icon(glyph));
  return node;
}

function createSlotDom(markIcon: IconName, isWatcher: boolean): SlotDom {
  const row = el('li', 'dfu-slot');
  row.dataset['kind'] = 'closed';
  const mark = el('span', 'dfu-slot-mark');
  mark.appendChild(icon(markIcon));
  const name = el('span', 'dfu-slot-name');
  const hostBadge = el('span', 'dfu-badge dfu-badge-host', 'Host');
  const youBadge = el('span', 'dfu-badge dfu-badge-you', 'You');
  const botBadge = el('span', 'dfu-badge', 'Bot');
  hostBadge.hidden = true;
  youBadge.hidden = true;
  botBadge.hidden = true;
  const id = el('span', 'dfu-slot-id');
  append(id, name, hostBadge, youBadge, botBadge);
  const classLabel = el('span', 'dfu-slot-class');
  const ping = el('span', 'dfu-slot-ping dfu-bars');
  ping.dataset['bars'] = '0';
  const pingText = el('span', 'dfu-num');
  append(ping, el('i'), el('i'), el('i'), el('i'), pingText);
  const state = el('span', 'dfu-slot-state');
  const stateText = el('span');
  append(state, icon('check', 'dfu-slot-check'), stateText);
  const actions = el('span', 'dfu-slot-actions');
  const toEmber = moveButton('moveEmber', TEAM_ICON[TEAM_EMBER], 'ember');
  const toFrost = moveButton('moveFrost', TEAM_ICON[TEAM_FROST], 'frost');
  const toWatch = moveButton('moveWatch', 'eye', 'watch');
  const kick = moveButton('kick', 'cross', 'kick');
  append(actions, toEmber, toFrost, toWatch, kick);
  const empty = el('span', 'dfu-slot-empty');
  // First in the row, so the keyboard reaches "look at this rider" before the host's buttons.
  // It covers the row in the aerie layout and does not exist for the flat one (CSS).
  let focus: HTMLButtonElement | null = null;
  if (!isWatcher) {
    focus = button('dfu-slot-focus', '', 'focusRow');
    focus.setAttribute('aria-pressed', 'false');
    row.appendChild(focus);
  }
  append(row, mark, id, classLabel, ping, state, actions, empty);
  return {
    row,
    name,
    hostBadge,
    youBadge,
    botBadge,
    classLabel,
    ping,
    pingText,
    stateText,
    empty,
    toEmber,
    toFrost,
    toWatch,
    kick,
    focus,
    isWatcher,
    focused: false,
    kind: -1,
    playerId: NO_PLAYER,
    shownName: '',
    classId: null,
    state: null,
    isHost: false,
    isLocal: false,
    isBot: false,
    pingMs: -2,
    canEmber: false,
    canFrost: false,
    canWatch: false,
    canKick: false,
  };
}

function rowState(view: SlotView, isWatcher: boolean): RowState {
  if (!view.connected) return 'away';
  if (isWatcher) return 'none';
  if (view.isHost) return 'host';
  if (view.isBot) return 'bot';
  return view.ready ? 'ready' : 'waiting';
}

function applySlot(dom: SlotDom, view: SlotView): void {
  if (dom.kind !== view.kind) {
    dom.kind = view.kind;
    dom.row.dataset['kind'] =
      view.kind === SLOT_PLAYER ? 'player' : view.kind === SLOT_OPEN ? 'open' : 'closed';
    if (dom.isWatcher) dom.row.hidden = view.kind !== SLOT_PLAYER;
    else if (view.kind !== SLOT_PLAYER) {
      dom.empty.textContent = view.kind === SLOT_OPEN ? 'Open perch' : 'Closed';
    }
  }
  if (view.kind !== SLOT_PLAYER) {
    if (dom.playerId !== NO_PLAYER) {
      dom.playerId = NO_PLAYER;
      delete dom.row.dataset['pid'];
    }
    return;
  }
  if (dom.playerId !== view.playerId) {
    dom.playerId = view.playerId;
    dom.row.dataset['pid'] = String(view.playerId);
  }
  if (dom.shownName !== view.name) {
    dom.shownName = view.name;
    // Names are player-chosen text: always set as text, never as markup.
    dom.name.textContent = view.name;
    dom.toEmber.setAttribute('aria-label', `Move ${view.name} to ${TEAMS[TEAM_EMBER].name}`);
    dom.toEmber.title = `Move to ${TEAMS[TEAM_EMBER].name}`;
    dom.toFrost.setAttribute('aria-label', `Move ${view.name} to ${TEAMS[TEAM_FROST].name}`);
    dom.toFrost.title = `Move to ${TEAMS[TEAM_FROST].name}`;
    dom.toWatch.setAttribute('aria-label', `Move ${view.name} to the watchers`);
    dom.toWatch.title = 'Move to the watchers';
    dom.kick.setAttribute('aria-label', `Remove ${view.name} from the room`);
    dom.kick.title = 'Remove from the room';
    dom.focus?.setAttribute('aria-label', `Look at ${view.name}`);
  }
  if (dom.classId !== view.classId) {
    dom.classId = view.classId;
    dom.classLabel.textContent = DRAGON_CLASSES[view.classId].name;
  }
  const state = rowState(view, dom.isWatcher);
  if (dom.state !== state) {
    dom.state = state;
    dom.row.dataset['state'] = state;
    dom.stateText.textContent = ROW_STATE_TEXT[state];
  }
  if (dom.isHost !== view.isHost) {
    dom.isHost = view.isHost;
    dom.hostBadge.hidden = !view.isHost;
  }
  if (dom.isLocal !== view.isLocal) {
    dom.isLocal = view.isLocal;
    dom.youBadge.hidden = !view.isLocal;
    dom.row.classList.toggle('dfu-slot-local', view.isLocal);
  }
  if (dom.isBot !== view.isBot) {
    dom.isBot = view.isBot;
    dom.botBadge.hidden = !view.isBot;
  }
  if (dom.pingMs !== view.pingMs) {
    dom.pingMs = view.pingMs;
    dom.ping.dataset['bars'] = String(pingBars(view.pingMs));
    dom.pingText.textContent = view.pingMs < 0 ? '' : `${view.pingMs} ms`;
  }
  if (dom.canEmber !== view.canMoveToEmber) {
    dom.canEmber = view.canMoveToEmber;
    dom.toEmber.hidden = !view.canMoveToEmber;
  }
  if (dom.canFrost !== view.canMoveToFrost) {
    dom.canFrost = view.canMoveToFrost;
    dom.toFrost.hidden = !view.canMoveToFrost;
  }
  if (dom.canWatch !== view.canMoveToSpectator) {
    dom.canWatch = view.canMoveToSpectator;
    dom.toWatch.hidden = !view.canMoveToSpectator;
  }
  if (dom.canKick !== view.canKick) {
    dom.canKick = view.canKick;
    dom.kick.hidden = !view.canKick;
  }
}

function setDisabled(
  node: HTMLButtonElement | HTMLInputElement | HTMLSelectElement,
  off: boolean,
): void {
  if (node.disabled !== off) node.disabled = off;
}

function setPressed(node: HTMLElement, attribute: string, on: boolean): void {
  const value = on ? 'true' : 'false';
  if (node.getAttribute(attribute) !== value) node.setAttribute(attribute, value);
}

function setText(node: HTMLElement, cache: { value: string }, value: string): void {
  if (cache.value === value) return;
  cache.value = value;
  node.textContent = value;
}

function ruleRow(label: string, control: HTMLElement): HTMLElement {
  const row = el('div', 'dfu-rule');
  append(row, el('span', 'dfu-rule-label', label), control);
  return row;
}

/** A two-state rule. The words next to the knob say the state, so it never relies on colour. */
function switchButton(action: string, label: string, offText: string): HTMLButtonElement {
  const node = button('dfu-switch', '', action);
  node.setAttribute('role', 'switch');
  node.setAttribute('aria-checked', 'false');
  node.setAttribute('aria-label', label);
  append(node, el('span', 'dfu-switch-knob'), el('span', 'dfu-switch-text', offText));
  return node;
}

/** One mode or map on the host panel. */
interface PickDom {
  readonly node: HTMLButtonElement;
  readonly id: string;
  readonly name: string;
  readonly soon: HTMLElement;
  /** The availability last drawn; null before the first refresh. */
  available: boolean | null;
}

/**
 * A choice among a few named things (mode, map) as a row of radio buttons rather than a
 * dropdown, so the ones that are not built yet are visible, marked "Soon", instead of hiding
 * inside a closed list.
 */
function pickGroup(
  label: string,
  action: string,
  ids: readonly string[],
  nameOf: (id: string) => string,
  out: PickDom[],
): HTMLElement {
  const group = el('div', 'dfu-picks');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const id of ids) {
    const name = nameOf(id);
    const node = button('dfu-pick', '', action);
    node.dataset['pick'] = id;
    node.setAttribute('role', 'radio');
    node.setAttribute('aria-checked', 'false');
    const soon = el('span', 'dfu-pick-soon', 'Soon');
    soon.hidden = true;
    append(node, el('span', '', name), soon);
    out.push({ node, id, name, soon, available: null });
    group.appendChild(node);
  }
  return group;
}

/**
 * Draws one choice. Availability is read from the shared table on every refresh, not once at
 * start-up: a mode or map becomes selectable by itself when its `available` flag turns true.
 */
function applyPick(pick: PickDom, available: boolean, chosen: boolean, canEdit: boolean): void {
  if (pick.available !== available) {
    pick.available = available;
    pick.soon.hidden = available;
    pick.node.dataset['soon'] = available ? '0' : '1';
    if (available) {
      pick.node.removeAttribute('aria-label');
      pick.node.title = '';
    } else {
      pick.node.setAttribute('aria-label', `${pick.name}, coming soon`);
      pick.node.title = 'Coming soon';
    }
  }
  setPressed(pick.node, 'aria-checked', chosen);
  setDisabled(pick.node, !canEdit || !available);
}

interface TeamDom {
  readonly box: HTMLElement;
  readonly count: HTMLElement;
  readonly countCache: { value: string };
  readonly join: HTMLButtonElement;
  readonly slots: SlotDom[];
}

export class LobbyScreen {
  readonly root: HTMLElement;

  private readonly onIntent: UiIntentHandler;
  private readonly view: LobbyView = createLobbyView();

  private readonly code: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly copyLabel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly teams: readonly [TeamDom, TeamDom];
  private readonly watchers: SlotDom[] = [];
  private readonly watcherCount: HTMLElement;
  private readonly watcherEmpty: HTMLElement;
  private readonly watchButton: HTMLButtonElement;
  private readonly classButtons: HTMLButtonElement[] = [];
  private readonly readyButton: HTMLButtonElement;
  private readonly readyLabel: HTMLElement;
  private readonly lockNote: HTMLElement;

  private readonly rulesOwner: HTMLElement;
  private readonly modePicks: PickDom[] = [];
  private readonly mapPicks: PickDom[] = [];
  private readonly sizeButtons: HTMLButtonElement[] = [];
  private readonly unevenSwitch: HTMLButtonElement;
  private readonly lockSwitch: HTMLButtonElement;
  private readonly fireSwitch: HTMLButtonElement;
  private readonly scoreInput: HTMLInputElement;
  private readonly timeSelect: HTMLSelectElement;
  private readonly timeCustom: HTMLOptionElement;
  private readonly allowButtons: HTMLButtonElement[] = [];
  private readonly hostTools: HTMLElement;
  private readonly balanceButton: HTMLButtonElement;
  private readonly shuffleButton: HTMLButtonElement;
  private readonly botLevelButtons: HTMLButtonElement[] = [];
  private readonly botTools: HTMLElement;
  private readonly addEmberBot: HTMLButtonElement;
  private readonly addFrostBot: HTMLButtonElement;
  private readonly fillBotsButton: HTMLButtonElement;
  private readonly clearBotsButton: HTMLButtonElement;
  private readonly rosterHint: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly startNote: HTMLElement;

  // The movable pieces and the two frames they sit in (see `setLayout`).
  private readonly codeBlock: HTMLElement;
  private readonly statusBlock: HTMLElement;
  private readonly watchersBox: HTMLElement;
  private readonly classGroup: HTMLElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly rules: HTMLElement;
  // Flat frame.
  private readonly main: HTMLElement;
  private readonly head: HTMLElement;
  private readonly teamsRow: HTMLElement;
  private readonly self: HTMLElement;
  private readonly selfActions: HTMLElement;
  private readonly startBox: HTMLElement;
  // Aerie frame.
  private readonly top: HTMLElement;
  private readonly docks: readonly [HTMLElement, HTMLElement];
  private readonly bottom: HTMLElement;
  private readonly youGroup: HTMLElement;
  private readonly hostGroup: HTMLElement;
  private readonly drawer: HTMLElement;
  private readonly rulesToggle: HTMLButtonElement;
  private readonly switchButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly notice: HTMLElement;
  private readonly noticeText: HTMLElement;
  private readonly plates = new LobbyPlates();

  private layout: LobbyLayout = 'flat';
  /** The rules drawer of the aerie layout: local to this screen, like an open dropdown. */
  private drawerOpen = false;
  /** False while the take-off plays (or a match runs): the aerie layout shows a line instead. */
  private controlsShown = true;
  /** The rider in the close-up, as last drawn; NO_PLAYER in the flat layout. */
  private focusId: PlayerId = NO_PLAYER;
  /** The team "Switch side" would move the local rider to, or null. */
  private switchTarget: TeamId | null = null;
  private shownSwitchTarget: TeamId | null = null;
  private shownPhase: LobbyPhase | null = null;
  private readonly noticeCache = { value: '' };

  // The screen area the docked panels leave free for name cards. Measured from the page only
  // after something moved the panels (layout, window size, interface size), never per frame.
  private readonly band: PlateBand = createPlateBand();
  private pendingMeasures = 0;
  private measureAttempts = 0;
  private lastScale = -1;

  // Inputs of the last full refresh: when none changed, `update` returns at once.
  private lastLobby: LobbyState | null = null;
  private lastLocalId: PlayerId = NO_PLAYER;
  private lastIsHost = false;
  private lastBlocker: UiStartBlocker | null | undefined = undefined;
  private lastLayout: LobbyLayout | null = null;
  private lastFocusId: PlayerId = NO_PLAYER;
  private readonly lastPings = new Int16Array(256).fill(-1);

  private readonly codeCache = { value: '' };
  private readonly statusCache = { value: '' };
  private readonly watcherCountCache = { value: '' };
  private readonly readyCache = { value: '' };
  private readonly startNoteCache = { value: '' };
  private readonly ownerCache = { value: '' };
  private shownScore = -1;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Settings of the last refresh, for building intents from clicks. */
  private settings: HostSettings | null = null;

  constructor(onIntent: UiIntentHandler) {
    this.onIntent = onIntent;
    this.root = el('section', 'dfu-screen dfu-lobby df-interactive');
    this.root.setAttribute('aria-label', 'Lobby');

    // --- Header: room code + status ---
    this.head = el('header', 'dfu-lobby-head');
    const head = this.head;
    const codeBlock = el('div', 'dfu-code-block');
    this.codeBlock = codeBlock;
    this.code = el('output', 'dfu-code');
    this.code.setAttribute('aria-label', 'Room code');
    this.copyButton = button('dfu-btn dfu-btn-small', '', 'copyCode');
    this.copyLabel = el('span', '', 'Copy');
    append(this.copyButton, icon('copy'), this.copyLabel);
    const codeLine = el('div', 'dfu-code-line');
    append(codeLine, this.code, this.copyButton);
    append(codeBlock, el('p', 'dfu-overline', 'Room code'), codeLine);
    const statusBlock = el('div', 'dfu-lobby-title');
    this.statusBlock = statusBlock;
    this.status = el('p', 'dfu-lobby-status');
    append(statusBlock, el('h2', 'dfu-heading', 'The Aerie'), this.status);
    append(head, codeBlock, statusBlock);

    // --- Team columns ---
    const teamsRow = el('div', 'dfu-teams');
    this.teamsRow = teamsRow;
    this.teams = [this.buildTeam(TEAM_EMBER, teamsRow), this.buildTeam(TEAM_FROST, teamsRow)];

    // --- Watchers ---
    const watchersBox = el('section', 'dfu-panel dfu-watchers');
    this.watchersBox = watchersBox;
    const watchersHead = el('header', 'dfu-team-head');
    this.watcherCount = el('span', 'dfu-team-count dfu-num');
    this.watchButton = button('dfu-btn dfu-btn-small', 'Watch', 'spectate');
    const watchersTitle = el('h3', 'dfu-team-name', 'Watchers');
    append(watchersHead, icon('eye', 'dfu-team-icon'), watchersTitle, this.watcherCount);
    append(watchersHead, this.watchButton);
    const watcherList = el('ul', 'dfu-watcher-list');
    this.watcherEmpty = el('li', 'dfu-watcher-empty', 'Nobody is watching.');
    watcherList.appendChild(this.watcherEmpty);
    for (let i = 0; i < this.view.spectators.length; i++) {
      const slot = createSlotDom('eye', true);
      slot.row.hidden = true;
      this.watchers.push(slot);
      watcherList.appendChild(slot.row);
    }
    append(watchersBox, watchersHead, watcherList);

    // --- Own controls ---
    const self = el('footer', 'dfu-panel dfu-self');
    this.self = self;
    const classGroup = el('div', 'dfu-classes');
    this.classGroup = classGroup;
    classGroup.setAttribute('role', 'radiogroup');
    classGroup.setAttribute('aria-label', 'Your dragon');
    for (const id of DRAGON_CLASS_IDS) {
      const info = DRAGON_CLASSES[id];
      const node = button('dfu-class', '', 'pickClass');
      node.dataset['class'] = id;
      node.setAttribute('role', 'radio');
      node.setAttribute('aria-checked', 'false');
      append(
        node,
        el('span', 'dfu-class-name', info.name),
        el('span', 'dfu-class-role', info.role),
        el('span', 'dfu-class-detail', info.abilities.primary.name),
      );
      this.classButtons.push(node);
      classGroup.appendChild(node);
    }
    const selfActions = el('div', 'dfu-self-actions');
    this.selfActions = selfActions;
    this.readyButton = button('dfu-btn dfu-btn-primary dfu-ready', '', 'ready');
    this.readyButton.setAttribute('aria-pressed', 'false');
    this.readyLabel = el('span');
    append(this.readyButton, icon('check'), this.readyLabel);
    this.lockNote = el('p', 'dfu-hint dfu-lock-note');
    append(this.lockNote, icon('lock'), el('span', '', 'Teams are locked by the host.'));
    this.lockNote.hidden = true;
    this.leaveButton = button('dfu-btn', 'Leave room', 'leave');
    append(selfActions, this.readyButton, this.leaveButton, this.lockNote);
    append(self, classGroup, selfActions);

    const main = el('div', 'dfu-lobby-main');
    this.main = main;
    append(main, head, teamsRow, watchersBox, self);

    // --- Rules column (host panel) ---
    const rules = el('aside', 'dfu-panel dfu-rules');
    this.rules = rules;
    rules.id = 'dfu-rules';
    rules.setAttribute('aria-label', 'Match rules');
    const rulesHead = el('header', 'dfu-rules-head');
    this.rulesOwner = el('span', 'dfu-hint');
    append(rulesHead, el('h3', 'dfu-heading dfu-heading-small', 'Match rules'), this.rulesOwner);

    const modeGroup = pickGroup(
      'Mode',
      'pickMode',
      MODE_IDS,
      (id) => MODES[id as ModeId].name,
      this.modePicks,
    );
    const mapGroup = pickGroup(
      'Map',
      'pickMap',
      MAP_IDS,
      (id) => MAPS[id as MapId].name,
      this.mapPicks,
    );

    const sizeGroup = el('div', 'dfu-segment');
    sizeGroup.setAttribute('role', 'group');
    sizeGroup.setAttribute('aria-label', 'Riders per team');
    for (let size = 1; size <= MAX_TEAM_SIZE; size++) {
      const node = button('dfu-segment-btn dfu-num', String(size), 'teamSize');
      node.dataset['size'] = String(size);
      node.setAttribute('aria-pressed', 'false');
      node.setAttribute('aria-label', `${size} per team`);
      this.sizeButtons.push(node);
      sizeGroup.appendChild(node);
    }

    this.unevenSwitch = switchButton('uneven', 'Allow uneven teams', 'Even only');
    this.lockSwitch = switchButton('lock', 'Lock teams', 'Open');
    this.fireSwitch = switchButton('friendlyFire', 'Friendly fire', 'Off');

    this.scoreInput = el('input', 'dfu-input dfu-input-number dfu-num');
    this.scoreInput.type = 'number';
    this.scoreInput.inputMode = 'numeric';
    this.scoreInput.min = String(HOST_SETTING_LIMITS.scoreLimitMin);
    this.scoreInput.max = String(HOST_SETTING_LIMITS.scoreLimitMax);
    this.scoreInput.step = '1';
    this.scoreInput.dataset['setting'] = 'scoreLimit';
    this.scoreInput.setAttribute('aria-label', 'Score limit');

    this.timeSelect = el('select', 'dfu-select');
    this.timeSelect.dataset['setting'] = 'timeLimit';
    for (const seconds of TIME_LIMIT_CHOICES_S) {
      const option = el('option', '', formatTimeLimit(seconds));
      option.value = String(seconds);
      this.timeSelect.appendChild(option);
    }
    // Holds a host value that is not one of the listed choices.
    this.timeCustom = el('option');
    this.timeCustom.hidden = true;
    this.timeCustom.disabled = true;
    this.timeSelect.appendChild(this.timeCustom);

    const allowGroup = el('div', 'dfu-allow');
    allowGroup.setAttribute('role', 'group');
    allowGroup.setAttribute('aria-label', 'Allowed dragons');
    for (const id of DRAGON_CLASS_IDS) {
      const node = button('dfu-chip-btn', DRAGON_CLASSES[id].name, 'allowClass');
      node.dataset['class'] = id;
      node.setAttribute('aria-pressed', 'true');
      this.allowButtons.push(node);
      allowGroup.appendChild(node);
    }

    this.hostTools = el('div', 'dfu-row dfu-host-tools');
    this.balanceButton = button('dfu-btn dfu-btn-small', 'Auto-balance', 'autoBalance');
    this.shuffleButton = button('dfu-btn dfu-btn-small', 'Shuffle', 'shuffle');
    append(this.hostTools, this.balanceButton, this.shuffleButton);

    // Bot riders (T-3.10): the host seats them, everyone sees their skill.
    const botLevelGroup = el('div', 'dfu-segment');
    botLevelGroup.setAttribute('role', 'group');
    botLevelGroup.setAttribute('aria-label', 'Bot skill');
    for (const level of BOT_DIFFICULTIES) {
      const node = button('dfu-segment-btn', BOT_LEVEL_LABELS[level], 'botLevel');
      node.dataset['level'] = level;
      node.setAttribute('aria-pressed', 'false');
      this.botLevelButtons.push(node);
      botLevelGroup.appendChild(node);
    }
    this.botTools = el('div', 'dfu-row dfu-host-tools dfu-bot-tools');
    this.addEmberBot = button('dfu-btn dfu-btn-small', '+ Ember bot', 'addBot');
    this.addEmberBot.dataset['side'] = String(TEAM_EMBER);
    this.addFrostBot = button('dfu-btn dfu-btn-small', '+ Frost bot', 'addBot');
    this.addFrostBot.dataset['side'] = String(TEAM_FROST);
    this.fillBotsButton = button('dfu-btn dfu-btn-small', 'Fill with bots', 'fillBots');
    this.clearBotsButton = button('dfu-btn dfu-btn-small', 'Clear bots', 'clearBots');
    append(
      this.botTools,
      this.addEmberBot,
      this.addFrostBot,
      this.fillBotsButton,
      this.clearBotsButton,
    );

    const startBox = el('div', 'dfu-start');
    this.startBox = startBox;
    this.startButton = button('dfu-btn dfu-btn-primary dfu-btn-large', 'Start match', 'start');
    this.startNote = el('p', 'dfu-hint dfu-start-note');
    this.startNote.id = 'dfu-start-note';
    this.startNote.setAttribute('aria-live', 'polite');
    this.startButton.setAttribute('aria-describedby', 'dfu-start-note');
    append(startBox, this.startButton, this.startNote);

    const ruleList = el('div', 'dfu-rule-list');
    append(
      ruleList,
      ruleRow('Mode', modeGroup),
      ruleRow('Map', mapGroup),
      ruleRow('Riders per team', sizeGroup),
      ruleRow('Uneven teams', this.unevenSwitch),
      ruleRow('Lock teams', this.lockSwitch),
      ruleRow('Score to win', this.scoreInput),
      ruleRow('Time limit', this.timeSelect),
      ruleRow('Friendly fire', this.fireSwitch),
      ruleRow('Dragons', allowGroup),
      ruleRow('Bot skill', botLevelGroup),
    );
    // Aerie layout: the move / remove buttons only appear on a roster row that is pointed at
    // or focused (the rows are narrow), so the host panel says where they are.
    this.rosterHint = el(
      'p',
      'dfu-hint dfa-roster-hint',
      'To move or remove a rider, point at their row in the rosters.',
    );
    this.rosterHint.hidden = true;
    append(rules, rulesHead, ruleList, this.hostTools, this.botTools, this.rosterHint, startBox);

    // --- Aerie frame: built now, filled by `setLayout` when a state asks for it ---
    this.top = el('header', 'dfu-panel dfa-top df-interactive');
    const emberDock = el('div', 'dfa-dock df-interactive');
    emberDock.dataset['side'] = 'ember';
    const frostDock = el('div', 'dfa-dock df-interactive');
    frostDock.dataset['side'] = 'frost';
    this.docks = [emberDock, frostDock];

    this.bottom = el('footer', 'dfu-panel dfa-bottom df-interactive');
    this.youGroup = el('div', 'dfa-you');
    this.hostGroup = el('div', 'dfa-host');
    this.switchButton = button('dfu-btn', 'Switch side', 'switchSide');
    this.switchButton.hidden = true;
    this.rulesToggle = button('dfu-btn dfa-rules-toggle', 'Match rules', 'rulesToggle');
    this.rulesToggle.setAttribute('aria-expanded', 'false');
    this.rulesToggle.setAttribute('aria-controls', 'dfu-rules');
    this.drawer = el('div', 'dfa-drawer');
    this.drawer.hidden = true;
    const closeDrawer = button('dfu-icon-btn dfa-drawer-close', '', 'rulesClose');
    closeDrawer.setAttribute('aria-label', 'Close the match rules');
    closeDrawer.title = 'Close';
    closeDrawer.appendChild(icon('cross'));
    this.drawer.appendChild(closeDrawer);
    append(this.bottom, this.youGroup, this.hostGroup);

    this.backButton = button('dfu-btn dfu-btn-small dfa-back df-interactive', 'Back to the aerie', 'focusBack');
    this.backButton.hidden = true;
    this.notice = el('div', 'dfa-notice');
    this.notice.setAttribute('role', 'status');
    this.notice.hidden = true;
    this.noticeText = el('p', 'dfa-notice-text');
    append(this.notice, el('p', 'dfu-overline', 'The Aerie'), this.noticeText);

    append(this.root, main, rules);

    // A resize moves the docked panels: the name cards' free area is measured again.
    window.addEventListener('resize', this.onResize);

    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('change', this.onChange);
  }

  update(state: UiState): void {
    const lobby = state.lobby;
    if (lobby === null) return;
    const layout = lobbyLayoutFor(state.aerie);
    if (layout !== this.layout) this.setLayout(layout);
    const aerie = layout === 'aerie';
    // The close-up belongs to the 3D aerie: without it nothing is highlighted.
    const focusId = aerie ? (state.lobbyFocusId ?? NO_PLAYER) : NO_PLAYER;
    const lobbyChanged = lobby !== this.lastLobby;
    this.refresh(state, lobby, layout, focusId);
    if (!aerie) return;

    // Name cards follow the perches, so this part runs every frame (see lobby-plates.ts).
    const scale = state.settings.uiScale ?? 1;
    if (scale !== this.lastScale) {
      this.lastScale = scale;
      this.requestMeasure();
    }
    if (this.pendingMeasures > 0) this.measureBand();
    this.plates.update(state, lobby, lobbyChanged, this.band, focusId);
  }

  /**
   * Escape in the aerie layout: close the rules drawer, else leave the close-up. Returns true
   * when it did something (the screen manager then keeps the key from doing anything else).
   */
  handleEscape(): boolean {
    if (this.layout !== 'aerie' || !this.controlsShown) return false;
    if (this.drawerOpen) {
      this.setDrawer(false);
      this.rulesToggle.focus();
      return true;
    }
    if (this.focusId !== NO_PLAYER) {
      this.onIntent({ type: 'lobby.focusPlayer', playerId: null });
      return true;
    }
    return false;
  }

  /** Everything that only changes when the lobby does. Returns at once when nothing did. */
  private refresh(state: UiState, lobby: LobbyState, layout: LobbyLayout, focusId: PlayerId): void {
    const connection = state.connection;
    const pings = state.playerPings;
    const blocker = state.startBlocker;
    if (
      lobby === this.lastLobby &&
      connection.localPlayerId === this.lastLocalId &&
      connection.isHost === this.lastIsHost &&
      blocker === this.lastBlocker &&
      layout === this.lastLayout &&
      focusId === this.lastFocusId &&
      !this.pingsChanged(lobby, pings)
    ) {
      return;
    }
    this.lastLobby = lobby;
    this.lastLocalId = connection.localPlayerId;
    this.lastIsHost = connection.isHost;
    this.lastBlocker = blocker;
    this.lastLayout = layout;
    this.lastFocusId = focusId;
    this.focusId = focusId;
    this.rememberPings(lobby, pings);
    const aerie = layout === 'aerie';

    const view = computeLobbyView(
      this.view,
      lobby,
      connection.localPlayerId,
      connection.isHost,
      pings,
    );
    const settings = lobby.settings;
    this.settings = settings;

    setText(this.code, this.codeCache, lobby.roomCode);
    setDisabled(this.copyButton, lobby.roomCode === '');
    const emberCount = view.counts[TEAM_EMBER];
    const frostCount = view.counts[TEAM_FROST];
    setText(
      this.status,
      this.statusCache,
      `${PHASE_TEXT[lobby.phase]}  ·  ${MODES[settings.mode].name} on ${MAPS[settings.map].name}  ·  ${emberCount} v ${frostCount}`,
    );

    for (let team = 0; team < 2; team++) {
      const dom = this.teams[team as TeamId];
      const slots = view.teams[team as TeamId];
      for (let i = 0; i < dom.slots.length; i++) {
        const slotDom = dom.slots[i];
        const slotView = slots[i];
        if (slotDom === undefined || slotView === undefined) continue;
        applySlot(slotDom, slotView);
        const focused =
          focusId !== NO_PLAYER && slotView.kind === SLOT_PLAYER && slotView.playerId === focusId;
        if (focused !== slotDom.focused) {
          slotDom.focused = focused;
          slotDom.row.dataset['focus'] = focused ? '1' : '0';
          slotDom.focus?.setAttribute('aria-pressed', focused ? 'true' : 'false');
        }
      }
      setText(dom.count, dom.countCache, `${view.counts[team as TeamId]} / ${view.teamSize}`);
      setDisabled(dom.join, !view.canJoin[team as TeamId]);
      const onTeam = view.localSide === team;
      if (dom.join.hidden !== onTeam) dom.join.hidden = onTeam;
    }

    for (let i = 0; i < this.watchers.length; i++) {
      const slotDom = this.watchers[i];
      const slotView = view.spectators[i];
      if (slotDom !== undefined && slotView !== undefined) applySlot(slotDom, slotView);
    }
    setText(this.watcherCount, this.watcherCountCache, String(view.spectatorCount));
    const noWatchers = view.spectatorCount === 0;
    if (this.watcherEmpty.hidden === noWatchers) this.watcherEmpty.hidden = !noWatchers;
    setDisabled(this.watchButton, !view.canSpectate);
    const watching = view.localSide === 'spectator';
    if (this.watchButton.hidden !== watching) this.watchButton.hidden = watching;

    // Own controls.
    for (const node of this.classButtons) {
      const id = node.dataset['class'];
      if (!isDragonClassId(id)) continue;
      setPressed(node, 'aria-checked', view.localSide !== null && view.localClassId === id);
      setDisabled(
        node,
        !view.editable || view.localSide === null || !settings.allowedClasses.includes(id),
      );
    }
    setDisabled(this.readyButton, !view.canReady);
    setPressed(this.readyButton, 'aria-pressed', view.localReady);
    setText(
      this.readyLabel,
      this.readyCache,
      view.localSide === 'spectator' ? 'Watching' : view.localReady ? 'Ready' : 'Ready up',
    );
    const showLock = settings.teamsLocked && view.editable;
    if (this.lockNote.hidden === showLock) this.lockNote.hidden = !showLock;
    // Aerie layout: one button to cross to the other order (watchers use the rosters' Join).
    const side = view.localSide;
    const other = side === TEAM_EMBER ? TEAM_FROST : side === TEAM_FROST ? TEAM_EMBER : null;
    this.switchTarget = other;
    if (this.switchButton.hidden === (other !== null)) this.switchButton.hidden = other === null;
    setDisabled(this.switchButton, other === null || !view.canJoin[other]);
    if (other !== null && other !== this.shownSwitchTarget) {
      this.shownSwitchTarget = other;
      this.switchButton.setAttribute('aria-label', `Switch to ${TEAMS[other].name}`);
      this.switchButton.title = `Switch to ${TEAMS[other].name}`;
    }

    // Rules column.
    const canEdit = view.localIsHost && view.editable;
    setText(
      this.rulesOwner,
      this.ownerCache,
      view.localIsHost ? 'You are the host' : 'Set by the host',
    );
    for (const pick of this.modePicks) {
      applyPick(pick, MODES[pick.id as ModeId].available, pick.id === settings.mode, canEdit);
    }
    for (const pick of this.mapPicks) {
      applyPick(pick, MAPS[pick.id as MapId].available, pick.id === settings.map, canEdit);
    }
    const range = teamSizeRange(settings.mode);
    for (let i = 0; i < this.sizeButtons.length; i++) {
      const node = this.sizeButtons[i];
      if (node === undefined) continue;
      const size = i + 1;
      setPressed(node, 'aria-pressed', size === view.teamSize);
      setDisabled(node, !canEdit || size < range.min || size > range.max);
    }
    this.applySwitch(this.unevenSwitch, settings.unevenTeams, canEdit, 'Allowed', 'Even only');
    this.applySwitch(this.lockSwitch, settings.teamsLocked, canEdit, 'Locked', 'Open');
    this.applySwitch(this.fireSwitch, settings.friendlyFire, canEdit, 'On', 'Off');
    if (this.shownScore !== settings.scoreLimit) {
      this.shownScore = settings.scoreLimit;
      this.scoreInput.value = String(settings.scoreLimit);
    }
    setDisabled(this.scoreInput, !canEdit);
    this.applyTimeLimit(settings.timeLimitS);
    setDisabled(this.timeSelect, !canEdit);
    const allowed = settings.allowedClasses;
    for (const node of this.allowButtons) {
      const id = node.dataset['class'];
      if (!isDragonClassId(id)) continue;
      const on = allowed.includes(id);
      setPressed(node, 'aria-pressed', on);
      // The last allowed dragon cannot be switched off.
      setDisabled(node, !canEdit || (on && allowed.length === 1));
    }
    if (this.hostTools.hidden === view.localIsHost) this.hostTools.hidden = !view.localIsHost;
    const canArrange = canEdit && !settings.teamsLocked;
    setDisabled(this.balanceButton, !canArrange);
    setDisabled(this.shuffleButton, !canArrange);
    for (const node of this.botLevelButtons) {
      setPressed(node, 'aria-pressed', node.dataset['level'] === settings.botDifficulty);
      setDisabled(node, !canEdit);
    }
    if (this.botTools.hidden === view.localIsHost) this.botTools.hidden = !view.localIsHost;
    const showRosterHint = aerie && view.localIsHost;
    if (this.rosterHint.hidden === showRosterHint) this.rosterHint.hidden = !showRosterHint;
    let ember = 0;
    let frost = 0;
    let bots = 0;
    for (const player of lobby.players) {
      if (player.side === TEAM_EMBER) ember++;
      else if (player.side === TEAM_FROST) frost++;
      if (player.isBot) bots++;
    }
    const size = settings.teamSize;
    setDisabled(this.addEmberBot, !canEdit || ember >= size);
    setDisabled(this.addFrostBot, !canEdit || frost >= size);
    setDisabled(this.fillBotsButton, !canEdit || (ember >= size && frost >= size));
    setDisabled(this.clearBotsButton, !canEdit || bots === 0);
    if (this.startButton.hidden === view.localIsHost) this.startButton.hidden = !view.localIsHost;
    setDisabled(this.startButton, !canEdit || (blocker !== null && blocker !== undefined));
    setText(
      this.startNote,
      this.startNoteCache,
      lobby.phase === 'lobby'
        ? describeStart(blocker, view.localIsHost, view.memberCount)
        : PHASE_TEXT[lobby.phase],
    );

    // Aerie layout: while the take-off plays the controls give way to one line.
    if (lobby.phase !== this.shownPhase) {
      this.shownPhase = lobby.phase;
      this.root.dataset['phase'] = lobby.phase;
    }
    const notice = aerie ? aerieNotice(lobby.phase) : '';
    const controls = notice === '';
    if (controls !== this.controlsShown) {
      this.controlsShown = controls;
      this.bottom.hidden = !controls;
      this.notice.hidden = controls;
      this.applyDrawer();
      // The bottom bar came or went: the name cards' free area changed with it.
      this.requestMeasure();
    }
    if (!controls) setText(this.noticeText, this.noticeCache, notice);
    const showBack = aerie && controls && focusId !== NO_PLAYER;
    if (this.backButton.hidden === showBack) this.backButton.hidden = !showBack;
    for (let team = 0; team < 2; team++) {
      for (const slot of this.teams[team as TeamId].slots) {
        if (slot.focus !== null) setDisabled(slot.focus, !controls);
      }
    }
  }

  dispose(): void {
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    window.removeEventListener('resize', this.onResize);
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('change', this.onChange);
    this.root.remove();
  }

  /**
   * Moves the shared controls into one layout's frame. Appending a node that is already in the
   * page moves it, so nothing is rebuilt and every control keeps its state.
   */
  private setLayout(layout: LobbyLayout): void {
    this.layout = layout;
    const ember = this.teams[TEAM_EMBER].box;
    const frost = this.teams[TEAM_FROST].box;
    if (layout === 'aerie') {
      append(this.top, this.codeBlock, this.statusBlock, this.leaveButton);
      append(this.docks[0], ember, this.watchersBox);
      append(this.docks[1], frost);
      append(this.youGroup, this.classGroup, this.readyButton, this.switchButton, this.lockNote);
      // Reading order: why Start is unavailable, the rules (the drawer opens right after its
      // button, so Tab walks into it), then Start.
      this.drawer.appendChild(this.rules);
      append(this.hostGroup, this.startNote, this.rulesToggle, this.drawer, this.startButton);
      this.root.replaceChildren(
        this.top,
        this.docks[0],
        this.docks[1],
        this.plates.root,
        this.backButton,
        this.notice,
        this.bottom,
      );
      // The frame itself must let the pointer through to the scene; its panels take it.
      this.root.classList.remove('df-interactive');
    } else {
      append(this.head, this.codeBlock, this.statusBlock);
      append(this.teamsRow, ember, frost);
      append(this.selfActions, this.readyButton, this.leaveButton, this.lockNote);
      append(this.self, this.classGroup, this.selfActions);
      append(this.main, this.head, this.teamsRow, this.watchersBox, this.self);
      append(this.startBox, this.startButton, this.startNote);
      this.root.replaceChildren(this.main, this.rules);
      this.root.classList.add('df-interactive');
    }
    this.root.dataset['layout'] = layout;
    this.applyDrawer();
    this.requestMeasure();
  }

  private setDrawer(open: boolean): void {
    if (open === this.drawerOpen) return;
    this.drawerOpen = open;
    this.applyDrawer();
  }

  /** The drawer shows when it is open, in the aerie layout, while the controls are up. */
  private applyDrawer(): void {
    const show = this.drawerOpen && this.controlsShown && this.layout === 'aerie';
    const hidden = this.layout === 'aerie' && !show;
    if (this.drawer.hidden !== hidden) this.drawer.hidden = hidden;
    setPressed(this.rulesToggle, 'aria-expanded', show);
  }

  private requestMeasure(): void {
    this.pendingMeasures = BAND_MEASURES;
    this.measureAttempts = 0;
  }

  /**
   * Reads where the docked panels end, to know the area left for name cards. A layout read, so
   * it only runs a few frames after something moved the panels: more than one because the
   * interface-size variable and the first reveal land a frame after the state that announced
   * them. `offset*` values ignore transforms, so the panels' slide-in does not skew them.
   */
  private measureBand(): void {
    const root = this.root;
    const left = this.docks[0];
    const right = this.docks[1];
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
    const em = style === null ? Number.NaN : parseFloat(style.fontSize);
    const gap = PLATE_GAP_EM * em;
    const height = root.clientHeight;
    const usable = measurePlateBand(
      this.band,
      root.clientWidth,
      height,
      left.offsetLeft + left.offsetWidth + gap,
      right.offsetLeft - gap,
      this.top.offsetTop + this.top.offsetHeight + gap,
      this.controlsShown ? this.bottom.offsetTop - gap : height,
      PLATE_WIDTH_EM * em,
      PLATE_HEIGHT_EM * em,
    );
    this.measureAttempts += 1;
    // Hidden (not revealed yet) measures as nothing: try again next frame, but not for ever.
    if (usable || this.measureAttempts >= BAND_MEASURE_ATTEMPTS) this.pendingMeasures -= 1;
    if (this.measureAttempts >= BAND_MEASURE_ATTEMPTS) this.pendingMeasures = 0;
  }

  private readonly onResize = (): void => {
    if (this.layout === 'aerie') this.requestMeasure();
  };

  private buildTeam(team: TeamId, parent: HTMLElement): TeamDom {
    const info = TEAMS[team];
    const box = el('section', 'dfu-panel dfu-team');
    box.dataset['team'] = info.key;
    const head = el('header', 'dfu-team-head');
    const count = el('span', 'dfu-team-count dfu-num');
    const join = button(
      'dfu-btn dfu-btn-small',
      'Join',
      team === TEAM_EMBER ? 'joinEmber' : 'joinFrost',
    );
    join.setAttribute('aria-label', `Join ${info.name}`);
    append(head, icon(TEAM_ICON[team], 'dfu-team-icon'), el('h3', 'dfu-team-name', info.name));
    append(head, count, join);
    const list = el('ol', 'dfu-slots');
    const slots: SlotDom[] = [];
    for (let i = 0; i < MAX_TEAM_SIZE; i++) {
      const slot = createSlotDom(TEAM_ICON[team], false);
      slots.push(slot);
      list.appendChild(slot.row);
    }
    append(box, head, list);
    parent.appendChild(box);
    return { box, count, countCache: { value: '' }, join, slots };
  }

  private applySwitch(
    node: HTMLButtonElement,
    on: boolean,
    canEdit: boolean,
    onText: string,
    offText: string,
  ): void {
    const checked = on ? 'true' : 'false';
    if (node.getAttribute('aria-checked') !== checked) {
      node.setAttribute('aria-checked', checked);
      const label = node.lastElementChild;
      if (label !== null) label.textContent = on ? onText : offText;
    }
    setDisabled(node, !canEdit);
  }

  private applyTimeLimit(seconds: number): void {
    const value = String(seconds);
    if (this.timeSelect.value === value && this.timeSelect.selectedIndex >= 0) return;
    if (TIME_LIMIT_CHOICES_S.includes(seconds)) {
      this.timeCustom.hidden = true;
    } else {
      this.timeCustom.value = value;
      this.timeCustom.textContent = formatTimeLimit(seconds);
      this.timeCustom.hidden = false;
    }
    this.timeSelect.value = value;
  }

  private pingsChanged(lobby: LobbyState, pings: readonly number[] | undefined): boolean {
    const players = lobby.players;
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (player === undefined) continue;
      if (this.lastPings[player.id & 0xff] !== roundPing(pings?.[player.id])) return true;
    }
    return false;
  }

  private rememberPings(lobby: LobbyState, pings: readonly number[] | undefined): void {
    const players = lobby.players;
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (player !== undefined) this.lastPings[player.id & 0xff] = roundPing(pings?.[player.id]);
    }
  }

  private playerIdOf(target: Element): PlayerId | null {
    const row = target.closest('[data-pid]');
    if (!(row instanceof HTMLElement)) return null;
    const id = Number(row.dataset['pid']);
    return Number.isInteger(id) ? id : null;
  }

  private move(target: Element, side: LobbySide): void {
    const playerId = this.playerIdOf(target);
    if (playerId !== null) this.onIntent({ type: 'host.movePlayer', playerId, side });
  }

  private readonly onClick = (event: Event): void => {
    const target = actionTarget(event);
    if (target === null || target.disabled) return;
    const settings = this.settings;
    switch (target.dataset['act']) {
      case 'copyCode':
        this.copyCode();
        break;
      case 'joinEmber':
        this.onIntent({ type: 'lobby.switchSide', side: TEAM_EMBER });
        break;
      case 'joinFrost':
        this.onIntent({ type: 'lobby.switchSide', side: TEAM_FROST });
        break;
      case 'spectate':
        this.onIntent({ type: 'lobby.switchSide', side: 'spectator' });
        break;
      case 'ready':
        this.onIntent({ type: 'lobby.ready', ready: !this.view.localReady });
        break;
      case 'leave':
        this.onIntent({ type: 'lobby.leave' });
        break;
      case 'pickClass': {
        const id = target.dataset['class'];
        if (isDragonClassId(id)) this.onIntent({ type: 'lobby.pickClass', classId: id });
        break;
      }
      case 'moveEmber':
        this.move(target, TEAM_EMBER);
        break;
      case 'moveFrost':
        this.move(target, TEAM_FROST);
        break;
      case 'moveWatch':
        this.move(target, 'spectator');
        break;
      case 'kick': {
        const playerId = this.playerIdOf(target);
        if (playerId === null) break;
        const player = this.lastLobby?.players.find((other) => other.id === playerId);
        // A bot the host seated has no connection to kick: it is simply taken out. (An in-page
        // `?bots=N` client refuses that and is kicked like anyone else.)
        if (player !== undefined && player.isBot) {
          this.onIntent({ type: 'host.removeBot', playerId });
        }
        this.onIntent({ type: 'host.kick', playerId });
        break;
      }
      case 'botLevel': {
        const level = target.dataset['level'];
        if (isBotDifficulty(level)) {
          this.onIntent({ type: 'host.setBotDifficulty', difficulty: level });
        }
        break;
      }
      case 'addBot': {
        const side = Number(target.dataset['side']);
        if (isBotSide(side)) this.onIntent({ type: 'host.addBot', side });
        break;
      }
      case 'fillBots':
        this.onIntent({ type: 'host.fillBots' });
        break;
      case 'clearBots':
        this.onIntent({ type: 'host.clearBots' });
        break;
      case 'teamSize': {
        const teamSize = Number(target.dataset['size']);
        if (Number.isInteger(teamSize)) this.onIntent({ type: 'host.setTeamSize', teamSize });
        break;
      }
      case 'uneven':
        if (settings !== null) {
          this.onIntent({ type: 'host.setUnevenTeams', enabled: !settings.unevenTeams });
        }
        break;
      case 'lock':
        if (settings !== null) {
          this.onIntent({ type: 'host.lockTeams', locked: !settings.teamsLocked });
        }
        break;
      case 'friendlyFire':
        if (settings !== null) {
          this.onIntent({ type: 'host.setFriendlyFire', enabled: !settings.friendlyFire });
        }
        break;
      case 'allowClass': {
        const id = target.dataset['class'];
        if (settings === null || !isDragonClassId(id)) break;
        const current = settings.allowedClasses;
        const classes = DRAGON_CLASS_IDS.filter((other) =>
          other === id ? !current.includes(other) : current.includes(other),
        );
        if (classes.length > 0) this.onIntent({ type: 'host.setAllowedClasses', classes });
        break;
      }
      case 'autoBalance':
        this.onIntent({ type: 'host.autoBalance' });
        break;
      case 'shuffle':
        this.onIntent({ type: 'host.shuffle' });
        break;
      case 'start':
        this.onIntent({ type: 'host.start' });
        break;
      case 'pickMode': {
        const mode = target.dataset['pick'];
        if (mode !== undefined && mode in MODES && MODES[mode as ModeId].available) {
          this.onIntent({ type: 'host.setMode', mode: mode as ModeId });
        }
        break;
      }
      case 'pickMap': {
        const map = target.dataset['pick'];
        if (map !== undefined && map in MAPS && MAPS[map as MapId].available) {
          this.onIntent({ type: 'host.setMap', map: map as MapId });
        }
        break;
      }
      case 'switchSide':
        if (this.switchTarget !== null) {
          this.onIntent({ type: 'lobby.switchSide', side: this.switchTarget });
        }
        break;
      // A rider's row or name card: frame them, or let go if they are already framed.
      case 'focusRow':
      case 'focusPlate': {
        const playerId = this.playerIdOf(target);
        if (playerId === null || this.layout !== 'aerie' || !this.controlsShown) break;
        this.onIntent({ type: 'lobby.focusPlayer', playerId: focusTarget(this.focusId, playerId) });
        break;
      }
      case 'focusBack':
        this.onIntent({ type: 'lobby.focusPlayer', playerId: null });
        break;
      case 'rulesToggle':
        this.setDrawer(!this.drawerOpen);
        break;
      case 'rulesClose':
        this.setDrawer(false);
        this.rulesToggle.focus();
        break;
      default:
        break;
    }
  };

  private readonly onChange = (event: Event): void => {
    const target = event.target;
    // A control now shows what the player picked, not what the host holds. Forget the last
    // refresh so the next update writes the real value back if the host refuses or clamps it.
    this.lastLobby = null;
    if (target === this.timeSelect) {
      const timeLimitS = Number(this.timeSelect.value);
      if (Number.isFinite(timeLimitS)) this.onIntent({ type: 'host.setTimeLimit', timeLimitS });
    } else if (target === this.scoreInput) {
      const raw = Number(this.scoreInput.value);
      // The host clamps too; clamping here keeps the field from showing a refused value.
      const scoreLimit = Number.isFinite(raw)
        ? Math.min(
            HOST_SETTING_LIMITS.scoreLimitMax,
            Math.max(HOST_SETTING_LIMITS.scoreLimitMin, Math.round(raw)),
          )
        : (this.settings?.scoreLimit ?? HOST_SETTING_LIMITS.scoreLimitMin);
      this.shownScore = -1;
      this.onIntent({ type: 'host.setScoreLimit', scoreLimit });
    }
  };

  private copyCode(): void {
    const code = this.codeCache.value;
    if (code === '') return;
    copyText(code, (ok) => {
      this.copyLabel.textContent = ok ? 'Copied' : 'Copy failed';
      if (this.copyTimer !== null) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copyTimer = null;
        this.copyLabel.textContent = 'Copy';
      }, COPY_FEEDBACK_MS);
    });
  }
}

function roundPing(ping: number | undefined): number {
  if (ping === undefined || !(ping >= 0)) return -1;
  return Math.min(999, Math.round(ping));
}
