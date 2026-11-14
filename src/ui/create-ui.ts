/**
 * Screen manager: mounts every menu layer once inside `#ui` and shows the ones a UiState calls
 * for. The UI is a function of UiState (plus small local form state such as the code being typed)
 * and reports every action as a UiIntent through one callback. It imports nothing from sim, net
 * or game.
 *
 * `update` may be called every frame: it compares primitives against what it last wrote and
 * returns without touching the DOM when nothing changed.
 */

import './ui.css';
import type { UiIntentHandler, UiNavCommand, UiState } from '../shared/ui';
import { el } from './dom';
import { createHud } from './hud';
import { createPadNav } from './pad-nav';
import { LobbyScreen } from './screens/lobby';
import { ConnectionChip, PauseMenu, SessionNotice, createReconnectStrip } from './screens/overlays';
import { ResultsPanel } from './screens/results';
import { TitleScreen } from './screens/title';
import type { NameStore } from './screens/title';
import { FadeLayer, LoadingOverlay } from './screens/transitions';
import {
  createSkipLatch,
  isSkipKey,
  rearmSkip,
  skipHintShown,
  takeSkip,
} from './view-model/cinematic';
import { computeLayers, createLayerFlags } from './view-model/connection';
import type { LayerFlags } from './view-model/connection';
import { isSessionEndError } from './view-model/messages';

/** localStorage key for the rider name (a plain string; settings have their own key). */
export const PLAYER_NAME_STORAGE_KEY = 'dragonfall.name';

export interface UiOptions {
  /** Where the rider name is kept. Default: `localStorage[PLAYER_NAME_STORAGE_KEY]`. */
  readonly nameStore?: NameStore;
  /**
   * The clock for the UI's own timing (the results reveal, the loading presentation's minimum
   * time on screen), in ms. Default: `performance.now()`. Tests and previews pass their own.
   */
  readonly now?: () => number;
}

export interface Ui {
  /** Renders the state. Cheap when nothing changed; safe to call every frame. */
  update(state: UiState): void;
  /**
   * One menu step from a gamepad (D-pad or stick, A, B), from the game layer, which reads the
   * pad. Moves the focus, presses the focused button, or does what Escape does (./pad-nav.ts).
   * Also reaches the settings panel when it is mounted in the same root.
   */
  navigate(command: UiNavCommand): void;
  /** The pad opened a menu: show the focus ring on the button that menu focuses. */
  markPadUsed(): void;
  /** Removes every element and listener. */
  dispose(): void;
}

/** A name store on localStorage that survives blocked or full storage by doing nothing. */
export function createLocalNameStore(): NameStore {
  return {
    load(): string {
      try {
        return window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? '';
      } catch {
        return '';
      }
    },
    save(name: string): void {
      try {
        window.localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
      } catch {
        // Private mode or blocked storage: the name just is not remembered.
      }
    },
  };
}

function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

export function createUi(root: HTMLElement, onIntent: UiIntentHandler, options?: UiOptions): Ui {
  const container = el('div', 'dfu-root');
  // Everything a dialog must cover and disable lives in `base`; dialogs are its siblings.
  const base = el('div', 'dfu-base');
  let last: UiState | null = null;
  let disposed = false;

  const refresh = (): void => {
    if (last !== null) update(last);
  };

  const title = new TitleScreen(onIntent, options?.nameStore ?? createLocalNameStore(), refresh);
  const lobby = new LobbyScreen(onIntent);
  const loading = new LoadingOverlay();
  const fade = new FadeLayer();
  const now = options?.now ?? ((): number => performance.now());
  const skip = createSkipLatch();
  // Launch skip hint (HUD is not mounted in the aerie).
  const lobbySkip = el('div', 'dfu-skip');
  lobbySkip.hidden = true;
  const lobbySkipKey = document.createElement('kbd');
  lobbySkipKey.className = 'dfu-skip-key';
  lobbySkipKey.textContent = 'Space';
  const lobbySkipWords = document.createElement('span');
  lobbySkipWords.textContent = 'Skip launch';
  lobbySkip.append(lobbySkipKey, lobbySkipWords);
  lobbySkip.setAttribute('role', 'note');
  lobbySkip.setAttribute('aria-label', 'Press Space to skip the launch');
  let lobbySkipShown = false;
  const chip = new ConnectionChip();
  const strip = createReconnectStrip();
  const pause = new PauseMenu(onIntent);
  const notice = new SessionNotice(onIntent);
  const results = new ResultsPanel();
  results.root.hidden = true;
  let resultsShown = false;

  const layers: LayerFlags = createLayerFlags();
  // What is on the page now. Everything starts hidden; the first update reveals.
  const shown: LayerFlags = createLayerFlags();
  for (const node of [title.root, lobby.root, chip.root, strip, pause.root, notice.root]) {
    node.hidden = true;
  }
  let baseInert = false;
  // Keyboard use (T-6.6): the button that had the focus when a dialog covered the page gets it
  // back when the dialog goes. The settings panel tries this itself, but it closes while the
  // page is still disabled, where `focus()` does nothing; the focus was left on nothing.
  let focusBehind: EventTarget | null = null;
  const onBaseFocusIn = (event: Event): void => {
    focusBehind = event.target;
  };
  const onBaseFocusOut = (event: FocusEvent): void => {
    // The focus was dropped on purpose (a click on the empty page), not taken by a dialog.
    if (!baseInert && event.relatedTarget === null) focusBehind = null;
  };
  const restoreFocusBehind = (): void => {
    const target = focusBehind;
    if (!(target instanceof HTMLElement) || !target.isConnected) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    if (target.closest('[hidden]') === null) target.focus();
  };
  base.addEventListener('focusin', onBaseFocusIn);
  base.addEventListener('focusout', onBaseFocusOut);

  base.append(title.root, lobby.root, chip.root, strip);
  // Stacking, bottom to top: the page (HUD, menus), the scene-cut fade, the loading
  // presentation, then the dialogs that must stay usable whatever is going on underneath.
  // (The settings panel is its own root, mounted after this one, so it is above all of it.)
  container.append(base, fade.root, loading.root, pause.root, notice.root, lobbySkip);
  root.appendChild(container);
  // The match HUD sits inside `base`, under everything else there, so the escape menu and the
  // session notice cover it and `inert` disables it with the rest. The results go on top of it.
  // The scoreboard key is a rebindable action: the game sets `HudState.scoreboardOpen` from the
  // bindings, so the HUD must not also listen for a hardcoded Tab (nor swallow Tab under the
  // pause menu, where it moves the focus).
  const hud = createHud(base, { listenForTab: false });
  base.insertBefore(hud.element, base.firstChild);
  base.appendChild(results.root);

  function update(state: UiState): void {
    if (disposed) return;
    last = state;
    const connection = state.connection;
    const error = connection.error;
    computeLayers(
      layers,
      state.screen,
      connection.status,
      state.lobby !== null,
      isSessionEndError(error),
      state.pauseMenuOpen === true,
    );

    // Fill a layer before revealing it, so it never flashes stale content.
    const nowMs = now();
    const inMatch = state.screen === 'match' && !layers.notice;
    hud.update(inMatch ? state.hud : null, nowMs);
    rearmSkip(skip, inMatch ? state.hud : null, state.lobby);
    const showLobbySkip =
      !layers.notice &&
      !layers.pause &&
      state.settingsOpen !== true &&
      skipHintShown(state.screen, state.hud, state.lobby) &&
      state.screen === 'lobby';
    if (showLobbySkip !== lobbySkipShown) {
      lobbySkipShown = showLobbySkip;
      lobbySkip.hidden = !showLobbySkip;
    }
    const showResults = inMatch && state.results !== null;
    if (showResults) results.update(state, nowMs);
    if (showResults !== resultsShown) {
      setHidden(results.root, !(resultsShown = showResults));
      if (!showResults) results.reset();
    }
    // The chip is a setting during a match (the lobby always shows it).
    if (layers.chip && state.screen === 'match' && state.settings.showNetChip === false) {
      layers.chip = false;
    }

    if (layers.title) title.update(state);
    if (layers.lobby) lobby.update(state);
    if (layers.chip) chip.update(state);
    // These two run every frame: each returns after one comparison when nothing changed.
    fade.update(state);
    loading.update(state, layers.loading, nowMs);
    if (layers.pause) pause.update(state);
    if (layers.notice && error !== null) notice.update(error, state.settings.signaling);

    if (layers.title !== shown.title) setHidden(title.root, !(shown.title = layers.title));
    if (layers.lobby !== shown.lobby) setHidden(lobby.root, !(shown.lobby = layers.lobby));
    if (layers.chip !== shown.chip) setHidden(chip.root, !(shown.chip = layers.chip));
    if (layers.reconnecting !== shown.reconnecting) {
      setHidden(strip, !(shown.reconnecting = layers.reconnecting));
    }

    // A dialog disables what is behind it, so Tab cannot reach covered buttons.
    const inert = layers.notice || layers.pause || state.settingsOpen === true;
    if (inert !== baseInert) {
      baseInert = inert;
      base.inert = inert;
      if (!inert) restoreFocusBehind();
    }
    if (layers.pause !== shown.pause) {
      setHidden(pause.root, !(shown.pause = layers.pause));
      if (layers.pause) pause.focus();
    }
    if (layers.notice !== shown.notice) {
      setHidden(notice.root, !(shown.notice = layers.notice));
      if (layers.notice) notice.focus();
    }
  }

  /**
   * Space or Enter during launch / intro / podium / death cam: skip it. Not while a menu is in
   * front (there the same keys press its buttons) and only once per beat.
   */
  const onSkipKey = (event: KeyboardEvent, state: UiState): boolean => {
    if (!isSkipKey(event.code)) return false;
    const menuOpen = shown.pause || shown.notice || state.settingsOpen === true;
    if (!takeSkip(skip, state.screen, state.hud, menuOpen, state.lobby)) return false;
    // Space would otherwise also "click" whatever still has the focus from the lobby.
    event.preventDefault();
    onIntent({ type: 'match.skipCinematic' });
    return true;
  };

  /**
   * Escape: close the escape menu, or open it during a match, or step back on the title or in
   * the aerie lobby (rules drawer, close-up). While the pointer is locked the browser keeps
   * Escape for itself (it only releases the lock), so `src/game` should also raise
   * `pauseMenuOpen` when the lock is lost.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || last === null) return;
    if (event.key !== 'Escape') {
      onSkipKey(event, last);
      return;
    }
    // The settings panel owns Escape while it is open (it closes itself).
    if (shown.notice || last.settingsOpen === true) return;
    if (shown.pause) {
      event.preventDefault();
      onIntent({ type: 'match.resume' });
    } else if (last.screen === 'match') {
      event.preventDefault();
      onIntent({ type: 'match.pause' });
    } else if (shown.title && title.handleEscape()) {
      event.preventDefault();
      refresh();
    } else if (shown.lobby && lobby.handleEscape()) {
      event.preventDefault();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  // The whole root, not just this container: the settings panel is mounted beside it.
  const padNav = createPadNav(root);

  const navigate = (command: UiNavCommand): void => {
    if (disposed || last === null) return;
    const dialogOpen = shown.pause || shown.notice || last.settingsOpen === true;
    if (!dialogOpen && (last.screen === 'match' || last.screen === 'lobby')) {
      // A skips the cinematic like Space does.
      if (command === 'accept' && takeSkip(skip, last.screen, last.hud, false, last.lobby)) {
        onIntent({ type: 'match.skipCinematic' });
        return;
      }
      if (last.screen === 'match' && (command === 'back' || !resultsShown)) return;
    }
    padNav.navigate(command);
  };

  return {
    update,
    navigate,
    markPadUsed(): void {
      if (!disposed) padNav.markUsed();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      padNav.dispose();
      document.removeEventListener('keydown', onKeyDown);
      base.removeEventListener('focusin', onBaseFocusIn);
      base.removeEventListener('focusout', onBaseFocusOut);
      hud.dispose();
      title.dispose();
      lobby.dispose();
      pause.dispose();
      notice.dispose();
      container.remove();
      last = null;
    },
  };
}
