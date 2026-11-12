/**
 * What sits between two scenes (T-5.6): the fade to the sky's cream colour and the loading
 * presentation. Both go above the 3D picture, the HUD and the lobby, and below the menus that
 * must stay usable (escape menu, session notice, settings).
 *
 * They share the cream of the sky (docs/ART_DIRECTION.md, palette: `#F4E6CC`) on purpose: a cut
 * goes aerie -> cream -> match, and when the match is not ready yet the loading presentation
 * takes over from a full fade and hands back to it without the screen changing colour.
 */

import type { UiState } from '../../shared/ui';
import { OPACITY_STRINGS, UNIT_STRINGS } from '../hud/hud-model';
import { append, el } from '../dom';
import type { LoadingGate } from '../view-model/cinematic';
import {
  createLoadingGate,
  fadeStep,
  loadingPercent,
  updateLoadingGate,
} from '../view-model/cinematic';

/** Full-screen cream layer whose opacity is `UiState.fade`, written as it arrives. */
export class FadeLayer {
  readonly root: HTMLElement;
  private shownStep = 0;

  constructor() {
    this.root = el('div', 'dfu-fade');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.hidden = true;
  }

  update(state: UiState): void {
    const step = fadeStep(state.fade);
    if (step === this.shownStep) return;
    const wasHidden = this.shownStep === 0;
    this.shownStep = step;
    if (step === 0) {
      this.root.hidden = true;
      return;
    }
    // The cinematic owns the curve: no CSS transition, the value is drawn as given.
    this.root.style.opacity = UNIT_STRINGS[step] ?? '1';
    if (wasHidden) this.root.hidden = false;
  }
}

const DEFAULT_LABEL = 'Preparing the sky…';

/**
 * The loading presentation: the game's name, what is being prepared, and a bar. Used as the
 * `loading` screen and as a cover over a match that is still fetching or compiling. It appears
 * at once, stays at least a moment and fades out (see `updateLoadingGate`), so a load that
 * finishes within a frame or two never flashes.
 */
export class LoadingOverlay {
  readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly gate: LoadingGate = createLoadingGate();
  private shownVisible = false;
  private shownOpacity = -1;
  private shownLabel = DEFAULT_LABEL;
  private shownPercent = -1;

  constructor() {
    // Interactive, so a click cannot reach (and pointer-lock) a scene that is not ready.
    this.root = el('div', 'dfu-screen dfu-loading df-interactive');
    this.root.hidden = true;
    const card = el('div', 'dfu-loading-card');
    card.setAttribute('role', 'status');
    this.label = el('p', 'dfu-loading-label', DEFAULT_LABEL);
    this.bar = el('div', 'dfu-progress');
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-label', 'Loading');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.fill = el('div', 'dfu-progress-fill');
    this.bar.appendChild(this.fill);
    append(card, el('p', 'dfu-loading-name', 'Dragonfall'), this.label, this.bar);
    this.root.appendChild(card);
  }

  /** `onScreen` = the `loading` screen is showing (it needs no `UiState.loading` to appear). */
  update(state: UiState, onScreen: boolean, nowMs: number): void {
    const loading = state.loading;
    const gate = updateLoadingGate(this.gate, onScreen || loading !== null, nowMs);

    // While it lingers after the load ended, it keeps the last label and a full bar.
    if (loading !== null || onScreen) {
      const label = loading === null || loading.label === '' ? DEFAULT_LABEL : loading.label;
      if (label !== this.shownLabel) {
        this.shownLabel = label;
        this.label.textContent = label;
      }
    }
    if (gate.visible) {
      const percent = loading === null ? (onScreen ? 0 : 100) : loadingPercent(loading.progress);
      if (percent !== this.shownPercent) {
        this.shownPercent = percent;
        // Transform only: the bar never triggers layout while the match is loading.
        this.fill.style.transform = `scaleX(${percent / 100})`;
        this.bar.setAttribute('aria-valuenow', String(percent));
      }
      if (gate.opacityStep !== this.shownOpacity) {
        this.shownOpacity = gate.opacityStep;
        this.root.style.opacity = OPACITY_STRINGS[gate.opacityStep] ?? '1';
      }
    }
    if (gate.visible !== this.shownVisible) {
      this.shownVisible = gate.visible;
      this.root.hidden = !gate.visible;
    }
  }
}
