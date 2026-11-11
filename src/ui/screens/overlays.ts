/**
 * Small layers that sit over the lobby or the match (T-2.9): the connection chip, the "trying to
 * rejoin" strip, the escape menu, the session-ended notice and the loading card. Each keeps the
 * values it last wrote and touches the DOM only when one changes.
 */

import type { SignalingMode, UiError, UiIntentHandler, UiState } from '../../shared/ui';
import { actionTarget, append, button, el } from '../dom';
import type { ChipKind, PauseRole } from '../view-model/connection';
import { chipKind, displayPing, pauseRole, qualityBars } from '../view-model/connection';
import { describeUiError, uiErrorKey } from '../view-model/messages';

const CHIP_TEXT: Readonly<Record<ChipKind, string>> = {
  hidden: '',
  host: 'Hosting',
  ping: '',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
};

/** Corner chip: quality bars plus ping in ms (or the link state in words). */
export class ConnectionChip {
  readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private shownKind: ChipKind | null = null;
  private shownBars = -1;
  private shownPing = -2;

  constructor() {
    this.root = el('div', 'dfu-chip dfu-bars');
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-label', 'Connection');
    this.label = el('span', 'dfu-num');
    append(this.root, el('i'), el('i'), el('i'), el('i'), this.label);
  }

  update(state: UiState): void {
    const connection = state.connection;
    const kind = chipKind(connection.status, connection.isHost);
    const bars = qualityBars(connection.status, connection.isHost, connection.pingMs);
    const ping = kind === 'ping' ? displayPing(connection.pingMs) : -1;
    if (bars !== this.shownBars) {
      this.shownBars = bars;
      this.root.dataset['bars'] = String(bars);
    }
    if (kind !== this.shownKind || ping !== this.shownPing) {
      this.shownKind = kind;
      this.shownPing = ping;
      this.root.dataset['kind'] = kind;
      this.label.textContent =
        kind === 'ping' ? (ping < 0 ? '— ms' : `${ping} ms`) : CHIP_TEXT[kind];
    }
  }
}

/** Strip shown while the client is trying to get its seat back (docs/NETWORKING.md, "Reconnect"). */
export function createReconnectStrip(): HTMLElement {
  const root = el('div', 'dfu-strip');
  root.setAttribute('role', 'status');
  const dot = el('span', 'dfu-strip-dot');
  dot.setAttribute('aria-hidden', 'true');
  append(
    root,
    dot,
    el('span', '', 'Connection lost. Trying to rejoin — your seat is held for 30 seconds.'),
  );
  return root;
}

const PAUSE_HINT: Readonly<Record<PauseRole, string>> = {
  guest: 'The match carries on while this is open.',
  solo: 'The flight carries on while this is open.',
  host: 'The match carries on while this is open. Closing the room sends every rider back to the title.',
};
const PAUSE_LEAVE_LABEL: Readonly<Record<PauseRole, string>> = {
  guest: 'Leave match',
  solo: 'End flight',
  host: 'Close room',
};

/**
 * Escape menu. The match keeps running behind it: this is a multiplayer game. The host gets a
 * second way out, "End match", which takes the room back to the lobby; its other button ends
 * the room for everyone and is labelled as that.
 */
export class PauseMenu {
  readonly root: HTMLElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly endButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly onIntent: UiIntentHandler;
  private shownRole: PauseRole | null = null;

  constructor(onIntent: UiIntentHandler) {
    this.onIntent = onIntent;
    this.root = el('div', 'dfu-scrim df-interactive');
    const card = el('div', 'dfu-panel dfu-dialog');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'dfu-pause-title');
    const title = el('h2', 'dfu-heading', 'Flight menu');
    title.id = 'dfu-pause-title';
    this.resumeButton = button('dfu-btn dfu-btn-primary dfu-btn-large', 'Resume', 'resume');
    this.endButton = button('dfu-btn dfu-btn-large', 'End match · back to lobby', 'endMatch');
    this.endButton.hidden = true;
    this.leaveButton = button('dfu-btn dfu-btn-large', PAUSE_LEAVE_LABEL.guest, 'leaveMatch');
    this.hint = el('p', 'dfu-hint', PAUSE_HINT.guest);
    append(card, title, this.hint, this.resumeButton, this.endButton, this.leaveButton);
    this.root.appendChild(card);
    this.root.addEventListener('click', this.onClick);
  }

  update(state: UiState): void {
    const role = pauseRole(state.connection.status, state.connection.isHost);
    if (role === this.shownRole) return;
    this.shownRole = role;
    this.hint.textContent = PAUSE_HINT[role];
    this.leaveButton.textContent = PAUSE_LEAVE_LABEL[role];
    this.endButton.hidden = role !== 'host';
  }

  focus(): void {
    this.resumeButton.focus();
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
  }

  private readonly onClick = (event: Event): void => {
    const target = actionTarget(event);
    if (target === null) return;
    const act = target.dataset['act'];
    if (act === 'resume') this.onIntent({ type: 'match.resume' });
    else if (act === 'endMatch') this.onIntent({ type: 'match.end' });
    else if (act === 'leaveMatch') this.onIntent({ type: 'match.leave' });
  };
}

/**
 * Full-screen card for an error that ended the session (host left, connection lost, removed).
 * Its one button raises `title.dismissError`: `src/game` clears the error and shows the title.
 */
export class SessionNotice {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly backButton: HTMLButtonElement;
  private readonly onIntent: UiIntentHandler;
  private shownKey = '';

  constructor(onIntent: UiIntentHandler) {
    this.onIntent = onIntent;
    this.root = el('div', 'dfu-scrim dfu-scrim-heavy df-interactive');
    const card = el('div', 'dfu-panel dfu-dialog');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'dfu-notice-title');
    card.setAttribute('aria-describedby', 'dfu-notice-hint');
    this.title = el('h2', 'dfu-heading');
    this.title.id = 'dfu-notice-title';
    this.hint = el('p', 'dfu-dialog-text');
    this.hint.id = 'dfu-notice-hint';
    this.backButton = button('dfu-btn dfu-btn-primary dfu-btn-large', 'Back to title', 'back');
    append(card, this.title, this.hint, this.backButton);
    this.root.appendChild(card);
    this.backButton.addEventListener('click', this.onBack);
  }

  update(error: UiError, signaling: SignalingMode): void {
    const key = uiErrorKey(error);
    if (key === this.shownKey) return;
    this.shownKey = key;
    const message = describeUiError(error, signaling);
    this.title.textContent = message.title;
    this.hint.textContent = message.hint;
  }

  focus(): void {
    this.backButton.focus();
  }

  dispose(): void {
    this.backButton.removeEventListener('click', this.onBack);
  }

  private readonly onBack = (): void => {
    this.onIntent({ type: 'title.dismissError' });
  };
}

/** Loading card between the lobby and the match: a label and a bar. */
export class LoadingCard {
  readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly bar: HTMLElement;
  private shownLabel = '';
  private shownPercent = -1;

  constructor() {
    this.root = el('div', 'dfu-screen dfu-loading df-interactive');
    const card = el('div', 'dfu-loading-card');
    this.label = el('p', 'dfu-loading-label', 'Preparing the sky…');
    this.bar = el('div', 'dfu-progress');
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.fill = el('div', 'dfu-progress-fill');
    this.bar.appendChild(this.fill);
    append(card, el('p', 'dfu-overline', 'Dragonfall'), this.label, this.bar);
    this.root.appendChild(card);
  }

  update(state: UiState): void {
    const loading = state.loading;
    const label = loading === null || loading.label === '' ? 'Preparing the sky…' : loading.label;
    if (label !== this.shownLabel) {
      this.shownLabel = label;
      this.label.textContent = label;
    }
    const progress = loading === null ? 0 : loading.progress;
    const percent = progress >= 0 ? Math.min(100, Math.round(progress * 100)) : 0;
    if (percent !== this.shownPercent) {
      this.shownPercent = percent;
      // Transform only: the bar never triggers layout while the match is loading.
      this.fill.style.transform = `scaleX(${percent / 100})`;
      this.bar.setAttribute('aria-valuenow', String(percent));
    }
  }
}
