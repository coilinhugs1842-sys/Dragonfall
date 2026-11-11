/**
 * `src/ui`: menus, lobby panel and connection overlays as plain HTML/CSS in `#ui`.
 * `src/game` builds a UiState, calls `ui.update(state)`, and receives UiIntents.
 */

export { PLAYER_NAME_STORAGE_KEY, createLocalNameStore, createUi } from './create-ui';
export type { Ui, UiOptions } from './create-ui';
export type { NameStore } from './screens/title';
