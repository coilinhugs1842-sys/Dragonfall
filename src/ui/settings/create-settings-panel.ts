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
 *
 * Gamepad: the Controls tab shows the connected pad, its options and its own button table
 * (./binding-list.ts, used twice). The panel cannot read a pad itself (src/ui has no input
 * module): a button press arrives in `UiState.gamepad.pressCode`, and stepping through the
 * panel with the pad is the shell's work (../pad-nav.ts), which stands back while
 * `data-capturing` says a slot is listening.
 */

import '../ui.css';
import './settings.css';
import { resolveSettings, SETTINGS_TABS } from '../../shared/ui';
import type {
  GameSettings,
  GamepadUiState,
  SettingsState,
  SettingsTab,
  UiIntentHandler,
  UiState,
} from '../../shared/ui';
import { append, button, el } from '../dom';
import { GAMEPAD_LIST_WORDS, KEYBOARD_LIST_WORDS, createBindingList } from './binding-list';
import type { BindingList } from './binding-list';
import {
  beginCapture,
  cancelCapture,
  captureCode,
  captureGamepadCode,
  mouseCode,
  resetBindingsIntent,
  resolveConflict,
} from './rebind-model';
import {
  RANGE_FIELDS,
  SELECT_OPTIONS,
  SETTINGS_TAB_LABELS,
  createRangeView,
  gamepadStatus,
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
  const view = createRangeView();
  const keyList = createBindingList('keyboard', KEYBOARD_LIST_WORDS);
  const padList = createBindingList('gamepad', GAMEPAD_LIST_WORDS);
  const lists: readonly BindingList[] = [keyList, padList];

  let settings: GameSettings | null = null;
  let shownSettings: SettingsState | null = null;
  // What the gamepad row was last drawn from.
  let shownPadSupported = false;
  let shownPadSecure = true;
  let shownPadConnected = false;
  let shownPadName = '';
  let shownPadStandard = false;
  let shownHasPad = true;
  let shownPressSeq = -1;
  // A pad press only binds once the list has been listening for a whole frame: the press of A
  // that chose the slot (through pad navigation) arrives in the same frame and is not the answer.
  let padArmed = false;
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
  // The automatic quality pick (T-6.2): runs it again and sets the preset to Automatic.
  const retest = button('dfu-btn dfu-btn-small', 'Test again', 'retestQuality');
  const retestControl = el('div', 'dfs-control');
  retestControl.appendChild(retest);
  append(
    tabPanels.get('video') as HTMLElement,
    group(
      'Quality',
      selectRow('quality', 'Quality preset', qualityNote),
      row(
        'Automatic preset',
        'Measures this computer for a few seconds on the title screen, then picks the preset.',
        retestControl,
      ),
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

  // The gamepad row says which pad is there in words and with a mark, never by colour alone.
  const padStatus = el('div', 'dfs-pad');
  padStatus.setAttribute('role', 'status');
  padStatus.dataset['connected'] = 'false';
  const padName = el('p', 'dfs-pad-name', 'No gamepad detected');
  const padNote = el('p', 'dfu-hint dfs-pad-note', '');
  append(padStatus, padName, padNote);
  const padButtonsGroup = group('Gamepad buttons', ...padList.nodes);
  const padGroup = group(
    'Gamepad',
    padStatus,
    rangeRow('gamepadSensitivity', 'Stick sensitivity', 'How far a full push turns the dragon.'),
    toggleRow(
      'gamepadInvertY',
      'Invert vertical stick',
      'Push forward to dive, like a flight stick.',
    ),
    rangeRow(
      'gamepadDeadZone',
      'Stick dead zone',
      'How far a stick moves before it counts. Raise it if the dragon drifts on its own.',
    ),
    rangeRow(
      'gamepadCurve',
      'Stick response',
      'Higher is finer near the centre and faster at the edge.',
    ),
    toggleRow('gamepadRumble', 'Rumble', 'A short shake when you are hit and on a takedown.'),
  );

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
    group('Keys', ...keyList.nodes),
    padGroup,
    padButtonsGroup,
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
    let cancelled = false;
    for (const list of lists) if (cancelCapture(list.model)) cancelled = true;
    if (cancelled) drawLists();
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

  /** Both tables, and the panel's "a slot is listening" flag that pad navigation stands back for. */
  const drawLists = (): void => {
    let capturing = false;
    for (const list of lists) {
      list.draw();
      if (list.model.phase === 'listening') capturing = true;
    }
    panel.dataset['capturing'] = capturing ? 'true' : 'false';
  };

  const drawPad = (): void => {
    const status = gamepadStatus(
      shownPadSupported,
      shownPadSecure,
      shownPadConnected,
      shownPadName,
      shownPadStandard,
    );
    padStatus.dataset['connected'] = status.connected ? 'true' : 'false';
    if (padName.textContent !== status.title) padName.textContent = status.title;
    if (padNote.textContent !== status.note) padNote.textContent = status.note;
    padNote.hidden = status.note === '';
  };

  const updatePad = (pad: GamepadUiState | undefined): void => {
    // A host page that says nothing about gamepads (a tool, an old build) gets no gamepad section.
    const has = pad !== undefined;
    if (has !== shownHasPad) {
      shownHasPad = has;
      padGroup.hidden = !has;
      padButtonsGroup.hidden = !has;
    }
    // The game hands over one object and rewrites it in place, so its fields are compared.
    const supported = pad?.supported ?? false;
    const secure = pad?.secure ?? true;
    const connected = pad?.connected ?? false;
    const name = pad?.name ?? '';
    const standard = pad?.standard ?? false;
    if (
      supported !== shownPadSupported ||
      secure !== shownPadSecure ||
      connected !== shownPadConnected ||
      name !== shownPadName ||
      standard !== shownPadStandard
    ) {
      shownPadSupported = supported;
      shownPadSecure = secure;
      shownPadConnected = connected;
      shownPadName = name;
      shownPadStandard = standard;
      if (open) drawPad();
    }
    if (pad === undefined) return;
    if (pad.pressSeq !== shownPressSeq) {
      shownPressSeq = pad.pressSeq;
      const table = padList.controls;
      if (open && padArmed && padList.model.phase === 'listening' && table !== undefined) {
        const action = padList.model.action;
        const slot = padList.model.slot;
        const intent = captureGamepadCode(padList.model, table, pad.pressCode);
        if (intent !== null) raise(intent);
        finishCapture(padList, action, slot);
      }
    }
    padArmed = padList.model.phase === 'listening';
  };

  function update(state: UiState): void {
    if (disposed) return;
    const flag = state.settingsOpen;
    if (flag !== shownOpenFlag) {
      shownOpenFlag = flag;
      if (flag === true) openPanel(state.settingsTab);
      else if (flag === false) closePanel();
    }
    if (state.settings !== shownSettings) {
      shownSettings = state.settings;
      settings = resolveSettings(state.settings);
      if (open) drawSettings(settings);
    }
    const keysChanged = keyList.setControls(state.controls);
    const padChanged = padList.setControls(state.gamepad?.controls);
    updatePad(state.gamepad);
    if (open && (keysChanged || padChanged || keyList.stale || padList.stale)) drawLists();
  }

  // --- Events -----------------------------------------------------------------------------------

  const raise: UiIntentHandler = (intent) => {
    onIntent(intent);
  };

  const finishCapture = (list: BindingList, action: string, slot: number): void => {
    drawLists();
    if (list.model.phase === 'idle') list.focusSlot(action, slot);
  };

  const listOf = (node: HTMLElement): BindingList =>
    node.dataset['device'] === 'gamepad' ? padList : keyList;

  /** The list that is waiting for a key or button, if one is. */
  const listeningList = (): BindingList | null => {
    for (const list of lists) if (list.model.phase === 'listening') return list;
    return null;
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
      case 'retestQuality':
        raise({ type: 'settings.retestQuality' });
        break;
      case 'bind': {
        const list = listOf(hit);
        const table = list.controls;
        const action = hit.dataset['action'] ?? '';
        const slot = Number(hit.dataset['slot']);
        // One slot listens at a time, across both tables.
        for (const other of lists) if (other !== list) cancelCapture(other.model);
        if (table !== undefined && beginCapture(list.model, table, action, slot)) {
          if (list === padList) padArmed = false;
        }
        drawLists();
        break;
      }
      case 'resetKey': {
        const list = listOf(hit);
        cancelCapture(list.model);
        raise(resetBindingsIntent(list.model, hit.dataset['action'] ?? ''));
        drawLists();
        list.focusSlot(hit.dataset['action'] ?? '', 0);
        break;
      }
      case 'resetKeys': {
        const list = listOf(hit);
        cancelCapture(list.model);
        raise(resetBindingsIntent(list.model, null));
        drawLists();
        break;
      }
      case 'conflictSwap':
      case 'conflictCancel': {
        const list = listOf(hit);
        const action = list.model.action;
        const slot = list.model.slot;
        const intent = resolveConflict(
          list.model,
          hit.dataset['act'] === 'conflictSwap' ? 'swap' : 'cancel',
        );
        if (intent !== null) raise(intent);
        finishCapture(list, action, slot);
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
    const listening = listeningList();
    const table = listening?.controls;
    if (listening !== null && table !== undefined) {
      swallow(event);
      if (event.repeat) return;
      // The pad's table takes pad buttons only; from the keyboard just Esc and Backspace reach it.
      if (listening === padList && event.code !== 'Escape' && event.code !== 'Backspace') return;
      const action = listening.model.action;
      const slot = listening.model.slot;
      const intent = captureCode(listening.model, table, event.code);
      if (intent !== null) raise(intent);
      finishCapture(listening, action, slot);
      return;
    }
    if (event.key === 'Escape') {
      swallow(event);
      if (event.repeat) return;
      const clashing = lists.find((list) => list.model.phase === 'conflict');
      if (clashing !== undefined) {
        const action = clashing.model.action;
        const slot = clashing.model.slot;
        resolveConflict(clashing.model, 'cancel');
        finishCapture(clashing, action, slot);
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
    // Only the keyboard's table binds mouse buttons; while the pad's listens the mouse stays a
    // mouse (a click elsewhere chooses another slot or closes the panel).
    const table = keyList.controls;
    if (keyList.model.phase !== 'listening' || table === undefined) return;
    const code = mouseCode(event.button);
    if (code === null) return;
    swallow(event);
    swallowClicksUntil = performance.now() + CLICK_SWALLOW_MS;
    const action = keyList.model.action;
    const slot = keyList.model.slot;
    const intent = captureCode(keyList.model, table, code);
    if (intent !== null) raise(intent);
    finishCapture(keyList, action, slot);
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
    drawPad();
    drawLists();
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
    for (const list of lists) cancelCapture(list.model);
    panel.dataset['capturing'] = 'false';
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
