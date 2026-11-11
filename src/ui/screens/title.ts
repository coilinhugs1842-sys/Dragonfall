/**
 * Title screen: rider name, Host / Join (room code entry) / Fly solo, the connecting state and
 * the inline error for a failed attempt (docs/GAME_DESIGN.md, "Flow").
 *
 * Which body shows is a function of `UiState.screen` plus one piece of local form state (menu or
 * code entry). Session-ending errors (host left, connection lost, removed) are not drawn here:
 * the notice layer covers the screen for those.
 */

import { ROOM_CODE_LENGTH } from '../../shared/constants';
import { FALLBACK_PLAYER_NAME, MAX_PLAYER_NAME_LENGTH } from '../../shared/lobby';
import type { SignalingMode, UiIntentHandler, UiState } from '../../shared/ui';
import { actionTarget, append, button, el } from '../dom';
import { describeUiError, isSessionEndError, uiErrorKey } from '../view-model/messages';
import {
  cleanPlayerNameInput,
  extractRoomCode,
  isCompleteRoomCode,
  sanitizeRoomCodeInput,
} from '../view-model/room-code';

/** Where the rider name is remembered between visits. */
export interface NameStore {
  load(): string;
  save(name: string): void;
}

type TitleBody = 'menu' | 'join' | 'connecting';

const SIGNALING_HINT: Readonly<Record<SignalingMode, string>> = {
  online: 'Online: everyone needs an internet connection.',
  lan: 'Local network: the host computer runs the LAN relay (npm run peer:lan).',
};

export class TitleScreen {
  readonly root: HTMLElement;

  private readonly onIntent: UiIntentHandler;
  private readonly names: NameStore;
  /** Re-renders the last state; called after a local change (menu ↔ code entry). */
  private readonly invalidate: () => void;

  private readonly nameInput: HTMLInputElement;
  private readonly menuBody: HTMLElement;
  private readonly joinBody: HTMLFormElement;
  private readonly connectingBody: HTMLElement;
  private readonly hostButton: HTMLButtonElement;
  private readonly codeInput: HTMLInputElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly connectingLabel: HTMLElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly errorBox: HTMLElement;
  private readonly errorTitle: HTMLElement;
  private readonly errorHint: HTMLElement;
  private readonly signalingRow: HTMLElement;
  private readonly onlineButton: HTMLButtonElement;
  private readonly lanButton: HTMLButtonElement;
  private readonly signalingHint: HTMLElement;

  // Local form state.
  private view: 'menu' | 'join' = 'menu';
  /** What the player last asked for, so the connecting body can name it. */
  private attempt: 'host' | 'join' | null = null;
  private attemptCode = '';

  // Last values written to the DOM.
  private shownBody: TitleBody | null = null;
  private shownErrorKey = '';
  private shownSignaling: SignalingMode | null = null;
  private shownConnecting = '';
  private shownJoinEnabled = false;

  constructor(onIntent: UiIntentHandler, names: NameStore, invalidate: () => void) {
    this.onIntent = onIntent;
    this.names = names;
    this.invalidate = invalidate;

    this.root = el('section', 'dfu-screen dfu-title df-interactive');
    this.root.setAttribute('aria-label', 'Title');

    // The live sky and cloud sea are drawn on the game canvas behind this screen; the only
    // backdrop of its own is an ink veil on the left, so the wordmark and the card read over
    // whatever the sky is doing.
    const sky = el('div', 'dfu-title-sky');
    sky.setAttribute('aria-hidden', 'true');

    const heading = el('header', 'dfu-title-head');
    append(
      heading,
      el('p', 'dfu-overline', 'The Riven Sky'),
      el('h1', 'dfu-wordmark', 'Dragonfall'),
      el('p', 'dfu-tagline', 'Two orders. One broken sky.'),
    );

    const card = el('div', 'dfu-panel dfu-title-card');

    const nameLabel = el('label', 'dfu-field');
    this.nameInput = el('input', 'dfu-input');
    this.nameInput.type = 'text';
    this.nameInput.name = 'rider-name';
    this.nameInput.setAttribute('autocomplete', 'nickname');
    this.nameInput.spellcheck = false;
    this.nameInput.maxLength = MAX_PLAYER_NAME_LENGTH * 2; // Code units; the real cut is by code point.
    this.nameInput.placeholder = FALLBACK_PLAYER_NAME;
    this.nameInput.value = cleanPlayerNameInput(names.load());
    append(nameLabel, el('span', 'dfu-field-label', 'Rider name'), this.nameInput);

    // --- Menu body ---
    this.menuBody = el('div', 'dfu-title-body');
    this.hostButton = choiceButton('host', 'Host a room', 'Open a room and share its code', true);
    append(
      this.menuBody,
      this.hostButton,
      choiceButton('showJoin', 'Join a room', 'Enter the code from the host’s screen', false),
      choiceButton('solo', 'Fly solo', 'Free flight over the spires, no opponents', false),
    );

    // --- Join body ---
    this.joinBody = el('form', 'dfu-title-body');
    this.joinBody.noValidate = true;
    const codeLabel = el('label', 'dfu-field');
    this.codeInput = el('input', 'dfu-input dfu-code-input');
    this.codeInput.type = 'text';
    this.codeInput.name = 'room-code';
    this.codeInput.autocomplete = 'off';
    this.codeInput.spellcheck = false;
    this.codeInput.setAttribute('autocapitalize', 'characters');
    this.codeInput.setAttribute('autocorrect', 'off');
    this.codeInput.setAttribute('aria-describedby', 'dfu-code-hint');
    this.codeInput.placeholder = '·'.repeat(ROOM_CODE_LENGTH);
    append(codeLabel, el('span', 'dfu-field-label', 'Room code'), this.codeInput);
    const codeHint = el(
      'p',
      'dfu-hint',
      `${ROOM_CODE_LENGTH} characters. Codes never use O, 0, I or 1.`,
    );
    codeHint.id = 'dfu-code-hint';
    const joinRow = el('div', 'dfu-row');
    this.joinButton = el('button', 'dfu-btn dfu-btn-primary', 'Join room');
    this.joinButton.type = 'submit';
    this.joinButton.disabled = true;
    append(joinRow, button('dfu-btn', 'Back', 'showMenu'), this.joinButton);
    append(this.joinBody, codeLabel, codeHint, joinRow);

    // --- Connecting body ---
    this.connectingBody = el('div', 'dfu-title-body dfu-connecting');
    this.connectingBody.setAttribute('role', 'status');
    this.connectingLabel = el('p', 'dfu-connecting-label', '');
    this.cancelButton = button('dfu-btn', 'Cancel', 'cancel');
    const spinner = el('div', 'dfu-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    append(
      this.connectingBody,
      spinner,
      this.connectingLabel,
      el('p', 'dfu-hint', 'This usually takes a few seconds.'),
      this.cancelButton,
    );

    // --- Error banner ---
    this.errorBox = el('div', 'dfu-error');
    this.errorBox.setAttribute('role', 'alert');
    this.errorBox.hidden = true;
    this.errorTitle = el('p', 'dfu-error-title');
    this.errorHint = el('p', 'dfu-error-hint');
    const errorText = el('div', 'dfu-error-text');
    append(errorText, this.errorTitle, this.errorHint);
    append(this.errorBox, errorText, button('dfu-btn dfu-btn-small', 'Dismiss', 'dismissError'));

    // --- Signaling mode ---
    this.signalingRow = el('div', 'dfu-signaling');
    const segment = el('div', 'dfu-segment');
    segment.setAttribute('role', 'group');
    segment.setAttribute('aria-label', 'Connection mode');
    this.onlineButton = button('dfu-segment-btn', 'Online', 'signalingOnline');
    this.lanButton = button('dfu-segment-btn', 'Local network', 'signalingLan');
    append(segment, this.onlineButton, this.lanButton);
    this.signalingHint = el('p', 'dfu-hint', '');
    append(this.signalingRow, segment, this.signalingHint);

    append(
      card,
      nameLabel,
      this.errorBox,
      this.menuBody,
      this.joinBody,
      this.connectingBody,
      this.signalingRow,
    );

    const foot = el(
      'p',
      'dfu-title-foot',
      'Mouse to steer  ·  Shift to boost  ·  Space to climb  ·  Q / E to roll',
    );

    const inner = el('div', 'dfu-title-inner');
    append(inner, heading, card, foot);
    append(this.root, sky, inner);

    this.root.addEventListener('click', this.onClick);
    this.joinBody.addEventListener('submit', this.onSubmit);
    this.codeInput.addEventListener('input', this.onCodeInput);
    this.codeInput.addEventListener('paste', this.onCodePaste);
    this.nameInput.addEventListener('change', this.onNameChange);
  }

  /** Writes only what differs from the last call. */
  update(state: UiState): void {
    const body: TitleBody = state.screen === 'title' ? this.view : 'connecting';
    if (body !== this.shownBody) {
      const previous = this.shownBody;
      this.shownBody = body;
      this.menuBody.hidden = body !== 'menu';
      this.joinBody.hidden = body !== 'join';
      this.connectingBody.hidden = body !== 'connecting';
      this.signalingRow.hidden = body === 'connecting';
      this.nameInput.disabled = body === 'connecting';
      // Move focus with the body, but not on first paint (do not steal it at page load).
      if (previous !== null) {
        if (body === 'join') this.codeInput.focus();
        else if (body === 'connecting') this.cancelButton.focus();
        else this.hostButton.focus();
      }
    }

    if (body === 'connecting') {
      const label =
        this.attempt === 'join'
          ? `Seeking room ${this.attemptCode}…`
          : this.attempt === 'host'
            ? 'Opening your room…'
            : 'Connecting…';
      if (label !== this.shownConnecting) {
        this.shownConnecting = label;
        this.connectingLabel.textContent = label;
      }
    }

    const error = state.connection.error;
    const inline = body !== 'connecting' && error !== null && !isSessionEndError(error);
    const key = inline ? uiErrorKey(error) : '';
    const signaling = state.settings.signaling;
    if (key !== this.shownErrorKey || (inline && signaling !== this.shownSignaling)) {
      this.shownErrorKey = key;
      this.errorBox.hidden = !inline;
      if (inline && error !== null) {
        const message = describeUiError(error, signaling);
        this.errorTitle.textContent = message.title;
        this.errorHint.textContent = message.hint;
      }
    }

    if (signaling !== this.shownSignaling) {
      this.shownSignaling = signaling;
      this.onlineButton.setAttribute('aria-pressed', signaling === 'online' ? 'true' : 'false');
      this.lanButton.setAttribute('aria-pressed', signaling === 'lan' ? 'true' : 'false');
      this.signalingHint.textContent = SIGNALING_HINT[signaling];
    }
  }

  /** Escape on the code-entry body goes back to the menu. Returns true when it did something. */
  handleEscape(): boolean {
    if (this.shownBody === 'join') {
      this.view = 'menu';
      return true;
    }
    if (this.shownBody === 'connecting') {
      this.onIntent({ type: 'title.cancel' });
      return true;
    }
    return false;
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
    this.joinBody.removeEventListener('submit', this.onSubmit);
    this.codeInput.removeEventListener('input', this.onCodeInput);
    this.codeInput.removeEventListener('paste', this.onCodePaste);
    this.nameInput.removeEventListener('change', this.onNameChange);
    this.root.remove();
  }

  private readName(): string {
    const name = cleanPlayerNameInput(this.nameInput.value);
    if (name !== this.nameInput.value) this.nameInput.value = name;
    this.names.save(name);
    return name;
  }

  private setCode(code: string): void {
    if (this.codeInput.value !== code) this.codeInput.value = code;
    const complete = isCompleteRoomCode(code);
    if (complete !== this.shownJoinEnabled) {
      this.shownJoinEnabled = complete;
      this.joinButton.disabled = !complete;
    }
  }

  private readonly onNameChange = (): void => {
    this.readName();
  };

  private readonly onCodeInput = (): void => {
    this.setCode(sanitizeRoomCodeInput(this.codeInput.value));
  };

  private readonly onCodePaste = (event: ClipboardEvent): void => {
    const pasted = event.clipboardData?.getData('text');
    if (pasted === undefined || pasted === '') return;
    event.preventDefault();
    this.setCode(extractRoomCode(pasted));
  };

  private readonly onSubmit = (event: Event): void => {
    event.preventDefault();
    const code = sanitizeRoomCodeInput(this.codeInput.value);
    if (!isCompleteRoomCode(code)) return;
    this.attempt = 'join';
    this.attemptCode = code;
    this.onIntent({ type: 'title.join', name: this.readName(), roomCode: code });
  };

  private readonly onClick = (event: Event): void => {
    const target = actionTarget(event);
    if (target === null) return;
    switch (target.dataset['act']) {
      case 'host':
        this.attempt = 'host';
        this.onIntent({ type: 'title.host', name: this.readName() });
        break;
      case 'solo':
        this.attempt = null;
        this.onIntent({ type: 'title.solo', name: this.readName() });
        break;
      case 'showJoin':
        this.view = 'join';
        this.invalidate();
        break;
      case 'showMenu':
        this.view = 'menu';
        this.invalidate();
        break;
      case 'cancel':
        this.onIntent({ type: 'title.cancel' });
        break;
      case 'dismissError':
        this.onIntent({ type: 'title.dismissError' });
        break;
      case 'signalingOnline':
        this.onIntent({ type: 'settings.update', patch: { signaling: 'online' } });
        break;
      case 'signalingLan':
        this.onIntent({ type: 'settings.update', patch: { signaling: 'lan' } });
        break;
      default:
        break;
    }
  };
}

function choiceButton(
  action: string,
  label: string,
  detail: string,
  primary: boolean,
): HTMLButtonElement {
  const node = button(primary ? 'dfu-choice dfu-choice-primary' : 'dfu-choice', '', action);
  append(node, el('span', 'dfu-choice-label', label), el('span', 'dfu-choice-detail', detail));
  return node;
}
