/**
 * The match intro's title card and its skip hint (T-5.4): the map's name large, the mode under
 * it, in the lower third so the flyby keeps the middle of the picture and the 3-2-1 that
 * follows (upper third) never shares its space. Part of the HUD: a function of HudState that
 * raises no intents. The skip key itself is handled by the screen manager, which knows whether
 * a menu is open.
 *
 * The card's opacity comes straight from the state on every frame (the cinematic owns the
 * fade), so nothing here transitions or animates: a CSS fade would lag behind the camera cut.
 */

import type { HudState } from '../../shared/ui';
import { UNIT_STRINGS, introCardStep } from './hud-model';

export interface IntroCard {
  /** Draws the card and the hint for this frame. Writes only what changed. */
  update(hud: HudState): void;
  /** Hides both (not in a match). */
  hide(): void;
}

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createIntroCard(root: HTMLElement): IntroCard {
  const card = div('dfh-intro');
  // Announced once when it appears; the names are also on the scoreboard and in the lobby.
  card.setAttribute('role', 'status');
  card.hidden = true;
  const mapNode = div('dfh-intro-map');
  const rule = div('dfh-intro-rule');
  rule.setAttribute('aria-hidden', 'true');
  const modeNode = div('dfh-intro-mode');
  card.append(mapNode, rule, modeNode);

  const hint = div('dfh-skip');
  hint.hidden = true;
  const key = document.createElement('kbd');
  key.className = 'dfh-skip-key';
  key.textContent = 'Space';
  const words = document.createElement('span');
  words.textContent = 'Skip';
  hint.append(key, words);
  // Screen readers get the sentence; the key cap is the sighted shorthand for it.
  hint.setAttribute('role', 'note');
  hint.setAttribute('aria-label', 'Press Space to skip');

  root.append(card, hint);

  let shownStep = 0;
  let shownMap = '';
  let shownMode = '';
  let hintShown = false;
  let hintWords = 'Skip';

  function setCard(step: number): void {
    if (step === shownStep) return;
    const wasHidden = shownStep === 0;
    shownStep = step;
    if (step === 0) {
      card.hidden = true;
      return;
    }
    card.style.opacity = UNIT_STRINGS[step] ?? '1';
    if (wasHidden) card.hidden = false;
  }

  function setHint(shown: boolean): void {
    if (shown === hintShown) return;
    hintShown = shown;
    hint.hidden = !shown;
  }

  return {
    update(hud: HudState): void {
      const intro = hud.introCard;
      const step = intro === null || intro === undefined ? 0 : introCardStep(intro.opacity);
      if (step > 0 && intro !== null && intro !== undefined) {
        // Text first, so the card never appears with the last match's names.
        if (intro.mapName !== shownMap) {
          shownMap = intro.mapName;
          mapNode.textContent = intro.mapName;
        }
        if (intro.modeName !== shownMode) {
          shownMode = intro.modeName;
          modeNode.textContent = intro.modeName;
        }
      }
      setCard(step);
      const skip =
        hud.deathCamActive === true ||
        (hud.canSkipIntro && (hud.phase === 'intro' || hud.phase === 'results'));
      setHint(skip);
      const label =
        hud.deathCamActive === true
          ? 'Skip cam'
          : hud.phase === 'results'
            ? 'Skip podium'
            : 'Skip';
      if (label !== hintWords) {
        hintWords = label;
        words.textContent = label;
      }
    },
    hide(): void {
      setCard(0);
      setHint(false);
    },
  };
}
