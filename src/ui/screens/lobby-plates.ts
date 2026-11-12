/**
 * Name cards over the perches of the aerie (T-5.2): one card per rider, floating where the 3D
 * scene says that rider's dragon is. The scene projects the perches (`UiState.lobbyPlates`);
 * this draws the name, class, team and marks, looked up in the lobby by player id.
 *
 * Cost: the perches drift with the camera, so cards move every frame. The pool is fixed
 * (PLATE_POOL_SIZE nodes, built here once). A frame writes at most two CSS variables per card
 * that moved, from ready-made string tables; text is rewritten only when the lobby object, the
 * card's rider or the local player changed. Positioning is `transform` only: each card sits in
 * a viewport-sized box that is translated by a percentage of itself, so a viewport fraction
 * goes straight into CSS and nothing is read back from the page.
 *
 * The cards are a pointer shortcut for "look at this rider". The roster rows carry the same
 * names, marks and action for the keyboard and for screen readers, so the cards are kept out of
 * the tab order and the accessibility tree rather than announcing every rider twice.
 */

import { DRAGON_CLASSES } from '../../shared/classes';
import type { DragonClassId } from '../../shared/classes';
import type { PlayerId, TeamId } from '../../shared/constants';
import { NO_PLAYER, TEAMS, TEAM_EMBER, TEAM_FROST } from '../../shared/constants';
import type { LobbyState } from '../../shared/lobby';
import type { UiState } from '../../shared/ui';
import { append, button, el, icon } from '../dom';
import { liveCount } from '../hud/hud-model';
import type { PlateBand, PlatePlacement } from '../view-model/aerie-view';
import {
  PLATE_PERCENT_STRINGS,
  PLATE_POOL_SIZE,
  PLATE_SCALE_STRINGS,
  createPlatePlacement,
  findLobbyPlayer,
  placePlate,
} from '../view-model/aerie-view';

type PlateState = 'ready' | 'waiting' | 'away';

interface PlateDom {
  /** Viewport-sized box; its translate is the card's anchor. */
  readonly wrap: HTMLElement;
  readonly card: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly classLabel: HTMLElement;
  readonly hostBadge: HTMLElement;
  readonly youBadge: HTMLElement;
  readonly botBadge: HTMLElement;
  // Last values written.
  shown: boolean;
  xStep: number;
  yStep: number;
  scaleStep: number;
  /** The rider this card was last filled for, and whether the lobby knows them. */
  playerId: PlayerId;
  known: boolean;
  shownName: string;
  classId: DragonClassId | null;
  team: TeamId | null;
  state: PlateState | null;
  isHost: boolean;
  isLocal: boolean;
  isBot: boolean;
  focused: boolean;
}

function createPlate(): PlateDom {
  const wrap = el('div', 'dfa-plate-wrap');
  wrap.hidden = true;
  const card = button('dfa-plate', '', 'focusPlate');
  card.tabIndex = -1;
  const mark = el('span', 'dfa-plate-mark');
  append(mark, icon('triangle', 'dfa-shape-ember'), icon('diamond', 'dfa-shape-frost'));
  const name = el('span', 'dfa-plate-name');
  // Ready is a tick in a ring, not ready an empty ring: a shape, not a colour.
  const ready = el('span', 'dfa-plate-ready');
  ready.appendChild(icon('check'));
  const classLabel = el('span', 'dfa-plate-class');
  const hostBadge = el('span', 'dfu-badge dfu-badge-host', 'Host');
  const youBadge = el('span', 'dfu-badge dfu-badge-you', 'You');
  const botBadge = el('span', 'dfu-badge', 'Bot');
  hostBadge.hidden = true;
  youBadge.hidden = true;
  botBadge.hidden = true;
  const top = el('span', 'dfa-plate-line');
  append(top, mark, name, ready);
  const bottom = el('span', 'dfa-plate-line dfa-plate-sub');
  append(bottom, classLabel, hostBadge, youBadge, botBadge);
  append(card, top, bottom);
  wrap.appendChild(card);
  return {
    wrap,
    card,
    name,
    classLabel,
    hostBadge,
    youBadge,
    botBadge,
    shown: false,
    xStep: -1,
    yStep: -1,
    scaleStep: -1,
    playerId: NO_PLAYER,
    known: false,
    shownName: '',
    classId: null,
    team: null,
    state: null,
    isHost: false,
    isLocal: false,
    isBot: false,
    focused: false,
  };
}

export class LobbyPlates {
  readonly root: HTMLElement;
  private readonly pool: PlateDom[] = [];
  private readonly placement: PlatePlacement = createPlatePlacement();
  private lastLocalId: PlayerId = NO_PLAYER;

  constructor() {
    this.root = el('div', 'dfa-plates');
    this.root.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < PLATE_POOL_SIZE; i++) {
      const plate = createPlate();
      this.pool.push(plate);
      this.root.appendChild(plate.wrap);
    }
  }

  /**
   * One frame. `lobbyChanged` = the lobby object differs from last frame's (names, classes and
   * ready marks may have changed); `band` is the part of the screen the docked panels leave free.
   */
  update(
    state: UiState,
    lobby: LobbyState,
    lobbyChanged: boolean,
    band: Readonly<PlateBand>,
    focusId: PlayerId,
  ): void {
    const plates = state.lobbyPlates;
    const count = plates === undefined ? 0 : liveCount(plates.length, state.lobbyPlateCount);
    const localId = state.connection.localPlayerId;
    const refill = lobbyChanged || localId !== this.lastLocalId;
    this.lastLocalId = localId;
    for (let i = 0; i < this.pool.length; i++) {
      const dom = this.pool[i];
      if (dom === undefined) continue;
      const plate = i < count && plates !== undefined ? plates[i] : undefined;
      if (plate === undefined) {
        this.setShown(dom, false);
        continue;
      }
      if (refill || plate.playerId !== dom.playerId) this.fill(dom, lobby, plate.playerId, localId);
      const placed = placePlate(this.placement, plate, band);
      if (!dom.known || !placed.shown) {
        this.setShown(dom, false);
        continue;
      }
      if (placed.xStep !== dom.xStep) {
        dom.xStep = placed.xStep;
        dom.wrap.style.setProperty('--dfa-x', PLATE_PERCENT_STRINGS[placed.xStep] ?? '0%');
      }
      if (placed.yStep !== dom.yStep) {
        dom.yStep = placed.yStep;
        dom.wrap.style.setProperty('--dfa-y', PLATE_PERCENT_STRINGS[placed.yStep] ?? '0%');
      }
      if (placed.scaleStep !== dom.scaleStep) {
        dom.scaleStep = placed.scaleStep;
        dom.wrap.style.setProperty('--dfa-s', PLATE_SCALE_STRINGS[placed.scaleStep] ?? '1');
      }
      const focused = focusId !== NO_PLAYER && dom.playerId === focusId;
      if (focused !== dom.focused) {
        dom.focused = focused;
        dom.card.dataset['focus'] = focused ? '1' : '0';
      }
      this.setShown(dom, true);
    }
  }

  private setShown(dom: PlateDom, shown: boolean): void {
    if (dom.shown === shown) return;
    dom.shown = shown;
    dom.wrap.hidden = !shown;
  }

  /** Looks the rider up and rewrites whatever differs. Only riders on a terrace get a card. */
  private fill(dom: PlateDom, lobby: LobbyState, playerId: PlayerId, localId: PlayerId): void {
    const player = findLobbyPlayer(lobby, playerId);
    dom.playerId = playerId;
    const side = player === null ? null : player.side;
    if (player === null || (side !== TEAM_EMBER && side !== TEAM_FROST)) {
      dom.known = false;
      return;
    }
    dom.known = true;
    dom.card.dataset['pid'] = String(playerId);
    if (dom.shownName !== player.name) {
      dom.shownName = player.name;
      // Names are player-chosen text: always set as text, never as markup.
      dom.name.textContent = player.name;
    }
    if (dom.classId !== player.classId) {
      dom.classId = player.classId;
      dom.classLabel.textContent = DRAGON_CLASSES[player.classId].name;
    }
    if (dom.team !== side) {
      dom.team = side;
      dom.card.dataset['team'] = TEAMS[side].key;
    }
    // The host and the bots do not ready up: they count as ready, as in the roster.
    const state: PlateState = !player.connected
      ? 'away'
      : player.ready || player.isHost || player.isBot
        ? 'ready'
        : 'waiting';
    if (dom.state !== state) {
      dom.state = state;
      dom.card.dataset['state'] = state;
    }
    if (dom.isHost !== player.isHost) {
      dom.isHost = player.isHost;
      dom.hostBadge.hidden = !player.isHost;
    }
    const isLocal = player.id === localId;
    if (dom.isLocal !== isLocal) {
      dom.isLocal = isLocal;
      dom.youBadge.hidden = !isLocal;
    }
    if (dom.isBot !== player.isBot) {
      dom.isBot = player.isBot;
      dom.botBadge.hidden = !player.isBot;
    }
  }
}
