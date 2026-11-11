/**
 * The settings panel (T-3.9): a dialog over the title screen or the flight menu with four tabs.
 * Plain HTML controls; every change is raised as a UiIntent at once (live apply) and the panel
 * redraws from the next UiState. It keeps no copy of the settings beyond what is being typed.
 *
 *   const panel = createSettingsPanel(uiRoot, onIntent);
 *   panel.update(uiState);          // every frame is fine: it returns early when nothing changed
 *   panel.open('controls');         // or drive it with UiState.settingsOpen / settingsTab
 *
 * Keyboard: Tab stays inside the dialog, Left / Right move between tabs, Escape closes (or
 * cancels a key capture). While the panel is open it takes key and mouse events in the capture
 * phase, so the game's own Escape and click handling never see them.
 */

import '../ui.css';
import './settings.css';
import { resolveSettings, SETTINGS_TABS } from '../../shared/ui';
import type {
  ControlsUiState,
  GameSettings,
  SettingsState,
  SettingsTab,
  UiIntentHandler,
  UiState,
} from '../../shared/ui';
import { append, button, el } from '../dom';
import {
  actionLabel,
  beginCapture,
  canSwap,
  cancelCapture,
  captureCode,
  codeLabel,
  createRebindModel,
  mouseCode,
  rebindPrompt,
  reconcileRebind,
  resolveConflict,
} from './rebind-model';
import {
  RANGE_FIELDS,
  SELECT_OPTIONS,
  SETTINGS_TAB_LABELS,
  createRangeView,
  isSettingsTab,
  neighbourTab,
  qualityHint,
  rangeIntent,
  rangeText,
  rangeView,
  selectIntent,
  selectValue,
  textIntent,
  toggleIntent,
  turnIntent,
} from './settings-model';
import type { RangeField, SelectField, TextField, ToggleField } from './settings-model';

export interface SettingsPanel {
  /** Redraws from the state. Cheap when nothing changed. */
  update(state: UiState): void;
  /** Shows the panel, on `tab` when given (otherwise the tab it was last on). */
  open(tab?: SettingsTab): void;
  close(): void;
  readonly isOpen: boolean;
  /** Removes every element and listener. */
  dispose(): void;
}

/** How long after a captured mouse button the click it produces is swallowed. */
const CLICK_SWALLOW_MS = 300;

let nextId = 0;

interface RangeDom {
  readonly field: RangeField;
  readonly input: HTMLInputElement;
  readonly output: HTMLElement;
}

interface ToggleDom {
  readonly field: ToggleField;
  readonly node: HTMLButtonElement;
  readonly text: HTMLElement;
  readonly onText: string;
  readonly offText: string;
}

interface SelectDom {
  readonly field: SelectField;
  readonly node: HTMLSelectElement;
}

interface KeyRowDom {
  readonly action: string;
  readonly row: HTMLElement;
  readonly slots: HTMLButtonElement[];
  readonly reset: HTMLButtonElement;
}

function group(title: string, ...rows: readonly HTMLElement[]): HTMLElement {
  const node = el('section', 'dfs-group');
  append(node, el('h3', 'dfu-overline dfs-group-title', title), ...rows);
  return node;
}

/** A labelled row: words on the left, the control on the right. */
function row(label: string, hint: string, control: HTMLElement, labelFor?: string): HTMLElement {
  const node = el('div', 'dfs-row');
  const words = el('div', 'dfs-row-words');
  const name = el('label', 'dfs-row-label', label);
  if (labelFor !== undefined) name.htmlFor = labelFor;
  words.appendChild(name);
  if (hint !== '') words.appendChild(el('p', 'dfu-hint dfs-row-hint', hint));
  append(node, words, control);
  return node;
}

export function createSettingsPanel(root: HTMLElement, onIntent: UiIntentHandler): SettingsPanel {
  const uid = `dfs${nextId++}`;
  const ranges: RangeDom[] = [];
  const toggles: ToggleDom[] = [];
  const selects: SelectDom[] = [];
  const keyRows: KeyRowDom[] = [];
  const view = createRangeView();
  const rebind = createRebindModel();

  let settings: GameSettings | null = null;
  let shownSettings: SettingsState | null = null;
  let controls: ControlsUiState | undefined;
  let shownControls: ControlsUiState | undefined;
  let shownRebindRevision = -1;
  let shownOpenFlag: boolean | undefined;
  let open = false;
  let disposed = false;
  let tab: SettingsTab = 'video';
  let returnFocus: Element | null = null;
  let swallowClicksUntil = 0;
  let confirmingReset = false;

  // --- Skeleton ---------------------------------------------------------------------------------

  const container = el('div', 'dfu-root dfs-root');
  container.hidden = true;
  const scrim = el('div', 'dfu-scrim dfs-scrim df-interactive');
  const panel = el('section', 'dfu-panel dfs-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', `${uid}-title`);

  const head = el('header', 'dfs-head');
  const heading = el('h2', 'dfu-heading', 'Settings');
  heading.id = `${uid}-title`;
  const tabList = el('div', 'dfs-tabs');
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Settings sections');
  append(head, heading, tabList);

  const body = el('div', 'dfs-body');
  const tabButtons = new Map<SettingsTab, HTMLButtonElement>();
  const tabPanels = new Map<SettingsTab, HTMLElement>();
  for (const id of SETTINGS_TABS) {
    const tabButton = button('dfs-tab', SETTINGS_TAB_LABELS[id]);
    tabButton.id = `${uid}-tab-${id}`;
    tabButton.dataset['tab'] = id;
    tabButton.setAttribute('role', 'tab');
    tabButton.setAttribute('aria-controls', `${uid}-panel-${id}`);
    tabButtons.set(id, tabButton);
    tabList.appendChild(tabButton);
    const tabPanel = el('div', 'dfs-tabpanel');
    tabPanel.id = `${uid}-panel-${id}`;
    tabPanel.setAttribute('role', 'tabpanel');
    tabPanel.setAttribute('aria-labelledby', tabButton.id);
    tabPanel.hidden = true;
    tabPanels.set(id, tabPanel);
    body.appendChild(tabPanel);
  }

  // --- Control builders ---------------------------------------------------------------------------

  const rangeRow = (field: RangeField, label: string, hint: string): HTMLElement => {
    const id = `${uid}-${field}`;
    const input = el('input', 'dfs-range');
    input.type = 'range';
    input.id = id;
    input.dataset['range'] = field;
    const output = el('output', 'dfu-num dfs-range-value');
    output.htmlFor.add(id);
    const control = el('div', 'dfs-control dfs-control-range');
    append(control, input, output);
    ranges.push({ field, input, output });
    return row(label, hint, control, id);
  };

  const toggleRow = (
    field: ToggleField,
    label: string,
    hint: string,
    onText = 'On',
    offText = 'Off',
  ): HTMLElement => {
    const node = button('dfu-switch dfs-switch', '');
    node.dataset['toggle'] = field;
    node.setAttribute('role', 'switch');
    node.setAttribute('aria-checked', 'false');
    node.setAttribute('aria-label', label);
    const text = el('span', 'dfu-switch-text', offText);
    append(node, el('span', 'dfu-switch-knob'), text);
    toggles.push({ field, node, text, onText, offText });
    const control = el('div', 'dfs-control');
    control.appendChild(node);
    return row(label, hint, control);
  };

  const selectRow = (
    field: SelectField,
    label: string,
    hint: HTMLElement | string,
  ): HTMLElement => {
    const id = `${uid}-${field}`;
    const node = el('select', 'dfu-select dfs-select');
    node.id = id;
    node.dataset['select'] = field;
    for (const option of SELECT_OPTIONS[field]) {
      const item = el('option', '', option.label);
      item.value = option.value;
      node.appendChild(item);
    }
    selects.push({ field, node });
    const control = el('div', 'dfs-control');
    control.appendChild(node);
    const built = row(label, typeof hint === 'string' ? hint : '', control, id);
    if (typeof hint !== 'string') built.firstElementChild?.appendChild(hint);
    return built;
  };

  const textInput = (
    name: string,
    type: 'text' | 'password',
    maxLength: number,
  ): HTMLInputElement => {
    const input = el('input', 'dfu-input dfs-input');
    input.type = type;
    input.id = `${uid}-${name}`;
    input.name = `dfs-${name}`;
    input.maxLength = maxLength;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    return input;
  };

  const textRow = (label: string, hint: string, input: HTMLInputElement): HTMLElement => {
    const control = el('div', 'dfs-control');
    control.appendChild(input);
    return row(label, hint, control, input.id);
  };

  // --- Video ------------------------------------------------------------------------------------

  const qualityNote = el('p', 'dfu-hint dfs-row-hint', '');
  const redetect = button('dfu-btn dfu-btn-small', 'Re-detect display', 'redetect');
  const redetectControl = el('div', 'dfs-control');
  redetectControl.appendChild(redetect);
  append(
    tabPanels.get('video') as HTMLElement,
    group(
      'Quality',
      selectRow('quality', 'Quality preset', qualityNote),
      toggleRow(
        'dynamicResolution',
        'Dynamic resolution',
        'Lowers the resolution when frames run long, to hold 60 fps.',
      ),
      rangeRow('renderScaleCap', 'Resolution limit', 'The sharpest the picture is allowed to get.'),
      selectRow(
        'fpsCap',
        'Frame rate limit',
        'A limit keeps the laptop cooler and the battery longer.',
      ),
      row(
        'Display',
        'Measure the screen again after moving the game to another display.',
        redetectControl,
      ),
    ),
    group(
      'Camera',
      rangeRow('fovDeg', 'Field of view', ''),
      rangeRow('cameraShake', 'Camera shake', ''),
      toggleRow('reduceMotion', 'Reduce motion', 'No shake, no camera roll, gentler speed zoom.'),
    ),
    group(
      'Interface',
      rangeRow('uiScale', 'Interface size', 'Applied when you let go of the slider.'),
      toggleRow(
        'colorBlindMarkers',
        'Stronger team markers',
        'Bolder team shapes and outlines, so teams never rest on colour.',
      ),
      toggleRow(
        'showNetChip',
        'Ping and frame rate',
        'A small readout in the corner while flying.',
      ),
    ),
  );

  // --- Controls ---------------------------------------------------------------------------------

  const prompt = el('div', 'dfs-prompt');
  prompt.setAttribute('role', 'status');
  prompt.setAttribute('aria-live', 'polite');
  prompt.hidden = true;
  const promptText = el('p', 'dfs-prompt-text', '');
  const swapButton = button('dfu-btn dfu-btn-small dfu-btn-primary', 'Swap', 'conflictSwap');
  const cancelButton = button('dfu-btn dfu-btn-small', 'Cancel', 'conflictCancel');
  const promptActions = el('div', 'dfs-prompt-actions');
  append(promptActions, swapButton, cancelButton);
  append(prompt, promptText, promptActions);

  const keyList = el('div', 'dfs-keys');
  const keyEmpty = el('p', 'dfu-hint', 'Key bindings are not available here.');
  const resetKeys = button('dfu-btn dfu-btn-small', 'Reset keys to defaults', 'resetKeys');
  const keysFoot = el('div', 'dfs-keys-foot');
  append(
    keysFoot,
    el('p', 'dfu-hint', 'Select a key, then press the new one. Mouse buttons work too.'),
    resetKeys,
  );
  const keysGroup = group('Keys', prompt, keyList, keyEmpty, keysFoot);
  append(
    tabPanels.get('controls') as HTMLElement,
    group(
      'Mouse',
      rangeRow('mouseSensitivity', 'Mouse sensitivity', ''),
      toggleRow(
        'invertY',
        'Invert vertical steering',
        'Push forward to dive, like a flight stick.',
      ),
      toggleRow(
        'boostToggle',
        'Boost key',
        'Hold: boost while the key is down. Toggle: press once to start, again to stop.',
        'Toggle',
        'Hold',
      ),
    ),
    keysGroup,
  );

  // --- Audio ------------------------------------------------------------------------------------

  append(
    tabPanels.get('audio') as HTMLElement,
    group(
      'Volume',
      rangeRow('masterVolume', 'Master', ''),
      rangeRow('sfxVolume', 'Effects', 'Wings, wind, breath and impacts.'),
      rangeRow('musicVolume', 'Music', ''),
      rangeRow('uiVolume', 'Interface', 'Menu and scoreboard sounds.'),
    ),
  );

  // --- Game & network ---------------------------------------------------------------------------

  const nameInput = textInput('playerName', 'text', 32);
  nameInput.placeholder = 'Rider';
  nameInput.setAttribute('autocomplete', 'nickname');
  nameInput.dataset['text'] = 'playerName';
  const lanInput = textInput('lanHost', 'text', 253);
  lanInput.placeholder = 'This computer';
  lanInput.dataset['text'] = 'lanHost';
  const lanRow = textRow(
    'Relay computer',
    'Name or address of the computer running the LAN relay. Empty = the one that served this page.',
    lanInput,
  );

  const turnUrl = textInput('turnUrl', 'text', 512);
  turnUrl.placeholder = 'turn:relay.example.org:3478';
  const turnUser = textInput('turnUser', 'text', 512);
  // A text field masked by CSS, not `type=password`: the browser must not offer to save a relay
  // credential in its password manager or sync it anywhere.
  const turnSecret = textInput('turnSecret', 'text', 512);
  turnSecret.classList.add('dfs-secret');
  turnSecret.dataset['masked'] = 'true';
  const reveal = button('dfu-btn dfu-btn-small dfs-reveal', 'Show', 'revealSecret');
  reveal.setAttribute('aria-pressed', 'false');
  reveal.setAttribute('aria-controls', turnSecret.id);
  const secretControl = el('div', 'dfs-control dfs-control-secret');
  append(secretControl, turnSecret, reveal);
  const turnProblem = el('p', 'dfs-problem', 'A relay address starts with turn: or turns:');
  turnProblem.setAttribute('role', 'alert');
  turnProblem.hidden = true;
  const turnUrlRow = textRow('Relay address', '', turnUrl);
  turnUrlRow.firstElementChild?.appendChild(turnProblem);

  const resetAll = button('dfu-btn dfu-btn-small', 'Reset all settings', 'resetAll');
  const resetConfirm = button('dfu-btn dfu-btn-small dfs-danger', 'Yes, reset', 'resetConfirm');
  const resetKeep = button('dfu-btn dfu-btn-small', 'Keep', 'resetKeep');
  resetConfirm.hidden = true;
  resetKeep.hidden = true;
  const resetControl = el('div', 'dfs-control dfs-control-buttons');
  append(resetControl, resetAll, resetConfirm, resetKeep);

  append(
    tabPanels.get('game') as HTMLElement,
    group('Rider', textRow('Rider name', 'Shown to everyone in the room.', nameInput)),
    group(
      'Connection',
      selectRow(
        'signaling',
        'Connection mode',
        'Online needs the internet. Local network needs a relay on one computer (npm run peer:lan).',
      ),
      lanRow,
    ),
    group(
      'Traffic relay (optional)',
      el(
        'p',
        'dfu-hint dfs-note',
        'Only for networks that block direct connections. These details stay on this computer and are given to the relay alone.',
      ),
      turnUrlRow,
      textRow('Relay user name', '', turnUser),
      row('Relay password', '', secretControl, turnSecret.id),
    ),
    group(
      'Start over',
      row('Everything', 'Every setting and every key back to how the game shipped.', resetControl),
    ),
  );

  // --- Footer -----------------------------------------------------------------------------------

  const foot = el('footer', 'dfs-foot');
  const done = button('dfu-btn dfu-btn-primary', 'Done', 'close');
  append(foot, el('p', 'dfu-hint', 'Changes apply at once and are kept on this computer.'), done);

  append(panel, head, body, foot);
  scrim.appendChild(panel);
  container.appendChild(scrim);
  root.appendChild(container);

  // --- Drawing ----------------------------------------------------------------------------------

  const showTab = (next: SettingsTab, focus: boolean): void => {
    tab = next;
    for (const id of SETTINGS_TABS) {
      const selected = id === next;
      const tabButton = tabButtons.get(id);
      const tabPanel = tabPanels.get(id);
      if (tabButton === undefined || tabPanel === undefined) continue;
      tabButton.setAttribute('aria-selected', selected ? 'true' : 'false');
      tabButton.tabIndex = selected ? 0 : -1;
      tabPanel.hidden = !selected;
      if (selected && focus) tabButton.focus();
    }
    body.scrollTop = 0;
    if (cancelCapture(rebind)) drawRebind();
    setConfirmingReset(false);
  };

  const setConfirmingReset = (on: boolean): void => {
    if (confirmingReset === on) return;
    confirmingReset = on;
    resetAll.hidden = on;
    resetConfirm.hidden = !on;
    resetKeep.hidden = !on;
    if (on) resetKeep.focus();
  };

  const drawSettings = (current: GameSettings): void => {
    for (const entry of ranges) {
      rangeView(entry.field, current, view);
      const input = entry.input;
      const min = String(view.min);
      const max = String(view.max);
      const step = String(view.step);
      const value = String(view.value);
      if (input.min !== min) input.min = min;
      if (input.max !== max) input.max = max;
      if (input.step !== step) input.step = step;
      if (input.value !== value) input.value = value;
      if (entry.output.textContent !== view.text) entry.output.textContent = view.text;
      input.setAttribute('aria-valuetext', view.text);
    }
    for (const entry of toggles) {
      const on = current[entry.field];
      const checked = on ? 'true' : 'false';
      if (entry.node.getAttribute('aria-checked') !== checked) {
        entry.node.setAttribute('aria-checked', checked);
        entry.text.textContent = on ? entry.onText : entry.offText;
      }
    }
    for (const entry of selects) {
      const value = selectValue(entry.field, current);
      if (entry.node.value !== value) entry.node.value = value;
    }
    const note = qualityHint(current);
    if (qualityNote.textContent !== note) qualityNote.textContent = note;

    // With the scaler off the limit IS the resolution; with shake reduced the slider is moot.
    const shake = ranges.find((entry) => entry.field === 'cameraShake');
    if (shake !== undefined) shake.input.disabled = current.reduceMotion;
    lanRow.hidden = current.signaling !== 'lan';

    // Text fields are left alone while the player is typing in them.
    const active = document.activeElement;
    if (active !== nameInput && nameInput.value !== current.playerName) {
      nameInput.value = current.playerName;
    }
    if (active !== lanInput && lanInput.value !== current.lanHost) lanInput.value = current.lanHost;
    // The relay form: a half-filled form (no valid address yet) is the player's draft, not state.
    if (active !== turnUrl && active !== turnUser && active !== turnSecret && turnProblem.hidden) {
      const turn = current.turn;
      if (turn === null) {
        if (turnUrl.value !== '') turnUrl.value = '';
      } else {
        if (turnUrl.value !== turn.url) turnUrl.value = turn.url;
        if (turnUser.value !== turn.username) turnUser.value = turn.username;
        if (turnSecret.value !== turn.credential) turnSecret.value = turn.credential;
      }
    }
  };

  const buildKeyRows = (current: ControlsUiState): void => {
    keyList.textContent = '';
    keyRows.length = 0;
    for (const action of current.actions) {
      const label = actionLabel(action);
      const keyRow = el('div', 'dfs-key-row');
      keyRow.setAttribute('role', 'group');
      keyRow.setAttribute('aria-label', label);
      const slots: HTMLButtonElement[] = [];
      const slotBox = el('div', 'dfs-key-slots');
      for (let slot = 0; slot < current.slotsPerAction; slot++) {
        const slotButton = button('dfs-key', '', 'bind');
        slotButton.dataset['action'] = action;
        slotButton.dataset['slot'] = String(slot);
        slots.push(slotButton);
        slotBox.appendChild(slotButton);
      }
      const reset = button('dfs-key-reset', 'Reset', 'resetKey');
      reset.dataset['action'] = action;
      reset.setAttribute('aria-label', `Reset ${label} to its default keys`);
      append(keyRow, el('span', 'dfs-key-name', label), slotBox, reset);
      keyRows.push({ action, row: keyRow, slots, reset });
      keyList.appendChild(keyRow);
    }
  };

  const sameCodes = (a: readonly string[], b: readonly string[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  const drawKeys = (): void => {
    const current = controls;
    const has = current !== undefined && current.actions.length > 0;
    keyEmpty.hidden = has;
    keysFoot.hidden = !has;
    keyList.hidden = !has;
    if (current === undefined) return;
    if (
      keyRows.length !== current.actions.length ||
      keyRows.some(
        (entry, index) =>
          entry.action !== current.actions[index] || entry.slots.length !== current.slotsPerAction,
      )
    ) {
      buildKeyRows(current);
    }
    let allDefault = true;
    for (const entry of keyRows) {
      const codes = current.bindings[entry.action] ?? [];
      const isDefault = sameCodes(codes, current.defaults[entry.action] ?? []);
      if (!isDefault) allDefault = false;
      entry.reset.disabled = isDefault;
      entry.row.dataset['unbound'] = codes.length === 0 ? 'true' : 'false';
      const label = actionLabel(entry.action);
      for (let slot = 0; slot < entry.slots.length; slot++) {
        const slotButton = entry.slots[slot];
        if (slotButton === undefined) continue;
        const code = codes[slot];
        const listening =
          rebind.phase !== 'idle' && rebind.action === entry.action && rebind.slot === slot;
        const clash =
          rebind.phase === 'conflict' &&
          rebind.holder === entry.action &&
          rebind.holderSlot === slot;
        const text = listening
          ? rebind.phase === 'conflict'
            ? codeLabel(rebind.code)
            : 'Press a key…'
          : code === undefined
            ? slot === 0
              ? 'Not set'
              : 'Add'
            : codeLabel(code);
        if (slotButton.textContent !== text) slotButton.textContent = text;
        slotButton.dataset['state'] = listening
          ? 'listening'
          : clash
            ? 'clash'
            : code === undefined
              ? 'empty'
              : 'set';
        slotButton.setAttribute(
          'aria-label',
          code === undefined
            ? `${label}, ${slot === 0 ? 'first' : 'second'} key: not set. Press to choose a key.`
            : `${label}, ${slot === 0 ? 'first' : 'second'} key: ${codeLabel(code)}. Press to change.`,
        );
      }
    }
    resetKeys.disabled = allDefault;
  };

  const drawRebind = (): void => {
    shownRebindRevision = rebind.revision;
    const text = rebindPrompt(rebind);
    prompt.hidden = text === '';
    prompt.dataset['phase'] = rebind.phase;
    if (promptText.textContent !== text) promptText.textContent = text;
    const conflict = rebind.phase === 'conflict';
    promptActions.hidden = !conflict;
    if (conflict && controls !== undefined) {
      swapButton.textContent = canSwap(rebind, controls) ? 'Swap the two' : 'Move it here';
    }
    panel.dataset['capturing'] = rebind.phase === 'listening' ? 'true' : 'false';
    drawKeys();
    if (conflict) swapButton.focus();
  };

  function update(state: UiState): void {
    if (disposed) return;
    const flag = state.settingsOpen;
    if (flag !== shownOpenFlag) {
      shownOpenFlag = flag;
      if (flag === true) openPanel(state.settingsTab);
      else if (flag === false) closePanel();
    }
    controls = state.controls;
    if (state.settings !== shownSettings) {
      shownSettings = state.settings;
      settings = resolveSettings(state.settings);
      if (open) drawSettings(settings);
    }
    if (controls !== shownControls) {
      shownControls = controls;
      reconcileRebind(rebind, controls);
      if (open) drawRebind();
    } else if (open && rebind.revision !== shownRebindRevision) {
      drawRebind();
    }
  }

  // --- Events -----------------------------------------------------------------------------------

  const raise: UiIntentHandler = (intent) => {
    onIntent(intent);
  };

  const focusSlot = (action: string, slot: number): void => {
    const entry = keyRows.find((candidate) => candidate.action === action);
    (entry?.slots[slot] ?? entry?.slots[0])?.focus();
  };

  const finishCapture = (action: string, slot: number): void => {
    drawRebind();
    if (rebind.phase === 'idle') focusSlot(action, slot);
  };

  const applyTurn = (): void => {
    const result = turnIntent(turnUrl.value, turnUser.value, turnSecret.value);
    turnProblem.hidden = result.problem === '';
    turnUrl.setAttribute('aria-invalid', result.problem === '' ? 'false' : 'true');
    if (result.intent !== null) raise(result.intent);
  };

  const onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || settings === null) return;
    const field = target.dataset['range'] as RangeField | undefined;
    if (field === undefined || !RANGE_FIELDS.includes(field)) return;
    const raw = Number(target.value);
    const entry = ranges.find((candidate) => candidate.input === target);
    if (entry !== undefined) entry.output.textContent = rangeText(field, raw, settings);
    // Resizing the panel under the pointer mid-drag would move the slider away from it.
    if (field !== 'uiScale') raise(rangeIntent(field, raw, settings));
  };

  const onChange = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      const field = target.dataset['select'] as SelectField | undefined;
      if (field === undefined) return;
      const intent = selectIntent(field, target.value);
      if (intent !== null) raise(intent);
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset['range'] === 'uiScale' && settings !== null) {
      raise(rangeIntent('uiScale', Number(target.value), settings));
      return;
    }
    const text = target.dataset['text'] as TextField | undefined;
    if (text !== undefined) {
      raise(textIntent(text, target.value));
      return;
    }
    if (target === turnUrl || target === turnUser || target === turnSecret) applyTurn();
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const hit = target.closest('button');
    if (!(hit instanceof HTMLButtonElement) || hit.disabled) return;

    const tabId = hit.dataset['tab'];
    if (isSettingsTab(tabId)) {
      showTab(tabId, false);
      return;
    }
    const toggle = hit.dataset['toggle'] as ToggleField | undefined;
    if (toggle !== undefined) {
      raise(toggleIntent(toggle, hit.getAttribute('aria-checked') !== 'true'));
      return;
    }
    switch (hit.dataset['act']) {
      case 'close':
        raise({ type: 'settings.close' });
        closePanel();
        break;
      case 'redetect':
        raise({ type: 'settings.redetectDisplay' });
        break;
      case 'bind': {
        const action = hit.dataset['action'] ?? '';
        const slot = Number(hit.dataset['slot']);
        if (controls !== undefined && beginCapture(rebind, controls, action, slot)) drawRebind();
        break;
      }
      case 'resetKey':
        cancelCapture(rebind);
        raise({ type: 'settings.resetBindings', action: hit.dataset['action'] ?? '' });
        focusSlot(hit.dataset['action'] ?? '', 0);
        break;
      case 'resetKeys':
        cancelCapture(rebind);
        raise({ type: 'settings.resetBindings', action: null });
        break;
      case 'conflictSwap':
      case 'conflictCancel': {
        const action = rebind.action;
        const slot = rebind.slot;
        const intent = resolveConflict(
          rebind,
          hit.dataset['act'] === 'conflictSwap' ? 'swap' : 'cancel',
        );
        if (intent !== null) raise(intent);
        finishCapture(action, slot);
        break;
      }
      case 'revealSecret': {
        const show = turnSecret.dataset['masked'] === 'true';
        turnSecret.dataset['masked'] = show ? 'false' : 'true';
        reveal.textContent = show ? 'Hide' : 'Show';
        reveal.setAttribute('aria-pressed', show ? 'true' : 'false');
        break;
      }
      case 'resetAll':
        setConfirmingReset(true);
        break;
      case 'resetKeep':
        setConfirmingReset(false);
        resetAll.focus();
        break;
      case 'resetConfirm':
        setConfirmingReset(false);
        turnProblem.hidden = true;
        turnUrl.value = '';
        turnUser.value = '';
        turnSecret.value = '';
        raise({ type: 'settings.reset' });
        resetAll.focus();
        break;
      default:
        break;
    }
  };

  const focusables = (): HTMLElement[] => {
    const found: HTMLElement[] = [];
    const nodes = panel.querySelectorAll<HTMLElement>('button, input, select');
    for (const node of nodes) {
      if (node.tabIndex < 0 || node.closest('[hidden]') !== null) continue;
      if ((node as HTMLButtonElement).disabled) continue;
      found.push(node);
    }
    return found;
  };

  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  /** Capture phase on the document, only while open: the panel sees keys before the game does. */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (rebind.phase === 'listening' && controls !== undefined) {
      swallow(event);
      if (event.repeat) return;
      const action = rebind.action;
      const slot = rebind.slot;
      const intent = captureCode(rebind, controls, event.code);
      if (intent !== null) raise(intent);
      finishCapture(action, slot);
      return;
    }
    if (event.key === 'Escape') {
      swallow(event);
      if (event.repeat) return;
      if (rebind.phase === 'conflict') {
        const action = rebind.action;
        const slot = rebind.slot;
        resolveConflict(rebind, 'cancel');
        finishCapture(action, slot);
      } else if (confirmingReset) {
        setConfirmingReset(false);
        resetAll.focus();
      } else {
        raise({ type: 'settings.close' });
        closePanel();
      }
      return;
    }
    // Everything else stays in the panel: the game must not fly on keys typed into a field.
    event.stopPropagation();
    const target = event.target;
    if (event.key === 'Tab') {
      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      target instanceof HTMLElement &&
      target.getAttribute('role') === 'tab'
    ) {
      event.preventDefault();
      showTab(neighbourTab(tab, event.key === 'ArrowRight' ? 1 : -1), true);
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    event.stopPropagation();
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (rebind.phase !== 'listening' || controls === undefined) return;
    const code = mouseCode(event.button);
    if (code === null) return;
    swallow(event);
    swallowClicksUntil = performance.now() + CLICK_SWALLOW_MS;
    const action = rebind.action;
    const slot = rebind.slot;
    const intent = captureCode(rebind, controls, code);
    if (intent !== null) raise(intent);
    finishCapture(action, slot);
  };

  /** The click, auxclick or context menu that follows a captured mouse button does nothing. */
  const onClickCapture = (event: Event): void => {
    if (performance.now() < swallowClicksUntil) swallow(event);
  };

  const CAPTURE: AddEventListenerOptions = { capture: true };

  function openPanel(next?: SettingsTab): void {
    if (disposed) return;
    if (open) {
      if (next !== undefined && next !== tab) showTab(next, true);
      return;
    }
    open = true;
    returnFocus = document.activeElement;
    container.hidden = false;
    if (settings !== null) drawSettings(settings);
    drawRebind();
    showTab(next ?? tab, true);
    document.addEventListener('keydown', onKeyDown, CAPTURE);
    document.addEventListener('keyup', onKeyUp, CAPTURE);
    document.addEventListener('mousedown', onMouseDown, CAPTURE);
    document.addEventListener('click', onClickCapture, CAPTURE);
    document.addEventListener('auxclick', onClickCapture, CAPTURE);
    document.addEventListener('contextmenu', onClickCapture, CAPTURE);
  }

  function closePanel(): void {
    if (!open) return;
    open = false;
    // A field still being edited is committed first (its `change` has not fired yet).
    const active = document.activeElement;
    if (active instanceof HTMLElement && panel.contains(active)) active.blur();
    cancelCapture(rebind);
    setConfirmingReset(false);
    container.hidden = true;
    document.removeEventListener('keydown', onKeyDown, CAPTURE);
    document.removeEventListener('keyup', onKeyUp, CAPTURE);
    document.removeEventListener('mousedown', onMouseDown, CAPTURE);
    document.removeEventListener('click', onClickCapture, CAPTURE);
    document.removeEventListener('auxclick', onClickCapture, CAPTURE);
    document.removeEventListener('contextmenu', onClickCapture, CAPTURE);
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  panel.addEventListener('input', onInput);
  panel.addEventListener('change', onChange);
  panel.addEventListener('click', onClick);

  return {
    update,
    open: openPanel,
    close: closePanel,
    get isOpen(): boolean {
      return open;
    },
    dispose(): void {
      if (disposed) return;
      closePanel();
      disposed = true;
      panel.removeEventListener('input', onInput);
      panel.removeEventListener('change', onChange);
      panel.removeEventListener('click', onClick);
      container.remove();
    },
  };
}
