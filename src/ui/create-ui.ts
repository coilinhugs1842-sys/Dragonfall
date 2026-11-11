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
import type { UiIntentHandler, UiState } from '../shared/ui';
import { el } from './dom';
import { LobbyScreen } from './screens/lobby';
import {
  ConnectionChip,
  LoadingCard,
  PauseMenu,
  SessionNotice,
  createReconnectStrip,
} from './screens/overlays';
import { TitleScreen } from './screens/title';
import type { NameStore } from './screens/title';
import { computeLayers, createLayerFlags } from './view-model/connection';
import type { LayerFlags } from './view-model/connection';
import { isSessionEndError } from './view-model/messages';

/** localStorage key for the rider name (a plain string; settings have their own key). */
export const PLAYER_NAME_STORAGE_KEY = 'dragonfall.name';

export interface UiOptions {
  /** Where the rider name is kept. Default: `localStorage[PLAYER_NAME_STORAGE_KEY]`. */
  readonly nameStore?: NameStore;
}

export interface Ui {
  /** Renders the state. Cheap when nothing changed; safe to call every frame. */
  update(state: UiState): void;
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
  const loading = new LoadingCard();
  const chip = new ConnectionChip();
  const strip = createReconnectStrip();
  const pause = new PauseMenu(onIntent);
  const notice = new SessionNotice(onIntent);

  const layers: LayerFlags = createLayerFlags();
  // What is on the page now. Everything starts hidden; the first update reveals.
  const shown: LayerFlags = createLayerFlags();
  for (const node of [
    title.root,
    lobby.root,
    loading.root,
    chip.root,
    strip,
    pause.root,
    notice.root,
  ]) {
    node.hidden = true;
  }
  let baseInert = false;

  base.append(title.root, lobby.root, loading.root, chip.root, strip);
  container.append(base, pause.root, notice.root);
  root.appendChild(container);

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
    if (layers.title) title.update(state);
    if (layers.lobby) lobby.update(state);
    if (layers.loading) loading.update(state);
    if (layers.chip) chip.update(state);
    if (layers.pause) pause.update(state);
    if (layers.notice && error !== null) notice.update(error, state.settings.signaling);

    if (layers.title !== shown.title) setHidden(title.root, !(shown.title = layers.title));
    if (layers.lobby !== shown.lobby) setHidden(lobby.root, !(shown.lobby = layers.lobby));
    if (layers.loading !== shown.loading) {
      setHidden(loading.root, !(shown.loading = layers.loading));
    }
    if (layers.chip !== shown.chip) setHidden(chip.root, !(shown.chip = layers.chip));
    if (layers.reconnecting !== shown.reconnecting) {
      setHidden(strip, !(shown.reconnecting = layers.reconnecting));
    }

    // A dialog disables what is behind it, so Tab cannot reach covered buttons.
    const inert = layers.notice || layers.pause;
    if (inert !== baseInert) {
      baseInert = inert;
      base.inert = inert;
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
   * Escape: close the escape menu, or open it during a match, or step back on the title. While
   * the pointer is locked the browser keeps Escape for itself (it only releases the lock), so
   * `src/game` should also raise `pauseMenuOpen` when the lock is lost.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.repeat || last === null) return;
    if (shown.notice) return;
    if (shown.pause) {
      event.preventDefault();
      onIntent({ type: 'match.resume' });
    } else if (last.screen === 'match') {
      event.preventDefault();
      onIntent({ type: 'match.pause' });
    } else if (shown.title && title.handleEscape()) {
      event.preventDefault();
      refresh();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  return {
    update,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('keydown', onKeyDown);
      title.dispose();
      lobby.dispose();
      pause.dispose();
      notice.dispose();
      container.remove();
      last = null;
    },
  };
}
