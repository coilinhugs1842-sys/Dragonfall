/**
 * Dev-only settings preview: the real panel on the real store, with no game behind it. Not part
 * of the game bundle.
 *
 *   npx vite  ->  /tools/settings-preview.html
 *   ?tab=controls    video | controls | audio | game
 *   ?log             show the last intents (TURN details are masked)
 *   ?memory          keep settings in memory instead of localStorage
 *
 * `window.__settingsPreview` exposes the store and the panel for scripted checks.
 */

import {
  bindSettingsTargets,
  createSettingsStore,
  handleSettingsIntent,
} from '../src/game/settings';
import { CONNECTION_OFFLINE_PREVIEW } from './settings-preview-state';
import type { UiIntent, UiState } from '../src/shared';
import { applyPageSettings, createSettingsPanel } from '../src/ui/settings';
import { isSettingsTab } from '../src/ui/settings';

const query = new URLSearchParams(location.search);
const root = document.getElementById('ui');
const log = document.getElementById('log');
if (root === null || log === null) throw new Error('preview markup missing');

const store = createSettingsStore({ storage: query.has('memory') ? null : window.localStorage });
const lines: string[] = [];
let redetects = 0;
let open = true;

function describe(intent: UiIntent): string {
  if (intent.type === 'settings.update' && intent.patch.turn != null) {
    return '{"type":"settings.update","patch":{"turn":"(masked)"}}';
  }
  return JSON.stringify(intent);
}

const panel = createSettingsPanel(root, (intent) => {
  lines.push(describe(intent));
  if (lines.length > 6) lines.shift();
  log.textContent = lines.join('\n');
  handleSettingsIntent(store, intent, {
    redetectDisplay: () => {
      redetects++;
    },
    open: () => {
      open = true;
    },
    close: () => {
      open = false;
    },
  });
  render();
});

function render(): void {
  const state: UiState = {
    screen: 'title',
    connection: CONNECTION_OFFLINE_PREVIEW,
    settings: store.settings,
    lobby: null,
    loading: null,
    hud: null,
    results: null,
    settingsOpen: open,
    controls: store.controls,
  };
  panel.update(state);
}

bindSettingsTargets(store, {
  setUi: (uiScale, colorBlindMarkers, _showNetChip, reduceMotion) => {
    applyPageSettings(document.documentElement, uiScale, colorBlindMarkers, reduceMotion);
  },
});
store.subscribe(render);
window.addEventListener('pagehide', () => store.flush());
log.hidden = !query.has('log');

const tab = query.get('tab');
render();
if (isSettingsTab(tab)) panel.open(tab);

// Click the backdrop's corner text to reopen after "Done".
document.getElementById('backdrop')?.addEventListener('click', () => {
  open = true;
  render();
});

Object.assign(window, {
  __settingsPreview: { store, panel, redetects: () => redetects, intents: lines },
});
