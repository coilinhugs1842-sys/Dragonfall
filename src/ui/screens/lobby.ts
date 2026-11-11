/**
 * Temporary 2D lobby panel (T-2.8). The cinematic aerie replaces the backdrop in Phase 5; the
 * rules column on the right is the basis of the host panel and stays.
 *
 * Everything is built once: 2 × MAX_TEAM_SIZE perch rows, MAX_LOBBY_MEMBERS watcher rows and the
 * rules controls. `update` refills a reused LobbyView and writes only the cells whose value
 * changed. One delegated click listener turns `data-act` buttons into intents.
 */

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

const MODE_IDS = Object.keys(MODES) as ModeId[];
const MAP_IDS = Object.keys(MAPS) as MapId[];
const TEAM_ICON: Readonly<Record<TeamId, IconName>> = {
  [TEAM_EMBER]: TEAMS[TEAM_EMBER].icon,
  [TEAM_FROST]: TEAMS[TEAM_FROST].icon,
};
const COPY_FEEDBACK_MS = 1600;
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
  readonly isWatcher: boolean;
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
    isWatcher,
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

interface TeamDom {
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
  private readonly modeSelect: HTMLSelectElement;
  private readonly mapSelect: HTMLSelectElement;
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
  private readonly startButton: HTMLButtonElement;
  private readonly startNote: HTMLElement;

  // Inputs of the last full refresh: when none changed, `update` returns at once.
  private lastLobby: LobbyState | null = null;
  private lastLocalId: PlayerId = NO_PLAYER;
  private lastIsHost = false;
  private lastBlocker: UiStartBlocker | null | undefined = undefined;
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
    const head = el('header', 'dfu-lobby-head');
    const codeBlock = el('div', 'dfu-code-block');
    this.code = el('output', 'dfu-code');
    this.code.setAttribute('aria-label', 'Room code');
    this.copyButton = button('dfu-btn dfu-btn-small', '', 'copyCode');
    this.copyLabel = el('span', '', 'Copy');
    append(this.copyButton, icon('copy'), this.copyLabel);
    const codeLine = el('div', 'dfu-code-line');
    append(codeLine, this.code, this.copyButton);
    append(codeBlock, el('p', 'dfu-overline', 'Room code'), codeLine);
    const statusBlock = el('div', 'dfu-lobby-title');
    this.status = el('p', 'dfu-lobby-status');
    append(statusBlock, el('h2', 'dfu-heading', 'The Aerie'), this.status);
    append(head, codeBlock, statusBlock);

    // --- Team columns ---
    const teamsRow = el('div', 'dfu-teams');
    this.teams = [this.buildTeam(TEAM_EMBER, teamsRow), this.buildTeam(TEAM_FROST, teamsRow)];

    // --- Watchers ---
    const watchersBox = el('section', 'dfu-panel dfu-watchers');
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
    const classGroup = el('div', 'dfu-classes');
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
    this.readyButton = button('dfu-btn dfu-btn-primary dfu-ready', '', 'ready');
    this.readyButton.setAttribute('aria-pressed', 'false');
    this.readyLabel = el('span');
    append(this.readyButton, icon('check'), this.readyLabel);
    this.lockNote = el('p', 'dfu-hint dfu-lock-note');
    append(this.lockNote, icon('lock'), el('span', '', 'Teams are locked by the host.'));
    this.lockNote.hidden = true;
    append(selfActions, this.readyButton, button('dfu-btn', 'Leave room', 'leave'), this.lockNote);
    append(self, classGroup, selfActions);

    const main = el('div', 'dfu-lobby-main');
    append(main, head, teamsRow, watchersBox, self);

    // --- Rules column (host panel) ---
    const rules = el('aside', 'dfu-panel dfu-rules');
    rules.setAttribute('aria-label', 'Match rules');
    const rulesHead = el('header', 'dfu-rules-head');
    this.rulesOwner = el('span', 'dfu-hint');
    append(rulesHead, el('h3', 'dfu-heading dfu-heading-small', 'Match rules'), this.rulesOwner);

    this.modeSelect = el('select', 'dfu-select');
    this.modeSelect.dataset['setting'] = 'mode';
    for (const id of MODE_IDS) {
      const option = el(
        'option',
        '',
        MODES[id].available ? MODES[id].name : `${MODES[id].name} (later)`,
      );
      option.value = id;
      option.disabled = !MODES[id].available;
      this.modeSelect.appendChild(option);
    }
    this.mapSelect = el('select', 'dfu-select');
    this.mapSelect.dataset['setting'] = 'map';
    for (const id of MAP_IDS) {
      const option = el(
        'option',
        '',
        MAPS[id].available ? MAPS[id].name : `${MAPS[id].name} (later)`,
      );
      option.value = id;
      option.disabled = !MAPS[id].available;
      this.mapSelect.appendChild(option);
    }

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
    this.startButton = button('dfu-btn dfu-btn-primary dfu-btn-large', 'Start match', 'start');
    this.startNote = el('p', 'dfu-hint dfu-start-note');
    this.startNote.id = 'dfu-start-note';
    this.startNote.setAttribute('aria-live', 'polite');
    this.startButton.setAttribute('aria-describedby', 'dfu-start-note');
    append(startBox, this.startButton, this.startNote);

    const ruleList = el('div', 'dfu-rule-list');
    append(
      ruleList,
      ruleRow('Mode', this.modeSelect),
      ruleRow('Map', this.mapSelect),
      ruleRow('Riders per team', sizeGroup),
      ruleRow('Uneven teams', this.unevenSwitch),
      ruleRow('Lock teams', this.lockSwitch),
      ruleRow('Score to win', this.scoreInput),
      ruleRow('Time limit', this.timeSelect),
      ruleRow('Friendly fire', this.fireSwitch),
      ruleRow('Dragons', allowGroup),
      ruleRow('Bot skill', botLevelGroup),
    );
    append(rules, rulesHead, ruleList, this.hostTools, this.botTools, startBox);

    append(this.root, main, rules);

    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('change', this.onChange);
  }

  update(state: UiState): void {
    const lobby = state.lobby;
    if (lobby === null) return;
    const connection = state.connection;
    const pings = state.playerPings;
    const blocker = state.startBlocker;
    if (
      lobby === this.lastLobby &&
      connection.localPlayerId === this.lastLocalId &&
      connection.isHost === this.lastIsHost &&
      blocker === this.lastBlocker &&
      !this.pingsChanged(lobby, pings)
    ) {
      return;
    }
    this.lastLobby = lobby;
    this.lastLocalId = connection.localPlayerId;
    this.lastIsHost = connection.isHost;
    this.lastBlocker = blocker;
    this.rememberPings(lobby, pings);

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
        if (slotDom !== undefined && slotView !== undefined) applySlot(slotDom, slotView);
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

    // Rules column.
    const canEdit = view.localIsHost && view.editable;
    setText(
      this.rulesOwner,
      this.ownerCache,
      view.localIsHost ? 'You are the host' : 'Set by the host',
    );
    if (this.modeSelect.value !== settings.mode) this.modeSelect.value = settings.mode;
    setDisabled(this.modeSelect, !canEdit);
    if (this.mapSelect.value !== settings.map) this.mapSelect.value = settings.map;
    setDisabled(this.mapSelect, !canEdit);
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
  }

  dispose(): void {
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('change', this.onChange);
    this.root.remove();
  }

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
    return { count, countCache: { value: '' }, join, slots };
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
      default:
        break;
    }
  };

  private readonly onChange = (event: Event): void => {
    const target = event.target;
    // A control now shows what the player picked, not what the host holds. Forget the last
    // refresh so the next update writes the real value back if the host refuses or clamps it.
    this.lastLobby = null;
    if (target === this.modeSelect) {
      const mode = this.modeSelect.value;
      if (mode in MODES) this.onIntent({ type: 'host.setMode', mode: mode as ModeId });
    } else if (target === this.mapSelect) {
      const map = this.mapSelect.value;
      if (map in MAPS) this.onIntent({ type: 'host.setMap', map: map as MapId });
    } else if (target === this.timeSelect) {
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
